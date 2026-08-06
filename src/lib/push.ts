// Web Push (PWA notifications) — phía client.
// Đăng ký service worker, xin quyền, subscribe PushManager rồi lưu vào Supabase
// (bảng push_subscriptions). Edge function `send-push` đọc bảng này để gửi.
//
// VAPID public key là PUBLIC (an toàn để nhúng FE). Private key chỉ nằm trong
// Supabase secret của edge function. Có thể override qua VITE_VAPID_PUBLIC_KEY.

import { supabase } from '@/integrations/supabase/client';
import { getSessionUserId } from '@/lib/authSession';

// Xoay khoá 29/07/2026: cặp cũ (BO7WKT9NW…) chưa từng chứng minh giao được tin nào và
// không đối chiếu được nửa private. Vì push_subscriptions đang 0 dòng nên xoay tốn 0 đồng.
// Nếu xoay lại lần nữa: phải đổi CẢ ở đây VÀ ở Supabase secrets (VAPID_PUBLIC_KEY +
// VAPID_PRIVATE_KEY), rồi redeploy send-push. Subscription cũ tự đăng ký lại nhờ
// enablePush() so applicationServerKey (xem bên dưới).
export const VAPID_PUBLIC_KEY: string =
  (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined) ||
  'BF4cxKnCn4zWVOIZPZ0vT4NKH18_Bvx_3pv9jxpI8ePhi16yvdpMnbY95sa34vWq6YnzT_m2dN_RpsUu2k2fZV4';

const SW_URL = '/sw.js';

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** PWA đã chạy ở chế độ standalone (đã "Thêm vào màn hình chính")? */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    // iOS Safari
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ báo là Mac có cảm ứng
    (/Macintosh/.test(ua) && 'ontouchend' in document);
}

export function getPermission(): NotificationPermission | 'unsupported' {
  if (!isPushSupported()) return 'unsupported';
  return Notification.permission;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function bufToBase64Url(buf: ArrayBuffer | null): string {
  if (!buf) return '';
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Đăng ký service worker (idempotent). Trả registration hoặc null. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    const existing = await navigator.serviceWorker.getRegistration();
    if (existing) return existing;
    return await navigator.serviceWorker.register(SW_URL);
  } catch (e) {
    console.warn('[push] register SW failed', e);
    return null;
  }
}

export async function getExistingSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** Đã bật push trên thiết bị này (đã cấp quyền + có subscription)? */
export async function isSubscribed(): Promise<boolean> {
  if (!isPushSupported() || Notification.permission !== 'granted') return false;
  const sub = await getExistingSubscription();
  return !!sub;
}

function extractKeys(sub: PushSubscription): { p256dh: string; auth: string } {
  return {
    p256dh: bufToBase64Url(sub.getKey('p256dh')),
    auth: bufToBase64Url(sub.getKey('auth')),
  };
}

async function saveSubscription(sub: PushSubscription): Promise<void> {
  const userId = await getSessionUserId();
  if (!userId) throw new Error('Bạn chưa đăng nhập');
  const { p256dh, auth } = extractKeys(sub);
  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      user_id: userId,
      endpoint: sub.endpoint,
      p256dh,
      auth,
      user_agent: navigator.userAgent,
      is_active: true,
    },
    { onConflict: 'endpoint' },
  );
  if (error) throw error;
}

/**
 * Bật thông báo trên thiết bị này: xin quyền → subscribe → lưu Supabase.
 * Trả 'granted' | 'denied' | 'unsupported'.
 */
export async function enablePush(): Promise<NotificationPermission | 'unsupported'> {
  if (!isPushSupported()) return 'unsupported';

  const reg = (await registerServiceWorker()) || (await navigator.serviceWorker.ready);
  await navigator.serviceWorker.ready;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission;

  const wantKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
  let sub = await reg.pushManager.getSubscription();

  // Subscription gắn CHẾT vào applicationServerKey lúc đăng ký. Nếu khoá VAPID đã xoay
  // mà ta tái dùng subscription cũ thì mọi lần gửi ăn 403 vĩnh viễn và không bao giờ bị
  // prune (send-push chỉ prune 404/410). Phải huỷ rồi đăng ký lại bằng khoá hiện tại.
  if (sub && !sameApplicationServerKey(sub, wantKey)) {
    try {
      await sub.unsubscribe();
    } catch (e) {
      console.warn('[push] unsubscribe khoá cũ thất bại', e);
    }
    sub = null;
  }

  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: wantKey,
    });
  }
  await saveSubscription(sub);
  return 'granted';
}

/** Subscription hiện có được đăng ký bằng đúng khoá VAPID đang dùng? */
function sameApplicationServerKey(sub: PushSubscription, want: Uint8Array): boolean {
  const raw = sub.options?.applicationServerKey;
  // Không đọc được options (trình duyệt cũ) → coi như KHÁC để buộc đăng ký lại: an toàn hơn
  // là giữ một subscription có thể đã lệch khoá.
  if (!raw) return false;
  const have = new Uint8Array(raw as ArrayBuffer);
  if (have.length !== want.length) return false;
  for (let i = 0; i < have.length; i++) if (have[i] !== want[i]) return false;
  return true;
}

/** Tắt thông báo trên thiết bị này: huỷ subscription + dọn DB. */
export async function disablePush(): Promise<void> {
  if (!isPushSupported()) return;
  const sub = await getExistingSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  try {
    await sub.unsubscribe();
  } catch (e) {
    console.warn('[push] unsubscribe failed', e);
  }
  await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
}

export interface PushSendError {
  status?: number;
  host: string;
  body: string;
}

export interface SendTestPushResult {
  sent: number;
  failed: number;
  total: number;
  pruned: number;
  errors: PushSendError[];
}

/** Gọi edge function gửi thông báo thử về chính mình. */
export async function sendTestPush(): Promise<SendTestPushResult> {
  const { data, error } = await supabase.functions.invoke('send-push', {
    body: {
      title: 'CRM — Thông báo thử 🔔',
      body: 'Nếu bạn thấy thông báo này thì push đã hoạt động!',
      url: '/',
      tag: 'test',
    },
  });

  if (error) {
    // supabase-js chỉ để lại "Edge Function returned a non-2xx status code" ở .message;
    // thân phản hồi thật nằm trong error.context và trước đây bị vứt đi.
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      try {
        const detail = await ctx.json();
        throw new Error(detail?.error ? String(detail.error) : JSON.stringify(detail).slice(0, 300));
      } catch (parseErr) {
        if (parseErr instanceof Error && parseErr.message !== 'Unexpected end of JSON input') {
          throw parseErr;
        }
      }
    }
    throw error;
  }

  return {
    sent: data?.sent ?? 0,
    failed: data?.failed ?? 0,
    total: data?.total ?? 0,
    pruned: data?.pruned ?? 0,
    errors: Array.isArray(data?.errors) ? (data.errors as PushSendError[]) : [],
  };
}
