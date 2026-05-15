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

// Auth Pages
import Register from "./pages/auth/Register";
import Login from "./pages/auth/Login";
import ForgotPassword from "./pages/auth/ForgotPassword";
import ResetPassword from "./pages/auth/ResetPassword";

// Main Pages
import Dashboard from "./pages/Dashboard";
import BuildingMapPage from "./pages/building-map/BuildingMapPage";
import NotificationsPage from "./pages/NotificationsPage";
import NotFound from "./pages/NotFound";

// Danh mục dữ liệu Pages
import AreasPage from "./pages/areas/AreasPage";
import BuildingsPage from "./pages/buildings/BuildingsPage";
import BuildingDetailPage from "./pages/buildings/BuildingDetailPage";
import RoomsPage from "./pages/rooms/RoomsPage";
import RoomDetailPage from "./pages/rooms/RoomDetailPage";
import BedsPage from "./pages/beds/BedsPage";
import ServicesPage from "./pages/services/ServicesPage";

// Customer Pages
import LeadsPage from "./pages/leads/LeadsPage";
import DepositsPage from "./pages/deposits/DepositsPage";
import ContractsPage from "./pages/contracts/ContractsPage";
import ContractDetailPage from "./pages/contracts/ContractDetailPage";
import TenantsPage from "./pages/tenants/TenantsPage";
import VehiclesPage from "./pages/vehicles/VehiclesPage";
import CustomersPage from "./pages/customers/CustomersPage";
import CustomerFormPage from "./pages/customers/CustomerFormPage";
import CustomerDetailPage from "./pages/customers/CustomerDetailPage";
import CT01FormPage from "./pages/customers/CT01FormPage";

// Finance Pages
import MeterReadingsPage from "./pages/meter-readings/MeterReadingsPage";
import InvoicesPage from "./pages/invoices/InvoicesPage";
import InvoiceDetailPage from "./pages/invoices/InvoiceDetailPage";
import InvoicePrintPage from "./pages/invoices/InvoicePrintPage";
import IncomeExpensePage from "./pages/payments/IncomeExpensePage";
import IncomeExpensePrintPage from "./pages/payments/IncomeExpensePrintPage";
import RefundLogPage from "./pages/payments/RefundLogPage";
// CashBookPage moved to reports/finance/DailyCashbookReport - redirect via /cash-book route below

// Assets Pages
import AssetsPage from "./pages/assets/AssetsPage";

// Reports Pages
import RealEstateReportsPage from "./pages/reports/RealEstateReportsPage";
import FinanceReportsPage from "./pages/reports/FinanceReportsPage";

// Real Estate Reports
import VacantRoomsReport from "./pages/reports/real-estate/VacantRoomsReport";
import ExpiringContractsReport from "./pages/reports/real-estate/ExpiringContractsReport";
import OccupancyReport from "./pages/reports/real-estate/OccupancyReport";
import OccupancyNewReport from "./pages/reports/real-estate/OccupancyNewReport";
import RenewalsTransfersReport from "./pages/reports/real-estate/RenewalsTransfersReport";
import PromotionsReport from "./pages/reports/real-estate/PromotionsReport";
import NewLeasesReport from "./pages/reports/real-estate/NewLeasesReport";
import TerminationsReport from "./pages/reports/real-estate/TerminationsReport";
import ExpenseRatioReport from "./pages/reports/real-estate/ExpenseRatioReport";

// Finance Reports
import DailyCashbookReport from "./pages/reports/finance/DailyCashbookReport";
import CashFlowReport from "./pages/reports/finance/CashFlowReport";
import DebtReport from "./pages/reports/finance/DebtReport";
import CustomerDebtReport from "./pages/reports/finance/CustomerDebtReport";
import PaymentScheduleReport from "./pages/reports/finance/PaymentScheduleReport";
import OverpaymentReport from "./pages/reports/finance/OverpaymentReport";
import DepositsReport from "./pages/reports/finance/DepositsReport";
import ProfitDistributionReport from "./pages/reports/finance/ProfitDistributionReport";

// Settings Pages
import GeneralSettingsPage from "./pages/settings/GeneralSettingsPage";
import CategoriesPage from "./pages/settings/CategoriesPage";
import TemplatesPage from "./pages/settings/TemplatesPage";
import SignaturesPage from "./pages/settings/SignaturesPage";
import StaffPage from "./pages/settings/StaffPage";

