/**
 * Data hooks cho tab "Thống kê" trang công khai Phòng trống (/r/:token).
 * Gọi 7 RPC pra_* (20260621100100_public_room_analytics_reports.sql, nâng cấp ở
 * 20260831100100_pra_errors_v2_nhom_loi.sql).
 *
 * - Mọi RPC pra_* ĐỀU có trong generated types nên gọi typed, KHÔNG cast.
 *   callPra nhận một thunk để mỗi supabase.rpc() giữ được tên hàm dạng literal — supabase-js
 *   phân giải overload bằng kiểu điều kiện trên tên, truyền tên qua biến sẽ mất kiểu.
 *   numeric/bigint qua PostgREST có thể về string → Number().
 * - p_token "" → null; p_building_ids [] → null (sort cho query key ổn định).
 */
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { batBuoc } from "@/lib/queryGuard";
import { supabase } from "@/integrations/supabase/client";
import type { PostgrestError } from "@supabase/supabase-js";

const PRA = "public-rooms-analytics";
const STALE_LIVE = 60 * 1000;

// Trả "undefined" chứ không "null": p_building_ids và p_token của mọi RPC pra_*
// đều DEFAULT NULL, nên bỏ hẳn khoá cho kết quả y hệt — mà kiểu Args sinh tự
// động lại khai "?: T". Khoá cache không đổi hình dạng vì JSON.stringify biến
// "undefined" trong mảng thành "null".
const normIds = (ids?: string[]): string[] | undefined => (ids && ids.length ? [...ids].sort() : undefined);
const normTok = (t?: string): string | undefined => (t && t.length ? t : undefined);
const n=(value:unknown,integer=true):number=>{
 if(typeof value!=='number'&&(typeof value!=='string'||!/^\d+(?:\.\d+)?$/.test(value)))throw new TypeError('Invalid analytics numeric payload');
 const result=Number(value);if(!Number.isFinite(result)||result<0||(integer&&!Number.isSafeInteger(result)))throw new TypeError('Invalid analytics numeric payload');return result;
};
const text=(value:unknown):string=>{if(typeof value!=='string'||!value)throw new TypeError('Invalid analytics text payload');return value;};
const nullableText=(value:unknown):string|null=>{if(value===null)return null;if(typeof value!=='string')throw new TypeError('Invalid analytics nullable text payload');return value;};
const timestamp=(value:unknown):string=>{const result=text(value);const match=/^(\d{4})-(\d{2})-(\d{2})(?:T| )/.exec(result);if(!match||!Number.isFinite(Date.parse(result)))throw new TypeError('Invalid analytics date payload');const day=new Date(Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3])));if(day.getUTCMonth()!==Number(match[2])-1||day.getUTCDate()!==Number(match[3]))throw new TypeError('Invalid analytics date payload');return result;};
const sourceValue=(value:unknown):PraErrorSource=>{if(value!=='app'&&value!=='external')throw new TypeError('Invalid analytics source payload');return value;};
const boolean=(value:unknown):boolean=>{if(typeof value!=='boolean')throw new TypeError('Invalid analytics boolean payload');return value;};
const singleton=<T,>(rows:T[]):T=>{if(rows.length!==1)throw new TypeError('Invalid analytics aggregate payload');return rows[0]!;};

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
  /** Số LƯỢT phiên dính lỗi ứng dụng — đơn vị là cặp (phiên × vân tay). */
  errors: number;
  avg_session_ms: number;
  unique_rooms_seen: number;
  /** Như `errors` nhưng cho nhóm ngoài app (WebView/tiện ích bên thứ ba). */
  errors_external: number;
  /** Tổng số LẦN lỗi ứng dụng xảy ra (cộng bộ đếm lặp trong từng phiên). */
  error_hits: number;
  /**
   * Số lỗi RIÊNG BIỆT của ứng dụng (đếm vân tay) — khớp số dòng bảng "Nhóm lỗi".
   * ĐỪNG lẫn với `errors`: đo trên production 31/08, nhóm ngoài app có 688 lượt
   * phiên nhưng chỉ 2 lỗi riêng biệt.
   */
  error_groups: number;
  error_groups_external: number;
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
/** app = lỗi của mình · external = script bên thứ ba tiêm vào trang. */
export type PraErrorSource = "app" | "external";

