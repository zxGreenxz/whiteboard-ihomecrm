import {getSessionUserId} from '@/lib/authSession';
import { notifyActionError } from '@/lib/actionFeedback';
// Tầng dữ liệu cho trang Cài đặt thông báo `/account/notifications` (plan 21/10/2026, gói D).
//
// Các lớp cấu hình RIÊNG BIỆT, đừng trộn:
//
//  1. CẤP CÔNG TY — `app_private.notification_org_config` (bật/tắt từng họ, ngưỡng tiền,
//     giờ yên công ty). Đọc/ghi qua `get/set_notification_org_config_v2(p_organization_id…)`:
//     theo CÔNG TY ĐANG CHỌN (bản v1 sửa ngầm công ty do current_admin_org_v1 chọn —
//     NOTIF-SETTINGS-14), ghi kèm `p_expected_updated_at` để hai quản trị không đè nhau
//     (máy chủ trả PT409). Server tự gate `settings.view` / `settings.edit`.
//
//  2. SỞ THÍCH CÁ NHÂN — `public.notification_preferences` (mỗi người × mỗi công ty ×
//     mỗi họ × in_app/push). Đọc/ghi qua `get/set_my_notification_preferences_v1`, server chỉ
//     kiểm membership ACTIVE ⇒ mọi thành viên tự chỉnh được, không cần `settings.view`.
//     Ghi CHỈ khoá/trường vừa đổi (NOTIF-SETTINGS-8): gửi đủ mọi khoá từ bản nháp cũ là
//     bật lại âm thầm cái người dùng vừa tắt trên máy khác.
//
//  3. GIỜ YÊN CÁ NHÂN — `public.notification_quiet_hours` qua `get/set_my_notification_quiet_hours_v1`.
//
//  4. THIẾT BỊ — `public.push_subscriptions` của chính mình (RLS select_own/delete_own), đọc
//     và gỡ trực tiếp; nhật ký gửi qua `get_my_push_log_v1`.
//
// Lỗi đọc phải có trạng thái riêng. Chỉ dùng giá trị mặc định khi máy chủ xác nhận chưa có cấu hình.
// RPC mới đi qua `@/lib/notifications/settingsRpc` (một file wrapper typed duy nhất).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { batBuoc } from "@/lib/queryGuard";
import { getExistingSubscription, isPushSupported } from "@/lib/push";
import { requireAccountWriteReceipt } from "@/lib/accountSettingsWriteReceipt";
import {
  NotificationOrgConfigConflictError,
  NotificationSettingsReceiptError,
  fetchDeliveryHealth,
  fetchMyPushLog,
  fetchMyQuietHours,
  fetchOrgConfigV2,
  saveMyQuietHours,
  saveOrgConfigV2,
  type MyQuietHours,
  type NotificationOrgConfigV2,
  type OrgEventConfig,
} from "@/lib/notifications/settingsRpc";
import { toast } from "sonner";

export { NotificationOrgConfigConflictError, NotificationSettingsReceiptError };
export type { MyQuietHours };

/* ────────────────────────────── Họ sự kiện ───────────────────────────── */

/**
 * 7 họ đã có trên máy chủ từ trước. `metadata.event` có 10 nhánh (E1, E2, E2b, E2c, E3, E4,
 * E5, E6a, E6b, E6c) nhưng cấu hình chỉ có khoá họ — ánh xạ `E2*` → `E2`, `E6*` → `E6` nằm ở
 * phía SQL (`notify_gate_v1`), frontend không tự ánh xạ lần nữa kẻo đẻ nguồn sự thật thứ hai.
 * Phong bì đọc THIẾU một khoá ở đây là lỗi hợp đồng.
 */
export const LEGACY_NOTIFICATION_EVENT_KEYS = ["E1", "E2", "E3", "E4", "E5", "E6", "LIFECYCLE"] as const;
/**
 * 3 họ nhắc chuyển lên máy chủ (plan B5/B8: lane lifecycle mở rộng). Máy chủ chưa áp migration
 * thì phong bì chưa có các khoá này — dòng tương ứng hiện "máy chủ chưa hỗ trợ", không vỡ cả ma trận.
 */
