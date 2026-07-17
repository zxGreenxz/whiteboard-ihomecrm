import { describe, expect, it, vi } from "vitest";

import {
  buildRecordInvoicePaymentRpcArgs,
  classifyV4FallbackSignal,
  recordInvoicePaymentWithFallback,
  type PaymentRpcInvoker,
  type RecordInvoicePaymentInput,
} from "../paymentRecordRpc";

const INPUT: RecordInvoicePaymentInput = {
  invoice_id: "11111111-1111-4111-8111-111111111111",
  amount: 150000,
  payment_method: "TM",
  payment_date: "2026-07-17",
};

const KEY = "pay-key-00000001";

describe("buildRecordInvoicePaymentRpcArgs", () => {
  it("maps every field exactly with null defaults for omitted optionals", () => {
    expect(buildRecordInvoicePaymentRpcArgs(INPUT, KEY)).toEqual({
      p_invoice_id: INPUT.invoice_id,
      p_amount: 150000,
      p_payment_method: "TM",
      p_payment_date: "2026-07-17",
      p_idempotency_key: KEY,
      p_account_id: null,
      p_notes: null,
      p_receipt_image_url: null,
      p_voucher: null,
      p_items: null,
      p_receipt_number: null,
      p_voucher_owner_id: null,
    });
  });

  it("passes optional fields through verbatim", () => {
    const voucher = { room_id: "22222222-2222-4222-8222-222222222222" };
    const items = [{ income_expense_type_id: "33333333-3333-4333-8333-333333333333" }];
    const args = buildRecordInvoicePaymentRpcArgs(
      {
        ...INPUT,
        account_id: "44444444-4444-4444-8444-444444444444",
        notes: "ghi chú",
        receipt_image_url: "https://example.com/r.jpg",
        receipt_number: "PT-001",
        voucher,
        items,
        voucher_owner_id: "55555555-5555-4555-8555-555555555555",
      },
      KEY,
    );
    expect(args.p_account_id).toBe("44444444-4444-4444-8444-444444444444");
    expect(args.p_notes).toBe("ghi chú");
    expect(args.p_receipt_image_url).toBe("https://example.com/r.jpg");
    expect(args.p_receipt_number).toBe("PT-001");
    expect(args.p_voucher).toBe(voucher);
    expect(args.p_items).toBe(items);
    expect(args.p_voucher_owner_id).toBe("55555555-5555-4555-8555-555555555555");
  });

  it("trims the idempotency key", () => {
    expect(buildRecordInvoicePaymentRpcArgs(INPUT, `  ${KEY}  `).p_idempotency_key).toBe(KEY);
  });

  it.each(["short", "has space key", "bad!char-key", "việt-hoá-key-123"])(
    "rejects invalid idempotency key %s",
    (bad) => {
      expect(() => buildRecordInvoicePaymentRpcArgs(INPUT, bad)).toThrow(/idempotency_key/);
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects non-positive or non-finite amount %s",
    (amount) => {
      expect(() =>
        buildRecordInvoicePaymentRpcArgs({ ...INPUT, amount }, KEY),
      ).toThrow(/số dương/);
    },
  );
});

describe("classifyV4FallbackSignal", () => {
  it("classifies PGRST202 as writer-not-deployed", () => {
    expect(classifyV4FallbackSignal({ code: "PGRST202", message: "not found" })).toBe(
      "writer-not-deployed",
    );
  });

  it("classifies 55000 'chưa bật' as writer-disabled", () => {
    expect(
      classifyV4FallbackSignal({
        code: "55000",
        message: "Writer thu tiền chưa bật cho tổ chức này",
      }),
    ).toBe("writer-disabled");
  });

  it("does NOT treat other 55000 errors as fallback (ledger anomaly must throw)", () => {
    expect(
      classifyV4FallbackSignal({
        code: "55000",
        message: "Không nhận diện được operation idempotency",
      }),
    ).toBeNull();
  });

  it("classifies 42501 as v4-denied (coexistence until T7 drain)", () => {
    expect(
      classifyV4FallbackSignal({ code: "42501", message: "permission denied" }),
    ).toBe("v4-denied");
  });

  it.each([
    ["23505", "idempotency_key đã dùng với nội dung khác"],
    ["23505", "idempotency_key đã dùng ở đường legacy (v3)"],
    ["P0001", "Số tiền không hợp lệ"],
    [undefined, "network down"],
  ])("never falls back on %s %s", (code, message) => {
    expect(classifyV4FallbackSignal({ code, message })).toBeNull();
  });
});

describe("recordInvoicePaymentWithFallback", () => {
  const okV4 = { data: { payment_id: "v4-payment" }, error: null };
  const okV3 = { data: { payment_id: "v3-payment" }, error: null };

  it("returns CANONICAL on v4 success without touching v3", async () => {
    const rpc = vi.fn().mockResolvedValue(okV4) as unknown as PaymentRpcInvoker;
    const outcome = await recordInvoicePaymentWithFallback(rpc, INPUT, KEY);
    expect(outcome).toEqual({ result: { payment_id: "v4-payment" }, route: "CANONICAL" });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      "record_invoice_payment_v4",
      expect.objectContaining({ p_idempotency_key: KEY }),
    );
  });

  it.each([
    [{ code: "PGRST202", message: "no function" }, "writer-not-deployed"],
    [{ code: "55000", message: "Writer thu tiền chưa bật cho tổ chức này" }, "writer-disabled"],
    [{ code: "42501", message: "Không có quyền thu tiền (thu_tien.collect)" }, "v4-denied"],
  ])("falls back to v3 with IDENTICAL args on %o", async (error, reason) => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error })
      .mockResolvedValueOnce(okV3) as unknown as PaymentRpcInvoker;
    const outcome = await recordInvoicePaymentWithFallback(rpc, INPUT, KEY);
    expect(outcome).toEqual({
      result: { payment_id: "v3-payment" },
      route: "LEGACY",
      legacyReason: reason,
    });
    const calls = (rpc as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe("record_invoice_payment_v4");
    expect(calls[1][0]).toBe("record_invoice_payment_v3");
    expect(calls[1][1]).toEqual(calls[0][1]);
  });

  it.each([
    { code: "23505", message: "idempotency_key đã dùng với nội dung khác" },
    { code: "23505", message: "idempotency_key đã dùng ở đường legacy (v3)" },
    { code: "55000", message: "Không nhận diện được operation idempotency" },
    { code: "P0001", message: "Số tiền không hợp lệ" },
  ])("throws v4 error %o without calling v3", async (error) => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error }) as unknown as PaymentRpcInvoker;
    await expect(recordInvoicePaymentWithFallback(rpc, INPUT, KEY)).rejects.toBe(error);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("throws the v3 error when the fallback also fails", async () => {
    const v3Error = { code: "42501", message: "legacy denied too" };
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "absent" } })
      .mockResolvedValueOnce({ data: null, error: v3Error }) as unknown as PaymentRpcInvoker;
    await expect(recordInvoicePaymentWithFallback(rpc, INPUT, KEY)).rejects.toBe(v3Error);
  });

  it("validates the key before any rpc call", async () => {
    const rpc = vi.fn() as unknown as PaymentRpcInvoker;
    await expect(recordInvoicePaymentWithFallback(rpc, INPUT, "bad key")).rejects.toThrow(
      /idempotency_key/,
    );
    expect(rpc).not.toHaveBeenCalled();
  });
});
