import { z } from 'zod';

export interface VoucherRecipient { payerName: string | null; bankName: string | null; bankAccount: string | null }
export interface RecipientExpected extends VoucherRecipient { approvalVersion: number | null; postingVersion: number | null; reviewVersion: number | null }
export interface RecipientUpdateInput { voucherId: string; organizationId: string; expected: RecipientExpected; patch: Partial<VoucherRecipient> }
export interface RecipientUpdateResult { voucherId: string; organizationId: string; recipient: VoucherRecipient }
export type RecipientWriter = (name: 'update_income_expense_recipient_v1', args: {
  p_organization_id: string; p_voucher_id: string; p_expected: RecipientExpected; p_patch: Partial<VoucherRecipient>;
}) => PromiseLike<{ data: unknown; error: { code?: string } | null }>;
export class RecipientUpdateError extends Error {
  constructor(message: string, readonly kind: 'validation' | 'permission' | 'concurrency' | 'conflict' | 'unconfirmed') { super(message); this.name = 'RecipientUpdateError'; }
}
const keys = ['payerName', 'bankName', 'bankAccount'] as const;
const recipientSchema = z.object({ payerName: z.string().nullable(), bankName: z.string().nullable(), bankAccount: z.string().nullable() }).strict();
const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();
const expectedSchema = recipientSchema.extend({ approvalVersion: version, postingVersion: version, reviewVersion: version }).strict();
const inputSchema = z.object({ voucherId: z.string().uuid(), organizationId: z.string().uuid(), expected: expectedSchema,
  patch: recipientSchema.partial().strict().refine(value => Object.keys(value).length > 0 && Object.values(value).every(item => item !== undefined)),
}).strict();
const resultSchema = z.object({ voucherId: z.string().uuid(), organizationId: z.string().uuid(), recipient: recipientSchema });

/** Untouched text stays byte-for-byte intact; blanking a changed field explicitly clears it. */
export function buildRecipientPatch(original: VoucherRecipient, draft: VoucherRecipient): Partial<VoucherRecipient> {
  const patch: Partial<VoucherRecipient> = {};
  for (const key of keys) {
    if ((draft[key] ?? '') === (original[key] ?? '')) continue;
    const next = draft[key]?.trim() || null;
    if (next !== original[key]) patch[key] = next;
  }
  return patch;
}
const uncertain = () => new RecipientUpdateError('Chưa xác nhận được việc sửa người nhận. Hãy tải lại phiếu để đối chiếu trước khi gửi tiếp.', 'unconfirmed');
export async function updateIncomeExpenseRecipient(input: RecipientUpdateInput, send: RecipientWriter): Promise<RecipientUpdateResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new RecipientUpdateError('Chỉ sửa thông tin người nhận đã thay đổi và tải đủ phiên bản phiếu trước khi lưu.', 'validation');
  // Validate all input first; the explicit interface avoids optional inference in legacy non-strict callers.
  const { voucherId, organizationId, expected, patch } = input;
  let response: Awaited<ReturnType<RecipientWriter>>;
  try { response = await send('update_income_expense_recipient_v1', { p_organization_id: organizationId, p_voucher_id: voucherId, p_expected: expected, p_patch: patch }); }
  catch { throw uncertain(); }
  if (response.error) {
    const code = response.error.code;
    if (code === '40001') throw new RecipientUpdateError('Phiếu vừa thay đổi. Hãy tải lại và kiểm tra người nhận trước khi lưu.', 'concurrency');
    if (code === '42501' || code === 'P0002') throw new RecipientUpdateError('Không còn quyền sửa người nhận trên phiếu này.', 'permission');
    if (code === '22023') throw new RecipientUpdateError('Thông tin người nhận không hợp lệ.', 'validation');
    if (code === '55000' || code === '23505' || code === 'P0001') throw new RecipientUpdateError('Phiếu đang khóa nội dung hoặc chưa đủ điều kiện sửa người nhận.', 'conflict');
    throw uncertain();
  }
  const result = resultSchema.safeParse(response.data);
  if (!result.success || result.data.voucherId !== voucherId || result.data.organizationId !== organizationId) throw uncertain();
  for (const key of keys) {
    const wanted = Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : expected[key];
    if (result.data.recipient[key] !== wanted) throw uncertain();
  }
  return { voucherId, organizationId, recipient: { payerName: result.data.recipient.payerName, bankName: result.data.recipient.bankName, bankAccount: result.data.recipient.bankAccount } };
}
