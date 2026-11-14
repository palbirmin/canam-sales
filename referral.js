// Referral cards page (version 1.14.0; counter tablet 1.16.0; required names, review, two-tap confirm, Fix 1.16.1;
// people lookup as you type 1.20.0; Can Am navy, red and yellow look 1.21.0; staff drop cards in the box and the
// owner enters them later with the date turned in 1.23.0): phone/referral.html. Built for the tablet at the
// counter, one task per screen: Home (two big buttons), Card turned in, Check a phone, Hotels, and More (hand-out
// log, Owner.com list, today's entries with Undo, sign out). Owner and employee logins (the same sign-in as the
// phone page). The rules are in referral-logic.js and checked again by the database (supabase_referral.sql,
// supabase_referral_tiers.sql). Screens are in-page with the address's #hash, so Back works; a reload goes Home.
// ?demo=1 on this computer (localhost) shows made-up people and needs no sign-in (referral-demo.js);
// ?demo=1 acts as the owner, ?demo=1&staff=1 as an employee (1.23.0). ?c=0042 opens Card turned in with that card
// number filled in (owner only: since 1.23.0 employees never reach that form, see screenFor in referral-logic.js).
import { CONFIG } from './config.js';
import { todayKey, dayKeyOf } from './lib.js';
import { makeSupa, AuthError } from './supa.js';
import { loginEmail, loginLabel } from './login-name.js';
import {
  normalizePhone, formatPhone, typingPhone, parseCard, cardLabel, isDay, shortDay, redeemCheck, handoutCheck,
  cardStatus, MAX_CARD, LUNCH_EVERY, turnedInMsg, phoneSummary, completesPizza, hotelLine, lunchState, canUndo,
  rewardName, validateTurnIn, validateHandout, checkName, fullName, digitsOnly, tapState, CONFIRM_MS, turnInPrefill,
  handoutPrefill as handoutFill, matchPeople, personLabel, splitName, checkTurnInDay, turnInDayRange, longDay,
  screenFor, savedText,
} from './referral-logic.js';
import { makeReferralStore, missingTables } from './referral-data.js';

const VERSION = '1.23.0';
const P = CONFIG.phone;
const PARAMS = new URLSearchParams(location.search);
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const DEMO = PARAMS.get('demo') === '1' && LOCAL;
const SESSION_KEY = 'canam.session'; // the same sign-in as the phone page
const KEEP_ALIVE_MS = 30 * 60 * 1000; // the tablet stays open for days: renew the sign-in every 30 minutes

let memory = null;
const supa = makeSupa({
  url: P.supabaseUrl,
  key: P.publishableKey,
  load: async () => {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || memory; } catch { return memory; }
  },
  save: async (s) => {
    memory = s;
    try { if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s)); else localStorage.removeItem(SESSION_KEY); } catch { /* memory only */ }
  },
});

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => todayKey();
const errText = (e) => (missingTables(e)
  ? 'This part isn\'t set up in the database yet. The owner needs to run supabase_referral_tiers.sql.'
  : (e?.message || String(e)));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const nameAndPhone = (name, phone) => [name, formatPhone(phone)].filter(Boolean).join(', ');
const dayOf = (row) => row.created_on || (row.created_at ? dayKeyOf(Date.parse(row.created_at)) : '');

let store = null;
let me = { id: null }; // the signed-in login
let isOwner = false;
let myName = '';
let started = false;

// ---------- sign-in (the same logins as the phone page) ----------
let retryTimer = null;
function showLogin(message = '', retry = false) {
  document.body.classList.add('locked');
  $('loginForm').hidden = retry;
  $('loginRetry').hidden = !retry;
  $('loginMsg').textContent = message;
  clearTimeout(retryTimer);
  // no connection (the tablet's Wi-Fi dropped): keep trying by itself
  if (retry) retryTimer = setTimeout(boot, 20 * 1000);
}
// A signed-out error (the sign-in ran out and couldn't be renewed): back to the sign-in screen.
function authLost(e) {
  if (e instanceof AuthError && e.signedOut) { showLogin('Please sign in again.'); return true; }
  return false;
}

// Owner (dashboard_users) or employee (staff_users). Any other login gets nothing from the database anyway.
async function checkAccess() {
  if ((await supa.rest('GET', 'dashboard_users?select=user_id')).length) return { owner: true, name: 'Owner' };
  const [me1] = await supa.rest('GET', 'staff_users?select=user_id,name');
  if (me1) return { owner: false, name: me1.name || loginLabel((await supa.session())?.email) };
  await supa.signOut();
  const e = new AuthError("This login doesn't have access. Ask the owner.", true);
  e.noAccess = true;
  throw e;
}

async function open() {
  const { owner, name } = await checkAccess(); // renews an expired sign-in first (supa.js)
  store = makeReferralStore(supa);
  me = await store.whoAmI();
  isOwner = owner;
  myName = name;
  // back to the main page: employees only have the Dough tab there (version 1.14.1)
  if (!owner) { $('backLink').textContent = 'Dough'; $('backLink').href = './#dough'; }
  start();
}

async function boot() {
  clearTimeout(retryTimer);
  if (DEMO) {
    const owner = PARAMS.get('staff') !== '1'; // 1.23.0: the owner unless &staff=1
    store = (await import('./referral-demo.js')).makeDemoStore(today(), { owner });
    await store.ready;
    me = await store.whoAmI();
    isOwner = owner;
    myName = owner ? 'Owner (demo)' : 'Demo';
    $('demoBanner').hidden = false;
    return start();
  }
  if (!(await supa.session())) return showLogin();
  $('loginMsg').textContent = 'Loading…';
  try {
    await open();
  } catch (e) {
    if (e instanceof AuthError && e.signedOut) showLogin(e.noAccess ? e.message : 'Please sign in again.');
    else showLogin("Couldn't reach the server. Check the internet connection. Trying again by itself…", true);
  }
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = loginEmail($('loginEmail').value);
  const pw = $('loginPassword');
  if (!email) { showLogin('Type your phone number (like 253-555-0100) or your email.'); return; }
  $('loginBtn').disabled = true;
  $('loginMsg').textContent = 'Signing in…';
  try {
    await supa.signIn(email, pw.value);
    pw.value = '';
    await open();
  } catch (err) {
    showLogin(err instanceof AuthError ? err.message : "Couldn't reach the server. Check the internet connection and try again.");
  } finally {
    $('loginBtn').disabled = false;
  }
});
$('loginRetry').addEventListener('click', boot);
window.addEventListener('online', () => { if (!$('loginRetry').hidden && document.body.classList.contains('locked')) boot(); });
$('loginEmail').addEventListener('input', (e) => {
  $('loginPassword').inputMode = /^[\d\s()+.-]+$/.test(e.target.value.trim()) ? 'numeric' : 'text';
});
$('loginShow').addEventListener('click', () => {
  const pw = $('loginPassword');
  const show = pw.type === 'password';
  pw.type = show ? 'text' : 'password';
  $('loginShow').textContent = show ? 'Hide' : 'Show';
});
$('signOut').addEventListener('click', async () => {
  if (store?.demo) { location.reload(); return; }
  await supa.signOut();
  location.replace(location.pathname);
});

// ---------- screens ----------
// Each screen is a <section data-scr>. go() adds a step to the browser's history (#turnin...), so the
// tablet's own Back works too; the big Back button goes up one step. A reload always starts at Home.
const PARENT = { home: null, turnin: 'home', review: 'turnin', check: 'home', hotels: 'home', more: 'home', done: 'home', handout: 'more', ownercom: 'more' };
let current = 'home';
const onShow = {};
function show(scr, fresh) {
  if (!(scr in PARENT)) scr = 'home';
  // 1.23.0: employees never see the turned-in form (a deep link, Back/Forward, Fix): Home instead
  const allowed = screenFor(scr, isOwner);
  if (allowed !== scr) {
    scr = allowed;
    history.replaceState({ scr, depth: history.state?.depth || 0 }, '', `#${scr}`);
  }
  current = scr;
  let title = '';
  let noBack = false;
  for (const s of document.querySelectorAll('main.ref .scr')) {
    s.hidden = s.dataset.scr !== scr;
    if (!s.hidden) { title = s.dataset.title || ''; noBack = s.hasAttribute('data-noback'); }
  }
  // 1.21.0: the screen's title and Back sit in the top bar (Home and Saved show the logo bar)
  document.body.classList.toggle('sub', !!title);
  $('barTitle').textContent = title;
  $('barBack').hidden = !title || noBack;
  document.body.dataset.scr = scr;
  window.scrollTo(0, 0);
  onShow[scr]?.(fresh);
}
// fresh: false keeps what's typed in the screen's boxes (Change on the review screen, Undo, Fix)
function go(scr, { replace = false, fresh = true } = {}) {
  scr = screenFor(scr, isOwner);
  const depth = (history.state?.depth || 0) + (replace ? 0 : 1);
  const st = { scr, depth };
  if (replace) history.replaceState(st, '', `#${scr}`); else history.pushState(st, '', `#${scr}`);
  show(scr, fresh);
}
function back() {
  if ((history.state?.depth || 0) > 0) history.back();
  else go(PARENT[current] || 'home', { replace: true });
}
window.addEventListener('popstate', (e) => show(e.state?.scr || 'home', false));
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-go]');
  if (b) { go(b.dataset.go); return; }
  if (e.target.closest('[data-back]')) back();
});

