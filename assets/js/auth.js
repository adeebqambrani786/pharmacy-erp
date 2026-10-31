/* ==========================================================================
   MediFlow Pharmacy ERP - Authentication, session & permissions
   --------------------------------------------------------------------------
   Centralises every access decision in the application. UI modules must call
   can() / requirePermission() rather than testing roles themselves, so a
   permission change here applies everywhere (section 3).
   ========================================================================== */

import {
  db, SESSION_KEY, userByUsername, user as findUser, addUser, patchUser,
  removeUser, activeAdminCount, recordActivity, logActivity, tx, save, settings
} from './store.js';
import { makeCredential, verifyPassword, passwordIssue } from './lib/password.js';
import { uid, isoNow, num, isBlank } from './utils.js';

/* ============================== PERMISSIONS ============================== */

/**
 * Every permission the application checks. Grouped only for documentation -
 * the keys are what matters.
 */
export const PERMISSIONS = {
  // Overview
  'dashboard.view': 'View dashboard',
  // Sales
  'pos.use': 'Use point of sale',
  'pos.discount': 'Apply discounts at POS',
  'sales.view.own': 'View own sales',
  'sales.view.all': 'View all staff sales',
  'sales.reprint': 'Reprint receipts',
  'sales.void': 'Void sales',
  'returns.request': 'Request sales returns',
  'returns.approve': 'Approve or reject returns',
  'shift.own': 'Open and close own shift',
  'shift.view.all': 'View all staff shifts',
  // Inventory
  'inventory.view': 'View drug inventory',
  'inventory.manage': 'Add and edit medicines',
  'inventory.cost': 'View cost prices and profit',
  'stock.receive': 'Receive goods',
  'stock.adjust': 'Adjust stock',
  'stock.count': 'Run stock counts',
  'expiry.manage': 'Manage expiry and quarantine',
  'qr.scan': 'Scan QR Codes and barcodes',
  'qr.manage': 'Generate and manage QR Codes',
  'labels.print': 'Print barcode and QR labels',
  // People
  'customers.view': 'View customers',
  'customers.create': 'Add customers',
  'customers.manage': 'Edit customers and credit limits',
  'suppliers.manage': 'Manage suppliers',
  // Finance
  'expenses.manage': 'Manage expenses',
  'reports.view': 'View reports and analytics',
  // Administration
  'users.manage': 'Manage users and permissions',
  'activity.view': 'View activity log',
  'settings.manage': 'Change pharmacy settings',
  'backup.manage': 'Backup, restore and reset data',
  'export.data': 'Export data to CSV'
};

/** Baseline permissions granted to every staff account. */
export const STAFF_DEFAULTS = new Set([
  'dashboard.view',
  'pos.use',
  'sales.view.own',
  'sales.reprint',
  'returns.request',
  'shift.own',
  'inventory.view',
  'qr.scan',
  'customers.view',
  'customers.create'
]);

/**
 * Permissions an administrator may switch on or off per staff account.
 * Everything else is fixed by role.
 */
export const CONFIGURABLE_PERMISSIONS = [
  'pos.discount',
  'returns.request',
  'sales.reprint',
  'customers.create',
  'qr.scan',
  'labels.print',
  'inventory.view'
];

/** Permissions that are never available to a staff account (rule 19). */
export const ADMIN_ONLY = new Set([
  'sales.view.all', 'sales.void', 'returns.approve', 'shift.view.all',
  'inventory.manage', 'inventory.cost', 'stock.receive', 'stock.adjust',
  'stock.count', 'expiry.manage', 'qr.manage', 'customers.manage',
  'suppliers.manage', 'expenses.manage', 'reports.view', 'users.manage',
  'activity.view', 'settings.manage', 'backup.manage'
]);

export class PermissionError extends Error {
  constructor(permission) {
    super(`You do not have permission to ${PERMISSIONS[permission] || permission}.`);
    this.name = 'PermissionError';
    this.permission = permission;
  }
}

/* ============================== SESSION STATE ============================== */

const IDLE_LIMIT_MS = 30 * 60 * 1000; // automatic lock after 30 minutes

let session = null;      // { userId, loginAt, lastActivity, locked }
const watchers = new Set();

export function onSessionChange(handler) {
  watchers.add(handler);
  return () => watchers.delete(handler);
}

function emit(reason) {
  watchers.forEach((fn) => {
    try { fn(reason, currentUser()); } catch (error) { console.error('[auth] watcher failed:', error); }
  });
}

