import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronLeft, ChevronRight, CalendarDays, SlidersHorizontal, Building2, X, Check,
  BarChart3, Plus, Settings2,
} from "lucide-react";
import { useBuildings } from "@/hooks/useBuildings";
import { usePersistedState } from "@/hooks/usePersistedState";
import {
  useIncomeExpenses, useIncomeExpenseStats, type IncomeExpenseFilters,
} from "@/hooks/useIncomeExpenses";
import { useAccrualMonthReport } from "@/hooks/useAccrualReport";
import {
  useInvoice, useInvoiceTotalsByIds, useFirstInvoiceDetails, useInvoiceRentPeriods,
} from "@/hooks/useInvoices";
import { useUiPrefBool, useSetUiPreference } from "@/hooks/useUiPreferences";
import { useHiddenInReportTypes, useIncomeExpenseTypes } from "@/hooks/useIncomeExpenseTypes";
import { useVacantRoomNotes } from "@/hooks/useReports";
import { vacancyNoteText } from "@/lib/vacancyReason";
import { compareRoomNames } from "@/lib/roomSort";
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
import MissingExpenseSettingsDialog from "@/components/reports/MissingExpenseSettingsDialog";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { canUse } from "@/lib/permissionPages";
import { toast } from "sonner";
import ProfitVerificationBar from "@/components/reports/ProfitVerificationBar";
import { MobileHeader, fmtShort } from "@/components/shareholders/profitMobileShared";
import { format, startOfMonth, endOfMonth } from "date-fns";

// Giao diện MOBILE tab "BC Thu Chi" của Báo cáo Lợi Nhuận — import từ thiết kế
// ProfitMobileC (mobile-app-finance-interface-design): header có pill tháng +
// nút toà + nút lọc, dải tổng 3 cột, thẻ dòng gọn 2 dòng, bottom sheet
// tháng/toà/lọc riêng. Dùng CHUNG hook/dữ liệu + logic dòng với bản desktop
// (ProfitDistributionReport): gộp theo hoá đơn, note thiếu/thừa, HĐ tháng đầu,
// phòng trống/thiếu hoá đơn, placeholder "chưa có phiếu".

