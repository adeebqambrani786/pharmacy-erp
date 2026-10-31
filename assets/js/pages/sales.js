/* ==========================================================================
   MediFlow Pharmacy ERP - Sales History
   Admin sees every transaction and may void with a mandatory reason; staff see
   only their own receipts and may reprint them or request a return (section 16).
   ========================================================================== */

import {
  salesFor, sale as findSale, voidSale, settings, users, customers, returnedQtyBySale,
  markReceiptPrinted
} from '../store.js';
import { can } from '../auth.js';
import {
  pageHead, card, kpi, icon, badge, renderTable, cellStack, renderPagination, emptyState,
  openDrawer, promptDialog, confirmDialog, notifySuccess, notifyError, notifyDenied, escapeHtml,
  searchBox, options, printNode, receiptHtml
} from '../ui.js';
import {
  money, int, num, fmtDate, fmtTime, fmtDateTime, sortBy, paginate, qs, on, debounce,
  downloadCsv, exportName, PAYMENT_METHODS, sum
} from '../utils.js';

const PER_PAGE = 15;

const state = {
  query: '',
  from: '',
  to: '',
  userId: '',
  method: '',
  customerId: '',
  status: '',
  page: 1,
  sortKey: 'datetime',
  sortDir: 'desc'
};

let ctxRef = null;

/* ============================== FILTERING ============================== */

function buildRows() {
  // Staff may only ever read their own transactions.
  const scopedUser = can('sales.view.all') ? state.userId : ctxRef.user.id;

  const rows = salesFor({
    userId: scopedUser || undefined,
    from: state.from || undefined,
    to: state.to || undefined,
    method: state.method || undefined,
    customerId: state.customerId || undefined,
    status: state.status || undefined,
    query: state.query || undefined
  });

  const selectors = {
    datetime: (s) => s.datetime,
    ref: (s) => s.ref,
    customerName: (s) => s.customerName,
    userName: (s) => s.userName,
    units: (s) => s.units,
    total: (s) => s.total,
    profit: (s) => s.profit
  };

  return sortBy(rows, selectors[state.sortKey] || selectors.datetime, state.sortDir);
}

/* ============================== RECEIPT ACTIONS ============================== */

function reprintReceipt(saleId) {
  if (!can('sales.reprint')) {
    notifyDenied({ message: 'Your account cannot reprint receipts.' });
    return;
  }
  const sale = findSale(saleId);
  if (!sale) return;

  // Staff can only reprint their own receipts.
  if (!can('sales.view.all') && sale.userId !== ctxRef.user.id) {
    notifyDenied({ message: 'You can only reprint receipts for your own sales.' });
    return;
  }

  const pharmacy = settings().pharmacy;
  printNode(receiptHtml(sale, { pharmacy, duplicate: true }), 'receipt');
  markReceiptPrinted(sale.id);
  notifySuccess('Receipt sent to printer', `${sale.ref} printed as a duplicate copy.`);
}

async function voidSaleFlow(saleId) {
  if (!can('sales.void')) {
    notifyDenied({ message: 'Only the pharmacy owner can void a sale.' });
    return;
  }
  const sale = findSale(saleId);
  if (!sale) return;

  const confirmed = await confirmDialog({
    title: `Void ${sale.ref}?`,
    message: `${money(sale.total)} will be reversed and ${int(sale.units)} unit(s) returned to their original batches.`,
    detail: sale.payment.creditAmount > 0
      ? `This was a credit sale - ${money(sale.payment.creditAmount)} will be removed from ${escapeHtml(sale.customerName)}'s balance.`
      : '',
    confirmLabel: 'Continue',
    tone: 'danger',
    iconName: 'alertCircle'
  });
  if (!confirmed) return;

  const reason = await promptDialog({
    title: 'Why is this sale being voided?',
    label: 'Void reason',
    placeholder: 'e.g. Wrong items dispensed, duplicate entry',
    multiline: true,
    required: true,
    confirmLabel: 'Void sale',
    tone: 'danger',
    hint: 'The reason is stored permanently against the transaction and the activity log.'
  });
  if (!reason) return;

  try {
    voidSale(saleId, ctxRef.user, reason);
    notifySuccess('Sale voided', `${sale.ref} has been reversed and stock restored.`);
    ctxRef.refresh();
  } catch (error) {
    notifyError('Could not void this sale', error.message);
  }
}

