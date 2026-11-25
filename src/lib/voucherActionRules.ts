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
// ảnh, đánh dấu đã kiểm, chi phiếu đã duyệt từ ĐÚNG sổ lúc lập; bỏ phiếu chỉ bằng hộp huỷ có lý do
// (profit_ledger_payout_cancel_v1). Phiếu nguồn cũ (profit.distribution / salary.manager) giữ luật thường.
// DUYỆT phiếu sổ tổng cũng làm NGAY Ở THU CHI (chủ chốt 25/11/2026: một đường duyệt, bỏ màn Chờ duyệt): ai có quyền chi
// của loại chủ thể thì có nút Duyệt; hộp xác nhận duyệt hiện thẻ số dư sổ tổng và tự khoá khi máy chủ chắc chắn từ
// chối. Luật ai duyệt được KHÔNG đổi (chốt F1, guard_profit_ledger_payout_v1 — soát prod 25/11/2026):
//  - cần quyền chi của loại chủ thể VÀ quyền duyệt thu chi ở đúng toà của phiếu (approve_income_expense_v2);
//  - phiếu CHỦ lập (maker_kind OWNER: chốt chi lợi nhuận, lương điều hành): người lập / người nhận tự duyệt được;
//  - phiếu tạm ứng (người giữ sổ lập, maker_kind CUSTODIAN_*): người lập và người nhận không tự duyệt — cần người khác.
// Trường hợp biết trước là máy chủ từ chối ⇒ nút vẫn bấm được nhưng mờ, hộp duyệt nói rõ lý do và khoá nút xác nhận
// (`approveBlockedReason`; nút mờ không hiện được lý do trên điện thoại — cùng cách với nút Huỷ).
import type { IncomeExpenseWithRelations } from "@/hooks/income-expenses/types";
import { flexCancelGate, type FlexCancelBlockCode, type FlexCancelEligibility } from "@/hooks/income-expenses/flexMutations";
import { voucherCancelDecision, type IncomeCancelEligibility } from "@/hooks/income-expenses/incomeVoucherCancel";
import { canUse, type PermsLike } from "@/lib/permissionCheck";
import { voucherEditAction } from "@/lib/incomeExpenseRevision";
import { canShowAnnotateAction } from "@/lib/voucherAnnotate";
import type { PayoutMakerKind } from "@/lib/profitLedger/sharedReaders";
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
  /**
   * Phiếu chi lợi nhuận cổ đông theo sổ tổng (`profit.ledger_payout`): loại người lập theo dòng sổ lúc lập
   * (E7 `at_create.maker_kind`) — chỉ hỏi cho dòng `needsLedgerMakerKind`. Vắng = chưa biết ⇒ dòng chưa nói trước
   * được lý do khoá (hộp duyệt tự đọc lại E7 rồi mới cho xác nhận). Phiếu lương điều hành sổ tổng luôn do chủ lập,
   * không cần trường này.
   */
  ledgerMakerKind?: PayoutMakerKind | null;
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
  /**
   * Phiếu chi theo sổ tổng mà biết trước máy chủ sẽ từ chối người xem duyệt (người lập phiếu tạm ứng, thiếu quyền
   * duyệt thu chi ở toà): nút Duyệt hiện mờ kèm lý do, hộp duyệt khoá nút xác nhận. null = không có gì phải nói.
   */
  approveBlockedReason: string | null;
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
  | "type" | "approval_status" | "posting_status" | "system_source" | "building_id" | "user_id" | "maker_user_id"
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

const isLedgerMaker = (v: Pick<ActionVoucher, "maker_user_id">, viewer: VoucherActionViewer): boolean =>
  !!viewer.currentUserId && !!v.maker_user_id && v.maker_user_id === viewer.currentUserId;

