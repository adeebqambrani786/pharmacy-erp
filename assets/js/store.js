/* ==========================================================================
   MediFlow Pharmacy ERP - Data layer & business logic
   --------------------------------------------------------------------------
   The single gateway to persisted state. Every stock movement, sale, receipt,
   adjustment and audit entry is created here so the business rules in section
   28 of the specification can never be bypassed by a UI module.

   Storage: LocalStorage (demo only). If storage is unavailable the store falls
   back to an in-memory database and raises a visible warning - see initStore().
   ========================================================================== */

import {
  uid, makeRef, isoNow, num, round, sum, daysUntil, deepClone, sortBy,
  startOfDay, endOfDay, isoDate, groupBy, norm, matchesQuery
} from './utils.js';
import { buildSeed } from './data/seed.js';

/* ============================== CONSTANTS ============================== */

export const STORAGE_KEY = 'mediflow.erp.v1';
// Bumped to v2 so a session persisted by an earlier build (which could open on
// the lock screen) is ignored rather than restored.
export const SESSION_KEY = 'mediflow.session.v2';
export const SCHEMA_VERSION = 1;

/** Batch lifecycle states. Expiry is always derived from the date, never stored. */
export const BATCH_STATUS = {
  ACTIVE: 'active',
  QUARANTINED: 'quarantined',
  WRITTEN_OFF: 'written-off'
}

;

export const MOVEMENT_TYPES = {
  RECEIPT: 'receipt',
  SALE: 'sale',
  SALE_VOID: 'sale-void',
  RETURN: 'return',
  ADJUSTMENT: 'adjustment',
  COUNT: 'stock-count',
  WRITE_OFF: 'write-off',
  SUPPLIER_RETURN: 'supplier-return'
}

;

/** Empty shape used for a fresh database and for validating imports. */
function emptyDb() {
  return {
    meta: { schema: SCHEMA_VERSION, createdAt: isoNow(), seeded: false },
    settings: {},
    counters: {},
    users: [],
    suppliers: [],
    medicines: [],
    batches: [],
    customers: [],
    sales: [],
    returns: [],
    goodsReceipts: [],
    adjustments: [],
    stockCounts: [],
    expenses: [],
    shifts: [],
    movements: [],
    activity: [],
    creditPayments: [],
    supplierPayments: [],
    heldBills: []
  };
}

export const COLLECTIONS = Object.keys(emptyDb()).filter((k) => Array.isArray(emptyDb()[k]));

/* ============================== STATE ============================== */

/**
 * Live database object. Modules import this reference directly; it is always
 * mutated in place (never reassigned) so imported bindings stay valid.
 */
export const db = emptyDb();

let storageAvailable = true;
let saveQueued = false;
const listeners = new Set();

/** Subscribe to "database changed" notifications. Returns an unsubscribe fn. */
export function onChange(handler) {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

function notify(reason) {
  listeners.forEach((fn) => {
    try { fn(reason); } catch (error) { console.error('[store] listener failed:', error); }
  });
}

export function isStorageAvailable() {
  return storageAvailable;
}

/* ============================== PERSISTENCE ============================== */

function probeStorage() {
  try {
    const probe = '__mediflow_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/** Replace the contents of `db` in place. */
function replaceDb(next) {
  Object.keys(db).forEach((key) => { delete db[key]; });
  Object.assign(db, next);
}

/** Write the database to LocalStorage. Debounced to one write per frame. */
export function save({ immediate = false } = {}) {
  if (!storageAvailable) return;
  const write = () => {
    saveQueued = false;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    } catch (error) {
      console.error('[store] save failed:', error);
      storageAvailable = false;
      notify('storage-error');
    }
  };
  if (immediate) { write(); return; }
  if (saveQueued) return;
  saveQueued = true;
  (window.requestAnimationFrame || setTimeout)(write, 0);
}

/**
 * Run a mutation, persist it, and notify subscribers.
 * Every write path in the application goes through this helper so a single
 * failure point handles persistence and change propagation.
 */
export function tx(mutator, reason = 'update') {
  const result = mutator(db);
  save();
  notify(reason);
  return result;
}

/** Load from storage, or build the demo seed on first run. */
export async function initStore() {
  storageAvailable = probeStorage();

  let loaded = null;
  if (storageAvailable) {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) loaded = JSON.parse(raw);
    } catch (error) {
      console.error('[store] could not parse stored data, rebuilding seed:', error);
      loaded = null;
    }
  }

  if (loaded && loaded.meta && Array.isArray(loaded.medicines)) {
    // Merge onto the empty shape so databases written by older builds still load.
    replaceDb({ ...emptyDb(), ...loaded });
  } else {
    replaceDb(await buildSeed());
    save({ immediate: true });
  }

  runStartupMaintenance();
  notify('init');
  return { storageAvailable };
}

/** Rebuild the demo dataset from scratch. */
export async function resetDemoData() {
  replaceDb(await buildSeed());
  save({ immediate: true });
  runStartupMaintenance();
  notify('reset');
}

/** Full JSON backup payload. */
export function exportBackup() {
  return { exportedAt: isoNow(), app: 'MediFlow Pharmacy ERP', schema: SCHEMA_VERSION, data: deepClone(db) };
}

/**
 * Restore from a backup object produced by exportBackup().
 * Throws a descriptive Error when the payload is not a MediFlow backup.
 */
export function importBackup(payload) {
  const data = payload && payload.data ? payload.data : payload;
  if (!data || typeof data !== 'object') throw new Error('The file does not contain MediFlow backup data.');
  if (!Array.isArray(data.medicines) || !Array.isArray(data.users)) {
    throw new Error('Backup is missing required records (medicines / users).');
  }
  replaceDb({ ...emptyDb(), ...data });
  save({ immediate: true });
  runStartupMaintenance();
  notify('restore');
}

/** Maintenance that must run whenever the database is (re)loaded. */
function runStartupMaintenance() {
  fillMissingQrCodes();
  autoQuarantineExpired();
}

/**
 * Give every batch a QR payload. Seeded and imported batches arrive without
 * one so that buildQrPayload() stays the single implementation of the format.
 * Silent by design - this is housekeeping, not a user action.
 */
function fillMissingQrCodes() {
  let count = 0;
  db.batches.forEach((row) => {
    if (row.qr) return;
    const med = medicine(row.medicineId);
    if (!med) return;
    row.qr = buildQrPayload(med, row);
    row.qrGeneratedAt = row.receivedAt || isoNow();
    count++;
  });
  if (count) save();
  return count;
}

/* ============================== IDs & REFERENCES ============================== */

/** Next sequential reference for a document type, e.g. nextRef('SL', 'sale'). */
export function nextRef(prefix, counterKey) {
  if (!db.counters) db.counters = {};
  const next = num(db.counters[counterKey]) + 1;
  db.counters[counterKey] = next;
  return makeRef(prefix, next);
}

/* ============================== GENERIC ACCESS ============================== */

export function list(collection) {
  return db[collection] || [];
}

export function find(collection, id) {
  if (!id) return null;
  return (db[collection] || []).find((row) => row.id === id) || null;
}

/* ============================== SETTINGS ============================== */

export function settings() {
  return db.settings;
}

export function updateSettings(patch, user) {
  return tx(() => {
    Object.entries(patch).forEach(([group, values]) => {
      db.settings[group] = { ...(db.settings[group] || {}), ...values };
    });
    if (user) {
      logActivity({
        user, action: 'settings.update',
        description: `Updated ${Object.keys(patch).join(', ')} settings`
      });
    }
    return db.settings;
  }, 'settings');
}

/* ============================== ACTIVITY LOG ============================== */

/**
 * Append an immutable audit entry. Never called directly by UI modules for
 * stock/financial events - those operations log themselves.
 */
export function logActivity({ user, action, description, ref = '', meta = null }) {
  const entry = {
    id: uid('act'),
    datetime: isoNow(),
    userId: user ? user.id : 'system',
    userName: user ? user.name : 'System',
    role: user ? user.role : 'system',
    action,
    description,
    ref,
    meta
  };
  db.activity.unshift(entry);
  // Keep the demo log bounded so LocalStorage never overflows.
  if (db.activity.length > 4000) db.activity.length = 4000;
  return entry;
}

/** Audit entry written outside an existing transaction. */
export function recordActivity(payload) {
  return tx(() => logActivity(payload), 'activity');
}

export function activityFor(filters = {}) {
  const { userId, action, from, to, query } = filters;
  return db.activity.filter((entry) => {
    if (userId && entry.userId !== userId) return false;
    if (action && !entry.action.startsWith(action)) return false;
    if (from && new Date(entry.datetime) < startOfDay(from)) return false;
    if (to && new Date(entry.datetime) > endOfDay(to)) return false;
    if (query && !matchesQuery(`${entry.userName} ${entry.action} ${entry.description} ${entry.ref}`, query)) return false;
    return true;
  });
}

/* ============================== STOCK MOVEMENTS ============================== */

/**
 * The ONLY function allowed to change a batch quantity.
 * @returns the created movement record
 * @throws when the movement would drive stock negative (rule 8)
 */
function moveStock({ batch, delta, type, ref, user, note = '', unitCost = null }) {
  const change = Math.round(num(delta));
  if (!batch) throw new Error('Stock movement requires a valid batch.');
  if (change === 0) throw new Error('Stock movement quantity cannot be zero.');

  const before = num(batch.qty);
  const after = before + change;
  if (after < 0) {
    throw new Error(`Insufficient stock in batch ${batch.batchNo}: ${before} available, ${Math.abs(change)} requested.`);
  }

  batch.qty = after;
  const movement = {
    id: uid('mov'),
    datetime: isoNow(),
    batchId: batch.id,
    medicineId: batch.medicineId,
    batchNo: batch.batchNo,
    type,
    qty: change,
    before,
    after,
    unitCost: unitCost === null ? num(batch.costPrice) : num(unitCost),
    ref,
    userId: user ? user.id : 'system',
    userName: user ? user.name : 'System',
    note
  };
  db.movements.unshift(movement);
  if (db.movements.length > 8000) db.movements.length = 8000;
  return movement;
}

