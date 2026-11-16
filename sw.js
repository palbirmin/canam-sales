// Phone page service worker (version 1.11.0): shows the closing dough-count reminder and, since
// version 1.19.0, the "dough is running low" notice, and opens the Dough tab when one is tapped.
// Nothing else: it keeps no copies of the page (no offline caching), so the page always loads fresh
// from GitHub Pages.

const home = () => self.registration.scope; // https://palbirmin.github.io/canam-sales/

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// A notice from the dough-reminder Edge Function: { title, body, url, tag, kind } (kind 'low' = running low).
self.addEventListener('push', (e) => {
  let msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch { msg = { body: e.data ? e.data.text() : '' }; }
  const url = new URL(msg.url || '#dough', home()).href;
  e.waitUntil(self.registration.showNotification(msg.title || 'Dough count', {
    body: msg.body || 'Count what\'s left before closing.',
    tag: msg.tag || 'dough-count', // a newer reminder replaces the older one
    renotify: true,
    icon: new URL('icons/app-192.png', home()).href,
    badge: new URL('icons/app-192.png', home()).href,
    data: { url, kind: msg.kind === 'low' ? 'low' : 'count' },
  }));
});

// Tapped: bring the page to the front if it's already open (and tell it to open the count, or for a
// running-low notice just the Dough tab), otherwise open it on the Dough tab.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || new URL('#dough', home()).href;
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const page = open.find((c) => c.url.startsWith(home()));
    if (page) {
      await page.focus().catch(() => {});
      page.postMessage({ type: e.notification.data?.kind === 'low' ? 'canam:open-dough' : 'canam:closing-count', url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
