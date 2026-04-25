import { useMemo } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTablePagination } from "@/components/ui/data-table-pagination";
import EmptyState from "@/components/ui/EmptyState";
import {
  calculatePaginationInfo,
  type PaginationState,
} from "@/hooks/usePagination";
import {
  accountTypeLabel,
  type AccountWithBalance,
} from "@/hooks/useAccounts";
import { Lock, LockOpen, Pencil, Trash2, Wallet, Eye } from "lucide-react";

interface CashbookListProps {
  rows: AccountWithBalance[];
  isLoading: boolean;
  totalCount: number;
  pagination: PaginationState;
  onView: (acc: AccountWithBalance) => void;
  onEdit: (acc: AccountWithBalance) => void;
  onDelete: (id: string) => void;
  onLock: (acc: AccountWithBalance) => void;
  onUnlock: (acc: AccountWithBalance) => void;
}

const formatVND = (n: number) => n.toLocaleString("vi-VN");

const CashbookList = ({
  rows,
  isLoading,
  totalCount,
  pagination,
  onView,
  onEdit,
  onDelete,
  onLock,
  onUnlock,
}: CashbookListProps) => {
  const info = useMemo(
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
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Wallet}
        title="Chưa có tài khoản nào"
        description="Hãy thêm tài khoản đầu tiên để bắt đầu quản lý tồn quỹ"
      />
    );
  }

  return (
    <div className="bg-white rounded-lg border border-zinc-200 overflow-hidden">
      <Table className="[&_th]:border-r [&_th]:border-b [&_th]:border-zinc-200 [&_td]:border-r [&_td]:border-b [&_td]:border-zinc-200 [&_tr>*:last-child]:border-r-0 [&_tbody_tr:last-child>td]:border-b-0">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[120px]">Mã</TableHead>
            <TableHead className="w-[140px]">Thao tác</TableHead>
            <TableHead>Tên tài khoản</TableHead>
            <TableHead>Loại tài khoản</TableHead>
            <TableHead className="text-right">Số dư đầu kỳ</TableHead>
            <TableHead className="text-right">Tồn quỹ</TableHead>
            <TableHead>Ghi chú</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((acc) => {
            const isLocked = !!acc.lock_date;
            return (
              <TableRow key={acc.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{acc.code}</span>
                    {isLocked && (
                      <Badge
                        variant="secondary"
                        className="bg-orange-100 text-orange-800 hover:bg-orange-100"
                      >
                        Khoá sổ
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50"
                      onClick={() => onView(acc)}
                      title="Xem chi tiết"
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
                    {isLocked ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-orange-500 hover:text-orange-600 hover:bg-orange-50"
                        onClick={() => onUnlock(acc)}
                        title="Mở khoá sổ"
                      >
                        <LockOpen className="h-4 w-4" />
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-amber-500 hover:text-amber-600 hover:bg-amber-50"
                        onClick={() => onLock(acc)}
                        title="Khoá sổ"
                      >
                        <Lock className="h-4 w-4" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-blue-500 hover:text-blue-600 hover:bg-blue-50"
                      onClick={() => onEdit(acc)}
                      title="Chỉnh sửa"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-red-500 hover:text-red-600 hover:bg-red-50"
                      onClick={() => onDelete(acc.id)}
                      title="Xoá"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </TableCell>
                <TableCell className="font-medium">{acc.name}</TableCell>
                <TableCell>{accountTypeLabel(acc.type)}</TableCell>
                <TableCell className="text-right">
                  {formatVND(Number(acc.initial_amount))}
                </TableCell>
                <TableCell className="text-right">
                  <span
                    className={
                      Number(acc.current_amount) < 0
                        ? "text-red-600 font-medium"
                        : "font-medium"
                    }
                  >
                    {formatVND(Number(acc.current_amount))}
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {acc.description || "—"}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <DataTablePagination
        paginationInfo={info}
        onPageChange={pagination.setPage}
        onPageSizeChange={pagination.setPageSize}
        showPageSizeSelector
        showItemCount
      />
    </div>
  );
};

export default CashbookList;
