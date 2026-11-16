// Taxes tab (version 1.27.0, owner only): one closed calendar month per channel, for the Washington
// state monthly excise (sales tax) return. Only numbers the add-on stored are used. A figure that isn't
// stored is null with a plain reason, never an estimate. No page code here, so the tests can run it
// (phone/tools/test-taxes.mjs). Amounts in cents; days are the store's days (Pacific time), as everywhere.
import { addDays, parseKey } from './lib.js';

export const TAX_FIRST_MONTH = '2026-09';
// CAN AM PIZZA's own Clover account starts this day. Before it, in-store sales were rung up on the old
// account (see CLOVER_OLD in sources.js), which the add-on doesn't read again, and Clover has no copy of
// the website orders.
export const CLOVER_FROM = '2026-09-25';
const OLD_CLOVER_TO = '2026-09-25';

export const TAX_CHANNELS = [
  { id: 'instore', name: 'In-store', note: 'Clover, card and cash' },
  { id: 'owner', name: 'Website and app', note: 'Owner.com' },
  { id: 'doordash', name: 'DoorDash' },
  { id: 'uber', name: 'Uber Eats' },
  { id: 'grubhub', name: 'Grubhub' },
];

export const monthOf = (dayKey) => dayKey.slice(0, 7);
// every day of a calendar month: ['2026-10-01', ..., '2026-10-31']
export function monthDays(month) {
  const out = [];
  for (let k = `${month}-01`; monthOf(k) === month; k = addDays(k, 1)) out.push(k);
  return out;
}
export const nextMonth = (month) => monthOf(addDays(`${month}-28`, 7));
// Months that have ended, newest first, from September 2026 on (today = the store's day, YYYY-MM-DD).
export function closedMonths(today, first = TAX_FIRST_MONTH) {
  const out = [];
  for (let m = first; m < monthOf(today); m = nextMonth(m)) out.unshift(m);
  return out;
}
export function monthLabel(month) {
  const { y, m } = parseKey(`${month}-01`);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });
}

