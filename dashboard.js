import { CONFIG } from './config.js';
import { todayKey, addDays, weekStartOf, WEEK_ORDER, minuteOfDay, minuteClock, parseKey, daysBetween, zoned, dayKeyOf, weekdayOf, oldCloverMissing, kitchenItems, cardFeeOfDay } from './lib.js';
import { doughName } from './dough.js';
import { doughEngine, DOUGH_SIZES, MIX_TIME, MIX_READY, DOUGH_RISE, COVER_UNTIL, DAY_END, OPENS, CLOSES, DOUGH_LEARN_DAYS, sumOf, relMinute,
  PM_DECIDE, PM_MIX_TIME, PM_MIX_BY, PM_READY, BUSY_FROM, BUSY_UNTIL, AM_COVER } from './dough-plan.js';
import { FORECAST_FROM, PROMO_DAYS, expectedSales, walkRatios, SLOTS } from './forecast.js';
import { loginEmail, loginLabel } from './login-name.js';

const TZ = CONFIG.timeZone;
const IN_EXTENSION = !!(globalThis.chrome?.storage?.local && globalThis.chrome?.runtime?.id);
// The phone page (phone/phone.js) signs in first, then hands over a store that reads from Supabase.
const REMOTE = !IN_EXTENSION && !!globalThis.canamRemoteStore;
const ADDON_PLACE = REMOTE ? 'in Chrome on the computer that runs the add-on' : 'in this Chrome window';

// Fixed order = fixed colors. A channel keeps its color no matter what is showing.
const CHANNELS = [
  { id: 'instore', name: 'In-store', note: 'Clover · card & cash', src: 'clover', cls: 's1', site: CONFIG.clover.home },
  { id: 'doordash', name: 'DoorDash', src: 'doordash', cls: 's2', site: CONFIG.doordash.home, status: 'doordash' },
  { id: 'uber', name: 'Uber Eats', src: 'uber', cls: 's3', site: CONFIG.uber.home, status: 'uber' },
  { id: 'owner', name: 'Website & app', note: 'Owner', src: 'owner', cls: 's4', site: CONFIG.owner.home },
  { id: 'grubhub', name: 'Grubhub', src: 'grubhub', cls: 's5', site: CONFIG.grubhub.home, status: 'grubhub' },
  { id: 'other', name: 'Other apps', note: 'via Clover', src: 'clover', cls: 's6', optional: true },
];
const byId = Object.fromEntries(CHANNELS.map((c) => [c.id, c]));

// "Last month" while it's October 2026: [month it applies in, first day, last day] (see rangeFor).
const LAST_MONTH_OCT = ['2026-10', '2026-09-21', '2026-10-21'];
// The "September" button (Sep 1–30), shown only in October 2026 (owner, 2026-10-22).
const SEPTEMBER = ['2026-10', '2026-09-01', '2026-09-30'];
const showSeptember = () => todayKey().slice(0, 7) === SEPTEMBER[0];

// ---------- data source ----------
function extensionStore() {
  return {
    load: () => chrome.storage.local.get(null),
    onChange: (cb) => chrome.storage.onChanged.addListener((_c, area) => { if (area === 'local') cb(); }),
    refresh: () => chrome.runtime.sendMessage({ type: 'refresh' }),
    set: (items) => chrome.storage.local.set(items),
    remove: (keys) => chrome.storage.local.remove(keys),
    // dough counts: saved by the add-on, which also sends them to the phone page
    saveDough: async (day, batch, counts) => {
      const r = await chrome.runtime.sendMessage({ type: 'doughSave', day, batch, counts });
      if (!r?.ok) throw new Error(r?.error || 'the add-on didn\'t answer');
    },
    // employee logins, through the add-on's phone page sign-in (the owner's)
    kitchenLogins: async (body) => {
      const r = await chrome.runtime.sendMessage({ type: 'kitchenLogins', body });
      if (!r?.ok) throw new Error(r?.error || 'the add-on didn\'t answer');
      return r.r;
    },
  };
}
const store = IN_EXTENSION ? extensionStore()
  : REMOTE ? globalThis.canamRemoteStore
  : (await import('./preview-data.js')).makePreviewStore();
let data = {};
// An employee (kitchen) login on the phone page: the Dough tab only. Its store never reads the
// money tables, and the database wouldn't give it anything from them anyway.
const KITCHEN = REMOTE && !!store.kitchen;
document.body.classList.toggle('kitchen', KITCHEN);

// ---------- formatting ----------
const money = (c) => (c < 0 ? '−$' : '$') + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const moneyShort = (c) => {
  const d = Math.abs(c) / 100;
  const s = d >= 10000 ? (d / 1000).toFixed(1).replace(/\.0$/, '') + 'K' : Math.round(d).toLocaleString('en-US');
  return (c < 0 ? '−$' : '$') + s;
};
const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const dayTimeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' });
const keyDate = (k) => { const { y, m, d } = parseKey(k); return new Date(Date.UTC(y, m - 1, d, 12)); };
const longDay = (k) => keyDate(k).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' });
const shortDay = (k) => keyDate(k).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
const monthDay = (k) => keyDate(k).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
const monthName = (k) => keyDate(k).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long' });
const weekdayName = (k) => keyDate(k).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long' });
const wd3 = (k) => keyDate(k).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

// ---------- reading the stored days ----------
function rec(key, ch) {
  if (ch === 'owner') {
    const own = data[`d:${key}:owner`];
    if (own) return own;
    const viaClover = data[`d:${key}:owner_clover`];
    return viaClover ? { ...viaClover, viaClover: true } : null;
  }
  return data[`d:${key}:${ch}`] || null;
}

// Card-processing fee rates (config.js; the phone page gets the same ones).
const CARD_FEES = CONFIG.cardFees || null;
const CARD_CHANNELS = new Set(['instore', 'owner']);

// cutoff = minute of the day; only orders up to that time count (for fair "so far" comparisons)
function dayTotals(key, ch, cutoff) {
  const r = rec(key, ch);
  if (!r) return null;
  // estimated card fees (in-store and website & app, version 1.13.0)
  const card = CARD_CHANNELS.has(ch) ? cardFeeOfDay(ch, r, CARD_FEES) : { fee: 0, est: false };
  if (cutoff == null) return { sales: r.sales, orders: r.orders, extra: r.extra || {}, viaClover: r.viaClover, cardFee: card.fee, cardEst: card.est };
  let sales = 0, orders = 0;
  for (const o of r.list || []) {
    if (o.cancelled || minuteOfDay(o.t) > cutoff) continue;
    sales += o.amt;
    if (!o.refund) orders += 1;
  }
  // up to that time of day: the day's card fees in proportion to its sales so far
  const cardFee = r.sales > 0 ? Math.round((card.fee * Math.max(0, sales)) / r.sales) : 0;
  return { sales, orders, extra: {}, viaClover: r.viaClover, cardFee, cardEst: card.est };
}

function totals(days, cutoffs = {}) {
  const out = {};
  for (const c of CHANNELS) {
    const t = { sales: 0, orders: 0, extra: {}, have: 0, payDays: 0, viaClover: false, cardFee: 0, cardEst: false };
    for (const k of days) {
      const d = dayTotals(k, c.id, cutoffs[k]);
      if (!d) continue;
      t.have += 1;
      if (d.extra.payout != null || (!d.sales && !d.orders)) t.payDays += 1; // days whose payout is known
      t.sales += d.sales;
      t.orders += d.orders;
      t.viaClover ||= !!d.viaClover;
      t.cardFee += d.cardFee || 0;
      t.cardEst ||= !!(d.cardFee && d.cardEst);
      for (const [x, v] of Object.entries(d.extra)) t.extra[x] = (t.extra[x] || 0) + v;
    }
    t.missing = t.have === 0;
    out[c.id] = t;
  }
  return out;
}

// True when every one of these days has been read (the add-on keeps about two months).
const covered = (days) => days.every((k) => data[`d:${k}:instore`] || data[`d:${k}:doordash`]);

// ---------- what you actually get paid ----------
// DoorDash, Uber Eats and Grubhub each report what they pay after their commission and fees,
// the promotions and ads you run there and refunds (extra.payout), and which sales
// that covers (extra.paidSales). Orders they haven't finished yet (still being made or delivered)
// are estimated at the app's usual rate. The website & app (Owner) has no per-order commission; what
// comes off in-store and website & app sales is the card-processing fee (version 1.13.0): Owner's own
// fee per order, and for Clover an estimate at the rate in config.js (cardFees).
const PAYOUT_APPS = new Set(['doordash', 'uber', 'grubhub']);
const PAYOUT_REPORT = { doordash: 'Financials → Transactions', uber: 'Financials → Earnings', grubhub: 'Financials → Transactions' };

// The share of sales an app paid out over the last 30 days.
function recentRate(ch) {
  let pay = 0, paid = 0;
  for (let i = 0; i < 30; i++) {
    const x = rec(addDays(todayKey(), -i), ch)?.extra;
    if (x?.payout == null || !(x.paidSales > 0)) continue;
    pay += x.payout;
    paid += x.paidSales;
  }
  return paid > 0 ? pay / paid : null;
}

// { get, fees, approx, card } for one channel's totals, or null while the app's payouts haven't been read.
// card = true when the fees are card-processing fees (in-store, website & app).
function takeHome(id, t) {
  if (CARD_CHANNELS.has(id)) return { get: t.sales - (t.cardFee || 0), fees: t.cardFee || 0, approx: !!t.cardEst, card: true };
  if (!PAYOUT_APPS.has(id)) return { get: t.sales, fees: 0, approx: false };
  if (t.missing || t.payDays < t.have) return null;
  const x = t.extra;
  const pending = Math.max(0, t.sales - (x.paidSales || 0));
  let get = x.payout || 0;
  if (pending) {
    const rate = recentRate(id) ?? (x.paidSales > 0 ? x.payout / x.paidSales : null);
    if (rate == null) return null;
    get += Math.round(pending * rate);
  }
  return { get, fees: t.sales - get, approx: pending > 0 };
}

// Take-home for several channels together; an app whose payouts aren't read yet is estimated.
// fees = appFees (delivery apps) + cardFees (in-store and website & app card processing).
function takeHomeOf(chans, tot) {
  const out = { get: 0, fees: 0, appFees: 0, cardFees: 0, cardEst: false, appSales: 0, approx: false, unknown: false };
  for (const c of chans) {
    const t = tot[c.id];
    if (t.missing) continue;
    let th = takeHome(c.id, t);
    if (!th) {
      const rate = recentRate(c.id);
      if (rate == null) { out.unknown = true; continue; }
      const get = Math.round(t.sales * rate);
      th = { get, fees: t.sales - get, approx: true };
    }
    out.get += th.get;
    out.fees += th.fees;
    if (th.card) { out.cardFees += th.fees; out.cardEst ||= th.approx; } else out.appFees += th.fees;
    out.approx ||= th.approx;
    if (PAYOUT_APPS.has(c.id)) out.appSales += t.sales;
  }
  return out;
}

// The line under each sales box.
function payLine(c, t) {
  if (!(PAYOUT_APPS.has(c.id) || CARD_CHANNELS.has(c.id)) || t.sales <= 0) return '';
  const th = takeHome(c.id, t);
  if (!th) return `Checking what ${c.name} pays…`;
  return `You get <b>${th.approx ? '≈ ' : ''}${money(th.get)}</b> · <span class="nw">${th.card ? 'card fees' : 'fees'} ${money(th.fees)} (${pct(th.fees, t.sales)}%)</span>`;
}

// The tooltip on the In-store and Website & app boxes: where their card fees come from.
function cardFeeTip(id, t) {
  const R = CARD_FEES;
  if (!R) return '';
  if (id === 'instore') return `Estimated card fees: ${R.clover.label}, on what was charged to each card (tax and tip included). Cash has no fee.`;
  if (t?.viaClover) return `Estimated card fees: ${R.owner.label}, on what each card was charged.`;
  return `Card fees are Owner's own fee per order (${R.owner.pct}% + ${R.owner.cents}¢ of what the card was charged). Owner's 5% online fee is paid by the guest and isn't in sales.`;
}

// ---------- the selected date range ----------
let view = { type: 'today' };

// "Wed, Oct 14" for one day; "Oct 12–14" or "Sep 28 – Oct 4" for several.
const daysText = (days) => (days.length === 1 ? shortDay(days[0]) : rangeText([days[0], days[days.length - 1]]));

// Every range carries its dates (when) and the dates it is compared with (cmpWhen), so
// "this month", "yesterday" and so on are never shown without the actual days.
function rangeFor(v) {
  if (v.type === 'september' && !showSeptember()) v = { type: 'today' }; // only in October 2026
  const T = todayKey();
  const now = minuteOfDay(Date.now());
  const one = (k, name) => {
    const prev = addDays(k, -7);
    const isToday = k === T;
    const when = shortDay(k);
    return {
      days: [k], cmp: [prev], cutoffs: isToday ? { [prev]: now } : {},
      when, cmpWhen: shortDay(prev),
      cmpLabel: `vs last ${weekdayName(k)} (${monthDay(prev)})${isToday ? ' by this time' : ''}`,
      cmpShort: `vs ${shortDay(prev)}`,
      hero: name ? `Total sales ${name} · ${when}` : `Total sales · ${longDay(k)}`,
      ordersTitle: name ? `${name === 'today' ? "Today's" : "Yesterday's"} orders · ${when}` : `Orders · ${longDay(k)}`,
      multi: false,
    };
  };
  if (v.type === 'today') return one(T, 'today');
  if (v.type === 'yesterday') return one(addDays(T, -1), 'yesterday');
  if (v.type === 'day') return one(v.key, v.key === T ? 'today' : v.key === addDays(T, -1) ? 'yesterday' : null);
  if (v.type === 'september') {
    // Sep 1–30, 2026, in full: in-store up to Sep 25 morning from Clover's old account too. Nothing to
    // compare it with (August's in-store isn't counted).
    const [, start, end] = SEPTEMBER;
    const days = Array.from({ length: daysBetween(start, end) + 1 }, (_, i) => addDays(start, i));
    const when = daysText(days);
    return {
      days, cmp: [], noCompare: true, when, cmpWhen: '', cutoffs: {}, cmpLabel: '', cmpShort: '',
      hero: `Total sales in September · ${when}`, ordersTitle: `Orders in September · ${when}`, multi: true,
    };
  }
  if (v.type === 'lastmonth' && T.slice(0, 7) === LAST_MONTH_OCT[0]) {
    // October 2026 only (owner, 2026-10-22): "Last month" is Sep 21 – Oct 21, with in-store for Sep 21–25
    // partly from Clover's old account (CLOVER_OLD in sources.js). Nothing to compare it with: in-store
    // sales before Sep 21 aren't counted. From November 1 it's the calendar month again.
    const [, start, end] = LAST_MONTH_OCT;
    const days = Array.from({ length: daysBetween(start, end) + 1 }, (_, i) => addDays(start, i));
    const when = daysText(days);
    return {
      days, cmp: [], noCompare: true, when, cmpWhen: '', cutoffs: {}, cmpLabel: '', cmpShort: '',
      hero: `Total sales · ${when}`, ordersTitle: `Orders · ${when}`, multi: true,
    };
  }
  if (v.type === 'month' || v.type === 'lastmonth') {
    // This month = the 1st to today, compared with the same number of days last month, up to this
    // time of day: from the 1st, or, on the 29th–31st when last month was shorter, the days up to its
    // last day (Oct 31: Aug 31 – Sep 30), so it's never more days against fewer (version 1.10.0).
    // Last month = the whole month, compared with the whole month before.
    const thisMonth = v.type === 'month';
    const firstOfThis = `${T.slice(0, 8)}01`;
    const start = thisMonth ? firstOfThis : `${addDays(firstOfThis, -1).slice(0, 8)}01`;
    const end = thisMonth ? T : addDays(firstOfThis, -1);
    const days = Array.from({ length: daysBetween(start, end) + 1 }, (_, i) => addDays(start, i));
    const prevStart = `${addDays(start, -1).slice(0, 8)}01`;
    const prevEnd = addDays(start, -1);
    const prevLen = daysBetween(prevStart, prevEnd) + 1;
    const n = days.length;
    const cmpEnd = thisMonth ? (n <= prevLen ? addDays(prevStart, n - 1) : prevEnd) : prevEnd;
    const cmpLen = thisMonth ? n : prevLen;
    const cmp = Array.from({ length: cmpLen }, (_, i) => addDays(cmpEnd, i - cmpLen + 1));
    const shifted = thisMonth && n > prevLen;
    const month = monthName(start);
    const when = daysText(days), cmpWhen = daysText(cmp);
    return {
      days, cmp, when, cmpWhen,
      cutoffs: thisMonth ? { [cmpEnd]: now } : {},
      cmpLabel: thisMonth
        ? `vs ${shifted ? `${cmpWhen} (the same ${n} days)` : `last month (${cmpWhen})`} at this point`
        : `vs ${monthName(prevStart)} (${cmpWhen})`,
      cmpShort: `vs ${cmpWhen}`,
      hero: thisMonth ? `Total sales this month · ${when}` : `Total sales in ${month} · ${when}`,
      ordersTitle: thisMonth ? `This month's orders · ${when}` : `Orders in ${month} · ${when}`,
      multi: true,
    };
  }
  // business weeks run Tuesday–Monday (weekStartOf); "at this point" compares Tuesday to today with the same days a week earlier
  const thisWeek = v.type === 'week';
  const start = thisWeek ? weekStartOf(T) : addDays(weekStartOf(T), -7);
  const n = thisWeek ? daysBetween(start, T) + 1 : 7;
  const days = Array.from({ length: n }, (_, i) => addDays(start, i));
  const cmp = days.map((k) => addDays(k, -7));
  const when = daysText(days), cmpWhen = daysText(cmp);
  return {
    days, cmp, when, cmpWhen,
    cutoffs: thisWeek ? { [addDays(T, -7)]: now } : {},
    cmpLabel: thisWeek ? `vs last week (${cmpWhen}) at this point` : `vs the week before (${cmpWhen})`,
    cmpShort: `vs ${cmpWhen}`,
    hero: thisWeek ? `Total sales this week · ${when}` : `Total sales last week · ${when}`,
    ordersTitle: thisWeek ? `This week's orders · ${when}` : `Last week's orders · ${when}`,
    multi: true,
  };
}