/* ============================== DETAIL DRAWER ============================== */

function openSaleDrawer(saleId) {
  const sale = findSale(saleId);
  if (!sale) return;

  const showCost = can('inventory.cost');
  const alreadyReturned = returnedQtyBySale(sale.id);
  const returnedUnits = sum(Object.values(alreadyReturned), (v) => v);

  const itemRows = renderTable({
    compact: true,
    responsive: false,
    columns: [
      { key: 'name', label: 'Medicine', cell: (l, i) => cellStack(l.name, `Batch ${l.batchNo} - exp ${fmtDate(l.expiry)}${num(alreadyReturned[i]) ? ` - ${alreadyReturned[i]} returned` : ''}`) },
      { key: 'qty', label: 'Qty', className: 'num', cell: (l) => int(l.qty) },
      { key: 'unitPrice', label: 'Unit', className: 'num', cell: (l) => money(l.unitPrice) },
      { key: 'discount', label: 'Disc.', className: 'num', cell: (l) => (num(l.discount) ? `-${money(l.discount)}` : '-') },
      ...(showCost ? [{ key: 'cost', label: 'Cost', className: 'num', cell: (l) => money(l.cost) }] : []),
      { key: 'total', label: 'Total', className: 'num', cell: (l) => `<strong>${money(l.total)}</strong>` }
    ],
    rows: sale.items
  });

  const canRequestReturn = can('returns.request')
    && sale.status === 'completed'
    && returnedUnits < sale.units
    && (can('sales.view.all') || sale.userId === ctxRef.user.id);

  const drawer = openDrawer({
    title: sale.ref,
    subtitle: `${fmtDateTime(sale.datetime)} - ${sale.userName}`,
    size: 'drawer-lg',
    body: `
      <div class="stack-lg">
        <div class="row-wrap">
          ${sale.status === 'voided'
            ? badge('Voided', 'danger', { dot: true })
            : badge('Completed', 'success', { dot: true })}
          ${badge(sale.payment.method, sale.payment.method === 'Credit' ? 'warning' : 'neutral')}
          ${sale.prescription ? badge('Prescription recorded', 'info') : ''}
          ${returnedUnits ? badge(`${int(returnedUnits)} unit(s) returned`, 'warning') : ''}
          ${num(sale.printCount) > 1 ? badge(`Printed ${num(sale.printCount)}x`, 'neutral') : ''}
        </div>

        ${sale.status === 'voided' ? `
          <div class="alert alert-danger">
            ${icon('alertCircle', 17)}
            <div>
              <div class="alert-title">Voided ${fmtDateTime(sale.voidedAt)} by ${escapeHtml(sale.voidedBy)}</div>
              <div class="small">${escapeHtml(sale.voidReason)}</div>
            </div>
          </div>` : ''}

        <div class="def-grid">
          <div class="def-item"><div class="def-label">Customer</div><div class="def-value">${escapeHtml(sale.customerName)}</div></div>
          <div class="def-item"><div class="def-label">Cashier</div><div class="def-value">${escapeHtml(sale.userName)}</div></div>
          <div class="def-item"><div class="def-label">Date</div><div class="def-value">${fmtDate(sale.datetime)}</div></div>
          <div class="def-item"><div class="def-label">Time</div><div class="def-value">${fmtTime(sale.datetime)}</div></div>
          <div class="def-item"><div class="def-label">Items</div><div class="def-value num">${int(sale.units)} units / ${sale.items.length} lines</div></div>
          ${sale.shiftId ? '<div class="def-item"><div class="def-label">Shift</div><div class="def-value">Linked to cash drawer</div></div>' : ''}
        </div>

        ${sale.prescription ? `
          <div class="alert alert-info">
            ${icon('clipboard', 17)}
            <div>
              <div class="alert-title">Prescription</div>
              <div class="small">Prescriber: ${escapeHtml(sale.prescription.doctor)}
              ${sale.prescription.reference ? ` - Ref ${escapeHtml(sale.prescription.reference)}` : ''}</div>
            </div>
          </div>` : ''}

        <section>
          <h3 class="mb-3">Items dispensed</h3>
          ${itemRows}
        </section>

        <section>
          <h3 class="mb-3">Payment</h3>
          <div class="stack-sm" style="gap:2px">
            <div class="stat-line"><span class="sl-label">Subtotal</span><span class="sl-value">${money(sale.subtotal)}</span></div>
            ${num(sale.discount) ? `<div class="stat-line"><span class="sl-label">Discount</span><span class="sl-value c-success">-${money(sale.discount)}</span></div>` : ''}
            <div class="stat-line is-total"><span class="sl-label">Total</span><span class="sl-value">${money(sale.total)}</span></div>
            <div class="stat-line"><span class="sl-label">Method</span><span class="sl-value">${escapeHtml(sale.payment.method)}</span></div>
            ${sale.payment.method === 'Cash' ? `
              <div class="stat-line"><span class="sl-label">Cash received</span><span class="sl-value">${money(sale.payment.cashReceived)}</span></div>
              <div class="stat-line"><span class="sl-label">Change given</span><span class="sl-value">${money(sale.payment.change)}</span></div>` : ''}
            ${num(sale.payment.creditAmount) ? `<div class="stat-line"><span class="sl-label">On account</span><span class="sl-value c-warning">${money(sale.payment.creditAmount)}</span></div>` : ''}
            ${sale.payment.reference ? `<div class="stat-line"><span class="sl-label">Reference</span><span class="sl-value mono">${escapeHtml(sale.payment.reference)}</span></div>` : ''}
            ${showCost ? `
              <div class="stat-line"><span class="sl-label">Cost of goods</span><span class="sl-value">${money(sale.cost)}</span></div>
              <div class="stat-line"><span class="sl-label">Gross profit</span><span class="sl-value c-success">${money(sale.profit)}</span></div>` : ''}
          </div>
        </section>
      </div>`,
    footer: `
      ${can('sales.reprint') ? `<button class="btn btn-secondary" type="button" data-reprint="${sale.id}">${icon('print', 15)} Reprint</button>` : ''}
      ${canRequestReturn ? `<button class="btn btn-secondary" type="button" data-return="${sale.id}">${icon('returnArrow', 15)} Request return</button>` : ''}
      ${can('sales.void') && sale.status === 'completed' ? `<button class="btn btn-danger" type="button" data-void="${sale.id}">${icon('close', 15)} Void sale</button>` : ''}`
  });

  drawer.root.addEventListener('click', (event) => {
    const reprint = event.target.closest('[data-reprint]');
    if (reprint) { reprintReceipt(reprint.getAttribute('data-reprint')); return; }

    const returnBtn = event.target.closest('[data-return]');
    if (returnBtn) { drawer.close(); ctxRef.navigate(`/returns?sale=${sale.id}`); return; }

    const voidBtn = event.target.closest('[data-void]');
    if (voidBtn) { drawer.close(); voidSaleFlow(voidBtn.getAttribute('data-void')); }
  });
}

