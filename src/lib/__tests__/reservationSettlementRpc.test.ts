import { describe, expect, it } from "vitest";
import {
  reservationSettlementListSchema,
  reservationSettlementPreviewSchema,
  reservationSettlementSchema,
  reservationSettlementSummarySchema,
} from "../reservationSettlementRpc";

const settlement = {
  id: "00000000-0000-4000-8000-000000000001",
  sourceVoucherId: "00000000-0000-4000-8000-000000000002",
  depositAmount: 3_000_000,
  retainedAmount: 2_000_000,
  refundAmount: 1_000_000,
  refundedAmount: 0,
  refundRemaining: 1_000_000,
  refundState: "PENDING",
  roomReleased: true,
  roomBlockers: [],
  revenueVoucherId: null,
  offsetVoucherId: null,
  refundVoucherId: null,
} as const;

describe("reservation settlement RPC DTOs", () => {
  it("rejects a settlement whose retained and refund amounts exceed the deposit", () => {
    expect(() => reservationSettlementSchema.parse({
      ...settlement,
      retainedAmount: 2_500_000,
    })).toThrow();
  });

  it("rejects a paid settlement that still has a refund balance", () => {
    expect(() => reservationSettlementSchema.parse({
      ...settlement,
      refundState: "PAID",
    })).toThrow();
  });

  it("keeps nullable source labels and voucher date in the preview", () => {
    expect(reservationSettlementPreviewSchema.parse({
      voucherId: settlement.sourceVoucherId,
      depositAmount: 3_000_000,
      fingerprint: "basis:v1",
      canSettle: true,
      canRefundNow: false,
      blockers: [],
      roomBlockers: ["OTHER_DEPOSIT"],
      voucherCode: null,
      payerName: "Nguyễn Văn A",
      roomName: null,
      buildingName: "Tòa A",
      voucherDate: "2026-09-01",
    })).toMatchObject({ voucherCode: null, voucherDate: "2026-09-01" });
  });

  it("rejects unsafe numeric summary values instead of coercing them to zero", () => {
    expect(() => reservationSettlementSummarySchema.parse({
      retainedAmount: "not-a-number",
      retainedCount: 1,
      refundPendingAmount: 0,
      refundPendingCount: 0,
      refundPaidAmount: 0,
      refundPaidCount: 0,
    })).toThrow();
  });

  it("validates list history fields and its keyset cursor", () => {
    const parsed = reservationSettlementListSchema.parse({
      rows: [{
        ...settlement,
        createdAt: "2026-09-10T08:00:00Z",
        settlementDate: "2026-09-10",
        reasonCode: "CHANGED_MIND",
        reasonText: "",
        buildingId: "00000000-0000-4000-8000-000000000003",
        buildingName: "Tòa A",
        roomId: null,
        roomName: null,
        payerName: "Nguyễn Văn A",
        voucherCode: "PT-001",
      }],
      nextCursor: { createdAt: "2026-09-10T08:00:00Z", id: settlement.id },
    });
    expect(parsed.rows[0].settlementDate).toBe("2026-09-10");
  });
});
