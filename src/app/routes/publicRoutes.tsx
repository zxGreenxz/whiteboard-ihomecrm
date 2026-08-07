// Nhóm route: CÔNG KHAI — không cần đăng nhập. Tách khỏi App.tsx (P1.2).
//
// Xuất ra một Fragment chứa các <Route>, giống mọi nhóm khác trong thư mục này:
// react-router 6 đệ quy vào Fragment khi dựng bảng route nên JSX giữ nguyên từng
// ký tự so với bản trong App.tsx.
//
// VÌ SAO GOM RIÊNG NHÓM NÀY
//   Route công khai là bề mặt tấn công lớn nhất của app — bất kỳ ai trên Internet
//   cũng mở được. Rải chúng lẫn giữa 150 route có guard nghĩa là không ai đếm nổi
//   chúng, và một route mới quên bọc `ProtectedRoute` trông y hệt hàng xóm.
//   Gom một chỗ thì danh sách này ĐẾM ĐƯỢC, và gate
//   scripts/check-route-guards.mjs vẫn quét cả thư mục nên guard (hoặc việc cố ý
//   không có guard) của từng route ở đây vẫn được kiểm như cũ.
import { Route } from "react-router-dom";
import { Suspense } from "react";
import PublicRoute from "../../components/auth/PublicRoute";
import Register from "../../pages/auth/Register";
import Login from "../../pages/auth/Login";
import ForgotPassword from "../../pages/auth/ForgotPassword";
import ResetPassword from "../../pages/auth/ResetPassword";
import {
  PublicContractInvoicePage,
  PhongTrongPage,
  QuaySoPage,
  QuaySoScreenPage,
} from "../lazyPages";

export const publicRoutes = (
  <>
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
    <Route path="/reset-password" element={<ResetPassword />} />

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
        Slug 'admin' cũng đã bị CHECK constraint chặn ở DB.
        Chính tính chất này là lý do việc TÁCH FILE không đổi hành vi: bảng route
        được xếp hạng theo độ cụ thể, không theo thứ tự khai. */}
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
  </>
);
