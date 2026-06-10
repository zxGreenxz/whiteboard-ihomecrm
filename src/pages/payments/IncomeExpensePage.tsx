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
import { Plus, Upload, Search, Receipt, ListFilter, SlidersHorizontal, RefreshCcw, ChevronDown, Layers, FileText } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IncomeExpenseStats } from "@/components/income-expenses/IncomeExpenseStats";
import { IncomeExpenseStatsMobile } from "@/components/income-expenses/IncomeExpenseStatsMobile";
import { IncomeExpenseFiltersBar } from "@/components/income-expenses/IncomeExpenseFilters";
import IncomeExpenseFilterPanel from "@/components/income-expenses/IncomeExpenseFilterPanel";
import IncomeExpenseList from "@/components/income-expenses/IncomeExpenseList";
import IncomeExpenseListMobile from "@/components/income-expenses/IncomeExpenseListMobile";
import IncomeExpenseFAB from "@/components/income-expenses/IncomeExpenseFAB";
import IncomeExpenseFilterChips from "@/components/income-expenses/IncomeExpenseFilterChips";
import IncomeExpenseForm from "@/components/income-expenses/IncomeExpenseForm";
import IncomeExpenseQuickCreateDialog from "@/components/income-expenses/IncomeExpenseQuickCreateDialog";
import IncomeExpenseDetailDialog from "@/components/income-expenses/IncomeExpenseDetailDialog";
import IncomeExpenseQuickEditDialog from "@/components/income-expenses/IncomeExpenseQuickEditDialog";
import IncomeExpenseVerifyDialog from "@/components/income-expenses/IncomeExpenseVerifyDialog";
import IncomeExpenseImportDialog from "@/components/income-expenses/IncomeExpenseImportDialog";
import IncomeExpenseBatchForm from "@/components/income-expenses/IncomeExpenseBatchForm";
import IncomeExpenseBatchList from "@/components/income-expenses/IncomeExpenseBatchList";
import IncomeExpenseBatchDetailDialog from "@/components/income-expenses/IncomeExpenseBatchDetailDialog";
import {
  useIncomeExpenses,
  useIncomeExpenseStats,
  useCancelIncomeExpense,
  useApproveVoucher,
  useGenerateRecurringVouchers,
  useStopRecurring,
  useIncomeExpenseBatches,
  useCancelIncomeExpenseBatch,
  type IncomeExpenseWithRelations,
} from "@/hooks/useIncomeExpenses";
import type { IncomeExpenseFilters } from "@/hooks/useIncomeExpenses";
import { usePagination } from "@/hooks/usePagination";
import { useIsMobile } from "@/hooks/use-mobile";

const EMPTY_FILTERS: IncomeExpenseFilters = {
  // Lọc nhiều toà (BuildingMultiSelect) — [] = tất cả toà. Thay cặp
  // area_id + building_id đơn cũ.
  building_ids: [],
  room_id: null,
  room_ids: null,
  account_id: null,
  cash_book_id: null,
  type: null,
  start_date: null,
  end_date: null,
  approval_status: "ALL_ACTIVE",
  income_type_id: null,
  expense_type_id: null,
  creator_id: null,
  amount_target: null,
  verified_status: null,
  period_start_month: null,
  period_end_month: null,
};

