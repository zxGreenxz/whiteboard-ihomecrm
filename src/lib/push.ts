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
import { withOrg } from '@/lib/orgPayload';

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
  // for…of thay chỉ số: push.ts giờ nằm trong cây import của đảo nuia (useAuth nạp
  // lười nó khi đăng xuất), nơi `bytes[i]` có kiểu number | undefined.
  for (const byte of bytes) bin += String.fromCharCode(byte);
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

async function saveSubscription(sub: PushSubscription, actorId: string, organizationId: string | null | undefined): Promise<void> {
  if (await getSessionUserId() !== actorId) throw { code: 'PGRST301', message: 'User session changed' };
  const { p256dh, auth } = extractKeys(sub);
  if (!sub.endpoint || !p256dh || !auth) throw new TypeError('Malformed browser push subscription');
  const expected = { user_id: actorId, endpoint: sub.endpoint, p256dh, auth, is_active: true };
  const { data, error } = await supabase.from('push_subscriptions').upsert(
    withOrg({ ...expected, user_agent: navigator.userAgent }, organizationId), { onConflict: 'endpoint' },
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
export async function enablePush(organizationId: string | null | undefined): Promise<NotificationPermission | 'unsupported'> {
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
    await saveSubscription(sub, actorId, organizationId);
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

export type EnsurePushOutcome =
  | 'unsupported'
  | 'no-permission'
  | 'no-subscription'
  | 'other-key'
  | 'in-sync'
  | 'saved'
  | 'resubscribed';

/**
 * Đối chiếu đăng ký push của MÁY NÀY với máy chủ lúc khởi động (đã có phiên +
 * đã chốt công ty). Không bao giờ xin quyền, không tự bật push cho ai chưa bật.
 *
 * Vì sao cần (đo prod 21/10): từ 05/10 có 0 thiết bị active — send-push prune
 * (404/410) đặt is_active=false và không ai biết; trình duyệt xoay subscription
 * (pushsubscriptionchange) mà không tab nào mở thì dòng mới không bao giờ được lưu.
 *
 *   - chưa cấp quyền / không có subscription ⇒ không làm gì;
 *   - subscription theo khoá VAPID khác ⇒ để nút bật/tắt tự xoay khoá (enablePush);
 *   - máy chủ THIẾU dòng ⇒ lưu (subscription mới do pushsubscriptionchange);
 *   - dòng is_active=false ⇒ endpoint đã chết (prune): upsert lại là vô ích vì
 *     lần gửi sau bị prune tiếp — phải unsubscribe + subscribe MỚI rồi mới lưu;
 *   - dòng active nhưng khoá p256dh/auth lệch ⇒ lưu lại (upsert theo endpoint).
 * Lỗi được NÉM (kèm PushOperationError khi đã đụng trình duyệt) để bên gọi ghi lại.
 */
export async function ensurePushSubscription(organizationId: string | null | undefined): Promise<EnsurePushOutcome> {
  if (!isPushSupported()) return 'unsupported';
  if (Notification.permission !== 'granted') return 'no-permission';
  const registered = await navigator.serviceWorker.getRegistration();
  if (!registered) return 'no-subscription';
  const reg = await activeRegistration(registered);
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return 'no-subscription';
  const wantKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
  if (!sameApplicationServerKey(sub, wantKey)) return 'other-key';
  const actorId = await getSessionUserId();
  if (!actorId) throw { code: 'PGRST301', message: 'Not authenticated' };
  const stored = await readStoredSubscription(sub.endpoint, actorId);
  const keys = extractKeys(sub);
  if (stored?.is_active && stored.p256dh === keys.p256dh && stored.auth === keys.auth) return 'in-sync';
  if (!stored || stored.is_active) {
    try {
      await saveSubscription(sub, actorId, organizationId);
    } catch (cause) {
      throw new PushOperationError('Trình duyệt có đăng ký nhưng chưa lưu lại được trên máy chủ.',
        'unknown', cause, 'enable', sub.endpoint, actorId);
    }
    return 'saved';
  }
  await unsubscribeConfirmed(sub, 'enable', actorId);
  let fresh: PushSubscription | null = null;
  try {
    fresh = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wantKey });
    if (!fresh || !sameApplicationServerKey(fresh, wantKey)) throw new TypeError('Unconfirmed application server key');
    await saveSubscription(fresh, actorId, organizationId);
  } catch (cause) {
    throw new PushOperationError(fresh
      ? 'Đã tạo đăng ký mới thay đăng ký hết hạn; chưa xác nhận lưu trên máy chủ.'
      : 'Đăng ký hết hạn đã hủy; chưa tạo được đăng ký mới. Bật lại thông báo trong Cài đặt thông báo.',
      'partial', cause, 'enable', fresh?.endpoint ?? sub.endpoint, actorId);
  }
  // Dòng cũ trỏ endpoint đã chết: dọn để danh sách thiết bị không còn bóng ma. Hỏng
  // cũng không sao (đã is_active=false, send-push không gửi tới nữa). Trình duyệt trả
  // lại đúng endpoint cũ thì dòng đó chính là dòng vừa lưu — không được xoá.
  if (fresh.endpoint !== sub.endpoint) {
    const { error: cleanupError } = await supabase.from('push_subscriptions').delete()
      .eq('endpoint', sub.endpoint).eq('user_id', actorId);
    if (cleanupError) console.warn('[push] chưa dọn được đăng ký hết hạn cũ', cleanupError);
  }
  return 'resubscribed';
}

/** Giới hạn thời gian dọn push trước khi đăng xuất: không bao giờ giữ chân người dùng. */
export const LOGOUT_PUSH_CLEANUP_MS = 3000;

export type LogoutPushCleanup = 'removed' | 'none' | 'unsupported' | 'timeout' | 'failed';

/**
 * Gỡ đăng ký push của máy này TRƯỚC khi đăng xuất (còn phiên để xoá dòng của
 * chính mình). Best-effort: tối đa LOGOUT_PUSH_CLEANUP_MS, KHÔNG BAO GIỜ ném —
 * đăng xuất không được kẹt vì push.
 *
 * Vì sao: send-push gửi theo push_subscriptions.user_id, không biết máy đã đổi
 * người. Không gỡ thì máy dùng chung tiếp tục hiện trên màn khoá phiếu chờ duyệt
 * (kèm số tiền), việc được giao… của tài khoản vừa thoát; người đăng nhập sau
 * còn không bật được push vì endpoint đang thuộc dòng của người trước (RLS).
 * disablePush hủy ở trình duyệt TRƯỚC rồi mới xoá dòng: hỏng giữa chừng thì máy
 * vẫn thôi nhận push (dòng mồ côi sẽ bị prune ở lần gửi sau).
 */
export async function disablePushForLogout(timeoutMs: number = LOGOUT_PUSH_CLEANUP_MS): Promise<LogoutPushCleanup> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<LogoutPushCleanup>([
      disablePush().then((result) => (result === 'disabled' ? 'removed' : result === 'already-disabled' ? 'none' : 'unsupported')),
      new Promise<LogoutPushCleanup>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      }),
    ]);
  } catch (error) {
    console.warn('[push] chưa gỡ được đăng ký push trước khi đăng xuất', error);
    return 'failed';
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
  /**
   * `outcome` của send-push: SENT · DUPLICATE · PARTIAL · NO_DEVICE · ALL_FAILED ·
   * PROVIDER_ERROR. Đọc trường này, KHÔNG suy từ HTTP status (send-push §D.1a).
   */
  outcome: string;
}

