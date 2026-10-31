/* ==========================================================================
   MediFlow Pharmacy ERP - Reusable UI components
   --------------------------------------------------------------------------
   Icons, toasts, modals, drawers, confirmation dialogs, tables, pagination,
   badges, empty states, skeletons, SVG charts, QR/barcode rendering and the
   print pipeline. Pages compose these helpers instead of writing raw markup.
   ========================================================================== */

import { escapeHtml, el, qs, qsa, num, round, money, sum, sleep, fmtDate, fmtTime } from './utils.js';
import { qrSvg } from './lib/qrcode.js';
import { code128Svg } from './lib/barcode.js';

/* ============================== ICONS ============================== */

/**
 * Inline SVG icon set. Paths are drawn on a 24x24 grid with a 1.7 stroke so
 * they stay crisp at the 16-20px sizes used across the interface.
 */
const ICONS = {
  dashboard: '<path d="M4 13h7V4H4v9Zm0 7h7v-5H4v5Zm9 0h7v-9h-7v9Zm0-16v5h7V4h-7Z"/>',
  pos: '<path d="M3 6h18l-1.5 9H5.5L4 6Zm1 0-.6-2.4H2m6 16.4a1 1 0 1 0 2 0 1 1 0 0 0-2 0Zm8 0a1 1 0 1 0 2 0 1 1 0 0 0-2 0Z"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Zm3 5h6M9 12h6M9 16h3"/>',
  returnArrow: '<path d="M9 14 4 9l5-5m-5 5h9a6 6 0 0 1 0 12h-4"/>',
  cash: '<path d="M2.5 7.5h19v9h-19v-9Zm9.5 2a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM5.5 10v4m13-4v4"/>',
  box: '<path d="M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Zm0 0v18M3 7.5 12 12l9-4.5"/>',
  truck: '<path d="M2 7h11v9H2V7Zm11 3h4.5l2.5 3v3H13v-6Zm-7 7.5a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0Zm9 0a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0Z"/>',
  adjust: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10m-6-10a2 2 0 1 0 4 0 2 2 0 0 0-4 0ZM6 17a2 2 0 1 0 4 0 2 2 0 0 0-4 0Z"/>',
  clipboard: '<path d="M9 4h6v2.5H9V4Zm-3 1.5h2m8 0h2v15H6v-15h2M9 12h6M9 16h4"/>',
  clock: '<path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v5l3.5 2"/>',
  qr: '<path d="M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h2v2h-2v-2Zm4 0h2v2h-2v-2Zm-4 4h2v2h-2v-2Zm4 0h2v2h-2v-2Z"/>',
  tag: '<path d="M13.5 3H21v7.5L10.5 21 3 13.5 13.5 3Zm3.5 4.5a1 1 0 1 0 2 0 1 1 0 0 0-2 0Z"/>',
  users: '<path d="M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm10 8v-1.5a3.5 3.5 0 0 0-2.5-3.35M15.5 4.2a3.5 3.5 0 0 1 0 6.6"/>',
  user: '<path d="M18 20v-1.5A4.5 4.5 0 0 0 13.5 14h-3A4.5 4.5 0 0 0 6 18.5V20M12 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/>',
  wallet: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H19v2.5M3 7.5V18a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3.5M3 7.5h16.5a1.5 1.5 0 0 1 1.5 1.5v2.5h-4a1.75 1.75 0 0 0 0 3.5h4"/>',
  chart: '<path d="M4 20V10m5 10V4m5 16v-7m5 7V8"/>',
  shield: '<path d="M12 3 5 6v6c0 4.2 2.9 7.9 7 9 4.1-1.1 7-4.8 7-9V6l-7-3Zm-2.5 9 1.8 1.8L15 10"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3 4v4h4m5 0v4.5l3 1.8"/>',
  settings: '<path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm8-3.5c0 .5-.05 1-.14 1.46l2 1.2-1.9 3.3-2.1-.84a7.9 7.9 0 0 1-2.5 1.45L15 21H9l-.36-2.47a7.9 7.9 0 0 1-2.5-1.45l-2.1.84-1.9-3.3 2-1.2a8.4 8.4 0 0 1 0-2.92l-2-1.2 1.9-3.3 2.1.84a7.9 7.9 0 0 1 2.5-1.45L9 3h6l.36 2.47a7.9 7.9 0 0 1 2.5 1.45l2.1-.84 1.9 3.3-2 1.2c.09.46.14.96.14 1.46Z"/>',
  search: '<path d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m4.5 12.5 5 5 10-11"/>',
  checkCircle: '<path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-3.5-9.2 2.4 2.4 4.6-5"/>',
  alert: '<path d="M12 9v5m0 3h.01M10.3 3.9 2.5 17.4A1.9 1.9 0 0 0 4.2 20.3h15.6a1.9 1.9 0 0 0 1.7-2.9L13.7 3.9a1.9 1.9 0 0 0-3.4 0Z"/>',
  alertCircle: '<path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v5m0 3h.01"/>',
  info: '<path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13h.01M11 12h1v5h1"/>',
  edit: '<path d="M4 20h4L19 9a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5 4 20Z"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3m-7 0 .8 13h6.4L16 7"/>',
  eye: '<path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Zm10 2.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2Z"/>',
  print: '<path d="M7 9V3h10v6M7 19H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M7 15h10v6H7v-6Z"/>',
  download: '<path d="M12 4v10m0 0 4-4m-4 4-4-4M4 19h16"/>',
  upload: '<path d="M12 20V10m0 0 4 4m-4-4-8 4m8-4 4-4m-4 4L8 6M4 4h16"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4-2v-4L3 5Z"/>',
  camera: '<path d="M4 8h3l1.5-2h7L17 8h3v11H4V8Zm8 8.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/>',
  scan: '<path d="M4 8V5h3m10 0h3v3M4 16v3h3m10 0h3v-3M7 12h10"/>',
  keyboard: '<path d="M3 6h18v12H3V6Zm3 3h1m3 0h1m3 0h1m3 0h1M6 12h1m3 0h1m3 0h1m3 0h1M8 15h8"/>',
  chevronLeft: '<path d="m14 6-6 6 6 6"/>',
  chevronRight: '<path d="m10 6 6 6-6 6"/>',
  chevronDown: '<path d="m6 10 6 6 6-6"/>',
  chevronUp: '<path d="m6 14 6-6 6 6"/>',
  arrowRight: '<path d="M5 12h14m0 0-5-5m5 5-5 5"/>',
  arrowUp: '<path d="M12 19V5m0 0-5 5m5-5 5 5"/>',
  arrowDown: '<path d="M12 5v14m0 0 5-5m-5 5-5-5"/>',
  logout: '<path d="M15 17l5-5-5-5m5 5H9m0-8H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4"/>',
  lock: '<path d="M4 10.5h16v10H4v-10Zm4 0V7a4 4 0 0 1 8 0v3.5"/>',
  bell: '<path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6ZM10.5 19.5a1.8 1.8 0 0 0 3 0"/>',
  sun: '<path d="M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM12 2v2m0 16v2M4.2 4.2l1.5 1.5m12.6 12.6 1.5 1.5M2 12h2m16 0h2M4.2 19.8l1.5-1.5M18.3 5.7l1.5-1.5"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  sidebar: '<path d="M4 5h16v14H4V5Zm5 0v14"/>',
  pill: '<path d="M8.5 3.5h7a5 5 0 0 1 0 10h-7a5 5 0 0 1 0-10Zm0 0v10M4 20h16"/>',
  flask: '<path d="M9 3h6v5l4.5 9a2 2 0 0 1-1.8 3H6.3a2 2 0 0 1-1.8-3L9 8V3Zm-2.8 11h11.6"/>',
  calendar: '<path d="M4 6h16v15H4V6Zm4-3v4m8-4v4M4 11h16"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14-4.5M4 13a8 8 0 0 0 14 4.5M4 4v4h4m12 12v-4h-4"/>',
  external: '<path d="M14 4h6v6m0-6-9 9M18 14v6H4V6h6"/>',
  copy: '<path d="M9 9h11v11H9V9ZM5 15H4V4h11v1"/>',
  phone: '<path d="M7 3h3l2 5-2.5 1.5a11 11 0 0 0 5 5L16 12l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 5a2 2 0 0 1 2-2h2Z"/>',
  mail: '<path d="M3 6h18v12H3V6Zm0 0 9 7 9-7"/>',
  pin: '<path d="M12 21s7-6 7-11a7 7 0 1 0-14 0c0 5 7 11 7 11Zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"/>',
  building: '<path d="M4 21V5l8-2v18M4 21h16M12 9h8v12M7 8h2m-2 4h2m-2 4h2m7-4h2m-2 4h2"/>',
  percent: '<path d="m5 19 14-14M7.5 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm9 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/>',
  trending: '<path d="m4 16 5-5 3.5 3.5L20 7m0 0h-5m5 0v5"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Zm9 9-9 5-9-5m18 4-9 5-9-5"/>',
  database: '<path d="M12 3c4.4 0 8 1.1 8 2.5S16.4 8 12 8 4 6.9 4 5.5 7.6 3 12 3Zm8 2.5v13c0 1.4-3.6 2.5-8 2.5s-8-1.1-8-2.5v-13m16 6.5c0 1.4-3.6 2.5-8 2.5s-8-1.1-8-2.5"/>',
  shoppingBag: '<path d="M5 7h14l1 14H4L5 7Zm3.5 0V5.5a3.5 3.5 0 0 1 7 0V7"/>',
  star: '<path d="m12 4 2.4 5 5.6.8-4 3.9 1 5.5-5-2.7-5 2.7 1-5.5-4-3.9 5.6-.8L12 4Z"/>'
}

