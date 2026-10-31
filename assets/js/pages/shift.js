/* ==========================================================================
   MediFlow Pharmacy ERP - Cash Drawer & Staff Shifts
   Staff open and close their own shift; the owner sees every shift and the cash
   discrepancies. Expected cash is always recalculated from the linked sales
   and refunds, never stored as a running total (section 21).
   ========================================================================== */

import {
  db, shifts, shift as findShift, activeShift, openShift, closeShift, shiftSummary,
  cashInDrawer, users, settings
} from '../store.js';
import { can, requirePermission } from '../auth.js';
import {
  pageHead, card, kpi, icon, badge, renderTable, cellStack, renderPagination, emptyState,
  openModal, openDrawer, modalFooter, confirmDialog, notifySuccess, notifyError, notifyWarning,
  notifyDenied, escapeHtml, field, options, searchBox, printNode, printHeader, printFooter,
  barChart
} from '../ui.js';
import {
  money, int, num, round, fmtDate, fmtTime, fmtDateTime, fmtRelative, fmtDuration, sortBy,
  paginate, qs, qsa, on, debounce, matchesQuery, sum, formData, downloadCsv, exportName,
  isSameDay
} from '../utils.js';

const PER_PAGE = 12;

const state = { query: '', userId: '', status: '', page: 1 };

let ctxRef = null;

/* ============================== OPEN SHIFT ============================== */

function openShiftModal() {
  try {
    requirePermission('shift.own');
  } catch (error) {
    notifyDenied(error);
    return;
  }

  const lastShift = sortBy(shifts().filter((s) => s.userId === ctxRef.user.id && s.status === 'closed'),
    (s) => s.closedAt, 'desc')[0];

  const modal = openModal({
    title: 'Open your shift',
    subtitle: 'Count the cash in the drawer before you start selling',
    size: 'modal-sm',
    iconName: 'cash',
    body: `
      <form id="shift-form" class="stack-lg" novalidate>
        ${field({
          name: 'openingCash', label: 'Opening cash in drawer', type: 'number', required: true,
          value: lastShift ? num(lastShift.countedCash) : 0,
          attrs: 'min="0" step="0.01" autofocus',
          hint: lastShift
            ? `Your last shift closed with ${money(lastShift.countedCash)} on ${fmtDate(lastShift.closedAt)}.`
            : 'Enter the float you are starting with.'
        })}
        <div class="field">
          <label class="label" for="shift-note">Note</label>
          <input class="input" id="shift-note" name="note" placeholder="e.g. Morning shift, float from safe" autocomplete="off">
        </div>
        <div class="alert alert-info small">
          ${icon('info', 16)}
          <div>Every sale you record while this shift is open is linked to it, so the expected
          cash at close is calculated from your actual transactions.</div>
        </div>
      </form>`,
    footer: modalFooter({ confirmLabel: 'Open shift' })
  });

  const form = qs('#shift-form', modal.root);
  const submit = () => {
    const data = formData(form);
    if (num(data.openingCash) < 0) {
      notifyError('Invalid amount', 'Opening cash cannot be negative.');
      return;
    }
    try {
      const row = openShift({ user: ctxRef.user, openingCash: data.openingCash, note: data.note });
      modal.close();
      notifySuccess('Shift opened', `${row.ref} started with ${money(row.openingCash)} in the drawer.`);
      ctxRef.refresh();
    } catch (error) {
      notifyError('Could not open the shift', error.message);
    }
  };
  form.addEventListener('submit', (event) => { event.preventDefault(); submit(); });
  qs('#modal-confirm', modal.root).addEventListener('click', (event) => { event.preventDefault(); submit(); });
}

/* ============================== CLOSE SHIFT ============================== */

