// Made-up numbers so the dashboard can be previewed outside Chrome's add-on.
// Only used when the page is opened as a normal web page.
import { todayKey, addDays, dayBounds, minuteOfDay, weekdayOf, mondayWeekStartOf, kitchenItems } from './lib.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

const HOURS = [10, 11, 11, 12, 12, 12, 13, 13, 14, 15, 16, 17, 17, 18, 18, 18, 19, 19, 20, 20, 21];
const NAMES = ['Maria G.', 'Ethen R.', 'Sam P.', 'Priya K.', 'DeShawn W.', 'Lena T.', 'Chris O.', 'Aisha B.', 'Jordan M.'];

const MENU = [
  ['Large Cheese Pizza', 1599], ['2 Large 2-Topping Pizzas', 2999], ['Butter Chicken Pizza', 2299], ['Medium Cheese', 1899],
  ['Pepperoni Pizza', 1799], ['Tandoori Paneer Pizza', 2299], ['Meatball Sub', 1149], ['Greek Gyro', 1299],
  ['12 Pieces Cheesy Bread Sticks', 1199], ['10 Pieces Mozzarella Sticks', 1499], ['Chicken Wings (10)', 1599],
  ['Butter Chicken Penne Pasta', 2299], ['Greek Dip', 89], ['Ranch Dip', 89], ['Garlic Dip', 89], ['Can', 199],
  ['2 Liter Soda', 399], ['Caesar Salad', 999], ['Karahi Paneer Sub', 999], ['Halal Chicken Wrap', 1099],
];
function makeItems(r, orders) {
  const items = {};
  for (let i = 0; i < orders; i++) {
    const n = 1 + Math.floor(r() * 3);
    for (let j = 0; j < n; j++) {
      const [name, price] = MENU[Math.floor(Math.pow(r(), 1.6) * MENU.length)];
      const it = items[name] || (items[name] = [0, 0]);
      it[0] += 1; it[1] += price;
    }
  }
  return items;
}

function makeDay(key, isToday) {
  const r = rng(key.split('-').join('') * 7);
  const [start] = dayBounds(key);
  const nowMin = minuteOfDay(Date.now());
  const weekend = [0, 5, 6].includes(weekdayOf(key));
  const plan = {
    instore: { n: Math.round((weekend ? 30 : 21) * (0.8 + r() * 0.4)), lo: 900, hi: 6200, kinds: ['Credit Card', 'Debit Card', 'Debit Card', 'Cash'] },
    doordash: { n: Math.round((weekend ? 12 : 8) * (0.7 + r() * 0.6)), lo: 1800, hi: 6400, kinds: ['Delivery', 'Delivery', 'Pickup'] },
    uber: { n: Math.round((weekend ? 5 : 3) * (0.5 + r())), lo: 2000, hi: 5200, kinds: ['Delivery'] },
    owner_clover: { n: Math.round((weekend ? 9 : 6) * (0.7 + r() * 0.6)), lo: 1500, hi: 5600, kinds: ['External Payment'] },
    grubhub: { n: Math.round((weekend ? 2 : 1) * (0.5 + r())), lo: 2500, hi: 6000, kinds: ['Delivery', 'Delivery', 'Pickup'] },
  };
  const out = {};
  for (const [ch, p] of Object.entries(plan)) {
    const rec = { sales: 0, orders: 0, list: [], extra: {}, fetchedAt: Date.now() };
    for (let i = 0; i < p.n; i++) {
      const h = HOURS[Math.floor(r() * HOURS.length)];
      const mi = Math.floor(r() * 60);
      if (isToday && h * 60 + mi > nowMin) continue;
      const amt = Math.round((p.lo + r() * (p.hi - p.lo)) / 10) * 10 - 1;
      const kind = p.kinds[Math.floor(r() * p.kinds.length)];
      const cancelled = ch !== 'instore' && r() < 0.04;
      const who = ch === 'instore' ? undefined : NAMES[Math.floor(r() * NAMES.length)];
      const n = ch === 'owner_clover' || ch === 'grubhub' ? 1 + Math.floor(r() * 4) : undefined;
      rec.list.push({ id: `${ch}-${key}-${i}`, t: start + (h * 60 + mi) * 60000, amt, kind, cancelled, who, n });
      if (cancelled) continue;
      rec.sales += amt;
      rec.orders += 1;
      if (ch === 'instore') {
        const b = kind === 'Cash' ? 'cash' : 'card';
        rec.extra[b] = (rec.extra[b] || 0) + amt;
      }
    }
    // what the app pays after its fees; today's last order isn't in the app's report yet
    const RATE = { doordash: 0.55, uber: 0.7, grubhub: 0.72 };
    if (RATE[ch]) {
      const paid = rec.list.filter((o) => !o.cancelled).slice(0, isToday ? -1 : undefined);
      rec.extra.paidSales = paid.reduce((a, o) => a + o.amt, 0);
      rec.extra.payout = Math.round(rec.extra.paidSales * RATE[ch]);
    }
    const items = makeItems(r, rec.orders);
    if (ch === 'doordash' || ch === 'uber') { if (!isToday) out[`i:${key}:${ch}`] = { items, sold: 1, discounts: ch === 'doordash' ? Math.round(rec.sales * 0.1) : 0 }; }
    else rec.items = items;
    if (ch === 'owner_clover') {
      const kinds = ['Website · Pickup', 'Website · Delivery', 'App · Pickup', 'Website'];
      const list = rec.list.map((o, i) => ({ ...o, kind: kinds[i % kinds.length] }));
      out[`d:${key}:owner`] = { ...rec, list, items, promos: r() < 0.6 ? { 'Coupon 40AUTUMN': [1 + Math.floor(r() * 3), 735] } : {}, extra: { discounts: 735 } };
    }
    out[`d:${key}:${ch}`] = rec;
  }
  // doughs from Clover: every order's doughs in its 15-minute slot (mostly large, some medium, few XL)
  const slots = new Map();
  let n = 0;
  for (const [k, rec] of Object.entries(out)) {
    if (!k.startsWith('d:') || k.endsWith(':owner')) continue;
    for (const o of rec.list || []) {
      if (o.cancelled) continue;
      n += 1;
      const slot = Math.floor(minuteOfDay(o.t) / 15);
      const x = slots.get(slot) || [slot, 0, 0, 0];
      for (let i = 0; i < 1 + Math.floor(r() * 2); i++) { const p = r(); x[p < 0.4 ? 1 : p < 0.9 ? 2 : 3] += 1; }
      slots.set(slot, x);
    }
  }
  out[`dough:${key}`] = { v: 1, s: [...slots.values()].sort((a, b) => a[0] - b[0]), gf: Math.floor(r() * 2), n, unknown: [] };
  return out;
}

