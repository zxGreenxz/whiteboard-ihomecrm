import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface StockBadgeProps {
  onHand: number;
  reorderLevel?: number;
  unit?: string;
  className?: string;
}

export function StockBadge({ onHand, reorderLevel = 0, unit = '', className }: StockBadgeProps) {
  const low = onHand <= reorderLevel;
  const zero = onHand <= 0;
  const formatted = Number(onHand).toLocaleString('vi-VN', { maximumFractionDigits: 2 });
  return (
    <Badge
      variant={zero ? 'destructive' : low ? 'secondary' : 'outline'}
      className={cn(
        zero ? 'bg-red-600 text-white' : low ? 'bg-amber-100 text-amber-900 border-amber-300' : '',
        'font-medium',
        className,
      )}
    >
      {zero
        ? `Hết hàng`
        : low
          ? `Sắp hết: ${formatted}${unit ? ' ' + unit : ''} / ngưỡng ${reorderLevel}`
          : `Còn ${formatted}${unit ? ' ' + unit : ''}`}
    </Badge>
  );
}