export function movementsFor({ batchId, medicineId, type, from, to } = {}) {
  return db.movements.filter((m) => {
    if (batchId && m.batchId !== batchId) return false;
    if (medicineId && m.medicineId !== medicineId) return false;
    if (type && m.type !== type) return false;
    if (from && new Date(m.datetime) < startOfDay(from)) return false;
    if (to && new Date(m.datetime) > endOfDay(to)) return false;
    return true;
  });
}

/* ============================== MEDICINES & BATCHES ============================== */

export function medicines() { return db.medicines; }
export function medicine(id) { return find('medicines', id); }
export function batches() { return db.batches; }
export function batch(id) { return find('batches', id); }

export function isExpired(batchRow) {
  return !!batchRow && daysUntil(batchRow.expiry) < 0;
}

export function isQuarantined(batchRow) {
  return !!batchRow && batchRow.status === BATCH_STATUS.QUARANTINED;
}

export function isWrittenOff(batchRow) {
  return !!batchRow && batchRow.status === BATCH_STATUS.WRITTEN_OFF;
}

/** A batch may only be dispensed when active, in date and in stock (rules 6, 7). */
export function isSellable(batchRow) {
  return !!batchRow
    && batchRow.status === BATCH_STATUS.ACTIVE
    && !isExpired(batchRow)
    && num(batchRow.qty) > 0;
}

/** Human status label for a single batch. */
export function batchState(batchRow) {
  if (!batchRow) return { key: 'unknown', label: 'Unknown', tone: 'neutral' };
  if (isWrittenOff(batchRow)) return { key: 'written-off', label: 'Written Off', tone: 'neutral' };
  if (isExpired(batchRow)) return { key: 'expired', label: 'Expired', tone: 'danger' };
  if (isQuarantined(batchRow)) return { key: 'quarantined', label: 'Quarantined', tone: 'warning' };
  if (num(batchRow.qty) <= 0) return { key: 'empty', label: 'Out of Stock', tone: 'neutral' };
  const days = daysUntil(batchRow.expiry);
  const window = num(db.settings?.inventory?.expiryAlertDays, 90);
  if (days <= window) return { key: 'expiring', label: `Expires in ${days}d`, tone: 'warning' };
  return { key: 'ok', label: 'In Stock', tone: 'success' };
}

export function batchesOf(medicineId) {
  return db.batches.filter((b) => b.medicineId === medicineId);
}

/**
 * FEFO queue: sellable batches for a medicine, earliest valid expiry first.
 * This is the single source of batch priority used by POS and reporting.
 */
export function fefoBatches(medicineId) {
  return sortBy(batchesOf(medicineId).filter(isSellable), (b) => b.expiry, 'asc');
}

/** Quantity that may legally be dispensed today. */
export function sellableQty(medicineId) {
  return sum(batchesOf(medicineId).filter(isSellable), (b) => b.qty);
}

export function reorderLevel(med) {
  return num(med.reorderLevel, num(db.settings?.inventory?.reorderLevel, 20));
}

/** Current selling price = price of the next FEFO batch, else last known price. */
export function currentPrice(medicineId) {
  const queue = fefoBatches(medicineId);
  if (queue.length) return num(queue[0].price);
  const all = sortBy(batchesOf(medicineId), (b) => b.receivedAt, 'desc');
  return all.length ? num(all[0].price) : 0;
}

/** Weighted average cost of the stock currently on hand (admin only figure). */
export function averageCost(medicineId) {
  const rows = batchesOf(medicineId).filter((b) => !isWrittenOff(b) && num(b.qty) > 0);
  const units = sum(rows, (b) => b.qty);
  if (!units) {
    const all = sortBy(batchesOf(medicineId), (b) => b.receivedAt, 'desc');
    return all.length ? num(all[0].costPrice) : 0;
  }
  return round(sum(rows, (b) => num(b.qty) * num(b.costPrice)) / units, 2);
}

/** Aggregate stock position for one medicine - used by inventory and reports. */
export function stockSummary(medicineId) {
  const rows = batchesOf(medicineId).filter((b) => !isWrittenOff(b));
  const med = medicine(medicineId);
  const sellable = rows.filter(isSellable);
  const expired = rows.filter((b) => isExpired(b) && num(b.qty) > 0);
  const quarantined = rows.filter((b) => isQuarantined(b) && !isExpired(b) && num(b.qty) > 0);
  const window = num(db.settings?.inventory?.expiryAlertDays, 90);
  const expiring = sellable.filter((b) => daysUntil(b.expiry) <= window);
  const available = sum(sellable, (b) => b.qty);
  const level = med ? reorderLevel(med) : 20;

  let status = 'ok';
  if (available <= 0) status = 'out';
  else if (available <= level) status = 'low';
  else if (expiring.length) status = 'expiring';

  return {
    medicineId,
    available,
    total: sum(rows, (b) => b.qty),
    batches: rows.length,
    sellableBatches: sellable.length,
    expiredUnits: sum(expired, (b) => b.qty),
    quarantinedUnits: sum(quarantined, (b) => b.qty),
    expiringBatches: expiring.length,
    earliestExpiry: sellable.length ? sortBy(sellable, (b) => b.expiry, 'asc')[0].expiry : null,
    reorderLevel: level,
    status,
    price: currentPrice(medicineId),
    cost: averageCost(medicineId),
    stockValueCost: round(sum(rows, (b) => num(b.qty) * num(b.costPrice)), 2),
    stockValueRetail: round(sum(rows, (b) => num(b.qty) * num(b.price)), 2)
  };
}

export const STATUS_LABELS = {
  ok: { label: 'In Stock', tone: 'success' },
  low: { label: 'Low Stock', tone: 'warning' },
  out: { label: 'Out of Stock', tone: 'danger' },
  expiring: { label: 'Expiring Soon', tone: 'warning' }
}

;

/** Free-text medicine search across name, generic, SKU, barcode and QR payload. */
export function searchMedicines(query, { limit = 0, sellableOnly = false } = {}) {
  const q = norm(query);
  let rows = db.medicines.filter((med) => med.status !== 'discontinued' || !q);
  if (q) {
    rows = db.medicines.filter((med) => {
      const haystack = `${med.name} ${med.genericName} ${med.strength} ${med.sku} ${med.barcode} ${med.category} ${med.manufacturer}`;
      if (matchesQuery(haystack, q)) return true;
      // Exact SKU / barcode / batch QR hits (scanner input)
      return batchesOf(med.id).some((b) => norm(b.batchNo) === q || norm(b.qr) === q);
    });
  }
  if (sellableOnly) rows = rows.filter((med) => sellableQty(med.id) > 0);
  const sorted = sortBy(rows, (m) => m.name, 'asc');
  return limit ? sorted.slice(0, limit) : sorted;
}

/* ---------------------------- medicine CRUD ---------------------------- */

export function createMedicine(payload, user) {
  return tx(() => {
    const med = {
      id: uid('med'),
      name: payload.name,
      genericName: payload.genericName || '',
      strength: payload.strength || '',
      form: payload.form || 'Tablet',
      category: payload.category || 'Other',
      manufacturer: payload.manufacturer || '',
      nafdac: payload.nafdac || '',
      sku: payload.sku || `MF-${String(db.medicines.length + 1).padStart(4, '0')}`,
      barcode: payload.barcode || '',
      supplierId: payload.supplierId || '',
      storage: payload.storage || 'Room temperature (15-25 C)',
      prescriptionRequired: !!payload.prescriptionRequired,
      packSize: num(payload.packSize, 1) || 1,
      reorderLevel: num(payload.reorderLevel, num(db.settings?.inventory?.reorderLevel, 20)),
      status: payload.status || 'active',
      createdAt: isoNow(),
      createdBy: user ? user.id : 'system'
    };
    db.medicines.push(med);
    logActivity({
      user, action: 'medicine.create',
      description: `Added medicine ${med.name} ${med.strength} (${med.sku})`,
      ref: med.sku
    });
    return med;
  }, 'medicines');
}

/**
 * Update medicine master data. Quantity is intentionally NOT updatable here -
 * stock may only change through authorised stock workflows (section 7).
 */
export function updateMedicine(id, payload, user) {
  return tx(() => {
    const med = medicine(id);
    if (!med) throw new Error('Medicine not found.');
    const changes = [];
    const fields = ['name', 'genericName', 'strength', 'form', 'category', 'manufacturer',
      'nafdac', 'sku', 'barcode', 'supplierId', 'storage', 'packSize', 'reorderLevel', 'status'];
    fields.forEach((field) => {
      if (payload[field] === undefined) return;
      const next = (field === 'packSize' || field === 'reorderLevel') ? num(payload[field]) : payload[field];
      if (String(med[field] ?? '') !== String(next ?? '')) {
        changes.push(field);
        med[field] = next;
      }
    });
    if (payload.prescriptionRequired !== undefined && med.prescriptionRequired !== !!payload.prescriptionRequired) {
      med.prescriptionRequired = !!payload.prescriptionRequired;
      changes.push('prescriptionRequired');
    }
    med.updatedAt = isoNow();
    logActivity({
      user, action: 'medicine.update',
      description: `Updated ${med.name} ${med.strength}${changes.length ? ` (${changes.join(', ')})` : ''}`,
      ref: med.sku
    });
    return med;
  }, 'medicines');
}

/** Change a batch selling price; always audited because it affects revenue. */
export function updateBatchPrice(batchId, price, user) {
  return tx(() => {
    const row = batch(batchId);
    if (!row) throw new Error('Batch not found.');
    const med = medicine(row.medicineId);
    const previous = num(row.price);
    row.price = round(num(price), 2);
    logActivity({
      user, action: 'medicine.price',
      description: `Price of ${med ? med.name : 'medicine'} batch ${row.batchNo} changed from ${previous} to ${row.price}`,
      ref: row.batchNo
    });
    return row;
  }, 'batches');
}

/* ============================== QR CODES ============================== */

/**
 * Deterministic QR payload for a batch. Only stable internal identifiers are
 * encoded - never price or quantity (section 9).
 */
export function buildQrPayload(med, batchRow) {
  return [
    'MEDIFLOW',
    `MED:${med.id}`,
    `BAT:${batchRow.id}`,
    `SKU:${med.sku}`,
    `BN:${batchRow.batchNo}`
  ].join('|');
}

