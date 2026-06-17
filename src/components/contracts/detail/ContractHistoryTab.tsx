import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, MoveRight, XCircle, History } from 'lucide-react';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import { formatCurrency } from '@/lib/utils';
import type { ContractHistoryItem } from './types';

const TYPE_LABEL: Record<string, string> = {
  extension: 'Gia hạn hợp đồng', transfer: 'Chuyển đổi', termination: 'Thanh lý',
};
const ST_LABEL: Record<string, string> = {
  DRAFT: 'Nháp', PENDING_APPROVAL: 'Chờ duyệt', APPROVED: 'Đã duyệt', COMPLETED: 'Hoàn thành', CANCELLED: 'Đã hủy',
};
const ST_CLS: Record<string, string> = {
  PENDING_APPROVAL: 'bg-orange-100 text-orange-800', APPROVED: 'bg-green-100 text-green-800',
  COMPLETED: 'bg-green-100 text-green-800', DRAFT: 'bg-gray-100 text-gray-800',
};

function typeIcon(t: string) {
  if (t === 'extension') return <RefreshCw className="h-4 w-4 text-blue-500" />;
  if (t === 'transfer') return <MoveRight className="h-4 w-4 text-purple-500" />;
  if (t === 'termination') return <XCircle className="h-4 w-4 text-red-500" />;
  return <History className="h-4 w-4 text-gray-500" />;
}

/** Tab "Lịch sử" — gia hạn / chuyển đổi / thanh lý dạng thẻ dọc. */
export function ContractHistoryTab({ history }: { history: ContractHistoryItem[] }) {
  if (!history.length) {
    return <div className="text-center py-10 text-sm text-muted-foreground">Chưa có lịch sử thay đổi</div>;
  }
  return (
    <div className="space-y-2.5">
      {history.map((item) => (
        <Card key={item.id}>
          <CardContent className="p-3 flex items-start gap-3">
            <div className="mt-0.5 shrink-0">{typeIcon(item.type)}</div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{TYPE_LABEL[item.type] ?? item.type}</span>
                <Badge variant="outline" className={`text-[10px] ${ST_CLS[item.status] ?? ''}`}>
                  {ST_LABEL[item.status] ?? item.status}
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground">
                {format(new Date(item.created_at), 'dd/MM/yyyy HH:mm', { locale: vi })}
              </div>
              {item.type === 'extension' && item.details.extension_months && (
                <div className="text-sm mt-1">
                  Gia hạn {item.details.extension_months} tháng
                  {item.details.new_rent_price ? <> · Giá mới {formatCurrency(item.details.new_rent_price)}</> : null}
                </div>
              )}
              {item.type === 'transfer' && (
                <div className="text-sm mt-1">Loại: {String(item.details.transfer_type || '').replace('_', ' ')}</div>
              )}
              {item.type === 'termination' && (
                <div className="text-sm mt-1">
                  Loại: {item.details.termination_type}
                  {item.details.actual_move_out_date
                    ? <> · Trả phòng {format(new Date(item.details.actual_move_out_date), 'dd/MM/yyyy', { locale: vi })}</>
                    : null}
                </div>
              )}
              {item.details.notes && (
                <div className="text-xs text-muted-foreground mt-1">Ghi chú: {item.details.notes}</div>
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
