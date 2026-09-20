import { useMutation } from '@tanstack/react-query';
import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';

export interface ResubmitIncomeExpenseReviewInput {
  voucherId: string;
  expectedReviewVersion: number;
  /** Owned by the shared controller: preserve it when the network result is unknown. */
  idempotencyKey: string;
}
export interface RequestIncomeExpenseChangesInput extends ResubmitIncomeExpenseReviewInput { reason: string }
export interface IncomeExpenseReviewResult {
  voucherId: string; approvalStatus: 'UNAPPROVED'; reviewState: 'PENDING' | 'CHANGES_REQUESTED'; reviewVersion: number;
}
export class IncomeExpenseReviewError extends Error {
  constructor(message: string, readonly kind: 'validation' | 'permission' | 'concurrency' | 'conflict' | 'not-found' | 'unconfirmed', readonly code: string | null = null) {
    super(message); this.name = 'IncomeExpenseReviewError';
  }
}
const inputSchema = z.object({
  voucherId: z.string().uuid(), expectedReviewVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  idempotencyKey: z.string().min(1).max(200).refine(value => value.trim().length > 0),
}).strict();
const requestSchema = inputSchema.extend({ reason: z.string().trim().min(1).max(5000) }).strict();
const resultSchema = z.object({
  voucherId: z.string().uuid(), approvalStatus: z.literal('UNAPPROVED'), reviewState: z.enum(['PENDING', 'CHANGES_REQUESTED']),
  reviewVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
const unconfirmed = () => new IncomeExpenseReviewError('Chưa xác nhận được kết quả. Giữ nguyên phiếu và tải lại để kiểm tra trước khi xử lý tiếp.', 'unconfirmed');
function serverError(code: string | undefined) {
  if (code === '42501') return new IncomeExpenseReviewError('Bạn không còn quyền thực hiện thao tác trên phiếu này.', 'permission', code);
  if (code === '40001') return new IncomeExpenseReviewError('Phiếu vừa thay đổi. Hãy tải lại và kiểm tra trước khi gửi.', 'concurrency', code);
  if (code === '22023') return new IncomeExpenseReviewError('Thông tin rà soát không hợp lệ. Hãy kiểm tra lại nội dung.', 'validation', code);
  if (code === 'P0002') return new IncomeExpenseReviewError('Không tìm thấy phiếu trong phạm vi được xem.', 'not-found', code);
  if (code === '55000' || code === '23505' || code === 'P0001') return new IncomeExpenseReviewError('Phiếu chưa đủ điều kiện hoặc yêu cầu đã thay đổi. Hãy tải lại để đối chiếu.', 'conflict', code);
  return unconfirmed();
}
async function sendReview(
  send: () => PromiseLike<{ data: unknown; error: { code?: string } | null }>,
  voucherId: string,
  expectedReviewVersion: number,
  expectedState: IncomeExpenseReviewResult['reviewState'],
): Promise<IncomeExpenseReviewResult> {
  let response: Awaited<ReturnType<typeof send>>;
  try { response = await send(); } catch { throw unconfirmed(); }
  if (response.error) throw serverError(response.error.code);
  const parsed = resultSchema.safeParse(response.data);
  if (!parsed.success || parsed.data.voucherId !== voucherId || parsed.data.reviewState !== expectedState
    || parsed.data.reviewVersion !== expectedReviewVersion + 1) throw unconfirmed();
  return { voucherId: parsed.data.voucherId, approvalStatus: parsed.data.approvalStatus,
    reviewState: parsed.data.reviewState, reviewVersion: parsed.data.reviewVersion };
}

/** No fallback, new key, notification or optimistic status. The shared host owns revalidation and feedback. */
export function useRequestIncomeExpenseChanges() {
  return useMutation({ retry: false, mutationFn: async (input: RequestIncomeExpenseChangesInput) => {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) throw new IncomeExpenseReviewError('Nhập lý do rà soát và tải lại phiên bản phiếu trước khi gửi.', 'validation');
    const fields = parsed.data;
    return sendReview(() => supabase.rpc('request_income_expense_changes_v2', {
      p_voucher: fields.voucherId, p_expected_review_version: fields.expectedReviewVersion, p_reason: fields.reason,
      p_field_mask: {}, p_idempotency_key: fields.idempotencyKey,
    }), fields.voucherId, fields.expectedReviewVersion, 'CHANGES_REQUESTED');
  } });
}

/** CHANGES_REQUESTED → PENDING on the same voucher; this API cannot carry a financial patch. */
export function useResubmitIncomeExpenseReview() {
  return useMutation({ retry: false, mutationFn: async (input: ResubmitIncomeExpenseReviewInput) => {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw new IncomeExpenseReviewError('Chưa có đủ thông tin phiên bản phiếu để chuyển chờ duyệt.', 'validation');
    const fields = parsed.data;
    return sendReview(() => supabase.rpc('resubmit_income_expense_v2', {
      p_voucher: fields.voucherId, p_expected_review_version: fields.expectedReviewVersion,
      p_patch: {}, p_idempotency_key: fields.idempotencyKey,
    }), fields.voucherId, fields.expectedReviewVersion, 'PENDING');
  } });
}