function deltaHtml(cur, prev, label) {
  if (!prev) return '';
  const pct = Math.round(((cur - prev) / Math.abs(prev)) * 100);
  if (pct === 0) return `<span class="delta flat">Same as ${esc(label.replace(/^vs (the )?/, ''))}</span>`;
  const up = pct > 0;
  return `<span class="delta ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(pct)}% <span class="flat">${esc(label)}</span></span>`;
}

// ---------- status of each site ----------
// health:<site> is how today's orders were read (version 1.10.0); the other checks (past days, items,
// payouts, open/paused status, scheduled orders, new customers) keep their own records, so one that
// worked can't hide that today's orders didn't. A sign-in or token problem another check ran into
// after today's orders last worked still shows.
const HEALTH_JOBS = ['history', 'items', 'payouts', 'status', 'upcoming', 'customers'];
function health(src) {
  const h = data[`health:${src}`] || null;
  for (const j of HEALTH_JOBS) {
    const x = data[`health:${src}:${j}`];
    if ((x?.state === 'signin' || x?.state === 'token') && x.failedAt > (h?.at || 0) && !(x.at > x.failedAt)) return x;
  }
  return h;
}
// When today's orders from a site last came through, if that's more than 10 minutes ago while the
// add-on is otherwise checking (-1: not yet today); null when they're current. When the add-on has
// stopped altogether, the "Numbers haven't updated" warning says so instead.
const STALE_MS = 10 * 60 * 1000;
function ordersStaleSince(src) {
  const h = data[`health:${src}`];
  if (!h || !data.lastRefresh || Date.now() - data.lastRefresh > 5 * 60 * 1000) return null;
  if (!h.at) return -1;
  return Date.now() - h.at > STALE_MS ? h.at : null;
}
const tileSrc = (c) => (c.src === 'owner' && !data['health:owner'] ? 'clover' : c.src);

function chipFor(c) {
  const h = health(tileSrc(c));
  if (h?.state === 'signin') return '<span class="chip signin">Sign in</span>';
  if (h?.state === 'token') return '<span class="chip signin">Check token</span>';
  if (!c.status) return '';
  const s = data[`store:${c.status}`];
  if (!s || Date.now() - s.at > 15 * 60 * 1000) return '';
  if (s.state === 'paused' && (!s.until || s.until > Date.now())) return '<span class="chip paused">Paused</span>';
  if (s.state === 'closed') return '<span class="chip closed">Closed</span>';
  if (s.state === 'busy' && (!s.until || s.until > Date.now())) return '<span class="chip busy">Busy</span>';
  if (s.state === 'open') return '<span class="chip open">Open</span>';
  return '';
}

function renderAlerts(dough) {
  const out = [];
  if (KITCHEN) {
    // kitchen logins only need to know when the dough numbers stop updating
    const at = Math.min(data.lastRefresh || 0, data.cloverAt || data.lastRefresh || 0);
    if (at && Date.now() - at > 10 * 60 * 1000) {
      const when = dayKeyOf(at) === todayKey() ? timeFmt.format(at) : dayTimeFmt.format(at);
      out.push(alertHtml('warning', '!', `<b>The dough numbers haven't updated since ${when}.</b> The store computer may be off, asleep or signed out of Clover. Tell the owner.`));
    }
    document.getElementById('alerts').innerHTML = out.join('');
    return;
  }
  const doughWarning = doughAlert(dough);
  if (doughWarning) out.push(doughWarning);
  for (const id of ['doordash', 'uber']) {
    const s = data[`store:${id}`];
    const c = byId[id];
    if (!s || Date.now() - s.at > 15 * 60 * 1000) continue;
    if (s.state === 'paused' && (!s.until || s.until > Date.now())) {
      const until = s.until ? ` until ${timeFmt.format(s.until)}${dayKeyOf(s.until) !== todayKey() ? ' ' + wd3(dayKeyOf(s.until)) : ''}` : '';
      out.push(alertHtml('critical', '!', `<b>${c.name} is paused${until}.</b> Customers can't order from you there right now. If that isn't on purpose, turn it back on in OrderOut.`,
        CONFIG[id].statusPage, `Open ${c.name}`));
    }
  }
  const gh = data['store:grubhub'];
  if (gh && Date.now() - gh.at < 15 * 60 * 1000 && gh.state === 'busy' && (!gh.until || gh.until > Date.now())) {
    out.push(alertHtml('info', 'i', `<b>Grubhub is set to busy${gh.until ? ` until ${timeFmt.format(gh.until)}` : ''}.</b> Customers see a longer wait there.`,
      CONFIG.grubhub.statusPage, 'Open Grubhub'));
  }
  for (const src of ['clover', 'doordash', 'uber', 'owner', 'grubhub']) {
    const h = health(src);
    if (!h) continue;
    const name = CONFIG[src].label;
    if (h.state === 'signin') {
      const tip = src === 'clover' && !data.cloverToken && !REMOTE ? ' To stop this happening, add a Clover API token under Connections below.' : '';
      out.push(alertHtml('warning', '!', `<b>${name} signed you out.</b> Sign in again ${ADDON_PLACE} and the numbers will start updating by themselves.${tip}`,
        REMOTE ? null : CONFIG[src].home, `Sign in to ${name}`));
    } else if (h.state === 'token') {
      out.push(alertHtml('warning', '!', `<b>Clover API token problem.</b> ${esc(h.message)}`, REMOTE ? null : CONFIG.clover.tokenPage, 'Open Clover settings'));
    } else if (h.state === 'busy' && (!h.at || h.failedAt > h.at)) {
      out.push(alertHtml('info', 'i', `${esc(h.message)} Numbers already shown stay as they are.`));
    } else if (h.state === 'error' && (!h.at || h.failedAt > h.at)) {
      out.push(alertHtml('info', 'i', `Couldn't update ${name} just now (${esc(h.message)}). Trying again every minute.`));
    }
  }
  if (newerVersion) {
    out.push(alertHtml('info', 'i', `<b>A newer version of the add-on (${esc(newerVersion)}) is ready.</b> Click the button to switch to it; this page closes and reopens by itself in a few seconds.`,
      null, 'Update add-on', 'update-addon'));
  }
  const last = data.lastRefresh;
  if ((IN_EXTENSION || REMOTE) && last && Date.now() - last > 5 * 60 * 1000) {
    const when = dayKeyOf(last) === todayKey() ? timeFmt.format(last) : dayTimeFmt.format(last);
    out.push(alertHtml('warning', '!', `<b>Numbers haven't updated since ${when}.</b> ${REMOTE
      ? 'Chrome on the computer that runs the add-on may be closed, asleep or offline.'
      : 'Keep Chrome open on this computer so the add-on can keep checking.'}`));
  }
  const oldMissing = showSeptember() ? (!REMOTE ? oldCloverMissing(data) : data.cloverOldMissing || []) : [];
  if (oldMissing.length) {
    const days = oldMissing.length === 1 ? shortDay(oldMissing[0]) : rangeText([oldMissing[0], oldMissing[oldMissing.length - 1]]);
    out.push(alertHtml('info', 'i', `<b>In-store sales for ${esc(days)} aren't counted yet.</b> They're on Clover's old account, which needs you signed in to the Clover website ${ADDON_PLACE} (the API token only covers CAN AM PIZZA). Sign in and leave the Clover tab open; they're read within 30 minutes.`,
      REMOTE ? null : CONFIG.clover.home, 'Sign in to Clover'));
  }
  if (IN_EXTENSION && !data.phoneAuth && data.phoneSync?.state === 'signin') {
    out.push(alertHtml('warning', '!', '<b>The phone page stopped getting new numbers.</b> Sign in again under Connections → See these numbers on your phone.'));
  }
  document.getElementById('alerts').innerHTML = out.join('');
}

// href = a link button to the site; action = a button that does something on this page instead
function alertHtml(level, icon, msg, href, btn, action) {
  const button = action ? `<button class="btn" type="button" data-action="${esc(action)}">${esc(btn)}</button>`
    : href ? `<a class="btn" href="${esc(href)}" target="_blank" rel="noopener">${esc(btn)}</a>` : '';
  return `<div class="alert ${level}"><span class="ico" aria-hidden="true">${icon}</span><div class="msg">${msg}</div>${button}</div>`;
}

// ---------- expected sales today (owner only, version 1.19.0) ----------
// What today is likely to bring in by closing, per channel and in all: what has come in so far plus a
// usual rest of the day, worked out the same way as the dough (forecast.js: the last 3 weeks' level ×
// how that weekday usually compares × the time of day sales come in; days from 2026-09-25 on, promo
// days left out). The likely range comes from how the morning's number did on past days; it's left
// out until there are enough of those. Never worked out for a kitchen login (it has no sales).
const wholeDollars = (c) => `$${Math.round(c / 100).toLocaleString('en-US')}`;
let salesMemo = { data: null, T: '', chans: null, ratios: null };
function expectedToday() {
  if (KITCHEN) return null;
  const T = todayKey();
  if (salesMemo.data !== data || salesMemo.T !== T) {
    const memo = new Map();
    const seriesOf = (ch) => (k) => {
      const key = `${ch}:${k}`;
      if (!memo.has(key)) {
        const r = k >= FORECAST_FROM ? rec(k, ch) : null;
        let day = null;
        if (r) {
          const slots = new Array(SLOTS).fill(0);
          for (const o of r.list || []) if (!o.cancelled) slots[Math.max(0, Math.min(SLOTS - 1, Math.floor(minuteOfDay(o.t) / 15)))] += o.amt;
          day = { total: r.sales || 0, slots };
        }
        memo.set(key, day);
      }
      return memo.get(key);
    };
    const chans = CHANNELS.map((c) => ({ id: c.id, series: seriesOf(c.id) }));
    salesMemo = { data, T, chans, ratios: walkRatios(T, chans.map((c) => c.series)) };
  }
  return expectedSales(T, minuteOfDay(Date.now()), salesMemo.chans.map((c) => ({ ...c, soFar: dayTotals(T, c.id)?.sales || 0 })), salesMemo.ratios);
}

// ---------- hero + tiles ----------
function visibleChannels(dayList) {
  return CHANNELS.filter((c) => !c.optional || dayList.some((k) => (rec(k, c.id)?.orders || 0) > 0));
}

