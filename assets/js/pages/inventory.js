/* ==========================================================================
   MediFlow Pharmacy ERP - Drug Inventory
   Medicine master data and batch-level stock. Admin may add and edit medicines;
   staff get a read-only view with no cost or profit figures (section 7).
   Quantities are never editable here - stock changes only through the
   authorised receive / adjust / count workflows.
   ========================================================================== */

import {
  medicines, medicine, batchesOf, stockSummary, batchState, STATUS_LABELS, suppliers, supplier,
  createMedicine, updateMedicine, updateBatchPrice, movementsFor, isExpired, isQuarantined,
  isWrittenOff, settings, buildQrPayload, generateBatchQr
} from '../store.js';
import { can, requirePermission } from '../auth.js';
import {
  pageHead, card, icon, badge, statusBadge, renderTable, cellStack, renderPagination,
  emptyState, openModal, openDrawer, modalFooter, searchBox, options, field, selectField,
  checkField, notifySuccess, notifyError, notifyDenied, escapeHtml, qrBox, printNode,
  printHeader, printFooter, kpi
} from '../ui.js';
import {
  money, int, fmtDate, fmtMonthYear, fmtDateTime, fmtRelative, num, sortBy, unique, paginate,
  matchesQuery, formData, validate, rule, showFormErrors, qs, qsa, on, debounce, downloadCsv,
  exportName, DOSAGE_FORMS, CATEGORIES, STORAGE_CONDITIONS, daysUntil, moneyShort
} from '../utils.js';

const PER_PAGE = 12;

/** View state kept across re-renders of the page. */
const state = {
  query: '',
  category: '',
  manufacturer: '',
  status: '',
  expiry: '',
  page: 1,
  sortKey: 'name',
  sortDir: 'asc'
};

let ctxRef = null;

/* ============================== DATA SHAPING ============================== */

/** Build the display rows, applying search, filters and sorting. */
function buildRows() {
  const showCost = can('inventory.cost');

  let rows = medicines().map((med) => {
    const summary = stockSummary(med.id);
    return { med, summary, showCost };
  });

  if (state.query) {
    rows = rows.filter(({ med }) => {
      const haystack = `${med.name} ${med.genericName} ${med.strength} ${med.sku} ${med.barcode} ${med.manufacturer} ${med.category} ${med.nafdac}`;
      if (matchesQuery(haystack, state.query)) return true;
      // Scanner-style exact hits on batch number or QR payload
      return batchesOf(med.id).some((b) =>
        String(b.batchNo).toLowerCase() === state.query.toLowerCase().trim()
        || String(b.qr).toLowerCase() === state.query.toLowerCase().trim());
    });
  }
  if (state.category) rows = rows.filter(({ med }) => med.category === state.category);
  if (state.manufacturer) rows = rows.filter(({ med }) => med.manufacturer === state.manufacturer);

  if (state.status) {
    rows = rows.filter(({ med, summary }) => {
      switch (state.status) {
        case 'in': return summary.status === 'ok';
        case 'low': return summary.status === 'low';
        case 'out': return summary.status === 'out';
        case 'expiring': return summary.expiringBatches > 0;
        case 'expired': return summary.expiredUnits > 0;
        case 'quarantined': return summary.quarantinedUnits > 0;
        case 'rx': return med.prescriptionRequired;
        default: return true;
      }
    });
  }

  if (state.expiry) {
    const limit = num(state.expiry);
    rows = rows.filter(({ med }) => batchesOf(med.id).some((b) => {
      if (isWrittenOff(b) || num(b.qty) <= 0) return false;
      const days = daysUntil(b.expiry);
      return limit === -1 ? days < 0 : days >= 0 && days <= limit;
    }));
  }

  const selectors = {
    name: (r) => `${r.med.name} ${r.med.strength}`,
    category: (r) => r.med.category,
    manufacturer: (r) => r.med.manufacturer,
    available: (r) => r.summary.available,
    price: (r) => r.summary.price,
    cost: (r) => r.summary.cost,
    value: (r) => r.summary.stockValueCost,
    batches: (r) => r.summary.sellableBatches,
    expiry: (r) => r.summary.earliestExpiry || '9999-12-31'
  };

  return sortBy(rows, selectors[state.sortKey] || selectors.name, state.sortDir);
}

/* ============================== MEDICINE FORM ============================== */

