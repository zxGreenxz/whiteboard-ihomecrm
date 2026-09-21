import {useEffect} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {supabase} from '@/integrations/supabase/client';
import {useAuth} from './useAuth';
import {useOrganization} from '@/contexts/OrganizationContext';
import {parseSettlementFinancialContext,type SettlementFinancialScope} from '@/lib/contractSettlementFinancialContext';
export interface SettlementFinancialTarget {roomId:string|null;contractId:string|null;terminationId?:string|null;voucherId?:string|null;sourceReceiptId?:string|null}
export const financialContextDependencies=['contracts','rooms','buildings','contract_transfers','contract_terminations','termination_refund_obligations','contract_deposit_links','income_expenses','income_expense_items','income_expense_postings','invoices','invoice_items','payments','invoice_payment_collections','invoice_payment_tenders','invoice_payment_allocations','organization_memberships'] as const;
type Rpc=(name:'read_contract_settlement_financial_facts_v1',args:{p_organization_id:string;p_room_id:string|null;p_contract_id:string|null;p_termination_id:string|null;p_voucher_id:string|null;p_source_receipt_id:string|null})=>{abortSignal(signal:AbortSignal):PromiseLike<{data:unknown;error:{code?:string;message:string}|null}>};
/** Also used by multi-contract reference lanes; always passes the same validated boundary. */
export async function readSettlementFinancialContext(scope:SettlementFinancialScope,signal:AbortSignal){
  const result=await (supabase.rpc as unknown as Rpc)('read_contract_settlement_financial_facts_v1',{p_organization_id:scope.organizationId,p_room_id:scope.roomId,p_contract_id:scope.contractId,p_termination_id:scope.terminationId,p_voucher_id:scope.voucherId,p_source_receipt_id:scope.sourceReceiptId}).abortSignal(signal);
  if(result.error)throw Object.assign(new Error('Không đọc được thông tin quyết toán trong phạm vi này. Vui lòng tải lại.'),{cause:result.error});
  try{return parseSettlementFinancialContext(result.data,scope);}catch(cause){throw Object.assign(new Error('Dữ liệu quyết toán chưa được xác minh. Vui lòng tải lại.'),{cause});}
}
export const settlementFinancialQueryKey=(actorId:string|undefined,scope:SettlementFinancialScope)=>['settlement-financial-context',actorId,scope.organizationId,scope.roomId,scope.contractId,scope.terminationId,scope.voucherId,scope.sourceReceiptId] as const;
export function useContractSettlementFinancialFacts(target:SettlementFinancialTarget,enabled=true){
 const {data:actor}=useAuth();const {selectedOrganizationId}=useOrganization();const client=useQueryClient();
 const scope:SettlementFinancialScope={organizationId:selectedOrganizationId??'',roomId:target.roomId,contractId:target.contractId,terminationId:target.terminationId??null,voucherId:target.voucherId??null,sourceReceiptId:target.sourceReceiptId??null};
 const active=enabled&&!!actor?.id&&!!selectedOrganizationId&&!!(target.contractId||target.voucherId||target.sourceReceiptId);
 const key=settlementFinancialQueryKey(actor?.id,scope);
 const query=useQuery({queryKey:key,enabled:active,retry:false,staleTime:0,refetchInterval:30_000,refetchOnWindowFocus:'always',queryFn:async({signal})=>{
  return readSettlementFinancialContext(scope,signal);
 }});
 const identity=JSON.stringify(key);
 useEffect(()=>{if(!active)return;const queryKey=JSON.parse(identity) as string[];const ch=supabase.channel('financial-context:'+identity);for(const table of financialContextDependencies)ch.on('postgres_changes',{event:'*',schema:'public',table},()=>{void client.invalidateQueries({queryKey});});ch.subscribe();return()=>{void supabase.removeChannel(ch);};},[active,identity,client]);
 return {...query,data:active&&!query.isError?query.data:undefined,refresh:async()=>{if(!active)throw Error('Chưa chọn nguồn quyết toán.');const refreshed=await query.refetch({throwOnError:true});if(!refreshed.data)throw Error('Dữ liệu quyết toán chưa sẵn sàng.');return refreshed.data;}};
}
