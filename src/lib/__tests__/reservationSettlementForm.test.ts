import { describe, expect, it } from "vitest";
import {
  calculateReservationSplit,
  reservationSettlementFormSchema,
} from "../reservationSettlementForm";

const base = {
  depositAmount: 3_000_000,
  refundAmount: 0,
  refundMode: "NONE",
  settlementDate: "2026-09-10",
  reasonCode: "CHANGED_MIND",
  reasonText: "",
  refundAccountId: null,
} as const;

describe("calculateReservationSplit", () => {
  it("keeps the refundable amount out of retained revenue", () => {
    expect(calculateReservationSplit(3_000_000, 1_000_000)).toEqual({
      retainedAmount: 2_000_000,
      refundAmount: 1_000_000,
    });
  });

  it.each([-1, 3_000_001, 0.5, Number.NaN])(
    "rejects an invalid refund amount %s",
    (refundAmount) => {
      expect(() => calculateReservationSplit(3_000_000, refundAmount)).toThrow();
    },
  );
});

describe("reservationSettlementFormSchema", () => {
  it("accepts the zero-refund default without a cashbook", () => {
    expect(reservationSettlementFormSchema.parse(base).refundMode).toBe("NONE");
  });

  it("requires NOW or LATER when a refund is due", () => {
    expect(() => reservationSettlementFormSchema.parse({ ...base, refundAmount: 1_000_000 })).toThrow();
  });

  it("requires a real cashbook selection for an immediate refund", () => {
    expect(() => reservationSettlementFormSchema.parse({
      ...base,
      refundAmount: 1_000_000,
      refundMode: "NOW",
    })).toThrow();
  });

  it("does not require a cashbook for a deferred refund", () => {
    expect(reservationSettlementFormSchema.parse({
      ...base,
      refundAmount: 1_000_000,
      refundMode: "LATER",
    }).refundAccountId).toBeNull();
  });

  it("requires an explanation for OTHER", () => {
    expect(() => reservationSettlementFormSchema.parse({
      ...base,
      reasonCode: "OTHER",
      reasonText: "   ",
    })).toThrow();
  });
});
