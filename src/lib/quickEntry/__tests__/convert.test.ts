import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  groupByPlace,
  idempotencyKeyFor,
  toCreateIncomeExpenseInput,
  toPersonalTransactionValues,
} from "../convert";
import type { DraftLine, QuickDraft } from "../draft";

const DRAFT_ID = "0f1e2d3c-4b5a-4987-8765-43210fedcba9";
const SERVER_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;

const line = (over: Partial<DraftLine> = {}): DraftLine => ({
  description: "bóng đèn",
  amount: 120_000,
  categoryId: "t3",
  personalCategory: null,
  periodStart: null,
  periodEnd: null,
  ...over,
});

const company = (over: Partial<QuickDraft> = {}): QuickDraft => ({
  id: DRAFT_ID,
  mode: "company",
  date: "2026-10-01",
  name: "Mua vật tư 102LVT",
  vendor: "Điện nước Minh Phát",
  buildingId: "b102",
  roomId: "r301",
  accountId: "acc1",
  attachmentUrls: ["https://cdn.test/a.jpg"],
  lines: [line()],
  ...over,
});

describe("idempotencyKeyFor", () => {
  it("khoá cố định theo thẻ, khớp regex máy chủ", () => {
    expect(idempotencyKeyFor(DRAFT_ID)).toBe(`qe-${DRAFT_ID}`);
    expect(idempotencyKeyFor(DRAFT_ID)).toMatch(SERVER_KEY_RE);
  });

  it("id thẻ có ký tự lạ ⇒ bỏ ký tự lạ, vẫn khớp regex", () => {
    expect(idempotencyKeyFor("ab cd/ef#12345")).toBe("qe-abcdef12345");
  });

  it("id quá ngắn ⇒ ném lỗi thay vì gửi khoá máy chủ sẽ từ chối", () => {
    expect(() => idempotencyKeyFor("ab")).toThrow();
  });
});

describe("toCreateIncomeExpenseInput", () => {
  it("map đúng từng trường của create_income_expense_v1", () => {
    const out = toCreateIncomeExpenseInput(company());
    expect(out).toEqual({
      type: "EXPENSE",
      name: "Mua vật tư 102LVT",
      building_id: "b102",
      room_id: "r301",
      tenant_id: null,
      contract_id: null,
      payer_name: "Điện nước Minh Phát",
      receive_bank_account: null,
      receive_bank_name: null,
      account_id: "acc1",
      voucher_date: "2026-10-01",
      business_result_accounting: null,
      attachments: ["https://cdn.test/a.jpg"],
      repeat_cycle: "NONE",
      repeat_infinity: false,
      repeat_count: 0,
      repeat_auto_approve: true,
      items: [
        {
          income_expense_type_id: "t3",
          description: "bóng đèn",
          quantity: 1,
          unit_price: 120_000,
          start_date: "2026-10-01",
          end_date: "2026-10-01",
        },
      ],
      idempotency_key: `qe-${DRAFT_ID}`,
    });
  });

  it("kỳ áp dụng của dòng (tiền điện tháng 9) đi vào start/end của item", () => {
    const out = toCreateIncomeExpenseInput(
      company({ lines: [line({ periodStart: "2026-09-01", periodEnd: "2026-09-30" })] }),
    );
    expect(out.items[0].start_date).toBe("2026-09-01");
    expect(out.items[0].end_date).toBe("2026-09-30");
  });

  it("tên trống ⇒ lấy mô tả dòng đầu; tên quá dài cắt còn 500 ký tự", () => {
    expect(toCreateIncomeExpenseInput(company({ name: "  " })).name).toBe("bóng đèn");
    expect(toCreateIncomeExpenseInput(company({ name: "x".repeat(600) })).name).toHaveLength(500);
  });

  it("mô tả dòng rỗng ⇒ null, quá dài cắt còn 1000 ký tự", () => {
    const out = toCreateIncomeExpenseInput(company({ lines: [line({ description: "" }), line({ description: "y".repeat(1200) })] }));
    expect(out.items[0].description).toBeNull();
    expect(out.items[1].description).toHaveLength(1000);
  });

  it("ảnh không phải https bị bỏ (writer v1 chỉ nhận https)", () => {
    const out = toCreateIncomeExpenseInput(company({ attachmentUrls: ["blob:x", "https://cdn.test/b.jpg", "http://cdn.test/c.jpg"] }));
    expect(out.attachments).toEqual(["https://cdn.test/b.jpg"]);
  });

  it("khoản cá nhân không được đi đường phiếu công ty", () => {
    expect(() => toCreateIncomeExpenseInput(company({ mode: "personal" }))).toThrow();
  });

  it("property: giữ tổng tiền, số lượng 1, dòng nào cũng có kỳ, khoá khớp regex", () => {
    const amounts = fc.array(fc.integer({ min: 1, max: 10_000_000_000 }), { minLength: 1, maxLength: 30 });
    fc.assert(
      fc.property(amounts, (list) => {
        const out = toCreateIncomeExpenseInput(company({ lines: list.map((amount) => line({ amount })) }));
        const total = out.items.reduce((s, it) => s + it.quantity * it.unit_price, 0);
        expect(total).toBe(list.reduce((s, a) => s + a, 0));
        expect(out.items.every((it) => it.quantity === 1 && !!it.start_date && !!it.end_date)).toBe(true);
        expect(out.idempotency_key).toMatch(SERVER_KEY_RE);
      }),
    );
  });
});

