# MediFlow Pharmacy ERP

**Smart Pharmacy Management & Inventory Control System**

A complete, single-pharmacy ERP for Nigerian community pharmacies: drug inventory with
batch-level expiry control, FEFO dispensing, QR-code goods receiving, a fast point of sale
with 80mm thermal receipts, staff accountability and full financial reporting.

Built as a zero-dependency frontend application — vanilla JavaScript ES modules, no build
step, no framework, no CDN. All data is held in the browser's LocalStorage.

---

## 1. Running the application

The app uses ES modules, so it must be served over HTTP. Opening `index.html` directly from
the filesystem (`file://`) will fail with a CORS error.

**With Laragon (this project already sits in `www`):**

```
http://localhost/pharmacy-erp/
```

**Any other static server, from the project folder:**

```bash
python -m http.server 8080      # then open http://localhost:8080
npx serve .                     # or any static file server
php -S localhost:8080           # PHP built-in server
```

Requires a current browser (Chrome, Edge, Firefox or Safari). Camera scanning additionally
requires a secure context — `localhost` counts as secure, other hosts need HTTPS.

### Demo credentials

| Role | Username | Password | Access |
|---|---|---|---|
| Pharmacy Owner (ADMIN) | `admin` | `admin123` | Everything |
| Pharmacy Staff (USER) | `staff` | `staff123` | POS, own sales, stock lookup, own shift |
| Pharmacy Staff | `ibrahim` | `staff123` | Same as staff, discounts disabled |
| Pharmacy Staff | `funke` | `staff123` | **Deactivated** — demonstrates blocked sign-in |

The login screen has one-click buttons for the first two. The demo dataset is built on first
load; **Settings → Reset demo data** rebuilds it at any time.

---

## 2. Project structure

```text
pharmacy-erp/
├── index.html                  App shell: login, session lock, layout, overlay roots
├── README.md
└── assets/
    ├── css/
    │   ├── tokens.css          Design tokens: colour, type, spacing, shadow, light/dark themes
    │   ├── base.css            Reset, typography, native form controls, utilities
    │   ├── components.css      Buttons, cards, tables, modals, drawers, toasts, charts, labels
    │   ├── layout.css          Auth screens, app shell, sidebar, topbar, POS grid, responsive
    │   └── print.css           Three print modes: 80mm receipt, A4 label sheet, A4 report
    └── js/
        ├── app.js              Boot, router, permission gate, sidebar/topbar, idle lock
        ├── store.js            Data layer and ALL business logic (single source of truth)
        ├── auth.js             Authentication, session, permission matrix
        ├── ui.js               Reusable components: icons, modals, tables, charts, receipt, scanner
        ├── utils.js            Formatting (Naira, DD-MM-YYYY), validation, CSV, DOM helpers
        ├── lib/
        │   ├── qrcode.js       QR Code encoder (ISO/IEC 18004), bundled locally
        │   ├── barcode.js      Code 128 barcode encoder, bundled locally
        │   └── password.js     PBKDF2-SHA256 hashing via Web Crypto
        ├── pages/              One module per screen (19 total)
        │   ├── dashboard.js    inventory.js   pos.js        sales.js      returns.js
        │   ├── receive.js      adjustment.js  stockcount.js expiry.js     suppliers.js
        │   ├── customers.js    expenses.js    shift.js      reports.js    activity.js
        │   └── users.js        settings.js    qr.js         labels.js
        └── data/
            └── seed.js         Realistic Nigerian demo dataset generator
```

**Architecture rules followed throughout:**

- `store.js` is the only module that mutates data. Every stock change passes through one
  internal `moveStock()` function, so no screen can bypass the business rules.
- `auth.js` is the only module that decides access. Screens call `can()` / `requirePermission()`
  and never test roles themselves.
- `utils.js` owns all formatting. Currency, dates and validation are defined once.
- Pages are presentation only: they read selectors and call store operations.

---

## 3. Completed modules

