/* ==========================================================================
   MediFlow Pharmacy ERP - Application shell
   --------------------------------------------------------------------------
   Boots the data layer, handles authentication screens, renders the sidebar
   and top navigation, enforces route permissions, and mounts page modules.
   ========================================================================== */

import {
  initStore, isStorageAvailable, onChange, db, alerts, settings,
  medicines, stockSummary, expiryBuckets, recordActivity
} from './store.js';
import {
  restoreSession, currentUser, isAuthenticated, isLocked, login, logout,
  unlockSession, lockSession, touchSession, enforceIdleLock, can, canAny,
  roleLabel, onSessionChange, preferredTheme, setPreferredTheme,
  changeOwnPassword, PermissionError, IDLE_LIMIT_MINUTES
} from './auth.js';
import {
  icon, toast, notifySuccess, notifyDenied, openModal, modalFooter, confirmDialog, bindDropdown,
  emptyState, escapeHtml, field
} from './ui.js';
import { el, qs, qsa, initials, fmtDateTime, fmtRelative, num, formData } from './utils.js';

/* ============================== NAVIGATION MAP ============================== */

/**
 * Sidebar structure. `permission` may be a single key or a list (any-of).
 * `badge` names a counter resolved in navBadges().
 */
const NAV_GROUPS = [
  {
    group: 'Overview',
    items: [
      { route: '#/dashboard', label: 'Dashboard', iconName: 'dashboard', permission: 'dashboard.view' }
    ]
  },
  {
    group: 'Sales',
    items: [
      { route: '#/pos', label: 'Point of Sale', iconName: 'pos', permission: 'pos.use' },
      { route: '#/sales', label: 'Sales History', iconName: 'receipt', permission: ['sales.view.all', 'sales.view.own'] },
      { route: '#/returns', label: 'Sales Returns', iconName: 'returnArrow', permission: ['returns.approve', 'returns.request'], badge: 'returns' },
      { route: '#/shift', label: 'Cash & Shifts', iconName: 'cash', permission: ['shift.own', 'shift.view.all'] }
    ]
  },
  {
    group: 'Inventory',
    items: [
      { route: '#/inventory', label: 'Drug Inventory', iconName: 'pill', permission: 'inventory.view', badge: 'lowStock' },
      { route: '#/receive', label: 'Stock Received', iconName: 'truck', permission: 'stock.receive' },
      { route: '#/adjustment', label: 'Stock Adjustment', iconName: 'adjust', permission: 'stock.adjust' },
      { route: '#/stockcount', label: 'Stock Count', iconName: 'clipboard', permission: 'stock.count' },
      { route: '#/expiry', label: 'Expiry & Quarantine', iconName: 'clock', permission: 'expiry.manage', badge: 'expiry' },
      { route: '#/qr', label: 'QR Code Management', iconName: 'qr', permission: 'qr.manage' },
      { route: '#/labels', label: 'Barcode & QR Labels', iconName: 'tag', permission: 'labels.print' }
    ]
  },
  {
    group: 'People',
    items: [
      { route: '#/customers', label: 'Customers', iconName: 'users', permission: 'customers.view' },
      { route: '#/suppliers', label: 'Suppliers', iconName: 'building', permission: 'suppliers.manage' }
    ]
  },
  {
    group: 'Finance',
    items: [
      { route: '#/expenses', label: 'Expenses', iconName: 'wallet', permission: 'expenses.manage' },
      { route: '#/reports', label: 'Reports', iconName: 'chart', permission: 'reports.view' }
    ]
  },
  {
    group: 'Administration',
    items: [
      { route: '#/users', label: 'Users & Permissions', iconName: 'shield', permission: 'users.manage' },
      { route: '#/activity', label: 'Activity Log', iconName: 'history', permission: 'activity.view' },
      { route: '#/settings', label: 'Settings', iconName: 'settings', permission: 'settings.manage' }
    ]
  }
];