/* ============================== EXPORT ============================== */

function exportCsv(rows) {
  if (!can('export.data')) {
    notifyDenied({ message: 'Your account cannot export data.' });
    return;
  }
  const showCost = can('inventory.cost');
  downloadCsv(exportName('sales'), rows, [
    { label: 'Receipt', value: (s) => s.ref },
    { label: 'Date', value: (s) => fmtDate(s.datetime) },
    { label: 'Time', value: (s) => fmtTime(s.datetime) },
    { label: 'Cashier', value: (s) => s.userName },
    { label: 'Customer', value: (s) => s.customerName },
    { label: 'Lines', value: (s) => s.items.length },
    { label: 'Units', value: (s) => s.units },
    { label: 'Subtotal', value: (s) => s.subtotal },
    { label: 'Discount', value: (s) => s.discount },
    { label: 'Total', value: (s) => s.total },
    ...(showCost ? [
      { label: 'Cost of goods', value: (s) => s.cost },
      { label: 'Gross profit', value: (s) => s.profit }
    ] : []),
    { label: 'Payment method', value: (s) => s.payment.method },
    { label: 'Credit amount', value: (s) => s.payment.creditAmount },
    { label: 'Status', value: (s) => s.status },
    { label: 'Void reason', value: (s) => s.voidReason || '' }
  ]);
  notifySuccess('Export ready', `${rows.length} sales exported to CSV.`);
}

/* ============================== RENDER ============================== */

