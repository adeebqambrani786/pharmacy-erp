/* ==========================================================================
   MediFlow Pharmacy ERP - Stock Received (QR-based goods receiving)
   --------------------------------------------------------------------------
   The client's core requirement: scan a medicine QR Code, confirm the batch,
   enter the goods, review and confirm. Scanning alone never changes stock -
   inventory only moves when the receipt is confirmed (section 10, rules 15-16).
   ========================================================================== */

import {
  medicines, medicine, batchesOf, batch as findBatch, suppliers, supplier,
  resolveScan, receiveGoods, settings, db, isWrittenOff, isExpired, stockSummary,
  searchMedicines
} from '../store.js';
import { can, requirePermission, onSessionChange } from '../auth.js';
import {
  pageHead, card, icon, badge, renderTable, cellStack, renderPagination, emptyState,
  openModal, openDrawer, modalFooter, confirmDialog, notifySuccess, notifyError,
  notifyDenied, escapeHtml, field, selectField, options, searchBox, createScanner,
  qrBox, printNode, printHeader, printFooter, statusBadge
} from '../ui.js';
import {
  money, int, num, round, fmtDate, fmtMonthYear, fmtDateTime, fmtRelative, isoDate,
  sortBy, qs, qsa, on, debounce, matchesQuery, sum, formData, validate, rule,
  showFormErrors, uid, daysUntil, addDays, downloadCsv, exportName, paginate
} from '../utils.js';

/* ============================== DRAFT STATE ============================== */

/**
 * The receipt being prepared. Lines are pure draft data - nothing touches
 * inventory until confirm() calls receiveGoods().
 */
const draft = {
  supplierId: '',
  invoiceNo: '',
  note: '',
  markPaid: false,
  lines: []
};

const state = { historyPage: 1, query: '' };

let ctxRef = null;

/**
 * An unconfirmed receipt belongs to the user preparing it, so the draft is
 * discarded whenever the session changes. No stock has moved at that point.
 */
onSessionChange((reason) => {
  if (reason === 'login' || reason === 'logout') resetDraft();
});

function draftTotals() {
  return {
    lines: draft.lines.length,
    units: sum(draft.lines, (l) => num(l.qty) + num(l.bonusQty)),
    purchased: sum(draft.lines, (l) => num(l.qty)),
    bonus: sum(draft.lines, (l) => num(l.bonusQty)),
    value: round(sum(draft.lines, (l) => num(l.qty) * num(l.costPrice)), 2),
    retail: round(sum(draft.lines, (l) => (num(l.qty) + num(l.bonusQty)) * num(l.price)), 2),
    newBatches: draft.lines.filter((l) => !l.batchId).length
  };
}

function resetDraft() {
  draft.supplierId = '';
  draft.invoiceNo = '';
  draft.note = '';
  draft.markPaid = false;
  draft.lines = [];
}

/* ============================== LINE EDITOR ============================== */

/**
 * Add or edit one receipt line.
 * @param {string} medicineId
 * @param {{lineId?:string, batchId?:string}} options existing line or a scanned batch
 */
