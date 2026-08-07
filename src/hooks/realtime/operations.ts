import type { SyncEntry } from "./types";

/**
 * Descriptor realtime của miền VẬN HÀNH: kho phòng/toà nhà, công việc, khách hàng.
 *
 * `rooms` và `buildings` chỉ mang key ["business-performance"] — cố ý. Danh sách
 * phòng/toà đổi rất hiếm và các màn đọc chúng đều có staleTime riêng; thứ cần
 * phản ứng ngay là số liệu hiệu quả kinh doanh tính TỪ chúng.
 */
export const OPERATIONS_SYNC_ENTRIES: readonly SyncEntry[] = [
  { table: "rooms", keys: [["business-performance"]] },
  {
    table: "buildings",
    keys: [["business-performance"]],
  },
  { table: "jobs", keys: [["jobs"]], domain: "jobs" },
  { table: "customers", keys: [["customers"], ["customer-stats"]] },
];
