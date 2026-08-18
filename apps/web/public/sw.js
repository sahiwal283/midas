/* Midas service worker — web push delivery + notification click handling.
 * No fetch caching: the app stays network-served; this worker exists so the
 * browser can receive pushes and make the PWA installable. */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'Midas', body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'Midas';
  const options = {
    body: payload.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: payload.tag || undefined,
    data: { url: payload.url || '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil((async () => {
    // Reuse an open Midas tab if one can be focused and navigated; otherwise
    // open a new one. navigate() rejects on uncontrolled clients (e.g. after
    // a hard reload), so fall through to the next tab / a fresh window.
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      try {
        await client.focus();
        if (new URL(client.url).pathname !== url && 'navigate' in client) {
          await client.navigate(url);
        }
        return;
      } catch {
        // try the next client
      }
    }
    await self.clients.openWindow(url);
  })());
});