/** Lazy page loaders, keyed by route path. */
const PAGE_LOADERS = {
  '/dashboard': () => import('./pages/dashboard.js'),
  '/pos': () => import('./pages/pos.js'),
  '/sales': () => import('./pages/sales.js'),
  '/returns': () => import('./pages/returns.js'),
  '/shift': () => import('./pages/shift.js'),
  '/inventory': () => import('./pages/inventory.js'),
  '/receive': () => import('./pages/receive.js'),
  '/adjustment': () => import('./pages/adjustment.js'),
  '/stockcount': () => import('./pages/stockcount.js'),
  '/expiry': () => import('./pages/expiry.js'),
  '/qr': () => import('./pages/qr.js'),
  '/labels': () => import('./pages/labels.js'),
  '/customers': () => import('./pages/customers.js'),
  '/suppliers': () => import('./pages/suppliers.js'),
  '/expenses': () => import('./pages/expenses.js'),
  '/reports': () => import('./pages/reports.js'),
  '/users': () => import('./pages/users.js'),
  '/activity': () => import('./pages/activity.js'),
  '/settings': () => import('./pages/settings.js')
};

/** Flat route index for permission + breadcrumb lookups. */
const ROUTE_INDEX = new Map();
NAV_GROUPS.forEach((group) => group.items.forEach((item) => {
  ROUTE_INDEX.set(item.route.replace('#', ''), { ...item, group: group.group });
}));

/* ============================== APP STATE ============================== */

const app = {
  route: '/dashboard',
  query: {},
  page: null,          // the mounted module
  destroy: null,       // teardown hook from the mounted module
  collapsed: false,
  navOpen: false,
  booted: false
};

/* ============================== THEME ============================== */

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = qs('#theme-toggle');
  if (btn) {
    btn.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon', 18);
    btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    btn.title = btn.getAttribute('aria-label');
  }
}

function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  setPreferredTheme(next);
  applyTheme(next);
}

/* ============================== VIEW SWITCHING ============================== */

/**
 * Show exactly one top-level view: 'boot' | 'login' | 'app' | 'lock'.
 * Relies on the global `[hidden] { display: none !important }` rule in base.css,
 * without which these views would stack on top of each other.
 */
function showView(name) {
  el('boot-view').hidden = name !== 'boot';
  el('login-view').hidden = name !== 'login';
  el('app-view').hidden = name !== 'app';
  el('lock-view').hidden = name !== 'lock';
}

/* ============================== LOGIN SCREEN ============================== */

function wireLoginScreen() {
  const form = el('login-form');
  const usernameInput = el('login-username');
  const passwordInput = el('login-password');
  const alertBox = el('login-alert');
  const submitBtn = el('login-submit');

  const clearErrors = () => {
    alertBox.hidden = true;
    alertBox.textContent = '';
    [usernameInput, passwordInput].forEach((input) => input.classList.remove('is-invalid'));
    el('login-username-error').hidden = true;
    el('login-password-error').hidden = true;
  };

  // Show / hide password
  el('login-toggle').addEventListener('click', () => {
    const visible = passwordInput.type === 'text';
    passwordInput.type = visible ? 'password' : 'text';
    el('login-toggle').setAttribute('aria-label', visible ? 'Show password' : 'Hide password');
    el('login-toggle').title = visible ? 'Show password' : 'Hide password';
    passwordInput.focus();
  });

  // One-click demo credentials
  qsa('[data-demo-user]').forEach((card) => {
    card.addEventListener('click', () => {
      usernameInput.value = card.getAttribute('data-demo-user');
      passwordInput.value = card.getAttribute('data-demo-pass');
      clearErrors();
      form.requestSubmit();
    });
  });

  [usernameInput, passwordInput].forEach((input) => input.addEventListener('input', clearErrors));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearErrors();

    // Inline validation before hitting the data layer
    let invalid = false;
    if (!usernameInput.value.trim()) {
      usernameInput.classList.add('is-invalid');
      el('login-username-error').textContent = 'Enter your username.';
      el('login-username-error').hidden = false;
      invalid = true;
    }
    if (!passwordInput.value) {
      passwordInput.classList.add('is-invalid');
      el('login-password-error').textContent = 'Enter your password.';
      el('login-password-error').hidden = false;
      invalid = true;
    }
    if (invalid) return;

    submitBtn.classList.add('is-loading');
    submitBtn.disabled = true;

    const result = await login(usernameInput.value, passwordInput.value);

    submitBtn.classList.remove('is-loading');
    submitBtn.disabled = false;

    if (!result.ok) {
      alertBox.innerHTML = `${icon('alertCircle', 15)} <span>${escapeHtml(result.error)}</span>`;
      alertBox.hidden = false;
      passwordInput.value = '';
      passwordInput.focus();
      return;
    }

    passwordInput.value = '';
    enterApplication();
  });
}

