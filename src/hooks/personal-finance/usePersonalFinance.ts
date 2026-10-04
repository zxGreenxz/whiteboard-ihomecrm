import { useEffect, useReducer } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { getSessionUser } from '@/lib/authSession';
import { supabase } from '@/integrations/supabase/client';
import { createPersonalFinanceService, PersonalFinanceError, type PersonalFinanceRpcClient } from '@/lib/personalFinance/service';
import { createPendingRequests, subscribePending, type PendingRequest } from '@/lib/personalFinance/pendingRequests';

export const personalFinanceKey=(ownerId:string|null)=>['personal-finance',ownerId] as const;
const actor=async()=>(await getSessionUser())?.id??null;
function serviceFor(ownerId:string){
 type RpcBuilder=ReturnType<PersonalFinanceRpcClient['rpc']>&{setHeader(name:string,value:string):RpcBuilder};
 const client=supabase as unknown as {rpc(...args:Parameters<PersonalFinanceRpcClient['rpc']>):RpcBuilder};
 return createPersonalFinanceService({rpc:async(name,args)=>{
  const {data:{session},error}=await supabase.auth.getSession();
  if(error||session?.user.id!==ownerId)throw new PersonalFinanceError('permission','Phiên đăng nhập đã thay đổi.',null,true);
  // Pin this request to the checked JWT; the shared client's lazy token lookup can otherwise race an account switch.
  const result=await client.rpc(name,args).setHeader('Authorization',`Bearer ${session.access_token}`);
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
