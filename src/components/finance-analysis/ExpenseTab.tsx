import { useMemo } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { format } from "date-fns";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/utils";
import { useIncomeExpenses, type IncomeExpenseFilters } from "@/hooks/useIncomeExpenses";
import { useFaMonthlyPnl } from "@/hooks/useFinancialAnalysis";
import type { AnalysisFilters } from "./types";
import {
  aggregatePnlByMonth,
  compactVnd,
  COLOR_EXPENSE,
  COLOR_RATIO,
  expenseColorAt,
  monthLabel,
  monthTitle,
  ratioPct,
  scaffoldMonths,
} from "./utils";
import { ChartCard } from "./ChartCard";
import { TypeBreakdownSection } from "./TypeBreakdownSection";

interface Props {
  filters: AnalysisFilters;
}

/** Tab Chi phí — cơ cấu chi KQKD + tỷ lệ CP/DT + top khoản chi lớn. */
export function ExpenseTab({ filters }: Props) {
  const { ym, periodStart, periodEnd, t13Start, t13End, months12, buildingIds, accrual } = filters;

  const { data: pnl = [], isLoading: pnlLoading } = useFaMonthlyPnl(t13Start, t13End, buildingIds, accrual);

  // Tỷ lệ CP/DT 12 tháng
  const ratioData = useMemo(() => {
    const byMonth = aggregatePnlByMonth(pnl);
    return scaffoldMonths(months12, byMonth).map((m) => ({
      label: monthLabel(m.ym),
      expense: m.expense,
      ratio: ratioPct(m.expense, m.revenue),
    }));
  }, [pnl, months12]);

  // Top 10 khoản chi lớn tháng chọn (hook sort theo ngày → lấy 100 dòng rồi
  // client-sort theo số tiền)
  const ieFilters: IncomeExpenseFilters = useMemo(
    () => ({
      building_ids: buildingIds.length ? buildingIds : undefined,
      type: "EXPENSE" as const,
      start_date: periodStart,
      end_date: periodEnd,
      approval_status: "APPROVED",
      business_result_only: true,
    }),
    [buildingIds, periodStart, periodEnd],
  );
  const { data: vouchers, isLoading: vLoading } = useIncomeExpenses(ieFilters, {
    page: 1,
    pageSize: 100,
  });
  const topVouchers = useMemo(
    () =>
      [...(vouchers?.data ?? [])]
        .sort((a: any, b: any) => Number(b.total_amount) - Number(a.total_amount))
        .slice(0, 10),
    [vouchers],
  );

  return (
    <div className="space-y-4">
      <ChartCard
        title="Tỷ lệ chi phí / doanh thu — 12 tháng"
        loading={pnlLoading}
        empty={ratioData.every((d) => d.expense === 0)}
        height={320}
      >
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={ratioData} barCategoryGap="22%">
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis dataKey="label" tick={{ fontSize: 12 }} />
            <YAxis yAxisId="left" tick={{ fontSize: 12 }} tickFormatter={compactVnd} width={70} />
            <YAxis
              yAxisId="right"
              orientation="right"
              tick={{ fontSize: 12 }}
              tickFormatter={(v: number) => `${v}%`}
            />
            <Tooltip
              formatter={(value: any, name: any) =>
                name === "Tỷ lệ CP/DT"
                  ? value == null
                    ? "—"
                    : `${Number(value).toFixed(1)}%`
                  : formatCurrency(Number(value))
              }
            />
            <Legend />
            <Bar
              yAxisId="left"
              dataKey="expense"
              name="Chi phí"
              fill={COLOR_EXPENSE}
              radius={[4, 4, 0, 0]}
              maxBarSize={28}
            />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="ratio"
              name="Tỷ lệ CP/DT"
              stroke={COLOR_RATIO}
              strokeWidth={2}
              dot={{ r: 3 }}
              connectNulls={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      <TypeBreakdownSection
        filters={filters}
        side="EXPENSE"
        mainColor={COLOR_EXPENSE}
        colorFn={expenseColorAt}
        invert
        noun="chi"
        exportPrefix="chi-phi"
      />

      <ChartCard
        title={`Top 10 khoản chi lớn — ${monthTitle(ym)}`}
        height={200}
        footnote={
          accrual ? (
            <p className="text-xs text-muted-foreground">
              Danh sách phiếu chi lập trong kỳ (theo ngày phiếu) — không phân bổ dồn tích như các
              biểu đồ tổng phía trên.
            </p>
          ) : undefined
        }
      >
        <div className="overflow-x-auto -mx-6 px-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ngày</TableHead>
                <TableHead>Mã</TableHead>
                <TableHead>Tên phiếu</TableHead>
                <TableHead>Toà nhà</TableHead>
                <TableHead>Hạng mục</TableHead>
                <TableHead className="text-right">Số tiền</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={6}><Skeleton className="h-6 w-full" /></TableCell>
                  </TableRow>
                ))
              ) : topVouchers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                    Không có khoản chi trong kỳ này
                  </TableCell>
                </TableRow>
              ) : (
                topVouchers.map((r: any) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap">
                      {format(new Date(r.voucher_date), "dd/MM/yyyy")}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {r.code || "—"}
                    </TableCell>
                    <TableCell className="max-w-[260px] truncate" title={r.name}>
                      {r.name}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{r.building_name || "—"}</TableCell>
                    <TableCell className="max-w-[200px] truncate">
                      {(r.items || [])
                        .map((it: any) => it.type_name)
                        .filter(Boolean)
                        .join(", ") || "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium text-red-700">
                      {formatCurrency(Number(r.total_amount))}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </ChartCard>
    </div>
  );
}
