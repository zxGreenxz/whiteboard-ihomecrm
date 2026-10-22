import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useSession } from '@/hooks/useAuth';
import { roomSalePollingInterval } from '@/lib/roomSaleFacts';
import {
  fetchSaleRoomInventory, patchSaleRoom, SaleRoomOperationError, saleInventoryAtTime, saleInventoryClock, saleInventoryBoundaryDelay,
  type PatchSaleRoomInput, type SaleRoomRpcInvoker,
} from '@/lib/saleRoomOperations';

// Additive local RPC contract; generated types must be refreshed from the target
// schema after the reviewed migration, never edited manually.
const invoke: SaleRoomRpcInvoker = (name, args) => {
  // The new additive RPCs have an explicit validated boundary until target
  // schema generation is available. Avoid instantiating the entire generated
  // generic method through bind (which exceeds the strict compiler's depth).
  const rpc = supabase.rpc as unknown as SaleRoomRpcInvoker;
  return rpc.call(supabase, name, args);
};
export function useSaleRoomInventory() {
  const { selectedOrganizationId } = useOrganization();
  const { data: session } = useSession();
  const query = useQuery({
    queryKey: ['sale-room-inventory', selectedOrganizationId, session?.user.id],
    enabled: !!selectedOrganizationId && !!session?.user.id,
    queryFn: async () => {
      const started = performance.now();
      const data = await fetchSaleRoomInventory(invoke, selectedOrganizationId!);
      const receivedMonotonicMs = performance.now();
      return { ...data, readTiming: { receivedMonotonicMs, requestDurationMs: Math.max(0, receivedMonotonicMs - started) } };
    },
    staleTime: 5_000,
    retry: false,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
    refetchIntervalInBackground: false,
    refetchInterval: query => roomSalePollingInterval(query.state.error ? query.state.errorUpdateCount : 0),
  });
  const [, setBoundaryTick] = useState(0);
  const clock = query.data ? saleInventoryClock(query.data) : null;
  const data = query.data && clock ? saleInventoryAtTime(query.data, clock.lowerBoundMs, clock.upperBoundMs) : undefined;
  const boundaryDelay = query.data && clock ? saleInventoryBoundaryDelay(query.data, clock.lowerBoundMs, clock.upperBoundMs) : null;
  useEffect(() => {
    if (boundaryDelay === null) return;
    const delay = Math.min(2_147_000_000, Math.max(1, boundaryDelay));
    const timer = setTimeout(() => { setBoundaryTick(tick => tick + 1); void query.refetch(); }, delay);
    return () => clearTimeout(timer);
  }, [boundaryDelay, query.dataUpdatedAt, query.refetch]);
  return { ...query, data };
}
export function usePatchSaleRoom({ refreshAfterWrite = true }: { refreshAfterWrite?: boolean } = {}) {
  const { selectedOrganizationId } = useOrganization();
  const cache = useQueryClient();
  return useMutation({
    meta: { handlesFeedback: true },
    retry: false,
    mutationFn: (input: PatchSaleRoomInput) => {
      if (!selectedOrganizationId) throw new SaleRoomOperationError('Chưa chọn tổ chức.', 'rejected', '42501');
      return patchSaleRoom(invoke, selectedOrganizationId, input);
    },
    onSettled: refreshAfterWrite ? () => Promise.all([
      'sale-room-inventory', 'rooms', 'my-available-rooms', 'phong-trong', 'room-sale-locks',
    ].map(key => cache.invalidateQueries({ queryKey: [key] }))) : undefined,
  });
}
