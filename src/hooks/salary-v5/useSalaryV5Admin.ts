import { salaryJobFeedback, salarySettingsErrorMessage } from "@/lib/salarySettingsFeedback";
// Data layer cho OwnerDashboardV5 (/reports/coverage) — Phase 9A tách toàn bộ
// query/mutation khỏi UI. GIỮ NGUYÊN query key + invalidation + hành vi (kể cả
// toast) so với bản inline cũ; KHÔNG đổi kill-switch/lock/công thức lương.
// types.ts đã regen (Phase 8) nên các bảng/view v5 có type thật — không `as any`
// theo bảng nữa; RPC trả Json thì ép về DTO khai báo TẠI ĐÂY (1 chỗ duy nhất).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

// ── DTO ──────────────────────────────────────────────────────────────────────
export interface CoverageRow {
  building_id: string;
  building_name: string;
  days_since_touch: number | null;
  days_since_full: number | null;
  rooms_total: number;
  vacant_rooms: number;
  jobs_30d: number;
}

export interface FlaggedDayRow {
  id: string;
  user_id: string;
  work_date: string;
  status: string;
  evidence: unknown;
  audit: unknown;
  tick_source: string | null;
}

export interface InspectionSessionRow {
  id: string;
  user_id: string;
  building_id: string;
  type: string;
  status: string;
  session_date: string;
  started_at: string | null;
  ended_at: string | null;
  dwell_seconds: number | null;
  condition_note: string | null;
  fail_reasons: string[] | null;
  photos_count: number;
  building_name: string;
  manager_name: string;
}

export interface InspectionPhotoRow {
  id: string;
  slot: string;
  storage_path: string;
  lat: number | null;
  lng: number | null;
  distance_m: number | null;
  geofence_status: string | null;
  exif_time: string | null;
}

export interface LockAssertRow {
  staff_id: string;
  staff_name: string;
  ticked_days: number;
  n_chuan: number;
  attend_amount: number;
  streak_amount: number;
  total: number;
  all_ok: boolean;
  a1_caps_ok: boolean;
  a2_no_open_flags: boolean;
  a3_payment_join_ok: boolean;
}

export interface ShadowRow {
  staff_id: string;
  staff_name: string;
  ticked_days: number;
  n_chuan: number;
  best_streak: number;
  breaks_no_leave: number;
  total: number;
}
export interface ShadowReport {
  rows?: ShadowRow[];
  [k: string]: unknown;
}

