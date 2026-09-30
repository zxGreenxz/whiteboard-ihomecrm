// useMyDay — data hooks cho màn "Ngày hôm nay của tôi" (/my-day) + phiên kiểm tra nhà.
// Mọi con số từ server (get_my_day_summary / v5_daily_missions_self) — KHÔNG hardcode.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { actionErrorMessage } from "@/lib/actionFeedback";
import { batBuoc } from "@/lib/queryGuard";
import { z } from 'zod';
import { financialReadRows } from '@/lib/financialReadValidation';

const dayCount = z.number().int().nonnegative();
const dayAmount = z.number().finite();
const dayDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const dayTime = z.string().datetime({offset:true});
const daySummaryReceipt = z.object({
  today:z.object({date:dayDate,status:z.string().min(1),tick_source:z.string().nullable()}),
  attend:z.object({n_chuan:dayCount,day_rate:dayAmount,ticked_days:dayCount,tam_tinh:dayAmount,budget:dayAmount}),
  streak:z.object({current:dayCount,best:dayCount,breaks_no_leave:dayCount,shields_free_left:dayCount,shields_reserve_left:z.number().int(),
    shields_perfect_left:dayCount.optional(),sunday_points_left:dayCount.optional(),
    banked:z.array(z.object({milestone:z.union([dayCount,z.literal('full_month')]),delta:dayAmount,top:z.boolean().optional()})),
    next:z.object({milestone:dayCount,delta:dayAmount,days_to_go:z.number().int()}).nullable()}),
  pending_checks:z.array(z.object({building_id:z.string().min(1),building_name:z.string().nullable()})),
  leave:z.object({quota:dayCount,used:dayCount,left:dayCount}),stage:z.string().min(1),
});
const inspectionStartReceipt = z.object({
  session_id:z.string().min(1),type:z.enum(['FULL','QUICK']),status:z.string().min(1),session_date:dayDate,
  checklist:z.array(z.object({key:z.string().min(1),label:z.string(),required:z.boolean(),done:z.boolean(),floor:z.number().optional(),random:z.boolean().optional()})),
  reqs:z.object({rooms:dayCount,size_idx:dayCount,photos_min:dayCount,dwell_min_seconds:dayCount}),
  photos_count:dayCount,dwell_seconds:dayCount,started_at:dayTime.optional(),slot_counts:z.record(dayCount).optional(),
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

export function useRequestLeave() {
  const qc = useQueryClient();
  return useMutation({
    meta: {handlesFeedback:true},
    mutationFn: async (args: { date: string; reason?: string }) => {
      const { data, error } = await rpc("request_paid_leave", {
        p_date: args.date,
        p_reason: args.reason ?? null,
      });
      if (error) throw error;
      const result = z.object({status:z.enum(['pending_leave','leave_approved']),date:dayDate,quota_left:dayCount.optional()}).parse(data);
      if(result.date!==args.date)throw new TypeError('Chưa xác nhận được đơn nghỉ của đúng ngày đã chọn.');
      return result;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["v5-my-day-summary"] }),
  });
}

// ───────────────── Phép — chủ duyệt (admin) ─────────────────
export interface PendingLeaveRequest {
  user_id: string;
  work_date: string;
  reason: string | null;
  requested_at: string | null;
  staff_name: string;
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
  if (raw === 'Ngày này không ở trạng thái chờ duyệt phép') return `Đơn nghỉ ngày ${args.date}${args.employeeName ? ` của ${args.employeeName}` : ''} không còn chờ duyệt. Tải lại danh sách để xem trạng thái mới.`;
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["v5-pending-leaves"] });
      qc.invalidateQueries({ queryKey: ["manager-salary"] });
    },
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
