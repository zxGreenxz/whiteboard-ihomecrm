import { useCallback, useState, lazy, Suspense } from "react";
import { usePhoneViewport } from "@/hooks/use-mobile";
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
import { usePersistedState } from "@/hooks/usePersistedState";
import { useIsMobile } from "@/hooks/use-mobile";
import CashbookList from "@/components/cashbooks/CashbookList";
import CashbookListMobile from "@/components/cashbooks/CashbookListMobile";
import CashbookForm from "@/components/cashbooks/CashbookForm";
import CashbookLockDialog from "@/components/cashbooks/CashbookLockDialog";
import CashbookDetailDialog from "@/components/cashbooks/CashbookDetailDialog";

const CashbooksDesktop = () => {
  const isMobile = useIsMobile();
  const pagination = usePagination(isMobile ? 50 : 10);
  const [searchQuery, setSearchQuery] = usePersistedState("flt:cashbooks:searchQuery", "");
  const [searchInput, setSearchInput] = usePersistedState("flt:cashbooks:search", "");

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
  const [detailAcc, setDetailAcc] = useState<AccountWithBalance | null>(null);

  const handleAdd = useCallback(() => {
    setEditing(null);
    setFormOpen(true);
  }, []);

  const handleView = useCallback((acc: AccountWithBalance) => {
    setDetailAcc(acc);
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
      title="Sổ quỹ"
      subtitle="Tài chính → Sổ quỹ"
      icon={Wallet}
    >
      {isMobile ? (
        <div className="-mx-4 -my-4 sm:-mx-6 sm:-my-6 bg-zinc-50 min-h-[calc(100vh-120px)]">
          <form
            onSubmit={handleSearchSubmit}
            className="px-3 pt-3 flex items-center gap-2"
          >
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Tìm mã hoặc tên sổ quỹ..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="pl-9 h-10 bg-white"
              />
            </div>
          </form>

          <CashbookListMobile
            rows={rows}
            isLoading={isLoading}
            onView={handleView}
            onEdit={handleEdit}
            onDelete={(id) => setDeleteId(id)}
            onLock={handleLock}
            onUnlock={handleUnlock}
          />

          {totalCount > pagination.pageSize && (
            <div className="px-3 pb-2 text-center text-xs text-muted-foreground">
              {rows.length} / {totalCount} sổ quỹ
              {pagination.page * pagination.pageSize < totalCount && (
                <button
                  className="ml-2 text-blue-600 font-medium"
                  onClick={() => pagination.setPage(pagination.page + 1)}
                >
                  Xem thêm →
                </button>
              )}
            </div>
          )}

          {/* Mobile FAB */}
          <button
            type="button"
            aria-label="Thêm sổ quỹ"
            onClick={handleAdd}
            className="fixed right-4 z-40 w-14 h-14 rounded-full bg-blue-600 text-white shadow-xl grid place-items-center active:scale-95 transition-transform"
            style={{ bottom: "calc(72px + env(safe-area-inset-bottom, 0px))" }}
          >
            <Plus className="h-6 w-6" />
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Button onClick={handleAdd}>
              <Plus className="h-4 w-4 mr-2" />
              Thêm sổ quỹ
            </Button>

            <form
              onSubmit={handleSearchSubmit}
              className="relative flex-1 max-w-sm ml-auto"
            >
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Tìm theo mã hoặc tên sổ quỹ..."
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
            onView={handleView}
            onEdit={handleEdit}
            onDelete={(id) => setDeleteId(id)}
            onLock={handleLock}
            onUnlock={handleUnlock}
          />
        </div>
      )}

      <CashbookDetailDialog
        open={!!detailAcc}
        onOpenChange={(o) => {
          if (!o) setDetailAcc(null);
        }}
        account={detailAcc}
        onEdit={handleEdit}
        onDelete={(id) => setDeleteId(id)}
      />

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
            <AlertDialogTitle>Xác nhận xoá sổ quỹ</AlertDialogTitle>
            <AlertDialogDescription>
              Bạn đang thực hiện thao tác xoá sổ quỹ.
              Việc này có thể ảnh hưởng đến các phiếu thu/chi đang gắn vào
              sổ quỹ này. Bạn có chắc chắn muốn xoá không?
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

const CashbooksMobilePage = lazy(() => import("./CashbooksMobilePage"));

export default function CashbooksPage() {
  const isPhone = usePhoneViewport();
  if (isPhone)
    return (
      <Suspense fallback={null}>
        <CashbooksMobilePage />
      </Suspense>
    );
  return <CashbooksDesktop />;
}
