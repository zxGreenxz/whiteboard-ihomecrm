// Nhóm route: Cài đặt hệ thống. Tách khỏi App.tsx (Đợt 4).
//
// Xuất ra một Fragment chứa các <Route>. react-router 6 đệ quy vào Fragment khi
// dựng bảng route, nên cụm này cắm thẳng vào <Routes> mà KHÔNG cần thêm key cho
// từng route — tức JSX giữ nguyên từng ký tự so với bản trong App.tsx.
//
// Gate scripts/check-route-guards.mjs quét cả thư mục này, nên guard của các
// route ở đây vẫn được kiểm như khi chúng còn nằm trong App.tsx.
import { Route, Navigate } from "react-router-dom";
import {
  AiCopilotAdminPage,
  AssetMaintenancePage,
  AssetMovementsPage,
  AssetTypesPage,
  AutoDebtPage,
  BankAccountsPage,
  CashbookClosureRecord,
  CashbooksPage,
  CategoriesPage,
  FixedFeesPage,
  FloorsPage,
  GeneralCategoriesPage,
  GeneralSettingsPage,
  HotlinesPage,
  IncomeExpenseTemplatesPage,
  IncomeExpenseTypesNewPage,
  MetersPage,
  ServiceQuotasPage,
  SignaturesPage,
  SuppliersPage,
  TaskTypesPage,
  TemplatesPage,
  WarehousesPage,
} from "../lazyPages";
import ProtectedRoute from "../../components/auth/ProtectedRoute";
import { RequirePermission } from "../../components/auth/RequirePermission";

export const settingsRoutes = (
  <>
    {/* === CÀI ĐẶT HỆ THỐNG === */}
    <Route path="/settings/general" element={<ProtectedRoute><RequirePermission module="settings"><GeneralSettingsPage /></RequirePermission></ProtectedRoute>} />
    {/* AI Copilot admin — gate super-admin/entitlement BÊN TRONG page (RLS là gate thật) */}
    <Route path="/settings/ai-copilot" element={<ProtectedRoute><AiCopilotAdminPage /></ProtectedRoute>} />
    <Route path="/general-setting" element={<Navigate to="/settings/general" replace />} />
    <Route path="/settings/categories" element={<ProtectedRoute><RequirePermission module="categories"><CategoriesPage /></RequirePermission></ProtectedRoute>} />
    {/* Categories Sub-Pages - Tài chính */}
    <Route path="/settings/categories/bank-accounts" element={<ProtectedRoute><RequirePermission module="categories"><BankAccountsPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/settings/categories/auto-debt" element={<ProtectedRoute><RequirePermission module="auto_debt"><AutoDebtPage /></RequirePermission></ProtectedRoute>} />
    {/* Loại thu chi: page chính ở /settings/income-expense-types.
        Hai URL còn lại (legacy + Resident-style) redirect về để tránh trùng. */}
    <Route path="/settings/categories/income-expense-types" element={<Navigate to="/settings/income-expense-types" replace />} />
    <Route path="/setting/finance/income-expense-types" element={<Navigate to="/settings/income-expense-types" replace />} />
    <Route path="/settings/categories/service-quotas" element={<ProtectedRoute><RequirePermission module="service_quotas"><ServiceQuotasPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/settings/categories/meters" element={<Navigate to="/settings/meters" replace />} />
    <Route path="/settings/meters" element={<ProtectedRoute><RequirePermission module="meters"><MetersPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/settings/income-expense-types" element={<ProtectedRoute><RequirePermission module="categories"><IncomeExpenseTypesNewPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/settings/income-expense-templates" element={<ProtectedRoute><RequirePermission module="categories"><IncomeExpenseTemplatesPage /></RequirePermission></ProtectedRoute>} />
    {/* Cashbooks (Tài khoản): canonical URL is /finance/cashbooks under
        VẬN HÀNH → Tài chính (cùng nhóm với Thu chi). Legacy URLs aliased. */}
    <Route path="/finance/cashbooks" element={<ProtectedRoute><RequirePermission module="cashbooks"><CashbooksPage /></RequirePermission></ProtectedRoute>} />
    {/* Cấu hình giá phí cố định theo toà. Gate trùng /thanh-toan
        (thu_tien/collect) để ai đóng được phí thì cấu hình được — server
        vẫn kiểm lại từng toà trong upsert_building_fee_account. */}
    <Route path="/settings/finance/fixed-fees" element={<ProtectedRoute><RequirePermission module="thu_tien" action="collect"><FixedFeesPage /></RequirePermission></ProtectedRoute>} />
    {/* Biên bản chốt & bàn giao quỹ — in được, ký tay. Gác bằng chính
        quyền xem sổ quỹ; nội dung biên bản đã khoá vĩnh viễn. */}
    <Route path="/finance/cashbooks/closure/:closureId" element={<ProtectedRoute><RequirePermission module="cashbooks"><CashbookClosureRecord /></RequirePermission></ProtectedRoute>} />
    <Route path="/setting/finance/cashbooks" element={<Navigate to="/finance/cashbooks" replace />} />
    <Route path="/settings/finance/cashbooks" element={<Navigate to="/finance/cashbooks" replace />} />
    <Route path="/cashbooks" element={<Navigate to="/finance/cashbooks" replace />} />
    {/* Categories Sub-Pages - Tài sản */}
    <Route path="/settings/categories/suppliers" element={<ProtectedRoute><RequirePermission module="suppliers"><SuppliersPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/settings/categories/warehouses" element={<ProtectedRoute><RequirePermission module="warehouses"><WarehousesPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/settings/categories/asset-types" element={<ProtectedRoute><RequirePermission module="asset_types"><AssetTypesPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/settings/categories/asset-movements" element={<ProtectedRoute><RequirePermission module="assets"><AssetMovementsPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/settings/categories/asset-maintenance" element={<ProtectedRoute><RequirePermission module="assets"><AssetMaintenancePage /></RequirePermission></ProtectedRoute>} />
    {/* Categories Sub-Pages - Khác */}
    <Route path="/settings/categories/hotlines" element={<ProtectedRoute><RequirePermission module="hotline"><HotlinesPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/settings/categories/general" element={<ProtectedRoute><RequirePermission module="categories"><GeneralCategoriesPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/settings/categories/floors" element={<ProtectedRoute><RequirePermission module="categories"><FloorsPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/settings/categories/task-types" element={<ProtectedRoute><RequirePermission module="task_types"><TaskTypesPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/settings/templates" element={<ProtectedRoute><RequirePermission module="templates"><TemplatesPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/settings/signatures" element={<ProtectedRoute><RequirePermission module="templates"><SignaturesPage /></RequirePermission></ProtectedRoute>} />
  </>
);