/** Parse a scanned string into a resolved medicine/batch, or explain the failure. */
export function resolveScan(raw) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, reason: 'empty', message: 'Nothing was scanned.' };

  // 1. MediFlow QR payload
  if (/^MEDIFLOW\|/i.test(text)) {
    const parts = text.split('|').reduce((acc, part) => {
      const [key, ...rest] = part.split(':');
      if (rest.length) acc[key.toUpperCase()] = rest.join(':');
      return acc;
    }, {});
    const batchRow = batch(parts.BAT) || db.batches.find((b) => norm(b.qr) === norm(text));
    const med = medicine(parts.MED) || (batchRow ? medicine(batchRow.medicineId) : null);
    if (!med) return { ok: false, reason: 'unknown', message: 'This MediFlow code is not linked to any medicine in your inventory.', raw: text };
    return { ok: true, type: 'qr', medicine: med, batch: batchRow || null, raw: text };
  }

  // 2. Exact QR string stored on a batch
  const byQr = db.batches.find((b) => norm(b.qr) === norm(text));
  if (byQr) return { ok: true, type: 'qr', medicine: medicine(byQr.medicineId), batch: byQr, raw: text };

  // 3. Batch number
  const byBatchNo = db.batches.find((b) => norm(b.batchNo) === norm(text));
  if (byBatchNo) return { ok: true, type: 'batch', medicine: medicine(byBatchNo.medicineId), batch: byBatchNo, raw: text };

  // 4. Barcode or SKU on the medicine record
  const byCode = db.medicines.find((m) => norm(m.barcode) === norm(text) || norm(m.sku) === norm(text));
  if (byCode) return { ok: true, type: 'barcode', medicine: byCode, batch: null, raw: text };

  return { ok: false, reason: 'unknown', message: `No medicine matches "${text}".`, raw: text };
}

/** Generate (or refresh) the QR payload stored on a batch. */
export function generateBatchQr(batchId, user, { silent = false } = {}) {
  return tx(() => {
    const row = batch(batchId);
    if (!row) throw new Error('Batch not found.');
    const med = medicine(row.medicineId);
    row.qr = buildQrPayload(med, row);
    row.qrGeneratedAt = isoNow();
    if (!silent) {
      logActivity({
        user, action: 'qr.generate',
        description: `Generated QR Code for ${med.name} batch ${row.batchNo}`,
        ref: row.batchNo
      });
    }
    return row;
  }, 'batches');
}

export function generateMissingQrCodes(user) {
  return tx(() => {
    let count = 0;
    db.batches.forEach((row) => {
      if (row.qr) return;
      const med = medicine(row.medicineId);
      if (!med) return;
      row.qr = buildQrPayload(med, row);
      row.qrGeneratedAt = isoNow();
      count++;
    });
    if (count) {
      logActivity({ user, action: 'qr.generate', description: `Generated QR Codes for ${count} batches` });
    }
    return count;
  }, 'batches');
}

/* ============================== GOODS RECEIVING ============================== */

/**
 * Confirm a goods receipt. Stock only increases here (rule 16).
 * lines: [{ medicineId, batchId?, batchNo, expiry, qty, bonusQty, costPrice,
 *           price, packSize?, location? }]
 */
export function receiveGoods({ user, supplierId, invoiceNo, note, lines }, options = {}) {
  if (!Array.isArray(lines) || !lines.length) throw new Error('Add at least one line before confirming the receipt.');

  return tx(() => {
    const ref = nextRef('GR', 'goodsReceipt');
    const now = isoNow();
    const recordedLines = [];

    lines.forEach((line) => {
      const med = medicine(line.medicineId);
      if (!med) throw new Error('A line references a medicine that no longer exists.');
      const qty = Math.round(num(line.qty));
      const bonus = Math.round(num(line.bonusQty));
      if (qty <= 0) throw new Error(`Enter a received quantity for ${med.name}.`);

      let target = line.batchId ? batch(line.batchId) : null;

      // Guard against duplicate batch records for the same medicine/batch number.
      if (!target && line.batchNo) {
        target = db.batches.find((b) => b.medicineId === med.id && norm(b.batchNo) === norm(line.batchNo));
      }

      let created = false;
      if (!target) {
        target = {
          id: uid('bat'),
          medicineId: med.id,
          batchNo: line.batchNo || `AUTO-${Date.now().toString(36).toUpperCase()}`,
          expiry: line.expiry,
          costPrice: round(num(line.costPrice), 2),
          price: round(num(line.price), 2),
          qty: 0,
          packSize: num(line.packSize, med.packSize || 1) || 1,
          supplierId: supplierId || med.supplierId || '',
          receivedAt: now,
          location: line.location || 'Main Shelf',
          status: BATCH_STATUS.ACTIVE,
          qr: ''
        };
        target.qr = buildQrPayload(med, target);
        target.qrGeneratedAt = now;
        db.batches.push(target);
        created = true;
      } else {
        // Topping up an existing batch refreshes its commercial terms.
        if (line.costPrice !== undefined && num(line.costPrice) > 0) target.costPrice = round(num(line.costPrice), 2);
        if (line.price !== undefined && num(line.price) > 0) target.price = round(num(line.price), 2);
        if (line.expiry) target.expiry = line.expiry;
        if (line.location) target.location = line.location;
        target.receivedAt = now;
        // Receiving fresh stock clears an expiry quarantine only when back in date.
        if (target.status === BATCH_STATUS.QUARANTINED && daysUntil(target.expiry) >= 0 && target.quarantineReason === 'Expired') {
          target.status = BATCH_STATUS.ACTIVE;
          delete target.quarantineReason;
        }
        if (!target.qr) { target.qr = buildQrPayload(med, target); target.qrGeneratedAt = now; }
      }

      const totalUnits = qty + bonus;
      moveStock({
        batch: target, delta: totalUnits, type: MOVEMENT_TYPES.RECEIPT,
        ref, user, unitCost: target.costPrice,
        note: bonus ? `${qty} purchased + ${bonus} bonus` : ''
      });

      recordedLines.push({
        medicineId: med.id,
        medicineName: `${med.name} ${med.strength}`.trim(),
        batchId: target.id,
        batchNo: target.batchNo,
        expiry: target.expiry,
        qty, bonusQty: bonus, units: totalUnits,
        costPrice: round(num(line.costPrice), 2),
        price: round(num(line.price), 2),
        lineTotal: round(qty * num(line.costPrice), 2),
        newBatch: created
      });
    });

    const total = round(sum(recordedLines, (l) => l.lineTotal), 2);
    const receipt = {
      id: uid('grn'),
      ref,
      datetime: now,
      userId: user.id,
      userName: user.name,
      supplierId: supplierId || '',
      invoiceNo: invoiceNo || '',
      note: note || '',
      lines: recordedLines,
      units: sum(recordedLines, (l) => l.units),
      total,
      paid: !!options.markPaid
    };
    db.goodsReceipts.unshift(receipt);

    // Unpaid receipts increase the supplier's outstanding balance.
    const supplier = find('suppliers', supplierId);
    if (supplier && !options.markPaid) {
      supplier.balance = round(num(supplier.balance) + total, 2);
      supplier.lastSupplyAt = now;
    } else if (supplier) {
      supplier.lastSupplyAt = now;
    }

    const newBatches = recordedLines.filter((l) => l.newBatch).length;
    logActivity({
      user, action: 'stock.receive',
      description: `Received ${receipt.units} units across ${recordedLines.length} line(s)`
        + `${supplier ? ` from ${supplier.name}` : ''}${newBatches ? `, ${newBatches} new batch(es)` : ''}`,
      ref
    });

    return receipt;
  }, 'receive');
}

/* ============================== STOCK ADJUSTMENT ============================== */

/**
 * Admin stock correction. `type` is 'increase' or 'decrease'.
 * Every adjustment carries a reason and a responsible user (rule 11).
 */
export function adjustStock({ user, batchId, type, qty, reason, note, source = 'manual' }) {
  return tx(() => {
    const row = batch(batchId);
    if (!row) throw new Error('Select a batch to adjust.');
    const amount = Math.round(num(qty));
    if (amount <= 0) throw new Error('Adjustment quantity must be greater than zero.');
    if (!reason) throw new Error('Select an adjustment reason.');

    const delta = type === 'decrease' ? -amount : amount;
    const before = num(row.qty);
    if (type === 'decrease' && amount > before) {
      throw new Error(`Cannot remove ${amount} units - only ${before} in batch ${row.batchNo}.`);
    }

    const ref = nextRef('ADJ', 'adjustment');
    moveStock({ batch: row, delta, type: MOVEMENT_TYPES.ADJUSTMENT, ref, user, note: reason });

    const med = medicine(row.medicineId);
    const record = {
      id: uid('adj'),
      ref,
      datetime: isoNow(),
      userId: user.id,
      userName: user.name,
      medicineId: row.medicineId,
      medicineName: med ? `${med.name} ${med.strength}`.trim() : '',
      batchId: row.id,
      batchNo: row.batchNo,
      type,
      qty: amount,
      before,
      after: num(row.qty),
      reason,
      note: note || '',
      source,
      valueImpact: round(delta * num(row.costPrice), 2)
    };
    db.adjustments.unshift(record);

    logActivity({
      user, action: 'stock.adjust',
      description: `${type === 'decrease' ? 'Reduced' : 'Increased'} ${med ? med.name : 'stock'} batch ${row.batchNo} by ${amount} (${reason})`,
      ref
    });
    return record;
  }, 'adjust');
}

/* ============================== EXPIRY & QUARANTINE ============================== */

/** Quarantine expired batches automatically when the setting is enabled. */
export function autoQuarantineExpired() {
  if (!db.settings?.inventory?.autoQuarantine) return 0;
  let count = 0;
  db.batches.forEach((row) => {
    if (row.status === BATCH_STATUS.ACTIVE && isExpired(row) && num(row.qty) > 0) {
      row.status = BATCH_STATUS.QUARANTINED;
      row.quarantineReason = 'Expired';
      row.quarantinedAt = isoNow();
      count++;
    }
  });
  if (count) {
    logActivity({
      user: null, action: 'stock.quarantine',
      description: `Automatically quarantined ${count} expired batch(es)`
    });
    save();
  }
  return count;
}

