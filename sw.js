/* Better View Pro — service worker for Web Push
   Host this file at the SITE ROOT: https://sign.betterview.homes/sw.js
   (A service worker can only control pages at or below its own path, so it
    must sit at the root to cover /app.html.) */

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { body: event.data ? event.data.text() : '' }; }

  const title = data.title || 'Better View Pro';
  const options = {
    body: data.body || '',
    tag: data.tag || 'bvp',          // same tag collapses duplicates
    data: { url: data.url || '/app.html' },
    icon: data.icon,                 // optional
    badge: data.badge,               // optional
    requireInteraction: false,
    vibrate: [120, 60, 120],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/app.html';
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes('app.html') && 'focus' in c) return c.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
