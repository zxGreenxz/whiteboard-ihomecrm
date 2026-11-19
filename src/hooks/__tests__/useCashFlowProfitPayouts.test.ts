// @vitest-environment jsdom
// Cột "Trong đó: chi chia lợi nhuận" (D2.12): cùng công ty / năm / toà / kỳ với báo cáo dòng tiền, đọc chặt
// (thiếu số ⇒ lỗi, không hiện 0), gộp tháng bỏ dòng quý của máy chủ.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  order: vi.fn(),
  range: vi.fn(),
  getSessionUser: vi.fn(),
  organizationId: "org-a" as string | null,
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: (options: unknown) => options }));
vi.mock("@/contexts/OrganizationContext", () => ({
  useOrganization: () => ({ selectedOrganizationId: h.organizationId }),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: h.rpc } }));
vi.mock("@/lib/authSession", () => ({ getSessionUser: h.getSessionUser }));

import { monthlyProfitPayouts, readCashFlowProfitPayoutRows, useCashFlowProfitPayouts } from "../useCashFlowProfitPayouts";

type Options = { queryKey: unknown[]; enabled: boolean; queryFn: () => Promise<unknown>; retry: (n: number, e: unknown) => boolean };
function query(year = 2026, buildingId?: string, options?: { enabled?: boolean }) {
  return renderHook(() => useCashFlowProfitPayouts(year, buildingId, options)).result.current as unknown as Options;
}
const row = (period: string, shareholder: unknown, manager: unknown, building: string | null = null) => ({
  organization_id: "org-a", building_id: building, period, shareholder_payout: shareholder, manager_payout: manager,
});

beforeEach(() => {
  h.organizationId = "org-a";
  h.getSessionUser.mockReset().mockResolvedValue({ id: "user-a" });
  const builder = { order: h.order, range: h.range };
  h.rpc.mockReset().mockReturnValue(builder);
  h.order.mockReset().mockReturnValue(builder);
  h.range.mockReset().mockResolvedValue({ data: [], error: null });
});

describe("useCashFlowProfitPayouts", () => {
  it("gọi đúng hàm với công ty đang chọn, năm và toà; khoá dưới gốc cash-flow-by-day", async () => {
    const options = query(2026, "building-a");
    expect(options.queryKey).toEqual(["cash-flow-by-day", "profit-payout", "org-a", 2026, "building-a"]);
    await options.queryFn();
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith("cashbook_cash_flow_profit_payout_v1", {
      p_organization_id: "org-a", p_year: 2026, p_building_ids: ["building-a"],
    });
    await query(2026).queryFn();
    expect(h.rpc).toHaveBeenLastCalledWith("cashbook_cash_flow_profit_payout_v1", { p_organization_id: "org-a", p_year: 2026, p_building_ids: undefined });
  });

  it("không có công ty / bị tắt ⇒ không gọi; 42501 không thử lại, máy chủ bận thì thử lại một lần", async () => {
    expect(query(2026, undefined, { enabled: false }).enabled).toBe(false);
    h.organizationId = null;
    expect(query().enabled).toBe(false);
    await expect(query().queryFn()).rejects.toThrow("Chưa chọn tổ chức");
    expect(h.rpc).not.toHaveBeenCalled();
    const { retry } = query();
    expect(retry(0, { code: "42501", message: "cash_flow_profit_denied" })).toBe(false);
    expect(retry(0, { code: "40001", message: "busy" })).toBe(true);
    expect(retry(1, { code: "40001", message: "busy" })).toBe(false);
  });

  it("lỗi nguồn giữ nguyên (không trả rỗng)", async () => {
    h.range.mockResolvedValue({ data: null, error: { code: "42501", message: "cash_flow_profit_denied" } });
    await expect(query().queryFn()).rejects.toMatchObject({ code: "42501" });
  });
});

describe("readCashFlowProfitPayoutRows", () => {
  const ctx = { organizationId: "org-a", year: 2026 };
  it("đọc số dạng chuỗi numeric; giữ chuỗi toàn công ty (toà null)", () => {
    expect(readCashFlowProfitPayoutRows([row("2026-07", "1500000.00", "0")], ctx)).toEqual([
      { organization_id: "org-a", building_id: null, period: "2026-07", shareholder_payout: 1500000, manager_payout: 0 },
    ]);
  });
  it.each([
    ["thiếu số", [row("2026-07", null, 0)]],
    ["số rác", [row("2026-07", "abc", 0)]],
    ["số âm", [row("2026-07", -1, 0)]],
    ["sai công ty", [{ ...row("2026-07", 1, 0), organization_id: "org-b" }]],
    ["sai năm", [row("2025-07", 1, 0)]],
    ["kỳ lạ", [row("2026-13", 1, 0)]],
    ["trùng kỳ", [row("2026-07", 1, 0), row("2026-07", 2, 0)]],
    ["không phải mảng", null],
  ])("%s ⇒ lỗi, không hiện 0", (_label, data) => {
    expect(() => readCashFlowProfitPayoutRows(data as unknown[] | null, ctx)).toThrow(TypeError);
  });
  it("có toà ⇒ dòng phải đúng toà đó", () => {
    expect(() => readCashFlowProfitPayoutRows([row("2026-07", 1, 0, "building-b")], { ...ctx, buildingId: "building-a" })).toThrow(TypeError);
    expect(readCashFlowProfitPayoutRows([row("2026-07", 1, 0, "building-a")], { ...ctx, buildingId: "building-a" })).toHaveLength(1);
  });
});

describe("monthlyProfitPayouts", () => {
  it("cộng cổ đông + lương điều hành theo tháng qua các toà, bỏ dòng quý của máy chủ", () => {
    const months = monthlyProfitPayouts(readCashFlowProfitPayoutRows([
      row("2026-07", 100, 20, "building-a"), row("2026-07", 5, 0, "building-b"), row("2026-08", 0, 7, "building-a"),
      row("2026-Q3", 999, 999, "building-a"),
    ], { organizationId: "org-a", year: 2026 }));
    expect(months).toHaveLength(12);
    expect(months[6]).toBe(125);
    expect(months[7]).toBe(7);
    expect(months.reduce((s, v) => s + v, 0)).toBe(132);
  });
});
