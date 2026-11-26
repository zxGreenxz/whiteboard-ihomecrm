import { FinancialAlreadyRecordedError } from '@/lib/financialWorkflowError';
import { getSessionUser } from '@/lib/authSession';
import { runFinancialPending } from '@/lib/financialPendingAction';
import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import { roomReservationSchema } from '@/lib/reservationIdentityRpc';

type IncomeRpc = (name: 'create_deposit_income_v1', args: {
  p_organization_id: string; p_request_key: string; p_row: Json; p_items: Json; p_terms: Json;
}) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;

const confirmation = z.object({
  id: z.string().uuid(), code: z.string().nullable(), approval_status: z.string(),
  reservation_id: z.string().uuid().nullable(), reservation: roomReservationSchema.nullable(),
});

export class ConfirmedDepositIncome extends FinancialAlreadyRecordedError {
  constructor(readonly voucherId:string) {
    super('Đã xác nhận phiếu cọc của lần lưu trước. Mở Thu chi để xem phiếu.',[voucherId]);
  }
}

export async function recordDepositIncome(org: string, key: string, row: Json, items: Json, terms: Json) {
  const client = supabase as unknown as { rpc: IncomeRpc };
  const { data, error } = await client.rpc('create_deposit_income_v1', {
    p_organization_id: org, p_request_key: key, p_row: row, p_items: items, p_terms: terms,
  });
  if (error?.code==='PT409' && error.message==='Mã yêu cầu đã dùng cho nội dung khác') {
    const saved=await findOwnDepositIncome(org,key);
    if (saved) throw new ConfirmedDepositIncome(saved);
  }
  if (error) throw error;
  return confirmation.parse(data);
}

export async function getLeadDepositIncomeId(org: string, leadId: string): Promise<string | null> {
  type LeadReceiptRpc = (name: 'get_lead_deposit_income_v1', args: { p_organization_id: string; p_lead_id: string }) =>
    PromiseLike<{ data: unknown; error: unknown }>;
  const client = supabase as unknown as { rpc: LeadReceiptRpc };
  const { data, error } = await client.rpc('get_lead_deposit_income_v1', { p_organization_id: org, p_lead_id: leadId });
  if (error) throw error;
  if (data !== null && typeof data !== 'string') throw new Error('Chưa xác nhận được mã phiếu.');
  return data as string | null;
}

export async function findOwnDepositIncome(org: string, requestKey: string): Promise<string | null> {
  type Read = (name: 'get_own_deposit_income_v1', args: { p_organization_id: string; p_request_key: string }) =>
    PromiseLike<{ data: unknown; error: unknown }>;
  const client = supabase as unknown as { rpc: Read };
  const { data, error } = await client.rpc('get_own_deposit_income_v1', { p_organization_id: org, p_request_key: requestKey });
  if (error) throw error;
  return z.string().uuid().nullable().parse(data);
}

/** Mỗi lần đọc mang tối đa chừng này mã (một lượt nhập Excel có thể có hàng trăm dòng). */
const COMPAT_LOOKUP_CHUNK = 100;
const compatInsertRows = z.array(z.object({ voucher_id: z.string().regex(/^[0-9a-z-]{1,64}$/i), request_key: z.string() }));

/**
 * Phiếu mà CHÍNH người đang đăng nhập đã lập qua `ie_compat_insert_keyed_v1` với từng mã yêu cầu (đợt 10a). Máy chủ trả
 * theo sổ giữ mã, không theo quyền đọc phiếu. Mã chưa có phiếu thì vắng trong kết quả. Đọc hỏng thì ném (chưa kết luận).
 */
export async function findOwnCompatInserts(org: string, requestKeys: readonly string[]): Promise<Map<string, string>> {
  type Read = (name: 'get_own_compat_inserts_v1', args: { p_organization_id: string; p_request_keys: string[] }) =>
    PromiseLike<{ data: unknown; error: unknown }>;
  const client = supabase as unknown as { rpc: Read };
  const found = new Map<string, string>();
  const keys = [...new Set(requestKeys)];
  for (let start = 0; start < keys.length; start += COMPAT_LOOKUP_CHUNK) {
    const part = keys.slice(start, start + COMPAT_LOOKUP_CHUNK);
    const { data, error } = await client.rpc('get_own_compat_inserts_v1', { p_organization_id: org, p_request_keys: part });
    if (error) throw error;
    for (const row of compatInsertRows.parse(data)) if (part.includes(row.request_key)) found.set(row.request_key, row.voucher_id);
  }
  return found;
}

// The durable marker stores identifiers only. After a reload, ask the server about that exact request.
export async function recoverableRoomDeposit<T extends {id:string}>(org:string, roomId:string, requestKey:string, save:(key:string)=>Promise<T>):Promise<T> {
  const actor=await getSessionUser();
  if (!actor) throw new Error('Đăng nhập lại để lưu phiếu cọc.');
  const result=await runFinancialPending<T | ConfirmedDepositIncome>({namespace:'room-deposit-receipt',userId:actor.id,organizationId:org,businessKey:roomId},async progress=>{
    const result=await save(progress.requestKey);
    progress.recordCompleted([result.id]);
    return result;
  }, undefined, {operation:'thu cọc',requestKey,reconcile:async pending=>{
    const id=await findOwnDepositIncome(org,pending.requestKey??pending.attemptId);
    return id ? {result:new ConfirmedDepositIncome(id)}
      : {outcome:'not-written',serverDedupesRequestKey:true};
  }});
  if (result instanceof ConfirmedDepositIncome) throw result;
  return result;
}
