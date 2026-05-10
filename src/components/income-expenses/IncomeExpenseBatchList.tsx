import { useMemo } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTablePagination } from '@/components/ui/data-table-pagination';
import EmptyState from '@/components/ui/EmptyState';
import {
  calculatePaginationInfo,
  type PaginationState,
} from '@/hooks/usePagination';
import type { IncomeExpenseBatchSummary } from '@/hooks/useIncomeExpenses';
import { Eye, Ban, Layers } from 'lucide-react';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';

interface IncomeExpenseBatchListProps {
  batches: IncomeExpenseBatchSummary[];
  isLoading: boolean;
  onView: (batchId: string) => void;
  onCancel: (batchId: string) => void;
  pagination: PaginationState;
  totalCount: number;
}

const formatVND = (amount: number): string =>
  amount.toLocaleString('vi-VN') + ' đ';

const IncomeExpenseBatchList = ({
  batches,
  isLoading,
  onView,
  onCancel,
  pagination,
  totalCount,
}: IncomeExpenseBatchListProps) => {
  const paginationInfo = useMemo(
    () =>
      calculatePaginationInfo(
        pagination.page,
        pagination.pageSize,
        totalCount
      ),
    [pagination.page, pagination.pageSize, totalCount]
  );

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    );
  }

  if (batches.length === 0) {
    return (
      <EmptyState
        icon={Layers}
        title="Chưa có phiếu tổng nào"
        description='Ấn "Thêm phiếu" → "Phiếu tổng" để gom nhiều phiếu lẻ trong 1 lần thanh toán.'
      />
    );
  }

  return (
    <div className="bg-white rounded-lg border border-zinc-200 overflow-hidden">
      <Table className="[&_th]:border-r [&_th]:border-b [&_th]:border-zinc-200 [&_td]:border-r [&_td]:border-b [&_td]:border-zinc-200 [&_tr>*:last-child]:border-r-0 [&_tbody_tr:last-child>td]:border-b-0">
        <TableHeader>
          <TableRow>
            <TableHead>Đợt</TableHead>
            <TableHead>Thao tác</TableHead>
            <TableHead>Tên đợt</TableHead>
            <TableHead className="text-right">Tổng tiền</TableHead>
            <TableHead>Tòa nhà</TableHead>
            <TableHead>Ngày</TableHead>
            <TableHead>Người nhận/nộp</TableHead>
            <TableHead>Sổ quỹ</TableHead>
            <TableHead className="text-center">Số phiếu</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {batches.map((batch) => {
            const firstCode = batch.vouchers[0]?.code ?? '—';
            const showPlus = batch.voucher_count > 1;

            return (
              <TableRow
                key={batch.id}
                className={batch.all_cancelled ? 'opacity-60' : ''}
              >
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span
                      className={`font-medium ${
                        batch.all_cancelled ? 'line-through' : ''
                      }`}
                    >
                      {firstCode}
                    </span>
                    {showPlus && (
                      <Badge
                        variant="outline"
                        className="text-[10px] px-1.5 py-0"
                      >
                        +{batch.voucher_count - 1}
                      </Badge>
                    )}
                    {batch.all_cancelled ? (
                      <Badge
                        variant="secondary"
                        className="bg-red-100 text-red-700 hover:bg-red-100"
                      >
                        Đã huỷ
                      </Badge>
                    ) : (
                      <Badge
                        variant="default"
                        className="bg-green-100 text-green-800 hover:bg-green-100"
                      >
                        Đã ghi nhận
                      </Badge>
                    )}
                  </div>
                </TableCell>

                <TableCell>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-blue-500 hover:text-blue-600 hover:bg-blue-50"
                      onClick={() => onView(batch.id)}
                      title="Xem chi tiết đợt"
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
                    {batch.has_approved && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-red-500 hover:text-red-600 hover:bg-red-50"
                        onClick={() => onCancel(batch.id)}
                        title="Huỷ cả đợt"
                      >
                        <Ban className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </TableCell>

                <TableCell className="max-w-[240px] truncate">
                  {batch.name}
                </TableCell>

                <TableCell className="text-right">
                  <span
                    className={
                      batch.type === 'INCOME'
                        ? 'text-green-600 font-medium'
                        : 'text-red-600 font-medium'
                    }
                  >
                    {batch.type === 'INCOME' ? '+' : '-'}
                    {formatVND(batch.total_amount)}
                  </span>
                </TableCell>

                <TableCell>
                  {batch.building_names.length > 0 ? (
                    <div className="flex flex-col leading-tight">
                      <span>
                        {batch.building_names.slice(0, 2).join(', ')}
                      </span>
                      {batch.building_names.length > 2 && (
                        <span className="text-xs text-muted-foreground">
                          ...+{batch.building_names.length - 2} tòa khác
                        </span>
                      )}
                    </div>
                  ) : (
                    '—'
                  )}
                </TableCell>

                <TableCell>
                  {batch.voucher_date
                    ? format(new Date(batch.voucher_date), 'dd/MM/yyyy', {
                        locale: vi,
                      })
                    : '—'}
                </TableCell>

                <TableCell>{batch.payer_name || '—'}</TableCell>

                <TableCell>{batch.account_name || '—'}</TableCell>

                <TableCell className="text-center">
                  <Badge variant="outline">{batch.voucher_count}</Badge>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <DataTablePagination
        paginationInfo={paginationInfo}
        onPageChange={pagination.setPage}
        onPageSizeChange={pagination.setPageSize}
        showPageSizeSelector
        showItemCount
      />
    </div>
  );
};

export default IncomeExpenseBatchList;
