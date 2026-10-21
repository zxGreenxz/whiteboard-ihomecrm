// Cây route tổng — P1.2 của plan. Trước đây nằm trong App.tsx cùng với 150 dòng
// import và toàn bộ cấu hình provider.
//
// GATE scripts/check-route-guards.mjs QUÉT CẢ THƯ MỤC NÀY, nên mọi route ở đây
// vẫn phải nằm dưới một guard đã biết hoặc được khai TƯỜNG MINH là công khai —
// y như khi chúng còn ở App.tsx.
import { useEffect, useLayoutEffect, useState, type ComponentType, type ReactElement } from "react";
import { Route, Routes, Navigate, useLocation } from "react-router-dom";
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
  const { pathname, search } = useLocation();
  useLayoutEffect(() => hideAppSplash(), []);
  useLayoutEffect(() => {
    window.dispatchEvent(new Event('pwa-route-change'));
  }, [pathname, search]);
  return null;
};

/**
 * Cầu nối service worker ↔ app (bấm push, số trên icon, đối chiếu đăng ký push).
 * Nằm ở đây vì cần cả Router lẫn OrganizationProvider — xem đầu file cầu nối.
 * Nạp lười bằng effect (không React.lazy): chunk vào app đang sát ngưỡng bundle,
 * và nạp hỏng chỉ được làm mất tính năng này, không được ném lên ErrorBoundary
 * hạ cả cây như một lazy component lỗi.
 */
const ServiceWorkerBridgeLazy = (): ReactElement | null => {
  const [Bridge, setBridge] = useState<ComponentType | null>(null);
  useEffect(() => {
    let alive = true;
    import("@/lib/push/serviceWorkerBridge")
      .then((m) => { if (alive) setBridge(() => m.ServiceWorkerBridge); })
      .catch((error: unknown) => console.warn("[push] chưa nạp được cầu nối service worker", error));
    return () => { alive = false; };
  }, []);
  return Bridge ? <Bridge /> : null;
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
      <ServiceWorkerBridgeLazy />
    </>
  );
}
