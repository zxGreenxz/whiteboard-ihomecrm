import { useOrganization } from "@/contexts/OrganizationContext";
import { useIncomeExpenseActions } from "@/hooks/income-expenses/useIncomeExpenseActions";
import { IncomeExpenseActionDialogs } from "@/components/income-expenses/IncomeExpenseActionDialogs";
import { useCopilotPageContext } from "@/hooks/useCopilotPageContext";
import { useState, useEffect, useMemo, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Plus,
  Search,
  Filter,
  TrendingUp,
  Wallet,
  Coins,
  FileText,
  Layers,
  Zap,
  Share2,
  History,
  X,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Check,
} from "lucide-react";
import "@/styles/mobileApp.css";
import "@/styles/financeMobile.css";
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
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import {
  useIncomeExpenses,
  useIncomeExpenseStats,
  useIncomeExpenseBatches,
  useRestoreIncomeExpense,
  useCancelIncomeExpenseBatch,
  EMPTY_INCOME_EXPENSE_FILTERS,
  type IncomeExpenseWithRelations,
  type IncomeExpenseFilters,
} from "@/hooks/useIncomeExpenses";
import { usePagination } from "@/hooks/usePagination";
import { MOBILE_FIRST_PAGE_SIZE } from "@/lib/listPageSizes";
import { useRoomIdsByCode } from "@/hooks/useRoomIdsByCode";
import { isRoomCodeQuery, resolveSearch } from "@/lib/roomCodeSearch";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { canUse } from "@/lib/permissionPages";
import IncomeExpenseFilterPanel from "@/components/income-expenses/IncomeExpenseFilterPanel";
import IncomeExpenseFilterChips from "@/components/income-expenses/IncomeExpenseFilterChips";
import { voucherLayer } from "@/lib/voucherSources";
import { buildIncomeExpenseStatCards } from "@/lib/incomeExpenseStatCards";
import IncomeExpenseDetailMobile from "@/components/income-expenses/IncomeExpenseDetailMobile";
import IncomeExpenseForm from "@/components/income-expenses/IncomeExpenseForm";
import IncomeExpenseQuickCreateDialog from "@/components/income-expenses/IncomeExpenseQuickCreateDialog";
import IncomeExpenseBatchForm from "@/components/income-expenses/IncomeExpenseBatchForm";
import { useIncomeExpenseSupplements } from "@/hooks/income-expenses/supplements";
import IncomeExpenseBatchListMobile from "@/components/income-expenses/IncomeExpenseBatchListMobile";
import IncomeExpenseBatchDetailMobile from "@/components/income-expenses/IncomeExpenseBatchDetailMobile";
import PayViaBankAppSheet from "@/components/income-expenses/PayViaBankAppSheet";
import { usePersistedState } from "@/hooks/usePersistedState";
import {
  IE_APPROVAL_STATUS_PARAM_VALUES,
  IE_LAYER_PARAM_VALUES,
} from "@/lib/notificationRoutes";
// Finance V2 (route-aware §9.6/§12): duyệt-only / duyệt+ghi sổ atomic khi org CANONICAL.
import { useFinanceV2Routes, isCanonicalRead } from "@/lib/financeV2Route";
import {
  getVoucherDisplayState,
  type VoucherDisplayInput,
  type VoucherTone,
} from "@/lib/financeV2VoucherState";
import VoucherHistoryDialog from "@/components/income-expenses/VoucherHistoryDialog";
import {
  groupReversalVouchers,
  groupNetAmount,
} from "@/lib/voucherReversalGrouping";

const EMPTY_FILTERS: IncomeExpenseFilters = EMPTY_INCOME_EXPENSE_FILTERS;

// Khoá sessionStorage của bộ lọc — dùng lại ở effect khôi phục sau deep-link.
const FILTERS_STORAGE_KEY = "flt:income-expense-mb:filters";

// Màu vch-tag theo tone composite V2 (khớp bảng màu TONE_CLASSES desktop).
const V2_TAG_STYLES: Record<
  VoucherTone,
  { color: string; background: string }
