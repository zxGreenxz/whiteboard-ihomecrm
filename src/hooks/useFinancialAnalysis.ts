/**
 * Data hooks cho trang Phân tích tài chính — gọi 6 RPC fa_* (migration
 * 20260611140000_financial_analysis_rpcs.sql).
 *
 * - Cả 6 RPC fa_* ĐỀU có trong generated types nên gọi typed, KHÔNG cast.
 *   (Comment cũ ở đây nói ngược lại và viện "convention hiện có" — sai từ lúc
 *   types.ts được regen; nó chỉ còn tác dụng hợp thức hoá việc né kiểm tra kiểu.)
 *   callFa nhận một thunk để mỗi supabase.rpc() giữ được tên hàm dạng literal —
 *   supabase-js phân giải overload bằng kiểu điều kiện trên tên, truyền tên qua
 *   biến `string` là mất sạch kiểu.
 * - numeric qua PostgREST có thể về string → Number() mọi field số.
 * - p_building_ids: [] (tất cả) chuẩn hoá thành null; sort để query key ổn định.
 */

import { useQuery, keepPreviousData } from "@tanstack/react-query";
import type { PostgrestError } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type {
  FaInvoiceCollectionRow,
  FaLeaseEventsRow,
  FaMonthlyPnlRow,
  FaOccupancyRow,
  FaSnapshotKpisRow,
  FaTypeBreakdownRow,
} from "@/components/finance-analysis/types";

const FA = "financial-analysis";
const STALE_SLOW = 5 * 60 * 1000; // dữ liệu tháng lịch sử — đổi khi nhập phiếu lùi ngày
const STALE_LIVE = 60 * 1000; // thu tiền/snapshot — biến động liên tục

const normIds = (ids?: string[]): string[] | null =>
  ids && ids.length ? [...ids].sort() : null;

/**
 * Nhận một THUNK thay vì (tên hàm, params).
 *
 * Chữ ký cũ khai `fn: string` + `params: Record<string, unknown>`, và chính hai
 * kiểu rộng đó là thứ buộc phải ép `(supabase.rpc as any)` ở trong: supabase-js
 * phân giải overload bằng kiểu điều kiện trên TÊN HÀM, nên tên phải còn ở dạng
 * literal ngay tại chỗ gọi `.rpc()`. Truyền qua một tham số `string` là mất sạch.
 *
 * Đổi sang thunk thì `Row` được suy ra TỪ CHÍNH kiểu trả về của RPC, nên hàm
 * `map` nhận hàng đã có kiểu — không còn `(r: any)`.
 */
async function callFa<Row, T>(
  run: () => PromiseLike<{ data: Row[] | null; error: PostgrestError | null }>,
  errMsg: string,
  map: (r: Row) => T,
): Promise<T[]> {
  const { data, error } = await run();
  if (error) {
    toast.error(errMsg);
    throw error;
  }
  return (data || []).map(map);
}

export const useFaMonthlyPnl = (
  start?: string,
  end?: string,
  buildingIds?: string[],
  accrual = false,
) =>
  useQuery({
    queryKey: [FA, "monthly-pnl", accrual ? "accrual" : "cash", start, end, normIds(buildingIds)],
    enabled: !!start && !!end,
    staleTime: STALE_SLOW,
    placeholderData: keepPreviousData,
    queryFn: () =>
      callFa(
        () => supabase.rpc(accrual ? "fa_monthly_pnl_accrual" : "fa_monthly_pnl", { p_start_date: start, p_end_date: end, p_building_ids: normIds(buildingIds) }),
        "Không thể tải P&L theo tháng",
        (r): FaMonthlyPnlRow => ({
          month: String(r.month),
          building_id: r.building_id,
          building_name: r.building_name,
          is_virtual: !!r.is_virtual,
          revenue: Number(r.revenue) || 0,
          expense: Number(r.expense) || 0,
          net: Number(r.net) || 0,
        }),
      ),
  });

export const useFaTypeBreakdown = (
  start?: string,
  end?: string,
  buildingIds?: string[],
  accrual = false,
) =>
  useQuery({
    queryKey: [FA, "type-breakdown", accrual ? "accrual" : "cash", start, end, normIds(buildingIds)],
    enabled: !!start && !!end,
    staleTime: STALE_SLOW,
    placeholderData: keepPreviousData,
    queryFn: () =>
      callFa(
        () => supabase.rpc(accrual ? "fa_type_breakdown_accrual" : "fa_type_breakdown", { p_start_date: start, p_end_date: end, p_building_ids: normIds(buildingIds) }),
        "Không thể tải cơ cấu thu chi",
        (r): FaTypeBreakdownRow => ({
          month: String(r.month),
          side: r.side === "EXPENSE" ? "EXPENSE" : "INCOME",
          type_id: r.type_id ?? null,
          type_name: r.type_name,
          category: r.category ?? null,
          total_amount: Number(r.total_amount) || 0,
          voucher_count: Number(r.voucher_count) || 0,
        }),
      ),
  });

