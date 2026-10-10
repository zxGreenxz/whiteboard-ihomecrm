import {describe,expect,it,vi} from 'vitest';
import {assignRoomReservationCustomer,buildCreateRoomReservationArgs,createRoomReservation,listRoomReservations,buildUpdateRoomReservationArgs,reservationErrorMessage,roomReservationSchema} from '../reservationIdentityRpc';
const org='00000000-0000-4000-8000-000000000001',room='00000000-0000-4000-8000-000000000002',customer='00000000-0000-4000-8000-000000000003';
describe('reservation identity DTO',()=>{
 it('pure hold excludes receipt entirely, while zero or anonymous money is rejected',()=>{
  expect(()=>buildCreateRoomReservationArgs(org,{roomId:room,customerId:customer,idempotencyKey:'hold-key-0001'})).toThrow();
  expect(buildCreateRoomReservationArgs(org,{roomId:room,customerId:customer,holdUntil:'2026-09-29',idempotencyKey:'hold-key-0001'}).p_payload).toEqual({room_id:room,customer_id:customer,hold_until:'2026-09-29',intended_move_in_on:null,topup_due_on:null,deposit_target:null,notes:null,existing_voucher_ids:[]});
  expect(()=>buildCreateRoomReservationArgs(org,{roomId:room,customerId:customer,idempotencyKey:'hold-key-0001',receipt:{amount:0,voucherDate:'2026-09-28'}})).toThrow();
 });
 it('uses selected organization and literal server API, never swallows write/read errors',async()=>{
  const error={code:'42501',message:'Denied'};const rpc=vi.fn().mockResolvedValue({data:null,error});
  await expect(createRoomReservation(rpc,org,{roomId:room,customerId:customer,holdUntil:'2026-09-29',idempotencyKey:'hold-key-0001'})).rejects.toBe(error);
  await expect(listRoomReservations(rpc,org,{roomId:room})).rejects.toBe(error);
  expect(rpc.mock.calls[1]).toEqual(['list_room_reservations_v1',{p_organization_id:org,p_room_id:room,p_customer_id:null,p_status:null,p_limit:100}]);
 });
 it('CAS topup sends exact amount/account and cancel cannot contain money',()=>{
  expect(buildUpdateRoomReservationArgs(org,{reservationId:room,expectedRevision:2,idempotencyKey:'hold-key-0002',action:'TOPUP',receipt:{amount:25,accountId:customer,voucherDate:'2026-09-28'}})).toMatchObject({p_expected_revision:2,p_action:'TOPUP',p_receipt:{amount:25,account_id:customer}});
  expect(()=>buildUpdateRoomReservationArgs(org,{reservationId:room,expectedRevision:1,idempotencyKey:'hold-key-0002',action:'CANCEL',receipt:{amount:25,voucherDate:'2026-09-28'}})).toThrow();
  expect(reservationErrorMessage({code:'PT409'})).toContain('đã thay đổi');
 });
});
describe('tên khách gợi nhớ (20261010114500)',()=>{
 const receipt={amount:500000,accountId:customer,voucherDate:'2026-10-10'};
 it('sends exactly one identity: customer_id or a trimmed customer_hint, never both',()=>{
  const hinted=buildCreateRoomReservationArgs(org,{roomId:room,customerHint:'  anh Tuấn  ',receipt,idempotencyKey:'hold-key-0003'}).p_payload;
  expect(hinted).toMatchObject({room_id:room,customer_hint:'anh Tuấn',receipt:{amount:500000}});expect(hinted).not.toHaveProperty('customer_id');
  const real=buildCreateRoomReservationArgs(org,{roomId:room,customerId:customer,receipt,idempotencyKey:'hold-key-0003'}).p_payload;
  expect(real).toMatchObject({customer_id:customer});expect(real).not.toHaveProperty('customer_hint');
  expect(()=>buildCreateRoomReservationArgs(org,{roomId:room,customerId:customer,customerHint:'Chị Lan',receipt,idempotencyKey:'hold-key-0003'})).toThrow();
  expect(()=>buildCreateRoomReservationArgs(org,{roomId:room,customerHint:'   ',receipt,idempotencyKey:'hold-key-0003'})).toThrow();
  expect(()=>buildCreateRoomReservationArgs(org,{roomId:room,customerHint:'x'.repeat(121),receipt,idempotencyKey:'hold-key-0003'})).toThrow();
 });
 it('a reminder name needs money: no pure hint-only hold',()=>{
  expect(()=>buildCreateRoomReservationArgs(org,{roomId:room,customerHint:'Chị Lan',holdUntil:'2026-10-12',idempotencyKey:'hold-key-0003'})).toThrow(/phiếu cọc có tiền/);
 });
 it('parses a hint-only reservation and accepts an older server without customer_hint',()=>{
  const row={id:room,organization_id:org,building_id:org,room_id:room,customer_id:null,customer_name:'anh Tuấn',customer_phone:null,customer_hint:'anh Tuấn',building_name:'B',room_name:'101',status:'HOLD',claim_status:'LIVE',revision:1,hold_until:null,intended_move_in_on:null,topup_due_on:null,deposit_target:null,notes:null,converted_contract_id:null,overdue:false,received_amount:0,source_voucher_ids:[],receipts:[],created_at:'x',updated_at:'x',history:[]};
  expect(roomReservationSchema.parse(row)).toMatchObject({customer_id:null,customer_hint:'anh Tuấn'});
  const {customer_hint:_omitted,...older}=row;expect(roomReservationSchema.parse({...older,customer_id:customer,customer_phone:'0900'}).customer_hint).toBeNull();
 });
 it('assign sends revision + key to the literal RPC and surfaces the server reason',async()=>{
  const error={code:'55000',message:'Giữ chỗ đã gắn khách trong danh bạ'};const rpc=vi.fn().mockResolvedValue({data:null,error});
  await expect(assignRoomReservationCustomer(rpc,org,{reservationId:room,expectedRevision:2,customerId:customer,idempotencyKey:'assign-key-0001'})).rejects.toBe(error);
  expect(rpc).toHaveBeenCalledWith('assign_room_reservation_customer_v1',{p_organization_id:org,p_reservation_id:room,p_expected_revision:2,p_customer_id:customer,p_idempotency_key:'assign-key-0001'});
  expect(reservationErrorMessage(error)).toContain('đã gắn khách');
 });
});
