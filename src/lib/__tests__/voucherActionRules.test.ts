import { describe, expect, it } from "vitest";
import {
  isReservationLeg,
  profitCancelTargetFromVoucher,
  voucherActionAvailability,
  type VoucherActionState,
  type VoucherActionViewer,
} from "@/lib/voucherActionRules";
import type { FlexCancelEligibility } from "@/hooks/income-expenses/flexMutations";
import type { IncomeCancelEligibility } from "@/hooks/income-expenses/incomeVoucherCancel";

// Quyền theo phạm vi (get_my_permissions_v2): chỉ có ở toà b1.
const scoped = (...actions: string[]) => ({
  income_expenses: Object.fromEntries(actions.map((a) => [a, { org_wide: false, building_ids: ["b1"] }])),
});

const viewer = (p: Partial<VoucherActionViewer> = {}): VoucherActionViewer => ({
  perms: scoped(), isAdmin: false, isSuperAdmin: false, isCompanyOwner: false, currentUserId: "u-xem", ...p,
});

const state = (p: Partial<VoucherActionState> = {}): VoucherActionState => ({
  canonicalRead: true, monetaryActionsAllowed: true, canReverseSettlementRefund: false, ...p,
});

type V = Parameters<typeof voucherActionAvailability>[0];
const phieu = (p: Partial<V> = {}): V => ({
  type: "EXPENSE", approval_status: "UNAPPROVED", posting_status: "UNPOSTED", system_source: null,
  building_id: "b1", user_id: "u-lap", repeat_cycle: "NONE", repeat_parent_id: null,
  deleted_at: null, invoice_id: null, shareholder_id: null, ...p,
});

const flex = (p: Partial<FlexCancelEligibility>): FlexCancelEligibility => ({ id: "v", eligible: false, reason_code: null, ...p });
const income = (p: Partial<IncomeCancelEligibility>): IncomeCancelEligibility => ({
  id: "v", eligible: false, mode: null, reason_code: null, blocking_voucher_code: null, ...p,
});

describe("Duyệt — quyền duyệt ở ĐÚNG toà của phiếu (như máy chủ)", () => {
  it("có quyền ở toà phiếu ⇒ hiện; quyền ở toà khác ⇒ ẩn", () => {
    expect(voucherActionAvailability(phieu(), viewer({ perms: scoped("approve") }), state()).approve).toBe(true);
    expect(voucherActionAvailability(phieu({ building_id: "b2" }), viewer({ perms: scoped("approve") }), state()).approve).toBe(false);
  });
  it("phiếu không gắn toà: chỉ quyền cấp công ty", () => {
    expect(voucherActionAvailability(phieu({ building_id: null }), viewer({ perms: scoped("approve") }), state()).approve).toBe(false);
    const orgWide = { income_expenses: { approve: { org_wide: true, building_ids: [] } } };
    expect(voucherActionAvailability(phieu({ building_id: null }), viewer({ perms: orgWide }), state()).approve).toBe(true);
  });
  it("chỉ phiếu Chờ duyệt, và không phải chân xử lý cọc", () => {
    const v = viewer({ perms: scoped("approve") });
    expect(voucherActionAvailability(phieu({ approval_status: "APPROVED" }), v, state()).approve).toBe(false);
    expect(voucherActionAvailability(phieu(), v, state({ monetaryActionsAllowed: false })).approve).toBe(false);
  });
});

