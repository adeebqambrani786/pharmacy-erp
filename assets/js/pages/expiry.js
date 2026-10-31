/* ==========================================================================
   MediFlow Pharmacy ERP - Expiry & Quarantine (admin only)
   Expired batches are detected automatically and quarantined so they can never
   be dispensed. From here stock can be returned to the supplier or written off
   with a full audit trail (section 15).
   ========================================================================== */

import {
  medicine, batch as findBatch, expiryBuckets, batchState, isExpired, isQuarantined,
  isWrittenOff, setBatchQuarantine, writeOffBatch, returnBatchToSupplier, supplier, settings,
  movementsFor, autoQuarantineExpired
} from '../store.js';
import { can, requirePermission } from '../auth.js';
import {
  pageHead, card, kpi, icon, badge, statusBadge, renderTable, cellStack, emptyState, openModal,
  openDrawer, modalFooter, confirmDialog, promptDialog, notifySuccess, notifyError,
  notifyWarning, notifyDenied, escapeHtml, searchBox, selectField, field, printNode,
  printHeader, printFooter, donutChart
} from '../ui.js';
import {
  money, int, num, round, fmtDate, fmtDateTime, fmtRelative, daysUntil, sortBy, qs, qsa, on,
  debounce, matchesQuery, sum, formData, downloadCsv, exportName, paginate
} from '../utils.js';

const TABS = [
  { key: 'expired', label: 'Expired' },
  { key: 'd30', label: 'Within 30 days' },
  { key: 'd60', label: '31-60 days' },
  { key: 'd90', label: '61-90 days' },
  { key: 'quarantined', label: 'Quarantined' }
];

const state = { tab: 'expired', query: '', selected: new Set(), page: 1 };

let ctxRef = null;

/* ============================== ROWS ============================== */

function tabRows(buckets) {
  let rows = buckets[state.tab] || [];
  if (state.query) {
    rows = rows.filter((b) => {
      const med = medicine(b.medicineId);
      return matchesQuery(`${med ? med.name : ''} ${med ? med.strength : ''} ${med ? med.sku : ''} ${b.batchNo} ${b.location}`, state.query);
    });
  }
  return sortBy(rows, (b) => b.expiry, 'asc');
}

function valueOf(rows) {
  return round(sum(rows, (b) => num(b.qty) * num(b.costPrice)), 2);
}

/* ============================== SINGLE-BATCH ACTIONS ============================== */

async function writeOffFlow(batchId) {
  try {
    requirePermission('expiry.manage');
  } catch (error) {
    notifyDenied(error);
    return;
  }

  const batch = findBatch(batchId);
  if (!batch) return;
  const med = medicine(batch.medicineId);

  const modal = openModal({
    title: 'Write off stock',
    subtitle: `${med.name} ${med.strength} - batch ${batch.batchNo}`,
    size: 'modal-sm',
    iconName: 'trash',
    tone: 'danger',
    body: `
      <form id="wo-form" class="stack-lg" novalidate>
        <div class="card card-pad">
          <div class="def-grid">
            <div class="def-item"><div class="def-label">Units to write off</div><div class="def-value num"><strong>${int(batch.qty)}</strong></div></div>
            <div class="def-item"><div class="def-label">Expiry</div><div class="def-value">${fmtDate(batch.expiry)}</div></div>
            <div class="def-item"><div class="def-label">Value at cost</div><div class="def-value num c-danger">${money(round(num(batch.qty) * num(batch.costPrice), 2))}</div></div>
          </div>
        </div>
        ${selectField({
          name: 'reason', label: 'Disposal reason', required: true,
          list: ['Expired / Disposed', 'Damaged', 'Lost / Stolen', 'Other'],
          value: isExpired(batch) ? 'Expired / Disposed' : 'Damaged'
        })}
        <div class="field">
          <label class="label" for="wo-note">Disposal note</label>
          <textarea class="textarea" id="wo-note" name="note" rows="2"
            placeholder="Disposal method, witness, waste collection reference..."></textarea>
        </div>
        <div class="alert alert-danger small">
          ${icon('alert', 16)}
          <div>This removes all remaining units and closes the batch permanently.
          The loss is recorded against you in the adjustment history.</div>
        </div>
      </form>`,
    footer: modalFooter({ confirmLabel: 'Write off stock', tone: 'danger' })
  });

  const form = qs('#wo-form', modal.root);
  const submit = () => {
    const data = formData(form);
    try {
      const record = writeOffBatch(batch.id, ctxRef.user, { reason: data.reason, note: data.note });
      modal.close();
      notifySuccess('Stock written off', `${record.ref}: ${int(record.qty)} unit(s) removed, ${money(Math.abs(record.valueImpact))} loss recorded.`);
      ctxRef.refresh();
    } catch (error) {
      notifyError('Could not write off this batch', error.message);
    }
  };
  form.addEventListener('submit', (event) => { event.preventDefault(); submit(); });
  qs('#modal-confirm', modal.root).addEventListener('click', (event) => { event.preventDefault(); submit(); });
}

