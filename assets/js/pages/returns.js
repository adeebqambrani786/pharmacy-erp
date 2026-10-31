/* ==========================================================================
   MediFlow Pharmacy ERP - Sales Returns
   Staff raise requests; the owner approves or rejects. Stock and money only
   move on approval, and damaged or expired goods are quarantined rather than
   returned to sellable inventory (section 17, rule 18).
   ========================================================================== */

import {
  db, salesFor, sale as findSale, requestReturn, approveReturn, rejectReturn,
  returnedQtyBySale, find, settings, batch as findBatch, isExpired
} from '../store.js';
import { can, requirePermission } from '../auth.js';
import {
  pageHead, card, kpi, icon, badge, renderTable, cellStack, renderPagination, emptyState,
  openModal, openDrawer, modalFooter, promptDialog, notifySuccess, notifyError, notifyDenied,
  escapeHtml, searchBox, options, selectField, printNode, printHeader, printFooter, qtyStepper
} from '../ui.js';
import {
  money, int, num, round, fmtDate, fmtDateTime, fmtRelative, sortBy, paginate,
  qs, qsa, on, debounce, matchesQuery, sum, downloadCsv, exportName,
  RETURN_REASONS, formData
} from '../utils.js';

const PER_PAGE = 12;

const state = {
  tab: 'pending',
  query: '',
  page: 1
};

let ctxRef = null;

/* ============================== DATA ============================== */

function visibleReturns() {
  const isAdmin = can('returns.approve');
  let rows = db.returns.filter((r) => isAdmin || r.requestedById === ctxRef.user.id);

  if (state.tab !== 'all') rows = rows.filter((r) => r.status === state.tab);
  if (state.query) {
    rows = rows.filter((r) => matchesQuery(
      `${r.ref} ${r.saleRef} ${r.customerName} ${r.requestedBy} ${r.items.map((i) => i.name).join(' ')}`,
      state.query
    ));
  }
  return sortBy(rows, (r) => r.datetime, 'desc');
}

function tabCounts() {
  const isAdmin = can('returns.approve');
  const scope = db.returns.filter((r) => isAdmin || r.requestedById === ctxRef.user.id);
  return {
    pending: scope.filter((r) => r.status === 'pending').length,
    approved: scope.filter((r) => r.status === 'approved').length,
    rejected: scope.filter((r) => r.status === 'rejected').length,
    all: scope.length
  };
}

const STATUS_TONE = { pending: 'warning', approved: 'success', rejected: 'danger' };

/* ============================== REQUEST FLOW ============================== */

/** Step 1: choose the original sale. */
function openSalePickerModal() {
  try {
    requirePermission('returns.request');
  } catch (error) {
    notifyDenied(error);
    return;
  }

  // Staff may only return against their own receipts.
  const scope = can('sales.view.all') ? {} : { userId: ctxRef.user.id };
  const candidates = salesFor({ ...scope, status: 'completed' })
    .filter((s) => {
      const returned = returnedQtyBySale(s.id);
      return sum(Object.values(returned), (v) => v) < s.units;
    })
    .slice(0, 150);

  let query = '';

  const rowsHtml = (list) => (list.length ? `<div class="list">${list.slice(0, 40).map((s) => `
    <button class="list-row is-clickable" type="button" data-pick="${s.id}">
      <span class="list-avatar tone-neutral">${icon('receipt', 16)}</span>
      <span class="list-main">
        <span class="list-title">${escapeHtml(s.ref)} · ${money(s.total)}</span>
        <span class="list-sub">${fmtDateTime(s.datetime)} · ${escapeHtml(s.customerName)}
          · ${int(s.units)} unit(s) · ${escapeHtml(s.userName)}</span>
      </span>
      <span class="list-end">${icon('chevronRight', 16)}</span>
    </button>`).join('')}</div>`
    : emptyState({
      iconName: 'search',
      title: 'No matching receipt',
      message: 'Search by receipt number, customer name or medicine.'
    }));

  const modal = openModal({
    title: 'Select the original sale',
    subtitle: 'Returns must always reference the receipt they came from',
    size: 'modal-lg',
    iconName: 'returnArrow',
    body: `
      ${searchBox({ id: 'ret-sale-search', placeholder: 'Receipt number, customer or medicine...' })}
      <div id="ret-sale-list" class="mt-4">${rowsHtml(candidates)}</div>`,
    footer: '<button class="btn btn-secondary" type="button" data-modal-close>Cancel</button>'
  });

  const search = qs('#ret-sale-search', modal.root);
  const list = qs('#ret-sale-list', modal.root);

  search.addEventListener('input', debounce(() => {
    query = search.value;
    const filtered = query
      ? candidates.filter((s) => matchesQuery(
          `${s.ref} ${s.customerName} ${s.userName} ${s.items.map((i) => i.name).join(' ')}`, query))
      : candidates;
    list.innerHTML = rowsHtml(filtered);
  }, 200));

  modal.root.addEventListener('click', (event) => {
    const pick = event.target.closest('[data-pick]');
    if (!pick) return;
    const saleId = pick.getAttribute('data-pick');
    modal.close();
    openRequestModal(saleId);
  });
}

