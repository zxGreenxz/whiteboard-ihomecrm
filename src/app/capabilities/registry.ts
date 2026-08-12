import { NETWORK_CENTER_RUNTIME_ENABLED } from "@/lib/network-center/runtime";
import { OPENCLAW_RUNTIME_ENABLED } from "@/lib/openclaw-zalo/runtime";
import type { CapabilityDefinition } from "./types";

/**
 * Registry bề mặt sản phẩm ở mức trang.
 *
 * Bắt đầu bằng đúng hai capability này vì chúng đã DRIFT THẬT: route được gác
 * sau cờ, nhưng tile ở launcher và mục ở sidebar từng bị bỏ sót — người dùng
 * giữ quyền nên vẫn thấy lối vào, bấm vào thì rơi ra 404. Các comment cảnh báo
 * nằm rải ở App.tsx, Sidebar.tsx và launcherTiles.ts đều nói về đúng sự cố đó.
 *
 * Ở lát này registry là nguồn ĐỐI CHIẾU: contract test đọc nó và kiểm bốn nơi
 * kia có khớp không. Việc cho các consumer sinh trực tiếp từ registry là lát
 * sau — đổi cùng lúc sẽ làm mất khả năng chỉ ra thứ gì gây ra sai lệch nếu có.
 */
export const CAPABILITIES: readonly CapabilityDefinition[] = [
  {
    id: "network-center",
    primaryRoute: "/network-center",
    label: "Trung tâm mạng",
    release: { enabled: NETWORK_CENTER_RUNTIME_ENABLED, runtimeModule: "network-center" },
    permission: { module: "network_center", action: "view" },
    surfaces: {
      desktopNav: true,
      mobileLauncher: true,
      permissionPage: "/network-center",
    },
    docs: {
      systemDoc: "docs/he-thong/22-network-center.md",
      // Bề mặt QUẢN TRỊ hạ tầng: chỉ chủ tổ chức và người được giao mới thấy, và
      // bốn thao tác của nó chạm router thật. Hướng dẫn của nó là runbook vận
      // hành (docs/he-thong/22-*.md), không phải trang cho người thuê nhà.
      userDoc: null,
      userDocMienTruVi:
        "Bề mặt quản trị hạ tầng, sau cờ build-time mặc định TẮT. Người dùng cuối không truy cập được nên một trang trong docs-site sẽ hứa thứ họ không mở được.",
      visibility: "internal",
    },
    e2e: { spec: ".e2e-fleet/specs/network-center.spec.ts" },
    risk: "infrastructure",
  },
  {
    id: "openclaw-zalo",
    primaryRoute: "/openclaw-zalo",
    label: "OpenClaw Zalo",
    release: { enabled: OPENCLAW_RUNTIME_ENABLED, runtimeModule: "openclaw-zalo" },
    permission: { module: "openclaw_zalo", action: "view" },
    surfaces: {
      desktopNav: true,
      mobileLauncher: true,
      permissionPage: "/openclaw-zalo",
    },
    docs: {
      systemDoc: "docs/he-thong/23-openclaw-zalo.md",
      // LƯU Ý dễ nhầm: docs-site CÓ trang "chat-zalo" nhưng đó là Chat Zalo CŨ
      // (docs/he-thong/18-zalo-chat.md), một hệ khác. Trỏ nó vào đây sẽ dẫn người
      // đọc tới hướng dẫn của tính năng khác — sai còn tệ hơn để trống.
      userDoc: null,
      userDocMienTruVi:
        "Rollout 11 bậc chưa tới bậc COMPLETE và cờ build-time mặc định TẮT. Trang hướng dẫn viết bây giờ sẽ mô tả một luồng còn đang đổi.",
      visibility: "internal",
    },
    e2e: { spec: ".e2e-fleet/specs/openclaw-zalo.spec.ts" },
    risk: "security",
  },

  // ===========================================================================
  // ĐỢT MIỀN TIỀN — bốn bề mặt đầu tiên KHÔNG phải "tính năng sau cờ".
  //
  // Hai capability ở trên vào registry vì chúng đã DRIFT THẬT (route sau cờ mà
  // nav/launcher bỏ sót). Bốn cái dưới đây vào vì lý do ngược lại: chúng là bề
  // mặt bình thường, ổn định, và chính vì thế mà bốn nơi khai chúng lệch nhau lúc
  // nào không ai biết. Chúng cũng là nhóm DUY NHẤT hiện có đủ CẢ BỐN bằng chứng
  // mà gate đòi — trang quyền, tài liệu hệ thống, hướng dẫn người dùng nằm trong
  // sidebar docs-site, và spec E2E — nên khai được mà không phải bịa trường nào.
  //
  // ĐO 12/08/2026 trên cả 146 route: 28 route có nav/launcher kèm quyền, nhưng
  // chỉ 2 route đủ cả tài liệu lẫn E2E, 23 route có tài liệu mà thiếu spec, 3
  // route chưa có tài liệu hệ thống. Bốn mục dưới là 2 route đủ sẵn cộng hai route
  // mà spec đã có nhưng bộ kiểm kê tự động bỏ sót vì tên file không khớp tên route.
  //
  // ID PHẢI TRÙNG ID TILE LAUNCHER — `launcherFieldsFor` lấy id capability làm id
  // tile, và `HomeLauncher.tsx` phân biệt kiểu hiển thị theo id (`invoices`,
  // `thu-tien`). Vì vậy giữ nguyên hai cái tên đặt LỆCH NGHĨA có sẵn:
  //   `funds`    → /finance/cashbooks (Sổ quỹ)
  //   `cashbook` → /income-expense    (Thu chi)
  // Đọc ngược nhau, và đó chính là cái bẫy bộ kiểm kê nêu ra. Đổi tên id ở đây là
  // đổi hành vi hiển thị — việc riêng, không gộp vào lát mở registry.
  // ===========================================================================
  {
    id: "invoices",
    primaryRoute: "/invoices",
    label: "Hoá đơn",
    release: { enabled: true, runtimeModule: null },
    permission: { module: "invoices", action: "view" },
    surfaces: { desktopNav: true, mobileLauncher: true, permissionPage: "/invoices" },
    docs: {
      systemDoc: "docs/he-thong/07-hoa-don-thanh-toan.md",
      userDoc: "docs/huong-dan-su-dung/03-quan-ly-van-hanh/hoa-don/index.md",
      visibility: "public",
    },
    e2e: { spec: ".e2e-fleet/specs/invoice-collection-v5.spec.ts" },
    risk: "financial",
  },
  {
    id: "cashbook",
    primaryRoute: "/income-expense",
    label: "Thu chi",
    release: { enabled: true, runtimeModule: null },
    permission: { module: "income_expenses", action: "view" },
    surfaces: { desktopNav: true, mobileLauncher: true, permissionPage: "/income-expense" },
    docs: {
      systemDoc: "docs/he-thong/08-thu-chi-so-quy.md",
      userDoc: "docs/huong-dan-su-dung/03-quan-ly-van-hanh/thu-chi/index.md",
      visibility: "public",
    },
    e2e: { spec: ".e2e-fleet/specs/ie-create.spec.ts" },
    risk: "financial",
  },
  {
    id: "funds",
    primaryRoute: "/finance/cashbooks",
    label: "Sổ quỹ",
    release: { enabled: true, runtimeModule: null },
    permission: { module: "cashbooks", action: "view" },
    surfaces: { desktopNav: true, mobileLauncher: true, permissionPage: "/finance/cashbooks" },
    docs: {
      systemDoc: "docs/he-thong/08-thu-chi-so-quy.md",
      userDoc: "docs/huong-dan-su-dung/03-quan-ly-van-hanh/so-quy/index.md",
      visibility: "public",
    },
    e2e: { spec: ".e2e-fleet/specs/cashbook-create-org-resolution.spec.ts" },
    risk: "financial",
  },
  {
    id: "salary",
    primaryRoute: "/finance/salary",
    label: "Bảng lương",
    release: { enabled: true, runtimeModule: null },
    permission: {
      module: "salary",
      action: "view",
      // Đã đọc `ManagerSalaryPage` trước khi khai miễn trừ này, không suy đoán:
      // trang tự rẽ admin ↔ self-view bằng `canUse(perms, "salary", lock|
      // manage_salary|distribute)`. Nhánh KHÔNG-admin chỉ hiện đúng bản ghi của
      // chính người đang đăng nhập (`myMgr`), và ai chưa được cấu hình hưởng
      // lương thì thấy dòng "Bạn chưa được cấu hình hưởng lương" — dữ liệu chặn
      // ở RLS chứ không ở router. Bọc `RequirePermission salary.view` sẽ CHẶN
      // nhân viên xem lương của chính mình, tức sửa một cảnh báo bằng cách làm
      // hỏng tính năng. `salary.view` ở đây là quyền của BỀ MẶT nav/tile.
      guardMienTruVi:
        "Trang phục vụ hai đối tượng và tự rẽ admin ↔ self-view; gác ở router sẽ chặn nhân viên xem lương của chính mình. Dữ liệu chặn ở RLS.",
    },
    surfaces: { desktopNav: true, mobileLauncher: true, permissionPage: "/finance/salary" },
    docs: {
      systemDoc: "docs/he-thong/17-luong-thuong.md",
      userDoc: "docs/huong-dan-su-dung/03-quan-ly-van-hanh/bang-luong/index.md",
      visibility: "public",
    },
    e2e: { spec: ".e2e-fleet/specs/salary-mobile-period.spec.ts" },
    risk: "financial",
  },

  {
    id: "buildings",
    primaryRoute: "/buildings",
    label: "Toà nhà",
    release: { enabled: true, runtimeModule: null },
    permission: { module: "buildings", action: "view" },
    surfaces: { desktopNav: true, mobileLauncher: true, permissionPage: "/buildings" },
    docs: {
      systemDoc: "docs/he-thong/02-co-cau-toa-nha-phong-dich-vu.md",
      userDoc: "docs/huong-dan-su-dung/03-quan-ly-van-hanh/toa-nha/index.md",
      visibility: "public",
    },
    e2e: { spec: ".e2e-fleet/specs/capability-route-smoke.spec.ts" },
    risk: "normal",
  },
  {
    id: "services",
    primaryRoute: "/services",
    label: "Dịch vụ",
    release: { enabled: true, runtimeModule: null },
    permission: { module: "services", action: "view" },
    surfaces: { desktopNav: true, mobileLauncher: false, permissionPage: "/services" },
    docs: {
      systemDoc: "docs/he-thong/02-co-cau-toa-nha-phong-dich-vu.md",
      userDoc: "docs/huong-dan-su-dung/03-quan-ly-van-hanh/dich-vu/index.md",
      visibility: "public",
    },
    e2e: { spec: ".e2e-fleet/specs/capability-route-smoke.spec.ts" },
    risk: "normal",
  },
  {
    id: "assets",
    primaryRoute: "/assets",
    label: "Tài sản",
    release: { enabled: true, runtimeModule: null },
    permission: { module: "assets", action: "view" },
    surfaces: { desktopNav: true, mobileLauncher: false, permissionPage: "/assets" },
    docs: {
      systemDoc: "docs/he-thong/10-tai-san.md",
      userDoc: "docs/huong-dan-su-dung/03-quan-ly-van-hanh/tai-san/index.md",
      visibility: "public",
    },
    e2e: { spec: ".e2e-fleet/specs/capability-route-smoke.spec.ts" },
    risk: "normal",
  },
  {
    id: "leads",
    primaryRoute: "/leads",
    label: "Khách hẹn",
    release: { enabled: true, runtimeModule: null },
    permission: { module: "leads", action: "view" },
    surfaces: { desktopNav: true, mobileLauncher: true, permissionPage: "/leads" },
    docs: {
      systemDoc: "docs/he-thong/03-khach-hang-lead-ho-so.md",
      userDoc: "docs/huong-dan-su-dung/03-quan-ly-van-hanh/khach-hen/index.md",
      visibility: "public",
    },
    e2e: { spec: ".e2e-fleet/specs/capability-route-smoke.spec.ts" },
    risk: "normal",
  },
  {
    id: "deposits",
    primaryRoute: "/deposits",
    label: "Đặt cọc",
    release: { enabled: true, runtimeModule: null },
    permission: { module: "deposits", action: "view" },
    surfaces: { desktopNav: true, mobileLauncher: false, permissionPage: "/deposits" },
    docs: {
      systemDoc: "docs/he-thong/04-coc-giu-cho.md",
      userDoc: "docs/huong-dan-su-dung/03-quan-ly-van-hanh/dat-coc/index.md",
      visibility: "public",
    },
    e2e: { spec: ".e2e-fleet/specs/capability-route-smoke.spec.ts" },
    risk: "financial",
  },
  {
    id: "contracts",
    primaryRoute: "/contracts",
    label: "Hợp đồng",
    release: { enabled: true, runtimeModule: null },
    permission: { module: "contracts", action: "view" },
    surfaces: { desktopNav: true, mobileLauncher: true, permissionPage: "/contracts" },
    docs: {
      systemDoc: "docs/he-thong/05-hop-dong.md",
      userDoc: "docs/huong-dan-su-dung/03-quan-ly-van-hanh/hop-dong/index.md",
      visibility: "public",
    },
    e2e: { spec: ".e2e-fleet/specs/capability-route-smoke.spec.ts" },
    risk: "financial",
  },
  {
    id: "customers",
    primaryRoute: "/customers",
    label: "Khách hàng",
    release: { enabled: true, runtimeModule: null },
    permission: { module: "customers", action: "view" },
    surfaces: { desktopNav: true, mobileLauncher: true, permissionPage: "/customers" },
    docs: {
      systemDoc: "docs/he-thong/03-khach-hang-lead-ho-so.md",
      userDoc: "docs/huong-dan-su-dung/03-quan-ly-van-hanh/cu-dan/index.md",
      visibility: "public",
    },
    e2e: { spec: ".e2e-fleet/specs/capability-route-smoke.spec.ts" },
    risk: "normal",
  },
  {
    id: "vehicles",
    primaryRoute: "/vehicles",
    label: "Phương tiện",
    release: { enabled: true, runtimeModule: null },
    permission: { module: "vehicles", action: "view" },
    surfaces: { desktopNav: true, mobileLauncher: true, permissionPage: "/vehicles" },
    docs: {
      systemDoc: "docs/he-thong/03-khach-hang-lead-ho-so.md",
      userDoc: "docs/huong-dan-su-dung/03-quan-ly-van-hanh/phuong-tien/index.md",
      visibility: "public",
    },
    e2e: { spec: ".e2e-fleet/specs/capability-route-smoke.spec.ts" },
    risk: "normal",
  },
  {
    id: "meters",
    primaryRoute: "/meter-readings",
    label: "Ghi chỉ số",
    release: { enabled: true, runtimeModule: null },
    permission: { module: "meter_readings", action: "view" },
    surfaces: { desktopNav: true, mobileLauncher: true, permissionPage: "/meter-readings" },
    docs: {
      systemDoc: "docs/he-thong/06-cong-to-chi-so.md",
      userDoc: "docs/huong-dan-su-dung/03-quan-ly-van-hanh/ghi-chi-so/index.md",
      visibility: "public",
    },
    e2e: { spec: ".e2e-fleet/specs/capability-route-smoke.spec.ts" },
    risk: "normal",
  },
  {
    id: "tasks",
    primaryRoute: "/tasks",
    label: "Công việc",
    release: { enabled: true, runtimeModule: null },
    permission: { module: "tasks", action: "view" },
    surfaces: { desktopNav: true, mobileLauncher: true, permissionPage: "/tasks" },
    docs: {
      systemDoc: "docs/he-thong/11-cong-viec-su-co.md",
      userDoc: "docs/huong-dan-su-dung/03-quan-ly-van-hanh/cong-viec/index.md",
      visibility: "public",
    },
    e2e: { spec: ".e2e-fleet/specs/capability-route-smoke.spec.ts" },
    risk: "normal",
  },
  {
    id: "chat-zalo",
    primaryRoute: "/chat-zalo",
    label: "Chat Zalo",
    release: { enabled: true, runtimeModule: null },
    permission: { module: "chat_zalo", action: "view" },
    surfaces: { desktopNav: true, mobileLauncher: false, permissionPage: "/chat-zalo" },
    docs: {
      systemDoc: "docs/he-thong/18-zalo-chat.md",
      userDoc: "docs/huong-dan-su-dung/03-quan-ly-van-hanh/chat-zalo/index.md",
      visibility: "public",
    },
    e2e: { spec: ".e2e-fleet/specs/capability-route-smoke.spec.ts" },
    risk: "normal",
  },
  {
    id: "notifications",
    primaryRoute: "/notifications",
    label: "Thông báo",
    release: { enabled: true, runtimeModule: null },
    permission: { module: "notifications", action: "view" },
    surfaces: { desktopNav: true, mobileLauncher: false, permissionPage: "/notifications" },
    docs: {
      systemDoc: "docs/he-thong/13-bao-cao-dashboard-thong-bao.md",
      userDoc: "docs/huong-dan-su-dung/02-theo-doi-nhanh/thong-bao/index.md",
      visibility: "public",
    },
    e2e: { spec: ".e2e-fleet/specs/capability-route-smoke.spec.ts" },
    risk: "normal",
  },
  {
    id: "templates",
    primaryRoute: "/settings/templates",
    label: "Mẫu biểu",
    release: { enabled: true, runtimeModule: null },
    permission: { module: "templates", action: "view" },
    surfaces: { desktopNav: true, mobileLauncher: false, permissionPage: "/settings/templates" },
    docs: {
      systemDoc: "docs/he-thong/14-cai-dat-danh-muc-tai-lieu.md",
      userDoc: "docs/huong-dan-su-dung/05-cai-dat/mau-bieu/index.md",
      visibility: "public",
    },
    e2e: { spec: ".e2e-fleet/specs/capability-route-smoke.spec.ts" },
    risk: "normal",
  },

  {
    id: "rooms",
    primaryRoute: "/apartments",
    label: "Căn hộ",
    release: { enabled: true, runtimeModule: null },
    permission: { module: "rooms", action: "view" },
    surfaces: { desktopNav: true, mobileLauncher: true, permissionPage: "/apartments" },
    docs: {
      systemDoc: "docs/he-thong/02-co-cau-toa-nha-phong-dich-vu.md",
      userDoc: "docs/huong-dan-su-dung/03-quan-ly-van-hanh/can-ho-phong/index.md",
      visibility: "public",
    },
    e2e: { spec: ".e2e-fleet/specs/capability-route-smoke.spec.ts" },
    risk: "normal",
  },
  {
    id: "materials",
    primaryRoute: "/materials",
    label: "Kho vật tư",
    release: { enabled: true, runtimeModule: null },
    permission: { module: "materials", action: "view" },
    surfaces: { desktopNav: true, mobileLauncher: false, permissionPage: "/materials" },
    docs: {
      systemDoc: "docs/he-thong/09-kho-vat-tu.md",
      userDoc: "docs/huong-dan-su-dung/03-quan-ly-van-hanh/kho-vat-tu/index.md",
      visibility: "public",
    },
    e2e: { spec: ".e2e-fleet/specs/capability-route-smoke.spec.ts" },
    risk: "normal",
  },
  {
    id: "thu-tien",
    primaryRoute: "/thu-tien",
    label: "Thu tiền",
    release: { enabled: true, runtimeModule: null },
    permission: { module: "thu_tien", action: "view" },
    surfaces: { desktopNav: true, mobileLauncher: true, permissionPage: "/thu-tien" },
    docs: {
      systemDoc: "docs/he-thong/15-kenh-cong-khai-sale-thu-tien.md",
      userDoc: "docs/huong-dan-su-dung/03-quan-ly-van-hanh/thu-tien-hoa-don/index.md",
      visibility: "public",
    },
    e2e: { spec: ".e2e-fleet/specs/capability-route-smoke.spec.ts" },
    risk: "financial",
  },

  {
    id: "sale-phong",
    primaryRoute: "/sale-phong",
    label: "Sale Phòng",
    release: { enabled: true, runtimeModule: null },
    permission: { module: "sale_phong", action: "view" },
    surfaces: {
      desktopNav: true,
      mobileLauncher: true,
      permissionPage: "/sale-phong",
    },
    docs: {
      systemDoc: "docs/he-thong/15-kenh-cong-khai-sale-thu-tien.md",
      userDoc: "docs/huong-dan-su-dung/03-quan-ly-van-hanh/sale-phong/index.md",
      visibility: "public",
    },
    e2e: { spec: ".e2e-fleet/specs/capability-route-smoke.spec.ts" },
    risk: "normal",
  },
  {
    id: "reports",
    primaryRoute: "/reports/real-estate",
    label: "Báo cáo bất động sản",
    release: { enabled: true, runtimeModule: null },
    permission: { module: "reports_real_estate", action: "view" },
    surfaces: {
      desktopNav: true,
      mobileLauncher: true,
      permissionPage: "/reports/real-estate",
    },
    docs: {
      systemDoc: "docs/he-thong/13-bao-cao-dashboard-thong-bao.md",
      userDoc: "docs/huong-dan-su-dung/04-bao-cao/hub-bds/index.md",
      visibility: "public",
    },
    e2e: { spec: ".e2e-fleet/specs/capability-route-smoke.spec.ts" },
    risk: "normal",
  },
  {
    id: "settings",
    primaryRoute: "/settings/general",
    label: "Cài đặt chung",
    release: { enabled: true, runtimeModule: null },
    permission: { module: "settings", action: "view" },
    surfaces: {
      desktopNav: true,
      mobileLauncher: true,
      permissionPage: "/settings/general",
    },
    docs: {
      systemDoc: "docs/he-thong/14-cai-dat-danh-muc-tai-lieu.md",
      userDoc: "docs/huong-dan-su-dung/05-cai-dat/cai-dat-chung/index.md",
      visibility: "public",
    },
    e2e: { spec: ".e2e-fleet/specs/capability-route-smoke.spec.ts" },
    risk: "normal",
  },
  {
    id: "map",
    primaryRoute: "/building-map",
    label: "Sơ đồ toà nhà",
    release: { enabled: true, runtimeModule: null },
    permission: { module: "buildings", action: "view" },
    surfaces: {
      desktopNav: true,
      mobileLauncher: true,
      // TRANG QUYỀN LÀ "/buildings", KHÔNG PHẢI "/building-map".
      // Route này gác bằng `buildings.view` — nó MƯỢN quyền của Toà nhà chứ không
      // có quyền riêng. Trong picker, ô cấp `buildings.view` nằm ở trang "Toà nhà &
      // Khu vực"; entry "/building-map" trong permissionPages chỉ là lối vào cho dễ
      // tìm, nó không cấp được gì mà trang kia chưa cấp. Trỏ vào đây mới đúng chỗ
      // người quản trị thật sự bật/tắt quyền cho màn này.
      permissionPage: "/buildings",
    },
    docs: {
      systemDoc: "docs/he-thong/02-co-cau-toa-nha-phong-dich-vu.md",
      userDoc: "docs/huong-dan-su-dung/02-theo-doi-nhanh/so-do-toa-nha/index.md",
      visibility: "public",
    },
    e2e: { spec: ".e2e-fleet/specs/capability-route-smoke.spec.ts" },
    risk: "normal",
  },
  {
    id: "overpayment",
    primaryRoute: "/reports/finance/overpayment",
    label: "Tiền thừa",
    release: { enabled: true, runtimeModule: null },
    permission: { module: "reports_finance", action: "overpayment" },
    surfaces: {
      desktopNav: true,
      mobileLauncher: false,
      // TRANG QUYỀN LÀ "/reports/finance", KHÔNG PHẢI route của chính nó.
      // Route gác bằng `reports_finance.overpayment`, và ô cấp quyền đó nằm ở trang
      // "Báo cáo tài chính". Trang `excess_amounts` trong picker CŨNG mang route
      // "/reports/finance/overpayment" nhưng cấp một module KHÁC (quyền trên dữ liệu
      // tiền thừa, cưỡng chế ở RLS) — bật nó KHÔNG mở được màn này. Đây là điểm dễ
      // nhầm nhất trong bảng phân quyền, nên ghi thẳng ra đây.
      permissionPage: "/reports/finance",
    },
    docs: {
      systemDoc: "docs/he-thong/13-bao-cao-dashboard-thong-bao.md",
      userDoc: "docs/huong-dan-su-dung/03-quan-ly-van-hanh/tien-thua/index.md",
      visibility: "public",
    },
    e2e: { spec: ".e2e-fleet/specs/capability-route-smoke.spec.ts" },
    risk: "financial",
  },
];

export function capabilityById(id: string): CapabilityDefinition | undefined {
  return CAPABILITIES.find((c) => c.id === id);
}

/** Capability đang bật theo cờ runtime hiện tại. */
export function enabledCapabilities(): readonly CapabilityDefinition[] {
  return CAPABILITIES.filter((c) => c.release.enabled);
}
