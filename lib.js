// Date helpers that work in the store's time zone, no matter where the computer is.
import { CONFIG } from './config.js';

const TZ = CONFIG.timeZone;
const pad = (n) => String(n).padStart(2, '0');

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

export function zoned(ts) {
  const p = {};
  for (const x of partsFmt.formatToParts(new Date(ts))) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

function tzOffsetMin(ts) {
  const z = zoned(ts);
  const sec = Math.floor(ts / 1000) * 1000;
  return Math.round((Date.UTC(z.y, z.m - 1, z.d, z.h, z.mi, z.s) - sec) / 60000);
}

// Store-local wall time -> epoch ms.
export function localToEpoch(y, m, d, h = 0, mi = 0) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - tzOffsetMin(guess) * 60000;
  return guess - tzOffsetMin(first) * 60000;
}

export const dayKeyOf = (ts) => { const z = zoned(ts); return `${z.y}-${pad(z.m)}-${pad(z.d)}`; };
export const todayKey = () => dayKeyOf(Date.now());
export const parseKey = (k) => { const [y, m, d] = k.split('-').map(Number); return { y, m, d }; };

export function addDays(k, n) {
  const { y, m, d } = parseKey(k);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function dayBounds(k) {
  const { y, m, d } = parseKey(k);
  const n = parseKey(addDays(k, 1));
  return [localToEpoch(y, m, d), localToEpoch(n.y, n.m, n.d)];
}

// 0 = Sunday
export const weekdayOf = (k) => { const { y, m, d } = parseKey(k); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
// The store's business weeks run Tuesday to Monday (the owner, 2026-10-31; Monday to Sunday before 1.14.2):
// "This week", "Last week" and their comparisons all start on a Tuesday.
export const weekStartOf = (k) => addDays(k, -((weekdayOf(k) + 5) % 7));
// Weekdays in business-week order, Tuesday first (0 = Sunday).
export const WEEK_ORDER = [2, 3, 4, 5, 6, 0, 1];
// A calendar week's Monday, for DoorDash, whose own reports run Monday to Sunday.
export const mondayWeekStartOf = (k) => addDays(k, -((weekdayOf(k) + 6) % 7));
export const minuteOfDay = (ts) => { const z = zoned(ts); return z.h * 60 + z.mi; };

// Minute of the day -> "11:00 AM", worked out from the minutes themselves. (Adding minutes to
// midnight is an hour off on the days the clocks change, like Nov 1, 2026 and Mar 14, 2027.)
export const minuteClock = (m) => {
  const t = ((Math.round(m) % 1440) + 1440) % 1440;
  const h = Math.floor(t / 60);
  return `${h % 12 || 12}:${pad(t % 60)} ${h < 12 ? 'AM' : 'PM'}`;
};

export function daysBetween(a, b) {
  const pa = parseKey(a), pb = parseKey(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86400000);
}

// "$1,234.56" / "1234.56" -> cents. "-$5.00", "−$5.00" (a minus sign) and "($5.00)" are negative.
export const toCents = (s) => {
  const str = String(s ?? '').replace(/\u2212/g, '-');
  const n = parseFloat(str.replace(/[^0-9.-]/g, ''));
  if (!Number.isFinite(n)) return 0;
  const inBrackets = /^\s*\(.*\)\s*$/.test(str);
  return Math.round((inBrackets ? -Math.abs(n) : n) * 100);
};

// In-store sales up to the morning of Sep 25, 2026 were rung up on Clover's old account (see
// CLOVER_OLD in sources.js). Those days are read from it until they come through, but not after
// October 2026.
export const CLOVER_OLD_DAYS = { from: '2026-09-01', to: '2026-09-25', retryUntil: '2026-11-01' };
export const usesOldClover = (dayKey) => dayKey >= CLOVER_OLD_DAYS.from && dayKey <= CLOVER_OLD_DAYS.to;
// The days whose in-store sales are still waiting for that account.
export const oldCloverMissing = (all) => Object.keys(all)
  .filter((k) => /^d:\d{4}-\d{2}-\d{2}:instore$/.test(k) && usesOldClover(k.slice(2, 12)) && all[k]?.old === 'missing')
  .map((k) => k.slice(2, 12)).sort();

// Card-processing fees for one day of in-store or website & app sales (version 1.13.0), in cents:
// { fee, est }. est = estimated with the rates in config.js (cardFees); Owner's own fee per order isn't
// an estimate. r = that day's record (the website & app record, or Clover's "External Payment" orders
// when Owner wasn't reachable). Days saved before 1.13.0 don't have what was charged on the cards, so
// it's worked out from the sales: in-store card sales plus sales tax and tips, and the website's sales
// plus tax and the guest's 5% Owner fee (no tips: those weren't saved).
export function cardFeeOfDay(ch, r, rates) {
  const none = { fee: 0, est: false };
  if (!r || !rates) return none;
  const x = r.extra || {};
  const at = (R, charged, count) => Math.max(0, Math.round((charged * R.pct) / 100 + count * R.cents));
  const tax = 1 + (rates.salesTax || 0);
  if (ch === 'instore') {
    const R = rates.clover;
    if (x.cardCharged != null) return { fee: at(R, x.cardCharged, x.cardCount || 0), est: true };
    const card = x.card || 0;
    if (card <= 0) return none;
    const share = card / (card + Math.max(0, x.cash || 0));
    return { fee: at(R, card * tax + (x.tips || 0), Math.round((r.orders || 0) * share)), est: true };
  }
  if (ch === 'owner') {
    const R = rates.owner;
    if (x.cardFee != null) return { fee: Math.round(x.cardFee), est: false }; // Owner's own fee per order
    if (x.charged != null) return { fee: at(R, x.charged, x.cardOrders ?? r.orders ?? 0), est: true };
    if (x.cardCharged != null) return { fee: at(R, x.cardCharged, x.cardCount || 0), est: true }; // from Clover
    if (!((r.sales || 0) > 0)) return none;
    return { fee: at(R, r.sales * tax * (1 + (rates.ownerGuestFee || 0)), r.orders || 0), est: true };
  }
  return none;
}

// What was in an order scheduled ahead, for the kitchen: [{ name, qty, mods? }]. Only item and
// choice names and how many; anything that looks like a price is taken out. undefined = not known.
export function kitchenItems(items) {
  if (!Array.isArray(items)) return undefined;
  const text = (s, max) => String(s ?? '')
    .replace(/[-+]?\$\s?\d[\d,]*(\.\d{1,2})?|\b\d+\.\d{2}\b/g, '')
    .replace(/[()]\s*[()]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
  const out = [];
  for (const it of items.slice(0, 40)) {
    const name = text(it?.name, 80);
    if (!name) continue;
    const x = { name, qty: Math.max(1, Math.min(99, Math.round(Number(it.qty) || 1))) };
    const mods = (Array.isArray(it.mods) ? it.mods : []).map((m) => text(m, 60)).filter(Boolean).slice(0, 12);
    if (mods.length) x.mods = mods;
    out.push(x);
  }
  return out.length ? out : undefined;
}
