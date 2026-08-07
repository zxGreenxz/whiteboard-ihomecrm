import { REALTIME_SYNC_TABLES, type SyncTable } from "@/lib/realtime/syncTables";
import type { BusinessPerformanceInvalidationRule, SyncEntry } from "./types";
import { CONTRACT_SYNC_ENTRIES } from "./contracts";
import { FINANCE_SYNC_ENTRIES } from "./finance";
import { OPERATIONS_SYNC_ENTRIES } from "./operations";

export type { BusinessPerformanceInvalidationRule, BusinessPerformanceSubtype, SyncEntry } from "./types";

/**
 * Gom descriptor của mọi miền.
 *
 * VÌ SAO CÓ FILE NÀY THAY VÌ HUB TỰ IMPORT BA MẢNG
 *   Tách một mảng 13 phần tử thành ba file tạo ra một cách hỏng MỚI mà bản gộp
 *   không có: quên nối một miền vào hub. Hậu quả trùng khít với lớp lỗi mà cả hệ
 *   realtime này sinh ra để chống — im lặng tuyệt đối, không lỗi, không cảnh báo,
 *   giao diện chỉ ngừng tự cập nhật cho đúng miền bị rơi.
 *
 *   Nên chỗ gom phải kèm phép đối chiếu với danh sách bảng chuẩn
 *   (REALTIME_SYNC_TABLES — cũng là thứ scripts/check-realtime-descriptors.mjs
 *   đối chiếu với publication thật). Ba nguồn phải khớp: bảng được publish, bảng
 *   hub đăng ký, và bảng có descriptor.
 */
export const SYNC_ENTRIES: readonly SyncEntry[] = [
  ...FINANCE_SYNC_ENTRIES,
  ...CONTRACT_SYNC_ENTRIES,
  ...OPERATIONS_SYNC_ENTRIES,
];

/** Bảng có trong danh sách chuẩn mà KHÔNG miền nào khai descriptor. */
export function tablesWithoutDescriptor(): SyncTable[] {
  const co = new Set(SYNC_ENTRIES.map((e) => e.table));
  return REALTIME_SYNC_TABLES.filter((t) => !co.has(t));
}

/** Descriptor trỏ tới bảng KHÔNG có trong danh sách chuẩn (hub sẽ không nghe). */
export function descriptorsWithoutTable(): string[] {
  const chuan = new Set<string>(REALTIME_SYNC_TABLES);
  return SYNC_ENTRIES.map((e) => e.table).filter((t) => !chuan.has(t));
}

/** Bảng bị khai descriptor HAI LẦN ở hai miền — invalidate chạy nhân đôi. */
export function duplicatedTables(): string[] {
  const dem = new Map<string, number>();
  for (const e of SYNC_ENTRIES) dem.set(e.table, (dem.get(e.table) ?? 0) + 1);
  return [...dem.entries()].filter(([, n]) => n > 1).map(([t]) => t);
}

const BUSINESS_PERFORMANCE_OCCUPANCY_RULES = [
  { subtype: "snapshot" },
  { subtype: "occupancy-snapshot" },
  { subtype: "upcoming-vacancy" },
  { subtype: "occupancy-trend-12m" },
] as const satisfies readonly BusinessPerformanceInvalidationRule[];

/**
 * Luật invalidate riêng cho nhóm key ["business-performance", …].
 *
 * Giữ Ở ĐÂY chứ không rải theo miền: một thay đổi ở `buildings` phải đánh vào
 * `pnl` lẫn `organizations` lẫn cả bốn luật occupancy, tức luật này vốn CẮT NGANG
 * các miền. Rải nó ra sẽ buộc mỗi miền biết về nhóm key của miền khác.
 */
export const BUSINESS_PERFORMANCE_INVALIDATION_RULES = {
  invoices: [
    { subtype: "pnl", basis: "ACCRUAL" },
    { subtype: "snapshot" },
  ],
  income_expenses: [{ subtype: "pnl" }],
  contracts: BUSINESS_PERFORMANCE_OCCUPANCY_RULES,
  rooms: BUSINESS_PERFORMANCE_OCCUPANCY_RULES,
  buildings: [
    { subtype: "organizations" },
    { subtype: "pnl" },
    ...BUSINESS_PERFORMANCE_OCCUPANCY_RULES,
  ],
} as const satisfies Partial<
  Record<SyncTable, readonly BusinessPerformanceInvalidationRule[]>
>;
