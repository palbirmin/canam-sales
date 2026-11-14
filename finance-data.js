// Finances tab (version 1.12.0): where the expenses come from and go to.
// Two backends with the same shape:
//  - Supabase: the six tables in phone/supabase_finance.sql, through the page's own sign-in (supa.js).
//  - Sample data: phone/fixtures/finance-demo.json, kept in memory only (nothing is saved). Used with
//    ?demo=1, and when the tables aren't there yet (supabase_finance.sql hasn't been run).
// Money is kept in cents inside the page (like the Sales tab); the database keeps dollars (numeric).
import { ruleFor, ruleMatches, sha256Hex, hashText } from './finance-csv.js';

const pad = (n) => String(n).padStart(2, '0');
const keyOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const parse = (k) => { const [y, m, d] = k.split('-').map(Number); return { y, m, d }; };
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export function addMonths(k, n, dom) {
  const { y, m, d } = parse(k);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const ty = t.getUTCFullYear(), tm = t.getUTCMonth() + 1;
  return keyOf(ty, tm, Math.min(dom || d, lastDay(ty, tm)));
}
export function addDaysKey(k, n) {
  const { y, m, d } = parse(k);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return keyOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
// The next due date after a bill is paid.
export function rollForward(bill) {
  const f = bill.frequency;
  if (f === 'weekly') return addDaysKey(bill.nextDue, 7);
  if (f === 'biweekly') return addDaysKey(bill.nextDue, 14);
  const n = f === 'quarterly' ? 3 : f === 'yearly' ? 12 : 1;
  return addMonths(bill.nextDue, n, bill.dayOfMonth || undefined);
}

const cents = (v) => (v == null || v === '' ? null : Math.round(Number(v) * 100));
const dollars = (c) => (c == null ? null : Math.round(c) / 100);
const uuid = () => crypto.randomUUID();

// database row <-> page object
const fromCat = (r) => ({ id: r.id, name: r.name, kind: r.kind, sort: r.sort ?? 0, budget: cents(r.monthly_budget) });
const fromTxn = (r) => ({
  id: r.id, date: r.txn_date, description: r.description || '', vendor: r.vendor || '', amount: cents(r.amount) || 0,
  categoryId: r.category_id || null, accountId: r.account_id || null, source: r.source || 'manual', importHash: r.import_hash || null,
  externalId: r.external_id || null, note: r.note || '', isRecurring: !!r.is_recurring, createdAt: r.created_at || null,
});
const toTxn = (t) => ({
  id: t.id, txn_date: t.date, description: t.description || '', vendor: t.vendor || '', amount: dollars(t.amount),
  category_id: t.categoryId || null, account_id: t.accountId || null, source: t.source || 'manual', import_hash: t.importHash || null,
  note: t.note || '', is_recurring: !!t.isRecurring,
});
const TXN_COLS = { date: 'txn_date', description: 'description', vendor: 'vendor', amount: 'amount', categoryId: 'category_id', accountId: 'account_id', note: 'note', isRecurring: 'is_recurring', source: 'source' };
const txnPatch = (p) => Object.fromEntries(Object.entries(p).filter(([k]) => TXN_COLS[k]).map(([k, v]) => [TXN_COLS[k], k === 'amount' ? dollars(v) : v ?? null]));
const fromAcct = (r) => ({ id: r.id, name: r.name, kind: r.kind || 'checking', institution: r.institution || '', externalId: r.external_id || null, lastSyncedAt: r.last_synced_at || null, active: r.active !== false });
const toAcct = (a) => ({ id: a.id, name: a.name, kind: a.kind, institution: a.institution || '', active: a.active !== false });
// sales_months: dollars in the database, cents here; ch = per channel like the Sales tab
const SM_CH = ['instore', 'doordash', 'uber', 'owner', 'owner_clover', 'other', 'grubhub'];
const SM_X = ['total', 'instore_card', 'instore_cash', 'doordash_fees', 'uber_fees', 'grubhub_fees'];
const fromMonth = (r) => ({ month: r.month, ...Object.fromEntries([...SM_CH, ...SM_X].map((k) => [k, cents(r[k]) || 0])), daysCounted: r.days_counted || 0, complete: !!r.complete });
const toMonth = (m) => ({ month: m.month, ...Object.fromEntries([...SM_CH, ...SM_X].map((k) => [k, dollars(m[k] || 0)])), days_counted: m.daysCounted, complete: !!m.complete });
const fromRule = (r) => ({ id: r.id, matchText: r.match_text, vendor: r.vendor || '', categoryId: r.category_id, createdAt: r.created_at || null });
const toRule = (r) => ({ id: r.id, match_text: r.matchText, vendor: r.vendor || '', category_id: r.categoryId });
const fromBill = (r) => ({
  id: r.id, name: r.name, vendor: r.vendor || '', categoryId: r.category_id || null, amount: cents(r.amount) || 0,
  frequency: r.frequency || 'monthly', dayOfMonth: r.day_of_month ?? null, nextDue: r.next_due, autoPay: !!r.auto_pay, active: r.active !== false,
});
const toBill = (b) => ({
  id: b.id, name: b.name, vendor: b.vendor || '', category_id: b.categoryId || null, amount: dollars(b.amount),
  frequency: b.frequency, day_of_month: b.dayOfMonth || null, next_due: b.nextDue, auto_pay: !!b.autoPay, active: b.active !== false,
});

export class MissingTables extends Error {}
const isMissing = (e) => /could not find the table|does not exist|schema cache|PGRST205|42P01/i.test(String(e?.message || e));

// ---------- Supabase backend ----------
function supabaseBackend(supa) {
  const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
  async function all(path) {
    const out = [];
    for (let offset = 0; ; offset += 1000) {
      const rows = await supa.rest('GET', `${path}&limit=1000&offset=${offset}`);
      out.push(...rows);
      if (rows.length < 1000) return out;
    }
  }
  return {
    async load(since) {
      let cats;
      try {
        cats = await supa.rest('GET', 'expense_categories?select=*&order=sort.asc,name.asc');
      } catch (e) {
        if (isMissing(e)) throw new MissingTables(e.message);
        throw e;
      }
      const [txns, rules, bills, accts, months] = await Promise.all([
        all(`expense_transactions?select=*&txn_date=gte.${since}&order=txn_date.desc,created_at.desc`),
        supa.rest('GET', 'vendor_rules?select=*&order=created_at.asc'),
        supa.rest('GET', 'recurring_bills?select=*&order=next_due.asc'),
        supa.rest('GET', 'expense_accounts?select=*&order=created_at.asc'),
        supa.rest('GET', 'sales_months?select=*&order=month.asc').catch(() => []), // added in 1.12.1
      ]);
      return { cats: cats.map(fromCat), txns: txns.map(fromTxn), rules: rules.map(fromRule), bills: bills.map(fromBill), accts: accts.map(fromAcct), months: months.map(fromMonth) };
    },
    async insert(table, rows, { ignoreDuplicates = false, conflict = '' } = {}) {
      for (const part of chunk(rows, 200)) {
        await supa.rest('POST', `${table}${conflict ? `?on_conflict=${conflict}` : ''}`, part,
          ignoreDuplicates ? 'resolution=ignore-duplicates,return=minimal' : conflict ? 'resolution=merge-duplicates,return=minimal' : 'return=minimal');
      }
    },
    async update(table, ids, patch) {
      for (const part of chunk(ids, 100)) await supa.rest('PATCH', `${table}?id=in.(${part.join(',')})`, patch, 'return=minimal');
    },
    async remove(table, ids) {
      for (const part of chunk(ids, 100)) await supa.rest('DELETE', `${table}?id=in.(${part.join(',')})`);
    },
    // import keys already in the database (also older than what the page loaded)
    async existingHashes(hashes) {
      const found = new Set();
      for (const part of chunk(hashes, 80)) {
        const rows = await supa.rest('GET', `expense_transactions?select=import_hash&import_hash=in.(${part.join(',')})`);
        for (const r of rows) found.add(r.import_hash);
      }
      return found;
    },
  };
}

// ---------- sample-data backend ----------
// The sample file is written for one month ("asOf"); its dates move forward by whole months so the
// newest month is always this month, and nothing after today shows.
// withSales: also the sample monthly sales (only in the no-sign-in demo, never next to real sales).
async function fixtureBackend(url, today, withSales) {
  const j = await (await fetch(url, { cache: 'no-store' })).json();
  const a = parse(j.asOf), t = parse(today);
  const shift = (t.y - a.y) * 12 + (t.m - a.m);
  const move = (k) => (k && shift ? addMonths(k, shift) : k);
  const txns = j.transactions.map((r) => fromTxn({ ...r, txn_date: move(r.txn_date) })).filter((x) => x.date <= today);
  return {
    async load() {
      return {
        cats: j.categories.map(fromCat),
        txns,
        rules: j.rules.map(fromRule),
        bills: j.bills.map((b) => fromBill({ ...b, next_due: move(b.next_due) })),
        accts: (j.accounts || []).map(fromAcct),
        months: withSales ? (j.sales_months || []).map((r) => fromMonth({ ...r, month: move(r.month) })).filter((m) => m.month <= today) : [],
      };
    },
    insert: async () => {}, update: async () => {}, remove: async () => {},
    existingHashes: async () => new Set(),
  };
}

// ---------- the data the page works with ----------
// opts: { supa, demo (true = sample data, no database), fixtureUrl, today, since }
export async function openFinanceData({ supa, demo, fixtureUrl, today, since }) {
  let backend, mode = 'supabase', reason = '';
  let loaded;
  if (demo || !supa) {
    backend = await fixtureBackend(fixtureUrl, today, !supa);
    mode = 'fixture'; reason = 'demo';
    loaded = await backend.load(since);
  } else {
    try {
      backend = supabaseBackend(supa);
      loaded = await backend.load(since);
    } catch (e) {
      if (!(e instanceof MissingTables)) throw e;
      backend = await fixtureBackend(fixtureUrl, today, false);
      mode = 'fixture'; reason = 'missing';
      loaded = await backend.load(since);
    }
  }
  let { cats, txns, rules, bills, accts, months } = loaded;
  const listeners = [];
  const changed = () => listeners.forEach((cb) => cb());
  const sortTxns = () => txns.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : String(y.createdAt).localeCompare(String(x.createdAt))));
  sortTxns();

  const api = {
    mode, reason,
    get cats() { return cats; },
    get txns() { return txns; },
    get rules() { return rules; },
    get bills() { return bills; },
    get accounts() { return accts; },
    get salesMonths() { return months; },
    // Saves monthly sales totals (Supabase only; the sample data keeps its own). Never called with a row
    // that is less complete than the saved one (finance.js checks).
    async saveSalesMonths(rows) {
      if (!rows.length || mode !== 'supabase') return;
      await backend.insert('sales_months', rows.map(toMonth), { conflict: 'month' });
      const by = new Map(months.map((m) => [m.month, m]));
      for (const r of rows) by.set(r.month, r);
      months = [...by.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
    },
    account: (id) => accts.find((a) => a.id === id) || null,
    onChange: (cb) => listeners.push(cb),
    cat: (id) => cats.find((c) => c.id === id) || null,
    catByName: (name) => cats.find((c) => c.name.toLowerCase() === String(name).toLowerCase()) || null,

    async reload() {
      ({ cats, txns, rules, bills, accts, months } = await backend.load(since));
      sortTxns();
      changed();
    },

    async addTxn(t) {
      const row = { id: uuid(), source: 'manual', importHash: null, note: '', isRecurring: false, vendor: '', description: '', categoryId: null, ...t, createdAt: new Date().toISOString() };
      await backend.insert('expense_transactions', [toTxn(row)]);
      txns = [row, ...txns];
      sortTxns();
      changed();
      return row;
    },
    async updateTxns(ids, patch) {
      if (!ids.length) return;
      await backend.update('expense_transactions', ids, txnPatch(patch));
      const set = new Set(ids);
      txns = txns.map((t) => (set.has(t.id) ? { ...t, ...patch } : t));
      sortTxns();
      changed();
    },
    async deleteTxn(id) {
      await backend.remove('expense_transactions', [id]);
      txns = txns.filter((t) => t.id !== id);
      changed();
    },

    // How many loaded transactions a rule would match (and how many of those have no category yet).
    ruleCount(matchText) {
      const r = { matchText };
      let all = 0, open = 0;
      for (const t of txns) if (ruleMatches(r, t)) { all++; if (!t.categoryId) open++; }
      return { all, open };
    },
    // A new rule, then every matching uncategorized transaction is filed under it.
    async addRule({ matchText, vendor, categoryId }) {
      const rule = { id: uuid(), matchText: matchText.trim(), vendor: (vendor || '').trim(), categoryId, createdAt: new Date().toISOString() };
      await backend.insert('vendor_rules', [toRule(rule)]);
      rules = [...rules, rule];
      const ids = txns.filter((t) => !t.categoryId && ruleMatches(rule, t)).map((t) => t.id);
      if (ids.length) {
        const patch = { categoryId };
        if (rule.vendor) patch.vendor = rule.vendor;
        await backend.update('expense_transactions', ids, txnPatch(patch));
        const set = new Set(ids);
        txns = txns.map((t) => (set.has(t.id) ? { ...t, ...patch } : t));
      }
      changed();
      return { rule, refiled: ids.length };
    },
    async deleteRule(id) {
      await backend.remove('vendor_rules', [id]);
      rules = rules.filter((r) => r.id !== id);
      changed();
    },

    async setBudget(catId, budgetCents) {
      await backend.update('expense_categories', [catId], { monthly_budget: dollars(budgetCents) });
      cats = cats.map((c) => (c.id === catId ? { ...c, budget: budgetCents } : c));
      changed();
    },

    // Bank accounts and cards (bank sync later fills in externalId / lastSyncedAt; the page never does).
    async saveAccount(a) {
      const acct = { kind: 'checking', institution: '', active: true, externalId: null, lastSyncedAt: null, ...a, id: a.id || uuid() };
      await backend.insert('expense_accounts', [toAcct(acct)], { conflict: 'id' });
      accts = [...accts.filter((x) => x.id !== acct.id), acct];
      changed();
      return acct;
    },

    async saveBill(b) {
      const bill = { active: true, autoPay: false, vendor: '', dayOfMonth: null, ...b, id: b.id || uuid() };
      await backend.insert('recurring_bills', [toBill(bill)], { conflict: 'id' });
      bills = [...bills.filter((x) => x.id !== bill.id), bill].sort((x, y) => (x.nextDue < y.nextDue ? -1 : 1));
      changed();
      return bill;
    },
    async deleteBill(id) {
      await backend.remove('recurring_bills', [id]);
      bills = bills.filter((b) => b.id !== id);
      changed();
    },
    // "Mark paid": an expense for today with the bill's amount and category, then the next due date.
    async markPaid(id, date) {
      const b = bills.find((x) => x.id === id);
      if (!b) return null;
      const t = { id: uuid(), date, description: b.name, vendor: b.vendor || b.name, amount: b.amount, categoryId: b.categoryId, source: 'manual', importHash: null, note: `Recurring bill, due ${b.nextDue}`, isRecurring: true, createdAt: new Date().toISOString() };
      const next = rollForward(b);
      await backend.insert('expense_transactions', [toTxn(t)]);
      await backend.update('recurring_bills', [id], { next_due: next });
      txns = [t, ...txns];
      sortTxns();
      bills = bills.map((x) => (x.id === id ? { ...x, nextDue: next } : x)).sort((x, y) => (x.nextDue < y.nextDue ? -1 : 1));
      changed();
      return { txn: t, nextDue: next };
    },

    // ---------- statement import ----------
    // items from statementItems(); adds to each: hash, dup ('file' | 'saved' | ''), rule, vendor, categoryId
    async checkImport(items) {
      const seen = new Set();
      for (const it of items) {
        if (it.error) continue;
        it.hash = await sha256Hex(hashText(it.date, it.description, it.amount));
        it.dup = seen.has(it.hash) ? 'file' : '';
        seen.add(it.hash);
        const rule = ruleFor(rules, it);
        it.rule = rule;
        it.categoryId = rule?.categoryId || null;
        it.vendor = rule?.vendor || '';
      }
      const local = new Set(txns.map((t) => t.importHash).filter(Boolean));
      const remote = await backend.existingHashes(items.filter((i) => i.hash && !local.has(i.hash)).map((i) => i.hash));
      for (const it of items) if (it.hash && !it.dup && (local.has(it.hash) || remote.has(it.hash))) it.dup = 'saved';
      return items;
    },
    // Saves the ticked, new items. Returns { imported, skipped, filed }.
    async importItems(items, vendorOf, accountId = null) {
      const take = items.filter((i) => i.include && !i.error && !i.dup);
      const now = new Date().toISOString();
      const rows = take.map((i) => ({
        id: uuid(), date: i.date, description: i.description, vendor: i.vendor || vendorOf(i.description), amount: i.amount,
        categoryId: i.categoryId || null, accountId: accountId || null, source: 'csv', importHash: i.hash, externalId: null, note: i.memo || '', isRecurring: false, createdAt: now,
      }));
      if (rows.length) await backend.insert('expense_transactions', rows.map(toTxn), { ignoreDuplicates: true, conflict: 'import_hash' });
      txns = [...rows, ...txns];
      sortTxns();
      changed();
      return { imported: rows.length, skipped: items.length - rows.length, filed: rows.filter((r) => r.categoryId).length, dups: items.filter((i) => i.dup).length };
    },
  };
  return api;
}
