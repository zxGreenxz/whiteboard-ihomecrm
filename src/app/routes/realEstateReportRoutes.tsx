// Nhóm route: Báo cáo bất động sản. Tách khỏi App.tsx (Đợt 4).
//
// Xuất ra một Fragment chứa các <Route>. react-router 6 đệ quy vào Fragment khi
// dựng bảng route, nên cụm này cắm thẳng vào <Routes> mà KHÔNG cần thêm key cho
// từng route — tức JSX giữ nguyên từng ký tự so với bản trong App.tsx.
//
// Gate scripts/check-route-guards.mjs quét cả thư mục này, nên guard của các
// route ở đây vẫn được kiểm như khi chúng còn nằm trong App.tsx.
import { Route, Navigate } from "react-router-dom";
import {
  ExpenseRatioReport,
  ExpiringContractsReport,
  NewLeasesReport,
  OccupancyReport,
  PromotionsReport,
  RealEstateReportsPage,
  RenewalsTransfersReport,
  TerminationsReport,
  VacantRoomsReport,
} from "../lazyPages";
import ProtectedRoute from "../../components/auth/ProtectedRoute";
import { RequirePermission } from "../../components/auth/RequirePermission";

export const realEstateReportRoutes = (
  <>
    {/* === BÁO CÁO BĐS === */}
    <Route path="/reports/real-estate" element={<ProtectedRoute><RequirePermission module="reports_real_estate"><RealEstateReportsPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/reports/real-estate/vacant-rooms" element={<ProtectedRoute><RequirePermission module="reports_real_estate" action="vacant_rooms"><VacantRoomsReport /></RequirePermission></ProtectedRoute>} />
    <Route path="/reports/real-estate/vacant" element={<ProtectedRoute><RequirePermission module="reports_real_estate" action="vacant_rooms"><VacantRoomsReport /></RequirePermission></ProtectedRoute>} />
    <Route path="/reports/real-estate/expiring-contracts" element={<ProtectedRoute><RequirePermission module="reports_real_estate" action="expiring"><ExpiringContractsReport /></RequirePermission></ProtectedRoute>} />
    <Route path="/reports/real-estate/expiring" element={<ProtectedRoute><RequirePermission module="reports_real_estate" action="expiring"><ExpiringContractsReport /></RequirePermission></ProtectedRoute>} />
    <Route path="/reports/real-estate/renewals-transfers" element={<ProtectedRoute><RequirePermission module="reports_real_estate" action="renewals_transfers"><RenewalsTransfersReport /></RequirePermission></ProtectedRoute>} />
    <Route path="/reports/real-estate/occupancy" element={<ProtectedRoute><RequirePermission module="reports_real_estate" action="occupancy"><OccupancyReport /></RequirePermission></ProtectedRoute>} />
    <Route path="/reports/real-estate/occupancy-new" element={<Navigate to="/reports/real-estate/occupancy" replace />} />
    <Route path="/reports/real-estate/promotions" element={<ProtectedRoute><RequirePermission module="reports_real_estate" action="promotions"><PromotionsReport /></RequirePermission></ProtectedRoute>} />
    <Route path="/reports/real-estate/new-leases" element={<ProtectedRoute><RequirePermission module="reports_real_estate" action="new_leases"><NewLeasesReport /></RequirePermission></ProtectedRoute>} />
    <Route path="/reports/real-estate/terminations" element={<ProtectedRoute><RequirePermission module="reports_real_estate" action="terminations"><TerminationsReport /></RequirePermission></ProtectedRoute>} />
    <Route path="/reports/real-estate/expense-ratio" element={<ProtectedRoute><RequirePermission module="reports_real_estate" action="expense_ratio"><ExpenseRatioReport /></RequirePermission></ProtectedRoute>} />

  </>
);