/** Step 2: pick lines, quantities and reasons. */
function openRequestModal(saleId) {
  const sale = findSale(saleId);
  if (!sale) return;

  const alreadyReturned = returnedQtyBySale(sale.id);

  const lines = sale.items.map((item, index) => ({
    index,
    item,
    returnable: num(item.qty) - num(alreadyReturned[index])
  })).filter((l) => l.returnable > 0);

  if (!lines.length) {
    notifyError('Nothing left to return', `Every unit on ${sale.ref} has already been returned.`);
    return;
  }

  const modal = openModal({
    title: `Request return - ${sale.ref}`,
    subtitle: `${fmtDateTime(sale.datetime)} - ${sale.customerName}`,
    size: 'modal-lg',
    iconName: 'returnArrow',
    body: `
      <form id="ret-form" class="stack-lg" novalidate>
        <div class="alert alert-info small">
          ${icon('info', 16)}
          <div>Select what is coming back. The pharmacy owner reviews every request before stock
          or money moves. Damaged and expired items are quarantined instead of returning to sellable stock.</div>
        </div>

        <div class="stack">
          ${lines.map((line) => `
            <div class="card card-pad" data-line="${line.index}">
              <div class="row-start" style="justify-content:space-between;flex-wrap:wrap;gap:var(--sp-3)">
                <label class="check" style="flex:1 1 220px">
                  <input type="checkbox" data-pick-line="${line.index}">
                  <span class="check-text">
                    <strong>${escapeHtml(line.item.name)}</strong>
                    <small>Batch ${escapeHtml(line.item.batchNo)} · exp ${fmtDate(line.item.expiry)}
                      · sold ${int(line.item.qty)} at ${money(line.item.unitPrice)}
                      ${num(alreadyReturned[line.index]) ? ` · ${alreadyReturned[line.index]} already returned` : ''}</small>
                  </span>
                </label>
                <div class="row-sm" style="flex:none">
                  ${qtyStepper({ value: 1, min: 1, max: line.returnable, dataset: `data-qty-line="${line.index}"` })}
                  <span class="small muted nowrap">of ${int(line.returnable)}</span>
                </div>
              </div>
              <div class="mt-3" data-reason-wrap="${line.index}" hidden>
                <select class="select" data-reason-line="${line.index}" aria-label="Return reason">
                  ${options(RETURN_REASONS, '', { placeholder: 'Select a return reason *' })}
                </select>
                <p class="field-hint" data-reason-hint="${line.index}"></p>
              </div>
            </div>`).join('')}
        </div>

        <div class="field">
          <label class="label" for="ret-note">Note for the approver</label>
          <textarea class="textarea" id="ret-note" name="note" rows="2"
            placeholder="Anything the owner should know about this return"></textarea>
        </div>

        <div class="card card-pad">
          <div class="stat-line is-total">
            <span class="sl-label">Refund requested</span>
            <span class="sl-value" id="ret-total">${money(0)}</span>
          </div>
        </div>
      </form>`,
    footer: modalFooter({ confirmLabel: 'Submit request' })
  });

  const form = qs('#ret-form', modal.root);

  /** Recompute the refund preview from the selected lines. */
  const recalc = () => {
    let total = 0;
    lines.forEach((line) => {
      const picked = qs(`[data-pick-line="${line.index}"]`, form).checked;
      const wrap = qs(`[data-reason-wrap="${line.index}"]`, form);
      wrap.hidden = !picked;
      if (!picked) return;
      const qty = num(qs(`[data-qty-line="${line.index}"]`, form).value);
      const unitNet = round(line.item.total / line.item.qty, 2);
      total += round(unitNet * qty, 2);

      const reason = qs(`[data-reason-line="${line.index}"]`, form).value;
      const hint = qs(`[data-reason-hint="${line.index}"]`, form);
      if (reason === 'Damaged product' || reason === 'Expired product') {
        hint.innerHTML = '<span class="c-warning">These units will be quarantined, not returned to sellable stock.</span>';
      } else if (reason) {
        hint.innerHTML = '<span class="c-success">These units return to the original batch once approved.</span>';
      } else {
        hint.textContent = '';
      }
    });
    qs('#ret-total', modal.root).textContent = money(total);
  };

  form.addEventListener('change', recalc);
  form.addEventListener('click', (event) => {
    if (event.target.closest('[data-step]')) {
      const wrapper = event.target.closest('.qty-stepper');
      const input = qs('input', wrapper);
      const step = num(event.target.closest('[data-step]').getAttribute('data-step'));
      const min = num(input.getAttribute('min'), 1);
      const max = num(input.getAttribute('max'), 1);
      input.value = Math.min(Math.max(num(input.value) + step, min), max);
      recalc();
    }
  });

  const submit = () => {
    const picked = lines
      .filter((line) => qs(`[data-pick-line="${line.index}"]`, form).checked)
      .map((line) => ({
        saleItemIndex: line.index,
        qty: num(qs(`[data-qty-line="${line.index}"]`, form).value),
        reason: qs(`[data-reason-line="${line.index}"]`, form).value
      }));

    if (!picked.length) {
      notifyError('Nothing selected', 'Tick at least one line to return.');
      return;
    }
    const missingReason = picked.find((p) => !p.reason);
    if (missingReason) {
      notifyError('Reason required', 'Select a return reason for every selected line.');
      const node = qs(`[data-reason-line="${missingReason.saleItemIndex}"]`, form);
      if (node) { node.classList.add('is-invalid'); node.focus(); }
      return;
    }

    try {
      const record = requestReturn({
        user: ctxRef.user,
        saleId: sale.id,
        items: picked,
        note: qs('#ret-note', form).value.trim()
      });
      modal.close();
      notifySuccess('Return requested', `${record.ref} is waiting for the pharmacy owner to approve.`);
      ctxRef.refresh();
    } catch (error) {
      notifyError('Could not submit the request', error.message);
    }
  };

  form.addEventListener('submit', (event) => { event.preventDefault(); submit(); });
  qs('#modal-confirm', modal.root).addEventListener('click', (event) => { event.preventDefault(); submit(); });

  recalc();
}