;

/**
 * Render an inline SVG icon.
 * @param {string} name key from ICONS
 * @param {number} size pixel size
 */
export function icon(name, size = 18, extraClass = '') {
  const path = ICONS[name] || ICONS.info;
  return `<svg class="ico ${extraClass}" width="${size}" height="${size}" viewBox="0 0 24 24" `
    + `fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" `
    + `stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

/* ============================== TOASTS ============================== */

const TOAST_ICONS = { success: 'checkCircle', error: 'alertCircle', warning: 'alert', info: 'info' };

/**
 * Show a transient notification.
 * @param {{title:string, message?:string, type?:'success'|'error'|'warning'|'info', timeout?:number}} options
 */
export function toast({ title, message = '', type = 'info', timeout = 4200 }) {
  const root = el('toast-root');
  if (!root) return () => {};

  const node = document.createElement('div');
  node.className = `toast toast-${type}`;
  node.setAttribute('role', type === 'error' ? 'alert' : 'status');
  node.innerHTML = `
    <span class="toast-ico">${icon(TOAST_ICONS[type] || 'info', 18)}</span>
    <div class="toast-body">
      <div class="toast-title">${escapeHtml(title)}</div>
      ${message ? `<div class="toast-msg">${escapeHtml(message)}</div>` : ''}
    </div>
    <button class="toast-x" type="button" aria-label="Dismiss">${icon('close', 15)}</button>
  `;

  const dismiss = () => {
    if (!node.isConnected) return;
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 200);
  };

  qs('.toast-x', node).addEventListener('click', dismiss);
  root.appendChild(node);
  if (timeout) setTimeout(dismiss, timeout);

  // Keep at most five visible notifications.
  const all = qsa('.toast', root);
  if (all.length > 5) all.slice(0, all.length - 5).forEach((n) => n.remove());

  return dismiss;
}

export const notifySuccess = (title, message) => toast({ title, message, type: 'success' });
export const notifyError = (title, message) => toast({ title, message, type: 'error', timeout: 6000 });
export const notifyWarning = (title, message) => toast({ title, message, type: 'warning', timeout: 5200 });
export const notifyInfo = (title, message) => toast({ title, message, type: 'info' });

/** Standard message for a blocked operation. */
export function notifyDenied(error) {
  toast({
    title: 'Permission denied',
    message: error && error.message ? error.message : 'You are not allowed to perform this action.',
    type: 'error',
    timeout: 5200
  });
}

/* ============================== OVERLAY STACK ============================== */

const overlayStack = [];

function pushOverlay(entry) {
  overlayStack.push(entry);
  document.body.style.overflow = 'hidden';
}

function popOverlay(entry) {
  const index = overlayStack.indexOf(entry);
  if (index >= 0) overlayStack.splice(index, 1);
  if (!overlayStack.length) document.body.style.overflow = '';
}

/** Global Escape handling: close the top-most overlay. */
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !overlayStack.length) return;
  const top = overlayStack[overlayStack.length - 1];
  if (top.dismissible) { event.stopPropagation(); top.close(); }
}

);

/** Trap Tab focus inside a container. */
function trapFocus(container, event) {
  const focusables = qsa(
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    container
  ).filter((n) => n.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

/* ============================== MODAL ============================== */

/**
 * Open a modal dialog.
 * @returns {{root:HTMLElement, body:HTMLElement, close:Function, setBusy:Function}}
 */
export function openModal({
  title,
  subtitle = '',
  body = '',
  footer = '',
  size = '',
  iconName = '',
  tone = '',
  dismissible = true,
  onMount = null,
  onClose = null
} = {}) {
  const root = el('modal-root');
  const previousFocus = document.activeElement;

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal ${size}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title || 'Dialog')}">
      <header class="modal-head">
        ${iconName ? `<span class="modal-icon ${tone ? `tone-${tone}` : ''}">${icon(iconName, 19)}</span>` : ''}
        <div class="modal-head-text">
          <h3>${escapeHtml(title || '')}</h3>
          ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}
        </div>
        ${dismissible ? `<button class="modal-close" type="button" data-modal-close aria-label="Close">${icon('close', 17)}</button>` : ''}
      </header>
      <div class="modal-body"></div>
      ${footer ? `<footer class="modal-foot">${footer}</footer>` : ''}
    </div>
  `;

  const modal = qs('.modal', backdrop);
  const bodyNode = qs('.modal-body', backdrop);
  bodyNode.innerHTML = body;

  const entry = { dismissible, close };
  let closed = false;

  function close(result) {
    if (closed) return;
    closed = true;
    popOverlay(entry);
    backdrop.remove();
    if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
    if (onClose) onClose(result);
  }

  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop && dismissible) close();
  });
  backdrop.addEventListener('click', (event) => {
    if (event.target.closest('[data-modal-close]')) close();
  });
  backdrop.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') trapFocus(modal, event);
  });

  root.appendChild(backdrop);
  pushOverlay(entry);

  // Focus the first meaningful control.
  const target = qs('[autofocus]', modal) || qs('input:not([type="hidden"]), select, textarea, button.btn-primary', modal);
  if (target) setTimeout(() => target.focus(), 30);

  const api = {
    root: backdrop,
    modal,
    body: bodyNode,
    footer: qs('.modal-foot', backdrop),
    close,
    setBusy(busy, selector = '.btn-primary') {
      const btn = qs(selector, backdrop);
      if (btn) { btn.classList.toggle('is-loading', !!busy); btn.disabled = !!busy; }
    }
  };

  if (onMount) onMount(api);
  return api;
}