/* ============================== LOCK SCREEN ============================== */

function wireLockScreen() {
  const form = el('lock-form');
  const input = el('lock-password');
  const errorNode = el('lock-error');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorNode.hidden = true;
    input.classList.remove('is-invalid');

    const result = await unlockSession(input.value);
    if (!result.ok) {
      input.classList.add('is-invalid');
      errorNode.textContent = result.error;
      errorNode.hidden = false;
      input.value = '';
      input.focus();
      return;
    }
    input.value = '';
    showView('app');
    renderRoute();
  });

  el('lock-logout').addEventListener('click', () => {
    logout();
    showView('login');
  });
}

function showLockScreen() {
  const user = currentUser();
  el('lock-user').textContent = user
    ? `${user.name} - locked after ${IDLE_LIMIT_MINUTES} minutes of inactivity.`
    : `Locked after ${IDLE_LIMIT_MINUTES} minutes of inactivity.`;
  showView('lock');
  setTimeout(() => el('lock-password').focus(), 60);
}

/* ============================== IDLE WATCHER ============================== */

function startIdleWatcher() {
  const activityEvents = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
  activityEvents.forEach((name) => {
    window.addEventListener(name, () => {
      if (isAuthenticated() && !isLocked()) touchSession();
    }, { passive: true });
  });

  // The lock is applied only while the tab is open; auth.js owns the rule.
  setInterval(enforceIdleLock, 20000);
}

/* ============================== SIDEBAR & TOPBAR ============================== */

/** Counters shown as sidebar badges. */
function navBadges() {
  const buckets = expiryBuckets();
  const lowStock = medicines().filter((med) => {
    const summary = stockSummary(med.id);
    return summary.status === 'low' || summary.status === 'out';
  }).length;

  return {
    returns: { count: db.returns.filter((r) => r.status === 'pending').length, tone: 'info' },
    lowStock: { count: lowStock, tone: 'warning' },
    expiry: { count: buckets.expired.length + buckets.d30.length, tone: 'danger' }
  };
}

function renderSidebar() {
  const badges = navBadges();
  const pharmacy = settings().pharmacy || {};

  const groups = NAV_GROUPS.map((group) => {
    const items = group.items.filter((item) => {
      const perms = Array.isArray(item.permission) ? item.permission : [item.permission];
      return canAny(perms);
    });
    if (!items.length) return '';

    const links = items.map((item) => {
      const active = `#${app.route}` === item.route;
      const badge = item.badge ? badges[item.badge] : null;
      return `
        <a class="nav-item${active ? ' is-active' : ''}" href="${item.route}" title="${escapeHtml(item.label)}">
          ${icon(item.iconName, 17)}
          <span>${escapeHtml(item.label)}</span>
          ${badge && badge.count ? `<span class="nav-badge tone-${badge.tone}">${badge.count}</span>` : ''}
        </a>`;
    }).join('');

    return `
      <div class="nav-group">
        <div class="nav-group-label">${escapeHtml(group.group)}</div>
        ${links}
      </div>`;
  }).join('');

  el('sidebar').innerHTML = `
    <div class="sidebar-brand">
      <span class="sidebar-brand-mark">${icon('plus', 19)}</span>
      <div class="sidebar-brand-text">
        <strong>MediFlow</strong>
        <small>Pharmacy ERP</small>
      </div>
    </div>
    <nav class="sidebar-nav">${groups}</nav>
    <div class="sidebar-foot">
      <div class="sidebar-foot-text">${escapeHtml(pharmacy.name || 'MediFlow Pharmacy')}</div>
      <button class="sidebar-collapse-btn" type="button" id="collapse-toggle">
        ${icon('sidebar', 16)}
        <span class="sidebar-foot-text" style="padding:0">${app.collapsed ? 'Expand' : 'Collapse'} sidebar</span>
      </button>
    </div>`;

  qs('#collapse-toggle').addEventListener('click', () => {
    app.collapsed = !app.collapsed;
    try { window.localStorage.setItem('mediflow.sidebar', app.collapsed ? '1' : '0'); } catch { /* ignore */ }
    el('app-view').classList.toggle('is-collapsed', app.collapsed);
    renderSidebar();
  });
}

