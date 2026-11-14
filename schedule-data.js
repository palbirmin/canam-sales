// Schedule tab (version 1.22.0): reading and saving the schedule. Two stores with the same calls:
//   makeScheduleStore(supa)  the real one, Supabase tables from supabase_schedule.sql (owner only)
//   makeSampleStore()        in memory, filled with the paper sheets (schedule-seed.js): the local preview
//                            (?demo=1 on this computer) and the "not set up yet" sample. Nothing is saved.
import { SEED_WEEK1_TUESDAY, SEED_EMPLOYEES, SEED_PRESETS, seedCells } from './schedule-seed.js';
import { addDays } from './schedule-logic.js';

export const missingTables = (e) => /could not find the table|does not exist|schema cache|PGRST20[0-9]|42P01/i.test(String(e?.message || e));
const COLS = 'employee_id,work_date,kind,start_at,end_at,note';
const clean = (r) => ({ employee_id: r.employee_id, work_date: r.work_date, kind: r.kind, start_at: r.start_at ?? null, end_at: r.end_at ?? null, note: r.note || '' });

export function makeScheduleStore(supa) {
  const byEmp = (keys) => {
    const m = new Map();
    for (const k of keys) { if (!m.has(k.employee_id)) m.set(k.employee_id, []); m.get(k.employee_id).push(k.work_date); }
    return m;
  };
  return {
    sample: false,
    async setup() {
      const [employees, presets, settings] = await Promise.all([
        supa.rest('GET', 'schedule_employees?select=id,name,sort,active,usual_week&order=sort,name'),
        supa.rest('GET', 'schedule_presets?select=id,start_at,end_at,sort&order=sort,created_at'),
        supa.rest('GET', 'schedule_settings?select=period_start&id=eq.1'),
      ]);
      return { employees, presets, periodStart: settings[0]?.period_start || null };
    },
    shifts: (from, to) => supa.rest('GET', `schedule_shifts?select=${COLS}&work_date=gte.${from}&work_date=lte.${to}&order=work_date`),
    // rows: full rows to write (insert, or replace that person's day)
    async save(rows) {
      if (!rows.length) return;
      await supa.rest('POST', 'schedule_shifts?on_conflict=employee_id,work_date', rows.map(clean), 'resolution=merge-duplicates,return=minimal');
    },
    // keys: [{ employee_id, work_date }] to empty
    async clear(keys) {
      for (const [id, days] of byEmp(keys)) {
        await supa.rest('DELETE', `schedule_shifts?employee_id=eq.${id}&work_date=in.(${days.join(',')})`);
      }
    },
    saveUsual: (id, usual) => supa.rest('PATCH', `schedule_employees?id=eq.${id}`, { usual_week: usual }, 'return=minimal'),
    async addPreset(p) {
      const id = crypto.randomUUID();
      await supa.rest('POST', 'schedule_presets', { id, start_at: p.start_at, end_at: p.end_at, sort: p.sort || 0 }, 'return=minimal');
      return { id, ...p };
    },
    removePreset: (id) => supa.rest('DELETE', `schedule_presets?id=eq.${id}`),
    async addEmployee(name, sort) {
      const id = crypto.randomUUID();
      await supa.rest('POST', 'schedule_employees', { id, name, sort }, 'return=minimal');
      return { id, name, sort, active: true, usual_week: null };
    },
    setActive: (id, active) => supa.rest('PATCH', `schedule_employees?id=eq.${id}`, { active }, 'return=minimal'),
  };
}

export function makeSampleStore({ delay = 250 } = {}) {
  const wait = () => new Promise((r) => setTimeout(r, delay));
  const employees = SEED_EMPLOYEES.map((name, i) => ({ id: `e${i + 1}`, name, sort: (i + 1) * 10, active: true, usual_week: null }));
  const idOf = Object.fromEntries(employees.map((e) => [e.name, e.id]));
  const rows = new Map();
  for (const { name, offset, row } of seedCells()) {
    const r = clean({ ...row, employee_id: idOf[name], work_date: addDays(SEED_WEEK1_TUESDAY, offset) });
    rows.set(`${r.employee_id}|${r.work_date}`, r);
  }
  let presets = SEED_PRESETS.map((p, i) => ({ id: `p${i + 1}`, ...p, sort: (i + 1) * 10 }));
  return {
    sample: true,
    async setup() { return { employees: employees.map((e) => ({ ...e })), presets: presets.map((p) => ({ ...p })), periodStart: SEED_WEEK1_TUESDAY }; },
    async shifts(from, to) { return [...rows.values()].filter((r) => r.work_date >= from && r.work_date <= to).map((r) => ({ ...r })); },
    async save(list) { await wait(); for (const r of list) rows.set(`${r.employee_id}|${r.work_date}`, clean(r)); },
    async clear(keys) { await wait(); for (const k of keys) rows.delete(`${k.employee_id}|${k.work_date}`); },
    async saveUsual(id, usual) { await wait(); const e = employees.find((x) => x.id === id); if (e) e.usual_week = usual; },
    async addPreset(p) { await wait(); const x = { id: `p${Date.now()}`, ...p }; presets.push(x); return x; },
    async removePreset(id) { await wait(); presets = presets.filter((p) => p.id !== id); },
    async addEmployee(name, sort) { await wait(); const e = { id: `e${Date.now()}`, name, sort, active: true, usual_week: null }; employees.push(e); return { ...e }; },
    async setActive(id, active) { await wait(); const e = employees.find((x) => x.id === id); if (e) e.active = active; },
  };
}
