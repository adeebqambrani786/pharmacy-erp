/* ==========================================================================
   MediFlow Pharmacy ERP - Expenses (admin only)
   Operating costs recorded here feed straight into the net-profit figures on
   the dashboard and in reports (section 20).
   ========================================================================== */

import {
  expenses, createExpense, updateExpense, deleteExpense, find, financials, settings
} from '../store.js';
import { can, requirePermission } from '../auth.js';
import {
  pageHead, card, kpi, icon, badge, renderTable, cellStack, renderPagination,
  emptyState, openModal, modalFooter, confirmDialog, notifySuccess, notifyError,
  notifyDenied, escapeHtml, field, selectField, options, searchBox, donutChart,
  barChart, printNode, printHeader, printFooter
} from '../ui.js';
import {
  money, int, num, round, fmtDate, fmtDateTime, fmtRelative, isoDate, sortBy, paginate, qs, qsa,
  on, debounce, matchesQuery, sum, groupBy, formData, validate, rule, showFormErrors,
  downloadCsv, exportName, EXPENSE_CATEGORIES, startOfMonth, lastNMonths, endOfDay
} from '../utils.js';

const PER_PAGE = 12;

const state = {
  query: '',
  category: '',
  method: '',
  from: '',
  to: '',
  page: 1,
  sortKey: 'date',
  sortDir: 'desc'
};

let ctxRef = null;

/* ============================== ROWS ============================== */

function buildRows() {
  let rows = expenses();
  if (state.category) rows = rows.filter((e) => e.category === state.category);
  if (state.method) rows = rows.filter((e) => e.method === state.method);
  if (state.from) rows = rows.filter((e) => e.date >= state.from);
  if (state.to) rows = rows.filter((e) => e.date <= state.to);
  if (state.query) {
    rows = rows.filter((e) => matchesQuery(`${e.ref} ${e.category} ${e.description} ${e.note} ${e.userName}`, state.query));
  }

  const selectors = {
    date: (e) => e.date,
    category: (e) => e.category,
    amount: (e) => num(e.amount),
    method: (e) => e.method
  };
  return sortBy(rows, selectors[state.sortKey] || selectors.date, state.sortDir);
}

/* ============================== FORM ============================== */

function openExpenseModal(existing = null) {
  try {
    requirePermission('expenses.manage');
  } catch (error) {
    notifyDenied(error);
    return;
  }

  const editing = !!existing;
  const modal = openModal({
    title: editing ? `Edit expense ${existing.ref}` : 'Record an expense',
    subtitle: editing ? `Recorded ${fmtDateTime(existing.createdAt)} by ${existing.userName}` : 'Expenses reduce net profit for the period they fall in',
    size: 'modal-lg',
    iconName: 'wallet',
    body: `
      <form id="exp-form" class="stack-lg" novalidate>
        <div class="grid-2">
          ${field({
            name: 'date', label: 'Expense date', type: 'date', required: true,
            value: existing ? existing.date : isoDate(), attrs: `max="${isoDate()}"`
          })}
          ${selectField({
            name: 'category', label: 'Category', required: true,
            list: EXPENSE_CATEGORIES, value: existing ? existing.category : '',
            placeholder: 'Select category'
          })}
          ${field({
            name: 'amount', label: 'Amount', type: 'number', required: true,
            value: existing ? num(existing.amount) : '', attrs: 'min="0.01" step="0.01" autofocus'
          })}
          ${selectField({
            name: 'method', label: 'Payment method', required: true,
            list: ['Cash', 'POS/Card', 'Bank Transfer', 'Cheque'],
            value: existing ? existing.method : 'Cash'
          })}
          ${field({
            name: 'description', label: 'Description', required: true,
            value: existing ? existing.description : '', className: 'col-span-2',
            attrs: 'placeholder="e.g. PHCN prepaid units for October"'
          })}
          ${field({
            name: 'note', label: 'Note', type: 'textarea',
            value: existing ? existing.note : '', className: 'col-span-2', attrs: 'rows="2"'
          })}
        </div>
        <div class="alert alert-info small">
          ${icon('info', 16)}
          <div>Cash expenses are not deducted from the cash drawer automatically - record a
          drawer adjustment at shift close if money left the till.</div>
        </div>
      </form>`,
    footer: modalFooter({ confirmLabel: editing ? 'Save changes' : 'Record expense' })
  });

  const form = qs('#exp-form', modal.root);

  const submit = () => {
    const data = formData(form);
    const { valid, errors } = validate(data, {
      date: [rule.required('Select the expense date'), rule.date()],
      category: [rule.required('Select a category')],
      amount: [rule.required('Enter the amount'), rule.positive('Amount must be greater than zero')],
      method: [rule.required('Select a payment method')],
      description: [rule.required('Describe what the money was spent on'), rule.minLen(3)]
    });
    if (!valid) { showFormErrors(form, errors); return; }

    try {
      if (editing) {
        updateExpense(existing.id, data, ctxRef.user);
        notifySuccess('Expense updated', `${existing.ref} saved.`);
      } else {
        const created = createExpense(data, ctxRef.user);
        notifySuccess('Expense recorded', `${created.ref}: ${money(created.amount)} ${created.category.toLowerCase()}.`);
      }
      modal.close();
      ctxRef.refresh();
    } catch (error) {
      notifyError('Could not save the expense', error.message);
    }
  };

  form.addEventListener('submit', (event) => { event.preventDefault(); submit(); });
  qs('#modal-confirm', modal.root).addEventListener('click', (event) => { event.preventDefault(); submit(); });
}

