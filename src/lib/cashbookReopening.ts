import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';
import { normalizeDateOnly } from '@/lib/firstInvoiceBuilder';
import { FinancialWorkflowError } from '@/lib/financialWorkflow';
import type { OperationErrorRule } from '@/lib/friendlyError';

const dateOnly = z.string().refine(value => normalizeDateOnly(value) === value, 'Ngày không hợp lệ');
const revision = z.string().min(1);
const historyEntry = z.object({
  id: z.string().uuid(),
  reopened_at: z.string().datetime({ offset: true }),
  reopened_by_name: z.string().nullable(),
  reason: z.string().min(10).max(1000),
  previous_lock_date: dateOnly,
  idempotency_key: z.string().uuid(),
  previous_revision: revision,
});
const stateSchema = z.object({
  cashbook_id: z.string().uuid(),
  can_reopen: z.boolean(),
  blocked_reason: z.enum(['PENDING_CLOSURE']).nullable(),
  lock_date: dateOnly.nullable(),
  revision,
  history: z.array(historyEntry),
}).refine(value => !value.can_reopen || value.lock_date !== null);
const receiptSchema = z.object({
  cashbook_id: z.string().uuid(),
  reopening_id: z.string().uuid(),
  status: z.literal('REOPENED'),
  lock_date: z.null(),
  idempotency_key: z.string().uuid(),
  previous_revision: revision,
});
const inputSchema = z.object({
  cashbookId: z.string().uuid(),
  cashbookName: z.string().nullish(),
  reason: z.string().trim().min(10).max(1000),
  expectedLockDate: dateOnly,
  expectedRevision: revision,
});

export type CashbookReopeningState = z.infer<typeof stateSchema>;
export type CashbookReopeningReceipt = z.infer<typeof receiptSchema>;
export type ReopenCashbookInput = z.infer<typeof inputSchema>;

// Narrow transport contract while the forward migration is awaiting deployment
// and generated types. Both JSON responses are validated before entering cache.
type ReopeningRpcResult = PromiseLike<{ data: unknown; error: unknown }>;
interface ReopeningRpc {
  (name: 'cashbook_reopening_state_v1', args: { p_cashbook: string }): ReopeningRpcResult;
  (name: 'reopen_cashbook_v1', args: {
    p_cashbook: string;
    p_reason: string;
    p_expected_lock_date: string;
    p_expected_revision: string;
    p_idempotency_key: string;
  }): ReopeningRpcResult;
}
const client = { rpc: (supabase.rpc as unknown as ReopeningRpc).bind(supabase) };

export function validateReopenCashbookInput(input: ReopenCashbookInput): ReopenCashbookInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new FinancialWorkflowError(
    'Nhập lý do mở khóa từ 10 đến 1000 ký tự và tải lại trạng thái sổ trước khi tiếp tục.', 'failure', [],
  );
  return parsed.data;
}

export async function readCashbookReopeningState(cashbookId: string): Promise<CashbookReopeningState> {
  const { data, error } = await client.rpc('cashbook_reopening_state_v1', { p_cashbook: cashbookId });
  if (error) throw error;
  const parsed = stateSchema.safeParse(data);
  if (!parsed.success || parsed.data.cashbook_id !== cashbookId) {
    throw new Error('Chưa xác nhận được quyền và lịch sử mở khóa của sổ quỹ này. Tải lại để kiểm tra.');
  }
  return parsed.data;
}

export async function reopenCashbook(input: ReopenCashbookInput, requestKey: string): Promise<CashbookReopeningReceipt> {
  const checked = validateReopenCashbookInput(input);
  const { data, error } = await client.rpc('reopen_cashbook_v1', {
    p_cashbook: checked.cashbookId,
    p_reason: checked.reason,
    p_expected_lock_date: checked.expectedLockDate,
    p_expected_revision: checked.expectedRevision,
    p_idempotency_key: requestKey,
  });
  if (error) throw error;
  const parsed = receiptSchema.safeParse(data);
  if (!parsed.success || parsed.data.cashbook_id !== checked.cashbookId
    || parsed.data.idempotency_key !== requestKey || parsed.data.previous_revision !== checked.expectedRevision) {
    throw new FinancialWorkflowError(
      'Chưa xác nhận được kết quả mở khóa. Tải lại lịch sử sổ để đối chiếu trước khi thực hiện tiếp.', 'unknown', [],
    );
  }
  return parsed.data;
}

export const CASHBOOK_REOPENING_RULES: readonly OperationErrorRule[] = [
  { message: /\[REOPEN_REASON_REQUIRED\]/, fieldErrors: { reason: 'Nhập lý do từ 10 đến 1000 ký tự.' }, description: 'Cần ghi rõ lý do mở khóa sổ.' },
  { message: /\[REOPEN_FORBIDDEN\]/, description: 'Chỉ chủ tổ chức sở hữu sổ này được mở khóa.' },
  { message: /\[REOPEN_STALE\]/, description: 'Trạng thái sổ đã thay đổi. Tải lại và kiểm tra ngày khóa trước khi tiếp tục.', recovery: 'reload' },
  { message: /\[REOPEN_NOT_LOCKED\]/, description: 'Sổ hiện không còn khóa. Tải lại danh sách sổ.', recovery: 'reload' },
  { message: /\[REOPEN_PENDING_CLOSURE\]/, description: 'Sổ có đề nghị chốt đang chờ. Xử lý đề nghị đó trước khi mở khóa.', recovery: 'reload' },
  { message: /\[REOPEN_KEY_REUSED\]/, description: 'Yêu cầu trước có nội dung khác. Kiểm tra lịch sử mở khóa trước khi thực hiện tiếp.', recovery: 'reload' },
];
