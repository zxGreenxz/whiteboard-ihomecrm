// useMyDay — data hooks cho màn "Ngày hôm nay của tôi" (/my-day) + phiên kiểm tra nhà.
// Mọi con số từ server (get_my_day_summary / v5_daily_missions_self) — KHÔNG hardcode.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { actionErrorMessage } from "@/lib/actionFeedback";
import { batBuoc } from "@/lib/queryGuard";
import { z } from 'zod';
import { financialReadRows } from '@/lib/financialReadValidation';
import { leaveMonths, leaveWorkDays } from '@/lib/leaveDates';

const dayCount = z.number().int().nonnegative();
const dayAmount = z.number().finite();
// Điểm Chủ nhật V5.1 tích 0,5 mỗi ngày (streak_v5.sunday_point) nên số dư có thể lẻ.
const dayPoints = z.number().finite().nonnegative();
const dayDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const dayTime = z.string().datetime({offset:true});
const daySummaryReceipt = z.object({
  today:z.object({date:dayDate,status:z.string().min(1),tick_source:z.string().nullable()}),
  attend:z.object({n_chuan:dayCount,day_rate:dayAmount,ticked_days:dayCount,tam_tinh:dayAmount,budget:dayAmount}),
  streak:z.object({current:dayCount,best:dayCount,breaks_no_leave:dayCount,shields_free_left:dayCount,shields_reserve_left:z.number().int(),
    shields_perfect_left:dayCount.optional(),sunday_points_left:dayPoints.optional(),
    banked:z.array(z.object({milestone:z.union([dayCount,z.literal('full_month')]),delta:dayAmount,top:z.boolean().optional()})),
    next:z.object({milestone:dayCount,delta:dayAmount,days_to_go:z.number().int()}).nullable()}),
  pending_checks:z.array(z.object({building_id:z.string().min(1),building_name:z.string().nullable()})),
  leave:z.object({quota:dayCount,used:dayCount,left:dayCount}),stage:z.string().min(1),
});
const inspectionStartReceipt = z.object({
  session_id:z.string().min(1),type:z.enum(['FULL','QUICK']),status:z.string().min(1),session_date:dayDate,
  checklist:z.array(z.object({key:z.string().min(1),label:z.string(),required:z.boolean(),done:z.boolean(),floor:z.number().optional(),random:z.boolean().optional()})),
  reqs:z.object({rooms:dayCount,size_idx:dayCount,photos_min:dayCount,dwell_min_seconds:dayCount}),
  photos_count:dayCount,dwell_seconds:dayCount,started_at:dayTime.optional(),slot_counts:z.record(z.string(), dayCount).optional(),
});
const inspectionPhotoReceipt = z.union([
  z.object({accepted:z.literal(false),reason:z.string().min(1),message:z.string().optional()}),
  z.object({accepted:z.literal(true),geofence_status:z.enum(['ok','out_of_range','gps_denied']),distance_m:dayAmount.nullable()}),
]);
const inspectionCompleteReceipt = z.object({
  status:z.string().min(1),missing:z.array(z.string()).optional(),message:z.string().optional(),
  tick:z.object({ticked:z.boolean(),day_rate:dayAmount.optional(),streak:z.object({current:dayCount,next:z.object({days_to_go:z.number().int(),delta:dayAmount}).nullable().optional()}).optional()}).nullable().optional(),
  spawned_job_id:z.string().min(1).nullable().optional(),
}).refine(r=>r.status!=='presence'||Array.isArray(r.missing),'Unconfirmed inspection requirements');


