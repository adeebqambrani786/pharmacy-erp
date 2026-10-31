/* ==========================================================================
   MediFlow Pharmacy ERP - Reports & Analytics (admin only)
   Every figure is calculated from the actual transaction records - sales,
   movements, adjustments, expenses and payments - never from stored totals
   (section 22, rule 22).
   ========================================================================== */

import {
  db, medicines, medicine, stockSummary, inventoryValue, financials, approvedReturns,
  medicineSalesStats, staffPerformance, creditAging, expiryBuckets, movementsFor, suppliers,
  supplier, customers, users, settings, batchState, isWrittenOff, shifts, STATUS_LABELS,
  supplierHistory
} from '../store.js';
import { can, requirePermission, roleLabel } from '../auth.js';
import {
  pageHead, card, kpi, icon, badge, statusBadge, renderTable, cellStack, emptyState,
  notifySuccess, notifyDenied, escapeHtml, options, searchBox, lineChart, barChart, donutChart,
  rankChart, printNode, printHeader, printFooter
} from '../ui.js';
import {
  money, int, num, round, percent, divide, fmtDate, fmtDateTime, fmtTime, isoDate, startOfDay,
  endOfDay, startOfMonth, addDays, lastNMonths, sortBy, groupBy, sum, unique, qs, qsa, on,
  debounce, downloadCsv, exportName, daysUntil, PAYMENT_METHODS, EXPENSE_CATEGORIES
} from '../utils.js';

/* ============================== STATE ============================== */

const TABS = [
  { key: 'sales', label: 'Sales', icon: 'pos' },
  { key: 'financial', label: 'Financial', icon: 'wallet' },
  { key: 'inventory', label: 'Inventory', icon: 'box' },
  { key: 'staff', label: 'Staff performance', icon: 'users' },
  { key: 'other', label: 'Credit, suppliers & more', icon: 'layers' }
];

const PRESETS = [
  { key: 'today', label: 'Today' },
  { key: '7', label: 'Last 7 days' },
  { key: '30', label: 'Last 30 days' },
  { key: 'month', label: 'This month' },
  { key: 'lastmonth', label: 'Last month' },
  { key: 'all', label: 'All time' },
  { key: 'custom', label: 'Custom range' }
];

const state = {
  tab: 'sales',
  preset: '30',
  from: '',
  to: '',
  userId: '',
  category: '',
  grain: 'day'    // day | week | month for the sales trend
};

let ctxRef = null;

/* ============================== RANGE ============================== */

/** Resolve the active preset into concrete from/to bounds. */
function range() {
  const today = new Date();
  switch (state.preset) {
    case 'today':
      return { from: startOfDay(today), to: endOfDay(today), label: `Today, ${fmtDate(today)}` };
    case '7':
      return { from: startOfDay(addDays(today, -6)), to: endOfDay(today), label: 'Last 7 days' };
    case '30':
      return { from: startOfDay(addDays(today, -29)), to: endOfDay(today), label: 'Last 30 days' };
    case 'month':
      return { from: startOfMonth(today), to: endOfDay(today), label: today.toLocaleDateString('en-NG', { month: 'long', year: 'numeric' }) };
    case 'lastmonth': {
      const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const end = new Date(today.getFullYear(), today.getMonth(), 0, 23, 59, 59, 999);
      return { from: start, to: end, label: start.toLocaleDateString('en-NG', { month: 'long', year: 'numeric' }) };
    }
    case 'custom':
      return {
        from: state.from ? startOfDay(state.from) : null,
        to: state.to ? endOfDay(state.to) : null,
        label: `${state.from ? fmtDate(state.from) : 'Start'} to ${state.to ? fmtDate(state.to) : 'today'}`
      };
    default:
      return { from: null, to: null, label: 'All time' };
  }
}

/** Bucket completed sales into the selected granularity. */
function trendSeries(rows, bounds) {
  if (state.grain === 'month') {
    return lastNMonths(12).map((m) => {
      const list = rows.filter((s) => {
        const d = new Date(s.datetime);
        return d >= m.start && d <= m.end;
      });
      const revenue = round(sum(list, (s) => s.total), 2);
      return {
        label: m.label,
        value: revenue,
        value2: round(sum(list, (s) => s.profit), 2),
        tip: `${m.label}: ${money(revenue)} from ${list.length} sale(s)`
      };
    });
  }

  if (state.grain === 'week') {
    const weeks = new Map();
    rows.forEach((s) => {
      const d = new Date(s.datetime);
      const monday = new Date(d);
      monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      const key = isoDate(monday);
      if (!weeks.has(key)) weeks.set(key, { date: monday, rows: [] });
      weeks.get(key).rows.push(s);
    });
    return sortBy([...weeks.entries()], ([key]) => key, 'asc').map(([key, entry]) => {
      const revenue = round(sum(entry.rows, (s) => s.total), 2);
      return {
        label: `w/c ${fmtDate(entry.date).slice(0, 5)}`,
        value: revenue,
        value2: round(sum(entry.rows, (s) => s.profit), 2),
        tip: `Week commencing ${fmtDate(entry.date)}: ${money(revenue)}`
      };
    });
  }

  // Daily, bounded by the selected range (max 60 points so the axis stays readable)
  const start = bounds.from || (rows.length ? new Date(sortBy(rows, (s) => s.datetime, 'asc')[0].datetime) : new Date());
  const end = bounds.to || new Date();
  const days = Math.min(60, Math.max(1, Math.round((endOfDay(end) - startOfDay(start)) / 86400000) + 1));
  const byDay = groupBy(rows, (s) => isoDate(s.datetime));

  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = addDays(end, -i);
    const key = isoDate(d);
    const list = byDay.get(key) || [];
    const revenue = round(sum(list, (s) => s.total), 2);
    out.push({
      label: d.toLocaleDateString('en-NG', { day: '2-digit', month: 'short' }),
      value: revenue,
      value2: round(sum(list, (s) => s.profit), 2),
      tip: `${fmtDate(d)}: ${money(revenue)} from ${list.length} sale(s)`
    });
  }
  return out;
}

/* ============================== SALES TAB ============================== */

