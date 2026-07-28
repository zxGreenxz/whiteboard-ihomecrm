import { describe, expect, it, vi } from "vitest";

import {
  buildRecordInvoiceCollectionRpcArgs,
  deriveInvoiceDepositDue,
  planInvoiceCollection,
  recordInvoiceCollectionV5,
  reverseInvoicePaymentBySource,
  type CollectionRpcInvoker,
  type RecordInvoiceCollectionInput,
  type ReversePaymentRpcInvoker,
} from "../paymentRecordRpc";

const COLLECTION_INPUT: RecordInvoiceCollectionInput = {
  invoice_id: "11111111-1111-4111-8111-111111111111",
  collection_date: "2026-07-21",
  tenders: [
    {
      payment_method: "TK",
      gross_amount: 3_000_000,
      account_id: "22222222-2222-4222-8222-222222222222",
    },
    {
      payment_method: "TM",
      gross_amount: 2_000_000,
      account_id: "33333333-3333-4333-8333-333333333333",
      change_account_id: "44444444-4444-4444-8444-444444444444",
    },
  ],
  overpay_action: "REFUND",
  allow_rounding: false,
  notes: "Thu tại phòng",
  receipt_image_url: "https://example.com/receipt.jpg",
  expected_paid_amount: 1_000_000,
};

const KEY = "collect-key-00000001";

