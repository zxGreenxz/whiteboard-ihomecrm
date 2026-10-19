import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { useIsSuperAdmin } from '@/hooks/useIsAdmin';
import { bankEventService, type EventFilters } from '@/lib/bank-events/service';
import { dayStartIso, vnDay } from '@/lib/bank-events/view';

/** Edge giới hạn 100 tin/lần: tổng hôm nay tính trên tối đa chừng đó tin mới nhất, nextCursor báo còn thiếu. */
export const TODAY_LIMIT = 100;
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
  const common = { enabled: allowed, retry: false, gcTime: 0, staleTime: 15_000, refetchInterval: 15_000, refetchIntervalInBackground: false, meta: { errorDisplay: 'inline' } } as const;
  const events = useQuery({ ...common, refetchInterval: filters.cursor ? false : 15_000, queryKey: [...key, 'events', filters], queryFn: () => bankEventService(actorId!).events(filters) });
  const sources = useQuery({ ...common, queryKey: [...key, 'sources'], queryFn: () => bankEventService(actorId!).sources() });
  const status = useQuery({ ...common, queryKey: [...key, 'status'], queryFn: () => bankEventService(actorId!).status() });
  // "Hôm nay" theo đồng hồ máy chủ (giờ Việt Nam): chờ trạng thái về rồi mới tải để không tải hai lần khi ngày máy người xem lệch;
  // trạng thái lỗi thì đành theo đồng hồ máy người xem.
  const day = vnDay(status.data?.serverTime ?? new Date().toISOString());
  const today = useQuery({ ...common, enabled: allowed && !status.isPending, queryKey: [...key, 'today', day], queryFn: () => bankEventService(actorId!).events({ from: dayStartIso(day), limit: TODAY_LIMIT }) });
  const refresh = () => client.invalidateQueries({ queryKey: key });
  return { actorId, allowed, day, events, sources, status, today, refresh };
}