// ---------- small helpers ----------
function debounce(fn, ms = 250) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
// Phone boxes format themselves while typing: 2535550100 -> (253) 555-0100. Anything but digits is dropped
// (1.16.1); typing in the middle keeps the digits and the brackets as they are. names: true (Check a phone,
// 1.20.0) leaves a box with letters in it as typed, since a name can be looked up there too.
function phoneBox(input, { names = false } = {}) {
  input.addEventListener('input', () => {
    if (names && /\p{L}/u.test(input.value)) return;
    const at = input.selectionStart === input.value.length;
    const v = at ? typingPhone(input.value) : input.value.replace(/[^\d() -]/g, '');
    if (v !== input.value) input.value = v;
  });
}
// Card number boxes take digits only (1.16.1).
function digitBox(input, max = 4) {
  input.addEventListener('input', () => {
    const v = digitsOnly(input.value, max);
    if (v !== input.value) input.value = v;
  });
}
// The plain-word check under each box (1.16.1), shown once the box has been used (or after a Save attempt).
const FIELDS = ['card', 'day', 'phone', 'first', 'last']; // day: Date turned in (1.23.0)
const cap = (k) => k[0].toUpperCase() + k.slice(1);
function showFieldMsgs(prefix, v, touched) {
  for (const k of Object.keys(v.fields)) {
    const el = $(`${prefix}${cap(k)}Err`);
    const input = $(`${prefix}${cap(k)}`);
    if (!el || !input) continue;
    const msg = touched.has(k) ? v.fields[k].msg : '';
    el.textContent = msg;
    if (msg && v.fields[k].block !== false) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
  }
}
function trackTouched(prefix, state, redraw) { // state.touched: the boxes used so far (a Set, replaced on reset)
  for (const k of FIELDS) {
    const input = $(`${prefix}${cap(k)}`);
    if (input) input.addEventListener('blur', () => { state.touched.add(k); redraw(); });
  }
}
// Two-tap buttons (1.16.1: Given, Delivered): the first tap turns the button into "Tap again to confirm" with a
// Cancel beside it, back to normal by itself after 6 seconds. Returns true on the second tap.
function disarm(btn) {
  clearTimeout(Number(btn.dataset.timer));
  if (btn.dataset.label) btn.textContent = btn.dataset.label;
  for (const k of ['armed', 'label', 'timer']) delete btn.dataset[k];
  btn.classList.remove('sure');
  const c = btn.nextElementSibling;
  if (c?.matches('[data-cancel]')) c.remove();
}
function confirmTap(btn, ask = 'Tap again to confirm', cancel = true) {
  if (tapState(Number(btn.dataset.armed || 0), Date.now()) === 'armed') { disarm(btn); return true; }
  disarm(btn);
  btn.dataset.armed = String(Date.now());
  btn.dataset.label = btn.textContent;
  btn.textContent = ask;
  btn.classList.add('sure');
  if (cancel) btn.insertAdjacentHTML('afterend', '<button type="button" class="go ghost cancel" data-cancel>Cancel</button>');
  btn.dataset.timer = String(setTimeout(() => { if (btn.isConnected && !btn.dataset.busy) disarm(btn); }, CONFIRM_MS));
  return false;
}
document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-cancel]');
  const armed = c?.previousElementSibling;
  if (armed?.dataset.armed) disarm(armed);
});
// The focused box scrolls into view above the on-screen keyboard and the sticky Save bar (1.16.1).
document.addEventListener('focusin', (e) => {
  const el = e.target;
  if (!el.matches?.('main.ref input, main.ref textarea')) return;
  setTimeout(() => { if (document.activeElement === el) el.scrollIntoView({ block: 'nearest' }); }, 300);
});
// the keyboard opening shrinks the window (interactive-widget=resizes-content): keep the box being typed in on screen
window.addEventListener('resize', () => {
  const el = document.activeElement;
  if (el?.matches?.('main.ref input, main.ref textarea')) el.scrollIntoView({ block: 'nearest' });
});
function setMsg(el, text, kind = '') { el.textContent = text; el.className = `msg ${kind}`; }
const alertBox = (kind, html) => `<div class="alert ${kind}"><span class="ico" aria-hidden="true">!</span><div class="msg">${html}</div></div>`;
// A date box: never after today; keeps the last date used, since a page of the log is usually one day.
function dateBox(input) {
  input.max = today();
  if (!input.value) input.value = today();
}
function readDate(input, msgEl) {
  const d = input.value;
  if (!isDay(d)) { setMsg(msgEl, 'Pick the date.', 'err'); input.focus(); return null; }
  if (d > today()) { setMsg(msgEl, 'The date can\'t be in the future.', 'err'); input.focus(); return null; }
  return d;
}
function showSetup(e) { if (missingTables(e)) $('setupBanner').hidden = false; }
// a button that saves: nothing happens on a second tap while it's saving
async function busy(btn, text, fn) {
  if (btn.dataset.busy) return;
  btn.dataset.busy = '1';
  const was = btn.textContent;
  btn.disabled = true;
  if (text) btn.textContent = text;
  try { await fn(); } finally {
    delete btn.dataset.busy;
    if (btn.isConnected) { btn.disabled = false; if (text && btn.textContent === text) btn.textContent = was; }
  }
}