function salesTab(bounds) {
  const fin = financials({ from: bounds.from, to: bounds.to, userId: state.userId || undefined });
  let rows = fin.saleRows;
  if (state.category) {
    rows = rows.filter((s) => s.items.some((line) => {
      const med = medicine(line.medicineId);
      return med && med.category === state.category;
    }));
  }

  const trend = trendSeries(rows, bounds);
  const byMethod = PAYMENT_METHODS.map((method) => ({
    label: method,
    value: round(sum(rows.filter((s) => s.payment.method === method), (s) => s.total), 2)
  })).filter((r) => r.value > 0);

  const stats = medicineSalesStats({ from: bounds.from, to: bounds.to });
  const topMedicines = sortBy(stats, (r) => r.revenue, 'desc').slice(0, 10);

  const byCategory = [...groupBy(
    rows.flatMap((s) => s.items.map((line) => ({ line, med: medicine(line.medicineId) }))).filter((x) => x.med),
    (x) => x.med.category
  ).entries()].map(([category, list]) => ({
    label: category,
    value: round(sum(list, (x) => x.line.total), 2),
    units: sum(list, (x) => x.line.qty)
  }));

  const byStaff = sortBy(
    staffPerformance({ from: bounds.from, to: bounds.to }).filter((p) => p.transactions > 0),
    (p) => p.revenue, 'desc'
  );

  const hourly = Array.from({ length: 14 }, (_, i) => {
    const hour = i + 7; // 07:00 - 20:00 trading window
    const list = rows.filter((s) => new Date(s.datetime).getHours() === hour);
    return {
      label: `${String(hour).padStart(2, '0')}h`,
      value: round(sum(list, (s) => s.total), 2),
      tip: `${String(hour).padStart(2, '0')}:00 - ${money(round(sum(list, (s) => s.total), 2))} from ${list.length} sale(s)`
    };
  });

  return `
    <div class="kpi-grid">
      ${kpi({ label: 'Revenue', value: money(fin.revenue), iconName: 'wallet', tone: 'success', foot: `<span>${int(fin.transactions)} transactions</span>` })}
      ${kpi({ label: 'Units dispensed', value: int(fin.units), iconName: 'pill', tone: 'info', foot: `<span>${int(unique(rows.flatMap((s) => s.items.map((l) => l.medicineId))).length)} different medicines</span>` })}
      ${kpi({ label: 'Average sale', value: money(divide(fin.revenue, fin.transactions)), iconName: 'chart', foot: `<span>${money(fin.discount)} total discount</span>` })}
      ${kpi({ label: 'Gross profit', value: money(fin.grossProfit), iconName: 'trending', tone: 'success', foot: `<span>${percent(fin.margin)} margin</span>` })}
    </div>

    <div class="grid-dash">
      <div class="span-8">
        ${card({
          title: 'Sales trend',
          sub: `Revenue and gross profit, by ${state.grain}`,
          actions: `<div class="segmented">
            ${['day', 'week', 'month'].map((g) => `<button type="button" data-grain="${g}" class="${state.grain === g ? 'is-active' : ''}">${g}</button>`).join('')}
          </div>`,
          body: lineChart(trend, { series2Label: 'Gross profit' })
            + `<div class="chart-legend">
                 <span><i style="background:var(--chart-1)"></i>Revenue</span>
                 <span><i style="background:var(--chart-2)"></i>Gross profit</span>
               </div>`
        })}
      </div>
      <div class="span-4">
        ${card({ title: 'Sales by payment method', body: donutChart(byMethod, { centreLabel: 'Revenue' }) })}
      </div>

      <div class="span-6">
        ${card({
          title: 'Sales by staff',
          sub: 'Individual accountability for the period',
          body: byStaff.length
            ? rankChart(byStaff.map((p) => ({
                label: `${p.user.name} (${roleLabel(p.user.role)})`,
                value: p.revenue,
                sub: `${int(p.transactions)} sales - average ${money(p.average)} - ${int(p.units)} units`,
                color: p.user.role === 'admin' ? 'var(--chart-1)' : 'var(--chart-2)'
              })))
            : emptyState({ iconName: 'users', title: 'No staff sales in this period' })
        })}
      </div>
      <div class="span-6">
        ${card({
          title: 'Sales by category',
          body: byCategory.length
            ? rankChart(sortBy(byCategory, (r) => r.value, 'desc').slice(0, 8).map((r) => ({
                label: r.label, value: r.value, sub: `${int(r.units)} units`, color: 'var(--chart-4)'
              })))
            : emptyState({ iconName: 'layers', title: 'No category sales in this period' })
        })}
      </div>

      <div class="span-12">
        ${card({
          title: 'Sales by hour of day',
          sub: 'Use this to plan staffing',
          body: barChart(hourly, { color: 'var(--chart-6)' })
        })}
      </div>

      <div class="span-12">
        ${card({
          title: 'Sales by medicine',
          sub: `Top ${topMedicines.length} by revenue`,
          actions: can('export.data')
            ? `<button class="btn btn-secondary btn-sm" type="button" data-export="medicines">${icon('download', 14)} CSV</button>`
            : '',
          flush: true,
          body: renderTable({
            columns: [
              { key: 'name', label: 'Medicine', cell: (r) => escapeHtml(r.name) },
              { key: 'units', label: 'Units', className: 'num', cell: (r) => int(r.units) },
              { key: 'transactions', label: 'Lines sold', className: 'num', cell: (r) => int(r.transactions) },
              { key: 'revenue', label: 'Revenue', className: 'num', cell: (r) => `<strong>${money(r.revenue)}</strong>` },
              { key: 'profit', label: 'Gross profit', className: 'num', cell: (r) => `<span class="c-success">${money(r.profit)}</span>` },
              {
                key: 'margin', label: 'Margin', className: 'num',
                cell: (r) => percent(divide(r.profit, r.revenue) * 100)
              },
              {
                key: 'share', label: 'Share of revenue', className: 'num',
                cell: (r) => percent(divide(r.revenue, fin.revenue) * 100)
              }
            ],
            rows: topMedicines,
            footer: `<tr>
              <td>Total for the period</td>
              <td class="num">${int(sum(stats, (r) => r.units))}</td>
              <td class="num">${int(sum(stats, (r) => r.transactions))}</td>
              <td class="num">${money(sum(stats, (r) => r.revenue))}</td>
              <td class="num">${money(sum(stats, (r) => r.profit))}</td>
              <td colspan="2"></td>
            </tr>`,
            empty: emptyState({ iconName: 'chart', title: 'No sales in this period' })
          })
        })}
      </div>
    </div>`;
}

/* ============================== FINANCIAL TAB ============================== */

function financialTab(bounds) {
  const fin = financials({ from: bounds.from, to: bounds.to });
  const expensesByCategory = EXPENSE_CATEGORIES.map((category) => ({
    label: category,
    value: round(sum(fin.expenseRows.filter((e) => e.category === category), (e) => e.amount), 2)
  })).filter((r) => r.value > 0);

  const months = lastNMonths(6).map((m) => {
    const f = financials({ from: m.start, to: m.end });
    return {
      label: m.label,
      value: f.netRevenue,
      value2: f.netProfit,
      tip: `${m.label}: revenue ${money(f.netRevenue)}, net profit ${money(f.netProfit)}`
    };
  });

  const creditCollected = round(sum(
    db.creditPayments.filter((p) => {
      if (bounds.from && new Date(p.datetime) < bounds.from) return false;
      if (bounds.to && new Date(p.datetime) > bounds.to) return false;
      return true;
    }), (p) => p.amount
  ), 2);

  const outstanding = round(sum(customers(), (c) => Math.max(0, num(c.balance))), 2);
  const payables = round(sum(suppliers(), (s) => Math.max(0, num(s.balance))), 2);

  const pl = [
    { label: 'Gross revenue', value: fin.revenue, tone: '' },
    { label: 'Less: approved refunds', value: -fin.refunds, tone: 'c-danger' },
    { label: 'Net revenue', value: fin.netRevenue, strong: true },
    { label: 'Less: cost of goods sold', value: -fin.cogs, tone: 'c-danger' },
    { label: 'Gross profit', value: fin.grossProfit, strong: true, tone: 'c-success' },
    { label: 'Less: operating expenses', value: -fin.expenses, tone: 'c-danger' },
    { label: 'Net profit', value: fin.netProfit, strong: true, tone: fin.netProfit >= 0 ? 'c-success' : 'c-danger' }
  ];

  return `
    <div class="kpi-grid">
      ${kpi({ label: 'Net revenue', value: money(fin.netRevenue), iconName: 'wallet', tone: 'success', foot: `<span>${money(fin.refunds)} refunded</span>` })}
      ${kpi({ label: 'Cost of goods sold', value: money(fin.cogs), iconName: 'box', tone: 'info', foot: `<span>${percent(divide(fin.cogs, fin.netRevenue) * 100)} of revenue</span>` })}
      ${kpi({ label: 'Gross profit', value: money(fin.grossProfit), iconName: 'trending', tone: 'success', foot: `<span>${percent(fin.margin)} margin</span>` })}
      ${kpi({ label: 'Net profit', value: money(fin.netProfit), iconName: 'percent', tone: fin.netProfit >= 0 ? 'success' : 'danger', foot: `<span>After ${money(fin.expenses)} expenses</span>` })}
    </div>

    <div class="grid-dash">
      <div class="span-5">
        ${card({
          title: 'Profit & loss',
          sub: bounds.label,
          body: `<div class="stack-sm" style="gap:2px">
            ${pl.map((line) => `
              <div class="stat-line${line.strong ? ' is-total' : ''}">
                <span class="sl-label">${escapeHtml(line.label)}</span>
                <span class="sl-value ${line.tone || ''}">${money(line.value)}</span>
              </div>`).join('')}
          </div>`
        })}
      </div>

      <div class="span-7">
        ${card({
          title: 'Revenue and net profit by month',
          sub: 'Last 6 months',
          body: lineChart(months, { series2Label: 'Net profit' })
            + `<div class="chart-legend">
                 <span><i style="background:var(--chart-1)"></i>Net revenue</span>
                 <span><i style="background:var(--chart-2)"></i>Net profit</span>
               </div>`
        })}
      </div>

      <div class="span-4">
        ${card({
          title: 'Cash collection',
          sub: bounds.label,
          body: `<div class="stack-sm" style="gap:2px">
            <div class="stat-line"><span class="sl-label">Cash sales</span><span class="sl-value">${money(fin.cash)}</span></div>
            <div class="stat-line"><span class="sl-label">POS / card</span><span class="sl-value">${money(fin.card)}</span></div>
            <div class="stat-line"><span class="sl-label">Bank transfer</span><span class="sl-value">${money(fin.transfer)}</span></div>
            <div class="stat-line"><span class="sl-label">Credit extended</span><span class="sl-value c-warning">${money(fin.credit)}</span></div>
            <div class="stat-line"><span class="sl-label">Credit payments received</span><span class="sl-value c-success">${money(creditCollected)}</span></div>
            <div class="stat-line is-total"><span class="sl-label">Collected in the period</span>
              <span class="sl-value">${money(round(fin.cash + fin.card + fin.transfer + creditCollected, 2))}</span></div>
          </div>`
        })}
      </div>

      <div class="span-4">
        ${card({
          title: 'Expenses by category',
          sub: bounds.label,
          body: expensesByCategory.length
            ? donutChart(expensesByCategory, { centreLabel: 'Expenses' })
            : emptyState({ iconName: 'wallet', title: 'No expenses in this period' })
        })}
      </div>

      <div class="span-4">
        ${card({
          title: 'Balance sheet snapshot',
          sub: 'Position today, not period-bound',
          body: `<div class="stack-sm" style="gap:2px">
            <div class="stat-line"><span class="sl-label">Stock at cost</span><span class="sl-value">${money(inventoryValue().cost)}</span></div>
            <div class="stat-line"><span class="sl-label">Stock at retail</span><span class="sl-value">${money(inventoryValue().retail)}</span></div>
            <div class="stat-line"><span class="sl-label">Customer receivables</span><span class="sl-value c-warning">${money(outstanding)}</span></div>
            <div class="stat-line"><span class="sl-label">Supplier payables</span><span class="sl-value c-danger">${money(payables)}</span></div>
            <div class="stat-line is-total"><span class="sl-label">Working position</span>
              <span class="sl-value">${money(round(inventoryValue().cost + outstanding - payables, 2))}</span></div>
          </div>`
        })}
      </div>

      <div class="span-12">
        ${card({
          title: 'Daily revenue breakdown',
          sub: bounds.label,
          actions: can('export.data')
            ? `<button class="btn btn-secondary btn-sm" type="button" data-export="daily">${icon('download', 14)} CSV</button>`
            : '',
          flush: true,
          body: renderTable({
            compact: true,
            columns: [
              { key: 'date', label: 'Date', cell: (r) => fmtDate(r.date) },
              { key: 'transactions', label: 'Sales', className: 'num', cell: (r) => int(r.transactions) },
              { key: 'revenue', label: 'Revenue', className: 'num', cell: (r) => money(r.revenue) },
              { key: 'cogs', label: 'Cost of goods', className: 'num', cell: (r) => money(r.cogs) },
              { key: 'gross', label: 'Gross profit', className: 'num', cell: (r) => `<span class="c-success">${money(r.gross)}</span>` },
              { key: 'expenses', label: 'Expenses', className: 'num', cell: (r) => money(r.expenses) },
              {
                key: 'net', label: 'Net profit', className: 'num',
                cell: (r) => `<strong class="${r.net >= 0 ? 'c-success' : 'c-danger'}">${money(r.net)}</strong>`
              }
            ],
            rows: dailyBreakdown(bounds),
            empty: emptyState({ iconName: 'chart', title: 'No activity in this period' })
          })
        })}
      </div>
    </div>`;
}

