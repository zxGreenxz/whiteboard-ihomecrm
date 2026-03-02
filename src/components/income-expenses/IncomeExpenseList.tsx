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
import { canEditVoucher } from '@/lib/incomeExpenseValidation';
import {
  CheckCircle,
  XCircle,
  Pencil,
  Trash2,
  Receipt,
} from 'lucide-react';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';

interface IncomeExpenseListProps {
  vouchers: IncomeExpenseWithRelations[];
  isLoading: boolean;
  onEdit: (voucher: IncomeExpenseWithRelations) => void;
  onDelete: (id: string) => void;
  onApprove: (id: string) => void;
  onUnapprove: (id: string) => void;
  pagination: PaginationState;
  totalCount: number;
}

const formatVND = (amount: number): string => {
  return amount.toLocaleString('vi-VN') + ' đ';
};

const IncomeExpenseList = ({
  vouchers,
  isLoading,
  onEdit,
  onDelete,
  onApprove,
  onUnapprove,
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
    <div className="bg-white rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Mã</TableHead>
            <TableHead>Thao tác</TableHead>
            <TableHead>Tên</TableHead>
            <TableHead className="text-right">Số tiền</TableHead>
            <TableHead>Tòa nhà</TableHead>
            <TableHead>Ngày thu/chi</TableHead>
            <TableHead>Người nhận/trả</TableHead>
            <TableHead>Tài khoản</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {vouchers.map((voucher) => {
            const isApproved = voucher.approval_status === 'APPROVED';
            const editable = canEditVoucher(voucher.approval_status);

            return (
              <TableRow key={voucher.id}>
                {/* Mã + Badge trạng thái */}
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{voucher.code}</span>
                    <Badge
                      variant={isApproved ? 'default' : 'secondary'}
                      className={
                        isApproved
                          ? 'bg-green-100 text-green-800 hover:bg-green-100'
                          : 'bg-amber-100 text-amber-800 hover:bg-amber-100'
                      }
                    >
                      {isApproved ? 'Đã duyệt' : 'Chưa duyệt'}
                    </Badge>
                  </div>
                </TableCell>

                {/* Thao tác - 3 icon buttons */}
                <TableCell>
                  <div className="flex items-center gap-1">
                    {/* Duyệt / Bỏ duyệt */}
                    {isApproved ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-orange-500 hover:text-orange-600 hover:bg-orange-50"
                        onClick={() => onUnapprove(voucher.id)}
                        title="Bỏ duyệt"
                      >
                        <XCircle className="h-4 w-4" />
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-green-500 hover:text-green-600 hover:bg-green-50"
                        onClick={() => onApprove(voucher.id)}
                        title="Duyệt"
                      >
                        <CheckCircle className="h-4 w-4" />
                      </Button>
                    )}

                    {/* Chỉnh sửa */}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-blue-500 hover:text-blue-600 hover:bg-blue-50"
                      disabled={!editable}
                      onClick={() => onEdit(voucher)}
                      title="Chỉnh sửa"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>

                    {/* Xóa */}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-red-500 hover:text-red-600 hover:bg-red-50"
                      disabled={!editable}
                      onClick={() => onDelete(voucher.id)}
                      title="Xóa"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
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

                {/* Tòa nhà */}
                <TableCell>{voucher.building_name || '—'}</TableCell>

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