export const SERVER_REMINDER_EVENT_KEYS = ["BILLING", "CONTRACT_EXPIRY", "DEPOSIT"] as const;
export const NOTIFICATION_EVENT_KEYS = [...LEGACY_NOTIFICATION_EVENT_KEYS, ...SERVER_REMINDER_EVENT_KEYS] as const;
export type LegacyNotificationEventKey = (typeof LEGACY_NOTIFICATION_EVENT_KEYS)[number];
export type ServerReminderEventKey = (typeof SERVER_REMINDER_EVENT_KEYS)[number];
export type NotificationEventKey = (typeof NOTIFICATION_EVENT_KEYS)[number];

/**
 * Họ mà producer CHỈ ghi dòng chuông khi `in_app` bật và push đi KÈM dòng đó (E1–E6 và nhắc
 * việc Hermes dùng cổng E4 — NOTIF-SETTINGS-6). Với các họ này "Trong app tắt + Đẩy bật" không
 * giao gì ⇒ UI khoá công tắc Đẩy. Không đổi phép đọc ở máy chủ: hook so biên nhận từng trường.
 * Lane lifecycle (LIFECYCLE + 3 họ nhắc) tách push khỏi dòng hộp thư nên không khoá.
 */
export const PUSH_FOLLOWS_IN_APP_KEYS: ReadonlySet<NotificationEventKey> = new Set<NotificationEventKey>(["E1", "E2", "E3", "E4", "E5", "E6"]);

/**
 * Ô ngưỡng tiền chỉ có nghĩa ở họ THÔNG TIN có truyền số tiền (NOTIF-SETTINGS-9): E1/E4 truyền
 * NULL nên ngưỡng vô tác dụng; E5/E6a/E6b là việc chờ tôi — lọc theo tiền là nuốt việc. Cấu hình
 * chỉ có MỘT khoá `E6` cho cả E6a/b/c nên chưa tách được E6c ⇒ chỉ E2, E3.
 */
export const ORG_MIN_AMOUNT_KEYS: ReadonlySet<NotificationEventKey> = new Set<NotificationEventKey>(["E2", "E3"]);

/** Nhãn tiếng Việt cho các họ — dùng chung cho thẻ công ty lẫn ma trận cá nhân. */
export const NOTIFICATION_EVENT_LABELS: Record<
  NotificationEventKey,
  { title: string; desc: string }
> = {
  E1: {
    title: "Phiếu chờ tôi duyệt",
    desc: "Gộp mỗi lượt: có bao nhiêu phiếu thu chi đang chờ chữ ký của bạn.",
  },
  E2: {
    title: "Phiếu của tôi được duyệt / bị từ chối",
    desc: "Kết quả xử lý phiếu do bạn lập.",
  },
  E3: {
    title: "Phiếu chờ duyệt bị huỷ",
    desc: "Báo người duyệt biết khỏi phải chờ nữa.",
  },
  E4: {
    title: "Việc được giao & nhắc việc",
    // NOTIF-SETTINGS-13: cổng E4 điều khiển cả 7 loại nhắc việc Hermes (due, overdue,
    // overdue_report, done, progress, cancelled, deleted), có loại gửi cho NGƯỜI GIAO.
    desc: "Việc mới gán cho bạn; nhắc việc sắp tới hạn / quá hạn; báo người giao khi việc xong, có tiến độ, bị huỷ hoặc quá hạn chưa xong.",
  },
  E5: {
    title: "Bàn giao tiền mặt chờ tôi xác nhận",
    desc: "Ai đó bàn giao quỹ và đang đợi bạn nhận.",
  },
  E6: {
    title: "Chốt sổ quỹ",
    desc: "Nhắc chốt sổ sau khi bàn giao xong, đề nghị chốt chờ bạn ký, và biên bản đã ký.",
  },
  LIFECYCLE: {
    title: "Việc cần theo dõi khi trả phòng",
    desc: "Nhắc báo trả đến hẹn, phòng dọn/sửa quá hạn hoặc chưa hẹn, và hồ sơ trả phòng chờ hoàn tất.",
  },
  BILLING: {
    title: "Hoá đơn sắp đến hạn / quá hạn",
    desc: "Gộp mỗi ngày: hoá đơn đến hạn trong 3 ngày tới và hoá đơn đã quá hạn ở các toà bạn phụ trách.",
  },
  CONTRACT_EXPIRY: {
    title: "Hợp đồng sắp hết hạn",
    desc: "Gộp mỗi ngày: hợp đồng đang hiệu lực sẽ hết hạn trong 30 ngày tới.",
  },
  DEPOSIT: {
    title: "Hợp đồng còn thiếu cọc",
    desc: "Gộp mỗi ngày: hợp đồng đang hiệu lực vẫn còn nợ tiền cọc.",
  },
};

