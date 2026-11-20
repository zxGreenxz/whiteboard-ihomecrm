import { useQuery } from '@tanstack/react-query';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { readRoomTransferQuote, type RoomTransferQuoteInput } from '@/lib/contract-lifecycle/roomTransferQuote';

export function useRoomTransferQuote(input: RoomTransferQuoteInput | null) {
  const { selectedOrganizationId } = useOrganization();
  const ready = useDebouncedValue(input, 250);
  const current = !!input && input === ready;
  const query = useQuery({
    queryKey: ['room-transfer-preview', selectedOrganizationId, ready],
    enabled: !!selectedOrganizationId && current,
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
    queryFn: () => {
      if (!selectedOrganizationId || !ready) throw new Error('Chưa chọn tổ chức hoặc phòng mới.');
      return readRoomTransferQuote(selectedOrganizationId, ready);
    },
  });
  return {
    data: current && !query.isFetching && !query.isError ? query.data : undefined,
    isError: current && query.isError, error: query.error,
    refetch: query.refetch,
  };
}
