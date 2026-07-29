// Edge function: send-push  —  contract §D.1a (PR-4c)
// Gửi Web Push (PWA notification) tới mọi thiết bị đã "Bật thông báo" của 1 user.
//
// Hai chế độ gọi:
//   1) Service role (drain push, digest v5, worker nội bộ): Authorization = service_role key
//      → tin tưởng body.userId (gửi cho user bất kỳ) và BẮT BUỘC có body.idempotencyKey.
//   2) User JWT (nút "Gửi thông báo thử" trên web): xác thực token → CHỈ gửi cho chính người gọi
//      (bỏ qua body.userId để tránh spam người khác). KHÔNG bắt buộc idempotencyKey — hàm tự sinh
//      khoá namespace riêng `usr:<uid>:<uuid>` để bấm thử lần hai vẫn gửi được và KHÔNG BAO GIỜ
//      đụng khoá của drain (khoá drain là md5 hex từ notify_claim_push_batch_v1).
//
// 🚫 TUYỆT ĐỐI KHÔNG deploy hàm này với `--no-verify-jwt`.
//    jwtRole() bên dưới CHỈ base64-decode payload, KHÔNG kiểm chữ ký. Hôm nay an toàn vì cổng nền
//    tảng (verify_jwt=true) đã chặn JWT giả trước khi vào thân hàm — đã chứng minh: JWT bịa
//    {role:"service_role"} chữ ký rác ăn 401 UNAUTHORIZED_LEGACY_JWT ở đây, nhưng LỌT vào thân
//    salary-v5-jobs (hàm đó verify_jwt=false). Lật cờ = ai cũng tự xưng service_role và gửi push
//    cho bất kỳ ai. §B1 của plan dự kiến thêm gate scripts/check-edge-verify-jwt.mjs canh việc này
//    (chưa có trong repo lúc viết file này — 29/07/2026).
//
// KHÔNG BAO GIỜ suy trạng thái giao vận từ HTTP status — luôn đọc trường `outcome` trong body.
// `outcome:"SENT"` chỉ có nghĩa DỊCH VỤ PUSH ĐÃ NHẬN, KHÔNG chứng minh máy đã hiện thông báo.
//
// Secrets cần đặt (Supabase ▸ Edge Functions ▸ Secrets):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:... hoặc https URL)

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.81.1';
import webpush from 'npm:web-push@3.6.7';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  // x-supabase-api-version: supabase-js ≥2.79 gắn header này ở mọi functions.invoke; thiếu trong
  // allow-list là preflight rớt trên trình duyệt. x-request-id: cho phép caller truyền trace id.
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-api-version, x-request-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Expose-Headers': 'x-request-id',
  'Access-Control-Max-Age': '86400',
};

type Outcome =
  | 'SENT'
  | 'PARTIAL'
  | 'NO_DEVICE'
  | 'ALL_FAILED'
  | 'DUPLICATE'
  | 'PROVIDER_ERROR'
  | 'CONFIG_ERROR'
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED';

// §D.1a: 200 chỉ cho SENT/DUPLICATE · 207 PARTIAL · 422 NO_DEVICE ·
//        502 ALL_FAILED/PROVIDER_ERROR · 500 CONFIG_ERROR · 400/401 còn lại.
const HTTP_BY_OUTCOME: Record<Outcome, number> = {
  SENT: 200,
  DUPLICATE: 200,
  PARTIAL: 207,
  NO_DEVICE: 422,
  ALL_FAILED: 502,
  PROVIDER_ERROR: 502,
  CONFIG_ERROR: 500,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
};

type DeviceStatus = 'sent' | 'gone' | 'rejected' | 'error';

interface DeviceResult {
  id: string;
  host: string;
  status: DeviceStatus;
  httpStatus?: number;
  body?: string;
}

interface SendPushBody {
  idempotencyKey?: unknown;
  notificationIds?: unknown;
  userId?: unknown;
  title?: unknown;
  body?: unknown;
  url?: unknown;
  tag?: unknown;
  icon?: unknown;
  badge?: unknown;
  data?: Record<string, unknown>;
}

/** Trạng thái claim khoá khử trùng trong public.push_send_log. */
type DedupeState = 'claimed' | 'duplicate' | 'unavailable' | 'error';

