import { describe, expect, it } from "vitest";

import type { InvoiceWithRelations } from "@/types/invoice";
import {
  getActivePaymentMethods,
  hasMixedActivePaymentMethods,
} from "../InvoiceListTable";

const invoice = (overrides: Record<string, unknown>): InvoiceWithRelations => ({
  id: "invoice-1",
  ...overrides,
} as unknown as InvoiceWithRelations);

describe("InvoiceListTable active payment methods", () => {
  it("prefers receipt methods so pure credit participates in mixed highlighting", () => {
    const row = invoice({
      active_payment_methods: ["TK", "TM"],
      payments: [{ payment_method: "TK", reversed_at: null }],
    });

    expect(getActivePaymentMethods(row)).toEqual(["TK", "TM"]);
    expect(hasMixedActivePaymentMethods(row)).toBe(true);
  });

  it("ignores reversed embedded payments when enrichment is unavailable", () => {
    const row = invoice({
      payments: [
        { payment_method: "TK", reversed_at: null },
        { payment_method: "TM", reversed_at: "2026-07-21T00:00:00Z" },
      ],
    });

    expect(getActivePaymentMethods(row)).toEqual(["TK"]);
    expect(hasMixedActivePaymentMethods(row)).toBe(false);
  });
});
