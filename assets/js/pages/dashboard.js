/* ==========================================================================
   MediFlow Pharmacy ERP - Dashboard
   Role-aware overview: the owner sees the whole business, staff see only their
   own figures and the operational alerts they can act on (section 6).
   ========================================================================== */

import {
  dashboardSnapshot, dailySeries, medicineSalesStats, staffPerformance, alerts, settings,
  activeShift, shiftSummary, medicine, financials
} from '../store.js';
import { can } from '../auth.js';
import {
  pageHead, card, kpi, icon, badge, lineChart, barChart, donutChart, rankChart,
  renderTable, cellStack, emptyState, escapeHtml, statusBadge
} from '../ui.js';
import {
  money, moneyShort, int, fmtDateTime, fmtRelative, fmtDate, fmtTime, num,
  sortBy, lastNMonths, startOfMonth, endOfDay, daysUntil, fmtDuration, percent, divide
} from '../utils.js';

/* ============================== ALERT CARDS ============================== */

const ALERT_ICONS = { alert: 'alert', clock: 'clock', box: 'box', return: 'returnArrow', cash: 'cash', users: 'users', qr: 'qr' };

function renderAlerts(adminView) {
  const rows = alerts().filter((a) => adminView || !a.adminOnly);
  if (!rows.length) {
    return emptyState({
      iconName: 'checkCircle',
      title: 'Nothing needs attention',
      message: 'No expiring stock, low stock or pending approvals right now.'
    });
  }
  return `<div class="list">${rows.map((a) => `
    <button class="list-row is-clickable" type="button" data-route="${escapeHtml(a.route)}">
      <span class="list-avatar tone-${a.tone}">${icon(ALERT_ICONS[a.icon] || 'info', 16)}</span>
      <span class="list-main">
        <span class="list-title">${escapeHtml(a.title)}</span>
        <span class="list-sub">${escapeHtml(a.detail)}</span>
      </span>
      <span class="list-end">${icon('chevronRight', 16)}</span>
    </button>`).join('')}</div>`;
}

/* ============================== ADMIN DASHBOARD ============================== */