// ---------- people lookup as you type (1.20.0) ----------
// Every name and phone on file, loaded once after sign-in (store.peopleIndex), kept in memory and filtered on
// each key press, so the matches show at once with no call per key. Loaded again after any save or undo on
// this page and when the page comes back after a few minutes. If it can't load, the boxes work as before.
let people = null;
let peopleAt = 0;
let peopleBusy = null;
let peopleAgain = false;
const PEOPLE_STALE_MS = 3 * 60 * 1000;
const suggests = [];
function loadPeople() {
  if (!store?.peopleIndex) return;
  if (peopleBusy) { peopleAgain = true; return; }
  peopleBusy = store.peopleIndex()
    .then((rows) => { people = rows; peopleAt = Date.now(); for (const x of suggests) x.redraw(); })
    .catch(() => { /* no matches shown; typing works as before */ })
    .finally(() => { peopleBusy = null; if (peopleAgain) { peopleAgain = false; loadPeople(); } });
}
// After a save or undo through the store, the lookup is loaded again (once, however many saves).
function refreshPeopleAfterSaves(st) {
  if (st.peopleWrapped) return;
  st.peopleWrapped = true;
  for (const k of ['saveHandout', 'saveBatch', 'savePersonalBatch', 'saveRedemption', 'giveReward', 'undo', 'deliverLunch']) {
    const f = st[k];
    if (typeof f !== 'function') continue;
    st[k] = async (...a) => { const r = await f.apply(st, a); loadPeople(); return r; };
  }
}
const marked = (parts) => parts.map((x) => (x.hit ? `<mark>${esc(x.text)}</mark>` : esc(x.text))).join('');
// The list right under a phone box: name in bold, the phone with the typed part marked, a small label.
// pick(entry) runs on a tap (or Enter after arrowing onto a row); filter(entry) leaves some people out;
// title = a line over the rows; kind = a CSS class ('warn' on Card turned in).
function suggestBox(input, { pick, filter = null, title = '', kind = '' }) {
  let anchor = input.parentElement;
  if (!anchor.classList.contains('sugg-anchor')) {
    anchor = document.createElement('span');
    anchor.className = 'sugg-anchor';
    input.before(anchor);
    anchor.append(input);
  }
  const list = document.createElement('ul');
  list.className = `sugg ${kind}`.trim();
  list.id = `${input.id}Sugg`;
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  // 1.21.0: no match after 2 or more characters = one quiet line under the box (Look up / Save work as before)
  const none = document.createElement('p');
  none.className = 'sugg-none';
  none.hidden = true;
  anchor.append(list, none);
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  let rows = [];
  let active = -1;
  function hide() {
    list.hidden = true;
    none.hidden = true;
    rows = [];
    active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    document.body.classList.toggle('sugg-open', suggests.some((x) => x.open()));
  }
  // 1.21.0: the list sits in the page under its box, at most 4 whole rows: rows that would end under the
  // on-screen keyboard are left off (never a cut-off row or a scrollbar); with too little room the box moves up first
  function fit(first) {
    const vv = window.visualViewport;
    const bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
    if (first && list.getBoundingClientRect().bottom > bottom - 8) anchor.scrollIntoView({ block: 'start' });
    const items = [...list.querySelectorAll('.sugg-row')];
    while (items.length > 1 && items[items.length - 1].getBoundingClientRect().bottom > bottom - 8) items.pop().remove();
    rows = rows.slice(0, items.length);
    if (active >= rows.length) active = -1;
  }
  function redraw() {
    if (document.activeElement !== input || !people) { hide(); return; }
    rows = matchPeople(filter ? people.filter(filter) : people, input.value, 4);
    if (!rows.length) {
      hide();
      const typed = input.value.replace(/[^\p{L}\d]/gu, '');
      if (typed.length >= 2) {
        none.textContent = /\p{L}/u.test(typed) ? 'No one on file with that name yet.' : 'No one on file with that number yet.';
        none.hidden = false;
      }
      return;
    }
    none.hidden = true;
    if (active >= rows.length) active = rows.length - 1;
    const was = list.hidden;
    list.innerHTML = (title ? `<li class="sugg-title" role="presentation">${esc(title)}</li>` : '')
      + rows.map((r, i) => `<li role="option" id="${list.id}${i}" class="sugg-row${i === active ? ' on' : ''}" data-i="${i}" aria-selected="${i === active}">
        <span class="sugg-who"><span class="sugg-name">${r.entry.name ? marked(r.nameParts) : '<span class="soft">No name on file</span>'}</span>
        <span class="sugg-tag">${esc(personLabel(r.entry))}</span></span>
        <span class="sugg-phone">${marked(r.phoneParts)}</span></li>`).join('');
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    document.body.classList.add('sugg-open');
    fit(was);
    if (active >= 0) input.setAttribute('aria-activedescendant', `${list.id}${active}`); else input.removeAttribute('aria-activedescendant');
  }
  function choose(i) {
    const r = rows[i];
    if (!r) return;
    hide();
    pick(r.entry);
  }
  // a tap on a row keeps the box focused (no keyboard flicker) and doesn't count as a tap on the label
  list.addEventListener('pointerdown', (e) => e.preventDefault());
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    e.preventDefault();
    const li = e.target.closest('[data-i]');
    if (li) choose(Number(li.dataset.i));
  });
  input.addEventListener('input', () => { active = -1; redraw(); });
  input.addEventListener('focus', () => { active = -1; redraw(); });
  input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) hide(); }, 150));
  // before the box's own keys (Enter moves on or looks up): Enter picks a row only when one was arrowed onto
  anchor.addEventListener('keydown', (e) => {
    if (e.target !== input || list.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = rows.length;
      active = e.key === 'ArrowDown' ? (active + 1) % n : active <= 0 ? n - 1 : active - 1;
      redraw();
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      e.stopPropagation();
      choose(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hide();
    }
  }, true);
  window.visualViewport?.addEventListener('resize', () => { if (!list.hidden) redraw(); });
  const box = { redraw, hide, open: () => !list.hidden };
  suggests.push(box);
  return box;
}

// ---------- Home ----------
async function drawHome() {
  $('whoLine').textContent = `Signed in: ${myName}`;
  try {
    const n = await store.todayCount(today());
    $('todayLine').textContent = `Today: ${plural(n, 'card', 'cards')} turned in`;
  } catch (e) {
    if (!authLost(e)) $('todayLine').textContent = '';
  }
}
onShow.home = () => drawHome();

// ---------- Card turned in ----------
const T = { n: null, info: null, p: null, hist: null, noteOpen: false, saving: false, touched: new Set() };
// "Date turned in" (1.23.0): today back to 14 days ago, today by default. keepDay: Next card keeps the day just used.
function dayLimits() {
  const { min, max } = turnInDayRange(today());
  Object.assign($('tDay'), { min, max });
}
function turnReset(keepDay = '') {
  for (const id of ['tCard', 'tPhone', 'tFirst', 'tLast', 'tNote']) $(id).value = '';
  dayLimits();
  $('tDay').value = keepDay && !checkTurnInDay(keepDay, today()) ? keepDay : today();
  Object.assign(T, { n: null, info: null, p: null, hist: null, noteOpen: false, touched: new Set() });
  setMsg($('tMsg'), '');
  turnDraw();
}
// back into the form with what was typed (Undo on the saved screen, Fix in the Today list)
function turnFill(v) {
  $('tCard').value = v.card;
  $('tPhone').value = v.phone;
  $('tFirst').value = v.first;
  $('tLast').value = v.last;
  $('tNote').value = v.note || '';
  dayLimits();
  if (v.day) $('tDay').value = v.day;
  Object.assign(T, { n: null, info: null, p: null, hist: null, noteOpen: !!v.note, touched: new Set(FIELDS) });
  turnDraw();
  turnCardLookup();
  turnPhoneLookup();
}
const turnValues = () => ({ card: $('tCard').value, phone: $('tPhone').value, first: $('tFirst').value, last: $('tLast').value, day: $('tDay').value, today: today() });
// the day the checks use: the date picked, or today while the picked one isn't allowed
const turnDay = () => (checkTurnInDay($('tDay').value, today()) ? today() : $('tDay').value);
function knowHtml(n, info, onDay) {
  const st = cardStatus(info, onDay);
  const c = info.card;
  const lines = [];
  if (st.kind === 'person') {
    lines.push(`Card <b>${cardLabel(n)}</b>, given to <b>${esc(c.referrer_name || formatPhone(c.referrer_phone))}</b> on ${shortDay(c.given_on)}`);
  } else if (st.kind === 'hotel') {
    lines.push(`Card <b>${cardLabel(n)}</b>, hotel batch <b>${esc(st.hotel)}</b> <span class="soft">(10% off only, no breadsticks)</span>`);
  } // not in the hand-out log: said under the card box (1.16.1)
  if (st.expiresOn && !st.redeemed) {
    lines.push(st.expired ? `<span class="bad">Expired ${shortDay(st.expiresOn)}</span> (good for 60 days)`
      : `<span class="ok">Good until ${shortDay(st.expiresOn)}</span>`);
  }
  return lines.map((l) => `<span class="line">${l}</span>`).join('');
}
function turnDraw() {
  const n = parseCard($('tCard').value);
  const p = normalizePhone($('tPhone').value);
  const info = T.n === n ? T.info : null;
  const hist = p && T.p === p ? T.hist : null;
  if ($('tCard').value.trim()) T.touched.add('card');
  T.touched.add('day'); // the date box is always filled in, so its check shows at once
  const v = validateTurnIn({ ...turnValues(), info });
  const onDay = turnDay();
  showFieldMsgs('t', v, T.touched);
  const box = $('tInfo');
  box.className = 'know';
  if (!n) box.innerHTML = '';
  else if (!info) box.innerHTML = '<span class="line soft">Checking the card…</span>';
  else box.innerHTML = knowHtml(n, info, onDay);
  const save = $('tSave');
  if (!n || !info) {
    $('tWarn').innerHTML = '';
    $('tNoteWrap').hidden = true;
    save.disabled = true;
    save.textContent = 'Save';
    return null;
  }
  const chk = redeemCheck({ cardNo: n, info, phone: p, history: hist, onDay });
  const soft = chk.soft.length && !chk.hard.length;
  // "already turned in" is said under the card box; the other hard stops get a red note here
  $('tWarn').innerHTML = chk.hard.filter((x) => x.code !== 'already_redeemed').map((x) => alertBox('critical', esc(x.msg))).join('')
    + (soft ? alertBox('warning', chk.soft.map((x) => `<span class="line">${esc(x.msg)}</span>`).join('')
      + (T.noteOpen ? '' : '<button type="button" class="go warn-go" id="tAnyway">Save anyway, with a note</button>')) : '');
  $('tNoteWrap').hidden = !(soft && T.noteOpen);
  // Save stays off until the card, the phone and both names are right (1.16.1)
  save.disabled = T.saving || !!chk.hard.length || !v.ok;
  save.textContent = T.saving ? 'Checking…' : soft && T.noteOpen ? 'Save anyway' : 'Save';
  return chk;
}
const turnCardLookup = debounce(async () => {
  const n = parseCard($('tCard').value);
  if (!n) { turnDraw(); return; }
  try {
    const info = await store.cardInfo(n);
    if (parseCard($('tCard').value) === n) { Object.assign(T, { n, info }); turnDraw(); }
  } catch (e) {
    if (!authLost(e)) { $('tInfo').className = 'know bad'; $('tInfo').textContent = errText(e); }
  }
}, 200);
const turnPhoneLookup = debounce(async () => {
  const p = normalizePhone($('tPhone').value);
  if (!p) { turnDraw(); return; }
  try {
    const hist = await store.phoneHistory(p);
    if (normalizePhone($('tPhone').value) === p) { Object.assign(T, { p, hist }); turnDraw(); }
  } catch (e) { authLost(e); /* checked again on save */ }
}, 200);
digitBox($('tCard'));
$('tCard').addEventListener('input', () => { T.noteOpen = false; setMsg($('tMsg'), ''); turnDraw(); turnCardLookup(); });
$('tPhone').addEventListener('input', () => { setMsg($('tMsg'), ''); turnDraw(); turnPhoneLookup(); });
for (const id of ['tFirst', 'tLast']) $(id).addEventListener('input', () => { setMsg($('tMsg'), ''); turnDraw(); });
for (const ev of ['input', 'change']) $('tDay').addEventListener(ev, () => { T.noteOpen = false; setMsg($('tMsg'), ''); turnDraw(); });
trackTouched('t', T, () => turnDraw());
$('tWarn').addEventListener('click', (e) => {
  if (!e.target.closest('#tAnyway')) return;
  T.noteOpen = true;
  turnDraw();
  $('tNote').focus();
});
// Enter in the card box moves on to the phone, not save
$('tCard').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('tPhone').focus(); } });
$('tPhone').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('tFirst').focus(); } });
$('tFirst').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('tLast').focus(); } });