// Parse search input: nếu toàn ký tự số (sau khi bỏ ., space, đ, d) → amount filter.
// Trả về { amount } nếu là số, { text } nếu là chuỗi, { } nếu rỗng.
function parseSearchInput(raw: string): { amount?: number; text?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const cleaned = trimmed.replace(/[\s.,đdĐ]/g, "");
  if (/^\d+$/.test(cleaned)) {
    const amount = Number(cleaned);
    if (amount > 0) return { amount };
  }
  return { text: trimmed };
}

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
  const [viewMode, setViewMode] = useState<"individual" | "batch">("individual");
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isQuickOpen, setIsQuickOpen] = useState(false);
  const [isBatchFormOpen, setIsBatchFormOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isFilterPanelOpen, setIsFilterPanelOpen] = useState(false);
  const [detailVoucher, setDetailVoucher] =
    useState<IncomeExpenseWithRelations | null>(null);
  const [editingVoucher, setEditingVoucher] =
    useState<IncomeExpenseWithRelations | null>(null);
  const [quickEditVoucher, setQuickEditVoucher] =
    useState<IncomeExpenseWithRelations | null>(null);
  const [verifyVoucher, setVerifyVoucher] =
    useState<IncomeExpenseWithRelations | null>(null);
  const [detailBatchId, setDetailBatchId] = useState<string | null>(null);
  const [formType, setFormType] = useState<"INCOME" | "EXPENSE">("INCOME");
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);
  const [approveTarget, setApproveTarget] = useState<string | null>(null);
  const [cancelBatchTarget, setCancelBatchTarget] = useState<string | null>(null);

  const pagination = usePagination(isMobile ? 50 : 20);

  // Parse search input: số → amount filter (±5.000đ), chữ → text search
  const parsedSearch = parseSearchInput(searchQuery);
  const buildingIds = filters.building_ids ?? [];
  const effectiveFilters: IncomeExpenseFilters = {
    ...filters,
    building_ids: buildingIds.length ? buildingIds : undefined,
    area_id: null,
    // Tương thích: useIncomeExpenseBatches (Phiếu tổng) chưa đọc building_ids —
    // chọn đúng 1 toà thì truyền kèm building_id đơn để view đó vẫn lọc được
    // (với list/stats, building_ids ưu tiên nên không đổi kết quả).
    building_id: buildingIds.length === 1 ? buildingIds[0] : null,
    amount_target: parsedSearch.amount ?? null,
  };

  const { data: listResult, isLoading } = useIncomeExpenses(
    effectiveFilters,
    { page: pagination.page, pageSize: pagination.pageSize },
    parsedSearch.text
  );

  const { data: batchResult, isLoading: isBatchLoading } =
    useIncomeExpenseBatches(
      effectiveFilters,
      { page: pagination.page, pageSize: pagination.pageSize },
      parsedSearch.text
    );

  const vouchers = listResult?.data ?? [];
  const totalCount = listResult?.totalCount ?? 0;
  const batches = batchResult?.data ?? [];
  const batchTotalCount = batchResult?.totalCount ?? 0;

  const detailBatch =
    detailBatchId !== null
      ? batches.find((b) => b.id === detailBatchId) ?? null
      : null;

  const { data: stats, isLoading: isStatsLoading } =
    useIncomeExpenseStats(effectiveFilters);

  const cancelMutation = useCancelIncomeExpense();
  const cancelBatchMutation = useCancelIncomeExpenseBatch();
  const approveMutation = useApproveVoucher();
  const generateRecurringMutation = useGenerateRecurringVouchers();
  const stopRecurringMutation = useStopRecurring();

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

  const handleAddBatch = useCallback((type: "INCOME" | "EXPENSE" = "EXPENSE") => {
    setFormType(type);
    setIsBatchFormOpen(true);
  }, []);

  const handleView = useCallback((voucher: IncomeExpenseWithRelations) => {
    setDetailVoucher(voucher);
  }, []);

  const handleViewBatch = useCallback((batchId: string) => {
    setDetailBatchId(batchId);
  }, []);

  const handleFormClose = useCallback((open: boolean) => {
    setIsFormOpen(open);
  }, []);

  const handleEditVoucher = useCallback((voucher: IncomeExpenseWithRelations) => {
    setEditingVoucher(voucher);
  }, []);

  const handleEditFormClose = useCallback((open: boolean) => {
    if (!open) setEditingVoucher(null);
  }, []);

  const handleQuickEditVoucher = useCallback(
    (voucher: IncomeExpenseWithRelations) => {
      setQuickEditVoucher(voucher);
    },
    []
  );

  const handleQuickEditClose = useCallback((open: boolean) => {
    if (!open) setQuickEditVoucher(null);
  }, []);

  const handleVerifyVoucher = useCallback(
    (voucher: IncomeExpenseWithRelations) => {
      setVerifyVoucher(voucher);
    },
    []
  );

  const handleVerifyClose = useCallback((open: boolean) => {
    if (!open) setVerifyVoucher(null);
  }, []);

  const handleApproveVoucher = useCallback((id: string) => {
    setApproveTarget(id);
  }, []);

  const confirmApprove = useCallback(() => {
    if (approveTarget) {
      approveMutation.mutate(approveTarget);
    }
    setApproveTarget(null);
  }, [approveTarget, approveMutation]);

  const handleCancelVoucher = useCallback((id: string) => {
    setCancelTarget(id);
  }, []);

  const handleCancelBatch = useCallback((batchId: string) => {
    setCancelBatchTarget(batchId);
  }, []);

  const confirmCancel = useCallback(() => {
    if (cancelTarget) {
      cancelMutation.mutate(cancelTarget);
    }
    setCancelTarget(null);
  }, [cancelTarget, cancelMutation]);

  const confirmCancelBatch = useCallback(() => {
    if (cancelBatchTarget) {
      cancelBatchMutation.mutate(cancelBatchTarget);
    }
    setCancelBatchTarget(null);
  }, [cancelBatchTarget, cancelBatchMutation]);

  const handleViewModeChange = useCallback(
    (v: string) => {
      setViewMode(v as "individual" | "batch");
      pagination.setPage(1);
    },
    [pagination]
  );

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

          {/* View mode toggle */}
          <div className="px-3 pt-1">
            <Tabs value={viewMode} onValueChange={handleViewModeChange}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="individual">Phiếu lẻ</TabsTrigger>
                <TabsTrigger value="batch">Phiếu tổng</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          {/* List */}
          {viewMode === "individual" ? (
            <IncomeExpenseListMobile
              vouchers={vouchers}
              isLoading={isLoading}
              onView={handleView}
            />
          ) : (
            <div className="px-3 pt-2">
              <IncomeExpenseBatchList
                batches={batches}
                isLoading={isBatchLoading}
                onView={handleViewBatch}
                onCancel={handleCancelBatch}
                onEdit={handleViewBatch}
                pagination={pagination}
                totalCount={batchTotalCount}
              />
            </div>
          )}

          {/* Pagination summary (mobile) — chỉ cho view phiếu lẻ */}
          {viewMode === "individual" && totalCount > pagination.pageSize && (
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
          onCreateQuick={() => setIsQuickOpen(true)}
          onCreateIncome={handleAddIncome}
          onCreateExpense={handleAddExpense}
          onCreateBatch={() => handleAddBatch("EXPENSE")}
        />

        {/* Dialogs */}
        <IncomeExpenseQuickCreateDialog
          open={isQuickOpen}
          onOpenChange={setIsQuickOpen}
          defaultType="EXPENSE"
        />
        <IncomeExpenseForm
          open={isFormOpen}
          onOpenChange={handleFormClose}
          voucher={null}
          defaultType={formType}
        />
        <IncomeExpenseBatchForm
          open={isBatchFormOpen}
          onOpenChange={setIsBatchFormOpen}
          defaultType={formType}
        />
        <IncomeExpenseForm
          open={!!editingVoucher}
          onOpenChange={handleEditFormClose}
          voucher={editingVoucher}
        />
        <IncomeExpenseDetailDialog
          open={!!detailVoucher}
          onOpenChange={(o) => {
            if (!o) setDetailVoucher(null);
          }}
          voucher={detailVoucher}
          onCancel={handleCancelVoucher}
          onEdit={handleEditVoucher}
          onQuickEdit={handleQuickEditVoucher}
          onApprove={handleApproveVoucher}
        />
        <IncomeExpenseQuickEditDialog
          open={!!quickEditVoucher}
          onOpenChange={handleQuickEditClose}
          voucher={quickEditVoucher}
        />
        <IncomeExpenseBatchDetailDialog
          open={!!detailBatch}
          onOpenChange={(o) => {
            if (!o) setDetailBatchId(null);
          }}
          batch={detailBatch}
          onCancel={handleCancelBatch}
          onEditVoucher={handleEditVoucher}
          onCancelVoucher={handleCancelVoucher}
          onApproveVoucher={handleApproveVoucher}
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
        <AlertDialog
          open={!!approveTarget}
          onOpenChange={() => setApproveTarget(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Xác nhận duyệt phiếu</AlertDialogTitle>
              <AlertDialogDescription>
                Sau khi duyệt, phiếu sẽ được tính vào <b>tồn quỹ</b> và không
                còn chỉnh sửa được. Hãy chắc chắn đã thanh toán cho người nhận.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Đóng</AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmApprove}
                className="bg-green-600 hover:bg-green-700"
              >
                Duyệt phiếu
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <AlertDialog
          open={!!cancelBatchTarget}
          onOpenChange={() => setCancelBatchTarget(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Xác nhận huỷ cả đợt</AlertDialogTitle>
              <AlertDialogDescription>
                Tất cả phiếu trong đợt sẽ được đánh dấu <b>Đã huỷ</b> cùng lúc
                và không còn ảnh hưởng đến tồn quỹ. Các phiếu vẫn được lưu lại
                trong lịch sử.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Đóng</AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmCancelBatch}
                className="bg-red-600 hover:bg-red-700"
              >
                Huỷ cả đợt
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Thêm phiếu
                <ChevronDown className="h-4 w-4 ml-1" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuItem onClick={handleAddVoucher}>
                <FileText className="h-4 w-4 mr-2" />
                Thêm phiếu lẻ
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleAddBatch("EXPENSE")}>
                <Layers className="h-4 w-4 mr-2" />
                Thêm phiếu tổng
                <span className="ml-auto text-[10px] text-muted-foreground">
                  Gom nhiều tòa
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
        </div>

        <IncomeExpenseFiltersBar
          filters={filters}
          onChange={handleFiltersChange}
        />

        <IncomeExpenseStats stats={statsData} isLoading={isStatsLoading} />

        {/* View mode toggle + Search */}
        <div className="flex items-center gap-2">
          <Tabs value={viewMode} onValueChange={handleViewModeChange}>
            <TabsList>
              <TabsTrigger value="individual" className="gap-1.5">
                <FileText className="h-4 w-4" />
                Phiếu lẻ
              </TabsTrigger>
              <TabsTrigger value="batch" className="gap-1.5">
                <Layers className="h-4 w-4" />
                Phiếu tổng (gom nhóm)
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="relative flex-1 max-w-md ml-auto">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Tìm tên/mã phiếu hoặc gõ số tiền (±5.000đ)..."
              value={searchQuery}
              onChange={handleSearchChange}
              className="pl-9"
            />
            {parsedSearch.amount != null && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5">
                ±5.000đ
              </span>
            )}
          </div>
        </div>

        {viewMode === "individual" ? (
          <IncomeExpenseList
            vouchers={vouchers}
            isLoading={isLoading}
            onView={handleView}
            onCancel={handleCancelVoucher}
            onStopRecurring={(id) => stopRecurringMutation.mutate(id)}
            onEdit={handleEditVoucher}
            onQuickEdit={handleQuickEditVoucher}
            onApprove={handleApproveVoucher}
            onVerify={handleVerifyVoucher}
            pagination={pagination}
            totalCount={totalCount}
          />
        ) : (
          <IncomeExpenseBatchList
            batches={batches}
            isLoading={isBatchLoading}
            onView={handleViewBatch}
            onCancel={handleCancelBatch}
            onEdit={handleViewBatch}
            pagination={pagination}
            totalCount={batchTotalCount}
          />
        )}
      </div>

      <IncomeExpenseForm
        open={isFormOpen}
        onOpenChange={handleFormClose}
        voucher={null}
        defaultType={formType}
      />
      <IncomeExpenseForm
        open={!!editingVoucher}
        onOpenChange={handleEditFormClose}
        voucher={editingVoucher}
      />
      <IncomeExpenseBatchForm
        open={isBatchFormOpen}
        onOpenChange={setIsBatchFormOpen}
        defaultType={formType}
      />
      <IncomeExpenseDetailDialog
        open={!!detailVoucher}
        onOpenChange={(o) => {
          if (!o) setDetailVoucher(null);
        }}
        voucher={detailVoucher}
        onCancel={handleCancelVoucher}
        onEdit={handleEditVoucher}
        onQuickEdit={handleQuickEditVoucher}
        onApprove={handleApproveVoucher}
      />
      <IncomeExpenseQuickEditDialog
        open={!!quickEditVoucher}
        onOpenChange={handleQuickEditClose}
        voucher={quickEditVoucher}
      />
      <IncomeExpenseVerifyDialog
        open={!!verifyVoucher}
        onOpenChange={handleVerifyClose}
        voucher={verifyVoucher}
      />
      <IncomeExpenseBatchDetailDialog
        open={!!detailBatch}
        onOpenChange={(o) => {
          if (!o) setDetailBatchId(null);
        }}
        batch={detailBatch}
        onCancel={handleCancelBatch}
        onEditVoucher={handleEditVoucher}
        onCancelVoucher={handleCancelVoucher}
        onApproveVoucher={handleApproveVoucher}
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

      <AlertDialog
        open={!!approveTarget}
        onOpenChange={() => setApproveTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận duyệt phiếu</AlertDialogTitle>
            <AlertDialogDescription>
              Sau khi duyệt, phiếu sẽ được tính vào <b>tồn quỹ</b> và không
              còn chỉnh sửa được. Hãy chắc chắn đã thanh toán cho người nhận.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Đóng</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmApprove}
              className="bg-green-600 hover:bg-green-700"
            >
              Duyệt phiếu
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!cancelBatchTarget}
        onOpenChange={() => setCancelBatchTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận huỷ cả đợt</AlertDialogTitle>
            <AlertDialogDescription>
              Tất cả phiếu trong đợt sẽ được đánh dấu <b>Đã huỷ</b> cùng lúc và
              không còn ảnh hưởng đến tồn quỹ. Các phiếu vẫn được lưu lại trong
              lịch sử.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Đóng</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmCancelBatch}
              className="bg-red-600 hover:bg-red-700"
            >
              Huỷ cả đợt
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </MainLayout>
  );
};

export default IncomeExpensePage;
