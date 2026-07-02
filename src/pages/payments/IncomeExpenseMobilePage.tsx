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
import {
  useIncomeExpenses,
  useIncomeExpenseStats,
  useIncomeExpenseBatches,
  useCancelIncomeExpense,
  useRestoreIncomeExpense,
  useApproveVoucher,
  useCancelIncomeExpenseBatch,
  type IncomeExpenseWithRelations,
  type IncomeExpenseFilters,
} from "@/hooks/useIncomeExpenses";
import { usePagination } from "@/hooks/usePagination";
import { useRoomIdsByCode } from "@/hooks/useRoomIdsByCode";
import { isRoomCodeQuery, resolveSearch } from "@/lib/roomCodeSearch";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { canUse } from "@/lib/permissionPages";
import IncomeExpenseFilterPanel from "@/components/income-expenses/IncomeExpenseFilterPanel";
import IncomeExpenseFilterChips from "@/components/income-expenses/IncomeExpenseFilterChips";
import IncomeExpenseDetailMobile from "@/components/income-expenses/IncomeExpenseDetailMobile";
import IncomeExpenseForm from "@/components/income-expenses/IncomeExpenseForm";
import IncomeExpenseQuickCreateDialog from "@/components/income-expenses/IncomeExpenseQuickCreateDialog";
import IncomeExpenseBatchForm from "@/components/income-expenses/IncomeExpenseBatchForm";
import IncomeExpenseQuickEditDialog from "@/components/income-expenses/IncomeExpenseQuickEditDialog";
import IncomeExpenseBatchListMobile from "@/components/income-expenses/IncomeExpenseBatchListMobile";
import IncomeExpenseBatchDetailMobile from "@/components/income-expenses/IncomeExpenseBatchDetailMobile";
import PayViaBankAppSheet from "@/components/income-expenses/PayViaBankAppSheet";

const EMPTY_FILTERS: IncomeExpenseFilters = {
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
  type_category: null,
  creator_id: null,
  amount_target: null,
  verified_status: null,
  period_start_month: null,
  period_end_month: null,
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

  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  // Vào /income-expense?account_id=xxx (vd "Xem thu chi" từ 1 sổ quỹ) → lọc sẵn
  // theo sổ đó, ĐỒNG BỘ với desktop. Không có param → xem tất cả (RLS lọc).
  const [filters, setFilters] = useState<IncomeExpenseFilters>(() => {
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
  const [viewMode, setViewMode] = useState<"individual" | "batch">("individual");
  const [filterOpen, setFilterOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const [detailVoucher, setDetailVoucher] =
    useState<IncomeExpenseWithRelations | null>(null);
  const [shareVoucher, setShareVoucher] =
    useState<IncomeExpenseWithRelations | null>(null);
  const [editingVoucher, setEditingVoucher] =
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
  const [approveTarget, setApproveTarget] = useState<string | null>(null);
  const [cancelBatchTarget, setCancelBatchTarget] = useState<string | null>(null);

  const pagination = usePagination(50);

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
    amount_target: parsed.amountTarget,
    room_ids: parsed.roomIds ?? filters.room_ids,
  };

  const { data: listResult, isLoading } = useIncomeExpenses(
    effectiveFilters,
    { page: pagination.page, pageSize: pagination.pageSize },
    parsed.text,
  );
  const { data: batchResult, isLoading: isBatchLoading } =
    useIncomeExpenseBatches(
      effectiveFilters,
      { page: pagination.page, pageSize: pagination.pageSize },
      parsed.text,
    );
  const { data: stats, isLoading: isStatsLoading } =
    useIncomeExpenseStats(effectiveFilters);

  const vouchers = listResult?.data ?? [];
  const totalCount = listResult?.totalCount ?? 0;
  const batches = batchResult?.data ?? [];
  const batchTotalCount = batchResult?.totalCount ?? 0;
  const detailBatch =
    detailBatchId !== null
      ? batches.find((b) => b.id === detailBatchId) ?? null
      : null;

  const statsData = stats ?? { totalIncome: 0, totalExpense: 0, difference: 0 };
  const positive = statsData.difference >= 0;

  const cancelMutation = useCancelIncomeExpense();
  const restoreMutation = useRestoreIncomeExpense();
  const approveMutation = useApproveVoucher();
  const cancelBatchMutation = useCancelIncomeExpenseBatch();

  const { data: perms } = useMyPermissions();
  const canCreate = canUse(perms, "income_expenses", "create");

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
                    const accent = inc ? "#10b981" : "#ef4444";
                    const cancelled = v.approval_status === "CANCELLED";
                    const draft = v.approval_status === "UNAPPROVED";
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
                              Nháp
                            </span>
                          )}
                          <span
                            className="vch-amt"
                            style={{ color: accent, marginLeft: "auto" }}
                          >
                            {inc ? "+" : "−"}
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
              onApprove={(id) => setApproveTarget(id)}
              onCancel={(id) => setCancelTarget(id)}
              onRestore={(id) => setRestoreTarget(id)}
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
        onOpenChange={() => setCancelTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận huỷ phiếu</AlertDialogTitle>
            <AlertDialogDescription>
              Phiếu sẽ được đánh dấu <b>Đã huỷ</b> và không còn ảnh hưởng đến tồn
              quỹ tài khoản. Phiếu vẫn được lưu lại trong lịch sử.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Đóng</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (cancelTarget) cancelMutation.mutate(cancelTarget);
                setCancelTarget(null);
              }}
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
        onOpenChange={() => setApproveTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận duyệt phiếu</AlertDialogTitle>
            <AlertDialogDescription>
              Sau khi duyệt, phiếu sẽ được tính vào <b>tồn quỹ</b> và không còn
              chỉnh sửa được. Hãy chắc chắn đã thanh toán cho người nhận.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Đóng</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (approveTarget) approveMutation.mutate(approveTarget);
                setApproveTarget(null);
              }}
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
