// MỘT bảng luật hiện nút thao tác trên một phiếu thu chi. Dùng chung cho dòng danh sách Thu chi,
// hộp chi tiết máy tính và tấm chi tiết điện thoại (Báo cáo lợi nhuận mở đúng hộp chi tiết đó).
// Trước 28/10/2026 ba nơi tự quyết và đã lệch nhau: hộp chi tiết hiện Duyệt / Huỷ không xét quyền,
// danh sách giấu Huỷ của người tạo phiếu, máy tính thiếu Chi / Hoàn tác, điện thoại thiếu Huỷ duyệt.
//
// Chỉ là lớp hiển thị — máy chủ luôn là chốt cuối. Đối chiếu với hàm SQL đang chạy (soát 28/10/2026):
//  - Duyệt (approve_income_expense_v2 / approve_voucher / approve_and_post): quyền
//    income_expenses.approve ở ĐÚNG toà của phiếu (authorize_tenant_action_v3 với v.building_id).
//  - Huỷ: câu trả lời từng phiếu của máy chủ. Phiếu CHI: can_flex_cancel_v1 (super admin, chủ tổ
//    chức, NGƯỜI TẠO PHIẾU, hoặc quyền huỷ ở toà + giữ sổ). Phiếu THU: can_cancel_income_voucher_v1
//    (chính người đã thu, chủ tổ chức, super admin — không đòi quyền "Huỷ thu chi"). Máy chủ nói
//    không có quyền ⇒ ẩn; bị chặn vì khoá sổ / chốt lợi nhuận / thứ tự thu… ⇒ `disabled` kèm lý do
//    (dòng danh sách hiện mờ; hộp / tấm chi tiết vẫn cho bấm để hộp xác nhận nói rõ "Không huỷ được").
//    Chưa có câu trả lời, hoặc đường huỷ cũ (Chuẩn kế toán, phiếu do luồng khác lập — máy chủ chưa
//    xét quyền ở bước hỏi trước) ⇒ theo quyền income_expenses.cancel như danh sách trước nay.
//  - Hoàn tác / Mở lại (reverse_posted_income_expense_v2): quyền income_expenses.reverse ở toà
//    (máy chủ còn đòi đang giữ đúng sổ của bút toán).
//  - Dừng lặp lại (ie_stop_recurring_v1): quyền income_expenses.edit ở toà, hoặc super admin.
//  - Huỷ duyệt: chỉ super admin (is_admin() ≡ is_super_admin()). Máy chủ còn cho người lập và người
//    có quyền duyệt ở toà, nhưng đó là chính sách chủ chưa mở — giữ như trước.
//  - Khôi phục (restore_income_expense): chỉ super admin.
// Chân xử lý cọc giữ chỗ (reservation.*) không thao tác tiền ở đây — xử lý ở luồng Đặt cọc.
//
// Phiếu chi theo SỔ TỔNG lợi nhuận (nguồn profit.ledger_payout / profit.manager_salary) đi luật riêng,
// xét TRƯỚC mọi luật trên (can_flex_cancel_v1 trả NOT_MANUAL cho phiếu hệ thống). Chốt F1/F1b/F2/F5 của
// máy chủ (Đợt 1, d1_chan_interface §2) chặn: sửa (LOCKED), huỷ duyệt / hoàn tác / khôi phục / rút /
// từ chối vì sai (CANCEL_ONLY), đổi hạng mục (ITEMS_LOCKED), đổi sổ quỹ (ACCOUNT_LOCKED); cho: ghi chú /
// ảnh, đánh dấu đã kiểm, chi phiếu đã duyệt từ ĐÚNG sổ lúc lập. Duyệt đi màn Chờ duyệt (thấy số dư sổ
// tổng); bỏ phiếu chỉ bằng hộp huỷ có lý do (profit_ledger_payout_cancel_v1). Phiếu nguồn cũ
// (profit.distribution / salary.manager) giữ luật thường.
import type { IncomeExpenseWithRelations } from "@/hooks/income-expenses/types";
import { flexCancelGate, type FlexCancelBlockCode, type FlexCancelEligibility } from "@/hooks/income-expenses/flexMutations";
import { voucherCancelDecision, type IncomeCancelEligibility } from "@/hooks/income-expenses/incomeVoucherCancel";
import { canUse, type PermsLike } from "@/lib/permissionCheck";
import { voucherEditAction } from "@/lib/incomeExpenseRevision";
import { canShowAnnotateAction } from "@/lib/voucherAnnotate";
import {
  expectedCancelState, isProfitLedgerVoucher,
  type ProfitLedgerSource, type ProfitPayoutCancelTarget,
} from "@/lib/profitLedger/vouchers";

/** Phiếu không gắn toà: chỉ quyền cấp công ty mới tính (như Chi nhanh, src/lib/quickExpense.ts). */
export const NO_BUILDING = "__no_building__";

export interface VoucherActionViewer {
  perms: PermsLike;
  /** public.is_admin() — hiện ≡ super admin. */
  isAdmin: boolean;
  isSuperAdmin: boolean;
  isCompanyOwner: boolean;
  currentUserId: string | null;
}

