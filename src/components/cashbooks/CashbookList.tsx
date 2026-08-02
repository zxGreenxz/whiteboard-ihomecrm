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
import { type AccountWithBalance } from "@/hooks/useAccounts";
import { Lock, Pencil, Trash2, Wallet, Eye } from "lucide-react";
import {
  useMyCashbookAccessV2,
  useCashbookVisibilityV2,
} from "@/hooks/income-expenses/financeV2Mutations";

interface CashbookListProps {
  rows: AccountWithBalance[];
  isLoading: boolean;
  totalCount: number;
  pagination: PaginationState;
  onView: (acc: AccountWithBalance) => void;
  onEdit: (acc: AccountWithBalance) => void;
  onDelete: (id: string) => void;
  /** Đợt 6: mở nghi thức chốt & bàn giao (thay cho khoá/mở khoá tay). */
  onClose: (acc: AccountWithBalance) => void;
}

const formatVND = (n: number) =>
  new Intl.NumberFormat("vi-VN").format(Math.round(n)) + " đ";

const CashbookList = ({
  rows,
  isLoading,
  totalCount,
  pagination,
  onView,
  onEdit,
  onDelete,
  onClose,
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
  // §12.6/§1810: binding KNOWER = biết sổ, KHÔNG thấy tồn quỹ. RLS đã chặn số
  // thật (client tính ra 0 giả) — hiện "—" thay vì "0 đ" gây hiểu lầm.
  const { data: myAccess } = useMyCashbookAccessV2();
  const knowerBooks = useMemo(
    () =>
      new Set(
        (myAccess ?? [])
          .filter((a) => a.possession_kind === "KNOWER")
          .map((a) => a.cashbook_id),
      ),
    [myAccess],
  );
  // Cờ server per-sổ: sổ KHÔNG binding cũng phải "—" + ẩn icon Sửa/Xoá/Khoá
  // (trước đây hiện 0 đ giả + icon bấm vào mới 42501). RPC lỗi → null → giữ
  // hành vi cũ (chỉ mask KNOWER).
  const { data: visibility } = useCashbookVisibilityV2();
  const visById = useMemo(
    () => new Map((visibility ?? []).map((f) => [f.cashbook_id, f])),
    [visibility],
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
        title="Chưa có sổ quỹ nào"
        description="Hãy thêm sổ quỹ đầu tiên để bắt đầu quản lý tồn quỹ"
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
            <TableHead>Tên sổ quỹ</TableHead>
            <TableHead className="w-[160px]">Phụ trách</TableHead>
            <TableHead className="text-right">Số dư đầu kỳ</TableHead>
            <TableHead className="text-right">Tồn quỹ</TableHead>
            <TableHead>Ghi chú</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {/* M1: sổ ảo (bút toán) đẩy xuống cuối + badge nhận diện — số dư của
              chúng không phải tiền trong két. */}
          {[...rows]
            .sort((a, b) => Number(!!a.is_virtual) - Number(!!b.is_virtual))
            .map((acc) => {
            const isLocked = !!acc.lock_date;
            const vis = visById.get(acc.id);
            const balanceMasked = vis
              ? !vis.balance_visible
              : knowerBooks.has(acc.id);
            const canManage = vis ? vis.can_manage : true;
            const canDelete = vis ? vis.can_delete : true;
            return (
              <TableRow key={acc.id} className={acc.is_virtual ? "bg-muted/40" : undefined}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{acc.code}</span>
                    {acc.is_virtual && (
                      <Badge
                        variant="secondary"
                        className="bg-slate-200 text-slate-700 hover:bg-slate-200"
                        title="Sổ bút toán/kỹ thuật — không phải tiền thật trong két"
                      >
                        Sổ ảo
                      </Badge>
                    )}
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
                    {/* Đợt 6: khoá sổ không còn là một nút bấm một mình. Nó là
                        kết quả của nghi thức chốt & bàn giao hai bên. Nút "Mở
                        khoá" đã bị gỡ hẳn: từ Đợt 3, lock_cashbook_period_v1
                        (p_unlock) LUÔN ném [CASHBOOK_CLOSED], nên để nút đó lại
                        là hứa một đường thoát không tồn tại. */}
                    {canManage && !isLocked && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-amber-500 hover:text-amber-600 hover:bg-amber-50"
                        onClick={() => onClose(acc)}
                        title="Chốt sổ & bàn giao quỹ"
                      >
                        <Lock className="h-4 w-4" />
                      </Button>
                    )}
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-blue-500 hover:text-blue-600 hover:bg-blue-50"
                        onClick={() => onEdit(acc)}
                        title="Chỉnh sửa"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    )}
                    {canDelete && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-red-500 hover:text-red-600 hover:bg-red-50"
                        onClick={() => onDelete(acc.id)}
                        title="Xoá"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </TableCell>
                <TableCell className="font-medium">{acc.name}</TableCell>
                <TableCell className="text-muted-foreground">
                  {acc.owner_name || "—"}
                </TableCell>
                <TableCell className="text-right">
                  {balanceMasked
                    ? "—"
                    : formatVND(Number(acc.initial_amount))}
                </TableCell>
                <TableCell className="text-right">
                  {balanceMasked ? (
                    <span
                      className="text-muted-foreground"
                      title={
                        knowerBooks.has(acc.id)
                          ? "Bạn là Người biết sổ (KNOWER) — không xem tồn quỹ"
                          : "Bạn không giữ sổ này — không xem tồn quỹ"
                      }
                    >
                      —
                    </span>
                  ) : (
                    <span
                      className={
                        Number(acc.current_amount) < 0
                          ? "text-red-600 font-medium"
                          : "font-medium"
                      }
                    >
                      {formatVND(Number(acc.current_amount))}
                    </span>
                  )}
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
