/* ==========================================================================
   MediFlow Pharmacy ERP - Stock Count (admin only)
   Count physical stock batch by batch, compare it with the system figure and
   turn each variance into an audited stock adjustment. Inventory is never
   updated silently - the session must be reviewed and confirmed (section 14).
   ========================================================================== */

import {
  db, find, medicine, medicines, startStockCount, stockCountScope, saveStockCountLine,
  commitStockCount, resolveScan, batchState, isWrittenOff, settings
} from '../store.js';
import { can, requirePermission } from '../auth.js';
import {
  pageHead, card, kpi, icon, badge, statusBadge, renderTable, cellStack, emptyState, openModal,
  openDrawer, modalFooter, confirmDialog, notifySuccess, notifyError, notifyWarning,
  notifyDenied, escapeHtml, searchBox, createScanner, printNode, printHeader, printFooter,
  checkField, flash
} from '../ui.js';
import {
  money, int, num, round, fmtDate, fmtDateTime, fmtRelative, fmtDuration, sortBy, qs, qsa, on,
  debounce, matchesQuery, sum, unique, downloadCsv, exportName, paginate
} from '../utils.js';

/** Page state: which session is open in the counting sheet. */
const state = {
  activeId: '',
  query: '',
  blind: true,       // hide the system quantity while counting
  onlyUncounted: false,
  page: 1
};

let ctxRef = null;

/* ============================== SESSION START ============================== */

function openStartModal() {
  try {
    requirePermission('stock.count');
  } catch (error) {
    notifyDenied(error);
    return;
  }

  const inUse = unique(medicines().map((m) => m.category)).sort();

  const modal = openModal({
    title: 'Start a stock count',
    subtitle: 'Count the whole inventory or selected categories',
    size: 'modal-lg',
    iconName: 'clipboard',
    body: `
      <form id="count-form" class="stack-lg" novalidate>
        <div>
          <div class="divider-label mb-3">Scope</div>
          <div class="segmented">
            <button type="button" data-scope="all" class="is-active">Entire inventory</button>
            <button type="button" data-scope="categories">Selected categories</button>
          </div>
        </div>

        <div id="scope-categories" hidden>
          <div class="grid-2">
            ${inUse.map((category) => checkField({
              name: `cat_${category.replace(/[^a-z0-9]/gi, '_')}`,
              label: category,
              hint: `${medicines().filter((m) => m.category === category).length} medicine(s)`,
              attrs: `data-category="${escapeHtml(category)}"`
            })).join('')}
          </div>
        </div>

        <div class="alert alert-info small">
          ${icon('info', 16)}
          <div>Written-off batches are excluded. Counting does not freeze sales - MediFlow
          re-reads the system quantity when you confirm, so any sale made mid-count is respected.</div>
        </div>

        <div class="card card-pad">
          <div class="stat-line is-total">
            <span class="sl-label">Batches to count</span>
            <span class="sl-value" id="count-scope-size">0</span>
          </div>
        </div>
      </form>`,
    footer: modalFooter({ confirmLabel: 'Start counting' })
  });

  const form = qs('#count-form', modal.root);
  let scope = 'all';

  const selectedCategories = () =>
    qsa('[data-category]', form).filter((n) => n.checked).map((n) => n.getAttribute('data-category'));

  const updateSize = () => {
    const cats = selectedCategories();
    const rows = db.batches.filter((b) => {
      if (isWrittenOff(b)) return false;
      if (scope === 'all') return true;
      const med = medicine(b.medicineId);
      return med && cats.includes(med.category);
    });
    qs('#count-scope-size', modal.root).textContent = int(rows.length);
  };

  qsa('[data-scope]', modal.root).forEach((btn) => btn.addEventListener('click', () => {
    scope = btn.getAttribute('data-scope');
    qsa('[data-scope]', modal.root).forEach((b) => b.classList.toggle('is-active', b === btn));
    qs('#scope-categories', modal.root).hidden = scope !== 'categories';
    updateSize();
  }));

  form.addEventListener('change', updateSize);
  updateSize();

  const submit = () => {
    const categories = selectedCategories();
    if (scope === 'categories' && !categories.length) {
      notifyError('Select at least one category', 'Or switch to counting the entire inventory.');
      return;
    }
    try {
      const session = startStockCount({ user: ctxRef.user, scope, categories });
      state.activeId = session.id;
      state.page = 1;
      modal.close();
      notifySuccess('Stock count started', `${session.ref} is open - enter the physical quantities.`);
      ctxRef.refresh();
    } catch (error) {
      notifyError('Could not start the count', error.message);
    }
  };

  form.addEventListener('submit', (event) => { event.preventDefault(); submit(); });
  qs('#modal-confirm', modal.root).addEventListener('click', (event) => { event.preventDefault(); submit(); });
}

