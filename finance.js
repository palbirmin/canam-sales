// Finances tab of the phone page (version 1.12.0, owner only): what the store spends next to what it
// sells, in plain terms. Sales come from the same days the Sales tab uses (sales_days, before tax and
// tips); expenses come from the four tables in supabase_finance.sql (or sample data until that has run).
// Delivery-app commissions are worked out from the payouts the add-on already reads (sales minus "You get").
// Card-processing fees (version 1.13.0) are estimated the same way the Sales tab does (cardFeeOfDay in lib.js,
// rates in config.js), and Owner gives its own fee per website & app order. From version 1.13.1 a month's in-store
// card fee is the processor's own charge from the bank statement once that is imported (taken early the next month).
import { todayKey, cardFeeOfDay } from './lib.js';
import { CONFIG } from './config.js';
import { openFinanceData, addDaysKey, addMonths } from './finance-data.js';
import { parseCSV, findHeader, detectColumns, columnsOk, statementItems, guessOutSign, guessVendor, SALES_DEPOSIT, ruleMatches } from './finance-csv.js';

export const FINANCE_VERSION = '1.17.0';

// ---------- formatting ----------
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const P = (k) => { const [y, m, d] = k.split('-').map(Number); return { y, m, d }; };
const md = (k) => { const { m, d } = P(k); return `${MON[m - 1]} ${d}`; };
const mdy = (k) => { const { y, m, d } = P(k); return `${MON[m - 1]} ${d}, ${y}`; };
const monYear = (k) => { const { y, m } = P(k); return `${MON[m - 1]} ${y}`; };
const dow = (k) => { const { y, m, d } = P(k); return DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]; };
const monthStart = (k) => `${k.slice(0, 7)}-01`;
const monthEnd = (k) => addDaysKey(addMonths(monthStart(k), 1), -1);
const daysBetween = (a, b) => { const x = P(a), y = P(b); return Math.round((Date.UTC(y.y, y.m - 1, y.d) - Date.UTC(x.y, x.m - 1, x.d)) / 864e5); };
const minK = (a, b) => (a < b ? a : b);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c, sign = false) => `${c < 0 ? '−' : sign && c > 0 ? '+' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const money0 = (c) => `${c < 0 ? '−' : ''}$${Math.round(Math.abs(c) / 100).toLocaleString('en-US')}`;
const moneyAxis = (c) => { const d = Math.abs(c) / 100; return `${c < 0 ? '−' : ''}$${d >= 1000 ? `${(Math.round(d / 100) / 10).toFixed(1).replace(/\.0$/, '')}K` : Math.round(d)}`; };
const pct = (a, b, digits = 1) => (b ? `${(Math.round((a / b) * 100 * 10 ** digits) / 10 ** digits).toFixed(digits)}%` : '—');
const pct0 = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const dollarsIn = (s) => { const n = parseFloat(String(s).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : null; };
const plural = (n, w, ws = `${w}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? w : ws}`;

// ---------- spending groups (from each category's kind) ----------
// fixed: shown under Fixed in Budgets; excluded: paid out, but not a cost of running the store
// (sales tax is collected from customers and passed on; the owner draw is the owner's pay from profit; and,
// version 1.13.1, Business Purchase & Setup: buying the store and the one-time money around it).
const KIND = {
  cogs: { group: 'Food & supplies', color: '#e0a21a' },
  labor: { group: 'Labor', color: '#2f7ed8' },
  occupancy: { group: 'Rent & utilities', color: '#1f9d55', fixed: true },
  platform: { group: 'App & card fees', color: '#e0679a' },
  marketing: { group: 'Marketing', color: '#8b5cf6' },
  admin: { group: 'Insurance & admin', color: '#0f9b9a', fixed: true },
  debt: { group: 'Loans', color: '#64748b', fixed: true },
  other: { group: 'Other', color: '#a39e96' },
  tax: { group: 'Sales tax', color: '#94a3b8', excluded: true },
  owner: { group: 'Owner & one-time', color: '#b58ce6', excluded: true },
  none: { group: 'Uncategorized', color: 'var(--fin-accent)' },
};
const KIND_ORDER = ['cogs', 'labor', 'occupancy', 'platform', 'marketing', 'admin', 'debt', 'other', 'none'];
const kindOf = (cat) => (cat ? cat.kind : 'none');
const FIXED_NAMES = /rent|insurance|loan|software|subscription|licen|utilit/i;
// kind 'owner' categories other than Owner Draw (version 1.13.1): one-time money, kept out of Cash left too
const SETUP_NAMES = /business purchase|setup|one[- ]time/i;
const isSetup = (cat) => !!cat && cat.kind === 'owner' && SETUP_NAMES.test(cat.name);
// The in-store card processor's monthly charge on the bank statement (version 1.13.1): Merchant Bankcard takes the
// previous calendar month's card fees early in the month as three ACH rows (INTERCHNG, FEE, DISCOUNT).
const PROCESSOR_ROW = /MERCH BNKCD.*\b(INTERCHNG|FEE|DISCOUNT)\b/i;
const isFixed = (cat) => (cat ? (FIXED_NAMES.test(cat.name) || !!KIND[cat.kind]?.fixed) : false);

// Sales channels, the same as the Sales tab (website & app falls back to Clover's "External Payment" orders).
const CHANNELS = [['instore', 'In-store'], ['doordash', 'DoorDash'], ['uber', 'Uber Eats'], ['grubhub', 'Grubhub'], ['owner', 'Website & app'], ['other', 'Other apps']];
const CH_COLOR = { instore: '#2a78d6', doordash: '#eb6834', uber: '#1baf7a', grubhub: '#e87ba4', owner: '#eda100', other: '#8f8a80', short: '#d03b3b' };
const APPS = [['doordash', 'DoorDash'], ['uber', 'Uber Eats'], ['grubhub', 'Grubhub']];

const ICON = {
  overview: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>',
  transactions: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  spending: '<path d="M12 3a9 9 0 1 0 9 9h-9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>',
  cashflow: '<path d="M7 20V5M3 9l4-4 4 4M17 4v15M13 15l4 4 4-4"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  budgets: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
  recurring: '<path d="M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5"/>',
  import: '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M4 14v6h16v-6"/>',
  rules: '<path d="M4 6h16M7 12h10M10 18h4"/>',
  accounts: '<path d="M3 10l9-6 9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/>',
  left: '<path d="M15 5l-7 7 7 7"/>', right: '<path d="M9 5l7 7-7 7"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};
const icon = (n, s = 18) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON[n]}</svg>`;

const VIEWS = {
  overview: { title: 'Overview', period: true },
  transactions: { title: 'Transactions', period: true },
  spending: { title: 'Spending', period: true },
  cashflow: { title: 'Cash flow', period: true },
  budgets: { title: 'Budgets', period: true, more: true },
  recurring: { title: 'Recurring bills', more: true },
  import: { title: 'Import a statement', more: true },
  rules: { title: 'Rules', more: true },
  accounts: { title: 'Accounts', more: true },
  more: { title: 'More' },
};
const NAV = [['overview', 'Overview'], ['transactions', 'Transactions'], ['spending', 'Spending'], ['cashflow', 'Cash flow'],
  ['budgets', 'Budgets'], ['recurring', 'Recurring bills'], ['import', 'Import'], ['rules', 'Rules'], ['accounts', 'Accounts'], ['more', 'More']];

