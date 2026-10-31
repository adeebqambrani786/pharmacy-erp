/* ==========================================================================
   MediFlow Pharmacy ERP - Activity Log (admin only)
   An immutable record of every important operation, with the user, role, action
   type, description, timestamp and transaction reference (section 23).
   ========================================================================== */

import { db, activityFor, users, settings } from '../store.js';
import { can } from '../auth.js';
import {
  pageHead, card, kpi, icon, badge, renderTable, cellStack, renderPagination, emptyState,
  notifySuccess, escapeHtml, options, searchBox, printNode, printHeader, printFooter, rankChart,
  barChart
} from '../ui.js';
import {
  int, num, fmtDate, fmtTime, fmtDateTime, fmtRelative, sortBy, paginate, qs, on, debounce,
  groupBy, downloadCsv, exportName, lastNDays, isoDate, startOfDay
} from '../utils.js';

const PER_PAGE = 25;

/**
 * Action groups shown in the filter. The value is matched as a prefix, which is
 * why every action name in the store follows the "domain.verb" convention.
 */
const ACTION_GROUPS = [
  { value: 'auth', label: 'Authentication' },
  { value: 'sale', label: 'Sales' },
  { value: 'return', label: 'Returns' },
  { value: 'stock', label: 'Stock operations' },
  { value: 'medicine', label: 'Medicine records' },
  { value: 'qr', label: 'QR Codes' },
  { value: 'customer', label: 'Customers & credit' },
  { value: 'supplier', label: 'Suppliers' },
  { value: 'expense', label: 'Expenses' },
  { value: 'shift', label: 'Shifts & cash' },
  { value: 'user', label: 'User management' },
  { value: 'settings', label: 'Settings' },
  { value: 'data', label: 'Backup & restore' }
];

/** Icon and tone per action group, used in the table and timeline. */
const ACTION_STYLE = {
  auth: { icon: 'lock', tone: 'neutral' },
  sale: { icon: 'pos', tone: 'success' },
  return: { icon: 'returnArrow', tone: 'warning' },
  stock: { icon: 'box', tone: 'info' },
  medicine: { icon: 'pill', tone: 'primary' },
  qr: { icon: 'qr', tone: 'info' },
  customer: { icon: 'users', tone: 'primary' },
  supplier: { icon: 'building', tone: 'info' },
  expense: { icon: 'wallet', tone: 'warning' },
  shift: { icon: 'cash', tone: 'warning' },
  user: { icon: 'shield', tone: 'danger' },
  settings: { icon: 'settings', tone: 'neutral' },
  data: { icon: 'database', tone: 'danger' }
};

function styleFor(action) {
  const group = String(action).split('.')[0];
  return ACTION_STYLE[group] || { icon: 'info', tone: 'neutral' };
}

const state = { query: '', userId: '', action: '', from: '', to: '', page: 1 };

let ctxRef = null;

/* ============================== RENDER ============================== */

