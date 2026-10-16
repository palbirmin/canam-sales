// Phone page: sign in, then show the add-on's own dashboard with numbers read from Supabase.
import { CONFIG } from './config.js';
import { todayKey, addDays } from './lib.js';
import { makeSupa, AuthError } from './supa.js';

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
function makeRemoteStore() {
  let days = {};
  let meta = {};
  let metaAt = null;
  let daysAt = 0;
  const listeners = [];

  async function pull() {
    const [m] = await supa.rest('GET', 'sales_meta?select=data,updated_at&id=eq.1');
    if (m && m.updated_at === metaAt) return false;
    const from = addDays(todayKey(), -(CONFIG.backfillDays + 1));
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
    load: async () => ({ ...days, ...meta }),
    onChange: (cb) => listeners.push(cb),
    refresh: async () => { metaAt = null; await pull(); },
    set: async () => {},
    remove: async () => {},
    signOut: () => supa.signOut(),
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

// A login that isn't on the owner list (dashboard_users) gets nothing from the database anyway;
// say so plainly and sign it out instead of showing an empty page.
async function checkAccess() {
  const me = await supa.rest('GET', 'dashboard_users?select=user_id');
  if (me.length) return;
  await supa.signOut();
  const e = new AuthError("This login doesn't have access to the sales page.", true);
  e.noAccess = true;
  throw e;
}

async function open() {
  await checkAccess();
  const store = makeRemoteStore();
  await store.pull();
  globalThis.canamRemoteStore = store;
  document.body.classList.remove('locked');
  await import('./dashboard.js');
  store.start();
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
  const email = $('loginEmail').value.trim();
  const pw = $('loginPassword');
  const btn = $('loginBtn');
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
$('loginShow').addEventListener('click', () => {
  const pw = $('loginPassword');
  const show = pw.type === 'password';
  pw.type = show ? 'text' : 'password';
  $('loginShow').textContent = show ? 'Hide' : 'Show';
  $('loginShow').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
});

// ---------- "put it on the home screen" tip (shown once, after signing in) ----------
const TIP_KEY = 'canam.appTipDone';
let installPrompt = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; }); // Android Chrome
function maybeShowAppTip() {
  let done = false;
  try { done = !!localStorage.getItem(TIP_KEY); } catch { /* private mode */ }
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (done || standalone) return;
  const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  if (!iOS && !installPrompt) return;
  $('appTipMsg').textContent = iOS
    ? 'Tip: tap the Share button, then "Add to Home Screen", to open these numbers like an app.'
    : 'Tip: install this page to open your numbers like an app.';
  $('appTipInstall').hidden = iOS;
  $('appTip').hidden = false;
}
function closeAppTip() {
  $('appTip').hidden = true;
  try { localStorage.setItem(TIP_KEY, '1'); } catch { /* ignore */ }
}
$('appTipClose').addEventListener('click', closeAppTip);
$('appTipInstall').addEventListener('click', async () => {
  if (installPrompt) { installPrompt.prompt(); await installPrompt.userChoice.catch(() => {}); installPrompt = null; }
  closeAppTip();
});

boot();
