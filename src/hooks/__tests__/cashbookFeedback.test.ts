import {beforeEach, describe, expect, it, vi} from 'vitest';
const h=vi.hoisted(()=>({responses:[] as {data:unknown;error:unknown;count?:number}[],rpc:vi.fn()}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useRef:(current:unknown)=>({current})}));
vi.mock('@/lib/persistentFinancialWorkflow',async()=>{const {FinancialWorkflowGuard}=await import('@/lib/financialWorkflow');return {persistentFinancialWorkflow:()=>new FinancialWorkflowGuard()};});
vi.mock('@tanstack/react-query',()=>({useQuery:(options:unknown)=>options,useMutation:(options:unknown)=>options,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'u',email:'demo.test'})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:h.rpc,from:()=>{
  const builder:Record<string,unknown>={};
  for(const method of ['select','is','order','not','or','range','in'])builder[method]=()=>builder;
  builder.then=(resolve:(result:unknown)=>void)=>Promise.resolve(h.responses.shift()).then(resolve);
  return builder;
}}}));
import {useAccountsWithBalance, useCreateAccount, useUpdateAccount, useDeleteAccount} from '../useAccounts';
beforeEach(()=>{h.responses=[];h.rpc.mockReset();});
describe('cashbook feedback',()=>{
  it('rejects a metadata receipt for a different cashbook',async()=>{
    h.rpc.mockResolvedValue({data:{cashbook_id:'wrong'},error:null});
    const mutation=useUpdateAccount() as unknown as {mutationFn:(input:unknown)=>Promise<unknown>};
    await expect(mutation.mutationFn({id:'book',values:{name:'Sổ A',initial_amount:0,initial_date:'2026-09-30'}})).rejects.toThrow();
  });
  it('does not treat an empty archive response as a deleted cashbook',async()=>{
    h.rpc.mockResolvedValue({data:null,error:null});
    const mutation=useDeleteAccount() as unknown as {mutationFn:(input:unknown)=>Promise<unknown>};
    await expect(mutation.mutationFn('book')).rejects.toThrow();
  });
  it('throws list errors instead of returning an empty list and zero count',async()=>{
    const error={message:'denied',code:'42501'};h.responses=[{data:null,error}];
    const query=useAccountsWithBalance() as unknown as {queryFn:()=>Promise<unknown>};
    await expect(query.queryFn()).rejects.toBe(error);
  });
  it('does not expose a numeric balance when its visibility check fails',async()=>{
    h.responses=[{data:[{id:'book',current_amount:0}],error:null,count:1}];
    const error={message:'Failed to fetch'};h.rpc.mockResolvedValue({data:null,error});
    const query=useAccountsWithBalance() as unknown as {queryFn:()=>Promise<unknown>};
    await expect(query.queryFn()).rejects.toBe(error);
  });
  it('keeps the actual identity returned by create_cashbook_v1',async()=>{
    h.rpc.mockResolvedValue({data:{cashbook_id:'new-book'},error:null});
    const mutation=useCreateAccount() as unknown as {mutationFn:(values:unknown)=>Promise<unknown>};
    await expect(mutation.mutationFn({name:'Sổ A',initial_amount:0,initial_date:'2026-09-30'})).resolves.toMatchObject({id:'new-book'});
  });
  it('masks a balance the server says is hidden, including nonzero initial amounts',async()=>{
    h.responses=[{data:[{id:'book',initial_amount:100,current_amount:100}],error:null,count:1}];
    h.rpc.mockResolvedValue({data:[{cashbook_id:'book',balance_visible:false}],error:null});
    const query=useAccountsWithBalance() as unknown as {queryFn:()=>Promise<unknown>};
    await expect(query.queryFn()).resolves.toMatchObject({data:[{balance_visible:false,current_amount:null}],totalCount:1});
  });
  it.each([null,'invalid'])('does not turn malformed visible balance %s into zero',async(current_amount)=>{
    h.responses=[{data:[{id:'book',initial_amount:100,current_amount}],error:null,count:1}];
    h.rpc.mockResolvedValue({data:[{cashbook_id:'book',balance_visible:true}],error:null});
    const query=useAccountsWithBalance() as unknown as {queryFn:()=>Promise<unknown>};
    await expect(query.queryFn()).rejects.toThrow('Invalid cashbook balance values');
  });
});