function openCloseModal(shiftId) {
  const row = findShift(shiftId);
  if (!row) return;

  // Staff may only close their own shift.
  if (row.userId !== ctxRef.user.id && !can('shift.view.all')) {
    notifyDenied({ message: 'You can only close your own shift.' });
    return;
  }

  const summary = shiftSummary(row);

  const modal = openModal({
    title: 'Close shift',
    subtitle: `${row.ref} - opened ${fmtTime(row.openedAt)} (${fmtDuration(row.openedAt)})`,
    size: 'modal-lg',
    iconName: 'cash',
    body: `
      <form id="close-form" class="stack-lg" novalidate>
        <div class="card card-pad">
          <div class="divider-label mb-3">Expected cash, calculated from your transactions</div>
          <div class="stack-sm" style="gap:2px">
            <div class="stat-line"><span class="sl-label">Opening cash</span><span class="sl-value">${money(row.openingCash)}</span></div>
            <div class="stat-line"><span class="sl-label">Cash sales (${summary.transactions} transaction(s) in total)</span><span class="sl-value">+${money(summary.cashSales)}</span></div>
            ${summary.cashRefunds ? `<div class="stat-line"><span class="sl-label">Cash refunds paid out</span><span class="sl-value c-danger">-${money(summary.cashRefunds)}</span></div>` : ''}
            <div class="stat-line is-total"><span class="sl-label">Expected in drawer</span><span class="sl-value">${money(summary.expectedCash)}</span></div>
          </div>
        </div>

        <div class="grid-2">
          <div class="card card-pad">
            <div class="def-label">Card / POS sales</div>
            <div class="kpi-value sm-value">${money(summary.cardSales)}</div>
          </div>
          <div class="card card-pad">
            <div class="def-label">Transfer sales</div>
            <div class="kpi-value sm-value">${money(summary.transferSales)}</div>
          </div>
          <div class="card card-pad">
            <div class="def-label">Credit sales</div>
            <div class="kpi-value sm-value">${money(summary.creditSales)}</div>
          </div>
          <div class="card card-pad">
            <div class="def-label">Total sales value</div>
            <div class="kpi-value sm-value">${money(summary.grossSales)}</div>
          </div>
        </div>

        ${field({
          name: 'countedCash', label: 'Actual cash counted in the drawer', type: 'number', required: true,
          attrs: 'min="0" step="0.01" autofocus placeholder="0.00"',
          hint: 'Count the physical notes and coins, including the opening float.'
        })}

        <div class="card card-pad" id="variance-box">
          <div class="stat-line is-total">
            <span class="sl-label">Shortage / excess</span>
            <span class="sl-value" id="variance-value">-</span>
          </div>
          <p class="small muted mt-2" id="variance-hint">Enter the counted cash to see the difference.</p>
        </div>

        <div class="field">
          <label class="label" for="close-note">Closing note</label>
          <textarea class="textarea" id="close-note" name="note" rows="2"
            placeholder="Explain any difference - recount, float moved to safe, etc."></textarea>
        </div>
      </form>`,
    footer: modalFooter({ confirmLabel: 'Close shift', tone: 'primary' })
  });

  const form = qs('#close-form', modal.root);
  const countedInput = form.elements.countedCash;

  const updateVariance = () => {
    if (countedInput.value === '') {
      qs('#variance-value', modal.root).textContent = '-';
      qs('#variance-hint', modal.root).textContent = 'Enter the counted cash to see the difference.';
      return;
    }
    const variance = round(num(countedInput.value) - summary.expectedCash, 2);
    const node = qs('#variance-value', modal.root);
    node.textContent = `${variance > 0 ? '+' : ''}${money(variance)}`;
    node.className = `sl-value ${variance === 0 ? 'c-success' : (variance < 0 ? 'c-danger' : 'c-warning')}`;
    qs('#variance-hint', modal.root).innerHTML = variance === 0
      ? '<span class="c-success">The drawer balances exactly.</span>'
      : (variance < 0
        ? `<span class="c-danger">${money(Math.abs(variance))} short - explain the difference in the note below.</span>`
        : `<span class="c-warning">${money(variance)} more than expected - check for an unrecorded sale.</span>`);
  };

  form.addEventListener('input', updateVariance);

  const submit = async () => {
    const data = formData(form);
    if (data.countedCash === '' || num(data.countedCash) < 0) {
      notifyError('Count the drawer', 'Enter the actual cash counted before closing.');
      countedInput.focus();
      return;
    }

    const variance = round(num(data.countedCash) - summary.expectedCash, 2);
    if (variance !== 0 && !String(data.note).trim()) {
      const proceed = await confirmDialog({
        title: variance < 0 ? 'Close with a shortage?' : 'Close with an excess?',
        message: `The drawer is ${money(Math.abs(variance))} ${variance < 0 ? 'short' : 'over'} and no note has been entered.`,
        detail: 'Discrepancies are highlighted to the pharmacy owner. A note helps explain what happened.',
        confirmLabel: 'Close anyway',
        tone: 'warning',
        iconName: 'alert'
      });
      if (!proceed) return;
    }

    try {
      const closed = closeShift({
        user: ctxRef.user,
        shiftId: row.id,
        countedCash: data.countedCash,
        note: data.note
      });
      modal.close();
      if (closed.variance === 0) {
        notifySuccess('Shift closed', `${closed.ref} balanced exactly at ${money(closed.countedCash)}.`);
      } else {
        notifyWarning('Shift closed with a difference',
          `${closed.ref}: ${money(Math.abs(closed.variance))} ${closed.variance < 0 ? 'short' : 'over'}.`);
      }
      ctxRef.refresh();
    } catch (error) {
      notifyError('Could not close the shift', error.message);
    }
  };

  form.addEventListener('submit', (event) => { event.preventDefault(); submit(); });
  qs('#modal-confirm', modal.root).addEventListener('click', (event) => { event.preventDefault(); submit(); });
}

