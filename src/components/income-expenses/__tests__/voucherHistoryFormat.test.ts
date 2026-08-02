// Nhật ký thay đổi phải đọc được bởi kế toán, không phải bởi lập trình viên.
// Dữ liệu mẫu dưới đây COPY NGUYÊN từ dry-run thật trên prod 30/07/2026
// (get_voucher_change_log_v1 sau khi huỷ PT2607112 rồi cuộn lại).

import { describe, expect, it } from "vitest";

import type { VoucherChangeLogEntry } from "@/hooks/income-expenses/flexMutations";
import {
  EMPTY_VALUE_TEXT,
  cancellationKindText,
  formatCellValue,
  formatMoney,
  humanizeChangeEntry,
  humanizeChangeLog,
} from "../voucherHistoryFormat";

const PROD_ENTRY_LIFECYCLE: VoucherChangeLogEntry = {
  at: "2026-07-30T00:36:44.965501+00:00",
  op: "UPDATE",
  cols: ["approval_status", "cancellation_kind", "posting_status"],
  after: {
    posting_status: "REVERSED",
    approval_status: "CANCELLED",
    cancellation_kind: "CANCELLED_AFTER_POSTING",
  },
  scope: "VOUCHER",
  before: {
    posting_status: "POSTED",
    approval_status: "APPROVED",
    cancellation_kind: null,
  },
  actor_id: "9a803710-c530-4a2e-9fb8-373b07ae4f03",
  actor_name: "DEMO Kế Toán",
};

const PROD_ENTRY_EDIT: VoucherChangeLogEntry = {
  at: "2026-07-30T00:36:44.965501+00:00",
  op: "UPDATE",
  cols: ["notes", "payer_name"],
  after: { notes: "MOI (dry-run WP3)", payer_name: "Nguoi nhan MOI" },
  scope: "VOUCHER",
  before: { notes: null, payer_name: null },
  actor_id: "9a803710-c530-4a2e-9fb8-373b07ae4f03",
  actor_name: "DEMO Kế Toán",
};

describe("formatCellValue", () => {
  it("null / chuỗi rỗng / mảng rỗng đều là (trống), không phải 'null'", () => {
    expect(formatCellValue("notes", null)).toBe(EMPTY_VALUE_TEXT);
    expect(formatCellValue("notes", undefined)).toBe(EMPTY_VALUE_TEXT);
    expect(formatCellValue("notes", "")).toBe(EMPTY_VALUE_TEXT);
    expect(formatCellValue("attachments", [])).toBe(EMPTY_VALUE_TEXT);
  });

  it("tiền in theo kiểu Việt Nam kèm đơn vị", () => {
    expect(formatCellValue("total_amount", "500000")).toBe(formatMoney(500000));
    expect(formatCellValue("total_amount", 600000)).toBe("600.000 đ");
    expect(formatCellValue("unit_price", "45000.00")).toBe("45.000 đ");
  });

  it("enum ra chữ người đọc, không ra hằng số hoa", () => {
    expect(formatCellValue("approval_status", "CANCELLED")).toBe("Đã huỷ");
    expect(formatCellValue("posting_status", "REVERSED")).toBe("Đã hoàn tác");
    expect(formatCellValue("type", "EXPENSE")).toBe("Phiếu chi");
    expect(formatCellValue("cancellation_kind", "CANCELLED_AFTER_POSTING")).toBe(
      "Huỷ sau khi đã ghi sổ",
    );
  });

  it("ngày THUẦN không bị lùi một ngày vì múi giờ", () => {
    // new Date('2026-07-30') là nửa đêm UTC — máy ở UTC-x sẽ ra 29/07 nếu dùng Date.
    expect(formatCellValue("voucher_date", "2026-07-30")).toBe("30/07/2026");
    expect(formatCellValue("start_date", "2026-01-01")).toBe("01/01/2026");
  });

  it("boolean và đính kèm nói bằng tiếng người", () => {
    expect(formatCellValue("business_result_accounting", true)).toBe("Có");
    expect(formatCellValue("business_result_accounting", false)).toBe("Không");
    expect(formatCellValue("attachments", ["a.jpg", "b.pdf"])).toBe("2 tệp");
  });
});

