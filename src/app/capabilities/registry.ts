import { NETWORK_CENTER_RUNTIME_ENABLED } from "@/lib/network-center/runtime";
import type { CapabilityDefinition, CopilotPageBatch, CopilotPageContract } from "./types";

type PageSeed = Omit<CopilotPageContract, "batch" | "rolloutKey"> & {
  batch: CopilotPageBatch;
  rolloutKey?: string;
};

/** Keep page metadata declarative: rollout keys are server-owned and default-off. */
const page = (seed: PageSeed): CopilotPageContract => ({
  ...seed,
  rolloutKey: seed.rolloutKey ?? seed.key,
});

export const COPILOT_PAGE_CONTRACTS: readonly CopilotPageContract[] = [
  page({
    key: "rooms.list",
    route: "/apartments",
    mode: "filter",
    permission: { module: "rooms", action: "view" },
    dataClass: "internal",
    batch: "property",
    safeControlIds: ["room.search", "room.status-filter"],
  }),
  page({
    key: "invoices.list",
    route: "/invoices",
    mode: "navigate",
    permission: { module: "invoices", action: "view" },
    dataClass: "financial",
    batch: "billing",
    safeControlIds: ["invoice.month-filter", "invoice.status-filter", "invoice.search"],
  }),
  page({
    key: "customers.list",
    route: "/customers",
    mode: "filter",
    permission: { module: "customers", action: "view" },
    dataClass: "pii",
    batch: "crm",
    safeControlIds: ["customer.search"],
  }),

  // Property and inventory read batch. Detail routes are patterns, not IDs.
  page({ key: "buildings.list", route: "/buildings", mode: "navigate", permission: { module: "buildings", action: "view" }, dataClass: "internal", batch: "property", safeControlIds: [] }),
  page({ key: "buildings.detail", route: "/buildings/:id", canonicalRoute: "/buildings", mode: "read", permission: { module: "buildings", action: "view" }, dataClass: "internal", batch: "property", safeControlIds: [] }),
  page({ key: "rooms.detail", route: "/apartments/:id", canonicalRoute: "/apartments", mode: "read", permission: { module: "rooms", action: "view" }, dataClass: "internal", batch: "property", safeControlIds: [] }),
  page({ key: "services.list", route: "/services", mode: "read", permission: { module: "services", action: "view" }, dataClass: "internal", batch: "property", safeControlIds: [] }),
  page({ key: "assets.list", route: "/assets", mode: "read", permission: { module: "assets", action: "view" }, dataClass: "internal", batch: "property", safeControlIds: [] }),
  page({ key: "materials.list", route: "/materials", mode: "read", permission: { module: "materials", action: "view" }, dataClass: "internal", batch: "property", safeControlIds: [] }),
  page({ key: "materials.purchases", route: "/materials/purchases", canonicalRoute: "/materials", mode: "read", permission: { module: "materials", action: "view" }, dataClass: "internal", batch: "property", safeControlIds: [] }),
  page({ key: "materials.usages", route: "/materials/usages", canonicalRoute: "/materials", mode: "read", permission: { module: "materials", action: "view" }, dataClass: "internal", batch: "property", safeControlIds: [] }),
  page({ key: "materials.adjustments", route: "/materials/adjustments", canonicalRoute: "/materials", mode: "read", permission: { module: "materials", action: "view" }, dataClass: "internal", batch: "property", safeControlIds: [] }),
  page({ key: "vehicles.list", route: "/vehicles", mode: "read", permission: { module: "vehicles", action: "view" }, dataClass: "internal", batch: "property", safeControlIds: [] }),

  // CRM and tenancy read batch. Writes and customer forms stay exempt below.
  page({ key: "leads.list", route: "/leads", mode: "read", permission: { module: "leads", action: "view" }, dataClass: "pii", batch: "crm", safeControlIds: [] }),
  page({ key: "deposits.list", route: "/deposits", mode: "read", permission: { module: "deposits", action: "view" }, dataClass: "financial", batch: "crm", safeControlIds: [] }),
  page({ key: "contracts.list", route: "/contracts", mode: "read", permission: { module: "contracts", action: "view" }, dataClass: "pii", batch: "crm", safeControlIds: [] }),
  page({ key: "contracts.detail", route: "/contracts/:id", canonicalRoute: "/contracts", mode: "read", permission: { module: "contracts", action: "view" }, dataClass: "pii", batch: "crm", safeControlIds: [] }),
  page({ key: "customers.detail", route: "/customers/:id", canonicalRoute: "/customers", mode: "read", permission: { module: "customers", action: "view" }, dataClass: "pii", batch: "crm", safeControlIds: [] }),

  // Billing/reporting read batch. No contract in this list grants a write mode.
  page({ key: "invoices.detail", route: "/invoices/:id", canonicalRoute: "/invoices", mode: "read", permission: { module: "invoices", action: "view" }, dataClass: "financial", batch: "billing", safeControlIds: [] }),
  page({ key: "invoices.print", route: "/invoices/print/:id", canonicalRoute: "/invoices", mode: "read", permission: { module: "invoices", action: "print" }, dataClass: "financial", batch: "billing", safeControlIds: [] }),
  page({ key: "income-expenses.list", route: "/income-expense", mode: "read", permission: { module: "income_expenses", action: "view" }, dataClass: "financial", batch: "billing", safeControlIds: [] }),
  page({ key: "cashbooks.list", route: "/finance/cashbooks", mode: "read", permission: { module: "cashbooks", action: "view" }, dataClass: "financial", batch: "billing", safeControlIds: [] }),
  page({ key: "reports.finance", route: "/reports/finance", mode: "read", permission: { module: "reports_finance", action: "view" }, dataClass: "financial", batch: "reports", safeControlIds: [] }),
  page({ key: "reports.finance.daily-cashbook", route: "/reports/finance/daily-cashbook", canonicalRoute: "/reports/finance", mode: "read", permission: { module: "reports_finance", action: "daily_cashbook" }, dataClass: "financial", batch: "reports", safeControlIds: [] }),
  page({ key: "reports.finance.cash-book", route: "/reports/finance/cash-book", canonicalRoute: "/reports/finance", mode: "read", permission: { module: "reports_finance", action: "daily_cashbook" }, dataClass: "financial", batch: "reports", safeControlIds: [] }),
  page({ key: "reports.finance.cash-flow", route: "/reports/finance/cash-flow", canonicalRoute: "/reports/finance", mode: "read", permission: { module: "reports_finance", action: "cash_flow" }, dataClass: "financial", batch: "reports", safeControlIds: [] }),
  page({ key: "reports.finance.payment-schedule", route: "/reports/finance/payment-schedule", canonicalRoute: "/reports/finance", mode: "read", permission: { module: "reports_finance", action: "payment_schedule" }, dataClass: "financial", batch: "reports", safeControlIds: [] }),
  page({ key: "reports.finance.overpayment", route: "/reports/finance/overpayment", canonicalRoute: "/reports/finance", mode: "read", permission: { module: "reports_finance", action: "overpayment" }, dataClass: "financial", batch: "reports", safeControlIds: [] }),
  page({ key: "reports.finance.deposits", route: "/reports/finance/deposits", canonicalRoute: "/reports/finance", mode: "read", permission: { module: "reports_finance", action: "deposits_report" }, dataClass: "financial", batch: "reports", safeControlIds: [] }),
  page({ key: "reports.finance.analysis", route: "/reports/finance/analysis", canonicalRoute: "/reports/finance", mode: "read", permission: { module: "reports_finance", action: "analysis" }, dataClass: "financial", batch: "reports", safeControlIds: [] }),
  page({ key: "reports.finance.handover", route: "/reports/finance/ban-giao", canonicalRoute: "/reports/finance", mode: "read", permission: { module: "reports_finance", action: "handover_report" }, dataClass: "financial", batch: "reports", safeControlIds: [] }),
  page({ key: "reports.finance.collection", route: "/reports/finance/thu-ban-giao", canonicalRoute: "/reports/finance", mode: "read", permission: { module: "reports_finance", action: "collection_cycle" }, dataClass: "financial", batch: "reports", safeControlIds: [] }),
  page({ key: "reports.real-estate", route: "/reports/real-estate", mode: "read", permission: { module: "reports_real_estate", action: "view" }, dataClass: "internal", batch: "reports", safeControlIds: [] }),
  page({ key: "reports.real-estate.vacant", route: "/reports/real-estate/vacant-rooms", canonicalRoute: "/reports/real-estate", mode: "read", permission: { module: "reports_real_estate", action: "vacant_rooms" }, dataClass: "internal", batch: "reports", safeControlIds: [] }),
  page({ key: "reports.real-estate.vacant-alias", route: "/reports/real-estate/vacant", canonicalRoute: "/reports/real-estate", mode: "read", permission: { module: "reports_real_estate", action: "vacant_rooms" }, dataClass: "internal", batch: "reports", safeControlIds: [] }),
  page({ key: "reports.real-estate.expiring", route: "/reports/real-estate/expiring-contracts", canonicalRoute: "/reports/real-estate", mode: "read", permission: { module: "reports_real_estate", action: "expiring" }, dataClass: "internal", batch: "reports", safeControlIds: [] }),
  page({ key: "reports.real-estate.expiring-alias", route: "/reports/real-estate/expiring", canonicalRoute: "/reports/real-estate", mode: "read", permission: { module: "reports_real_estate", action: "expiring" }, dataClass: "internal", batch: "reports", safeControlIds: [] }),
  page({ key: "reports.real-estate.renewals", route: "/reports/real-estate/renewals-transfers", canonicalRoute: "/reports/real-estate", mode: "read", permission: { module: "reports_real_estate", action: "renewals_transfers" }, dataClass: "internal", batch: "reports", safeControlIds: [] }),
  page({ key: "reports.real-estate.occupancy", route: "/reports/real-estate/occupancy", canonicalRoute: "/reports/real-estate", mode: "read", permission: { module: "reports_real_estate", action: "occupancy" }, dataClass: "internal", batch: "reports", safeControlIds: [] }),
  page({ key: "reports.real-estate.promotions", route: "/reports/real-estate/promotions", canonicalRoute: "/reports/real-estate", mode: "read", permission: { module: "reports_real_estate", action: "promotions" }, dataClass: "internal", batch: "reports", safeControlIds: [] }),
  page({ key: "reports.real-estate.new-leases", route: "/reports/real-estate/new-leases", canonicalRoute: "/reports/real-estate", mode: "read", permission: { module: "reports_real_estate", action: "new_leases" }, dataClass: "internal", batch: "reports", safeControlIds: [] }),
  page({ key: "reports.real-estate.terminations", route: "/reports/real-estate/terminations", canonicalRoute: "/reports/real-estate", mode: "read", permission: { module: "reports_real_estate", action: "terminations" }, dataClass: "internal", batch: "reports", safeControlIds: [] }),
  page({ key: "reports.real-estate.expense-ratio", route: "/reports/real-estate/expense-ratio", canonicalRoute: "/reports/real-estate", mode: "read", permission: { module: "reports_real_estate", action: "expense_ratio" }, dataClass: "internal", batch: "reports", safeControlIds: [] }),
  page({ key: "meter-readings.list", route: "/meter-readings", mode: "read", permission: { module: "meter_readings", action: "view" }, dataClass: "internal", batch: "property", safeControlIds: [] }),
  page({ key: "thu-tien.list", route: "/thu-tien", mode: "read", permission: { module: "thu_tien", action: "view" }, dataClass: "financial", batch: "billing", safeControlIds: [] }),

  // Internal communication/work queues are read-only until scoped tools exist.
  page({ key: "chat-zalo.list", route: "/chat-zalo", mode: "read", permission: { module: "chat_zalo", action: "view" }, dataClass: "pii", batch: "communications", safeControlIds: [] }),
  page({ key: "tasks.list", route: "/tasks", mode: "read", permission: { module: "tasks", action: "view" }, dataClass: "internal", batch: "workforce", safeControlIds: [] }),
];