export interface VoucherActionState {
  /** Route đọc Finance V2 của tổ chức phiếu là CANONICAL (mới có Chi / Hoàn tác). */
  canonicalRead: boolean;
  /** false = phiếu là chân xử lý cọc ⇒ không duyệt / chi / huỷ ở đây. */
  monetaryActionsAllowed: boolean;
  /** Chân hoàn cọc giữ chỗ đã có hồ sơ xử lý — vẫn hoàn tác được. */
  canReverseSettlementRefund: boolean;
  /** Dòng can_flex_cancel_v1 của phiếu (phiếu chi); vắng = chưa hỏi / chưa có câu trả lời. */
  flexEligibility?: FlexCancelEligibility;
  /** Dòng can_cancel_income_voucher_v1 của phiếu (phiếu thu). */
  incomeEligibility?: IncomeCancelEligibility;
}

export interface CancelAvailability {
  show: boolean;
  disabled: boolean;
  /** Lý do mờ nút / lưu ý của máy chủ; null = không có gì phải nói. */
  reason: string | null;
  /** Phiếu chi theo sổ tổng: huỷ bằng hộp huỷ có lý do (E6), không qua đường huỷ thường. Vắng = đường thường. */
  via?: "PROFIT_LEDGER";
}

export interface VoucherActionAvailability {
  edit: { show: boolean; title: string };
  annotate: boolean;
  approve: boolean;
  /** Phiếu chi theo sổ tổng duyệt ở màn Chờ duyệt (thấy số dư sổ tổng) ⇒ hiện lối sang đó thay nút Duyệt. */
  approveVia: "INBOX" | null;
  /** Thu / Chi phiếu đã duyệt (kể cả thu / chi lại sau hoàn tác). */
  postApproved: boolean;
  /** Hoàn tác / Mở lại phiếu đã ghi sổ. */
  reverse: boolean;
  unapprove: boolean;
  cancel: CancelAvailability;
  restore: boolean;
  copy: boolean;
  verify: boolean;
  stopRecurring: boolean;
}

type ActionVoucher = Pick<
  IncomeExpenseWithRelations,
  | "type" | "approval_status" | "posting_status" | "system_source" | "building_id" | "user_id"
  | "repeat_cycle" | "repeat_parent_id" | "invoice_id" | "shareholder_id"
> & { deleted_at?: string | null };

const HIDDEN: CancelAvailability = { show: false, disabled: false, reason: null };

/** Mã từ chối của reader phiếu chi mang nghĩa "người này không có quyền" ⇒ ẩn hẳn nút. */
const FLEX_PERMISSION_DENIALS: ReadonlySet<FlexCancelBlockCode> = new Set<FlexCancelBlockCode>([
  "NO_PERMISSION",
  "NOT_CUSTODIAN",
  "RESTRICTED",
]);

/** Phiếu là chân xử lý cọc giữ chỗ (danh sách không tra hồ sơ cọc từng dòng). */
export const isReservationLeg = (v: Pick<IncomeExpenseWithRelations, "system_source">): boolean =>
  v.system_source?.startsWith("reservation.") ?? false;

function cancelAvailability(
  v: ActionVoucher,
  viewer: VoucherActionViewer,
  state: VoucherActionState,
): CancelAvailability {
  if (v.approval_status === "CANCELLED" || !state.monetaryActionsAllowed) return HIDDEN;
  const isIncome = v.type === "INCOME";
  const decision = voucherCancelDecision({
    type: v.type,
    income: state.incomeEligibility,
    flexGate: flexCancelGate(state.flexEligibility),
  });
  const row = isIncome ? state.incomeEligibility : state.flexEligibility;
  if (row?.eligible) return { show: true, disabled: false, reason: null };
  if (row) {
    const denied = isIncome
      ? state.incomeEligibility?.reason_code === "NOT_OWNER"
      : FLEX_PERMISSION_DENIALS.has(state.flexEligibility?.reason_code ?? "UNKNOWN");
    if (denied) return HIDDEN;
    if (!decision.canCancel) return { show: true, disabled: true, reason: decision.reason };
  }
  // Chưa có câu trả lời, hoặc đường huỷ cũ: máy chủ chưa xét quyền ở bước hỏi trước.
  if (!canUse(viewer.perms, "income_expenses", "cancel")) return HIDDEN;
  return { show: true, disabled: false, reason: decision.reason };
}

/** Khoá quyền của sổ tổng theo nguồn phiếu — đúng khoá máy chủ đòi ở E6 (huỷ) và F1 (duyệt). */
export function profitLedgerPermissionFor(source: ProfitLedgerSource): "distribute" | "pay_manager" {
  return source === "profit.manager_salary" ? "pay_manager" : "distribute";
}

