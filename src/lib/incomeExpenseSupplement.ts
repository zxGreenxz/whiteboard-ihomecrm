import { z } from 'zod';

export const incomeExpenseSupplementSchema = z.object({
  id: z.string().uuid(), organization_id: z.string().uuid(), income_expense_id: z.string().uuid(),
  note: z.string().nullable(), attachments: z.array(z.string()),
  actor_id: z.string().uuid(), actor_name: z.string(), created_at: z.string().datetime({ offset: true }),
});
export interface IncomeExpenseSupplement {
  id: string; organization_id: string; income_expense_id: string;
  note: string | null; attachments: string[];
  actor_id: string; actor_name: string; created_at: string;
}
export interface SupplementedVoucher {
  attachments?: string[] | null;
  supplements?: IncomeExpenseSupplement[];
}

export const supplementFormSchema = z.object({
  note: z.string().trim().max(5000, 'Ghi chú bổ sung tối đa 5.000 ký tự.'),
  attachments: z.array(z.string().url()).max(20, 'Mỗi lần bổ sung tối đa 20 tệp.'),
}).refine(value => value.note.length > 0 || value.attachments.length > 0, {
  message: 'Nhập ghi chú hoặc chọn ảnh để bổ sung.', path: ['note'],
});
export interface SupplementFormValues { note: string; attachments: string[]; }
export const appendSupplementInputSchema = supplementFormSchema.and(z.object({
  voucherId: z.string().uuid(), idempotencyKey: z.string().trim().min(1).max(200),
}));

/** Presentation only: never send this union back through a financial writer. */
export function getVoucherDisplayAttachments(voucher: SupplementedVoucher): string[] {
  return [...new Set([...(voucher.attachments ?? []), ...(voucher.supplements ?? []).flatMap(s => s.attachments)])];
}

export function formatSupplementAuthor(supplement: Pick<IncomeExpenseSupplement, 'actor_name' | 'created_at'>): string {
  const date = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(supplement.created_at));
  return `Người bổ sung: ${supplement.actor_name} · ${date}`;
}

export function supplementErrorMessage(error: unknown): string {
  const parsed = z.object({ code: z.string().optional(), message: z.string().optional() }).safeParse(error);
  if (!parsed.success) return 'Chưa lưu được phần bổ sung. Hãy thử lại.';
  const { code } = parsed.data;
  if (code === '42501') return 'Bạn không có quyền bổ sung chứng từ cho phiếu này.';
  if (code === 'P0002') return 'Không tìm thấy phiếu hoặc phiếu không còn được chia sẻ với bạn.';
  if (code === '22023') return 'Nội dung hoặc ảnh bổ sung không hợp lệ. Hãy kiểm tra và chọn lại ảnh.';
  if (code === '23505' || code === '40001') return 'Lần bổ sung này đã được ghi nhận với nội dung khác. Hãy mở lại phiếu để kiểm tra.';
  return 'Chưa xác nhận được phần bổ sung đã lưu. Hãy thử lưu lại để kiểm tra.';
}

export const appendSupplementResultSchema = z.object({
  id: z.string().uuid(), income_expense_id: z.string().uuid(), changed: z.boolean(), replayed: z.boolean().optional(),
});