function renderTopbar() {
  const user = currentUser();
  const route = ROUTE_INDEX.get(app.route);
  const alertList = alerts().filter((a) => !a.adminOnly || can('reports.view'));
  const title = route ? route.label : 'MediFlow';

  el('topbar').innerHTML = `
    <button class="icon-btn nav-toggle" type="button" id="nav-toggle" aria-label="Open navigation">${icon('menu', 19)}</button>
    <div class="topbar-title">
      <h1 id="page-title">${escapeHtml(title)}</h1>
      <div class="breadcrumbs" id="breadcrumbs">
        <a href="#/dashboard">Home</a>
        ${route ? `<span class="sep">/</span><span>${escapeHtml(route.group)}</span>
                   <span class="sep">/</span><span class="current">${escapeHtml(route.label)}</span>` : ''}
      </div>
    </div>
    <div class="topbar-actions">
      <div class="dropdown">
        <button class="icon-btn" type="button" id="notif-toggle" aria-label="Notifications" aria-expanded="false">
          ${icon('bell', 18)}
          ${alertList.length ? '<span class="dot-alert"></span>' : ''}
        </button>
      </div>
      <button class="icon-btn" type="button" id="theme-toggle" aria-label="Switch theme"></button>
      <span class="topbar-sep" aria-hidden="true"></span>
      <div class="dropdown">
        <button class="user-chip" type="button" id="user-toggle" aria-expanded="false">
          <span class="user-avatar">${escapeHtml(initials(user.name))}</span>
          <span class="user-chip-text">
            <strong>${escapeHtml(user.name)}</strong>
            <small>${escapeHtml(roleLabel(user.role))}</small>
          </span>
          ${icon('chevronDown', 15)}
        </button>
      </div>
    </div>`;

  applyTheme(document.documentElement.getAttribute('data-theme') || 'light');

  qs('#nav-toggle').addEventListener('click', () => setNavOpen(true));
  qs('#theme-toggle').addEventListener('click', toggleTheme);

  // Notifications panel
  bindDropdown(qs('#notif-toggle'), () => {
    if (!alertList.length) {
      return `<div class="notif-panel">
        <div class="notif-head"><strong>Notifications</strong></div>
        <div class="empty" style="padding:var(--sp-6)">
          <div class="empty-icon">${icon('checkCircle', 20)}</div>
          <h3>All clear</h3><p>No alerts need your attention.</p>
        </div></div>`;
    }
    const rows = alertList.map((a) => `
      <button class="notif-item" type="button" data-route="${escapeHtml(a.route)}">
        <span class="notif-ico" style="background:var(--${a.tone}-soft);color:var(--${a.tone}-text)">${icon(a.icon === 'return' ? 'returnArrow' : a.icon, 15)}</span>
        <span class="notif-body">
          <strong>${escapeHtml(a.title)}</strong>
          <small>${escapeHtml(a.detail)}</small>
        </span>
      </button>`).join('');
    return `<div class="notif-panel">
      <div class="notif-head"><strong>Notifications</strong>
        <span class="badge badge-neutral" style="margin-left:auto">${alertList.length}</span>
      </div>${rows}</div>`;
  });

  // User menu
  bindDropdown(qs('#user-toggle'), () => `
    <div class="menu-label">${escapeHtml(user.username)} · ${escapeHtml(roleLabel(user.role))}</div>
    <button class="menu-item" type="button" data-action="profile">${icon('user', 16)} My profile</button>
    <button class="menu-item" type="button" data-action="password">${icon('lock', 16)} Change password</button>
    <button class="menu-item" type="button" data-action="shortcuts">${icon('keyboard', 16)} Keyboard shortcuts</button>
    <div class="menu-sep"></div>
    <button class="menu-item" type="button" data-action="lock">${icon('lock', 16)} Lock session</button>
    <button class="menu-item is-danger" type="button" data-action="logout">${icon('logout', 16)} Sign out</button>
  `);
}

