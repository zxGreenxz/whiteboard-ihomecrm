// Nhóm route: Theo dõi nhanh. Tách khỏi App.tsx (Đợt 4).
//
// Xuất ra một Fragment chứa các <Route>. react-router 6 đệ quy vào Fragment khi
// dựng bảng route, nên cụm này cắm thẳng vào <Routes> mà KHÔNG cần thêm key cho
// từng route — tức JSX giữ nguyên từng ký tự so với bản trong App.tsx.
//
// Gate scripts/check-route-guards.mjs quét cả thư mục này, nên guard của các
// route ở đây vẫn được kiểm như khi chúng còn nằm trong App.tsx.
import { Route, Navigate } from "react-router-dom";
import { NETWORK_CENTER_RUNTIME_ENABLED } from "@/lib/network-center/runtime";
import {
  BuildingMapPage,
  NetworkCenterApp,
  NotificationsPage,
} from "../lazyPages";
import ProtectedRoute from "../../components/auth/ProtectedRoute";
import HomeRoute from "../../pages/home/HomeRoute";
import DashboardRoute from "../../pages/home/DashboardRoute";
import { RequirePermission } from "../../components/auth/RequirePermission";

export const quickTrackRoutes = (
  <>
    {/* === THEO DÕI NHANH === */}
    {/* "/" tách nhánh: mobile → Home launcher (web-app), desktop → Dashboard. */}
    <Route
      path="/"
      element={
        <ProtectedRoute>
          <HomeRoute />
        </ProtectedRoute>
      }
    />
    {/* /dashboard: Bảng tin — mobile mở màn web-app riêng, desktop về "/". */}
    <Route path="/dashboard" element={<ProtectedRoute><DashboardRoute /></ProtectedRoute>} />
    <Route path="/building-map" element={<ProtectedRoute><RequirePermission module="buildings"><BuildingMapPage /></RequirePermission></ProtectedRoute>} />
    {NETWORK_CENTER_RUNTIME_ENABLED ? (
      <Route path="/network-center/*" element={<ProtectedRoute><RequirePermission module="network_center" action="view"><NetworkCenterApp /></RequirePermission></ProtectedRoute>} />
    ) : null}
    <Route path="/notifications" element={<ProtectedRoute><RequirePermission module="notifications"><NotificationsPage /></RequirePermission></ProtectedRoute>} />

  </>
);
