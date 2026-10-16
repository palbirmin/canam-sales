import { CONFIG } from './config.js';
import { todayKey, addDays, weekStartOf, minuteOfDay, parseKey, daysBetween, zoned, dayKeyOf, weekdayOf } from './lib.js';

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

// ---------- data source ----------
function extensionStore() {
  return {
    load: () => chrome.storage.local.get(null),
    onChange: (cb) => chrome.storage.onChanged.addListener((_c, area) => { if (area === 'local') cb(); }),
    refresh: () => chrome.runtime.sendMessage({ type: 'refresh' }),
    set: (items) => chrome.storage.local.set(items),
    remove: (keys) => chrome.storage.local.remove(keys),
  };
}
const store = IN_EXTENSION ? extensionStore()
  : REMOTE ? globalThis.canamRemoteStore
  : (await import('./preview-data.js')).makePreviewStore();
let data = {};

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

// cutoff = minute of the day; only orders up to that time count (for fair "so far" comparisons)
function dayTotals(key, ch, cutoff) {
  const r = rec(key, ch);
  if (!r) return null;
  if (cutoff == null) return { sales: r.sales, orders: r.orders, extra: r.extra || {}, viaClover: r.viaClover };
  let sales = 0, orders = 0;
  for (const o of r.list || []) {
    if (o.cancelled || minuteOfDay(o.t) > cutoff) continue;
    sales += o.amt;
    if (!o.refund) orders += 1;
  }
  return { sales, orders, extra: {}, viaClover: r.viaClover };
}

