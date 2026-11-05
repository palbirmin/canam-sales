// Phone page: sign in, then show the add-on's own dashboard with numbers read from Supabase.
import { CONFIG } from './config.js';
import { todayKey, addDays } from './lib.js';
import { makeSupa, AuthError } from './supa.js';
import { loginEmail } from './login-name.js';

const P = CONFIG.phone;
// Version 1.12.0: ?demo=1 shows the page with made-up sales and sample expenses and no sign-in, but only
// when the page is opened from this computer (localhost), for checking changes before publishing. On the
// published page, ?demo=1 only makes the Finances tab use its sample expenses after the owner signs in.
const PARAMS = new URLSearchParams(location.search);
const DEMO = PARAMS.get('demo') === '1';
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
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
  me = { role, name };
  const store = makeRemoteStore({ kitchen: role === 'kitchen', email: (await supa.session())?.email || '', name });
  await store.pull();
  globalThis.canamRemoteStore = store;
  document.body.classList.remove('locked');
  await import('./dashboard.js');
  // the Finances tab (version 1.12.0): the owner only; employee logins never load it
  if (role === 'owner') (await import('./finance.js')).initFinance({ store, supa, demo: DEMO });
  store.start();
  tipReady = true;
  setTimeout(maybeShowAppTip, 4000);
  initReminder();
}

// The no-sign-in demo on this computer: the add-on's own made-up numbers (preview-data.js) and sample
// expenses. Nothing is read from or written to Supabase.
async function openDemo() {
  me = { role: 'owner', name: 'Owner' };
  const { makePreviewStore } = await import('./preview-data.js');
  const store = { ...makePreviewStore(), kitchen: false, email: 'demo', name: 'Owner', start() {}, pull: async () => true, signOut: async () => {} };
  globalThis.canamRemoteStore = store;
  document.body.classList.remove('locked');
  await import('./dashboard.js');
  (await import('./finance.js')).initFinance({ store, supa: null, demo: true });
}

async function boot() {
  if (DEMO && LOCAL) return openDemo();
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

// ---------- closing dough-count reminder (version 1.11.0) ----------
// The owner kept forgetting the count at night. A phone that taps "Remind this phone before closing"
// on the Dough tab gets a notification 20 minutes before closing and again at closing, but only while
// tonight's "Left at closing" count is missing. The phone's push address goes in the table
// push_subscriptions (each login sees only its own); the dough-reminder Edge Function
// (phone/dough-reminder.ts) sends the reminders, and sw.js shows them. This is the public half of the
// VAPID key pair (fine to publish); the private half is only in Supabase (table app_config).
const VAPID_PUBLIC_KEY = 'BHOOUhKXSRBZVRmQUyESr_9RZv0HALHhSRonl9VIirvr2MhcUekA8E8Jb-NZjAxVp2rKVbjCWROy8y5-tejf4eg';
const PUSH_KEY = 'canam.pushEndpoint'; // this phone's push address, once it's set up
let me = { role: 'owner', name: '' };

// The service worker (sw.js) only shows reminders and opens the Dough tab; it keeps no copies of the page.
// (Not in the no-sign-in demo, which has no reminders.)
const swReg = 'serviceWorker' in navigator && !(DEMO && LOCAL)
  ? navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => null)
  : Promise.resolve(null);
// A reminder tapped while the page is already open: go to the closing count (dashboard.js listens).
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'canam:closing-count') dispatchEvent(new Event('canam:closing-count'));
});