/* ============================== COUNTING SHEET ============================== */

function sheetRows(session) {
  const scope = stockCountScope(session);
  const lineMap = new Map(session.lines.map((l) => [l.batchId, l]));

  let rows = scope.map((b) => {
    const med = medicine(b.medicineId);
    const line = lineMap.get(b.id) || null;
    return {
      batch: b,
      med,
      line,
      counted: !!line,
      system: num(b.qty),
      physical: line ? num(line.physical) : null,
      diff: line ? num(line.physical) - num(b.qty) : 0,
      valueImpact: line ? round((num(line.physical) - num(b.qty)) * num(b.costPrice), 2) : 0
    };
  });

  if (state.query) {
    rows = rows.filter((r) => matchesQuery(
      `${r.med ? r.med.name : ''} ${r.med ? r.med.strength : ''} ${r.med ? r.med.sku : ''} ${r.batch.batchNo} ${r.batch.location}`,
      state.query
    ));
  }
  if (state.onlyUncounted) rows = rows.filter((r) => !r.counted);

  return sortBy(rows, (r) => `${r.med ? r.med.name : 'zz'}${r.batch.expiry}`, 'asc');
}

/** Save one physical quantity and repaint just that row's figures. */
function saveLine(session, batchId, value, rowNode) {
  try {
    const line = saveStockCountLine(session.id, { batchId, physical: value });
    if (rowNode) {
      const diffCell = qs('[data-diff]', rowNode);
      const valueCell = qs('[data-impact]', rowNode);
      if (diffCell) {
        diffCell.innerHTML = line.diff === 0
          ? '<span class="c-success">Match</span>'
          : `<span class="${line.diff > 0 ? 'c-info' : 'c-danger'}"><strong>${line.diff > 0 ? '+' : ''}${int(line.diff)}</strong></span>`;
      }
      if (valueCell) {
        valueCell.innerHTML = line.valueImpact === 0
          ? '<span class="subtle">-</span>'
          : `<span class="${line.valueImpact < 0 ? 'c-danger' : 'c-success'}">${money(line.valueImpact)}</span>`;
      }
      rowNode.classList.remove('row-warning');
      flash(rowNode, line.diff === 0 ? 'success' : 'warning');
    }
    updateProgress(session);
    return line;
  } catch (error) {
    notifyError('Could not save the count', error.message);
    return null;
  }
}

function updateProgress(session) {
  const scope = stockCountScope(session);
  const counted = session.lines.length;
  const variances = session.lines.filter((l) => l.diff !== 0);

  const set = (id, text) => { const node = qs(id); if (node) node.textContent = text; };
  set('#cnt-progress', `${counted} of ${scope.length} batches counted`);
  set('#cnt-variances', int(variances.length));
  set('#cnt-shortage', int(Math.abs(sum(variances.filter((l) => l.diff < 0), (l) => l.diff))));
  set('#cnt-excess', int(sum(variances.filter((l) => l.diff > 0), (l) => l.diff)));
  set('#cnt-value', money(sum(session.lines, (l) => l.valueImpact)));

  const bar = qs('#cnt-bar > i');
  if (bar) bar.style.width = `${scope.length ? round((counted / scope.length) * 100, 1) : 0}%`;

  const commitBtn = qs('#btn-commit');
  if (commitBtn) commitBtn.disabled = counted === 0;
}

/* ============================== SCAN TO COUNT ============================== */