$('turnForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (T.saving) return; // a second tap while saving does nothing
  const msg = $('tMsg');
  const v = validateTurnIn({ ...turnValues(), info: T.n === parseCard($('tCard').value) ? T.info : null });
  const bad = FIELDS.find((k) => v.fields[k]?.block);
  if (bad) {
    T.touched = new Set(FIELDS);
    turnDraw();
    $(`t${cap(bad)}`).focus();
    return;
  }
  const { n, p: phone, name, day } = v;
  T.saving = true;
  turnDraw();
  setMsg(msg, '');
  try {
    // check again with fresh numbers before saving (another tablet may have saved it meanwhile)
    const [info, hist] = await Promise.all([store.cardInfo(n), store.phoneHistory(phone)]);
    Object.assign(T, { n, info, p: phone, hist });
    const chk = turnDraw();
    if (chk.hard.length) { setMsg(msg, 'Not saved. See the red note above.', 'err'); return; }
    if (chk.soft.length && !T.noteOpen) { setMsg(msg, 'Not saved yet. Read the yellow note, then tap Save anyway, with a note.', 'err'); return; }
    const note = $('tNote').value.trim();
    if (chk.soft.length && !note) { setMsg(msg, 'Write a short note on why it\'s OK to go ahead.', 'err'); $('tNote').focus(); return; }
    // nothing is saved yet: the review screen first, and only Confirm saves (1.16.1)
    showReview({ n, info, chk, phone, name, day, note: chk.soft.length ? note : '' });
  } catch (err) {
    if (authLost(err)) return;
    if (/already redeemed|duplicate key/i.test(err.message || '')) {
      // someone else turned it in meanwhile: say so plainly
      const info = await store.cardInfo(n).catch(() => null);
      if (info?.redemption) {
        Object.assign(T, { n, info });
        setMsg(msg, turnedInMsg(n, info.redemption), 'err');
        return;
      }
    }
    showSetup(err);
    setMsg(msg, `Not saved: ${errText(err)}`, 'err');
  } finally {
    T.saving = false;
    turnDraw();
  }
});
let nextDay = ''; // Next card (1.23.0): the day to keep for the next blank form
onShow.turnin = (fresh) => {
  if (!fresh) return; // back from Change, Undo or Fix: everything stays as typed, no keyboard
  turnReset(nextDay);
  nextDay = '';
  setTimeout(() => $('tCard').focus(), 50);
};

// ---------- Review before saving (1.16.1) ----------
let R = null; // what Confirm saves: { n, info, chk, phone, name, day, note }
function showReview(r) {
  R = r;
  const st = r.chk.status;
  const c = r.info.card;
  $('rvCard').textContent = cardLabel(r.n);
  $('rvFrom').textContent = st.kind === 'person' ? nameAndPhone(c.referrer_name, c.referrer_phone)
    : st.kind === 'hotel' ? `${st.hotel} (hotel batch)` : 'Not logged as handed out';
  $('rvDay').textContent = longDay(r.day);
  $('rvName').textContent = r.name;
  $('rvPhone').textContent = formatPhone(r.phone);
  $('rvWarn').innerHTML = r.chk.soft.length
    ? alertBox('warning', r.chk.soft.map((x) => `<span class="line">${esc(x.msg)}</span>`).join('')
      + `<span class="line rv-note">Note: <b>${esc(r.note)}</b></span>`) : '';
  setMsg($('rvMsg'), '');
  go('review', { replace: true });
}
$('rvChange').addEventListener('click', () => go('turnin', { replace: true, fresh: false }));
$('rvConfirm').addEventListener('click', () => busy($('rvConfirm'), 'Saving…', async () => {
  if (!R) return;
  const { n, info, chk, phone, name, day, note } = R;
  try {
    await store.saveRedemption({ card_no: n, new_name: name, new_phone: phone, redeemed_on: day, override_note: note });
    R = null;
    await showDone({ n, info, chk, phone, name, day, note });
  } catch (err) {
    if (authLost(err)) return;
    if (/already redeemed|duplicate key/i.test(err.message || '')) {
      // someone else turned it in meanwhile: back to the form, which says so under the card box
      const fresh = await store.cardInfo(n).catch(() => null);
      if (fresh?.redemption) {
        Object.assign(T, { n, info: fresh });
        go('turnin', { replace: true, fresh: false });
        turnDraw();
        setMsg($('tMsg'), turnedInMsg(n, fresh.redemption), 'err');
        return;
      }
    }
    showSetup(err);
    setMsg($('rvMsg'), `Not saved: ${errText(err)}`, 'err');
  }
}));
onShow.review = () => {
  if (!R) { go('turnin', { replace: true, fresh: false }); return; }
  setTimeout(() => $('rvConfirm').focus({ preventScroll: true }), 50);
};

// ---------- Saved ----------
const D = { n: null, phone: '', name: '', day: '', note: '' };
async function showDone({ n, info, chk, phone, name, day, note = '' }) {
  Object.assign(D, { n, phone, name, day, note });
  const st = chk.status;
  const c = info.card;
  $('doneBox').className = 'done-box';
  // 1.23.0: a card from the box (an earlier day) only says Saved and the date; the 10% was given then
  const txt = savedText({ n, name, phone, day, today: today() });
  $('doneBig').textContent = txt.big;
  $('doneSub').textContent = txt.sub;
  let line1 = '';
  let line2 = '';
  if (st.kind === 'person' && c.referrer_phone !== phone) {
    const who = c.referrer_name || formatPhone(c.referrer_phone);
    line1 = `${who} gets free breadsticks next visit.`;
    try {
      const sum = phoneSummary(c.referrer_phone, await store.phoneHistory(c.referrer_phone));
      if (completesPizza(sum.progress.count)) line2 = `${who} also earned a free medium pizza.`;
    } catch { /* only a note */ }
  } else if (st.kind === 'hotel') {
    try {
      const hc = (await store.hotelCounts()).find((x) => x.label === st.hotel);
      line1 = hotelLine(hc) || '';
    } catch { /* only a note */ }
  } else {
    line1 = 'This card isn\'t in the hand-out log yet. Once its hand-out is logged, the breadsticks are owed then.';
  }
  $('doneLine1').textContent = line1;
  $('doneLine1').hidden = !line1;
  $('doneLine2').textContent = line2;
  $('doneLine2').hidden = !line2;
  $('doneUndo').hidden = false;
  setMsg($('doneMsg'), '');
  go('done', { replace: true });
}
// Undo (1.16.1): takes the row off and goes back to the form with everything still filled in, to fix and save again.
$('doneUndo').addEventListener('click', () => busy($('doneUndo'), 'Undoing…', async () => {
  try {
    await store.undo('redemption', D.n);
    go('turnin', { replace: true, fresh: false });
    turnFill(turnInPrefill({ card_no: D.n, new_name: D.name, new_phone: D.phone, redeemed_on: D.day, override_note: D.note }));
    setMsg($('tMsg'), `Undone: card ${cardLabel(D.n)} is not turned in any more. Fix what's wrong, then Save again.`, 'ok');
  } catch (e) {
    if (!authLost(e)) setMsg($('doneMsg'), `Not undone: ${errText(e)}`, 'err');
  }
}));
$('doneOk').addEventListener('click', () => back());
// Next card (1.23.0): a blank form for the next card from the box, on the same day
$('doneNext').addEventListener('click', () => { nextDay = D.day; go('turnin', { replace: true }); });
onShow.done = () => setTimeout(() => $('doneNext').focus(), 50);

