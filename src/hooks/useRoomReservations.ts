import {recordDepositIncome} from '@/lib/depositIncomeRpc';
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {toast} from 'sonner';
import {supabase} from '@/integrations/supabase/client';
import type {Database} from '@/integrations/supabase/types';
import {useOrganization} from '@/contexts/OrganizationContext';
import {roomReservationListSchema,type RoomReservationList,buildCreateRoomReservationArgs,createRoomReservation,listRoomReservations,updateRoomReservation,reservationErrorMessage,type CreateRoomReservationInput,type UpdateRoomReservationInput,type RoomReservationFilters,type ReservationRpcInvoker} from '@/lib/reservationIdentityRpc';
type Functions=Database['public']['Functions'];
const invoke:ReservationRpcInvoker=(name,args)=>{switch(name){
 case 'create_room_reservation_v1':return supabase.rpc('create_room_reservation_v1',args as Functions['create_room_reservation_v1']['Args']);
 case 'update_room_reservation_v1':return supabase.rpc('update_room_reservation_v1',args as Functions['update_room_reservation_v1']['Args']);
 case 'list_room_reservations_v1':return supabase.rpc('list_room_reservations_v1',args as Functions['list_room_reservations_v1']['Args']);
 case 'assign_room_reservation_customer_v1':return supabase.rpc('assign_room_reservation_customer_v1',args as Functions['assign_room_reservation_customer_v1']['Args']);
}};
async function listHoldPages(org:string,filters:RoomReservationFilters,buildingIds:string[]):Promise<RoomReservationList>{
  type Read=(name:'list_deposit_income_holds_v1',args:Record<string,string|string[]|number|null>)=>PromiseLike<{error:unknown;data:unknown}>;
  const client=supabase as unknown as { rpc: Read };
  const rows:RoomReservationList['reservations']=[];
  let before:string|null=null, after:string|null=null;
  for(;;){
    const {data,error}=await client.rpc('list_deposit_income_holds_v1',{p_organization_id:org,p_room_id:filters.roomId??null,
      p_customer_id:filters.customerId??null,p_status:filters.status??null,p_limit:100,p_before_created:before,p_after_id:after,p_buildings:buildingIds});
    if(error)throw error;
    const page=roomReservationListSchema.parse(data);
    rows.push(...page.reservations);
    if(page.reservations.length<100)return {...page,reservations:rows};
    const end=page.reservations[page.reservations.length-1];
    if(after===end.id)throw new Error('Không đọc tiếp được danh sách giữ chỗ.');
    before=end.created_at;
    after=end.id;
  }
}
export function useRoomReservations(filters:RoomReservationFilters={},enabled=true,buildingIds?:string[]){const{selectedOrganizationId}=useOrganization();return useQuery({queryKey:['room-reservations',selectedOrganizationId,filters,buildingIds],queryFn:()=>buildingIds?listHoldPages(selectedOrganizationId!,filters,buildingIds):listRoomReservations(invoke,selectedOrganizationId!,filters),enabled:enabled&&!!selectedOrganizationId,retry:false,refetchInterval:60_000});}
function useReservationMutation<Input>(fn:(org:string,input:Input)=>ReturnType<typeof createRoomReservation>, options:{silent?:boolean}={}){const{selectedOrganizationId}=useOrganization();const cache=useQueryClient();return useMutation({meta:{handlesFeedback:true},mutationFn:(input:Input)=>{if(!selectedOrganizationId)throw{code:'42501',message:'Chưa chọn tổ chức'};return fn(selectedOrganizationId,input);},retry:false,onError:error=>{if(!options.silent)toast.error(reservationErrorMessage(error));},onSuccess:async r=>{if(!options.silent)toast.success(r.status==='CANCELLED'?'Đã hủy giữ chỗ':r.receipts.length?'Đã lưu giữ chỗ và nguồn cọc':'Đã giữ chỗ • Chưa thu tiền');await Promise.all(['deposit-income-hold','room-reservations','orphan-deposit-vouchers','reservation-deposits','sale-room-inventory','room-sale-locks','phong-trong','rooms','my-available-rooms','income-expenses','deposits','reservation-hold-deadlines'].map(k=>cache.invalidateQueries({queryKey:[k]})));}});}
export function useCreateRoomReservation(options:{silent?:boolean}={}){
  return useReservationMutation(async(org:string,input:CreateRoomReservationInput)=>{
    if(!input.receipt)return createRoomReservation(invoke,org,input);
    const {p_payload}=buildCreateRoomReservationArgs(org,input);
    const receipt=input.receipt;
    const result=await recordDepositIncome(org,input.idempotencyKey,{
      type:'INCOME',room_id:input.roomId,name:receipt.name??'Cọc giữ chỗ',
      payer_name:input.customerHint??null,amount:receipt.amount,account_id:receipt.accountId??null,
      voucher_date:receipt.voucherDate,description:receipt.description??null,attachments:receipt.attachments??[],
    },[],{
      channel:input.channel??'reservation',expected_hold:input.expectedHoldId??null,
      ...(input.expectedRevision ? {expected_revision:input.expectedRevision} : {}),
      ...(p_payload.hold_until ? {hold_until:p_payload.hold_until} : {}),
      ...(p_payload.intended_move_in_on ? {intended_move_in_on:p_payload.intended_move_in_on} : {}),
      ...(p_payload.topup_due_on ? {topup_due_on:p_payload.topup_due_on} : {}),
      ...(p_payload.deposit_target != null ? {deposit_target:p_payload.deposit_target} : {}),
      ...(p_payload.notes ? {notes:p_payload.notes} : {}),
    });
    if(!result.reservation)throw new TypeError('Chưa xác nhận đợt giữ chỗ của phiếu thu');
    return {...result.reservation,writtenVoucherId:result.id};
  },options);
}
export function useUpdateRoomReservation(){
  return useReservationMutation(async(org:string,input:UpdateRoomReservationInput)=>{
    if(input.action!=='TOPUP'||!input.receipt)return updateRoomReservation(invoke,org,input);
    const receipt=input.receipt;
    if(!input.roomId||!input.payerName?.trim())throw new Error('Chọn phòng và nhập người gửi tiền cọc.');
    const result=await recordDepositIncome(org,input.idempotencyKey,{
      type:'INCOME',room_id:input.roomId,name:receipt.name??'Bổ sung cọc',payer_name:input.payerName,
      amount:receipt.amount,account_id:receipt.accountId??null,voucher_date:receipt.voucherDate,
      description:receipt.description??null,attachments:receipt.attachments??[],
    },[],{channel:'reservation',expected_hold:input.reservationId,expected_revision:input.expectedRevision,
      ...(input.changes?.holdUntil!==undefined ? {hold_until:input.changes.holdUntil}:{}),
      ...(input.changes?.intendedMoveInOn!==undefined ? {intended_move_in_on:input.changes.intendedMoveInOn}:{}),
      ...(input.changes?.topupDueOn!==undefined ? {topup_due_on:input.changes.topupDueOn}:{}),
    });
    if(!result.reservation)throw new TypeError('Chưa xác nhận được phiếu bổ sung cọc');
    return result.reservation;
  });
}
