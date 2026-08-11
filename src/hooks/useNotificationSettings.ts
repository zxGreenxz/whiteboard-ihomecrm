// Tầng dữ liệu cho hai màn cài đặt thông báo (PR-7b · §C + §E.3).
//
// Hai lớp cấu hình RIÊNG BIỆT, đừng trộn:
//
//  1. CẤP TỔ CHỨC — `app_private.notification_org_config` (bật/tắt từng sự kiện E1…E6,
//     ngưỡng tiền, giờ yên tĩnh). Đọc/ghi qua `get/set_notification_org_config_v1`,
//     server tự gate `settings.view` / `settings.edit`. Render ở tab Thông báo của
//     /settings/general (chỉ Chủ sở hữu tổ chức vào được route đó).
//
//  2. SỞ THÍCH CÁ NHÂN — `public.notification_preferences` (mỗi người × mỗi tổ chức ×
//     5 họ sự kiện × in_app/push). Đọc/ghi qua `get/set_my_notification_preferences_v1`,
//     server chỉ kiểm membership ACTIVE. Render ở /account/profile — 10/10 tài khoản mở
//     được, KHÔNG đặt trong /settings/general vì 8/10 người nhận thông báo không có
//     `settings.view` (nathan ôm 658/1130 dòng mà không mở nổi trang để tự tắt).
//
// 🔴 NGUYÊN TẮC HẠ CÁNH AN TOÀN: toàn bộ hook đọc PHẢI trả về mặc định hợp lệ khi RPC
// lỗi hoặc CHƯA TỒN TẠI. Frontend được ship trước migration, nên nếu thiếu nhánh này
// thì tab Thông báo và trang Tài khoản sẽ vỡ trắng trên production ngay lúc deploy FE.
// Mặc định = "bật hết, giờ yên tĩnh 21h→7h" — đúng hành vi hiện tại của hệ thống.

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { batBuoc } from "@/lib/queryGuard";
import { toast } from "sonner";

/* ────────────────────────────── Kiểu dữ liệu ───────────────────────────── */

/**
 * 6 HỌ sự kiện. `metadata.event` có 10 nhánh (E1, E2, E2b, E2c, E3, E4, E5, E6a,
 * E6b, E6c) nhưng cấu hình chỉ có 6 khoá — quy tắc ánh xạ `E2*` → `E2` và
 * `E6*` → `E6` nằm ở phía SQL (`notify_gate_v1`), frontend không được tự ánh xạ
 * lần nữa kẻo đẻ nguồn sự thật thứ hai.
 */
export const NOTIFICATION_EVENT_KEYS = ["E1", "E2", "E3", "E4", "E5", "E6"] as const;
export type NotificationEventKey = (typeof NOTIFICATION_EVENT_KEYS)[number];

/** Nhãn tiếng Việt cho 6 họ — dùng chung cho cả card tổ chức lẫn card cá nhân. */
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
    title: "Việc được giao cho tôi",
    desc: "Có công việc mới gán về tên bạn.",
  },
  E5: {
    title: "Bàn giao tiền mặt chờ tôi xác nhận",
    desc: "Ai đó bàn giao quỹ và đang đợi bạn nhận.",
  },
  E6: {
    title: "Chốt sổ quỹ",
    desc: "Nhắc chốt sổ sau khi bàn giao xong, đề nghị chốt chờ bạn ký, và biên bản đã ký.",
  },
};

// `type` chứ không phải `interface`: chỉ type alias mới gán được vào `Json`, nên
// cả map cấu hình mới đi thẳng làm tham số RPC mà không phải ép kiểu.
export type NotificationEventConfig = {
  enabled: boolean;
  /**
   * Ngưỡng tiền tối thiểu để phát thông báo; `null` = KHÔNG lọc theo tiền.
   * ⚠ Đã đo: nâng ngưỡng 300k → 3tr chỉ hạ đỉnh từ 15 xuống 14 thông báo/ngày, và
   * đường compat ép UNAPPROVED bất kể số tiền — nên ngưỡng gần như vô dụng để chống
   * ồn. Cơ chế chống ồn thật là GỘP ở phía server. Giữ ô này chỉ vì hợp đồng dữ liệu.
   */
  min_amount: number | null;
}

export interface NotificationOrgConfig {
  events: Record<NotificationEventKey, NotificationEventConfig>;
  /** Giờ bắt đầu / kết thúc khoảng yên tĩnh (0..23, theo giờ máy chủ). */
  quiet_start: number;
  quiet_end: number;
  /** false = RPC chưa có trên server (FE ship trước migration) hoặc gọi lỗi. */
  available: boolean;
}

export type NotificationCadence = "IMMEDIATE" | "DIGEST" | "OFF";

export interface NotificationPreferenceRow {
  event_key: NotificationEventKey;
  in_app: boolean;
  push: boolean;
  cadence: NotificationCadence;
}

