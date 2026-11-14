// The Dough tab's numbers (version 1.19.0, 2026-11-09; two mixes a day since 1.26.0): the morning and
// afternoon mixes, what's left, when a size may run out and how many more to mix. Plain code over the
// stored data (no page, no Chrome calls), so the page (dashboard.js), the add-on's background (the
// pushes, dough-push.js) and the tests (phone/tools/test-dough.mjs) all work out exactly the same
// numbers. No money in or out.
//
// Two mixes a day, both in quiet hours (version 1.26.0, the owner, 2026-11-14: "I need a system where I
// am not making dough during busy times since making dough takes a long time"; a mix ties someone up
// for about an hour, and staff can mix at 11 AM and between 2 and 3:30 PM):
//   - the morning mix at MIX_TIME (11 AM), ready at MIX_READY (noon), covers until the afternoon mix is
//     ready (AM_COVER) plus the extra DOUGH_K; last night's leftovers are used first and come off it;
//   - the afternoon mix is worked out at PM_DECIDE (2 PM) from what is really on hand then (leftovers +
//     the morning mix + anything entered, less what the orders used), mixed by PM_MIX_BY (3 PM, planned
//     at PM_MIX_TIME, 2:30 PM) and ready at PM_READY (3:30 PM). It covers until closing plus the next
//     morning until the next morning mix is ready at noon (COVER_UNTIL the next day), plus the extra
//     DOUGH_K_PM. Nothing is planned after it, so its extra carries the dinner risk.
//   - Between BUSY_FROM and BUSY_UNTIL (4 to 8 PM) nothing ever asks for a mix: a size expected to run
//     out is only said ("Medium may run out around 8:45 PM"), in `watch`, never in `low` (no warning
//     box, no push). Before 4 PM and from 8 PM the running-low warning works as before.
// Twelve-hour dough (version 1.25.0, the owner, 2026-11-14: "the dough basically expires after 12
// hours", counted from when it is ready): dough left at closing is still used first the next morning,
// so it is counted as stock and taken off the next mix.
//
// Counts people can enter (dough_counts), per size: 'am' = new doughs of the morning mix (not last
// night's), 'pm' = doughs mixed later in the day, all of them added up: from 2 PM on that is the
// afternoon mix (plus any extra), before 2 PM an extra mix (on days before ONE_MIX_FROM it was the
// second batch of the day: also new doughs mixed later that day, so it reads the same), 'left' = left
// over after closing. Nothing has to be entered: without a count, the suggestion is taken as mixed and
// last night's leftovers are worked out from the orders.
import { addDays, weekdayOf, minuteOfDay, dayKeyOf, daysBetween } from './lib.js';
import { doughOfItems, doughForLine } from './dough.js';
import { FORECAST_FROM, usableDay, pastDays, buildModel, expectSpan, withBuffer, mixNeeded, SLOTS } from './forecast.js';

