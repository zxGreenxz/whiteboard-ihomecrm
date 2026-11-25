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