function renderAdmin(root, ctx) {
  const snap = dashboardSnapshot({});
  const pharmacy = settings().pharmacy || {};
  const series = dailySeries(14);
  const weekSeries = dailySeries(7);
  const months = lastNMonths(6);
  const inventory = snap.inventory;

  // Monthly revenue from actual transactions
  const monthly = months.map((m) => {
    const fin = financials({ from: m.start, to: m.end });
    return { label: m.label, value: fin.revenue, tip: `${m.label}: ${money(fin.revenue)} revenue, ${money(fin.netProfit)} net profit` };
  });

  // Top sellers this month
  const monthStats = sortBy(
    medicineSalesStats({ from: startOfMonth(), to: endOfDay() }),
    (r) => r.revenue, 'desc'
  ).slice(0, 6);

  // Sales by staff today
  const staffToday = sortBy(
    staffPerformance({ from: new Date(new Date().setHours(0, 0, 0, 0)), to: endOfDay() })
      .filter((row) => row.transactions > 0),
    (r) => r.revenue, 'desc'
  );

  const paymentMix = [
    { label: 'Cash', value: snap.financials.cash },
    { label: 'POS/Card', value: snap.financials.card },
    { label: 'Transfer', value: snap.financials.transfer },
    { label: 'Credit', value: snap.financials.credit }
  ];

  const inventoryMix = [
    { label: 'Sellable stock', value: inventory.sellableCost, color: 'var(--chart-1)' },
    { label: 'Quarantined / expired', value: inventory.quarantinedCost, color: 'var(--chart-3)' }
  ];

  root.innerHTML = `
  <div class="page">
    ${pageHead({
      title: `Good ${greeting()}, ${ctx.user.name.split(' ').slice(-1)[0]}`,
      subtitle: `${pharmacy.name} - ${fmtDate(new Date())} - business overview`,
      actions: `
        <button class="btn btn-secondary" type="button" data-route="#/reports">${icon('chart', 16)} Full reports</button>
        <button class="btn btn-primary" type="button" data-route="#/pos">${icon('pos', 16)} New sale</button>`
    })}

    <div class="kpi-grid">
      ${kpi({ label: "Today's revenue", value: money(snap.todayRevenue), iconName: 'wallet', tone: 'success', foot: `<span>${int(snap.todaySales)} transactions · ${int(snap.todayUnits)} units</span>`, route: '#/sales' })}
      ${kpi({ label: 'Gross profit today', value: money(snap.grossProfit), iconName: 'trending', tone: 'info', foot: `<span>${percent(divide(snap.grossProfit, snap.todayRevenue) * 100)} margin</span>` })}
      ${kpi({ label: 'Net profit today', value: money(snap.netProfit), iconName: 'percent', tone: snap.netProfit >= 0 ? 'success' : 'danger', foot: `<span>After ${money(snap.todayExpenses)} expenses</span>`, route: '#/expenses' })}
      ${kpi({ label: 'Cash in drawer', value: money(snap.cashInDrawer), iconName: 'cash', tone: 'warning', foot: `<span>${snap.openShifts.length} open shift(s)</span>`, route: '#/shift' })}
    </div>

    <div class="kpi-grid">
      ${kpi({ label: 'Medicines', value: int(snap.medicinesCount), iconName: 'pill', foot: `<span>${int(inventory.batches)} batches · ${int(inventory.units)} units</span>`, route: '#/inventory', small: true })}
      ${kpi({ label: 'Stock value (cost)', value: moneyShort(inventory.cost), iconName: 'layers', tone: 'info', foot: `<span>Retail ${moneyShort(inventory.retail)}</span>`, route: '#/reports', small: true })}
      ${kpi({ label: 'Low stock', value: int(snap.lowStock.length), iconName: 'box', tone: snap.lowStock.length ? 'warning' : '', foot: '<span>At or below reorder level</span>', route: '#/inventory?filter=low', small: true })}
      ${kpi({ label: 'Expiring in 30 days', value: int(snap.expiring30.length), iconName: 'clock', tone: snap.expiring30.length ? 'warning' : '', foot: `<span>${int(snap.expiring60.length)} in 60d · ${int(snap.expiring90.length)} in 90d</span>`, route: '#/expiry', small: true })}
      ${kpi({ label: 'Expired batches', value: int(snap.expired.length), iconName: 'alert', tone: snap.expired.length ? 'danger' : '', foot: '<span>Blocked from sale</span>', route: '#/expiry', small: true })}
      ${kpi({ label: 'Customer credit', value: moneyShort(snap.outstandingCredit), iconName: 'users', tone: snap.outstandingCredit ? 'warning' : '', foot: '<span>Outstanding balances</span>', route: '#/customers?filter=credit', small: true })}
    </div>

    <div class="grid-dash">
      <div class="span-8">
        ${card({
          title: 'Daily sales overview',
          sub: 'Revenue and gross profit, last 14 days',
          actions: `<span class="chart-legend" style="margin:0">
            <span><i style="background:var(--chart-1)"></i>Revenue</span>
            <span><i style="background:var(--chart-2)"></i>Gross profit</span></span>`,
          body: lineChart(series.map((d) => ({ label: d.label, value: d.revenue, value2: d.profit })), { series2Label: 'Profit' })
        })}
      </div>
      <div class="span-4">
        ${card({
          title: 'Priority alerts',
          sub: 'Every alert opens its module',
          body: renderAlerts(true),
          flush: true
        })}
      </div>

      <div class="span-4">
        ${card({ title: 'This week', sub: 'Revenue by day', body: barChart(weekSeries.map((d) => ({ label: d.label, value: d.revenue }))) })}
      </div>
      <div class="span-4">
        ${card({ title: 'Monthly revenue', sub: 'Last 6 months', body: barChart(monthly, { color: 'var(--chart-2)' }) })}
      </div>
      <div class="span-4">
        ${card({ title: "Today's payment mix", body: donutChart(paymentMix, { centreLabel: 'Revenue' }) })}
      </div>

      <div class="span-6">
        ${card({
          title: 'Top-selling medicines',
          sub: 'By revenue, this month',
          actions: `<button class="btn btn-ghost btn-sm" type="button" data-route="#/reports">View report</button>`,
          body: monthStats.length
            ? rankChart(monthStats.map((r) => ({ label: r.name, value: r.revenue, sub: `${int(r.units)} units · ${money(r.profit)} profit` })))
            : emptyState({ iconName: 'chart', title: 'No sales this month yet' })
        })}
      </div>
      <div class="span-6">
        ${card({
          title: 'Sales by staff today',
          sub: 'Individual accountability',
          actions: `<button class="btn btn-ghost btn-sm" type="button" data-route="#/reports">Staff report</button>`,
          body: staffToday.length
            ? rankChart(staffToday.map((r) => ({
                label: r.user.name,
                value: r.revenue,
                sub: `${int(r.transactions)} sales · avg ${money(r.average)}`,
                color: 'var(--chart-4)'
              })))
            : emptyState({ iconName: 'users', title: 'No staff sales recorded today' })
        })}
      </div>

      <div class="span-4">
        ${card({ title: 'Inventory overview', sub: 'Stock value at cost', body: donutChart(inventoryMix, { centreLabel: 'At cost' }) })}
      </div>

      <div class="span-8">
        ${card({
          title: 'Recent sales',
          actions: `<button class="btn btn-ghost btn-sm" type="button" data-route="#/sales">All sales ${icon('arrowRight', 14)}</button>`,
          flush: true,
          body: renderTable({
            columns: [
              { key: 'ref', label: 'Receipt', cell: (r) => cellStack(r.ref, fmtTime(r.datetime)) },
              { key: 'customerName', label: 'Customer', cell: (r) => escapeHtml(r.customerName) },
              { key: 'userName', label: 'Cashier', cell: (r) => escapeHtml(r.userName) },
              { key: 'units', label: 'Units', className: 'num', cell: (r) => int(r.units) },
              { key: 'method', label: 'Payment', cell: (r) => badge(r.payment.method, r.payment.method === 'Credit' ? 'warning' : 'neutral') },
              { key: 'total', label: 'Total', className: 'num', cell: (r) => `<strong>${money(r.total)}</strong>` }
            ],
            rows: snap.recentSales,
            rowClass: (r) => (r.status === 'voided' ? 'row-danger' : ''),
            empty: emptyState({ iconName: 'receipt', title: 'No sales recorded yet', message: 'Completed sales appear here.' })
          })
        })}
      </div>

      <div class="span-6">
        ${card({
          title: 'Recent stock receipts',
          actions: `<button class="btn btn-ghost btn-sm" type="button" data-route="#/receive">Receive stock</button>`,
          flush: true,
          body: snap.recentReceipts.length ? `<div class="list">${snap.recentReceipts.map((r) => `
            <div class="list-row">
              <span class="list-avatar tone-info">${icon('truck', 16)}</span>
              <span class="list-main">
                <span class="list-title">${escapeHtml(r.ref)} · ${int(r.units)} units</span>
                <span class="list-sub">${escapeHtml(r.lines.length)} line(s) · ${fmtRelative(r.datetime)} · by ${escapeHtml(r.userName)}</span>
              </span>
              <span class="list-end"><strong class="num">${money(r.total)}</strong></span>
            </div>`).join('')}</div>`
            : emptyState({ iconName: 'truck', title: 'No goods receipts yet' })
        })}
      </div>

      <div class="span-6">
        ${card({
          title: 'Recent stock adjustments',
          actions: `<button class="btn btn-ghost btn-sm" type="button" data-route="#/adjustment">Adjust stock</button>`,
          flush: true,
          body: snap.recentAdjustments.length ? `<div class="list">${snap.recentAdjustments.map((a) => `
            <div class="list-row">
              <span class="list-avatar tone-${a.type === 'increase' ? 'success' : 'danger'}">${icon(a.type === 'increase' ? 'arrowUp' : 'arrowDown', 16)}</span>
              <span class="list-main">
                <span class="list-title">${escapeHtml(a.medicineName)} · ${a.type === 'increase' ? '+' : '-'}${int(a.qty)}</span>
                <span class="list-sub">${escapeHtml(a.reason)} · batch ${escapeHtml(a.batchNo)} · ${fmtRelative(a.datetime)}</span>
              </span>
              <span class="list-end"><span class="sm ${a.valueImpact < 0 ? 'c-danger' : 'c-success'} num">${money(a.valueImpact)}</span></span>
            </div>`).join('')}</div>`
            : emptyState({ iconName: 'adjust', title: 'No adjustments recorded' })
        })}
      </div>

      <div class="span-12">
        ${card({
          title: 'Staff activity',
          sub: 'Most recent audited operations',
          actions: `<button class="btn btn-ghost btn-sm" type="button" data-route="#/activity">Full activity log ${icon('arrowRight', 14)}</button>`,
          flush: true,
          body: renderTable({
            compact: true,
            columns: [
              { key: 'datetime', label: 'When', cell: (r) => cellStack(fmtRelative(r.datetime), fmtDateTime(r.datetime)) },
              { key: 'userName', label: 'User', cell: (r) => cellStack(r.userName, r.role === 'admin' ? 'Owner' : 'Staff') },
              { key: 'action', label: 'Action', cell: (r) => `<span class="mono small">${escapeHtml(r.action)}</span>` },
              { key: 'description', label: 'Description', cell: (r) => escapeHtml(r.description) },
              { key: 'ref', label: 'Reference', cell: (r) => (r.ref ? `<span class="mono small">${escapeHtml(r.ref)}</span>` : '<span class="subtle">-</span>') }
            ],
            rows: snap.recentActivity
          })
        })}
      </div>
    </div>
  </div>`;
}

