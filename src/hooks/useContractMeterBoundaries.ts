import { useMutation,useQuery,useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import type { Database } from '@/integrations/supabase/types';
import { useOrganization } from '@/contexts/OrganizationContext';
import { contractExitErrorMessage } from '@/lib/contractExitCases';
import { readMeterBoundarySet,readMeterInterval,reviseMeterBoundarySet,type MeterBoundaryInvoker,type MeterBoundaryKind,type ReviseMeterBoundaryInput } from '@/lib/contractMeterBoundaries';
type Functions=Database['public']['Functions'];
const invoke:MeterBoundaryInvoker=(name,args)=>{
  switch(name){
    case 'read_contract_meter_boundary_set_v1':return supabase.rpc('read_contract_meter_boundary_set_v1',args as Functions['read_contract_meter_boundary_set_v1']['Args']);
    case 'revise_contract_meter_boundary_set_v1':return supabase.rpc('revise_contract_meter_boundary_set_v1',args as Functions['revise_contract_meter_boundary_set_v1']['Args']);
    case 'read_contract_meter_interval_v1':return supabase.rpc('read_contract_meter_interval_v1',args as Functions['read_contract_meter_interval_v1']['Args']);
  }
};
export function useContractMeterBoundaries(contractId?:string|null,kind:MeterBoundaryKind='MOVE_OUT'){
  const {selectedOrganizationId}=useOrganization();
  return useQuery({queryKey:['contract-meter-boundaries',selectedOrganizationId,contractId,kind],queryFn:()=>readMeterBoundarySet(invoke,selectedOrganizationId!,contractId!,kind),enabled:!!selectedOrganizationId&&!!contractId,retry:false});
}
export function useContractMeterInterval(contractId:string|null|undefined,meterId:string|null|undefined,at:string){
  const {selectedOrganizationId}=useOrganization();
  return useQuery({queryKey:['contract-meter-interval',selectedOrganizationId,contractId,meterId,at],queryFn:()=>readMeterInterval(invoke,selectedOrganizationId!,contractId!,meterId!,at),enabled:!!selectedOrganizationId&&!!contractId&&!!meterId&&!!at,retry:false});
}
export function useReviseContractMeterBoundaries(){
  const {selectedOrganizationId}=useOrganization();const cache=useQueryClient();
  return useMutation({mutationFn:(input:ReviseMeterBoundaryInput)=>{
    if(!selectedOrganizationId)throw {code:'42501',message:'Chưa chọn tổ chức'};
    return reviseMeterBoundarySet(invoke,selectedOrganizationId,input);
  },retry:false,onError:(error)=>toast.error(contractExitErrorMessage(error)),onSuccess:async(result)=>{
    toast.success(result.state==='REVIEW'?'Đã lưu chỉ số • Cần đối soát':'Đã lưu mốc chỉ số');
    await Promise.all(['contract-meter-boundaries','contract-meter-interval','contract-meter-followups'].map(key=>cache.invalidateQueries({queryKey:[key]})));
  }});
}
