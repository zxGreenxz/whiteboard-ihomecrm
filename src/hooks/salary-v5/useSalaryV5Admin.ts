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
        const { data: profs } = await supabase
          .from("profiles").select("id, full_name").in("id", ids);
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
    queryFn: async (): Promise<ShadowReport> => {
      const { data, error } = await supabase.rpc("v5_shadow_report", { p_month: month });
      if (error) throw error;
      return (data ?? {}) as ShadowReport;
    },
  });
}

export function useV5AdminConfig() {
  return useQuery({
    queryKey: ["v5-config-admin"],
    queryFn: async (): Promise<V5Config> => {
      const { data, error } = await supabase.rpc("get_salary_v5_config");
      if (error) throw error;
      return (data ?? {}) as V5Config;
    },
  });
}

export function useV5CronRuns() {
  return useQuery({
    queryKey: ["v5-cron-runs"],
    queryFn: async (): Promise<CronRunRow[]> => {
      const { data } = await supabase
        .from("cron_runs")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(20);
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
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["v5-config-admin"] });
      qc.invalidateQueries({ queryKey: ["v5-config-salary-engine"] });
      qc.invalidateQueries({ queryKey: ["manager-salary"] });
      toast.success("Đã lưu cấu hình");
    },
    onError: (e: Error) => toast.error(e?.message ?? "Lỗi lưu cấu hình"),
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
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["v5-flagged"] });
      qc.invalidateQueries({ queryKey: ["v5-lock-assert"] });
      toast.success("Đã kết luận");
    },
  });
}

export function useV5ApplyLock(month: string) {
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("v5_apply_lock_adjustments", { p_month: month });
      if (error) throw error;
      return data as { staff_applied?: number } | null;
    },
    onSuccess: (d) => toast.success(`Đã ghi tiền v5 cho ${d?.staff_applied ?? 0} nhân viên vào bảng lương`),
    onError: (e: Error) => toast.error(e?.message ?? "Không chốt được"),
  });
}

export function useV5RunJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (job: string) => {
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      const res = await fetch(
        `https://tryymsxyyckgbrmmvozx.supabase.co/functions/v1/salary-v5-jobs?job=${job}`,
        { method: "POST", headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["v5-cron-runs"] });
      toast.success("Job đã chạy");
    },
    onError: () => toast.error("Job lỗi — xem cron_runs"),
  });
}