const MAX_IDEM_KEY = 128;
const MAX_DEVICE_BODY = 300;
// Web Push aes128gcm: bản mã trần ~4 kB. Chừa chỗ cho padding/record overhead của web-push để
// không tự chuốc lấy 413 (413 = `rejected`, retryable=false ⇒ thông báo mất hẳn, không gửi lại).
const MAX_PAYLOAD_BYTES = 3500;

const utf8len = (s: string) => new TextEncoder().encode(s).length;

interface RespondArgs {
  outcome: Outcome;
  requestId: string;
  idempotencyKey: string | null;
  total?: number;
  sent?: number;
  failed?: number;
  pruned?: number;
  retryable?: boolean;
  devices?: DeviceResult[];
  /** Thông điệp người đọc được. Giữ tên `error` để push.ts (nhánh non-2xx) hiện đúng câu. */
  error?: string;
  note?: string;
  dedupe?: DedupeState;
}

function respond(args: RespondArgs): Response {
  const devices = args.devices ?? [];
  const status = HTTP_BY_OUTCOME[args.outcome];
  const payload: Record<string, unknown> = {
    outcome: args.outcome,
    idempotencyKey: args.idempotencyKey,
    requestId: args.requestId,
    total: args.total ?? devices.length,
    sent: args.sent ?? 0,
    failed: args.failed ?? 0,
    pruned: args.pruned ?? 0,
    retryable: args.retryable ?? false,
    devices,
    // ---- TƯƠNG THÍCH NGƯỢC, ĐỪNG XOÁ ----
    // src/lib/push.ts:229-235 đọc {sent, failed, total, pruned, errors[]}; salary-v5-jobs đọc res.ok.
    // devices[] là nguồn sự thật mới, errors[] chỉ là chiếu lại của các thiết bị KHÔNG gửi được.
    ok: status >= 200 && status < 300,
    errors: devices
      .filter((d) => d.status !== 'sent')
      .map((d) => ({ status: d.httpStatus, host: d.host, body: d.body ?? '' })),
  };
  if (args.error) payload.error = args.error;
  if (args.note) payload.note = args.note;
  if (args.dedupe) payload.dedupe = args.dedupe;

  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'x-request-id': args.requestId },
  });
}

/**
 * Phân loại lỗi provider → quyết định retry. KHÔNG đoán từ status đơn lẻ ở chỗ gọi.
 *   404/410      → gone     (subscription chết → prune, retryable=false)
 *   401/403/413  → rejected (lệch cặp VAPID hoặc payload >4 kB → gửi lại vẫn hỏng, KHÔNG đốt 3 lượt)
 *   429/5xx/mạng → error    (retryable=true)
 * 4xx lạ khác coi như `rejected` (lỗi ở phía ta, gửi lại vô ích); không có status = lỗi mạng → error.
 */
function classifyStatus(status?: number): Exclude<DeviceStatus, 'sent'> {
  if (status === 404 || status === 410) return 'gone';
  if (status === 401 || status === 403 || status === 413) return 'rejected';
  if (typeof status !== 'number' || !Number.isFinite(status)) return 'error';
  if (status === 429) return 'error';
  if (status >= 500) return 'error';
  if (status >= 400) return 'rejected';
  return 'error';
}

// Đọc claim `role` từ JWT (chữ ký đã được platform verify_jwt kiểm TRƯỚC khi vào đây)
// → 'service_role' = gọi nội bộ tin cậy; 'authenticated' = user thường.
// ⚠ Hàm này KHÔNG kiểm chữ ký. Xem cảnh báo --no-verify-jwt ở đầu file.
function jwtRole(token: string): string | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(atob(b64 + pad))?.role ?? null;
  } catch {
    return null;
  }
}

/**
 * Giữ chỗ khoá khử trùng TRƯỚC khi gửi (§D.1a).
 * `ignoreDuplicates:true` → PostgREST sinh `ON CONFLICT (idempotency_key) DO NOTHING`; đụng khoá
 * cũ thì .select() trả mảng rỗng ⇒ 'duplicate' ⇒ chỗ gọi KHÔNG gửi.
 */
