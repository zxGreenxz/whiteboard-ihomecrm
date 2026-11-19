// Thông báo theo trạng thái sổ tổng (thay ghi chú cũ "chi lợi nhuận qua app đang tắt") + khối lỗi đọc sổ tổng
// dùng chung cho trang lợi nhuận của chủ (máy tính + điện thoại).

import { Info, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { profitLedgerErrorMessage } from '@/lib/profitLedger/errors';
import { profitLedgerRouteState } from '@/lib/profitLedger/route';
import { cn } from '@/lib/utils';

/** Không hiện gì khi chưa biết trạng thái (đang tải) hoặc sổ tổng đang chạy thật. */
export function ProfitLedgerRouteBanner({ route, className }: { route: unknown; className?: string }) {
  if (route === undefined) return null;
  const banner = profitLedgerRouteState(route).banner;
  if (!banner) return null;
  return (
    <p
      role="status"
      data-testid="profit-ledger-route-banner"
      className={cn(
        'flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12.5px] font-medium text-amber-900',
        className,
      )}
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{banner}</span>
    </p>
  );
}

/** Lỗi đọc sổ tổng tại chỗ: câu tiếng Việt từ mã máy + nút tải lại (không trả rỗng che lỗi). */
export function ProfitLedgerReadError({ error, onRetry, className }: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const info = profitLedgerErrorMessage(error, 'read');
  return (
    <div role="alert" className={cn('space-y-2 rounded-md border border-destructive/40 p-3 text-sm', className)}>
      <p className="font-medium text-destructive">{info.message}</p>
      {onRetry && info.kind !== 'FORBIDDEN' && (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />Tải lại
        </Button>
      )}
    </div>
  );
}
