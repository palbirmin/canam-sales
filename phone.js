// Phone page: sign in, then show the add-on's own dashboard with numbers read from Supabase.
import { CONFIG } from './config.js';
import { todayKey, addDays } from './lib.js';
import { makeSupa, AuthError } from './supa.js';
import { loginEmail } from './login-name.js';

const P = CONFIG.phone;
const SESSION_KEY = 'canam.session';
const POLL_MS = 30 * 1000;

// Remember the sign-in on this phone (falls back to memory if the browser blocks storage).
let memory = null;
const supa = makeSupa({
  url: P.supabaseUrl,
  key: P.publishableKey,
  load: async () => {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; } catch { return memory; }
  },
  save: async (s) => {
    memory = s;
    try { if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s)); else localStorage.removeItem(SESSION_KEY); } catch { /* memory only */ }
  },
});

// Safari can't read more than 3 decimals of seconds.
const ms = (iso) => Date.parse(String(iso).replace(/(\.\d{3})\d+/, '$1'));

// Same shape as the add-on's storage, so dashboard.js can't tell the difference.
// kitchen = an employee login: it only reads the dough tables and kitchen_meta (scheduled orders
// without prices), never sales_days or sales_meta. The database refuses those to it anyway.
function makeRemoteStore({ kitchen = false, email = '', name = '' } = {}) {
  let days = {};
  let meta = {};
  let metaAt = null;
  let daysAt = 0;
  let dough = {}; // dough counts the owner entered: { day: { am | pm | left: { m, l, x, at } } }
  let doughDays = {}; // doughs used each day, from Clover: { 'dough:<day>': { v, s, gf, n, unknown } }
  let doughDaysAt = 0;
  let kitchenMeta = {}; // { lastRefresh, cloverAt, upcoming } for employee logins
  let doughLog = []; // who entered which dough count, last 7 days (owner only)
  const listeners = [];

  // Only what changed since last time (with a little overlap to be safe); about 6 months the first time.
  async function pullDoughDays() {
    let q = `dough_days?select=day,data,updated_at&day=gte.${addDays(todayKey(), -200)}`;
    if (doughDaysAt) q += `&updated_at=gte.${encodeURIComponent(new Date(doughDaysAt - 2 * 60 * 1000).toISOString())}`;
    const rows = await supa.rest('GET', q);
    let changed = false;
    const next = { ...doughDays };
    for (const r of rows) {
      doughDaysAt = Math.max(doughDaysAt, ms(r.updated_at) || 0);
      const k = `dough:${r.day}`;
      if (JSON.stringify(next[k]) === JSON.stringify(r.data)) continue;
      next[k] = r.data;
      changed = true;
    }
    doughDays = next;
    return changed;
  }

  // Read every time, since the computer and this phone can both enter counts.
  async function pullDough() {
    const rows = await supa.rest('GET', `dough_counts?select=day,batch,m,l,x,updated_at,by_name&day=gte.${addDays(todayKey(), -(CONFIG.backfillDays + 1))}`);
    const next = {};
    for (const r of rows) (next[r.day] ||= {})[r.batch] = { m: r.m, l: r.l, x: r.x, at: ms(r.updated_at), by: r.by_name || '' };
    const changed = JSON.stringify(next) !== JSON.stringify(dough);
    dough = next;
    return changed;
  }

  async function pullKitchen() {
    const [k] = await supa.rest('GET', 'kitchen_meta?select=data&id=eq.1');
    const next = k?.data || {};
    const changed = JSON.stringify(next) !== JSON.stringify(kitchenMeta);
    kitchenMeta = next;
    return changed;
  }

  // Every change to a dough count and who made it (the database keeps this log; only the owner can read it).
  async function pullLog() {
    const since = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const rows = await supa.rest('GET', `dough_log?select=at,day,batch,m,l,x,was,who&at=gte.${encodeURIComponent(since)}&order=at.desc&limit=300`);
    const next = rows.map((r) => ({ ...r, at: ms(r.at) }));
    const changed = JSON.stringify(next) !== JSON.stringify(doughLog);
    doughLog = next;
    return changed;
  }

  async function pull() {
    const doughChanged = (await pullDough().catch(() => false)) | (await pullDoughDays().catch(() => false));
    if (kitchen) return (await pullKitchen()) || !!doughChanged;
    const logChanged = await pullLog().catch(() => false);
    const [m] = await supa.rest('GET', 'sales_meta?select=data,updated_at&id=eq.1');
    if (m && m.updated_at === metaAt) return !!(doughChanged | logChanged);
    const from = addDays(todayKey(), -(CONFIG.keepDays + 1));
    let q = `sales_days?select=day,channel,data,updated_at&day=gte.${from}`;
    // only what changed since last time (with a little overlap to be safe)
    if (daysAt) q += `&updated_at=gte.${encodeURIComponent(new Date(daysAt - 2 * 60 * 1000).toISOString())}`;
    const rows = await supa.rest('GET', q);
    const next = { ...days };
    for (const r of rows) {
      next[`d:${r.day}:${r.channel}`] = r.data;
      daysAt = Math.max(daysAt, ms(r.updated_at) || 0);
    }
    days = next;
    meta = m?.data || {};
    metaAt = m?.updated_at || null;
    return true;
  }

  const notify = () => listeners.forEach((cb) => cb());
  async function tick() {
    try {
      if (await pull()) notify();
    } catch (e) {
      if (e instanceof AuthError && e.signedOut) location.reload(); // shows the sign-in screen
      // otherwise (no signal, etc.) keep showing the last numbers; the header shows how old they are
    }
  }

  let timer = null;
  function start() {
    const run = () => { clearInterval(timer); timer = null; if (!document.hidden) { tick(); timer = setInterval(tick, POLL_MS); } };
    document.addEventListener('visibilitychange', run);
    addEventListener('online', run);
    timer = setInterval(tick, POLL_MS);
  }

  return {
    pull, start,
    load: async () => (kitchen
      ? { ...doughDays, doughCounts: dough, lastRefresh: kitchenMeta.lastRefresh || null, cloverAt: kitchenMeta.cloverAt || null, upcoming: kitchenMeta.upcoming || null }
      : { ...days, ...meta, ...doughDays, doughCounts: dough, doughLog }),
    kitchen,
    email,
    name, // an employee's name, as the owner entered it
    onChange: (cb) => listeners.push(cb),
    refresh: async () => { metaAt = null; await pull(); },
    set: async () => {},
    remove: async () => {},
    saveDough: async (day, batch, c) => {
      const row = { day, batch, m: c.m, l: c.l, x: c.x };
      await supa.rest('POST', 'dough_counts?on_conflict=day,batch', [row], 'resolution=merge-duplicates,return=minimal');
      dough = { ...dough, [day]: { ...(dough[day] || {}), [batch]: { m: c.m, l: c.l, x: c.x, at: Date.now(), by: name } } };
      notify();
      // the database stamps who saved it; read that back (and the owner's log) straight away
      await pullDough().catch(() => {});
      if (!kitchen) await pullLog().catch(() => {});
      notify();
    },
    signOut: () => supa.signOut(),
    // the owner's "Employee logins" box (the kitchen-logins Edge Function only answers the owner)
    kitchenLogins: kitchen ? undefined : (body) => supa.fn('kitchen-logins', body),
  };
}

