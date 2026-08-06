// Nhóm route: Quản trị tài khoản, phân quyền, thông tin cá nhân. Tách khỏi App.tsx (Đợt 4).
//
// Xuất ra một Fragment chứa các <Route>. react-router 6 đệ quy vào Fragment khi
// dựng bảng route, nên cụm này cắm thẳng vào <Routes> mà KHÔNG cần thêm key cho
// từng route — tức JSX giữ nguyên từng ký tự so với bản trong App.tsx.
//
// Gate scripts/check-route-guards.mjs quét cả thư mục này, nên guard của các
// route ở đây vẫn được kiểm như khi chúng còn nằm trong App.tsx.
import { Route, Navigate } from "react-router-dom";
import {
  AcceptInvitation,
  AdminUsersPage,
  AppGuidePage,
  ChangelogPage,
  FaqPage,
  MembersPage,
  OrganizationPage,
  ProfilePage,
  RolesPage,
  SubscriptionPage,
} from "../lazyPages";
import ProtectedRoute from "../../components/auth/ProtectedRoute";
import { AdminOnlyRoute } from "../../components/auth/AdminOnlyRoute";
import { RequirePermission } from "../../components/auth/RequirePermission";

export const adminAccountRoutes = (
  <>
    {/* === ADMIN — QUẢN LÝ TÀI KHOẢN === */}
    <Route path="/admin/users" element={<ProtectedRoute><AdminOnlyRoute><AdminUsersPage /></AdminOnlyRoute></ProtectedRoute>} />

    {/* === PHÂN QUYỀN (mô hình tổ chức V3, thay trang Nhân viên cũ) === */}
    <Route path="/settings/organization" element={<ProtectedRoute><RequirePermission module="users" action="view"><OrganizationPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/settings/members" element={<ProtectedRoute><RequirePermission module="users" action="view"><MembersPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/settings/roles" element={<ProtectedRoute><RequirePermission module="users" action="view"><RolesPage /></RequirePermission></ProtectedRoute>} />
    {/* Đường cũ: giữ lại làm chuyển hướng để link đã lưu / bookmark không gãy. */}
    <Route path="/settings/staff" element={<Navigate to="/settings/members" replace />} />
    {/* Nhận lời mời — cần đăng nhập đúng email đã được mời. */}
    <Route path="/invite/:token" element={<ProtectedRoute><AcceptInvitation /></ProtectedRoute>} />

    {/* === TÀI KHOẢN === */}
    <Route path="/account/profile" element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />
    <Route path="/account/subscription" element={<ProtectedRoute><SubscriptionPage /></ProtectedRoute>} />

    {/* === THÔNG TIN KHÁC === */}
    <Route path="/faq" element={<ProtectedRoute><FaqPage /></ProtectedRoute>} />
    <Route path="/changelog" element={<ProtectedRoute><ChangelogPage /></ProtectedRoute>} />
    <Route path="/app-guide" element={<ProtectedRoute><AppGuidePage /></ProtectedRoute>} />

  </>
);
