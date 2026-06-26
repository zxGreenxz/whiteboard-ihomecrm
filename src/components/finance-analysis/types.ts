/**
 * Types cho trang Phân tích tài chính (/report/finance/analysis).
 *
 * Row interfaces khớp 1-1 RETURNS TABLE của các RPC fa_* (migration
 * 20260611140000_financial_analysis_rpcs.sql). Để ở module thuần type
 * (không runtime import) cho cả hooks lẫn utils/tests dùng chung.
 */

/** Bộ lọc chung của trang — derive 1 lần ở shell, truyền props xuống tab. */
export interface AnalysisFilters {
  /** Tháng phân tích 'YYYY-MM'. */
  ym: string;
  /** Ngày đầu tháng phân tích 'YYYY-MM-01'. */
  periodStart: string;
  /** Ngày cuối tháng phân tích 'YYYY-MM-DD'. */
  periodEnd: string;
  /** Tháng liền trước 'YYYY-MM' (so MoM). */
  prevYm: string;
  /** Cùng kỳ năm trước 'YYYY-MM' (so YoY). */
  yoyYm: string;
  /** Đầu cửa sổ 13 tháng = yoyYm — 1 lần fetch phục vụ chart 12T + MoM + YoY + YTD. */
  t13StartYm: string;
  /** 'YYYY-MM-01' của t13StartYm. */
  t13Start: string;
  /** = periodEnd. */
  t13End: string;
  /** 12 tháng 'YYYY-MM' kết thúc tại ym (trục X chart/ma trận). */
  months12: string[];
  /** [] = tất cả toà (gồm toà ảo "Chung"). */
  buildingIds: string[];
  /** true = ghi nhận DỒN TÍCH (theo kỳ áp dụng / billing_month) — đồng bộ Phân bổ
   *  lợi nhuận; false = TIỀN MẶT (theo ngày phiếu). Chỉ ảnh hưởng P&L & cơ cấu
   *  hạng mục; chỉ số vận hành (lấp đầy, thu hồi, tuổi nợ) không phụ thuộc. */
  accrual: boolean;
}

// ── Row shapes từ RPC ────────────────────────────────────────────────

export interface FaMonthlyPnlRow {
  month: string; // 'YYYY-MM-01'
  building_id: string;
  building_name: string;
  is_virtual: boolean;
  revenue: number;
  expense: number;
  net: number;
}

export interface FaTypeBreakdownRow {
  month: string; // 'YYYY-MM-01'
  side: "INCOME" | "EXPENSE";
  type_id: string | null; // null = "Không có hạng mục"
  type_name: string;
  category: string | null;
  total_amount: number;
  voucher_count: number;
}

export interface FaOccupancyRow {
  month: string; // 'YYYY-MM-01'
  building_id: string;
  building_name: string;
  total_rooms: number;
  occupied_rooms: number;
  occupancy_pct: number;
}

export interface FaLeaseEventsRow {
  month: string; // 'YYYY-MM-01'
  building_id: string;
  building_name: string;
  new_contracts: number;
  renewals: number;
  terminations: number;
}

export interface FaInvoiceCollectionRow {
  billing_month: string; // 'YYYY-MM'
  building_id: string;
  building_name: string;
  billed: number;
  collected: number;
  remaining: number;
  invoice_count: number;
  draft_count: number;
  pending_count: number;
  approved_count: number;
  paid_count: number;
  partial_count: number;
  overdue_count: number;
}

export interface FaSnapshotKpisRow {
  building_id: string;
  building_name: string;
  total_rooms: number;
  rooms_available: number;
  rooms_occupied: number;
  rooms_reserved: number;
  rooms_maintenance: number;
  rooms_unavailable: number;
  vacancy_loss_month: number;
  active_contracts: number;
  avg_rent: number;
  deposit_held: number;
  receivable_total: number;
  aging_not_due: number;
  aging_1_30: number;
  aging_31_60: number;
  aging_61_90: number;
  aging_over_90: number;
}

/** Tổng thu/chi/LN của 1 tháng (cộng mọi toà trong scope). */
export interface MonthAgg {
  ym: string;
  revenue: number;
  expense: number;
  net: number;
}

/** 1 nhận định tự động trên panel "Nhận định & khuyến nghị". */
export interface Insight {
  severity: "red" | "amber" | "green";
  title: string;
  detail?: string;
}
