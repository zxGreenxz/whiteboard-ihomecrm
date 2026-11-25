import {useEffect,useRef,useState} from 'react';
import {persistentFinancialWorkflow} from '@/lib/persistentFinancialWorkflow';
import {FinancialAlreadyRecordedError,FinancialWorkflowError,isConfirmedFinancialRejection} from '@/lib/financialWorkflow';
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
    // Cách B (đợt 7): sign_and_checkin_contract_draft_v1 (production 26/11/2026) khoá phòng FOR UPDATE, khoá công ty và bản
    // nháp FOR UPDATE TRƯỚC khi tra lần ký; mỗi bản nháp chỉ có MỘT lần ký (contract_draft_signings_draft_id_key): cùng nội
    // dung ⇒ trả lại lần ký cũ, khác nội dung ⇒ 23505. Lần bấm sau đọc lần ký của bản nháp; chưa có thì gửi lại đúng mã.
    let resend=false;
    return workflow.run(target,'ghi nhận ký hợp đồng',async progress=>{
      if(!input)throw new FinancialWorkflowError('Chưa thấy lần ký đã gửi trên máy chủ. Kiểm tra thông tin rồi bấm «Xác nhận đã ký và nhận phòng» để gửi lại; mỗi bản nháp chỉ được ghi nhận ký một lần.','failure',[]);
      setPendingRequestId(progress.requestKey);
      const record=(raw:unknown)=>{const id=raw&&typeof raw==='object'?(raw as {contract_id?:unknown}).contract_id:undefined;if(typeof id==='string'&&id&&!progress.completed.some(step=>step.id===id))progress.completed.push({id,label:`Đã nhận hợp đồng chính thức ${id}`});};
      let raw:unknown;
      try{raw=await signAndCheckinDraft(organizationId,{...input,requestId:progress.requestKey},record);}
      catch(error){
        // Gửi lại mà máy chủ báo trùng: lần ký cũ của bản nháp đã ghi (lệnh cũ tới sau lần đọc) với nội dung khác lần này.
        if(resend&&String((error as {code?:unknown}|null)?.code??'')==='23505'){
          const prior=await readContractDraftSigning(organizationId,target).then(snapshot=>snapshot.signing,()=>null);
          if(prior&&prior.draft_id===target)throw new FinancialAlreadyRecordedError(`Bản nháp đã được ghi nhận ký ở lần gửi trước (hợp đồng ${prior.contract_number}) với thông tin lúc đó. Tải lại bản nháp để xem kết quả.`,[prior.contract_id]);
        }
        throw error;
      }
      record(raw);
      const signing=contractSigningSchema.parse(raw);
      if(signing.organization_id!==organizationId||signing.draft_id!==target||signing.revision!==input.source.revision||signing.document_id!==input.source.documentId||signing.document_sha256!==input.source.documentSha256)throw new TypeError('Chưa xác nhận được đúng nguồn ký và hợp đồng chính thức.');
      return signing;
    },async(pending,progress)=>{
      const snapshot=await readContractDraftSigning(organizationId,target);
      if(snapshot.signing){
        const signing=contractSigningSchema.parse(snapshot.signing);
        if(signing.organization_id!==organizationId||signing.draft_id!==target)return null;
        if(signing.request_id===(pending.requestKey??pending.attemptId)){
          progress.completed.push({id:signing.contract_id,label:`Đã đối chiếu hợp đồng ${signing.contract_number}`});return {result:signing};
        }
        // Bản nháp đã được ký bởi một lần gửi khác (máy khác, hoặc một mã yêu cầu khác): lần này không ký nữa.
        return {outcome:'already-written',message:`Bản nháp đã được ghi nhận ký (hợp đồng ${signing.contract_number}). Tải lại bản nháp để xem kết quả.`,recordIds:[signing.contract_id]};
      }
      // Hàng rào biên nhận: lần trước đã nhận mã hợp đồng chính thức (biên nhận lệch nguồn) mà nay không thấy lần ký nào của
      // bản nháp. Không gửi lại; giữ dấu và mã để đối chiếu qua hộp cảnh báo.
      if(pending.completedIds.length)return null;
      resend=true;
      return {outcome:'not-written',serverDedupesRequestKey:true};
    },organizationId);
  },onSuccess:async signing=>{
    setPendingRequestId(null);queryClient.setQueryData(['contract-draft-signing',organizationId,signing.draft_id],(current:{server_today?:string}|undefined)=>({...current,signing}));
    await Promise.all(['contract-drafts','contracts','rooms','my-available-rooms','orphan-deposit-vouchers','room-reservations','contract-draft-signing','contract-exit-early-terms','sale-room-inventory','contract-commission-followups'].map(key=>queryClient.invalidateQueries({queryKey:[key]})));
    toast.success(`Đã ghi nhận ký và nhận phòng · ${signing.contract_number}`);
  },onError:error=>{
    // Từ chối rõ (kể cả «đã ghi nhận ở lần trước» và lần đối chiếu không thấy lần ký nào): dấu đã gỡ, nút ký không còn chờ.
    if(isConfirmedFinancialRejection(error))setPendingRequestId(null);
    toast.error(signingErrorMessage(error));
  }});
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