function persistSession() {
  try {
    if (session) window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Session persistence is a convenience; ignore storage failures.
  }
}

/** Forget the session held in memory and in this tab's storage. */
export function clearStoredSession() {
  session = null;
  try { window.sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}

/**
 * Restore a session saved earlier in this tab.
 *
 * A session is only resumed when it is still live: the user exists, is active,
 * and the last recorded activity falls inside the idle window. Everything else
 * is discarded so the caller sends the visitor to the login screen.
 *
 * The lock screen is deliberately unreachable from here. Locking protects a tab
 * that is still open, so a persisted `locked` flag means a stale session: it is
 * discarded rather than resumed, because a reload must not bypass the lock and a
 * fresh visit must never open on the lock screen.
 *
 * @returns {object|null} the signed-in user, or null when the visitor must log in
 */
export function restoreSession() {
  let saved = null;
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (!raw) { session = null; return null; }
    saved = JSON.parse(raw);
  } catch {
    clearStoredSession();
    return null;
  }

  if (!saved || !saved.userId) { clearStoredSession(); return null; }

  const row = findUser(saved.userId);
  if (!row || !row.active) { clearStoredSession(); return null; }

  // A locked session cannot be resumed by reloading the page.
  if (saved.locked) { clearStoredSession(); return null; }

  // A session past its idle window is expired, not locked.
  const lastActivity = new Date(saved.lastActivity || 0).getTime();
  if (!Number.isFinite(lastActivity) || Date.now() - lastActivity > IDLE_LIMIT_MS) {
    clearStoredSession();
    return null;
  }

  session = {
    userId: saved.userId,
    loginAt: saved.loginAt || isoNow(),
    lastActivity: saved.lastActivity,
    locked: false
  };
  persistSession();
  return currentUser();
}

export function currentUser() {
  if (!session) return null;
  return findUser(session.userId);
}

export function isAuthenticated() {
  return !!currentUser();
}

export function isLocked() {
  return !!(session && session.locked);
}

/* ============================== PERMISSION CHECKS ============================== */

/*
 * Access is decided only by can() / canAny() / requirePermission(). There is
 * deliberately no isAdmin() helper: testing a role directly in a screen would
 * bypass the per-user permission overrides an administrator can configure.
 */

/** The authoritative permission test for the signed-in user. */
export function can(permission) {
  const u = currentUser();
  if (!u || !u.active) return false;
  if (session && session.locked) return false;
  if (u.role === 'admin') return true;
  if (ADMIN_ONLY.has(permission)) return false;

  const overrides = u.permissions || {};
  if (Object.prototype.hasOwnProperty.call(overrides, permission)) return !!overrides[permission];
  return STAFF_DEFAULTS.has(permission);
}

/** True when ANY of the given permissions is granted. */
export function canAny(list) {
  return (list || []).some((p) => can(p));
}

/** Throw a PermissionError unless the permission is granted. */
export function requirePermission(permission) {
  if (!can(permission)) throw new PermissionError(permission);
  return true;
}

/** Effective permission map for a user record (used by the users screen). */
export function effectivePermissions(row) {
  const map = {};
  Object.keys(PERMISSIONS).forEach((key) => {
    if (row.role === 'admin') { map[key] = true; return; }
    if (ADMIN_ONLY.has(key)) { map[key] = false; return; }
    const overrides = row.permissions || {};
    map[key] = Object.prototype.hasOwnProperty.call(overrides, key)
      ? !!overrides[key]
      : STAFF_DEFAULTS.has(key);
  });
  return map;
}

/* ============================== LOGIN / LOGOUT ============================== */

/**
 * Authenticate a username/password pair.
 * @returns {Promise<{ok:boolean, user?:object, error?:string, code?:string}>}
 */
