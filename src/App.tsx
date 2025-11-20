import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import ErrorBoundary from "@/components/ErrorBoundary";

// Auth Pages
import Register from "./pages/auth/Register";
import Login from "./pages/auth/Login";
import ForgotPassword from "./pages/auth/ForgotPassword";

// Main Pages
import Dashboard from "./pages/Dashboard";
import BuildingMapPage from "./pages/building-map/BuildingMapPage";
import NotFound from "./pages/NotFound";

// Master Data Pages
import AreasPage from "./pages/areas/AreasPage";
import BuildingsPage from "./pages/buildings/BuildingsPage";
import RoomsPage from "./pages/rooms/RoomsPage";
import BedsPage from "./pages/beds/BedsPage";
import ServicesPage from "./pages/services/ServicesPage";

// Customer Pages
import LeadsPage from "./pages/leads/LeadsPage";
import DepositsPage from "./pages/deposits/DepositsPage";
import ContractsPage from "./pages/contracts/ContractsPage";
import TenantsPage from "./pages/tenants/TenantsPage";
import VehiclesPage from "./pages/vehicles/VehiclesPage";

// Finance Pages
import MeterReadingsPage from "./pages/meter-readings/MeterReadingsPage";
import InvoicesPage from "./pages/invoices/InvoicesPage";
import InvoiceDetailPage from "./pages/invoices/InvoiceDetailPage";
import PaymentsPage from "./pages/payments/PaymentsPage";
import CashBookPage from "./pages/cash-book/CashBookPage";

// Assets & Issues Pages
import AssetsPage from "./pages/assets/AssetsPage";
import IssuesPage from "./pages/issues/IssuesPage";
import IssueDetailPage from "./pages/issues/IssueDetailPage";

// Reports Pages
import RealEstateReportsPage from "./pages/reports/RealEstateReportsPage";
import FinanceReportsPage from "./pages/reports/FinanceReportsPage";
import TasksReportsPage from "./pages/reports/TasksReportsPage";

// Real Estate Reports
import VacantRoomsReport from "./pages/reports/real-estate/VacantRoomsReport";
import ExpiringContractsReport from "./pages/reports/real-estate/ExpiringContractsReport";
import OccupancyReport from "./pages/reports/real-estate/OccupancyReport";
import PromotionsReport from "./pages/reports/real-estate/PromotionsReport";
import NewLeasesReport from "./pages/reports/real-estate/NewLeasesReport";
import TerminationsReport from "./pages/reports/real-estate/TerminationsReport";
import PriceHistoryReport from "./pages/reports/real-estate/PriceHistoryReport";
import ContractChangesReport from "./pages/reports/real-estate/ContractChangesReport";

// Finance Reports
import CashBookReport from "./pages/reports/finance/CashBookReport";
import CashFlowReport from "./pages/reports/finance/CashFlowReport";
import DebtReport from "./pages/reports/finance/DebtReport";
import CustomerDebtReport from "./pages/reports/finance/CustomerDebtReport";
import PaymentScheduleReport from "./pages/reports/finance/PaymentScheduleReport";
import OverpaymentReport from "./pages/reports/finance/OverpaymentReport";
import DepositsReport from "./pages/reports/finance/DepositsReport";
import ProfitDistributionReport from "./pages/reports/finance/ProfitDistributionReport";

// Task Reports
import TasksOverviewReport from "./pages/reports/tasks/TasksOverviewReport";
import TasksByStaffReport from "./pages/reports/tasks/TasksByStaffReport";
import TasksByRoomReport from "./pages/reports/tasks/TasksByRoomReport";

// Settings Pages
import GeneralSettingsPage from "./pages/settings/GeneralSettingsPage";
import TemplatesPage from "./pages/settings/TemplatesPage";
import SignaturesPage from "./pages/settings/SignaturesPage";
import StaffPage from "./pages/settings/StaffPage";

// Route Guards
import ProtectedRoute from "./components/auth/ProtectedRoute";
import PublicRoute from "./components/auth/PublicRoute";

const queryClient = new QueryClient();

