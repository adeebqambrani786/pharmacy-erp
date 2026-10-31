/* ==========================================================================
   MediFlow Pharmacy ERP - Shared utilities
   Centralised formatting (currency, date, time), id/reference generation,
   array helpers, CSV export, validation and small DOM conveniences.
   Every module must use these helpers so formatting never diverges.
   ========================================================================== */

/* ============================== CONSTANTS ============================== */

export const CURRENCY_SYMBOL = '₦'; // Nigerian Naira
export const MS_DAY = 86400000;

export const DOSAGE_FORMS = [
  'Tablet', 'Capsule', 'Syrup', 'Suspension', 'Injection', 'Infusion',
  'Cream', 'Ointment', 'Gel', 'Eye Drops', 'Ear Drops', 'Nasal Spray',
  'Inhaler', 'Suppository', 'Powder', 'Sachet', 'Lozenge', 'Other'
];

export const CATEGORIES = [
  'Analgesics', 'Antibiotics', 'Antimalarials', 'Antihypertensives',
  'Antidiabetics', 'Antihistamines', 'Vitamins & Supplements',
  'Gastrointestinal', 'Respiratory', 'Dermatology', 'Ophthalmic',
  'Family Planning', 'First Aid & Consumables', 'Other'
];

export const STORAGE_CONDITIONS = [
  'Room temperature (15-25 C)',
  'Cool & dry place',
  'Refrigerated (2-8 C)',
  'Protect from light',
  'Protect from moisture'
];

export const PAYMENT_METHODS = ['Cash', 'POS/Card', 'Bank Transfer', 'Credit'];
export const EXPENSE_CATEGORIES = ['Rent', 'Electricity', 'Salary', 'Transport', 'Maintenance', 'Supplies', 'Other'];
export const ADJUSTMENT_REASONS = [
  'Damaged', 'Expired / Disposed', 'Stock count correction',
  'Lost / Stolen', 'Returned to supplier', 'Internal use', 'Other'
];
export const RETURN_REASONS = [
  'Wrong medicine', 'Customer changed mind', 'Damaged product', 'Expired product', 'Other'
];

/* ============================== NUMBERS & MONEY ============================== */

/** Coerce anything into a finite number, falling back to 0. */
export function num(value, fallback = 0) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Round to a fixed number of decimals without floating point noise. */
export function round(value, decimals = 2) {
  const f = Math.pow(10, decimals);
  return Math.round((num(value) + Number.EPSILON) * f) / f;
}

/** Format a value as Naira currency: 1250 -> "N1,250.00". */
export function money(value, { symbol = true, decimals = 2 } = {}) {
  const n = round(num(value), decimals);
  const formatted = Math.abs(n).toLocaleString('en-NG', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
  const sign = n < 0 ? '-' : '';
  return `${sign}${symbol ? CURRENCY_SYMBOL : ''}${formatted}`;
}

/** Compact money for dense tiles: 1250000 -> "N1.25m". */
export function moneyShort(value) {
  const n = num(value);
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}${CURRENCY_SYMBOL}${round(abs / 1e9, 2)}b`;
  if (abs >= 1e6) return `${sign}${CURRENCY_SYMBOL}${round(abs / 1e6, 2)}m`;
  if (abs >= 1e4) return `${sign}${CURRENCY_SYMBOL}${round(abs / 1e3, 1)}k`;
  return money(n);
}

/** Thousand-separated integer. */
export function int(value) {
  return Math.round(num(value)).toLocaleString('en-NG');
}

/** Percentage with one decimal: 0.1234 is NOT accepted - pass 12.34. */
export function percent(value, decimals = 1) {
  return `${round(num(value), decimals).toFixed(decimals)}%`;
}

/** Safe division that returns 0 instead of NaN/Infinity. */
export function divide(a, b) {
  const d = num(b);
  return d === 0 ? 0 : num(a) / d;
}

export function clamp(value, min, max) {
  return Math.min(Math.max(num(value), min), max);
}

export function sum(list, selector = (x) => x) {
  return (list || []).reduce((total, item) => total + num(selector(item)), 0);
}

/* ============================== DATES & TIME ============================== */

/** Parse anything date-like into a Date, or null when invalid. */
export function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** ISO yyyy-mm-dd of a date (local time), used for <input type="date">. */
export function isoDate(value = new Date()) {
  const d = toDate(value) || new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Full ISO timestamp, the canonical storage format for all records. */
export function isoNow() {
  return new Date().toISOString();
}

/** Display date in Nigerian convention: DD-MM-YYYY. */
export function fmtDate(value) {
  const d = toDate(value);
  if (!d) return '-';
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}-${month}-${d.getFullYear()}`;
}

