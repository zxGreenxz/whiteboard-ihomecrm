// Nhóm route: Chia lợi nhuận cổ đông + bảng lương quản lý. Tách khỏi App.tsx (Đợt 4).
//
// Xuất ra một Fragment chứa các <Route>. react-router 6 đệ quy vào Fragment khi
// dựng bảng route, nên cụm này cắm thẳng vào <Routes> mà KHÔNG cần thêm key cho
// từng route — tức JSX giữ nguyên từng ký tự so với bản trong App.tsx.
//
// Gate scripts/check-route-guards.mjs quét cả thư mục này, nên guard của các
// route ở đây vẫn được kiểm như khi chúng còn nằm trong App.tsx.
import { Route, Navigate } from "react-router-dom";
import {
  ManagerSalaryPage,
  MySalaryPage,
  PersonalWalletPage,
} from "../lazyPages";
import ProtectedRoute from "../../components/auth/ProtectedRoute";
import { RequirePermission } from "../../components/auth/RequirePermission";

export const salaryProfitRoutes = (
  <>
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

  </>
);
