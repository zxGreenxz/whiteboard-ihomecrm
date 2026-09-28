import {describe,expect,it,vi} from 'vitest';
import {buildCreateRoomReservationArgs,createRoomReservation,listRoomReservations,buildUpdateRoomReservationArgs,reservationErrorMessage} from '../reservationIdentityRpc';
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