export interface PraErrorRow {
  created_at: string;
  token: string;
  session_id: string;
  kind: string | null;
  message: string | null;
  context: string | null;
  user_agent: string | null;
  source: PraErrorSource;
  line_no: number | null;
  col_no: number | null;
  stack: string | null;
  href: string | null;
  viewport: string | null;
  build: string | null;
  fingerprint: string;
  /** Số lần lặp trong phiên (MAX theo (phiên, vân tay)). */
  n: number;
}

export interface PraErrorGroupRow {
  fingerprint: string;
  kind: string | null;
  message: string | null;
  source: PraErrorSource;
  context: string | null;
  /** Tổng số LẦN xảy ra, cộng qua mọi phiên. */
  total_count: number;
  /** Số phiên khách bị dính nhóm lỗi này. */
  sessions: number;
  first_seen: string;
  last_seen: string;
  sample_stack: string | null;
  sample_user_agent: string | null;
  sample_href: string | null;
  sample_build: string | null;
  sample_token: string | null;
}

async function callPra<Row, T>(
  run: () => PromiseLike<{ data: Row[] | null; error: PostgrestError | null }>,
  _errMsg: string,
  map: (r: Row) => T,
): Promise<T[]> {
  const { data, error } = await run();
  if(error)throw error;
  if(!Array.isArray(data)||data.some(row=>!row||typeof row!=='object'||Array.isArray(row)))throw new TypeError('Invalid analytics list payload');
  return data.map(map);
}

// `batBuoc` nay dùng chung ở `@/lib/queryGuard`.
const baseParams = (f: PraFilters) => ({
  p_start_date: batBuoc(f.start, 'start'),
  p_end_date: batBuoc(f.end, 'end'),
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
    meta:{errorDisplay:"inline",label:"thống kê phòng công khai"},
    placeholderData: keepPreviousData,
    queryFn: () =>
      callPra(() => supabase.rpc("pra_summary", baseParams(f)), "Không tải được tổng quan thống kê", (r): PraSummaryRow => ({
        total_sessions: n(r.total_sessions),
        total_views: n(r.total_views),
        room_opens: n(r.room_opens),
        impressions: n(r.impressions),
        contact_clicks: n(r.contact_clicks),
        favorites: n(r.favorites),
        deposit_dialogs: n(r.deposit_dialogs),
        errors: n(r.errors),
        avg_session_ms: n(r.avg_session_ms,false),
        unique_rooms_seen: n(r.unique_rooms_seen),
        errors_external: n(r.errors_external),
        error_hits: n(r.error_hits),
        error_groups: n(r.error_groups),
        error_groups_external: n(r.error_groups_external),
      })),
    select: singleton<PraSummaryRow>,
  });