function renderSummary(r) {
  const cur = totals(r.days);
  const prev = totals(r.cmp, r.cutoffs);
  if (r.noCompare || !covered(r.cmp)) for (const id of Object.keys(prev)) prev[id].missing = true; // partly before the saved history
  const shown = visibleChannels(r.days);
  const anyData = shown.some((c) => !cur[c.id].missing);

  const sales = shown.reduce((a, c) => a + cur[c.id].sales, 0);
  const orders = shown.reduce((a, c) => a + cur[c.id].orders, 0);
  const prevSales = shown.reduce((a, c) => a + prev[c.id].sales, 0);
  const prevHave = shown.some((c) => !prev[c.id].missing);

  // cancelled orders are in the order list but not in the count, so the count says how many there were
  let cancelled = 0;
  for (const k of r.days) for (const c of shown) for (const o of rec(k, c.id)?.list || []) if (o.cancelled) cancelled += 1;
  // Today, after midnight and before opening: say the store is closed, and compare with the whole of
  // last week's day instead of "by this time" (which would be nothing against nothing)
  const T = todayKey();
  const opens = OPENS[weekdayOf(T)];
  const closedNow = anyData && r.days.length === 1 && r.days[0] === T && minuteOfDay(Date.now()) < opens && !orders;
  document.getElementById('heroLabel').textContent = r.hero;
  document.getElementById('heroValue').textContent = anyData ? money(sales) : '—';
  document.getElementById('heroOrders').textContent = !anyData ? 'Getting the first numbers… this takes about a minute the first time.'
    : closedNow ? `Closed · opens ${minuteClock(opens).replace(':00 ', ' ')}`
    : `${orders} order${orders === 1 ? '' : 's'}${cancelled ? ` · ${cancelled} cancelled` : ''}${orders ? ` · avg ${money(Math.round(sales / orders))}` : ''}`;
  let heroDelta = anyData && prevHave ? deltaHtml(sales, prevSales, r.cmpLabel) : '';
  if (closedNow) {
    const all = totals(r.cmp);
    const whole = shown.reduce((a, c) => a + all[c.id].sales, 0);
    heroDelta = prevHave && whole > 0 ? `<span class="delta flat">Last ${esc(weekdayName(r.cmp[0]))} (${esc(monthDay(r.cmp[0]))}): ${money(whole)} all day</span>` : '';
  }
  document.getElementById('heroDelta').innerHTML = heroDelta;
  const th = takeHomeOf(shown, cur);
  const feeParts = [th.appFees ? `${money(th.appFees)} app fees` : '', th.cardFees ? `${money(th.cardFees)} ${th.cardEst ? 'estimated ' : ''}card fees` : ''].filter(Boolean);
  document.getElementById('heroPay').innerHTML = anyData && sales > 0 && !th.unknown
    ? `You keep about <b>${money(th.get)}</b> after app and card fees${feeParts.length ? ` (${feeParts.join(' + ')})` : ''}.`
    : '';

  // expected sales by closing (version 1.19.0): only for today, while the store day is still going
  const nowMin = minuteOfDay(Date.now());
  const exp = anyData && r.days.length === 1 && r.days[0] === T && nowMin < CLOSES[weekdayOf(T)] ? expectedToday() : null;
  document.getElementById('heroExpect').innerHTML = exp
    ? `Expected today (${shortDay(T)}): about <b>${wholeDollars(exp.expect)}</b>${exp.range ? ` <span class="nw">· likely ${wholeDollars(exp.range[0])} to ${wholeDollars(exp.range[1])}</span>` : ''} <span class="nw">· ${wholeDollars(exp.soFar)} so far</span>${
      exp.days < 7 ? ` <span class="nw">(an early guess: ${exp.days} day${exp.days === 1 ? '' : 's'} of history)</span>` : ''}`
    : '';
  const expOf = Object.fromEntries((exp?.channels || []).filter((c) => c.known).map((c) => [c.id, c.expect]));

  const tiles = document.getElementById('tiles');
  tiles.classList.toggle('five', shown.length === 5);
  tiles.innerHTML = shown.map((c) => {
    const t = cur[c.id], p = prev[c.id];
    const h = health(tileSrc(c));
    const staleAt = r.days.includes(T) ? ordersStaleSince(tileSrc(c)) : null;
    const stale = staleAt == null ? ''
      : `<div class="tile-stale"><span aria-hidden="true">!</span> ${staleAt > 0 ? `Today's orders last came in at ${timeFmt.format(staleAt)}` : 'Today\'s orders haven\'t come in yet'}</div>`;
    let note = c.note || '';
    if (c.id === 'owner' && t.viaClover) note = 'Owner · from Clover for now';
    let body;
    if (t.missing) {
      body = `<div class="tile-value loading">${h?.state === 'signin' ? 'Needs sign-in' : h?.state === 'error' ? 'Not available yet' : 'Loading…'}</div>`;
    } else {
      const share = sales > 0 ? Math.round((t.sales / sales) * 100) : 0;
      let extra = '';
      if (c.id === 'instore' && (t.extra.card || t.extra.cash)) extra = `Card ${money(t.extra.card || 0)} · Cash ${money(t.extra.cash || 0)}`;
      const pay = payLine(c, t);
      body = `<div class="tile-value">${money(t.sales)}</div>
        <div class="tile-sub">${t.orders} order${t.orders === 1 ? '' : 's'}${t.orders ? ` · avg ${money(Math.round(t.sales / t.orders))}` : ''} · ${share}% of sales</div>
        ${p.missing ? '' : `<div class="tile-delta">${deltaHtml(t.sales, p.sales, r.cmpShort)}</div>`}
        ${extra ? `<div class="tile-extra">${extra}</div>` : ''}
        ${expOf[c.id] != null ? `<div class="tile-extra tile-expect">Expected by closing: about ${wholeDollars(expOf[c.id])}</div>` : ''}
        ${pay ? `<div class="tile-pay">${pay}</div>` : ''}`;
    }
    body += stale;
    const tip = CARD_CHANNELS.has(c.id) && !t.missing && t.sales > 0 ? ` ${cardFeeTip(c.id, t)}` : '';
    return `<article class="tile" data-ch="${c.id}" tabindex="0" role="button" title="See what sold on ${c.name}${tip ? `.${esc(tip)}` : ''}">
      <div class="tile-head"><span class="tile-title"><span class="swatch ${c.cls}"></span><span class="tile-name">${c.name}</span></span>${chipFor(c)}</div>
      ${note ? `<div class="tile-note">${esc(note)}</div>` : ''}
      ${body}
      <span class="tile-go"><span class="tile-go-text">What sold</span> <span aria-hidden="true">›</span></span>
    </article>`;
  }).join('');
}

// ---------- new customers (each app's own count, checked every few hours) ----------
// "Oct 5–11", "Sep 15 – Oct 14"
function rangeText([a, b]) {
  const mon = (k) => keyDate(k).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short' });
  const A = parseKey(a), B = parseKey(b);
  return A.m === B.m ? `${mon(a)} ${A.d}–${B.d}` : `${mon(a)} ${A.d} – ${mon(b)} ${B.d}`;
}

function renderNewCustomers() {
  const nc = data.customers;
  const card = document.getElementById('newCustCard');
  card.hidden = !nc && !IN_EXTENSION;
  if (card.hidden) return;
  document.getElementById('newCust').innerHTML = ['doordash', 'uber', 'owner'].map((id) => {
    const c = byId[id];
    const r = nc?.[id];
    const stat = (n, i, label) => {
      const when = r?.ranges?.[i] ? rangeText(r.ranges[i]) : r?.labels?.[i] || '';
      return `<div class="nc-stat"><div class="nc-label">${label}</div>${n
        ? `<div class="nc-num">${n.new}<small> new</small></div><div class="nc-sub">of ${n.total} customer${n.total === 1 ? '' : 's'}</div>${when ? `<div class="nc-when">${esc(when)}</div>` : ''}`
        : `<div class="nc-sub">${r ? 'Not available' : 'Checking…'}</div>`}</div>`;
    };
    return `<div class="nc-card"><div class="nc-name"><span class="swatch ${c.cls}"></span>${c.name}</div>
      <div class="nc-stats">${id === 'doordash'
        ? `${stat(r?.week, 0, 'DoorDash’s last week (Mon–Sun)')}${stat(r?.month, 1, 'DoorDash’s last month')}`
        : `${stat(r?.week, 0, 'Last 7 days')}${stat(r?.month, 1, 'Last 30 days')}`}</div></div>`;
  }).join('');
  const times = ['doordash', 'uber', 'owner'].map((id) => nc?.[id]?.at).filter(Boolean);
  document.getElementById('newCustAge').textContent = times.length ? `Checked ${ago(Math.min(...times))}` : '';
}

// ---------- 14-day chart ----------
const chartEl = document.getElementById('chart');
const tip = document.getElementById('tooltip');
let showTable = false;

function niceStep(max) {
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

function topRounded(x, y, w, h, r) {
  r = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function chartDays() {
  const T = todayKey();
  return Array.from({ length: 14 }, (_, i) => addDays(T, i - 13));
}

// Shows the last 14 days, or every day of the chosen month when that is longer; the chosen
// days are shaded and a single chosen day is underlined.
function renderChart(r) {
  const selectedKey = r.days.length === 1 ? r.days[0] : null;
  const inRange = new Set(r.days.length > 1 && r.days.length <= 14 ? r.days : []); // shade a week inside the 14 days
  const days = r.days.length > 14 ? r.days : chartDays();
  const series = visibleChannels(days);
  const T = todayKey();
  const cols = days.map((k) => {
    const vals = series.map((c) => Math.max(0, dayTotals(k, c.id)?.sales || 0));
    return { k, vals, total: vals.reduce((a, b) => a + b, 0) };
  });

  document.getElementById('legend').innerHTML = series.map((c) => `<span><i class="swatch ${c.cls}"></i>${c.name}</span>`).join('');
  document.getElementById('chartTitle').textContent = r.days.length > 14
    ? `Daily sales · ${rangeText([days[0], days[days.length - 1]])}`
    : `Last 14 days · ${rangeText([days[0], days[days.length - 1]])}`;

  const W = Math.max(320, chartEl.clientWidth || 800);
  const H = W < 560 ? 220 : 260;
  const m = { l: 46, r: 6, t: 22, b: 40 };
  const plotH = H - m.t - m.b;
  const maxTotal = Math.max(...cols.map((c) => c.total), 1);
  const step = niceStep(maxTotal);
  const max = Math.ceil(maxTotal / step) * step;
  const y = (v) => m.t + plotH * (1 - v / max);
  const slot = (W - m.l - m.r) / cols.length;
  const bw = Math.min(24, slot * 0.62);
  const narrow = slot < 14 ? 3 : slot < 24 ? 2 : slot < 38 ? 1 : 0; // how much to shorten the day labels
  const best = cols.reduce((a, c) => (c.total > a.total ? c : a), cols[0]);

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily sales for the last 14 days, by channel">`;
  for (let v = 0; v <= max + 1; v += step) {
    svg += `<line class="${v === 0 ? 'baseline' : 'gridline'}" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`;
    svg += `<text class="tick" x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${moneyShort(v)}</text>`;
  }
  cols.forEach((c, i) => {
    const sx = m.l + i * slot;
    const x = sx + (slot - bw) / 2;
    const sel = c.k === selectedKey;
    svg += `<g class="col${sel ? ' sel' : ''}${inRange.has(c.k) ? ' inrange' : ''}" data-key="${c.k}" tabindex="0" role="button" aria-label="${esc(shortDay(c.k))}: ${money(c.total)}">`;
    svg += `<rect class="hit" x="${sx + 1}" y="${m.t - 16}" width="${slot - 2}" height="${plotH + 16 + 34}" rx="6"/>`;
    // stack from the baseline up, 2px surface gap between segments, rounded top on the last one
    let base = m.t + plotH;
    const segs = c.vals.map((v, si) => ({ v, si })).filter((s) => s.v > 0);
    segs.forEach((s, j) => {
      const h = (s.v / max) * plotH;
      const gap = j > 0 ? 2 : 0;
      const top = base - h;
      const hh = Math.max(0, h - gap);
      if (hh > 0) {
        const cls = `seg-${series[s.si].cls}`;
        svg += j === segs.length - 1
          ? `<path class="${cls}" d="${topRounded(x, top, bw, hh, 4)}"/>`
          : `<rect class="${cls}" x="${x}" y="${top}" width="${bw}" height="${hh}"/>`;
      }
      base = top;
    });
    if ((c.k === T || c === best || sel) && c.total > 0) {
      svg += `<text class="total" x="${sx + slot / 2}" y="${y(c.total) - 6}">${moneyShort(c.total)}</text>`;
    }
    // narrow screens: one letter for the weekday and just the day of the month; a whole
    // month on a phone: only every third date
    let lab = narrow ? wd3(c.k).slice(0, narrow > 1 ? 1 : 2) : c.k === T ? 'Today' : wd3(c.k);
    let sub = narrow ? String(parseKey(c.k).d) : `${parseKey(c.k).m}/${parseKey(c.k).d}`;
    if (narrow === 3) { lab = i % 3 === 0 || c.k === T ? String(parseKey(c.k).d) : ''; sub = ''; }
    svg += `<text class="xlab${c.k === T ? ' today' : ''}${sel ? ' sel' : ''}" x="${sx + slot / 2}" y="${H - m.b + 16}">${lab}</text>`;
    svg += `<text class="xlab${c.k === T ? ' today' : ''}${sel ? ' sel' : ''}" x="${sx + slot / 2}" y="${H - m.b + 30}">${sub}</text>`;
    if (sel) svg += `<rect class="selbar" x="${sx + slot / 2 - 10}" y="${H - 4}" width="20" height="2" rx="1"/>`;
    svg += '</g>';
  });
  svg += '</svg>';
  chartEl.innerHTML = svg;
  chartEl.hidden = showTable;

  const colsByKey = Object.fromEntries(cols.map((c) => [c.k, c]));
  chartEl.querySelectorAll('.col').forEach((g) => {
    const c = colsByKey[g.dataset.key];
    g.addEventListener('mousemove', (e) => showTip(e, c, series));
    g.addEventListener('mouseleave', hideTip);
    g.addEventListener('click', () => { hideTip(); selectView({ type: 'day', key: c.k }); });
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectView({ type: 'day', key: c.k }); } });
  });

  // Table view: same numbers, for reading exact values.
  const tw = document.getElementById('tableWrap');
  tw.hidden = !showTable;
  if (showTable) {
    tw.innerHTML = `<table class="data"><thead><tr><th>Day</th>${series.map((s) => `<th>${s.name}</th>`).join('')}<th>Total</th></tr></thead><tbody>${
      [...cols].reverse().map((c) => `<tr><td>${esc(shortDay(c.k))}</td>${c.vals.map((v) => `<td>${money(v)}</td>`).join('')}<td><b>${money(c.total)}</b></td></tr>`).join('')
    }</tbody></table>`;
  }
}

function showTip(e, c, series) {
  tip.innerHTML = `<div class="tt-title">${esc(longDay(c.k))}</div>${
    series.map((s, i) => `<div class="tt-row"><i class="swatch ${s.cls}"></i>${s.name}<span class="v">${money(c.vals[i])}</span></div>`).join('')
  }<div class="tt-row tt-total">Total<span class="v">${money(c.total)}</span></div>`;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let x = e.clientX + 14, yy = e.clientY + 14;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14;
  if (yy + r.height > innerHeight - 8) yy = e.clientY - r.height - 14;
  tip.style.left = `${x}px`;
  tip.style.top = `${yy}px`;
}
const hideTip = () => { tip.hidden = true; };

// ---------- order list ----------
let showAll = false;
function renderOrders(r) {
  const shown = visibleChannels(r.days);
  const all = [];
  for (const k of r.days) for (const c of shown) for (const o of rec(k, c.id)?.list || []) all.push({ ...o, c, day: k });
  all.sort((a, b) => b.t - a.t);
  const real = all.filter((o) => !o.cancelled && !o.refund).length;

  // each day's orders and sales, for the day headings
  const perDay = new Map();
  for (const o of all) {
    if (o.cancelled) continue;
    const d = perDay.get(o.day) || { n: 0, cents: 0 };
    if (!o.refund) d.n += 1;
    d.cents += o.amt;
    perDay.set(o.day, d);
  }
  let lastDay = '';
  const dayHead = (o) => {
    if (!r.multi || o.day === lastDay) return '';
    lastDay = o.day;
    const d = perDay.get(o.day) || { n: 0, cents: 0 };
    return `<li class="day-head"><span>${esc(longDay(o.day))}</span><span>${d.n} order${d.n === 1 ? '' : 's'} · ${money(d.cents)}</span></li>`;
  };

  document.getElementById('ordersTitle').textContent = r.ordersTitle;
  const nCancelled = all.filter((o) => o.cancelled).length;
  document.getElementById('ordersCount').textContent = all.length ? `${real} order${real === 1 ? '' : 's'}${nCancelled ? ` · ${nCancelled} cancelled` : ''}` : '';
  const limit = showAll ? all.length : 40;
  document.getElementById('orders').innerHTML = all.length
    ? all.slice(0, limit).map((o) => `${dayHead(o)}<li class="order${o.cancelled ? ' cancelled' : ''}${o.refund ? ' refund' : ''}">
        <span class="time">${timeFmt.format(o.t)}</span>
        <span class="swatch ${o.c.cls}"></span>
        <span class="ch">${o.c.name}</span>
        <span class="kind">${orderDetail(o)}${o.cancelled ? '<span class="tag">Cancelled</span>' : ''}</span>
        <span class="amt">${money(o.amt)}</span>
      </li>`).join('')
    : `<li class="empty">${shown.some((c) => r.days.some((k) => rec(k, c.id))) ? 'No orders yet.' : 'Loading…'}</li>`;
  const more = document.getElementById('moreBtn');
  more.hidden = all.length <= 40 || showAll;
  more.textContent = `Show all ${all.length}`;
}

// "Ethen R. · Delivery · 3 items": who ordered (on this computer only; the phone page never gets
// names), the kind of order, and how many items when the app says.
function orderDetail(o) {
  const parts = [];
  if (o.who) parts.push(`<span class="who">${esc(o.who)}</span>`);
  const kind = kindText(o);
  if (kind) parts.push(esc(kind));
  if (o.n) parts.push(`<span class="nw">${o.n} item${o.n === 1 ? '' : 's'}</span>`);
  return parts.join(' · ');
}

// Website & app orders: "Website · Pickup", "App · Delivery", or just "Online" when the kind isn't
// known. (Days read from Clover instead of Owner say "External Payment", Clover's name for them.)
function kindText(o) {
  const k = o.kind || '';
  if ((o.c?.id || o.ch) !== 'owner' || o.refund) return k;
  const where = /^app\b/i.test(k) ? 'App' : /^website\b/i.test(k) ? 'Website' : '';
  const how = /deliver/i.test(k) ? 'Delivery' : /pick ?up/i.test(k) ? 'Pickup' : '';
  const note = / · (refunded|cancelled, still paid)$/i.exec(k)?.[1] || '';
  return [where, how, note].filter(Boolean).join(' · ') || 'Online';
}

// ---------- expected (scheduled) orders: a pop-up panel ----------
function renderUpcoming() {
  const u = data.upcoming;
  const list = (u?.orders || []).filter((o) => o.due > Date.now() - 60 * 60 * 1000);
  // the button at the top opens the panel, with how many are coming up
  document.getElementById('heroUpcoming').hidden = !u && !IN_EXTENSION;
  const pill = document.getElementById('heroUpcomingCount');
  pill.hidden = !list.length;
  pill.textContent = String(list.length);
  document.getElementById('upcomingCount').textContent = !u ? 'Checking…'
    : `${list.length ? `${list.length} scheduled · ` : ''}checked ${ago(u.at)}`;
  document.getElementById('upcoming').innerHTML = list.length
    ? list.map((o) => {
      const c = byId[o.ch] || byId.other;
      return `<li class="order">
        <span class="time">${esc(shortDay(dayKeyOf(o.due)))}<br>${timeFmt.format(o.due)}</span>
        <span class="swatch ${c.cls}"></span>
        <span class="ch">${c.name}</span>
        <span class="kind">${orderDetail(o)}</span>
        <span class="amt">${money(o.amt)}</span>
      </li>`;
    }).join('')
    : `<li class="empty">${u ? 'No scheduled orders right now.' : 'Checking…'}</li>`;
}

// ---------- dough (its own tab: dough only, no money) ----------
// Two mixes a day, both in quiet hours (version 1.26.0, the owner, 2026-11-14): the morning mix at
// 11 AM (ready at noon) lasts until the afternoon mix is ready; the afternoon mix is worked out at 2 PM
// from what is really left, mixed by 3 PM (ready about 3:30 PM) and lasts until closing plus the next
// morning until noon. Nothing ever asks for a mix between 4 and 8 PM (a size that may run out is only
// said then). The times are all at the top of dough-plan.js. All the numbers (the mixes, what's left, when a
// size may run out, how many more to mix, what the day is likely to use) are worked out in
// dough-plan.js from Clover's doughs (dough:<day>; see dough.js) and forecast.js: how busy the last
// 3 weeks were × how that weekday usually compares × the time of day orders come in, from 2026-09-25
// on, promo days left out, plus a per-size extra (DOUGH_K and DOUGH_K_PM, picked 2026-11-14).
//
// Counts people can enter (dough_counts), per size: 'am' = new doughs of the morning mix (not last
// night's), 'pm' = the afternoon mix and any extra doughs mixed later that day, all added up (the time
// of the last save is when it was entered), 'left' = left over after closing. Nothing has to be entered: without a count,
// the suggestion is taken as mixed and last night's leftovers are worked out from the orders.
const minuteText = minuteClock; // "2:30 PM" from minutes after midnight, right on the days the clocks change too
// The same, but "noon" for 12:00 PM (plain words for the cover time and when the mix is ready)
const clockWord = (m) => (m % DAY_END === 12 * 60 ? 'noon' : minuteText(m % DAY_END));
const sizeWord = (name) => (name === 'XL' ? 'XL' : name.toLowerCase());
const listWords = (v) => (v.length < 2 ? v.join('') : `${v.slice(0, -1).join(', ')} and ${v[v.length - 1]}`);
const trioWords = (c) => `${c.m || 0} medium, ${c.l || 0} large and ${c.x || 0} XL`;
// "12 large and 4 XL": only the sizes with a number
const someWords = (c) => listWords(DOUGH_SIZES.filter(([, , k]) => c[k] > 0).map(([, name, k]) => `${c[k]} ${sizeWord(name)}`)) || 'none';
let doughMemo = { data: null, engine: null };
// The numbers for the data now showing (worked out again only when new data comes in).
function doughNumbers() {
  if (doughMemo.data !== data) doughMemo = { data, engine: doughEngine(data, { kitchen: KITCHEN }) };
  return doughMemo.engine;
}
const doughToday = () => doughNumbers().today(Date.now());
// "noon tomorrow (Tue, Nov 10)": how long the dough has to last, from COVER_UNTIL. Tomorrow always carries its date.
const coverText = (st) => `<span class="nw">${clockWord(COVER_UNTIL)}</span> tomorrow <span class="nw">(${shortDay(st.tomorrow)})</span>`;
// "the afternoon mix is ready (about 3:30 PM)": how long the morning dough has to last (AM_COVER)
const amCoverText = () => `the afternoon mix is ready <span class="nw">(about ${minuteText(AM_COVER)})</span>`;
// how long a running-low amount lasts: before 2 PM until the afternoon mix is ready, then noon tomorrow
const lowUntilText = (st) => (st.lowUntil === AM_COVER ? amCoverText() : coverText(st));
const busyText = () => `No mixing from ${minuteText(BUSY_FROM).replace(':00', '')} to ${minuteText(BUSY_UNTIL).replace(':00', '')}.`;
// A time today, or "11:15 AM tomorrow (Tue, Nov 10)", from minutes after today's midnight.
const whenText = (st, t) => `<span class="nw">${minuteText(t)}</span>${t >= DAY_END ? ` tomorrow <span class="nw">(${shortDay(st.tomorrow)})</span>` : ''}`;
// "Large dough is running low." / "Mix 20 now to last until noon tomorrow (Tue, Nov 10)." (the push says the same)
function lowWords(st) {
  const low = st.low;
  return {
    title: `${listWords(low.map((x) => x.name))} ${low.length > 1 ? 'are' : 'is'} running low`, // on the Dough tab itself
    head: `${listWords(low.map((x) => x.name))} dough ${low.length > 1 ? 'are' : 'is'} running low.`,
    mix: `Mix ${low.length > 1 ? listWords(low.map((x) => `${x.more} ${x.name}`)) : low[0].more} now to last until ${lowUntilText(st)}.`,
    guess: st.amAssumed ? ' (This counts on the suggested amount having been mixed this morning.)' : '',
  };
}

