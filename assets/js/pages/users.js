/* ==========================================================================
   MediFlow Pharmacy ERP - Users & Permissions (admin only)
   Create staff accounts, tune the permissions an administrator is allowed to
   delegate, reset passwords and review individual performance. Guard rails stop
   the owner locking themselves out (section 24).
   ========================================================================== */

import {
  users, user as findUser, staffPerformance, salesFor, activityFor, activeAdminCount, shifts,
  settings
} from '../store.js';
import {
  can, requirePermission, createUser, updateUser, setUserActive, deleteUser,
  resetUserPassword, roleLabel, PERMISSIONS, CONFIGURABLE_PERMISSIONS,
  STAFF_DEFAULTS, ADMIN_ONLY, effectivePermissions
} from '../auth.js';
import {
  pageHead, card, kpi, icon, badge, renderTable, cellStack, emptyState, openModal, openDrawer,
  modalFooter, confirmDialog, promptDialog, notifySuccess, notifyError, notifyDenied,
  escapeHtml, field, selectField, options, searchBox, printNode, printHeader, printFooter,
  rankChart
} from '../ui.js';
import {
  money, int, num, fmtDate, fmtDateTime, fmtRelative, sortBy, qs, qsa, on, debounce,
  matchesQuery, sum, formData, validate, rule, showFormErrors, initials, downloadCsv,
  exportName, startOfMonth, endOfDay, percent
} from '../utils.js';

const state = { query: '', role: '', status: '' };

let ctxRef = null;

/* ============================== USER FORM ============================== */

function permissionToggles(row) {
  const effective = row ? effectivePermissions(row) : null;
  return CONFIGURABLE_PERMISSIONS.map((key) => {
    const checked = effective ? effective[key] : STAFF_DEFAULTS.has(key);
    return `
      <label class="switch" style="padding:7px 0;border-bottom:1px solid var(--border);width:100%">
        <input type="checkbox" data-perm="${key}" ${checked ? 'checked' : ''}>
        <span class="switch-track"></span>
        <span class="check-text">${escapeHtml(PERMISSIONS[key])}<small class="mono">${escapeHtml(key)}</small></span>
      </label>`;
  }).join('');
}

