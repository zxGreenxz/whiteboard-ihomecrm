import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useOrganization } from '@/contexts/OrganizationContext';
import type { Database } from '@/integrations/supabase/types';
import {
  discardExitSettlementDraft, getExitSettlementDraft, listExitSettlementDrafts, saveExitSettlementDraft,
  type DiscardExitSettlementDraftInput, type ExitSettlementDraftRpcInvoker, type SaveExitSettlementDraftInput,
} from '@/lib/contractExitSettlementDrafts';

type Functions = Database['public']['Functions'];
// Literal RPC names preserve the normal generated-client boundary.
const invoke: ExitSettlementDraftRpcInvoker = (name, args) => {
  switch (name) {
    case 'get_contract_exit_settlement_draft_v1': return supabase.rpc('get_contract_exit_settlement_draft_v1', args as Functions['get_contract_exit_settlement_draft_v1']['Args']);
    case 'list_contract_exit_settlement_drafts_v1': return supabase.rpc('list_contract_exit_settlement_drafts_v1', args as Functions['list_contract_exit_settlement_drafts_v1']['Args']);
    case 'save_contract_exit_settlement_draft_v1': return supabase.rpc('save_contract_exit_settlement_draft_v1', args as Functions['save_contract_exit_settlement_draft_v1']['Args']);
    case 'discard_contract_exit_settlement_draft_v1': return supabase.rpc('discard_contract_exit_settlement_draft_v1', args as Functions['discard_contract_exit_settlement_draft_v1']['Args']);
  }
};
export const EXIT_SETTLEMENT_DRAFT_KEYS = ['contract-exit-settlement-draft', 'contract-exit-settlement-drafts'] as const;

/** Nháp đầy đủ của một hồ sơ — luôn đọc mới lúc mở hộp thoại (người khác có thể vừa lưu). */
export function useContractExitSettlementDraft(caseId?: string | null, enabled = true) {
  const { selectedOrganizationId } = useOrganization();
  return useQuery({
    queryKey: ['contract-exit-settlement-draft', selectedOrganizationId, caseId],
    queryFn: () => getExitSettlementDraft(invoke, caseId!, selectedOrganizationId!),
    enabled: enabled && !!caseId && !!selectedOrganizationId, retry: false, staleTime: 0, refetchOnMount: 'always',
    // Hộp thoại tự báo lỗi tại chỗ và khoá nút Lưu nháp; không thêm toast chung.
    meta: { errorDisplay: 'inline', label: 'bản nháp quyết toán' },
  });
}
/** Dấu "Có nháp" cho các hồ sơ đang hiện ở danh sách Chờ quyết toán. */
export function useContractExitSettlementDrafts(caseIds: string[]) {
  const { selectedOrganizationId } = useOrganization();
  const ids = [...caseIds].sort();
  return useQuery({
    queryKey: ['contract-exit-settlement-drafts', selectedOrganizationId, ids],
    queryFn: () => listExitSettlementDrafts(invoke, ids, selectedOrganizationId!),
    enabled: !!selectedOrganizationId && ids.length > 0, retry: false, refetchInterval: 60_000, refetchIntervalInBackground: false,
    // Chỉ là dấu hiệu "Có nháp": lỗi thì danh sách báo một dòng tại chỗ, không toast mỗi lần làm mới.
    meta: { errorDisplay: 'inline', label: 'dấu bản nháp quyết toán' },
  });
}
function useDraftMutation<Input, Output>(run: (input: Input, organizationId: string) => Promise<Output>) {
  const { selectedOrganizationId } = useOrganization();
  const cache = useQueryClient();
  return useMutation({
    mutationFn: (input: Input) => {
      if (!selectedOrganizationId) throw { code: '42501', message: 'Chưa chọn tổ chức' };
      return run(input, selectedOrganizationId);
    },
    retry: false,
    // Hộp thoại báo kết quả (kể cả hỏi ghi đè khi PT409); bộ báo lỗi chung không chen toast thứ hai.
    meta: { handlesFeedback: true },
    onSettled: () => Promise.all(EXIT_SETTLEMENT_DRAFT_KEYS.map(key => cache.invalidateQueries({ queryKey: [key] }))),
  });
}
export function useSaveContractExitSettlementDraft() {
  return useDraftMutation((input: SaveExitSettlementDraftInput, org: string) => saveExitSettlementDraft(invoke, input, org));
}
export function useDiscardContractExitSettlementDraft() {
  return useDraftMutation((input: DiscardExitSettlementDraftInput, org: string) => discardExitSettlementDraft(invoke, input, org));
}
