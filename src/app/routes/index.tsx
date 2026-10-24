// Cây route tổng — P1.2 của plan. Trước đây nằm trong App.tsx cùng với 150 dòng
// import và toàn bộ cấu hình provider.
//
// GATE scripts/check-route-guards.mjs QUÉT CẢ THƯ MỤC NÀY, nên mọi route ở đây
// vẫn phải nằm dưới một guard đã biết hoặc được khai TƯỜNG MINH là công khai —
// y như khi chúng còn ở App.tsx.
import { Suspense, useLayoutEffect } from "react";
import { Route, Routes, Navigate, useLocation } from "react-router-dom";
import { hideAppSplash } from "@/lib/appSplash";
import { landlordPortalSlugFromHost } from "@/lib/landlordPortal";
import ProtectedRoute from "../../components/auth/ProtectedRoute";
import { RequirePermission } from "../../components/auth/RequirePermission";
import { ChatZaloPage, LandlordPortalPage, LuckyDrawAdminPage } from "../lazyPages";
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
  const { pathname, search } = useLocation();
  useLayoutEffect(() => hideAppSplash(), []);
  useLayoutEffect(() => {
    window.dispatchEvent(new Event('pwa-route-change'));
  }, [pathname, search]);
  return null;
};

export function AppRoutes() {
  // Tên miền riêng của link chủ nhà (cgiang/agiang.chillhome.io.vn): MỌI đường dẫn đều là trang link đó — cùng
  // trang công khai với route /cn/:slug đã khai ở publicRoutes (vào bằng PIN, server chống dò). Không mở được
  // màn CRM nào khác trên các tên miền này.
  const portalSlug = landlordPortalSlugFromHost(window.location.hostname);
  if (portalSlug) {
    return (
      <>
        <Suspense fallback={null}>
          <LandlordPortalPage slug={portalSlug} />
        </Suspense>
        <RouteTreeCommit />
      </>
    );
  }
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
