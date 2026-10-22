import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { readRpcAllowlist } from "../../.e2e-fleet/support/read-rpc-allowlist.ts";

// Hàng rào cho `.e2e-fleet/support/read-rpc-allowlist.ts`: module chỉ chặn tên ghi theo tiền tố
// (save_/adjust_/record_/lock_…), nên `personal_finance_mutate`, `release_room_sale_lock_v1`…
// vẫn lọt. Test này đối chiếu MỌI tên trong SHELL/SHARED/PAGES với volatility trong
// contracts/surfaces/rpc-surface.json (catalog live đã normalize): tên VOLATILE chỉ được ở
// đúng nhóm khai trong VOLATILE_EXCEPTIONS, tên vắng khỏi bề mặt phải khai NOT_IN_SURFACE.
// Test nằm ở scripts/__tests__ (vitest app-unit) để không đổi cây `.e2e-fleet/`.

const MODULE_PATH = fileURLToPath(new URL("../../.e2e-fleet/support/read-rpc-allowlist.ts", import.meta.url));
const SURFACE_PATH = fileURLToPath(new URL("../../contracts/surfaces/rpc-surface.json", import.meta.url));

/**
 * 16 tên VOLATILE kế thừa từ danh sách đọc cũ của các spec (trước PR #205; get_notification_org_config_v1 gỡ 22/10
 * vì web chuyển sang get_notification_org_config_v2 chỉ ở /account/notifications, PR #275). Mỗi tên chỉ được ở
 * nhóm khai ở đây; thêm tên VOLATILE mới hoặc chuyển nhóm phải sửa bảng này kèm lý do.
 * "Chỉ SELECT" = thân hàm ở migration định nghĩa cuối không INSERT/UPDATE/DELETE; chỉ thiếu khai STABLE.
 */
const VOLATILE_EXCEPTIONS = {
  business_performance_organizations_v1: { groups: ["SHELL"], reason: "chỉ SELECT; sidebar/báo cáo gọi khi mở app (useBusinessPerformance)" },
  is_company_owner_self_v1: { groups: ["SHELL"], reason: "chỉ SELECT, trả boolean; mọi màn hỏi vai chủ công ty (useIsCompanyOwner)" },
  is_org_owner_self_v1: { groups: ["SHELL"], reason: "chỉ SELECT, trả boolean; mọi màn hỏi vai chủ org (useIsOrgOwner)" },
  get_my_notification_preferences_v1: { groups: ["SHELL"], reason: "chỉ SELECT; chuông thông báo đọc sở thích (useNotificationSettings)" },
  get_invoice_statistics_v2: { groups: ["dashboard", "invoices"], reason: "chỉ SELECT; thẻ thống kê hoá đơn cũ ở / và /invoices" },
  get_customer_credit_balance_v1: { groups: ["invoices"], reason: "chỉ SELECT, trả numeric; số dư có của khách ở /invoices/:id" },
  can_flex_cancel_v1: { groups: ["incomeExpense"], reason: "chỉ SELECT; hỏi phiếu nào được huỷ linh hoạt, không huỷ (flexMutations)" },
  get_refund_forfeit_summary: { groups: ["deposits"], reason: "chỉ SELECT; thẻ tổng hoàn/mất cọc ở /deposits (useDepositDashboard)" },
  sale_bonus_status_v1: { groups: ["rentSupport"], reason: "chỉ SELECT; trạng thái thưởng sale trên chi tiết hợp đồng (useSaleBonus)" },
  get_room_cash_lifecycle_v1: { groups: ["rentSupport"], reason: "chỉ SELECT; vòng đời tiền phòng trên chi tiết hợp đồng (useRoomCashLifecycle)" },
  get_room_residence_segments_v1: { groups: ["rentSupport"], reason: "chỉ SELECT; đoạn cư trú trên chi tiết hợp đồng (useContractLifecycle)" },
  rent_support_salary_bridge_required_v1: { groups: ["salary"], reason: "chỉ SELECT, trả boolean; hỏi cầu nối lương hỗ trợ thuê (rentSupportSalary)" },
  get_special_fee_prices_v1: { groups: ["salary"], reason: "chỉ SELECT; bảng giá phí đặc biệt ở quyết toán (useSpecialFeePrices)" },
  get_period_fee_status: { groups: ["salary"], reason: "chỉ SELECT; trạng thái phí kỳ ở quyết toán (usePeriodFees)" },
  get_period_commissions: { groups: ["salary"], reason: "chỉ SELECT; hoa hồng kỳ ở quyết toán (useContractSettlement)" },
  personal_finance_bootstrap: {
    groups: ["personalFinance"],
    reason: "GHI THẬT (tạo ví mặc định lần đầu, idempotent); app gọi khi mở /finance/personal-wallet; chỉ spec personal-finance-real (spec ghi trên TEST) dùng nhóm này",
  },
};

