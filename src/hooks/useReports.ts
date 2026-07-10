// Shell tương thích API cũ (Phase 10B) — code thật đã tách theo domain vào
// src/hooks/reports/. Chỉ re-export đúng những gì file cũ từng export
// (KHÔNG kéo useOccupancyDashboard — hook đó chưa từng thuộc useReports).
export * from "./reports/types";
export * from "./reports/realEstateReports";
export * from "./reports/financeReports";
