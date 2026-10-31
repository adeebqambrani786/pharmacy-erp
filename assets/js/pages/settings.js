/* ==========================================================================
   MediFlow Pharmacy ERP - Settings (admin only)
   Pharmacy profile, inventory rules, sales rules, theme, backup / restore and
   demo reset. Changes are audited like any other operation (section 25).
   ========================================================================== */

import {
  db, settings, updateSettings, exportBackup, importBackup, resetDemoData,
  recordActivity, isStorageAvailable, COLLECTIONS, autoQuarantineExpired,
  generateMissingQrCodes, medicines, users as allUsers
} from '../store.js';
import {
  can, requirePermission, preferredTheme, setPreferredTheme, roleLabel
} from '../auth.js';
import {
  pageHead, card, icon, openModal, modalFooter, confirmDialog, notifySuccess, notifyError,
  notifyWarning, notifyDenied, escapeHtml, field, switchField, printNode, printHeader,
  printFooter
} from '../ui.js';
import {
  money, int, num, fmtDate, fmtDateTime, qs, qsa, on, sum, formData, validate, rule,
  showFormErrors, downloadJson, readFileAsText, exportName
} from '../utils.js';

let ctxRef = null;

/* ============================== SECTION FORMS ============================== */

function savePharmacyProfile(form) {
  const data = formData(form);
  const { valid, errors } = validate(data, {
    name: [rule.required('Enter the pharmacy name'), rule.minLen(2)],
    address: [rule.required('Enter the pharmacy address')],
    phone: [rule.required('Enter a contact phone number'), rule.phone()],
    email: [rule.email()]
  });
  if (!valid) { showFormErrors(form, errors); return; }

  updateSettings({
    pharmacy: {
      name: data.name,
      tagline: data.tagline,
      address: data.address,
      phone: data.phone,
      email: data.email,
      licence: data.licence,
      nafdac: data.nafdac,
      receiptFooter: data.receiptFooter
    }
  }, ctxRef.user);

  notifySuccess('Pharmacy profile saved', 'Receipts and reports now use the updated details.');
  ctxRef.refresh();
}

function saveInventorySettings(form) {
  const data = formData(form);
  const { valid, errors } = validate(data, {
    reorderLevel: [rule.minZero('Reorder level cannot be negative')],
    expiryAlertDays: [rule.custom((v) => num(v) >= 7 && num(v) <= 365, 'Choose between 7 and 365 days')]
  });
  if (!valid) { showFormErrors(form, errors); return; }

  updateSettings({
    inventory: {
      reorderLevel: num(data.reorderLevel),
      expiryAlertDays: num(data.expiryAlertDays),
      autoQuarantine: !!data.autoQuarantine,
      allowNewBatchOnReceive: !!data.allowNewBatchOnReceive,
      fefoEnforced: true, // FEFO is a core rule and cannot be switched off
      allowManualBatchOverride: !!data.allowManualBatchOverride
    }
  }, ctxRef.user);

  // Apply the new quarantine rule immediately.
  const quarantined = autoQuarantineExpired();
  notifySuccess('Inventory settings saved',
    quarantined ? `${quarantined} expired batch(es) were quarantined by the new rule.` : 'Rules applied across the application.');
  ctxRef.refresh();
}

function saveSalesSettings(form) {
  const data = formData(form);
  const { valid, errors } = validate(data, {
    maxStaffDiscount: [rule.custom((v) => num(v) >= 0 && num(v) <= 50, 'Choose between 0% and 50%')],
    defaultCreditLimit: [rule.minZero('Credit limit cannot be negative')]
  });
  if (!valid) { showFormErrors(form, errors); return; }

  updateSettings({
    sales: {
      maxStaffDiscount: num(data.maxStaffDiscount),
      creditEnabled: !!data.creditEnabled,
      defaultCreditLimit: num(data.defaultCreditLimit),
      requirePrescriptionDoctor: !!data.requirePrescriptionDoctor
    }
  }, ctxRef.user);

  notifySuccess('Sales settings saved', 'The point of sale will use the new rules immediately.');
  ctxRef.refresh();
}

/* ============================== BACKUP & RESTORE ============================== */

function downloadBackup() {
  try {
    requirePermission('backup.manage');
  } catch (error) {
    notifyDenied(error);
    return;
  }

  const payload = exportBackup();
  downloadJson(exportName('backup', 'json'), payload);
  recordActivity({
    user: ctxRef.user,
    action: 'data.export',
    description: `Downloaded a full JSON backup (${COLLECTIONS.length} collections)`
  });
  notifySuccess('Backup downloaded', 'Keep the file somewhere safe - it contains every record.');
}

