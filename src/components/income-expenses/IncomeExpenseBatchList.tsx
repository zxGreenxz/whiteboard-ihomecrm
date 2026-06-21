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
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTablePagination } from '@/components/ui/data-table-pagination';
import EmptyState from '@/components/ui/EmptyState';
import {
  calculatePaginationInfo,
  type PaginationState,
} from '@/hooks/usePagination';
import type { IncomeExpenseBatchSummary } from '@/hooks/useIncomeExpenses';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import {
  BATCH_COLUMNS,
  useBatchColumnVisibility,
} from './batchListColumns';
import { Eye, Ban, Layers, Pencil, LayoutGrid } from 'lucide-react';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';

interface IncomeExpenseBatchListProps {
  batches: IncomeExpenseBatchSummary[];
  isLoading: boolean;
  onView: (batchId: string) => void;
  onCancel: (batchId: string) => void;
  /** Mở dialog chi tiết đợt ở chế độ "sửa nhanh" — Super Admin (cho phép
   *  chỉnh sửa từng phiếu con bên trong đợt). */
  onEdit?: (batchId: string) => void;
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
  onEdit,
  pagination,
  totalCount,
}: IncomeExpenseBatchListProps) => {
  const { data: isAdmin = false } = useIsAdmin();
  const {
    visibility: cols,
    toggle: toggleColumn,
    reset: resetColumns,
  } = useBatchColumnVisibility();
  const visibleCount = BATCH_COLUMNS.filter((c) => cols[c.key]).length;
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
      {/* Thanh công cụ: nút ẩn/hiện cột */}
      <div className="flex items-center justify-end px-3 py-2 border-b border-zinc-200">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 gap-1.5">
              <LayoutGrid className="h-4 w-4" />
              Cột
              <span className="text-xs text-muted-foreground">
                {visibleCount}/{BATCH_COLUMNS.length}
              </span>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-60 p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-medium">Hiển thị cột</div>
              <div className="text-xs text-muted-foreground">
                {visibleCount}/{BATCH_COLUMNS.length}
              </div>
            </div>
            <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
              {BATCH_COLUMNS.map((col) => (
                <Label
                  key={col.key}
                  htmlFor={`batch-col-${col.key}`}
                  className="flex items-center gap-2 py-1 px-1 rounded hover:bg-accent cursor-pointer text-sm font-normal"
                >
                  <Checkbox
                    id={`batch-col-${col.key}`}
                    checked={cols[col.key]}
                    onCheckedChange={() => toggleColumn(col.key)}
                  />
                  <span>{col.label}</span>
                </Label>
              ))}
            </div>
            <div className="mt-3 pt-2 border-t flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={resetColumns}
              >
                Đặt lại mặc định
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <Table className="[&_th]:border-r [&_th]:border-b [&_th]:border-zinc-200 [&_td]:border-r [&_td]:border-b [&_td]:border-zinc-200 [&_tr>*:last-child]:border-r-0 [&_tbody_tr:last-child>td]:border-b-0">
        <TableHeader>
          <TableRow>
            {cols.code && <TableHead>Đợt</TableHead>}
            <TableHead>Thao tác</TableHead>
            <TableHead>Tên đợt</TableHead>
            {cols.amount && <TableHead className="text-right">Tổng tiền</TableHead>}
            {cols.building && <TableHead>Tòa nhà</TableHead>}
            {cols.room && <TableHead>Phòng</TableHead>}
            {cols.date && <TableHead>Ngày</TableHead>}
            {cols.payer && <TableHead>Người nhận/nộp</TableHead>}
            {cols.account && <TableHead>Sổ quỹ</TableHead>}
            {cols.count && <TableHead className="text-center">Số phiếu</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {batches.map((batch) => {
            const firstCode = batch.vouchers[0]?.code ?? '—';
            const showPlus = batch.voucher_count > 1;
            // Gộp tên phòng từ các phiếu con (1 đợt có thể nhiều phòng).
            const roomNames = Array.from(
              new Set(
                batch.vouchers
                  .map((v) => v.room_name)
                  .filter((n): n is string => !!n)
              )
            );

            const statusBadge = batch.all_cancelled ? (
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
            );

            return (
              <TableRow
                key={batch.id}
                className={batch.all_cancelled ? 'opacity-60' : ''}
              >
                {cols.code && (
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
                    </div>
                  </TableCell>
                )}

                <TableCell>
                  <div className="flex items-center gap-1 flex-wrap">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-blue-500 hover:text-blue-600 hover:bg-blue-50"
                      onClick={() => onView(batch.id)}
                      title="Xem chi tiết đợt"
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
                    {isAdmin && onEdit && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                        onClick={() => onEdit(batch.id)}
                        title="Sửa phiếu trong đợt (Super Admin)"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    )}
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
                    {/* Trạng thái — chuyển từ cột mã phiếu sang đây để vẫn thấy
                        khi ẩn cột Đợt */}
                    {statusBadge}
                  </div>
                </TableCell>

                <TableCell className="max-w-[240px] truncate">
                  {batch.name}
                </TableCell>

                {cols.amount && (
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
                )}

                {cols.building && (
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
                )}

                {cols.room && (
                  <TableCell>
                    {roomNames.length > 0 ? (
                      <div className="flex flex-col leading-tight">
                        <span>{roomNames.slice(0, 2).join(', ')}</span>
                        {roomNames.length > 2 && (
                          <span className="text-xs text-muted-foreground">
                            ...+{roomNames.length - 2} phòng khác
                          </span>
                        )}
                      </div>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                )}

                {cols.date && (
                  <TableCell>
                    {batch.voucher_date
                      ? format(new Date(batch.voucher_date), 'dd/MM/yyyy', {
                          locale: vi,
                        })
                      : '—'}
                  </TableCell>
                )}

                {cols.payer && (
                  <TableCell>{batch.payer_name || '—'}</TableCell>
                )}

                {cols.account && (
                  <TableCell>{batch.account_name || '—'}</TableCell>
                )}

                {cols.count && (
                  <TableCell className="text-center">
                    <Badge variant="outline">{batch.voucher_count}</Badge>
                  </TableCell>
                )}
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
