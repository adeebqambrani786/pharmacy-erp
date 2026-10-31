/* ==========================================================================
   MediFlow Pharmacy ERP - Stock Adjustment (admin only)
   Every correction carries a reason, a preview of the effect and the user who
   made it. A decrease can never exceed the stock on hand (rules 8, 11).
   ========================================================================== */

import {
  db, medicines, medicine, batchesOf, batch as findBatch, adjustStock, resolveScan,
  batchState, isWrittenOff, stockSummary, searchMedicines, settings
} from '../store.js';
import { can, requirePermission } from '../auth.js';
import {
  pageHead, card, kpi, icon, badge, statusBadge, renderTable, cellStack,
  renderPagination, emptyState, openModal, openDrawer, modalFooter, confirmDialog,
  notifySuccess, notifyError, notifyDenied, escapeHtml, field, selectField, options,
  searchBox, createScanner, printNode, printHeader, printFooter
} from '../ui.js';
import {
  money, int, num, round, fmtDate, fmtDateTime, fmtRelative, sortBy, paginate, qs, qsa, on,
  debounce, matchesQuery, sum, formData, downloadCsv, exportName, ADJUSTMENT_REASONS, daysUntil,
  startOfMonth
} from '../utils.js';

const PER_PAGE = 12;

const state = { query: '', reason: '', type: '', from: '', to: '', page: 1 };

let ctxRef = null;

/* ============================== BATCH PICKER ============================== */

/** Choose the batch to adjust - by search or by scanning its QR Code. */
function openBatchPicker({ prefill = '' } = {}) {
  try {
    requirePermission('stock.adjust');
  } catch (error) {
    notifyDenied(error);
    return;
  }

  const buildRows = (query) => {
    const meds = query ? searchMedicines(query) : sortBy(medicines(), (m) => m.name, 'asc');
    const rows = [];
    meds.forEach((med) => {
      batchesOf(med.id)
        .filter((b) => !isWrittenOff(b))
        .forEach((b) => rows.push({ med, batch: b }));
    });
    return sortBy(rows, (r) => `${r.med.name}${r.batch.expiry}`, 'asc').slice(0, 60);
  };

  const rowsHtml = (rows) => (rows.length ? `<div class="list">${rows.map(({ med, batch }) => `
    <button class="list-row is-clickable" type="button" data-pick="${batch.id}">
      <span class="list-avatar">${icon('pill', 16)}</span>
      <span class="list-main">
        <span class="list-title">${escapeHtml(`${med.name} ${med.strength}`.trim())}</span>
        <span class="list-sub">Batch ${escapeHtml(batch.batchNo)} · exp ${fmtDate(batch.expiry)}
          · ${int(batch.qty)} units · ${escapeHtml(batch.location || 'Unassigned')}</span>
      </span>
      <span class="list-end">${statusBadge(batchState(batch))}</span>
    </button>`).join('')}</div>`
    : emptyState({ iconName: 'search', title: 'No batch matches that search' }));

  let scanner = null;
  const modal = openModal({
    title: 'Select a batch to adjust',
    subtitle: 'Search the inventory or scan the batch QR Code',
    size: 'modal-lg',
    iconName: 'adjust',
    body: `
      <div class="stack-lg">
        ${searchBox({ id: 'adj-search', value: prefill, placeholder: 'Medicine name, SKU or batch number...' })}
        <div id="adj-list">${rowsHtml(buildRows(prefill))}</div>
        <details id="adj-scan-wrap">
          <summary class="btn btn-secondary btn-sm" style="width:fit-content">
            ${icon('scan', 15)} Scan a batch QR Code instead
          </summary>
          <div class="mt-4" id="adj-scan-mount"></div>
          <div id="adj-scan-feed" class="mt-3"></div>
        </details>
      </div>`,
    footer: '<button class="btn btn-secondary" type="button" data-modal-close>Cancel</button>',
    onClose: () => { if (scanner) scanner.stop(); }
  });

  const search = qs('#adj-search', modal.root);
  const list = qs('#adj-list', modal.root);

  search.addEventListener('input', debounce(() => {
    list.innerHTML = rowsHtml(buildRows(search.value));
  }, 200));

  // The scanner is only started when the section is opened.
  const details = qs('#adj-scan-wrap', modal.root);
  details.addEventListener('toggle', () => {
    if (!details.open || scanner) return;
    const feed = qs('#adj-scan-feed', modal.root);
    scanner = createScanner(qs('#adj-scan-mount', modal.root), {
      onDetect: (value) => {
        const result = resolveScan(value);
        if (!result.ok) {
          feed.innerHTML = `<div class="alert alert-danger small">${icon('alertCircle', 15)}
            <div>${escapeHtml(result.message)}</div></div>`;
          return;
        }
        if (!result.batch) {
          feed.innerHTML = `<div class="alert alert-warning small">${icon('alert', 15)}
            <div>That code identifies <strong>${escapeHtml(result.medicine.name)}</strong> but not a specific batch.
            Pick the batch from the list above.</div></div>`;
          search.value = result.medicine.name;
          list.innerHTML = rowsHtml(buildRows(result.medicine.name));
          return;
        }
        modal.close();
        openAdjustModal(result.batch.id);
      }
    });
  });

  modal.root.addEventListener('click', (event) => {
    const pick = event.target.closest('[data-pick]');
    if (!pick) return;
    modal.close();
    openAdjustModal(pick.getAttribute('data-pick'));
  });
}

