// Data hooks cho Báo cáo Lấp đầy v2 (Phase 8) — TOÀN BỘ tổng hợp chạy server-side
// qua 3 RPC (không fetch rooms/contracts về client nữa → hết cap-1000, hết lệch
// trend >100% do đếm HĐ chồng lấn):
//   - occupancy_snapshot_v2(p_as_of_date, p_building_ids)     → snapshot 5 nhóm/toà
//   - occupancy_upcoming_vacancy_v2(as_of, window, buildings)  → phòng sắp trống
//   - fa_occupancy_monthly(start, end, buildings)              → trend 12 tháng
//
// ĐỊNH NGHĨA metric khoá trong migration 20260710180000_occupancy_v2_rpcs.sql —
// UI/export trích dẫn OCCUPANCY_METRIC_DEFINITIONS bên dưới, đừng tự diễn giải lại.
// Lưu ý 2 định nghĩa "occupied" khác nhau CÓ CHỦ Ý:
//   - snapshot: HĐ ACTIVE đang hiệu lực tại as_of (quá hạn chưa thanh lý vẫn là ở)
//   - trend (fa_occupancy_monthly): HĐ non-DRAFT giao tháng — tháng quá khứ tính cả
//     HĐ nay đã TERMINATED/EXPIRED (đúng lịch sử).
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { format, startOfMonth, subMonths } from "date-fns";

export interface OccupancySnapshotRow {
  building_id: string;
  building_name: string;
  total: number;
  occupied: number;
  reserved: number;
  maintenance: number;
  unavailable: number;
  available: number;
  occupancy_pct: number;
  committed_pct: number;
  missed_revenue: number;
  generated_at: string;
}

export interface UpcomingVacancyRow {
  contract_id: string;
  contract_number: string;
  building_id: string;
  building_name: string;
  room_id: string;
  room_name: string;
  effective_end_date: string;
  days_remaining: number;
  rent_price: number;
  extension_applied: boolean;
}

export interface OccupancyTrendPoint {
  month: string;      // nhãn "M/YYYY"
  occupied: number;   // Σ phòng occupied mọi toà trong filter
  total: number;      // Σ phòng
  rate: number;       // % (0 khi total=0)
}

export const OCCUPANCY_METRIC_DEFINITIONS = [
  "Đang thuê: phòng có HĐ ACTIVE hiệu lực tại ngày snapshot (HĐ quá hạn chưa thanh lý/gia hạn vẫn tính là đang ở).",
  "Đã giữ chỗ: không có HĐ ACTIVE và trạng thái phòng RESERVED (đã cọc).",
  "Trống: không có HĐ ACTIVE và trạng thái AVAILABLE.",
  "Bảo trì / Không khai thác: trạng thái MAINTENANCE / UNAVAILABLE (trạng thái bất thường xếp vào Không khai thác, KHÔNG tính Trống).",
  "Tỷ lệ lấp đầy = Đang thuê / Tổng; Tỷ lệ cam kết = (Đang thuê + Giữ chỗ) / Tổng.",
  "Doanh thu bỏ lỡ = Σ giá thuê niêm yết của RIÊNG phòng Trống (không tính giữ chỗ/bảo trì/không khai thác).",
  "Sắp trống: HĐ ACTIVE có ngày hết hạn HIỆU LỰC (đã cộng gia hạn APPROVED/COMPLETED) rơi trong cửa sổ 30/60 ngày; 1 phòng 1 dòng.",
  "Trend theo tháng: phòng có HĐ (mọi trạng thái trừ NHÁP) giao tháng đó — tháng quá khứ tính cả HĐ nay đã thanh lý/hết hạn.",
] as const;

/**
 * buildingIds rỗng = tất cả toà trong scope; RPC tự giao với quyền.
 *
 * TRẢ `undefined`, KHÔNG PHẢI `null`. Cả ba RPC đều khai `p_building_ids?:
 * string[]` trong kiểu sinh tự động, tức tham số có `DEFAULT NULL` trên server:
 * bỏ khoá đi thì server tự dùng NULL. Hành vi y hệt bản cũ, nhưng `null` thì
 * không gán được vào `string[] | undefined` nên nó chặn ba file này khỏi đảo
 * strict. Đây là án lệ đã dùng ở `src/lib/rpcNullable.ts`: tham số CÓ DEFAULT thì
 * bỏ khoá; tham số KHÔNG có DEFAULT mới phải bọc `rpcNullable`.
 */