// Bọc bằng ARROW chứ không `.bind()`: dưới `strict`, `.bind()` bắt trình biên dịch
// duyệt hết ~640 overload của `supabase.rpc` và nó bỏ cuộc với TS2589
// ("type instantiation is excessively deep"). Arrow wrapper cho cùng kết quả lúc
// chạy mà không đụng chuỗi overload. Cùng cách chữa đã dùng ở
// `src/lib/network-center/supabaseRepository.ts`.
type GoiRpc = (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
const rpc: GoiRpc = (fn, args) => (supabase.rpc as unknown as GoiRpc)(fn, args);

export interface MyDaySummary {
  today: { date: string; status: string; tick_source: string | null };
  attend: { n_chuan: number; day_rate: number; ticked_days: number; tam_tinh: number; budget: number };
  streak: {
    current: number; best: number; breaks_no_leave: number;
    shields_free_left: number; shields_reserve_left: number;
    // V5.1 (kỳ ≥ 09/2026): kho tháng-hoàn-hảo + điểm Chủ nhật; kỳ legacy không có 2 key này
    shields_perfect_left?: number; sunday_points_left?: number;
    banked: { milestone: number | "full_month"; delta: number; top?: boolean }[];
    next: { milestone: number; delta: number; days_to_go: number } | null;
  };
  pending_checks: { building_id: string; building_name: string | null }[];
  leave: { quota: number; used: number; left: number };
  stage: string;
}

export interface Mission {
  building_id: string;
  building_name: string;
  cluster_id: string | null;
  latitude: number | null;
  longitude: number | null;
  street_address?: string | null;
  ward?: string | null;
  district?: string | null;
  province?: string | null;
  public_map_url?: string | null;
  last_touch_date: string | null;
  last_full_date: string | null;
  days_since_touch: number | null;
  days_since_full: number | null;
  vacant_rooms: number;
  rooms_total: number;
  expiring_contracts: number;
  open_jobs: number;
  score: number | string;
  priority_bucket: number;
  priority_label: string;
  touch_sla_days: number;
  full_interval_days: number;
  checked_today: boolean;
  last_full_by_name: string | null;
  color: "red" | "yellow" | "green";
  reason: string;
}

export function useMyDaySummary() {
  return useQuery({
    queryKey: ["v5-my-day-summary"],
    queryFn: async (): Promise<MyDaySummary> => {
      const { data, error } = await rpc("get_my_day_summary");
      if (error) throw error;
      return daySummaryReceipt.parse(data) as MyDaySummary;
    },
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useMyMissions() {
  return useQuery({
    queryKey: ["v5-my-missions"],
    queryFn: async (): Promise<Mission[]> => {
      const { data, error } = await rpc("v5_route_candidates_self");
      if (error) throw error;
      if (!Array.isArray(data)) throw new TypeError("Chưa tải được danh sách tòa cần kiểm tra.");
      return data as Mission[];
    },
    staleTime: 60_000,
  });
}

// Màn Hôm nay của nhân viên, thẻ duyệt của chủ, chấm trạng thái từng người (PersonPicker / thẻ ngày công) và Bảng lương
// cùng đọc trạng thái phép: gửi hay duyệt đơn đều làm mới đủ các nguồn này.
function invalidateLeaveViews(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["v5-my-day-summary"] });
  qc.invalidateQueries({ queryKey: ["v5-pending-leaves"] });
  qc.invalidateQueries({ queryKey: ["manager-salary"] });
  qc.invalidateQueries({ queryKey: ["staff-day"] });
}

const leaveRangeReceipt = z.object({
  from: dayDate, to: dayDate, requested: z.array(dayDate), existing: z.array(dayDate), holidays: z.array(dayDate),
  batch: z.string().min(1).nullable(),
});
export type LeaveRangeResult = z.infer<typeof leaveRangeReceipt>;

/**
 * Ngày làm (T2–T7 trừ ngày lễ của công ty người gọi — vn_workdays) của các tháng mà khoảng [from, to] chạm tới. Biểu mẫu
 * xin nghỉ dùng để xem trước đúng số ngày máy chủ sẽ ghi (máy chủ đọc cùng RPC). Khoảng sai / quá dài ⇒ không đọc.
 */
export function useLeaveWorkdays(from: string, to: string) {
  const months = leaveMonths(from, to);
  return useQuery({
    queryKey: ["v5-workdays", ...months],
    enabled: months.length > 0,
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<string[]> => {
      const days: string[] = [];
      for (const month of months) {
        const { data, error } = await rpc("vn_workdays", { p_month: month });
        if (error) throw error;
        days.push(...z.array(dayDate).parse(data));
      }
      return days;
    },
  });
}

/**
 * Xin nghỉ phép có lương từ ngày đến ngày trong MỘT đơn (request_paid_leave_range, 20261119020927): Chủ nhật và ngày lễ
 * của công ty không tính, số dư phải đủ cho mọi ngày mới, ngày đã có đơn giữ nguyên. Một ngày = from bằng to.
 */
export function useRequestLeaveRange() {
  const qc = useQueryClient();
  return useMutation({
    meta: {handlesFeedback:true},
    mutationFn: async (args: { from: string; to: string; reason?: string }) => {
      const { data, error } = await rpc("request_paid_leave_range", {
        p_from: args.from,
        p_to: args.to,
        p_reason: args.reason?.trim() || null,
      });
      if (error) throw error;
      const result = leaveRangeReceipt.parse(data);
      // Biên nhận phải phủ ĐÚNG các ngày không phải Chủ nhật của khoảng đã chọn (ngày ghi đơn + ngày đã có đơn + ngày lễ)
      // — thiếu hay thừa ngày là chưa xác nhận được đơn.
      const covered = [...result.requested, ...result.existing, ...result.holidays].sort().join(",");
      if (result.from !== args.from || result.to !== args.to || covered !== leaveWorkDays(args.from, args.to).join(",")) {
        throw new TypeError("Chưa xác nhận được đơn nghỉ của đúng khoảng ngày đã chọn.");
      }
      return result;
    },
    onSuccess: () => invalidateLeaveViews(qc),
  });
}

/** Lỗi nghiệp vụ của request_paid_leave_range mang HINT leave_*: câu lỗi máy chủ là câu hiển thị cho nhân viên. */
const LEAVE_REQUEST_HINTS = new Set([
  "leave_not_signed_in", "leave_range_invalid", "leave_past_date", "leave_range_too_long", "leave_reason_too_long",
  "leave_no_workday", "leave_day_ticked", "leave_quota_exceeded", "leave_day_changed",
]);
export function leaveRequestErrorMessage(error: unknown): string {
  const record = error && typeof error === "object" ? error as { message?: unknown; hint?: unknown } : {};
  const message = typeof record.message === "string" ? record.message.trim() : "";
  if (typeof record.hint === "string" && LEAVE_REQUEST_HINTS.has(record.hint) && message) {
    return /[.!?]$/.test(message) ? message : `${message}.`;
  }
  return actionErrorMessage(error, "Chưa xác nhận được kết quả gửi đơn nghỉ phép");
}

// ───────────────── Phép — chủ duyệt (admin) ─────────────────
export interface PendingLeaveRequest {
  user_id: string;
  work_date: string;
  reason: string | null;
  requested_at: string | null;
  staff_name: string;
  /** Mã đơn nhiều ngày (evidence.batch) — gom các ngày cùng đơn; null với đơn một ngày. */
  batch: string | null;
}

/** Danh sách đơn xin phép đang chờ duyệt (status='pending_leave') — RLS chỉ trả đủ cho admin. */
export function usePendingLeaveRequests(enabled: boolean = true) {
  return useQuery({
    queryKey: ["v5-pending-leaves"],
    enabled,
    queryFn: async (): Promise<PendingLeaveRequest[]> => {
      const { data, error } = await (supabase
        .from("salary_attendance_day" as any)
        .select("user_id, work_date, evidence") as any)
        .eq("status", "pending_leave")
        .order("work_date", { ascending: true });
      if (error) throw error;
      const rows = financialReadRows(data) as any[];
      const staffIds = [...new Set(rows.map((r) => r.user_id))];
      let nameById = new Map<string, string>();
      if (staffIds.length) {
        const { data: profiles, error: profileError } = await (supabase.from("profiles" as any).select("id, full_name") as any).in("id", staffIds);
        if (profileError) throw profileError;
        nameById = new Map((financialReadRows(profiles) as any[]).map((p) => [p.id, p.full_name]));
      }
      return rows.map((r) => {
        const evidence = Array.isArray(r.evidence) ? r.evidence : [];
        const leaveEvents = evidence.filter((e: any) => e?.kind === "leave_request");
        const last = leaveEvents[leaveEvents.length - 1];
        return {
          user_id: r.user_id,
          work_date: r.work_date,
          reason: last?.reason ?? null,
          requested_at: last?.at ?? null,
          staff_name: nameById.get(r.user_id) ?? "Nhân viên",
          batch: typeof last?.batch === "string" && last.batch ? last.batch : null,
        };
      });
    },
    staleTime: 30_000,
  });
}

export function leaveActionErrorMessage(error: unknown, args: {date: string; approve: boolean; employeeName?: string}) {
  const raw = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  const context = `${args.approve ? 'duyệt' : 'từ chối'} phép ${args.employeeName ? `của ${args.employeeName} ` : ''}ngày ${args.date}`;
  if (raw === 'Chỉ chủ được duyệt phép') return `Bạn không có quyền ${context}. Liên hệ chủ công ty để xử lý đơn này.`;
  if (raw === 'Ngày này không ở trạng thái chờ duyệt phép') return `Đơn nghỉ ngày ${args.date}${args.employeeName ? ` của ${args.employeeName}` : ''} không còn chờ duyệt. Danh sách đã được tải lại để xem trạng thái mới.`;
  // 20261119035131: phép trên Chủ nhật / ngày lễ chỉ được từ chối — câu máy chủ nêu đúng ngày.
  if (error && typeof error === 'object' && 'hint' in error && error.hint === 'leave_not_workday' && raw) return `${raw}.`;
  return actionErrorMessage(error, `Chưa ${context}. Kiểm tra trạng thái đơn trước khi thực hiện tiếp.`);
}

export function useApproveLeave() {
  const qc = useQueryClient();
  return useMutation({
    meta: {handlesFeedback:true},
    mutationFn: async (args: { user: string; date: string; approve: boolean }) => {
      const { data, error } = await rpc("approve_leave", {
        p_user: args.user,
        p_date: args.date,
        p_approve: args.approve,
      });
      if (error) throw error;
      if (!data || typeof data !== 'object' || !('approved' in data) || data.approved !== args.approve || !('date' in data) || data.date !== args.date) throw new TypeError('Unconfirmed leave approval result');
      return data;
    },
    // Thẻ duyệt nằm cả trên các màn Hôm nay của chủ: chấm trạng thái ở PersonPicker và thẻ ngày
    // công của người vừa được duyệt đọc từ ["staff-day", …], không làm mới thì còn «chờ duyệt».
    // Làm mới cả khi lỗi: đơn vừa được xử lý ở chỗ khác / vừa chấm công thì danh sách cũ phải tự cập nhật.
    onSettled: () => invalidateLeaveViews(qc),
  });
}

const leaveBatchReceipt = z.object({ approved: z.boolean(), user: z.string().min(1), dates: z.array(dayDate).min(1) });

/**
 * Chủ duyệt / từ chối CẢ đơn nhiều ngày của một người trong một lần (approve_leave_batch, 20261119020927). Máy chủ đổi
 * mọi ngày hoặc không ngày nào, gửi một thông báo kết quả; câu lỗi giống approve_leave nên dùng leaveActionErrorMessage.
 */
export function useApproveLeaveBatch() {
  const qc = useQueryClient();
  return useMutation({
    meta: {handlesFeedback:true},
    mutationFn: async (args: { user: string; dates: readonly string[]; approve: boolean }) => {
      const { data, error } = await rpc("approve_leave_batch", {
        p_user: args.user,
        p_dates: [...args.dates],
        p_approve: args.approve,
      });
      if (error) throw error;
      const result = leaveBatchReceipt.parse(data);
      if (result.approved !== args.approve || result.user !== args.user || result.dates.join(",") !== [...new Set(args.dates)].sort().join(",")) {
        throw new TypeError("Unconfirmed leave batch approval result");
      }
      return result;
    },
    // Làm mới cả khi lỗi (vd. một ngày vừa duyệt lẻ ở Bảng lương / vừa chấm công): thẻ không giữ nhóm cũ.
    onSettled: () => invalidateLeaveViews(qc),
  });
}

// ───────────────── Phiên kiểm tra nhà ─────────────────
export interface InspectionChecklistItem {
  key: string; label: string; required: boolean; done: boolean;
  floor?: number; random?: boolean;
}
export interface InspectionSessionState {
  session_id: string;
  type: "FULL" | "QUICK";
  status: string;
  session_date: string;
  checklist: InspectionChecklistItem[];
  reqs: { rooms: number; size_idx: number; photos_min: number; dwell_min_seconds: number };
  photos_count: number;
  dwell_seconds: number;
  /** Lúc bấm "Kiểm tra" lần đầu trong ngày — đồng hồ dwell chạy từ đây (server trả). */
  started_at?: string;
  /** Số ảnh đã chụp theo từng mục (resume phiên dở hiển thị đúng). */
  slot_counts?: Record<string, number>;
}

/** Phiên kiểm tra ĐANG DỞ hôm nay (open/presence) — để mở lại app còn thấy mà làm tiếp. */
export interface OpenInspectionSession {
  id: string;
  building_id: string;
  type: "FULL" | "QUICK";
  status: string;
  photos_count: number;
  building_name: string | null;
}
export function useMyOpenInspections(today?: string, userId?: string) {
  return useQuery({
    queryKey: ["v5-open-inspections", today, userId],
    enabled: !!today && !!userId,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<OpenInspectionSession[]> => {
      // Bảng v5 chưa có trong types generated → cast (RLS vẫn chỉ trả phiên của mình)
      const { data, error } = await supabase
        .from("inspection_sessions")
        .select("id, building_id, type, status, photos_count, buildings(name)")
        .eq("user_id", batBuoc(userId, "userId"))
        .eq("session_date", batBuoc(today, "today"))
        .in("status", ["open", "presence"])
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return (financialReadRows(data) as any[]).map((r) => ({
        id: r.id,
        building_id: r.building_id,
        type: r.type,
        status: r.status,
        photos_count: r.photos_count,
        building_name: r.buildings?.name ?? null,
      }));
    },
  });
}

export function useStartInspection() {
  return useMutation({
    meta: {handlesFeedback:true},
    mutationFn: async (args: { buildingId: string; type: "FULL" | "QUICK"; pairedIncomeExpenseId?: string }) => {
      const { data, error } = await rpc("start_inspection", {
        p_building: args.buildingId,
        p_type: args.type,
        p_paired_income_expense_id: args.pairedIncomeExpenseId ?? null,
      });
      if (error) throw error;
      const result = inspectionStartReceipt.parse(data) as InspectionSessionState;
      if(result.type!==args.type)throw new TypeError("Chưa xác nhận được đúng loại phiên kiểm tra.");
      return result;
    },
  });
}

export function useSubmitInspectionPhoto() {
  return useMutation({
    meta: {handlesFeedback:true},
    mutationFn: async (args: {
      sessionId: string; slot: string; storagePath: string; sha256: string;
      lat: number | null; lng: number | null;
    }) => {
      const { data, error } = await rpc("submit_inspection_photo", {
        p_session: args.sessionId,
        p_slot: args.slot,
        p_storage_path: args.storagePath,
        p_sha256: args.sha256,
        p_lat: args.lat,
        p_lng: args.lng,
        p_exif_time: new Date().toISOString(),
      });
      if (error) throw error;
      return inspectionPhotoReceipt.parse(data) as {accepted:boolean;reason?:string;message?:string;geofence_status?:'ok'|'out_of_range'|'gps_denied';distance_m?:number|null};
    },
  });
}

/**
 * Số ảnh của phiên ĐÃ được chấm 'ok' (trong bán kính toà) — server đòi ≥1 mới
 * chốt được ngày công. Đọc thẳng bảng (RLS chỉ trả phiên của mình) để mở lại
 * phiên dở vẫn biết mình còn thiếu bằng chứng vị trí hay không.
 */
export async function fetchGeoOkCount(sessionId: string): Promise<number> {
  const { count, error } = await supabase
    .from("inspection_photos")
    .select("id", { count: "exact", head: true })
    .eq("session_id", sessionId)
    .eq("geofence_status", "ok");
  if (error) throw error;
  if(typeof count!=="number"||!Number.isSafeInteger(count)||count<0)throw new TypeError("Chưa kiểm tra được số ảnh có vị trí hợp lệ.");
  return count;
}

export function useCompleteInspection() {
  const qc = useQueryClient();
  return useMutation({
    meta: {handlesFeedback:true},
    mutationFn: async (args: { sessionId: string; conditionNote: string }) => {
      const { data, error } = await rpc("complete_inspection", {
        p_session: args.sessionId,
        p_condition_note: args.conditionNote,
      });
      if (error) throw error;
      return inspectionCompleteReceipt.parse(data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["v5-my-day-summary"] });
      qc.invalidateQueries({ queryKey: ["v5-my-missions"] });
      qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}

export function useReportDeviceIssue() {
  return useMutation({
    meta: {handlesFeedback:true},
    mutationFn: async (args: { sessionId: string; reason: string }) => {
      const { data, error } = await rpc("report_device_issue", {
        p_session: args.sessionId,
        p_reason: args.reason,
      });
      if (error) throw error;
      return z.object({reported:z.literal(true)}).parse(data);
    },
  });
}

/** SHA-256 của file ảnh (chống nộp lại ảnh cũ — server đối chiếu theo ngày). */
export async function sha256File(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
