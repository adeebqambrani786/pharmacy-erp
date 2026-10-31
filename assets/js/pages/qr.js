/* ==========================================================================
   MediFlow Pharmacy ERP - QR Code Management (admin only)
   Generate, inspect, search, test and print batch QR Codes. Codes carry only
   stable internal identifiers - never prices or quantities (section 9).
   ========================================================================== */

import {
  db, medicine, medicines, batch as findBatch, batchState, buildQrPayload, generateBatchQr,
  generateMissingQrCodes, resolveScan, isWrittenOff, isExpired, settings, stockSummary, supplier
} from '../store.js';
import { can, requirePermission } from '../auth.js';
import {
  pageHead, card, kpi, icon, badge, statusBadge, renderTable, cellStack, emptyState, openModal,
  openDrawer, confirmDialog, notifySuccess, notifyError, notifyWarning, notifyDenied,
  escapeHtml, options, searchBox, createScanner, qrBox, qrSvg, code128Svg, printNode,
  printHeader, printFooter
} from '../ui.js';
import {
  money, int, num, fmtDate, fmtMonthYear, fmtDateTime, sortBy, paginate, qs, qsa, on, debounce,
  matchesQuery, sum, unique, daysUntil
} from '../utils.js';

const state = {
  query: '',
  category: '',
  status: '',
  view: 'grid',   // 'grid' | 'table'
  page: 1,
  selected: new Set()
};

let ctxRef = null;

/* ============================== DATA ============================== */

function qrRows() {
  let rows = db.batches
    .filter((b) => !isWrittenOff(b))
    .map((b) => ({ batch: b, med: medicine(b.medicineId) }))
    .filter((r) => r.med);

  if (state.query) {
    rows = rows.filter(({ batch, med }) => matchesQuery(
      `${med.name} ${med.strength} ${med.sku} ${med.barcode} ${batch.batchNo} ${batch.qr} ${batch.location}`,
      state.query
    ));
  }
  if (state.category) rows = rows.filter(({ med }) => med.category === state.category);
  if (state.status) {
    rows = rows.filter(({ batch }) => {
      if (state.status === 'missing') return !batch.qr;
      if (state.status === 'generated') return !!batch.qr;
      return batchState(batch).key === state.status;
    });
  }

  return sortBy(rows, (r) => `${r.med.name}${r.batch.expiry}`, 'asc');
}

/* ============================== SINGLE CODE ============================== */