export interface V5Config {
  system_v5?: {
    feature_flags?: Record<string, boolean>;
    stage?: string;
    salary_engine?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface CronRunRow {
  id: number;
  job: string;
  idem_key: string | null;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

// ── Queries ──────────────────────────────────────────────────────────────────
export function useV5Coverage() {
  return useQuery({
    queryKey: ["v5-coverage-all"],
    meta:{label:"vận hành lương",errorDisplay:"inline"},
    queryFn: async (): Promise<CoverageRow[]> => {
      const { data, error } = await supabase
        .from("building_coverage")
        .select("*")
        .gt("rooms_total", 0)
        .order("days_since_touch", { ascending: false, nullsFirst: true });
      if (error) throw error;
      return (data ?? []) as CoverageRow[];
    },
  });
}

export function useV5Flagged() {
  return useQuery({
    queryKey: ["v5-flagged"],
    meta:{label:"vận hành lương",errorDisplay:"inline"},
    queryFn: async (): Promise<FlaggedDayRow[]> => {
      const { data, error } = await supabase
        .from("salary_attendance_day")
        .select("id, user_id, work_date, status, evidence, audit, tick_source")
        .eq("status", "flagged")
        .order("work_date", { ascending: false });
      if (error) throw error;
      return (data ?? []) as FlaggedDayRow[];
    },
  });
}

// Nhật ký kiểm tra nhà: chủ xem chi tiết phiên của MỌI quản lý.
// RLS insp_sess_select cho is_admin() đọc hết. FK user_id → auth.users (KHÔNG
// phải profiles) nên không embed tên qua PostgREST → fetch profiles riêng rồi map.
export function useV5InspectionLog(dateFrom: string, dateTo: string) {
  return useQuery({
    queryKey: ["v5-inspection-log", dateFrom, dateTo],
    meta:{label:"vận hành lương",errorDisplay:"inline"},
    queryFn: async (): Promise<InspectionSessionRow[]> => {
      const { data, error } = await supabase
        .from("inspection_sessions")
        .select(
          "id, user_id, building_id, type, status, session_date, started_at, ended_at, dwell_seconds, condition_note, fail_reasons, photos_count, buildings(name)",
        )
        .gte("session_date", dateFrom)
        .lte("session_date", dateTo)
        .order("session_date", { ascending: false })
        .order("started_at", { ascending: false });
      if (error) throw error;
      const rows = (data ?? []) as Array<Record<string, unknown> & { buildings?: { name?: string } | null }>;
      const ids = Array.from(new Set(rows.map((r) => r.user_id as string).filter(Boolean)));
      let nameById: Record<string, string> = {};
      if (ids.length) {
        const { data: profs , error: sourceError1 } = await supabase
          .from("profiles").select("id, full_name").in("id", ids);
        if (sourceError1) throw sourceError1;
        nameById = Object.fromEntries((profs ?? []).map((p) => [p.id, p.full_name ?? "—"]));
      }
      return rows.map((r) => ({
        ...r,
        building_name: r.buildings?.name ?? "—",
        manager_name: nameById[r.user_id as string] ?? "—",
      })) as InspectionSessionRow[];
    },
  });
}

export function useV5SessionPhotos(sessionId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["v5-insp-photos", sessionId],
    meta:{label:"vận hành lương",errorDisplay:"inline"},
    enabled,
    queryFn: async (): Promise<InspectionPhotoRow[]> => {
      const { data, error } = await supabase
        .from("inspection_photos")
        .select("id, slot, storage_path, lat, lng, distance_m, geofence_status, exif_time")
        .eq("session_id", sessionId)
        .order("slot");
      if (error) throw error;
      return (data ?? []) as InspectionPhotoRow[];
    },
  });
}

export function useV5LockAssert(month: string) {
  return useQuery({
    queryKey: ["v5-lock-assert", month],
    meta:{label:"vận hành lương",errorDisplay:"inline"},
    queryFn: async (): Promise<LockAssertRow[]> => {
      const { data, error } = await supabase.rpc("v5_lock_assert", { p_month: month });
      if (error) throw error;
      return (data ?? []) as LockAssertRow[];
    },
  });
}

export function useV5ShadowReport(month: string) {
  return useQuery({
    queryKey: ["v5-shadow", month],
    meta:{label:"vận hành lương",errorDisplay:"inline"},
    queryFn: async (): Promise<ShadowReport> => {
      const { data, error } = await supabase.rpc("v5_shadow_report", { p_month: month });
      if (error) throw error;
      if (!data || typeof data !== "object" || !("rows" in data) || !Array.isArray(data.rows)) throw new Error("Invalid salary comparison response");
      return data as ShadowReport;
    },
  });
}

export function useV5AdminConfig() {
  return useQuery({
    queryKey: ["v5-config-admin"],
    meta:{label:"vận hành lương",errorDisplay:"inline"},
    queryFn: async (): Promise<V5Config> => {
      const { data, error } = await supabase.rpc("get_salary_v5_config");
      if (error) throw error;
      if (!data || typeof data !== "object" || !("system_v5" in data)) throw new Error("Invalid salary configuration response");
      return data as V5Config;
    },
  });
}

export function useV5CronRuns() {
  return useQuery({
    queryKey: ["v5-cron-runs"],
    meta:{label:"vận hành lương",errorDisplay:"inline"},
    queryFn: async (): Promise<CronRunRow[]> => {
      const { data , error: sourceError2 } = await supabase
        .from("cron_runs")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(20);
      if (sourceError2) throw sourceError2;
      return (data ?? []) as CronRunRow[];
    },
  });
}

// ── Mutations ────────────────────────────────────────────────────────────────
export function useV5SetConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      const { data, error } = await supabase.rpc("set_salary_v5_config", {
        p_patch: patch as never,
      });
      if (error) throw error;
      if (!data || typeof data !== 'object' || !('system_v5' in data)) throw new TypeError('Unconfirmed salary configuration write');
      const matches = (actual: unknown, expected: unknown): boolean => expected !== null && typeof expected === 'object' && !Array.isArray(expected)
        ? !!actual && typeof actual === 'object' && Object.entries(expected).every(([key,value])=>matches((actual as Record<string,unknown>)[key],value))
        : actual === expected;
      if (patch.system_v5 && !matches(data.system_v5,patch.system_v5)) throw new TypeError('Unconfirmed salary configuration change');
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["v5-config-admin"] });
      qc.invalidateQueries({ queryKey: ["v5-config-salary-engine"] });
      qc.invalidateQueries({ queryKey: ["manager-salary"] });
      toast.success("Đã lưu chế độ và cài đặt vận hành lương.");
    },
    onError: (error) => toast.error(salarySettingsErrorMessage(error,"lưu cài đặt vận hành lương")),
  });
}

