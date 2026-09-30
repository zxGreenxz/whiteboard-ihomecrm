import {useEffect,useRef,useState} from 'react';
import {persistentFinancialWorkflow} from '@/lib/persistentFinancialWorkflow';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
import {financialPending} from '@/lib/financialPending';
import {getSessionUser} from '@/lib/authSession';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOrganization } from '@/contexts/OrganizationContext';
import { readContractDraftSigning, signAndCheckinDraft, getOrCreateSignedContractDocument } from '@/lib/contractSigningApi';
import { signingErrorMessage,buildContractSigningArgs,contractSigningSchema, type ContractSigningInput, type ContractSigning } from '@/lib/contractSigning';
import { downloadDocxBlob } from '@/lib/contractTemplateEngine';
import { toast } from 'sonner';

export function useContractDraftSigning(draftId?: string, enabled = true) {
  const { selectedOrganizationId } = useOrganization();
  return useQuery({ queryKey: ['contract-draft-signing', selectedOrganizationId, draftId],
    enabled: enabled && !!selectedOrganizationId && !!draftId, retry: false,
    refetchOnWindowFocus: true,
    queryFn: () => {
      if (!selectedOrganizationId || !draftId) throw new Error('Chưa chọn tổ chức hoặc bản nháp.');
      return readContractDraftSigning(selectedOrganizationId, draftId);
    },
  });
}
export function useContractSigning(organizationId:string,draftId?:string) {
  const {selectedOrganizationId}=useOrganization();const queryClient=useQueryClient();
  const workflow=useRef(persistentFinancialWorkflow('contract-signing')).current;
  const [pendingRequestId,setPendingRequestId]=useState<string|null>(null);
  const [hydrating,setHydrating]=useState(!!draftId);
  useEffect(()=>{let cancelled=false;if(!draftId){setPendingRequestId(null);setHydrating(false);return;}setHydrating(true);
    void getSessionUser().then(actor=>{if(cancelled)return;if(!actor){setPendingRequestId(null);return;}
      const pending=financialPending.read({namespace:'contract-signing',userId:actor.id,organizationId,businessKey:draftId});setPendingRequestId(pending?(pending.requestKey??pending.attemptId):null);
    }).catch(()=>{if(!cancelled)setPendingRequestId('unreadable');}).finally(()=>{if(!cancelled)setHydrating(false);});return()=>{cancelled=true;};
  },[organizationId,draftId]);
  const mutation=useMutation({mutationFn:async(input?:ContractSigningInput)=>{
    if(!selectedOrganizationId||selectedOrganizationId!==organizationId)throw new FinancialWorkflowError('Tổ chức đang chọn đã đổi. Mở lại bản nháp trong đúng tổ chức.','failure',[]);
    const target=draftId??input?.source.draftId;if(!target||input&&input.source.draftId!==target)throw new FinancialWorkflowError('Chưa xác định được đúng bản nháp để ký. Tải lại bản nháp.','failure',[]);
    if(input)buildContractSigningArgs(organizationId,input);
    return workflow.run(target,'ghi nhận ký hợp đồng',async progress=>{
      if(!input)throw new FinancialWorkflowError('Không có lần ký đang chờ đối chiếu. Tải lại bản nháp.','failure',[]);
      setPendingRequestId(progress.requestKey);
      const record=(raw:unknown)=>{const id=raw&&typeof raw==='object'?(raw as {contract_id?:unknown}).contract_id:undefined;if(typeof id==='string'&&id&&!progress.completed.some(step=>step.id===id))progress.completed.push({id,label:`Đã nhận hợp đồng chính thức ${id}`});};
      const raw=await signAndCheckinDraft(organizationId,{...input,requestId:progress.requestKey},record);record(raw);
      const signing=contractSigningSchema.parse(raw);
      if(signing.organization_id!==organizationId||signing.draft_id!==target||signing.revision!==input.source.revision||signing.document_id!==input.source.documentId||signing.document_sha256!==input.source.documentSha256)throw new TypeError('Chưa xác nhận được đúng nguồn ký và hợp đồng chính thức.');
      return signing;
    },async(pending,progress)=>{
      const snapshot=await readContractDraftSigning(organizationId,target);if(!snapshot.signing)return null;
      const signing=contractSigningSchema.parse(snapshot.signing);
      if(signing.organization_id!==organizationId||signing.draft_id!==target||signing.request_id!==(pending.requestKey??pending.attemptId))return null;
      progress.completed.push({id:signing.contract_id,label:`Đã đối chiếu hợp đồng ${signing.contract_number}`});return {result:signing};
    },organizationId);
  },onSuccess:async signing=>{
    setPendingRequestId(null);queryClient.setQueryData(['contract-draft-signing',organizationId,signing.draft_id],(current:{server_today?:string}|undefined)=>({...current,signing}));
    await Promise.all(['contract-drafts','contracts','rooms','my-available-rooms','room-reservations','contract-draft-signing','contract-commission-followups'].map(key=>queryClient.invalidateQueries({queryKey:[key]})));
    toast.success(`Đã ghi nhận ký và nhận phòng · ${signing.contract_number}`);
  },onError:error=>toast.error(signingErrorMessage(error))});
  return {...mutation,pendingRequestId,isPending:mutation.isPending||hydrating};
}
export function useSignedContractDocument(organizationId: string) {
  const { selectedOrganizationId } = useOrganization();
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: (signing: ContractSigning) => {
    if (!selectedOrganizationId || selectedOrganizationId !== organizationId || signing.organization_id !== organizationId) throw new Error('Tổ chức đang chọn đã đổi. Mở lại hợp đồng.');
    return getOrCreateSignedContractDocument(signing);
  }, onSuccess: async ({ signing, blob }) => {
    downloadDocxBlob(blob, signing.contract_number);
    await queryClient.invalidateQueries({ queryKey: ['contract-draft-signing', organizationId, signing.draft_id] });
  }, onError: error => toast.error(`Hợp đồng vẫn đã ký. Chưa tạo được bản tải: ${signingErrorMessage(error)}`) });
}