function openLineModal(medicineId, { lineId = '', batchId = '' } = {}) {
  const med = medicine(medicineId);
  if (!med) return;

  const existing = lineId ? draft.lines.find((l) => l.lineId === lineId) : null;
  const summary = stockSummary(med.id);

  // Batches that may still be topped up (written-off batches are closed).
  const openBatches = sortBy(
    batchesOf(med.id).filter((b) => !isWrittenOff(b)),
    (b) => b.expiry, 'asc'
  );

  const preselectedBatch = existing ? existing.batchId : batchId;
  const defaultMode = preselectedBatch ? 'existing' : (openBatches.length ? 'existing' : 'new');
  const lastBatch = openBatches.length ? openBatches[openBatches.length - 1] : null;

  const modal = openModal({
    title: existing ? 'Edit receipt line' : `Receive ${med.name} ${med.strength}`.trim(),
    subtitle: `${med.form} - ${med.category} - SKU ${med.sku}`,
    size: 'modal-lg',
    iconName: 'truck',
    body: `
      <form id="line-form" class="stack-lg" novalidate>
        <div class="card card-pad">
          <div class="def-grid">
            <div class="def-item"><div class="def-label">Currently available</div><div class="def-value num">${int(summary.available)} units</div></div>
            <div class="def-item"><div class="def-label">Open batches</div><div class="def-value num">${openBatches.length}</div></div>
            <div class="def-item"><div class="def-label">Last cost price</div><div class="def-value num">${money(summary.cost)}</div></div>
            <div class="def-item"><div class="def-label">Current selling price</div><div class="def-value num">${money(summary.price)}</div></div>
          </div>
        </div>

        <div>
          <div class="divider-label mb-3">Batch</div>
          <div class="segmented" role="tablist">
            <button type="button" data-mode="existing" class="${defaultMode === 'existing' ? 'is-active' : ''}"
              ${openBatches.length ? '' : 'disabled'}>Add to existing batch</button>
            <button type="button" data-mode="new" class="${defaultMode === 'new' ? 'is-active' : ''}">Create a new batch</button>
          </div>
        </div>

        <div id="mode-existing" ${defaultMode === 'existing' ? '' : 'hidden'}>
          ${openBatches.length ? `<div class="list" style="border:1px solid var(--border);border-radius:var(--r-md)">
            ${openBatches.map((b) => `
              <label class="list-row is-clickable">
                <input type="radio" name="batchId" value="${b.id}" style="flex:none"
                  ${String(preselectedBatch) === b.id ? 'checked' : ''}>
                <span class="list-main">
                  <span class="list-title">${escapeHtml(b.batchNo)}
                    ${isExpired(b) ? badge('Expired', 'danger') : ''}
                    ${b.status === 'quarantined' ? badge('Quarantined', 'warning') : ''}</span>
                  <span class="list-sub">Expires ${fmtDate(b.expiry)} · ${int(b.qty)} units on hand
                    · cost ${money(b.costPrice)} · sells ${money(b.price)}</span>
                </span>
              </label>`).join('')}
          </div>
          <p class="field-hint">Topping up a batch keeps one record per batch number, so no duplicate batches are created.</p>`
            : `<div class="alert alert-neutral small">${icon('info', 15)}
                <div>This medicine has no batches yet - create the first one.</div></div>`}
        </div>

        <div id="mode-new" class="grid-2" ${defaultMode === 'new' ? '' : 'hidden'}>
          ${field({
            name: 'batchNo', label: 'Batch number', required: true,
            value: existing && !existing.batchId ? existing.batchNo : '',
            attrs: 'placeholder="As printed on the carton"',
            hint: lastBatch ? `Most recent batch: ${lastBatch.batchNo}` : ''
          })}
          ${field({
            name: 'expiry', label: 'Expiry date', type: 'date', required: true,
            value: existing ? existing.expiry : isoDate(addDays(new Date(), 365)),
            attrs: `min="${isoDate(new Date())}"`
          })}
          ${selectField({
            name: 'location', label: 'Stock location',
            list: ['Main Shelf A', 'Main Shelf B', 'Cabinet C1', 'Cold Chain Fridge', 'Back Store'],
            value: existing ? existing.location : (med.storage.includes('Refrigerated') ? 'Cold Chain Fridge' : 'Main Shelf A')
          })}
          <div class="field">
            <label class="label">Storage requirement</label>
            <input class="input" value="${escapeHtml(med.storage)}" readonly>
          </div>
        </div>

        <div>
          <div class="divider-label mb-3">Quantities and prices</div>
          <div class="grid-2">
            ${field({
              name: 'qty', label: 'Quantity received', type: 'number', required: true,
              value: existing ? existing.qty : '', attrs: 'min="1" step="1" placeholder="0"',
              hint: 'Units purchased and invoiced'
            })}
            ${field({
              name: 'bonusQty', label: 'Free / bonus units', type: 'number',
              value: existing ? existing.bonusQty : 0, attrs: 'min="0" step="1"',
              hint: 'Added to stock but not to the invoice value'
            })}
            ${field({
              name: 'costPrice', label: 'Purchase price per unit', type: 'number', required: true,
              value: existing ? existing.costPrice : (summary.cost || ''), attrs: 'min="0" step="0.01"'
            })}
            ${field({
              name: 'price', label: 'Selling price per unit', type: 'number', required: true,
              value: existing ? existing.price : (summary.price || ''), attrs: 'min="0" step="0.01"'
            })}
          </div>
          <div class="card card-pad mt-3">
            <div class="stat-line"><span class="sl-label">Line value (purchased units)</span><span class="sl-value" id="line-value">${money(0)}</span></div>
            <div class="stat-line"><span class="sl-label">Expected margin per unit</span><span class="sl-value" id="line-margin">-</span></div>
          </div>
        </div>
      </form>`,
    footer: modalFooter({ confirmLabel: existing ? 'Update line' : 'Add to receipt' })
  });

  const form = qs('#line-form', modal.root);
  let mode = defaultMode;

  // Mode switch
  qsa('[data-mode]', modal.root).forEach((btn) => btn.addEventListener('click', () => {
    if (btn.disabled) return;
    mode = btn.getAttribute('data-mode');
    qsa('[data-mode]', modal.root).forEach((b) => b.classList.toggle('is-active', b === btn));
    qs('#mode-existing', modal.root).hidden = mode !== 'existing';
    qs('#mode-new', modal.root).hidden = mode !== 'new';
  }));

  // Live line value
  const recalc = () => {
    const data = formData(form);
    const value = round(num(data.qty) * num(data.costPrice), 2);
    qs('#line-value', modal.root).textContent = money(value);
    const marginNode = qs('#line-margin', modal.root);
    const margin = round(num(data.price) - num(data.costPrice), 2);
    const pct = num(data.costPrice) > 0 ? round((margin / num(data.costPrice)) * 100, 1) : 0;
    marginNode.textContent = num(data.price) && num(data.costPrice)
      ? `${money(margin)} (${pct}%)`
      : '-';
    marginNode.className = `sl-value ${margin < 0 ? 'c-danger' : 'c-success'}`;
  };
  form.addEventListener('input', recalc);
  recalc();

  const submit = () => {
    const data = formData(form);
    const rules = {
      qty: [rule.required('Enter the quantity received'), rule.positive('Quantity must be greater than zero')],
      costPrice: [rule.required('Enter the purchase price'), rule.minZero()],
      price: [rule.required('Enter the selling price'), rule.positive('Selling price must be greater than zero')]
    };
    if (mode === 'new') {
      rules.batchNo = [rule.required('Enter the batch number')];
      rules.expiry = [rule.date('Select the expiry date'), rule.future('The expiry date must be in the future')];
    }

    const { valid, errors } = validate(data, rules);

    let targetBatch = null;
    if (mode === 'existing') {
      const chosen = qs('input[name="batchId"]:checked', form);
      if (!chosen) {
        notifyError('Select a batch', 'Choose which batch this stock belongs to, or create a new one.');
        return;
      }
      targetBatch = findBatch(chosen.value);
    } else {
      // Guard against creating a duplicate of an existing batch number.
      const clash = batchesOf(med.id).find((b) =>
        String(b.batchNo).toLowerCase() === String(data.batchNo).trim().toLowerCase());
      if (clash) {
        errors.batchNo = `Batch ${clash.batchNo} already exists - use "Add to existing batch" instead.`;
      }
      const inDraft = draft.lines.find((l) =>
        l.medicineId === med.id && !l.batchId && l.lineId !== lineId
        && String(l.batchNo).toLowerCase() === String(data.batchNo).trim().toLowerCase());
      if (inDraft) {
        errors.batchNo = 'This receipt already creates that batch number - edit the existing line.';
      }
    }

    if (!valid || Object.keys(errors).length) { showFormErrors(form, errors); return; }

    if (num(data.price) < num(data.costPrice)) {
      showFormErrors(form, { price: 'The selling price is below the purchase price.' });
      return;
    }

    const line = {
      lineId: lineId || uid('rline'),
      medicineId: med.id,
      medicineName: `${med.name} ${med.strength}`.trim(),
      sku: med.sku,
      batchId: targetBatch ? targetBatch.id : '',
      batchNo: targetBatch ? targetBatch.batchNo : String(data.batchNo).trim(),
      expiry: targetBatch ? targetBatch.expiry : data.expiry,
      qty: Math.round(num(data.qty)),
      bonusQty: Math.round(num(data.bonusQty)),
      costPrice: round(num(data.costPrice), 2),
      price: round(num(data.price), 2),
      location: targetBatch ? (targetBatch.location || '') : (data.location || 'Main Shelf A'),
      isNewBatch: !targetBatch
    };

    if (existing) {
      Object.assign(existing, line);
      notifySuccess('Line updated', `${line.medicineName} - ${int(line.qty)} unit(s).`);
    } else {
      draft.lines.push(line);
      notifySuccess('Added to receipt', `${line.medicineName} - ${int(line.qty)} unit(s) pending confirmation.`);
    }

    modal.close();
    ctxRef.refresh();
  };

  form.addEventListener('submit', (event) => { event.preventDefault(); submit(); });
  qs('#modal-confirm', modal.root).addEventListener('click', (event) => { event.preventDefault(); submit(); });
}