/* ============================== APPROVAL FLOW ============================== */

function openApproveModal(returnId) {
  try {
    requirePermission('returns.approve');
  } catch (error) {
    notifyDenied(error);
    return;
  }

  const record = find('returns', returnId);
  if (!record || record.status !== 'pending') return;

  const restockUnits = sum(record.items.filter((l) => l.restock), (l) => l.qty);
  const quarantineUnits = sum(record.items.filter((l) => !l.restock), (l) => l.qty);

  const refundOptions = [
    { value: 'Cash', label: 'Cash refund from the drawer' },
    { value: 'POS/Card', label: 'Card reversal' },
    { value: 'Bank Transfer', label: 'Bank transfer' },
    ...(record.customerId ? [{ value: 'Customer Credit', label: 'Credit the customer account' }] : []),
    { value: 'Exchange', label: 'Exchange - no money refunded' }
  ];

  const modal = openModal({
    title: `Approve ${record.ref}`,
    subtitle: `${money(record.total)} refund against ${record.saleRef}`,
    size: 'modal-lg',
    iconName: 'checkCircle',
    tone: 'success',
    body: `
      <form id="approve-form" class="stack-lg" novalidate>
        ${renderTable({
          compact: true,
          responsive: false,
          columns: [
            { key: 'name', label: 'Medicine', cell: (l) => cellStack(l.name, `Batch ${l.batchNo} - exp ${fmtDate(l.expiry)}`) },
            { key: 'qty', label: 'Qty', className: 'num', cell: (l) => int(l.qty) },
            { key: 'reason', label: 'Reason', cell: (l) => escapeHtml(l.reason) },
            {
              key: 'destination', label: 'Destination',
              cell: (l) => {
                const b = findBatch(l.batchId);
                if (!l.restock) return badge('Quarantine', 'warning');
                if (b && isExpired(b)) return badge('Quarantine (expired batch)', 'warning');
                return badge('Back to sellable stock', 'success');
              }
            },
            { key: 'refund', label: 'Refund', className: 'num', cell: (l) => money(l.refund) }
          ],
          rows: record.items
        })}

        <div class="grid-2">
          <div class="card card-pad">
            <div class="def-label">Returning to sellable stock</div>
            <div class="kpi-value sm-value c-success">${int(restockUnits)} units</div>
          </div>
          <div class="card card-pad">
            <div class="def-label">Going to quarantine</div>
            <div class="kpi-value sm-value c-warning">${int(quarantineUnits)} units</div>
          </div>
        </div>

        ${selectField({
          name: 'refundMethod', label: 'How is the customer being refunded?',
          list: refundOptions, required: true, placeholder: 'Select a refund method'
        })}

        <div class="field">
          <label class="label" for="approve-note">Decision note</label>
          <textarea class="textarea" id="approve-note" name="note" rows="2"
            placeholder="Optional note recorded with the approval"></textarea>
        </div>

        ${record.note ? `<div class="alert alert-neutral small">${icon('info', 15)}
          <div><strong>${escapeHtml(record.requestedBy)} wrote:</strong> ${escapeHtml(record.note)}</div></div>` : ''}
      </form>`,
    footer: modalFooter({ confirmLabel: 'Approve return', tone: 'success' })
  });

  const form = qs('#approve-form', modal.root);

  const submit = () => {
    const data = formData(form);
    if (!data.refundMethod) {
      notifyError('Refund method required', 'Choose how the customer is being refunded.');
      return;
    }
    try {
      const approved = approveReturn(record.id, {
        user: ctxRef.user,
        refundMethod: data.refundMethod,
        note: data.note
      });
      modal.close();
      notifySuccess('Return approved', `Credit note ${approved.creditNoteNo} issued for ${money(approved.total)}.`);
      ctxRef.refresh();
    } catch (error) {
      notifyError('Could not approve', error.message);
    }
  };

  form.addEventListener('submit', (event) => { event.preventDefault(); submit(); });
  qs('#modal-confirm', modal.root).addEventListener('click', (event) => { event.preventDefault(); submit(); });
}

