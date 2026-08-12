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
];

export function capabilityById(id: string): CapabilityDefinition | undefined {
  return CAPABILITIES.find((c) => c.id === id);
}

/** Capability đang bật theo cờ runtime hiện tại. */
export function enabledCapabilities(): readonly CapabilityDefinition[] {
  return CAPABILITIES.filter((c) => c.release.enabled);
}
