import { describe, expect, it } from "vitest";

import {
  accountChangeNeedsReason,
  approvalEditPatch,
  approvalErrorMessage,
  buildRevisionPatch,
  canReviseVoucher,
  diffRevisionSnapshots,
  formatRevisionItem,
  incomeExpenseRevisionSchema,
  isStaleVersionError,
  isSystemRevisableVoucher,
  requiresRevisionReason,
  revisionErrorMessage,
  revisionItemsChanged,
  summarizePendingRevisions,
  voucherEditAction,
  type IncomeExpenseRevision,
  type RevisableValues,
  type RevisionFormValues,
  type VoucherSnapshot,
} from "@/lib/incomeExpenseRevision";

const truoc: VoucherSnapshot = {
  type: "EXPENSE",
  name: "Mua zalo Business",
  voucher_date: "2026-09-23",
  building: { id: "b1", name: "Kho Văn Phòng Chung" },
  room: null,
  tenant: null,
  contract: null,
  account: { id: "a1", name: "Hiệp chi" },
  payer_name: null,
  receive_bank_account: null,
  receive_bank_name: null,
  business_result_accounting: null,
  notes: null,
  attachments: ["https://x/1.png"],
  repeat: { cycle: "NONE", count: 0, infinity: false, auto_approve: true },
  total_amount: 1791000,
  items: [
    { type_id: "t1", type_name: "Phần mềm", description: null, quantity: 1, unit_price: 1791000, amount: 1791000,
      start_date: "2026-09-01", end_date: "2026-09-30" },
  ],
};

const base: RevisableValues = {
  type: "EXPENSE",
  building_id: "b1",
  account_id: "a1",
  business_result_accounting: null,
  items: [
    { income_expense_type_id: "t1", description: "x", quantity: 1, unit_price: 100, start_date: "2026-09-01", end_date: "2026-09-30" },
  ],
};

function rev(no: number, kind: IncomeExpenseRevision["kind"], before: VoucherSnapshot, after: VoucherSnapshot): IncomeExpenseRevision {
  return {
    id: `r${no}`, income_expense_id: "v1", revision_no: no, kind, actor_id: "u1", actor_name: "NATHAN",
    reason: null, changed_fields: [], before_snapshot: before, after_snapshot: after, created_at: "2026-09-25T08:00:00Z",
  };
}

describe("diffRevisionSnapshots", () => {
  it("chỉ trả các trường khác nhau, nhãn tiếng Việt, tiền theo định dạng đ", () => {
    const sau: VoucherSnapshot = {
      ...truoc,
      name: "Mua Zalo Business năm 2026",
      total_amount: 1792000,
      items: [{ ...truoc.items![0], unit_price: 1792000, amount: 1792000 }],
    };
    const rows = diffRevisionSnapshots(truoc, sau);
    expect(rows.map((r) => r.field)).toEqual(["name", "items"]);
    expect(rows[0]).toMatchObject({ label: "Tên phiếu", before: ["Mua zalo Business"], after: ["Mua Zalo Business năm 2026"] });
    expect(rows[1].label).toBe("Hạng mục");
    expect(rows[1].before.at(-1)).toBe("Tổng: 1.791.000 đ");
    expect(rows[1].after.at(-1)).toBe("Tổng: 1.792.000 đ");
  });

  it("đổi ảnh chứng từ cùng số lượng vẫn là thay đổi", () => {
    const rows = diffRevisionSnapshots(truoc, { ...truoc, attachments: ["https://x/2.png"] });
    expect(rows.map((r) => r.field)).toEqual(["attachments"]);
  });

  it("đổi hình thức thu: so hình thức + sổ nhận", () => {
    const rows = diffRevisionSnapshots(
      { payment_method: "TK", account: { id: "a", name: "MBHIEP" } },
      { payment_method: "TM", account: { id: "b", name: "Hiệp Thu" } },
      "COLLECTION_METHOD",
    );
    expect(rows).toEqual([
      { field: "payment_method", label: "Hình thức thu", before: ["Chuyển khoản"], after: ["Tiền mặt"] },
      { field: "account_id", label: "Sổ quỹ", before: ["MBHIEP"], after: ["Hiệp Thu"] },
    ]);
  });
});

