import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  buildCreateIncomeExpenseRpcArgs,
  type CanonicalIncomeExpenseDraftValues,
  type CreateIncomeExpenseV1RpcArgs,
} from "../incomeExpenseCreateRpc";

const RPC_ARG_KEYS: Array<keyof CreateIncomeExpenseV1RpcArgs> = [
  "p_type",
  "p_name",
  "p_building_id",
  "p_room_id",
  "p_tenant_id",
  "p_contract_id",
  "p_payer_name",
  "p_receive_bank_account",
  "p_receive_bank_name",
  "p_account_id",
  "p_attachments",
  "p_business_result_accounting",
  "p_notes",
  "p_voucher_date",
  "p_items",
  "p_idempotency_key",
];

const ITEM_KEYS = [
  "income_expense_type_id",
  "description",
  "quantity",
  "unit_price",
  "start_date",
  "end_date",
];

function makeValues(
  overrides: Partial<CanonicalIncomeExpenseDraftValues> = {},
): CanonicalIncomeExpenseDraftValues {
  return {
    type: "INCOME",
    name: "Tiền thuê tháng 7",
    building_id: "00000000-0000-0000-0000-000000000001",
    room_id: "00000000-0000-0000-0000-000000000002",
    tenant_id: "00000000-0000-0000-0000-000000000003",
    contract_id: "00000000-0000-0000-0000-000000000004",
    payer_name: "Nguyễn Văn A",
    receive_bank_account: "0123456789",
    receive_bank_name: "Vietcombank",
    account_id: "00000000-0000-0000-0000-000000000005",
    voucher_date: "2026-07-16",
    business_result_accounting: null,
    attachments: ["https://example.test/receipt.jpg"],
    repeat_cycle: "NONE",
    repeat_infinity: false,
    repeat_count: 0,
    repeat_auto_approve: true,
    items: [
      {
        income_expense_type_id: "00000000-0000-0000-0000-000000000006",
        description: "Kỳ tháng 7",
        quantity: 2,
        unit_price: 1_500_000,
        start_date: "2026-07-01",
        end_date: "2026-07-31",
      },
    ],
    ...overrides,
  };
}