export function render(root, ctx) {
  ctxRef = ctx;

  const viewAll = can('sales.view.all');
  const showCost = can('inventory.cost');
  const allRows = buildRows();
  const pageData = paginate(allRows, state.page, PER_PAGE);

  const totals = {
    count: allRows.filter((s) => s.status === 'completed').length,
    voided: allRows.filter((s) => s.status === 'voided').length,
    revenue: sum(allRows.filter((s) => s.status === 'completed'), (s) => s.total),
    units: sum(allRows.filter((s) => s.status === 'completed'), (s) => s.units),
    profit: sum(allRows.filter((s) => s.status === 'completed'), (s) => s.profit)
  };

  const columns = [
    {
      key: 'ref', label: 'Receipt', sortable: true,
      cell: (s) => cellStack(s.ref, `${fmtDate(s.datetime)} ${fmtTime(s.datetime)}`)
    },
    { key: 'customerName', label: 'Customer', sortable: true, cell: (s) => escapeHtml(s.customerName) },
    ...(viewAll ? [{ key: 'userName', label: 'Cashier', sortable: true, cell: (s) => escapeHtml(s.userName) }] : []),
    {
      key: 'units', label: 'Items', className: 'num', sortable: true,
      cell: (s) => `${int(s.units)}<div class="cell-sub">${s.items.length} line(s)</div>`
    },
    { key: 'method', label: 'Payment', cell: (s) => badge(s.payment.method, s.payment.method === 'Credit' ? 'warning' : 'neutral') },
    { key: 'total', label: 'Total', className: 'num', sortable: true, cell: (s) => `<strong>${money(s.total)}</strong>` },
    ...(showCost ? [{ key: 'profit', label: 'Profit', className: 'num', sortable: true, cell: (s) => `<span class="${s.profit >= 0 ? 'c-success' : 'c-danger'}">${money(s.profit)}</span>` }] : []),
    {
      key: 'status', label: 'Status',
      cell: (s) => (s.status === 'voided'
        ? badge('Voided', 'danger', { dot: true })
        : badge('Completed', 'success', { dot: true }))
    },
    {
      key: 'actions', label: '', className: 'right',
      cell: (s) => `<div class="table-actions">
        <button class="btn btn-ghost btn-sm" type="button" data-open="${s.id}" title="View details">${icon('eye', 15)}</button>
        ${can('sales.reprint') ? `<button class="btn btn-ghost btn-sm" type="button" data-reprint="${s.id}" title="Reprint receipt">${icon('print', 15)}</button>` : ''}
        ${can('sales.void') && s.status === 'completed' ? `<button class="btn btn-ghost btn-sm" type="button" data-void="${s.id}" title="Void sale">${icon('close', 15)}</button>` : ''}
      </div>`
    }
  ];

  const staffOptions = users().map((u) => ({ value: u.id, label: u.name }));
  const customerOptions = sortBy(customers(), (c) => c.name, 'asc').map((c) => ({ value: c.id, label: c.name }));

  root.innerHTML = `
  <div class="page">
    ${pageHead({
      title: viewAll ? 'Sales History' : 'My Sales',
      subtitle: viewAll
        ? 'Every transaction with its cashier, batch detail and payment record'
        : 'Your own transactions. Reprint receipts or request a return from any receipt.',
      actions: `
        ${can('export.data') ? `<button class="btn btn-secondary" type="button" id="btn-export">${icon('download', 16)} Export CSV</button>` : ''}
        <button class="btn btn-primary" type="button" data-route="#/pos">${icon('pos', 16)} New sale</button>`
    })}

    <div class="kpi-grid">
      ${kpi({ label: 'Transactions', value: int(totals.count), iconName: 'receipt', foot: totals.voided ? `<span class="c-danger">${int(totals.voided)} voided</span>` : '<span>None voided</span>', small: true })}
      ${kpi({ label: 'Revenue', value: money(totals.revenue), iconName: 'wallet', tone: 'success', small: true })}
      ${kpi({ label: 'Units dispensed', value: int(totals.units), iconName: 'pill', tone: 'info', small: true })}
      ${showCost
        ? kpi({ label: 'Gross profit', value: money(totals.profit), iconName: 'trending', tone: 'success', small: true })
        : kpi({ label: 'Average sale', value: money(totals.count ? totals.revenue / totals.count : 0), iconName: 'chart', small: true })}
    </div>

    <div class="toolbar">
      ${searchBox({ id: 'sales-search', value: state.query, placeholder: 'Search receipt, customer or medicine...' })}
      <div class="toolbar-group">
        <input class="input filter-select" id="f-from" type="date" value="${state.from}" aria-label="From date" title="From date">
        <input class="input filter-select" id="f-to" type="date" value="${state.to}" aria-label="To date" title="To date">
        ${viewAll ? `<select class="select filter-select" id="f-user" aria-label="Filter by staff">
          ${options(staffOptions, state.userId, { placeholder: 'All staff' })}
        </select>` : ''}
        <select class="select filter-select" id="f-method" aria-label="Filter by payment method">
          ${options(PAYMENT_METHODS, state.method, { placeholder: 'All payments' })}
        </select>
        <select class="select filter-select" id="f-customer" aria-label="Filter by customer">
          ${options(customerOptions, state.customerId, { placeholder: 'All customers' })}
        </select>
        <select class="select filter-select" id="f-status" aria-label="Filter by status">
          ${options([{ value: 'completed', label: 'Completed' }, { value: 'voided', label: 'Voided' }], state.status, { placeholder: 'All statuses' })}
        </select>
        ${(state.query || state.from || state.to || state.userId || state.method || state.customerId || state.status)
          ? '<button class="btn btn-ghost btn-sm" type="button" id="btn-clear">Clear</button>' : ''}
      </div>
    </div>

    ${card({
      flush: true,
      body: renderTable({
        columns,
        rows: pageData.rows,
        sort: { key: state.sortKey, dir: state.sortDir },
        rowClass: (s) => (s.status === 'voided' ? 'row-danger' : ''),
        empty: emptyState({
          iconName: 'receipt',
          title: 'No sales match these filters',
          message: viewAll
            ? 'Adjust the date range or clear the filters.'
            : 'Sales you record at the point of sale will be listed here.',
          actions: '<button class="btn btn-primary btn-sm" type="button" data-route="#/pos">Open point of sale</button>'
        })
      }) + renderPagination(pageData, { label: 'sales' })
    })}
  </div>`;

  /* ---------------------------- events ---------------------------- */

  const rerender = () => ctx.refresh();

  const search = qs('#sales-search', root);
  search.addEventListener('input', debounce(() => {
    state.query = search.value;
    state.page = 1;
    const caret = search.selectionStart;
    rerender();
    const next = qs('#sales-search');
    if (next) { next.focus(); next.setSelectionRange(caret, caret); }
  }, 260));

  const bind = (selector, key) => {
    const node = qs(selector, root);
    if (node) node.addEventListener('change', () => { state[key] = node.value; state.page = 1; rerender(); });
  };
  bind('#f-from', 'from');
  bind('#f-to', 'to');
  bind('#f-user', 'userId');
  bind('#f-method', 'method');
  bind('#f-customer', 'customerId');
  bind('#f-status', 'status');

  const clearBtn = qs('#btn-clear', root);
  if (clearBtn) clearBtn.addEventListener('click', () => {
    Object.assign(state, { query: '', from: '', to: '', userId: '', method: '', customerId: '', status: '', page: 1 });
    rerender();
  });

  on(root, 'click', '[data-sort]', (event, node) => {
    const key = node.getAttribute('data-sort');
    if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    else { state.sortKey = key; state.sortDir = key === 'datetime' || key === 'ref' ? 'desc' : 'asc'; }
    rerender();
  });

  on(root, 'click', '[data-page]', (event, node) => {
    const page = num(node.getAttribute('data-page'));
    if (page >= 1 && page <= pageData.pages) { state.page = page; rerender(); }
  });

  on(root, 'click', '[data-open]', (event, node) => openSaleDrawer(node.getAttribute('data-open')));
  on(root, 'click', '[data-reprint]', (event, node) => {
    event.stopPropagation();
    reprintReceipt(node.getAttribute('data-reprint'));
  });
  on(root, 'click', '[data-void]', (event, node) => {
    event.stopPropagation();
    voidSaleFlow(node.getAttribute('data-void'));
  });

  const exportBtn = qs('#btn-export', root);
  if (exportBtn) exportBtn.addEventListener('click', () => exportCsv(allRows));

  // Deep link from the dashboard / returns module
  if (ctx.query.sale) {
    openSaleDrawer(ctx.query.sale);
    ctx.navigate('/sales');
  }
}

export default { render };
