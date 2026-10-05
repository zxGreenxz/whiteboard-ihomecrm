// @vitest-environment jsdom
import {expect,it,vi} from 'vitest';
import {createPersonalFinanceService} from '@/lib/personalFinance/service';
const owner='11111111-1111-4111-8111-111111111111';
const input={action:'transaction.create',data:{type:'EXPENSE',amount:100,txn_date:'2026-09-30',wallet_id:owner,category_id:owner}};
it('missing receipt ID remains unknown across replay rather than success',async()=>{
 const rpc=vi.fn().mockResolvedValue({data:null,error:null});const service=createPersonalFinanceService({rpc},owner);
 await expect(service.mutate(owner,input)).rejects.toMatchObject({outcomeUnknown:true});await expect(service.mutate(owner,input)).rejects.toMatchObject({outcomeUnknown:true});expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
});
it.each([{...input.data,amount:NaN},{...input.data,amount:0},{...input.data,txn_date:'2026-02-30'}])('invalid payload rejects before RPC: %j',async(data)=>{
 const rpc=vi.fn();await expect(createPersonalFinanceService({rpc},owner).mutate(owner,{...input,data})).rejects.toThrow();expect(rpc).not.toHaveBeenCalled();
});
it.each([null,'','  '])('read amount %j never becomes a zero balance',async amount=>{
 const rpc=vi.fn().mockResolvedValue({data:{owner_id:owner,schema_version:1,wallets:[],categories:[],transactions:[{amount}],transfers:[],budgets:[],goals:[]},error:null});
 await expect(createPersonalFinanceService({rpc},owner).snapshot()).rejects.toThrow();
});

