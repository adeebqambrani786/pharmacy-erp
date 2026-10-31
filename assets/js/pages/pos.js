/* ==========================================================================
   MediFlow Pharmacy ERP - Point of Sale
   --------------------------------------------------------------------------
   Fast pharmacy checkout: scanner-first search, FEFO batch allocation, cart
   editing, customer credit checks, prescription capture and an 80mm receipt.
   Expired and quarantined batches can never reach the cart (rules 6, 7).
   ========================================================================== */

import {
  searchMedicines, medicine, fefoBatches, allocateFefo, batch as findBatch,
  sellableQty, currentPrice, isSellable, isExpired, customers, customer,
  createCustomer, creditAvailable, commitSale, settings, activeShift, resolveScan,
  holdBill, heldBillsFor, dropHeldBill, markReceiptPrinted
} from '../store.js';
import { can, requirePermission, onSessionChange } from '../auth.js';
import {
  pageHead, icon, badge, emptyState, openModal, modalFooter, confirmDialog,
  notifySuccess, notifyError, notifyWarning, notifyInfo, notifyDenied,
  escapeHtml, field, options, createScanner, printNode, receiptHtml, qtyStepper
} from '../ui.js';
import {
  money, int, num, round, fmtDate, fmtMonthYear, fmtTime, daysUntil,
  uid, qs, qsa, on, debounce, sortBy, clamp, formData, validate, rule,
  showFormErrors, isBlank, sum, divide
} from '../utils.js';

/* ============================== STATE ============================== */

/**
 * Cart state lives at module scope so a cashier can check inventory or add a
 * customer and come back to an intact basket.
 * Every `qty` is stored in PIECES; pack mode only changes how it is entered.
 */
const pos = {
  query: '',
  results: [],
  cursor: 0,
  cart: [],
  customerId: '',
  method: 'Cash',
  cashReceived: '',
  reference: '',
  prescription: { doctor: '', reference: '' },
  busy: false
};

let ctxRef = null;
let keyHandler = null;

/**
 * A cart belongs to the cashier who built it, so it is discarded whenever the
 * session changes. Without this, signing out and back in as someone else would
 * inherit the previous cashier's basket.
 */
onSessionChange((reason) => {
  if (reason === 'login' || reason === 'logout') clearCart();
});

/* ============================== CART MATHS ============================== */

/** Units of a batch already committed to the cart (across all lines). */
function cartQtyForBatch(batchId, exceptLineId = null) {
  return sum(pos.cart.filter((l) => l.batchId === batchId && l.lineId !== exceptLineId), (l) => l.qty);
}

/** Remaining sellable capacity of a batch given what is already in the cart. */
function batchCapacity(batchId, exceptLineId = null) {
  const b = findBatch(batchId);
  if (!b || !isSellable(b)) return 0;
  return Math.max(0, num(b.qty) - cartQtyForBatch(batchId, exceptLineId));
}

function lineGross(line) {
  return round(line.unitPrice * line.qty, 2);
}

function lineTotal(line) {
  return round(Math.max(0, lineGross(line) - num(line.discount)), 2);
}

function cartTotals() {
  const subtotal = round(sum(pos.cart, lineGross), 2);
  const discount = round(sum(pos.cart, (l) => num(l.discount)), 2);
  const total = round(subtotal - discount, 2);
  return {
    subtotal,
    discount,
    total,
    units: sum(pos.cart, (l) => l.qty),
    lines: pos.cart.length,
    needsRx: pos.cart.some((l) => l.prescriptionRequired)
  };
}

/** Maximum discount percentage this user may grant. */
function discountCeiling() {
  if (!can('pos.discount')) return 0;
  return can('inventory.cost') ? 100 : num(settings().sales.maxStaffDiscount, 0);
}

/* ============================== CART OPERATIONS ============================== */

/**
 * Add a medicine to the cart, allocating across FEFO batches.
 * @returns {{added:number, shortfall:number}}
 */
function addMedicine(medicineId, qty = 1, { preferBatchId = '' } = {}) {
  const med = medicine(medicineId);
  if (!med) return { added: 0, shortfall: qty };

  // The store owns FEFO ordering; the cart only tells it what is already
  // reserved, so the same unit is never allocated to two lines.
  const allocation = allocateFefo(medicineId, qty, {
    reserved: (batchId) => cartQtyForBatch(batchId),
    prefer: preferBatchId
  });

  allocation.lines.forEach((line) => {
    const batchRow = findBatch(line.batchId);
    if (batchRow) upsertLine(med, batchRow, line.qty);
  });

  return { added: allocation.allocated, shortfall: allocation.shortfall };
}

/** Merge into an existing line for the same batch, or create a new one. */
function upsertLine(med, batchRow, qty) {
  const existing = pos.cart.find((l) => l.batchId === batchRow.id);
  if (existing) {
    existing.qty += qty;
    return existing;
  }
  const line = {
    lineId: uid('line'),
    medicineId: med.id,
    name: `${med.name} ${med.strength}`.trim(),
    sku: med.sku,
    form: med.form,
    prescriptionRequired: !!med.prescriptionRequired,
    batchId: batchRow.id,
    batchNo: batchRow.batchNo,
    expiry: batchRow.expiry,
    qty,
    unitPrice: num(batchRow.price),
    discount: 0,
    packMode: 'piece',
    packSize: num(batchRow.packSize, med.packSize) || 1
  };
  pos.cart.push(line);
  return line;
}

/**
 * Change a line quantity. When the batch runs out the surplus spills into the
 * next eligible FEFO batch rather than failing silently.
 */
