import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  RefreshCw,
  MoveRight,
  XCircle,
  CheckCircle,
  History,
} from 'lucide-react';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import type { ContractHistoryItem } from '@/components/contracts/detail/types';
import { formatCurrency } from './formatCurrency';

const getHistoryTypeLabel = (type: string) => {
  const labels: Record<string, string> = {
    extension: 'Gia hạn hợp đồng',
    transfer: 'Chuyển đổi',
    termination: 'Thanh lý',
  };
  return labels[type] || type;
};

const getHistoryTypeIcon = (type: string) => {
  switch (type) {
    case 'extension':
      return <RefreshCw className="h-4 w-4 text-blue-500" />;
    case 'transfer':
      return <MoveRight className="h-4 w-4 text-purple-500" />;
    case 'termination':
      return <XCircle className="h-4 w-4 text-red-500" />;
    default:
      return <History className="h-4 w-4 text-gray-500" />;
  }
};

interface ContractHistoryTabDesktopProps {
  history: ContractHistoryItem[];
  loading: boolean;
}

/** Tab "Lịch sử" (desktop) — tách nguyên văn từ ContractDetailView (Phase 10D).
 *  (Tên có hậu tố Desktop vì ContractHistoryTab.tsx là bản mobile.) */
export function ContractHistoryTabDesktop({ history, loading }: ContractHistoryTabDesktopProps) {
  const navigate = useNavigate();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Lịch sử thay đổi</CardTitle>
        <CardDescription>
          Các hoạt động gia hạn, chuyển đổi, thanh lý
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="text-center py-8 text-gray-500">
            Đang tải...
          </div>
        ) : history.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            Chưa có lịch sử thay đổi
          </div>
        ) : (
          <div className="space-y-4">
            {history.map((item) => (
              <div
                key={item.id}
                className="flex items-start gap-4 p-4 rounded-lg border bg-gray-50"
              >
                <div className="flex-shrink-0 mt-1">
                  {getHistoryTypeIcon(item.type)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium">{getHistoryTypeLabel(item.type)}</span>
                    <Badge
                      variant="outline"
                      className={`text-xs ${
                        item.status === 'PENDING_APPROVAL' ? 'bg-orange-100 text-orange-800 border-orange-300' :
                        item.status === 'APPROVED' || item.status === 'COMPLETED' ? 'bg-green-100 text-green-800 border-green-300' :
                        item.status === 'DRAFT' ? 'bg-gray-100 text-gray-800' : ''
                      }`}
                    >
                      {item.status === 'DRAFT' ? 'Nháp' :
                       item.status === 'PENDING_APPROVAL' ? 'Chờ duyệt' :
                       item.status === 'APPROVED' ? 'Đã duyệt' :
                       item.status === 'COMPLETED' ? 'Hoàn thành' :
                       item.status === 'CANCELLED' ? 'Đã hủy' :
                       item.status}
                    </Badge>
                  </div>
                  <div className="text-sm text-gray-600">
                    {format(new Date(item.created_at), 'dd/MM/yyyy HH:mm', { locale: vi })}
                  </div>
                  {item.type === 'extension' && item.details.extension_months && (
                    <div className="text-sm mt-1">
                      Gia hạn {item.details.extension_months} tháng
                      {item.details.new_rent_price && (
                        <> - Giá mới: {formatCurrency(item.details.new_rent_price)}</>
                      )}
                    </div>
                  )}
                  {item.type === 'transfer' && (
                    <div className="text-sm mt-1">
                      Loại: {item.details.transfer_type?.replace('_', ' ')}
                    </div>
                  )}
                  {item.type === 'termination' && (
                    <div className="text-sm mt-1">
                      Loại: {item.details.termination_type}
                      {item.details.actual_move_out_date && (
                        <> - Ngày trả căn hộ: {format(new Date(item.details.actual_move_out_date), 'dd/MM/yyyy', { locale: vi })}</>
                      )}
                      {(item.status === 'DRAFT' || item.status === 'PENDING_APPROVAL') && (
                        <div className="mt-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-blue-600 border-blue-300 hover:bg-blue-50"
                            onClick={() => navigate('/contracts?tab=termination-approvals')}
                          >
                            <CheckCircle className="h-3 w-3 mr-1" />
                            Đi đến duyệt thanh lý
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                  {item.details.notes && (
                    <div className="text-sm text-gray-500 mt-1">
                      Ghi chú: {item.details.notes}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
