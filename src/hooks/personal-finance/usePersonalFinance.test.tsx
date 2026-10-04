// @vitest-environment jsdom
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {renderHook,waitFor,act,cleanup} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import type {ReactNode} from 'react';
const io=vi.hoisted(()=>({owner:'11111111-1111-4111-8111-111111111111',rpc:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{auth:{getSession:async()=>({data:{session:{user:{id:io.owner},access_token:'test-'+io.owner}},error:null})},rpc:(...args:unknown[])=>Object.assign(io.rpc(...args),{setHeader(){return this;}})}}));
vi.mock('@/hooks/useAuth',()=>({useAuth:()=>({data:io.owner?{id:io.owner}:null,isLoading:false,error:null})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>io.owner?{id:io.owner}:null}));
import {usePersonalFinance,usePersonalFinanceMutation} from './usePersonalFinance';
const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const snapshot=(owner_id=owner)=>({owner_id,schema_version:1,wallets:[],categories:[],transactions:[],transfers:[],budgets:[],goals:[]});
function mount(){const queryClient=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});const wrapper=({children}:{children:ReactNode})=><QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;return{...renderHook(()=>({read:usePersonalFinance(),write:usePersonalFinanceMutation()}),{wrapper}),queryClient};}
beforeEach(()=>{localStorage.clear();io.owner=owner;io.rpc.mockReset();});afterEach(cleanup);
it('isolates cache on owner change and never exposes previous snapshot',async()=>{
 io.rpc.mockImplementation(async(name:string)=>({data:name==='personal_finance_snapshot'?snapshot(io.owner):null,error:null}));
 const hook=mount();await waitFor(()=>expect(hook.result.current.read.data?.owner_id).toBe(owner));
 io.owner=other;hook.rerender();expect(hook.result.current.read.data).toBeUndefined();
 await waitFor(()=>expect(hook.result.current.read.data?.owner_id).toBe(other));
 expect(hook.queryClient.getQueryData(['personal-finance',owner])).toBeUndefined();
});
it('actor changes during bootstrap: cannot request new actor snapshot under old key',async()=>{
 let release!:(v:unknown)=>void;io.rpc.mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
 const h=mount();await waitFor(()=>expect(io.rpc).toHaveBeenCalledOnce());
 io.owner=other;await act(async()=>release({data:null,error:null}));
 await waitFor(()=>expect(h.result.current.read.ownerId).toBe(other));
 expect(h.queryClient.getQueryData(['personal-finance',owner])).toBeUndefined();
 expect(io.rpc.mock.calls.every(c=>c[0]==='personal_finance_bootstrap')).toBe(true);expect(h.result.current.read.data).toBeUndefined();
});
it('malformed receipt stays pending across reload; exact replay confirms and invalidates server snapshot',async()=>{
 let malformed=true;
 io.rpc.mockImplementation(async(name:string,args?:{p_request_key:string})=>{
  if(name==='personal_finance_mutate')return{error:null,data:malformed?null:{owner_id:owner,request_key:args!.p_request_key,action:'wallet.create',entities:[{id:other,user_id:owner,version:1,name:'Ví',kind:'cash',icon:'wallet',opening_balance:0,hidden:false,is_default:false}]}};
  return{data:name==='personal_finance_snapshot'?snapshot():null,error:null};
 });
 const first=mount();await waitFor(()=>expect(first.result.current.read.data).toBeTruthy());
 let key='';await act(async()=>{const request=first.result.current.write.prepare({action:'wallet.create',data:{name:'Ví'}});key=request.requestKey;await expect(first.result.current.write.mutateAsync(request)).rejects.toMatchObject({outcomeUnknown:true});});
 first.unmount();malformed=false;const second=mount();
 expect(second.result.current.write.pending).toHaveLength(1);
 await act(async()=>{await second.result.current.write.retry(key);});
 expect(second.result.current.write.pending).toEqual([]);
 const writes=io.rpc.mock.calls.filter(c=>c[0]==='personal_finance_mutate');expect(writes[1][1]).toEqual(writes[0][1]);
});
it('malformed snapshot errors instead of empty data',async()=>{
 io.rpc.mockResolvedValue({data:null,error:null});const h=mount();await waitFor(()=>expect(h.result.current.read.error).toBeTruthy());expect(h.result.current.read.data).toBeUndefined();
});