function setLineQty(lineId, nextQty) {
  const line = pos.cart.find((l) => l.lineId === lineId);
  if (!line) return;

  const wanted = Math.max(0, Math.round(num(nextQty)));
  if (wanted === 0) {
    removeLine(lineId);
    return;
  }

  const capacity = batchCapacity(line.batchId, lineId);
  if (wanted <= capacity) {
    line.qty = wanted;
    return;
  }

  // Fill this batch, then try the remaining FEFO queue.
  const overflow = wanted - capacity;
  line.qty = capacity;
  const result = addMedicine(line.medicineId, overflow);

  if (result.added > 0) {
    notifyWarning(
      'Split across batches',
      `Batch ${line.batchNo} had only ${capacity} units - ${result.added} unit(s) came from the next batch by expiry.`
    );
  }
  if (result.shortfall > 0) {
    notifyWarning(
      'Not enough stock',
      `${line.name}: only ${capacity + result.added} unit(s) available in sellable batches.`
    );
  }
}

function removeLine(lineId) {
  const index = pos.cart.findIndex((l) => l.lineId === lineId);
  if (index >= 0) pos.cart.splice(index, 1);
}

function clearCart() {
  pos.cart = [];
  pos.customerId = '';
  pos.method = 'Cash';
  pos.cashReceived = '';
  pos.reference = '';
  pos.prescription = { doctor: '', reference: '' };
}

/* ============================== SEARCH RESULTS ============================== */

function runSearch() {
  const rows = searchMedicines(pos.query, { limit: 40 });
  pos.results = rows.map((med) => {
    const queue = fefoBatches(med.id);
    return {
      med,
      available: sum(queue, (b) => b.qty),
      inCart: sum(pos.cart.filter((l) => l.medicineId === med.id), (l) => l.qty),
      nextBatch: queue[0] || null,
      price: currentPrice(med.id),
      batchCount: queue.length
    };
  });
  pos.cursor = clamp(pos.cursor, 0, Math.max(0, pos.results.length - 1));
}

function resultsHtml() {
  if (!pos.results.length) {
    return emptyState({
      iconName: 'search',
      title: pos.query ? 'No medicine matches that search' : 'Start typing or scan a code',
      message: pos.query
        ? 'Try the generic name, SKU, barcode or batch number.'
        : 'Search by medicine name, generic name, SKU or barcode. A scanner types straight into the box.'
    });
  }

  return pos.results.map((row, index) => {
    const free = row.available - row.inCart;
    const soldOut = free <= 0;
    const days = row.nextBatch ? daysUntil(row.nextBatch.expiry) : null;
    const expiryTone = days === null ? '' : (days <= 30 ? 'c-danger' : (days <= 90 ? 'c-warning' : 'muted'));

    return `
      <button class="pos-result${index === pos.cursor ? ' is-cursor' : ''}${soldOut ? ' is-disabled' : ''}"
              type="button" data-add="${row.med.id}" ${soldOut ? 'disabled' : ''}>
        <span class="pos-result-main">
          <span class="pos-result-name">
            ${escapeHtml(`${row.med.name} ${row.med.strength}`.trim())}
            ${row.med.prescriptionRequired ? badge('Rx', 'info') : ''}
          </span>
          <span class="pos-result-meta">
            <span>${escapeHtml(row.med.form)}</span>
            <span class="mono">${escapeHtml(row.med.sku)}</span>
            ${row.nextBatch ? `<span class="${expiryTone}">FEFO: ${escapeHtml(row.nextBatch.batchNo)} exp ${fmtMonthYear(row.nextBatch.expiry)}</span>` : ''}
            ${row.batchCount > 1 ? `<span class="subtle">${row.batchCount} batches</span>` : ''}
            ${row.inCart ? `<span class="c-primary">${int(row.inCart)} in cart</span>` : ''}
          </span>
        </span>
        <span class="pos-result-end">
          <span class="pos-result-price">${money(row.price)}</span>
          <span class="pos-result-meta" style="justify-content:flex-end">
            ${soldOut
              ? '<span class="c-danger">No sellable stock</span>'
              : `<span>${int(free)} available</span>`}
          </span>
        </span>
      </button>`;
  }).join('');
}

/* ============================== CART RENDER ============================== */

function cartItemsHtml() {
  if (!pos.cart.length) {
    return emptyState({
      iconName: 'shoppingBag',
      title: 'Cart is empty',
      message: 'Scan a QR Code or search for a medicine to begin a sale.'
    });
  }

  return pos.cart.map((line) => {
    const b = findBatch(line.batchId);
    const capacity = batchCapacity(line.batchId, line.lineId);
    const days = daysUntil(line.expiry);
    const packs = line.packSize > 1 ? round(divide(line.qty, line.packSize), 2) : 0;
    const altBatches = fefoBatches(line.medicineId).filter((x) => x.id !== line.batchId).length;

    return `
      <div class="cart-line" data-line="${line.lineId}">
        <div class="cart-line-top">
          <span class="cart-line-name">${escapeHtml(line.name)}</span>
          <button class="btn btn-ghost btn-sm btn-icon" type="button" data-remove="${line.lineId}" title="Remove line">${icon('close', 14)}</button>
        </div>
        <div class="cart-line-meta">
          <span class="mono">${escapeHtml(line.batchNo)}</span>
          <span class="${days <= 30 ? 'c-danger' : (days <= 90 ? 'c-warning' : '')}">Exp ${fmtDate(line.expiry)}</span>
          ${altBatches && settings().inventory.allowManualBatchOverride
            ? `<button class="btn btn-ghost btn-sm" type="button" data-batch="${line.lineId}">${icon('layers', 12)} Change batch</button>`
            : ''}
          ${line.packSize > 1
            ? `<button class="btn btn-ghost btn-sm" type="button" data-pack="${line.lineId}">
                 ${line.packMode === 'pack' ? `Pack of ${line.packSize}` : 'Piece'}
               </button>` : ''}
        </div>
        <div class="cart-line-bottom">
          ${qtyStepper({
            value: line.packMode === 'pack' ? packs : line.qty,
            min: 1,
            max: line.packMode === 'pack'
              ? Math.floor((line.qty + capacity) / line.packSize) || 1
              : line.qty + capacity,
            name: 'qty',
            dataset: `data-qty="${line.lineId}"`
          })}
          <span class="small muted">x ${money(line.unitPrice)}</span>
          ${discountCeiling() > 0
            ? `<button class="btn btn-ghost btn-sm" type="button" data-discount="${line.lineId}" title="Apply discount">
                 ${icon('percent', 13)}${num(line.discount) > 0 ? ` -${money(line.discount)}` : ''}
               </button>` : ''}
          <span class="cart-line-total">${money(lineTotal(line))}</span>
        </div>
        ${line.packMode === 'pack' ? `<div class="small subtle">${packs} pack(s) = ${int(line.qty)} pieces</div>` : ''}
        ${b && num(b.qty) - cartQtyForBatch(b.id) <= 0 ? '<div class="small c-warning">Batch fully allocated to this cart</div>' : ''}
      </div>`;
  }).join('');
}