function openRestoreModal() {
  try {
    requirePermission('backup.manage');
  } catch (error) {
    notifyDenied(error);
    return;
  }

  const modal = openModal({
    title: 'Restore from a backup',
    subtitle: 'This replaces every record currently in the application',
    size: 'modal-sm',
    iconName: 'upload',
    tone: 'warning',
    body: `
      <div class="stack-lg">
        <div class="alert alert-danger small">
          ${icon('alert', 16)}
          <div><strong>Everything will be replaced.</strong> Medicines, batches, sales, customers,
          users and settings are all taken from the backup file. Download a backup of the current
          data first if you might need it.</div>
        </div>
        <div class="field">
          <label class="label" for="restore-file">Backup file (.json)</label>
          <input class="input" id="restore-file" type="file" accept="application/json,.json">
          <p class="field-error" data-for="file" hidden></p>
        </div>
        <div id="restore-preview"></div>
      </div>`,
    footer: modalFooter({ confirmLabel: 'Restore data', tone: 'danger' })
  });

  const fileInput = qs('#restore-file', modal.root);
  const preview = qs('#restore-preview', modal.root);
  let parsed = null;

  fileInput.addEventListener('change', async () => {
    preview.innerHTML = '';
    parsed = null;
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;

    try {
      const text = await readFileAsText(file);
      const json = JSON.parse(text);
      const data = json.data || json;
      if (!Array.isArray(data.medicines) || !Array.isArray(data.users)) {
        throw new Error('This file does not look like a MediFlow backup.');
      }
      parsed = json;

      preview.innerHTML = `
        <div class="alert alert-success small">
          ${icon('checkCircle', 16)}
          <div>
            <strong>Backup looks valid.</strong>
            ${json.exportedAt ? `Exported ${fmtDateTime(json.exportedAt)}.` : ''}
          </div>
        </div>
        <div class="card card-pad mt-3">
          <div class="def-grid">
            ${['medicines', 'batches', 'sales', 'customers', 'suppliers', 'users', 'expenses', 'activity']
              .map((key) => `<div class="def-item">
                <div class="def-label">${escapeHtml(key)}</div>
                <div class="def-value num">${int((data[key] || []).length)}</div>
              </div>`).join('')}
          </div>
        </div>`;
    } catch (error) {
      preview.innerHTML = `<div class="alert alert-danger small">${icon('alertCircle', 16)}
        <div>${escapeHtml(error.message)}</div></div>`;
    }
  });

  qs('#modal-confirm', modal.root).addEventListener('click', async (event) => {
    event.preventDefault();
    if (!parsed) {
      notifyError('No valid file selected', 'Choose a MediFlow JSON backup first.');
      return;
    }

    const ok = await confirmDialog({
      title: 'Replace all data?',
      message: 'Every record in this browser will be overwritten by the backup.',
      confirmLabel: 'Replace everything',
      tone: 'danger',
      iconName: 'alertCircle',
      requireText: 'RESTORE'
    });
    if (!ok) return;

    try {
      const actor = ctxRef.user;
      importBackup(parsed);
      recordActivity({
        user: actor,
        action: 'data.restore',
        description: `Restored all data from a JSON backup${parsed.exportedAt ? ` exported ${fmtDate(parsed.exportedAt)}` : ''}`
      });
      modal.close();
      notifySuccess('Data restored', 'The application has been reloaded from your backup.');
      // A restore can change the signed-in user's own record, so reload cleanly.
      setTimeout(() => window.location.reload(), 900);
    } catch (error) {
      notifyError('Restore failed', error.message);
    }
  });
}

async function resetDemoFlow() {
  try {
    requirePermission('backup.manage');
  } catch (error) {
    notifyDenied(error);
    return;
  }

  const ok = await confirmDialog({
    title: 'Reset to the demo dataset?',
    message: 'All current records are deleted and the original demo data is rebuilt.',
    detail: `
      <div class="small">This removes ${int(db.sales.length)} sale(s), ${int(db.medicines.length)} medicine(s),
      ${int(db.customers.length)} customer(s) and every other record, including any user accounts you created.
      Passwords return to the demo credentials.</div>`,
    confirmLabel: 'Reset demo data',
    tone: 'danger',
    iconName: 'refresh',
    requireText: 'RESET'
  });
  if (!ok) return;

  try {
    await resetDemoData();
    notifySuccess('Demo data restored', 'Signing you out so the fresh dataset loads cleanly.');
    setTimeout(() => window.location.reload(), 900);
  } catch (error) {
    notifyError('Reset failed', error.message);
  }
}