async function deleteFlow(expenseId) {
  const row = find('expenses', expenseId);
  if (!row) return;

  const ok = await confirmDialog({
    title: 'Delete this expense?',
    message: `${row.ref}: ${money(row.amount)} for ${row.category.toLowerCase()} on ${fmtDate(row.date)}.`,
    detail: 'Net profit for that period will be recalculated. The deletion is recorded in the activity log.',
    confirmLabel: 'Delete expense',
    tone: 'danger',
    iconName: 'trash'
  });
  if (!ok) return;

  try {
    deleteExpense(expenseId, ctxRef.user);
    notifySuccess('Expense deleted', `${row.ref} has been removed.`);
    ctxRef.refresh();
  } catch (error) {
    notifyError('Could not delete', error.message);
  }
}

/* ============================== RENDER ============================== */

export function render(root, ctx) {
  ctxRef = ctx;

  const allRows = buildRows();
  const pageData = paginate(allRows, state.page, PER_PAGE);

  const monthRows = expenses().filter((e) => new Date(e.date) >= startOfMonth());
  const monthTotal = round(sum(monthRows, (e) => e.amount), 2);
  const fin = financials({ from: startOfMonth(), to: endOfDay() });

  // Category mix for the current month
  const byCategory = [...groupBy(monthRows, (e) => e.category).entries()]
    .map(([category, rows]) => ({ label: category, value: round(sum(rows, (e) => e.amount), 2) }))
    .filter((r) => r.value > 0);

  // Six-month trend
  const trend = lastNMonths(6).map((m) => {
    const rows = expenses().filter((e) => {
      const d = new Date(e.date);
      return d >= m.start && d <= m.end;
    });
    const total = round(sum(rows, (e) => e.amount), 2);
    return { label: m.label, value: total, tip: `${m.label}: ${money(total)} across ${rows.length} expense(s)` };
  });

  const columns = [
    { key: 'date', label: 'Date', sortable: true, cell: (e) => cellStack(fmtDate(e.date), fmtRelative(e.createdAt)) },
    { key: 'ref', label: 'Reference', cell: (e) => `<span class="mono small">${escapeHtml(e.ref)}</span>` },
    { key: 'category', label: 'Category', sortable: true, cell: (e) => badge(e.category, 'neutral') },
    { key: 'description', label: 'Description', cell: (e) => cellStack(e.description, e.note || '') },
    { key: 'method', label: 'Paid by', sortable: true, cell: (e) => escapeHtml(e.method) },
    { key: 'amount', label: 'Amount', className: 'num', sortable: true, cell: (e) => `<strong>${money(e.amount)}</strong>` },
    { key: 'userName', label: 'Recorded by', cell: (e) => escapeHtml(e.userName) },
    {
      key: 'actions', label: '', className: 'right',
      cell: (e) => `<div class="table-actions">
        <button class="btn btn-ghost btn-sm" type="button" data-edit="${e.id}" title="Edit expense">${icon('edit', 15)}</button>
        <button class="btn btn-ghost btn-sm" type="button" data-delete="${e.id}" title="Delete expense">${icon('trash', 15)}</button>
      </div>`
    }
  ];

  root.innerHTML = `
  <div class="page">
    ${pageHead({
      title: 'Expenses',
      subtitle: 'Operating costs that are deducted from gross profit to give net profit.',
      actions: `
        ${can('export.data') ? `<button class="btn btn-secondary" type="button" id="btn-export">${icon('download', 16)} Export CSV</button>` : ''}
        <button class="btn btn-secondary" type="button" id="btn-print">${icon('print', 16)} Print</button>
        <button class="btn btn-primary" type="button" id="btn-add">${icon('plus', 16)} Record expense</button>`
    })}

    <div class="kpi-grid">
      ${kpi({ label: 'This month', value: money(monthTotal), iconName: 'wallet', tone: 'warning', foot: `<span>${monthRows.length} expense(s)</span>`, small: true })}
      ${kpi({ label: 'Gross profit this month', value: money(fin.grossProfit), iconName: 'trending', tone: 'success', small: true })}
      ${kpi({ label: 'Net profit this month', value: money(fin.netProfit), iconName: 'percent', tone: fin.netProfit >= 0 ? 'success' : 'danger', foot: '<span>After expenses</span>', small: true })}
      ${kpi({ label: 'Expense ratio', value: fin.netRevenue ? `${round((monthTotal / fin.netRevenue) * 100, 1)}%` : '0%', iconName: 'chart', tone: 'info', foot: '<span>Of net revenue</span>', small: true })}
    </div>

    <div class="grid-dash">
      <div class="span-5">
        ${card({
          title: 'This month by category',
          body: byCategory.length
            ? donutChart(byCategory, { centreLabel: 'Spent' })
            : emptyState({ iconName: 'wallet', title: 'No expenses this month yet' })
        })}
      </div>
      <div class="span-7">
        ${card({
          title: 'Expense trend',
          sub: 'Last 6 months',
          body: barChart(trend, { color: 'var(--chart-3)' })
        })}
      </div>
    </div>

    <div class="toolbar">
      ${searchBox({ id: 'exp-search', value: state.query, placeholder: 'Search description, reference or note...' })}
      <div class="toolbar-group">
        <select class="select filter-select" id="f-category" aria-label="Filter by category">
          ${options(EXPENSE_CATEGORIES, state.category, { placeholder: 'All categories' })}
        </select>
        <select class="select filter-select" id="f-method" aria-label="Filter by payment method">
          ${options(['Cash', 'POS/Card', 'Bank Transfer', 'Cheque'], state.method, { placeholder: 'All methods' })}
        </select>
        <input class="input filter-select" id="f-from" type="date" value="${state.from}" title="From date" aria-label="From date">
        <input class="input filter-select" id="f-to" type="date" value="${state.to}" title="To date" aria-label="To date">
        ${(state.query || state.category || state.method || state.from || state.to)
          ? '<button class="btn btn-ghost btn-sm" type="button" id="btn-clear">Clear</button>' : ''}
      </div>
    </div>

    ${card({
      title: 'Expense records',
      sub: `${allRows.length} record(s) totalling ${money(sum(allRows, (e) => e.amount))}`,
      flush: true,
      body: renderTable({
        columns,
        rows: pageData.rows,
        sort: { key: state.sortKey, dir: state.sortDir },
        footer: `<tr>
          <td colspan="5">Total for the current filter</td>
          <td class="num">${money(sum(allRows, (e) => e.amount))}</td>
          <td colspan="2"></td>
        </tr>`,
        empty: emptyState({
          iconName: 'wallet',
          title: 'No expenses recorded',
          message: 'Record rent, electricity, salaries and other running costs so net profit is accurate.',
          actions: '<button class="btn btn-primary btn-sm" type="button" id="btn-add-empty">Record expense</button>'
        })
      }) + renderPagination(pageData, { label: 'expenses' })
    })}
  </div>`;

  /* ---------------------------- events ---------------------------- */

  const rerender = () => ctx.refresh();

  const search = qs('#exp-search', root);
  search.addEventListener('input', debounce(() => {
    state.query = search.value;
    state.page = 1;
    const caret = search.selectionStart;
    rerender();
    const next = qs('#exp-search');
    if (next) { next.focus(); next.setSelectionRange(caret, caret); }
  }, 260));

  const bind = (selector, key) => {
    const node = qs(selector, root);
    if (node) node.addEventListener('change', () => { state[key] = node.value; state.page = 1; rerender(); });
  };
  bind('#f-category', 'category');
  bind('#f-method', 'method');
  bind('#f-from', 'from');
  bind('#f-to', 'to');

  const clearBtn = qs('#btn-clear', root);
  if (clearBtn) clearBtn.addEventListener('click', () => {
    Object.assign(state, { query: '', category: '', method: '', from: '', to: '', page: 1 });
    rerender();
  });

  on(root, 'click', '[data-sort]', (event, node) => {
    const key = node.getAttribute('data-sort');
    if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    else { state.sortKey = key; state.sortDir = 'desc'; }
    rerender();
  });

  on(root, 'click', '[data-page]', (event, node) => {
    const page = num(node.getAttribute('data-page'));
    if (page >= 1 && page <= pageData.pages) { state.page = page; rerender(); }
  });

  on(root, 'click', '[data-edit]', (event, node) => openExpenseModal(find('expenses', node.getAttribute('data-edit'))));
  on(root, 'click', '[data-delete]', (event, node) => deleteFlow(node.getAttribute('data-delete')));

  qsa('#btn-add, #btn-add-empty', root).forEach((b) => b.addEventListener('click', () => openExpenseModal()));

  const exportBtn = qs('#btn-export', root);
  if (exportBtn) exportBtn.addEventListener('click', () => {
    downloadCsv(exportName('expenses'), allRows, [
      { label: 'Reference', value: (e) => e.ref },
      { label: 'Date', value: (e) => fmtDate(e.date) },
      { label: 'Category', value: (e) => e.category },
      { label: 'Description', value: (e) => e.description },
      { label: 'Note', value: (e) => e.note },
      { label: 'Payment method', value: (e) => e.method },
      { label: 'Amount', value: (e) => e.amount },
      { label: 'Recorded by', value: (e) => e.userName },
      { label: 'Recorded at', value: (e) => fmtDateTime(e.createdAt) }
    ]);
    notifySuccess('Export ready', `${allRows.length} expenses exported.`);
  });

  qs('#btn-print', root).addEventListener('click', () => {
    const pharmacy = settings().pharmacy;
    const grouped = [...groupBy(allRows, (e) => e.category).entries()]
      .map(([category, rows]) => ({ category, total: round(sum(rows, (e) => e.amount), 2), count: rows.length }));

    printNode(`
      <div class="print-doc">
        ${printHeader({
          pharmacy,
          title: 'Expense Report',
          subtitle: state.from || state.to ? `${state.from ? fmtDate(state.from) : 'Start'} to ${state.to ? fmtDate(state.to) : 'today'}` : 'All records',
          meta: `Generated ${fmtDateTime(new Date())}<br>By ${escapeHtml(ctx.user.name)}<br>${allRows.length} expense(s)`
        })}

        <h2 class="print-section">Summary by category</h2>
        <table>
          <thead><tr><th>Category</th><th class="num">Records</th><th class="num">Total</th><th class="num">Share</th></tr></thead>
          <tbody>${sortBy(grouped, (g) => g.total, 'desc').map((g) => `<tr>
            <td>${escapeHtml(g.category)}</td>
            <td class="num">${int(g.count)}</td>
            <td class="num">${money(g.total)}</td>
            <td class="num">${round((g.total / Math.max(1, sum(allRows, (e) => e.amount))) * 100, 1)}%</td>
          </tr>`).join('')}</tbody>
          <tfoot><tr><td>Total</td><td class="num">${int(allRows.length)}</td>
            <td class="num">${money(sum(allRows, (e) => e.amount))}</td><td class="num">100%</td></tr></tfoot>
        </table>

        <h2 class="print-section">Detailed records</h2>
        <table>
          <thead><tr><th>Date</th><th>Reference</th><th>Category</th><th>Description</th>
            <th>Paid by</th><th class="num">Amount</th><th>Recorded by</th></tr></thead>
          <tbody>${allRows.map((e) => `<tr>
            <td>${fmtDate(e.date)}</td>
            <td>${escapeHtml(e.ref)}</td>
            <td>${escapeHtml(e.category)}</td>
            <td>${escapeHtml(e.description)}</td>
            <td>${escapeHtml(e.method)}</td>
            <td class="num">${money(e.amount)}</td>
            <td>${escapeHtml(e.userName)}</td>
          </tr>`).join('')}</tbody>
          <tfoot><tr><td colspan="5">Total</td>
            <td class="num">${money(sum(allRows, (e) => e.amount))}</td><td></td></tr></tfoot>
        </table>
        ${printFooter({ left: `${escapeHtml(pharmacy.name)} - confidential`, right: 'MediFlow Pharmacy ERP' })}
      </div>`, 'report');
  });
}

export default { render };
