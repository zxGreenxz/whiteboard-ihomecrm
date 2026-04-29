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
import type { MeterReadingDetailed } from '@/hooks/useMeterReadings';
import { canEditReading, canDeleteReading } from '@/hooks/useMeterReadingsHelpers';
import {
  MoreHorizontal,
  Pencil,
  Trash2,
  ClipboardList,
} from 'lucide-react';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';

// =============================================
// Types
// =============================================

interface MeterReadingListProps {
  readings: MeterReadingDetailed[];
  isLoading: boolean;
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  onEdit: (reading: MeterReadingDetailed) => void;
  onDelete: (id: string) => void;
  pagination: PaginationState;
  totalCount: number;
}

// =============================================
// Helpers
// =============================================

/** Format a number with Vietnamese locale (e.g. 1.234,56) */
const formatNumber = (value: number | null | undefined): string => {
  if (value == null) return '—';
  return value.toLocaleString('vi-VN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};

/** Format a date string as DD/MM/YYYY */
const formatDate = (dateStr: string | null | undefined): string => {
  if (!dateStr) return '—';
  try {
    return format(new Date(dateStr), 'dd/MM/yyyy', { locale: vi });
  } catch {
    return '—';
  }
};

// =============================================
// Component
// =============================================

const MeterReadingList = ({
  readings,
  isLoading,
  selectedIds,
  onSelectionChange,
  onEdit,
  onDelete,
  pagination,
  totalCount,
}: MeterReadingListProps) => {
  const paginationInfo = useMemo(
    () => calculatePaginationInfo(pagination.page, pagination.pageSize, totalCount),
    [pagination.page, pagination.pageSize, totalCount],
  );

  const isAllSelected =
    readings.length > 0 && readings.every((r) => selectedIds.includes(r.id));

  const isSomeSelected =
    readings.some((r) => selectedIds.includes(r.id)) && !isAllSelected;

  const handleToggleAll = () => {
    if (isAllSelected) {
      const currentPageIds = new Set(readings.map((r) => r.id));
      onSelectionChange(selectedIds.filter((id) => !currentPageIds.has(id)));
    } else {
      const currentPageIds = readings.map((r) => r.id);
      const merged = new Set([...selectedIds, ...currentPageIds]);
      onSelectionChange(Array.from(merged));
    }
  };

  const handleToggleRow = (id: string) => {
    if (selectedIds.includes(id)) {
      onSelectionChange(selectedIds.filter((sid) => sid !== id));
    } else {
      onSelectionChange([...selectedIds, id]);
    }
  };

  // Loading skeleton
  if (isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  // Empty state
  if (readings.length === 0) {
    return (
      <EmptyState
        icon={ClipboardList}
        title="Chưa có chỉ số nào"
        description="Hãy thêm chỉ số đầu tiên để bắt đầu quản lý"
      />
    );
  }

  return (
    <div className="bg-white rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-12">
              <Checkbox
                checked={isAllSelected}
                ref={(el) => {
                  if (el) {
                    (el as unknown as HTMLButtonElement).dataset.indeterminate =
                      isSomeSelected ? 'true' : 'false';
                  }
                }}
                onCheckedChange={handleToggleAll}
              />
            </TableHead>
            <TableHead>Mã</TableHead>
            <TableHead>Thao tác</TableHead>
            <TableHead>Công tơ</TableHead>
            <TableHead className="text-right">Chỉ số đầu</TableHead>
            <TableHead className="text-right">Chỉ số cuối</TableHead>
            <TableHead className="text-right">Số tiêu thụ</TableHead>
            <TableHead>Ngày chốt</TableHead>
            <TableHead>Người chốt</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {readings.map((reading) => {
            const isApproved = reading.status === 'APPROVED';
            const editable = canEditReading(reading.status);
            const deletable = canDeleteReading(reading.status);

            return (
              <TableRow key={reading.id}>
                {/* Checkbox */}
                <TableCell>
                  <Checkbox
                    checked={selectedIds.includes(reading.id)}
                    onCheckedChange={() => handleToggleRow(reading.id)}
                  />
                </TableCell>

                {/* Mã + Badge trạng thái */}
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{reading.reading_code}</span>
                    <Badge
                      variant={isApproved ? 'default' : 'secondary'}
                      className={
                        isApproved
                          ? 'bg-green-100 text-green-800 hover:bg-green-100'
                          : 'bg-yellow-100 text-yellow-800 hover:bg-yellow-100'
                      }
                    >
                      {isApproved ? 'Đã duyệt' : 'Chưa duyệt'}
                    </Badge>
                  </div>
                </TableCell>

                {/* Thao tác */}
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuLabel>Thao tác</DropdownMenuLabel>
                      <DropdownMenuSeparator />

                      {/* Cập nhật - disabled khi APPROVED */}
                      <DropdownMenuItem
                        disabled={!editable}
                        onClick={() => onEdit(reading)}
                      >
                        <Pencil className="h-4 w-4 mr-2" />
                        Cập nhật
                      </DropdownMenuItem>

                      {/* Xoá - disabled khi APPROVED */}
                      <DropdownMenuItem
                        disabled={!deletable}
                        className={deletable ? 'text-red-600' : ''}
                        onClick={() => onDelete(reading.id)}
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Xoá
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>

                {/* Công tơ */}
                <TableCell>
                  <div>
                    <div className="text-sm font-medium">{reading.meter_code}</div>
                    <div className="text-xs text-muted-foreground">{reading.meter_name}</div>
                  </div>
                </TableCell>

                {/* Chỉ số đầu */}
                <TableCell className="text-right">
                  {formatNumber(reading.previous_reading)}
                </TableCell>

                {/* Chỉ số cuối */}
                <TableCell className="text-right">
                  {formatNumber(reading.current_reading)}
                </TableCell>

                {/* Số tiêu thụ */}
                <TableCell className="text-right font-medium">
                  {formatNumber(reading.consumption)}
                </TableCell>

                {/* Ngày chốt */}
                <TableCell>
                  {formatDate(reading.reading_date)}
                </TableCell>

                {/* Người chốt */}
                <TableCell className="text-sm text-muted-foreground">
                  {reading.recorder_email || '—'}
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

export default MeterReadingList;