/* ────────────────────────────── Kiểu dữ liệu ───────────────────────────── */

// `type` chứ không phải `interface`: chỉ type alias mới gán được vào `Json`.
export type NotificationEventConfig = OrgEventConfig;
export type NotificationOrgEventMap = Record<LegacyNotificationEventKey, NotificationEventConfig>
  & Partial<Record<ServerReminderEventKey, NotificationEventConfig>>;

export interface NotificationOrgConfig {
  organizationId: string;
  organizationName: string | null;
  events: NotificationOrgEventMap;
  /** Giờ bắt đầu / kết thúc khoảng yên (0..23, theo giờ công ty). Bằng nhau = không có khoảng yên. */
  quietStart: number;
  quietEnd: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export type NotificationCadence = "IMMEDIATE" | "DIGEST" | "OFF";

export interface NotificationPreferenceRow {
  event_key: NotificationEventKey;
  in_app: boolean;
  push: boolean;
  cadence: NotificationCadence;
}

export type NotificationPreferenceMap = Record<LegacyNotificationEventKey, NotificationPreferenceRow>
  & Partial<Record<ServerReminderEventKey, NotificationPreferenceRow>>;

export interface MyNotificationPreferences {
  prefs: NotificationPreferenceMap;
  available: boolean;
}

/* ───────────────────────────── Tiện ích nội bộ ──────────────────────────── */

type Json = Record<string, unknown>;

const asRecord = (v: unknown): Json | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;

const CADENCES: readonly string[] = ["IMMEDIATE", "DIGEST", "OFF"];

function readPreference(key: NotificationEventKey, raw: unknown): NotificationPreferenceRow {
  const pref = asRecord(raw);
  if (!pref || typeof pref.in_app !== "boolean" || typeof pref.push !== "boolean" || !CADENCES.includes(String(pref.cadence)))
    throw new NotificationSettingsReceiptError();
  return { event_key: key, in_app: pref.in_app, push: pref.push, cadence: pref.cadence as NotificationCadence };
}

// Phong bì phải đúng người, đúng công ty và đủ 7 khoá cũ. Khoá nhắc mới: có thì phải đúng hình dạng.
function parseNotificationPreferences(data: unknown, organizationId: string, actorId: string): MyNotificationPreferences {
  const row = asRecord(data);
  const bag = asRecord(row?.preferences);
  if (!row || row.organization_id !== organizationId || row.user_id !== actorId || !bag) throw new NotificationSettingsReceiptError();
  const prefs = Object.fromEntries(LEGACY_NOTIFICATION_EVENT_KEYS.map(key => [key, readPreference(key, bag[key])])) as NotificationPreferenceMap;
  for (const key of SERVER_REMINDER_EVENT_KEYS) if (bag[key] !== undefined) prefs[key] = readPreference(key, bag[key]);
  return { prefs, available: true };
}

function toOrgConfig(row: NotificationOrgConfigV2): NotificationOrgConfig {
  const events = Object.fromEntries(LEGACY_NOTIFICATION_EVENT_KEYS.map(key => [key, row.events[key]])) as NotificationOrgEventMap;
  for (const key of SERVER_REMINDER_EVENT_KEYS) if (row.events[key]) events[key] = row.events[key];
  return {
    organizationId: row.organizationId, organizationName: row.organizationName, events,
    quietStart: row.quietStart, quietEnd: row.quietEnd, updatedAt: row.updatedAt, updatedBy: row.updatedBy,
  };
}

async function requireActor(): Promise<string> {
  const actorId = await getSessionUserId();
  if (!actorId) throw { code: "PGRST301", message: "Not authenticated" };
  return actorId;
}

/* ─────────────────────────── Công ty: đọc / ghi (v2) ─────────────────────────── */

export const NOTIFICATION_ORG_CONFIG_KEY = (orgId: string | null) => ["notification-org-config", orgId] as const;

export function useNotificationOrgConfig(organizationId: string | null, enabled = true) {
  return useQuery({
    queryKey: NOTIFICATION_ORG_CONFIG_KEY(organizationId),
    enabled: enabled && !!organizationId,
    meta: { label: "cấu hình thông báo của công ty", errorDisplay: "inline" },
    queryFn: async (): Promise<NotificationOrgConfig> =>
      toOrgConfig(await fetchOrgConfigV2(batBuoc(organizationId, "organizationId"), LEGACY_NOTIFICATION_EVENT_KEYS)),
    staleTime: 60_000,
    retry: false,
  });
}

export interface NotificationOrgConfigChange {
  /** CHỈ họ/trường vừa đổi. */
  events: Partial<Record<NotificationEventKey, Partial<NotificationEventConfig>>>;
  quietStart: number;
  quietEnd: number;
  /** `updatedAt` của lần đọc mà bản nháp dựa trên. */
  expectedUpdatedAt: string | null;
}

/**
 * Chỉ họ × trường khác giữa bản đọc máy chủ (`base`) và bản nháp. Họ không đổi không có mặt;
 * trong một họ chỉ trường đổi có mặt — máy chủ merge sâu tới cấp trường.
 */
export function diffOrgEvents(base: NotificationOrgEventMap, draft: NotificationOrgEventMap): NotificationOrgConfigChange["events"] {
  const out: NotificationOrgConfigChange["events"] = {};
  for (const key of NOTIFICATION_EVENT_KEYS) {
    const before = base[key];
    const after = draft[key];
    if (!before || !after) continue;
    const patch: Partial<NotificationEventConfig> = {};
    if (after.enabled !== before.enabled) patch.enabled = after.enabled;
    if (!Object.is(after.min_amount, before.min_amount)) patch.min_amount = after.min_amount;
    if (Object.keys(patch).length) out[key] = patch;
  }
  return out;
}

export function useSetNotificationOrgConfig(organizationId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (change: NotificationOrgConfigChange): Promise<NotificationOrgConfig> => {
      if (!organizationId) throw new Error("Chưa xác định được công ty đang chọn");
      const saved = toOrgConfig(await saveOrgConfigV2({
        organizationId, events: change.events, quietStart: change.quietStart, quietEnd: change.quietEnd,
        expectedUpdatedAt: change.expectedUpdatedAt,
      }, LEGACY_NOTIFICATION_EVENT_KEYS));
      // Biên nhận: đúng công ty, đúng giờ yên, và từng trường vừa gửi phải có hiệu lực.
      const mismatch = saved.organizationId !== organizationId || saved.quietStart !== change.quietStart || saved.quietEnd !== change.quietEnd
        || Object.entries(change.events).some(([key, patch]) => {
          const actual = saved.events[key as NotificationEventKey];
          return !actual || Object.entries(patch ?? {}).some(([field, value]) => actual[field as keyof NotificationEventConfig] !== value);
        });
      if (mismatch) throw new NotificationSettingsReceiptError();
      return saved;
    },
    onSuccess: (saved) => {
      qc.setQueryData(NOTIFICATION_ORG_CONFIG_KEY(organizationId), saved);
      toast.success("Đã lưu cấu hình thông báo của công ty");
    },
    onError: async (e: Error) => {
      if (e instanceof NotificationOrgConfigConflictError) {
        // Đọc lại TRƯỚC khi báo "đã tải lại" — mutation chỉ kết thúc sau khi refetch xong.
        await qc.refetchQueries({ queryKey: NOTIFICATION_ORG_CONFIG_KEY(organizationId) });
        toast.warning(e.message);
        return;
      }
      notifyActionError(e, "Không lưu được cấu hình thông báo của công ty");
    },
  });
}

