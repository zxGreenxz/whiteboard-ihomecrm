import { useEffect, useState, type CSSProperties } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Cách hiển thị lúc chờ dữ liệu — chủ chốt 02/10/2026 (canvas "Thời gian chờ hiển thị dữ liệu"):
 *   1. Chưa có dữ liệu: khung trang hiện ngay, chỗ dữ liệu là khối xám đúng hình thật.
 *   2. Có một phần: hiện ngay phần đã có, ô còn thiếu là vạch xám nhỏ ngay trong ô.
 *   3. Đang làm mới dữ liệu đã có: giữ nguyên nội dung, chỉ một vạch mảnh ở mép trên.
 *   4. Chậm bất thường (quá 8 giây) mới có một dòng nhẹ "Mạng đang chậm" kèm Thử lại.
 * Không hiện chữ "Đang tải…" trên màn hình; chữ đó chỉ còn cho trình đọc màn hình
 * (sr-only trong role="status"). Khối xám chỉ hiện sau 0,3 giây (lớp CSS `ld-appear`)
 * để dữ liệu về nhanh thì màn hình không chớp.
 */

/** Khối xám hiện sau chừng này — khớp `animation-delay` của `.ld-appear` trong index.css. */
export const LOADING_APPEAR_DELAY_MS = 300;
/** Quá chừng này mới báo mạng chậm. */
export const LOADING_SLOW_AFTER_MS = 8000;

export type LoadingVariant = 'lines' | 'list' | 'table' | 'cards' | 'detail' | 'inline' | 'none';

/** Độ dài lệch nhau cho giống chữ thật. */
const WIDTHS = ['92%', '76%', '84%', '64%', '88%', '70%'];
const CARD_WIDTHS = ['62%', '54%', '70%', '58%', '66%'];

/** Một vạch xám giữ chỗ — chỉ để nhìn, trình đọc màn hình bỏ qua. */
export function SkeletonBar({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <span
      aria-hidden="true"
      className={cn('ld-sk block h-3.5 animate-pulse rounded-md bg-muted', className)}
      style={style}
    />
  );
}

/** true sau `ms` kể từ khi mount (và còn `active`). */
export function useSlowFlag(active: boolean, ms: number = LOADING_SLOW_AFTER_MS): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!active) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return active && slow;
}

/** Dòng báo mạng chậm (quy tắc 4). */
export function SlowNotice({ onRetry, className }: { onRetry?: () => void; className?: string }) {
  return (
    <div className={cn('ld-slow mt-2 flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground', className)}>
      <span className="flex-1">Mạng đang chậm, vẫn đang tải.</span>
      {onRetry && (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Thử lại
        </Button>
      )}
    </div>
  );
}

function Skeleton({ variant, rows }: { variant: Exclude<LoadingVariant, 'inline' | 'none'>; rows?: number }) {
  if (variant === 'list') {
    return (
      <div className="flex flex-col gap-2.5">
        {Array.from({ length: rows ?? 4 }, (_, i) => (
          <div key={i} className="ld-card flex items-center gap-3 rounded-xl border bg-card p-3.5">
            <SkeletonBar className="h-10 w-10 shrink-0 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <SkeletonBar style={{ width: CARD_WIDTHS[i % CARD_WIDTHS.length] }} />
              <SkeletonBar className="h-3" style={{ width: '38%' }} />
            </div>
            <SkeletonBar className="h-5 w-14 rounded-full" />
          </div>
        ))}
      </div>
    );
  }
  if (variant === 'table') {
    return (
      <div className="flex flex-col">
        {Array.from({ length: rows ?? 5 }, (_, i) => (
          <div key={i} className="grid grid-cols-[1fr_2fr_1fr_1fr] items-center gap-4 border-b px-3 py-3 last:border-b-0">
            <SkeletonBar style={{ width: '70%' }} />
            <SkeletonBar style={{ width: WIDTHS[i % WIDTHS.length] }} />
            <SkeletonBar style={{ width: '60%' }} />
            <SkeletonBar style={{ width: '50%' }} />
          </div>
        ))}
      </div>
    );
  }
  if (variant === 'cards') {
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {Array.from({ length: rows ?? 3 }, (_, i) => (
          <div key={i} className="ld-card flex flex-col gap-2.5 rounded-xl border bg-card p-4">
            <SkeletonBar className="h-3" style={{ width: '45%' }} />
            <SkeletonBar className="h-6" style={{ width: '70%' }} />
          </div>
        ))}
      </div>
    );
  }
  if (variant === 'detail') {
    return (
      <div className="flex flex-col overflow-hidden rounded-xl border">
        {Array.from({ length: rows ?? 6 }, (_, i) => (
          <div key={i} className="grid grid-cols-[minmax(6rem,30%)_1fr] items-center gap-4 border-b px-3 py-3 last:border-b-0">
            <SkeletonBar style={{ width: '70%' }} />
            <SkeletonBar style={{ width: WIDTHS[i % WIDTHS.length] }} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2.5">
      {Array.from({ length: rows ?? 3 }, (_, i) => (
        <SkeletonBar key={i} style={{ width: WIDTHS[i % WIDTHS.length] }} />
      ))}
    </div>
  );
}

/** Ô chờ nhỏ nằm ngay trong ô dữ liệu (quy tắc 2). */
export function InlineSkeleton({ label, width = '7rem', className }: { label: string; width?: string; className?: string }) {
  return (
    <span role="status" className={cn('inline-flex max-w-full align-middle', className)}>
      <span className="sr-only">Đang tải {label}…</span>
      <span className="ld-appear inline-flex max-w-full" aria-hidden="true">
        <SkeletonBar className="inline-block" style={{ width }} />
      </span>
    </span>
  );
}

/**
 * Vùng đang chờ dữ liệu (quy tắc 1 và 4). `variant` chọn hình khối xám cho gần với nội
 * dung thật; `none` chỉ báo cho trình đọc màn hình — dùng cho vùng chỉ để theo dõi trạng thái.
 */
export function LoadingState({
  label,
  variant = 'lines',
  rows,
  onRetry,
  className,
}: {
  label: string;
  variant?: LoadingVariant;
  rows?: number;
  onRetry?: () => void;
  className?: string;
}) {
  const slow = useSlowFlag(variant !== 'none' && variant !== 'inline');
  if (variant === 'inline') return <InlineSkeleton label={label} className={className} />;
  if (variant === 'none') {
    return (
      <span role="status" className="sr-only">
        Đang tải {label}…
      </span>
    );
  }
  return (
    <div role="status" className={cn('py-2', className)}>
      <span className="sr-only">Đang tải {label}…</span>
      <div className="ld-appear" aria-hidden="true">
        <Skeleton variant={variant} rows={rows} />
      </div>
      {slow && <SlowNotice onRetry={onRetry} />}
    </div>
  );
}

/**
 * Vạch mảnh chạy ở mép trên khi đang làm mới dữ liệu đã hiển thị (quy tắc 3). Đặt trong
 * khung có `position: relative` (hộp thoại shadcn đã là `fixed`, đủ làm khung).
 */
export function RefreshBar({ active, label = 'Đang cập nhật' }: { active: boolean; label?: string }) {
  if (!active) return null;
  return (
    <div role="status" className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden">
      <span className="sr-only">{label}</span>
      <div className="ld-appear h-full w-full" aria-hidden="true">
        <div className="ld-bar h-full w-1/3 rounded-full bg-primary" />
      </div>
    </div>
  );
}
