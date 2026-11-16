// Finances tab (version 1.12.0): reading a bank or card statement saved as CSV, and vendor rules.
// No page code in here, so it can be checked on its own (node).

// ---------- CSV text -> rows ----------
// Quoted fields, "" inside quotes, \r\n or \n, and a comma, semicolon or tab between fields.
export function parseCSV(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const firstLine = src.slice(0, src.indexOf('\n') > -1 ? src.indexOf('\n') : src.length);
  const count = (ch) => firstLine.split(ch).length;
  const sep = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field.trim() === '') { field = ''; quoted = true; }
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row.map((f) => f.trim()));
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row.map((f) => f.trim()));
  return rows;
}

// ---------- which column is which ----------
const H = {
  date: /^(transaction |trans\.? |posting |posted |post )?date$|^date posted$|^posted$|^date$/i,
  dateLoose: /date/i,
  // in this order: Chase checking has both "Details" (just DEBIT / CREDIT) and "Description"
  desc: /^(transaction )?description$/i,
  descPayee: /^(payee|merchant|merchant name|name)$/i,
  descLoose: /description|payee|merchant/i,
  descLast: /^(details|transaction)$/i,
  memo: /^(memo|notes?|extended details|reference)$/i,
  amount: /^(amount|transaction amount|amount \(usd\)|net amount)$/i,
  amountLoose: /amount/i,
  debit: /debit|withdrawal|money out|charges?$|paid out/i,
  credit: /credit|deposit|money in|payments?$|paid in/i,
};
const pick = (header, ...res) => {
  for (const re of res) {
    const i = header.findIndex((h) => re.test(h));
    if (i > -1) return i;
  }
  return -1;
};

// { date, desc, memo, amount, debit, credit } column numbers (-1 = none), ok when there's enough to import.
export function detectColumns(header) {
  const h = header.map((x) => String(x || '').trim());
  const map = { date: pick(h, H.date, H.dateLoose), desc: pick(h, H.desc, H.descPayee, H.descLoose, H.descLast), memo: pick(h, H.memo), amount: -1, debit: -1, credit: -1 };
  map.amount = pick(h, H.amount, H.amountLoose);
  if (map.amount === -1) {
    map.debit = pick(h, H.debit);
    map.credit = pick(h, H.credit);
  }
  if (map.memo === map.desc) map.memo = -1;
  if (map.desc === -1 && map.memo > -1) { map.desc = map.memo; map.memo = -1; }
  return { ...map, ok: columnsOk(map) };
}
export const columnsOk = (m) => m.date > -1 && m.desc > -1 && (m.amount > -1 || m.debit > -1 || m.credit > -1);

// Some banks put a few summary lines above the real header: the header is the first row (of the first
// 20) that has a date column and an amount (or debit / credit) column.
export function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const d = detectColumns(rows[i]);
    if (d.ok && rows[i].length >= 3) return i;
  }
  return 0;
}