// Made-up dough counts: the last two weeks have what was mixed and what was left at closing,
// and today has the 11 AM batch once it's past 11 AM (not with ?counts=none).
const ASK = new URLSearchParams(globalThis.location?.search || '');
function makeDough(T) {
  if (ASK.get('counts') === 'none') return {};
  const out = {};
  const r = rng(T.split('-').join('') * 3);
  for (let i = 1; i <= 14; i++) {
    const k = addDays(T, -i);
    const busy = [0, 5, 6].includes(weekdayOf(k));
    const am = { m: busy ? 8 : 6, l: busy ? 20 : 14, x: 2 }, pm = { m: busy ? 10 : 8, l: busy ? 24 : 16, x: 2 };
    const left = { m: Math.floor(r() * 4), l: Math.floor(r() * 6), x: Math.floor(r() * 2) };
    out[k] = { am: { ...am, at: 0 }, pm: { ...pm, at: 0 }, left: { ...left, at: 0 } };
  }
  if (minuteOfDay(Date.now()) >= 11 * 60) out[T] = { am: { m: 7, l: 15, x: 1, at: dayBounds(T)[0] + 11.1 * 3600e3, by: 'Maria' } };
  return out;
}

// Made-up "who entered what" log (the real one is the database's dough_log; owner only).
function makeDoughLog(T, dough) {
  const log = [];
  for (const [day, b] of Object.entries(dough)) {
    for (const [batch, c] of Object.entries(b)) {
      if (!c.at) continue;
      log.push({ at: c.at, day, batch, m: c.m, l: c.l, x: c.x, was: null, who: c.by || 'Owner' });
    }
  }
  const [start] = dayBounds(addDays(T, -1));
  log.push({ at: start + 22.3 * 3600e3, day: addDays(T, -1), batch: 'left', m: 3, l: 5, x: 1, was: { m: 3, l: 4, x: 1 }, who: '12535550100@phone.invalid' });
  log.push({ at: start + 15.1 * 3600e3, day: addDays(T, -1), batch: 'pm', m: 14, l: 30, x: 4, was: null, who: 'Sam' });
  return log.sort((a, b) => b.at - a.at);
}