/** Short month/year display for batch expiry: "Mar 2027". */
export function fmtMonthYear(value) {
  const d = toDate(value);
  if (!d) return '-';
  return d.toLocaleDateString('en-NG', { month: 'short', year: 'numeric' });
}

/** 12-hour clock: "03:45 PM". */
export function fmtTime(value) {
  const d = toDate(value);
  if (!d) return '-';
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${String(h).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
}

/** Combined display: "28-10-2026 03:45 PM". */
export function fmtDateTime(value) {
  const d = toDate(value);
  if (!d) return '-';
  return `${fmtDate(d)} ${fmtTime(d)}`;
}

/** Human relative time: "4 min ago", "2 days ago". */
export function fmtRelative(value) {
  const d = toDate(value);
  if (!d) return '-';
  const diff = Date.now() - d.getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr${hours > 1 ? 's' : ''} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days > 1 ? 's' : ''} ago`;
  return fmtDate(d);
}

/** Midnight of the given day (local). */
export function startOfDay(value = new Date()) {
  const d = toDate(value) || new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

export function endOfDay(value = new Date()) {
  const d = toDate(value) || new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

export function addDays(value, days) {
  const d = toDate(value) || new Date();
  return new Date(d.getTime() + days * MS_DAY);
}

export function startOfMonth(value = new Date()) {
  const d = toDate(value) || new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** Whole days from today until the given date (negative when past). */
export function daysUntil(value) {
  const d = toDate(value);
  if (!d) return Infinity;
  return Math.round((startOfDay(d).getTime() - startOfDay(new Date()).getTime()) / MS_DAY);
}

export function isSameDay(a, b) {
  const x = toDate(a); const y = toDate(b);
  if (!x || !y) return false;
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** List of the last n days as {iso, label, date}, oldest first. */
export function lastNDays(n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = addDays(new Date(), -i);
    out.push({ date: startOfDay(d), iso: isoDate(d), label: d.toLocaleDateString('en-NG', { day: '2-digit', month: 'short' }) });
  }
  return out;
}

/** List of the last n months as {key, label, start, end}, oldest first. */
export function lastNMonths(n) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 0, 23, 59, 59, 999);
    out.push({
      key: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`,
      label: start.toLocaleDateString('en-NG', { month: 'short', year: '2-digit' }),
      start, end
    });
  }
  return out;
}

/** Duration between two instants as "3h 24m". */
export function fmtDuration(from, to = new Date()) {
  const a = toDate(from); const b = toDate(to);
  if (!a || !b) return '-';
  const mins = Math.max(0, Math.round((b.getTime() - a.getTime()) / 60000));
  const h = Math.floor(mins / 60);
  return h ? `${h}h ${mins % 60}m` : `${mins}m`;
}

/* ============================== IDS & REFERENCES ============================== */

let idCounter = 0;

/** Collision-resistant local id: "med_lx8k2p_04". */
export function uid(prefix = 'id') {
  idCounter = (idCounter + 1) % 1000;
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${stamp}${rand}${String(idCounter).padStart(2, '0')}`;
}

/** Human transaction reference: "SL-260128-0042". */
export function makeRef(prefix, serial, date = new Date()) {
  const d = toDate(date) || new Date();
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${prefix}-${yy}${mm}${dd}-${String(serial).padStart(4, '0')}`;
}

/* ============================== STRINGS ============================== */

export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Normalised text used by every search box (case/space insensitive). */
export function norm(value) {
  return String(value || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/** True when every whitespace-separated term of the query appears in the haystack. */
export function matchesQuery(haystack, query) {
  const q = norm(query);
  if (!q) return true;
  const hay = norm(haystack);
  return q.split(' ').every((term) => hay.includes(term));
}

/* ============================== ARRAYS & OBJECTS ============================== */

export function groupBy(list, keyFn) {
  const map = new Map();
  (list || []).forEach((item) => {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  });
  return map;
}

/** Stable multi-direction sort. dir: 'asc' | 'desc'. */
export function sortBy(list, selector, dir = 'asc') {
  const mult = dir === 'desc' ? -1 : 1;
  return [...(list || [])].sort((a, b) => {
    const x = selector(a); const y = selector(b);
    if (x === y) return 0;
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * mult;
    return String(x).localeCompare(String(y), 'en', { numeric: true }) * mult;
  });
}

export function unique(list) {
  return [...new Set(list || [])];
}

export function paginate(list, page, perPage) {
  const items = list || [];
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const current = clamp(page, 1, pages);
  const from = (current - 1) * perPage;
  return {
    rows: items.slice(from, from + perPage),
    page: current, pages, perPage,
    total: items.length,
    from: items.length ? from + 1 : 0,
    to: Math.min(from + perPage, items.length)
  };
}

export function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') {
    try { return structuredClone(value); } catch { /* fall through */ }
  }
  return JSON.parse(JSON.stringify(value));
}