/* ============================== SCAN TO RECEIVE ============================== */

function openScanModal() {
  try {
    requirePermission('qr.scan');
  } catch (error) {
    notifyDenied(error);
    return;
  }

  let scanner = null;
  const modal = openModal({
    title: 'Scan to receive',
    subtitle: 'Scan the batch QR Code or the pack barcode',
    size: 'modal-lg',
    iconName: 'scan',
    body: `
      <div class="alert alert-info small mb-4">
        ${icon('info', 16)}
        <div><strong>Scanning never changes stock.</strong> The code only identifies the medicine -
        you still enter the batch, quantity and prices, then confirm the receipt.</div>
      </div>
      <div id="scan-mount"></div>
      <div id="scan-feed" class="mt-4"></div>`,
    footer: '<button class="btn btn-secondary" type="button" data-modal-close>Done</button>',
    onClose: () => { if (scanner) scanner.stop(); }
  });

  const feed = qs('#scan-feed', modal.root);

  scanner = createScanner(qs('#scan-mount', modal.root), {
    manualLabel: 'Enter or scan a QR payload, batch number, barcode or SKU',
    onDetect: (value) => {
      const result = resolveScan(value);

      if (!result.ok) {
        feed.innerHTML = `
          <div class="alert alert-danger small">
            ${icon('alertCircle', 16)}
            <div>
              <strong>Code not recognised.</strong> ${escapeHtml(result.message)}
              <div class="mt-2">
                <button class="btn btn-secondary btn-sm" type="button" id="scan-manual-pick">
                  Find the medicine manually
                </button>
              </div>
            </div>
          </div>`;
        const pick = qs('#scan-manual-pick', feed);
        if (pick) pick.addEventListener('click', () => { modal.close(); openMedicinePicker(); });
        return;
      }

      const med = result.medicine;
      const summary = stockSummary(med.id);
      const b = result.batch;

      feed.innerHTML = `
        <div class="alert alert-success small">
          ${icon('checkCircle', 16)}
          <div><strong>${escapeHtml(med.name)} ${escapeHtml(med.strength)}</strong> identified
          ${b ? `from batch ${escapeHtml(b.batchNo)}` : `by ${result.type}`}.</div>
        </div>
        <div class="card card-pad mt-3">
          <div class="def-grid">
            <div class="def-item"><div class="def-label">SKU</div><div class="def-value mono">${escapeHtml(med.sku)}</div></div>
            <div class="def-item"><div class="def-label">Form</div><div class="def-value">${escapeHtml(med.form)}</div></div>
            <div class="def-item"><div class="def-label">Available now</div><div class="def-value num">${int(summary.available)}</div></div>
            ${b ? `<div class="def-item"><div class="def-label">Scanned batch</div><div class="def-value">${escapeHtml(b.batchNo)} (exp ${fmtDate(b.expiry)})</div></div>` : ''}
          </div>
          <button class="btn btn-primary mt-4 btn-block" type="button" id="scan-continue">
            ${icon('arrowRight', 16)} Enter goods for this medicine
          </button>
        </div>`;

      qs('#scan-continue', feed).addEventListener('click', () => {
        modal.close();
        openLineModal(med.id, { batchId: b && !isWrittenOff(b) ? b.id : '' });
      });
    }
  });
}