function setNavOpen(open) {
  app.navOpen = open;
  el('app-view').classList.toggle('is-nav-open', open);
  el('sidebar-scrim').hidden = !open;
}

/* ============================== PROFILE DIALOGS ============================== */

function openProfileModal() {
  const user = currentUser();
  openModal({
    title: 'My profile',
    size: 'modal-sm',
    iconName: 'user',
    body: `
      <div class="def-grid">
        <div class="def-item"><div class="def-label">Full name</div><div class="def-value">${escapeHtml(user.name)}</div></div>
        <div class="def-item"><div class="def-label">Username</div><div class="def-value mono">${escapeHtml(user.username)}</div></div>
        <div class="def-item"><div class="def-label">Role</div><div class="def-value">${escapeHtml(roleLabel(user.role))}</div></div>
        <div class="def-item"><div class="def-label">Status</div><div class="def-value">${user.active ? 'Active' : 'Deactivated'}</div></div>
        <div class="def-item"><div class="def-label">Phone</div><div class="def-value">${escapeHtml(user.phone || '-')}</div></div>
        <div class="def-item"><div class="def-label">Email</div><div class="def-value">${escapeHtml(user.email || '-')}</div></div>
        <div class="def-item"><div class="def-label">Last sign-in</div><div class="def-value">${fmtDateTime(user.lastLogin)}</div></div>
        <div class="def-item"><div class="def-label">Previous sign-in</div><div class="def-value">${user.previousLogin ? fmtDateTime(user.previousLogin) : '-'}</div></div>
        <div class="def-item"><div class="def-label">Total sign-ins</div><div class="def-value num">${num(user.loginCount)}</div></div>
        <div class="def-item"><div class="def-label">Account created</div><div class="def-value">${fmtDateTime(user.createdAt)}</div></div>
      </div>`,
    footer: '<button class="btn btn-secondary" type="button" data-modal-close>Close</button>'
  });
}

function openChangePasswordModal() {
  const modal = openModal({
    title: 'Change password',
    subtitle: 'Choose a password with at least 6 characters, including a letter and a number.',
    size: 'modal-sm',
    iconName: 'lock',
    body: `
      <form id="pw-form" class="stack-lg" novalidate>
        ${field({ name: 'currentPassword', label: 'Current password', type: 'password', required: true, attrs: 'autocomplete="current-password" autofocus' })}
        ${field({ name: 'newPassword', label: 'New password', type: 'password', required: true, attrs: 'autocomplete="new-password"' })}
        ${field({ name: 'confirmPassword', label: 'Confirm new password', type: 'password', required: true, attrs: 'autocomplete="new-password"' })}
        <div class="auth-alert" id="pw-alert" hidden></div>
      </form>`,
    footer: modalFooter({ confirmLabel: 'Update password' })
  });

  const form = qs('#pw-form', modal.root);
  const alertBox = qs('#pw-alert', modal.root);

  const submit = async () => {
    alertBox.hidden = true;
    modal.setBusy(true);
    const data = formData(form);
    const result = await changeOwnPassword(data);
    modal.setBusy(false);
    if (!result.ok) {
      alertBox.textContent = result.error;
      alertBox.hidden = false;
      return;
    }
    modal.close();
    notifySuccess('Password updated', 'Use your new password at the next sign-in.');
  };

  form.addEventListener('submit', (event) => { event.preventDefault(); submit(); });
  qs('#modal-confirm', modal.root).addEventListener('click', (event) => { event.preventDefault(); submit(); });
}