/**
 * Mã HTTP mà send-push dùng cho kết quả GỬI THẬT (không phải lỗi gọi hàm), và
 * outcome hợp lệ đi kèm. supabase.functions.invoke biến mọi non-2xx thành error,
 * nên trước 21/10 NO_DEVICE/ALL_FAILED thành "lỗi chung" và UI không bao giờ tới
 * được nhánh "chưa có thiết bị"/"không gửi được N/M". 207 là 2xx nên đi đường data.
 */
const OUTCOME_THEO_HTTP: Readonly<Record<number, readonly string[]>> = {
  207: ['PARTIAL'],
  422: ['NO_DEVICE'],
  502: ['ALL_FAILED', 'PROVIDER_ERROR'],
};

function docKetQuaGuiThu(data: unknown): SendTestPushResult | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  const n = (key: string) => (Number.isSafeInteger(row[key]) && (row[key] as number) >= 0 ? (row[key] as number) : null);
  const sent = n('sent');
  const failed = n('failed');
  const total = n('total');
  const pruned = n('pruned');
  if (sent === null || failed === null || total === null || pruned === null) return null;
  if (sent + failed !== total || pruned > failed || typeof row.outcome !== 'string' || !row.outcome) return null;
  if (!Array.isArray(row.errors) || !row.errors.every((e: unknown) => e !== null && typeof e === 'object' &&
    typeof (e as Record<string, unknown>).host === 'string' && typeof (e as Record<string, unknown>).body === 'string')) return null;
  return { sent, failed, total, pruned, errors: row.errors as PushSendError[], outcome: row.outcome };
}

/** FunctionsHttpError.context là Response gốc; chỉ đọc body khi mã thuộc nhóm "kết quả gửi". */
async function ketQuaTuLoiHttp(error: unknown): Promise<SendTestPushResult | null> {
  const context = (error as { context?: unknown } | null)?.context;
  if (!context || typeof context !== 'object') return null;
  const status = (context as { status?: unknown }).status;
  const json = (context as { json?: unknown }).json;
  if (typeof status !== 'number' || typeof json !== 'function') return null;
  const allowed = OUTCOME_THEO_HTTP[status];
  if (!allowed) return null;
  let body: unknown;
  try {
    body = await (json as () => Promise<unknown>).call(context);
  } catch {
    return null;
  }
  const result = docKetQuaGuiThu(body);
  return result && allowed.includes(result.outcome) ? result : null;
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
    // NO_DEVICE / ALL_FAILED / PROVIDER_ERROR là KẾT QUẢ để UI giải thích, không
    // phải lỗi gọi hàm. Mọi lỗi khác (401, 400, 500, mạng) giữ nguyên lỗi gốc.
    const result = await ketQuaTuLoiHttp(error);
    if (result) return result;
    throw error;
  }
  const result = docKetQuaGuiThu(data);
  if (!result)
    throw new PushOperationError('Chưa xác nhận được kết quả gửi thử. Kiểm tra trạng thái thiết bị trước khi gửi tiếp.',
      'unknown', new TypeError('Malformed push test result'), 'enable');
  return result;
}
