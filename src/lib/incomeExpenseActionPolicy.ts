import type { ReservationRefundActionCapability } from './incomeExpenseActionSnapshot';
import type { FinanceV2OrgRoutes } from './financeV2Route';

/** A missing snapshot is not a negative permission or a LEGACY route. */
export type ActionReadiness<T> = { state: 'ready'; value: T } | { state: 'loading' } | { state: 'error'; reason: string };
export type IncomeExpenseAction = 'approveOnly' | 'legacyApprove' | 'approveAndPost' | 'post' | 'reverse' | 'unapprove'
  | 'cancel' | 'edit' | 'editRecipient' | 'supplement' | 'requestChanges' | 'resubmitReview';
export interface ActionVoucher {
  id: string; organizationId: string | null; buildingId: string | null; type: string;
  userId: string | null; makerUserId: string | null;
  approvalStatus: string; postingStatus: string | null; postingMode: string | null; reviewState: string | null;
  activePostingId: string | null; accountId: string | null;
  approvalVersion: number | null; postingVersion: number | null; reviewVersion: number | null;
}
export interface IncomeExpenseActionContext {
  /** A host may require the complete canonical route without changing legacy Thu chi behavior. */
  canonicalOnly?: boolean;
  /** Display hints never authorize writes; useful while a selected row's full snapshot loads. */
  display?: Pick<ActionVoucher, 'approvalStatus' | 'postingStatus' | 'reviewState'>;
  voucher: ActionReadiness<ActionVoucher>;
  actor: ActionReadiness<{ id: string; organizationId: string; isAdmin: boolean }>;
  /** Already resolved for this voucher's building, never a global permission guess. */
  permissions: ActionReadiness<{ approve: boolean; edit: boolean; cancel: boolean; reverse: boolean }>;
  routes: ActionReadiness<FinanceV2OrgRoutes>;
  ownership: ActionReadiness<{ flowKind: string | null; sourceReviewSupported: boolean; moneyEditAllowed: boolean }>;
  source: ActionReadiness<{moneyActionsAllowed:boolean;refundReverseAllowed:boolean;reservationRefund?:ReservationRefundActionCapability|null}>;
  lifecycle: ActionReadiness<{ approveBirthReady: boolean; forfeitPair: boolean; forfeitAllowed: boolean; unapproveSupported: boolean }>;
  custody: ActionReadiness<{ hasUsableCashbook: boolean; holdsVoucherCashbook: boolean }>;
  cancellation: ActionReadiness<{ canCancel: boolean; reason: string | null; useIncomeDoor: boolean; useFlexWriter: boolean; mode: string | null }>;
  handlers: Partial<Record<IncomeExpenseAction, boolean>>;
}
export interface IncomeExpenseActionAvailability {
  visible: boolean; enabled: boolean; loading: boolean; reason: string | null; reasonCode: string | null;
  writer?: 'canonical' | 'legacy' | 'income' | 'flex' | 'owned';
}
export type IncomeExpenseActionAvailabilityMap = Record<IncomeExpenseAction, IncomeExpenseActionAvailability>;
const actionNames: IncomeExpenseAction[] = ['approveOnly', 'legacyApprove', 'approveAndPost', 'post', 'reverse', 'unapprove',
  'cancel', 'edit', 'editRecipient', 'supplement', 'requestChanges', 'resubmitReview'];
const validVersion = (value: number | null) => value !== null && Number.isSafeInteger(value) && value >= 0;

export function pendingIncomeExpenseActionContext(
  handlers: IncomeExpenseActionContext['handlers'], display?: IncomeExpenseActionContext['display'], canonicalOnly = false,
): IncomeExpenseActionContext {
  return { handlers, display, canonicalOnly, voucher: { state: 'loading' }, actor: { state: 'loading' }, permissions: { state: 'loading' },
    routes: { state: 'loading' }, ownership: { state: 'loading' }, custody: { state: 'loading' }, lifecycle: { state: 'loading' }, source: { state: 'loading' }, cancellation: { state: 'loading' } };
}

