/**
 * Data hooks cho tab "Thống kê" trang công khai Phòng trống (/r/:token).
 * Gọi 6 RPC pra_* (migration 20260621100100_public_room_analytics_reports.sql).
 *
 * - RPC chưa có trong generated types → cast (supabase.rpc as any) như convention
 *   useFinancialAnalysis. numeric/bigint qua PostgREST có thể về string → Number().
 * - p_token "" → null; p_building_ids [] → null (sort cho query key ổn định).
 */
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

const PRA = "public-rooms-analytics";
const STALE_LIVE = 60 * 1000;

const normIds = (ids?: string[]): string[] | null => (ids && ids.length ? [...ids].sort() : null);
const normTok = (t?: string): string | null => (t && t.length ? t : null);
const n = (v: unknown): number => Number(v) || 0;

export interface PraFilters {
  start?: string; // yyyy-MM-dd
  end?: string; // yyyy-MM-dd
  token?: string;
  buildingIds?: string[];
  excludeStaff?: boolean;
}

export interface PraSummaryRow {
  total_sessions: number;
  total_views: number;
  room_opens: number;
  impressions: number;
  contact_clicks: number;
  favorites: number;
  deposit_dialogs: number;
  errors: number;
  avg_session_ms: number;
  unique_rooms_seen: number;
}
export interface PraTimeseriesRow {
  bucket: string;
  sessions: number;
  events: number;
  room_opens: number;
  contact_clicks: number;
}
export interface PraTopRoomRow {
  room_id: string | null;
  room_name: string | null;
  room_code: string | null;
  building_name: string | null;
  open_count: number;
  impression_count: number;
  total_dwell_ms: number;
  avg_dwell_ms: number;
  contact_clicks: number;
}
export interface PraFunnelRow {
  sessions: number;
  sessions_impression: number;
  sessions_opened_room: number;
  sessions_contacted: number;
}
export interface PraByTokenRow {
  token: string;
  label: string | null;
  revoked: boolean;
  sessions: number;
  views: number;
  room_opens: number;
  contact_clicks: number;
  errors: number;
  avg_session_ms: number;
}
export interface PraErrorRow {
  created_at: string;
  token: string;
  session_id: string;
  kind: string | null;
  message: string | null;
  context: string | null;
  user_agent: string | null;
}

async function callPra<T>(
  fn: string,
  params: Record<string, unknown>,
  errMsg: string,
  map: (r: any) => T,
): Promise<T[]> {
  const { data, error } = await (supabase.rpc as any)(fn, params);
  if (error) {
    toast.error(errMsg);
    throw error;
  }
  return ((data || []) as any[]).map(map);
}

const baseParams = (f: PraFilters) => ({
  p_start_date: f.start,
  p_end_date: f.end,
  p_token: normTok(f.token),
  p_building_ids: normIds(f.buildingIds),
  p_exclude_staff: !!f.excludeStaff,
});
const baseKey = (f: PraFilters) => [
  f.start, f.end, normTok(f.token), normIds(f.buildingIds), !!f.excludeStaff,
];

export const usePraSummary = (f: PraFilters) =>
  useQuery({
    queryKey: [PRA, "summary", ...baseKey(f)],
    enabled: !!f.start && !!f.end,
    staleTime: STALE_LIVE,
    placeholderData: keepPreviousData,
    queryFn: () =>
      callPra<PraSummaryRow>("pra_summary", baseParams(f), "Không tải được tổng quan thống kê", (r) => ({
        total_sessions: n(r.total_sessions),
        total_views: n(r.total_views),
        room_opens: n(r.room_opens),
        impressions: n(r.impressions),
        contact_clicks: n(r.contact_clicks),
        favorites: n(r.favorites),
        deposit_dialogs: n(r.deposit_dialogs),
        errors: n(r.errors),
        avg_session_ms: n(r.avg_session_ms),
        unique_rooms_seen: n(r.unique_rooms_seen),
      })),
    select: (rows) => rows[0] as PraSummaryRow | undefined,
  });

