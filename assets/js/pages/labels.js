/* ==========================================================================
   MediFlow Pharmacy ERP - Barcode & QR Labels (admin only)
   Build a print-ready A4 sheet of shelf-edge labels for selected batches, with
   a live preview, per-batch label counts and a choice of symbology (section 26).
   ========================================================================== */

import {
  db, medicine, medicines, batch as findBatch, batchState, buildQrPayload, isWrittenOff,
  settings, generateBatchQr
} from '../store.js';
import { can, requirePermission } from '../auth.js';
import {
  pageHead, card, icon, badge, statusBadge, renderTable, cellStack, emptyState, openModal,
  modalFooter, notifySuccess, notifyWarning, notifyDenied, escapeHtml, options, searchBox,
  qrSvg, code128Svg, printNode, checkField, selectField
} from '../ui.js';
import {
  money, int, num, fmtDate, fmtMonthYear, fmtDateTime, sortBy, qs, qsa, on,
  debounce, matchesQuery, sum, unique, clamp, daysUntil, paginate
} from '../utils.js';

/**
 * Selection is a Map of batchId -> label count, so one batch can be printed
 * several times (one label per pack on the shelf).
 */
const state = {
  query: '',
  category: '',
  selection: new Map(),
  symbology: 'qr',       // 'qr' | 'barcode' | 'both'
  showPrice: true,
  showExpiry: true,
  showSku: true,
  showStoreName: true,
  columns: 3,
  page: 1
};

let ctxRef = null;

/* ============================== LABEL TEMPLATE ============================== */

/**
 * One shelf label. Kept in a single function so the on-screen preview and the
 * printed sheet can never drift apart.
 */
function labelHtml(batch, med) {
  const pharmacy = settings().pharmacy;
  const payload = batch.qr || buildQrPayload(med, batch);

  const code = state.symbology === 'barcode'
    ? `<div class="bc-wrap" style="width:100%">${code128Svg(med.barcode || med.sku, { height: 30, moduleWidth: 1 })}</div>`
    : `<div class="qr-wrap">${qrSvg(payload, { margin: 1 })}</div>`;

  const both = state.symbology === 'both'
    ? `<div class="bc-wrap" style="width:100%;margin-top:2px">${code128Svg(med.barcode || med.sku, { height: 18, moduleWidth: 0.8 })}</div>`
    : '';

  return `
    <div class="label-tag">
      ${code}
      <div class="label-info">
        ${state.showStoreName ? `<div class="label-store">${escapeHtml(pharmacy.name)}</div>` : ''}
        <div class="label-name">${escapeHtml(`${med.name} ${med.strength}`.trim())}</div>
        <div>${escapeHtml(med.form)}${med.prescriptionRequired ? ' · POM' : ''}</div>
        ${state.showSku ? `<div>SKU ${escapeHtml(med.sku)}</div>` : ''}
        <div>Batch ${escapeHtml(batch.batchNo)}</div>
        ${state.showExpiry ? `<div>Exp ${fmtMonthYear(batch.expiry)}</div>` : ''}
        ${state.showPrice ? `<div class="label-price">${money(batch.price)}</div>` : ''}
        ${both}
      </div>
    </div>`;
}

/** Expand the selection into one entry per physical label. */
function expandSelection() {
  const out = [];
  state.selection.forEach((count, batchId) => {
    const batch = findBatch(batchId);
    if (!batch) return;
    const med = medicine(batch.medicineId);
    if (!med) return;
    for (let i = 0; i < count; i++) out.push({ batch, med });
  });
  return out;
}

function totalLabels() {
  return sum([...state.selection.values()], (v) => v);
}

/* ============================== PRINT ============================== */

function printLabels() {
  try {
    requirePermission('labels.print');
  } catch (error) {
    notifyDenied(error);
    return;
  }

  const labels = expandSelection();
  if (!labels.length) {
    notifyWarning('No labels selected', 'Choose at least one batch and a label count.');
    return;
  }

  // Make sure every selected batch actually carries a QR payload.
  state.selection.forEach((count, batchId) => {
    const batch = findBatch(batchId);
    if (batch && !batch.qr) generateBatchQr(batchId, ctxRef.user, { silent: true });
  });

  const pharmacy = settings().pharmacy;
  printNode(`
    <div class="print-doc">
      <div class="print-head" style="border-bottom:1pt solid #0f766e;padding-bottom:2mm;margin-bottom:4mm">
        <div>
          <h1 style="font-size:12pt;margin:0">${escapeHtml(pharmacy.name)} - Shelf Labels</h1>
          <div class="ph-sub">${labels.length} label(s) · ${state.selection.size} batch(es)</div>
        </div>
        <div class="ph-meta">${fmtDateTime(new Date())}<br>By ${escapeHtml(ctxRef.user.name)}</div>
      </div>
      <div class="label-sheet" style="grid-template-columns:repeat(${state.columns}, 1fr)">
        ${labels.map(({ batch, med }) => labelHtml(batch, med)).join('')}
      </div>
    </div>`, 'labels');

  notifySuccess('Labels sent to printer', `${labels.length} label(s) laid out ${state.columns} per row.`);
}

