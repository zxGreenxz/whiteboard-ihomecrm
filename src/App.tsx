import { Suspense, useEffect, useLayoutEffect, useState } from "react";
// lazyWithRetry: thử lại import() page khi mạng chập chờn (tab idle → wifi ngủ →
// request chunk đầu fail) trước khi để lỗi rơi xuống ErrorBoundary. Alias thành
// `lazy` để mọi call site route bên dưới giữ nguyên.
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useParams } from "react-router-dom";
import ErrorBoundary from "./components/errors/ErrorBoundary";
import { supabase } from "@/integrations/supabase/client";
import { RealtimeDataSync } from "@/hooks/useRealtimeDataSync";
import { NotificationsRealtime } from "@/hooks/useNotifications";
import { hideAppSplash } from "@/lib/appSplash";
import { syncAuthQueryCache } from "@/lib/authQueryCache";
import { NETWORK_CENTER_RUNTIME_ENABLED } from "@/lib/network-center/runtime";
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
import HomeRoute from "./pages/home/HomeRoute";
import DashboardRoute from "./pages/home/DashboardRoute";
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
const NetworkCenterApp = lazy(() => import("./pages/network-center/NetworkCenterApp"));
// AI Copilot — nút nổi + panel chat (gate session/entitlement/quyền bên trong)
const CopilotLauncher = lazy(() => import("./copilot/CopilotLauncher"));
// AI Copilot — trang quản trị (super admin: full; user thường: tab Sử dụng)
const AiCopilotAdminPage = lazy(() => import("./copilot/admin/AiCopilotAdminPage"));
const NotificationsPage = lazy(() => import("./pages/NotificationsPage"));
const ChatZaloPage = lazy(() => import("./pages/chat-zalo/ChatZaloPage"));

// Danh mục dữ liệu
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
const VoucherDetailPage = lazy(() => import("./pages/payments/VoucherDetailPage"));
const RefundLogPage = lazy(() => import("./pages/payments/RefundLogPage"));
const ApprovalsPage = lazy(() => import("./pages/approvals/ApprovalsPage"));

// Tài sản & vật tư
const AssetsPage = lazy(() => import("./pages/assets/AssetsPage"));
const MaterialsPage = lazy(() => import("./pages/materials/MaterialsPage"));

// Báo cáo
const RealEstateReportsPage = lazy(() => import("./pages/reports/RealEstateReportsPage"));
const FinanceReportsPage = lazy(() => import("./pages/reports/FinanceReportsPage"));
const VacantRoomsReport = lazy(() => import("./pages/reports/real-estate/VacantRoomsReport"));
const ExpiringContractsReport = lazy(() => import("./pages/reports/real-estate/ExpiringContractsReport"));
const OccupancyReport = lazy(() => import("./pages/reports/real-estate/OccupancyReport"));
const RenewalsTransfersReport = lazy(() => import("./pages/reports/real-estate/RenewalsTransfersReport"));
const PromotionsReport = lazy(() => import("./pages/reports/real-estate/PromotionsReport"));
const NewLeasesReport = lazy(() => import("./pages/reports/real-estate/NewLeasesReport"));
const TerminationsReport = lazy(() => import("./pages/reports/real-estate/TerminationsReport"));
const ExpenseRatioReport = lazy(() => import("./pages/reports/real-estate/ExpenseRatioReport"));
const DailyCashbookReport = lazy(() => import("./pages/reports/finance/DailyCashbookReport"));
const CashFlowReport = lazy(() => import("./pages/reports/finance/CashFlowReport"));
const CashbookClosureRecord = lazy(() => import("./pages/reports/finance/CashbookClosureRecord"));
const PaymentScheduleReport = lazy(() => import("./pages/reports/finance/PaymentScheduleReport"));
const OverpaymentReport = lazy(() => import("./pages/reports/finance/OverpaymentReport"));
const DepositsReport = lazy(() => import("./pages/reports/finance/DepositsReport"));
const ProfitHubPage = lazy(() => import("./pages/reports/finance/ProfitHubPage"));
const BusinessPerformanceReportPage = lazy(() => import("./pages/reports/finance/BusinessPerformanceReportPage"));
const FinancialAnalysisReport = lazy(() => import("./pages/reports/finance/FinancialAnalysisReport"));
const BanGiaoReport = lazy(() => import("./pages/reports/finance/BanGiaoReport"));
const BanGiaoCycleReport = lazy(() => import("./pages/reports/finance/BanGiaoCycleReport"));