export interface MyNotificationPreferences {
  prefs: Record<NotificationEventKey, NotificationPreferenceRow>;
  /** false = RPC chưa có trên server hoặc gọi lỗi ⇒ đang hiển thị mặc định, không lưu được. */
  available: boolean;
}

/* ───────────────────────────── Mặc định an toàn ─────────────────────────── */

const DEFAULT_EVENTS = (): Record<NotificationEventKey, NotificationEventConfig> =>
  Object.fromEntries(
    NOTIFICATION_EVENT_KEYS.map(
      (k): [NotificationEventKey, NotificationEventConfig] => [
        k,
        { enabled: true, min_amount: null },
      ],
    ),
  ) as Record<NotificationEventKey, NotificationEventConfig>;

const DEFAULT_ORG_CONFIG = (): NotificationOrgConfig => ({
  events: DEFAULT_EVENTS(),
  quiet_start: 21,
  quiet_end: 7,
  available: false,
});

const DEFAULT_PREFS = (): Record<NotificationEventKey, NotificationPreferenceRow> =>
  Object.fromEntries(
    NOTIFICATION_EVENT_KEYS.map((k) => [
      k,
      { event_key: k, in_app: true, push: true, cadence: "IMMEDIATE" as NotificationCadence },
    ]),
  ) as Record<NotificationEventKey, NotificationPreferenceRow>;

/* ───────────────────────────── Tiện ích nội bộ ──────────────────────────── */

type Json = Record<string, unknown>;

const asRecord = (v: unknown): Json | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;

/** RPC có thể trả object, mảng-1-phần-tử (SETOF), hoặc null. Chuẩn hoá về object. */
const unwrapRow = (data: unknown): Json | null => {
  if (Array.isArray(data)) return asRecord(data[0]);
  return asRecord(data);
};

const toBool = (v: unknown, fallback: boolean): boolean =>
  typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : fallback;

const toHour = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback;
};

const toAmount = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const toCadence = (v: unknown): NotificationCadence =>
  v === "DIGEST" || v === "OFF" || v === "IMMEDIATE" ? v : "IMMEDIATE";

/**
 * Ghi log MỘT dòng khi RPC vắng mặt, rồi trả mặc định. Không toast: người dùng bình
 * thường không cần biết migration chưa lên, và toast đỏ lúc mở trang là báo động giả.
 */
const warnUnavailable = (fn: string, message: string) => {
  // eslint-disable-next-line no-console
  console.warn(`[notification-settings] ${fn} chưa dùng được (${message}) — dùng mặc định.`);
};

/* ─────────────────────────── Tổ chức: đọc / ghi ─────────────────────────── */

export const NOTIFICATION_ORG_CONFIG_KEY = ["notification-org-config"] as const;

export function useNotificationOrgConfig() {
  return useQuery({
    queryKey: NOTIFICATION_ORG_CONFIG_KEY,
    // Đọc hỏng KHÔNG được ném lên trên: card phải render được ở trạng thái mặc định.
    queryFn: async (): Promise<NotificationOrgConfig> => {
      const { data, error } = await supabase.rpc("get_notification_org_config_v1");
      if (error) {
        warnUnavailable("get_notification_org_config_v1", error.message);
        return DEFAULT_ORG_CONFIG();
      }
      const row = unwrapRow(data);
      if (!row) return { ...DEFAULT_ORG_CONFIG(), available: true };

      const rawEvents = asRecord(row.events) ?? {};
      const events = DEFAULT_EVENTS();
      for (const k of NOTIFICATION_EVENT_KEYS) {
        const e = asRecord(rawEvents[k]);
        if (!e) continue;
        events[k] = {
          enabled: toBool(e.enabled, true),
          min_amount: toAmount(e.min_amount),
        };
      }

      return {
        events,
        quiet_start: toHour(row.quiet_start, 21),
        quiet_end: toHour(row.quiet_end, 7),
        available: true,
      };
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function useSetNotificationOrgConfig() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      events: Record<NotificationEventKey, NotificationEventConfig>;
      quiet_start: number;
      quiet_end: number;
    }) => {
      const { data, error } = await supabase.rpc("set_notification_org_config_v1", {
        p_events: input.events,
        p_quiet_start: input.quiet_start,
        p_quiet_end: input.quiet_end,
      });
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: NOTIFICATION_ORG_CONFIG_KEY });
      toast.success("Đã lưu cấu hình thông báo của tổ chức");
    },
    onError: (e: Error) => {
      toast.error(e.message || "Không lưu được cấu hình thông báo");
    },
  });
}

/* ──────────────────────── Cá nhân: tổ chức + đọc / ghi ──────────────────── */

