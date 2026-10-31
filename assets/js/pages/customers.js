/* ==========================================================================
   MediFlow Pharmacy ERP - Customers & Credit
   Staff may view and add customers; only the owner edits credit limits, records
   payments and reads the ledger (sections 19, 3).
   ========================================================================== */

import {
  customers, customer, createCustomer, updateCustomer, creditAvailable,
  recordCreditPayment, customerLedger, salesFor, db, creditAging, settings
} from '../store.js';
import { can, requirePermission } from '../auth.js';
import {
  pageHead, card, kpi, icon, badge, renderTable, cellStack, renderPagination, emptyState,
  openModal, openDrawer, modalFooter, notifySuccess, notifyError, notifyDenied, escapeHtml,
  field, selectField, options, searchBox, printNode, printHeader, printFooter, donutChart,
  rankChart
} from '../ui.js';
import {
  money, int, num, round, fmtDate, fmtDateTime, fmtRelative, sortBy, paginate, qs, qsa, on,
  debounce, matchesQuery, sum, formData, validate, rule, showFormErrors, downloadCsv,
  exportName, initials
} from '../utils.js';

const PER_PAGE = 12;

const state = { query: '', filter: '', page: 1, sortKey: 'name', sortDir: 'asc' };

let ctxRef = null;

/* ============================== ROWS ============================== */

function buildRows() {
  let rows = customers().map((c) => ({
    customer: c,
    available: creditAvailable(c.id),
    purchases: db.sales.filter((s) => s.customerId === c.id && s.status === 'completed').length,
    lastPurchase: c.lastPurchaseAt || null
  }));

  if (state.query) {
    rows = rows.filter(({ customer: c }) => matchesQuery(`${c.name} ${c.phone} ${c.address} ${c.note}`, state.query));
  }
  if (state.filter === 'credit') rows = rows.filter(({ customer: c }) => num(c.balance) > 0);
  if (state.filter === 'overlimit') rows = rows.filter(({ customer: c }) => num(c.balance) >= num(c.creditLimit) && num(c.creditLimit) > 0);
  if (state.filter === 'inactive') rows = rows.filter(({ customer: c }) => !c.active);
  if (state.filter === 'active') rows = rows.filter(({ customer: c }) => c.active);

  const selectors = {
    name: (r) => r.customer.name,
    balance: (r) => num(r.customer.balance),
    limit: (r) => num(r.customer.creditLimit),
    purchases: (r) => num(r.customer.totalPurchases),
    last: (r) => r.lastPurchase || ''
  };

  return sortBy(rows, selectors[state.sortKey] || selectors.name, state.sortDir);
}

/* ============================== CUSTOMER FORM ============================== */

