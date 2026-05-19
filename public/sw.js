// Service worker for the Swish Menu app.
//
// Responsibilities:
//   1. Receive web-push payloads from the backend (web-push lib + VAPID keys)
//      and display them as system notifications.
//   2. Focus or open the app when a notification is clicked.
//
// Intentionally does NOT cache requests — the app is online-only.
// The frontend registers this at /sw.js from Dashboard.tsx on first mount.

self.addEventListener('install', (event) => {
  // Activate immediately so push handlers attach without waiting for old SW.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = { title: 'Swish Menu', body: 'You have a new notification', data: {} };
  if (event.data) {
    try {
      payload = { ...payload, ...event.data.json() };
    } catch (_err) {
      // Body wasn't JSON; use the raw text as the body.
      payload.body = event.data.text();
    }
  }

  const title = payload.title || 'Swish Menu';
  const options = {
    body: payload.body || '',
    icon: payload.icon || undefined,
    badge: payload.badge || undefined,
    tag: payload.tag || undefined,           // de-dupes same-tag notifications
    renotify: Boolean(payload.tag),          // re-buzz when tag matches
    requireInteraction: payload.requireInteraction !== false,
    data: payload.data || {},
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If the app is already open in a tab, focus it.
      for (const client of clientList) {
        if ('focus' in client) {
          try {
            client.focus();
            if ('navigate' in client && targetUrl !== '/') {
              client.navigate(targetUrl).catch(() => {});
            }
            return;
          } catch (_err) {
            // Continue to next client.
          }
        }
      }
      // No open tab — open a fresh one.
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
