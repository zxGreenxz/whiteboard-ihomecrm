import { useMemo, useState } from "react";
import { format, startOfMonth, endOfMonth } from "date-fns";
import {
  ChevronLeft, ChevronRight, CalendarDays, SlidersHorizontal, X, Check,
  TrendingUp, TrendingDown, CircleDollarSign, BarChart3, Plus,
} from "lucide-react";
import { useBuildings } from "@/hooks/useBuildings";
import { usePersistedState } from "@/hooks/usePersistedState";
import {
  useIncomeExpenses, useIncomeExpenseStats, type IncomeExpenseFilters,
} from "@/hooks/useIncomeExpenses";
import { useAccrualMonthReport } from "@/hooks/useAccrualReport";
import { useInvoice } from "@/hooks/useInvoices";
import { useUiPrefBool, useSetUiPreference } from "@/hooks/useUiPreferences";
import { useHiddenInReportTypes, useIncomeExpenseTypes } from "@/hooks/useIncomeExpenseTypes";
import { formatPeriod } from "@/lib/monthPeriod";
import {
  FIXED_EXPENSE_CATEGORIES,
  expenseRankOf,
  findTypeForFixedCategory,
} from "@/lib/fixedExpenseCategories";
import PaymentsSummaryDialog from "@/components/invoices/PaymentsSummaryDialog";
import InvoiceDetailModal from "@/components/invoices/InvoiceDetailModal";
import IncomeExpenseForm, {
  type IncomeExpensePrefill,
} from "@/components/income-expenses/IncomeExpenseForm";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { canUse } from "@/lib/permissionPages";
import { toast } from "sonner";
import ProfitVerificationBar from "@/components/reports/ProfitVerificationBar";

// Giao diện MOBILE cho báo cáo Phân bổ lợi nhuận (import từ thiết kế claude.ai/design
// "Phân bổ lợi nhuận (mobile)"). Dùng CHUNG hook/dữ liệu với bản desktop
// (ProfitDistributionReport) — chỉ khác cách trình bày: thẻ + bottom sheet thay cho
// bảng 2 cột. Bản desktop/mobile rẽ nhánh bằng usePhoneViewport ở component bao ngoài.

const fmtFull = (n: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(n || 0);

function fmtShort(n: number): string {
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);
  if (a >= 1e9) return sign + (a / 1e9).toFixed(a % 1e9 === 0 ? 0 : 2).replace(/\.?0+$/, "") + " tỷ";
  if (a >= 1e6) return sign + Math.round(a / 1e6).toLocaleString("vi-VN") + " tr";
  if (a >= 1e3) return sign + Math.round(a / 1e3).toLocaleString("vi-VN") + "k";
  return sign + a.toLocaleString("vi-VN") + "đ";
}

interface MRow {
  key: string; desc: string; building: string; room: string | null;
  type: string; period: string; amount: number; notKqkd: boolean; invoiceId: string | null;
  // category (income_expense_types.category) — dùng sắp ưu tiên + dò hạng mục cố định.
  category?: string | null;
  // Dòng placeholder "chưa có phiếu" cho hạng mục chi cố định còn thiếu.
  isMissingExpense?: boolean;
  fixedRank?: number;
}

const CARD = "rounded-xl border border-[#e7e3da] bg-white shadow-sm";

