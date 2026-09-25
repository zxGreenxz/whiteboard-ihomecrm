// @vitest-environment jsdom
// Mở khoá tháng đã chốt lợi nhuận đi `profit_unlock_v2` — có lý do, có vết
// (profit_close_runs + profit_close_revisions). Chủ chốt 25/09/2026: "Mở khoá
// tháng phải ghi lý do (lưu lại)". Đường mở khoá v1 cũ không lý do đã bỏ.
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  goiHam: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: state.toastSuccess, error: state.toastError, info: vi.fn() },
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: state.goiHam } }));
// Hook mở khoá không đụng tới danh sách toà; thay để khỏi kéo cả cây hook toà nhà.
vi.mock("@/hooks/useBuildings", () => ({ useBuildings: () => ({ data: [] }) }));

import {
  unlockProfitMonthErrorMessage,
  useUnlockProfitMonth,
  type UnlockProfitMonthInput,
} from "@/hooks/useShareholderProfit";

const ORG = "dddd0000-0000-4000-8000-000000000001";
const B1 = "bbbb0000-0000-4000-8000-000000000001";
const B2 = "bbbb0000-0000-4000-8000-000000000002";
const LY_DO = "Sửa phiếu PC2607001 nhập sai số tiền";

function dungHook() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useUnlockProfitMonth(), { wrapper });
}

const dauVao = (over: Partial<UnlockProfitMonthInput> = {}): UnlockProfitMonthInput => ({
  organizationId: ORG,
  periodMonth: "2026-07-01",
  buildingIds: [B1],
  reason: LY_DO,
  ...over,
});

afterEach(() => {
  cleanup();
  state.goiHam.mockReset();
  state.toastSuccess.mockReset();
  state.toastError.mockReset();
});

