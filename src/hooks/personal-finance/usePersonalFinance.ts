import { useEffect, useReducer } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { getSessionUser } from '@/lib/authSession';
import { supabase } from '@/integrations/supabase/client';
import { createPersonalFinanceService, PersonalFinanceError } from '@/lib/personalFinance/service';
import { createPendingRequests, subscribePending, type PendingRequest } from '@/lib/personalFinance/pendingRequests';

export const personalFinanceKey=(ownerId:string|null)=>['personal-finance',ownerId] as const;
const actor=async()=>(await getSessionUser())?.id??null;
function serviceFor(ownerId:string){
 return createPersonalFinanceService({rpc:async(name,args)=>{
  const {data:{session},error}=await supabase.auth.getSession();
  if(error||session?.user.id!==ownerId)throw new PersonalFinanceError('permission','Phiên đăng nhập đã thay đổi.',null,true);
  // Pin this request to the checked JWT; the shared client's lazy token lookup can otherwise race an account switch.
  const request=(()=>{
   switch(name){
    case 'personal_finance_bootstrap': return supabase.rpc('personal_finance_bootstrap');
    case 'personal_finance_snapshot': return supabase.rpc('personal_finance_snapshot');
    case 'personal_finance_mutate': {
     if(!args)throw new PersonalFinanceError('validation','Thiếu yêu cầu ghi ví cá nhân.');
     const {data,...payload}=args.p_payload;
     // Entity schemas accept only scalar fields; narrow the service's unknown record
     // at the generated JSON boundary without disabling RPC name/argument types.
     const fields:Record<string,string|number|boolean|null|undefined>={};
     for(const [key,value] of Object.entries(data??{})){
      if(value===null)fields[key]=null;
      else if(value===undefined)fields[key]=undefined;
      else if(typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))fields[key]=value;
      else throw new PersonalFinanceError('validation','Dữ liệu ghi ví cá nhân không hợp lệ.');
     }
     return supabase.rpc('personal_finance_mutate',{p_request_key:args.p_request_key,p_payload:{...payload,...(data?{data:fields}:{})}});
    }
   }
  })();
  const result=await request.setHeader('Authorization',`Bearer ${session.access_token}`);
  if(await actor()!==ownerId)throw new PersonalFinanceError('permission','Phiên đăng nhập đã thay đổi.',null,true);
  return result;
 }},ownerId);
}
const requests=()=>createPendingRequests(localStorage,actor);
export function usePersonalFinance(){
 const auth=useAuth();const ownerId=auth.data?.id??null;
 const qc=useQueryClient();
 useEffect(()=>{
  const predicate=(q:{queryKey:readonly unknown[]})=>['personal-finance','personal-transactions'].includes(String(q.queryKey[0]))&&q.queryKey[1]!==ownerId;
  void qc.cancelQueries({predicate});qc.removeQueries({predicate});
 },[qc,ownerId]);
 const query=useQuery({queryKey:personalFinanceKey(ownerId),enabled:!!ownerId,queryFn:()=>serviceFor(ownerId!).snapshot(),retry:false});
 return {...query,ownerId,isLoading:auth.isLoading||!!ownerId&&query.isLoading,error:auth.error??query.error,data:query.data?.owner_id===ownerId?query.data:undefined};
}
/** Shared by manual forms, management screens and QuickEntry. Always keep the returned request for retries. */
export function usePersonalFinanceMutation(){
 const {data:user}=useAuth();const ownerId=user?.id??null;const qc=useQueryClient();
 const [,refresh]=useReducer(n=>n+1,0);useEffect(()=>subscribePending(refresh),[]);
 let pending:PendingRequest[]=[];let pendingError:Error|null=null;
 try{if(ownerId)pending=requests().list(ownerId);}catch(error){pendingError=error instanceof Error?error:new Error('Không đọc được yêu cầu chờ.');}
 const mutation=useMutation({retry:false,mutationFn:async(request:PendingRequest)=>{
  if(!ownerId||request.ownerId!==ownerId)throw new PersonalFinanceError('permission','Yêu cầu không thuộc chủ ví hiện tại.',null,true);
  return requests().run(request,serviceFor(ownerId).mutate);
 },onSettled:async(_data,_error,request)=>{
  await Promise.all([qc.invalidateQueries({queryKey:personalFinanceKey(request.ownerId)}),qc.invalidateQueries({queryKey:['personal-transactions',request.ownerId]})]);
 }});
 const prepare=(payload:unknown,key?:string)=>{if(!ownerId)throw new PersonalFinanceError('permission','Vui lòng đăng nhập.');return requests().prepare(ownerId,payload,key);};
 const retry=(key:string)=>{const request=requests().list(ownerId??'').find(p=>p.requestKey===key);if(!request)throw new PersonalFinanceError('validation','Không tìm thấy yêu cầu đang chờ.');return mutation.mutateAsync(request);};
 return {...mutation,ownerId,prepare,retry,pending,pendingError};
}
