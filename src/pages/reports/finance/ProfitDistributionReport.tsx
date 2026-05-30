import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import MainLayout from "@/components/layout/MainLayout";
import { ChevronRight, DollarSign } from "lucide-react";
import { useIncomeExpenses } from "@/hooks/useIncomeExpenses";
import { useAreas } from "@/hooks/useAreas";
import { useBuildings } from "@/hooks/useBuildings";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
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
  const [areaId, setAreaId] = useState<string>("all");
  const [buildingId, setBuildingId] = useState<string>("all");
  const [roomId, setRoomId] = useState<string>("all");
  const [bedId, setBedId] = useState<string>("all");
  const [voucherType, setVoucherType] = useState<string>("all");
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(10);

  // Parse monthStr "MM-yyyy" → start/end date
  const [mm, yyyy] = monthStr.split("-").map((s) => parseInt(s, 10));
  const monthDate = new Date(yyyy, (mm || 1) - 1, 1);
  const startDate = format(startOfMonth(monthDate), "yyyy-MM-dd");
  const endDate = format(endOfMonth(monthDate), "yyyy-MM-dd");

  const { data: areas = [] } = useAreas();
  const { data: buildings = [] } = useBuildings({ includeVirtual: true });

  const { data: result, isLoading } = useIncomeExpenses(
    {
      area_id: areaId === "all" ? undefined : areaId,
      building_id: buildingId === "all" ? undefined : buildingId,
      room_id: roomId === "all" ? undefined : roomId,
      type: voucherType === "all" ? undefined : (voucherType as any),
      start_date: startDate,
      end_date: endDate,
      approval_status: "APPROVED" as any,
    },
    { page, pageSize }
  );

  const rows = result?.data ?? [];
  const totalCount = result?.totalCount ?? 0;

  const totals = useMemo(() => {
    const income = rows
      .filter((r: any) => r.type === "INCOME")
      .reduce((s: number, r: any) => s + r.total_amount, 0);
    const expense = rows
      .filter((r: any) => r.type === "EXPENSE")
      .reduce((s: number, r: any) => s + r.total_amount, 0);
    return { income, expense, profit: income - expense };
  }, [rows]);

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
          <StatCard label="Doanh thu" value={totals.income} ring="ring-1 ring-emerald-200" bg="bg-emerald-100 text-emerald-700" />
          <StatCard label="Chi phí" value={totals.expense} ring="ring-1 ring-orange-200" bg="bg-orange-100 text-orange-700" />
          <StatCard label="Lợi nhuận" value={totals.profit} ring="ring-1 ring-blue-200" bg="bg-blue-100 text-blue-700" />
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-end gap-3">
          <SearchableSelect
            value={monthStr}
            onValueChange={setMonthStr}
            className="w-[140px]"
            options={monthOptions.map((m) => ({ value: m, label: m }))}
          />

          <SearchableSelect
            value={areaId}
            onValueChange={setAreaId}
            className="w-[180px]"
            placeholder="Chọn khu vực"
            options={[
              { value: 'all', label: 'Tất cả khu vực' },
              ...(areas as any[]).map((a) => ({ value: a.id, label: a.name })),
            ]}
          />

          <SearchableSelect
            value={buildingId}
            onValueChange={setBuildingId}
            className="w-[180px]"
            placeholder="Chọn tòa nhà"
            options={[
              { value: 'all', label: 'Tất cả tòa nhà' },
              ...buildings.map((b) => ({ value: b.id, label: b.name })),
            ]}
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
            value={bedId}
            onValueChange={setBedId}
            className="w-[160px]"
            placeholder="Chọn giường"
            options={[
              { value: 'all', label: 'Tất cả giường' },
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
                <TableHead>Phân loại</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={7}><Skeleton className="h-6 w-full" /></TableCell>
                  </TableRow>
                ))
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                    Không có dữ liệu nào để hiển thị
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r: any) => (
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
                    <TableCell>
                      {(r.items || []).map((it: any) => it.type_name).filter(Boolean).join(", ") || "—"}
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
