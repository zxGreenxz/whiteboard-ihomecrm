// Finance V2 — mô hình HIỂN THỊ canonical cho Phiếu thu/chi (plan §12.1).
//
// Đây là helper THUẦN, additive: KHÔNG thay `voucherLayer()` cũ, KHÔNG đụng
// component nào. Chỉ tới lúc cutover các UI mới mới gọi vào đây; app hiện tại +
// characterization test giữ nguyên hiệu lực.
//
// Bốn trục độc lập (plan §5.1):
//   - approval_status : quyết định phê duyệt (workflow).
//   - review_state    : substate khi chưa thể approve/cancel ngay.
//   - posting_mode    : phiếu có yêu cầu đụng sổ quỹ hay chỉ bút toán không tiền.
//   - posting_status  : posting event là NGUỒN TIỀN THẬT duy nhất.
// + execution_state (optional): hàng đợi phân sổ cho phiếu Đã Duyệt - Chưa Chi/Thu
//   khi chưa gán đúng sổ (badge "· Chờ phân sổ").
//
// NGUYÊN TẮC CỨNG:
//   - TUYỆT ĐỐI không suy "tiền thật" từ approval_status. `isCash` chỉ true khi
//     posting_status === 'POSTED'.
//   - TUYỆT ĐỐI không dùng chữ "Nháp" — UNAPPROVED/PENDING là "Chờ duyệt".
//
// Bảng hiển thị chuẩn (plan §12.1):
//   | Điều kiện                                   | Phiếu chi                        | Phiếu thu                        |
//   | UNAPPROVED + CHANGES_REQUESTED              | Cần bổ sung                      | Cần bổ sung                      |
//   | UNAPPROVED + DISPUTED                       | Đang tranh chấp                  | Đang tranh chấp                  |
//   | UNAPPROVED + PENDING + UNPOSTED             | Chờ duyệt                        | Chờ duyệt                        |
//   | APPROVED + UNPOSTED                         | Đã Duyệt - Chưa Chi              | Đã Duyệt - Chưa Thu              |
//   | APPROVED + UNPOSTED + execution=UNASSIGNED  | … · Chờ phân sổ                  | … · Chờ phân sổ                  |
//   | APPROVED + NON_CASH + NOT_APPLICABLE        | Đã ghi nhận - Không qua sổ       | Đã ghi nhận - Không qua sổ       |
//   | active posting (POSTED)                     | Đã Chi                           | Đã Thu                           |
//   | reversed (REVERSED)                         | Đã hoàn tác                      | Đã hoàn tác                      |
//   | cancelled (CANCELLED)                       | Đã hủy                           | Đã hủy                           |

// --- Bốn trục trạng thái ---

/** Trục phê duyệt/workflow. */
export type ApprovalStatus = "UNAPPROVED" | "APPROVED" | "CANCELLED";

/** Substate xử lý khi chưa thể approve/cancel ngay. */
export type ReviewState =
  | "PENDING"
  | "CHANGES_REQUESTED"
  | "DISPUTED"
  | "RESOLVED";

/** Phiếu có đụng sổ quỹ hay chỉ là bút toán không tiền. */
export type PostingMode = "CASHBOOK" | "NON_CASH";

/** Trạng thái posting event (nguồn tiền thật). */
export type PostingStatus =
  | "UNPOSTED"
  | "POSTED"
  | "REVERSED"
  | "NOT_APPLICABLE";

/**
 * Hàng đợi phân sổ (optional) cho phiếu Đã Duyệt - Chưa Chi/Thu: khi chưa gán
 * đúng sổ để Người giữ sổ nhận thực hiện. Chỉ 'UNASSIGNED' làm badge đổi.
 */
export type ExecutionState = "UNASSIGNED" | "ASSIGNED" | "CLAIMED";

/** Loại phiếu — quyết định chọn cặp nhãn Chi vs Thu. */
export type VoucherType = "INCOME" | "EXPENSE";

/** Sắc thái badge cho lớp trình bày. */
export type VoucherTone =
  | "pending"
  | "approved"
  | "posted"
  | "reversed"
  | "cancelled"
  | "disputed"
  | "changes";