function returnToSupplierFlow(batchId) {
  try {
    requirePermission('expiry.manage');
  } catch (error) {
    notifyDenied(error);
    return;
  }

  const batch = findBatch(batchId);
  if (!batch) return;
  const med = medicine(batch.medicineId);
  const sup = supplier(batch.supplierId);

  const modal = openModal({
    title: 'Return to supplier',
    subtitle: `${med.name} ${med.strength} - batch ${batch.batchNo}`,
    size: 'modal-sm',
    iconName: 'truck',
    body: `
      <form id="rts-form" class="stack-lg" novalidate>
        <div class="card card-pad">
          <div class="def-grid">
            <div class="def-item"><div class="def-label">Supplier</div><div class="def-value">${escapeHtml(sup ? sup.name : 'Not recorded')}</div></div>
            <div class="def-item"><div class="def-label">Units on hand</div><div class="def-value num">${int(batch.qty)}</div></div>
            <div class="def-item"><div class="def-label">Unit cost</div><div class="def-value num">${money(batch.costPrice)}</div></div>
            ${sup ? `<div class="def-item"><div class="def-label">Current balance owed</div><div class="def-value num">${money(sup.balance)}</div></div>` : ''}
          </div>
        </div>
        ${field({
          name: 'qty', label: 'Quantity being returned', type: 'number', required: true,
          value: int(batch.qty), attrs: `min="1" max="${int(batch.qty)}" step="1" autofocus`
        })}
        <div class="field">
          <label class="label" for="rts-note">Note / waybill reference</label>
          <textarea class="textarea" id="rts-note" name="note" rows="2"
            placeholder="Credit note expected, driver name, waybill no..."></textarea>
        </div>
        ${sup ? `<div class="alert alert-info small">${icon('info', 15)}
          <div>The returned value is deducted from what you owe ${escapeHtml(sup.name)}.</div></div>`
          : `<div class="alert alert-warning small">${icon('alert', 15)}
            <div>No supplier is linked to this batch, so no balance will be adjusted.</div></div>`}
      </form>`,
    footer: modalFooter({ confirmLabel: 'Record return', tone: 'primary' })
  });

  const form = qs('#rts-form', modal.root);
  const submit = () => {
    const data = formData(form);
    const qty = Math.round(num(data.qty));
    if (qty <= 0 || qty > num(batch.qty)) {
      notifyError('Invalid quantity', `Enter a quantity between 1 and ${int(batch.qty)}.`);
      return;
    }
    try {
      const record = returnBatchToSupplier(batch.id, ctxRef.user, { qty, note: data.note });
      modal.close();
      notifySuccess('Return recorded', `${record.ref}: ${int(qty)} unit(s) returned, ${money(Math.abs(record.valueImpact))} credited.`);
      ctxRef.refresh();
    } catch (error) {
      notifyError('Could not record the return', error.message);
    }
  };
  form.addEventListener('submit', (event) => { event.preventDefault(); submit(); });
  qs('#modal-confirm', modal.root).addEventListener('click', (event) => { event.preventDefault(); submit(); });
}

