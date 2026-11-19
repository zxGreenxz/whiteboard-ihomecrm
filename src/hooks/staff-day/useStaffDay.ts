// Dữ liệu các màn «xem theo người». Mọi lời gọi đi qua hàm có cổng quyền ở máy chủ.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import {
  calendarSchema, journeySchema, reportSchema, routeSchema, summarySchema, teamSchema,
} from "@/lib/staffDay";

// Viết thẳng `db.rpc("tên", …)` tại từng nơi gọi để gate bề mặt RPC đọc được tên hàm.
type KetQuaRpc = Promise<{ data: unknown; error: unknown }>;
const db = supabase as unknown as { rpc(fn: string, args?: Record<string, unknown>): KetQuaRpc };

async function read<S extends z.ZodTypeAny>(call: KetQuaRpc, schema: S): Promise<z.output<S>> {
  const { data, error } = await call;
  if (error) throw error;
  return schema.parse(data) as z.output<S>;
}

const omitEmpty = (args: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));

/** Màn đang diễn ra làm mới 30 giây/lần khi tab đang mở; lịch sử thì không cần. */
const LIVE = { staleTime: 20_000, refetchInterval: 30_000, refetchOnWindowFocus: true } as const;
const HISTORY = { staleTime: 60_000 } as const;

/** `background`: bộ chọn người ở đầu màn; lỗi ở đây không được bật thông báo chung. */
export function useStaffDayTeam(date?: string, enabled = true, background = false) {
  return useQuery({
    queryKey: ["staff-day", "team", date ?? "today"],
    enabled,
    queryFn: () => read(db.rpc("staff_day_team_v1", omitEmpty({ p_date: date })), teamSchema),
    ...(date ? HISTORY : LIVE),
    meta: background ? { silent: true } : undefined,
  });
}

export function useStaffDaySummary(userId: string | undefined, date?: string) {
  return useQuery({
    queryKey: ["staff-day", "summary", userId, date ?? "today"],
    enabled: !!userId,
    queryFn: () => read(db.rpc("staff_day_summary_v1", omitEmpty({ p_user: userId, p_date: date })), summarySchema),
    ...(date ? HISTORY : LIVE),
  });
}

export function useStaffDayRoute(userId: string | undefined) {
  return useQuery({
    queryKey: ["staff-day", "route", userId],
    enabled: !!userId,
    queryFn: () => read(db.rpc("staff_day_route_v1", { p_user: userId }), routeSchema),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}

export function useStaffJourney(userId: string | undefined, date: string | undefined, isToday: boolean) {
  return useQuery({
    queryKey: ["staff-day", "journey", userId, date],
    enabled: !!userId && !!date,
    queryFn: () => read(db.rpc("staff_day_journey_v1", { p_user: userId, p_date: date }), journeySchema),
    ...(isToday ? LIVE : HISTORY),
  });
}

export function useStaffCalendar(userId: string | undefined, monthFirstDay: string | undefined) {
  return useQuery({
    queryKey: ["staff-day", "calendar", userId, monthFirstDay],
    enabled: !!userId && !!monthFirstDay,
    queryFn: () => read(db.rpc("staff_day_calendar_v1", { p_user: userId, p_month: monthFirstDay }), calendarSchema),
    ...HISTORY,
  });
}

export function useStaffPeriodReport(from: string | undefined, to: string | undefined) {
  return useQuery({
    queryKey: ["staff-day", "report", from, to],
    enabled: !!from && !!to,
    queryFn: () => read(db.rpc("staff_period_report_v1", { p_from: from, p_to: to }), reportSchema),
    ...HISTORY,
  });
}

export interface StaffReviewInput {
  userId: string;
  from: string;
  to: string;
  rating: "A" | "B" | "C" | null;
  note: string;
}

export function useSaveStaffReview() {
  const client = useQueryClient();
  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: async (input: StaffReviewInput) => {
      const { data, error } = await db.rpc("staff_period_review_set_v1", {
        p_user: input.userId,
        p_from: input.from,
        p_to: input.to,
        p_rating: input.rating,
        p_note: input.note,
      });
      if (error) throw error;
      if (!data || typeof data !== "object") throw new TypeError("Chưa xác nhận được việc lưu nhận xét.");
      return data;
    },
    onSuccess: (_data, input) => {
      void client.invalidateQueries({ queryKey: ["staff-day", "report", input.from, input.to] });
    },
  });
}