/** Manual alternative to scanning. */
function openMedicinePicker() {
  const all = sortBy(medicines().filter((m) => m.status === 'active'), (m) => m.name, 'asc');

  const rowsHtml = (list) => (list.length ? `<div class="list">${list.slice(0, 60).map((med) => {
    const summary = stockSummary(med.id);
    return `
      <button class="list-row is-clickable" type="button" data-pick="${med.id}">
        <span class="list-avatar">${icon('pill', 16)}</span>
        <span class="list-main">
          <span class="list-title">${escapeHtml(`${med.name} ${med.strength}`.trim())}</span>
          <span class="list-sub">${escapeHtml(med.form)} · ${escapeHtml(med.sku)}
            · ${int(summary.available)} available · ${summary.batches} batch(es)</span>
        </span>
        <span class="list-end">${statusBadge({
          label: summary.status === 'out' ? 'Out of stock' : (summary.status === 'low' ? 'Low' : 'In stock'),
          tone: summary.status === 'out' ? 'danger' : (summary.status === 'low' ? 'warning' : 'success')
        })}</span>
      </button>`;
  }).join('')}</div>` : emptyState({ iconName: 'search', title: 'No medicine matches that search' }));

  const modal = openModal({
    title: 'Find a medicine',
    subtitle: 'Manual alternative to scanning',
    size: 'modal-lg',
    iconName: 'search',
    body: `${searchBox({ id: 'recv-pick-search', placeholder: 'Name, generic, SKU or barcode...' })}
           <div id="recv-pick-list" class="mt-4">${rowsHtml(all)}</div>`,
    footer: `<button class="btn btn-secondary" type="button" data-modal-close>Cancel</button>
             ${can('inventory.manage') ? '<button class="btn btn-soft" type="button" data-route="#/inventory">Add a new medicine</button>' : ''}`
  });

  const search = qs('#recv-pick-search', modal.root);
  const list = qs('#recv-pick-list', modal.root);

  search.addEventListener('input', debounce(() => {
    const value = search.value;
    list.innerHTML = rowsHtml(value ? searchMedicines(value) : all);
  }, 200));

  modal.root.addEventListener('click', (event) => {
    const pick = event.target.closest('[data-pick]');
    if (!pick) return;
    modal.close();
    openLineModal(pick.getAttribute('data-pick'));
  });
}

/* ============================== CONFIRM ============================== */

async function confirmReceipt() {
  try {
    requirePermission('stock.receive');
  } catch (error) {
    notifyDenied(error);
    return;
  }

  if (!draft.lines.length) {
    notifyError('Nothing to receive', 'Scan or search for a medicine and add at least one line.');
    return;
  }
  if (!draft.supplierId) {
    notifyError('Supplier required', 'Select the supplier this delivery came from.');
    const node = qs('#recv-supplier');
    if (node) { node.classList.add('is-invalid'); node.focus(); }
    return;
  }

  const totals = draftTotals();
  const sup = supplier(draft.supplierId);

  const ok = await confirmDialog({
    title: 'Confirm this goods receipt?',
    message: `${int(totals.units)} unit(s) across ${totals.lines} line(s) will be added to inventory.`,
    detail: `
      <div class="stack-sm">
        <div class="stat-line"><span class="sl-label">Supplier</span><span class="sl-value">${escapeHtml(sup.name)}</span></div>
        <div class="stat-line"><span class="sl-label">Invoice</span><span class="sl-value">${escapeHtml(draft.invoiceNo || 'Not recorded')}</span></div>
        <div class="stat-line"><span class="sl-label">Purchased units</span><span class="sl-value">${int(totals.purchased)}</span></div>
        ${totals.bonus ? `<div class="stat-line"><span class="sl-label">Bonus units</span><span class="sl-value">${int(totals.bonus)}</span></div>` : ''}
        ${totals.newBatches ? `<div class="stat-line"><span class="sl-label">New batches</span><span class="sl-value">${int(totals.newBatches)}</span></div>` : ''}
        <div class="stat-line is-total"><span class="sl-label">Invoice value</span><span class="sl-value">${money(totals.value)}</span></div>
      </div>`,
    confirmLabel: 'Confirm receipt',
    tone: 'primary',
    iconName: 'truck'
  });
  if (!ok) return;

  try {
    const receipt = receiveGoods({
      user: ctxRef.user,
      supplierId: draft.supplierId,
      invoiceNo: draft.invoiceNo,
      note: draft.note,
      lines: draft.lines.map((l) => ({
        medicineId: l.medicineId,
        batchId: l.batchId || null,
        batchNo: l.batchNo,
        expiry: l.expiry,
        qty: l.qty,
        bonusQty: l.bonusQty,
        costPrice: l.costPrice,
        price: l.price,
        location: l.location
      }))
    }, { markPaid: draft.markPaid });

    resetDraft();
    ctxRef.refresh();
    showReceiptSummary(receipt);
  } catch (error) {
    notifyError('Receipt not confirmed', error.message);
  }
}