function openCountScanModal(session) {
  let scanner = null;
  const modal = openModal({
    title: 'Scan to count',
    subtitle: 'Scan a batch QR Code and type the quantity you physically counted',
    size: 'modal-lg',
    iconName: 'scan',
    body: '<div id="cnt-scan-mount"></div><div id="cnt-scan-feed" class="mt-4"></div>',
    footer: '<button class="btn btn-secondary" type="button" data-modal-close>Done</button>',
    onClose: () => { if (scanner) scanner.stop(); ctxRef.refresh(); }
  });

  const feed = qs('#cnt-scan-feed', modal.root);

  const renderEntry = (batch) => {
    const med = medicine(batch.medicineId);
    const existing = session.lines.find((l) => l.batchId === batch.id);

    feed.innerHTML = `
      <div class="card card-pad">
        <div class="row-sm mb-3" style="justify-content:space-between">
          <div>
            <strong>${escapeHtml(`${med.name} ${med.strength}`.trim())}</strong>
            <div class="small muted">Batch ${escapeHtml(batch.batchNo)} · exp ${fmtDate(batch.expiry)}
              · ${escapeHtml(batch.location || 'Unassigned')}</div>
          </div>
          ${statusBadge(batchState(batch))}
        </div>
        ${existing ? `<div class="alert alert-info small mb-3">${icon('info', 15)}
          <div>Already counted as <strong>${int(existing.physical)}</strong> - entering a new figure replaces it.</div></div>` : ''}
        <div class="field">
          <label class="label" for="scan-qty">Physical quantity counted</label>
          <input class="input num" id="scan-qty" type="number" min="0" step="1" autofocus
                 value="${existing ? int(existing.physical) : ''}" placeholder="0">
        </div>
        ${state.blind ? '' : `<p class="field-hint">System quantity: <strong>${int(batch.qty)}</strong></p>`}
        <button class="btn btn-primary btn-block mt-3" type="button" id="scan-save">
          ${icon('check', 16)} Save count
        </button>
      </div>`;

    const input = qs('#scan-qty', feed);
    const save = () => {
      if (input.value === '') { input.focus(); return; }
      const line = saveLine(session, batch.id, input.value, null);
      if (!line) return;
      feed.innerHTML = `<div class="alert alert-success small">${icon('checkCircle', 15)}
        <div><strong>${escapeHtml(med.name)}</strong> batch ${escapeHtml(batch.batchNo)} counted:
        ${int(line.physical)} physical vs ${int(line.system)} system
        ${line.diff === 0 ? '(match)' : `(${line.diff > 0 ? '+' : ''}${int(line.diff)})`}.
        Scan the next batch.</div></div>`;
      if (scanner) scanner.focusManual();
    };
    qs('#scan-save', feed).addEventListener('click', save);
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); save(); } });
  };

  scanner = createScanner(qs('#cnt-scan-mount', modal.root), {
    onDetect: (value) => {
      const result = resolveScan(value);
      if (!result.ok) {
        feed.innerHTML = `<div class="alert alert-danger small">${icon('alertCircle', 15)}
          <div>${escapeHtml(result.message)}</div></div>`;
        return;
      }
      if (!result.batch) {
        feed.innerHTML = `<div class="alert alert-warning small">${icon('alert', 15)}
          <div>That code identifies ${escapeHtml(result.medicine.name)} but not a batch.
          Use the counting sheet to pick the batch.</div></div>`;
        return;
      }
      const inScope = stockCountScope(session).some((b) => b.id === result.batch.id);
      if (!inScope) {
        feed.innerHTML = `<div class="alert alert-warning small">${icon('alert', 15)}
          <div>Batch ${escapeHtml(result.batch.batchNo)} is outside this count's scope.</div></div>`;
        return;
      }
      renderEntry(result.batch);
    }
  });
}

/* ============================== COMMIT ============================== */

