import { z } from 'zod';
import { normalizeMutation, parseReceipt, parseSnapshot, type Mutation, type Receipt, type Snapshot } from './contract';

export type FinanceErrorKind = 'validation' | 'permission' | 'conflict' | 'network' | 'internal';
export class PersonalFinanceError extends Error {
 constructor(public readonly kind: FinanceErrorKind, message: string, public readonly cause?: unknown, public readonly outcomeUnknown = false) { super(message); this.name = 'PersonalFinanceError'; }
}
type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };
// Narrow temporary boundary until production generator sees the new RPCs; never cast generated types.
export interface PersonalFinanceRpcClient {
 rpc(name: 'personal_finance_bootstrap' | 'personal_finance_snapshot' | 'personal_finance_mutate', args?: { p_request_key: string; p_payload: Mutation }): PromiseLike<RpcResult>;
}
export function mapFinanceError(error: unknown): PersonalFinanceError {
 if (error instanceof PersonalFinanceError) return error;
 if (error instanceof z.ZodError) return new PersonalFinanceError('validation', 'Thông tin chưa hợp lệ. Vui lòng kiểm tra lại.', error);
 const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
 if (['42501', 'PGRST301', 'PGRST302'].includes(code)) return new PersonalFinanceError('permission', 'Bạn không có quyền thực hiện thao tác này.', error);
 if (['PT409', '40001', '23505', '23514', '23503'].includes(code)) return new PersonalFinanceError('conflict', 'Dữ liệu đã thay đổi hoặc còn liên kết. Vui lòng tải lại và kiểm tra.', error);
 if (code.startsWith('22') || code === '23502') return new PersonalFinanceError('validation', 'Thông tin chưa hợp lệ. Vui lòng kiểm tra lại.', error);
 if (error instanceof TypeError || code === '' && typeof error === 'object' && error !== null && 'message' in error && /fetch|network|timeout/i.test(String(error.message))) return new PersonalFinanceError('network', 'Không thể kết nối. Bạn có thể thử lại thao tác này.', error);
 return new PersonalFinanceError('internal', 'Không thể xử lý dữ liệu ví cá nhân.', error);
}
export function createPersonalFinanceService(client: PersonalFinanceRpcClient, ownerId: string) {
 const owner = z.string().uuid().parse(ownerId);
 return {
  async snapshot(): Promise<Snapshot> {
   try {
    const bootstrap = await client.rpc('personal_finance_bootstrap'); if (bootstrap.error) throw bootstrap.error;
    const response = await client.rpc('personal_finance_snapshot'); if (response.error) throw response.error;
    try { return parseSnapshot(response.data, owner); } catch (error) { throw new PersonalFinanceError('internal', 'Dữ liệu ví trả về không hợp lệ.', error); }
   } catch (error) { throw mapFinanceError(error); }
  },
  async mutate(requestKey: string, input: unknown): Promise<Receipt> {
   try {
    const key = z.string().uuid().parse(requestKey), payload = normalizeMutation(input);
    const response = await client.rpc('personal_finance_mutate', { p_request_key: key, p_payload: payload }); if (response.error) throw response.error;
    try {
     const receipt = parseReceipt(response.data, owner, key, payload.action);
     if (payload.rows && receipt.entities.length !== payload.rows.length) throw new Error('Incomplete batch receipt');
     return receipt;
    } catch (error) { throw new PersonalFinanceError('internal', 'Chưa xác nhận được kết quả. Thử lại cùng yêu cầu để kiểm tra.', error, true); }
   } catch (error) {
    const mapped = mapFinanceError(error);
    if (mapped.kind === 'network' || mapped.kind === 'internal') throw new PersonalFinanceError(mapped.kind, mapped.message, error, true);
    throw mapped;
   }
  },
 };
}
