/* Service Worker — Web Push cho PWA "CRM".
 * Chỉ lo NHẬN push + click thông báo + giữ đăng ký push sống. KHÔNG cache/intercept
 * fetch (tránh đụng cơ chế chunk-reload + Cache-Control no-cache hiện có của app).
 *
 * File TĨNH, không qua bundler: không import được module của app. Test nạp file này
 * với `self` giả: src/lib/__tests__/serviceWorker.handlers.test.ts.
 *
 * Hợp đồng với app (cầu nối: src/lib/push/serviceWorkerBridge.tsx), 21/10/2026 — C3:
 *   push                      → hiện thông báo + postMessage {type:'push-received', payload}
 *   notificationclick         → có tab cùng origin: focus + postMessage {type:'notification-click',
 *                               url, notificationIds, organizationId} (app tự đánh dấu đã đọc,
 *                               đổi công ty nếu cần, điều hướng SPA — KHÔNG tải lại trang đang
 *                               nhập dở). Tab không xác nhận (bản app cũ) ⇒ navigate như trước.
 *                               Không có tab: openWindow(url?__pn=<ids>&__porg=<id>).
 *   pushsubscriptionchange    → subscribe lại bằng applicationServerKey cũ + postMessage
 *                               {type:'push-subscription-changed', endpoint, oldEndpoint}
 *                               để app lưu dòng mới (endpoint null ⇒ app tự subscribe lại).
 *
 * Tham số mở app `__pn` (id thông báo) / `__porg` (công ty) là khoá RIÊNG của cầu nối:
 * không route nào dùng. Từng dùng `notif`/`org` và đụng `?org=` của trang báo cáo KQKD
 * (cầu nối gỡ, trang ghi lại ⇒ replace URL vô hạn + đổi công ty toàn cục — NOTIF-CLIENT-1).
 * Đổi tên ở đây thì đổi cùng THAM_SO_* trong src/lib/push/swMessages.ts.
 */

// Đích dự phòng khi url lạ/khác origin — trang ai đăng nhập cũng vào được.
const FALLBACK_URL = '/my-day';
// Payload push (send-push) mang tối đa 20 id; giữ biên rộng hơn một chút.
const MAX_IDS = 50;
// Chờ tab xác nhận đã nhận notification-click. Tab chạy bản app cũ (chưa có cầu nối)
// sẽ im lặng ⇒ quá hạn thì điều hướng kiểu cũ để bấm push không thành "không làm gì".
const ACK_TIMEOUT_MS = 1500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Khớp THAM_SO_ID_THONG_BAO / THAM_SO_CONG_TY ở src/lib/push/swMessages.ts.
const PARAM_IDS = '__pn';
const PARAM_ORG = '__porg';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/** url tương đối cùng origin (path+query+hash); khác origin/hỏng ⇒ FALLBACK_URL. */
function normalizeUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '/';
  try {
    const url = new URL(raw.trim(), self.location.origin);
    if (url.origin !== self.location.origin) return FALLBACK_URL;
    return url.pathname + url.search + url.hash;
  } catch (_e) {
    return FALLBACK_URL;
  }
}

function cleanIds(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const id of raw) {
    if (typeof id === 'string' && UUID_RE.test(id) && !out.includes(id)) out.push(id);
    if (out.length >= MAX_IDS) break;
  }
  return out;
}

function cleanOrg(raw) {
  return typeof raw === 'string' && UUID_RE.test(raw) ? raw : null;
}

function windowClients() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
}

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
      // Báo cho các tab đang mở (phục vụ test E2E + làm tươi chuông ngay)
      const clientsArr = await windowClients();
      for (const client of clientsArr) {
        client.postMessage({ type: 'push-received', payload });
      }
    })(),
  );
});

/** Gửi tin cho tab và chờ tab trả lời qua MessageChannel; false nếu quá hạn. */
function postWithAck(client, message) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    try {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => finish(true);
      client.postMessage(message, [channel.port2]);
    } catch (_e) {
      finish(false);
      return;
    }
    setTimeout(() => finish(false), ACK_TIMEOUT_MS);
  });
}

function pickClient(all) {
  return all.find((c) => c.focused) || all.find((c) => c.visibilityState === 'visible') || all[0] || null;
}

function launchUrl(url, ids, organizationId) {
  const target = new URL(url, self.location.origin);
  if (ids.length > 0) target.searchParams.set(PARAM_IDS, ids.join(','));
  if (organizationId) target.searchParams.set(PARAM_ORG, organizationId);
  return target.pathname + target.search + target.hash;
}

// Bấm vào thông báo → giao cho tab đang mở (SPA), hoặc mở tab mới mang id để đánh dấu đọc
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = normalizeUrl(data.url);
  const notificationIds = cleanIds(data.notificationIds);
  const organizationId = cleanOrg(data.organizationId);

  event.waitUntil(
    (async () => {
      const all = await windowClients();
      const client = pickClient(all);
      if (client) {
        try {
          if ('focus' in client) await client.focus();
        } catch (_e) { /* focus bị chặn vẫn giao tin được */ }
        const acked = await postWithAck(client, { type: 'notification-click', url, notificationIds, organizationId });
        if (acked) return;
        if ('navigate' in client) {
          try {
            await client.navigate(launchUrl(url, notificationIds, organizationId));
            return;
          } catch (_e) { /* tab không do SW này điều khiển: mở tab mới */ }
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(launchUrl(url, notificationIds, organizationId));
    })(),
  );
});

// Trình duyệt xoay/thu hồi đăng ký push → đăng ký lại bằng đúng khoá cũ và báo app lưu
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription || null;
      let fresh = event.newSubscription || null;
      const key = old && old.options ? old.options.applicationServerKey : null;
      if (!fresh && key) {
        try {
          fresh = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        } catch (_e) {
          fresh = null;
        }
      }
      // Không có tab nào: lần mở app sau, ensurePushSubscription() đối chiếu và lưu.
      const all = await windowClients();
      for (const client of all) {
        client.postMessage({
          type: 'push-subscription-changed',
          endpoint: fresh ? fresh.endpoint : null,
          oldEndpoint: old ? old.endpoint : null,
        });
      }
    })(),
  );
});