const num = (v) => typeof v === 'number' && Number.isFinite(v);
// a figure that is the sum of what each day stored, or null (with why) when a day didn't store it
const part = () => ({ cents: 0, have: 0, miss: [] });
function close(p, why) {
  return p.miss.length ? { cents: null, known: p.cents, missDays: p.miss, why: why(p.miss) } : { cents: p.cents };
}
const fmtDays = (days) => {
  if (!days.length) return '';
  const d = (k) => String(parseKey(k).d);
  const mon = (k) => new Date(Date.UTC(2000, parseKey(k).m - 1, 1)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short' });
  return days.length === 1 ? `${mon(days[0])} ${d(days[0])}` : `${mon(days[0])} ${d(days[0])}-${mon(days.at(-1)) === mon(days[0]) ? '' : `${mon(days.at(-1))} `}${d(days.at(-1))}`;
};
const nDays = (n) => `${n} day${n === 1 ? '' : 's'}`;
// "Sep 1-25" for days on the old Clover account, else "not read yet" with how many days
function whyNotRead(days, what) {
  const old = days.filter((k) => k <= OLD_CLOVER_TO);
  const rest = days.filter((k) => !old.includes(k));
  const out = [];
  if (old.length) out.push(`${fmtDays(old)} ${what === 'website' ? "came before Clover's own account had a full copy of website orders" : "were rung up on Clover's old account, which isn't read again"}`);
  if (rest.length) out.push(`${nDays(rest.length)} not read yet: click Update add-on on the store computer, then wait for the numbers to fill in`);
  return out.join('. ');
}

// The same record the dashboard uses: website and app from Owner, or Clover's copy when Owner wasn't reachable.
function recOf(data, key, ch) {
  if (ch === 'owner') {
    const own = data[`d:${key}:owner`];
    if (own) return own;
    const viaClover = data[`d:${key}:owner_clover`];
    return viaClover ? { ...viaClover, viaClover: true } : null;
  }
  return data[`d:${key}:${ch}`] || null;
}
// discounts: the DoorDash / Uber Eats item report (i:<day>:<app>, on the add-on) or the day's own extra
// (the phone page gets it merged into extra, see trimDay in phone-sync.js)
const discountsOf = (data, key, ch, r) => data[`i:${key}:${ch}`]?.discounts || r.extra?.discounts || 0;
const hadSales = (r) => (r?.sales || 0) !== 0 || (r?.orders || 0) !== 0;

// One channel over the given days.
function channelRow(data, days, c, who) {
  const name = c.name;
  const row = { id: c.id, name: c.name, note: c.note || '', orders: 0, sales: 0, haveDays: 0, missingDays: [], viaCloverDays: [], notes: [] };
  const tax = part(), tips = part(), kept = part(), disc = part();
  let cardTaxKnown = 0, cardTaxDays = 0, cloverOrders = 0, cloverDays = 0;
  for (const k of days) {
    const r = recOf(data, k, c.id);
    if (!r) { row.missingDays.push(k); continue; }
    row.haveDays += 1;
    row.sales += r.sales || 0;
    row.orders += r.orders || 0;
    if (r.viaClover) row.viaCloverDays.push(k);
    const x = r.extra || {};
    if (c.id === 'instore') {
      if (num(x.tax)) tax.cents += x.tax;
      else if (!hadSales(r)) { /* nothing sold, nothing to tax */ } else {
        tax.miss.push(k);
        // card payments' tax can be worked out on older days: charged on cards less tips less card sales
        // (exact when no cash payment had a tip; shown as a hint only, never added to the totals)
        if (num(x.cardCharged) && num(x.card)) { cardTaxKnown += x.cardCharged - (x.tips || 0) - x.card; cardTaxDays += 1; }
      }
      if (num(x.tips)) tips.cents += x.tips;
      else if (hadSales(r)) tips.miss.push(k);
      // discounts given in the store aren't stored
      disc.miss.push(k);
    } else if (c.id === 'owner') {
      // tax and tips as Clover recorded them on its copy of the website and app orders (External Payment)
      const cl = data[`d:${k}:owner_clover`];
      if (cl) { cloverOrders += cl.orders || 0; cloverDays += 1; }
      const cx = cl?.extra || {};
      if (num(cx.tax)) tax.cents += cx.tax;
      else if (hadSales(r) || hadSales(cl)) tax.miss.push(k);
      if (num(cx.tips)) tips.cents += cx.tips;
      else if (hadSales(r) || hadSales(cl)) tips.miss.push(k);
      disc.cents += discountsOf(data, k, c.id, r);
      // what comes off: Owner's own card fee on each order (Owner charges no commission)
      if (num(x.cardFee)) kept.cents += x.cardFee;
      else if (hadSales(r)) kept.miss.push(k);
    } else {
      // the apps: their tax and tips aren't read from their reports (yet)
      if (hadSales(r)) { tax.miss.push(k); tips.miss.push(k); }
      disc.cents += discountsOf(data, k, c.id, r);
      // what the app kept: the sales its payout covers less the payout (commission, fees, promotions, ads)
      if (num(x.payout) && num(x.paidSales)) {
        kept.cents += x.paidSales - x.payout;
        if (x.paidSales !== (r.sales || 0)) row.notes.push(`${fmtDays([k])}: ${name}'s payout covers $${(x.paidSales / 100).toFixed(2)} of $${((r.sales || 0) / 100).toFixed(2)} sales`);
      } else if (hadSales(r)) kept.miss.push(k);
    }
  }
  if (c.id === 'instore') {
    row.tax = close(tax, (d) => whyNotRead(d, 'instore'));
    if (row.tax.cents == null && cardTaxDays) row.tax.cardHint = { cents: cardTaxKnown, days: cardTaxDays };
    row.tips = close(tips, (d) => `${nDays(d.length)} without tips stored`);
    row.discounts = { cents: null, why: "In-store discounts aren't stored. Sales are already after discounts." };
    row.kept = { cents: null, none: true, why: 'No app. Card fees are on the Sales tab.' };
  } else if (c.id === 'owner') {
    row.tax = close(tax, (d) => `${whyNotRead(d, 'website')}. This tax is read from Clover's copy of these orders`);
    if (row.tax.cents != null) row.tax.from = "From Clover's copy of these orders";
    row.tips = close(tips, (d) => whyNotRead(d, 'website'));
    row.discounts = { cents: disc.cents, from: 'Coupons and rewards. Sales are already after them.' };
    row.kept = close(kept, (d) => `${nDays(d.length)} without Owner's card fee stored`);
    if (row.kept.cents != null) row.kept.what = "Card fees (Owner's own number). No commission.";
    if (cloverDays && cloverOrders !== row.orders) row.notes.push(`Clover's copy has ${cloverOrders} orders, Owner has ${row.orders}, so the tax may not match exactly`);
    if (row.viaCloverDays.length) row.notes.push(`${fmtDays(row.viaCloverDays)}: Owner wasn't reachable, sales from Clover's copy`);
  } else {
    row.tax = close(tax, () => `Not read yet: the add-on doesn't read the tax from ${name}'s own report`);
    row.tips = close(tips, () => `Not stored: the add-on doesn't read tips from ${name}`);
    row.discounts = c.id === 'uber' ? { cents: null, why: "Uber Eats discounts aren't stored" }
      : { cents: disc.cents, from: 'Promotions you ran there. Sales are before them.' };
    row.kept = close(kept, (d) => `${nDays(d.length)} without ${name}'s payout`);
    if (row.kept.cents != null) row.kept.what = 'Commission, fees, promotions and ads (sales less what it paid you)';
  }
  const w = who?.[c.id] || {};
  row.who = { who: w.who || 'Not known', confirmed: w.status === 'confirmed', you: w.who === 'You' };
  return row;
}

// Totals and the numbers for the state return. days = the store days to add up.
export function taxDays(data, days, who) {
  const rows = TAX_CHANNELS.map((c) => channelRow(data, days, c, who));
  const sum = (f) => rows.reduce((a, r) => a + (r[f] || 0), 0);
  const sumOf = (f) => {
    const miss = rows.filter((r) => r[f].cents == null && !r[f].none);
    return miss.length ? { cents: null, known: rows.reduce((a, r) => a + (r[f].cents ?? 0), 0), missing: miss.map((r) => r.name) }
      : { cents: rows.reduce((a, r) => a + (r[f].cents ?? 0), 0) };
  };
  const total = { orders: sum('orders'), sales: sum('sales'), discounts: sumOf('discounts'), tax: sumOf('tax'), tips: sumOf('tips'), kept: sumOf('kept') };
  // instore discounts are never stored, so the total of discounts lists what is known
  total.discounts = { cents: null, known: rows.reduce((a, r) => a + (r.discounts.cents ?? 0), 0), missing: ['In-store'] };
  const yours = rows.filter((r) => r.who.you);
  const apps = rows.filter((r) => !r.who.you);
  const storeTaxMiss = yours.filter((r) => r.tax.cents == null);
  const state = {
    totalSales: total.sales,
    appSales: apps.reduce((a, r) => a + r.sales, 0),
    appNames: apps.map((r) => r.name),
    appsConfirmed: apps.every((r) => r.who.confirmed),
    yourSales: yours.reduce((a, r) => a + r.sales, 0),
    yourNames: yours.map((r) => r.name),
    storeTax: storeTaxMiss.length ? null : yours.reduce((a, r) => a + r.tax.cents, 0),
    storeTaxMissing: storeTaxMiss.map((r) => r.name),
    storeTaxConfirmed: yours.every((r) => r.who.confirmed),
  };
  const missingDays = [...new Set(rows.flatMap((r) => r.missingDays))].sort();
  return { rows, total, state, missingDays };
}

export function taxMonth(data, month, who) {
  const days = monthDays(month);
  return { month, label: monthLabel(month), days, ...taxDays(data, days, who) };
}

// ---------- the CSV download ----------
const dollars = (c) => (c == null ? '' : (c < 0 ? '-' : '') + (Math.abs(c) / 100).toFixed(2));
const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const line = (a) => a.map(cell).join(',');
const shown = (f) => (f.cents == null ? (f.none ? 'none' : 'not available yet') : '');

export function taxCsv(t, data) {
  const out = [];
  out.push(line([`Can Am Pizza Lakewood: sales tax numbers for ${t.label}`]));
  out.push(line(['All amounts in dollars. Sales are before tax and tips. Days are Pacific time.']));
  out.push(line(['Check these with your accountant before filing.']));
  out.push('');
  out.push(line(['Channel', 'Orders', 'Sales before fees', 'Discounts', 'Sales tax collected', 'Tips (not sales)', 'Fees the app kept', 'Who sends the sales tax', 'Confirmed?', 'Notes']));
  for (const r of t.rows) {
    const notes = [r.tax.why, r.tax.from, r.discounts.why, r.tips.why, r.kept.what, r.kept.why, ...r.notes].filter(Boolean).join(' | ');
    const appTips = r.id !== 'instore' && r.id !== 'owner';
    out.push(line([r.name, r.orders, dollars(r.sales), dollars(r.discounts.cents) || 'not stored', dollars(r.tax.cents) || shown(r.tax),
      dollars(r.tips.cents) || (appTips ? 'not stored' : shown(r.tips)), dollars(r.kept.cents) || shown(r.kept), r.who.who, r.who.confirmed ? 'yes' : 'not confirmed', notes]));
  }
  const T = t.total;
  out.push(line(['Total', T.orders, dollars(T.sales), '', dollars(T.tax.cents) || 'not available yet', dollars(T.tips.cents) || 'not available yet', '', '', '', '']));
  out.push('');
  const S = t.state;
  out.push(line(['Numbers for the state return']));
  out.push(line(['Total sales, all channels', dollars(S.totalSales)]));
  out.push(line([`Sales the apps already handled tax on (${S.appNames.join(', ')})`, dollars(S.appSales), S.appsConfirmed ? '' : 'not confirmed']));
  out.push(line([`Sales tax the store itself collected (${S.yourNames.join(', ')})`, S.storeTax == null ? 'not available yet' : dollars(S.storeTax), S.storeTaxConfirmed ? '' : 'not confirmed']));
  out.push('');
  out.push(line(['Day by day']));
  out.push(line(['Day', 'Channel', 'Orders', 'Sales', 'Sales tax', 'Tips']));
  for (const k of t.days) {
    for (const c of TAX_CHANNELS) {
      const one = channelRow(data, [k], c, null);
      if (!one.haveDays) continue;
      out.push(line([k, c.name, one.orders, dollars(one.sales), dollars(one.tax.cents), dollars(one.tips.cents)]));
    }
  }
  out.push('');
  out.push(line(['Recent days can still change. File from a month that has ended.']));
  return out.join('\r\n') + '\r\n';
}