/** Day-by-day financial table for the selected range (newest first). */
function dailyBreakdown(bounds) {
  const end = bounds.to || new Date();
  const start = bounds.from || addDays(end, -29);
  const days = Math.min(62, Math.max(1, Math.round((endOfDay(end) - startOfDay(start)) / 86400000) + 1));

  const out = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(end, -i);
    const f = financials({ from: startOfDay(d), to: endOfDay(d) });
    if (!f.transactions && !f.expenses) continue;
    out.push({
      date: d,
      transactions: f.transactions,
      revenue: f.revenue,
      cogs: f.cogs,
      gross: f.grossProfit,
      expenses: f.expenses,
      net: f.netProfit
    });
  }
  return out;
}

/* ============================== INVENTORY TAB ============================== */

function inventoryTab(bounds) {
  const value = inventoryValue();
  const buckets = expiryBuckets();

  const rows = medicines().map((med) => {
    const summary = stockSummary(med.id);
    const stats = medicineSalesStats({ from: bounds.from, to: bounds.to }).find((s) => s.medicineId === med.id);
    return { med, summary, sold: stats ? stats.units : 0, revenue: stats ? stats.revenue : 0 };
  });

  const lowStock = rows.filter((r) => r.summary.status === 'low' || r.summary.status === 'out');
  const deadStock = rows.filter((r) => r.sold === 0 && r.summary.available > 0);
  const slowMoving = sortBy(rows.filter((r) => r.sold > 0 && r.summary.available > 0), (r) => r.sold, 'asc').slice(0, 10);

  const byCategoryValue = [...groupBy(rows, (r) => r.med.category).entries()]
    .map(([category, list]) => ({
      label: category,
      value: round(sum(list, (r) => r.summary.stockValueCost), 2)
    }))
    .filter((r) => r.value > 0);

  const receipts = db.goodsReceipts.filter((r) => {
    if (bounds.from && new Date(r.datetime) < bounds.from) return false;
    if (bounds.to && new Date(r.datetime) > bounds.to) return false;
    return true;
  });

  const adjustments = db.adjustments.filter((a) => {
    if (bounds.from && new Date(a.datetime) < bounds.from) return false;
    if (bounds.to && new Date(a.datetime) > bounds.to) return false;
    return true;
  });

  const batchRows = sortBy(
    db.batches.filter((b) => !isWrittenOff(b) && num(b.qty) > 0),
    (b) => b.expiry, 'asc'
  );

  return `
    <div class="kpi-grid">
      ${kpi({ label: 'Stock value at cost', value: money(value.cost), iconName: 'wallet', tone: 'success', foot: `<span>Retail ${money(value.retail)}</span>` })}
      ${kpi({ label: 'Units on hand', value: int(value.units), iconName: 'box', tone: 'info', foot: `<span>${int(value.batches)} batches</span>` })}
      ${kpi({ label: 'Potential margin', value: money(round(value.retail - value.cost, 2)), iconName: 'trending', foot: `<span>${percent(divide(value.retail - value.cost, value.retail) * 100)} of retail</span>` })}
      ${kpi({ label: 'Blocked stock value', value: money(value.quarantinedCost), iconName: 'alert', tone: value.quarantinedCost ? 'danger' : '', foot: '<span>Expired or quarantined</span>' })}
    </div>

    <div class="grid-dash">
      <div class="span-5">
        ${card({ title: 'Stock value by category', sub: 'At cost', body: byCategoryValue.length ? donutChart(byCategoryValue, { centreLabel: 'At cost' }) : emptyState({ title: 'No stock on hand' }) })}
      </div>
      <div class="span-7">
        ${card({
          title: 'Expiry exposure',
          sub: 'Value of stock by expiry window, at cost',
          body: barChart([
            { label: 'Expired', value: round(sum(buckets.expired, (b) => num(b.qty) * num(b.costPrice)), 2), color: 'var(--chart-5)' },
            { label: '0-30 days', value: round(sum(buckets.d30, (b) => num(b.qty) * num(b.costPrice)), 2), color: 'var(--chart-3)' },
            { label: '31-60 days', value: round(sum(buckets.d60, (b) => num(b.qty) * num(b.costPrice)), 2), color: 'var(--chart-2)' },
            { label: '61-90 days', value: round(sum(buckets.d90, (b) => num(b.qty) * num(b.costPrice)), 2), color: 'var(--chart-1)' },
            { label: 'Quarantined', value: round(sum(buckets.quarantined, (b) => num(b.qty) * num(b.costPrice)), 2), color: 'var(--chart-4)' }
          ])
        })}
      </div>

      <div class="span-12">
        ${card({
          title: 'Current stock position',
          sub: `${rows.length} medicines`,
          actions: can('export.data')
            ? `<button class="btn btn-secondary btn-sm" type="button" data-export="stock">${icon('download', 14)} CSV</button>`
            : '',
          flush: true,
          body: renderTable({
            compact: true,
            columns: [
              { key: 'name', label: 'Medicine', cell: (r) => cellStack(`${r.med.name} ${r.med.strength}`.trim(), `${r.med.sku} - ${r.med.category}`) },
              { key: 'available', label: 'Available', className: 'num', cell: (r) => int(r.summary.available) },
              { key: 'batches', label: 'Batches', className: 'num', cell: (r) => int(r.summary.sellableBatches) },
              { key: 'cost', label: 'Avg cost', className: 'num', cell: (r) => money(r.summary.cost) },
              { key: 'price', label: 'Price', className: 'num', cell: (r) => money(r.summary.price) },
              { key: 'value', label: 'Value at cost', className: 'num', cell: (r) => `<strong>${money(r.summary.stockValueCost)}</strong>` },
              { key: 'sold', label: 'Sold in period', className: 'num', cell: (r) => int(r.sold) },
              { key: 'status', label: 'Status', cell: (r) => statusBadge(STATUS_LABELS[r.summary.status]) }
            ],
            rows: sortBy(rows, (r) => r.summary.stockValueCost, 'desc'),
            footer: `<tr>
              <td>Total</td>
              <td class="num">${int(sum(rows, (r) => r.summary.available))}</td>
              <td class="num">${int(sum(rows, (r) => r.summary.sellableBatches))}</td>
              <td colspan="2"></td>
              <td class="num">${money(sum(rows, (r) => r.summary.stockValueCost))}</td>
              <td class="num">${int(sum(rows, (r) => r.sold))}</td>
              <td></td>
            </tr>`
          })
        })}
      </div>

      <div class="span-6">
        ${card({
          title: 'Low stock & stock-outs',
          sub: `${lowStock.length} medicine(s) need reordering`,
          flush: true,
          body: renderTable({
            compact: true,
            columns: [
              { key: 'name', label: 'Medicine', cell: (r) => cellStack(`${r.med.name} ${r.med.strength}`.trim(), r.med.sku) },
              { key: 'available', label: 'Available', className: 'num', cell: (r) => int(r.summary.available) },
              { key: 'reorder', label: 'Reorder at', className: 'num', cell: (r) => int(r.summary.reorderLevel) },
              { key: 'sold', label: 'Sold in period', className: 'num', cell: (r) => int(r.sold) },
              { key: 'status', label: '', cell: (r) => statusBadge(STATUS_LABELS[r.summary.status]) }
            ],
            rows: sortBy(lowStock, (r) => r.summary.available, 'asc'),
            empty: emptyState({ iconName: 'checkCircle', title: 'Every medicine is above its reorder level' })
          })
        })}
      </div>

      <div class="span-6">
        ${card({
          title: 'Dead & slow-moving stock',
          sub: 'Capital tied up in stock that is not selling',
          flush: true,
          body: renderTable({
            compact: true,
            columns: [
              { key: 'name', label: 'Medicine', cell: (r) => cellStack(`${r.med.name} ${r.med.strength}`.trim(), r.med.sku) },
              { key: 'available', label: 'On hand', className: 'num', cell: (r) => int(r.summary.available) },
              { key: 'sold', label: 'Sold', className: 'num', cell: (r) => int(r.sold) },
              { key: 'value', label: 'Tied-up value', className: 'num', cell: (r) => money(r.summary.stockValueCost) },
              {
                key: 'flag', label: '',
                cell: (r) => (r.sold === 0 ? badge('Dead stock', 'danger') : badge('Slow', 'warning'))
              }
            ],
            rows: sortBy([...deadStock, ...slowMoving.filter((s) => !deadStock.includes(s))], (r) => r.summary.stockValueCost, 'desc').slice(0, 12),
            empty: emptyState({ iconName: 'checkCircle', title: 'Everything in stock is selling' })
          })
        })}
      </div>

      <div class="span-6">
        ${card({
          title: 'Stock receiving history',
          sub: `${receipts.length} receipt(s) in this period`,
          flush: true,
          body: renderTable({
            compact: true,
            columns: [
              { key: 'ref', label: 'Reference', cell: (r) => cellStack(r.ref, fmtDate(r.datetime)) },
              { key: 'supplier', label: 'Supplier', cell: (r) => { const s = supplier(r.supplierId); return escapeHtml(s ? s.name : '-'); } },
              { key: 'units', label: 'Units', className: 'num', cell: (r) => int(r.units) },
              { key: 'total', label: 'Value', className: 'num', cell: (r) => money(r.total) }
            ],
            rows: receipts.slice(0, 12),
            footer: `<tr><td colspan="2">Total purchased</td>
              <td class="num">${int(sum(receipts, (r) => r.units))}</td>
              <td class="num">${money(sum(receipts, (r) => r.total))}</td></tr>`,
            empty: emptyState({ iconName: 'truck', title: 'No goods received in this period' })
          })
        })}
      </div>

      <div class="span-6">
        ${card({
          title: 'Stock adjustment history',
          sub: `${adjustments.length} adjustment(s) in this period`,
          flush: true,
          body: renderTable({
            compact: true,
            columns: [
              { key: 'ref', label: 'Reference', cell: (a) => cellStack(a.ref, fmtDate(a.datetime)) },
              { key: 'medicineName', label: 'Medicine', cell: (a) => cellStack(a.medicineName, `Batch ${a.batchNo}`) },
              { key: 'qty', label: 'Change', className: 'num', cell: (a) => `<span class="${a.type === 'increase' ? 'c-success' : 'c-danger'}">${a.type === 'increase' ? '+' : '-'}${int(a.qty)}</span>` },
              { key: 'reason', label: 'Reason', cell: (a) => escapeHtml(a.reason) },
              { key: 'valueImpact', label: 'Value', className: 'num', cell: (a) => money(a.valueImpact) }
            ],
            rows: adjustments.slice(0, 12),
            footer: `<tr><td colspan="4">Net value impact</td>
              <td class="num">${money(sum(adjustments, (a) => a.valueImpact))}</td></tr>`,
            empty: emptyState({ iconName: 'adjust', title: 'No adjustments in this period' })
          })
        })}
      </div>

      <div class="span-12">
        ${card({
          title: 'Batch-wise stock',
          sub: 'Earliest expiry first - this is the FEFO dispensing order',
          actions: can('export.data')
            ? `<button class="btn btn-secondary btn-sm" type="button" data-export="batches">${icon('download', 14)} CSV</button>`
            : '',
          flush: true,
          body: renderTable({
            compact: true,
            columns: [
              {
                key: 'medicine', label: 'Medicine',
                cell: (b) => { const med = medicine(b.medicineId); return cellStack(med ? `${med.name} ${med.strength}`.trim() : '-', `Batch ${b.batchNo}`); }
              },
              { key: 'expiry', label: 'Expiry', cell: (b) => cellStack(fmtDate(b.expiry), `${daysUntil(b.expiry)} days`) },
              { key: 'qty', label: 'Units', className: 'num', cell: (b) => int(b.qty) },
              { key: 'costPrice', label: 'Unit cost', className: 'num', cell: (b) => money(b.costPrice) },
              { key: 'value', label: 'Value', className: 'num', cell: (b) => money(round(num(b.qty) * num(b.costPrice), 2)) },
              { key: 'location', label: 'Location', cell: (b) => escapeHtml(b.location || '-') },
              { key: 'state', label: 'Status', cell: (b) => statusBadge(batchState(b)) }
            ],
            rows: batchRows.slice(0, 40),
            footer: `<tr><td colspan="2">Total (${batchRows.length} batches)</td>
              <td class="num">${int(sum(batchRows, (b) => b.qty))}</td><td></td>
              <td class="num">${money(sum(batchRows, (b) => num(b.qty) * num(b.costPrice)))}</td>
              <td colspan="2"></td></tr>`
          })
        })}
      </div>
    </div>`;
}

