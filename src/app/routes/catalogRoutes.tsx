// Nhóm route: Danh mục dữ liệu. Tách khỏi App.tsx (Đợt 4).
//
// Xuất ra một Fragment chứa các <Route>. react-router 6 đệ quy vào Fragment khi
// dựng bảng route, nên cụm này cắm thẳng vào <Routes> mà KHÔNG cần thêm key cho
// từng route — tức JSX giữ nguyên từng ký tự so với bản trong App.tsx.
//
// Gate scripts/check-route-guards.mjs quét cả thư mục này, nên guard của các
// route ở đây vẫn được kiểm như khi chúng còn nằm trong App.tsx.
import { Route, Navigate } from "react-router-dom";
import {
  AssetsPage,
  BuildingDetailPage,
  BuildingsPage,
  MaterialsPage,
  RoomDetailPage,
  RoomsPage,
  SalePhongPage,
  ServicesPage,
} from "../lazyPages";
import ProtectedRoute from "../../components/auth/ProtectedRoute";
import { RequirePermission } from "../../components/auth/RequirePermission";

export const catalogRoutes = (
  <>
    {/* === DANH MỤC DỮ LIỆU === */}
    {/* /areas đã gỡ: khu vực = nhãn nhóm toà, quản lý bằng dialog trong /buildings */}
    <Route path="/areas" element={<Navigate to="/buildings" replace />} />
    <Route path="/buildings" element={<ProtectedRoute><RequirePermission module="buildings"><BuildingsPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/buildings/:id" element={<ProtectedRoute><RequirePermission module="buildings"><BuildingDetailPage /></RequirePermission></ProtectedRoute>} />
    {/* Primary route: /apartments, redirect /rooms → /apartments */}
    <Route path="/apartments" element={<ProtectedRoute><RequirePermission module="rooms"><RoomsPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/apartments/:id" element={<ProtectedRoute><RequirePermission module="rooms"><RoomDetailPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/rooms" element={<Navigate to="/apartments" replace />} />
    <Route path="/rooms/:id" element={<Navigate to="/apartments" replace />} />
    <Route path="/services" element={<ProtectedRoute><RequirePermission module="services"><ServicesPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/sale-phong" element={<ProtectedRoute><RequirePermission module="sale_phong" action="view"><SalePhongPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/assets" element={<ProtectedRoute><RequirePermission module="assets"><AssetsPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/materials" element={<ProtectedRoute><RequirePermission module="materials"><MaterialsPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/materials/purchases" element={<ProtectedRoute><RequirePermission module="materials"><MaterialsPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/materials/usages" element={<ProtectedRoute><RequirePermission module="materials"><MaterialsPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/materials/adjustments" element={<ProtectedRoute><RequirePermission module="materials"><MaterialsPage /></RequirePermission></ProtectedRoute>} />

  </>
);