describe("Huỷ — theo câu trả lời từng phiếu của máy chủ", () => {
  it("người tạo phiếu chi KHÔNG có quyền huỷ nhưng máy chủ cho (cửa người tạo) ⇒ hiện", () => {
    const a = voucherActionAvailability(phieu(), viewer(), state({ flexEligibility: flex({ eligible: true }) })).cancel;
    expect(a).toEqual({ show: true, disabled: false, reason: null });
  });
  it("máy chủ báo không có quyền / không giữ sổ / hạng mục hạn chế ⇒ ẩn, kể cả khi có quyền huỷ ở nơi khác", () => {
    for (const reason_code of ["NO_PERMISSION", "NOT_CUSTODIAN", "RESTRICTED"] as const) {
      const a = voucherActionAvailability(phieu(), viewer({ perms: scoped("cancel") }), state({ flexEligibility: flex({ reason_code }) })).cancel;
      expect(a.show).toBe(false);
    }
  });
  it("bị chặn vì tháng đã chốt lợi nhuận ⇒ hiện mờ kèm lý do", () => {
    const a = voucherActionAvailability(phieu(), viewer({ perms: scoped("cancel") }), state({ flexEligibility: flex({ reason_code: "PROFIT_LOCKED" }) })).cancel;
    expect(a.show && a.disabled).toBe(true);
    expect(a.reason).toMatch(/chốt lợi nhuận/);
  });
  it("đường huỷ cũ (Chuẩn kế toán): theo quyền huỷ như danh sách trước nay, kèm lưu ý", () => {
    const strict = state({ flexEligibility: flex({ reason_code: "STRICT_MODE" }) });
    const coQuyen = voucherActionAvailability(phieu(), viewer({ perms: scoped("cancel") }), strict).cancel;
    expect(coQuyen.show && !coQuyen.disabled).toBe(true);
    expect(coQuyen.reason).toMatch(/đường huỷ cũ/);
    expect(voucherActionAvailability(phieu(), viewer(), strict).cancel.show).toBe(false);
  });
  it("chưa có câu trả lời ⇒ theo quyền huỷ", () => {
    expect(voucherActionAvailability(phieu(), viewer({ perms: scoped("cancel") }), state()).cancel.show).toBe(true);
    expect(voucherActionAvailability(phieu(), viewer(), state()).cancel.show).toBe(false);
  });
  it("phiếu thu: người đã thu tự huỷ được dù không có quyền huỷ; không phải người thu ⇒ ẩn", () => {
    const thu = phieu({ type: "INCOME", approval_status: "APPROVED", posting_status: "POSTED" });
    expect(voucherActionAvailability(thu, viewer(), state({ incomeEligibility: income({ eligible: true, mode: "MANUAL" }) })).cancel.show).toBe(true);
    expect(voucherActionAvailability(thu, viewer({ perms: scoped("cancel") }), state({ incomeEligibility: income({ reason_code: "NOT_OWNER" }) })).cancel.show).toBe(false);
  });
  it("phiếu thu chưa có câu trả lời của máy chủ ⇒ theo quyền huỷ", () => {
    const thu = phieu({ type: "INCOME", approval_status: "APPROVED", posting_status: "POSTED" });
    expect(voucherActionAvailability(thu, viewer({ perms: scoped("cancel") }), state()).cancel.show).toBe(true);
    expect(voucherActionAvailability(thu, viewer(), state()).cancel.show).toBe(false);
  });
  it("phiếu thu bị chặn theo thứ tự thu ⇒ mờ, nêu đúng phiếu phải huỷ trước", () => {
    const thu = phieu({ type: "INCOME", approval_status: "APPROVED", posting_status: "POSTED" });
    const a = voucherActionAvailability(thu, viewer(), state({ incomeEligibility: income({ reason_code: "LIFO_ORDER", blocking_voucher_code: "PT01" }) })).cancel;
    expect(a.show && a.disabled).toBe(true);
    expect(a.reason).toMatch(/PT01/);
  });
  it("phiếu đã huỷ hoặc chân xử lý cọc ⇒ không có nút Huỷ", () => {
    const v = viewer({ perms: scoped("cancel") });
    expect(voucherActionAvailability(phieu({ approval_status: "CANCELLED" }), v, state()).cancel.show).toBe(false);
    expect(voucherActionAvailability(phieu(), v, state({ monetaryActionsAllowed: false })).cancel.show).toBe(false);
  });
});