/* ============================== STAFF TAB ============================== */

function staffTab(bounds) {
  const perf = sortBy(staffPerformance({ from: bounds.from, to: bounds.to }), (p) => p.revenue, 'desc');
  const active = perf.filter((p) => p.transactions > 0);
  const totalRevenue = sum(perf, (p) => p.revenue);

  const closedShifts = shifts().filter((s) => {
    if (s.status !== 'closed') return false;
    if (bounds.from && new Date(s.closedAt) < bounds.from) return false;
    if (bounds.to && new Date(s.closedAt) > bounds.to) return false;
    return true;
  });

  return `
    <div class="kpi-grid">
      ${kpi({ label: 'Staff who sold', value: int(active.length), iconName: 'users', foot: `<span>of ${perf.length} account(s)</span>` })}
      ${kpi({ label: 'Revenue recorded', value: money(totalRevenue), iconName: 'wallet', tone: 'success' })}
      ${kpi({ label: 'Transactions', value: int(sum(perf, (p) => p.transactions)), iconName: 'receipt', tone: 'info' })}
      ${kpi({
        label: 'Net cash variance',
        value: money(sum(closedShifts, (s) => num(s.variance))),
        iconName: 'alert',
        tone: sum(closedShifts, (s) => num(s.variance)) === 0 ? 'success' : 'danger',
        foot: `<span>${closedShifts.filter((s) => num(s.variance) !== 0).length} of ${closedShifts.length} shifts off</span>`
      })}
    </div>

    <div class="grid-dash">
      <div class="span-7">
        ${card({
          title: 'Revenue by staff member',
          body: active.length
            ? rankChart(active.map((p) => ({
                label: p.user.name,
                value: p.revenue,
                sub: `${percent(divide(p.revenue, totalRevenue) * 100)} of revenue - ${int(p.transactions)} sales`,
                color: p.user.role === 'admin' ? 'var(--chart-1)' : 'var(--chart-2)'
              })))
            : emptyState({ iconName: 'users', title: 'No sales in this period' })
        })}
      </div>
      <div class="span-5">
        ${card({
          title: 'Average transaction value',
          body: active.length
            ? barChart(active.map((p) => ({
                label: p.user.name.split(' ')[0],
                value: p.average,
                tip: `${p.user.name}: ${money(p.average)} average across ${int(p.transactions)} sales`
              })), { color: 'var(--chart-4)' })
            : emptyState({ iconName: 'chart', title: 'No data' })
        })}
      </div>

      <div class="span-12">
        ${card({
          title: 'Staff performance detail',
          sub: bounds.label,
          actions: can('export.data')
            ? `<button class="btn btn-secondary btn-sm" type="button" data-export="staff">${icon('download', 14)} CSV</button>`
            : '',
          flush: true,
          body: renderTable({
            columns: [
              { key: 'name', label: 'Staff member', cell: (p) => cellStack(p.user.name, `${roleLabel(p.user.role)} - ${p.user.username}`) },
              { key: 'transactions', label: 'Sales', className: 'num', cell: (p) => int(p.transactions) },
              { key: 'units', label: 'Units', className: 'num', cell: (p) => int(p.units) },
              { key: 'revenue', label: 'Revenue', className: 'num', cell: (p) => `<strong>${money(p.revenue)}</strong>` },
              { key: 'average', label: 'Average sale', className: 'num', cell: (p) => money(p.average) },
              { key: 'cash', label: 'Cash', className: 'num', cell: (p) => money(p.cash) },
              { key: 'card', label: 'Card', className: 'num', cell: (p) => money(p.card) },
              { key: 'transfer', label: 'Transfer', className: 'num', cell: (p) => money(p.transfer) },
              { key: 'credit', label: 'Credit', className: 'num', cell: (p) => money(p.credit) },
              { key: 'returns', label: 'Returns', className: 'num', cell: (p) => int(p.returns) },
              { key: 'shifts', label: 'Shifts', className: 'num', cell: (p) => int(p.shifts) },
              {
                key: 'discrepancy', label: 'Cash variance', className: 'num',
                cell: (p) => {
                  if (!p.shifts) return '<span class="subtle">-</span>';
                  return p.discrepancy === 0
                    ? '<span class="c-success">Balanced</span>'
                    : `<span class="${p.discrepancy < 0 ? 'c-danger' : 'c-warning'}">${p.discrepancy > 0 ? '+' : ''}${money(p.discrepancy)}</span>`;
                }
              }
            ],
            rows: perf,
            footer: `<tr>
              <td>Totals</td>
              <td class="num">${int(sum(perf, (p) => p.transactions))}</td>
              <td class="num">${int(sum(perf, (p) => p.units))}</td>
              <td class="num">${money(totalRevenue)}</td>
              <td class="num">${money(divide(totalRevenue, sum(perf, (p) => p.transactions)))}</td>
              <td class="num">${money(sum(perf, (p) => p.cash))}</td>
              <td class="num">${money(sum(perf, (p) => p.card))}</td>
              <td class="num">${money(sum(perf, (p) => p.transfer))}</td>
              <td class="num">${money(sum(perf, (p) => p.credit))}</td>
              <td class="num">${int(sum(perf, (p) => p.returns))}</td>
              <td class="num">${int(sum(perf, (p) => p.shifts))}</td>
              <td class="num">${money(sum(perf, (p) => p.discrepancy))}</td>
            </tr>`
          })
        })}
      </div>

      <div class="span-12">
        ${card({
          title: 'Shift closing discrepancies',
          sub: `${closedShifts.filter((s) => num(s.variance) !== 0).length} shift(s) did not balance`,
          flush: true,
          body: renderTable({
            compact: true,
            columns: [
              { key: 'ref', label: 'Shift', cell: (s) => cellStack(s.ref, fmtDate(s.closedAt)) },
              { key: 'userName', label: 'Cashier', cell: (s) => escapeHtml(s.userName) },
              { key: 'expected', label: 'Expected', className: 'num', cell: (s) => money(s.expectedCash) },
              { key: 'counted', label: 'Counted', className: 'num', cell: (s) => money(s.countedCash) },
              {
                key: 'variance', label: 'Difference', className: 'num',
                cell: (s) => {
                  const v = num(s.variance);
                  return v === 0 ? '<span class="c-success">Balanced</span>'
                    : `<strong class="${v < 0 ? 'c-danger' : 'c-warning'}">${v > 0 ? '+' : ''}${money(v)}</strong>`;
                }
              },
              { key: 'note', label: 'Explanation', cell: (s) => escapeHtml(s.closingNote || '-') }
            ],
            rows: sortBy(closedShifts, (s) => Math.abs(num(s.variance)), 'desc').slice(0, 15),
            empty: emptyState({ iconName: 'checkCircle', title: 'No closed shifts in this period' })
          })
        })}
      </div>
    </div>`;
}

