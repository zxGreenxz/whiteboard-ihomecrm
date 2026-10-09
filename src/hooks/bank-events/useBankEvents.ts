import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { useIsSuperAdmin } from '@/hooks/useIsAdmin';
import { bankEventService, type EventFilters } from '@/lib/bank-events/service';

export const bankEventKey = (actorId: string | null) => ['bank-events', actorId] as const;
export function useBankEvents(filters: EventFilters) {
  const auth = useAuth();
  const permission = useIsSuperAdmin();
  const actorId = auth.data?.id ?? null;
  const allowed = !!actorId && !auth.error && !permission.isError && !permission.isLoading && !permission.isPending && permission.data === true;
  const client = useQueryClient();
  useEffect(() => {
    const predicate = (query: { queryKey: readonly unknown[] }) => query.queryKey[0] === 'bank-events' && (!allowed || query.queryKey[1] !== actorId);
    void client.cancelQueries({ predicate });
    client.removeQueries({ predicate });
    return () => { void client.cancelQueries({ queryKey: bankEventKey(actorId) }); client.removeQueries({ queryKey: bankEventKey(actorId) }); };
  }, [actorId, allowed, client]);
  const key = bankEventKey(actorId);
  const common = { enabled: allowed, retry: false, gcTime: 0, staleTime: 15_000, meta: { errorDisplay: 'inline' } } as const;
  const events = useQuery({ ...common, queryKey: [...key, 'events', filters], queryFn: () => bankEventService(actorId!).events(filters) });
  const sources = useQuery({ ...common, queryKey: [...key, 'sources'], queryFn: () => bankEventService(actorId!).sources() });
  const status = useQuery({ ...common, queryKey: [...key, 'status'], queryFn: () => bankEventService(actorId!).status() });
  const refresh = () => client.invalidateQueries({ queryKey: key });
  return { actorId, allowed, events, sources, status, refresh };
}