// These regression cases mount the actual compatibility hooks, query/service boundary and pending registry.
import {createElement,type ReactNode} from 'react';
import {renderHook,act,waitFor,cleanup} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {beforeEach,afterEach} from 'vitest';
const io=vi.hoisted(()=>({owner:'11111111-1111-4111-8111-111111111111',transport:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{auth:{getSession:async()=>({data:{session:{user:{id:io.owner},access_token:'test-token'}},error:null})},rpc:(...args:unknown[])=>Object.assign(io.transport(...args),{setHeader(){return this;}})}}));
vi.mock('@/hooks/useAuth',()=>({useAuth:()=>({data:{id:io.owner},isLoading:false,error:null})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:io.owner})}));
vi.mock('sonner',()=>({toast:{success:vi.fn(),error:vi.fn()}}));
import {useDeletePersonalTransaction,useCreatePersonalTransaction,usePersonalTransactions} from '../usePersonalTransactions';
import {usePersonalFinanceMutation} from '../personal-finance/usePersonalFinance';
import type {Mutation} from '@/lib/personalFinance/contract';
const a='22222222-2222-4222-8222-222222222222',b='33333333-3333-4333-8333-333333333333';
const keyA='44444444-4444-4444-8444-444444444444';
const snapshot={owner_id:owner,schema_version:1,wallets:[{id:owner,user_id:owner,version:1,name:'Ví',kind:'cash',icon:'wallet',opening_balance:0,balance:0,hidden:false,is_default:true}],categories:[{id:owner,user_id:owner,version:1,name:'Chi khác',type:'EXPENSE',hidden:false,icon:'wallet',color:'#123456',seed_key:'other',legacy_name:null}],transactions:[],transfers:[],budgets:[],goals:[]};
function actualHooks(){
 const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 const wrapper=({children}:{children:ReactNode})=>createElement(QueryClientProvider,{client},children);
 return renderHook(()=>({read:usePersonalTransactions(),remove:useDeletePersonalTransaction(),create:useCreatePersonalTransaction(),recovery:usePersonalFinanceMutation()}),{wrapper});
}
function server(){
 let writes=0;
 io.transport.mockImplementation(async(name:string,args?:{p_request_key:string;p_payload:Mutation})=>{
  if(name!=='personal_finance_mutate')return {data:name==='personal_finance_snapshot'?{...snapshot,owner_id:io.owner,wallets:snapshot.wallets.map(w=>({...w,user_id:io.owner})),categories:snapshot.categories.map(c=>({...c,user_id:io.owner}))}:null,error:null};
  if(++writes===1)throw new TypeError('Failed to fetch');
  const p=args!.p_payload;
  const entity=p.action==='transaction.delete'?{id:p.id,user_id:owner,version:p.expected_version,deleted:true}:{id:crypto.randomUUID(),user_id:owner,version:1,description:null,...p.data,category:null,created_at:'2026-09-30T00:00:00Z',updated_at:'2026-09-30T00:00:00Z',deleted_at:null};
  return {data:{owner_id:owner,request_key:args!.p_request_key,action:p.action,entities:[entity]},error:null};
 });
}
const writes=()=>io.transport.mock.calls.filter(c=>c[0]==='personal_finance_mutate').map(c=>c[1] as {p_request_key:string;p_payload:Mutation});
beforeEach(()=>{localStorage.clear();io.transport.mockReset();io.owner=owner;});afterEach(cleanup);
it('actual delete hook: unknown A does not block B; explicit retry A keeps its key and payload',async()=>{
 server();const h=actualHooks();await waitFor(()=>expect(h.result.current.read.isSuccess).toBe(true));
 await act(async()=>{await expect(h.result.current.remove.mutateAsync({id:a,expected_version:3,request_key:keyA})).rejects.toMatchObject({outcomeUnknown:true});});
 await act(async()=>{await expect(h.result.current.remove.mutateAsync({id:a,expected_version:4,request_key:keyA})).rejects.toMatchObject({kind:'conflict',outcomeUnknown:true});});
 expect(writes()).toHaveLength(1);
 await act(async()=>{await expect(h.result.current.remove.mutateAsync({id:b,expected_version:8})).resolves.toMatchObject({id:b});});
 expect(h.result.current.recovery.pending.map(p=>p.requestKey)).toEqual([keyA]);
 await act(async()=>{await h.result.current.remove.mutateAsync({id:a,expected_version:3,request_key:keyA});});
 expect(writes()[1].p_request_key).not.toBe(keyA);expect(writes()[2]).toEqual(writes()[0]);expect(h.result.current.recovery.pending).toEqual([]);
});
it('actual create hook: two independent identical entries receive distinct request keys while A is unknown',async()=>{
 server();const h=actualHooks();await waitFor(()=>expect(h.result.current.read.isSuccess).toBe(true));
 const values={type:'EXPENSE' as const,amount:100,txn_date:'2026-09-30'};
 await act(async()=>{await expect(h.result.current.create.mutateAsync({...values})).rejects.toMatchObject({outcomeUnknown:true});});
 await act(async()=>{await h.result.current.create.mutateAsync({...values});});
 expect(writes()[1].p_payload).toEqual(writes()[0].p_payload);expect(writes()[1].p_request_key).not.toBe(writes()[0].p_request_key);
 expect(h.result.current.recovery.pending.map(p=>p.requestKey)).toEqual([writes()[0].p_request_key]);
});
it('actual delete hook: external pending recovery cannot leave a stale handle blocking a new action',async()=>{
 server();const h=actualHooks();await waitFor(()=>expect(h.result.current.read.isSuccess).toBe(true));
 await act(async()=>{await expect(h.result.current.remove.mutateAsync({id:a,expected_version:3,request_key:keyA})).rejects.toThrow();});
 await act(async()=>{await h.result.current.recovery.retry(keyA);});
 await act(async()=>{await expect(h.result.current.remove.mutateAsync({id:b,expected_version:8})).resolves.toMatchObject({id:b});});
 expect(writes()[1]).toEqual(writes()[0]);expect(writes()[2].p_request_key).not.toBe(keyA);expect(h.result.current.recovery.pending).toEqual([]);
});
it('actual hook keeps explicit operation ownership after actor changes',async()=>{
 server();const h=actualHooks();await waitFor(()=>expect(h.result.current.read.isSuccess).toBe(true));
 await act(async()=>{await expect(h.result.current.remove.mutateAsync({id:a,expected_version:3,request_key:keyA})).rejects.toThrow();});
 io.owner=b;h.rerender();await waitFor(()=>expect(h.result.current.read.ownerId).toBe(b));await waitFor(()=>expect(h.result.current.read.isSuccess).toBe(true));
 await act(async()=>{await expect(h.result.current.remove.mutateAsync({id:a,expected_version:3,request_key:keyA})).rejects.toMatchObject({kind:'permission',outcomeUnknown:true});});
 expect(writes()).toHaveLength(1);expect(h.result.current.recovery.pending).toEqual([]);
 io.owner=owner;h.rerender();await waitFor(()=>expect(h.result.current.read.isSuccess).toBe(true));
 expect(h.result.current.recovery.pending.map(p=>p.requestKey)).toEqual([keyA]);
});