// ---------- Check a phone ----------
let lastLook = '';
function rewardRow(w) {
  const what = rewardName(w);
  const detail = w.kind === 'medium_pizza'
    ? `For 4 cards turned in, earned ${shortDay(w.earned_on)} (card ${cardLabel(w.earned_from_card)})`
    : `Card ${cardLabel(w.earned_from_card)} turned in ${shortDay(w.earned_on)}`;
  return `<li class="give-row reward ${w.kind === 'medium_pizza' ? 'pizza' : ''}"><div class="give-what"><b>${what}</b><span>${detail}</span></div>
    <button type="button" class="go give" data-give="${w.id}">Given</button></li>`;
}
function givenTodayRow(w) {
  const mine = w.given_by && w.given_by === me.id;
  const undo = canUndo({ by: w.given_by, day: w.given_on }, me.id, isOwner, today());
  return `<li class="give-row given"><div class="give-what"><b>${rewardName(w)}</b>
    <span>${mine ? 'Given just now' : 'Given today'}${w.given_by_name ? ` by ${esc(w.given_by_name)}` : ''}</span></div>
    ${undo ? `<button type="button" class="go ghost undo" data-undo-reward="${w.id}">Undo</button>` : ''}</li>`;
}
function renderCheck(p, sum) {
  if (!sum.known) {
    return `<div class="who-box"><div class="who-name">${formatPhone(p)}</div></div>
      <div class="banner none">No cards for this number</div>
      <button type="button" class="go" data-handout="${p}">Log a hand-out</button>`;
  }
  const t = today();
  const givenToday = sum.givenRows.filter((w) => w.given_on === t);
  const givenBefore = sum.givenRows.filter((w) => w.given_on !== t);
  const html = [];
  html.push(`<div class="who-box"><div class="who-name">${esc(sum.name || formatPhone(p))}</div>${sum.name ? `<div class="who-phone">${formatPhone(p)}</div>` : ''}</div>`);
  html.push(`<div class="banner ${sum.owed.any ? 'yes' : 'none'}">${esc(sum.owed.text)}</div>`);
  if (sum.owedRows.length || givenToday.length) {
    html.push(`<ul class="give-list">${sum.owedRows.map(rewardRow).join('')}${givenToday.map(givenTodayRow).join('')}</ul>`); // 1.21.0: owed = yellow cards
  }
  if (sum.owed.sticks) html.push('<p class="hint">Breadsticks: with a regular-priced <b>Large or XL</b> pizza, one per visit. In Clover: add the 12-piece cheesy breadsticks first, then Order Discounts, <b>Referral: Cheese Breadsticks</b>.</p>');
  const pr = sum.progress;
  const dots = Array.from({ length: 4 }, (_, i) => `<span class="${i < pr.count % 4 ? 'on' : ''}"></span>`).join('');
  html.push(`<div class="progress"><div class="dots" aria-hidden="true">${dots}</div><p><b>${plural(pr.count, 'referral', 'referrals')} redeemed</b>, next medium pizza at ${pr.next}</p></div>`);
  const hist = [];
  if (sum.cameWith) {
    const c = sum.cameWith.card;
    const from = c?.batch_id ? `${c.referrer_name} (hotel)` : (c?.referrer_name || formatPhone(c?.referrer_phone) || 'not logged');
    hist.push(`<li><span class="tag redeemed">came with</span><span class="main">Card ${cardLabel(sum.cameWith.card_no)}, ${shortDay(sum.cameWith.redeemed_on)}<span class="sub">from ${esc(from)}</span></span></li>`);
  }
  for (const c of [...sum.handedOut].sort((a, b) => a.card_no - b.card_no)) {
    const r = c.redemption;
    const st = cardStatus({ card: c, redemption: r }, t);
    const what = r ? `turned in ${shortDay(r.redeemed_on)}${r.new_name ? ` by ${esc(r.new_name)}` : ''}${r.new_phone === p ? ' (their own phone, doesn\'t count)' : ''}`
      : st.expired ? `not turned in, expired ${shortDay(st.expiresOn)}` : `not turned in yet, good until ${shortDay(st.expiresOn)}`;
    hist.push(`<li><span class="tag">handed</span><span class="main">Card ${cardLabel(c.card_no)}, ${shortDay(c.given_on)}<span class="sub">${what}</span></span></li>`);
  }
  for (const w of givenBefore) {
    hist.push(`<li><span class="tag">given</span><span class="main">${rewardName(w)}, card ${cardLabel(w.earned_from_card)}<span class="sub">given ${shortDay(w.given_on)}${w.given_by_name ? ` by ${esc(w.given_by_name)}` : ''}</span></span></li>`);
  }
  if (hist.length) html.push(`<h2 class="sec">History</h2><ul class="rows">${hist.join('')}</ul>`);
  return html.join('');
}
async function lookUp(p, quiet = false) {
  lastLook = p;
  const out = $('cResult');
  if (!quiet) out.innerHTML = '<p class="loading">Looking up…</p>';
  try {
    const sum = phoneSummary(p, await store.phoneHistory(p));
    if (lastLook === p) out.innerHTML = renderCheck(p, sum);
  } catch (e) {
    if (!authLost(e)) out.innerHTML = `<p class="msg err">${esc(errText(e))}</p>`;
  }
}
phoneBox($('cPhone'), { names: true });
// The box takes a name too (1.20.0): ABC switches the tablet's keyboard to letters, 123 back to the number pad.
function setLookMode(name) {
  const el = $('cPhone');
  el.type = name ? 'text' : 'tel';
  el.inputMode = name ? 'text' : 'numeric';
  el.setAttribute('autocapitalize', name ? 'words' : 'off');
  el.maxLength = name ? 40 : 16;
  el.placeholder = name ? 'First or last name' : 'Phone number or name';
  // 1.21.0: a two-part 123 | ABC switch, the kind on now marked
  for (const b of $('cMode').querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String((b.dataset.mode === 'name') === name));
  syncClear();
}
// 1.21.0: a clear (x) button inside the box while it has text
function syncClear() { $('cClear').hidden = !$('cPhone').value; }
for (const id of ['cMode', 'cClear']) $(id).addEventListener('pointerdown', (e) => e.preventDefault()); // the box keeps the keyboard
$('cMode').addEventListener('click', (e) => {
  e.preventDefault();
  const b = e.target.closest('[data-mode]');
  const el = $('cPhone');
  if (!b || (b.dataset.mode === 'name') === (el.type !== 'tel')) { el.focus(); return; } // already that kind
  setLookMode(el.type === 'tel');
  el.value = '';
  syncClear();
  $('cResult').innerHTML = '';
  lastLook = '';
  el.blur(); // the keyboard comes back as the new kind
  el.focus();
});
$('cClear').addEventListener('click', (e) => {
  e.preventDefault();
  const el = $('cPhone');
  el.value = '';
  el.focus();
  el.dispatchEvent(new Event('input', { bubbles: true })); // the same as deleting it all: result and list go
});
$('cPhone').addEventListener('input', syncClear);
$('cPhone').addEventListener('input', () => {
  const p = normalizePhone($('cPhone').value);
  // looks up by itself once all 10 digits are in, and the keyboard goes away so the answer shows
  if (p && p !== lastLook) { $('cPhone').blur(); lookUp(p); }
  if (!p) { lastLook = ''; $('cResult').innerHTML = ''; }
});
$('checkForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const p = normalizePhone($('cPhone').value);
  if (!p) {
    const name = /\p{L}/u.test($('cPhone').value);
    $('cResult').innerHTML = `<p class="msg err">${name ? 'Tap the person in the list, or type their 10-digit phone number.' : 'Type the 10-digit phone number, like 253-555-0100.'}</p>`;
    $('cPhone').focus();
    return;
  }
  $('cPhone').blur(); // the keyboard goes away so the answer shows
  lookUp(p);
});
let handoutPrefill = '';
$('cResult').addEventListener('click', async (e) => {
  const give = e.target.closest('[data-give]');
  const undo = e.target.closest('[data-undo-reward]');
  const ho = e.target.closest('[data-handout]');
  if (ho) { handoutPrefill = ho.dataset.handout; go('handout'); return; }
  const b = give || undo;
  if (!b) return;
  if (give && !confirmTap(give)) return; // Given takes two taps (1.16.1)
  await busy(b, give ? 'Saving…' : 'Undoing…', async () => {
    try {
      if (give) await store.giveReward(Number(give.dataset.give), today());
      else await store.undo('reward', Number(undo.dataset.undoReward));
      await lookUp(lastLook, true);
    } catch (err) {
      if (!authLost(err)) $('cResult').insertAdjacentHTML('afterbegin', `<p class="msg err">Not saved: ${esc(errText(err))}</p>`);
    }
  });
});
onShow.check = (fresh) => {
  if (fresh) { setLookMode(false); $('cPhone').value = ''; syncClear(); $('cResult').innerHTML = ''; lastLook = ''; setTimeout(() => $('cPhone').focus(), 50); return; }
  const p = normalizePhone($('cPhone').value);
  if (p) lookUp(p, true); // back from a hand-out: show it again with the new card
};