function cartFooterHtml() {
  const totals = cartTotals();
  const cust = pos.customerId ? customer(pos.customerId) : null;
  const creditRoom = cust ? creditAvailable(cust.id) : 0;
  const creditAllowed = settings().sales.creditEnabled;
  const cash = num(pos.cashReceived);
  const change = pos.method === 'Cash' ? round(cash - totals.total, 2) : 0;
  const shift = activeShift(ctxRef.user.id);

  const customerOptions = sortBy(customers().filter((c) => c.active), (c) => c.name, 'asc')
    .map((c) => ({ value: c.id, label: `${c.name}${c.phone ? ` - ${c.phone}` : ''}` }));

  const methodButton = (method, iconName, label) => {
    const disabled = method === 'Credit' && (!creditAllowed || !pos.customerId);
    return `<button class="pay-btn${pos.method === method ? ' is-active' : ''}" type="button"
      data-method="${method}" ${disabled ? 'disabled title="Select a registered customer first"' : ''}>
      ${icon(iconName, 16)}<span>${label}</span></button>`;
  };

  return `
    <div class="stack-sm">
      <div class="row-sm">
        <select class="select" id="pos-customer" aria-label="Customer">
          ${options(customerOptions, pos.customerId, { placeholder: 'Walk-in Customer' })}
        </select>
        ${can('customers.create')
          ? `<button class="btn btn-secondary btn-sm btn-icon" type="button" id="pos-new-customer" title="Add a customer">${icon('plus', 15)}</button>`
          : ''}
      </div>

      ${cust ? `
        <div class="alert ${creditRoom > 0 ? 'alert-info' : 'alert-warning'} small">
          ${icon('users', 15)}
          <div>
            <strong>${escapeHtml(cust.name)}</strong> · owes ${money(cust.balance)}
            of a ${money(cust.creditLimit)} limit · ${money(creditRoom)} available
          </div>
        </div>` : ''}

      ${totals.needsRx ? `
        <div class="stack-sm">
          <div class="divider-label">Prescription record</div>
          <input class="input" id="rx-doctor" placeholder="Prescribing doctor *"
                 value="${escapeHtml(pos.prescription.doctor)}" autocomplete="off">
          <input class="input" id="rx-ref" placeholder="Prescription reference (optional)"
                 value="${escapeHtml(pos.prescription.reference)}" autocomplete="off">
        </div>` : ''}

      <div class="stack-sm" style="gap:2px">
        <div class="stat-line"><span class="sl-label">Subtotal (${int(totals.units)} units)</span><span class="sl-value">${money(totals.subtotal)}</span></div>
        ${totals.discount > 0 ? `<div class="stat-line"><span class="sl-label">Discount</span><span class="sl-value c-success">-${money(totals.discount)}</span></div>` : ''}
        <div class="stat-line is-total"><span class="sl-label">Total due</span><span class="sl-value">${money(totals.total)}</span></div>
      </div>

      <div class="divider-label">Payment</div>
      <div class="pos-pay-grid">
        ${methodButton('Cash', 'cash', 'Cash')}
        ${methodButton('POS/Card', 'wallet', 'Card')}
        ${methodButton('Bank Transfer', 'external', 'Transfer')}
        ${methodButton('Credit', 'users', 'Credit')}
      </div>

      ${pos.method === 'Cash' ? `
        <div class="row-sm">
          <input class="input num" id="pos-cash" type="number" min="0" step="0.01"
                 placeholder="Cash received" value="${pos.cashReceived}" inputmode="decimal">
          <button class="btn btn-secondary btn-sm nowrap" type="button" data-exact>Exact</button>
        </div>
        <div class="stat-line">
          <span class="sl-label">Change due</span>
          <span class="sl-value ${change < 0 ? 'c-danger' : 'c-success'}">${money(Math.max(0, change))}</span>
        </div>
        ${cash > 0 && change < 0 ? `<p class="small c-danger">Short by ${money(Math.abs(change))}.</p>` : ''}` : ''}

      ${pos.method === 'Bank Transfer' || pos.method === 'POS/Card' ? `
        <input class="input" id="pos-reference" placeholder="${pos.method === 'Bank Transfer' ? 'Transfer reference' : 'Terminal / approval code'}"
               value="${escapeHtml(pos.reference)}" autocomplete="off">` : ''}

      ${pos.method === 'Credit' && cust ? `
        <div class="alert ${totals.total <= creditRoom ? 'alert-info' : 'alert-danger'} small">
          ${icon(totals.total <= creditRoom ? 'info' : 'alert', 15)}
          <div>${totals.total <= creditRoom
            ? `${money(totals.total)} will be added to ${escapeHtml(cust.name)}'s account.`
            : `This sale exceeds the available credit of ${money(creditRoom)}.`}</div>
        </div>` : ''}

      ${!shift ? `
        <div class="alert alert-warning small">
          ${icon('alert', 15)}
          <div>No shift is open, so this sale will not be linked to a cash drawer.
          <button class="btn btn-ghost btn-sm" type="button" data-route="#/shift">Open shift</button></div>
        </div>` : ''}

      <button class="btn btn-primary btn-xl btn-block" type="button" id="pos-checkout"
              ${pos.cart.length ? '' : 'disabled'}>
        ${icon('checkCircle', 19)} Complete sale · ${money(totals.total)}
        <kbd class="key" style="margin-left:6px">F9</kbd>
      </button>

      <div class="row-sm" style="justify-content:space-between">
        <button class="btn btn-ghost btn-sm" type="button" id="pos-hold" ${pos.cart.length ? '' : 'disabled'}>
          ${icon('clipboard', 14)} Hold <kbd class="key">F6</kbd>
        </button>
        <button class="btn btn-ghost btn-sm" type="button" id="pos-resume">
          ${icon('refresh', 14)} Resume <kbd class="key">F7</kbd>
        </button>
        <button class="btn btn-ghost btn-sm" type="button" id="pos-clear" ${pos.cart.length ? '' : 'disabled'}>
          ${icon('trash', 14)} Clear <kbd class="key">F8</kbd>
        </button>
      </div>
    </div>`;
}

