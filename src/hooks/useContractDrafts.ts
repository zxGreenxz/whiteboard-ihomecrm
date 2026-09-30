import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOrganization } from '@/contexts/OrganizationContext';
import { toast } from 'sonner';
import { listContractDrafts, saveContractDraft, exportContractDraft, downloadContractDraftDocument, deleteContractDraft,
  type SaveContractDraftInput } from '@/lib/contractDraftApi';
import { draftErrorMessage, type ContractDraft, type ContractDraftDocument } from '@/lib/contractDrafts';
import type { DocumentTemplate } from '@/hooks/useDocumentTemplates';
import { downloadDocxBlob } from '@/lib/contractTemplateEngine';

export function useContractDrafts(buildingId?: string, enabled = true) {
  const { selectedOrganizationId } = useOrganization();
  return useQuery({ queryKey: ['contract-drafts', selectedOrganizationId, buildingId ?? null],
    enabled: enabled && !!selectedOrganizationId,
    queryFn: () => {
      if (!selectedOrganizationId) throw new Error('Chưa chọn tổ chức');
      return listContractDrafts(selectedOrganizationId, buildingId);
    },
  });
}
export function useSaveContractDraft() {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: (input: SaveContractDraftInput) => saveContractDraft(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['contract-drafts'] }),
    onError: error => toast.error(draftErrorMessage(error)),
  });
}
export function useDeleteContractDraft() {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: deleteContractDraft,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['contract-drafts'] });
      toast.success('Đã xóa bản nháp');
    },
  });
}
export function useExportContractDraft() {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: ({ draft, template }: { draft: ContractDraft; template: DocumentTemplate }) => exportContractDraft(draft, template),
    onSuccess: ({ blob, document }) => {
      downloadDocxBlob(blob, `BAN_NHAP_${document.draft_id.slice(0, 8)}_v${document.revision}`);
      toast.success(`Đã lưu bản nháp và chuẩn bị tệp BAN_NHAP_${document.draft_id.slice(0, 8)}_v${document.revision}.docx để tải xuống.`);
      return queryClient.invalidateQueries({ queryKey: ['contract-drafts'] });
    }, onError: error => toast.error(draftErrorMessage(error)),
  });
}
export function useDownloadContractDraftDocument() {
  return useMutation({ mutationFn: async (document: ContractDraftDocument) => {
    const blob = await downloadContractDraftDocument(document);
    downloadDocxBlob(blob, `BAN_NHAP_${document.draft_id.slice(0, 8)}_v${document.revision}`);
  }, onError: error => toast.error(draftErrorMessage(error)) });
}