function openShortcutsModal() {
  const rows = [
    ['F2', 'Open Point of Sale'],
    ['F3', 'Open Drug Inventory'],
    ['F4', 'Open Sales History'],
    ['/', 'Focus the page search box'],
    ['Alt + N', 'Primary action on the current page'],
    ['Esc', 'Close dialog, drawer or menu'],
    ['POS: F9', 'Checkout the current cart'],
    ['POS: F6', 'Hold the current bill'],
    ['POS: F7', 'Resume a held bill'],
    ['POS: F8', 'Clear the cart'],
    ['POS: Up / Down', 'Move through search results'],
    ['POS: Enter', 'Add the highlighted medicine'],
    ['Shift + ?', 'Show this shortcut list']
  ];
  openModal({
    title: 'Keyboard shortcuts',
    size: 'modal-sm',
    iconName: 'keyboard',
    body: `<div class="stack-sm">${rows.map(([key, label]) => `
      <div class="stat-line">
        <span class="sl-label">${escapeHtml(label)}</span>
        <span class="sl-value"><kbd class="key">${escapeHtml(key)}</kbd></span>
      </div>`).join('')}</div>`,
    footer: '<button class="btn btn-secondary" type="button" data-modal-close>Close</button>'
  });
}

async function confirmLogout() {
  const ok = await confirmDialog({
    title: 'Sign out of MediFlow?',
    message: 'Any unsaved work on this page will be lost. Held bills and saved records are kept.',
    confirmLabel: 'Sign out',
    tone: 'danger',
    iconName: 'logout'
  });
  if (!ok) return;
  logout();
  showView('login');
  el('login-username').value = '';
  el('login-password').value = '';
  setTimeout(() => el('login-username').focus(), 60);
}

/* ============================== ROUTER ============================== */

function parseHash() {
  const raw = (window.location.hash || '#/dashboard').slice(1);
  const [path, queryString] = raw.split('?');
  const query = {};
  if (queryString) {
    new URLSearchParams(queryString).forEach((value, key) => { query[key] = value; });
  }
  return { path: path || '/dashboard', query };
}

/** The first route the signed-in user is allowed to open. */
function defaultRoute() {
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      const perms = Array.isArray(item.permission) ? item.permission : [item.permission];
      if (canAny(perms)) return item.route.replace('#', '');
    }
  }
  return '/dashboard';
}

export function navigate(route, { replace = false } = {}) {
  const hash = route.startsWith('#') ? route : `#${route}`;
  if (window.location.hash === hash) { renderRoute(); return; }
  if (replace) window.history.replaceState(null, '', hash);
  else window.location.hash = hash;
  if (replace) renderRoute();
}

/** Re-render the current page in place (used after data changes). */
export function refresh() {
  renderRoute({ keepScroll: true });
}