function openCustomerModal(existing = null) {
  const editing = !!existing;
  const permission = editing ? 'customers.manage' : 'customers.create';
  try {
    requirePermission(permission);
  } catch (error) {
    notifyDenied(error);
    return;
  }

  const canSetLimit = can('customers.manage');

  const modal = openModal({
    title: editing ? `Edit ${existing.name}` : 'Add a customer',
    subtitle: editing ? `Customer since ${fmtDate(existing.createdAt)}` : 'Register a customer for credit sales and purchase history',
    size: 'modal-lg',
    iconName: 'users',
    body: `
      <form id="cust-form" class="stack-lg" novalidate>
        <div class="grid-2">
          ${field({ name: 'name', label: 'Full name / organisation', value: existing ? existing.name : '', required: true, attrs: 'autofocus' })}
          ${field({ name: 'phone', label: 'Phone number', value: existing ? existing.phone : '', attrs: 'inputmode="tel" placeholder="08030000000"' })}
          ${field({ name: 'address', label: 'Address', value: existing ? existing.address : '', className: 'col-span-2', type: 'textarea', attrs: 'rows="2"' })}
          ${canSetLimit
            ? field({
                name: 'creditLimit', label: 'Credit limit', type: 'number',
                value: existing ? num(existing.creditLimit) : num(settings().sales.defaultCreditLimit),
                attrs: 'min="0" step="500"',
                hint: 'Set to 0 to block credit sales for this customer'
              })
            : `<div class="field"><label class="label">Credit limit</label>
                <input class="input" value="${money(existing ? existing.creditLimit : settings().sales.defaultCreditLimit)}" readonly>
                <p class="field-hint">Only the pharmacy owner can change credit limits.</p></div>`}
          ${field({ name: 'note', label: 'Note', value: existing ? existing.note : '', attrs: 'placeholder="e.g. Institutional account"' })}
        </div>

        ${editing && canSetLimit ? `
          <label class="check">
            <input type="checkbox" name="active" ${existing.active ? 'checked' : ''}>
            <span class="check-text">Account active
              <small>Inactive accounts cannot be used for new sales</small></span>
          </label>` : ''}

        ${editing && num(existing.balance) > 0 ? `
          <div class="alert alert-warning small">
            ${icon('alert', 15)}
            <div>This customer owes <strong>${money(existing.balance)}</strong>.
            Lowering the limit below the balance blocks further credit but keeps the debt.</div>
          </div>` : ''}
      </form>`,
    footer: modalFooter({ confirmLabel: editing ? 'Save changes' : 'Add customer' })
  });

  const form = qs('#cust-form', modal.root);

  const submit = () => {
    const data = formData(form);
    const { valid, errors } = validate(data, {
      name: [rule.required('Enter the customer name'), rule.minLen(2)],
      phone: [rule.phone()],
      creditLimit: canSetLimit ? [rule.minZero('Credit limit cannot be negative')] : []
    });

    // Duplicate phone check keeps the customer list clean.
    if (data.phone) {
      const clash = customers().find((c) =>
        c.phone && c.phone.replace(/\s/g, '') === String(data.phone).replace(/\s/g, '')
        && (!editing || c.id !== existing.id));
      if (clash) errors.phone = `That number already belongs to ${clash.name}.`;
    }

    if (!valid || Object.keys(errors).length) { showFormErrors(form, errors); return; }

    try {
      if (editing) {
        updateCustomer(existing.id, data, ctxRef.user);
        notifySuccess('Customer updated', `${data.name} has been saved.`);
      } else {
        const created = createCustomer(data, ctxRef.user);
        notifySuccess('Customer added', `${created.name} can now be selected at the point of sale.`);
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

/* ============================== CREDIT PAYMENT ============================== */

function openPaymentModal(customerId) {
  try {
    requirePermission('customers.manage');
  } catch (error) {
    notifyDenied(error);
    return;
  }

  const row = customer(customerId);
  if (!row) return;
  if (num(row.balance) <= 0) {
    notifySuccess('Nothing outstanding', `${row.name} has no balance to settle.`);
    return;
  }

  const modal = openModal({
    title: 'Record a credit payment',
    subtitle: `${row.name} owes ${money(row.balance)}`,
    size: 'modal-sm',
    iconName: 'cash',
    tone: 'success',
    body: `
      <form id="pay-form" class="stack-lg" novalidate>
        <div class="card card-pad">
          <div class="stat-line"><span class="sl-label">Outstanding balance</span><span class="sl-value">${money(row.balance)}</span></div>
          <div class="stat-line"><span class="sl-label">Credit limit</span><span class="sl-value">${money(row.creditLimit)}</span></div>
        </div>
        ${field({
          name: 'amount', label: 'Amount received', type: 'number', required: true,
          value: num(row.balance), attrs: `min="0.01" max="${num(row.balance)}" step="0.01" autofocus`
        })}
        ${selectField({
          name: 'method', label: 'Payment method', required: true,
          list: ['Cash', 'POS/Card', 'Bank Transfer'], value: 'Cash'
        })}
        <div class="field">
          <label class="label" for="pay-note">Note</label>
          <input class="input" id="pay-note" name="note" placeholder="Teller number, reference..." autocomplete="off">
        </div>
        <div class="card card-pad">
          <div class="stat-line is-total">
            <span class="sl-label">Balance after payment</span>
            <span class="sl-value" id="pay-after">${money(0)}</span>
          </div>
        </div>
      </form>`,
    footer: modalFooter({ confirmLabel: 'Record payment', tone: 'success' })
  });

  const form = qs('#pay-form', modal.root);
  const amountInput = form.elements.amount;

  const recalc = () => {
    const after = round(num(row.balance) - num(amountInput.value), 2);
    qs('#pay-after', modal.root).textContent = money(Math.max(0, after));
  };
  form.addEventListener('input', recalc);
  recalc();

  const submit = () => {
    const data = formData(form);
    const amount = round(num(data.amount), 2);
    if (amount <= 0) { showFormErrors(form, { amount: 'Enter an amount greater than zero.' }); return; }
    if (amount > num(row.balance)) {
      showFormErrors(form, { amount: `Cannot exceed the outstanding balance of ${money(row.balance)}.` });
      return;
    }
    try {
      const record = recordCreditPayment({
        customerId: row.id,
        amount,
        method: data.method,
        note: data.note,
        user: ctxRef.user
      });
      modal.close();
      notifySuccess('Payment recorded', `${record.ref}: ${money(amount)} received, balance now ${money(record.balanceAfter)}.`);
      ctxRef.refresh();
    } catch (error) {
      notifyError('Could not record the payment', error.message);
    }
  };

  form.addEventListener('submit', (event) => { event.preventDefault(); submit(); });
  qs('#modal-confirm', modal.root).addEventListener('click', (event) => { event.preventDefault(); submit(); });
}

/* ============================== CUSTOMER DETAIL ============================== */

function openCustomerDrawer(customerId) {
  const row = customer(customerId);
  if (!row) return;

  const isAdmin = can('customers.manage');
  const sales = sortBy(
    salesFor({ customerId: row.id }).filter((s) => s.status === 'completed'),
    (s) => s.datetime, 'desc'
  );
  const ledger = isAdmin ? customerLedger(row.id) : [];
  const payments = db.creditPayments.filter((p) => p.customerId === row.id);
  const available = creditAvailable(row.id);

  openDrawer({
    title: row.name,
    subtitle: `${row.phone || 'No phone'} - customer since ${fmtDate(row.createdAt)}`,
    size: 'drawer-lg',
    body: `
      <div class="stack-lg">
        <div class="row-wrap">
          ${row.active ? badge('Active', 'success', { dot: true }) : badge('Inactive', 'danger', { dot: true })}
          ${num(row.balance) > 0 ? badge(`Owes ${money(row.balance)}`, 'warning') : badge('No outstanding balance', 'neutral')}
          ${num(row.creditLimit) === 0 ? badge('Cash only', 'neutral') : badge(`Limit ${money(row.creditLimit)}`, 'info')}
        </div>

        <div class="kpi-grid">
          ${kpi({ label: 'Total purchases', value: money(row.totalPurchases), iconName: 'shoppingBag', tone: 'success', foot: `<span>${sales.length} completed sale(s)</span>`, small: true })}
          ${kpi({ label: 'Outstanding credit', value: money(row.balance), iconName: 'wallet', tone: num(row.balance) > 0 ? 'warning' : '', small: true })}
          ${kpi({ label: 'Credit available', value: money(available), iconName: 'percent', tone: available > 0 ? 'info' : 'danger', small: true })}
        </div>

        ${num(row.creditLimit) > 0 ? `
          <div>
            <div class="row-sm" style="justify-content:space-between">
              <span class="small muted">Credit used</span>
              <span class="small semibold">${money(row.balance)} of ${money(row.creditLimit)}</span>
            </div>
            <div class="bar-meter mt-1">
              <i class="${num(row.balance) / num(row.creditLimit) > 0.85 ? 'tone-danger' : (num(row.balance) / num(row.creditLimit) > 0.6 ? 'tone-warning' : '')}"
                 style="width:${Math.min(100, round((num(row.balance) / num(row.creditLimit)) * 100, 1))}%"></i>
            </div>
          </div>` : ''}

        <div class="def-grid">
          <div class="def-item"><div class="def-label">Phone</div><div class="def-value">${escapeHtml(row.phone || '-')}</div></div>
          <div class="def-item"><div class="def-label">Address</div><div class="def-value">${escapeHtml(row.address || '-')}</div></div>
          <div class="def-item"><div class="def-label">Last purchase</div><div class="def-value">${row.lastPurchaseAt ? fmtDateTime(row.lastPurchaseAt) : 'Never'}</div></div>
          <div class="def-item"><div class="def-label">Registered by</div><div class="def-value">${escapeHtml((db.users.find((u) => u.id === row.createdBy) || {}).name || 'System')}</div></div>
          ${row.note ? `<div class="def-item"><div class="def-label">Note</div><div class="def-value">${escapeHtml(row.note)}</div></div>` : ''}
        </div>

        ${isAdmin ? `
          <section>
            <h3 class="mb-3">Credit ledger</h3>
            ${ledger.length ? renderTable({
              compact: true,
              responsive: false,
              columns: [
                { key: 'datetime', label: 'Date', cell: (r) => fmtDate(r.datetime) },
                { key: 'type', label: 'Entry', cell: (r) => escapeHtml(r.type) },
                { key: 'ref', label: 'Reference', cell: (r) => `<span class="mono small">${escapeHtml(r.ref)}</span>` },
                { key: 'debit', label: 'Credit taken', className: 'num', cell: (r) => (r.debit ? money(r.debit) : '-') },
                { key: 'credit', label: 'Paid', className: 'num', cell: (r) => (r.credit ? `<span class="c-success">${money(r.credit)}</span>` : '-') },
                { key: 'balance', label: 'Balance', className: 'num', cell: (r) => `<strong>${money(r.balance)}</strong>` }
              ],
              rows: ledger
            }) : emptyState({ iconName: 'wallet', title: 'No credit activity' })}
          </section>` : ''}

        <section>
          <h3 class="mb-3">Purchase history (${sales.length})</h3>
          ${sales.length ? renderTable({
            compact: true,
            responsive: false,
            columns: [
              { key: 'ref', label: 'Receipt', cell: (s) => cellStack(s.ref, fmtDate(s.datetime)) },
              { key: 'units', label: 'Units', className: 'num', cell: (s) => int(s.units) },
              { key: 'method', label: 'Payment', cell: (s) => badge(s.payment.method, s.payment.method === 'Credit' ? 'warning' : 'neutral') },
              { key: 'total', label: 'Total', className: 'num', cell: (s) => `<strong>${money(s.total)}</strong>` }
            ],
            rows: sales.slice(0, 20)
          }) : emptyState({ iconName: 'shoppingBag', title: 'No purchases yet' })}
        </section>

        ${isAdmin && payments.length ? `
          <section>
            <h3 class="mb-3">Payments received (${payments.length})</h3>
            <div class="list">${payments.map((p) => `
              <div class="list-row">
                <span class="list-avatar tone-success">${icon('cash', 15)}</span>
                <span class="list-main">
                  <span class="list-title">${money(p.amount)} · ${escapeHtml(p.method)}</span>
                  <span class="list-sub">${escapeHtml(p.ref)} · ${fmtDateTime(p.datetime)} · by ${escapeHtml(p.userName)}
                    ${p.note ? ` · ${escapeHtml(p.note)}` : ''}</span>
                </span>
                <span class="list-end"><span class="small muted">Balance ${money(p.balanceAfter)}</span></span>
              </div>`).join('')}</div>
          </section>` : ''}
      </div>`,
    footer: `
      ${isAdmin && num(row.balance) > 0 ? `<button class="btn btn-success" type="button" data-pay="${row.id}">${icon('cash', 15)} Record payment</button>` : ''}
      ${isAdmin ? `<button class="btn btn-secondary" type="button" data-statement="${row.id}">${icon('print', 15)} Statement</button>` : ''}
      ${isAdmin ? `<button class="btn btn-secondary" type="button" data-edit="${row.id}">${icon('edit', 15)} Edit</button>` : ''}
      ${can('pos.use') && row.active ? `<button class="btn btn-primary" type="button" data-sell="${row.id}">${icon('pos', 15)} New sale</button>` : ''}`,
    onMount: (api) => {
      api.root.addEventListener('click', (event) => {
        const pay = event.target.closest('[data-pay]');
        if (pay) { api.close(); openPaymentModal(pay.getAttribute('data-pay')); return; }
        const edit = event.target.closest('[data-edit]');
        if (edit) { api.close(); openCustomerModal(customer(edit.getAttribute('data-edit'))); return; }
        const statement = event.target.closest('[data-statement]');
        if (statement) { printStatement(statement.getAttribute('data-statement')); return; }
        const sell = event.target.closest('[data-sell]');
        if (sell) { api.close(); ctxRef.navigate('/pos'); }
      });
    }
  });
}

function printStatement(customerId) {
  const row = customer(customerId);
  if (!row) return;
  const pharmacy = settings().pharmacy;
  const ledger = customerLedger(row.id);

  printNode(`
    <div class="print-doc">
      ${printHeader({
        pharmacy,
        title: 'Customer Statement',
        subtitle: row.name,
        meta: `Generated ${fmtDateTime(new Date())}<br>
               Phone: ${escapeHtml(row.phone || '-')}<br>
               Credit limit: ${money(row.creditLimit)}`
      })}
      <div class="print-kpis">
        <div class="print-kpi"><div class="pk-label">Total purchases</div><div class="pk-value">${money(row.totalPurchases)}</div></div>
        <div class="print-kpi"><div class="pk-label">Outstanding balance</div><div class="pk-value">${money(row.balance)}</div></div>
        <div class="print-kpi"><div class="pk-label">Credit available</div><div class="pk-value">${money(creditAvailable(row.id))}</div></div>
        <div class="print-kpi"><div class="pk-label">Account status</div><div class="pk-value">${row.active ? 'Active' : 'Inactive'}</div></div>
      </div>

      <h2 class="print-section">Credit ledger</h2>
      <table>
        <thead><tr><th>Date</th><th>Entry</th><th>Reference</th>
          <th class="num">Credit taken</th><th class="num">Paid</th><th class="num">Balance</th></tr></thead>
        <tbody>${[...ledger].reverse().map((r) => `<tr>
          <td>${fmtDate(r.datetime)}</td>
          <td>${escapeHtml(r.type)}</td>
          <td>${escapeHtml(r.ref)}</td>
          <td class="num">${r.debit ? money(r.debit) : '-'}</td>
          <td class="num">${r.credit ? money(r.credit) : '-'}</td>
          <td class="num">${money(r.balance)}</td>
        </tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="5">Balance due</td><td class="num">${money(row.balance)}</td></tr></tfoot>
      </table>
      ${printFooter({ left: `${escapeHtml(pharmacy.name)} - customer copy`, right: 'MediFlow Pharmacy ERP' })}
    </div>`, 'report');
}

/* ============================== RENDER ============================== */

export function render(root, ctx) {
  ctxRef = ctx;

  if (ctx.query.filter && ctx.query.filter !== state.filter) {
    state.filter = ctx.query.filter;
    state.page = 1;
  }

  const isAdmin = can('customers.manage');
  const allRows = buildRows();
  const pageData = paginate(allRows, state.page, PER_PAGE);

  const totals = {
    count: customers().length,
    active: customers().filter((c) => c.active).length,
    owing: customers().filter((c) => num(c.balance) > 0),
    outstanding: sum(customers(), (c) => Math.max(0, num(c.balance))),
    purchases: sum(customers(), (c) => num(c.totalPurchases))
  };

  const aging = creditAging();
  const agingBuckets = ['1-30', '31-60', '61-90', '90+'].map((bucket) => ({
    label: `${bucket} days`,
    value: sum(aging.filter((a) => a.bucket === bucket), (a) => a.balance)
  })).filter((b) => b.value > 0);

  const topDebtors = sortBy(totals.owing, (c) => num(c.balance), 'desc').slice(0, 5);

  const columns = [
    {
      key: 'name', label: 'Customer', sortable: true,
      cell: ({ customer: c }) => `<button class="btn-ghost" type="button" data-open="${c.id}" style="text-align:left;display:block;width:100%">
        <span class="row-sm">
          <span class="list-avatar" style="width:30px;height:30px;font-size:11px">${escapeHtml(initials(c.name))}</span>
          <span>${cellStack(c.name, c.phone || 'No phone')}</span>
        </span></button>`
    },
    { key: 'address', label: 'Address', cell: ({ customer: c }) => `<span class="small">${escapeHtml(c.address || '-')}</span>` },
    { key: 'purchases', label: 'Total purchases', className: 'num', sortable: true, cell: ({ customer: c }) => money(c.totalPurchases) },
    {
      key: 'balance', label: 'Outstanding', className: 'num', sortable: true,
      cell: ({ customer: c }) => (num(c.balance) > 0
        ? `<strong class="c-warning">${money(c.balance)}</strong>`
        : '<span class="subtle">-</span>')
    },
    {
      key: 'limit', label: 'Credit limit', className: 'num', sortable: true,
      cell: ({ customer: c, available }) => `${money(c.creditLimit)}
        ${num(c.creditLimit) > 0 ? `<div class="cell-sub">${money(available)} left</div>` : '<div class="cell-sub">Cash only</div>'}`
    },
    { key: 'last', label: 'Last purchase', sortable: true, cell: ({ customer: c }) => (c.lastPurchaseAt ? fmtRelative(c.lastPurchaseAt) : '<span class="subtle">Never</span>') },
    {
      key: 'status', label: 'Status',
      cell: ({ customer: c }) => (c.active ? badge('Active', 'success', { dot: true }) : badge('Inactive', 'danger', { dot: true }))
    },
    {
      key: 'actions', label: '', className: 'right',
      cell: ({ customer: c }) => `<div class="table-actions">
        <button class="btn btn-ghost btn-sm" type="button" data-open="${c.id}" title="View customer">${icon('eye', 15)}</button>
        ${isAdmin && num(c.balance) > 0 ? `<button class="btn btn-ghost btn-sm" type="button" data-pay="${c.id}" title="Record payment">${icon('cash', 15)}</button>` : ''}
        ${isAdmin ? `<button class="btn btn-ghost btn-sm" type="button" data-edit="${c.id}" title="Edit">${icon('edit', 15)}</button>` : ''}
      </div>`
    }
  ];

  root.innerHTML = `
  <div class="page">
    ${pageHead({
      title: 'Customers',
      subtitle: isAdmin
        ? 'Accounts, purchase history and credit control.'
        : 'Customer directory. Credit limits and ledgers are managed by the pharmacy owner.',
      actions: `
        ${can('export.data') ? `<button class="btn btn-secondary" type="button" id="btn-export">${icon('download', 16)} Export CSV</button>` : ''}
        ${can('customers.create') ? `<button class="btn btn-primary" type="button" id="btn-add">${icon('plus', 16)} Add customer</button>` : ''}`
    })}

    <div class="kpi-grid">
      ${kpi({ label: 'Customers', value: int(totals.count), iconName: 'users', foot: `<span>${int(totals.active)} active</span>`, small: true })}
      ${kpi({ label: 'Lifetime purchases', value: money(totals.purchases), iconName: 'shoppingBag', tone: 'success', small: true })}
      ${kpi({ label: 'Outstanding credit', value: money(totals.outstanding), iconName: 'wallet', tone: totals.outstanding ? 'warning' : '', foot: `<span>${totals.owing.length} account(s)</span>`, route: '#/customers?filter=credit', small: true })}
      ${kpi({ label: 'At their limit', value: int(customers().filter((c) => num(c.creditLimit) > 0 && num(c.balance) >= num(c.creditLimit)).length), iconName: 'alert', tone: 'danger', small: true })}
    </div>

    ${isAdmin && (agingBuckets.length || topDebtors.length) ? `
      <div class="grid-dash">
        <div class="span-5">
          ${card({ title: 'Credit aging', sub: 'Outstanding balance by age of the oldest credit sale', body: agingBuckets.length ? donutChart(agingBuckets, { centreLabel: 'Owed' }) : emptyState({ iconName: 'checkCircle', title: 'No outstanding credit' }) })}
        </div>
        <div class="span-7">
          ${card({
            title: 'Largest balances',
            sub: 'Follow these up first',
            body: topDebtors.length
              ? rankChart(topDebtors.map((c) => ({
                  label: c.name,
                  value: num(c.balance),
                  sub: `Limit ${money(c.creditLimit)} - ${money(creditAvailable(c.id))} available`,
                  color: 'var(--chart-3)'
                })))
              : emptyState({ iconName: 'checkCircle', title: 'Every account is settled' })
          })}
        </div>
      </div>` : ''}

    <div class="toolbar">
      ${searchBox({ id: 'cust-search', value: state.query, placeholder: 'Search name, phone or address...' })}
      <div class="toolbar-group">
        <select class="select filter-select" id="f-filter" aria-label="Filter customers">
          ${options([
            { value: 'active', label: 'Active accounts' },
            { value: 'inactive', label: 'Inactive accounts' },
            { value: 'credit', label: 'With outstanding credit' },
            { value: 'overlimit', label: 'At or above limit' }
          ], state.filter, { placeholder: 'All customers' })}
        </select>
        ${(state.query || state.filter) ? '<button class="btn btn-ghost btn-sm" type="button" id="btn-clear">Clear</button>' : ''}
      </div>
    </div>

    ${card({
      flush: true,
      body: renderTable({
        columns,
        rows: pageData.rows,
        sort: { key: state.sortKey, dir: state.sortDir },
        rowClass: ({ customer: c }) => (!c.active ? 'row-warning' : ''),
        empty: emptyState({
          iconName: 'users',
          title: 'No customers match',
          message: 'Clear the filters or register a new customer.',
          actions: can('customers.create')
            ? '<button class="btn btn-primary btn-sm" type="button" id="btn-add-empty">Add customer</button>'
            : ''
        })
      }) + renderPagination(pageData, { label: 'customers' })
    })}
  </div>`;

  /* ---------------------------- events ---------------------------- */

  const rerender = () => ctx.refresh();

  const search = qs('#cust-search', root);
  search.addEventListener('input', debounce(() => {
    state.query = search.value;
    state.page = 1;
    const caret = search.selectionStart;
    rerender();
    const next = qs('#cust-search');
    if (next) { next.focus(); next.setSelectionRange(caret, caret); }
  }, 260));

  const filterSelect = qs('#f-filter', root);
  filterSelect.addEventListener('change', () => { state.filter = filterSelect.value; state.page = 1; rerender(); });

  const clearBtn = qs('#btn-clear', root);
  if (clearBtn) clearBtn.addEventListener('click', () => {
    Object.assign(state, { query: '', filter: '', page: 1 });
    ctx.navigate('/customers');
    rerender();
  });

  on(root, 'click', '[data-sort]', (event, node) => {
    const key = node.getAttribute('data-sort');
    if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    else { state.sortKey = key; state.sortDir = key === 'name' ? 'asc' : 'desc'; }
    rerender();
  });

  on(root, 'click', '[data-page]', (event, node) => {
    const page = num(node.getAttribute('data-page'));
    if (page >= 1 && page <= pageData.pages) { state.page = page; rerender(); }
  });

  on(root, 'click', '[data-open]', (event, node) => openCustomerDrawer(node.getAttribute('data-open')));
  on(root, 'click', '[data-edit]', (event, node) => {
    event.stopPropagation();
    openCustomerModal(customer(node.getAttribute('data-edit')));
  });
  on(root, 'click', '[data-pay]', (event, node) => {
    event.stopPropagation();
    openPaymentModal(node.getAttribute('data-pay'));
  });

  qsa('#btn-add, #btn-add-empty', root).forEach((b) => b.addEventListener('click', () => openCustomerModal()));

  const exportBtn = qs('#btn-export', root);
  if (exportBtn) exportBtn.addEventListener('click', () => {
    const columnsCsv = [
      { label: 'Name', value: ({ customer: c }) => c.name },
      { label: 'Phone', value: ({ customer: c }) => c.phone },
      { label: 'Address', value: ({ customer: c }) => c.address },
      { label: 'Total purchases', value: ({ customer: c }) => c.totalPurchases },
      { label: 'Last purchase', value: ({ customer: c }) => (c.lastPurchaseAt ? fmtDate(c.lastPurchaseAt) : '') },
      { label: 'Status', value: ({ customer: c }) => (c.active ? 'Active' : 'Inactive') }
    ];
    // Credit figures are confidential - only the owner exports them.
    if (isAdmin) {
      columnsCsv.splice(4, 0,
        { label: 'Outstanding balance', value: ({ customer: c }) => c.balance },
        { label: 'Credit limit', value: ({ customer: c }) => c.creditLimit },
        { label: 'Credit available', value: ({ available }) => available });
    }
    downloadCsv(exportName('customers'), allRows, columnsCsv);
    notifySuccess('Export ready', `${allRows.length} customers exported.`);
  });
}

export default { render };