describe("Chi phiếu đã duyệt / Hoàn tác", () => {
  it("Chi: đã duyệt, chưa ghi sổ (hoặc đã hoàn tác), tổ chức ghi sổ kiểu mới", () => {
    const v = viewer();
    expect(voucherActionAvailability(phieu({ approval_status: "APPROVED" }), v, state()).postApproved).toBe(true);
    expect(voucherActionAvailability(phieu({ approval_status: "APPROVED", posting_status: "REVERSED" }), v, state()).postApproved).toBe(true);
    expect(voucherActionAvailability(phieu({ approval_status: "APPROVED", posting_status: "POSTED" }), v, state()).postApproved).toBe(false);
    expect(voucherActionAvailability(phieu({ approval_status: "APPROVED", posting_status: "NOT_APPLICABLE" }), v, state()).postApproved).toBe(false);
    expect(voucherActionAvailability(phieu({ approval_status: "APPROVED" }), v, state({ canonicalRead: false })).postApproved).toBe(false);
  });
  it("Hoàn tác: phiếu đã ghi sổ + quyền hoàn tác ở toà", () => {
    const daChi = phieu({ approval_status: "APPROVED", posting_status: "POSTED" });
    expect(voucherActionAvailability(daChi, viewer({ perms: scoped("reverse") }), state()).reverse).toBe(true);
    expect(voucherActionAvailability(daChi, viewer(), state()).reverse).toBe(false);
    expect(voucherActionAvailability(daChi, viewer({ perms: scoped("reverse") }), state({ canonicalRead: false })).reverse).toBe(false);
  });
  it("Hoàn tác: quyền hoàn tác ở toà KHÁC không tính", () => {
    const daChiToaKhac = phieu({ approval_status: "APPROVED", posting_status: "POSTED", building_id: "b2" });
    expect(voucherActionAvailability(daChiToaKhac, viewer({ perms: scoped("reverse") }), state()).reverse).toBe(false);
  });
  it("chân cọc không phải hoàn cọc (vd bỏ cọc) ⇒ không Hoàn tác ở đây", () => {
    const boCoc = phieu({ approval_status: "APPROVED", posting_status: "POSTED", system_source: "reservation.forfeit_offset" });
    const s = state({ monetaryActionsAllowed: false, canReverseSettlementRefund: false });
    expect(voucherActionAvailability(boCoc, viewer({ perms: scoped("reverse") }), s).reverse).toBe(false);
  });
  it("chân hoàn cọc giữ chỗ đã có hồ sơ xử lý vẫn hoàn tác được", () => {
    const hoanCoc = phieu({ approval_status: "APPROVED", posting_status: "POSTED", system_source: "reservation.refund" });
    const s = state({ monetaryActionsAllowed: false, canReverseSettlementRefund: true });
    expect(voucherActionAvailability(hoanCoc, viewer({ perms: scoped("reverse") }), s).reverse).toBe(true);
    expect(isReservationLeg(hoanCoc)).toBe(true);
  });
});

