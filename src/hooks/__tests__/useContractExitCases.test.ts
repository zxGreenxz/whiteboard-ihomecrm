import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useConfirmContractReturn,useContractExitCase,useContractExitCases,useFinalizeContractExitCase,useUpdateContractExitKind } from '../useContractExitCases';
import type { ConfirmContractReturnInput, FinalizeContractExitCaseInput, UpdateContractExitKindInput } from '@/lib/contractExitCases';

const mocks=vi.hoisted(()=>({
  org:'00000000-0000-4000-8000-000000000001' as string|null,
  rpc:vi.fn(),invalidate:vi.fn(),error:vi.fn(),success:vi.fn(),
}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:mocks.org})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:mocks.rpc}}));
vi.mock('sonner',()=>({toast:{error:mocks.error,success:mocks.success}}));
vi.mock('@tanstack/react-query',()=>({useQuery:(options:unknown)=>options,useMutation:(options:unknown)=>options,useQueryClient:()=>({invalidateQueries:mocks.invalidate})}));
const id='00000000-0000-4000-8000-000000000002';
const row={id,organization_id:'00000000-0000-4000-8000-000000000001',building_id:id,contract_id:id,room_at_handover_id:id,actual_move_out_on:'2026-09-28',initial_kind:'EARLY_RETURN',current_kind:'EARLY_RETURN',settlement_mode:'DEFERRED',state:'PENDING',version:1,created_at:'2026-09-28T00:00:00Z',updated_at:'2026-09-28T00:00:00Z',settlement_result:null,kind_history:[]};
interface QueryOptions {enabled:boolean;retry:boolean;queryFn:()=>Promise<unknown>}
interface MutationOptions<T> {retry:boolean;mutationFn:(input:T)=>Promise<unknown>;onError:(error:unknown)=>unknown;onSuccess:(result:typeof row)=>Promise<void>}
beforeEach(()=>{vi.clearAllMocks();mocks.org=row.organization_id;mocks.rpc.mockResolvedValue({data:row,error:null});});
describe('selected organization at the exit-case hook boundary',()=>{
  it('injects selected org into reads and disables absent case/organization without retries',async()=>{
    mocks.rpc.mockResolvedValueOnce({data:{items:[row],total:1,limit:1,offset:0},error:null});
    const list=useContractExitCases({contractId:id,limit:1}) as unknown as QueryOptions;
    await list.queryFn();expect(mocks.rpc).toHaveBeenLastCalledWith('list_contract_exit_cases_v1',expect.objectContaining({p_organization_id:row.organization_id,p_contract_id:id,p_limit:1}));
    const detail=useContractExitCase(id) as unknown as QueryOptions;
    await detail.queryFn();expect(mocks.rpc).toHaveBeenLastCalledWith('get_contract_exit_case_v1',{p_organization_id:row.organization_id,p_case_id:id});
    expect(detail.retry).toBe(false);expect((useContractExitCase(null) as unknown as QueryOptions).enabled).toBe(false);
    mocks.org=null;expect((useContractExitCases() as unknown as QueryOptions).enabled).toBe(false);
  });
  it('injects the selected org into all mutation DTOs and distinguishes pending/finalized success',async()=>{
    const confirm=useConfirmContractReturn() as unknown as MutationOptions<ConfirmContractReturnInput>;
    await confirm.mutationFn({contractId:id,expectedContractUpdatedAt:'2026-09-27T00:00:00Z',idempotencyKey:'return-key-0001',actualMoveOutOn:'2026-09-28',initialKind:'EARLY_RETURN',settlementMode:'DEFERRED',returnNote:'Khách chuyển nhà.'});
    expect(mocks.rpc).toHaveBeenLastCalledWith('confirm_contract_return_v1',expect.objectContaining({p_organization_id:row.organization_id,p_settlement:null,p_return_note:'Khách chuyển nhà.'}));
    await confirm.onSuccess(row);expect(mocks.success).toHaveBeenLastCalledWith('Đã trả phòng • Chờ quyết toán');
    const finalize=useFinalizeContractExitCase() as unknown as MutationOptions<FinalizeContractExitCaseInput>;
    await finalize.mutationFn({caseId:id,expectedVersion:1,idempotencyKey:'settle-key-0001',currentKind:'FORFEIT',settlement:{}});
    expect(mocks.rpc).toHaveBeenLastCalledWith('finalize_contract_exit_case_v1',expect.objectContaining({p_organization_id:row.organization_id,p_settlement:{extra_charges:[]}}));
    await finalize.onSuccess({...row,state:'FINALIZED'});expect(mocks.success).toHaveBeenLastCalledWith('Đã quyết toán');
    const kind=useUpdateContractExitKind() as unknown as MutationOptions<UpdateContractExitKindInput>;
    await kind.mutationFn({caseId:id,expectedVersion:1,idempotencyKey:'kind-key-0001',kind:'FORFEIT',reason:'Facts'});
    expect(mocks.rpc).toHaveBeenLastCalledWith('update_contract_exit_case_kind_v1',expect.objectContaining({p_organization_id:row.organization_id,p_reason:'Facts'}));
    expect(finalize.retry).toBe(false);
  });
  it('denies mutation with no selected organization and maps CAS failure to an actionable toast',async()=>{
    mocks.org=null;
    const mutation=useConfirmContractReturn() as unknown as MutationOptions<ConfirmContractReturnInput>;
    expect(()=>mutation.mutationFn({} as ConfirmContractReturnInput)).toThrow();expect(mocks.rpc).not.toHaveBeenCalled();
    mutation.onError({code:'PT409'});expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('tải lại'));
  });
});