> = {
  pending: { color: "#b45309", background: "#fef3c7" },
  changes: { color: "#c2410c", background: "#ffedd5" },
  disputed: { color: "#be123c", background: "#ffe4e6" },
  approved: { color: "#0369a1", background: "#e0f2fe" },
  posted: { color: "#1d4ed8", background: "#dbeafe" },
  reversed: { color: "#6d28d9", background: "#ede9fe" },
  cancelled: { color: "#b91c1c", background: "#fee2e2" },
};

const compact = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "tỷ";
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "tr";
  if (a >= 1e3) return (n / 1e3).toFixed(0) + "k";
  return n.toLocaleString("vi-VN");
};

const fmtDate = (s: string | null) => {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "—";
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
};

function countActiveFilters(f: IncomeExpenseFilters): number {
  return [
    f.type,
    (f.building_ids?.length ?? 0) > 0 || undefined,
    f.account_id,
    f.cash_book_id,
    f.income_type_id,
    f.expense_type_id,
    f.type_category,
    f.approval_status && f.approval_status !== "ALL_ACTIVE" ? true : undefined,
    f.start_date || f.end_date || undefined,
    f.period_start_month || f.period_end_month || undefined,
    f.verified_status,
    f.creator_id,
    f.source_group,
    f.room_id || (f.room_ids?.length ?? 0) > 0 || undefined,
  ].filter(Boolean).length;
}

/**
 * Thu chi — màn hình app full-screen trên mobile (web-app). Dựng theo handoff
 * Claude Design (ui_kits/mobile-app: CashbookScreen) nhưng nối DỮ LIỆU THẬT:
 * useIncomeExpenses + useIncomeExpenseStats + bộ lọc/đợt như desktop; chi tiết
 * phiếu mở bottom-sheet warm-neutral (IncomeExpenseDetailMobile). Nút ← về trang
 * chủ. Scope .cm-stage/.cm-app, ngoài MainLayout.
 */