| Module | Status | Notes |
|---|---|---|
| Professional login | Done | Split-screen, show/hide password, inline validation, deactivated-account handling, failed-attempt auditing |
| Session security | Done | Persistent session, automatic lock after 30 min idle, password re-entry to unlock |
| Admin dashboard | Done | 10 KPIs, 6 charts, priority alerts, recent sales/receipts/adjustments/activity |
| Staff dashboard | Done | Own sales only, no cost or profit figures |
| Drug inventory | Done | 15 searchable fields, 5 filters, sorting, pagination, detail drawer |
| Batch management | Done | Independent batches with own expiry, cost, price, location, status, QR |
| FEFO inventory | Done | Mandatory; allocation spans batches, excludes expired and quarantined |
| Point of sale | Done | Scanner-first search, FEFO batching, pack/piece, discounts, 4 payment methods, hold/resume |
| Barcode scanning | Done | Code 128 generation + BarcodeDetector decoding + scanner-keyboard input |
| QR Code generation | Done | Locally bundled encoder, unique code per batch |
| QR Code scanning | Done | Camera, manual entry and USB/Bluetooth scanner, with a read-only test tool |
| QR goods receiving | Done | Scan → identify → batch → quantities → review → confirm |
| Stock received | Done | Multi-line receipts, bonus units, supplier invoices, printable GRN |
| Stock adjustment | Done | 7 reasons, live preview, value impact, immutable history |
| Stock count | Done | Blind counting, QR jump-to-batch, variance review, posts adjustments |
| Expiry management | Done | 5 expiry windows, automatic quarantine, bulk actions |
| Quarantine | Done | Block, release, return to supplier, write off |
| Sales history | Done | Admin sees all with void; staff see only their own |
| Sales returns | Done | Request → approve/reject, credit notes, damaged goods quarantined |
| Staff-wise sales | Done | Per-user revenue, transactions, averages, payment mix, cash variance |
| Suppliers | Done | Purchase history, payments, balances, returns, statements |
| Customers | Done | Accounts, purchase history, ledger |
| Credit management | Done | Limits enforced at POS, payments, aging report |
| Expenses | Done | 7 categories, feeds net profit |
| Cash & shifts | Done | Open/close, expected vs counted, variance, printable Z-report |
| Professional reports | Done | 5 report groups, 20+ tables, charts, CSV export, printable |
| Users & permissions | Done | Create, edit, delegate permissions, reset passwords, guard rails |
| Activity log | Done | Immutable audit trail, filterable by user, action and date |
| Settings | Done | Pharmacy profile, inventory rules, sales rules, theme |
| Backup & restore | Done | JSON export/import with validation, demo reset |
| Printable QR labels | Done | Live preview, 2-4 per row, QR / barcode / both |

---

## 4. Implemented business workflows

**Goods receiving (QR-based)** — Open Stock Received → *Scan to receive* → scan a batch QR or
pack barcode → MediFlow identifies the medicine and shows its live stock → choose an existing
batch or create one → enter quantity, bonus units, cost and selling price → add more lines →
select supplier and invoice → review the totals → **Confirm**. Only at confirmation does stock
move: a stock movement is written per line, a GRN record is created, new batches get a QR Code,
and an unpaid invoice is added to the supplier's balance.

**Dispensing (FEFO)** — Open POS → scan or search → MediFlow allocates from the earliest-expiring
eligible batch → quantity changes spill into the next batch automatically when one runs out →
optional batch override is recorded → prescription-only items demand a prescriber → payment
validated (cash change, credit limit) → **Complete sale**. Checkout deducts from the exact batches,
links the sale to the cashier's open shift, updates customer credit and prints an 80mm receipt.

**Returns** — Staff raise a request against a specific receipt with per-line quantities and reasons.
Nothing changes until the owner approves. On approval, sellable lines return to their original
batch; damaged and expired lines are quarantined instead, and a credit note is issued.

**Stock count** — Start a session (whole inventory or chosen categories) → count with the system
figure hidden (blind count) → scan a QR to jump to a batch → review the variances and their value
impact → **Confirm**, which posts one audited adjustment per difference. The system quantity is
re-read at commit time, so sales made mid-count are respected.

**Cash reconciliation** — Staff open a shift with a counted float. Every sale links to it. At close,
expected cash is recalculated from the actual transactions (opening + cash sales − cash refunds),
compared with the physical count, and the variance is recorded and surfaced to the owner.

