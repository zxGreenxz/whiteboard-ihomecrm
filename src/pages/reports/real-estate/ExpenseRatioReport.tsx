import { useMemo } from "react";
import { Percent, TrendingUp, DollarSign, Calendar } from "lucide-react";
import { startOfMonth, endOfMonth, subMonths } from "date-fns";
import { DateRange } from "react-day-picker";
import MainLayout from "@/components/layout/MainLayout";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { DateRangePicker } from "@/components/reports/DateRangePicker";
import { useExpenseRatioReport } from "@/hooks/useReports";
import { useIncomeExpenseTypeCategories } from "@/hooks/useIncomeExpenseTypes";
import { useBuildings } from "@/hooks/useBuildings";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  ComposedChart,
  Bar,
  Line,
  BarChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { usePersistedState, usePersistedDateRange } from "@/hooks/usePersistedState";

const CATEGORY_COLORS = [
  "#3B82F6",
  "#10B981",
  "#F59E0B",
  "#EF4444",
  "#8B5CF6",
  "#EC4899",
  "#14B8A6",
  "#F97316",
];
const RATIO_LINE_COLOR = "#DC2626";

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(amount);

const formatCurrencyShort = (amount: number) => {
  const abs = Math.abs(amount);
  if (abs >= 1_000_000_000) return `${(amount / 1_000_000_000).toFixed(1)}tỷ`;
  if (abs >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}tr`;
  if (abs >= 1_000) return `${(amount / 1_000).toFixed(0)}k`;
  return String(amount);
};

export default function ExpenseRatioReport() {
  const defaultRange: DateRange = {
    from: startOfMonth(subMonths(new Date(), 5)),
    to: endOfMonth(new Date()),
  };
  const [dateRange, setDateRange] = usePersistedDateRange("flt:rpt-expense-ratio:dateRange", defaultRange);
  const [category, setCategory] = usePersistedState<string | undefined>("flt:rpt-expense-ratio:category", undefined);
  const [buildingId, setBuildingId] = usePersistedState<string | undefined>("flt:rpt-expense-ratio:buildingId", undefined);

  const { data: buildings } = useBuildings({ includeVirtual: true });
  const { data: categoriesList } = useIncomeExpenseTypeCategories("expense");
  const { data, isLoading } = useExpenseRatioReport(
    dateRange?.from,
    dateRange?.to,
    category,
    buildingId
  );

  const colorByCategory = useMemo(() => {
    const map: Record<string, string> = {};
    (data?.categories ?? []).forEach((c, idx) => {
      map[c] = CATEGORY_COLORS[idx % CATEGORY_COLORS.length];
    });
    return map;
  }, [data?.categories]);

  const chartData = useMemo(() => {
    if (!data) return [];
    return data.byMonth.map((row) => ({
      month: row.month,
      revenue: row.revenue,
      totalExpense: row.totalExpense,
      ratio: row.ratio,
      ...row.expensesByCategory,
    }));
  }, [data]);

  const stats = data && (
    <>
      <ReportCard
        title="Tổng chi phí"
        value={formatCurrency(data.summary.totalExpense)}
        icon={DollarSign}
        description={category ? `Nhóm: ${category}` : "Tất cả nhóm"}
      />
      <ReportCard
        title="Tổng doanh thu"
        value={formatCurrency(data.summary.totalRevenue)}
        icon={TrendingUp}
        description="Doanh thu ghi nhận trên invoice đã duyệt"
      />
      <ReportCard
        title="Tỉ lệ TB"
        value={`${data.summary.avgRatio.toFixed(1)}%`}
        icon={Percent}
        description="Chi phí / doanh thu trung bình"
      />
      <ReportCard
        title="Tháng đỉnh"
        value={
          data.summary.peakMonth
            ? `${data.summary.peakMonth} (${data.summary.peakRatio.toFixed(1)}%)`
            : "—"
        }
        icon={Calendar}
        description="Tháng có tỉ lệ cao nhất"
      />
    </>
  );

  const exportData =
    data?.byMonth.map((row) => {
      const out: Record<string, string | number> = {
        "Tháng": row.month,
        "Doanh thu (VND)": row.revenue,
        "Tổng chi (VND)": row.totalExpense,
        "Tỉ lệ %": row.ratio === null ? "—" : Number(row.ratio.toFixed(2)),
      };
      for (const c of data.categories) {
        out[c] = row.expensesByCategory[c] ?? 0;
      }
      return out;
    }) ?? [];

  const filters = (
    <div className="flex flex-wrap gap-4">
      <div className="w-[200px]">
        <SearchableSelect
          value={buildingId || "all"}
          onValueChange={(v) => setBuildingId(v === "all" ? undefined : v)}
          placeholder="Chọn toà nhà"
          options={[
            { value: "all", label: "Tất cả toà nhà" },
            ...(buildings?.map((b) => ({ value: b.id, label: b.name })) ?? []),
          ]}
        />
      </div>
      <div className="w-[220px]">
        <SearchableSelect
          value={category ?? "all"}
          onValueChange={(v) => setCategory(v === "all" ? undefined : v)}
          placeholder="Chọn nhóm hạng mục"
          options={[
            { value: "all", label: "Tất cả nhóm" },
            ...(categoriesList ?? []).map((c) => ({ value: c, label: c })),
          ]}
        />
      </div>
      <DateRangePicker value={dateRange} onChange={setDateRange} />
    </div>
  );

  return (
    <MainLayout>
      <ReportLayout
        title="Tỉ lệ chi phí / Doanh thu"
        description="Thống kê tỉ lệ chi phí theo nhóm hạng mục, phân theo tháng"
        icon={<Percent className="h-8 w-8" />}
        actions={<ExportButtons data={exportData} filename="ti-le-chi-phi-doanh-thu" />}
        stats={stats}
        filters={filters}
      >
        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-[350px] w-full" />
            <Skeleton className="h-[300px] w-full" />
            <Skeleton className="h-[200px] w-full" />
          </div>
        ) : !data ? (
          <div className="text-center py-8 text-muted-foreground">
            Không có dữ liệu
          </div>
        ) : (
          <>
            {/* Chart 1 — Composed (bar chi phí + line tỉ lệ %) */}
            <Card>
              <CardHeader>
                <CardTitle>Chi phí & tỉ lệ % so doanh thu theo tháng</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={360}>
                  <ComposedChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="month" />
                    <YAxis
                      yAxisId="left"
                      tickFormatter={(v) => formatCurrencyShort(Number(v))}
                    />
                    <YAxis
                      yAxisId="right"
                      orientation="right"
                      tickFormatter={(v) => `${Number(v).toFixed(0)}%`}
                    />
                    <Tooltip
                      formatter={(value: any, name: string) => {
                        if (name === "Tỉ lệ %") {
                          return value === null
                            ? ["—", name]
                            : [`${Number(value).toFixed(1)}%`, name];
                        }
                        return [formatCurrency(Number(value)), name];
                      }}
                    />
                    <Legend />
                    {category
                      ? (
                        <Bar
                          yAxisId="left"
                          dataKey={category}
                          stackId="exp"
                          name={category}
                          fill={colorByCategory[category] ?? CATEGORY_COLORS[0]}
                        />
                      )
                      : data.categories.map((c) => (
                          <Bar
                            key={c}
                            yAxisId="left"
                            dataKey={c}
                            stackId="exp"
                            name={c}
                            fill={colorByCategory[c]}
                          />
                        ))}
                    <Line
                      yAxisId="right"
                      type="monotone"
                      dataKey="ratio"
                      name="Tỉ lệ %"
                      stroke={RATIO_LINE_COLOR}
                      strokeWidth={2}
                      dot={{ r: 4 }}
                      activeDot={{ r: 6 }}
                      connectNulls={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* Chart 2 — Breakdown by typeName */}
            {data.byTypeName.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Phân bổ theo loại hạng mục</CardTitle>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={320}>
                    <BarChart data={data.byTypeName}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="typeName" interval={0} angle={-15} textAnchor="end" height={70} />
                      <YAxis tickFormatter={(v) => formatCurrencyShort(Number(v))} />
                      <Tooltip
                        formatter={(value: any, _name, props) => [
                          formatCurrency(Number(value)),
                          props.payload?.category ?? "Chi",
                        ]}
                      />
                      <Bar dataKey="total" name="Số tiền">
                        {data.byTypeName.map((row, idx) => (
                          <Cell
                            key={idx}
                            fill={colorByCategory[row.category] ?? CATEGORY_COLORS[idx % CATEGORY_COLORS.length]}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            )}

            {/* Table */}
            <Card>
              <CardHeader>
                <CardTitle>Chi tiết theo tháng</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Tháng</TableHead>
                        <TableHead className="text-right">Doanh thu</TableHead>
                        {data.categories.map((c) => (
                          <TableHead key={c} className="text-right">{c}</TableHead>
                        ))}
                        <TableHead className="text-right">Tổng chi</TableHead>
                        <TableHead className="text-right">Tỉ lệ %</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.byMonth.map((row) => (
                        <TableRow key={row.month}>
                          <TableCell className="font-medium">{row.month}</TableCell>
                          <TableCell className="text-right">{formatCurrency(row.revenue)}</TableCell>
                          {data.categories.map((c) => (
                            <TableCell key={c} className="text-right">
                              {row.expensesByCategory[c]
                                ? formatCurrency(row.expensesByCategory[c])
                                : "—"}
                            </TableCell>
                          ))}
                          <TableCell className="text-right font-semibold">
                            {formatCurrency(row.totalExpense)}
                          </TableCell>
                          <TableCell className="text-right">
                            {row.ratio === null ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              <span
                                className={
                                  row.ratio >= 50
                                    ? "text-red-600 font-semibold"
                                    : row.ratio >= 25
                                    ? "text-yellow-600 font-semibold"
                                    : "text-green-600"
                                }
                              >
                                {row.ratio.toFixed(1)}%
                              </span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </ReportLayout>
    </MainLayout>
  );
}
