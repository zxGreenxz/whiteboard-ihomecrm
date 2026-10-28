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
import type { IncomeExpenseWithRelations } from "@/hooks/income-expenses/types";
import { flexCancelGate, type FlexCancelBlockCode, type FlexCancelEligibility } from "@/hooks/income-expenses/flexMutations";
import { voucherCancelDecision, type IncomeCancelEligibility } from "@/hooks/income-expenses/incomeVoucherCancel";
import { canUse, type PermsLike } from "@/lib/permissionCheck";
import { voucherEditAction } from "@/lib/incomeExpenseRevision";
import { canShowAnnotateAction } from "@/lib/voucherAnnotate";

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
}

export interface VoucherActionAvailability {
  edit: { show: boolean; title: string };
  annotate: boolean;
  approve: boolean;
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

export function voucherActionAvailability(
  v: ActionVoucher,
  viewer: VoucherActionViewer,
  state: VoucherActionState,
): VoucherActionAvailability {
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
      canEdit: canUse(viewer.perms, "income_expenses", "edit"),
    }),
    approve: state.monetaryActionsAllowed && isUnapproved && canUse(viewer.perms, "income_expenses", "approve", building),
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