describe("đổi Thu ↔ Chi: mã phiếu mới", () => {
  it("hiện dòng Mã phiếu cũ → mới cạnh Loại phiếu", () => {
    const rows = diffRevisionSnapshots(
      { ...truoc, code: "PC2609105" },
      { ...truoc, code: "PT2609150", type: "INCOME" },
    );
    expect(rows.map((r) => [r.label, r.before, r.after])).toEqual([
      ["Loại phiếu", ["Phiếu chi"], ["Phiếu thu"]],
      ["Mã phiếu", ["PC2609105"], ["PT2609150"]],
    ]);
  });
  it("ảnh chụp không có mã (bản cũ) ⇒ không báo đổi mã giả", () => {
    expect(diffRevisionSnapshots({ ...truoc }, { ...truoc }).map((r) => r.field)).toEqual([]);
  });
});

describe("summarizePendingRevisions", () => {
  it("so ảnh TRƯỚC lần sửa đầu với ảnh SAU lần sửa cuối, bỏ qua đổi hình thức thu", () => {
    const b = { ...truoc, name: "B" };
    const c = { ...truoc, name: "C" };
    const tom = summarizePendingRevisions([
      rev(2, "EDIT_PENDING", b, c),
      rev(3, "COLLECTION_METHOD", { payment_method: "TK" }, { payment_method: "TM" }),
      rev(1, "EDIT_PENDING", truoc, b),
    ]);
    expect(tom?.count).toBe(2);
    expect(tom?.diff).toEqual([
      { field: "name", label: "Tên phiếu", before: ["Mua zalo Business"], after: ["C"] },
    ]);
  });

  it("chưa sửa lần nào ⇒ null", () => {
    expect(summarizePendingRevisions([])).toBeNull();
  });
});

describe("requiresRevisionReason — cùng luật máy chủ", () => {
  it("chỉ đổi mô tả hạng mục hoặc không đổi gì ⇒ không cần lý do", () => {
    expect(requiresRevisionReason(base, base)).toBe(false);
    expect(requiresRevisionReason(base, { ...base, items: [{ ...base.items[0], description: "khác" }] })).toBe(false);
  });
  it("đổi đơn giá, số lượng, loại hoặc kỳ hạng mục ⇒ cần lý do", () => {
    const it0 = base.items[0];
    expect(requiresRevisionReason(base, { ...base, items: [{ ...it0, unit_price: 101 }] })).toBe(true);
    expect(requiresRevisionReason(base, { ...base, items: [{ ...it0, quantity: 2 }] })).toBe(true);
    expect(requiresRevisionReason(base, { ...base, items: [{ ...it0, income_expense_type_id: "t2" }] })).toBe(true);
    expect(requiresRevisionReason(base, { ...base, items: [{ ...it0, end_date: "2026-10-31" }] })).toBe(true);
    expect(requiresRevisionReason(base, { ...base, items: [it0, it0] })).toBe(true);
  });
  it("Thu/Chi, toà, KQKD ⇒ cần lý do", () => {
    expect(requiresRevisionReason(base, { ...base, type: "INCOME" })).toBe(true);
    expect(requiresRevisionReason(base, { ...base, building_id: "b2" })).toBe(true);
    expect(requiresRevisionReason(base, { ...base, business_result_accounting: false })).toBe(true);
  });
  it("sổ quỹ: chọn lần đầu thì không, đổi từ sổ này sang sổ khác thì có", () => {
    expect(requiresRevisionReason({ ...base, account_id: null }, { ...base, account_id: "a9" })).toBe(false);
    expect(requiresRevisionReason(base, { ...base, account_id: "a9" })).toBe(true);
  });
  it("thứ tự hạng mục không quan trọng", () => {
    const a = { ...base.items[0] };
    const b = { ...base.items[0], income_expense_type_id: "t2" };
    expect(requiresRevisionReason({ ...base, items: [a, b] }, { ...base, items: [b, a] })).toBe(false);
  });
});

