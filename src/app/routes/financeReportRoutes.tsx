// Nhóm route: Báo cáo tài chính. Tách khỏi App.tsx (Đợt 4).
//
// Xuất ra một Fragment chứa các <Route>. react-router 6 đệ quy vào Fragment khi
// dựng bảng route, nên cụm này cắm thẳng vào <Routes> mà KHÔNG cần thêm key cho
// từng route — tức JSX giữ nguyên từng ký tự so với bản trong App.tsx.
//
// Gate scripts/check-route-guards.mjs quét cả thư mục này, nên guard của các
// route ở đây vẫn được kiểm như khi chúng còn nằm trong App.tsx.
import { Route, Navigate } from "react-router-dom";
import {
  BanGiaoCycleReport,
  BanGiaoReport,
  BusinessPerformanceReportPage,
  CashFlowReport,
  DailyCashbookReport,
  DepositsReport,
  FinanceReportsPage,
  FinancialAnalysisReport,
  OverpaymentReport,
  PaymentScheduleReport,
  ProfitHubPage,
} from "../lazyPages";
import ProtectedRoute from "../../components/auth/ProtectedRoute";
import { RequirePermission } from "../../components/auth/RequirePermission";

export const financeReportRoutes = (
  <>
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

  </>
);
