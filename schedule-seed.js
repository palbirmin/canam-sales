// The owner's two handwritten schedule sheets (photo of 2026-11-12), typed in. Used two ways:
//   - phone/tools/make-schedule-seed.mjs turns it into supabase_schedule_seed.sql (the owner runs that once)
//   - the Schedule tab's local preview (?demo=1 on this computer) and its "not set up yet" sample
// Week 1 = the sheet with Heather first, week 2 = the sheet with Rahul first (owner, 2026-11-12: the sheets end
// Mon Nov 16, so week 1 is Tue Nov 3 – Mon Nov 9 and week 2 is Tue Nov 10 – Mon Nov 16).
// "cl" on the sheets = Close, "open" = the store's opening time. Cells marked "check" were hard to read.

export const SEED_WEEK1_TUESDAY = '2026-11-03'; // the only date in here; everything else counts from it

export const SEED_EMPLOYEES = ['Rahul', 'Chrystal', 'Heather', 'Shruti', 'Atma'];

const S = (start_at, end_at, note = '') => ({ kind: 'shift', start_at, end_at, note });
const OFF = { kind: 'off', start_at: null, end_at: null, note: '' };
const NONE = (note) => ({ kind: 'none', start_at: null, end_at: null, note });
const _ = null; // not scheduled (blank on the sheet)
const CL = 'close';
const OP = 'open';

// 7 cells each, Tuesday first.
export const SEED_WEEKS = [
  { // week 1
    Heather: [S('16:00', CL), OFF, OFF, S('16:00', CL), S('16:00', CL), S('16:00', CL), S('16:00', CL)],
    Chrystal: [OFF, S('16:00', CL), S('16:00', CL), S('10:00', '16:00'), S('16:00', '22:00'), S('16:00', '22:00'), S('10:00', '16:00')],
    Rahul: [S('10:00', CL), S('10:00', CL), S('10:00', CL), S('10:00', CL), S('10:00', CL), OFF, S('10:00', CL)],
    Shruti: [_, _, _, S('16:00', CL), S(OP, CL, 'check: sheet says 11–11 (Sat opens 11 am, closes 11 pm)'), OFF,
      NONE('check: unclear mark on the sheet')],
    Atma: [S(OP, '18:00'), S('10:00', '18:00'), S(OP, '18:00'), S('12:00', '20:00'), S('15:00', '20:00'), _, S(OP, '18:00')],
  },
  { // week 2
    Rahul: [S(OP, CL), OFF, S(OP, CL), S('10:00', CL), S(OP, CL), S(OP, CL), S(OP, CL)],
    Chrystal: [OFF, S('16:00', CL), S('16:00', CL), S('11:00', '16:00'), S('16:00', CL), S('16:00', CL), S('16:00', CL)],
    Heather: [S('16:00', CL), S('16:00', CL), OFF, S('16:00', CL), S('16:00', CL), S('16:00', CL), OFF],
    Shruti: [_, _, _, S('16:00', CL), S(OP, CL, 'check: sheet says 11–11'),
      S(OP, CL, 'check: sheet says 11–11, but Sunday closes at 10 pm'), NONE('check: tick mark on the sheet')],
    // Atma isn't on the week 2 sheet
  },
];

// Extra quick buttons, the other shifts that appear on the sheets.
export const SEED_PRESETS = [
  { start_at: OP, end_at: '18:00' },
  { start_at: '10:00', end_at: '18:00' },
  { start_at: '12:00', end_at: '20:00' },
  { start_at: '15:00', end_at: '20:00' },
  { start_at: '16:00', end_at: '22:00' },
];

// [{ name, offset (days after SEED_WEEK1_TUESDAY), row }]
export function seedCells() {
  const out = [];
  SEED_WEEKS.forEach((week, w) => {
    for (const [name, cells] of Object.entries(week)) {
      cells.forEach((row, i) => { if (row) out.push({ name, offset: w * 7 + i, row }); });
    }
  });
  return out;
}