export default function ProfitDistributionMobile() {
  const now = new Date();
  const [ym, setYm] = usePersistedState("flt:rpt-profit-dist-mb:ym", { m: now.getMonth() + 1, y: now.getFullYear() });
  const [buildingIds, setBuildingIds] = usePersistedState<string[]>("flt:rpt-profit-dist-mb:buildingIds", []);
  const [side, setSide] = usePersistedState<"income" | "expense">("flt:rpt-profit-dist-mb:side", "income");
  const [accrualMode, setAccrualMode] = usePersistedState("flt:rpt-profit-dist-mb:accrualMode", true);
  const [pnlOnly, setPnlOnly] = usePersistedState("flt:rpt-profit-dist-mb:pnlOnly", true); // false ⇒ gồm khoản cọc/không KQKD
  const [filterOpen, setFilterOpen] = useState(false);
  const [monthOpen, setMonthOpen] = useState(false);
  const [detailInvoiceId, setDetailInvoiceId] = useState<string | null>(null);
  // Tap TÊN hoá đơn → modal chi tiết hoá đơn (như trang /invoices);
  // tap chỗ khác trên thẻ → dialog "Các lần thanh toán" như cũ.
  const [invoiceModal, setInvoiceModal] = useState<{ id: string; title: string } | null>(null);

  const hideSpecialTypes = useUiPrefBool("pd_hideSpecialTypes", false);
  const hideStatCards = useUiPrefBool("pd_hideStatCards", false);
  const setUiPref = useSetUiPreference();

  const monthDate = new Date(ym.y, ym.m - 1, 1);
  const startDate = format(startOfMonth(monthDate), "yyyy-MM-dd");
  const endDate = format(endOfMonth(monthDate), "yyyy-MM-dd");
  const ymStr = `${ym.y}-${String(ym.m).padStart(2, "0")}`;
  const monthLabel = `${String(ym.m).padStart(2, "0")}/${ym.y}`;

  const { data: buildings = [] } = useBuildings({ includeVirtual: true });
  const { data: specialTypes = [] } = useHiddenInReportTypes();
  const specialTypeIds = useMemo(() => new Set(specialTypes.map((t) => t.id)), [specialTypes]);
  const specialTypeNames = useMemo(
    () => new Set(specialTypes.map((t) => t.name.trim().toLowerCase()).filter(Boolean)),
    [specialTypes],
  );

  const filters: IncomeExpenseFilters = {
    building_ids: buildingIds.length ? buildingIds : undefined,
    start_date: startDate,
    end_date: endDate,
    approval_status: "APPROVED",
    business_result_only: pnlOnly,
  };

  const { data: accrual } = useAccrualMonthReport(accrualMode ? ymStr : "", filters, { businessResultOnly: pnlOnly });
  // enabled: cash chỉ được đọc ở nhánh !accrualMode (đồng bộ desktop) — đừng
  // kéo 2000 dòng khi đang dồn tích.
  const { data: cash } = useIncomeExpenses(filters, { page: 1, pageSize: 2000 }, undefined, {
    enabled: !accrualMode,
  });
  const { data: stats } = useIncomeExpenseStats(filters, { businessResultOnly: pnlOnly });
  const { data: detailInvoice } = useInvoice(detailInvoiceId ?? undefined);

  // Cùng công thức với desktop: tiền mặt + gồm-cọc → tổng MỌI khoản (allIncome).
  const cashIncome = pnlOnly ? stats?.totalIncome ?? 0 : stats?.allIncome ?? stats?.totalIncome ?? 0;
  const cashExpense = pnlOnly ? stats?.totalExpense ?? 0 : stats?.allExpense ?? stats?.totalExpense ?? 0;
  const displayIncome = accrualMode ? accrual?.totalIncome ?? 0 : cashIncome;
  const displayExpense = accrualMode ? accrual?.totalExpense ?? 0 : cashExpense;
  const displayDiff = displayIncome - displayExpense;

  const isSpecial = (typeId?: string | null, typeName?: string) =>
    (!!typeId && specialTypeIds.has(typeId)) || specialTypeNames.has((typeName ?? "").trim().toLowerCase());

  const { incomeRows, expenseRows } = useMemo(() => {
    const inc: MRow[] = [], exp: MRow[] = [];
    if (accrualMode) {
      for (const r of (accrual?.rows ?? []) as any[]) {
        if (hideSpecialTypes && isSpecial(r.typeId, r.typeName)) continue;
        const base = {
          desc: r.voucherName || "", building: r.buildingName || "—", room: r.roomName ?? null,
          type: r.typeName || "—", period: formatPeriod(r.startDate, r.endDate) || "",
          notKqkd: r.countsInBusinessResult === false, invoiceId: r.invoiceId ?? null,
          category: r.category ?? null,
        };
        if (r.income > 0) inc.push({ ...base, key: r.itemId, amount: r.income });
        if (r.expense > 0) exp.push({ ...base, key: r.itemId + "-e", amount: r.expense });
      }
    } else {
      for (const v of (cash?.data ?? []) as any[]) {
        // Chế độ P&L (pnlOnly): tính PHẦN KQKD của phiếu (kqkd_amount — phiếu
        // trộn thu HĐ gộp cọc chỉ tính phần doanh thu); tắt → cả phiếu.
        const kqkd = Number(v.kqkd_amount ?? v.total_amount) || 0;
        const row: MRow = {
          key: v.id, desc: v.name || "", building: v.building?.name || "—", room: v.room?.name ?? null,
          type: "—", period: "", notKqkd: kqkd <= 0,
          invoiceId: v.invoice_id ?? null,
          category: null,
          amount: pnlOnly ? kqkd : Number(v.total_amount) || 0,
        };
        if (v.type === "INCOME") inc.push(row);
        else if (v.type === "EXPENSE") exp.push(row);
      }
    }
    // Cột Chi: hạng mục cố định (Tiền nhà → Điện → … → Thang máy) lên đầu — cùng
    // thứ tự với desktop (module dùng chung). Chế độ tiền mặt thiếu category ⇒ rank
    // cuối, giữ nguyên thứ tự nguồn.
    exp.sort(
      (a, b) =>
        expenseRankOf(a.category, a.type, a.desc, a.fixedRank) -
        expenseRankOf(b.category, b.type, b.desc, b.fixedRank),
    );
    return { incomeRows: inc, expenseRows: exp };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accrualMode, accrual, cash, hideSpecialTypes, specialTypeIds, specialTypeNames, pnlOnly]);

  const incomeTotal = incomeRows.reduce((s, r) => s + r.amount, 0);
  const expenseTotal = expenseRows.reduce((s, r) => s + r.amount, 0);

  // Toà đang lọc (chỉ khi đúng 1 toà) — đọc cờ has_elevator + tên cho placeholder.
  const singleBuilding = useMemo(
    () => (buildingIds.length === 1 ? (buildings as any[]).find((b) => b.id === buildingIds[0]) ?? null : null),
    [buildings, buildingIds],
  );

  // Tạo phiếu chi ngay tại trang (nút + dưới toggle & tap card "chưa có phiếu")
  // — đồng bộ desktop. Prefill giữ trong state (identity ổn định cho effect
  // reset của form); kỳ item = tháng đang xem.
  const { data: perms } = useMyPermissions();
  const canCreate = canUse(perms, "income_expenses", "create");
  const { data: expenseTypes = [] } = useIncomeExpenseTypes("expense", { enabled: canCreate });
  const [expenseFormOpen, setExpenseFormOpen] = useState(false);
  const [expensePrefill, setExpensePrefill] = useState<IncomeExpensePrefill | undefined>();
  const openCreateExpense = () => {
    setExpensePrefill({
      building_id: singleBuilding && !singleBuilding.is_virtual ? singleBuilding.id : undefined,
      period: { start_date: startDate, end_date: endDate },
    });
    setExpenseFormOpen(true);
  };
  const openCreateMissingExpense = (r: MRow) => {
    const type = findTypeForFixedCategory(expenseTypes, r.fixedRank ?? -1);
    if (!type)
      toast.info(`Không tìm thấy loại chi khớp "${r.type}" — chọn hạng mục thủ công trong form`);
    setExpensePrefill({
      // Card missing chỉ sinh khi đang lọc đúng 1 toà thật (không ảo).
      building_id: singleBuilding?.id,
      period: { start_date: startDate, end_date: endDate },
      items: type
        ? [{ income_expense_type_id: type.id, type_name: type.name, quantity: 1, unit_price: 0 }]
        : undefined,
    });
    setExpenseFormOpen(true);
  };
  // Chèn dòng placeholder "chưa có phiếu" cho hạng mục chi cố định còn thiếu —
  // CHỈ khi lọc đúng 1 toà & đang ở chế độ phân bổ theo kỳ (accrual, category tin
  // cậy). `!accrual` = chưa tải xong → không hiện để tránh nháy 9 dòng thiếu.
  // Placeholder KHÔNG vào expenseRows nên số đếm/tổng giữ nguyên.
  const displayExpenseRows = useMemo(() => {
    // Bỏ qua toà ẢO "Chung" (bucket chia LN cổ đông) — không có phiếu cố định.
    if (!accrualMode || !singleBuilding || singleBuilding.is_virtual || !accrual) return expenseRows;
    // Dò "đã có phiếu" trên NGUỒN accrual.rows đầy đủ (kể cả hạng mục đang bị ẩn
    // bởi "Ẩn hạng mục đặc biệt") để không báo thiếu nhầm.
    const present = new Set<number>();
    for (const r of (accrual.rows ?? []) as any[])
      if ((r.expense ?? 0) > 0) present.add(expenseRankOf(r.category, r.typeName, r.voucherName));
    const missing: MRow[] = [];
    FIXED_EXPENSE_CATEGORIES.forEach((cat, i) => {
      if (present.has(i)) return;
      if (cat.requiresElevator && !singleBuilding.has_elevator) return;
      missing.push({
        key: `missing-exp-${i}`, desc: cat.label, building: singleBuilding.name ?? "—",
        room: null, type: cat.label, period: "", amount: 0, notKqkd: false,
        invoiceId: null, category: null, isMissingExpense: true, fixedRank: i,
      });
    });
    if (missing.length === 0) return expenseRows;
    return [...expenseRows, ...missing].sort(
      (a, b) =>
        expenseRankOf(a.category, a.type, a.desc, a.fixedRank) -
        expenseRankOf(b.category, b.type, b.desc, b.fixedRank),
    );
  }, [expenseRows, accrualMode, singleBuilding, accrual]);

  const rows = side === "income" ? incomeRows : displayExpenseRows;

  // B5: phần dòng bị ẩn bởi "Ẩn hạng mục đặc biệt" (mobile lọc ngay khi build
  // rows nên tính lại từ nguồn để thanh kiểm chứng giải thích được số lệch).
  const { hiddenCount, hiddenSum } = useMemo(() => {
    if (!hideSpecialTypes) return { hiddenCount: 0, hiddenSum: 0 };
    let c = 0, t = 0;
    if (accrualMode) {
      for (const r of (accrual?.rows ?? []) as any[]) {
        if (isSpecial(r.typeId, r.typeName)) { c++; t += (r.income || 0) + (r.expense || 0); }
      }
    }
    return { hiddenCount: c, hiddenSum: t };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hideSpecialTypes, accrualMode, accrual, specialTypeIds, specialTypeNames]);
  const capWarning =
    !accrualMode && (cash?.totalCount ?? 0) > (cash?.data?.length ?? 0)
      ? { shown: cash?.data?.length ?? 0, total: cash?.totalCount ?? 0 }
      : null;

  const filterCount =
    buildingIds.length + (hideSpecialTypes ? 1 : 0) + (!pnlOnly ? 1 : 0) + (hideStatCards ? 1 : 0);

  const toggleBuilding = (id: string) =>
    setBuildingIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const shiftMonth = (delta: number) =>
    setYm((p) => {
      const d = new Date(p.y, p.m - 1 + delta, 1);
      return { m: d.getMonth() + 1, y: d.getFullYear() };
    });
  const profitPos = displayDiff >= 0;

  return (
    <div className="space-y-3 pb-6">
      {/* Toolbar: điều hướng tháng + nút Lọc */}
      <div className="flex items-center gap-2">
        <button onClick={() => shiftMonth(-1)} aria-label="Tháng trước"
          className="h-11 w-11 shrink-0 grid place-items-center rounded-xl border border-[#e7e3da] bg-white text-[#514c42] shadow-sm active:scale-95">
          <ChevronLeft className="h-5 w-5" />
        </button>
        <button onClick={() => setMonthOpen(true)}
          className="flex-1 h-11 inline-flex items-center justify-center gap-2 rounded-xl border border-[#e7e3da] bg-white shadow-sm font-bold text-[15px] text-[#1b1813]">
          <CalendarDays className="h-4 w-4 text-[#1a6645]" />
          Tháng {monthLabel}
        </button>
        <button onClick={() => shiftMonth(1)} aria-label="Tháng sau"
          className="h-11 w-11 shrink-0 grid place-items-center rounded-xl border border-[#e7e3da] bg-white text-[#514c42] shadow-sm active:scale-95">
          <ChevronRight className="h-5 w-5" />
        </button>
        <button onClick={() => setFilterOpen(true)}
          className="relative h-11 px-3 inline-flex items-center gap-1.5 rounded-xl border border-[#e7e3da] bg-white shadow-sm font-bold text-[13px] text-[#514c42]">
          <SlidersHorizontal className="h-4 w-4" /> Lọc
          {filterCount > 0 && (
            <span className="ml-0.5 min-w-[16px] h-4 px-1 grid place-items-center rounded-full bg-[#1f7a52] text-white text-[10px] font-bold tabular-nums">
              {filterCount}
            </span>
          )}
        </button>
      </div>

      {/* P&L tóm tắt */}
      {!hideStatCards && (
        <div className="space-y-2.5">
          <div className="grid grid-cols-2 gap-2.5">
            <div className={`${CARD} p-3 flex flex-col gap-1.5`}>
              <span className="flex items-center gap-1.5 text-[10.5px] font-bold tracking-wide text-[#8d8678]">
                <TrendingUp className="h-3.5 w-3.5 text-[#1f9d57]" /> DOANH THU
              </span>
              <span className="font-mono font-bold text-xl leading-none text-[#0e7a47]">{fmtShort(displayIncome)}</span>
            </div>
            <div className={`${CARD} p-3 flex flex-col gap-1.5`}>
              <span className="flex items-center gap-1.5 text-[10.5px] font-bold tracking-wide text-[#8d8678]">
                <TrendingDown className="h-3.5 w-3.5 text-[#e0691f]" /> CHI PHÍ
              </span>
              <span className="font-mono font-bold text-xl leading-none text-[#c2570f]">{fmtShort(displayExpense)}</span>
            </div>
          </div>
          <div className={`rounded-xl px-4 py-3 flex items-center justify-between gap-3 border ${profitPos ? "border-[#cfe6d7] bg-[#eef7f0]" : "border-[#f3d6c4] bg-[#fdf0e8]"}`}>
            <span className="flex items-center gap-1.5 text-[11px] font-bold tracking-wide text-[#514c42]">
              <CircleDollarSign className={`h-4 w-4 ${profitPos ? "text-[#0e7a47]" : "text-[#c2570f]"}`} />
              LỢI NHUẬN <span className="font-semibold text-[#8d8678]">· Thu − Chi</span>
            </span>
            <span className={`font-mono font-bold text-[22px] leading-none ${profitPos ? "text-[#0e7a47]" : "text-[#c2570f]"}`}>
              {fmtShort(displayDiff)}
            </span>
          </div>
        </div>
      )}

      {/* B5: thanh kiểm chứng — cùng component với desktop */}
      <ProfitVerificationBar
        ym={ymStr}
        startDate={startDate}
        endDate={endDate}
        buildingIds={buildingIds}
        monthLabel={monthLabel}
        accrualMode={accrualMode}
        pnlOnly={pnlOnly}
        totalIncome={displayIncome}
        totalExpense={displayExpense}
        shownIncomeSum={incomeTotal}
        shownExpenseSum={expenseTotal}
        hiddenCount={hiddenCount}
        hiddenSum={hiddenSum}
        capWarning={capWarning}
      />

      {/* Chip chế độ */}
      <div className="flex gap-2">
        {[
          { on: accrualMode, label: "Phân bổ theo kỳ", toggle: () => setAccrualMode((v) => !v) },
          { on: !pnlOnly, label: "Gồm khoản cọc", toggle: () => setPnlOnly((v) => !v) },
        ].map((c) => (
          <button key={c.label} onClick={c.toggle}
            className={`flex-1 inline-flex items-center justify-center gap-1.5 h-9 rounded-xl border text-[12.5px] font-bold ${
              c.on ? "border-[#1f7a52] bg-[#e8f3ec] text-[#1a6645]" : "border-[#e7e3da] bg-white text-[#8d8678]"
            }`}>
            <span className={`h-2 w-2 rounded-full ${c.on ? "bg-[#1f7a52]" : "bg-[#cfcabd]"}`} /> {c.label}
          </button>
        ))}
      </div>

      {/* Chip toà đang lọc */}
      {buildingIds.length > 0 && (
        <div className="flex gap-2 overflow-x-auto [&::-webkit-scrollbar]:hidden">
          {buildingIds.map((id) => (
            <button key={id} onClick={() => toggleBuilding(id)}
              className="shrink-0 inline-flex items-center gap-1.5 text-[12px] font-semibold text-[#1a6645] bg-[#e8f3ec] border border-[#d2e8da] px-2.5 py-1.5 rounded-full">
              {(buildings as any[]).find((b) => b.id === id)?.name ?? "—"}
              <X className="h-3 w-3" />
            </button>
          ))}
          <button onClick={() => setBuildingIds([])}
            className="shrink-0 text-[12px] font-semibold text-[#8d8678] bg-[#faf8f4] border border-[#e7e3da] px-2.5 py-1.5 rounded-full">
            Xoá lọc
          </button>
        </div>
      )}

      {/* Phân đoạn Thu | Chi */}
      <div className="grid grid-cols-2 gap-2">
        {([
          { k: "income" as const, label: "Khoản thu", n: incomeRows.length, total: incomeTotal },
          { k: "expense" as const, label: "Khoản chi", n: expenseRows.length, total: expenseTotal },
        ]).map((s) => {
          const active = side === s.k;
          const tone = s.k === "income"
            ? (active ? "bg-[#0e7a47] text-white border-[#0e7a47]" : "")
            : (active ? "bg-[#c2570f] text-white border-[#c2570f]" : "");
          return (
            <button key={s.k} onClick={() => setSide(s.k)}
              className={`flex flex-col items-center gap-0.5 py-2 rounded-xl border ${active ? tone : "border-[#e7e3da] bg-white text-[#514c42]"}`}>
              <span className="text-[13px] font-bold">{s.label}</span>
              <span className="font-mono text-[11px] font-bold opacity-90">{s.n} · {fmtShort(s.total)}</span>
            </button>
          );
        })}
      </div>

      {/* Tạo phiếu chi tại chỗ — chỉ tab Khoản chi + có quyền create */}
      {side === "expense" && canCreate && (
        <button
          onClick={openCreateExpense}
          className="w-full h-10 inline-flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-[#e0a06f] bg-white text-[#c2570f] text-[13px] font-bold active:scale-[0.99]"
        >
          <Plus className="h-4 w-4" /> Tạo phiếu chi tháng {monthLabel}
        </button>
      )}

      {/* Danh sách khoản */}
      <div className="space-y-2">
        {rows.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-12 px-6 text-center">
            <div className="h-14 w-14 grid place-items-center rounded-2xl bg-[#faf8f4] border border-[#e7e3da] text-[#b6b0a3]">
              <BarChart3 className="h-6 w-6" />
            </div>
            <p className="text-[13.5px] text-[#8d8678] max-w-[240px] leading-relaxed">
              Không có khoản nào trong tháng {monthLabel} phù hợp bộ lọc.
            </p>
          </div>
        ) : (
          rows.map((r) => {
            const amtColor = side === "income" ? "text-[#0e7a47]" : "text-[#c2570f]";
            return (
              <div key={r.key}
                onClick={() => {
                  if (r.isMissingExpense) {
                    if (canCreate) openCreateMissingExpense(r);
                    return;
                  }
                  if (r.invoiceId) setDetailInvoiceId(r.invoiceId);
                }}
                className={`${CARD} p-3 ${
                  r.isMissingExpense
                    ? `!bg-[#fffbeb] !border-[#fde68a]${canCreate ? " cursor-pointer active:bg-[#fef3c7]" : ""}`
                    : r.invoiceId ? "active:bg-[#faf8f4] cursor-pointer" : ""
                }`}>
                <div className="flex items-center gap-2">
                  {r.room && (
                    <span className="font-mono font-bold text-[12px] text-[#1b1813] bg-[#faf8f4] border border-[#e7e3da] px-2 py-0.5 rounded-md">
                      {r.room}
                    </span>
                  )}
                  {r.notKqkd && (
                    <span className="text-[10px] font-bold text-[#b45309] bg-[#fdebc4] px-1.5 py-0.5 rounded">không KQKD</span>
                  )}
                  <span className={`ml-auto font-mono font-bold text-[14.5px] whitespace-nowrap ${r.isMissingExpense ? "text-[#b45309]" : amtColor}`}>
                    {r.isMissingExpense ? "—" : fmtFull(r.amount)}
                  </span>
                </div>
                <div className="mt-1.5 text-[13px] font-semibold text-[#514c42] leading-snug">
                  {r.invoiceId ? (
                    <span
                      className="underline decoration-dotted underline-offset-2"
                      onClick={(e) => {
                        e.stopPropagation();
                        setInvoiceModal({
                          id: r.invoiceId!,
                          title: r.desc + (r.room ? ` — ${r.room}` : ""),
                        });
                      }}
                    >
                      {r.desc}
                    </span>
                  ) : (
                    r.desc
                  )}
                  {r.isMissingExpense && (
                    <span className="ml-1 text-[11px] font-bold text-[#b45309]">(chưa có phiếu)</span>
                  )}
                </div>
                <div className="mt-1 flex items-center gap-1.5 flex-wrap text-[11.5px] text-[#8d8678]">
                  <span className="font-semibold text-[#514c42]">{r.type}</span>
                  <span className="text-[#b6b0a3]">·</span>
                  <span className="font-mono">{r.building}</span>
                  {r.period && (
                    <>
                      <span className="text-[#b6b0a3]">·</span>
                      <span className="font-mono">Kỳ {r.period}</span>
                    </>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      <div className="pt-3 border-t border-[#efece4] text-[11.5px] text-[#8d8678] leading-relaxed">
        Tổng <b className="text-[#514c42] font-bold">{incomeRows.length + expenseRows.length} khoản</b>
        {" · "}
        {accrualMode ? "ghi nhận theo kỳ áp dụng (phân bổ)" : "ghi nhận theo ngày phiếu"}
      </div>

      {/* ===== Bottom sheet: Bộ lọc & hiển thị ===== */}
      {filterOpen && (
        <div onClick={() => setFilterOpen(false)} className="fixed inset-0 z-50 bg-black/40 flex items-end justify-center">
          <div onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[480px] max-h-[88%] overflow-y-auto bg-white rounded-t-[22px] px-5 pt-2.5 pb-6 [&::-webkit-scrollbar]:hidden">
            <div className="w-10 h-1 rounded-full bg-[#efece4] mx-auto mb-3.5" />
            <div className="flex items-center gap-2 pb-1.5">
              <span className="text-[17px] font-bold text-[#1b1813]">Bộ lọc &amp; hiển thị</span>
              <button onClick={() => setFilterOpen(false)} aria-label="Đóng"
                className="ml-auto h-8 w-8 grid place-items-center rounded-lg border border-[#e7e3da] bg-[#faf8f4] text-[#514c42]">
                <X className="h-[18px] w-[18px]" />
              </button>
            </div>

            <div className="text-[10.5px] font-bold uppercase tracking-wide text-[#8d8678] mt-4 mb-2">Toà nhà</div>
            <div className="flex gap-2 flex-wrap">
              {(buildings as any[]).map((b) => {
                const on = buildingIds.includes(b.id);
                return (
                  <button key={b.id} onClick={() => toggleBuilding(b.id)}
                    className={`text-[12.5px] font-semibold px-3 py-1.5 rounded-full border ${
                      on ? "border-[#1f7a52] bg-[#e8f3ec] text-[#1a6645]" : "border-[#e7e3da] bg-[#faf8f4] text-[#514c42]"
                    }`}>
                    {b.name}
                  </button>
                );
              })}
            </div>

            <div className="text-[10.5px] font-bold uppercase tracking-wide text-[#8d8678] mt-5 mb-2">Cách ghi nhận</div>
            <div className="flex flex-col gap-2.5">
              <SwitchRow on={accrualMode} onToggle={() => setAccrualMode((v) => !v)}
                title="Phân bổ theo kỳ áp dụng" desc="Chia đều tiền theo kỳ thay vì ngày phiếu" />
              <SwitchRow on={!pnlOnly} onToggle={() => setPnlOnly((v) => !v)}
                title="Gồm khoản không hạch toán KQKD" desc="Tiền cọc, chia lợi nhuận cổ đông…" />
            </div>

            <div className="text-[10.5px] font-bold uppercase tracking-wide text-[#8d8678] mt-5 mb-2">Hiển thị</div>
            <div className="flex flex-col gap-2.5">
              <SwitchRow on={hideSpecialTypes} onToggle={() => setUiPref.mutate({ key: "pd_hideSpecialTypes", value: !hideSpecialTypes })}
                title="Ẩn hạng mục đặc biệt" desc="Ẩn dòng (vd Tiền nhà) — số tổng giữ nguyên" />
              <SwitchRow on={!hideStatCards} onToggle={() => setUiPref.mutate({ key: "pd_hideStatCards", value: !hideStatCards })}
                title="Thẻ thống kê" desc="Doanh thu · Chi phí · Lợi nhuận" />
            </div>

            <div className="flex gap-2.5 mt-5">
              <button onClick={() => { setBuildingIds([]); setPnlOnly(true); setAccrualMode(true); }}
                className="flex-1 border border-[#e7e3da] bg-[#faf8f4] text-[#514c42] font-bold text-[13.5px] py-3 rounded-xl">
                Đặt lại
              </button>
              <button onClick={() => setFilterOpen(false)}
                className="flex-1 bg-[#1f7a52] text-white font-bold text-[13.5px] py-3 rounded-xl shadow-sm">
                Xong
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== Bottom sheet: Chọn tháng ===== */}
      {monthOpen && (
        <div onClick={() => setMonthOpen(false)} className="fixed inset-0 z-50 bg-black/40 flex items-end justify-center">
          <div onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[480px] bg-white rounded-t-[22px] px-5 pt-2.5 pb-6">
            <div className="w-10 h-1 rounded-full bg-[#efece4] mx-auto mb-3.5" />
            <div className="flex items-center gap-2 pb-3.5">
              <button onClick={() => setYm((p) => ({ ...p, y: p.y - 1 }))} aria-label="Năm trước"
                className="h-8 w-8 grid place-items-center rounded-lg border border-[#e7e3da] bg-[#faf8f4]">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-[17px] font-bold text-[#1b1813]">Năm {ym.y}</span>
              <button onClick={() => setYm((p) => ({ ...p, y: p.y + 1 }))} aria-label="Năm sau"
                className="h-8 w-8 grid place-items-center rounded-lg border border-[#e7e3da] bg-[#faf8f4]">
                <ChevronRight className="h-4 w-4" />
              </button>
              <button onClick={() => setMonthOpen(false)} aria-label="Đóng"
                className="ml-auto h-8 w-8 grid place-items-center rounded-lg border border-[#e7e3da] bg-[#faf8f4] text-[#514c42]">
                <X className="h-[18px] w-[18px]" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2.5">
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
                const active = m === ym.m;
                return (
                  <button key={m} onClick={() => { setYm((p) => ({ ...p, m })); setMonthOpen(false); }}
                    className={`py-3 rounded-xl border text-[13.5px] font-bold ${
                      active ? "border-[#1f7a52] bg-[#1f7a52] text-white" : "border-[#e7e3da] bg-[#faf8f4] text-[#514c42]"
                    }`}>
                    Tháng {m}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <PaymentsSummaryDialog
        open={!!detailInvoiceId}
        onOpenChange={(v) => { if (!v) setDetailInvoiceId(null); }}
        invoice={detailInvoice ?? null}
      />

      {/* Tap TÊN hoá đơn → chi tiết hoá đơn full-screen (như trang /invoices) */}
      <InvoiceDetailModal
        invoiceId={invoiceModal?.id ?? null}
        title={invoiceModal?.title}
        open={!!invoiceModal}
        onOpenChange={(v) => { if (!v) setInvoiceModal(null); }}
      />

      {/* Nút + / tap card "chưa có phiếu" → tạo phiếu chi tại chỗ
          (kỳ item = tháng đang xem; lưu xong query tự refetch). */}
      <IncomeExpenseForm
        open={expenseFormOpen}
        onOpenChange={(v) => {
          setExpenseFormOpen(v);
          if (!v) setExpensePrefill(undefined);
        }}
        voucher={null}
        defaultType="EXPENSE"
        defaultPrefill={expensePrefill}
      />
    </div>
  );
}

function SwitchRow({ on, onToggle, title, desc }: { on: boolean; onToggle: () => void; title: string; desc: string }) {
  return (
    <button onClick={onToggle}
      className="flex items-center gap-3 text-left rounded-xl border border-[#e7e3da] bg-[#faf8f4] px-3.5 py-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-[13.5px] font-bold text-[#1b1813]">{title}</span>
        <span className="text-[11.5px] text-[#8d8678]">{desc}</span>
      </div>
      <span className={`ml-auto shrink-0 w-[42px] h-[25px] rounded-full p-0.5 transition-colors ${on ? "bg-[#1f7a52]" : "bg-[#d9d4c8]"}`}>
        <span className={`block h-[21px] w-[21px] rounded-full bg-white shadow transition-transform ${on ? "translate-x-[17px]" : ""} flex items-center justify-center`}>
          {on && <Check className="h-3 w-3 text-[#1f7a52]" />}
        </span>
      </span>
    </button>
  );
}