/* ============================== OTHER TAB ============================== */

function otherTab(bounds) {
  const aging = creditAging();
  const agingBuckets = ['current', '1-30', '31-60', '61-90', '90+'].map((bucket) => ({
    bucket,
    rows: aging.filter((a) => a.bucket === bucket),
    total: round(sum(aging.filter((a) => a.bucket === bucket), (a) => a.balance), 2)
  })).filter((b) => b.rows.length);

  const supplierRows = suppliers().map((s) => {
    const history = supplierHistory(s.id);
    return {
      supplier: s,
      purchased: round(sum(history.receipts, (r) => r.total), 2),
      paid: round(sum(history.payments, (p) => p.amount), 2),
      unpaid: history.receipts.filter((r) => !r.paid).length
    };
  });

  const returns = approvedReturns({ from: bounds.from, to: bounds.to });
  const returnReasons = [...groupBy(returns.flatMap((r) => r.items), (l) => l.reason).entries()]
    .map(([reason, list]) => ({
      label: reason,
      value: round(sum(list, (l) => l.refund), 2),
      units: sum(list, (l) => l.qty)
    }));

  const expenseRows = db.expenses.filter((e) => {
    if (bounds.from && new Date(e.date) < bounds.from) return false;
    if (bounds.to && new Date(e.date) > bounds.to) return false;
    return true;
  });
  const expenseByCategory = [...groupBy(expenseRows, (e) => e.category).entries()]
    .map(([category, list]) => ({ category, count: list.length, total: round(sum(list, (e) => e.amount), 2) }));

  // Daily cash closing across all shifts in the period
  const dayShifts = shifts().filter((s) => {
    if (s.status !== 'closed') return false;
    if (bounds.from && new Date(s.closedAt) < bounds.from) return false;
    if (bounds.to && new Date(s.closedAt) > bounds.to) return false;
    return true;
  });
  const cashDays = [...groupBy(dayShifts, (s) => isoDate(s.closedAt)).entries()]
    .map(([day, list]) => ({
      day,
      shifts: list.length,
      opening: round(sum(list, (s) => num(s.openingCash)), 2),
      cashSales: round(sum(list, (s) => num(s.cashSales)), 2),
      expected: round(sum(list, (s) => num(s.expectedCash)), 2),
      counted: round(sum(list, (s) => num(s.countedCash)), 2),
      variance: round(sum(list, (s) => num(s.variance)), 2)
    }));

  return `
    <div class="grid-dash">
      <div class="span-7">
        ${card({
          title: 'Customer credit aging',
          sub: `${money(sum(aging, (a) => a.balance))} outstanding across ${aging.length} account(s)`,
          actions: can('export.data')
            ? `<button class="btn btn-secondary btn-sm" type="button" data-export="credit">${icon('download', 14)} CSV</button>`
            : '',
          flush: true,
          body: renderTable({
            compact: true,
            columns: [
              { key: 'name', label: 'Customer', cell: (a) => cellStack(a.customer.name, a.customer.phone || '-') },
              { key: 'balance', label: 'Balance', className: 'num', cell: (a) => `<strong>${money(a.balance)}</strong>` },
              { key: 'limit', label: 'Limit', className: 'num', cell: (a) => money(a.customer.creditLimit) },
              { key: 'age', label: 'Oldest debt', cell: (a) => (a.oldest ? cellStack(fmtDate(a.oldest), `${a.age} days`) : '-') },
              {
                key: 'bucket', label: 'Age band',
                cell: (a) => badge(a.bucket === 'current' ? 'Current' : `${a.bucket} days`,
                  a.bucket === '90+' ? 'danger' : (a.bucket === '61-90' ? 'warning' : 'info'))
              }
            ],
            rows: sortBy(aging, (a) => a.balance, 'desc'),
            footer: `<tr><td>Total receivable</td>
              <td class="num">${money(sum(aging, (a) => a.balance))}</td><td colspan="3"></td></tr>`,
            empty: emptyState({ iconName: 'checkCircle', title: 'No outstanding customer credit' })
          })
        })}
      </div>

      <div class="span-5">
        ${card({
          title: 'Receivables by age',
          body: agingBuckets.length
            ? donutChart(agingBuckets.map((b) => ({
                label: b.bucket === 'current' ? 'Current' : `${b.bucket} days`,
                value: b.total
              })), { centreLabel: 'Owed' })
            : emptyState({ iconName: 'checkCircle', title: 'Nothing outstanding' })
        })}
      </div>

      <div class="span-7">
        ${card({
          title: 'Supplier balances',
          sub: `${money(sum(suppliers(), (s) => Math.max(0, num(s.balance))))} payable`,
          flush: true,
          body: renderTable({
            compact: true,
            columns: [
              { key: 'name', label: 'Supplier', cell: (r) => cellStack(r.supplier.name, r.supplier.phone || '-') },
              { key: 'purchased', label: 'Purchased', className: 'num', cell: (r) => money(r.purchased) },
              { key: 'paid', label: 'Paid', className: 'num', cell: (r) => money(r.paid) },
              { key: 'unpaid', label: 'Open invoices', className: 'num', cell: (r) => int(r.unpaid) },
              {
                key: 'balance', label: 'Balance', className: 'num',
                cell: (r) => (num(r.supplier.balance) > 0
                  ? `<strong class="c-warning">${money(r.supplier.balance)}</strong>`
                  : '<span class="c-success">Settled</span>')
              }
            ],
            rows: sortBy(supplierRows, (r) => num(r.supplier.balance), 'desc'),
            footer: `<tr><td>Totals</td>
              <td class="num">${money(sum(supplierRows, (r) => r.purchased))}</td>
              <td class="num">${money(sum(supplierRows, (r) => r.paid))}</td>
              <td class="num">${int(sum(supplierRows, (r) => r.unpaid))}</td>
              <td class="num">${money(sum(suppliers(), (s) => Math.max(0, num(s.balance))))}</td></tr>`
          })
        })}
      </div>

      <div class="span-5">
        ${card({
          title: 'Expense summary',
          sub: bounds.label,
          flush: true,
          body: renderTable({
            compact: true,
            columns: [
              { key: 'category', label: 'Category', cell: (r) => escapeHtml(r.category) },
              { key: 'count', label: 'Records', className: 'num', cell: (r) => int(r.count) },
              { key: 'total', label: 'Total', className: 'num', cell: (r) => `<strong>${money(r.total)}</strong>` }
            ],
            rows: sortBy(expenseByCategory, (r) => r.total, 'desc'),
            footer: `<tr><td>Total</td><td class="num">${int(expenseRows.length)}</td>
              <td class="num">${money(sum(expenseRows, (e) => e.amount))}</td></tr>`,
            empty: emptyState({ iconName: 'wallet', title: 'No expenses in this period' })
          })
        })}
      </div>

      <div class="span-6">
        ${card({
          title: 'Sales returns',
          sub: `${returns.length} approved return(s) worth ${money(sum(returns, (r) => r.total))}`,
          flush: true,
          body: renderTable({
            compact: true,
            columns: [
              { key: 'reason', label: 'Reason', cell: (r) => escapeHtml(r.label) },
              { key: 'units', label: 'Units', className: 'num', cell: (r) => int(r.units) },
              { key: 'value', label: 'Refunded', className: 'num', cell: (r) => money(r.value) }
            ],
            rows: sortBy(returnReasons, (r) => r.value, 'desc'),
            footer: `<tr><td>Total</td>
              <td class="num">${int(sum(returnReasons, (r) => r.units))}</td>
              <td class="num">${money(sum(returnReasons, (r) => r.value))}</td></tr>`,
            empty: emptyState({ iconName: 'returnArrow', title: 'No approved returns in this period' })
          })
        })}
      </div>

      <div class="span-6">
        ${card({
          title: 'Daily cash closing',
          sub: 'Aggregated across all shifts closed that day',
          flush: true,
          body: renderTable({
            compact: true,
            columns: [
              { key: 'day', label: 'Date', cell: (r) => cellStack(fmtDate(r.day), `${r.shifts} shift(s)`) },
              { key: 'cashSales', label: 'Cash sales', className: 'num', cell: (r) => money(r.cashSales) },
              { key: 'expected', label: 'Expected', className: 'num', cell: (r) => money(r.expected) },
              { key: 'counted', label: 'Counted', className: 'num', cell: (r) => money(r.counted) },
              {
                key: 'variance', label: 'Difference', className: 'num',
                cell: (r) => (r.variance === 0
                  ? '<span class="c-success">Balanced</span>'
                  : `<span class="${r.variance < 0 ? 'c-danger' : 'c-warning'}">${r.variance > 0 ? '+' : ''}${money(r.variance)}</span>`)
              }
            ],
            rows: sortBy(cashDays, (r) => r.day, 'desc').slice(0, 14),
            empty: emptyState({ iconName: 'cash', title: 'No closed shifts in this period' })
          })
        })}
      </div>

      <div class="span-12">
        ${card({
          title: 'Batch traceability',
          sub: 'Follow any batch from receipt to sale - open a medicine in Drug Inventory for its full movement history',
          body: `
            <div class="row-wrap mb-4">
              ${searchBox({ id: 'trace-search', placeholder: 'Enter a batch number to trace...' })}
            </div>
            <div id="trace-result">
              ${emptyState({
                iconName: 'search',
                title: 'Trace a batch',
                message: 'Type a batch number to see every movement recorded against it: goods receipt, sales, returns, adjustments and write-offs.'
              })}
            </div>`
        })}
      </div>
    </div>`;
}