// --- Input/Output ---

/** Bốn trục trạng thái tối thiểu để suy nhãn + action (không cần cột tiền). */
export interface VoucherLifecycleState {
  approval_status: ApprovalStatus;
  review_state?: ReviewState | null;
  posting_mode?: PostingMode | null;
  posting_status?: PostingStatus | null;
  execution_state?: ExecutionState | null;
}

/** Input cho nhãn hiển thị — cần thêm `type` để chọn Chi/Thu. */
export interface VoucherDisplayInput extends VoucherLifecycleState {
  type: VoucherType;
}

/**
 * Phiếu NỘI BỘ (bút toán không tiền): không bao giờ được chào "Duyệt và Thu/Chi".
 *
 * 7af (25/07): cặp bút toán bỏ cọc từng lọt vào luồng tiền thật vì bỏ trống
 * posting_mode ⇒ màn Thu chi hiện nút ghi tiền vào SỔ QUỸ THẬT cho một bút toán
 * chạy trên sổ ảo. Server đã chặn, nhưng UI không được mời làm việc sai ngay từ
 * đầu. Nhận diện theo dấu bản chất của phiếu, không theo nguồn sinh phiếu.
 */
export function isNonCashVoucher(
  v: Pick<VoucherLifecycleState, "posting_mode" | "posting_status"> | null | undefined,
): boolean {
  return (
    v?.posting_mode === "NON_CASH" || v?.posting_status === "NOT_APPLICABLE"
  );
}

/** `system_source` của hai chân cặp bút toán bỏ cọc. */
export const FORFEIT_REVENUE_SOURCE = "termination.forfeit_revenue";
export const FORFEIT_OFFSET_SOURCE = "termination.forfeit_offset";

/**
 * Chân DOANH THU của cặp bỏ cọc — phiếu duy nhất mà chủ công ty / super admin
 * được đổi cờ "tính vào kết quả kinh doanh" (RPC set_forfeit_voucher_kqkd_v1).
 *
 * Nhận diện theo `system_source` chứ KHÔNG theo tên phiếu: tên do người dùng gõ
 * lại được, còn `system_source` do writer thanh lý đóng dấu và guard
 * `guard_termination_forfeit_voucher_v1` canh theo đúng cột này.
 */
export function isForfeitRevenueVoucher(
  v: { system_source?: string | null } | null | undefined,
): boolean {
  return v?.system_source === FORFEIT_REVENUE_SOURCE;
}

/**
 * Chân ĐỐI ỨNG (cấn cọc) — bút toán tiêu cọc. `kqkd_amount` của nó phải bằng 0
 * vĩnh viễn, nên cửa đổi cờ KQKD cố ý KHÔNG nhận phiếu này; server trả P0001.
 */
export function isForfeitOffsetVoucher(
  v: { system_source?: string | null } | null | undefined,
): boolean {
  return v?.system_source === FORFEIT_OFFSET_SOURCE;
}

/** Ai đang mở phiếu — hai cờ hiển thị lấy từ server. */
export interface ForfeitKqkdViewer {
  /** useIsAdmin() — trên prod hôm nay ≡ is_super_admin(). */
  isAdmin: boolean;
  /** useIsCompanyOwner() — KHÁC useIsOrgOwner, xem đầu hook đó. */
  isCompanyOwner: boolean;
}

export interface ForfeitKqkdGate {
  /** Phiếu là một chân của cặp bỏ cọc (bất kể chân nào). */
  isForfeitLeg: boolean;
  /**
   * Bày cửa hẹp "đổi cờ KQKD". Khi true thì `canEditNormally` LUÔN false —
   * hai cái loại trừ nhau, đó là điểm chính của cửa này.
   */
  forfeitKqkdMode: boolean;
  /** Đường sửa phiếu THƯỜNG (mọi ô) có mở không. */
  canEditNormally: boolean;
}