export function setBatchQuarantine(batchId, quarantined, user, reason = 'Manual quarantine') {
  return tx(() => {
    const row = batch(batchId);
    if (!row) throw new Error('Batch not found.');
    if (!quarantined && isExpired(row)) throw new Error('An expired batch cannot be released back to sellable stock.');
    row.status = quarantined ? BATCH_STATUS.QUARANTINED : BATCH_STATUS.ACTIVE;
    if (quarantined) { row.quarantineReason = reason; row.quarantinedAt = isoNow(); }
    else { delete row.quarantineReason; delete row.quarantinedAt; }
    const med = medicine(row.medicineId);
    logActivity({
      user, action: 'stock.quarantine',
      description: `${quarantined ? 'Quarantined' : 'Released'} ${med ? med.name : 'batch'} ${row.batchNo}${quarantined ? ` (${reason})` : ''}`,
      ref: row.batchNo
    });
    return row;
  }, 'batches');
}

/** Write off the remaining units of a batch (disposal). */
export function writeOffBatch(batchId, user, { reason = 'Expired / Disposed', note = '' } = {}) {
  return tx(() => {
    const row = batch(batchId);
    if (!row) throw new Error('Batch not found.');
    const qty = num(row.qty);
    if (qty <= 0) throw new Error('This batch has no remaining stock to write off.');

    const ref = nextRef('WO', 'writeOff');
    moveStock({ batch: row, delta: -qty, type: MOVEMENT_TYPES.WRITE_OFF, ref, user, note: reason });
    row.status = BATCH_STATUS.WRITTEN_OFF;
    row.writtenOffAt = isoNow();

    const med = medicine(row.medicineId);
    const record = {
      id: uid('adj'), ref, datetime: isoNow(),
      userId: user.id, userName: user.name,
      medicineId: row.medicineId,
      medicineName: med ? `${med.name} ${med.strength}`.trim() : '',
      batchId: row.id, batchNo: row.batchNo,
      type: 'decrease', qty, before: qty, after: 0,
      reason, note, source: 'write-off',
      valueImpact: round(-qty * num(row.costPrice), 2)
    };
    db.adjustments.unshift(record);
    logActivity({
      user, action: 'stock.writeoff',
      description: `Wrote off ${qty} units of ${med ? med.name : 'medicine'} batch ${row.batchNo} (${reason})`,
      ref
    });
    return record;
  }, 'writeoff');
}

/** Send quarantined/expired stock back to the supplier. */
export function returnBatchToSupplier(batchId, user, { qty, note = '' } = {}) {
  return tx(() => {
    const row = batch(batchId);
    if (!row) throw new Error('Batch not found.');
    const amount = Math.round(num(qty, row.qty));
    if (amount <= 0 || amount > num(row.qty)) throw new Error(`Enter a quantity between 1 and ${num(row.qty)}.`);

    const ref = nextRef('SRN', 'supplierReturn');
    moveStock({ batch: row, delta: -amount, type: MOVEMENT_TYPES.SUPPLIER_RETURN, ref, user, note: 'Returned to supplier' });
    if (num(row.qty) === 0) row.status = BATCH_STATUS.WRITTEN_OFF;

    const med = medicine(row.medicineId);
    const supplier = find('suppliers', row.supplierId);
    const value = round(amount * num(row.costPrice), 2);

    // A supplier return reduces what we owe that supplier.
    if (supplier) supplier.balance = round(num(supplier.balance) - value, 2);

    const record = {
      id: uid('adj'), ref, datetime: isoNow(),
      userId: user.id, userName: user.name,
      medicineId: row.medicineId,
      medicineName: med ? `${med.name} ${med.strength}`.trim() : '',
      batchId: row.id, batchNo: row.batchNo,
      type: 'decrease', qty: amount,
      before: num(row.qty) + amount, after: num(row.qty),
      reason: 'Returned to supplier', note, source: 'supplier-return',
      valueImpact: round(-value, 2),
      supplierId: row.supplierId
    };
    db.adjustments.unshift(record);
    logActivity({
      user, action: 'stock.supplier-return',
      description: `Returned ${amount} units of ${med ? med.name : 'medicine'} batch ${row.batchNo} to ${supplier ? supplier.name : 'supplier'}`,
      ref
    });
    return record;
  }, 'supplier-return');
}

/** Batches grouped by expiry horizon, for the Expiry & Quarantine module. */
export function expiryBuckets() {
  const rows = db.batches.filter((b) => !isWrittenOff(b) && num(b.qty) > 0);
  const bucket = (min, max) => rows.filter((b) => {
    const d = daysUntil(b.expiry);
    return d >= min && d <= max;
  });
  return {
    expired: rows.filter((b) => daysUntil(b.expiry) < 0),
    d30: bucket(0, 30),
    d60: bucket(31, 60),
    d90: bucket(61, 90),
    quarantined: rows.filter((b) => isQuarantined(b))
  };
}

/* ============================== FEFO ALLOCATION ============================== */

/**
 * Allocate a quantity across FEFO-ordered batches (section 8).
 * This is the single allocator used by the point of sale - expired and
 * quarantined batches are excluded, and a short allocation is reported rather
 * than silently truncated.
 *
 * @param {string} medicineId
 * @param {number} qty units required
 * @param {{exclude?:string[], reserved?:(batchId:string)=>number, prefer?:string}} options
 *   exclude  - batch ids to skip entirely
 *   reserved - units of a batch already committed elsewhere (e.g. a POS cart),
 *              so the same unit is never allocated twice before checkout
 *   prefer   - a batch id to try first (a scanned batch), with the rest of the
 *              queue still in strict expiry order behind it
 */
export function allocateFefo(medicineId, qty, { exclude = [], reserved = null, prefer = '' } = {}) {
  const wanted = Math.round(num(qty));
  const committed = typeof reserved === 'function' ? reserved : () => 0;

  let queue = fefoBatches(medicineId).filter((b) => !exclude.includes(b.id));
  if (prefer) queue = sortBy(queue, (b) => (b.id === prefer ? 0 : 1), 'asc');

  const freeOf = (b) => Math.max(0, num(b.qty) - num(committed(b.id)));

  const lines = [];
  let remaining = wanted;

  for (const b of queue) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, freeOf(b));
    if (take <= 0) continue;
    lines.push({
      batchId: b.id, batchNo: b.batchNo, expiry: b.expiry,
      qty: take, price: num(b.price), costPrice: num(b.costPrice)
    });
    remaining -= take;
  }

  return {
    lines,
    allocated: wanted - remaining,
    shortfall: remaining,
    complete: remaining === 0,
    available: sum(queue, freeOf)
  };
}

/* ============================== CUSTOMERS ============================== */

export function customers() { return db.customers; }
export function customer(id) { return find('customers', id); }

export function createCustomer(payload, user) {
  return tx(() => {
    const row = {
      id: uid('cus'),
      name: payload.name,
      phone: payload.phone || '',
      address: payload.address || '',
      creditLimit: num(payload.creditLimit, num(db.settings?.sales?.defaultCreditLimit, 0)),
      balance: 0,
      totalPurchases: 0,
      active: payload.active === undefined ? true : !!payload.active,
      note: payload.note || '',
      createdAt: isoNow(),
      createdBy: user ? user.id : 'system'
    };
    db.customers.push(row);
    logActivity({ user, action: 'customer.create', description: `Added customer ${row.name}`, ref: row.phone });
    return row;
  }, 'customers');
}

export function updateCustomer(id, payload, user) {
  return tx(() => {
    const row = customer(id);
    if (!row) throw new Error('Customer not found.');
    const limitChanged = payload.creditLimit !== undefined && num(payload.creditLimit) !== num(row.creditLimit);
    ['name', 'phone', 'address', 'note'].forEach((f) => { if (payload[f] !== undefined) row[f] = payload[f]; });
    if (payload.creditLimit !== undefined) row.creditLimit = num(payload.creditLimit);
    if (payload.active !== undefined) row.active = !!payload.active;
    row.updatedAt = isoNow();
    logActivity({
      user, action: limitChanged ? 'customer.credit-limit' : 'customer.update',
      description: limitChanged
        ? `Credit limit for ${row.name} set to ${row.creditLimit}`
        : `Updated customer ${row.name}`,
      ref: row.phone
    });
    return row;
  }, 'customers');
}

/** Available headroom for a credit sale. */
export function creditAvailable(customerId) {
  const row = customer(customerId);
  if (!row) return 0;
  return round(num(row.creditLimit) - num(row.balance), 2);
}

export function recordCreditPayment({ customerId, amount, method, note, user }) {
  return tx(() => {
    const row = customer(customerId);
    if (!row) throw new Error('Customer not found.');
    const value = round(num(amount), 2);
    if (value <= 0) throw new Error('Enter a payment amount greater than zero.');
    if (value > num(row.balance)) throw new Error(`Payment exceeds the outstanding balance of ${num(row.balance)}.`);

    const ref = nextRef('CP', 'creditPayment');
    row.balance = round(num(row.balance) - value, 2);
    const record = {
      id: uid('cpay'), ref, datetime: isoNow(),
      customerId, customerName: row.name,
      amount: value, method: method || 'Cash', note: note || '',
      userId: user.id, userName: user.name,
      balanceAfter: row.balance
    };
    db.creditPayments.unshift(record);
    logActivity({
      user, action: 'customer.payment',
      description: `Received ${value} credit payment from ${row.name} (${method || 'Cash'})`,
      ref
    });
    return record;
  }, 'credit-payment');
}

/** Combined sales + payments ledger for one customer. */
export function customerLedger(customerId) {
  const sales = db.sales
    .filter((s) => s.customerId === customerId && s.status !== 'voided' && num(s.payment.creditAmount) > 0)
    .map((s) => ({ datetime: s.datetime, type: 'Credit sale', ref: s.ref, debit: num(s.payment.creditAmount), credit: 0 }));
  const payments = db.creditPayments
    .filter((p) => p.customerId === customerId)
    .map((p) => ({ datetime: p.datetime, type: `Payment (${p.method})`, ref: p.ref, debit: 0, credit: num(p.amount) }));
  const rows = sortBy([...sales, ...payments], (r) => r.datetime, 'asc');
  let running = 0;
  return rows.map((r) => {
    running = round(running + r.debit - r.credit, 2);
    return { ...r, balance: running };
  }).reverse();
}

/* ============================== SUPPLIERS ============================== */

export function suppliers() { return db.suppliers; }
export function supplier(id) { return find('suppliers', id); }

