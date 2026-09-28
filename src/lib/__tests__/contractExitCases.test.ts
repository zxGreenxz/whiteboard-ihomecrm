import { describe, expect, it, vi } from 'vitest';
import {
  buildConfirmContractReturnArgs, buildFinalizeContractExitCaseArgs,
  confirmContractReturn, finalizeContractExitCase, parseContractExitCase,
  listContractExitCases, getContractExitCase, contractExitErrorMessage,
  type ConfirmContractReturnInput, type ContractExitRpcInvoker,
} from '../contractExitCases';

const contractId = '00000000-0000-4000-8000-000000000001';
const caseId = '00000000-0000-4000-8000-000000000002';
const deferred: ConfirmContractReturnInput = {
  contractId, expectedContractUpdatedAt: '2026-09-27T00:00:00Z',
  idempotencyKey: 'return-request-0001', actualMoveOutOn: '2026-09-28',
  initialKind: 'EARLY_RETURN', settlementMode: 'DEFERRED',
};
const row = {
  id: caseId, organization_id: contractId, building_id: contractId, contract_id: contractId,
  room_at_handover_id: contractId, actual_move_out_on: '2026-09-28', initial_kind: 'EARLY_RETURN',
  current_kind: 'EARLY_RETURN', settlement_mode: 'DEFERRED', state: 'PENDING', version: 1,
  created_at: '2026-09-28T00:00:00Z', updated_at: '2026-09-28T00:00:00Z',
  settlement_result: null, kind_history: [],
};