async function rejectFlow(returnId) {
  try {
    requirePermission('returns.approve');
  } catch (error) {
    notifyDenied(error);
    return;
  }

  const record = find('returns', returnId);
  if (!record) return;

  const reason = await promptDialog({
    title: `Reject ${record.ref}?`,
    label: 'Reason for rejection',
    placeholder: 'e.g. Outside the 7-day return window',
    multiline: true,
    required: true,
    confirmLabel: 'Reject return',
    tone: 'danger',
    hint: 'The requesting staff member will see this reason. No stock or money will move.'
  });
  if (!reason) return;

  try {
    rejectReturn(record.id, { user: ctxRef.user, note: reason });
    notifySuccess('Return rejected', `${record.ref} was declined and nothing changed in stock.`);
    ctxRef.refresh();
  } catch (error) {
    notifyError('Could not reject', error.message);
  }
}

/* ============================== DETAIL / CREDIT NOTE ============================== */

function openReturnDrawer(returnId) {
  const record = find('returns', returnId);
  if (!record) return;

  openDrawer({
    title: record.ref,
    subtitle: `Against ${record.saleRef} - requested ${fmtDateTime(record.datetime)}`,
    size: 'drawer-lg',
    body: `
      <div class="stack-lg">
        <div class="row-wrap">
          ${badge(record.status.charAt(0).toUpperCase() + record.status.slice(1), STATUS_TONE[record.status], { dot: true })}
          ${record.refundMethod ? badge(record.refundMethod, 'neutral') : ''}
          ${record.creditNoteNo ? badge(`Credit note ${record.creditNoteNo}`, 'info') : ''}
        </div>

        <div class="def-grid">
          <div class="def-item"><div class="def-label">Original sale</div><div class="def-value mono">${escapeHtml(record.saleRef)}</div></div>
          <div class="def-item"><div class="def-label">Customer</div><div class="def-value">${escapeHtml(record.customerName || 'Walk-in Customer')}</div></div>
          <div class="def-item"><div class="def-label">Requested by</div><div class="def-value">${escapeHtml(record.requestedBy)}</div></div>
          <div class="def-item"><div class="def-label">Requested</div><div class="def-value">${fmtDateTime(record.datetime)}</div></div>
          <div class="def-item"><div class="def-label">Refund value</div><div class="def-value num">${money(record.total)}</div></div>
          ${record.decidedAt ? `
            <div class="def-item"><div class="def-label">${record.status === 'approved' ? 'Approved' : 'Rejected'} by</div><div class="def-value">${escapeHtml(record.decidedBy)}</div></div>
            <div class="def-item"><div class="def-label">Decision date</div><div class="def-value">${fmtDateTime(record.decidedAt)}</div></div>` : ''}
          ${record.restockedUnits !== undefined ? `
            <div class="def-item"><div class="def-label">Returned to stock</div><div class="def-value num">${int(record.restockedUnits)} units</div></div>
            <div class="def-item"><div class="def-label">Quarantined</div><div class="def-value num">${int(record.quarantinedUnits)} units</div></div>` : ''}
        </div>

        ${record.note ? `<div class="alert alert-neutral small">${icon('info', 15)}
          <div><strong>Request note:</strong> ${escapeHtml(record.note)}</div></div>` : ''}
        ${record.decisionNote ? `<div class="alert alert-${record.status === 'approved' ? 'success' : 'danger'} small">
          ${icon('info', 15)}<div><strong>Decision note:</strong> ${escapeHtml(record.decisionNote)}</div></div>` : ''}

        <section>
          <h3 class="mb-3">Returned items</h3>
          ${renderTable({
            compact: true,
            responsive: false,
            columns: [
              { key: 'name', label: 'Medicine', cell: (l) => cellStack(l.name, `Batch ${l.batchNo} - exp ${fmtDate(l.expiry)}`) },
              { key: 'qty', label: 'Qty', className: 'num', cell: (l) => int(l.qty) },
              { key: 'unitPrice', label: 'Unit', className: 'num', cell: (l) => money(l.unitPrice) },
              { key: 'reason', label: 'Reason', cell: (l) => escapeHtml(l.reason) },
              { key: 'restock', label: 'Sellable again', cell: (l) => (l.restock ? badge('Yes', 'success') : badge('No', 'warning')) },
              { key: 'refund', label: 'Refund', className: 'num', cell: (l) => `<strong>${money(l.refund)}</strong>` }
            ],
            rows: record.items
          })}
        </section>
      </div>`,
    footer: `
      <button class="btn btn-secondary" type="button" data-route="#/sales?sale=${record.saleId}">${icon('receipt', 15)} Original sale</button>
      ${record.status === 'approved' ? `<button class="btn btn-secondary" type="button" data-print="${record.id}">${icon('print', 15)} Credit note</button>` : ''}
      ${record.status === 'pending' && can('returns.approve') ? `
        <button class="btn btn-danger-soft" type="button" data-reject="${record.id}">Reject</button>
        <button class="btn btn-success" type="button" data-approve="${record.id}">Approve</button>` : ''}`,
    onMount: (api) => {
      api.root.addEventListener('click', (event) => {
        const approveBtn = event.target.closest('[data-approve]');
        if (approveBtn) { api.close(); openApproveModal(approveBtn.getAttribute('data-approve')); return; }
        const rejectBtn = event.target.closest('[data-reject]');
        if (rejectBtn) { api.close(); rejectFlow(rejectBtn.getAttribute('data-reject')); return; }
        const printBtn = event.target.closest('[data-print]');
        if (printBtn) printCreditNote(printBtn.getAttribute('data-print'));
      });
    }
  });
}

