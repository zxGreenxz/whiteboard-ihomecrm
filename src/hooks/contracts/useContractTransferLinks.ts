import { useMutation,useQuery,useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useOrganization } from '@/contexts/OrganizationContext';
import { supabase } from '@/integrations/supabase/client';
import type { Database } from '@/integrations/supabase/types';
import { createContractTransferLink,readContractTransferLinks,cancelContractTransferLink,finalizeContractTransferExit,
  createContractTransferCommission,transferErrorMessage,type TransferInvoker,type TransferFilter,type CreateContractTransferInput,
  type CancelTransferInput,type FinalizeTransferInput,type CreateTransferCommissionInput } from '@/lib/contract-lifecycle/transfers';

type Functions=Database['public']['Functions'];
const invoke:TransferInvoker=(name,args)=>{
  switch(name){
    case 'create_contract_transfer_link_v1':return supabase.rpc('create_contract_transfer_link_v1',args as Functions['create_contract_transfer_link_v1']['Args']);
    case 'read_contract_transfer_links_v1':return supabase.rpc('read_contract_transfer_links_v1',args as Functions['read_contract_transfer_links_v1']['Args']);
    case 'cancel_contract_transfer_link_v1':return supabase.rpc('cancel_contract_transfer_link_v1',args as Functions['cancel_contract_transfer_link_v1']['Args']);
    case 'finalize_contract_transfer_exit_v1':return supabase.rpc('finalize_contract_transfer_exit_v1',args as Functions['finalize_contract_transfer_exit_v1']['Args']);
    case 'create_contract_transfer_commission_v1':return supabase.rpc('create_contract_transfer_commission_v1',args as Functions['create_contract_transfer_commission_v1']['Args']);
  }
};
export function useContractTransferLinks(filter:TransferFilter,enabled=true){
  const {selectedOrganizationId}=useOrganization();
  return useQuery({queryKey:['contract-transfer-links',selectedOrganizationId,filter.contractId??null,filter.draftId??null,filter.exitCaseId??null],
    enabled:enabled&&!!selectedOrganizationId&&Object.values(filter).some(Boolean),
    queryFn:()=>{if(!selectedOrganizationId)throw new Error('Chưa chọn tổ chức');return readContractTransferLinks(invoke,filter,selectedOrganizationId);}});
}
function useTransferMutation<T,R>(run:(input:T,org:string)=>Promise<R>,message:string){
  const {selectedOrganizationId}=useOrganization();const client=useQueryClient();
  const refresh=()=>{for(const key of [['contract-transfer-links'],['contract-exit-cases'],['contract-drafts'],['contracts'],['income-expenses']])void client.invalidateQueries({queryKey:key});};
  return useMutation({retry:false,mutationFn:(input:T)=>{if(!selectedOrganizationId)throw new Error('Chưa chọn tổ chức');return run(input,selectedOrganizationId);},
    onSuccess:()=>{refresh();toast.success(message);},onError:(error)=>{refresh();toast.error(transferErrorMessage(error));}});
}
export function useCreateContractTransferLink(){return useTransferMutation((input:CreateContractTransferInput,org)=>createContractTransferLink(invoke,input,org),'Đã liên kết hai hồ sơ hợp đồng');}
export function useCancelContractTransferLink(){return useTransferMutation((input:CancelTransferInput,org)=>cancelContractTransferLink(invoke,input,org),'Đã hủy liên kết; giữ lịch sử nhượng');}
export function useFinalizeContractTransferExit(){return useTransferMutation((input:FinalizeTransferInput,org)=>finalizeContractTransferExit(invoke,input,org),'Đã quyết toán hồ sơ cũ cùng phí nhượng');}
export function useCreateContractTransferCommission(){return useTransferMutation((input:CreateTransferCommissionInput,org)=>createContractTransferCommission(invoke,input,org),'Đã nối phiếu hoa hồng hiện hành');}
