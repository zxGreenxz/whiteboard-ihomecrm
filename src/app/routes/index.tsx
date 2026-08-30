// Cây route tổng — P1.2 của plan. Trước đây nằm trong App.tsx cùng với 150 dòng
// import và toàn bộ cấu hình provider.
//
// GATE scripts/check-route-guards.mjs QUÉT CẢ THƯ MỤC NÀY, nên mọi route ở đây
// vẫn phải nằm dưới một guard đã biết hoặc được khai TƯỜNG MINH là công khai —
// y như khi chúng còn ở App.tsx.
import { useLayoutEffect } from "react";
import { Route, Routes, Navigate } from "react-router-dom";
import { hideAppSplash } from "@/lib/appSplash";
import ProtectedRoute from "../../components/auth/ProtectedRoute";
import { RequirePermission } from "../../components/auth/RequirePermission";
import { ChatZaloPage, LuckyDrawAdminPage } from "../lazyPages";
import NotFound from "../../pages/NotFound";
import { publicRoutes } from "./publicRoutes";
import { quickTrackRoutes } from "./quickTrackRoutes";
import { catalogRoutes } from "./catalogRoutes";
import { customerRoutes } from "./customerRoutes";
import { realEstateReportRoutes } from "./realEstateReportRoutes";
import { financeReportRoutes } from "./financeReportRoutes";
import { financeWorkRoutes } from "./financeWorkRoutes";
import { salaryProfitRoutes } from "./salaryProfitRoutes";
import { settingsRoutes } from "./settingsRoutes";
import { adminAccountRoutes } from "./adminAccountRoutes";

/**
 * Gỡ splash NGAY khi cây route commit lần đầu, không đợi effect thường.
 * `useLayoutEffect` chạy trước khi trình duyệt vẽ, nên không có một khung hình
 * nào splash và nội dung cùng xuất hiện.
 */
const RouteTreeCommit = (): null => {
  useLayoutEffect(() => hideAppSplash(), []);
  return null;
};

export function AppRoutes() {
  return (
    <>
      <Routes>
        {publicRoutes}

        {/* ========================================
            PROTECTED ROUTES - Require authentication
            ======================================== */}

        {/* Quản trị sự kiện quay số: server tự guard OWNER/STAFF qua RPC
            (42501), route chỉ cần đăng nhập. */}
        <Route
          path="/quayso/admin"
          element={
            <ProtectedRoute>
              <LuckyDrawAdminPage />
            </ProtectedRoute>
          }
        />

        {quickTrackRoutes}
        {/* === KÊNH CHAT === */}
        <Route path="/chat-zalo" element={<ProtectedRoute><RequirePermission module="chat_zalo" action="view"><ChatZaloPage /></RequirePermission></ProtectedRoute>} />
        {catalogRoutes}
        {customerRoutes}
        {realEstateReportRoutes}
        {financeReportRoutes}
        {financeWorkRoutes}
        {salaryProfitRoutes}
        {settingsRoutes}
        {adminAccountRoutes}
        {/* === REDIRECTS from old routes === */}
        <Route path="/cash-book" element={<Navigate to="/reports/finance/daily-cashbook" replace />} />

        {/* 404 Not Found - Catch all */}
        <Route path="*" element={<NotFound />} />
      </Routes>
      <RouteTreeCommit />
    </>
  );
}
