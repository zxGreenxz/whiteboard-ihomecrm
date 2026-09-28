import { z } from 'zod';
const base={contractId:z.string().uuid(),expectedUpdatedAt:z.string().datetime({offset:true}),requestId:z.string().uuid(),notes:z.string().optional(),noticeReason:z.string().trim().max(2000).optional()};
const renewSchema=z.object({...base,newEndDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),newRentPrice:z.number().optional(),newDeposit:z.number().optional(),noticeChoice:z.enum(['KEEP','CANCEL'])}).strict();
const transferSchema=z.object({...base,newRoomId:z.string().uuid(),transferDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),newRentPrice:z.number().optional()}).strict();
export type RenewNoticeInput=z.infer<typeof renewSchema>;
export type TransferRoomNoticeInput=z.infer<typeof transferSchema>;
export function buildRenewNoticeArgs(input:RenewNoticeInput,organizationId:string){const x=renewSchema.parse(input);return {
  p_organization_id:z.string().uuid().parse(organizationId),p_contract_id:x.contractId,p_expected_updated_at:x.expectedUpdatedAt,p_new_end_date:x.newEndDate,
  p_notice_choice:x.noticeChoice,p_request_id:x.requestId,p_new_rent_price:x.newRentPrice,p_new_deposit:x.newDeposit,p_notes:x.notes,p_notice_reason:x.noticeReason,
};}
export function buildTransferRoomNoticeArgs(input:TransferRoomNoticeInput,organizationId:string){const x=transferSchema.parse(input);return {
  p_organization_id:z.string().uuid().parse(organizationId),p_contract_id:x.contractId,p_expected_updated_at:x.expectedUpdatedAt,p_new_room_id:x.newRoomId,
  p_transfer_date:x.transferDate,p_request_id:x.requestId,p_new_rent_price:x.newRentPrice,p_notes:x.notes,p_notice_reason:x.noticeReason,
};}
