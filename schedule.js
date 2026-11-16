// Schedule tab (version 1.22.0, phone page, owner only). The staff schedule by 2-week pay period (weeks run
// Tuesday to Monday), replacing the handwritten sheets. phone.js loads this file for owner logins only; the
// tables behind it (supabase_schedule.sql) answer only logins on dashboard_users.
//
// Computer or tablet (768 px and wider): a spreadsheet. Names down the left, Tue–Mon across, both weeks stacked,
// an Hours column on the right. In Edit, click a day and type the owner's shorthand ("4-cl", "10-4", "open-cl",
// "off"); arrows, Tab and Enter move, Esc cancels, Delete clears, Ctrl/Cmd+C and V copy and paste (also from
// Excel or Google Sheets), shift-click or drag selects several days and a shift button fills them.
// Phone: a Today card and a by-day or by-person list. In Edit, one week at a time: pick a shift button, then tap
// days to fill them (hold a day to clear it), or tap a day without a button picked to type, pick, set a custom
// time or add a note.
// Every change saves by itself (the bar at the bottom says Saved), and Undo takes back the last one.
import { todayKey } from './lib.js';
import { OPENS, CLOSES } from './dough-plan.js';
import * as L from './schedule-logic.js';
import { makeScheduleStore, makeSampleStore, missingTables } from './schedule-data.js';

const HOURS = { opens: OPENS, closes: CLOSES };
const WIDE = matchMedia('(min-width: 768px)');
const nb = (s) => s.replace(/ (am|pm)\b/g, '&nbsp;$1'); // "4 pm" never splits over two lines
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const keyOf = (id, k) => `${id}|${k}`;
const sameRow = (a, b) => (!a && !b) || (!!a && !!b && a.kind === b.kind && (a.start_at ?? null) === (b.start_at ?? null)
  && (a.end_at ?? null) === (b.end_at ?? null) && (a.note || '') === (b.note || ''));
const nowClock = () => new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();

