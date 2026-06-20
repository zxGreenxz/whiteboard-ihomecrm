import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import MainLayout from "@/components/layout/MainLayout";
import { ChevronRight, DollarSign, LayoutGrid } from "lucide-react";
import {
  useIncomeExpenses,
  useIncomeExpenseStats,
  type IncomeExpenseFilters,
} from "@/hooks/useIncomeExpenses";
import { useInvoice, useInvoiceTotalsByIds, useFirstInvoiceDetails } from "@/hooks/useInvoices";
import PaymentsSummaryDialog from "@/components/invoices/PaymentsSummaryDialog";
import { useAccrualMonthReport } from "@/hooks/useAccrualReport";
import { formatPeriod } from "@/lib/monthPeriod";
import { useBuildings } from "@/hooks/useBuildings";
import { BuildingMultiSelect } from "@/components/buildings/BuildingMultiSelect";
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
  periodLabel: string;
  typeName: string;
  // Nhóm hạng mục (income_expense_types.category) — dùng sắp xếp ưu tiên cột Chi.
  category: string | null;
  amount: number;
  notKqkd: boolean;
  // Khoản THU sinh từ thanh toán hoá đơn: gộp các khoản cùng 1 HĐ thành 1 dòng.
  // invoiceId != null ⇒ dòng có thể nhấp đôi xem chi tiết + note thiếu/thừa.
  invoiceId?: string | null;
  // Số lần thu được gộp (>1 ⇒ hiện "(N lần)").
  groupCount?: number;
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