/* ============================== PARTIAL REPAINTS ============================== */

function paintResults() {
  const node = qs('#pos-results');
  if (node) node.innerHTML = resultsHtml();
}

function paintCart() {
  const items = qs('#pos-cart-items');
  const foot = qs('#pos-cart-foot');
  const count = qs('#pos-cart-count');
  if (items) items.innerHTML = cartItemsHtml();
  if (foot) { foot.innerHTML = cartFooterHtml(); wireCartFooter(); }
  if (count) count.textContent = `${pos.cart.length} line(s)`;
}

function paintAll() {
  runSearch();
  paintResults();
  paintCart();
}

/* ============================== BATCH OVERRIDE ============================== */

function openBatchModal(lineId) {
  const line = pos.cart.find((l) => l.lineId === lineId);
  if (!line) return;
  const queue = fefoBatches(line.medicineId);
  if (!queue.length) return;

  const rows = queue.map((b, index) => {
    const capacity = batchCapacity(b.id, lineId);
    const selected = b.id === line.batchId;
    return `
      <label class="list-row is-clickable" style="gap:12px">
        <input type="radio" name="batch" value="${b.id}" ${selected ? 'checked' : ''}
               ${capacity <= 0 && !selected ? 'disabled' : ''} style="flex:none">
        <span class="list-main">
          <span class="list-title">${escapeHtml(b.batchNo)} ${index === 0 ? badge('FEFO - use first', 'success') : ''}</span>
          <span class="list-sub">Expires ${fmtDate(b.expiry)} (${daysUntil(b.expiry)} days)
            · ${int(capacity + (selected ? line.qty : 0))} available
            · ${escapeHtml(b.location || 'Unassigned')}</span>
        </span>
        <span class="list-end"><strong class="num">${money(b.price)}</strong></span>
      </label>`;
  }).join('');

  const modal = openModal({
    title: 'Select batch',
    subtitle: line.name,
    size: 'modal-lg',
    iconName: 'layers',
    body: `
      <form id="batch-form">
        <div class="alert alert-info small mb-4">
          ${icon('info', 15)}
          <div>MediFlow suggests the earliest-expiring eligible batch (FEFO). Choosing a later
          batch is recorded against this sale on the receipt.</div>
        </div>
        <div class="list">${rows}</div>
      </form>`,
    footer: modalFooter({ confirmLabel: 'Use this batch' })
  });

  const apply = () => {
    const chosen = qs('input[name="batch"]:checked', modal.root);
    if (!chosen) { modal.close(); return; }
    const batchId = chosen.value;
    if (batchId === line.batchId) { modal.close(); return; }

    const target = findBatch(batchId);
    const capacity = batchCapacity(batchId, lineId);
    if (capacity < line.qty) {
      notifyWarning('Not enough in that batch', `Batch ${target.batchNo} has ${capacity} unit(s) available.`);
      return;
    }

    // Merge with an existing line on the target batch when one exists.
    const sibling = pos.cart.find((l) => l.batchId === batchId && l.lineId !== lineId);
    if (sibling) {
      sibling.qty += line.qty;
      removeLine(lineId);
    } else {
      line.batchId = target.id;
      line.batchNo = target.batchNo;
      line.expiry = target.expiry;
      line.unitPrice = num(target.price);
      line.packSize = num(target.packSize, line.packSize) || 1;
    }
    modal.close();
    paintAll();
  };

  qs('#modal-confirm', modal.root).addEventListener('click', (event) => { event.preventDefault(); apply(); });
  qs('#batch-form', modal.root).addEventListener('submit', (event) => { event.preventDefault(); apply(); });
}

/* ============================== DISCOUNT ============================== */

function openDiscountModal(lineId) {
  const line = pos.cart.find((l) => l.lineId === lineId);
  if (!line) return;

  const ceiling = discountCeiling();
  if (ceiling <= 0) {
    notifyDenied({ message: 'Your account cannot apply discounts at the point of sale.' });
    return;
  }

  const gross = lineGross(line);
  const maxAmount = round(gross * (ceiling / 100), 2);
  const currentPercent = gross ? round((num(line.discount) / gross) * 100, 2) : 0;

  const modal = openModal({
    title: 'Apply discount',
    subtitle: `${line.name} - ${money(gross)} line value`,
    size: 'modal-sm',
    iconName: 'percent',
    body: `
      <form id="disc-form" class="stack-lg" novalidate>
        ${field({
          name: 'percent', label: `Discount percentage (max ${ceiling}%)`, type: 'number',
          value: currentPercent || '', attrs: `min="0" max="${ceiling}" step="0.5" autofocus`
        })}
        <div class="divider-label">or</div>
        ${field({
          name: 'amount', label: `Discount amount (max ${money(maxAmount)})`, type: 'number',
          value: num(line.discount) || '', attrs: `min="0" max="${maxAmount}" step="0.01"`
        })}
        <p class="field-hint">${can('inventory.cost')
          ? 'As the pharmacy owner you may discount up to the full line value.'
          : `Staff discounts are capped at ${ceiling}% by pharmacy settings.`}</p>
      </form>`,
    footer: modalFooter({
      confirmLabel: 'Apply',
      extra: num(line.discount) > 0 ? '<button class="btn btn-ghost" type="button" id="disc-clear">Remove discount</button>' : ''
    })
  });

  const form = qs('#disc-form', modal.root);
  const percentInput = form.elements.percent;
  const amountInput = form.elements.amount;

  // The two inputs mirror each other.
  percentInput.addEventListener('input', () => {
    if (isBlank(percentInput.value)) return;
    amountInput.value = round(gross * (num(percentInput.value) / 100), 2);
  });
  amountInput.addEventListener('input', () => {
    if (isBlank(amountInput.value)) return;
    percentInput.value = gross ? round((num(amountInput.value) / gross) * 100, 2) : 0;
  });

  const apply = () => {
    const amount = round(num(amountInput.value), 2);
    if (amount < 0) { showFormErrors(form, { amount: 'Discount cannot be negative.' }); return; }
    if (amount > maxAmount + 0.005) {
      showFormErrors(form, { amount: `Maximum allowed discount is ${money(maxAmount)} (${ceiling}%).` });
      return;
    }
    line.discount = amount;
    modal.close();
    paintCart();
  };

  const clearBtn = qs('#disc-clear', modal.root);
  if (clearBtn) clearBtn.addEventListener('click', () => { line.discount = 0; modal.close(); paintCart(); });

  form.addEventListener('submit', (event) => { event.preventDefault(); apply(); });
  qs('#modal-confirm', modal.root).addEventListener('click', (event) => { event.preventDefault(); apply(); });
}