/* ============================== SHIFT DETAIL ============================== */

function openShiftDrawer(shiftId) {
  const row = findShift(shiftId);
  if (!row) return;

  // Staff see only their own shifts.
  if (row.userId !== ctxRef.user.id && !can('shift.view.all')) {
    notifyDenied({ message: 'You can only view your own shifts.' });
    return;
  }

  const summary = shiftSummary(row);
  const sales = sortBy(db.sales.filter((s) => s.shiftId === row.id), (s) => s.datetime, 'desc');
  const variance = row.status === 'closed' ? num(row.variance) : null;

  openDrawer({
    title: row.ref,
    subtitle: `${row.userName} - ${fmtDateTime(row.openedAt)}`,
    size: 'drawer-lg',
    body: `
      <div class="stack-lg">
        <div class="row-wrap">
          ${row.status === 'open'
            ? badge('Open', 'warning', { dot: true })
            : badge('Closed', 'success', { dot: true })}
          ${variance !== null && variance !== 0
            ? badge(`${money(Math.abs(variance))} ${variance < 0 ? 'short' : 'over'}`, variance < 0 ? 'danger' : 'warning')
            : (row.status === 'closed' ? badge('Balanced', 'success') : '')}
          ${badge(`${summary.transactions} sale(s)`, 'neutral')}
        </div>

        <div class="kpi-grid">
          ${kpi({ label: 'Opening cash', value: money(row.openingCash), iconName: 'cash', small: true })}
          ${kpi({ label: 'Cash sales', value: money(summary.cashSales), iconName: 'wallet', tone: 'success', small: true })}
          ${kpi({
            label: row.status === 'open' ? 'Expected now' : 'Expected at close',
            value: money(summary.expectedCash), iconName: 'percent', tone: 'info', small: true
          })}
          ${row.status === 'closed'
            ? kpi({
                label: 'Counted',
                value: money(row.countedCash),
                iconName: variance === 0 ? 'checkCircle' : 'alert',
                tone: variance === 0 ? 'success' : (variance < 0 ? 'danger' : 'warning'),
                foot: `<span>${variance === 0 ? 'Balanced' : `${money(Math.abs(variance))} ${variance < 0 ? 'short' : 'over'}`}</span>`,
                small: true
              })
            : kpi({ label: 'Open for', value: fmtDuration(row.openedAt), iconName: 'clock', tone: 'warning', small: true })}
        </div>

        <section>
          <h3 class="mb-3">Cash reconciliation</h3>
          <div class="stack-sm" style="gap:2px">
            <div class="stat-line"><span class="sl-label">Opening cash</span><span class="sl-value">${money(row.openingCash)}</span></div>
            <div class="stat-line"><span class="sl-label">Cash received from sales</span><span class="sl-value">+${money(summary.cashSales)}</span></div>
            <div class="stat-line"><span class="sl-label">Cash refunds paid</span><span class="sl-value">-${money(summary.cashRefunds)}</span></div>
            <div class="stat-line is-total"><span class="sl-label">Expected cash</span><span class="sl-value">${money(summary.expectedCash)}</span></div>
            ${row.status === 'closed' ? `
              <div class="stat-line"><span class="sl-label">Counted cash</span><span class="sl-value">${money(row.countedCash)}</span></div>
              <div class="stat-line"><span class="sl-label">Difference</span>
                <span class="sl-value ${variance === 0 ? 'c-success' : (variance < 0 ? 'c-danger' : 'c-warning')}">
                  ${variance > 0 ? '+' : ''}${money(variance)}</span></div>` : ''}
          </div>
        </section>

        <section>
          <h3 class="mb-3">Sales by payment method</h3>
          <div class="def-grid">
            <div class="def-item"><div class="def-label">Cash</div><div class="def-value num">${money(summary.cashSales)}</div></div>
            <div class="def-item"><div class="def-label">POS / Card</div><div class="def-value num">${money(summary.cardSales)}</div></div>
            <div class="def-item"><div class="def-label">Bank transfer</div><div class="def-value num">${money(summary.transferSales)}</div></div>
            <div class="def-item"><div class="def-label">Credit</div><div class="def-value num">${money(summary.creditSales)}</div></div>
            <div class="def-item"><div class="def-label">Total sales value</div><div class="def-value num"><strong>${money(summary.grossSales)}</strong></div></div>
          </div>
        </section>

        ${row.note || row.closingNote ? `
          <div class="alert alert-neutral small">
            ${icon('info', 15)}
            <div>
              ${row.note ? `<div><strong>Opening note:</strong> ${escapeHtml(row.note)}</div>` : ''}
              ${row.closingNote ? `<div><strong>Closing note:</strong> ${escapeHtml(row.closingNote)}</div>` : ''}
            </div>
          </div>` : ''}

        <section>
          <h3 class="mb-3">Transactions in this shift (${sales.length})</h3>
          ${sales.length ? renderTable({
            compact: true,
            responsive: false,
            columns: [
              { key: 'ref', label: 'Receipt', cell: (s) => cellStack(s.ref, fmtTime(s.datetime)) },
              { key: 'customerName', label: 'Customer', cell: (s) => escapeHtml(s.customerName) },
              { key: 'method', label: 'Payment', cell: (s) => badge(s.payment.method, s.payment.method === 'Credit' ? 'warning' : 'neutral') },
              { key: 'total', label: 'Total', className: 'num', cell: (s) => money(s.total) }
            ],
            rows: sales.slice(0, 30),
            footer: `<tr><td colspan="3">Total</td><td class="num">${money(sum(sales.filter((s) => s.status !== 'voided'), (s) => s.total))}</td></tr>`
          }) : emptyState({ iconName: 'receipt', title: 'No sales recorded in this shift' })}
        </section>
      </div>`,
    footer: `
      <button class="btn btn-secondary" type="button" data-print="${row.id}">${icon('print', 15)} Print Z-report</button>
      ${row.status === 'open' && (row.userId === ctxRef.user.id || can('shift.view.all'))
        ? `<button class="btn btn-primary" type="button" data-close="${row.id}">${icon('cash', 15)} Close shift</button>` : ''}`,
    onMount: (api) => {
      api.root.addEventListener('click', (event) => {
        const close = event.target.closest('[data-close]');
        if (close) { api.close(); openCloseModal(close.getAttribute('data-close')); return; }
        const print = event.target.closest('[data-print]');
        if (print) printZReport(print.getAttribute('data-print'));
      });
    }
  });
}