/** Render the movement history of one batch for the traceability panel. */
function renderTrace(query) {
  const target = db.batches.find((b) => String(b.batchNo).toLowerCase() === String(query).trim().toLowerCase());
  const node = qs('#trace-result');
  if (!node) return;

  if (!target) {
    node.innerHTML = `<div class="alert alert-warning small">${icon('alert', 15)}
      <div>No batch found with the number "<strong>${escapeHtml(query)}</strong>".</div></div>`;
    return;
  }

  const med = medicine(target.medicineId);
  const sup = supplier(target.supplierId);
  const movements = movementsFor({ batchId: target.id });

  node.innerHTML = `
    <div class="stack-lg">
      <div class="def-grid">
        <div class="def-item"><div class="def-label">Medicine</div><div class="def-value">${escapeHtml(med ? `${med.name} ${med.strength}` : '-')}</div></div>
        <div class="def-item"><div class="def-label">Batch</div><div class="def-value mono">${escapeHtml(target.batchNo)}</div></div>
        <div class="def-item"><div class="def-label">Expiry</div><div class="def-value">${fmtDate(target.expiry)}</div></div>
        <div class="def-item"><div class="def-label">Supplier</div><div class="def-value">${escapeHtml(sup ? sup.name : '-')}</div></div>
        <div class="def-item"><div class="def-label">Units on hand</div><div class="def-value num">${int(target.qty)}</div></div>
        <div class="def-item"><div class="def-label">Status</div><div class="def-value">${statusBadge(batchState(target))}</div></div>
      </div>
      ${renderTable({
        compact: true,
        columns: [
          { key: 'datetime', label: 'When', cell: (m) => cellStack(fmtDate(m.datetime), fmtTime(m.datetime)) },
          { key: 'type', label: 'Movement', cell: (m) => escapeHtml(m.type) },
          { key: 'qty', label: 'Change', className: 'num', cell: (m) => `<span class="${m.qty > 0 ? 'c-success' : 'c-danger'}">${m.qty > 0 ? '+' : ''}${int(m.qty)}</span>` },
          { key: 'balance', label: 'Running stock', className: 'num', cell: (m) => `${int(m.before)} → ${int(m.after)}` },
          { key: 'ref', label: 'Reference', cell: (m) => `<span class="mono small">${escapeHtml(m.ref || '-')}</span>` },
          { key: 'userName', label: 'By', cell: (m) => escapeHtml(m.userName) },
          { key: 'note', label: 'Note', cell: (m) => escapeHtml(m.note || '-') }
        ],
        rows: movements,
        empty: emptyState({ title: 'No movements recorded for this batch' })
      })}
    </div>`;
}

