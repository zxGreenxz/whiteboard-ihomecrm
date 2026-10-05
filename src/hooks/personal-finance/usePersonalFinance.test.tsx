// @vitest-environment jsdom
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {renderHook,waitFor,act,cleanup} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import type {ReactNode} from 'react';
const io=vi.hoisted(()=>({owner:'11111111-1111-4111-8111-111111111111',transport:vi.fn(),headers:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{auth:{getSession:async()=>({data:{session:{user:{id:io.owner},access_token:'test-'+io.owner}},error:null})},rpc:(...args:unknown[])=>Object.assign(io.transport(...args),{setHeader(name:string,value:string){io.headers(name,value);return this;}})}}));
vi.mock('@/hooks/useAuth',()=>({useAuth:()=>({data:io.owner?{id:io.owner}:null,isLoading:false,error:null})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>io.owner?{id:io.owner}:null}));
import {usePersonalFinance,usePersonalFinanceMutation} from './usePersonalFinance';
const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const snapshot=(owner_id=owner)=>({owner_id,schema_version:1,wallets:[],categories:[],transactions:[],transfers:[],budgets:[],goals:[]});
function mount(){const queryClient=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});const wrapper=({children}:{children:ReactNode})=><QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;return{...renderHook(()=>({read:usePersonalFinance(),write:usePersonalFinanceMutation()}),{wrapper}),queryClient};}
beforeEach(()=>{localStorage.clear();io.owner=owner;io.transport.mockReset();io.headers.mockReset();});afterEach(cleanup);
it('routes each service operation to its exact RPC and pins the checked JWT on every request',async()=>{
 io.transport.mockImplementation(async(name:string,args?:{p_request_key:string})=>({error:null,data:name==='personal_finance_snapshot'?snapshot():name==='personal_finance_mutate'?{owner_id:owner,request_key:args!.p_request_key,action:'wallet.create',entities:[{id:other,user_id:owner,version:1,name:'Ví',kind:'cash',icon:'wallet',opening_balance:0,hidden:false,is_default:false}]}:null}));
 const h=mount();await waitFor(()=>expect(h.result.current.read.data).toBeTruthy());
 expect(io.transport.mock.calls).toEqual([['personal_finance_bootstrap'],['personal_finance_snapshot']]);
 await act(async()=>{
  const request=h.result.current.write.prepare({action:'wallet.create',data:{name:'Ví',hidden:false,opening_balance:0}});
  await h.result.current.write.mutateAsync(request);
  expect(io.transport.mock.calls.filter(c=>c[0]==='personal_finance_mutate')).toEqual([['personal_finance_mutate',{p_request_key:request.requestKey,p_payload:request.payload}]]);
 });
 expect(io.headers.mock.calls).toHaveLength(io.transport.mock.calls.length);
 expect(io.headers.mock.calls.every(call=>call[0]==='Authorization'&&call[1]===`Bearer test-${owner}`)).toBe(true);
});
it('isolates cache on owner change and never exposes previous snapshot',async()=>{
 io.transport.mockImplementation(async(name:string)=>({data:name==='personal_finance_snapshot'?snapshot(io.owner):null,error:null}));
 const hook=mount();await waitFor(()=>expect(hook.result.current.read.data?.owner_id).toBe(owner));
 io.owner=other;hook.rerender();expect(hook.result.current.read.data).toBeUndefined();
 await waitFor(()=>expect(hook.result.current.read.data?.owner_id).toBe(other));
 expect(hook.queryClient.getQueryData(['personal-finance',owner])).toBeUndefined();
});
it('actor changes during bootstrap: cannot request new actor snapshot under old key',async()=>{
 let release!:(v:unknown)=>void;io.transport.mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
 const h=mount();await waitFor(()=>expect(io.transport).toHaveBeenCalledOnce());
 expect(io.headers.mock.calls[0]).toEqual(['Authorization',`Bearer test-${owner}`]);
 io.owner=other;await act(async()=>release({data:null,error:null}));
 await waitFor(()=>expect(h.result.current.read.ownerId).toBe(other));
 expect(h.queryClient.getQueryData(['personal-finance',owner])).toBeUndefined();
 expect(io.transport.mock.calls.every(c=>c[0]==='personal_finance_bootstrap')).toBe(true);expect(h.result.current.read.data).toBeUndefined();
});
it('malformed receipt stays pending across reload; exact replay confirms and invalidates server snapshot',async()=>{
 let malformed=true;
 io.transport.mockImplementation(async(name:string,args?:{p_request_key:string})=>{
  if(name==='personal_finance_mutate')return{error:null,data:malformed?null:{owner_id:owner,request_key:args!.p_request_key,action:'wallet.create',entities:[{id:other,user_id:owner,version:1,name:'Ví',kind:'cash',icon:'wallet',opening_balance:0,hidden:false,is_default:false}]}};
  return{data:name==='personal_finance_snapshot'?snapshot():null,error:null};
 });
 const first=mount();await waitFor(()=>expect(first.result.current.read.data).toBeTruthy());
 let key='';await act(async()=>{const request=first.result.current.write.prepare({action:'wallet.create',data:{name:'Ví'}});key=request.requestKey;await expect(first.result.current.write.mutateAsync(request)).rejects.toMatchObject({outcomeUnknown:true});});
 first.unmount();malformed=false;const second=mount();
 expect(second.result.current.write.pending).toHaveLength(1);
 await act(async()=>{await second.result.current.write.retry(key);});
 expect(second.result.current.write.pending).toEqual([]);
 const writes=io.transport.mock.calls.filter(c=>c[0]==='personal_finance_mutate');expect(writes[1][1]).toEqual(writes[0][1]);
});
it('malformed snapshot errors instead of empty data',async()=>{
 io.transport.mockResolvedValue({data:null,error:null});const h=mount();await waitFor(()=>expect(h.result.current.read.error).toBeTruthy());expect(h.result.current.read.data).toBeUndefined();
});
it('actor switch after a pinned mutation response keeps its request unknown for the original owner',async()=>{
 let release!:(v:unknown)=>void;
 io.transport.mockImplementation((name:string)=>name==='personal_finance_mutate'?new Promise(resolve=>{release=resolve;}):Promise.resolve({error:null,data:name==='personal_finance_snapshot'?snapshot(io.owner):null}));
 const h=mount();await waitFor(()=>expect(h.result.current.read.data).toBeTruthy());
 const request=h.result.current.write.prepare({action:'wallet.create',data:{name:'Ví'}});
 let outcome!:Promise<void>;
 await act(async()=>{outcome=expect(h.result.current.write.mutateAsync(request)).rejects.toMatchObject({kind:'permission',outcomeUnknown:true});});
 await waitFor(()=>expect(release).toBeTypeOf('function'));
 expect(io.headers.mock.calls.at(-1)).toEqual(['Authorization',`Bearer test-${owner}`]);
 io.owner=other;
 await act(async()=>{release({error:null,data:{owner_id:owner,request_key:request.requestKey,action:'wallet.create',entities:[{id:other,user_id:owner,version:1,name:'Ví',kind:'cash',icon:'wallet',opening_balance:0,hidden:false,is_default:false}]}});await outcome;});
 io.owner=owner;h.rerender();
 expect(h.result.current.write.pending.map(p=>p.requestKey)).toContain(request.requestKey);
});
