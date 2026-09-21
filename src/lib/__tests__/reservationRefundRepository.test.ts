import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: m.rpc } }));
vi.mock("@/hooks/income-expenses/useIncomeExpenseActionSnapshots", () => ({
  readIncomeExpenseActionSnapshotPage: vi.fn(),
}));
import {
  executeReservationRefundAction,
  type ReservationRefundActionInput,
} from "../reservationRefundRepository";
const input: ReservationRefundActionInput = {
  organizationId: "o",
  sourceVoucherId: "d",
  settlementId: "s",
  voucherId: "v",
  basisFingerprint: "basis",
  expectedRemaining: 100,
  expectedApprovalVersion: 1,
  expectedPostingVersion: 2,
  expectedReviewVersion: 3,
  idempotencyKey: "stable-key",
  action: "approve",
};
beforeEach(() => vi.resetAllMocks());
it.each([
  [
    "approve",
    { voucherId: "v", approvalStatus: "APPROVED", approvalVersion: 2 },
  ],
  [
    "request_changes",
    {
      voucherId: "v",
      approvalStatus: "UNAPPROVED",
      reviewState: "CHANGES_REQUESTED",
      reviewVersion: 4,
    },
  ],
  [
    "resubmit",
    {
      voucherId: "v",
      approvalStatus: "UNAPPROVED",
      reviewState: "PENDING",
      reviewVersion: 4,
    },
  ],
  [
    "post",
    {
      voucherId: "v",
      postingStatus: "POSTED",
      postingVersion: 3,
      postingId: "p",
    },
  ],
  [
    "approve_and_post",
    {
      voucherId: "v",
      approvalStatus: "APPROVED",
      approvalVersion: 2,
      postingStatus: "POSTED",
      postingVersion: 3,
      postingId: "p",
    },
  ],
  [
    "reverse",
    {
      voucherId: "v",
      postingStatus: "REVERSED",
      postingVersion: 3,
      reversalPostingId: "r",
    },
  ],
] as const)(
  "validates exact specialized %s result and preserves caller key/CAS",
  async (action, data) => {
    m.rpc.mockResolvedValue({ data, error: null });
    const request = { ...input, action };
    await executeReservationRefundAction(request);
    expect(m.rpc).toHaveBeenCalledExactlyOnceWith(
      "execute_reservation_refund_action_v1",
      { p_input: request },
    );
  },
);
it.each([
  null,
  {},
  { voucherId: "other", approvalStatus: "APPROVED", approvalVersion: 2 },
  { voucherId: "v", approvalStatus: "APPROVED", approvalVersion: 9 },
])("keeps an invalid result unknown without retry: %j", async (data) => {
  m.rpc.mockResolvedValue({ data, error: null });
  await expect(executeReservationRefundAction(input)).rejects.toThrow(
    "Chưa xác nhận",
  );
  expect(m.rpc).toHaveBeenCalledOnce();
});
it("preserves server permission denial without fallback", async () => {
  m.rpc.mockResolvedValue({
    data: null,
    error: { message: "denied", code: "42501" },
  });
  await expect(executeReservationRefundAction(input)).rejects.toMatchObject({
    code: "42501",
  });
  expect(m.rpc).toHaveBeenCalledOnce();
});