async function quarantineFlow(batchId, quarantined) {
  try {
    requirePermission('expiry.manage');
  } catch (error) {
    notifyDenied(error);
    return;
  }

  const batch = findBatch(batchId);
  if (!batch) return;
  const med = medicine(batch.medicineId);

  if (quarantined) {
    const reason = await promptDialog({
      title: 'Quarantine this batch?',
      label: 'Quarantine reason',
      placeholder: 'e.g. Suspected damage, recall notice, storage breach',
      multiline: true,
      required: true,
      confirmLabel: 'Quarantine batch',
      tone: 'warning',
      hint: `${int(batch.qty)} unit(s) of ${med.name} batch ${batch.batchNo} will be blocked from sale.`
    });
    if (!reason) return;
    try {
      setBatchQuarantine(batch.id, true, ctxRef.user, reason);
      notifyWarning('Batch quarantined', `${int(batch.qty)} unit(s) can no longer be dispensed.`);
      ctxRef.refresh();
    } catch (error) {
      notifyError('Could not quarantine', error.message);
    }
    return;
  }

  const ok = await confirmDialog({
    title: 'Release this batch back to sellable stock?',
    message: `${med.name} ${med.strength} batch ${batch.batchNo} (${int(batch.qty)} units) will become available at the point of sale again.`,
    detail: batch.quarantineReason ? `<div class="small">Quarantined because: ${escapeHtml(batch.quarantineReason)}</div>` : '',
    confirmLabel: 'Release batch',
    tone: 'primary',
    iconName: 'checkCircle'
  });
  if (!ok) return;

  try {
    setBatchQuarantine(batch.id, false, ctxRef.user);
    notifySuccess('Batch released', `${med.name} batch ${batch.batchNo} is sellable again.`);
    ctxRef.refresh();
  } catch (error) {
    notifyError('Could not release this batch', error.message);
  }
}

/* ============================== BULK ACTIONS ============================== */

async function bulkWriteOff(batchIds) {
  const batches = batchIds.map(findBatch).filter((b) => b && num(b.qty) > 0);
  if (!batches.length) {
    notifyError('Nothing selected', 'Select at least one batch with stock remaining.');
    return;
  }

  const totalUnits = sum(batches, (b) => b.qty);
  const totalValue = valueOf(batches);

  const reason = await promptDialog({
    title: `Write off ${batches.length} batch(es)?`,
    label: 'Disposal reason',
    value: 'Expired / Disposed',
    placeholder: 'Reason recorded against every batch',
    required: true,
    confirmLabel: `Write off ${int(totalUnits)} units`,
    tone: 'danger',
    hint: `${int(totalUnits)} unit(s) worth ${money(totalValue)} at cost will be removed permanently.`
  });
  if (!reason) return;

  let done = 0;
  const failures = [];
  batches.forEach((b) => {
    try {
      writeOffBatch(b.id, ctxRef.user, { reason, note: 'Bulk write-off' });
      done++;
    } catch (error) {
      failures.push(`${b.batchNo}: ${error.message}`);
    }
  });

  state.selected.clear();
  if (done) notifySuccess('Stock written off', `${done} batch(es) closed, ${money(totalValue)} loss recorded.`);
  if (failures.length) notifyError('Some batches failed', failures.slice(0, 2).join(' | '));
  ctxRef.refresh();
}

async function bulkQuarantine(batchIds) {
  const batches = batchIds.map(findBatch).filter((b) => b && !isQuarantined(b) && !isWrittenOff(b));
  if (!batches.length) {
    notifyError('Nothing to quarantine', 'The selected batches are already quarantined or closed.');
    return;
  }

  const reason = await promptDialog({
    title: `Quarantine ${batches.length} batch(es)?`,
    label: 'Quarantine reason',
    placeholder: 'e.g. Pending supplier inspection',
    required: true,
    confirmLabel: 'Quarantine batches',
    tone: 'warning'
  });
  if (!reason) return;

  batches.forEach((b) => {
    try { setBatchQuarantine(b.id, true, ctxRef.user, reason); } catch { /* skip */ }
  });
  state.selected.clear();
  notifyWarning('Batches quarantined', `${batches.length} batch(es) blocked from sale.`);
  ctxRef.refresh();
}