/**
 * Quyết định form Thu chi mở ô nào cho phiếu đang xem.
 *
 * Tách thành hàm thuần vì đây là chỗ dễ sai nhất và cũng là chỗ khó thấy nhất:
 * ba cờ (`isAdmin`, `isCompanyOwner`, trạng thái phiếu) nhân với hai chân của
 * cặp bỏ cọc. Sai một ô là hoặc chủ công ty bị khoá read-only không hiểu vì sao,
 * hoặc quản lý toà được mời bấm một nút mà server chắc chắn từ chối.
 *
 * Luật:
 *   · Hai chân của cặp bỏ cọc KHÔNG BAO GIỜ sửa được bằng đường thường — trigger
 *     writer thanh lý chặn mọi ghi, kể cả của super admin. Khoá hẳn thay vì mời
 *     người dùng làm việc chắc chắn hỏng.
 *   · Chân DOANH THU, chưa huỷ, người xem là chủ công ty hoặc super admin →
 *     mở đúng một ô: cờ KQKD, đi qua set_forfeit_voucher_kqkd_v1.
 */
export function forfeitKqkdGate(
  voucher:
    | { system_source?: string | null; approval_status?: ApprovalStatus | null }
    | null
    | undefined,
  viewer: ForfeitKqkdViewer,
): ForfeitKqkdGate {
  const isForfeitLeg =
    isForfeitRevenueVoucher(voucher) || isForfeitOffsetVoucher(voucher);
  const forfeitKqkdMode =
    isForfeitRevenueVoucher(voucher) &&
    voucher?.approval_status !== "CANCELLED" &&
    (viewer.isAdmin || viewer.isCompanyOwner);
  const isUnapprovedDraft = voucher?.approval_status === "UNAPPROVED";
  const canEditNormally =
    !isForfeitLeg && (!voucher || isUnapprovedDraft || viewer.isAdmin);
  return { isForfeitLeg, forfeitKqkdMode, canEditNormally };
}

/** Kết quả mô hình hiển thị. */
export interface VoucherDisplayState {
  /** Nhãn tiếng Việt canonical (không bao giờ là "Nháp"). */
  label: string;
  tone: VoucherTone;
  /** true CHỈ KHI posting_status === 'POSTED'. Không suy từ approval_status. */
  isCash: boolean;
}

/** Năng lực của actor trên phiếu/sổ đang xét. */
export interface VoucherCapabilities {
  /** `income_expenses.approve` trên đúng org/sổ. */
  canApprove: boolean;
  /** Người giữ sổ (CUSTODIAN) của sổ liên quan. */
  isCustodian: boolean;
  /** Human maker gốc còn active, tạo chính phiếu này. */
  isMaker: boolean;
  /** Được đảo posting đã ghi. */
  canReverse: boolean;
}

/** Các hành động lifecycle có thể bật cho actor. */
export interface VoucherActions {
  /** Duyệt: chỉ đổi phê duyệt, không đụng sổ. */
  approve: boolean;
  /** Duyệt và Thu/Chi: phê duyệt + ghi sổ trong một transaction. */
  approveAndPost: boolean;
  /** Thu/Chi phiếu đã duyệt (posting sau). */
  post: boolean;
  /** Yêu cầu bổ sung → CHANGES_REQUESTED. */
  requestChanges: boolean;
  /** Từ chối vì không phát sinh/trùng/sai → CANCELLED. */
  reject: boolean;
  /** Đánh dấu tranh chấp → DISPUTED. */
  dispute: boolean;
  /** Maker rút phiếu do chính mình tạo. */
  withdraw: boolean;
  /** Maker sửa xong nộp lại (CHANGES_REQUESTED → PENDING). */
  resubmit: boolean;
  /** Đảo phiếu đã POSTED. */
  reverse: boolean;
}

// --- Hằng nhãn (để test/consumer tham chiếu, tránh gõ lệch dấu) ---

export const VOUCHER_LABELS = {
  changesRequested: "Cần bổ sung",
  disputed: "Đang tranh chấp",
  pending: "Chờ duyệt",
  approvedUnpostedExpense: "Đã Duyệt - Chưa Chi",
  approvedUnpostedIncome: "Đã Duyệt - Chưa Thu",
  /** Hậu tố khi APPROVED + UNPOSTED + execution=UNASSIGNED. */
  awaitingAssignmentSuffix: " · Chờ phân sổ",
  nonCashRecognized: "Đã ghi nhận - Không qua sổ",
  postedExpense: "Đã Chi",
  postedIncome: "Đã Thu",
  reversed: "Đã hoàn tác",
  cancelled: "Đã hủy",
} as const;