function medicineFormBody(med = {}) {
  const supplierList = suppliers().map((s) => ({ value: s.id, label: s.name }));
  return `
    <form id="med-form" class="stack-lg" novalidate>
      <div class="grid-2">
        ${field({ name: 'name', label: 'Medicine / brand name', value: med.name || '', required: true, attrs: 'autofocus placeholder="e.g. Paracetamol"' })}
        ${field({ name: 'genericName', label: 'Generic name', value: med.genericName || '', attrs: 'placeholder="e.g. Paracetamol"' })}
        ${field({ name: 'strength', label: 'Strength', value: med.strength || '', attrs: 'placeholder="e.g. 500mg"' })}
        ${selectField({ name: 'form', label: 'Dosage form', list: DOSAGE_FORMS, value: med.form || 'Tablet', required: true })}
        ${selectField({ name: 'category', label: 'Category', list: CATEGORIES, value: med.category || '', required: true, placeholder: 'Select category' })}
        ${field({ name: 'manufacturer', label: 'Manufacturer', value: med.manufacturer || '', attrs: 'placeholder="e.g. Emzor"' })}
        ${field({ name: 'nafdac', label: 'NAFDAC registration no.', value: med.nafdac || '', attrs: 'placeholder="e.g. A4-5821"' })}
        ${field({ name: 'sku', label: 'SKU', value: med.sku || '', required: true, hint: 'Internal stock code, must be unique' })}
        ${field({ name: 'barcode', label: 'Barcode', value: med.barcode || '', hint: 'Manufacturer barcode, if printed on the pack' })}
        ${selectField({ name: 'supplierId', label: 'Default supplier', list: supplierList, value: med.supplierId || '', placeholder: 'Select supplier' })}
        ${selectField({ name: 'storage', label: 'Storage condition', list: STORAGE_CONDITIONS, value: med.storage || STORAGE_CONDITIONS[0] })}
        ${field({ name: 'packSize', label: 'Units per pack', type: 'number', value: num(med.packSize, 1), attrs: 'min="1" step="1"', hint: 'Pieces in one pack / card' })}
        ${field({ name: 'reorderLevel', label: 'Reorder level', type: 'number', value: num(med.reorderLevel, num(settings().inventory.reorderLevel, 20)), attrs: 'min="0" step="1"', hint: 'Low-stock alert threshold' })}
        ${selectField({ name: 'status', label: 'Product status', list: [{ value: 'active', label: 'Active' }, { value: 'discontinued', label: 'Discontinued' }], value: med.status || 'active' })}
      </div>
      <div class="alert alert-neutral">
        ${icon('info', 16)}
        <div class="small">
          <strong>Stock quantity is not editable here.</strong>
          Quantities change only through Stock Received, Stock Adjustment, Stock Count and sales,
          so every movement stays traceable.
        </div>
      </div>
      ${checkField({ name: 'prescriptionRequired', label: 'Prescription required (POM)', hint: 'POS will ask for the prescribing doctor', checked: !!med.prescriptionRequired })}
    </form>`;
}

const MEDICINE_RULES = {
  name: [rule.required('Enter the medicine name'), rule.minLen(2)],
  form: [rule.required('Select a dosage form')],
  category: [rule.required('Select a category')],
  sku: [rule.required('Enter a SKU')],
  packSize: [rule.custom((v) => num(v) >= 1, 'Pack size must be at least 1')],
  reorderLevel: [rule.minZero('Reorder level cannot be negative')]
};

function openMedicineModal(med = null) {
  try {
    requirePermission('inventory.manage');
  } catch (error) {
    notifyDenied(error);
    return;
  }

  const editing = !!med;
  const modal = openModal({
    title: editing ? `Edit ${med.name}` : 'Add a medicine',
    subtitle: editing ? `SKU ${med.sku}` : 'Create the product record, then receive stock against it',
    size: 'modal-lg',
    iconName: 'pill',
    body: medicineFormBody(med || {}),
    footer: modalFooter({ confirmLabel: editing ? 'Save changes' : 'Create medicine' })
  });

  const form = qs('#med-form', modal.root);

  const submit = () => {
    const data = formData(form);
    const { valid, errors } = validate(data, MEDICINE_RULES);

    // SKU uniqueness
    const clash = medicines().find((m) => m.sku.toLowerCase() === String(data.sku).toLowerCase() && (!editing || m.id !== med.id));
    if (clash) { errors.sku = `SKU already used by ${clash.name}`; }

    if (!valid || errors.sku) { showFormErrors(form, errors); return; }

    try {
      if (editing) {
        updateMedicine(med.id, data, ctxRef.user);
        notifySuccess('Medicine updated', `${data.name} has been saved.`);
      } else {
        createMedicine(data, ctxRef.user);
        notifySuccess('Medicine created', `${data.name} is ready to receive stock.`);
      }
      modal.close();
      ctxRef.refresh();
    } catch (error) {
      notifyError('Could not save', error.message);
    }
  };

  form.addEventListener('submit', (event) => { event.preventDefault(); submit(); });
  qs('#modal-confirm', modal.root).addEventListener('click', (event) => { event.preventDefault(); submit(); });
}

