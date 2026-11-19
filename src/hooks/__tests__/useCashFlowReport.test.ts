// @vitest-environment jsdom
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

import { useCashFlowReport } from "../useCashFlowReport";

function query(year = 2026, buildingId?: string, options?: { enabled?: boolean }) {
  return renderHook(() => useCashFlowReport(year, buildingId, options)).result.current as unknown as {
    queryKey: unknown[];
    enabled: boolean;
    queryFn: () => Promise<unknown>;
  };
}
const row = {
  organization_id: "org-a", building_id: "building-a", period: "2026-07",
  income: 120, expense: 20, net: 100,
};

beforeEach(() => {
  h.organizationId = "org-a";
  h.getSessionUser.mockReset().mockResolvedValue({ id: "user-a" });
  const builder = { order: h.order, range: h.range };
  h.rpc.mockReset().mockReturnValue(builder);
  h.order.mockReset().mockReturnValue(builder);
  h.range.mockReset().mockResolvedValue({ data: [], error: null });
});

describe("useCashFlowReport", () => {
  it("passes the selected organization and building filter to the external cash-flow RPC", async () => {
    await query(2026, "building-a").queryFn();
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith("cashbook_cash_flow_v1", {
      p_organization_id: "org-a", p_year: 2026, p_building_ids: ["building-a"],
    });
  });

  it("isolates organization, year and building caches while retaining existing invalidation", () => {
    const first = query();
    expect(first.queryKey).toEqual(["cash-flow-by-day", "external-cash-flow", "org-a", 2026, undefined, "ready"]);
    h.organizationId = "org-b";
    expect(query().queryKey).not.toEqual(first.queryKey);
    h.organizationId = "org-a";
    expect(query(2025).queryKey).not.toEqual(first.queryKey);
    expect(query(2026, "building-a").queryKey).not.toEqual(first.queryKey);
  });

  it("does not fall back to another organization when none is selected", async () => {
    h.organizationId = null;
    expect(query().enabled).toBe(false);
    await expect(query().queryFn()).rejects.toThrow("Chưa chọn tổ chức");
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("waits for building selection validation even if explicitly refetched", async () => {
    const pending = query(2026, undefined, { enabled: false });
    expect(pending.enabled).toBe(false);
    expect(pending.queryKey).not.toEqual(query().queryKey);
    await expect(pending.queryFn()).rejects.toThrow("Chưa xác nhận được tòa nhà");
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("preserves authentication and source failures instead of presenting zero", async () => {
    h.getSessionUser.mockResolvedValueOnce(null);
    await expect(query().queryFn()).rejects.toThrow("Not authenticated");
    expect(h.rpc).not.toHaveBeenCalled();
    const error = { code: "42501", message: "denied" };
    h.range.mockResolvedValueOnce({ data: null, error });
    await expect(query().queryFn()).rejects.toBe(error);
  });

  it("normalizes money in month and quarter rows without dropping confirmed zeroes", async () => {
    h.range.mockResolvedValueOnce({ data: [
      { ...row, income: "120", expense: "20", net: "100" },
      { ...row, period: "2026-Q3", income: 0, expense: 0, net: 0 },
    ], error: null });
    expect(await query().queryFn()).toEqual([row, { ...row, period: "2026-Q3", income: 0, expense: 0, net: 0 }]);
  });

  it.each([null, undefined, {}])("rejects missing or malformed source %j", async (data) => {
    h.range.mockResolvedValueOnce({ data, error: null });
    await expect(query().queryFn()).rejects.toThrow();
  });

  it.each([
    { organization_id: "org-demo" },
    { period: "2025-07" },
    { period: "2026-00" },
    { period: "2026-13" },
    { period: "2026-Q5" },
    { period: null },
    { income: null },
    { expense: "" },
    { net: NaN },
    { income: Infinity },
  ])("rejects wrong scope or malformed financial values %j", async (change) => {
    h.range.mockResolvedValueOnce({ data: [{ ...row, ...change }], error: null });
    await expect(query().queryFn()).rejects.toThrow();
  });

  it("rejects a building outside the requested filter and repeated aggregate rows", async () => {
    h.range.mockResolvedValueOnce({ data: [{ ...row, building_id: "building-b" }], error: null });
    await expect(query(2026, "building-a").queryFn()).rejects.toThrow("phạm vi");
    h.range.mockResolvedValueOnce({ data: [row, row], error: null });
    await expect(query().queryFn()).rejects.toThrow("trùng");
  });

  it.each([NaN, Infinity, 2026.5, 1999, 2101])("rejects an invalid persisted year %s", async (year) => {
    await expect(query(year).queryFn()).rejects.toThrow("Năm báo cáo");
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("reads all 16 periods for more than 62 buildings past the server's 1000-row cap", async () => {
    const rows = Array.from({ length: 64 }, (_, building) => (
      Array.from({ length: 16 }, (_, period) => ({
        ...row,
        building_id: `building-${String(building).padStart(3, "0")}`,
        period: period < 12 ? `2026-${String(period + 1).padStart(2, "0")}` : `2026-Q${period - 11}`,
      }))
    )).flat();
    h.range.mockImplementation(async (from: number, to: number) => ({
      data: rows.slice(from, Math.min(to + 1, from + 1000)), error: null,
    }));
    expect(await query().queryFn()).toEqual(rows);
    expect(h.range.mock.calls).toEqual([[0, 999], [1000, 1999], [1024, 2023]]);
    expect(h.order.mock.calls).toEqual(Array.from({ length: 3 }, () => [
      ["building_id", { ascending: true, nullsFirst: true }],
      ["period", { ascending: true }],
    ]).flat());
  });

  it("continues after a short page until the server confirms an empty page", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({ ...row, building_id: `building-${index}` }));
    h.range.mockImplementation(async (from: number) => ({ data: rows.slice(from, from + 2), error: null }));
    expect(await query().queryFn()).toEqual(rows);
    expect(h.range.mock.calls).toEqual([[0, 999], [2, 1001], [4, 1003], [5, 1004]]);
  });

  it("throws the original second-page error instead of returning incomplete totals", async () => {
    const error = { code: "42501", message: "second page denied" };
    h.range.mockResolvedValueOnce({ data: [row], error: null }).mockResolvedValueOnce({ data: null, error });
    await expect(query().queryFn()).rejects.toBe(error);
    expect(h.range.mock.calls).toEqual([[0, 999], [1, 1000]]);
  });

  it("rejects duplicate aggregate rows across page boundaries", async () => {
    h.range.mockResolvedValueOnce({ data: [row], error: null }).mockResolvedValueOnce({ data: [row], error: null });
    await expect(query().queryFn()).rejects.toThrow("trùng");
    expect(h.range.mock.calls).toEqual([[0, 999], [1, 1000], [2, 1001]]);
  });
});
