// Schedule tab (version 1.22.0, phone page, owner only): the rules, with no page or database in them, so
// phone/tools/test-schedule.mjs can check them. Dates are 'YYYY-MM-DD' day keys in the store's time zone.
//
// A cell (one employee, one day) is one of:
//   no row                      not scheduled (blank)
//   { kind: 'off' }             OFF
//   { kind: 'shift', start_at, end_at }   start_at = 'open' or 'HH:MM', end_at = 'close' or 'HH:MM' (24-hour)
//   { kind: 'none', note }      not scheduled, but with a note (e.g. "check: unclear mark on the sheet")
// Any of them can carry a note; a note starting with "check" shows a small marker on the page.

export const DAY_NAMES = ['Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon']; // a week runs Tuesday to Monday
export const DAY_LONG = ['Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'Monday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// The first pay period (owner, 2026-11-12): Tue Nov 3 – Mon Nov 16, 2026, then every 14 days. The database's
// schedule_settings.period_start replaces this once supabase_schedule.sql has run.
export const DEFAULT_PERIOD_START = '2026-11-03';

const pad = (n) => String(n).padStart(2, '0');
const utc = (k) => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const keyOf = (t) => { const d = new Date(t); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
export const addDays = (k, n) => keyOf(utc(k) + n * 86400000);
export const daysFrom = (a, b) => Math.round((utc(b) - utc(a)) / 86400000); // b - a, in days
export const jsWeekday = (k) => new Date(utc(k)).getUTCDay(); // 0 = Sunday
export const isTuesday = (k) => /^\d{4}-\d{2}-\d{2}$/.test(k || '') && jsWeekday(k) === 2;

// The 14-day pay period that holds day k, given any period's first Tuesday.
export function periodStartOf(k, anchor = DEFAULT_PERIOD_START) {
  const d = daysFrom(anchor, k);
  return addDays(anchor, Math.floor(d / 14) * 14);
}
export const periodDays = (start) => Array.from({ length: 14 }, (_, i) => addDays(start, i));

export function shortDate(k) { const [, m, d] = k.split('-').map(Number); return `${MONTHS[m - 1]} ${d}`; }
export function dayLabel(k) { return `${DAY_NAMES[(jsWeekday(k) + 5) % 7]} ${shortDate(k)}`; }
export function rangeLabel(a, b) {
  const [, ma] = a.split('-').map(Number); const [, mb, db] = b.split('-').map(Number);
  return ma === mb ? `${shortDate(a)} – ${db}` : `${shortDate(a)} – ${MONTHS[mb - 1]} ${db}`;
}

// ---------- times ----------
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const validStart = (s) => s === 'open' || TIME.test(s || '');
export const validEnd = (s) => s === 'close' || TIME.test(s || '');
export const toMinutes = (s) => { const m = TIME.exec(s || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
export const fromMinutes = (n) => `${pad(Math.floor(n / 60))}:${pad(n % 60)}`;
// 960 -> "4 pm", 630 -> "10:30 am", 720 -> "12 pm"
export function clock(min) {
  const h = Math.floor(min / 60) % 24; const mi = min % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${mi ? `:${pad(mi)}` : ''} ${h < 12 ? 'am' : 'pm'}`;
}
export const startWord = (s) => (s === 'open' ? 'Open' : clock(toMinutes(s)));
export const endWord = (e) => (e === 'close' ? 'Close' : clock(toMinutes(e)));
export const shiftText = (s, e) => `${startWord(s)} – ${endWord(e)}`;

// The words a cell shows, e.g. { text: '4 pm – Close', a: '4 pm', b: 'Close' } or { text: 'OFF' }.
export function cellWords(row) {
  if (!row || row.kind === 'none') return { text: '', a: '', b: '' };
  if (row.kind === 'off') return { text: 'OFF', a: 'OFF', b: '' };
  return { text: shiftText(row.start_at, row.end_at), a: startWord(row.start_at), b: endWord(row.end_at) };
}
export const needsCheck = (row) => /^\s*check\b/i.test(row?.note || '');

// Store hours: opens[w] / closes[w] in minutes after midnight, w = JS weekday (0 = Sunday), the same lists the
// Dough tab and the closing reminder use (dough-plan.js: OPENS / CLOSES).
export function shiftMinutes(row, k, hours) {
  if (!row || row.kind !== 'shift') return 0;
  const w = jsWeekday(k);
  const a = row.start_at === 'open' ? hours?.opens?.[w] : toMinutes(row.start_at);
  const b = row.end_at === 'close' ? hours?.closes?.[w] : toMinutes(row.end_at);
  if (a == null || b == null || b <= a) return null; // can't tell (no store hours, or ends before it starts)
  return b - a;
}
// Minutes for a list of [row, day] pairs; null if any shift can't be worked out.
export function sumMinutes(pairs, hours) {
  let t = 0;
  for (const [row, k] of pairs) {
    const m = shiftMinutes(row, k, hours);
    if (m == null) return null;
    t += m;
  }
  return t;
}
export function hoursText(min) {
  if (min == null) return '—';
  const h = Math.round((min / 60) * 100) / 100;
  return `${Number.isInteger(h) ? h : h.toFixed(2).replace(/0$/, '')} h`;
}
// "4 pm – Close (10 pm)" for the Today card
export function shiftWithTimes(row, k, hours) {
  if (row?.kind !== 'shift') return cellWords(row).text;
  const w = jsWeekday(k);
  const s = row.start_at === 'open' && hours?.opens ? `Open (${clock(hours.opens[w])})` : startWord(row.start_at);
  const e = row.end_at === 'close' && hours?.closes ? `Close (${clock(hours.closes[w])})` : endWord(row.end_at);
  return `${s} – ${e}`;
}

// ---------- quick shift buttons ----------
export const BUILT_IN_PRESETS = [
  { id: 'off', kind: 'off' },
  { id: 'open-close', kind: 'shift', start_at: 'open', end_at: 'close' },
  { id: '10-close', kind: 'shift', start_at: '10:00', end_at: 'close' },
  { id: '4-close', kind: 'shift', start_at: '16:00', end_at: 'close' },
  { id: '10-4', kind: 'shift', start_at: '10:00', end_at: '16:00' },
  { id: '11-4', kind: 'shift', start_at: '11:00', end_at: '16:00' },
];
export const presetText = (p) => (p.kind === 'off' ? 'OFF' : shiftText(p.start_at, p.end_at));
export const sameShift = (a, b) => !!a && !!b && a.kind === b.kind && (a.kind !== 'shift' || (a.start_at === b.start_at && a.end_at === b.end_at));

// ---------- usual weeks ----------
// A usual week is 7 entries, Tuesday first: null (not scheduled), { k: 'off' } or { k: 'shift', s, e }.
export function rowToUsual(row) {
  if (!row || row.kind === 'none') return null;
  if (row.kind === 'off') return { k: 'off' };
  return { k: 'shift', s: row.start_at, e: row.end_at };
}
export function usualToRow(u) {
  if (!u) return null;
  if (u.k === 'off') return { kind: 'off', start_at: null, end_at: null, note: '' };
  if (u.k === 'shift' && validStart(u.s) && validEnd(u.e)) return { kind: 'shift', start_at: u.s, end_at: u.e, note: '' };
  return null;
}
export const validUsual = (u) => Array.isArray(u) && u.length === 7;
export function usualSummary(u) {
  if (!validUsual(u)) return '';
  return u.map((x, i) => `${DAY_NAMES[i]} ${x ? (x.k === 'off' ? 'OFF' : shiftText(x.s, x.e)) : '—'}`).join(' · ');
}

// What "Fill from usual weeks" would set: only days that are empty now. cells: Map 'emp|day' -> row.
export function fillFromUsual(employees, days, cells) {
  const out = [];
  for (const e of employees) {
    if (!validUsual(e.usual_week)) continue;
    days.forEach((k, i) => {
      if (cells.has(`${e.id}|${k}`)) return;
      const row = usualToRow(e.usual_week[i % 7]);
      if (row) out.push({ employee_id: e.id, work_date: k, row });
    });
  }
  return out;
}
// What "Copy last period" would set: last period's shifts and OFFs moved 14 days on, only into empty days.
// Notes aren't copied ("check" notes belong to the old sheet).
export function copyPeriod(employees, prevRows, cells) {
  const ids = new Set(employees.map((e) => e.id));
  const out = [];
  for (const r of prevRows) {
    if (!ids.has(r.employee_id) || r.kind === 'none') continue;
    const k = addDays(r.work_date, 14);
    if (cells.has(`${r.employee_id}|${k}`)) continue;
    out.push({ employee_id: r.employee_id, work_date: k, row: { kind: r.kind, start_at: r.start_at ?? null, end_at: r.end_at ?? null, note: '' } });
  }
  return out;
}

// The custom-shift picker: an hour (6 am to 11 pm) and the minutes, in 15-minute steps.
export const PICK_HOURS = Array.from({ length: 18 }, (_, i) => 6 + i);
export const PICK_MINUTES = [0, 15, 30, 45];
export const hourWord = (h) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'am' : 'pm'}`;

// Store hours in words, from the opens/closes lists: "Tue–Fri 10 am – 10 pm (Fri 11 pm) ..." kept simple: one line per day.
export function storeHoursLines(hours) {
  return DAY_NAMES.map((d, i) => {
    const w = (i + 2) % 7;
    return `${d} ${clock(hours.opens[w])} – ${clock(hours.closes[w])}`;
  });
}

// ---------- typing a shift (the owner's own shorthand, like on the paper sheets) ----------
// "4-cl", "4cl", "10-cl", "open-cl", "open/cl", "o-c", "10-4", "11-4", "3-8", "12-8", "3:30-8", "off",
// and the page's own words ("4 pm – Close", "OFF"), so copying out and pasting back works.
// Hours without am/pm are read the restaurant way: 10 and 11 are morning, 12 is noon, 1 to 9 are afternoon/
// evening. 13-23 are 24-hour. An end that would come before the start (e.g. "11-11") is read as pm.
// Returns { row } (row null = clear the day) or { error } for something it can't read; it never guesses.
const TOK = '(open|opn|op|o|close|clo|cl|c|\\d{1,2}(?::\\d{2})?\\s*(?:am|pm|a|p)?)';
const SHORT = new RegExp(`^${TOK}\\s*(?:-|–|—|/|to|\\s)?\\s*${TOK}$`);
function readTime(tok, { end = false, after = null } = {}) {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/.exec(tok);
  if (!m) return null;
  let h = Number(m[1]); const mi = Number(m[2] || 0); const ap = m[3]?.[0];
  if (mi > 59 || h > 23) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ap === 'p' ? 12 : 0);
  } else if (h >= 1 && h <= 9) h += 12;
  else if (h === 0) return null;
  let t = h * 60 + mi;
  if (end && !ap && after != null && t <= after && t + 720 < 24 * 60) t += 720;
  return t;
}
export function parseShift(input) {
  const s = String(input ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s || s === '-' || s === '—' || s === '–') return { row: null };
  if (/^(off|x|day off)$/.test(s)) return { row: { kind: 'off', start_at: null, end_at: null } };
  const m = SHORT.exec(s);
  if (!m) return { error: `Can't read "${String(input).trim()}"` };
  const [, a, b] = m;
  if (/^\d/.test(a) && /^\d/.test(b) && !/[-–—/]|to|\s/.test(s.slice(a.length, s.length - b.length))) {
    return { error: `Put a dash between the times, like 10-4` };
  }
  const isOpen = /^(open|opn|op|o)$/.test(a);
  const isClose = /^(close|clo|cl|c)$/.test(b);
  if (!isOpen && /^(close|clo|cl|c)$/.test(a)) return { error: 'The start comes first, like 4-cl' };
  if (!isClose && /^(open|opn|op|o)$/.test(b)) return { error: 'The end comes second, like open-6' };
  const start = isOpen ? null : readTime(a);
  if (!isOpen && start == null) return { error: `Can't read the start "${a}"` };
  const end = isClose ? null : readTime(b, { end: true, after: start });
  if (!isClose && end == null) return { error: `Can't read the end "${b}"` };
  if (start != null && end != null && end <= start) return { error: 'The end is before the start' };
  return { row: { kind: 'shift', start_at: isOpen ? 'open' : fromMinutes(start), end_at: isClose ? 'close' : fromMinutes(end) } };
}
