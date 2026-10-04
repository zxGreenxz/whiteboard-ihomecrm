import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';
import { incomeExpenseFormSchema } from '@/lib/incomeExpenseValidation';
import type { EmailBillSource } from './types';

const sourceSchema = z.object({
  provider: z.enum(['grab', 'shopee']),
  mailbox: z.string().trim().toLowerCase().email().max(254),
  message_id: z.string().trim().regex(/^[a-zA-Z0-9_-]{1,200}$/),
  receipt_id: z.string().trim().toUpperCase().regex(/^[A-Z0-9._:-]{1,160}$/),
}).strict();
const receiptSchema = z.object({ id: z.string().uuid(), created: z.boolean() });
const importedSchema = z.array(z.object({ provider: z.enum(['grab', 'shopee']), receipt_id: z.string(), imported: z.boolean() }));
type RpcError = { code?: string; message?: string; details?: string };
type EmailBillRpc = (
  name: 'create_income_expense_from_email_v1' | 'get_imported_email_bills_v1',
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: RpcError | null }>;
const rpc: EmailBillRpc = (name, args) => (supabase.rpc as unknown as EmailBillRpc)(name, args);

export const emailBillKey = (source: Pick<EmailBillSource, 'provider' | 'receipt_id'>) =>
  `${source.provider}:${source.receipt_id.trim().toUpperCase()}`;

export class EmailBillImportError extends Error {
  constructor(message: string, readonly code?: string) { super(message); this.name = 'EmailBillImportError'; }
}
function importFailure(error: RpcError): EmailBillImportError {
  if (error.code === '23505' || error.code === 'PT409' || error.code === '40001') return new EmailBillImportError('Hóa đơn này đã được nhập. Tải lại danh sách và kiểm tra phiếu đã có.', error.code);
  if (error.code === '42501') return new EmailBillImportError('Bạn không có quyền nhập hóa đơn vào tòa nhà hoặc sổ quỹ đã chọn.', error.code);
  if (error.code === 'PGRST202' || error.code === '42883') return new EmailBillImportError('Tính năng lấy hóa đơn Gmail chưa được bật đầy đủ. Nhờ quản trị viên kiểm tra.', error.code);
  return new EmailBillImportError('Chưa lưu được hóa đơn. Kiểm tra thông tin phiếu và thử lại.', error.code);
}

/** Only reviewed voucher fields cross this boundary; email body and Google token never do. */
export function createEmailBillRepository(transport: EmailBillRpc = rpc) {
  return {
    async create(organizationId: string, source: EmailBillSource, input: unknown) {
      const org = z.string().uuid().parse(organizationId);
      const origin = sourceSchema.parse(source);
      const data = incomeExpenseFormSchema.parse(input);
      if (data.type !== 'EXPENSE' || (data.repeat_cycle ?? 'NONE') !== 'NONE' || data.repeat_infinity || data.repeat_count) {
        throw new EmailBillImportError('Hóa đơn Gmail chỉ dùng cho phiếu chi một lần.');
      }
      const { items } = data;
      const voucher = {
        type: data.type, name: data.name, building_id: data.building_id,
        room_id: data.room_id ?? null, tenant_id: data.tenant_id ?? null, contract_id: data.contract_id ?? null,
        payer_name: data.payer_name ?? null, receive_bank_account: data.receive_bank_account || null,
        receive_bank_name: data.receive_bank_name || null, account_id: data.account_id,
        attachments: data.attachments, business_result_accounting: data.business_result_accounting,
        voucher_date: data.voucher_date,
      };
      const result = await transport('create_income_expense_from_email_v1', {
        p_organization_id: org, p_source: origin, p_voucher: voucher, p_items: items,
      });
      if (result.error) throw importFailure(result.error);
      const parsed = receiptSchema.safeParse(result.data);
      if (!parsed.success) throw new EmailBillImportError('Chưa xác nhận được phiếu đã lưu. Bạn có thể thử lại với cùng hóa đơn; hệ thống sẽ kiểm tra trùng trước khi tạo.');
      return parsed.data;
    },
    async lookup(organizationId: string, sources: EmailBillSource[]): Promise<Set<string>> {
      const org = z.string().uuid().parse(organizationId);
      const unique = [...new Map(sources.map(source => { const parsed = sourceSchema.parse(source); return [emailBillKey({ provider: parsed.provider, receipt_id: parsed.receipt_id }), parsed]; })).values()];
      if (!unique.length) return new Set();
      const imported = new Set<string>();
      for (let offset = 0; offset < unique.length; offset += 100) {
        const page = unique.slice(offset, offset + 100);
        const result = await transport('get_imported_email_bills_v1', { p_organization_id: org, p_sources: page });
        if (result.error) throw importFailure(result.error);
        const parsed = importedSchema.safeParse(result.data);
        const expected = new Set(page.map(emailBillKey));
        if (!parsed.success || parsed.data.length !== expected.size) throw new EmailBillImportError('Chưa kiểm tra được các hóa đơn đã nhập. Hãy thử tìm lại.');
        for (const row of parsed.data) {
          const key = emailBillKey({ provider: row.provider, receipt_id: row.receipt_id });
          if (!expected.delete(key)) throw new EmailBillImportError('Chưa kiểm tra được các hóa đơn đã nhập. Hãy thử tìm lại.');
          if (row.imported) imported.add(key);
        }
      }
      return imported;
    },
  };
}

export const emailBillRepository = createEmailBillRepository();
