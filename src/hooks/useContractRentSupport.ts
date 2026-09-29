import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOrganization } from '@/contexts/OrganizationContext';
import { quoteContractRentSupport, readContractRentSupport, reviseContractRentSupport,
  type SupportQuoteInput, type SupportReadFilter, type SupportReviseInput } from '@/lib/rentSupportApi';
export const CONTRACT_RENT_SUPPORT_KEY = 'contract-rent-support';
export function useContractRentSupport(filter: SupportReadFilter = {}) {
  const { selectedOrganizationId } = useOrganization();
  return useQuery({ queryKey: [CONTRACT_RENT_SUPPORT_KEY, selectedOrganizationId, filter],
    enabled: !!selectedOrganizationId && filter.enabled !== false,
    queryFn: () => {
      if (!selectedOrganizationId) throw new Error('Chưa xác định tổ chức.');
      return readContractRentSupport(selectedOrganizationId, filter);
    },
  });
}
export function useQuoteContractRentSupport() {
  const { selectedOrganizationId } = useOrganization();
  return useMutation({ mutationFn: (input: SupportQuoteInput) => {
    if (!selectedOrganizationId) throw new Error('Chưa xác định tổ chức.');
    return quoteContractRentSupport(selectedOrganizationId, input);
  } });
}
export function useReviseContractRentSupport() {
  const { selectedOrganizationId } = useOrganization();
  const cache = useQueryClient();
  return useMutation({ mutationFn: (input: SupportReviseInput) => {
    if (!selectedOrganizationId) throw new Error('Chưa xác định tổ chức.');
    // Caller retains requestId over a retry; do not mint another financial intent here.
    return reviseContractRentSupport(selectedOrganizationId, input);
  }, onSettled: () => cache.invalidateQueries({ queryKey: [CONTRACT_RENT_SUPPORT_KEY] }) });
}
