/* ==========================================================================
   MediFlow Pharmacy ERP - Suppliers (admin only)
   Supplier records, purchase history, outstanding balances, payments and
   return-to-supplier records (section 18).
   ========================================================================== */

import {
  db, suppliers, supplier, createSupplier, updateSupplier, recordSupplierPayment,
  supplierHistory, medicines, settings
} from '../store.js';
import { can, requirePermission } from '../auth.js';
import {
  pageHead, card, kpi, icon, badge, renderTable, cellStack, renderPagination, emptyState,
  openModal, openDrawer, modalFooter, notifySuccess, notifyError, notifyDenied, escapeHtml,
  field, selectField, options, searchBox, printNode, printHeader, printFooter, rankChart
} from '../ui.js';
import {
  money, int, num, round, fmtDate, fmtDateTime, fmtRelative, sortBy, paginate,
  qs, qsa, on, debounce, matchesQuery, sum, formData, validate, rule,
  showFormErrors, downloadCsv, exportName, initials, startOfMonth
} from '../utils.js';

const PER_PAGE = 10;

const state = { query: '', filter: '', page: 1 };

let ctxRef = null;

/* ============================== ROWS ============================== */

function buildRows() {
  let rows = suppliers().map((s) => {
    const history = supplierHistory(s.id);
    return {
      supplier: s,
      receipts: history.receipts.length,
      purchased: round(sum(history.receipts, (r) => r.total), 2),
      paid: round(sum(history.payments, (p) => p.amount), 2),
      returns: history.returns.length,
      medicines: medicines().filter((m) => m.supplierId === s.id).length,
      lastSupply: s.lastSupplyAt || null
    };
  });

  if (state.query) {
    rows = rows.filter(({ supplier: s }) => matchesQuery(
      `${s.name} ${s.contactPerson} ${s.phone} ${s.email} ${s.address}`, state.query));
  }
  if (state.filter === 'owing') rows = rows.filter(({ supplier: s }) => num(s.balance) > 0);
  if (state.filter === 'active') rows = rows.filter(({ supplier: s }) => s.active);
  if (state.filter === 'inactive') rows = rows.filter(({ supplier: s }) => !s.active);

  return sortBy(rows, (r) => r.supplier.name, 'asc');
}

/* ============================== SUPPLIER FORM ============================== */

