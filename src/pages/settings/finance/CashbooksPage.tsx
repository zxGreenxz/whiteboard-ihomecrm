import { useCallback, useMemo, useState, lazy, Suspense } from "react";
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
  useAccounts,
  useAccountsWithBalance,
  useDeleteAccount,
  type AccountWithBalance,
} from "@/hooks/useAccounts";
import { usePagination } from "@/hooks/usePagination";
import { usePersistedState } from "@/hooks/usePersistedState";
import { useIsMobile } from "@/hooks/use-mobile";
import CashbookList from "@/components/cashbooks/CashbookList";
import CashbookListMobile from "@/components/cashbooks/CashbookListMobile";
import CashbookForm from "@/components/cashbooks/CashbookForm";
import CloseCashbookDialog from "@/components/cashbooks/CloseCashbookDialog";
import ConfirmCashbookClosingDialog from "@/components/cashbooks/ConfirmCashbookClosingDialog";
import CashbookClosingInbox from "@/components/cashbooks/CashbookClosingInbox";
import {
  useCashbookCloseConfirmers,
  useCashbookClosingDeepLink,
} from "@/hooks/useCashbookClosing";
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

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AccountWithBalance | null>(null);
  // Đợt 6 — nghi thức chốt & bàn giao thay cho khoá/mở khoá tay.
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeTarget, setCloseTarget] = useState<AccountWithBalance | null>(null);
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

  // ── PA4 deep-link từ thông báo ──────────────────────────────────────
  // `?close=<id>` (E6a "đã bàn giao xong — chốt sổ?") và `?confirm=<id>` (E6b).
  //
  // Sổ cần chốt có thể KHÔNG nằm trong `rows` (trang này phân trang 10 dòng),
  // nên tra tên từ `useAccounts()` — danh sách đầy đủ, cùng cache `["accounts"]`
  // mà nhiều màn khác đã nạp. Dialog chỉ cần `id` để chạy; tên/ngân hàng là để
  // hiển thị, thiếu cũng không sai nghiệp vụ.
  const { data: allAccounts } = useAccounts();
  const [deepLinkBookId, setDeepLinkBookId] = useState<string | null>(null);
  const [confirmRequestId, setConfirmRequestId] = useState<string | null>(null);

  useCashbookClosingDeepLink({
    onClose: useCallback((id: string) => {
      setDeepLinkBookId(id);
      setCloseOpen(true);
    }, []),
    onConfirm: useCallback((id: string) => setConfirmRequestId(id), []),
  });

  const closeBookId = closeTarget?.id ?? deepLinkBookId;
  const closeBookMeta = useMemo(() => {
    if (closeTarget) return { name: closeTarget.name, bankName: closeTarget.bank_name ?? null };
    if (!deepLinkBookId) return { name: null, bankName: null };
    const found = (allAccounts ?? []).find((a) => a.id === deepLinkBookId);
    return { name: found?.name ?? null, bankName: found?.bank_name ?? null };
  }, [closeTarget, deepLinkBookId, allAccounts]);

  const { data: confirmers } = useCashbookCloseConfirmers(closeBookId ?? null);

  const handleClose = useCallback((acc: AccountWithBalance) => {
    setDeepLinkBookId(null);
    setCloseTarget(acc);
    setCloseOpen(true);
  }, []);

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

          <div className="px-3 pt-3">
            <CashbookClosingInbox autoOpenRequestId={confirmRequestId} />
          </div>

          <CashbookListMobile
            rows={rows}
            isLoading={isLoading}
            onView={handleView}
            onEdit={handleEdit}
            onDelete={(id) => setDeleteId(id)}
            onClose={handleClose}
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

          <CashbookClosingInbox autoOpenRequestId={confirmRequestId} />

          <CashbookList
            rows={rows}
            isLoading={isLoading}
            totalCount={totalCount}
            pagination={pagination}
            onView={handleView}
            onEdit={handleEdit}
            onDelete={(id) => setDeleteId(id)}
            onClose={handleClose}
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

      <CloseCashbookDialog
        open={closeOpen}
        onOpenChange={(o) => {
          setCloseOpen(o);
          if (!o) {
            setCloseTarget(null);
            setDeepLinkBookId(null);
          }
        }}
        cashbookId={closeBookId ?? null}
        cashbookName={closeBookMeta.name}
        bankName={closeBookMeta.bankName}
        candidates={confirmers ?? []}
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
