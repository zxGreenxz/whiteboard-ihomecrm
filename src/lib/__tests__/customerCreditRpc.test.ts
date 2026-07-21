import { describe, expect, it, vi } from "vitest";

import {
  buildCreditInvoiceCreateRpcArgs,
  buildForfeitWithCreditRpcArgs,
  buildInvoiceCreditLifecycleRpcArgs,
  buildMoveOutWithCreditRpcArgs,
  invokeCustomerCreditRpc,
  prepareCustomerCreditRequest,
  selectInvoiceCreateRpc,
  type CustomerCreditRpcInvoker,
} from "../customerCreditRpc";

const KEY = "invoice-credit-request-00000001";

describe("customer credit RPC request preparation", () => {
  it("keeps one idempotency key stable for every build of a prepared request", () => {
    const request = prepareCustomerCreditRequest("invoice-create", `  ${KEY}  `);

    expect(buildInvoiceCreditLifecycleRpcArgs("invoice-1", request)).toEqual({
      p_invoice_id: "invoice-1",
      p_idempotency_key: KEY,
    });
    expect(buildInvoiceCreditLifecycleRpcArgs("invoice-1", request)).toEqual({
      p_invoice_id: "invoice-1",
      p_idempotency_key: KEY,
    });
  });

  it.each(["short", "contains spaces 1", "bad/key/0001", "bad!key-0001"])(
    "rejects invalid idempotency key %s",
    (key) => {
      expect(() => prepareCustomerCreditRequest("invoice-create", key)).toThrow(
        /idempotency_key/,
      );
    },
  );
});

describe("credit-aware writer selection", () => {
  it("routes invoices with applied credit only to the atomic wrapper", () => {
    expect(selectInvoiceCreateRpc(1)).toBe("create_invoice_with_credit_v1");
    expect(selectInvoiceCreateRpc(0)).toBe("create_invoice_v1");
  });

  it("maps invoice credit without exposing a direct compatibility-ledger write", () => {
    const args = buildCreditInvoiceCreateRpcArgs(
      {
        p_contract_id: "contract-1",
        p_items: [],
        p_discount_amount: 175_000,
      },
      125_000,
      prepareCustomerCreditRequest("invoice-create", KEY),
    );

    expect(args).toEqual({
      p_contract_id: "contract-1",
      p_items: [],
      p_discount_amount: 175_000,
      p_applied_credit: 125_000,
      p_non_credit_discount_amount: 50_000,
      p_idempotency_key: KEY,
    });
    expect(args).not.toHaveProperty("amount");
    expect(args).not.toHaveProperty("source_invoice_id");
  });

  it("rejects non-positive or over-precision invoice credit", () => {
    const request = prepareCustomerCreditRequest("invoice-create", KEY);
    expect(() => buildCreditInvoiceCreateRpcArgs({ p_discount_amount: 1 }, 0, request)).toThrow(
      /positive/,
    );
    expect(() => buildCreditInvoiceCreateRpcArgs({ p_discount_amount: 2 }, 1.001, request)).toThrow(
      /decimal places/,
    );
    expect(() =>
      buildCreditInvoiceCreateRpcArgs({ p_discount_amount: 100 }, 101, request),
    ).toThrow(/include the full applied_credit/);
  });
});

describe("termination wrapper arguments", () => {
  it("builds the forfeit payload with the same stable key", () => {
    const request = prepareCustomerCreditRequest("contract-forfeit", KEY);
    expect(
      buildForfeitWithCreditRpcArgs(
        {
          contractId: "contract-1",
          forfeitDate: "2026-07-21",
          extraCharges: [{ amount: 50_000 }],
        },
        request,
      ),
    ).toEqual({
      p_contract_id: "contract-1",
      p_forfeit_date: "2026-07-21",
      p_extra_charges: [{ amount: 50_000 }],
      p_idempotency_key: KEY,
    });
  });

  it("builds the full move-out payload without a second client write", () => {
    const request = prepareCustomerCreditRequest("contract-move-out", KEY);
    expect(
      buildMoveOutWithCreditRpcArgs(
        {
          contractId: "contract-1",
          moveOutDate: "2026-07-21",
          depositRefund: 1_000_000,
          excessRent: 250_000,
          shortfallMode: "DEBT",
        },
        request,
      ),
    ).toEqual(
      expect.objectContaining({
        p_contract_id: "contract-1",
        p_excess_rent: 250_000,
        p_shortfall_mode: "DEBT",
        p_idempotency_key: KEY,
      }),
    );
  });
});

describe("fail-closed invocation", () => {
  it("throws the wrapper error after exactly one RPC and never chooses fallback", async () => {
    const error = { code: "55000", message: "credit reconciliation required" };
    const rpc = vi.fn().mockResolvedValue({ data: null, error }) as unknown as
      CustomerCreditRpcInvoker;

    await expect(
      invokeCustomerCreditRpc(
        rpc,
        "cancel_invoice_with_credit_v1",
        buildInvoiceCreditLifecycleRpcArgs(
          "invoice-1",
          prepareCustomerCreditRequest("invoice-cancel", KEY),
        ),
      ),
    ).rejects.toBe(error);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      "cancel_invoice_with_credit_v1",
      expect.objectContaining({ p_idempotency_key: KEY }),
    );
  });
});