/* ============================== STAFF DASHBOARD ============================== */

function renderStaff(root, ctx) {
  const snap = dashboardSnapshot({ userId: ctx.user.id });
  const pharmacy = settings().pharmacy || {};
  const shift = activeShift(ctx.user.id);
  const summary = shift ? shiftSummary(shift) : null;
  const mySeries = dailySeries(7, { userId: ctx.user.id });

  // Staff see stock availability but never cost or profit figures.
  const lowStockRows = snap.lowStock.slice(0, 8).map((row) => ({
    med: row.med,
    summary: row.summary
  }));

  const expiringRows = sortBy([...snap.expiring30, ...snap.expired], (b) => b.expiry, 'asc').slice(0, 8);

  root.innerHTML = `
  <div class="page">
    ${pageHead({
      title: `Good ${greeting()}, ${ctx.user.name.split(' ')[0]}`,
      subtitle: `${pharmacy.name} - ${fmtDate(new Date())}`,
      actions: `
        ${can('shift.own') && !shift ? '<button class="btn btn-secondary" type="button" data-route="#/shift">' + icon('cash', 16) + ' Open shift</button>' : ''}
        <button class="btn btn-primary" type="button" data-route="#/pos">${icon('pos', 16)} Start selling</button>`
    })}

    ${!shift && can('shift.own') ? `
      <div class="alert alert-warning">
        ${icon('alert', 17)}
        <div>
          <div class="alert-title">No open shift</div>
          <div class="small">Open your shift so the cash you take is reconciled to your drawer at close of business.</div>
        </div>
        <button class="btn btn-sm btn-warning-soft" style="margin-left:auto" type="button" data-route="#/shift">Open shift</button>
      </div>` : ''}

    <div class="kpi-grid">
      ${kpi({ label: 'My sales today', value: money(snap.todayRevenue), iconName: 'wallet', tone: 'success', foot: `<span>${int(snap.todaySales)} transactions</span>`, route: '#/sales' })}
      ${kpi({ label: 'Units dispensed', value: int(snap.todayUnits), iconName: 'pill', tone: 'info', foot: '<span>Across all my receipts today</span>' })}
      ${kpi({ label: 'My current shift', value: shift ? money(summary.expectedCash) : 'Not open', iconName: 'cash', tone: shift ? 'warning' : '', foot: shift ? `<span>Opened ${fmtTime(shift.openedAt)} · ${fmtDuration(shift.openedAt)}</span>` : '<span>Open a shift to track cash</span>', route: '#/shift', small: !shift })}
      ${kpi({ label: 'Low stock items', value: int(snap.lowStock.length), iconName: 'box', tone: snap.lowStock.length ? 'warning' : '', foot: '<span>Tell the owner to reorder</span>', route: '#/inventory?filter=low' })}
    </div>

    <div class="grid-dash">
      <div class="span-8">
        ${card({
          title: 'My recent sales',
          actions: `<button class="btn btn-ghost btn-sm" type="button" data-route="#/sales">All my sales ${icon('arrowRight', 14)}</button>`,
          flush: true,
          body: renderTable({
            columns: [
              { key: 'ref', label: 'Receipt', cell: (r) => cellStack(r.ref, fmtTime(r.datetime)) },
              { key: 'customerName', label: 'Customer', cell: (r) => escapeHtml(r.customerName) },
              { key: 'units', label: 'Units', className: 'num', cell: (r) => int(r.units) },
              { key: 'method', label: 'Payment', cell: (r) => badge(r.payment.method, r.payment.method === 'Credit' ? 'warning' : 'neutral') },
              { key: 'total', label: 'Total', className: 'num', cell: (r) => `<strong>${money(r.total)}</strong>` }
            ],
            rows: snap.recentSales,
            empty: emptyState({
              iconName: 'receipt',
              title: 'You have not made any sales yet',
              message: 'Your completed receipts will be listed here.',
              actions: '<button class="btn btn-primary btn-sm" type="button" data-route="#/pos">Open point of sale</button>'
            })
          })
        })}
      </div>

      <div class="span-4">
        ${card({
          title: 'Alerts',
          body: renderAlerts(false),
          flush: true
        })}
      </div>

      <div class="span-6">
        ${card({ title: 'My sales this week', sub: 'Revenue I recorded', body: barChart(mySeries.map((d) => ({ label: d.label, value: d.revenue }))) })}
      </div>

      <div class="span-6">
        ${card({
          title: 'Expiry watch',
          sub: 'Dispense the earliest-expiring batch first',
          flush: true,
          body: expiringRows.length ? renderTable({
            compact: true,
            columns: [
              { key: 'med', label: 'Medicine', cell: (b) => {
                const med = medicine(b.medicineId);
                return cellStack(med ? `${med.name} ${med.strength}` : 'Unknown', `Batch ${b.batchNo}`);
              } },
              { key: 'expiry', label: 'Expiry', cell: (b) => fmtDate(b.expiry) },
              { key: 'qty', label: 'Units', className: 'num', cell: (b) => int(b.qty) },
              { key: 'state', label: 'Status', cell: (b) => {
                const days = daysUntil(b.expiry);
                return days < 0 ? badge('Expired', 'danger', { dot: true }) : badge(`${days} days`, 'warning', { dot: true });
              } }
            ],
            rows: expiringRows
          }) : emptyState({ iconName: 'checkCircle', title: 'No batches expiring soon' })
        })}
      </div>

      <div class="span-12">
        ${card({
          title: 'Low stock medicines',
          sub: 'Availability only - pricing and cost are managed by the owner',
          flush: true,
          body: lowStockRows.length ? renderTable({
            compact: true,
            columns: [
              { key: 'name', label: 'Medicine', cell: (r) => cellStack(`${r.med.name} ${r.med.strength}`, `${r.med.form} · ${r.med.category}`) },
              { key: 'available', label: 'Available', className: 'num', cell: (r) => int(r.summary.available) },
              { key: 'reorder', label: 'Reorder level', className: 'num', cell: (r) => int(r.summary.reorderLevel) },
              { key: 'status', label: 'Status', cell: (r) => statusBadge({
                label: r.summary.status === 'out' ? 'Out of Stock' : 'Low Stock',
                tone: r.summary.status === 'out' ? 'danger' : 'warning'
              }) }
            ],
            rows: lowStockRows
          }) : emptyState({ iconName: 'checkCircle', title: 'Stock levels are healthy' })
        })}
      </div>
    </div>
  </div>`;
}

/* ============================== ENTRY ============================== */

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

export function render(root, ctx) {
  // Cost, profit and cross-staff figures are gated on inventory.cost (admin).
  if (can('inventory.cost')) renderAdmin(root, ctx);
  else renderStaff(root, ctx);
}

export default { render };
