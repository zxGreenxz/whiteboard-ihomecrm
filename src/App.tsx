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
import { RealtimeDataSync } from "@/hooks/useRealtimeDataSync";
import { NotificationsRealtime } from "@/hooks/useNotifications";
import { hideAppSplash } from "@/lib/appSplash";
import { AuthCacheSync } from "@/app/providers/AuthCacheSync";
import { NETWORK_CENTER_RUNTIME_ENABLED } from "@/lib/network-center/runtime";
import { OPENCLAW_RUNTIME_ENABLED } from "@/lib/openclaw-zalo/runtime";
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
import { settingsRoutes } from "./app/routes/settingsRoutes";
import { financeReportRoutes } from "./app/routes/financeReportRoutes";
import { realEstateReportRoutes } from "./app/routes/realEstateReportRoutes";
import { quickTrackRoutes } from "./app/routes/quickTrackRoutes";
import { catalogRoutes } from "./app/routes/catalogRoutes";
import { customerRoutes } from "./app/routes/customerRoutes";
import { financeWorkRoutes } from "./app/routes/financeWorkRoutes";
import { salaryProfitRoutes } from "./app/routes/salaryProfitRoutes";
import { adminAccountRoutes } from "./app/routes/adminAccountRoutes";

// Khai báo lazy cho 99 page đã tách sang ./app/lazyPages (Đợt 4) — xem lý do ở đó.
import {
  BuildingMapPage,
  NetworkCenterApp,
  CopilotLauncher,
  AiCopilotAdminPage,
  NotificationsPage,
  ChatZaloPage,
  OpenClawZaloPage,
  OpenClawRouteGuard,
  BuildingsPage,
  BuildingDetailPage,
  RoomsPage,
  RoomDetailPage,
  ServicesPage,
  SalePhongPage,
  LeadsPage,
  DepositsPage,
  ContractsPage,
  ContractDetailPage,
  VehiclesPage,
  CustomersPage,
  CustomerFormPage,
  CustomerDetailPage,
  CT01FormPage,
  MeterReadingsPage,
  InvoicesPage,
  InvoiceDetailPage,
  InvoicePrintPage,
  IncomeExpensePage,
  IncomeExpensePrintPage,
  VoucherDetailPage,
  RefundLogPage,
  ApprovalsPage,
  AssetsPage,
  MaterialsPage,
  RealEstateReportsPage,
  FinanceReportsPage,
  VacantRoomsReport,
  ExpiringContractsReport,
  OccupancyReport,
  RenewalsTransfersReport,
  PromotionsReport,
  NewLeasesReport,
  TerminationsReport,
  ExpenseRatioReport,
  DailyCashbookReport,
  CashFlowReport,
  CashbookClosureRecord,
  PaymentScheduleReport,
  OverpaymentReport,
  DepositsReport,
  ProfitHubPage,
  BusinessPerformanceReportPage,
  FinancialAnalysisReport,
  BanGiaoReport,
  BanGiaoCycleReport,
  GeneralSettingsPage,
  CategoriesPage,
  TemplatesPage,
  SignaturesPage,
  OrganizationPage,
  MembersPage,
  RolesPage,
  AcceptInvitation,
  AdminUsersPage,
  BankAccountsPage,
  AutoDebtPage,
  ServiceQuotasPage,
  MetersPage,
  IncomeExpenseTypesNewPage,
  IncomeExpenseTemplatesPage,
  CashbooksPage,
  FixedFeesPage,
  PersonalWalletPage,
  ManagerSalaryPage,
  MySalaryPage,
  SuppliersPage,
  WarehousesPage,
  AssetTypesPage,
  AssetMovementsPage,
  AssetMaintenancePage,
  HotlinesPage,
  GeneralCategoriesPage,
  FloorsPage,
  TaskTypesPage,
  TaskManagementPage,
  MyDayPage,
  OwnerDashboardV5,
  ProfilePage,
  SubscriptionPage,
  PublicContractInvoicePage,
  FaqPage,
  ChangelogPage,
  AppGuidePage,
  PhongTrongPage,
  QuaySoPage,
  QuaySoScreenPage,
  LuckyDrawAdminPage,
  ThuTien,
  ThanhToan,
} from "./app/lazyPages";

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
const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <ErrorBoundary>
        <Toaster />
        <Sonner />
        {/* Listener auth giữ cache ['auth','user'] / ['auth','session'] tươi.
            Trước đây đăng ký ở module scope ngay trong file này và vứt luôn
            subscription; xem AuthCacheSync để biết vì sao phải có cleanup. */}
        <AuthCacheSync />
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

          {quickTrackRoutes}
          {/* === KÊNH CHAT === */}
          <Route path="/chat-zalo" element={<ProtectedRoute><RequirePermission module="chat_zalo" action="view"><ChatZaloPage /></RequirePermission></ProtectedRoute>} />
          {/* Behind a build-time flag, default OFF, the same way Network Center is.
              `openclaw_zalo.view` is granted to every organization owner including
              the real one, so the server permission cannot also serve as the
              "not shipped yet" switch: it says who may use the feature, not
              whether the feature is finished. Tasks 26/28/29 are not done. */}
          {OPENCLAW_RUNTIME_ENABLED ? (
            <Route
              path="/openclaw-zalo"
              element={
                <ProtectedRoute>
                  <OpenClawRouteGuard>
                    <OpenClawZaloPage />
                  </OpenClawRouteGuard>
                </ProtectedRoute>
              }
            />
          ) : null}
          {catalogRoutes}
          {customerRoutes}
          {realEstateReportRoutes}
          {financeReportRoutes}
          {financeWorkRoutes}
          {salaryProfitRoutes}
          {settingsRoutes}
          {adminAccountRoutes}
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