const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const keyBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const savedEndpoint = () => { try { return localStorage.getItem(PUSH_KEY) || ''; } catch { return ''; } };
const saveEndpoint = (v) => { try { if (v) localStorage.setItem(PUSH_KEY, v); else localStorage.removeItem(PUSH_KEY); } catch { /* private mode */ } };
// a push address made with an older key can't get our reminders
function madeWithOurKey(sub) {
  const k = sub.options?.applicationServerKey;
  if (!k) return true;
  const a = new Uint8Array(k), b = keyBytes(VAPID_PUBLIC_KEY);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

const REMIND_TEXT = {
  ios: `On iPhone, reminders only work when this page is opened from its home-screen icon. Tap the Share button ${SHARE_ICON}, then <b>Add to Home Screen</b>, open Can Am from the new icon and come back here.`,
  iosOld: 'This iPhone can\'t show reminders from a web page. It needs iOS 16.4 or newer (Settings → General → Software Update).',
  unsupported: 'This browser can\'t show reminders. On Android use Chrome; on iPhone open the page from its home-screen icon.',
  denied: 'Notifications are turned off for this page. Turn them on in the phone\'s settings (iPhone: Settings → Notifications → Can Am; Android: Settings → Apps → Chrome → Notifications), then tap the button again.',
  off: 'Get a reminder on this phone when tonight\'s dough count hasn\'t been entered: 20 minutes before closing, and again at closing. The phone asks once to <b>Allow</b> notifications.',
  on: 'This phone gets a reminder when tonight\'s closing count is missing: at 9:40 PM (Friday and Saturday 10:40 PM), 20 minutes before closing, and again at closing.',
  error: 'The reminder isn\'t set up on this phone.',
};
// Version 1.11.1 (owner, 2026-10-25): the reminder is required on every phone. Until this phone has
// it, a warning banner sits at the top of the page, on every tab, with no way to close it. It goes
// away only once the phone is set up, and comes back if the phone's push address is gone or
// notifications were turned off (checked every time the page is opened or comes back into view).
const BANNER_TEXT = {
  off: () => (me.role === 'owner' ? '<b>Turn on closing reminders on this phone.</b>'
    : '<b>Closing reminders are required.</b> Turn them on for this phone.'),
  ios: () => `<b>${me.role === 'owner' ? 'Turn on closing reminders on this phone.' : 'Closing reminders are required on every phone.'}</b> ${REMIND_TEXT.ios}`,
  iosOld: () => `<b>Closing reminders can't be turned on here.</b> ${REMIND_TEXT.iosOld}`,
  unsupported: () => `<b>Closing reminders can't be turned on here.</b> ${REMIND_TEXT.unsupported}`,
  denied: () => (isIOS()
    ? '<b>Notifications are blocked for Can Am on this iPhone, so closing reminders can\'t show.</b> The page can\'t ask again: open Settings → Notifications → Can Am, turn on Allow Notifications, then come back and tap Turn on reminders.'
    : isAndroid()
      ? '<b>Notifications are blocked for this page, so closing reminders can\'t show.</b> The page can\'t ask again: tap the icon left of the web address (or ⋮ → Settings → Site settings → Notifications), allow notifications for this site, then tap Turn on reminders.'
      : '<b>Notifications are blocked for this page, so closing reminders can\'t show.</b> The page can\'t ask again: click the icon left of the web address, allow notifications for this site, then click Turn on reminders.'),
};
BANNER_TEXT.error = BANNER_TEXT.off;
function remindBanner() {
  let el = $('remindBanner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'remindBanner';
    el.className = 'alert warning remind-banner';
    el.setAttribute('role', 'alert');
    el.innerHTML = '<span class="ico" aria-hidden="true">!</span><div class="msg"></div><button class="btn" type="button">Turn on reminders</button>';
    el.querySelector('button').addEventListener('click', turnOn);
    const main = document.querySelector('main');
    main?.insertBefore(el, main.firstChild); // above the alerts, which dashboard.js redraws
  }
  return el;
}
function showBanner(state) {
  const el = remindBanner();
  el.hidden = state === 'on';
  if (el.hidden) return;
  el.querySelector('.msg').innerHTML = BANNER_TEXT[state]();
  el.querySelector('.btn').hidden = !['off', 'denied', 'error'].includes(state);
  el.querySelector('.btn').disabled = false;
}

function showReminder(state, note = '') {
  showBanner(state);
  $('remindMsg').innerHTML = REMIND_TEXT[state];
  $('remindOn').hidden = !['off', 'denied', 'error'].includes(state);
  $('remindOff').hidden = state !== 'on';
  $('remindTest').hidden = state !== 'on' || me.role !== 'owner'; // the test goes to the owner's own phones
  for (const b of document.querySelectorAll('.remind-btns .btn')) b.disabled = false;
  $('remindNote').textContent = note;
}
function reminderBusy(note) {
  for (const b of document.querySelectorAll('.remind-btns .btn, .remind-banner .btn')) b.disabled = true;
  $('remindNote').textContent = note;
}

let reminderReady = false;
let reminderBusyNow = false; // a tap on Turn on / Stop is in progress: don't redraw over it
async function initReminder() {
  if (!$('remindCard')) return;
  $('remindCard').hidden = false;
  reminderReady = true;
  await checkReminder();
}
// What the phone itself says, every time: the push address, the permission, and that the database
// still has this phone (dough-reminder drops addresses the push service refuses).
async function checkReminder() {
  if (!reminderReady || reminderBusyNow) return;
  if (!pushSupported()) return showReminder(isIOS() ? (standalone() ? 'iosOld' : 'ios') : 'unsupported');
  if (Notification.permission === 'denied') { saveEndpoint(''); return showReminder('denied'); }
  const reg = await swReg;
  const sub = await reg?.pushManager.getSubscription().catch(() => null);
  let on = !!sub && Notification.permission === 'granted' && sub.endpoint === savedEndpoint() && madeWithOurKey(sub);
  if (on) {
    const rows = await supa.rest('GET', `push_subscriptions?select=id&endpoint=eq.${encodeURIComponent(sub.endpoint)}`).catch(() => null);
    if (rows && !rows.length) on = false; // no signal: trust the phone until next time
  }
  if (reminderBusyNow) return;
  if (!on) saveEndpoint('');
  showReminder(on ? 'on' : 'off');
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkReminder(); });