describe("useUnlockProfitMonth — mở khoá có lý do qua profit_unlock_v2", () => {
  it("gọi profit_unlock_v2 đúng tham số: tổ chức, kỳ YYYY-MM-01, lý do đã cắt khoảng trắng, khoá idempotency mới, tập nhà không trùng", async () => {
    state.goiHam.mockResolvedValue({
      data: { run_id: "run-1", operation: "UNLOCK", affected_buildings: 2, idempotent_replay: false },
      error: null,
    });
    const { result } = dungHook();
    let ketQua: unknown;
    await act(async () => {
      ketQua = await result.current.mutateAsync(
        dauVao({ buildingIds: [B2, B1, B2], reason: `   ${LY_DO}  ` }),
      );
    });

    expect(state.goiHam).toHaveBeenCalledTimes(1);
    const [ten, thamSo] = state.goiHam.mock.calls[0] ?? [];
    expect(ten).toBe("profit_unlock_v2");
    expect(thamSo).toEqual({
      p_organization_id: ORG,
      p_period_month: "2026-07-01",
      p_reason: LY_DO,
      p_idempotency_key: expect.stringMatching(/^profit-unlock-[0-9a-f-]{36}$/),
      p_building_ids: [B1, B2],
    });
    // Không gửi CAS source hash: mỗi nhà một hash, một hash chung là chắc lệch.
    expect(thamSo).not.toHaveProperty("p_expected_source_hash");
    expect(ketQua).toEqual({ run_id: "run-1", affected_buildings: 2, idempotent_replay: false });

    const loiBao = String(state.toastSuccess.mock.calls[0]?.[0] ?? "");
    expect(loiBao).toContain("Đã mở khoá 2 toà tháng 07/2026");
    expect(loiBao).toContain("Phần đã phân bổ cho cổ đông đã bị xoá, PHẢI chốt lại sau khi sửa xong.");
  });

  it("mỗi lượt gửi một khoá idempotency khác nhau", async () => {
    state.goiHam.mockResolvedValue({ data: { affected_buildings: 1 }, error: null });
    const { result } = dungHook();
    await act(async () => {
      await result.current.mutateAsync(dauVao());
      await result.current.mutateAsync(dauVao());
    });
    const khoa = state.goiHam.mock.calls.map(
      (call) => (call[1] as { p_idempotency_key: string }).p_idempotency_key,
    );
    expect(khoa).toHaveLength(2);
    expect(khoa[0]).not.toBe(khoa[1]);
  });

  it.each([
    ["rỗng", ""],
    ["chỉ có khoảng trắng", "          "],
    ["7 ký tự sau khi cắt khoảng trắng", "   1234567   "],
    ["quá 1000 ký tự", "x".repeat(1001)],
  ])("từ chối lý do %s ngay ở client, không gọi máy chủ", async (_nhan, reason) => {
    const { result } = dungHook();
    await act(async () => {
      await expect(result.current.mutateAsync(dauVao({ reason }))).rejects.toThrow(
        "Lý do mở khoá phải có 8–1000 ký tự",
      );
    });
    expect(state.goiHam).not.toHaveBeenCalled();
    expect(state.toastError).toHaveBeenCalledWith("Lý do mở khoá phải có 8–1000 ký tự");
  });

  it("đúng 8 ký tự (sau khi cắt) là đủ", async () => {
    state.goiHam.mockResolvedValue({ data: { affected_buildings: 1 }, error: null });
    const { result } = dungHook();
    await act(async () => {
      await result.current.mutateAsync(dauVao({ reason: "  12345678  " }));
    });
    expect((state.goiHam.mock.calls[0]?.[1] as { p_reason: string }).p_reason).toBe("12345678");
  });

  const thieuDauVao: Array<[string, Partial<UnlockProfitMonthInput>, string]> = [
    ["thiếu tổ chức", { organizationId: "" }, "Không xác định được tổ chức"],
    ["không có nhà nào", { buildingIds: [] }, "Không có toà nào đang khoá để mở"],
    ["kỳ không phải ngày đầu tháng", { periodMonth: "2026-07-15" }, "Kỳ mở khoá phải là ngày đầu tháng"],
  ];
  it.each(thieuDauVao)("%s thì không gọi máy chủ", async (_nhan, over, loi) => {
    const { result } = dungHook();
    await act(async () => {
      await expect(result.current.mutateAsync(dauVao(over))).rejects.toThrow(loi);
    });
    expect(state.goiHam).not.toHaveBeenCalled();
  });

  it("lỗi máy chủ đã biết được nói bằng tiếng Việt", async () => {
    state.goiHam.mockResolvedValue({
      data: null,
      error: { message: "UNLOCK requires LOCKED current snapshots", code: "55000" },
    });
    const { result } = dungHook();
    await act(async () => {
      await expect(result.current.mutateAsync(dauVao())).rejects.toMatchObject({ code: "55000" });
    });
    expect(state.toastSuccess).not.toHaveBeenCalled();
    expect(String(state.toastError.mock.calls[0]?.[0] ?? "")).toContain(
      "không còn ở trạng thái Đã chốt",
    );
  });
});

describe("unlockProfitMonthErrorMessage", () => {
  it("dịch các lỗi profit_unlock_v2 người dùng có thể gặp", () => {
    expect(unlockProfitMonthErrorMessage("reason must contain 8..1000 characters")).toBe(
      "Lý do mở khoá phải có 8–1000 ký tự",
    );
    expect(
      unlockProfitMonthErrorMessage("Every requested building must have a current period snapshot"),
    ).toContain("chưa có bản chốt");
    expect(
      unlockProfitMonthErrorMessage("Unlock permission does not cover every requested building"),
    ).toContain("không có quyền mở khoá");
    expect(unlockProfitMonthErrorMessage("Permission denied: shareholder_profit.unlock")).toContain(
      "không có quyền mở khoá",
    );
  });

  it("lỗi lạ giữ nguyên văn; không có câu thì có câu mặc định", () => {
    expect(unlockProfitMonthErrorMessage("Active organization membership required")).toBe(
      "Active organization membership required",
    );
    expect(unlockProfitMonthErrorMessage(undefined)).toBe("Không thể mở khoá tháng");
  });
});