// "Medium may run out around 8:45 PM." Between 4 and 8 PM (version 1.26.0): said, never asked for.
const watchWords = (st) => st.watch.map((x) => (x.runOut <= st.now ? `${x.name} may be out already` : `${x.name} may run out around ${whenText(st, x.runOut)}`)).join('. ');

// The warning at the top of the Sales tab when a size is running low (no money in it). On the Dough
// tab the same warning is the first box. Between 4 and 8 PM only what may run out, no mixing.
function doughAlert(st) {
  if (tab === 'dough') return '';
  if (!st.low.length && st.watch.length) return alertHtml('info', 'i', `<b>${watchWords(st)}.</b> ${busyText()}`, null, 'Open Dough', 'open-dough');
  if (!st.low.length) return '';
  const w = lowWords(st);
  return alertHtml(st.low.some((x) => x.urgent) ? 'critical' : 'warning', '!', `<b>${w.head}</b> ${w.mix}${w.guess}`, null, 'Open Dough', 'open-dough');
}

function renderDough(st) {
  renderDoughDo(st);
  renderDoughNow(st);
  renderDoughUsed(st);
  renderDoughSteps(st);
  renderDoughWho(st);
  renderDoughOrders();
  renderDoughHow(st);
  renderDoughLog(st);
  renderKitchenLogins();
  renderDoughFoot();
}

// ----- the one big box: what to do now, in big numbers
const sizeTiles = (c, sizes = DOUGH_SIZES) => `<div class="do-sizes">${sizes.map(([, name, k]) => `<div class="do-size"><b>${c[k] || 0}</b><span>${name}</span></div>`).join('')}</div>`;
// "Extra mix: 12 large, entered 3:42 PM by Maria. Ready about 4:42 PM." ("Afternoon mix: ..." when
// everything was entered from 2 PM on, version 1.26.0)
function extraWords(st, label = true) {
  const list = st.extras;
  if (!list.length) return '';
  const afternoon = list.every((e) => e.at && relMinute(st.T, e.at) >= PM_DECIDE);
  const one = (e) => `${someWords(e)}${e.at ? `, entered ${timeFmt.format(e.at)}` : ''}${e.by ? ` by ${esc(loginLabel(e.by))}` : ''}`;
  const waiting = list.filter((e) => e.at && relMinute(st.T, e.at) + DOUGH_RISE > st.now);
  const ready = waiting.length ? ` Ready about ${minuteText(Math.max(...waiting.map((e) => relMinute(st.T, e.at))) + DOUGH_RISE)}.` : '';
  return `${label ? `<b>${afternoon ? 'Afternoon mix' : `Extra mix${list.length > 1 ? 'es' : ''}`}:</b> ` : ''}${list.map(one).join('; ')}.${ready}`;
}
// Version 1.24.0 (the owner, 2026-11-13): while the store is open and any size still has to be mixed
// (st.toMix: the morning suggestion less what's entered today, or the running-low amount if that's
// more), the box shows all three sizes, the number still to mix or ✓ Enough, and stays up until that
// many have been entered; it no longer goes away at noon just because time has passed.
const toMixTiles = (c) => `<div class="do-sizes">${DOUGH_SIZES.map(([, name, k]) => (c[k] > 0
  ? `<div class="do-size"><b>${c[k]}</b><span>${name}</span></div>`
  : `<div class="do-size ok"><b>✓</b><span>${name}</span><em>Enough</em></div>`)).join('')}</div>`;
// Version 1.25.0 (the owner, 2026-11-14: dough is good for about 12 hours): when tonight's count is a lot
// more than tomorrow morning needs until its mix is ready, say so plainly (no money; kitchen logins see it).
function spareWords(st) {
  const sp = st.spare;
  if (!sp) return '';
  const over = sp.over, need = sp.need;
  const needWords = someWords(need) === 'none' ? 'almost none' : `about ${someWords(need)}`;
  return `<p class="do-line do-spare">That is more than tomorrow morning needs. Until the new mix is ready at ${clockWord(MIX_READY)}, it needs ${needWords}. About <b>${someWords(over)}</b> ${sumOf(over) === 1 ? 'is' : 'are'} extra.</p>`;
}
// Version 1.26.0: until 2 PM the box is the morning mix (or a running-low warning); from 2 PM it is
// the afternoon mix ("Mix by 3:00 PM", worked out at 2 PM from the dough left then), which stays up per
// size until that many have been entered (version 1.24.0 rule). From 4 PM it no longer says to mix it,
// only to enter it if it was made; between 4 and 8 PM nothing asks for a mix, and a size that may run
// out is only said (st.watch).
function renderDoughDo(st) {
  const { now, plan, counts, live, low } = st;
  const box = document.getElementById('doughDo');
  if (!plan) {
    const nothing = !Object.keys(data).some((k) => k.startsWith('dough:'));
    box.innerHTML = KITCHEN && nothing
      ? '<p class="do-title">No dough numbers yet</p><p class="do-line">They show up once the store computer sends its first numbers. If this doesn\'t change today, tell the owner.</p>'
      : '<p class="do-title">Not enough history yet</p><p class="do-line">The numbers start once there\'s a day of orders to go by.</p>';
    return;
  }
  let html = '';
  const ln = st.lastNight;
  const had = sumOf(ln);
  const sizes = live?.sizes || [];
  const toMix = st.toMix;
  const pmPhase = st.phase === 'pm';
  const many = DOUGH_SIZES.filter(([, , k]) => toMix[k] > 0).length > 1 ? 'these' : 'this many';
  // the one-tap button saves the numbers shown: as the morning mix while none is entered (before 2 PM),
  // otherwise added to 'pm' (the afternoon mix and extras)
  const button = `<button class="btn do-btn" type="button" ${pmPhase || counts.am ? 'data-mixed-more' : 'data-mixed-am'}>I mixed these</button> <span class="do-saving" aria-live="polite"></span>`;
  const amNote = st.amAssumed && now >= MIX_TIME
    ? `<p class="do-line do-note">Nothing has been entered for this morning's mix yet. ${pmPhase ? 'These numbers count on the suggested amount having been mixed. Enter it under Today\'s dough.' : 'Once it\'s mixed, tap <b>I mixed these</b>.'}</p>` : '';
  if (!st.open) {
    html += counts.left
      ? `<p class="do-title">Closed for tonight <span class="do-done">✓</span></p><p class="do-line">Left over: <b>${trioWords(counts.left)}</b>. Use this dough first tomorrow (${shortDay(st.tomorrow)}).</p>${spareWords(st)}`
      : `<p class="do-title">Closed: count what's left</p><p class="do-line">Count the doughs left over and enter them. Tomorrow's mix (${shortDay(st.tomorrow)}) takes them off.</p>
        <button class="btn do-btn" type="button" data-edit="left">Count what's left</button>`;
  } else if (sumOf(toMix) > 0 && low.length) {
    // running low (never between 4 and 8 PM): mix now
    const w = lowWords(st);
    let lines = `<p class="do-line">${low.map((x) => (x.runOut <= now ? `${x.name} may be out already` : `${x.name} may run out around ${whenText(st, x.runOut)}`)).join('. ')}.</p>`;
    lines += `<p class="do-line">Mixing ${many} lasts until <b>${lowUntilText(st)}</b>. Ready about <span class="nw">${minuteText(Math.max(now, MIX_TIME) + DOUGH_RISE)}</span>.</p>`;
    html += `<div class="do-alert${low.some((x) => x.urgent) ? '' : ' soon'}"><p class="do-title">${esc(w.title)}</p><p class="do-sub">Mix now</p>${toMixTiles(toMix)}${lines}${amNote}${button}</div>`;
  } else if (sumOf(toMix) > 0 && pmPhase) {
    // the afternoon mix
    const late = now >= BUSY_FROM;
    const title = late ? 'Afternoon mix not entered' : now < PM_MIX_BY ? `Mix by ${minuteText(PM_MIX_BY)}` : 'Mix the afternoon dough now';
    let lines = late
      ? `<p class="do-line">Was it mixed? Tap <b>I mixed these</b> so the numbers stay right.${now < BUSY_UNTIL ? ` ${busyText()}` : ''}</p>`
      : `<p class="do-line">Worked out at ${minuteText(PM_DECIDE)} from the dough left then. Ready about <span class="nw">${minuteText(Math.max(now, PM_MIX_TIME) + DOUGH_RISE)}</span>. It lasts tonight and tomorrow morning, until <b>${coverText(st)}</b>.</p>`;
    if (sumOf(st.pmIn)) lines += `<p class="do-line">Suggested at ${minuteText(PM_DECIDE)}: ${trioWords(st.pmSuggest)}. Entered so far: <b>${trioWords(st.pmIn)}</b>.</p>`;
    html += `<p class="do-title">${title}</p><p class="do-sub">Afternoon mix</p>${toMixTiles(toMix)}${lines}${amNote}${button}`;
  } else if (sumOf(toMix) > 0) {
    // the morning mix
    const entered = !!(counts.am || counts.pm);
    const title = entered ? 'Still to mix' : now < MIX_TIME ? `Mix at ${minuteText(MIX_TIME).replace(':00', '')}` : 'Mix now';
    let lines = '';
    if (!entered && now < MIX_READY) {
      const inAll = had ? `<b>${st.total}</b> in all, ${ln.worked ? 'about ' : ''}${had} from last night. Use last night's dough first.` : `<b>${st.total}</b> in all.`;
      lines += `<p class="do-line">It lasts until <b>${amCoverText()}</b>. ${inAll} Ready at ${clockWord(MIX_READY)}.</p>`;
    } else {
      lines += `<p class="do-line">Mixing ${many} lasts until <b>${amCoverText()}</b>. Ready about <span class="nw">${minuteText(Math.max(now, MIX_TIME) + DOUGH_RISE)}</span>.</p>`;
    }
    if (entered) {
      const done = Object.fromEntries(DOUGH_SIZES.map(([, , k]) => [k, (counts.am?.[k] || 0) + (counts.pm?.[k] || 0)]));
      lines += `<p class="do-line">Suggested for this morning: ${trioWords(st.suggest)}. Entered so far: <b>${trioWords(done)}</b>.</p>`;
    }
    html += `<p class="do-title">${title}</p><p class="do-sub">Morning mix</p>${toMixTiles(toMix)}${lines}${amNote}${button}`;
  } else if (now < MIX_READY && !counts.am) {
    html += `<p class="do-title">No mix needed this morning <span class="do-done">✓</span></p><p class="do-line">The ${had} doughs from last night should last until <b>${amCoverText()}</b>. Use last night's dough first.</p>`;
  } else if (now < MIX_READY) {
    html += `<p class="do-title">Morning mix done <span class="do-done">✓</span></p>${sizeTiles(counts.am)}
      <p class="do-line">Ready at ${clockWord(MIX_READY)}. It should last until <b>${amCoverText()}</b>.${had ? ' Use last night\'s dough first.' : ''}</p>`;
  } else if (!pmPhase) {
    html += `<p class="do-title">Morning mix done <span class="do-done">✓</span></p>
      <p class="do-line">At ${minuteText(PM_DECIDE)} this box shows the afternoon mix, worked out from the dough left then. Mix it by ${minuteText(PM_MIX_BY)}.</p>`;
  } else {
    const tight = sizes.filter((x) => x.status === 'tight');
    const none = !sumOf(st.pmSuggest) && !sumOf(st.pmIn);
    // with a size that may run out (said below, between 4 and 8 PM), it doesn't say "enough"
    html += `<p class="do-title">${none ? 'No afternoon mix needed' : st.watch.length ? 'Afternoon mix done' : 'All set'} <span class="do-done">✓</span></p>`;
    if (!st.watch.length) html += `<p class="do-line">There should be enough dough until tomorrow's mix (${shortDay(st.tomorrow)}).${tight.length ? ` ${listWords(tight.map((x) => x.name))} might run low if it gets busy.` : ''}</p>`;
  }
  // between 4 and 8 PM: what may run out, said only (no mixing then)
  if (st.open && st.watch.length) html += `<p class="do-line do-watch"><b>${watchWords(st)}.</b> ${busyText()}</p>`;
  const gap = st.open ? sizes.filter((x) => x.status === 'gap') : [];
  if (gap.length) html += `<p class="do-line">${listWords(gap.map((x) => x.name))} may run short until ${minuteText(Math.max(...gap.map((x) => x.gapUntil)))}, when the new dough is ready.</p>`;
  const extra = extraWords(st);
  if (extra) html += `<p class="do-line do-extra">${extra}</p>`;
  // anyone can add an extra mix at any time after the morning mix; the time is saved by itself
  if (live) html += '<button class="btn ghost do-btn do-more" type="button" data-edit="extra">Made more dough? Add it</button>';
  box.innerHTML = html;
}

// ----- how many are left now, one tile per size
function renderDoughNow(st) {
  const { T, now, plan, live } = st;
  const card = document.getElementById('doughNowCard');
  card.hidden = !plan || !live;
  if (card.hidden) return;
  document.getElementById('doughNowTitle').innerHTML = live.open
    ? `Left right now · <span class="nw">${minuteText(now)}</span>` : `Left now · <span class="nw">closed</span>`;
  const say = (x) => {
    if (x.status === 'short') return x.runOut <= now ? 'May be out now' : `May run out around ${whenText(st, x.runOut)}`;
    if (x.status === 'gap') return `May run short until ${minuteText(x.gapUntil)}, when the new dough is ready`;
    if (x.status === 'tight') return 'Might run low if it gets busy';
    return st.phase === 'am' ? 'Enough until the afternoon mix' : `Enough until tomorrow's mix (${wd3(st.tomorrow)})`;
  };
  const mark = { ok: '✓', tight: '!', gap: '!', short: '!' };
  const cls = { ok: 'ok', tight: 'tight', gap: 'tight', short: 'short' };
  const busier = live.usualTotal > 3 ? live.usedTotal / live.usualTotal : 1;
  const wd = weekdayName(T);
  const pace = !live.open || now < MIX_READY ? '' : busier > 1.25 ? `Busier than a usual ${wd} so far.` : busier < 0.8 ? `Quieter than a usual ${wd} so far.` : '';
  document.getElementById('doughNow').innerHTML = `<div class="left-tiles">${live.sizes.map((x) => `<div class="left-tile ${!live.open ? 'closed' : x.status === 'short' && !x.urgent ? 'tight' : cls[x.status]}">
        <span class="left-name">${x.name}</span><b>${Math.max(0, Math.round(x.left))}</b>
        ${live.open ? `<span class="left-say"><i aria-hidden="true">${mark[x.status]}</i> ${say(x)}</span>` : ''}</div>`).join('')}</div>
    ${pace ? `<p class="dough-note">${pace}</p>` : ''}
    <p class="hint">Last night's leftovers plus what was mixed today, minus what the orders have used.${st.amAssumed
      ? ' Nothing was entered for this morning\'s mix, so it counts on the suggested amount.' : ''}</p>`;
}