const toIdsParam = (buildingIds: string[]): string[] | undefined =>
  buildingIds.length > 0 ? buildingIds : undefined;

export function useOccupancySnapshot(asOfDate: string, buildingIds: string[]) {
  return useQuery({
    queryKey: ["occupancy-dashboard", "snapshot", asOfDate, buildingIds] as const,
    queryFn: async (): Promise<OccupancySnapshotRow[]> => {
      const { data, error } = await supabase.rpc("occupancy_snapshot_v2", {
        p_as_of_date: asOfDate,
        p_building_ids: toIdsParam(buildingIds),
      });
      if (error) throw error;
      return (data ?? []) as OccupancySnapshotRow[];
    },
  });
}

export function useUpcomingVacancy(
  asOfDate: string,
  windowDays: number,
  buildingIds: string[],
) {
  return useQuery({
    queryKey: [
      "occupancy-dashboard", "upcoming-vacancy", asOfDate, windowDays, buildingIds,
    ] as const,
    queryFn: async (): Promise<UpcomingVacancyRow[]> => {
      const { data, error } = await supabase.rpc("occupancy_upcoming_vacancy_v2", {
        p_as_of_date: asOfDate,
        p_window_days: windowDays,
        p_building_ids: toIdsParam(buildingIds),
      });
      if (error) throw error;
      return (data ?? []) as UpcomingVacancyRow[];
    },
  });
}

/** Trend 12 tháng (gộp mọi toà trong filter thành 1 đường). */
export function useOccupancyTrend12m(buildingIds: string[]) {
  return useQuery({
    queryKey: ["occupancy-dashboard", "trend-12m", buildingIds] as const,
    queryFn: async (): Promise<OccupancyTrendPoint[]> => {
      const end = new Date();
      const start = startOfMonth(subMonths(end, 11));
      const { data, error } = await supabase.rpc("fa_occupancy_monthly", {
        p_start_date: format(start, "yyyy-MM-dd"),
        p_end_date: format(end, "yyyy-MM-dd"),
        p_building_ids: toIdsParam(buildingIds),
      });
      if (error) throw error;
      // Gộp theo tháng (RPC trả tháng × toà)
      const byMonth = new Map<string, { occupied: number; total: number }>();
      for (const row of data ?? []) {
        const key = row.month as string;
        const cur = byMonth.get(key) ?? { occupied: 0, total: 0 };
        cur.occupied += row.occupied_rooms ?? 0;
        cur.total += row.total_rooms ?? 0;
        byMonth.set(key, cur);
      }
      return [...byMonth.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, v]) => {
          // `month` là chuỗi CHỈ CÓ NGÀY ("2026-02-01") do RPC trả về. Không đưa nó
          // qua `new Date()`: spec quy định chuỗi dạng này parse thành nửa đêm UTC,
          // trong khi getMonth()/getFullYear() lại đọc theo GIỜ MÁY. Ở múi giờ ÂM,
          // nửa đêm UTC ngày 1 rơi về ngày cuối tháng trước ⇒ cả biểu đồ lệch một
          // tháng. Máy ở UTC+7 nên không lộ ra, và CI cũng chạy UTC — bắt được nhờ
          // chạy thử ở UTC-11 (scripts/check-timezone-stability.mjs).
          // Giá trị chỉ có ngày thì cắt chuỗi là đủ, và không phụ thuộc máy chạy.
          const [y, m] = month.slice(0, 7).split("-");
          return {
            month: `${Number(m)}/${y}`,
            occupied: v.occupied,
            total: v.total,
            rate: v.total > 0 ? Number(((v.occupied / v.total) * 100).toFixed(1)) : 0,
          };
        });
    },
  });
}
