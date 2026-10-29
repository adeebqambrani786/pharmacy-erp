# Oushadh ERP — Multi-Branch Pharmacy ERP (Bangladesh)

An interactive, client-ready demo of a complete pharmacy chain ERP, built as a single
self-contained HTML file. No build step, no backend.

**Live demo:** https://claude.ai/artifact/3tiywz4GazPjbzEkd27oKL

## Running it

Open `pharmacy-erp.html` in any modern browser, or serve the folder:

```bash
npx http-server . -p 8080
```

Everything loads from CDN (React 18, Recharts, lucide, Tailwind, Babel standalone,
qrcode-generator) and Google Fonts (Inter, Hind Siliguri).

## Demo logins

One click on the login screen — the password field is pre-filled and any value works.

| Role | User | Scope |
|---|---|---|
| Owner | Shafiqur Rahman | Everything, all three branches |
| Branch Manager | Mahbubur Rahman | Dhanmondi only, incl. attendance and leave approval |
| Pharmacist/Cashier | Sumaiya Khatun | POS, stock view, own attendance, payslips, leave |
| Accountant | Kamrul Ahsan | Finance, payroll payment, reports |
| HR Manager | Sadia Afrin | Employees, attendance, leave, payroll processing |

## What is in the box

- **3 branches** — Dhanmondi, Uttara (24h), Agrabad (Chattogram), each with its own
  drug licence, DGDA registration, trade licence, manager and monthly target.
- **78 medicines** from Square, Beximco, Incepta, Renata, ACI, Eskayef, Healthcare,
  Opsonin, ACME, SMC and others, with batches, expiry tiers, rack location, pack
  conversion (box → strip → piece), VAT %, prescription / controlled / cold-chain flags.
- **90 days of connected history** — ~12,000 invoices, purchases, returns, expenses,
  attendance, leave, two processed payroll months and a festival bonus run, with a
  dengue-season spike in Napa and Orsaline-N through September and October.
- **40 customers** (incl. 3 institutional), 10 doctors, 18 employees, 8 distributors.

Everything is connected: a sale reduces the batch it was picked from, updates the
dashboard, the customer's Baki and loyalty points, the cashier's commission and the
P&L. Paying payroll posts a salary expense per branch into Finance.

## Bangladesh localisation

BDT with South-Asian grouping (৳1,25,000), DD-MM-YYYY dates, 12-hour time,
+880 1XXX-XXXXXX phones, July–June fiscal year, NBR-style per-item VAT with BIN,
Bangladesh Pharmacy Council registration (Grade A/B/C) with expiry tracking,
national and religious holidays, controlled-drug register, and payment by Cash, Card,
bKash, Nagad, Rocket, Bank, Cheque, Baki or a split of any of them.
Full English / বাংলা toggle including amounts in words.

## Source layout

`pharmacy-erp.html` is organised in numbered sections:

1. Utilities & Bangla localisation (money, words, dates, storage)
2. i18n dictionary
3. Mock data and the history generator (seeded, so the dataset is identical every load)
4. State store — reducer, selectors, permissions, localStorage persistence
5. Reusable components — DataTable, Drawer, Modal, KPI, charts, toasts
6. Shell — navigation, command palette, shortcuts, guided tour, notifications
7. Screens (45)
8. Receipt / invoice (80 mm, 58 mm, A4)
9. App shell and router
10. Mount

## Notes on the demo

- Changes persist to `localStorage`, wrapped in try/catch; the app works normally when
  storage is unavailable (private window), and falls back to a slimmer payload if the
  quota is hit. **Reset Demo Data** in Settings restores the seeded state.
- The hosted artifact sandbox blocks the browser print dialog, so Print shows an
  explanatory toast. The receipts, payslips, salary sheets and reports are laid out at
  exact paper width behind a real `@media print` stylesheet for a normal deployment.
- Export, PDF and WhatsApp/SMS actions show a toast describing what they would do.