// ====================================================================================================
export function initFinance({ store, supa, demo = false, fixtureUrl = 'fixtures/finance-demo.json' }) {
  const $ = (id) => document.getElementById(id);
  const root = $('finance');
  const tabBtn = $('finTabBtn');
  if (!root || !tabBtn) return;
  tabBtn.hidden = false;

  let fin = null; // the data (finance-data.js)
  let loadError = '';
  let loading = null;
  let all = {}; // the store's days (same as the Sales tab)
  let active = false;
  let view = 'overview';
  try { view = localStorage.getItem('canam.finView') || 'overview'; } catch { /* private mode */ }
  if (!VIEWS[view]) view = 'overview';

  const ui = {
    txFilter: 'all', txSearch: '', txCat: '', txSel: new Set(), txLimit: 200,
    spendBy: 'categories', spendPick: null, flowMode: 'sankey', openGroups: new Set(),
    imp: null, impResult: null, impAccount: '', ruleDraft: { matchText: '', vendor: '', categoryId: '' },
  };

  // ---------- the period every number on the page is for ----------
  const T = () => todayKey();
  let period = { kind: 'this', from: monthStart(T()), to: monthEnd(T()) };
  function setPeriod(kind, from, to) {
    const t = T();
    if (kind === 'this') period = { kind, from: monthStart(t), to: monthEnd(t) };
    else if (kind === 'last') { const f = addMonths(monthStart(t), -1); period = { kind, from: f, to: monthEnd(f) }; }
    else if (kind === '3m') period = { kind, from: addMonths(monthStart(t), -2), to: monthEnd(t) };
    else if (kind === 'ytd') period = { kind, from: `${t.slice(0, 4)}-01-01`, to: monthEnd(t) };
    else if (kind === 'month') period = { kind, from: monthStart(from), to: monthEnd(from) };
    else period = { kind: 'custom', from, to: to < from ? from : to };
  }
  const monthsIn = (p) => (P(p.to).y - P(p.from).y) * 12 + P(p.to).m - P(p.from).m + 1;
  function shiftPeriod(dir) {
    const p = period;
    if (p.kind === 'custom') {
      const len = daysBetween(p.from, p.to) + 1;
      period = { kind: 'custom', from: addDaysKey(p.from, dir * len), to: addDaysKey(p.to, dir * len) };
      return;
    }
    const n = p.kind === 'ytd' ? 12 : monthsIn(p);
    const from = addMonths(p.from, dir * n);
    const to = p.kind === 'ytd' ? addDaysKey(addMonths(`${from.slice(0, 4)}-01-01`, 12), -1) : monthEnd(addMonths(p.to, dir * n));
    const t = T();
    // back on a "this month"-type period when the arrows come back to today
    if (n === 1 && from === monthStart(t)) return setPeriod('this');
    if (n === 1 && from === addMonths(monthStart(t), -1)) return setPeriod('last');
    period = { kind: n === 1 ? 'month' : p.kind === 'ytd' ? 'year' : p.kind, from, to };
    if (p.kind === 'year' && from.slice(0, 4) === t.slice(0, 4)) setPeriod('ytd');
  }
  const periodEnd = () => minK(period.to, T());
  function periodLabel(p = period) {
    const a = P(p.from), b = P(p.to);
    if (p.kind === 'custom') return a.y === b.y ? `${md(p.from)} – ${mdy(p.to)}` : `${mdy(p.from)} – ${mdy(p.to)}`;
    if (p.kind === 'year') return `${a.y}`;
    if (p.from.slice(0, 7) === p.to.slice(0, 7)) return monYear(p.from);
    return a.y === b.y ? `${MON[a.m - 1]} – ${MON[b.m - 1]} ${b.y}` : `${monYear(p.from)} – ${monYear(p.to)}`;
  }
  // "Oct 1–26" when the period is still going, else the label
  function periodShort(from = period.from, end = periodEnd(), to = period.to) {
    if (end < to && from.slice(0, 7) === end.slice(0, 7)) return `${md(from)}–${P(end).d}`;
    if (end < to) return `${md(from)} – ${md(end)}`;
    return periodLabel({ ...period, from, to });
  }
  // The period before, the same length. While this one is still going, only as many days as so far.
  function previous() {
    const end = periodEnd();
    const span = daysBetween(period.from, end);
    let from;
    if (period.kind === 'custom') from = addDaysKey(period.from, -(daysBetween(period.from, period.to) + 1));
    else from = addMonths(period.from, -(period.kind === 'ytd' || period.kind === 'year' ? 12 : monthsIn(period)));
    const to = period.kind === 'custom' ? addDaysKey(period.from, -1) : addDaysKey(period.from, -1);
    const pEnd = minK(addDaysKey(from, span), to);
    return { from, end: pEnd, to, partial: end < period.to };
  }

  // ---------- sales (the Sales tab's own days) ----------
  let salesDays = null;
  let rateCache = null;
  function salesMap() {
    if (salesDays) return salesDays;
    salesDays = new Map();
    for (const k of Object.keys(all)) {
      const m = /^d:(\d{4}-\d{2}-\d{2}):/.exec(k);
      if (!m || salesDays.has(m[1])) continue;
      const day = m[1];
      const s = { total: 0, ch: {}, card: 0, cash: 0, ownerClover: 0, have: !!(all[`d:${day}:instore`] || all[`d:${day}:doordash`]) };
      for (const [id] of CHANNELS) {
        const own = all[`d:${day}:${id}`];
        const r = own || (id === 'owner' ? all[`d:${day}:owner_clover`] : null);
        const v = r?.sales || 0;
        if (id === 'owner' && !own && r) s.ownerClover = v;
        s.ch[id] = v;
        s.total += v;
        if (id === 'instore' && r) { s.card += r.extra?.card || 0; s.cash += r.extra?.cash || 0; }
      }
      salesDays.set(day, s);
    }
    return salesDays;
  }
  // The share of sales an app paid out over the last 30 days (for orders its report doesn't have yet).
  function appRate(id) {
    rateCache ||= {};
    if (id in rateCache) return rateCache[id];
    let pay = 0, paid = 0;
    for (let i = 0; i < 30; i++) {
      const x = all[`d:${addDaysKey(T(), -i)}:${id}`]?.extra;
      if (x?.payout == null || !(x.paidSales > 0)) continue;
      pay += x.payout;
      paid += x.paidSales;
    }
    return (rateCache[id] = paid > 0 ? pay / paid : null);
  }
  // Delivery-app fees: sales minus "You get", from each app's payout report (≈ for orders not in it yet).
  function appFees(from, end) {
    const apps = [];
    let total = 0, approx = false, unknown = false;
    for (const [id, name] of APPS) {
      let sales = 0, paid = 0, pay = 0;
      for (let k = from; k <= end; k = addDaysKey(k, 1)) {
        const r = all[`d:${k}:${id}`];
        if (!r) continue;
        sales += r.sales || 0;
        if (r.extra?.payout != null) { paid += r.extra.paidSales || 0; pay += r.extra.payout; }
      }
      if (!sales && !pay) continue;
      const pending = Math.max(0, sales - paid);
      let fees = paid - pay;
      if (pending > 0) {
        const rate = appRate(id) ?? (paid > 0 ? pay / paid : null);
        if (rate == null) unknown = true; else fees += Math.round(pending * (1 - rate));
      }
      apps.push({ id, name, sales, get: sales - fees, fees, approx: pending > 0 });
      total += fees;
      approx ||= pending > 0;
    }
    return { total, apps, approx, unknown };
  }

  // Card-processing fees (version 1.13.0): in-store (Clover, estimated at the rate in config.js) and
  // website & app (Owner's own fee per order; estimated on days Owner wasn't reachable). Version 1.13.1: a month
  // whose processor rows are on an imported statement uses those instead of the estimate (withBankFee below).
  const CARD = [['instore', 'In-store (Clover)'], ['owner', 'Website & app (Owner)']];
  const cardRec = (k, id) => all[`d:${k}:${id}`] || (id === 'owner' ? all[`d:${k}:owner_clover`] : null) || null;
  function cardFees(from, end) {
    const parts = [];
    let total = 0, approx = false;
    for (const [id, name] of CARD) {
      let sales = 0, fees = 0, est = false;
      for (let k = from; k <= end; k = addDaysKey(k, 1)) {
        const r = cardRec(k, id);
        if (!r) continue;
        const f = cardFeeOfDay(id, r, CONFIG.cardFees);
        sales += r.sales || 0;
        fees += f.fee;
        est ||= !!(f.fee && f.est);
      }
      if (!sales && !fees) continue;
      parts.push({ id, name, sales, fees, approx: est });
      total += fees;
      approx ||= est;
    }
    return { total, parts, approx };
  }
  // For a whole month taken from its saved totals (no card-fee column there): the share of sales card fees
  // took over the last 30 days the dashboard has.
  let cardRateCache = null;
  function cardRate(id) {
    cardRateCache ||= {};
    if (id in cardRateCache) return cardRateCache[id];
    let sales = 0, fees = 0;
    for (let i = 0; i < 30; i++) {
      const r = cardRec(addDaysKey(T(), -i), id);
      if (!r || !(r.sales > 0)) continue;
      sales += r.sales;
      fees += cardFeeOfDay(id, r, CONFIG.cardFees).fee;
    }
    return (cardRateCache[id] = sales > 0 ? fees / sales : 0);
  }
  function addCard(into, f) {
    for (const a of f.parts) {
      const x = into.parts.find((y) => y.id === a.id);
      if (x) { x.sales += a.sales; x.fees += a.fees; x.bankFees += a.bankFees || 0; x.approx ||= a.approx; } else into.parts.push({ bankFees: 0, ...a });
    }
    into.total += f.total; into.approx ||= f.approx;
  }
  // The processor's rows on the bank statement (filed under Card Processing Fees), by the month they pay for
  // (the month before the one they're dated in). Version 1.13.1.
  const isProcessorRow = (t, cc) => !!cc && t.categoryId === cc.id && PROCESSOR_ROW.test(t.description || '');
  function bankCardFees() {
    const cc = cardCat(), map = new Map();
    if (!cc) return map;
    for (const t of fin.txns) if (isProcessorRow(t, cc)) {
      const mk = addMonths(monthStart(t.date), -1);
      map.set(mk, (map.get(mk) || 0) + t.amount);
    }
    return map;
  }
  // Card fees f for days a..b of month mk, with the in-store part replaced by the bank's charge for that month
  // when the statement for it has been imported (part of the month: its share of the month's in-store card sales).
  function withBankFee(f, mk, a, b, bank = bankCardFees()) {
    if (!bank.has(mk)) return f;
    let share = 1;
    if (a !== mk || b !== monthEnd(mk)) {
      let part = 0, whole = 0;
      for (let k = mk; k <= monthEnd(mk); k = addDaysKey(k, 1)) {
        const s = cardRec(k, 'instore')?.sales || 0;
        whole += s;
        if (k >= a && k <= b) part += s;
      }
      share = whole > 0 ? part / whole : (daysBetween(a, b) + 1) / daysIn(mk);
    }
    const fee = Math.round(bank.get(mk) * share);
    const old = f.parts.find((p) => p.id === 'instore');
    const parts = f.parts.filter((p) => p.id !== 'instore');
    if (old || fee) parts.unshift({ id: 'instore', name: CARD[0][1], sales: old?.sales || 0, fees: fee, bankFees: fee, approx: false });
    return { total: parts.reduce((t, p) => t + p.fees, 0), parts, approx: parts.some((p) => p.approx) };
  }

  // ---------- one period's numbers ----------
  const feesCat = () => fin.catByName('Delivery App Fees') || fin.cats.find((c) => c.kind === 'platform') || null;
  const cardCat = () => fin.catByName('Card Processing Fees') || null;
  // A month's saved totals (sales_months), used when sales_days no longer has every day of it.
  const monthRow = (mk) => fin.salesMonths.find((r) => r.month === mk) || null;
  const daysIn = (mk) => daysBetween(mk, monthEnd(mk)) + 1;
  function addFees(into, f) {
    for (const a of f.apps) {
      const x = into.apps.find((y) => y.id === a.id);
      if (x) { x.sales += a.sales; x.get += a.get; x.fees += a.fees; x.approx ||= a.approx; } else into.apps.push({ ...a });
    }
    into.total += f.total; into.approx ||= f.approx; into.unknown ||= f.unknown;
  }
  // Sales (and delivery-app fees) for some days: from sales_days, or for a whole month that sales_days no
  // longer has every day of, from that month's saved row.
  function salesPart(from, end, m) {
    const S = salesMap();
    for (let mk = monthStart(from); mk <= end; mk = addMonths(mk, 1)) {
      const a = from > mk ? from : mk, b = minK(end, monthEnd(mk));
      const row = monthRow(mk);
      let have = 0;
      for (let k = a; k <= b; k = addDaysKey(k, 1)) if (S.get(k)?.have) have++;
      if (a === mk && b === monthEnd(mk) && row?.complete && have < daysIn(mk)) {
        m.days += daysIn(mk);
        m.sales += row.total; m.card += row.instore_card; m.cash += row.instore_cash;
        for (const [id] of CHANNELS) m.ch[id] += row[id] || 0;
        const apps = APPS.map(([id, name]) => ({ id, name, sales: row[id] || 0, fees: row[`${id}_fees`] || 0 }))
          .filter((x) => x.sales || x.fees).map((x) => ({ ...x, get: x.sales - x.fees, approx: false }));
        addFees(m.fees, { total: apps.reduce((t, x) => t + x.fees, 0), apps, approx: false, unknown: false });
        const parts = CARD.map(([id, name]) => ({ id, name, sales: row[id] || 0, fees: Math.round((row[id] || 0) * cardRate(id)), approx: true }))
          .filter((x) => x.fees);
        addCard(m.cardFees, withBankFee({ total: parts.reduce((t, x) => t + x.fees, 0), parts, approx: parts.length > 0 }, mk, mk, monthEnd(mk)));
        m.fromMonths.push(mk);
        continue;
      }
      for (let k = a; k <= b; k = addDaysKey(k, 1)) {
        m.days++;
        const s = S.get(k);
        if (!s?.have) { m.missing++; if (!s) continue; }
        m.sales += s.total; m.card += s.card; m.cash += s.cash;
        for (const [id] of CHANNELS) m.ch[id] += s.ch[id];
      }
      addFees(m.fees, appFees(a, b));
      addCard(m.cardFees, withBankFee(cardFees(a, b), mk, a, b));
    }
  }
  // THE numbers for a period. Every page shows these, so Expenses and Net profit are the same everywhere:
  //   operatingExpenses = every expense except Sales Tax, Owner Draw and Business Purchase & Setup, plus the
  //   delivery-app fees and the card-processing fees (estimated, or the in-store processor's charge from the bank,
  //   counted in the month it pays for, not the month it's dated in)
  //   net = sales − operatingExpenses;  cashLeft = net − salesTax − ownerDraw
  //   setup (business purchase & setup) is one-time money: in neither, shown on its own line
  function sums(from, end) {
    const m = { from, end, sales: 0, ch: {}, card: 0, cash: 0, days: 0, missing: 0, fromMonths: [], rows: [], byCat: new Map(), rowsExp: 0, prime: 0, tax: 0, owner: 0, uncategorized: 0, feeRows: 0,
      fees: { total: 0, apps: [], approx: false, unknown: false }, cardFees: { total: 0, parts: [], approx: false }, cardFeeRows: 0, bankCardRows: 0, setup: 0 };
    for (const [id] of CHANNELS) m.ch[id] = 0;
    salesPart(from, end, m);
    const fc = feesCat();
    const cc = cardCat();
    for (const t of fin.txns) {
      if (t.date < from || t.date > end) continue;
      m.rows.push(t);
      const c = fin.cat(t.categoryId);
      const kind = kindOf(c);
      if (kind === 'tax') { m.tax += t.amount; continue; }
      if (kind === 'owner') { if (isSetup(c)) m.setup += t.amount; else m.owner += t.amount; continue; }
      // the processor's rows are counted as the month before's in-store card fee (salesPart), not here
      if (isProcessorRow(t, cc)) { m.bankCardRows += t.amount; continue; }
      m.rowsExp += t.amount;
      m.byCat.set(c ? c.id : '', (m.byCat.get(c ? c.id : '') || 0) + t.amount);
      if (kind === 'cogs' || kind === 'labor') m.prime += t.amount;
      if (!c) m.uncategorized++;
      if (fc && c?.id === fc.id) m.feeRows += t.amount;
      if (cc && c?.id === cc.id) m.cardFeeRows += t.amount;
    }
    m.appFees = m.fees.total;
    m.cardFee = m.cardFees.total;
    // in-store card fee from the bank for some of this period, or estimated for some of it
    m.cardFromBank = m.cardFees.parts.some((p) => p.id === 'instore' && p.bankFees);
    m.cardEstimated = m.cardFees.parts.some((p) => p.id === 'instore' && p.fees > (p.bankFees || 0));
    m.operatingExpenses = m.rowsExp + m.appFees + m.cardFee;
    m.salesTax = m.tax;
    m.ownerDraw = m.owner;
    m.net = m.sales - m.operatingExpenses;
    m.cashLeft = m.net - m.salesTax - m.ownerDraw;
    m.primePct = m.sales ? m.prime / m.sales : null;
    return m;
  }
  // The chosen period's numbers, worked out once per drawing of the page and shared by every view.
  let curCache = null;
  const cur = () => (curCache ||= sums(period.from, periodEnd()));
  // Category amounts, with the delivery-app fees from payout reports added to Delivery App Fees and the
  // card fees to Card Processing Fees. derived = 'payouts' | 'estimated' | 'bank' (in-store from the statement) for those two.
  function catRows(m) {
    const fc = feesCat(), cc = cardCat();
    const appId = fc ? fc.id : 'appfees', cardId = cc && cc.id !== appId ? cc.id : 'cardfees';
    const map = new Map(m.byCat);
    if (m.fees.total) map.set(appId, (map.get(appId) || 0) + m.fees.total);
    if (m.cardFee) map.set(cardId, (map.get(cardId) || 0) + m.cardFee);
    return [...map.entries()].map(([id, amount]) => {
      const c = fin.cat(id);
      const kind = id === 'appfees' || id === 'cardfees' ? 'platform' : kindOf(c);
      const name = c ? c.name : id === 'appfees' ? 'Delivery App Fees' : id === 'cardfees' ? 'Card Processing Fees' : 'Uncategorized';
      const derived = id === appId && m.fees.total ? 'payouts' : id === cardId && m.cardFee ? (m.cardFromBank && !m.cardEstimated ? 'bank' : 'estimated') : '';
      return { id, amount, kind, name, group: KIND[kind].group, color: KIND[kind].color, derived };
    }).filter((r) => r.amount !== 0).sort((a, b) => b.amount - a.amount);
  }
  // The small grey note after a category that has worked-out fees in it.
  const derivedNote = (r, full) => (r.derived === 'payouts' ? (full ? 'incl. app payouts' : 'from payouts')
    : r.derived === 'bank' ? (full ? 'in-store from bank statement' : 'from bank statement')
    : r.derived === 'estimated' ? (full ? 'incl. estimated card fees' : 'estimated') : '');
  // "incl. $X app fees + $Y card fees", under Expenses
  const feeSub = (m, word = 'app') => [m.appFees ? `${money0(m.appFees)} ${word} fees` : '', m.cardFee ? `${money0(m.cardFee)} card fees` : ''].filter(Boolean).join(' + ');
  function groupRows(m) {
    const map = new Map();
    for (const r of catRows(m)) {
      const g = map.get(r.kind) || { id: r.kind, kind: r.kind, name: r.group, color: r.color, amount: 0, cats: [] };
      g.amount += r.amount; g.cats.push(r);
      map.set(r.kind, g);
    }
    return [...map.values()].sort((a, b) => b.amount - a.amount);
  }
  function vendorRows(m) {
    const map = new Map();
    for (const t of m.rows) {
      const c = fin.cat(t.categoryId);
      if (KIND[kindOf(c)].excluded) continue;
      const name = t.vendor || guessVendor(t.description);
      const v = map.get(name.toLowerCase()) || { id: `v:${name.toLowerCase()}`, name, amount: 0, kind: kindOf(c) };
      v.amount += t.amount;
      map.set(name.toLowerCase(), v);
    }
    for (const a of m.fees.apps) map.set(`fees:${a.id}`, { id: `fees:${a.id}`, name: `${a.name} fees`, amount: a.fees, kind: 'platform' });
    for (const a of m.cardFees.parts) map.set(`card:${a.id}`, { id: `card:${a.id}`, name: `${a.name} card fees`, amount: a.fees, kind: 'platform' });
    return [...map.values()].map((v) => ({ ...v, group: KIND[v.kind].group, color: KIND[v.kind].color })).filter((v) => v.amount).sort((a, b) => b.amount - a.amount);
  }
  // Per day: net (sales − expenses) and spending, for the sparkline and the running total.
  function daily(from, end) {
    const S = salesMap();
    const exp = new Map();
    const cc = cardCat(), bank = bankCardFees();
    for (const t of fin.txns) {
      if (t.date < from || t.date > end || KIND[kindOf(fin.cat(t.categoryId))].excluded || isProcessorRow(t, cc)) continue;
      exp.set(t.date, (exp.get(t.date) || 0) + t.amount);
    }
    // whole months that sums() takes from their saved totals: spread evenly over their days, so the
    // running line ends on the same net profit as the big number
    const viaRow = new Set(sums(from, end).fromMonths);
    const out = [];
    for (let k = from; k <= end; k = addDaysKey(k, 1)) {
      const mk = monthStart(k), row = viaRow.has(mk) ? monthRow(mk) : null;
      const n = daysIn(mk);
      const fees = row ? (row.doordash_fees + row.uber_fees + row.grubhub_fees
          + CARD.reduce((a, [id]) => a + (id === 'instore' && bank.has(mk) ? bank.get(mk) : (row[id] || 0) * cardRate(id)), 0)) / n
        : appFees(k, k).total + withBankFee(cardFees(k, k), mk, k, k, bank).total;
      out.push({ k, sales: row ? row.total / n : S.get(k)?.total || 0, spend: (exp.get(k) || 0) + fees });
    }
    return out;
  }
  // Up to 12 months ending with the period's last month (months with nothing in them at the start are left out).
  function months(endKey = period.to, n = 12, filter = null) {
    const out = [];
    const t = T();
    for (let i = n - 1; i >= 0; i--) {
      const from = addMonths(monthStart(endKey), -i);
      if (from > t) continue;
      const end = minK(monthEnd(from), t);
      const m = sums(from, end);
      const spend = filter ? filterAmount(m, filter) : m.operatingExpenses;
      out.push({ from, label: MON[P(from).m - 1], sales: m.sales, exp: m.operatingExpenses, spend, partial: m.missing > 0 && m.missing < m.days, none: m.missing === m.days, rows: m.rows.length });
    }
    while (out.length > 1 && out[0].none && !out[0].rows) out.shift();
    return out;
  }
  function filterAmount(m, f) {
    if (f.by === 'groups') return groupRows(m).find((g) => g.id === f.id)?.amount || 0;
    if (f.by === 'vendors') return vendorRows(m).find((v) => v.id === f.id)?.amount || 0;
    return catRows(m).find((c) => c.id === f.id)?.amount || 0;
  }

  // ---------- recurring bills ----------
  // Every time a bill falls due between two days (bills roll forward when they're marked paid).
  function dueBetween(from, to) {
    const out = [];
    for (const b of fin.bills) {
      if (!b.active) continue;
      let d = b.nextDue, guard = 0;
      while (d <= to && guard++ < 60) {
        if (d >= from || d < T()) out.push({ bill: b, due: d });
        d = nextAfter(b, d);
      }
    }
    return out.sort((a, b) => (a.due < b.due ? -1 : 1));
  }
  function nextAfter(b, d) {
    if (b.frequency === 'weekly') return addDaysKey(d, 7);
    if (b.frequency === 'biweekly') return addDaysKey(d, 14);
    return addMonths(d, b.frequency === 'quarterly' ? 3 : b.frequency === 'yearly' ? 12 : 1, b.dayOfMonth || undefined);
  }
  const perMonth = (b) => Math.round(b.amount * ({ weekly: 52 / 12, biweekly: 26 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 }[b.frequency] || 1));
  function dueText(k) {
    const n = daysBetween(T(), k);
    if (n < 0) return `${md(k)} · ${plural(-n, 'day')} late`;
    if (n === 0) return `${md(k)} · today`;
    if (n === 1) return `${md(k)} · tomorrow`;
    return `${dow(k)}, ${md(k)} · in ${n} days`;
  }

  // ---------- review ----------
  function dupKeys(rows) {
    const seen = new Map();
    for (const t of rows) {
      const key = `${t.date}|${t.amount}|${(t.vendor || t.description).toLowerCase()}`;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    return new Set([...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k));
  }
  const isDup = (t, dups) => dups.has(`${t.date}|${t.amount}|${(t.vendor || t.description).toLowerCase()}`);
  const uncategorizedCount = () => fin ? fin.txns.filter((t) => !t.categoryId).length : 0;

  // ====================================================================================================
  // charts (inline SVG, drawn at the box's real width so the text stays readable on a phone)
  // ====================================================================================================
  function svgOpen(w, h, label) { return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}">`; }
  // the top of a chart: 4 even, round steps (so the axis reads $10K, $20K, ...)
  function niceMax(v) {
    if (v <= 0) return 400;
    const step = v / 4, p = 10 ** Math.floor(Math.log10(step));
    for (const s of [1, 2, 2.5, 5, 10]) if (s * p >= step) return s * p * 4;
    return 40 * p;
  }
  function sparkline(points, w, h) {
    if (points.length < 2) return '';
    const lo = Math.min(0, ...points), hi = Math.max(0, ...points);
    const y = (v) => h - 4 - ((v - lo) / (hi - lo || 1)) * (h - 8);
    const x = (i) => (i / (points.length - 1)) * (w - 4) + 2;
    const d = points.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const last = points[points.length - 1];
    const col = last >= 0 ? 'var(--fin-green)' : 'var(--fin-red)';
    return `${svgOpen(w, h, 'Running net profit by day')}<line x1="0" x2="${w}" y1="${y(0)}" y2="${y(0)}" style="stroke:var(--fin-grid);stroke-dasharray:3 3"/>`
      + `<path d="${d}L${x(points.length - 1)},${y(0)}L${x(0)},${y(0)}Z" style="fill:${col};opacity:.10"/>`
      + `<path d="${d}" style="fill:none;stroke:${col};stroke-width:2;stroke-linejoin:round"/>`
      + `<circle cx="${x(points.length - 1)}" cy="${y(last)}" r="3" style="fill:${col}"/></svg>`;
  }
  // paired bars per month: green sales, red expenses
  function cashBars(ms, w, h) {
    const padL = 44, padB = 22, padT = 8;
    const max = niceMax(Math.max(...ms.map((m) => Math.max(m.sales, m.exp)), 1));
    const ih = h - padB - padT, iw = w - padL - 4;
    const bw = Math.min(26, (iw / ms.length - 8) / 2);
    let s = svgOpen(w, h, 'Sales and expenses by month');
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i, y = padT + ih - (v / max) * ih;
      s += `<line x1="${padL}" x2="${w}" y1="${y}" y2="${y}" style="stroke:var(--fin-grid)"/><text x="${padL - 6}" y="${y + 4}" text-anchor="end" class="fin-ax">${moneyAxis(v)}</text>`;
    }
    ms.forEach((m, i) => {
      const cx = padL + (iw / ms.length) * (i + 0.5);
      const hs = (m.sales / max) * ih, he = (Math.max(0, m.exp) / max) * ih;
      s += `<rect x="${cx - bw - 1}" y="${padT + ih - hs}" width="${bw}" height="${hs}" rx="2" style="fill:var(--fin-green)${m.partial ? ';opacity:.55' : ''}"><title>${esc(monYear(m.from))} sales ${money(m.sales)}${m.partial ? ' (some days not kept)' : ''}</title></rect>`;
      s += `<rect x="${cx + 1}" y="${padT + ih - he}" width="${bw}" height="${he}" rx="2" style="fill:var(--fin-red)"><title>${esc(monYear(m.from))} expenses ${money(m.exp)}</title></rect>`;
      s += `<text x="${cx}" y="${h - 6}" text-anchor="middle" class="fin-ax">${m.label}${m.partial ? '*' : ''}</text>`;
    });
    return `${s}</svg>`;
  }
  // running total of spending by day: this period vs the one before
  function cumLines(cur, prev, w, h) {
    const padL = 44, padB = 22, padT = 8;
    const run = (a) => { let t = 0; return a.map((v) => (t += v)); };
    const A = run(cur), B = run(prev);
    const n = Math.max(A.length, B.length, 2);
    const max = niceMax(Math.max(...A, ...B, 1));
    const ih = h - padB - padT, iw = w - padL - 6;
    const x = (i) => padL + (i / (n - 1)) * iw, y = (v) => padT + ih - (v / max) * ih;
    const path = (a) => a.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    let s = svgOpen(w, h, 'Running total of spending, this period and the one before');
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i;
      s += `<line x1="${padL}" x2="${w}" y1="${y(v)}" y2="${y(v)}" style="stroke:var(--fin-grid)"/><text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end" class="fin-ax">${moneyAxis(v)}</text>`;
    }
    for (const i of [0, Math.round((n - 1) / 2), n - 1]) s += `<text x="${x(i)}" y="${h - 6}" text-anchor="middle" class="fin-ax">Day ${i + 1}</text>`;
    if (B.length > 1) s += `<path d="${path(B)}" style="fill:none;stroke:var(--fin-prev);stroke-width:2"/>`;
    if (A.length) s += `<path d="${path(A)}L${x(A.length - 1)},${y(0)}L${x(0)},${y(0)}Z" style="fill:var(--fin-line);opacity:.08"/><path d="${path(A)}" style="fill:none;stroke:var(--fin-line);stroke-width:2.2"/>`;
    return `${s}</svg>`;
  }
  function donut(segs, size, total) {
    const r = size / 2, th = Math.max(18, size * 0.14), ri = r - th;
    const sum = segs.reduce((a, s) => a + Math.max(0, s.value), 0) || 1;
    let a0 = -Math.PI / 2;
    let s = svgOpen(size, size, 'Spending by category');
    const pt = (a, rr) => `${(r + rr * Math.cos(a)).toFixed(2)},${(r + rr * Math.sin(a)).toFixed(2)}`;
    for (const g of segs) {
      if (g.value <= 0) continue;
      const a1 = a0 + (g.value / sum) * Math.PI * 2 - (segs.length > 1 ? 0.012 : 0);
      const big = a1 - a0 > Math.PI ? 1 : 0;
      if (g.value / sum > 0.9999) s += `<circle cx="${r}" cy="${r}" r="${r - th / 2}" style="fill:none;stroke:${g.color};stroke-width:${th}"/>`;
      else s += `<path d="M${pt(a0, r)}A${r},${r} 0 ${big} 1 ${pt(a1, r)}L${pt(a1, ri)}A${ri},${ri} 0 ${big} 0 ${pt(a0, ri)}Z" style="fill:${g.color}"><title>${esc(g.label)} ${money(g.value)}</title></path>`;
      a0 = a1 + (segs.length > 1 ? 0.012 : 0);
    }
    s += `<text x="${r}" y="${r - 6}" text-anchor="middle" class="fin-donut-l">Total</text><text x="${r}" y="${r + 18}" text-anchor="middle" class="fin-donut-v">${money0(total)}</text>`;
    return `${s}</svg>`;
  }
  function trendBars(ms, w, h, color) {
    const padL = 44, padB = 22, padT = 8;
    const max = niceMax(Math.max(...ms.map((m) => m.spend), 1));
    const ih = h - padB - padT, iw = w - padL - 4;
    const bw = Math.min(34, iw / ms.length - 10);
    let s = svgOpen(w, h, 'Spending by month');
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i, y = padT + ih - (v / max) * ih;
      s += `<line x1="${padL}" x2="${w}" y1="${y}" y2="${y}" style="stroke:var(--fin-grid)"/><text x="${padL - 6}" y="${y + 4}" text-anchor="end" class="fin-ax">${moneyAxis(v)}</text>`;
    }
    ms.forEach((m, i) => {
      const cx = padL + (iw / ms.length) * (i + 0.5), hh = (Math.max(0, m.spend) / max) * ih;
      s += `<rect x="${cx - bw / 2}" y="${padT + ih - hh}" width="${bw}" height="${hh}" rx="3" style="fill:${color}"><title>${esc(monYear(m.from))} ${money(m.spend)}</title></rect><text x="${cx}" y="${h - 6}" text-anchor="middle" class="fin-ax">${m.label}</text>`;
    });
    return `${s}</svg>`;
  }
  // Sankey: sales channels -> Sales -> Kept (profit, on top) and spending groups -> categories.
  // On a narrow screen the categories column is left out.
  function sankey(m, w) {
    const wide = w >= 640;
    const groups = groupRows(m).filter((g) => g.amount > 0);
    const kept = Math.max(0, m.net);
    const short = Math.max(0, -m.net);
    const src = CHANNELS.map(([id, name]) => ({ id, name, v: m.ch[id], color: CH_COLOR[id] })).filter((c) => c.v > 0);
    if (short) src.push({ id: 'short', name: 'Spent more than sales', v: short, color: CH_COLOR.short });
    const mid = src.reduce((a, c) => a + c.v, 0);
    if (mid <= 0) return '<p class="fin-empty">No sales or spending in this period yet.</p>';
    const right = [];
    if (kept) right.push({ id: 'kept', name: 'Kept (profit)', v: kept, color: 'var(--fin-green)' });
    // on a phone, the small groups go together so every band has a readable label
    const small = groups.filter((g) => g.amount / mid < (wide ? 0.025 : 0.04));
    for (const g of groups) if (!small.includes(g)) right.push({ id: g.id, name: g.name, v: g.amount, color: g.color, cats: g.cats.filter((c) => c.amount > 0) });
    if (small.length) right.push({ id: 'small', name: small.length === 1 ? small[0].name : `${small.length} smaller groups`, v: small.reduce((a, g) => a + g.amount, 0), color: '#a39e96' });
    const H = Math.max(320, (wide ? 16 : 9) * 22);
    const gap = 6;
    const cols = wide ? [0, 0.3, 0.6, 1] : [0, 0.45, 1];
    const nodeW = 9, labelW = wide ? 150 : 104;
    const x0 = wide ? 120 : 92, x1 = w - labelW;
    const X = (c) => x0 + (x1 - x0 - nodeW) * cols[c];
    const scale = (H - gap * Math.max(src.length, right.length)) / mid;
    let s = '';
    const band = (xa, ya, xb, yb, th, color) => {
      const mx = (xa + xb) / 2;
      return `<path d="M${xa},${ya}C${mx},${ya} ${mx},${yb} ${xb},${yb}L${xb},${yb + th}C${mx},${yb + th} ${mx},${ya + th} ${xa},${ya + th}Z" style="fill:${color};opacity:.28"/>`;
    };
    // labels never sit on top of each other: each is at least 25px below the one before it in its column
    const lastY = {};
    const label = (x, y, h, name, v, anchor) => {
      const cy = Math.max(y + h / 2, (lastY[x] ?? -99) + 25);
      lastY[x] = cy;
      return `<text x="${x}" y="${cy - 1}" text-anchor="${anchor}" class="fin-sk-n">${esc(name)}</text><text x="${x}" y="${cy + 11}" text-anchor="${anchor}" class="fin-sk-v">${money0(v)} (${pct(v, mid)})</text>`;
    };
    // left: channels
    let y = 10, ym = 10;
    for (const c of src) {
      const h = c.v * scale;
      s += band(X(0) + nodeW, y, X(1), ym, h, c.color);
      s += `<rect x="${X(0)}" y="${y}" width="${nodeW}" height="${Math.max(1, h)}" rx="2" style="fill:${c.color}"/>`;
      s += label(X(0) - 6, y, h, c.name, c.v, 'end');
      y += h + gap; ym += h;
    }
    const midH = mid * scale;
    s += `<rect x="${X(1)}" y="10" width="${nodeW}" height="${midH}" rx="2" style="fill:var(--fin-ink)"/>`;
    s += `<text x="${X(1) + nodeW / 2}" y="6" text-anchor="middle" class="fin-sk-n">Sales ${money0(m.sales)}</text>`;
    // right: kept + groups (+ categories)
    let yo = 10;
    y = 10;
    const gc = wide ? 2 : 2;
    for (const g of right) {
      const h = g.v * scale;
      s += band(X(1) + nodeW, yo, X(gc), y, h, g.color);
      s += `<rect x="${X(gc)}" y="${y}" width="${nodeW}" height="${Math.max(1, h)}" rx="2" style="fill:${g.color}"/>`;
      if (wide && g.cats) {
        let yc = y, ys = y;
        for (const c of g.cats) {
          const ch = c.amount * scale;
          s += band(X(2) + nodeW, ys, X(3), yc, ch, g.color);
          s += `<rect x="${X(3)}" y="${yc}" width="${nodeW}" height="${Math.max(1, ch)}" rx="2" style="fill:${g.color}"><title>${esc(c.name)} ${money(c.amount)}</title></rect>`;
          if (ch >= 11) s += `<text x="${X(3) + nodeW + 6}" y="${yc + ch / 2 + 4}" class="fin-sk-n">${esc(c.name)} <tspan class="fin-sk-v">${money0(c.amount)}</tspan></text>`;
          yc += ch; ys += ch;
        }
        s += label(X(2) - 6, y, h, g.name, g.v, 'end');
      } else s += label(X(gc) + nodeW + 6, y, h, g.name, g.v, 'start');
      y += h + gap; yo += h;
    }
    const tall = Math.ceil(Math.max(H + 20, ...Object.values(lastY).map((v) => v + 20)));
    return `${svgOpen(w, tall, 'Where the money went: sales on the left, what it paid for on the right')}${s}</svg>`;
  }

  // ====================================================================================================
  // views
  // ====================================================================================================
  const card = (title, body, extra = '', cls = '') => `<section class="fin-card ${cls}"><div class="fin-card-head"><h3>${title}</h3>${extra}</div>${body}</section>`;
  const tile = (label, value, sub, dot = '', cls = '', extra = '') => `<div class="fin-tile ${cls}"><div class="fin-tile-l">${dot ? `<i class="fin-dot" style="background:${dot}"></i>` : ''}${label}</div><div class="fin-tile-v">${value}</div><div class="fin-tile-s">${sub}</div>${extra ? `<div class="fin-tile-x">${extra}</div>` : ''}</div>`;
  // the small gray line under Expenses: paid out, but not part of it
  const belowLine = (m) => `Not in expenses: sales tax remitted ${money0(m.salesTax)} · owner draw ${money0(m.ownerDraw)}${m.setup ? ` · business purchase & setup ${money0(m.setup)}` : ''}`;
  const seg = (name, opts, cur) => `<div class="fin-seg" role="group">${opts.map(([v, l]) => `<button type="button" data-seg="${name}" data-v="${v}" aria-pressed="${v === cur}">${l}</button>`).join('')}</div>`;
  const chart = (kind, h) => `<div class="fin-chart" data-chart="${kind}" style="height:${h}px"></div>`;
  const barColor = (r) => (r > 1 ? 'var(--fin-red)' : r >= 0.8 ? 'var(--fin-amber)' : 'var(--fin-green)');
  const catOptions = (sel, blank = 'Uncategorized') => `<option value="">${blank}</option>${fin.cats.map((c) => `<option value="${c.id}"${c.id === sel ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}`;
  const charts = {}; // what each chart box draws, filled in by the view

  // ---------- Overview ----------
  function viewOverview() {
    const end = periodEnd();
    const m = cur();
    const pv = previous();
    const p = sums(pv.from, pv.end);
    const delta = m.net - p.net;
    const prevLabel = pv.partial ? periodShort(pv.from, pv.end, pv.to) : periodLabel({ ...period, kind: period.kind === 'custom' ? 'custom' : 'month', from: pv.from, to: pv.to });
    const days = daily(period.from, end);
    let run = 0;
    const netRun = days.map((d) => (run += d.sales - d.spend));
    charts.spark = (w) => sparkline(netRun, w, 64);

    // bills still to pay before the period ends (only while it's still going)
    const left = period.to >= T() ? dueBetween(T(), period.to).filter((d) => !KIND[kindOf(fin.cat(d.bill.categoryId))].excluded) : [];
    const leftSum = left.reduce((a, d) => a + d.bill.amount, 0);

    const primeP = p.primePct;
    const primeUp = m.primePct != null && primeP != null ? m.primePct - primeP : null;
    const tiles = [
      tile('Sales', money(m.sales), `${pv.partial ? 'vs' : 'last period'} ${money0(p.sales)}${pv.partial ? ` ${esc(prevLabel)}` : ''}`, 'var(--fin-green)'),
      tile('Expenses', money(m.operatingExpenses), `${feeSub(m) ? `incl. ${feeSub(m)} · ` : ''}vs ${money0(p.operatingExpenses)}`, 'var(--fin-red)', '', belowLine(m)),
      tile('Prime cost', m.primePct == null ? '—' : pct0(m.prime, m.sales),
        m.primePct == null ? 'No sales yet' : `${primeWord(m.primePct)} · under 60% is healthy${primeUp != null && Math.round(primeUp * 100) ? ` · ${primeUp > 0 ? 'up' : 'down'} ${Math.abs(Math.round(primeUp * 100))} pts` : ''}`,
        m.primePct != null && Math.round(m.primePct * 100) >= 60 ? 'var(--fin-amber)' : 'var(--fin-green)'),
      tile('Left after bills', money(m.net - leftSum), left.length ? `after ${money0(leftSum)} of bills due by ${md(period.to)}` : 'no bills left to pay in this period', 'var(--fin-line)'),
    ].join('');

    const ms = months(period.to);
    charts.cash = (w) => cashBars(ms, w, 220);
    const prevDays = daily(pv.from, pv.to < T() ? pv.to : minK(pv.to, T()));
    charts.cum = (w) => cumLines(days.map((d) => d.spend), prevDays.map((d) => d.spend), w, 220);
    const cashHead = `<div class="fin-card-sub">Net this period: <b class="${m.net >= 0 ? 'fin-up' : 'fin-down'}">${money(m.net)}</b></div><button class="fin-link" data-go="cashflow">View all</button>`;
    const partialNote = ms.some((x) => x.partial || x.none) ? '<p class="fin-note">* Sales for part of that month aren\'t kept (the dashboard keeps about 100 days), so that month\'s green bar is short.</p>' : '';
    const cashCard = card('Cash flow', `${chart('cash', 220)}<div class="fin-legend"><span><i style="background:var(--fin-green)"></i>Sales</span><span><i style="background:var(--fin-red)"></i>Expenses</span></div>${partialNote}`, cashHead);
    const cumCard = card(`Spending <span class="fin-card-sub">${money0(m.operatingExpenses)} ${esc(periodShort())}</span>`, `${chart('cum', 220)}<div class="fin-legend"><span><i style="background:var(--fin-prev)"></i>${esc(periodLabel({ ...period, kind: period.kind === 'custom' ? 'custom' : 'month', from: pv.from, to: pv.to }))}</span><span><i style="background:var(--fin-line)"></i>${esc(periodLabel())}</span></div>`);

    // budgets
    const nMonths = period.kind === 'custom' ? Math.max(1, Math.round((daysBetween(period.from, period.to) + 1) / 30.4)) : monthsIn(period);
    const cr = new Map(catRows(m).map((r) => [r.id, r.amount]));
    const budgeted = fin.cats.filter((c) => c.budget != null && c.budget > 0);
    const budgetGroup = (name, cats) => {
      if (!cats.length) return '';
      const plan = cats.reduce((a, c) => a + c.budget * nMonths, 0);
      const spent = cats.reduce((a, c) => a + (cr.get(c.id) || 0), 0);
      const r = plan ? spent / plan : 0;
      return `<div class="fin-bgroup"><div class="fin-brow"><b>${name}</b><span class="muted">${money0(plan)} planned</span></div>
        <div class="fin-bar"><i style="width:${Math.min(100, r * 100)}%;background:${barColor(r)}"></i></div>
        <div class="fin-brow small"><span class="muted">${money0(spent)} spent</span><span class="${spent > plan ? 'fin-down' : 'fin-ok'}">${spent > plan ? `${money0(spent - plan)} over` : `${money0(plan - spent)} remaining`}</span></div>
        <div class="fin-bcats">${cats.map((c) => { const sp = cr.get(c.id) || 0, rr = sp / (c.budget * nMonths); return `<div class="fin-bcat"><span><i class="fin-dot" style="background:${KIND[c.kind].color}"></i>${esc(c.name)}</span><span class="fin-bcat-bar"><i style="width:${Math.min(100, rr * 100)}%;background:${barColor(rr)}"></i></span><span class="num">${money0(sp)} / ${money0(c.budget * nMonths)}</span></div>`; }).join('')}</div></div>`;
    };
    const budgetCard = card(`Budget <span class="fin-card-sub">${esc(periodLabel())}</span>`, budgeted.length
      ? budgetGroup('Fixed', budgeted.filter(isFixed)) + budgetGroup('Flexible', budgeted.filter((c) => !isFixed(c)))
      : '<p class="fin-empty">No budgets yet. Set a monthly amount for any category under More → Budgets.</p>', '<button class="fin-link" data-go="budgets">Edit</button>');

    // upcoming bills (14 days, plus any that are late)
    const soon = dueBetween(T(), addDaysKey(T(), 14));
    const billsCard = card('Upcoming bills', soon.length ? `<ul class="fin-bills">${soon.map(({ bill, due }) => `<li><i class="fin-dot" style="background:${KIND[kindOf(fin.cat(bill.categoryId))].color}"></i><div><b>${esc(bill.name)}</b><span class="muted ${due < T() ? 'fin-warn' : ''}">${dueText(due)}${bill.autoPay ? ' · auto-pay' : ''}</span></div><span class="num">${money(bill.amount)}</span></li>`).join('')}</ul>`
      : '<p class="fin-empty">Nothing due in the next 14 days.</p>', '<button class="fin-link" data-go="recurring">View all</button>');

    // delivery-app fees (from payout reports)
    const fees = m.fees;
    const feeCard = card('Delivery-app fees', fees.apps.length ? `<div class="fin-table">
      <div class="fin-tr fin-th"><span>App</span><span class="num">Sales</span><span class="num">You get</span><span class="num">Fees</span></div>
      ${fees.apps.map((a) => `<div class="fin-tr"><span>${a.name}</span><span class="num">${money0(a.sales)}</span><span class="num">${a.approx ? '≈' : ''}${money0(a.get)}</span><span class="num">${money0(a.fees)} <small class="muted">${pct0(a.fees, a.sales)}</small></span></div>`).join('')}
      <div class="fin-tr fin-tt"><span>Total</span><span class="num">${money0(fees.apps.reduce((x, a) => x + a.sales, 0))}</span><span class="num">${money0(fees.apps.reduce((x, a) => x + a.get, 0))}</span><span class="num">${money0(fees.total)}</span></div></div>
      <p class="fin-note">Worked out from each app's payout report: sales minus "You get" (commission, promotions, ads and refunds the app kept). Not from your bank.${fees.approx ? ' ≈ = orders the app hasn\'t paid out yet, estimated at its usual rate.' : ''}</p>
      ${m.feeRows ? `<p class="fin-note fin-warn">${money(m.feeRows)} of transactions are also filed under Delivery App Fees this period. If those are the same app fees from a statement, they're counted twice: file them as something else.</p>` : ''}`
      : '<p class="fin-empty">No delivery-app sales in this period.</p>');

    // card-processing fees (version 1.13.0; in-store from the bank statement when it's imported, 1.13.1)
    const cf = m.cardFees;
    const R = CONFIG.cardFees;
    const partSrc = (a) => (a.id !== 'instore' ? '' : a.bankFees && a.fees > a.bankFees ? 'part from bank statement' : a.bankFees ? 'from bank statement' : 'estimated');
    const cardNote = (mm, r) => {
      const inst = mm.cardFees.parts.some((a) => a.id === 'instore');
      const bank = 'what the card processor took for the month (the MERCH BNKCD interchange, fee and discount rows on the bank statement, taken out early the next month and counted in the month they pay for)';
      const est = `estimated at the ${esc(r?.clover?.label || 'Clover in-person rate')}, on what was charged to each card (tax and tip included)`;
      const instText = !inst ? '' : mm.cardFromBank && mm.cardEstimated ? `In-store: ${bank}; for days whose statement isn't imported yet, ${est}. Cash has no fee. `
        : mm.cardFromBank ? `In-store: ${bank}. Cash has no fee. ` : `In-store: ${est}, until the bank statement with that month's processor charge is imported. Cash has no fee. `;
      return `${instText}Website & app: Owner's own card fee per order (${r?.owner?.pct ?? 2.9}% + ${r?.owner?.cents ?? 30}¢), estimated the same way on days Owner wasn't reachable.`;
    };
    const cardSub = m.cardFromBank ? (m.cardEstimated ? 'in-store partly from bank statement' : 'in-store from bank statement') : 'estimated';
    const cardFeeCard = cf.parts.length ? card(`Card Processing Fees <span class="fin-card-sub">${cardSub}</span>`, `<div class="fin-table">
      <div class="fin-tr fin-th"><span>Channel</span><span class="num">Sales</span><span class="num">You get</span><span class="num">Card fees</span></div>
      ${cf.parts.map((a) => `<div class="fin-tr"><span>${a.name}${partSrc(a) ? ` <small class="muted">${partSrc(a)}</small>` : ''}</span><span class="num">${money0(a.sales)}</span><span class="num">${a.approx ? '≈' : ''}${money0(a.sales - a.fees)}</span><span class="num">${money0(a.fees)} <small class="muted">${pct(a.fees, a.sales)}</small></span></div>`).join('')}
      <div class="fin-tr fin-tt"><span>Total</span><span class="num">${money0(cf.parts.reduce((x, a) => x + a.sales, 0))}</span><span class="num">${money0(cf.parts.reduce((x, a) => x + a.sales - a.fees, 0))}</span><span class="num">${money0(cf.total)}</span></div></div>
      <p class="fin-note">${cardNote(m, R)}</p>
      ${m.cardFeeRows && m.cardEstimated ? `<p class="fin-note fin-warn">${money(m.cardFeeRows)} of other transactions are filed under Card Processing Fees this period, next to estimated in-store card fees. If those are the same card fees, they're counted twice: file them as something else.</p>` : ''}`) : '';

    const top = catRows(m).slice(0, 6);
    const topMax = top[0]?.amount || 1;
    const whereCard = card('Where it went', top.length ? `<ul class="fin-rank">${top.map((r) => `<li><div class="fin-rank-t"><span><i class="fin-dot" style="background:${r.color}"></i>${esc(r.name)}${r.derived ? ` <small class="muted">${derivedNote(r)}</small>` : ''}</span><span class="num">${money0(r.amount)} <small class="muted">${pct0(r.amount, m.operatingExpenses)}</small></span></div><div class="fin-thin"><i style="width:${(r.amount / topMax) * 100}%;background:${r.color}"></i></div></li>`).join('')}</ul>`
      : '<p class="fin-empty">No spending in this period yet.</p>', '<button class="fin-link" data-go="spending">See all</button>');

    const missingNote = m.missing && m.sales ? `<p class="fin-note">Sales for ${plural(m.missing, 'day')} of this period aren't in the dashboard (it keeps about 100 days), so sales and profit read low.</p>` : '';
    return `<section class="fin-card fin-hero">
        <div class="fin-hero-l">
          <div class="fin-label">Net profit · ${esc(periodShort())}</div>
          <div class="fin-big ${m.net < 0 ? 'fin-down' : ''}">${money(m.net)}</div>
          <div class="fin-delta ${delta >= 0 ? 'fin-up' : 'fin-down'}">${delta >= 0 ? '▲' : '▼'} ${money(Math.abs(delta))} vs ${esc(prevLabel)}${m.sales ? ` <span class="muted">· ${pct(m.net, m.sales)} of sales kept</span>` : ''}</div>
        </div>
        <div class="fin-hero-r">${chart('spark', 64)}</div>
        <p class="fin-summary">${summary(m, p, prevLabel)}</p>${missingNote}
      </section>
      <div class="fin-tiles">${tiles}</div>
      <div class="fin-grid2">${cashCard}${cumCard}${budgetCard}${billsCard}${whereCard}${feeCard}${cardFeeCard}</div>`;
  }

  const primeWord = (p) => { const r = Math.round(p * 100); return r < 60 ? 'Healthy' : r <= 65 ? 'At the limit' : 'High'; };

  // 3–4 plain sentences from the numbers.
  function summary(m, p, prevLabel) {
    const going = period.to > T();
    const name = period.kind === 'this' || period.kind === 'last' || period.kind === 'month' ? MONTH[P(period.from).m - 1] : periodLabel();
    const out = [];
    out.push(`${esc(name)}${going ? ' so far' : ''}: you took in <b>${money0(m.sales)}</b> and spent <b>${money0(m.operatingExpenses)}</b>, so you ${m.net >= 0 ? 'kept' : 'lost'} <b>${money0(Math.abs(m.net))}</b>${m.sales ? ` (${pct0(Math.abs(m.net), m.sales)} of sales)` : ''}.`);
    if (m.primePct != null) {
      const dir = p.primePct == null ? '' : m.primePct > p.primePct + 0.005 ? `, up from ${pct0(p.prime, p.sales)}` : m.primePct < p.primePct - 0.005 ? `, down from ${pct0(p.prime, p.sales)}` : ', about the same as';
      out.push(`Food, packaging and labor (prime cost) are ${pct0(m.prime, m.sales)} of sales${dir}${dir === ', about the same as' ? ` ${esc(prevLabel)}` : ''}; under 60% is healthy for a pizzeria.`);
    }
    const big = catRows(m)[0];
    if (big) out.push(`The biggest cost is ${esc(big.name)} at ${money0(big.amount)}${m.fees.total && big.derived !== 'payouts' ? `, and the delivery apps kept ${money0(m.fees.total)} in fees` : ''}.`);
    const next = dueBetween(T(), addDaysKey(T(), 14)).sort((a, b) => b.bill.amount - a.bill.amount)[0];
    if (next) out.push(`${esc(next.bill.name)} (${money0(next.bill.amount)}) is due ${next.due === T() ? 'today' : `on ${dow(next.due)}, ${md(next.due)}`}.`);
    if (m.uncategorized) out.push(`${plural(m.uncategorized, 'expense')} still need${m.uncategorized === 1 ? 's' : ''} a category.`);
    return out.slice(0, 4).join(' ');
  }

  // ---------- Transactions ----------
  function viewTransactions() {
    const end = periodEnd(); // the same days as every other page
    const rowsAll = fin.txns.filter((t) => t.date >= period.from && t.date <= end);
    const dups = dupKeys(rowsAll);
    const review = (t) => !t.categoryId || isDup(t, dups);
    const q = ui.txSearch.trim().toLowerCase();
    let rows = rowsAll.filter((t) => {
      if (ui.txFilter === 'review' && !review(t)) return false;
      if (ui.txFilter === 'uncat' && t.categoryId) return false;
      if (ui.txFilter === 'recurring' && !t.isRecurring) return false;
      if (ui.txCat && t.categoryId !== ui.txCat) return false;
      if (!q) return true;
      const c = fin.cat(t.categoryId);
      return `${t.vendor} ${t.description} ${t.note} ${c?.name || 'uncategorized'} ${(t.amount / 100).toFixed(2)}`.toLowerCase().includes(q);
    });
    const out = rows.filter((t) => t.amount > 0).reduce((a, t) => a + t.amount, 0);
    const inn = -rows.filter((t) => t.amount < 0).reduce((a, t) => a + t.amount, 0);
    const nReview = rowsAll.filter(review).length;
    const counts = { all: rowsAll.length, review: nReview, uncat: rowsAll.filter((t) => !t.categoryId).length, recurring: rowsAll.filter((t) => t.isRecurring).length };
    const chips = [['all', 'All'], ['review', 'Needs review'], ['uncat', 'Uncategorized'], ['recurring', 'Recurring']]
      .map(([v, l]) => `<button type="button" class="fin-chip" data-txf="${v}" aria-pressed="${ui.txFilter === v}">${l} <small>${counts[v]}</small></button>`).join('');
    const shown = rows.slice(0, ui.txLimit);
    let list = '', day = '';
    for (const t of shown) {
      if (t.date !== day) {
        day = t.date;
        const sub = rows.filter((x) => x.date === day).reduce((a, x) => a + x.amount, 0);
        list += `<li class="fin-day"><span>${dow(day)}, ${mdy(day)}</span><span class="num">${money(-sub)}</span></li>`;
      }
      const c = fin.cat(t.categoryId);
      const name = t.vendor || guessVendor(t.description);
      const col = KIND[kindOf(c)].color;
      const tags = [isDup(t, dups) ? '<span class="fin-tag warn">Possible duplicate</span>' : '', t.isRecurring ? '<span class="fin-tag">Recurring</span>' : '', t.source === 'manual' ? '<span class="fin-tag">Typed in</span>' : ''].join('');
      list += `<li class="fin-tx" data-tx="${t.id}">
        <label class="fin-check" aria-label="Select"><input type="checkbox" data-sel="${t.id}"${ui.txSel.has(t.id) ? ' checked' : ''}></label>
        <span class="fin-avatar" style="background:${col}">${esc(name.replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase() || '?')}</span>
        <button type="button" class="fin-tx-main" data-open="${t.id}"><b>${esc(name)}</b><span><span class="${c ? 'muted' : 'fin-warn'}">${c ? esc(c.name) : 'Uncategorized'}</span>${fin.account(t.accountId) ? `<span class="muted fin-acct"> · ${esc(fin.account(t.accountId).name)}</span>` : ''}</span>${tags}</button>
        <span class="num fin-tx-amt ${t.amount < 0 ? 'fin-up' : ''}">${money(-t.amount, true)}</span></li>`;
    }
    const bulk = ui.txSel.size ? `<div class="fin-bulk"><b>${ui.txSel.size} selected</b><select id="finBulkCat" aria-label="Category for the selected rows"><option value="">Set category…</option>${fin.cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select><button type="button" class="fin-btn ghost" data-act="bulk-clear">Clear</button></div>` : '';
    const fees = cur().appFees, cardFee = cur().cardFee;
    return `<section class="fin-card fin-tx-card">
      <div class="fin-tx-tools"><input type="search" id="finSearch" placeholder="Search vendor, category, note or amount" value="${esc(ui.txSearch)}" autocomplete="off">
        <select id="finTxCat" aria-label="Category">${'<option value="">All categories</option>' + fin.cats.map((c) => `<option value="${c.id}"${ui.txCat === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
        <button type="button" class="fin-btn accent" data-act="add-txn">${icon('plus', 16)} Add expense</button></div>
      <div class="fin-chips">${chips}</div>
      <p class="fin-sumline">${plural(rows.length, 'transaction')} · <span class="fin-up">${money(inn)} in</span> · ${money(out)} out${nReview ? ` · <button type="button" class="fin-warn fin-plain" data-txf="review">${nReview} need review</button>` : ''}</p>
      ${bulk}
      ${rows.length ? `<ul class="fin-txs">${list}</ul>` : '<p class="fin-empty">No transactions here. Import a statement or add an expense.</p>'}
      ${rows.length > shown.length ? `<button type="button" class="fin-link more" data-act="tx-more">Show ${Math.min(200, rows.length - shown.length)} more</button>` : ''}
      ${fees ? `<p class="fin-note">Plus ${money(fees)} of delivery-app fees in this period, worked out from the apps' payout reports (not listed here).</p>` : ''}
      ${cardFee ? `<p class="fin-note">Plus ${money(cardFee)} of card-processing fees (in-store and website & app) for this period${cur().cardFromBank ? ': in-store from the processor\'s rows on the bank statement, which are listed in the month after and counted in the month they pay for' : ', worked out from the sales (not listed here)'}.</p>` : ''}
      </section>`;
  }

  // ---------- Spending ----------
  function viewSpending() {
    const m = cur();
    const by = ui.spendBy;
    const rows = by === 'groups' ? groupRows(m) : by === 'vendors' ? vendorRows(m) : catRows(m);
    const groups = groupRows(m);
    const nMonths = Math.max(1, monthsIn({ from: period.from, to: periodEnd() }));
    const big = groups[0];
    const tiles = [
      tile('Expenses', money(m.operatingExpenses), feeSub(m) ? `incl. ${feeSub(m, 'delivery-app')}` : 'everything spent running the store', 'var(--fin-red)', '', belowLine(m)),
      tile('Average per month', money(Math.round(m.operatingExpenses / nMonths)), `${plural(nMonths, 'month')}${period.to > T() ? ', this one so far' : ''}`),
      tile('Largest group', big ? esc(big.name) : '—', big ? `${pct(big.amount, m.operatingExpenses)} of spending · ${money0(big.amount)}` : 'Nothing yet', big?.color || ''),
      tile('Transactions', m.rows.length.toLocaleString('en-US'), m.uncategorized ? `<span class="fin-warn">${m.uncategorized} uncategorized</span>` : 'all have a category'),
    ].join('');
    if (ui.spendPick && !rows.some((r) => r.id === ui.spendPick)) ui.spendPick = null;
    const max = rows[0]?.amount || 1;
    const list = rows.map((r) => `<li><button type="button" class="fin-rankbtn" data-pick="${esc(r.id)}" aria-pressed="${ui.spendPick === r.id}">
        <div class="fin-rank-t"><span><i class="fin-dot" style="background:${r.color}"></i>${esc(r.name)}${by !== 'groups' ? ` <span class="muted">· ${esc(r.group)}</span>` : ''}${r.derived ? ` <small class="muted">${derivedNote(r, true)}</small>` : ''}</span>
        <span class="num">${money(r.amount)} <span class="muted fin-pc">${pct(r.amount, m.operatingExpenses)}</span></span></div>
        <div class="fin-thin"><i style="width:${Math.max(0, (r.amount / max) * 100)}%;background:${r.color}"></i></div></button></li>`).join('');
    const segs = (by === 'vendors' ? rows.slice(0, 10).concat(rows.length > 10 ? [{ name: 'Everything else', amount: rows.slice(10).reduce((a, r) => a + r.amount, 0), color: '#c8c3ba' }] : []) : rows)
      .map((r) => ({ label: r.name, value: r.amount, color: r.color }));
    charts.donut = (w) => donut(segs, Math.min(220, w), m.operatingExpenses);
    const pick = ui.spendPick ? rows.find((r) => r.id === ui.spendPick) : null;
    const ms = months(period.to, 12, pick ? { by, id: pick.id } : null);
    charts.trend = (w) => trendBars(ms, w, 200, pick ? pick.color : 'var(--fin-line)');
    const legend = groups.map((g) => `<span><i style="background:${g.color}"></i>${esc(g.name)}</span>`).join('');
    return `<div class="fin-tiles">${tiles}</div>
      ${card('Spending breakdown', `<div class="fin-break"><div class="fin-donut">${chart('donut', 220)}<div class="fin-legend wrap">${legend}</div></div><ul class="fin-rank">${list || '<li class="fin-empty">Nothing spent in this period.</li>'}</ul></div>`,
        seg('spendBy', [['groups', 'Groups'], ['categories', 'Categories'], ['vendors', 'Vendors']], by))}
      ${card(`Spending trend <span class="fin-card-sub">${pick ? esc(pick.name) : 'All spending'}</span>`, `<p class="fin-note">${pick ? 'Tap it again in the list above to see all spending.' : 'Tap a row in the breakdown above to chart just that one.'}</p>${chart('trend', 200)}`)}`;
  }

  // ---------- Cash flow ----------
  function viewCashflow() {
    const m = cur();
    const tiles = [
      tile('Sales', money(m.sales), 'before tax and tips, all channels', 'var(--fin-green)'),
      tile('Expenses', money(m.operatingExpenses), feeSub(m) ? `incl. ${feeSub(m, 'delivery-app')}` : 'everything spent running the store', 'var(--fin-red)', '', belowLine(m)),
      tile('Net profit', money(m.net), m.net >= 0 ? 'kept after expenses' : 'spent more than sales', m.net >= 0 ? 'var(--fin-green)' : 'var(--fin-red)'),
      tile('Kept of each $100', m.sales ? `$${Math.max(-999, Math.round((m.net / m.sales) * 100))}` : '—', m.sales ? `margin ${pct(m.net, m.sales)}` : 'no sales yet'),
    ].join('');
    let body;
    if (ui.flowMode === 'sankey') {
      charts.sankey = (w) => sankey(m, w);
      body = `<div class="fin-chart fin-sankey" data-chart="sankey"></div>`;
    } else body = pnl(m);
    const ms = months(period.to);
    charts.cash = (w) => cashBars(ms, w, 220);
    return `<div class="fin-tiles">${tiles}</div>
      ${card('Where the money went', body, seg('flowMode', [['sankey', 'Sankey'], ['pnl', 'Profit & loss']], ui.flowMode))}
      ${card('Cash flow by month', `${chart('cash', 220)}<div class="fin-legend"><span><i style="background:var(--fin-green)"></i>Sales</span><span><i style="background:var(--fin-red)"></i>Expenses</span></div>`)}`;
  }
  function pnl(m) {
    const inc = [];
    if (m.ch.instore) {
      const other = m.ch.instore - m.card - m.cash;
      if (m.card || m.cash) {
        inc.push(['In-store card', m.card]);
        inc.push(['In-store cash', m.cash]);
        if (Math.abs(other) >= 1) inc.push(['In-store, other', other]);
      } else inc.push(['In-store', m.ch.instore]);
    }
    for (const [id, name] of CHANNELS.slice(1)) if (m.ch[id]) inc.push([name, m.ch[id]]);
    const row = (name, p, amt, cls = '', attr = '') => `<div class="fin-pl ${cls}" ${attr}><span>${name}</span><span class="muted num">${p}</span><span class="num">${amt}</span></div>`;
    let s = `<div class="fin-pl fin-pl-h"><span>Category</span><span class="num">% of sales</span><span class="num">Amount</span></div>`;
    s += row('<b>Income</b>', '', `<b>${money(m.sales)}</b>`, 'fin-pl-g');
    for (const [n, v] of inc) s += row(esc(n), pct(v, m.sales), money(v), 'fin-pl-c');
    s += row('<b>Expenses</b>', pct(m.operatingExpenses, m.sales), `<b>${money(-m.operatingExpenses)}</b>`, 'fin-pl-g');
    for (const g of groupRows(m)) {
      const open = ui.openGroups.has(g.id);
      s += `<button type="button" class="fin-pl fin-pl-grp" data-grp="${g.id}" aria-expanded="${open}"><span><span class="fin-caret">›</span><i class="fin-dot" style="background:${g.color}"></i>${esc(g.name)}</span><span class="muted num">${pct(g.amount, m.sales)}</span><span class="num">${money(-g.amount)}</span></button>`;
      if (open) for (const c of g.cats) s += row(`${esc(c.name)}${c.derived ? ` <small class="muted">${derivedNote(c, true)}</small>` : ''}`, pct(c.amount, m.sales), money(-c.amount), 'fin-pl-c deep');
    }
    s += row('<b>Net profit</b>', pct(m.net, m.sales), `<b class="${m.net >= 0 ? 'fin-up' : 'fin-down'}">${money(m.net)}</b>`, 'fin-pl-g fin-pl-net');
    s += '<div class="fin-pl fin-pl-h"><span>Below the line (paid out, not a cost)</span><span></span><span></span></div>';
    s += row('Sales tax remitted <small class="muted">(collected from customers)</small>', pct(m.salesTax, m.sales), money(-m.salesTax), 'fin-pl-c');
    s += row('Owner draw', pct(m.ownerDraw, m.sales), money(-m.ownerDraw), 'fin-pl-c');
    s += row('<b>Cash left</b>', pct(m.cashLeft, m.sales), `<b class="${m.cashLeft >= 0 ? 'fin-up' : 'fin-down'}">${money(m.cashLeft)}</b>`, 'fin-pl-g');
    if (m.setup) s += row('Business purchase & setup <small class="muted">(one-time, not in cash left)</small>', '', money(-m.setup), 'fin-pl-c');
    return `<div class="fin-pls">${s}</div><p class="fin-note">Sales tax paid isn't a cost here because sales are counted before tax: it's the tax customers paid, passed on. Loan payments are counted in full (the interest part is the real cost).${m.setup ? ' Business purchase & setup is the one-time money around buying the store (the purchase, franchise fees, lease deposit), so it is left out of profit and cash left.' : ''}</p>`;
  }

  // ---------- Budgets ----------
  function viewBudgets() {
    const m = cur();
    const cr = new Map(catRows(m).map((r) => [r.id, r.amount]));
    const nMonths = monthsIn(period);
    const list = (name, cats) => `<h4 class="fin-h4">${name}</h4><ul class="fin-budgets">${cats.map((c) => {
      const sp = cr.get(c.id) || 0;
      const plan = c.budget != null ? c.budget * nMonths : null;
      const r = plan ? sp / plan : 0;
      return `<li><div class="fin-brow"><span><i class="fin-dot" style="background:${KIND[c.kind].color}"></i>${esc(c.name)}</span>
        <label class="fin-money-in"><span>$</span><input type="text" inputmode="decimal" data-budget="${c.id}" value="${c.budget != null ? (c.budget / 100).toFixed(0) : ''}" placeholder="no budget" aria-label="Monthly budget for ${esc(c.name)}"><span class="muted">/mo</span></label></div>
        ${plan ? `<div class="fin-bar"><i style="width:${Math.min(100, r * 100)}%;background:${barColor(r)}"></i></div><div class="fin-brow small"><span class="muted">${money0(sp)} of ${money0(plan)}</span><span class="${sp > plan ? 'fin-down' : 'fin-ok'}">${sp > plan ? `${money0(sp - plan)} over` : `${money0(plan - sp)} left`}</span></div>` : `<div class="fin-brow small"><span class="muted">${money0(sp)} spent</span></div>`}</li>`;
    }).join('')}</ul>`;
    const cats = fin.cats.filter((c) => !KIND[c.kind].excluded);
    return card(`Monthly budgets <span class="fin-card-sub">${esc(periodLabel())}${nMonths > 1 ? ` · ${nMonths} months` : ''}</span>`,
      `<p class="fin-note">Type a monthly amount for a category; leave it empty for no budget. Bars turn amber at 80% and red when over.${fin.mode === 'fixture' ? ' (Sample data: changes aren\'t saved.)' : ''}</p>
      ${list('Fixed', cats.filter(isFixed))}${list('Flexible', cats.filter((c) => !isFixed(c)))}
      <p class="fin-note">Sales tax, owner draw and business purchase & setup have no budget: they aren't costs of running the store.</p>`);
  }

  // ---------- Recurring ----------
  function viewRecurring() {
    const bills = [...fin.bills].sort((a, b) => (a.active !== b.active ? (a.active ? -1 : 1) : a.nextDue < b.nextDue ? -1 : 1));
    const monthly = bills.filter((b) => b.active).reduce((a, b) => a + perMonth(b), 0);
    const FREQ = { weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly', quarterly: 'Every 3 months', yearly: 'Yearly' };
    return card(`Recurring bills <span class="fin-card-sub">about ${money0(monthly)} a month</span>`,
      bills.length ? `<ul class="fin-bills big">${bills.map((b) => `<li class="${b.active ? '' : 'off'}"><i class="fin-dot" style="background:${KIND[kindOf(fin.cat(b.categoryId))].color}"></i>
        <div><b>${esc(b.name)}</b><span class="muted">${esc([b.vendor, FREQ[b.frequency], b.autoPay ? 'auto-pay' : '', fin.cat(b.categoryId)?.name].filter(Boolean).join(' · '))}</span>
        <span class="${b.active && b.nextDue < T() ? 'fin-warn' : 'muted'}">${b.active ? `Next: ${dueText(b.nextDue)}` : 'Stopped'}</span></div>
        <div class="fin-bill-r"><span class="num">${money(b.amount)}</span><span class="fin-bill-btns">${b.active ? `<button type="button" class="fin-btn small" data-paid="${b.id}">Mark paid</button>` : ''}<button type="button" class="fin-btn ghost small" data-bill="${b.id}">Edit</button></span></div></li>`).join('')}</ul>`
        : '<p class="fin-empty">No recurring bills yet.</p>',
      `<button type="button" class="fin-btn accent small" data-act="add-bill">${icon('plus', 15)} Add bill</button>`)
      + '<p class="fin-note">"Mark paid" adds the bill as an expense today and moves its due date to the next one. If the same payment also comes in with a bank statement, the import shows it as a separate row: untick it there, or delete one of the two.</p>';
  }

  // ---------- Import ----------
  function viewImport() {
    const imp = ui.imp;
    let body = `<label class="fin-drop" id="finDrop"><input type="file" id="finFile" accept=".csv,text/csv" hidden>
      ${icon('import', 26)}<b>Choose a CSV file</b><span class="muted">or drop it here. From your bank's or card's website: Activity → Download → CSV.</span></label>`;
    if (ui.impResult) {
      const r = ui.impResult;
      body = `<div class="fin-result"><b>Imported ${r.imported} · Skipped ${r.skipped}</b><span>${r.dups ? `${plural(r.dups, 'row')} already imported. ` : ''}${r.imported ? `Rules filed ${r.filed} of them${r.imported - r.filed ? `; ${r.imported - r.filed} need a category` : ''}.` : ''}</span>
        <span><button type="button" class="fin-btn" data-act="see-review">See them in Transactions</button> <button type="button" class="fin-btn ghost" data-act="imp-again">Import another file</button></span></div>`;
      return card('Done', body);
    }
    if (imp) {
      const headers = imp.rows[imp.header] || [];
      const opt = (k, allowNone = true) => `<select data-map="${k}">${allowNone ? '<option value="-1">(none)</option>' : ''}${headers.map((h, i) => `<option value="${i}"${imp.map[k] === i ? ' selected' : ''}>${esc(h || `Column ${i + 1}`)}</option>`).join('')}</select>`;
      const name = (i) => (i > -1 ? `<b>${esc(headers[i])}</b>` : '—');
      const found = imp.map.amount > -1 ? `Date: ${name(imp.map.date)} · Description: ${name(imp.map.desc)} · Amount: ${name(imp.map.amount)}`
        : `Date: ${name(imp.map.date)} · Description: ${name(imp.map.desc)} · Money out: ${name(imp.map.debit)} · Money in: ${name(imp.map.credit)}`;
      const items = imp.items || [];
      const ok = columnsOk(imp.map);
      const take = items.filter((i) => i.include && !i.error && !i.dup);
      const nd = items.filter((i) => i.dup).length;
      const ne = items.filter((i) => i.error).length;
      const nu = items.filter((i) => !i.include && !i.dup && !i.error).length;
      const prev = items.slice(0, 300).map((it, n) => {
        const c = fin.cat(it.categoryId);
        const status = it.error ? `<span class="fin-tag warn">Skipped: ${it.error}</span>` : it.dup === 'saved' ? '<span class="fin-tag">Already imported</span>' : it.dup === 'file' ? '<span class="fin-tag">Twice in this file</span>' : it.amount < 0 && it.deposit ? '<span class="fin-tag">Money in: looks like a sales deposit</span>' : it.amount < 0 ? '<span class="fin-tag">Money in (refund)</span>' : '';
        return `<li class="${it.dup || it.error ? 'off' : ''}"><label class="fin-check"><input type="checkbox" data-imp="${n}"${it.include && !it.dup && !it.error ? ' checked' : ''}${it.dup || it.error ? ' disabled' : ''}></label>
          <div class="fin-imp-main"><b>${esc(it.vendor || guessVendor(it.description))}</b><span class="muted">${it.date ? md(it.date) : '?'} · ${esc(it.description)}</span>
          <span class="${c ? 'muted' : 'fin-warn'}">${c ? `${esc(c.name)}${it.rule ? ` <small>(rule "${esc(it.rule.matchText)}")</small>` : ''}` : 'Uncategorized'}</span>${status}</div>
          <span class="num ${it.amount < 0 ? 'fin-up' : ''}">${money(-it.amount, true)}</span></li>`;
      }).join('');
      body = `<div class="fin-imp-file"><b>${esc(imp.fileName)}</b><span class="muted">${plural(items.length, 'row')} · ${found}</span>
        <button type="button" class="fin-link" data-act="imp-map">${imp.showMap || !ok ? 'Hide columns' : 'Change columns'}</button> <button type="button" class="fin-link" data-act="imp-again">Pick another file</button></div>
        ${imp.showMap || !ok ? `<div class="fin-map">${ok ? '' : '<p class="fin-warn">Couldn\'t tell which column is which. Pick them here.</p>'}
          <label>Header row<select data-map="header">${imp.rows.slice(0, 20).map((r, i) => `<option value="${i}"${imp.header === i ? ' selected' : ''}>Row ${i + 1}: ${esc(r.slice(0, 4).join(', ').slice(0, 60))}</option>`).join('')}</select></label>
          <label>Date${opt('date', false)}</label><label>Description${opt('desc', false)}</label><label>Memo (optional)${opt('memo')}</label>
          <label>Amount (one column)${opt('amount')}</label><label>Or money out${opt('debit')}</label><label>and money in${opt('credit')}</label></div>` : ''}
        ${fin.accounts.length ? `<div class="fin-signrow"><span>This statement is from</span><select id="finImpAcct" aria-label="Account"><option value="">(not saying)</option>${fin.accounts.filter((a) => a.active).map((a) => `<option value="${a.id}"${ui.impAccount === a.id ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>` : ''}
        ${imp.map.amount > -1 ? `<div class="fin-signrow"><span>In this file, money going out shows as</span>${seg('outSign', [['negative', 'Negative (−45.00)'], ['positive', 'Positive (45.00)']], imp.outSign)}</div>` : ''}
        <p class="fin-sumline"><b>${plural(take.length, 'new expense')}</b> to import${nd ? ` · ${nd} already imported` : ''}${nu ? ` · ${nu} unticked` : ''}${ne ? ` · ${ne} can't be read` : ''} · rules filed ${take.filter((i) => i.categoryId).length}</p>
        <ul class="fin-imp">${prev}</ul>${items.length > 300 ? `<p class="fin-note">Showing the first 300 of ${items.length} rows; all ticked rows are imported.</p>` : ''}
        <div class="fin-actions"><button type="button" class="fin-btn accent" data-act="imp-go"${take.length ? '' : ' disabled'}>Import ${plural(take.length, 'expense')}</button></div>
        <p class="fin-note">Rows already imported before are skipped (same date, description and amount). Money coming in that looks like a sales deposit (DoorDash, Uber, Grubhub, Clover, transfers) starts unticked: sales are counted from the dashboard.</p>`;
    }
    return card(imp ? 'Check before importing' : 'Statement file', body) + `<p class="fin-note">${fin.mode === 'fixture' ? 'Sample data: imported rows show until the page is reloaded and aren\'t saved. ' : ''}Statements with app payouts: DoorDash, Uber Eats and Grubhub fees are already worked out from their payout reports, so a CSV that lists those fees separately would count them twice.</p>`;
  }
  async function readFile(file) {
    const text = await file.text();
    const rows = parseCSV(text);
    if (!rows.length) { ui.imp = null; toast('That file is empty.'); return; }
    const header = findHeader(rows);
    const map = detectColumns(rows[header]);
    ui.imp = { fileName: file.name, rows, header, map, outSign: guessOutSign(rows, header, map), showMap: !map.ok, items: [] };
    ui.impResult = null;
    await rebuildImport();
  }
  async function rebuildImport(keepTicks = false) {
    const imp = ui.imp;
    const old = keepTicks ? new Map(imp.items.map((i) => [i.line, i.include])) : null;
    if (!columnsOk(imp.map)) { imp.items = []; render(); return; }
    const items = statementItems(imp.rows, imp.header, imp.map, imp.outSign);
    await fin.checkImport(items);
    for (const it of items) {
      it.deposit = it.amount < 0 && SALES_DEPOSIT.test(it.description);
      it.include = old?.has(it.line) ? old.get(it.line) : !it.deposit;
    }
    imp.items = items;
    render();
  }

  // ---------- Rules ----------
  function viewRules() {
    const d = ui.ruleDraft;
    const cnt = d.matchText.trim().length >= 2 ? fin.ruleCount(d.matchText) : null;
    const rules = [...fin.rules].sort((a, b) => a.matchText.localeCompare(b.matchText));
    return card('New rule', `<form class="fin-form" id="finRuleForm">
        <label>When the bank description contains<input type="text" id="finRuleText" value="${esc(d.matchText)}" required minlength="2" maxlength="100" autocomplete="off" placeholder="SYSCO"></label>
        <p class="fin-live" id="finRuleCount" aria-live="polite">${ruleCountText(cnt)}</p>
        <label>Call the vendor<input type="text" id="finRuleVendor" value="${esc(d.vendor)}" maxlength="120" autocomplete="off" placeholder="Sysco"></label>
        <label>File it under<select id="finRuleCat" required>${catOptions(d.categoryId, 'Pick a category')}</select></label>
        <button type="submit" class="fin-btn accent">Create rule</button></form>`)
      + card(`Rules <span class="fin-card-sub">${rules.length}</span>`, rules.length ? `<ul class="fin-rules">${rules.map((r) => {
        const c = fin.cat(r.categoryId);
        return `<li><div><code>${esc(r.matchText)}</code> → <b>${esc(r.vendor || '(vendor unchanged)')}</b><span class="muted"><i class="fin-dot" style="background:${KIND[kindOf(c)].color}"></i>${esc(c?.name || '?')} · ${plural(fin.ruleCount(r.matchText).all, 'match', 'matches')}</span></div><button type="button" class="fin-btn ghost small" data-delrule="${r.id}">Delete</button></li>`;
      }).join('')}</ul>` : '<p class="fin-empty">No rules yet.</p>')
      + '<p class="fin-note">Rules are used when a statement is imported, and when a rule is made: matching transactions that have no category yet are filed straight away. The longest matching text wins.</p>';
  }
  const ruleCountText = (cnt) => (cnt ? `Matches <b>${plural(cnt.all, 'past transaction')}</b>${cnt.open ? `; <b>${cnt.open}</b> uncategorized will be filed now` : ''}.` : 'Type at least 2 letters to see what it matches.');

  // ---------- Accounts ----------
  const ACCT_KIND = { checking: 'Checking', savings: 'Savings', credit_card: 'Credit card', cash: 'Cash', other: 'Other' };
  function viewAccounts() {
    const n = (id) => fin.txns.filter((t) => t.accountId === id).length;
    return card(`Accounts <span class="fin-card-sub">${fin.accounts.length}</span>`, fin.accounts.length ? `<ul class="fin-rules">${fin.accounts.map((a) => `<li class="${a.active ? '' : 'off'}"><div><b>${esc(a.name)}</b>
        <span class="muted">${esc([ACCT_KIND[a.kind], a.institution, plural(n(a.id), 'transaction')].filter(Boolean).join(' · '))}${a.active ? '' : ' · not used any more'}</span>
        <span class="muted">Last synced: ${a.lastSyncedAt ? new Date(a.lastSyncedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never'} · <span class="fin-soon">Sync coming soon</span></span></div>
        <button type="button" class="fin-btn ghost small" data-acct="${a.id}">Edit</button></li>`).join('')}</ul>` : '<p class="fin-empty">No accounts yet. Add your business checking account and card, then pick one when you import a statement.</p>',
    `<button type="button" class="fin-btn accent small" data-act="add-acct">${icon('plus', 15)} Add account</button>`)
      + '<p class="fin-note">For now, expenses come in from CSV statements (pick the account on the Import page) or are typed in. Automatic bank sync is planned for later.</p>';
  }
  function acctSheet(a) {
    const isNew = !a;
    a ||= { name: '', kind: 'checking', institution: '', active: true };
    openSheet(`<div class="fin-sheet-h"><h3>${isNew ? 'Add an account' : 'Account'}</h3><button type="button" class="fin-x" data-act="sheet-close" aria-label="Close">×</button></div>
      <form class="fin-form" id="finAcctForm">
        <label>Name<input type="text" name="name" value="${esc(a.name)}" required maxlength="60" placeholder="Business Checking"></label>
        <div class="fin-2"><label>Kind<select name="kind">${Object.entries(ACCT_KIND).map(([v, l]) => `<option value="${v}"${a.kind === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>Bank or card company<input type="text" name="institution" value="${esc(a.institution)}" maxlength="80"></label></div>
        <label class="fin-inline"><input type="checkbox" name="active"${a.active ? ' checked' : ''}> Still using it</label>
        <p class="fin-hint">Last synced: never. Bank sync is coming later; nothing here connects to your bank.</p>
        <div class="fin-actions"><button type="submit" class="fin-btn accent">${isNew ? 'Add account' : 'Save'}</button></div>
      </form>`, () => {
      const form = $('finAcctForm');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = new FormData(form);
        await busy(async () => {
          await fin.saveAccount({ ...a, name: String(f.get('name')).trim(), kind: f.get('kind'), institution: String(f.get('institution')).trim(), active: !!f.get('active') });
          sheet.close();
          toast('Saved.');
        });
      });
    });
  }

  // ---------- More (phone) ----------
  function viewMore() {
    const soon = fin.bills.filter((b) => b.active && b.nextDue <= addDaysKey(T(), 7)).length;
    const items = [['budgets', 'Budgets', 'Monthly amount per category'], ['recurring', 'Recurring bills', soon ? `${soon} due within 7 days` : 'Rent, utilities, loans…'], ['import', 'Import a statement', 'Bank or card CSV'], ['rules', 'Rules', `${fin.rules.length} vendor rules`], ['accounts', 'Accounts', `${plural(fin.accounts.length, 'account')} · bank sync coming soon`]];
    return `<ul class="fin-morelist">${items.map(([v, l, s]) => `<li><button type="button" data-go="${v}">${icon(v, 20)}<span><b>${l}</b><span class="muted">${s}</span></span><span aria-hidden="true">›</span></button></li>`).join('')}</ul>
      <p class="fin-note">Finances · version ${FINANCE_VERSION} · ${fin.mode === 'fixture' ? 'sample data' : 'your data in Supabase'}</p>`;
  }

  // ====================================================================================================
  // the sheet (add / edit an expense, edit a bill)
  // ====================================================================================================
  const sheet = $('finSheet');
  function openSheet(html, onReady) {
    sheet.innerHTML = `<div class="fin-sheet-in">${html}</div>`;
    if (!sheet.open) sheet.showModal();
    onReady?.();
  }
  sheet.addEventListener('click', (e) => { if (e.target === sheet || e.target.closest('[data-act="sheet-close"]')) sheet.close(); });
  sheet.addEventListener('close', () => { sheet.innerHTML = ''; });

  function txnSheet(t) {
    const isNew = !t;
    t ||= { date: T(), vendor: '', description: '', amount: 0, categoryId: '', note: '', isRecurring: false, source: 'manual' };
    const words = guessVendor(t.description || t.vendor).toUpperCase().split(' ');
    const ruleText = (words[0]?.length < 4 && words[1] ? words.slice(0, 2).join(' ') : words[0]) || '';
    const SRC = { csv: 'From a statement import', manual: t.isRecurring ? 'Recurring bill marked paid' : 'Typed in', platform: 'From an app report', rule: 'Filed by a rule' };
    openSheet(`<div class="fin-sheet-h"><h3>${isNew ? 'Add an expense' : 'Expense'}</h3><button type="button" class="fin-x" data-act="sheet-close" aria-label="Close">×</button></div>
      ${isNew ? '' : `<p class="muted fin-desc">${esc(t.description)}<br><small>${SRC[t.source] || ''}</small></p>`}
      <form class="fin-form" id="finTxForm">
        <label>Vendor<input type="text" name="vendor" value="${esc(t.vendor)}" maxlength="120" ${isNew ? 'required' : ''} autocomplete="off" placeholder="${esc(guessVendor(t.description))}"></label>
        <div class="fin-2"><label>Amount ($)<input type="text" name="amount" inputmode="decimal" value="${t.amount ? (t.amount / 100).toFixed(2) : ''}" required placeholder="0.00"></label>
        <label>Date<input type="date" name="date" value="${t.date}" required></label></div>
        <div class="fin-2"><label>Category<select name="categoryId">${catOptions(t.categoryId)}</select></label>
        <label>Paid from<select name="accountId"><option value="">Cash / not known</option>${fin.accounts.map((a) => `<option value="${a.id}"${a.id === t.accountId ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label></div>
        <label>Note<input type="text" name="note" value="${esc(t.note)}" maxlength="500" autocomplete="off"></label>
        <label class="fin-inline"><input type="checkbox" name="isRecurring"${t.isRecurring ? ' checked' : ''}> A recurring bill</label>
        <p class="fin-hint">A refund: type the amount with a minus sign (−25.00).</p>
        <div class="fin-actions">${isNew ? '' : '<button type="button" class="fin-btn ghost danger" data-act="tx-delete">Delete</button>'}<button type="submit" class="fin-btn accent">${isNew ? 'Add expense' : 'Save'}</button></div>
      </form>
      ${isNew ? '' : `<details class="fin-rulebox"${t.categoryId ? '' : ' open'}><summary>Make this a rule</summary>
        <form class="fin-form" id="finTxRule"><label>When the description contains<input type="text" name="matchText" value="${esc(ruleText)}" minlength="2" maxlength="100" required autocomplete="off"></label>
        <p class="fin-live" id="finTxRuleCount" aria-live="polite"></p>
        <label>Vendor<input type="text" name="vendor" value="${esc(t.vendor || guessVendor(t.description))}" maxlength="120" autocomplete="off"></label>
        <label>Category<select name="categoryId" required>${catOptions(t.categoryId, 'Pick a category')}</select></label>
        <button type="submit" class="fin-btn">Create rule and file matches</button></form></details>`}`, () => {
      const form = $('finTxForm');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = new FormData(form);
        const amount = dollarsIn(f.get('amount'));
        if (amount == null || amount === 0) return toast('Type the amount, like 45.00.');
        const patch = { vendor: String(f.get('vendor')).trim(), amount, date: f.get('date'), categoryId: f.get('categoryId') || null, accountId: f.get('accountId') || null, note: String(f.get('note')).trim(), isRecurring: !!f.get('isRecurring') };
        await busy(async () => {
          if (isNew) await fin.addTxn({ ...patch, description: patch.vendor });
          else await fin.updateTxns([t.id], patch);
          sheet.close();
          toast(isNew ? 'Expense added.' : 'Saved.');
        });
      });
      form.querySelector('[data-act="tx-delete"]')?.addEventListener('click', async () => {
        if (!confirm('Delete this expense?')) return;
        await busy(async () => { await fin.deleteTxn(t.id); sheet.close(); toast('Deleted.'); });
      });
      const rf = $('finTxRule');
      if (rf) {
        const live = () => { const v = rf.matchText.value.trim(); $('finTxRuleCount').innerHTML = v.length >= 2 ? ruleCountText(fin.ruleCount(v)) : ruleCountText(null); };
        rf.matchText.addEventListener('input', live);
        live();
        rf.addEventListener('submit', async (e) => {
          e.preventDefault();
          const catId = rf.categoryId.value;
          if (!catId) return toast('Pick a category for the rule.');
          await busy(async () => {
            // this row gets the category too, even if it already had one
            await fin.updateTxns([t.id], { categoryId: catId, ...(rf.vendor.value.trim() ? { vendor: rf.vendor.value.trim() } : {}) });
            const r = await fin.addRule({ matchText: rf.matchText.value, vendor: rf.vendor.value, categoryId: catId });
            sheet.close();
            toast(`Rule made. ${r.refiled ? `Filed ${plural(r.refiled, 'other transaction')}.` : 'No other uncategorized matches.'}`);
          });
        });
      }
    });
  }

  function billSheet(b) {
    const isNew = !b;
    b ||= { name: '', vendor: '', categoryId: '', amount: 0, frequency: 'monthly', dayOfMonth: null, nextDue: addDaysKey(T(), 7), autoPay: false, active: true };
    openSheet(`<div class="fin-sheet-h"><h3>${isNew ? 'Add a recurring bill' : 'Recurring bill'}</h3><button type="button" class="fin-x" data-act="sheet-close" aria-label="Close">×</button></div>
      <form class="fin-form" id="finBillForm">
        <label>Name<input type="text" name="name" value="${esc(b.name)}" required maxlength="80" placeholder="Rent"></label>
        <label>Paid to<input type="text" name="vendor" value="${esc(b.vendor)}" maxlength="120" placeholder="Landlord"></label>
        <div class="fin-2"><label>Amount ($)<input type="text" name="amount" inputmode="decimal" value="${b.amount ? (b.amount / 100).toFixed(2) : ''}" required></label>
        <label>How often<select name="frequency">${[['weekly', 'Weekly'], ['biweekly', 'Every 2 weeks'], ['monthly', 'Monthly'], ['quarterly', 'Every 3 months'], ['yearly', 'Yearly']].map(([v, l]) => `<option value="${v}"${b.frequency === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label></div>
        <div class="fin-2"><label>Next due<input type="date" name="nextDue" value="${b.nextDue}" required></label>
        <label>Day of month <small>(optional)</small><input type="number" name="dayOfMonth" min="1" max="31" value="${b.dayOfMonth || ''}"></label></div>
        <label>Category<select name="categoryId">${catOptions(b.categoryId)}</select></label>
        <label class="fin-inline"><input type="checkbox" name="autoPay"${b.autoPay ? ' checked' : ''}> Paid automatically</label>
        <label class="fin-inline"><input type="checkbox" name="active"${b.active ? ' checked' : ''}> Still paying it</label>
        <div class="fin-actions">${isNew ? '' : '<button type="button" class="fin-btn ghost danger" data-act="bill-delete">Delete</button>'}<button type="submit" class="fin-btn accent">${isNew ? 'Add bill' : 'Save'}</button></div>
      </form>`, () => {
      const form = $('finBillForm');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = new FormData(form);
        const amount = dollarsIn(f.get('amount'));
        if (!amount || amount < 0) return toast('Type the amount, like 1250.00.');
        const dom = parseInt(f.get('dayOfMonth'), 10);
        await busy(async () => {
          await fin.saveBill({ ...(isNew ? {} : { id: b.id }), name: String(f.get('name')).trim(), vendor: String(f.get('vendor')).trim(), amount, frequency: f.get('frequency'), nextDue: f.get('nextDue'), dayOfMonth: dom >= 1 && dom <= 31 ? dom : null, categoryId: f.get('categoryId') || null, autoPay: !!f.get('autoPay'), active: !!f.get('active') });
          sheet.close();
          toast('Saved.');
        });
      });
      form.querySelector('[data-act="bill-delete"]')?.addEventListener('click', async () => {
        if (!confirm('Delete this bill? Expenses already marked paid stay.')) return;
        await busy(async () => { await fin.deleteBill(b.id); sheet.close(); toast('Deleted.'); });
      });
    });
  }

  // ---------- little helpers ----------
  let toastTimer = null;
  function toast(msg) {
    let el = $('finToast');
    if (!el) { el = document.createElement('div'); el.id = 'finToast'; el.className = 'fin-toast'; el.setAttribute('role', 'status'); root.appendChild(el); }
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }
  async function busy(fn) {
    root.classList.add('fin-busy');
    try { await fn(); } catch (e) { toast(`Couldn't save: ${e.message || e}`); } finally { root.classList.remove('fin-busy'); }
  }

  // ====================================================================================================
  // drawing the page
  // ====================================================================================================
  function navHtml() {
    const nReview = uncategorizedCount();
    const soon = fin ? fin.bills.filter((b) => b.active && b.nextDue <= addDaysKey(T(), 7)).length : 0;
    const badge = (v) => (v === 'transactions' && nReview ? `<span class="fin-badge">${nReview}</span>` : (v === 'recurring' || v === 'more') && soon ? `<span class="fin-badge">${soon}</span>` : '');
    const cur = VIEWS[view]?.more ? (matchMedia('(max-width: 899px)').matches ? 'more' : view) : view;
    return NAV.map(([v, l]) => `<button type="button" data-go="${v}" class="${VIEWS[v].more ? 'fin-nav-extra' : v === 'more' ? 'fin-nav-more' : ''}" aria-current="${v === cur || (v === 'more' && VIEWS[view]?.more) ? 'page' : 'false'}"><span class="fin-nav-i">${icon(v, 20)}${badge(v)}</span><span class="fin-nav-l">${l}</span></button>`).join('');
  }
  function headHtml() {
    const v = VIEWS[view];
    const salesAt = all.lastRefresh ? new Date(all.lastRefresh) : null;
    const lastImport = fin?.txns.filter((t) => t.source === 'csv' && t.createdAt).map((t) => t.createdAt).sort().pop();
    const at = salesAt ? (Date.now() - salesAt < 864e5 ? salesAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : salesAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })) : '—';
    const sync = `${v.period ? `${periodShort()} · ` : ''}Sales updated ${at} · Expenses last import ${lastImport ? new Date(lastImport).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'never'}`;
    const kindSel = period.kind === 'month' || period.kind === 'year' ? 'other' : period.kind;
    const nav = v.period ? `<div class="fin-period">
        <button type="button" class="fin-arrow" data-act="prev" aria-label="Earlier">${icon('left', 16)}</button>
        <span class="fin-period-l">${esc(periodLabel())}</span>
        <button type="button" class="fin-arrow" data-act="next" aria-label="Later"${period.to >= T() ? ' disabled' : ''}>${icon('right', 16)}</button>
        <label class="fin-period-sel">${icon('cal', 15)}<select id="finPeriod" aria-label="Period">
          ${[['this', 'This month'], ['last', 'Last month'], ['3m', 'Last 3 months'], ['ytd', 'Year to date'], ['custom', 'Custom']].map(([k, l]) => `<option value="${k}"${kindSel === k ? ' selected' : ''}>${l}</option>`).join('')}
          ${kindSel === 'other' ? `<option value="other" selected>${esc(periodLabel())}</option>` : ''}</select></label></div>` : '';
    const custom = v.period && period.kind === 'custom' ? `<div class="fin-custom"><label>From<input type="date" id="finFrom" value="${period.from}"></label><label>To<input type="date" id="finTo" value="${period.to}"></label></div>` : '';
    return `<div class="fin-head-row"><h2 class="fin-title">${v.title}</h2>${nav}
      <button type="button" class="fin-iconbtn" data-go="import" title="Import a statement" aria-label="Import a statement">${icon('import', 18)}</button></div>
      <p class="fin-sync">${esc(sync)}</p>${custom}`;
  }
  function modeHtml() {
    if (!fin || fin.mode !== 'fixture') return '';
    return fin.reason === 'demo'
      ? '<b>Demo.</b> Made-up numbers (sales and expenses). Nothing you change here is saved.'
      : '<b>Sample expenses.</b> The finance tables aren\'t set up yet, so these expenses are made up (the sales are yours). Run <code>phone/supabase_finance.sql</code> in Supabase to start entering your own. Changes here aren\'t saved.';
  }

  const RENDER = { overview: viewOverview, transactions: viewTransactions, spending: viewSpending, cashflow: viewCashflow, budgets: viewBudgets, recurring: viewRecurring, import: viewImport, rules: viewRules, accounts: viewAccounts, more: viewMore };
  function render() {
    if (!active) return;
    $('finNav').innerHTML = fin ? navHtml() : '';
    if (!fin) {
      $('finHead').innerHTML = '<h2 class="fin-title">Finances</h2>';
      $('finBody').innerHTML = loadError
        ? `<section class="fin-card"><p>Couldn't load the finances: ${esc(loadError)}</p><button type="button" class="fin-btn" data-act="retry">Try again</button></section>`
        : '<section class="fin-card"><p class="muted">Loading…</p></section>';
      return;
    }
    const mode = modeHtml();
    $('finMode').hidden = !mode;
    $('finMode').innerHTML = mode;
    $('finHead').innerHTML = headHtml();
    for (const k of Object.keys(charts)) delete charts[k];
    curCache = null;
    const y = scrollY;
    $('finBody').innerHTML = RENDER[view]();
    drawCharts();
    scrollTo(0, y);
  }
  function drawCharts() {
    for (const el of root.querySelectorAll('.fin-chart[data-chart]')) {
      const f = charts[el.dataset.chart];
      if (f) el.innerHTML = f(Math.max(240, Math.floor(el.clientWidth)));
    }
  }
  let resizeTimer = null;
  addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (active && fin) { $('finNav').innerHTML = navHtml(); drawCharts(); } }, 150); });

  function go(v) {
    if (!VIEWS[v]) return;
    view = v;
    try { localStorage.setItem('canam.finView', v); } catch { /* private mode */ }
    history.replaceState(history.state, '', `#finance/${v}`);
    render();
    scrollTo(0, 0);
  }

  // ---------- events ----------
  root.addEventListener('click', async (e) => {
    const g = e.target.closest('[data-go]');
    if (g) return go(g.dataset.go);
    const a = e.target.closest('[data-act]');
    const act = a?.dataset.act;
    if (act === 'prev' || act === 'next') { shiftPeriod(act === 'prev' ? -1 : 1); return render(); }
    if (act === 'retry') { loading = null; loadError = ''; render(); return ensure(); }
    if (act === 'add-txn') return txnSheet(null);
    if (act === 'add-bill') return billSheet(null);
    if (act === 'add-acct') return acctSheet(null);
    if (act === 'tx-more') { ui.txLimit += 200; return render(); }
    if (act === 'bulk-clear') { ui.txSel.clear(); return render(); }
    if (act === 'imp-again') { ui.imp = null; ui.impResult = null; return render(); }
    if (act === 'imp-map') { ui.imp.showMap = !ui.imp.showMap; return render(); }
    if (act === 'see-review') { ui.impResult = null; ui.imp = null; ui.txFilter = 'review'; return go('transactions'); }
    if (act === 'imp-go') {
      const items = ui.imp.items;
      await busy(async () => {
        ui.impResult = await fin.importItems(items, guessVendor, ui.impAccount || null);
        ui.imp = null;
      });
      return render();
    }
    const s = e.target.closest('[data-seg]');
    if (s) {
      if (s.dataset.seg === 'outSign') { ui.imp.outSign = s.dataset.v; await rebuildImport(); return; }
      ui[s.dataset.seg] = s.dataset.v;
      if (s.dataset.seg === 'spendBy') ui.spendPick = null;
      return render();
    }
    const f = e.target.closest('[data-txf]');
    if (f) { ui.txFilter = f.dataset.txf; ui.txSel.clear(); return render(); }
    const o = e.target.closest('[data-open]');
    if (o) return txnSheet(fin.txns.find((t) => t.id === o.dataset.open));
    const pk = e.target.closest('[data-pick]');
    if (pk) { ui.spendPick = ui.spendPick === pk.dataset.pick ? null : pk.dataset.pick; return render(); }
    const gr = e.target.closest('[data-grp]');
    if (gr) { const id = gr.dataset.grp; if (ui.openGroups.has(id)) ui.openGroups.delete(id); else ui.openGroups.add(id); return render(); }
    const paid = e.target.closest('[data-paid]');
    if (paid) {
      await busy(async () => {
        const r = await fin.markPaid(paid.dataset.paid, T());
        if (r) toast(`Added as an expense today. Next due ${mdy(r.nextDue)}.`);
      });
      return;
    }
    const ea = e.target.closest('[data-acct]');
    if (ea) return acctSheet(fin.account(ea.dataset.acct));
    const eb = e.target.closest('[data-bill]');
    if (eb) return billSheet(fin.bills.find((b) => b.id === eb.dataset.bill));
    const dr = e.target.closest('[data-delrule]');
    if (dr && confirm('Delete this rule? Transactions it filed keep their category.')) await busy(() => fin.deleteRule(dr.dataset.delrule));
  });
  root.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.id === 'finPeriod') {
      if (t.value === 'custom') setPeriod('custom', period.from, minK(period.to, T()));
      else if (t.value !== 'other') setPeriod(t.value);
      return render();
    }
    if (t.id === 'finFrom' || t.id === 'finTo') {
      const from = $('finFrom').value, to = $('finTo').value;
      if (from && to) setPeriod('custom', from, to);
      return render();
    }
    if (t.dataset.sel) { if (t.checked) ui.txSel.add(t.dataset.sel); else ui.txSel.delete(t.dataset.sel); return render(); }
    if (t.id === 'finBulkCat' && t.value) {
      const ids = [...ui.txSel];
      await busy(async () => { await fin.updateTxns(ids, { categoryId: t.value }); ui.txSel.clear(); toast(`Filed ${plural(ids.length, 'transaction')}.`); });
      return;
    }
    if (t.id === 'finTxCat') { ui.txCat = t.value; return render(); }
    if (t.id === 'finImpAcct') { ui.impAccount = t.value; return; }
    if (t.id === 'finFile' && t.files?.[0]) return readFile(t.files[0]);
    if (t.dataset.imp != null) { ui.imp.items[+t.dataset.imp].include = t.checked; return render(); }
    if (t.dataset.map) {
      const v = parseInt(t.value, 10);
      if (t.dataset.map === 'header') { ui.imp.header = v; ui.imp.map = detectColumns(ui.imp.rows[v]); } else {
        ui.imp.map[t.dataset.map] = v;
        if (t.dataset.map === 'amount' && v > -1) { ui.imp.map.debit = -1; ui.imp.map.credit = -1; }
        if ((t.dataset.map === 'debit' || t.dataset.map === 'credit') && v > -1) ui.imp.map.amount = -1;
      }
      ui.imp.showMap = true;
      return rebuildImport();
    }
    if (t.dataset.budget) {
      const v = t.value.trim() === '' ? null : dollarsIn(t.value);
      if (v != null && v < 0) return toast('A budget can\'t be negative.');
      await busy(() => fin.setBudget(t.dataset.budget, v));
    }
    if (t.id === 'finRuleCat') ui.ruleDraft.categoryId = t.value;
  });
  root.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'finSearch') {
      ui.txSearch = t.value;
      const pos = t.selectionStart;
      render();
      const s = $('finSearch'); s.focus(); s.setSelectionRange(pos, pos);
    }
    if (t.id === 'finRuleText') { ui.ruleDraft.matchText = t.value; $('finRuleCount').innerHTML = ruleCountText(t.value.trim().length >= 2 ? fin.ruleCount(t.value) : null); }
    if (t.id === 'finRuleVendor') ui.ruleDraft.vendor = t.value;
  });
  root.addEventListener('submit', async (e) => {
    if (e.target.id !== 'finRuleForm') return;
    e.preventDefault();
    const d = { matchText: $('finRuleText').value, vendor: $('finRuleVendor').value, categoryId: $('finRuleCat').value };
    if (d.matchText.trim().length < 2) return toast('Type at least 2 letters.');
    if (!d.categoryId) return toast('Pick a category.');
    await busy(async () => {
      const r = await fin.addRule(d);
      ui.ruleDraft = { matchText: '', vendor: '', categoryId: '' };
      toast(`Rule made. ${r.refiled ? `Filed ${plural(r.refiled, 'transaction')}.` : 'Nothing uncategorized matched.'}`);
    });
  });
  // drop a CSV on the import box (computers)
  root.addEventListener('dragover', (e) => { if (view === 'import' && e.target.closest('#finDrop')) { e.preventDefault(); e.target.closest('#finDrop').classList.add('over'); } });
  root.addEventListener('dragleave', (e) => e.target.closest?.('#finDrop')?.classList.remove('over'));
  root.addEventListener('drop', (e) => {
    if (view !== 'import' || !e.target.closest('#finDrop')) return;
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) readFile(f);
  });

  // ---------- monthly sales (sales_months, version 1.12.1) ----------
  // sales_days keeps about 100 days, so each month's totals are saved once the dashboard has every day of
  // it (complete), and the current month as it goes. Only with the owner's real data, never a less
  // complete row over a more complete one, and only when something changed.
  async function syncSalesMonths() {
    if (fin.mode !== 'supabase') return;
    await fin.saveSalesMonths(monthRowsToSave()).catch(() => {}); // no table yet, or no signal: next time
  }
  function monthRowsToSave() {
    const S = salesMap();
    const t = T(), thisMonth = monthStart(t);
    const monthsSeen = new Set([...S.keys()].map(monthStart));
    monthsSeen.add(thisMonth);
    const rows = [];
    for (const mk of monthsSeen) {
      if (mk > thisMonth) continue;
      const last = mk === thisMonth ? t : monthEnd(mk);
      const r = { month: mk, total: 0, instore_card: 0, instore_cash: 0, daysCounted: 0, complete: false };
      for (const [id] of CHANNELS) r[id] = 0;
      r.owner_clover = 0;
      for (let k = mk; k <= last; k = addDaysKey(k, 1)) {
        const s = S.get(k);
        if (!s?.have) continue;
        r.daysCounted++;
        r.total += s.total; r.instore_card += s.card; r.instore_cash += s.cash; r.owner_clover += s.ownerClover;
        for (const [id] of CHANNELS) r[id] += s.ch[id];
      }
      for (const a of appFees(mk, last).apps) r[`${a.id}_fees`] = a.fees;
      r.complete = mk < thisMonth && r.daysCounted === daysIn(mk);
      if (!r.complete && mk !== thisMonth) continue; // a past month with days missing: not saved
      const old = monthRow(mk);
      if (old?.complete && !r.complete) continue;
      if (old && old.daysCounted > r.daysCounted) continue;
      // saved again when the app fees changed too (1.13.0: Grubhub's payouts to the bank had counted as fees)
      if (old && old.total === r.total && old.daysCounted === r.daysCounted && old.complete === r.complete
        && APPS.every(([id]) => (old[`${id}_fees`] || 0) === (r[`${id}_fees`] || 0))) continue;
      rows.push(r);
    }
    return rows;
  }

  // ---------- loading ----------
  function ensure() {
    loading ||= (async () => {
      try {
        all = await store.load();
        salesDays = null; rateCache = null; cardRateCache = null;
        const since = addMonths(monthStart(T()), -24);
        fin = await openFinanceData({ supa, demo, fixtureUrl, today: T(), since });
        fin.onChange(() => { render(); badge(); });
        syncSalesMonths();
        loadError = '';
      } catch (e) {
        loadError = e.message || String(e);
        loading = null;
      }
      render();
      badge();
    })();
    return loading;
  }
  // the count of expenses without a category, on the Finances button
  function badge() {
    const n = uncategorizedCount();
    tabBtn.innerHTML = `Finances${n ? ` <span class="fin-badge in-tab">${n}</span>` : ''}`;
  }
  // sales changed (the dashboard reads them every 30 seconds): redraw, but not over something being typed or a sheet
  store.onChange?.(async () => {
    all = await store.load();
    salesDays = null; rateCache = null; cardRateCache = null;
    const typing = root.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
    if (active && fin && !sheet.open && !typing && view !== 'import') render();
  });

  // ---------- the Sales / Dough / Finances buttons at the top ----------
  // dashboard.js runs the Sales and Dough tabs; any tab that isn't Dough is Sales to it, so this runs
  // after it and takes over when Finances is picked.
  function show(on, save = true) {
    active = on;
    document.body.classList.toggle('tab-finance', on);
    if (on) {
      for (const b of document.querySelectorAll('#views button')) b.setAttribute('aria-pressed', b === tabBtn ? 'true' : 'false');
      document.getElementById('brandTitle').textContent = 'Lakewood finances';
      document.title = 'Can Am Finances';
      if (save) {
        try { localStorage.setItem('canam.tab', 'finance'); } catch { /* private mode */ }
        history.replaceState(history.state, '', `#finance/${view}`);
      }
      render();
      ensure();
    } else tabBtn.setAttribute('aria-pressed', 'false');
  }
  document.getElementById('views').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    show(b === tabBtn);
    if (b === tabBtn) scrollTo(0, 0);
  });
  addEventListener('hashchange', () => {
    const on = location.hash.startsWith('#finance');
    if (on) { const v = location.hash.split('/')[1]; if (VIEWS[v]) view = v; }
    show(on, false);
  });
  let saved = '';
  try { saved = localStorage.getItem('canam.tab') || ''; } catch { /* private mode */ }
  if (location.hash.startsWith('#finance')) { const v = location.hash.split('/')[1]; if (VIEWS[v]) view = v; show(true, false); }
  else if (!location.hash && saved === 'finance') show(true, false);
  else ensure(); // load quietly, so the Finances button shows how many need a category

  // for checking by hand (and the README's test steps): the numbers behind the Overview
  globalThis.canamFinance = { sums: (from, to) => sums(from, to), current: () => cur(), monthRowsToSave: () => monthRowsToSave(), get data() { return fin; }, go, setPeriod: (k, f, t) => { setPeriod(k, f, t); render(); } };
}