/* ============================== DETAIL ============================== */

function openBatchDrawer(batchId) {
  const batch = findBatch(batchId);
  if (!batch) return;
  const med = medicine(batch.medicineId);
  const sup = supplier(batch.supplierId);
  const movements = movementsFor({ batchId: batch.id }).slice(0, 12);
  const days = daysUntil(batch.expiry);

  openDrawer({
    title: `${med.name} ${med.strength}`.trim(),
    subtitle: `Batch ${batch.batchNo} - ${days < 0 ? `expired ${Math.abs(days)} days ago` : `expires in ${days} days`}`,
    body: `
      <div class="stack-lg">
        <div class="row-wrap">
          ${statusBadge(batchState(batch))}
          ${batch.quarantineReason ? badge(`Reason: ${batch.quarantineReason}`, 'warning') : ''}
        </div>

        ${isExpired(batch) ? `
          <div class="alert alert-danger">
            ${icon('alertCircle', 17)}
            <div>
              <div class="alert-title">Expired ${fmtDate(batch.expiry)}</div>
              <div class="small">These units are blocked from sale. Return them to the supplier
              or write them off so inventory value stays accurate.</div>
            </div>
          </div>` : ''}

        <div class="def-grid">
          <div class="def-item"><div class="def-label">Units on hand</div><div class="def-value num"><strong>${int(batch.qty)}</strong></div></div>
          <div class="def-item"><div class="def-label">Expiry date</div><div class="def-value">${fmtDate(batch.expiry)}</div></div>
          <div class="def-item"><div class="def-label">Unit cost</div><div class="def-value num">${money(batch.costPrice)}</div></div>
          <div class="def-item"><div class="def-label">Value at cost</div><div class="def-value num">${money(round(num(batch.qty) * num(batch.costPrice), 2))}</div></div>
          <div class="def-item"><div class="def-label">Selling price</div><div class="def-value num">${money(batch.price)}</div></div>
          <div class="def-item"><div class="def-label">Location</div><div class="def-value">${escapeHtml(batch.location || '-')}</div></div>
          <div class="def-item"><div class="def-label">Supplier</div><div class="def-value">${escapeHtml(sup ? sup.name : '-')}</div></div>
          <div class="def-item"><div class="def-label">Received</div><div class="def-value">${fmtDate(batch.receivedAt)}</div></div>
          ${batch.quarantinedAt ? `<div class="def-item"><div class="def-label">Quarantined</div><div class="def-value">${fmtDateTime(batch.quarantinedAt)}</div></div>` : ''}
        </div>

        <section>
          <h3 class="mb-3">Batch movement history</h3>
          ${movements.length ? `<div class="timeline">${movements.map((m) => `
            <div class="timeline-item tone-${m.qty > 0 ? 'success' : 'danger'}">
              <div class="row-sm" style="justify-content:space-between">
                <strong class="sm">${m.qty > 0 ? '+' : ''}${int(m.qty)} units · ${escapeHtml(m.type)}</strong>
                <span class="small muted">${fmtRelative(m.datetime)}</span>
              </div>
              <div class="small muted">${int(m.before)} → ${int(m.after)} · ${escapeHtml(m.userName)}
                ${m.ref ? `· <span class="mono">${escapeHtml(m.ref)}</span>` : ''}</div>
              ${m.note ? `<div class="small subtle">${escapeHtml(m.note)}</div>` : ''}
            </div>`).join('')}</div>`
            : emptyState({ iconName: 'history', title: 'No movements recorded' })}
        </section>
      </div>`,
    footer: `
      ${num(batch.qty) > 0 && !isWrittenOff(batch)
        ? `<button class="btn btn-secondary" type="button" data-rts="${batch.id}">${icon('truck', 15)} Return to supplier</button>` : ''}
      ${!isExpired(batch) && isQuarantined(batch)
        ? `<button class="btn btn-soft" type="button" data-release="${batch.id}">${icon('checkCircle', 15)} Release</button>` : ''}
      ${!isQuarantined(batch) && !isWrittenOff(batch)
        ? `<button class="btn btn-warning-soft" type="button" data-quarantine="${batch.id}">${icon('alert', 15)} Quarantine</button>` : ''}
      ${num(batch.qty) > 0 && !isWrittenOff(batch)
        ? `<button class="btn btn-danger" type="button" data-writeoff="${batch.id}">${icon('trash', 15)} Write off</button>` : ''}`,
    onMount: (api) => {
      api.root.addEventListener('click', (event) => {
        const wo = event.target.closest('[data-writeoff]');
        if (wo) { api.close(); writeOffFlow(wo.getAttribute('data-writeoff')); return; }
        const rts = event.target.closest('[data-rts]');
        if (rts) { api.close(); returnToSupplierFlow(rts.getAttribute('data-rts')); return; }
        const q = event.target.closest('[data-quarantine]');
        if (q) { api.close(); quarantineFlow(q.getAttribute('data-quarantine'), true); return; }
        const r = event.target.closest('[data-release]');
        if (r) { api.close(); quarantineFlow(r.getAttribute('data-release'), false); }
      });
    }
  });
}

