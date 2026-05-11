import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import MainLayout from "@/components/layout/MainLayout";
import { ChevronRight } from "lucide-react";
import { useCashFlowByDay, useCashBookSummary } from "@/hooks/useCashBook";
import { useBuildings } from "@/hooks/useBuildings";
import { useAreas } from "@/hooks/useAreas";
import { useAccounts } from "@/hooks/useAccounts";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { DateRangePicker } from "@/components/reports/DateRangePicker";
import { DateRange } from "react-day-picker";
import { addDays, format, startOfMonth } from "date-fns";
import { vi } from "date-fns/locale";

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(amount);

const toLocalDateStr = (d: Date) => format(d, "yyyy-MM-dd");

const enumerateDays = (start: string, end: string): string[] => {
  const out: string[] = [];
  let cur = new Date(start + "T00:00:00");
  const to = new Date(end + "T00:00:00");
  while (cur <= to) {
    out.push(toLocalDateStr(cur));
    cur = addDays(cur, 1);
  }
  return out;
};

export default function DailyCashbookReport() {
  const [dateRange, setDateRange] = useState<DateRange | undefined>({
    from: startOfMonth(new Date()),
    to: new Date(),
  });
  const [areaId, setAreaId] = useState<string>("all");
  const [buildingId, setBuildingId] = useState<string>("all");
  const [accountId, setAccountId] = useState<string>("all");

  const startDate = dateRange?.from ? toLocalDateStr(dateRange.from) : undefined;
  const endDate = dateRange?.to ? toLocalDateStr(dateRange.to) : undefined;

  const { data: areas = [] } = useAreas();
  const { data: buildings = [] } = useBuildings();
  const { data: accounts = [] } = useAccounts();
  const filterOpts = {
    building_id: buildingId === "all" ? undefined : buildingId,
    account_id: accountId === "all" ? undefined : accountId,
  };
  const { data: byDay = [], isLoading } = useCashFlowByDay(
    startDate || "",
    endDate || "",
    filterOpts
  );
  const { data: summary } = useCashBookSummary(startDate, endDate, filterOpts);

  const accountName = accountId === "all"
    ? "Tất cả"
    : (accounts as any[]).find((a) => a.id === accountId)?.name || "—";

  const rows = useMemo(() => {
    if (!startDate || !endDate) return [];
    const dayMap = new Map<string, { income: number; expense: number }>();
    (byDay as any[]).forEach((d) => {
      dayMap.set(d.date, { income: d.income || 0, expense: d.expense || 0 });
    });
    let opening = summary?.openingBalance || 0;
    return enumerateDays(startDate, endDate).map((date) => {
      const entry = dayMap.get(date) || { income: 0, expense: 0 };
      const startBal = opening;
      const closing = startBal + entry.income - entry.expense;
      opening = closing;
      return {
        date,
        startBalance: startBal,
        income: entry.income,
        expense: entry.expense,
        endBalance: closing,
      };
    });
  }, [byDay, summary, startDate, endDate]);

  return (
    <MainLayout>
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link to="/reports/finance" className="hover:text-primary">
            Báo cáo tài chính
          </Link>
          <ChevronRight className="h-4 w-4" />
          <span className="text-foreground font-medium">Tài khoản theo ngày</span>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <Select value={areaId} onValueChange={setAreaId}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Chọn khu vực" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tất cả khu vực</SelectItem>
              {(areas as any[]).map((a) => (
                <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={buildingId} onValueChange={setBuildingId}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Chọn tòa nhà" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tất cả tòa nhà</SelectItem>
              {buildings.map((b) => (
                <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={accountId} onValueChange={setAccountId}>
            <SelectTrigger className="w-[220px]">
              <SelectValue placeholder="Tài khoản" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tất cả tài khoản</SelectItem>
              {(accounts as any[]).map((a) => (
                <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <DateRangePicker value={dateRange} onChange={setDateRange} />
        </div>

        <div className="rounded-md border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="border-r font-semibold">Ngày</TableHead>
                <TableHead className="border-r font-semibold">Tài khoản</TableHead>
                <TableHead className="border-r text-right font-semibold">Số dư đầu ngày</TableHead>
                <TableHead className="border-r text-right font-semibold">Tổng thu</TableHead>
                <TableHead className="border-r text-right font-semibold">Tổng chi</TableHead>
                <TableHead className="text-right font-semibold">Tồn cuối ngày</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={6}>
                      <Skeleton className="h-6 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                    Không có dữ liệu nào để hiển thị
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r, idx) => (
                  <TableRow key={r.date} className={idx % 2 === 1 ? "bg-muted/20" : ""}>
                    <TableCell className="border-r">
                      {format(new Date(r.date), "dd-MM-yyyy", { locale: vi })}
                    </TableCell>
                    <TableCell className="border-r">{accountName}</TableCell>
                    <TableCell className="border-r text-right tabular-nums">
                      {formatCurrency(r.startBalance)}
                    </TableCell>
                    <TableCell className="border-r text-right tabular-nums text-emerald-700">
                      {r.income ? formatCurrency(r.income) : "0 ₫"}
                    </TableCell>
                    <TableCell className="border-r text-right tabular-nums text-red-700">
                      {r.expense ? formatCurrency(r.expense) : "0 ₫"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {formatCurrency(r.endBalance)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {!isLoading && rows.length > 0 && (
          <div className="text-right text-sm text-muted-foreground">
            1 - {rows.length} trên tổng số {rows.length} bản ghi
          </div>
        )}
      </div>
    </MainLayout>
  );
}