/**
 * Routes deliberately outside the initial Copilot read/navigation pilot.
 * Each pattern has a reason so adding a route cannot silently expand exposure.
 */
export const COPILOT_PAGE_EXEMPTIONS = [
  { route: "/admin/*", reason: "admin surface remains disabled until its authz contract is reviewed" },
  { route: "/settings/*", reason: "settings and control-plane pages remain disabled" },
  { route: "/invite/*", reason: "invite/session flow is not a Copilot surface" },
  { route: "/account/*", reason: "account self-service remains disabled" },
  { route: "/faq", reason: "support content has no page contract yet" },
  { route: "/changelog", reason: "support content has no page contract yet" },
  { route: "/app-guide", reason: "support content has no page contract yet" },
  { route: "/sale-phong", reason: "sales surface is deferred" },
  { route: "/customers/new", reason: "customer create form is deferred; read-only customer contracts remain explicit" },
  { route: "/customers/:id/edit", reason: "customer edit form is deferred" },
  { route: "/customers/:id/ct01", reason: "customer print/form surface is deferred" },
  { route: "/materials/*", reason: "materials write sub-surface is deferred; read-only list views are explicit" },
  { route: "/income-expense/*", reason: "cashbook write/detail surface is deferred" },
  { route: "/finance/*", reason: "finance write/detail and salary surfaces are deferred" },
  { route: "/reports/finance/profit-distribution", reason: "profit distribution has an internal tab-level guard and is deferred" },
  { route: "/reports/finance/business-performance", reason: "business performance report lacks a route-level permission guard" },
  { route: "/finance/refund-log", reason: "refund log is a financial detail surface deferred pending read-only proof" },
  { route: "/thanh-toan", reason: "payment surface is deferred" },
  { route: "/approvals", reason: "approval surface is deferred" },
  { route: "/my-day", reason: "personal dashboard surface is deferred" },
  { route: "/reports/coverage", reason: "coverage report is deferred" },
  { route: "/quayso/*", reason: "campaign/admin surface is deferred" },
  { route: "*", reason: "404 fallback is not a Copilot surface" },
  { route: "/register", reason: "authentication flow is not a Copilot surface" },
  { route: "/login", reason: "authentication flow is not a Copilot surface" },
  { route: "/forgot-password", reason: "authentication flow is not a Copilot surface" },
  { route: "/reset-password", reason: "authentication flow is not a Copilot surface" },
  { route: "/c/:code", reason: "public customer link is not a Copilot surface" },
  { route: "/r/:token", reason: "public vacancy link is not a Copilot surface" },
  { route: "/phongtrong", reason: "public vacancy alias is not a Copilot surface" },
  { route: "/", reason: "dashboard shell is deferred" },
  { route: "/dashboard", reason: "dashboard shell is deferred" },
  { route: "/building-map", reason: "map surface is deferred" },
  { route: "/network-center/*", reason: "infrastructure surface is deferred" },
  { route: "/notifications", reason: "notification surface is deferred" },
  { route: "/finance/personal-wallet", reason: "personal finance surface is deferred" },
  { route: "/finance/salary", reason: "salary surface is deferred" },
  { route: "/finance/my-salary", reason: "salary self-service surface is deferred" },
];