describe("Huỷ duyệt / Khôi phục / Bản sao / Đã kiểm / Dừng lặp / Sửa / Bổ sung", () => {
  it("Huỷ duyệt chỉ super admin, phiếu đã duyệt", () => {
    expect(voucherActionAvailability(phieu({ approval_status: "APPROVED" }), viewer({ isAdmin: true }), state()).unapprove).toBe(true);
    expect(voucherActionAvailability(phieu({ approval_status: "APPROVED" }), viewer({ perms: scoped("approve") }), state()).unapprove).toBe(false);
    expect(voucherActionAvailability(phieu(), viewer({ isAdmin: true }), state()).unapprove).toBe(false);
  });
  it("Khôi phục chỉ super admin; Bản sao mọi người — cùng chỉ cho phiếu đã huỷ", () => {
    const huy = phieu({ approval_status: "CANCELLED" });
    expect(voucherActionAvailability(huy, viewer({ isSuperAdmin: true }), state()).restore).toBe(true);
    expect(voucherActionAvailability(huy, viewer(), state()).restore).toBe(false);
    expect(voucherActionAvailability(huy, viewer(), state()).copy).toBe(true);
    expect(voucherActionAvailability(phieu(), viewer(), state()).copy).toBe(false);
  });
  it("Đánh dấu đã kiểm: mọi phiếu chưa huỷ", () => {
    expect(voucherActionAvailability(phieu(), viewer(), state()).verify).toBe(true);
    expect(voucherActionAvailability(phieu({ approval_status: "CANCELLED" }), viewer(), state()).verify).toBe(false);
  });
  it("Dừng lặp lại: phiếu gốc đang lặp + quyền sửa ở toà", () => {
    const goc = phieu({ approval_status: "APPROVED", posting_status: "POSTED", repeat_cycle: "MONTH" });
    expect(voucherActionAvailability(goc, viewer({ perms: scoped("edit") }), state()).stopRecurring).toBe(true);
    expect(voucherActionAvailability(goc, viewer(), state()).stopRecurring).toBe(false);
    expect(voucherActionAvailability({ ...goc, repeat_parent_id: "p" }, viewer({ perms: scoped("edit") }), state()).stopRecurring).toBe(false);
    expect(voucherActionAvailability({ ...goc, building_id: "b2" }, viewer({ perms: scoped("edit") }), state()).stopRecurring).toBe(false);
  });
  it("Sửa: phiếu chờ duyệt lập tay; chân xử lý cọc thì không", () => {
    expect(voucherActionAvailability(phieu(), viewer(), state()).edit.show).toBe(true);
    expect(voucherActionAvailability(phieu(), viewer(), state({ monetaryActionsAllowed: false })).edit.show).toBe(false);
  });
  it("Bổ sung: người lập phiếu, người có quyền sửa, quản trị", () => {
    expect(voucherActionAvailability(phieu(), viewer({ currentUserId: "u-lap" }), state()).annotate).toBe(true);
    expect(voucherActionAvailability(phieu(), viewer({ perms: scoped("edit") }), state()).annotate).toBe(true);
    expect(voucherActionAvailability(phieu(), viewer(), state()).annotate).toBe(false);
  });
});