/* ============================== EXPORTS ============================== */

function exportTable(kind, bounds) {
  if (!can('export.data')) { notifyDenied({ message: 'Your account cannot export data.' }); return; }

  const map = {
    medicines: () => downloadCsv(exportName('report-medicine-sales'), sortBy(medicineSalesStats({ from: bounds.from, to: bounds.to }), (r) => r.revenue, 'desc'), [
      { label: 'Medicine', value: (r) => r.name },
      { label: 'Units sold', value: (r) => r.units },
      { label: 'Lines sold', value: (r) => r.transactions },
      { label: 'Revenue', value: (r) => r.revenue },
      { label: 'Gross profit', value: (r) => r.profit }
    ]),
    daily: () => downloadCsv(exportName('report-daily-financials'), dailyBreakdown(bounds), [
      { label: 'Date', value: (r) => fmtDate(r.date) },
      { label: 'Transactions', value: (r) => r.transactions },
      { label: 'Revenue', value: (r) => r.revenue },
      { label: 'Cost of goods', value: (r) => r.cogs },
      { label: 'Gross profit', value: (r) => r.gross },
      { label: 'Expenses', value: (r) => r.expenses },
      { label: 'Net profit', value: (r) => r.net }
    ]),
    stock: () => downloadCsv(exportName('report-stock-position'), medicines().map((med) => ({ med, summary: stockSummary(med.id) })), [
      { label: 'Medicine', value: (r) => `${r.med.name} ${r.med.strength}`.trim() },
      { label: 'SKU', value: (r) => r.med.sku },
      { label: 'Category', value: (r) => r.med.category },
      { label: 'Available', value: (r) => r.summary.available },
      { label: 'Batches', value: (r) => r.summary.sellableBatches },
      { label: 'Average cost', value: (r) => r.summary.cost },
      { label: 'Selling price', value: (r) => r.summary.price },
      { label: 'Value at cost', value: (r) => r.summary.stockValueCost },
      { label: 'Value at retail', value: (r) => r.summary.stockValueRetail },
      { label: 'Status', value: (r) => STATUS_LABELS[r.summary.status].label }
    ]),
    batches: () => downloadCsv(exportName('report-batch-stock'), sortBy(db.batches.filter((b) => !isWrittenOff(b)), (b) => b.expiry, 'asc'), [
      { label: 'Medicine', value: (b) => { const m = medicine(b.medicineId); return m ? `${m.name} ${m.strength}`.trim() : ''; } },
      { label: 'Batch', value: (b) => b.batchNo },
      { label: 'Expiry', value: (b) => fmtDate(b.expiry) },
      { label: 'Days to expiry', value: (b) => daysUntil(b.expiry) },
      { label: 'Units', value: (b) => b.qty },
      { label: 'Unit cost', value: (b) => b.costPrice },
      { label: 'Selling price', value: (b) => b.price },
      { label: 'Value at cost', value: (b) => round(num(b.qty) * num(b.costPrice), 2) },
      { label: 'Location', value: (b) => b.location },
      { label: 'Status', value: (b) => batchState(b).label }
    ]),
    staff: () => downloadCsv(exportName('report-staff-performance'), staffPerformance({ from: bounds.from, to: bounds.to }), [
      { label: 'Staff member', value: (p) => p.user.name },
      { label: 'Role', value: (p) => roleLabel(p.user.role) },
      { label: 'Transactions', value: (p) => p.transactions },
      { label: 'Units', value: (p) => p.units },
      { label: 'Revenue', value: (p) => p.revenue },
      { label: 'Gross profit', value: (p) => p.profit },
      { label: 'Average sale', value: (p) => p.average },
      { label: 'Cash', value: (p) => p.cash },
      { label: 'Card', value: (p) => p.card },
      { label: 'Transfer', value: (p) => p.transfer },
      { label: 'Credit', value: (p) => p.credit },
      { label: 'Returns raised', value: (p) => p.returns },
      { label: 'Closed shifts', value: (p) => p.shifts },
      { label: 'Cash variance', value: (p) => p.discrepancy }
    ]),
    credit: () => downloadCsv(exportName('report-credit-aging'), creditAging(), [
      { label: 'Customer', value: (a) => a.customer.name },
      { label: 'Phone', value: (a) => a.customer.phone },
      { label: 'Balance', value: (a) => a.balance },
      { label: 'Credit limit', value: (a) => a.customer.creditLimit },
      { label: 'Oldest debt', value: (a) => (a.oldest ? fmtDate(a.oldest) : '') },
      { label: 'Age in days', value: (a) => a.age },
      { label: 'Age band', value: (a) => a.bucket }
    ])
  };

  if (map[kind]) {
    map[kind]();
    notifySuccess('Export ready', 'The report has been downloaded as CSV.');
  }
}

/* ============================== PRINT ============================== */