// ---------- Hotels ----------
async function drawHotels() {
  const out = $('hotelBlocks');
  if (!out.children.length) out.innerHTML = '<p class="loading">Loading…</p>';
  try {
    const [hotels, lunches] = await Promise.all([store.hotelCounts(), store.hotelLunches()]);
    if (!hotels.length) { out.innerHTML = '<p class="empty">No hotel batches yet. Log one under More, Log a hand-out, Batch.</p>'; return; }
    out.innerHTML = hotels.map((h) => {
      const st = lunchState(h, lunches);
      const pct = Math.round((st.sinceLast / LUNCH_EVERY) * 100);
      const hist = st.history.slice().reverse().map((l) => {
        const undo = canUndo({ by: l.delivered_by, day: dayOf(l) }, me.id, isOwner, today());
        return `<li><span class="main">Lunch ${l.lunch_no}<span class="sub">delivered ${shortDay(l.delivered_on)}${l.delivered_by_name ? ` by ${esc(l.delivered_by_name)}` : ''}</span></span>
          ${undo ? `<button type="button" class="go ghost undo" data-undo-lunch="${l.id}">Undo</button>` : ''}</li>`;
      }).join('');
      return `<article class="card hotel">
        <h2>${esc(h.label)}</h2>
        <p class="hotel-big"><b>${st.sinceLast} / ${LUNCH_EVERY}</b> to next lunch</p>
        <div class="bar" role="img" aria-label="${st.sinceLast} of ${LUNCH_EVERY}"><span style="width:${pct}%"></span></div>
        <p class="hotel-sub">${plural(h.cards_given, 'card', 'cards')} given, ${h.redemptions} turned in, ${plural(st.earned, 'lunch', 'lunches')} earned</p>
        ${st.owed ? `<div class="lunch owed reward"><b class="lunch-n">Lunches owed: ${st.owed}</b>
          <button type="button" class="go" data-deliver="${esc(h.label)}" data-no="${st.nextNo}">Delivered</button></div>`
          : '<p class="lunch-none">No lunch owed</p>'}
        ${hist ? `<ul class="rows">${hist}</ul>` : ''}
      </article>`;
    }).join('');
  } catch (e) {
    if (authLost(e)) return;
    showSetup(e);
    out.innerHTML = `<p class="msg err">${esc(errText(e))}</p>`;
  }
}
$('hotelBlocks').addEventListener('click', async (e) => {
  const d = e.target.closest('[data-deliver]');
  const u = e.target.closest('[data-undo-lunch]');
  const b = d || u;
  if (!b) return;
  if (d && !confirmTap(d)) return; // Delivered takes two taps (1.16.1)
  await busy(b, d ? 'Saving…' : 'Undoing…', async () => {
    try {
      if (d) {
        await store.deliverLunch({ label: d.dataset.deliver, lunch_no: Number(d.dataset.no), delivered_on: today() });
        setMsg($('hotelMsg'), `Lunch ${d.dataset.no} for ${d.dataset.deliver} recorded, delivered today.`, 'ok');
      } else {
        await store.undo('lunch', Number(u.dataset.undoLunch));
        setMsg($('hotelMsg'), 'Lunch taken off.', 'ok');
      }
    } catch (err) {
      if (authLost(err)) return;
      setMsg($('hotelMsg'), /already recorded/i.test(err.message || '') ? 'That lunch is already recorded.' : `Not saved: ${errText(err)}`, 'err');
    }
    await drawHotels();
  });
});
onShow.hotels = (fresh) => { if (fresh) setMsg($('hotelMsg'), ''); drawHotels(); };

// ---------- More: today's entries (with Undo), sign out ----------
function entryText(x) {
  const r = x.row;
  if (x.what === 'redemption') {
    const late = r.redeemed_on && r.redeemed_on !== today() ? ` · turned in ${shortDay(r.redeemed_on)}` : ''; // from the box (1.23.0)
    return [`Card ${cardLabel(r.card_no)} turned in`, nameAndPhone(r.new_name, r.new_phone) + late];
  }
  if (x.what === 'handout') return [`Card ${cardLabel(r.card_no)} handed out`, nameAndPhone(r.referrer_name, r.referrer_phone)];
  if (x.what === 'batch') return [`Hotel batch: ${r.label}`, `Cards ${cardLabel(r.card_from)} to ${cardLabel(r.card_to)}`];
  if (x.what === 'lunch') return [`Lunch ${r.lunch_no} delivered`, r.label];
  return [`${rewardName(r)} given`, `${formatPhone(r.phone)}, card ${cardLabel(r.earned_from_card)}`];
}
const todayRows = new Map(); // what Fix puts back in the form
async function drawToday() {
  $('moreWho').textContent = myName;
  todayRows.clear();
  $('todaySub').textContent = isOwner ? 'everyone, newest first' : 'yours, newest first';
  try {
    const all = await store.todayEntries(today());
    const list = isOwner ? all : all.filter((x) => x.by && x.by === me.id);
    $('todayList').innerHTML = list.length ? list.map((x) => {
      const [title, sub] = entryText(x);
      const undo = canUndo(x, me.id, isOwner, today());
      // Fix of a turned-in card opens that form, which is the owner's only (1.23.0); employees keep Undo
      const fix = undo && (x.what === 'handout' || (x.what === 'redemption' && isOwner));
      if (fix) todayRows.set(`${x.what}:${x.id}`, x.row);
      return `<li><span class="main">${esc(title)}<span class="sub">${esc(sub)}${isOwner && x.by_name ? `, by ${esc(x.by_name)}` : ''}</span></span>
        ${undo ? `<span class="row-btns">${fix ? `<button type="button" class="go ghost undo fix" data-fix="${x.what}" data-id="${x.id}">Fix</button>` : ''}<button type="button" class="go ghost undo" data-undo="${x.what}" data-id="${x.id}">Undo</button></span>` : ''}</li>`;
    }).join('') : '<li class="empty">Nothing entered today yet.</li>';
  } catch (e) {
    if (authLost(e)) return;
    showSetup(e);
    $('todayList').innerHTML = `<li class="empty">${esc(errText(e))}</li>`;
  }
}
// Undo in the Today list takes two taps (the first asks), since it's further from what was just done.
// Fix (1.16.1) = undo, then the form opens again filled in, to correct and save.
$('todayList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-undo], [data-fix]');
  if (!b) return;
  const fix = b.dataset.fix;
  if (!confirmTap(b, fix ? 'Tap again to fix' : 'Tap again to undo', false)) return;
  await busy(b, 'Undoing…', async () => {
    try {
      const what = fix || b.dataset.undo;
      const row = todayRows.get(`${what}:${b.dataset.id}`);
      await store.undo(what, b.dataset.id);
      if (fix && what === 'redemption') {
        go('turnin', { fresh: false });
        turnFill(turnInPrefill(row));
        setMsg($('tMsg'), `Undone: card ${cardLabel(row.card_no)} is not turned in any more. Fix what's wrong, then Save again.`, 'ok');
        return;
      }
      if (fix) {
        handoutFix = handoutFill(row);
        go('handout');
        return;
      }
      setMsg($('todayMsg'), 'Undone.', 'ok');
    } catch (err) {
      if (!authLost(err)) setMsg($('todayMsg'), `Not undone: ${errText(err)}`, 'err');
    }
    await drawToday();
  });
});
onShow.more = (fresh) => { if (fresh) setMsg($('todayMsg'), ''); drawToday(); };