function totals(days, cutoffs = {}) {
  const out = {};
  for (const c of CHANNELS) {
    const t = { sales: 0, orders: 0, extra: {}, have: 0, payDays: 0, viaClover: false };
    for (const k of days) {
      const d = dayTotals(k, c.id, cutoffs[k]);
      if (!d) continue;
      t.have += 1;
      if (d.extra.payout != null || (!d.sales && !d.orders)) t.payDays += 1; // days whose payout is known
      t.sales += d.sales;
      t.orders += d.orders;
      t.viaClover ||= !!d.viaClover;
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
// are estimated at the app's usual rate. The website & app (Owner) has no per-order commission,
// and card fees (in-store, website) aren't available, so those sales count in full.
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

// { get, fees, approx } for one channel's totals, or null while the app's payouts haven't been read.
function takeHome(id, t) {
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
function takeHomeOf(chans, tot) {
  const out = { get: 0, fees: 0, appSales: 0, approx: false, unknown: false };
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
    out.approx ||= th.approx;
    if (PAYOUT_APPS.has(c.id)) out.appSales += t.sales;
  }
  return out;
}

// The line under each sales box.
function payLine(c, t) {
  if (c.id === 'owner') return 'No commission · card fees not included';
  if (c.id === 'instore') return 'Card fees not included';
  if (!PAYOUT_APPS.has(c.id) || t.sales <= 0) return '';
  const th = takeHome(c.id, t);
  if (!th) return `Checking what ${c.name} pays…`;
  return `You get <b>${th.approx ? '≈' : ''}${money(th.get)}</b> · <span class="nw">fees ${money(th.fees)} (${pct(th.fees, t.sales)}%)</span>`;
}

// ---------- the selected date range ----------
let view = { type: 'today' };

// "Wed, Oct 14" for one day; "Oct 12–14" or "Sep 28 – Oct 4" for several.
const daysText = (days) => (days.length === 1 ? shortDay(days[0]) : rangeText([days[0], days[days.length - 1]]));

// Every range carries its dates (when) and the dates it is compared with (cmpWhen), so
// "this month", "yesterday" and so on are never shown without the actual days.
function rangeFor(v) {
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
  if (v.type === 'month' || v.type === 'lastmonth') {
    // This month = the 1st to today, compared with the same dates last month (up to this
    // time of day). Last month = the whole month, compared with the whole month before.
    const thisMonth = v.type === 'month';
    const firstOfThis = `${T.slice(0, 8)}01`;
    const start = thisMonth ? firstOfThis : `${addDays(firstOfThis, -1).slice(0, 8)}01`;
    const end = thisMonth ? T : addDays(firstOfThis, -1);
    const days = Array.from({ length: daysBetween(start, end) + 1 }, (_, i) => addDays(start, i));
    const prevStart = `${addDays(start, -1).slice(0, 8)}01`;
    const prevEnd = addDays(start, -1);
    const prevLen = daysBetween(prevStart, prevEnd) + 1;
    const cmp = thisMonth
      ? days.map((_, i) => addDays(prevStart, i)).slice(0, prevLen)
      : Array.from({ length: prevLen }, (_, i) => addDays(prevStart, i));
    const month = monthName(start);
    const when = daysText(days), cmpWhen = daysText(cmp);
    return {
      days, cmp, when, cmpWhen,
      cutoffs: thisMonth && days.length <= prevLen ? { [cmp[cmp.length - 1]]: now } : {},
      cmpLabel: thisMonth ? `vs last month (${cmpWhen}) at this point` : `vs ${monthName(prevStart)} (${cmpWhen})`,
      cmpShort: `vs ${cmpWhen}`,
      hero: thisMonth ? `Total sales this month · ${when}` : `Total sales in ${month} · ${when}`,
      ordersTitle: thisMonth ? `This month's orders · ${when}` : `Orders in ${month} · ${when}`,
      multi: true,
    };
  }
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
const health = (src) => data[`health:${src}`] || null;

function chipFor(c) {
  const h = health(c.src === 'owner' && !data['health:owner'] ? 'clover' : c.src);
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

function renderAlerts() {
  const out = [];
  for (const id of ['doordash', 'uber']) {
    const s = data[`store:${id}`];
    const c = byId[id];
    if (!s || Date.now() - s.at > 15 * 60 * 1000) continue;
    if (s.state === 'paused' && (!s.until || s.until > Date.now())) {
      const until = s.until ? ` until ${timeFmt.format(s.until)}${todayKeyOf(s.until) !== todayKey() ? ' ' + wd3(todayKeyOf(s.until)) : ''}` : '';
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
  const last = data.lastRefresh;
  if ((IN_EXTENSION || REMOTE) && last && Date.now() - last > 5 * 60 * 1000) {
    const when = todayKeyOf(last) === todayKey() ? timeFmt.format(last) : dayTimeFmt.format(last);
    out.push(alertHtml('warning', '!', `<b>Numbers haven't updated since ${when}.</b> ${REMOTE
      ? 'Chrome on the computer that runs the add-on may be closed, asleep or offline.'
      : 'Keep Chrome open on this computer so the add-on can keep checking.'}`));
  }
  if (IN_EXTENSION && !data.phoneAuth && data.phoneSync?.state === 'signin') {
    out.push(alertHtml('warning', '!', '<b>The phone page stopped getting new numbers.</b> Sign in again under Connections → See these numbers on your phone.'));
  }
  document.getElementById('alerts').innerHTML = out.join('');
}
const todayKeyOf = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(ts);

function alertHtml(level, icon, msg, href, btn) {
  return `<div class="alert ${level}"><span class="ico" aria-hidden="true">${icon}</span><div class="msg">${msg}</div>${
    href ? `<a class="btn" href="${esc(href)}" target="_blank" rel="noopener">${esc(btn)}</a>` : ''}</div>`;
}

// ---------- hero + tiles ----------
function visibleChannels(dayList) {
  return CHANNELS.filter((c) => !c.optional || dayList.some((k) => (rec(k, c.id)?.orders || 0) > 0));
}

function renderSummary(r) {
  const cur = totals(r.days);
  const prev = totals(r.cmp, r.cutoffs);
  if (!covered(r.cmp)) for (const id of Object.keys(prev)) prev[id].missing = true; // partly before the saved history
  const shown = visibleChannels(r.days);
  const anyData = shown.some((c) => !cur[c.id].missing);

  const sales = shown.reduce((a, c) => a + cur[c.id].sales, 0);
  const orders = shown.reduce((a, c) => a + cur[c.id].orders, 0);
  const prevSales = shown.reduce((a, c) => a + prev[c.id].sales, 0);
  const prevHave = shown.some((c) => !prev[c.id].missing);

  document.getElementById('heroLabel').textContent = r.hero;
  document.getElementById('heroValue').textContent = anyData ? money(sales) : '—';
  document.getElementById('heroOrders').textContent = anyData
    ? `${orders} order${orders === 1 ? '' : 's'}${orders ? ` · avg ${money(Math.round(sales / orders))}` : ''}`
    : 'Getting the first numbers… this takes about a minute the first time.';
  document.getElementById('heroDelta').innerHTML = anyData && prevHave ? deltaHtml(sales, prevSales, r.cmpLabel) : '';
  const th = takeHomeOf(shown, cur);
  document.getElementById('heroPay').innerHTML = anyData && sales > 0 && !th.unknown
    ? `You keep about <b>${money(th.get)}</b> after app fees${th.fees ? ` (${money(th.fees)} in fees)` : ''}. Card fees aren't included.`
    : '';

  const tiles = document.getElementById('tiles');
  tiles.classList.toggle('five', shown.length === 5);
  tiles.innerHTML = shown.map((c) => {
    const t = cur[c.id], p = prev[c.id];
    const h = health(c.src === 'owner' && !data['health:owner'] ? 'clover' : c.src);
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
        ${pay ? `<div class="tile-pay">${pay}</div>` : ''}`;
    }
    return `<article class="tile" data-ch="${c.id}" tabindex="0" role="button" title="See what sold on ${c.name}">
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
      <div class="nc-stats">${stat(r?.week, 0, 'Last 7 days')}${stat(r?.month, 1, 'Last 30 days')}</div></div>`;
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
  document.getElementById('ordersCount').textContent = all.length ? `${real} order${real === 1 ? '' : 's'}` : '';
  const limit = showAll ? all.length : 40;
  document.getElementById('orders').innerHTML = all.length
    ? all.slice(0, limit).map((o) => `${dayHead(o)}<li class="order${o.cancelled ? ' cancelled' : ''}${o.refund ? ' refund' : ''}">
        <span class="time">${timeFmt.format(o.t)}</span>
        <span class="swatch ${o.c.cls}"></span>
        <span class="ch">${o.c.name}</span>
        <span class="kind">${esc(o.kind || '')}${o.cancelled ? '<span class="tag">Cancelled</span>' : ''}</span>
        <span class="amt">${money(o.amt)}</span>
      </li>`).join('')
    : `<li class="empty">${shown.some((c) => r.days.some((k) => rec(k, c.id))) ? 'No orders yet.' : 'Loading…'}</li>`;
  const more = document.getElementById('moreBtn');
  more.hidden = all.length <= 40 || showAll;
  more.textContent = `Show all ${all.length}`;
}

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
      REMOTE ? '<span></span>' : `<a href="${esc(link)}" target="_blank" rel="noopener">Open site</a>`}</li>`;
  });
  document.getElementById('conns').innerHTML = rows.join('');
  document.getElementById('version').textContent = IN_EXTENSION
    ? `Add-on version ${chrome.runtime.getManifest().version}`
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
const RANGE_NAMES = { today: 'Today', yesterday: 'Yesterday', week: 'This week', lastweek: 'Last week', month: 'This month', lastmonth: 'Last month' };
let rangeLabelsDay = '';
function labelRangeButtons() {
  const T = todayKey();
  if (rangeLabelsDay === T) return;
  rangeLabelsDay = T;
  for (const b of document.querySelectorAll('.range button[data-view]')) {
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
  const last = data.lastRefresh;
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
const normName = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/&/g, 'and').replace(/(\d+)\s*pcs?\b/g, '$1 pieces').replace(/\bpcs?\b/g, 'pieces')
  .replace(/[^a-z0-9]+/g, ' ').trim();
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
      const base = all ? th.appSales : sales;
      // the % goes with the label so the amount stays on one line on small phones
      const share = base > 0 ? ` · ${pct(th.fees, base)}%${all ? ' of app sales' : ''}` : '';
      stats.push([`${th.approx ? '≈' : ''}${money(th.get)}`, all ? 'you get paid (before card fees)' : 'you get paid'],
        [money(th.fees), `app fees${share}`]);
    } else stats.push(['…', `checking what ${all ? 'the apps pay' : c.name + ' pays'}`]);
    payNote = all
      ? '"You get paid" is what DoorDash, Uber Eats and Grubhub pay after their commission and fees, the promotions and ads you run there and refunds, plus in-store and website sales in full (the website has no commission). Card fees aren\'t included.'
      : `"You get paid" is what ${c.name} pays after its commission and fees, the promotions and ads you run there, refunds and error charges, from its ${PAYOUT_REPORT[c.id]} report.`;
    if (th?.approx) payNote += all ? ' Orders the apps haven\'t finished yet are estimated at each app\'s usual rate.'
      : ' Orders it hasn\'t finished yet are estimated at its usual rate.';
  } else if (!all && c.id === 'owner') {
    stats.push([money(sales), 'you get paid'], ['None', 'app commission']);
    payNote = 'Owner charges a flat monthly fee, not a commission per order. Card fees aren\'t included.';
  } else if (!all && c.id === 'instore') {
    payNote = 'Clover card fees aren\'t included in these numbers.';
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
  const prev = !r.days.includes(T) && covered(r.cmp) ? tallyItems(r.cmp, chans).items : null;
  const lateNote = [...new Set(missing.map(([, ch]) => ch))].filter((ch) => LATE_ITEMS[ch]).map((ch) => LATE_ITEMS[ch]);
  html += `<section class="d-sec"><div class="d-sec-head"><h3>Best sellers</h3><div class="d-sort" role="group" aria-label="Sort best sellers">${
    [['qty', 'Number sold'], ['sales', 'Sales']].map(([k, label]) => `<button data-sort="${k}" aria-pressed="${(k === 'sales') === detailSortBySales}">${label}</button>`).join('')}</div></div>`;
  if (!sorted.length) {
    html += `<p class="muted">${lateNote.length ? `${lateNote.join(' and ')} ${lateNote.length === 1 ? 'publishes' : 'publish'} what sold a day later, so these items will show tomorrow.` : 'No items sold yet.'}</p>`;
  } else {
    const top = detailAllItems ? sorted : sorted.slice(0, 10);
    html += itemTable(top, itemCents, prev && prev.size ? prev : null, all, `vs ${r.cmpWhen}`);
    if (sorted.length > 10) html += `<button class="link-btn d-more" id="detailMore">${detailAllItems ? 'Show top 10' : `Show all ${sorted.length} items`}</button>`;
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
      const dayRows = [1, 2, 3, 4, 5, 6, 0].filter((wd) => byDay.has(wd)).map((wd) => ({ label: WEEKDAYS[wd], n: byDay.get(wd).n, cents: byDay.get(wd).cents }));
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

function openDetail(ch) {
  detailCh = ch;
  detailAllItems = false;
  if (!detailEl.open) {
    detailEl.showModal();
    history.pushState({ canamDetail: true }, ''); // so the phone's Back button closes the panel
  }
  renderDetail();
  detailEl.scrollTop = 0;
}
detailEl.addEventListener('close', () => { if (history.state?.canamDetail) history.back(); });
addEventListener('popstate', () => { if (detailEl.open) detailEl.close(); });

document.getElementById('tiles').addEventListener('click', (e) => {
  const t = e.target.closest('.tile[data-ch]');
  if (t) openDetail(t.dataset.ch);
});
document.getElementById('tiles').addEventListener('keydown', (e) => {
  const t = e.target.closest('.tile[data-ch]');
  if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openDetail(t.dataset.ch); }
});
document.getElementById('heroDetail').addEventListener('click', () => openDetail('all'));
document.getElementById('detailClose').addEventListener('click', () => detailEl.close());
detailEl.addEventListener('click', (e) => {
  if (e.target === detailEl) detailEl.close(); // tap outside the panel
  if (e.target.id === 'detailMore') { detailAllItems = !detailAllItems; renderDetail(); }
  const sortBtn = e.target.closest('button[data-sort]');
  if (sortBtn) { detailSortBySales = sortBtn.dataset.sort === 'sales'; renderDetail(); }
});
document.getElementById('detailRange').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b) { detailAllItems = false; selectView({ type: b.dataset.view }); }
});

function render() {
  const r = rangeFor(view);
  renderHeader();
  renderAlerts();
  renderSummary(r);
  renderNewCustomers();
  renderChart(r);
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
setInterval(() => { renderHeader(); renderConnections(); }, 1000); // "updated … ago" ticks every second
await reload();