// Categories Sub-Pages
import BankAccountsPage from "./pages/settings/categories/BankAccountsPage";
import AutoDebtPage from "./pages/settings/categories/AutoDebtPage";
import ServiceQuotasPage from "./pages/settings/categories/ServiceQuotasPage";
import MetersPage from "./pages/settings/MetersPage";
import IncomeExpenseTypesNewPage from "./pages/settings/IncomeExpenseTypesPage";
import IncomeExpenseTemplatesPage from "./pages/settings/IncomeExpenseTemplatesPage";
import CashbooksPage from "./pages/settings/finance/CashbooksPage";

import SuppliersPage from "./pages/settings/categories/SuppliersPage";
import WarehousesPage from "./pages/settings/categories/WarehousesPage";
import AssetTypesPage from "./pages/settings/categories/AssetTypesPage";
import AssetMovementsPage from "./pages/settings/categories/AssetMovementsPage";
import AssetMaintenancePage from "./pages/settings/categories/AssetMaintenancePage";
import HotlinesPage from "./pages/settings/categories/HotlinesPage";
import GeneralCategoriesPage from "./pages/settings/categories/GeneralCategoriesPage";
import FloorsPage from "./pages/settings/categories/FloorsPage";
import TaskTypesPage from "./pages/settings/categories/TaskTypesPage";
import TaskManagementPage from "./pages/TaskManagementPage";

// Account Pages
import ProfilePage from "./pages/account/ProfilePage";
import SubscriptionPage from "./pages/account/SubscriptionPage";

// Public Pages (không cần đăng nhập, dùng cho QR hợp đồng)
import PublicContractInvoicePage from "./pages/public/PublicContractInvoicePage";

// Info Pages
import FaqPage from "./pages/FaqPage";
import ChangelogPage from "./pages/ChangelogPage";
import AppGuidePage from "./pages/AppGuidePage";