/** Shared availability only. Commands must re-read/CAS and the server still authorizes each write. */
export function decideIncomeExpenseActions(c: IncomeExpenseActionContext): IncomeExpenseActionAvailabilityMap {
  const result = Object.fromEntries(actionNames.map(name => [name, { visible: !!c.handlers[name], enabled: false, loading: false, reason: null, reasonCode: null }])) as IncomeExpenseActionAvailabilityMap;
  const deny = (a: IncomeExpenseActionAvailability, code: string, reason: string) => { a.reasonCode = code; a.reason = reason; return false; };
  const requireReady = <T,>(a: IncomeExpenseActionAvailability, input: ActionReadiness<T>): input is { state: 'ready'; value: T } => {
    if (input.state === 'ready') return true;
    a.loading = input.state === 'loading';
    return deny(a, input.state === 'loading' ? 'LOADING' : 'READ_ERROR', input.state === 'loading' ? 'Đang tải điều kiện thao tác' : input.reason);
  };
  for (const name of actionNames) {
    const a = result[name];
    if (!a.visible) { deny(a, 'NO_HANDLER', 'Chưa có thao tác tương ứng'); continue; }
    if (c.voucher.state !== 'ready' && c.display) {
      const d = c.display;
      if ((['approveOnly', 'legacyApprove', 'approveAndPost', 'requestChanges', 'resubmitReview'].includes(name) && d.approvalStatus !== 'UNAPPROVED')
        || (name === 'post' && (d.approvalStatus !== 'APPROVED' || d.postingStatus === 'POSTED' || d.postingStatus === 'NOT_APPLICABLE'))
        || (name === 'reverse' && (d.approvalStatus === 'CANCELLED' || d.postingStatus !== 'POSTED'))
        || (name === 'unapprove' && d.approvalStatus !== 'APPROVED') || (name === 'cancel' && d.approvalStatus === 'CANCELLED')
        || (name === 'requestChanges' && d.reviewState === 'CHANGES_REQUESTED') || (name === 'resubmitReview' && d.reviewState !== 'CHANGES_REQUESTED')) a.visible = false;
    }
    if (!requireReady(a, c.voucher) || !requireReady(a, c.actor)) continue;
    const v = c.voucher.value, actor = c.actor.value;
    if (!v.organizationId || v.organizationId !== actor.organizationId) { deny(a, 'ORGANIZATION_SCOPE', 'Phiếu không thuộc tổ chức đang thao tác'); continue; }
    const pending = v.approvalStatus === 'UNAPPROVED', approved = v.approvalStatus === 'APPROVED', cancelled = v.approvalStatus === 'CANCELLED';
    const isReview = name === 'requestChanges' || name === 'resubmitReview';
    const approvalAction = ['approveOnly', 'legacyApprove', 'approveAndPost'].includes(name);
    const cash = v.postingMode === 'CASHBOOK';
    const visible = approvalAction ? pending : name === 'post' ? approved && v.postingStatus !== 'NOT_APPLICABLE' && v.postingStatus !== 'POSTED'
      : name === 'reverse' ? !cancelled && v.postingStatus === 'POSTED' : name === 'unapprove' ? approved
      : name === 'cancel' ? !cancelled : name === 'edit' ? pending || actor.isAdmin
      : name === 'requestChanges' ? pending && (v.reviewState === 'PENDING' || v.reviewState === 'DISPUTED' || v.reviewState === null)
      : name === 'resubmitReview' ? pending && (v.reviewState === 'CHANGES_REQUESTED' || v.reviewState === null) : true;
    if (!visible) { a.visible = false; deny(a, 'STATE', 'Trạng thái phiếu không hỗ trợ thao tác'); continue; }
    if (c.canonicalOnly) {
      if (!requireReady(a, c.routes)) continue;
      const routes = c.routes.value;
      if (routes.workflow !== 'CANONICAL' || routes.posting !== 'CANONICAL') {
        if (name === 'legacyApprove') a.visible = false;
        deny(a, 'CANONICAL_REQUIRED', 'Khu Hợp đồng & quyết toán cần quy trình thu chi chuẩn');
        continue;
      }
    }
    // Route-independent append-only evidence retains its existing UI authority (including cancelled vouchers).
    if (name === 'supplement') {
      if (actor.isAdmin || v.userId === actor.id) { a.enabled = true; continue; }
      if (!requireReady(a, c.permissions)) continue;
      a.enabled = c.permissions.value.edit || deny(a, 'PERMISSION', 'Cần quyền bổ sung chứng từ hoặc sửa thu chi'); continue;
    }
    if (!requireReady(a, c.source)) continue;
    const reservation = c.source.value.reservationRefund;
    const reservationAction = !!reservation && ['approveOnly','approveAndPost','post','requestChanges','resubmitReview','reverse'].includes(name) && reservation.basisValid && reservation.current && (name === 'reverse' || reservation.fullRemaining);
    if (!c.source.value.moneyActionsAllowed && !reservationAction && !(name === 'reverse' && c.source.value.refundReverseAllowed)) { deny(a, 'SOURCE_GUARD', 'Phiếu thuộc quyết toán giữ chỗ; xử lý tại luồng nguồn'); continue; }
    if (!requireReady(a, c.routes)) continue;
    const routes = c.routes.value;
    if (reservationAction) {
      if (routes.workflow !== 'CANONICAL' || (['post','approveAndPost','reverse'].includes(name) && routes.posting !== 'CANONICAL')) { deny(a, 'CANONICAL_REQUIRED', 'Thao tác cần quy trình thu chi chuẩn'); continue; }
      if (![v.approvalVersion,v.postingVersion,v.reviewVersion].every(validVersion)) { deny(a, 'CAS_REQUIRED', 'Chưa tải đủ phiên bản phiếu hoàn'); continue; }
      if (approvalAction && v.reviewState !== 'PENDING') { deny(a, 'STATE', 'Cần chuyển phiếu về chờ duyệt trước khi duyệt'); continue; }
    }
    const route = name === 'post' || name === 'reverse' ? routes.posting : routes.workflow;
    if (route === 'FROZEN' || ((name === 'approveAndPost' || name === 'cancel' || name === 'unapprove' || name === 'edit' || name === 'editRecipient') && routes.posting === 'FROZEN')) {
      deny(a, 'FROZEN', 'Tổ chức đang tạm khóa thao tác thu chi'); continue;
    }
    if (name === 'legacyApprove') {
      if (route === 'CANONICAL') { a.visible = false; deny(a, 'ROUTE', 'Phiếu dùng quy trình duyệt riêng và ghi sổ riêng'); continue; }
      a.writer = 'legacy';
    } else if (approvalAction || isReview || name === 'post' || name === 'reverse') {
      a.writer = 'canonical';
      if (route !== 'CANONICAL' || (name === 'approveAndPost' && routes.posting !== 'CANONICAL')) { deny(a, 'CANONICAL_REQUIRED', 'Thao tác cần quy trình thu chi chuẩn'); continue; }
    }
    if (name !== 'post') {
      if (!requireReady(a, c.permissions)) continue;
      const p = c.permissions.value;
      if ((approvalAction || name === 'requestChanges') && !p.approve && !((name === 'approveOnly' || name === 'legacyApprove') && c.lifecycle.state === 'ready' && c.lifecycle.value.forfeitPair && c.lifecycle.value.forfeitAllowed)) { deny(a, 'PERMISSION', 'Cần quyền duyệt thu chi tại tòa nhà'); continue; }
      if (name === 'reverse' && !p.reverse) { deny(a, 'PERMISSION', 'Cần quyền hoàn tác thu chi tại tòa nhà'); continue; }
      if (((name === 'edit' || name === 'editRecipient') && !p.edit) || (name === 'unapprove' && !actor.isAdmin)) { deny(a, 'PERMISSION', 'Không có quyền thực hiện thao tác'); continue; }
      if (name === 'resubmitReview' && (v.makerUserId ? v.makerUserId !== actor.id : !p.edit)) { deny(a, 'MAKER', 'Cần người lập gốc; phiếu cũ chưa có người lập cần quyền sửa tại tòa nhà'); continue; }
    }
    if (approvalAction || name === 'unapprove') {
      if (!requireReady(a, c.lifecycle)) continue;
      const life = c.lifecycle.value;
      if ((name === 'approveOnly' || name === 'legacyApprove') && life.forfeitPair && !life.forfeitAllowed) { deny(a, 'SOURCE_WRITER_UNSUPPORTED', 'Cặp cấn cọc chưa đủ quyền hoặc điều kiện duyệt'); continue; }
      if (name === 'unapprove' && !life.unapproveSupported) { deny(a, 'LIFECYCLE_GUARD', 'Phiếu đã khóa vòng đời hoặc thuộc luồng duyệt riêng'); continue; }
      if ((name === 'approveOnly' || name === 'approveAndPost') && !life.approveBirthReady
        && !(name === 'approveOnly' && life.forfeitPair && life.forfeitAllowed)) { deny(a, 'BIRTH_REQUIRED', 'Chưa có nguồn lập phiếu hợp lệ để duyệt'); continue; }
    }
    if (name === 'cancel') {
      if (!requireReady(a, c.cancellation)) continue;
      const cancel = c.cancellation.value;
      a.writer = cancel.useIncomeDoor ? 'income' : cancel.useFlexWriter ? 'flex' : 'legacy';
      if (!cancel.canCancel) { deny(a, 'CANCEL_DENIED', cancel.reason || 'Phiếu chưa đủ điều kiện hủy'); continue; }
      if (!cancel.useIncomeDoor && (!validVersion(v.approvalVersion) || !validVersion(v.postingVersion))) { deny(a, 'CAS_REQUIRED', 'Chưa tải phiên bản phiếu để hủy'); continue; }
    }
    if (name === 'edit' || name === 'editRecipient' || isReview || approvalAction || name === 'post' || name === 'reverse' || name === 'unapprove') {
      if (!requireReady(a, c.ownership)) continue;
      const owner = c.ownership.value;
      if ((name === 'post' || name === 'reverse') && owner.flowKind !== null && owner.flowKind !== 'CANONICAL_INCOME_EXPENSE') {
        deny(a, 'SOURCE_WRITER_UNSUPPORTED', name === 'reverse' ? 'Nguồn phiếu chưa có cửa hoàn tác dùng chung' : 'Nguồn phiếu chưa có cửa ghi sổ dùng chung'); continue;
      }
      if (isReview && (!owner.sourceReviewSupported || (owner.flowKind !== null && owner.flowKind !== 'CANONICAL_INCOME_EXPENSE'))) { deny(a, 'SOURCE_REVIEW_UNSUPPORTED', 'Nguồn phiếu chưa có cửa yêu cầu sửa/chuyển chờ duyệt an toàn'); continue; }
      if ((name === 'edit' || name === 'editRecipient') && !owner.moneyEditAllowed) { deny(a, 'PAYLOAD_FROZEN', 'Phiếu khóa nội dung tài chính; có thể bổ sung chứng từ'); continue; }
      if (approvalAction && owner.flowKind !== null && owner.flowKind !== 'CANONICAL_INCOME_EXPENSE') {
        if ((name === 'approveOnly' && ['INVOICE_REFUND', 'TERMINATION_REFUND'].includes(owner.flowKind))
          || ((name === 'approveOnly' || name === 'legacyApprove') && c.lifecycle.state === 'ready' && c.lifecycle.value.forfeitPair && c.lifecycle.value.forfeitAllowed)) a.writer = 'owned';
        else { deny(a, 'SOURCE_WRITER_UNSUPPORTED', 'Nguồn phiếu cần cửa duyệt riêng'); continue; }
      }
    }
    if (name === 'editRecipient' && (!pending || v.activePostingId !== null || !(cash && v.postingStatus === 'UNPOSTED' || v.postingMode === 'NON_CASH' && v.postingStatus === 'NOT_APPLICABLE'))) {
      deny(a, 'STATE', 'Chỉ sửa người nhận khi phiếu chưa duyệt và chưa ghi sổ'); continue;
    }
    if (isReview) {
      if (v.activePostingId !== null || !(cash && v.postingStatus === 'UNPOSTED' || v.postingMode === 'NON_CASH' && v.postingStatus === 'NOT_APPLICABLE')) { deny(a, 'STATE', 'Phiếu cần chưa duyệt và chưa ghi sổ'); continue; }
      if (!validVersion(v.reviewVersion)) { deny(a, 'CAS_REQUIRED', 'Chưa tải phiên bản rà soát'); continue; }
      if (v.reviewState === null) { deny(a, 'STATE', 'Chưa tải trạng thái rà soát'); continue; }
    }
    if ((name === 'approveOnly' || name === 'approveAndPost') && (!validVersion(v.approvalVersion) || !validVersion(v.postingVersion) || !['PENDING', 'CHANGES_REQUESTED'].includes(v.reviewState || ''))) { deny(a, 'CAS_REQUIRED', 'Cần trạng thái và phiên bản duyệt hiện tại'); continue; }
    if (name === 'approveOnly' && (v.activePostingId !== null || !(cash && v.postingStatus === 'UNPOSTED' || v.postingMode === 'NON_CASH' && v.postingStatus === 'NOT_APPLICABLE'))) { deny(a, 'POSTING_STATE', 'Phiếu chưa đủ điều kiện duyệt riêng'); continue; }
    if ((name === 'unapprove' || name === 'legacyApprove') && !validVersion(v.approvalVersion)) { deny(a, 'CAS_REQUIRED', 'Chưa tải phiên bản duyệt hiện tại'); continue; }
    if (name === 'approveAndPost' || name === 'post' || name === 'reverse') {
      if (!cash || !validVersion(v.postingVersion) || !validVersion(v.approvalVersion)) { deny(a, 'CASH_STATE', 'Cần phiếu ghi sổ và phiên bản hiện tại'); continue; }
      const posted = name === 'reverse';
      const canPostState = v.postingStatus === 'UNPOSTED' || (name === 'post' && v.postingStatus === 'REVERSED');
      if (posted ? !v.activePostingId || !v.accountId : v.activePostingId !== null || !canPostState) { deny(a, 'POSTING_STATE', 'Trạng thái bút toán chưa đủ điều kiện'); continue; }
      if (!requireReady(a, c.custody)) continue;
      if (posted ? !c.custody.value.holdsVoucherCashbook : !c.custody.value.hasUsableCashbook) { deny(a, 'CUSTODY', posted ? 'Cần giữ đúng sổ quỹ của phiếu' : 'Cần sổ quỹ có thể thu/chi'); continue; }
    }
    a.enabled = true;
  }
  return result;
}