async function renderRoute({ keepScroll = false } = {}) {
  if (!isAuthenticated()) { showView('login'); return; }
  if (isLocked()) { showLockScreen(); return; }

  const { path, query } = parseHash();
  app.query = query;

  const loader = PAGE_LOADERS[path];
  const routeMeta = ROUTE_INDEX.get(path);

  // Unknown route -> fall back to the user's landing page.
  if (!loader || !routeMeta) {
    navigate(defaultRoute(), { replace: true });
    return;
  }

  // Route-level permission gate (section 3).
  const perms = Array.isArray(routeMeta.permission) ? routeMeta.permission : [routeMeta.permission];
  if (!canAny(perms)) {
    const user = currentUser();
    recordActivity({
      user, action: 'auth.denied',
      description: `Blocked attempt to open ${routeMeta.label}`
    });
    toast({
      title: 'Permission denied',
      message: `Your account cannot open ${routeMeta.label}.`,
      type: 'error'
    });
    navigate(defaultRoute(), { replace: true });
    return;
  }

  app.route = path;
  const pageRoot = el('page-root');
  const scrollY = keepScroll ? window.scrollY : 0;

  // Tear down the previous page.
  if (typeof app.destroy === 'function') {
    try { app.destroy(); } catch (error) { console.error('[app] page teardown failed:', error); }
  }
  app.destroy = null;

  renderSidebar();
  renderTopbar();
  setNavOpen(false);

  pageRoot.innerHTML = `<div class="page"><div class="card">${'<div class="card-body"><div class="skeleton skeleton-row"></div><div class="skeleton skeleton-row"></div><div class="skeleton skeleton-row"></div></div>'}</div></div>`;

  /**
   * Each page is mounted into a FRESH wrapper element rather than into
   * #page-root itself. Pages attach delegated listeners to the root they are
   * given, so reusing one node would stack a new set of handlers on every
   * navigation - stale handlers would then fire alongside the current page's.
   * Replacing the wrapper discards those listeners with the old DOM.
   */
  const mountPage = (module, context) => {
    const view = document.createElement('div');
    view.className = 'page-view';
    pageRoot.replaceChildren(view);
    return module.render(view, context);
  };

  try {
    const module = await loader();
    app.page = module;

    const context = {
      user: currentUser(),
      query,
      navigate,
      refresh,
      route: path
    };

    const result = mountPage(module, context);
    app.destroy = result && typeof result.destroy === 'function' ? result.destroy : (module.destroy || null);

    document.title = `${routeMeta.label} - MediFlow Pharmacy ERP`;
    if (keepScroll) window.scrollTo(0, scrollY);
    else window.scrollTo(0, 0);
  } catch (error) {
    console.error('[app] failed to render page:', error);
    if (error instanceof PermissionError) {
      notifyDenied(error);
      navigate(defaultRoute(), { replace: true });
      return;
    }
    pageRoot.innerHTML = `<div class="page"><div class="card">${emptyState({
      iconName: 'alertCircle',
      title: 'This page could not be loaded',
      message: error.message || 'An unexpected error occurred.',
      actions: '<button class="btn btn-secondary" type="button" data-action="reload">Reload application</button>'
    })}</div></div>`;
  }
}

/* ============================== GLOBAL HANDLERS ============================== */

function wireGlobalHandlers() {
  // Delegated navigation for any element carrying data-route.
  document.addEventListener('click', (event) => {
    const routeTarget = event.target.closest('[data-route]');
    if (routeTarget) {
      event.preventDefault();
      navigate(routeTarget.getAttribute('data-route'));
      return;
    }

    const actionTarget = event.target.closest('[data-action]');
    if (!actionTarget) return;
    const action = actionTarget.getAttribute('data-action');

    switch (action) {
      case 'profile': openProfileModal(); break;
      case 'password': openChangePasswordModal(); break;
      case 'shortcuts': openShortcutsModal(); break;
      case 'lock': lockSession({ reason: 'manual' }); break;
      case 'logout': confirmLogout(); break;
      case 'reload': window.location.reload(); break;
      default: break;
    }
  });

  el('sidebar-scrim').addEventListener('click', () => setNavOpen(false));

  window.addEventListener('hashchange', () => renderRoute());

  // Close the mobile drawer when the viewport grows.
  window.addEventListener('resize', () => {
    if (window.innerWidth > 1024 && app.navOpen) setNavOpen(false);
  });

  // Global keyboard shortcuts.
  document.addEventListener('keydown', (event) => {
    if (!isAuthenticated() || isLocked()) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable;

    if (event.key === '?' && event.shiftKey && !typing) {
      event.preventDefault();
      openShortcutsModal();
      return;
    }
    if (event.key === '/' && !typing) {
      const search = qs('#page-root input[type="search"]');
      if (search) { event.preventDefault(); search.focus(); search.select(); }
      return;
    }
    if (event.key === 'F2' && can('pos.use')) { event.preventDefault(); navigate('/pos'); }
    if (event.key === 'F3' && can('inventory.view')) { event.preventDefault(); navigate('/inventory'); }
    if (event.key === 'F4' && canAny(['sales.view.all', 'sales.view.own'])) { event.preventDefault(); navigate('/sales'); }
  });

  // Sidebar badges follow data changes.
  onChange(() => {
    if (!isAuthenticated() || isLocked() || el('app-view').hidden) return;
    renderSidebar();
    const bell = qs('#notif-toggle .dot-alert');
    const alertList = alerts().filter((a) => !a.adminOnly || can('reports.view'));
    if (alertList.length && !bell) {
      const toggle = qs('#notif-toggle');
      if (toggle) toggle.insertAdjacentHTML('beforeend', '<span class="dot-alert"></span>');
    } else if (!alertList.length && bell) {
      bell.remove();
    }
  });

  // Session transitions
  onSessionChange((reason) => {
    if (reason === 'lock') { showLockScreen(); return; }
    if (reason === 'logout') { showView('login'); return; }
    // A sign-in while the shell is already visible (for example a re-authentication)
    // must rebuild the navigation and page for the new user's permissions. The
    // first sign-in from the login screen is handled by enterApplication().
    if (reason === 'login' && !el('app-view').hidden) {
      navigate(defaultRoute(), { replace: true });
    }
  });
}

