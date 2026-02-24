import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { InvoiceStatus } from '@/types/invoice';

interface InvoiceStatusBadgeProps {
  status: InvoiceStatus;
}

const statusConfig: Record<
  InvoiceStatus,
  { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline'; className?: string }
> = {
  DRAFT: { label: 'Nháp', variant: 'outline', className: 'text-gray-600 border-gray-300' },
  APPROVED: { label: 'Đã duyệt', variant: 'default', className: 'bg-blue-600 hover:bg-blue-600/80' },
  PARTIAL_PAID: { label: 'Trả 1 phần', variant: 'secondary', className: 'bg-yellow-100 text-yellow-800 border-yellow-300 hover:bg-yellow-100/80' },
  PAID: { label: 'Đã thanh toán', variant: 'default', className: 'bg-green-600 hover:bg-green-600/80' },
  OVERDUE: { label: 'Quá hạn', variant: 'destructive', className: 'bg-red-600 hover:bg-red-600/80' },
  CANCELLED: { label: 'Đã huỷ', variant: 'destructive', className: 'bg-black hover:bg-black/80' },
};

const InvoiceStatusBadge = ({ status }: InvoiceStatusBadgeProps) => {
  const config = statusConfig[status] ?? statusConfig.DRAFT;

  return (
    <Badge variant={config.variant} className={cn(config.className)}>
      {config.label}
    </Badge>
  );
};

export default InvoiceStatusBadge;