// ---------- sign-in screen ----------
const $ = (id) => document.getElementById(id);

function showLogin(message = '', retry = false) {
  document.body.classList.add('locked');
  $('loginForm').hidden = retry;
  $('loginRetry').hidden = !retry;
  $('loginMsg').textContent = message;
}

// 'owner' (on dashboard_users) or 'kitchen' (an employee login on staff_users, dough only). A login
// on neither list gets nothing from the database anyway; say so plainly and sign it out instead of
// showing an empty page.
async function checkAccess() {
  if ((await supa.rest('GET', 'dashboard_users?select=user_id')).length) return { role: 'owner', name: 'Owner' };
  const [me] = await supa.rest('GET', 'staff_users?select=user_id,name');
  if (me) return { role: 'kitchen', name: me.name || '' };
  await supa.signOut();
  const e = new AuthError("This login doesn't have access. Ask the owner.", true);
  e.noAccess = true;
  throw e;
}

async function open() {
  const { role, name } = await checkAccess();
  const store = makeRemoteStore({ kitchen: role === 'kitchen', email: (await supa.session())?.email || '', name });
  await store.pull();
  globalThis.canamRemoteStore = store;
  document.body.classList.remove('locked');
  await import('./dashboard.js');
  store.start();
  tipReady = true;
  setTimeout(maybeShowAppTip, 4000);
}