/* ============================== BULK SELECTION ============================== */

function openBulkModal() {
  const cats = unique(medicines().map((m) => m.category)).sort();

  const modal = openModal({
    title: 'Select batches in bulk',
    subtitle: 'Add every batch that matches a rule, with one label each',
    size: 'modal-sm',
    iconName: 'layers',
    body: `
      <form id="bulk-form" class="stack-lg" novalidate>
        ${selectField({
          name: 'rule', label: 'Which batches?', required: true,
          list: [
            { value: 'in-stock', label: 'All batches with stock' },
            { value: 'no-qr', label: 'Batches without a QR Code' },
            { value: 'recent', label: 'Batches received in the last 14 days' },
            { value: 'expiring', label: 'Batches expiring within 90 days' },
            { value: 'category', label: 'All batches in a category' }
          ],
          value: 'in-stock'
        })}
        <div id="bulk-cat" hidden>
          ${selectField({ name: 'category', label: 'Category', list: cats, placeholder: 'Select category' })}
        </div>
        ${selectField({
          name: 'count', label: 'Labels per batch',
          list: ['1', '2', '3', '5', '10'], value: '1'
        })}
      </form>`,
    footer: modalFooter({ confirmLabel: 'Add to sheet' })
  });

  const form = qs('#bulk-form', modal.root);
  const ruleSelect = form.elements.rule;
  ruleSelect.addEventListener('change', () => {
    qs('#bulk-cat', modal.root).hidden = ruleSelect.value !== 'category';
  });

  qs('#modal-confirm', modal.root).addEventListener('click', (event) => {
    event.preventDefault();
    const rule = ruleSelect.value;
    const count = num(form.elements.count.value, 1);
    const category = form.elements.category ? form.elements.category.value : '';

    const batches = db.batches.filter((b) => {
      if (isWrittenOff(b)) return false;
      switch (rule) {
        case 'in-stock': return num(b.qty) > 0;
        case 'no-qr': return !b.qr;
        case 'recent': return daysUntil(b.receivedAt) > -15;
        case 'expiring': {
          const days = daysUntil(b.expiry);
          return days >= 0 && days <= 90;
        }
        case 'category': {
          const med = medicine(b.medicineId);
          return med && med.category === category;
        }
        default: return false;
      }
    });

    if (!batches.length) {
      notifyWarning('No batches matched', 'Try a different rule.');
      return;
    }
    batches.forEach((b) => state.selection.set(b.id, count));
    modal.close();
    notifySuccess('Batches added', `${batches.length} batch(es) added, ${batches.length * count} label(s) total.`);
    ctxRef.refresh();
  });
}

/* ============================== RENDER ============================== */

