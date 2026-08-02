import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  flattenVoucherGroups,
  getReversalOf,
  groupNetAmount,
  groupReversalVouchers,
  isReversalVoucher,
  signedAmount,
  REVERSAL_SYSTEM_SOURCE_V5,
  type VoucherRowGroup,
} from "@/lib/voucherReversalGrouping";

interface Row {
  id: string;
  type: "INCOME" | "EXPENSE";
  total_amount: number;
  approval_status: "UNAPPROVED" | "APPROVED" | "CANCELLED";
  reversal_of_income_expense_id?: string | null;
  system_source?: string | null;
}

const row = (
  id: string,
  over: Partial<Row> = {},
): Row => ({
  id,
  type: "INCOME",
  total_amount: 10_000,
  approval_status: "APPROVED",
  reversal_of_income_expense_id: null,
  system_source: null,
  ...over,
});

/** Tổng tiền có dấu của một mảng phiếu — chính là "tiền trên màn". */
const sumSigned = (rows: readonly Row[]) =>
  rows.reduce((s, r) => s + signedAmount(r), 0);

describe("groupReversalVouchers — gộp ẩn phiếu đối ứng di sản", () => {
  it("gộp phiếu đối ứng vào ĐÚNG dòng phiếu gốc, giữ vị trí của gốc", () => {
    // Thứ tự vào giống list thật: voucher_date giảm dần ⇒ đối ứng đứng trước.
    const rev = row("rev", {
      type: "EXPENSE",
      reversal_of_income_expense_id: "goc",
      system_source: REVERSAL_SYSTEM_SOURCE_V5,
    });
    const other = row("other");
    const goc = row("goc");

    const groups = groupReversalVouchers([rev, other, goc]);

    expect(groups.map((g) => g.anchor.id)).toEqual(["other", "goc"]);
    expect(groups[1].reversals.map((r) => r.id)).toEqual(["rev"]);
    expect(groupNetAmount(groups[1])).toBe(0);
  });

  it("KHÔNG gộp khi phiếu gốc không có trong trang đang vẽ (lệch tháng)", () => {
    // Ca thật trên prod: PC2607106 (29/07) hoàn tác PT2606212 (30/06) — lọc
    // tháng 7 thì chỉ có phiếu đối ứng. Nó phải đứng nguyên thành dòng riêng.
    const rev = row("rev", {
      type: "EXPENSE",
      reversal_of_income_expense_id: "goc-thang-truoc",
    });

    const groups = groupReversalVouchers([rev]);

    expect(groups).toEqual([{ anchor: rev, reversals: [] }]);
  });

  it("KHÔNG gộp phiếu đối ứng đã huỷ — nó không hoàn tác được gì", () => {
    const rev = row("rev", {
      type: "EXPENSE",
      approval_status: "CANCELLED",
      reversal_of_income_expense_id: "goc",
    });
    const goc = row("goc");

    const groups = groupReversalVouchers([rev, goc]);

    expect(groups.map((g) => g.anchor.id)).toEqual(["rev", "goc"]);
    expect(groups.every((g) => g.reversals.length === 0)).toBe(true);
  });

  it("không gộp bắc cầu: chuỗi hoàn tác để nguyên, không phiếu nào bị đếm hai lần", () => {
    const q = row("q");
    const p = row("p", { type: "EXPENSE", reversal_of_income_expense_id: "q" });
    const r = row("r", { reversal_of_income_expense_id: "p" });

    const groups = groupReversalVouchers([r, p, q]);
    const flat = flattenVoucherGroups(groups);

    expect(flat).toHaveLength(3);
    expect(new Set(flat.map((x) => x.id)).size).toBe(3);
  });

  it("bỏ qua FK tự trỏ chính mình", () => {
    const self = row("self", { reversal_of_income_expense_id: "self" });
    expect(groupReversalVouchers([self])).toEqual([
      { anchor: self, reversals: [] },
    ]);
  });

  it("gom được nhiều phiếu đối ứng trên cùng một gốc", () => {
    const goc = row("goc", { total_amount: 20_000 });
    const r1 = row("r1", {
      type: "EXPENSE",
      total_amount: 10_000,
      reversal_of_income_expense_id: "goc",
    });
    const r2 = row("r2", {
      type: "EXPENSE",
      total_amount: 10_000,
      reversal_of_income_expense_id: "goc",
    });

    const groups = groupReversalVouchers([r1, r2, goc]);

    expect(groups).toHaveLength(1);
    expect(groups[0].reversals.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(groupNetAmount(groups[0])).toBe(0);
  });

  it("nhận diện phiếu đối ứng qua CẢ FK lẫn system_source V5", () => {
    expect(isReversalVoucher(row("a", { reversal_of_income_expense_id: "b" }))).toBe(true);
    expect(isReversalVoucher(row("a", { system_source: REVERSAL_SYSTEM_SOURCE_V5 }))).toBe(true);
    expect(isReversalVoucher(row("a"))).toBe(false);
    expect(getReversalOf(row("a", { reversal_of_income_expense_id: "" }))).toBeNull();
    expect(getReversalOf(undefined)).toBeNull();
  });
});

describe("bất biến TIỀN — gộp hiển thị không được làm suy suyển đồng nào", () => {
  const arbRows = fc
    .uniqueArray(fc.string({ minLength: 1, maxLength: 4 }), {
      minLength: 0,
      maxLength: 12,
    })
    .chain((ids) =>
      fc.tuple(
        fc.constant(ids),
        fc.array(
          fc.record({
            type: fc.constantFrom<"INCOME" | "EXPENSE">("INCOME", "EXPENSE"),
            total_amount: fc.integer({ min: 0, max: 5_000_000 }),
            approval_status: fc.constantFrom<Row["approval_status"]>(
              "UNAPPROVED",
              "APPROVED",
              "CANCELLED",
            ),
            // FK trỏ bừa: có thể là id có thật, id không tồn tại, hoặc null.
            link: fc.option(fc.string({ minLength: 1, maxLength: 4 }), {
              nil: null,
            }),
          }),
          { minLength: ids.length, maxLength: ids.length },
        ),
      ),
    )
    .map(([ids, bodies]) =>
      ids.map((id, i) => ({
        id,
        type: bodies[i].type,
        total_amount: bodies[i].total_amount,
        approval_status: bodies[i].approval_status,
        reversal_of_income_expense_id: bodies[i].link,
      })) as Row[],
    );

  it("trải phẳng lại là một HOÁN VỊ của mảng vào (không mất, không nhân bản)", () => {
    fc.assert(
      fc.property(arbRows, (rows) => {
        const flat = flattenVoucherGroups(groupReversalVouchers(rows));
        expect(flat).toHaveLength(rows.length);
        expect([...flat].sort(byId)).toEqual([...rows].sort(byId));
      }),
    );
  });

  it("tổng tiền có dấu TRƯỚC và SAU khi gộp bằng nhau tuyệt đối", () => {
    fc.assert(
      fc.property(arbRows, (rows) => {
        const groups = groupReversalVouchers(rows);
        const tongTruoc = sumSigned(rows);
        const tongSau = groups.reduce((s, g) => s + groupNetAmount(g), 0);
        expect(tongSau).toBe(tongTruoc);
      }),
    );
  });

  it("mỗi phiếu xuất hiện đúng MỘT lần — không vừa làm dòng chính vừa bị gộp", () => {
    fc.assert(
      fc.property(arbRows, (rows) => {
        const groups = groupReversalVouchers(rows);
        const anchors = groups.map((g) => g.anchor.id);
        const merged = groups.flatMap((g) => g.reversals.map((r) => r.id));
        expect(new Set([...anchors, ...merged]).size).toBe(rows.length);
        expect(anchors.filter((id) => merged.includes(id))).toEqual([]);
      }),
    );
  });

  it("giữ nguyên thứ tự tương đối của các dòng chính so với mảng vào", () => {
    fc.assert(
      fc.property(arbRows, (rows) => {
        const anchors = groupReversalVouchers(rows).map((g) => g.anchor.id);
        const viTri = new Map(rows.map((r, i) => [r.id, i]));
        const chiSo = anchors.map((id) => viTri.get(id)!);
        expect(chiSo).toEqual([...chiSo].sort((a, b) => a - b));
      }),
    );
  });
});

const byId = (a: Row, b: Row) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

describe("groupNetAmount", () => {
  it("cụm không có đối ứng thì ròng = tiền có dấu của chính nó", () => {
    const g: VoucherRowGroup<Row> = {
      anchor: row("a", { type: "EXPENSE", total_amount: 7_000 }),
      reversals: [],
    };
    expect(groupNetAmount(g)).toBe(-7_000);
  });
});