describe("buildRevisionPatch — chỉ gửi ô người dùng đã đổi", () => {
  const moForm: RevisionFormValues = {
    type: "EXPENSE",
    name: "Chi hoa hồng P101",
    building_id: "b1",
    room_id: "r1",
    tenant_id: null,
    contract_id: "c1",
    payer_name: "",
    receive_bank_account: "",
    receive_bank_name: "VietinBank",
    account_id: "",
    voucher_date: "2026-09-20",
    business_result_accounting: null,
    attachments: ["https://x/1.png"],
    repeat_cycle: "NONE",
    repeat_count: 0,
    repeat_infinity: false,
    repeat_auto_approve: true,
  };

  it("không chạm ô nào ⇒ patch rỗng (không sinh lần sửa ma)", () => {
    expect(buildRevisionPatch(moForm, { ...moForm })).toEqual({});
  });
  it("khoảng trắng / chuỗi rỗng coi như trống, giống máy chủ", () => {
    expect(buildRevisionPatch(moForm, { ...moForm, payer_name: "   ", name: " Chi hoa hồng P101 " })).toEqual({});
  });
  it("đổi tên + chọn sổ ⇒ đúng hai khoá, giá trị đã cắt khoảng trắng", () => {
    expect(buildRevisionPatch(moForm, { ...moForm, name: "Chi HH P101 ", account_id: "a9" })).toEqual({
      name: "Chi HH P101",
      account_id: "a9",
    });
  });
  it("xoá người nhận ⇒ gửi null", () => {
    const coNguoiNhan = { ...moForm, payer_name: "Anh Tư" };
    expect(buildRevisionPatch(coNguoiNhan, { ...coNguoiNhan, payer_name: "" })).toEqual({ payer_name: null });
  });
  it("ảnh: so danh sách đường dẫn; KQKD: null ≠ false", () => {
    expect(buildRevisionPatch(moForm, { ...moForm, attachments: ["https://x/2.png"] })).toEqual({
      attachments: ["https://x/2.png"],
    });
    expect(buildRevisionPatch(moForm, { ...moForm, business_result_accounting: false })).toEqual({
      business_result_accounting: false,
    });
  });
  it("đổi một ô lặp ⇒ gửi đủ bốn ô lặp", () => {
    expect(buildRevisionPatch(moForm, { ...moForm, repeat_cycle: "MONTH", repeat_count: 3 })).toEqual({
      repeat_cycle: "MONTH",
      repeat_count: 3,
      repeat_infinity: false,
      repeat_auto_approve: true,
    });
  });
});

describe("hộp Duyệt: đổi sổ / ảnh trước khi duyệt", () => {
  it("không đổi ⇒ patch rỗng; sổ '' coi như chưa có", () => {
    expect(approvalEditPatch({ account_id: null, attachments: null }, { account_id: "", attachments: [] })).toEqual({});
  });
  it("chọn sổ lần đầu + thêm ảnh ⇒ đúng hai khoá, không cần lý do", () => {
    expect(
      approvalEditPatch({ account_id: null, attachments: ["https://x/1.png"] }, {
        account_id: "a1",
        attachments: ["https://x/1.png", "https://x/2.png"],
      }),
    ).toEqual({ account_id: "a1", attachments: ["https://x/1.png", "https://x/2.png"] });
    expect(accountChangeNeedsReason(null, "a1")).toBe(false);
  });
  it("đổi từ sổ này sang sổ khác (hoặc bỏ sổ) ⇒ cần lý do", () => {
    expect(accountChangeNeedsReason("a1", "a2")).toBe(true);
    expect(accountChangeNeedsReason("a1", "")).toBe(true);
    expect(accountChangeNeedsReason("a1", "a1")).toBe(false);
  });
});

describe("revisionItemsChanged", () => {
  const hm = [
    { income_expense_type_id: "t1", description: null, quantity: 1, unit_price: 500000, start_date: null, end_date: null },
    { income_expense_type_id: "t2", description: "Điện", quantity: 1, unit_price: 120000, start_date: "2026-09-01", end_date: "2026-09-30" },
  ];
  it("giống hệt (kể cả kỳ trống, thứ tự khác) ⇒ không đổi", () => {
    expect(revisionItemsChanged(hm, [hm[1], { ...hm[0], start_date: "", end_date: "" }])).toBe(false);
  });
  it("mô tả, đơn giá, kỳ khác ⇒ có đổi", () => {
    expect(revisionItemsChanged(hm, [hm[0], { ...hm[1], description: "Điện T9" }])).toBe(true);
    expect(revisionItemsChanged(hm, [{ ...hm[0], unit_price: 600000 }, hm[1]])).toBe(true);
    expect(revisionItemsChanged(hm, [{ ...hm[0], start_date: "2026-09-01", end_date: "2026-09-30" }, hm[1]])).toBe(true);
  });
});