// A short, plain description of the device for the owner's list ("iPhone", "Android phone"), nothing personal.
function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/iPhone|iPod/.test(ua)) return 'iPhone';
  if (isAndroid()) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  return 'Computer';
}

async function saveSubscription(sub) {
  const j = sub.toJSON();
  const label = deviceLabel(); // version 1.11.1: the device only; the owner's list shows whose it is
  // user_id is filled in by the database (the signed-in login)
  await supa.rest('POST', 'push_subscriptions?on_conflict=endpoint',
    [{ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, label, fails: 0 }], 'resolution=merge-duplicates,return=minimal');
}

// The card's button and the banner's button do the same thing.
async function turnOn() {
  // asked straight from the tap: an iPhone only shows the Allow question then
  const asked = Promise.resolve(Notification.requestPermission());
  reminderBusy('Setting up…');
  reminderBusyNow = true;
  try {
    const perm = (await asked) || Notification.permission;
    if (perm === 'denied') return showReminder('denied');
    if (perm !== 'granted') return showReminder('off', 'Tap Allow when the phone asks, so the reminder can show.');
    const reg = await swReg;
    if (!reg) throw new Error('the page\'s notification helper didn\'t start. Reload the page and try again.');
    await navigator.serviceWorker.ready;
    const fresh = () => reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) });
    let sub = await reg.pushManager.getSubscription();
    if (sub && !madeWithOurKey(sub)) { await sub.unsubscribe(); sub = null; }
    sub ||= await fresh();
    try {
      await saveSubscription(sub);
    } catch {
      // this phone was set up under another login before: give it a new push address and try once more
      await sub.unsubscribe().catch(() => {});
      sub = await fresh();
      await saveSubscription(sub);
    }
    saveEndpoint(sub.endpoint);
    showReminder('on', me.role === 'owner' ? 'Done. Tap Send a test to check it.' : 'Done.');
  } catch (e) {
    showReminder('error', `Couldn't set up the reminder: ${e.message || e}`);
  } finally {
    reminderBusyNow = false;
  }
}
$('remindOn').addEventListener('click', turnOn);

$('remindOff').addEventListener('click', async () => {
  reminderBusy('Stopping…');
  reminderBusyNow = true;
  try {
    const sub = await (await swReg)?.pushManager.getSubscription();
    const endpoint = sub?.endpoint || savedEndpoint();
    if (endpoint) await supa.rest('DELETE', `push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`);
    await sub?.unsubscribe().catch(() => {});
    saveEndpoint('');
    showReminder('off', 'Reminders stopped on this phone.');
  } catch (e) {
    showReminder('on', `Couldn't stop them: ${e.message || e}`);
  } finally {
    reminderBusyNow = false;
  }
});

$('remindTest').addEventListener('click', async () => {
  reminderBusy('Sending a test…');
  try {
    const r = await supa.fn('dough-reminder', { test: true });
    showReminder('on', r.sent
      ? `Test sent to ${r.sent === 1 ? 'your phone' : `your ${r.sent} phones`}. It should show in a few seconds.`
      : r.note || 'The test didn\'t reach this phone. Tap Stop reminders, then set it up again.');
  } catch (e) {
    showReminder('on', `Couldn't send a test: ${e.message || e}`);
  }
});

boot();