async function boot() {
  if (!(await supa.session())) return showLogin();
  $('loginMsg').textContent = 'Loading…';
  try {
    await open();
  } catch (e) {
    if (e instanceof AuthError && e.signedOut) showLogin(e.noAccess ? e.message : 'Please sign in again.');
    else showLogin("Couldn't reach the server. Check the internet connection and try again.", true);
  }
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = loginEmail($('loginEmail').value); // a phone number becomes its login's made-up email
  const pw = $('loginPassword');
  const btn = $('loginBtn');
  if (!email) { showLogin('Type your phone number (like 253-555-0100) or your email.'); return; }
  btn.disabled = true;
  $('loginMsg').textContent = 'Signing in…';
  try {
    await supa.signIn(email, pw.value);
    pw.value = '';
    await open();
  } catch (err) {
    const offline = !(err instanceof AuthError);
    showLogin(offline ? "Couldn't reach the server. Check the internet connection and try again." : err.message);
  } finally {
    btn.disabled = false;
  }
});
$('loginRetry').addEventListener('click', boot);
// Employees sign in with a phone number and a 6-number PIN: once the first box looks like a phone
// number, the PIN box brings up the number keypad.
$('loginEmail').addEventListener('input', (e) => {
  $('loginPassword').inputMode = /^[\d\s()+.-]+$/.test(e.target.value.trim()) ? 'numeric' : 'text';
});
$('loginShow').addEventListener('click', () => {
  const pw = $('loginPassword');
  const show = pw.type === 'password';
  pw.type = show ? 'text' : 'password';
  $('loginShow').textContent = show ? 'Hide' : 'Show';
  $('loginShow').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
});

// ---------- "put it on the home screen" tip ----------
// Comes back every time the page is opened in a browser (and after an hour away), until it's
// opened as an installed app (the owner, 2026-10-21). "Not now" only hides it for now. An iPhone
// can't tell Safari whether the page is on the home screen, so there it shows until the page is
// opened from the home-screen icon; Android Chrome and computers say when it's installed.
const INSTALLED_KEY = 'canam.appInstalled';
const AGAIN_MS = 60 * 60 * 1000;
let installPrompt = null; // Android Chrome / computer Chrome: the browser's own Install
let tipReady = false; // signed in, so the tip may show
let tipClosedAt = 0; // "Not now"
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = () => /Android/i.test(navigator.userAgent);
const remember = (on) => { try { if (on) localStorage.setItem(INSTALLED_KEY, '1'); else localStorage.removeItem(INSTALLED_KEY); } catch { /* private mode */ } };
const SHARE_ICON = '<svg viewBox="0 0 24 24" width="17" height="17" aria-label="Share" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3M8 7l4-4 4 4"/><path d="M7 11H5v10h14V11h-2"/></svg>';

addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  remember(false); // the browser only offers this when it isn't installed
  maybeShowAppTip();
});
addEventListener('appinstalled', () => { remember(true); $('appTip').hidden = true; });

async function installedAlready() {
  if (standalone()) return true;
  if (installPrompt) return false;
  try { if (localStorage.getItem(INSTALLED_KEY)) return true; } catch { /* private mode */ }
  try { return ((await navigator.getInstalledRelatedApps?.()) || []).length > 0; } catch { return false; }
}

async function maybeShowAppTip() {
  if (!tipReady || Date.now() - tipClosedAt < AGAIN_MS || (await installedAlready())) return;
  let msg;
  if (installPrompt) msg = 'Install this page so it opens like an app, with its own icon.';
  else if (isIOS()) msg = `Put this on your home screen so it opens like an app: tap the Share button ${SHARE_ICON}, then <b>Add to Home Screen</b>.`;
  else if (isAndroid()) msg = 'Put this on your home screen so it opens like an app: open the browser menu <b>⋮</b>, then <b>Add to Home screen</b> or <b>Install app</b>.';
  else return; // computers: only when the browser offers to install
  $('appTipMsg').innerHTML = msg;
  $('appTipInstall').hidden = !installPrompt;
  $('appTip').hidden = false;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) maybeShowAppTip(); });

$('appTipClose').addEventListener('click', () => { tipClosedAt = Date.now(); $('appTip').hidden = true; });
$('appTipInstall').addEventListener('click', async () => {
  const p = installPrompt;
  installPrompt = null;
  $('appTip').hidden = true;
  if (!p) return;
  p.prompt();
  const choice = await p.userChoice.catch(() => null);
  if (choice?.outcome === 'accepted') remember(true);
  else tipClosedAt = Date.now();
});

boot();