export function makePreviewStore() {
  const listeners = [];
  let dough = null;
  const build = () => {
    const T = todayKey();
    dough ||= makeDough(T);
    let all = { doughCounts: dough, doughLog: makeDoughLog(T, dough) };
    for (let i = 0; i <= 100; i++) all = { ...all, ...makeDay(addDays(T, -i), i === 0) }; // the add-on keeps about 100 days
    // ?oldmissing=1: Sep 22's in-store is still waiting for Clover's old account (see CLOVER_OLD in sources.js)
    if (ASK.get('oldmissing') && all['d:2026-09-22:instore']) all['d:2026-09-22:instore'] = { ...all['d:2026-09-22:instore'], old: 'missing' };
    const tenPm = dayBounds(T)[0] + 22 * 3600 * 1000;
    return {
      ...all,
      'health:clover': { state: 'ok', at: Date.now() },
      'health:doordash': { state: 'ok', at: Date.now() },
      'health:uber': { state: 'ok', at: Date.now() },
      'health:grubhub': { state: 'ok', at: Date.now(), via: 'tab' },
      'store:grubhub': { state: 'open', at: Date.now() },
      'store:doordash': { state: 'paused', until: tenPm, at: Date.now() },
      'store:uber': { state: 'open', at: Date.now() },
      lastRefresh: Date.now() - 20000,
      upcoming: {
        at: Date.now() - 90e3,
        orders: [
          { ch: 'doordash', id: 'dd-up1', due: Date.now() + 2.5 * 3600e3, amt: 4599, who: 'Maria G.', kind: 'Delivery' },
          { ch: 'owner', id: 'ow-up2', due: dayBounds(addDays(T, 1))[0] + 12.5 * 3600e3, amt: 8997, who: 'Sam P.', kind: 'Pickup', n: 4,
            items: [{ name: '2 Large 2-Topping Pizzas', qty: 1, mods: ['Pepperoni', 'Mushrooms', 'Both Large 38.99'] }, { name: 'Butter Chicken Pizza', qty: 2, mods: ['Large 14"'] }, { name: 'Ranch Dip', qty: 1 }] },
          { ch: 'grubhub', id: 'gh-up3', due: dayBounds(addDays(T, 3))[0] + 18 * 3600e3, amt: 15240, who: 'Lakewood Office Lunch', kind: 'Delivery',
            items: [{ name: 'Large Cheese Pizza', qty: 4 }, { name: '12 Pieces Cheesy Bread Sticks', qty: 2 }] },
        ],
      },
      customers: {
        v: 2, day: T, at: Date.now() - 3600e3,
        doordash: { week: { new: 23, total: 71 }, month: { new: 142, total: 319 }, ranges: [[addDays(mondayWeekStartOf(T), -7), addDays(mondayWeekStartOf(T), -1)], ['2026-09-01', '2026-09-30']], at: Date.now() - 3600e3 },
        uber: { week: { new: 19, total: 31 }, month: { new: 62, total: 134 }, ranges: [[addDays(T, -6), T], [addDays(T, -29), T]], at: Date.now() - 3600e3 },
        owner: { week: { new: 16, total: 46 }, month: { new: 74, total: 165 }, ranges: [[addDays(T, -6), T], [addDays(T, -29), T]], at: Date.now() - 3600e3 },
        uberFunnel: { week: [['Viewed store', 2009], ['Viewed menu', 148], ['Added to cart', 42], ['Placed an order', 25]], month: [['Viewed store', 13003], ['Viewed menu', 927], ['Added to cart', 279], ['Placed an order', 132]], ranges: [[addDays(T, -9), addDays(T, -3)], [addDays(T, -32), addDays(T, -3)]] },
      },
    };
  };
  let logins = [{ id: '00000000-0000-4000-8000-000000000001', email: '12535550100@phone.invalid', name: 'Maria', added: new Date(Date.now() - 5 * 86400e3).toISOString(), lastSignIn: new Date(Date.now() - 3 * 3600e3).toISOString() }];
  return {
    load: async () => build(),
    onChange: (cb) => listeners.push(cb),
    refresh: () => new Promise((r) => setTimeout(r, 700)),
    set: async () => {},
    remove: async () => {},
    saveDough: async (day, batch, c) => {
      dough = { ...dough, [day]: { ...(dough[day] || {}), [batch]: { ...c, at: Date.now(), by: 'Owner' } } };
      listeners.forEach((cb) => cb());
    },
    // made-up employee logins (the real ones go through the kitchen-logins Edge Function)
    kitchenLogins: async (body) => {
      await new Promise((r) => setTimeout(r, 400));
      if (body.action === 'add') {
        if (!/@/.test(body.email || '')) throw new Error("That doesn't look like an email address.");
        logins = [...logins, { id: crypto.randomUUID(), email: body.email.toLowerCase(), name: body.name, added: new Date().toISOString(), lastSignIn: null }];
      }
      if (body.action === 'rename') logins = logins.map((l) => (l.id === body.id ? { ...l, name: body.name } : l));
      if (body.action === 'remove') logins = logins.filter((l) => l.id !== body.id);
      return { ok: true, logins };
    },
  };
}

// What an employee (kitchen) login's page gets: dough only, the scheduled orders without prices or
// names, and when the numbers were last checked. For testing the phone page's kitchen view.
export function makeKitchenPreviewStore() {
  const owner = makePreviewStore();
  return {
    ...owner,
    kitchen: true,
    email: '12535550100@phone.invalid',
    name: 'Maria',
    kitchenLogins: undefined,
    signOut: async () => {},
    load: async () => {
      const all = await owner.load();
      const out = { doughCounts: all.doughCounts, lastRefresh: all.lastRefresh, cloverAt: all.lastRefresh }; // no doughLog: owner only
      if (ASK.get('history') !== 'none') for (const [k, v] of Object.entries(all)) if (k.startsWith('dough:')) out[k] = { ...v, n: v.n > 0 ? 1 : 0 };
      out.upcoming = { at: all.upcoming.at, orders: all.upcoming.orders.map((o) => ({ due: o.due, ch: o.ch, kind: o.kind, ...(o.n ? { n: o.n } : {}), ...(kitchenItems(o.items) ? { items: kitchenItems(o.items) } : {}) })) };
      return out;
    },
  };
}