export const DOUGH_SIZES = [['M', 'Medium', 'm'], ['L', 'Large', 'l'], ['X', 'XL', 'x']];
export const DOUGH_CHANNELS = ['instore', 'doordash', 'uber', 'owner', 'grubhub'];
const LIVE_ITEMS = ['instore', 'owner']; // what sells here is known as it happens
// ----- the times of the day's dough, all in one place (minutes after midnight, the store's clock) -----
// The push function (phone/dough-reminder.ts) has its own copies; the tests check they are the same.
export const MIX_TIME = 11 * 60; // the morning mix (owner, 2026-11-09)
export const DOUGH_RISE = 60; // minutes from mixing until the dough can be used (owner, 2026-10-21)
export const MIX_READY = MIX_TIME + DOUGH_RISE; // noon
export const PM_DECIDE = 14 * 60; // 2 PM: the afternoon number is worked out and shown (owner, 2026-11-14)
export const PM_MIX_TIME = 14 * 60 + 30; // the afternoon mix is planned for about 2:30 PM ...
export const PM_MIX_BY = 15 * 60; // ... and has to be mixed by 3 PM
export const PM_READY = PM_MIX_TIME + DOUGH_RISE; // ready about 3:30 PM
export const BUSY_FROM = 16 * 60; // no mixing between 4 PM ...
export const BUSY_UNTIL = 20 * 60; // ... and 8 PM (the dinner rush, peak 5-8 PM)
export const inBusyHours = (m) => m >= BUSY_FROM && m < BUSY_UNTIL;
// The morning mix lasts until the afternoon mix is ready; the afternoon mix until the next day's
// morning mix is ready at noon (COVER_UNTIL the next day; twelve-hour dough, 1.25.0).
export const AM_COVER = PM_READY;
export const COVER_UNTIL = MIX_READY;
export const DAY_END = 24 * 60;
// The first day with one mix. Before it there was also a second mix in the afternoon, so a day before
// it without a counted 'pm' can't be worked out (its leftover is then "not known" and nothing is taken
// off). Set it to the day the kitchen really starts mixing once, if that isn't this day.
export const ONE_MIX_FROM = '2026-11-10';
// The first day with two planned mixes (version 1.26.0). On it and after, a day with no 'pm' entered
// is taken to have had the afternoon suggestion mixed (as a missing 'am' is the morning suggestion).
// Days from ONE_MIX_FROM until the day before are read as one-mix days (one 11 AM mix to noon the next
// day, ONE_MIX_K). Set it to the day the kitchen really starts mixing twice, if that isn't this day.
export const TWO_MIX_FROM = '2026-11-15';
// Closing and opening time by weekday, Sunday first: Mon–Thu 10–10, Fri 10–11, Sat 11–11, Sun 11–10
// (the owner, 2026-10-25).
export const CLOSES = [22 * 60, 22 * 60, 22 * 60, 22 * 60, 22 * 60, 23 * 60, 23 * 60];
export const OPENS = [11 * 60, 10 * 60, 10 * 60, 10 * 60, 10 * 60, 10 * 60, 11 * 60];
// Extra on top of the expected need: k × its square root, per size and per mix. Picked on 2026-11-14
// for two mixes by a walk-forward test of this same forecast on Clover's 15-minute slots (31 mix days,
// Oct 9 – Nov 12, the promo left out, leftovers carried over and used first, no other mixing;
// Docs/Dough Forecast Study/two_mix_plan.md):
//            afternoon k   left at closing (avg)   days a size ran out before closing (of 31)
//   Medium   2.5           16                      0
//   Large    3.5           17                      1   (by 7 on Nov 6: 30 large at 8 PM)
//   XL       3.0            8.5                    1   (by 1)
//   All three: 41.5 left a night (one mix to noon, 1.25.0, with no extra mixes: 35 and 5 run-out days;
//   one mix to 2:30 PM, before 1.25.0: 54 and 1). The morning k (2.0) hardly changes what is left at
//   closing (what is left at 2 PM comes off the afternoon mix) and keeps Medium and Large from running
//   short before the afternoon mix is ready.
export const DOUGH_K = { M: 2.0, L: 2.0, X: 2.0 }; // the morning mix
export const DOUGH_K_PM = { M: 2.5, L: 3.5, X: 3.0 }; // the afternoon mix
// One-mix days (ONE_MIX_FROM until TWO_MIX_FROM), only to work out what was left on those days.
export const ONE_MIX_K = { M: 2.0, L: 2.5, X: 2.0 };
export const DOUGH_LEARN_DAYS = 3;
export const NO_LEARNING = { M: { x: 1, n: 0 }, L: { x: 1, n: 0 }, X: { x: 1, n: 0 } };
export const noDough = () => ({ M: 0, L: 0, X: 0 });
export const sumOf = (c) => (c ? (c.m || 0) + (c.l || 0) + (c.x || 0) : 0);
const buffered = (E, s) => withBuffer(E, DOUGH_K[s]);
const bufferedPm = (E, s) => withBuffer(E, DOUGH_K_PM[s]);
const floor15 = (t) => Math.floor(Math.max(0, t) / 15) * 15; // orders are known by 15-minute slot

// A minute relative to day T's midnight (1440 + 600 = 10 AM the next day) for a time stamp. Counted
// in days and minutes of the store's own clock, never in milliseconds, so it's right on the days the
// clocks change.
export const relMinute = (T, ts) => daysBetween(T, dayKeyOf(ts)) * DAY_END + minuteOfDay(ts);

// Doughs in scheduled orders due in [from, to) relative minutes of day T, from the items each app
// gives (website & app and Grubhub do; DoorDash and Uber Eats don't, so those are skipped). Only items
// whose size is known from the name or the choices made; a specialty pizza without one is skipped.
export function scheduledDough(upcoming, T, from, to) {
  const out = noDough();
  for (const o of upcoming?.orders || []) {
    if (!o?.due || !Array.isArray(o.items)) continue;
    const t = relMinute(T, o.due);
    if (t < from || t >= to) continue;
    for (const it of o.items) {
      const mods = Array.isArray(it.mods) ? it.mods.map(String) : [];
      const text = `${it.name} ${mods.join(' ')}`;
      if (!/\b(medium|large|x-?large|extra large|calzone|bread ?sticks|cheese sticks|curry bites|lunch special)\b/i.test(text)) continue;
      const d = doughForLine(String(it.name || ''), mods, 0, o.ch, dayKeyOf(o.due));
      if (!d || !d.known || d.gf) continue;
      const q = Math.max(1, Math.min(99, Math.round(Number(it.qty) || 1)));
      for (const [s] of DOUGH_SIZES) out[s] += (d[s] || 0) * q;
    }
  }
  return out;
}

