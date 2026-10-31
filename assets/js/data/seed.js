/* ==========================================================================
   MediFlow Pharmacy ERP - Demo seed data
   --------------------------------------------------------------------------
   Builds a realistic Nigerian community-pharmacy dataset:
     1 admin + 3 staff, 4 suppliers, 20 medicines, 50+ batches, 12 customers,
     ~45 days of sales history, goods receipts, adjustments, returns, shifts,
     expenses and credit payments.

   The generator REPLAYS history rather than inventing final numbers: stock is
   received into batches, then sales deduct from those batches in expiry order,
   so quantities, movements and reports are mutually consistent and every
   workflow in the specification has data to exercise.
   ========================================================================== */

import { makeCredential } from '../lib/password.js';
import { uid, isoNow, isoDate, round, num } from '../utils.js';

/* ============================== DETERMINISTIC RANDOM ============================== */

/** Small seeded PRNG (mulberry32) so each reset produces the same demo set. */
function createRandom(seed = 20260101) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = createRandom();
const pick = (list) => list[Math.floor(rnd() * list.length)];
const between = (min, max) => Math.floor(rnd() * (max - min + 1)) + min;
const chance = (probability) => rnd() < probability;

/* ============================== DATE HELPERS ============================== */

const DAY = 86400000;
const NOW = new Date();

/** Date n days before today, at a given hour/minute. */
function daysAgo(days, hour = 10, minute = 0) {
  const d = new Date(NOW.getTime() - days * DAY);
  d.setHours(hour, minute, between(0, 59), 0);
  return d;
}

/** ISO date n months from the first of this month (used for expiry dates). */
function monthsAhead(months, day = 28) {
  const d = new Date(NOW.getFullYear(), NOW.getMonth() + months, day);
  return isoDate(d);
}

/** A trading timestamp: pharmacy hours are 08:00 - 20:00. */
function tradingTime(days) {
  const hour = between(8, 19);
  return daysAgo(days, hour, between(0, 59));
}

/* ============================== REFERENCE DATA ============================== */

const SUPPLIER_SEED = [
  {
    name: 'Emzor Pharmaceutical Industries Ltd',
    contactPerson: 'Mrs. Ngozi Okafor',
    phone: '08034567120', email: 'sales@emzorpharma.ng',
    address: '9 Dr. Nnamdi Azikiwe Street, Isolo, Lagos'
  },
  {
    name: 'Fidson Healthcare Plc',
    contactPerson: 'Mr. Tunde Bakare',
    phone: '08091234455', email: 'orders@fidson.ng',
    address: '268 Ikorodu Road, Obanikoro, Lagos'
  },
  {
    name: 'Juhel Nigeria Limited',
    contactPerson: 'Mr. Chukwudi Nnaji',
    phone: '08062228890', email: 'supply@juhelnigeria.ng',
    address: '35 Nkwubor Road, Emene, Enugu'
  },
  {
    name: 'May & Baker Nigeria Plc',
    contactPerson: 'Mrs. Aisha Bello',
    phone: '08155500231', email: 'trade@may-baker.ng',
    address: '3/5 Sapara Street, Ikeja, Lagos'
  }
];

/**
 * Medicine catalogue. `cost` / `price` are the opening commercial terms;
 * later batches vary them slightly to make margin reporting realistic.
 */