function openQrDrawer(batchId) {
  const batch = findBatch(batchId);
  if (!batch) return;
  const med = medicine(batch.medicineId);
  const sup = supplier(batch.supplierId);
  const payload = batch.qr || buildQrPayload(med, batch);

  // Decode the payload back into its parts so the admin can verify the mapping.
  const parts = payload.split('|').slice(1).map((part) => {
    const [key, ...rest] = part.split(':');
    return { key, value: rest.join(':') };
  });

  const PART_LABELS = { MED: 'Medicine ID', BAT: 'Batch ID', SKU: 'SKU', BN: 'Batch number' };

  openDrawer({
    title: 'Batch QR Code',
    subtitle: `${med.name} ${med.strength} - ${batch.batchNo}`,
    body: `
      <div class="stack-lg">
        <div class="center">
          ${qrBox(payload, { size: 220, title: batch.batchNo })}
        </div>

        <div class="row-wrap" style="justify-content:center">
          ${statusBadge(batchState(batch))}
          ${batch.qr ? badge('Code generated', 'success') : badge('Not generated yet', 'warning')}
          ${batch.qrGeneratedAt ? badge(`Generated ${fmtDate(batch.qrGeneratedAt)}`, 'neutral') : ''}
        </div>

        <section>
          <h3 class="mb-3">What the code contains</h3>
          <div class="def-grid">
            ${parts.map((p) => `
              <div class="def-item">
                <div class="def-label">${escapeHtml(PART_LABELS[p.key] || p.key)}</div>
                <div class="def-value mono">${escapeHtml(p.value)}</div>
              </div>`).join('')}
          </div>
          <div class="alert alert-info small mt-3">
            ${icon('shield', 15)}
            <div>No price or quantity is stored in the code. When scanned, MediFlow reads the
            current price, stock and expiry from the live inventory record.</div>
          </div>
          <p class="small mono subtle mt-3" style="word-break:break-all">${escapeHtml(payload)}</p>
        </section>

        <section>
          <h3 class="mb-3">Live batch information</h3>
          <div class="def-grid">
            <div class="def-item"><div class="def-label">Units on hand</div><div class="def-value num">${int(batch.qty)}</div></div>
            <div class="def-item"><div class="def-label">Expiry</div><div class="def-value">${fmtDate(batch.expiry)} (${daysUntil(batch.expiry)}d)</div></div>
            <div class="def-item"><div class="def-label">Selling price</div><div class="def-value num">${money(batch.price)}</div></div>
            ${can('inventory.cost') ? `<div class="def-item"><div class="def-label">Unit cost</div><div class="def-value num">${money(batch.costPrice)}</div></div>` : ''}
            <div class="def-item"><div class="def-label">Location</div><div class="def-value">${escapeHtml(batch.location || '-')}</div></div>
            <div class="def-item"><div class="def-label">Supplier</div><div class="def-value">${escapeHtml(sup ? sup.name : '-')}</div></div>
            <div class="def-item"><div class="def-label">Received</div><div class="def-value">${fmtDate(batch.receivedAt)}</div></div>
            <div class="def-item"><div class="def-label">NAFDAC no.</div><div class="def-value mono">${escapeHtml(med.nafdac || '-')}</div></div>
          </div>
        </section>

        ${med.barcode ? `
          <section>
            <h3 class="mb-3">Manufacturer barcode</h3>
            <div class="qr-box" style="width:100%;max-width:280px">
              ${code128Svg(med.barcode, { height: 46, showText: true, moduleWidth: 1.1 })}
            </div>
            <p class="small muted mt-2">Code 128 rendering of <span class="mono">${escapeHtml(med.barcode)}</span>.
            Scanning it identifies the medicine, then FEFO picks the batch.</p>
          </section>` : ''}
      </div>`,
    footer: `
      <button class="btn btn-secondary" type="button" data-regen="${batch.id}">${icon('refresh', 15)} Regenerate</button>
      ${can('labels.print') ? `<button class="btn btn-primary" type="button" data-label="${batch.id}">${icon('tag', 15)} Print label</button>` : ''}`,
    onMount: (api) => {
      api.root.addEventListener('click', (event) => {
        const regen = event.target.closest('[data-regen]');
        if (regen) {
          try {
            generateBatchQr(regen.getAttribute('data-regen'), ctxRef.user);
            api.close();
            notifySuccess('QR Code regenerated', `Batch ${batch.batchNo} now has a fresh code.`);
            ctxRef.refresh();
          } catch (error) {
            notifyError('Could not regenerate', error.message);
          }
          return;
        }
        const label = event.target.closest('[data-label]');
        if (label) {
          api.close();
          ctxRef.navigate(`/labels?batch=${label.getAttribute('data-label')}`);
        }
      });
    }
  });
}

/* ============================== SCAN TESTER ============================== */

