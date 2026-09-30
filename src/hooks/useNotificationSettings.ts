import {getSessionUserId} from '@/lib/authSession';
import {requireReadRows,readString} from '@/lib/accountProfitReadModels';
import { notifyActionError } from '@/lib/actionFeedback';
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
// Lỗi đọc phải có trạng thái riêng. Chỉ dùng giá trị mặc định khi máy chủ xác nhận chưa có cấu hình.

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
export const NOTIFICATION_EVENT_KEYS = ["E1", "E2", "E3", "E4", "E5", "E6", "LIFECYCLE"] as const;
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
  LIFECYCLE: {
    title: "Việc cần theo dõi khi trả phòng",
    desc: "Nhắc báo trả đến hẹn, phòng dọn/sửa quá hạn hoặc chưa hẹn, và hồ sơ trả phòng chờ hoàn tất.",
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
  organizationId: string;
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

/* ───────────────────────────── Tiện ích nội bộ ──────────────────────────── */

type Json = Record<string, unknown>;

const asRecord = (v: unknown): Json | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;

/** Các RPC SQL trả một JSON envelope; array/null không phải trạng thái đã xác minh. */
const unwrapRow = (data: unknown): Json | null => {
  if (Array.isArray(data)) return null;
  return asRecord(data);
};

/**
 * Log chẩn đoán kèm lỗi query; card hiển thị lỗi đọc và chặn lưu.
 */
const warnUnavailable = (fn: string, message: string) => {
  // eslint-disable-next-line no-console
  console.warn(`[notification-settings] ${fn} chưa dùng được (${message})`);
};

export class NotificationSettingsReceiptError extends Error {
  constructor() { super('Chưa xác nhận được cấu hình thông báo đã lưu. Đọc lại trạng thái trước khi thay đổi tiếp.'); }
}

// SQL returns a complete envelope, including defaults when no configuration exists.
// A missing envelope is a failed read/unknown write, never a default configuration.
function requireNotificationConfig(data: unknown): Json {
  const row = unwrapRow(data);
  const events = asRecord(row?.events);
  if (!row || typeof row.organization_id !== 'string' || !row.organization_id || !events
    || !Number.isInteger(row.quiet_start) || Number(row.quiet_start) < 0 || Number(row.quiet_start) > 23
    || !Number.isInteger(row.quiet_end) || Number(row.quiet_end) < 0 || Number(row.quiet_end) > 23
    || NOTIFICATION_EVENT_KEYS.some(key => {
      const event = asRecord(events[key]);
      return !event || typeof event.enabled !== 'boolean'
        || (event.min_amount !== null && (typeof event.min_amount !== 'number' || !Number.isFinite(event.min_amount) || event.min_amount < 0));
    })) throw new NotificationSettingsReceiptError();
  return row;
}
function requireNotificationPreferences(data: unknown, organizationId: string, actorId: string): Json {
  const row = unwrapRow(data);
  const prefs = asRecord(row?.preferences);
  if (!row || row.organization_id !== organizationId || row.user_id !== actorId || !prefs
    || NOTIFICATION_EVENT_KEYS.some(key => {
      const pref = asRecord(prefs[key]);
      return !pref || typeof pref.in_app !== 'boolean' || typeof pref.push !== 'boolean'
        || !['IMMEDIATE','DIGEST','OFF'].includes(String(pref.cadence));
    })) throw new NotificationSettingsReceiptError();
  return row;
}

/* ─────────────────────────── Tổ chức: đọc / ghi ─────────────────────────── */

export const NOTIFICATION_ORG_CONFIG_KEY = ["notification-org-config"] as const;

export function useNotificationOrgConfig() {
  return useQuery({
    queryKey: NOTIFICATION_ORG_CONFIG_KEY,
    meta: { label: "cấu hình thông báo", errorDisplay: "inline" },
    queryFn: async (): Promise<NotificationOrgConfig> => {
      const { data, error } = await supabase.rpc("get_notification_org_config_v1");
      if (error) {
        throw error;
      }
      const row = requireNotificationConfig(data);

      return {organizationId: row.organization_id as string,events:row.events as Record<NotificationEventKey,NotificationEventConfig>,quiet_start:row.quiet_start as number,quiet_end:row.quiet_end as number,available:true};
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function useSetNotificationOrgConfig() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      organizationId: string;
      events: Record<NotificationEventKey, NotificationEventConfig>;
      quiet_start: number;
      quiet_end: number;
    }) => {
      const { data, error } = await supabase.rpc("set_notification_org_config_v1", {
        p_events: input.events,
        p_quiet_start: input.quiet_start,
        p_quiet_end: input.quiet_end,
      });
      if (error) throw error;
      const row=requireNotificationConfig(data);
      const events=row.events as Record<NotificationEventKey,NotificationEventConfig>;
      if(row.organization_id!==input.organizationId||row.quiet_start!==input.quiet_start||row.quiet_end!==input.quiet_end||NOTIFICATION_EVENT_KEYS.some(key=>events[key].enabled!==input.events[key].enabled||events[key].min_amount!==input.events[key].min_amount)) throw new NotificationSettingsReceiptError();
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: NOTIFICATION_ORG_CONFIG_KEY });
      toast.success("Đã lưu cấu hình thông báo của tổ chức");
    },
    onError: (e: Error) => {
      notifyActionError(e, "Không lưu được cấu hình thông báo");
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
        throw error;
      }
      // `my_org_ids()` là array_agg thô trên organization_memberships — hai membership
      // ACTIVE trong cùng một tổ chức sẽ ra id TRÙNG, làm vỡ key React của ô chọn.
      // Sắp xếp để thứ tự ỔN ĐỊNH giữa các lần gọi: array_agg không đảm bảo thứ tự, mà
      // ô chọn lấy phần tử đầu làm mặc định — thứ tự nhảy = mỗi lần mở trang lại đặt sở
      // thích cho một tổ chức khác.
      if(!Array.isArray(data)||data.some(id=>!readString(id)))throw new TypeError('Invalid organization IDs');
      return Array.from(new Set(data as string[])).sort();
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useMyOrgOptions() {
  const idsQuery=useMyOrgIds();
  const ids=idsQuery.data??[];
  const needsNames=ids.length>1;
  const namesQuery=useQuery({queryKey:['my-org-names'],enabled:needsNames,retry:false,staleTime:5*60_000,queryFn:async()=>{const {data,error}=await supabase.rpc('list_ie_accounting_standard_v1');if(error)throw error;return requireReadRows<{organization_id:string;organization_name:string}>(data,row=>readString(row.organization_id)&&readString(row.organization_name));}});
  const named=namesQuery.data;
  const options=useMemo(()=>{if(needsNames&&!named)return [];const byId=new Map(named?.map(o=>[o.organization_id,o.organization_name])??[]);return ids.map(id=>({id,name:byId.get(id)||`Tổ chức ${id.slice(0,8)}…`}));},[ids,named,needsNames]);
  const error=idsQuery.error??(needsNames?namesQuery.error:null);
  return {options,isLoading:idsQuery.isLoading||(needsNames&&namesQuery.isLoading),isError:idsQuery.isError||(needsNames&&namesQuery.isError),error,refetch:()=>Promise.allSettled(needsNames?[idsQuery.refetch(),namesQuery.refetch()]:[idsQuery.refetch()])};
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
        throw error;
      }

      const actorId=await getSessionUserId();
      if(!actorId)throw new Error('Chưa đăng nhập');
      const envelope=requireNotificationPreferences(data,batBuoc(organizationId,'organizationId'),actorId);
      const bag=envelope.preferences as Record<NotificationEventKey,{in_app:boolean;push:boolean;cadence:NotificationCadence}>;
      const prefs=Object.fromEntries(NOTIFICATION_EVENT_KEYS.map(key=>[key,{event_key:key,...bag[key]}])) as Record<NotificationEventKey,NotificationPreferenceRow>;
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
      const actorId=await getSessionUserId();
      if(!actorId)throw new Error('Chưa đăng nhập');
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
      if (error) throw error;
      const row=requireNotificationPreferences(data,organizationId,actorId);
      const actual=row.preferences as Record<NotificationEventKey,NotificationPreferenceRow>;
      if(NOTIFICATION_EVENT_KEYS.some(key=>actual[key].in_app!==prefs[key].in_app||actual[key].push!==prefs[key].push||actual[key].cadence!==prefs[key].cadence))throw new NotificationSettingsReceiptError();
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: MY_NOTIFICATION_PREFS_KEY(organizationId) });
    },
    onError: (e: Error) => {
      notifyActionError(e, "Không lưu được tuỳ chọn thông báo");
    },
  });
}