/** Standard footer markup for a two-button modal. */
export function modalFooter({ confirmLabel = 'Save', cancelLabel = 'Cancel', tone = 'primary', confirmId = 'modal-confirm', extra = '' } = {}) {
  return `${extra}
    <button class="btn btn-secondary" type="button" data-modal-close>${escapeHtml(cancelLabel)}</button>
    <button class="btn btn-${tone}" type="submit" id="${confirmId}">${escapeHtml(confirmLabel)}</button>`;
}

/**
 * Confirmation dialog.
 * @returns {Promise<boolean>}
 */
export function confirmDialog({
  title = 'Are you sure?',
  message = '',
  detail = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'primary',
  iconName = 'alert',
  requireText = ''
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const modal = openModal({
      title,
      size: 'modal-sm',
      iconName,
      tone: tone === 'danger' ? 'danger' : (tone === 'warning' ? 'warning' : ''),
      body: `
        ${message ? `<p class="sm">${escapeHtml(message)}</p>` : ''}
        ${detail ? `<div class="alert alert-neutral mt-3 small">${detail}</div>` : ''}
        ${requireText ? `
          <div class="field mt-4">
            <label class="label" for="confirm-text">Type <strong>${escapeHtml(requireText)}</strong> to continue</label>
            <input class="input" id="confirm-text" autocomplete="off" spellcheck="false">
          </div>` : ''}
      `,
      footer: `
        <button class="btn btn-secondary" type="button" data-modal-close>${escapeHtml(cancelLabel)}</button>
        <button class="btn btn-${tone}" type="button" id="confirm-ok" ${requireText ? 'disabled' : ''}>${escapeHtml(confirmLabel)}</button>
      `,
      onClose: () => { if (!settled) { settled = true; resolve(false); } }
    });

    if (requireText) {
      const input = qs('#confirm-text', modal.root);
      const okBtn = qs('#confirm-ok', modal.root);
      input.addEventListener('input', () => {
        okBtn.disabled = input.value.trim().toUpperCase() !== requireText.toUpperCase();
      });
    }

    qs('#confirm-ok', modal.root).addEventListener('click', () => {
      settled = true;
      modal.close();
      resolve(true);
    });
  });
}

/**
 * Single-field prompt, used for void reasons, rejection notes and similar.
 * @returns {Promise<string|null>}
 */
