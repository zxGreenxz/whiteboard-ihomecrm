import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import MainLayout from "@/components/layout/MainLayout";
import { ChevronRight, DollarSign } from "lucide-react";
import {
  useIncomeExpenses,
  useIncomeExpenseStats,
  type IncomeExpenseFilters,
} from "@/hooks/useIncomeExpenses";
import { useAccrualMonthReport } from "@/hooks/useAccrualReport";
import { formatPeriod } from "@/lib/monthPeriod";
import { useBuildings } from "@/hooks/useBuildings";
import { BuildingMultiSelect } from "@/components/buildings/BuildingMultiSelect";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { format, startOfMonth, endOfMonth } from "date-fns";

const formatCurrency = (n: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(n);

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
  const [accrualMode, setAccrualMode] = useState<boolean>(false);
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(10);

  // Parse monthStr "MM-yyyy" → start/end date + 'YYYY-MM'
  const [mm, yyyy] = monthStr.split("-").map((s) => parseInt(s, 10));
  const monthDate = new Date(yyyy, (mm || 1) - 1, 1);
  const startDate = format(startOfMonth(monthDate), "yyyy-MM-dd");
  const endDate = format(endOfMonth(monthDate), "yyyy-MM-dd");
  const ym = `${yyyy}-${String(mm || 1).padStart(2, "0")}`;

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

  const { data: result, isLoading } = useIncomeExpenses(filters, { page, pageSize });
  // Tổng 3 thẻ tính trên TOÀN BỘ dữ liệu khớp filter (không phụ thuộc phân trang).
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

  // Giá trị 3 thẻ + bảng theo chế độ ghi nhận.
  const displayIncome = accrualMode ? accrual?.totalIncome ?? 0 : stats?.totalIncome ?? 0;
  const displayExpense = accrualMode ? accrual?.totalExpense ?? 0 : stats?.totalExpense ?? 0;
  const displayDiff = accrualMode ? accrual?.difference ?? 0 : stats?.difference ?? 0;

  const accrualRows = accrual?.rows ?? [];
  const rows = accrualMode
    ? accrualRows.slice((page - 1) * pageSize, page * pageSize)
    : result?.data ?? [];
  const totalCount = accrualMode ? accrualRows.length : result?.totalCount ?? 0;
  const loading = accrualMode ? accrualLoading : isLoading;

  const monthOptions = useMemo(() => {
    const out: string[] = [];
    const d = new Date();
    for (let i = 0; i < 24; i++) {
      const dt = new Date(d.getFullYear(), d.getMonth() - i, 1);
      out.push(format(dt, "MM-yyyy"));
    }
    return out;
  }, []);

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
            onChange={(ids) => {
              setBuildingIds(ids);
              setPage(1);
            }}
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
              onCheckedChange={(v) => {
                setPnlOnly(!v);
                setPage(1);
              }}
            />
            <Label htmlFor="pnl-only" className="text-sm text-muted-foreground whitespace-nowrap">
              Hiện cả khoản không hạch toán KQKD (cọc…)
            </Label>
          </div>

          <div className="flex items-center gap-2 h-9">
            <Switch
              id="accrual-mode"
              checked={accrualMode}
              onCheckedChange={(v) => {
                setAccrualMode(v);
                setPage(1);
              }}
            />
            <Label htmlFor="accrual-mode" className="text-sm text-muted-foreground whitespace-nowrap">
              Phân bổ theo kỳ áp dụng
            </Label>
          </div>
        </div>

        {/* Table */}
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tháng</TableHead>
                <TableHead>Mô tả</TableHead>
                <TableHead>Tòa nhà</TableHead>
                <TableHead>Phòng</TableHead>
                <TableHead className="text-right">Doanh thu</TableHead>
                <TableHead className="text-right">Chi phí</TableHead>
                <TableHead>Kỳ</TableHead>
                <TableHead>Phân loại</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={8}><Skeleton className="h-6 w-full" /></TableCell>
                  </TableRow>
                ))
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                    Không có dữ liệu nào để hiển thị
                  </TableCell>
                </TableRow>
              ) : accrualMode ? (
                (rows as any[]).map((r) => (
                  <TableRow key={r.itemId}>
                    <TableCell>{`${String(mm || 1).padStart(2, "0")}/${yyyy}`}</TableCell>
                    <TableCell>{r.voucherName}</TableCell>
                    <TableCell>{r.buildingName || "—"}</TableCell>
                    <TableCell>{r.roomName || "—"}</TableCell>
                    <TableCell className="text-right">
                      {r.income > 0 ? formatCurrency(r.income) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {r.expense > 0 ? formatCurrency(r.expense) : "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatPeriod(r.startDate, r.endDate) || "—"}
                    </TableCell>
                    <TableCell>
                      {r.typeName || "—"}
                      {r.countsInBusinessResult === false && (
                        <span className="ml-1 text-xs text-amber-600">(không KQKD)</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                (rows as any[]).map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{format(new Date(r.voucher_date), "MM/yyyy")}</TableCell>
                    <TableCell>{r.name}</TableCell>
                    <TableCell>{r.building_name || "—"}</TableCell>
                    <TableCell>{r.room_name || "—"}</TableCell>
                    <TableCell className="text-right">
                      {r.type === "INCOME" ? formatCurrency(r.total_amount) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {r.type === "EXPENSE" ? formatCurrency(r.total_amount) : "—"}
                    </TableCell>
                    <TableCell>—</TableCell>
                    <TableCell>
                      {(r.items || []).map((it: any) => it.type_name).filter(Boolean).join(", ") || "—"}
                      {r.counts_in_business_result === false && (
                        <span className="ml-1 text-xs text-amber-600">(không KQKD)</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <span>Số bản ghi</span>
            <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(parseInt(v, 10)); setPage(1); }}>
              <SelectTrigger className="w-[80px] h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[10, 20, 50, 100].map((n) => (
                  <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            {totalCount === 0
              ? "1 - 0 trên tổng số 0 bản ghi"
              : `${(page - 1) * pageSize + 1} - ${Math.min(page * pageSize, totalCount)} trên tổng số ${totalCount} bản ghi`}
          </div>
        </div>
      </div>
    </MainLayout>
  );
}