/**
 * Danh sách tổ chức của chính người đang đăng nhập.
 *
 * Vì sao cần: hai RPC preferences nhận `p_organization_id` BẮT BUỘC (preferences là
 * per-user × per-org), mà frontend không có sẵn khái niệm "org hiện tại". `my_org_ids()`
 * là SECURITY DEFINER đã grant cho `authenticated` và có sẵn trong types.ts.
 * ⚠ `public.organizations` CHỈ super admin đọc được nên KHÔNG lấy được tên từ đó —
 * tên (nếu cần) lấy từ `list_ie_accounting_standard_v1`, và chỉ khi có >1 tổ chức
 * (đo thật: 9/10 tài khoản có đúng 1 tổ chức, chỉ chủ có 2).
 */
export function useMyOrgIds() {
  return useQuery({
    queryKey: ["my-org-ids"],
    queryFn: async (): Promise<string[]> => {
      const { data, error } = await supabase.rpc("my_org_ids");
      if (error) {
        warnUnavailable("my_org_ids", error.message);
        return [];
      }
      // `my_org_ids()` là array_agg thô trên organization_memberships — hai membership
      // ACTIVE trong cùng một tổ chức sẽ ra id TRÙNG, làm vỡ key React của ô chọn.
      // Sắp xếp để thứ tự ỔN ĐỊNH giữa các lần gọi: array_agg không đảm bảo thứ tự, mà
      // ô chọn lấy phần tử đầu làm mặc định — thứ tự nhảy = mỗi lần mở trang lại đặt sở
      // thích cho một tổ chức khác.
      return Array.isArray(data)
        ? Array.from(new Set((data as string[]).filter(Boolean))).sort()
        : [];
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useMyOrgOptions() {
  const { data: ids = [], isLoading: loadingIds } = useMyOrgIds();

  // Chỉ đi hỏi tên khi thật sự có nhiều hơn một tổ chức — người dùng 1 org không cần
  // thấy ô chọn, và RPC tên có thể không dành cho họ.
  const { data: named = [] } = useQuery({
    queryKey: ["my-org-names"],
    enabled: ids.length > 1,
    retry: false,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<{ organization_id: string; organization_name: string }[]> => {
      const { data, error } = await supabase.rpc("list_ie_accounting_standard_v1");
      if (error) return [];
      return Array.isArray(data) ? (data as any[]) : [];
    },
  });

  const options = useMemo(() => {
    const byId = new Map(named.map((o) => [o.organization_id, o.organization_name]));
    return ids.map((id) => ({ id, name: byId.get(id) || `Tổ chức ${id.slice(0, 8)}…` }));
  }, [ids, named]);

  return { options, isLoading: loadingIds };
}

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
        warnUnavailable("get_my_notification_preferences_v1", error.message);
        return { prefs: DEFAULT_PREFS(), available: false };
      }

      const prefs = DEFAULT_PREFS();
      // Hình dạng THẬT của RPC: { organization_id, user_id, preferences: { E1:{in_app,push,
      // cadence,updated_at}, … } }. Bóc `preferences` ra trước — đọc thẳng object ngoài sẽ
      // duyệt phải organization_id/user_id và âm thầm trả về TOÀN MẶC ĐỊNH, tức người dùng
      // tưởng đã tắt mà thật ra vẫn bật.
      const envelope = unwrapRow(data);
      const bag = envelope && asRecord(envelope.preferences) ? asRecord(envelope.preferences)! : envelope;
      const rows: unknown[] = Array.isArray(data)
        ? data
        : bag
          ? Object.entries(bag).map(([k, v]) => ({ event_key: k, ...(asRecord(v) ?? {}) }))
          : [];
      for (const r of rows) {
        const row = asRecord(r);
        if (!row) continue;
        const key = String(row.event_key ?? "") as NotificationEventKey;
        if (!NOTIFICATION_EVENT_KEYS.includes(key)) continue;
        prefs[key] = {
          event_key: key,
          in_app: toBool(row.in_app, true),
          push: toBool(row.push, true),
          cadence: toCadence(row.cadence),
        };
      }
      return { prefs, available: true };
    },
  });
}

export function useSetMyNotificationPreferences(organizationId: string | null) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (prefs: Record<NotificationEventKey, NotificationPreferenceRow>) => {
      if (!organizationId) throw new Error("Chưa xác định được tổ chức của bạn");
      // Gửi ĐÚNG 3 khoá server cần; `event_key` đã là khoá của object nên nhét lại vào
      // trong value là nguồn sự thật thứ hai.
      const payload = Object.fromEntries(
        NOTIFICATION_EVENT_KEYS.map((k) => [
          k,
          { in_app: prefs[k].in_app, push: prefs[k].push, cadence: prefs[k].cadence },
        ]),
      );
      const { data, error } = await supabase.rpc(
        "set_my_notification_preferences_v1",
        { p_organization_id: organizationId, p_prefs: payload },
      );
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: MY_NOTIFICATION_PREFS_KEY(organizationId) });
    },
    onError: (e: Error) => {
      toast.error(e.message || "Không lưu được tuỳ chọn thông báo");
    },
  });
}
