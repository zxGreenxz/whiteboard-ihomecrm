import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';
import type { buildTransferRoomNoticeArgs } from './noticeTransitions';

const amount = z.number().finite().nonnegative();
const quoteSchema = z.object({
  period_start: z.iso.date(), period_end: z.iso.date(),
  old_days: z.number().int().nonnegative(), new_days: z.number().int().nonnegative(),
  required_deposit: amount, held_deposit: amount, deposit_shortfall: amount, deposit_surplus: amount,
  deposit_invoiced_shortfall: amount.optional(), deposit_unbilled_shortfall: amount.optional(),
  period_rent: amount, billed_rent: amount, rent_delta: z.number().finite(),
  scheduled_rent: amount.optional(), rent_override: z.number().finite().optional(),
  invoice_id: z.string().guid().nullable(), invoice_status: z.string().min(1).nullable(),
  remaining_after: amount.optional(), refund_pending: amount.optional(),
  quote_key: z.string().regex(/^[0-9a-f]{32}$/),
});

export type RoomTransferQuote = z.infer<typeof quoteSchema>;
export interface RoomTransferQuoteInput {
  contractId: string;
  newRoomId: string;
  transferDate: string;
  newRentPrice?: number;
  newDeposit: number;
}

interface QuoteArgs {
  p_org: string; p_contract_id: string; p_new_room_id: string; p_transfer_date: string;
  p_new_rent_price: number | null; p_new_deposit: number;
}

// Keep the rolling-deployment interface narrow and validate JSON at the boundary.
type Reply = PromiseLike<{ data: unknown; error: unknown }>;
const transferRpc = supabase as unknown as {
  rpc(name: 'preview_room_transfer_v1', args: QuoteArgs): Reply;
  rpc(name: 'transfer_room_with_notice_v2', args: ReturnType<typeof buildTransferRoomNoticeArgs>): Reply;
};

export async function readRoomTransferQuote(org: string, input: RoomTransferQuoteInput) {
  const { data, error } = await transferRpc.rpc('preview_room_transfer_v1', {
    p_org: org, p_contract_id: input.contractId, p_new_room_id: input.newRoomId,
    p_transfer_date: input.transferDate, p_new_rent_price: input.newRentPrice ?? null,
    p_new_deposit: input.newDeposit,
  });
  if (error) throw error;
  const parsed = quoteSchema.safeParse(data);
  // A handover before billing begins has zero old-room billable days in the first period.
  if (!parsed.success || parsed.data.period_start > parsed.data.period_end || parsed.data.period_end < input.transferDate
      || (parsed.data.period_start > input.transferDate && parsed.data.old_days !== 0)
      || parsed.data.required_deposit !== input.newDeposit
      || (parsed.data.invoice_id === null) !== (parsed.data.invoice_status === null)) {
    throw new Error('Số liệu xem trước chưa khớp với yêu cầu chuyển phòng. Hãy tải lại.');
  }
  return parsed.data;
}

export const submitRoomTransfer = (args: ReturnType<typeof buildTransferRoomNoticeArgs>) =>
  transferRpc.rpc('transfer_room_with_notice_v2', args);