export async function login(username, password) {
  const name = String(username || '').trim();
  if (isBlank(name) || isBlank(password)) {
    return { ok: false, code: 'missing', error: 'Enter both your username and password.' };
  }

  const row = userByUsername(name);

  if (!row) {
    // Failed attempts are audited even when the username does not exist (section 4).
    recordActivity({
      user: null, action: 'auth.failed',
      description: `Failed sign-in attempt for unknown username "${name}"`
    });
    return { ok: false, code: 'unknown', error: 'Incorrect username or password.' };
  }

  const valid = await verifyPassword(password, row.salt, row.hash);
  if (!valid) {
    recordActivity({
      user: row, action: 'auth.failed',
      description: `Failed sign-in attempt for ${row.username}`
    });
    return { ok: false, code: 'invalid', error: 'Incorrect username or password.' };
  }

  if (!row.active) {
    recordActivity({
      user: row, action: 'auth.blocked',
      description: `Sign-in blocked - ${row.username} is deactivated`
    });
    return {
      ok: false, code: 'inactive',
      error: 'This account has been deactivated. Contact the pharmacy owner.'
    };
  }

  session = { userId: row.id, loginAt: isoNow(), lastActivity: isoNow(), locked: false };
  persistSession();

  tx(() => {
    row.previousLogin = row.lastLogin || null;
    row.lastLogin = isoNow();
    row.loginCount = num(row.loginCount) + 1;
    logActivity({ user: row, action: 'auth.login', description: `${row.name} signed in` });
  }, 'auth');

  emit('login');
  return { ok: true, user: row };
}

export function logout({ silent = false } = {}) {
  const u = currentUser();
  if (u && !silent) {
    recordActivity({ user: u, action: 'auth.logout', description: `${u.name} signed out` });
  }
  session = null;
  persistSession();
  emit('logout');
}

/* ============================== IDLE LOCKING ============================== */

export function touchSession() {
  if (!session || session.locked) return;
  session.lastActivity = isoNow();
  persistSession();
}

export function isIdle() {
  if (!session) return false;
  return Date.now() - new Date(session.lastActivity).getTime() > IDLE_LIMIT_MS;
}

/**
 * Lock the session if it has gone idle. Called by the application's idle
 * watcher; exported so the rule can be tested without 30 minutes of
 * wall-clock waiting.
 * @returns {boolean} true when this call locked the session
 */
export function enforceIdleLock() {
  if (!isAuthenticated() || isLocked() || !isIdle()) return false;
  lockSession({ reason: 'idle' });
  return true;
}

export function lockSession({ reason = 'idle' } = {}) {
  if (!session || session.locked) return;
  session.locked = true;
  persistSession();
  const u = currentUser();
  if (u) {
    recordActivity({
      user: u, action: 'auth.lock',
      description: reason === 'idle'
        ? `Session locked automatically after 30 minutes of inactivity`
        : 'Session locked'
    });
  }
  emit('lock');
}

/** Unlock the current session by re-entering the signed-in user's password. */
export async function unlockSession(password) {
  const u = currentUser();
  if (!u) return { ok: false, error: 'Your session has ended. Please sign in again.' };
  const valid = await verifyPassword(password, u.salt, u.hash);
  if (!valid) {
    recordActivity({ user: u, action: 'auth.failed', description: 'Incorrect password on session unlock' });
    return { ok: false, error: 'Incorrect password.' };
  }
  session.locked = false;
  session.lastActivity = isoNow();
  persistSession();
  recordActivity({ user: u, action: 'auth.unlock', description: `${u.name} unlocked their session` });
  emit('unlock');
  return { ok: true };
}

export const IDLE_LIMIT_MINUTES = IDLE_LIMIT_MS / 60000;

/* ============================== PASSWORDS ============================== */

/** Change the signed-in user's own password. */
export async function changeOwnPassword({ currentPassword, newPassword, confirmPassword }) {
  const u = currentUser();
  if (!u) return { ok: false, error: 'No active session.' };

  const valid = await verifyPassword(currentPassword, u.salt, u.hash);
  if (!valid) return { ok: false, error: 'Your current password is incorrect.' };

  const issue = passwordIssue(newPassword);
  if (issue) return { ok: false, error: issue };
  if (newPassword !== confirmPassword) return { ok: false, error: 'The new passwords do not match.' };
  if (newPassword === currentPassword) return { ok: false, error: 'Choose a password different from your current one.' };

  const credential = await makeCredential(newPassword);
  patchUser(u.id, { ...credential, passwordChangedAt: isoNow() }, u, `${u.name} changed their own password`);
  return { ok: true };
}

/** Administrator password reset for another account. */
export async function resetUserPassword(userId, newPassword) {
  requirePermission('users.manage');
  const actor = currentUser();
  const row = findUser(userId);
  if (!row) return { ok: false, error: 'User not found.' };

  const issue = passwordIssue(newPassword);
  if (issue) return { ok: false, error: issue };

  const credential = await makeCredential(newPassword);
  patchUser(userId, { ...credential, passwordChangedAt: isoNow(), mustChangePassword: true }, actor,
    `Reset password for ${row.name} (${row.username})`);
  return { ok: true };
}

/* ============================== USER ADMINISTRATION ============================== */

