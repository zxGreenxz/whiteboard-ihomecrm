// Web Push (PWA notifications) — phía client.
// Đăng ký service worker, xin quyền, subscribe PushManager rồi lưu vào Supabase
// (bảng push_subscriptions). Edge function `send-push` đọc bảng này để gửi.
//
// VAPID public key là PUBLIC (an toàn để nhúng FE). Private key chỉ nằm trong
// Supabase secret của edge function. Có thể override qua VITE_VAPID_PUBLIC_KEY.

import { supabase } from '@/integrations/supabase/client';
import { getSessionUserId } from '@/lib/authSession';

export const VAPID_PUBLIC_KEY: string =
  (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined) ||
  'BO7WKT9NWAu87ilcP54yVYn8_M0DJX0UOpWC04dgEhu8X8s5lU0KIV9gjoPM3ejJ5v0Ify171gsnmtVjEz_7n-c';

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
  // push_subscriptions chưa có trong Database types (regen sau) → cast như pattern (supabase.rpc as any)
  const { error } = await (supabase as any).from('push_subscriptions').upsert(
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

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }
  await saveSubscription(sub);
  return 'granted';
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
  await (supabase as any).from('push_subscriptions').delete().eq('endpoint', endpoint);
}

/** Gọi edge function gửi thông báo thử về chính mình. */
export async function sendTestPush(): Promise<{ sent: number; total: number }> {
  const { data, error } = await supabase.functions.invoke('send-push', {
    body: {
      title: 'CRM — Thông báo thử 🔔',
      body: 'Nếu bạn thấy thông báo này thì push đã hoạt động!',
      url: '/',
      tag: 'test',
    },
  });
  if (error) throw error;
  return { sent: data?.sent ?? 0, total: data?.total ?? 0 };
}