/** Post-confirmation summary with the QR Codes of any new batches. */
function showReceiptSummary(receipt) {
  const newBatches = receipt.lines.filter((l) => l.newBatch);
  const sup = supplier(receipt.supplierId);

  const modal = openModal({
    title: 'Goods received',
    subtitle: `${receipt.ref} - ${int(receipt.units)} units from ${sup ? sup.name : 'supplier'}`,
    size: 'modal-lg',
    iconName: 'checkCircle',
    tone: 'success',
    body: `
      <div class="stack-lg">
        <div class="alert alert-success">
          ${icon('checkCircle', 17)}
          <div>
            <div class="alert-title">Inventory updated</div>
            <div class="small">${receipt.lines.length} line(s) recorded with a stock movement each.
            ${newBatches.length ? `${newBatches.length} new batch QR Code(s) generated below.` : ''}</div>
          </div>
        </div>

        ${renderTable({
          compact: true,
          responsive: false,
          columns: [
            { key: 'medicineName', label: 'Medicine', cell: (l) => cellStack(l.medicineName, `Batch ${l.batchNo}${l.newBatch ? ' (new)' : ''}`) },
            { key: 'expiry', label: 'Expiry', cell: (l) => fmtDate(l.expiry) },
            { key: 'qty', label: 'Qty', className: 'num', cell: (l) => int(l.qty) + (l.bonusQty ? ` +${l.bonusQty}` : '') },
            { key: 'costPrice', label: 'Cost', className: 'num', cell: (l) => money(l.costPrice) },
            { key: 'lineTotal', label: 'Value', className: 'num', cell: (l) => money(l.lineTotal) }
          ],
          rows: receipt.lines,
          footer: `<tr><td colspan="4">Invoice value</td><td class="num">${money(receipt.total)}</td></tr>`
        })}

        ${newBatches.length ? `
          <section>
            <h3 class="mb-3">New batch QR Codes</h3>
            <div class="qr-grid">
              ${newBatches.map((l) => {
                const b = findBatch(l.batchId);
                return `
                  <div class="qr-card">
                    ${qrBox(b ? b.qr : '', { title: l.batchNo })}
                    <div class="qr-card-name">${escapeHtml(l.medicineName)}</div>
                    <div class="qr-card-meta">${escapeHtml(l.batchNo)} · exp ${fmtMonthYear(l.expiry)}</div>
                  </div>`;
              }).join('')}
            </div>
          </section>` : ''}
      </div>`,
    footer: `
      <button class="btn btn-secondary" type="button" data-modal-close>Close</button>
      <button class="btn btn-secondary" type="button" id="recv-print">${icon('print', 15)} Print GRN</button>
      ${newBatches.length && can('labels.print')
        ? `<button class="btn btn-primary" type="button" id="recv-labels">${icon('tag', 15)} Print batch labels</button>` : ''}`
  });

  qs('#recv-print', modal.root).addEventListener('click', () => printGrn(receipt));

  const labelsBtn = qs('#recv-labels', modal.root);
  if (labelsBtn) labelsBtn.addEventListener('click', () => {
    modal.close();
    ctxRef.navigate(`/labels?receipt=${receipt.id}`);
  });
}

function printGrn(receipt) {
  const sup = supplier(receipt.supplierId);
  const pharmacy = settings().pharmacy;

  printNode(`
    <div class="print-doc">
      ${printHeader({
        pharmacy,
        title: 'Goods Received Note',
        subtitle: receipt.ref,
        meta: `Date ${fmtDateTime(receipt.datetime)}<br>
               Received by ${escapeHtml(receipt.userName)}<br>
               Invoice ${escapeHtml(receipt.invoiceNo || '-')}`
      })}
      <h2 class="print-section">Supplier</h2>
      <p>
        <strong>${escapeHtml(sup ? sup.name : '-')}</strong><br>
        ${escapeHtml(sup ? sup.address : '')}<br>
        ${escapeHtml(sup ? sup.phone : '')} ${sup && sup.email ? `· ${escapeHtml(sup.email)}` : ''}
      </p>

      <h2 class="print-section">Items received</h2>
      <table>
        <thead><tr>
          <th>Medicine</th><th>Batch</th><th>Expiry</th>
          <th class="num">Qty</th><th class="num">Bonus</th>
          <th class="num">Unit cost</th><th class="num">Line value</th>
        </tr></thead>
        <tbody>${receipt.lines.map((l) => `<tr>
          <td>${escapeHtml(l.medicineName)}</td>
          <td>${escapeHtml(l.batchNo)}${l.newBatch ? ' (new)' : ''}</td>
          <td>${fmtDate(l.expiry)}</td>
          <td class="num">${int(l.qty)}</td>
          <td class="num">${int(l.bonusQty)}</td>
          <td class="num">${money(l.costPrice)}</td>
          <td class="num">${money(l.lineTotal)}</td>
        </tr>`).join('')}</tbody>
        <tfoot><tr>
          <td colspan="3">Totals</td>
          <td class="num">${int(receipt.lines.reduce((t, l) => t + l.qty, 0))}</td>
          <td class="num">${int(receipt.lines.reduce((t, l) => t + l.bonusQty, 0))}</td>
          <td></td>
          <td class="num">${money(receipt.total)}</td>
        </tr></tfoot>
      </table>

      ${receipt.note ? `<h2 class="print-section">Notes</h2><p>${escapeHtml(receipt.note)}</p>` : ''}

      <div style="margin-top:14mm;display:flex;gap:16mm">
        <div style="flex:1">______________________________<br><span style="font-size:7.5pt">Received by</span></div>
        <div style="flex:1">______________________________<br><span style="font-size:7.5pt">Checked by (Pharmacist)</span></div>
      </div>
      ${printFooter({ left: `${escapeHtml(pharmacy.name)}`, right: 'MediFlow Pharmacy ERP' })}
    </div>`, 'report');
}