// Đợt 2 sổ tổng (d1_chan_interface §2, §5): phiếu nguồn profit.ledger_payout / profit.manager_salary bị chốt F1
// chặn sửa (LOCKED), huỷ duyệt / hoàn tác / khôi phục (CANCEL_ONLY), đổi sổ (ACCOUNT_LOCKED). Nhánh này đứng
// TRƯỚC luật huỷ thường: can_flex_cancel_v1 trả NOT_MANUAL cho phiếu hệ thống, không được rơi về đó.
describe("Phiếu chi theo sổ tổng lợi nhuận", () => {
  const owner = {
    shareholder_profit: { distribute: { org_wide: true, building_ids: [] } },
    income_expenses: Object.fromEntries(["approve", "cancel", "reverse", "edit"].map((a) => [a, { org_wide: true, building_ids: [] }])),
  };
  const soTong = (p: Partial<V> = {}) => phieu({ system_source: "profit.ledger_payout", building_id: "toa-ao", ...p });

  it("chờ duyệt: không Duyệt / Sửa ở Thu chi; có lối sang Chờ duyệt; Huỷ đi hộp sổ tổng", () => {
    const a = voucherActionAvailability(soTong(), viewer({ perms: owner, isAdmin: true, isSuperAdmin: true, isCompanyOwner: true }), state());
    expect(a.approve).toBe(false);
    expect(a.approveVia).toBe("INBOX");
    expect(a.edit.show).toBe(false);
    expect(a.cancel).toEqual({ show: true, disabled: false, reason: null, via: "PROFIT_LEDGER" });
  });

  it("đã chi: không Hoàn tác / Huỷ duyệt / Chi lại; Huỷ vẫn qua hộp sổ tổng; Đánh dấu đã kiểm và Bổ sung vẫn có", () => {
    const a = voucherActionAvailability(soTong({ approval_status: "APPROVED", posting_status: "POSTED" }),
      viewer({ perms: owner, isAdmin: true, isSuperAdmin: true }), state());
    expect([a.reverse, a.unapprove, a.postApproved, a.restore, a.copy, a.stopRecurring]).toEqual([false, false, false, false, false, false]);
    expect(a.cancel.via).toBe("PROFIT_LEDGER");
    expect(a.verify).toBe(true);
    expect(a.annotate).toBe(true);
    expect(a.approveVia).toBeNull();
  });

  it("đã duyệt chưa chi: Chi từ sổ (hộp khoá đúng sổ lúc lập); phiếu đã đảo hoặc tổ chức chưa ghi sổ kiểu mới ⇒ không", () => {
    const v = viewer({ perms: owner });
    expect(voucherActionAvailability(soTong({ approval_status: "APPROVED", posting_status: "UNPOSTED" }), v, state()).postApproved).toBe(true);
    expect(voucherActionAvailability(soTong({ approval_status: "APPROVED", posting_status: null }), v, state()).postApproved).toBe(true);
    expect(voucherActionAvailability(soTong({ approval_status: "APPROVED", posting_status: "REVERSED" }), v, state()).postApproved).toBe(false);
    expect(voucherActionAvailability(soTong({ approval_status: "APPROVED", posting_status: "UNPOSTED" }), v, state({ canonicalRead: false })).postApproved).toBe(false);
  });

  it("đã huỷ: không Khôi phục, không Tạo bản sao (bản sao sẽ thành phiếu chi ngoài sổ tổng), không Huỷ", () => {
    const a = voucherActionAvailability(soTong({ approval_status: "CANCELLED", posting_status: "REVERSED" }),
      viewer({ perms: owner, isAdmin: true, isSuperAdmin: true }), state());
    expect([a.restore, a.copy, a.cancel.show, a.verify]).toEqual([false, false, false, false]);
  });

  it("quyền theo loại phiếu: cổ đông ⇒ distribute, lương điều hành ⇒ pay_manager; quyền huỷ thu chi KHÔNG đủ", () => {
    const thuChiOnly = viewer({ perms: { income_expenses: owner.income_expenses } });
    const a = voucherActionAvailability(soTong(), thuChiOnly, state({ flexEligibility: flex({ eligible: true }) }));
    expect([a.cancel.show, a.approveVia, a.approve]).toEqual([false, null, false]);
    const manager = soTong({ system_source: "profit.manager_salary" });
    expect(voucherActionAvailability(manager, viewer({ perms: owner }), state()).cancel.show).toBe(false);
    const payManager = viewer({ perms: { shareholder_profit: { pay_manager: { org_wide: true, building_ids: [] } } } });
    expect(voucherActionAvailability(manager, payManager, state()).cancel).toEqual({ show: true, disabled: false, reason: null, via: "PROFIT_LEDGER" });
    expect(voucherActionAvailability(manager, payManager, state()).approveVia).toBe("INBOX");
  });

  // Phiếu Tạm Ứng người giữ sổ lập HỘ một cổ đông (18/11/2026): cùng nguồn profit.ledger_payout nên cùng nhánh
  // này. Người giữ sổ lập hộ KHÔNG có quyền chi lợi nhuận (chỉ giữ sổ + quyền lập phiếu chi thường).
  describe("phiếu Tạm Ứng lập hộ — người giữ sổ không có quyền chi lợi nhuận", () => {
    const custodian = viewer({ perms: scoped("create", "edit"), currentUserId: "u-giu-so" });
    // Như máy chủ ghi: user_id của phiếu sổ tổng là CHỦ công ty; người bấm lập nằm ở maker_user_id.
    const tamUng = (p: Partial<V> = {}) => soTong({ user_id: "u-chu", maker_user_id: "u-giu-so", shareholder_id: "sh-nguoi-nhan", ...p });

    it("còn chờ chủ duyệt: người lập không có Duyệt, không có lối sang Chờ duyệt, chưa có nút Chi", () => {
      const a = voucherActionAvailability(tamUng(), custodian, state());
      expect([a.approve, a.approveVia, a.postApproved, a.edit.show, a.reverse, a.unapprove]).toEqual([false, null, false, false, false, false]);
    });

    it("còn chờ chủ duyệt: NGƯỜI LẬP thấy Huỷ ở Thu chi dù không có quyền chi lợi nhuận — mở hộp huỷ sổ tổng", () => {
      // Máy chủ (E6) cho người lập tự huỷ phiếu còn chờ của mình, kỳ vọng PENDING (đo trên TEST 18/11/2026).
      const a = voucherActionAvailability(tamUng(), custodian, state());
      expect(a.cancel).toEqual({ show: true, disabled: false, reason: null, via: "PROFIT_LEDGER" });
      expect(profitCancelTargetFromVoucher({
        id: "v1", organization_id: "org", system_source: "profit.ledger_payout", code: "PC1", name: "Tạm ứng — Cổ đông mẫu",
        total_amount: 500_000, approval_status: "UNAPPROVED", posting_status: "UNPOSTED", account_name: "Sổ giữ",
      })).toMatchObject({ kind: "SHAREHOLDER", approvalStatus: "UNAPPROVED", postingStatus: "UNPOSTED" });
    });

    it("cổ đông tự tạm ứng (người lập = người nhận) cũng thấy Huỷ khi phiếu còn chờ", () => {
      const self = viewer({ perms: { shareholder_profit: { advance_own_cashbook: { org_wide: true, building_ids: [] } } }, currentUserId: "u-co-dong" });
      expect(voucherActionAvailability(tamUng({ maker_user_id: "u-co-dong" }), self, state()).cancel.show).toBe(true);
    });

    it("người KHÁC (không lập, không có quyền chi lợi nhuận) không thấy Huỷ — kể cả người nhận, kể cả có quyền huỷ thu chi", () => {
      const other = viewer({ perms: scoped("create", "edit", "cancel"), currentUserId: "u-khac" });
      expect(voucherActionAvailability(tamUng(), other, state({ flexEligibility: flex({ eligible: true }) })).cancel.show).toBe(false);
      const payee = viewer({ perms: { shareholder_profit: { advance_own_cashbook: { org_wide: true, building_ids: [] } } }, currentUserId: "u-nguoi-nhan" });
      expect(voucherActionAvailability(tamUng(), payee, state()).cancel.show).toBe(false);
      // user_id của phiếu sổ tổng là chủ công ty — KHÔNG được coi "user_id = tôi" là người lập.
      const ownerRow = viewer({ perms: scoped("create"), currentUserId: "u-chu" });
      expect(voucherActionAvailability(tamUng(), ownerRow, state()).cancel.show).toBe(false);
    });

    it("đường đọc không mang người lập (maker_user_id vắng / null) ⇒ không đoán, không hiện Huỷ", () => {
      expect(voucherActionAvailability(tamUng({ maker_user_id: undefined }), custodian, state()).cancel.show).toBe(false);
      expect(voucherActionAvailability(tamUng({ maker_user_id: null }), custodian, state()).cancel.show).toBe(false);
      expect(voucherActionAvailability(tamUng({ maker_user_id: null }), viewer({ perms: scoped(), currentUserId: null }), state()).cancel.show).toBe(false);
    });

    it("chủ duyệt xong, chưa chi: người giữ sổ THẤY nút Chi (hộp Chi khoá đúng sổ lúc lập), KHÔNG còn Huỷ", () => {
      const a = voucherActionAvailability(tamUng({ approval_status: "APPROVED", posting_status: "UNPOSTED" }), custodian, state());
      expect(a.postApproved).toBe(true);
      // Người lập huỷ phiếu đã duyệt: máy chủ từ chối (PROFIT_LEDGER_CANCEL_FORBIDDEN) ⇒ không chào nút.
      expect([a.approve, a.approveVia, a.edit.show, a.cancel.show]).toEqual([false, null, false, false]);
    });

    it("đã chi: không còn nút Chi, không Hoàn tác, người lập không Huỷ (chỉ người có quyền chi lợi nhuận huỷ có lý do)", () => {
      const a = voucherActionAvailability(tamUng({ approval_status: "APPROVED", posting_status: "POSTED" }), custodian, state());
      expect([a.postApproved, a.reverse, a.cancel.show]).toEqual([false, false, false]);
    });

    it("lương điều hành: người lập không có quyền chi lương vẫn KHÔNG có Huỷ (luật riêng của cổ đông không lan sang)", () => {
      const manager = tamUng({ system_source: "profit.manager_salary" });
      expect(voucherActionAvailability(manager, custodian, state()).cancel.show).toBe(false);
    });

    it("nút Chi theo TRẠNG THÁI phiếu, không theo người xem: người nhận có thấy nút cũng không tự chi được", () => {
      // Luật hiển thị không biết ai là người nhận / ai đang giữ sổ. Chặn thật nằm ở hai chỗ khác:
      //   · hộp Chi chỉ chào ĐÚNG sổ lúc lập trong các sổ người bấm đang GIỮ (rỗng ⇒ không chi được) —
      //     xem useVoucherActions.test.tsx "Chi phiếu đã duyệt: hộp Thu/Chi chỉ chào ĐÚNG sổ lúc lập";
      //   · máy chủ từ chối người nhận tự chi phiếu người khác lập (PROFIT_LEDGER_PAYEE_SELF_POST).
      const payee = viewer({ perms: { shareholder_profit: { advance_own_cashbook: { org_wide: true, building_ids: [] } } }, currentUserId: "u-nguoi-nhan" });
      const a = voucherActionAvailability(tamUng({ approval_status: "APPROVED", posting_status: "UNPOSTED" }), payee, state());
      expect(a.postApproved).toBe(true);
      expect([a.approve, a.approveVia, a.cancel.show, a.edit.show]).toEqual([false, null, false, false]);
    });
  });

  it("nguồn cũ (profit.distribution / salary.manager) giữ luật thường", () => {
    const a = voucherActionAvailability(soTong({ system_source: "profit.distribution", building_id: "b1" }),
      viewer({ perms: scoped("approve", "cancel") }), state());
    expect(a.approve).toBe(true);
    expect(a.approveVia).toBeNull();
    expect(a.cancel.via).toBeUndefined();
  });
});

