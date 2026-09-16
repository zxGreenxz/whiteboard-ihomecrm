import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../useManagerSalary.ts", import.meta.url),
  "utf8",
);

describe("useManagerSalary legacy fallback organization scope", () => {
  it("resolves and creates salary expense types inside the voucher organization", () => {
    expect(source).toMatch(
      /from\("buildings"\)[\s\S]+?\.eq\("user_id", input\.ownerId\)[\s\S]+?\.eq\("is_virtual", true\)/,
    );
    expect(source).toMatch(/const organizationId\s*=/);
    expect(source).toMatch(/\.eq\("organization_id", organizationId\)/);
    expect(source).toMatch(/organization_id:\s*organizationId/);
  });

  it("keeps rent-offset income types and items inside the invoice organization", () => {
    expect(source).toMatch(/const rentOrganizationId\s*=/);
    expect(source).toMatch(/\.eq\("organization_id", rentOrganizationId\)/);
    expect(source.match(/organization_id:\s*rentOrganizationId/g)?.length).toBeGreaterThanOrEqual(2);
  });

  // Plan I3: trigger payments chuyển sang autofill_org_strict. Payment khấu trừ
  // lương có invoice_id nên vẫn suy được, nhưng gửi tường minh org của HOÁ ĐƠN
  // là nguồn đúng hơn org đang chọn — cùng nguồn với phiếu thu đi kèm.
  it("payment khấu trừ lương gửi organization_id của hoá đơn, không để trigger suy", () => {
    expect(source).toMatch(
      /from\("payments"\)\s*\.insert\(\{\s*user_id: invOwner,\s*organization_id: rentOrganizationId,/,
    );
  });

  it("dòng phiếu chi lương đi qua withOrgAll với org của phiếu", () => {
    expect(source).toMatch(/from\("income_expense_items"\)\s*\.insert\(withOrgAll\(salItems, organizationId\)\)/);
  });
});
