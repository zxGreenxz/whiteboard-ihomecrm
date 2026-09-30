import { friendlyError } from '@/lib/friendlyError';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { deriveFinanceQueryState } from '@/lib/financeQueryState';

export interface RegionQuery {
  data: unknown;
  status: 'pending' | 'error' | 'success';
  fetchStatus: 'fetching' | 'paused' | 'idle';
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  dataUpdatedAt?: number;
  refetch: () => unknown;
}

/** Keep every required source explicit; missing data must not enter totals as zero. */
export function QueryRegion({ label, queries, children, loading }: {
  label: string;
  queries: readonly RegionQuery[];
  children: ReactNode;
  loading?: ReactNode;
}) {
  const states = queries.map(query => deriveFinanceQueryState(query,
    query.data === undefined && !query.isLoading && query.fetchStatus !== 'fetching' && query.fetchStatus !== 'paused' && !query.isError
      ? new Error('Required source has not been loaded') : null));
  const blocked = states.some(state => state.hasBlockingError);
  const stale = states.some(state => state.showStaleWarning);
  const pending = states.some(state => state.showLoading);
  const retry = () => { void Promise.allSettled(queries.map(query => Promise.resolve().then(() => query.refetch()))); };
  const timestamps = queries.map(query => query.dataUpdatedAt ?? 0).filter(time => time > 0);
  const lastRead = timestamps.length ? new Date(Math.min(...timestamps)).toLocaleString('vi-VN') : null;
  if (blocked) {
    const failure = states.find(state => state.hasBlockingError)?.blockingError;
    const feedback = friendlyError(failure, `Chưa tải được ${label}`, { operation: `xem ${label}` });
    return <div role="alert" className="rounded-md border border-destructive/40 p-4 text-sm">
      <p className="font-medium text-destructive">Chưa tải được {label}.</p>
      <p className="mt-1 text-muted-foreground">{feedback.recovery === "sign-in" ? "Phiên đăng nhập đã hết hạn. Đăng nhập lại để tiếp tục." : feedback.recovery === "contact-admin" && /quyền/i.test(feedback.description) ? feedback.description : "Chưa đủ dữ liệu để hiển thị kết quả. Hãy tải lại khu vực này để kiểm tra."}</p>
      <Button type="button" variant="outline" size="sm" className="mt-2" onClick={retry}>Tải lại</Button>
    </div>;
  }
  if (pending) return <>{loading ?? <p role="status" className="p-4 text-sm text-muted-foreground">Đang tải {label}…</p>}</>;
  return <>
    {stale && <div role="alert" className="mb-3 rounded-md border border-amber-400 p-3 text-sm">
      <p>Chưa cập nhật được {label}. {lastRead ? `Đang hiển thị kết quả tải lúc ${lastRead}.` : 'Đang hiển thị kết quả của lần tải trước.'}</p>
      <Button type="button" variant="outline" size="sm" className="mt-2" onClick={retry}>Tải lại</Button>
    </div>}
    {children}
  </>;
}
