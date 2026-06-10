import { lazy, Suspense } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useParams } from "react-router-dom";
import ErrorBoundary from "./components/errors/ErrorBoundary";

// Backward-compat redirect: /tenants/:id → /customers/:id (giữ id, không
// đổ về danh sách).
function TenantToCustomerRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/customers/${id ?? ''}`} replace />;
}

// ===== Eager imports — cần cho first paint / luôn dùng =====
// Auth Pages (màn đầu tiên user thấy)
import Register from "./pages/auth/Register";
import Login from "./pages/auth/Login";
import ForgotPassword from "./pages/auth/ForgotPassword";
import ResetPassword from "./pages/auth/ResetPassword";
import Dashboard from "./pages/Dashboard";
import NotFound from "./pages/NotFound";

// Route Guards
import ProtectedRoute from "./components/auth/ProtectedRoute";
import PublicRoute from "./components/auth/PublicRoute";
import { AdminOnlyRoute } from "./components/auth/AdminOnlyRoute";
import { RequirePermission } from "./components/auth/RequirePermission";

// ===== Lazy imports — code-split theo route =====
// Bundle chính từng là 3.8 MB (1.05 MB gzip) vì ~80 page import tĩnh kéo theo
// xlsx/docxtemplater/recharts. Mỗi page lazy thành chunk riêng; <Suspense>
// bọc chung quanh <Routes> (riêng /r/:token và /thu-tien giữ Suspense cục bộ
// vì có CSS toàn cục cần cô lập).
const BuildingMapPage = lazy(() => import("./pages/building-map/BuildingMapPage"));
const NotificationsPage = lazy(() => import("./pages/NotificationsPage"));

// Danh mục dữ liệu
const AreasPage = lazy(() => import("./pages/areas/AreasPage"));
const BuildingsPage = lazy(() => import("./pages/buildings/BuildingsPage"));
const BuildingDetailPage = lazy(() => import("./pages/buildings/BuildingDetailPage"));
const RoomsPage = lazy(() => import("./pages/rooms/RoomsPage"));
const RoomDetailPage = lazy(() => import("./pages/rooms/RoomDetailPage"));
const ServicesPage = lazy(() => import("./pages/services/ServicesPage"));
const SalePhongPage = lazy(() => import("./pages/sale-phong/SalePhongPage"));

// Khách hàng
const LeadsPage = lazy(() => import("./pages/leads/LeadsPage"));
const DepositsPage = lazy(() => import("./pages/deposits/DepositsPage"));
const ContractsPage = lazy(() => import("./pages/contracts/ContractsPage"));
const ContractDetailPage = lazy(() => import("./pages/contracts/ContractDetailPage"));
const VehiclesPage = lazy(() => import("./pages/vehicles/VehiclesPage"));
const CustomersPage = lazy(() => import("./pages/customers/CustomersPage"));
const CustomerFormPage = lazy(() => import("./pages/customers/CustomerFormPage"));
const CustomerDetailPage = lazy(() => import("./pages/customers/CustomerDetailPage"));
const CT01FormPage = lazy(() => import("./pages/customers/CT01FormPage"));

// Tài chính
const MeterReadingsPage = lazy(() => import("./pages/meter-readings/MeterReadingsPage"));
const InvoicesPage = lazy(() => import("./pages/invoices/InvoicesPage"));
const InvoiceDetailPage = lazy(() => import("./pages/invoices/InvoiceDetailPage"));
const InvoicePrintPage = lazy(() => import("./pages/invoices/InvoicePrintPage"));
const IncomeExpensePage = lazy(() => import("./pages/payments/IncomeExpensePage"));
const IncomeExpensePrintPage = lazy(() => import("./pages/payments/IncomeExpensePrintPage"));
const RefundLogPage = lazy(() => import("./pages/payments/RefundLogPage"));

// Tài sản & vật tư
const AssetsPage = lazy(() => import("./pages/assets/AssetsPage"));
const MaterialsPage = lazy(() => import("./pages/materials/MaterialsPage"));

// Báo cáo
const RealEstateReportsPage = lazy(() => import("./pages/reports/RealEstateReportsPage"));
const FinanceReportsPage = lazy(() => import("./pages/reports/FinanceReportsPage"));
const VacantRoomsReport = lazy(() => import("./pages/reports/real-estate/VacantRoomsReport"));
const ExpiringContractsReport = lazy(() => import("./pages/reports/real-estate/ExpiringContractsReport"));
const OccupancyReport = lazy(() => import("./pages/reports/real-estate/OccupancyReport"));
const OccupancyNewReport = lazy(() => import("./pages/reports/real-estate/OccupancyNewReport"));
const RenewalsTransfersReport = lazy(() => import("./pages/reports/real-estate/RenewalsTransfersReport"));
const PromotionsReport = lazy(() => import("./pages/reports/real-estate/PromotionsReport"));
const NewLeasesReport = lazy(() => import("./pages/reports/real-estate/NewLeasesReport"));
const TerminationsReport = lazy(() => import("./pages/reports/real-estate/TerminationsReport"));
const ExpenseRatioReport = lazy(() => import("./pages/reports/real-estate/ExpenseRatioReport"));
const DailyCashbookReport = lazy(() => import("./pages/reports/finance/DailyCashbookReport"));
const CashFlowReport = lazy(() => import("./pages/reports/finance/CashFlowReport"));
const DebtReport = lazy(() => import("./pages/reports/finance/DebtReport"));
const CustomerDebtReport = lazy(() => import("./pages/reports/finance/CustomerDebtReport"));
const PaymentScheduleReport = lazy(() => import("./pages/reports/finance/PaymentScheduleReport"));
const OverpaymentReport = lazy(() => import("./pages/reports/finance/OverpaymentReport"));
const DepositsReport = lazy(() => import("./pages/reports/finance/DepositsReport"));
const ProfitDistributionReport = lazy(() => import("./pages/reports/finance/ProfitDistributionReport"));

// Cài đặt
const GeneralSettingsPage = lazy(() => import("./pages/settings/GeneralSettingsPage"));
const CategoriesPage = lazy(() => import("./pages/settings/CategoriesPage"));
const TemplatesPage = lazy(() => import("./pages/settings/TemplatesPage"));
const SignaturesPage = lazy(() => import("./pages/settings/SignaturesPage"));
const StaffPage = lazy(() => import("./pages/settings/StaffPage"));
const AdminUsersPage = lazy(() => import("./pages/admin/UsersPage"));
const BankAccountsPage = lazy(() => import("./pages/settings/categories/BankAccountsPage"));
const AutoDebtPage = lazy(() => import("./pages/settings/categories/AutoDebtPage"));
const ServiceQuotasPage = lazy(() => import("./pages/settings/categories/ServiceQuotasPage"));
const MetersPage = lazy(() => import("./pages/settings/MetersPage"));
const IncomeExpenseTypesNewPage = lazy(() => import("./pages/settings/IncomeExpenseTypesPage"));
const IncomeExpenseTemplatesPage = lazy(() => import("./pages/settings/IncomeExpenseTemplatesPage"));
const CashbooksPage = lazy(() => import("./pages/settings/finance/CashbooksPage"));
const ShareholderProfitPage = lazy(() => import("./pages/finance/ShareholderProfitPage"));
const PersonalWalletPage = lazy(() => import("./pages/finance/PersonalWalletPage"));
const SuppliersPage = lazy(() => import("./pages/settings/categories/SuppliersPage"));
const WarehousesPage = lazy(() => import("./pages/settings/categories/WarehousesPage"));
const AssetTypesPage = lazy(() => import("./pages/settings/categories/AssetTypesPage"));
const AssetMovementsPage = lazy(() => import("./pages/settings/categories/AssetMovementsPage"));
const AssetMaintenancePage = lazy(() => import("./pages/settings/categories/AssetMaintenancePage"));
const HotlinesPage = lazy(() => import("./pages/settings/categories/HotlinesPage"));
const GeneralCategoriesPage = lazy(() => import("./pages/settings/categories/GeneralCategoriesPage"));
const FloorsPage = lazy(() => import("./pages/settings/categories/FloorsPage"));
const TaskTypesPage = lazy(() => import("./pages/settings/categories/TaskTypesPage"));
const TaskManagementPage = lazy(() => import("./pages/TaskManagementPage"));

// Tài khoản + Info + Public
const ProfilePage = lazy(() => import("./pages/account/ProfilePage"));
const SubscriptionPage = lazy(() => import("./pages/account/SubscriptionPage"));
const PublicContractInvoicePage = lazy(() => import("./pages/public/PublicContractInvoicePage"));
const FaqPage = lazy(() => import("./pages/FaqPage"));
const ChangelogPage = lazy(() => import("./pages/ChangelogPage"));
const AppGuidePage = lazy(() => import("./pages/AppGuidePage"));

// Trang công khai "Phòng trống" (share link) — lazy để CSS toàn cục của nó
// (phongTrong.css đặt style body ngoài @layer) chỉ nạp khi mở /r/:token,
// không rò font/nền sang phần còn lại của CRM.
const PhongTrongPage = lazy(() => import("./pages/phong-trong/PhongTrongPage"));

// Trang "Thu tiền" (mobile, đi thu tiền mặt) — page phụ độc lập có bộ style
// riêng (thu-tien.css scope dưới .tt-page). Lazy để CSS + font Be Vietnam Pro /
// Space Mono chỉ nạp khi mở /thu-tien, không kế thừa/đụng theme site.
const ThuTien = lazy(() => import("./pages/ThuTien"));

// Fallback khi đang tải chunk của route lazy
const RouteFallback = () => (
  <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
    Đang tải…
  </div>
);

// CRM nội bộ: dữ liệu 1 phút tuổi chấp nhận được. staleTime=0 +
// refetchOnWindowFocus mặc định của TanStack Query khiến MỌI query đang mount
// refetch lại mỗi lần Alt-Tab — nhân 3-5 lần số request không cần thiết.
// Hook cần tươi hơn (notifications, dashboard-stats) tự khai staleTime/
// refetchInterval riêng nên không bị ảnh hưởng; mutation vẫn cập nhật đúng
// vì toàn repo dùng invalidateQueries sau mutation.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <ErrorBoundary>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <Suspense fallback={<RouteFallback />}>
          <Routes>
          {/* ========================================
              PUBLIC ROUTES - Only for unauthenticated users
              ======================================== */}
          <Route
            path="/register"
            element={
              <PublicRoute>
                <Register />
              </PublicRoute>
            }
          />
          <Route
            path="/login"
            element={
              <PublicRoute>
                <Login />
              </PublicRoute>
            }
          />
          <Route
            path="/forgot-password"
            element={
              <PublicRoute>
                <ForgotPassword />
              </PublicRoute>
            }
          />
          <Route
            path="/reset-password"
            element={<ResetPassword />}
          />

          {/* ========================================
              PUBLIC PAGES - Không cần đăng nhập
              (Dùng cho QR hợp đồng → hoá đơn mới nhất)
              Link ngắn: /c/<public_code 6 ký tự>
              ======================================== */}
          <Route path="/c/:code" element={<PublicContractInvoicePage />} />

          {/* Trang công khai "Phòng trống" (Sale view, share link). Lazy + Suspense
              để cô lập phongTrong.css. KHÔNG bọc ProtectedRoute. */}
          <Route
            path="/r/:token"
            element={
              <Suspense fallback={null}>
                <PhongTrongPage />
              </Suspense>
            }
          />

          {/* ========================================
              PROTECTED ROUTES - Require authentication
              ======================================== */}

          {/* === THEO DÕI NHANH === */}
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Dashboard />
              </ProtectedRoute>
            }
          />
          <Route path="/building-map" element={<ProtectedRoute><BuildingMapPage /></ProtectedRoute>} />
          <Route path="/notifications" element={<ProtectedRoute><NotificationsPage /></ProtectedRoute>} />

          {/* === DANH MỤC DỮ LIỆU === */}
          <Route path="/areas" element={<ProtectedRoute><AreasPage /></ProtectedRoute>} />
          <Route path="/buildings" element={<ProtectedRoute><BuildingsPage /></ProtectedRoute>} />
          <Route path="/buildings/:id" element={<ProtectedRoute><BuildingDetailPage /></ProtectedRoute>} />
          {/* Primary route: /apartments, redirect /rooms → /apartments */}
          <Route path="/apartments" element={<ProtectedRoute><RoomsPage /></ProtectedRoute>} />
          <Route path="/apartments/:id" element={<ProtectedRoute><RoomDetailPage /></ProtectedRoute>} />
          <Route path="/rooms" element={<Navigate to="/apartments" replace />} />
          <Route path="/rooms/:id" element={<Navigate to="/apartments" replace />} />
          <Route path="/services" element={<ProtectedRoute><ServicesPage /></ProtectedRoute>} />
          <Route path="/sale-phong" element={<ProtectedRoute><RequirePermission module="sale_phong" action="view"><SalePhongPage /></RequirePermission></ProtectedRoute>} />
          <Route path="/assets" element={<ProtectedRoute><AssetsPage /></ProtectedRoute>} />
          <Route path="/materials" element={<ProtectedRoute><MaterialsPage /></ProtectedRoute>} />
          <Route path="/materials/purchases" element={<ProtectedRoute><MaterialsPage /></ProtectedRoute>} />
          <Route path="/materials/usages" element={<ProtectedRoute><MaterialsPage /></ProtectedRoute>} />
          <Route path="/materials/adjustments" element={<ProtectedRoute><MaterialsPage /></ProtectedRoute>} />

          {/* === KHÁCH HÀNG === */}
          <Route path="/leads" element={<ProtectedRoute><LeadsPage /></ProtectedRoute>} />
          <Route path="/deposits" element={<ProtectedRoute><DepositsPage /></ProtectedRoute>} />
          <Route path="/reservations" element={<Navigate to="/deposits" replace />} />
          <Route path="/reservations/all" element={<Navigate to="/deposits" replace />} />
          <Route path="/contracts" element={<ProtectedRoute><ContractsPage /></ProtectedRoute>} />
          <Route path="/contracts/:id" element={<ProtectedRoute><ContractDetailPage /></ProtectedRoute>} />
          {/* Primary route: /customers (new CustomersPage), redirect /tenants → /customers */}
          <Route path="/customers" element={<ProtectedRoute><CustomersPage /></ProtectedRoute>} />
          <Route path="/customers/new" element={<ProtectedRoute><CustomerFormPage /></ProtectedRoute>} />
          <Route path="/customers/:id/edit" element={<ProtectedRoute><CustomerFormPage /></ProtectedRoute>} />
          <Route path="/customers/:id/ct01" element={<ProtectedRoute><CT01FormPage /></ProtectedRoute>} />
          <Route path="/customers/:id" element={<ProtectedRoute><CustomerDetailPage /></ProtectedRoute>} />
          <Route path="/tenants" element={<Navigate to="/customers" replace />} />
          <Route path="/tenants/:id" element={<TenantToCustomerRedirect />} />
          <Route path="/vehicles" element={<ProtectedRoute><VehiclesPage /></ProtectedRoute>} />

          {/* === TÀI CHÍNH === */}
          <Route path="/meter-readings" element={<ProtectedRoute><MeterReadingsPage /></ProtectedRoute>} />
          <Route path="/thu-tien" element={<ProtectedRoute><Suspense fallback={null}><ThuTien /></Suspense></ProtectedRoute>} />
          <Route path="/invoices" element={<ProtectedRoute><InvoicesPage /></ProtectedRoute>} />
          <Route path="/invoices/print/:id" element={<ProtectedRoute><InvoicePrintPage /></ProtectedRoute>} />
          <Route path="/invoices/:id" element={<ProtectedRoute><InvoiceDetailPage /></ProtectedRoute>} />
          {/* Primary route: /income-expense, redirect /payments → /income-expense */}
          <Route path="/income-expense" element={<ProtectedRoute><IncomeExpensePage /></ProtectedRoute>} />
          <Route path="/income-expense/print/:id" element={<ProtectedRoute><IncomeExpensePrintPage /></ProtectedRoute>} />
          <Route path="/finance/refund-log" element={<ProtectedRoute><RefundLogPage /></ProtectedRoute>} />
          <Route path="/payments" element={<Navigate to="/income-expense" replace />} />
          <Route path="/payments/income-expenses" element={<Navigate to="/income-expense" replace />} />
          <Route path="/payments/income-expense" element={<Navigate to="/income-expense" replace />} />

          {/* === CÔNG VIỆC === */}
          <Route path="/tasks" element={<ProtectedRoute><TaskManagementPage /></ProtectedRoute>} />

          {/* === BÁO CÁO BĐS === */}
          <Route path="/reports/real-estate" element={<ProtectedRoute><RealEstateReportsPage /></ProtectedRoute>} />
          <Route path="/reports/real-estate/vacant-rooms" element={<ProtectedRoute><VacantRoomsReport /></ProtectedRoute>} />
          <Route path="/reports/real-estate/vacant" element={<ProtectedRoute><VacantRoomsReport /></ProtectedRoute>} />
          <Route path="/reports/real-estate/expiring-contracts" element={<ProtectedRoute><ExpiringContractsReport /></ProtectedRoute>} />
          <Route path="/reports/real-estate/expiring" element={<ProtectedRoute><ExpiringContractsReport /></ProtectedRoute>} />
          <Route path="/reports/real-estate/renewals-transfers" element={<ProtectedRoute><RenewalsTransfersReport /></ProtectedRoute>} />
          <Route path="/reports/real-estate/occupancy" element={<ProtectedRoute><OccupancyReport /></ProtectedRoute>} />
          <Route path="/reports/real-estate/occupancy-new" element={<ProtectedRoute><OccupancyNewReport /></ProtectedRoute>} />
          <Route path="/reports/real-estate/promotions" element={<ProtectedRoute><PromotionsReport /></ProtectedRoute>} />
          <Route path="/reports/real-estate/new-leases" element={<ProtectedRoute><NewLeasesReport /></ProtectedRoute>} />
          <Route path="/reports/real-estate/terminations" element={<ProtectedRoute><TerminationsReport /></ProtectedRoute>} />
          <Route path="/reports/real-estate/expense-ratio" element={<ProtectedRoute><ExpenseRatioReport /></ProtectedRoute>} />

          {/* === BÁO CÁO TÀI CHÍNH === */}
          {/* Resident-style URLs (canonical) */}
          <Route path="/report/finance/cashbook" element={<ProtectedRoute><DailyCashbookReport /></ProtectedRoute>} />
          <Route path="/report/finance/cash-flow" element={<ProtectedRoute><CashFlowReport /></ProtectedRoute>} />
          <Route path="/report/finance-by-month" element={<ProtectedRoute><ProfitDistributionReport /></ProtectedRoute>} />
          <Route path="/report/finance/debt" element={<ProtectedRoute><CustomerDebtReport /></ProtectedRoute>} />
          <Route path="/report/finance/billing-calendar" element={<ProtectedRoute><PaymentScheduleReport /></ProtectedRoute>} />
          <Route path="/report/finance/prepaid" element={<ProtectedRoute><OverpaymentReport /></ProtectedRoute>} />
          <Route path="/report/finance/deposit" element={<ProtectedRoute><DepositsReport /></ProtectedRoute>} />
          {/* Legacy URLs (kept for backward compatibility, also serve as hub) */}
          <Route path="/reports/finance" element={<ProtectedRoute><FinanceReportsPage /></ProtectedRoute>} />
          <Route path="/reports/finance/daily-cashbook" element={<ProtectedRoute><DailyCashbookReport /></ProtectedRoute>} />
          <Route path="/reports/finance/cash-book" element={<ProtectedRoute><DailyCashbookReport /></ProtectedRoute>} />
          <Route path="/reports/finance/cash-flow" element={<ProtectedRoute><CashFlowReport /></ProtectedRoute>} />
          <Route path="/reports/finance/profit-distribution" element={<ProtectedRoute><ProfitDistributionReport /></ProtectedRoute>} />
          <Route path="/reports/finance/new-contract-debt" element={<ProtectedRoute><DebtReport /></ProtectedRoute>} />
          <Route path="/reports/finance/debt" element={<ProtectedRoute><DebtReport /></ProtectedRoute>} />
          <Route path="/reports/finance/customer-debt" element={<ProtectedRoute><CustomerDebtReport /></ProtectedRoute>} />
          <Route path="/reports/finance/payment-schedule" element={<ProtectedRoute><PaymentScheduleReport /></ProtectedRoute>} />
          <Route path="/reports/finance/overpayment" element={<ProtectedRoute><OverpaymentReport /></ProtectedRoute>} />
          <Route path="/reports/finance/deposits" element={<ProtectedRoute><DepositsReport /></ProtectedRoute>} />

          {/* === CHIA LỢI NHUẬN CỔ ĐÔNG + VÍ THU CHI CÁ NHÂN === */}
          <Route path="/finance/shareholder-profit" element={<ProtectedRoute><RequirePermission module="shareholder_profit" action="view"><ShareholderProfitPage /></RequirePermission></ProtectedRoute>} />
          <Route path="/reports/finance/shareholder-profit" element={<Navigate to="/finance/shareholder-profit" replace />} />
          <Route path="/finance/personal-wallet" element={<ProtectedRoute><RequirePermission module="personal_finance" action="view"><PersonalWalletPage /></RequirePermission></ProtectedRoute>} />

          {/* === BÁO CÁO CÔNG VIỆC === (đang xây dựng lại) */}

          {/* === ADMIN — QUẢN LÝ TÀI KHOẢN === */}
          <Route path="/admin/users" element={<ProtectedRoute><AdminOnlyRoute><AdminUsersPage /></AdminOnlyRoute></ProtectedRoute>} />

          {/* === CÀI ĐẶT HỆ THỐNG === */}
          <Route path="/settings/general" element={<ProtectedRoute><GeneralSettingsPage /></ProtectedRoute>} />
          <Route path="/general-setting" element={<Navigate to="/settings/general" replace />} />
          <Route path="/settings/categories" element={<ProtectedRoute><CategoriesPage /></ProtectedRoute>} />
          {/* Categories Sub-Pages - Tài chính */}
          <Route path="/settings/categories/bank-accounts" element={<ProtectedRoute><BankAccountsPage /></ProtectedRoute>} />
          <Route path="/settings/categories/auto-debt" element={<ProtectedRoute><AutoDebtPage /></ProtectedRoute>} />
          {/* Loại thu chi: page chính ở /settings/income-expense-types.
              Hai URL còn lại (legacy + Resident-style) redirect về để tránh trùng. */}
          <Route path="/settings/categories/income-expense-types" element={<Navigate to="/settings/income-expense-types" replace />} />
          <Route path="/setting/finance/income-expense-types" element={<Navigate to="/settings/income-expense-types" replace />} />
          <Route path="/settings/categories/service-quotas" element={<ProtectedRoute><ServiceQuotasPage /></ProtectedRoute>} />
          <Route path="/settings/categories/meters" element={<Navigate to="/settings/meters" replace />} />
          <Route path="/settings/meters" element={<ProtectedRoute><MetersPage /></ProtectedRoute>} />
          <Route path="/settings/income-expense-types" element={<ProtectedRoute><IncomeExpenseTypesNewPage /></ProtectedRoute>} />
          <Route path="/settings/income-expense-templates" element={<ProtectedRoute><IncomeExpenseTemplatesPage /></ProtectedRoute>} />
          {/* Cashbooks (Tài khoản): canonical URL is /finance/cashbooks under
              VẬN HÀNH → Tài chính (cùng nhóm với Thu chi). Legacy URLs aliased. */}
          <Route path="/finance/cashbooks" element={<ProtectedRoute><CashbooksPage /></ProtectedRoute>} />
          <Route path="/setting/finance/cashbooks" element={<Navigate to="/finance/cashbooks" replace />} />
          <Route path="/settings/finance/cashbooks" element={<Navigate to="/finance/cashbooks" replace />} />
          <Route path="/cashbooks" element={<Navigate to="/finance/cashbooks" replace />} />
          {/* Categories Sub-Pages - Tài sản */}
          <Route path="/settings/categories/suppliers" element={<ProtectedRoute><SuppliersPage /></ProtectedRoute>} />
          <Route path="/settings/categories/warehouses" element={<ProtectedRoute><WarehousesPage /></ProtectedRoute>} />
          <Route path="/settings/categories/asset-types" element={<ProtectedRoute><AssetTypesPage /></ProtectedRoute>} />
          <Route path="/settings/categories/asset-movements" element={<ProtectedRoute><AssetMovementsPage /></ProtectedRoute>} />
          <Route path="/settings/categories/asset-maintenance" element={<ProtectedRoute><AssetMaintenancePage /></ProtectedRoute>} />
          {/* Categories Sub-Pages - Khác */}
          <Route path="/settings/categories/hotlines" element={<ProtectedRoute><HotlinesPage /></ProtectedRoute>} />
          <Route path="/settings/categories/general" element={<ProtectedRoute><GeneralCategoriesPage /></ProtectedRoute>} />
          <Route path="/settings/categories/floors" element={<ProtectedRoute><FloorsPage /></ProtectedRoute>} />
          <Route path="/settings/categories/task-types" element={<ProtectedRoute><TaskTypesPage /></ProtectedRoute>} />
          <Route path="/settings/templates" element={<ProtectedRoute><TemplatesPage /></ProtectedRoute>} />
          <Route path="/settings/signatures" element={<ProtectedRoute><SignaturesPage /></ProtectedRoute>} />
          <Route path="/settings/staff" element={<ProtectedRoute><RequirePermission module="users" action="view"><StaffPage /></RequirePermission></ProtectedRoute>} />

          {/* === TÀI KHOẢN === */}
          <Route path="/account/profile" element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />
          <Route path="/account/subscription" element={<ProtectedRoute><SubscriptionPage /></ProtectedRoute>} />

          {/* === THÔNG TIN KHÁC === */}
          <Route path="/faq" element={<ProtectedRoute><FaqPage /></ProtectedRoute>} />
          <Route path="/changelog" element={<ProtectedRoute><ChangelogPage /></ProtectedRoute>} />
          <Route path="/app-guide" element={<ProtectedRoute><AppGuidePage /></ProtectedRoute>} />

          {/* === REDIRECTS from old routes === */}
          <Route path="/cash-book" element={<Navigate to="/reports/finance/daily-cashbook" replace />} />

          {/* 404 Not Found - Catch all */}
          <Route path="*" element={<NotFound />} />
        </Routes>
        </Suspense>
      </BrowserRouter>
      </ErrorBoundary>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