function ledgerVoucherAvailability(
  v: ActionVoucher,
  source: ProfitLedgerSource,
  viewer: VoucherActionViewer,
  state: VoucherActionState,
): VoucherActionAvailability {
  const isCancelled = v.approval_status === "CANCELLED";
  const isUnapproved = v.approval_status === "UNAPPROVED";
  const posting = v.posting_status ?? null;
  // Chỉ là lớp hiển thị (máy chủ còn đòi khác người lập / người nhận, giữ đúng sổ khi phiếu đã chi…).
  // Người lập không có quyền này vẫn tự huỷ được phiếu CHỜ của mình ở màn "Tạm ứng LN" — danh sách
  // Thu chi không có người lập sổ tổng (maker_user_id) ở mọi đường đọc nên không xét vế đó.
  const canLedger = canUse(viewer.perms, "shareholder_profit", profitLedgerPermissionFor(source));
  return {
    edit: { show: false, title: "" },
    annotate: canShowAnnotateAction({
      hasHandler: true,
      isUnapproved,
      isAdmin: viewer.isAdmin,
      isCreator: !!viewer.currentUserId && v.user_id === viewer.currentUserId,
      canEdit: canUse(viewer.perms, "income_expenses", "edit", v.building_id ?? NO_BUILDING),
    }),
    approve: false,
    approveVia: isUnapproved && canLedger ? "INBOX" : null,
    // Hộp Thu/Chi khoá đúng sổ quỹ lúc lập (ACCOUNT_LOCKED); phiếu từng bị đảo không chi lại (REPOST).
    postApproved: state.canonicalRead && v.approval_status === "APPROVED" && (posting === null || posting === "UNPOSTED"),
    reverse: false,
    unapprove: false,
    cancel: canLedger && expectedCancelState(v.approval_status, posting)
      ? { show: true, disabled: false, reason: null, via: "PROFIT_LEDGER" }
      : HIDDEN,
    restore: false,
    copy: false,
    verify: !isCancelled,
    stopRecurring: false,
  };
}

/**
 * Đầu vào hộp huỷ sổ tổng từ một dòng Thu chi (đã có trạng thái, sổ, số tiền). Phiếu khác nguồn, thiếu
 * công ty, trạng thái không huỷ được (đã huỷ, đã đảo…) ⇒ null.
 */
export function profitCancelTargetFromVoucher(
  v: Pick<IncomeExpenseWithRelations,
    "id" | "organization_id" | "system_source" | "code" | "name" | "total_amount" | "approval_status" | "posting_status" | "account_name">,
): ProfitPayoutCancelTarget | null {
  if (!isProfitLedgerVoucher(v.system_source) || !v.organization_id) return null;
  if (!expectedCancelState(v.approval_status, v.posting_status)) return null;
  if (!Number.isFinite(v.total_amount) || v.total_amount <= 0) return null;
  return {
    voucherId: v.id,
    organizationId: v.organization_id,
    kind: v.system_source === "profit.manager_salary" ? "MANAGER" : "SHAREHOLDER",
    code: v.code || null,
    amount: v.total_amount,
    approvalStatus: v.approval_status,
    postingStatus: v.posting_status ?? null,
    subjectName: v.name || null,
    accountName: v.account_name ?? null,
  };
}

export function voucherActionAvailability(
  v: ActionVoucher,
  viewer: VoucherActionViewer,
  state: VoucherActionState,
): VoucherActionAvailability {
  if (isProfitLedgerVoucher(v.system_source)) return ledgerVoucherAvailability(v, v.system_source, viewer, state);
  const isCancelled = v.approval_status === "CANCELLED";
  const isUnapproved = v.approval_status === "UNAPPROVED";
  const isCreator = !!viewer.currentUserId && v.user_id === viewer.currentUserId;
  const building = v.building_id ?? NO_BUILDING;
  const editAction = voucherEditAction(v, { isAdmin: viewer.isAdmin, isCompanyOwner: viewer.isCompanyOwner });
  const posting = v.posting_status ?? null;
  return {
    edit: { show: state.monetaryActionsAllowed && editAction.show, title: editAction.title },
    annotate: canShowAnnotateAction({
      hasHandler: true,
      isUnapproved,
      isAdmin: viewer.isAdmin,
      isCreator,
      canEdit: canUse(viewer.perms, "income_expenses", "edit", building),
    }),
    approve: state.monetaryActionsAllowed && isUnapproved && canUse(viewer.perms, "income_expenses", "approve", building),
    approveVia: null,
    postApproved: state.monetaryActionsAllowed && !isCancelled && v.approval_status === "APPROVED" &&
      posting !== "POSTED" && posting !== "NOT_APPLICABLE" && state.canonicalRead,
    reverse: (state.monetaryActionsAllowed || state.canReverseSettlementRefund) && !isCancelled &&
      posting === "POSTED" && state.canonicalRead && canUse(viewer.perms, "income_expenses", "reverse", building),
    unapprove: state.monetaryActionsAllowed && viewer.isAdmin && !isUnapproved && !isCancelled,
    cancel: cancelAvailability(v, viewer, state),
    restore: isCancelled && viewer.isSuperAdmin,
    copy: isCancelled,
    verify: !isCancelled,
    stopRecurring: !!v.repeat_cycle && v.repeat_cycle !== "NONE" && !v.repeat_parent_id && !isCancelled &&
      canUse(viewer.perms, "income_expenses", "edit", building),
  };
}