export function render(root, ctx) {
  ctxRef = ctx;

  const rows = sortBy(activityFor({
    userId: state.userId || undefined,
    action: state.action || undefined,
    from: state.from || undefined,
    to: state.to || undefined,
    query: state.query || undefined
  }), (a) => a.datetime, 'desc');

  const pageData = paginate(rows, state.page, PER_PAGE);

  // Totals across the whole log, not just the filtered view.
  const all = db.activity;
  const failedLogins = all.filter((a) => a.action === 'auth.failed');
  const stockOps = all.filter((a) => a.action.startsWith('stock.'));
  const today = all.filter((a) => new Date(a.datetime) >= startOfDay(new Date()));

  // Activity per user (filtered view)
  const byUser = [...groupBy(rows, (a) => a.userName).entries()]
    .map(([name, list]) => ({ label: name, value: list.length, sub: `${list.length} action(s)` }));

  // 14-day activity trend
  const trend = lastNDays(14).map((day) => {
    const count = all.filter((a) => isoDate(a.datetime) === day.iso).length;
    return { label: day.label, value: count, tip: `${day.label}: ${count} action(s)` };
  });

  const columns = [
    {
      key: 'datetime', label: 'When',
      cell: (a) => cellStack(fmtRelative(a.datetime), `${fmtDate(a.datetime)} ${fmtTime(a.datetime)}`)
    },
    {
      key: 'userName', label: 'User',
      cell: (a) => `<span class="row-sm">
        <span class="list-avatar tone-${a.role === 'admin' ? 'primary' : (a.role === 'system' ? 'neutral' : 'info')}"
              style="width:26px;height:26px;font-size:10px">${icon(styleFor(a.action).icon, 13)}</span>
        <span>${cellStack(a.userName, a.role === 'admin' ? 'Owner' : (a.role === 'system' ? 'System' : 'Staff'))}</span>
      </span>`
    },
    {
      key: 'action', label: 'Action',
      cell: (a) => {
        const style = styleFor(a.action);
        return `${badge(a.action, style.tone === 'neutral' ? 'neutral' : style.tone)}`;
      }
    },
    { key: 'description', label: 'Description', cell: (a) => escapeHtml(a.description) },
    {
      key: 'ref', label: 'Reference',
      cell: (a) => (a.ref ? `<span class="mono small">${escapeHtml(a.ref)}</span>` : '<span class="subtle">-</span>')
    }
  ];

  root.innerHTML = `
  <div class="page">
    ${pageHead({
      title: 'Activity Log',
      subtitle: 'A permanent, read-only record of every important operation. Entries can never be edited or deleted.',
      actions: `
        ${can('export.data') ? `<button class="btn btn-secondary" type="button" id="btn-export">${icon('download', 16)} Export CSV</button>` : ''}
        <button class="btn btn-secondary" type="button" id="btn-print">${icon('print', 16)} Print</button>`
    })}

    <div class="kpi-grid">
      ${kpi({ label: 'Entries in the log', value: int(all.length), iconName: 'history', small: true })}
      ${kpi({ label: 'Actions today', value: int(today.length), iconName: 'clock', tone: 'info', small: true })}
      ${kpi({ label: 'Stock operations', value: int(stockOps.length), iconName: 'box', tone: 'warning', foot: '<span>Receipts, adjustments, counts</span>', small: true })}
      ${kpi({ label: 'Failed sign-ins', value: int(failedLogins.length), iconName: 'lock', tone: failedLogins.length ? 'danger' : '', foot: failedLogins.length ? `<span>Last ${fmtRelative(failedLogins[0].datetime)}</span>` : '<span>None recorded</span>', small: true })}
    </div>

    <div class="grid-dash">
      <div class="span-8">
        ${card({
          title: 'Activity over the last 14 days',
          body: barChart(trend, { formatter: (v) => `${int(v)} actions`, color: 'var(--chart-2)' })
        })}
      </div>
      <div class="span-4">
        ${card({
          title: 'Actions by user',
          sub: 'Within the current filter',
          body: byUser.length
            ? rankChart(sortBy(byUser, (r) => r.value, 'desc').slice(0, 6), { formatter: (v) => `${int(v)}` })
            : emptyState({ iconName: 'users', title: 'No activity in this view' })
        })}
      </div>
    </div>

    <div class="toolbar">
      ${searchBox({ id: 'act-search', value: state.query, placeholder: 'Search user, action, description or reference...' })}
      <div class="toolbar-group">
        <select class="select filter-select" id="f-user" aria-label="Filter by user">
          ${options(users().map((u) => ({ value: u.id, label: u.name })), state.userId, { placeholder: 'All users' })}
        </select>
        <select class="select filter-select" id="f-action" aria-label="Filter by action type">
          ${options(ACTION_GROUPS, state.action, { placeholder: 'All action types' })}
        </select>
        <input class="input filter-select" id="f-from" type="date" value="${state.from}" title="From date" aria-label="From date">
        <input class="input filter-select" id="f-to" type="date" value="${state.to}" title="To date" aria-label="To date">
        ${(state.query || state.userId || state.action || state.from || state.to)
          ? '<button class="btn btn-ghost btn-sm" type="button" id="btn-clear">Clear</button>' : ''}
      </div>
    </div>

    ${card({
      sub: `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} match the current filter`,
      flush: true,
      body: renderTable({
        compact: true,
        columns,
        rows: pageData.rows,
        rowClass: (a) => (a.action === 'auth.failed' || a.action === 'auth.denied' ? 'row-warning' : ''),
        empty: emptyState({
          iconName: 'history',
          title: 'No matching activity',
          message: 'Adjust the filters or clear them to see the full log.'
        })
      }) + renderPagination(pageData, { label: 'entries' })
    })}

    <div class="alert alert-neutral">
      ${icon('shield', 17)}
      <div>
        <div class="alert-title">Why this log matters</div>
        <div class="small">Every sale, stock movement, price change, approval, sign-in and settings
        change is written here with the responsible user. Staff accounts cannot read or modify it.
        In this browser-only demo the log is capped at the most recent 4,000 entries - a production
        deployment keeps the full history server-side.</div>
      </div>
    </div>
  </div>`;

  /* ---------------------------- events ---------------------------- */

  const rerender = () => ctx.refresh();

  const search = qs('#act-search', root);
  search.addEventListener('input', debounce(() => {
    state.query = search.value;
    state.page = 1;
    const caret = search.selectionStart;
    rerender();
    const next = qs('#act-search');
    if (next) { next.focus(); next.setSelectionRange(caret, caret); }
  }, 260));

  const bind = (selector, key) => {
    const node = qs(selector, root);
    if (node) node.addEventListener('change', () => { state[key] = node.value; state.page = 1; rerender(); });
  };
  bind('#f-user', 'userId');
  bind('#f-action', 'action');
  bind('#f-from', 'from');
  bind('#f-to', 'to');

  const clearBtn = qs('#btn-clear', root);
  if (clearBtn) clearBtn.addEventListener('click', () => {
    Object.assign(state, { query: '', userId: '', action: '', from: '', to: '', page: 1 });
    rerender();
  });

  on(root, 'click', '[data-page]', (event, node) => {
    const page = num(node.getAttribute('data-page'));
    if (page >= 1 && page <= pageData.pages) { state.page = page; rerender(); }
  });

  const exportBtn = qs('#btn-export', root);
  if (exportBtn) exportBtn.addEventListener('click', () => {
    downloadCsv(exportName('activity-log'), rows, [
      { label: 'Date', value: (a) => fmtDate(a.datetime) },
      { label: 'Time', value: (a) => fmtTime(a.datetime) },
      { label: 'User ID', value: (a) => a.userId },
      { label: 'User', value: (a) => a.userName },
      { label: 'Role', value: (a) => a.role },
      { label: 'Action', value: (a) => a.action },
      { label: 'Description', value: (a) => a.description },
      { label: 'Reference', value: (a) => a.ref }
    ]);
    notifySuccess('Export ready', `${rows.length} log entries exported.`);
  });

  qs('#btn-print', root).addEventListener('click', () => {
    const pharmacy = settings().pharmacy;
    printNode(`
      <div class="print-doc">
        ${printHeader({
          pharmacy,
          title: 'Activity Log',
          subtitle: `${rows.length} entries`,
          meta: `Generated ${fmtDateTime(new Date())}<br>
                 By ${escapeHtml(ctx.user.name)}<br>
                 ${state.from || state.to ? `Period: ${state.from ? fmtDate(state.from) : 'start'} to ${state.to ? fmtDate(state.to) : 'today'}` : 'All dates'}`
        })}
        <table>
          <thead><tr><th>Date &amp; time</th><th>User</th><th>Role</th><th>Action</th><th>Description</th><th>Reference</th></tr></thead>
          <tbody>${rows.slice(0, 600).map((a) => `<tr>
            <td>${fmtDate(a.datetime)} ${fmtTime(a.datetime)}</td>
            <td>${escapeHtml(a.userName)}</td>
            <td>${escapeHtml(a.role)}</td>
            <td>${escapeHtml(a.action)}</td>
            <td>${escapeHtml(a.description)}</td>
            <td>${escapeHtml(a.ref || '-')}</td>
          </tr>`).join('')}</tbody>
        </table>
        ${rows.length > 600 ? '<p class="small">Only the 600 most recent entries are printed. Export to CSV for the full list.</p>' : ''}
        ${printFooter({ left: `${escapeHtml(pharmacy.name)} - confidential audit record`, right: 'MediFlow Pharmacy ERP' })}
      </div>`, 'report');
  });
}

export default { render };
