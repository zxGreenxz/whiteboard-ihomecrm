import { useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { usePersonalFinance, usePersonalFinanceMutation } from './personal-finance/usePersonalFinance';
import { selectTransactions, selectBalance } from '@/lib/personalFinance/selectors';
import { transactionInput, type TransactionValues } from '@/lib/personalFinance/transactionInput';
import { PersonalFinanceError } from '@/lib/personalFinance/service';
import type { PendingRequest } from '@/lib/personalFinance/pendingRequests';
import type { Mutation, PersonalTransaction as Transaction } from '@/lib/personalFinance/contract';
export type PersonalTransaction=Transaction;
export type PersonalTransactionFormValues=TransactionValues;
export const usePersonalTransactions=()=>{const q=usePersonalFinance();return {...q,balance:q.data?selectBalance(q.data):undefined,data:q.data?selectTransactions(q.data).map(t=>({...t,category:q.data!.categories.find(c=>c.id===t.resolved_category_id)?.name??t.category})):undefined};};
function useWrite<T>(build:(input:T,snapshot:NonNullable<ReturnType<typeof usePersonalFinance>['data']>)=>Mutation,label:string){
 const q=usePersonalFinance();const writer=usePersonalFinanceMutation();const held=useRef<PendingRequest|null>(null);
 const mutation=useMutation({retry:false,meta:{handlesFeedback:true},mutationFn:async(input:T)=>{
  if(!q.data||q.data.owner_id!==writer.ownerId)throw new PersonalFinanceError('permission','Chờ tải ví cá nhân trước khi lưu.');
  const payload=build(input,q.data);
  const key=(input as {request_key?:string}).request_key;
  if(held.current&&held.current.ownerId!==writer.ownerId)throw new PersonalFinanceError('permission','Phiên đăng nhập đã thay đổi.',null,true);
  const request=writer.prepare(payload,key??held.current?.requestKey);held.current=request;
  try{const receipt=await writer.mutateAsync(request);held.current=null;return receipt.entities[0];}
  catch(error){if(error instanceof PersonalFinanceError&&!error.outcomeUnknown&&!['network','internal'].includes(error.kind))held.current=null;throw error;}
 },onSuccess:()=>toast.success(label),onError:(error)=>toast.error(error instanceof Error?error.message:'Chưa xác nhận được thao tác.')});
 return {...mutation,pendingRequest:held.current};
}
export const useCreatePersonalTransaction=()=>useWrite<TransactionValues>((values,s)=>({action:'transaction.create',data:transactionInput(values,s)}),'Đã thêm khoản');
export const useUpdatePersonalTransaction=()=>useWrite<{id:string;expected_version:number;values:Partial<TransactionValues>;original:Transaction;request_key?:string}>((input,s)=>({action:'transaction.update',id:input.id,expected_version:input.expected_version,data:transactionInput(input.values,s,input.original)}),'Đã cập nhật khoản');
export const useDeletePersonalTransaction=()=>useWrite<{id:string;expected_version:number;request_key?:string}>((input)=>({action:'transaction.delete',id:input.id,expected_version:input.expected_version,data:{}}),'Đã xoá khoản');