export function promptDialog({
  title = 'Enter a value',
  label = 'Value',
  placeholder = '',
  value = '',
  multiline = false,
  required = true,
  confirmLabel = 'Save',
  tone = 'primary',
  hint = ''
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const modal = openModal({
      title,
      size: 'modal-sm',
      body: `
        <form id="prompt-form" novalidate>
          <div class="field">
            <label class="label" for="prompt-value">${escapeHtml(label)}${required ? '<span class="req">*</span>' : ''}</label>
            ${multiline
              ? `<textarea class="textarea" id="prompt-value" name="value" placeholder="${escapeHtml(placeholder)}" autofocus>${escapeHtml(value)}</textarea>`
              : `<input class="input" id="prompt-value" name="value" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(value)}" autofocus>`}
            <p class="field-error" data-for="value" hidden></p>
            ${hint ? `<p class="field-hint">${escapeHtml(hint)}</p>` : ''}
          </div>
        </form>
      `,
      footer: modalFooter({ confirmLabel, tone }),
      onClose: () => { if (!settled) { settled = true; resolve(null); } }
    });

    const form = qs('#prompt-form', modal.root);
    const submit = () => {
      const input = qs('#prompt-value', modal.root);
      const text = input.value.trim();
      if (required && !text) {
        input.classList.add('is-invalid');
        const slot = qs('.field-error[data-for="value"]', modal.root);
        slot.textContent = 'This field is required.';
        slot.hidden = false;
        input.focus();
        return;
      }
      settled = true;
      modal.close();
      resolve(text);
    };
    form.addEventListener('submit', (event) => { event.preventDefault(); submit(); });
    qs('#modal-confirm', modal.root).addEventListener('click', (event) => { event.preventDefault(); submit(); });
  });
}

/* ============================== DRAWER ============================== */

export function openDrawer({
  title,
  subtitle = '',
  body = '',
  footer = '',
  size = '',
  onMount = null,
  onClose = null
} = {}) {
  const root = el('drawer-root');
  const previousFocus = document.activeElement;

  const backdrop = document.createElement('div');
  backdrop.className = 'drawer-backdrop';
  backdrop.innerHTML = `
    <aside class="drawer ${size}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title || 'Details')}">
      <header class="drawer-head">
        <div class="drawer-head-text">
          <h3>${escapeHtml(title || '')}</h3>
          ${subtitle ? `<p class="small muted mt-1">${escapeHtml(subtitle)}</p>` : ''}
        </div>
        <button class="modal-close" type="button" data-modal-close aria-label="Close">${icon('close', 17)}</button>
      </header>
      <div class="drawer-body"></div>
      ${footer ? `<footer class="drawer-foot">${footer}</footer>` : ''}
    </aside>
  `;

  const panel = qs('.drawer', backdrop);
  const bodyNode = qs('.drawer-body', backdrop);
  bodyNode.innerHTML = body;

  const entry = { dismissible: true, close };
  let closed = false;

  function close(result) {
    if (closed) return;
    closed = true;
    popOverlay(entry);
    backdrop.remove();
    if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
    if (onClose) onClose(result);
  }

  backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop) close(); });
  backdrop.addEventListener('click', (event) => { if (event.target.closest('[data-modal-close]')) close(); });
  backdrop.addEventListener('keydown', (event) => { if (event.key === 'Tab') trapFocus(panel, event); });

  root.appendChild(backdrop);
  pushOverlay(entry);

  const api = { root: backdrop, body: bodyNode, footer: qs('.drawer-foot', backdrop), close };
  if (onMount) onMount(api);
  return api;
}

/* ============================== PAGE LAYOUT ============================== */

/** Standard page header: title, supporting line and right-aligned actions. */
export function pageHead({ title, subtitle = '', actions = '' }) {
  return `
    <header class="page-head">
      <div class="page-head-text">
        <h2>${escapeHtml(title)}</h2>
        ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}
      </div>
      ${actions ? `<div class="page-head-actions">${actions}</div>` : ''}
    </header>`;
}

/**
 * Card with an optional titled header and footer.
 * Pass `flush: true` when the body is a table or list that should meet the edges.
 */
export function card({ title = '', sub = '', actions = '', body = '', footer = '', flush = false, className = '' }) {
  return `
    <section class="card ${className}">
      ${title ? `
        <header class="card-head">
          <div>
            <h3>${escapeHtml(title)}</h3>
            ${sub ? `<div class="card-sub">${escapeHtml(sub)}</div>` : ''}
          </div>
          ${actions ? `<div class="card-head-actions">${actions}</div>` : ''}
        </header>` : ''}
      <div class="card-body${flush ? ' card-body-flush' : ''}">${body}</div>
      ${footer ? `<footer class="card-foot">${footer}</footer>` : ''}
    </section>`;
}

/* ============================== BADGES & CHIPS ============================== */

export function badge(label, tone = 'neutral', { dot = false, large = false } = {}) {
  return `<span class="badge badge-${tone}${large ? ' badge-lg' : ''}">`
    + `${dot ? '<i class="badge-dot"></i>' : ''}${escapeHtml(label)}</span>`;
}

export function statusBadge(state) {
  return badge(state.label, state.tone, { dot: true });
}

/* ============================== EMPTY STATE / SKELETON ============================== */

export function emptyState({ iconName = 'box', title = 'Nothing here yet', message = '', actions = '' } = {}) {
  return `
    <div class="empty">
      <div class="empty-icon">${icon(iconName, 22)}</div>
      <h3>${escapeHtml(title)}</h3>
      ${message ? `<p>${escapeHtml(message)}</p>` : ''}
      ${actions ? `<div class="empty-actions">${actions}</div>` : ''}
    </div>`;
}

/* ============================== TABLES ============================== */

/**
 * Render a data table.
 * columns: [{ key, label, className?, cell?(row, index), sortable?, width? }]
 * The data-label attributes drive the mobile card layout in components.css.
 */
export function renderTable({
  columns,
  rows,
  rowAttrs = null,
  rowClass = null,
  footer = '',
  empty = null,
  compact = false,
  responsive = true,
  sort = null,
  emptyColspan = null
} = {}) {
  if (!rows || !rows.length) {
    return empty || emptyState({ title: 'No records found', message: 'Try adjusting your filters or search terms.' });
  }

  const head = columns.map((col) => {
    const sorted = sort && sort.key === col.key;
    const indicator = col.sortable
      ? `<span class="sort-ind">${sorted ? (sort.dir === 'asc' ? '&#9650;' : '&#9660;') : '&#9671;'}</span>`
      : '';
    return `<th class="${col.className || ''}${col.sortable ? ' sortable' : ''}${sorted ? ' is-sorted' : ''}"`
      + `${col.sortable ? ` data-sort="${escapeHtml(col.key)}"` : ''}`
      + `${col.width ? ` style="width:${col.width}"` : ''}>${escapeHtml(col.label)}${indicator}</th>`;
  }).join('');

  const body = rows.map((row, index) => {
    const attrs = rowAttrs ? rowAttrs(row, index) : '';
    const cls = rowClass ? rowClass(row, index) : '';
    const cells = columns.map((col) => {
      const content = col.cell ? col.cell(row, index) : escapeHtml(row[col.key] ?? '');
      return `<td class="${col.className || ''}" data-label="${escapeHtml(col.label)}">${content}</td>`;
    }).join('');
    return `<tr class="${cls}" ${attrs}>${cells}</tr>`;
  }).join('');

  return `
    <div class="table-wrap">
      <table class="table${compact ? ' table-compact' : ''}${responsive ? ' table-responsive' : ''}">
        <thead><tr>${head}</tr></thead>
        <tbody>${body}</tbody>
        ${footer ? `<tfoot>${footer}</tfoot>` : ''}
      </table>
    </div>`;
}

/** Two-line table cell: strong primary text with muted supporting text. */
export function cellStack(main, sub) {
  return `<div class="cell-main">${escapeHtml(main)}</div>`
    + (sub ? `<div class="cell-sub">${escapeHtml(sub)}</div>` : '');
}

/** Pagination control for a paginate() result. */
export function renderPagination(state, { label = 'records' } = {}) {
  if (!state || state.total === 0) return '';
  const { page, pages, from, to, total } = state;

  const windowed = [];
  const add = (n) => { if (!windowed.includes(n) && n >= 1 && n <= pages) windowed.push(n); };
  add(1); add(2);
  for (let p = page - 1; p <= page + 1; p++) add(p);
  add(pages - 1); add(pages);
  windowed.sort((a, b) => a - b);

  let buttons = '';
  let previous = 0;
  windowed.forEach((p) => {
    if (previous && p - previous > 1) buttons += '<span class="page-btn" aria-hidden="true">…</span>';
    buttons += `<button class="page-btn${p === page ? ' is-active' : ''}" type="button" data-page="${p}">${p}</button>`;
    previous = p;
  });

  return `
    <div class="pagination">
      <span class="pagination-info">Showing <strong>${from}-${to}</strong> of <strong>${total}</strong> ${escapeHtml(label)}</span>
      <div class="pagination-pages">
        <button class="page-btn" type="button" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''} aria-label="Previous page">${icon('chevronLeft', 15)}</button>
        ${buttons}
        <button class="page-btn" type="button" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''} aria-label="Next page">${icon('chevronRight', 15)}</button>
      </div>
    </div>`;
}

/* ============================== KPI TILES ============================== */

/**
 * KPI tile.
 * @param {{label:string, value:string, iconName?:string, tone?:string, foot?:string, route?:string, small?:boolean}} config
 */
export function kpi({ label, value, iconName = 'chart', tone = '', foot = '', route = '', small = false }) {
  const tag = route ? 'button' : 'div';
  const attrs = route ? ` type="button" data-route="${escapeHtml(route)}"` : '';
  return `
    <${tag} class="kpi${route ? ' is-link' : ''}"${attrs}>
      <div class="kpi-top">
        <span class="kpi-label">${escapeHtml(label)}</span>
        <span class="kpi-icon${tone ? ` tone-${tone}` : ''}">${icon(iconName, 16)}</span>
      </div>
      <div class="kpi-value${small ? ' sm-value' : ''}">${value}</div>
      ${foot ? `<div class="kpi-foot">${foot}</div>` : ''}
    </${tag}>`;
}

/* ============================== FORM HELPERS ============================== */

/** Build an <option> list, marking the selected value. */
export function options(list, selected = '', { placeholder = '' } = {}) {
  const items = list.map((item) => {
    const value = typeof item === 'object' ? item.value : item;
    const label = typeof item === 'object' ? item.label : item;
    const disabled = typeof item === 'object' && item.disabled ? ' disabled' : '';
    return `<option value="${escapeHtml(value)}"${String(value) === String(selected) ? ' selected' : ''}${disabled}>${escapeHtml(label)}</option>`;
  }).join('');
  return (placeholder ? `<option value="">${escapeHtml(placeholder)}</option>` : '') + items;
}

/**
 * Standard labelled field wrapper.
 * @param {{name:string, label:string, type?:string, value?:any, required?:boolean, hint?:string, attrs?:string, control?:string}} config
 */
export function field({
  name, label, type = 'text', value = '', required = false, hint = '',
  attrs = '', control = '', placeholder = '', className = ''
}

) {
  const inner = control || (type === 'textarea'
    ? `<textarea class="textarea" id="f-${name}" name="${name}" placeholder="${escapeHtml(placeholder)}" ${attrs}>${escapeHtml(value)}</textarea>`
    : `<input class="input" id="f-${name}" name="${name}" type="${type}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" ${attrs}>`);
  return `
    <div class="field ${className}">
      <label class="label" for="f-${name}">${escapeHtml(label)}${required ? '<span class="req">*</span>' : ''}</label>
      ${inner}
      <p class="field-error" data-for="${name}" hidden></p>
      ${hint ? `<p class="field-hint">${escapeHtml(hint)}</p>` : ''}
    </div>`;
}

export function selectField({ name, label, list, value = '', required = false, placeholder = '', hint = '', attrs = '' }) {
  return field({
    name, label, required, hint,
    control: `<select class="select" id="f-${name}" name="${name}" ${attrs}>${options(list, value, { placeholder })}</select>`
  });
}

export function checkField({ name, label, hint = '', checked = false, attrs = '' }) {
  return `
    <label class="check">
      <input type="checkbox" name="${name}" id="f-${name}" ${checked ? 'checked' : ''} ${attrs}>
      <span class="check-text">${escapeHtml(label)}${hint ? `<small>${escapeHtml(hint)}</small>` : ''}</span>
    </label>`;
}

export function switchField({ name, label, checked = false, hint = '' }) {
  return `
    <label class="switch">
      <input type="checkbox" name="${name}" id="f-${name}" ${checked ? 'checked' : ''}>
      <span class="switch-track"></span>
      <span class="check-text">${escapeHtml(label)}${hint ? `<small>${escapeHtml(hint)}</small>` : ''}</span>
    </label>`;
}

/** Search input with a leading magnifier. */
export function searchBox({ id = 'search', value = '', placeholder = 'Search...' } = {}) {
  return `
    <div class="search-box">
      ${icon('search', 16)}
      <input class="input" id="${id}" type="search" value="${escapeHtml(value)}"
             placeholder="${escapeHtml(placeholder)}" autocomplete="off" spellcheck="false">
    </div>`;
}

/** Quantity stepper used in POS and receiving lines. */
export function qtyStepper({ value = 1, min = 1, max = 9999, name = 'qty', dataset = '' } = {}) {
  return `
    <span class="qty-stepper">
      <button type="button" data-step="-1" ${dataset} aria-label="Decrease">${icon('minus', 14)}</button>
      <input type="number" name="${name}" value="${num(value)}" min="${min}" max="${max}" ${dataset} aria-label="Quantity">
      <button type="button" data-step="1" ${dataset} aria-label="Increase">${icon('plus', 14)}</button>
    </span>`;
}

/* ============================== CHARTS ============================== */

const CHART_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)'];

/** Pick a nice axis maximum so gridlines land on round numbers. */
function niceMax(value) {
  if (value <= 0) return 10;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const normalised = value / magnitude;
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}

function axisLabel(value) {
  const n = num(value);
  if (Math.abs(n) >= 1e6) return `${round(n / 1e6, 1)}m`;
  if (Math.abs(n) >= 1e3) return `${round(n / 1e3, 0)}k`;
  return String(round(n, 0));
}

/**
 * Vertical bar chart.
 * data: [{ label, value, tip? }]
 */
export function barChart(data, { height = 190, formatter = money, color = 'var(--chart-1)', showGrid = true } = {}) {
  if (!data || !data.length) return emptyState({ iconName: 'chart', title: 'No data for this period' });

  const width = 640;
  const padL = 46; const padR = 10; const padT = 12; const padB = 26;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const max = niceMax(Math.max(...data.map((d) => num(d.value)), 0));
  const slot = innerW / data.length;
  const barW = Math.max(4, Math.min(38, slot * 0.6));

  const grid = showGrid ? [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const y = padT + innerH - innerH * f;
    return `<line class="grid-line" x1="${padL}" y1="${y}" x2="${width - padR}" y2="${y}"/>`
      + `<text x="${padL - 7}" y="${y + 3.5}" text-anchor="end">${axisLabel(max * f)}</text>`;
  }).join('') : '';

  const bars = data.map((d, i) => {
    const value = num(d.value);
    const h = max ? Math.max(value > 0 ? 2 : 0, (value / max) * innerH) : 0;
    const x = padL + slot * i + (slot - barW) / 2;
    const y = padT + innerH - h;
    const showLabel = data.length <= 16 || i % Math.ceil(data.length / 12) === 0;
    return `
      <rect class="bar" x="${x}" y="${y}" width="${barW}" height="${h}" rx="3" fill="${d.color || color}"
            data-tip="${escapeHtml(d.tip || `${d.label}: ${formatter(value)}`)}"/>
      ${showLabel ? `<text x="${x + barW / 2}" y="${height - 8}" text-anchor="middle">${escapeHtml(d.label)}</text>` : ''}`;
  }).join('');

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="height:${height}px">
    ${grid}<line class="axis-line" x1="${padL}" y1="${padT + innerH}" x2="${width - padR}" y2="${padT + innerH}"/>${bars}
  </svg>`;
}