// So sánh tên phòng theo thứ tự TỰ NHIÊN (101 < 102 < 201…); phòng trống (null)
// dồn xuống cuối.
const compareRoom = (a: string | null, b: string | null): number => {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
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

// Thứ tự ƯU TIÊN hiển thị KHOẢN CHI: các hạng mục cố định hằng tháng nổi lên
// đầu sổ đúng thứ tự nghiệp vụ; phần còn lại giữ thứ tự cũ (phòng → mô tả) ở dưới.
// Khớp chủ yếu theo CATEGORY của loại thu chi (chuẩn hơn tên):
//   - "Vệ Sinh" và "Rác" tách riêng dù chung category "Vệ sinh".
//   - "vệ sinh máy lạnh"/"Vệ sinh máy giặt" (category Bảo Trì) KHÔNG lọt nhóm Vệ Sinh.
// Mỗi vị có thêm fallback theo TÊN để chịu được loại trùng bị thiếu category.
const EXPENSE_PRIORITY: ((cat: string, name: string) => boolean)[] = [
  (c, n) => c === "tien nha" || n.includes("tien nha"),          // 1. Tiền nhà
  (c, n) => c === "dien" || n.includes("tien dien"),             // 2. Điện
  (c, n) => c === "nuoc" || n.includes("tien nuoc"),             // 3. Nước
  (c, n) => c === "internet" || n.includes("internet"),          // 4. Internet
  (_c, n) => n.includes("quan ly"),                              // 5. Quản Lý (loại "văn phòng")
  (c, n) => c === "ve sinh" && !n.includes("rac"),               // 6. Vệ Sinh (trừ rác)
  (c, n) => c === "ca" || n.includes("cong an"),                 // 7. Công an
  (_c, n) => n.includes("rac"),                                  // 8. Rác
  (_c, n) => n.includes("thang may"),                            // 9. Bảo Trì Thang Máy
];

// Thứ hạng ưu tiên (0 = lên đầu). Không khớp hạng mục nào → xuống cuối.
const expenseRank = (r: DisplayRow): number => {
  const c = nrm(r.category);
  const n = nrm(r.typeName);
  for (let i = 0; i < EXPENSE_PRIORITY.length; i++) {
    if (EXPENSE_PRIORITY[i](c, n)) return i;
  }
  return EXPENSE_PRIORITY.length;
};

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

export default function ProfitDistributionReport() {
  const now = new Date();
  const [monthStr, setMonthStr] = useState<string>(format(now, "MM-yyyy"));
  // Lọc nhiều toà (nhóm theo khu vực trong BuildingMultiSelect). [] = tất cả.
  const [buildingIds, setBuildingIds] = useState<string[]>([]);
  const [roomId, setRoomId] = useState<string>("all");
  const [voucherType, setVoucherType] = useState<string>("all");
  // Mặc định: chỉ tính khoản CÓ hạch toán KQKD (loại tiền cọc & khoản
  // override không-KQKD). Bật toggle để xem cả khoản không hạch toán.
  const [pnlOnly, setPnlOnly] = useState<boolean>(true);
  // Ghi nhận: false = theo Ngày phiếu (voucher_date, hành vi cũ);
  // true = theo Kỳ phân bổ (accrual — chia đều số tiền item ra các tháng trong kỳ).
  // Mặc định BẬT — đúng tên trang "Phân bổ lợi nhuận"; tắt toggle để xem theo ngày phiếu.
  const [accrualMode, setAccrualMode] = useState<boolean>(true);
  // Người dùng tự ép ẩn/hiện 1 cột — ghi đè lên mặc định tự-suy-từ-bộ-lọc.
  // Trống = theo mặc định (nút "Đặt lại mặc định" xoá hết override).
  const [colOverrides, setColOverrides] = useState<Partial<Record<ColKey, boolean>>>({});

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
  const { data: result, isLoading } = useIncomeExpenses(filters, {
    page: 1,
    pageSize: LIST_LIMIT,
  });
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
  const displayIncome = accrualMode ? accrual?.totalIncome ?? 0 : stats?.totalIncome ?? 0;
  const displayExpense = accrualMode ? accrual?.totalExpense ?? 0 : stats?.totalExpense ?? 0;
  const displayDiff = accrualMode ? accrual?.difference ?? 0 : stats?.difference ?? 0;

  const loading = accrualMode ? accrualLoading : isLoading;

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
          periodLabel: formatPeriod(r.startDate, r.endDate) || "—",
          typeName: r.typeName || "—",
          category: r.category ?? null,
          notKqkd: r.countsInBusinessResult === false,
          monthLabel,
        };
        if (r.income > 0)
          rawInc.push({ ...base, key: r.itemId, amount: r.income, invoiceId: r.invoiceId ?? null });
        else if (r.expense > 0) exp.push({ ...base, key: r.itemId, amount: r.expense });
      }
    } else {
      for (const r of (result?.data ?? []) as any[]) {
        const base = {
          description: r.name ?? "",
          buildingName: r.building_name ?? "",
          roomName: r.room_name ?? null,
          periodLabel: "—",
          // Mặc định null — gán đúng category theo từng item bên dưới (cột Chi).
          category: null as string | null,
          notKqkd: r.counts_in_business_result === false,
          monthLabel: format(new Date(r.voucher_date), "MM/yyyy"),
        };
        const items = (r.items || []) as any[];

        // CHỈ phiếu thu tiền nhà hằng tháng (gắn hoá đơn) mới giữ nguyên 1
        // dòng/phiếu để gộp theo hoá đơn ở bước sau.
        if (r.type === "INCOME" && r.invoice_id) {
          const typeName =
            items.map((it) => it.type_name).filter(Boolean).join(", ") || "—";
          rawInc.push({
            ...base,
            key: r.id,
            typeName,
            amount: Number(r.total_amount),
            invoiceId: r.invoice_id,
          });
          continue;
        }

        // Phiếu thu/chi KHÁC → KHÔNG gộp, tách theo từng hạng mục (item).
        const rows =
          items.length > 0
            ? items.map((it) => {
                const amt = Number(it.amount);
                const safe = Number.isFinite(amt)
                  ? amt
                  : Number(it.quantity) * Number(it.unit_price) || 0;
                return {
                  ...base,
                  key: `${r.id}:${it.id}`,
                  typeName: it.type_name || "—",
                  category: it.category ?? null,
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

    // Gộp các khoản THU cùng 1 hoá đơn (invoice_id) thành 1 dòng tổng. Khoản
    // không gắn hoá đơn giữ nguyên từng dòng.
    const groups = new Map<string, DisplayRow[]>();
    const inc: DisplayRow[] = [];
    for (const r of rawInc) {
      if (r.invoiceId) {
        const g = groups.get(r.invoiceId);
        if (g) g.push(r);
        else groups.set(r.invoiceId, [r]);
      } else {
        inc.push(r);
      }
    }
    for (const [invoiceId, list] of groups) {
      if (list.length === 1) {
        inc.push({ ...list[0], groupCount: 1 });
      } else {
        inc.push({
          ...list[0],
          key: `inv-${invoiceId}`,
          amount: list.reduce((s, x) => s + x.amount, 0),
          notKqkd: list.some((x) => x.notKqkd),
          groupCount: list.length,
        });
      }
    }

    const sorter = (a: DisplayRow, b: DisplayRow) =>
      compareRoom(a.roomName, b.roomName) || a.description.localeCompare(b.description, "vi");
    inc.sort(sorter);
    // Cột Chi: hạng mục cố định (Tiền nhà → Điện → … → Thang máy) lên đầu,
    // trong cùng nhóm vẫn theo phòng → mô tả như cũ.
    exp.sort(
      (a, b) => expenseRank(a) - expenseRank(b) || sorter(a, b)
    );
    return { incomeRows: inc, expenseRows: exp };
  }, [accrualMode, accrual, result, monthLabel]);

  // Tổng/đã trả của các hoá đơn xuất hiện trong cột Thu → tính note thiếu/thừa.
  const invoiceIds = useMemo(
    () => Array.from(new Set(incomeRows.filter((r) => r.invoiceId).map((r) => r.invoiceId!))),
    [incomeRows]
  );
  const { data: invoiceTotals } = useInvoiceTotalsByIds(invoiceIds);
  // Chi tiết "hoá đơn tháng đầu" (HĐ tự sinh khi ký HĐ) cho các HĐ trong cột Thu:
  // kỳ tiền phòng + đã thu/tổng HĐ + cọc đã đóng/tổng. Chỉ trả về HĐ tháng đầu.
  const { data: firstInvoiceDetails } = useFirstInvoiceDetails(invoiceIds);

  // Chi tiết các lần thu của 1 hoá đơn (nhấp đôi vào dòng) — dùng lại dialog
  // "Các lần thanh toán" (hiện số tiền + ngày giờ từng lần).
  const [detailInvoiceId, setDetailInvoiceId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const { data: detailInvoice } = useInvoice(detailInvoiceId ?? undefined);
  const openDetail = (invoiceId: string) => {
    setDetailInvoiceId(invoiceId);
    setDetailOpen(true);
  };

  // Note "thiếu/thừa so với hoá đơn": so tổng khoản thu (đã gộp) với total HĐ.
  const noteFor = (row: DisplayRow): { text: string; cls: string } | null => {
    if (!row.invoiceId) return null;
    const inv = invoiceTotals?.get(row.invoiceId);
    if (!inv || !inv.total_amount) return null;
    const diff = Math.round(row.amount - inv.total_amount);
    if (diff <= -1) return { text: `thiếu ${formatCurrency(-diff)}`, cls: "text-amber-600" };
    if (diff >= 1) return { text: `thừa ${formatCurrency(diff)}`, cls: "text-rose-600" };
    return null;
  };

  // Mặc định ẩn/hiện cột: ẩn cột mà MỌI dòng (gộp cả 2 bên để 2 bảng đồng cột)
  // có cùng giá trị — tức cột đã bị bộ lọc ghim (tháng/toà/phòng/kỳ…).
  const autoVisible = useMemo(() => {
    const all = [...incomeRows, ...expenseRows];
    const m = {} as Record<ColKey, boolean>;
    for (const c of TOGGLE_COLUMNS) m[c.key] = !allSame(all, COL_VALUE[c.key]);
    return m;
  }, [incomeRows, expenseRows]);

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
  ) => (
    <div className="rounded-md border flex flex-col min-w-0">
      <div className={`flex items-center justify-between gap-2 px-4 py-2.5 border-b ${accentHeader}`}>
        <div className="flex items-center gap-2">
          <span className="font-medium">{title}</span>
          <span className="text-xs text-muted-foreground">{data.length} khoản</span>
        </div>
        <span className={`font-semibold ${accentText}`}>{formatCurrency(total)}</span>
      </div>
      <div className="overflow-auto max-h-[60vh]">
        <Table>
          <TableHeader>
            <TableRow>
              {visible("thang") && <TableHead className="whitespace-nowrap">Tháng</TableHead>}
              <TableHead>Mô tả</TableHead>
              {visible("toa_nha") && <TableHead>Tòa nhà</TableHead>}
              {visible("phong") && <TableHead>Phòng</TableHead>}
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
                const fd = r.invoiceId ? firstInvoiceDetails?.get(r.invoiceId) : null;
                const invFull = fd ? fd.rentServiceTotal - fd.rentServicePaid < 1 : false;
                const depFull = fd ? fd.depositTotal - fd.depositPaid < 1 : false;
                const firstFull = invFull && depFull;
                const rowClass = fd
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
                    onDoubleClick={clickable ? () => openDetail(r.invoiceId!) : undefined}
                    title={clickable ? "Nhấp đôi để xem các lần thu của hoá đơn này" : undefined}
                  >
                    {visible("thang") && <TableCell className="whitespace-nowrap">{r.monthLabel}</TableCell>}
                    <TableCell>
                      {r.description}
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
                    </TableCell>
                    {visible("toa_nha") && <TableCell>{r.buildingName || "—"}</TableCell>}
                    {visible("phong") && <TableCell>{r.roomName || "—"}</TableCell>}
                    {visible("ky") && (
                      <TableCell className="whitespace-nowrap">{r.periodLabel}</TableCell>
                    )}
                    {visible("phan_loai") && <TableCell>{r.typeName}</TableCell>}
                    <TableCell className={`text-right whitespace-nowrap font-medium ${accentText}`}>
                      {formatCurrency(r.amount)}
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
    <MainLayout>
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link to="/reports/finance" className="hover:text-primary">
            Báo cáo tài chính
          </Link>
          <ChevronRight className="h-4 w-4" />
          <span className="text-foreground font-medium">Phân bổ lợi nhuận</span>
        </div>

        {/* 3 Stat cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <StatCard label="Doanh thu" value={displayIncome} ring="ring-1 ring-emerald-200" bg="bg-emerald-100 text-emerald-700" />
          <StatCard label="Chi phí" value={displayExpense} ring="ring-1 ring-orange-200" bg="bg-orange-100 text-orange-700" />
          <StatCard label="Lợi nhuận" value={displayDiff} ring="ring-1 ring-blue-200" bg="bg-blue-100 text-blue-700" />
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-end gap-3">
          <SearchableSelect
            value={monthStr}
            onValueChange={setMonthStr}
            className="w-[140px]"
            options={monthOptions.map((m) => ({ value: m, label: m }))}
          />

          <BuildingMultiSelect
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
                <div className="text-sm font-medium mb-2">Hiển thị cột</div>
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
          {showThu && renderPanel("Khoản thu", "Doanh thu", displayIncome, incomeRows, "text-emerald-700", "bg-emerald-50")}
          {showChi && renderPanel("Khoản chi", "Chi phí", displayExpense, expenseRows, "text-orange-700", "bg-orange-50")}
        </div>

        <div className="text-sm text-muted-foreground">
          Tổng {incomeRows.length + expenseRows.length} khoản
          {!accrualMode && (result?.totalCount ?? 0) > LIST_LIMIT && (
            <span className="ml-1 text-amber-600">
              (hiển thị {LIST_LIMIT} đầu trên tổng {result?.totalCount} — số tổng ở thẻ vẫn đủ)
            </span>
          )}
        </div>
      </div>

      {/* Nhấp đôi dòng thu theo HĐ → chi tiết các lần thu (số tiền + ngày giờ) */}
      <PaymentsSummaryDialog
        open={detailOpen}
        onOpenChange={(v) => {
          setDetailOpen(v);
          if (!v) setDetailInvoiceId(null);
        }}
        invoice={detailInvoice ?? null}
      />
    </MainLayout>
  );
}