export default function IncomeExpenseMobilePage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [search, setSearch] = usePersistedState(
    "flt:income-expense-mb:search",
    "",
  );
  const [debounced, setDebounced] = useState("");
  // Vào /income-expense?account_id=xxx (vd "Xem thu chi" từ 1 sổ quỹ) → lọc sẵn
  // theo sổ đó, ĐỒNG BỘ với desktop. Không có param → xem tất cả (RLS lọc).
  // Giữ qua F5 (sessionStorage); ?account_id trên URL vẫn THẮNG nhờ effect dưới.
  const [filters, setFilters] = usePersistedState<IncomeExpenseFilters>(
    FILTERS_STORAGE_KEY,
    () => {
      const accountId = searchParams.get("account_id");
      return accountId
        ? { ...EMPTY_FILTERS, account_id: accountId }
        : EMPTY_FILTERS;
    },
  );
  const [viewMode, setViewMode] = usePersistedState<"individual" | "batch">(
    "flt:income-expense-mb:viewMode",
    "individual",
  );
  const [filterOpen, setFilterOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const [detailVoucher, setDetailVoucher] =
    useState<IncomeExpenseWithRelations | null>(null);
  const [shareVoucher, setShareVoucher] =
    useState<IncomeExpenseWithRelations | null>(null);
  const [editingVoucher, setEditingVoucher] =
    useState<IncomeExpenseWithRelations | null>(null);
  // Tạo bản sao từ phiếu đã huỷ: form TẠO MỚI prefill toàn bộ (kể cả ảnh).
  const [copyVoucher, setCopyVoucher] =
    useState<IncomeExpenseWithRelations | null>(null);
  // Đợt 4: màn đọc lại mốc lập/duyệt/huỷ + nhật ký thay đổi trước/sau.
  const [historyVoucher, setHistoryVoucher] =
    useState<IncomeExpenseWithRelations | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isQuickOpen, setIsQuickOpen] = useState(false);
  const [isBatchFormOpen, setIsBatchFormOpen] = useState(false);
  const [formType, setFormType] = useState<"INCOME" | "EXPENSE">("INCOME");
  const [detailBatchId, setDetailBatchId] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [cancelBatchTarget, setCancelBatchTarget] = useState<string | null>(
    null,
  );

  // Trang đầu 15 (khớp MOBILE_FIRST_PAGE_SIZE prefetch từ màn chính — lệch là
  // trật cache key); "Tải thêm" vẫn nới +50.
  const pagination = usePagination(MOBILE_FIRST_PAGE_SIZE);
  const { setPage } = pagination;

  // ── Deep-link vào trang Thu chi (bản mobile) ─────────────────────────────
  //  ?account_id=<uuid>                        → lọc theo sổ quỹ (đường cũ)
  //  ?approval_status=UNAPPROVED&layer=PENDING → thông báo "Phiếu chờ bạn duyệt"
  //
  // `layer` là BẮT BUỘC khi lọc theo approval_status: lớp mặc định CASH tự ép
  // `.eq('approval_status','APPROVED')`, postgrest-js append 2 `.eq` cùng cột
  // thành AND ⇒ danh sách ra 0 DÒNG.
  //
  // Deps [searchParams] (trước là []) để bấm thông báo lúc đang ở sẵn trang này
  // cũng áp được lọc; chống lặp bằng cách xoá param + nhớ chữ ký đã xử lý.
  const handledDeepLinkRef = useRef<string | null>(null);
  // Bộ lọc nằm trong sessionStorage ⇒ ép layer là ghi đè lựa chọn của user.
  // Chụp chuỗi đã lưu trước khi ép, trả lại khi rời trang.
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
    // Cặp (approval_status, layer) do LINK quyết định hoàn toàn — trộn với giá
    // trị đang lưu là đẻ tổ hợp mâu thuẫn ⇒ 0 DÒNG (CASH ép `.eq('APPROVED')`
    // cạnh `.eq('UNAPPROVED')`; PENDING ép `.neq('CANCELLED')` cạnh
    // `.eq('CANCELLED')`). Thiếu vế nào lấy mặc định trung tính.
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

    const next = new URLSearchParams(searchParams);
    next.delete("account_id");
    next.delete("approval_status");
    next.delete("layer");
    setSearchParams(next, { replace: true });
  }, [searchParams, setFilters, setSearchParams, setPage]);

  // Rời trang → trả bộ lọc đã lưu về trạng thái trước deep-link. Ghi thẳng
  // sessionStorage vì lúc unmount không còn effect nào của usePersistedState chạy.
  useEffect(
    () => () => {
      const snapshot = savedFiltersSnapshotRef.current;
      if (snapshot === undefined) return;
      try {
        if (snapshot === null) sessionStorage.removeItem(FILTERS_STORAGE_KEY);
        else sessionStorage.setItem(FILTERS_STORAGE_KEY, snapshot);
      } catch {
        // Storage bị chặn — bỏ qua.
      }
    },
    [],
  );

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350);
    return () => clearTimeout(t);
  }, [search]);

  const buildingIds = filters.building_ids ?? [];
  const trimmedSearch = debounced.trim();
  const roomCode = isRoomCodeQuery(trimmedSearch) ? trimmedSearch : null;
  const { data: roomLookup } = useRoomIdsByCode(
    roomCode,
    buildingIds.length ? buildingIds : undefined,
  );
  const parsed = resolveSearch(debounced, roomLookup);
  const effectiveFilters: IncomeExpenseFilters = {
    ...filters,
    building_ids: buildingIds.length ? buildingIds : undefined,
    building_id: buildingIds.length === 1 ? buildingIds[0] : null,
    // B4: lớp phiếu — mặc định TIỀN THẬT (null = Tất cả).
    layer: filters.layer === undefined ? "CASH" : filters.layer,
    amount_target: parsed.amountTarget,
    room_ids: parsed.roomIds ?? filters.room_ids,
  };

  useCopilotPageContext(
    "income-expenses.list",
    { ...effectiveFilters, search: parsed.text, view: viewMode },
    detailVoucher,
  );
  // keepPreviousData: màn danh sách phân trang — giữ trang cũ để danh sách không
  // nháy skeleton mỗi lần "Tải thêm"/đổi filter (opt-in, xem useIncomeExpenses).
  const { data: listResult, isLoading } = useIncomeExpenses(
    effectiveFilters,
    { page: pagination.page, pageSize: pagination.pageSize },
    parsed.text,
    { keepPreviousData: true },
  );
  const { data: batchResult, isLoading: isBatchLoading } =
    useIncomeExpenseBatches(
      effectiveFilters,
      { page: pagination.page, pageSize: pagination.pageSize },
      parsed.text,
      // Chỉ fetch Phiếu tổng khi đang xem tab đó (đồng bộ với bản desktop).
      { enabled: viewMode === "batch" },
    );
  const { data: stats, isLoading: isStatsLoading } = useIncomeExpenseStats(
    effectiveFilters,
    { keepPreviousData: true },
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
  // --- Gộp ẩn phiếu đối ứng DI SẢN vào thẻ phiếu gốc (plan Đợt 5, parity desktop) ---
  // Lịch sử trước Đợt 5 có hai thẻ rời rạc cho cùng một nghiệp vụ hoàn tác.
  // `vouchers` GIỮ NGUYÊN để nút "Xem thêm" vẫn đếm theo số bản ghi thật.
  const [openReversals, setOpenReversals] = useState<Record<string, boolean>>(
    {},
  );
  const displayRows = useMemo(() => {
    const rows: Array<{
      voucher: (typeof vouchers)[number];
      reversalCount: number;
      netAmount: number;
      nested: boolean;
    }> = [];
    for (const group of groupReversalVouchers(vouchers)) {
      const reversalCount = group.reversals.length;
      rows.push({
        voucher: group.anchor,
        reversalCount,
        netAmount: reversalCount > 0 ? groupNetAmount(group) : 0,
        nested: false,
      });
      if (reversalCount > 0 && openReversals[group.anchor.id]) {
        for (const reversal of group.reversals) {
          rows.push({
            voucher: reversal,
            reversalCount: 0,
            netAmount: 0,
            nested: true,
          });
        }
      }
    }
    return rows;
  }, [vouchers, openReversals]);

  const curLayer =
    filters.layer === undefined ? "CASH" : (filters.layer ?? "ALL");
  const setLayer = (v: "CASH" | "INTERNAL" | "PENDING" | "ALL") => {
    setFilters({ ...filters, layer: v === "ALL" ? null : v });
    pagination.setPage(1);
  };
  const positive = statsData.difference >= 0;
  // Ngoặc "gồm cả phiếu chờ xử lý" — cùng toán với desktop, xem
  // src/lib/incomeExpenseStatCards.ts. Hết phiếu chờ thì thay số bằng ✓.
  const withPending = buildIncomeExpenseStatCards({
    totalIncome: statsData.totalIncome,
    totalExpense: statsData.totalExpense,
    pendingIncome: statsData.pendingIncome,
    pendingExpense: statsData.pendingExpense,
  });
  // Lời chú theo ĐÚNG Ô ĐANG ĐỨNG (parity desktop): ô Thu có thể sạch trong khi
  // vẫn còn hàng trăm phiếu CHI chờ. ✓ nói về TIỀN của ô này, không phải số phiếu.
  const renderPendingSub = (
    card: { withPending: number; hasPending: boolean },
    className: string,
    label: string,
  ) => {
    if (isStatsLoading) return null;
    if (!card.hasPending) {
      const hint = `Duyệt hết phiếu chờ xử lý cũng không đổi số "${label}" này`;
      return (
        <span className={className} style={{ color: "#10b981" }} title={hint}>
          <Check aria-hidden="true" />
          <span className="sr-only">{hint}</span>
        </span>
      );
    }
    return (
      <span
        className={className}
        title={`"${label}" nếu duyệt hết phiếu chờ xử lý (chờ duyệt hoặc chưa chọn sổ quỹ)`}
      >
        ({compact(card.withPending)})
      </span>
    );
  };
  const restoreMutation = useRestoreIncomeExpense();
  const cancelBatchMutation = useCancelIncomeExpenseBatch();
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

  const { data: perms } = useMyPermissions();
  const canCreate = canUse(perms, "income_expenses", "create");

  // Finance V2 route-aware (§9.6): org CANONICAL → duyệt-only không đổi tồn quỹ,
  // "Duyệt và Chi/Thu" đi qua Posting dialog atomic. Mặc định LEGACY giữ flow cũ.
  const v2Routes = useFinanceV2Routes();

  const activeCount = useMemo(() => countActiveFilters(filters), [filters]);

  const onFiltersChange = (next: IncomeExpenseFilters) => {
    setFilters(next);
    pagination.setPage(1);
  };

  return (
    <div className="cm-stage">
      <div className="cm-app">
        <div className="route route-anim">
          <div className="mtop">
            <button
              className="mback"
              onClick={() => navigate("/")}
              aria-label="Về trang chủ"
            >
              <ArrowLeft />
            </button>
            <div className="mtitle">
              <h1>Thu chi</h1>
              <p>Tài chính → Thu chi</p>
            </div>
            {canCreate && (
              <div className="mtop-act">
                <button
                  className="mtop-btn"
                  onClick={() => setCreateOpen(true)}
                >
                  <Plus />
                  Phiếu
                </button>
              </div>
            )}
          </div>

          <div className="mbody">
            {/* Tìm kiếm + nút lọc */}
            <div className="tksearch">
              <div className="tksearch-in">
                <Search />
                <input
                  placeholder="Theo mã phòng, mã phiếu, tên, số tiền…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <button
                className={"tkfbtn" + (activeCount ? " act" : "")}
                onClick={() => setFilterOpen(true)}
                aria-label="Lọc dữ liệu"
              >
                <Filter size={17} />
                {activeCount ? (
                  <span className="fbadge">{activeCount}</span>
                ) : null}
              </button>
            </div>

            {/* Chỉ số tổng thu / tổng chi / chênh lệch */}
            <div className="iestats">
              <div className="iestat">
                <span className="iestat-l">
                  <TrendingUp style={{ color: "#10b981" }} />
                  TỔNG THU
                </span>
                <span className="iestat-v" style={{ color: "#10b981" }}>
                  {isStatsLoading ? "…" : compact(statsData.totalIncome)}
                </span>
                {renderPendingSub(withPending.income, "iestat-sub", "Tổng thu")}
              </div>
              <div className="iestat">
                <span className="iestat-l">
                  <Wallet style={{ color: "#ef4444" }} />
                  TỔNG CHI
                </span>
                <span className="iestat-v" style={{ color: "#ef4444" }}>
                  {isStatsLoading ? "…" : compact(statsData.totalExpense)}
                </span>
                {renderPendingSub(
                  withPending.expense,
                  "iestat-sub",
                  "Tổng chi",
                )}
              </div>
              <div className={"iediff" + (positive ? " pos" : " neg")}>
                <span className="iediff-l">
                  <Coins />
                  THU − CHI
                </span>
                <span
                  className="iediff-v"
                  style={{ color: positive ? "#10b981" : "#ef4444" }}
                >
                  {positive ? "+" : ""}
                  {isStatsLoading ? "…" : compact(statsData.difference)}
                </span>
                {renderPendingSub(
                  withPending.difference,
                  "iediff-sub",
                  "Thu − chi",
                )}
              </div>
            </div>

            {/* B4: LỚP phiếu — Tiền thật (mặc định) / Nội bộ / Chờ xử lý / Tất cả */}
            {viewMode === "individual" && (
              <div className="ieseg" style={{ marginTop: 8 }}>
                {(
                  [
                    ["CASH", "Tiền thật"],
                    ["INTERNAL", "Nội bộ"],
                    ["PENDING", "Chờ xử lý"],
                    ["ALL", "Tất cả"],
                  ] as const
                ).map(([v, label]) => (
                  <button
                    key={v}
                    className={"ieseg-b" + (curLayer === v ? " on" : "")}
                    onClick={() => setLayer(v)}
                  >
                    {label}
                    {v === "INTERNAL" && (statsData.internalCount ?? 0) > 0
                      ? ` (${statsData.internalCount})`
                      : v === "PENDING" && (statsData.pendingCount ?? 0) > 0
                        ? ` (${statsData.pendingCount})`
                        : ""}
                  </button>
                ))}
              </div>
            )}

            {/* Chip bộ lọc đang áp dụng */}
            <IncomeExpenseFilterChips
              filters={filters}
              emptyFilters={EMPTY_FILTERS}
              onChange={onFiltersChange}
            />

            {/* Phiếu lẻ / Phiếu tổng */}
            <div className="ieseg">
              <button
                className={"ieseg-b" + (viewMode === "individual" ? " on" : "")}
                onClick={() => {
                  setViewMode("individual");
                  pagination.setPage(1);
                }}
              >
                Phiếu lẻ
              </button>
              <button
                className={"ieseg-b" + (viewMode === "batch" ? " on" : "")}
                onClick={() => {
                  setViewMode("batch");
                  pagination.setPage(1);
                }}
              >
                Phiếu tổng
              </button>
            </div>

            {viewMode === "individual" ? (
              isLoading || parsed.pending ? (
                <div className="stub">
                  <p>Đang tải phiếu…</p>
                </div>
              ) : vouchers.length === 0 ? (
                <div className="stub">
                  <p>
                    Chưa có phiếu nào. Tạo phiếu mới qua nút (+) hoặc nới bộ
                    lọc.
                  </p>
                </div>
              ) : (
                <div className="rowlist">
                  {vouchers.map((v) => {
                    const inc = v.type === "INCOME";
                    const cancelled = v.approval_status === "CANCELLED";
                    const draft = v.approval_status === "UNAPPROVED";
                    // B4: bút toán nội bộ — trung tính, không xanh/đỏ tiền thật.
                    const internal =
                      !cancelled &&
                      voucherLayer({
                        approval_status: v.approval_status,
                        account_id: v.account_id,
                        system_source: v.system_source,
                        account_is_virtual: v.account_is_virtual,
                      }) === "INTERNAL";
                    const accent = internal
                      ? "#94a3b8"
                      : inc
                        ? "#10b981"
                        : "#ef4444";
                    const canShareQR =
                      v.type === "EXPENSE" &&
                      !cancelled &&
                      !!v.receive_bank_account;
                    return (
                      <div
                        className="vch"
                        key={v.id}
                        onClick={() => setDetailVoucher(v)}
                        style={{
                          borderLeftColor: accent,
                          opacity: cancelled ? 0.6 : 1,
                        }}
                      >
                        <div className="vch-l1">
                          <span className="lrow-code">{v.code}</span>
                          <span
                            className="vch-chip"
                            style={{
                              color: inc ? "#047857" : "#b91c1c",
                              background: inc ? "#d1fae5" : "#fee2e2",
                            }}
                          >
                            {inc ? "Phiếu thu" : "Phiếu chi"}
                          </span>
                          {/* Finance V2 §12.1: org CANONICAL read → tag composite
                              (Đã Duyệt - Chưa Chi / Đã Chi / Đã hoàn tác…) parity
                              desktop; org LEGACY giữ 2 tag cũ. */}
                          {(() => {
                            const vv = v as {
                              organization_id?: string | null;
                              review_state?: string | null;
                              posting_mode?: string | null;
                              posting_status?: string | null;
                            };
                            if (
                              !isCanonicalRead(
                                v2Routes.getOrg(vv.organization_id ?? null),
                              )
                            ) {
                              return null;
                            }
                            const s = getVoucherDisplayState({
                              approval_status:
                                v.approval_status as VoucherDisplayInput["approval_status"],
                              review_state: (vv.review_state ??
                                null) as VoucherDisplayInput["review_state"],
                              posting_mode: (vv.posting_mode ??
                                null) as VoucherDisplayInput["posting_mode"],
                              posting_status: (vv.posting_status ??
                                null) as VoucherDisplayInput["posting_status"],
                              type: v.type as VoucherDisplayInput["type"],
                            });
                            return (
                              <span
                                className="vch-tag"
                                style={{
                                  color: V2_TAG_STYLES[s.tone].color,
                                  background: V2_TAG_STYLES[s.tone].background,
                                }}
                              >
                                {s.label}
                              </span>
                            );
                          })() ?? (
                            <>
                              {cancelled && (
                                <span
                                  className="vch-tag"
                                  style={{
                                    color: "#52525b",
                                    background: "#f4f4f5",
                                  }}
                                >
                                  Đã huỷ
                                </span>
                              )}
                              {draft && (
                                <span
                                  className="vch-tag"
                                  style={{
                                    color: "#b45309",
                                    background: "#fef3c7",
                                  }}
                                >
                                  Chờ duyệt
                                </span>
                              )}
                            </>
                          )}
                          {internal && (
                            <span
                              className="vch-tag"
                              style={{
                                color: "#475569",
                                background: "#e2e8f0",
                              }}
                            >
                              Nội bộ
                            </span>
                          )}
                          {!cancelled && !draft && v.verified_at && (
                            <span
                              className="vch-tag"
                              style={{
                                color: "#047857",
                                background: "#d1fae5",
                              }}
                            >
                              Đã đối chiếu
                            </span>
                          )}
                          <span
                            className="vch-amt"
                            style={{ color: accent, marginLeft: "auto" }}
                          >
                            {internal ? "" : inc ? "+" : "−"}
                            {compact(v.total_amount)}
                          </span>
                        </div>
                        <div className="vch-name">
                          <b>{v.name}</b>
                          {v.payer_name && (
                            <span className="vch-payer"> · {v.payer_name}</span>
                          )}
                        </div>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                          }}
                        >
                          <div className="vch-meta">
                            {fmtDate(v.voucher_date)}
                            {v.account_name ? ` · ${v.account_name}` : ""}
                            {v.building_name ? ` · ${v.building_name}` : ""}
                            {v.room_name ? ` - ${v.room_name}` : ""}
                          </div>
                          {/* Đợt 4 (parity desktop): lịch sử phiếu — mốc
                              lập/duyệt/huỷ + lý do + nhật ký trước/sau. Với
                              phiếu đã huỷ đây là chỗ đối soát duy nhất. */}
                          <button
                            className="vch-qr"
                            aria-label="Xem lịch sử phiếu"
                            onClick={(e) => {
                              e.stopPropagation();
                              setHistoryVoucher(v);
                            }}
                          >
                            <History size={15} />
                          </button>
                          {canShareQR && (
                            <button
                              className="vch-qr"
                              aria-label="Gửi/lưu QR chuyển khoản"
                              onClick={(e) => {
                                e.stopPropagation();
                                setShareVoucher(v);
                              }}
                            >
                              <Share2 size={15} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {totalCount > vouchers.length && (
                    <button
                      className="loadmore"
                      onClick={() =>
                        pagination.setPageSize(pagination.pageSize + 50)
                      }
                    >
                      Xem thêm ({totalCount - vouchers.length})
                    </button>
                  )}
                </div>
              )
            ) : (
              <IncomeExpenseBatchListMobile
                batches={batches}
                isLoading={isBatchLoading || parsed.pending}
                onView={setDetailBatchId}
                totalCount={batchTotalCount}
                onLoadMore={() =>
                  pagination.setPageSize(pagination.pageSize + 50)
                }
              />
            )}
          </div>

          {/* Chi tiết phiếu — bottom sheet */}
          {detailVoucher && (
            <IncomeExpenseDetailMobile
              actions={actions}
              onBeforeAction={rememberActionVoucher}
              voucher={{
                ...detailVoucher,
                supplements:
                  detailSupplements.data ?? detailVoucher.supplements,
              }}
              onClose={() => setDetailVoucher(null)}
              onEdit={handleEditVoucher}
              onQuickEdit={handleQuickEditVoucher}
              onApprove={handleApproveVoucher}
              onCancel={handleCancelVoucher}
              onRestore={(id) => setRestoreTarget(id)}
              onCopy={(v) => setCopyVoucher(v)}
              onPostApproved={(v) => actions.open("post", v.id)}
              onReversePosting={(v) => actions.open("reverse", v.id)}
            />
          )}

          {/* Chi tiết phiếu tổng — bottom sheet */}
          {detailBatch && (
            <IncomeExpenseBatchDetailMobile
              batch={detailBatch}
              onClose={() => setDetailBatchId(null)}
              onCancelBatch={setCancelBatchTarget}
              onEditVoucher={handleEditVoucher}
              onCancelVoucher={handleCancelVoucher}
              onApproveVoucher={handleApproveVoucher}
            />
          )}

          {/* Menu tạo phiếu — bottom sheet */}
          {createOpen && (
            <div className="sheet-ov" onClick={() => setCreateOpen(false)}>
              <div className="sheet" onClick={(e) => e.stopPropagation()}>
                <div className="sheet-grab" />
                <div className="cmenu-hd">
                  <span className="cmenu-hd-t">Tạo phiếu mới</span>
                  <button
                    className="sheet-x"
                    style={{ marginLeft: "auto" }}
                    onClick={() => setCreateOpen(false)}
                    aria-label="Đóng"
                  >
                    <X size={18} />
                  </button>
                </div>
                <div className="cmenu">
                  <button
                    className="cmenu-opt"
                    onClick={() => {
                      setCreateOpen(false);
                      setFormType("INCOME");
                      setIsFormOpen(true);
                    }}
                  >
                    <span
                      className="cmenu-ic"
                      style={{ background: "#d1fae5", color: "#047857" }}
                    >
                      <TrendingUp size={19} />
                    </span>
                    <span className="cmenu-tx">
                      <span className="cmenu-t">Phiếu thu</span>
                      <span className="cmenu-s">Ghi nhận một khoản thu</span>
                    </span>
                  </button>
                  <button
                    className="cmenu-opt"
                    onClick={() => {
                      setCreateOpen(false);
                      setFormType("EXPENSE");
                      setIsFormOpen(true);
                    }}
                  >
                    <span
                      className="cmenu-ic"
                      style={{ background: "#fee2e2", color: "#b91c1c" }}
                    >
                      <Wallet size={19} />
                    </span>
                    <span className="cmenu-tx">
                      <span className="cmenu-t">Phiếu chi</span>
                      <span className="cmenu-s">Ghi nhận một khoản chi</span>
                    </span>
                  </button>
                  <button
                    className="cmenu-opt"
                    onClick={() => {
                      setCreateOpen(false);
                      setIsQuickOpen(true);
                    }}
                  >
                    <span
                      className="cmenu-ic"
                      style={{ background: "#e8f3ec", color: "#1a6645" }}
                    >
                      <Zap size={19} />
                    </span>
                    <span className="cmenu-tx">
                      <span className="cmenu-t">Tạo nhanh</span>
                      <span className="cmenu-s">
                        Nhập gọn vài trường cơ bản
                      </span>
                    </span>
                  </button>
                  <button
                    className="cmenu-opt"
                    onClick={() => {
                      setCreateOpen(false);
                      setFormType("EXPENSE");
                      setIsBatchFormOpen(true);
                    }}
                  >
                    <span
                      className="cmenu-ic"
                      style={{ background: "#e7eefc", color: "#2563eb" }}
                    >
                      <Layers size={19} />
                    </span>
                    <span className="cmenu-tx">
                      <span className="cmenu-t">Phiếu tổng</span>
                      <span className="cmenu-s">
                        Gom nhiều phiếu thành một đợt
                      </span>
                    </span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bộ lọc (bottom sheet desktop-style — dùng lại panel thật) */}
      <IncomeExpenseFilterPanel
        open={filterOpen}
        onOpenChange={setFilterOpen}
        filters={filters}
        emptyFilters={EMPTY_FILTERS}
        onApply={onFiltersChange}
        side="bottom"
      />

      {/* Dialog tạo / sửa phiếu (dùng lại logic desktop) */}
      <IncomeExpenseQuickCreateDialog
        open={isQuickOpen}
        onOpenChange={setIsQuickOpen}
        defaultType="EXPENSE"
      />
      <IncomeExpenseForm
        open={isFormOpen}
        onOpenChange={setIsFormOpen}
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
        onOpenChange={(o) => {
          if (!o) setEditingVoucher(null);
        }}
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

      {/* Đợt 4: lịch sử phiếu — dùng chung component với desktop (parity). */}
      <IncomeExpenseActionDialogs controller={actions} />
      <VoucherHistoryDialog
        open={!!historyVoucher}
        onOpenChange={(o) => {
          if (!o) setHistoryVoucher(null);
        }}
        voucher={historyVoucher}
      />
      {shareVoucher && (
        <PayViaBankAppSheet
          open
          onOpenChange={(o) => {
            if (!o) setShareVoucher(null);
          }}
          voucher={shareVoucher}
        />
      )}
      {/* Xác nhận huỷ / duyệt */}

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
              onClick={() => {
                if (restoreTarget) restoreMutation.mutate(restoreTarget);
                setRestoreTarget(null);
              }}
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
              onClick={() => {
                if (cancelBatchTarget)
                  cancelBatchMutation.mutate(cancelBatchTarget);
                setCancelBatchTarget(null);
              }}
              className="bg-red-600 hover:bg-red-700"
            >
              Huỷ cả đợt
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
