import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOrganization } from '@/contexts/OrganizationContext';
import { readContractCommissionFollowups, recordContractCommissionEvent,
  type CommissionFollowupFilter, type CommissionKind } from '@/lib/contractCommissionFollowup';

export const CONTRACT_COMMISSION_FOLLOWUP_KEY = 'contract-commission-followups';
export function useContractCommissionFollowups(filter: CommissionFollowupFilter) {
  const { selectedOrganizationId } = useOrganization();
  return useQuery({
    queryKey: [CONTRACT_COMMISSION_FOLLOWUP_KEY, selectedOrganizationId, filter.contractId ?? null,
      [...(filter.buildingIds ?? [])].sort(), filter.unresolvedOnly ?? !filter.contractId, filter.page ?? 0,
      filter.kind ?? null, filter.search?.trim() ?? null, filter.periodFrom ?? null, filter.periodTo ?? null],
    enabled: !!selectedOrganizationId && filter.enabled !== false,
    staleTime: 10000, refetchOnWindowFocus: true, refetchInterval: 30000,
    queryFn: () => {
      if (!selectedOrganizationId) throw new Error('Chưa xác định được tổ chức đang xem.');
      return readContractCommissionFollowups(selectedOrganizationId, filter);
    },
  });
}
export function useRecordContractCommissionEvent() {
  const { selectedOrganizationId } = useOrganization();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { contractId: string; kind: CommissionKind; action: 'NOT_APPLICABLE' | 'REOPENED'; reason?: string }) => {
      if (!selectedOrganizationId) throw new Error('Chưa xác định được tổ chức đang xử lý.');
      return recordContractCommissionEvent(selectedOrganizationId, { ...input, requestId: crypto.randomUUID() });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: [CONTRACT_COMMISSION_FOLLOWUP_KEY] }),
  });
}