const MEDICINE_SEED = [
  { name: 'Paracetamol', genericName: 'Paracetamol', strength: '500mg', form: 'Tablet', category: 'Analgesics', manufacturer: 'Emzor', sku: 'PCM500TAB', cost: 95, price: 150, packSize: 10, reorder: 120, rx: false, supplier: 0 },
  { name: 'Lonart DS', genericName: 'Artemether/Lumefantrine', strength: '80/480mg', form: 'Tablet', category: 'Antimalarials', manufacturer: 'Greenlife', sku: 'LON80TAB', cost: 1750, price: 2500, packSize: 6, reorder: 25, rx: false, supplier: 2 },
  { name: 'Amoxicillin', genericName: 'Amoxicillin Trihydrate', strength: '500mg', form: 'Capsule', category: 'Antibiotics', manufacturer: 'Fidson', sku: 'AMX500CAP', cost: 820, price: 1250, packSize: 10, reorder: 40, rx: true, supplier: 1 },
  { name: 'Ciprofloxacin', genericName: 'Ciprofloxacin HCl', strength: '500mg', form: 'Tablet', category: 'Antibiotics', manufacturer: 'Juhel', sku: 'CIP500TAB', cost: 640, price: 1000, packSize: 10, reorder: 35, rx: true, supplier: 2 },
  { name: 'Flagyl', genericName: 'Metronidazole', strength: '400mg', form: 'Tablet', category: 'Antibiotics', manufacturer: 'May & Baker', sku: 'MET400TAB', cost: 380, price: 600, packSize: 10, reorder: 40, rx: true, supplier: 3 },
  { name: 'Amlodipine', genericName: 'Amlodipine Besylate', strength: '10mg', form: 'Tablet', category: 'Antihypertensives', manufacturer: 'Fidson', sku: 'AML10TAB', cost: 950, price: 1500, packSize: 28, reorder: 20, rx: true, supplier: 1 },
  { name: 'Lisinopril', genericName: 'Lisinopril', strength: '10mg', form: 'Tablet', category: 'Antihypertensives', manufacturer: 'Juhel', sku: 'LIS10TAB', cost: 1100, price: 1700, packSize: 28, reorder: 18, rx: true, supplier: 2 },
  { name: 'Metformin', genericName: 'Metformin HCl', strength: '500mg', form: 'Tablet', category: 'Antidiabetics', manufacturer: 'Emzor', sku: 'MTF500TAB', cost: 780, price: 1200, packSize: 30, reorder: 20, rx: true, supplier: 0 },
  { name: 'Glibenclamide', genericName: 'Glibenclamide', strength: '5mg', form: 'Tablet', category: 'Antidiabetics', manufacturer: 'Juhel', sku: 'GLB5TAB', cost: 420, price: 700, packSize: 30, reorder: 15, rx: true, supplier: 2 },
  { name: 'Loratadine', genericName: 'Loratadine', strength: '10mg', form: 'Tablet', category: 'Antihistamines', manufacturer: 'Emzor', sku: 'LOR10TAB', cost: 310, price: 500, packSize: 10, reorder: 30, rx: false, supplier: 0 },
  { name: 'Piriton', genericName: 'Chlorpheniramine Maleate', strength: '4mg', form: 'Tablet', category: 'Antihistamines', manufacturer: 'GSK', sku: 'CPM4TAB', cost: 180, price: 300, packSize: 10, reorder: 40, rx: false, supplier: 3 },
  { name: 'Vitamin C', genericName: 'Ascorbic Acid', strength: '100mg', form: 'Tablet', category: 'Vitamins & Supplements', manufacturer: 'Emzor', sku: 'VTC100TAB', cost: 210, price: 350, packSize: 100, reorder: 50, rx: false, supplier: 0 },
  { name: 'Folic Acid', genericName: 'Folic Acid', strength: '5mg', form: 'Tablet', category: 'Vitamins & Supplements', manufacturer: 'Juhel', sku: 'FOL5TAB', cost: 150, price: 250, packSize: 30, reorder: 40, rx: false, supplier: 2 },
  { name: 'Astymin Forte', genericName: 'Multivitamin + Amino Acids', strength: '100ml', form: 'Syrup', category: 'Vitamins & Supplements', manufacturer: 'Tabel', sku: 'ASTSYR100', cost: 2100, price: 3000, packSize: 1, reorder: 12, rx: false, supplier: 1 },
  { name: 'Emzor Paracetamol Syrup', genericName: 'Paracetamol', strength: '120mg/5ml', form: 'Syrup', category: 'Analgesics', manufacturer: 'Emzor', sku: 'PCMSYR100', cost: 560, price: 850, packSize: 1, reorder: 24, rx: false, supplier: 0 },
  { name: 'Amoxil Suspension', genericName: 'Amoxicillin', strength: '125mg/5ml', form: 'Suspension', category: 'Antibiotics', manufacturer: 'Fidson', sku: 'AMXSUS125', cost: 980, price: 1500, packSize: 1, reorder: 18, rx: true, supplier: 1 },
  { name: 'Omeprazole', genericName: 'Omeprazole', strength: '20mg', form: 'Capsule', category: 'Gastrointestinal', manufacturer: 'Fidson', sku: 'OMP20CAP', cost: 1250, price: 1900, packSize: 14, reorder: 20, rx: false, supplier: 1 },
  { name: 'Ventolin Inhaler', genericName: 'Salbutamol Sulphate', strength: '100mcg', form: 'Inhaler', category: 'Respiratory', manufacturer: 'GSK', sku: 'SAL100INH', cost: 3400, price: 4800, packSize: 1, reorder: 8, rx: true, supplier: 3 },
  { name: 'Hydrocortisone Cream', genericName: 'Hydrocortisone Acetate', strength: '1% 15g', form: 'Cream', category: 'Dermatology', manufacturer: 'Juhel', sku: 'HYD1CRM', cost: 450, price: 750, packSize: 1, reorder: 15, rx: false, supplier: 2 },
  { name: 'Ceftriaxone Injection', genericName: 'Ceftriaxone Sodium', strength: '1g', form: 'Injection', category: 'Antibiotics', manufacturer: 'Juhel', sku: 'CFX1INJ', cost: 1650, price: 2500, packSize: 1, reorder: 10, rx: true, supplier: 2 }
];

const CUSTOMER_SEED = [
  { name: 'Chinedu Okoro', phone: '08031122334', address: '12 Ogui Road, Enugu', creditLimit: 50000 },
  { name: 'Aisha Mohammed', phone: '08065544332', address: '7 Ahmadu Bello Way, Kaduna', creditLimit: 30000 },
  { name: 'Mrs. Folake Adeniyi', phone: '08022334455', address: '45 Allen Avenue, Ikeja, Lagos', creditLimit: 75000 },
  { name: 'Emeka Nwosu', phone: '08099887766', address: '3 Zik Avenue, Awka', creditLimit: 25000 },
  { name: 'Hauwa Garba', phone: '07033445566', address: '18 Yakubu Gowon Way, Jos', creditLimit: 20000 },
  { name: 'Dr. Samuel Eshiet', phone: '08177665544', address: '22 Aba Road, Port Harcourt', creditLimit: 100000 },
  { name: 'Blessing Udo', phone: '08055667788', address: '9 Oron Road, Uyo', creditLimit: 15000 },
  { name: 'Yusuf Abdullahi', phone: '08144332211', address: '5 Murtala Mohammed Way, Kano', creditLimit: 40000 },
  { name: 'Grace Oyelaran', phone: '08037778899', address: '31 Iwo Road, Ibadan', creditLimit: 0 },
  { name: 'Tope Bamidele', phone: '08188990011', address: '14 Oba Akran Avenue, Ikeja', creditLimit: 0 },
  { name: 'St. Mary Clinic', phone: '08023456789', address: '2 Hospital Road, Onitsha', creditLimit: 150000 },
  { name: 'Ngozi Ibeh', phone: '07066554433', address: '8 New Market Road, Nnewi', creditLimit: 10000 }
];

const STOCK_LOCATIONS = ['Main Shelf A', 'Main Shelf B', 'Cabinet C1', 'Cold Chain Fridge', 'Back Store'];

/* ============================== SEED BUILDER ============================== */

