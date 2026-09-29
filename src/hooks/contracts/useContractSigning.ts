import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOrganization } from '@/contexts/OrganizationContext';
import { readContractDraftSigning, signAndCheckinDraft, getOrCreateSignedContractDocument } from '@/lib/contractSigningApi';
import { signingErrorMessage, type ContractSigningInput, type ContractSigning } from '@/lib/contractSigning';
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
export function useContractSigning(organizationId: string) {
  const { selectedOrganizationId } = useOrganization();
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: (input: ContractSigningInput) => {
    if (!selectedOrganizationId || selectedOrganizationId !== organizationId) throw new Error('Tổ chức đang chọn đã đổi. Mở lại bản nháp.');
    return signAndCheckinDraft(selectedOrganizationId, input);
  }, onSuccess: async signing => {
    queryClient.setQueryData(['contract-draft-signing', organizationId, signing.draft_id], (current: { server_today?: string } | undefined) => ({ ...current, signing }));
    await Promise.all(['contract-drafts', 'contracts', 'rooms', 'my-available-rooms', 'room-reservations', 'contract-draft-signing', 'contract-commission-followups'].map(key => queryClient.invalidateQueries({ queryKey: [key] })));
    toast.success(`Đã ghi nhận ký và nhận phòng · ${signing.contract_number}`);
  }, onError: error => toast.error(signingErrorMessage(error)) });
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
