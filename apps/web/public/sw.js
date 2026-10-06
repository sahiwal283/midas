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
    // Same tag replaces the earlier banner; without renotify the replacement
    // is silent, so a second message on one expense would never buzz.
    renotify: Boolean(payload.tag),
    data: { url: payload.url || '/', notificationId: payload.notificationId || null },
  };

  event.waitUntil((async () => {
    await self.registration.showNotification(title, options);
    // Let open tabs refresh the bell and dashboard right away.
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) client.postMessage({ type: 'midas:notification' });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.url || '/';

  event.waitUntil((async () => {
    // Tapping the push is reading it — clear the in-app badge to match.
    // Best-effort: a signed-out or offline device just leaves it unread.
    if (data.notificationId) {
      try {
        await fetch(`/api/v1/notifications/${data.notificationId}/read`, {
          method: 'POST',
          credentials: 'include',
        });
      } catch {
        // ignore
      }
    }

    // Reuse an open Midas tab if one can be focused and navigated; otherwise
    // open a new one. navigate() rejects on uncontrolled clients (e.g. after
    // a hard reload), so fall through to the next tab / a fresh window.
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      try {
        await client.focus();
        const current = new URL(client.url);
        if (current.pathname + current.hash !== url && 'navigate' in client) {
          await client.navigate(url);
        }
        client.postMessage({ type: 'midas:notification' });
        return;
      } catch {
        // try the next client
      }
    }
    await self.clients.openWindow(url);
  })());
});
