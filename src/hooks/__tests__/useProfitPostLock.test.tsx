// @vitest-environment jsdom
// Lớp hook của "phát sinh sau chốt" (rà 21/10 F06, chủ chốt 22/10/2026): gọi đúng RPC + tham số,
// Báo cáo LN tách khoản sau chốt khỏi tổng tháng đã chốt, lỗi tải thì KHÔNG tách mà cảnh báo.
// Số tiền / mã giả.
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: state.rpc } }));

import { useProfitLockedMonthsForForm, useProfitPostLockReport } from "@/hooks/useProfitPostLock";

const A = "00000000-0000-4000-8000-000000000011";
const V1 = "00000000-0000-4000-8000-000000000101";
const V2 = "00000000-0000-4000-8000-000000000102";

const goi = {
  from: "2025-08-01",
  to: "2025-08-01",
  locked: [{ building_id: A, building_name: "Toà A", month: "2025-08-01", locked_at: "2025-09-03T03:00:00+00:00" }],
  after_lock: [
    {
      voucher_id: V1, building_id: A, building_name: "Toà A", month: "2025-08-01",
      locked_at: "2025-09-03T03:00:00+00:00", code: "PT0001", name: "Thu HĐ T8", restricted: false,
      voucher_date: "2025-09-10", type: "INCOME", invoice_month: "2025-08", period_from: null, period_to: null,
      income: 300, expense: 0, created_at: "2025-09-10T03:00:00+00:00", approved_at: "2025-09-10T03:00:00+00:00",
    },
  ],
};

const row = (voucherId: string, income: number, expense: number, approvalStatus: "APPROVED" | "UNAPPROVED" = "APPROVED") => ({
  itemId: `${voucherId}:i`, voucherId, buildingId: A, income, expense, approvalStatus,
});
const accrual = {
  totalIncome: 1300, totalExpense: 400, difference: 900,
  rows: [row(V1, 300, 0), row(V2, 1000, 0), row("v3", 0, 400, "UNAPPROVED")],
  pendingIncome: 0, pendingExpense: 400, pendingCount: 1,
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => state.rpc.mockReset());
afterEach(cleanup);

describe("useProfitPostLockReport", () => {
  it("gọi profit_post_lock_vouchers_v1 đúng tháng + toà, tách khoản sau chốt khỏi tổng", async () => {
    state.rpc.mockResolvedValue({ data: goi, error: null });
    const { result } = renderHook(
      () => useProfitPostLockReport({ ym: "2025-08", buildingIds: [A], accrual, enabled: true }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.count).toBe(1));
    expect(state.rpc).toHaveBeenCalledWith("profit_post_lock_vouchers_v1", {
      p_from: "2025-08-01", p_to: "2025-08-01", p_building_ids: [A],
    });
    expect(result.current.accrual?.totalIncome).toBe(1000);
    expect(result.current.accrual?.totalExpense).toBe(400);
    expect(result.current.accrual?.rows.map((r) => r.voucherId)).toEqual([V2, "v3"]);
    expect(result.current.accrual?.pendingCount).toBe(1);
    expect(result.current).toMatchObject({ income: 300, expense: 0, isError: false, isLoading: false });
    expect(result.current.engineExclusions).toMatchObject({ count: 1, income: 300, expense: 0 });
    expect(result.current.warnings[0]).toContain("1 khoản phát sinh sau chốt");
  });

  it("RPC lỗi ⇒ không tách (tổng như cũ), engine không trừ, có cảnh báo", async () => {
    state.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "not found" } });
    const { result } = renderHook(
      () => useProfitPostLockReport({ ym: "2025-08", buildingIds: [A], accrual, enabled: true }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.accrual).toBe(accrual);
    expect(result.current.engineExclusions.count).toBe(0);
    expect(result.current.warnings[0]).toMatch(/Chưa tải được khoản phát sinh sau chốt/);
  });

  it("tắt (chế độ theo ngày phiếu) ⇒ không gọi RPC, trả nguyên bản", () => {
    const { result } = renderHook(
      () => useProfitPostLockReport({ ym: "2025-08", buildingIds: [A], accrual, enabled: false }),
      { wrapper },
    );
    expect(state.rpc).not.toHaveBeenCalled();
    expect(result.current.accrual).toBe(accrual);
    expect(result.current.warnings).toEqual([]);
  });
});

describe("useProfitLockedMonthsForForm", () => {
  it("hỏi khoảng tháng phiếu chạm tới, toà không trùng; khoảng quá 36 tháng ⇒ không hỏi", async () => {
    state.rpc.mockResolvedValue({ data: goi, error: null });
    const { result } = renderHook(
      () => useProfitLockedMonthsForForm({ buildingIds: [A, A, null], months: ["2025-09-01", "2025-08-01"], enabled: true }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(state.rpc).toHaveBeenCalledWith("profit_post_lock_vouchers_v1", {
      p_from: "2025-08-01", p_to: "2025-09-01", p_building_ids: [A],
    });
    state.rpc.mockClear();
    renderHook(
      () => useProfitLockedMonthsForForm({ buildingIds: [A], months: ["2020-01-01", "2025-08-01"], enabled: true }),
      { wrapper },
    );
    renderHook(() => useProfitLockedMonthsForForm({ buildingIds: [null], months: ["2025-08-01"], enabled: true }), { wrapper });
    expect(state.rpc).not.toHaveBeenCalled();
  });
});
