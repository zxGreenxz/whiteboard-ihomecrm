import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { readContractSettlement, settlementQueryKey, findSettlementSelection, type SettlementReadScope } from '@/lib/contractSettlementReader';
import { readSettlementPage } from '@/lib/contractSettlementRepository';
import type { SettlementSelection } from '@/lib/contractSettlement';
/** Explicit polling covers private/unpublished tables; realtime is only an acceleration. */
export const settlementDependencies = ['contracts','contract_customers','customers','rooms','buildings','contract_terminations','contract_transfers','income_expenses','income_expense_items','income_expense_types','invoices','termination_refund_obligations','income_expense_postings','reservation_deposit_settlements','reservation_settlement_vouchers','organization_memberships'] as const;
export function useContractSettlement(scope: SettlementReadScope, selection: SettlementSelection | null = null, enabled = true) {
 const queryClient=useQueryClient(); const key=settlementQueryKey(scope);
 const query=useQuery({queryKey:key,enabled:enabled && !!scope.actorId && !!scope.organizationId && scope.buildingIds.length>0,
  queryFn:({signal})=>readContractSettlement(scope,readSettlementPage,signal),staleTime:0,refetchInterval:30_000,refetchOnWindowFocus:'always',retry:false});
 useEffect(()=>{
  if(!enabled || !scope.organizationId || !scope.actorId)return;
  const channel=supabase.channel(`settlement:${scope.organizationId}:${scope.actorId}`);
  for(const table of settlementDependencies)channel.on('postgres_changes',{event:'*',schema:'public',table},()=>{void queryClient.invalidateQueries({queryKey:['contract-settlement',scope.organizationId,scope.actorId]});});
  channel.subscribe();return ()=>{void supabase.removeChannel(channel);};
 },[enabled,scope.organizationId,scope.actorId,queryClient]);
 const selectedRow=findSettlementSelection(query.data?.rows??[],selection);
 const selectionDetail= !selection ? null : query.isFetching ? {state:'loading' as const} : !selectedRow ? {state:'unavailable' as const,reason:'SELECTION_NOT_VISIBLE'} : selectedRow.rowType==='voucher' && selectedRow.snapshot.state==='unavailable' ? selectedRow.snapshot : {state:'ready' as const,value:selectedRow};
 const errorCode=query.error?.message??query.data?.error??null;
 const error=errorCode === null ? null : errorCode==='SETTLEMENT_READ_DENIED' ? 'Bạn không có quyền đọc dữ liệu trong phạm vi này.' : errorCode==='SETTLEMENT_CHANGED_RELOAD' ? 'Dữ liệu vừa thay đổi. Vui lòng tải lại để xem danh sách và tổng đầy đủ.' : 'Chưa đọc đủ dữ liệu quyết toán. Vui lòng tải lại; tổng tiền tạm thời chưa xác định.';
 return {...query.data,rows:query.data?.rows??[],totals:query.isError?null:query.data?.totals??null,loading:query.isPending,error,errorCode,partial:query.isError||query.data?.partial||false,pagination:query.data?.pagination??{complete:false,pages:0,nextCursor:null},selectionDetail,refresh:async():Promise<void>=>{const result=await query.refetch();if(result.error||result.data?.error)throw new Error('Chưa tải lại được dữ liệu quyết toán. Vui lòng thử lại.');}};
}