function openSupplierModal(existing = null) {
  try {
    requirePermission('suppliers.manage');
  } catch (error) {
    notifyDenied(error);
    return;
  }

  const editing = !!existing;
  const modal = openModal({
    title: editing ? `Edit ${existing.name}` : 'Add a supplier',
    subtitle: editing ? `On record since ${fmtDate(existing.createdAt)}` : 'Suppliers are selected when receiving goods',
    size: 'modal-lg',
    iconName: 'building',
    body: `
      <form id="sup-form" class="stack-lg" novalidate>
        <div class="grid-2">
          ${field({ name: 'name', label: 'Company name', value: existing ? existing.name : '', required: true, attrs: 'autofocus' })}
          ${field({ name: 'contactPerson', label: 'Contact person', value: existing ? existing.contactPerson : '' })}
          ${field({ name: 'phone', label: 'Phone number', value: existing ? existing.phone : '', attrs: 'inputmode="tel"' })}
          ${field({ name: 'email', label: 'Email address', type: 'email', value: existing ? existing.email : '' })}
          ${field({ name: 'address', label: 'Address', value: existing ? existing.address : '', type: 'textarea', className: 'col-span-2', attrs: 'rows="2"' })}
          ${field({ name: 'note', label: 'Note', value: existing ? existing.note : '', className: 'col-span-2', attrs: 'placeholder="Delivery days, payment terms..."' })}
        </div>
        ${editing ? `
          <label class="check">
            <input type="checkbox" name="active" ${existing.active ? 'checked' : ''}>
            <span class="check-text">Supplier active
              <small>Inactive suppliers cannot be selected when receiving goods</small></span>
          </label>` : ''}
        ${editing && num(existing.balance) > 0 ? `
          <div class="alert alert-warning small">
            ${icon('alert', 15)}
            <div>You owe this supplier <strong>${money(existing.balance)}</strong> on unpaid invoices.</div>
          </div>` : ''}
      </form>`,
    footer: modalFooter({ confirmLabel: editing ? 'Save changes' : 'Add supplier' })
  });

  const form = qs('#sup-form', modal.root);

  const submit = () => {
    const data = formData(form);
    const { valid, errors } = validate(data, {
      name: [rule.required('Enter the company name'), rule.minLen(2)],
      phone: [rule.phone()],
      email: [rule.email()]
    });

    const clash = suppliers().find((s) =>
      s.name.toLowerCase() === String(data.name).trim().toLowerCase() && (!editing || s.id !== existing.id));
    if (clash) errors.name = 'A supplier with that name already exists.';

    if (!valid || Object.keys(errors).length) { showFormErrors(form, errors); return; }

    try {
      if (editing) {
        updateSupplier(existing.id, data, ctxRef.user);
        notifySuccess('Supplier updated', `${data.name} has been saved.`);
      } else {
        createSupplier(data, ctxRef.user);
        notifySuccess('Supplier added', `${data.name} can now be selected when receiving goods.`);
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

/* ============================== PAYMENT ============================== */

function openPaymentModal(supplierId) {
  try {
    requirePermission('suppliers.manage');
  } catch (error) {
    notifyDenied(error);
    return;
  }

  const row = supplier(supplierId);
  if (!row) return;

  const history = supplierHistory(row.id);
  const unpaid = history.receipts.filter((r) => !r.paid);

  const modal = openModal({
    title: 'Pay a supplier',
    subtitle: `${row.name} - ${money(row.balance)} outstanding`,
    size: 'modal-sm',
    iconName: 'wallet',
    body: `
      <form id="pay-form" class="stack-lg" novalidate>
        <div class="card card-pad">
          <div class="stat-line"><span class="sl-label">Outstanding balance</span><span class="sl-value">${money(row.balance)}</span></div>
          <div class="stat-line"><span class="sl-label">Unpaid invoices</span><span class="sl-value">${unpaid.length}</span></div>
          <div class="stat-line"><span class="sl-label">Total purchased</span><span class="sl-value">${money(sum(history.receipts, (r) => r.total))}</span></div>
        </div>
        ${field({
          name: 'amount', label: 'Amount paid', type: 'number', required: true,
          value: num(row.balance) > 0 ? num(row.balance) : '', attrs: 'min="0.01" step="0.01" autofocus'
        })}
        ${selectField({
          name: 'method', label: 'Payment method', required: true,
          list: ['Bank Transfer', 'Cash', 'POS/Card', 'Cheque'], value: 'Bank Transfer'
        })}
        ${unpaid.length ? selectField({
          name: 'invoiceNo', label: 'Against invoice (optional)',
          list: unpaid.map((r) => ({ value: r.invoiceNo || r.ref, label: `${r.invoiceNo || r.ref} - ${money(r.total)} (${fmtDate(r.datetime)})` })),
          placeholder: 'Not invoice specific'
        }) : ''}
        <div class="field">
          <label class="label" for="sup-note">Note</label>
          <input class="input" id="sup-note" name="note" placeholder="Teller or transfer reference" autocomplete="off">
        </div>
        <div class="card card-pad">
          <div class="stat-line is-total">
            <span class="sl-label">Balance after payment</span>
            <span class="sl-value" id="pay-after">${money(row.balance)}</span>
          </div>
        </div>
      </form>`,
    footer: modalFooter({ confirmLabel: 'Record payment', tone: 'success' })
  });

  const form = qs('#pay-form', modal.root);
  form.addEventListener('input', () => {
    const after = round(num(row.balance) - num(form.elements.amount.value), 2);
    qs('#pay-after', modal.root).textContent = money(after);
  });

  const submit = () => {
    const data = formData(form);
    if (num(data.amount) <= 0) { showFormErrors(form, { amount: 'Enter an amount greater than zero.' }); return; }
    try {
      const record = recordSupplierPayment({
        supplierId: row.id,
        amount: data.amount,
        method: data.method,
        invoiceNo: data.invoiceNo,
        note: data.note,
        user: ctxRef.user
      });
      modal.close();
      notifySuccess('Payment recorded', `${record.ref}: ${money(record.amount)} paid, balance now ${money(record.balanceAfter)}.`);
      ctxRef.refresh();
    } catch (error) {
      notifyError('Could not record the payment', error.message);
    }
  };

  form.addEventListener('submit', (event) => { event.preventDefault(); submit(); });
  qs('#modal-confirm', modal.root).addEventListener('click', (event) => { event.preventDefault(); submit(); });
}

/* ============================== DETAIL ============================== */

function openSupplierDrawer(supplierId) {
  const row = supplier(supplierId);
  if (!row) return;

  const history = supplierHistory(row.id);
  const receipts = sortBy(history.receipts, (r) => r.datetime, 'desc');
  const payments = sortBy(history.payments, (p) => p.datetime, 'desc');
  const supplied = medicines().filter((m) => m.supplierId === row.id);
  const purchased = round(sum(receipts, (r) => r.total), 2);

  openDrawer({
    title: row.name,
    subtitle: `${row.contactPerson || 'No contact person'} - ${row.phone || 'no phone'}`,
    size: 'drawer-lg',
    body: `
      <div class="stack-lg">
        <div class="row-wrap">
          ${row.active ? badge('Active', 'success', { dot: true }) : badge('Inactive', 'danger', { dot: true })}
          ${num(row.balance) > 0 ? badge(`${money(row.balance)} owed`, 'warning') : badge('Fully settled', 'neutral')}
          ${badge(`${supplied.length} product(s)`, 'info')}
        </div>

        <div class="kpi-grid">
          ${kpi({ label: 'Total purchased', value: money(purchased), iconName: 'truck', tone: 'info', foot: `<span>${receipts.length} receipt(s)</span>`, small: true })}
          ${kpi({ label: 'Total paid', value: money(sum(payments, (p) => p.amount)), iconName: 'wallet', tone: 'success', foot: `<span>${payments.length} payment(s)</span>`, small: true })}
          ${kpi({ label: 'Outstanding', value: money(row.balance), iconName: 'alert', tone: num(row.balance) > 0 ? 'warning' : '', small: true })}
        </div>

        <div class="def-grid">
          <div class="def-item"><div class="def-label">Contact person</div><div class="def-value">${escapeHtml(row.contactPerson || '-')}</div></div>
          <div class="def-item"><div class="def-label">Phone</div><div class="def-value">${escapeHtml(row.phone || '-')}</div></div>
          <div class="def-item"><div class="def-label">Email</div><div class="def-value">${escapeHtml(row.email || '-')}</div></div>
          <div class="def-item"><div class="def-label">Address</div><div class="def-value">${escapeHtml(row.address || '-')}</div></div>
          <div class="def-item"><div class="def-label">Last supply</div><div class="def-value">${row.lastSupplyAt ? fmtDateTime(row.lastSupplyAt) : 'Never'}</div></div>
          <div class="def-item"><div class="def-label">On record since</div><div class="def-value">${fmtDate(row.createdAt)}</div></div>
          ${row.note ? `<div class="def-item"><div class="def-label">Note</div><div class="def-value">${escapeHtml(row.note)}</div></div>` : ''}
        </div>

        <section>
          <h3 class="mb-3">Purchase history (${receipts.length})</h3>
          ${receipts.length ? renderTable({
            compact: true,
            responsive: false,
            columns: [
              { key: 'ref', label: 'Receipt', cell: (r) => cellStack(r.ref, fmtDate(r.datetime)) },
              { key: 'invoiceNo', label: 'Invoice', cell: (r) => `<span class="mono small">${escapeHtml(r.invoiceNo || '-')}</span>` },
              { key: 'units', label: 'Units', className: 'num', cell: (r) => int(r.units) },
              { key: 'total', label: 'Value', className: 'num', cell: (r) => `<strong>${money(r.total)}</strong>` },
              { key: 'paid', label: 'Status', cell: (r) => (r.paid ? badge('Paid', 'success') : badge('Unpaid', 'warning')) }
            ],
            rows: receipts.slice(0, 20),
            footer: `<tr><td colspan="3">Total purchased</td><td class="num">${money(purchased)}</td><td></td></tr>`
          }) : emptyState({ iconName: 'truck', title: 'No deliveries recorded' })}
        </section>

        ${payments.length ? `
          <section>
            <h3 class="mb-3">Payments made (${payments.length})</h3>
            <div class="list">${payments.map((p) => `
              <div class="list-row">
                <span class="list-avatar tone-success">${icon('wallet', 15)}</span>
                <span class="list-main">
                  <span class="list-title">${money(p.amount)} · ${escapeHtml(p.method)}</span>
                  <span class="list-sub">${escapeHtml(p.ref)} · ${fmtDateTime(p.datetime)} · by ${escapeHtml(p.userName)}
                    ${p.invoiceNo ? ` · invoice ${escapeHtml(p.invoiceNo)}` : ''}</span>
                </span>
                <span class="list-end"><span class="small muted">Balance ${money(p.balanceAfter)}</span></span>
              </div>`).join('')}</div>
          </section>` : ''}

        ${history.returns.length ? `
          <section>
            <h3 class="mb-3">Returned to this supplier (${history.returns.length})</h3>
            ${renderTable({
              compact: true,
              responsive: false,
              columns: [
                { key: 'ref', label: 'Reference', cell: (r) => cellStack(r.ref, fmtDate(r.datetime)) },
                { key: 'medicineName', label: 'Medicine', cell: (r) => cellStack(r.medicineName, `Batch ${r.batchNo}`) },
                { key: 'qty', label: 'Units', className: 'num', cell: (r) => int(r.qty) },
                { key: 'valueImpact', label: 'Credit', className: 'num', cell: (r) => money(Math.abs(r.valueImpact)) }
              ],
              rows: history.returns
            })}
          </section>` : ''}

        <section>
          <h3 class="mb-3">Products supplied (${supplied.length})</h3>
          ${supplied.length ? `<div class="row-wrap">${supplied.map((m) =>
            `<span class="chip">${escapeHtml(`${m.name} ${m.strength}`.trim())}</span>`).join('')}</div>`
            : emptyState({ iconName: 'pill', title: 'No medicines are linked to this supplier' })}
        </section>
      </div>`,
    footer: `
      ${num(row.balance) > 0 ? `<button class="btn btn-success" type="button" data-pay="${row.id}">${icon('wallet', 15)} Record payment</button>` : ''}
      <button class="btn btn-secondary" type="button" data-statement="${row.id}">${icon('print', 15)} Statement</button>
      <button class="btn btn-secondary" type="button" data-edit="${row.id}">${icon('edit', 15)} Edit</button>
      <button class="btn btn-primary" type="button" data-route="#/receive">${icon('truck', 15)} Receive goods</button>`,
    onMount: (api) => {
      api.root.addEventListener('click', (event) => {
        const pay = event.target.closest('[data-pay]');
        if (pay) { api.close(); openPaymentModal(pay.getAttribute('data-pay')); return; }
        const edit = event.target.closest('[data-edit]');
        if (edit) { api.close(); openSupplierModal(supplier(edit.getAttribute('data-edit'))); return; }
        const statement = event.target.closest('[data-statement]');
        if (statement) printStatement(statement.getAttribute('data-statement'));
      });
    }
  });
}

function printStatement(supplierId) {
  const row = supplier(supplierId);
  if (!row) return;
  const pharmacy = settings().pharmacy;
  const history = supplierHistory(row.id);

  // Build a chronological account: purchases debit us, payments credit us.
  const entries = [
    ...history.receipts.map((r) => ({ datetime: r.datetime, type: `Goods received ${r.ref}`, ref: r.invoiceNo || r.ref, debit: r.total, credit: 0 })),
    ...history.payments.map((p) => ({ datetime: p.datetime, type: `Payment (${p.method})`, ref: p.ref, debit: 0, credit: p.amount })),
    ...history.returns.map((r) => ({ datetime: r.datetime, type: `Returned ${r.medicineName}`, ref: r.ref, debit: 0, credit: Math.abs(r.valueImpact) }))
  ];
  const sorted = sortBy(entries, (e) => e.datetime, 'asc');
  let running = 0;
  const ledger = sorted.map((e) => {
    running = round(running + e.debit - e.credit, 2);
    return { ...e, balance: running };
  });

  printNode(`
    <div class="print-doc">
      ${printHeader({
        pharmacy,
        title: 'Supplier Statement',
        subtitle: row.name,
        meta: `Generated ${fmtDateTime(new Date())}<br>
               ${escapeHtml(row.contactPerson || '')}<br>
               ${escapeHtml(row.phone || '')}`
      })}
      <div class="print-kpis">
        <div class="print-kpi"><div class="pk-label">Total purchased</div><div class="pk-value">${money(sum(history.receipts, (r) => r.total))}</div></div>
        <div class="print-kpi"><div class="pk-label">Total paid</div><div class="pk-value">${money(sum(history.payments, (p) => p.amount))}</div></div>
        <div class="print-kpi"><div class="pk-label">Returns credited</div><div class="pk-value">${money(sum(history.returns, (r) => Math.abs(r.valueImpact)))}</div></div>
        <div class="print-kpi"><div class="pk-label">Balance owed</div><div class="pk-value">${money(row.balance)}</div></div>
      </div>

      <h2 class="print-section">Account activity</h2>
      <table>
        <thead><tr><th>Date</th><th>Entry</th><th>Reference</th>
          <th class="num">Invoiced</th><th class="num">Paid / credited</th><th class="num">Balance</th></tr></thead>
        <tbody>${ledger.reverse().map((e) => `<tr>
          <td>${fmtDate(e.datetime)}</td>
          <td>${escapeHtml(e.type)}</td>
          <td>${escapeHtml(e.ref)}</td>
          <td class="num">${e.debit ? money(e.debit) : '-'}</td>
          <td class="num">${e.credit ? money(e.credit) : '-'}</td>
          <td class="num">${money(e.balance)}</td>
        </tr>`).join('')}</tbody>
      </table>
      ${printFooter({ left: `${escapeHtml(pharmacy.name)} - confidential`, right: 'MediFlow Pharmacy ERP' })}
    </div>`, 'report');
}

/* ============================== RENDER ============================== */

export function render(root, ctx) {
  ctxRef = ctx;

  const allRows = buildRows();
  const pageData = paginate(allRows, state.page, PER_PAGE);

  const totals = {
    count: suppliers().length,
    owed: sum(suppliers(), (s) => Math.max(0, num(s.balance))),
    owing: suppliers().filter((s) => num(s.balance) > 0).length,
    purchasedMonth: round(sum(
      db.goodsReceipts.filter((r) => new Date(r.datetime) >= startOfMonth()),
      (r) => r.total
    ), 2)
  };

  const topSuppliers = sortBy(allRows, (r) => r.purchased, 'desc').slice(0, 5);

  const columns = [
    {
      key: 'name', label: 'Supplier',
      cell: ({ supplier: s }) => `<button class="btn-ghost" type="button" data-open="${s.id}" style="text-align:left;display:block;width:100%">
        <span class="row-sm">
          <span class="list-avatar tone-info" style="width:30px;height:30px;font-size:11px">${escapeHtml(initials(s.name))}</span>
          <span>${cellStack(s.name, s.contactPerson || s.phone || '-')}</span>
        </span></button>`
    },
    { key: 'contact', label: 'Contact', cell: ({ supplier: s }) => cellStack(s.phone || '-', s.email || '') },
    { key: 'medicines', label: 'Products', className: 'num', cell: (r) => int(r.medicines) },
    { key: 'receipts', label: 'Deliveries', className: 'num', cell: (r) => `${int(r.receipts)}${r.lastSupply ? `<div class="cell-sub">${fmtRelative(r.lastSupply)}</div>` : ''}` },
    { key: 'purchased', label: 'Total purchased', className: 'num', cell: (r) => money(r.purchased) },
    {
      key: 'balance', label: 'Outstanding', className: 'num',
      cell: ({ supplier: s }) => (num(s.balance) > 0
        ? `<strong class="c-warning">${money(s.balance)}</strong>`
        : '<span class="c-success">Settled</span>')
    },
    {
      key: 'status', label: 'Status',
      cell: ({ supplier: s }) => (s.active ? badge('Active', 'success', { dot: true }) : badge('Inactive', 'danger', { dot: true }))
    },
    {
      key: 'actions', label: '', className: 'right',
      cell: ({ supplier: s }) => `<div class="table-actions">
        <button class="btn btn-ghost btn-sm" type="button" data-open="${s.id}" title="View supplier">${icon('eye', 15)}</button>
        ${num(s.balance) > 0 ? `<button class="btn btn-ghost btn-sm" type="button" data-pay="${s.id}" title="Record payment">${icon('wallet', 15)}</button>` : ''}
        <button class="btn btn-ghost btn-sm" type="button" data-edit="${s.id}" title="Edit">${icon('edit', 15)}</button>
      </div>`
    }
  ];

  root.innerHTML = `
  <div class="page">
    ${pageHead({
      title: 'Suppliers',
      subtitle: 'Supplier records, purchase history, outstanding invoices and payments.',
      actions: `
        ${can('export.data') ? `<button class="btn btn-secondary" type="button" id="btn-export">${icon('download', 16)} Export CSV</button>` : ''}
        <button class="btn btn-secondary" type="button" data-route="#/receive">${icon('truck', 16)} Receive goods</button>
        <button class="btn btn-primary" type="button" id="btn-add">${icon('plus', 16)} Add supplier</button>`
    })}

    <div class="kpi-grid">
      ${kpi({ label: 'Suppliers', value: int(totals.count), iconName: 'building', foot: `<span>${suppliers().filter((s) => s.active).length} active</span>`, small: true })}
      ${kpi({ label: 'Outstanding payables', value: money(totals.owed), iconName: 'wallet', tone: totals.owed ? 'warning' : '', foot: `<span>${totals.owing} supplier(s)</span>`, small: true })}
      ${kpi({ label: 'Purchased this month', value: money(totals.purchasedMonth), iconName: 'truck', tone: 'info', small: true })}
      ${kpi({ label: 'Supplier returns', value: int(db.adjustments.filter((a) => a.source === 'supplier-return').length), iconName: 'returnArrow', small: true })}
    </div>

    ${topSuppliers.some((r) => r.purchased > 0) ? `
      <div class="grid-dash">
        <div class="span-12">
          ${card({
            title: 'Purchases by supplier',
            sub: 'Total value of goods received, all time',
            body: rankChart(topSuppliers.filter((r) => r.purchased > 0).map((r) => ({
              label: r.supplier.name,
              value: r.purchased,
              sub: `${r.receipts} delivery(ies) - ${money(r.supplier.balance)} outstanding`,
              color: 'var(--chart-2)'
            })))
          })}
        </div>
      </div>` : ''}

    <div class="toolbar">
      ${searchBox({ id: 'sup-search', value: state.query, placeholder: 'Search supplier, contact or phone...' })}
      <div class="toolbar-group">
        <select class="select filter-select" id="f-filter" aria-label="Filter suppliers">
          ${options([
            { value: 'active', label: 'Active' },
            { value: 'inactive', label: 'Inactive' },
            { value: 'owing', label: 'With outstanding balance' }
          ], state.filter, { placeholder: 'All suppliers' })}
        </select>
        ${(state.query || state.filter) ? '<button class="btn btn-ghost btn-sm" type="button" id="btn-clear">Clear</button>' : ''}
      </div>
    </div>

    ${card({
      flush: true,
      body: renderTable({
        columns,
        rows: pageData.rows,
        rowClass: ({ supplier: s }) => (!s.active ? 'row-warning' : ''),
        empty: emptyState({
          iconName: 'building',
          title: 'No suppliers match',
          message: 'Clear the filters or add a new supplier.',
          actions: '<button class="btn btn-primary btn-sm" type="button" id="btn-add-empty">Add supplier</button>'
        })
      }) + renderPagination(pageData, { label: 'suppliers' })
    })}
  </div>`;

  /* ---------------------------- events ---------------------------- */

  const rerender = () => ctx.refresh();

  const search = qs('#sup-search', root);
  search.addEventListener('input', debounce(() => {
    state.query = search.value;
    state.page = 1;
    const caret = search.selectionStart;
    rerender();
    const next = qs('#sup-search');
    if (next) { next.focus(); next.setSelectionRange(caret, caret); }
  }, 260));

  const filterSelect = qs('#f-filter', root);
  filterSelect.addEventListener('change', () => { state.filter = filterSelect.value; state.page = 1; rerender(); });

  const clearBtn = qs('#btn-clear', root);
  if (clearBtn) clearBtn.addEventListener('click', () => {
    Object.assign(state, { query: '', filter: '', page: 1 });
    rerender();
  });

  on(root, 'click', '[data-page]', (event, node) => {
    const page = num(node.getAttribute('data-page'));
    if (page >= 1 && page <= pageData.pages) { state.page = page; rerender(); }
  });

  on(root, 'click', '[data-open]', (event, node) => openSupplierDrawer(node.getAttribute('data-open')));
  on(root, 'click', '[data-edit]', (event, node) => {
    event.stopPropagation();
    openSupplierModal(supplier(node.getAttribute('data-edit')));
  });
  on(root, 'click', '[data-pay]', (event, node) => {
    event.stopPropagation();
    openPaymentModal(node.getAttribute('data-pay'));
  });

  qsa('#btn-add, #btn-add-empty', root).forEach((b) => b.addEventListener('click', () => openSupplierModal()));

  const exportBtn = qs('#btn-export', root);
  if (exportBtn) exportBtn.addEventListener('click', () => {
    downloadCsv(exportName('suppliers'), allRows, [
      { label: 'Supplier', value: ({ supplier: s }) => s.name },
      { label: 'Contact person', value: ({ supplier: s }) => s.contactPerson },
      { label: 'Phone', value: ({ supplier: s }) => s.phone },
      { label: 'Email', value: ({ supplier: s }) => s.email },
      { label: 'Address', value: ({ supplier: s }) => s.address },
      { label: 'Products supplied', value: (r) => r.medicines },
      { label: 'Deliveries', value: (r) => r.receipts },
      { label: 'Total purchased', value: (r) => r.purchased },
      { label: 'Total paid', value: (r) => r.paid },
      { label: 'Outstanding balance', value: ({ supplier: s }) => s.balance },
      { label: 'Returns', value: (r) => r.returns },
      { label: 'Last supply', value: (r) => (r.lastSupply ? fmtDate(r.lastSupply) : '') },
      { label: 'Status', value: ({ supplier: s }) => (s.active ? 'Active' : 'Inactive') }
    ]);
    notifySuccess('Export ready', `${allRows.length} suppliers exported.`);
  });
}

export default { render };