function printCreditNote(returnId) {
  const record = find('returns', returnId);
  if (!record) return;
  const pharmacy = settings().pharmacy;

  printNode(`
    <div class="print-doc">
      ${printHeader({
        pharmacy,
        title: 'Credit Note',
        subtitle: record.creditNoteNo || record.ref,
        meta: `Date ${fmtDate(record.decidedAt || record.datetime)}<br>
               Against sale ${escapeHtml(record.saleRef)}<br>
               Refund method: ${escapeHtml(record.refundMethod || '-')}`
      })}
      <h2 class="print-section">Customer</h2>
      <p>${escapeHtml(record.customerName || 'Walk-in Customer')}</p>

      <h2 class="print-section">Returned items</h2>
      <table>
        <thead><tr>
          <th>Medicine</th><th>Batch</th><th>Expiry</th>
          <th class="num">Qty</th><th class="num">Unit price</th><th class="num">Refund</th><th>Reason</th>
        </tr></thead>
        <tbody>${record.items.map((l) => `<tr>
          <td>${escapeHtml(l.name)}</td>
          <td>${escapeHtml(l.batchNo)}</td>
          <td>${fmtDate(l.expiry)}</td>
          <td class="num">${int(l.qty)}</td>
          <td class="num">${money(l.unitPrice)}</td>
          <td class="num">${money(l.refund)}</td>
          <td>${escapeHtml(l.reason)}</td>
        </tr>`).join('')}</tbody>
        <tfoot><tr>
          <td colspan="5">Total credited</td>
          <td class="num">${money(record.total)}</td><td></td>
        </tr></tfoot>
      </table>

      <p class="mt-6">Requested by ${escapeHtml(record.requestedBy)} ·
         Approved by ${escapeHtml(record.decidedBy || '-')} on ${fmtDateTime(record.decidedAt)}</p>
      ${printFooter({ left: `${escapeHtml(pharmacy.name)} - customer copy`, right: 'MediFlow Pharmacy ERP' })}
    </div>`, 'report');
}

