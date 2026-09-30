// Tên trang chỉ dùng trong thông báo lỗi; không kéo catalog phân quyền vào boot.
// Giữ đúng thứ tự ALL_PAGES. Kiểm thử parity yêu cầu cập nhật bảng này khi catalog đổi.
export const ERROR_PAGE_NAMES = [
  { route: "/", label: "Bảng tin" },
  { route: "/", label: "AI Copilot" },
  { route: "/notifications", label: "Thông báo" },
  { route: "/building-map", label: "Sơ đồ toà nhà" },
  { route: "/chat-zalo", label: "Chat Zalo" },
  { route: "/buildings", label: "Toà nhà & Khu vực" },
  { route: "/apartments", label: "Căn hộ / Phòng" },
  { route: "/services", label: "Dịch vụ" },
  { route: "/sale-phong", label: "Sale Phòng" },
  { route: "/leads", label: "Khách hẹn" },
  { route: "/deposits", label: "Đặt cọc" },
  { route: "/contracts", label: "Hợp đồng" },
  { route: "/customers", label: "Cư dân" },
  { route: "/vehicles", label: "Phương tiện" },
  { route: "/finance/cashbooks", label: "Sổ quỹ" },
  { route: "/meter-readings", label: "Ghi chỉ số" },
  { route: "/invoices", label: "Hoá đơn" },
  { route: "/thu-tien", label: "Thu tiền (mobile)" },
  { route: "/income-expense", label: "Thu chi" },
  { route: "/reports/finance/overpayment", label: "Tiền thừa" },
  { route: "/reports/finance/profit-distribution", label: "Lợi nhuận cổ đông" },
  { route: "/finance/salary", label: "Bảng lương quản lý" },
  { route: "/finance/personal-wallet", label: "Ví thu chi cá nhân" },
  { route: "/assets", label: "Tài sản" },
  { route: "/materials", label: "Vật tư" },
  { route: "/settings/categories/asset-types", label: "Loại tài sản" },
  { route: "/settings/categories/warehouses", label: "Kho" },
  { route: "/settings/categories/suppliers", label: "Nhà cung cấp" },
  { route: "/network-center", label: "Trung tâm mạng" },
  { route: "/tasks", label: "Công việc" },
  { route: "/settings/categories/task-types", label: "Loại công việc" },
  { route: "/reports/real-estate", label: "Báo cáo BĐS" },
  { route: "/reports/finance", label: "Báo cáo tài chính" },
  { route: "/settings/meters", label: "Đồng hồ / Công tơ" },
  { route: "/settings/categories/service-quotas", label: "Định mức dịch vụ" },
  { route: "/settings/categories/auto-debt", label: "Gạch nợ tự động" },
  { route: "/settings/categories/hotlines", label: "Hotline" },
  { route: "/settings/categories", label: "Danh mục khác" },
  { route: "/settings/templates", label: "Biểu mẫu / Chữ ký" },
  { route: "/settings/general", label: "Cài đặt chung" },
  { route: "/settings/members", label: "Phân quyền nhân viên" },
] as const;

const pagesByRouteLength = [...ERROR_PAGE_NAMES]
  .sort((a, b) => b.route.length - a.route.length);

export function errorPageName(path: string): string {
  return pagesByRouteLength.find(page => path === page.route || (page.route !== '/' && path.startsWith(`${page.route}/`)))?.label ?? 'đang mở';
}
