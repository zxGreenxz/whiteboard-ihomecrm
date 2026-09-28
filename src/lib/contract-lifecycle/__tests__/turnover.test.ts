import { expect, it } from 'vitest';
import { buildRoomTurnoverArgs, parseRoomTurnoverSnapshot, turnoverReadiness, turnoverErrorMessage } from '../turnover';

const room = '00000000-0000-4000-8000-000000000012';
const org = 'dddd0000-0000-4000-8000-000000000001';
const state = {id:room,organization_id:org,room_id:room,version:3,epoch:1,source_contract_id:null,status:'PENDING' as const,
  expected_ready_on:null,responsible_user_id:null,reason:'Dọn phòng',updated_at:'2026-09-28T01:00:00.123456Z'};

it('allows unknown date and unassigned responsibility without treating the room as ready', () => {
  expect(buildRoomTurnoverArgs({organizationId:org,roomId:room,expectedVersion:0,status:'PENDING',expectedReadyOn:null,
    responsibleUserId:null,sourceContractId:null,reason:'  Dọn phòng  ',startNewCycle:false}).p_payload).toEqual({
    status:'PENDING',expected_ready_on:null,responsible_user_id:null,source_contract_id:null,reason:'Dọn phòng',start_new_cycle:false,
  });
  expect(turnoverReadiness(state,'2026-09-28')).toEqual({kind:'confirm-date',expectedReadyOn:null});
  expect(turnoverReadiness(null,'2026-09-28')).toEqual({kind:'unknown',expectedReadyOn:null});
});
it('keeps overdue pending work distinct from ready and never invents a replacement date', () => {
  expect(turnoverReadiness({...state,expected_ready_on:'2026-09-27'},'2026-09-28')).toEqual({kind:'confirm-date',expectedReadyOn:null});
  expect(turnoverReadiness({...state,expected_ready_on:'2026-09-28'},'2026-09-28')).toEqual({kind:'confirm-date',expectedReadyOn:null});
  expect(turnoverReadiness({...state,expected_ready_on:'2026-09-30'},'2026-09-28')).toEqual({kind:'planned',expectedReadyOn:'2026-09-30'});
  expect(turnoverReadiness({...state,status:'READY'},'2026-09-28')).toEqual({kind:'ready',expectedReadyOn:null});
});
it('validates dates, reasons and exact CAS versions at the input boundary', () => {
  const input = {organizationId:org,roomId:room,expectedVersion:3,status:'PENDING' as const,expectedReadyOn:null,
    responsibleUserId:null,sourceContractId:null,reason:'Khách trả',startNewCycle:false};
  expect(()=>buildRoomTurnoverArgs({...input,expectedReadyOn:'2026-02-30'})).toThrow();
  expect(()=>buildRoomTurnoverArgs({...input,reason:' '})).toThrow();
  expect(()=>buildRoomTurnoverArgs({...input,expectedVersion:-1})).toThrow();
  expect(buildRoomTurnoverArgs(input).p_expected_version).toBe(3);
  expect(turnoverErrorMessage({code:'PT409',message:'SQL internals'})).toMatch(/tải lại/);
  expect(turnoverErrorMessage({code:'42501',message:'SQL internals'})).not.toContain('SQL internals');
});
it('rejects a malformed reader instead of reporting no pending work', () => {
  expect(parseRoomTurnoverSnapshot({today:'2026-09-28',can_start_new_cycle:true,turnover:state,history:[]})).toMatchObject({turnover:state});
  expect(()=>parseRoomTurnoverSnapshot(null)).toThrow();
  expect(()=>parseRoomTurnoverSnapshot({today:'2026-09-28',can_start_new_cycle:true,turnover:{...state,version:'3'},history:[]})).toThrow();
});