/* ============================== STORAGE INFO ============================== */

/** Rough size of the stored database, for the storage panel. */
function storageFootprint() {
  try {
    const raw = JSON.stringify(db);
    const bytes = new Blob([raw]).size;
    return {
      bytes,
      label: bytes > 1048576 ? `${(bytes / 1048576).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`
    };
  } catch {
    return { bytes: 0, label: 'unknown' };
  }
}

/* ============================== RENDER ============================== */

export function render(root, ctx) {
  ctxRef = ctx;
  try {
    requirePermission('settings.manage');
  } catch (error) {
    notifyDenied(error);
    ctx.navigate('/dashboard');
    return;
  }

  const s = settings();
  const pharmacy = s.pharmacy || {};
  const inventory = s.inventory || {};
  const sales = s.sales || {};
  const footprint = storageFootprint();
  const theme = preferredTheme();

  const counts = COLLECTIONS.map((key) => ({ key, count: (db[key] || []).length }));

  root.innerHTML = `
  <div class="page">
    ${pageHead({
      title: 'Settings',
      subtitle: 'Pharmacy profile, inventory and sales rules, appearance, and data management.',
      actions: `<button class="btn btn-secondary" type="button" id="btn-print">${icon('print', 16)} Print configuration</button>`
    })}

    ${!isStorageAvailable() ? `
      <div class="alert alert-danger">
        ${icon('alertCircle', 17)}
        <div>
          <div class="alert-title">Browser storage is unavailable</div>
          <div class="small">MediFlow is running in memory only. Nothing you change will survive
          closing this tab. Enable cookies and site data for this address.</div>
        </div>
      </div>` : ''}

    <div class="grid-dash">
      <!-- ============ Pharmacy profile ============ -->
      <div class="span-7">
        ${card({
          title: 'Pharmacy profile',
          sub: 'Printed on every receipt, label and report',
          body: `
            <form id="profile-form" class="stack-lg" novalidate>
              <div class="grid-2">
                ${field({ name: 'name', label: 'Pharmacy name', value: pharmacy.name, required: true })}
                ${field({ name: 'tagline', label: 'Tagline', value: pharmacy.tagline || '' })}
                ${field({ name: 'address', label: 'Address', value: pharmacy.address, required: true, className: 'col-span-2' })}
                ${field({ name: 'phone', label: 'Phone number', value: pharmacy.phone, required: true, attrs: 'inputmode="tel"' })}
                ${field({ name: 'email', label: 'Email address', type: 'email', value: pharmacy.email || '' })}
                ${field({ name: 'licence', label: 'Premises licence (PCN) number', value: pharmacy.licence || '' })}
                ${field({ name: 'nafdac', label: 'NAFDAC reference', value: pharmacy.nafdac || '' })}
                ${field({
                  name: 'receiptFooter', label: 'Receipt footer / return policy', type: 'textarea',
                  value: pharmacy.receiptFooter || '', className: 'col-span-2', attrs: 'rows="2"'
                })}
              </div>
            </form>`,
          footer: `<div class="spacer"></div>
            <button class="btn btn-primary" type="button" id="save-profile">${icon('check', 15)} Save profile</button>`
        })}
      </div>

      <!-- ============ Appearance & account ============ -->
      <div class="span-5">
        ${card({
          title: 'Appearance',
          body: `
            <div class="stack-lg">
              <div>
                <div class="label mb-2">Theme</div>
                <div class="segmented">
                  <button type="button" data-theme="light" class="${theme === 'light' ? 'is-active' : ''}">${icon('sun', 14)} Light</button>
                  <button type="button" data-theme="dark" class="${theme === 'dark' ? 'is-active' : ''}">${icon('moon', 14)} Dark</button>
                </div>
                <p class="field-hint">The theme is remembered per browser. As the owner it also becomes the pharmacy default.</p>
              </div>
              <div class="divider-label">Your account</div>
              <div class="stack-sm">
                <button class="btn btn-secondary btn-block" type="button" data-action="password">
                  ${icon('lock', 15)} Change my password
                </button>
                <button class="btn btn-secondary btn-block" type="button" data-action="profile">
                  ${icon('user', 15)} View my profile
                </button>
                <button class="btn btn-secondary btn-block" type="button" data-route="#/users">
                  ${icon('shield', 15)} Users &amp; permissions
                </button>
              </div>
            </div>`
        })}
      </div>

      <!-- ============ Inventory settings ============ -->
      <div class="span-6">
        ${card({
          title: 'Inventory rules',
          sub: 'Reorder thresholds, expiry alerts and batch behaviour',
          body: `
            <form id="inventory-form" class="stack-lg" novalidate>
              <div class="grid-2">
                ${field({
                  name: 'reorderLevel', label: 'Default reorder level', type: 'number',
                  value: num(inventory.reorderLevel, 20), attrs: 'min="0" step="1"',
                  hint: 'Used when a medicine has no level of its own'
                })}
                ${field({
                  name: 'expiryAlertDays', label: 'Expiry alert window (days)', type: 'number',
                  value: num(inventory.expiryAlertDays, 90), attrs: 'min="7" max="365" step="1"',
                  hint: 'Batches inside this window are flagged as expiring'
                })}
              </div>
              <div class="stack-sm">
                ${switchField({
                  name: 'autoQuarantine', label: 'Quarantine expired batches automatically',
                  checked: !!inventory.autoQuarantine,
                  hint: 'Runs whenever MediFlow loads and when you open Expiry & Quarantine'
                })}
                ${switchField({
                  name: 'allowNewBatchOnReceive', label: 'Allow new batches during goods receiving',
                  checked: inventory.allowNewBatchOnReceive !== false,
                  hint: 'Turn off to force receiving into existing batches only'
                })}
                ${switchField({
                  name: 'allowManualBatchOverride', label: 'Allow manual batch choice at the point of sale',
                  checked: inventory.allowManualBatchOverride !== false,
                  hint: 'When off, POS always dispenses the FEFO batch'
                })}
              </div>
              <div class="alert alert-info small">
                ${icon('shield', 16)}
                <div><strong>FEFO is always enforced.</strong> The earliest-expiring eligible batch is
                suggested first, and expired or quarantined batches are never sellable. This rule
                cannot be switched off.</div>
              </div>
            </form>`,
          footer: `<div class="spacer"></div>
            <button class="btn btn-primary" type="button" id="save-inventory">${icon('check', 15)} Save inventory rules</button>`
        })}
      </div>

      <!-- ============ Sales settings ============ -->
      <div class="span-6">
        ${card({
          title: 'Sales & credit rules',
          sub: 'Discount ceilings and customer credit policy',
          body: `
            <form id="sales-form" class="stack-lg" novalidate>
              <div class="grid-2">
                ${field({
                  name: 'maxStaffDiscount', label: 'Maximum staff discount (%)', type: 'number',
                  value: num(sales.maxStaffDiscount, 5), attrs: 'min="0" max="50" step="0.5"',
                  hint: 'Set to 0 to stop staff discounting entirely'
                })}
                ${field({
                  name: 'defaultCreditLimit', label: 'Default credit limit for new customers', type: 'number',
                  value: num(sales.defaultCreditLimit, 0), attrs: 'min="0" step="500"'
                })}
              </div>
              <div class="stack-sm">
                ${switchField({
                  name: 'creditEnabled', label: 'Allow credit sales',
                  checked: sales.creditEnabled !== false,
                  hint: 'When off, the Credit payment option is unavailable at the point of sale'
                })}
                ${switchField({
                  name: 'requirePrescriptionDoctor', label: 'Require the prescriber for prescription-only medicines',
                  checked: sales.requirePrescriptionDoctor !== false,
                  hint: 'Recommended - the name is printed on the receipt'
                })}
              </div>
              <div class="card card-pad">
                <div class="stat-line"><span class="sl-label">Customers with a credit balance</span>
                  <span class="sl-value">${int(db.customers.filter((c) => num(c.balance) > 0).length)}</span></div>
                <div class="stat-line"><span class="sl-label">Total outstanding credit</span>
                  <span class="sl-value">${money(sum(db.customers, (c) => Math.max(0, num(c.balance))))}</span></div>
                <div class="stat-line"><span class="sl-label">Prescription-only medicines</span>
                  <span class="sl-value">${int(medicines().filter((m) => m.prescriptionRequired).length)}</span></div>
              </div>
            </form>`,
          footer: `<div class="spacer"></div>
            <button class="btn btn-primary" type="button" id="save-sales">${icon('check', 15)} Save sales rules</button>`
        })}
      </div>

      <!-- ============ Backup & restore ============ -->
      <div class="span-7">
        ${card({
          title: 'Backup & restore',
          sub: 'Export every record as JSON, or rebuild from a file',
          body: `
            <div class="stack-lg">
              <div class="row-wrap">
                <button class="btn btn-primary" type="button" id="btn-backup">${icon('download', 16)} Download backup</button>
                <button class="btn btn-secondary" type="button" id="btn-restore">${icon('upload', 16)} Restore from file</button>
                <button class="btn btn-danger-soft" type="button" id="btn-reset">${icon('refresh', 16)} Reset demo data</button>
              </div>

              <div class="card card-pad">
                <div class="def-label mb-2">Stored data</div>
                <div class="def-grid">
                  ${counts.filter((c) => c.count > 0).map((c) => `
                    <div class="def-item">
                      <div class="def-label">${escapeHtml(c.key)}</div>
                      <div class="def-value num">${int(c.count)}</div>
                    </div>`).join('')}
                </div>
                <div class="stat-line mt-3" style="border-top:1px solid var(--border);padding-top:10px">
                  <span class="sl-label">Approximate size in browser storage</span>
                  <span class="sl-value">${escapeHtml(footprint.label)}</span>
                </div>
                ${db.meta && db.meta.createdAt ? `
                  <div class="stat-line">
                    <span class="sl-label">Database created</span>
                    <span class="sl-value">${fmtDateTime(db.meta.createdAt)}</span>
                  </div>` : ''}
              </div>

              <div class="row-wrap">
                <button class="btn btn-secondary btn-sm" type="button" id="btn-fix-qr">
                  ${icon('qr', 14)} Generate any missing QR Codes
                </button>
                <button class="btn btn-secondary btn-sm" type="button" id="btn-run-quarantine">
                  ${icon('shield', 14)} Re-run expiry quarantine
                </button>
              </div>
            </div>`
        })}
      </div>

      <!-- ============ Production notice ============ -->
      <div class="span-5">
        ${card({
          title: 'Before going live',
          sub: 'What this demo build does not provide',
          body: `
            <div class="alert alert-warning small">
              ${icon('alert', 16)}
              <div><strong>This build stores everything in this browser.</strong> It is a functional
              demonstration, not a production deployment.</div>
            </div>
            <div class="stack-sm mt-4">
              ${[
                ['database', 'A central database and backend API so every device sees the same stock'],
                ['shield', 'Server-side authentication and role checks that a user cannot bypass'],
                ['layers', 'Transaction-safe stock updates, so two tills cannot sell the same unit'],
                ['users', 'Multi-user synchronisation and conflict handling'],
                ['history', 'A permanent, tamper-evident audit history held server-side'],
                ['refresh', 'Automated off-site backups and a tested restore procedure']
              ].map(([iconName, text]) => `
                <div class="row-start">
                  <span class="list-avatar tone-neutral" style="width:26px;height:26px;flex:none">${icon(iconName, 13)}</span>
                  <span class="sm">${escapeHtml(text)}</span>
                </div>`).join('')}
            </div>
            <p class="small muted mt-4">
              Passwords in this demo are hashed with PBKDF2-SHA256 in the browser, which keeps them
              out of plain sight but is not a substitute for server-side authentication.
              See README.md for the full list of production requirements.
            </p>`
        })}
      </div>
    </div>
  </div>`;

  /* ---------------------------- events ---------------------------- */

  qs('#save-profile', root).addEventListener('click', () => savePharmacyProfile(qs('#profile-form', root)));
  qs('#save-inventory', root).addEventListener('click', () => saveInventorySettings(qs('#inventory-form', root)));
  qs('#save-sales', root).addEventListener('click', () => saveSalesSettings(qs('#sales-form', root)));

  qsa('[data-theme]', root).forEach((btn) => btn.addEventListener('click', () => {
    const next = btn.getAttribute('data-theme');
    setPreferredTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    ctx.refresh();
  }));

  qs('#btn-backup', root).addEventListener('click', downloadBackup);
  qs('#btn-restore', root).addEventListener('click', openRestoreModal);
  qs('#btn-reset', root).addEventListener('click', resetDemoFlow);

  qs('#btn-fix-qr', root).addEventListener('click', () => {
    const count = generateMissingQrCodes(ctx.user);
    if (count) notifySuccess('QR Codes generated', `${count} batch code(s) created.`);
    else notifySuccess('Nothing to do', 'Every batch already has a QR Code.');
    ctx.refresh();
  });

  qs('#btn-run-quarantine', root).addEventListener('click', () => {
    const count = autoQuarantineExpired();
    if (count) notifyWarning('Expired batches quarantined', `${count} batch(es) were blocked from sale.`);
    else notifySuccess('Nothing to quarantine', 'No expired batches are sellable.');
    ctx.refresh();
  });

  qs('#btn-print', root).addEventListener('click', () => {
    printNode(`
      <div class="print-doc">
        ${printHeader({
          pharmacy,
          title: 'System Configuration',
          subtitle: 'MediFlow Pharmacy ERP',
          meta: `Generated ${fmtDateTime(new Date())}<br>By ${escapeHtml(ctx.user.name)}`
        })}

        <h2 class="print-section">Pharmacy profile</h2>
        <table><tbody>
          <tr><td>Pharmacy name</td><td>${escapeHtml(pharmacy.name || '-')}</td></tr>
          <tr><td>Address</td><td>${escapeHtml(pharmacy.address || '-')}</td></tr>
          <tr><td>Phone</td><td>${escapeHtml(pharmacy.phone || '-')}</td></tr>
          <tr><td>Email</td><td>${escapeHtml(pharmacy.email || '-')}</td></tr>
          <tr><td>Premises licence</td><td>${escapeHtml(pharmacy.licence || '-')}</td></tr>
          <tr><td>NAFDAC reference</td><td>${escapeHtml(pharmacy.nafdac || '-')}</td></tr>
          <tr><td>Receipt footer</td><td>${escapeHtml(pharmacy.receiptFooter || '-')}</td></tr>
        </tbody></table>

        <h2 class="print-section">Inventory rules</h2>
        <table><tbody>
          <tr><td>Default reorder level</td><td>${int(inventory.reorderLevel)}</td></tr>
          <tr><td>Expiry alert window</td><td>${int(inventory.expiryAlertDays)} days</td></tr>
          <tr><td>Automatic quarantine of expired batches</td><td>${inventory.autoQuarantine ? 'Enabled' : 'Disabled'}</td></tr>
          <tr><td>New batches allowed when receiving</td><td>${inventory.allowNewBatchOnReceive !== false ? 'Yes' : 'No'}</td></tr>
          <tr><td>Manual batch choice at POS</td><td>${inventory.allowManualBatchOverride !== false ? 'Allowed' : 'Blocked'}</td></tr>
          <tr><td>FEFO dispensing</td><td>Always enforced</td></tr>
        </tbody></table>

        <h2 class="print-section">Sales rules</h2>
        <table><tbody>
          <tr><td>Maximum staff discount</td><td>${num(sales.maxStaffDiscount)}%</td></tr>
          <tr><td>Credit sales</td><td>${sales.creditEnabled !== false ? 'Enabled' : 'Disabled'}</td></tr>
          <tr><td>Default credit limit</td><td>${money(sales.defaultCreditLimit)}</td></tr>
          <tr><td>Prescriber required for POM</td><td>${sales.requirePrescriptionDoctor !== false ? 'Yes' : 'No'}</td></tr>
        </tbody></table>

        <h2 class="print-section">User accounts</h2>
        <table>
          <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th>Last sign-in</th></tr></thead>
          <tbody>${allUsers().map((u) => `<tr>
            <td>${escapeHtml(u.name)}</td>
            <td>${escapeHtml(u.username)}</td>
            <td>${escapeHtml(roleLabel(u.role))}</td>
            <td>${u.active ? 'Active' : 'Deactivated'}</td>
            <td>${u.lastLogin ? fmtDateTime(u.lastLogin) : 'Never'}</td>
          </tr>`).join('')}</tbody>
        </table>

        <h2 class="print-section">Stored records</h2>
        <table>
          <thead><tr><th>Collection</th><th class="num">Records</th></tr></thead>
          <tbody>${counts.map((c) => `<tr><td>${escapeHtml(c.key)}</td><td class="num">${int(c.count)}</td></tr>`).join('')}</tbody>
        </table>

        ${printFooter({ left: `${escapeHtml(pharmacy.name)} - configuration record`, right: 'MediFlow Pharmacy ERP' })}
      </div>`, 'report');
  });
}

export default { render };
