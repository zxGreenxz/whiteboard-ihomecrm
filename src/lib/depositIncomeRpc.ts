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

export async function recordDepositIncome(org: string, key: string, row: Json, items: Json, terms: Json) {
  const client = supabase as unknown as { rpc: IncomeRpc };
  const { data, error } = await client.rpc('create_deposit_income_v1', {
    p_organization_id: org, p_request_key: key, p_row: row, p_items: items, p_terms: terms,
  });
  if (error?.code==='PT409' && error.message==='Mã yêu cầu đã dùng cho nội dung khác') {
    const saved=await findOwnDepositIncome(org,key);
    if (saved) throw new FinancialAlreadyRecordedError('Phiếu cọc của lần lưu trước đã được xác nhận. Mở Thu chi để xem phiếu.',[saved]);
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

// The durable marker stores identifiers only. After a reload, ask the server about that exact request.
export async function recoverableRoomDeposit<T extends {id:string}>(org:string, roomId:string, save:(key:string)=>Promise<T>):Promise<T> {
  const actor=await getSessionUser();
  if (!actor) throw new Error('Đăng nhập lại để lưu phiếu cọc.');
  return runFinancialPending({namespace:'room-deposit-receipt',userId:actor.id,organizationId:org,businessKey:roomId},async progress=>{
    const result=await save(progress.requestKey);
    progress.recordCompleted([result.id]);
    return result;
  }, undefined, {operation:'thu cọc',reconcile:async pending=>{
    const id=await findOwnDepositIncome(org,pending.requestKey??pending.attemptId);
    return id ? {outcome:'already-written',message:'Đã xác nhận phiếu cọc của lần lưu trước. Mở Thu chi để xem phiếu.',recordIds:[id]}
      : {outcome:'not-written',serverDedupesRequestKey:true};
  }});
}