// Bỏ dấu + thường hoá — khớp hạng mục bất kể cách gõ (đồng bộ desktop).
const nrm = (s: string | null | undefined): string =>
  (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .trim();

// 'YYYY-MM-DD' → 'dd/MM' (note kỳ tiền phòng — mobile rút gọn, desktop dd/MM/yyyy).
const fmtDayShort = (iso?: string | null): string => {
  if (!iso) return "—";
  const d = new Date(String(iso).slice(0, 10) + "T00:00:00");
  return Number.isNaN(d.getTime()) ? "—" : format(d, "dd/MM");
};

interface MRow {
  key: string;
  desc: string;
  building: string;
  room: string | null;
  roomId?: string | null;
  type: string;
  period: string;
  amount: number;
  notKqkd: boolean;
  invoiceId: string | null;
  category?: string | null;
  typeId?: string | null;
  // Số khoản thu gộp cùng 1 hoá đơn (>1 ⇒ "(N lần)").
  groupCount?: number;
  // Σ khoản thanh lý cùng HĐ đã tách dòng riêng — bù khi so thiếu/thừa.
  liqSiblingAmount?: number;
  // Dòng doanh thu thanh lý/bỏ cọc → nền vàng cam.
  isLiq?: boolean;
  // Dòng ghi chú thuần (amount 0, không tính tổng/đếm).
  isNote?: boolean;
  isMissingInvoice?: boolean;
  isVacantNote?: boolean;
  isMissingExpense?: boolean;
  fixedRank?: number;
}

const isLiquidation = (typeName: string, desc: string): boolean => {
  const s = nrm(`${typeName} ${desc}`);
  return s.includes("bo coc") || s.includes("thanh ly");
};

const compareRoom = (a: string | null, b: string | null): number => {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return compareRoomNames(a, b);
};

const LIST_LIMIT = 2000;

export default function ProfitDistributionMobile({ onBack }: { onBack?: () => void }) {
  const navigate = useNavigate();
  const now = new Date();
  const [ym, setYm] = usePersistedState("flt:rpt-profit-dist-mb:ym", { m: now.getMonth() + 1, y: now.getFullYear() });
  const [buildingIds, setBuildingIds] = usePersistedState<string[]>("flt:rpt-profit-dist-mb:buildingIds", []);
  const [side, setSide] = usePersistedState<"income" | "expense">("flt:rpt-profit-dist-mb:side", "income");
  const [accrualMode, setAccrualMode] = usePersistedState("flt:rpt-profit-dist-mb:accrualMode", true);
  const [pnlOnly, setPnlOnly] = usePersistedState("flt:rpt-profit-dist-mb:pnlOnly", true); // false ⇒ gồm khoản cọc/không KQKD
  const [sheet, setSheet] = useState<null | "month" | "bld" | "filter">(null);
  // Thanh kiểm chứng ẨN mặc định — chỉ khi CÓ LỆCH mới hiện chấm đỏ chớp ở ô
  // LỢI NHUẬN; bấm chấm mới xổ thanh ra (yêu cầu chủ 11/07).
  const [hasVerifyIssue, setHasVerifyIssue] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [detailInvoiceId, setDetailInvoiceId] = useState<string | null>(null);
  // Tap TÊN dòng → modal chi tiết hoá đơn; tap chỗ khác trên thẻ → "Các lần thanh toán".
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
    // Finance V2 §2.3: phiếu CHỜ DUYỆT vẫn ghi nhận KQKD — tính cả UNAPPROVED,
    // thanh kiểm chứng nêu counter riêng (đồng bộ desktop).
    approval_status: "ALL_ACTIVE",
    business_result_only: pnlOnly,
  };

  const { data: accrual, isLoading: accrualLoading } = useAccrualMonthReport(
    accrualMode ? ymStr : "", filters, { businessResultOnly: pnlOnly },
  );
  // Cash chỉ đọc ở nhánh !accrualMode (đồng bộ desktop) — đừng kéo 2000 dòng khi đang dồn tích.
  const { data: cash, isLoading: cashLoading } = useIncomeExpenses(
    filters, { page: 1, pageSize: LIST_LIMIT }, undefined, { enabled: !accrualMode },
  );
  const { data: stats } = useIncomeExpenseStats(filters, { businessResultOnly: pnlOnly });
  const { data: detailInvoice } = useInvoice(detailInvoiceId ?? undefined);
  // Phòng trống / thiếu hoá đơn trong tháng (cột Thu) — cùng hook desktop.
  const { data: vacantNotes } = useVacantRoomNotes(buildingIds, endDate, true);
  // Mốc đếm số ngày trống: tháng cũ chốt theo cuối tháng, tháng hiện tại tới hôm nay.
  const todayStr = format(new Date(), "yyyy-MM-dd");
  const vacancyRefDate = endDate < todayStr ? endDate : todayStr;

  const loading = accrualMode ? accrualLoading : cashLoading;

  // §2.3: phần "chờ duyệt" trong tổng — đồng bộ công thức desktop.
  const pendingInfo = useMemo(() => {
    if (accrualMode) {
      return {
        count: accrual?.pendingCount ?? 0,
        income: accrual?.pendingIncome ?? 0,
        expense: accrual?.pendingExpense ?? 0,
      };
    }
    let income = 0;
    let expense = 0;
    let count = 0;
    for (const r of (cash?.data ?? []) as any[]) {
      if (r.approval_status !== "UNAPPROVED") continue;
      count++;
      const amt = pnlOnly
        ? Number(r.kqkd_amount ?? r.total_amount) || 0
        : Number(r.total_amount) || 0;
      if (r.type === "INCOME") income += amt;
      else expense += amt;
    }
    return { count, income, expense };
  }, [accrualMode, accrual, cash, pnlOnly]);

  // Cùng công thức desktop: tiền mặt + gồm-cọc → tổng MỌI khoản (allIncome).
  const cashIncome = pnlOnly ? stats?.totalIncome ?? 0 : stats?.allIncome ?? stats?.totalIncome ?? 0;
  const cashExpense = pnlOnly ? stats?.totalExpense ?? 0 : stats?.allExpense ?? stats?.totalExpense ?? 0;
  const displayIncome = accrualMode ? accrual?.totalIncome ?? 0 : cashIncome;
  const displayExpense = accrualMode ? accrual?.totalExpense ?? 0 : cashExpense;
  const displayDiff = displayIncome - displayExpense;

  // ===== Dựng dòng thu/chi — PORT từ desktop (gộp hoá đơn, tách thanh lý, phòng trống) =====
  const { incomeRows, expenseRows } = useMemo(() => {
    const rawInc: MRow[] = [];
    const exp: MRow[] = [];

    if (accrualMode) {
      for (const r of (accrual?.rows ?? []) as any[]) {
        const base = {
          desc: r.voucherName ?? "",
          building: r.buildingName || "—",
          room: r.roomName ?? null,
          roomId: r.roomId ?? null,
          type: r.typeName || "—",
          period: formatPeriod(r.startDate, r.endDate) || "",
          category: r.category ?? null,
          typeId: r.typeId ?? null,
          notKqkd: r.countsInBusinessResult === false,
        };
        if (r.income > 0) rawInc.push({ ...base, key: r.itemId, amount: r.income, invoiceId: r.invoiceId ?? null });
        else if (r.expense > 0) exp.push({ ...base, key: r.itemId, amount: r.expense, invoiceId: null });
      }
    } else {
      for (const r of (cash?.data ?? []) as any[]) {
        const kqkd = Number(r.kqkd_amount ?? r.total_amount) || 0;
        const base = {
          desc: r.name ?? "",
          building: r.building_name ?? r.building?.name ?? "—",
          room: r.room_name ?? r.room?.name ?? null,
          roomId: r.room_id ?? null,
          type: "—",
          period: "",
          category: null as string | null,
          typeId: null as string | null,
          notKqkd: kqkd <= 0,
        };
        const items = (r.items || []) as any[];
        const skipDeposit = (it: any) =>
          pnlOnly && !!it.is_deposit && r.business_result_accounting !== true;

        // Phiếu thu gắn hoá đơn giữ 1 dòng/phiếu để gộp theo HĐ ở bước sau.
        if (r.type === "INCOME" && r.invoice_id) {
          const shownItems = items.filter((it) => !skipDeposit(it));
          const typeName = shownItems.map((it) => it.type_name).filter(Boolean).join(", ") || "—";
          rawInc.push({
            ...base, key: r.id, type: typeName,
            amount: pnlOnly ? kqkd : Number(r.total_amount) || 0,
            invoiceId: r.invoice_id,
          });
          continue;
        }
        // Phiếu khác → tách theo từng hạng mục (item).
        const rows: MRow[] =
          items.length > 0
            ? items.filter((it) => !skipDeposit(it)).map((it) => {
                const amt = Number(it.amount);
                const safe = Number.isFinite(amt) ? amt : Number(it.quantity) * Number(it.unit_price) || 0;
                return {
                  ...base,
                  key: `${r.id}:${it.id}`,
                  type: it.type_name || "—",
                  category: it.category ?? null,
                  typeId: it.income_expense_type_id ?? null,
                  notKqkd: base.notKqkd || (!!it.is_deposit && r.business_result_accounting !== true),
                  amount: safe,
                  invoiceId: null,
                };
              })
            : [{ ...base, key: r.id, amount: Number(r.total_amount) || 0, invoiceId: null }];
        for (const row of rows) {
          if (r.type === "INCOME") rawInc.push(row);
          else exp.push(row);
        }
      }
    }

    // Gộp khoản THU cùng hoá đơn thành 1 dòng — TÁCH khoản thanh lý/bỏ cọc nhóm riêng.
    const groups = new Map<string, MRow[]>();
    const liqByInvoice = new Map<string, number>();
    const inc: MRow[] = [];
    for (const r of rawInc) {
      if (r.invoiceId) {
        const liq = isLiquidation(r.type, r.desc);
        const k = liq ? `${r.invoiceId}:tl` : r.invoiceId;
        const g = groups.get(k);
        if (g) g.push(r);
        else groups.set(k, [r]);
        if (liq) liqByInvoice.set(r.invoiceId, (liqByInvoice.get(r.invoiceId) ?? 0) + r.amount);
      } else inc.push(r);
    }
    for (const [k, list] of groups) {
      const liqSibling = k.endsWith(":tl") ? 0 : liqByInvoice.get(list[0].invoiceId!) ?? 0;
      const extra = liqSibling > 0 ? { liqSiblingAmount: liqSibling } : undefined;
      const isLiq = k.endsWith(":tl");
      if (list.length === 1) inc.push({ ...list[0], groupCount: 1, isLiq, ...extra });
      else
        inc.push({
          ...list[0],
          key: `inv-${k}`,
          amount: list.reduce((s, x) => s + x.amount, 0),
          notKqkd: list.some((x) => x.notKqkd),
          groupCount: list.length,
          isLiq,
          ...extra,
        });
    }
    // Khoản thanh lý KHÔNG gắn hoá đơn cũng tô vàng cam. Bỏ qua dòng ghi chú —
    // "Trống N ngày … — Thanh lý HĐ" chứa "thanh ly" nhưng không phải khoản thật.
    for (const r of inc) if (!r.isNote && !r.isLiq && isLiquidation(r.type, r.desc)) r.isLiq = true;

    const sorter = (a: MRow, b: MRow) =>
      compareRoom(a.room, b.room) || a.desc.localeCompare(b.desc, "vi");
    exp.sort(
      (a, b) =>
        expenseRankOf(a.category, a.type, a.desc, a.fixedRank) -
          expenseRankOf(b.category, b.type, b.desc, b.fixedRank) || sorter(a, b),
    );

    if (!vacantNotes) {
      inc.sort(sorter);
      return { incomeRows: inc, expenseRows: exp };
    }
    // Phòng gắn cờ KHÔNG có khoản thu trong tháng → dòng ghi chú:
    //  - còn HĐ → đỏ "Chưa có hoá đơn"; trống thật → vàng cam "Trống phòng — lý do".
    const anyIncomeRooms = new Set<string>();
    for (const r of inc) if (r.roomId) anyIncomeRooms.add(r.roomId);
    for (const note of vacantNotes.values()) {
      if (anyIncomeRooms.has(note.roomId)) continue;
      if (note.kind === "active") {
        inc.push({
          key: `missing-${note.roomId}`,
          desc: "⚠️ Chưa có hoá đơn tháng này (còn HĐ)",
          building: note.buildingName, room: note.roomName, roomId: note.roomId,
          type: "—", period: "", amount: 0, notKqkd: false, invoiceId: null,
          isNote: true, isMissingInvoice: true,
        });
      } else {
        inc.push({
          key: `vacant-${note.roomId}`,
          desc: vacancyNoteText(note.reason, note.vacantSince, vacancyRefDate),
          building: note.buildingName, room: note.roomName, roomId: note.roomId,
          type: "—", period: "", amount: 0, notKqkd: false, invoiceId: null,
          isNote: true, isVacantNote: true,
        });
      }
    }
    inc.sort(sorter);
    return { incomeRows: inc, expenseRows: exp };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accrualMode, accrual, cash, vacantNotes, pnlOnly, vacancyRefDate]);

  // Ẩn hạng mục đặc biệt: chỉ ẩn DÒNG — tổng 3 ô giữ nguyên (kiểm chứng giải thích lệch).
  const isSpecialRow = (r: MRow) =>
    (!!r.typeId && specialTypeIds.has(r.typeId)) ||
    specialTypeNames.has((r.type ?? "").trim().toLowerCase());
  const shownIncomeRows = useMemo(
    () => (hideSpecialTypes ? incomeRows.filter((r) => !isSpecialRow(r)) : incomeRows),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [incomeRows, hideSpecialTypes, specialTypeIds, specialTypeNames],
  );
  const shownExpenseRows = useMemo(
    () => (hideSpecialTypes ? expenseRows.filter((r) => !isSpecialRow(r)) : expenseRows),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [expenseRows, hideSpecialTypes, specialTypeIds, specialTypeNames],
  );

  const sumRows = (rows: MRow[]) => rows.reduce((s, r) => (r.isNote ? s : s + r.amount), 0);
  const shownIncomeSum = useMemo(() => sumRows(shownIncomeRows), [shownIncomeRows]);
  const shownExpenseSum = useMemo(() => sumRows(shownExpenseRows), [shownExpenseRows]);
  const hiddenIncomeSum = sumRows(incomeRows) - shownIncomeSum;
  const hiddenExpenseSum = sumRows(expenseRows) - shownExpenseSum;
  const hiddenCount =
    incomeRows.length + expenseRows.length - shownIncomeRows.length - shownExpenseRows.length;
  const capWarning =
    !accrualMode && (cash?.totalCount ?? 0) > (cash?.data?.length ?? 0)
      ? { shown: cash?.data?.length ?? 0, total: cash?.totalCount ?? 0 }
      : null;

  // Tổng/đã thu hoá đơn + chi tiết HĐ tháng đầu + kỳ prorate — cho note thiếu/thừa.
  const invoiceIds = useMemo(
    () => Array.from(new Set(incomeRows.filter((r) => r.invoiceId).map((r) => r.invoiceId!))),
    [incomeRows],
  );
  const { data: invoiceTotals } = useInvoiceTotalsByIds(invoiceIds);
  const { data: firstInvoiceDetails } = useFirstInvoiceDetails(invoiceIds);
  const { data: rentPeriods } = useInvoiceRentPeriods(invoiceIds);

  // Toà đang lọc (đúng 1 toà) — đọc has_elevator + hidden_fixed_expenses cho placeholder.
  const singleBuilding = useMemo(
    () => (buildingIds.length === 1 ? (buildings as any[]).find((b) => b.id === buildingIds[0]) ?? null : null),
    [buildings, buildingIds],
  );

  const { data: perms } = useMyPermissions();
  const canCreate = canUse(perms, "income_expenses", "create");
  const canEditBuildings = canUse(perms, "buildings", "edit");
  const { data: expenseTypes = [] } = useIncomeExpenseTypes("expense", { enabled: canCreate });
  const [expenseFormOpen, setExpenseFormOpen] = useState(false);
  const [expensePrefill, setExpensePrefill] = useState<IncomeExpensePrefill | undefined>();
  const [missingCfgOpen, setMissingCfgOpen] = useState(false);
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
      building_id: singleBuilding?.id,
      period: { start_date: startDate, end_date: endDate },
      items: type
        ? [{ income_expense_type_id: type.id, type_name: type.name, quantity: 1, unit_price: 0 }]
        : undefined,
    });
    setExpenseFormOpen(true);
  };

  // Placeholder "chưa có phiếu" cho hạng mục chi cố định còn thiếu — như desktop:
  // chỉ ở chế độ dồn tích + đúng 1 toà thật; dò trên danh sách ĐẦY ĐỦ expenseRows.
  const displayExpenseRows = useMemo(() => {
    if (loading || !accrualMode || !singleBuilding || singleBuilding.is_virtual) return shownExpenseRows;
    const present = new Set<number>();
    for (const r of expenseRows)
      if (!r.isNote) present.add(expenseRankOf(r.category, r.type, r.desc));
    const hiddenFixed = new Set<string>(
      (singleBuilding.hidden_fixed_expenses as string[] | null) ?? [],
    );
    const missing: MRow[] = [];
    FIXED_EXPENSE_CATEGORIES.forEach((cat, i) => {
      if (present.has(i)) return;
      if (cat.requiresElevator && !singleBuilding.has_elevator) return;
      if (hiddenFixed.has(cat.key)) return;
      missing.push({
        key: `missing-exp-${i}`, desc: cat.label, building: singleBuilding.name ?? "—",
        room: null, type: cat.label, period: "", amount: 0, notKqkd: false,
        invoiceId: null, isNote: true, isMissingExpense: true, fixedRank: i,
      });
    });
    if (missing.length === 0) return shownExpenseRows;
    return [...shownExpenseRows, ...missing].sort(
      (a, b) =>
        expenseRankOf(a.category, a.type, a.desc, a.fixedRank) -
          expenseRankOf(b.category, b.type, b.desc, b.fixedRank) ||
        compareRoom(a.room, b.room) || a.desc.localeCompare(b.desc, "vi"),
    );
  }, [shownExpenseRows, expenseRows, loading, accrualMode, singleBuilding]);

  // Note "thiếu/thừa so với hoá đơn" — port desktop (bù cọc-trong-HĐ + phần thanh lý đã tách).
  const noteFor = (row: MRow): { text: string; kind: "lack" | "over" } | null => {
    if (!row.invoiceId || row.isLiq) return null;
    const inv = invoiceTotals?.get(row.invoiceId);
    if (!inv || !inv.total_amount) return null;
    const depositInInvoice = pnlOnly
      ? firstInvoiceDetails?.get(row.invoiceId)?.depositInInvoice ?? 0
      : 0;
    const diff = Math.round(
      row.amount - (inv.total_amount - depositInInvoice - (row.liqSiblingAmount ?? 0)),
    );
    if (diff <= -1) return { text: `thiếu ${fmtShort(-diff)}`, kind: "lack" };
    if (diff >= 1) return { text: `thừa ${fmtShort(diff)}`, kind: "over" };
    return null;
  };

  // Tên dòng THU — như desktop: thanh lý → nhãn gộp; gắn HĐ → tên bên trang /invoices.
  const displayDescription = (r: MRow): string => {
    // Dòng ghi chú thuần giữ nguyên mô tả (ghi chú trống phòng có thể chứa "Thanh lý HĐ").
    if (r.isNote) return r.desc;
    if (nrm(`${r.type} ${r.desc}`).includes("thanh ly")) return "HĐ Thanh Lý Hợp Đồng";
    const invTitle = r.invoiceId ? invoiceTotals?.get(r.invoiceId)?.displayTitle : undefined;
    if (invTitle) return invTitle;
    if (nrm(r.desc).includes("thu tien theo hd tien phong")) return `Hóa Đơn Tiền Phòng T${ym.m}`;
    return r.desc;
  };

  const rows = side === "income" ? shownIncomeRows : displayExpenseRows;
  const nInc = shownIncomeRows.filter((r) => !r.isNote).length;
  const nExp = shownExpenseRows.filter((r) => !r.isNote).length;

  const toggleBuilding = (id: string) =>
    setBuildingIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const modeCount = (!pnlOnly ? 1 : 0) + (accrualMode ? 0 : 1);
  const profitPos = displayDiff >= 0;

  const badge = (n: number) => (
    <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-[3px] grid place-items-center rounded-full bg-[#1f7a52] text-white font-mono text-[9px] font-bold">
      {n}
    </span>
  );

  // ===== Render 1 thẻ dòng (layout Option C: dòng 1 phòng+mô tả+tiền, dòng 2 meta+note) =====
  const renderRow = (r: MRow) => {
    const isIncome = side === "income";
    const fd = isIncome && r.invoiceId && !r.isLiq ? firstInvoiceDetails?.get(r.invoiceId) : null;
    const rp = isIncome && r.invoiceId && !r.isLiq ? rentPeriods?.get(r.invoiceId) : null;
    const invFull = fd ? fd.rentServiceTotal - fd.rentServicePaid < 1 : false;
    const depFull = fd ? fd.depositTotal - fd.depositPaid < 1 : false;

    // Màu nền theo ưu tiên desktop: thiếu phiếu → thiếu HĐ → trống/thanh lý → HĐ đầu/prorate.
    let bg = "#ffffff", line = "#e7e3da", dashed = false;
    let descColor = "#514c42";
    let amtColor = isIncome ? "#0e7a47" : "#c2570f";
    if (r.isMissingExpense) { bg = "#fffbeb"; line = "#fde68a"; dashed = true; descColor = "#b45309"; amtColor = "#b45309"; }
    else if (r.isMissingInvoice) { bg = "#fdecea"; line = "#f5c6c0"; descColor = "#a33731"; amtColor = "#a33731"; }
    else if (r.isVacantNote) { bg = "#fdf3e2"; line = "#f0dca8"; descColor = "#8a6111"; amtColor = "#8a6111"; }
    else if (r.isLiq) { bg = "#fdf3e2"; line = "#f0dca8"; }
    else if (fd || rp) { bg = "#e9f6ee"; line = "#c4e6d0"; }

    // Note bên phải dòng 2.
    let noteText = "", noteColor = "#8d8678";
    if (r.isMissingExpense) { noteText = canCreate ? "bấm để tạo phiếu" : "chưa có phiếu"; noteColor = "#b45309"; }
    else if (r.isMissingInvoice) { noteText = "cảnh báo"; noteColor = "#a33731"; }
    else if (fd) {
      noteText = fd.depositTotal > 0
        ? `HĐ đầu · cọc ${fmtShort(fd.depositPaid)}/${fmtShort(fd.depositTotal)}`
        : `HĐ đầu · thu ${fmtShort(fd.rentServicePaid)}/${fmtShort(fd.rentServiceTotal)}`;
      noteColor = (fd.depositTotal > 0 ? depFull : invFull) ? "#1a8a4c" : "#d6453f";
    } else if (rp) {
      noteText = `từ ${fmtDayShort(rp.rentFrom)} → ${fmtDayShort(rp.rentTo)}`;
      noteColor = "#1a8a4c";
    } else if (!r.isNote) {
      const parts: string[] = [];
      if (r.groupCount && r.groupCount > 1) parts.push(`(${r.groupCount} lần)`);
      const n = noteFor(r);
      if (n) { parts.push(n.text); noteColor = n.kind === "lack" ? "#c97a10" : "#d6453f"; }
      if (r.notKqkd) parts.push("không KQKD");
      noteText = parts.join(" · ");
    }

    const meta = r.isMissingExpense
      ? `Hạng mục cố định · ${r.building}`
      : r.isNote
        ? r.building
        : `${r.type} · ${r.building}${accrualMode && r.period ? ` · Kỳ ${r.period}` : ""}`;

    const onTap = r.isMissingExpense
      ? (canCreate ? () => openCreateMissingExpense(r) : undefined)
      : r.invoiceId
        ? () => setDetailInvoiceId(r.invoiceId)
        : undefined;

    return (
      <div
        key={r.key}
        onClick={onTap}
        className={`rounded-xl px-[11px] py-[9px] shadow-[0_1px_2px_rgba(27,24,19,.04)] border ${dashed ? "border-dashed" : ""} ${onTap ? "cursor-pointer active:opacity-80" : ""}`}
        style={{ background: bg, borderColor: line }}
      >
        <div className="flex items-center gap-2 min-w-0">
          {r.room && (
            <span className="shrink-0 font-mono font-bold text-[11.5px] text-[#1b1813] bg-[#faf8f4] border border-[#e7e3da] px-[7px] py-0.5 rounded-[7px]">
              {r.room}
            </span>
          )}
          <span
            className="flex-1 min-w-0 text-[12.5px] font-bold truncate"
            style={{ color: descColor }}
            onClick={
              r.invoiceId
                ? (e) => {
                    e.stopPropagation();
                    setInvoiceModal({
                      id: r.invoiceId!,
                      title: displayDescription(r) + (r.room ? ` — ${r.room}` : ""),
                    });
                  }
                : undefined
            }
          >
            {displayDescription(r)}
            {r.isMissingExpense && <span className="ml-1 text-[11px]">(chưa có phiếu)</span>}
          </span>
          <span
            className="shrink-0 font-mono font-bold text-[13px] tracking-[-0.3px] whitespace-nowrap"
            style={{ color: amtColor }}
          >
            {r.isNote ? "—" : fmtShort(r.amount)}
          </span>
        </div>
        <div className="mt-1 flex items-baseline justify-between gap-2">
          <span className="text-[10.5px] font-semibold text-[#8d8678] whitespace-nowrap overflow-hidden text-ellipsis">
            {meta}
          </span>
          {noteText && (
            <span className="shrink-0 text-[10.5px] font-bold whitespace-nowrap" style={{ color: noteColor }}>
              {noteText}
            </span>
          )}
        </div>
      </div>
    );
  };

  // ===== Header phải: pill tháng + nút toà + nút lọc (thiết kế 1b) =====
  const headerRight = (
    <>
      <button
        onClick={() => setSheet("month")}
        className="h-7 inline-flex items-center gap-1 font-mono text-[11px] font-bold text-[#1a6645] bg-[#e8f3ec] border border-[#d2e8da] px-1.5 rounded-lg"
      >
        <CalendarDays className="h-3 w-3" />
        {monthLabel}
      </button>
      <button
        onClick={() => setSheet("bld")}
        aria-label="Chọn toà nhà"
        className={`relative h-7 w-[30px] grid place-items-center rounded-lg border ${
          buildingIds.length
            ? "border-[#d2e8da] bg-[#e8f3ec] text-[#1a6645]"
            : "border-[#e7e3da] bg-[#faf8f4] text-[#514c42]"
        }`}
      >
        <Building2 className="h-3.5 w-3.5" />
        {buildingIds.length > 0 && badge(buildingIds.length)}
      </button>
      <button
        onClick={() => setSheet("filter")}
        aria-label="Lọc"
        className="relative h-7 w-[30px] grid place-items-center rounded-lg border border-[#e7e3da] bg-[#faf8f4] text-[#514c42]"
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
        {modeCount > 0 && badge(modeCount)}
      </button>
    </>
  );

  const stripCol = (
    label: string, dot: string, value: string, color: string, grow = "flex-1",
    issue?: { on: boolean; toggle: () => void },
  ) => (
    <div
      className={`${grow} min-w-0 flex flex-col gap-0.5 ${issue?.on ? "cursor-pointer" : ""}`}
      onClick={issue?.on ? issue.toggle : undefined}
    >
      <span className="flex items-center gap-[5px] text-[10px] font-bold tracking-wide text-[#8d8678]">
        <span className="w-[7px] h-[7px] rounded-full" style={{ background: dot }} />
        {label}
        {issue?.on && (
          // Chấm đỏ chớp nhẹ = kiểm chứng CÓ LỆCH — bấm để xổ/thu thanh kiểm chứng.
          <span className="w-[7px] h-[7px] rounded-full bg-[#d6453f] animate-pulse" />
        )}
      </span>
      <span className="font-mono font-bold text-[16.5px] tracking-[-0.5px] whitespace-nowrap" style={{ color }}>
        {value}
      </span>
    </div>
  );

  // Thanh kiểm chứng: luôn MOUNT (để tính trạng thái lệch server-side) nhưng chỉ
  // HIỆN khi có lệch VÀ user bấm chấm đỏ (hoặc đang ẩn dải thống kê → hiện thẳng).
  const showVerify = hasVerifyIssue && (verifyOpen || hideStatCards);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <MobileHeader onBack={onBack ?? (() => navigate(-1))} right={headerRight} />

      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden [&::-webkit-scrollbar]:hidden">
        <div className="mx-auto w-full max-w-[480px] px-3.5 pt-3 pb-2 flex flex-col gap-2.5">
          {/* Dải tổng DOANH THU | CHI PHÍ | LỢI NHUẬN */}
          {!hideStatCards && (
            <div className="flex items-center gap-2.5 rounded-[13px] border border-[#e7e3da] bg-white px-[13px] py-[11px] shadow-[0_1px_2px_rgba(27,24,19,.05)]">
              {stripCol("DOANH THU", "#1f9d57", fmtShort(displayIncome), "#0e7a47")}
              <div className="w-px self-stretch bg-[#efece4] shrink-0" />
              {stripCol("CHI PHÍ", "#e0691f", fmtShort(displayExpense), "#c2570f")}
              <div className="w-px self-stretch bg-[#efece4] shrink-0" />
              {stripCol("LỢI NHUẬN", "#1b1813", fmtShort(displayDiff), profitPos ? "#0e7a47" : "#c2570f", "flex-[1.1]", {
                on: hasVerifyIssue,
                toggle: () => setVerifyOpen((v) => !v),
              })}
            </div>
          )}

          {/* B5: thanh kiểm chứng — ẩn mặc định, chỉ hiện khi có lệch + bấm chấm đỏ.
              Luôn mount (display:none) để tự tính trạng thái lệch. */}
          <div className={showVerify ? "" : "hidden"}>
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
            shownIncomeSum={shownIncomeSum}
            shownExpenseSum={shownExpenseSum}
            hiddenCount={hiddenCount}
            hiddenIncomeSum={hiddenIncomeSum}
            hiddenExpenseSum={hiddenExpenseSum}
            capWarning={capWarning}
            pendingCount={pendingInfo.count}
            pendingIncome={pendingInfo.income}
            pendingExpense={pendingInfo.expense}
            onIssueChange={setHasVerifyIssue}
          />
          </div>

          {/* Phân đoạn Khoản thu | Khoản chi (+ tạo phiếu chi, bánh răng cấu hình) */}
          <div className="flex gap-[7px]">
            <button
              onClick={() => setSide("income")}
              className={`flex-1 inline-flex items-center justify-center gap-[7px] py-2 rounded-xl border text-[13px] font-extrabold ${
                side === "income" ? "bg-[#0e7a47] border-[#0e7a47] text-white" : "bg-white border-[#e7e3da] text-[#514c42]"
              }`}
            >
              Khoản thu
            </button>
            <button
              onClick={() => setSide("expense")}
              className={`flex-1 inline-flex items-center justify-center gap-[7px] py-2 rounded-xl border text-[13px] font-extrabold ${
                side === "expense" ? "bg-[#c2570f] border-[#c2570f] text-white" : "bg-white border-[#e7e3da] text-[#514c42]"
              }`}
            >
              Khoản chi
              {canCreate && (
                <span
                  title="Tạo phiếu chi"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSide("expense");
                    openCreateExpense();
                  }}
                  className={`inline-grid place-items-center w-5 h-5 rounded-md ${
                    side === "expense" ? "bg-white/25 text-white" : "bg-[#fdf0e8] text-[#c2570f]"
                  }`}
                >
                  <Plus className="h-[13px] w-[13px]" strokeWidth={2.5} />
                </span>
              )}
            </button>
            {side === "expense" && canEditBuildings && singleBuilding && !singleBuilding.is_virtual && (
              <button
                onClick={() => setMissingCfgOpen(true)}
                aria-label="Cài đặt cảnh báo thiếu phiếu chi"
                className="w-10 shrink-0 grid place-items-center rounded-xl border border-[#e7e3da] bg-white text-[#c2570f] active:scale-95"
              >
                <Settings2 className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* Danh sách khoản */}
          <div className="flex flex-col gap-1.5">
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-[54px] rounded-xl bg-[#efece4] animate-pulse" />
              ))
            ) : rows.length === 0 ? (
              <div className="flex flex-col items-center gap-2.5 px-5 py-[42px] text-center">
                <div className="w-[52px] h-[52px] grid place-items-center rounded-2xl bg-[#faf8f4] border border-[#e7e3da] text-[#b6b0a3]">
                  <BarChart3 className="h-[22px] w-[22px]" />
                </div>
                <p className="m-0 text-[12.5px] font-semibold text-[#8d8678] max-w-[230px] leading-relaxed">
                  Không có khoản nào trong tháng {monthLabel} phù hợp bộ lọc.
                </p>
              </div>
            ) : (
              rows.map(renderRow)
            )}
          </div>

          <div className="pt-2 border-t border-[#efece4] text-[11px] font-semibold text-[#8d8678] leading-relaxed">
            Tổng {nInc + nExp} khoản · {accrualMode ? "ghi nhận theo kỳ áp dụng (phân bổ)" : "ghi nhận theo ngày phiếu"}
          </div>
        </div>
      </div>

      {/* ===== Bottom sheets ===== */}
      {sheet && (
        <div onClick={() => setSheet(null)} className="fixed inset-0 z-50 bg-[rgba(27,24,19,.45)] flex items-end justify-center">
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[480px] max-h-[84%] overflow-y-auto bg-white rounded-t-[22px] px-5 pt-2.5 pb-6 [&::-webkit-scrollbar]:hidden"
          >
            <div className="w-10 h-1 rounded-full bg-[#efece4] mx-auto mb-3.5" />

            {sheet === "month" && (
              <>
                <div className="flex items-center gap-2 pb-3.5">
                  <button onClick={() => setYm((p) => ({ ...p, y: p.y - 1 }))} aria-label="Năm trước"
                    className="h-8 w-8 grid place-items-center rounded-[9px] border border-[#e7e3da] bg-[#faf8f4] text-[#514c42]">
                    <ChevronLeft className="h-[15px] w-[15px]" />
                  </button>
                  <span className="text-[16px] font-extrabold text-[#1b1813]">Năm {ym.y}</span>
                  <button onClick={() => setYm((p) => ({ ...p, y: p.y + 1 }))} aria-label="Năm sau"
                    className="h-8 w-8 grid place-items-center rounded-[9px] border border-[#e7e3da] bg-[#faf8f4] text-[#514c42]">
                    <ChevronRight className="h-[15px] w-[15px]" />
                  </button>
                  <button onClick={() => setSheet(null)} aria-label="Đóng"
                    className="ml-auto h-8 w-8 grid place-items-center rounded-[9px] border border-[#e7e3da] bg-[#faf8f4] text-[#514c42]">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-[9px]">
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
                    const on = m === ym.m;
                    return (
                      <button key={m} onClick={() => { setYm((p) => ({ ...p, m })); setSheet(null); }}
                        className={`py-[11px] rounded-xl border text-[12.5px] font-extrabold ${
                          on ? "border-[#1f7a52] bg-[#1f7a52] text-white" : "border-[#e7e3da] bg-[#faf8f4] text-[#514c42]"
                        }`}>
                        Tháng {m}
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {sheet === "bld" && (
              <>
                <div className="flex items-center gap-2 pb-1">
                  <span className="text-[16px] font-extrabold text-[#1b1813]">Chọn toà nhà</span>
                  <button onClick={() => setSheet(null)} aria-label="Đóng"
                    className="ml-auto h-8 w-8 grid place-items-center rounded-[9px] border border-[#e7e3da] bg-[#faf8f4] text-[#514c42]">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="flex gap-[7px] flex-wrap mt-3">
                  {(buildings as any[]).map((b) => {
                    const on = buildingIds.includes(b.id);
                    return (
                      <button key={b.id} onClick={() => toggleBuilding(b.id)}
                        className={`text-[11.5px] font-bold px-3 py-1.5 rounded-full border ${
                          on ? "border-[#1f7a52] bg-[#e8f3ec] text-[#1a6645]" : "border-[#e7e3da] bg-white text-[#514c42]"
                        }`}>
                        {b.name}
                      </button>
                    );
                  })}
                </div>
                <div className="flex gap-[9px] mt-[18px]">
                  <button onClick={() => setBuildingIds([])}
                    className="flex-1 border border-[#e7e3da] bg-[#faf8f4] text-[#514c42] font-extrabold text-[13px] py-3 rounded-xl">
                    Tất cả toà
                  </button>
                  <button onClick={() => setSheet(null)}
                    className="flex-1 bg-[#1f7a52] text-white font-extrabold text-[13px] py-3 rounded-xl shadow-sm">
                    Xong
                  </button>
                </div>
              </>
            )}

            {sheet === "filter" && (
              <>
                <div className="flex items-center gap-2 pb-1">
                  <span className="text-[16px] font-extrabold text-[#1b1813]">Bộ lọc &amp; hiển thị</span>
                  <button onClick={() => setSheet(null)} aria-label="Đóng"
                    className="ml-auto h-8 w-8 grid place-items-center rounded-[9px] border border-[#e7e3da] bg-[#faf8f4] text-[#514c42]">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="text-[10.5px] font-bold uppercase tracking-wider text-[#8d8678] mt-[17px] mb-[9px]">Cách ghi nhận</div>
                <div className="flex flex-col gap-2">
                  <SwitchRow on={accrualMode} onToggle={() => setAccrualMode((v) => !v)}
                    title="Phân bổ theo kỳ áp dụng" desc="Chia đều tiền theo kỳ thay vì ngày phiếu" />
                  <SwitchRow on={!pnlOnly} onToggle={() => setPnlOnly((v) => !v)}
                    title="Gồm khoản không hạch toán KQKD" desc="Tiền cọc, chia lợi nhuận cổ đông…" />
                </div>
                <div className="text-[10.5px] font-bold uppercase tracking-wider text-[#8d8678] mt-[17px] mb-[9px]">Hiển thị</div>
                <div className="flex flex-col gap-2">
                  <SwitchRow on={hideSpecialTypes}
                    onToggle={() => setUiPref.mutate({ key: "pd_hideSpecialTypes", value: !hideSpecialTypes })}
                    title="Ẩn hạng mục đặc biệt" desc="Ẩn dòng (vd Tiền nhà) — số tổng giữ nguyên" />
                  <SwitchRow on={!hideStatCards}
                    onToggle={() => setUiPref.mutate({ key: "pd_hideStatCards", value: !hideStatCards })}
                    title="Dải thống kê" desc="Doanh thu · Chi phí · Lợi nhuận" />
                </div>
                <div className="flex gap-[9px] mt-[18px]">
                  <button onClick={() => { setBuildingIds([]); setPnlOnly(true); setAccrualMode(true); }}
                    className="flex-1 border border-[#e7e3da] bg-[#faf8f4] text-[#514c42] font-extrabold text-[13px] py-3 rounded-xl">
                    Đặt lại
                  </button>
                  <button onClick={() => setSheet(null)}
                    className="flex-1 bg-[#1f7a52] text-white font-extrabold text-[13px] py-3 rounded-xl shadow-sm">
                    Xong
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Tap thẻ → "Các lần thanh toán" của hoá đơn */}
      <PaymentsSummaryDialog
        open={!!detailInvoiceId}
        onOpenChange={(v) => { if (!v) setDetailInvoiceId(null); }}
        invoice={detailInvoice ?? null}
      />

      {/* Tap TÊN dòng → chi tiết hoá đơn full-screen (như trang /invoices) */}
      <InvoiceDetailModal
        invoiceId={invoiceModal?.id ?? null}
        title={invoiceModal?.title}
        open={!!invoiceModal}
        onOpenChange={(v) => { if (!v) setInvoiceModal(null); }}
      />

      {/* Nút + / tap thẻ vàng "chưa có phiếu" → tạo phiếu chi (kỳ item = tháng đang xem) */}
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

      {/* Bánh răng → tắt/bật cảnh báo "chưa có phiếu" theo toà */}
      <MissingExpenseSettingsDialog
        open={missingCfgOpen}
        onOpenChange={setMissingCfgOpen}
        building={singleBuilding && !singleBuilding.is_virtual ? singleBuilding : null}
      />
    </div>
  );
}

function SwitchRow({ on, onToggle, title, desc }: { on: boolean; onToggle: () => void; title: string; desc: string }) {
  return (
    <button onClick={onToggle}
      className="flex items-center gap-[11px] text-left rounded-[13px] border border-[#e7e3da] bg-[#faf8f4] px-[13px] py-[11px]">
      <div className="flex flex-col gap-px flex-1 min-w-0">
        <span className="text-[13px] font-extrabold text-[#1b1813]">{title}</span>
        <span className="text-[11px] font-semibold text-[#8d8678]">{desc}</span>
      </div>
      <span className={`shrink-0 w-[42px] h-[25px] rounded-full p-0.5 transition-colors ${on ? "bg-[#1f7a52]" : "bg-[#d9d4c8]"}`}>
        <span className={`h-[21px] w-[21px] rounded-full bg-white shadow transition-transform flex items-center justify-center ${on ? "translate-x-[17px]" : ""}`}>
          {on && <Check className="h-3 w-3 text-[#1f7a52]" />}
        </span>
      </span>
    </button>
  );
}
