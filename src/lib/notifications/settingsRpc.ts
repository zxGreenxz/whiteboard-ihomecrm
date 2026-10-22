// Lớp gọi RPC MỚI của trang Cài đặt thông báo (plan 21/10/2026 §4 — gói B cài ở máy chủ).
//
// VÌ SAO GOM VỀ MỘT FILE
//   Sáu RPC dưới đây chưa có trong `src/integrations/supabase/types.ts` (types chỉ sinh lại
//   SAU khi migration áp production). Gọi thẳng `supabase.rpc('<tên mới>', …)` nên typecheck
//   báo thiếu tên RPC — và lỗi đó CHỈ được phép nằm ở file này. Không ép kiểu `as never`/`any`
//   để né: khi `npm run gen:types` chạy xong, lỗi tự hết và tham số được kiểm theo kiểu sinh
//   thật, nên lệch tên tham số giữa hai gói sẽ lộ ra ở đúng chỗ này thay vì im lặng.
//
// Mỗi hàm trả về dữ liệu ĐÃ KIỂM HÌNH DẠNG. Phong bì lệch hợp đồng ⇒ `NotificationSettingsReceiptError`
// (không bao giờ dựng mặc định thay cho dữ liệu thật — Contract §14 "không trả rỗng che lỗi").

import { supabase } from '@/integrations/supabase/client';

/* ─────────────────────────────── Lỗi có phân loại ─────────────────────────────── */

/** Phong bì máy chủ thiếu/lệch, hoặc biên nhận ghi không khớp giá trị đã gửi. */
export class NotificationSettingsReceiptError extends Error {
  constructor() { super('Chưa xác nhận được cấu hình thông báo đã lưu. Đọc lại trạng thái trước khi thay đổi tiếp.'); }
}

/**
 * Cấu hình công ty đã bị người khác sửa sau lần đọc cuối (`set_notification_org_config_v2`
 * so `p_expected_updated_at` và trả `PT409`). Không bao giờ gửi lại nguyên yêu cầu cũ.
 */
export class NotificationOrgConfigConflictError extends Error {
  constructor(readonly serverError: unknown) { super('Cấu hình vừa được người khác sửa — đã tải lại'); }
}

type ErrorLike = { code?: unknown; message?: unknown };
const codeOf = (error: unknown): string =>
  error && typeof error === 'object' ? String((error as ErrorLike).code ?? '') : '';

/** RPC chưa có trên máy chủ (client lên trước migration — Contract §3). */
export function isMissingRpcError(error: unknown): boolean {
  return ['PGRST202', '42883'].includes(codeOf(error));
}

/** Máy chủ từ chối vì quyền (42501). Khác lỗi mạng và khác lỗi dữ liệu. */
export function isPermissionError(error: unknown): boolean {
  return codeOf(error) === '42501';
}

/* ─────────────────────────────── Kiểm hình dạng ─────────────────────────────── */

type Json = Record<string, unknown>;
const asRecord = (v: unknown): Json | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
const isHour = (v: unknown): v is number => Number.isInteger(v) && Number(v) >= 0 && Number(v) <= 23;
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const isInstant = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && Number.isFinite(Date.parse(v));
const isInstantOrNull = (v: unknown): v is string | null => v === null || isInstant(v);
const fail = (): never => { throw new NotificationSettingsReceiptError(); };

/** Map `{khoá: số đếm}` — mọi giá trị phải là số nguyên không âm. */
function readCounts(v: unknown): Record<string, number> {
  const row = asRecord(v) ?? fail();
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(row)) out[key] = isCount(value) ? value : fail();
  return out;
}

/* ─────────────────────────────── Giờ yên cá nhân ─────────────────────────────── */

export interface MyQuietHours {
  enabled: boolean;
  quietStart: number;
  quietEnd: number;
  /** null = chưa từng lưu (máy chủ trả mặc định 21h–7h, đang tắt). */
  updatedAt: string | null;
}

export function parseMyQuietHours(data: unknown): MyQuietHours {
  const row = asRecord(data);
  if (!row || typeof row.enabled !== 'boolean' || !isHour(row.quiet_start) || !isHour(row.quiet_end)
    || !isInstantOrNull(row.updated_at)) fail();
  const ok = row as Json;
  return { enabled: ok.enabled as boolean, quietStart: ok.quiet_start as number, quietEnd: ok.quiet_end as number, updatedAt: ok.updated_at as string | null };
}

export async function fetchMyQuietHours(organizationId: string): Promise<MyQuietHours> {
  const { data, error } = await supabase.rpc('get_my_notification_quiet_hours_v1', { p_organization_id: organizationId });
  if (error) throw error;
  return parseMyQuietHours(data);
}

export async function saveMyQuietHours(input: { organizationId: string; enabled: boolean; quietStart: number; quietEnd: number }): Promise<MyQuietHours> {
  const { data, error } = await supabase.rpc('set_my_notification_quiet_hours_v1', {
    p_organization_id: input.organizationId,
    p_enabled: input.enabled,
    p_quiet_start: input.quietStart,
    p_quiet_end: input.quietEnd,
  });
  if (error) throw error;
  return parseMyQuietHours(data);
}