/* ──────────────────────── Cá nhân: sở thích theo họ ──────────────────────── */

export const MY_NOTIFICATION_PREFS_KEY = (orgId: string | null) =>
  ["my-notification-preferences", orgId] as const;

export function useMyNotificationPreferences(organizationId: string | null) {
  return useQuery({
    queryKey: MY_NOTIFICATION_PREFS_KEY(organizationId),
    enabled: !!organizationId,
    retry: false,
    staleTime: 60_000,
    queryFn: async (): Promise<MyNotificationPreferences> => {
      const { data, error } = await supabase.rpc(
        "get_my_notification_preferences_v1",
        // `p_organization_id uuid` KHÔNG có DEFAULT — `enabled: !!organizationId`
        // ở trên đã bảo đảm có giá trị, `batBuoc` giữ đúng bất biến đó.
        { p_organization_id: batBuoc(organizationId, "organizationId") },
      );
      if (error) {
        throw error;
      }
      const actorId = await requireActor();
      return parseNotificationPreferences(data, batBuoc(organizationId, "organizationId"), actorId);
    },
  });
}

export interface NotificationPreferenceChange {
  key: NotificationEventKey;
  field: "in_app" | "push";
  value: boolean;
}

/**
 * Ghi ĐÚNG một khoá × một trường: `{[key]:{[field]:value}}`. Máy chủ (`notification_prefs_normalize_v1`)
 * phát `null` cho trường vắng và setter giữ giá trị cũ, nên các khoá/trường khác không bị đụng.
 * Phong bì trả về là trạng thái ĐẦY ĐỦ mới nhất ⇒ ghi thẳng vào cache, các công tắc khác cũng
 * bắt kịp thay đổi từ máy khác.
 */