describe("record_invoice_collection_v5 args and routing", () => {
  it("maps one RPC payload containing every tender", () => {
    expect(buildRecordInvoiceCollectionRpcArgs(COLLECTION_INPUT, `  ${KEY}  `)).toEqual({
      p_invoice_id: COLLECTION_INPUT.invoice_id,
      p_collection_date: "2026-07-21",
      p_tenders: [
        {
          payment_method: "TK",
          gross_amount: 3_000_000,
          account_id: "22222222-2222-4222-8222-222222222222",
          change_account_id: null,
          rounding_account_id: null,
          receipt_number: null,
        },
        {
          payment_method: "TM",
          gross_amount: 2_000_000,
          account_id: "33333333-3333-4333-8333-333333333333",
          change_account_id: "44444444-4444-4444-8444-444444444444",
          rounding_account_id: null,
          receipt_number: null,
        },
      ],
      p_overpay_action: "REFUND",
      p_allow_rounding: false,
      p_notes: "Thu tại phòng",
      p_receipt_image_url: "https://example.com/receipt.jpg",
      p_expected_paid_amount: 1_000_000,
      p_idempotency_key: KEY,
    });
  });

  it("keeps the same prepared key stable across retries", () => {
    expect(buildRecordInvoiceCollectionRpcArgs(COLLECTION_INPUT, KEY).p_idempotency_key).toBe(KEY);
    expect(buildRecordInvoiceCollectionRpcArgs(COLLECTION_INPUT, KEY).p_idempotency_key).toBe(KEY);
  });

  it("rejects virtual receiving accounts and real metadata accounts", () => {
    expect(() => buildRecordInvoiceCollectionRpcArgs({
      ...COLLECTION_INPUT,
      tenders: [{
        payment_method: "TM",
        gross_amount: 100_000,
        account_id: "virtual-receiving",
        account_is_virtual: true,
      }],
      overpay_action: "REJECT",
    }, KEY)).toThrow(/sổ thật/);

    expect(() => buildRecordInvoiceCollectionRpcArgs({
      ...COLLECTION_INPUT,
      tenders: [{
        payment_method: "TM",
        gross_amount: 100_000,
        account_id: "real-receiving",
        account_is_virtual: false,
        change_account_id: "real-change",
        change_account_is_virtual: false,
      }],
    }, KEY)).toThrow(/tiền thối phải là sổ ảo/);

    expect(() => buildRecordInvoiceCollectionRpcArgs({
      ...COLLECTION_INPUT,
      tenders: [{
        payment_method: "TM",
        gross_amount: 100_000,
        account_id: "real-receiving",
        account_is_virtual: false,
        rounding_account_id: "real-rounding",
        rounding_account_is_virtual: false,
      }],
      overpay_action: "REJECT",
    }, KEY)).toThrow(/làm tròn phải là sổ ảo/);
  });

  it.each(["short", "has space key", "bad!char-key", "việt-hoá-key-123"])(
    "rejects invalid idempotency key %s",
    (bad) => expect(() => buildRecordInvoiceCollectionRpcArgs(COLLECTION_INPUT, bad)).toThrow(
      /idempotency_key/,
    ),
  );

  it("calls V5 exactly once on success and never invokes legacy", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { collection_id: "collection-1" },
      error: null,
    }) as unknown as CollectionRpcInvoker;
    const outcome = await recordInvoiceCollectionV5(rpc, COLLECTION_INPUT, KEY);
    expect(outcome).toEqual({ collection_id: "collection-1" });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    { code: "PGRST202", message: "function missing" },
    { code: "55000", message: "Writer invoice.collection.v5 chưa bật" },
    { code: "42501", message: "Không có quyền thu tiền hóa đơn" },
    { code: "55000", message: "Writer invoice.collection.v5 đang bị đóng băng" },
    { code: "55000", message: "[FROZEN] invoice.collection.v5" },
    { code: "40001", message: "Số đã thu vừa thay đổi" },
    { code: "23505", message: "idempotency_key đã dùng với nội dung khác" },
  ])("does not swallow business error %o", async (error) => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error }) as unknown as CollectionRpcInvoker;
    await expect(recordInvoiceCollectionV5(rpc, COLLECTION_INPUT, KEY)).rejects.toBe(error);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe("collection planning", () => {
  it("treats gross as money received and allocates refund only from TM", () => {
    const plan = planInvoiceCollection({
      ...COLLECTION_INPUT,
      invoice_total_amount: 5_000_000,
      deposit_due: 0,
      has_contract: true,
    });
    expect(plan).toMatchObject({
      gross_amount: 5_000_000,
      retained_amount: 4_000_000,
      applied_amount: 4_000_000,
      change_amount: 1_000_000,
      credit_amount: 0,
    });
    expect(plan.tenders[0]).toMatchObject({ applied_amount: 3_000_000, change_amount: 0 });
    expect(plan.tenders[1]).toMatchObject({ applied_amount: 1_000_000, change_amount: 1_000_000 });
  });

  it("allocates overpay as credit without reducing retained cash", () => {
    const plan = planInvoiceCollection({
      ...COLLECTION_INPUT,
      overpay_action: "CREDIT",
      tenders: COLLECTION_INPUT.tenders.map((tender) => ({
        ...tender,
        change_account_id: null,
      })),
      invoice_total_amount: 5_000_000,
      deposit_due: 0,
      has_contract: true,
    });
    expect(plan).toMatchObject({
      gross_amount: 5_000_000,
      retained_amount: 5_000_000,
      applied_amount: 4_000_000,
      credit_amount: 1_000_000,
      change_amount: 0,
    });
    expect(plan.tenders.reduce((sum, line) => sum + line.credit_amount, 0)).toBe(1_000_000);
  });

  it("allows pure TT/TK overpay only when it is kept as customer credit", () => {
    const plan = planInvoiceCollection({
      ...COLLECTION_INPUT,
      tenders: [
        { payment_method: "TK", gross_amount: 5_000_000, account_id: "account-tk" },
      ],
      overpay_action: "CREDIT",
      invoice_total_amount: 4_000_000,
      expected_paid_amount: 0,
      deposit_due: 0,
      has_contract: true,
    });

    expect(plan).toMatchObject({
      gross_amount: 5_000_000,
      retained_amount: 5_000_000,
      applied_amount: 4_000_000,
      credit_amount: 1_000_000,
      change_amount: 0,
    });
    expect(plan.tenders[0]).toMatchObject({
      payment_method: "TK",
      applied_amount: 4_000_000,
      credit_amount: 1_000_000,
      change_amount: 0,
    });
  });

  it("requires TM in the current collection to cover a cash refund", () => {
    expect(() => planInvoiceCollection({
      ...COLLECTION_INPUT,
      tenders: [
        { payment_method: "TK", gross_amount: 4_500_000, account_id: "account-tk" },
        { payment_method: "TM", gross_amount: 500_000, account_id: "account-tm", change_account_id: "change" },
      ],
      overpay_action: "REFUND",
      invoice_total_amount: 4_000_000,
      expected_paid_amount: 0,
      deposit_due: 0,
    })).toThrow(/tiền mặt TM/);
  });

  it("allocates mixed-method credit from the last tender regardless of method", () => {
    const plan = planInvoiceCollection({
      ...COLLECTION_INPUT,
      tenders: [
        { payment_method: "TM", gross_amount: 500_000, account_id: "account-tm" },
        { payment_method: "TT", gross_amount: 4_500_000, account_id: "account-tt" },
      ],
      overpay_action: "CREDIT",
      invoice_total_amount: 4_000_000,
      expected_paid_amount: 0,
      deposit_due: 0,
      has_contract: true,
    });

    expect(plan.tenders[0].credit_amount).toBe(0);
    expect(plan.tenders[1]).toMatchObject({
      payment_method: "TT",
      credit_amount: 1_000_000,
    });
  });

  it("rounds a small revenue residual with an explicit account", () => {
    const plan = planInvoiceCollection({
      ...COLLECTION_INPUT,
      tenders: [{
        payment_method: "TM",
        gross_amount: 995_000,
        account_id: "account-tm",
        rounding_account_id: "rounding-account",
      }],
      overpay_action: "REJECT",
      allow_rounding: true,
      expected_paid_amount: 0,
      invoice_total_amount: 1_000_000,
      deposit_due: 0,
    });
    expect(plan.rounding_amount).toBe(5_000);
    expect(plan.tenders[0].rounding_amount).toBe(5_000);
  });

  it("rejects rounding when the unpaid residual is deposit", () => {
    expect(() => planInvoiceCollection({
      ...COLLECTION_INPUT,
      tenders: [{
        payment_method: "TM",
        gross_amount: 995_000,
        account_id: "account-tm",
        rounding_account_id: "rounding-account",
      }],
      overpay_action: "REJECT",
      allow_rounding: true,
      expected_paid_amount: 0,
      invoice_total_amount: 1_000_000,
      deposit_due: 1_000_000,
    })).toThrow(/tiền cọc/);
  });

  it("derives deposit from accounting class, legacy label and debt sources once", () => {
    expect(deriveInvoiceDepositDue({
      invoice_items: [
        { accounting_class: "DEPOSIT", type: "OTHER", description: "Tiền cọc", amount: 500_000 },
        { type: "OTHER", description: "Tiền cọc", amount: 300_000 },
        { type: "OTHER", description: "Cọc xe máy", amount: 100_000 },
      ],
      previous_debt_sources: [{ type: "deposit", amount: 200_000 }],
    })).toBe(1_000_000);
  });

  it("keeps tender allocations balanced without client-side writes", () => {
    const plan = planInvoiceCollection({
      ...COLLECTION_INPUT,
      invoice_total_amount: 5_000_000,
      deposit_due: 1_000_000,
      has_contract: true,
    });
    expect(plan.tenders.reduce((sum, line) => sum + line.gross_amount, 0)).toBe(plan.gross_amount);
    expect(plan.tenders.reduce((sum, line) => sum + line.applied_amount, 0)).toBe(plan.applied_amount);
    expect(plan.tenders.reduce((sum, line) => sum + line.change_amount, 0)).toBe(plan.change_amount);
  });
});

