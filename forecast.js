// How much of something (doughs of one size, or one app's sales) a day is likely to need, from the
// store's own past days (version 1.19.0, 2026-11-09). Plain code: no page, no Chrome, so the add-on's
// background, the page and the tests (phone/tools/test-dough.mjs) all use the same numbers.
//
// The method, per series and per time window, using 15-minute slots:
//   recent level  = the average day over the last 21 days with data, each day first divided by its
//                   weekday's ratio (so a run with an extra Friday doesn't look busier)
//   × that weekday's usual ratio to the average day (last 8 weeks; a weekday needs 2 days of its own)
//   × that weekday's usual share of the day that falls in the window (the time of day things sell).
// Only days from 2026-09-25 on are read (CAN AM PIZZA's own Clover account; the 35 days before are the
// previous owner's, which the owner doesn't trust), and promo days are left out. With under 7 days
// there are no weekday ratios (every day counts the same) and the time of day comes from all days.
//
// Times are minutes after midnight in the store's own clock, counted from day T's midnight ("relative
// minutes": 1440 + 870 = 2:30 PM the next day). Nothing here adds milliseconds, so the days the clocks
// change (Nov 1, 2026; Mar 14, 2027) come out right.
import { addDays, weekdayOf } from './lib.js';

export const FORECAST_FROM = '2026-09-25'; // nothing before this day is ever read
// Days left out of the history: a promo made them unusual. 2026-10-30 to 11-01: free 12-pc cheesy
// breadsticks with a Large or XL (each one a medium dough, so Medium ran far above normal).
export const PROMO_DAYS = new Set(['2026-10-30', '2026-10-31', '2026-11-01']);
export const LEVEL_DAYS = 21;
export const PATTERN_DAYS = 56;
export const MIN_DAYS = 7;
export const SLOTS = 96;
export const DAY_MIN = 1440;

export const usableDay = (k) => k >= FORECAST_FROM && !PROMO_DAYS.has(k);

// The usable days before T, newest first, looking back at most `max` calendar days.
export function pastDays(T, max = PATTERN_DAYS) {
  const out = [];
  for (let i = 1; i <= max; i++) {
    const k = addDays(T, -i);
    if (k < FORECAST_FROM) break;
    if (usableDay(k)) out.push(k);
  }
  return out;
}

const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
const sumOf = (p) => { let s = 0; for (let i = 0; i < p.length; i++) s += p[i]; return s; };

// What a 96-slot day has in [a, b) minutes, sharing a slot out evenly when the window cuts it.
export function slotSum(p, a, b) {
  const lo = Math.max(0, a), hi = Math.min(DAY_MIN, b);
  if (hi <= lo) return 0;
  let s = 0;
  for (let i = Math.floor(lo / 15); i < SLOTS && i * 15 < hi; i++) {
    const x = Math.max(lo, i * 15), y = Math.min(hi, i * 15 + 15);
    if (y > x) s += (p[i] || 0) * (y - x) / 15;
  }
  return s;
}

// series(k) -> { total, slots: 96 numbers } for day k, or null when that day isn't known (skipped).
// Returns null without any usable day before T.
export function buildModel(T, series) {
  const hist = [];
  for (const k of pastDays(T)) {
    const d = series(k);
    if (d && Number.isFinite(d.total)) hist.push({ k, w: weekdayOf(k), total: d.total, slots: d.slots || [] });
  }
  if (!hist.length) return null;
  const thin = hist.length < MIN_DAYS;
  const byW = Array.from({ length: 7 }, () => []);
  for (const h of hist) byW[h.w].push(h);
  const ratio = Array(7).fill(1);
  if (!thin) {
    const wm = byW.map((L) => (L.length >= 2 ? mean(L.map((h) => h.total)) : null));
    const have = wm.filter((x) => x != null);
    const base = have.length ? mean(have) : 0;
    if (base > 0) for (let w = 0; w < 7; w++) if (wm[w] != null) ratio[w] = wm[w] / base;
  }
  const recent = hist.slice(0, LEVEL_DAYS).filter((h) => ratio[h.w] > 0.05);
  const level = recent.length ? mean(recent.map((h) => h.total / ratio[h.w])) : 0;
  const profile = (L) => {
    const p = new Float64Array(SLOTS);
    for (const h of L) for (let i = 0; i < SLOTS; i++) p[i] += Math.max(0, h.slots[i] || 0);
    return p;
  };
  const pooled = profile(hist);
  const profW = byW.map((L) => (!thin && L.length >= 2 ? profile(L) : null));
  const totals = profW.map((p) => (p ? sumOf(p) : 0));
  const pooledTotal = sumOf(pooled);
  // the share of weekday w's day in [a, b)
  const share = (w, a, b) => {
    if (profW[w] && totals[w] > 0) return slotSum(profW[w], a, b) / totals[w];
    if (pooledTotal > 0) return slotSum(pooled, a, b) / pooledTotal;
    return Math.max(0, Math.min(b, DAY_MIN) - Math.max(a, 0)) / DAY_MIN;
  };
  return {
    T, days: hist.map((h) => h.k), n: hist.length, thin, level, ratio, share,
    dayTotal: (k) => level * ratio[weekdayOf(k)],
    expect: (k, a, b) => level * ratio[weekdayOf(k)] * share(weekdayOf(k), a, b),
  };
}