export const usePraTimeseries = (f: PraFilters, bucket: "day" | "hour" = "day") =>
  useQuery({
    queryKey: [PRA, "timeseries", bucket, ...baseKey(f)],
    enabled: !!f.start && !!f.end,
    staleTime: STALE_LIVE,
    placeholderData: keepPreviousData,
    queryFn: () =>
      callPra<PraTimeseriesRow>(
        "pra_timeseries",
        { ...baseParams(f), p_bucket: bucket },
        "Không tải được lưu lượng theo thời gian",
        (r) => ({
          bucket: String(r.bucket),
          sessions: n(r.sessions),
          events: n(r.events),
          room_opens: n(r.room_opens),
          contact_clicks: n(r.contact_clicks),
        }),
      ),
  });

export const usePraTopRooms = (f: PraFilters, limit = 50) =>
  useQuery({
    queryKey: [PRA, "top-rooms", limit, ...baseKey(f)],
    enabled: !!f.start && !!f.end,
    staleTime: STALE_LIVE,
    placeholderData: keepPreviousData,
    queryFn: () =>
      callPra<PraTopRoomRow>(
        "pra_top_rooms",
        { ...baseParams(f), p_limit: limit },
        "Không tải được danh sách phòng được xem",
        (r) => ({
          room_id: r.room_id ?? null,
          room_name: r.room_name ?? null,
          room_code: r.room_code ?? null,
          building_name: r.building_name ?? null,
          open_count: n(r.open_count),
          impression_count: n(r.impression_count),
          total_dwell_ms: n(r.total_dwell_ms),
          avg_dwell_ms: n(r.avg_dwell_ms),
          contact_clicks: n(r.contact_clicks),
        }),
      ),
  });

export const usePraFunnel = (f: PraFilters) =>
  useQuery({
    queryKey: [PRA, "funnel", ...baseKey(f)],
    enabled: !!f.start && !!f.end,
    staleTime: STALE_LIVE,
    placeholderData: keepPreviousData,
    queryFn: () =>
      callPra<PraFunnelRow>("pra_funnel", baseParams(f), "Không tải được phễu tương tác", (r) => ({
        sessions: n(r.sessions),
        sessions_impression: n(r.sessions_impression),
        sessions_opened_room: n(r.sessions_opened_room),
        sessions_contacted: n(r.sessions_contacted),
      })),
    select: (rows) => rows[0] as PraFunnelRow | undefined,
  });

export const usePraByToken = (f: PraFilters) =>
  useQuery({
    queryKey: [PRA, "by-token", ...baseKey(f)],
    enabled: !!f.start && !!f.end,
    staleTime: STALE_LIVE,
    placeholderData: keepPreviousData,
    queryFn: () =>
      callPra<PraByTokenRow>("pra_by_token", baseParams(f), "Không tải được thống kê theo link", (r) => ({
        token: String(r.token),
        label: r.label ?? null,
        revoked: !!r.revoked,
        sessions: n(r.sessions),
        views: n(r.views),
        room_opens: n(r.room_opens),
        contact_clicks: n(r.contact_clicks),
        errors: n(r.errors),
        avg_session_ms: n(r.avg_session_ms),
      })),
  });

export const usePraErrors = (f: PraFilters, limit = 200) =>
  useQuery({
    queryKey: [PRA, "errors", limit, ...baseKey(f)],
    enabled: !!f.start && !!f.end,
    staleTime: STALE_LIVE,
    placeholderData: keepPreviousData,
    queryFn: () =>
      callPra<PraErrorRow>(
        "pra_errors",
        { ...baseParams(f), p_limit: limit },
        "Không tải được nhật ký lỗi",
        (r) => ({
          created_at: String(r.created_at),
          token: String(r.token),
          session_id: String(r.session_id),
          kind: r.kind ?? null,
          message: r.message ?? null,
          context: r.context ?? null,
          user_agent: r.user_agent ?? null,
        }),
      ),
  });
