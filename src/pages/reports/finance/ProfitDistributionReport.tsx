import { lazy, Suspense, useCallback, useEffect, useState, useMemo, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, LayoutGrid, MousePointerClick, Plus, Settings2 } from "lucide-react";
import { usePhoneViewport } from "@/hooks/use-mobile";
import { ProfitHubSlot } from "@/pages/reports/finance/ProfitHubShell";
import { useFaMonthlyPnl } from "@/hooks/useFinancialAnalysis";
import { toMillions } from "@/components/shareholders/profitCharts";
import { profitVerificationChipLabel, type ProfitVerificationVisualState } from "@/lib/profitVerification";
import { usePersistedState } from "@/hooks/usePersistedState";
import ProfitDistributionMobile from "./ProfitDistributionMobile";
import {
  useIncomeExpenses,
  useIncomeExpenseStats,
  type IncomeExpenseFilters,
} from "@/hooks/useIncomeExpenses";
import { useInvoice, useInvoiceTotalsByIds, useFirstInvoiceDetails, useInvoiceRentPeriods } from "@/hooks/useInvoices";
import PaymentsSummaryDialog from "@/components/invoices/PaymentsSummaryDialog";
import InvoiceDetailModal from "@/components/invoices/InvoiceDetailModal";
import IncomeExpenseForm, {
  type IncomeExpensePrefill,
} from "@/components/income-expenses/IncomeExpenseForm";
import MissingExpenseSettingsDialog from "@/components/reports/MissingExpenseSettingsDialog";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { canUse } from "@/lib/permissionPages";
import { profitReportRowDescription } from "@/lib/voucherDisplayName";
import { toast } from "sonner";
import ProfitVerificationBar from "@/components/reports/ProfitVerificationBar";
import { useAccrualMonthReport } from "@/hooks/useAccrualReport";
import { ihomeLineTitle, pendingBuildingIdsOf, useIhomeProfitLine } from "@/hooks/useIhomeProfitLine";
import { useOrganization } from "@/contexts/OrganizationContext";
import { orgBuildingsOf, profitScopeIds } from "@/lib/profitReportScope";
import ProfitReportChecks from "@/components/reports/ProfitReportChecks";
import ProfitPostLockNotice from "@/components/reports/ProfitPostLockNotice";
import { useProfitPostLockReport } from "@/hooks/useProfitPostLock";
import {
  activeRoomNoteText,
  computeProfitReportChecks,
  endedUnsettledNoteText,
  fixedFeePrefillAmount,
  summarizeRoomNotes,
  type FixedFeeCell,
  type ProfitCheckBuilding,
} from "@/lib/profitReportChecks";
import { useFeeConfigMatrix } from "@/hooks/useFeeConfigMatrix";
import { useLandlordIhomeProfit } from "@/hooks/useLandlordSettlement";
import { useUiPrefBool, useSetUiPreference } from "@/hooks/useUiPreferences";
import { useHiddenInReportTypes, useIncomeExpenseTypes } from "@/hooks/useIncomeExpenseTypes";
import { useVacantRoomNotes } from "@/hooks/useReports";
import { useInvoiceAmountParts } from "@/hooks/useInvoiceAmountParts";
import { categorySharesOf, invoiceAdjustmentsText } from "@/lib/invoiceAmountParts";
import { CategoryShareBlock, IncomePartCells } from "@/components/reports/IncomeBreakdown";
import { ProfitFilterBar, ProfitRowSearchInput } from "@/components/reports/ProfitRowFilters";
import {
  NO_CATEGORIES,
  filterProfitRows,
  pruneSideSelections,
  toggleCategorySelection,
  type ProfitViewResult,
  type ProfitViewRow,
} from "@/lib/profitReportFilters";
import { vacancyNoteText } from "@/lib/vacancyReason";
import { compareRoomNames } from "@/lib/roomSort";
import { formatPeriod } from "@/lib/monthPeriod";
import {
  FIXED_EXPENSE_CATEGORIES,
  expenseRankOf,
  findTypeForFixedCategory,
} from "@/lib/fixedExpenseCategories";
import { useBuildings } from "@/hooks/useBuildings";
import { BuildingFilterSelect } from "@/components/buildings/BuildingFilterSelect";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import { format, startOfMonth, endOfMonth, addMonths } from "date-fns";
import { formatCurrency } from "@/lib/utils";

// Panel "Vòng đời hợp đồng" (bấm số phòng cột Thu) — chỉ tải khi mở.
const RoomContractLifecycleDrawer = lazy(
  () => import("@/components/reports/room-contract-lifecycle/RoomContractLifecycleDrawer")
);
// Bấm khoản chi → hộp phiếu của Thu chi (adapter, xem file) — chỉ tải khi mở.
const ProfitVoucherViewer = lazy(() => import("@/components/reports/ProfitVoucherViewer"));

type Side = "income" | "expense";


// Số tiền gọn cho dòng phụ "hoá đơn tháng đầu" (không ký hiệu ₫ rườm rà).
const fmtCompact = (n: number) =>
  new Intl.NumberFormat("vi-VN").format(Math.round(n || 0)) + "đ";

// Ngày 'YYYY-MM-DD' → 'dd/MM/yyyy' (kỳ tiền phòng); null → "—".
const fmtDay = (iso?: string | null): string => {
  if (!iso) return "—";
  const d = new Date(String(iso).slice(0, 10) + "T00:00:00");
  return Number.isNaN(d.getTime()) ? "—" : format(d, "dd/MM/yyyy");
};

// Dòng đã chuẩn hoá cho 1 bên (thu HOẶC chi) của sổ phân bổ.
interface DisplayRow {
  key: string;
  monthLabel: string;
  description: string;
  buildingName: string;
  roomName: string | null;
  // room_id của phiếu — khớp phòng trống chính xác (tránh trùng tên giữa các toà).
  roomId?: string | null;
  periodLabel: string;
  typeName: string;
  // income_expense_type_id của dòng — khớp cờ "hạng mục đặc biệt" để ẩn/hiện.
  // null với dòng gộp theo hoá đơn (nhiều hạng mục) hoặc dòng ghi chú.
  typeId?: string | null;
  // Nhóm hạng mục (income_expense_types.category) — dùng sắp xếp ưu tiên cột Chi.
  category: string | null;
  amount: number;
  notKqkd: boolean;
  // Khoản THU sinh từ thanh toán hoá đơn: gộp các khoản cùng 1 HĐ thành 1 dòng.
  // invoiceId != null ⇒ dòng có thể nhấp đôi xem chi tiết + note thiếu/thừa.
  invoiceId?: string | null;
  // Số lần thu được gộp (>1 ⇒ hiện "(N lần)").
  groupCount?: number;
  // id các phiếu làm nên dòng — server xét phiếu nào được tách tiền theo hoá đơn (như quyết toán vận hành).
  voucherIds?: string[];
  // Mã phiếu (PC…/PT…) — chỉ để ô tìm của khung tìm theo mã.
  voucherCode?: string | null;
  // Số tiền dòng gồm cả phần ngoài KQKD (cọc) — tắt "Chỉ KQKD" ở chế độ ngày phiếu ⇒ không tách theo hoá đơn.
  mixedDeposit?: boolean;
  // Σ khoản THANH LÝ/BỎ CỌC gắn CÙNG hoá đơn nhưng đã tách sang dòng riêng —
  // trừ khỏi mệnh giá HĐ khi so thiếu/thừa (mệnh giá HĐ quyết toán đã cộng cả
  // phần phụ thu thanh lý mà phiếu "Doanh thu thanh lý" thanh toán).
  liqSiblingAmount?: number;
  // Phòng đang trống trong tháng → tô nền vàng cam + đẩy lên đầu cột Thu.
  isVacant?: boolean;
  // Phòng CÒN HĐ nhưng THIẾU hoá đơn tháng này → cảnh báo nền đỏ.
  isMissingInvoice?: boolean;
  // Dòng ghi chú thuần (không phải khoản thật) "Trống phòng — <lý do>" — amount 0,
  // không tính vào "X khoản".
  isNote?: boolean;
  // Dòng placeholder "chưa có phiếu" cho 1 hạng mục chi CỐ ĐỊNH còn thiếu →
  // nền vàng nhạt, amount 0 (isNote=true nên không tính tổng/đếm).
  isMissingExpense?: boolean;
  // Ghim đúng vị trí trong 9 hạng mục cố định (dùng cho dòng placeholder).
  fixedRank?: number;
  // Lý do trống ("Bỏ cọc" / "Thanh lý HĐ" / "Chuyển phòng" / …).
  vacantReason?: string;
}

// Các cột CÓ THỂ ẩn/hiện. "Mô tả" + cột số tiền luôn hiển thị (lõi).
type ColKey = "thang" | "toa_nha" | "phong" | "ky" | "phan_loai";
const TOGGLE_COLUMNS: { key: ColKey; label: string }[] = [
  { key: "thang", label: "Tháng" },
  { key: "toa_nha", label: "Tòa nhà" },
  { key: "phong", label: "Phòng" },
  { key: "ky", label: "Kỳ" },
  { key: "phan_loai", label: "Phân loại" },
];

// PostgREST trả tối đa 1000 dòng/trang. Sổ 2 cột hiển thị TẤT CẢ khoản trong
// tháng (cuộn riêng từng bên) thay vì phân trang → fetch 1 lần với hạn mức này.
// Tổng 3 thẻ vẫn lấy từ stats/accrual (đủ chính xác) nên dù list chạm trần
// 1000 thì con số tổng không sai.
const LIST_LIMIT = 1000;

// So sánh tên phòng theo thứ tự nhóm MB* → G* → L* → 1,2,3,4… (dùng compareRoomNames
// chung của dự án); phòng không tên (null) dồn xuống cuối.
const compareRoom = (a: string | null, b: string | null): number => {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return compareRoomNames(a, b);
};