/**
 * Line / area chart with optional second series.
 * data: [{ label, value, value2? }]
 */
export function lineChart(data, {
  height = 200, formatter = money, color = 'var(--chart-1)',
  color2 = 'var(--chart-2)', fill = true, series2Label = ''
} = {}) {
  if (!data || !data.length) return emptyState({ iconName: 'chart', title: 'No data for this period' });

  const width = 680;
  const padL = 46; const padR = 12; const padT = 12; const padB = 26;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const hasSecond = data.some((d) => d.value2 !== undefined);
  const max = niceMax(Math.max(...data.map((d) => Math.max(num(d.value), num(d.value2))), 0));
  const stepX = data.length > 1 ? innerW / (data.length - 1) : 0;

  const pointAt = (d, i, key = 'value') => ({
    x: padL + stepX * i,
    y: padT + innerH - (max ? (num(d[key]) / max) * innerH : 0)
  });

  const buildPath = (key) => data.map((d, i) => {
    const p = pointAt(d, i, key);
    return `${i === 0 ? 'M' : 'L'}${round(p.x, 2)} ${round(p.y, 2)}`;
  }).join(' ');

  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const y = padT + innerH - innerH * f;
    return `<line class="grid-line" x1="${padL}" y1="${y}" x2="${width - padR}" y2="${y}"/>`
      + `<text x="${padL - 7}" y="${y + 3.5}" text-anchor="end">${axisLabel(max * f)}</text>`;
  }).join('');

  const areaPath = `${buildPath('value')} L${round(padL + stepX * (data.length - 1), 2)} ${padT + innerH} L${padL} ${padT + innerH} Z`;

  const dots = data.map((d, i) => {
    const p = pointAt(d, i);
    const every = Math.ceil(data.length / 20);
    if (data.length > 20 && i % every !== 0) return '';
    return `<circle class="point" cx="${round(p.x, 2)}" cy="${round(p.y, 2)}" r="3.2" fill="${color}"
      data-tip="${escapeHtml(d.tip || `${d.label}: ${formatter(d.value)}${hasSecond ? ` | ${series2Label}: ${formatter(d.value2)}` : ''}`)}"/>`;
  }).join('');

  const labels = data.map((d, i) => {
    const every = Math.ceil(data.length / 10);
    if (i % every !== 0 && i !== data.length - 1) return '';
    const p = pointAt(d, i);
    return `<text x="${round(p.x, 2)}" y="${height - 8}" text-anchor="middle">${escapeHtml(d.label)}</text>`;
  }).join('');

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="height:${height}px">
    <defs>
      <linearGradient id="mf-area" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity=".22"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${grid}
    <line class="axis-line" x1="${padL}" y1="${padT + innerH}" x2="${width - padR}" y2="${padT + innerH}"/>
    ${fill ? `<path class="area-path" d="${areaPath}" fill="url(#mf-area)"/>` : ''}
    ${hasSecond ? `<path class="line-path" d="${buildPath('value2')}" stroke="${color2}" stroke-dasharray="4 3"/>` : ''}
    <path class="line-path" d="${buildPath('value')}" stroke="${color}"/>
    ${dots}${labels}
  </svg>`;
}

/**
 * Donut chart with centre total.
 * data: [{ label, value }]
 */
export function donutChart(data, { size = 168, formatter = money, centreLabel = 'Total', thickness = 20 } = {}) {
  const rows = (data || []).filter((d) => num(d.value) > 0);
  if (!rows.length) return emptyState({ iconName: 'chart', title: 'No data for this period' });

  const total = sum(rows, (d) => d.value);
  const radius = (size - thickness) / 2;
  const centre = size / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  const segments = rows.map((d, i) => {
    const fraction = num(d.value) / total;
    const length = fraction * circumference;
    const seg = `<circle cx="${centre}" cy="${centre}" r="${radius}" fill="none"
      stroke="${d.color || CHART_COLORS[i % CHART_COLORS.length]}" stroke-width="${thickness}"
      stroke-dasharray="${round(length, 2)} ${round(circumference - length, 2)}"
      stroke-dashoffset="${round(-offset, 2)}"
      transform="rotate(-90 ${centre} ${centre})"
      data-tip="${escapeHtml(`${d.label}: ${formatter(d.value)} (${round(fraction * 100, 1)}%)`)}"/>`;
    offset += length;
    return seg;
  }).join('');

  const legend = rows.map((d, i) => `
    <span><i style="background:${d.color || CHART_COLORS[i % CHART_COLORS.length]}"></i>
    ${escapeHtml(d.label)} · <strong>${formatter(d.value)}</strong></span>`).join('');

  return `
    <div class="row" style="gap:var(--sp-5);flex-wrap:wrap;justify-content:center">
      <svg class="chart" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="flex:none">
        ${segments}
        <text x="${centre}" y="${centre - 4}" text-anchor="middle" style="font-size:9px;fill:var(--text-muted)">${escapeHtml(centreLabel)}</text>
        <text x="${centre}" y="${centre + 12}" text-anchor="middle" style="font-size:13px;font-weight:600;fill:var(--text-strong)">${formatter(total)}</text>
      </svg>
      <div class="chart-legend" style="flex-direction:column;gap:7px;margin:0">${legend}</div>
    </div>`;
}

/** Horizontal ranked bars, used for top-selling / staff comparisons. */
export function rankChart(data, { formatter = money, max = null, color = 'var(--chart-1)' } = {}) {
  const rows = data || [];
  if (!rows.length) return emptyState({ iconName: 'chart', title: 'No data for this period' });
  const peak = max || Math.max(...rows.map((d) => num(d.value)), 1);

  return `<div class="stack-sm">${rows.map((d) => `
    <div>
      <div class="row-sm" style="justify-content:space-between;margin-bottom:4px">
        <span class="sm truncate">${escapeHtml(d.label)}</span>
        <span class="sm semibold num nowrap">${formatter(d.value)}</span>
      </div>
      <div class="bar-meter"><i style="width:${round((num(d.value) / peak) * 100, 1)}%;background:${d.color || color}"></i></div>
      ${d.sub ? `<div class="small muted mt-1">${escapeHtml(d.sub)}</div>` : ''}
    </div>`).join('')}</div>`;
}

/* ---------------------------- chart tooltips ---------------------------- */

let tipNode = null;

function showTip(text, x, y) {
  if (!tipNode) {
    tipNode = document.createElement('div');
    tipNode.className = 'chart-tip';
    document.body.appendChild(tipNode);
  }
  tipNode.textContent = text;
  tipNode.style.left = `${x}px`;
  tipNode.style.top = `${y}px`;
  tipNode.hidden = false;
}

function hideTip() {
  if (tipNode) tipNode.hidden = true;
}

document.addEventListener('mouseover', (event) => {
  const target = event.target instanceof Element ? event.target.closest('[data-tip]') : null;
  if (!target) return;
  const rect = target.getBoundingClientRect();
  showTip(target.getAttribute('data-tip'), rect.left + rect.width / 2, rect.top);
}

);

document.addEventListener('mouseout', (event) => {
  if (event.target instanceof Element && event.target.closest('[data-tip]')) hideTip();
}

);

document.addEventListener('scroll', hideTip, true);

/* ============================== QR & BARCODE ============================== */

/** QR Code inside a white print-safe frame. */
export function qrBox(payload, { size = 0, margin = 2, title = '' } = {}) {
  return `<span class="qr-box">${qrSvg(payload, { size, margin, title })}</span>`;
}

export { qrSvg, code128Svg };

/* ============================== PRINTING ============================== */

/**
 * Print arbitrary markup using one of the print.css modes.
 * @param {string} html content to print
 * @param {'receipt'|'labels'|'report'} mode
 */
export function printNode(html, mode = 'report') {
  const root = el('print-root');
  if (!root) return;

  root.innerHTML = html;
  const cls = `print-${mode}`;
  document.documentElement.classList.add(cls);

  const cleanup = () => {
    document.documentElement.classList.remove(cls);
    root.innerHTML = '';
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);

  // Give the browser a frame to apply print styles before opening the dialog.
  requestAnimationFrame(() => {
    window.print();
    // Safety net for browsers that do not fire afterprint.
    setTimeout(cleanup, 1200);
  });
}

/** Standard document header for printed reports. */
export function printHeader({ pharmacy, title, subtitle = '', meta = '' }) {
  return `
    <div class="print-head">
      <div>
        <h1>${escapeHtml(title)}</h1>
        <div class="ph-sub">
          <strong>${escapeHtml(pharmacy.name)}</strong><br>
          ${escapeHtml(pharmacy.address)}<br>
          ${escapeHtml(pharmacy.phone)}${pharmacy.email ? ` · ${escapeHtml(pharmacy.email)}` : ''}
        </div>
      </div>
      <div class="ph-meta">
        ${subtitle ? `<strong>${escapeHtml(subtitle)}</strong><br>` : ''}
        ${meta}
      </div>
    </div>`;
}

export function printFooter({ left = '', right = '' } = {}) {
  return `<div class="print-foot"><span>${left}</span><span>${right}</span></div>`;
}

/**
 * 80mm thermal receipt template - the single implementation used by both the
 * point of sale and receipt reprints from sales history.
 * @param {object} sale a completed sale record
 * @param {{pharmacy:object, duplicate?:boolean}} options
 */
export function receiptHtml(sale, { pharmacy = {}, duplicate = false } = {}) {
  const row = (label, value, strong = false) =>
    `<div class="receipt-row${strong ? ' receipt-total' : ''}"><span>${label}</span><span>${value}</span></div>`;

  const items = sale.items.map((line) => `
    <div class="receipt-item">
      <div class="ri-name">${escapeHtml(line.name)}</div>
      <div class="ri-meta">Batch ${escapeHtml(line.batchNo)} · Exp ${fmtDate(line.expiry)}</div>
      <div class="receipt-row">
        <span>${line.qty} x ${money(line.unitPrice, { symbol: false })}</span>
        <span>${money(line.total, { symbol: false })}</span>
      </div>
      ${num(line.discount) > 0
        ? `<div class="receipt-row ri-meta"><span>Line discount</span><span>-${money(line.discount, { symbol: false })}</span></div>`
        : ''}
    </div>`).join('');

  return `
    <div class="receipt">
      ${duplicate ? '<div class="receipt-dup">DUPLICATE COPY</div>' : ''}
      <div class="receipt-center">
        <h4>${escapeHtml(pharmacy.name || 'MediFlow Pharmacy')}</h4>
        <div>${escapeHtml(pharmacy.address || '')}</div>
        <div>Tel: ${escapeHtml(pharmacy.phone || '-')}</div>
        ${pharmacy.email ? `<div>${escapeHtml(pharmacy.email)}</div>` : ''}
        ${pharmacy.licence ? `<div>Licence: ${escapeHtml(pharmacy.licence)}</div>` : ''}
      </div>
      <div class="receipt-rule"></div>
      ${row('Receipt', escapeHtml(sale.ref))}
      ${row('Date', fmtDate(sale.datetime))}
      ${row('Time', fmtTime(sale.datetime))}
      ${row('Cashier', escapeHtml(sale.userName))}
      ${row('Customer', escapeHtml(sale.customerName || 'Walk-in Customer'))}
      <div class="receipt-rule"></div>
      ${items}
      <div class="receipt-rule"></div>
      ${row('Subtotal', money(sale.subtotal, { symbol: false }))}
      ${num(sale.discount) > 0 ? row('Discount', `-${money(sale.discount, { symbol: false })}`) : ''}
      ${row('TOTAL', money(sale.total, { symbol: false }), true)}
      <div class="receipt-rule"></div>
      ${row('Payment', escapeHtml(sale.payment.method))}
      ${sale.payment.method === 'Cash' ? row('Cash received', money(sale.payment.cashReceived, { symbol: false })) : ''}
      ${sale.payment.method === 'Cash' ? row('Change', money(sale.payment.change, { symbol: false })) : ''}
      ${num(sale.payment.creditAmount) > 0 ? row('On account', money(sale.payment.creditAmount, { symbol: false })) : ''}
      ${sale.payment.reference ? row('Reference', escapeHtml(sale.payment.reference)) : ''}
      ${sale.prescription ? `
        <div class="receipt-rule"></div>
        <div class="receipt-center"><strong>PRESCRIPTION RECORD</strong></div>
        ${row('Prescriber', escapeHtml(sale.prescription.doctor))}
        ${sale.prescription.reference ? row('Rx ref', escapeHtml(sale.prescription.reference)) : ''}` : ''}
      <div class="receipt-rule"></div>
      <div class="receipt-center ri-meta">
        <div>${escapeHtml(pharmacy.receiptFooter || 'Goods returnable within 7 days with receipt.')}</div>
        <div style="margin-top:4px">Items sold: ${sale.units} · Currency: Naira</div>
        <div style="margin-top:6px"><strong>Thank you for your patronage.</strong></div>
        <div style="margin-top:4px">Powered by MediFlow Pharmacy ERP</div>
      </div>
    </div>`;
}

/* ============================== CAMERA SCANNER ============================== */

/**
 * Create a QR / barcode scanner widget.
 * Uses the native BarcodeDetector API when available and always provides a
 * manual-entry fallback that also accepts USB/Bluetooth scanner keyboard input.
 *
 * @param {HTMLElement} container mount point
 * @param {{onDetect:Function, formats?:string[], manualLabel?:string}} config
 * @returns {{stop:Function, focusManual:Function}}
 */
export function createScanner(container, { onDetect, manualLabel = 'Enter or scan code manually' } = {}) {
  const supported = 'BarcodeDetector' in window;
  const hasCamera = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  container.innerHTML = `
    <div class="scan-shell">
      <div class="scan-stage" id="scan-stage">
        <div class="scan-placeholder" id="scan-placeholder">
          ${icon('camera', 26, 'mb-2')}
          <p class="mt-2">${hasCamera
            ? 'Start the camera to scan a batch QR Code'
            : 'Camera scanning is not available on this device'}</p>
        </div>
      </div>
      <div class="row-sm" style="flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" type="button" id="scan-start" ${hasCamera ? '' : 'disabled'}>
          ${icon('camera', 15)} Start camera
        </button>
        <button class="btn btn-secondary btn-sm" type="button" id="scan-stop" hidden>
          ${icon('close', 15)} Stop camera
        </button>
        <span class="scan-state muted" id="scan-state">
          ${supported ? 'Native barcode detection available' : 'Native detection unavailable - use manual entry'}
        </span>
      </div>
      <div class="field">
        <label class="label" for="scan-manual">${escapeHtml(manualLabel)}</label>
        <div class="input-group">
          <input class="input mono" id="scan-manual" placeholder="MEDIFLOW|MED:... or batch no / barcode"
                 autocomplete="off" spellcheck="false">
          <button class="input-addon" type="button" id="scan-submit" aria-label="Look up code">${icon('arrowRight', 17)}</button>
        </div>
        <p class="field-hint">A USB or Bluetooth scanner types into this box and submits automatically.</p>
      </div>
    </div>`;

  const stage = qs('#scan-stage', container);
  const placeholder = qs('#scan-placeholder', container);
  const startBtn = qs('#scan-start', container);
  const stopBtn = qs('#scan-stop', container);
  const stateNode = qs('#scan-state', container);
  const manual = qs('#scan-manual', container);

  let stream = null;
  let video = null;
  let detector = null;
  let rafId = null;
  let running = false;
  let lastValue = '';
  let lastAt = 0;

  const setState = (text, tone = '') => {
    stateNode.className = `scan-state ${tone ? `c-${tone}` : 'muted'}`;
    stateNode.textContent = text;
  };

  /** Debounce repeat reads of the same code. */
  const emit = (value) => {
    const now = Date.now();
    if (value === lastValue && now - lastAt < 1800) return;
    lastValue = value;
    lastAt = now;
    onDetect(String(value).trim());
  };

  async function start() {
    if (running) return;
    try {
      setState('Requesting camera permission...');
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
      });

      video = document.createElement('video');
      video.setAttribute('playsinline', 'true');
      video.muted = true;
      video.srcObject = stream;
      placeholder.hidden = true;
      stage.appendChild(video);
      stage.insertAdjacentHTML('beforeend', '<div class="scan-reticle"></div>');
      await video.play();

      running = true;
      startBtn.hidden = true;
      stopBtn.hidden = false;

      if (supported) {
        detector = new window.BarcodeDetector({
          formats: ['qr_code', 'code_128', 'ean_13', 'ean_8', 'code_39', 'upc_a', 'itf']
        });
        setState('Scanning... hold the code inside the frame', 'primary');
        scanLoop();
      } else {
        setState('This browser cannot decode from the camera - type the code below instead', 'warning');
      }
    } catch (error) {
      console.warn('[scanner] camera unavailable:', error);
      const denied = error && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
      setState(denied
        ? 'Camera permission was denied - use manual entry below'
        : 'Could not start the camera - use manual entry below', 'danger');
      stop();
    }
  }

  async function scanLoop() {
    if (!running || !detector || !video) return;
    try {
      const codes = await detector.detect(video);
      if (codes && codes.length) {
        const value = codes[0].rawValue;
        if (value) {
          setState('Code detected', 'success');
          emit(value);
        }
      }
    } catch {
      // Detection can fail on individual frames; keep scanning.
    }
    rafId = requestAnimationFrame(() => setTimeout(scanLoop, 160));
  }

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = null;
    if (video) { video.remove(); video = null; }
    const reticle = qs('.scan-reticle', stage);
    if (reticle) reticle.remove();
    placeholder.hidden = false;
    startBtn.hidden = false;
    stopBtn.hidden = true;
  }

  startBtn.addEventListener('click', start);
  stopBtn.addEventListener('click', () => { stop(); setState('Camera stopped'); });

  const submitManual = () => {
    const value = manual.value.trim();
    if (!value) return;
    emit(value);
    manual.value = '';
    manual.focus();
  };

  qs('#scan-submit', container).addEventListener('click', submitManual);
  manual.addEventListener('keydown', (event) => {
    // Hardware scanners finish their input with Enter.
    if (event.key === 'Enter') { event.preventDefault(); submitManual(); }
  });

  setTimeout(() => manual.focus(), 60);

  return {
    stop,
    focusManual: () => manual.focus(),
    setState
  };
}

/* ============================== MISC HELPERS ============================== */

/** Toggle a dropdown menu, closing it on outside click or Escape. */
export function bindDropdown(trigger, menuHtml, { align = 'right' } = {}) {
  let menu = null;

  const close = () => {
    if (!menu) return;
    menu.remove();
    menu = null;
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', onKey, true);
    trigger.setAttribute('aria-expanded', 'false');
  };

  function outside(event) {
    if (menu && !menu.contains(event.target) && !trigger.contains(event.target)) close();
  }

  function onKey(event) {
    if (event.key === 'Escape') { event.stopPropagation(); close(); }
  }

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    if (menu) { close(); return; }
    const wrapper = trigger.closest('.dropdown') || trigger.parentElement;
    wrapper.style.position = wrapper.style.position || 'relative';
    menu = document.createElement('div');
    menu.className = `menu${align === 'left' ? ' menu-left' : ''}`;
    menu.innerHTML = typeof menuHtml === 'function' ? menuHtml() : menuHtml;
    wrapper.appendChild(menu);
    trigger.setAttribute('aria-expanded', 'true');
    menu.addEventListener('click', (e) => {
      if (e.target.closest('.menu-item')) close();
    });
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', onKey, true);
  });

  return { close };
}

/** Briefly flash an element to confirm a change. */
export async function flash(node, tone = 'success') {
  if (!node) return;
  const original = node.style.backgroundColor;
  node.style.transition = 'background-color 200ms';
  node.style.backgroundColor = `var(--${tone}-soft)`;
  await sleep(420);
  node.style.backgroundColor = original;
}

export { escapeHtml };
