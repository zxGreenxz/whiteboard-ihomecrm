import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import MainLayout from "@/components/layout/MainLayout";
import { ChevronRight } from "lucide-react";
import { useCashFlowByDay } from "@/hooks/useCashBook";
import { useBuildings } from "@/hooks/useBuildings";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, BarChart,
} from "recharts";

const formatCurrency = (n: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(n);

const QUARTER_LABEL = ["I", "II", "III", "IV"];

export default function CashFlowReport() {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState<number>(currentYear);
  const [buildingId, setBuildingId] = useState<string>("all");
  const [series, setSeries] = useState<{
    income: boolean;
    expense: boolean;
    net: boolean;
  }>({ income: true, expense: true, net: true });

  const startDate = `${year}-01-01`;
  const endDate = `${year}-12-31`;

  const { data: buildings = [] } = useBuildings();
  const { data: byDay = [], isLoading } = useCashFlowByDay(startDate, endDate, {
    building_id: buildingId === "all" ? undefined : buildingId,
  });

  // Aggregate to 12 months
  const monthly = useMemo(() => {
    const result = Array.from({ length: 12 }, (_, i) => ({
      month: i + 1,
      label: `TH${i + 1}`,
      income: 0,
      expense: 0,
      net: 0,
    }));
    (byDay as any[]).forEach((d) => {
      const m = parseInt(d.date.substring(5, 7), 10) - 1;
      if (m >= 0 && m < 12) {
        result[m].income += d.income || 0;
        result[m].expense += d.expense || 0;
      }
    });
    result.forEach((r) => (r.net = r.income - r.expense));
    return result;
  }, [byDay]);

  // Quarter aggregation
  const quarterly = useMemo(() => {
    return [0, 1, 2, 3].map((q) => {
      const months = monthly.slice(q * 3, q * 3 + 3);
      const income = months.reduce((s, m) => s + m.income, 0);
      const expense = months.reduce((s, m) => s + m.expense, 0);
      return { quarter: q + 1, label: QUARTER_LABEL[q], income, expense, net: income - expense };
    });
  }, [monthly]);

  const yearTotals = useMemo(() => {
    const income = monthly.reduce((s, m) => s + m.income, 0);
    const expense = monthly.reduce((s, m) => s + m.expense, 0);
    return { income, expense, net: income - expense };
  }, [monthly]);

  const yearOptions = Array.from({ length: 5 }, (_, i) => currentYear - i);

  return (
    <MainLayout>
      <div className="space-y-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link to="/reports/finance" className="hover:text-primary">
            Báo cáo tài chính
          </Link>
          <ChevronRight className="h-4 w-4" />
          <span className="text-foreground font-medium">Dòng tiền</span>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Năm</span>
            <Select value={String(year)} onValueChange={(v) => setYear(parseInt(v, 10))}>
              <SelectTrigger className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {yearOptions.map((y) => (
                  <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Tòa nhà</span>
            <Select value={buildingId} onValueChange={setBuildingId}>
              <SelectTrigger className="w-[220px]">
                <SelectValue placeholder="Chọn tòa nhà" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tất cả tòa nhà</SelectItem>
                {buildings.map((b) => (
                  <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="rounded-md border bg-card">
          <div className="border-b p-4 flex items-center justify-between flex-wrap gap-3">
            <h3 className="text-base font-semibold">Biểu đồ dòng tiền thu chi thực tế</h3>
            <div className="flex gap-2">
            <Button
              size="sm"
              variant={series.income ? "default" : "outline"}
              onClick={() => setSeries((s) => ({ ...s, income: !s.income }))}
            >
              Thu vào
            </Button>
            <Button
              size="sm"
              variant={series.expense ? "default" : "outline"}
              onClick={() => setSeries((s) => ({ ...s, expense: !s.expense }))}
            >
              Chi ra
            </Button>
            <Button
              size="sm"
              variant={series.net ? "default" : "outline"}
              onClick={() => setSeries((s) => ({ ...s, net: !s.net }))}
            >
              Chênh lệch
            </Button>
            </div>
          </div>
          <div className="p-4">
          {isLoading ? (
            <Skeleton className="h-[320px] w-full" />
          ) : (
            <ResponsiveContainer width="100%" height={360}>
              <BarChart data={monthly} barCategoryGap="20%" barGap={4}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => new Intl.NumberFormat("vi-VN", { notation: "compact" }).format(Number(v))} />
                <Tooltip formatter={(v) => formatCurrency(Number(v))} />
                <Legend />
                {series.income && <Bar dataKey="income" fill="#10B981" name="Thu vào" radius={[4,4,0,0]} maxBarSize={32} />}
                {series.expense && <Bar dataKey="expense" fill="#EF4444" name="Chi ra" radius={[4,4,0,0]} maxBarSize={32} />}
                {series.net && <Bar dataKey="net" fill="#3B82F6" name="Chênh lệch" radius={[4,4,0,0]} maxBarSize={32} />}
              </BarChart>
            </ResponsiveContainer>
          )}
          </div>
        </div>

        <div className="rounded-md border bg-card">
          <div className="border-b p-4">
            <h3 className="text-base font-semibold">Bảng thu chi theo tháng và quý</h3>
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="border-r font-semibold text-center w-16">Quý</TableHead>
                <TableHead className="border-r text-right font-semibold">Doanh thu</TableHead>
                <TableHead className="border-r text-right font-semibold">Chi phí</TableHead>
                <TableHead className="border-r-2 text-right font-semibold">Lợi nhuận</TableHead>
                <TableHead className="border-r font-semibold text-center w-16">Tháng</TableHead>
                <TableHead className="border-r text-right font-semibold">Doanh thu</TableHead>
                <TableHead className="border-r text-right font-semibold">Chi phí</TableHead>
                <TableHead className="text-right font-semibold">Lợi nhuận</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {quarterly.flatMap((q) => {
                const monthsOfQ = monthly.slice((q.quarter - 1) * 3, q.quarter * 3);
                return monthsOfQ.map((m, idx) => (
                  <TableRow key={`${q.quarter}-${m.month}`} className={q.quarter % 2 === 0 ? "bg-muted/10" : ""}>
                    {idx === 0 ? (
                      <>
                        <TableCell rowSpan={3} className="border-r text-center align-middle font-semibold">{q.label}</TableCell>
                        <TableCell rowSpan={3} className="border-r text-right align-middle tabular-nums">{formatCurrency(q.income)}</TableCell>
                        <TableCell rowSpan={3} className="border-r text-right align-middle tabular-nums">{formatCurrency(q.expense)}</TableCell>
                        <TableCell rowSpan={3} className="border-r-2 text-right align-middle tabular-nums">{formatCurrency(q.net)}</TableCell>
                      </>
                    ) : null}
                    <TableCell className="border-r text-center">{m.month}</TableCell>
                    <TableCell className="border-r text-right tabular-nums text-emerald-700">{formatCurrency(m.income)}</TableCell>
                    <TableCell className="border-r text-right tabular-nums text-red-700">{formatCurrency(m.expense)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(m.net)}</TableCell>
                  </TableRow>
                ));
              })}
              <TableRow className="bg-muted/60 font-bold border-t-2">
                <TableCell className="border-r font-bold">Cả năm</TableCell>
                <TableCell className="border-r text-right tabular-nums">{formatCurrency(yearTotals.income)}</TableCell>
                <TableCell className="border-r text-right tabular-nums">{formatCurrency(yearTotals.expense)}</TableCell>
                <TableCell className="border-r-2 text-right tabular-nums">{formatCurrency(yearTotals.net)}</TableCell>
                <TableCell colSpan={4} />
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </div>
    </MainLayout>
  );
}