// The extra mixes entered on day T, oldest first: [{ at, m, l, x, by }]. The 'pm' count holds them all
// added up, with the time and name of the last save. The owner's log (dough_log) has every save, so
// there each one has its own time; a kitchen login (no log), or a log that doesn't add up to the count,
// gets one entry at the last save's time (so all of it counts as ready an hour after the last one).
export function extraMixes(T, pm, log) {
  if (!pm || !sumOf(pm)) return [];
  const mine = (log || []).filter((e) => e.day === T && e.batch === 'pm').sort((a, b) => a.at - b.at);
  if (mine.length) {
    const list = mine.map((e) => ({ at: e.at, by: e.who || '', m: e.m - (e.was?.m || 0), l: e.l - (e.was?.l || 0), x: e.x - (e.was?.x || 0) }));
    const last = mine[mine.length - 1];
    const fits = list.every((e) => e.m >= 0 && e.l >= 0 && e.x >= 0) && last.m === (pm.m || 0) && last.l === (pm.l || 0) && last.x === (pm.x || 0);
    if (fits) return list.filter((e) => e.m || e.l || e.x);
  }
  return [{ at: pm.at || 0, by: pm.by || '', m: pm.m || 0, l: pm.l || 0, x: pm.x || 0, all: true }];
}

// Still to mix per size (version 1.24.0, the owner, 2026-11-13: "if it says to make 70 medium keep
// that up until we input 70 or up"): the larger of (a) the morning suggestion less everything entered
// as mixed today (the morning mix 'am' + the extras 'pm'), never below 0, and (b) how many the
// running-low warning asks for (x.more of a size in `low`). { m, l, x }; 0 = enough for that size.
// suggest = { m, l, x } (the morning suggestion), am / pm = today's entered counts or null.
export function stillToMix(suggest, am, pm, low) {
  const out = {};
  for (const [, , k] of DOUGH_SIZES) {
    const left = Math.max(0, Math.round((suggest?.[k] || 0) - (am?.[k] || 0) - (pm?.[k] || 0)));
    const short = (low || []).find((x) => x.k === k)?.more || 0;
    out[k] = Math.max(left, short);
  }
  return out;
}

// Dough left at closing that is more than tomorrow morning needs (version 1.25.0): per size, left less
// what the next morning should need until the new mix is ready at noon (with the usual extra, so a busy
// morning still has enough). Only sizes at least SPARE_SHOW over are listed. left / need = { m, l, x }.
export const SPARE_SHOW = 3;
export function spareAtClosing(left, need) {
  if (!left || !need) return null;
  const over = {}, needs = {};
  let any = false;
  for (const [, , k] of DOUGH_SIZES) {
    const n = Math.max(0, Math.round(need[k] || 0));
    const o = Math.round((left[k] || 0) - n);
    needs[k] = n;
    over[k] = o >= SPARE_SHOW ? o : 0;
    if (over[k]) any = true;
  }
  return any ? { over, need: needs } : null;
}