/** Z-report: the end-of-shift cash declaration. */
function printZReport(shiftId) {
  const row = findShift(shiftId);
  if (!row) return;
  const summary = shiftSummary(row);
  const pharmacy = settings().pharmacy;
  const sales = db.sales.filter((s) => s.shiftId === row.id && s.status !== 'voided');

  printNode(`
    <div class="print-doc">
      ${printHeader({
        pharmacy,
        title: 'Shift Cash Report (Z-Report)',
        subtitle: row.ref,
        meta: `Cashier: ${escapeHtml(row.userName)}<br>
               Opened: ${fmtDateTime(row.openedAt)}<br>
               ${row.closedAt ? `Closed: ${fmtDateTime(row.closedAt)}` : 'Status: OPEN'}`
      })}

      <div class="print-kpis">
        <div class="print-kpi"><div class="pk-label">Transactions</div><div class="pk-value">${int(summary.transactions)}</div></div>
        <div class="print-kpi"><div class="pk-label">Total sales</div><div class="pk-value">${money(summary.grossSales)}</div></div>
        <div class="print-kpi"><div class="pk-label">Expected cash</div><div class="pk-value">${money(summary.expectedCash)}</div></div>
        <div class="print-kpi"><div class="pk-label">${row.status === 'closed' ? 'Counted cash' : 'Not yet counted'}</div>
          <div class="pk-value">${row.status === 'closed' ? money(row.countedCash) : '-'}</div></div>
      </div>

      <h2 class="print-section">Cash reconciliation</h2>
      <table>
        <tbody>
          <tr><td>Opening cash float</td><td class="num">${money(row.openingCash)}</td></tr>
          <tr><td>Cash received from sales</td><td class="num">${money(summary.cashSales)}</td></tr>
          <tr><td>Cash refunds paid out</td><td class="num">-${money(summary.cashRefunds)}</td></tr>
          <tr><td><strong>Expected cash in drawer</strong></td><td class="num"><strong>${money(summary.expectedCash)}</strong></td></tr>
          ${row.status === 'closed' ? `
            <tr><td>Actual cash counted</td><td class="num">${money(row.countedCash)}</td></tr>
            <tr><td><strong>Shortage / excess</strong></td>
                <td class="num"><strong>${num(row.variance) > 0 ? '+' : ''}${money(row.variance)}</strong></td></tr>` : ''}
        </tbody>
      </table>

      <h2 class="print-section">Sales by payment method</h2>
      <table>
        <thead><tr><th>Method</th><th class="num">Value</th></tr></thead>
        <tbody>
          <tr><td>Cash</td><td class="num">${money(summary.cashSales)}</td></tr>
          <tr><td>POS / Card</td><td class="num">${money(summary.cardSales)}</td></tr>
          <tr><td>Bank transfer</td><td class="num">${money(summary.transferSales)}</td></tr>
          <tr><td>Credit (on account)</td><td class="num">${money(summary.creditSales)}</td></tr>
        </tbody>
        <tfoot><tr><td>Total</td><td class="num">${money(summary.grossSales)}</td></tr></tfoot>
      </table>

      ${row.closingNote ? `<h2 class="print-section">Closing note</h2><p>${escapeHtml(row.closingNote)}</p>` : ''}

      <div style="margin-top:14mm;display:flex;gap:16mm">
        <div style="flex:1">______________________________<br><span style="font-size:7.5pt">Cashier signature</span></div>
        <div style="flex:1">______________________________<br><span style="font-size:7.5pt">Verified by (Owner)</span></div>
      </div>
      ${printFooter({ left: `${escapeHtml(pharmacy.name)} - ${sales.length} transaction(s)`, right: 'MediFlow Pharmacy ERP' })}
    </div>`, 'report');
}