export function render(root, ctx) {
  ctxRef = ctx;

  // Deep links from the receiving and QR modules
  if (ctx.query.batch) {
    state.selection.set(ctx.query.batch, state.selection.get(ctx.query.batch) || 1);
    ctx.navigate('/labels');
  }
  if (ctx.query.batches) {
    ctx.query.batches.split(',').filter(Boolean).forEach((id) => {
      state.selection.set(id, state.selection.get(id) || 1);
    });
    ctx.navigate('/labels');
  }
  if (ctx.query.receipt) {
    const receipt = db.goodsReceipts.find((r) => r.id === ctx.query.receipt);
    if (receipt) {
      receipt.lines.forEach((line) => {
        if (line.batchId) state.selection.set(line.batchId, state.selection.get(line.batchId) || 1);
      });
    }
    ctx.navigate('/labels');
  }

  let rows = db.batches
    .filter((b) => !isWrittenOff(b))
    .map((b) => ({ batch: b, med: medicine(b.medicineId) }))
    .filter((r) => r.med);

  if (state.query) {
    rows = rows.filter(({ batch, med }) => matchesQuery(
      `${med.name} ${med.strength} ${med.sku} ${med.barcode} ${batch.batchNo}`, state.query));
  }
  if (state.category) rows = rows.filter(({ med }) => med.category === state.category);
  rows = sortBy(rows, (r) => `${r.med.name}${r.batch.expiry}`, 'asc');

  const pageData = paginate(rows, state.page, 12);
  const labels = expandSelection();
  const previewLabels = labels.slice(0, 12);

  root.innerHTML = `
  <div class="page">
    ${pageHead({
      title: 'Barcode & QR Labels',
      subtitle: 'Build a print-ready sheet of shelf labels. Each label carries the batch QR Code so it can be scanned at the counter and when receiving.',
      actions: `
        <button class="btn btn-secondary" type="button" id="btn-bulk">${icon('layers', 16)} Bulk select</button>
        ${state.selection.size ? `<button class="btn btn-ghost" type="button" id="btn-clear-sel">${icon('trash', 16)} Clear sheet</button>` : ''}
        <button class="btn btn-primary" type="button" id="btn-print" ${labels.length ? '' : 'disabled'}>
          ${icon('print', 16)} Print ${labels.length || ''} label${labels.length === 1 ? '' : 's'}
        </button>`
    })}

    <div class="grid-dash">
      <div class="span-7">
        <div class="toolbar mb-3">
          ${searchBox({ id: 'lbl-search', value: state.query, placeholder: 'Search medicine, SKU or batch...' })}
          <select class="select filter-select" id="f-category" aria-label="Filter by category">
            ${options(unique(medicines().map((m) => m.category)).sort(), state.category, { placeholder: 'All categories' })}
          </select>
        </div>

        ${card({
          title: 'Choose batches',
          sub: `${rows.length} batch(es) available`,
          flush: true,
          body: renderTable({
            columns: [
              {
                key: 'medicine', label: 'Medicine',
                cell: ({ med, batch }) => cellStack(`${med.name} ${med.strength}`.trim(), `${med.sku} - batch ${batch.batchNo}`)
              },
              { key: 'expiry', label: 'Expiry', cell: ({ batch }) => fmtDate(batch.expiry) },
              { key: 'qty', label: 'Units', className: 'num', cell: ({ batch }) => int(batch.qty) },
              { key: 'price', label: 'Price', className: 'num', cell: ({ batch }) => money(batch.price) },
              { key: 'state', label: 'Batch', cell: ({ batch }) => statusBadge(batchState(batch)) },
              {
                key: 'labels', label: 'Labels', className: 'num', width: '120px',
                cell: ({ batch }) => `<input class="input num" type="number" min="0" max="200" step="1"
                  style="max-width:84px" data-count="${batch.id}"
                  value="${state.selection.get(batch.id) || 0}"
                  aria-label="Label count for batch ${escapeHtml(batch.batchNo)}">`
              }
            ],
            rows: pageData.rows,
            rowClass: ({ batch }) => (state.selection.has(batch.id) ? 'is-selected' : ''),
            empty: emptyState({ iconName: 'tag', title: 'No batches match', message: 'Clear the search or category filter.' })
          }) + (pageData.pages > 1 ? paginationHtml(pageData) : '')
        })}
      </div>

      <div class="span-5">
        ${card({
          title: 'Label design',
          body: `
            <div class="stack-lg">
              <div>
                <div class="label mb-2">Code type</div>
                <div class="segmented">
                  <button type="button" data-sym="qr" class="${state.symbology === 'qr' ? 'is-active' : ''}">QR Code</button>
                  <button type="button" data-sym="barcode" class="${state.symbology === 'barcode' ? 'is-active' : ''}">Barcode</button>
                  <button type="button" data-sym="both" class="${state.symbology === 'both' ? 'is-active' : ''}">Both</button>
                </div>
                <p class="field-hint">QR Codes identify the exact batch; barcodes identify the product only.</p>
              </div>

              <div>
                <div class="label mb-2">Labels per row</div>
                <div class="segmented">
                  ${[2, 3, 4].map((n) => `<button type="button" data-cols="${n}" class="${state.columns === n ? 'is-active' : ''}">${n}</button>`).join('')}
                </div>
              </div>

              <div class="stack-sm">
                <div class="label">Include on the label</div>
                ${checkField({ name: 'showStoreName', label: 'Pharmacy name', checked: state.showStoreName })}
                ${checkField({ name: 'showSku', label: 'SKU', checked: state.showSku })}
                ${checkField({ name: 'showExpiry', label: 'Expiry month', checked: state.showExpiry })}
                ${checkField({ name: 'showPrice', label: 'Selling price', checked: state.showPrice })}
              </div>
            </div>`
        })}

        ${card({
          className: 'mt-4',
          title: 'Sheet preview',
          sub: labels.length
            ? `${labels.length} label(s) from ${state.selection.size} batch(es)${labels.length > 12 ? ' - showing the first 12' : ''}`
            : 'Nothing selected yet',
          body: labels.length ? `
            <div class="label-sheet" style="grid-template-columns:repeat(${Math.min(state.columns, 2)}, 1fr)">
              ${previewLabels.map(({ batch, med }) => labelHtml(batch, med)).join('')}
            </div>`
            : emptyState({
              iconName: 'tag',
              title: 'No labels on the sheet',
              message: 'Set a label count against one or more batches, or use bulk select.'
            })
        })}

        ${state.selection.size ? card({
          className: 'mt-4',
          title: 'On this sheet',
          flush: true,
          body: `<div class="list">${[...state.selection.entries()].map(([batchId, count]) => {
            const batch = findBatch(batchId);
            const med = batch ? medicine(batch.medicineId) : null;
            if (!batch || !med) return '';
            return `
              <div class="list-row">
                <span class="list-main">
                  <span class="list-title">${escapeHtml(`${med.name} ${med.strength}`.trim())}</span>
                  <span class="list-sub">Batch ${escapeHtml(batch.batchNo)} · exp ${fmtMonthYear(batch.expiry)}</span>
                </span>
                <span class="list-end row-sm">
                  <span class="badge badge-primary">${int(count)}</span>
                  <button class="btn btn-ghost btn-sm btn-icon" type="button" data-unselect="${batchId}"
                    title="Remove from sheet">${icon('close', 14)}</button>
                </span>
              </div>`;
          }).join('')}</div>`
        }) : ''}
      </div>
    </div>
  </div>`;

  /* ---------------------------- events ---------------------------- */

  const rerender = () => ctx.refresh();

  const search = qs('#lbl-search', root);
  search.addEventListener('input', debounce(() => {
    state.query = search.value;
    state.page = 1;
    const caret = search.selectionStart;
    rerender();
    const next = qs('#lbl-search');
    if (next) { next.focus(); next.setSelectionRange(caret, caret); }
  }, 260));

  const catSelect = qs('#f-category', root);
  catSelect.addEventListener('change', () => { state.category = catSelect.value; state.page = 1; rerender(); });

  // Label counts
  on(root, 'change', 'input[data-count]', (event, node) => {
    const id = node.getAttribute('data-count');
    const count = clamp(Math.round(num(node.value)), 0, 200);
    if (count <= 0) state.selection.delete(id);
    else state.selection.set(id, count);
    rerender();
  });

  on(root, 'click', '[data-unselect]', (event, node) => {
    state.selection.delete(node.getAttribute('data-unselect'));
    rerender();
  });

  qsa('[data-sym]', root).forEach((btn) => btn.addEventListener('click', () => {
    state.symbology = btn.getAttribute('data-sym');
    rerender();
  }));

  qsa('[data-cols]', root).forEach((btn) => btn.addEventListener('click', () => {
    state.columns = num(btn.getAttribute('data-cols'), 3);
    rerender();
  }));

  ['showStoreName', 'showSku', 'showExpiry', 'showPrice'].forEach((key) => {
    const node = qs(`#f-${key}`, root);
    if (node) node.addEventListener('change', () => { state[key] = node.checked; rerender(); });
  });

  on(root, 'click', '[data-page]', (event, node) => {
    const page = num(node.getAttribute('data-page'));
    if (page >= 1 && page <= pageData.pages) { state.page = page; rerender(); }
  });

  qs('#btn-print', root).addEventListener('click', printLabels);
  qs('#btn-bulk', root).addEventListener('click', openBulkModal);

  const clearSel = qs('#btn-clear-sel', root);
  if (clearSel) clearSel.addEventListener('click', () => {
    state.selection.clear();
    rerender();
  });
}

function paginationHtml(pageData) {
  let buttons = '';
  for (let p = 1; p <= pageData.pages; p++) {
    buttons += `<button class="page-btn${p === pageData.page ? ' is-active' : ''}" type="button" data-page="${p}">${p}</button>`;
  }
  return `<div class="pagination">
    <span class="pagination-info">Showing <strong>${pageData.from}-${pageData.to}</strong> of <strong>${pageData.total}</strong> batches</span>
    <div class="pagination-pages">${buttons}</div></div>`;
}

export default { render };