/* ============================== ADJUSTMENT FORM ============================== */

function openAdjustModal(batchId) {
  const batch = findBatch(batchId);
  if (!batch) return;
  const med = medicine(batch.medicineId);
  const summary = stockSummary(med.id);

  const modal = openModal({
    title: 'Adjust stock',
    subtitle: `${med.name} ${med.strength} - batch ${batch.batchNo}`,
    size: 'modal-lg',
    iconName: 'adjust',
    body: `
      <form id="adj-form" class="stack-lg" novalidate>
        <div class="card card-pad">
          <div class="def-grid">
            <div class="def-item"><div class="def-label">Batch</div><div class="def-value mono">${escapeHtml(batch.batchNo)}</div></div>
            <div class="def-item"><div class="def-label">Expiry</div><div class="def-value">${fmtDate(batch.expiry)} (${daysUntil(batch.expiry)}d)</div></div>
            <div class="def-item"><div class="def-label">Current quantity</div><div class="def-value num"><strong>${int(batch.qty)}</strong> units</div></div>
            <div class="def-item"><div class="def-label">Unit cost</div><div class="def-value num">${money(batch.costPrice)}</div></div>
            <div class="def-item"><div class="def-label">Location</div><div class="def-value">${escapeHtml(batch.location || '-')}</div></div>
            <div class="def-item"><div class="def-label">Batch status</div><div class="def-value">${statusBadge(batchState(batch))}</div></div>
          </div>
        </div>

        <div>
          <div class="divider-label mb-3">Direction</div>
          <div class="segmented">
            <button type="button" data-type="decrease" class="is-active">${icon('arrowDown', 14)} Decrease stock</button>
            <button type="button" data-type="increase">${icon('arrowUp', 14)} Increase stock</button>
          </div>
        </div>

        <div class="grid-2">
          ${field({
            name: 'qty', label: 'Adjustment quantity', type: 'number', required: true,
            attrs: `min="1" step="1" max="${int(batch.qty)}" autofocus placeholder="0"`,
            hint: `Maximum ${int(batch.qty)} when decreasing`
          })}
          ${selectField({
            name: 'reason', label: 'Reason', list: ADJUSTMENT_REASONS, required: true,
            placeholder: 'Select a reason'
          })}
        </div>

        <div class="field">
          <label class="label" for="f-note">Notes</label>
          <textarea class="textarea" id="f-note" name="note" rows="2"
            placeholder="Explain what happened - this is stored permanently"></textarea>
          <p class="field-error" data-for="note" hidden></p>
        </div>

        <div class="card card-pad" id="adj-preview">
          <div class="divider-label mb-3">Preview</div>
          <div class="stack-sm" style="gap:2px">
            <div class="stat-line"><span class="sl-label">Previous quantity</span><span class="sl-value">${int(batch.qty)}</span></div>
            <div class="stat-line"><span class="sl-label">Adjustment</span><span class="sl-value" id="pv-delta">-</span></div>
            <div class="stat-line is-total"><span class="sl-label">New quantity</span><span class="sl-value" id="pv-new">${int(batch.qty)}</span></div>
            <div class="stat-line"><span class="sl-label">Value impact (at cost)</span><span class="sl-value" id="pv-value">${money(0)}</span></div>
            <div class="stat-line"><span class="sl-label">Medicine availability after</span><span class="sl-value" id="pv-avail">${int(summary.available)}</span></div>
          </div>
        </div>

        <div class="alert alert-warning small">
          ${icon('alert', 16)}
          <div>This adjustment is permanent and will be recorded against
          <strong>${escapeHtml(ctxRef.user.name)}</strong> in the activity log and stock movement history.</div>
        </div>
      </form>`,
    footer: modalFooter({ confirmLabel: 'Confirm adjustment', tone: 'primary' })
  });

  const form = qs('#adj-form', modal.root);
  let type = 'decrease';

  const qtyInput = form.elements.qty;

  const updatePreview = () => {
    const qty = Math.max(0, Math.round(num(qtyInput.value)));
    const delta = type === 'decrease' ? -qty : qty;
    const next = num(batch.qty) + delta;

    qs('#pv-delta', modal.root).textContent = qty ? `${delta > 0 ? '+' : ''}${int(delta)}` : '-';
    qs('#pv-delta', modal.root).className = `sl-value ${delta > 0 ? 'c-success' : (delta < 0 ? 'c-danger' : '')}`;
    qs('#pv-new', modal.root).textContent = int(Math.max(0, next));
    qs('#pv-value', modal.root).textContent = money(round(delta * num(batch.costPrice), 2));
    qs('#pv-value', modal.root).className = `sl-value ${delta < 0 ? 'c-danger' : 'c-success'}`;
    qs('#pv-avail', modal.root).textContent = int(Math.max(0, summary.available + delta));
  };

  qsa('[data-type]', modal.root).forEach((btn) => btn.addEventListener('click', () => {
    type = btn.getAttribute('data-type');
    qsa('[data-type]', modal.root).forEach((b) => b.classList.toggle('is-active', b === btn));
    // Only a decrease is capped by the stock on hand.
    if (type === 'decrease') qtyInput.setAttribute('max', String(num(batch.qty)));
    else qtyInput.removeAttribute('max');
    updatePreview();
  }));

  form.addEventListener('input', updatePreview);

  const submit = async () => {
    const data = formData(form);
    const qty = Math.round(num(data.qty));
    const errors = {};

    if (qty <= 0) errors.qty = 'Enter a quantity greater than zero.';
    else if (type === 'decrease' && qty > num(batch.qty)) {
      errors.qty = `Only ${int(batch.qty)} unit(s) are in this batch.`;
    }
    if (!data.reason) errors.reason = 'Select a reason for this adjustment.';
    if (data.reason === 'Other' && !String(data.note).trim()) {
      errors.note = 'Describe the reason when choosing "Other".';
    }
    if (Object.keys(errors).length) {
      Object.entries(errors).forEach(([key, message]) => {
        const slot = qs(`.field-error[data-for="${key}"]`, form);
        if (slot) { slot.textContent = message; slot.hidden = false; }
        const input = form.elements[key];
        if (input && input.classList) input.classList.add('is-invalid');
      });
      return;
    }

    const confirmed = await confirmDialog({
      title: `${type === 'decrease' ? 'Reduce' : 'Increase'} stock by ${int(qty)}?`,
      message: `${med.name} ${med.strength} batch ${batch.batchNo} will go from ${int(batch.qty)} to ${int(type === 'decrease' ? batch.qty - qty : batch.qty + qty)} units.`,
      detail: `<div class="stat-line"><span class="sl-label">Reason</span><span class="sl-value">${escapeHtml(data.reason)}</span></div>
               <div class="stat-line"><span class="sl-label">Value impact</span><span class="sl-value">${money(round((type === 'decrease' ? -qty : qty) * num(batch.costPrice), 2))}</span></div>`,
      confirmLabel: 'Confirm adjustment',
      tone: type === 'decrease' ? 'danger' : 'primary',
      iconName: 'adjust'
    });
    if (!confirmed) return;

    try {
      const record = adjustStock({
        user: ctxRef.user,
        batchId: batch.id,
        type,
        qty,
        reason: data.reason,
        note: data.note
      });
      modal.close();
      notifySuccess(
        'Stock adjusted',
        `${record.ref}: ${med.name} batch ${batch.batchNo} is now ${int(record.after)} units.`
      );
      ctxRef.refresh();
    } catch (error) {
      notifyError('Adjustment failed', error.message);
    }
  };

  form.addEventListener('submit', (event) => { event.preventDefault(); submit(); });
  qs('#modal-confirm', modal.root).addEventListener('click', (event) => { event.preventDefault(); submit(); });

  updatePreview();
}