const App = () => (
  <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
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

          {/* ========================================
              PROTECTED ROUTES - Require authentication
              ======================================== */}

          {/* Dashboard */}
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Dashboard />
              </ProtectedRoute>
            }
          />
          <Route path="/building-map" element={<ProtectedRoute><BuildingMapPage /></ProtectedRoute>} />

          {/* Master Data Routes */}
          <Route path="/areas" element={<ProtectedRoute><AreasPage /></ProtectedRoute>} />
          <Route path="/buildings" element={<ProtectedRoute><BuildingsPage /></ProtectedRoute>} />
          <Route path="/rooms" element={<ProtectedRoute><RoomsPage /></ProtectedRoute>} />
          <Route path="/beds" element={<ProtectedRoute><BedsPage /></ProtectedRoute>} />
          <Route path="/services" element={<ProtectedRoute><ServicesPage /></ProtectedRoute>} />

          {/* Customer Routes */}
          <Route path="/leads" element={<ProtectedRoute><LeadsPage /></ProtectedRoute>} />
          <Route path="/deposits" element={<ProtectedRoute><DepositsPage /></ProtectedRoute>} />
          <Route path="/contracts" element={<ProtectedRoute><ContractsPage /></ProtectedRoute>} />
          <Route path="/tenants" element={<ProtectedRoute><TenantsPage /></ProtectedRoute>} />
          <Route path="/vehicles" element={<ProtectedRoute><VehiclesPage /></ProtectedRoute>} />

          {/* Finance Routes */}
          <Route path="/meter-readings" element={<ProtectedRoute><MeterReadingsPage /></ProtectedRoute>} />
          <Route path="/invoices" element={<ProtectedRoute><InvoicesPage /></ProtectedRoute>} />
          <Route path="/invoices/:id" element={<ProtectedRoute><InvoiceDetailPage /></ProtectedRoute>} />
          <Route path="/payments" element={<ProtectedRoute><PaymentsPage /></ProtectedRoute>} />
          <Route path="/cash-book" element={<ProtectedRoute><CashBookPage /></ProtectedRoute>} />

          {/* Assets & Issues Routes */}
          <Route path="/assets" element={<ProtectedRoute><AssetsPage /></ProtectedRoute>} />
          <Route path="/issues" element={<ProtectedRoute><IssuesPage /></ProtectedRoute>} />
          <Route path="/issues/:id" element={<ProtectedRoute><IssueDetailPage /></ProtectedRoute>} />

          {/* Reports Routes */}
          <Route path="/reports/real-estate" element={<ProtectedRoute><RealEstateReportsPage /></ProtectedRoute>} />
          <Route path="/reports/real-estate/vacant-rooms" element={<ProtectedRoute><VacantRoomsReport /></ProtectedRoute>} />
          <Route path="/reports/real-estate/expiring-contracts" element={<ProtectedRoute><ExpiringContractsReport /></ProtectedRoute>} />
          <Route path="/reports/real-estate/occupancy" element={<ProtectedRoute><OccupancyReport /></ProtectedRoute>} />
          <Route path="/reports/real-estate/promotions" element={<ProtectedRoute><PromotionsReport /></ProtectedRoute>} />
          <Route path="/reports/real-estate/new-leases" element={<ProtectedRoute><NewLeasesReport /></ProtectedRoute>} />
          <Route path="/reports/real-estate/terminations" element={<ProtectedRoute><TerminationsReport /></ProtectedRoute>} />
          <Route path="/reports/real-estate/price-history" element={<ProtectedRoute><PriceHistoryReport /></ProtectedRoute>} />
          <Route path="/reports/real-estate/contract-changes" element={<ProtectedRoute><ContractChangesReport /></ProtectedRoute>} />

          <Route path="/reports/finance" element={<ProtectedRoute><FinanceReportsPage /></ProtectedRoute>} />
          <Route path="/reports/finance/cash-book" element={<ProtectedRoute><CashBookReport /></ProtectedRoute>} />
          <Route path="/reports/finance/cash-flow" element={<ProtectedRoute><CashFlowReport /></ProtectedRoute>} />
          <Route path="/reports/finance/debt" element={<ProtectedRoute><DebtReport /></ProtectedRoute>} />
          <Route path="/reports/finance/customer-debt" element={<ProtectedRoute><CustomerDebtReport /></ProtectedRoute>} />
          <Route path="/reports/finance/payment-schedule" element={<ProtectedRoute><PaymentScheduleReport /></ProtectedRoute>} />
          <Route path="/reports/finance/overpayment" element={<ProtectedRoute><OverpaymentReport /></ProtectedRoute>} />
          <Route path="/reports/finance/deposits" element={<ProtectedRoute><DepositsReport /></ProtectedRoute>} />
          <Route path="/reports/finance/profit-distribution" element={<ProtectedRoute><ProfitDistributionReport /></ProtectedRoute>} />

          <Route path="/reports/tasks" element={<ProtectedRoute><TasksReportsPage /></ProtectedRoute>} />
          <Route path="/reports/tasks/overview" element={<ProtectedRoute><TasksOverviewReport /></ProtectedRoute>} />
          <Route path="/reports/tasks/by-staff" element={<ProtectedRoute><TasksByStaffReport /></ProtectedRoute>} />
          <Route path="/reports/tasks/by-room" element={<ProtectedRoute><TasksByRoomReport /></ProtectedRoute>} />

          {/* Settings Routes */}
          <Route path="/settings/general" element={<ProtectedRoute><GeneralSettingsPage /></ProtectedRoute>} />
          <Route path="/settings/templates" element={<ProtectedRoute><TemplatesPage /></ProtectedRoute>} />
          <Route path="/settings/signatures" element={<ProtectedRoute><SignaturesPage /></ProtectedRoute>} />
          <Route path="/settings/staff" element={<ProtectedRoute><StaffPage /></ProtectedRoute>} />

          {/* 404 Not Found - Catch all */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
  </ErrorBoundary>
);

export default App;