/* ============================== QUICK CUSTOMER ============================== */

function openQuickCustomerModal() {
  try {
    requirePermission('customers.create');
  } catch (error) {
    notifyDenied(error);
    return;
  }

  const modal = openModal({
    title: 'Add a customer',
    subtitle: 'Quick registration for this sale',
    size: 'modal-sm',
    iconName: 'users',
    body: `
      <form id="cust-form" class="stack-lg" novalidate>
        ${field({ name: 'name', label: 'Full name', required: true, attrs: 'autofocus placeholder="Customer name"' })}
        ${field({ name: 'phone', label: 'Phone number', attrs: 'placeholder="08030000000" inputmode="tel"' })}
        ${field({ name: 'address', label: 'Address', type: 'textarea', attrs: 'rows="2"' })}
        ${can('customers.manage')
          ? field({ name: 'creditLimit', label: 'Credit limit', type: 'number', value: num(settings().sales.defaultCreditLimit), attrs: 'min="0" step="100"', hint: 'Set to 0 to disallow credit sales' })
          : `<div class="alert alert-neutral small">${icon('info', 15)}
               <div>New accounts start with a ${money(settings().sales.defaultCreditLimit)} credit limit.
               Only the pharmacy owner can change it.</div></div>`}
      </form>`,
    footer: modalFooter({ confirmLabel: 'Add customer' })
  });

  const form = qs('#cust-form', modal.root);
  const submit = () => {
    const data = formData(form);
    const { valid, errors } = validate(data, {
      name: [rule.required('Enter the customer name'), rule.minLen(2)],
      phone: [rule.phone()]
    });
    if (!valid) { showFormErrors(form, errors); return; }
    try {
      const created = createCustomer(data, ctxRef.user);
      pos.customerId = created.id;
      modal.close();
      paintCart();
      notifySuccess('Customer added', `${created.name} is selected for this sale.`);
    } catch (error) {
      notifyError('Could not add customer', error.message);
    }
  };
  form.addEventListener('submit', (event) => { event.preventDefault(); submit(); });
  qs('#modal-confirm', modal.root).addEventListener('click', (event) => { event.preventDefault(); submit(); });
}

/* ============================== SCANNER ============================== */

function openScanModal() {
  try {
    requirePermission('qr.scan');
  } catch (error) {
    notifyDenied(error);
    return;
  }

  let scanner = null;
  const modal = openModal({
    title: 'Scan to sell',
    subtitle: 'Scan a batch QR Code, product barcode or type the code',
    size: 'modal-lg',
    iconName: 'scan',
    body: '<div id="scan-mount"></div><div id="scan-feed" class="mt-4"></div>',
    footer: '<button class="btn btn-secondary" type="button" data-modal-close>Done</button>',
    onClose: () => { if (scanner) scanner.stop(); }
  });

  const feed = qs('#scan-feed', modal.root);

  scanner = createScanner(qs('#scan-mount', modal.root), {
    onDetect: (value) => {
      const result = resolveScan(value);

      if (!result.ok) {
        feed.innerHTML = `<div class="alert alert-danger small">${icon('alertCircle', 16)}
          <div><strong>Not recognised.</strong> ${escapeHtml(result.message)}</div></div>`;
        return;
      }

      const med = result.medicine;
      const available = sellableQty(med.id);

      if (available <= 0) {
        feed.innerHTML = `<div class="alert alert-warning small">${icon('alert', 16)}
          <div><strong>${escapeHtml(med.name)}</strong> has no sellable stock.
          ${result.batch && isExpired(result.batch) ? 'The scanned batch has expired.' : ''}</div></div>`;
        return;
      }

      // A scanned batch is preferred when it is still sellable.
      const preferBatchId = result.batch && isSellable(result.batch) ? result.batch.id : '';
      const outcome = addMedicine(med.id, 1, { preferBatchId });

      if (outcome.added > 0) {
        const line = pos.cart.find((l) => l.medicineId === med.id);
        feed.innerHTML = `<div class="alert alert-success small">${icon('checkCircle', 16)}
          <div><strong>Added ${escapeHtml(med.name)} ${escapeHtml(med.strength)}</strong>
          from batch ${escapeHtml(line ? line.batchNo : '')}.
          ${result.batch && !isSellable(result.batch)
            ? ' The scanned batch was not sellable, so the FEFO batch was used.' : ''}</div></div>`;
        paintAll();
      } else {
        feed.innerHTML = `<div class="alert alert-warning small">${icon('alert', 16)}
          <div>All available units of <strong>${escapeHtml(med.name)}</strong> are already in the cart.</div></div>`;
      }
    }
  });
}

