import { describe, expect, it, vi } from "vitest";
import {
  createReservationRefundPending,
  parseReservationRefundSource,
  reservationRefundDraftSchema,
} from "../reservationRefundWorkflow";
import type { IncomeExpenseActionSnapshot } from "../incomeExpenseActionSnapshot";
const org = "10000000-0000-4000-8000-000000000001",
  actor = "20000000-0000-4000-8000-000000000002",
  source = "30000000-0000-4000-8000-000000000003",
  settlement = "40000000-0000-4000-8000-000000000004",
  voucher = "50000000-0000-4000-8000-000000000005";
const ref = {
  kind: "reservation_refund" as const,
  organizationId: org,
  sourceVoucherId: source,
  settlementId: settlement,
  refundVoucherId: null,
};
const raw = {
  organizationId: org,
  actorId: actor,
  sourceVoucherId: source,
  settlementId: settlement,
  sourceCode: "GC-001",
  payerName: "Người nộp cọc",
  sourceDate: "2026-09-20",
  settlementDate: "2026-09-21",
  today: "2026-09-21",
  basisFingerprint: "a".repeat(32),
  basisValid: true,
  depositAmount: 100,
  retainedAmount: 0,
  refundAmount: 100,
  paid: 0,
  remaining: 100,
  canCreate: true,
  existingVoucherId: null,
  hiddenExisting: false,
  blockedReason: null,
  revision: "b".repeat(32),
};
const parse = (x: unknown = raw) => parseReservationRefundSource(x, ref, actor);
const draft = {
  recipientName: "Người nhận",
  bank: "VCB",
  accountNumber: "123",
};
const request = {
  actorId: actor,
  sourceRef: ref,
  expectedRevision: raw.revision,
  idempotencyKey: "pending-caller-key",
  draft,
};
const snapshot = {
  id: voucher,
  organizationId: org,
  type: "EXPENSE",
  totalAmount: 100,
  systemSource: "reservation.refund",
  accountId: null,
  activePostingId: null,
  approvalStatus: "UNAPPROVED",
  reviewState: "PENDING",
  postingStatus: "UNPOSTED",
  capabilities: {
    reservationRefund: {
      settlementId: settlement,
      sourceVoucherId: source,
      basisFingerprint: raw.basisFingerprint,
      remaining: 100,
      basisValid: true,
      current: true,
      fullRemaining: true,
    },
  },
} as IncomeExpenseActionSnapshot;
function ports() {
  return {
    readSource: vi
      .fn()
      .mockResolvedValueOnce(parse())
      .mockResolvedValue(
        parse({
          ...raw,
          canCreate: false,
          existingVoucherId: voucher,
          revision: "c".repeat(32),
        }),
      ),
    readVoucher: vi.fn().mockResolvedValue(snapshot),
    createPending: vi
      .fn()
      .mockResolvedValue({
        voucherId: voucher,
        settlementId: settlement,
        sourceVoucherId: source,
        outcome: "created",
      }),
  };
}
describe("reservation source boundary", () => {
  it("validates ledger math without substituting unknown values", () => {
    expect(parse().remaining).toBe(100);
    for (const change of [
      { remaining: null },
      { remaining: 99 },
      { paid: 1 },
      { depositAmount: 99 },
      { basisValid: null },
      { canCreate: true, hiddenExisting: true },
      { canCreate: true, existingVoucherId: voucher },
      { sourceDate: "2026-02-30" },
    ])
      expect(() => parse({ ...raw, ...change })).toThrow();
  });
  it("rejects another actor, organization, source or settlement", () => {
    for (const key of [
      "actorId",
      "organizationId",
      "sourceVoucherId",
      "settlementId",
    ])
      expect(() => parse({ ...raw, [key]: voucher })).toThrow();
  });
  it("requires explicit recipient and a complete optional bank pair", () => {
    expect(reservationRefundDraftSchema.safeParse(draft).success).toBe(true);
    for (const change of [
      { recipientName: " " },
      { bank: "", accountNumber: "123" },
      { bank: "VCB", accountNumber: "" },
    ])
      expect(
        reservationRefundDraftSchema.safeParse({ ...draft, ...change }).success,
      ).toBe(false);
  });
  it("creates only one pending voucher using frozen remaining and a stable caller key", async () => {
    const p = ports();
    expect(await createReservationRefundPending(request, p)).toEqual({
      outcome: "created",
      voucherId: voucher,
    });
    expect(p.createPending).toHaveBeenCalledOnce();
    expect(p.createPending.mock.calls[0]?.[0]).toEqual({
      organizationId: org,
      sourceVoucherId: source,
      settlementId: settlement,
      basisFingerprint: raw.basisFingerprint,
      expectedRemaining: 100,
      idempotencyKey: request.idempotencyKey,
      ...draft,
    });
  });
  it("opens an authoritative existing identity without creating or resubmitting", async () => {
    const p = ports();
    p.readSource
      .mockReset()
      .mockResolvedValue(
        parse({ ...raw, canCreate: false, existingVoucherId: voucher }),
      );
    expect(await createReservationRefundPending(request, p)).toEqual({
      outcome: "existing",
      voucherId: voucher,
    });
    expect(p.createPending).not.toHaveBeenCalled();
  });
  it.each([
    { revision: "d".repeat(32) },
    { canCreate: false, blockedReason: "Thiếu quyền" },
    { basisValid: false, canCreate: false },
    { hiddenExisting: true, canCreate: false },
  ])("blocks source drift before writing: %j", async (change) => {
    const p = ports();
    p.readSource.mockReset().mockResolvedValue(parse({ ...raw, ...change }));
    await expect(createReservationRefundPending(request, p)).rejects.toThrow();
    expect(p.createPending).not.toHaveBeenCalled();
  });
  it("rejects a response or readback from another source", async () => {
    const p = ports();
    p.createPending.mockResolvedValue({
      voucherId: voucher,
      settlementId: org,
      sourceVoucherId: source,
      outcome: "created",
    });
    await expect(
      createReservationRefundPending(request, p),
    ).rejects.toMatchObject({ kind: "unconfirmed" });
  });
  it.each([
    { accountId: source },
    { approvalStatus: "APPROVED" },
    { reviewState: "CHANGES_REQUESTED" },
    { postingStatus: "POSTED" },
    { activePostingId: source },
    { totalAmount: 99 },
    { systemSource: "termination.refund" },
  ])("requires a truthful pending readback: %j", async (change) => {
    const p = ports();
    p.readVoucher.mockResolvedValue({ ...snapshot, ...change });
    await expect(
      createReservationRefundPending(request, p),
    ).rejects.toMatchObject({ kind: "unconfirmed" });
  });
  it("reconciles a lost response to the exact source claim without retrying create", async () => {
    const p = ports();
    p.createPending.mockRejectedValue(new Error("network"));
    expect(await createReservationRefundPending(request, p)).toEqual({
      outcome: "existing",
      voucherId: voucher,
    });
    expect(p.createPending).toHaveBeenCalledOnce();
  });
  it("holds an uncertain result when no source claim confirms it", async () => {
    const p = ports();
    p.createPending.mockRejectedValue(new Error("network"));
    p.readSource.mockReset().mockResolvedValue(parse());
    await expect(
      createReservationRefundPending(request, p),
    ).rejects.toMatchObject({ kind: "unconfirmed" });
    expect(p.createPending).toHaveBeenCalledOnce();
  });
  it("preserves a known permission denial without pretending creation succeeded", async () => {
    const p = ports();
    p.createPending.mockRejectedValue(
      Object.assign(new Error("denied"), { code: "42501" }),
    );
    p.readSource.mockReset().mockResolvedValue(parse());
    await expect(
      createReservationRefundPending(request, p),
    ).rejects.toMatchObject({ kind: "blocked" });
  });
});
