// Nhóm route: Khách hàng. Tách khỏi App.tsx (Đợt 4).
//
// Xuất ra một Fragment chứa các <Route>. react-router 6 đệ quy vào Fragment khi
// dựng bảng route, nên cụm này cắm thẳng vào <Routes> mà KHÔNG cần thêm key cho
// từng route — tức JSX giữ nguyên từng ký tự so với bản trong App.tsx.
//
// Gate scripts/check-route-guards.mjs quét cả thư mục này, nên guard của các
// route ở đây vẫn được kiểm như khi chúng còn nằm trong App.tsx.
import { Route, Navigate, useParams } from "react-router-dom";
import {
  CT01FormPage,
  ContractDetailPage,
  ContractsPage,
  CustomerDetailPage,
  CustomerFormPage,
  CustomersPage,
  DepositsPage,
  LeadsPage,
  VehiclesPage,
} from "../lazyPages";
import ProtectedRoute from "../../components/auth/ProtectedRoute";
import { RequirePermission } from "../../components/auth/RequirePermission";

// Backward-compat redirect: /tenants/:id → /customers/:id (giữ id, không
// đổ về danh sách). Chuyển từ App.tsx sang đây cùng route dùng nó — nó chỉ phục
// vụ đúng một route, để lại ở App.tsx thì file gốc giữ một mảnh của nhóm này.
function TenantToCustomerRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/customers/${id ?? ''}`} replace />;
}

export const customerRoutes = (
  <>
    {/* === KHÁCH HÀNG === */}
    <Route path="/leads" element={<ProtectedRoute><RequirePermission module="leads"><LeadsPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/deposits" element={<ProtectedRoute><RequirePermission module="deposits"><DepositsPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/reservations" element={<Navigate to="/deposits" replace />} />
    <Route path="/reservations/all" element={<Navigate to="/deposits" replace />} />
    <Route path="/contracts" element={<ProtectedRoute><RequirePermission module="contracts"><ContractsPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/contracts/:id" element={<ProtectedRoute><RequirePermission module="contracts"><ContractDetailPage /></RequirePermission></ProtectedRoute>} />
    {/* Primary route: /customers (new CustomersPage), redirect /tenants → /customers */}
    <Route path="/customers" element={<ProtectedRoute><RequirePermission module="customers"><CustomersPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/customers/new" element={<ProtectedRoute><RequirePermission module="customers" action="create"><CustomerFormPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/customers/:id/edit" element={<ProtectedRoute><RequirePermission module="customers" action="edit"><CustomerFormPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/customers/:id/ct01" element={<ProtectedRoute><RequirePermission module="customers" action="print"><CT01FormPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/customers/:id" element={<ProtectedRoute><RequirePermission module="customers"><CustomerDetailPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/tenants" element={<Navigate to="/customers" replace />} />
    <Route path="/tenants/:id" element={<TenantToCustomerRedirect />} />
    <Route path="/vehicles" element={<ProtectedRoute><RequirePermission module="vehicles"><VehiclesPage /></RequirePermission></ProtectedRoute>} />

  </>
);