// ----- doughs used so far today (version 1.18.0, the owner asked on 2026-11-09), always shown, for the
// owner and the kitchen. The raw count: no learning and no plan needed. From Clover's 15-minute slots
// once today's Clover day is in; before the add-on has any Clover days, the owner's page works it out
// from the sales. A kitchen login can't do that (it has no sales), and in Clover mode a missing day
// means it simply hasn't come in, so both say "Not in yet", never a wrong 0. Since 1.19.0 it also
// says what the day is likely to use by closing: used so far plus a usual rest of the day (no extra).
function renderDoughUsed(st) {
  const u = doughNumbers().usedSoFar(st.T, st.now);
  const when = u.at ? (dayKeyOf(u.at) === st.T ? timeFmt.format(u.at) : dayTimeFmt.format(u.at)) : '';
  document.getElementById('doughUsedTitle').innerHTML = `Used today · <span class="nw">${shortDay(st.T)}</span>`;
  const box = document.getElementById('doughUsed');
  const ex = u.expect && st.open && u.expect.total > 0
    ? `<p class="dough-note used-expect">Expect about <b>${u.expect.total}</b> by closing: ${trioWords(u.expect)}.</p>` : '';
  if (u.state === 'missing') {
    box.innerHTML = `<div class="trio none">Not in yet</div>${ex}<p class="hint">Today's doughs from Clover haven't come in yet${when ? ` (last check ${when})` : ''}. If this doesn't change once orders start, the store computer may be off or signed out of Clover.</p>`;
    return;
  }
  const nums = `<div class="trio used-trio">${DOUGH_SIZES.map(([, name, k]) => `<span><b>${u.c[k]}</b> ${name}</span>`).join('')}<span class="used-total"><b>${u.total}</b> doughs in all</span></div>`;
  const zero = !u.total ? `<p class="dough-note">${u.orders ? 'No doughs used yet today.' : 'No orders yet today.'}</p>` : '';
  const from = u.state === 'clover'
    ? `From Clover's orders since midnight (every app prints there)${when ? `, as of ${when}` : ''}.`
    : `Worked out from today's sales until Clover's dough counts come in, so it's close, not exact${when ? ` (as of ${when})` : ''}.`;
  box.innerHTML = `${nums}${zero}${ex}<p class="hint">${from} Calzones and breadsticks count as a medium; gluten-free isn't counted.</p>`;
}

// ----- today's dough, in the order of the day: last night's leftovers, the morning mix, any extra
// mixes, what's left at closing. Each can be changed or counted right there; nothing is folded away.
// doughEdit.id: 'night', 'am', 'left', 'extra' (add an extra mix) or 'pm' (fix the day's extra total).
const doughEdit = { id: null, vals: null, note: '', redraw: false };
const doughArea = document.querySelector('main');
const EDIT_HELP = {
  night: 'Doughs left over after closing last night.',
  am: 'Just the new doughs of this morning\'s mix, not last night\'s.',
  extra: 'The new doughs you just mixed: the afternoon mix or any extra. The time is saved by itself.',
  pm: 'All the dough mixed after the morning mix today (the afternoon mix and any extra), added up. Change this only to fix a mistake.',
  left: 'Doughs left over after closing tonight.',
};
const EDIT_TITLE = { extra: 'Enter dough you mixed', pm: 'Afternoon and extra mixes, in all' };
function doughRows(st) {
  const { T, now, counts, plan } = st;
  const ln = st.lastNight;
  const saved = (c) => (c?.at ? ` ${dayKeyOf(c.at) === T ? timeFmt.format(c.at) : dayTimeFmt.format(c.at)}` : '')
    + (c?.by ? ` by ${esc(loginLabel(c.by))}` : ''); // who saved it, stamped by the database
  const nightDay = addDays(T, -1);
  const nightCount = data.doughCounts?.[nightDay]?.left;
  const mixAt = minuteText(MIX_TIME).replace(':00', '');
  const rows = [
    {
      id: 'night', day: nightDay, batch: 'left', title: 'Left from last night', when: shortDay(nightDay),
      vals: ln, done: !!nightCount,
      note: `${nightCount ? `Counted${saved(nightCount)} ✓` : ln ? 'Worked out from what was mixed and sold, not counted.' : 'Not counted.'}${sumOf(ln) > 0 ? ' Use last night\'s dough first.' : ''}`,
      btn: nightCount ? 'Change' : 'Count',
    },
    {
      id: 'am', day: T, batch: 'am', title: now < MIX_TIME && !counts.am ? `Mix at ${mixAt}` : `Mixed at ${mixAt}`, when: 'ready at noon',
      vals: counts.am || st.mix, done: !!counts.am,
      note: counts.am ? `Entered${saved(counts.am)} ✓`
        : !plan ? 'Not entered.'
        : now < MIX_TIME ? `Suggested. With last night's, that's ${st.total} in all.` : 'Suggested. Mixed a different amount? Change it.',
      btn: counts.am || plan ? 'Change' : 'Enter',
    },
    {
      // version 1.26.0: the afternoon mix (and any extra) goes in 'pm'
      id: 'extra', day: T, batch: 'pm', title: 'Afternoon mix', when: `mix by ${minuteText(PM_MIX_BY)}, ready about ${minuteText(PM_READY)}`,
      vals: counts.pm && sumOf(counts.pm) ? counts.pm : st.pmSuggest, done: st.extras.length > 0,
      note: st.extras.length ? `${extraWords(st, false).replace(/^./, (ch) => ch.toUpperCase())} ✓`
        : !st.pmSuggest ? `Worked out at ${minuteText(PM_DECIDE)} from the dough left then.`
        : sumOf(st.pmSuggest) ? `Suggested at ${minuteText(PM_DECIDE)}. Mixed a different amount? Enter what you mixed.` : 'Not needed today.',
      btn: st.extras.length ? 'Add more' : 'Enter', fix: st.extras.length > 0,
    },
    {
      id: 'left', day: T, batch: 'left', title: 'Left at closing', when: `closes ${minuteText(st.closes)}`,
      vals: counts.left || null, done: !!counts.left,
      note: counts.left ? `Counted${saved(counts.left)} ✓` : st.open ? 'Count after closing.' : 'Not counted yet. Tomorrow\'s mix takes off what\'s counted.',
      btn: counts.left ? 'Change' : 'Count',
    },
  ];
  // the step that's up now gets a "Next" tag
  const next = !st.open ? (counts.left ? '' : 'left') : !plan ? '' : now < MIX_READY && !counts.am ? 'am'
    : st.phase === 'pm' && sumOf(st.toMix) && !st.low.length ? 'extra' : '';
  for (const r of rows) r.next = r.id === next;
  return rows;
}
function renderDoughSteps(st) {
  const list = document.getElementById('doughSteps');
  document.getElementById('doughDayTitle').innerHTML = `Today's dough · <span class="nw">${shortDay(st.T)}</span>`;
  // an open count stays exactly as it is while it's being filled in
  if (doughEdit.id && !doughEdit.redraw && list.querySelector('form')) return;
  doughEdit.redraw = false;
  const trio = (c) => (c ? `<div class="trio">${DOUGH_SIZES.map(([, name, k]) => `<span><b>${c[k] || 0}</b> ${sizeWord(name)}</span>`).join('')}</div>`
    : '<div class="trio none">—</div>');
  const editing = (r) => r.id === doughEdit.id || (r.id === 'extra' && doughEdit.id === 'pm');
  list.innerHTML = doughRows(st).map((r) => {
    if (!editing(r)) {
      return `<li class="step${r.next ? ' next' : ''}${r.done ? ' done' : ''}">
        <div class="step-head"><span class="step-title">${r.title}</span>${r.next ? '<span class="chip next">Next</span>' : ''}<span class="step-when">${esc(r.when)}</span></div>
        ${trio(r.vals)}
        <div class="step-foot${r.fix ? ' two' : ''}"><p class="step-note">${r.note}</p>${r.fix ? '<button class="btn ghost step-btn" type="button" data-edit="pm">Change</button>' : ''}<button class="btn ghost step-btn" type="button" data-edit="${r.id}">${r.btn}</button></div></li>`;
    }
    const v = doughEdit.vals;
    return `<li class="step editing"><form class="dough-form" data-row="${doughEdit.id}" autocomplete="off">
        <div class="step-head"><span class="step-title">${EDIT_TITLE[doughEdit.id] || r.title}</span><span class="step-when">${esc(r.day === st.T ? longDay(r.day) : `${longDay(r.day)} (last night)`)}</span></div>
        <p class="step-note">${EDIT_HELP[doughEdit.id]}</p>
        <div class="dough-steppers">${DOUGH_SIZES.map(([, name, k]) => `<div class="stepper"><span class="stepper-name">${name}</span>
          <button type="button" data-step="${k}:-1" aria-label="One less ${name}">−</button>
          <input type="number" inputmode="numeric" min="0" max="999" step="1" name="${k}" value="${v[k] ?? ''}" placeholder="0" aria-label="${name}">
          <button type="button" data-step="${k}:1" aria-label="One more ${name}">+</button></div>`).join('')}</div>
        <div class="dough-save"><button class="btn" type="submit">Save</button><button class="btn ghost" type="button" data-cancel>Cancel</button>
          <span class="muted" aria-live="polite">${esc(doughEdit.note)}</span></div>
      </form></li>`;
  }).join('');
}
function openDoughEdit(id) {
  const st = doughToday();
  const r = doughRows(st).find((x) => x.id === (id === 'pm' ? 'extra' : id));
  if (!r) return;
  const counted = data.doughCounts?.[r.day]?.[r.batch];
  // made counts start at what's shown (the suggestion); leftovers start empty, to be counted. An extra
  // mix starts empty too, or at the numbers the running-low warning asked for.
  let start = counted || (r.batch === 'left' ? null : r.vals);
  if (id === 'extra') {
    start = st.low.length ? Object.fromEntries(st.low.map((x) => [x.k, x.more]))
      : st.phase === 'pm' && sumOf(st.toMix) ? st.toMix : null; // the afternoon mix still to enter
  }
  const blank = id === 'extra' && start ? 0 : '';
  Object.assign(doughEdit, { id, vals: Object.fromEntries(DOUGH_SIZES.map(([, , k]) => [k, start ? start[k] || blank : ''])), note: '', redraw: true });
  renderDoughSteps(st);
  // the count box goes to the middle of the screen (the owner asked; at the bottom it was easy to miss)
  const form = document.querySelector('#doughSteps form');
  form?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
function closeDoughEdit() {
  Object.assign(doughEdit, { id: null, vals: null, note: '', redraw: true });
  render();
}
// Adds an extra mix to today's: the 'pm' count holds all of today's extra doughs added up, and the
// database stamps the time and who saved it, so the time is the moment it was entered. The latest
// count is read first, so two phones adding one after the other both count.
async function saveExtraMix(add) {
  if (!store.saveDough) throw new Error('saving isn\'t available here');
  const T = todayKey();
  await store.freshDough?.(); // the phone page reads the table again first
  data = await store.load();
  const had = data.doughCounts?.[T]?.pm || {};
  const total = Object.fromEntries(DOUGH_SIZES.map(([, , k]) => [k, Math.min(999, (had[k] || 0) + (add[k] || 0))]));
  await store.saveDough(T, 'pm', total);
}
// The one-tap "I mixed these" button of the big box (see addMixedAm / addMixedMore below).
async function oneTapSave(btn, save) {
  btn.disabled = true;
  const note = btn.parentElement.querySelector('.do-saving');
  if (note) note.textContent = 'Saving…';
  try {
    await save();
  } catch (err) {
    if (note) note.textContent = `Couldn't save: ${err.message || err}`;
    btn.disabled = false;
    return;
  }
  doughEdit.redraw = true;
  data = await store.load();
  render();
}
// Both save the numbers the box shows (st.toMix, version 1.24.0): as the morning mix while none is
// entered yet (before 2 PM), otherwise added to 'pm' (from 2 PM that is the afternoon mix, 1.26.0).
const shownMix = (st) => Object.fromEntries(DOUGH_SIZES.map(([, , k]) => [k, st.toMix?.[k] || 0]));
function addMixedMore(btn) {
  const st = doughToday();
  if ((st.phase === 'am' && !st.counts.am) || !sumOf(st.toMix)) return;
  oneTapSave(btn, () => saveExtraMix(shownMix(st)));
}
function addMixedAm(btn) {
  const st = doughToday();
  if (st.counts.am || st.phase === 'pm' || !sumOf(st.toMix)) return;
  oneTapSave(btn, () => {
    if (!store.saveDough) throw new Error('saving isn\'t available here');
    return store.saveDough(st.T, 'am', shownMix(st));
  });
}
doughArea.addEventListener('click', (e) => {
  const up = e.target.closest('[data-up]');
  if (up) {
    const k = up.dataset.up;
    if (!upOpen.delete(k)) upOpen.add(k);
    keepFocus(renderDoughOrders);
    return;
  }
  const mixed = e.target.closest('[data-mixed-more]');
  if (mixed) { addMixedMore(mixed); return; }
  const mixedAm = e.target.closest('[data-mixed-am]');
  if (mixedAm) { addMixedAm(mixedAm); return; }
  const open = e.target.closest('[data-edit]');
  if (open) { openDoughEdit(open.dataset.edit); return; }
  if (e.target.closest('[data-cancel]')) { closeDoughEdit(); return; }
  const step = e.target.closest('button[data-step]');
  if (step) {
    const [k, d] = step.dataset.step.split(':');
    const input = step.closest('form').elements[k];
    input.value = String(Math.max(0, Math.min(999, (Number(input.value) || 0) + Number(d))));
    doughEdit.vals[k] = Number(input.value);
  }
});
doughArea.addEventListener('input', (e) => {
  if (doughEdit.vals && e.target.name in doughEdit.vals) doughEdit.vals[e.target.name] = e.target.value;
});
doughArea.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-row]');
  if (!form) return;
  e.preventDefault();
  const id = form.dataset.row;
  const r = doughRows(doughToday()).find((x) => x.id === (id === 'pm' ? 'extra' : id));
  const counts = Object.fromEntries(DOUGH_SIZES.map(([, , k]) => [k, Math.max(0, Math.min(999, Math.round(Number(form.elements[k].value) || 0)))]));
  const btn = form.querySelector('button[type="submit"]');
  const note = form.querySelector('[aria-live]');
  if (id === 'extra' && !sumOf(counts)) { doughEdit.note = 'Tap + for each dough you mixed, then Save.'; note.textContent = doughEdit.note; return; }
  btn.disabled = true;
  note.textContent = 'Saving…';
  try {
    if (!store.saveDough) throw new Error('saving isn\'t available here');
    if (id === 'extra') await saveExtraMix(counts);
    else await store.saveDough(r.day, r.batch, counts);
    Object.assign(doughEdit, { id: null, vals: null, note: '', redraw: true });
  } catch (err) {
    doughEdit.note = `Couldn't save: ${err.message || err}`;
    note.textContent = doughEdit.note;
    btn.disabled = false;
    return;
  }
  data = await store.load();
  render();
  // an extra mix shows at the top of the tab straight away (when it was entered, by whom, when it's ready)
  if (id === 'extra') document.getElementById('doughDoCard').scrollIntoView({ block: 'start', behavior: 'smooth' });
});

// ----- who entered which count (owner only): the last 7 days of the database's dough_log, newest first
const BATCH_WORDS = { am: 'Morning mix', pm: 'Afternoon and extra mixes, in all', left: 'Left at closing' };
function renderDoughWho(st) {
  const log = KITCHEN ? [] : data.doughLog || [];
  const card = document.getElementById('doughWhoCard');
  card.hidden = !log.length;
  if (card.hidden) return;
  const T = st.T;
  const trio = (c) => `<span class="nw">${c.m || 0} medium</span> · <span class="nw">${c.l || 0} large</span> · <span class="nw">${c.x || 0} XL</span>`;
  document.getElementById('doughWhoList').innerHTML = log.slice(0, 60).map((e) => {
    const k = dayKeyOf(e.at);
    const when = k === T ? `Today, ${monthDay(k)}` : k === addDays(T, -1) ? `Yesterday, ${monthDay(k)}` : shortDay(k);
    const which = `${BATCH_WORDS[e.batch] || e.batch}${e.day !== k ? ` (${shortDay(e.day)})` : ''}`;
    return `<li><span class="k-when"><b>${timeFmt.format(e.at)}</b><span>${esc(when)}</span></span>
      <span class="k-what"><span><b>${esc(loginLabel(e.who))}</b> · <span class="nw">${esc(which)}</span></span>
      <span class="k-kind">${trio(e)}${e.was ? ` <span class="muted nw">(was ${e.was.m} · ${e.was.l} · ${e.was.x})</span>` : ''}</span></span></li>`;
  }).join('');
}

