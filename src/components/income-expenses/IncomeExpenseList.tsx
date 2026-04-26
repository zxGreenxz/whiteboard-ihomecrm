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
import type { IncomeExpenseWithRelations } from '@/hooks/useIncomeExpenses';
import { Eye, Ban, Receipt } from 'lucide-react';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';

interface IncomeExpenseListProps {
  vouchers: IncomeExpenseWithRelations[];
  isLoading: boolean;
  onView: (voucher: IncomeExpenseWithRelations) => void;
  onCancel: (id: string) => void;
  pagination: PaginationState;
  totalCount: number;
}

const formatVND = (amount: number): string => {
  return amount.toLocaleString('vi-VN') + ' đ';
};

const IncomeExpenseList = ({
  vouchers,
  isLoading,
  onView,
  onCancel,
  pagination,
  totalCount,
}: IncomeExpenseListProps) => {
  const paginationInfo = useMemo(
    () => calculatePaginationInfo(pagination.page, pagination.pageSize, totalCount),
    [pagination.page, pagination.pageSize, totalCount],
  );

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (vouchers.length === 0) {
    return (
      <EmptyState
        icon={Receipt}
        title="Chưa có phiếu thu/chi nào"
        description="Hãy thêm phiếu đầu tiên để bắt đầu quản lý thu chi"
      />
    );
  }

  return (
    <div className="bg-white rounded-lg border border-zinc-200 overflow-hidden">
      <Table className="[&_th]:border-r [&_th]:border-b [&_th]:border-zinc-200 [&_td]:border-r [&_td]:border-b [&_td]:border-zinc-200 [&_tr>*:last-child]:border-r-0 [&_tbody_tr:last-child>td]:border-b-0">
        <TableHeader>
          <TableRow>
            <TableHead>Mã</TableHead>
            <TableHead>Thao tác</TableHead>
            <TableHead>Tên</TableHead>
            <TableHead className="text-right">Số tiền</TableHead>
            <TableHead>Tòa nhà</TableHead>
            <TableHead>Ngày thu/chi</TableHead>
            <TableHead>Người nhận/trả</TableHead>
            <TableHead>Sổ quỹ</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {vouchers.map((voucher) => {
            const isCancelled = voucher.approval_status === 'CANCELLED';

            return (
              <TableRow
                key={voucher.id}
                className={isCancelled ? 'opacity-60' : ''}
              >
                {/* Mã + Badge trạng thái */}
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span
                      className={`font-medium ${
                        isCancelled ? 'line-through' : ''
                      }`}
                    >
                      {voucher.code}
                    </span>
                    {isCancelled ? (
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

                {/* Thao tác */}
                <TableCell>
                  <div className="flex items-center gap-1">
                    {/* Xem chi tiết */}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-blue-500 hover:text-blue-600 hover:bg-blue-50"
                      onClick={() => onView(voucher)}
                      title="Xem chi tiết"
                    >
                      <Eye className="h-4 w-4" />
                    </Button>

                    {/* Huỷ phiếu (chỉ khi chưa huỷ) */}
                    {!isCancelled && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-red-500 hover:text-red-600 hover:bg-red-50"
                        onClick={() => onCancel(voucher.id)}
                        title="Huỷ phiếu"
                      >
                        <Ban className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </TableCell>

                {/* Tên */}
                <TableCell className="max-w-[200px] truncate">
                  {voucher.name}
                </TableCell>

                {/* Số tiền (có dấu + màu) */}
                <TableCell className="text-right">
                  <span
                    className={
                      voucher.type === 'INCOME'
                        ? 'text-green-600 font-medium'
                        : 'text-red-600 font-medium'
                    }
                  >
                    {voucher.type === 'INCOME' ? '+' : '-'}
                    {formatVND(voucher.total_amount)}
                  </span>
                </TableCell>

                {/* Tòa nhà + Phòng (sub-line) */}
                <TableCell>
                  {voucher.building_name ? (
                    <div className="flex flex-col leading-tight">
                      <span>{voucher.building_name}</span>
                      {voucher.room_name && (
                        <span className="text-xs text-muted-foreground">
                          {voucher.room_name}
                        </span>
                      )}
                    </div>
                  ) : (
                    '—'
                  )}
                </TableCell>

                {/* Ngày thu/chi */}
                <TableCell>
                  {voucher.voucher_date
                    ? format(new Date(voucher.voucher_date), 'dd/MM/yyyy', { locale: vi })
                    : '—'}
                </TableCell>

                {/* Người nhận/trả */}
                <TableCell>{voucher.payer_name || '—'}</TableCell>

                {/* Tài khoản */}
                <TableCell>{voucher.account_name || '—'}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {/* Phân trang */}
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

export default IncomeExpenseList;
