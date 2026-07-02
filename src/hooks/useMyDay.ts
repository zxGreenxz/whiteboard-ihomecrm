// useMyDay — data hooks cho màn "Ngày hôm nay của tôi" (/my-day) + phiên kiểm tra nhà.
// Mọi con số từ server (get_my_day_summary / v5_daily_missions_self) — KHÔNG hardcode.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

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
  days_since_touch: number | null;
  days_since_full: number | null;
  vacant_rooms: number;
  score: number;
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
      const { data, error } = await rpc("v5_daily_missions_self");
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
      return data as { accepted: boolean; reason?: string; message?: string; geofence_status?: string };
    },
  });
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
