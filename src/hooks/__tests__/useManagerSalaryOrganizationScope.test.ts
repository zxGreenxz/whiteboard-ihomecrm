import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateSalaryLockOrganization, type SalaryLockSubject } from "@/lib/salaryOrganization";

const database = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: database }));

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
});


describe("salary lock batch preflight", () => {
  const orgA = "dddd0000-0000-4000-8000-000000000001";
  const orgB = "cccc0000-0000-4000-8000-000000000001";
  type Manager = SalaryLockSubject;
  const manager = (id: string, voucherId?: string): Manager => ({
    id, commissionItems: voucherId ? [{ voucherId }] : [],
  });
  function replies(values: Array<{ data: unknown; error: unknown }>) {
    database.from.mockImplementation(() => {
      const response = values.shift();
      if (!response) throw new Error("Unexpected database call");
      const chain = { select: vi.fn(), eq: vi.fn(), in: vi.fn(), maybeSingle: vi.fn() };
      chain.select.mockReturnValue(chain);
      chain.eq.mockReturnValue(chain);
      chain.in.mockResolvedValue(response);
      chain.maybeSingle.mockResolvedValue(response);
      return chain;
    });
  }
  beforeEach(() => { database.from.mockReset(); });

  it("rejects mixed persisted salary companies before touching commission vouchers", async () => {
    replies([{ data: { organization_id: orgA }, error: null }, { data: { organization_id: orgB }, error: null }]);
    await expect(validateSalaryLockOrganization([manager("one", "voucher"), manager("two")], "2026-09-01")).rejects.toThrow("cùng một công ty");
    expect(database.from.mock.calls.map(([table]) => table)).toEqual(["salary_monthly", "salary_monthly"]);
  });

  it.each([
    { vouchers: [] },
    { vouchers: [{ id: "voucher", organization_id: orgB }] },
    { vouchers: [{ id: "voucher", organization_id: null }] },
  ])("rejects missing or foreign commission evidence: %j", async ({ vouchers }) => {
    replies([{ data: { organization_id: orgA }, error: null }, { data: vouchers, error: null }]);
    await expect(validateSalaryLockOrganization([manager("one", "voucher")], "2026-09-01")).rejects.toThrow("Phiếu hoa hồng");
  });

  it("returns one proven company and unique voucher ids without writing", async () => {
    replies([
      { data: { organization_id: orgA }, error: null },
      { data: { organization_id: orgA }, error: null },
      { data: [{ id: "voucher", organization_id: orgA }], error: null },
    ]);
    await expect(validateSalaryLockOrganization([manager("one", "voucher"), manager("two", "voucher")], "2026-09-01"))
      .resolves.toEqual({ organizationId: orgA, commVoucherIds: ["voucher"] });
  });

  it("does not turn a denied read into an empty successful check", async () => {
    const denied = new Error("permission denied");
    replies([{ data: { organization_id: orgA }, error: null }, { data: null, error: denied }]);
    await expect(validateSalaryLockOrganization([manager("one", "voucher")], "2026-09-01")).rejects.toBe(denied);
  });
});