export async function buildSeed() {
  /* ---------------------------------------------------------- settings ---- */
  const settings = {
    pharmacy: {
      name: 'MediFlow Pharmacy',
      tagline: 'Your trusted community pharmacy',
      address: '24 Awolowo Road, Ikoyi, Lagos State, Nigeria',
      phone: '0803 400 7788',
      email: 'care@mediflowpharmacy.ng',
      licence: 'PCN/LAG/2024/04821',
      nafdac: 'NAFDAC-PR-18420',
      receiptFooter: 'Goods returnable within 7 days with receipt. Medicines are not returnable once opened.'
    },
    inventory: {
      reorderLevel: 20,
      expiryAlertDays: 90,
      autoQuarantine: true,
      allowNewBatchOnReceive: true,
      fefoEnforced: true,
      allowManualBatchOverride: true
    },
    sales: {
      maxStaffDiscount: 5,
      creditEnabled: true,
      defaultCreditLimit: 20000,
      requirePrescriptionDoctor: true
    },
    other: {
      theme: 'light',
      lowStockBanner: true
    }
  };

  /* ------------------------------------------------------------- users ---- */
  const [adminCred, chiomaCred, ibrahimCred, funkeCred] = await Promise.all([
    makeCredential('admin123'),
    makeCredential('staff123'),
    makeCredential('staff123'),
    makeCredential('staff123')
  ]);

  const users = [
    {
      id: 'usr_admin', name: 'Pharm. Adebayo Okonkwo', username: 'admin', role: 'admin',
      phone: '08034007788', email: 'adebayo@mediflowpharmacy.ng',
      active: true, permissions: {}, ...adminCred,
      createdAt: daysAgo(400).toISOString(), lastLogin: daysAgo(1, 8, 12).toISOString(),
      previousLogin: daysAgo(2, 8, 30).toISOString(), loginCount: 214
    },
    {
      id: 'usr_staff1', name: 'Chioma Eze', username: 'staff', role: 'staff',
      phone: '08055512345', email: 'chioma@mediflowpharmacy.ng',
      active: true, permissions: { 'pos.discount': true, 'labels.print': false }, ...chiomaCred,
      createdAt: daysAgo(300).toISOString(), lastLogin: daysAgo(0, 8, 5).toISOString(),
      previousLogin: daysAgo(1, 8, 2).toISOString(), loginCount: 168
    },
    {
      id: 'usr_staff2', name: 'Ibrahim Musa', username: 'ibrahim', role: 'staff',
      phone: '08166678901', email: 'ibrahim@mediflowpharmacy.ng',
      active: true, permissions: { 'pos.discount': false }, ...ibrahimCred,
      createdAt: daysAgo(210).toISOString(), lastLogin: daysAgo(1, 14, 40).toISOString(),
      previousLogin: daysAgo(3, 9, 10).toISOString(), loginCount: 96
    },
    {
      id: 'usr_staff3', name: 'Funke Adeyemi', username: 'funke', role: 'staff',
      phone: '07011122233', email: 'funke@mediflowpharmacy.ng',
      active: false, permissions: {}, ...funkeCred,
      createdAt: daysAgo(150).toISOString(), lastLogin: daysAgo(34, 11, 20).toISOString(),
      previousLogin: daysAgo(36, 10, 5).toISOString(), loginCount: 41
    }
  ];

  const admin = users[0];
  const staffUsers = [users[1], users[2]];

  /* --------------------------------------------------------- suppliers ---- */
  const suppliers = SUPPLIER_SEED.map((s, i) => ({
    id: `sup_${i + 1}`,
    ...s,
    note: '',
    balance: 0,
    active: true,
    createdAt: daysAgo(380 - i * 10).toISOString()
  }));

  /* --------------------------------------------------------- medicines ---- */
  const medicines = MEDICINE_SEED.map((m, i) => ({
    id: `med_${String(i + 1).padStart(3, '0')}`,
    name: m.name,
    genericName: m.genericName,
    strength: m.strength,
    form: m.form,
    category: m.category,
    manufacturer: m.manufacturer,
    nafdac: `A4-${between(1000, 9999)}`,
    sku: m.sku,
    barcode: `615${String(1000000000 + i * 7771).slice(0, 10)}`,
    supplierId: suppliers[m.supplier].id,
    storage: m.form === 'Injection' || m.name === 'Astymin Forte'
      ? 'Refrigerated (2-8 C)'
      : (m.form === 'Syrup' || m.form === 'Suspension' ? 'Cool & dry place' : 'Room temperature (15-25 C)'),
    prescriptionRequired: m.rx,
    packSize: m.packSize,
    reorderLevel: m.reorder,
    status: 'active',
    createdAt: daysAgo(365 - i).toISOString(),
    createdBy: admin.id
  }));

  /* ----------------------------------------------------------- batches ---- */
  const batches = [];
  const movements = [];
  const goodsReceipts = [];
  const activity = [];
  const counters = {
    sale: 0, goodsReceipt: 0, adjustment: 0, return: 0, stockCount: 0,
    expense: 0, shift: 0, creditPayment: 0, supplierPayment: 0,
    writeOff: 0, supplierReturn: 0, heldBill: 0
  };

  const ref = (prefix, counterKey, when) => {
    counters[counterKey] += 1;
    const d = when || NOW;
    const yy = String(d.getFullYear()).slice(2);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${prefix}-${yy}${mm}${dd}-${String(counters[counterKey]).padStart(4, '0')}`;
  };

  const addActivity = (user, action, description, when, docRef = '') => {
    activity.push({
      id: uid('act'),
      datetime: (when || NOW).toISOString(),
      userId: user ? user.id : 'system',
      userName: user ? user.name : 'System',
      role: user ? user.role : 'system',
      action, description, ref: docRef, meta: null
    });
  };

  const addMovement = ({ batch, delta, type, docRef, user, when, note = '', before }) => {
    movements.push({
      id: uid('mov'),
      datetime: (when || NOW).toISOString(),
      batchId: batch.id, medicineId: batch.medicineId, batchNo: batch.batchNo,
      type, qty: delta,
      before, after: before + delta,
      unitCost: batch.costPrice,
      ref: docRef,
      userId: user ? user.id : 'system',
      userName: user ? user.name : 'System',
      note
    });
  };

  let batchCounter = 0;

  /**
   * Create a batch and its opening goods-receipt movement.
   * `plan` controls the expiry/quantity scenario so every workflow in the
   * specification has representative data to work with.
   */
  function addBatch(med, spec, receivedDaysAgo, receiptRef, receiptWhen) {
    batchCounter += 1;
    const seedRow = MEDICINE_SEED[medicines.indexOf(med)];
    const costDrift = 1 + (rnd() - 0.4) * 0.12;
    const costPrice = round(num(spec.cost, seedRow.cost) * costDrift, 2);
    const price = round(num(spec.price, seedRow.price) * (1 + (rnd() - 0.35) * 0.08), 2);

    const row = {
      id: `bat_${String(batchCounter).padStart(3, '0')}`,
      medicineId: med.id,
      batchNo: spec.batchNo,
      expiry: spec.expiry,
      costPrice,
      price: Math.max(price, round(costPrice * 1.12, 2)),
      qty: 0,
      packSize: med.packSize,
      supplierId: med.supplierId,
      receivedAt: receiptWhen.toISOString(),
      location: spec.location || pick(STOCK_LOCATIONS),
      status: spec.status || 'active',
      qr: '', // generated by the store on first load (single implementation)
      qrGeneratedAt: null
    };
    if (spec.quarantineReason) {
      row.quarantineReason = spec.quarantineReason;
      row.quarantinedAt = daysAgo(Math.max(1, receivedDaysAgo - 10)).toISOString();
    }
    batches.push(row);

    // Opening receipt movement
    addMovement({
      batch: row, delta: spec.qty, type: 'receipt', docRef: receiptRef,
      user: admin, when: receiptWhen, before: 0
    });
    row.qty = spec.qty;
    return row;
  }

  /**
   * Batch plan per medicine: a mix of healthy, near-expiry, expired,
   * quarantined and low-stock situations (section 27).
   */
  const BATCH_PLANS = medicines.map((med, index) => {
    const code = med.sku.slice(0, 3).toUpperCase();
    const plans = [];

    // Oldest batch - short dated, sometimes already expired
    if (index % 7 === 0) {
      plans.push({ // expired batch, auto-quarantined on load
        batchNo: `${code}-23X${index}`, expiry: monthsAhead(-2, 15), qty: between(6, 24), receivedDaysAgo: 320
      });
    } else if (index % 5 === 0) {
      plans.push({ // expiring within 30 days
        batchNo: `${code}-24A${index}`, expiry: monthsAhead(0, 25), qty: between(10, 40), receivedDaysAgo: 150
      });
    } else if (index % 4 === 0) {
      plans.push({ // expiring within 60 days
        batchNo: `${code}-24B${index}`, expiry: monthsAhead(1, 20), qty: between(14, 50), receivedDaysAgo: 120
      });
    } else {
      plans.push({ // expiring within 90 days
        batchNo: `${code}-24C${index}`, expiry: monthsAhead(2, 18), qty: between(20, 60), receivedDaysAgo: 100
      });
    }

    // Mid-life batch
    plans.push({
      batchNo: `${code}-25A${index}`, expiry: monthsAhead(between(7, 13), 20),
      qty: between(40, 160), receivedDaysAgo: between(45, 80)
    });

    // Freshest batch - most medicines, deliberately omitted for a few so some
    // products sit at or below their reorder level.
    if (index % 6 !== 3) {
      plans.push({
        batchNo: `${code}-25B${index}`, expiry: monthsAhead(between(16, 28), 12),
        qty: between(60, 260), receivedDaysAgo: between(8, 35)
      });
    }

    // One damaged/quarantined batch for the quarantine workflow
    if (index === 2 || index === 11) {
      plans.push({
        batchNo: `${code}-DMG${index}`, expiry: monthsAhead(between(9, 15), 10),
        qty: between(8, 20), receivedDaysAgo: 60,
        status: 'quarantined', quarantineReason: 'Damaged in transit - held for supplier inspection'
      });
    }

    return { med, plans };
  });

  // Group batch creation into goods receipts by supplier + receiving day.
  const receiptGroups = new Map();
  BATCH_PLANS.forEach(({ med, plans }) => {
    plans.forEach((plan) => {
      const key = `${med.supplierId}|${plan.receivedDaysAgo}`;
      if (!receiptGroups.has(key)) receiptGroups.set(key, { supplierId: med.supplierId, daysAgo: plan.receivedDaysAgo, items: [] });
      receiptGroups.get(key).items.push({ med, plan });
    });
  });

  // Oldest receipts first so references read chronologically.
  const orderedGroups = [...receiptGroups.values()].sort((a, b) => b.daysAgo - a.daysAgo);

  orderedGroups.forEach((group) => {
    const when = daysAgo(group.daysAgo, between(9, 15), between(0, 59));
    const docRef = ref('GR', 'goodsReceipt', when);
    const supplier = suppliers.find((s) => s.id === group.supplierId);
    const lines = [];

    group.items.forEach(({ med, plan }) => {
      const row = addBatch(med, plan, group.daysAgo, docRef, when);
      lines.push({
        medicineId: med.id,
        medicineName: `${med.name} ${med.strength}`.trim(),
        batchId: row.id,
        batchNo: row.batchNo,
        expiry: row.expiry,
        qty: plan.qty,
        bonusQty: 0,
        units: plan.qty,
        costPrice: row.costPrice,
        price: row.price,
        lineTotal: round(plan.qty * row.costPrice, 2),
        newBatch: true
      });
    });

    const total = round(lines.reduce((t, l) => t + l.lineTotal, 0), 2);
    const paid = group.daysAgo > 30; // recent invoices are still outstanding
    goodsReceipts.push({
      id: uid('grn'),
      ref: docRef,
      datetime: when.toISOString(),
      userId: admin.id, userName: admin.name,
      supplierId: group.supplierId,
      invoiceNo: `INV/${String(between(1000, 9999))}/${String(when.getFullYear()).slice(2)}`,
      note: '',
      lines,
      units: lines.reduce((t, l) => t + l.units, 0),
      total,
      paid
    });
    if (!paid && supplier) supplier.balance = round(supplier.balance + total, 2);
    if (supplier) supplier.lastSupplyAt = when.toISOString();

    addActivity(admin, 'stock.receive',
      `Received ${lines.reduce((t, l) => t + l.units, 0)} units across ${lines.length} line(s) from ${supplier ? supplier.name : 'supplier'}`,
      when, docRef);
  });

  /* --------------------------------------------------------- customers ---- */
  const customers = CUSTOMER_SEED.map((c, i) => ({
    id: `cus_${String(i + 1).padStart(3, '0')}`,
    name: c.name,
    phone: c.phone,
    address: c.address,
    creditLimit: c.creditLimit,
    balance: 0,
    totalPurchases: 0,
    active: i !== 9, // one inactive account for testing
    note: i === 10 ? 'Institutional account - monthly invoice' : '',
    createdAt: daysAgo(340 - i * 12).toISOString(),
    createdBy: i % 3 === 0 ? admin.id : staffUsers[i % 2].id
  }));

  /* ------------------------------------------------- sales history replay -- */
  const sales = [];

  /**
   * Seed-time batch picker. Mirrors live FEFO but evaluates expiry AS AT the
   * historical sale date, so back-dated sales never dispense stock that was
   * expired on that day.
   */
  function pickBatchesAt(medicineId, qty, when) {
    const eligible = batches
      .filter((b) => b.medicineId === medicineId
        && b.status === 'active'
        && b.qty > 0
        && new Date(b.receivedAt) <= when
        && new Date(b.expiry) > when)
      .sort((a, b) => new Date(a.expiry) - new Date(b.expiry));

    const out = [];
    let remaining = qty;
    for (const b of eligible) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, b.qty);
      if (take > 0) { out.push({ batch: b, qty: take }); remaining -= take; }
    }
    return out;
  }

  // 45 days of trading, busier at weekends, 4-14 transactions a day.
  for (let day = 45; day >= 0; day--) {
    const when0 = daysAgo(day);
    const weekend = when0.getDay() === 0 || when0.getDay() === 6;
    const txCount = day === 0 ? between(3, 7) : between(weekend ? 6 : 4, weekend ? 14 : 11);

    // Timestamps are generated up front and sorted so the day's transactions
    // are replayed in the order they actually happened - this keeps every
    // stock movement's before/after balance chronologically correct.
    const times = Array.from({ length: txCount }, () => tradingTime(day)).sort((a, b) => a - b);

    for (const when of times) {
      const cashier = day === 0 ? pick(staffUsers) : pick([...staffUsers, admin]);
      const lineCount = between(1, 4);
      const items = [];

      for (let li = 0; li < lineCount; li++) {
        const med = pick(medicines);
        if (items.some((i) => i.medicineId === med.id)) continue;
        const wanted = med.form === 'Tablet' || med.form === 'Capsule' ? between(1, 12) : between(1, 3);
        const allocation = pickBatchesAt(med.id, wanted, when);
        allocation.forEach(({ batch: b, qty }) => {
          const before = b.qty;
          b.qty -= qty;
          items.push({
            medicineId: med.id,
            name: `${med.name} ${med.strength}`.trim(),
            genericName: med.genericName,
            sku: med.sku,
            form: med.form,
            prescriptionRequired: med.prescriptionRequired,
            batchId: b.id,
            batchNo: b.batchNo,
            expiry: b.expiry,
            qty,
            packMode: 'piece',
            packSize: b.packSize,
            unitPrice: b.price,
            costPrice: b.costPrice,
            discount: 0,
            total: round(b.price * qty, 2),
            cost: round(b.costPrice * qty, 2),
            _before: before,
            _batch: b
          });
        });
      }

      if (!items.length) continue;

      const needsRx = items.some((i) => i.prescriptionRequired);
      const subtotal = round(items.reduce((s, i) => s + i.unitPrice * i.qty, 0), 2);
      const discount = chance(0.14) ? round(subtotal * (between(1, 4) / 100), 2) : 0;
      const total = round(subtotal - discount, 2);

      // Payment mix: mostly cash, then card, transfer, occasional credit.
      let method = 'Cash';
      const roll = rnd();
      if (roll > 0.92) method = 'Bank Transfer';
      else if (roll > 0.74) method = 'POS/Card';
      else if (roll > 0.68) method = 'Credit';

      let cust = null;
      if (method === 'Credit') {
        const candidates = customers.filter((c) => c.active && c.creditLimit >= total + c.balance);
        cust = candidates.length ? pick(candidates) : null;
        if (!cust) method = 'Cash';
      } else if (chance(0.34)) {
        cust = pick(customers.filter((c) => c.active));
      }

      const cashReceived = method === 'Cash'
        ? round(Math.ceil(total / 100) * 100 + (chance(0.3) ? 500 : 0), 2)
        : 0;
      const docRef = ref('SL', 'sale', when);

      items.forEach((line) => {
        addMovement({
          batch: line._batch, delta: -line.qty, type: 'sale', docRef,
          user: cashier, when, before: line._before,
          note: `Sold ${line.qty} @ ${line.unitPrice}`
        });
        delete line._batch;
        delete line._before;
      });

      const cost = round(items.reduce((s, i) => s + i.cost, 0), 2);
      const record = {
        id: uid('sal'),
        ref: docRef,
        datetime: when.toISOString(),
        userId: cashier.id, userName: cashier.name,
        customerId: cust ? cust.id : '',
        customerName: cust ? cust.name : 'Walk-in Customer',
        items,
        units: items.reduce((s, i) => s + i.qty, 0),
        subtotal,
        discount,
        total,
        cost,
        profit: round(total - cost, 2),
        payment: {
          method,
          cashReceived: method === 'Cash' ? cashReceived : 0,
          change: method === 'Cash' ? round(cashReceived - total, 2) : 0,
          creditAmount: method === 'Credit' ? total : 0,
          reference: method === 'Bank Transfer' ? `TRF${between(100000, 999999)}` : ''
        },
        prescription: needsRx
          ? { doctor: pick(['Dr. Eze Nwachukwu', 'Dr. Amina Sule', 'Dr. Olu Falana', 'Dr. Benedict Umeh']), reference: `RX-${between(10000, 99999)}` }
          : null,
        shiftId: '',
        note: '',
        status: 'completed',
        printCount: 1
      };
      sales.push(record);

      if (cust) {
        cust.totalPurchases = round(cust.totalPurchases + total, 2);
        cust.lastPurchaseAt = when.toISOString();
        if (method === 'Credit') cust.balance = round(cust.balance + total, 2);
      }
    }
  }

  // Newest first, matching the live store's ordering.
  sales.sort((a, b) => new Date(b.datetime) - new Date(a.datetime));

  // A representative sample of sales in the audit log (the log is bounded).
  sales.slice(0, 60).forEach((s) => {
    addActivity(
      users.find((u) => u.id === s.userId),
      'sale.create',
      `Sold ${s.units} unit(s) to ${s.customerName} for ${s.total} (${s.payment.method})`,
      new Date(s.datetime), s.ref
    );
  });

  /* -------------------------------------------------------- adjustments --- */
  const adjustments = [];

  function addAdjustment({ batch, type, qty, reason, note, daysBack, user, source = 'manual' }) {
    const when = daysAgo(daysBack, between(10, 17));
    const docRef = ref('ADJ', 'adjustment', when);
    const before = batch.qty;
    const delta = type === 'decrease' ? -Math.min(qty, before) : qty;
    if (delta === 0) return null;
    batch.qty = before + delta;
    addMovement({
      batch, delta, docRef, user, when, before, note: reason,
      type: source === 'stock-count' ? 'stock-count' : 'adjustment'
    });
    const med = medicines.find((m) => m.id === batch.medicineId);
    const record = {
      id: uid('adj'), ref: docRef, datetime: when.toISOString(),
      userId: user.id, userName: user.name,
      medicineId: batch.medicineId,
      medicineName: med ? `${med.name} ${med.strength}`.trim() : '',
      batchId: batch.id, batchNo: batch.batchNo,
      type, qty: Math.abs(delta),
      before, after: batch.qty,
      reason, note: note || '', source,
      valueImpact: round(delta * batch.costPrice, 2)
    };
    adjustments.push(record);
    addActivity(user, 'stock.adjust',
      `${type === 'decrease' ? 'Reduced' : 'Increased'} ${record.medicineName} batch ${batch.batchNo} by ${Math.abs(delta)} (${reason})`,
      when, docRef);
    return record;
  }

  const stocked = batches.filter((b) => b.qty > 5 && b.status === 'active');

  // The batch whose variance the historical stock count below corrected.
  const countBatch = stocked[9] || stocked[0];

  addAdjustment({ batch: stocked[1], type: 'decrease', qty: 4, reason: 'Damaged', note: 'Broken blister during arrangement', daysBack: 18, user: admin });
  addAdjustment({ batch: stocked[5], type: 'decrease', qty: 2, reason: 'Lost / Stolen', note: 'Unaccounted after stock-take', daysBack: 12, user: admin });
  addAdjustment({ batch: countBatch, type: 'increase', qty: 6, reason: 'Stock count correction', note: 'Found in back store', daysBack: 9, user: admin, source: 'stock-count' });
  addAdjustment({ batch: stocked[14], type: 'decrease', qty: 3, reason: 'Internal use', note: 'Used for in-house first aid', daysBack: 5, user: admin });
  addAdjustment({ batch: stocked[20] || stocked[2], type: 'decrease', qty: 5, reason: 'Expired / Disposed', note: 'Disposed per PCN guidance', daysBack: 3, user: admin });

  adjustments.sort((a, b) => new Date(b.datetime) - new Date(a.datetime));

  /* ------------------------------------------------------------ returns --- */
  const returns = [];

  function addReturn({ sale: src, lineIndexes, reason, status, daysBack, requestedBy, refundMethod }) {
    const when = daysAgo(daysBack, between(11, 18));
    const docRef = ref('RT', 'return', when);
    const lines = lineIndexes.map((idx) => {
      const source = src.items[idx];
      const qty = Math.max(1, Math.floor(source.qty / 2));
      const unitNet = round(source.total / source.qty, 2);
      return {
        saleItemIndex: idx,
        medicineId: source.medicineId,
        name: source.name,
        batchId: source.batchId,
        batchNo: source.batchNo,
        expiry: source.expiry,
        qty,
        unitPrice: source.unitPrice,
        refund: round(unitNet * qty, 2),
        cost: round(source.costPrice * qty, 2),
        reason,
        restock: reason !== 'Damaged product' && reason !== 'Expired product'
      };
    });

    const record = {
      id: uid('ret'), ref: docRef, datetime: when.toISOString(),
      saleId: src.id, saleRef: src.ref,
      customerId: src.customerId, customerName: src.customerName,
      requestedById: requestedBy.id, requestedBy: requestedBy.name,
      items: lines,
      total: round(lines.reduce((t, l) => t + l.refund, 0), 2),
      cost: round(lines.reduce((t, l) => t + l.cost, 0), 2),
      note: '',
      status,
      refundMethod: status === 'approved' ? refundMethod : '',
      decidedAt: status === 'pending' ? null : daysAgo(daysBack - 1, 12).toISOString(),
      decidedBy: status === 'pending' ? '' : admin.name,
      decidedById: status === 'pending' ? '' : admin.id,
      decisionNote: '',
      shiftId: ''
    };

    if (status === 'approved') {
      let restocked = 0;
      let quarantined = 0;
      lines.forEach((line) => {
        const b = batches.find((x) => x.id === line.batchId);
        if (!b) return;
        const before = b.qty;
        b.qty = before + line.qty;
        const sellable = line.restock && new Date(b.expiry) > NOW;
        addMovement({
          batch: b, delta: line.qty, type: 'return', docRef,
          user: admin, when: new Date(record.decidedAt), before,
          note: sellable ? `Return approved (${line.reason})` : `Return quarantined (${line.reason})`
        });
        if (sellable) restocked += line.qty;
        else {
          b.status = 'quarantined';
          b.quarantineReason = line.reason;
          b.quarantinedAt = record.decidedAt;
          quarantined += line.qty;
        }
      });
      record.restockedUnits = restocked;
      record.quarantinedUnits = quarantined;
      record.creditNoteNo = docRef.replace('RT-', 'CN-');
      if (record.customerId) {
        const cust = customers.find((c) => c.id === record.customerId);
        if (cust) cust.totalPurchases = round(cust.totalPurchases - record.total, 2);
      }
      addActivity(admin, 'return.approve',
        `Approved return ${docRef} (${record.total} via ${refundMethod})`, new Date(record.decidedAt), docRef);
    } else {
      addActivity(requestedBy, 'return.request',
        `Requested return of ${lines.reduce((t, l) => t + l.qty, 0)} unit(s) from ${src.ref} (${record.total})`,
        when, docRef);
    }

    returns.push(record);
    return record;
  }

  // Two pending requests awaiting admin approval + one already approved.
  const returnCandidates = sales.filter((s) => s.items.length && s.status === 'completed');
  if (returnCandidates[4]) {
    addReturn({ sale: returnCandidates[4], lineIndexes: [0], reason: 'Wrong medicine', status: 'pending', daysBack: 2, requestedBy: staffUsers[0] });
  }
  if (returnCandidates[9]) {
    addReturn({ sale: returnCandidates[9], lineIndexes: [0], reason: 'Damaged product', status: 'pending', daysBack: 1, requestedBy: staffUsers[1] });
  }
  if (returnCandidates[22]) {
    addReturn({
      sale: returnCandidates[22], lineIndexes: [0], reason: 'Customer changed mind',
      status: 'approved', daysBack: 8, requestedBy: staffUsers[0], refundMethod: 'Cash'
    });
  }

  /* ------------------------------------------------------------- shifts --- */
  const shifts = [];

  function addShift({ user, daysBack, openingCash, status, openHour = 8 }) {
    const openedAt = daysAgo(daysBack, openHour, between(0, 20));
    const docRef = ref('SH', 'shift', openedAt);
    const userSales = sales.filter((s) =>
      s.userId === user.id
      && new Date(s.datetime) >= openedAt
      && new Date(s.datetime) <= daysAgo(daysBack, 20, 0));

    const row = {
      id: uid('shf'), ref: docRef,
      userId: user.id, userName: user.name,
      openedAt: openedAt.toISOString(),
      closedAt: null,
      openingCash,
      countedCash: null,
      variance: null,
      note: '', closingNote: '',
      status
    };
    userSales.forEach((s) => { s.shiftId = row.id; });

    const cashSales = round(userSales
      .filter((s) => s.payment.method === 'Cash')
      .reduce((t, s) => t + (s.payment.cashReceived - s.payment.change), 0), 2);

    if (status === 'closed') {
      const expected = round(openingCash + cashSales, 2);
      // Most shifts balance; a couple have small discrepancies to highlight.
      const drift = chance(0.25) ? pick([-500, -200, 150, 300, -1000]) : 0;
      row.closedAt = daysAgo(daysBack, 20, between(0, 30)).toISOString();
      row.expectedCash = expected;
      row.cashSales = cashSales;
      row.cashRefunds = 0;
      row.grossSales = round(userSales.reduce((t, s) => t + s.total, 0), 2);
      row.transactions = userSales.length;
      row.countedCash = round(expected + drift, 2);
      row.variance = drift;
      row.closingNote = drift ? 'Recounted drawer, difference noted' : '';
      addActivity(user, 'shift.close',
        `Closed shift ${docRef}: expected ${expected}, counted ${row.countedCash}${drift ? `, variance ${drift}` : ' (balanced)'}`,
        new Date(row.closedAt), docRef);
    } else {
      addActivity(user, 'shift.open', `Opened shift with ${openingCash} opening cash`, openedAt, docRef);
    }

    shifts.push(row);
    return row;
  }

  for (let day = 7; day >= 1; day--) {
    addShift({ user: staffUsers[0], daysBack: day, openingCash: 20000, status: 'closed' });
    if (day % 2 === 0) addShift({ user: staffUsers[1], daysBack: day, openingCash: 15000, status: 'closed' });
  }
  // One shift still open today, so the cash-drawer workflow has live data.
  addShift({ user: staffUsers[0], daysBack: 0, openingCash: 20000, status: 'open' });

  shifts.sort((a, b) => new Date(b.openedAt) - new Date(a.openedAt));

  /* ------------------------------------------------------- stock counts --- */
  const countWhen = daysAgo(9, 18, 30);
  // The session that produced the "Stock count correction" adjustment above.
  const countedBatches = [...new Set([countBatch, ...batches.filter((b) => b.status === 'active')])].slice(0, 12);
  const countedCategories = [...new Set(countedBatches
    .map((b) => (medicines.find((m) => m.id === b.medicineId) || {}).category)
    .filter(Boolean))];
  const stockCounts = [{
    id: uid('cnt'),
    ref: ref('SC', 'stockCount', countWhen),
    startedAt: daysAgo(9, 17, 0).toISOString(),
    completedAt: countWhen.toISOString(),
    completedBy: admin.name,
    userId: admin.id, userName: admin.name,
    scope: 'categories',
    categories: countedCategories,
    lines: countedBatches.map((b) => {
      const med = medicines.find((m) => m.id === b.medicineId);
      // The counted batch whose physical quantity exceeded the system figure.
      const diff = b.id === countBatch.id ? 6 : 0;
      return {
        batchId: b.id, batchNo: b.batchNo,
        medicineId: b.medicineId,
        medicineName: med ? `${med.name} ${med.strength}`.trim() : '',
        expiry: b.expiry,
        system: b.qty - diff,
        physical: b.qty,
        diff,
        valueImpact: round(diff * b.costPrice, 2),
        countedAt: countWhen.toISOString()
      };
    }),
    status: 'completed',
    totalVariance: 6,
    valueImpact: round(6 * countBatch.costPrice, 2),
    adjustmentsCreated: 1,
    note: 'Quarterly count of fast-moving categories'
  }];
  addActivity(admin, 'stock.count-complete',
    `Completed stock count ${stockCounts[0].ref}: ${stockCounts[0].lines.length} batches counted, 1 adjustment(s), value impact ${stockCounts[0].valueImpact}`,
    countWhen, stockCounts[0].ref);

  /* ----------------------------------------------------------- expenses --- */
  const expenses = [];
  const EXPENSE_PLAN = [
    { category: 'Rent', amount: 250000, method: 'Bank Transfer', description: 'Shop rent', day: 1 },
    { category: 'Electricity', amount: 48500, method: 'POS/Card', description: 'PHCN prepaid units', day: 4 },
    { category: 'Salary', amount: 420000, method: 'Bank Transfer', description: 'Staff salaries', day: 28 },
    { category: 'Transport', amount: 18000, method: 'Cash', description: 'Stock pickup from Idumota', day: 11 },
    { category: 'Supplies', amount: 23500, method: 'Cash', description: 'Dispensing envelopes & receipt rolls', day: 16 },
    { category: 'Maintenance', amount: 35000, method: 'Cash', description: 'Air conditioner servicing', day: 22 }
  ];

  for (let monthBack = 2; monthBack >= 0; monthBack--) {
    EXPENSE_PLAN.forEach((plan) => {
      const d = new Date(NOW.getFullYear(), NOW.getMonth() - monthBack, plan.day);
      if (d > NOW) return;
      const when = new Date(d.getFullYear(), d.getMonth(), d.getDate(), between(9, 16), between(0, 59));
      const amount = round(plan.amount * (1 + (rnd() - 0.5) * 0.08), 2);
      const docRef = ref('EX', 'expense', when);
      expenses.push({
        id: uid('exp'), ref: docRef,
        date: isoDate(when),
        category: plan.category,
        amount,
        method: plan.method,
        description: plan.description,
        note: '',
        userId: admin.id, userName: admin.name,
        createdAt: when.toISOString()
      });
      addActivity(admin, 'expense.create', `Recorded ${plan.category} expense of ${amount}`, when, docRef);
    });
  }
  expenses.sort((a, b) => new Date(b.date) - new Date(a.date));

  /* ---------------------------------------------------- credit payments --- */
  const creditPayments = [];
  customers.filter((c) => c.balance > 6000).slice(0, 4).forEach((cust, i) => {
    const when = daysAgo(between(2, 14), between(10, 17));
    const amount = round(Math.min(cust.balance * 0.5, 25000), 2);
    if (amount <= 0) return;
    cust.balance = round(cust.balance - amount, 2);
    const docRef = ref('CP', 'creditPayment', when);
    creditPayments.push({
      id: uid('cpay'), ref: docRef, datetime: when.toISOString(),
      customerId: cust.id, customerName: cust.name,
      amount, method: i % 2 ? 'Bank Transfer' : 'Cash', note: 'Part payment',
      userId: admin.id, userName: admin.name,
      balanceAfter: cust.balance
    });
    addActivity(admin, 'customer.payment',
      `Received ${amount} credit payment from ${cust.name} (${i % 2 ? 'Bank Transfer' : 'Cash'})`, when, docRef);
  });

  /* -------------------------------------------------- supplier payments --- */
  const supplierPayments = [];
  suppliers.forEach((sup, i) => {
    if (sup.balance <= 0) return;
    const when = daysAgo(between(5, 25), between(10, 16));
    const amount = round(sup.balance * (i % 2 ? 0.4 : 0.6), 2);
    sup.balance = round(sup.balance - amount, 2);
    const docRef = ref('SP', 'supplierPayment', when);
    supplierPayments.push({
      id: uid('spay'), ref: docRef, datetime: when.toISOString(),
      supplierId: sup.id, supplierName: sup.name,
      amount, method: 'Bank Transfer',
      invoiceNo: '', note: 'Part settlement',
      userId: admin.id, userName: admin.name,
      balanceAfter: sup.balance
    });
    addActivity(admin, 'supplier.payment', `Paid ${amount} to ${sup.name} (Bank Transfer)`, when, docRef);
  });

  /* ------------------------------------------------------- login history -- */
  users.forEach((u) => {
    if (!u.lastLogin) return;
    addActivity(u, 'auth.login', `${u.name} signed in`, new Date(u.lastLogin));
  });
  addActivity(null, 'auth.failed', 'Failed sign-in attempt for unknown username "manager"', daysAgo(2, 19, 42));

  /* ------------------------------------------------ movement reconciliation */
  /**
   * Replay each batch's movements in date order so every record's before/after
   * balance is the true running stock position. The generator creates some
   * documents (returns, adjustments) after the sales loop even though they are
   * dated earlier, so the chain is normalised once at the end.
   */
  const movementsByBatch = new Map();
  movements.forEach((m) => {
    if (!movementsByBatch.has(m.batchId)) movementsByBatch.set(m.batchId, []);
    movementsByBatch.get(m.batchId).push(m);
  });
  movementsByBatch.forEach((rows) => {
    rows.sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
    let running = 0;
    rows.forEach((m) => {
      m.before = running;
      running += m.qty;
      m.after = running;
    });
  });

  // Newest first for display.
  movements.sort((a, b) => new Date(b.datetime) - new Date(a.datetime));
  activity.sort((a, b) => new Date(b.datetime) - new Date(a.datetime));

  /* ------------------------------------------------------------ assemble -- */
  return {
    meta: {
      schema: 1,
      createdAt: isoNow(),
      seeded: true,
      seedVersion: '1.0',
      note: 'Demo dataset - MediFlow Pharmacy ERP'
    },
    settings,
    counters,
    users,
    suppliers,
    medicines,
    batches,
    customers,
    sales,
    returns,
    goodsReceipts,
    adjustments,
    stockCounts,
    expenses,
    shifts,
    movements: movements.slice(0, 4000),
    activity: activity.slice(0, 600),
    creditPayments,
    supplierPayments,
    heldBills: []
  };
}

export default { buildSeed };