function openTestModal() {
  let scanner = null;
  const modal = openModal({
    title: 'Test a QR Code or barcode',
    subtitle: 'Confirm a printed label resolves to the right medicine and batch',
    size: 'modal-lg',
    iconName: 'scan',
    body: `
      <div class="alert alert-info small mb-4">
        ${icon('info', 16)}
        <div>This tester only reads - it never changes stock. Use it after printing labels
        to prove each code maps to the correct batch.</div>
      </div>
      <div id="qr-scan-mount"></div>
      <div id="qr-scan-feed" class="mt-4"></div>`,
    footer: '<button class="btn btn-secondary" type="button" data-modal-close>Done</button>',
    onClose: () => { if (scanner) scanner.stop(); }
  });

  const feed = qs('#qr-scan-feed', modal.root);

  scanner = createScanner(qs('#qr-scan-mount', modal.root), {
    manualLabel: 'Paste or scan a code to resolve it',
    onDetect: (value) => {
      const result = resolveScan(value);

      if (!result.ok) {
        feed.innerHTML = `
          <div class="alert alert-danger">
            ${icon('alertCircle', 17)}
            <div>
              <div class="alert-title">Unrecognised code</div>
              <div class="small">${escapeHtml(result.message)}</div>
              <div class="small mono subtle mt-2" style="word-break:break-all">${escapeHtml(String(value).slice(0, 160))}</div>
            </div>
          </div>`;
        return;
      }

      const med = result.medicine;
      const batch = result.batch;
      const summary = stockSummary(med.id);

      feed.innerHTML = `
        <div class="alert alert-success mb-3">
          ${icon('checkCircle', 17)}
          <div>
            <div class="alert-title">Resolved as ${escapeHtml(result.type.toUpperCase())}</div>
            <div class="small">${escapeHtml(`${med.name} ${med.strength}`.trim())}
            ${batch ? ` - batch ${escapeHtml(batch.batchNo)}` : ' (medicine level, no batch in the code)'}</div>
          </div>
        </div>
        <div class="card card-pad">
          <div class="def-grid">
            <div class="def-item"><div class="def-label">Medicine ID</div><div class="def-value mono">${escapeHtml(med.id)}</div></div>
            <div class="def-item"><div class="def-label">SKU</div><div class="def-value mono">${escapeHtml(med.sku)}</div></div>
            ${batch ? `
              <div class="def-item"><div class="def-label">Batch ID</div><div class="def-value mono">${escapeHtml(batch.id)}</div></div>
              <div class="def-item"><div class="def-label">Batch number</div><div class="def-value">${escapeHtml(batch.batchNo)}</div></div>
              <div class="def-item"><div class="def-label">Expiry</div><div class="def-value">${fmtDate(batch.expiry)}</div></div>
              <div class="def-item"><div class="def-label">Units in batch</div><div class="def-value num">${int(batch.qty)}</div></div>
              <div class="def-item"><div class="def-label">Batch status</div><div class="def-value">${statusBadge(batchState(batch))}</div></div>` : ''}
            <div class="def-item"><div class="def-label">Sellable now</div><div class="def-value num">${int(summary.available)}</div></div>
            <div class="def-item"><div class="def-label">Current price</div><div class="def-value num">${money(summary.price)}</div></div>
          </div>
          ${batch && isExpired(batch) ? `<div class="alert alert-danger small mt-3">${icon('alert', 15)}
            <div>This batch has expired - the point of sale will refuse it.</div></div>` : ''}
        </div>`;
    }
  });
}

/* ============================== BULK GENERATE ============================== */

async function generateMissingFlow() {
  try {
    requirePermission('qr.manage');
  } catch (error) {
    notifyDenied(error);
    return;
  }

  const missing = db.batches.filter((b) => !b.qr && !isWrittenOff(b));
  if (!missing.length) {
    notifySuccess('Nothing to generate', 'Every batch already has a QR Code.');
    return;
  }

  const ok = await confirmDialog({
    title: `Generate ${missing.length} QR Code(s)?`,
    message: 'A code will be created for every batch that does not have one yet.',
    confirmLabel: 'Generate codes',
    iconName: 'qr'
  });
  if (!ok) return;

  const count = generateMissingQrCodes(ctxRef.user);
  notifySuccess('QR Codes generated', `${count} batch code(s) created and ready to print.`);
  ctxRef.refresh();
}

/* ============================== RENDER ============================== */

