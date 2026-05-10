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
  const { data: byDay = [], isLoading } = useCashFlowByDay(startDate, endDate);

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

        <div className="rounded-md border p-4">
          <h3 className="text-base font-semibold mb-3">Biểu đồ dòng tiền thu chi thực tế</h3>
          <div className="flex gap-2 mb-3">
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
          {isLoading ? (
            <Skeleton className="h-[320px] w-full" />
          ) : (
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={monthly}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="label" />
                <YAxis tickFormatter={(v) => new Intl.NumberFormat("vi-VN", { notation: "compact" }).format(Number(v))} />
                <Tooltip formatter={(v) => formatCurrency(Number(v))} />
                <Legend />
                {series.income && <Bar dataKey="income" fill="#10B981" name="Thu vào" />}
                {series.expense && <Bar dataKey="expense" fill="#EF4444" name="Chi ra" />}
                {series.net && <Bar dataKey="net" fill="#3B82F6" name="Chênh lệch" />}
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="rounded-md border p-4">
          <h3 className="text-base font-semibold mb-3">Bảng thu chi theo tháng và quý</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead><strong>Quý</strong></TableHead>
                <TableHead className="text-right"><strong>Doanh thu</strong></TableHead>
                <TableHead className="text-right"><strong>Chi phí</strong></TableHead>
                <TableHead className="text-right"><strong>Lợi nhuận</strong></TableHead>
                <TableHead><strong>Tháng</strong></TableHead>
                <TableHead className="text-right"><strong>Doanh thu</strong></TableHead>
                <TableHead className="text-right"><strong>Chi phí</strong></TableHead>
                <TableHead className="text-right"><strong>Lợi nhuận</strong></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {quarterly.flatMap((q) => {
                const monthsOfQ = monthly.slice((q.quarter - 1) * 3, q.quarter * 3);
                return monthsOfQ.map((m, idx) => (
                  <TableRow key={`${q.quarter}-${m.month}`}>
                    {idx === 0 ? (
                      <>
                        <TableCell rowSpan={3}><strong>{q.label}</strong></TableCell>
                        <TableCell rowSpan={3} className="text-right">{formatCurrency(q.income)}</TableCell>
                        <TableCell rowSpan={3} className="text-right">{formatCurrency(q.expense)}</TableCell>
                        <TableCell rowSpan={3} className="text-right">{formatCurrency(q.net)}</TableCell>
                      </>
                    ) : null}
                    <TableCell>{m.month}</TableCell>
                    <TableCell className="text-right">{formatCurrency(m.income)}</TableCell>
                    <TableCell className="text-right">{formatCurrency(m.expense)}</TableCell>
                    <TableCell className="text-right">{formatCurrency(m.net)}</TableCell>
                  </TableRow>
                ));
              })}
              <TableRow className="bg-muted/50 font-semibold">
                <TableCell colSpan={4}><strong>Cả năm</strong></TableCell>
                <TableCell className="text-right">{formatCurrency(yearTotals.income)}</TableCell>
                <TableCell className="text-right">{formatCurrency(yearTotals.expense)}</TableCell>
                <TableCell className="text-right">{formatCurrency(yearTotals.net)}</TableCell>
                <TableCell />
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </div>
    </MainLayout>
  );
}
