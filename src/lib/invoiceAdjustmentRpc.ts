import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';
import type { InvoiceAdjustment } from '@/types/invoice';
import type { AdjustmentRequest } from './invoiceAdjustmentEditor';

export type AdjustInvoiceInput = AdjustmentRequest & { idempotencyKey: string };
export type ReviewAdjustmentInput = { adjustmentId: string; expectedRevision: number };
const adjustmentResult = z.object({
  id: z.string().uuid(), organization_id: z.string().uuid(), invoice_id: z.string().uuid(),
  revision: z.number().int().positive(), idempotency_key: z.string(), reason: z.string(),
  before_snapshot: z.record(z.unknown()), after_snapshot: z.record(z.unknown()),
  before_total: z.number().finite(), after_total: z.number().finite(), delta: z.number().finite(),
  adjusted_by: z.string().uuid(), adjusted_at: z.string().datetime({ offset: true }),
  review_status: z.enum(['PENDING', 'CHECKED']), checked_by: z.string().nullable(), checked_at: z.string().nullable(),
});
export class InvoiceAdjustmentError extends Error {
  readonly kind: 'conflict' | 'permission' | 'validation' | 'constraint' | 'internal';
  readonly showPaymentHistory: boolean;
  constructor(error: { code?: string; message?: string }) {
    const kind = error.code === '40001' || error.code === '23505' ? 'conflict' : error.code === '42501' ? 'permission' : error.code === '22023' ? 'validation' : error.code === '55000' ? 'constraint' : 'internal';
    super(kind === 'internal' ? 'Chưa xác nhận được kết quả lưu. Giữ nguyên nội dung và thử lại; nếu vẫn lỗi, hãy tải lại hóa đơn.' : kind === 'conflict' ? 'Hóa đơn vừa thay đổi hoặc vừa thu tiền. Tải lại hóa đơn trước khi tiếp tục.' : kind === 'permission' ? 'Bạn không có quyền điều chỉnh hoặc kiểm tra hóa đơn trong tổ chức/tòa này.' : error.message ?? 'Không thể thực hiện điều chỉnh.');
    this.name = 'InvoiceAdjustmentError';
    this.kind = kind;
    this.showPaymentHistory = kind === 'constraint' && /phân bổ|credit|làm tròn|chuyển sang|thanh toán|đảo giao dịch/i.test(error.message ?? '');
  }
}
function parseResult(data: unknown, error: { code?: string; message?: string } | null): InvoiceAdjustment {
  if (error) throw new InvoiceAdjustmentError(error);
  const parsed = adjustmentResult.safeParse(data);
  if (!parsed.success) throw new InvoiceAdjustmentError({});
  const row = parsed.data;
  return {
    id: row.id, organization_id: row.organization_id, invoice_id: row.invoice_id,
    revision: row.revision, idempotency_key: row.idempotency_key, reason: row.reason,
    before_snapshot: row.before_snapshot, after_snapshot: row.after_snapshot,
    before_total: row.before_total, after_total: row.after_total, delta: row.delta,
    adjusted_by: row.adjusted_by, adjusted_at: row.adjusted_at,
    review_status: row.review_status, checked_by: row.checked_by, checked_at: row.checked_at,
  };
}
export async function adjustInvoice(input: AdjustInvoiceInput): Promise<InvoiceAdjustment> {
  try {
    const { data, error } = await supabase.rpc('adjust_invoice_v2', {
    p_invoice_id: input.invoiceId, p_after_items: input.afterItems,
    p_discount_amount: input.discountAmount, p_discount_notes: input.discountNotes, p_notes: input.notes,
    p_reason: input.reason, p_expected_revision: input.expectedRevision,
    p_expected_paid_amount: input.expectedPaidAmount, p_expected_updated_at: input.expectedUpdatedAt,
    p_idempotency_key: input.idempotencyKey,
    });
    return parseResult(data, error);
  } catch (cause) {
    throw cause instanceof InvoiceAdjustmentError ? cause : new InvoiceAdjustmentError({});
  }
}
export async function reviewInvoiceAdjustment(input: ReviewAdjustmentInput): Promise<InvoiceAdjustment> {
  try {
    const { data, error } = await supabase.rpc('review_invoice_adjustment_v2', {
    p_adjustment_id: input.adjustmentId, p_expected_revision: input.expectedRevision,
    });
    return parseResult(data, error);
  } catch (cause) {
    throw cause instanceof InvoiceAdjustmentError ? cause : new InvoiceAdjustmentError({});
  }
}
