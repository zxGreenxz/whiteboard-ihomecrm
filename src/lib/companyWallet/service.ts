import { z } from 'zod';
import type { CreateIncomeExpenseInput } from '@/hooks/income-expenses/types';
import type { Json } from '@/integrations/supabase/types';
import { companyWalletMutationSchema, companyWalletMutationReceiptSchema, companyWalletVoucherReceiptSchema, parseCompanyWalletSnapshot, type CompanyWalletMutation, type CompanyWalletMutationReceipt, type CompanyWalletSnapshot, type CompanyWalletVoucherReceipt } from './contract';

export class CompanyWalletError extends Error {
 override readonly name = 'CompanyWalletError';
 constructor(public readonly kind: 'validation' | 'permission' | 'conflict' | 'network' | 'internal', message: string,
  public readonly cause?: unknown, public readonly outcomeUnknown = false, public readonly code?: string) { super(message); }
}
type RpcResult = { data: unknown; error: { code?: string; message?: string; status?: number } | null };
export interface CompanyWalletRpcArguments {
 company_wallet_snapshot: { p_organization_id: string };
 company_wallet_mutate: { p_organization_id: string; p_request_key: string; p_payload: Json };
 create_company_wallet_voucher: { p_organization_id: string; p_wallet_id: string; p_idempotency_key: string; p_input: Json };
}
export interface CompanyWalletRpcClient {
 rpc<K extends keyof CompanyWalletRpcArguments>(name: K, args: CompanyWalletRpcArguments[K]): Promise<RpcResult>;
}
export interface CreateCompanyWalletVoucherInput { walletId: string; idempotencyKey: string; input: CreateIncomeExpenseInput }
export function mapCompanyWalletError(error: unknown, writing = false): CompanyWalletError {
 if (error instanceof CompanyWalletError) return error;
 if (error instanceof z.ZodError) return new CompanyWalletError('validation', 'Thông tin ví Công ty chưa hợp lệ. Vui lòng kiểm tra lại.', error);
 const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
 if (['42501', 'PGRST301', 'PGRST302'].includes(code)) return new CompanyWalletError('permission', 'Bạn không còn quyền dùng ví hoặc sổ quỹ tại công ty này.', error, false, code);
 if (['PT409', '40001', '23505', '23514', '23503'].includes(code)) return new CompanyWalletError('conflict', 'Ví đã thay đổi hoặc còn lịch sử liên kết. Hãy tải lại; ví có lịch sử chỉ được ẩn.', error, false, code);
 if (code.startsWith('22') || code === '23502') return new CompanyWalletError('validation', 'Thông tin ví Công ty chưa hợp lệ. Vui lòng kiểm tra lại.', error, false, code);
 const network = error instanceof TypeError || code === '' && typeof error === 'object' && error !== null && 'message' in error && /network|fetch|timeout/i.test(String(error.message));
 return new CompanyWalletError(network ? 'network' : 'internal', writing ? 'Chưa xác nhận kết quả. Giữ nguyên yêu cầu và gửi lại để kiểm tra.' : 'Không tải được dữ liệu ví Công ty. Vui lòng thử lại.', error, writing, code);
}
/** All voucher fields map into the existing writer; recurring/non-canonical inputs fail closed. */
export function companyVoucherPayload(input: CreateIncomeExpenseInput): Json {
 if ((input.repeat_cycle ?? 'NONE') !== 'NONE' || input.repeat_infinity || (input.repeat_count ?? 0) !== 0 ||
  !input.items.length || input.items.some(item => !item.start_date || !item.end_date)) throw new CompanyWalletError('validation', 'Phiếu ví Công ty cần đầy đủ ngày hạng mục và không hỗ trợ lặp lại.');
 return {
  type: input.type, name: input.name, building_id: input.building_id, room_id: input.room_id ?? null,
  tenant_id: input.tenant_id ?? null, contract_id: input.contract_id ?? null, payer_name: input.payer_name ?? null,
  receive_bank_account: input.receive_bank_account || null, receive_bank_name: input.receive_bank_name || null,
  account_id: input.account_id ?? null, attachments: input.attachments ?? [], business_result_accounting: input.business_result_accounting ?? null,
  notes: null, voucher_date: input.voucher_date, items: input.items.map(item => ({
   income_expense_type_id: item.income_expense_type_id, description: item.description ?? null, quantity: item.quantity,
   unit_price: item.unit_price, start_date: item.start_date!, end_date: item.end_date!,
  })),
 };
}
export function createCompanyWalletService(client: CompanyWalletRpcClient, ownerId: string, organizationId: string) {
 const owner = z.string().uuid().parse(ownerId), organization = z.string().uuid().parse(organizationId);
 return {
  async snapshot(): Promise<CompanyWalletSnapshot> {
   try {
    const response = await client.rpc('company_wallet_snapshot', { p_organization_id: organization });
    if (response.error) throw response.error;
    try { return parseCompanyWalletSnapshot(response.data, owner, organization); }
    catch (error) { throw new CompanyWalletError('internal', 'Dữ liệu ví Công ty trả về không hợp lệ.', error); }
   } catch (error) { throw mapCompanyWalletError(error); }
  },
  async mutate(input: CompanyWalletMutation): Promise<CompanyWalletMutationReceipt> {
   try {
    const request = companyWalletMutationSchema.parse(input);
    const response = await client.rpc('company_wallet_mutate', { p_organization_id: organization, p_request_key: request.requestKey,
     p_payload: { action: request.action, data: request.data ?? {}, ...(request.id ? { id: request.id, expected_version: request.expectedVersion } : {}) },
    });
    if (response.error) throw response.error;
    try {
     const result = companyWalletMutationReceiptSchema.parse(response.data);
     if (result.owner_id !== owner || result.organization_id !== organization || result.request_key !== request.requestKey || result.action !== request.action ||
      result.wallet.user_id !== owner || result.wallet.organization_id !== organization || request.id && result.wallet.id !== request.id ||
      (request.action === 'delete') !== ('deleted' in result.wallet)) throw new Error('Company wallet receipt mismatch');
     return result;
    } catch (error) { throw new CompanyWalletError('internal', 'Chưa xác nhận được thay đổi ví. Gửi lại nguyên yêu cầu để kiểm tra.', error, true); }
   } catch (error) { throw mapCompanyWalletError(error, true); }
  },
  async createVoucher(request: CreateCompanyWalletVoucherInput): Promise<CompanyWalletVoucherReceipt> {
   try {
    z.string().uuid().parse(request.walletId); z.string().trim().min(1).max(200).parse(request.idempotencyKey);
    const response = await client.rpc('create_company_wallet_voucher', { p_organization_id: organization, p_wallet_id: request.walletId,
     p_idempotency_key: request.idempotencyKey, p_input: companyVoucherPayload(request.input),
    });
    if (response.error) throw response.error;
    try {
     const result = companyWalletVoucherReceiptSchema.parse(response.data);
     if (result.organization_id !== organization || result.wallet_id !== request.walletId || result.account_id !== request.input.account_id ||
      (result.maker_user_id ?? result.user_id) !== owner) throw new Error('Company voucher receipt mismatch');
     return result;
    } catch (error) { throw new CompanyWalletError('internal', 'Chưa xác nhận phiếu đã lưu. Gửi lại nguyên yêu cầu để kiểm tra.', error, true); }
   } catch (error) { throw mapCompanyWalletError(error, true); }
  },
 };
}
