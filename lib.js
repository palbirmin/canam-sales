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
// Weeks start on Monday.
export const weekStartOf = (k) => addDays(k, -((weekdayOf(k) + 6) % 7));
export const minuteOfDay = (ts) => { const z = zoned(ts); return z.h * 60 + z.mi; };

export function daysBetween(a, b) {
  const pa = parseKey(a), pb = parseKey(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86400000);
}

// "$1,234.56" / "1234.56" -> cents
export const toCents = (s) => {
  const n = parseFloat(String(s ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