export function createSupplier(payload, user) {
  return tx(() => {
    const row = {
      id: uid('sup'),
      name: payload.name,
      contactPerson: payload.contactPerson || '',
      phone: payload.phone || '',
      email: payload.email || '',
      address: payload.address || '',
      note: payload.note || '',
      balance: 0,
      active: payload.active === undefined ? true : !!payload.active,
      createdAt: isoNow()
    };
    db.suppliers.push(row);
    logActivity({ user, action: 'supplier.create', description: `Added supplier ${row.name}`, ref: row.phone });
    return row;
  }, 'suppliers');
}

export function updateSupplier(id, payload, user) {
  return tx(() => {
    const row = supplier(id);
    if (!row) throw new Error('Supplier not found.');
    ['name', 'contactPerson', 'phone', 'email', 'address', 'note'].forEach((f) => {
      if (payload[f] !== undefined) row[f] = payload[f];
    });
    if (payload.active !== undefined) row.active = !!payload.active;
    row.updatedAt = isoNow();
    logActivity({ user, action: 'supplier.update', description: `Updated supplier ${row.name}` });
    return row;
  }, 'suppliers');
}

export function recordSupplierPayment({ supplierId, amount, method, invoiceNo, note, user }) {
  return tx(() => {
    const row = supplier(supplierId);
    if (!row) throw new Error('Supplier not found.');
    const value = round(num(amount), 2);
    if (value <= 0) throw new Error('Enter a payment amount greater than zero.');

    const ref = nextRef('SP', 'supplierPayment');
    row.balance = round(num(row.balance) - value, 2);
    const record = {
      id: uid('spay'), ref, datetime: isoNow(),
      supplierId, supplierName: row.name,
      amount: value, method: method || 'Bank Transfer',
      invoiceNo: invoiceNo || '', note: note || '',
      userId: user.id, userName: user.name,
      balanceAfter: row.balance
    };
    db.supplierPayments.unshift(record);
    logActivity({
      user, action: 'supplier.payment',
      description: `Paid ${value} to ${row.name} (${record.method})`,
      ref
    });
    return record;
  }, 'supplier-payment');
}

export function supplierHistory(supplierId) {
  return {
    receipts: db.goodsReceipts.filter((r) => r.supplierId === supplierId),
    payments: db.supplierPayments.filter((p) => p.supplierId === supplierId),
    returns: db.adjustments.filter((a) => a.source === 'supplier-return' && a.supplierId === supplierId)
  };
}

/* ============================== SHIFTS & CASH ============================== */

export function shifts() { return db.shifts; }
export function shift(id) { return find('shifts', id); }

export function activeShift(userId) {
  return db.shifts.find((s) => s.userId === userId && s.status === 'open') || null;
}

export function openShift({ user, openingCash, note }) {
  return tx(() => {
    if (activeShift(user.id)) throw new Error('You already have an open shift. Close it before starting a new one.');
    const ref = nextRef('SH', 'shift');
    const row = {
      id: uid('shf'), ref,
      userId: user.id, userName: user.name,
      openedAt: isoNow(), closedAt: null,
      openingCash: round(num(openingCash), 2),
      countedCash: null, variance: null,
      note: note || '', closingNote: '',
      status: 'open'
    };
    db.shifts.unshift(row);
    logActivity({ user, action: 'shift.open', description: `Opened shift with ${row.openingCash} opening cash`, ref });
    return row;
  }, 'shifts');
}

/** Expected cash is always recalculated from the linked transactions. */
export function shiftSummary(shiftRow) {
  if (!shiftRow) return null;
  const sales = db.sales.filter((s) => s.shiftId === shiftRow.id && s.status !== 'voided');
  const cashSales = round(sum(sales, (s) => (s.payment.method === 'Cash' ? num(s.payment.cashReceived) - num(s.payment.change) : 0)), 2);
  const cardSales = round(sum(sales, (s) => (s.payment.method === 'POS/Card' ? num(s.total) : 0)), 2);
  const transferSales = round(sum(sales, (s) => (s.payment.method === 'Bank Transfer' ? num(s.total) : 0)), 2);
  const creditSales = round(sum(sales, (s) => num(s.payment.creditAmount)), 2);

  // Cash refunds paid out of the drawer during this shift.
  const refunds = db.returns.filter((r) =>
    r.status === 'approved' && r.refundMethod === 'Cash' && r.shiftId === shiftRow.id);
  const cashRefunds = round(sum(refunds, (r) => num(r.total)), 2);

  const expected = round(num(shiftRow.openingCash) + cashSales - cashRefunds, 2);
  const counted = shiftRow.countedCash === null || shiftRow.countedCash === undefined ? null : num(shiftRow.countedCash);

  return {
    shift: shiftRow,
    transactions: sales.length,
    grossSales: round(sum(sales, (s) => num(s.total)), 2),
    cashSales, cardSales, transferSales, creditSales, cashRefunds,
    expectedCash: expected,
    countedCash: counted,
    variance: counted === null ? null : round(counted - expected, 2)
  };
}

export function closeShift({ user, shiftId, countedCash, note }) {
  return tx(() => {
    const row = shift(shiftId);
    if (!row) throw new Error('Shift not found.');
    if (row.status !== 'open') throw new Error('This shift is already closed.');

    const summary = shiftSummary(row);
    row.countedCash = round(num(countedCash), 2);
    row.expectedCash = summary.expectedCash;
    row.cashSales = summary.cashSales;
    row.cashRefunds = summary.cashRefunds;
    row.grossSales = summary.grossSales;
    row.transactions = summary.transactions;
    row.variance = round(row.countedCash - summary.expectedCash, 2);
    row.closingNote = note || '';
    row.closedAt = isoNow();
    row.status = 'closed';

    logActivity({
      user, action: 'shift.close',
      description: `Closed shift ${row.ref}: expected ${summary.expectedCash}, counted ${row.countedCash}`
        + `${row.variance === 0 ? ' (balanced)' : `, variance ${row.variance}`}`,
      ref: row.ref
    });
    return row;
  }, 'shifts');
}

/** Cash currently expected in the drawer across all open shifts. */
export function cashInDrawer() {
  return round(sum(db.shifts.filter((s) => s.status === 'open'), (s) => shiftSummary(s).expectedCash), 2);
}

/* ============================== SALES ============================== */

export function sales() { return db.sales; }
export function sale(id) { return find('sales', id); }

/**
 * Commit a point-of-sale transaction.
 * items: [{ medicineId, batchId, qty, unitPrice, discount?, packMode?, packSize? }]
 * payment: { method, cashReceived?, creditAmount?, reference? }
 */
export function commitSale({ user, customerId, items, payment, prescription, discount = 0, note = '' }) {
  if (!Array.isArray(items) || !items.length) throw new Error('The cart is empty.');

  return tx(() => {
    const method = payment.method || 'Cash';
    const shiftRow = activeShift(user.id);
    const now = isoNow();

    // ---- validate every line against live batch state before touching stock ----
    const prepared = items.map((item) => {
      const med = medicine(item.medicineId);
      if (!med) throw new Error('A cart item references a medicine that no longer exists.');
      const batchRow = batch(item.batchId);
      if (!batchRow) throw new Error(`Select a batch for ${med.name}.`);
      if (!isSellable(batchRow)) {
        throw new Error(`Batch ${batchRow.batchNo} of ${med.name} is ${isExpired(batchRow) ? 'expired' : 'not available'} and cannot be sold.`);
      }
      const qty = Math.round(num(item.qty));
      if (qty <= 0) throw new Error(`Enter a quantity for ${med.name}.`);
      if (qty > num(batchRow.qty)) {
        throw new Error(`Only ${num(batchRow.qty)} units left in batch ${batchRow.batchNo} of ${med.name}.`);
      }
      const unitPrice = round(num(item.unitPrice, batchRow.price), 2);
      const lineDiscount = round(num(item.discount), 2);
      const gross = round(unitPrice * qty, 2);
      return {
        medicineId: med.id,
        name: `${med.name} ${med.strength}`.trim(),
        genericName: med.genericName,
        sku: med.sku,
        form: med.form,
        prescriptionRequired: !!med.prescriptionRequired,
        batchId: batchRow.id,
        batchNo: batchRow.batchNo,
        expiry: batchRow.expiry,
        qty,
        packMode: item.packMode || 'piece',
        packSize: num(item.packSize, batchRow.packSize) || 1,
        unitPrice,
        costPrice: num(batchRow.costPrice),
        discount: lineDiscount,
        total: round(gross - lineDiscount, 2),
        cost: round(num(batchRow.costPrice) * qty, 2),
        batchRow
      };
    });

    // ---- prescription requirement ----
    const needsRx = prepared.some((l) => l.prescriptionRequired);
    if (needsRx && (!prescription || !prescription.doctor)) {
      throw new Error('This sale contains prescription-only medicine - record the prescribing doctor.');
    }

    const subtotal = round(sum(prepared, (l) => round(l.unitPrice * l.qty, 2)), 2);
    const lineDiscounts = round(sum(prepared, (l) => l.discount), 2);
    const billDiscount = round(num(discount), 2);
    const total = round(subtotal - lineDiscounts - billDiscount, 2);
    if (total < 0) throw new Error('Discount cannot exceed the bill total.');

    // ---- payment validation ----
    const cashReceived = round(num(payment.cashReceived), 2);
    let creditAmount = 0;
    let change = 0;

    if (method === 'Credit') {
      if (!db.settings?.sales?.creditEnabled) throw new Error('Credit sales are disabled in settings.');
      if (!customerId) throw new Error('Select a registered customer for a credit sale.');
      const cust = customer(customerId);
      if (!cust) throw new Error('Customer not found.');
      if (!cust.active) throw new Error(`${cust.name}'s account is inactive.`);
      creditAmount = total;
      const headroom = creditAvailable(customerId);
      if (creditAmount > headroom) {
        throw new Error(`Credit limit exceeded. ${cust.name} may only owe ${round(num(cust.creditLimit), 2)} `
          + `(outstanding ${round(num(cust.balance), 2)}, available ${headroom}).`);
      }
    } else if (method === 'Cash') {
      if (cashReceived < total) throw new Error(`Cash received (${cashReceived}) is less than the total (${total}).`);
      change = round(cashReceived - total, 2);
    }

    // ---- deduct stock batch by batch (rule 9) ----
    const ref = nextRef('SL', 'sale');
    prepared.forEach((line) => {
      moveStock({
        batch: line.batchRow, delta: -line.qty, type: MOVEMENT_TYPES.SALE,
        ref, user, note: `Sold ${line.qty} @ ${line.unitPrice}`
      });
      delete line.batchRow;
    });

    const cust = customerId ? customer(customerId) : null;
    const record = {
      id: uid('sal'),
      ref,
      datetime: now,
      userId: user.id,
      userName: user.name,
      customerId: customerId || '',
      customerName: cust ? cust.name : 'Walk-in Customer',
      items: prepared,
      units: sum(prepared, (l) => l.qty),
      subtotal,
      discount: round(lineDiscounts + billDiscount, 2),
      total,
      cost: round(sum(prepared, (l) => l.cost), 2),
      profit: round(total - sum(prepared, (l) => l.cost), 2),
      payment: {
        method,
        cashReceived: method === 'Cash' ? cashReceived : 0,
        change,
        creditAmount,
        reference: payment.reference || ''
      },
      prescription: needsRx ? { doctor: prescription.doctor, reference: prescription.reference || '' } : null,
      shiftId: shiftRow ? shiftRow.id : '',
      note,
      status: 'completed',
      printCount: 0
    };
    db.sales.unshift(record);

    // ---- customer account ----
    if (cust) {
      cust.totalPurchases = round(num(cust.totalPurchases) + total, 2);
      cust.lastPurchaseAt = now;
      if (creditAmount > 0) cust.balance = round(num(cust.balance) + creditAmount, 2);
    }

    logActivity({
      user, action: 'sale.create',
      description: `Sold ${record.units} unit(s) to ${record.customerName} for ${total} (${method})`,
      ref
    });

    return record;
  }, 'sale');
}