/**
 * Chi khi có thể chính mình là người nhận: máy chủ (F1 nới 19/11/2026) chỉ miễn "người nhận không tự Chi" khi người Chi
 * có quyền chi của loại chủ thể ở cấp CẢ CÔNG TY (không ngoại lệ super admin). Hộp chốt chi và nút "Duyệt và Chi…" ở Thu
 * chi đều không biết người bấm có phải người nhận ⇒ chỉ chào khi quyền phủ cả công ty. Chủ công ty nhận cờ `__superadmin`
 * của get_my_permissions_v2 (cùng cờ với super admin, giao diện không tách được) ⇒ coi là phủ cả công ty; máy chủ vẫn từ
 * chối (PROFIT_LEDGER_PAYEE_SELF_POST) thì hộp chốt tự hạ về chỉ Duyệt.
 */
export function payoutPostAllowedAsPayee(perms: PermsLike, right: "distribute" | "pay_manager"): boolean {
  if (!perms || typeof perms !== "object") return false;
  if ((perms as { __superadmin?: unknown }).__superadmin === true) return true;
  const raw = (perms as Record<string, Record<string, unknown> | undefined>).shareholder_profit?.[right];
  return !!raw && typeof raw === "object" && (raw as { org_wide?: unknown }).org_wide === true;
}

/**
 * "Duyệt và Chi…" ở hộp Duyệt của Thu chi: phiếu chi sổ tổng (chủ tự duyệt phiếu mình lập — có thể chính mình là người
 * nhận) chỉ chào khi được Chi kể cả khi là người nhận (payoutPostAllowedAsPayee, cùng luật hộp chốt); phiếu khác như cũ.
 */
export function ledgerApproveAndPostAllowed(
  v: Pick<ActionVoucher, "system_source">,
  perms: PermsLike,
): boolean {
  if (!isProfitLedgerVoucher(v.system_source)) return true;
  return payoutPostAllowedAsPayee(perms, profitLedgerPermissionFor(v.system_source));
}

/** Câu cho người lập một phiếu tạm ứng: máy chủ trả PROFIT_LEDGER_MAKER_SELF_APPROVE nếu vẫn bấm duyệt. */
export const LEDGER_MAKER_SELF_APPROVE_REASON =
  "Phiếu tạm ứng do chính bạn lập — người lập không tự duyệt được, cần một người khác có quyền chi lợi nhuận duyệt.";
/** Câu cho người có quyền chi lợi nhuận nhưng thiếu quyền duyệt thu chi ở toà của phiếu. */
export const LEDGER_APPROVE_PERMISSION_REASON =
  "Cần thêm quyền duyệt thu chi ở toà của phiếu mới duyệt được phiếu này.";

/**
 * Lý do biết trước là người xem KHÔNG duyệt được một phiếu chi theo sổ tổng còn chờ duyệt (dòng danh sách dùng để làm
 * mờ nút; hộp duyệt dùng để khoá nút xác nhận). null = không biết lý do nào — máy chủ vẫn là chốt cuối (người nhận tự
 * duyệt, phiếu lương cần xem lại… chỉ máy chủ biết). Phiếu khác nguồn ⇒ null.
 * `makerKind`: loại người lập theo dòng sổ lúc lập (E7); `undefined` = chưa đọc được ⇒ chưa kết luận gì về người lập.
 */
export function ledgerApproveBlockReason(
  v: Pick<ActionVoucher, "system_source" | "building_id" | "maker_user_id">,
  viewer: Pick<VoucherActionViewer, "perms" | "currentUserId">,
  makerKind: PayoutMakerKind | null | undefined,
): string | null {
  if (!isProfitLedgerVoucher(v.system_source)) return null;
  if (!canUse(viewer.perms, "income_expenses", "approve", v.building_id ?? NO_BUILDING)) return LEDGER_APPROVE_PERMISSION_REASON;
  const isMaker = !!viewer.currentUserId && !!v.maker_user_id && v.maker_user_id === viewer.currentUserId;
  // Lương điều hành sổ tổng luôn do chủ lập; phiếu cổ đông phải biết chắc không phải phiếu chủ lập mới khoá.
  if (isMaker && v.system_source === "profit.ledger_payout" && makerKind !== undefined && makerKind !== "OWNER") {
    return LEDGER_MAKER_SELF_APPROVE_REASON;
  }
  return null;
}

