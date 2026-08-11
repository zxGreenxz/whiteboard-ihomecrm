import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  buildCreateContractRpcArgs,
  calculateContractDepositBalance,
  createContractV2,
  prepareContractCreateRequest,
  type ContractCreatePayload,
  type ContractCreateRpcInvoker,
  type CreateContractV2Response,
} from "../contractCreateRpc";

const KEY = "contract-create-00000001";
const contractMigration = readFileSync(
  "supabase/migrations/20260721090000_contract_create_v2.sql",
  "utf8",
);

interface BuiltContractPayload {
  contract: Record<string, unknown>;
  customers: Array<Record<string, unknown>>;
  deposit_receipts: Array<Record<string, unknown>>;
  existing_deposit_voucher_ids: string[];
  first_invoice?: {
    items: Array<Record<string, unknown>>;
    issue_date: string | null;
    due_date: string | null;
  };
}

const asBuiltPayload = (value: unknown) => value as BuiltContractPayload;

const PAYLOAD: ContractCreatePayload = {
  contract: {
    room_id: "11111111-1111-4111-8111-111111111111",
    signed_date: "2026-07-21T12:30:00+07:00",
    start_date: "2026-07-22T00:00:00+07:00",
    end_date: "2027-07-21T00:00:00+07:00",
    rent_price: 4_000_000,
    total_deposit: 4_000_000,
    payment_cycle: "MONTHLY",
    end_billing_date: "2026-08-05T23:59:59+07:00",
    notes: "  ghi chu hop dong  ",
    discounts: { months: 2, amount_per_month: 300_000 },
    deposit_debt_mode: "FIRST_INVOICE",
  },
  customers: [
    {
      customer_id: "22222222-2222-4222-8222-222222222222",
      is_representative: true,
      notes: "  dai dien  ",
    },
  ],
  services: [
    {
      service_id: "33333333-3333-4333-8333-333333333333",
      unit_price: 100_000,
      initial_reading: 12,
    },
  ],
  deposit_receipts: [
    {
      amount: 1_000_000,
      account_id: "44444444-4444-4444-8444-444444444444",
      received_date: "2026-07-21T08:00:00+07:00",
      attachments: ["https://example.com/deposit.jpg"],
    },
  ],
  existing_deposit_voucher_ids: [
    "55555555-5555-4555-8555-555555555555",
  ],
  first_invoice: {
    items: [
      {
        type: "RENT",
        accounting_class: "REVENUE",
        description: "Tien phong",
        unit_price: 1_290_323,
        quantity: 1,
        from_date: "2026-07-22T00:00:00+07:00",
        to_date: "2026-08-05T00:00:00+07:00",
      },
      {
        type: "OTHER",
        accounting_class: "DEPOSIT",
        description: "Tien coc",
        unit_price: 3_000_000,
        quantity: 1,
      },
    ],
    discount_amount: 300_000,
    discount_notes: "  thang 1/2  ",
    issue_date: "2026-07-21T13:00:00+07:00",
    due_date: "2026-08-05T00:00:00+07:00",
    notes: "  invoice dau  ",
  },
};

describe("calculateContractDepositBalance", () => {
  it.each([1, 9_999])(
    "requires DEBT or FIRST_INVOICE for a %d VND shortfall",
    (shortfall) => {
      expect(calculateContractDepositBalance(10_000, 10_000 - shortfall)).toEqual(
        expect.objectContaining({
          shortfall,
          requiresResolution: true,
          isOverpaid: false,
        }),
      );
    },
  );

  it("flags over-deposit before the RPC is submitted", () => {
    expect(calculateContractDepositBalance(4_000_000, 4_000_001)).toEqual(
      expect.objectContaining({
        overpayment: 1,
        requiresResolution: false,
        isOverpaid: true,
      }),
    );
  });

  it("ignores sub-cent numeric noise only", () => {
    expect(calculateContractDepositBalance(100, 99.995)).toEqual(
      expect.objectContaining({
        requiresResolution: false,
        isOverpaid: false,
      }),
    );
  });
});