// Cài đặt
const GeneralSettingsPage = lazy(() => import("./pages/settings/GeneralSettingsPage"));
const CategoriesPage = lazy(() => import("./pages/settings/CategoriesPage"));
const TemplatesPage = lazy(() => import("./pages/settings/TemplatesPage"));
const SignaturesPage = lazy(() => import("./pages/settings/SignaturesPage"));
const OrganizationPage = lazy(() => import("./pages/settings/OrganizationPage"));
const MembersPage = lazy(() => import("./pages/settings/MembersPage"));
const RolesPage = lazy(() => import("./pages/settings/RolesPage"));
const AcceptInvitation = lazy(() => import("./pages/auth/AcceptInvitation"));
const AdminUsersPage = lazy(() => import("./pages/admin/UsersPage"));
const BankAccountsPage = lazy(() => import("./pages/settings/categories/BankAccountsPage"));
const AutoDebtPage = lazy(() => import("./pages/settings/categories/AutoDebtPage"));
const ServiceQuotasPage = lazy(() => import("./pages/settings/categories/ServiceQuotasPage"));
const MetersPage = lazy(() => import("./pages/settings/MetersPage"));
const IncomeExpenseTypesNewPage = lazy(() => import("./pages/settings/IncomeExpenseTypesPage"));
const IncomeExpenseTemplatesPage = lazy(() => import("./pages/settings/IncomeExpenseTemplatesPage"));
const CashbooksPage = lazy(() => import("./pages/settings/finance/CashbooksPage"));
const FixedFeesPage = lazy(() => import("./pages/settings/finance/FixedFeesPage"));
const PersonalWalletPage = lazy(() => import("./pages/finance/PersonalWalletPage"));
const ManagerSalaryPage = lazy(() => import("./pages/finance/ManagerSalaryPage"));
const MySalaryPage = lazy(() => import("./pages/finance/MySalaryPage"));
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
const MyDayPage = lazy(() => import("./pages/my-day/MyDayPage"));
const OwnerDashboardV5 = lazy(() => import("./pages/reports/OwnerDashboardV5"));

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

// Sự kiện trao thưởng + vòng xoay may mắn. Trang công khai /quayso có bộ style
// riêng (quayso.css scope dưới .qs-page) nên lazy để không rò sang CRM; trang
// quản trị /quayso/admin nằm trong app đã đăng nhập.
const QuaySoPage = lazy(() => import("./pages/quayso/QuaySoPage"));
const QuaySoScreenPage = lazy(() => import("./pages/quayso/QuaySoScreenPage"));
const LuckyDrawAdminPage = lazy(() => import("./pages/quayso/LuckyDrawAdminPage"));

// Trang "Thu tiền" (mobile, đi thu tiền mặt) — page phụ độc lập có bộ style
// riêng (thu-tien.css scope dưới .tt-page). Lazy để CSS + font Be Vietnam Pro /
// Space Mono chỉ nạp khi mở /thu-tien, không kế thừa/đụng theme site.
const ThuTien = lazy(() => import("./pages/ThuTien"));

// Trang "Thanh toán" (Đóng tiền Tập trung theo Kỳ) — tách khỏi overlay của
// /thu-tien. Dùng CHUNG thu-tien.css nên cũng cần Suspense cục bộ như trên.
const ThanhToan = lazy(() => import("./pages/ThanhToan"));

// Fallback khi đang tải chunk của route lazy
const RouteFallback = () => (
  <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
    Đang tải…
  </div>
);

const RouteTreeCommit = () => {
  useLayoutEffect(() => hideAppSplash(), []);
  return null;
};