async function commitFlow(session) {
  const variances = session.lines.filter((l) => l.diff !== 0);
  const scope = stockCountScope(session);

  if (!session.lines.length) {
    notifyError('Nothing counted', 'Enter at least one physical quantity before completing the count.');
    return;
  }

  if (session.lines.length < scope.length) {
    const proceed = await confirmDialog({
      title: 'Not every batch has been counted',
      message: `${session.lines.length} of ${scope.length} batches have a physical quantity. Uncounted batches are left untouched.`,
      confirmLabel: 'Continue anyway',
      tone: 'warning',
      iconName: 'alert'
    });
    if (!proceed) return;
  }

  const modal = openModal({
    title: 'Review and confirm the count',
    subtitle: `${session.ref} - ${variances.length} variance(s) to post`,
    size: 'modal-xl',
    iconName: 'clipboard',
    body: `
      <div class="stack-lg">
        <div class="kpi-grid">
          ${kpi({ label: 'Batches counted', value: int(session.lines.length), iconName: 'clipboard', small: true })}
          ${kpi({ label: 'Variances', value: int(variances.length), iconName: 'adjust', tone: variances.length ? 'warning' : 'success', small: true })}
          ${kpi({ label: 'Shortage units', value: int(Math.abs(sum(variances.filter((l) => l.diff < 0), (l) => l.diff))), iconName: 'arrowDown', tone: 'danger', small: true })}
          ${kpi({ label: 'Net value impact', value: money(sum(session.lines, (l) => l.valueImpact)), iconName: 'wallet', small: true })}
        </div>

        ${variances.length ? renderTable({
          compact: true,
          responsive: false,
          columns: [
            { key: 'medicineName', label: 'Medicine', cell: (l) => cellStack(l.medicineName, `Batch ${l.batchNo}`) },
            { key: 'system', label: 'System', className: 'num', cell: (l) => int(l.system) },
            { key: 'physical', label: 'Counted', className: 'num', cell: (l) => int(l.physical) },
            {
              key: 'diff', label: 'Difference', className: 'num',
              cell: (l) => `<span class="${l.diff < 0 ? 'c-danger' : 'c-info'}"><strong>${l.diff > 0 ? '+' : ''}${int(l.diff)}</strong></span>`
            },
            {
              key: 'valueImpact', label: 'Value', className: 'num',
              cell: (l) => `<span class="${l.valueImpact < 0 ? 'c-danger' : 'c-success'}">${money(l.valueImpact)}</span>`
            }
          ],
          rows: sortBy(variances, (l) => Math.abs(l.diff), 'desc')
        }) : `<div class="alert alert-success">${icon('checkCircle', 17)}
          <div><div class="alert-title">Perfect count</div>
          <div class="small">Every counted batch matches the system quantity. No adjustments will be created.</div></div></div>`}

        <div class="alert alert-warning small">
          ${icon('alert', 16)}
          <div>Confirming creates <strong>${variances.length}</strong> stock adjustment record(s) with the reason
          "Stock count correction", each traceable to this session and to you.</div>
        </div>

        <div class="field">
          <label class="label" for="commit-note">Session note</label>
          <textarea class="textarea" id="commit-note" name="note" rows="2"
            placeholder="Who counted, any observations...">${escapeHtml(session.note || '')}</textarea>
        </div>
      </div>`,
    footer: modalFooter({ confirmLabel: 'Confirm count & post adjustments', tone: 'primary' })
  });

  const submit = () => {
    try {
      const completed = commitStockCount(session.id, {
        user: ctxRef.user,
        note: qs('#commit-note', modal.root).value.trim()
      });
      state.activeId = '';
      modal.close();
      notifySuccess(
        'Stock count completed',
        `${completed.ref}: ${completed.adjustmentsCreated} adjustment(s) posted, value impact ${money(completed.valueImpact)}.`
      );
      ctxRef.refresh();
    } catch (error) {
      notifyError('Could not complete the count', error.message);
    }
  };

  qs('#modal-confirm', modal.root).addEventListener('click', (event) => { event.preventDefault(); submit(); });
}

/* ============================== SESSION DETAIL ============================== */