/* ============================== RENDER ============================== */

export function render(root, ctx) {
  ctxRef = ctx;

  // Keep the automatic quarantine rule current every time the page is opened.
  autoQuarantineExpired();

  const buckets = expiryBuckets();
  const rows = tabRows(buckets);
  const pageData = paginate(rows, state.page, 15);
  const alertWindow = num(settings().inventory.expiryAlertDays, 90);

  const counts = {
    expired: buckets.expired.length,
    d30: buckets.d30.length,
    d60: buckets.d60.length,
    d90: buckets.d90.length,
    quarantined: buckets.quarantined.length
  };

  const valueMix = [
    { label: 'Expired', value: valueOf(buckets.expired), color: 'var(--chart-5)' },
    { label: 'Within 30 days', value: valueOf(buckets.d30), color: 'var(--chart-3)' },
    { label: '31-60 days', value: valueOf(buckets.d60), color: 'var(--chart-2)' },
    { label: '61-90 days', value: valueOf(buckets.d90), color: 'var(--chart-1)' }
  ];

  const selectedIds = [...state.selected].filter((id) => rows.some((b) => b.id === id));

  const columns = [
    {
      key: 'select', label: '', width: '34px',
      cell: (b) => `<input type="checkbox" data-select="${b.id}" ${state.selected.has(b.id) ? 'checked' : ''}
        aria-label="Select batch ${escapeHtml(b.batchNo)}">`
    },
    {
      key: 'medicine', label: 'Medicine',
      cell: (b) => {
        const med = medicine(b.medicineId);
        return `<button class="btn-ghost" type="button" data-open="${b.id}" style="text-align:left;display:block;width:100%">
          ${cellStack(med ? `${med.name} ${med.strength}`.trim() : 'Unknown', `${b.batchNo} - ${med ? med.sku : ''}`)}
        </button>`;
      }
    },
    {
      key: 'expiry', label: 'Expiry',
      cell: (b) => {
        const days = daysUntil(b.expiry);
        return `<div class="${days < 0 ? 'c-danger' : (days <= 30 ? 'c-warning' : '')}">${fmtDate(b.expiry)}</div>
                <div class="cell-sub">${days < 0 ? `${Math.abs(days)} days ago` : `in ${days} days`}</div>`;
      }
    },
    { key: 'qty', label: 'Units', className: 'num', cell: (b) => `<strong>${int(b.qty)}</strong>` },
    { key: 'value', label: 'Value at cost', className: 'num', cell: (b) => money(round(num(b.qty) * num(b.costPrice), 2)) },
    { key: 'location', label: 'Location', cell: (b) => escapeHtml(b.location || '-') },
    { key: 'supplier', label: 'Supplier', cell: (b) => { const s = supplier(b.supplierId); return escapeHtml(s ? s.name : '-'); } },
    { key: 'state', label: 'Status', cell: (b) => statusBadge(batchState(b)) },
    {
      key: 'actions', label: '', className: 'right',
      cell: (b) => `<div class="table-actions">
        <button class="btn btn-ghost btn-sm" type="button" data-open="${b.id}" title="View batch">${icon('eye', 15)}</button>
        ${num(b.qty) > 0 ? `<button class="btn btn-ghost btn-sm" type="button" data-rts="${b.id}" title="Return to supplier">${icon('truck', 15)}</button>` : ''}
        ${num(b.qty) > 0 ? `<button class="btn btn-ghost btn-sm" type="button" data-writeoff="${b.id}" title="Write off">${icon('trash', 15)}</button>` : ''}
      </div>`
    }
  ];

  root.innerHTML = `
  <div class="page">
    ${pageHead({
      title: 'Expiry & Quarantine',
      subtitle: `Expired batches are quarantined automatically and can never be dispensed. Alert window: ${alertWindow} days.`,
      actions: `
        ${can('export.data') ? `<button class="btn btn-secondary" type="button" id="btn-export">${icon('download', 16)} Export CSV</button>` : ''}
        <button class="btn btn-secondary" type="button" id="btn-print">${icon('print', 16)} Print report</button>`
    })}

    ${counts.expired ? `
      <div class="alert alert-danger">
        ${icon('alertCircle', 17)}
        <div>
          <div class="alert-title">${counts.expired} expired batch(es) holding ${int(sum(buckets.expired, (b) => b.qty))} units</div>
          <div class="small">${money(valueOf(buckets.expired))} of stock value is locked up. Return it to the supplier or write it off.</div>
        </div>
      </div>` : ''}

    <div class="kpi-grid">
      ${kpi({ label: 'Expired', value: int(counts.expired), iconName: 'alert', tone: counts.expired ? 'danger' : '', foot: `<span>${money(valueOf(buckets.expired))} at cost</span>`, small: true })}
      ${kpi({ label: 'Within 30 days', value: int(counts.d30), iconName: 'clock', tone: counts.d30 ? 'warning' : '', foot: `<span>${money(valueOf(buckets.d30))} at cost</span>`, small: true })}
      ${kpi({ label: '31-60 days', value: int(counts.d60), iconName: 'clock', tone: 'info', foot: `<span>${money(valueOf(buckets.d60))} at cost</span>`, small: true })}
      ${kpi({ label: 'Quarantined', value: int(counts.quarantined), iconName: 'shield', tone: counts.quarantined ? 'warning' : '', foot: `<span>${money(valueOf(buckets.quarantined))} held</span>`, small: true })}
    </div>

    <div class="grid-dash">
      <div class="span-8">
        <div class="toolbar mb-3">
          <div class="tabs" id="exp-tabs" style="border:0">
            ${TABS.map((tab) => `
              <button type="button" data-tab="${tab.key}" class="${state.tab === tab.key ? 'is-active' : ''}">
                ${tab.label} <span class="tab-count">${counts[tab.key]}</span>
              </button>`).join('')}
          </div>
          <div class="spacer"></div>
          ${searchBox({ id: 'exp-search', value: state.query, placeholder: 'Search medicine or batch...' })}
        </div>

        ${selectedIds.length ? `
          <div class="toolbar mb-3" style="background:var(--primary-soft);border-color:var(--primary)">
            <strong class="sm">${selectedIds.length} batch(es) selected</strong>
            <div class="spacer"></div>
            <button class="btn btn-warning-soft btn-sm" type="button" id="bulk-quarantine">${icon('shield', 14)} Quarantine</button>
            <button class="btn btn-danger btn-sm" type="button" id="bulk-writeoff">${icon('trash', 14)} Write off selected</button>
            <button class="btn btn-ghost btn-sm" type="button" id="bulk-clear">Clear</button>
          </div>` : ''}

        ${card({
          flush: true,
          body: renderTable({
            columns,
            rows: pageData.rows,
            rowClass: (b) => (isExpired(b) ? 'row-danger' : (isQuarantined(b) ? 'row-warning' : '')),
            empty: emptyState({
              iconName: 'checkCircle',
              title: state.tab === 'expired' ? 'No expired stock' : 'Nothing in this window',
              message: state.tab === 'expired'
                ? 'Every batch in stock is still in date.'
                : 'No batches fall into this expiry window right now.'
            })
          }) + (pageData.pages > 1 ? paginationHtml(pageData) : '')
        })}
      </div>

      <div class="span-4">
        ${card({
          title: 'Value at risk',
          sub: 'Stock value by expiry window, at cost',
          body: donutChart(valueMix, { centreLabel: 'At risk' })
        })}

        ${card({
          className: 'mt-4',
          title: 'How this works',
          body: `
            <div class="stack-sm small">
              <div class="row-start"><span class="list-avatar tone-danger" style="width:26px;height:26px">${icon('alert', 13)}</span>
                <div><strong>Automatic quarantine</strong><br>
                <span class="muted">Batches past their expiry date are quarantined whenever MediFlow loads
                ${settings().inventory.autoQuarantine ? '(enabled in settings)' : '(currently disabled in settings)'}.</span></div></div>
              <div class="row-start"><span class="list-avatar tone-warning" style="width:26px;height:26px">${icon('shield', 13)}</span>
                <div><strong>Blocked from sale</strong><br>
                <span class="muted">Expired and quarantined batches never appear at the point of sale,
                and FEFO skips them entirely.</span></div></div>
              <div class="row-start"><span class="list-avatar tone-info" style="width:26px;height:26px">${icon('truck', 13)}</span>
                <div><strong>Supplier returns</strong><br>
                <span class="muted">Returning stock reduces the balance you owe that supplier.</span></div></div>
              <div class="row-start"><span class="list-avatar tone-neutral" style="width:26px;height:26px">${icon('trash', 13)}</span>
                <div><strong>Write-offs</strong><br>
                <span class="muted">Recorded as a stock loss with a reason, visible in reports and the activity log.</span></div></div>
            </div>`
        })}
      </div>
    </div>
  </div>`;

  /* ---------------------------- events ---------------------------- */

  const rerender = () => ctx.refresh();

  qsa('#exp-tabs [data-tab]', root).forEach((btn) => btn.addEventListener('click', () => {
    state.tab = btn.getAttribute('data-tab');
    state.page = 1;
    state.selected.clear();
    rerender();
  }));

  const search = qs('#exp-search', root);
  search.addEventListener('input', debounce(() => {
    state.query = search.value;
    state.page = 1;
    const caret = search.selectionStart;
    rerender();
    const next = qs('#exp-search');
    if (next) { next.focus(); next.setSelectionRange(caret, caret); }
  }, 260));

  on(root, 'change', '[data-select]', (event, node) => {
    const id = node.getAttribute('data-select');
    if (node.checked) state.selected.add(id); else state.selected.delete(id);
    rerender();
  });

  on(root, 'click', '[data-page]', (event, node) => {
    const page = num(node.getAttribute('data-page'));
    if (page >= 1 && page <= pageData.pages) { state.page = page; rerender(); }
  });

  on(root, 'click', '[data-open]', (event, node) => openBatchDrawer(node.getAttribute('data-open')));
  on(root, 'click', '[data-writeoff]', (event, node) => {
    event.stopPropagation();
    writeOffFlow(node.getAttribute('data-writeoff'));
  });
  on(root, 'click', '[data-rts]', (event, node) => {
    event.stopPropagation();
    returnToSupplierFlow(node.getAttribute('data-rts'));
  });

  const bulkWo = qs('#bulk-writeoff', root);
  if (bulkWo) bulkWo.addEventListener('click', () => bulkWriteOff(selectedIds));
  const bulkQ = qs('#bulk-quarantine', root);
  if (bulkQ) bulkQ.addEventListener('click', () => bulkQuarantine(selectedIds));
  const bulkClear = qs('#bulk-clear', root);
  if (bulkClear) bulkClear.addEventListener('click', () => { state.selected.clear(); rerender(); });

  const exportBtn = qs('#btn-export', root);
  if (exportBtn) exportBtn.addEventListener('click', () => {
    const all = [...buckets.expired, ...buckets.d30, ...buckets.d60, ...buckets.d90, ...buckets.quarantined];
    const unique = [...new Map(all.map((b) => [b.id, b])).values()];
    downloadCsv(exportName('expiry'), unique, [
      { label: 'Medicine', value: (b) => { const m = medicine(b.medicineId); return m ? `${m.name} ${m.strength}`.trim() : ''; } },
      { label: 'SKU', value: (b) => { const m = medicine(b.medicineId); return m ? m.sku : ''; } },
      { label: 'Batch', value: (b) => b.batchNo },
      { label: 'Expiry', value: (b) => fmtDate(b.expiry) },
      { label: 'Days to expiry', value: (b) => daysUntil(b.expiry) },
      { label: 'Units', value: (b) => b.qty },
      { label: 'Unit cost', value: (b) => b.costPrice },
      { label: 'Value at cost', value: (b) => round(num(b.qty) * num(b.costPrice), 2) },
      { label: 'Status', value: (b) => batchState(b).label },
      { label: 'Quarantine reason', value: (b) => b.quarantineReason || '' },
      { label: 'Location', value: (b) => b.location },
      { label: 'Supplier', value: (b) => { const s = supplier(b.supplierId); return s ? s.name : ''; } }
    ]);
    notifySuccess('Export ready', `${unique.length} batches exported.`);
  });

  qs('#btn-print', root).addEventListener('click', () => {
    const pharmacy = settings().pharmacy;
    const section = (title, list) => (list.length ? `
      <h2 class="print-section">${title} (${list.length})</h2>
      <table>
        <thead><tr><th>Medicine</th><th>Batch</th><th>Expiry</th><th class="num">Units</th><th class="num">Value</th><th>Status</th></tr></thead>
        <tbody>${sortBy(list, (b) => b.expiry, 'asc').map((b) => {
          const med = medicine(b.medicineId);
          return `<tr>
            <td>${escapeHtml(med ? `${med.name} ${med.strength}` : '-')}</td>
            <td>${escapeHtml(b.batchNo)}</td>
            <td>${fmtDate(b.expiry)}</td>
            <td class="num">${int(b.qty)}</td>
            <td class="num">${money(round(num(b.qty) * num(b.costPrice), 2))}</td>
            <td>${batchState(b).label}</td>
          </tr>`;
        }).join('')}</tbody>
        <tfoot><tr><td colspan="3">Subtotal</td>
          <td class="num">${int(sum(list, (b) => b.qty))}</td>
          <td class="num">${money(valueOf(list))}</td><td></td></tr></tfoot>
      </table>` : '');

    printNode(`
      <div class="print-doc">
        ${printHeader({
          pharmacy,
          title: 'Expiry & Quarantine Report',
          subtitle: `Alert window ${alertWindow} days`,
          meta: `Generated ${fmtDateTime(new Date())}<br>By ${escapeHtml(ctx.user.name)}`
        })}
        ${section('Expired stock', buckets.expired)}
        ${section('Expiring within 30 days', buckets.d30)}
        ${section('Expiring in 31-60 days', buckets.d60)}
        ${section('Expiring in 61-90 days', buckets.d90)}
        ${section('Quarantined stock', buckets.quarantined)}
        ${printFooter({ left: `${escapeHtml(pharmacy.name)} - confidential`, right: 'MediFlow Pharmacy ERP' })}
      </div>`, 'report');
  });
}

/** Compact pagination for the expiry table. */
function paginationHtml(pageData) {
  let buttons = '';
  for (let p = 1; p <= pageData.pages; p++) {
    buttons += `<button class="page-btn${p === pageData.page ? ' is-active' : ''}" type="button" data-page="${p}">${p}</button>`;
  }
  return `<div class="pagination">
    <span class="pagination-info">Showing <strong>${pageData.from}-${pageData.to}</strong> of <strong>${pageData.total}</strong> batches</span>
    <div class="pagination-pages">${buttons}</div></div>`;
}

export default { render };