/* ============================== HISTORY ============================== */

function openHistoryDrawer(receiptId) {
  const receipt = db.goodsReceipts.find((r) => r.id === receiptId);
  if (!receipt) return;
  const sup = supplier(receipt.supplierId);

  openDrawer({
    title: receipt.ref,
    subtitle: `${fmtDateTime(receipt.datetime)} - ${receipt.userName}`,
    size: 'drawer-lg',
    body: `
      <div class="stack-lg">
        <div class="row-wrap">
          ${badge(`${int(receipt.units)} units`, 'info')}
          ${receipt.paid ? badge('Paid', 'success') : badge('On supplier account', 'warning')}
          ${receipt.lines.some((l) => l.newBatch) ? badge(`${receipt.lines.filter((l) => l.newBatch).length} new batch(es)`, 'primary') : ''}
        </div>

        <div class="def-grid">
          <div class="def-item"><div class="def-label">Supplier</div><div class="def-value">${escapeHtml(sup ? sup.name : '-')}</div></div>
          <div class="def-item"><div class="def-label">Invoice no.</div><div class="def-value mono">${escapeHtml(receipt.invoiceNo || '-')}</div></div>
          <div class="def-item"><div class="def-label">Received by</div><div class="def-value">${escapeHtml(receipt.userName)}</div></div>
          <div class="def-item"><div class="def-label">Date</div><div class="def-value">${fmtDateTime(receipt.datetime)}</div></div>
          <div class="def-item"><div class="def-label">Invoice value</div><div class="def-value num">${money(receipt.total)}</div></div>
          <div class="def-item"><div class="def-label">Lines</div><div class="def-value num">${receipt.lines.length}</div></div>
        </div>

        ${receipt.note ? `<div class="alert alert-neutral small">${icon('info', 15)}<div>${escapeHtml(receipt.note)}</div></div>` : ''}

        <section>
          <h3 class="mb-3">Items</h3>
          ${renderTable({
            compact: true,
            responsive: false,
            columns: [
              { key: 'medicineName', label: 'Medicine', cell: (l) => cellStack(l.medicineName, `Batch ${l.batchNo}`) },
              { key: 'expiry', label: 'Expiry', cell: (l) => fmtDate(l.expiry) },
              { key: 'qty', label: 'Qty', className: 'num', cell: (l) => int(l.qty) },
              { key: 'bonusQty', label: 'Bonus', className: 'num', cell: (l) => int(l.bonusQty) },
              { key: 'costPrice', label: 'Unit cost', className: 'num', cell: (l) => money(l.costPrice) },
              { key: 'lineTotal', label: 'Value', className: 'num', cell: (l) => money(l.lineTotal) }
            ],
            rows: receipt.lines,
            footer: `<tr><td colspan="5">Total</td><td class="num">${money(receipt.total)}</td></tr>`
          })}
        </section>
      </div>`,
    footer: `<button class="btn btn-primary" type="button" id="hist-print">${icon('print', 15)} Print GRN</button>`,
    onMount: (api) => {
      qs('#hist-print', api.root).addEventListener('click', () => printGrn(receipt));
    }
  });
}

/* ============================== RENDER ============================== */