function openUserModal(existing = null) {
  try {
    requirePermission('users.manage');
  } catch (error) {
    notifyDenied(error);
    return;
  }

  const editing = !!existing;
  const isSelf = editing && existing.id === ctxRef.user.id;

  const modal = openModal({
    title: editing ? `Edit ${existing.name}` : 'Create a user account',
    subtitle: editing ? `${roleLabel(existing.role)} - ${existing.username}` : 'Staff accounts can sell but never see cost or profit figures',
    size: 'modal-lg',
    iconName: 'user',
    body: `
      <form id="user-form" class="stack-lg" novalidate>
        <div class="grid-2">
          ${field({ name: 'name', label: 'Full name', value: existing ? existing.name : '', required: true, attrs: 'autofocus' })}
          ${editing
            ? `<div class="field"><label class="label">Username</label>
                <input class="input mono" value="${escapeHtml(existing.username)}" readonly>
                <p class="field-hint">Usernames cannot be changed after creation.</p></div>`
            : field({ name: 'username', label: 'Username', required: true, hint: '3-20 characters: letters, numbers, dot, dash or underscore', attrs: 'autocomplete="off" spellcheck="false"' })}
          ${field({ name: 'phone', label: 'Phone number', value: existing ? existing.phone : '', attrs: 'inputmode="tel"' })}
          ${field({ name: 'email', label: 'Email address', type: 'email', value: existing ? existing.email : '' })}
          ${selectField({
            name: 'role', label: 'Role', required: true,
            list: [{ value: 'staff', label: 'Pharmacy Staff' }, { value: 'admin', label: 'Pharmacy Owner (full access)' }],
            value: existing ? existing.role : 'staff',
            attrs: isSelf ? 'disabled' : ''
          })}
          ${editing ? '' : field({
            name: 'password', label: 'Temporary password', type: 'password', required: true,
            hint: 'At least 6 characters with a letter and a number', attrs: 'autocomplete="new-password"'
          })}
        </div>

        ${isSelf ? `<div class="alert alert-info small">${icon('info', 15)}
          <div>This is your own account, so the role cannot be changed here.</div></div>` : ''}

        <div id="perm-section" ${(existing ? existing.role : 'staff') === 'admin' ? 'hidden' : ''}>
          <div class="divider-label mb-3">Permissions you may delegate</div>
          <div class="card card-pad">
            ${permissionToggles(existing)}
            <p class="field-hint mt-3">
              ${icon('shield', 13)} Cost prices, profit figures, stock operations, reports, user
              management and settings are reserved for the pharmacy owner and can never be granted
              to a staff account.
            </p>
          </div>
        </div>
      </form>`,
    footer: modalFooter({ confirmLabel: editing ? 'Save changes' : 'Create account' })
  });

  const form = qs('#user-form', modal.root);
  const roleSelect = form.elements.role;

  roleSelect.addEventListener('change', () => {
    qs('#perm-section', modal.root).hidden = roleSelect.value === 'admin';
  });

  const collectPermissions = () => {
    const permissions = {};
    qsa('[data-perm]', modal.root).forEach((node) => {
      permissions[node.getAttribute('data-perm')] = node.checked;
    });
    return permissions;
  };

  const submit = async () => {
    const data = formData(form);
    const rules = {
      name: [rule.required('Enter the full name'), rule.minLen(3)],
      phone: [rule.phone()],
      email: [rule.email()]
    };
    if (!editing) {
      rules.username = [rule.required('Enter a username'), rule.minLen(3)];
      rules.password = [rule.required('Enter a temporary password'), rule.minLen(6)];
    }
    const { valid, errors } = validate(data, rules);
    if (!valid) { showFormErrors(form, errors); return; }

    modal.setBusy(true);
    try {
      if (editing) {
        const result = updateUser(existing.id, {
          name: data.name,
          phone: data.phone,
          email: data.email,
          role: isSelf ? existing.role : data.role,
          permissions: collectPermissions()
        });
        if (!result.ok) { modal.setBusy(false); notifyError('Could not save', result.error); return; }
        notifySuccess('Account updated', `${data.name} has been saved.`);
      } else {
        const result = await createUser({
          name: data.name,
          username: data.username,
          password: data.password,
          role: data.role,
          phone: data.phone,
          email: data.email,
          permissions: data.role === 'staff' ? collectPermissions() : {}
        });
        if (!result.ok) {
          modal.setBusy(false);
          notifyError('Could not create the account', result.error);
          return;
        }
        notifySuccess('Account created', `${result.user.name} can now sign in as "${result.user.username}".`);
      }
      modal.close();
      ctxRef.refresh();
    } catch (error) {
      modal.setBusy(false);
      notifyError('Something went wrong', error.message);
    }
  };

  form.addEventListener('submit', (event) => { event.preventDefault(); submit(); });
  qs('#modal-confirm', modal.root).addEventListener('click', (event) => { event.preventDefault(); submit(); });
}

/* ============================== PASSWORD RESET ============================== */

async function resetPasswordFlow(userId) {
  const row = findUser(userId);
  if (!row) return;

  const password = await promptDialog({
    title: `Reset the password for ${row.name}?`,
    label: 'New temporary password',
    placeholder: 'At least 6 characters with a letter and a number',
    required: true,
    confirmLabel: 'Reset password',
    tone: 'danger',
    hint: 'Give this password to the user privately and ask them to change it after signing in.'
  });
  if (!password) return;

  const result = await resetUserPassword(userId, password);
  if (!result.ok) { notifyError('Could not reset the password', result.error); return; }
  notifySuccess('Password reset', `${row.name} can sign in with the new password.`);
  ctxRef.refresh();
}

/* ============================== ACTIVATE / DELETE ============================== */

async function toggleActiveFlow(userId) {
  const row = findUser(userId);
  if (!row) return;

  const deactivating = row.active;
  const ok = await confirmDialog({
    title: deactivating ? `Deactivate ${row.name}?` : `Reactivate ${row.name}?`,
    message: deactivating
      ? 'They will be signed out at their next action and cannot sign in again until reactivated. Their sales history is kept.'
      : 'They will be able to sign in again with their existing password.',
    confirmLabel: deactivating ? 'Deactivate account' : 'Reactivate account',
    tone: deactivating ? 'danger' : 'primary',
    iconName: deactivating ? 'lock' : 'checkCircle'
  });
  if (!ok) return;

  const result = setUserActive(userId, !row.active);
  if (!result.ok) { notifyError('Not allowed', result.error); return; }
  notifySuccess(deactivating ? 'Account deactivated' : 'Account reactivated', row.name);
  ctxRef.refresh();
}

