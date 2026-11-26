// @vitest-environment jsdom
// Khoá chống trùng do người gọi giữ cố định (trang Báo chi nhanh: `qe-<id thẻ>`), để gửi lại
// y nguyên sau một lần rớt mạng không sinh phiếu đôi. Vắng khoá ⇒ hành vi cũ (ngẫu nhiên mỗi lần).
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ rpc: vi.fn(), invalidate: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: unknown) => options,
  useQueryClient: () => ({ invalidateQueries: h.invalidate }),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: h.rpc } }));
vi.mock("@/lib/authSession", () => ({ getSessionUser: async () => ({ id: "u1", user_metadata: { full_name: "Tâm" } }) }));
vi.mock("../accountingClass", () => ({ loadIncomeExpenseAccountingClassResolver: async () => () => "OTHER" }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { isCanonicalCreateEligible, useCreateIncomeExpense } from "../mutations";
import type { CreateIncomeExpenseInput } from "../types";

type Mutation = { mutationFn: (input: CreateIncomeExpenseInput) => Promise<unknown> };

// Khoá dựng bằng template literal: dạng `key: "<chuỗi dài>"` trùng luật generic-api-key của gitleaks.
const DRAFT_ID = "0f1e2d3c-4b5a-4987-8765-43210fedcba9";
const STABLE = `qe-${DRAFT_ID}`;

const input = (over: Partial<CreateIncomeExpenseInput> = {}): CreateIncomeExpenseInput => ({
  type: "EXPENSE",
  name: "Mua bóng đèn",
  building_id: "b1",
  account_id: "a1",
  voucher_date: "2026-10-01",
  business_result_accounting: null,
  attachments: [],
  items: [{ income_expense_type_id: "t1", quantity: 1, unit_price: 120_000, start_date: "2026-10-01", end_date: "2026-10-01" }],
  ...over,
});

const argsOf = (call: unknown[]) => call[1] as Record<string, unknown>;

beforeEach(() => {
  h.rpc.mockReset();
});

describe("useCreateIncomeExpense — khoá chống trùng", () => {
  it("người gọi truyền khoá ⇒ create_income_expense_v1 nhận ĐÚNG khoá đó", async () => {
    h.rpc.mockResolvedValueOnce({ data: { id: "v1", code: "PC01" }, error: null });
    await (useCreateIncomeExpense() as unknown as Mutation).mutationFn(input({ idempotency_key: STABLE }));
    expect(h.rpc.mock.calls[0][0]).toBe("create_income_expense_v1");
    expect(argsOf(h.rpc.mock.calls[0]).p_idempotency_key).toBe(STABLE);
  });

  it("không truyền khoá ⇒ vẫn sinh khoá ngẫu nhiên như cũ, mỗi lần một khác", async () => {
    h.rpc.mockResolvedValue({ data: { id: "v1", code: "PC01" }, error: null });
    const m = useCreateIncomeExpense() as unknown as Mutation;
    await m.mutationFn(input());
    await m.mutationFn(input());
    const [a, b] = h.rpc.mock.calls.map((c) => argsOf(c).p_idempotency_key as string);
    expect(a).toMatch(/^ie-create-[0-9a-f-]{36}$/);
    expect(b).not.toBe(a);
  });

  it("đợt 10a: rơi sang compat ⇒ ie_compat_insert_keyed_v1 nhận ĐÚNG khoá đó (p_request_key), khoá KHÔNG lọt vào p_row", async () => {
    h.rpc
      .mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "not found" } })
      .mockResolvedValueOnce({ data: { id: "v2" }, error: null });
    await (useCreateIncomeExpense() as unknown as Mutation).mutationFn(input({ idempotency_key: STABLE }));
    expect(h.rpc.mock.calls[1][0]).toBe("ie_compat_insert_keyed_v1");
    expect(argsOf(h.rpc.mock.calls[1]).p_request_key).toBe(STABLE);
    expect(Object.keys(argsOf(h.rpc.mock.calls[1]).p_row as object)).not.toContain("idempotency_key");
  });

  it("đợt 10a: không có khoá ⇒ compat vẫn đi ie_compat_insert_v2 như cũ, không p_request_key", async () => {
    h.rpc.mockResolvedValueOnce({ data: { id: "v3" }, error: null });
    await (useCreateIncomeExpense() as unknown as Mutation).mutationFn(input({ repeat_cycle: "MONTH", repeat_count: 2 }));
    expect(h.rpc.mock.calls[0][0]).toBe("ie_compat_insert_v2");
    expect(Object.keys(argsOf(h.rpc.mock.calls[0]))).toEqual(["p_row", "p_items"]);
  });

  it("đợt 10a: compat có khoá báo khoá đã dùng (đường chính đã lập / nội dung khác) ⇒ báo đã lập ở lần trước kèm mã phiếu", async () => {
    const used = "11111111-2222-4333-8444-555555555555";
    const m = useCreateIncomeExpense() as unknown as Mutation;
    for (const hint of ["ie_request_key_used_by_canonical", "ie_request_key_payload_mismatch"]) {
      h.rpc.mockReset();
      h.rpc.mockResolvedValueOnce({ data: null, error: { code: "23505", message: "Mã yêu cầu đã dùng", details: used, hint } });
      const err = await m
        .mutationFn(input({ repeat_cycle: "MONTH", repeat_count: 2, idempotency_key: STABLE })).catch((e: unknown) => e);
      expect(err).toMatchObject({ alreadyRecorded: true, recordIds: [used] });
      expect(h.rpc).toHaveBeenCalledTimes(1);
    }
  });

  it("lỗi của CHÍNH lời gọi compat mang nhãn đường compat (người gọi không được gửi lại mà KHÔNG giữ khoá)", async () => {
    const net = { code: "", message: "TypeError: Failed to fetch", details: "", hint: "" };
    h.rpc
      .mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "not found" } })
      .mockResolvedValueOnce({ data: null, error: net });
    await expect(
      (useCreateIncomeExpense() as unknown as Mutation).mutationFn(input({ idempotency_key: STABLE })),
    ).rejects.toMatchObject({ ieCreatePath: "compat" });
  });

  it("lỗi ở đường canonical (có khoá) KHÔNG mang nhãn compat", async () => {
    const net = { code: "", message: "TypeError: Failed to fetch", details: "", hint: "" };
    h.rpc.mockResolvedValueOnce({ data: null, error: net });
    const err = await (useCreateIncomeExpense() as unknown as Mutation)
      .mutationFn(input({ idempotency_key: STABLE }))
      .catch((e: unknown) => e);
    expect((err as { ieCreatePath?: string }).ieCreatePath).toBeUndefined();
  });

  it("23505 (cùng khoá, khác nội dung) là lỗi thật, KHÔNG rơi sang đường compat", async () => {
    const err = { code: "23505", message: "duplicate key value violates unique constraint" };
    h.rpc.mockResolvedValueOnce({ data: null, error: err });
    await expect(
      (useCreateIncomeExpense() as unknown as Mutation).mutationFn(input({ idempotency_key: STABLE })),
    ).rejects.toBe(err);
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });
});

describe("isCanonicalCreateEligible", () => {
  it("phiếu thường đủ kỳ, ảnh https ⇒ đi đường canonical", () => {
    expect(isCanonicalCreateEligible(input({ attachments: ["https://cdn.test/a.jpg"] }))).toBe(true);
  });

  it("phiếu lặp, dòng thiếu kỳ, ảnh không https ⇒ không canonical", () => {
    expect(isCanonicalCreateEligible(input({ repeat_cycle: "MONTH", repeat_count: 2 }))).toBe(false);
    expect(isCanonicalCreateEligible(input({ items: [{ ...input().items[0], start_date: "" }] }))).toBe(false);
    expect(isCanonicalCreateEligible(input({ attachments: ["blob:x"] }))).toBe(false);
  });
});