/** Void a completed sale and return its stock to the originating batches. */
export function voidSale(saleId, user, reason) {
  return tx(() => {
    const row = sale(saleId);
    if (!row) throw new Error('Sale not found.');
    if (row.status === 'voided') throw new Error('This sale is already voided.');
    if (!reason || !String(reason).trim()) throw new Error('A void reason is required.');

    const hasReturns = db.returns.some((r) => r.saleId === saleId && r.status !== 'rejected');
    if (hasReturns) throw new Error('This sale has return activity - process the return instead of voiding.');

    row.items.forEach((line) => {
      const batchRow = batch(line.batchId);
      if (batchRow && !isWrittenOff(batchRow)) {
        moveStock({
          batch: batchRow, delta: line.qty, type: MOVEMENT_TYPES.SALE_VOID,
          ref: row.ref, user, note: 'Sale voided'
        });
      }
    });

    if (row.customerId) {
      const cust = customer(row.customerId);
      if (cust) {
        cust.totalPurchases = round(num(cust.totalPurchases) - num(row.total), 2);
        if (num(row.payment.creditAmount) > 0) {
          cust.balance = round(num(cust.balance) - num(row.payment.creditAmount), 2);
        }
      }
    }

    row.status = 'voided';
    row.voidReason = String(reason).trim();
    row.voidedAt = isoNow();
    row.voidedBy = user.name;

    logActivity({
      user, action: 'sale.void',
      description: `Voided sale ${row.ref} (${row.total}) - ${row.voidReason}`,
      ref: row.ref
    });
    return row;
  }, 'sale-void');
}

export function markReceiptPrinted(saleId) {
  return tx(() => {
    const row = sale(saleId);
    if (row) row.printCount = num(row.printCount) + 1;
    return row;
  }, 'sale-print');
}

/** Sales filtered for the current viewer; staff only ever see their own. */
export function salesFor({ userId, from, to, method, customerId, status, query } = {}) {
  return db.sales.filter((s) => {
    if (userId && s.userId !== userId) return false;
    if (from && new Date(s.datetime) < startOfDay(from)) return false;
    if (to && new Date(s.datetime) > endOfDay(to)) return false;
    if (method && s.payment.method !== method) return false;
    if (customerId && s.customerId !== customerId) return false;
    if (status && s.status !== status) return false;
    if (query && !matchesQuery(`${s.ref} ${s.customerName} ${s.userName} ${s.items.map((i) => i.name).join(' ')}`, query)) return false;
    return true;
  });
}

/* ============================== HELD BILLS ============================== */

export function holdBill({ user, cart, customerId, note }) {
  return tx(() => {
    const row = {
      id: uid('hold'),
      ref: nextRef('HB', 'heldBill'),
      datetime: isoNow(),
      userId: user.id, userName: user.name,
      customerId: customerId || '',
      cart: deepClone(cart),
      note: note || ''
    };
    db.heldBills.unshift(row);
    return row;
  }, 'held');
}

export function heldBillsFor(userId) {
  return db.heldBills.filter((b) => b.userId === userId);
}

export function dropHeldBill(id) {
  return tx(() => {
    const index = db.heldBills.findIndex((b) => b.id === id);
    if (index >= 0) db.heldBills.splice(index, 1);
  }, 'held');
}

/* ============================== SALES RETURNS ============================== */

/**
 * Staff raise a return request; stock and money only move on approval (rule 18).
 * items: [{ saleItemIndex, qty, reason }]
 */
export function requestReturn({ user, saleId, items, note }) {
  return tx(() => {
    const original = sale(saleId);
    if (!original) throw new Error('Select the original sale.');
    if (original.status === 'voided') throw new Error('This sale has been voided.');
    if (!Array.isArray(items) || !items.length) throw new Error('Select at least one item to return.');

    const alreadyReturned = returnedQtyBySale(saleId);
    const lines = items.map((item) => {
      const source = original.items[item.saleItemIndex];
      if (!source) throw new Error('Invalid return line.');
      const qty = Math.round(num(item.qty));
      if (qty <= 0) throw new Error(`Enter a return quantity for ${source.name}.`);
      const used = num(alreadyReturned[item.saleItemIndex]);
      if (qty + used > source.qty) {
        throw new Error(`Only ${source.qty - used} of ${source.name} remain returnable on this receipt.`);
      }
      if (!item.reason) throw new Error(`Select a return reason for ${source.name}.`);
      const unitNet = round(source.total / source.qty, 2);
      return {
        saleItemIndex: item.saleItemIndex,
        medicineId: source.medicineId,
        name: source.name,
        batchId: source.batchId,
        batchNo: source.batchNo,
        expiry: source.expiry,
        qty,
        unitPrice: source.unitPrice,
        refund: round(unitNet * qty, 2),
        cost: round(num(source.costPrice) * qty, 2),
        reason: item.reason,
        // Damaged and expired goods must never re-enter sellable stock (section 17)
        restock: item.reason !== 'Damaged product' && item.reason !== 'Expired product'
      };
    });

    const ref = nextRef('RT', 'return');
    const record = {
      id: uid('ret'), ref,
      datetime: isoNow(),
      saleId, saleRef: original.ref,
      customerId: original.customerId,
      customerName: original.customerName,
      requestedById: user.id, requestedBy: user.name,
      items: lines,
      total: round(sum(lines, (l) => l.refund), 2),
      cost: round(sum(lines, (l) => l.cost), 2),
      note: note || '',
      status: 'pending',
      refundMethod: '',
      decidedAt: null, decidedBy: '', decisionNote: '',
      shiftId: ''
    };
    db.returns.unshift(record);

    logActivity({
      user, action: 'return.request',
      description: `Requested return of ${sum(lines, (l) => l.qty)} unit(s) from ${original.ref} (${record.total})`,
      ref
    });
    return record;
  }, 'return-request');
}

/** Quantities already returned per sale line, keyed by line index. */
export function returnedQtyBySale(saleId) {
  const map = {};
  db.returns
    .filter((r) => r.saleId === saleId && r.status === 'approved')
    .forEach((r) => r.items.forEach((l) => {
      map[l.saleItemIndex] = num(map[l.saleItemIndex]) + num(l.qty);
    }));
  return map;
}

/** Admin approval: restock eligible lines, quarantine the rest, settle the refund. */
export function approveReturn(returnId, { user, refundMethod, note }) {
  return tx(() => {
    const record = find('returns', returnId);
    if (!record) throw new Error('Return not found.');
    if (record.status !== 'pending') throw new Error('This return has already been processed.');
    if (!refundMethod) throw new Error('Select a refund method.');

    const shiftRow = activeShift(user.id);
    let restocked = 0;
    let quarantined = 0;

    record.items.forEach((line) => {
      const batchRow = batch(line.batchId);
      if (!batchRow || isWrittenOff(batchRow)) return;

      if (line.restock && !isExpired(batchRow)) {
        moveStock({
          batch: batchRow, delta: line.qty, type: MOVEMENT_TYPES.RETURN,
          ref: record.ref, user, note: `Return approved (${line.reason})`
        });
        restocked += line.qty;
      } else {
        // Unsellable returns are recorded as quarantined stock, not sellable units.
        moveStock({
          batch: batchRow, delta: line.qty, type: MOVEMENT_TYPES.RETURN,
          ref: record.ref, user, note: `Return quarantined (${line.reason})`
        });
        batchRow.status = BATCH_STATUS.QUARANTINED;
        batchRow.quarantineReason = line.reason;
        batchRow.quarantinedAt = isoNow();
        quarantined += line.qty;
      }
    });

    record.status = 'approved';
    record.refundMethod = refundMethod;
    record.decidedAt = isoNow();
    record.decidedBy = user.name;
    record.decidedById = user.id;
    record.decisionNote = note || '';
    record.shiftId = shiftRow ? shiftRow.id : '';
    record.restockedUnits = restocked;
    record.quarantinedUnits = quarantined;
    record.creditNoteNo = record.ref.replace('RT-', 'CN-');

    // A credit refund reduces the customer's outstanding balance.
    if (refundMethod === 'Customer Credit' && record.customerId) {
      const cust = customer(record.customerId);
      if (cust) cust.balance = round(Math.max(0, num(cust.balance) - num(record.total)), 2);
    }
    if (record.customerId) {
      const cust = customer(record.customerId);
      if (cust) cust.totalPurchases = round(num(cust.totalPurchases) - num(record.total), 2);
    }

    logActivity({
      user, action: 'return.approve',
      description: `Approved return ${record.ref} (${record.total} via ${refundMethod})`
        + `${quarantined ? `, ${quarantined} unit(s) quarantined` : ''}`,
      ref: record.ref
    });
    return record;
  }, 'return-approve');
}