export function useSetMyNotificationPreference(organizationId: string | null) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (change: NotificationPreferenceChange): Promise<MyNotificationPreferences> => {
      if (!organizationId) throw new Error("Chưa xác định được công ty đang chọn");
      const actorId = await requireActor();
      const { data, error } = await supabase.rpc(
        "set_my_notification_preferences_v1",
        { p_organization_id: organizationId, p_prefs: { [change.key]: { [change.field]: change.value } } },
      );
      if (error) throw error;
      const saved = parseNotificationPreferences(data, organizationId, actorId);
      if (saved.prefs[change.key]?.[change.field] !== change.value) throw new NotificationSettingsReceiptError();
      return saved;
    },
    onSuccess: (saved) => {
      qc.setQueryData(MY_NOTIFICATION_PREFS_KEY(organizationId), saved);
    },
    onError: (e: Error) => {
      notifyActionError(e, "Không lưu được tuỳ chọn thông báo");
    },
  });
}

/* ──────────────────────── Cá nhân: giờ yên ──────────────────────── */

export const MY_QUIET_HOURS_KEY = (orgId: string | null) => ["my-notification-quiet-hours", orgId] as const;

export function useMyQuietHours(organizationId: string | null) {
  return useQuery({
    queryKey: MY_QUIET_HOURS_KEY(organizationId),
    enabled: !!organizationId,
    retry: false,
    staleTime: 60_000,
    meta: { label: "giờ yên của bạn", errorDisplay: "inline" },
    queryFn: () => fetchMyQuietHours(batBuoc(organizationId, "organizationId")),
  });
}

export function useSetMyQuietHours(organizationId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { enabled: boolean; quietStart: number; quietEnd: number }): Promise<MyQuietHours> => {
      if (!organizationId) throw new Error("Chưa xác định được công ty đang chọn");
      const saved = await saveMyQuietHours({ organizationId, ...input });
      if (saved.enabled !== input.enabled || saved.quietStart !== input.quietStart || saved.quietEnd !== input.quietEnd)
        throw new NotificationSettingsReceiptError();
      return saved;
    },
    onSuccess: (saved) => {
      qc.setQueryData(MY_QUIET_HOURS_KEY(organizationId), saved);
      toast.success("Đã lưu giờ yên của bạn");
    },
    onError: (e: Error) => {
      notifyActionError(e, "Không lưu được giờ yên của bạn");
    },
  });
}

/* ──────────────────────── Sức khoẻ giao thông báo (settings.view) ──────────────────────── */

export function useNotificationDeliveryHealth(organizationId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["notification-delivery-health", organizationId] as const,
    enabled: enabled && !!organizationId,
    retry: false,
    staleTime: 60_000,
    meta: { label: "sức khoẻ giao thông báo", errorDisplay: "inline" },
    queryFn: () => fetchDeliveryHealth(batBuoc(organizationId, "organizationId")),
  });
}