async function deleteFlow(userId) {
  const row = findUser(userId);
  if (!row) return;

  const saleCount = salesFor({ userId }).length;
  const ok = await confirmDialog({
    title: `Delete ${row.name}?`,
    message: saleCount
      ? `This account recorded ${saleCount} sale(s). Those transactions stay in the records but will no longer link to a user account.`
      : 'This account has no transactions.',
    detail: 'Deactivating is usually safer than deleting, because it preserves accountability.',
    confirmLabel: 'Delete account',
    tone: 'danger',
    iconName: 'trash',
    requireText: 'DELETE'
  });
  if (!ok) return;

  const result = deleteUser(userId);
  if (!result.ok) { notifyError('Not allowed', result.error); return; }
  notifySuccess('Account deleted', `${row.name} has been removed.`);
  ctxRef.refresh();
}

/* ============================== USER DETAIL ============================== */

function openUserDrawer(userId) {
  const row = findUser(userId);
  if (!row) return;

  const perf = staffPerformance({}).find((p) => p.user.id === userId);
  const monthPerf = staffPerformance({ from: startOfMonth(), to: endOfDay() }).find((p) => p.user.id === userId);
  const recentActivity = activityFor({ userId }).slice(0, 12);
  const userShifts = shifts().filter((s) => s.userId === userId);
  const effective = effectivePermissions(row);
  const granted = Object.keys(PERMISSIONS).filter((key) => effective[key]);
  const denied = Object.keys(PERMISSIONS).filter((key) => !effective[key]);
  const isSelf = row.id === ctxRef.user.id;

  openDrawer({
    title: row.name,
    subtitle: `${roleLabel(row.role)} - ${row.username}`,
    size: 'drawer-lg',
    body: `
      <div class="stack-lg">
        <div class="row-wrap">
          ${row.active ? badge('Active', 'success', { dot: true }) : badge('Deactivated', 'danger', { dot: true })}
          ${badge(roleLabel(row.role), row.role === 'admin' ? 'primary' : 'info')}
          ${isSelf ? badge('This is you', 'neutral') : ''}
          ${row.mustChangePassword ? badge('Password reset pending', 'warning') : ''}
        </div>

        <div class="kpi-grid">
          ${kpi({ label: 'Sales this month', value: money(monthPerf ? monthPerf.revenue : 0), iconName: 'wallet', tone: 'success', foot: `<span>${int(monthPerf ? monthPerf.transactions : 0)} transaction(s)</span>`, small: true })}
          ${kpi({ label: 'Lifetime sales', value: money(perf ? perf.revenue : 0), iconName: 'chart', tone: 'info', foot: `<span>${int(perf ? perf.transactions : 0)} transaction(s)</span>`, small: true })}
          ${kpi({ label: 'Average sale', value: money(perf ? perf.average : 0), iconName: 'percent', small: true })}
          ${kpi({
            label: 'Cash variance',
            value: money(perf ? perf.discrepancy : 0),
            iconName: perf && perf.discrepancy === 0 ? 'checkCircle' : 'alert',
            tone: !perf || perf.discrepancy === 0 ? 'success' : 'danger',
            foot: `<span>${int(perf ? perf.shifts : 0)} closed shift(s)</span>`,
            small: true
          })}
        </div>

        <section>
          <h3 class="mb-3">Account</h3>
          <div class="def-grid">
            <div class="def-item"><div class="def-label">Username</div><div class="def-value mono">${escapeHtml(row.username)}</div></div>
            <div class="def-item"><div class="def-label">Phone</div><div class="def-value">${escapeHtml(row.phone || '-')}</div></div>
            <div class="def-item"><div class="def-label">Email</div><div class="def-value">${escapeHtml(row.email || '-')}</div></div>
            <div class="def-item"><div class="def-label">Created</div><div class="def-value">${fmtDate(row.createdAt)}</div></div>
            <div class="def-item"><div class="def-label">Last sign-in</div><div class="def-value">${row.lastLogin ? fmtDateTime(row.lastLogin) : 'Never'}</div></div>
            <div class="def-item"><div class="def-label">Previous sign-in</div><div class="def-value">${row.previousLogin ? fmtDateTime(row.previousLogin) : '-'}</div></div>
            <div class="def-item"><div class="def-label">Total sign-ins</div><div class="def-value num">${int(row.loginCount)}</div></div>
            <div class="def-item"><div class="def-label">Password last changed</div><div class="def-value">${row.passwordChangedAt ? fmtDate(row.passwordChangedAt) : 'Never'}</div></div>
          </div>
        </section>

        <section>
          <h3 class="mb-3">Payment mix handled</h3>
          <div class="def-grid">
            <div class="def-item"><div class="def-label">Cash</div><div class="def-value num">${money(perf ? perf.cash : 0)}</div></div>
            <div class="def-item"><div class="def-label">POS / Card</div><div class="def-value num">${money(perf ? perf.card : 0)}</div></div>
            <div class="def-item"><div class="def-label">Transfer</div><div class="def-value num">${money(perf ? perf.transfer : 0)}</div></div>
            <div class="def-item"><div class="def-label">Credit</div><div class="def-value num">${money(perf ? perf.credit : 0)}</div></div>
            <div class="def-item"><div class="def-label">Returns raised</div><div class="def-value num">${int(perf ? perf.returns : 0)}</div></div>
            <div class="def-item"><div class="def-label">Units dispensed</div><div class="def-value num">${int(perf ? perf.units : 0)}</div></div>
          </div>
        </section>

        <section>
          <h3 class="mb-3">Effective permissions</h3>
          <div class="row-wrap mb-3">
            ${granted.slice(0, 40).map((key) => `<span class="chip">${icon('check', 12)} ${escapeHtml(PERMISSIONS[key])}</span>`).join('')}
          </div>
          ${row.role === 'staff' ? `
            <details>
              <summary class="small muted" style="cursor:pointer">Show the ${denied.length} permission(s) this account does not have</summary>
              <div class="row-wrap mt-3">
                ${denied.map((key) => `<span class="chip" style="opacity:.6">${escapeHtml(PERMISSIONS[key])}
                  ${ADMIN_ONLY.has(key) ? badge('Owner only', 'neutral') : ''}</span>`).join('')}
              </div>
            </details>` : `
            <div class="alert alert-info small">${icon('shield', 15)}
              <div>Administrators hold every permission in the system.</div></div>`}
        </section>

        ${userShifts.length ? `
          <section>
            <h3 class="mb-3">Recent shifts</h3>
            ${renderTable({
              compact: true,
              responsive: false,
              columns: [
                { key: 'ref', label: 'Shift', cell: (s) => cellStack(s.ref, fmtDate(s.openedAt)) },
                { key: 'status', label: 'Status', cell: (s) => (s.status === 'open' ? badge('Open', 'warning') : badge('Closed', 'success')) },
                { key: 'counted', label: 'Counted', className: 'num', cell: (s) => (s.status === 'closed' ? money(s.countedCash) : '-') },
                {
                  key: 'variance', label: 'Difference', className: 'num',
                  cell: (s) => {
                    if (s.status !== 'closed') return '-';
                    const v = num(s.variance);
                    return v === 0 ? '<span class="c-success">Balanced</span>'
                      : `<span class="${v < 0 ? 'c-danger' : 'c-warning'}">${v > 0 ? '+' : ''}${money(v)}</span>`;
                  }
                }
              ],
              rows: sortBy(userShifts, (s) => s.openedAt, 'desc').slice(0, 8)
            })}
          </section>` : ''}

        <section>
          <h3 class="mb-3">Recent activity</h3>
          ${recentActivity.length ? `<div class="timeline">${recentActivity.map((a) => `
            <div class="timeline-item">
              <div class="row-sm" style="justify-content:space-between">
                <strong class="sm">${escapeHtml(a.action)}</strong>
                <span class="small muted">${fmtRelative(a.datetime)}</span>
              </div>
              <div class="small muted">${escapeHtml(a.description)}</div>
            </div>`).join('')}</div>`
            : emptyState({ iconName: 'history', title: 'No activity recorded' })}
        </section>
      </div>`,
    footer: `
      <button class="btn btn-secondary" type="button" data-reset="${row.id}">${icon('lock', 15)} Reset password</button>
      ${!isSelf ? `<button class="btn ${row.active ? 'btn-danger-soft' : 'btn-soft'}" type="button" data-toggle="${row.id}">
        ${row.active ? 'Deactivate' : 'Reactivate'}</button>` : ''}
      <button class="btn btn-primary" type="button" data-edit="${row.id}">${icon('edit', 15)} Edit account</button>`,
    onMount: (api) => {
      api.root.addEventListener('click', (event) => {
        const reset = event.target.closest('[data-reset]');
        if (reset) { api.close(); resetPasswordFlow(reset.getAttribute('data-reset')); return; }
        const toggle = event.target.closest('[data-toggle]');
        if (toggle) { api.close(); toggleActiveFlow(toggle.getAttribute('data-toggle')); return; }
        const edit = event.target.closest('[data-edit]');
        if (edit) { api.close(); openUserModal(findUser(edit.getAttribute('data-edit'))); }
      });
    }
  });
}