describe("buildCreateContractRpcArgs", () => {
  it("maps the atomic payload and normalizes all dates to date-only", () => {
    const request = prepareContractCreateRequest(PAYLOAD, `  ${KEY}  `);
    const args = buildCreateContractRpcArgs(request);
    const payload = asBuiltPayload(args.p_payload);

    expect(args.p_idempotency_key).toBe(KEY);
    expect(payload.contract).toEqual(
      expect.objectContaining({
        signed_date: "2026-07-21",
        start_date: "2026-07-22",
        end_date: "2027-07-21",
        start_billing_date: "2026-07-22",
        end_billing_date: "2026-08-05",
        notes: "ghi chu hop dong",
        deposit_debt_mode: "FIRST_INVOICE",
      }),
    );
    expect(payload.customers[0].notes).toBe("dai dien");
    expect(payload.deposit_receipts[0]).toEqual({
      amount: 1_000_000,
      account_id: "44444444-4444-4444-8444-444444444444",
      received_date: "2026-07-21",
      attachments: ["https://example.com/deposit.jpg"],
      creator_name: null,
    });
    expect(payload.existing_deposit_voucher_ids).toEqual(
      PAYLOAD.existing_deposit_voucher_ids,
    );
    expect(payload.first_invoice?.items).toEqual([
      expect.objectContaining({
        accounting_class: "REVENUE",
        from_date: "2026-07-22",
        to_date: "2026-08-05",
      }),
      expect.objectContaining({
        type: "OTHER",
        accounting_class: "DEPOSIT",
      }),
    ]);
    expect(payload.first_invoice?.issue_date).toBe("2026-07-21");
    expect(payload.first_invoice?.due_date).toBe("2026-08-05");
  });

  it("matches the server fallback when end_billing_date is omitted", () => {
    const request = prepareContractCreateRequest(
      {
        ...PAYLOAD,
        contract: {
          ...PAYLOAD.contract,
          start_billing_date: undefined,
          end_billing_date: undefined,
        },
        first_invoice: null,
      },
      KEY,
    );
    const payload = asBuiltPayload(buildCreateContractRpcArgs(request).p_payload);
    expect(payload.contract.start_billing_date).toBe("2026-07-22");
    expect(payload.contract.end_billing_date).toBe("2026-07-22");
    expect(payload.first_invoice).toBeUndefined();
  });

  it("keeps one idempotency key stable for repeated attempts of a prepared request", () => {
    const request = prepareContractCreateRequest(PAYLOAD, KEY);
    expect(buildCreateContractRpcArgs(request).p_idempotency_key).toBe(KEY);
    expect(buildCreateContractRpcArgs(request).p_idempotency_key).toBe(KEY);
  });

  it.each(["short", "has space key", "bad!char-key", "bad/key/0001"])(
    "rejects invalid idempotency key %s",
    (key) => {
      expect(() => prepareContractCreateRequest(PAYLOAD, key)).toThrow(
        /idempotency_key/,
      );
    },
  );
});

describe("create_contract_v2 date guards", () => {
  it("rejects first-invoice dates outside the signed and billing bounds", () => {
    expect(contractMigration).toContain(
      "Hạn trả hóa đơn đầu phải nằm trong kỳ tính tiền đầu",
    );
    expect(contractMigration).toContain(
      "Ngày phát hành hóa đơn đầu phải từ ngày ký đến hạn trả",
    );
    expect(contractMigration).not.toContain("v_issue_date := LEAST(");
  });

  it("normalizes revenue item dates inside the first billing period", () => {
    expect(contractMigration).toContain(
      "Kỳ hạng mục doanh thu phải nằm trong kỳ tính tiền đầu",
    );
    expect(contractMigration).toContain(
      "THEN COALESCE(NULLIF(v_item->>'from_date', '')::date, v_start_billing)",
    );
    expect(contractMigration).toContain(
      "THEN COALESCE(NULLIF(v_item->>'to_date', '')::date, v_end_billing)",
    );
  });
});