/* ============================== BATCH PRICE ============================== */

function openPriceModal(batch) {
  try {
    requirePermission('inventory.manage');
  } catch (error) {
    notifyDenied(error);
    return;
  }

  const med = medicine(batch.medicineId);
  const modal = openModal({
    title: 'Change selling price',
    subtitle: `${med.name} ${med.strength} - batch ${batch.batchNo}`,
    size: 'modal-sm',
    iconName: 'tag',
    body: `
      <form id="price-form" class="stack-lg" novalidate>
        <div class="def-grid">
          <div class="def-item"><div class="def-label">Purchase price</div><div class="def-value num">${money(batch.costPrice)}</div></div>
          <div class="def-item"><div class="def-label">Current selling price</div><div class="def-value num">${money(batch.price)}</div></div>
          <div class="def-item"><div class="def-label">Units in batch</div><div class="def-value num">${int(batch.qty)}</div></div>
        </div>
        ${field({ name: 'price', label: 'New selling price', type: 'number', value: num(batch.price), required: true, attrs: 'min="0" step="0.01" autofocus' })}
        <div class="alert alert-warning small">
          ${icon('alert', 16)}
          <div>Price changes are recorded in the activity log with your name and the previous value.</div>
        </div>
      </form>`,
    footer: modalFooter({ confirmLabel: 'Update price' })
  });

  const form = qs('#price-form', modal.root);
  const submit = () => {
    const data = formData(form);
    if (num(data.price) <= 0) {
      showFormErrors(form, { price: 'Enter a selling price greater than zero.' });
      return;
    }
    if (num(data.price) < num(batch.costPrice)) {
      showFormErrors(form, { price: `Selling below the ${money(batch.costPrice)} purchase price would lose money.` });
      return;
    }
    try {
      updateBatchPrice(batch.id, data.price, ctxRef.user);
      notifySuccess('Price updated', `Batch ${batch.batchNo} now sells at ${money(data.price)}.`);
      modal.close();
      ctxRef.refresh();
    } catch (error) {
      notifyError('Could not update price', error.message);
    }
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  qs('#modal-confirm', modal.root).addEventListener('click', (e) => { e.preventDefault(); submit(); });
}

/* ============================== MEDICINE DETAIL DRAWER ============================== */

function openMedicineDrawer(medicineId) {
  const med = medicine(medicineId);
  if (!med) return;

  const summary = stockSummary(med.id);
  const showCost = can('inventory.cost');
  const batches = sortBy(batchesOf(med.id).filter((b) => !isWrittenOff(b)), (b) => b.expiry, 'asc');
  const sup = supplier(med.supplierId);
  const movements = movementsFor({ medicineId: med.id }).slice(0, 14);

  const batchTable = renderTable({
    compact: true,
    responsive: false,
    columns: [
      {
        key: 'batchNo',
        label: 'Batch',
        cell: (b) => cellStack(b.batchNo, `${b.location || 'Unassigned'}`)
      },
      { key: 'expiry', label: 'Expiry', cell: (b) => cellStack(fmtDate(b.expiry), fmtMonthYear(b.expiry)) },
      { key: 'qty', label: 'Units', className: 'num', cell: (b) => int(b.qty) },
      ...(showCost ? [{ key: 'costPrice', label: 'Cost', className: 'num', cell: (b) => money(b.costPrice) }] : []),
      { key: 'price', label: 'Price', className: 'num', cell: (b) => money(b.price) },
      { key: 'state', label: 'Status', cell: (b) => statusBadge(batchState(b)) },
      ...(can('inventory.manage') ? [{
        key: 'actions',
        label: '',
        className: 'right',
        cell: (b) => `<div class="table-actions">
          <button class="btn btn-ghost btn-sm" type="button" data-price="${b.id}" title="Change selling price">${icon('tag', 14)}</button>
          <button class="btn btn-ghost btn-sm" type="button" data-qr="${b.id}" title="View QR Code">${icon('qr', 14)}</button>
        </div>`
      }] : [])
    ],
    rows: batches,
    rowClass: (b) => (isExpired(b) ? 'row-danger' : (isQuarantined(b) ? 'row-warning' : '')),
    empty: emptyState({
      iconName: 'box',
      title: 'No batches yet',
      message: 'Receive stock to create the first batch for this medicine.'
    })
  });

  const fefoNote = summary.sellableBatches > 1
    ? `<div class="alert alert-info small">${icon('info', 16)}
        <div><strong>FEFO:</strong> the next sale will dispense batch
        <strong>${escapeHtml(batches.find((b) => b.expiry === summary.earliestExpiry)?.batchNo || '-')}</strong>
        (expires ${fmtDate(summary.earliestExpiry)}) first.</div></div>`
    : '';

  const drawer = openDrawer({
    title: `${med.name} ${med.strength}`.trim(),
    subtitle: `${med.form} - ${med.category}`,
    size: 'drawer-lg',
    body: `
      <div class="stack-lg">
        <div class="row-wrap">
          ${statusBadge(STATUS_LABELS[summary.status])}
          ${med.prescriptionRequired ? badge('Prescription only', 'info') : badge('Over the counter', 'neutral')}
          ${med.status === 'discontinued' ? badge('Discontinued', 'danger') : ''}
          ${summary.expiredUnits ? badge(`${int(summary.expiredUnits)} expired units`, 'danger') : ''}
          ${summary.quarantinedUnits ? badge(`${int(summary.quarantinedUnits)} quarantined`, 'warning') : ''}
        </div>

        <div class="kpi-grid">
          ${kpi({ label: 'Available to sell', value: int(summary.available), iconName: 'box', tone: summary.available > summary.reorderLevel ? 'success' : 'warning', foot: `<span>Reorder at ${int(summary.reorderLevel)}</span>`, small: true })}
          ${kpi({ label: 'Selling price', value: money(summary.price), iconName: 'tag', tone: 'info', small: true })}
          ${showCost
            ? kpi({ label: 'Stock value (cost)', value: money(summary.stockValueCost), iconName: 'wallet', foot: `<span>Avg cost ${money(summary.cost)}</span>`, small: true })
            : kpi({ label: 'Batches in stock', value: int(summary.sellableBatches), iconName: 'layers', small: true })}
        </div>

        ${fefoNote}

        <section>
          <h3 class="mb-3">Product details</h3>
          <div class="def-grid">
            <div class="def-item"><div class="def-label">Generic name</div><div class="def-value">${escapeHtml(med.genericName || '-')}</div></div>
            <div class="def-item"><div class="def-label">SKU</div><div class="def-value mono">${escapeHtml(med.sku)}</div></div>
            <div class="def-item"><div class="def-label">Barcode</div><div class="def-value mono">${escapeHtml(med.barcode || '-')}</div></div>
            <div class="def-item"><div class="def-label">NAFDAC no.</div><div class="def-value mono">${escapeHtml(med.nafdac || '-')}</div></div>
            <div class="def-item"><div class="def-label">Manufacturer</div><div class="def-value">${escapeHtml(med.manufacturer || '-')}</div></div>
            <div class="def-item"><div class="def-label">Default supplier</div><div class="def-value">${escapeHtml(sup ? sup.name : '-')}</div></div>
            <div class="def-item"><div class="def-label">Storage</div><div class="def-value">${escapeHtml(med.storage || '-')}</div></div>
            <div class="def-item"><div class="def-label">Units per pack</div><div class="def-value num">${int(med.packSize)}</div></div>
            <div class="def-item"><div class="def-label">Added</div><div class="def-value">${fmtDate(med.createdAt)}</div></div>
            ${med.updatedAt ? `<div class="def-item"><div class="def-label">Last updated</div><div class="def-value">${fmtDate(med.updatedAt)}</div></div>` : ''}
          </div>
        </section>

        <section>
          <div class="section-head mb-3">
            <h3>Batches (${batches.length})</h3>
            ${can('stock.receive') ? `<div class="section-actions">
              <button class="btn btn-secondary btn-sm" type="button" data-route="#/receive">${icon('truck', 14)} Receive stock</button>
            </div>` : ''}
          </div>
          ${batchTable}
        </section>

        <section>
          <h3 class="mb-3">Recent stock movements</h3>
          ${movements.length ? `<div class="timeline">${movements.map((m) => `
            <div class="timeline-item tone-${m.qty > 0 ? 'success' : 'danger'}">
              <div class="row-sm" style="justify-content:space-between">
                <strong class="sm">${m.qty > 0 ? '+' : ''}${int(m.qty)} units · ${escapeHtml(movementLabel(m.type))}</strong>
                <span class="small muted">${fmtRelative(m.datetime)}</span>
              </div>
              <div class="small muted">
                Batch ${escapeHtml(m.batchNo)} · ${int(m.before)} → ${int(m.after)}
                · ${escapeHtml(m.userName)}${m.ref ? ` · <span class="mono">${escapeHtml(m.ref)}</span>` : ''}
              </div>
              ${m.note ? `<div class="small subtle">${escapeHtml(m.note)}</div>` : ''}
            </div>`).join('')}</div>`
            : emptyState({ iconName: 'history', title: 'No movements recorded' })}
        </section>
      </div>`,
    footer: `
      ${can('inventory.manage') ? `<button class="btn btn-secondary" type="button" data-edit="${med.id}">${icon('edit', 15)} Edit medicine</button>` : ''}
      ${can('pos.use') ? `<button class="btn btn-primary" type="button" data-sell="${med.id}">${icon('pos', 15)} Sell this medicine</button>` : ''}
    `
  });

  // Drawer actions
  drawer.root.addEventListener('click', (event) => {
    const priceBtn = event.target.closest('[data-price]');
    if (priceBtn) {
      const b = batches.find((x) => x.id === priceBtn.getAttribute('data-price'));
      drawer.close();
      openPriceModal(b);
      return;
    }
    const qrBtn = event.target.closest('[data-qr]');
    if (qrBtn) {
      const b = batches.find((x) => x.id === qrBtn.getAttribute('data-qr'));
      showBatchQr(b, med);
      return;
    }
    const editBtn = event.target.closest('[data-edit]');
    if (editBtn) {
      drawer.close();
      openMedicineModal(med);
      return;
    }
    const sellBtn = event.target.closest('[data-sell]');
    if (sellBtn) {
      drawer.close();
      ctxRef.navigate(`/pos?medicine=${med.id}`);
    }
  });
}

function movementLabel(type) {
  const labels = {
    receipt: 'Goods received',
    sale: 'Sale',
    'sale-void': 'Sale voided',
    return: 'Customer return',
    adjustment: 'Stock adjustment',
    'stock-count': 'Stock count correction',
    'write-off': 'Written off',
    'supplier-return': 'Returned to supplier'
  };
  return labels[type] || type;
}

/** Small QR preview with print and regenerate actions. */
function showBatchQr(batch, med) {
  if (!batch.qr) generateBatchQr(batch.id, ctxRef.user, { silent: true });
  const payload = batch.qr || buildQrPayload(med, batch);

  const modal = openModal({
    title: 'Batch QR Code',
    subtitle: `${med.name} ${med.strength} - ${batch.batchNo}`,
    size: 'modal-sm',
    iconName: 'qr',
    body: `
      <div class="center stack">
        ${qrBox(payload, { size: 190, title: batch.batchNo })}
        <div class="def-grid mt-4" style="text-align:left">
          <div class="def-item"><div class="def-label">Batch number</div><div class="def-value mono">${escapeHtml(batch.batchNo)}</div></div>
          <div class="def-item"><div class="def-label">Expiry</div><div class="def-value">${fmtDate(batch.expiry)}</div></div>
          <div class="def-item"><div class="def-label">Units</div><div class="def-value num">${int(batch.qty)}</div></div>
          <div class="def-item"><div class="def-label">Selling price</div><div class="def-value num">${money(batch.price)}</div></div>
        </div>
        <div class="alert alert-neutral small mt-3" style="text-align:left">
          ${icon('info', 15)}
          <div>The code carries only internal identifiers. Price and quantity are always read
          from the live inventory record when scanned.</div>
        </div>
        <p class="small mono subtle" style="word-break:break-all">${escapeHtml(payload)}</p>
      </div>`,
    footer: `
      <button class="btn btn-secondary" type="button" data-modal-close>Close</button>
      ${can('labels.print') ? `<button class="btn btn-primary" type="button" id="qr-print">${icon('print', 15)} Print label</button>` : ''}`
  });

  const printBtn = qs('#qr-print', modal.root);
  if (printBtn) {
    printBtn.addEventListener('click', () => {
      ctxRef.navigate(`/labels?batch=${batch.id}`);
      modal.close();
    });
  }
}

/* ============================== EXPORT ============================== */

function exportCsv(rows) {
  try {
    requirePermission('export.data');
  } catch (error) {
    notifyDenied(error);
    return;
  }
  const showCost = can('inventory.cost');
  const columns = [
    { label: 'Medicine', value: (r) => `${r.med.name} ${r.med.strength}`.trim() },
    { label: 'Generic', value: (r) => r.med.genericName },
    { label: 'Form', value: (r) => r.med.form },
    { label: 'Category', value: (r) => r.med.category },
    { label: 'Manufacturer', value: (r) => r.med.manufacturer },
    { label: 'SKU', value: (r) => r.med.sku },
    { label: 'Barcode', value: (r) => r.med.barcode },
    { label: 'NAFDAC', value: (r) => r.med.nafdac },
    { label: 'Prescription only', value: (r) => (r.med.prescriptionRequired ? 'Yes' : 'No') },
    { label: 'Available units', value: (r) => r.summary.available },
    { label: 'Batches', value: (r) => r.summary.sellableBatches },
    { label: 'Reorder level', value: (r) => r.summary.reorderLevel },
    { label: 'Earliest expiry', value: (r) => (r.summary.earliestExpiry ? fmtDate(r.summary.earliestExpiry) : '') },
    { label: 'Selling price', value: (r) => r.summary.price },
    ...(showCost ? [
      { label: 'Average cost', value: (r) => r.summary.cost },
      { label: 'Stock value (cost)', value: (r) => r.summary.stockValueCost },
      { label: 'Stock value (retail)', value: (r) => r.summary.stockValueRetail }
    ] : []),
    { label: 'Status', value: (r) => STATUS_LABELS[r.summary.status].label }
  ];
  downloadCsv(exportName('inventory'), rows, columns);
  notifySuccess('Export ready', `${rows.length} medicines exported to CSV.`);
}

function printInventory(rows) {
  const showCost = can('inventory.cost');
  const pharmacy = settings().pharmacy;
  const totalValue = rows.reduce((t, r) => t + r.summary.stockValueCost, 0);

  printNode(`
    <div class="print-doc">
      ${printHeader({
        pharmacy,
        title: 'Stock Position Report',
        subtitle: 'Drug Inventory',
        meta: `Generated ${fmtDateTime(new Date())}<br>By ${escapeHtml(ctxRef.user.name)}<br>${rows.length} medicines`
      })}
      <table>
        <thead><tr>
          <th>Medicine</th><th>SKU</th><th>Category</th>
          <th class="num">Available</th><th class="num">Batches</th>
          <th>Earliest expiry</th><th class="num">Price</th>
          ${showCost ? '<th class="num">Value (cost)</th>' : ''}
          <th>Status</th>
        </tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td>${escapeHtml(`${r.med.name} ${r.med.strength}`)}</td>
          <td>${escapeHtml(r.med.sku)}</td>
          <td>${escapeHtml(r.med.category)}</td>
          <td class="num">${int(r.summary.available)}</td>
          <td class="num">${int(r.summary.sellableBatches)}</td>
          <td>${r.summary.earliestExpiry ? fmtDate(r.summary.earliestExpiry) : '-'}</td>
          <td class="num">${money(r.summary.price)}</td>
          ${showCost ? `<td class="num">${money(r.summary.stockValueCost)}</td>` : ''}
          <td>${STATUS_LABELS[r.summary.status].label}</td>
        </tr>`).join('')}</tbody>
        ${showCost ? `<tfoot><tr>
          <td colspan="7">Total stock value at cost</td>
          <td class="num">${money(totalValue)}</td><td></td>
        </tr></tfoot>` : ''}
      </table>
      ${printFooter({ left: `${escapeHtml(pharmacy.name)} - confidential`, right: 'MediFlow Pharmacy ERP' })}
    </div>`, 'report');
}

/* ============================== RENDER ============================== */

export function render(root, ctx) {
  ctxRef = ctx;

  // Deep links such as #/inventory?filter=low
  if (ctx.query.filter && ctx.query.filter !== state.status) {
    state.status = ctx.query.filter;
    state.page = 1;
  }
  if (ctx.query.q) state.query = ctx.query.q;

  const showCost = can('inventory.cost');
  const allRows = buildRows();
  const pageData = paginate(allRows, state.page, PER_PAGE);

  const totals = {
    medicines: allRows.length,
    units: allRows.reduce((t, r) => t + r.summary.available, 0),
    value: allRows.reduce((t, r) => t + r.summary.stockValueCost, 0),
    retail: allRows.reduce((t, r) => t + r.summary.stockValueRetail, 0),
    low: allRows.filter((r) => r.summary.status === 'low' || r.summary.status === 'out').length
  };

  const columns = [
    {
      key: 'name', label: 'Medicine', sortable: true,
      cell: (r) => `<button class="btn-ghost" type="button" data-open="${r.med.id}" style="text-align:left;display:block;width:100%">
        ${cellStack(`${r.med.name} ${r.med.strength}`.trim(), `${r.med.genericName || r.med.form} · ${r.med.sku}`)}
      </button>`
    },
    { key: 'category', label: 'Category', sortable: true, cell: (r) => cellStack(r.med.category, r.med.manufacturer) },
    {
      key: 'batches', label: 'Batches', className: 'num', sortable: true,
      cell: (r) => `${int(r.summary.sellableBatches)}${r.summary.quarantinedUnits || r.summary.expiredUnits
        ? `<div class="cell-sub c-warning">+${int(r.summary.quarantinedUnits + r.summary.expiredUnits)} held</div>` : ''}`
    },
    {
      key: 'available', label: 'Available', className: 'num', sortable: true,
      cell: (r) => `<strong>${int(r.summary.available)}</strong><div class="cell-sub">of ${int(r.summary.reorderLevel)} min</div>`
    },
    {
      key: 'expiry', label: 'Next expiry', sortable: true,
      cell: (r) => {
        if (!r.summary.earliestExpiry) return '<span class="subtle">-</span>';
        const days = daysUntil(r.summary.earliestExpiry);
        const tone = days <= 30 ? 'c-danger' : (days <= 90 ? 'c-warning' : '');
        return `<div class="${tone}">${fmtDate(r.summary.earliestExpiry)}</div><div class="cell-sub">${days} days</div>`;
      }
    },
    { key: 'price', label: 'Price', className: 'num', sortable: true, cell: (r) => money(r.summary.price) },
    ...(showCost ? [
      { key: 'cost', label: 'Cost', className: 'num', sortable: true, cell: (r) => money(r.summary.cost) },
      { key: 'value', label: 'Stock value', className: 'num', sortable: true, cell: (r) => money(r.summary.stockValueCost) }
    ] : []),
    { key: 'status', label: 'Status', cell: (r) => statusBadge(STATUS_LABELS[r.summary.status]) },
    {
      key: 'actions', label: '', className: 'right',
      cell: (r) => `<div class="table-actions">
        <button class="btn btn-ghost btn-sm" type="button" data-open="${r.med.id}" title="View details">${icon('eye', 15)}</button>
        ${can('inventory.manage') ? `<button class="btn btn-ghost btn-sm" type="button" data-edit="${r.med.id}" title="Edit medicine">${icon('edit', 15)}</button>` : ''}
      </div>`
    }
  ];

  root.innerHTML = `
  <div class="page">
    ${pageHead({
      title: 'Drug Inventory',
      subtitle: can('inventory.manage')
        ? 'Medicine master data and batch-level stock. Quantities change only through authorised stock workflows.'
        : 'Read-only view of medicine availability. Cost prices are not shown to staff accounts.',
      actions: `
        ${can('export.data') ? `<button class="btn btn-secondary" type="button" id="btn-export">${icon('download', 16)} Export CSV</button>` : ''}
        <button class="btn btn-secondary" type="button" id="btn-print">${icon('print', 16)} Print</button>
        ${can('stock.receive') ? `<button class="btn btn-secondary" type="button" data-route="#/receive">${icon('truck', 16)} Receive stock</button>` : ''}
        ${can('inventory.manage') ? `<button class="btn btn-primary" type="button" id="btn-add">${icon('plus', 16)} Add medicine</button>` : ''}`
    })}

    <div class="kpi-grid">
      ${kpi({ label: 'Medicines listed', value: int(totals.medicines), iconName: 'pill', small: true })}
      ${kpi({ label: 'Sellable units', value: int(totals.units), iconName: 'box', tone: 'info', small: true })}
      ${showCost
        ? kpi({ label: 'Stock value at cost', value: moneyShort(totals.value), iconName: 'wallet', tone: 'success', foot: `<span>Retail ${moneyShort(totals.retail)}</span>`, small: true })
        : kpi({ label: 'Categories', value: int(unique(allRows.map((r) => r.med.category)).length), iconName: 'layers', small: true })}
      ${kpi({ label: 'Needing reorder', value: int(totals.low), iconName: 'alert', tone: totals.low ? 'warning' : '', small: true })}
    </div>

    <div class="toolbar">
      ${searchBox({ id: 'inv-search', value: state.query, placeholder: 'Search name, generic, SKU, barcode, batch or QR...' })}
      <div class="toolbar-group">
        <select class="select filter-select" id="f-category" aria-label="Filter by category">
          ${options(unique(medicines().map((m) => m.category)).sort(), state.category, { placeholder: 'All categories' })}
        </select>
        <select class="select filter-select" id="f-manufacturer" aria-label="Filter by manufacturer">
          ${options(unique(medicines().map((m) => m.manufacturer).filter(Boolean)).sort(), state.manufacturer, { placeholder: 'All manufacturers' })}
        </select>
        <select class="select filter-select" id="f-status" aria-label="Filter by stock status">
          ${options([
            { value: 'in', label: 'In stock' },
            { value: 'low', label: 'Low stock' },
            { value: 'out', label: 'Out of stock' },
            { value: 'expiring', label: 'Expiring soon' },
            { value: 'expired', label: 'Has expired stock' },
            { value: 'quarantined', label: 'Has quarantined stock' },
            { value: 'rx', label: 'Prescription only' }
          ], state.status, { placeholder: 'All stock statuses' })}
        </select>
        <select class="select filter-select" id="f-expiry" aria-label="Filter by expiry window">
          ${options([
            { value: '-1', label: 'Expired batches' },
            { value: '30', label: 'Expiring in 30 days' },
            { value: '60', label: 'Expiring in 60 days' },
            { value: '90', label: 'Expiring in 90 days' }
          ], state.expiry, { placeholder: 'Any expiry' })}
        </select>
        ${(state.query || state.category || state.manufacturer || state.status || state.expiry)
          ? '<button class="btn btn-ghost btn-sm" type="button" id="btn-clear">Clear filters</button>' : ''}
      </div>
    </div>

    ${card({
      flush: true,
      body: renderTable({
        columns,
        rows: pageData.rows,
        sort: { key: state.sortKey, dir: state.sortDir },
        rowClass: (r) => (r.summary.status === 'out' ? 'row-danger' : (r.summary.status === 'low' ? 'row-warning' : '')),
        empty: emptyState({
          iconName: 'search',
          title: 'No medicines match your filters',
          message: 'Adjust the search terms or clear the filters to see the full inventory.',
          actions: '<button class="btn btn-secondary btn-sm" type="button" id="btn-clear-empty">Clear filters</button>'
        })
      }) + renderPagination(pageData, { label: 'medicines' })
    })}
  </div>`;

  /* ---------------------------- events ---------------------------- */

  const rerender = () => ctx.refresh();

  const search = qs('#inv-search', root);
  search.addEventListener('input', debounce(() => {
    state.query = search.value;
    state.page = 1;
    const caret = search.selectionStart;
    rerender();
    const next = qs('#inv-search');
    if (next) { next.focus(); next.setSelectionRange(caret, caret); }
  }, 260));

  const bindFilter = (id, key) => {
    const node = qs(id, root);
    if (!node) return;
    node.addEventListener('change', () => { state[key] = node.value; state.page = 1; rerender(); });
  };
  bindFilter('#f-category', 'category');
  bindFilter('#f-manufacturer', 'manufacturer');
  bindFilter('#f-status', 'status');
  bindFilter('#f-expiry', 'expiry');

  qsa('#btn-clear, #btn-clear-empty', root).forEach((btn) => btn.addEventListener('click', () => {
    Object.assign(state, { query: '', category: '', manufacturer: '', status: '', expiry: '', page: 1 });
    ctx.navigate('/inventory');
    rerender();
  }));

  on(root, 'click', '[data-sort]', (event, node) => {
    const key = node.getAttribute('data-sort');
    if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    else { state.sortKey = key; state.sortDir = 'asc'; }
    rerender();
  });

  on(root, 'click', '[data-page]', (event, node) => {
    const page = num(node.getAttribute('data-page'));
    if (page >= 1 && page <= pageData.pages) { state.page = page; rerender(); }
  });

  on(root, 'click', '[data-open]', (event, node) => openMedicineDrawer(node.getAttribute('data-open')));
  on(root, 'click', '[data-edit]', (event, node) => {
    event.stopPropagation();
    openMedicineModal(medicine(node.getAttribute('data-edit')));
  });

  const addBtn = qs('#btn-add', root);
  if (addBtn) addBtn.addEventListener('click', () => openMedicineModal());

  const exportBtn = qs('#btn-export', root);
  if (exportBtn) exportBtn.addEventListener('click', () => exportCsv(allRows));

  qs('#btn-print', root).addEventListener('click', () => printInventory(allRows));
}

export default { render };