/* ============================== HISTORY ============================== */

function filteredAdjustments() {
  let rows = db.adjustments;
  if (state.reason) rows = rows.filter((a) => a.reason === state.reason);
  if (state.type) rows = rows.filter((a) => a.type === state.type);
  if (state.from) rows = rows.filter((a) => new Date(a.datetime) >= new Date(`${state.from}T00:00:00`));
  if (state.to) rows = rows.filter((a) => new Date(a.datetime) <= new Date(`${state.to}T23:59:59`));
  if (state.query) {
    rows = rows.filter((a) => matchesQuery(
      `${a.ref} ${a.medicineName} ${a.batchNo} ${a.reason} ${a.note} ${a.userName}`, state.query));
  }
  return sortBy(rows, (a) => a.datetime, 'desc');
}

function openAdjustmentDrawer(id) {
  const record = db.adjustments.find((a) => a.id === id);
  if (!record) return;
  const batch = findBatch(record.batchId);

  openDrawer({
    title: record.ref,
    subtitle: `${fmtDateTime(record.datetime)} - ${record.userName}`,
    body: `
      <div class="stack-lg">
        <div class="row-wrap">
          ${badge(record.type === 'increase' ? 'Stock increased' : 'Stock decreased', record.type === 'increase' ? 'success' : 'danger', { dot: true })}
          ${badge(record.reason, 'neutral')}
          ${record.source !== 'manual' ? badge(`Source: ${record.source}`, 'info') : ''}
        </div>

        <div class="def-grid">
          <div class="def-item"><div class="def-label">Medicine</div><div class="def-value">${escapeHtml(record.medicineName)}</div></div>
          <div class="def-item"><div class="def-label">Batch</div><div class="def-value mono">${escapeHtml(record.batchNo)}</div></div>
          <div class="def-item"><div class="def-label">Previous quantity</div><div class="def-value num">${int(record.before)}</div></div>
          <div class="def-item"><div class="def-label">Adjustment</div><div class="def-value num ${record.type === 'increase' ? 'c-success' : 'c-danger'}">${record.type === 'increase' ? '+' : '-'}${int(record.qty)}</div></div>
          <div class="def-item"><div class="def-label">New quantity</div><div class="def-value num"><strong>${int(record.after)}</strong></div></div>
          <div class="def-item"><div class="def-label">Value impact</div><div class="def-value num ${record.valueImpact < 0 ? 'c-danger' : 'c-success'}">${money(record.valueImpact)}</div></div>
          <div class="def-item"><div class="def-label">Performed by</div><div class="def-value">${escapeHtml(record.userName)}</div></div>
          <div class="def-item"><div class="def-label">Date &amp; time</div><div class="def-value">${fmtDateTime(record.datetime)}</div></div>
          ${batch ? `<div class="def-item"><div class="def-label">Batch quantity now</div><div class="def-value num">${int(batch.qty)}</div></div>` : ''}
        </div>

        ${record.note ? `<div class="alert alert-neutral small">${icon('info', 15)}
          <div><strong>Note:</strong> ${escapeHtml(record.note)}</div></div>` : ''}

        <div class="alert alert-info small">
          ${icon('shield', 15)}
          <div>Adjustment records are immutable. To correct a mistake, record a second
          adjustment in the opposite direction with an explanatory note.</div>
        </div>
      </div>`,
    footer: batch
      ? `<button class="btn btn-secondary" type="button" data-again="${batch.id}">${icon('adjust', 15)} Adjust this batch again</button>`
      : '',
    onMount: (api) => {
      api.root.addEventListener('click', (event) => {
        const again = event.target.closest('[data-again]');
        if (again) { api.close(); openAdjustModal(again.getAttribute('data-again')); }
      });
    }
  });
}