describe("toPersonalTransactionValues", () => {
  const personal = (lines: DraftLine[]): QuickDraft => ({
    ...company(),
    mode: "personal",
    buildingId: null,
    roomId: null,
    accountId: null,
    attachmentUrls: [],
    name: "Đi chợ",
    lines,
  });

  it("gộp theo danh mục cá nhân: mỗi danh mục một khoản, cộng tiền, nối mô tả", () => {
    const out = toPersonalTransactionValues(
      personal([
        line({ description: "rau", amount: 20_000, categoryId: null, personalCategory: "Ăn uống" }),
        line({ description: "dầu gội", amount: 85_000, categoryId: null, personalCategory: "Mua sắm" }),
        line({ description: "thịt", amount: 120_000, categoryId: null, personalCategory: "Ăn uống" }),
      ]),
    );
    expect(out).toEqual([
      { type: "EXPENSE", amount: 140_000, txn_date: "2026-10-01", category: "Ăn uống", description: "Đi chợ: rau; thịt" },
      { type: "EXPENSE", amount: 85_000, txn_date: "2026-10-01", category: "Mua sắm", description: "Đi chợ: dầu gội" },
    ]);
  });

  it("dòng không có danh mục ⇒ category null", () => {
    const out = toPersonalTransactionValues(personal([line({ description: "", amount: 50_000, categoryId: null, personalCategory: null })]));
    expect(out).toEqual([{ type: "EXPENSE", amount: 50_000, txn_date: "2026-10-01", category: null, description: "Đi chợ" }]);
  });

  it("khoản công ty không được đi đường ví cá nhân", () => {
    expect(() => toPersonalTransactionValues(company())).toThrow();
  });
});

describe("groupByPlace", () => {
  it("khác toà hoặc khác phòng ⇒ nhóm riêng, giữ thứ tự xuất hiện đầu tiên", () => {
    const groups = groupByPlace([
      { buildingId: "b102", roomId: "r301", line: line({ description: "a" }) },
      { buildingId: "b15", roomId: null, line: line({ description: "b" }) },
      { buildingId: "b102", roomId: "r301", line: line({ description: "c" }) },
      { buildingId: "b102", roomId: null, line: line({ description: "d" }) },
    ]);
    expect(groups.map((g) => [g.buildingId, g.roomId, g.lines.map((l) => l.description)])).toEqual([
      ["b102", "r301", ["a", "c"]],
      ["b15", null, ["b"]],
      ["b102", null, ["d"]],
    ]);
  });
});