/**
 * Mô hình hiển thị canonical của một phiếu thu/chi theo plan §12.1.
 *
 * Thứ tự ưu tiên (đảm bảo các dòng bảng loại trừ lẫn nhau với state hợp lệ):
 *   1. CANCELLED           → "Đã hủy"
 *   2. posting REVERSED     → "Đã hoàn tác"
 *   3. posting POSTED       → "Đã Chi"/"Đã Thu"  (isCash=true)
 *   4. APPROVED + NON_CASH  → "Đã ghi nhận - Không qua sổ"
 *   5. APPROVED + UNPOSTED  → "Đã Duyệt - Chưa Chi/Thu" (+ "· Chờ phân sổ" nếu UNASSIGNED)
 *   6. UNAPPROVED + CHANGES_REQUESTED → "Cần bổ sung"
 *   7. UNAPPROVED + DISPUTED          → "Đang tranh chấp"
 *   8. UNAPPROVED + PENDING           → "Chờ duyệt"
 */
export function getVoucherDisplayState(
  v: VoucherDisplayInput,
): VoucherDisplayState {
  // Bất biến cứng: tiền thật CHỈ đến từ posting POSTED, không từ phê duyệt.
  const isCash = v.posting_status === "POSTED";
  const isExpense = v.type === "EXPENSE";

  // 1. Đã hủy — thắng mọi trục khác.
  if (v.approval_status === "CANCELLED") {
    return { label: VOUCHER_LABELS.cancelled, tone: "cancelled", isCash };
  }

  // 2. Đã hoàn tác — posting bị đảo.
  if (v.posting_status === "REVERSED") {
    return { label: VOUCHER_LABELS.reversed, tone: "reversed", isCash };
  }

  // 3. Đã Chi / Đã Thu — posting đang hiệu lực.
  if (v.posting_status === "POSTED") {
    return {
      label: isExpense
        ? VOUCHER_LABELS.postedExpense
        : VOUCHER_LABELS.postedIncome,
      tone: "posted",
      isCash,
    };
  }

  // 4 & 5. Đã duyệt (chưa posting).
  if (v.approval_status === "APPROVED") {
    // Không qua sổ (bút toán ghi nhận).
    if (
      v.posting_mode === "NON_CASH" ||
      v.posting_status === "NOT_APPLICABLE"
    ) {
      return {
        label: VOUCHER_LABELS.nonCashRecognized,
        tone: "approved",
        isCash,
      };
    }
    // Đã Duyệt - Chưa Chi/Thu, thêm hậu tố nếu chưa phân sổ.
    const base = isExpense
      ? VOUCHER_LABELS.approvedUnpostedExpense
      : VOUCHER_LABELS.approvedUnpostedIncome;
    const label =
      v.execution_state === "UNASSIGNED"
        ? base + VOUCHER_LABELS.awaitingAssignmentSuffix
        : base;
    return { label, tone: "approved", isCash };
  }

  // 6-8. UNAPPROVED — theo review substate.
  const review = v.review_state ?? "PENDING";
  if (review === "CHANGES_REQUESTED") {
    return { label: VOUCHER_LABELS.changesRequested, tone: "changes", isCash };
  }
  if (review === "DISPUTED") {
    return { label: VOUCHER_LABELS.disputed, tone: "disputed", isCash };
  }
  // PENDING (hoặc legacy null/RESOLVED) + UNPOSTED → Chờ duyệt.
  return { label: VOUCHER_LABELS.pending, tone: "pending", isCash };
}

const NO_ACTIONS: VoucherActions = {
  approve: false,
  approveAndPost: false,
  post: false,
  requestChanges: false,
  reject: false,
  dispute: false,
  withdraw: false,
  resubmit: false,
  reverse: false,
};

