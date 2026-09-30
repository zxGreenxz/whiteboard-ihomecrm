import {supabase} from '@/integrations/supabase/client';
import {matchesContractMoneyReceipt} from './contractMoneyReceipt';
import {z} from 'zod';
import type {RenewNoticeInput,TransferRoomNoticeInput} from './contract-lifecycle/noticeTransitions';
const isoDate=z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const coreSchema=z.object({id:z.string().uuid(),organization_id:z.string().uuid(),contract_number:z.string().nullable(),status:z.enum(['ACTIVE','EXTENDED']),end_date:isoDate,room_id:z.string().uuid(),room:z.object({id:z.string().uuid(),name:z.string()}),expected_move_out_date:isoDate.nullable(),rent_price:z.unknown(),total_deposit:z.unknown()});
const eventSchema=z.object({id:z.string().uuid(),organization_id:z.string().uuid(),contract_id:z.string().uuid(),result_contract_id:z.string().uuid(),request_id:z.string().uuid(),operation:z.enum(['RENEW','TRANSFER_ROOM']),notice_choice:z.enum(['KEEP','CANCEL']),previous_notice_date:isoDate.nullable(),expected_updated_at:z.string().datetime({offset:true})});
export interface ContractNoticeOperationReceipt {contractId:string;contractNumber:string;endDate:string;roomId:string;roomName:string;eventId:string;operation:'RENEW'|'TRANSFER_ROOM'}
export async function readContractNoticeOperationReceipt(organizationId:string,requestId:string,input:RenewNoticeInput|TransferRoomNoticeInput,operation:'RENEW'|'TRANSFER_ROOM'):Promise<ContractNoticeOperationReceipt>{
 const [coreResult,eventResult]=await Promise.all([
  supabase.from('contracts').select('id,organization_id,contract_number,status,end_date,room_id,room:rooms!contracts_room_id_fkey(id,name),expected_move_out_date,rent_price,total_deposit').eq('id',input.contractId).eq('organization_id',organizationId).maybeSingle(),
  supabase.from('contract_notice_transition_events').select('id,organization_id,contract_id,result_contract_id,request_id,operation,notice_choice,previous_notice_date,expected_updated_at').eq('request_id',requestId).eq('organization_id',organizationId).maybeSingle(),
 ]);
 if(coreResult.error)throw coreResult.error;if(eventResult.error)throw eventResult.error;
 const core=coreSchema.parse(coreResult.data);const event=eventSchema.parse(eventResult.data);
 const expectedChoice='noticeChoice' in input?input.noticeChoice:'CANCEL';
 if(core.id!==input.contractId||core.organization_id!==organizationId||event.organization_id!==organizationId||event.contract_id!==input.contractId||event.result_contract_id!==core.id||event.request_id!==requestId||event.operation!==operation||event.notice_choice!==expectedChoice||Date.parse(event.expected_updated_at)!==Date.parse(input.expectedUpdatedAt)||core.room.id!==core.room_id||core.expected_move_out_date!==(expectedChoice==='KEEP'?event.previous_notice_date:null))throw new TypeError('Unconfirmed contract operation receipt');
 if('newEndDate' in input&&core.end_date!==input.newEndDate)throw new TypeError('Unconfirmed contract renewal date');
 if('newRoomId' in input&&core.room_id!==input.newRoomId)throw new TypeError('Unconfirmed contract transfer room');
 if(input.newRentPrice!==undefined&&!matchesContractMoneyReceipt(core.rent_price,input.newRentPrice))throw new TypeError('Unconfirmed contract operation rent');
 if('newDeposit' in input&&input.newDeposit!==undefined&&!matchesContractMoneyReceipt(core.total_deposit,input.newDeposit))throw new TypeError('Unconfirmed contract renewal deposit');
 return {contractId:core.id,contractNumber:core.contract_number||core.id,endDate:core.end_date,roomId:core.room_id,roomName:core.room.name,eventId:event.id,operation};
}