/* ──────────────────────── Thiết bị & nhật ký push của tôi ──────────────────────── */

export const MY_PUSH_LOG_KEY = ["my-push-log"] as const;

export function useMyPushLog(limit = 5) {
  return useQuery({
    queryKey: [...MY_PUSH_LOG_KEY, limit] as const,
    retry: false,
    staleTime: 30_000,
    meta: { label: "nhật ký gửi thông báo", errorDisplay: "inline" },
    queryFn: () => fetchMyPushLog(limit),
  });
}

export interface MyPushDevice {
  id: string;
  endpoint: string;
  userAgent: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export const MY_PUSH_DEVICES_KEY = ["my-push-devices"] as const;

export function useMyPushDevices() {
  return useQuery({
    queryKey: MY_PUSH_DEVICES_KEY,
    retry: false,
    staleTime: 30_000,
    meta: { label: "thiết bị nhận thông báo", errorDisplay: "inline" },
    queryFn: async (): Promise<MyPushDevice[]> => {
      const actorId = await requireActor();
      const { data, error } = await supabase.from("push_subscriptions")
        .select("id,user_id,endpoint,user_agent,is_active,created_at,updated_at")
        .eq("user_id", actorId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      if (!Array.isArray(data)) throw new NotificationSettingsReceiptError();
      return data.map((row) => {
        if (!row || row.user_id !== actorId || typeof row.id !== "string" || typeof row.endpoint !== "string"
          || typeof row.is_active !== "boolean" || typeof row.created_at !== "string")
          throw new NotificationSettingsReceiptError();
        return {
          id: row.id, endpoint: row.endpoint, userAgent: row.user_agent ?? null, isActive: row.is_active,
          createdAt: row.created_at, updatedAt: row.updated_at,
        };
      });
    },
  });
}

/** Gỡ một máy KHÁC của chính mình (máy đang dùng thì tắt bằng công tắc để huỷ cả đăng ký trình duyệt). */
export function useRemovePushDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (deviceId: string): Promise<string> => {
      const actorId = await requireActor();
      const { data, error } = await supabase.from("push_subscriptions").delete()
        .eq("id", deviceId).eq("user_id", actorId).select("id,user_id,endpoint");
      if (error) throw error;
      // Mảng rỗng = không xoá được dòng nào (RLS hoặc đã gỡ ở nơi khác) — không phải "đã gỡ".
      if (!Array.isArray(data) || data.length !== 1) throw new NotificationSettingsReceiptError();
      requireAccountWriteReceipt(data[0], { id: deviceId, user_id: actorId });
      return deviceId;
    },
    onSuccess: () => {
      toast.success("Đã gỡ thiết bị khỏi danh sách nhận thông báo");
    },
    onError: (e: Error) => {
      notifyActionError(e, "Chưa gỡ được thiết bị");
    },
    onSettled: () => qc.invalidateQueries({ queryKey: MY_PUSH_DEVICES_KEY }),
  });
}

/* ──────────────────────── Trạng thái cục bộ của máy đang dùng ──────────────────────── */

export const CURRENT_PUSH_DEVICE_KEY = ["push-current-device"] as const;

export interface CurrentPushDeviceState {
  /** Endpoint đăng ký push của trình duyệt này; null = chưa đăng ký. */
  endpoint: string | null;
  serviceWorker: "active" | "waiting" | "none" | "unsupported";
}

/**
 * Chẩn đoán phía trình duyệt: service worker có chạy không, máy này đang đăng ký endpoint nào
 * (để đánh dấu "Máy này" trong danh sách và đối chiếu với máy chủ). Không gọi mạng.
 */
export function useCurrentPushDevice() {
  return useQuery({
    queryKey: CURRENT_PUSH_DEVICE_KEY,
    retry: false,
    staleTime: 30_000,
    queryFn: async (): Promise<CurrentPushDeviceState> => {
      if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return { endpoint: null, serviceWorker: "unsupported" };
      const reg = await navigator.serviceWorker.getRegistration();
      const serviceWorker = !reg ? "none" : reg.active ? "active" : "waiting";
      const endpoint = serviceWorker === "active" && isPushSupported() ? (await getExistingSubscription())?.endpoint ?? null : null;
      return { endpoint, serviceWorker };
    },
  });
}