// ---------- values ----------
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
const okDate = (y, m, d) => {
  if (y < 100) y += 2000;
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2100)) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 ? `${y}-${pad(m)}-${pad(d)}` : null;
};
// "10/03/2026", "10/3/26", "2026-10-03", "Oct 3, 2026", "03-Oct-2026" -> "2026-10-03" (US order: month first).
export function parseDate(s) {
  const t = String(s || '').trim();
  let m;
  if ((m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) return okDate(+m[1], +m[2], +m[3]);
  if ((m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/))) return okDate(+m[3], +m[1], +m[2]);
  if ((m = t.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})/))) return okDate(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  if ((m = t.match(/^(\d{1,2})[- ]([A-Za-z]{3})[a-z]*[- ](\d{2,4})/))) return okDate(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  return null;
}

// "$1,234.56", "-1234.56", "(45.00)", "45.00 CR", "−$5" -> cents (null when it isn't a number).
export function parseMoney(s) {
  let t = String(s ?? '').trim().replace(/−/g, '-');
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (/\bCR$/i.test(t)) { neg = !neg; t = t.replace(/\s*CR$/i, ''); }
  t = t.replace(/\s*DR$/i, '');
  if (t.includes('-')) { neg = !neg; t = t.replace(/-/g, ''); }
  t = t.replace(/[$,\s]/g, '');
  if (!/^\d*\.?\d+$/.test(t)) return null;
  const c = Math.round(parseFloat(t) * 100);
  return neg ? -c : c;
}

export const normDesc = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// ---------- a vendor name from a bank description ----------
// "POS DEBIT SQ *SYSCO SEATTLE 10/03 #1234 WA" -> "Sysco Seattle"
const NOISE = /^(pos|debit|credit|card|purchase|recurring|payment|ach|withdrawal|online|pmt|checkcard|visa|dbt|preauthorized|electronic|web|ppd|ccd|id|to|from|transfer|bill|pay|debit card purchase)$/i;
export function guessVendor(desc) {
  let s = normDesc(desc)
    .replace(/^(sq|tst|sp|pp|paypal|py|in|dd|ach|pos|chk|ckcd|bkofamerica)\s?\*\s?/i, '')
    .replace(/\b(sq|tst|sp|paypal)\s?\*\s?/gi, '')
    .replace(/https?:\/\/\S+|www\.\S+/gi, '')
    .replace(/[#*]\s?\w*\d\w*/g, ' ')
    .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' ')
    .replace(/\b(x{2,}|\*{2,})\d+\b/gi, ' ')
    .replace(/\b\d{3,}\b/g, ' ')
    .replace(/\b(WA|OR|CA|ID|TX|NY|USA|US)\b\s*$/g, ' ');
  const words = s.split(/\s+/).filter((w) => w && !NOISE.test(w) && /[a-z]/i.test(w));
  const name = words.slice(0, 3).join(' ').replace(/[^\w&'.\- ]/g, '').trim();
  if (!name) return normDesc(desc).slice(0, 40);
  return name.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\b(Llc|Inc|Co)\b/g, (w) => w.toUpperCase());
}

// ---------- rules ----------
// A rule matches when its text is inside the description or the vendor (any upper/lower case). When
// several match, the longest text wins (the most specific).
export function ruleMatches(rule, t) {
  const m = String(rule.matchText || '').trim().toLowerCase();
  if (m.length < 2) return false;
  return `${t.description || ''} ${t.vendor || ''}`.toLowerCase().includes(m);
}
export function ruleFor(rules, t) {
  let best = null;
  for (const r of rules) if (ruleMatches(r, t) && (!best || r.matchText.length > best.matchText.length)) best = r;
  return best;
}

// ---------- duplicates ----------
// The import key, as the brief has it: sha256("date|description|amount"), amount with 2 decimals and
// money out positive. The same statement imported twice gives the same keys.
export const hashText = (date, description, cents) => `${date}|${normDesc(description)}|${(cents / 100).toFixed(2)}`;
export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Money coming in that's most likely a sales deposit (the apps and Clover pay into the bank). Sales are
// counted from the dashboard, so these start unticked; a refund from a supplier starts ticked.
export const SALES_DEPOSIT = /doordash|uber\s?eats|uber\b|grubhub|clover|first data|fiserv|owner\.com|owner inc|stripe|square inc|merchant (dep|settle)|deposit|transfer from|payout|zelle from|mobile deposit|interest paid/i;

// ---------- rows of a statement -> what would be imported ----------
// map: from detectColumns (or the owner's own choice); outSign: 'negative' when money out shows as a
// negative number (most bank accounts), 'positive' when it shows positive (many credit cards).
// Each item: { line, date, description, memo, amount (cents, + = out), error }
export function statementItems(rows, headerIdx, map, outSign) {
  const items = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const get = (k) => (map[k] > -1 ? r[map[k]] ?? '' : '');
    const date = parseDate(get('date'));
    const description = normDesc(get('desc'));
    const memo = map.memo > -1 ? normDesc(get('memo')) : '';
    let amount = null;
    if (map.amount > -1) {
      const v = parseMoney(get('amount'));
      if (v != null) amount = outSign === 'negative' ? -v : v;
    } else {
      const d = parseMoney(get('debit')), c = parseMoney(get('credit'));
      if (d != null || c != null) amount = Math.abs(d || 0) - Math.abs(c || 0);
    }
    let error = '';
    if (!date) error = 'no date';
    else if (amount == null) error = 'no amount';
    else if (!description) error = 'no description';
    // a footer line ("Total", "Ending balance") isn't a transaction
    if (!date && amount == null) continue;
    items.push({ line: i + 1, date, description, memo, amount: amount ?? 0, error });
  }
  return items;
}

// Most lines on a business statement are money going out, so the more common sign is money out.
export function guessOutSign(rows, headerIdx, map) {
  if (map.amount === -1) return 'negative';
  let neg = 0, pos = 0;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const v = parseMoney(rows[i][map.amount]);
    if (v == null || v === 0) continue;
    if (v < 0) neg++; else pos++;
  }
  return pos > neg ? 'positive' : 'negative';
}
