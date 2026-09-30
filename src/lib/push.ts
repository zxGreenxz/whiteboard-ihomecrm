// Web Push (PWA notifications) — phía client.
// Đăng ký service worker, xin quyền, subscribe PushManager rồi lưu vào Supabase
// (bảng push_subscriptions). Edge function `send-push` đọc bảng này để gửi.
//
// VAPID public key là PUBLIC (an toàn để nhúng FE). Private key chỉ nằm trong
// Supabase secret của edge function. Có thể override qua VITE_VAPID_PUBLIC_KEY.

import { supabase } from '@/integrations/supabase/client';
import { getSessionUserId } from '@/lib/authSession';
import { FinancialWorkflowError } from '@/lib/financialWorkflowError';
import { requireAccountWriteReceipt } from '@/lib/accountSettingsWriteReceipt';

export class PushOperationError extends FinancialWorkflowError {
  constructor(message: string, outcome: 'partial' | 'unknown', cause: unknown,
    readonly operation: 'enable' | 'disable', readonly endpoint?: string, readonly actorId?: string) {
    super(message, outcome, [], cause);
  }
}


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

/* Registration errors must reach an interactive caller; bootstrap owns background logging. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  const existing = await navigator.serviceWorker.getRegistration();
  return existing || await navigator.serviceWorker.register(SW_URL);
}

async function activeRegistration(reg: ServiceWorkerRegistration): Promise<ServiceWorkerRegistration> {
  if (reg.active) return reg;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const active = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PushOperationError(
          'Trình duyệt chưa xác nhận kích hoạt thông báo. Giữ trạng thái chưa xác định và kiểm tra lại.',
          'unknown', new TypeError('Service worker activation timed out'), 'enable')), 10000);
      }),
    ]);
    if (!active?.active) throw new TypeError('Unconfirmed active service worker');
    return active;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function getExistingSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return null;
  return (await activeRegistration(reg)).pushManager.getSubscription();
}

async function readStoredSubscription(endpoint: string, actorId: string) {
  const { data, error } = await supabase.from('push_subscriptions')
    .select('id,user_id,endpoint,p256dh,auth,is_active')
    .eq('endpoint', endpoint).eq('user_id', actorId).maybeSingle();
  if (error) throw error;
  if (data === null) return null;
  requireAccountWriteReceipt(data, { user_id: actorId, endpoint });
  if (typeof data.is_active !== 'boolean' || typeof data.p256dh !== 'string' || !data.p256dh || typeof data.auth !== 'string' || !data.auth)
    throw new TypeError('Malformed stored push subscription');
  return data;
}

/** Read native and own server registration; pending cleanup is never cleared from native absence alone. */
export async function isSubscribed(pending?: unknown): Promise<boolean> {
  if (!isPushSupported()) return false;
  const sub = await getExistingSubscription();
  const previous = pending instanceof PushOperationError ? pending : null;
  if (previous?.operation === 'disable' && previous.endpoint) {
    const actorId = await getSessionUserId();
    if (!actorId || actorId !== previous.actorId) throw previous;
    const stored = await readStoredSubscription(previous.endpoint, actorId);
    if (stored || sub?.endpoint === previous.endpoint) throw previous;
    return false;
  }
  if (Notification.permission !== 'granted' || !sub) return false;
  if (!sameApplicationServerKey(sub, urlBase64ToUint8Array(VAPID_PUBLIC_KEY))) return false;
  const actorId = await getSessionUserId();
  if (!actorId) throw { code: 'PGRST301', message: 'Not authenticated' };
  const stored = await readStoredSubscription(sub.endpoint, actorId);
  const keys = extractKeys(sub);
  if (!stored || stored.p256dh !== keys.p256dh || stored.auth !== keys.auth)
    throw new PushOperationError('Trình duyệt có đăng ký nhưng chưa xác nhận được đăng ký tương ứng trên máy chủ. Kiểm tra lại trạng thái trước khi thay đổi tiếp.',
      'unknown', new TypeError('Unconfirmed server push subscription'), 'enable', sub.endpoint, actorId);
  return stored.is_active;
}

function extractKeys(sub: PushSubscription): { p256dh: string; auth: string } {
  return {
    p256dh: bufToBase64Url(sub.getKey('p256dh')),
    auth: bufToBase64Url(sub.getKey('auth')),
  };
}

async function saveSubscription(sub: PushSubscription, actorId: string): Promise<void> {
  if (await getSessionUserId() !== actorId) throw { code: 'PGRST301', message: 'User session changed' };
  const { p256dh, auth } = extractKeys(sub);
  if (!sub.endpoint || !p256dh || !auth) throw new TypeError('Malformed browser push subscription');
  const expected = { user_id: actorId, endpoint: sub.endpoint, p256dh, auth, is_active: true };
  const { data, error } = await supabase.from('push_subscriptions').upsert(
    { ...expected, user_agent: navigator.userAgent }, { onConflict: 'endpoint' },
  ).select('id,user_id,endpoint,p256dh,auth,is_active').single();
  if (error) throw error;
  requireAccountWriteReceipt(data, expected);
}