export function useV5Verdict() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { user: string; date: string; confirm: boolean }) => {
      const { data, error } = await supabase.rpc("v5_verdict", {
        p_user: args.user, p_date: args.date, p_confirm: args.confirm, p_note: null as never,
      });
      if (error) throw error;
      if (!data || typeof data !== "object" || !("confirmed" in data) || data.confirmed !== args.confirm || !("date" in data) || data.date !== args.date) throw new TypeError("Unconfirmed attendance verdict");
      return data;
    },
    onError: (error,args) => toast.error(salarySettingsErrorMessage(error,`kết luận ngày công ${args.date}`)),
    onSuccess: (_data,args) => {
      qc.invalidateQueries({ queryKey: ["v5-flagged"] });
      qc.invalidateQueries({ queryKey: ["v5-lock-assert"] });
      toast.success(args.confirm ? `Đã hủy công ngày ${args.date} và cập nhật mốc thưởng tháng.` : `Đã xác nhận ngày ${args.date} hợp lệ và trả lại công.`);
    },
  });
}

export function useV5ApplyLock(month: string) {
  const qc=useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("v5_apply_lock_adjustments", { p_month: month });
      if (error) throw error;
      if(!data||typeof data!=='object'||!('staff_applied' in data)||!Number.isInteger(data.staff_applied)||Number(data.staff_applied)<0||!('month' in data)||data.month!==month)throw new TypeError('Unconfirmed salary application result');
      return {staff_applied:Number(data.staff_applied)};
    },
    onSuccess: (d) => {
      qc.invalidateQueries({queryKey:['manager-salary']});qc.invalidateQueries({queryKey:['v5-lock-assert']});
      toast[d.staff_applied ? 'success' : 'info'](d.staff_applied ? `Đã cập nhật tiền chuyên cần và chuỗi vào bảng lương của ${d.staff_applied} nhân viên tháng ${month.slice(5,7)}/${month.slice(0,4)}.` : 'Không có nhân viên cần ghi tiền vào bảng lương trong tháng này.');
    },
    onError: (error) => toast.error(salarySettingsErrorMessage(error,"ghi tiền chuyên cần và chuỗi vào bảng lương")),
  });
}

export function useV5RunJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (job: string) => {
      const { data: session , error: sourceError3 } = await supabase.auth.getSession();
      if (sourceError3) throw sourceError3;
      const token = session.session?.access_token;
      if (!token) throw Object.assign(new Error("unauthorized"),{status:401});
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/salary-v5-jobs?job=${job}`,
        { method: "POST", headers: { Authorization: `Bearer ${token}` } },
      );
      const payload: unknown = await res.json();
      if(!res.ok && (!payload || typeof payload!=='object' || !('ran' in payload) || !Array.isArray(payload.ran) || payload.ran.length===0)) throw Object.assign(res.status>=500 ? new TypeError('Unconfirmed salary job result') : new Error('Salary job request failed'),{status:res.status});
      return salaryJobFeedback(payload);
    },
    onSuccess: (feedback) => {
      qc.invalidateQueries({ queryKey: ["v5-cron-runs"] });
      toast[feedback.kind](feedback.message);
    },
    onError: (error) => toast.error(salarySettingsErrorMessage(error,"chạy tác vụ vận hành lương. Kiểm tra nhật ký tác vụ trước khi thực hiện tiếp")),
  });
}
