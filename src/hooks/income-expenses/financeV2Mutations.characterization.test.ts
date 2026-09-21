import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  invalidateQueries: vi.fn(),
  useMutation: vi.fn((options: unknown) => options),
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: mocks.useMutation,
  useQuery: vi.fn((options: unknown) => options),
  useQueryClient: vi.fn(() => ({ invalidateQueries: mocks.invalidateQueries })),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: mocks.rpc, storage: { from: vi.fn() } } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/collect", () => ({ todayISO: () => "2026-09-21" }));

import {
  useApproveIncomeExpenseV2,
  usePostApprovedIncomeExpenseV2,
  useReversePostingV2,
} from "./financeV2Mutations";

type Mutation<T> = { mutationFn: (input: T) => Promise<unknown> };

beforeEach(() => vi.clearAllMocks());

describe("Finance V2 action characterization", () => {
  it("canonical approve-only calls no posting writer", async () => {
    mocks.rpc.mockResolvedValue({ data: { approval_status: "APPROVED" }, error: null });
    const mutation = useApproveIncomeExpenseV2() as unknown as Mutation<{ voucherId: string; expectedApprovalVersion: number }>;
    await mutation.mutationFn({ voucherId: "voucher-1", expectedApprovalVersion: 7 });
    expect(mocks.rpc).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledWith("approve_income_expense_v2", expect.objectContaining({ p_voucher: "voucher-1", p_expected_approval_version: 7 }));
  });

  it("owned approval dispatches through the owned flow after the canonical guard", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { message: "voucher owned by system flow" } })
      .mockResolvedValueOnce({ data: { approval_status: "APPROVED" }, error: null });
    const mutation = useApproveIncomeExpenseV2() as unknown as Mutation<{ voucherId: string; expectedApprovalVersion: number }>;
    await mutation.mutationFn({ voucherId: "voucher-owned", expectedApprovalVersion: 3 });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, "decide_owned_income_expense_v2", expect.objectContaining({ p_voucher: "voucher-owned", p_decision: "approve" }));
  });

  it("post-only calls the posting writer without an approval writer", async () => {
    mocks.rpc.mockResolvedValue({ data: { posting_status: "POSTED" }, error: null });
    const mutation = usePostApprovedIncomeExpenseV2() as unknown as Mutation<Record<string, unknown>>;
    const input = { voucher_id: "voucher-1", cashbook_id: "cashbook-1" };
    await mutation.mutationFn(input);
    expect(mocks.rpc).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledWith("post_approved_income_expense_v2", { input });
  });

  it("reverse uses the reverse writer and preserves voucher/cashbook identity", async () => {
    mocks.rpc.mockResolvedValue({ data: { posting_status: "REVERSED" }, error: null });
    const mutation = useReversePostingV2() as unknown as Mutation<{ voucherId: string; cashbookId: string; reason: string }>;
    await mutation.mutationFn({ voucherId: "voucher-1", cashbookId: "cashbook-1", reason: "Sai chứng từ" });
    expect(mocks.rpc).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledWith("reverse_posted_income_expense_v2", expect.objectContaining({
      p_voucher: "voucher-1", p_cashbook: "cashbook-1", p_posted_on: "2026-09-21", p_reason: "Sai chứng từ",
    }));
  });

  it('managed approval retains caller key through owned dispatch and retries', async () => {
    const mutation = useApproveIncomeExpenseV2({ managed: true }) as unknown as Mutation<{ voucherId: string; expectedApprovalVersion: number; idempotencyKey: string }>;
    for (let i = 0; i < 2; i++) {
      mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'owned by system flow' } })
        .mockResolvedValueOnce({ data: { voucherId: 'owned', approvalStatus: 'APPROVED' }, error: null });
      await mutation.mutationFn({ voucherId: 'owned', expectedApprovalVersion: 8, idempotencyKey: 'stable-approval-key' });
    }
    expect(mocks.rpc.mock.calls.every(call => call[1].p_idempotency_key === 'stable-approval-key')).toBe(true);
  });

  it('managed approval rejects missing actual CAS before writing and preserves server error code', async () => {
    const mutation = useApproveIncomeExpenseV2({ managed: true }) as unknown as Mutation<{ voucherId: string; expectedApprovalVersion?: number; idempotencyKey: string }>;
    await expect(mutation.mutationFn({ voucherId: 'v', idempotencyKey: 'stable-key' })).rejects.toThrow();
    expect(mocks.rpc).not.toHaveBeenCalled();
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '40001', message: 'stale' } });
    await expect(mutation.mutationFn({ voucherId: 'v', expectedApprovalVersion: 8, idempotencyKey: 'stable-key' })).rejects.toMatchObject({ code: '40001' });
  });

  it('managed reversal keeps its caller key and posted date', async () => {
    mocks.rpc.mockResolvedValue({ data: { voucherId: 'v', postingStatus: 'REVERSED' }, error: null });
    const mutation = useReversePostingV2({ managed: true }) as unknown as Mutation<{ voucherId: string; cashbookId: string; idempotencyKey: string; postedOn: string }>;
    await mutation.mutationFn({ voucherId: 'v', cashbookId: 'b', idempotencyKey: 'reverse-key', postedOn: '2026-09-20' });
    expect(mocks.rpc).toHaveBeenCalledWith('reverse_posted_income_expense_v2', expect.objectContaining({ p_idempotency_key: 'reverse-key', p_posted_on: '2026-09-20' }));
  });
});
