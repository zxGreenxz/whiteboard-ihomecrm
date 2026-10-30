import { QuickExpenseProvider, usePageQuickExpense } from '@/components/income-expenses/QuickExpenseProvider';
import { QuickExpenseFeedback, QuickExpenseToolbar } from '@/components/income-expenses/QuickExpenseActions';
import { QueryRegion } from "@/components/errors/QueryRegion";
import { useIncomeExpenseDetail } from "@/hooks/income-expenses/detailRead";
import { useState, useCallback, useEffect, useMemo, useRef, lazy, Suspense } from "react";
import { useSearchParams } from "react-router-dom";
import MainLayout from "@/components/layout/MainLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import IncomeExpenseImportDialog from "@/components/income-expenses/IncomeExpenseImportDialog";
import IncomeExpenseBatchForm from "@/components/income-expenses/IncomeExpenseBatchForm";
import IncomeExpenseBatchList from "@/components/income-expenses/IncomeExpenseBatchList";
import IncomeExpenseBatchDetailDialog from "@/components/income-expenses/IncomeExpenseBatchDetailDialog";
import {
  useIncomeExpenses,
  useIncomeExpenseStats,
  useGenerateRecurringVouchers,
  useIncomeExpenseBatches,
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
// Thao tác trên phiếu + hộp xác nhận: một bộ dùng chung với trang điện thoại và Báo cáo lợi nhuận.
import { useVoucherActions } from "@/hooks/income-expenses/useVoucherActions";
import VoucherActionDialogs from "@/components/income-expenses/VoucherActionDialogs";

const IncomeExpenseMobilePage = lazy(() => import("./IncomeExpenseMobilePage"));

const EMPTY_FILTERS: IncomeExpenseFilters = EMPTY_INCOME_EXPENSE_FILTERS;

// Khoá sessionStorage của bộ lọc — dùng lại ở effect khôi phục sau deep-link,
// nên khai hằng để hai chỗ không trôi khỏi nhau.
const FILTERS_STORAGE_KEY = "flt:income-expense:filters";

const IncomeExpenseDesktopPage = () => {
  const [searchParams, setSearchParams] = useSearchParams();

  // Giữ qua F5 (sessionStorage); param trên URL vẫn THẮNG nhờ effect deep-link.
  const [filters, setFilters] = usePersistedState<IncomeExpenseFilters>(FILTERS_STORAGE_KEY, () => {
    const accountId = searchParams.get("account_id");
    return accountId
      ? { ...EMPTY_FILTERS, account_id: accountId }
      : EMPTY_FILTERS;
  });

  const [searchQuery, setSearchQuery] = usePersistedState("flt:income-expense:search", "");
  // Search đẩy xuống server (list + stats RPC + rooms-lookup) → debounce 350ms
  // như mobile để mỗi phím không bắn đồng thời list + RPC stats; input vẫn hiển
  // thị searchQuery nên gõ phản hồi tức thì. Khởi tạo từ giá trị khôi phục để
  // F5 không fetch 2 lần.
  const [debouncedSearch, setDebouncedSearch] = useState(() => searchQuery);
  const [viewMode, setViewMode] = usePersistedState<"individual" | "batch">("flt:income-expense:viewMode", "individual");
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isBatchFormOpen, setIsBatchFormOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isFilterPanelOpen, setIsFilterPanelOpen] = useState(false);
  const [detailVoucherId, setDetailVoucherId] = useState<string | null>(null);
  // Dòng danh sách vừa bấm: hiện NGAY làm bản xem trước (nút khoá tới khi bản đọc
  // mới về — chủ chốt 30/09/2026), và cho biết tổ chức để đọc song song. Không thay kiểm quyền.
  const [detailPreview, setDetailPreview] = useState<IncomeExpenseWithRelations | null>(null);
  const detailOrgHint = detailPreview?.organization_id ?? null;
  const setDetailVoucher = useCallback((value: IncomeExpenseWithRelations | null) => {
    setDetailVoucherId(value?.id ?? null);
    setDetailPreview(value);
  }, []);
  const selectedDetail = useIncomeExpenseDetail(detailVoucherId, true, detailOrgHint);
  // 'idle' = không đang đọc và không tạm dừng vì mất mạng (lúc đó dữ liệu có thể đã cũ).
  const detailVoucher = selectedDetail.isSuccess && selectedDetail.fetchStatus === "idle" ? selectedDetail.data ?? null : null;
  const [detailBatchId, setDetailBatchId] = useState<string | null>(null);
  const [formType, setFormType] = useState<"INCOME" | "EXPENSE">("INCOME");

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
        savedFiltersSnapshotRef.current = sessionStorage.getItem(FILTERS_STORAGE_KEY);
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
    buildingIds.length ? buildingIds : undefined
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
    layer: filters.layer === undefined ? 'CASH' : filters.layer,
    amount_target: parsedSearch.amountTarget,
    // Tìm theo mã phòng → ghi đè bộ lọc phòng (nếu có) bằng các phòng khớp.
    room_ids: parsedSearch.roomIds ?? filters.room_ids,
  };

  // keepPreviousData: màn danh sách phân trang — giữ trang cũ để bảng không nhảy
  // về skeleton mỗi lần đổi trang/filter (opt-in ở consumer, xem useIncomeExpenses).
  const listQuery = useIncomeExpenses(
    effectiveFilters,
    { page: pagination.page, pageSize: pagination.pageSize },
    parsedSearch.text,
    { keepPreviousData: true, inlineErrors: true }
  );
  const { data: listResult, isLoading, isError: listError, refetch: retryList } = listQuery;

  const batchQuery = useIncomeExpenseBatches(
      effectiveFilters,
      { page: pagination.page, pageSize: pagination.pageSize },
      parsedSearch.text,
      // Chỉ fetch Phiếu tổng khi đang xem tab đó — đỡ 1 query nặng mỗi lần
      // tải trang ở tab Phiếu lẻ (mặc định).
      { enabled: viewMode === "batch", inlineErrors: true }
    );
  const { data: batchResult, isLoading: isBatchLoading, isError: batchError, refetch: retryBatch } = batchQuery;

  const activeListQuery = viewMode === "individual" ? listQuery : batchQuery;
  const quickExpense = usePageQuickExpense(JSON.stringify([effectiveFilters, searchQuery, viewMode]), activeListQuery.isSuccess && !activeListQuery.isFetching && !activeListQuery.isPlaceholderData && !parsedSearch.pending);
  const vouchers = listResult?.data ?? [];
  const totalCount = listResult?.totalCount ?? 0;
  const batches = batchResult?.data ?? [];
  const batchTotalCount = batchResult?.totalCount ?? 0;

  const detailBatch =
    detailBatchId !== null
      ? batches.find((b) => b.id === detailBatchId) ?? null
      : null;

  const statsQuery = useIncomeExpenseStats(effectiveFilters, { keepPreviousData: true, inlineErrors: true });
  const { data: stats, isLoading: isStatsLoading } = statsQuery;

  const generateRecurringMutation = useGenerateRecurringVouchers();
  // Mọi thao tác trên phiếu (duyệt, chi, huỷ, khôi phục…) + hộp xác nhận: một bộ dùng chung với
  // trang điện thoại và Báo cáo lợi nhuận (useVoucherActions / VoucherActionDialogs). Phiếu đang
  // mở chi tiết cũng được hỏi máy chủ trước (nút Huỷ) dù không nằm trong trang danh sách.
  const listVouchers = listResult?.data;
  const actionVouchers = useMemo(() => {
    const list = listVouchers ?? [];
    return detailVoucher && !list.some((v) => v.id === detailVoucher.id) ? [...list, detailVoucher] : list;
  }, [listVouchers, detailVoucher]);
  const actions = useVoucherActions({ vouchers: actionVouchers });

  const handleFiltersChange = useCallback(
    (newFilters: IncomeExpenseFilters) => {
      setFilters(newFilters);
      pagination.setPage(1);
    },
    [pagination]
  );

  // Chỉ cập nhật ô nhập; reset trang do effect trên debouncedSearch lo.
  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearchQuery(e.target.value);
    },
    [setSearchQuery]
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

        <QueryRegion label="thống kê thu chi" queries={[statsQuery]} skeleton="cards" rows={3}>
        <IncomeExpenseStats
          stats={statsData}
          isLoading={isStatsLoading}
          onShowInternal={() => handleFiltersChange({ ...filters, layer: 'INTERNAL' })}
          onShowPending={() => handleFiltersChange({ ...filters, layer: 'PENDING' })}
        />
        </QueryRegion>

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

        {viewMode === "individual" ? <QuickExpenseToolbar quick={quickExpense} filters={effectiveFilters} search={parsedSearch.text} /> : <QuickExpenseFeedback quick={quickExpense} />}
        <QueryRegion label="danh sách phiếu thu chi" queries={[viewMode === "individual" ? listQuery : batchQuery]} skeleton="table" rows={8}>
        {viewMode === "individual" ? (
          <IncomeExpenseList
            quickExpense={quickExpense}
            vouchers={vouchers}
            isLoading={isLoading || parsedSearch.pending}
            onView={handleView}
            onCancel={actions.cancel}
            onRestore={actions.restore}
            onStopRecurring={actions.stopRecurring}
            onEdit={actions.edit}
            onQuickEdit={actions.quickEdit}
            onApprove={actions.approve}
            onPostApproved={actions.postApproved}
            onReversePosting={actions.reverse}
            onUnapprove={actions.unapprove}
            onVerify={actions.verify}
            onCopy={actions.copy}
            onHistory={actions.history}
            cancelEligibility={actions.cancelEligibility}
            incomeCancelEligibility={actions.incomeCancelEligibility}
            pagination={pagination}
            totalCount={totalCount}
          />
        ) : (
          <IncomeExpenseBatchList
            quickExpense={quickExpense}
            batches={batches}
            isLoading={isBatchLoading || parsedSearch.pending}
            onView={handleViewBatch}
            onCancel={actions.cancelBatch}
            onEdit={handleViewBatch}
            pagination={pagination}
            totalCount={batchTotalCount}
          />
        )}
        </QueryRegion>
      </div>

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
      <IncomeExpenseDetailDialog
        quickExpense={quickExpense}
        open={!!detailVoucherId}
        onOpenChange={(o) => {
          if (!o) setDetailVoucher(null);
        }}
        voucherId={detailVoucherId}
        organizationIdHint={detailOrgHint}
        previewVoucher={detailPreview}
        voucher={detailVoucher}
        onCancel={actions.cancel}
        onRestore={actions.restore}
        onEdit={actions.edit}
        onQuickEdit={actions.quickEdit}
        onApprove={actions.approve}
        onUnapprove={actions.unapprove}
        onCopy={actions.copy}
        onPostApproved={actions.postApproved}
        onReversePosting={actions.reverse}
        onVerify={actions.verify}
        onHistory={actions.history}
        onStopRecurring={actions.stopRecurring}
        cancelEligibility={actions.cancelEligibility}
        incomeCancelEligibility={actions.incomeCancelEligibility}
      />
      <IncomeExpenseBatchDetailDialog
        quickExpense={quickExpense}
        open={!!detailBatch}
        onOpenChange={(o) => {
          if (!o) setDetailBatchId(null);
        }}
        batch={detailBatch}
        onCancel={actions.cancelBatch}
        onEditVoucher={actions.edit}
        onCancelVoucher={actions.cancel}
        onApproveVoucher={actions.approve}
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

      {/* Hộp xác nhận + form của mọi thao tác phiếu — một bản dùng chung (useVoucherActions). */}
      <VoucherActionDialogs actions={actions} />
    </MainLayout>
  );
};

// Mobile (≤767px): trang app full-screen riêng (warm-neutral) — khởi tạo đồng bộ
// từ matchMedia để không nháy desktop / không mount query nặng trên điện thoại.
export default function IncomeExpensePage() {
  const isPhone = usePhoneViewport();
  return (
    <QuickExpenseProvider>
      {isPhone ? (
        <Suspense fallback={null}>
          <IncomeExpenseMobilePage />
        </Suspense>
      ) : <IncomeExpenseDesktopPage />}
    </QuickExpenseProvider>
  );
}