export const usePraTimeseries = (f: PraFilters, bucket: "day" | "hour" = "day") =>
  useQuery({
    queryKey: [PRA, "timeseries", bucket, ...baseKey(f)],
    enabled: !!f.start && !!f.end,
    staleTime: STALE_LIVE,
    meta:{errorDisplay:"inline",label:"thống kê phòng công khai"},
    placeholderData: keepPreviousData,
    queryFn: () =>
      callPra(
        () => supabase.rpc("pra_timeseries", { ...baseParams(f), p_bucket: bucket }),
        "Không tải được lưu lượng theo thời gian",
        (r): PraTimeseriesRow => ({
          bucket: timestamp(r.bucket),
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
    meta:{errorDisplay:"inline",label:"thống kê phòng công khai"},
    placeholderData: keepPreviousData,
    queryFn: () =>
      callPra(
        () => supabase.rpc("pra_top_rooms", { ...baseParams(f), p_limit: limit }),
        "Không tải được danh sách phòng được xem",
        (r): PraTopRoomRow => ({
          room_id: nullableText(r.room_id),
          room_name: nullableText(r.room_name),
          room_code: nullableText(r.room_code),
          building_name: nullableText(r.building_name),
          open_count: n(r.open_count),
          impression_count: n(r.impression_count),
          total_dwell_ms: n(r.total_dwell_ms,false),
          avg_dwell_ms: n(r.avg_dwell_ms,false),
          contact_clicks: n(r.contact_clicks),
        }),
      ),
  });

export const usePraFunnel = (f: PraFilters) =>
  useQuery({
    queryKey: [PRA, "funnel", ...baseKey(f)],
    enabled: !!f.start && !!f.end,
    staleTime: STALE_LIVE,
    meta:{errorDisplay:"inline",label:"thống kê phòng công khai"},
    placeholderData: keepPreviousData,
    queryFn: () =>
      callPra(() => supabase.rpc("pra_funnel", baseParams(f)), "Không tải được phễu tương tác", (r): PraFunnelRow => ({
        sessions: n(r.sessions),
        sessions_impression: n(r.sessions_impression),
        sessions_opened_room: n(r.sessions_opened_room),
        sessions_contacted: n(r.sessions_contacted),
      })),
    select: singleton<PraFunnelRow>,
  });

export const usePraByToken = (f: PraFilters) =>
  useQuery({
    queryKey: [PRA, "by-token", ...baseKey(f)],
    enabled: !!f.start && !!f.end,
    staleTime: STALE_LIVE,
    meta:{errorDisplay:"inline",label:"thống kê phòng công khai"},
    placeholderData: keepPreviousData,
    queryFn: () =>
      callPra(() => supabase.rpc("pra_by_token", baseParams(f)), "Không tải được thống kê theo link", (r): PraByTokenRow => ({
        token: text(r.token),
        label: nullableText(r.label),
        revoked: boolean(r.revoked),
        sessions: n(r.sessions),
        views: n(r.views),
        room_opens: n(r.room_opens),
        contact_clicks: n(r.contact_clicks),
        errors: n(r.errors),
        avg_session_ms: n(r.avg_session_ms,false),
      })),
  });

/** Nguồn nào cũng lấy → truyền `undefined` để RPC dùng DEFAULT NULL. */
const normSource = (s?: PraErrorSource | "all"): PraErrorSource | undefined =>
  s === "app" || s === "external" ? s : undefined;

export const usePraErrors = (f: PraFilters, limit = 200, source?: PraErrorSource | "all") =>
  useQuery({
    queryKey: [PRA, "errors", limit, normSource(source) ?? "all", ...baseKey(f)],
    enabled: !!f.start && !!f.end,
    staleTime: STALE_LIVE,
    meta:{errorDisplay:"inline",label:"thống kê phòng công khai"},
    placeholderData: keepPreviousData,
    queryFn: () =>
      callPra(
        () =>
          supabase.rpc("pra_errors", {
            ...baseParams(f),
            p_limit: limit,
            p_source: normSource(source),
          }),
        "Không tải được nhật ký lỗi",
        (r): PraErrorRow => ({
          created_at: timestamp(r.created_at),
          token: text(r.token),
          session_id: text(r.session_id),
          kind: nullableText(r.kind),
          message: nullableText(r.message),
          context: nullableText(r.context),
          user_agent: nullableText(r.user_agent),
          source: sourceValue(r.source),
          line_no: r.line_no === null ? null : n(r.line_no),
          col_no: r.col_no === null ? null : n(r.col_no),
          stack: nullableText(r.stack),
          href: nullableText(r.href),
          viewport: nullableText(r.viewport),
          build: nullableText(r.build),
          fingerprint: text(r.fingerprint),
          n: (()=>{const count=n(r.n);if(count<1)throw new TypeError("Invalid analytics occurrence payload");return count;})(),
        }),
      ),
  });

export const usePraErrorGroups = (
  f: PraFilters,
  source?: PraErrorSource | "all",
  limit = 100,
) =>
  useQuery({
    queryKey: [PRA, "error-groups", limit, normSource(source) ?? "all", ...baseKey(f)],
    enabled: !!f.start && !!f.end,
    staleTime: STALE_LIVE,
    meta:{errorDisplay:"inline",label:"thống kê phòng công khai"},
    placeholderData: keepPreviousData,
    queryFn: () =>
      callPra(
        () =>
          supabase.rpc("pra_error_groups", {
            ...baseParams(f),
            p_source: normSource(source),
            p_limit: limit,
          }),
        "Không tải được nhóm lỗi",
        (r): PraErrorGroupRow => ({
          fingerprint: text(r.fingerprint),
          kind: nullableText(r.kind),
          message: nullableText(r.message),
          source: sourceValue(r.source),
          context: nullableText(r.context),
          total_count: n(r.total_count),
          sessions: n(r.sessions),
          first_seen: timestamp(r.first_seen),
          last_seen: timestamp(r.last_seen),
          sample_stack: nullableText(r.sample_stack),
          sample_user_agent: nullableText(r.sample_user_agent),
          sample_href: nullableText(r.sample_href),
          sample_build: nullableText(r.sample_build),
          sample_token: nullableText(r.sample_token),
        }),
      ),
  });