function printReport(bounds) {
  const pharmacy = settings().pharmacy;
  const fin = financials({ from: bounds.from, to: bounds.to });
  const value = inventoryValue();
  const perf = sortBy(staffPerformance({ from: bounds.from, to: bounds.to }).filter((p) => p.transactions > 0), (p) => p.revenue, 'desc');
  const topMedicines = sortBy(medicineSalesStats({ from: bounds.from, to: bounds.to }), (r) => r.revenue, 'desc').slice(0, 15);
  const buckets = expiryBuckets();

  printNode(`
    <div class="print-doc">
      ${printHeader({
        pharmacy,
        title: 'Business Performance Report',
        subtitle: bounds.label,
        meta: `Generated ${fmtDateTime(new Date())}<br>By ${escapeHtml(ctxRef.user.name)}<br>
               Licence ${escapeHtml(pharmacy.licence || '-')}`
      })}

      <div class="print-kpis">
        <div class="print-kpi"><div class="pk-label">Net revenue</div><div class="pk-value">${money(fin.netRevenue)}</div></div>
        <div class="print-kpi"><div class="pk-label">Gross profit</div><div class="pk-value">${money(fin.grossProfit)}</div></div>
        <div class="print-kpi"><div class="pk-label">Expenses</div><div class="pk-value">${money(fin.expenses)}</div></div>
        <div class="print-kpi"><div class="pk-label">Net profit</div><div class="pk-value">${money(fin.netProfit)}</div></div>
      </div>

      <h2 class="print-section">Profit and loss</h2>
      <table>
        <tbody>
          <tr><td>Gross revenue</td><td class="num">${money(fin.revenue)}</td></tr>
          <tr><td>Less: approved refunds</td><td class="num">-${money(fin.refunds)}</td></tr>
          <tr><td><strong>Net revenue</strong></td><td class="num"><strong>${money(fin.netRevenue)}</strong></td></tr>
          <tr><td>Less: cost of goods sold</td><td class="num">-${money(fin.cogs)}</td></tr>
          <tr><td><strong>Gross profit</strong></td><td class="num"><strong>${money(fin.grossProfit)} (${percent(fin.margin)})</strong></td></tr>
          <tr><td>Less: operating expenses</td><td class="num">-${money(fin.expenses)}</td></tr>
          <tr><td><strong>Net profit</strong></td><td class="num"><strong>${money(fin.netProfit)}</strong></td></tr>
        </tbody>
      </table>

      <h2 class="print-section">Sales summary</h2>
      <table>
        <tbody>
          <tr><td>Transactions</td><td class="num">${int(fin.transactions)}</td></tr>
          <tr><td>Units dispensed</td><td class="num">${int(fin.units)}</td></tr>
          <tr><td>Average transaction value</td><td class="num">${money(divide(fin.revenue, fin.transactions))}</td></tr>
          <tr><td>Discounts given</td><td class="num">${money(fin.discount)}</td></tr>
          <tr><td>Cash</td><td class="num">${money(fin.cash)}</td></tr>
          <tr><td>POS / card</td><td class="num">${money(fin.card)}</td></tr>
          <tr><td>Bank transfer</td><td class="num">${money(fin.transfer)}</td></tr>
          <tr><td>Credit extended</td><td class="num">${money(fin.credit)}</td></tr>
        </tbody>
      </table>

      <h2 class="print-section">Staff performance</h2>
      <table>
        <thead><tr><th>Staff member</th><th>Role</th><th class="num">Sales</th>
          <th class="num">Units</th><th class="num">Revenue</th><th class="num">Average</th><th class="num">Cash variance</th></tr></thead>
        <tbody>${perf.map((p) => `<tr>
          <td>${escapeHtml(p.user.name)}</td>
          <td>${escapeHtml(roleLabel(p.user.role))}</td>
          <td class="num">${int(p.transactions)}</td>
          <td class="num">${int(p.units)}</td>
          <td class="num">${money(p.revenue)}</td>
          <td class="num">${money(p.average)}</td>
          <td class="num">${money(p.discrepancy)}</td>
        </tr>`).join('')}</tbody>
      </table>

      <h2 class="print-section">Top selling medicines</h2>
      <table>
        <thead><tr><th>Medicine</th><th class="num">Units</th><th class="num">Revenue</th>
          <th class="num">Gross profit</th><th class="num">Margin</th></tr></thead>
        <tbody>${topMedicines.map((r) => `<tr>
          <td>${escapeHtml(r.name)}</td>
          <td class="num">${int(r.units)}</td>
          <td class="num">${money(r.revenue)}</td>
          <td class="num">${money(r.profit)}</td>
          <td class="num">${percent(divide(r.profit, r.revenue) * 100)}</td>
        </tr>`).join('')}</tbody>
      </table>

      <h2 class="print-section">Inventory position</h2>
      <table>
        <tbody>
          <tr><td>Medicines listed</td><td class="num">${int(medicines().length)}</td></tr>
          <tr><td>Batches in stock</td><td class="num">${int(value.batches)}</td></tr>
          <tr><td>Units on hand</td><td class="num">${int(value.units)}</td></tr>
          <tr><td>Stock value at cost</td><td class="num">${money(value.cost)}</td></tr>
          <tr><td>Stock value at retail</td><td class="num">${money(value.retail)}</td></tr>
          <tr><td>Expired batches</td><td class="num">${int(buckets.expired.length)}</td></tr>
          <tr><td>Expiring within 30 days</td><td class="num">${int(buckets.d30.length)}</td></tr>
          <tr><td>Quarantined batches</td><td class="num">${int(buckets.quarantined.length)}</td></tr>
          <tr><td>Blocked stock value</td><td class="num">${money(value.quarantinedCost)}</td></tr>
          <tr><td>Customer receivables</td><td class="num">${money(sum(customers(), (c) => Math.max(0, num(c.balance))))}</td></tr>
          <tr><td>Supplier payables</td><td class="num">${money(sum(suppliers(), (s) => Math.max(0, num(s.balance))))}</td></tr>
        </tbody>
      </table>

      ${printFooter({
        left: `${escapeHtml(pharmacy.name)} - confidential management report`,
        right: 'MediFlow Pharmacy ERP'
      })}
    </div>`, 'report');
}

/* ============================== RENDER ============================== */

export function render(root, ctx) {
  ctxRef = ctx;
  try {
    requirePermission('reports.view');
  } catch (error) {
    notifyDenied(error);
    ctx.navigate('/dashboard');
    return;
  }

  const bounds = range();

  const tabBody = {
    sales: salesTab,
    financial: financialTab,
    inventory: inventoryTab,
    staff: staffTab,
    other: otherTab
  }[state.tab](bounds);

  root.innerHTML = `
  <div class="page">
    ${pageHead({
      title: 'Reports & Analytics',
      subtitle: `${bounds.label} - every figure is calculated from actual transaction records.`,
      actions: `
        <button class="btn btn-secondary" type="button" id="btn-print">${icon('print', 16)} Print report</button>`
    })}

    <div class="toolbar">
      <div class="toolbar-group">
        <div class="segmented">
          ${PRESETS.map((p) => `<button type="button" data-preset="${p.key}" class="${state.preset === p.key ? 'is-active' : ''}">${p.label}</button>`).join('')}
        </div>
      </div>
      ${state.preset === 'custom' ? `
        <div class="toolbar-group">
          <input class="input filter-select" id="f-from" type="date" value="${state.from}" aria-label="From date">
          <input class="input filter-select" id="f-to" type="date" value="${state.to}" aria-label="To date">
        </div>` : ''}
      <div class="spacer"></div>
      <div class="toolbar-group">
        <select class="select filter-select" id="f-user" aria-label="Filter by staff">
          ${options(users().map((u) => ({ value: u.id, label: u.name })), state.userId, { placeholder: 'All staff' })}
        </select>
        <select class="select filter-select" id="f-category" aria-label="Filter by category">
          ${options(unique(medicines().map((m) => m.category)).sort(), state.category, { placeholder: 'All categories' })}
        </select>
      </div>
    </div>

    <div class="tabs" id="rep-tabs">
      ${TABS.map((tab) => `
        <button type="button" data-tab="${tab.key}" class="${state.tab === tab.key ? 'is-active' : ''}">
          ${icon(tab.icon, 15)} ${tab.label}
        </button>`).join('')}
    </div>

    ${tabBody}
  </div>`;

  /* ---------------------------- events ---------------------------- */

  const rerender = () => ctx.refresh();

  qsa('#rep-tabs [data-tab]', root).forEach((btn) => btn.addEventListener('click', () => {
    state.tab = btn.getAttribute('data-tab');
    rerender();
  }));

  qsa('[data-preset]', root).forEach((btn) => btn.addEventListener('click', () => {
    state.preset = btn.getAttribute('data-preset');
    if (state.preset === 'custom' && !state.from) {
      state.from = isoDate(addDays(new Date(), -29));
      state.to = isoDate(new Date());
    }
    rerender();
  }));

  qsa('[data-grain]', root).forEach((btn) => btn.addEventListener('click', () => {
    state.grain = btn.getAttribute('data-grain');
    rerender();
  }));

  const bind = (selector, key) => {
    const node = qs(selector, root);
    if (node) node.addEventListener('change', () => { state[key] = node.value; rerender(); });
  };
  bind('#f-from', 'from');
  bind('#f-to', 'to');
  bind('#f-user', 'userId');
  bind('#f-category', 'category');

  on(root, 'click', '[data-export]', (event, node) => exportTable(node.getAttribute('data-export'), bounds));

  qs('#btn-print', root).addEventListener('click', () => printReport(bounds));

  const trace = qs('#trace-search', root);
  if (trace) {
    trace.addEventListener('input', debounce(() => {
      const value = trace.value.trim();
      if (value.length < 3) return;
      renderTrace(value);
    }, 320));
    trace.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); renderTrace(trace.value.trim()); }
    });
  }
}

export default { render };
