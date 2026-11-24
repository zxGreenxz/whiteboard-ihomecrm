import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useOrganization } from '@/contexts/OrganizationContext';
import type { Database } from '@/integrations/supabase/types';
import { toast } from 'sonner';
import { exitWithMeterSources } from '@/lib/meter-capture/service';
import { meterSourceReferenceSchema } from '@/lib/meter-capture/types';
import { EXIT_SETTLEMENT_DRAFT_KEYS } from '@/hooks/useContractExitSettlementDrafts';
import {
  confirmContractReturn,finalizeContractExitCase,getContractExitCase,listContractExitCases,updateContractExitKind,contractExitErrorMessage,
  type ContractExitCaseFilters,type ContractExitRpcInvoker,type ConfirmContractReturnInput,
  type FinalizeContractExitCaseInput,type UpdateContractExitKindInput,
} from '@/lib/contractExitCases';

type Functions=Database['public']['Functions'];
// Literal RPC names preserve the normal generated-client boundary.
const invoke:ContractExitRpcInvoker=(name,args)=>{
  const settlement = args.p_settlement;
  if ((name === 'confirm_contract_return_v2' || name === 'confirm_contract_return_v1' || name === 'finalize_contract_exit_case_v1') && settlement && typeof settlement === 'object' && !Array.isArray(settlement)) {
    const charges = settlement.extra_charges;
    const sources = Array.isArray(charges) ? charges.flatMap(charge => {
      if (!charge || typeof charge !== 'object' || Array.isArray(charge) || !charge.meter_source) return [];
      return [meterSourceReferenceSchema.parse(charge.meter_source)];
    }) : [];
    // Đường ảnh đồng hồ nhận cả writer v2 (migration 20261124154554): trả phòng trước hạn + quyết toán ngay đi qua v2 kèm
    // trường hợp (chỉ chủ nhà hỗ trợ được quyết toán ngay; hai trường hợp sang nhượng máy chủ vẫn chỉ cho quyết toán sau).
    if (sources.length) return exitWithMeterSources(String(args.p_organization_id), name, args, sources).then(data => ({ data, error: null }));
  }
  switch(name){
    case 'confirm_contract_return_v2': return supabase.rpc('confirm_contract_return_v2',args as Functions['confirm_contract_return_v2']['Args']);
    case 'confirm_contract_return_v1': return supabase.rpc('confirm_contract_return_v1',args as Functions['confirm_contract_return_v1']['Args']);
    case 'finalize_contract_exit_case_v1': return supabase.rpc('finalize_contract_exit_case_v1',args as Functions['finalize_contract_exit_case_v1']['Args']);
    case 'update_contract_exit_case_kind_v1': return supabase.rpc('update_contract_exit_case_kind_v1',args as Functions['update_contract_exit_case_kind_v1']['Args']);
    case 'get_contract_exit_case_v1': return supabase.rpc('get_contract_exit_case_v1',args as Functions['get_contract_exit_case_v1']['Args']);
    case 'list_contract_exit_cases_v1': return supabase.rpc('list_contract_exit_cases_v1',args as Functions['list_contract_exit_cases_v1']['Args']);
  }
};
export function useContractExitCases(filters:ContractExitCaseFilters={}) {
  const {selectedOrganizationId}=useOrganization();
  return useQuery({queryKey:['contract-exit-cases',selectedOrganizationId,filters],queryFn:()=>listContractExitCases(invoke,filters,selectedOrganizationId!),enabled:!!selectedOrganizationId,retry:false,refetchInterval:60_000,refetchIntervalInBackground:false});
}
export function useContractExitCase(caseId?:string|null) {
  const {selectedOrganizationId}=useOrganization();
  return useQuery({queryKey:['contract-exit-case',selectedOrganizationId,caseId],queryFn:()=>getContractExitCase(invoke,caseId!,selectedOrganizationId!),enabled:!!caseId&&!!selectedOrganizationId,retry:false});
}
function useExitMutation<Input>(mutationFn:(input:Input,organizationId:string)=>ReturnType<typeof confirmContractReturn>,kindChange=false) {
  const {selectedOrganizationId}=useOrganization();
  const cache=useQueryClient();
  return useMutation({mutationFn:(input:Input)=>{
    if(!selectedOrganizationId) throw {code:'42501',message:'Chưa chọn tổ chức'};
    return mutationFn(input,selectedOrganizationId);
  },retry:false,onError:(error)=>toast.error(contractExitErrorMessage(error)),onSuccess:async(result)=>{
    toast.success(kindChange?'Đã cập nhật loại thanh lý':result.state==='PENDING'?'Đã trả phòng • Chờ quyết toán':'Đã quyết toán');
    await Promise.all(['contract-exit-cases','contract-exit-case','contract-exit-early-terms','sale-room-inventory','contract-meter-boundaries','contract-meter-followups','contracts','contract','rooms','my-available-rooms','phong-trong','invoices','income-expenses','excess-amount','contract-pending-forfeit',...EXIT_SETTLEMENT_DRAFT_KEYS].map(key=>cache.invalidateQueries({queryKey:[key]})));
  }});
}
export function useConfirmContractReturn(){return useExitMutation((input:ConfirmContractReturnInput,org:string)=>confirmContractReturn(invoke,input,org));}
export function useFinalizeContractExitCase(){return useExitMutation((input:FinalizeContractExitCaseInput,org:string)=>finalizeContractExitCase(invoke,input,org));}
export function useUpdateContractExitKind(){return useExitMutation((input:UpdateContractExitKindInput,org:string)=>updateContractExitKind(invoke,input,org),true);}