async function unsubscribeConfirmed(sub: PushSubscription, operation: 'enable' | 'disable', actorId: string): Promise<void> {
  try {
    const result = await sub.unsubscribe();
    if (result !== true) throw result;
  } catch (cause) {
    throw new PushOperationError('Chưa xác nhận được việc hủy đăng ký của trình duyệt. Không thay đổi đăng ký máy chủ; kiểm tra lại trạng thái thiết bị.',
      'unknown', cause, operation, sub.endpoint, actorId);
  }
}

/** Permission -> native subscription -> exact own server receipt; no provider delivery claim. */
export async function enablePush(): Promise<NotificationPermission | 'unsupported'> {
  if (!isPushSupported()) return 'unsupported';
  const actorId = await getSessionUserId();
  if (!actorId) throw { code: 'PGRST301', message: 'Not authenticated' };
  const registered = await registerServiceWorker();
  if (!registered) throw new TypeError('Unconfirmed service worker registration');
  const reg = await activeRegistration(registered);
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission;
  const wantKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
  let sub = await reg.pushManager.getSubscription();
  let removedOld = false;
  if (sub && !sameApplicationServerKey(sub, wantKey)) {
    await unsubscribeConfirmed(sub, 'enable', actorId);
    removedOld = true;
    sub = null;
  }
  try {
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wantKey });
    if (!sub || !sameApplicationServerKey(sub, wantKey)) throw new TypeError('Unconfirmed application server key');
    await saveSubscription(sub, actorId);
  } catch (cause) {
    throw new PushOperationError(sub
      ? 'Trình duyệt đã tạo đăng ký; chưa xác nhận lưu đúng đăng ký trên máy chủ. Giữ trạng thái chưa xác định và kiểm tra lại.'
      : removedOld ? 'Đăng ký cũ đã hủy; chưa xác nhận tạo đăng ký mới. Kiểm tra lại trạng thái thiết bị.'
      : 'Chưa xác nhận được đăng ký của trình duyệt. Kiểm tra lại trạng thái thiết bị.',
      sub || removedOld ? 'partial' : 'unknown', cause, 'enable', sub?.endpoint, actorId);
  }
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

/** Native unsubscribe must succeed before deleting its own exact server registration. */
export async function disablePush(): Promise<'disabled' | 'already-disabled' | 'unsupported'> {
  if (!isPushSupported()) return 'unsupported';
  const sub = await getExistingSubscription();
  if (!sub) return 'already-disabled';
  const actorId = await getSessionUserId();
  if (!actorId) throw { code: 'PGRST301', message: 'Not authenticated' };
  await unsubscribeConfirmed(sub, 'disable', actorId);
  try {
    if (await getSessionUserId() !== actorId) throw { code: 'PGRST301', message: 'User session changed' };
    const { data, error } = await supabase.from('push_subscriptions').delete()
      .eq('endpoint', sub.endpoint).eq('user_id', actorId).select('id,user_id,endpoint');
    if (error) throw error;
    if (!Array.isArray(data) || data.length !== 1) throw new TypeError('Unconfirmed push deletion receipt');
    requireAccountWriteReceipt(data[0], { user_id: actorId, endpoint: sub.endpoint });
  } catch (cause) {
    throw new PushOperationError('Thiết bị đã hủy đăng ký; chưa xác nhận dọn đăng ký trên máy chủ. Giữ trạng thái chưa xác định và kiểm tra lại.',
      'partial', cause, 'disable', sub.endpoint, actorId);
  }
  return 'disabled';
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

  if (error) throw error;
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      !['sent', 'failed', 'total', 'pruned'].every(key => Number.isSafeInteger(data[key]) && data[key] >= 0) ||
      data.sent + data.failed !== data.total || data.pruned > data.failed || !Array.isArray(data.errors) ||
      !data.errors.every((row: unknown) => row && typeof row === 'object' &&
        typeof (row as Record<string, unknown>).host === 'string' &&
        typeof (row as Record<string, unknown>).body === 'string'))
    throw new PushOperationError('Chưa xác nhận được kết quả gửi thử. Kiểm tra trạng thái thiết bị trước khi gửi tiếp.',
      'unknown', new TypeError('Malformed push test result'), 'enable');
  return { sent: data.sent, failed: data.failed, total: data.total, pruned: data.pruned, errors: data.errors as PushSendError[] };
}