/**
 * Dòng nên đọc loại người lập (E7) để nói trước lý do khoá nút Duyệt: phiếu chi lợi nhuận cổ đông theo sổ tổng còn chờ
 * duyệt, do CHÍNH người xem lập, người xem có quyền chi lợi nhuận — có thể là phiếu chủ lập (tự duyệt được) hoặc phiếu
 * tạm ứng người xem tự lập khi đang giữ sổ (không tự duyệt được). Phiếu lương điều hành luôn do chủ lập: không cần đọc.
 */
export function needsLedgerMakerKind(
  v: Pick<ActionVoucher, "system_source" | "approval_status" | "maker_user_id">,
  viewer: VoucherActionViewer,
): boolean {
  return v.system_source === "profit.ledger_payout" && v.approval_status === "UNAPPROVED" && isLedgerMaker(v, viewer)
    && canUse(viewer.perms, "shareholder_profit", "distribute");
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
  const canLedger = canUse(viewer.perms, "shareholder_profit", profitLedgerPermissionFor(source));
  // NGƯỜI LẬP phiếu của CỔ ĐÔNG (tự tạm ứng, hoặc người giữ sổ lập hộ ở Thu chi) tự huỷ được phiếu còn CHỜ duyệt
  // của mình dù không có quyền chi lợi nhuận — đúng luật E6 của máy chủ (kỳ vọng PENDING). Phiếu đã duyệt / đã chi
  // thì người lập không huỷ được (PROFIT_LEDGER_CANCEL_FORBIDDEN) ⇒ giữ luật cũ: cần quyền chi lợi nhuận.
  // Người lập = cột maker_user_id (user_id của phiếu sổ tổng là chủ công ty); đường đọc không mang cột đó
  // (hộp chi tiết mở từ nơi khác) ⇒ coi như không phải người lập, không đoán.
  const isMaker = isLedgerMaker(v, viewer);
  const makerCanCancelPending = source === "profit.ledger_payout" && isUnapproved && isMaker;
  // Duyệt ngay ở Thu chi (chủ chốt 25/11/2026): ai có quyền chi của loại chủ thể thì có nút Duyệt — hộp xác nhận hiện
  // số dư sổ tổng. Biết trước máy chủ từ chối (thiếu quyền duyệt thu chi ở ĐÚNG toà của phiếu; người lập phiếu tạm ứng
  // — phiếu CHỦ lập thì người lập tự duyệt được, F1 nới 19/11/2026) ⇒ nút mờ kèm lý do, hộp duyệt khoá xác nhận.
  const approve = isUnapproved && canLedger && state.canonicalRead && state.monetaryActionsAllowed;
  return {
    edit: { show: false, title: "" },
    annotate: canShowAnnotateAction({
      hasHandler: true,
      isUnapproved,
      isAdmin: viewer.isAdmin,
      isCreator: !!viewer.currentUserId && v.user_id === viewer.currentUserId,
      canEdit: canUse(viewer.perms, "income_expenses", "edit", v.building_id ?? NO_BUILDING),
    }),
    approve,
    approveBlockedReason: approve ? ledgerApproveBlockReason(v, viewer, state.ledgerMakerKind) : null,
    // Hộp Thu/Chi khoá đúng sổ quỹ lúc lập (ACCOUNT_LOCKED); phiếu từng bị đảo không chi lại (REPOST).
    postApproved: state.canonicalRead && v.approval_status === "APPROVED" && (posting === null || posting === "UNPOSTED"),
    reverse: false,
    unapprove: false,
    cancel: (canLedger || makerCanCancelPending) && expectedCancelState(v.approval_status, posting)
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
    approveBlockedReason: null,
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