/* ============================== VALIDATION ============================== */

export function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

export function isPhone(value) {
  return /^[0-9+][0-9\s-]{6,19}$/.test(String(value || '').trim());
}

export function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || '').trim());
}

export function isPositive(value) {
  return Number.isFinite(num(value, NaN)) && num(value) > 0;
}

/**
 * Validate a plain object against a rule map.
 * rules: { field: [{ test: fn(value, data) -> bool, message: string }] }
 * Returns { valid, errors: { field: message } }.
 */
export function validate(data, rules) {
  const errors = {};
  Object.entries(rules).forEach(([field, checks]) => {
    for (const check of checks) {
      if (!check.test(data[field], data)) {
        errors[field] = check.message;
        break;
      }
    }
  });
  return { valid: Object.keys(errors).length === 0, errors };
}

export const rule = {
  required: (message = 'This field is required') => ({ test: (v) => !isBlank(v), message }),
  minLen: (n, message) => ({ test: (v) => String(v || '').trim().length >= n, message: message || `Must be at least ${n} characters` }),
  positive: (message = 'Enter a number greater than zero') => ({ test: (v) => isPositive(v), message }),
  minZero: (message = 'Cannot be negative') => ({ test: (v) => num(v) >= 0, message }),
  phone: (message = 'Enter a valid phone number') => ({ test: (v) => isBlank(v) || isPhone(v), message }),
  email: (message = 'Enter a valid email address') => ({ test: (v) => isBlank(v) || isEmail(v), message }),
  date: (message = 'Select a valid date') => ({ test: (v) => !!toDate(v), message }),
  future: (message = 'Date must be in the future') => ({ test: (v) => !!toDate(v) && daysUntil(v) > 0, message }),
  max: (n, message) => ({ test: (v) => num(v) <= n, message: message || `Cannot exceed ${n}` }),
  custom: (test, message) => ({ test, message })
}

;

/* ============================== CSV & FILES ============================== */

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Build CSV text from rows.
 * columns: [{ key, label, value?(row) }]
 */
export function toCsv(rows, columns) {
  const head = columns.map((c) => csvCell(c.label)).join(',');
  const body = (rows || []).map((row) =>
    columns.map((c) => csvCell(c.value ? c.value(row) : row[c.key])).join(',')
  );
  return [head, ...body].join('\r\n');
}

/** Trigger a browser download of text content. */
export function downloadText(filename, text, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob(['﻿', text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function downloadCsv(filename, rows, columns) {
  downloadText(filename, toCsv(rows, columns), 'text/csv;charset=utf-8');
}

export function downloadJson(filename, data) {
  downloadText(filename, JSON.stringify(data, null, 2), 'application/json');
}

/** Read a user-selected file as text. */
export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read the selected file.'));
    reader.readAsText(file);
  });
}

/** Timestamped export filename: "mediflow-sales-20261028-1545.csv". */
export function exportName(slug, ext = 'csv') {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `mediflow-${slug}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
}

/* ============================== DOM HELPERS ============================== */

export function el(id) { return document.getElementById(id); }
export function qs(selector, root = document) { return root.querySelector(selector); }
export function qsa(selector, root = document) { return [...root.querySelectorAll(selector)]; }

/** Delegated event binding; handler receives (event, matchedElement). */
export function on(root, event, selector, handler) {
  if (!root) return () => {};
  const listener = (e) => {
    const target = e.target instanceof Element ? e.target.closest(selector) : null;
    if (target && root.contains(target)) handler(e, target);
  };
  root.addEventListener(event, listener);
  return () => root.removeEventListener(event, listener);
}

export function debounce(fn, wait = 220) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/** Collect a form into a plain object (trimmed strings). */
export function formData(form) {
  const out = {};
  new FormData(form).forEach((value, key) => {
    out[key] = typeof value === 'string' ? value.trim() : value;
  });
  // Unchecked checkboxes are absent from FormData - normalise them to false.
  qsa('input[type="checkbox"]', form).forEach((box) => {
    if (box.name) out[box.name] = box.checked;
  });
  return out;
}

/** Paint validation errors produced by validate() onto a form. */
export function showFormErrors(form, errors) {
  qsa('.field-error[data-for]', form).forEach((n) => { n.hidden = true; n.textContent = ''; });
  qsa('.is-invalid', form).forEach((n) => n.classList.remove('is-invalid'));
  let first = null;
  Object.entries(errors || {}).forEach(([field, message]) => {
    const input = form.elements[field];
    const slot = qs(`.field-error[data-for="${field}"]`, form);
    if (input && input.classList) input.classList.add('is-invalid');
    if (slot) { slot.textContent = message; slot.hidden = false; }
    if (!first && input) first = input;
  });
  if (first && typeof first.focus === 'function') first.focus();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