/* ============================== HELD BILLS ============================== */

function holdCurrentBill() {
  if (!pos.cart.length) return;
  holdBill({ user: ctxRef.user, cart: pos.cart, customerId: pos.customerId, note: '' });
  clearCart();
  paintAll();
  notifySuccess('Bill held', 'Resume it from the Resume button when the customer returns.');
}

function openResumeModal() {
  const bills = heldBillsFor(ctxRef.user.id);

  const modal = openModal({
    title: 'Held bills',
    subtitle: bills.length ? `${bills.length} bill(s) waiting` : '',
    size: 'modal-lg',
    iconName: 'clipboard',
    body: bills.length ? `<div class="list">${bills.map((bill) => {
      const total = round(sum(bill.cart, (l) => round(l.unitPrice * l.qty, 2) - num(l.discount)), 2);
      const cust = bill.customerId ? customer(bill.customerId) : null;
      return `
        <div class="list-row">
          <span class="list-avatar tone-info">${icon('clipboard', 16)}</span>
          <span class="list-main">
            <span class="list-title">${escapeHtml(bill.ref)} · ${money(total)}</span>
            <span class="list-sub">${bill.cart.length} line(s) · ${cust ? escapeHtml(cust.name) : 'Walk-in'} · held ${fmtTime(bill.datetime)}</span>
          </span>
          <span class="list-end row-sm">
            <button class="btn btn-ghost btn-sm" type="button" data-drop="${bill.id}">${icon('trash', 14)}</button>
            <button class="btn btn-primary btn-sm" type="button" data-resume="${bill.id}">Resume</button>
          </span>
        </div>`;
    }).join('')}</div>`
      : emptyState({ iconName: 'clipboard', title: 'No held bills', message: 'Use Hold to park a bill and serve the next customer.' }),
    footer: '<button class="btn btn-secondary" type="button" data-modal-close>Close</button>'
  });

  modal.root.addEventListener('click', async (event) => {
    const resumeBtn = event.target.closest('[data-resume]');
    if (resumeBtn) {
      const bill = bills.find((b) => b.id === resumeBtn.getAttribute('data-resume'));
      if (!bill) return;
      if (pos.cart.length) {
        const ok = await confirmDialog({
          title: 'Replace the current cart?',
          message: 'The cart you are working on will be discarded.',
          confirmLabel: 'Replace cart',
          tone: 'danger'
        });
        if (!ok) return;
      }

      // Re-validate every held line against live stock before resuming.
      const dropped = [];
      pos.cart = [];
      bill.cart.forEach((line) => {
        const b = findBatch(line.batchId);
        if (b && isSellable(b) && num(b.qty) >= line.qty) {
          pos.cart.push({ ...line, lineId: uid('line') });
        } else {
          dropped.push(line.name);
        }
      });
      pos.customerId = bill.customerId || '';
      dropHeldBill(bill.id);
      modal.close();
      paintAll();

      if (dropped.length) {
        notifyWarning('Some lines were dropped', `${dropped.join(', ')} are no longer available in the held batch.`);
      } else {
        notifySuccess('Bill resumed', `${bill.ref} is back in the cart.`);
      }
      return;
    }

    const dropBtn = event.target.closest('[data-drop]');
    if (dropBtn) {
      dropHeldBill(dropBtn.getAttribute('data-drop'));
      modal.close();
      notifyInfo('Held bill discarded', 'The parked cart has been removed.');
    }
  });
}

/* ============================== CHECKOUT ============================== */

async function checkout() {
  if (pos.busy || !pos.cart.length) return;

  const totals = cartTotals();

  // Prescription capture
  if (totals.needsRx) {
    const doctorInput = qs('#rx-doctor');
    pos.prescription.doctor = doctorInput ? doctorInput.value.trim() : pos.prescription.doctor;
    const refInput = qs('#rx-ref');
    pos.prescription.reference = refInput ? refInput.value.trim() : '';
    if (!pos.prescription.doctor) {
      notifyError('Prescription required', 'Record the prescribing doctor for the prescription-only items in this cart.');
      if (doctorInput) { doctorInput.classList.add('is-invalid'); doctorInput.focus(); }
      return;
    }
  }

  if (pos.method === 'Cash' && num(pos.cashReceived) < totals.total) {
    notifyError('Cash is short', `Collect at least ${money(totals.total)} or choose another payment method.`);
    const cashInput = qs('#pos-cash');
    if (cashInput) cashInput.focus();
    return;
  }

  if (pos.method === 'Credit') {
    if (!pos.customerId) {
      notifyError('Customer required', 'Credit sales must be attached to a registered customer account.');
      return;
    }
    const room = creditAvailable(pos.customerId);
    if (totals.total > room) {
      notifyError('Credit limit exceeded', `Only ${money(room)} of credit remains on this account.`);
      return;
    }
  }

  const checkoutBtn = qs('#pos-checkout');
  pos.busy = true;
  if (checkoutBtn) { checkoutBtn.classList.add('is-loading'); checkoutBtn.disabled = true; }

  try {
    const sale = commitSale({
      user: ctxRef.user,
      customerId: pos.customerId,
      items: pos.cart.map((line) => ({
        medicineId: line.medicineId,
        batchId: line.batchId,
        qty: line.qty,
        unitPrice: line.unitPrice,
        discount: line.discount,
        packMode: line.packMode,
        packSize: line.packSize
      })),
      payment: {
        method: pos.method,
        cashReceived: pos.method === 'Cash' ? num(pos.cashReceived) : 0,
        reference: pos.reference
      },
      prescription: totals.needsRx ? pos.prescription : null
    });

    clearCart();
    pos.query = '';
    const searchInput = qs('#pos-search');
    if (searchInput) searchInput.value = '';
    paintAll();
    showReceiptModal(sale);
  } catch (error) {
    notifyError('Sale not completed', error.message);
    paintAll();
  } finally {
    pos.busy = false;
    const btn = qs('#pos-checkout');
    if (btn) { btn.classList.remove('is-loading'); btn.disabled = !pos.cart.length; }
  }
}