export function rejectReturn(returnId, { user, note }) {
  return tx(() => {
    const record = find('returns', returnId);
    if (!record) throw new Error('Return not found.');
    if (record.status !== 'pending') throw new Error('This return has already been processed.');
    if (!note || !String(note).trim()) throw new Error('Give a reason for rejecting this return.');
    record.status = 'rejected';
    record.decidedAt = isoNow();
    record.decidedBy = user.name;
    record.decidedById = user.id;
    record.decisionNote = String(note).trim();
    logActivity({
      user, action: 'return.reject',
      description: `Rejected return ${record.ref} - ${record.decisionNote}`,
      ref: record.ref
    });
    return record;
  }, 'return-reject');
}

/* ============================== STOCK COUNT ============================== */

export function startStockCount({ user, scope, categories = [] }) {
  return tx(() => {
    const ref = nextRef('SC', 'stockCount');
    const row = {
      id: uid('cnt'), ref,
      startedAt: isoNow(), completedAt: null,
      userId: user.id, userName: user.name,
      scope: scope || 'all',
      categories,
      lines: [],
      status: 'open',
      totalVariance: 0, valueImpact: 0
    };
    db.stockCounts.unshift(row);
    logActivity({ user, action: 'stock.count-start', description: `Started stock count (${row.scope})`, ref });
    return row;
  }, 'stock-count');
}

/** Batches that belong to a count session, with their system quantities. */
export function stockCountScope(countRow) {
  const rows = db.batches.filter((b) => !isWrittenOff(b));
  if (countRow.scope === 'categories' && countRow.categories.length) {
    return rows.filter((b) => {
      const med = medicine(b.medicineId);
      return med && countRow.categories.includes(med.category);
    });
  }
  return rows;
}

export function saveStockCountLine(countId, { batchId, physical }) {
  return tx(() => {
    const row = find('stockCounts', countId);
    if (!row) throw new Error('Stock count not found.');
    if (row.status !== 'open') throw new Error('This count has been completed.');
    const batchRow = batch(batchId);
    if (!batchRow) throw new Error('Batch not found.');

    const system = num(batchRow.qty);
    const counted = Math.round(num(physical));
    if (counted < 0) throw new Error('Counted quantity cannot be negative.');

    const med = medicine(batchRow.medicineId);
    const line = {
      batchId, batchNo: batchRow.batchNo,
      medicineId: batchRow.medicineId,
      medicineName: med ? `${med.name} ${med.strength}`.trim() : '',
      expiry: batchRow.expiry,
      system, physical: counted,
      diff: counted - system,
      valueImpact: round((counted - system) * num(batchRow.costPrice), 2),
      countedAt: isoNow()
    };
    const index = row.lines.findIndex((l) => l.batchId === batchId);
    if (index >= 0) row.lines[index] = line; else row.lines.push(line);
    row.totalVariance = sum(row.lines, (l) => Math.abs(l.diff));
    row.valueImpact = round(sum(row.lines, (l) => l.valueImpact), 2);
    return line;
  }, 'stock-count');
}

/** Complete a count: each variance becomes an audited stock adjustment. */
export function commitStockCount(countId, { user, note }) {
  return tx(() => {
    const row = find('stockCounts', countId);
    if (!row) throw new Error('Stock count not found.');
    if (row.status !== 'open') throw new Error('This count has already been completed.');
    const variances = row.lines.filter((l) => l.diff !== 0);

    variances.forEach((line) => {
      const batchRow = batch(line.batchId);
      if (!batchRow) return;
      // Re-read the system quantity at commit time so concurrent sales are respected.
      const system = num(batchRow.qty);
      const delta = line.physical - system;
      if (delta === 0) return;
      const ref = nextRef('ADJ', 'adjustment');
      moveStock({
        batch: batchRow, delta, type: MOVEMENT_TYPES.COUNT,
        ref, user, note: `Stock count ${row.ref}`
      });
      db.adjustments.unshift({
        id: uid('adj'), ref, datetime: isoNow(),
        userId: user.id, userName: user.name,
        medicineId: line.medicineId, medicineName: line.medicineName,
        batchId: line.batchId, batchNo: line.batchNo,
        type: delta > 0 ? 'increase' : 'decrease',
        qty: Math.abs(delta), before: system, after: num(batchRow.qty),
        reason: 'Stock count correction',
        note: `Count ${row.ref}`,
        source: 'stock-count',
        valueImpact: round(delta * num(batchRow.costPrice), 2)
      });
    });

    row.status = 'completed';
    row.completedAt = isoNow();
    row.completedBy = user.name;
    row.note = note || '';
    row.adjustmentsCreated = variances.length;

    logActivity({
      user, action: 'stock.count-complete',
      description: `Completed stock count ${row.ref}: ${row.lines.length} batches counted, `
        + `${variances.length} adjustment(s), value impact ${row.valueImpact}`,
      ref: row.ref
    });
    return row;
  }, 'stock-count');
}

/* ============================== EXPENSES ============================== */

export function expenses() { return db.expenses; }

export function createExpense(payload, user) {
  return tx(() => {
    const row = {
      id: uid('exp'),
      ref: nextRef('EX', 'expense'),
      date: payload.date || isoDate(),
      category: payload.category || 'Other',
      amount: round(num(payload.amount), 2),
      method: payload.method || 'Cash',
      description: payload.description || '',
      note: payload.note || '',
      userId: user.id, userName: user.name,
      createdAt: isoNow()
    };
    if (row.amount <= 0) throw new Error('Enter an expense amount greater than zero.');
    db.expenses.unshift(row);
    logActivity({
      user, action: 'expense.create',
      description: `Recorded ${row.category} expense of ${row.amount}`,
      ref: row.ref
    });
    return row;
  }, 'expenses');
}

export function updateExpense(id, payload, user) {
  return tx(() => {
    const row = find('expenses', id);
    if (!row) throw new Error('Expense not found.');
    ['date', 'category', 'method', 'description', 'note'].forEach((f) => {
      if (payload[f] !== undefined) row[f] = payload[f];
    });
    if (payload.amount !== undefined) row.amount = round(num(payload.amount), 2);
    row.updatedAt = isoNow();
    logActivity({ user, action: 'expense.update', description: `Updated expense ${row.ref}`, ref: row.ref });
    return row;
  }, 'expenses');
}

export function deleteExpense(id, user) {
  return tx(() => {
    const index = db.expenses.findIndex((e) => e.id === id);
    if (index < 0) throw new Error('Expense not found.');
    const [row] = db.expenses.splice(index, 1);
    logActivity({ user, action: 'expense.delete', description: `Deleted ${row.category} expense of ${row.amount}`, ref: row.ref });
    return row;
  }, 'expenses');
}

/* ============================== USERS ============================== */

export function users() { return db.users; }
export function user(id) { return find('users', id); }

export function userByUsername(username) {
  const key = norm(username);
  return db.users.find((u) => norm(u.username) === key) || null;
}

export function activeAdminCount() {
  return db.users.filter((u) => u.role === 'admin' && u.active).length;
}

export function addUser(row, actor) {
  return tx(() => {
    db.users.push(row);
    logActivity({
      user: actor, action: 'user.create',
      description: `Created ${row.role} account for ${row.name} (${row.username})`,
      ref: row.username
    });
    return row;
  }, 'users');
}

export function patchUser(id, patch, actor, description) {
  return tx(() => {
    const row = user(id);
    if (!row) throw new Error('User not found.');
    Object.assign(row, patch, { updatedAt: isoNow() });
    if (description) {
      logActivity({ user: actor, action: 'user.update', description, ref: row.username });
    }
    return row;
  }, 'users');
}

export function removeUser(id, actor) {
  return tx(() => {
    const row = user(id);
    if (!row) throw new Error('User not found.');
    if (row.role === 'admin' && activeAdminCount() <= 1) {
      throw new Error('The last active administrator cannot be removed.');
    }
    db.users.splice(db.users.findIndex((u) => u.id === id), 1);
    logActivity({
      user: actor, action: 'user.delete',
      description: `Deleted user ${row.name} (${row.username})`, ref: row.username
    });
    return row;
  }, 'users');
}

/** Per-staff performance figures, always derived from transactions. */
export function staffPerformance({ from, to } = {}) {
  return db.users.map((u) => {
    const userSales = salesFor({ userId: u.id, from, to, status: 'completed' });
    const handledReturns = db.returns.filter((r) => r.requestedById === u.id);
    const closedShifts = db.shifts.filter((s) => s.userId === u.id && s.status === 'closed');
    const revenue = round(sum(userSales, (s) => s.total), 2);
    return {
      user: u,
      transactions: userSales.length,
      units: sum(userSales, (s) => s.units),
      revenue,
      profit: round(sum(userSales, (s) => s.profit), 2),
      average: userSales.length ? round(revenue / userSales.length, 2) : 0,
      cash: round(sum(userSales.filter((s) => s.payment.method === 'Cash'), (s) => s.total), 2),
      card: round(sum(userSales.filter((s) => s.payment.method === 'POS/Card'), (s) => s.total), 2),
      transfer: round(sum(userSales.filter((s) => s.payment.method === 'Bank Transfer'), (s) => s.total), 2),
      credit: round(sum(userSales, (s) => num(s.payment.creditAmount)), 2),
      returns: handledReturns.length,
      shifts: closedShifts.length,
      discrepancy: round(sum(closedShifts, (s) => num(s.variance)), 2)
    };
  });
}

/* ============================== ANALYTICS ============================== */

/** Completed sales within a date range. */
export function completedSales({ from, to, userId } = {}) {
  return salesFor({ from, to, userId, status: 'completed' });
}

/** Approved returns within a date range. */
export function approvedReturns({ from, to } = {}) {
  return db.returns.filter((r) => {
    if (r.status !== 'approved') return false;
    if (from && new Date(r.decidedAt || r.datetime) < startOfDay(from)) return false;
    if (to && new Date(r.decidedAt || r.datetime) > endOfDay(to)) return false;
    return true;
  });
}