// ----- orders customers scheduled ahead: when, which app, pickup or delivery, how many items (no prices).
// Tap one to see what's in it (version 1.10.0): item names × how many and the choices made, where the
// app says (website & app and Grubhub do; DoorDash and Uber Eats don't).
const upOpen = new Set(); // the orders showing their items, by app and due time
function renderDoughOrders() {
  const u = data.upcoming;
  const card = document.getElementById('doughOrdersCard');
  card.hidden = !u;
  if (!u) return;
  const list = (u.orders || []).filter((o) => o.due > Date.now() - 60 * 60 * 1000);
  document.getElementById('doughOrdersAge').textContent = u.at ? `checked ${ago(u.at)}` : '';
  const T = todayKey();
  const seen = new Map();
  document.getElementById('doughOrders').innerHTML = list.length
    ? list.map((o) => {
      const c = byId[o.ch] || byId.other;
      const k = dayKeyOf(o.due);
      const day = k === T ? `Today, ${monthDay(k)}` : k === addDays(T, 1) ? `Tomorrow, ${monthDay(k)}` : shortDay(k);
      const what = [o.kind, o.n ? `${o.n} item${o.n === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
      const base = `${o.ch}:${o.due}`;
      const key = `${base}:${seen.set(base, (seen.get(base) || 0) + 1).get(base)}`;
      const open = upOpen.has(key);
      const items = kitchenItems(o.items) || []; // names and how many only, never prices (the same as the kitchen gets)
      const inside = !open ? '' : items.length
        ? `<ul class="k-items">${items.map((it) => `<li><span class="k-item">${esc(it.name)} <b class="nw">× ${Number(it.qty) || 1}</b></span>${
          Array.isArray(it.mods) && it.mods.length ? `<span class="k-mods">${esc(it.mods.join(', '))}</span>` : ''}</li>`).join('')}</ul>`
        : '<p class="k-items none">Items not available</p>';
      return `<li class="k-order${open ? ' open' : ''}"><button type="button" class="k-toggle" data-up="${esc(key)}" aria-expanded="${open}">
        <span class="k-when"><b>${timeFmt.format(o.due)}</b><span>${esc(day)}</span></span>
        <span class="k-what"><span class="k-app"><span class="swatch ${c.cls}"></span>${c.name}</span>${what ? `<span class="k-kind">${esc(what)}</span>` : ''}</span>
        <span class="k-chev" aria-hidden="true">›</span></button>${inside}</li>`;
    }).join('')
    : '<li class="empty">None right now.</li>';
}

// ----- how the numbers are worked out (always shown; the kitchen gets the short version)
function renderDoughHow(st) {
  const { T } = st;
  const body = document.getElementById('doughHowBody');
  if (!st.plan) { body.innerHTML = '<p>The numbers come from the store\'s own orders, so they start once there\'s history to go by.</p>'; return; }
  const eng = doughNumbers();
  const lines = [
    'The numbers come from the store\'s own orders: how busy the last 3 weeks were, how each day of the week usually compares, and what time of day the orders come in.',
    `Dough is mixed twice a day, both in quiet hours. The morning mix is made at ${minuteText(MIX_TIME).replace(':00', '')} and is ready at ${clockWord(MIX_READY)}. It is what the orders should use until the afternoon mix is ready (about ${minuteText(PM_READY)}), plus extra, minus the dough already on hand. Last night's dough is used first.`,
    `The afternoon mix is worked out at ${minuteText(PM_DECIDE)} from the dough really left then. Mix it by ${minuteText(PM_MIX_BY)}; it is ready about an hour later. It is what the orders should use tonight and the next morning until ${clockWord(COVER_UNTIL)}, plus extra for a busy night, minus the dough on hand. Phones with reminders on get a notice at ${minuteText(PM_DECIDE)}.`,
    `Nothing asks for a mix between ${minuteText(BUSY_FROM).replace(':00', '')} and ${minuteText(BUSY_UNTIL).replace(':00', '')}. Then a size that may run out is only said. At other times, if a size is likely to run out before the next mix is ready, a warning says how many to mix, and phones with reminders on get a notification.`,
    'Nothing has to be entered, but the numbers are better when the morning mix, any extra mix and what\'s left at closing are entered.',
  ];
  if (!KITCHEN) {
    const days = st.model.L?.days || st.model.M?.days || [];
    const known = days.map((k) => eng.doughDay(k)).filter(Boolean);
    const fromClover = known.length > 0 && known.every((d) => d.clover);
    lines.push(
      `${fromClover ? 'Doughs come from Clover, which gets every order from every app (in-store, DoorDash, Uber Eats, Grubhub and the website) with the size picked.' : 'Doughs come from what sold; where an app doesn\'t say a specialty pizza\'s size, it\'s worked out from the price.'} Pizzas use the dough of their size, deals count the pizzas in them (2 Large 2-Topping Pizzas = 2 large), and calzones, every kind of breadsticks, Cheesy Curry Bites and the 8" lunch pizza use a medium.${fromClover ? ' Gluten-free crusts use a different dough and aren\'t counted.' : ''}`,
      `Only days from ${monthDay(FORECAST_FROM)} on are used (${days.length} so far), and promo days are left out (${[...PROMO_DAYS].sort().map(monthDay).join(', ')}).`,
      doughLearnText(st.f),
    );
    const t = eng.track(T);
    if (t.cases) {
      const ok = Math.round((100 * (t.cases - t.short)) / t.cases);
      const by = t.short ? Math.max(1, Math.round(t.shortBy / t.short)) : 0;
      lines.push(`<b>How often it was enough:</b> on the last ${t.days.length} day${t.days.length === 1 ? '' : 's'} it could be checked (${rangeText([t.days[0], t.days[t.days.length - 1]])}), the morning number alone would have lasted until the afternoon mix was ready, and the afternoon number until ${clockWord(COVER_UNTIL)} the next day, ${ok} times out of 100 (each size and mix counts once)${t.short ? `; when one ran short it was by about ${by} dough${by === 1 ? '' : 's'}` : ''}. About ${Math.round(t.left / t.days.length)} doughs a day were still left when the next morning mix was ready.`);
    }
    const unknown = [...new Set(known.flatMap((d) => d.unknown))];
    if (unknown.length) lines.push(`Not counted, because they aren't in the dough list yet: ${unknown.map(esc).join(', ')}.`);
  }
  body.innerHTML = lines.map((l) => `<p>${l}</p>`).join('');
}

function doughLearnText(f) {
  const learned = DOUGH_SIZES.filter(([s]) => f[s].n >= DOUGH_LEARN_DAYS);
  if (!learned.length) {
    const most = Math.max(...DOUGH_SIZES.map(([s]) => f[s].n));
    return `Count what's left at closing (and enter what was mixed) on ${DOUGH_LEARN_DAYS} days and the numbers will start matching how much dough your kitchen really uses (so far ${most} day${most === 1 ? '' : 's'}).`;
  }
  const parts = learned.map(([s, name]) => {
    const p = Math.round((f[s].x - 1) * 100);
    const what = sizeWord(name);
    return p === 0 ? `${what} matches the orders` : `${what} uses about ${Math.abs(p)}% ${p > 0 ? 'more' : 'less'} than the orders show`;
  });
  return `<b>Learned from your counts</b> (last 4 weeks): ${parts.join('; ')}. The numbers here are adjusted to match.`;
}

// ----- the last week of counts, next to what the orders used (owner only)
function renderDoughLog(st) {
  const { T } = st;
  const days = [];
  if (!KITCHEN) for (let i = 0; i <= 7; i++) { const k = addDays(T, -i); if (data.doughCounts?.[k]) days.push(k); }
  const card = document.getElementById('doughLogCard');
  card.hidden = !days.length;
  if (card.hidden) return;
  const eng = doughNumbers();
  const trio = (o) => (o ? `<b>${o.M + o.L + o.X}</b><span>${o.M} · ${o.L} · ${o.X}</span>` : '<span>—</span>');
  const big = (c) => (c ? Object.fromEntries(DOUGH_SIZES.map(([s, , key]) => [s, c[key] || 0])) : null);
  const rows = days.map((k) => {
    const c = data.doughCounts[k];
    const mixed = c.am || c.pm ? Object.fromEntries(DOUGH_SIZES.map(([s, , key]) => [s, (c.am?.[key] || 0) + (c.pm?.[key] || 0)])) : null;
    const got = k !== T && eng.doughDay(k);
    const all = got && eng.usedBetween(got, 0, DAY_END);
    const sold = got ? Object.fromEntries(DOUGH_SIZES.map(([s]) => [s, Math.round(all[s])])) : null;
    return `<tr><th scope="row">${esc(shortDay(k))}</th><td>${trio(mixed)}</td><td>${trio(big(c.left))}</td><td>${trio(sold)}</td></tr>`;
  }).join('');
  document.getElementById('doughLogTitle').innerHTML = `Counts entered · <span class="nw">${rangeText([days[days.length - 1], days[0]])}</span>`;
  document.getElementById('doughLog').innerHTML = `<div class="table-wrap"><table class="data dough-log">
      <thead><tr><th>Day</th><th>Mixed</th><th>Left at close</th><th>Orders used</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="hint">Small numbers are medium · large · XL. "Mixed" is what was entered for the morning mix and any extra mix; "Orders used" is what that day's orders used, from Clover.</p>`;
}

// ----- employee logins (owner only): they see this Dough page and nothing else. The database
// keeps them out of every money table; the kitchen-logins Edge Function makes and removes them.
const kitchenBox = { loaded: false, loading: false, logins: [], error: '', note: '' };
async function loadKitchenLogins() {
  if (!store.kitchenLogins || kitchenBox.loading) return;
  kitchenBox.loading = true;
  try {
    const r = await store.kitchenLogins({ action: 'list' });
    Object.assign(kitchenBox, { loaded: true, logins: r.logins || [], ownerPhones: r.ownerPhones || null, error: '' });
  } catch (e) {
    Object.assign(kitchenBox, { loaded: true, error: e.message || String(e) });
  }
  kitchenBox.loading = false;
  renderKitchenLogins();
}
// Kitchen logins use a 6-number PIN (owner, 2026-10-21). The same digit six times or six in a row
// (123456, 654321) is too easy; the kitchen-logins function refuses those too.
const easyPin = (s) => /^(\d)\1+$/.test(s) || '0123456789012'.includes(s) || '9876543210987'.includes(s);
const pinProblem = (s) => (!/^\d{6}$/.test(s) ? 'The PIN needs to be 6 numbers.'
  : easyPin(s) ? 'That PIN is too easy to guess. Pick another, or tap Make one up.' : '');
function makePin() {
  const n = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(n);
    const pin = String(n[0] % 1000000).padStart(6, '0');
    if (!easyPin(pin)) return pin;
  }
}
// Closing reminders are required on every phone (version 1.11.1): each employee's row says whether
// any of their phones has them on, from push_subscriptions (the kitchen-logins function reads it).
// Labels from 1.11.0 were "Name · iPhone"; only the device part is shown.
function phonesText(phones) {
  const one = (p) => {
    const t = Date.parse(p.created_at);
    const since = Number.isFinite(t) ? `since ${monthDay(dayKeyOf(t))}` : '';
    const bad = p.fails > 0 ? 'not reaching it lately' : '';
    return [String(p.label || '').split(' · ').pop() || 'Phone', since, bad].filter(Boolean).join(' · ');
  };
  return phones.map(one).join('; ');
}
function remindStatus(phones) {
  return phones?.length
    ? `<span class="staff-remind on">Reminders on · ${esc(phonesText(phones))}</span>`
    : '<span class="staff-remind off">Reminders OFF</span>';
}
function renderKitchenLogins() {
  const card = document.getElementById('staffCard');
  card.hidden = KITCHEN || !store.kitchenLogins;
  if (card.hidden) return;
  const link = document.getElementById('staffLink');
  link.href = CONFIG.phone?.pageUrl || '#';
  link.textContent = (CONFIG.phone?.pageUrl || '').replace(/^https:\/\//, '').replace(/\/$/, '');
  const needsSignIn = IN_EXTENSION && !data.phoneAuth;
  document.getElementById('staffForm').hidden = needsSignIn;
  if (!needsSignIn && !kitchenBox.loaded && tab === 'dough') loadKitchenLogins();
  const listEl = document.getElementById('staffList');
  const when = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? ago(t) : ''; };
  listEl.innerHTML = needsSignIn
    ? '<li class="empty">To add employees from this computer, first turn on "See these numbers on your phone" (Sales tab → Connections). Or do it on the phone page.</li>'
    : !kitchenBox.loaded ? '<li class="empty">Loading…</li>'
    : kitchenBox.error ? `<li class="empty">Couldn't load the list: ${esc(kitchenBox.error)} <button class="link-btn" type="button" data-kretry>Try again</button></li>`
    : !kitchenBox.logins.length ? '<li class="empty">No employee logins yet.</li>'
    : kitchenBox.logins.map((l) => {
      const who = l.name || loginLabel(l.email);
      return `<li><span class="staff-who"><b>${esc(who)}</b>${l.name ? `<span>${esc(loginLabel(l.email))}</span>` : ''}
        <span class="muted">added ${esc(monthDay(dayKeyOf(Date.parse(l.added))))} · ${l.lastSignIn ? `last signed in ${esc(when(l.lastSignIn))}` : 'hasn\'t signed in yet'}</span>
        ${Array.isArray(l.phones) ? remindStatus(l.phones) : ''}</span>
        <span class="staff-btns"><button class="btn ghost" type="button" data-kpw="${esc(l.id)}" data-email="${esc(who)}">New PIN</button>
        <button class="btn ghost" type="button" data-kname="${esc(l.id)}" data-email="${esc(who)}" data-name="${esc(l.name || '')}">Rename</button>
        <button class="btn ghost danger" type="button" data-kremove="${esc(l.id)}" data-email="${esc(who)}">Remove</button></span></li>`;
    }).join('');
  const own = document.getElementById('staffOwn');
  own.hidden = needsSignIn || !kitchenBox.loaded || !!kitchenBox.error || !Array.isArray(kitchenBox.ownerPhones);
  if (!own.hidden) {
    own.innerHTML = kitchenBox.ownerPhones.length
      ? `Your phones with closing reminders: ${esc(phonesText(kitchenBox.ownerPhones))}`
      : '<span class="staff-remind off">Your phones: none have closing reminders on.</span>';
  }
  document.getElementById('staffNote').textContent = kitchenBox.note;
}
async function kitchenAction(body, done) {
  kitchenBox.note = 'Working…';
  renderKitchenLogins();
  try {
    await store.kitchenLogins(body);
    kitchenBox.note = done;
    kitchenBox.loaded = false; // reload the list
  } catch (e) {
    kitchenBox.note = `Couldn't do that: ${e.message || e}`;
  }
  renderKitchenLogins();
}
document.getElementById('staffMake').addEventListener('click', () => { document.getElementById('staffPassword').value = makePin(); });
document.getElementById('staffForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  // a phone number becomes its login's made-up email (see login-name.js)
  const nameEl = document.getElementById('staffName');
  const name = nameEl.value.trim();
  const email = loginEmail(document.getElementById('staffEmail').value);
  const pw = document.getElementById('staffPassword');
  const pin = pw.value.trim();
  const problem = !name ? 'Type their name.' : !email ? 'Type their phone number, like 253-555-0100.' : pinProblem(pin);
  if (problem) { kitchenBox.note = problem; renderKitchenLogins(); return; }
  await kitchenAction({ action: 'add', name, email, password: pin },
    `Added ${name}. They sign in with ${loginLabel(email)} and the PIN ${pin}. Tell them now; the PIN isn't shown again.`);
  if (/^Added/.test(kitchenBox.note)) { nameEl.value = ''; document.getElementById('staffEmail').value = ''; pw.value = ''; }
});
// A list that didn't load is asked for again with Try again, when the Dough tab is opened again, or
// when the page comes back into view (version 1.10.0; before that it stayed failed until a reload).
function retryKitchenLogins() {
  if (!kitchenBox.error || kitchenBox.loading) return;
  Object.assign(kitchenBox, { loaded: false, error: '' });
  renderKitchenLogins();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) retryKitchenLogins(); });
document.getElementById('staffList').addEventListener('click', async (e) => {
  if (e.target.closest('[data-kretry]')) { retryKitchenLogins(); return; }
  const rm = e.target.closest('[data-kremove]');
  if (rm) {
    if (!confirm(`Remove ${rm.dataset.email}? They won't be able to sign in any more.`)) return;
    await kitchenAction({ action: 'remove', id: rm.dataset.kremove }, `Removed ${rm.dataset.email}.`);
    return;
  }
  const pwBtn = e.target.closest('[data-kpw]');
  if (pwBtn) {
    const pin = prompt(`New 6-number PIN for ${pwBtn.dataset.email}:`, makePin());
    if (pin == null) return;
    const problem = pinProblem(pin.trim());
    if (problem) { kitchenBox.note = problem; renderKitchenLogins(); return; }
    await kitchenAction({ action: 'password', id: pwBtn.dataset.kpw, password: pin.trim() }, `New PIN for ${pwBtn.dataset.email}: ${pin.trim()}. Tell them now.`);
    return;
  }
  const nameBtn = e.target.closest('[data-kname]');
  if (nameBtn) {
    const name = prompt(`Name for ${nameBtn.dataset.email}:`, nameBtn.dataset.name);
    if (name == null || !name.trim()) return;
    await kitchenAction({ action: 'rename', id: nameBtn.dataset.kname, name: name.trim() }, `Renamed to ${name.trim()}.`);
  }
});

// ----- who's signed in (phone page), with a way to sign out
function renderDoughFoot() {
  const foot = document.getElementById('doughFoot');
  foot.hidden = !REMOTE;
  if (foot.hidden) return;
  document.getElementById('doughWho').textContent = KITCHEN
    ? `Signed in as ${store.name || loginLabel(store.email) || 'an employee'} (dough only).` : `Signed in as ${loginLabel(store.email) || 'the owner'}.`;
}
document.getElementById('doughSignOut').addEventListener('click', async () => {
  await store.signOut();
  location.reload();
});