/** Receipt preview with print, shared with the sales-history reprint action. */
export function showReceiptModal(sale, { duplicate = false } = {}) {
  const pharmacy = settings().pharmacy;
  const html = receiptHtml(sale, { pharmacy, duplicate });

  const modal = openModal({
    title: duplicate ? 'Reprint receipt' : 'Sale completed',
    subtitle: `${sale.ref} - ${money(sale.total)} (${sale.payment.method})`,
    size: 'modal-sm',
    iconName: duplicate ? 'print' : 'checkCircle',
    tone: duplicate ? '' : 'success',
    body: `
      ${!duplicate && sale.payment.method === 'Cash' && num(sale.payment.change) > 0 ? `
        <div class="alert alert-success mb-4">
          ${icon('cash', 18)}
          <div><div class="alert-title">Give change: ${money(sale.payment.change)}</div>
          <div class="small">Received ${money(sale.payment.cashReceived)} for a ${money(sale.total)} sale.</div></div>
        </div>` : ''}
      <div class="receipt-preview-shell">${html}</div>`,
    footer: `
      <button class="btn btn-secondary" type="button" data-modal-close>Close</button>
      <button class="btn btn-primary" type="button" id="receipt-print">${icon('print', 15)} Print receipt</button>`
  });

  qs('#receipt-print', modal.root).addEventListener('click', () => {
    const reprint = duplicate || num(sale.printCount) > 0;
    printNode(receiptHtml(sale, { pharmacy, duplicate: reprint }), 'receipt');
    markReceiptPrinted(sale.id);
  });

  // Auto-focus the search box again so the next customer can be served fast.
  modal.root.addEventListener('click', (event) => {
    if (event.target.closest('[data-modal-close]')) {
      setTimeout(() => { const input = qs('#pos-search'); if (input) input.focus(); }, 40);
    }
  });
}

/* ============================== EVENT WIRING ============================== */

function wireCartFooter() {
  const customerSelect = qs('#pos-customer');
  if (customerSelect) {
    customerSelect.addEventListener('change', () => {
      pos.customerId = customerSelect.value;
      if (pos.method === 'Credit' && !pos.customerId) pos.method = 'Cash';
      paintCart();
    });
  }

  const newCustomerBtn = qs('#pos-new-customer');
  if (newCustomerBtn) newCustomerBtn.addEventListener('click', openQuickCustomerModal);

  qsa('[data-method]').forEach((btn) => btn.addEventListener('click', () => {
    pos.method = btn.getAttribute('data-method');
    pos.reference = '';
    paintCart();
  }));

  const cashInput = qs('#pos-cash');
  if (cashInput) {
    cashInput.addEventListener('input', debounce(() => {
      pos.cashReceived = cashInput.value;
      const caret = cashInput.selectionStart;
      paintCart();
      const next = qs('#pos-cash');
      if (next) { next.focus(); try { next.setSelectionRange(caret, caret); } catch { /* number input */ } }
    }, 320));
    cashInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); pos.cashReceived = cashInput.value; checkout(); }
    });
  }

  const exactBtn = qs('[data-exact]');
  if (exactBtn) exactBtn.addEventListener('click', () => {
    pos.cashReceived = String(cartTotals().total);
    paintCart();
  });

  const referenceInput = qs('#pos-reference');
  if (referenceInput) referenceInput.addEventListener('input', () => { pos.reference = referenceInput.value; });

  const rxDoctor = qs('#rx-doctor');
  if (rxDoctor) rxDoctor.addEventListener('input', () => { pos.prescription.doctor = rxDoctor.value; });
  const rxRef = qs('#rx-ref');
  if (rxRef) rxRef.addEventListener('input', () => { pos.prescription.reference = rxRef.value; });

  const checkoutBtn = qs('#pos-checkout');
  if (checkoutBtn) checkoutBtn.addEventListener('click', checkout);

  const holdBtn = qs('#pos-hold');
  if (holdBtn) holdBtn.addEventListener('click', holdCurrentBill);

  const resumeBtn = qs('#pos-resume');
  if (resumeBtn) resumeBtn.addEventListener('click', openResumeModal);

  const clearBtn = qs('#pos-clear');
  if (clearBtn) clearBtn.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Clear the cart?',
      message: `${pos.cart.length} line(s) will be removed.`,
      confirmLabel: 'Clear cart',
      tone: 'danger',
      iconName: 'trash'
    });
    if (!ok) return;
    clearCart();
    paintAll();
  });
}

/* ============================== RENDER ============================== */