// ---------- Log a hand-out: one card from the paper log ----------
let hInfo = null; // { n, info } for the card number in the box
let handoutFix = null; // Fix in the Today list: the hand-out to put back in the form (1.16.1)
const counts = { handout: 0 };
const H = { touched: new Set() };
const handValues = () => ({ card: $('hCard').value, phone: $('hPhone').value, first: $('hFirst').value, last: $('hLast').value });
// the checks under each box, and Save off until card, phone and both names are right (1.16.1)
function handDraw() {
  if ($('hCard').value.trim()) H.touched.add('card');
  const v = validateHandout(handValues());
  showFieldMsgs('h', v, H.touched);
  const blocked = hInfo && hInfo.n === v.n && handoutCheck(hInfo.info).block;
  if (!$('hSave').dataset.busy) $('hSave').disabled = !v.ok || !!blocked;
  return v;
}
const hLookup = debounce(async () => {
  const n = parseCard($('hCard').value);
  const el = $('hInfo');
  el.className = 'ref-info';
  $('hSave').classList.remove('replace');
  $('hSave').textContent = 'Save hand-out';
  if (!n) { hInfo = null; el.textContent = ''; handDraw(); return; }
  try {
    const info = await store.cardInfo(n);
    if (parseCard($('hCard').value) !== n) return; // typed on meanwhile
    hInfo = { n, info };
    handDraw();
    const chk = handoutCheck(info);
    if (chk.block) { el.className = 'ref-info block'; el.textContent = chk.block; return; }
    if (chk.replace) {
      el.className = 'ref-info replace';
      el.textContent = chk.replace;
      $('hSave').classList.add('replace');
      $('hSave').textContent = `Replace card ${cardLabel(n)}`;
      return;
    }
    if (chk.fillIn) {
      const r = info.redemption;
      el.innerHTML = `Card <b>${cardLabel(n)}</b> was already turned in${r ? ` on ${shortDay(r.redeemed_on)}` : ''}. Saving fills in who it was handed to; they'll be owed breadsticks.`;
      return;
    }
    el.innerHTML = `Card <b>${cardLabel(n)}</b>: new.`;
  } catch (e) {
    if (authLost(e)) return;
    el.className = 'ref-info block';
    el.textContent = errText(e);
  }
});
digitBox($('hCard'));
$('hCard').addEventListener('input', () => { handDraw(); hLookup(); });
for (const id of ['hPhone', 'hFirst', 'hLast']) {
  $(id).addEventListener('input', () => { if ($('hMsg').classList.contains('ok')) setMsg($('hMsg'), ''); handDraw(); });
}
trackTouched('h', H, handDraw);

$('handForm').addEventListener('submit', (e) => {
  e.preventDefault();
  busy($('hSave'), '', async () => {
    const msg = $('hMsg');
    const v = validateHandout(handValues());
    const bad = FIELDS.find((k) => v.fields[k]?.block);
    if (bad) { H.touched = new Set(FIELDS); handDraw(); $(`h${cap(bad)}`).focus(); return; }
    const { n, p: phone, name } = v;
    const given = readDate($('hDate'), msg);
    if (!given) return;
    try {
      // always check the card fresh before saving (someone else may have entered it)
      const info = await store.cardInfo(n);
      const chk = handoutCheck(info);
      if (chk.block) { setMsg(msg, chk.block, 'err'); return; }
      if (chk.replace && !(hInfo?.n === n && handoutCheck(hInfo.info).replace)) {
        hInfo = { n, info };
        hLookup();
        setMsg(msg, 'This card is already logged. Check it, then tap Replace to save over it.', 'err');
        return;
      }
      await store.saveHandout({ card_no: n, given_on: given, referrer_name: name, referrer_phone: phone }, !!info.card);
      counts.handout += 1;
      $('handCount').textContent = `${counts.handout} saved`;
      setMsg(msg, `Saved card ${cardLabel(n)}: ${nameAndPhone(name, phone)}, ${shortDay(given)}${chk.fillIn ? '. They\'re owed breadsticks.' : '.'}`, 'ok');
      // next row: same date, next card number, empty names and phone
      for (const id of ['hFirst', 'hLast', 'hPhone']) $(id).value = '';
      H.touched = new Set();
      $('hCard').value = n < MAX_CARD ? cardLabel(n + 1) : '';
      hInfo = null;
      hLookup();
      $('hCard').focus();
      $('hCard').select();
    } catch (err) {
      if (!authLost(err)) setMsg(msg, `Not saved: ${errText(err)}`, 'err');
    }
  }).then(handDraw);
});
onShow.handout = (fresh) => {
  dateBox($('hDate'));
  if (fresh) { setMsg($('hMsg'), ''); setMsg($('bMsg'), ''); }
  if (handoutPrefill) {
    for (const id of ['hCard', 'hFirst', 'hLast']) $(id).value = '';
    $('hPhone').value = formatPhone(handoutPrefill);
    handoutPrefill = '';
    H.touched = new Set();
    hLookup();
  }
  if (handoutFix) {
    const f = handoutFix;
    handoutFix = null;
    $('hCard').value = f.card;
    if (f.date) $('hDate').value = f.date;
    $('hFirst').value = f.first;
    $('hLast').value = f.last;
    $('hPhone').value = f.phone;
    H.touched = new Set(FIELDS);
    setMsg($('hMsg'), `Undone: card ${f.card} is not logged any more. Fix what's wrong, then Save again.`, 'ok');
    hLookup();
  }
  handDraw();
  setTimeout(() => $('hCard').focus(), 50);
};

// ---------- batch: a hotel's front desk, or one person ----------
// Hotel: 10% off only, no breadsticks, counts toward front-desk lunches. Person: just several ordinary hand-out
// rows to the same phone, so each card redeemed earns that person breadsticks (and counts toward a pizza).
let batchKind = 'hotel';
function setBatchKind(kind) {
  batchKind = kind;
  for (const b of document.querySelectorAll('.ref-kind button')) {
    const on = b.dataset.kind === kind;
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-checked', String(on));
  }
  const hotel = kind === 'hotel';
  // a hotel batch keeps the hotel's name; a personal batch needs the person's first and last name (1.16.1)
  $('bLabelWrap').hidden = !hotel;
  $('bFirstWrap').hidden = hotel;
  $('bLastWrap').hidden = hotel;
  $('bPhoneText').textContent = hotel ? 'Front desk phone' : 'Phone';
  $('bPhone').placeholder = hotel ? 'optional' : '(253) 555-0100';
  $('bNotesWrap').hidden = !hotel;
  $('bSave').textContent = hotel ? 'Save hotel batch' : 'Save personal batch';
  bInfo();
}
document.querySelector('.ref-kind').addEventListener('click', (e) => {
  const b = e.target.closest('[data-kind]');
  if (b) { setBatchKind(b.dataset.kind); $(b.dataset.kind === 'hotel' ? 'bLabel' : 'bFirst').focus(); }
});
const B = { touched: new Set() };
function batchNames() {
  const v = { fields: { first: { msg: checkName($('bFirst').value, 'First name') }, last: { msg: checkName($('bLast').value, 'Last name') } } };
  showFieldMsgs('b', v, B.touched);
  return v;
}
for (const id of ['bFirst', 'bLast']) $(id).addEventListener('input', batchNames);
trackTouched('b', B, batchNames);
digitBox($('bFrom'));
digitBox($('bTo'));
function batchRange() {
  const a = parseCard($('bFrom').value);
  const b = parseCard($('bTo').value);
  return { a, b, ok: !!(a && b && a <= b) };
}
function bInfo() {
  const { a, b, ok } = batchRange();
  const range = ok ? `Cards ${cardLabel(a)} to ${cardLabel(b)}: ${plural(b - a + 1, 'card', 'cards')}. ` : '';
  $('bInfo').textContent = range + (batchKind === 'hotel'
    ? 'Hotel cards get 10% off only, no breadsticks. Every 25 turned in = lunch for that front desk.'
    : 'Each one is a normal hand-out to this person: every card turned in earns them free breadsticks, every 4th a free medium pizza.');
}
$('bFrom').addEventListener('input', bInfo);
$('bTo').addEventListener('input', bInfo);
$('batchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  busy($('bSave'), '', async () => {
    const msg = $('bMsg');
    const hotel = batchKind === 'hotel';
    const label = hotel ? $('bLabel').value.trim() : fullName($('bFirst').value, $('bLast').value);
    if (!label && hotel) { setMsg(msg, 'Type the hotel\'s name.', 'err'); $('bLabel').focus(); return; }
    if (!hotel) {
      B.touched.add('first').add('last');
      const nv = batchNames();
      const bad = ['first', 'last'].find((k) => nv.fields[k].msg);
      if (bad) { $(`b${cap(bad)}`).focus(); return; }
    }
    const { a, b, ok } = batchRange();
    if (!ok) { setMsg(msg, 'Type the first and last card numbers (the first one smaller).', 'err'); $('bFrom').focus(); return; }
    const given = readDate($('bDate'), msg);
    if (!given) return;
    const raw = $('bPhone').value.trim();
    const phone = raw ? normalizePhone(raw) : null;
    if (raw && !phone) { setMsg(msg, hotel ? 'The front desk phone needs 10 digits (or leave it empty).' : 'Type the 10-digit phone number, like 253-555-0100.', 'err'); $('bPhone').focus(); return; }
    if (!hotel && !phone) { setMsg(msg, 'A personal batch needs the person\'s phone number (it\'s how their rewards find them).', 'err'); $('bPhone').focus(); return; }
    try {
      if (hotel) await store.saveBatch({ label, phone, card_from: a, card_to: b, given_on: given, notes: $('bNotes').value.trim() });
      else await store.savePersonalBatch({ name: label, phone, card_from: a, card_to: b, given_on: given });
      setMsg(msg, `Saved: ${hotel ? label : nameAndPhone(label, phone)}, cards ${cardLabel(a)} to ${cardLabel(b)} (${b - a + 1}), ${shortDay(given)}.`, 'ok');
      for (const id of hotel ? ['bFrom', 'bTo', 'bPhone', 'bNotes'] : ['bFirst', 'bLast', 'bFrom', 'bTo', 'bPhone']) $(id).value = '';
      B.touched.clear();
      batchNames();
      bInfo();
    } catch (err) {
      if (!authLost(err)) setMsg(msg, `Not saved: ${errText(err)}`, 'err');
    }
  });
});

