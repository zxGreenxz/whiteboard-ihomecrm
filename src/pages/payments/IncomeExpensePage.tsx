import { useState, useCallback, useEffect, useMemo, useRef, lazy, Suspense } from "react";
import { useSearchParams } from "react-router-dom";
import MainLayout from "@/components/layout/MainLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import {
  IE_APPROVAL_STATUS_PARAM_VALUES,
  IE_LAYER_PARAM_VALUES,
} from "@/lib/notificationRoutes";
// Finance V2 (route-aware §9.6/§12): duyệt-only / duyệt+ghi sổ atomic khi org CANONICAL.
import {
  useFinanceV2Routes,
  canWriteWorkflow,
  canWritePosting,
} from "@/lib/financeV2Route";
import { isNonCashVoucher } from "@/lib/financeV2VoucherState";
import {
  useApproveIncomeExpenseV2,
  useApproveAndPostIncomeExpenseV2,
  usePostApprovedIncomeExpenseV2,
  useReversePostingV2,
  useCustodianCashbooksV2,
  uploadFinanceEvidence,
  adoptVoucherAttachmentsAsEvidence,
  useAttachPostingEvidence,
  useRemovePostingAttachment,
} from "@/hooks/income-expenses/financeV2Mutations";
import IncomeExpensePostingDialog from "@/components/income-expenses/IncomeExpensePostingDialog";
// Đợt 4: hỏi-trước can_flex_cancel_v1 + writer huỷ-một-nhát có CAS hai version.
import {
  useFlexCancelEligibility,
  useCancelVoucherFlex,
  flexCancelGate,
} from "@/hooks/income-expenses/flexMutations";
// ĐỢT A: phiếu THU đi cửa riêng cancel_income_voucher_v1 (huỷ ở đâu cũng được,
// tự liên kết hoá đơn). Phiếu CHI giữ nguyên thang cũ — hai đường tách hẳn.
import {
  useIncomeCancelEligibility,
  useCancelIncomeVoucher,
  voucherCancelDecision,
} from "@/hooks/income-expenses/incomeVoucherCancel";
import VoucherHistoryDialog from "@/components/income-expenses/VoucherHistoryDialog";

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
  // Đợt 4: màn đọc lại mốc lập/duyệt/huỷ + nhật ký thay đổi trước/sau.
  const [historyVoucher, setHistoryVoucher] =
    useState<IncomeExpenseWithRelations | null>(null);
  const [detailBatchId, setDetailBatchId] = useState<string | null>(null);
  const [formType, setFormType] = useState<"INCOME" | "EXPENSE">("INCOME");
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);
  // Loại phiếu đang huỷ, nhớ riêng vì phiếu mở từ CHI TIẾT ĐỢT (phiếu tổng)
  // hầu như không nằm trong trang danh sách lẻ hiện tại: tra ngược trong
  // `vouchers` sẽ ra null ⇒ type=undefined ⇒ rơi ngược về thang huỷ CŨ.
  const [cancelTargetType, setCancelTargetType] = useState<string | null>(null);
  // Huỷ phiếu ĐÃ CHI: cảnh báo hoàn-tác-tiền + lý do (ghi vào reversal).
  const [cancelReason, setCancelReason] = useState("");
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [approveTarget, setApproveTarget] =
    useState<IncomeExpenseWithRelations | null>(null);
  // Duyệt phiếu: cho bổ sung/đổi sổ quỹ + đính kèm ngay trước khi ghi vào tồn quỹ.
  const [approveAccountId, setApproveAccountId] = useState<string>("");
  const [approveAttachments, setApproveAttachments] = useState<string[]>([]);
  const [unapproveTarget, setUnapproveTarget] = useState<string | null>(null);
  // V2: mở Posting dialog "Duyệt và Chi/Thu" (chỉ khi route CANONICAL).
  const [approveAndPostOpen, setApproveAndPostOpen] = useState(false);
  // V2 §12.3: Thu/Chi phiếu ĐÃ DUYỆT-CHƯA GHI SỔ (CUSTODIAN, không cần quyền duyệt).
  const [postApprovedTarget, setPostApprovedTarget] =
    useState<IncomeExpenseWithRelations | null>(null);
  // Mô hình 2 nút: HOÀN TÁC phiếu đã ghi sổ (kèm lý do).
  const [reverseTarget, setReverseTarget] =
    useState<IncomeExpenseWithRelations | null>(null);
  const [reverseReason, setReverseReason] = useState("");
  const [cancelBatchTarget, setCancelBatchTarget] = useState<string | null>(null);

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
  const { data: listResult, isLoading } = useIncomeExpenses(
    effectiveFilters,
    { page: pagination.page, pageSize: pagination.pageSize },
    parsedSearch.text,
    { keepPreviousData: true }
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
    useIncomeExpenseStats(effectiveFilters, { keepPreviousData: true });

  const cancelMutation = useCancelIncomeExpense();
  const flexCancelMutation = useCancelVoucherFlex();
  const cancelIncomeMutation = useCancelIncomeVoucher();
  const restoreMutation = useRestoreIncomeExpense();
  const cancelBatchMutation = useCancelIncomeExpenseBatch();
  const approveMutation = useApproveVoucher();
  const unapproveMutation = useUnapproveVoucher();
  const quickUpdateMutation = useQuickUpdateIncomeExpense();
  const generateRecurringMutation = useGenerateRecurringVouchers();
  const stopRecurringMutation = useStopRecurring();

  const { data: accounts = [] } = useAccounts();
  const { data: authUser } = useAuth();
  // Dán ảnh trong hộp thoại Thu/Chi = đính ảnh lên phiếu rồi nhận nó làm chứng
  // từ — nhờ vậy ảnh hiện luôn ở dòng thu chi (chủ báo 27/08/2026).
  const attachPostingEvidence = useAttachPostingEvidence();
  const removePostingAttachment = useRemovePostingAttachment();

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

  // Đợt 4 — hỏi server TRƯỚC phiếu nào huỷ được (can_flex_cancel_v1). Danh sách
  // id phải dựng bằng useMemo: queryKey băm từ mảng đã sort, mảng mới mỗi render
  // vẫn cùng key nhưng effect của react-query thì chạy lại vô ích.
  const flexCancelIds = useMemo(
    () =>
      vouchers
        .filter((v) => v.approval_status !== "CANCELLED")
        .map((v) => v.id),
    [vouchers],
  );
  const { data: cancelEligibility } = useFlexCancelEligibility(flexCancelIds);

  // ĐỢT A: phiếu THU hỏi reader riêng (can_cancel_income_voucher_v1) — nó biết
  // cả thứ tự LIFO của đợt thu lẫn tiền thừa đã cấn đi đâu, những thứ reader
  // của phiếu chi không có khái niệm.
  const incomeCancelIds = useMemo(
    () =>
      vouchers
        .filter((v) => v.type === "INCOME" && v.approval_status !== "CANCELLED")
        .map((v) => v.id),
    [vouchers],
  );
  const { data: incomeCancelEligibility } =
    useIncomeCancelEligibility(incomeCancelIds);

  // Phiếu đang huỷ có ĐÃ GHI SỔ không (đổi lời cảnh báo + ô lý do).
  const cancelTargetVoucher = cancelTarget
    ? vouchers.find((v) => v.id === cancelTarget) ?? null
    : null;
  const cancelTargetPosted = cancelTargetVoucher?.posting_status === "POSTED";
  const cancelTargetIsIncome =
    (cancelTargetVoucher?.type ?? cancelTargetType) === "INCOME";
  // Hộp thoại xác nhận cũng phải tôn trọng câu trả lời của server: phiếu mở từ
  // chi tiết/đợt có thể không nằm trong trang hiện tại ⇒ không có dòng ⇒ gate
  // mặc định "cho bấm", writer là chốt chặn cuối.
  const cancelTargetGate = voucherCancelDecision({
    type: cancelTargetVoucher?.type ?? cancelTargetType,
    income: cancelTarget ? incomeCancelEligibility?.[cancelTarget] : undefined,
    flexGate: flexCancelGate(
      cancelTarget ? cancelEligibility?.[cancelTarget] : undefined,
    ),
  });

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
  // (update_income_expense_quick chỉ áp cho phiếu chờ duyệt) rồi mới ghi vào tồn quỹ.
  const confirmApprove = useCallback(async () => {
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
  }, [
    approveTarget,
    approveAccountId,
    approveAttachments,
    approveMutation,
    quickUpdateMutation,
    v2ApproveOnly,
    approveV2Mutation,
  ]);

  const handleUnapproveVoucher = useCallback((id: string) => {
    setUnapproveTarget(id);
  }, []);

  const confirmUnapprove = useCallback(() => {
    if (unapproveTarget) {
      unapproveMutation.mutate(unapproveTarget);
    }
    setUnapproveTarget(null);
  }, [unapproveTarget, unapproveMutation]);

  const handleCancelVoucher = useCallback((id: string, type?: string | null) => {
    setCancelTarget(id);
    setCancelTargetType(type ?? null);
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
    const reason = cancelReason.trim();
    if (cancelTarget) {
      // ĐỢT A: phiếu THU đi cửa riêng — server tự rẽ nhánh đợt thu hoá đơn /
      // cặp bỏ cọc / phiếu thường và tự mở lại nợ hoá đơn. Không còn thang 6
      // bậc, không còn "owned by system flow".
      if (cancelTargetGate.useIncomeDoor) {
        cancelIncomeMutation.mutate({ voucherId: cancelTarget, reason });
      } else if (cancelTargetGate.useFlexWriter && cancelTargetVoucher) {
        // Đợt 4 (phiếu CHI): writer linh hoạt là đường duy nhất truyền được CAS
        // hai version. Đường cũ luôn gửi null nên hai người bấm cùng lúc là huỷ
        // đè lên nhau trong im lặng.
        flexCancelMutation.mutate({
          voucherId: cancelTarget,
          reason,
          expectedApprovalVersion: cancelTargetVoucher.approval_version ?? null,
          expectedPostingVersion: cancelTargetVoucher.posting_version ?? null,
        });
      } else {
        cancelMutation.mutate(
          reason ? { id: cancelTarget, reason } : cancelTarget,
        );
      }
    }
    setCancelTarget(null);
    setCancelTargetType(null);
    setCancelReason("");
  }, [
    cancelTarget,
    cancelReason,
    cancelMutation,
    cancelIncomeMutation,
    cancelTargetGate.useFlexWriter,
    cancelTargetGate.useIncomeDoor,
    cancelTargetVoucher,
    flexCancelMutation,
  ]);

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
            onPostApproved={(v) => setPostApprovedTarget(v)}
            onReversePosting={(v) => setReverseTarget(v)}
            onUnapprove={handleUnapproveVoucher}
            onVerify={handleVerifyVoucher}
            onCopy={(v) => setCopyVoucher(v)}
            onHistory={(v) => setHistoryVoucher(v)}
            cancelEligibility={cancelEligibility}
            incomeCancelEligibility={incomeCancelEligibility}
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
      {/* Đợt 4: lịch sử phiếu — mốc lập/duyệt/huỷ + lý do + nhật ký trước/sau. */}
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
        open={!!cancelTarget}
        onOpenChange={() => {
          setCancelTarget(null);
          setCancelTargetType(null);
          setCancelReason("");
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận huỷ phiếu</AlertDialogTitle>
            <AlertDialogDescription>
              {cancelTargetPosted ? (
                <>
                  Phiếu này <b>đã {cancelTargetIsIncome ? "thu" : "chi"} tiền
                  thật</b>. Huỷ sẽ <b>trừ thẳng khoản này khỏi tồn quỹ</b> ngay,
                  không sinh thêm phiếu đối ứng nào trong danh sách. Phiếu
                  chuyển <b>Đã huỷ</b> và giữ lại đầy đủ mốc lập / duyệt / huỷ
                  cùng lý do để đối soát.
                </>
              ) : (
                <>
                  Phiếu sẽ được đánh dấu <b>Đã huỷ</b> và không còn ảnh hưởng
                  đến tồn quỹ tài khoản. Phiếu vẫn được lưu lại trong lịch sử.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* ĐỢT A: phiếu THU đi cửa riêng, huỷ CẢ ĐỢT THU nếu lần thu đó gồm
              nhiều phiếu (bộ đếm toàn vẹn định nghĩa bất biến ở mức đợt thu,
              huỷ lẻ một phiếu sẽ kẹt cổng an toàn của hệ thống). */}
          {cancelTargetIsIncome && cancelTargetGate.mode === "COLLECTION" && (
            <p className="rounded-md bg-blue-50 px-2 py-1.5 text-xs text-blue-800">
              Đây là khoản thu của một hoá đơn. Huỷ sẽ gỡ <b>cả lần thu đó</b>{" "}
              (kể cả khi lần thu gồm nhiều phiếu ở nhiều sổ quỹ) và{" "}
              <b>mở lại nợ trên hoá đơn</b> để thu lại.
            </p>
          )}
          {cancelTargetIsIncome && cancelTargetGate.mode === "FORFEIT_PAIR" && (
            <p className="rounded-md bg-blue-50 px-2 py-1.5 text-xs text-blue-800">
              Phiếu này là một chân của cặp cấn cọc bỏ cọc — huỷ sẽ lật{" "}
              <b>cả hai chân</b> để hai sổ không lệch nhau.
            </p>
          )}
          {/* Sự thật về QUYỀN. Phiếu THU (ĐỢT A, quyết định của chủ 01/08/2026):
              chỉ người đã thu / chủ tổ chức / super admin — không còn đòi giữ
              sổ, không còn đòi quyền theo toà. Phiếu CHI giữ luật cũ. */}
          <p className="text-xs text-muted-foreground">
            {cancelTargetIsIncome
              ? "Người huỷ được: chính người đã thu khoản này, chủ tổ chức, hoặc super admin."
              : "Người huỷ được: chủ tổ chức, super admin, người tạo phiếu — hoặc người vừa có quyền huỷ thu chi ở toà này vừa đang giữ sổ quỹ của phiếu (CUSTODIAN)."}
          </p>
          {/* Server đã nói trước là không huỷ được thì nói luôn ở đây, đừng để
              người dùng gõ xong lý do rồi mới ăn toast lỗi. */}
          {cancelTargetGate.reason && (
            <p
              className={
                cancelTargetGate.canCancel
                  ? "rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800"
                  : "rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700"
              }
            >
              {cancelTargetGate.canCancel ? "Lưu ý: " : "Không huỷ được: "}
              {cancelTargetGate.reason}
            </p>
          )}
          {/* Đợt 4: lý do là BẮT BUỘC ở mọi trạng thái. Đây là vế "đổi lại"
              của thoả thuận: cho huỷ thẳng không sinh phiếu đối ứng, nhưng
              phiếu đã huỷ phải tự giải thích được khi đối soát về sau. */}
          <div className="space-y-1">
            <Textarea
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Lý do huỷ (bắt buộc, ít nhất 8 ký tự) — ví dụ: ghi nhầm số tiền, khách huỷ giao dịch…"
              rows={2}
            />
            <p className="text-xs text-muted-foreground">
              Lý do được lưu cùng mốc lập / duyệt / huỷ phiếu để đối soát lại khi cần.
            </p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Đóng</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmCancel}
              disabled={
                cancelReason.trim().length < 8 ||
                !cancelTargetGate.canCancel ||
                flexCancelMutation.isPending ||
                cancelIncomeMutation.isPending ||
                cancelMutation.isPending
              }
              className="bg-red-600 hover:bg-red-700"
            >
              {cancelTargetPosted ? "Huỷ phiếu & trừ khỏi sổ quỹ" : "Huỷ phiếu"}
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
              {v2ApproveOnly ? (
                <>
                  <b>Duyệt</b> chỉ chuyển trạng thái phê duyệt — <b>không</b> thay
                  đổi tồn quỹ. Tiền chỉ vào/ra sổ khi thực hiện <b>Thu/Chi</b> với
                  đủ ngày, sổ quỹ và chứng từ.
                </>
              ) : (
                <>
                  Sau khi duyệt, phiếu sẽ được tính vào <b>tồn quỹ</b> và không
                  còn chỉnh sửa được. Hãy chắc chắn đã thanh toán cho người nhận.
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
                confirmApprove();
              }}
              disabled={
                approveMutation.isPending ||
                quickUpdateMutation.isPending ||
                approveV2Mutation.isPending ||
                (!v2ApproveOnly && isShareholderPayout && !approveAccountId)
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
          onAttachEvidence={(file) =>
            attachPostingEvidence(file, {
              voucherId: approveTarget.id,
              userId: authUser?.id ?? "",
              organizationId: (approveTarget as { organization_id?: string | null })
                .organization_id,
            })
          }
          onRemoveAttachment={(url) =>
            removePostingAttachment(approveTarget.id, url)
          }
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
            <AlertDialogTitle>Hoàn tác {reverseTarget?.type === "INCOME" ? "khoản thu" : "khoản chi"}</AlertDialogTitle>
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
            <AlertDialogCancel>Đóng</AlertDialogCancel>
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
          expectedApprovalVersion={postApprovedTarget.approval_version ?? 1}
          expectedPostingVersion={postApprovedTarget.posting_version ?? 1}
          onAdoptAttachments={adoptVoucherAttachmentsAsEvidence}
          onAttachEvidence={(file) =>
            attachPostingEvidence(file, {
              voucherId: postApprovedTarget.id,
              userId: authUser?.id ?? "",
              organizationId: postApprovedTarget.organization_id,
            })
          }
          onRemoveAttachment={(url) =>
            removePostingAttachment(postApprovedTarget.id, url)
          }
          onUploadEvidence={(file) =>
            uploadFinanceEvidence(file, postApprovedTarget.organization_id)
          }
          onSubmit={async (input) => {
            await postApprovedV2Mutation.mutateAsync(input);
            setPostApprovedTarget(null);
          }}
          isSubmitting={postApprovedV2Mutation.isPending}
        />
      )}

      <AlertDialog
        open={!!unapproveTarget}
        onOpenChange={() => setUnapproveTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận huỷ duyệt phiếu</AlertDialogTitle>
            <AlertDialogDescription>
              Phiếu sẽ chuyển về trạng thái <b>Chờ duyệt</b> và không còn tính vào{" "}
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
