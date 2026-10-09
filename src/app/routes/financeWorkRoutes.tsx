// Nhóm route: Tài chính + công việc. Tách khỏi App.tsx (Đợt 4).
//
// Xuất ra một Fragment chứa các <Route>. react-router 6 đệ quy vào Fragment khi
// dựng bảng route, nên cụm này cắm thẳng vào <Routes> mà KHÔNG cần thêm key cho
// từng route — tức JSX giữ nguyên từng ký tự so với bản trong App.tsx.
//
// Gate scripts/check-route-guards.mjs quét cả thư mục này, nên guard của các
// route ở đây vẫn được kiểm như khi chúng còn nằm trong App.tsx.
import { Route, Navigate } from "react-router-dom";
import {
  ApprovalsPage,
  BankEventsPage,
  IncomeExpensePage,
  IncomeExpensePrintPage,
  InvoiceDetailPage,
  InvoicePrintPage,
  InvoicesPage,
  MeterReadingsPage,
  MyDayPage,
  PersonalTasksPage,
  OwnerDashboardV5,
  QuickEntryPage,
  RefundLogPage,
  TaskManagementPage,
  ThanhToan,
  ThuTien,
  VoucherDetailPage,
} from "../lazyPages";
import ProtectedRoute from "../../components/auth/ProtectedRoute";
import { RequirePermission } from "../../components/auth/RequirePermission";
import { RequireSuperAdmin } from "../../components/auth/RequireSuperAdmin";
import { Suspense, useEffect, useLayoutEffect, useState } from "react";
import { AdminOnlyRoute } from "../../components/auth/AdminOnlyRoute";

export const financeWorkRoutes = (
  <>
    {/* === TÀI CHÍNH === */}
    <Route path="/bien-dong-so-du" element={<ProtectedRoute><RequireSuperAdmin><BankEventsPage /></RequireSuperAdmin></ProtectedRoute>} />
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
    {/* Báo chi nhanh: KHÔNG gate RequirePermission — trang phục vụ HAI nhóm quyền
        (income_expenses.create ⇒ phiếu chi; personal_finance.create ⇒ Ví cá nhân) và tự rẽ
        bên trong; người không có quyền nào thấy câu báo. Chặn thật ở writer: phiếu chi qua
        create_income_expense_v1, khoản cá nhân qua RLS của personal_transactions. */}
    <Route path="/chi-tieu" element={<ProtectedRoute><QuickEntryPage /></ProtectedRoute>} />
    <Route path="/payments" element={<Navigate to="/income-expense" replace />} />
    <Route path="/payments/income-expenses" element={<Navigate to="/income-expense" replace />} />
    <Route path="/payments/income-expense" element={<Navigate to="/income-expense" replace />} />

    {/* === CÔNG VIỆC === */}
    <Route path="/tasks" element={<ProtectedRoute><RequirePermission module="tasks"><TaskManagementPage /></RequirePermission></ProtectedRoute>} />
    <Route path="/my-day" element={<ProtectedRoute><MyDayPage /></ProtectedRoute>} />
    <Route path="/viec-cua-toi" element={<ProtectedRoute><PersonalTasksPage /></ProtectedRoute>} />
    <Route path="/reports/coverage" element={<ProtectedRoute><AdminOnlyRoute><OwnerDashboardV5 /></AdminOnlyRoute></ProtectedRoute>} />

  </>
);