// Day key and minute of a relative minute (see the top).
export function relDay(T, t) {
  const d = Math.floor(t / DAY_MIN);
  return { k: addDays(T, d), m: t - d * DAY_MIN };
}

// What the model expects between relative minutes t0 and t1 (they may cross midnight, more than once).
export function expectSpan(model, T, t0, t1) {
  if (!model || !(t1 > t0)) return 0;
  let s = 0;
  for (let d = Math.floor(t0 / DAY_MIN); d * DAY_MIN < t1; d++) {
    const a = Math.max(t0 - d * DAY_MIN, 0), b = Math.min(t1 - d * DAY_MIN, DAY_MIN);
    if (b > a) s += model.expect(addDays(T, d), a, b);
  }
  return s;
}

// How many to have for an expected need E: E plus k × its square root (busy days swing more), whole doughs.
export const withBuffer = (E, k) => (E > 0 ? Math.ceil(E + k * Math.sqrt(E) - 1e-6) : 0);
// How many more to mix to get to `need`, with `onHand` already there (never below zero; part-doughs
// on hand don't count).
export const mixNeeded = (need, onHand) => Math.max(0, Math.ceil(need) - Math.max(0, Math.floor((Number(onHand) || 0) + 1e-9)));

// The q-th quantile (0..1) of numbers, in between where needed.
export function quantile(values, q) {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return NaN;
  const i = (v.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return v[lo] + (v[hi] - v[lo]) * (i - lo);
}

// Walk-forward check: for each usable day before T (the last `look` days) that had at least `minHist`
// days of history itself, what really happened over what was expected that morning, all the series
// added up. Used for the likely range of expected sales.
export function walkRatios(T, seriesList, { look = PATTERN_DAYS, minHist = 14 } = {}) {
  const out = [];
  for (const k of pastDays(T, look)) {
    let fc = 0, act = 0, ok = false;
    for (const series of seriesList) {
      const d = series(k);
      if (!d) continue;
      const m = buildModel(k, series);
      if (!m || m.n < minHist) continue;
      fc += m.dayTotal(k);
      act += d.total;
      ok = true;
    }
    if (ok && fc > 0) out.push(act / fc);
  }
  return out;
}

// Expected sales for day T as of minute `now` of that day (version 1.19.0): what has come in so far plus
// what the rest of the day usually brings, per channel and added up. Same method as the dough: each
// channel's recent level × that weekday's ratio × the share of the day still to come.
// channels = [{ id, series(k) -> { total, slots } | null, soFar }], money in cents.
// The likely range is the middle 80% of how the morning's number did on past days (walk-forward),
// applied to the part of the day still to come; null (hidden) with fewer than RANGE_MIN_DAYS such days.
// Returns null without any history.
export const RANGE_MIN_DAYS = 14;
export function expectedSales(T, now, channels, ratios = null) {
  const rows = channels.map((c) => {
    const m = buildModel(T, c.series);
    const soFar = Math.max(0, Number(c.soFar) || 0);
    const rest = m ? Math.max(0, m.expect(T, now, DAY_MIN)) : 0;
    return { id: c.id, known: !!m, n: m ? m.n : 0, soFar, rest, expect: soFar + rest, day: m ? m.dayTotal(T) : 0 };
  });
  const known = rows.filter((r) => r.known);
  if (!known.length) return null;
  const soFar = rows.reduce((a, r) => a + r.soFar, 0);
  const rest = rows.reduce((a, r) => a + r.rest, 0);
  const r = ratios || walkRatios(T, channels.map((c) => c.series));
  const range = r.length >= RANGE_MIN_DAYS
    ? [soFar + rest * Math.min(1, quantile(r, 0.1)), soFar + rest * Math.max(1, quantile(r, 0.9))] : null;
  return { T, soFar, rest, expect: soFar + rest, range, days: Math.max(...known.map((x) => x.n)), checked: r.length, channels: rows };
}
