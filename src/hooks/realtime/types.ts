import type { PrefetchDomain } from "@/lib/prefetchPages";
import type { SyncTable } from "@/lib/realtime/syncTables";

/**
 * Kiểu dùng chung cho descriptor realtime, tách ra để 5 module domain khai được
 * mà không import ngược vào hub (vòng import).
 */
export type BusinessPerformanceSubtype =
  | "organizations"
  | "pnl"
  | "snapshot"
  | "occupancy-snapshot"
  | "upcoming-vacancy"
  | "occupancy-trend-12m";

export type BusinessPerformanceInvalidationRule =
  | {
      subtype: "pnl";
      basis?: "ACCRUAL" | "VOUCHER_DATE";
    }
  | {
      subtype: Exclude<BusinessPerformanceSubtype, "pnl">;
    };

export interface SyncEntry {
  table: SyncTable;
  /** Prefix query key sẽ invalidate khi bảng đổi. */
  keys: readonly (readonly unknown[])[];
  /** Domain prefetch cần hâm lại (nếu là trang được prefetch từ màn chính). */
  domain?: PrefetchDomain;
}