/* ─────────────────────────────── Cấu hình công ty (v2) ─────────────────────────────── */

export type OrgEventConfig = { enabled: boolean; min_amount: number | null };

export interface NotificationOrgConfigV2 {
  organizationId: string;
  /** Tên công ty máy chủ trả kèm; null ⇒ trang dùng tên từ OrganizationContext. */
  organizationName: string | null;
  /** Đủ mọi khoá máy chủ đang quản lý (≥ 7 khoá cũ; khoá mới có thể có hoặc chưa). */
  events: Record<string, OrgEventConfig>;
  quietStart: number;
  quietEnd: number;
  /** Mốc khoá lạc quan gửi lại ở `p_expected_updated_at`; null = công ty chưa từng lưu. */
  updatedAt: string | null;
  updatedBy: string | null;
}

export function parseOrgConfigV2(data: unknown, requiredKeys: readonly string[]): NotificationOrgConfigV2 {
  const row = asRecord(data) ?? fail();
  const events = asRecord(row.events) ?? fail();
  if (typeof row.organization_id !== 'string' || !row.organization_id
    || !(row.organization_name === null || row.organization_name === undefined || typeof row.organization_name === 'string')
    || !isHour(row.quiet_start) || !isHour(row.quiet_end) || !isInstantOrNull(row.updated_at)
    || !(row.updated_by === null || row.updated_by === undefined || typeof row.updated_by === 'string')) fail();
  const out: Record<string, OrgEventConfig> = {};
  for (const [key, raw] of Object.entries(events)) {
    const event = asRecord(raw);
    const min = event?.min_amount;
    if (!event || typeof event.enabled !== 'boolean'
      || !(min === null || (typeof min === 'number' && Number.isFinite(min) && min >= 0))) fail();
    out[key] = { enabled: event!.enabled as boolean, min_amount: (min ?? null) as number | null };
  }
  if (requiredKeys.some(key => !out[key])) fail();
  return {
    organizationId: row.organization_id as string,
    organizationName: typeof row.organization_name === 'string' && row.organization_name.trim() ? row.organization_name : null,
    events: out,
    quietStart: row.quiet_start as number,
    quietEnd: row.quiet_end as number,
    updatedAt: (row.updated_at ?? null) as string | null,
    updatedBy: typeof row.updated_by === 'string' ? row.updated_by : null,
  };
}

export async function fetchOrgConfigV2(organizationId: string, requiredKeys: readonly string[]): Promise<NotificationOrgConfigV2> {
  const { data, error } = await supabase.rpc('get_notification_org_config_v2', { p_organization_id: organizationId });
  if (error) throw error;
  return parseOrgConfigV2(data, requiredKeys);
}

/**
 * Ghi cấu hình công ty. `events` CHỈ chứa họ/trường vừa đổi (máy chủ merge sâu tới cấp
 * trường, xem set_notification_org_config_v1) — gửi đủ mọi họ từ bản nháp cũ là đè mất
 * thay đổi của người khác (NOTIF-SETTINGS-8).
 */
export async function saveOrgConfigV2(input: {
  organizationId: string;
  events: Record<string, Partial<OrgEventConfig>>;
  quietStart: number;
  quietEnd: number;
  expectedUpdatedAt: string | null;
}, requiredKeys: readonly string[]): Promise<NotificationOrgConfigV2> {
  const { data, error } = await supabase.rpc('set_notification_org_config_v2', {
    p_organization_id: input.organizationId,
    p_events: input.events,
    p_quiet_start: input.quietStart,
    p_quiet_end: input.quietEnd,
    p_expected_updated_at: input.expectedUpdatedAt,
  });
  if (error) {
    if (codeOf(error) === 'PT409') throw new NotificationOrgConfigConflictError(error);
    throw error;
  }
  return parseOrgConfigV2(data, requiredKeys);
}

/* ─────────────────────────────── Sức khoẻ giao thông báo ─────────────────────────────── */

export interface NotificationDeliveryHealth {
  generatedAt: string;
  membersTotal: number;
  membersWithDevice: number;
  activeDevices: number;
  queue: {
    queued: number;
    sending: number;
    /** Dòng QUEUED cũ nhất, KỂ CẢ dòng đang được hoãn hợp lệ vì giờ yên. */
    oldestQueuedAt: string | null;
    /**
     * Dòng QUEUED cũ nhất ĐỦ ĐIỀU KIỆN gửi lúc này (loại dòng trong giờ yên công ty/cá
     * nhân). `undefined` = máy chủ chưa trả trường này (bản RPC cũ); `null` = không có.
     */
    oldestEligibleQueuedAt?: string | null;
    /** Số dòng đang hoãn vì giờ yên; `undefined` = máy chủ chưa trả. */
    deferredQuiet?: number;
  };
  last7d: { sent: number; noDevice: number; failed: number; skipped: number };
  lifecycle: { pushStates: Record<string, number>; lastSuccessAt: string | null };
  pushLog7d: Record<string, number>;
  noRecipient7d: { event: string; reason: string; n: number }[];
  lastDrainAt: string | null;
  /** Lượt drain THÀNH CÔNG gần nhất (lastDrainAt tính cả lượt lỗi); `undefined` = chưa trả. */
  lastDrainOkAt?: string | null;
  /** Lỗi của lượt drain gần nhất — máy chủ chỉ trả khác null cho super admin. */
  lastDrainError?: string | null;
}