/**
 * Tên không có trong rpc-surface (bề mặt chỉ ghi RPC web đang gọi) nên không đọc được volatility
 * ở đó. Trình duyệt không gửi chúng; giữ vì danh sách cũ hoặc tên cũ của hàm dùng chung.
 */
const NOT_IN_SURFACE = {
  can_access_building: "helper RLS SQL, web không gọi thẳng; danh sách SHELL cũ",
  accessible_building_ids: "helper RLS SQL, web không gọi thẳng; danh sách SHELL cũ",
  customer_location_ids_v1: "helper STABLE của customer_list_v1 (20261017115708), web không gọi thẳng",
  customer_search_patterns_v1: "helper IMMUTABLE của customer_list_v1 (20261017115708), web không gọi thẳng",
  get_contract_stats: "tên cũ trước contract_stats_v2; isContractStatsRead còn nhận",
  invoice_active_payment_methods: "đọc của màn hoá đơn cũ; danh sách dashboard/invoices cũ",
  invoice_payment_method_drilldown: "STABLE ở 20260721102000; web không còn gọi thẳng",
  get_finance_v2_client_flags_v1: "đọc cờ thu chi v2 cũ; danh sách incomeExpense cũ",
  get_finance_v2_routes_v1: "đọc tuyến thu chi v2 cũ; danh sách incomeExpense cũ",
  list_my_cashbook_access_v2: "đọc quyền sổ quỹ cũ; danh sách incomeExpense cũ",
  get_my_cashbook_access_v2: "đọc quyền sổ quỹ cũ; danh sách incomeExpense cũ",
  list_cashbooks_for_expense_v2: "đọc sổ quỹ cho phiếu chi cũ; danh sách incomeExpense cũ",
  get_income_expense_stats: "đọc thống kê thu chi cũ; danh sách incomeExpense cũ",
  get_pending_approvals_count: "đếm phiếu chờ duyệt cũ; danh sách incomeExpense cũ",
  list_active_memberships_v1: "đọc thành viên cũ; danh sách incomeExpense cũ",
  list_organization_members_v2: "đọc thành viên cũ; danh sách incomeExpense cũ",
  read_authorization_catalog_v1: "đọc catalog quyền cũ; danh sách incomeExpense cũ",
  get_reservation_settlement_summary_v1: "đọc tổng quyết toán giữ chỗ cũ; danh sách deposits cũ",
  get_reservation_settlements_v1: "đọc quyết toán giữ chỗ cũ; danh sách deposits cũ",
  quote_invoice_rent_support_v1: "báo giá hỗ trợ thuê trên hoá đơn (quote_ = tính, không ghi); danh sách rent-support cũ",
};

const GROUP_CONSTS = ["SHELL", "SHARED", "PAGES"];

/**
 * Đọc tên theo nhóm từ mã nguồn module (SHELL, SHARED, PAGES.<màn>). Fail-closed: phần tử nào
 * không phải chuỗi literal (spread, biến, nối chuỗi) làm test đỏ, để không giấu tên khỏi phép kiểm.
 */
