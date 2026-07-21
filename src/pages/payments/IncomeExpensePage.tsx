import { useState, useCallback, useEffect, lazy, Suspense } from "react";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import AttachmentUpload from "@/components/income-expenses/AttachmentUpload";
import { useAccounts } from "@/hooks/useAccounts";
import { useAuth } from "@/hooks/useAuth";
import { Plus, Upload, Search, Receipt, ListFilter, RefreshCcw, ChevronDown, Layers, FileText } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IncomeExpenseStats } from "@/components/income-expenses/IncomeExpenseStats";
import { IncomeExpenseFiltersBar } from "@/components/income-expenses/IncomeExpenseFilters";
import IncomeExpenseFilterPanel from "@/components/income-expenses/IncomeExpenseFilterPanel";
import IncomeExpenseList from "@/components/income-expenses/IncomeExpenseList";
import IncomeExpenseForm from "@/components/income-expenses/IncomeExpenseForm";
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
  useRestoreIncomeExpense,
  useApproveVoucher,
  useUnapproveVoucher,
  useQuickUpdateIncomeExpense,
  useGenerateRecurringVouchers,
  useStopRecurring,
  useIncomeExpenseBatches,
  useCancelIncomeExpenseBatch,
  EMPTY_INCOME_EXPENSE_FILTERS,
  type IncomeExpenseWithRelations,
} from "@/hooks/useIncomeExpenses";
import type { IncomeExpenseFilters } from "@/hooks/useIncomeExpenses";
import { usePagination } from "@/hooks/usePagination";
import { usePhoneViewport } from "@/hooks/use-mobile";
import { useRoomIdsByCode } from "@/hooks/useRoomIdsByCode";
import { isRoomCodeQuery, resolveSearch } from "@/lib/roomCodeSearch";
import { usePersistedState } from "@/hooks/usePersistedState";

const IncomeExpenseMobilePage = lazy(() => import("./IncomeExpenseMobilePage"));

const EMPTY_FILTERS: IncomeExpenseFilters = EMPTY_INCOME_EXPENSE_FILTERS;

