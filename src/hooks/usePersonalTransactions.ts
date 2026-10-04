import { useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { usePersonalFinance, usePersonalFinanceMutation } from './personal-finance/usePersonalFinance';
import { selectTransactions, selectBalance } from '@/lib/personalFinance/selectors';
import { transactionInput, type TransactionValues } from '@/lib/personalFinance/transactionInput';
import { PersonalFinanceError } from '@/lib/personalFinance/service';
import type { Mutation, PersonalTransaction as Transaction } from '@/lib/personalFinance/contract';
export type PersonalTransaction=Transaction;
export type PersonalTransactionFormValues=TransactionValues;
export const usePersonalTransactions=()=>{const q=usePersonalFinance();return {...q,balance:q.data?selectBalance(q.data):undefined,data:q.data?selectTransactions(q.data).map(t=>({...t,category:q.data!.categories.find(c=>c.id===t.resolved_category_id)?.name??t.category})):undefined};};
function useWrite<T>(build:(input:T,snapshot:NonNullable<ReturnType<typeof usePersonalFinance>['data']>)=>Mutation,label:string){
 const q=usePersonalFinance();const writer=usePersonalFinanceMutation();
 const operationOwners=useRef(new Map<string,string>());
 const mutation=useMutation({retry:false,meta:{handlesFeedback:true},mutationFn:async(input:T)=>{
  if(!q.data||q.data.owner_id!==writer.ownerId)throw new PersonalFinanceError('permission','Chờ tải ví cá nhân trước khi lưu.');
  const payload=build(input,q.data);
  const key=(input as {request_key?:string}).request_key;
  if(key&&operationOwners.current.has(key)&&operationOwners.current.get(key)!==writer.ownerId)
   throw new PersonalFinanceError('permission','Yêu cầu thuộc phiên đăng nhập trước.',null,true);
  // A retry names its operation explicitly. An independent confirmation without a key
  // always gets a fresh UUID, even when an earlier identical operation remains unknown.
  const request=writer.prepare(payload,key);
  operationOwners.current.set(request.requestKey,request.ownerId);
  const receipt=await writer.mutateAsync(request);return receipt.entities[0];
 },onSuccess:()=>toast.success(label),onError:(error)=>toast.error(error instanceof Error?error.message:'Chưa xác nhận được thao tác.')});
 return {...mutation,pendingRequests:writer.pending,retryPending:writer.retry};
}
export const useCreatePersonalTransaction=()=>useWrite<TransactionValues>((values,s)=>({action:'transaction.create',data:transactionInput(values,s)}),'Đã thêm khoản');
export const useUpdatePersonalTransaction=()=>useWrite<{id:string;expected_version:number;values:Partial<TransactionValues>;original:Transaction;request_key?:string}>((input,s)=>({action:'transaction.update',id:input.id,expected_version:input.expected_version,data:transactionInput(input.values,s,input.original)}),'Đã cập nhật khoản');
export const useDeletePersonalTransaction=()=>useWrite<{id:string;expected_version:number;request_key?:string}>((input)=>({action:'transaction.delete',id:input.id,expected_version:input.expected_version,data:{}}),'Đã xoá khoản');