/** Create a staff or administrator account. */
export async function createUser({ name, username, password, role, phone, email, permissions }) {
  requirePermission('users.manage');
  const actor = currentUser();

  if (isBlank(name)) return { ok: false, error: 'Enter the full name.' };
  if (isBlank(username)) return { ok: false, error: 'Enter a username.' };
  if (!/^[a-z0-9._-]{3,20}$/i.test(String(username).trim())) {
    return { ok: false, error: 'Username must be 3-20 characters: letters, numbers, dot, dash or underscore.' };
  }
  if (userByUsername(username)) return { ok: false, error: 'That username is already taken.' };

  const issue = passwordIssue(password);
  if (issue) return { ok: false, error: issue };
  if (role !== 'admin' && role !== 'staff') return { ok: false, error: 'Select a valid role.' };

  const credential = await makeCredential(password);
  const row = {
    id: uid('usr'),
    name: String(name).trim(),
    username: String(username).trim().toLowerCase(),
    role,
    phone: phone || '',
    email: email || '',
    active: true,
    permissions: role === 'staff' ? (permissions || {}) : {},
    ...credential,
    createdAt: isoNow(),
    createdBy: actor ? actor.id : 'system',
    lastLogin: null,
    loginCount: 0
  };
  addUser(row, actor);
  return { ok: true, user: row };
}

/** Update profile fields and (for staff) the configurable permission overrides. */
export function updateUser(userId, { name, phone, email, role, permissions }) {
  requirePermission('users.manage');
  const actor = currentUser();
  const row = findUser(userId);
  if (!row) return { ok: false, error: 'User not found.' };

  // Guard: never leave the pharmacy without an administrator.
  if (role && role !== row.role && row.role === 'admin' && activeAdminCount() <= 1) {
    return { ok: false, error: 'This is the last active administrator - their role cannot be changed.' };
  }
  if (role === 'staff' && row.id === (actor && actor.id)) {
    return { ok: false, error: 'You cannot downgrade your own administrator account.' };
  }

  const patch = {};
  if (name !== undefined) patch.name = String(name).trim();
  if (phone !== undefined) patch.phone = phone;
  if (email !== undefined) patch.email = email;
  if (role !== undefined) patch.role = role;
  if (permissions !== undefined) patch.permissions = (role || row.role) === 'admin' ? {} : permissions;

  patchUser(userId, patch, actor, `Updated account for ${row.name} (${row.username})`);
  return { ok: true, user: findUser(userId) };
}

/** Activate or deactivate an account, with the self-lockout guards of section 24. */
export function setUserActive(userId, active) {
  requirePermission('users.manage');
  const actor = currentUser();
  const row = findUser(userId);
  if (!row) return { ok: false, error: 'User not found.' };

  if (!active) {
    if (actor && row.id === actor.id) return { ok: false, error: 'You cannot deactivate your own account.' };
    if (row.role === 'admin' && activeAdminCount() <= 1) {
      return { ok: false, error: 'The last active administrator cannot be deactivated.' };
    }
  }

  patchUser(userId, { active: !!active }, actor,
    `${active ? 'Activated' : 'Deactivated'} account ${row.username}`);
  return { ok: true };
}

export function deleteUser(userId) {
  requirePermission('users.manage');
  const actor = currentUser();
  const row = findUser(userId);
  if (!row) return { ok: false, error: 'User not found.' };
  if (actor && row.id === actor.id) return { ok: false, error: 'You cannot delete your own account.' };
  if (row.role === 'admin' && activeAdminCount() <= 1) {
    return { ok: false, error: 'The last active administrator cannot be deleted.' };
  }
  try {
    removeUser(userId, actor);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/* ============================== DISPLAY HELPERS ============================== */

export function roleLabel(role) {
  return role === 'admin' ? 'Pharmacy Owner' : 'Pharmacy Staff';
}

/** Theme preference is per-browser, with the pharmacy default as a fallback. */
export function preferredTheme() {
  try {
    const stored = window.localStorage.getItem('mediflow.theme');
    if (stored === 'light' || stored === 'dark') return stored;
  } catch { /* ignore */ }
  return settings()?.other?.theme || 'light';
}

export function setPreferredTheme(theme) {
  try { window.localStorage.setItem('mediflow.theme', theme); } catch { /* ignore */ }
  const u = currentUser();
  if (u && u.role === 'admin') {
    db.settings.other = { ...(db.settings.other || {}), theme };
    save();
  }
}