**Expiry control** — Expired batches are quarantined automatically on load, blocked from FEFO and
refused at checkout. From Expiry & Quarantine they can be returned to the supplier (reducing the
payable) or written off (recorded as a stock loss).

---

## 5. Test results

Five automated suites were run against the real modules (Node 25 + jsdom, no mocks of the
business logic): **270 checks, all passing**, plus a static import/export validation across all
28 JavaScript modules (0 unresolved imports) and a parse check of every module.

### 5.1 QR Code generation and scanning — 13/13

A verifier independently re-implements the decode path: it recovers the format information
(BCH-checked), identifies the mask, un-masks the symbol, reads the zigzag codeword stream,
de-interleaves the Reed-Solomon blocks and decodes the byte-mode segment.

| Payload | Version | ECC | Mask | Size | Round-trip |
|---|---|---|---|---|---|
| `MEDIFLOW\|MED:med_001\|BAT:bat_001\|SKU:PCM500TAB\|BN:PCM-2411A` | 4 | M | 1 | 33×33 | exact |
| `MEDIFLOW\|MED:x\|BAT:y` | 2 | L | 3 | 25×25 | exact |
| `MF` | 1 | H | 3 | 21×21 | exact |
| 83-char batch reference | 7 | Q | 7 | 45×45 | exact |
| 300-char payload | 13 | M | 3 | 69×69 | exact |
| UTF-8 with the ₦ sign | 4 | M | 3 | 33×33 | exact |

Structural checks passed: all three finder patterns, separators, timing patterns, the mandatory
dark module, and version information for versions ≥ 7.

Scan resolution (`resolveScan`) was verified to map a batch QR back to its exact batch, resolve a
medicine from its barcode, and reject an unknown code with a clear message rather than guessing.
Every seeded batch carries a QR Code, and no code contains a price or quantity.

### 5.2 Code 128 barcodes — 19/19

Full round-trip decode including the modulo-103 checksum, across alphanumeric SKUs, 13-digit GS1
barcodes, code-set B↔C switching, and strings with punctuation. Pattern table verified
(107 entries, 11 modules per data symbol, 13 for the stop pattern). Non-encodable input falls back
to a visible placeholder instead of breaking a sheet of labels.

### 5.3 FEFO, stock integrity and business rules — 101/101

| Area | Verified |
|---|---|
| FEFO ordering | Queue sorted by earliest expiry; expired and quarantined batches excluded |
| FEFO allocation | Earliest batch consumed first; spills into the next batch; honours cart reservations, a preferred scanned batch and exclusions; reports a shortfall rather than over-allocating |
| Stock integrity | Every batch quantity equals the net of its movements; the chronological before/after chain is continuous and never negative |
| Overselling | A sale beyond batch stock is refused |
| Expired stock | A sale from an expired batch is refused |
| Cash validation | A cash sale below the total is refused; change is computed exactly |
| Credit limits | A credit sale beyond the available limit is refused |
| Void | Restores stock to the original batches, reverses customer credit, and is audited |
| Goods receiving | Creates batches, adds purchased + bonus units, values the invoice on purchased units only, generates batch QRs, and increases the supplier balance |
| Duplicate batches | Receiving an existing batch number tops up the one record instead of duplicating it |
| Adjustments | Record before/after and value impact; a decrease beyond stock is refused |
| Returns | Sellable lines restock; damaged lines are quarantined and unsellable; a credit note is issued |
| Stock count | Variance detected, correction applied, adjustment created |
| Shifts | Expected cash = opening + cash sales − refunds; variance computed on close |
| Write-off | Clears the batch, records the loss, leaves it unsellable |
| Financials | Gross profit = net revenue − COGS; net profit = gross − expenses; payment mix reconciles to revenue |
| Customer credit | Balances equal credit sales minus payments; no customer exceeds their limit |
| Passwords | All stored as PBKDF2 hashes; no plaintext field anywhere |
| Backup | Export/import round-trips; a non-MediFlow file is rejected |

### 5.4 Interface and permissions — 88/88

Every page was rendered in jsdom as admin and as staff.