// Everything worked out from one copy of the stored data. opts.kitchen: an employee login (no sales).
export function doughEngine(data, opts = {}) {
  const kitchen = !!opts.kitchen;
  // Once there are Clover counts, only those are used, so every screen (the owner's and the kitchen's,
  // which can't see sales) works from the same numbers.
  const clover = Object.keys(data).some((key) => key.startsWith('dough:') && key.slice(6) >= FORECAST_FROM && data[key]?.n > 0);
  const days = new Map(), models = new Map(), factors = new Map(), lefts = new Map(), tracks = new Map();
  const itemsFor = (day, ch) => data[`d:${day}:${ch}`]?.items || data[`i:${day}:${ch}`]?.items || null;
  const counts = (k) => data.doughCounts?.[k] || {};

  // One day's doughs: { slots } from Clover's 15-minute slots, or { chans } from each app's items and
  // order times; null when that day can't be counted, or is before FORECAST_FROM (never read).
  function doughDay(k) {
    if (!days.has(k)) days.set(k, readDay(k));
    return days.get(k);
  }
  function readDay(k) {
    if (k < FORECAST_FROM) return null;
    const c = data[`dough:${k}`];
    if (c?.s && c.n > 0) return { slots: c.s, gf: c.gf || 0, unknown: c.unknown || [], clover: true };
    if (clover) return null;
    if (!(data[`d:${k}:instore`]?.orders > 0)) return null;
    const day = { chans: [], unknown: [] };
    for (const ch of DOUGH_CHANNELS) {
      const r = data[`d:${k}:${ch}`];
      const items = itemsFor(k, ch);
      if (!items || !Object.keys(items).length) {
        // DoorDash and Uber Eats publish what sold a day later; Grubhub items are only known for some orders
        if (ch !== 'grubhub' && (r?.orders || 0) > 0) return null;
        continue;
      }
      const d = doughOfItems(items, ch, k);
      const times = (r?.list || []).filter((o) => !o.cancelled).map((o) => [minuteOfDay(o.t), o.amt]);
      day.chans.push({ ch, d, times, total: times.reduce((a, [, amt]) => a + amt, 0) });
      day.unknown.push(...d.unknown);
    }
    return day;
  }

  // Doughs one day used between two minutes of that day.
  function usedBetween(day, a, b) {
    const out = noDough();
    if (!day) return out;
    if (day.slots) {
      for (const [slot, M, L, X] of day.slots) if (slot * 15 >= a && slot * 15 < b) { out.M += M; out.L += L; out.X += X; }
      return out;
    }
    for (const c of day.chans) {
      let share;
      if (c.total > 0) share = c.times.reduce((x, [m, amt]) => x + (m >= a && m < b ? amt : 0), 0) / c.total;
      else share = Math.max(0, Math.min(b, 23 * 60) - Math.max(a, MIX_TIME)) / (12 * 60); // no order times: an even day
      for (const [s] of DOUGH_SIZES) out[s] += c.d[s] * share;
    }
    return out;
  }
  function sizeSlots(day, s) {
    const p = new Array(SLOTS).fill(0);
    if (day.slots) {
      const i = { M: 1, L: 2, X: 3 }[s];
      for (const x of day.slots) if (x[0] >= 0 && x[0] < SLOTS) p[x[0]] += x[i];
    } else for (let j = 0; j < SLOTS; j++) p[j] = usedBetween(day, j * 15, j * 15 + 15)[s];
    return p;
  }
  const seriesMemo = new Map();
  const seriesOf = (s) => (k) => {
    const key = `${s}:${k}`;
    if (!seriesMemo.has(key)) {
      const d = doughDay(k);
      const slots = d ? sizeSlots(d, s) : null;
      seriesMemo.set(key, slots ? { total: slots.reduce((a, b) => a + b, 0), slots } : null);
    }
    return seriesMemo.get(key);
  };

  // The forecast per size as of the morning of day T (from the days before it), or null without history.
  function model(T) {
    if (!models.has(T)) {
      const m = {};
      for (const [s] of DOUGH_SIZES) m[s] = buildModel(T, seriesOf(s));
      models.set(T, m.M || m.L || m.X ? m : null);
    }
    return models.get(T);
  }
  // Doughs of size s the orders are expected to use between relative minutes t0 and t1 of day T.
  const expect = (T, s, t0, t1, f = NO_LEARNING) => expectSpan(model(T)?.[s], T, t0, t1) * f[s].x;

  // What the counts teach: doughs really used in a day (left from the night before + mixed − left at
  // closing) against what the orders show, per size, over the last 4 weeks. Kitchens use some dough the
  // orders don't show (remakes, staff food, dropped dough). A size with none left is skipped, since how
  // much more would have sold isn't known. Needs 3 days before it changes anything; 0.6–1.6 at most.
  function factor(T) {
    if (factors.has(T)) return factors.get(T);
    const f = {};
    for (const [s, , k] of DOUGH_SIZES) {
      let real = 0, sold = 0, n = 0;
      for (let i = 1; i <= 28; i++) {
        const d = addDays(T, -i);
        if (d < FORECAST_FROM) break;
        const c = counts(d);
        const got = doughDay(d);
        if (!c.am || !c.left || !got) continue;
        if ((d < ONE_MIX_FROM || d >= TWO_MIX_FROM) && !c.pm) continue; // the afternoon mix wasn't counted: not known
        const night = leftAt(addDays(d, -1), NO_LEARNING, 1);
        if (!night) continue;
        const left = c.left[k] || 0;
        const est = usedBetween(got, 0, DAY_END)[s];
        if (!left || est < 1) continue;
        real += (night[k] || 0) + (c.am[k] || 0) + (c.pm?.[k] || 0) - left;
        sold += est;
        n += 1;
      }
      f[s] = { x: n >= DOUGH_LEARN_DAYS && sold > 0 ? Math.min(1.6, Math.max(0.6, real / sold)) : 1, n };
    }
    factors.set(T, f);
    return f;
  }

  // The morning mix of day k, per size: { E (expected from the mix until the afternoon mix is ready),
  // make (with the extra and the scheduled orders), onHand (last night's, less what's used before the
  // mix), mix }. now = minute of day k (DAY_END for a past day); night = { m, l, x } left last night, or
  // null. past: worked out for a day that is over (to know what was left then): a one-mix day
  // (ONE_MIX_FROM until TWO_MIX_FROM) then gets the one mix it really had, to noon the next day.
  function plan(k, f, night, now = DAY_END, sched = noDough(), past = false) {
    if (!model(k)) return null;
    const one = past && k >= ONE_MIX_FROM && k < TWO_MIX_FROM;
    const until = one ? DAY_END + COVER_UNTIL : AM_COVER;
    const before = usedBetween(doughDay(k), 0, Math.min(now, MIX_TIME));
    const out = {};
    for (const [s, , key] of DOUGH_SIZES) {
      const E = expect(k, s, MIX_TIME, until, f);
      const make = withBuffer(E, (one ? ONE_MIX_K : DOUGH_K)[s]) + (sched[s] || 0);
      const soon = now < MIX_TIME ? expect(k, s, now, MIX_TIME, f) : 0;
      const onHand = Math.max(0, (night?.[key] || 0) - before[s] * f[s].x - soon);
      out[s] = { E, make, onHand, mix: mixNeeded(make, onHand) };
    }
    return out;
  }
  const mixOf = (k, p) => {
    const c = counts(k).am;
    return Object.fromEntries(DOUGH_SIZES.map(([s, , key]) => [key, c ? c[key] || 0 : p ? p[s].mix : 0]));
  };

  // What is really on hand at relative minute t of day T, for one size: last night's, then the
  // morning mix and each extra (list) added at its own time before t, less what the orders used until
  // t. As in onHandNow, stock never goes below zero before a mix. Without timed orders for that day it
  // takes off the usual use instead.
  function stockAt(T, t, f, s, key, night, mix, list) {
    const day = doughDay(T);
    const events = [{ t: MIX_TIME, add: mix[key] || 0 }, ...list.map((e) => ({ t: relMinute(T, e.at), add: e[key] || 0 }))]
      .filter((ev) => ev.t < t).sort((a, b) => a.t - b.t);
    if (!(day?.slots || day?.chans)) return events.reduce((a, ev) => a + ev.add, night?.[key] || 0) - expect(T, s, 0, t, f);
    const used = (a, b) => usedBetween(day, a, b)[s] * f[s].x;
    let stock = night?.[key] || 0, t0 = 0;
    for (const ev of events) {
      const at = floor15(ev.t);
      stock = Math.max(0, stock - used(t0, at)) + ev.add;
      t0 = Math.max(t0, at);
    }
    return stock - used(t0, t);
  }

  // The afternoon mix of day T (version 1.26.0), per size, as worked out at PM_DECIDE (2 PM) from what
  // was really on hand then: { E (expected from 2 PM until noon the next day), make (with the extra and
  // the scheduled orders), onHand (at 2 PM), mix }. mix = { m, l, x } the morning mix (entered or
  // suggested); list = the day's extra mixes (only those entered before 2 PM count as on hand).
  function afternoon(T, f, night, mix, list, sched = noDough()) {
    if (!model(T)) return null;
    const out = {};
    for (const [s, , key] of DOUGH_SIZES) {
      const E = expect(T, s, PM_DECIDE, DAY_END + COVER_UNTIL, f);
      const make = bufferedPm(E, s) + (sched[s] || 0);
      const onHand = stockAt(T, PM_DECIDE, f, s, key, night, mix, list);
      out[s] = { E, make, onHand, mix: mixNeeded(make, onHand) };
    }
    return out;
  }
  const trioOf = (p) => (p ? Object.fromEntries(DOUGH_SIZES.map(([s, , k]) => [k, p[s].mix])) : null);

  // Dough left at closing on day k: what was counted, or else worked out (the night before's leftovers,
  // looked at up to `depth` nights back, plus what was mixed, less what the orders used).
  // { m, l, x, worked } or null when it can't be known.
  function leftAt(k, f, depth = 2) {
    const c = counts(k);
    if (c.left) return { m: c.left.m || 0, l: c.left.l || 0, x: c.left.x || 0, at: c.left.at, worked: false };
    if (depth <= 0 || k < FORECAST_FROM) return null;
    if (k < ONE_MIX_FROM && !(c.am && c.pm)) return null; // two mixes then, and not both counted
    const key = `${k}:${depth}:${JSON.stringify(f)}`;
    if (lefts.has(key)) return lefts.get(key);
    let out = null;
    const day = doughDay(k);
    if (day) {
      const night = leftAt(addDays(k, -1), f, depth - 1);
      const p = c.am ? null : plan(k, f, night, DAY_END, noDough(), true);
      if (c.am || p) {
        const mix = mixOf(k, p);
        // from TWO_MIX_FROM on, a day with no afternoon count had the afternoon suggestion mixed
        const pm = c.pm || (k >= TWO_MIX_FROM ? trioOf(afternoon(k, f, night, mix, [])) : null);
        const used = usedBetween(day, 0, DAY_END);
        out = { worked: true };
        for (const [s, , kk] of DOUGH_SIZES) out[kk] = Math.max(0, Math.round((night?.[kk] || 0) + mix[kk] + (pm?.[kk] || 0) - used[s] * f[s].x));
      }
    }
    lefts.set(key, out);
    return out;
  }

  // Doughs used on day T so far: straight from Clover, where every app's orders come in as they happen.
  // Before the add-on has Clover's counts, in-store and website & app items are counted as they sell, and
  // DoorDash, Uber Eats and Grubhub (whose items come a day later) are worked out from their sales.
  function usedToday(T, f) {
    const today = doughDay(T);
    const used = noDough();
    if (today?.slots) Object.assign(used, usedBetween(today, 0, DAY_END));
    else if (!clover) {
      const sales = (ch) => (data[`d:${T}:${ch}`]?.list || []).reduce((a, o) => a + (o.cancelled ? 0 : o.amt), 0);
      for (const ch of LIVE_ITEMS) {
        const items = itemsFor(T, ch);
        if (!items) continue;
        const d = doughOfItems(items, ch, T);
        for (const [s] of DOUGH_SIZES) used[s] += d[s];
      }
      const rates = appRates(T);
      for (const ch of Object.keys(rates)) for (const [s] of DOUGH_SIZES) used[s] += sales(ch) * rates[ch][s];
    }
    for (const [s] of DOUGH_SIZES) used[s] *= f[s].x;
    return used;
  }
  // Doughs per dollar of DoorDash and Uber Eats sales over the last 2 weeks it can be counted.
  function appRates(T) {
    const sum = { doordash: { ...noDough(), cents: 0 }, uber: { ...noDough(), cents: 0 } };
    for (let i = 1, n = 0; i <= 28 && n < 14; i++) {
      const day = doughDay(addDays(T, -i));
      if (!day) continue;
      n += 1;
      for (const c of day.chans || []) {
        const t = sum[c.ch];
        if (!t) continue;
        for (const [s] of DOUGH_SIZES) t[s] += c.d[s];
        t.cents += c.total;
      }
    }
    const both = { cents: sum.doordash.cents + sum.uber.cents };
    for (const [s] of DOUGH_SIZES) both[s] = sum.doordash[s] + sum.uber[s];
    const rate = (t) => Object.fromEntries(DOUGH_SIZES.map(([s]) => [s, t.cents > 0 ? t[s] / t.cents : 0]));
    return { doordash: rate(sum.doordash), uber: rate(sum.uber), grubhub: rate(both) };
  }

  const extras = (T) => extraMixes(T, counts(T).pm, kitchen ? null : data.doughLog);

  // How many of one size are on hand now: last night's, then each mix added at its own time, less what
  // the orders used. When the orders used more than was there before a mix, there must have been more
  // dough than counted, so that mix isn't used up by the gap (stock never goes below zero before a mix).
  function onHandNow(T, now, f, s, key, night, mix, list) {
    const day = doughDay(T);
    const timed = !!(day?.slots || day?.chans);
    const used = (a, b) => (timed ? usedBetween(day, a, b)[s] * f[s].x : 0);
    const events = [{ t: Math.min(now, MIX_TIME), add: mix[key] || 0 },
      ...list.map((e) => ({ t: Math.min(now, relMinute(T, e.at)), add: e[key] || 0 }))].sort((a, b) => a.t - b.t);
    let stock = night?.[key] || 0, t0 = 0;
    for (const ev of events) {
      const t = Math.floor(Math.max(0, ev.t) / 15) * 15; // orders are known by 15-minute slot
      stock = Math.max(0, stock - used(t0, t)) + ev.add;
      t0 = Math.max(t0, t);
    }
    return stock - (timed ? used(t0, DAY_END) : usedToday(T, f)[s]);
  }

  // Everything the Dough tab, its warnings and the pushes show for the moment nowMs.
  function today(nowMs) {
    const T = dayKeyOf(nowMs);
    const now = minuteOfDay(nowMs);
    const f = factor(T);
    const c = counts(T);
    const wd = weekdayOf(T);
    const closes = CLOSES[wd], opens = OPENS[wd];
    const cover = DAY_END + COVER_UNTIL; // noon tomorrow, when tomorrow's morning mix is ready
    const out = {
      T, now, f, counts: c, closes, opens, open: now < closes, openNow: now >= opens && now < closes,
      tomorrow: addDays(T, 1), model: model(T), plan: null, lastNight: null, mix: null, ready: null, total: 0,
      extras: extras(T), amAssumed: !c.am, live: null, low: [],
      // version 1.26.0: 'am' until 2 PM (the big box is the morning mix), then 'pm' (the afternoon mix)
      phase: now < PM_DECIDE ? 'am' : 'pm', busy: inBusyHours(now),
      // the afternoon mix as worked out at 2 PM (from 2 PM on), what has been entered for it (everything
      // added to 'pm' from 2 PM on) and whether nothing has been, so the suggestion is counted on
      pmPlan: null, pmSuggest: null, pmIn: { m: 0, l: 0, x: 0 }, pmAssumed: false,
      // sizes expected to run out between 4 and 8 PM: said, never asked for (no mixing then)
      watch: [],
      // how long the running-low amount lasts: until the afternoon mix is ready (before 2 PM), else noon tomorrow
      lowUntil: now < PM_DECIDE ? AM_COVER : cover,
      // the suggestion of the mix in the big box now (morning until 2 PM, then the afternoon mix; it stays
      // what it was at 11 AM or 2 PM, whatever is entered) and how many of it, or of the running-low
      // amount, still have to be mixed (version 1.24.0; see stillToMix)
      suggest: null, toMix: { m: 0, l: 0, x: 0 },
      // what tomorrow morning should need until its mix is ready, with the extra (whole doughs), and
      // tonight's count less that when it is a lot more (version 1.25.0; see spareAtClosing)
      morningNeed: null, spare: null,
    };
    if (!out.model) return out;
    out.lastNight = leftAt(addDays(T, -1), f);
    out.plan = plan(T, f, out.lastNight, now, scheduledDough(data.upcoming, T, MIX_TIME, AM_COVER));
    out.mix = mixOf(T, out.plan);
    out.ready = Object.fromEntries(DOUGH_SIZES.map(([, , k]) => [k, out.mix[k] + (out.lastNight?.[k] || 0)]));
    out.total = sumOf(out.ready);
    out.suggest = trioOf(out.plan);
    const late = out.extras.filter((e) => relMinute(T, e.at) >= PM_DECIDE);
    for (const [, , k] of DOUGH_SIZES) out.pmIn[k] = late.reduce((a, e) => a + (e[k] || 0), 0);
    if (out.phase === 'pm') {
      out.pmPlan = afternoon(T, f, out.lastNight, out.mix, out.extras, scheduledDough(data.upcoming, T, PM_DECIDE, cover));
      out.pmSuggest = trioOf(out.pmPlan);
      out.pmAssumed = !sumOf(out.pmIn) && sumOf(out.pmSuggest) > 0;
    }
    const still = (low) => (out.phase === 'am' ? stillToMix(out.suggest, c.am, c.pm, low) : stillToMix(out.pmSuggest, null, out.pmIn, low));
    out.toMix = still([]);
    out.morningNeed = Object.fromEntries(DOUGH_SIZES.map(([s, , k]) => [k, buffered(expect(T, s, DAY_END, DAY_END + MIX_READY, f), s)]));
    out.spare = c.left ? spareAtClosing(c.left, out.morningNeed) : null;
    if (now < MIX_TIME && !c.am) return out;
    const used = usedToday(T, f);
    const H = out.lowUntil;
    const later = scheduledDough(data.upcoming, T, now, H);
    const sizes = DOUGH_SIZES.map(([s, name, k]) => {
      // really on hand, and the afternoon suggestion while nothing has been entered for it: counted on
      // as mixed (as a missing morning count is), ready at 3:30 PM
      const real = onHandNow(T, now, f, s, k, out.lastNight, out.mix, out.extras);
      const assumed = out.pmAssumed ? out.pmSuggest[k] : 0;
      // ... and what the rest of the day can count on
      const have = real + assumed;
      // dough mixed but not ready yet at relative minute t
      const waits = out.extras.filter((e) => e[k] > 0).map((e) => ({ until: relMinute(T, e.at) + DOUGH_RISE, n: e[k] }));
      // (the morning mix too, but only when last night's leftovers are known: without them there's no
      // telling whether the kitchen is short before noon)
      if (out.mix[k] > 0 && out.lastNight) waits.push({ until: MIX_READY, n: out.mix[k] });
      if (assumed > 0) waits.push({ until: PM_READY, n: assumed });
      const pending = (t) => waits.reduce((a, w) => a + (t < w.until ? w.n : 0), 0);
      const E = (t) => expect(T, s, now, t, f);
      let runOut = null;
      if (have < 0.5) runOut = now;
      else for (let t = Math.ceil((now + 1) / 15) * 15; t <= H; t += 15) if (E(t) > have + 0.5) { runOut = t; break; }
      // a short wait for dough that's mixed but not ready (mixing more wouldn't be ready sooner)
      let gapUntil = null;
      if (runOut == null && pending(now) > 0) {
        const readyAt = Math.max(...waits.filter((w) => w.until > now).map((w) => w.until));
        for (let t = now; t < readyAt; t += 15) if (E(t + 15) > have - pending(t) + 0.5) { gapUntil = readyAt; break; }
      }
      // before 2 PM: enough to last until the afternoon mix is ready (morning extra); from 2 PM: until
      // noon tomorrow (afternoon extra). Counted against what is really there, so a running-low amount
      // in the afternoon includes the afternoon mix still to be made.
      const bufd = now < PM_DECIDE ? buffered(E(H), s) : bufferedPm(E(H), s);
      const more = runOut == null ? 0 : Math.max(1, mixNeeded(bufd + later[s], real));
      // (tight: more than one dough under the extra, so a mix sized exactly to it isn't called tight by rounding)
      const status = runOut != null ? 'short' : gapUntil != null ? 'gap' : have + 1 < bufd ? 'tight' : 'ok';
      // "left right now" counts the afternoon suggestion from when it is due to be mixed (2:30 PM)
      const left = now >= PM_MIX_TIME ? have : real;
      return { s, name, k, left, used: used[s], runOut, urgent: runOut != null && runOut < closes, more, gapUntil, status };
    });
    out.live = {
      sizes, open: out.open,
      usedTotal: DOUGH_SIZES.reduce((a, [s]) => a + used[s], 0),
      usualTotal: DOUGH_SIZES.reduce((a, [s]) => a + expect(T, s, 0, now, f), 0),
    };
    // The sizes to warn about (and push about): only while the store is open, from the morning mix time
    // on, and never between 4 and 8 PM: then a size that may run out is only said (watch).
    if (out.openNow && now >= MIX_TIME) {
      const short = sizes.filter((x) => x.status === 'short' && x.more > 0);
      if (out.busy) out.watch = short;
      else out.low = short;
    }
    out.toMix = still(out.low);
    return out;
  }

  // Doughs used so far on day T (the raw count, no learning) for the Used today card, and what the
  // orders are likely to use by the end of the day (used so far + the usual rest of the day, no extra).
  // { state: 'clover' | 'sales' | 'missing', c, total, orders, at, expect: { m, l, x, total } | null }
  function usedSoFar(T, now) {
    const rec = data[`dough:${T}`];
    const at = rec?.at || data['health:clover']?.at || data.cloverAt || null;
    const day = doughDay(T);
    const exp = (c) => {
      if (!model(T)) return null;
      const e = Object.fromEntries(DOUGH_SIZES.map(([s, , k]) => [k, Math.round((c?.[k] || 0) + expect(T, s, now, DAY_END))]));
      return { ...e, total: sumOf(e) };
    };
    let state;
    if (day?.clover) state = 'clover';
    else if (rec?.s && !(rec.n > 0)) state = 'clover'; // today's Clover day is in, with no orders yet
    else if (!clover && !kitchen && data[`d:${T}:instore`]) state = 'sales';
    else return { state: 'missing', at, expect: exp(null) };
    const used = state === 'clover' && !day ? noDough() : usedToday(T, NO_LEARNING);
    const c = Object.fromEntries(DOUGH_SIZES.map(([s, , k]) => [k, Math.max(0, Math.round(used[s] || 0))]));
    return { state, c, total: sumOf(c), orders: rec ? rec.n > 0 : DOUGH_CHANNELS.some((ch) => data[`d:${T}:${ch}`]?.orders > 0), at, expect: exp(c) };
  }

  // How the two mixes would have done on the last 6 weeks (from the orders alone, nothing on hand):
  // for each mix day whose next day is over, per size, was the morning number enough until the
  // afternoon mix was ready, and the afternoon number (with what it counts on at 2 PM) enough from 2 PM
  // until noon the next day? left = what the afternoon number had left at noon the next day.
  function track(T) {
    if (tracks.has(T)) return tracks.get(T);
    const t = { days: [], cases: 0, short: 0, shortBy: 0, left: 0 };
    for (const k of pastDays(T, 42).reverse()) {
      const k1 = addDays(k, 1);
      if (k1 >= T || !usableDay(k1)) continue;
      const d0 = doughDay(k), d1 = doughDay(k1);
      if (!d0 || !d1 || !model(k) || !(model(k).L?.n >= 14)) continue;
      t.days.push(k);
      for (const [s] of DOUGH_SIZES) {
        const cases = [
          [buffered(expect(k, s, MIX_TIME, AM_COVER), s), usedBetween(d0, MIX_TIME, AM_COVER)[s]],
          [bufferedPm(expect(k, s, PM_DECIDE, DAY_END + COVER_UNTIL), s), usedBetween(d0, PM_DECIDE, DAY_END)[s] + usedBetween(d1, 0, COVER_UNTIL)[s]],
        ];
        for (const [made, need] of cases) {
          t.cases += 1;
          if (need - made > 0.5) { t.short += 1; t.shortBy += need - made; }
        }
        t.left += Math.max(0, cases[1][0] - cases[1][1]);
      }
    }
    tracks.set(T, t);
    return t;
  }

  return { clover, doughDay, usedBetween, model, expect, factor, plan, afternoon, stockAt, leftAt, usedToday, extras, today, usedSoFar, track };
}
