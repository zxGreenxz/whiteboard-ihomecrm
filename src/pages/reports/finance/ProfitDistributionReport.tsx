import { useState, useMemo, type ReactNode } from "react";
import { DollarSign, LayoutGrid, Plus, Settings2 } from "lucide-react";
import { usePhoneViewport } from "@/hooks/use-mobile";
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
import { toast } from "sonner";
import ProfitVerificationBar from "@/components/reports/ProfitVerificationBar";
import { useAccrualMonthReport } from "@/hooks/useAccrualReport";
import { useUiPrefBool, useSetUiPreference } from "@/hooks/useUiPreferences";
import { useHiddenInReportTypes, useIncomeExpenseTypes } from "@/hooks/useIncomeExpenseTypes";
import { useVacantRoomNotes } from "@/hooks/useReports";
import { VACANCY_FALLBACK_REASON } from "@/lib/vacancyReason";
import { compareRoomNames } from "@/lib/roomSort";
import { formatPeriod } from "@/lib/monthPeriod";
import {
  FIXED_EXPENSE_CATEGORIES,
  expenseRankOf,
  findTypeForFixedCategory,
} from "@/lib/fixedExpenseCategories";
import { useBuildings } from "@/hooks/useBuildings";
import { BuildingFilterSelect } from "@/components/buildings/BuildingFilterSelect";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import { format, startOfMonth, endOfMonth } from "date-fns";