- All 19 page modules import and render without errors for the owner.
- Detail drawers open on 11 list pages; 13 create/action dialogs open correctly.
- All 5 report tabs and all 5 expiry tabs render.
- Adding an item to the POS cart changes no stock until checkout.
- **Staff restrictions confirmed in logic, not just hidden in the UI:** all 19 confidential
  permissions denied, 7 admin-only pages refuse to open, cost/profit wording absent from staff
  pages, sales history scoped to the signed-in user, and no add/edit controls on inventory.
- Zero uncaught DOM errors across the whole sweep.

One real defect was found and fixed by this suite: pages attach delegated listeners to the
element they are mounted into, and the router was reusing a single `#page-root`, so handlers
accumulated on every navigation (eventually opening duplicate drawers from one click). The
router now mounts each page into a fresh wrapper element; a regression test covers it.

### 5.5 Full application boot and navigation — 49/49

`app.js` was imported exactly as the browser loads it, then driven through a complete session:

- Boots, seeds the demo database, hides the splash and shows the login screen.
- A wrong password is rejected with an inline message and written to the activity log.
- The deactivated account (`funke`) is blocked with a clear reason.
- Admin sign-in through the real form renders the shell: 6 navigation groups, all 19 routes,
  page title, breadcrumbs and 10+ dashboard KPI tiles.
- The router renders all 19 routes via `location.hash`, with exactly one page view mounted
  at any time.
- Theme toggle, notification panel (with live alerts) and the user menu all work.
- Session lock: locking shows the lock screen, a wrong password is refused, the correct
  password restores the session.
- Sign-out returns to the login screen; staff sign-in then shows only 9 navigation items with
  reports, users, settings and activity absent.
- A staff member typing `#/reports` directly is redirected away and the attempt is audited.
- Zero uncaught errors and zero console errors across the entire session.

A second gap was found and fixed here: the shell did not rebuild its navigation when a session
changed while the shell was already visible. `app.js` now re-renders on that transition.

### 5.6 Responsive design

Layout was built and reviewed mobile-first at these breakpoints:

| Width | Behaviour |
|---|---|
| ≥ 1180px (desktop) | Full 12-column dashboard, collapsible sidebar, POS split view |
| 1025–1180px (laptop) | Dashboard cards reflow to 6 columns; tables keep all columns |
| ≤ 1024px (tablet) | Sidebar becomes an overlay drawer with a scrim; POS stacks cart under search |
| ≤ 760px | Dashboard grid goes single-column; multi-column forms become one column |
| ≤ 720px | Tables switch to card rows with a label per field — **no horizontal scrolling** |
| ≤ 600px (mobile) | Compact topbar, full-width toasts and dialogs, stacked footer buttons, 2-up payment buttons, 2-up label sheet |

Both light and dark themes are defined with the same token names, so every component inherits
both. Dark mode is toggled from the topbar or Settings and remembered per browser.
Interactive elements have visible focus rings, dialogs trap Tab focus and close on Escape,
and colour choices target WCAG AA contrast.

---

## 6. Known limitations

**This is a browser-only demonstration build.** The limitations below are inherent to that, not
oversights.

1. **Browser-only storage.** All data lives in this browser's LocalStorage. Another computer,
   another browser or a cleared cache means different data. There is no synchronisation.
2. **Client-side authentication is not security.** Passwords are hashed with PBKDF2-SHA256
   (120,000 iterations) so they are not readable in storage, but anyone with access to the
   browser can read or rewrite LocalStorage directly and bypass every permission check. The
   permission model here is a faithful implementation of the business rules, not a security
   boundary.
3. **No concurrency control.** Two tills cannot safely share stock: there are no transactions
   or row locks, so simultaneous sales of the last unit are not prevented.
4. **Storage ceiling.** LocalStorage is typically 5–10 MB. The activity log is capped at 4,000
   entries and movements at 8,000 so a long-running demo cannot overflow it; a real pharmacy
   needs unbounded history.
5. **Camera decoding depends on the browser.** The `BarcodeDetector` API is used where available
   (Chrome and Edge on Android/desktop). Safari and Firefox do not expose it, so those browsers
   use manual entry or a USB/Bluetooth scanner — both fully supported everywhere.