function openSessionDrawer(id) {
  const session = find('stockCounts', id);
  if (!session) return;

  const variances = session.lines.filter((l) => l.diff !== 0);

  openDrawer({
    title: session.ref,
    subtitle: `${session.scope === 'all' ? 'Entire inventory' : session.categories.join(', ')} - ${session.userName}`,
    size: 'drawer-lg',
    body: `
      <div class="stack-lg">
        <div class="row-wrap">
          ${badge(session.status === 'completed' ? 'Completed' : 'Open', session.status === 'completed' ? 'success' : 'warning', { dot: true })}
          ${badge(`${session.lines.length} batches counted`, 'neutral')}
          ${variances.length ? badge(`${variances.length} variance(s)`, 'warning') : badge('No variances', 'success')}
        </div>

        <div class="def-grid">
          <div class="def-item"><div class="def-label">Started</div><div class="def-value">${fmtDateTime(session.startedAt)}</div></div>
          <div class="def-item"><div class="def-label">Completed</div><div class="def-value">${session.completedAt ? fmtDateTime(session.completedAt) : '-'}</div></div>
          <div class="def-item"><div class="def-label">Duration</div><div class="def-value">${session.completedAt ? fmtDuration(session.startedAt, session.completedAt) : fmtDuration(session.startedAt)}</div></div>
          <div class="def-item"><div class="def-label">Counted by</div><div class="def-value">${escapeHtml(session.userName)}</div></div>
          <div class="def-item"><div class="def-label">Total variance units</div><div class="def-value num">${int(session.totalVariance)}</div></div>
          <div class="def-item"><div class="def-label">Value impact</div><div class="def-value num ${session.valueImpact < 0 ? 'c-danger' : 'c-success'}">${money(session.valueImpact)}</div></div>
          ${session.adjustmentsCreated !== undefined ? `<div class="def-item"><div class="def-label">Adjustments posted</div><div class="def-value num">${int(session.adjustmentsCreated)}</div></div>` : ''}
        </div>

        ${session.note ? `<div class="alert alert-neutral small">${icon('info', 15)}<div>${escapeHtml(session.note)}</div></div>` : ''}

        <section>
          <h3 class="mb-3">Counted lines</h3>
          ${renderTable({
            compact: true,
            responsive: false,
            columns: [
              { key: 'medicineName', label: 'Medicine', cell: (l) => cellStack(l.medicineName, `Batch ${l.batchNo}`) },
              { key: 'system', label: 'System', className: 'num', cell: (l) => int(l.system) },
              { key: 'physical', label: 'Counted', className: 'num', cell: (l) => int(l.physical) },
              {
                key: 'diff', label: 'Diff', className: 'num',
                cell: (l) => (l.diff === 0
                  ? '<span class="c-success">0</span>'
                  : `<span class="${l.diff < 0 ? 'c-danger' : 'c-info'}">${l.diff > 0 ? '+' : ''}${int(l.diff)}</span>`)
              },
              { key: 'valueImpact', label: 'Value', className: 'num', cell: (l) => money(l.valueImpact) }
            ],
            rows: sortBy(session.lines, (l) => Math.abs(l.diff), 'desc'),
            empty: emptyState({ title: 'No lines counted in this session' })
          })}
        </section>
      </div>`,
    footer: `
      <button class="btn btn-secondary" type="button" id="sess-print">${icon('print', 15)} Print sheet</button>
      ${session.status === 'open' ? `<button class="btn btn-primary" type="button" data-resume="${session.id}">Continue counting</button>` : ''}`,
    onMount: (api) => {
      qs('#sess-print', api.root).addEventListener('click', () => printSession(session));
      api.root.addEventListener('click', (event) => {
        const resume = event.target.closest('[data-resume]');
        if (resume) {
          state.activeId = resume.getAttribute('data-resume');
          api.close();
          ctxRef.refresh();
        }
      });
    }
  });
}

function printSession(session) {
  const pharmacy = settings().pharmacy;
  printNode(`
    <div class="print-doc">
      ${printHeader({
        pharmacy,
        title: 'Stock Count Sheet',
        subtitle: session.ref,
        meta: `Started ${fmtDateTime(session.startedAt)}<br>
               ${session.completedAt ? `Completed ${fmtDateTime(session.completedAt)}<br>` : ''}
               Counted by ${escapeHtml(session.userName)}<br>
               Scope: ${session.scope === 'all' ? 'Entire inventory' : escapeHtml(session.categories.join(', '))}`
      })}
      <table>
        <thead><tr>
          <th>Medicine</th><th>Batch</th><th>Expiry</th>
          <th class="num">System</th><th class="num">Counted</th>
          <th class="num">Difference</th><th class="num">Value impact</th>
        </tr></thead>
        <tbody>${session.lines.map((l) => `<tr>
          <td>${escapeHtml(l.medicineName)}</td>
          <td>${escapeHtml(l.batchNo)}</td>
          <td>${fmtDate(l.expiry)}</td>
          <td class="num">${int(l.system)}</td>
          <td class="num">${int(l.physical)}</td>
          <td class="num">${l.diff > 0 ? '+' : ''}${int(l.diff)}</td>
          <td class="num">${money(l.valueImpact)}</td>
        </tr>`).join('')}</tbody>
        <tfoot><tr>
          <td colspan="5">Totals</td>
          <td class="num">${int(session.totalVariance)} units</td>
          <td class="num">${money(session.valueImpact)}</td>
        </tr></tfoot>
      </table>
      <div style="margin-top:14mm;display:flex;gap:16mm">
        <div style="flex:1">______________________________<br><span style="font-size:7.5pt">Counted by</span></div>
        <div style="flex:1">______________________________<br><span style="font-size:7.5pt">Verified by (Pharmacist)</span></div>
      </div>
      ${printFooter({ left: `${escapeHtml(pharmacy.name)} - confidential`, right: 'MediFlow Pharmacy ERP' })}
    </div>`, 'report');
}