describe("buildCreateIncomeExpenseRpcArgs", () => {
  it("maps the exact 16 RPC arguments in signature order", () => {
    const result = buildCreateIncomeExpenseRpcArgs(
      makeValues(),
      "  request-123  ",
    );

    expect(Object.keys(result)).toEqual(RPC_ARG_KEYS);
    expect(result).toEqual({
      p_type: "INCOME",
      p_name: "Tiền thuê tháng 7",
      p_building_id: "00000000-0000-0000-0000-000000000001",
      p_room_id: "00000000-0000-0000-0000-000000000002",
      p_tenant_id: "00000000-0000-0000-0000-000000000003",
      p_contract_id: "00000000-0000-0000-0000-000000000004",
      p_payer_name: "Nguyễn Văn A",
      p_receive_bank_account: "0123456789",
      p_receive_bank_name: "Vietcombank",
      p_account_id: "00000000-0000-0000-0000-000000000005",
      p_attachments: ["https://example.test/receipt.jpg"],
      p_business_result_accounting: null,
      p_notes: null,
      p_voucher_date: "2026-07-16",
      p_items: [
        {
          income_expense_type_id: "00000000-0000-0000-0000-000000000006",
          description: "Kỳ tháng 7",
          quantity: 2,
          unit_price: 1_500_000,
          start_date: "2026-07-01",
          end_date: "2026-07-31",
        },
      ],
      p_idempotency_key: "request-123",
    });
  });

  it("normalizes omitted optional form values to RPC nulls", () => {
    const result = buildCreateIncomeExpenseRpcArgs(
      makeValues({
        room_id: undefined,
        tenant_id: undefined,
        contract_id: undefined,
        payer_name: undefined,
        receive_bank_account: undefined,
        receive_bank_name: undefined,
        business_result_accounting: undefined,
        repeat_cycle: undefined,
        repeat_infinity: undefined,
        repeat_count: undefined,
        repeat_auto_approve: true,
        attachments: [],
        items: [
          {
            income_expense_type_id: "type-id",
            description: undefined,
            quantity: 1,
            unit_price: 0,
            start_date: "2026-07-16",
            end_date: "2026-07-16",
          },
        ],
      }),
      "12345678",
    );

    expect(result).toMatchObject({
      p_room_id: null,
      p_tenant_id: null,
      p_contract_id: null,
      p_payer_name: null,
      p_receive_bank_account: null,
      p_receive_bank_name: null,
      p_business_result_accounting: null,
      p_notes: null,
      p_attachments: [],
      p_items: [
        {
          income_expense_type_id: "type-id",
          description: null,
          quantity: 1,
          unit_price: 0,
          start_date: "2026-07-16",
          end_date: "2026-07-16",
        },
      ],
    });
  });

  it.each([
    ["explicit null", null],
    ["empty legacy value", ""],
  ])("maps a pending draft without a selected cashbook: %s", (_label, accountId) => {
    const result = buildCreateIncomeExpenseRpcArgs(
      makeValues({ account_id: accountId }),
      "12345678",
    );

    expect(result.p_account_id).toBeNull();
  });

  it("preserves item ordering", () => {
    const firstItem = {
      income_expense_type_id: "first-type",
      description: "first",
      quantity: 1,
      unit_price: 100,
      start_date: "2026-07-01",
      end_date: "2026-07-15",
    };
    const secondItem = {
      income_expense_type_id: "second-type",
      description: "second",
      quantity: 2,
      unit_price: 200,
      start_date: "2026-07-16",
      end_date: "2026-07-31",
    };

    const result = buildCreateIncomeExpenseRpcArgs(
      makeValues({ items: [firstItem, secondItem] }),
      "12345678",
    );

    expect(result.p_items.map((item) => item.income_expense_type_id)).toEqual([
      "first-type",
      "second-type",
    ]);
  });

  it("copies only whitelisted fields into fresh header, attachment, and item objects", () => {
    const pollutedItem = Object.assign(
      {
        income_expense_type_id: "type-id",
        description: "description",
        quantity: 1,
        unit_price: 100,
        start_date: "2026-07-01",
        end_date: "2026-07-31",
      },
      {
        id: "client-owned-item-id",
        income_expense_id: "parent-id",
        organization_id: "foreign-org",
        amount: 999_999,
        created_at: "server-time",
      },
    );
    const values = Object.assign(
      makeValues({
        attachments: ["attachment"],
        items: [pollutedItem],
      }),
      {
        id: "client-owned-voucher-id",
        user_id: "another-user",
        organization_id: "foreign-org",
        creator_name: "spoofed actor",
        approval_status: "APPROVED",
        approved_by: "another-user",
        approved_at: "server-time",
        total_amount: 999_999,
        code: "PT-SPOOF",
        source_payload_hash: "client-hash",
        system_source: "client-source",
        notes: "must not be forwarded",
      },
    );

    const result = buildCreateIncomeExpenseRpcArgs(values, "12345678");

    expect(Object.keys(result)).toEqual(RPC_ARG_KEYS);
    expect(Object.keys(result.p_items[0])).toEqual(ITEM_KEYS);
    expect(result.p_notes).toBeNull();
    expect(result).not.toBe(values);
    expect(result.p_attachments).not.toBe(values.attachments);
    expect(result.p_items).not.toBe(values.items);
    expect(result.p_items[0]).not.toBe(values.items[0]);
  });

  it.each([
    ["non-NONE cycle", { repeat_cycle: "WEEK" as const }],
    ["repeat infinity", { repeat_infinity: true }],
    ["positive repeat count", { repeat_count: 1 }],
    ["negative nonzero repeat count", { repeat_count: -1 }],
    [
      "multiple recurrence signals",
      {
        repeat_cycle: "YEAR" as const,
        repeat_infinity: true,
        repeat_count: 12,
      },
    ],
  ])("rejects actual recurrence: %s", (_label, recurrence) => {
    expect(() =>
      buildCreateIncomeExpenseRpcArgs(
        makeValues(recurrence),
        "12345678",
      ),
    ).toThrow(/recurring/i);
  });

  it.each([
    ["omitted recurrence fields", undefined, undefined, undefined, undefined],
    ["repeat_auto_approve=false", "NONE" as const, false, 0, false],
    ["repeat_auto_approve=true", "NONE" as const, false, 0, true],
  ])(
    "allows non-recurring values: %s",
    (
      _label,
      repeatCycle,
      repeatInfinity,
      repeatCount,
      repeatAutoApprove,
    ) => {
      expect(() =>
        buildCreateIncomeExpenseRpcArgs(
          makeValues({
            repeat_cycle: repeatCycle,
            repeat_infinity: repeatInfinity,
            repeat_count: repeatCount,
            repeat_auto_approve: repeatAutoApprove,
          }),
          "12345678",
        ),
      ).not.toThrow();
    },
  );

  it.each([
    ["1234567", false],
    ["12345678", true],
    ["x".repeat(200), true],
    ["x".repeat(201), false],
    [`  ${"x".repeat(8)}  `, true],
    [`  ${"x".repeat(7)}  `, false],
    [`  ${"x".repeat(200)}  `, true],
    [`  ${"x".repeat(201)}  `, false],
  ])("validates idempotency boundary %#", (key, isValid) => {
    const call = () => buildCreateIncomeExpenseRpcArgs(makeValues(), key);

    if (isValid) {
      expect(call().p_idempotency_key).toBe(key.trim());
    } else {
      expect(call).toThrow(/8 to 200/);
    }
  });

  it("accepts exactly all trimmed ASCII-safe idempotency lengths from 8 through 200", () => {
    fc.assert(
      fc.property(fc.integer({ min: 8, max: 200 }), (length) => {
        const key = "k".repeat(length);
        const result = buildCreateIncomeExpenseRpcArgs(
          makeValues(),
          `\t${key}\n`,
        );

        expect(result.p_idempotency_key).toBe(key);
        expect(result.p_idempotency_key).toHaveLength(length);
      }),
      { numRuns: 100 },
    );
  });

  it.each([
    ["unicode", "request-đẹp"],
    ["space inside", "request 123"],
    ["slash", "request/123"],
    ["leading punctuation", "_request123"],
    ["control", `request${String.fromCharCode(0)}123`],
  ])("rejects a non-ASCII-safe idempotency key: %s", (_label, key) => {
    expect(() => buildCreateIncomeExpenseRpcArgs(makeValues(), key)).toThrow(
      /ASCII/,
    );
  });

  it("accepts every allowlisted idempotency character after an alphanumeric prefix", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-"), {
          minLength: 7,
          maxLength: 199,
        }),
        (suffix) => {
          const key = `A${suffix.join("")}`;
          expect(buildCreateIncomeExpenseRpcArgs(makeValues(), key).p_idempotency_key).toBe(
            key,
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rejects every trimmed idempotency length outside 8 through 200", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: 0, max: 7 }),
          fc.integer({ min: 201, max: 500 }),
        ),
        (length) => {
          expect(() =>
            buildCreateIncomeExpenseRpcArgs(
              makeValues(),
              `  ${"k".repeat(length)}  `,
            ),
          ).toThrow(/8 to 200/);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rejects every actual recurrence combination as a property", () => {
    const cycleArb = fc.constantFrom(
      "NONE" as const,
      "WEEK" as const,
      "MONTH" as const,
      "QUARTER" as const,
      "YEAR" as const,
    );

    fc.assert(
      fc.property(
        cycleArb,
        fc.boolean(),
        fc.integer({ min: -240, max: 240 }),
        fc.boolean(),
        (cycle, infinity, count, autoApprove) => {
          fc.pre(cycle !== "NONE" || infinity || count !== 0);

          expect(() =>
            buildCreateIncomeExpenseRpcArgs(
              makeValues({
                repeat_cycle: cycle,
                repeat_infinity: infinity,
                repeat_count: count,
                repeat_auto_approve: autoApprove,
              }),
              "12345678",
            ),
          ).toThrow(/recurring/i);
        },
      ),
      { numRuns: 100 },
    );
  });
});
