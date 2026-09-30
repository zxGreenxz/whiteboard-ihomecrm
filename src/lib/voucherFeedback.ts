import {FinancialWorkflowError,workflowFeedbackDescription} from './financialWorkflowError';
import { VOUCHER_ERROR_RULES } from "./voucherErrorRules";
import { friendlyError } from './friendlyError';
import { periodBlockMessage } from './cashbookClosing';
import { hasUnconfirmedResponse } from './operationOutcome';
import {FinancialPendingError,FinancialPendingStorageError} from './financialPending';

export interface VoucherFeedback { kind: 'success' | 'info' | 'warning'; message: string }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};

/** Failed transport is not proof that a financial command was rolled back. */
export function voucherOutcomeUnknown(error: unknown): boolean {
  return hasUnconfirmedResponse(error);
}

export function voucherFailureMessage(error: unknown, action: string): string {
  if(error instanceof FinancialWorkflowError)return workflowFeedbackDescription(error);
  if(error instanceof FinancialPendingError||error instanceof FinancialPendingStorageError)return error.message+(error instanceof FinancialPendingError&&error.pending?.completedIds.length?` Mã đã nhận: ${error.pending.completedIds.join(', ')}.`:'');
  if (error instanceof VoucherPartialError) return error.message;
  if (voucherOutcomeUnknown(error)) return `Chưa xác nhận được kết quả ${action}. Hãy tải lại danh sách và kiểm tra trạng thái phiếu trước khi thực hiện tiếp.`;
  const raw = String(record(error).message ?? '');
  if (record(error).code === 'PT409' || /approval_version mismatch/i.test(raw)) return action === 'duyệt phiếu' ? 'Phiếu vừa được sửa — tải lại để xem thay đổi trước khi duyệt.' : 'Phiếu vừa được người khác thay đổi — hãy tải lại phiếu để kiểm tra.';
  if (/frozen/i.test(raw) && action === 'bỏ duyệt phiếu') return 'Phiếu này không hỗ trợ bỏ duyệt. Hãy kiểm tra phiếu trước khi chọn Huỷ phiếu hoặc Tạo bản sao.';
  if (/frozen/i.test(raw) && action === 'khôi phục phiếu') return 'Phiếu đã huỷ không hỗ trợ khôi phục. Có thể dùng Tạo bản sao để lập phiếu mới sau khi kiểm tra.';
  const blocked = periodBlockMessage(raw);
  if (blocked) return blocked;
  const feedback = friendlyError(error, `Không thể ${action}`, { operation: action, financial: true, rules: VOUCHER_ERROR_RULES });
  const known = VOUCHER_ERROR_RULES.some(rule => (!rule.code || rule.code === record(error).code) && (typeof rule.message === 'string' ? rule.message === raw : rule.message.test(raw)));
  return known ? feedback.description : `${feedback.title}. ${feedback.description}`;
}

/** Carries the receipts of completed steps to the form; never retry the whole batch. */
export class VoucherPartialError extends Error {
  override readonly name = 'VoucherPartialError';
  constructor(message: string, readonly completedIds: readonly string[], readonly batchId?: string, readonly cause?: unknown) { super(message); }
}

export function createdVoucherFeedback(value: unknown): VoucherFeedback {
  const row = record(value);
  const name = typeof row.code === 'string' && row.code ? `phiếu ${row.code}` : 'phiếu';
  if (row.posting_status === 'POSTED' || row.postingStatus === 'POSTED') return {kind:'success',message:`Đã tạo ${name} và ghi nhận thu/chi vào sổ quỹ.`};
  if (row.approval_status === 'UNAPPROVED') return {kind:'success',message:`Đã tạo ${name}. Phiếu đang chờ duyệt, chưa ghi nhận thu/chi.`};
  if (row.approval_status === 'APPROVED' && (row.posting_status === 'UNPOSTED' || row.postingStatus === 'UNPOSTED')) return {kind:'success',message:`Đã tạo ${name}. Phiếu đã được duyệt, chưa ghi nhận thu/chi.`};
  return {kind:'warning',message:row.id ? `Đã tạo ${name}. Hãy tải lại danh sách để kiểm tra trạng thái duyệt và thu/chi.` : 'Chưa xác nhận được kết quả tạo phiếu. Hãy tải lại danh sách và kiểm tra trước khi tạo thêm.'};
}

export function approvalDecisionFeedback(value: unknown, decision: 'APPROVE' | 'REJECT' | 'WITHDRAW'): VoucherFeedback {
  const state = record(value).state;
  if (decision === 'APPROVE') {
    if (state === 'PENDING_APPROVAL') return {kind:'info',message:'Đã ghi nhận bước duyệt của bạn. Yêu cầu vẫn đang chờ các bước duyệt còn lại.'};
    if (state === 'POSTED') return {kind:'success',message:'Đã duyệt yêu cầu và ghi nhận thu/chi vào sổ quỹ.'};
    if (state === 'APPROVED') return {kind:'success',message:'Đã duyệt yêu cầu. Chưa xác nhận thu/chi vào sổ quỹ.'};
  }
  if (decision === 'REJECT' && state === 'REJECTED') return {kind:'success',message:'Đã từ chối yêu cầu.'};
  if (decision === 'WITHDRAW' && ['CANCELLED','WITHDRAWN'].includes(String(state))) return {kind:'success',message:'Đã thu hồi yêu cầu duyệt. Hãy xem trạng thái hiện tại của phiếu trong danh sách thu chi.'};
  return {kind:'warning',message:'Chưa xác nhận được trạng thái cuối của yêu cầu. Hãy tải lại danh sách trước khi thao tác tiếp.'};
}

export function voucherLifecycleFeedback(value: unknown, action: 'approve' | 'post' | 'approvePost' | 'reverse'): VoucherFeedback {
  const data = record(value);
  const approval = data.approvalStatus ?? data.approval_status;
  const posting = data.postingStatus ?? data.posting_status;
  if (action === 'approve' && (approval === 'APPROVED' || data.approved === true)) return data.already === true
    ? {kind:'info',message:'Phiếu đã được duyệt trước đó. Không tạo thêm lần duyệt.'}
    : {kind:'success',message:'Đã duyệt phiếu. Chưa ghi nhận thu/chi vào sổ quỹ.'};
  if ((action === 'post' || action === 'approvePost') && posting === 'POSTED') return {kind:'success',message:action === 'approvePost' ? 'Đã duyệt phiếu và ghi nhận thu/chi vào sổ quỹ.' : 'Đã ghi nhận thu/chi vào sổ quỹ.'};
  if (action === 'reverse' && posting === 'REVERSED') return {kind:'success',message:'Đã hoàn tác lần thu/chi. Số liệu sổ quỹ đã được cập nhật; phiếu chưa bị huỷ.'};
  return {kind:'warning',message:'Chưa xác nhận được trạng thái cuối của phiếu. Hãy tải lại danh sách trước khi thao tác tiếp.'};
}