export function render(root, ctx) {
  ctxRef = ctx;

  const totals = draftTotals();
  const supplierOptions = sortBy(suppliers().filter((s) => s.active), (s) => s.name, 'asc')
    .map((s) => ({ value: s.id, label: s.name }));

  let history = sortBy(db.goodsReceipts, (r) => r.datetime, 'desc');
  if (state.query) {
    history = history.filter((r) => {
      const sup = supplier(r.supplierId);
      return matchesQuery(`${r.ref} ${r.invoiceNo} ${sup ? sup.name : ''} ${r.lines.map((l) => l.medicineName).join(' ')}`, state.query);
    });
  }
  const historyPage = paginate(history, state.historyPage, 8);

  const monthReceipts = db.goodsReceipts.filter((r) => daysUntil(r.datetime) > -31);

  root.innerHTML = `
  <div class="page">
    ${pageHead({
      title: 'Stock Received',
      subtitle: 'Scan a QR Code or search a medicine, enter the goods, review and confirm. Stock only moves on confirmation.',
      actions: `
        ${can('qr.scan') ? `<button class="btn btn-primary" type="button" id="btn-scan">${icon('scan', 16)} Scan to receive</button>` : ''}
        <button class="btn btn-secondary" type="button" id="btn-manual">${icon('search', 16)} Find medicine</button>`
    })}

    <div class="stepper">
      <span class="step ${draft.lines.length ? 'is-done' : 'is-active'}"><span class="step-num">1</span> Identify medicine</span>
      <span class="step-sep"></span>
      <span class="step ${draft.lines.length ? 'is-active' : ''}"><span class="step-num">2</span> Enter batch &amp; quantities</span>
      <span class="step-sep"></span>
      <span class="step ${draft.lines.length && draft.supplierId ? 'is-active' : ''}"><span class="step-num">3</span> Supplier &amp; invoice</span>
      <span class="step-sep"></span>
      <span class="step"><span class="step-num">4</span> Review &amp; confirm</span>
    </div>

    <div class="grid-dash">
      <div class="span-8">
        ${card({
          title: 'Receipt lines',
          sub: totals.lines
            ? `${totals.lines} line(s) - ${int(totals.units)} unit(s) pending confirmation`
            : 'Nothing added yet',
          actions: totals.lines
            ? `<button class="btn btn-ghost btn-sm" type="button" id="btn-discard">${icon('trash', 14)} Discard all</button>`
            : '',
          flush: true,
          body: renderTable({
            columns: [
              { key: 'medicineName', label: 'Medicine', cell: (l) => cellStack(l.medicineName, `${l.sku}`) },
              {
                key: 'batchNo', label: 'Batch',
                cell: (l) => `${escapeHtml(l.batchNo)} ${l.isNewBatch ? badge('New', 'primary') : badge('Top-up', 'neutral')}`
              },
              { key: 'expiry', label: 'Expiry', cell: (l) => cellStack(fmtDate(l.expiry), `${daysUntil(l.expiry)} days`) },
              {
                key: 'qty', label: 'Qty', className: 'num',
                cell: (l) => `${int(l.qty)}${l.bonusQty ? `<div class="cell-sub c-success">+${int(l.bonusQty)} free</div>` : ''}`
              },
              { key: 'costPrice', label: 'Unit cost', className: 'num', cell: (l) => money(l.costPrice) },
              { key: 'price', label: 'Sell at', className: 'num', cell: (l) => money(l.price) },
              { key: 'value', label: 'Line value', className: 'num', cell: (l) => `<strong>${money(round(l.qty * l.costPrice, 2))}</strong>` },
              {
                key: 'actions', label: '', className: 'right',
                cell: (l) => `<div class="table-actions">
                  <button class="btn btn-ghost btn-sm" type="button" data-edit-line="${l.lineId}" title="Edit line">${icon('edit', 15)}</button>
                  <button class="btn btn-ghost btn-sm" type="button" data-remove-line="${l.lineId}" title="Remove line">${icon('close', 15)}</button>
                </div>`
              }
            ],
            rows: draft.lines,
            empty: emptyState({
              iconName: 'truck',
              title: 'Start a goods receipt',
              message: 'Scan the batch QR Code on the carton, or search for the medicine by name or SKU.',
              actions: `
                ${can('qr.scan') ? '<button class="btn btn-primary btn-sm" type="button" id="btn-scan-empty">Scan to receive</button>' : ''}
                <button class="btn btn-secondary btn-sm" type="button" id="btn-manual-empty">Find medicine</button>`
            })
          })
        })}
      </div>

      <div class="span-4">
        ${card({
          title: 'Supplier & invoice',
          body: `
            <form id="recv-header" class="stack-lg" novalidate>
              <div class="field">
                <label class="label" for="recv-supplier">Supplier<span class="req">*</span></label>
                <select class="select" id="recv-supplier" name="supplierId">
                  ${options(supplierOptions, draft.supplierId, { placeholder: 'Select supplier' })}
                </select>
                ${supplierOptions.length ? '' : '<p class="field-hint c-warning">No active suppliers - add one first.</p>'}
              </div>
              <div class="field">
                <label class="label" for="recv-invoice">Supplier invoice / waybill no.</label>
                <input class="input" id="recv-invoice" name="invoiceNo" value="${escapeHtml(draft.invoiceNo)}"
                       placeholder="e.g. INV/4821/26" autocomplete="off">
              </div>
              <div class="field">
                <label class="label" for="recv-note">Notes</label>
                <textarea class="textarea" id="recv-note" name="note" rows="2"
                  placeholder="Delivery condition, short supply, driver name...">${escapeHtml(draft.note)}</textarea>
              </div>
              <label class="check">
                <input type="checkbox" id="recv-paid" ${draft.markPaid ? 'checked' : ''}>
                <span class="check-text">Invoice already paid
                  <small>Leave unticked to add the value to the supplier's outstanding balance</small></span>
              </label>
            </form>`,
          footer: `<div class="stack" style="width:100%">
            <div class="stat-line"><span class="sl-label">Purchased units</span><span class="sl-value">${int(totals.purchased)}</span></div>
            ${totals.bonus ? `<div class="stat-line"><span class="sl-label">Bonus units</span><span class="sl-value c-success">+${int(totals.bonus)}</span></div>` : ''}
            ${totals.newBatches ? `<div class="stat-line"><span class="sl-label">New batches</span><span class="sl-value">${int(totals.newBatches)}</span></div>` : ''}
            <div class="stat-line"><span class="sl-label">Retail value added</span><span class="sl-value">${money(totals.retail)}</span></div>
            <div class="stat-line is-total"><span class="sl-label">Invoice value</span><span class="sl-value">${money(totals.value)}</span></div>
            <button class="btn btn-primary btn-lg btn-block" type="button" id="btn-confirm" ${totals.lines ? '' : 'disabled'}>
              ${icon('checkCircle', 17)} Confirm receipt
            </button>
            <p class="small muted center">Inventory, stock movements and the supplier balance update together.</p>
          </div>`
        })}
      </div>

      <div class="span-12">
        ${card({
          title: 'Receiving history',
          sub: `${monthReceipts.length} receipt(s) in the last 30 days`,
          actions: `${searchBox({ id: 'hist-search', value: state.query, placeholder: 'Search receipts...' })}
            ${can('export.data') ? `<button class="btn btn-secondary btn-sm" type="button" id="btn-export">${icon('download', 14)} CSV</button>` : ''}`,
          flush: true,
          body: renderTable({
            columns: [
              { key: 'ref', label: 'Reference', cell: (r) => cellStack(r.ref, fmtRelative(r.datetime)) },
              { key: 'supplier', label: 'Supplier', cell: (r) => { const s = supplier(r.supplierId); return cellStack(s ? s.name : '-', r.invoiceNo || 'No invoice'); } },
              { key: 'lines', label: 'Lines', className: 'num', cell: (r) => int(r.lines.length) },
              { key: 'units', label: 'Units', className: 'num', cell: (r) => int(r.units) },
              { key: 'total', label: 'Value', className: 'num', cell: (r) => `<strong>${money(r.total)}</strong>` },
              { key: 'paid', label: 'Payment', cell: (r) => (r.paid ? badge('Paid', 'success') : badge('On account', 'warning')) },
              { key: 'userName', label: 'Received by', cell: (r) => escapeHtml(r.userName) },
              {
                key: 'actions', label: '', className: 'right',
                cell: (r) => `<div class="table-actions">
                  <button class="btn btn-ghost btn-sm" type="button" data-hist="${r.id}" title="View receipt">${icon('eye', 15)}</button>
                </div>`
              }
            ],
            rows: historyPage.rows,
            empty: emptyState({ iconName: 'truck', title: 'No goods receipts recorded yet' })
          }) + renderPagination(historyPage, { label: 'receipts' })
        })}
      </div>
    </div>
  </div>`;

  /* ---------------------------- events ---------------------------- */

  const rerender = () => ctx.refresh();

  qsa('#btn-scan, #btn-scan-empty', root).forEach((b) => b.addEventListener('click', openScanModal));
  qsa('#btn-manual, #btn-manual-empty', root).forEach((b) => b.addEventListener('click', openMedicinePicker));

  on(root, 'click', '[data-edit-line]', (event, node) => {
    const line = draft.lines.find((l) => l.lineId === node.getAttribute('data-edit-line'));
    if (line) openLineModal(line.medicineId, { lineId: line.lineId });
  });

  on(root, 'click', '[data-remove-line]', (event, node) => {
    const id = node.getAttribute('data-remove-line');
    const index = draft.lines.findIndex((l) => l.lineId === id);
    if (index >= 0) { draft.lines.splice(index, 1); rerender(); }
  });

  const discardBtn = qs('#btn-discard', root);
  if (discardBtn) discardBtn.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Discard this receipt?',
      message: `${draft.lines.length} unconfirmed line(s) will be removed. No stock has changed.`,
      confirmLabel: 'Discard',
      tone: 'danger',
      iconName: 'trash'
    });
    if (!ok) return;
    resetDraft();
    rerender();
  });

  // Header fields keep the draft in sync without a full re-render.
  const supplierSelect = qs('#recv-supplier', root);
  supplierSelect.addEventListener('change', () => {
    draft.supplierId = supplierSelect.value;
    supplierSelect.classList.remove('is-invalid');
  });
  qs('#recv-invoice', root).addEventListener('input', (event) => { draft.invoiceNo = event.target.value; });
  qs('#recv-note', root).addEventListener('input', (event) => { draft.note = event.target.value; });
  qs('#recv-paid', root).addEventListener('change', (event) => { draft.markPaid = event.target.checked; });

  qs('#btn-confirm', root).addEventListener('click', confirmReceipt);

  on(root, 'click', '[data-hist]', (event, node) => openHistoryDrawer(node.getAttribute('data-hist')));

  on(root, 'click', '[data-page]', (event, node) => {
    const page = num(node.getAttribute('data-page'));
    if (page >= 1 && page <= historyPage.pages) { state.historyPage = page; rerender(); }
  });

  const histSearch = qs('#hist-search', root);
  histSearch.addEventListener('input', debounce(() => {
    state.query = histSearch.value;
    state.historyPage = 1;
    const caret = histSearch.selectionStart;
    rerender();
    const next = qs('#hist-search');
    if (next) { next.focus(); next.setSelectionRange(caret, caret); }
  }, 260));

  const exportBtn = qs('#btn-export', root);
  if (exportBtn) exportBtn.addEventListener('click', () => {
    const flat = [];
    history.forEach((r) => r.lines.forEach((l) => flat.push({ r, l })));
    downloadCsv(exportName('stock-received'), flat, [
      { label: 'Receipt ref', value: ({ r }) => r.ref },
      { label: 'Date', value: ({ r }) => fmtDate(r.datetime) },
      { label: 'Supplier', value: ({ r }) => { const s = supplier(r.supplierId); return s ? s.name : ''; } },
      { label: 'Invoice no', value: ({ r }) => r.invoiceNo },
      { label: 'Medicine', value: ({ l }) => l.medicineName },
      { label: 'Batch', value: ({ l }) => l.batchNo },
      { label: 'New batch', value: ({ l }) => (l.newBatch ? 'Yes' : 'No') },
      { label: 'Expiry', value: ({ l }) => fmtDate(l.expiry) },
      { label: 'Qty', value: ({ l }) => l.qty },
      { label: 'Bonus qty', value: ({ l }) => l.bonusQty },
      { label: 'Unit cost', value: ({ l }) => l.costPrice },
      { label: 'Selling price', value: ({ l }) => l.price },
      { label: 'Line value', value: ({ l }) => l.lineTotal },
      { label: 'Received by', value: ({ r }) => r.userName }
    ]);
    notifySuccess('Export ready', `${flat.length} receipt lines exported.`);
  });
}

export default { render };