describe("humanizeChangeEntry — dữ liệu thật từ prod", () => {
  it("dòng sửa ghi chú đọc thành 'Ghi chú: (trống) → MOI…'", () => {
    const e = humanizeChangeEntry(PROD_ENTRY_EDIT);
    expect(e.headline).toBe("DEMO Kế Toán sửa phiếu");
    const byLabel = Object.fromEntries(e.changes.map((c) => [c.label, c]));
    expect(byLabel["Ghi chú"]).toMatchObject({
      before: EMPTY_VALUE_TEXT,
      after: "MOI (dry-run WP3)",
      technical: false,
    });
    expect(byLabel["Người nhận/trả"]).toMatchObject({
      before: EMPTY_VALUE_TEXT,
      after: "Nguoi nhan MOI",
    });
  });

  it("dòng vòng đời dịch cả ba cột trạng thái sang chữ", () => {
    const e = humanizeChangeEntry(PROD_ENTRY_LIFECYCLE);
    const byLabel = Object.fromEntries(e.changes.map((c) => [c.label, c]));
    expect(byLabel["Trạng thái duyệt"]).toMatchObject({
      before: "Đã ghi nhận",
      after: "Đã huỷ",
    });
    expect(byLabel["Trạng thái ghi sổ"]).toMatchObject({
      before: "Đã ghi sổ",
      after: "Đã hoàn tác",
    });
    expect(byLabel["Kiểu huỷ"]).toMatchObject({
      before: EMPTY_VALUE_TEXT,
      after: "Huỷ sau khi đã ghi sổ",
    });
    // Không cột nào trong ba cột này được rơi vào nhóm "kỹ thuật".
    expect(e.changes.every((c) => !c.technical)).toBe(true);
  });

  it("cột lạ vẫn hiện (nhật ký không được giấu) nhưng xếp SAU cột có nhãn", () => {
    const e = humanizeChangeEntry({
      ...PROD_ENTRY_EDIT,
      cols: ["source_ref_xyz", "notes"],
      before: { source_ref_xyz: "a", notes: null },
      after: { source_ref_xyz: "b", notes: "x" },
    });
    expect(e.changes.map((c) => c.column)).toEqual(["notes", "source_ref_xyz"]);
    expect(e.changes[1].technical).toBe(true);
    expect(e.changes[1].label).toBe("source_ref_xyz");
  });

  it("INSERT hạng mục chỉ nêu trường có nhãn, không đổ nguyên dòng ra màn hình", () => {
    const e = humanizeChangeEntry({
      at: "2026-07-30T00:00:00+00:00",
      op: "INSERT",
      cols: ["*created*"],
      before: null,
      after: {
        id: "11111111-1111-4111-8111-111111111111",
        organization_id: "dddd0000-0000-4000-8000-000000000001",
        income_expense_id: "22222222-2222-4222-8222-222222222222",
        description: "Tiền điện tháng 7",
        quantity: 1,
        unit_price: "450000.00",
        amount: "450000.00",
      },
      scope: "ITEM",
      actor_id: null,
      actor_name: null,
    });
    expect(e.headline).toBe("Hệ thống thêm hạng mục");
    expect(e.changes.map((c) => c.column).sort()).toEqual([
      "amount",
      "description",
      "quantity",
      "unit_price",
    ]);
    for (const c of e.changes) expect(c.before).toBe(EMPTY_VALUE_TEXT);
    expect(e.changes.find((c) => c.column === "amount")?.after).toBe("450.000 đ");
  });

  it("DELETE nêu giá trị CŨ và để vế sau trống", () => {
    const e = humanizeChangeEntry({
      at: "2026-07-30T00:00:00+00:00",
      op: "DELETE",
      cols: ["*deleted*"],
      before: { description: "Phí gửi xe", amount: "120000.00", id: "x" },
      after: null,
      scope: "ITEM",
      actor_id: null,
      actor_name: "DEMO Chủ Nhà",
    });
    expect(e.headline).toBe("DEMO Chủ Nhà xoá hạng mục");
    const byCol = Object.fromEntries(e.changes.map((c) => [c.column, c]));
    expect(byCol.description).toMatchObject({
      before: "Phí gửi xe",
      after: EMPTY_VALUE_TEXT,
    });
    expect(byCol.amount.before).toBe("120.000 đ");
    expect(byCol.id).toBeUndefined(); // cột kỹ thuật của INSERT/DELETE bị bỏ
  });

  it("mảng rỗng / null đầu vào không làm sập màn", () => {
    expect(humanizeChangeLog(null)).toEqual([]);
    expect(humanizeChangeLog(undefined)).toEqual([]);
    expect(humanizeChangeLog([PROD_ENTRY_LIFECYCLE, PROD_ENTRY_EDIT])).toHaveLength(2);
  });
});

describe("cancellationKindText", () => {
  it("nói rõ tiền có đụng tồn quỹ hay không", () => {
    expect(cancellationKindText("CANCELLED_AFTER_POSTING")?.hint).toContain(
      "trừ thẳng khỏi tồn quỹ",
    );
    expect(cancellationKindText("CANCELLED_UNPOSTED")?.hint).toContain(
      "không làm thay đổi số dư",
    );
    expect(cancellationKindText(null)).toBeNull();
    expect(cancellationKindText("KIEU_LA")).toBeNull();
  });
});