const formatCurrency = (n: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(n);

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

const StatCard = ({
  label,
  value,
  bg,
  ring,
}: {
  label: string;
  value: number;
  bg: string;
  ring: string;
}) => (
  <div className="flex-1 rounded-lg border bg-card p-4 flex items-center justify-between">
    <div className={`h-12 w-12 rounded-full ${ring} flex items-center justify-center ${bg}`}>
      <DollarSign className="h-6 w-6" />
    </div>
    <div className="text-right">
      <div className="text-2xl font-bold">{formatCurrency(value)}</div>
      <div className="text-sm text-muted-foreground">{label}</div>
    </div>
  </div>
);

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
  // Loại CHI trong DB — resolve dòng "chưa có phiếu" (hạng mục cố định) → đúng
  // income_expense_type_id để prefill form. Chỉ fetch khi có quyền tạo.
  const { data: expenseTypes = [] } = useIncomeExpenseTypes("expense", { enabled: canCreate });

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
  const { data: buildings = [] } = useBuildings({ includeVirtual: true });
  const buildingOptions = useMemo(
    () =>
      (buildings as any[]).map((b) => ({
        id: b.id,
        name: b.name,
        area_ids: b.area_ids ?? [],
      })),
    [buildings]
  );

  const buildingFilter = buildingIds.length > 0 ? buildingIds : undefined;
  const filters: IncomeExpenseFilters = {
    building_ids: buildingFilter,
    room_id: roomId === "all" ? undefined : roomId,
    type: voucherType === "all" ? undefined : (voucherType as any),
    start_date: startDate,
    end_date: endDate,
    approval_status: "APPROVED",
    business_result_only: pnlOnly,
  };

  // Sổ 2 cột hiển thị TẤT CẢ khoản trong tháng → fetch 1 trang lớn (không phân trang).
  // enabled: chế độ DỒN TÍCH (mặc định) lấy rows từ accrual — list tiền mặt
  // 1000 dòng + items chỉ được đọc ở nhánh !accrualMode (kể cả capWarning),
  // fetch sẵn chỉ tổ nghẽn pool mỗi lần đổi toà/kỳ.
  const { data: result, isLoading } = useIncomeExpenses(
    filters,
    {
      page: 1,
      pageSize: LIST_LIMIT,
    },
    undefined,
    { enabled: !accrualMode }
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
  const { data: accrual, isLoading: accrualLoading } = useAccrualMonthReport(
    accrualMode ? ym : "",
    filters,
    { businessResultOnly: pnlOnly }
  );

  // Giá trị 3 thẻ + tổng mỗi bên theo chế độ ghi nhận.
  // Tiền mặt + "gồm cả khoản ngoài KQKD": tổng MỌI khoản (kể cả bút toán nội
  // bộ/chưa chọn sổ) — khớp danh sách bên dưới vốn không lọc lớp.
  const cashIncome = pnlOnly ? stats?.totalIncome ?? 0 : stats?.allIncome ?? stats?.totalIncome ?? 0;
  const cashExpense = pnlOnly ? stats?.totalExpense ?? 0 : stats?.allExpense ?? stats?.totalExpense ?? 0;
  const displayIncome = accrualMode ? accrual?.totalIncome ?? 0 : cashIncome;
  const displayExpense = accrualMode ? accrual?.totalExpense ?? 0 : cashExpense;
  const displayDiff = displayIncome - displayExpense;

  const loading = accrualMode ? accrualLoading : isLoading;

  // Phòng trống trong tháng (đầu cột Thu, nền vàng cam). Chỉ tính khi panel Thu
  // hiển thị, không lọc 1 phòng cụ thể, và đã chọn ≥1 toà (cần danh sách phòng
  // đầy đủ của toà).
  // B5: bật mặc định cả khi chưa chọn toà (hook tự quét mọi toà theo RLS).
  const vacancyEnabled = voucherType !== "EXPENSE" && roomId === "all";
  const { data: vacantNotes } = useVacantRoomNotes(buildingIds, endDate, vacancyEnabled);

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
    for (const r of inc) if (r.roomId) anyIncomeRooms.add(r.roomId);

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
    // Phòng gắn cờ KHÔNG có khoản thu nào trong tháng → dòng ghi chú thuần:
    //  - còn HĐ (kind 'active') → CẢNH BÁO đỏ "Chưa có hoá đơn".
    //  - trống thật (kind 'vacant') → ghi chú vàng cam "Trống phòng — <lý do>".
    for (const note of vacantNotes.values()) {
      if (anyIncomeRooms.has(note.roomId)) continue;
      if (note.kind === "active") {
        all.push({
          key: `missing-${note.roomId}`,
          monthLabel,
          description: "⚠️ Chưa có hoá đơn tháng này (còn hợp đồng)",
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
          description:
            !note.reason || note.reason === VACANCY_FALLBACK_REASON
              ? "Trống phòng"
              : `Trống phòng — ${note.reason}`,
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
  }, [accrualMode, accrual, result, monthLabel, vacantNotes, pnlOnly]);

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

  // Chèn dòng placeholder "chưa có phiếu" cho các hạng mục chi CỐ ĐỊNH còn thiếu.
  // CHỈ khi đang lọc đúng 1 toà và không lọc riêng 1 phòng (9 khoản này là chi phí
  // cố định theo TỪNG toà — "thiếu" chỉ rõ nghĩa trong ngữ cảnh 1 toà). Dòng
  // placeholder là ghi chú (isNote) nên KHÔNG ảnh hưởng tổng 3 thẻ / "X khoản".
  // Thang máy chỉ cảnh báo khi toà bật has_elevator.
  const displayExpenseRows = useMemo(() => {
    // Chỉ ở chế độ phân bổ theo kỳ (accrual) — chế độ tiền mặt gom theo NGÀY PHIẾU
    // nên phiếu tháng lân cận bị lệch tháng → dò thiếu không tin cậy (đồng bộ mobile).
    if (loading || voucherType === "INCOME" || !accrualMode) return shownExpenseRows;
    // Bỏ qua TOÀ ẢO "Chung" (bucket chia LN cổ đông) — không phải toà vật lý, không
    // bao giờ có phiếu Tiền nhà/Điện/… nên đừng báo thiếu nhầm.
    if (!singleBuilding || singleBuilding.is_virtual || roomId !== "all") return shownExpenseRows;
    // Dò "đã có phiếu" trên DANH SÁCH ĐẦY ĐỦ (expenseRows) — kể cả hạng mục đang
    // bị ẩn bởi "Ẩn hạng mục đặc biệt" — để không báo thiếu nhầm khi nó đã có.
    const present = new Set<number>();
    for (const r of expenseRows)
      if (!r.isNote) present.add(expenseRankOf(r.category, r.typeName, r.description));
    // Hạng mục toà này TẮT cảnh báo (buildings.hidden_fixed_expenses — vd toà
    // xài nước giếng tắt Nước) → không sinh dòng vàng.
    const hiddenFixed = new Set<string>(
      (singleBuilding.hidden_fixed_expenses as string[] | null) ?? []
    );
    const missing: DisplayRow[] = [];
    FIXED_EXPENSE_CATEGORIES.forEach((cat, i) => {
      if (present.has(i)) return;
      if (cat.requiresElevator && !singleBuilding.has_elevator) return;
      if (hiddenFixed.has(cat.key)) return;
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
    });
    if (missing.length === 0) return shownExpenseRows;
    return [...shownExpenseRows, ...missing].sort(
      (a, b) =>
        expenseRankOf(a.category, a.typeName, a.description, a.fixedRank) -
          expenseRankOf(b.category, b.typeName, b.description, b.fixedRank) ||
        compareRoom(a.roomName, b.roomName) ||
        a.description.localeCompare(b.description, "vi")
    );
  }, [shownExpenseRows, expenseRows, loading, voucherType, accrualMode, singleBuilding, roomId, monthLabel]);

  // B5: số liệu cho thanh kiểm chứng — Σ dòng hiển thị vs tổng thẻ.
  const sumRows = (rows: DisplayRow[]) =>
    rows.reduce((s, r) => (r.isNote ? s : s + r.amount), 0);
  const shownIncomeSum = useMemo(() => sumRows(shownIncomeRows), [shownIncomeRows]);
  const shownExpenseSum = useMemo(() => sumRows(shownExpenseRows), [shownExpenseRows]);
  const hiddenSum =
    sumRows(incomeRows) + sumRows(expenseRows) - shownIncomeSum - shownExpenseSum;
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
  const displayDescription = (r: DisplayRow): string => {
    if (nrm(`${r.typeName} ${r.description}`).includes("thanh ly")) return "HĐ Thanh Lý Hợp Đồng";
    const invTitle = r.invoiceId ? invoiceTotals?.get(r.invoiceId)?.displayTitle : undefined;
    if (invTitle) return invTitle;
    if (nrm(r.description).includes("thu tien theo hd tien phong"))
      return `Hóa Đơn Tiền Phòng T${mm || 1}`;
    return r.description;
  };

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
  const colCount = visibleToggleCols.length + 2; // Mô tả + cột số tiền

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

  const renderPanel = (
    title: string,
    amountLabel: string,
    total: number,
    data: DisplayRow[],
    accentText: string,
    accentHeader: string,
    headerAction?: ReactNode,
  ) => (
    <div className="rounded-md border flex flex-col min-w-0">
      <div className={`flex items-center justify-between gap-2 px-4 py-2.5 border-b ${accentHeader}`}>
        <div className="flex items-center gap-2">
          <span className="font-medium">{title}</span>
          <span className="text-xs text-muted-foreground">
            {data.filter((r) => !r.isNote).length} khoản
          </span>
          {headerAction}
        </div>
        {!hideTotals && (
          <span className={`font-semibold ${accentText}`}>{formatCurrency(total)}</span>
        )}
      </div>
      <div className="overflow-auto max-h-[60vh]">
        <Table>
          <TableHeader>
            <TableRow>
              {visible("thang") && <TableHead className="whitespace-nowrap">Tháng</TableHead>}
              <TableHead>Mô tả</TableHead>
              {visible("toa_nha") && <TableHead>Tòa nhà</TableHead>}
              {visible("phong") && <TableHead className="font-semibold">Phòng</TableHead>}
              {visible("ky") && <TableHead className="whitespace-nowrap">Kỳ</TableHead>}
              {visible("phan_loai") && <TableHead>Phân loại</TableHead>}
              <TableHead className="text-right whitespace-nowrap">{amountLabel}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={colCount}><Skeleton className="h-6 w-full" /></TableCell>
                </TableRow>
              ))
            ) : data.length === 0 ? (
              <TableRow>
                <TableCell colSpan={colCount} className="text-center py-8 text-muted-foreground">
                  Không có khoản nào
                </TableCell>
              </TableRow>
            ) : (
              data.map((r) => {
                const clickable = !!r.invoiceId;
                const note = noteFor(r);
                // HĐ tháng đầu: tô NỀN NHẠT cả dòng theo trạng thái — xanh khi HĐ
                // & cọc đều đủ, đỏ khi còn thiếu (dung sai 1đ cho làm tròn).
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
                // → HĐ tháng đầu (xanh đậm/đỏ theo đã trả).
                const rowClass = r.isMissingExpense
                  ? `bg-amber-50 hover:bg-amber-100${canCreate ? " cursor-pointer select-none" : ""}`
                  : r.isMissingInvoice
                  ? "bg-red-100 hover:bg-red-200"
                  : r.isVacant
                  ? `${clickable ? "cursor-pointer select-none " : ""}bg-amber-100 hover:bg-amber-200`
                  : rp
                    ? `${clickable ? "cursor-pointer select-none " : ""}bg-green-50 hover:bg-green-100`
                    : fd
                      ? `${clickable ? "cursor-pointer select-none " : ""}${
                          firstFull
                            ? "bg-emerald-50 hover:bg-emerald-100"
                            : "bg-rose-50 hover:bg-rose-100"
                        }`
                      : clickable
                        ? "cursor-pointer select-none hover:bg-muted/50"
                        : undefined;
                return (
                  <TableRow
                    key={r.key}
                    className={rowClass}
                    onClick={
                      r.isMissingExpense && canCreate
                        ? () => openCreateMissingExpense(r)
                        : undefined
                    }
                    onDoubleClick={clickable ? () => openDetail(r.invoiceId!) : undefined}
                    title={
                      r.isMissingExpense && canCreate
                        ? "Bấm để tạo phiếu chi cho hạng mục này"
                        : clickable
                          ? "Bấm tên hoá đơn: xem chi tiết hoá đơn · bấm số tiền: xem các lần thu"
                          : undefined
                    }
                  >
                    {visible("thang") && <TableCell className="whitespace-nowrap">{r.monthLabel}</TableCell>}
                    <TableCell>
                      {clickable ? (
                        // Bấm tên HĐ → chi tiết hoá đơn (như trang /invoices).
                        <button
                          type="button"
                          className="text-left hover:underline underline-offset-2 hover:text-emerald-700"
                          onClick={(e) => {
                            e.stopPropagation();
                            openInvoiceModal(
                              r.invoiceId!,
                              displayDescription(r) + (r.roomName ? ` — ${r.roomName}` : "")
                            );
                          }}
                        >
                          {displayDescription(r)}
                        </button>
                      ) : (
                        displayDescription(r)
                      )}
                      {r.isMissingExpense && (
                        <span className="ml-1 text-xs font-medium text-amber-600">(chưa có phiếu)</span>
                      )}
                      {r.groupCount && r.groupCount > 1 && (
                        <span className="ml-1 text-xs text-muted-foreground">({r.groupCount} lần)</span>
                      )}
                      {r.notKqkd && (
                        <span className="ml-1 text-xs text-amber-600">(không KQKD)</span>
                      )}
                      {fd && (
                        // HĐ tháng đầu (ký HĐ): kỳ tiền phòng + đã thu/tổng của HĐ
                        // và của cọc; số "đã thu" tô xanh khi đủ, đỏ khi thiếu.
                        <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                          {(fd.rentFrom || fd.rentTo) && (
                            <div>
                              <span className="text-foreground/70">Kỳ phòng:</span>{" "}
                              {fmtDay(fd.rentFrom)} → {fmtDay(fd.rentTo)}
                            </div>
                          )}
                          <div>
                            {/* invoiceTotal = tiền phòng + dịch vụ (đã trừ giảm
                                trừ), KHÔNG gồm cọc — cọc là phiếu thu riêng. */}
                            <span className="text-foreground/70">Tiền Phòng + Dịch Vụ:</span>{" "}
                            đã thu{" "}
                            <span className={`font-medium ${invFull ? "text-emerald-600" : "text-rose-600"}`}>
                              {fmtCompact(fd.rentServicePaid)}
                            </span>{" "}
                            / {fmtCompact(fd.rentServiceTotal)}
                          </div>
                          {fd.depositTotal > 0 && (
                            <div>
                              <span className="text-foreground/70">Cọc:</span>{" "}
                              đã đóng{" "}
                              <span className={`font-medium ${depFull ? "text-emerald-600" : "text-rose-600"}`}>
                                {fmtCompact(fd.depositPaid)}
                              </span>{" "}
                              / {fmtCompact(fd.depositTotal)}
                              {fd.depositInInvoice > 0 && (
                                <span> ({fmtCompact(fd.depositInInvoice)} trong HĐ)</span>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                      {/* HĐ không đủ ngày mà KHÔNG phải HĐ tháng đầu (fd) → vẫn ghi
                          chú kỳ tiền phòng để thấy khách chỉ ở 1 đoạn trong tháng. */}
                      {!fd && rp && (
                        <div className="mt-1 text-xs text-emerald-700">
                          <span className="text-foreground/70">Tiền phòng tính từ:</span>{" "}
                          {fmtDay(rp.rentFrom)} → {fmtDay(rp.rentTo)}
                        </div>
                      )}
                    </TableCell>
                    {visible("toa_nha") && <TableCell>{r.buildingName || "—"}</TableCell>}
                    {visible("phong") && (
                      <TableCell className="font-semibold">{r.roomName || "—"}</TableCell>
                    )}
                    {visible("ky") && (
                      <TableCell className="whitespace-nowrap">{r.periodLabel}</TableCell>
                    )}
                    {visible("phan_loai") && <TableCell>{r.typeName}</TableCell>}
                    <TableCell className={`text-right whitespace-nowrap font-medium ${accentText}`}>
                      {r.isNote ? (
                        "—"
                      ) : clickable ? (
                        // Bấm số tiền → các lần thu (phiếu thu) — như nhấp đôi dòng.
                        <button
                          type="button"
                          className="hover:underline underline-offset-2"
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
                      {note && <div className={`text-xs font-normal ${note.cls}`}>{note.text}</div>}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );

  return (
    <>
      <div className="space-y-4">
        {/* 3 Stat cards — có thể ẩn qua popover "Cột" (lưu server) */}
        {!hideStatCards && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <StatCard label="Doanh thu" value={displayIncome} ring="ring-1 ring-emerald-200" bg="bg-emerald-100 text-emerald-700" />
            <StatCard label="Chi phí" value={displayExpense} ring="ring-1 ring-orange-200" bg="bg-orange-100 text-orange-700" />
            <StatCard label="Lợi nhuận" value={displayDiff} ring="ring-1 ring-blue-200" bg="bg-blue-100 text-blue-700" />
          </div>
        )}

        {/* B5: thanh kiểm chứng — desktop + mobile dùng chung */}
        <ProfitVerificationBar
          ym={ym}
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
          hiddenSum={hiddenSum}
          capWarning={capWarning}
        />

        {/* Filters */}
        <div className="flex flex-wrap items-end gap-3">
          <SearchableSelect
            value={monthStr}
            onValueChange={setMonthStr}
            className="w-[140px]"
            options={monthOptions.map((m) => ({ value: m, label: m }))}
          />

          <BuildingFilterSelect
            value={buildingIds}
            onChange={(ids) => setBuildingIds(ids)}
            buildings={buildingOptions}
            className="w-[260px]"
            placeholder="Tất cả toà nhà"
          />

          <SearchableSelect
            value={roomId}
            onValueChange={setRoomId}
            className="w-[160px]"
            placeholder="Chọn phòng"
            options={[
              { value: 'all', label: 'Tất cả phòng' },
            ]}
          />

          <SearchableSelect
            value={voucherType}
            onValueChange={setVoucherType}
            className="w-[180px]"
            placeholder="Loại thu chi"
            options={[
              { value: 'all', label: 'Tất cả loại' },
              { value: 'INCOME', label: 'Thu' },
              { value: 'EXPENSE', label: 'Chi' },
            ]}
          />

          <div className="flex items-center gap-2 h-9">
            <Switch
              id="pnl-only"
              checked={!pnlOnly}
              onCheckedChange={(v) => setPnlOnly(!v)}
            />
            <Label htmlFor="pnl-only" className="text-sm text-muted-foreground whitespace-nowrap">
              Hiện cả khoản không hạch toán KQKD (cọc…)
            </Label>
          </div>

          <div className="flex items-center gap-2 h-9">
            <Switch
              id="accrual-mode"
              checked={accrualMode}
              onCheckedChange={(v) => setAccrualMode(v)}
            />
            <Label htmlFor="accrual-mode" className="text-sm text-muted-foreground whitespace-nowrap">
              Phân bổ theo kỳ áp dụng
            </Label>
          </div>

          {/* Ẩn/hiện cột */}
          <div className="ml-auto">
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-9 gap-2" aria-label="Hiển thị cột">
                  <LayoutGrid className="h-4 w-4" />
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
                    <span>Thẻ thống kê</span>
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
          </div>
        </div>

        {/* Sổ 2 cột: Thu | Chi */}
        <div className={`grid gap-4 ${showThu && showChi ? "grid-cols-1 lg:grid-cols-2" : "grid-cols-1"}`}>
          {showThu && renderPanel("Khoản thu", "Doanh thu", displayIncome, shownIncomeRows, "text-emerald-700", "bg-emerald-50")}
          {showChi &&
            renderPanel(
              "Khoản chi",
              "Chi phí",
              displayExpense,
              displayExpenseRows,
              "text-orange-700",
              "bg-orange-50",
              canCreate || (canEditBuildings && singleBuilding && !singleBuilding.is_virtual) ? (
                <>
                  {canCreate && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-orange-700 hover:bg-orange-100"
                      title={`Tạo phiếu chi tháng ${monthLabel}`}
                      aria-label="Tạo phiếu chi"
                      onClick={openCreateExpense}
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  )}
                  {canEditBuildings && singleBuilding && !singleBuilding.is_virtual && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-orange-700 hover:bg-orange-100"
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

        <div className="text-sm text-muted-foreground">
          Tổng {incomeRows.filter((r) => !r.isNote).length + expenseRows.length} khoản
          {!accrualMode && (result?.totalCount ?? 0) > LIST_LIMIT && (
            <span className="ml-1 text-amber-600">
              (hiển thị {LIST_LIMIT} đầu trên tổng {result?.totalCount} — số tổng ở thẻ vẫn đủ)
            </span>
          )}
        </div>
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

      {/* Bánh răng header Chi → tắt/bật cảnh báo "chưa có phiếu" theo toà */}
      <MissingExpenseSettingsDialog
        open={missingCfgOpen}
        onOpenChange={setMissingCfgOpen}
        building={singleBuilding && !singleBuilding.is_virtual ? singleBuilding : null}
      />
    </>
  );
}