/* ============================== RENDER ============================== */

export function render(root, ctx) {
  ctxRef = ctx;

  const viewAll = can('shift.view.all');
  const myShift = activeShift(ctx.user.id);
  const mySummary = myShift ? shiftSummary(myShift) : null;

  let rows = viewAll ? shifts() : shifts().filter((s) => s.userId === ctx.user.id);
  if (state.userId && viewAll) rows = rows.filter((s) => s.userId === state.userId);
  if (state.status) rows = rows.filter((s) => s.status === state.status);
  if (state.query) {
    rows = rows.filter((s) => matchesQuery(`${s.ref} ${s.userName} ${s.note} ${s.closingNote}`, state.query));
  }
  rows = sortBy(rows, (s) => s.openedAt, 'desc');
  const pageData = paginate(rows, state.page, PER_PAGE);

  const closed = rows.filter((s) => s.status === 'closed');
  const discrepancies = closed.filter((s) => num(s.variance) !== 0);
  const todayShifts = shifts().filter((s) => isSameDay(s.openedAt, new Date()));

  // Variance trend across the most recent closed shifts
  const varianceSeries = sortBy(closed.slice(0, 12), (s) => s.closedAt, 'asc').map((s) => ({
    label: fmtDate(s.closedAt).slice(0, 5),
    value: num(s.variance),
    tip: `${s.ref} (${s.userName}): ${num(s.variance) === 0 ? 'balanced' : `${money(num(s.variance))} ${num(s.variance) < 0 ? 'short' : 'over'}`}`,
    color: num(s.variance) < 0 ? 'var(--chart-5)' : (num(s.variance) > 0 ? 'var(--chart-3)' : 'var(--chart-1)')
  }));

  const columns = [
    { key: 'ref', label: 'Shift', cell: (s) => cellStack(s.ref, fmtRelative(s.openedAt)) },
    ...(viewAll ? [{ key: 'userName', label: 'Cashier', cell: (s) => escapeHtml(s.userName) }] : []),
    { key: 'opened', label: 'Opened', cell: (s) => cellStack(fmtDate(s.openedAt), fmtTime(s.openedAt)) },
    {
      key: 'closed', label: 'Closed',
      cell: (s) => (s.closedAt
        ? cellStack(fmtTime(s.closedAt), fmtDuration(s.openedAt, s.closedAt))
        : '<span class="c-warning">Still open</span>')
    },
    { key: 'openingCash', label: 'Opening', className: 'num', cell: (s) => money(s.openingCash) },
    {
      key: 'sales', label: 'Sales', className: 'num',
      cell: (s) => {
        const summary = shiftSummary(s);
        return `${money(summary.grossSales)}<div class="cell-sub">${int(summary.transactions)} txn</div>`;
      }
    },
    {
      key: 'expected', label: 'Expected', className: 'num',
      cell: (s) => money(s.status === 'closed' ? num(s.expectedCash) : shiftSummary(s).expectedCash)
    },
    {
      key: 'counted', label: 'Counted', className: 'num',
      cell: (s) => (s.status === 'closed' ? money(s.countedCash) : '<span class="subtle">-</span>')
    },
    {
      key: 'variance', label: 'Difference', className: 'num',
      cell: (s) => {
        if (s.status !== 'closed') return '<span class="subtle">-</span>';
        const v = num(s.variance);
        if (v === 0) return '<span class="c-success">Balanced</span>';
        return `<strong class="${v < 0 ? 'c-danger' : 'c-warning'}">${v > 0 ? '+' : ''}${money(v)}</strong>`;
      }
    },
    {
      key: 'actions', label: '', className: 'right',
      cell: (s) => `<div class="table-actions">
        <button class="btn btn-ghost btn-sm" type="button" data-open="${s.id}" title="View shift">${icon('eye', 15)}</button>
        ${s.status === 'open' && (s.userId === ctx.user.id || viewAll)
          ? `<button class="btn btn-ghost btn-sm" type="button" data-close="${s.id}" title="Close shift">${icon('cash', 15)}</button>` : ''}
        <button class="btn btn-ghost btn-sm" type="button" data-print="${s.id}" title="Print Z-report">${icon('print', 15)}</button>
      </div>`
    }
  ];

  root.innerHTML = `
  <div class="page">
    ${pageHead({
      title: viewAll ? 'Cash & Shifts' : 'My Shift',
      subtitle: viewAll
        ? 'Every staff shift with its cash reconciliation. Differences are highlighted for follow-up.'
        : 'Open a shift before you start selling, then count the drawer when you finish.',
      actions: `
        ${can('export.data') ? `<button class="btn btn-secondary" type="button" id="btn-export">${icon('download', 16)} Export CSV</button>` : ''}
        ${myShift
          ? `<button class="btn btn-primary" type="button" id="btn-close-mine">${icon('cash', 16)} Close my shift</button>`
          : (can('shift.own') ? `<button class="btn btn-primary" type="button" id="btn-open">${icon('plus', 16)} Open shift</button>` : '')}`
    })}

    ${myShift ? `
      ${card({
        title: `Your open shift - ${myShift.ref}`,
        sub: `Opened ${fmtTime(myShift.openedAt)} (${fmtDuration(myShift.openedAt)} ago)`,
        actions: `<button class="btn btn-primary btn-sm" type="button" id="btn-close-mine-2">${icon('cash', 14)} Close shift</button>`,
        body: `
          <div class="kpi-grid">
            ${kpi({ label: 'Opening cash', value: money(myShift.openingCash), iconName: 'cash', small: true })}
            ${kpi({ label: 'Cash sales so far', value: money(mySummary.cashSales), iconName: 'wallet', tone: 'success', small: true })}
            ${kpi({ label: 'Expected in drawer', value: money(mySummary.expectedCash), iconName: 'percent', tone: 'info', small: true })}
            ${kpi({ label: 'Transactions', value: int(mySummary.transactions), iconName: 'receipt', foot: `<span>${money(mySummary.grossSales)} total sales</span>`, small: true })}
          </div>`
      })}` : (can('shift.own') ? `
      <div class="alert alert-warning">
        ${icon('alert', 17)}
        <div>
          <div class="alert-title">You have no open shift</div>
          <div class="small">Sales recorded without an open shift are not linked to a cash drawer,
          which makes end-of-day reconciliation impossible.</div>
        </div>
        <button class="btn btn-sm btn-warning-soft" style="margin-left:auto" type="button" id="btn-open-2">Open shift now</button>
      </div>` : '')}

    ${viewAll ? `
      <div class="kpi-grid">
        ${kpi({ label: 'Cash in drawers now', value: money(cashInDrawer()), iconName: 'cash', tone: 'warning', foot: `<span>${shifts().filter((s) => s.status === 'open').length} open shift(s)</span>`, small: true })}
        ${kpi({ label: 'Shifts today', value: int(todayShifts.length), iconName: 'clock', tone: 'info', small: true })}
        ${kpi({ label: 'Shifts with a difference', value: int(discrepancies.length), iconName: 'alert', tone: discrepancies.length ? 'danger' : '', foot: `<span>of ${closed.length} closed</span>`, small: true })}
        ${kpi({ label: 'Net cash variance', value: money(sum(closed, (s) => num(s.variance))), iconName: 'percent', tone: sum(closed, (s) => num(s.variance)) < 0 ? 'danger' : 'success', small: true })}
      </div>

      ${varianceSeries.length ? `
        <div class="grid-dash">
          <div class="span-12">
            ${card({
              title: 'Cash variance by shift',
              sub: 'Most recent closed shifts - bars below zero are shortages',
              body: barChart(varianceSeries, { formatter: money })
            })}
          </div>
        </div>` : ''}` : ''}

    <div class="toolbar">
      ${searchBox({ id: 'shift-search', value: state.query, placeholder: 'Search shift reference or note...' })}
      <div class="toolbar-group">
        ${viewAll ? `<select class="select filter-select" id="f-user" aria-label="Filter by staff">
          ${options(users().map((u) => ({ value: u.id, label: u.name })), state.userId, { placeholder: 'All staff' })}
        </select>` : ''}
        <select class="select filter-select" id="f-status" aria-label="Filter by status">
          ${options([{ value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }], state.status, { placeholder: 'All statuses' })}
        </select>
        ${(state.query || state.userId || state.status) ? '<button class="btn btn-ghost btn-sm" type="button" id="btn-clear">Clear</button>' : ''}
      </div>
    </div>

    ${card({
      title: viewAll ? 'Shift history' : 'My shift history',
      sub: `${rows.length} shift(s)`,
      flush: true,
      body: renderTable({
        columns,
        rows: pageData.rows,
        rowClass: (s) => {
          if (s.status === 'open') return 'row-warning';
          return num(s.variance) !== 0 ? 'row-danger' : '';
        },
        empty: emptyState({
          iconName: 'cash',
          title: 'No shifts recorded',
          message: can('shift.own')
            ? 'Open your first shift to start tracking the cash drawer.'
            : 'Staff shifts will appear here once they are opened.',
          actions: can('shift.own') && !myShift
            ? '<button class="btn btn-primary btn-sm" type="button" id="btn-open-3">Open shift</button>'
            : ''
        })
      }) + renderPagination(pageData, { label: 'shifts' })
    })}
  </div>`;

  /* ---------------------------- events ---------------------------- */

  const rerender = () => ctx.refresh();

  qsa('#btn-open, #btn-open-2, #btn-open-3', root).forEach((b) => b.addEventListener('click', openShiftModal));
  qsa('#btn-close-mine, #btn-close-mine-2', root).forEach((b) =>
    b.addEventListener('click', () => openCloseModal(myShift.id)));

  const search = qs('#shift-search', root);
  search.addEventListener('input', debounce(() => {
    state.query = search.value;
    state.page = 1;
    const caret = search.selectionStart;
    rerender();
    const next = qs('#shift-search');
    if (next) { next.focus(); next.setSelectionRange(caret, caret); }
  }, 260));

  const bind = (selector, key) => {
    const node = qs(selector, root);
    if (node) node.addEventListener('change', () => { state[key] = node.value; state.page = 1; rerender(); });
  };
  bind('#f-user', 'userId');
  bind('#f-status', 'status');

  const clearBtn = qs('#btn-clear', root);
  if (clearBtn) clearBtn.addEventListener('click', () => {
    Object.assign(state, { query: '', userId: '', status: '', page: 1 });
    rerender();
  });

  on(root, 'click', '[data-page]', (event, node) => {
    const page = num(node.getAttribute('data-page'));
    if (page >= 1 && page <= pageData.pages) { state.page = page; rerender(); }
  });

  on(root, 'click', '[data-open]', (event, node) => openShiftDrawer(node.getAttribute('data-open')));
  on(root, 'click', '[data-close]', (event, node) => {
    event.stopPropagation();
    openCloseModal(node.getAttribute('data-close'));
  });
  on(root, 'click', '[data-print]', (event, node) => {
    event.stopPropagation();
    printZReport(node.getAttribute('data-print'));
  });

  const exportBtn = qs('#btn-export', root);
  if (exportBtn) exportBtn.addEventListener('click', () => {
    downloadCsv(exportName('shifts'), rows, [
      { label: 'Shift', value: (s) => s.ref },
      { label: 'Cashier', value: (s) => s.userName },
      { label: 'Opened', value: (s) => fmtDateTime(s.openedAt) },
      { label: 'Closed', value: (s) => (s.closedAt ? fmtDateTime(s.closedAt) : '') },
      { label: 'Duration', value: (s) => (s.closedAt ? fmtDuration(s.openedAt, s.closedAt) : '') },
      { label: 'Opening cash', value: (s) => s.openingCash },
      { label: 'Transactions', value: (s) => shiftSummary(s).transactions },
      { label: 'Total sales', value: (s) => shiftSummary(s).grossSales },
      { label: 'Cash sales', value: (s) => shiftSummary(s).cashSales },
      { label: 'Cash refunds', value: (s) => shiftSummary(s).cashRefunds },
      { label: 'Expected cash', value: (s) => shiftSummary(s).expectedCash },
      { label: 'Counted cash', value: (s) => (s.status === 'closed' ? s.countedCash : '') },
      { label: 'Variance', value: (s) => (s.status === 'closed' ? s.variance : '') },
      { label: 'Status', value: (s) => s.status },
      { label: 'Closing note', value: (s) => s.closingNote || '' }
    ]);
    notifySuccess('Export ready', `${rows.length} shifts exported.`);
  });
}

export default { render };
