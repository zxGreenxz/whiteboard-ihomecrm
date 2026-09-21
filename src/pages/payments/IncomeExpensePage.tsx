import { useOrganization } from "@/contexts/OrganizationContext";
import { useIncomeExpenseActions } from "@/hooks/income-expenses/useIncomeExpenseActions";
import { IncomeExpenseActionDialogs } from "@/components/income-expenses/IncomeExpenseActionDialogs";
import { useCopilotPageContext } from "@/hooks/useCopilotPageContext";
import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  lazy,
  Suspense,
} from "react";
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
import { useAuth } from "@/hooks/useAuth";
import {
  Plus,
  Upload,
  Search,
  Receipt,
  ListFilter,
  RefreshCcw,
  ChevronDown,
  Layers,
  FileText,
} from "lucide-react";
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
import { useIncomeExpenseSupplements } from "@/hooks/income-expenses/supplements";
import IncomeExpenseVerifyDialog from "@/components/income-expenses/IncomeExpenseVerifyDialog";
import IncomeExpenseImportDialog from "@/components/income-expenses/IncomeExpenseImportDialog";
import IncomeExpenseBatchForm from "@/components/income-expenses/IncomeExpenseBatchForm";
import IncomeExpenseBatchList from "@/components/income-expenses/IncomeExpenseBatchList";
import IncomeExpenseBatchDetailDialog from "@/components/income-expenses/IncomeExpenseBatchDetailDialog";
import {
  useIncomeExpenses,
  useIncomeExpenseStats,
  useRestoreIncomeExpense,
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
import {
  IE_APPROVAL_STATUS_PARAM_VALUES,
  IE_LAYER_PARAM_VALUES,
} from "@/lib/notificationRoutes";
import VoucherHistoryDialog from "@/components/income-expenses/VoucherHistoryDialog";

const IncomeExpenseMobilePage = lazy(() => import("./IncomeExpenseMobilePage"));

const EMPTY_FILTERS: IncomeExpenseFilters = EMPTY_INCOME_EXPENSE_FILTERS;

// Khoá sessionStorage của bộ lọc — dùng lại ở effect khôi phục sau deep-link,
// nên khai hằng để hai chỗ không trôi khỏi nhau.
const FILTERS_STORAGE_KEY = "flt:income-expense:filters";

const IncomeExpenseDesktopPage = () => {
  const [searchParams, setSearchParams] = useSearchParams();

  // Giữ qua F5 (sessionStorage); param trên URL vẫn THẮNG nhờ effect deep-link.
  const [filters, setFilters] = usePersistedState<IncomeExpenseFilters>(
    FILTERS_STORAGE_KEY,
    () => {
      const accountId = searchParams.get("account_id");
      return accountId
        ? { ...EMPTY_FILTERS, account_id: accountId }
        : EMPTY_FILTERS;
    },
  );

  const [searchQuery, setSearchQuery] = usePersistedState(
    "flt:income-expense:search",
    "",
  );
  // Search đẩy xuống server (list + stats RPC + rooms-lookup) → debounce 350ms
  // như mobile để mỗi phím không bắn đồng thời list + RPC stats; input vẫn hiển
  // thị searchQuery nên gõ phản hồi tức thì. Khởi tạo từ giá trị khôi phục để
  // F5 không fetch 2 lần.
  const [debouncedSearch, setDebouncedSearch] = useState(() => searchQuery);
  const [viewMode, setViewMode] = usePersistedState<"individual" | "batch">(
    "flt:income-expense:viewMode",
    "individual",
  );
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
  const [verifyVoucher, setVerifyVoucher] =
    useState<IncomeExpenseWithRelations | null>(null);
  // Đợt 4: màn đọc lại mốc lập/duyệt/huỷ + nhật ký thay đổi trước/sau.
  const [historyVoucher, setHistoryVoucher] =
    useState<IncomeExpenseWithRelations | null>(null);
  const [detailBatchId, setDetailBatchId] = useState<string | null>(null);
  const [formType, setFormType] = useState<"INCOME" | "EXPENSE">("INCOME");
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [cancelBatchTarget, setCancelBatchTarget] = useState<string | null>(
    null,
  );

  const pagination = usePagination(20);
  // setPage là useCallback ổn định, còn `pagination` là object MỚI mỗi render —
  // đưa cả object vào deps effect dưới là reset trang mỗi render.
  const { setPage } = pagination;

  // ── Deep-link vào trang Thu chi ───────────────────────────────────────────
  //  ?account_id=<uuid>                        → lọc theo sổ quỹ (đường cũ, từ màn Sổ quỹ)
  //  ?approval_status=UNAPPROVED&layer=PENDING → thông báo "Phiếu chờ bạn duyệt"
  //
  // BẮT BUỘC có `layer` đi kèm khi lọc theo approval_status: lớp mặc định CASH
  // tự ép thêm `.eq('approval_status','APPROVED')`, mà postgrest-js append 2 `.eq`
  // cùng cột thành AND ⇒ danh sách ra 0 DÒNG (bẫy đã đo).
  //
  // Deps là [searchParams] (KHÔNG phải [] như trước) để bấm thông báo lúc đang
  // đứng sẵn ở /income-expense cũng áp được bộ lọc. Chống lặp: xử lý xong là xoá
  // param khỏi URL + nhớ chữ ký query vừa xử lý.
  const handledDeepLinkRef = useRef<string | null>(null);
  // `filters` là usePersistedState (sessionStorage) ⇒ ép layer/approval_status là
  // GHI ĐÈ bộ lọc user đã chọn, còn dính lại sau khi rời trang. Chụp đúng chuỗi
  // đã lưu TRƯỚC khi ép và trả lại nguyên trạng lúc unmount.
  const savedFiltersSnapshotRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const accountId = searchParams.get("account_id");
    const rawApproval = searchParams.get("approval_status");
    const rawLayer = searchParams.get("layer");
    if (!accountId && !rawApproval && !rawLayer) {
      handledDeepLinkRef.current = null;
      return;
    }
    const signature = `${accountId ?? ""}|${rawApproval ?? ""}|${rawLayer ?? ""}`;
    if (handledDeepLinkRef.current === signature) return;
    handledDeepLinkRef.current = signature;

    const approvalStatus =
      rawApproval && IE_APPROVAL_STATUS_PARAM_VALUES.has(rawApproval)
        ? (rawApproval as IncomeExpenseFilters["approval_status"])
        : null;
    const layer =
      rawLayer && IE_LAYER_PARAM_VALUES.has(rawLayer)
        ? (rawLayer as IncomeExpenseFilters["layer"])
        : null;
    // Link chạm tới danh sách ⇒ cặp (approval_status, layer) do LINK quyết định
    // HOÀN TOÀN, không trộn với giá trị đang lưu. Trộn là đẻ ra tổ hợp mâu thuẫn
    // ⇒ 0 DÒNG: lớp CASH ép `.eq('APPROVED')` cạnh `.eq('UNAPPROVED')`, lớp
    // PENDING ép `.neq('CANCELLED')` cạnh `.eq('CANCELLED')`.
    // Thiếu vế nào thì lấy mặc định trung tính: approval `ALL_ACTIVE`, layer null
    // (= "Tất cả", không ràng buộc lớp).
    const hasListIntent = approvalStatus !== null || layer !== null;

    if (hasListIntent && savedFiltersSnapshotRef.current === undefined) {
      try {
        savedFiltersSnapshotRef.current =
          sessionStorage.getItem(FILTERS_STORAGE_KEY);
      } catch {
        savedFiltersSnapshotRef.current = null;
      }
    }

    setFilters((f) => ({
      ...f,
      ...(accountId ? { account_id: accountId } : null),
      ...(hasListIntent
        ? { approval_status: approvalStatus ?? "ALL_ACTIVE", layer }
        : null),
    }));
    setPage(1);

    // Xoá query để URL sạch — filter chip vẫn hiển thị cái đang lọc.
    const next = new URLSearchParams(searchParams);
    next.delete("account_id");
    next.delete("approval_status");
    next.delete("layer");
    setSearchParams(next, { replace: true });
  }, [searchParams, setFilters, setSearchParams, setPage]);

  // Rời trang → trả bộ lọc đã lưu về đúng trạng thái trước deep-link. Phải ghi
  // THẲNG sessionStorage: setState lúc unmount không còn effect nào chạy để lưu.
  useEffect(
    () => () => {
      const snapshot = savedFiltersSnapshotRef.current;
      if (snapshot === undefined) return;
      try {
        if (snapshot === null) sessionStorage.removeItem(FILTERS_STORAGE_KEY);
        else sessionStorage.setItem(FILTERS_STORAGE_KEY, snapshot);
      } catch {
        // Storage bị chặn — bỏ qua, bộ lọc chỉ không khôi phục được.
      }
    },
    [],
  );

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 350);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // Về trang 1 khi GIÁ TRỊ DEBOUNCED đổi, KHÔNG phải mỗi phím: chỉ debouncedSearch
  // vào queryKey, nên setPage(1) ngay trong handler gõ bắn thêm 1 request key
  // trung gian (trang 1 + từ khoá CŨ) hoàn toàn phí. Bỏ qua lần chạy đầu để
  // không xoá trang đang xem khi khôi phục search từ sessionStorage.
  const searchPageResetRef = useRef(false);
  useEffect(() => {
    if (!searchPageResetRef.current) {
      searchPageResetRef.current = true;
      return;
    }
    setPage(1);
  }, [debouncedSearch, setPage]);

  // Tìm kiếm: ưu tiên MÃ PHÒNG → nếu không có phòng nào mới tìm theo số tiền
  // (±5.000đ) hoặc tên/mã phiếu như cũ.
  const buildingIds = filters.building_ids ?? [];
  const trimmedSearch = debouncedSearch.trim();
  const roomCode = isRoomCodeQuery(trimmedSearch) ? trimmedSearch : null;
  const { data: roomLookup } = useRoomIdsByCode(
    roomCode,
    buildingIds.length ? buildingIds : undefined,
  );
  const parsedSearch = resolveSearch(debouncedSearch, roomLookup);

  const effectiveFilters: IncomeExpenseFilters = {
    ...filters,
    building_ids: buildingIds.length ? buildingIds : undefined,
    // Tương thích: useIncomeExpenseBatches (Phiếu tổng) chưa đọc building_ids —
    // chọn đúng 1 toà thì truyền kèm building_id đơn để view đó vẫn lọc được
    // (với list/stats, building_ids ưu tiên nên không đổi kết quả).
    building_id: buildingIds.length === 1 ? buildingIds[0] : null,
    // B4: lớp phiếu — mặc định TIỀN THẬT; user đổi qua tab (null = Tất cả).
    layer: filters.layer === undefined ? "CASH" : filters.layer,
    amount_target: parsedSearch.amountTarget,
    // Tìm theo mã phòng → ghi đè bộ lọc phòng (nếu có) bằng các phòng khớp.
    room_ids: parsedSearch.roomIds ?? filters.room_ids,
  };

  useCopilotPageContext(
    "income-expenses.list",
    { ...effectiveFilters, search: parsedSearch.text, view: viewMode },
    detailVoucher,
  );
  // keepPreviousData: màn danh sách phân trang — giữ trang cũ để bảng không nhảy
  // về skeleton mỗi lần đổi trang/filter (opt-in ở consumer, xem useIncomeExpenses).
  const { data: listResult, isLoading } = useIncomeExpenses(
    effectiveFilters,
    { page: pagination.page, pageSize: pagination.pageSize },
    parsedSearch.text,
    { keepPreviousData: true },
  );

  const { data: batchResult, isLoading: isBatchLoading } =
    useIncomeExpenseBatches(
      effectiveFilters,
      { page: pagination.page, pageSize: pagination.pageSize },
      parsedSearch.text,
      // Chỉ fetch Phiếu tổng khi đang xem tab đó — đỡ 1 query nặng mỗi lần
      // tải trang ở tab Phiếu lẻ (mặc định).
      { enabled: viewMode === "batch" },
    );

  const vouchers = listResult?.data ?? [];
  const detailSupplements = useIncomeExpenseSupplements(
    detailVoucher?.id,
    !!detailVoucher,
  );
  const totalCount = listResult?.totalCount ?? 0;
  const batches = batchResult?.data ?? [];
  const batchTotalCount = batchResult?.totalCount ?? 0;

  const detailBatch =
    detailBatchId !== null
      ? (batches.find((b) => b.id === detailBatchId) ?? null)
      : null;

  const { data: stats, isLoading: isStatsLoading } = useIncomeExpenseStats(
    effectiveFilters,
    { keepPreviousData: true },
  );
  const restoreMutation = useRestoreIncomeExpense();
  const cancelBatchMutation = useCancelIncomeExpenseBatch();
  const generateRecurringMutation = useGenerateRecurringVouchers();
  const stopRecurringMutation = useStopRecurring();
  const { data: authUser } = useAuth();
  const { selectedOrganizationId } = useOrganization();
  const actionRows = useRef(new Map<string, IncomeExpenseWithRelations>());
  const actions = useIncomeExpenseActions({
    scope: {
      actorId: authUser?.id ?? "",
      organizationId: selectedOrganizationId ?? "",
    },
    voucherIds: [
      ...vouchers.map((v) => v.id),
      ...(detailVoucher ? [detailVoucher.id] : []),
    ],
    onEdit: (id) => {
      const row =
        actionRows.current.get(id) ??
        vouchers.find((v) => v.id === id) ??
        (detailVoucher?.id === id ? detailVoucher : null);
      if (row) setEditingVoucher(row);
    },
  });
  const rememberActionVoucher = (voucher: IncomeExpenseWithRelations) => {
    actionRows.current.set(voucher.id, voucher);
  };
  const handleEditVoucher = (voucher: IncomeExpenseWithRelations) => {
    rememberActionVoucher(voucher);
    actions.open("edit", voucher.id);
  };
  const handleQuickEditVoucher = (voucher: IncomeExpenseWithRelations) =>
    actions.open("supplement", voucher.id);
  const handleApproveVoucher = (voucher: IncomeExpenseWithRelations) =>
    actions.openApproval(voucher.id);
  const handleUnapproveVoucher = (id: string) => actions.open("unapprove", id);
  const handleCancelVoucher = (id: string) => actions.open("cancel", id);

  const handleFiltersChange = useCallback(
    (newFilters: IncomeExpenseFilters) => {
      setFilters(newFilters);
      pagination.setPage(1);
    },
    [pagination],
  );

  // Chỉ cập nhật ô nhập; reset trang do effect trên debouncedSearch lo.
  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearchQuery(e.target.value);
    },
    [setSearchQuery],
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

  const handleAddBatch = useCallback(
    (type: "INCOME" | "EXPENSE" = "EXPENSE") => {
      setFormType(type);
      setIsBatchFormOpen(true);
    },
    [],
  );

  const handleView = useCallback((voucher: IncomeExpenseWithRelations) => {
    setDetailVoucher(voucher);
  }, []);

  const handleViewBatch = useCallback((batchId: string) => {
    setDetailBatchId(batchId);
  }, []);

  const handleFormClose = useCallback((open: boolean) => {
    setIsFormOpen(open);
  }, []);

  const handleEditFormClose = useCallback((open: boolean) => {
    if (!open) setEditingVoucher(null);
  }, []);

  const handleVerifyVoucher = useCallback(
    (voucher: IncomeExpenseWithRelations) => {
      setVerifyVoucher(voucher);
    },
    [],
  );

  const handleVerifyClose = useCallback((open: boolean) => {
    if (!open) setVerifyVoucher(null);
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
    [pagination],
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
    pendingIncome: 0,
    pendingExpense: 0,
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
          onShowInternal={() =>
            handleFiltersChange({ ...filters, layer: "INTERNAL" })
          }
          onShowPending={() =>
            handleFiltersChange({ ...filters, layer: "PENDING" })
          }
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
              value={
                filters.layer === undefined ? "CASH" : (filters.layer ?? "ALL")
              }
              onValueChange={(v) =>
                handleFiltersChange({
                  ...filters,
                  layer:
                    v === "ALL" ? null : (v as "CASH" | "INTERNAL" | "PENDING"),
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
            onPostApproved={(v) => actions.open("post", v.id)}
            onReversePosting={(v) => actions.open("reverse", v.id)}
            onUnapprove={handleUnapproveVoucher}
            onVerify={handleVerifyVoucher}
            onCopy={(v) => setCopyVoucher(v)}
            onHistory={(v) => setHistoryVoucher(v)}
            actionContexts={actions.contexts}
            onApproveAndPost={(v) => actions.open("approveAndPost", v.id)}
            onRequestChanges={(v) => actions.open("requestChanges", v.id)}
            onResubmitReview={(v) => actions.open("resubmitReview", v.id)}
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
        actions={actions}
        onBeforeAction={rememberActionVoucher}
        open={!!detailVoucher}
        onOpenChange={(o) => {
          if (!o) setDetailVoucher(null);
        }}
        voucher={
          detailVoucher
            ? {
                ...detailVoucher,
                supplements:
                  detailSupplements.data ?? detailVoucher.supplements,
              }
            : null
        }
        onCancel={handleCancelVoucher}
        onRestore={handleRestoreVoucher}
        onEdit={handleEditVoucher}
        onQuickEdit={handleQuickEditVoucher}
        onApprove={handleApproveVoucher}
        onUnapprove={handleUnapproveVoucher}
        onCopy={(v) => setCopyVoucher(v)}
      />

      <IncomeExpenseVerifyDialog
        open={!!verifyVoucher}
        onOpenChange={handleVerifyClose}
        voucher={verifyVoucher}
      />
      {/* Đợt 4: lịch sử phiếu — mốc lập/duyệt/huỷ + lý do + nhật ký trước/sau. */}
      <IncomeExpenseActionDialogs controller={actions} />
      <VoucherHistoryDialog
        open={!!historyVoucher}
        onOpenChange={(o) => {
          if (!o) setHistoryVoucher(null);
        }}
        voucher={historyVoucher}
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