/* ============================== RENDER ============================== */

export function render(root, ctx) {
  ctxRef = ctx;

  const allRows = filteredAdjustments();
  const pageData = paginate(allRows, state.page, PER_PAGE);

  const monthRows = db.adjustments.filter((a) => new Date(a.datetime) >= startOfMonth());
  const losses = monthRows.filter((a) => a.valueImpact < 0);
  const gains = monthRows.filter((a) => a.valueImpact > 0);

  const columns = [
    { key: 'ref', label: 'Reference', cell: (a) => cellStack(a.ref, fmtRelative(a.datetime)) },
    { key: 'medicineName', label: 'Medicine', cell: (a) => cellStack(a.medicineName, `Batch ${a.batchNo}`) },
    {
      key: 'type', label: 'Change', className: 'num',
      cell: (a) => `<span class="${a.type === 'increase' ? 'c-success' : 'c-danger'}"><strong>${a.type === 'increase' ? '+' : '-'}${int(a.qty)}</strong></span>
                    <div class="cell-sub">${int(a.before)} → ${int(a.after)}</div>`
    },
    { key: 'reason', label: 'Reason', cell: (a) => cellStack(a.reason, a.note ? a.note.slice(0, 40) : '') },
    {
      key: 'valueImpact', label: 'Value impact', className: 'num',
      cell: (a) => `<span class="${a.valueImpact < 0 ? 'c-danger' : 'c-success'}">${money(a.valueImpact)}</span>`
    },
    { key: 'userName', label: 'Performed by', cell: (a) => escapeHtml(a.userName) },
    {
      key: 'actions', label: '', className: 'right',
      cell: (a) => `<div class="table-actions">
        <button class="btn btn-ghost btn-sm" type="button" data-open="${a.id}" title="View details">${icon('eye', 15)}</button>
      </div>`
    }
  ];

  root.innerHTML = `
  <div class="page">
    ${pageHead({
      title: 'Stock Adjustment',
      subtitle: 'Correct stock with a reason and a full audit trail. Decreases can never exceed the quantity on hand.',
      actions: `
        ${can('export.data') ? `<button class="btn btn-secondary" type="button" id="btn-export">${icon('download', 16)} Export CSV</button>` : ''}
        <button class="btn btn-secondary" type="button" id="btn-print">${icon('print', 16)} Print</button>
        <button class="btn btn-primary" type="button" id="btn-new">${icon('plus', 16)} New adjustment</button>`
    })}

    <div class="kpi-grid">
      ${kpi({ label: 'Adjustments this month', value: int(monthRows.length), iconName: 'adjust', small: true })}
      ${kpi({ label: 'Stock losses (value)', value: money(Math.abs(sum(losses, (a) => a.valueImpact))), iconName: 'arrowDown', tone: 'danger', foot: `<span>${losses.length} decrease(s)</span>`, small: true })}
      ${kpi({ label: 'Stock gains (value)', value: money(sum(gains, (a) => a.valueImpact)), iconName: 'arrowUp', tone: 'success', foot: `<span>${gains.length} increase(s)</span>`, small: true })}
      ${kpi({ label: 'Total records', value: int(db.adjustments.length), iconName: 'history', small: true })}
    </div>

    <div class="toolbar">
      ${searchBox({ id: 'adj-hist-search', value: state.query, placeholder: 'Search reference, medicine, batch or reason...' })}
      <div class="toolbar-group">
        <select class="select filter-select" id="f-type" aria-label="Filter by direction">
          ${options([{ value: 'increase', label: 'Increases' }, { value: 'decrease', label: 'Decreases' }], state.type, { placeholder: 'All directions' })}
        </select>
        <select class="select filter-select" id="f-reason" aria-label="Filter by reason">
          ${options(ADJUSTMENT_REASONS, state.reason, { placeholder: 'All reasons' })}
        </select>
        <input class="input filter-select" id="f-from" type="date" value="${state.from}" title="From date" aria-label="From date">
        <input class="input filter-select" id="f-to" type="date" value="${state.to}" title="To date" aria-label="To date">
        ${(state.query || state.type || state.reason || state.from || state.to)
          ? '<button class="btn btn-ghost btn-sm" type="button" id="btn-clear">Clear</button>' : ''}
      </div>
    </div>

    ${card({
      title: 'Adjustment history',
      sub: `${allRows.length} record(s)`,
      flush: true,
      body: renderTable({
        columns,
        rows: pageData.rows,
        empty: emptyState({
          iconName: 'adjust',
          title: 'No adjustments recorded',
          message: 'Stock corrections for damage, loss, disposal or count differences appear here.',
          actions: '<button class="btn btn-primary btn-sm" type="button" id="btn-new-empty">New adjustment</button>'
        })
      }) + renderPagination(pageData, { label: 'adjustments' })
    })}
  </div>`;

  /* ---------------------------- events ---------------------------- */

  const rerender = () => ctx.refresh();

  qsa('#btn-new, #btn-new-empty', root).forEach((b) =>
    b.addEventListener('click', () => openBatchPicker()));

  const search = qs('#adj-hist-search', root);
  search.addEventListener('input', debounce(() => {
    state.query = search.value;
    state.page = 1;
    const caret = search.selectionStart;
    rerender();
    const next = qs('#adj-hist-search');
    if (next) { next.focus(); next.setSelectionRange(caret, caret); }
  }, 260));

  const bind = (selector, key) => {
    const node = qs(selector, root);
    if (node) node.addEventListener('change', () => { state[key] = node.value; state.page = 1; rerender(); });
  };
  bind('#f-type', 'type');
  bind('#f-reason', 'reason');
  bind('#f-from', 'from');
  bind('#f-to', 'to');

  const clearBtn = qs('#btn-clear', root);
  if (clearBtn) clearBtn.addEventListener('click', () => {
    Object.assign(state, { query: '', reason: '', type: '', from: '', to: '', page: 1 });
    rerender();
  });

  on(root, 'click', '[data-page]', (event, node) => {
    const page = num(node.getAttribute('data-page'));
    if (page >= 1 && page <= pageData.pages) { state.page = page; rerender(); }
  });

  on(root, 'click', '[data-open]', (event, node) => openAdjustmentDrawer(node.getAttribute('data-open')));

  const exportBtn = qs('#btn-export', root);
  if (exportBtn) exportBtn.addEventListener('click', () => {
    downloadCsv(exportName('stock-adjustments'), allRows, [
      { label: 'Reference', value: (a) => a.ref },
      { label: 'Date', value: (a) => fmtDate(a.datetime) },
      { label: 'Time', value: (a) => fmtDateTime(a.datetime) },
      { label: 'Medicine', value: (a) => a.medicineName },
      { label: 'Batch', value: (a) => a.batchNo },
      { label: 'Direction', value: (a) => a.type },
      { label: 'Quantity', value: (a) => a.qty },
      { label: 'Before', value: (a) => a.before },
      { label: 'After', value: (a) => a.after },
      { label: 'Reason', value: (a) => a.reason },
      { label: 'Note', value: (a) => a.note },
      { label: 'Value impact', value: (a) => a.valueImpact },
      { label: 'Source', value: (a) => a.source },
      { label: 'Performed by', value: (a) => a.userName }
    ]);
    notifySuccess('Export ready', `${allRows.length} adjustments exported.`);
  });

  qs('#btn-print', root).addEventListener('click', () => {
    const pharmacy = settings().pharmacy;
    printNode(`
      <div class="print-doc">
        ${printHeader({
          pharmacy,
          title: 'Stock Adjustment Report',
          subtitle: `${allRows.length} records`,
          meta: `Generated ${fmtDateTime(new Date())}<br>By ${escapeHtml(ctx.user.name)}`
        })}
        <table>
          <thead><tr>
            <th>Reference</th><th>Date</th><th>Medicine</th><th>Batch</th>
            <th class="num">Change</th><th class="num">Before</th><th class="num">After</th>
            <th>Reason</th><th class="num">Value</th><th>By</th>
          </tr></thead>
          <tbody>${allRows.map((a) => `<tr>
            <td>${escapeHtml(a.ref)}</td>
            <td>${fmtDate(a.datetime)}</td>
            <td>${escapeHtml(a.medicineName)}</td>
            <td>${escapeHtml(a.batchNo)}</td>
            <td class="num">${a.type === 'increase' ? '+' : '-'}${int(a.qty)}</td>
            <td class="num">${int(a.before)}</td>
            <td class="num">${int(a.after)}</td>
            <td>${escapeHtml(a.reason)}</td>
            <td class="num">${money(a.valueImpact)}</td>
            <td>${escapeHtml(a.userName)}</td>
          </tr>`).join('')}</tbody>
          <tfoot><tr>
            <td colspan="8">Net value impact</td>
            <td class="num">${money(sum(allRows, (a) => a.valueImpact))}</td><td></td>
          </tr></tfoot>
        </table>
        ${printFooter({ left: `${escapeHtml(pharmacy.name)} - confidential`, right: 'MediFlow Pharmacy ERP' })}
      </div>`, 'report');
  });
}

export default { render };