export function initSchedule({ supa, demo = false, forceMissing = false }) {
  const $ = (id) => document.getElementById(id);
  const root = $('schedule');
  const body = $('scBody');
  const bar = $('scBar');
  const dlg = $('scDialog');
  const tabBtn = $('schedTabBtn');
  const printEl = $('scPrint');
  if (!root || !tabBtn) return;
  tabBtn.hidden = false;
  if (printEl) document.body.appendChild(printEl); // printed on its own, outside the page

  let store = demo && !forceMissing ? makeSampleStore() : makeScheduleStore(supa);
  const S = {
    ready: false, loading: null, error: '', missing: false,
    employees: [], presets: [], anchor: L.DEFAULT_PERIOD_START, period: null,
    cells: new Map(), loaded: new Set(),
    editing: false, brush: null, // brush: a preset object, or 'clear'
    sel: null, // { ar, ac, fr, fc } anchor and focus (computer grid)
    typing: null, // { r, c, text, error }
    bad: new Map(), // cell key -> { text, error }: typed but not readable, not saved
    undo: [], status: null, // { kind: 'saving' | 'saved' | 'error' | 'info', text }
    pending: new Set(), flash: new Set(),
    week: 0, list: 'day', // phone: which week, and By day / By person
    active: false,
  };
  try { S.list = localStorage.getItem('canam.schedList') === 'person' ? 'person' : 'day'; } catch { /* private mode */ }
  let queue = Promise.resolve();

  // ---------- data ----------
  const T = () => todayKey();
  const days = () => L.periodDays(S.period);
  const visibleEmps = () => {
    const ds = days();
    return S.employees.filter((e) => e.active || ds.some((k) => S.cells.has(keyOf(e.id, k))));
  };
  const rowsModel = () => { const emps = visibleEmps(); return [0, 1].flatMap((w) => emps.map((e) => ({ w, e }))); };
  const dateAt = (r, c) => { const m = rowsModel()[r]; return m ? L.addDays(S.period, m.w * 7 + c) : null; };
  const cellAt = (r, c) => { const m = rowsModel()[r]; return m ? S.cells.get(keyOf(m.e.id, dateAt(r, c))) || null : null; };
  const allPresets = () => [...L.BUILT_IN_PRESETS, ...S.presets.map((p) => ({ ...p, kind: 'shift', saved: true }))];

  async function setup() {
    try {
      if (forceMissing) throw new Error('Could not find the table public.schedule_employees in the schema cache');
      const s = await store.setup();
      Object.assign(S, { employees: s.employees, presets: s.presets, anchor: L.isTuesday(s.periodStart) ? s.periodStart : L.DEFAULT_PERIOD_START });
    } catch (e) {
      if (!missingTables(e)) throw e;
      S.missing = true;
      store = makeSampleStore();
      const s = await store.setup();
      Object.assign(S, { employees: s.employees, presets: s.presets, anchor: s.periodStart });
    }
    S.period = L.periodStartOf(T(), S.anchor);
    S.week = weekOfToday();
    await loadPeriod(S.period);
    S.ready = true;
  }
  async function loadPeriod(start) {
    if (S.loaded.has(start)) return;
    const rows = await store.shifts(start, L.addDays(start, 13));
    for (const r of rows) S.cells.set(keyOf(r.employee_id, r.work_date), r);
    S.loaded.add(start);
  }
  function ensure() {
    if (S.ready || S.loading) return S.loading;
    S.loading = setup().catch((e) => { S.error = e.message || String(e); }).finally(() => { S.loading = null; render(); });
    return S.loading;
  }
  const weekOfToday = () => { const d = L.daysFrom(S.period, T()); return d >= 7 && d < 14 ? 1 : 0; };

  // ---------- saving: every change saves by itself, in order; Undo puts the days back ----------
  const describe = (ch) => {
    const e = S.employees.find((x) => x.id === ch.employee_id);
    return `${e?.name || ''} · ${L.dayLabel(ch.work_date)}: ${ch.row ? (L.cellWords(ch.row).text || 'note') : 'cleared'}`;
  };
  function apply(changes, { label = '', undoing = false } = {}) {
    if (S.missing) { setStatus('info', 'Not set up yet, so nothing can be saved. See the note at the top.'); return Promise.resolve(); }
    changes = changes.filter((ch) => !sameRow(S.cells.get(keyOf(ch.employee_id, ch.work_date)), ch.row));
    if (!changes.length) return Promise.resolve();
    const before = changes.map((ch) => ({ employee_id: ch.employee_id, work_date: ch.work_date, row: S.cells.get(keyOf(ch.employee_id, ch.work_date)) || null }));
    const text = label || (changes.length === 1 ? describe(changes[0]) : `${changes.length} days`);
    for (const ch of changes) {
      const k = keyOf(ch.employee_id, ch.work_date);
      if (ch.row) S.cells.set(k, { ...ch.row, employee_id: ch.employee_id, work_date: ch.work_date, note: ch.row.note || '' });
      else S.cells.delete(k);
      S.pending.add(k);
      S.bad.delete(k);
    }
    setStatus('saving', 'Saving…');
    render();
    const job = async () => {
      try {
        const save = changes.filter((c) => c.row).map((c) => ({ ...c.row, employee_id: c.employee_id, work_date: c.work_date }));
        const clear = changes.filter((c) => !c.row).map((c) => ({ employee_id: c.employee_id, work_date: c.work_date }));
        await store.save(save);
        await store.clear(clear);
        if (!undoing) S.undo.push({ label: text, before });
        if (S.undo.length > 50) S.undo.shift();
        setStatus('saved', `${undoing ? 'Undone' : 'Saved'} ${nowClock()} · ${text}`);
        for (const ch of changes) S.flash.add(keyOf(ch.employee_id, ch.work_date));
        setTimeout(() => { S.flash.clear(); render(); }, 900);
      } catch (e) {
        for (const b of before) { // put it back the way it was, so the page never shows something unsaved
          const k = keyOf(b.employee_id, b.work_date);
          if (b.row) S.cells.set(k, b.row); else S.cells.delete(k);
        }
        setStatus('error', `Not saved: ${e.message || e}. Check the internet connection and try again.`);
      } finally {
        for (const ch of changes) S.pending.delete(keyOf(ch.employee_id, ch.work_date));
        render();
      }
    };
    queue = queue.then(job);
    return queue;
  }
  function undoLast() {
    const u = S.undo.pop();
    if (!u) return;
    apply(u.before.map((b) => ({ employee_id: b.employee_id, work_date: b.work_date, row: b.row })), { label: u.label, undoing: true });
  }
  function setStatus(kind, text) { S.status = { kind, text }; }

  // a shift put on a day keeps the day's own note, except a "check" note (looking at it was the check)
  const withNote = (row, old) => (row ? { ...row, note: old && !L.needsCheck(old) ? old.note || '' : '' } : null);
  const brushRow = (b) => (b === 'clear' ? null : { kind: b.kind, start_at: b.start_at ?? null, end_at: b.end_at ?? null });

  // ---------- page ----------
  function render() {
    if (!S.active) return;
    if (!S.ready) {
      body.innerHTML = S.error
        ? `<div class="sc-card sc-note err"><b>Couldn't load the schedule.</b> ${esc(S.error)} <button class="sc-btn" data-act="retry">Try again</button></div>`
        : '<div class="sc-card sc-loading">Loading the schedule…</div>';
      bar.hidden = true;
      return;
    }
    const wide = WIDE.matches;
    document.body.classList.toggle('sc-editing', S.editing);
    const ds = days();
    const cur = L.periodStartOf(T(), S.anchor) === S.period;
    const typingFocus = S.typing && document.activeElement?.classList.contains('sc-in');
    body.innerHTML = [
      headHtml(cur),
      noticeHtml(),
      cur ? todayHtml() : '',
      S.editing && !ds.some((k) => S.employees.some((e) => S.cells.has(keyOf(e.id, k)))) ? emptyHtml() : '',
      wide ? gridHtml({ weeks: [0, 1] }) : S.editing ? phoneEditHtml() : phoneListHtml(),
      hoursHtml(),
      S.editing ? toolsHtml() : '',
      storeHoursHtml(),
    ].join('');
    bar.hidden = !S.editing;
    if (S.editing) bar.innerHTML = barHtml(wide);
    if (S.typing) {
      const inp = body.querySelector('.sc-in');
      if (inp && (typingFocus || S.typing.fresh)) {
        inp.focus();
        const n = inp.value.length;
        inp.setSelectionRange(n, n);
        S.typing.fresh = false;
      }
    }
    renderPrint();
  }

  function headHtml(cur) {
    const end = L.addDays(S.period, 13);
    return `<header class="sc-head">
      <div class="sc-period">
        <button class="sc-icon" data-act="prev" aria-label="Previous pay period">‹</button>
        <div class="sc-period-txt"><b>${esc(L.rangeLabel(S.period, end))}</b><small>Pay period · two weeks, Tuesday to Monday${cur ? ' · this one' : ''}</small></div>
        <button class="sc-icon" data-act="next" aria-label="Next pay period">›</button>
      </div>
      <div class="sc-actions">
        ${cur ? '' : '<button class="sc-btn quiet" data-act="current">This period</button>'}
        <button class="sc-btn quiet" data-act="print">Print</button>
        <button class="sc-btn ${S.editing ? 'primary' : ''}" data-act="edit" ${S.missing ? 'disabled' : ''}>${S.editing ? 'Done' : 'Edit'}</button>
      </div>
    </header>`;
  }

  function noticeHtml() {
    if (S.missing) {
      return `<div class="sc-card sc-note warn"><b>The schedule isn't set up yet.</b> Below are your two paper sheets as a sample;
        nothing can be saved until it is. One time, on the computer: Supabase → project "Can Am Finances" → SQL Editor →
        New query, paste <code>phone/supabase_schedule.sql</code> and press Run, then do the same with
        <code>phone/supabase_schedule_seed.sql</code>. Then reload this page.</div>`;
    }
    if (demo) return '<div class="sc-card sc-note">Preview on this computer with the paper sheets. Changes stay on this page only.</div>';
    return '';
  }

  function todayHtml() {
    const t = T();
    const work = []; const off = []; const none = [];
    for (const e of visibleEmps()) {
      const row = S.cells.get(keyOf(e.id, t));
      if (row?.kind === 'shift') work.push({ e, row });
      else if (row?.kind === 'off') off.push(e.name);
      else if (e.active) none.push(e.name);
    }
    const startMin = (row) => { const w = L.jsWeekday(t); return row.start_at === 'open' ? HOURS.opens[w] : L.toMinutes(row.start_at); };
    work.sort((a, b) => startMin(a.row) - startMin(b.row));
    return `<section class="sc-card sc-today" aria-label="Today">
      <h2>Today <span>${esc(L.DAY_LONG[(L.jsWeekday(t) + 5) % 7])}, ${esc(L.shortDate(t))}</span></h2>
      ${work.length ? `<ul class="sc-today-list">${work.map(({ e, row }) => `<li><b>${esc(e.name)}</b><span>${esc(L.shiftWithTimes(row, t, HOURS))}</span>${row.note ? `<em class="${L.needsCheck(row) ? 'chk' : ''}">${esc(row.note)}</em>` : ''}</li>`).join('')}</ul>`
        : '<p class="sc-muted">Nobody is on the schedule today.</p>'}
      ${off.length ? `<p class="sc-today-off"><span>Off</span> ${esc(off.join(', '))}</p>` : ''}
      ${none.length ? `<p class="sc-today-off quiet"><span>Not scheduled</span> ${esc(none.join(', '))}</p>` : ''}
    </section>`;
  }

  function emptyHtml() {
    const hasUsual = S.employees.some((e) => e.active && L.validUsual(e.usual_week));
    return `<div class="sc-card sc-empty"><b>This pay period is empty.</b>
      <p>Start it from everyone's usual week, or from the last period, then fix the days that are different.</p>
      <div class="sc-row-btns">
        <button class="sc-btn primary" data-act="fill-usual" ${hasUsual ? '' : 'disabled'}>Fill from usual weeks</button>
        <button class="sc-btn" data-act="copy-last">Copy last period</button>
      </div>
      ${hasUsual ? '' : '<p class="sc-muted">No usual weeks saved yet: in a filled period, tap a name and choose "Save as usual".</p>'}
    </div>`;
  }

  // ---- one cell's inside
  function cellInner(row, k, { compact = false } = {}) {
    const bad = S.bad.get(k);
    if (bad) return `<span class="sc-w bad-t">${esc(bad.text)}</span>`;
    const w = L.cellWords(row);
    const mark = row?.note ? `<i class="sc-mark ${L.needsCheck(row) ? 'chk' : ''}" title="${esc(row.note)}"></i>` : '';
    if (!row || row.kind === 'none') return `<span class="sc-w blank" aria-label="not scheduled"></span>${mark}`;
    if (row.kind === 'off') return `<span class="sc-w off">OFF</span>${mark}`;
    return compact ? `<span class="sc-w"><span>${esc(w.a)}</span><span>${esc(w.b)}</span></span>${mark}` : `<span class="sc-w">${esc(w.text)}</span>${mark}`;
  }
  function cellClass(row, k, extra = []) {
    const c = ['sc-cell', ...extra];
    if (!row || row.kind === 'none') c.push('is-blank'); else if (row.kind === 'off') c.push('is-off'); else c.push('is-shift');
    if (S.pending.has(k)) c.push('is-pending');
    if (S.flash.has(k)) c.push('is-saved');
    if (S.bad.has(k)) c.push('is-bad');
    if (row?.note) c.push(L.needsCheck(row) ? 'has-check' : 'has-note');
    return c.join(' ');
  }
  const weekHours = (e, w) => L.sumMinutes(L.periodDays(S.period).slice(w * 7, w * 7 + 7).map((k) => [S.cells.get(keyOf(e.id, k)), k]), HOURS);

  // ---- the spreadsheet (computer and tablet)
  function selBox() {
    if (!S.sel) return null;
    return { r0: Math.min(S.sel.ar, S.sel.fr), r1: Math.max(S.sel.ar, S.sel.fr), c0: Math.min(S.sel.ac, S.sel.fc), c1: Math.max(S.sel.ac, S.sel.fc) };
  }
  function gridHtml() {
    const emps = visibleEmps();
    const t = T();
    const box = S.editing ? selBox() : null;
    let r = 0;
    const tbodies = [0, 1].map((w) => {
      const ds = L.periodDays(S.period).slice(w * 7, w * 7 + 7);
      const head = `<tr class="sc-wk"><th scope="row">Week ${w + 1}</th>${ds.map((k) => `<th class="${k === t ? 'is-today' : ''}">${esc(L.shortDate(k))}${k === t ? ' · today' : ''}</th>`).join('')}<th class="sc-hrs"></th></tr>`;
      const rows = emps.map((e) => {
        const cells = ds.map((k, c) => {
          const row = S.cells.get(keyOf(e.id, k)) || null;
          const kk = keyOf(e.id, k);
          const extra = [];
          if (k === t) extra.push('is-today');
          if (box && r >= box.r0 && r <= box.r1 && c >= box.c0 && c <= box.c1) extra.push('is-sel');
          if (S.editing && S.sel && S.sel.fr === r && S.sel.fc === c) extra.push('is-cursor');
          const typing = S.typing && S.typing.r === r && S.typing.c === c;
          if (typing && S.typing.error) extra.push('is-bad');
          const inner = typing
            ? `<input class="sc-in" value="${esc(S.typing.text)}" aria-label="${esc(e.name)} ${esc(L.dayLabel(k))}" autocomplete="off" spellcheck="false">`
            : cellInner(row, kk);
          const tip = S.bad.get(kk)?.error || row?.note || '';
          return `<td class="${cellClass(row, kk, extra)}" data-r="${r}" data-c="${c}"${tip ? ` title="${esc(tip)}"` : ''}>${inner}</td>`;
        }).join('');
        const h = weekHours(e, w);
        const html = `<tr${e.active ? '' : ' class="inactive"'}><th scope="row" class="sc-name"${S.editing ? ` data-emp="${esc(e.id)}" tabindex="0"` : ''}>${esc(e.name)}</th>${cells}<td class="sc-hrs">${esc(L.hoursText(h))}</td></tr>`;
        r += 1;
        return html;
      }).join('');
      return `<tbody>${head}${rows}</tbody>`;
    }).join('');
    return `<div class="sc-sheet-wrap ${S.editing ? 'editing' : ''}"><table class="sc-grid" aria-label="Schedule">
      <thead><tr><th class="sc-corner">Name</th>${L.DAY_NAMES.map((d) => `<th>${d}</th>`).join('')}<th class="sc-hrs">Hours</th></tr></thead>
      ${tbodies}</table></div>
      ${S.editing ? `<p class="sc-help">Click a day and type, like <b>4-cl</b>, <b>10-4</b>, <b>open-cl</b> or <b>off</b>. Enter, Tab and the arrows move; Delete clears; Ctrl or Cmd + C / V copy and paste (also from Excel). Shift-click or drag to pick several days, then press a shift button below. Click a name for usual weeks.</p><p class="sc-type-preview" aria-live="polite">${typePreview()}</p>` : ''}`;
  }

  // ---- phone: edit one week at a time
  function weekSwitch() {
    return `<div class="sc-seg" role="group" aria-label="Week">${[0, 1].map((w) => {
      const a = L.addDays(S.period, w * 7);
      return `<button data-act="week" data-w="${w}" aria-pressed="${S.week === w}">Week ${w + 1}<small>${esc(L.rangeLabel(a, L.addDays(a, 6)))}</small></button>`;
    }).join('')}</div>`;
  }
  function phoneEditHtml() {
    const emps = visibleEmps();
    const t = T();
    const ds = L.periodDays(S.period).slice(S.week * 7, S.week * 7 + 7);
    const rows = emps.map((e, i) => {
      const r = S.week * emps.length + i;
      return `<tr><th scope="row" class="sc-name" data-emp="${esc(e.id)}"><span>${esc(e.name)}</span><small>${esc(L.hoursText(weekHours(e, S.week)))}</small></th>${ds.map((k, c) => {
        const row = S.cells.get(keyOf(e.id, k)) || null;
        const kk = keyOf(e.id, k);
        return `<td class="${cellClass(row, kk, k === t ? ['is-today'] : [])}" data-r="${r}" data-c="${c}">${cellInner(row, kk, { compact: true })}</td>`;
      }).join('')}</tr>`;
    }).join('');
    return `${weekSwitch()}<div class="sc-phone-wrap"><table class="sc-grid compact" aria-label="Schedule, week ${S.week + 1}">
      <thead><tr><th class="sc-corner"></th>${ds.map((k) => `<th class="${k === t ? 'is-today' : ''}">${esc(L.DAY_NAMES[(L.jsWeekday(k) + 5) % 7])}<small>${esc(k.slice(8).replace(/^0/, ''))}</small></th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody></table></div>
      <p class="sc-help">${S.brush ? `Tap days to make them <b>${esc(S.brush === 'clear' ? 'empty' : L.presetText(S.brush))}</b>. Tap the button again to stop.` : 'Pick a shift below, then tap days to fill them. Or tap a day to type, pick a custom time or add a note.'} Hold a day to clear it. Tap a name for usual weeks.</p>`;
  }

  // ---- phone: view (no grid)
  function phoneListHtml() {
    const emps = visibleEmps();
    const t = T();
    const ds = L.periodDays(S.period).slice(S.week * 7, S.week * 7 + 7);
    const toggle = `<div class="sc-seg small" role="group" aria-label="Show"><button data-act="list" data-l="day" aria-pressed="${S.list === 'day'}">By day</button><button data-act="list" data-l="person" aria-pressed="${S.list === 'person'}">By person</button></div>`;
    let list;
    if (S.list === 'day') {
      list = ds.map((k) => {
        const work = []; const off = [];
        for (const e of emps) {
          const row = S.cells.get(keyOf(e.id, k));
          if (row?.kind === 'shift') work.push({ e, row }); else if (row?.kind === 'off') off.push(e.name);
          else if (row?.note) work.push({ e, row });
        }
        return `<section class="sc-card sc-day ${k === t ? 'is-today' : ''}"><h3>${esc(L.DAY_LONG[(L.jsWeekday(k) + 5) % 7])} <span>${esc(L.shortDate(k))}${k === t ? ' · today' : ''}</span></h3>
          ${work.length ? `<ul>${work.map(({ e, row }) => `<li><b>${esc(e.name)}</b><span>${row.kind === 'shift' ? esc(L.cellWords(row).text) : '<i class="sc-muted">not scheduled</i>'}</span>${row.note ? `<em class="${L.needsCheck(row) ? 'chk' : ''}">${esc(row.note)}</em>` : ''}</li>`).join('')}</ul>` : '<p class="sc-muted">Nobody scheduled.</p>'}
          ${off.length ? `<p class="sc-off-line"><span>Off</span> ${esc(off.join(', '))}</p>` : ''}</section>`;
      }).join('');
    } else {
      list = emps.map((e) => `<section class="sc-card sc-person"><h3>${esc(e.name)} <span>${esc(L.hoursText(weekHours(e, S.week)))}</span></h3>
        <ul>${ds.map((k) => {
          const row = S.cells.get(keyOf(e.id, k));
          const w = L.cellWords(row);
          return `<li class="${k === t ? 'is-today' : ''}"><b>${esc(L.DAY_NAMES[(L.jsWeekday(k) + 5) % 7])} ${esc(k.slice(8).replace(/^0/, ''))}</b><span class="${row?.kind === 'off' ? 'off' : !w.text ? 'blank' : ''}">${w.text ? esc(w.text) : '—'}</span>${row?.note ? `<em class="${L.needsCheck(row) ? 'chk' : ''}">${esc(row.note)}</em>` : ''}</li>`;
        }).join('')}</ul></section>`).join('');
    }
    return `${weekSwitch()}${toggle}<div class="sc-list">${list}</div>`;
  }

  function hoursHtml() {
    const emps = visibleEmps();
    let t0 = 0; let t1 = 0; let bad = false;
    const rows = emps.map((e) => {
      const a = weekHours(e, 0); const b = weekHours(e, 1);
      if (a == null || b == null) bad = true; else { t0 += a; t1 += b; }
      return `<tr><th scope="row">${esc(e.name)}</th><td>${esc(L.hoursText(a))}</td><td>${esc(L.hoursText(b))}</td><td><b>${esc(L.hoursText(a == null || b == null ? null : a + b))}</b></td></tr>`;
    }).join('');
    return `<section class="sc-card sc-hours" aria-label="Hours"><h2>Hours this pay period</h2>
      <table><thead><tr><th></th><th>Week 1</th><th>Week 2</th><th>Total</th></tr></thead><tbody>${rows}</tbody>
      <tfoot><tr><th scope="row">Everyone</th><td>${esc(L.hoursText(bad ? null : t0))}</td><td>${esc(L.hoursText(bad ? null : t1))}</td><td><b>${esc(L.hoursText(bad ? null : t0 + t1))}</b></td></tr></tfoot></table>
      <p class="sc-muted">Scheduled hours, worked out from the shifts (no breaks taken off). "—" means a shift that can't be counted.</p></section>`;
  }
  function storeHoursHtml() {
    return `<p class="sc-foot">Open and Close follow the store hours: ${esc(L.storeHoursLines(HOURS).join(' · '))}.</p>`;
  }

  function toolsHtml() {
    const hidden = S.employees.filter((e) => !e.active);
    const hasUsual = S.employees.some((e) => e.active && L.validUsual(e.usual_week));
    return `<section class="sc-card sc-tools" aria-label="Schedule tools"><h2>Fill in faster</h2>
      <div class="sc-row-btns">
        <button class="sc-btn" data-act="fill-usual" ${hasUsual ? '' : 'disabled'}>Fill empty days from usual weeks</button>
        <button class="sc-btn" data-act="copy-last">Copy last period into empty days</button>
      </div>
      <p class="sc-muted">Both only fill days that are still empty; nothing you've entered is replaced. Usual weeks:
        ${S.employees.filter((e) => e.active).map((e) => `${esc(e.name)} ${L.validUsual(e.usual_week) ? '✓' : '—'}`).join(' · ')} (tap a name to save one).</p>
      <h3>Staff</h3>
      <form class="sc-add" data-form="add-emp"><input name="name" maxlength="40" placeholder="New employee's name" aria-label="New employee's name" autocomplete="off"><button class="sc-btn">Add</button></form>
      ${hidden.length ? `<p class="sc-muted">Hidden: ${hidden.map((e) => `${esc(e.name)} <button class="sc-link" data-act="show-emp" data-id="${esc(e.id)}">show again</button>`).join(' · ')}</p>` : ''}
    </section>`;
  }

  function barHtml(wide) {
    const st = S.status;
    const u = S.undo[S.undo.length - 1];
    const box = selBox();
    const nSel = box ? (box.r1 - box.r0 + 1) * (box.c1 - box.c0 + 1) : 0;
    const btn = (p) => {
      const on = S.brush && S.brush !== 'clear' && L.sameShift(S.brush, p);
      return `<span class="sc-chip-wrap"><button class="sc-chip ${p.kind === 'off' ? 'off' : ''}" data-act="brush" data-p="${esc(p.id)}" aria-pressed="${!!on}">${nb(esc(L.presetText(p)))}</button>${p.saved ? `<button class="sc-chip-x" data-act="del-preset" data-p="${esc(p.id)}" aria-label="Remove the ${esc(L.presetText(p))} button">×</button>` : ''}</span>`;
    };
    return `<div class="sc-bar-in">
      <div class="sc-status ${st?.kind || ''}" role="status" aria-live="polite">${st ? `${st.kind === 'saved' ? '<b>✓</b> ' : ''}${esc(st.text)}` : (wide ? 'Every change saves by itself.' : 'Every tap saves by itself.')}</div>
      <button class="sc-btn quiet sc-undo" data-act="undo" ${u ? '' : 'disabled'} title="${u ? esc(`Undo: ${u.label}`) : ''}">Undo</button>
      <div class="sc-chips">${allPresets().map(btn).join('')}
        <button class="sc-chip custom" data-act="custom">Custom…</button>
        <button class="sc-chip clear" data-act="brush" data-p="clear" aria-pressed="${S.brush === 'clear'}">Clear</button>
      </div>
      ${wide ? `<div class="sc-bar-hint">${S.brush ? `Click or drag over days to make them ${esc(S.brush === 'clear' ? 'empty' : L.presetText(S.brush))}. Press the button again to stop.` : nSel ? `${nSel} day${nSel === 1 ? '' : 's'} picked: press a button to fill ${nSel === 1 ? 'it' : 'them'}.` : 'Pick days in the grid, then press a button.'}</div>` : ''}
    </div>`;
  }

  // ---------- printing: one landscape page per pay period ----------
  function renderPrint() {
    if (!printEl) return;
    const emps = visibleEmps();
    const weeks = [0, 1].map((w) => {
      const ds = L.periodDays(S.period).slice(w * 7, w * 7 + 7);
      return `<table><thead><tr><th>Week ${w + 1}</th>${ds.map((k) => `<th>${esc(L.dayLabel(k))}</th>`).join('')}<th>Hours</th></tr></thead><tbody>
        ${emps.map((e) => `<tr><th>${esc(e.name)}</th>${ds.map((k) => {
          const row = S.cells.get(keyOf(e.id, k));
          const w2 = L.cellWords(row);
          return `<td class="${row?.kind === 'off' ? 'off' : ''}">${esc(w2.text)}${row?.note && !L.needsCheck(row) ? `<small>${esc(row.note)}</small>` : ''}</td>`;
        }).join('')}<td class="h">${esc(L.hoursText(weekHours(e, w)))}</td></tr>`).join('')}
      </tbody></table>`;
    }).join('');
    printEl.innerHTML = `<h1>Can Am Pizza Lakewood · Schedule ${esc(L.rangeLabel(S.period, L.addDays(S.period, 13)))}, ${S.period.slice(0, 4)}</h1>${weeks}
      <p>Open and Close follow the store hours: ${esc(L.storeHoursLines(HOURS).join(' · '))}. Printed ${esc(new Date().toLocaleDateString('en-US'))}.</p>`;
  }
  function doPrint() {
    renderPrint();
    const st = document.createElement('style');
    st.id = 'scPageStyle';
    st.textContent = '@page { size: landscape; margin: 0.4in; }';
    document.head.appendChild(st);
    document.body.classList.add('sc-printing');
    const done = () => { document.body.classList.remove('sc-printing'); st.remove(); removeEventListener('afterprint', done); };
    addEventListener('afterprint', done);
    print();
    setTimeout(done, 1500); // some browsers don't send afterprint
  }

  // ---------- the dialog: one day (phone), the custom time picker, a person's usual week ----------
  let D = null; // what the dialog is showing
  function openDialog(state) { D = state; renderDialog(); if (!dlg.open) dlg.showModal(); }
  function closeDialog() { D = null; if (dlg.open) dlg.close(); }
  dlg.addEventListener('close', () => { D = null; });

  function pickerHtml(p) {
    const part = (which) => {
      const isStart = which === 's';
      const v = p[which];
      const word = isStart ? 'open' : 'close';
      const h = v === word ? null : Math.floor(L.toMinutes(v) / 60);
      const m = v === word ? null : L.toMinutes(v) % 60;
      return `<fieldset class="sc-pick"><legend>${isStart ? 'Starts' : 'Ends'}</legend>
        <button class="sc-pk wide ${v === word ? 'on' : ''}" data-pk="${which}" data-v="${word}">${isStart ? 'Open' : 'Close'}</button>
        <div class="sc-pk-hours">${L.PICK_HOURS.map((x) => `<button class="sc-pk ${h === x ? 'on' : ''}" data-pk="${which}" data-h="${x}">${L.hourWord(x)}</button>`).join('')}</div>
        <div class="sc-pk-mins">${L.PICK_MINUTES.map((x) => `<button class="sc-pk ${m === x ? 'on' : ''}" data-pk="${which}" data-m="${x}" ${v === word ? 'disabled' : ''}>:${String(x).padStart(2, '0')}</button>`).join('')}</div>
      </fieldset>`;
    };
    const ok = p.s && p.e && (p.s === 'open' || p.e === 'close' || L.toMinutes(p.e) > L.toMinutes(p.s));
    return `<div class="sc-picker">${part('s')}${part('e')}</div>
      <p class="sc-pick-out ${ok ? '' : 'sc-err'}">${ok ? `<b>${esc(L.shiftText(p.s, p.e))}</b>` : 'The end has to be after the start.'}</p>
      <label class="sc-check"><input type="checkbox" data-keep ${p.keep ? 'checked' : ''}> Keep it as a shift button</label>
      <div class="sc-row-btns end"><button class="sc-btn quiet" data-dl="back">${p.back ? 'Back' : 'Cancel'}</button><button class="sc-btn primary" data-dl="use-custom" ${ok ? '' : 'disabled'}>Use this shift</button></div>`;
  }

  function renderDialog() {
    if (!D) return;
    if (D.type === 'custom') {
      dlg.innerHTML = `<h2>Custom shift${D.cell ? ` <span>${esc(D.cell.name)} · ${esc(L.dayLabel(D.cell.k))}</span>` : ''}</h2>${pickerHtml(D)}`;
      return;
    }
    if (D.type === 'day') {
      const row = S.cells.get(keyOf(D.id, D.k));
      const parsed = D.text.trim() ? L.parseShift(D.text) : null;
      dlg.innerHTML = `<h2>${esc(D.name)} <span>${esc(L.DAY_LONG[(L.jsWeekday(D.k) + 5) % 7])}, ${esc(L.shortDate(D.k))}</span></h2>
        <p class="sc-now">Now: <b>${row && row.kind !== 'none' ? esc(L.cellWords(row).text) : 'not scheduled'}</b></p>
        <div class="sc-type"><input class="sc-type-in" value="${esc(D.text)}" placeholder="Type it: 4-cl, 10-4, open-cl, off" aria-label="Type a shift" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="done">
          <button class="sc-btn primary" data-dl="use-typed" ${parsed?.row !== undefined && !parsed?.error ? '' : 'disabled'}>Save</button></div>
        <p class="sc-type-out ${parsed?.error ? 'sc-err' : ''}">${parsed ? (parsed.error ? esc(parsed.error) : `= ${esc(parsed.row ? L.cellWords(parsed.row).text : 'empty')}`) : ''}</p>
        <div class="sc-chips in-dialog">${allPresets().map((p) => `<button class="sc-chip ${p.kind === 'off' ? 'off' : ''} ${row && L.sameShift(row, p) ? 'cur' : ''}" data-dl="preset" data-p="${esc(p.id)}">${nb(esc(L.presetText(p)))}</button>`).join('')}
          <button class="sc-chip custom" data-dl="custom">Custom…</button></div>
        <label class="sc-note-in">Note <small>(optional, e.g. training, leave at 8 if slow)</small><input class="sc-note-field" maxlength="200" value="${esc(D.note)}" autocomplete="off"></label>
        <div class="sc-row-btns end">
          <button class="sc-btn quiet" data-dl="clear-day" ${row ? '' : 'disabled'}>Clear day</button>
          <button class="sc-btn quiet" data-dl="close">Close</button>
          <button class="sc-btn" data-dl="save-note" ${(row?.note || '') === D.note ? 'disabled' : ''}>Save note</button>
        </div>`;
      return;
    }
    if (D.type === 'person') {
      const e = S.employees.find((x) => x.id === D.id);
      if (!e) return closeDialog();
      const w = (i) => L.rangeLabel(L.addDays(S.period, i * 7), L.addDays(S.period, i * 7 + 6));
      dlg.innerHTML = `<h2>${esc(e.name)} <span>usual week</span></h2>
        <p class="sc-usual">${L.validUsual(e.usual_week) ? esc(L.usualSummary(e.usual_week)) : 'No usual week saved yet.'}</p>
        <div class="sc-col-btns">
          <button class="sc-btn" data-dl="save-usual" data-w="0">Save week 1 (${esc(w(0))}) as ${esc(e.name)}'s usual</button>
          <button class="sc-btn" data-dl="save-usual" data-w="1">Save week 2 (${esc(w(1))}) as ${esc(e.name)}'s usual</button>
          <button class="sc-btn" data-dl="fill-person" ${L.validUsual(e.usual_week) ? '' : 'disabled'}>Fill ${esc(e.name)}'s empty days from the usual week</button>
          ${e.active ? `<button class="sc-btn quiet" data-dl="hide-emp">Hide ${esc(e.name)} (no longer works here)</button>` : ''}
        </div>
        <div class="sc-row-btns end"><button class="sc-btn quiet" data-dl="close">Close</button></div>`;
    }
  }

  dlg.addEventListener('input', (ev) => {
    if (!D) return;
    if (ev.target.classList.contains('sc-type-in')) {
      D.text = ev.target.value;
      const pos = ev.target.selectionStart;
      renderDialog();
      const inp = dlg.querySelector('.sc-type-in');
      inp.focus(); inp.setSelectionRange(pos, pos);
    } else if (ev.target.classList.contains('sc-note-field')) {
      D.note = ev.target.value;
      const b = dlg.querySelector('[data-dl="save-note"]');
      const row = S.cells.get(keyOf(D.id, D.k));
      if (b) b.disabled = (row?.note || '') === D.note;
    } else if (ev.target.matches('[data-keep]')) D.keep = ev.target.checked;
  });
  dlg.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.classList.contains('sc-type-in')) { ev.preventDefault(); dlg.querySelector('[data-dl="use-typed"]:not([disabled])')?.click(); }
  });
  dlg.addEventListener('click', async (ev) => {
    if (ev.target === dlg) return closeDialog(); // tap outside
    const pk = ev.target.closest('[data-pk]');
    if (pk && D?.type === 'custom') {
      const which = pk.dataset.pk;
      const word = which === 's' ? 'open' : 'close';
      const cur = D[which];
      if (pk.dataset.v) D[which] = word;
      else if (pk.dataset.h) { const m = cur && cur !== word ? L.toMinutes(cur) % 60 : 0; D[which] = L.fromMinutes(Number(pk.dataset.h) * 60 + m); }
      else if (pk.dataset.m && cur && cur !== word) D[which] = L.fromMinutes(Math.floor(L.toMinutes(cur) / 60) * 60 + Number(pk.dataset.m));
      return renderDialog();
    }
    const b = ev.target.closest('[data-dl]');
    if (!b || !D) return;
    const act = b.dataset.dl;
    if (act === 'close') return closeDialog();
    if (D.type === 'day') {
      const old = S.cells.get(keyOf(D.id, D.k)) || null;
      const put = (row) => { closeDialog(); apply([{ employee_id: D0.id, work_date: D0.k, row: row ? { ...row, note: D0.note } : null }]); };
      const D0 = D;
      if (act === 'preset') { const p = allPresets().find((x) => x.id === b.dataset.p); if (p) put(brushRow(p)); }
      else if (act === 'use-typed') {
        const r = L.parseShift(D.text);
        if (r.error) return;
        put(r.row || (D.note ? { kind: 'none', start_at: null, end_at: null } : null));
      } else if (act === 'clear-day') { closeDialog(); apply([{ employee_id: D0.id, work_date: D0.k, row: null }]); }
      else if (act === 'save-note') {
        const base = old && old.kind !== 'none' ? old : { kind: 'none', start_at: null, end_at: null };
        put(base.kind === 'none' && !D.note ? null : { kind: base.kind, start_at: base.start_at ?? null, end_at: base.end_at ?? null });
      } else if (act === 'custom') {
        openDialog({ type: 'custom', s: old?.kind === 'shift' ? old.start_at : '16:00', e: old?.kind === 'shift' ? old.end_at : 'close', keep: true, back: D0, cell: { name: D0.name, k: D0.k } });
      }
      return;
    }
    if (D.type === 'custom') {
      if (act === 'back') { if (D.back) openDialog(D.back); else closeDialog(); return; }
      if (act === 'use-custom') {
        const p = { kind: 'shift', start_at: D.s, end_at: D.e };
        const keep = D.keep && !allPresets().some((x) => L.sameShift(x, p));
        const back = D.back;
        closeDialog();
        if (keep) {
          try {
            const saved = S.missing ? null : await store.addPreset({ start_at: p.start_at, end_at: p.end_at, sort: (S.presets.length + 1) * 10 + 100 });
            if (saved) S.presets.push(saved);
          } catch (e) { setStatus('error', `The button wasn't kept: ${e.message || e}`); }
        }
        const preset = allPresets().find((x) => L.sameShift(x, p)) || { id: 'tmp', ...p };
        if (back?.type === 'day') apply([{ employee_id: back.id, work_date: back.k, row: { ...brushRow(preset), note: back.note } }]);
        else if (WIDE.matches && selBox()) fillSelection(preset);
        else { S.brush = preset; render(); }
        render();
      }
      return;
    }
    if (D.type === 'person') {
      const e = S.employees.find((x) => x.id === D.id);
      if (act === 'save-usual') {
        const w = Number(b.dataset.w);
        const usual = L.periodDays(S.period).slice(w * 7, w * 7 + 7).map((k) => L.rowToUsual(S.cells.get(keyOf(e.id, k))));
        closeDialog();
        if (S.missing) return;
        setStatus('saving', 'Saving…'); render();
        try { await store.saveUsual(e.id, usual); e.usual_week = usual; setStatus('saved', `Saved ${nowClock()} · ${e.name}'s usual week`); }
        catch (err) { setStatus('error', `Not saved: ${err.message || err}`); }
        render();
      } else if (act === 'fill-person') {
        closeDialog();
        const ch = L.fillFromUsual([e], days(), S.cells);
        if (!ch.length) { setStatus('info', `${e.name}'s days are already filled.`); render(); return; }
        apply(ch.map((c) => ({ employee_id: c.employee_id, work_date: c.work_date, row: c.row })), { label: `${e.name}: ${ch.length} days from the usual week` });
      } else if (act === 'hide-emp') {
        closeDialog();
        try { await store.setActive(e.id, false); e.active = false; setStatus('saved', `Saved ${nowClock()} · ${e.name} hidden`); }
        catch (err) { setStatus('error', `Not saved: ${err.message || err}`); }
        render();
      }
    }
  });

  // ---------- grid editing (computer) ----------
  const nRows = () => rowsModel().length;
  function moveTo(r, c, extend = false) {
    r = Math.max(0, Math.min(nRows() - 1, r));
    c = Math.max(0, Math.min(6, c));
    if (extend && S.sel) S.sel = { ...S.sel, fr: r, fc: c };
    else S.sel = { ar: r, ac: c, fr: r, fc: c };
    render();
    body.querySelector(`td[data-r="${r}"][data-c="${c}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function startTyping(text, keep = false) {
    if (!S.sel) return;
    const { fr: r, fc: c } = S.sel;
    const m = rowsModel()[r];
    const kk = keyOf(m.e.id, dateAt(r, c));
    const cur = S.bad.get(kk)?.text ?? L.cellWords(cellAt(r, c)).text;
    S.sel = { ar: r, ac: c, fr: r, fc: c };
    S.typing = { r, c, text: keep ? cur : text, error: '', fresh: true };
    render();
  }
  // returns true when it moved on (saved, or nothing to save)
  function commitTyping() {
    const t = S.typing;
    if (!t) return true;
    const m = rowsModel()[t.r];
    const k = dateAt(t.r, t.c);
    const kk = keyOf(m.e.id, k);
    const r = L.parseShift(t.text);
    if (r.error) { S.typing = { ...t, error: r.error }; render(); return false; }
    S.typing = null;
    S.bad.delete(kk);
    const old = S.cells.get(kk) || null;
    const row = r.row ? withNote(r.row, old) : (old?.note && !L.needsCheck(old) ? { kind: 'none', start_at: null, end_at: null, note: old.note } : null);
    apply([{ employee_id: m.e.id, work_date: k, row }]);
    return true;
  }
  function leaveTypingBad() { // clicked away from a cell that can't be read: keep the text, red, not saved
    const t = S.typing;
    if (!t) return;
    const r = L.parseShift(t.text);
    if (!r.error) { commitTyping(); return; }
    const m = rowsModel()[t.r];
    S.bad.set(keyOf(m.e.id, dateAt(t.r, t.c)), { text: t.text, error: r.error });
    S.typing = null;
    setStatus('error', `Not saved: ${r.error}. Click that day and fix it.`);
  }
  function selectionCells() {
    const b = selBox();
    if (!b) return [];
    const out = [];
    for (let r = b.r0; r <= b.r1; r += 1) for (let c = b.c0; c <= b.c1; c += 1) out.push({ r, c });
    return out;
  }
  function fillSelection(p) {
    const ch = selectionCells().map(({ r, c }) => {
      const m = rowsModel()[r]; const k = dateAt(r, c);
      return { employee_id: m.e.id, work_date: k, row: withNote(brushRow(p), S.cells.get(keyOf(m.e.id, k))) };
    });
    apply(ch);
  }
  function clearSelection() { fillSelection('clear'); }
  function copyText() {
    const b = selBox();
    if (!b) return '';
    const lines = [];
    for (let r = b.r0; r <= b.r1; r += 1) {
      const vals = [];
      for (let c = b.c0; c <= b.c1; c += 1) vals.push(L.cellWords(cellAt(r, c)).text);
      lines.push(vals.join('\t'));
    }
    return lines.join('\n');
  }
  function pasteText(text) {
    const b = selBox();
    if (!b) return;
    const grid = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map((l) => l.split('\t'));
    const single = grid.length === 1 && grid[0].length === 1;
    const targets = [];
    if (single) for (const { r, c } of selectionCells()) targets.push({ r, c, v: grid[0][0] });
    else grid.forEach((line, i) => line.forEach((v, j) => targets.push({ r: b.r0 + i, c: b.c0 + j, v })));
    const ch = []; let bad = 0;
    for (const { r, c, v } of targets) {
      if (r >= nRows() || c > 6) continue;
      const m = rowsModel()[r]; const k = dateAt(r, c); const kk = keyOf(m.e.id, k);
      const p = L.parseShift(v);
      if (p.error) { S.bad.set(kk, { text: v, error: p.error }); bad += 1; continue; }
      ch.push({ employee_id: m.e.id, work_date: k, row: withNote(p.row, S.cells.get(kk)) });
    }
    if (ch.length) apply(ch, { label: `pasted ${ch.length} day${ch.length === 1 ? '' : 's'}` });
    if (bad) { setStatus('error', `${bad} pasted day${bad === 1 ? '' : 's'} couldn't be read (red). Click and fix ${bad === 1 ? 'it' : 'them'}.`); render(); }
  }

  const gridKeysOn = () => S.active && S.editing && WIDE.matches && !dlg.open;
  document.addEventListener('keydown', (ev) => {
    if (!gridKeysOn()) return;
    const inCell = ev.target.classList?.contains('sc-in');
    if (!inCell && /INPUT|TEXTAREA|SELECT/.test(ev.target.tagName)) return;
    if (inCell) {
      if (ev.key === 'Escape') { ev.preventDefault(); S.typing = null; render(); return; }
      if (ev.key === 'Enter' || ev.key === 'Tab') {
        ev.preventDefault();
        const { r, c } = S.typing;
        if (!commitTyping()) return;
        if (ev.key === 'Enter') moveTo(ev.shiftKey ? r - 1 : r + 1, c);
        else if (ev.shiftKey) moveTo(c === 0 ? r - 1 : r, c === 0 ? 6 : c - 1);
        else moveTo(c === 6 ? r + 1 : r, c === 6 ? 0 : c + 1);
      }
      return;
    }
    if (!S.sel) return;
    const mod = ev.metaKey || ev.ctrlKey;
    const { fr: r, fc: c } = S.sel;
    const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (moves[ev.key] && !mod) { ev.preventDefault(); moveTo(r + moves[ev.key][0], c + moves[ev.key][1], ev.shiftKey); return; }
    if (ev.key === 'Tab') { ev.preventDefault(); if (ev.shiftKey) moveTo(c === 0 ? r - 1 : r, c === 0 ? 6 : c - 1); else moveTo(c === 6 ? r + 1 : r, c === 6 ? 0 : c + 1); return; }
    if (ev.key === 'Enter') { ev.preventDefault(); moveTo(ev.shiftKey ? r - 1 : r + 1, c); return; }
    if (ev.key === 'F2') { ev.preventDefault(); startTyping('', true); return; }
    if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); clearSelection(); return; }
    if (ev.key === 'Escape') { S.sel = null; render(); return; }
    if (mod && ev.key.toLowerCase() === 'z') { ev.preventDefault(); undoLast(); return; }
    if (!mod && !ev.altKey && ev.key.length === 1) { ev.preventDefault(); startTyping(ev.key); }
  });
  document.addEventListener('copy', (ev) => {
    if (!gridKeysOn() || !S.sel || S.typing || /INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return;
    ev.preventDefault();
    ev.clipboardData.setData('text/plain', copyText());
    setStatus('info', 'Copied. Pick where it goes and press Ctrl or Cmd + V.'); render();
  });
  document.addEventListener('paste', (ev) => {
    if (!gridKeysOn() || !S.sel || S.typing || /INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return;
    ev.preventDefault();
    pasteText(ev.clipboardData.getData('text/plain'));
  });

  function typePreview() {
    if (!S.typing) return '';
    if (S.typing.error) return `<span class="sc-err">${esc(S.typing.error)}. Fix it, or press Esc to cancel.</span>`;
    if (!S.typing.text.trim()) return 'Empty: Enter clears the day.';
    const r = L.parseShift(S.typing.text);
    return r.error ? `<span class="sc-err">${esc(r.error)}</span>` : `Enter saves: <b>${esc(r.row ? L.cellWords(r.row).text : 'empty')}</b>`;
  }
  body.addEventListener('input', (ev) => {
    if (!ev.target.classList.contains('sc-in') || !S.typing) return;
    S.typing.text = ev.target.value; S.typing.error = '';
    const out = body.querySelector('.sc-type-preview');
    if (out) out.innerHTML = typePreview();
  });
  body.addEventListener('focusout', (ev) => {
    if (!ev.target.classList.contains('sc-in') || !S.typing) return;
    // clicking another day or a button: keep what was typed (saved if it can be read, red if not)
    setTimeout(() => { if (S.typing && !body.querySelector('.sc-in:focus')) { leaveTypingBad(); render(); } }, 0);
  });

  // mouse: click, shift-click and drag to pick days (computer); taps and holds on the phone
  let drag = false; let hold = null; let held = false;
  body.addEventListener('pointerdown', (ev) => {
    const td = ev.target.closest('td[data-r]');
    if (!td || !S.editing) return;
    const r = Number(td.dataset.r); const c = Number(td.dataset.c);
    if (WIDE.matches) {
      if (ev.target.classList.contains('sc-in')) return;
      if (S.typing) leaveTypingBad();
      if (ev.shiftKey && S.sel) S.sel = { ...S.sel, fr: r, fc: c };
      else S.sel = { ar: r, ac: c, fr: r, fc: c };
      drag = true;
      ev.preventDefault();
      render();
      return;
    }
    held = false;
    const x0 = ev.clientX; const y0 = ev.clientY;
    clearTimeout(hold);
    hold = setTimeout(() => {
      held = true;
      const m = rowsModel()[r];
      if (navigator.vibrate) navigator.vibrate(15);
      apply([{ employee_id: m.e.id, work_date: dateAt(r, c), row: null }]);
    }, 550);
    const cancel = (e2) => {
      if (e2.type === 'pointermove' && Math.hypot(e2.clientX - x0, e2.clientY - y0) < 10) return;
      clearTimeout(hold);
      removeEventListener('pointermove', cancel); removeEventListener('pointerup', cancel); removeEventListener('pointercancel', cancel);
    };
    addEventListener('pointermove', cancel); addEventListener('pointerup', cancel); addEventListener('pointercancel', cancel);
  });
  body.addEventListener('pointerover', (ev) => {
    if (!drag) return;
    const td = ev.target.closest('td[data-r]');
    if (!td || !S.sel) return;
    const r = Number(td.dataset.r); const c = Number(td.dataset.c);
    if (S.sel.fr !== r || S.sel.fc !== c) { S.sel = { ...S.sel, fr: r, fc: c }; render(); }
  });
  addEventListener('pointerup', () => {
    if (drag && S.brush && WIDE.matches && S.editing) fillSelection(S.brush); // a shift button picked first: click or drag fills
    drag = false;
  });
  body.addEventListener('dblclick', (ev) => {
    if (!S.editing || !WIDE.matches || !ev.target.closest('td[data-r]')) return;
    startTyping('', true);
  });
  body.addEventListener('contextmenu', (ev) => { if (S.editing && !WIDE.matches && ev.target.closest('td[data-r]')) ev.preventDefault(); });

  body.addEventListener('submit', async (ev) => {
    const f = ev.target.closest('[data-form="add-emp"]');
    if (!f) return;
    ev.preventDefault();
    const name = f.name.value.trim().replace(/\s+/g, ' ');
    if (!name) return;
    if (S.employees.some((e) => e.name.toLowerCase() === name.toLowerCase())) { setStatus('info', `${name} is already on the list.`); render(); return; }
    try {
      const e = await store.addEmployee(name, (S.employees.length + 1) * 10);
      S.employees.push(e);
      setStatus('saved', `Saved ${nowClock()} · ${name} added`);
    } catch (err) { setStatus('error', `Not saved: ${err.message || err}`); }
    render();
  });

  async function goPeriod(start) {
    if (S.typing) leaveTypingBad();
    S.period = start; S.sel = null; S.week = weekOfToday();
    if (!S.loaded.has(start)) { body.querySelector('.sc-period-txt small')?.replaceChildren('Loading…'); }
    try { await loadPeriod(start); } catch (e) { setStatus('error', `Couldn't load that period: ${e.message || e}`); }
    render();
  }

  async function onAct(b) {
    const act = b.dataset.act;
    if (act === 'retry') { S.error = ''; ensure(); render(); }
    else if (act === 'prev') goPeriod(L.addDays(S.period, -14));
    else if (act === 'next') goPeriod(L.addDays(S.period, 14));
    else if (act === 'current') goPeriod(L.periodStartOf(T(), S.anchor));
    else if (act === 'edit') {
      if (S.typing) leaveTypingBad();
      S.editing = !S.editing; S.brush = null; S.sel = null;
      if (!S.editing && S.status?.kind !== 'error') S.status = null;
      render();
    } else if (act === 'print') doPrint();
    else if (act === 'week') { S.week = Number(b.dataset.w); render(); }
    else if (act === 'list') { S.list = b.dataset.l; try { localStorage.setItem('canam.schedList', S.list); } catch { /* private mode */ } render(); }
    else if (act === 'undo') undoLast();
    else if (act === 'brush') {
      const p = b.dataset.p === 'clear' ? 'clear' : allPresets().find((x) => x.id === b.dataset.p);
      if (!p) return;
      if (WIDE.matches && selBox() && !S.brush) { fillSelection(p); return; }
      S.brush = S.brush && (S.brush === p || (p !== 'clear' && S.brush !== 'clear' && L.sameShift(S.brush, p))) ? null : p;
      render();
    } else if (act === 'del-preset') {
      const p = S.presets.find((x) => x.id === b.dataset.p);
      if (!p) return;
      try {
        await store.removePreset(p.id);
        S.presets = S.presets.filter((x) => x.id !== p.id);
        if (S.brush && S.brush.id === p.id) S.brush = null;
        setStatus('saved', `Saved ${nowClock()} · removed the ${L.presetText({ kind: 'shift', ...p })} button`);
      } catch (e) { setStatus('error', `Not saved: ${e.message || e}`); }
      render();
    } else if (act === 'custom') openDialog({ type: 'custom', s: '16:00', e: 'close', keep: true });
    else if (act === 'fill-usual') {
      const ch = L.fillFromUsual(S.employees.filter((e) => e.active), days(), S.cells);
      if (!ch.length) { setStatus('info', 'Nothing to fill: the empty days have no usual shift.'); render(); return; }
      apply(ch.map((c) => ({ employee_id: c.employee_id, work_date: c.work_date, row: c.row })), { label: `${ch.length} days from usual weeks` });
    } else if (act === 'copy-last') {
      const prev = L.addDays(S.period, -14);
      try { await loadPeriod(prev); } catch (e) { setStatus('error', `Couldn't read the last period: ${e.message || e}`); render(); return; }
      const prevRows = [...S.cells.values()].filter((r) => r.work_date >= prev && r.work_date < S.period);
      const ch = L.copyPeriod(S.employees.filter((e) => e.active), prevRows, S.cells);
      if (!ch.length) { setStatus('info', prevRows.length ? 'Nothing to copy: those days are already filled.' : 'The last period is empty.'); render(); return; }
      apply(ch.map((c) => ({ employee_id: c.employee_id, work_date: c.work_date, row: c.row })), { label: `${ch.length} days copied from ${L.rangeLabel(prev, L.addDays(prev, 13))}` });
    } else if (act === 'show-emp') {
      const e = S.employees.find((x) => x.id === b.dataset.id);
      try { await store.setActive(e.id, true); e.active = true; } catch (err) { setStatus('error', `Not saved: ${err.message || err}`); }
      render();
    }
  }
  const onClick = (ev) => {
    const b = ev.target.closest('[data-act]');
    if (b && !b.disabled) { onAct(b); return; }
    const name = ev.target.closest('[data-emp]');
    if (name && S.editing) { openDialog({ type: 'person', id: name.dataset.emp }); return; }
    const td = ev.target.closest('td[data-r]');
    if (td && S.editing && !WIDE.matches) {
      if (held) { held = false; return; }
      const r = Number(td.dataset.r); const c = Number(td.dataset.c);
      const m = rowsModel()[r]; const k = dateAt(r, c);
      const old = S.cells.get(keyOf(m.e.id, k)) || null;
      if (S.brush) { apply([{ employee_id: m.e.id, work_date: k, row: withNote(brushRow(S.brush), old) }]); return; }
      openDialog({ type: 'day', id: m.e.id, name: m.e.name, k, text: '', note: old?.note || '' });
    }
  };
  body.addEventListener('click', onClick);
  bar.addEventListener('click', onClick);
  WIDE.addEventListener('change', () => { S.typing = null; S.sel = null; render(); });

  // ---------- the tab button (dashboard.js runs Sales and Dough; finance.js runs Finances) ----------
  function show(on, save = true) {
    S.active = on;
    document.body.classList.toggle('tab-schedule', on);
    if (!on) { tabBtn.setAttribute('aria-pressed', 'false'); document.body.classList.remove('sc-editing'); return; }
    for (const b of document.querySelectorAll('#views button')) b.setAttribute('aria-pressed', b === tabBtn ? 'true' : 'false');
    document.getElementById('brandTitle').textContent = 'Lakewood schedule';
    document.title = 'Can Am Schedule';
    if (save) {
      try { localStorage.setItem('canam.tab', 'schedule'); } catch { /* private mode */ }
      history.replaceState(history.state, '', '#schedule');
    }
    if (S.ready && L.periodStartOf(T(), S.anchor) !== S.period && !S.editing) { /* keep the period the owner was looking at */ }
    render();
    ensure();
  }
  document.getElementById('views').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    show(b === tabBtn);
    if (b === tabBtn) scrollTo(0, 0);
  });
  addEventListener('hashchange', () => show(location.hash === '#schedule', false));
  let saved = '';
  try { saved = localStorage.getItem('canam.tab') || ''; } catch { /* private mode */ }
  if (location.hash === '#schedule' || (!location.hash && saved === 'schedule')) show(true, false);

  // for checking by hand: the state behind the page
  globalThis.canamSchedule = { state: S, parse: L.parseShift, render };
}