6. **Printing depends on the browser's print dialog.** The 80mm receipt, A4 label sheet and A4
   report layouts are all CSS-driven; exact margins vary by printer driver. No direct ESC/POS
   thermal printing.
7. **Single pharmacy.** No branches, inter-branch transfers or consolidated multi-site reporting.
8. **No integrations.** No NAFDAC verification lookup, payment-terminal integration, SMS/email
   notifications, or accounting-system export beyond CSV and JSON.
9. **Deactivating a signed-in user** takes effect at their next action rather than instantly,
   because there is no server to push a session revocation.
10. **Demo seed dates are relative to today**, so reopening the app weeks later shifts which
    batches appear "expiring". Reset demo data to regenerate a fresh, coherent dataset.

### What production deployment requires

| Need | Why |
|---|---|
| Backend API + central database | One shared source of truth across devices |
| Server-side authentication, sessions and role checks | Permissions a client cannot bypass |
| Transaction-safe inventory operations (DB transactions, row locks) | Prevents double-selling the same unit |
| Centralised QR and batch registry | Batch identity consistent across every till |
| Multi-user synchronisation | Live stock as several staff sell simultaneously |
| Automated off-site backups with a tested restore | Real data-loss protection |
| Server-side append-only audit log | Tamper-evident accountability |
| HTTPS everywhere | Required for camera access and credential safety |

---

## 7. Data model

Nine transaction collections, six master collections, all in one LocalStorage key
(`mediflow.erp.v1`):

```
medicines ──┬── batches ──┬── movements        every quantity change, signed, with before/after
            │             ├── sales.items      batch, expiry, unit price and cost per line
            │             ├── adjustments      reason + responsible user, immutable
            │             ├── goodsReceipts    supplier, invoice, purchased + bonus units
            │             └── stockCounts      system vs physical per batch
            └── suppliers ─── supplierPayments

customers ──┬── sales ───── returns ─── (credit notes)
            └── creditPayments

users ──────┬── shifts ───── (Z-reports, variance)
            └── activity     immutable audit trail

expenses, settings, counters, heldBills
```

**Invariants enforced in `store.js`:**

1. Unique internal ID for every medicine and batch; unique reference for every transaction.
2. A batch's quantity only changes through `moveStock()`, which refuses to go negative.
3. Expired and quarantined batches are never sellable; FEFO skips them.
4. Every sale identifies its cashier and deducts from the exact batches it dispensed.
5. Every receipt, adjustment, count correction and return creates a stock movement.
6. Returns change nothing until approved; damaged and expired goods never re-enter sellable stock.
7. Scanning never changes inventory — only a confirmed operation does.
8. Reports and dashboards are computed from transaction records, never from stored totals.

---

## 8. Keyboard shortcuts

| Key | Action |
|---|---|
| `F2` / `F3` / `F4` | Point of Sale / Drug Inventory / Sales History |
| `/` | Focus the current page's search box |
| `Esc` | Close the top dialog, drawer or menu |
| `Shift + ?` | Show the shortcut list |
| **POS** `F9` | Complete the sale |
| **POS** `F6` / `F7` / `F8` | Hold bill / Resume bill / Clear cart |
| **POS** `↑` `↓` `Enter` | Move through results and add the highlighted medicine |

A USB or Bluetooth barcode scanner needs no setup: it types into the focused search or scan box
and submits with its trailing Enter.

---

## 9. Conventions

- **Currency** — Nigerian Naira, `₦1,250.00`, tabular figures so columns align.
- **Dates** — `DD-MM-YYYY` for display, ISO internally.
- **Time** — 12-hour with AM/PM.
- **References** — `SL-261030-0042` (type, date, sequence): `SL` sale, `GR` goods receipt,
  `ADJ` adjustment, `RT` return, `CN` credit note, `SC` stock count, `SH` shift, `EX` expense,
  `CP` customer payment, `SP` supplier payment, `WO` write-off, `SRN` supplier return.
- **QR payload** — `MEDIFLOW|MED:<id>|BAT:<id>|SKU:<sku>|BN:<batch>`. Internal identifiers only;
  price, quantity and expiry are always read live from inventory.
