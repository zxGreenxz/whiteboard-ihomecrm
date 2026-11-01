import { describe, expect, it } from "vitest";
import {
  isReservationLeg,
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