/**
 * Hành động lifecycle hợp lệ cho actor trên một phiếu, theo năng lực (§2.2, §5.3).
 *
 * Quy tắc:
 *   - POSTED           : chỉ `reverse` (nếu canReverse). Không sửa/duyệt lại.
 *   - REVERSED/CANCELLED: terminal, không action.
 *   - APPROVED + UNPOSTED + CASHBOOK : `post` cho CUSTODIAN (không cần duyệt).
 *   - APPROVED + NON_CASH            : không post (không qua sổ).
 *   - UNAPPROVED :
 *       * approve/approveAndPost chỉ khi review=PENDING (Chờ duyệt);
 *         approveAndPost đòi vừa approver vừa CUSTODIAN và là CASHBOOK.
 *       * requestChanges: approver, trừ khi đã CHANGES_REQUESTED.
 *       * reject       : approver (bất kỳ UNAPPROVED).
 *       * dispute      : approver, trừ khi đã DISPUTED.
 *       * withdraw     : maker, chỉ UNPOSTED + review PENDING/CHANGES_REQUESTED.
 *       * resubmit     : maker, chỉ CHANGES_REQUESTED.
 */
export function getVoucherActions(
  v: VoucherLifecycleState,
  caps: VoucherCapabilities,
): VoucherActions {
  const posting = v.posting_status ?? "UNPOSTED";
  const review = v.review_state ?? "PENDING";
  // NON_CASH tường minh; null coi như CASHBOOK (mặc định phiếu tiền).
  const isCashbook = v.posting_mode !== "NON_CASH";

  // Đã posting: chỉ đảo được (nếu có quyền).
  if (posting === "POSTED") {
    return { ...NO_ACTIONS, reverse: caps.canReverse };
  }

  // Terminal: đã đảo hoặc đã hủy.
  if (posting === "REVERSED" || v.approval_status === "CANCELLED") {
    return { ...NO_ACTIONS };
  }

  // Đã duyệt, chưa posting.
  if (v.approval_status === "APPROVED") {
    return {
      ...NO_ACTIONS,
      // Chỉ CASHBOOK UNPOSTED mới Thu/Chi được; NON_CASH đã ghi nhận thì thôi.
      post: caps.isCustodian && isCashbook && posting === "UNPOSTED",
    };
  }

  // UNAPPROVED (PENDING / CHANGES_REQUESTED / DISPUTED).
  return {
    ...NO_ACTIONS,
    approve: caps.canApprove && review === "PENDING",
    approveAndPost:
      caps.canApprove && caps.isCustodian && review === "PENDING" && isCashbook,
    requestChanges: caps.canApprove && review !== "CHANGES_REQUESTED",
    reject: caps.canApprove,
    dispute: caps.canApprove && review !== "DISPUTED",
    withdraw:
      caps.isMaker &&
      posting === "UNPOSTED" &&
      (review === "PENDING" || review === "CHANGES_REQUESTED"),
    resubmit: caps.isMaker && review === "CHANGES_REQUESTED",
  };
}

/**
 * Ngưỡng lý do khi đổi cờ KQKD của phiếu bỏ cọc — GIỮ CHUNG MỘT CON SỐ với
 * server (`set_forfeit_voucher_kqkd_v1` ném 22023 khi < 8 ký tự).
 *
 * Đặt ở lib chứ không ở hook: đây là phần kiểm hợp lệ của một đường ghi sổ, nên
 * nó phải test được mà không dựng react-query, và phải có đúng một nơi để sửa
 * khi ngưỡng ở server đổi. Lời gọi RPC vẫn giữ literal tại chỗ để tên hàm còn
 * xuất hiện trong manifest bề mặt (xem scripts/check-raw-rpc-callers.mjs).
 */
export const FORFEIT_KQKD_REASON_MIN = 8;

/** true ⇔ lý do đủ dài để server nhận. Cắt khoảng trắng đúng như `btrim` bên SQL. */
export function forfeitKqkdReasonValid(reason: string | null | undefined): boolean {
  return (reason ?? "").trim().length >= FORFEIT_KQKD_REASON_MIN;
}
