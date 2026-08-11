// useMyDay — data hooks cho màn "Ngày hôm nay của tôi" (/my-day) + phiên kiểm tra nhà.
// Mọi con số từ server (get_my_day_summary / v5_daily_missions_self) — KHÔNG hardcode.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { batBuoc } from "@/lib/queryGuard";

const rpc = supabase.rpc.bind(supabase) as (fn: string, args?: Record<string, unknown>) => any;

export interface MyDaySummary {
  today: { date: string; status: string; tick_source: string | null };
  attend: { n_chuan: number; day_rate: number; ticked_days: number; tam_tinh: number; budget: number };
  streak: {
    current: number; best: number; breaks_no_leave: number;
    shields_free_left: number; shields_reserve_left: number;
    banked: { milestone: number | "full_month"; delta: number }[];
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
      return data as MyDaySummary;
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
      return (data ?? []) as Mission[];
    },
    staleTime: 60_000,
  });
}

export function useRequestLeave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { date: string; reason?: string }) => {
      const { data, error } = await rpc("request_paid_leave", {
        p_date: args.date,
        p_reason: args.reason ?? null,
      });
      if (error) throw error;
      return data;
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
      const rows = (data ?? []) as any[];
      const staffIds = [...new Set(rows.map((r) => r.user_id))];
      let nameById = new Map<string, string>();
      if (staffIds.length) {
        const { data: profiles } = await (supabase.from("profiles" as any).select("id, full_name") as any).in("id", staffIds);
        nameById = new Map(((profiles ?? []) as any[]).map((p) => [p.id, p.full_name]));
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

export function useApproveLeave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { user: string; date: string; approve: boolean }) => {
      const { data, error } = await rpc("approve_leave", {
        p_user: args.user,
        p_date: args.date,
        p_approve: args.approve,
      });
      if (error) throw error;
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
      return ((data ?? []) as any[]).map((r) => ({
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
    mutationFn: async (args: { buildingId: string; type: "FULL" | "QUICK"; pairedIncomeExpenseId?: string }) => {
      const { data, error } = await rpc("start_inspection", {
        p_building: args.buildingId,
        p_type: args.type,
        p_paired_income_expense_id: args.pairedIncomeExpenseId ?? null,
      });
      if (error) throw error;
      return data as InspectionSessionState;
    },
  });
}

export function useSubmitInspectionPhoto() {
  return useMutation({
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
      return data as {
        accepted: boolean; reason?: string; message?: string;
        geofence_status?: string; distance_m?: number | null;
      };
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
  if (error) return 0;
  return count ?? 0;
}

export function useCompleteInspection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { sessionId: string; conditionNote: string }) => {
      const { data, error } = await rpc("complete_inspection", {
        p_session: args.sessionId,
        p_condition_note: args.conditionNote,
      });
      if (error) throw error;
      return data as {
        status: string; missing?: string[]; message?: string;
        tick?: { day_rate: number; streak?: { current: number; next?: { days_to_go: number; delta: number } } };
        spawned_job_id?: string | null;
      };
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
    mutationFn: async (args: { sessionId: string; reason: string }) => {
      const { data, error } = await rpc("report_device_issue", {
        p_session: args.sessionId,
        p_reason: args.reason,
      });
      if (error) throw error;
      return data;
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