const IncomeExpenseDesktopPage = () => {
  const [searchParams, setSearchParams] = useSearchParams();

  // Giữ qua F5 (sessionStorage); ?account_id trên URL vẫn THẮNG nhờ effect dưới.
  const [filters, setFilters] = usePersistedState<IncomeExpenseFilters>("flt:income-expense:filters", () => {
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

  const [searchQuery, setSearchQuery] = usePersistedState("flt:income-expense:search", "");
  const [viewMode, setViewMode] = usePersistedState<"individual" | "batch">("flt:income-expense:viewMode", "individual");
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isBatchFormOpen, setIsBatchFormOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isFilterPanelOpen, setIsFilterPanelOpen] = useState(false);
  const [detailVoucher, setDetailVoucher] =
    useState<IncomeExpenseWithRelations | null>(null);
  const [editingVoucher, setEditingVoucher] =
    useState<IncomeExpenseWithRelations | null>(null);
  // Tạo bản sao từ phiếu đã huỷ: mở form TẠO MỚI prefill toàn bộ (kể cả ảnh).
  const [copyVoucher, setCopyVoucher] =
    useState<IncomeExpenseWithRelations | null>(null);
  const [quickEditVoucher, setQuickEditVoucher] =
    useState<IncomeExpenseWithRelations | null>(null);
  const [verifyVoucher, setVerifyVoucher] =
    useState<IncomeExpenseWithRelations | null>(null);
  const [detailBatchId, setDetailBatchId] = useState<string | null>(null);
  const [formType, setFormType] = useState<"INCOME" | "EXPENSE">("INCOME");
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [approveTarget, setApproveTarget] =
    useState<IncomeExpenseWithRelations | null>(null);
  // Duyệt phiếu: cho bổ sung/đổi sổ quỹ + đính kèm ngay trước khi ghi vào tồn quỹ.
  const [approveAccountId, setApproveAccountId] = useState<string>("");
  const [approveAttachments, setApproveAttachments] = useState<string[]>([]);
  const [unapproveTarget, setUnapproveTarget] = useState<string | null>(null);
  const [cancelBatchTarget, setCancelBatchTarget] = useState<string | null>(null);

  const pagination = usePagination(20);

  // Tìm kiếm: ưu tiên MÃ PHÒNG → nếu không có phòng nào mới tìm theo số tiền
  // (±5.000đ) hoặc tên/mã phiếu như cũ.
  const buildingIds = filters.building_ids ?? [];
  const trimmedSearch = searchQuery.trim();
  const roomCode = isRoomCodeQuery(trimmedSearch) ? trimmedSearch : null;
  const { data: roomLookup } = useRoomIdsByCode(
    roomCode,
    buildingIds.length ? buildingIds : undefined
  );
  const parsedSearch = resolveSearch(searchQuery, roomLookup);

  const effectiveFilters: IncomeExpenseFilters = {
    ...filters,
    building_ids: buildingIds.length ? buildingIds : undefined,
    // Tương thích: useIncomeExpenseBatches (Phiếu tổng) chưa đọc building_ids —
    // chọn đúng 1 toà thì truyền kèm building_id đơn để view đó vẫn lọc được
    // (với list/stats, building_ids ưu tiên nên không đổi kết quả).
    building_id: buildingIds.length === 1 ? buildingIds[0] : null,
    // B4: lớp phiếu — mặc định TIỀN THẬT; user đổi qua tab (null = Tất cả).
    layer: filters.layer === undefined ? 'CASH' : filters.layer,
    amount_target: parsedSearch.amountTarget,
    // Tìm theo mã phòng → ghi đè bộ lọc phòng (nếu có) bằng các phòng khớp.
    room_ids: parsedSearch.roomIds ?? filters.room_ids,
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
      parsedSearch.text,
      // Chỉ fetch Phiếu tổng khi đang xem tab đó — đỡ 1 query nặng mỗi lần
      // tải trang ở tab Phiếu lẻ (mặc định).
      { enabled: viewMode === "batch" }
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
  const restoreMutation = useRestoreIncomeExpense();
  const cancelBatchMutation = useCancelIncomeExpenseBatch();
  const approveMutation = useApproveVoucher();
  const unapproveMutation = useUnapproveVoucher();
  const quickUpdateMutation = useQuickUpdateIncomeExpense();
  const generateRecurringMutation = useGenerateRecurringVouchers();
  const stopRecurringMutation = useStopRecurring();

  const { data: accounts = [] } = useAccounts();
  const { data: authUser } = useAuth();
  const isShareholderPayout = !!approveTarget?.shareholder_id;
  const approvalAccounts = isShareholderPayout
    ? accounts.filter((account) => !account.is_virtual)
    : accounts;

  // Nạp giá trị hiện tại của phiếu mỗi khi mở hộp thoại duyệt.
  useEffect(() => {
    if (approveTarget) {
      const currentAccount = accounts.find(
        (account) => account.id === approveTarget.account_id,
      );
      setApproveAccountId(
        approveTarget.shareholder_id && currentAccount?.is_virtual
          ? ""
          : approveTarget.account_id ?? "",
      );
      setApproveAttachments(approveTarget.attachments ?? []);
    }
  }, [accounts, approveTarget]);

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

  const handleApproveVoucher = useCallback(
    (voucher: IncomeExpenseWithRelations) => {
      setApproveTarget(voucher);
    },
    []
  );

  // Nếu người dùng đổi sổ quỹ hoặc thêm/bớt ảnh thì lưu trước
  // (update_income_expense_quick chỉ áp cho phiếu nháp) rồi mới ghi vào tồn quỹ.
  const confirmApprove = useCallback(async () => {
    const target = approveTarget;
    if (!target) return;
    const nextAccountId = approveAccountId || null;
    const accountChanged = nextAccountId !== (target.account_id ?? null);
    const prevAttachments = target.attachments ?? [];
    const attachmentsChanged =
      JSON.stringify(prevAttachments) !== JSON.stringify(approveAttachments);
    try {
      if (accountChanged || attachmentsChanged) {
        await quickUpdateMutation.mutateAsync({
          id: target.id,
          account_id: nextAccountId,
          attachments: approveAttachments,
          notes: target.notes ?? null,
        });
      }
      await approveMutation.mutateAsync(target.id);
      setApproveTarget(null);
    } catch {
      // toast đã hiển thị trong hook; giữ hộp thoại để người dùng thử lại.
    }
  }, [approveTarget, approveAccountId, approveAttachments, approveMutation, quickUpdateMutation]);

  const handleUnapproveVoucher = useCallback((id: string) => {
    setUnapproveTarget(id);
  }, []);

  const confirmUnapprove = useCallback(() => {
    if (unapproveTarget) {
      unapproveMutation.mutate(unapproveTarget);
    }
    setUnapproveTarget(null);
  }, [unapproveTarget, unapproveMutation]);

  const handleCancelVoucher = useCallback((id: string) => {
    setCancelTarget(id);
  }, []);

  const handleRestoreVoucher = useCallback((id: string) => {
    setRestoreTarget(id);
  }, []);

  const confirmRestore = useCallback(() => {
    if (restoreTarget) {
      restoreMutation.mutate(restoreTarget);
    }
    setRestoreTarget(null);
  }, [restoreTarget, restoreMutation]);

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
    internalCount: 0,
    internalIncome: 0,
    internalExpense: 0,
    pendingCount: 0,
    pendingTotal: 0,
  };


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

        <IncomeExpenseStats
          stats={statsData}
          isLoading={isStatsLoading}
          onShowInternal={() => handleFiltersChange({ ...filters, layer: 'INTERNAL' })}
          onShowPending={() => handleFiltersChange({ ...filters, layer: 'PENDING' })}
        />

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
          {/* B4: LỚP phiếu — Tiền thật (mặc định) / Nội bộ / Chờ xử lý / Tất cả */}
          {viewMode === "individual" && (
            <Tabs
              value={filters.layer === undefined ? 'CASH' : filters.layer ?? 'ALL'}
              onValueChange={(v) =>
                handleFiltersChange({
                  ...filters,
                  layer: v === 'ALL' ? null : (v as 'CASH' | 'INTERNAL' | 'PENDING'),
                })
              }
            >
              <TabsList>
                <TabsTrigger value="CASH">Tiền thật</TabsTrigger>
                <TabsTrigger value="INTERNAL" className="gap-1">
                  Nội bộ
                  {(statsData.internalCount ?? 0) > 0 && (
                    <span className="rounded-full bg-slate-200 px-1.5 text-[11px] tabular-nums">
                      {statsData.internalCount}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="PENDING" className="gap-1">
                  Chờ xử lý
                  {(statsData.pendingCount ?? 0) > 0 && (
                    <span className="rounded-full bg-amber-200 px-1.5 text-[11px] tabular-nums">
                      {statsData.pendingCount}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="ALL">Tất cả</TabsTrigger>
              </TabsList>
            </Tabs>
          )}
          <div className="relative flex-1 max-w-md ml-auto">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Tìm mã phòng, tên/mã phiếu hoặc số tiền (±5.000đ)..."
              value={searchQuery}
              onChange={handleSearchChange}
              className="pl-9"
            />
            {parsedSearch.mode === "room" && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded px-1.5 py-0.5">
                mã phòng
              </span>
            )}
            {parsedSearch.mode === "amount" && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5">
                ±5.000đ
              </span>
            )}
          </div>
        </div>

        {viewMode === "individual" ? (
          <IncomeExpenseList
            vouchers={vouchers}
            isLoading={isLoading || parsedSearch.pending}
            onView={handleView}
            onCancel={handleCancelVoucher}
            onRestore={handleRestoreVoucher}
            onStopRecurring={(id) => stopRecurringMutation.mutate(id)}
            onEdit={handleEditVoucher}
            onQuickEdit={handleQuickEditVoucher}
            onApprove={handleApproveVoucher}
            onUnapprove={handleUnapproveVoucher}
            onVerify={handleVerifyVoucher}
            onCopy={(v) => setCopyVoucher(v)}
            pagination={pagination}
            totalCount={totalCount}
          />
        ) : (
          <IncomeExpenseBatchList
            batches={batches}
            isLoading={isBatchLoading || parsedSearch.pending}
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
      {/* Form "Tạo bản sao" từ phiếu đã huỷ — chế độ tạo mới, prefill toàn bộ */}
      <IncomeExpenseForm
        open={!!copyVoucher}
        onOpenChange={(o) => {
          if (!o) setCopyVoucher(null);
        }}
        voucher={null}
        copyFrom={copyVoucher}
        defaultType={copyVoucher?.type}
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
        onRestore={handleRestoreVoucher}
        onEdit={handleEditVoucher}
        onQuickEdit={handleQuickEditVoucher}
        onApprove={handleApproveVoucher}
        onUnapprove={handleUnapproveVoucher}
        onCopy={(v) => setCopyVoucher(v)}
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
        open={!!restoreTarget}
        onOpenChange={() => setRestoreTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận khôi phục phiếu</AlertDialogTitle>
            <AlertDialogDescription>
              Phiếu sẽ trở lại trạng thái <b>Đã ghi nhận</b> và tính lại vào{" "}
              <b>tồn quỹ</b>. Nếu là phiếu thu theo hoá đơn, khoản thanh toán
              tương ứng trên hoá đơn cũng được phục hồi. Thao tác được ghi vào
              lịch sử của phiếu.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Đóng</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmRestore}
              className="bg-green-600 hover:bg-green-700"
            >
              Khôi phục
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!approveTarget}
        onOpenChange={(o) => {
          if (!o) setApproveTarget(null);
        }}
      >
        <AlertDialogContent className="max-h-[90vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận duyệt phiếu</AlertDialogTitle>
            <AlertDialogDescription>
              Sau khi duyệt, phiếu sẽ được tính vào <b>tồn quỹ</b> và không
              còn chỉnh sửa được. Hãy chắc chắn đã thanh toán cho người nhận.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="approve-account">Sổ quỹ</Label>
              <Select
                value={approveAccountId}
                onValueChange={setApproveAccountId}
              >
                <SelectTrigger id="approve-account">
                  <SelectValue placeholder="Chọn sổ quỹ" />
                </SelectTrigger>
                <SelectContent>
                  {approvalAccounts.map((acc) => (
                    <SelectItem key={acc.id} value={acc.id}>
                      {acc.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Bổ sung hoặc đổi sổ quỹ ghi nhận phiếu này trước khi duyệt.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Hình ảnh đính kèm</Label>
              <AttachmentUpload
                attachments={approveAttachments}
                onChange={setApproveAttachments}
                userId={authUser?.id ?? approveTarget?.user_id ?? ""}
              />
            </div>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={approveMutation.isPending || quickUpdateMutation.isPending}
            >
              Đóng
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                confirmApprove();
              }}
              disabled={
                approveMutation.isPending ||
                quickUpdateMutation.isPending ||
                (isShareholderPayout && !approveAccountId)
              }
              className="bg-green-600 hover:bg-green-700"
            >
              {approveMutation.isPending || quickUpdateMutation.isPending
                ? "Đang duyệt…"
                : "Duyệt phiếu"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!unapproveTarget}
        onOpenChange={() => setUnapproveTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận huỷ duyệt phiếu</AlertDialogTitle>
            <AlertDialogDescription>
              Phiếu sẽ chuyển về trạng thái <b>Nháp</b> và không còn tính vào{" "}
              <b>tồn quỹ</b> cho đến khi duyệt lại. Dùng khi cần chỉnh sửa phiếu
              đã ghi nhận.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Đóng</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmUnapprove}
              className="bg-amber-600 hover:bg-amber-700"
            >
              Huỷ duyệt
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

// Mobile (≤767px): trang app full-screen riêng (warm-neutral) — khởi tạo đồng bộ
// từ matchMedia để không nháy desktop / không mount query nặng trên điện thoại.
export default function IncomeExpensePage() {
  const isPhone = usePhoneViewport();
  if (isPhone) {
    return (
      <Suspense fallback={null}>
        <IncomeExpenseMobilePage />
      </Suspense>
    );
  }
  return <IncomeExpenseDesktopPage />;
}
