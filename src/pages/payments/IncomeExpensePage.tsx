import { useState, useCallback, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
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
import { Plus, Upload, Search, Receipt, ListFilter, SlidersHorizontal, RefreshCcw } from "lucide-react";
import { IncomeExpenseStats } from "@/components/income-expenses/IncomeExpenseStats";
import { IncomeExpenseStatsMobile } from "@/components/income-expenses/IncomeExpenseStatsMobile";
import { IncomeExpenseFiltersBar } from "@/components/income-expenses/IncomeExpenseFilters";
import IncomeExpenseFilterPanel from "@/components/income-expenses/IncomeExpenseFilterPanel";
import IncomeExpenseList from "@/components/income-expenses/IncomeExpenseList";
import IncomeExpenseListMobile from "@/components/income-expenses/IncomeExpenseListMobile";
import IncomeExpenseFAB from "@/components/income-expenses/IncomeExpenseFAB";
import IncomeExpenseFilterChips from "@/components/income-expenses/IncomeExpenseFilterChips";
import IncomeExpenseForm from "@/components/income-expenses/IncomeExpenseForm";
import IncomeExpenseDetailDialog from "@/components/income-expenses/IncomeExpenseDetailDialog";
import IncomeExpenseImportDialog from "@/components/income-expenses/IncomeExpenseImportDialog";
import {
  useIncomeExpenses,
  useIncomeExpenseStats,
  useCancelIncomeExpense,
  useGenerateRecurringVouchers,
  type IncomeExpenseWithRelations,
} from "@/hooks/useIncomeExpenses";
import type { IncomeExpenseFilters } from "@/hooks/useIncomeExpenses";
import { usePagination } from "@/hooks/usePagination";
import { useIsMobile } from "@/hooks/use-mobile";

const EMPTY_FILTERS: IncomeExpenseFilters = {
  area_id: null,
  building_id: null,
  room_id: null,
  account_id: null,
  cash_book_id: null,
  type: null,
  start_date: null,
  end_date: null,
  approval_status: "APPROVED",
};

const IncomeExpensePage = () => {
  const isMobile = useIsMobile();
  const [searchParams, setSearchParams] = useSearchParams();

  const [filters, setFilters] = useState<IncomeExpenseFilters>(() => {
    const accountId = searchParams.get("account_id");
    return accountId
      ? { ...EMPTY_FILTERS, account_id: accountId }
      : EMPTY_FILTERS;
  });

  // Khi user vào /income-expense?account_id=xxx, pre-load filter và clear URL
  useEffect(() => {
    const accountId = searchParams.get("account_id");
    if (accountId) {
      setFilters((f) => ({ ...f, account_id: accountId }));
      // Xoá query để URL sạch — filter chip vẫn hiển thị
      const next = new URLSearchParams(searchParams);
      next.delete("account_id");
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [searchQuery, setSearchQuery] = useState("");
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isFilterPanelOpen, setIsFilterPanelOpen] = useState(false);
  const [detailVoucher, setDetailVoucher] =
    useState<IncomeExpenseWithRelations | null>(null);
  const [formType, setFormType] = useState<"INCOME" | "EXPENSE">("INCOME");
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);

  const pagination = usePagination(isMobile ? 50 : 20);

  const { data: listResult, isLoading } = useIncomeExpenses(
    filters,
    { page: pagination.page, pageSize: pagination.pageSize },
    searchQuery || undefined
  );

  const vouchers = listResult?.data ?? [];
  const totalCount = listResult?.totalCount ?? 0;

  const { data: stats, isLoading: isStatsLoading } =
    useIncomeExpenseStats(filters);

  const cancelMutation = useCancelIncomeExpense();
  const generateRecurringMutation = useGenerateRecurringVouchers();

  const handleFiltersChange = useCallback(
    (newFilters: IncomeExpenseFilters) => {
      setFilters(newFilters);
      pagination.setPage(1);
    },
    [pagination]
  );

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearchQuery(e.target.value);
      pagination.setPage(1);
    },
    [pagination]
  );

  const handleAddVoucher = useCallback(() => {
    setFormType("INCOME");
    setIsFormOpen(true);
  }, []);

  const handleAddIncome = useCallback(() => {
    setFormType("INCOME");
    setIsFormOpen(true);
  }, []);

  const handleAddExpense = useCallback(() => {
    setFormType("EXPENSE");
    setIsFormOpen(true);
  }, []);

  const handleView = useCallback((voucher: IncomeExpenseWithRelations) => {
    setDetailVoucher(voucher);
  }, []);

  const handleFormClose = useCallback((open: boolean) => {
    setIsFormOpen(open);
  }, []);

  const handleCancelVoucher = useCallback((id: string) => {
    setCancelTarget(id);
  }, []);

  const confirmCancel = useCallback(() => {
    if (cancelTarget) {
      cancelMutation.mutate(cancelTarget);
    }
    setCancelTarget(null);
  }, [cancelTarget, cancelMutation]);

  const statsData = stats ?? {
    totalIncome: 0,
    totalExpense: 0,
    difference: 0,
  };

  // ============== MOBILE LAYOUT ==============
  if (isMobile) {
    return (
      <MainLayout title="Thu chi" subtitle="Tài chính → Thu chi" icon={Receipt}>
        <div className="-mx-4 -my-4 sm:-mx-6 sm:-my-6 bg-zinc-50 min-h-[calc(100vh-120px)]">
          {/* Search + filter row */}
          <div className="flex items-center gap-2 px-3 pt-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Theo mã phiếu, tên..."
                value={searchQuery}
                onChange={handleSearchChange}
                className="pl-9 h-10 bg-white"
              />
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setIsFilterPanelOpen(true)}
              className="h-10 w-10 shrink-0 bg-white"
              title="Lọc dữ liệu"
            >
              <SlidersHorizontal className="h-4 w-4" />
            </Button>
          </div>

          {/* Stats */}
          <IncomeExpenseStatsMobile
            stats={statsData}
            isLoading={isStatsLoading}
          />

          {/* Filter chips (active filters) */}
          <IncomeExpenseFilterChips
            filters={filters}
            emptyFilters={EMPTY_FILTERS}
            onChange={handleFiltersChange}
          />

          {/* List */}
          <IncomeExpenseListMobile
            vouchers={vouchers}
            isLoading={isLoading}
            onView={handleView}
          />

          {/* Pagination summary (mobile) */}
          {totalCount > pagination.pageSize && (
            <div className="px-3 pb-2 text-center text-xs text-muted-foreground">
              Hiển thị {vouchers.length} / {totalCount} phiếu
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
        </div>

        {/* FAB */}
        <IncomeExpenseFAB
          onCreateIncome={handleAddIncome}
          onCreateExpense={handleAddExpense}
        />

        {/* Dialogs */}
        <IncomeExpenseForm
          open={isFormOpen}
          onOpenChange={handleFormClose}
          voucher={null}
          defaultType={formType}
        />
        <IncomeExpenseDetailDialog
          open={!!detailVoucher}
          onOpenChange={(o) => {
            if (!o) setDetailVoucher(null);
          }}
          voucher={detailVoucher}
          onCancel={handleCancelVoucher}
        />
        <IncomeExpenseImportDialog
          open={isImportOpen}
          onOpenChange={setIsImportOpen}
        />
        <IncomeExpenseFilterPanel
          open={isFilterPanelOpen}
          onOpenChange={setIsFilterPanelOpen}
          filters={filters}
          emptyFilters={EMPTY_FILTERS}
          onApply={handleFiltersChange}
          side="bottom"
        />
        <AlertDialog
          open={!!cancelTarget}
          onOpenChange={() => setCancelTarget(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Xác nhận huỷ phiếu</AlertDialogTitle>
              <AlertDialogDescription>
                Phiếu sẽ được đánh dấu <b>Đã huỷ</b> và không còn ảnh hưởng đến
                tồn quỹ tài khoản. Phiếu vẫn được lưu lại trong lịch sử.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Đóng</AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmCancel}
                className="bg-red-600 hover:bg-red-700"
              >
                Huỷ phiếu
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </MainLayout>
    );
  }

  // ============== DESKTOP LAYOUT ==============
  return (
    <MainLayout title="Thu chi" subtitle="Tài chính → Thu chi" icon={Receipt}>
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Button onClick={handleAddVoucher}>
            <Plus className="h-4 w-4 mr-2" />
            Thêm phiếu
          </Button>
          <Button variant="outline" onClick={() => setIsImportOpen(true)}>
            <Upload className="h-4 w-4 mr-2" />
            Import
          </Button>
          <Button
            variant="outline"
            onClick={() => generateRecurringMutation.mutate()}
            disabled={generateRecurringMutation.isPending}
            title="Sinh các phiếu thu/chi định kỳ đã đến hạn"
          >
            <RefreshCcw className="h-4 w-4 mr-2" />
            {generateRecurringMutation.isPending
              ? "Đang sinh..."
              : "Sinh phiếu lặp lại"}
          </Button>
          <Button
            variant="outline"
            onClick={() => setIsFilterPanelOpen(true)}
            title="Lọc dữ liệu"
          >
            <ListFilter className="h-4 w-4 mr-2" />
            Lọc dữ liệu
          </Button>
          <div className="relative flex-1 max-w-sm ml-auto">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Tìm theo tên phiếu, khách hàng, mã phiếu..."
              value={searchQuery}
              onChange={handleSearchChange}
              className="pl-9"
            />
          </div>
        </div>

        <IncomeExpenseFiltersBar
          filters={filters}
          onChange={handleFiltersChange}
        />

        <IncomeExpenseStats stats={statsData} isLoading={isStatsLoading} />

        <IncomeExpenseList
          vouchers={vouchers}
          isLoading={isLoading}
          onView={handleView}
          onCancel={handleCancelVoucher}
          pagination={pagination}
          totalCount={totalCount}
        />
      </div>

      <IncomeExpenseForm
        open={isFormOpen}
        onOpenChange={handleFormClose}
        voucher={null}
        defaultType={formType}
      />
      <IncomeExpenseDetailDialog
        open={!!detailVoucher}
        onOpenChange={(o) => {
          if (!o) setDetailVoucher(null);
        }}
        voucher={detailVoucher}
        onCancel={handleCancelVoucher}
      />
      <IncomeExpenseImportDialog
        open={isImportOpen}
        onOpenChange={setIsImportOpen}
      />
      <IncomeExpenseFilterPanel
        open={isFilterPanelOpen}
        onOpenChange={setIsFilterPanelOpen}
        filters={filters}
        emptyFilters={EMPTY_FILTERS}
        onApply={handleFiltersChange}
        side="right"
      />

      <AlertDialog
        open={!!cancelTarget}
        onOpenChange={() => setCancelTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận huỷ phiếu</AlertDialogTitle>
            <AlertDialogDescription>
              Phiếu sẽ được đánh dấu <b>Đã huỷ</b> và không còn ảnh hưởng đến
              tồn quỹ tài khoản. Phiếu vẫn được lưu lại trong lịch sử.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Đóng</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmCancel}
              className="bg-red-600 hover:bg-red-700"
            >
              Huỷ phiếu
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </MainLayout>
  );
};

export default IncomeExpensePage;