// ----- Sales / Dough tabs. Each device remembers its last tab; dashboard.html#dough opens Dough.
let tab = 'sales';
function setTab(t, save = true) {
  const was = tab;
  tab = t === 'dough' || KITCHEN ? 'dough' : 'sales';
  if (tab === 'dough' && was !== 'dough' && kitchenBox.error) Object.assign(kitchenBox, { loaded: false, error: '' }); // try the employee list again
  document.body.classList.toggle('tab-dough', tab === 'dough');
  for (const b of document.querySelectorAll('#views button')) b.setAttribute('aria-pressed', b.dataset.tab === tab ? 'true' : 'false');
  document.getElementById('brandTitle').textContent = tab === 'dough' ? 'Lakewood dough' : 'Lakewood sales';
  document.title = tab === 'dough' ? 'Can Am Dough' : 'Can Am Sales';
  if (save) {
    try { localStorage.setItem('canam.tab', tab); } catch { /* private mode */ }
    history.replaceState(history.state, '', tab === 'dough' ? '#dough' : location.pathname + location.search);
  }
}
document.getElementById('views').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) { setTab(b.dataset.tab); scrollTo(0, 0); render(); }
});
addEventListener('hashchange', () => { setTab(location.hash === '#dough' ? 'dough' : 'sales', false); render(); });
{
  let saved = '';
  try { saved = localStorage.getItem('canam.tab') || ''; } catch { /* private mode */ }
  setTab(location.hash === '#dough' ? 'dough' : saved || 'sales', false);
}

// Opened from the closing-count reminder (phone page, version 1.11.0): the notification opens the page
// with #dough, or tells a page that's already open to come here. While tonight's count is still missing,
// the "Left at closing" count box opens in the middle of the screen, as if Count was tapped. Only from
// 30 minutes before closing, so a page reloaded on the Dough tab during the day doesn't pop it open.
function openClosingCount() {
  if (tab !== 'dough' || doughEdit.id) return;
  const st = doughToday();
  if (st.counts.left || st.now < st.closes - 30) return;
  openDoughEdit('left');
}
addEventListener('canam:closing-count', () => {
  if (tab !== 'dough') { setTab('dough'); render(); }
  openClosingCount();
});
// A running-low notification was tapped (version 1.19.0): the Dough tab, at the top, where the warning is.
addEventListener('canam:open-dough', () => {
  if (tab !== 'dough') setTab('dough');
  render();
  scrollTo(0, 0);
});

// ---------- connections ----------
function renderConnections() {
  const rows = ['clover', 'doordash', 'uber', 'owner', 'grubhub'].map((src) => {
    const h = health(src);
    let dot = '', state = 'Waiting for the first check…', bad = false;
    if (src === 'owner' && !h) {
      dot = 'warn';
      state = "Not connected yet — showing Clover's “External Payment” orders instead";
    } else if (h?.state === 'ok') {
      dot = 'ok';
      let via = h.via === 'tab' ? ' · through an open tab' : '';
      if (src === 'clover') via = h.via === 'token' ? ' · using API token' : ' · using your Clover sign-in';
      state = `Connected · checked ${ago(h.at)}${via}`;
      if (ordersStaleSince(src) != null) { dot = 'warn'; state = `Today's orders last came in ${ago(h.at)} · trying again every minute`; }
    } else if (h?.state === 'signin') {
      dot = 'bad'; bad = true; state = `Signed out — sign in again ${ADDON_PLACE}`;
    } else if (h?.state === 'busy') {
      dot = 'warn'; state = h.message;
    } else if (h) {
      dot = 'bad'; bad = true; state = h.message || 'Not working right now';
    }
    const link = src === 'owner' && !h ? CONFIG.owner.home : CONFIG[src].home;
    return `<li class="conn"><span class="dot ${dot}"></span><span class="name">${CONFIG[src].label}</span>
      <span class="state${bad ? ' bad' : ''}">${esc(state)}</span>${
      REMOTE ? '<span></span>' : `<a href="${esc(link)}" target="_blank" rel="noopener" data-conn="${src}">Open site</a>`}</li>`;
  });
  document.getElementById('conns').innerHTML = rows.join('');
  document.getElementById('version').textContent = IN_EXTENSION
    ? `Add-on version ${chrome.runtime.getManifest().version}${newerVersion ? ` · version ${newerVersion} is ready` : ''}`
    : REMOTE ? `Phone view · add-on version ${data.addonVersion || '?'}` : 'Preview with made-up numbers';
  renderPhone();
  if (REMOTE) return;

  const has = !!data.cloverToken;
  document.getElementById('tokenRemove').hidden = !has;
  document.getElementById('tokenOpen').href = CONFIG.clover.tokenPage;
  document.getElementById('tokenState').textContent = has
    ? `A token ending in …${data.cloverToken.slice(-4)} is saved. Clover numbers use it instead of your web sign-in.`
    : 'No token saved — Clover numbers use your web sign-in for now.';
}

// "See these numbers on your phone" box (add-on only).
let phoneNote = '';
function renderPhone() {
  const box = document.getElementById('phoneBox');
  if (!box) return; // the phone page leaves this box out
  box.hidden = !IN_EXTENSION || !CONFIG.phone?.supabaseUrl;
  if (box.hidden) return;
  const link = document.getElementById('phoneLink');
  link.href = document.getElementById('phoneOpen').href = CONFIG.phone.pageUrl;
  link.textContent = CONFIG.phone.pageUrl.replace(/^https:\/\//, '').replace(/\/$/, '');
  const on = !!data.phoneAuth;
  const s = data.phoneSync;
  document.getElementById('phoneForm').hidden = on;
  document.getElementById('phoneOn').hidden = !on;
  const email = document.getElementById('phoneEmail');
  if (!email.value && data.phoneEmail && document.activeElement !== email) email.value = data.phoneEmail;
  let state;
  if (phoneNote) state = phoneNote;
  else if (on && s?.state === 'ok' && s.at) state = `Sending to the phone page as ${data.phoneAuth.email} · last sent ${ago(s.at)}.`;
  else if (on && s?.state === 'error') state = `Couldn't send to the phone page just now (${s.message}). Trying again every minute.`;
  else if (on) state = `Signed in as ${data.phoneAuth.email}. Sending the first numbers…`;
  else if (s?.state === 'signin') state = 'The phone page sign-in stopped working. Sign in again to keep it updated.';
  else state = 'Not sending. Sign in with the phone page login to start.';
  document.getElementById('phoneState').textContent = state;
}

// ---------- header ----------
const RANGE_NAMES = { today: 'Today', yesterday: 'Yesterday', week: 'This week', lastweek: 'Last week', month: 'This month', lastmonth: 'Last month', september: 'September' };
let rangeLabelsDay = '';
function labelRangeButtons() {
  const T = todayKey();
  if (rangeLabelsDay === T) return;
  rangeLabelsDay = T;
  for (const b of document.querySelectorAll('.range button[data-view]')) {
    if (b.dataset.view === 'september') b.hidden = !showSeptember();
    const r = rangeFor({ type: b.dataset.view });
    const dates = r.days.length === 1 ? monthDay(r.days[0]) : rangeText([r.days[0], r.days[r.days.length - 1]]);
    b.innerHTML = `<span class="rb-name">${RANGE_NAMES[b.dataset.view]}</span><span class="rb-date">${dates}</span>`;
    b.title = `${RANGE_NAMES[b.dataset.view]}: ${r.when}`;
  }
}

let lastSeenRefresh = 0;
function renderHeader() {
  const now = Date.now();
  labelRangeButtons();
  document.getElementById('dateLine').textContent = `${longDay(todayKey())} · ${timeFmt.format(now)}`;
  for (const b of document.querySelectorAll('#range button')) {
    const on = b.dataset.view === view.type || (view.type === 'day' && view.key === todayKey() && b.dataset.view === 'today')
      || (view.type === 'day' && view.key === addDays(todayKey(), -1) && b.dataset.view === 'yesterday');
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  const dot = document.getElementById('liveDot');
  const text = document.getElementById('liveText');
  // kitchen logins: the dough numbers are only as fresh as the last Clover check
  const last = KITCHEN && data.lastRefresh ? Math.min(data.lastRefresh, data.cloverAt || data.lastRefresh) : data.lastRefresh;
  if (refreshing) { dot.className = 'live-dot pulse'; text.textContent = REMOTE ? 'Getting the latest numbers…' : 'Checking every site…'; return; }
  if (!last) { dot.className = 'live-dot stale'; text.textContent = 'Connecting…'; return; }
  const stale = now - last > 3 * 60 * 1000;
  dot.className = 'live-dot' + (stale ? ' stale' : '') + (last !== lastSeenRefresh ? ' pulse' : '');
  text.textContent = stale ? `Last update ${ago(last)}` : `Live · updated ${ago(last)}`;
  lastSeenRefresh = last;
}

// ---------- wiring ----------
// ---------- detail panel: what sold, when it sold, promos ----------
// Opens from a channel tile (or "See what sold" for all of them) and follows the same
// Today / Yesterday / This week / Last week / clicked-day choice as the rest of the page.
const ITEM_CHANNELS = ['instore', 'doordash', 'uber', 'owner', 'grubhub'];
const LATE_ITEMS = { doordash: 'DoorDash', uber: 'Uber Eats' }; // item reports come a day later
const detailEl = document.getElementById('detail');
let detailCh = null; // a channel id, or 'all'
let detailAllItems = false;
let detailSortBySales = false; // best sellers by number sold (default) or by money brought in

// Same item, different spelling on each app ("12pcs Cheesy Bread Sticks" in Clover, "12 Pieces
// Cheesy Bread Sticks" on DoorDash, "Jalapeño"/"Jalapeno") → one row in the all-channels list.
const normName = doughName; // the same spelling rules as the dough list (dough.js)
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
const hourLabel = (h) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Item list for one channel and day: { name: [quantity, cents] }, or null if not known.
function itemsFor(day, ch) {
  return data[`d:${day}:${ch}`]?.items || data[`i:${day}:${ch}`]?.items || null;
}
function discountsFor(day, ch) {
  return data[`d:${day}:${ch}`]?.extra?.discounts ?? data[`i:${day}:${ch}`]?.discounts ?? 0;
}

function tallyItems(days, chans) {
  const items = new Map();
  const missing = [];
  for (const k of days) {
    for (const ch of chans) {
      const list = itemsFor(k, ch);
      const empty = !list || !Object.keys(list).length;
      if (empty) { if ((rec(k, ch)?.orders || 0) > 0) missing.push([k, ch]); continue; }
      for (const [name, [qty, cents]] of Object.entries(list)) {
        const key = normName(name);
        const t = items.get(key) || { name, qty: 0, cents: 0, chans: new Set() };
        t.qty += qty;
        t.cents += cents;
        t.chans.add(ch);
        items.set(key, t);
      }
    }
  }
  return { items, missing };
}

// When Clover's orders call failed for a day (version 1.15.3): itemsError is a short code, and
// itemsStale means the items shown are from an earlier read. Plain text; the latest such day wins.
const ITEMS_ERROR_WORDS = { 'http-429': 'HTTP 429', 'http-5xx': 'HTTP 5xx', 'http-4xx': 'HTTP 4xx', timeout: 'no answer in 30 s', network: 'network error', parse: 'unreadable answer' };
function cloverItemsNote(days) {
  for (const k of [...days].reverse()) {
    const x = rec(k, 'instore');
    if (!x?.itemsError && !x?.itemsStale) continue;
    const code = ITEMS_ERROR_WORDS[x.itemsError] || 'error';
    const on = days.length > 1 ? `${shortDay(k)}: ` : '';
    return on + (x.itemsStale
      ? `Items are from an earlier read today; Clover's last answer failed (${code}).`
      : `Clover didn't list what sold the last time it was asked (${code}). Sales still count; the add-on tries again every minute today and every half hour for past days.`);
  }
  return '';
}

function ordersOf(days, chans) {
  const out = [];
  for (const k of days) for (const ch of chans) for (const o of rec(k, ch)?.list || []) if (!o.cancelled && !o.refund) out.push({ ...o, ch });
  return out;
}

function bars(rows, unit) {
  const max = Math.max(...rows.map((r) => r.n), 1);
  // highlight the peak only when there is one worth pointing at; an empty hour gets no bar
  return `<div class="d-bars">${rows.map((r) => `<div class="d-bar-row${max > 1 && r.n === max ? ' best' : ''}${r.n ? '' : ' none'}">
      <span class="d-bar-label">${esc(r.label)}</span>
      <span class="d-bar"><i style="width:${r.n ? Math.max(3, (r.n / max) * 100) : 0}%"></i></span>
      <span class="d-bar-val">${r.n} ${unit}${r.n === 1 ? '' : 's'}${r.cents != null ? ` · ${money(r.cents)}` : ''}</span>
    </div>`).join('')}</div>`;
}

function itemTable(list, totalCents, prev, showChans, prevLabel = 'vs week before') {
  return `<div class="table-wrap"><table class="data d-items"><thead><tr><th>Item</th><th>Sold</th><th>Sales</th><th class="d-share">Share</th>${
    prev ? `<th>${prevLabel}</th>` : ''}</tr></thead><tbody>${list.map((t) => {
    let change = '';
    if (prev) {
      const p = prev.get(normName(t.name));
      change = !p ? '<span class="delta up">new</span>'
        : p.qty === t.qty ? '<span class="delta flat">same</span>'
          : `<span class="delta ${t.qty > p.qty ? 'up' : 'down'}">${t.qty > p.qty ? '▲' : '▼'} ${Math.abs(t.qty - p.qty)}</span>`;
    }
    const where = showChans ? ` <span class="d-chans">${[...t.chans].map((ch) => `<i class="swatch ${byId[ch].cls}" title="${byId[ch].name}"></i>`).join('')}</span>` : '';
    return `<tr><td>${esc(t.name)}${where}</td><td>${t.qty}</td><td>${money(t.cents)}</td><td class="d-share">${pct(t.cents, totalCents)}%</td>${prev ? `<td>${change}</td>` : ''}</tr>`;
  }).join('')}</tbody></table></div>`;
}

function renderDetail() {
  if (!detailEl.open || !detailCh) return;
  const r = rangeFor(view);
  const all = detailCh === 'all';
  const c = all ? null : byId[detailCh];
  const chans = all ? ITEM_CHANNELS : [detailCh];
  const T = todayKey();

  document.getElementById('detailTitle').textContent = all ? 'All channels' : c.name;
  document.getElementById('detailSwatch').className = `swatch ${all ? 'all' : c.cls}`;
  for (const b of document.querySelectorAll('#detailRange button')) {
    const on = b.dataset.view === view.type || (view.type === 'day' && view.key === T && b.dataset.view === 'today')
      || (view.type === 'day' && view.key === addDays(T, -1) && b.dataset.view === 'yesterday');
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  const first = r.days[0], last = r.days[r.days.length - 1];
  document.getElementById('detailWhen').textContent = r.days.length === 1
    ? `${first === T ? 'Today, ' : ''}${longDay(first)}` : `${shortDay(first)} – ${shortDay(last)}`;

  // summary
  const tot = totals(r.days);
  const shown = all ? visibleChannels(r.days) : [c];
  const sales = shown.reduce((a, x) => a + tot[x.id].sales, 0);
  const orders = shown.reduce((a, x) => a + tot[x.id].orders, 0);
  const list = ordersOf(r.days, shown.map((x) => x.id));
  const delivery = list.filter((o) => /deliver/i.test(o.kind || '')).length;
  const pickup = list.filter((o) => /pick ?up/i.test(o.kind || '')).length;
  let discounts = 0;
  for (const k of r.days) for (const ch of chans) discounts += discountsFor(k, ch);
  const stats = [[money(sales), 'sales']];
  // what the apps pay after their fees
  let payNote = '';
  if (sales > 0 && (all || PAYOUT_APPS.has(c.id))) {
    const th = all ? takeHomeOf(shown, tot) : takeHome(c.id, tot[c.id]);
    if (th && !th.unknown) {
      const appFees = all ? th.appFees : th.fees;
      const base = all ? th.appSales : sales;
      // the % goes with the label so the amount stays on one line on small phones
      const share = base > 0 ? ` · ${pct(appFees, base)}%${all ? ' of app sales' : ''}` : '';
      stats.push([`${th.approx ? '≈' : ''}${money(th.get)}`, 'you get paid'], [money(appFees), `app fees${share}`]);
      const cardSales = shown.filter((x) => CARD_CHANNELS.has(x.id)).reduce((a, x) => a + tot[x.id].sales, 0);
      if (all && th.cardFees) stats.push([`${th.cardEst ? '≈' : ''}${money(th.cardFees)}`, `card fees · ${pct(th.cardFees, cardSales)}% of in-store & website`]);
    } else stats.push(['…', `checking what ${all ? 'the apps pay' : c.name + ' pays'}`]);
    payNote = all
      ? '"You get paid" is what DoorDash, Uber Eats and Grubhub pay after their commission and fees, the promotions and ads you run there and refunds, plus in-store and website & app sales less card fees (estimated for Clover; Owner gives its own). The website has no commission.'
      : `"You get paid" is what ${c.name} pays after its commission and fees, the promotions and ads you run there, refunds and error charges, from its ${PAYOUT_REPORT[c.id]} report.`;
    if (th?.approx) payNote += all ? ' ≈: orders the apps haven\'t finished yet are estimated at each app\'s usual rate, and card fees are estimates.'
      : ' Orders it hasn\'t finished yet are estimated at its usual rate.';
    if (all && CARD_FEES) payNote += ` In-store card fees use the ${CARD_FEES.clover.label}.`;
  } else if (!all && CARD_CHANNELS.has(c.id) && sales > 0) {
    const t = tot[c.id];
    const th = takeHome(c.id, t);
    stats.push([`${th.approx ? '≈' : ''}${money(th.get)}`, 'you get paid'],
      [`${th.approx ? '≈' : ''}${money(th.fees)}`, `${th.approx ? 'estimated ' : ''}card fees · ${pct(th.fees, sales)}%`]);
    if (c.id === 'owner') stats.push(['None', 'app commission']);
    payNote = c.id === 'owner'
      ? `Owner charges a flat monthly fee, not a commission per order. ${cardFeeTip('owner', t)}`
      : cardFeeTip('instore', t);
  }
  stats.push([String(orders), `order${orders === 1 ? '' : 's'}`]);
  if (orders) stats.push([money(Math.round(sales / orders)), 'average order']);
  // two shares that always add up to 100%
  const split = (a, b) => { const p = pct(a, a + b); return `${p}% / ${100 - p}%`; };
  if (delivery + pickup) stats.push([split(delivery, pickup), all ? 'delivery / pickup on apps' : 'delivery / pickup']);
  if (!all && c.id === 'instore') {
    const t = tot.instore.extra;
    if (t.card || t.cash) stats.push([split(t.card || 0, t.cash || 0), 'card / cash']);
  }
  if (discounts) stats.push([money(discounts), 'discounts given']);
  let html = `<div class="d-stats">${stats.map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('')}</div>`;
  if (payNote) html += `<p class="hint d-pay-note">${esc(payNote)}</p>`;

  // what sold
  const { items, missing } = tallyItems(r.days, chans);
  const sorted = [...items.values()].sort(detailSortBySales
    ? (a, b) => b.cents - a.cents || b.qty - a.qty
    : (a, b) => b.qty - a.qty || b.cents - a.cents);
  const itemCents = sorted.reduce((a, t) => a + t.cents, 0);
  const prev = !r.days.includes(T) && !r.noCompare && covered(r.cmp) ? tallyItems(r.cmp, chans).items : null;
  const lateNote = [...new Set(missing.map(([, ch]) => ch))].filter((ch) => LATE_ITEMS[ch]).map((ch) => LATE_ITEMS[ch]);
  html += `<section class="d-sec"><div class="d-sec-head"><h3>Best sellers</h3><div class="d-sort" role="group" aria-label="Sort best sellers">${
    [['qty', 'Number sold'], ['sales', 'Sales']].map(([k, label]) => `<button data-sort="${k}" aria-pressed="${(k === 'sales') === detailSortBySales}">${label}</button>`).join('')}</div></div>`;
  const itemsNote = chans.includes('instore') ? cloverItemsNote(r.days) : '';
  if (!sorted.length) {
    const late = lateNote.length ? `${lateNote.join(' and ')} ${lateNote.length === 1 ? 'publishes' : 'publish'} what sold a day later, so these items will show tomorrow.` : '';
    html += `<p class="muted">${esc([late, itemsNote].filter(Boolean).join(' ') || 'No items sold yet.')}</p>`;
  } else {
    const top = detailAllItems ? sorted : sorted.slice(0, 10);
    html += itemTable(top, itemCents, prev && prev.size ? prev : null, all, `vs ${r.cmpWhen}`);
    if (sorted.length > 10) html += `<button class="link-btn d-more" id="detailMore">${detailAllItems ? 'Show top 10' : `Show all ${sorted.length} items`}</button>`;
    if (itemsNote) html += `<p class="muted">${esc(itemsNote)}</p>`;
  }
  html += '</section>';

  // when it sold
  if (list.length) {
    const byHour = new Map();
    for (const o of list) { const h = zoned(o.t).h; const x = byHour.get(h) || { n: 0, cents: 0 }; x.n += 1; x.cents += o.amt; byHour.set(h, x); }
    const hours = [...byHour.keys()].sort((a, b) => a - b);
    const hourRows = [];
    for (let h = hours[0]; h <= hours[hours.length - 1]; h++) hourRows.push({ label: hourLabel(h), n: byHour.get(h)?.n || 0, cents: byHour.get(h)?.cents || 0 });
    html += `<section class="d-sec"><h3>Busiest hours</h3>${bars(hourRows, 'order')}</section>`;
    if (r.days.length > 1) {
      const byDay = new Map();
      for (const o of list) { const wd = weekdayOf(dayKeyOf(o.t)); const x = byDay.get(wd) || { n: 0, cents: 0 }; x.n += 1; x.cents += o.amt; byDay.set(wd, x); }
      const dayRows = WEEK_ORDER.filter((wd) => byDay.has(wd)).map((wd) => ({ label: WEEKDAYS[wd], n: byDay.get(wd).n, cents: byDay.get(wd).cents }));
      html += `<section class="d-sec"><h3>Busiest days</h3>${bars(dayRows, 'order')}</section>`;
    }
  }

  // coupons and rewards (website & app)
  if (all || c.id === 'owner') {
    const promos = new Map();
    for (const k of r.days) for (const [name, [n, cents]] of Object.entries(data[`d:${k}:owner`]?.promos || {})) {
      const x = promos.get(name) || { n: 0, cents: 0 }; x.n += n; x.cents += cents; promos.set(name, x);
    }
    if (promos.size) {
      html += `<section class="d-sec"><h3>Coupons and rewards used${all ? ' (website & app)' : ''}</h3><div class="table-wrap"><table class="data"><thead><tr><th>Promo</th><th>Times used</th><th>Discount given</th></tr></thead><tbody>${
        [...promos].sort((a, b) => b[1].n - a[1].n).map(([name, x]) => `<tr><td>${esc(name)}</td><td>${x.n}</td><td>${money(x.cents)}</td></tr>`).join('')}</tbody></table></div></section>`;
    }
  }

  // Uber Eats shopper funnel (Uber's own fixed periods)
  const f = data.customers?.uberFunnel;
  if ((all || c.id === 'uber') && f?.week?.length) {
    const step = (steps, i) => {
      const v = steps[i]?.[1] || 0;
      const before = i ? steps[i - 1][1] : 0;
      return `${v.toLocaleString('en-US')}${i ? ` <span class="muted">(${pct(v, before)}%)</span>` : ''}`;
    };
    html += `<section class="d-sec"><h3>Uber Eats shoppers</h3><div class="table-wrap"><table class="data"><thead><tr><th></th><th>${rangeText(f.ranges[0])}</th><th>${rangeText(f.ranges[1])}</th></tr></thead><tbody>${
      f.week.map(([label], i) => `<tr><td>${esc(label)}</td><td>${step(f.week, i)}</td><td>${step(f.month, i)}</td></tr>`).join('')
    }</tbody></table></div><p class="hint">How many people saw your Uber Eats store, opened the menu, added something to the cart and ordered (the % is how many made it from the step before). Uber fills these in a few days late.</p></section>`;
  }

  const notes = [];
  if (sorted.length && lateNote.length) notes.push(`${lateNote.join(' and ')} ${lateNote.length === 1 ? 'publishes' : 'publish'} what sold a day later, so ${missing.length === 1 ? 'one day isn’t' : 'some days aren’t'} in the item list yet.`);
  if (sorted.length) notes.push('Item sales are before discounts and tax. DoorDash and Uber Eats numbers come from their own item reports.');
  if (prev && prev.size) notes.push(`"vs ${r.cmpWhen}" compares the number sold with ${r.cmp.length === 1 ? 'that day' : 'those days'}.`);
  if (notes.length) html += `<p class="hint">${notes.join(' ')}</p>`;
  document.getElementById('detailBody').innerHTML = html;
}

// Pop-up panels (What sold, Expected orders): the phone's Back button closes them, and so does
// a tap outside.
const upcomingEl = document.getElementById('upcomingPanel');
const PANELS = [detailEl, upcomingEl];
function openPanel(el) {
  if (el.open) return;
  el.showModal();
  history.pushState({ canamPanel: true }, '');
}
for (const el of PANELS) {
  el.addEventListener('close', () => { if (history.state?.canamPanel) history.back(); });
  el.addEventListener('click', (e) => { if (e.target === el) el.close(); });
}
addEventListener('popstate', () => { for (const el of PANELS) if (el.open) el.close(); });

function openDetail(ch) {
  detailCh = ch;
  detailAllItems = false;
  openPanel(detailEl);
  renderDetail();
  detailEl.scrollTop = 0;
}

document.getElementById('tiles').addEventListener('click', (e) => {
  const t = e.target.closest('.tile[data-ch]');
  if (t) openDetail(t.dataset.ch);
});
document.getElementById('tiles').addEventListener('keydown', (e) => {
  const t = e.target.closest('.tile[data-ch]');
  if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openDetail(t.dataset.ch); }
});
document.getElementById('heroDetail').addEventListener('click', () => openDetail('all'));
document.getElementById('heroUpcoming').addEventListener('click', () => { openPanel(upcomingEl); upcomingEl.scrollTop = 0; });
document.getElementById('upcomingClose').addEventListener('click', () => upcomingEl.close());
document.getElementById('detailClose').addEventListener('click', () => detailEl.close());
detailEl.addEventListener('click', (e) => {
  if (e.target.id === 'detailMore') { detailAllItems = !detailAllItems; renderDetail(); }
  const sortBtn = e.target.closest('button[data-sort]');
  if (sortBtn) { detailSortBySales = sortBtn.dataset.sort === 'sales'; renderDetail(); }
});
document.getElementById('detailRange').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b) { detailAllItems = false; selectView({ type: b.dataset.view }); }
});

