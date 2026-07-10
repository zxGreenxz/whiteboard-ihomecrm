// Barrel cho các hook báo cáo (Phase 10B) — re-export toàn bộ module theo domain.
// Public API tương thích cả 2 đường import:
//   - "@/hooks/reports"   (barrel này, KÈM useOccupancyDashboard Phase 8)
//   - "@/hooks/useReports" (shell cũ — chỉ những export vốn có của file cũ)
export * from "./types";
export * from "./realEstateReports";
export * from "./financeReports";
export * from "./useOccupancyDashboard";