export function render(root, ctx) {
  ctxRef = ctx;

  const allRows = qrRows();
  const pageData = paginate(allRows, state.page, state.view === 'grid' ? 18 : 15);

  const liveBatches = db.batches.filter((b) => !isWrittenOff(b));
  const withQr = liveBatches.filter((b) => !!b.qr).length;
  const missing = liveBatches.length - withQr;
  const selectedIds = [...state.selected].filter((id) => allRows.some((r) => r.batch.id === id));

  const gridHtml = pageData.rows.length ? `
    <div class="qr-grid">
      ${pageData.rows.map(({ batch, med }) => `
        <div class="qr-card">
          <label class="check" style="position:absolute;margin:4px">
            <input type="checkbox" data-select="${batch.id}" ${state.selected.has(batch.id) ? 'checked' : ''}
              aria-label="Select ${escapeHtml(batch.batchNo)}">
          </label>
          <button class="btn-ghost" type="button" data-open="${batch.id}" style="display:block;width:100%">
            ${batch.qr
              ? qrBox(batch.qr, { title: batch.batchNo })
              : `<span class="qr-box" style="display:grid;place-items:center;aspect-ratio:1;color:var(--text-subtle)">
                   ${icon('qr', 30)}<span class="small mt-2">Not generated</span></span>`}
            <div class="qr-card-name">${escapeHtml(`${med.name} ${med.strength}`.trim())}</div>
            <div class="qr-card-meta">${escapeHtml(batch.batchNo)} · exp ${fmtMonthYear(batch.expiry)}</div>
            <div class="qr-card-meta">${int(batch.qty)} units · ${money(batch.price)}</div>
          </button>
          <div class="mt-3">${statusBadge(batchState(batch))}</div>
        </div>`).join('')}
    </div>` : emptyState({
      iconName: 'qr',
      title: 'No batches match these filters',
      message: 'Clear the filters or receive stock to create batches.'
    });

  const tableHtml = renderTable({
    columns: [
      {
        key: 'select', label: '', width: '34px',
        cell: ({ batch }) => `<input type="checkbox" data-select="${batch.id}" ${state.selected.has(batch.id) ? 'checked' : ''}
          aria-label="Select ${escapeHtml(batch.batchNo)}">`
      },
      {
        key: 'qr', label: 'Code', width: '64px',
        cell: ({ batch }) => (batch.qr
          ? `<span class="qr-box" style="width:52px;padding:3px">${qrSvg(batch.qr, { margin: 1 })}</span>`
          : `<span class="subtle">${icon('qr', 18)}</span>`)
      },
      { key: 'medicine', label: 'Medicine', cell: ({ med, batch }) => cellStack(`${med.name} ${med.strength}`.trim(), `${med.sku} - batch ${batch.batchNo}`) },
      { key: 'expiry', label: 'Expiry', cell: ({ batch }) => cellStack(fmtDate(batch.expiry), `${daysUntil(batch.expiry)} days`) },
      { key: 'qty', label: 'Units', className: 'num', cell: ({ batch }) => int(batch.qty) },
      { key: 'price', label: 'Price', className: 'num', cell: ({ batch }) => money(batch.price) },
      { key: 'location', label: 'Location', cell: ({ batch }) => escapeHtml(batch.location || '-') },
      { key: 'state', label: 'Batch', cell: ({ batch }) => statusBadge(batchState(batch)) },
      {
        key: 'code', label: 'QR',
        cell: ({ batch }) => (batch.qr ? badge('Generated', 'success') : badge('Missing', 'warning'))
      },
      {
        key: 'actions', label: '', className: 'right',
        cell: ({ batch }) => `<div class="table-actions">
          <button class="btn btn-ghost btn-sm" type="button" data-open="${batch.id}" title="View code">${icon('eye', 15)}</button>
          <button class="btn btn-ghost btn-sm" type="button" data-regen="${batch.id}" title="Regenerate">${icon('refresh', 15)}</button>
        </div>`
      }
    ],
    rows: pageData.rows,
    empty: emptyState({ iconName: 'qr', title: 'No batches match these filters' })
  });

  root.innerHTML = `
  <div class="page">
    ${pageHead({
      title: 'QR Code Management',
      subtitle: 'Every batch carries a unique QR Code built from internal identifiers only - safe to print, impossible to tamper with prices.',
      actions: `
        ${can('qr.scan') ? `<button class="btn btn-secondary" type="button" id="btn-test">${icon('scan', 16)} Test a code</button>` : ''}
        ${missing ? `<button class="btn btn-soft" type="button" id="btn-generate">${icon('qr', 16)} Generate ${missing} missing</button>` : ''}
        ${can('labels.print') ? `<button class="btn btn-primary" type="button" data-route="#/labels">${icon('tag', 16)} Print labels</button>` : ''}`
    })}

    <div class="kpi-grid">
      ${kpi({ label: 'Batches with a code', value: int(withQr), iconName: 'qr', tone: 'success', foot: `<span>of ${int(liveBatches.length)} live batches</span>`, small: true })}
      ${kpi({ label: 'Missing codes', value: int(missing), iconName: 'alert', tone: missing ? 'warning' : '', foot: '<span>Generate before printing</span>', small: true })}
      ${kpi({ label: 'Medicines covered', value: int(unique(liveBatches.map((b) => b.medicineId)).length), iconName: 'pill', tone: 'info', small: true })}
      ${kpi({ label: 'Units identified', value: int(sum(liveBatches, (b) => b.qty)), iconName: 'box', small: true })}
    </div>

    <div class="toolbar">
      ${searchBox({ id: 'qr-search', value: state.query, placeholder: 'Search medicine, SKU, batch or QR payload...' })}
      <div class="toolbar-group">
        <select class="select filter-select" id="f-category" aria-label="Filter by category">
          ${options(unique(medicines().map((m) => m.category)).sort(), state.category, { placeholder: 'All categories' })}
        </select>
        <select class="select filter-select" id="f-status" aria-label="Filter by code status">
          ${options([
            { value: 'generated', label: 'Code generated' },
            { value: 'missing', label: 'Code missing' },
            { value: 'ok', label: 'In stock' },
            { value: 'expiring', label: 'Expiring soon' },
            { value: 'expired', label: 'Expired' },
            { value: 'quarantined', label: 'Quarantined' }
          ], state.status, { placeholder: 'All statuses' })}
        </select>
        <div class="segmented">
          <button type="button" data-view="grid" class="${state.view === 'grid' ? 'is-active' : ''}">${icon('layers', 14)} Grid</button>
          <button type="button" data-view="table" class="${state.view === 'table' ? 'is-active' : ''}">${icon('dashboard', 14)} Table</button>
        </div>
        ${(state.query || state.category || state.status)
          ? '<button class="btn btn-ghost btn-sm" type="button" id="btn-clear">Clear</button>' : ''}
      </div>
    </div>

    ${selectedIds.length ? `
      <div class="toolbar" style="background:var(--primary-soft);border-color:var(--primary)">
        <strong class="sm">${selectedIds.length} code(s) selected</strong>
        <div class="spacer"></div>
        ${can('labels.print') ? `<button class="btn btn-primary btn-sm" type="button" id="bulk-print">${icon('print', 14)} Print selected labels</button>` : ''}
        <button class="btn btn-secondary btn-sm" type="button" id="bulk-sheet">${icon('qr', 14)} Print QR sheet</button>
        <button class="btn btn-ghost btn-sm" type="button" id="bulk-clear">Clear</button>
      </div>` : ''}

    ${card({
      sub: `${allRows.length} batch code(s)`,
      flush: state.view === 'table',
      body: (state.view === 'grid' ? `<div class="card-body">${gridHtml}</div>` : tableHtml)
        + (pageData.pages > 1 ? paginationHtml(pageData) : '')
    })}
  </div>`;

  /* ---------------------------- events ---------------------------- */

  const rerender = () => ctx.refresh();

  const search = qs('#qr-search', root);
  search.addEventListener('input', debounce(() => {
    state.query = search.value;
    state.page = 1;
    const caret = search.selectionStart;
    rerender();
    const next = qs('#qr-search');
    if (next) { next.focus(); next.setSelectionRange(caret, caret); }
  }, 260));

  const bind = (selector, key) => {
    const node = qs(selector, root);
    if (node) node.addEventListener('change', () => { state[key] = node.value; state.page = 1; rerender(); });
  };
  bind('#f-category', 'category');
  bind('#f-status', 'status');

  qsa('[data-view]', root).forEach((btn) => btn.addEventListener('click', () => {
    state.view = btn.getAttribute('data-view');
    state.page = 1;
    rerender();
  }));

  const clearBtn = qs('#btn-clear', root);
  if (clearBtn) clearBtn.addEventListener('click', () => {
    Object.assign(state, { query: '', category: '', status: '', page: 1 });
    rerender();
  });

  on(root, 'change', '[data-select]', (event, node) => {
    const id = node.getAttribute('data-select');
    if (node.checked) state.selected.add(id); else state.selected.delete(id);
    rerender();
  });

  on(root, 'click', '[data-open]', (event, node) => openQrDrawer(node.getAttribute('data-open')));

  on(root, 'click', '[data-regen]', (event, node) => {
    event.stopPropagation();
    try {
      generateBatchQr(node.getAttribute('data-regen'), ctx.user);
      notifySuccess('QR Code regenerated');
      rerender();
    } catch (error) {
      notifyError('Could not regenerate', error.message);
    }
  });

  on(root, 'click', '[data-page]', (event, node) => {
    const page = num(node.getAttribute('data-page'));
    if (page >= 1 && page <= pageData.pages) { state.page = page; rerender(); }
  });

  const testBtn = qs('#btn-test', root);
  if (testBtn) testBtn.addEventListener('click', openTestModal);

  const genBtn = qs('#btn-generate', root);
  if (genBtn) genBtn.addEventListener('click', generateMissingFlow);

  const bulkPrint = qs('#bulk-print', root);
  if (bulkPrint) bulkPrint.addEventListener('click', () => {
    ctx.navigate(`/labels?batches=${selectedIds.join(',')}`);
  });

  const bulkSheet = qs('#bulk-sheet', root);
  if (bulkSheet) bulkSheet.addEventListener('click', () => printQrSheet(selectedIds));

  const bulkClear = qs('#bulk-clear', root);
  if (bulkClear) bulkClear.addEventListener('click', () => { state.selected.clear(); rerender(); });
}