async function claimIdempotency(
  admin: SupabaseClient,
  key: string,
  userId: string,
  requestId: string,
): Promise<DedupeState> {
  try {
    const { data, error } = await admin
      .from('push_send_log')
      .upsert(
        { idempotency_key: key, user_id: userId, outcome: 'SENDING', sent: 0 },
        { onConflict: 'idempotency_key', ignoreDuplicates: true },
      )
      .select('idempotency_key');

    if (error) {
      const code = String((error as { code?: string })?.code ?? '');
      if (code === '23505') return 'duplicate';
      // Bảng chưa có (migration chưa apply) hoặc schema cache PostgREST chưa reload → fail-open,
      // vì chặn cứng ở đây làm CHẾT toàn bộ push chỉ vì thứ tự deploy. Có cờ dedupe trong response
      // để người vận hành thấy ngay là đang chạy KHÔNG có khử trùng.
      if (code === '42P01' || code.startsWith('PGRST2')) {
        console.error('[send-push] push_send_log chưa sẵn sàng — chạy KHÔNG khử trùng',
          JSON.stringify({ requestId, code, message: error.message }));
        return 'unavailable';
      }
      console.error('[send-push] claim idempotency lỗi',
        JSON.stringify({ requestId, code, message: error.message }));
      return 'error';
    }
    return Array.isArray(data) && data.length > 0 ? 'claimed' : 'duplicate';
  } catch (e) {
    console.error('[send-push] claim idempotency ném',
      JSON.stringify({ requestId, message: String((e as Error)?.message ?? e) }));
    return 'error';
  }
}

/** Ghi outcome cuối vào sổ. Lỗi ở đây KHÔNG được làm hỏng kết quả gửi — chỉ log. */
async function finishLog(
  admin: SupabaseClient,
  dedupe: DedupeState,
  key: string,
  outcome: Outcome,
  sent: number,
  requestId: string,
): Promise<void> {
  if (dedupe !== 'claimed') return;
  const { error } = await admin
    .from('push_send_log')
    .update({ outcome, sent })
    .eq('idempotency_key', key);
  if (error) {
    console.error('[send-push] ghi outcome vào push_send_log lỗi',
      JSON.stringify({ requestId, key, outcome, message: error.message }));
  }
}