export function parseDeliveryHealth(data: unknown): NotificationDeliveryHealth {
  const row = asRecord(data) ?? fail();
  const queue = asRecord(row.queue) ?? fail();
  const last7d = asRecord(row.last_7d) ?? fail();
  const lifecycle = asRecord(row.lifecycle) ?? fail();
  if (!isInstant(row.generated_at) || !isCount(row.members_total) || !isCount(row.members_with_device)
    || !isCount(row.active_devices) || !isCount(queue.queued) || !isCount(queue.sending)
    || !isInstantOrNull(queue.oldest_queued_at ?? null)
    || !['sent', 'no_device', 'failed', 'skipped'].every(key => isCount(last7d[key]))
    || !isInstantOrNull(lifecycle.last_success_at ?? null) || !isInstantOrNull(row.last_drain_at ?? null)
    || !Array.isArray(row.no_recipient_7d)) fail();
  // Trường bổ sung (SETTINGS-3/5): TUỲ CHỌN — bản RPC chưa có thì vắng, không vỡ. Có mặt
  // thì phải đúng hình dạng (lệch ⇒ lỗi hợp đồng như mọi trường khác).
  if (!(queue.oldest_eligible_queued_at === undefined || isInstantOrNull(queue.oldest_eligible_queued_at))
    || !(queue.deferred_quiet === undefined || isCount(queue.deferred_quiet))
    || !(row.last_drain_ok_at === undefined || isInstantOrNull(row.last_drain_ok_at))
    || !(row.last_drain_error === undefined || row.last_drain_error === null || typeof row.last_drain_error === 'string')) fail();
  const noRecipient = (row.no_recipient_7d as unknown[]).map(item => {
    const r = asRecord(item);
    if (!r || typeof r.event !== 'string' || typeof r.reason !== 'string' || !isCount(r.n)) fail();
    return { event: r!.event as string, reason: r!.reason as string, n: r!.n as number };
  });
  return {
    generatedAt: row.generated_at as string,
    membersTotal: row.members_total as number,
    membersWithDevice: row.members_with_device as number,
    activeDevices: row.active_devices as number,
    queue: {
      queued: queue.queued as number, sending: queue.sending as number, oldestQueuedAt: (queue.oldest_queued_at ?? null) as string | null,
      ...(queue.oldest_eligible_queued_at !== undefined ? { oldestEligibleQueuedAt: queue.oldest_eligible_queued_at as string | null } : {}),
      ...(queue.deferred_quiet !== undefined ? { deferredQuiet: queue.deferred_quiet as number } : {}),
    },
    last7d: { sent: last7d.sent as number, noDevice: last7d.no_device as number, failed: last7d.failed as number, skipped: last7d.skipped as number },
    lifecycle: { pushStates: readCounts(lifecycle.push_states ?? {}), lastSuccessAt: (lifecycle.last_success_at ?? null) as string | null },
    pushLog7d: readCounts(row.push_log_7d ?? {}),
    noRecipient7d: noRecipient,
    lastDrainAt: (row.last_drain_at ?? null) as string | null,
    ...(row.last_drain_ok_at !== undefined ? { lastDrainOkAt: row.last_drain_ok_at as string | null } : {}),
    ...(row.last_drain_error !== undefined ? { lastDrainError: row.last_drain_error as string | null } : {}),
  };
}

export async function fetchDeliveryHealth(organizationId: string): Promise<NotificationDeliveryHealth> {
  const { data, error } = await supabase.rpc('get_notification_delivery_health_v1', { p_organization_id: organizationId });
  if (error) throw error;
  return parseDeliveryHealth(data);
}

/* ─────────────────────────────── Nhật ký gửi push của tôi ─────────────────────────────── */

export interface MyPushLogRow { createdAt: string; outcome: string; sent: number }

export function parseMyPushLog(data: unknown): MyPushLogRow[] {
  if (!Array.isArray(data)) fail();
  return (data as unknown[]).map(item => {
    const r = asRecord(item);
    if (!r || !isInstant(r.created_at) || typeof r.outcome !== 'string' || !r.outcome || !isCount(r.sent)) fail();
    return { createdAt: r!.created_at as string, outcome: r!.outcome as string, sent: r!.sent as number };
  });
}

/** `p_limit` 1..50 theo hợp đồng; giá trị ngoài khoảng bị kẹp trước khi gọi. */
export async function fetchMyPushLog(limit: number): Promise<MyPushLogRow[]> {
  const pLimit = Math.min(50, Math.max(1, Math.trunc(limit)));
  const { data, error } = await supabase.rpc('get_my_push_log_v1', { p_limit: pLimit });
  if (error) throw error;
  return parseMyPushLog(data);
}
