import { useCallback, useState } from "react";
import MainLayout from "@/components/layout/MainLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Search, Wallet } from "lucide-react";
import {
  useAccountsWithBalance,
  useDeleteAccount,
  useUnlockAccount,
  type AccountWithBalance,
} from "@/hooks/useAccounts";
import { usePagination } from "@/hooks/usePagination";
import CashbookList from "@/components/cashbooks/CashbookList";
import CashbookForm from "@/components/cashbooks/CashbookForm";
import CashbookLockDialog from "@/components/cashbooks/CashbookLockDialog";

const CashbooksPage = () => {
  const pagination = usePagination(10);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");

  const { data, isLoading } = useAccountsWithBalance({
    page: pagination.page,
    pageSize: pagination.pageSize,
    searchQuery,
  });
  const rows = data?.data ?? [];
  const totalCount = data?.totalCount ?? 0;

  const deleteMut = useDeleteAccount();
  const unlockMut = useUnlockAccount();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AccountWithBalance | null>(null);
  const [lockOpen, setLockOpen] = useState(false);
  const [lockTarget, setLockTarget] = useState<AccountWithBalance | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const handleAdd = useCallback(() => {
    setEditing(null);
    setFormOpen(true);
  }, []);

  const handleEdit = useCallback((acc: AccountWithBalance) => {
    setEditing(acc);
    setFormOpen(true);
  }, []);

  const handleLock = useCallback((acc: AccountWithBalance) => {
    setLockTarget(acc);
    setLockOpen(true);
  }, []);

  const handleUnlock = useCallback(
    async (acc: AccountWithBalance) => {
      await unlockMut.mutateAsync(acc.id);
    },
    [unlockMut]
  );

  const confirmDelete = useCallback(async () => {
    if (!deleteId) return;
    await deleteMut.mutateAsync(deleteId);
    setDeleteId(null);
  }, [deleteId, deleteMut]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSearchQuery(searchInput.trim());
    pagination.setPage(1);
  };

  return (
    <MainLayout
      title="Tài khoản"
      subtitle="Cài đặt → Danh mục khác → Tài chính → Tài khoản"
      icon={Wallet}
    >
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Button onClick={handleAdd}>
            <Plus className="h-4 w-4 mr-2" />
            Thêm tài khoản
          </Button>

          <form
            onSubmit={handleSearchSubmit}
            className="relative flex-1 max-w-sm ml-auto"
          >
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Tìm theo mã hoặc tên tài khoản..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="pl-9"
            />
          </form>
        </div>

        <CashbookList
          rows={rows}
          isLoading={isLoading}
          totalCount={totalCount}
          pagination={pagination}
          onEdit={handleEdit}
          onDelete={(id) => setDeleteId(id)}
          onLock={handleLock}
          onUnlock={handleUnlock}
        />
      </div>

      <CashbookForm
        open={formOpen}
        onOpenChange={(o) => {
          setFormOpen(o);
          if (!o) setEditing(null);
        }}
        account={editing}
      />

      <CashbookLockDialog
        open={lockOpen}
        onOpenChange={(o) => {
          setLockOpen(o);
          if (!o) setLockTarget(null);
        }}
        account={lockTarget}
      />

      <AlertDialog
        open={!!deleteId}
        onOpenChange={(o) => {
          if (!o) setDeleteId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận xoá tài khoản</AlertDialogTitle>
            <AlertDialogDescription>
              Bạn đang thực hiện thao tác xoá tài khoản ngân hàng/tiền mặt.
              Việc này có thể ảnh hưởng đến các phiếu thu/chi đang gắn vào
              tài khoản. Bạn có chắc chắn muốn xoá không?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-red-600 hover:bg-red-700"
            >
              Xoá
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </MainLayout>
  );
};

export default CashbooksPage;