export function render(root, ctx) {
  ctxRef = ctx;
  runSearch();

  const shift = activeShift(ctx.user.id);

  root.innerHTML = `
  <div class="page">
    ${pageHead({
      title: 'Point of Sale',
      subtitle: shift
        ? `Shift ${shift.ref} open since ${fmtTime(shift.openedAt)} - every sale is linked to your drawer`
        : 'No open shift - open one from Cash & Shifts to reconcile your cash',
      actions: `
        ${can('qr.scan') ? `<button class="btn btn-secondary" type="button" id="btn-scan">${icon('scan', 16)} Scan code</button>` : ''}
        <button class="btn btn-secondary" type="button" data-action="shortcuts">${icon('keyboard', 16)} Shortcuts</button>`
    })}

    <div class="pos-grid">
      <div class="pos-left">
        <section class="card pos-search-card">
          <div class="row-sm">
            <div class="search-box" style="max-width:none">
              ${icon('search', 16)}
              <input class="input" id="pos-search" type="search" autocomplete="off" spellcheck="false"
                     placeholder="Scan or search: name, generic, SKU, barcode, batch..."
                     value="${escapeHtml(pos.query)}">
            </div>
          </div>
          <p class="small muted mt-2">
            ${icon('info', 13)} Use <kbd class="key">↑</kbd><kbd class="key">↓</kbd> to move,
            <kbd class="key">Enter</kbd> to add the highlighted medicine. A hardware scanner types here directly.
          </p>
        </section>

        <section class="card" style="overflow:hidden">
          <div class="card-head">
            <div>
              <h3>Medicines</h3>
              <div class="card-sub" id="pos-result-count">${pos.results.length} result(s)</div>
            </div>
          </div>
          <div class="pos-results" id="pos-results">${resultsHtml()}</div>
        </section>
      </div>

      <section class="card pos-cart">
        <div class="card-head">
          <div>
            <h3>Current sale</h3>
            <div class="card-sub" id="pos-cart-count">${pos.cart.length} line(s)</div>
          </div>
          <div class="card-head-actions">
            <span class="badge badge-primary">${escapeHtml(ctx.user.name.split(' ')[0])}</span>
          </div>
        </div>
        <div class="pos-cart-items" id="pos-cart-items">${cartItemsHtml()}</div>
        <div class="pos-cart-foot" id="pos-cart-foot">${cartFooterHtml()}</div>
      </section>
    </div>
  </div>`;

  /* ---------------------------- search box ---------------------------- */

  const search = qs('#pos-search', root);

  const applySearch = () => {
    pos.query = search.value;
    pos.cursor = 0;
    runSearch();
    paintResults();
    const count = qs('#pos-result-count', root);
    if (count) count.textContent = `${pos.results.length} result(s)`;
  };

  search.addEventListener('input', debounce(applySearch, 180));

  search.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      pos.cursor = clamp(pos.cursor + 1, 0, Math.max(0, pos.results.length - 1));
      paintResults();
      const node = qs('.pos-result.is-cursor', root);
      if (node) node.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      pos.cursor = clamp(pos.cursor - 1, 0, Math.max(0, pos.results.length - 1));
      paintResults();
      const node = qs('.pos-result.is-cursor', root);
      if (node) node.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const raw = search.value.trim();
      if (!raw) return;

      // Treat an exact code hit as a scan, otherwise take the highlighted row.
      const scan = resolveScan(raw);
      if (scan.ok) {
        const preferBatchId = scan.batch && isSellable(scan.batch) ? scan.batch.id : '';
        const outcome = addMedicine(scan.medicine.id, 1, { preferBatchId });
        if (outcome.added) {
          search.value = '';
          pos.query = '';
          applySearch();
          paintCart();
        } else {
          notifyWarning('Nothing added', `${scan.medicine.name} has no sellable stock left.`);
        }
        return;
      }

      const row = pos.results[pos.cursor];
      if (row) addToCartFromRow(row.med.id);
    }
  });

  /* ---------------------------- delegated actions ---------------------------- */

  function addToCartFromRow(medicineId) {
    const med = medicine(medicineId);
    const outcome = addMedicine(medicineId, 1);
    if (!outcome.added) {
      notifyWarning('No sellable stock', `${med.name} has no in-date, unquarantined stock available.`);
      return;
    }
    paintAll();
  }

  on(root, 'click', '[data-add]', (event, node) => {
    if (node.disabled) return;
    addToCartFromRow(node.getAttribute('data-add'));
  });

  on(root, 'click', '[data-remove]', (event, node) => {
    removeLine(node.getAttribute('data-remove'));
    paintAll();
  });

  on(root, 'click', '[data-batch]', (event, node) => openBatchModal(node.getAttribute('data-batch')));
  on(root, 'click', '[data-discount]', (event, node) => openDiscountModal(node.getAttribute('data-discount')));

  on(root, 'click', '[data-pack]', (event, node) => {
    const line = pos.cart.find((l) => l.lineId === node.getAttribute('data-pack'));
    if (!line) return;
    line.packMode = line.packMode === 'pack' ? 'piece' : 'pack';
    // Round the piece count up to a whole pack when switching to pack entry.
    if (line.packMode === 'pack') {
      const packs = Math.max(1, Math.round(line.qty / line.packSize));
      setLineQty(line.lineId, packs * line.packSize);
    }
    paintCart();
  });

  // Quantity stepper buttons and direct entry
  on(root, 'click', '.qty-stepper [data-step]', (event, node) => {
    const wrapper = node.closest('.qty-stepper');
    const input = qs('input', wrapper);
    const lineId = input.getAttribute('data-qty');
    const line = pos.cart.find((l) => l.lineId === lineId);
    if (!line) return;
    const step = num(node.getAttribute('data-step'));
    const multiplier = line.packMode === 'pack' ? line.packSize : 1;
    setLineQty(lineId, line.qty + step * multiplier);
    paintAll();
  });

  on(root, 'change', '.qty-stepper input[data-qty]', (event, node) => {
    const lineId = node.getAttribute('data-qty');
    const line = pos.cart.find((l) => l.lineId === lineId);
    if (!line) return;
    const entered = num(node.value);
    setLineQty(lineId, line.packMode === 'pack' ? entered * line.packSize : entered);
    paintAll();
  });

  const scanBtn = qs('#btn-scan', root);
  if (scanBtn) scanBtn.addEventListener('click', openScanModal);

  wireCartFooter();

  /* ---------------------------- deep link ---------------------------- */

  if (ctx.query.medicine) {
    const outcome = addMedicine(ctx.query.medicine, 1);
    if (outcome.added) paintAll();
    ctx.navigate('/pos');
  }

  /* ---------------------------- keyboard shortcuts ---------------------------- */

  keyHandler = (event) => {
    if (event.key === 'F9') { event.preventDefault(); checkout(); }
    if (event.key === 'F6') { event.preventDefault(); holdCurrentBill(); }
    if (event.key === 'F7') { event.preventDefault(); openResumeModal(); }
    if (event.key === 'F8') {
      event.preventDefault();
      const clearBtn = qs('#pos-clear');
      if (clearBtn && !clearBtn.disabled) clearBtn.click();
    }
  };
  window.addEventListener('keydown', keyHandler);

  setTimeout(() => search.focus(), 60);

  return {
    destroy() {
      if (keyHandler) window.removeEventListener('keydown', keyHandler);
      keyHandler = null;
    }
  };
}

export default { render };
