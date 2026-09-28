import { describe, expect, it } from "vitest";
import {
  readIncomeExpenseDetails,
  hasCompleteVoucherDetail,
} from "../incomeExpenseDetailRead";
const org = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const header = (n: number) => ({
  posting_mode: null,
  posting_status: null,
  review_state: null,
  room_id: null,
  tenant_id: null,
  approved_by: null,
  approved_at: null,
  notes: null,
  payer_name: null,
  account_id: null,
  system_source: null,
  shareholder_id: null,
  contract_id: null,
  invoice_id: null,
  commission_kind: null,
  attachments: [],
  business_result_accounting: null,
  counts_in_business_result: true,
  receive_bank_name: null,
  receive_bank_account: null,
  creator_name: null,
  repeat_cycle: null,
  repeat_infinity: false,
  repeat_count: 0,
  repeat_remaining: 0,
  repeat_next_date: null,
  repeat_parent_id: null,
  verified_at: null,
  verified_by: null,
  verified_by_name: null,
  verified_note: null,
  reversal_of_income_expense_id: null,
  id: id(n),
  organization_id: org,
  user_id: id(9),
  building_id: id(8),
  code: "PT001",
  type: "INCOME",
  name: "Phiếu",
  voucher_date: "2026-09-28",
  total_amount: "100",
  kqkd_amount: "100",
  approval_status: "UNAPPROVED",
  approval_version: 1,
  posting_version: 1,
  created_at: "2026-09-28T00:00:00Z",
  updated_at: "2026-09-28T00:00:00Z",
});
const item = (n: number, parent = 1) => ({
  id: id(10000 + n),
  income_expense_id: id(parent),
  organization_id: org,
  income_expense_type_id: id(7),
  type_name: "Tiền thuê",
  category: null,
  is_deposit: false,
  description: null,
  quantity: "1",
  unit_price: "100",
  amount: "100",
  start_date: null,
  end_date: null,
});
const row = (n: number, items: ReturnType<typeof item>[] = []) => ({
  header: header(n),
  items,
  building_name: "Tòa A",
  expected_item_count: items.length,
  items_complete: true,
  issues: [],
});
describe("validated voucher detail reader", () => {
  it("keeps true zero-item vouchers without fabricating a total-as-item", async () => {
    const [v] = await readIncomeExpenseDetails(
      async () => ({ data: { rows: [row(1)] }, error: null }),
      org,
      [id(1)],
    );
    expect(v.items).toEqual([]);
    expect(hasCompleteVoucherDetail(v)).toBe(true);
  });
  it("rejects partial rows even if the RPC claims complete", async () => {
    await expect(
      readIncomeExpenseDetails(
        async () => ({
          data: { rows: [{ ...row(1), expected_item_count: 1 }] },
          error: null,
        }),
        org,
        [id(1)],
      ),
    ).rejects.toThrow();
  });
  it("rejects inaccessible requested vouchers instead of returning empty success", async () => {
    await expect(
      readIncomeExpenseDetails(
        async () => ({ data: { rows: [] }, error: null }),
        org,
        [id(1)],
      ),
    ).rejects.toThrow();
  });
  it("propagates transport errors", async () => {
    const error = new Error("network");
    await expect(
      readIncomeExpenseDetails(async () => ({ data: null, error }), org, [
        id(1),
      ]),
    ).rejects.toBe(error);
  });
  it("chunks 405 ids at 200, restores order, and does not identify by duplicate code", async () => {
    const sizes: number[] = [];
    const ids = Array.from({ length: 405 }, (_, n) => id(n + 1));
    const rows = await readIncomeExpenseDetails(
      async (_name, args) => {
        sizes.push(args.p_voucher_ids.length);
        return {
          data: {
            rows: args.p_voucher_ids
              .map((x) => row(Number(x.slice(-12))))
              .reverse(),
          },
          error: null,
        };
      },
      org,
      ids,
    );
    expect(sizes).toEqual([200, 200, 5]);
    expect(rows.map((x) => x.id)).toEqual(ids);
  });
  it("preserves more than 1000 items", async () => {
    const [v] = await readIncomeExpenseDetails(
      async () => ({
        data: {
          rows: [
            row(
              1,
              Array.from({ length: 1005 }, (_, n) => item(n)),
            ),
          ],
        },
        error: null,
      }),
      org,
      [id(1)],
    );
    expect(v.items).toHaveLength(1005);
  });
  it.each(["org", "parent", "duplicate", "label"])(
    "rejects %s inconsistencies",
    async (mode) => {
      const r = row(1, [item(1)]);
      if (mode === "org") r.header.organization_id = id(99);
      if (mode === "parent") r.items[0].income_expense_id = id(2);
      if (mode === "duplicate") {
        r.items.push(item(1));
        r.expected_item_count = 2;
      }
      if (mode === "label") r.issues = ["RELATED_DATA_UNAVAILABLE"] as never[];
      await expect(
        readIncomeExpenseDetails(
          async () => ({ data: { rows: [r] }, error: null }),
          org,
          [id(1)],
        ),
      ).rejects.toThrow();
    },
  );
  it("does not treat legacy unverified objects as complete", () => {
    expect(hasCompleteVoucherDetail({ items: [] })).toBe(false);
  });
});

it("accepts an unattached system voucher with actual zero items", async () => {
  const r = {
    ...row(1),
    header: {
      ...header(1),
      building_id: null,
      system_source: "adjustment.close_coc",
    },
    building_name: null,
  };
  const [v] = await readIncomeExpenseDetails(
    async () => ({ data: { rows: [r] }, error: null }),
    org,
    [id(1)],
  );
  expect(v.items).toEqual([]);
  expect(v.building_id).toBeNull();
  expect(hasCompleteVoucherDetail(v)).toBe(true);
});

it("rejects a partial header instead of fabricating editable defaults", async () => {
  const { notes: _notes, ...partial } = { ...header(1), notes: null };
  await expect(
    readIncomeExpenseDetails(
      async () => ({
        data: { rows: [{ ...row(1), header: partial }] },
        error: null,
      }),
      org,
      [id(1)],
    ),
  ).rejects.toThrow();
});