describe("create_contract_v2 customer locking", () => {
  it("validates and locks the full customer set in deterministic shared order", () => {
    const validationStart = contractMigration.indexOf(
      "WITH requested_customers AS MATERIALIZED",
    );
    const validationEnd = contractMigration.indexOf(
      "FOR v_service IN SELECT value FROM jsonb_array_elements(v_services) LOOP",
      validationStart,
    );
    const customerValidation = contractMigration.slice(
      validationStart,
      validationEnd,
    );

    expect(validationStart).toBeGreaterThan(-1);
    expect(validationEnd).toBeGreaterThan(validationStart);
    expect(customerValidation).toContain(
      "locked_customers AS MATERIALIZED",
    );
    expect(customerValidation).toMatch(
      /ORDER BY customer_row\.id\s+FOR SHARE OF customer_row/,
    );
    expect(customerValidation).toContain("INTO v_locked_customer_count");
    expect(customerValidation).toContain(
      "IF v_locked_customer_count <> v_customer_count THEN",
    );
    expect(customerValidation).not.toContain(
      "FOR v_customer IN SELECT value FROM jsonb_array_elements(v_customers) LOOP",
    );
    expect(customerValidation).not.toContain("FOR UPDATE");
  });
});

describe("create_contract_v2 existing deposit lifecycle", () => {
  it("links an approved orphan voucher and removes its orphan marker atomically", () => {
    expect(contractMigration).toContain("DO $deposit_link_backfill$");
    expect(contractMigration).toContain(
      "Existing contract deposit link conflicts with voucher lifecycle",
    );
    expect(contractMigration).toContain("INSERT INTO public.contract_deposit_links");
    expect(contractMigration).toContain("SET contract_id = v_contract_id");
    expect(contractMigration).toContain(
      "Phiếu cọc đã đổi trạng thái trong lúc tạo hợp đồng",
    );
  });

  it("returns a completed idempotent operation before rejecting OCCUPIED rooms", () => {
    const replayIndex = contractMigration.indexOf(
      "IF v_operation.completed_at IS NOT NULL THEN",
    );
    const roomStateIndex = contractMigration.indexOf(
      "IF v_room_status NOT IN ('AVAILABLE', 'RESERVED') THEN",
    );
    expect(replayIndex).toBeGreaterThan(-1);
    expect(roomStateIndex).toBeGreaterThan(replayIndex);
  });

  it("does not charge the canary cap again for a previously received deposit", () => {
    expect(contractMigration).toContain(
      "v_new_deposit_receipts := v_new_deposit_receipts + v_amount",
    );
    expect(contractMigration).toContain(
      "round(v_new_deposit_receipts + COALESCE(v_total_amount, 0), 2)",
    );
    expect(contractMigration).not.toContain(
      "round(v_deposit_paid + COALESCE(v_total_amount, 0), 2)",
    );
  });
});

describe("createContractV2", () => {
  it("uses exactly one canonical RPC and returns its response", async () => {
    const response: Pick<
      CreateContractV2Response,
      "invoice" | "deposit_paid" | "deposit_shortfall"
    > & { contract: Pick<CreateContractV2Response["contract"], "id"> } = {
      contract: { id: "66666666-6666-4666-8666-666666666666" },
      invoice: null,
      deposit_paid: 1_000_000,
      deposit_shortfall: 3_000_000,
    };
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: response, error: null }) as unknown as ContractCreateRpcInvoker;

    await expect(
      createContractV2(rpc, prepareContractCreateRequest(PAYLOAD, KEY)),
    ).resolves.toEqual(response);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      "create_contract_v2",
      expect.objectContaining({ p_idempotency_key: KEY }),
    );
  });

  it("throws the RPC error without a legacy or best-effort fallback", async () => {
    const error = { code: "23505", message: "room already has an active contract" };
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: null, error }) as unknown as ContractCreateRpcInvoker;

    await expect(
      createContractV2(rpc, prepareContractCreateRequest(PAYLOAD, KEY)),
    ).rejects.toBe(error);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