describe("reverse routing", () => {
  it("reverses a V5 collection directly", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { status: "REVERSED" }, error: null }) as unknown as ReversePaymentRpcInvoker;
    const outcome = await reverseInvoicePaymentBySource(rpc, {
      payment_id: "payment-1",
      collection_id: "collection-1",
      reversal_date: "2026-07-21",
      reason: "Hoàn tác từ giao diện",
      idempotency_key: "reverse-collection-0001",
    });
    expect(outcome.source).toBe("COLLECTION");
    expect(rpc).toHaveBeenCalledWith("reverse_invoice_collection_v5", expect.objectContaining({
      p_collection_id: "collection-1",
    }));
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("reverses a pure-credit collection without requiring a payment row", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { status: "REVERSED" }, error: null }) as unknown as ReversePaymentRpcInvoker;
    const outcome = await reverseInvoicePaymentBySource(rpc, {
      payment_id: null,
      collection_id: "collection-credit-only",
      reversal_date: "2026-07-21",
      reason: "Hoàn tác tender chỉ giữ credit",
      idempotency_key: "reverse-credit-only-0001",
    });
    expect(outcome.source).toBe("COLLECTION");
    expect(rpc).toHaveBeenCalledWith("reverse_invoice_collection_v5", {
      p_collection_id: "collection-credit-only",
      p_reversal_date: "2026-07-21",
      p_reason: "Hoàn tác tender chỉ giữ credit",
      p_idempotency_key: "reverse-credit-only-0001",
    });
  });

  it("uses the compat undo adapter only for a legacy payment", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { reversed: true }, error: null }) as unknown as ReversePaymentRpcInvoker;
    const outcome = await reverseInvoicePaymentBySource(rpc, {
      payment_id: "payment-old",
      collection_id: null,
      reversal_date: "2026-07-21",
      reason: "Hoàn tác payment cũ",
      idempotency_key: "reverse-payment-0001",
    });
    expect(outcome.source).toBe("LEGACY_PAYMENT");
    expect(rpc).toHaveBeenCalledWith("undo_invoice_payment_compat_v1", expect.objectContaining({
      p_payment_id: "payment-old",
    }));
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("propagates permission errors without another route", async () => {
    const error = { code: "42501", message: "Không có quyền hoàn tác" };
    const rpc = vi.fn().mockResolvedValue({ data: null, error }) as unknown as ReversePaymentRpcInvoker;
    await expect(reverseInvoicePaymentBySource(rpc, {
      payment_id: "payment-1",
      collection_id: "collection-1",
      reversal_date: "2026-07-21",
      reason: "Hoàn tác từ giao diện",
      idempotency_key: "reverse-collection-0001",
    })).rejects.toBe(error);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("rejects a legacy reversal without a payment source", async () => {
    const rpc = vi.fn() as unknown as ReversePaymentRpcInvoker;
    await expect(reverseInvoicePaymentBySource(rpc, {
      payment_id: "   ",
      collection_id: null,
      reversal_date: "2026-07-21",
      reason: "Hoàn tác payment cũ bị thiếu nguồn",
      idempotency_key: "reverse-missing-source-0001",
    })).rejects.toThrow(/collection_id hoặc payment_id legacy/);
    expect(rpc).not.toHaveBeenCalled();
  });
});