describe("profitCancelTargetFromVoucher — đầu vào hộp huỷ sổ tổng từ dòng Thu chi", () => {
  const dong = {
    id: "v1", organization_id: "o1" as string | null, system_source: "profit.ledger_payout" as string | null, code: "PC-1",
    name: "Chia lợi nhuận: Cổ đông 1", total_amount: 500, approval_status: "APPROVED" as const,
    posting_status: "POSTED" as "POSTED" | "REVERSED", account_name: "Quỹ tiền mặt",
  };
  it("dựng đủ trường; lương điều hành ⇒ MANAGER", () => {
    expect(profitCancelTargetFromVoucher(dong)).toEqual({
      voucherId: "v1", organizationId: "o1", kind: "SHAREHOLDER", code: "PC-1", amount: 500,
      approvalStatus: "APPROVED", postingStatus: "POSTED", subjectName: "Chia lợi nhuận: Cổ đông 1", accountName: "Quỹ tiền mặt",
    });
    expect(profitCancelTargetFromVoucher({ ...dong, system_source: "profit.manager_salary" })?.kind).toBe("MANAGER");
  });
  it("không dựng khi: nguồn khác, thiếu công ty, đã huỷ, đã đảo, số tiền không dương", () => {
    expect(profitCancelTargetFromVoucher({ ...dong, system_source: "profit.distribution" })).toBeNull();
    expect(profitCancelTargetFromVoucher({ ...dong, organization_id: null })).toBeNull();
    expect(profitCancelTargetFromVoucher({ ...dong, approval_status: "CANCELLED" as unknown as "APPROVED" })).toBeNull();
    expect(profitCancelTargetFromVoucher({ ...dong, posting_status: "REVERSED" })).toBeNull();
    expect(profitCancelTargetFromVoucher({ ...dong, total_amount: 0 })).toBeNull();
    expect(profitCancelTargetFromVoucher({ ...dong, total_amount: Number.NaN })).toBeNull();
  });
});