/* ============================== BOOT ============================== */

function enterApplication() {
  const user = currentUser();
  if (!user) { showView('login'); return; }

  showView('app');
  el('app-view').classList.toggle('is-collapsed', app.collapsed);

  // Land on the requested route when it is still permitted, else the default.
  const { path } = parseHash();
  const routeMeta = ROUTE_INDEX.get(path);
  const perms = routeMeta
    ? (Array.isArray(routeMeta.permission) ? routeMeta.permission : [routeMeta.permission])
    : [];
  if (!routeMeta || !canAny(perms)) navigate(defaultRoute(), { replace: true });
  else renderRoute();

  notifySuccess(`Welcome back, ${user.name.split(' ').slice(-1)[0]}`,
    user.previousLogin ? `Previous sign-in ${fmtRelative(user.previousLogin)}.` : 'This is your first sign-in.');
}

async function boot() {
  showView('boot');
  applyTheme(preferredTheme());

  try {
    app.collapsed = window.localStorage.getItem('mediflow.sidebar') === '1';
  } catch { /* ignore */ }

  try {
    await initStore();
  } catch (error) {
    console.error('[app] store initialisation failed:', error);
    el('boot-view').innerHTML = `<div class="card card-pad" style="max-width:420px">
      <h2 class="mb-2">MediFlow could not start</h2>
      <p class="sm muted">${escapeHtml(error.message || 'The local database could not be prepared.')}</p>
      <button class="btn btn-primary mt-4" type="button" data-action="reload">Reload</button>
    </div>`;
    return;
  }

  if (!isStorageAvailable()) {
    el('storage-warning').hidden = false;
  }

  applyTheme(preferredTheme());
  wireLoginScreen();
  wireLockScreen();
  wireGlobalHandlers();
  startIdleWatcher();

  app.booted = true;

  /*
   * Boot lands on exactly one of two screens: the application when a live
   * session is resumed, otherwise the login page. The lock screen is never a
   * boot destination - restoreSession() discards an expired or locked session,
   * so a first-time visitor and a returning one both arrive at login.
   */
  const restored = restoreSession();
  if (restored) {
    showView('app');
    el('app-view').classList.toggle('is-collapsed', app.collapsed);
    renderRoute();
  } else {
    showView('login');
    setTimeout(() => el('login-username').focus(), 80);
  }
}

/* Expose a small debug handle for support work in the browser console. */
window.MediFlow = {
  get db() { return db; },
  navigate,
  refresh,
  version: '1.0.0'
};

boot();