function normalizeCopilotRoute(pathname: string): string {
  const path = pathname.split(/[?#]/, 1)[0] || "/";
  return path.replace(/\/+$/, "") || "/";
}

function copilotRouteMatches(pattern: string, pathname: string): boolean {
  const expected = normalizeCopilotRoute(pattern);
  const actual = normalizeCopilotRoute(pathname);
  if (expected === "*") return actual === "*";
  const expectedParts = expected.split("/").filter(Boolean);
  const actualParts = actual.split("/").filter(Boolean);
  const wildcard = expectedParts.at(-1) === "*";
  const fixedLength = wildcard ? expectedParts.length - 1 : expectedParts.length;
  if ((!wildcard && expectedParts.length !== actualParts.length) || actualParts.length < fixedLength) return false;
  return expectedParts.slice(0, fixedLength).every((part, index) => part.startsWith(":") || part === actualParts[index]);
}

export function copilotPageByRoute(pathname: string): CopilotPageContract | undefined {
  const normalized = normalizeCopilotRoute(pathname);
  const exact = COPILOT_PAGE_CONTRACTS.find((page) => normalizeCopilotRoute(page.route) === normalized);
  if (exact) return exact;
  if (COPILOT_PAGE_EXEMPTIONS.some((entry) => copilotRouteMatches(entry.route, normalized))) return undefined;
  return COPILOT_PAGE_CONTRACTS.find((page) => copilotRouteMatches(page.route, normalized));
}

export function copilotRouteForKey(key: string): string | undefined {
  const page = COPILOT_PAGE_CONTRACTS.find((entry) => entry.key === key);
  return page?.canonicalRoute ?? page?.route;
}

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
    copilot: { pages: COPILOT_PAGE_CONTRACTS.filter((p) => p.key === "invoices.list") },
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
    copilot: { pages: COPILOT_PAGE_CONTRACTS.filter((p) => p.key === "customers.list") },
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
    e2e: { spec: ".e2e-fleet/specs/chat-zalo.spec.ts" },
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
    copilot: { pages: COPILOT_PAGE_CONTRACTS.filter((p) => p.key === "rooms.list") },
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