/** Headline financials for a period, net of returns and expenses. */
export function financials({ from, to, userId } = {}) {
  const rows = completedSales({ from, to, userId });
  const returns = approvedReturns({ from, to });
  const periodExpenses = db.expenses.filter((e) => {
    if (from && new Date(e.date) < startOfDay(from)) return false;
    if (to && new Date(e.date) > endOfDay(to)) return false;
    return true;
  });

  const revenue = round(sum(rows, (s) => s.total), 2);
  const cogs = round(sum(rows, (s) => s.cost), 2);
  const refunds = round(sum(returns, (r) => r.total), 2);
  const refundCost = round(sum(returns, (r) => r.cost), 2);
  const expenseTotal = round(sum(periodExpenses, (e) => e.amount), 2);
  const netRevenue = round(revenue - refunds, 2);
  const grossProfit = round(netRevenue - (cogs - refundCost), 2);

  return {
    transactions: rows.length,
    units: sum(rows, (s) => s.units),
    revenue, refunds, netRevenue,
    cogs: round(cogs - refundCost, 2),
    grossProfit,
    expenses: expenseTotal,
    netProfit: round(grossProfit - expenseTotal, 2),
    margin: netRevenue ? round((grossProfit / netRevenue) * 100, 1) : 0,
    cash: round(sum(rows.filter((s) => s.payment.method === 'Cash'), (s) => s.total), 2),
    card: round(sum(rows.filter((s) => s.payment.method === 'POS/Card'), (s) => s.total), 2),
    transfer: round(sum(rows.filter((s) => s.payment.method === 'Bank Transfer'), (s) => s.total), 2),
    credit: round(sum(rows, (s) => num(s.payment.creditAmount)), 2),
    discount: round(sum(rows, (s) => s.discount), 2),
    expenseRows: periodExpenses,
    saleRows: rows,
    returnRows: returns
  };
}

/** Total value of stock on hand, at cost and at retail. */
export function inventoryValue() {
  const rows = db.batches.filter((b) => !isWrittenOff(b) && num(b.qty) > 0);
  const sellable = rows.filter(isSellable);
  const dead = rows.filter((b) => !isSellable(b));
  return {
    cost: round(sum(rows, (b) => num(b.qty) * num(b.costPrice)), 2),
    retail: round(sum(rows, (b) => num(b.qty) * num(b.price)), 2),
    sellableCost: round(sum(sellable, (b) => num(b.qty) * num(b.costPrice)), 2),
    quarantinedCost: round(sum(dead, (b) => num(b.qty) * num(b.costPrice)), 2),
    units: sum(rows, (b) => b.qty),
    batches: rows.length
  };
}

/** Units and revenue per medicine over a period, for top/slow-moving reports. */
export function medicineSalesStats({ from, to } = {}) {
  const rows = completedSales({ from, to });
  const map = new Map();
  rows.forEach((s) => s.items.forEach((line) => {
    const entry = map.get(line.medicineId) || { medicineId: line.medicineId, name: line.name, units: 0, revenue: 0, profit: 0, transactions: 0 };
    entry.units += num(line.qty);
    entry.revenue = round(entry.revenue + num(line.total), 2);
    entry.profit = round(entry.profit + (num(line.total) - num(line.cost)), 2);
    entry.transactions += 1;
    map.set(line.medicineId, entry);
  }));
  return [...map.values()];
}

/** Daily revenue series for charts. */
export function dailySeries(days = 14, { userId } = {}) {
  const rows = completedSales({ from: startOfDay(new Date(Date.now() - (days - 1) * 86400000)), userId });
  const byDay = groupBy(rows, (s) => isoDate(s.datetime));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = isoDate(d);
    const dayRows = byDay.get(key) || [];
    out.push({
      key,
      date: d,
      label: d.toLocaleDateString('en-NG', { day: '2-digit', month: 'short' }),
      revenue: round(sum(dayRows, (s) => s.total), 2),
      profit: round(sum(dayRows, (s) => s.profit), 2),
      transactions: dayRows.length
    });
  }
  return out;
}

/** Customers with outstanding credit, bucketed by age of the oldest debt. */
export function creditAging() {
  return db.customers
    .filter((c) => num(c.balance) > 0)
    .map((c) => {
      const open = db.sales.filter((s) => s.customerId === c.id && s.status !== 'voided' && num(s.payment.creditAmount) > 0);
      const oldest = open.length ? sortBy(open, (s) => s.datetime, 'asc')[0].datetime : null;
      const age = oldest ? Math.abs(daysUntil(oldest)) : 0;
      let bucket = 'current';
      if (age > 90) bucket = '90+';
      else if (age > 60) bucket = '61-90';
      else if (age > 30) bucket = '31-60';
      else if (age > 0) bucket = '1-30';
      return { customer: c, balance: round(num(c.balance), 2), oldest, age, bucket };
    });
}

/* ============================== ALERTS ============================== */

/**
 * Priority alerts used by the dashboard and the topbar notification panel.
 * Each alert knows the route it should open.
 */
export function alerts() {
  const out = [];
  const buckets = expiryBuckets();
  const window = num(db.settings?.inventory?.expiryAlertDays, 90);

  if (buckets.expired.length) {
    out.push({
      key: 'expired', tone: 'danger', icon: 'alert',
      title: `${buckets.expired.length} expired batch${buckets.expired.length > 1 ? 'es' : ''}`,
      detail: `${sum(buckets.expired, (b) => b.qty)} units blocked from sale`,
      route: '#/expiry', adminOnly: false
    });
  }
  if (buckets.d30.length) {
    out.push({
      key: 'expiring-30', tone: 'warning', icon: 'clock',
      title: `${buckets.d30.length} batch${buckets.d30.length > 1 ? 'es' : ''} expiring within 30 days`,
      detail: 'Prioritise these batches for dispensing or return',
      route: '#/expiry', adminOnly: false
    });
  }
  if (buckets.d60.length) {
    out.push({
      key: 'expiring-60', tone: 'warning', icon: 'clock',
      title: `${buckets.d60.length} batch${buckets.d60.length > 1 ? 'es' : ''} expiring in 31-60 days`,
      detail: 'Plan supplier returns or promotions',
      route: '#/expiry', adminOnly: true
    });
  }
  if (buckets.d90.length) {
    out.push({
      key: 'expiring-90', tone: 'info', icon: 'clock',
      title: `${buckets.d90.length} batch${buckets.d90.length > 1 ? 'es' : ''} expiring in 61-90 days`,
      detail: `Expiry alert window is ${window} days`,
      route: '#/expiry', adminOnly: true
    });
  }

  const low = db.medicines.filter((med) => {
    const s = stockSummary(med.id);
    return s.status === 'low' || s.status === 'out';
  });
  if (low.length) {
    out.push({
      key: 'low-stock', tone: 'warning', icon: 'box',
      title: `${low.length} medicine${low.length > 1 ? 's' : ''} at or below reorder level`,
      detail: 'Reorder to avoid stock-outs',
      route: '#/inventory?filter=low', adminOnly: false
    });
  }

  const pending = db.returns.filter((r) => r.status === 'pending');
  if (pending.length) {
    out.push({
      key: 'returns', tone: 'info', icon: 'return',
      title: `${pending.length} return${pending.length > 1 ? 's' : ''} awaiting approval`,
      detail: `${round(sum(pending, (r) => r.total), 2)} in requested refunds`,
      route: '#/returns', adminOnly: true
    });
  }

  const openShifts = db.shifts.filter((s) => s.status === 'open');
  if (openShifts.length) {
    out.push({
      key: 'shifts', tone: 'info', icon: 'cash',
      title: `${openShifts.length} open staff shift${openShifts.length > 1 ? 's' : ''}`,
      detail: openShifts.map((s) => s.userName).join(', '),
      route: '#/shift', adminOnly: true
    });
  }

  const owing = db.customers.filter((c) => num(c.balance) > 0);
  if (owing.length) {
    out.push({
      key: 'credit', tone: 'warning', icon: 'users',
      title: `${round(sum(owing, (c) => c.balance), 2)} outstanding customer credit`,
      detail: `${owing.length} customer account${owing.length > 1 ? 's' : ''} with a balance`,
      route: '#/customers?filter=credit', adminOnly: true
    });
  }

  const missingQr = db.batches.filter((b) => !b.qr && !isWrittenOff(b)).length;
  if (missingQr) {
    out.push({
      key: 'qr', tone: 'info', icon: 'qr',
      title: `${missingQr} batch${missingQr > 1 ? 'es' : ''} without a QR Code`,
      detail: 'Generate codes so they can be scanned',
      route: '#/qr', adminOnly: true
    });
  }

  return out;
}

/* ============================== DASHBOARD SNAPSHOT ============================== */

/** Everything the dashboard needs, computed from transaction records. */
export function dashboardSnapshot({ userId = null } = {}) {
  const today = { from: startOfDay(new Date()), to: endOfDay(new Date()) };
  const fin = financials({ ...today, userId: userId || undefined });
  const inventory = inventoryValue();
  const buckets = expiryBuckets();

  const lowStock = db.medicines
    .map((med) => ({ med, summary: stockSummary(med.id) }))
    .filter((row) => row.summary.status === 'low' || row.summary.status === 'out');

  return {
    todaySales: fin.transactions,
    todayRevenue: fin.revenue,
    todayUnits: fin.units,
    grossProfit: fin.grossProfit,
    netProfit: fin.netProfit,
    todayExpenses: fin.expenses,
    cashInDrawer: cashInDrawer(),
    medicinesCount: db.medicines.filter((m) => m.status === 'active').length,
    inventory,
    lowStock,
    expired: buckets.expired,
    expiring30: buckets.d30,
    expiring60: buckets.d60,
    expiring90: buckets.d90,
    quarantined: buckets.quarantined,
    outstandingCredit: round(sum(db.customers, (c) => Math.max(0, num(c.balance))), 2),
    pendingReturns: db.returns.filter((r) => r.status === 'pending'),
    openShifts: db.shifts.filter((s) => s.status === 'open'),
    recentSales: (userId ? db.sales.filter((s) => s.userId === userId) : db.sales).slice(0, 8),
    recentReceipts: db.goodsReceipts.slice(0, 5),
    recentAdjustments: db.adjustments.slice(0, 5),
    recentActivity: db.activity.slice(0, 8),
    financials: fin
  };
}
