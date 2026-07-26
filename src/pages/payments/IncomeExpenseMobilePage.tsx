import { useState, useEffect, useMemo } from "react";
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
  X,
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
import {
  useIncomeExpenses,
  useIncomeExpenseStats,
  useIncomeExpenseBatches,
  useCancelIncomeExpense,
  useRestoreIncomeExpense,
  useApproveVoucher,
  useQuickUpdateIncomeExpense,
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
import IncomeExpenseDetailMobile from "@/components/income-expenses/IncomeExpenseDetailMobile";
import IncomeExpenseForm from "@/components/income-expenses/IncomeExpenseForm";
import IncomeExpenseQuickCreateDialog from "@/components/income-expenses/IncomeExpenseQuickCreateDialog";
import IncomeExpenseBatchForm from "@/components/income-expenses/IncomeExpenseBatchForm";
import IncomeExpenseQuickEditDialog from "@/components/income-expenses/IncomeExpenseQuickEditDialog";
import IncomeExpenseBatchListMobile from "@/components/income-expenses/IncomeExpenseBatchListMobile";
import IncomeExpenseBatchDetailMobile from "@/components/income-expenses/IncomeExpenseBatchDetailMobile";
import PayViaBankAppSheet from "@/components/income-expenses/PayViaBankAppSheet";
import { usePersistedState } from "@/hooks/usePersistedState";
// Finance V2 (route-aware §9.6/§12): duyệt-only / duyệt+ghi sổ atomic khi org CANONICAL.
import {
  useFinanceV2Routes,
  canWriteWorkflow,
  canWritePosting,
  isCanonicalRead,
} from "@/lib/financeV2Route";
import {
  getVoucherDisplayState,
  isNonCashVoucher,
  type VoucherDisplayInput,
  type VoucherTone,
} from "@/lib/financeV2VoucherState";
import {
  useApproveIncomeExpenseV2,
  useApproveAndPostIncomeExpenseV2,
  usePostApprovedIncomeExpenseV2,
  useReversePostingV2,
  useCustodianCashbooksV2,
  uploadFinanceEvidence,
  adoptVoucherAttachmentsAsEvidence,
} from "@/hooks/income-expenses/financeV2Mutations";
import IncomeExpensePostingDialog from "@/components/income-expenses/IncomeExpensePostingDialog";
import { Textarea } from "@/components/ui/textarea";

const EMPTY_FILTERS: IncomeExpenseFilters = EMPTY_INCOME_EXPENSE_FILTERS;

// Màu vch-tag theo tone composite V2 (khớp bảng màu TONE_CLASSES desktop).
const V2_TAG_STYLES: Record<VoucherTone, { color: string; background: string }> = {
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

  const [search, setSearch] = usePersistedState("flt:income-expense-mb:search", "");
  const [debounced, setDebounced] = useState("");
  // Vào /income-expense?account_id=xxx (vd "Xem thu chi" từ 1 sổ quỹ) → lọc sẵn
  // theo sổ đó, ĐỒNG BỘ với desktop. Không có param → xem tất cả (RLS lọc).
  // Giữ qua F5 (sessionStorage); ?account_id trên URL vẫn THẮNG nhờ effect dưới.
  const [filters, setFilters] = usePersistedState<IncomeExpenseFilters>("flt:income-expense-mb:filters", () => {
    const accountId = searchParams.get("account_id");
    return accountId
      ? { ...EMPTY_FILTERS, account_id: accountId }
      : EMPTY_FILTERS;
  });

  // Đọc xong thì xoá query để URL sạch — filter chip vẫn hiển thị sổ đang lọc.
  useEffect(() => {
    const accountId = searchParams.get("account_id");
    if (accountId) {
      setFilters((f) => ({ ...f, account_id: accountId }));
      const next = new URLSearchParams(searchParams);
      next.delete("account_id");
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [viewMode, setViewMode] = usePersistedState<"individual" | "batch">("flt:income-expense-mb:viewMode", "individual");
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
  const [quickEditVoucher, setQuickEditVoucher] =
    useState<IncomeExpenseWithRelations | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isQuickOpen, setIsQuickOpen] = useState(false);
  const [isBatchFormOpen, setIsBatchFormOpen] = useState(false);
  const [formType, setFormType] = useState<"INCOME" | "EXPENSE">("INCOME");
  const [detailBatchId, setDetailBatchId] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [approveTarget, setApproveTarget] =
    useState<IncomeExpenseWithRelations | null>(null);
  // Duyệt phiếu: cho bổ sung/đổi sổ quỹ + đính kèm ngay trước khi ghi vào tồn quỹ.
  const [approveAccountId, setApproveAccountId] = useState<string>("");
  const [approveAttachments, setApproveAttachments] = useState<string[]>([]);
  // V2: mở Posting dialog "Duyệt và Chi/Thu" (chỉ khi route CANONICAL).
  const [approveAndPostOpen, setApproveAndPostOpen] = useState(false);
  // V2 §12.3: Thu/Chi phiếu ĐÃ DUYỆT-CHƯA GHI SỔ (CUSTODIAN, không cần quyền duyệt).
  const [postApprovedTarget, setPostApprovedTarget] =
    useState<IncomeExpenseWithRelations | null>(null);
  // Mô hình 2 nút: HOÀN TÁC phiếu đã ghi sổ (kèm lý do).
  const [reverseTarget, setReverseTarget] =
    useState<IncomeExpenseWithRelations | null>(null);
  const [reverseReason, setReverseReason] = useState("");
  // Huỷ phiếu ĐÃ CHI: cảnh báo hoàn-tác-tiền + lý do (ghi vào reversal).
  const [cancelReason, setCancelReason] = useState("");
  const [cancelBatchTarget, setCancelBatchTarget] = useState<string | null>(null);

  // Nạp giá trị hiện tại của phiếu mỗi khi mở hộp thoại duyệt.
  useEffect(() => {
    if (approveTarget) {
      setApproveAccountId(approveTarget.account_id ?? "");
      setApproveAttachments(approveTarget.attachments ?? []);
    }
  }, [approveTarget]);

  // Trang đầu 15 (khớp MOBILE_FIRST_PAGE_SIZE prefetch từ màn chính — lệch là
  // trật cache key); "Tải thêm" vẫn nới +50.
  const pagination = usePagination(MOBILE_FIRST_PAGE_SIZE);

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
    layer: filters.layer === undefined ? 'CASH' : filters.layer,
    amount_target: parsed.amountTarget,
    room_ids: parsed.roomIds ?? filters.room_ids,
  };

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
  const { data: stats, isLoading: isStatsLoading } =
    useIncomeExpenseStats(effectiveFilters, { keepPreviousData: true });

  const vouchers = listResult?.data ?? [];
  const totalCount = listResult?.totalCount ?? 0;
  const batches = batchResult?.data ?? [];
  const batchTotalCount = batchResult?.totalCount ?? 0;
  const detailBatch =
    detailBatchId !== null
      ? batches.find((b) => b.id === detailBatchId) ?? null
      : null;

  const statsData = stats ?? {
    totalIncome: 0, totalExpense: 0, difference: 0,
    internalCount: 0, internalIncome: 0, internalExpense: 0,
    pendingCount: 0, pendingTotal: 0,
  };
  const curLayer = filters.layer === undefined ? "CASH" : filters.layer ?? "ALL";
  const setLayer = (v: "CASH" | "INTERNAL" | "PENDING" | "ALL") => {
    setFilters({ ...filters, layer: v === "ALL" ? null : v });
    pagination.setPage(1);
  };
  const positive = statsData.difference >= 0;

  const cancelMutation = useCancelIncomeExpense();
  const restoreMutation = useRestoreIncomeExpense();
  const approveMutation = useApproveVoucher();
  const quickUpdateMutation = useQuickUpdateIncomeExpense();
  const cancelBatchMutation = useCancelIncomeExpenseBatch();

  const { data: accounts = [] } = useAccounts();
  const { data: authUser } = useAuth();

  const { data: perms } = useMyPermissions();
  const canCreate = canUse(perms, "income_expenses", "create");

  // Finance V2 route-aware (§9.6): org CANONICAL → duyệt-only không đổi tồn quỹ,
  // "Duyệt và Chi/Thu" đi qua Posting dialog atomic. Mặc định LEGACY giữ flow cũ.
  const v2Routes = useFinanceV2Routes();
  const approveOrgRoutes = v2Routes.getOrg(
    (approveTarget as { organization_id?: string } | null)?.organization_id ?? null,
  );
  const v2ApproveOnly = canWriteWorkflow(approveOrgRoutes);
  const v2ApproveAndPost = v2ApproveOnly && canWritePosting(approveOrgRoutes);
  const approveV2Mutation = useApproveIncomeExpenseV2();
  const approveAndPostV2Mutation = useApproveAndPostIncomeExpenseV2();
  const postApprovedV2Mutation = usePostApprovedIncomeExpenseV2();
  const reversePostingV2Mutation = useReversePostingV2();
  const { data: custodianBooks = [] } = useCustodianCashbooksV2(
    approveAndPostOpen || !!postApprovedTarget,
  );

  // Phiếu đang huỷ có ĐÃ GHI SỔ không (đổi lời cảnh báo + ô lý do).
  const cancelTargetVoucher = cancelTarget
    ? vouchers.find((x) => x.id === cancelTarget) ?? null
    : null;
  const cancelTargetPosted =
    (cancelTargetVoucher as { posting_status?: string | null } | null)
      ?.posting_status === "POSTED";
  const cancelTargetIsIncome = cancelTargetVoucher?.type === "INCOME";

  // Duyệt phiếu: nếu người dùng đổi sổ quỹ hoặc thêm/bớt ảnh thì lưu trước
  // (update_income_expense_quick chỉ áp cho phiếu nháp) rồi mới ghi vào tồn quỹ.
  const handleApprove = async () => {
    const target = approveTarget;
    if (!target) return;
    // V2 CANONICAL: duyệt-only qua RPC canonical — KHÔNG đổi tồn quỹ, không quick-update
    // sổ/ảnh (posting fields thuộc Posting dialog, §12.3). Không có fallback legacy.
    if (v2ApproveOnly) {
      try {
        await approveV2Mutation.mutateAsync({
          voucherId: target.id,
          expectedApprovalVersion:
            (target as { approval_version?: number }).approval_version ?? 1,
        });
        setApproveTarget(null);
      } catch {
        // toast đã hiển thị trong hook; giữ hộp thoại để người dùng thử lại.
      }
      return;
    }
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
  };

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
                <button className="mtop-btn" onClick={() => setCreateOpen(true)}>
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
                {activeCount ? <span className="fbadge">{activeCount}</span> : null}
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
              </div>
              <div className="iestat">
                <span className="iestat-l">
                  <Wallet style={{ color: "#ef4444" }} />
                  TỔNG CHI
                </span>
                <span className="iestat-v" style={{ color: "#ef4444" }}>
                  {isStatsLoading ? "…" : compact(statsData.totalExpense)}
                </span>
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
              </div>
            </div>

            {/* B4: LỚP phiếu — Tiền thật (mặc định) / Nội bộ / Chờ xử lý / Tất cả */}
            {viewMode === "individual" && (
              <div className="ieseg" style={{ marginTop: 8 }}>
                {([
                  ["CASH", "Tiền thật"],
                  ["INTERNAL", "Nội bộ"],
                  ["PENDING", "Chờ xử lý"],
                  ["ALL", "Tất cả"],
                ] as const).map(([v, label]) => (
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
                    Chưa có phiếu nào. Tạo phiếu mới qua nút (+) hoặc nới bộ lọc.
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
                              !isCanonicalRead(v2Routes.getOrg(vv.organization_id ?? null))
                            ) {
                              return null;
                            }
                            const s = getVoucherDisplayState({
                              approval_status:
                                v.approval_status as VoucherDisplayInput["approval_status"],
                              review_state:
                                (vv.review_state ?? null) as VoucherDisplayInput["review_state"],
                              posting_mode:
                                (vv.posting_mode ?? null) as VoucherDisplayInput["posting_mode"],
                              posting_status:
                                (vv.posting_status ?? null) as VoucherDisplayInput["posting_status"],
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
                                  style={{ color: "#52525b", background: "#f4f4f5" }}
                                >
                                  Đã huỷ
                                </span>
                              )}
                              {draft && (
                                <span
                                  className="vch-tag"
                                  style={{ color: "#b45309", background: "#fef3c7" }}
                                >
                                  Chờ duyệt
                                </span>
                              )}
                            </>
                          )}
                          {internal && (
                            <span
                              className="vch-tag"
                              style={{ color: "#475569", background: "#e2e8f0" }}
                            >
                              Nội bộ
                            </span>
                          )}
                          {!cancelled && !draft && v.verified_at && (
                            <span
                              className="vch-tag"
                              style={{ color: "#047857", background: "#d1fae5" }}
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
                          style={{ display: "flex", alignItems: "center", gap: 8 }}
                        >
                          <div className="vch-meta">
                            {fmtDate(v.voucher_date)}
                            {v.account_name ? ` · ${v.account_name}` : ""}
                            {v.building_name ? ` · ${v.building_name}` : ""}
                            {v.room_name ? ` - ${v.room_name}` : ""}
                          </div>
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
              voucher={detailVoucher}
              onClose={() => setDetailVoucher(null)}
              onEdit={(v) => setEditingVoucher(v)}
              onQuickEdit={(v) => setQuickEditVoucher(v)}
              onApprove={(v) => setApproveTarget(v)}
              onCancel={(id) => setCancelTarget(id)}
              onRestore={(id) => setRestoreTarget(id)}
              onCopy={(v) => setCopyVoucher(v)}
              onPostApproved={(v) => setPostApprovedTarget(v)}
              onReversePosting={(v) => setReverseTarget(v)}
            />
          )}

          {/* Chi tiết phiếu tổng — bottom sheet */}
          {detailBatch && (
            <IncomeExpenseBatchDetailMobile
              batch={detailBatch}
              onClose={() => setDetailBatchId(null)}
              onCancelBatch={setCancelBatchTarget}
              onEditVoucher={(v) => setEditingVoucher(v)}
              onCancelVoucher={setCancelTarget}
              onApproveVoucher={setApproveTarget}
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
                      <span className="cmenu-s">Nhập gọn vài trường cơ bản</span>
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
                      <span className="cmenu-s">Gom nhiều phiếu thành một đợt</span>
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
      <IncomeExpenseQuickEditDialog
        open={!!quickEditVoucher}
        onOpenChange={(o) => {
          if (!o) setQuickEditVoucher(null);
        }}
        voucher={quickEditVoucher}
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
        open={!!cancelTarget}
        onOpenChange={(o) => {
          if (!o) {
            setCancelTarget(null);
            setCancelReason("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận huỷ phiếu</AlertDialogTitle>
            <AlertDialogDescription>
              {cancelTargetPosted ? (
                <>
                  Phiếu này <b>đã {cancelTargetIsIncome ? "thu" : "chi"} tiền
                  thật</b>. Huỷ sẽ tạo bút toán <b>HOÀN TÁC</b> ghi ngày hôm
                  nay ({cancelTargetIsIncome ? "tiền rời khỏi sổ" : "tiền trả về sổ"},
                  tồn quỹ thay đổi) rồi mới đánh dấu phiếu <b>Đã huỷ</b>. Bút
                  toán gốc giữ nguyên trong lịch sử sổ.
                </>
              ) : (
                <>
                  Phiếu sẽ được đánh dấu <b>Đã huỷ</b> và không còn ảnh hưởng đến
                  tồn quỹ tài khoản. Phiếu vẫn được lưu lại trong lịch sử.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {cancelTargetPosted && (
            <Textarea
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Lý do hoàn tác/huỷ (ghi vào bút toán hoàn tác — nên nhập)"
              rows={2}
            />
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Đóng</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (cancelTarget) {
                  cancelMutation.mutate(
                    cancelReason.trim()
                      ? { id: cancelTarget, reason: cancelReason.trim() }
                      : cancelTarget,
                  );
                }
                setCancelTarget(null);
                setCancelReason("");
              }}
              className="bg-red-600 hover:bg-red-700"
            >
              {cancelTargetPosted ? "Hoàn tác & Huỷ phiếu" : "Huỷ phiếu"}
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
        open={!!approveTarget}
        onOpenChange={(o) => {
          if (!o) setApproveTarget(null);
        }}
      >
        <AlertDialogContent className="max-h-[90vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận duyệt phiếu</AlertDialogTitle>
            <AlertDialogDescription>
              {v2ApproveOnly ? (
                <>
                  <b>Duyệt</b> chỉ chuyển trạng thái phê duyệt — <b>không</b> thay
                  đổi tồn quỹ. Tiền chỉ vào/ra sổ khi thực hiện <b>Thu/Chi</b> với
                  đủ ngày, sổ quỹ và chứng từ.
                </>
              ) : (
                <>
                  Sau khi duyệt, phiếu sẽ được tính vào <b>tồn quỹ</b> và không còn
                  chỉnh sửa được. Hãy chắc chắn đã thanh toán cho người nhận.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {!v2ApproveOnly && (
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
                  {accounts.map((acc) => (
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
          )}

          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={
                approveMutation.isPending ||
                quickUpdateMutation.isPending ||
                approveV2Mutation.isPending
              }
            >
              Đóng
            </AlertDialogCancel>
            {/* 7af: phiếu NỘI BỘ (bút toán không tiền, sổ ảo) không bao giờ được
                chào ghi tiền vào sổ quỹ thật — chỉ còn nút "Duyệt". */}
            {v2ApproveAndPost && !isNonCashVoucher(approveTarget) && (
              <Button
                variant="outline"
                className="border-blue-600 text-blue-700 hover:bg-blue-50"
                disabled={approveV2Mutation.isPending || approveAndPostV2Mutation.isPending}
                onClick={() => setApproveAndPostOpen(true)}
              >
                {approveTarget?.type === "INCOME" ? "Duyệt và Thu…" : "Duyệt và Chi…"}
              </Button>
            )}
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleApprove();
              }}
              disabled={
                approveMutation.isPending ||
                quickUpdateMutation.isPending ||
                approveV2Mutation.isPending
              }
              className="bg-green-600 hover:bg-green-700"
            >
              {approveMutation.isPending ||
              quickUpdateMutation.isPending ||
              approveV2Mutation.isPending
                ? "Đang duyệt…"
                : v2ApproveOnly
                  ? "Chỉ duyệt"
                  : "Duyệt phiếu"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Finance V2: Duyệt và Chi/Thu atomic qua Posting dialog (§12.3). */}
      {approveTarget && (
        <IncomeExpensePostingDialog
          open={approveAndPostOpen}
          onOpenChange={setApproveAndPostOpen}
          mode="APPROVE_AND_POST"
          voucher={{
            subjectKind: "VOUCHER",
            subjectId: approveTarget.id,
            type: (approveTarget.type as "INCOME" | "EXPENSE") ?? "EXPENSE",
            approvedTotal: approveTarget.total_amount ?? 0,
            name: approveTarget.name ?? undefined,
            defaultCashbookId: approveTarget.account_id ?? null,
            attachments: approveTarget.attachments ?? null,
          }}
          capability={{ isCustodian: custodianBooks.length > 0, canApprove: true }}
          cashbookOptions={custodianBooks}
          expectedExecutionRevision={0}
          expectedApprovalVersion={
            (approveTarget as { approval_version?: number }).approval_version ?? 1
          }
          expectedPostingVersion={
            (approveTarget as { posting_version?: number }).posting_version ?? 1
          }
          onAdoptAttachments={adoptVoucherAttachmentsAsEvidence}
          onUploadEvidence={(file) =>
            uploadFinanceEvidence(
              file,
              (approveTarget as { organization_id?: string | null }).organization_id,
            )
          }
          onSubmit={async (input) => {
            await approveAndPostV2Mutation.mutateAsync(input);
            setApproveAndPostOpen(false);
            setApproveTarget(null);
          }}
          isSubmitting={approveAndPostV2Mutation.isPending}
        />
      )}

      {/* Mô hình 2 nút: xác nhận HOÀN TÁC phiếu đã ghi sổ (kèm lý do). */}
      <AlertDialog
        open={!!reverseTarget}
        onOpenChange={(o) => {
          if (!o) {
            setReverseTarget(null);
            setReverseReason("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Hoàn tác {reverseTarget?.type === "INCOME" ? "khoản thu" : "khoản chi"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Hệ thống tạo bút toán <b>đối dấu ghi ngày hôm nay</b> — tiền{" "}
              {reverseTarget?.type === "INCOME" ? "rời khỏi" : "trả về"} sổ{" "}
              <b>{(reverseTarget as { account_name?: string } | null)?.account_name ?? "đã chi"}</b>,{" "}
              <b>tồn quỹ thay đổi</b>. Phiếu chuyển sang <b>Đã hoàn tác</b> và
              nằm chờ: có thể <b>Thu/Chi lại</b> (vd đúng sổ khác) hoặc{" "}
              <b>Huỷ</b>. Bút toán gốc giữ nguyên trong lịch sử.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            value={reverseReason}
            onChange={(e) => setReverseReason(e.target.value)}
            placeholder="Lý do hoàn tác (ghi vào bút toán — nên nhập)"
            rows={2}
          />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reversePostingV2Mutation.isPending}>
              Đóng
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-violet-600 hover:bg-violet-700"
              disabled={reversePostingV2Mutation.isPending}
              onClick={() => {
                if (!reverseTarget?.account_id) return;
                reversePostingV2Mutation.mutate({
                  voucherId: reverseTarget.id,
                  cashbookId: reverseTarget.account_id,
                  reason: reverseReason.trim() || null,
                });
                setReverseTarget(null);
                setReverseReason("");
              }}
            >
              Hoàn tác
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Finance V2 §12.3: Thu/Chi phiếu ĐÃ DUYỆT (CUSTODIAN, không cần quyền duyệt). */}
      {postApprovedTarget && (
        <IncomeExpensePostingDialog
          open={!!postApprovedTarget}
          onOpenChange={(o) => {
            if (!o) setPostApprovedTarget(null);
          }}
          mode="POST_APPROVED"
          voucher={{
            subjectKind: "VOUCHER",
            subjectId: postApprovedTarget.id,
            type: (postApprovedTarget.type as "INCOME" | "EXPENSE") ?? "EXPENSE",
            approvedTotal: postApprovedTarget.total_amount ?? 0,
            name: postApprovedTarget.name ?? undefined,
            defaultCashbookId: postApprovedTarget.account_id ?? null,
            attachments: postApprovedTarget.attachments ?? null,
          }}
          capability={{ isCustodian: custodianBooks.length > 0, canApprove: false }}
          cashbookOptions={custodianBooks}
          expectedExecutionRevision={0}
          expectedApprovalVersion={
            (postApprovedTarget as { approval_version?: number }).approval_version ?? 1
          }
          expectedPostingVersion={
            (postApprovedTarget as { posting_version?: number }).posting_version ?? 1
          }
          onAdoptAttachments={adoptVoucherAttachmentsAsEvidence}
          onUploadEvidence={(file) =>
            uploadFinanceEvidence(
              file,
              (postApprovedTarget as { organization_id?: string | null }).organization_id,
            )
          }
          onSubmit={async (input) => {
            await postApprovedV2Mutation.mutateAsync(input);
            setPostApprovedTarget(null);
          }}
          isSubmitting={postApprovedV2Mutation.isPending}
        />
      )}

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