function extractAllowlistGroups(source) {
  const file = ts.createSourceFile("read-rpc-allowlist.ts", source, ts.ScriptTarget.Latest, true);
  const groups = new Map();
  const problems = [];
  const unwrap = node => {
    while (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression;
    return node;
  };
  const collectArray = (node, group) => {
    const array = unwrap(node);
    if (!ts.isArrayLiteralExpression(array)) { problems.push(`${group}: không phải mảng literal`); return; }
    const names = groups.get(group) ?? [];
    for (const element of array.elements) {
      if (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) names.push(element.text);
      else problems.push(`${group}: phần tử không phải chuỗi literal (${element.getText(file)})`);
    }
    groups.set(group, names);
  };
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && GROUP_CONSTS.includes(node.name.text) && node.initializer) {
      if (node.name.text !== "PAGES") collectArray(node.initializer, node.name.text);
      else {
        const pages = unwrap(node.initializer);
        if (!ts.isObjectLiteralExpression(pages)) problems.push("PAGES: không phải object literal");
        else for (const property of pages.properties) {
          if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
            collectArray(property.initializer, property.name.text);
          } else problems.push(`PAGES: thuộc tính không phải "màn: [...]" (${property.getText(file)})`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const name of GROUP_CONSTS.filter(n => n !== "PAGES")) if (!groups.has(name)) problems.push(`thiếu ${name}`);
  return { groups, problems };
}

const isVolatile = entry => entry.definitions.some(definition => definition.volatility === "VOLATILE");

/** Mọi vi phạm của danh sách đọc so với bề mặt RPC; rỗng là đạt. */
function allowlistViolations(groups, surfaceRpcs) {
  const violations = [];
  const seen = new Map();
  for (const [group, names] of groups) for (const name of names) seen.set(name, [...(seen.get(name) ?? []), group]);
  for (const [name, inGroups] of seen) {
    const entry = surfaceRpcs[name];
    if (!entry) {
      if (!NOT_IN_SURFACE[name]) violations.push(`${name}: không có trong rpc-surface và không khai NOT_IN_SURFACE`);
      continue;
    }
    if (NOT_IN_SURFACE[name]) violations.push(`${name}: đã có trong rpc-surface, gỡ khỏi NOT_IN_SURFACE`);
    const exception = VOLATILE_EXCEPTIONS[name];
    if (!isVolatile(entry)) {
      if (exception) violations.push(`${name}: không còn VOLATILE, gỡ khỏi VOLATILE_EXCEPTIONS`);
      continue;
    }
    if (!exception) { violations.push(`${name}: VOLATILE (có thể ghi) trong nhóm đọc ${inGroups.join(", ")}`); continue; }
    const outside = inGroups.filter(group => !exception.groups.includes(group));
    if (outside.length) violations.push(`${name}: VOLATILE, chỉ được ở ${exception.groups.join(", ")}, đang ở cả ${outside.join(", ")}`);
  }
  for (const name of Object.keys(VOLATILE_EXCEPTIONS)) if (!seen.has(name)) violations.push(`${name}: ngoại lệ thừa, không còn trong danh sách đọc`);
  for (const name of Object.keys(NOT_IN_SURFACE)) if (!seen.has(name)) violations.push(`${name}: NOT_IN_SURFACE thừa, không còn trong danh sách đọc`);
  return violations;
}

const source = readFileSync(MODULE_PATH, "utf8");
const surfaceRpcs = JSON.parse(readFileSync(SURFACE_PATH, "utf8")).rpcs;

describe("e2e fleet read-rpc-allowlist đối chiếu volatility", () => {
  const { groups, problems } = extractAllowlistGroups(source);

  it("đọc được mọi nhóm từ mã nguồn, khớp đúng tập module trả lúc chạy", () => {
    expect(problems).toEqual([]);
    const pages = [...groups.keys()].filter(group => group !== "SHELL" && group !== "SHARED");
    expect(pages.length).toBeGreaterThan(0);
    const fromSource = new Set([...groups.values()].flat());
    expect([...readRpcAllowlist(...pages)].sort()).toEqual([...fromSource].sort());
  });

  it("mỗi ngoại lệ có lý do và nhóm", () => {
    for (const [name, exception] of Object.entries(VOLATILE_EXCEPTIONS)) {
      expect(exception.reason.trim(), name).not.toBe("");
      expect(exception.groups.length, name).toBeGreaterThan(0);
    }
    for (const [name, reason] of Object.entries(NOT_IN_SURFACE)) expect(reason.trim(), name).not.toBe("");
  });

  it("không có tên VOLATILE ngoài ngoại lệ kế thừa, không có tên lạ ngoài bề mặt", () => {
    expect(allowlistViolations(groups, surfaceRpcs)).toEqual([]);
  });

  it("đột biến: tên ghi không có tiền tố bị chặn (personal_finance_mutate, release_room_sale_lock_v1)", () => {
    for (const name of ["personal_finance_mutate", "release_room_sale_lock_v1"]) {
      expect(isVolatile(surfaceRpcs[name]), name).toBe(true);
      const mutated = source.replace("personalFinance: [", `personalFinance: ['${name}', `);
      expect(mutated).not.toBe(source);
      const parsed = extractAllowlistGroups(mutated);
      expect(parsed.problems).toEqual([]);
      expect(allowlistViolations(parsed.groups, surfaceRpcs)).toEqual([`${name}: VOLATILE (có thể ghi) trong nhóm đọc personalFinance`]);
    }
  });

  it("đột biến: ngoại lệ ghi chuyển sang nhóm khác bị chặn", () => {
    const mutated = source.replace("const SHELL = [", "const SHELL = ['personal_finance_bootstrap', ");
    expect(allowlistViolations(extractAllowlistGroups(mutated).groups, surfaceRpcs))
      .toEqual(["personal_finance_bootstrap: VOLATILE, chỉ được ở personalFinance, đang ở cả SHELL"]);
  });

  it("đột biến: tên giấu sau biến/spread làm đỏ", () => {
    const mutated = source.replace("personalFinance: [", "personalFinance: [...HIDDEN, ");
    expect(extractAllowlistGroups(mutated).problems.join("\n")).toMatch(/personalFinance: phần tử không phải chuỗi literal/);
  });
});
