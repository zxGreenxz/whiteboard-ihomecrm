/* Service Worker — Web Push cho PWA "CRM".
 * Chỉ lo NHẬN push + click thông báo. KHÔNG cache/intercept fetch (tránh đụng
 * cơ chế chunk-reload + Cache-Control no-cache hiện có của app).
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Nhận đẩy → hiện thông báo trên thanh trạng thái
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_e) {
    payload = { title: 'CRM', body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'CRM';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/pwa-192.png',
    badge: payload.badge || '/pwa-192.png',
    tag: payload.tag || undefined,
    renotify: !!payload.tag,
    data: { url: payload.url || '/', ...(payload.data || {}) },
  };

  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, options);
      // Báo cho các tab đang mở (phục vụ test E2E + cập nhật UI realtime)
      const clientsArr = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientsArr) {
        client.postMessage({ type: 'push-received', payload });
      }
    })(),
  );
});

// Bấm vào thông báo → focus tab đang mở hoặc mở tab mới tới url
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of all) {
        const url = new URL(client.url);
        if (url.pathname === targetUrl || client.url.includes(targetUrl)) {
          if ('focus' in client) return client.focus();
        }
      }
      // Không có tab khớp → focus tab đầu rồi điều hướng, hoặc mở mới
      if (all.length > 0 && 'navigate' in all[0]) {
        await all[0].focus();
        try { return all[0].navigate(targetUrl); } catch (_e) { /* fallthrough */ }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })(),
  );
});