export const useFaOccupancyMonthly = (start?: string, end?: string, buildingIds?: string[]) =>
  useQuery({
    queryKey: [FA, "occupancy", start, end, normIds(buildingIds)],
    enabled: !!start && !!end,
    staleTime: STALE_SLOW,
    placeholderData: keepPreviousData,
    queryFn: () =>
      callFa(
        () => supabase.rpc("fa_occupancy_monthly", { p_start_date: start, p_end_date: end, p_building_ids: normIds(buildingIds) }),
        "Không thể tải tỷ lệ lấp đầy",
        (r): FaOccupancyRow => ({
          month: String(r.month),
          building_id: r.building_id,
          building_name: r.building_name,
          total_rooms: Number(r.total_rooms) || 0,
          occupied_rooms: Number(r.occupied_rooms) || 0,
          occupancy_pct: Number(r.occupancy_pct) || 0,
        }),
      ),
  });

export const useFaLeaseEvents = (start?: string, end?: string, buildingIds?: string[]) =>
  useQuery({
    queryKey: [FA, "lease-events", start, end, normIds(buildingIds)],
    enabled: !!start && !!end,
    staleTime: STALE_SLOW,
    placeholderData: keepPreviousData,
    queryFn: () =>
      callFa(
        () => supabase.rpc("fa_lease_events", { p_start_date: start, p_end_date: end, p_building_ids: normIds(buildingIds) }),
        "Không thể tải biến động hợp đồng",
        (r): FaLeaseEventsRow => ({
          month: String(r.month),
          building_id: r.building_id,
          building_name: r.building_name,
          new_contracts: Number(r.new_contracts) || 0,
          renewals: Number(r.renewals) || 0,
          terminations: Number(r.terminations) || 0,
        }),
      ),
  });

export const useFaInvoiceCollection = (
  startMonth?: string,
  endMonth?: string,
  buildingIds?: string[],
) =>
  useQuery({
    queryKey: [FA, "invoice-collection", startMonth, endMonth, normIds(buildingIds)],
    enabled: !!startMonth && !!endMonth,
    staleTime: STALE_LIVE,
    placeholderData: keepPreviousData,
    queryFn: () =>
      callFa(
        () => supabase.rpc("fa_invoice_collection", { p_start_month: startMonth, p_end_month: endMonth, p_building_ids: normIds(buildingIds) }),
        "Không thể tải thu hồi hoá đơn",
        (r): FaInvoiceCollectionRow => ({
          billing_month: r.billing_month,
          building_id: r.building_id,
          building_name: r.building_name,
          billed: Number(r.billed) || 0,
          collected: Number(r.collected) || 0,
          remaining: Number(r.remaining) || 0,
          invoice_count: Number(r.invoice_count) || 0,
          draft_count: Number(r.draft_count) || 0,
          pending_count: Number(r.pending_count) || 0,
          approved_count: Number(r.approved_count) || 0,
          paid_count: Number(r.paid_count) || 0,
          partial_count: Number(r.partial_count) || 0,
          overdue_count: Number(r.overdue_count) || 0,
        }),
      ),
  });

export const useFaSnapshotKpis = (buildingIds?: string[]) =>
  useQuery({
    queryKey: [FA, "snapshot-kpis", normIds(buildingIds)],
    staleTime: STALE_LIVE,
    placeholderData: keepPreviousData,
    queryFn: () =>
      callFa(
        () => supabase.rpc("fa_snapshot_kpis", { p_building_ids: normIds(buildingIds) }),
        "Không thể tải KPI hiện tại",
        (r): FaSnapshotKpisRow => ({
          building_id: r.building_id,
          building_name: r.building_name,
          total_rooms: Number(r.total_rooms) || 0,
          rooms_available: Number(r.rooms_available) || 0,
          rooms_occupied: Number(r.rooms_occupied) || 0,
          rooms_reserved: Number(r.rooms_reserved) || 0,
          rooms_maintenance: Number(r.rooms_maintenance) || 0,
          rooms_unavailable: Number(r.rooms_unavailable) || 0,
          vacancy_loss_month: Number(r.vacancy_loss_month) || 0,
          active_contracts: Number(r.active_contracts) || 0,
          avg_rent: Number(r.avg_rent) || 0,
          deposit_held: Number(r.deposit_held) || 0,
          receivable_total: Number(r.receivable_total) || 0,
          aging_not_due: Number(r.aging_not_due) || 0,
          aging_1_30: Number(r.aging_1_30) || 0,
          aging_31_60: Number(r.aging_31_60) || 0,
          aging_61_90: Number(r.aging_61_90) || 0,
          aging_over_90: Number(r.aging_over_90) || 0,
        }),
      ),
  });