/* ============================== RENDER ============================== */

export function render(root, ctx) {
  ctxRef = ctx;

  let rows = users();
  if (state.query) rows = rows.filter((u) => matchesQuery(`${u.name} ${u.username} ${u.phone} ${u.email}`, state.query));
  if (state.role) rows = rows.filter((u) => u.role === state.role);
  if (state.status) rows = rows.filter((u) => (state.status === 'active' ? u.active : !u.active));
  rows = sortBy(rows, (u) => `${u.role === 'admin' ? 0 : 1}${u.name}`, 'asc');

  const perfAll = staffPerformance({});
  const perfMonth = staffPerformance({ from: startOfMonth(), to: endOfDay() });
  const monthLeaders = sortBy(perfMonth.filter((p) => p.revenue > 0), (p) => p.revenue, 'desc');

  const columns = [
    {
      key: 'name', label: 'User',
      cell: (u) => `<button class="btn-ghost" type="button" data-open="${u.id}" style="text-align:left;display:block;width:100%">
        <span class="row-sm">
          <span class="list-avatar ${u.role === 'admin' ? '' : 'tone-info'}" style="width:32px;height:32px;font-size:11px">${escapeHtml(initials(u.name))}</span>
          <span>${cellStack(u.name, u.username)}</span>
        </span></button>`
    },
    { key: 'role', label: 'Role', cell: (u) => badge(roleLabel(u.role), u.role === 'admin' ? 'primary' : 'info') },
    { key: 'contact', label: 'Contact', cell: (u) => cellStack(u.phone || '-', u.email || '') },
    {
      key: 'sales', label: 'Sales this month', className: 'num',
      cell: (u) => {
        const perf = perfMonth.find((p) => p.user.id === u.id);
        return `${money(perf ? perf.revenue : 0)}<div class="cell-sub">${int(perf ? perf.transactions : 0)} txn</div>`;
      }
    },
    {
      key: 'variance', label: 'Cash variance', className: 'num',
      cell: (u) => {
        const perf = perfAll.find((p) => p.user.id === u.id);
        const v = perf ? perf.discrepancy : 0;
        if (!perf || !perf.shifts) return '<span class="subtle">No shifts</span>';
        return v === 0
          ? '<span class="c-success">Balanced</span>'
          : `<span class="${v < 0 ? 'c-danger' : 'c-warning'}">${v > 0 ? '+' : ''}${money(v)}</span>`;
      }
    },
    { key: 'lastLogin', label: 'Last sign-in', cell: (u) => (u.lastLogin ? cellStack(fmtRelative(u.lastLogin), fmtDateTime(u.lastLogin)) : '<span class="subtle">Never</span>') },
    {
      key: 'status', label: 'Status',
      cell: (u) => (u.active ? badge('Active', 'success', { dot: true }) : badge('Deactivated', 'danger', { dot: true }))
    },
    {
      key: 'actions', label: '', className: 'right',
      cell: (u) => `<div class="table-actions">
        <button class="btn btn-ghost btn-sm" type="button" data-open="${u.id}" title="View account">${icon('eye', 15)}</button>
        <button class="btn btn-ghost btn-sm" type="button" data-edit="${u.id}" title="Edit">${icon('edit', 15)}</button>
        <button class="btn btn-ghost btn-sm" type="button" data-reset="${u.id}" title="Reset password">${icon('lock', 15)}</button>
        ${u.id !== ctx.user.id ? `<button class="btn btn-ghost btn-sm" type="button" data-delete="${u.id}" title="Delete account">${icon('trash', 15)}</button>` : ''}
      </div>`
    }
  ];

  root.innerHTML = `
  <div class="page">
    ${pageHead({
      title: 'Users & Permissions',
      subtitle: 'Create staff accounts, delegate the permissions you choose, and review individual accountability.',
      actions: `
        ${can('export.data') ? `<button class="btn btn-secondary" type="button" id="btn-export">${icon('download', 16)} Export CSV</button>` : ''}
        <button class="btn btn-secondary" type="button" id="btn-print">${icon('print', 16)} Staff report</button>
        <button class="btn btn-primary" type="button" id="btn-add">${icon('plus', 16)} Add user</button>`
    })}

    <div class="kpi-grid">
      ${kpi({ label: 'Total accounts', value: int(users().length), iconName: 'users', foot: `<span>${users().filter((u) => u.active).length} active</span>`, small: true })}
      ${kpi({ label: 'Administrators', value: int(activeAdminCount()), iconName: 'shield', tone: 'primary', foot: '<span>Full access</span>', small: true })}
      ${kpi({ label: 'Staff accounts', value: int(users().filter((u) => u.role === 'staff').length), iconName: 'user', tone: 'info', small: true })}
      ${kpi({ label: 'Deactivated', value: int(users().filter((u) => !u.active).length), iconName: 'lock', tone: users().some((u) => !u.active) ? 'warning' : '', small: true })}
    </div>

    ${monthLeaders.length ? `
      <div class="grid-dash">
        <div class="span-12">
          ${card({
            title: 'Staff sales this month',
            sub: 'Revenue recorded by each account',
            actions: '<button class="btn btn-ghost btn-sm" type="button" data-route="#/reports">Full staff report</button>',
            body: rankChart(monthLeaders.map((p) => ({
              label: p.user.name,
              value: p.revenue,
              sub: `${int(p.transactions)} transaction(s) - average ${money(p.average)} - ${int(p.units)} units`,
              color: p.user.role === 'admin' ? 'var(--chart-1)' : 'var(--chart-2)'
            })))
          })}
        </div>
      </div>` : ''}

    <div class="toolbar">
      ${searchBox({ id: 'user-search', value: state.query, placeholder: 'Search name, username, phone or email...' })}
      <div class="toolbar-group">
        <select class="select filter-select" id="f-role" aria-label="Filter by role">
          ${options([{ value: 'admin', label: 'Administrators' }, { value: 'staff', label: 'Staff' }], state.role, { placeholder: 'All roles' })}
        </select>
        <select class="select filter-select" id="f-status" aria-label="Filter by status">
          ${options([{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Deactivated' }], state.status, { placeholder: 'All statuses' })}
        </select>
        ${(state.query || state.role || state.status) ? '<button class="btn btn-ghost btn-sm" type="button" id="btn-clear">Clear</button>' : ''}
      </div>
    </div>

    ${card({
      flush: true,
      body: renderTable({
        columns,
        rows,
        rowClass: (u) => (!u.active ? 'row-warning' : ''),
        empty: emptyState({ iconName: 'users', title: 'No accounts match', message: 'Clear the filters to see every user.' })
      })
    })}

    ${card({
      title: 'What staff accounts can never do',
      sub: 'These restrictions are enforced in the application logic, not just hidden in the interface',
      body: `
        <div class="grid-2">
          <div class="stack-sm">
            ${['inventory.cost', 'reports.view', 'sales.view.all', 'stock.receive', 'stock.adjust', 'returns.approve']
              .map((key) => `<div class="row-sm">${icon('close', 14, 'c-danger')}
                <span class="sm">${escapeHtml(PERMISSIONS[key])}</span></div>`).join('')}
          </div>
          <div class="stack-sm">
            ${['users.manage', 'settings.manage', 'activity.view', 'backup.manage', 'expiry.manage', 'suppliers.manage']
              .map((key) => `<div class="row-sm">${icon('close', 14, 'c-danger')}
                <span class="sm">${escapeHtml(PERMISSIONS[key])}</span></div>`).join('')}
          </div>
        </div>`
    })}
  </div>`;

  /* ---------------------------- events ---------------------------- */

  const rerender = () => ctx.refresh();

  const search = qs('#user-search', root);
  search.addEventListener('input', debounce(() => {
    state.query = search.value;
    const caret = search.selectionStart;
    rerender();
    const next = qs('#user-search');
    if (next) { next.focus(); next.setSelectionRange(caret, caret); }
  }, 260));

  const bind = (selector, key) => {
    const node = qs(selector, root);
    if (node) node.addEventListener('change', () => { state[key] = node.value; rerender(); });
  };
  bind('#f-role', 'role');
  bind('#f-status', 'status');

  const clearBtn = qs('#btn-clear', root);
  if (clearBtn) clearBtn.addEventListener('click', () => {
    Object.assign(state, { query: '', role: '', status: '' });
    rerender();
  });

  on(root, 'click', '[data-open]', (event, node) => openUserDrawer(node.getAttribute('data-open')));
  on(root, 'click', '[data-edit]', (event, node) => {
    event.stopPropagation();
    openUserModal(findUser(node.getAttribute('data-edit')));
  });
  on(root, 'click', '[data-reset]', (event, node) => {
    event.stopPropagation();
    resetPasswordFlow(node.getAttribute('data-reset'));
  });
  on(root, 'click', '[data-delete]', (event, node) => {
    event.stopPropagation();
    deleteFlow(node.getAttribute('data-delete'));
  });

  qs('#btn-add', root).addEventListener('click', () => openUserModal());

  const exportBtn = qs('#btn-export', root);
  if (exportBtn) exportBtn.addEventListener('click', () => {
    downloadCsv(exportName('users'), perfAll, [
      { label: 'Name', value: (p) => p.user.name },
      { label: 'Username', value: (p) => p.user.username },
      { label: 'Role', value: (p) => roleLabel(p.user.role) },
      { label: 'Phone', value: (p) => p.user.phone },
      { label: 'Email', value: (p) => p.user.email },
      { label: 'Status', value: (p) => (p.user.active ? 'Active' : 'Deactivated') },
      { label: 'Last sign-in', value: (p) => (p.user.lastLogin ? fmtDateTime(p.user.lastLogin) : '') },
      { label: 'Transactions', value: (p) => p.transactions },
      { label: 'Units sold', value: (p) => p.units },
      { label: 'Revenue', value: (p) => p.revenue },
      { label: 'Average sale', value: (p) => p.average },
      { label: 'Returns raised', value: (p) => p.returns },
      { label: 'Closed shifts', value: (p) => p.shifts },
      { label: 'Cash variance', value: (p) => p.discrepancy }
    ]);
    notifySuccess('Export ready', `${perfAll.length} user records exported.`);
  });

  qs('#btn-print', root).addEventListener('click', () => {
    const pharmacy = settings().pharmacy;
    printNode(`
      <div class="print-doc">
        ${printHeader({
          pharmacy,
          title: 'Staff Accountability Report',
          subtitle: 'All time',
          meta: `Generated ${fmtDateTime(new Date())}<br>By ${escapeHtml(ctx.user.name)}`
        })}
        <table>
          <thead><tr>
            <th>Staff member</th><th>Role</th><th>Status</th>
            <th class="num">Transactions</th><th class="num">Units</th>
            <th class="num">Revenue</th><th class="num">Average</th>
            <th class="num">Returns</th><th class="num">Shifts</th><th class="num">Cash variance</th>
          </tr></thead>
          <tbody>${sortBy(perfAll, (p) => p.revenue, 'desc').map((p) => `<tr>
            <td>${escapeHtml(p.user.name)}<br><span style="font-size:7pt">${escapeHtml(p.user.username)}</span></td>
            <td>${escapeHtml(roleLabel(p.user.role))}</td>
            <td>${p.user.active ? 'Active' : 'Deactivated'}</td>
            <td class="num">${int(p.transactions)}</td>
            <td class="num">${int(p.units)}</td>
            <td class="num">${money(p.revenue)}</td>
            <td class="num">${money(p.average)}</td>
            <td class="num">${int(p.returns)}</td>
            <td class="num">${int(p.shifts)}</td>
            <td class="num">${money(p.discrepancy)}</td>
          </tr>`).join('')}</tbody>
          <tfoot><tr>
            <td colspan="3">Totals</td>
            <td class="num">${int(sum(perfAll, (p) => p.transactions))}</td>
            <td class="num">${int(sum(perfAll, (p) => p.units))}</td>
            <td class="num">${money(sum(perfAll, (p) => p.revenue))}</td>
            <td class="num"></td>
            <td class="num">${int(sum(perfAll, (p) => p.returns))}</td>
            <td class="num">${int(sum(perfAll, (p) => p.shifts))}</td>
            <td class="num">${money(sum(perfAll, (p) => p.discrepancy))}</td>
          </tr></tfoot>
        </table>
        ${printFooter({ left: `${escapeHtml(pharmacy.name)} - confidential`, right: 'MediFlow Pharmacy ERP' })}
      </div>`, 'report');
  });
}

export default { render };