// Bỏ dấu + thường hoá để khớp hạng mục bất kể cách gõ ("Vệ Sinh" ≈ "vệ sinh").
const nrm = (s: string | null | undefined): string =>
  (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    // toLowerCase TRƯỚC khi thay đ→d: đảo lại sẽ bỏ sót Đ hoa (U+0110) → "đien".
    .toLowerCase()
    .replace(/đ/g, "d")
    .trim();

// Dòng doanh thu THANH LÝ / BỎ CỌC — khi phòng đang trống thì đem lên đầu + tô màu
// (thay cho dòng ghi chú "Trống phòng").
const isLiquidationRow = (r: DisplayRow): boolean => {
  const s = nrm(`${r.typeName} ${r.description}`);
  return s.includes("bo coc") || s.includes("thanh ly");
};

// Thứ tự ƯU TIÊN hiển thị KHOẢN CHI + danh sách hạng mục cố định hằng tháng nay
// dùng chung với bản mobile — xem @/lib/fixedExpenseCategories
// (FIXED_EXPENSE_CATEGORIES + expenseRankOf). Dòng chi không khớp hạng mục cố
// định nào → xuống cuối; trong cùng nhóm vẫn theo phòng → mô tả.

// true khi MỌI dòng cùng một giá trị cho cột → cột không phân biệt được gì
// (đã bị bộ lọc ghim, vd lọc 1 toà / 1 tháng) → ẩn mặc định. <2 dòng: không ẩn.
const allSame = (rows: DisplayRow[], get: (r: DisplayRow) => string): boolean => {
  if (rows.length < 2) return false;
  const first = get(rows[0]);
  for (let i = 1; i < rows.length; i++) if (get(rows[i]) !== first) return false;
  return true;
};

const COL_VALUE: Record<ColKey, (r: DisplayRow) => string> = {
  thang: (r) => r.monthLabel,
  toa_nha: (r) => r.buildingName || "—",
  phong: (r) => r.roomName || "—",
  ky: (r) => r.periodLabel,
  phan_loai: (r) => r.typeName,
};

// Mã 2 ký tự cho ô đầu dòng CHI (mock: TN / ĐI / NC / IN / VS…): chữ cái đầu của
// 2 từ đầu, hoặc 2 chữ cái đầu nếu hạng mục chỉ có 1 từ.
const typeCode = (name: string): string => {
  const words = (name || "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "—";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
};

// Bản nội dung (không MainLayout) — render trong tab "Phân bổ lợi nhuận" của ProfitHubPage.
// Rẽ nhánh desktop ↔ mobile bằng usePhoneViewport (khởi tạo đồng bộ → không nháy bảng).
export default function ProfitDistributionContent() {
  const phone = usePhoneViewport();
  return phone ? <ProfitDistributionMobile /> : <ProfitDistributionDesktop />;
}

function ProfitDistributionDesktop() {
  const now = new Date();
  const [monthStr, setMonthStr] = usePersistedState<string>("flt:rpt-profit-dist:month", format(now, "MM-yyyy"));
  // Lọc 1 toà (BuildingFilterSelect, state giữ shape mảng 0/1 phần tử). [] = tất cả.
  const [buildingIds, setBuildingIds] = usePersistedState<string[]>("flt:rpt-profit-dist:buildingIds", []);
  const [roomId, setRoomId] = usePersistedState<string>("flt:rpt-profit-dist:roomId", "all");
  const [voucherType, setVoucherType] = usePersistedState<string>("flt:rpt-profit-dist:voucherType", "all");
  // Mặc định: chỉ tính khoản CÓ hạch toán KQKD (loại tiền cọc & khoản
  // override không-KQKD). Bật toggle để xem cả khoản không hạch toán.
  const [pnlOnly, setPnlOnly] = usePersistedState<boolean>("flt:rpt-profit-dist:pnlOnly", true);
  // Ghi nhận: false = theo Ngày phiếu (voucher_date, hành vi cũ);
  // true = theo Kỳ phân bổ (accrual — chia đều số tiền item ra các tháng trong kỳ).
  // Mặc định BẬT — đúng tên trang "Phân bổ lợi nhuận"; tắt toggle để xem theo ngày phiếu.
  const [accrualMode, setAccrualMode] = usePersistedState<boolean>("flt:rpt-profit-dist:accrualMode", true);
  // Người dùng tự ép ẩn/hiện 1 cột — ghi đè lên mặc định tự-suy-từ-bộ-lọc.
  // Trống = theo mặc định (nút "Đặt lại mặc định" xoá hết override).
  const [colOverrides, setColOverrides] = useState<Partial<Record<ColKey, boolean>>>({});

  // Ẩn/hiện thẻ thống kê & số tổng — LƯU TRÊN SERVER (profiles.ui_preferences) để
  // giữ trạng thái qua F5/đa thiết bị. Toggle nằm trong popover "Cột".
  const hideStatCards = useUiPrefBool("pd_hideStatCards", false);
  const hideTotals = useUiPrefBool("pd_hideTotals", false);
  // Ẩn các hạng mục đánh dấu "đặc biệt" (hide_in_report) — vd Tiền nhà. Chỉ ẩn
  // DÒNG khỏi danh sách; số tổng (3 thẻ + header) GIỮ NGUYÊN.
  const hideSpecialTypes = useUiPrefBool("pd_hideSpecialTypes", false);
  const setUiPref = useSetUiPreference();

  // Quyền tạo phiếu chi ngay tại trang (nút + header Khoản chi & bấm dòng
  // "chưa có phiếu") — thiếu quyền thì ẩn nút, dòng vàng không click được.
  const { data: perms } = useMyPermissions();
  const canCreate = canUse(perms, "income_expenses", "create");
  // Quyền sửa toà nhà — gate nút bánh răng cấu hình cảnh báo thiếu phiếu chi
  // theo toà (ghi buildings.hidden_fixed_expenses).
  const canEditBuildings = canUse(perms, "buildings", "edit");
  // Bấm khoản chi mở phiếu: chỉ người xem được Thu chi (chủ chốt 28/10/2026) — người chỉ có quyền xem báo cáo
  // (cổ đông) thì dòng chi không bấm được, như trước.
  const canViewVoucher = canUse(perms, "income_expenses", "view");
  // Loại CHI trong DB — resolve dòng "chưa có phiếu" (hạng mục cố định) → đúng
  // income_expense_type_id để prefill form, và cho bộ dò chi cố định khớp hạng mục
  // theo khoá fee_category (thiếu danh sách thì bộ dò phải khớp theo tên) ⇒ tải cho mọi người.
  const { data: expenseTypes = [] } = useIncomeExpenseTypes("expense");

  // Hạng mục đánh dấu đặc biệt — khớp dòng theo type_id HOẶC tên (dữ liệu có thể
  // trùng tên "Tiền nhà" giữa nhiều type_id; đánh dấu 1 cái → ẩn mọi dòng cùng tên).
  const { data: specialTypes = [] } = useHiddenInReportTypes();
  const specialTypeIds = useMemo(() => new Set(specialTypes.map((t) => t.id)), [specialTypes]);
  const specialTypeNames = useMemo(
    () => new Set(specialTypes.map((t) => t.name.trim().toLowerCase()).filter(Boolean)),
    [specialTypes]
  );
  const hasSpecialTypes = specialTypes.length > 0;

  // Parse monthStr "MM-yyyy" → start/end date + 'YYYY-MM'
  const [mm, yyyy] = monthStr.split("-").map((s) => parseInt(s, 10));
  const monthDate = new Date(yyyy, (mm || 1) - 1, 1);
  const startDate = format(startOfMonth(monthDate), "yyyy-MM-dd");
  const endDate = format(endOfMonth(monthDate), "yyyy-MM-dd");
  const ym = `${yyyy}-${String(mm || 1).padStart(2, "0")}`;
  const monthLabel = `${String(mm || 1).padStart(2, "0")}/${yyyy}`;

  // Trang này cần cả toà ảo "Chung" (phiếu chia LN cổ đông) → tự fetch
  // includeVirtual và truyền vào BuildingMultiSelect thay vì để nó tự fetch.
  // Chỉ toà của CÔNG TY đang chọn: RLS cho siêu quản trị thấy toà mọi công ty (gồm DEMO) — để trống bộ
  // lọc là cộng lẫn số công ty khác vào tổng. Mọi truy vấn của trang nhận danh sách toà cụ thể (scopeIds).
  const { data: allBuildings = [], isSuccess: buildingsLoaded } = useBuildings({ includeVirtual: true });
  const { selectedOrganizationId } = useOrganization();
  const buildings = useMemo(
    () => orgBuildingsOf(allBuildings as { id: string; organization_id?: string | null }[], selectedOrganizationId),
    [allBuildings, selectedOrganizationId]
  );
  const scopeReady = buildingsLoaded && !!selectedOrganizationId;
  const scopeIds = useMemo(() => profitScopeIds(buildings, buildingIds), [buildings, buildingIds]);
  const buildingOptions = useMemo(
    () =>
      (buildings as any[]).map((b) => ({
        id: b.id,
        name: b.name,
        area_ids: b.area_ids ?? [],
      })),
    [buildings]
  );

  const buildingFilter = scopeIds;
  const filters: IncomeExpenseFilters = {
    building_ids: buildingFilter,
    room_id: roomId === "all" ? undefined : roomId,
    type: voucherType === "all" ? undefined : (voucherType as any),
    start_date: startDate,
    end_date: endDate,
    // Finance V2 §2.3: phiếu CHỜ DUYỆT vẫn ghi nhận KQKD (chi phí/doanh thu đã
    // phát sinh) — báo cáo tính cả UNAPPROVED, thanh kiểm chứng nêu counter riêng.
    approval_status: "ALL_ACTIVE",
    business_result_only: pnlOnly,
  };

  // Sổ 2 cột hiển thị TẤT CẢ khoản trong tháng → fetch 1 trang lớn (không phân trang).
  // enabled: chế độ DỒN TÍCH (mặc định) lấy rows từ accrual — list tiền mặt
  // 1000 dòng + items chỉ được đọc ở nhánh !accrualMode (kể cả capWarning),
  // fetch sẵn chỉ tổ nghẽn pool mỗi lần đổi toà/kỳ.
  const { data: result, isLoading, isError: cashError, refetch: retryCash } = useIncomeExpenses(
    filters,
    {
      page: 1,
      pageSize: LIST_LIMIT,
    },
    undefined,
    { enabled: !accrualMode && scopeReady }
  );
  // Tổng 3 thẻ tính trên TOÀN BỘ dữ liệu khớp filter.
  // businessResultOnly đồng bộ với toggle → loại tiền cọc khỏi Doanh thu/Lợi nhuận.
  const { data: stats } = useIncomeExpenseStats(filters, {
    businessResultOnly: pnlOnly,
  });

  // Chế độ accrual: phân bổ số tiền item theo kỳ áp dụng (theo tháng).
  // Truyền month='' khi tắt → hook trả rỗng, không query. Dùng chung `filters`
  // (hook tự bỏ qua start/end_date — kỳ lấy theo `month`); truyền BIẾN thay vì
  // object literal để building_ids đi qua được dù AccrualFilters chưa khai báo.
  const { data: accrualRaw, isLoading: accrualLoading, isError: accrualError, refetch: retryAccrual } = useAccrualMonthReport(
    accrualMode && scopeReady ? ym : "",
    filters,
    { businessResultOnly: pnlOnly }
  );
  // F06 (chủ chốt 22/10/2026): toà × tháng ĐÃ CHỐT không cộng khoản phát sinh sau lúc chốt (vd thu
  // tiền hoá đơn của tháng đó) — tách khỏi danh sách và tổng, báo lên ở chip riêng. Mọi chỗ bên dưới
  // (tổng, chờ duyệt, bộ dò, dòng "Của iHome", thanh kiểm chứng) dùng bản đã tách.
  const postLock = useProfitPostLockReport({
    ym,
    buildingIds: scopeIds,
    accrual: accrualRaw,
    enabled: accrualMode && scopeReady,
  });
  const accrual = postLock.accrual;

  // §2.3: phần "chờ duyệt" ĐANG NẰM TRONG tổng — accrual lấy từ hook (đúng phân
  // bổ kỳ), tiền mặt tính từ list (kqkd khi pnlOnly, total khi không).
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
    for (const r of (result?.data ?? []) as any[]) {
      if (r.approval_status !== "UNAPPROVED") continue;
      count++;
      const amt = pnlOnly
        ? Number(r.kqkd_amount ?? r.total_amount) || 0
        : Number(r.total_amount) || 0;
      if (r.type === "INCOME") income += amt;
      else expense += amt;
    }
    return { count, income, expense };
  }, [accrualMode, accrual, result, pnlOnly]);

  // Giá trị 3 thẻ + tổng mỗi bên theo chế độ ghi nhận.
  // Tiền mặt + "gồm cả khoản ngoài KQKD": tổng MỌI khoản (kể cả bút toán nội
  // bộ/chưa chọn sổ) — khớp danh sách bên dưới vốn không lọc lớp.
  const cashIncome = pnlOnly ? stats?.totalIncome ?? 0 : stats?.allIncome ?? stats?.totalIncome ?? 0;
  const cashExpense = pnlOnly ? stats?.totalExpense ?? 0 : stats?.allExpense ?? stats?.totalExpense ?? 0;
  const displayIncome = accrualMode ? accrual?.totalIncome ?? 0 : cashIncome;
  const displayExpense = accrualMode ? accrual?.totalExpense ?? 0 : cashExpense;
  const displayDiff = displayIncome - displayExpense;

  // chưa chốt phạm vi công ty (toà / công ty đang nạp) cũng là đang tải — không hiện số 0 như thật
  const loading = !scopeReady || (accrualMode ? accrualLoading || postLock.isLoading : isLoading);

  // Phòng trống trong tháng (đầu cột Thu, nền vàng cam). Chỉ tính khi panel Thu
  // hiển thị, không lọc 1 phòng cụ thể, và đã chọn ≥1 toà (cần danh sách phòng
  // đầy đủ của toà).
  // B5: bật mặc định cả khi chưa chọn toà (hook tự quét mọi toà theo RLS).
  const vacancyEnabled = voucherType !== "EXPENSE" && roomId === "all";
  const { data: vacantNotes } = useVacantRoomNotes(scopeIds, endDate, vacancyEnabled && scopeReady, {
    includeEndedContracts: true,
  });
  // Mốc đếm số ngày trống: tháng cũ chốt theo cuối tháng, tháng hiện tại tới hôm nay.
  const todayStr = format(new Date(), "yyyy-MM-dd");
  const vacancyRefDate = endDate < todayStr ? endDate : todayStr;

  // Bộ dò dùng chung (F13/F17): chi cố định thiếu/thiếu số/có thể trùng ở MỌI toà trong phạm vi,
  // phiếu chờ duyệt quá 30 ngày. Chỉ ở chế độ phân bổ theo kỳ (theo ngày phiếu thì phiếu tháng lân
  // cận lệch tháng ⇒ dò không tin cậy). Toà vận hành cho chủ nhà không trả tiền nhà ⇒ bỏ khoản đó.
  const { data: feeRates } = useFeeConfigMatrix();
  const { data: landlordRows } = useLandlordIhomeProfit(scopeReady ? `${ym}-01` : null, scopeReady ? `${ym}-01` : null);
  const profitChecks = useMemo(
    () =>
      !accrualMode || !accrual || !feeRates || voucherType === "INCOME" || roomId !== "all"
        ? null
        : computeProfitReportChecks({
            rows: accrual.rows,
            buildings: buildings as ProfitCheckBuilding[],
            feeRates,
            expenseTypes,
            scopeBuildingIds: scopeIds,
            skipRentBuildingIds: landlordRows?.map((r) => r.building_id),
            today: todayStr,
          }),
    [accrualMode, accrual, feeRates, voucherType, roomId, buildings, expenseTypes, scopeIds, landlordRows, todayStr]
  );
  const roomSummary = useMemo(() => (vacantNotes ? summarizeRoomNotes(vacantNotes) : null), [vacantNotes]);

  // Chuẩn hoá dữ liệu thành 2 danh sách thu/chi + sắp theo thứ tự phòng.
  const { incomeRows, expenseRows } = useMemo(() => {
    const rawInc: DisplayRow[] = [];
    const exp: DisplayRow[] = [];

    if (accrualMode) {
      for (const r of (accrual?.rows ?? []) as any[]) {
        const base = {
          description: r.voucherName ?? "",
          buildingName: r.buildingName ?? "",
          roomName: r.roomName ?? null,
          roomId: r.roomId ?? null,
          periodLabel: formatPeriod(r.startDate, r.endDate) || "—",
          typeName: r.typeName || "—",
          category: r.category ?? null,
          typeId: r.typeId ?? null,
          notKqkd: r.countsInBusinessResult === false,
          monthLabel,
          voucherIds: r.voucherId ? [r.voucherId as string] : [],
          voucherCode: r.voucherCode ?? null,
        };
        if (r.income > 0)
          rawInc.push({ ...base, key: r.itemId, amount: r.income, invoiceId: r.invoiceId ?? null });
        else if (r.expense > 0) exp.push({ ...base, key: r.itemId, amount: r.expense });
      }
    } else {
      for (const r of (result?.data ?? []) as any[]) {
        // kqkd_amount (item-level, DB maintain): phần của phiếu tính vào KQKD.
        // Phiếu TRỘN (thu HĐ gộp cọc) có 0 < kqkd < total.
        const kqkd = Number(r.kqkd_amount ?? r.total_amount) || 0;
        const base = {
          description: r.name ?? "",
          buildingName: r.building_name ?? "",
          roomName: r.room_name ?? null,
          roomId: r.room_id ?? null,
          periodLabel: "—",
          // Mặc định null — gán đúng category theo từng item bên dưới (cột Chi).
          category: null as string | null,
          notKqkd: kqkd <= 0,
          monthLabel: format(new Date(r.voucher_date), "MM/yyyy"),
          voucherIds: [r.id as string],
          voucherCode: r.code ?? null,
        };
        const items = (r.items || []) as any[];
        // Item cọc bị loại khỏi P&L trừ khi phiếu ép TRUE (khớp kqkd_amount DB).
        const skipDeposit = (it: any) =>
          pnlOnly && !!it.is_deposit && r.business_result_accounting !== true;

        // CHỈ phiếu thu tiền nhà hằng tháng (gắn hoá đơn) mới giữ nguyên 1
        // dòng/phiếu để gộp theo hoá đơn ở bước sau. Chế độ P&L (pnlOnly) lấy
        // phần KQKD; chế độ "gồm khoản cọc" lấy cả phiếu.
        if (r.type === "INCOME" && r.invoice_id) {
          const shownItems = items.filter((it) => !skipDeposit(it));
          const typeName =
            shownItems.map((it) => it.type_name).filter(Boolean).join(", ") || "—";
          rawInc.push({
            ...base,
            key: r.id,
            typeName,
            amount: pnlOnly ? kqkd : Number(r.total_amount),
            invoiceId: r.invoice_id,
            mixedDeposit: !pnlOnly && Math.abs(kqkd - Number(r.total_amount)) >= 1,
          });
          continue;
        }

        // Phiếu thu/chi KHÁC → KHÔNG gộp, tách theo từng hạng mục (item).
        const rows =
          items.length > 0
            ? items
                .filter((it) => !skipDeposit(it))
                .map((it) => {
                  const amt = Number(it.amount);
                  const safe = Number.isFinite(amt)
                    ? amt
                    : Number(it.quantity) * Number(it.unit_price) || 0;
                  return {
                    ...base,
                    key: `${r.id}:${it.id}`,
                    typeName: it.type_name || "—",
                    category: it.category ?? null,
                    typeId: it.income_expense_type_id ?? null,
                    // Dòng cọc (hiện khi tắt pnlOnly) đánh dấu không-KQKD.
                    notKqkd: base.notKqkd || (!!it.is_deposit && r.business_result_accounting !== true),
                    amount: safe,
                  };
                })
            : [{ ...base, key: r.id, typeName: "—", amount: Number(r.total_amount) }];

        for (const row of rows) {
          if (r.type === "INCOME") rawInc.push({ ...row, invoiceId: null });
          else exp.push(row);
        }
      }
    }

    // Gộp các khoản THU cùng 1 hoá đơn (invoice_id) thành 1 dòng tổng — nhưng
    // TÁCH khoản THANH LÝ/BỎ CỌC thành nhóm riêng: RPC thanh lý gắn phiếu
    // "Doanh thu thanh lý" vào hoá đơn quyết toán (lịch sử: cả hoá đơn THÁNG bị
    // gộp thu thêm), gộp chung sẽ nhuộm cả tiền phòng thành "thanh lý"
    // (case MB/158PVC 06/2026). Khoản không gắn hoá đơn giữ nguyên từng dòng.
    const groups = new Map<string, DisplayRow[]>();
    // Σ tiền thanh lý theo hoá đơn — bù vào note thiếu/thừa của nhóm thu thường.
    const liqByInvoice = new Map<string, number>();
    const inc: DisplayRow[] = [];
    for (const r of rawInc) {
      if (r.invoiceId) {
        const liq = isLiquidationRow(r);
        const k = liq ? `${r.invoiceId}:tl` : r.invoiceId;
        const g = groups.get(k);
        if (g) g.push(r);
        else groups.set(k, [r]);
        if (liq) liqByInvoice.set(r.invoiceId, (liqByInvoice.get(r.invoiceId) ?? 0) + r.amount);
      } else {
        inc.push(r);
      }
    }
    for (const [k, list] of groups) {
      // Nhóm thu thường có "anh em" thanh lý cùng HĐ → ghi số bù cho noteFor.
      const liqSibling = k.endsWith(":tl") ? 0 : liqByInvoice.get(list[0].invoiceId!) ?? 0;
      const extra = liqSibling > 0 ? { liqSiblingAmount: liqSibling } : undefined;
      if (list.length === 1) {
        inc.push({ ...list[0], groupCount: 1, ...extra });
      } else {
        inc.push({
          ...list[0],
          key: `inv-${k}`,
          amount: list.reduce((s, x) => s + x.amount, 0),
          notKqkd: list.some((x) => x.notKqkd),
          groupCount: list.length,
          voucherIds: Array.from(new Set(list.flatMap((x) => x.voucherIds ?? []))),
          // tìm theo mã: mọi phiếu thu của hoá đơn đều khớp được
          voucherCode: Array.from(new Set(list.map((x) => x.voucherCode).filter(Boolean))).join(" ") || null,
          mixedDeposit: list.some((x) => x.mixedDeposit),
          ...extra,
        });
      }
    }

    const sorter = (a: DisplayRow, b: DisplayRow) =>
      compareRoom(a.roomName, b.roomName) || a.description.localeCompare(b.description, "vi");
    // Cột Chi: hạng mục cố định (Tiền nhà → Điện → … → Thang máy) lên đầu,
    // trong cùng nhóm vẫn theo phòng → mô tả như cũ.
    exp.sort(
      (a, b) =>
        expenseRankOf(a.category, a.typeName, a.description, a.fixedRank) -
          expenseRankOf(b.category, b.typeName, b.description, b.fixedRank) || sorter(a, b),
    );

    // Phòng-trống chỉ bật khi đã chọn ≥1 toà (vacantNotes !== undefined). Tắt → cũ.
    if (!vacantNotes) {
      inc.sort(sorter);
      return { incomeRows: inc, expenseRows: exp };
    }

    const anyIncomeRooms = new Set<string>();
    // phòng có khoản thu GẮN HOÁ ĐƠN trong tháng — đã có hoá đơn (có thể của HĐ khác khi đổi phòng)
    const invoicedIncomeRooms = new Set<string>();
    for (const r of inc) {
      if (!r.roomId) continue;
      anyIncomeRooms.add(r.roomId);
      if (r.invoiceId) invoicedIncomeRooms.add(r.roomId);
    }

    // KHÔNG dồn dòng nào lên đầu nữa — xếp ĐỀU mọi dòng theo thứ tự phòng
    // (MB → G → L → 0 → 1 → 2 …). Vẫn GIỮ màu nền: khoản thanh lý/bỏ cọc vàng cam,
    // ghi chú phòng trống vàng cam, thiếu hoá đơn đỏ.
    const all: DisplayRow[] = inc.map((r) =>
      isLiquidationRow(r)
        ? {
            ...r,
            isVacant: true,
            vacantReason: r.roomId ? vacantNotes.get(r.roomId)?.reason : undefined,
          }
        : r
    );
    // Dòng ghi chú thuần (không cộng vào tổng):
    //  - HĐ kết thúc giữa tháng chưa thanh lý (kind 'ended_unsettled') → CẢNH BÁO đỏ.
    //  - còn HĐ (kind 'active'), theo hoá đơn kỳ của HĐ: chưa có hoá đơn → đỏ "Chưa có hoá đơn";
    //    có hoá đơn chưa thu đồng nào → đỏ "Có hoá đơn, chưa thu X"; đã thu một phần/đủ → không ghi.
    //  - trống thật (kind 'vacant') → ghi chú vàng cam "Trống phòng — <lý do>" (khi phòng không có
    //    khoản thu nào — phòng có dòng thanh lý/bỏ cọc đã được tô vàng ở trên).
    for (const note of vacantNotes.values()) {
      if (note.kind === "ended_unsettled") {
        all.push({
          key: `ended-${note.contractId ?? note.roomId}`,
          monthLabel,
          description: endedUnsettledNoteText(note),
          buildingName: note.buildingName,
          roomName: note.roomName,
          roomId: note.roomId,
          periodLabel: "—",
          typeName: "—",
          category: null,
          amount: 0,
          notKqkd: false,
          isMissingInvoice: true,
          isNote: true,
        });
        continue;
      }
      if (note.kind === "active") {
        const st = note.invoiceState;
        if (st === "paid" || st === "partial") continue;
        // chưa rõ trạng thái hoá đơn (dữ liệu cũ) ⇒ giữ luật cũ: phòng có khoản thu thì bỏ qua
        if (st === undefined && anyIncomeRooms.has(note.roomId)) continue;
        if (st === "none" && invoicedIncomeRooms.has(note.roomId)) continue;
      } else if (anyIncomeRooms.has(note.roomId)) {
        continue;
      }
      if (note.kind === "active") {
        all.push({
          key: `missing-${note.roomId}`,
          monthLabel,
          // Nhãn "Còn hợp đồng" nay là badge đỏ riêng bên cạnh (xem renderPanel)
          // nên mô tả không lặp lại nữa.
          description: activeRoomNoteText(note),
          buildingName: note.buildingName,
          roomName: note.roomName,
          roomId: note.roomId,
          periodLabel: "—",
          typeName: "—",
          category: null,
          amount: 0,
          notKqkd: false,
          isMissingInvoice: true,
          isNote: true,
        });
      } else {
        all.push({
          key: `vacant-${note.roomId}`,
          monthLabel,
          description: vacancyNoteText(note.reason, note.vacantSince, vacancyRefDate),
          buildingName: note.buildingName,
          roomName: note.roomName,
          roomId: note.roomId,
          periodLabel: "—",
          typeName: "—",
          category: null,
          amount: 0,
          notKqkd: false,
          isVacant: true,
          isNote: true,
          vacantReason: note.reason,
        });
      }
    }
    all.sort(sorter);
    return { incomeRows: all, expenseRows: exp };
  }, [accrualMode, accrual, result, monthLabel, vacantNotes, pnlOnly, vacancyRefDate]);

  // Lọc bỏ dòng thuộc hạng mục đặc biệt khi bật toggle (chỉ ẩn dòng — số tổng
  // 3 thẻ + header lấy từ stats/accrual nên KHÔNG đổi).
  const isSpecialRow = (r: DisplayRow) =>
    (r.typeId && specialTypeIds.has(r.typeId)) ||
    specialTypeNames.has((r.typeName ?? "").trim().toLowerCase());
  const filterSpecial = (rows: DisplayRow[]) =>
    hideSpecialTypes && hasSpecialTypes ? rows.filter((r) => !isSpecialRow(r)) : rows;
  const shownIncomeRows = useMemo(
    () => filterSpecial(incomeRows),
    [incomeRows, hideSpecialTypes, hasSpecialTypes, specialTypeIds, specialTypeNames]
  );
  const shownExpenseRows = useMemo(
    () => filterSpecial(expenseRows),
    [expenseRows, hideSpecialTypes, hasSpecialTypes, specialTypeIds, specialTypeNames]
  );

  // Toà đang lọc (chỉ khi đúng 1 toà) — lấy từ danh sách đã fetch để đọc cờ
  // has_elevator + tên toà cho dòng placeholder.
  const singleBuilding = useMemo(
    () =>
      buildingIds.length === 1
        ? (buildings as any[]).find((b) => b.id === buildingIds[0]) ?? null
        : null,
    [buildings, buildingIds]
  );

  // Chèn dòng placeholder "chưa có phiếu" cho các hạng mục chi CỐ ĐỊNH còn thiếu khi đang lọc
  // đúng 1 toà — lấy từ bộ dò chung (profitChecks: khớp hạng mục theo khoá fee_category, bỏ khoản
  // "không áp dụng", thang máy khi toà không có, tiền nhà ở toà vận hành cho chủ nhà; chỉ chế độ phân
  // bổ theo kỳ, không lọc 1 phòng / chỉ thu). Xem nhiều toà thì thiếu/trùng hiện ở chip bộ dò.
  // Dòng placeholder là ghi chú (isNote) nên KHÔNG ảnh hưởng tổng 3 thẻ / "X khoản".
  const displayExpenseRows = useMemo(() => {
    if (loading || !profitChecks || !singleBuilding || singleBuilding.is_virtual) return shownExpenseRows;
    const missing: DisplayRow[] = [];
    for (const cell of profitChecks.fixedFees.issues) {
      if (cell.buildingId !== singleBuilding.id || cell.status !== "MISSING") continue;
      const i = FIXED_EXPENSE_CATEGORIES.findIndex((c) => c.key === cell.key);
      const cat = FIXED_EXPENSE_CATEGORIES[i];
      if (!cat) continue;
      missing.push({
        key: `missing-exp-${i}`,
        monthLabel,
        description: cat.label,
        buildingName: singleBuilding.name ?? "",
        roomName: null,
        periodLabel: "—",
        typeName: cat.label,
        category: null,
        amount: 0,
        notKqkd: false,
        isNote: true,
        isMissingExpense: true,
        fixedRank: i,
      });
    }
    if (missing.length === 0) return shownExpenseRows;
    return [...shownExpenseRows, ...missing].sort(
      (a, b) =>
        expenseRankOf(a.category, a.typeName, a.description, a.fixedRank) -
          expenseRankOf(b.category, b.typeName, b.description, b.fixedRank) ||
        compareRoom(a.roomName, b.roomName) ||
        a.description.localeCompare(b.description, "vi")
    );
  }, [shownExpenseRows, loading, profitChecks, singleBuilding, monthLabel]);

  // B5: số liệu cho thanh kiểm chứng — Σ dòng hiển thị vs tổng thẻ.
  const sumRows = (rows: DisplayRow[]) =>
    rows.reduce((s, r) => (r.isNote ? s : s + r.amount), 0);
  const shownIncomeSum = useMemo(() => sumRows(shownIncomeRows), [shownIncomeRows]);
  const shownExpenseSum = useMemo(() => sumRows(shownExpenseRows), [shownExpenseRows]);
  const hiddenIncomeSum = sumRows(incomeRows) - shownIncomeSum;
  const hiddenExpenseSum = sumRows(expenseRows) - shownExpenseSum;
  const hiddenCount =
    incomeRows.length + expenseRows.length - shownIncomeRows.length - shownExpenseRows.length;
  const capWarning =
    !accrualMode && (result?.totalCount ?? 0) > LIST_LIMIT
      ? { shown: LIST_LIMIT, total: result?.totalCount ?? 0 }
      : null;

  // Tổng/đã trả của các hoá đơn xuất hiện trong cột Thu → tính note thiếu/thừa.
  const invoiceIds = useMemo(
    () => Array.from(new Set(incomeRows.filter((r) => r.invoiceId).map((r) => r.invoiceId!))),
    [incomeRows]
  );
  const { data: invoiceTotals } = useInvoiceTotalsByIds(invoiceIds);
  // Chi tiết "hoá đơn tháng đầu" (HĐ tự sinh khi ký HĐ) cho các HĐ trong cột Thu:
  // kỳ tiền phòng + đã thu/tổng HĐ + cọc đã đóng/tổng. Chỉ trả về HĐ tháng đầu.
  const { data: firstInvoiceDetails } = useFirstInvoiceDetails(invoiceIds);
  // Kỳ tiền phòng của hoá đơn KHÔNG đủ ngày (prorate) — tô xanh lá + ghi chú kỳ.
  const { data: rentPeriods } = useInvoiceRentPeriods(invoiceIds);

  // Tách tiền phòng / điện / nước / PDV của khoản thu theo hoá đơn (chủ chốt 25/10/2026 — như Quyết toán vận
  // hành; server chia và xét phiếu nào được tách). Không gửi: dòng thanh lý / bỏ cọc (nhóm riêng), dòng gồm khoản
  // ngoài KQKD (cọc khi tắt "Chỉ KQKD").
  const partsRequests = useMemo(
    () =>
      shownIncomeRows
        .filter((r) => r.invoiceId && !r.isNote && !r.notKqkd && !r.mixedDeposit && !isLiquidationRow(r)
          && r.amount > 0 && (r.voucherIds?.length ?? 0) > 0)
        .map((r) => ({ key: r.key, invoiceId: r.invoiceId!, amount: r.amount, voucherIds: r.voucherIds! })),
    [shownIncomeRows]
  );
  const {
    data: incomeParts,
    isError: partsError,
    refetch: retryParts,
    isPlaceholderData: partsPlaceholder,
    isFetching: partsFetching,
  } = useInvoiceAmountParts(partsRequests, !loading);
  // Bảng cột Tiền phòng · Điện · Nước · PDV chỉ khi có dòng đã tách — chưa tách được (đang tải, lỗi, server cũ)
  // thì giữ danh sách cũ, không hiện cột trống.
  const incomeTable = (incomeParts?.size ?? 0) > 0;

  // "Theo hạng mục" của hai cột (dòng đang hiện, bỏ dòng ghi chú). Khoản thu đã tách ⇒ cộng theo cột hoá đơn
  // (tên trùng hạng mục của quyết toán vận hành); còn lại theo hạng mục của dòng. Chỉ để hiển thị tỷ trọng.
  const incomeCats = useMemo(
    () => categorySharesOf(shownIncomeRows.map((r) => ({ key: r.key, name: r.typeName, amount: r.amount, isNote: r.isNote })), incomeParts),
    [shownIncomeRows, incomeParts]
  );
  const expenseCats = useMemo(
    () => categorySharesOf(shownExpenseRows.map((r) => ({ key: r.key, name: r.typeName, amount: r.amount, isNote: r.isNote }))),
    [shownExpenseRows]
  );
  // mở / đóng "Theo hạng mục" ở hai cột cùng lúc (mặc định thu gọn — như quyết toán vận hành)
  const [catsOpen, setCatsOpen] = useState(false);

  // Ô tìm + ô tích "Theo hạng mục" của từng khung (chủ chốt 28/10/2026) — CHỈ lọc danh sách đang xem: tổng thẻ,
  // tổng khung, tỷ trọng và số đưa vào thanh kiểm chứng vẫn tính trên toàn bộ dòng. Không lưu qua F5; đổi tháng/toà
  // giữ chữ đang tìm, hạng mục không còn trong dữ liệu mới thì tự bỏ.
  const [rowSearch, setRowSearch] = useState<Record<Side, string>>({ income: "", expense: "" });
  const [catPick, setCatPick] = useState<Record<Side, ReadonlySet<string>>>({
    income: NO_CATEGORIES,
    expense: NO_CATEGORIES,
  });
  // Tên hạng mục thu đến từ phần tách hoá đơn: lúc phần tách còn là số của lần trước (hook giữ tạm khi đổi
  // tháng/toà), đang tải hay lỗi thì tên chưa chốt ⇒ đừng bỏ tích oan. Danh sách lỗi tải (rỗng) cũng không bỏ gì.
  const incomeNamesUnsettled = partsRequests.length > 0 && (partsPlaceholder || partsFetching || partsError);
  const listError = accrualMode ? accrualError : cashError;
  useEffect(() => {
    if (loading || listError) return;
    const namesOf = (cats: { name: string; amount: number }[]) => cats.filter((c) => c.amount !== 0).map((c) => c.name);
    setCatPick((p) => pruneSideSelections(p, {
      income: incomeNamesUnsettled ? null : namesOf(incomeCats),
      expense: namesOf(expenseCats),
    }));
  }, [loading, listError, incomeNamesUnsettled, incomeCats, expenseCats]);
  const clearRowFilters = (side: Side) => {
    setRowSearch((p) => ({ ...p, [side]: "" }));
    setCatPick((p) => ({ ...p, [side]: NO_CATEGORIES }));
  };

  // Bấm khoản chi → hộp phiếu của Thu chi (ProfitVoucherViewer).
  const [voucherView, setVoucherView] = useState<string | null>(null);
  const closeVoucherView = useCallback(() => setVoucherView(null), []);

  // Chi tiết các lần thu của 1 hoá đơn (nhấp đôi vào dòng) — dùng lại dialog
  // "Các lần thanh toán" (hiện số tiền + ngày giờ từng lần).
  const [detailInvoiceId, setDetailInvoiceId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const { data: detailInvoice } = useInvoice(detailInvoiceId ?? undefined);
  const openDetail = (invoiceId: string) => {
    setDetailInvoiceId(invoiceId);
    setDetailOpen(true);
  };

  // Bấm TÊN hoá đơn (cột Mô tả) → modal chi tiết hoá đơn full-screen như trang
  // /invoices (khác với bấm số tiền → dialog "Các lần thanh toán" ở trên).
  const [invoiceModal, setInvoiceModal] = useState<{ id: string; title: string } | null>(null);
  const [invoiceModalOpen, setInvoiceModalOpen] = useState(false);
  const openInvoiceModal = (id: string, title: string) => {
    setInvoiceModal({ id, title });
    setInvoiceModalOpen(true);
  };

  // Tạo phiếu chi ngay tại trang — prefill giữ trong state (identity ổn định,
  // effect reset của form phụ thuộc defaultPrefill). Kỳ item = tháng đang xem.
  const [expenseFormOpen, setExpenseFormOpen] = useState(false);
  const [expensePrefill, setExpensePrefill] = useState<IncomeExpensePrefill | undefined>();
  // Dialog cài đặt cảnh báo thiếu phiếu chi theo toà (nút bánh răng header Chi).
  const [missingCfgOpen, setMissingCfgOpen] = useState(false);
  // Bấm SỐ PHÒNG ở cột Thu → panel vòng đời hợp đồng của phòng trong năm báo cáo.
  // `anchor` = khung cuộn cột Thu: mép trái panel bám mép phải của nó (chỗ thanh cuộn).
  const [lifecycleRoom, setLifecycleRoom] = useState<
    { id: string; name: string; anchor: HTMLElement | null } | null
  >(null);
  // Nút + ở header Khoản chi: prefill toà (khi lọc đúng 1 toà thật) + kỳ.
  const openCreateExpense = () => {
    setExpensePrefill({
      building_id: singleBuilding && !singleBuilding.is_virtual ? singleBuilding.id : undefined,
      period: { start_date: startDate, end_date: endDate },
    });
    setExpenseFormOpen(true);
  };
  // Bấm dòng vàng "chưa có phiếu": prefill thêm đúng hạng mục còn thiếu.
  const openCreateMissingExpense = (r: DisplayRow) => {
    const type = findTypeForFixedCategory(expenseTypes, r.fixedRank ?? -1);
    if (!type)
      toast.info(`Không tìm thấy loại chi khớp "${r.typeName}" — chọn hạng mục thủ công trong form`);
    setExpensePrefill({
      // Dòng missing chỉ sinh khi đang lọc đúng 1 toà thật (không ảo).
      building_id: singleBuilding?.id,
      period: { start_date: startDate, end_date: endDate },
      items: type
        ? [{ income_expense_type_id: type.id, type_name: type.name, quantity: 1, unit_price: 0 }]
        : undefined,
    });
    setExpenseFormOpen(true);
  };
  // "Lập phiếu" ở một khoản chi cố định còn thiếu trong chip bộ dò (mọi toà): đúng toà + hạng mục.
  const openCreateFixedFee = (cell: FixedFeeCell) => {
    const rank = FIXED_EXPENSE_CATEGORIES.findIndex((c) => c.key === cell.key);
    const type = findTypeForFixedCategory(expenseTypes, rank);
    if (!type) toast.info(`Không tìm thấy loại chi khớp "${cell.label}" — chọn hạng mục thủ công trong form`);
    setExpensePrefill({
      building_id: cell.buildingId,
      period: { start_date: startDate, end_date: endDate },
      items: type
        ? [{ income_expense_type_id: type.id, type_name: type.name, quantity: 1, unit_price: fixedFeePrefillAmount(cell) }]
        : undefined,
    });
    setExpenseFormOpen(true);
  };

  // Note "thiếu/thừa so với hoá đơn": so tổng khoản thu (đã gộp) với total HĐ.
  // Chế độ P&L (pnlOnly): row.amount là PHẦN KQKD (không gồm cọc) → phải so với
  // phần phòng/DV của hoá đơn (total − cọc gộp trong HĐ), kẻo HĐ tháng đầu gộp
  // cọc bị báo "thiếu" oan đúng bằng tiền cọc. Tắt pnlOnly: so tiền thật vs total.
  const noteFor = (row: DisplayRow): { text: string; cls: string } | null => {
    if (!row.invoiceId) return null;
    // Dòng thanh lý/bỏ cọc: phiếu doanh thu có amount = cọc-cấn-nợ (trải trên NHIỀU
    // hoá đơn khác), KHÔNG so được với mệnh giá 1 hoá đơn quyết toán nó gắn vào
    // → cờ "thừa/thiếu" là artifact gây hiểu nhầm, bỏ qua (B5 — audit 03/07).
    if (isLiquidationRow(row)) return null;
    const inv = invoiceTotals?.get(row.invoiceId);
    if (!inv || !inv.total_amount) return null;
    const depositInInvoice = pnlOnly
      ? firstInvoiceDetails?.get(row.invoiceId)?.depositInInvoice ?? 0
      : 0;
    // Trừ thêm phần đã thanh toán bởi phiếu thanh lý (đã tách dòng riêng) —
    // kẻo nhóm tiền phòng bị báo "thiếu" oan đúng bằng phần phụ thu thanh lý.
    const diff = Math.round(
      row.amount - (inv.total_amount - depositInInvoice - (row.liqSiblingAmount ?? 0))
    );
    if (diff <= -1) return { text: `thiếu ${formatCurrency(-diff)}`, cls: "text-amber-600" };
    if (diff >= 1) return { text: `thừa ${formatCurrency(diff)}`, cls: "text-rose-600" };
    return null;
  };

  // Tên dòng THU:
  //  - Khoản thanh lý hợp đồng → "HĐ Thanh Lý Hợp Đồng" (phiếu trải trên nhiều
  //    HĐ, lấy tên 1 hoá đơn sẽ gây hiểu nhầm — giữ nhãn gộp).
  //  - Dòng gắn hoá đơn → lấy ĐÚNG tên bên trang /invoices nhưng BỎ phần
  //    "<phòng>/<toà>" (phòng đã có cột riêng) — vd "TIỀN PHÒNG - 05/2026",
  //    HĐ tháng đầu là "TIỀN PHÒNG THÁNG ĐẦU TIÊN - 05/2026".
  //  - Chưa tải xong invoiceTotals → tạm rơi về nhãn rút gọn cũ.
  //  Luật nằm ở src/lib/voucherDisplayName.ts (dùng chung với Thu chi và Quyết toán vận hành). Dòng
  //  ghi chú thuần ("Trống N ngày … — Thanh lý HĐ" chứa "thanh ly" nhưng KHÔNG phải khoản thanh lý) và
  //  phiếu chi (vd chi hoàn cọc khi thanh lý) giữ đúng tên của nó.
  const displayDescription = (r: DisplayRow, side: "income" | "expense"): string =>
    profitReportRowDescription(
      { isNote: !!r.isNote, side, typeName: r.typeName, description: r.description },
      { invoice: r.invoiceId ? invoiceTotals?.get(r.invoiceId)?.titleParts : null, month: mm || 1 },
    );

  // Dòng đưa vào ô tìm / ô tích: tên hạng mục TRÙNG khối "Theo hạng mục" (incomeCats/expenseCats); chữ để tìm gồm
  // mô tả đang hiện + tên/mã phiếu + hạng mục + phòng + toà.
  const viewRowOf = (side: Side) => (r: DisplayRow): ProfitViewRow => ({
    key: r.key,
    name: r.typeName,
    amount: r.amount,
    isNote: r.isNote,
    room: r.roomName,
    texts: [displayDescription(r, side), r.description, r.voucherCode, r.typeName, r.roomName, r.buildingName],
  });
  const incomeView = useMemo(
    () => filterProfitRows(shownIncomeRows, viewRowOf("income"),
      { search: rowSearch.income, categories: catPick.income }, incomeParts),
    // displayDescription chỉ đọc invoiceTotals + tháng
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shownIncomeRows, rowSearch.income, catPick.income, incomeParts, invoiceTotals, mm],
  );
  const expenseView = useMemo(
    () => filterProfitRows(displayExpenseRows, viewRowOf("expense"),
      { search: rowSearch.expense, categories: catPick.expense }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [displayExpenseRows, rowSearch.expense, catPick.expense],
  );

  // Mặc định ẩn/hiện cột: ẩn cột mà MỌI dòng (gộp cả 2 bên để 2 bảng đồng cột)
  // có cùng giá trị — tức cột đã bị bộ lọc ghim (tháng/toà/phòng/kỳ…).
  const autoVisible = useMemo(() => {
    const all = [...incomeRows, ...expenseRows];
    const m = {} as Record<ColKey, boolean>;
    for (const c of TOGGLE_COLUMNS) m[c.key] = !allSame(all, COL_VALUE[c.key]);
    // Lọc theo 1 toà cụ thể (kèm kỳ tháng cố định) → ẩn cột "Kỳ" mặc định cho gọn.
    if (buildingIds.length > 0) m.ky = false;
    return m;
  }, [incomeRows, expenseRows, buildingIds]);

  const visible = (k: ColKey) => colOverrides[k] ?? autoVisible[k];
  const toggleCol = (k: ColKey) =>
    setColOverrides((o) => ({ ...o, [k]: !(o[k] ?? autoVisible[k]) }));
  const resetCols = () => setColOverrides({});

  const visibleToggleCols = TOGGLE_COLUMNS.filter((c) => visible(c.key));

  // Bộ lọc "Loại" ghim 1 bên → ẩn hẳn panel còn lại.
  const showThu = voucherType !== "EXPENSE";
  const showChi = voucherType !== "INCOME";

  const monthOptions = useMemo(() => {
    const out: string[] = [];
    const d = new Date();
    for (let i = 0; i < 24; i++) {
      const dt = new Date(d.getFullYear(), d.getMonth() - i, 1);
      out.push(format(dt, "MM-yyyy"));
    }
    return out;
  }, []);

  // Nút ◀ ▶ trên dải hero — lùi/tiến 1 tháng (không giới hạn 24 tháng như dropdown).
  const stepMonth = (delta: number) => setMonthStr(format(addMonths(monthDate, delta), "MM-yyyy"));

  // Cột LN 6 tháng gần nhất trên hero — CẢ 6 cột (kể cả tháng đang xem) lấy từ RPC
  // fa_monthly_pnl (aggregate server, không dính cap 1000) cùng MỘT cơ sở: phiếu đã
  // duyệt, chỉ KQKD. Trước đây cột tháng đang xem lấy số của trang (gồm chờ duyệt,
  // có thể gồm ngoài-KQKD) nên so với 5 cột trước là so hai cơ sở khác nhau.
  const { data: faMonths = [] } = useFaMonthlyPnl(
    scopeReady ? format(startOfMonth(addMonths(monthDate, -5)), "yyyy-MM-dd") : undefined,
    endDate,
    buildingFilter,
    accrualMode,
  );
  const profitSeries = useMemo(() => {
    const byMonth = new Map<string, number>();
    for (const r of faMonths) {
      const k = String(r.month).slice(0, 7);
      byMonth.set(k, (byMonth.get(k) ?? 0) + r.net);
    }
    return Array.from({ length: 6 }, (_, i) => {
      const d = addMonths(monthDate, i - 5);
      return {
        label: `T${d.getMonth() + 1}`,
        value: byMonth.get(format(d, "yyyy-MM")) ?? 0,
        current: i === 5,
      };
    });
  }, [faMonths, monthDate]);
  const prevMonthProfit = profitSeries[4]?.value ?? 0;
  const curMonthApproved = profitSeries[5]?.value ?? 0;
  // % so tháng trước: cùng cơ sở với cột (đã duyệt, chỉ KQKD) — không lấy số lớn (gồm chờ duyệt)
  const momPct =
    prevMonthProfit !== 0 ? ((curMonthApproved - prevMonthProfit) / Math.abs(prevMonthProfit)) * 100 : null;
  // Thẻ Lợi nhuận chỉ có nghĩa khi xem cả thu lẫn chi
  const profitApplies = voucherType === "all";
  const pendingBuildingIds = useMemo(() => pendingBuildingIdsOf(accrual?.rows), [accrual]);
  const ihomeLine = useIhomeProfitLine(ym, scopeIds, displayDiff, {
    // đang tải thì tổng còn là 0 ⇒ chưa trừ được (tránh hiện số âm bằng đúng phần chủ nhà)
    enabled: profitApplies && roomId === "all" && !hideStatCards && !loading,
    sameBasis: accrualMode && pnlOnly,
    pendingBuildingIds,
  });
  const prevMonthLabel = format(addMonths(monthDate, -1), "MM/yyyy");
  const sparkMax = Math.max(1, ...profitSeries.map((p) => Math.abs(p.value)));

  // Số đếm cho dòng chip cảnh báo trên hero.
  const incomeCount = shownIncomeRows.filter((r) => !r.isNote).length;
  const expenseCount = displayExpenseRows.filter((r) => !r.isNote).length;
  const buildingCount = useMemo(() => {
    const names = new Set<string>();
    for (const r of [...incomeRows, ...expenseRows]) if (r.buildingName) names.add(r.buildingName);
    return names.size;
  }, [incomeRows, expenseRows]);
  // Cảnh báo bộ dò đẩy thanh kiểm chứng (và chip của nó) lên "cần xem lại": khớp engine chỉ chứng
  // minh cùng tập phiếu, không chứng minh đã đủ phiếu.
  const checkWarnings = useMemo(() => {
    const out: string[] = [];
    const f = profitChecks?.fixedFees;
    if (f && f.missingBuildingCount > 0) out.push(`Thiếu chi cố định ở ${f.missingBuildingCount} toà`);
    if (f && f.duplicateBuildingCount > 0) out.push(`Có thể trùng chi cố định ở ${f.duplicateBuildingCount} toà`);
    const s = profitChecks?.stalePending;
    if (s && s.count > 0) out.push(`${s.count} phiếu chờ duyệt quá ${s.thresholdDays} ngày vẫn đang nằm trong tổng`);
    out.push(...postLock.warnings);
    return out;
  }, [profitChecks, postLock.warnings]);
  const expenseRatio = displayIncome > 0 ? Math.round((displayExpense / displayIncome) * 100) : 0;
  const marginPct = displayIncome > 0 ? Math.round((displayDiff / displayIncome) * 100) : 0;

  // Chip "Kiểm chứng" trên hero soi lại trạng thái của thanh kiểm chứng ở thân
  // trang (nguồn duy nhất — không gọi lại RPC).
  const [verifyState, setVerifyState] = useState<ProfitVerificationVisualState>("LOADING");
  const [verifiedAt, setVerifiedAt] = useState<string | null>(null);
  const handleVerifyState = useCallback((s: ProfitVerificationVisualState) => {
    setVerifyState(s);
    setVerifiedAt(s === "LOADING" ? null : format(new Date(), "HH:mm"));
  }, []);

  // Dòng phụ dưới mô tả — gộp các cột đang bật (bảng 3 cột của bản thiết kế
  // không còn cột riêng, thông tin "Tháng · Toà · Phòng · Phân loại · Kỳ" dồn
  // xuống đây). Cột đã nằm ở ô mã bên trái thì không lặp lại.
  // Xem nhiều toà: ô phòng cột Thu ghi thêm toà (vd "L04 / 1392QT") ⇒ dòng phụ không lặp tên toà; lọc một toà
  // thì đã biết toà, không ghi ở đâu cả (chủ nhắn 26/10/2026).
  const buildingInTag = buildingIds.length !== 1;
  const subParts = (r: DisplayRow, side: "income" | "expense", hasTag: boolean): string[] => {
    const out: string[] = [];
    if (visible("thang")) out.push(r.monthLabel);
    if (visible("toa_nha") && r.buildingName && !(side === "income" && hasTag)) out.push(r.buildingName);
    if (visible("phong") && !(side === "income" && hasTag) && r.roomName) out.push(r.roomName);
    if (visible("phan_loai") && r.typeName && r.typeName !== "—") out.push(r.typeName);
    if (visible("ky") && r.periodLabel && r.periodLabel !== "—") out.push(r.periodLabel);
    return out;
  };

  const renderPanel = (
    side: Side,
    title: string,
    total: number,
    data: DisplayRow[],
    view: ProfitViewResult<DisplayRow>,
    headerAction?: ReactNode,
  ) => {
    // Ô mã 40×32 đầu dòng: cột Thu là SỐ PHÒNG, cột Chi là mã hạng mục — theo
    // đúng toggle cột tương ứng nên popover "Cột" vẫn điều khiển được.
    const hasTag = side === "income" ? visible("phong") : visible("phan_loai");
    // ô phòng có thêm dòng tên toà ⇒ rộng hơn
    const tagBld = side === "income" && hasTag && buildingInTag;
    const tagCol = tagBld ? "60px" : "44px";
    // Khoản thu theo hoá đơn: bảng Tiền phòng · Điện · Nước · PDV · Tổng (như Quyết toán vận hành)
    const table = side === "income" && incomeTable;
    const gridStyle = table
      ? {
          gridTemplateColumns: `${hasTag ? `${tagCol} ` : ""}repeat(4, minmax(0, 1fr)) minmax(92px, auto)`,
          columnGap: 8,
        }
      : { gridTemplateColumns: hasTag ? `${tagCol} 1fr auto` : "1fr auto" };
    // dòng không tách / dòng mô tả dưới các cột: trải từ sau ô phòng tới hết
    const spanCells = { gridColumn: hasTag ? "2 / span 4" : "1 / span 4" };
    const spanBelow = { gridColumn: hasTag ? "2 / -1" : "1 / -1" };
    const realCount = data.filter((r) => !r.isNote).length;
    const cats = side === "income" ? incomeCats : expenseCats;
    // danh sách đang xem sau ô tìm / ô tích (chỉ lớp xem — mọi tổng ở trên vẫn tính trên `data`)
    const rows = view.rows;
    const picked = catPick[side];

    return (
      <div className={`ph-panel ph-panel--${side}`}>
        <div className="ph-panel__head">
          <div className="ph-panel__name">{title}</div>
          <div className="ph-panel__count" data-testid={`profit-count-${side}`}>
            {view.active ? `${view.count}/${realCount}` : realCount} khoản
          </div>
          <ProfitRowSearchInput side={side} value={rowSearch[side]}
            onChange={(value) => setRowSearch((p) => ({ ...p, [side]: value }))}
            className="max-w-[210px] flex-1" />
          {headerAction}
          {!hideTotals && <div className="ph-panel__total">{formatCurrency(total)}</div>}
        </div>

        {!loading && (
          <CategoryShareBlock cats={cats} total={side === "income" ? shownIncomeSum : shownExpenseSum}
            kind={side === "income" ? "INCOME" : "EXPENSE"} open={catsOpen}
            onToggle={() => setCatsOpen((v) => !v)} testId="profit-categories"
            selected={picked}
            onToggleSelect={(name) => setCatPick((p) => ({ ...p, [side]: toggleCategorySelection(p[side], name) }))} />
        )}
        {!loading && view.active && (
          <ProfitFilterBar side={side} categories={[...picked]} search={rowSearch[side].trim()}
            shown={view.count} total={realCount}
            amount={picked.size > 0 ? view.selectedAmount : view.total}
            amountLabel={picked.size > 0 ? "phần hạng mục đã chọn" : "tổng"}
            onClear={() => clearRowFilters(side)}
            className={`border-b px-3.5 py-1.5 ${side === "income" ? "bg-[#f7fcf9]" : "bg-[#fffaf5]"}`} />
        )}
        {side === "income" && partsError && (
          <button type="button" className="ph-panel__foot" style={{ width: "100%", borderTop: 0 }} onClick={() => retryParts()}>
            Chưa tách được tiền phòng / điện / nước — bấm để thử lại
          </button>
        )}

        <div className="ph-row ph-row--head" style={gridStyle}>
          {hasTag && <div>{side === "income" ? "Phòng" : "Loại"}</div>}
          {table ? (
            <>
              <div style={{ textAlign: "right" }}>Tiền phòng</div>
              <div style={{ textAlign: "right" }}>Điện</div>
              <div style={{ textAlign: "right" }}>Nước</div>
              <div style={{ textAlign: "right" }}>PDV</div>
              <div style={{ textAlign: "right" }}>Tổng</div>
            </>
          ) : (
            <>
              <div>Mô tả</div>
              <div style={{ textAlign: "right" }}>Số tiền</div>
            </>
          )}
        </div>

        <div className="ph-panel__scroll">
          {loading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <div className="ph-row" style={gridStyle} key={i}>
                {hasTag && <Skeleton className="h-8 w-10 rounded-lg" />}
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-24" />
              </div>
            ))
          ) : data.length === 0 ? (
            <div className="ph-empty">Không có khoản nào</div>
          ) : rows.length === 0 ? (
            <div className="ph-empty" data-testid={`profit-filter-empty-${side}`}>
              Không có khoản nào khớp bộ lọc —{" "}
              <button type="button" className="underline underline-offset-2" onClick={() => clearRowFilters(side)}>Bỏ lọc</button>
            </div>
          ) : (
            rows.map((r) => {
              const clickable = !!r.invoiceId;
              // khoản chi thật → mở phiếu của Thu chi (chủ chốt 28/10/2026); dòng vàng "chưa có phiếu" giữ luồng tạo
              const voucherId = side === "expense" && !r.isNote && canViewVoucher ? r.voucherIds?.[0] ?? null : null;
              const pressable = clickable || !!voucherId;
              const note = noteFor(r);
              // HĐ tháng đầu: tô NỀN NHẠT cả dòng theo trạng thái — xanh khi HĐ
              // & cọc đều đủ, hồng khi còn thiếu (dung sai 1đ cho làm tròn).
              // Dòng thanh lý (tách riêng) KHÔNG nhận block HĐ tháng đầu/prorate
              // — tránh render đúp khi hoá đơn có cả nhóm thu thường cùng HĐ.
              const fd = r.invoiceId && !isLiquidationRow(r) ? firstInvoiceDetails?.get(r.invoiceId) : null;
              const invFull = fd ? fd.rentServiceTotal - fd.rentServicePaid < 1 : false;
              const depFull = fd ? fd.depositTotal - fd.depositPaid < 1 : false;
              const firstFull = invFull && depFull;
              // Hoá đơn KHÔNG đủ ngày (prorate — khách vào/rời giữa tháng, có đoạn
              // trống) → nền XANH LÁ nhạt + ghi chú kỳ tiền phòng.
              const rp = r.invoiceId && !isLiquidationRow(r) ? rentPeriods?.get(r.invoiceId) : null;
              // Thứ tự ưu tiên nền: hạng mục chi thiếu phiếu (VÀNG NHẠT) → thiếu
              // hoá đơn (ĐỎ) → phòng trống (vàng cam) → HĐ không đủ ngày (xanh lá)
              // → HĐ tháng đầu (xanh khi đủ / hồng khi còn thiếu).
              const state = r.isMissingExpense
                ? "is-missing-expense"
                : r.isMissingInvoice
                  ? "is-missing-invoice"
                  : r.isVacant
                    ? "is-vacant"
                    : rp || (fd && firstFull)
                      ? "is-prorate"
                      : fd
                        ? "is-first-due"
                        : "";
              const rowClickable = pressable || (r.isMissingExpense && canCreate);
              const detailBlock = fd || (!fd && rp);
              const sub = subParts(r, side, hasTag);
              const parts = table ? incomeParts?.get(r.key) : undefined;
              // dòng đã tách: bỏ dòng mô tả "TIỀN PHÒNG - 10/2026 · … · Thu tiền hoá đơn", chỉ giữ ở hoá đơn tháng
              // đầu (chủ nhắn 26/10/2026) — mô tả vẫn có khi rê chuột
              const showMain = !parts || !!fd;
              // giảm trừ / nợ cũ: ngay dưới tổng tiền, chỉ số gọn (chủ nhắn 26/10/2026)
              const adjust = parts ? invoiceAdjustmentsText(parts) : "";
              const invTitle = displayDescription(r, side) + (r.roomName ? ` — ${r.roomName}` : "");
              // bấm vào dòng là xem hoá đơn luôn (chủ nhắn 26/10/2026); bấm số tiền vẫn xem các lần thu
              const onRowClick = clickable
                ? () => openInvoiceModal(r.invoiceId!, invTitle)
                : voucherId
                  ? () => setVoucherView(voucherId)
                  : r.isMissingExpense && canCreate ? () => openCreateMissingExpense(r) : undefined;

              return (
                <div
                  key={r.key}
                  style={gridStyle}
                  className={`ph-row${detailBlock && !parts ? " ph-row--tall" : ""}${
                    rowClickable ? " ph-row--click" : ""
                  }${parts ? " ph-row--parts" : ""}${state ? ` ${state}` : ""}`}
                  data-testid={side === "income" ? "profit-income-row" : "profit-expense-row"}
                  data-layout={table ? (parts ? "table" : "table-other") : undefined}
                  onClick={onRowClick}
                  // dòng hoá đơn / khoản chi bấm được bằng bàn phím (đã bỏ nút tên hoá đơn)
                  role={pressable ? "button" : undefined}
                  tabIndex={pressable ? 0 : undefined}
                  onKeyDown={pressable ? (e) => {
                    if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onRowClick?.(); }
                  } : undefined}
                  title={
                    r.isMissingExpense && canCreate
                      ? "Bấm để tạo phiếu chi cho hạng mục này"
                      : clickable
                        ? `Bấm vào dòng: xem hoá đơn · bấm số tiền: xem các lần thu${
                            showMain ? "" : ` — ${[displayDescription(r, side), ...sub].join(" · ")}`}`
                        : voucherId
                          ? `Bấm để xem phiếu chi${r.voucherCode ? ` ${r.voucherCode}` : ""}`
                          : undefined
                  }
                >
                  {hasTag &&
                    (side === "income" && r.roomId ? (
                      <button
                        type="button"
                        className={`ph-tag ph-tag--btn${tagBld ? " ph-tag--bld" : ""}`}
                        title={`Xem vòng đời hợp đồng phòng ${r.roomName ?? ""}${tagBld && r.buildingName ? ` — ${r.buildingName}` : ""} năm ${yyyy}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setLifecycleRoom({
                            id: r.roomId!,
                            name: r.roomName ?? "—",
                            anchor: e.currentTarget.closest<HTMLElement>(".ph-panel__scroll"),
                          });
                        }}
                        onDoubleClick={(e) => e.stopPropagation()}
                      >
                        <span>{r.roomName ?? "—"}</span>
                        {tagBld && r.buildingName && <span className="ph-tag__bld" data-testid="profit-tag-building">{r.buildingName}</span>}
                      </button>
                    ) : (
                      <div
                        className={`ph-tag${side === "expense" ? " ph-tag--code" : ""}${tagBld ? " ph-tag--bld" : ""}`}
                        title={side === "income" ? `${r.roomName ?? "—"}${tagBld && r.buildingName ? ` — ${r.buildingName}` : ""}` : r.typeName}
                      >
                        <span>{side === "income" ? r.roomName ?? "—" : typeCode(r.typeName)}</span>
                        {tagBld && r.buildingName && <span className="ph-tag__bld" data-testid="profit-tag-building">{r.buildingName}</span>}
                      </div>
                    ))}

                  {parts && <IncomePartCells parts={parts} />}
                  {/* có phần tách: chỉ HĐ tháng đầu còn mô tả + chi tiết, xuống dòng dưới các cột */}
                  {showMain && <div className={`ph-row__main${parts ? " ph-row__main--below" : ""}`}
                    style={parts ? { ...spanBelow, gridRow: 2 } : table ? spanCells : undefined}>
                    <div className="ph-row__desc">
                      {displayDescription(r, side)}
                      {fd && <span className="ph-inline ph-inline--first">HĐ tháng đầu</span>}
                      {r.isMissingInvoice && <span className="ph-inline ph-inline--alert">Còn hợp đồng</span>}
                      {r.isMissingExpense && <span className="ph-inline ph-inline--soft"> (chưa có phiếu)</span>}
                      {r.groupCount && r.groupCount > 1 && (
                        <span className="ph-inline ph-inline--soft"> ({r.groupCount} lần)</span>
                      )}
                      {r.notKqkd && <span className="ph-inline ph-inline--soft"> (không KQKD)</span>}
                    </div>

                    {sub.length > 0 && <div className="ph-row__sub">{sub.join(" · ")}</div>}

                    {fd && (
                      // HĐ tháng đầu (ký HĐ): kỳ tiền phòng + đã thu/tổng của HĐ
                      // và của cọc; số "đã thu" tô xanh khi đủ, đỏ khi thiếu.
                      <>
                        {(fd.rentFrom || fd.rentTo) && (
                          <div className="ph-row__detail">
                            Kỳ phòng: {fmtDay(fd.rentFrom)} → {fmtDay(fd.rentTo)}
                          </div>
                        )}
                        {/* rentServiceTotal = tiền phòng + dịch vụ (đã trừ giảm trừ),
                            KHÔNG gồm cọc — cọc là phiếu thu riêng. */}
                        <div className="ph-row__detail">
                          Tiền Phòng + DV: đã thu{" "}
                          <b className={invFull ? "ph-money-ok" : "ph-money-bad"}>
                            {fmtCompact(fd.rentServicePaid)}
                          </b>{" "}
                          / {fmtCompact(fd.rentServiceTotal)}
                        </div>
                        {fd.depositTotal > 0 && (
                          <div className="ph-row__detail">
                            Cọc: đã đóng{" "}
                            <b className={depFull ? "ph-money-ok" : "ph-money-bad"}>
                              {fmtCompact(fd.depositPaid)}
                            </b>{" "}
                            / {fmtCompact(fd.depositTotal)}
                            {fd.depositInInvoice > 0 && ` (${fmtCompact(fd.depositInInvoice)} trong HĐ)`}
                          </div>
                        )}
                      </>
                    )}
                    {/* HĐ không đủ ngày mà KHÔNG phải HĐ tháng đầu (fd) → vẫn ghi
                        chú kỳ tiền phòng để thấy khách chỉ ở 1 đoạn trong tháng. */}
                    {!fd && rp && (
                      <div className="ph-row__detail">
                        Tiền phòng tính từ: {fmtDay(rp.rentFrom)} → {fmtDay(rp.rentTo)}
                      </div>
                    )}
                  </div>}

                  {r.isMissingExpense && canCreate ? (
                    <div style={{ textAlign: "right" }}>
                      <span className="ph-row__cta">＋ Tạo phiếu chi</span>
                    </div>
                  ) : (
                    <div className={`ph-row__amt${r.isNote ? " ph-row__amt--none" : ""}`}>
                      {r.isNote ? (
                        "—"
                      ) : clickable ? (
                        // Bấm số tiền → các lần thu (phiếu thu) — như nhấp đôi dòng.
                        <button
                          type="button"
                          className="ph-row__link"
                          onClick={(e) => {
                            e.stopPropagation();
                            openDetail(r.invoiceId!);
                          }}
                        >
                          {formatCurrency(r.amount)}
                        </button>
                      ) : (
                        formatCurrency(r.amount)
                      )}
                      {adjust && <div className="ph-row__note ph-row__note--adj" data-testid="profit-row-adjust">{adjust}</div>}
                      {note && (
                        <div
                          className={`ph-row__note ${
                            note.cls === "text-amber-600" ? "ph-row__note--short" : "ph-row__note--over"
                          }`}
                        >
                          {note.text}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {rows.length > 8 && (
          <div className="ph-panel__foot">{rows.length} dòng — cuộn để xem thêm</div>
        )}
      </div>
    );
  };

  const reportError = accrualMode ? accrualError : cashError;

  return (
    <>
      {!reportError && <>
      {/* ---- Phần đổ lên dải hero xanh (KPI · chip cảnh báo) ---- */}
      {!hideStatCards && (
        <ProfitHubSlot name="kpis">
          <div className="ph-kpi">
            <div className="ph-kpi__label">Doanh thu</div>
            {/* đang tải: khối xám, không hiện "0 ₫" như số thật */}
            <div className="ph-kpi__value ph-kpi__value--mint">
              {loading ? <span className="ph-kpi__skel animate-pulse" aria-hidden /> : formatCurrency(displayIncome)}
            </div>
            {!loading && (
              <div className="ph-kpi__sub">
                {incomeCount} khoản thu{buildingCount > 0 ? ` · ${buildingCount} tòa nhà` : ""}
              </div>
            )}
          </div>
          <div className="ph-op">−</div>
          <div className="ph-kpi">
            <div className="ph-kpi__label">Chi phí</div>
            <div className="ph-kpi__value ph-kpi__value--peach">
              {loading ? <span className="ph-kpi__skel animate-pulse" aria-hidden /> : formatCurrency(displayExpense)}
            </div>
            {!loading && (
              <div className="ph-kpi__sub">
                {expenseCount} khoản chi{displayIncome > 0 ? ` · ${expenseRatio}% doanh thu` : ""}
              </div>
            )}
          </div>
          <div className="ph-op">=</div>
          <div className="ph-kpi">
            <div className="ph-kpi__label">Lợi nhuận</div>
            {loading ? (
              <div className="ph-kpi__value ph-kpi__value--lg">
                <span className="ph-kpi__skel ph-kpi__skel--lg animate-pulse" aria-hidden />
              </div>
            ) : profitApplies ? (
              <>
                <div className="ph-kpi__row">
                  <div className="ph-kpi__value ph-kpi__value--lg">{formatCurrency(displayDiff)}</div>
                  {displayIncome > 0 && <div className="ph-pill-mint">Biên {marginPct}%</div>}
                </div>
                {ihomeLine.kind === "ready" && (
                  <div className="ph-kpi__ihome" data-testid="ihome-profit" title={ihomeLineTitle(ihomeLine)}>
                    Của iHome: <b>{formatCurrency(ihomeLine.profit)}</b>
                    {ihomeLine.provisional ? " · tạm tính" : ""}
                  </div>
                )}
                {ihomeLine.kind === "other-basis" && (
                  <div className="ph-kpi__ihome" data-testid="ihome-profit">
                    Của iHome: chỉ tính khi xem phân bổ theo kỳ, chỉ khoản tính KQKD
                  </div>
                )}
                {ihomeLine.kind === "error" && (
                  <button type="button" className="ph-kpi__ihome underline" onClick={ihomeLine.retry}>
                    Chưa tính được lợi nhuận của iHome — thử lại
                  </button>
                )}
                {momPct !== null && (
                  <div
                    className={`ph-kpi__sub ${momPct >= 0 ? "ph-kpi__sub--mint" : "ph-kpi__sub--peach"}`}
                    title="So phần đã duyệt, chỉ khoản tính KQKD — cùng cơ sở với cột 6 tháng"
                  >
                    {momPct >= 0 ? "▲ +" : "▼ "}
                    {momPct.toFixed(1).replace(".", ",")}% so với T{prevMonthLabel} (đã duyệt)
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="ph-kpi__value ph-kpi__value--lg">—</div>
                <div className="ph-kpi__sub">Đang lọc chỉ khoản {voucherType === "INCOME" ? "thu" : "chi"} — chọn "Tất cả" để xem lợi nhuận</div>
              </>
            )}
          </div>
          <div className="ph-kpi__div ph-kpi__div--push" />
          <div className="ph-kpi ph-kpi__grow">
            <div className="ph-kpi__label">Lợi nhuận 6 tháng gần nhất</div>
            <div className="ph-spark__bars">
              {profitSeries.map((p, i) => (
                <div
                  key={p.label}
                  className={`ph-spark__bar${
                    p.current ? " ph-spark__bar--cur" : i === 4 ? " ph-spark__bar--prev" : ""
                  }${p.value < 0 ? " ph-spark__bar--neg" : ""}`}
                  style={{ height: Math.max(4, Math.round((Math.abs(p.value) / sparkMax) * 62)) }}
                  title={`${p.label}: ${p.value < 0 ? "lỗ " : ""}${formatCurrency(p.value)} (đã duyệt, chỉ KQKD)`}
                >
                  {p.current && (
                    <div className={`ph-spark__cap${p.value < 0 ? " ph-spark__cap--neg" : ""}`}>
                      {p.value < 0 ? "−" : ""}{toMillions(Math.abs(p.value))}tr
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="ph-spark__labels">
              {profitSeries.map((p) => (
                <div key={p.label} className={`ph-spark__label${p.current ? " ph-spark__label--cur" : ""}`}>
                  {p.label}
                </div>
              ))}
            </div>
          </div>
        </ProfitHubSlot>
      )}

      <ProfitHubSlot name="chips">
        {/* Bộ dò chung (mọi toà trong phạm vi): chi cố định thiếu / có thể trùng, chờ duyệt quá 30
            ngày, phòng chưa có hoá đơn / có hoá đơn chưa thu, HĐ kết thúc chưa thanh lý, phòng trống. */}
        <ProfitReportChecks
          checks={profitChecks}
          roomSummary={roomSummary}
          onCreateExpense={canCreate ? openCreateFixedFee : undefined}
        />
        <ProfitPostLockNotice
          entries={postLock.entries}
          count={postLock.count}
          income={postLock.income}
          expense={postLock.expense}
        />
        {pendingInfo.count > 0 && (
          <span className="ph-chip">
            {pendingInfo.count} phiếu chờ duyệt · {toMillions(pendingInfo.income + pendingInfo.expense, 1)}tr
          </span>
        )}
        <button
          type="button"
          className={`ph-chip ph-chip--push ${
            verifyState === "OK"
              ? "ph-chip--ok"
              : verifyState === "ERROR" || verifyState === "UNAVAILABLE"
                ? "ph-chip--red"
                : "ph-chip--amber"
          }`}
          onClick={() =>
            document.getElementById("ph-verify")?.scrollIntoView({ behavior: "smooth", block: "center" })
          }
          title="Xem chi tiết thanh kiểm chứng"
        >
          {verifyState !== "OK" && <span className="ph-chip__dot" />}
          {/* F12: "khớp" chỉ chứng minh client khớp engine trên phần ĐÃ DUYỆT, không phải đã đủ phiếu */}
          {profitVerificationChipLabel(verifyState, verifiedAt)}
        </button>
      </ProfitHubSlot>

      </>}
      <div className="ph-stack">
        {/* Thanh công cụ: kỳ · toà · phòng · loại phiếu — cùng 1 hàng, hero chỉ còn số. */}
        <div className="ph-toolbar">
          <div className="ph-stepper ph-stepper--light">
            <button
              type="button"
              className="ph-stepper__btn"
              onClick={() => stepMonth(-1)}
              aria-label="Tháng trước"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <SearchableSelect
              value={monthStr}
              onValueChange={setMonthStr}
              className="ph-stepper__label ph-stepper__select"
              contentClassName="ph-dd"
              align="center"
              aria-label="Chọn tháng"
              options={monthOptions.map((m) => ({ value: m, label: `Tháng ${m.replace("-", "/")}` }))}
            />
            <button
              type="button"
              className="ph-stepper__btn"
              onClick={() => stepMonth(1)}
              aria-label="Tháng sau"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>

          <BuildingFilterSelect
            value={buildingIds}
            onChange={(ids) => setBuildingIds(ids)}
            buildings={buildingOptions}
            className="ph-control ph-control--wide"
            contentClassName="ph-dd"
            placeholder="Tất cả tòa nhà"
          />

          <SearchableSelect
            value={roomId}
            onValueChange={setRoomId}
            className="ph-control"
            contentClassName="ph-dd"
            placeholder="Chọn phòng"
            aria-label="Lọc phòng"
            options={[
              { value: 'all', label: 'Tất cả phòng' },
            ]}
          />

          <SearchableSelect
            value={voucherType}
            onValueChange={setVoucherType}
            className="ph-control"
            contentClassName="ph-dd"
            placeholder="Loại thu chi"
            aria-label="Lọc loại phiếu"
            options={[
              { value: 'all', label: 'Thu & Chi' },
              { value: 'INCOME', label: 'Chỉ khoản thu' },
              { value: 'EXPENSE', label: 'Chỉ khoản chi' },
            ]}
          />

          <div className="ph-toolbar__push">
            <div className="ph-switch">
              <Switch
                id="accrual-mode"
                checked={accrualMode}
                onCheckedChange={(v) => setAccrualMode(v)}
              />
              <Label htmlFor="accrual-mode" className="cursor-pointer font-medium" title="Chia đều số tiền của hạng mục ra các tháng trong kỳ áp dụng, thay vì ghi trọn vào ngày phiếu">
                Kỳ phân bổ
              </Label>
            </div>

            <div className="ph-switch">
              <Switch id="pnl-only" checked={pnlOnly} onCheckedChange={(v) => setPnlOnly(v)} />
              <Label htmlFor="pnl-only" className="cursor-pointer font-medium" title="Tắt để xem cả khoản KHÔNG hạch toán kết quả kinh doanh (tiền cọc, bút toán nội bộ…)">
                Chỉ KQKD
              </Label>
            </div>

            {/* Ẩn/hiện cột */}
            <Popover>
              <PopoverTrigger asChild>
                <Button className="ph-control ph-control--strong" aria-label="Hiển thị cột">
                  <LayoutGrid className="h-3.5 w-3.5" />
                  Cột ({visibleToggleCols.length}/{TOGGLE_COLUMNS.length})
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-56 p-3">
                <div className="text-sm font-medium mb-2">Hiển thị</div>
                <div className="space-y-1.5">
                  <Label
                    htmlFor="pd-show-stats"
                    className="flex items-center gap-2 py-1 px-1 rounded hover:bg-accent cursor-pointer text-sm font-normal"
                  >
                    <Checkbox
                      id="pd-show-stats"
                      checked={!hideStatCards}
                      onCheckedChange={() =>
                        setUiPref.mutate({ key: "pd_hideStatCards", value: !hideStatCards })
                      }
                    />
                    <span>Dải KPI trên đầu trang</span>
                  </Label>
                  <Label
                    htmlFor="pd-show-totals"
                    className="flex items-center gap-2 py-1 px-1 rounded hover:bg-accent cursor-pointer text-sm font-normal"
                  >
                    <Checkbox
                      id="pd-show-totals"
                      checked={!hideTotals}
                      onCheckedChange={() =>
                        setUiPref.mutate({ key: "pd_hideTotals", value: !hideTotals })
                      }
                    />
                    <span>Số tổng (thu/chi)</span>
                  </Label>
                  {hasSpecialTypes && (
                    <Label
                      htmlFor="pd-hide-special"
                      className="flex items-center gap-2 py-1 px-1 rounded hover:bg-accent cursor-pointer text-sm font-normal"
                    >
                      <Checkbox
                        id="pd-hide-special"
                        checked={hideSpecialTypes}
                        onCheckedChange={() =>
                          setUiPref.mutate({ key: "pd_hideSpecialTypes", value: !hideSpecialTypes })
                        }
                      />
                      <span>Ẩn hạng mục đặc biệt</span>
                    </Label>
                  )}
                </div>
                <div className="text-sm font-medium mb-2 mt-3 pt-2 border-t">Hiển thị cột</div>
                <div className="space-y-1.5">
                  {TOGGLE_COLUMNS.map((col) => (
                    <Label
                      key={col.key}
                      htmlFor={`pdcol-${col.key}`}
                      className="flex items-center gap-2 py-1 px-1 rounded hover:bg-accent cursor-pointer text-sm font-normal"
                    >
                      <Checkbox
                        id={`pdcol-${col.key}`}
                        checked={visible(col.key)}
                        onCheckedChange={() => toggleCol(col.key)}
                      />
                      <span>{col.label}</span>
                    </Label>
                  ))}
                </div>
                <div className="mt-3 pt-2 border-t flex justify-end">
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={resetCols}>
                    Đặt lại mặc định
                  </Button>
                </div>
              </PopoverContent>
            </Popover>

            {canCreate && (
              <button type="button" className="ph-btn-primary" onClick={openCreateExpense}>
                ＋ Tạo phiếu
              </button>
            )}
          </div>
        </div>

        {reportError ? (
          <div role="alert" className="rounded-lg border border-destructive/30 p-4">
            <p>Chưa tải đủ chi tiết phiếu. Chưa thể hiển thị số liệu báo cáo.</p>
            <Button variant="outline" className="mt-3" onClick={() => void (accrualMode ? retryAccrual() : retryCash())}>Thử lại</Button>
          </div>
        ) : <>
        {/* Chú thích màu nền dòng — đúng 5 trạng thái của sổ */}
        <div className="ph-legend">
          <span className="ph-legend__title">Chú thích:</span>
          <span className="ph-legend__item">
            <span className="ph-legend__sw" style={{ background: "#FEF6DE", border: "1px solid #F3DFA8" }} />
            Phòng trống / thanh lý
          </span>
          <span className="ph-legend__item">
            <span className="ph-legend__sw" style={{ background: "#FDECEC", border: "1px solid #F5C8C8" }} />
            Thiếu hoá đơn
          </span>
          <span className="ph-legend__item">
            <span className="ph-legend__sw" style={{ background: "#FFFBEB", border: "1px solid #F1D48A" }} />
            Chi cố định chưa có phiếu
          </span>
          <span className="ph-legend__item">
            <span className="ph-legend__sw" style={{ background: "#FDF0F3", border: "1px solid #F6CBD6" }} />
            HĐ tháng đầu còn thiếu
          </span>
          <span className="ph-legend__item">
            <span className="ph-legend__sw" style={{ background: "#F1FAF4", border: "1px solid #C8E8D3" }} />
            HĐ không đủ ngày / đã đủ
          </span>
          {(showThu || (showChi && canViewVoucher)) && (
            <span className="ph-legend__item ph-legend__hint">
              <MousePointerClick className="h-4 w-4" />
              {showThu ? "Bấm số phòng để xem vòng đời hợp đồng" : ""}
              {showThu && showChi && canViewVoucher ? " · bấm khoản chi để xem phiếu" : ""}
              {!showThu ? "Bấm khoản chi để xem phiếu" : ""}
            </span>
          )}
        </div>

        {/* Sổ 2 cột: Thu | Chi */}
        <div className={showThu && showChi ? "ph-grid-2" : undefined}>
          {showThu && renderPanel("income", "Khoản thu", displayIncome, shownIncomeRows, incomeView)}
          {showChi &&
            renderPanel(
              "expense",
              "Khoản chi",
              displayExpense,
              displayExpenseRows,
              expenseView,
              canCreate || (canEditBuildings && singleBuilding && !singleBuilding.is_virtual) ? (
                <>
                  {canCreate && (
                    <Button
                      className="ph-panel__act"
                      title={`Tạo phiếu chi tháng ${monthLabel}`}
                      aria-label="Tạo phiếu chi"
                      onClick={openCreateExpense}
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  )}
                  {canEditBuildings && singleBuilding && !singleBuilding.is_virtual && (
                    <Button
                      className="ph-panel__act"
                      title={`Cài đặt cảnh báo thiếu phiếu chi — ${singleBuilding.name}`}
                      aria-label="Cài đặt cảnh báo thiếu phiếu chi"
                      onClick={() => setMissingCfgOpen(true)}
                    >
                      <Settings2 className="h-4 w-4" />
                    </Button>
                  )}
                </>
              ) : undefined,
            )}
        </div>

        {/* B5: thanh kiểm chứng — desktop + mobile dùng chung. Chip "Kiểm chứng"
            trên hero là bản rút gọn của thanh này (bấm chip cuộn xuống đây).
            buildingIds: luôn là danh sách toà cụ thể của CÔNG TY đang chọn (scopeIds) —
            RPC kiểm chứng (fa engine, layer stats) là SECURITY DEFINER quét MỌI building
            user thấy, gồm cả org khác (V2-PRE-1: org DEMO lọt vào engine ⇒ lệch −17,3tr oan). */}
        <div className="ph-verify" id="ph-verify">
          <ProfitVerificationBar
            ym={ym}
            startDate={startDate}
            endDate={endDate}
            buildingIds={scopeIds}
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
            voucherType={voucherType === "INCOME" || voucherType === "EXPENSE" ? voucherType : "all"}
            accrualRows={accrualMode ? accrual?.rows : undefined}
            extraWarnings={checkWarnings}
            engineExclusions={accrualMode ? postLock.engineExclusions : undefined}
            pageLoading={loading}
            onStateChange={handleVerifyState}
          />
        </div>

        <div className="ph-hint">
          Tổng {incomeRows.filter((r) => !r.isNote).length + expenseRows.length} khoản
          {!accrualMode && (result?.totalCount ?? 0) > LIST_LIMIT && (
            <span style={{ color: "var(--ph-amber-d)", marginLeft: 4 }}>
              (hiển thị {LIST_LIMIT} đầu trên tổng {result?.totalCount} — số tổng ở thẻ vẫn đủ)
            </span>
          )}
        </div>
        </>}
      </div>

      {/* Bấm số tiền / nhấp đôi dòng thu theo HĐ → các lần thu (số tiền + ngày giờ) */}
      <PaymentsSummaryDialog
        open={detailOpen}
        onOpenChange={(v) => {
          setDetailOpen(v);
          if (!v) setDetailInvoiceId(null);
        }}
        invoice={detailInvoice ?? null}
      />

      {/* Bấm TÊN hoá đơn → chi tiết hoá đơn full-screen (như trang /invoices) */}
      <InvoiceDetailModal
        invoiceId={invoiceModal?.id ?? null}
        title={invoiceModal?.title}
        open={invoiceModalOpen}
        onOpenChange={(v) => {
          setInvoiceModalOpen(v);
          if (!v) setInvoiceModal(null);
        }}
      />

      {/* Nút + header Khoản chi / bấm dòng "chưa có phiếu" → tạo phiếu chi
          tại chỗ (kỳ item = tháng đang xem; lưu xong query tự refetch). */}
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

      {lifecycleRoom && (
        <Suspense fallback={null}>
          <RoomContractLifecycleDrawer
            key={lifecycleRoom.id}
            roomId={lifecycleRoom.id}
            roomName={lifecycleRoom.name}
            initialYear={yyyy || now.getFullYear()}
            alignAfter={lifecycleRoom.anchor}
            onClose={() => setLifecycleRoom(null)}
          />
        </Suspense>
      )}

      {/* Bấm khoản chi → hộp phiếu + Sửa (phiếu chờ duyệt) / Bổ sung chứng từ của Thu chi */}
      {voucherView && (
        <Suspense fallback={null}>
          <ProfitVoucherViewer
            key={voucherView}
            voucherId={voucherView}
            organizationId={selectedOrganizationId ?? null}
            onClose={closeVoucherView}
          />
        </Suspense>
      )}

      {/* Bánh răng header Chi → tắt/bật cảnh báo "chưa có phiếu" theo toà */}
      <MissingExpenseSettingsDialog
        open={missingCfgOpen}
        onOpenChange={setMissingCfgOpen}
        building={singleBuilding && !singleBuilding.is_virtual ? singleBuilding : null}
      />
    </>
  );
}