// ---------- Owner.com list ----------
let signup = [];
async function drawSignup() {
  try {
    signup = await store.signupList();
    $('signupCount').textContent = signup.length ? `${signup.length} to add` : '';
    $('signupCopy').disabled = $('signupMarkAll').disabled = !signup.length;
    $('signupList').innerHTML = signup.length ? signup.map((x) => `<li><span class="main">${esc(nameAndPhone(x.name, x.phone))}
      <span class="sub">${esc(x.sources)}</span></span><button class="go ghost undo" type="button" data-added="${x.phone}">Added</button></li>`).join('')
      : '<li class="empty">Everyone is on Owner.com rewards.</li>';
  } catch (e) {
    if (!authLost(e)) $('signupList').innerHTML = `<li class="empty">${esc(errText(e))}</li>`;
  }
}
async function markAdded(phones, done) {
  try {
    await store.markAdded(phones);
    setMsg($('signupMsg'), done, 'ok');
    $('signupText').hidden = true;
    await drawSignup();
  } catch (e) {
    if (!authLost(e)) setMsg($('signupMsg'), `Not saved: ${errText(e)}`, 'err');
  }
}
$('signupCopy').addEventListener('click', async () => {
  const text = signup.map((x) => x.phone).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    setMsg($('signupMsg'), `Copied ${plural(signup.length, 'phone number', 'phone numbers')}, one per line.`, 'ok');
  } catch {
    // no clipboard here: show them selected, ready to copy by hand
    $('signupText').value = text;
    $('signupText').hidden = false;
    $('signupText').select();
    setMsg($('signupMsg'), 'Copy the selected numbers below (long-press, then Copy).', '');
  }
});
$('signupMarkAll').addEventListener('click', () => {
  if (!signup.length) return;
  if (!confirm(`Mark all ${signup.length} phone numbers as added to Owner.com rewards?`)) return;
  markAdded(signup.map((x) => x.phone), `Marked ${signup.length} as added.`);
});
$('signupList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-added]');
  if (!b) return;
  b.disabled = true;
  markAdded([b.dataset.added], `Marked ${formatPhone(b.dataset.added)} as added.`);
});
onShow.ownercom = (fresh) => { if (fresh) setMsg($('signupMsg'), ''); drawSignup(); };

// ---------- stay signed in, and keep the screens current ----------
async function keepAlive() {
  if (!store || store.demo || document.body.classList.contains('locked')) return;
  try { await store.ping(); } catch (e) { authLost(e); }
}
function refreshScreen() {
  for (const id of ['hDate', 'bDate']) $(id).max = today(); // after midnight, today moves on
  dayLimits();
  if (current === 'home') drawHome();
  else if (current === 'hotels') drawHotels();
  else if (current === 'more') drawToday();
}

function start() {
  // 1.23.0: owner or employee view, set before the page shows (no flash); without it, the employee view
  document.body.classList.toggle('owner', isOwner);
  document.body.classList.remove('locked');
  // the people lookup (1.20.0): loaded for this sign-in, and again after every save or undo
  refreshPeopleAfterSaves(store);
  loadPeople();
  if (started) { show(current, false); return; } // show() sends an employee who was on the form Home
  started = true;
  for (const id of ['hDate', 'bDate']) dateBox($(id));
  for (const id of ['tPhone', 'hPhone', 'bPhone']) phoneBox($(id));
  // Check a phone: a tap is the same as typing the whole number (the usual look-up)
  suggestBox($('cPhone'), {
    pick: (e) => {
      $('cPhone').value = formatPhone(e.phone);
      syncClear();
      $('cPhone').blur();
      lookUp(e.phone);
    },
  });
  // Log a hand-out: a tap fills the phone and the name (people only, not a hotel's front desk)
  suggestBox($('hPhone'), {
    filter: (e) => e.referrer || e.newCustomer,
    pick: (e) => {
      $('hPhone').value = formatPhone(e.phone);
      if (e.name) { const n = splitName(e.name); $('hFirst').value = n.first; $('hLast').value = n.last; }
      for (const k of ['phone', 'first', 'last']) H.touched.add(k);
      if ($('hMsg').classList.contains('ok')) setMsg($('hMsg'), '');
      handDraw();
      $('hPhone').blur();
    },
  });
  // Card turned in: a match means this phone is already on file, and the offer is for new customers. It only
  // shows who it is; the usual checks (yellow note, Save anyway with a note) decide, nothing new is blocked.
  suggestBox($('tPhone'), {
    title: 'Already on file. The 10% is for new customers only.',
    kind: 'warn',
    pick: (e) => {
      $('tPhone').value = formatPhone(e.phone);
      if (e.name && !$('tFirst').value.trim() && !$('tLast').value.trim()) {
        const n = splitName(e.name);
        $('tFirst').value = n.first;
        $('tLast').value = n.last;
      }
      T.touched.add('phone');
      setMsg($('tMsg'), '');
      turnDraw();
      turnPhoneLookup();
      if ($('tFirst').value.trim() && $('tLast').value.trim()) $('tPhone').blur(); else $('tFirst').focus();
    },
  });
  setBatchKind('hotel');
  // hotel names for the batch form
  store.hotelCounts().then((hs) => {
    const known = new Set(['TownePlace Suites', 'WoodSpring Suites', ...hs.map((h) => h.label)]);
    $('hotelList').innerHTML = [...known].map((l) => `<option value="${esc(l)}">`).join('');
  }).catch(() => {});
  // a reload always starts at Home (the screens are in this page's history from here on)
  history.replaceState({ scr: 'home', depth: 0 }, '', `${location.pathname}${location.search}`);
  show('home', true);
  const c = parseCard(PARAMS.get('c'));
  if (c && isOwner) { go('turnin'); $('tCard').value = cardLabel(c); turnCardLookup(); }
  setInterval(keepAlive, KEEP_ALIVE_MS);
  setInterval(refreshScreen, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    keepAlive();
    refreshScreen();
    if (Date.now() - peopleAt > PEOPLE_STALE_MS) loadPeople();
  });
  window.addEventListener('focus', () => { if (Date.now() - peopleAt > PEOPLE_STALE_MS) loadPeople(); });
}

console.debug(`Referral cards v${VERSION}`);
boot();