const DeferredCopilotLauncher = () => {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const idleWindow = window as unknown as {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (idleWindow.requestIdleCallback) {
      const id = idleWindow.requestIdleCallback(() => setReady(true), { timeout: 1_500 });
      return () => idleWindow.cancelIdleCallback?.(id);
    }

    const id = window.setTimeout(() => setReady(true), 700);
    return () => window.clearTimeout(id);
  }, []);

  if (!ready) return null;
  return (
    <Suspense fallback={null}>
      <CopilotLauncher />
    </Suspense>
  );
};

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
// Listener auth DUY NHẤT giữ cache ['auth','user'] / ['auth','session'] tươi
// (INITIAL_SESSION khi boot, SIGNED_IN, TOKEN_REFRESHED, SIGNED_OUT, cross-tab)
// → useAuth/useSession dùng staleTime: Infinity, không round-trip mạng.
// CẢNH BÁO: chỉ được code SYNC trong callback này — `await supabase.*` ở đây
// gây deadlock (supabase-js giữ lock nội bộ khi dispatch sự kiện auth).
supabase.auth.onAuthStateChange((event, session) => {
  syncAuthQueryCache(queryClient, event, session);
});

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <ErrorBoundary>
        <Toaster />
        <Sonner />
        {/* Hub realtime nghiệp vụ: invalidate + hâm cache prefetch khi
            invoices/income_expenses/contracts/jobs/customers đổi. */}
        <RealtimeDataSync />
        {/* Kênh realtime RIÊNG cho hộp thư: hub trên không khai được filter nên mỗi thông báo
            của một người sẽ đánh thức tất cả. Kênh này lọc user_id=eq.<uid> ngay ở server. */}
        <NotificationsRealtime />
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

          {/* Link công khai có thương hiệu: chillhome.io.vn/phongtrong → cùng trang
              Phòng trống (token "demo"). Giữ nguyên /r/:token cho link cũ. */}
          <Route
            path="/phongtrong"
            element={
              <Suspense fallback={null}>
                <PhongTrongPage token="demo" />
              </Suspense>
            }
          />

          {/* Sự kiện quay số may mắn — trang CÔNG KHAI cho sale (không đăng
              nhập). Định danh bằng mã 6 số web cấp cho từng đội.
              Link đẹp: /quayso/<slug> (vd /quayso/deal). Link cũ /quayso?e=<uuid>
              giữ nguyên cho ai đã lỡ phát ra. */}
          <Route
            path="/quayso"
            element={
              <Suspense fallback={null}>
                <QuaySoPage />
              </Suspense>
            }
          />
          {/* Đặt SAU /quayso/admin trong bảng route cũng được — React Router xếp
              hạng đoạn tĩnh cao hơn đoạn động, nên "admin" không rơi vào đây.
              Slug 'admin' cũng đã bị CHECK constraint chặn ở DB. */}
          <Route
            path="/quayso/:slug"
            element={
              <Suspense fallback={null}>
                <QuaySoPage />
              </Suspense>
            }
          />
          {/* Màn quay riêng để chủ sự kiện ghi hình gửi group: chỉ bánh xe +
              nút quay, vừa khít một màn hình điện thoại dọc. Cũng KHÔNG cần
              đăng nhập. */}
          <Route
            path="/quayso/:slug/quay"
            element={
              <Suspense fallback={null}>
                <QuaySoScreenPage />
              </Suspense>
            }
          />

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

          {/* === KÊNH CHAT === */}
          <Route path="/chat-zalo" element={<ProtectedRoute><RequirePermission module="chat_zalo" action="view"><ChatZaloPage /></RequirePermission></ProtectedRoute>} />

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

          {/* === TÀI CHÍNH === */}
          <Route path="/meter-readings" element={<ProtectedRoute><RequirePermission module="meter_readings"><MeterReadingsPage /></RequirePermission></ProtectedRoute>} />
          <Route path="/thu-tien" element={<ProtectedRoute><RequirePermission module="thu_tien"><Suspense fallback={null}><ThuTien /></Suspense></RequirePermission></ProtectedRoute>} />
          {/* Gate `thu_tien.collect` (không phải `view`) — giữ NGUYÊN tầm với cũ:
              trước đây panel này chỉ mở được qua nút Plug vốn đã ẩn với người
              không có quyền thu. Dùng `view` sẽ mở rộng ai thấy được số liệu chi. */}
          <Route path="/thanh-toan" element={<ProtectedRoute><RequirePermission module="thu_tien" action="collect"><Suspense fallback={null}><ThanhToan /></Suspense></RequirePermission></ProtectedRoute>} />
          <Route path="/invoices" element={<ProtectedRoute><RequirePermission module="invoices"><InvoicesPage /></RequirePermission></ProtectedRoute>} />
          <Route path="/invoices/print/:id" element={<ProtectedRoute><RequirePermission module="invoices" action="print"><InvoicePrintPage /></RequirePermission></ProtectedRoute>} />
          <Route path="/invoices/:id" element={<ProtectedRoute><RequirePermission module="invoices"><InvoiceDetailPage /></RequirePermission></ProtectedRoute>} />
          {/* Primary route: /income-expense, redirect /payments → /income-expense */}
          <Route path="/income-expense" element={<ProtectedRoute><RequirePermission module="income_expenses"><IncomeExpensePage /></RequirePermission></ProtectedRoute>} />
          <Route path="/income-expense/print/:id" element={<ProtectedRoute><RequirePermission module="income_expenses" action="print"><IncomeExpensePrintPage /></RequirePermission></ProtectedRoute>} />
          <Route path="/income-expense/voucher/:id" element={<ProtectedRoute><RequirePermission module="income_expenses"><VoucherDetailPage /></RequirePermission></ProtectedRoute>} />
          <Route path="/finance/refund-log" element={<ProtectedRoute><RequirePermission module="deposits"><RefundLogPage /></RequirePermission></ProtectedRoute>} />
          {/* Hộp thư duyệt: KHÔNG gate RequirePermission — RPC đã lọc theo auth.uid(),
              ai vào cũng chỉ thấy yêu cầu chờ chính mình duyệt (rỗng nếu không phải người duyệt). */}
          <Route path="/approvals" element={<ProtectedRoute><ApprovalsPage /></ProtectedRoute>} />
          <Route path="/payments" element={<Navigate to="/income-expense" replace />} />
          <Route path="/payments/income-expenses" element={<Navigate to="/income-expense" replace />} />
          <Route path="/payments/income-expense" element={<Navigate to="/income-expense" replace />} />

          {/* === CÔNG VIỆC === */}
          <Route path="/tasks" element={<ProtectedRoute><RequirePermission module="tasks"><TaskManagementPage /></RequirePermission></ProtectedRoute>} />
          <Route path="/my-day" element={<ProtectedRoute><MyDayPage /></ProtectedRoute>} />
          <Route path="/reports/coverage" element={<ProtectedRoute><AdminOnlyRoute><OwnerDashboardV5 /></AdminOnlyRoute></ProtectedRoute>} />

          {/* === BÁO CÁO BĐS === */}
          <Route path="/reports/real-estate" element={<ProtectedRoute><RequirePermission module="reports_real_estate"><RealEstateReportsPage /></RequirePermission></ProtectedRoute>} />
          <Route path="/reports/real-estate/vacant-rooms" element={<ProtectedRoute><RequirePermission module="reports_real_estate" action="vacant_rooms"><VacantRoomsReport /></RequirePermission></ProtectedRoute>} />
          <Route path="/reports/real-estate/vacant" element={<ProtectedRoute><RequirePermission module="reports_real_estate" action="vacant_rooms"><VacantRoomsReport /></RequirePermission></ProtectedRoute>} />
          <Route path="/reports/real-estate/expiring-contracts" element={<ProtectedRoute><RequirePermission module="reports_real_estate" action="expiring"><ExpiringContractsReport /></RequirePermission></ProtectedRoute>} />
          <Route path="/reports/real-estate/expiring" element={<ProtectedRoute><RequirePermission module="reports_real_estate" action="expiring"><ExpiringContractsReport /></RequirePermission></ProtectedRoute>} />
          <Route path="/reports/real-estate/renewals-transfers" element={<ProtectedRoute><RequirePermission module="reports_real_estate" action="renewals_transfers"><RenewalsTransfersReport /></RequirePermission></ProtectedRoute>} />
          <Route path="/reports/real-estate/occupancy" element={<ProtectedRoute><RequirePermission module="reports_real_estate" action="occupancy"><OccupancyReport /></RequirePermission></ProtectedRoute>} />
          <Route path="/reports/real-estate/occupancy-new" element={<Navigate to="/reports/real-estate/occupancy" replace />} />
          <Route path="/reports/real-estate/promotions" element={<ProtectedRoute><RequirePermission module="reports_real_estate" action="promotions"><PromotionsReport /></RequirePermission></ProtectedRoute>} />
          <Route path="/reports/real-estate/new-leases" element={<ProtectedRoute><RequirePermission module="reports_real_estate" action="new_leases"><NewLeasesReport /></RequirePermission></ProtectedRoute>} />
          <Route path="/reports/real-estate/terminations" element={<ProtectedRoute><RequirePermission module="reports_real_estate" action="terminations"><TerminationsReport /></RequirePermission></ProtectedRoute>} />
          <Route path="/reports/real-estate/expense-ratio" element={<ProtectedRoute><RequirePermission module="reports_real_estate" action="expense_ratio"><ExpenseRatioReport /></RequirePermission></ProtectedRoute>} />

          {/* === BÁO CÁO TÀI CHÍNH === */}
          {/* Canonical: /reports/finance/*. Nhóm /report/finance/* (số ít, resident-style
              cũ) chỉ còn là redirect giữ bookmark — không render component riêng. */}
          <Route path="/report/finance/analysis" element={<Navigate to="/reports/finance/analysis" replace />} />
          <Route path="/report/finance/cashbook" element={<Navigate to="/reports/finance/daily-cashbook" replace />} />
          <Route path="/report/finance/cash-flow" element={<Navigate to="/reports/finance/cash-flow" replace />} />
          <Route path="/report/finance-by-month" element={<Navigate to="/reports/finance/profit-distribution" replace />} />
          {/* 2 BC công nợ đã bỏ (Phase 7) — nghiệp vụ nợ xử lý ở màn Thu tiền */}
          <Route path="/report/finance/debt" element={<Navigate to="/thu-tien" replace />} />
          <Route path="/report/finance/billing-calendar" element={<Navigate to="/reports/finance/payment-schedule" replace />} />
          <Route path="/report/finance/prepaid" element={<Navigate to="/reports/finance/overpayment" replace />} />
          <Route path="/report/finance/deposit" element={<Navigate to="/reports/finance/deposits" replace />} />
          <Route path="/reports/finance" element={<ProtectedRoute><RequirePermission module="reports_finance"><FinanceReportsPage /></RequirePermission></ProtectedRoute>} />
          <Route path="/reports/finance/daily-cashbook" element={<ProtectedRoute><RequirePermission module="reports_finance" action="daily_cashbook"><DailyCashbookReport /></RequirePermission></ProtectedRoute>} />
          <Route path="/reports/finance/cash-book" element={<ProtectedRoute><RequirePermission module="reports_finance" action="daily_cashbook"><DailyCashbookReport /></RequirePermission></ProtectedRoute>} />
          <Route path="/reports/finance/cash-flow" element={<ProtectedRoute><RequirePermission module="reports_finance" action="cash_flow"><CashFlowReport /></RequirePermission></ProtectedRoute>} />
          {/* Trang gộp: Phân bổ lợi nhuận (báo cáo) + Chia lợi nhuận cổ đông — tab theo quyền, gate bên trong */}
          <Route path="/reports/finance/profit-distribution" element={<ProtectedRoute><ProfitHubPage /></ProtectedRoute>} />
          {/* 2 BC công nợ đã bỏ (Phase 7) — nghiệp vụ nợ xử lý ở màn Thu tiền */}
          <Route path="/reports/finance/new-contract-debt" element={<Navigate to="/thu-tien" replace />} />
          <Route path="/reports/finance/debt" element={<Navigate to="/thu-tien" replace />} />
          <Route path="/reports/finance/customer-debt" element={<Navigate to="/thu-tien" replace />} />
          <Route path="/reports/finance/payment-schedule" element={<ProtectedRoute><RequirePermission module="reports_finance" action="payment_schedule"><PaymentScheduleReport /></RequirePermission></ProtectedRoute>} />
          <Route path="/reports/finance/overpayment" element={<ProtectedRoute><RequirePermission module="reports_finance" action="overpayment"><OverpaymentReport /></RequirePermission></ProtectedRoute>} />
          <Route path="/reports/finance/deposits" element={<ProtectedRoute><RequirePermission module="reports_finance" action="deposits_report"><DepositsReport /></RequirePermission></ProtectedRoute>} />
          <Route path="/reports/finance/business-performance" element={<ProtectedRoute><BusinessPerformanceReportPage /></ProtectedRoute>} />
          <Route path="/reports/finance/analysis" element={<ProtectedRoute><RequirePermission module="reports_finance" action="analysis"><FinancialAnalysisReport /></RequirePermission></ProtectedRoute>} />
          <Route path="/reports/finance/ban-giao" element={<ProtectedRoute><RequirePermission module="reports_finance" action="handover_report"><BanGiaoReport /></RequirePermission></ProtectedRoute>} />
          <Route path="/reports/finance/thu-ban-giao" element={<ProtectedRoute><RequirePermission module="reports_finance" action="collection_cycle"><BanGiaoCycleReport /></RequirePermission></ProtectedRoute>} />

          {/* === CHIA LỢI NHUẬN CỔ ĐÔNG + VÍ THU CHI CÁ NHÂN === */}
          {/* Đã gộp vào trang Phân bổ lợi nhuận → redirect các URL cũ */}
          <Route path="/finance/shareholder-profit" element={<Navigate to="/reports/finance/profit-distribution" replace />} />
          <Route path="/reports/finance/shareholder-profit" element={<Navigate to="/reports/finance/profit-distribution" replace />} />
          <Route path="/finance/personal-wallet" element={<ProtectedRoute><RequirePermission module="personal_finance" action="view"><PersonalWalletPage /></RequirePermission></ProtectedRoute>} />

          {/* === BẢNG LƯƠNG QUẢN LÝ === (trang tự rẽ admin ↔ self-view theo quyền/cấu hình) */}
          <Route path="/finance/salary" element={<ProtectedRoute><ManagerSalaryPage /></ProtectedRoute>} />
          {/* "Lương của tôi" — trang trọn-màn QUEST, nhân viên mở ở TAB MỚI từ sidebar */}
          <Route path="/finance/my-salary" element={<ProtectedRoute><MySalaryPage /></ProtectedRoute>} />

          {/* === BÁO CÁO CÔNG VIỆC === (đang xây dựng lại) */}

          {/* === ADMIN — QUẢN LÝ TÀI KHOẢN === */}
          <Route path="/admin/users" element={<ProtectedRoute><AdminOnlyRoute><AdminUsersPage /></AdminOnlyRoute></ProtectedRoute>} />

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

          {/* === REDIRECTS from old routes === */}
          <Route path="/cash-book" element={<Navigate to="/reports/finance/daily-cashbook" replace />} />

          {/* 404 Not Found - Catch all */}
          <Route path="*" element={<NotFound />} />
        </Routes>
        <RouteTreeCommit />
        </Suspense>
        {/* AI Copilot: nút nổi toàn app — tự ẩn trên route public / khi không
            có session / không entitlement / không quyền ai_copilot.view */}
        <DeferredCopilotLauncher />
      </BrowserRouter>
      </ErrorBoundary>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