serve(async (req) => {
  const requestId = req.headers.get('x-request-id')?.slice(0, 64) || crypto.randomUUID();

  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return respond({
      outcome: 'BAD_REQUEST', requestId, idempotencyKey: null,
      error: 'Method not allowed — chỉ nhận POST',
    });
  }

  let idempotencyKey: string | null = null;
  let dedupe: DedupeState = 'unavailable';
  let admin: SupabaseClient | null = null;

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const vapidPublic = Deno.env.get('VAPID_PUBLIC_KEY');
    const vapidPrivate = Deno.env.get('VAPID_PRIVATE_KEY');
    const vapidSubject = Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@ptcrm.vercel.app';

    if (!supabaseUrl || !serviceKey || !anonKey) {
      return respond({
        outcome: 'CONFIG_ERROR', requestId, idempotencyKey: null,
        error: 'Thiếu SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY',
      });
    }
    if (!vapidPublic || !vapidPrivate) {
      return respond({
        outcome: 'CONFIG_ERROR', requestId, idempotencyKey: null,
        error: 'Thiếu VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY trong secrets',
      });
    }
    try {
      webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
    } catch (e) {
      // VAPID_SUBJECT sai định dạng hoặc khoá không phải P-256 → cấu hình sai, KHÔNG retryable.
      return respond({
        outcome: 'CONFIG_ERROR', requestId, idempotencyKey: null,
        error: `VAPID không hợp lệ: ${String((e as Error)?.message ?? e)}`,
      });
    }

    const authHeader = req.headers.get('Authorization') ?? '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) {
      return respond({
        outcome: 'UNAUTHORIZED', requestId, idempotencyKey: null, error: 'Missing authorization',
      });
    }

    const raw = await req.json().catch(() => null);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return respond({
        outcome: 'BAD_REQUEST', requestId, idempotencyKey: null,
        error: 'Body phải là JSON object',
      });
    }
    const body = raw as SendPushBody;

    // notificationIds: nhận + kiểm kiểu, dùng để log/đối soát với hàng đợi. CỐ Ý KHÔNG nhét vào
    // payload push — 100 UUID ≈ 3,7 kB, đủ đẩy payload qua trần 4 kB và ăn 413 (mất hẳn thông báo).
    // sw.js cũng không đọc trường này (public/sw.js:23-30).
    let notificationIds: string[] = [];
    if (body.notificationIds !== undefined && body.notificationIds !== null) {
      if (!Array.isArray(body.notificationIds) || body.notificationIds.some((x) => typeof x !== 'string')) {
        return respond({
          outcome: 'BAD_REQUEST', requestId, idempotencyKey: null,
          error: 'notificationIds phải là mảng chuỗi',
        });
      }
      notificationIds = body.notificationIds as string[];
    }

    admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const isService = token === serviceKey || jwtRole(token) === 'service_role';
    let targetUserId: string;

    if (isService) {
      if (typeof body.userId !== 'string' || !body.userId.trim()) {
        return respond({
          outcome: 'BAD_REQUEST', requestId, idempotencyKey: null,
          error: 'service role: body.userId bắt buộc',
        });
      }
      targetUserId = body.userId.trim();

      const k = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
      if (!k) {
        return respond({
          outcome: 'BAD_REQUEST', requestId, idempotencyKey: null,
          error: 'service role: body.idempotencyKey bắt buộc (§D.1a)',
        });
      }
      if (k.length > MAX_IDEM_KEY) {
        return respond({
          outcome: 'BAD_REQUEST', requestId, idempotencyKey: null,
          error: `idempotencyKey tối đa ${MAX_IDEM_KEY} ký tự`,
        });
      }
      idempotencyKey = k;
    } else {
      const callerClient = createClient(supabaseUrl, anonKey, {
        auth: { persistSession: false },
        global: { headers: { Authorization: `Bearer ${token}` } },
      });
      const { data: userData, error: userErr } = await callerClient.auth.getUser();
      const user = userData?.user ?? null;
      if (userErr || !user) {
        return respond({
          outcome: 'UNAUTHORIZED', requestId, idempotencyKey: null, error: 'Invalid session',
        });
      }
      targetUserId = user.id;
      // Namespace riêng cho nút "Gửi thử": KHÔNG dùng body.idempotencyKey của user thường, kẻo một
      // tài khoản bất kỳ đoán/đoạt khoá của drain rồi làm cả lô thông báo thật hoá DUPLICATE.
      idempotencyKey = `usr:${user.id}:${crypto.randomUUID()}`;
    }

    // ---- Khử trùng: giữ chỗ TRƯỚC khi gửi ----
    dedupe = await claimIdempotency(admin, idempotencyKey, targetUserId, requestId);
    if (dedupe === 'duplicate') {
      return respond({
        outcome: 'DUPLICATE', requestId, idempotencyKey, dedupe,
        total: 0, sent: 0, failed: 0, pruned: 0, retryable: false,
        note: 'Lượt gửi này đã được ghi nhận trước đó — không gửi lại',
      });
    }
    if (dedupe === 'error' && isService) {
      // Không giữ được chỗ ⇒ không dám gửi (gửi mà không có khoá = mở đường gửi trùng).
      // Chế độ user (nút Gửi thử) thì vẫn cho đi tiếp: không có rủi ro gửi trùng hàng loạt.
      return respond({
        outcome: 'PROVIDER_ERROR', requestId, idempotencyKey, dedupe,
        retryable: true, error: 'Không ghi được push_send_log — hoãn gửi để tránh trùng',
      });
    }

    // ---- Lấy thiết bị ----
    const { data: subs, error: subErr } = await admin
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .eq('user_id', targetUserId)
      .eq('is_active', true);

    if (subErr) {
      await finishLog(admin, dedupe, idempotencyKey, 'PROVIDER_ERROR', 0, requestId);
      return respond({
        outcome: 'PROVIDER_ERROR', requestId, idempotencyKey, dedupe,
        retryable: true, error: subErr.message,
      });
    }

    if (!subs || subs.length === 0) {
      await finishLog(admin, dedupe, idempotencyKey, 'NO_DEVICE', 0, requestId);
      return respond({
        outcome: 'NO_DEVICE', requestId, idempotencyKey, dedupe,
        total: 0, sent: 0, failed: 0, pruned: 0, retryable: false,
        error: 'Chưa có thiết bị nào bật thông báo',
        note: 'Chưa có thiết bị nào bật thông báo',
      });
    }

    // ---- Dựng payload, chặn 413 từ trước ----
    const title = typeof body.title === 'string' && body.title ? body.title : 'CRM';
    const url = typeof body.url === 'string' && body.url ? body.url : '/';
    const tag = typeof body.tag === 'string' ? body.tag : undefined;
    const icon = typeof body.icon === 'string' && body.icon ? body.icon : '/pwa-192.png';
    const badge = typeof body.badge === 'string' && body.badge ? body.badge : '/pwa-192.png';
    const data = body.data && typeof body.data === 'object' ? body.data : {};

    const build = (text: string) =>
      JSON.stringify({ title, body: text, url, tag, icon, badge, data });

    let text = typeof body.body === 'string' ? body.body : '';
    let payload = build(text);
    let truncated = false;
    while (utf8len(payload) > MAX_PAYLOAD_BYTES && text.length > 0) {
      // Cắt theo tỉ lệ (không theo byte) vì tiếng Việt là đa byte; vòng lặp hội tụ nhanh.
      const keep = Math.max(0, Math.floor(text.length * 0.85) - 1);
      text = text.slice(0, keep);
      payload = build(text ? `${text}…` : '');
      truncated = true;
    }
    if (truncated) {
      console.warn('[send-push] payload quá 4kB — đã cắt bớt body',
        JSON.stringify({ requestId, idempotencyKey, bytes: utf8len(payload) }));
    }

    // ---- Gửi ----
    const deadIds: string[] = [];
    // Promise.all giữ nguyên thứ tự đầu vào ⇒ devices[] khớp 1-1 với subs[].
    const devices: DeviceResult[] = await Promise.all(
      subs.map(async (s): Promise<DeviceResult> => {
        let host = '?';
        try {
          host = new URL(s.endpoint).host;
        } catch {
          /* endpoint hỏng — giữ '?' */
        }
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload,
          );
          return { id: s.id, host, status: 'sent' };
        } catch (e) {
          const httpStatus = (e as { statusCode?: number })?.statusCode;
          const detail = String(
            (e as { body?: unknown })?.body ?? (e as Error)?.message ?? e,
          ).slice(0, MAX_DEVICE_BODY);
          const status = classifyStatus(httpStatus);
          if (status === 'gone') deadIds.push(s.id);
          console.error('[send-push] fail',
            JSON.stringify({ requestId, idempotencyKey, id: s.id, host, status, httpStatus, body: detail }));
          return { id: s.id, host, status, httpStatus, body: detail };
        }
      }),
    );

    // 404/410 = subscription hết hạn/đã huỷ → tắt cờ is_active. Lỗi prune KHÔNG đổi outcome gửi.
    if (deadIds.length) {
      const { error: pruneErr } = await admin
        .from('push_subscriptions')
        .update({ is_active: false })
        .in('id', deadIds);
      if (pruneErr) {
        console.error('[send-push] prune lỗi', JSON.stringify({ requestId, message: pruneErr.message }));
      }
    }

    const sent = devices.filter((d) => d.status === 'sent').length;
    const failed = devices.length - sent;
    // retryable CHỈ khi còn ít nhất một lỗi thuộc nhóm 429/5xx/mạng. Toàn `gone`/`rejected` thì
    // gửi lại cũng hỏng y hệt ⇒ false để drain KHÔNG đốt 3 lượt vô ích (§D.1a).
    const hasRetryable = devices.some((d) => d.status === 'error');
    const outcome: Outcome = sent > 0 ? (failed > 0 ? 'PARTIAL' : 'SENT') : 'ALL_FAILED';
    const retryable = outcome === 'SENT' ? false : hasRetryable;

    await finishLog(admin, dedupe, idempotencyKey, outcome, sent, requestId);

    console.log('[send-push] done', JSON.stringify({
      requestId, idempotencyKey, outcome, total: devices.length, sent, failed,
      pruned: deadIds.length, retryable, notificationIds: notificationIds.length, dedupe,
    }));

    return respond({
      outcome, requestId, idempotencyKey, dedupe, devices,
      total: devices.length, sent, failed, pruned: deadIds.length, retryable,
      ...(outcome === 'ALL_FAILED'
        ? { error: `Không gửi được tới ${failed} thiết bị — xem devices[]` }
        : {}),
    });
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    console.error('[send-push] ngoại lệ', JSON.stringify({ requestId, idempotencyKey, message }));
    if (admin && idempotencyKey) {
      await finishLog(admin, dedupe, idempotencyKey, 'PROVIDER_ERROR', 0, requestId).catch(() => {});
    }
    return respond({
      outcome: 'PROVIDER_ERROR', requestId, idempotencyKey, retryable: true, error: message,
    });
  }
});