describe('contract return request boundary', () => {
  it('requires actual date and initial kind before dispatch', () => {
    expect(() => buildConfirmContractReturnArgs({...deferred, actualMoveOutOn: ''},contractId)).toThrow();
    expect(() => buildConfirmContractReturnArgs({...deferred, actualMoveOutOn: '2026-02-30'},contractId)).toThrow();
    expect(() => buildConfirmContractReturnArgs({...deferred, initialKind: undefined} as unknown as ConfirmContractReturnInput,contractId)).toThrow();
  });
  it('DEFERRED emits no monetary payload and rejects a hidden settlement', () => {
    expect(buildConfirmContractReturnArgs(deferred,contractId)).toEqual({
      p_organization_id:contractId,p_contract_id: contractId, p_expected_contract_updated_at: '2026-09-27T00:00:00Z',
      p_idempotency_key: 'return-request-0001', p_actual_move_out_on: '2026-09-28',
      p_initial_kind: 'EARLY_RETURN', p_settlement_mode: 'DEFERRED', p_settlement: null,p_meter_boundary:null,
    });
    expect(() => buildConfirmContractReturnArgs({...deferred, settlement: {depositRefund: 0}} as unknown as ConfirmContractReturnInput,contractId)).toThrow();
  });
  it('keeps physical meter input separate from money and pins zero as a verified value',()=>{
    const args=buildConfirmContractReturnArgs({...deferred,meterBoundary:{state:'VERIFIED',readings:[{meterId:contractId,reading:0,measuredAt:'2026-09-28T09:00:00+07:00'}]}},contractId);
    expect(args.p_settlement).toBeNull();
    expect(args.p_meter_boundary).toEqual({state:'VERIFIED',reason:null,readings:[{meter_id:contractId,reading:0,measured_at:'2026-09-28T09:00:00+07:00',evidence:null}]});
  });
  it('IMMEDIATE requires its monetary branch and keeps the existing field names/defaults', () => {
    const args = buildConfirmContractReturnArgs({...deferred, settlementMode: 'IMMEDIATE', settlement: {depositRefund: 120, shortfallMode: 'DEBT', refundItems: [{kind:'CUSTOM',description:'Rent',amount:30}]}},contractId);
    expect(args.p_settlement).toEqual({deposit_refund:120,penalty_fee:0,excess_rent:0,outstanding_debt:0,notes:null,extra_charges:[],shortfall_mode:'DEBT',receipt_account_id:null,refund_items:[{kind:'CUSTOM',description:'Rent',amount:30}]});
    expect(() => buildConfirmContractReturnArgs({...deferred, settlementMode:'IMMEDIATE'} as ConfirmContractReturnInput,contractId)).toThrow();
  });
  it('preserves a stable request key and immutable physical date in finalize args', () => {
    const input = {caseId,expectedVersion:3,idempotencyKey:'  settle-request-0001  ',currentKind:'FORFEIT' as const,settlement:{extraCharges:[{kind:'CUSTOM' as const,description:'Extra',amount:50}]}};
    expect(buildFinalizeContractExitCaseArgs(input,contractId)).toEqual({p_organization_id:contractId,p_case_id:caseId,p_expected_version:3,p_idempotency_key:'settle-request-0001',p_current_kind:'FORFEIT',p_reason:null,p_settlement:{extra_charges:[{kind:'CUSTOM',description:'Extra',amount:50}]}});
    expect(() => buildFinalizeContractExitCaseArgs({...input,settlement:{depositRefund:1}},contractId)).toThrow();
  });
  it('validates server results rather than returning an empty success', async () => {
    const invoke = vi.fn<ContractExitRpcInvoker>().mockResolvedValue({data:row,error:null});
    expect(await confirmContractReturn(invoke,deferred,contractId)).toMatchObject({id:caseId,state:'PENDING'});
    expect(invoke).toHaveBeenCalledWith('confirm_contract_return_v1',buildConfirmContractReturnArgs(deferred,contractId));
    expect(() => parseContractExitCase({...row, initial_kind:null})).toThrow();
    invoke.mockResolvedValueOnce({data:{},error:null});
    await expect(confirmContractReturn(invoke,deferred,contractId)).rejects.toThrow();
  });
  it('dispatches finalize once and preserves canonical errors', async () => {
    const invoke=vi.fn<ContractExitRpcInvoker>().mockResolvedValue({data:{...row,state:'FINALIZED',version:2,settlement_result:{credit:{deferred:true}}},error:null});
    const input={caseId,expectedVersion:1,idempotencyKey:'settle-request-0001',currentKind:'FORFEIT' as const,settlement:{}};
    expect((await finalizeContractExitCase(invoke,input,contractId)).settlement_result).toEqual({credit:{deferred:true}});
    expect(invoke).toHaveBeenCalledWith('finalize_contract_exit_case_v1',buildFinalizeContractExitCaseArgs(input,contractId));
    const error={code:'42501',message:'Denied'}; invoke.mockResolvedValueOnce({data:null,error});
    await expect(finalizeContractExitCase(invoke,input,contractId)).rejects.toBe(error);
  });
  it('pins selected organization and deep-link/building filters at the RPC boundary',async()=>{
    const invoke=vi.fn<ContractExitRpcInvoker>().mockResolvedValueOnce({data:{items:[row],total:1,limit:1,offset:0,server_today:'2026-09-28'},error:null});
    await listContractExitCases(invoke,{contractId,buildingIds:[contractId],limit:1},contractId);
    expect(invoke).toHaveBeenCalledWith('list_contract_exit_cases_v1',{p_organization_id:contractId,p_building_id:null,p_building_ids:[contractId],p_contract_id:contractId,p_state:null,p_limit:1,p_offset:0});
    invoke.mockResolvedValueOnce({data:row,error:null});
    await getContractExitCase(invoke,caseId,contractId);
    expect(invoke).toHaveBeenLastCalledWith('get_contract_exit_case_v1',{p_organization_id:contractId,p_case_id:caseId});
    await expect(getContractExitCase(invoke,caseId,'')).rejects.toThrow();
  });
  it('gives a concise actionable CAS/permission error and retains unknown canonical messages',()=>{
    expect(contractExitErrorMessage({code:'PT409'})).toContain('tải lại');
    expect(contractExitErrorMessage({code:'40001'})).toContain('tải lại');
    expect(contractExitErrorMessage({code:'42501'})).toContain('không có quyền');
    expect(contractExitErrorMessage({code:'55000',message:'Credit writer disabled'})).toBe('Credit writer disabled');
  });
});
