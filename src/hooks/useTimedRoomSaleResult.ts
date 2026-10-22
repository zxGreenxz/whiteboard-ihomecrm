import { useEffect, useState } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { nextPolicyReadBoundary, projectTimedRoomSaleRead, type TimedRoomSaleRead } from '@/lib/publicSalePolicyExpiry';

/** Keep the public reader's active text removable when a boundary refresh is
 * slow/offline. Upcoming content is never synthesized from a cached payload. */
export function useTimedRoomSaleResult(query: UseQueryResult<TimedRoomSaleRead, Error>) {
  const [, tick] = useState(0);
  const now = performance.now();
  const delay = query.data ? nextPolicyReadBoundary(query.data, now) : null;
  useEffect(() => {
    if (delay === null) return;
    const timer = setTimeout(() => { tick(value => value + 1); void query.refetch(); }, Math.min(2_147_000_000, Math.max(1, delay)));
    return () => clearTimeout(timer);
  }, [query.data, query.refetch, delay]);
  const readFresh = async () => {
    const fresh = await query.refetch();
    if (fresh.error || !fresh.data) throw new Error('Chưa xác minh được danh sách phòng mới nhất.');
    return projectTimedRoomSaleRead(fresh.data, performance.now());
  };
  return { ...query, data: query.data ? projectTimedRoomSaleRead(query.data, now) : undefined, readFresh };
}