// The page is drawn again every 15 seconds and whenever new numbers come in. Whatever had the keyboard
// focus (a sales box, a day in the chart, a button) gets it back afterwards, found again by its id or
// its data key (version 1.10.0; before that the focus was lost every 15 seconds).
const FOCUS_KEYS = ['ch', 'key', 'view', 'tab', 'up', 'edit', 'sort', 'kpw', 'kname', 'kremove', 'kretry', 'conn', 'action', 'mixedMore', 'mixedAm'];
function keepFocus(draw) {
  const el = document.activeElement;
  draw();
  if (!el || el === document.body || el.isConnected) return;
  let sel = el.id ? `#${CSS.escape(el.id)}` : '';
  if (!sel) {
    const k = FOCUS_KEYS.find((x) => el.dataset?.[x] != null);
    if (!k) return;
    const attr = `data-${k.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)}`;
    sel = `${el.tagName.toLowerCase()}[${attr}="${CSS.escape(el.dataset[k])}"]`;
  }
  document.querySelector(sel)?.focus({ preventScroll: true });
}

function render() { keepFocus(drawAll); }
function drawAll() {
  if (view.type === 'september' && !showSeptember()) view = { type: 'today' }; // the September button ends with October
  const dough = doughToday();
  renderHeader();
  renderAlerts(dough);
  if (KITCHEN) { renderDough(dough); return; }
  const r = rangeFor(view);
  renderSummary(r);
  renderDough(dough);
  renderNewCustomers();
  renderChart(r);
  renderUpcoming();
  renderOrders(r);
  renderConnections();
  renderDetail();
}

function selectView(v) {
  view = v;
  showAll = false;
  render();
}

document.getElementById('range').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b) selectView({ type: b.dataset.view });
});
document.getElementById('tableToggle').addEventListener('click', (e) => {
  showTable = !showTable;
  e.target.textContent = showTable ? 'Show as chart' : 'Show as table';
  render();
});
document.getElementById('moreBtn').addEventListener('click', () => { showAll = true; render(); });
// Refresh now: spins and says "Checking all four sites…" until the add-on reports back.
let refreshing = false;
document.getElementById('refreshBtn').addEventListener('click', async (e) => {
  if (refreshing) return;
  const btn = e.currentTarget;
  refreshing = true;
  btn.classList.add('spin');
  btn.disabled = true;
  renderHeader();
  const started = Date.now();
  try { await store.refresh(); } catch { /* the header shows the last good update */ }
  await new Promise((r) => setTimeout(r, Math.max(0, 800 - (Date.now() - started))));
  refreshing = false;
  btn.classList.remove('spin');
  btn.disabled = false;
  data = await store.load();
  render();
});

document.getElementById('tokenSave')?.addEventListener('click', async () => {
  const input = document.getElementById('tokenInput');
  const token = input.value.trim();
  if (!token) return;
  await store.set({ cloverToken: token });
  input.value = '';
  store.refresh();
});
// Light / dark switch (theme.js keeps the choice on this device). Each tap goes to the next
// look, starting with the opposite of what the device shows, so the first tap always changes it.
const THEME_ICON = {
  light: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6"/>',
  dark: '<path d="M20.5 14.2A8.5 8.5 0 1 1 9.8 3.5a7 7 0 0 0 10.7 10.7z"/>',
  auto: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor"/>',
};
const THEME_WORD = { light: 'Light', dark: 'Dark', auto: 'Auto' };
const themeBtn = document.getElementById('themeBtn');
function paintThemeBtn() {
  const t = globalThis.canamTheme?.get() || 'auto';
  themeBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${THEME_ICON[t]}</svg><span class="theme-word">${THEME_WORD[t]}</span>`;
  const what = t === 'auto' ? `Auto: matches this ${REMOTE ? 'phone' : 'computer'}` : `${THEME_WORD[t]} look`;
  themeBtn.title = `${what}. Tap to change.`;
  themeBtn.setAttribute('aria-label', `Colors: ${what}. Tap to change.`);
}
themeBtn.hidden = !globalThis.canamTheme;
themeBtn.addEventListener('click', () => {
  const t = canamTheme.get();
  const order = canamTheme.systemDark() ? ['auto', 'light', 'dark'] : ['auto', 'dark', 'light'];
  canamTheme.set(order[(order.indexOf(t) + 1) % order.length]);
  paintThemeBtn();
});
paintThemeBtn();

// The add-on's folder can get newer files (from the GitHub copy, which each computer pulls by
// itself). Chrome keeps running the version it loaded until Update add-on is clicked, so the page
// compares the two every minute and says when a newer one is waiting.
let newerVersion = '';
async function checkFolderVersion() {
  if (!IN_EXTENSION) return;
  try {
    const m = await (await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })).json();
    const was = newerVersion;
    newerVersion = m.version && m.version !== chrome.runtime.getManifest().version ? m.version : '';
    if (newerVersion !== was) render();
  } catch { /* keep the last answer */ }
}
setInterval(checkFolderVersion, 60 * 1000);
checkFolderVersion();

// The "Update add-on" button in the newer-version notice at the top does the same as the one at the bottom.
document.getElementById('alerts').addEventListener('click', (e) => {
  if (IN_EXTENSION && e.target.closest('[data-action="update-addon"]')) chrome.runtime.reload();
  if (e.target.closest('[data-action="open-dough"]')) { setTab('dough'); scrollTo(0, 0); render(); }
});

// Reloads the add-on from its folder; the dashboard reopens by itself.
document.getElementById('reloadAddon').hidden = !IN_EXTENSION;
document.getElementById('reloadAddon').addEventListener('click', () => chrome.runtime.reload());
document.getElementById('tokenRemove')?.addEventListener('click', async () => {
  await store.remove('cloverToken');
  store.refresh();
});

// Phone page: the add-on side signs in once and keeps sending; the phone side can sign out.
if (document.getElementById('tokenBox')) document.getElementById('tokenBox').hidden = REMOTE;
document.getElementById('phoneLogout').hidden = !REMOTE;
document.getElementById('phoneLogout').addEventListener('click', async () => {
  await store.signOut();
  location.reload();
});
document.getElementById('phoneForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('phoneEmail').value.trim();
  const pw = document.getElementById('phonePassword');
  if (!email || !pw.value) return;
  phoneNote = 'Signing in…';
  renderPhone();
  const res = await chrome.runtime.sendMessage({ type: 'phoneSignIn', email, password: pw.value })
    .catch((err) => ({ ok: false, error: String(err) }));
  pw.value = '';
  phoneNote = res?.ok ? '' : `Couldn't start: ${res?.error || 'unknown problem'}`;
  data = await store.load();
  render();
});
document.getElementById('phoneStop')?.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'phoneSignOut' }).catch(() => {});
  phoneNote = '';
  data = await store.load();
  render();
});

let pending = null;
async function reload() {
  data = await store.load();
  render();
}
store.onChange(() => { clearTimeout(pending); pending = setTimeout(reload, 250); });
let lastW = 0;
new ResizeObserver(() => { const w = chartEl.clientWidth; if (Math.abs(w - lastW) > 4) { lastW = w; render(); } }).observe(chartEl);
setInterval(render, 15000); // keeps today's "by this time" comparison current
setInterval(() => keepFocus(() => { renderHeader(); if (!KITCHEN) renderConnections(); }), 1000); // "updated … ago" ticks every second
await reload();
// (a running-low notification opens the page with ?low=1: the Dough tab, without the closing count)
if (REMOTE && location.hash === '#dough' && !new URLSearchParams(location.search).has('low')) openClosingCount();