// Route Guards
import ProtectedRoute from "./components/auth/ProtectedRoute";
import PublicRoute from "./components/auth/PublicRoute";
import GuardedRoute from "./components/auth/GuardedRoute";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <ErrorBoundary>
        <Toaster />
        <Sonner />
        <BrowserRouter>
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
              ======================================== */}
          <Route path="/public/contract/:contractId" element={<PublicContractInvoicePage />} />

          {/* ========================================
              PROTECTED ROUTES - Require authentication
              ======================================== */}

          {/* === THEO DÕI NHANH === */}
          <Route path="/" element={<GuardedRoute resource="dashboard"><Dashboard /></GuardedRoute>} />
          <Route path="/building-map" element={<GuardedRoute resource="building_layout"><BuildingMapPage /></GuardedRoute>} />
          <Route path="/notifications" element={<GuardedRoute resource="notifications"><NotificationsPage /></GuardedRoute>} />

          {/* === DANH MỤC DỮ LIỆU === */}
          <Route path="/areas" element={<GuardedRoute resource="areas"><AreasPage /></GuardedRoute>} />
          <Route path="/buildings" element={<GuardedRoute resource="buildings"><BuildingsPage /></GuardedRoute>} />
          <Route path="/buildings/:id" element={<GuardedRoute resource="buildings"><BuildingDetailPage /></GuardedRoute>} />
          {/* Primary route: /apartments, redirect /rooms → /apartments */}
          <Route path="/apartments" element={<GuardedRoute resource="rooms"><RoomsPage /></GuardedRoute>} />
          <Route path="/apartments/:id" element={<GuardedRoute resource="rooms"><RoomDetailPage /></GuardedRoute>} />
          <Route path="/rooms" element={<Navigate to="/apartments" replace />} />
          <Route path="/rooms/:id" element={<Navigate to="/apartments" replace />} />
          <Route path="/beds" element={<GuardedRoute resource="beds"><BedsPage /></GuardedRoute>} />
          <Route path="/services" element={<GuardedRoute resource="services"><ServicesPage /></GuardedRoute>} />
          <Route path="/assets" element={<GuardedRoute resource="assets"><AssetsPage /></GuardedRoute>} />

          {/* === KHÁCH HÀNG === */}
          <Route path="/leads" element={<GuardedRoute resource="leads"><LeadsPage /></GuardedRoute>} />
          <Route path="/deposits" element={<GuardedRoute resource="deposits"><DepositsPage /></GuardedRoute>} />
          <Route path="/reservations" element={<Navigate to="/deposits" replace />} />
          <Route path="/reservations/all" element={<Navigate to="/deposits" replace />} />
          <Route path="/contracts" element={<GuardedRoute resource="contracts"><ContractsPage /></GuardedRoute>} />
          <Route path="/contracts/:id" element={<GuardedRoute resource="contracts"><ContractDetailPage /></GuardedRoute>} />
          {/* Primary route: /customers (new CustomersPage), redirect /tenants → /customers */}
          <Route path="/customers" element={<GuardedRoute resource="customers"><CustomersPage /></GuardedRoute>} />
          <Route path="/customers/new" element={<GuardedRoute resource="customers" action="create"><CustomerFormPage /></GuardedRoute>} />
          <Route path="/customers/:id/edit" element={<GuardedRoute resource="customers" action="edit"><CustomerFormPage /></GuardedRoute>} />
          <Route path="/customers/:id/ct01" element={<GuardedRoute resource="customers" action="print_ct01"><CT01FormPage /></GuardedRoute>} />
          <Route path="/customers/:id" element={<GuardedRoute resource="customers"><CustomerDetailPage /></GuardedRoute>} />
          <Route path="/tenants" element={<Navigate to="/customers" replace />} />
          <Route path="/tenants/:id" element={<TenantToCustomerRedirect />} />
          <Route path="/vehicles" element={<GuardedRoute resource="vehicles"><VehiclesPage /></GuardedRoute>} />

          {/* === TÀI CHÍNH === */}
          <Route path="/meter-readings" element={<GuardedRoute resource="meter_readings"><MeterReadingsPage /></GuardedRoute>} />
          <Route path="/invoices" element={<GuardedRoute resource="invoices"><InvoicesPage /></GuardedRoute>} />
          <Route path="/invoices/print/:id" element={<GuardedRoute resource="invoices"><InvoicePrintPage /></GuardedRoute>} />
          <Route path="/invoices/:id" element={<GuardedRoute resource="invoices"><InvoiceDetailPage /></GuardedRoute>} />
          {/* Primary route: /income-expense, redirect /payments → /income-expense */}
          <Route path="/income-expense" element={<GuardedRoute resource="income_expenses"><IncomeExpensePage /></GuardedRoute>} />
          <Route path="/income-expense/print/:id" element={<GuardedRoute resource="income_expenses"><IncomeExpensePrintPage /></GuardedRoute>} />
          <Route path="/finance/refund-log" element={<GuardedRoute resource="refund_log"><RefundLogPage /></GuardedRoute>} />
          <Route path="/payments" element={<Navigate to="/income-expense" replace />} />
          <Route path="/payments/income-expenses" element={<Navigate to="/income-expense" replace />} />
          <Route path="/payments/income-expense" element={<Navigate to="/income-expense" replace />} />

          {/* === CÔNG VIỆC === */}
          <Route path="/tasks" element={<GuardedRoute resource="tasks"><TaskManagementPage /></GuardedRoute>} />

          {/* === BÁO CÁO BĐS === */}
          <Route path="/reports/real-estate" element={<GuardedRoute resource="reports_real_estate"><RealEstateReportsPage /></GuardedRoute>} />
          <Route path="/reports/real-estate/vacant-rooms" element={<GuardedRoute resource="reports_real_estate"><VacantRoomsReport /></GuardedRoute>} />
          <Route path="/reports/real-estate/vacant" element={<GuardedRoute resource="reports_real_estate"><VacantRoomsReport /></GuardedRoute>} />
          <Route path="/reports/real-estate/expiring-contracts" element={<GuardedRoute resource="reports_real_estate"><ExpiringContractsReport /></GuardedRoute>} />
          <Route path="/reports/real-estate/expiring" element={<GuardedRoute resource="reports_real_estate"><ExpiringContractsReport /></GuardedRoute>} />
          <Route path="/reports/real-estate/renewals-transfers" element={<GuardedRoute resource="reports_real_estate"><RenewalsTransfersReport /></GuardedRoute>} />
          <Route path="/reports/real-estate/occupancy" element={<GuardedRoute resource="reports_real_estate"><OccupancyReport /></GuardedRoute>} />
          <Route path="/reports/real-estate/occupancy-new" element={<GuardedRoute resource="reports_real_estate"><OccupancyNewReport /></GuardedRoute>} />
          <Route path="/reports/real-estate/promotions" element={<GuardedRoute resource="reports_real_estate"><PromotionsReport /></GuardedRoute>} />
          <Route path="/reports/real-estate/new-leases" element={<GuardedRoute resource="reports_real_estate"><NewLeasesReport /></GuardedRoute>} />
          <Route path="/reports/real-estate/terminations" element={<GuardedRoute resource="reports_real_estate"><TerminationsReport /></GuardedRoute>} />
          <Route path="/reports/real-estate/expense-ratio" element={<GuardedRoute resource="reports_real_estate"><ExpenseRatioReport /></GuardedRoute>} />

          {/* === BÁO CÁO TÀI CHÍNH === */}
          {/* Resident-style URLs (canonical) */}
          <Route path="/report/finance/cashbook" element={<GuardedRoute resource="reports_finance"><DailyCashbookReport /></GuardedRoute>} />
          <Route path="/report/finance/cash-flow" element={<GuardedRoute resource="reports_finance"><CashFlowReport /></GuardedRoute>} />
          <Route path="/report/finance-by-month" element={<GuardedRoute resource="reports_finance"><ProfitDistributionReport /></GuardedRoute>} />
          <Route path="/report/finance/debt" element={<GuardedRoute resource="reports_finance"><CustomerDebtReport /></GuardedRoute>} />
          <Route path="/report/finance/billing-calendar" element={<GuardedRoute resource="reports_finance"><PaymentScheduleReport /></GuardedRoute>} />
          <Route path="/report/finance/prepaid" element={<GuardedRoute resource="reports_finance"><OverpaymentReport /></GuardedRoute>} />
          <Route path="/report/finance/deposit" element={<GuardedRoute resource="reports_finance"><DepositsReport /></GuardedRoute>} />
          {/* Legacy URLs (kept for backward compatibility, also serve as hub) */}
          <Route path="/reports/finance" element={<GuardedRoute resource="reports_finance"><FinanceReportsPage /></GuardedRoute>} />
          <Route path="/reports/finance/daily-cashbook" element={<GuardedRoute resource="reports_finance"><DailyCashbookReport /></GuardedRoute>} />
          <Route path="/reports/finance/cash-book" element={<GuardedRoute resource="reports_finance"><DailyCashbookReport /></GuardedRoute>} />
          <Route path="/reports/finance/cash-flow" element={<GuardedRoute resource="reports_finance"><CashFlowReport /></GuardedRoute>} />
          <Route path="/reports/finance/profit-distribution" element={<GuardedRoute resource="reports_finance"><ProfitDistributionReport /></GuardedRoute>} />
          <Route path="/reports/finance/new-contract-debt" element={<GuardedRoute resource="reports_finance"><DebtReport /></GuardedRoute>} />
          <Route path="/reports/finance/debt" element={<GuardedRoute resource="reports_finance"><DebtReport /></GuardedRoute>} />
          <Route path="/reports/finance/customer-debt" element={<GuardedRoute resource="reports_finance"><CustomerDebtReport /></GuardedRoute>} />
          <Route path="/reports/finance/payment-schedule" element={<GuardedRoute resource="reports_finance"><PaymentScheduleReport /></GuardedRoute>} />
          <Route path="/reports/finance/overpayment" element={<GuardedRoute resource="reports_finance"><OverpaymentReport /></GuardedRoute>} />
          <Route path="/reports/finance/deposits" element={<GuardedRoute resource="reports_finance"><DepositsReport /></GuardedRoute>} />

          {/* === BÁO CÁO CÔNG VIỆC === (đang xây dựng lại) */}

          {/* === CÀI ĐẶT HỆ THỐNG === */}
          <Route path="/settings/general" element={<GuardedRoute resource="settings"><GeneralSettingsPage /></GuardedRoute>} />
          <Route path="/general-setting" element={<Navigate to="/settings/general" replace />} />
          <Route path="/settings/categories" element={<GuardedRoute resource="categories"><CategoriesPage /></GuardedRoute>} />
          {/* Categories Sub-Pages - Tài chính */}
          <Route path="/settings/categories/bank-accounts" element={<GuardedRoute resource="categories"><BankAccountsPage /></GuardedRoute>} />
          <Route path="/settings/categories/auto-debt" element={<GuardedRoute resource="auto_debt"><AutoDebtPage /></GuardedRoute>} />
          {/* Loại thu chi: page chính ở /settings/income-expense-types.
              Hai URL còn lại (legacy + Resident-style) redirect về để tránh trùng. */}
          <Route path="/settings/categories/income-expense-types" element={<Navigate to="/settings/income-expense-types" replace />} />
          <Route path="/setting/finance/income-expense-types" element={<Navigate to="/settings/income-expense-types" replace />} />
          <Route path="/settings/categories/service-quotas" element={<GuardedRoute resource="service_quotas"><ServiceQuotasPage /></GuardedRoute>} />
          <Route path="/settings/categories/meters" element={<Navigate to="/settings/meters" replace />} />
          <Route path="/settings/meters" element={<GuardedRoute resource="meters"><MetersPage /></GuardedRoute>} />
          <Route path="/settings/income-expense-types" element={<GuardedRoute resource="categories"><IncomeExpenseTypesNewPage /></GuardedRoute>} />
          <Route path="/settings/income-expense-templates" element={<GuardedRoute resource="categories"><IncomeExpenseTemplatesPage /></GuardedRoute>} />
          {/* Cashbooks (Tài khoản): canonical URL is /finance/cashbooks under
              VẬN HÀNH → Tài chính (cùng nhóm với Thu chi). Legacy URLs aliased. */}
          <Route path="/finance/cashbooks" element={<GuardedRoute resource="cashbooks"><CashbooksPage /></GuardedRoute>} />
          <Route path="/setting/finance/cashbooks" element={<Navigate to="/finance/cashbooks" replace />} />
          <Route path="/settings/finance/cashbooks" element={<Navigate to="/finance/cashbooks" replace />} />
          <Route path="/cashbooks" element={<Navigate to="/finance/cashbooks" replace />} />
          {/* Categories Sub-Pages - Tài sản */}
          <Route path="/settings/categories/suppliers" element={<GuardedRoute resource="suppliers"><SuppliersPage /></GuardedRoute>} />
          <Route path="/settings/categories/warehouses" element={<GuardedRoute resource="warehouses"><WarehousesPage /></GuardedRoute>} />
          <Route path="/settings/categories/asset-types" element={<GuardedRoute resource="asset_types"><AssetTypesPage /></GuardedRoute>} />
          <Route path="/settings/categories/asset-movements" element={<GuardedRoute resource="assets" action="movement"><AssetMovementsPage /></GuardedRoute>} />
          <Route path="/settings/categories/asset-maintenance" element={<GuardedRoute resource="assets" action="maintenance"><AssetMaintenancePage /></GuardedRoute>} />
          {/* Categories Sub-Pages - Khác */}
          <Route path="/settings/categories/hotlines" element={<GuardedRoute resource="hotline"><HotlinesPage /></GuardedRoute>} />
          <Route path="/settings/categories/general" element={<GuardedRoute resource="categories"><GeneralCategoriesPage /></GuardedRoute>} />
          <Route path="/settings/categories/floors" element={<GuardedRoute resource="floors"><FloorsPage /></GuardedRoute>} />
          <Route path="/settings/categories/task-types" element={<GuardedRoute resource="task_types"><TaskTypesPage /></GuardedRoute>} />
          <Route path="/settings/templates" element={<GuardedRoute resource="templates"><TemplatesPage /></GuardedRoute>} />
          <Route path="/settings/signatures" element={<GuardedRoute resource="signatures"><SignaturesPage /></GuardedRoute>} />
          <Route path="/settings/staff" element={<GuardedRoute resource="users"><StaffPage /></GuardedRoute>} />

          {/* === TÀI KHOẢN === (mọi user đăng nhập đều có) */}
          <Route path="/account/profile" element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />
          <Route path="/account/subscription" element={<ProtectedRoute><SubscriptionPage /></ProtectedRoute>} />

          {/* === THÔNG TIN KHÁC === (mọi user đăng nhập đều có) */}
          <Route path="/faq" element={<ProtectedRoute><FaqPage /></ProtectedRoute>} />
          <Route path="/changelog" element={<ProtectedRoute><ChangelogPage /></ProtectedRoute>} />
          <Route path="/app-guide" element={<ProtectedRoute><AppGuidePage /></ProtectedRoute>} />

          {/* === REDIRECTS from old routes === */}
          <Route path="/cash-book" element={<Navigate to="/reports/finance/daily-cashbook" replace />} />

          {/* 404 Not Found - Catch all */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
      </ErrorBoundary>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
