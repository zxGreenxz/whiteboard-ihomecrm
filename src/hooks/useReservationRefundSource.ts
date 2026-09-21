import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { useOrganization } from '@/contexts/OrganizationContext';
import { reservationRefundRepository } from '@/lib/reservationRefundRepository';
import type { ReservationRefundSourceRef } from '@/lib/reservationRefundWorkflow';

/** Read-only, actor-scoped source facts used after a reservation refund voucher exists. */
export function useReservationRefundSource(sourceRef: ReservationRefundSourceRef) {
  const { data: actor } = useAuth();
  const { selectedOrganizationId } = useOrganization();
  const actorId = actor?.id ?? '';
  const organizationId = selectedOrganizationId ?? '';
  const repository = useMemo(
    () => reservationRefundRepository(actorId, organizationId),
    [actorId, organizationId],
  );
  const enabled = !!actorId && organizationId === sourceRef.organizationId;
  const query = useQuery({
    queryKey: ['reservation-refund-workflow', actorId, organizationId, sourceRef],
    enabled,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: 'always',
    refetchInterval: 30_000,
    queryFn: () => repository.readSource(sourceRef),
  });
  return {
    ...query,
    data: enabled && !query.isError ? query.data : undefined,
    enabled,
  };
}