describe("canReviseVoucher", () => {
  const cho = { approval_status: "UNAPPROVED", posting_status: "UNPOSTED", system_source: null, invoice_id: null, shareholder_id: null };
  it("phiếu tay / hoa hồng / trả khách Chờ duyệt ⇒ hiện nút", () => {
    expect(canReviseVoucher(cho)).toBe(true);
    expect(canReviseVoucher({ ...cho, system_source: "contract.commission" })).toBe(true);
    expect(canReviseVoucher({ ...cho, system_source: "termination.refund" })).toBe(true);
    expect(isSystemRevisableVoucher({ system_source: "termination.refund" })).toBe(true);
    expect(isSystemRevisableVoucher({ system_source: null })).toBe(false);
  });
  it("đã duyệt, đã ghi sổ, gắn hoá đơn, chia lợi nhuận, phiếu hệ thống khác ⇒ ẩn", () => {
    expect(canReviseVoucher({ ...cho, approval_status: "APPROVED" })).toBe(false);
    expect(canReviseVoucher({ ...cho, posting_status: "POSTED" })).toBe(false);
    expect(canReviseVoucher({ ...cho, invoice_id: "i1" })).toBe(false);
    expect(canReviseVoucher({ ...cho, shareholder_id: "s1" })).toBe(false);
    expect(canReviseVoucher({ ...cho, system_source: "invoice.collection.v5" })).toBe(false);
  });
});

describe("voucherEditAction — cây bút trên mặt Thu chi", () => {
  const viewer = { isAdmin: false, isCompanyOwner: false };
  const cho = { approval_status: "UNAPPROVED", posting_status: "UNPOSTED", system_source: null };
  it("phiếu chờ duyệt sửa được ⇒ hiện 'Sửa phiếu chờ duyệt'", () => {
    expect(voucherEditAction(cho, viewer)).toEqual({ show: true, title: "Sửa phiếu chờ duyệt" });
  });
  it("phiếu đã duyệt ⇒ ẩn, kể cả super admin (bỏ 'Sửa phiếu (Super Admin)')", () => {
    expect(voucherEditAction({ ...cho, approval_status: "APPROVED" }, { isAdmin: true, isCompanyOwner: true }).show).toBe(false);
  });
  it("phiếu doanh thu bỏ cọc: chủ/super admin giữ chế độ đổi cờ KQKD, người khác ẩn", () => {
    const boCoc = { approval_status: "APPROVED", system_source: "termination.forfeit_revenue" };
    expect(voucherEditAction(boCoc, { isAdmin: false, isCompanyOwner: true }).show).toBe(true);
    expect(voucherEditAction(boCoc, viewer).show).toBe(false);
    expect(voucherEditAction({ ...boCoc, approval_status: "CANCELLED" }, { isAdmin: true, isCompanyOwner: true }).show).toBe(false);
  });
});

describe("dịch lỗi", () => {
  it("PT409, 40001 và approval_version mismatch đều là phiên bản cũ", () => {
    expect(isStaleVersionError({ code: "PT409", message: "x" })).toBe(true);
    expect(isStaleVersionError({ code: "40001", message: "x" })).toBe(true);
    expect(isStaleVersionError({ code: "55000", message: "approve_income_expense_v2: approval_version mismatch (expected 1, found 2)" })).toBe(true);
    expect(isStaleVersionError({ code: "22023", message: "x" })).toBe(false);
    expect(revisionErrorMessage({ code: "40001" })).toBe("Phiếu vừa được người khác sửa — tải lại để xem thay đổi.");
    expect(approvalErrorMessage({ code: "40001" })).toBe("Phiếu vừa được sửa — tải lại để xem thay đổi trước khi duyệt.");
  });
  it("giữ câu tiếng Việt của máy chủ, bỏ tiền tố máy đọc", () => {
    expect(revisionErrorMessage({ code: "P0001", message: "[PROFIT_LOCKED] Tháng 07/2026 của toà 15KV đã chốt" }))
      .toBe("Tháng 07/2026 của toà 15KV đã chốt");
    expect(revisionErrorMessage({ code: "22023", message: "Đổi số tiền … phải ghi lý do" })).toBe("Đổi số tiền … phải ghi lý do");
    expect(revisionErrorMessage("không phải object")).toBe("Chưa lưu được phiếu. Hãy thử lại.");
  });
});

describe("formatRevisionItem + schema", () => {
  it("một dòng hạng mục đọc được", () => {
    expect(formatRevisionItem(truoc.items![0])).toBe(
      "Phần mềm × 1 × 1.791.000 đ = 1.791.000 đ · kỳ 01/09/2026–30/09/2026",
    );
  });
  it("parse được dòng lịch sử máy chủ trả", () => {
    const row = incomeExpenseRevisionSchema.parse({
      id: "r1", income_expense_id: "v1", revision_no: 1, kind: "EDIT_PENDING", actor_id: "u1", actor_name: "NATHAN",
      reason: "Sua don gia", changed_fields: ["items"], before_snapshot: truoc, after_snapshot: truoc,
      created_at: "2026-09-25T08:00:00.123+00:00",
    });
    expect(row.before_snapshot.items?.[0].unit_price).toBe(1791000);
  });
});
