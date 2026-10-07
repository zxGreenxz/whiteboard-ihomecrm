import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useOrganization } from '@/contexts/OrganizationContext';
import { readResidenceHistory, readResidenceSummaries } from '@/lib/customerResidenceHistory';
export function useCustomerResidenceSummaries(customerIds: readonly string[]) {
  const { selectedOrganizationId } = useOrganization();
  const ids = [...new Set(customerIds)].sort();
  return useQuery({
    queryKey: ['customer-residence', 'summary', selectedOrganizationId, ids],
    enabled: !!selectedOrganizationId && ids.length > 0,
    queryFn: () => readResidenceSummaries(selectedOrganizationId!, ids),
    staleTime: 30000
  });
}
export function useCustomerResidenceHistory(customerId: string | null, open: boolean) {
  const { selectedOrganizationId } = useOrganization();
  return useInfiniteQuery({
    queryKey: ['customer-residence', 'history', selectedOrganizationId, customerId],
    enabled: open && !!customerId && !!selectedOrganizationId,
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => readResidenceHistory(selectedOrganizationId!, customerId!, pageParam),
    getNextPageParam: page => page.next_before_id ?? undefined,
    staleTime: 30000
  });
}