/** Reference sheet: large codes with their batch details, for the dispensary wall. */
function printQrSheet(batchIds) {
  const pharmacy = settings().pharmacy;
  const rows = batchIds.map(findBatch).filter(Boolean);
  if (!rows.length) {
    notifyWarning('Nothing selected', 'Select at least one batch first.');
    return;
  }

  printNode(`
    <div class="print-doc">
      ${printHeader({
        pharmacy,
        title: 'Batch QR Code Reference Sheet',
        subtitle: `${rows.length} batch code(s)`,
        meta: `Generated ${fmtDateTime(new Date())}<br>By ${escapeHtml(ctxRef.user.name)}`
      })}
      <table>
        <thead><tr>
          <th style="width:26mm">QR Code</th><th>Medicine</th><th>Batch</th>
          <th>Expiry</th><th class="num">Units</th><th class="num">Price</th>
        </tr></thead>
        <tbody>${rows.map((b) => {
          const med = medicine(b.medicineId);
          return `<tr>
            <td><div style="width:22mm">${qrSvg(b.qr || buildQrPayload(med, b), { margin: 1 })}</div></td>
            <td>${escapeHtml(med ? `${med.name} ${med.strength}` : '-')}<br>
                <span style="font-size:7pt">${escapeHtml(med ? med.sku : '')}</span></td>
            <td>${escapeHtml(b.batchNo)}</td>
            <td>${fmtDate(b.expiry)}</td>
            <td class="num">${int(b.qty)}</td>
            <td class="num">${money(b.price)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
      ${printFooter({ left: `${escapeHtml(pharmacy.name)}`, right: 'MediFlow Pharmacy ERP' })}
    </div>`, 'report');
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
