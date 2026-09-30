import {beforeEach, describe, expect, it, vi} from 'vitest';
const h=vi.hoisted(()=>({rpc:vi.fn(),success:vi.fn(),info:vi.fn()}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useRef:(value:unknown)=>({current:value})}));
vi.mock('@tanstack/react-query',()=>({useQuery:(options:unknown)=>options,useMutation:(options:unknown)=>options,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:h.rpc}}));
vi.mock('sonner',()=>({toast:{success:h.success,info:h.info}}));
import {useCashbookBalanceAsOf,useCashbookClosings,useConfirmCashbookClosing,useCancelCashbookClosing} from '../useCashbookClosing';
beforeEach(()=>{vi.clearAllMocks();});
describe('closing feedback',()=>{
  it('does not convert a missing closing response to an empty successful list',async()=>{
    h.rpc.mockResolvedValue({data:null,error:null});
    const query=useCashbookClosings() as unknown as {queryFn:()=>Promise<unknown>};
    await expect(query.queryFn()).rejects.toThrow();
  });
  it('rejects unavailable/nonfinite balances before closing',async()=>{
    const query=useCashbookBalanceAsOf('b') as unknown as {queryFn:()=>Promise<unknown>};
    for(const data of [null,'not a balance',{}]){
      h.rpc.mockResolvedValue({data,error:null});await expect(query.queryFn()).rejects.toThrow();
    }
  });
  it('retains server codes, rejects unconfirmed results and blocks another confirmation',async()=>{
    const mutation=useConfirmCashbookClosing() as unknown as {mutationFn:(value:unknown)=>Promise<unknown>};
    const input={requestId:'r',countedBalance:0};const error={code:'42501',message:'no permission'};
    h.rpc.mockResolvedValueOnce({data:null,error});await expect(mutation.mutationFn(input)).rejects.toBe(error);
    h.rpc.mockResolvedValue({data:{},error:null});
    await expect(mutation.mutationFn(input)).rejects.toMatchObject({outcome:'unknown'});
    await expect(mutation.mutationFn(input)).rejects.toMatchObject({outcome:'unknown'});
    expect(h.rpc).toHaveBeenCalledTimes(2);
  });
  it('does not claim a cancellation when the request had already changed',()=>{
    const mutation=useCancelCashbookClosing() as unknown as {onSuccess:(result:unknown,input:unknown)=>void};
    mutation.onSuccess({request_id:'r',changed:false,status:'CONFIRMED'},{requestId:'r',cashbookName:'Sổ A'});
    expect(h.success).not.toHaveBeenCalled();expect(h.info).toHaveBeenCalledWith(expect.stringContaining('đã thay đổi'));
  });
});

vi.mock('@/lib/persistentFinancialWorkflow',async()=>{const {FinancialWorkflowGuard}=await import('@/lib/financialWorkflow');return {persistentFinancialWorkflow:()=>new FinancialWorkflowGuard()};});
