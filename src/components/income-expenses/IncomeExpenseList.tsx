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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { DataTablePagination } from '@/components/ui/data-table-pagination';
import EmptyState from '@/components/ui/EmptyState';
import {
  calculatePaginationInfo,
  type PaginationState,
} from '@/hooks/usePagination';
import type { IncomeExpenseWithRelations } from '@/hooks/useIncomeExpenses';
import { canEditVoucher } from '@/lib/incomeExpenseValidation';
import {
  MoreHorizontal,
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
            <TableHead>Mã phiếu</TableHead>
            <TableHead>Ngày</TableHead>
            <TableHead>Loại</TableHead>
            <TableHead>Tên phiếu</TableHead>
            <TableHead>Căn hộ</TableHead>
            <TableHead>Phòng</TableHead>
            <TableHead>Khách hàng</TableHead>
            <TableHead className="text-right">Tổng tiền</TableHead>
            <TableHead>Thao tác</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {vouchers.map((voucher) => {
            const isApproved = voucher.approval_status === 'APPROVED';
            const editable = canEditVoucher(voucher.approval_status);

            return (
              <TableRow key={voucher.id}>
                {/* Mã phiếu + Badge trạng thái */}
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

                {/* Ngày */}
                <TableCell>
                  {voucher.voucher_date
                    ? format(new Date(voucher.voucher_date), 'dd/MM/yyyy', { locale: vi })
                    : '—'}
                </TableCell>

                {/* Loại (Thu/Chi badge) */}
                <TableCell>
                  <Badge
                    variant="outline"
                    className={
                      voucher.type === 'INCOME'
                        ? 'bg-green-100 text-green-800 border-green-200'
                        : 'bg-red-100 text-red-800 border-red-200'
                    }
                  >
                    {voucher.type === 'INCOME' ? 'Phiếu thu' : 'Phiếu chi'}
                  </Badge>
                </TableCell>

                {/* Tên phiếu */}
                <TableCell className="max-w-[200px] truncate">
                  {voucher.name}
                </TableCell>

                {/* Căn hộ */}
                <TableCell>{voucher.building_name || '—'}</TableCell>

                {/* Phòng */}
                <TableCell>{voucher.room_name || '—'}</TableCell>

                {/* Khách hàng */}
                <TableCell>{voucher.tenant_name || '—'}</TableCell>

                {/* Tổng tiền (format VND) */}
                <TableCell className="text-right">
                  <span
                    className={
                      voucher.type === 'INCOME'
                        ? 'text-green-600 font-medium'
                        : 'text-red-600 font-medium'
                    }
                  >
                    {formatVND(voucher.total_amount)}
                  </span>
                </TableCell>

                {/* Thao tác */}
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuLabel>Thao tác</DropdownMenuLabel>
                      <DropdownMenuSeparator />

                      {/* Duyệt / Bỏ duyệt */}
                      {isApproved ? (
                        <DropdownMenuItem onClick={() => onUnapprove(voucher.id)}>
                          <XCircle className="h-4 w-4 mr-2" />
                          Bỏ duyệt
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem onClick={() => onApprove(voucher.id)}>
                          <CheckCircle className="h-4 w-4 mr-2 text-green-600" />
                          Duyệt
                        </DropdownMenuItem>
                      )}

                      {/* Cập nhật - disabled khi APPROVED */}
                      <DropdownMenuItem
                        disabled={!editable}
                        onClick={() => onEdit(voucher)}
                      >
                        <Pencil className="h-4 w-4 mr-2" />
                        Cập nhật
                      </DropdownMenuItem>

                      {/* Xoá - disabled khi APPROVED */}
                      <DropdownMenuItem
                        disabled={!editable}
                        className={editable ? 'text-red-600' : ''}
                        onClick={() => onDelete(voucher.id)}
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Xoá
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
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