/* ============================== RENDER ============================== */

export function render(root, ctx) {
  ctxRef = ctx;

  const isAdmin = can('returns.approve');
  const counts = tabCounts();
  const allRows = visibleReturns();
  const pageData = paginate(allRows, state.page, PER_PAGE);

  const pendingValue = sum(db.returns.filter((r) => r.status === 'pending'), (r) => r.total);
  const approvedValue = sum(db.returns.filter((r) => r.status === 'approved'), (r) => r.total);

  const columns = [
    { key: 'ref', label: 'Return', cell: (r) => cellStack(r.ref, fmtRelative(r.datetime)) },
    { key: 'saleRef', label: 'Original sale', cell: (r) => `<span class="mono small">${escapeHtml(r.saleRef)}</span>` },
    { key: 'customerName', label: 'Customer', cell: (r) => escapeHtml(r.customerName || 'Walk-in') },
    ...(isAdmin ? [{ key: 'requestedBy', label: 'Requested by', cell: (r) => escapeHtml(r.requestedBy) }] : []),
    {
      key: 'items', label: 'Items', className: 'num',
      cell: (r) => `${int(sum(r.items, (l) => l.qty))}<div class="cell-sub">${r.items.length} line(s)</div>`
    },
    {
      key: 'reason', label: 'Reason',
      cell: (r) => {
        const reasons = [...new Set(r.items.map((l) => l.reason))];
        return reasons.length === 1 ? escapeHtml(reasons[0]) : `${reasons.length} reasons`;
      }
    },
    { key: 'total', label: 'Refund', className: 'num', cell: (r) => `<strong>${money(r.total)}</strong>` },
    {
      key: 'status', label: 'Status',
      cell: (r) => badge(r.status.charAt(0).toUpperCase() + r.status.slice(1), STATUS_TONE[r.status], { dot: true })
    },
    {
      key: 'actions', label: '', className: 'right',
      cell: (r) => `<div class="table-actions">
        <button class="btn btn-ghost btn-sm" type="button" data-open="${r.id}" title="View details">${icon('eye', 15)}</button>
        ${r.status === 'pending' && isAdmin ? `
          <button class="btn btn-ghost btn-sm" type="button" data-approve="${r.id}" title="Approve">${icon('check', 15)}</button>
          <button class="btn btn-ghost btn-sm" type="button" data-reject="${r.id}" title="Reject">${icon('close', 15)}</button>` : ''}
        ${r.status === 'approved' ? `<button class="btn btn-ghost btn-sm" type="button" data-print="${r.id}" title="Print credit note">${icon('print', 15)}</button>` : ''}
      </div>`
    }
  ];

  root.innerHTML = `
  <div class="page">
    ${pageHead({
      title: 'Sales Returns',
      subtitle: isAdmin
        ? 'Review every return request. Stock and refunds only move when you approve.'
        : 'Your return requests. The pharmacy owner approves them before anything changes.',
      actions: `
        ${can('export.data') ? `<button class="btn btn-secondary" type="button" id="btn-export">${icon('download', 16)} Export CSV</button>` : ''}
        ${can('returns.request') ? `<button class="btn btn-primary" type="button" id="btn-new">${icon('plus', 16)} New return request</button>` : ''}`
    })}

    ${isAdmin && counts.pending ? `
      <div class="alert alert-warning">
        ${icon('alert', 17)}
        <div>
          <div class="alert-title">${counts.pending} return${counts.pending > 1 ? 's' : ''} awaiting your approval</div>
          <div class="small">${money(pendingValue)} of requested refunds is on hold until you decide.</div>
        </div>
      </div>` : ''}

    <div class="kpi-grid">
      ${kpi({ label: 'Pending', value: int(counts.pending), iconName: 'clock', tone: counts.pending ? 'warning' : '', foot: `<span>${money(pendingValue)} requested</span>`, small: true })}
      ${kpi({ label: 'Approved', value: int(counts.approved), iconName: 'checkCircle', tone: 'success', foot: `<span>${money(approvedValue)} refunded</span>`, small: true })}
      ${kpi({ label: 'Rejected', value: int(counts.rejected), iconName: 'close', tone: counts.rejected ? 'danger' : '', small: true })}
      ${kpi({ label: 'Total requests', value: int(counts.all), iconName: 'returnArrow', small: true })}
    </div>

    <div class="toolbar">
      <div class="tabs" id="ret-tabs" style="border:0">
        <button type="button" data-tab="pending" class="${state.tab === 'pending' ? 'is-active' : ''}">
          Pending <span class="tab-count">${counts.pending}</span></button>
        <button type="button" data-tab="approved" class="${state.tab === 'approved' ? 'is-active' : ''}">
          Approved <span class="tab-count">${counts.approved}</span></button>
        <button type="button" data-tab="rejected" class="${state.tab === 'rejected' ? 'is-active' : ''}">
          Rejected <span class="tab-count">${counts.rejected}</span></button>
        <button type="button" data-tab="all" class="${state.tab === 'all' ? 'is-active' : ''}">
          All <span class="tab-count">${counts.all}</span></button>
      </div>
      <div class="spacer"></div>
      ${searchBox({ id: 'ret-search', value: state.query, placeholder: 'Search return, receipt or medicine...' })}
    </div>

    ${card({
      flush: true,
      body: renderTable({
        columns,
        rows: pageData.rows,
        rowClass: (r) => (r.status === 'pending' ? 'row-warning' : ''),
        empty: emptyState({
          iconName: 'returnArrow',
          title: state.tab === 'pending' ? 'No returns waiting' : 'No returns here',
          message: state.tab === 'pending'
            ? 'Return requests raised at the counter appear here for approval.'
            : 'Try another tab or clear the search.',
          actions: can('returns.request')
            ? '<button class="btn btn-primary btn-sm" type="button" id="btn-new-empty">New return request</button>'
            : ''
        })
      }) + renderPagination(pageData, { label: 'returns' })
    })}
  </div>`;

  /* ---------------------------- events ---------------------------- */

  const rerender = () => ctx.refresh();

  qsa('#ret-tabs [data-tab]', root).forEach((btn) => btn.addEventListener('click', () => {
    state.tab = btn.getAttribute('data-tab');
    state.page = 1;
    rerender();
  }));

  const search = qs('#ret-search', root);
  search.addEventListener('input', debounce(() => {
    state.query = search.value;
    state.page = 1;
    const caret = search.selectionStart;
    rerender();
    const next = qs('#ret-search');
    if (next) { next.focus(); next.setSelectionRange(caret, caret); }
  }, 260));

  on(root, 'click', '[data-page]', (event, node) => {
    const page = num(node.getAttribute('data-page'));
    if (page >= 1 && page <= pageData.pages) { state.page = page; rerender(); }
  });

  on(root, 'click', '[data-open]', (event, node) => openReturnDrawer(node.getAttribute('data-open')));
  on(root, 'click', '[data-approve]', (event, node) => {
    event.stopPropagation();
    openApproveModal(node.getAttribute('data-approve'));
  });
  on(root, 'click', '[data-reject]', (event, node) => {
    event.stopPropagation();
    rejectFlow(node.getAttribute('data-reject'));
  });
  on(root, 'click', '[data-print]', (event, node) => {
    event.stopPropagation();
    printCreditNote(node.getAttribute('data-print'));
  });

  qsa('#btn-new, #btn-new-empty', root).forEach((btn) =>
    btn.addEventListener('click', openSalePickerModal));

  const exportBtn = qs('#btn-export', root);
  if (exportBtn) exportBtn.addEventListener('click', () => {
    downloadCsv(exportName('returns'), allRows, [
      { label: 'Return ref', value: (r) => r.ref },
      { label: 'Date', value: (r) => fmtDate(r.datetime) },
      { label: 'Original sale', value: (r) => r.saleRef },
      { label: 'Customer', value: (r) => r.customerName },
      { label: 'Requested by', value: (r) => r.requestedBy },
      { label: 'Units', value: (r) => sum(r.items, (l) => l.qty) },
      { label: 'Reasons', value: (r) => [...new Set(r.items.map((l) => l.reason))].join('; ') },
      { label: 'Refund', value: (r) => r.total },
      { label: 'Status', value: (r) => r.status },
      { label: 'Refund method', value: (r) => r.refundMethod },
      { label: 'Decided by', value: (r) => r.decidedBy },
      { label: 'Decision note', value: (r) => r.decisionNote }
    ]);
    notifySuccess('Export ready', `${allRows.length} returns exported to CSV.`);
  });

  // Deep link: start a request for a specific sale
  if (ctx.query.sale) {
    openRequestModal(ctx.query.sale);
    ctx.navigate('/returns');
  }
}

export default { render };