/* ============================== RENDER ============================== */

export function render(root, ctx) {
  ctxRef = ctx;

  // Resume an open session automatically.
  const openSession = db.stockCounts.find((s) => s.status === 'open');
  if (!state.activeId && openSession) state.activeId = openSession.id;
  const session = state.activeId ? find('stockCounts', state.activeId) : null;
  const active = session && session.status === 'open' ? session : null;

  const pastSessions = sortBy(db.stockCounts.filter((s) => s.status === 'completed'), (s) => s.completedAt, 'desc');

  /* ---------------------------- counting sheet ---------------------------- */

  let sheetHtml = '';
  if (active) {
    const rows = sheetRows(active);
    const pageData = paginate(rows, state.page, 20);
    const scopeSize = stockCountScope(active).length;

    sheetHtml = card({
      title: `Counting sheet - ${active.ref}`,
      sub: `${active.scope === 'all' ? 'Entire inventory' : active.categories.join(', ')} - started ${fmtRelative(active.startedAt)}`,
      actions: `
        ${searchBox({ id: 'sheet-search', value: state.query, placeholder: 'Jump to medicine or batch...' })}
        ${can('qr.scan') ? `<button class="btn btn-secondary btn-sm" type="button" id="btn-scan-count">${icon('scan', 14)} Scan</button>` : ''}`,
      flush: true,
      body: `
        <div class="card-body" style="padding-bottom:0">
          <div class="row-wrap mb-3">
            <div style="flex:1 1 220px">
              <div class="row-sm" style="justify-content:space-between">
                <span class="small muted" id="cnt-progress">${active.lines.length} of ${scopeSize} batches counted</span>
                <span class="small muted">${round((active.lines.length / Math.max(1, scopeSize)) * 100, 0)}%</span>
              </div>
              <div class="bar-meter mt-1" id="cnt-bar">
                <i style="width:${round((active.lines.length / Math.max(1, scopeSize)) * 100, 1)}%"></i>
              </div>
            </div>
            <label class="switch" title="Hide the system quantity to avoid bias">
              <input type="checkbox" id="opt-blind" ${state.blind ? 'checked' : ''}>
              <span class="switch-track"></span>
              <span class="check-text">Blind count</span>
            </label>
            <label class="check">
              <input type="checkbox" id="opt-uncounted" ${state.onlyUncounted ? 'checked' : ''}>
              <span class="check-text">Only uncounted</span>
            </label>
          </div>
        </div>
        ${renderTable({
          compact: true,
          columns: [
            {
              key: 'medicine', label: 'Medicine',
              cell: (r) => cellStack(r.med ? `${r.med.name} ${r.med.strength}`.trim() : 'Unknown',
                `${r.batch.batchNo} - exp ${fmtDate(r.batch.expiry)}`)
            },
            { key: 'location', label: 'Location', cell: (r) => escapeHtml(r.batch.location || '-') },
            { key: 'status', label: 'Batch', cell: (r) => statusBadge(batchState(r.batch)) },
            ...(state.blind ? [] : [{ key: 'system', label: 'System', className: 'num', cell: (r) => int(r.system) }]),
            {
              key: 'physical', label: 'Counted', className: 'num', width: '110px',
              cell: (r) => `<input class="input num" type="number" min="0" step="1" style="max-width:96px"
                data-count="${r.batch.id}" value="${r.counted ? int(r.physical) : ''}" placeholder="-"
                aria-label="Physical quantity for batch ${escapeHtml(r.batch.batchNo)}">`
            },
            {
              key: 'diff', label: 'Difference', className: 'num',
              cell: (r) => `<span data-diff>${r.counted
                ? (r.diff === 0
                  ? '<span class="c-success">Match</span>'
                  : `<span class="${r.diff > 0 ? 'c-info' : 'c-danger'}"><strong>${r.diff > 0 ? '+' : ''}${int(r.diff)}</strong></span>`)
                : '<span class="subtle">Not counted</span>'}</span>`
            },
            {
              key: 'impact', label: 'Value', className: 'num',
              cell: (r) => `<span data-impact>${r.counted && r.valueImpact !== 0
                ? `<span class="${r.valueImpact < 0 ? 'c-danger' : 'c-success'}">${money(r.valueImpact)}</span>`
                : '<span class="subtle">-</span>'}</span>`
            }
          ],
          rows: pageData.rows,
          rowAttrs: (r) => `data-row="${r.batch.id}"`,
          rowClass: (r) => (r.counted ? '' : 'row-warning'),
          empty: emptyState({ title: 'No batches match', message: 'Clear the search or the "only uncounted" filter.' })
        })}
        ${renderPaginationSafe(pageData)}`,
      footer: `<div class="row-wrap" style="width:100%">
        <div class="row-wrap" style="gap:var(--sp-5);flex:1 1 auto">
          <span class="small"><span class="muted">Variances</span> <strong id="cnt-variances">${int(active.lines.filter((l) => l.diff !== 0).length)}</strong></span>
          <span class="small"><span class="muted">Shortage</span> <strong id="cnt-shortage">${int(Math.abs(sum(active.lines.filter((l) => l.diff < 0), (l) => l.diff)))}</strong> units</span>
          <span class="small"><span class="muted">Excess</span> <strong id="cnt-excess">${int(sum(active.lines.filter((l) => l.diff > 0), (l) => l.diff))}</strong> units</span>
          <span class="small"><span class="muted">Value impact</span> <strong id="cnt-value">${money(sum(active.lines, (l) => l.valueImpact))}</strong></span>
        </div>
        <button class="btn btn-secondary" type="button" id="btn-print-sheet">${icon('print', 15)} Print sheet</button>
        <button class="btn btn-primary" type="button" id="btn-commit" ${active.lines.length ? '' : 'disabled'}>
          ${icon('checkCircle', 16)} Review &amp; complete
        </button>
      </div>`
    });
  }

  root.innerHTML = `
  <div class="page">
    ${pageHead({
      title: 'Stock Count',
      subtitle: 'Compare physical stock with the system, then post the differences as audited adjustments.',
      actions: `
        ${active
          ? `<button class="btn btn-secondary" type="button" id="btn-abandon">${icon('close', 16)} Abandon count</button>`
          : `<button class="btn btn-primary" type="button" id="btn-start">${icon('plus', 16)} Start stock count</button>`}`
    })}

    ${active ? sheetHtml : `
      <div class="grid-dash">
        <div class="span-12">
          ${card({
            body: emptyState({
              iconName: 'clipboard',
              title: 'No stock count in progress',
              message: 'Start a count to check physical stock against the system. You can count the whole inventory or selected categories, and scan batch QR Codes to jump straight to a batch.',
              actions: '<button class="btn btn-primary" type="button" id="btn-start-empty">Start stock count</button>'
            })
          })}
        </div>
      </div>`}

    <div class="grid-dash">
      <div class="span-12">
        ${card({
          title: 'Past stock counts',
          sub: `${pastSessions.length} completed session(s)`,
          actions: can('export.data')
            ? `<button class="btn btn-secondary btn-sm" type="button" id="btn-export">${icon('download', 14)} CSV</button>`
            : '',
          flush: true,
          body: renderTable({
            columns: [
              { key: 'ref', label: 'Reference', cell: (s) => cellStack(s.ref, fmtRelative(s.completedAt)) },
              { key: 'scope', label: 'Scope', cell: (s) => cellStack(s.scope === 'all' ? 'Entire inventory' : 'Selected categories', s.scope === 'all' ? '' : s.categories.join(', ')) },
              { key: 'lines', label: 'Batches', className: 'num', cell: (s) => int(s.lines.length) },
              { key: 'variance', label: 'Variance units', className: 'num', cell: (s) => int(s.totalVariance) },
              {
                key: 'valueImpact', label: 'Value impact', className: 'num',
                cell: (s) => `<span class="${s.valueImpact < 0 ? 'c-danger' : 'c-success'}">${money(s.valueImpact)}</span>`
              },
              { key: 'userName', label: 'Counted by', cell: (s) => escapeHtml(s.userName) },
              { key: 'duration', label: 'Duration', cell: (s) => fmtDuration(s.startedAt, s.completedAt) },
              {
                key: 'actions', label: '', className: 'right',
                cell: (s) => `<div class="table-actions">
                  <button class="btn btn-ghost btn-sm" type="button" data-open="${s.id}" title="View session">${icon('eye', 15)}</button>
                </div>`
              }
            ],
            rows: pastSessions,
            empty: emptyState({ iconName: 'clipboard', title: 'No completed counts yet' })
          })
        })}
      </div>
    </div>
  </div>`;

  /* ---------------------------- events ---------------------------- */

  const rerender = () => ctx.refresh();

  qsa('#btn-start, #btn-start-empty', root).forEach((b) => b.addEventListener('click', openStartModal));

  const abandonBtn = qs('#btn-abandon', root);
  if (abandonBtn) abandonBtn.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Abandon this stock count?',
      message: `${active.lines.length} counted line(s) will be discarded. No stock has been changed.`,
      confirmLabel: 'Abandon count',
      tone: 'danger',
      iconName: 'trash'
    });
    if (!ok) return;
    const index = db.stockCounts.findIndex((s) => s.id === active.id);
    if (index >= 0) db.stockCounts.splice(index, 1);
    state.activeId = '';
    notifyWarning('Stock count abandoned', 'Nothing was posted to inventory.');
    rerender();
  });

  if (active) {
    // Physical quantity entry: save on change or Enter.
    on(root, 'change', 'input[data-count]', (event, node) => {
      if (node.value === '') return;
      const batchId = node.getAttribute('data-count');
      const rowNode = node.closest('tr');
      saveLine(active, batchId, node.value, rowNode);
    });

    on(root, 'keydown', 'input[data-count]', (event, node) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      node.blur();
      // Move to the next quantity input for fast sequential counting.
      const inputs = qsa('input[data-count]', root);
      const index = inputs.indexOf(node);
      if (index >= 0 && inputs[index + 1]) inputs[index + 1].focus();
    });

    const blindToggle = qs('#opt-blind', root);
    if (blindToggle) blindToggle.addEventListener('change', () => { state.blind = blindToggle.checked; rerender(); });

    const uncountedToggle = qs('#opt-uncounted', root);
    if (uncountedToggle) uncountedToggle.addEventListener('change', () => {
      state.onlyUncounted = uncountedToggle.checked;
      state.page = 1;
      rerender();
    });

    const sheetSearch = qs('#sheet-search', root);
    if (sheetSearch) sheetSearch.addEventListener('input', debounce(() => {
      state.query = sheetSearch.value;
      state.page = 1;
      const caret = sheetSearch.selectionStart;
      rerender();
      const next = qs('#sheet-search');
      if (next) { next.focus(); next.setSelectionRange(caret, caret); }
    }, 260));

    const scanBtn = qs('#btn-scan-count', root);
    if (scanBtn) scanBtn.addEventListener('click', () => openCountScanModal(active));

    qs('#btn-commit', root).addEventListener('click', () => commitFlow(active));
    qs('#btn-print-sheet', root).addEventListener('click', () => printSession(active));

    on(root, 'click', '[data-page]', (event, node) => {
      const page = num(node.getAttribute('data-page'));
      if (page >= 1) { state.page = page; rerender(); }
    });
  }

  on(root, 'click', '[data-open]', (event, node) => openSessionDrawer(node.getAttribute('data-open')));

  const exportBtn = qs('#btn-export', root);
  if (exportBtn) exportBtn.addEventListener('click', () => {
    const flat = [];
    pastSessions.forEach((s) => s.lines.forEach((l) => flat.push({ s, l })));
    downloadCsv(exportName('stock-counts'), flat, [
      { label: 'Session', value: ({ s }) => s.ref },
      { label: 'Completed', value: ({ s }) => fmtDate(s.completedAt) },
      { label: 'Counted by', value: ({ s }) => s.userName },
      { label: 'Medicine', value: ({ l }) => l.medicineName },
      { label: 'Batch', value: ({ l }) => l.batchNo },
      { label: 'System qty', value: ({ l }) => l.system },
      { label: 'Physical qty', value: ({ l }) => l.physical },
      { label: 'Difference', value: ({ l }) => l.diff },
      { label: 'Value impact', value: ({ l }) => l.valueImpact }
    ]);
    notifySuccess('Export ready', `${flat.length} count lines exported.`);
  });
}

/** Local wrapper: pagination is only shown when there is more than one page. */
function renderPaginationSafe(pageData) {
  if (!pageData || pageData.pages <= 1) return '';
  let buttons = '';
  for (let p = 1; p <= pageData.pages; p++) {
    buttons += `<button class="page-btn${p === pageData.page ? ' is-active' : ''}" type="button" data-page="${p}">${p}</button>`;
  }
  return `<div class="pagination">
    <span class="pagination-info">Showing <strong>${pageData.from}-${pageData.to}</strong> of <strong>${pageData.total}</strong> batches</span>
    <div class="pagination-pages">${buttons}</div>
  </div>`;
}

export default { render };
