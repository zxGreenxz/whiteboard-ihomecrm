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
import AdminUsersPage from "./pages/admin/UsersPage";

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
          <Route path="/beds" element={<ProtectedRoute><BedsPage /></ProtectedRoute>} />
          <Route path="/services" element={<ProtectedRoute><ServicesPage /></ProtectedRoute>} />
          <Route path="/assets" element={<ProtectedRoute><AssetsPage /></ProtectedRoute>} />

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

          {/* === BÁO CÁO CÔNG VIỆC === (đang xây dựng lại) */}

          {/* === ADMIN — QUẢN LÝ TÀI KHOẢN === */}
          <Route path="/admin/users" element={<ProtectedRoute><AdminUsersPage /></ProtectedRoute>} />

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
          <Route path="/settings/staff" element={<ProtectedRoute><StaffPage /></ProtectedRoute>} />

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
      </BrowserRouter>
      </ErrorBoundary>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
