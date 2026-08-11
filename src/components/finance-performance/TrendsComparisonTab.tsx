import { useMemo } from "react";
import { Info, RefreshCw } from "lucide-react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  FinanceEmptyState,
  FinanceLoadingGrid,
  FinanceQueryError,
} from "@/components/finance-performance/FinanceDataState";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useBusinessPerformancePnl } from "@/hooks/reports/useBusinessPerformance";
import {
  aggregateBusinessPerformancePnl,
  buildBusinessPerformanceComparison,
  type BusinessPerformanceComparison,
  type BusinessPerformanceFilters,
  type BusinessPerformanceMonthAggregate,
} from "@/lib/businessPerformance";
import { deriveFinanceQueryState } from "@/lib/financeQueryState";
import { formatCurrency } from "@/lib/utils";

interface TrendsComparisonTabProps {
  filters: BusinessPerformanceFilters;
}

interface TrendChartRow {
  month: string;
  label: string;
  revenue: number | null;
  expense: number | null;
  net: number | null;
  marginPct: number | null;
  expenseRatioPct: number | null;
}

type ComparisonMetricKey = "revenue" | "expense" | "net";

interface TrendLegendSeries {
  dataKey: string;
  label: string;
  color: string;
  strokeDasharray?: string;
  dot: { readonly r: number };
}

const MONEY_SERIES = {
  revenue: { label: "Doanh thu", color: "#0f766e" },
  expense: { label: "Chi phí", color: "#b45309" },
  net: { label: "Lợi nhuận", color: "hsl(var(--foreground))" },
} as const;

type TrendSeriesStyle = Pick<TrendLegendSeries, "strokeDasharray" | "dot">;

const MONEY_SERIES_STYLES: Record<ComparisonMetricKey, TrendSeriesStyle> = {
  revenue: { strokeDasharray: undefined, dot: { r: 3 } },
  expense: { strokeDasharray: "8 4", dot: { r: 3 } },
  net: { strokeDasharray: "2 4", dot: { r: 3 } },
};

const MONEY_LEGEND_SERIES: readonly TrendLegendSeries[] = (
  Object.keys(MONEY_SERIES) as ComparisonMetricKey[]
).map((dataKey) => ({
  dataKey,
  ...MONEY_SERIES[dataKey],
  ...MONEY_SERIES_STYLES[dataKey],
}));

type RatioMetricKey = "marginPct" | "expenseRatioPct";

const RATIO_SERIES: Record<RatioMetricKey, Omit<TrendLegendSeries, "dataKey">> = {
  marginPct: {
    label: "Biên lợi nhuận",
    color: "#2563eb",
    strokeDasharray: undefined,
    dot: { r: 3 },
  },
  expenseRatioPct: {
    label: "Tỷ lệ chi phí",
    color: "#b45309",
    strokeDasharray: "6 4",
    dot: { r: 3 },
  },
};

const RATIO_LEGEND_SERIES: readonly TrendLegendSeries[] = Object.entries(
  RATIO_SERIES,
).map(([dataKey, series]) => ({ dataKey, ...series }));

function formatMonthLabel(month: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  return match ? `${Number(match[2])}/${match[1].slice(2)}` : month;
}

function formatMonthTitle(month: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  return match ? `T${Number(match[2])}/${match[1]}` : month;
}

function formatCompactMoney(value: number) {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} tỷ`;
  }
  if (absolute >= 1_000_000) {
    return `${(value / 1_000_000).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} tr`;
  }
  if (absolute >= 1_000) {
    return `${(value / 1_000).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} nghìn`;
  }
  return value.toLocaleString("vi-VN");
}

function formatPercent(value: number | null) {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function formatNullableMoney(value: number | null) {
  return value === null ? "Không có dữ liệu" : formatCurrency(value);
}

// Exported as a pure test seam for the zero-baseline comparison rule.
// eslint-disable-next-line react-refresh/only-export-components
export function absoluteDelta(current: number | null, baseline: number | null) {
  return current === null || baseline === null ? null : current - baseline;
}

function StaleDataWarning({ onRetry }: { onRetry: () => void }) {
  return (
    <Alert role="status">
      <Info aria-hidden="true" />
      <AlertTitle>Dữ liệu đang hiển thị có thể đã cũ</AlertTitle>
      <AlertDescription className="flex flex-col gap-3">
        <p>Lần làm mới gần nhất thất bại. Số liệu đã tải trước đó vẫn được giữ để tham khảo.</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw data-icon="inline-start" aria-hidden="true" />
          Thử tải lại
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function buildTrendRows(
  filters: BusinessPerformanceFilters,
  byMonth: Map<string, BusinessPerformanceMonthAggregate>,
): TrendChartRow[] {
  const months = [filters.yoyMonth, ...filters.months12];
  return months.map((month) => {
    const aggregate = byMonth.get(month);
    return {
      month,
      label: formatMonthLabel(month),
      revenue: aggregate?.revenue ?? 0,
      expense: aggregate?.expense ?? 0,
      net: aggregate?.net ?? 0,
      marginPct: aggregate?.marginPct ?? null,
      expenseRatioPct: aggregate?.expenseRatioPct ?? null,
    };
  });
}

function PatternLegend({ series }: { series: readonly TrendLegendSeries[] }) {
  return (
    <ul
      className="flex flex-wrap justify-center gap-x-4 gap-y-2 pt-2 text-sm"
      aria-label="Chú giải biểu đồ"
    >
      {series.map(({ dataKey, label, color, strokeDasharray, dot }) => (
        <li
          key={dataKey}
          data-series-key={dataKey}
          data-stroke-pattern={strokeDasharray ?? "solid"}
          data-dot-radius={dot.r}
          className="flex items-center gap-2"
        >
          <svg
            width="48"
            height="12"
            viewBox="0 0 48 12"
            aria-hidden="true"
            focusable="false"
          >
            <line
              x1="1"
              y1="6"
              x2="47"
              y2="6"
              stroke={color}
              strokeWidth="2.25"
              strokeDasharray={strokeDasharray}
            />
            <circle cx="24" cy="6" r={dot.r} fill={color} />
          </svg>
          <span>{label}</span>
        </li>
      ))}
    </ul>
  );
}

function MoneyTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: ReadonlyArray<{ name?: string; value?: number | null; color?: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;

  return (
    <div className="rounded-md border bg-background p-3 text-sm shadow-md">
      <p className="mb-2 font-medium">{label}</p>
      <div className="flex flex-col gap-1">
        {payload.map((item) => (
          <div key={item.name} className="flex items-center justify-between gap-5">
            <span className="flex items-center gap-2 text-muted-foreground">
              <span
                className="size-2.5 rounded-full"
                style={{ backgroundColor: item.color }}
                aria-hidden="true"
              />
              {item.name}
            </span>
            <span className="tabular-nums">
              {item.value === null || item.value === undefined
                ? "Không có dữ liệu"
                : formatCurrency(item.value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PercentTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: ReadonlyArray<{ name?: string; value?: number | null; color?: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;

  return (
    <div className="rounded-md border bg-background p-3 text-sm shadow-md">
      <p className="mb-2 font-medium">{label}</p>
      <div className="flex flex-col gap-1">
        {payload.map((item) => (
          <div key={item.name} className="flex items-center justify-between gap-5">
            <span className="flex items-center gap-2 text-muted-foreground">
              <span
                className="size-2.5 rounded-full"
                style={{ backgroundColor: item.color }}
                aria-hidden="true"
              />
              {item.name}
            </span>
            <span className="tabular-nums">
              {item.value === null || item.value === undefined
                ? "Không có dữ liệu"
                : `${item.value.toFixed(1)}%`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ComparisonTable({
  comparison,
  filters,
}: {
  comparison: BusinessPerformanceComparison;
  filters: BusinessPerformanceFilters;
}) {
  const metrics: ReadonlyArray<{
    key: ComparisonMetricKey;
    label: string;
  }> = [
    { key: "revenue", label: "Doanh thu" },
    { key: "expense", label: "Chi phí" },
    { key: "net", label: "Lợi nhuận" },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle id="comparison-table-title" className="text-lg">
          So sánh kỳ báo cáo
        </CardTitle>
        <CardDescription>
          MoM = kỳ hiện tại − kỳ trước; YoY = kỳ hiện tại − cùng tháng năm trước.
          Phần trăm chỉ hiển thị khi kỳ gốc có dữ liệu và khác 0.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div
          className="relative w-full overflow-auto"
          role="region"
          aria-labelledby="comparison-table-title"
          tabIndex={0}
        >
          <table className="w-full caption-bottom text-sm">
            <TableCaption className="sr-only">
              So sánh doanh thu, chi phí, lợi nhuận và biên lợi nhuận giữa kỳ hiện tại,
              kỳ trước và cùng tháng năm trước.
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Chỉ số</TableHead>
                <TableHead scope="col" className="text-right">
                  {formatMonthTitle(filters.month)}
                </TableHead>
                <TableHead scope="col" className="text-right">
                  {formatMonthTitle(filters.prevMonth)}
                </TableHead>
                <TableHead scope="col" className="text-right">Δ tháng</TableHead>
                <TableHead scope="col" className="text-right">Δ tháng (%)</TableHead>
                <TableHead scope="col" className="text-right">
                  {formatMonthTitle(filters.yoyMonth)}
                </TableHead>
                <TableHead scope="col" className="text-right">Δ cùng kỳ</TableHead>
                <TableHead scope="col" className="text-right">Δ cùng kỳ (%)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {metrics.map(({ key, label }) => {
                const metric = comparison[key];
                const momDelta = absoluteDelta(metric.current, metric.previous);
                const yoyDelta = absoluteDelta(metric.current, metric.yearAgo);

                return (
                  <TableRow key={key}>
                    <th
                      scope="row"
                      className="p-4 text-left align-middle font-medium [&:has([role=checkbox])]:pr-0"
                    >
                      {label}
                    </th>
                    <TableCell className="text-right tabular-nums">
                      {formatNullableMoney(metric.current)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNullableMoney(metric.previous)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {momDelta === null ? "—" : formatCurrency(momDelta)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatPercent(metric.momPct)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNullableMoney(metric.yearAgo)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {yoyDelta === null ? "—" : formatCurrency(yoyDelta)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatPercent(metric.yoyPct)}
                    </TableCell>
                  </TableRow>
                );
              })}
              <TableRow className="bg-muted/40">
                <th
                  scope="row"
                  className="p-4 text-left align-middle font-medium [&:has([role=checkbox])]:pr-0"
                >
                  Biên lợi nhuận
                </th>
                <TableCell className="text-right tabular-nums">
                  {formatPercent(comparison.current?.marginPct ?? null)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatPercent(comparison.previous?.marginPct ?? null)}
                </TableCell>
                <TableCell colSpan={2} className="text-center text-muted-foreground">
                  Không áp dụng
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatPercent(comparison.yearAgo?.marginPct ?? null)}
                </TableCell>
                <TableCell colSpan={2} className="text-center text-muted-foreground">
                  Không áp dụng
                </TableCell>
              </TableRow>
            </TableBody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function TrendDataTable({ rows }: { rows: readonly TrendChartRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle id="trend-data-table-title" className="text-lg">
          Bảng dữ liệu thay thế cho biểu đồ
        </CardTitle>
        <CardDescription>
          Tháng không có dòng lãi/lỗ được hiển thị bằng 0 cho doanh thu, chi phí và lợi nhuận;
          các tỷ lệ không xác định hiển thị —.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div
          className="relative w-full overflow-auto"
          role="region"
          aria-labelledby="trend-data-table-title"
          tabIndex={0}
        >
          <table className="w-full caption-bottom text-sm">
            <TableCaption className="sr-only">
              Dữ liệu doanh thu, chi phí, lợi nhuận, biên lợi nhuận và tỷ lệ chi phí
              theo từng tháng trong cửa sổ 13 tháng.
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Tháng</TableHead>
                <TableHead scope="col" className="text-right">Doanh thu</TableHead>
                <TableHead scope="col" className="text-right">Chi phí</TableHead>
                <TableHead scope="col" className="text-right">Lợi nhuận</TableHead>
                <TableHead scope="col" className="text-right">Biên lợi nhuận</TableHead>
                <TableHead scope="col" className="text-right">Tỷ lệ chi phí</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.month}>
                  <th
                    scope="row"
                    className="p-4 text-left align-middle font-medium [&:has([role=checkbox])]:pr-0"
                  >
                    {formatMonthTitle(row.month)}
                  </th>
                  <TableCell className="text-right tabular-nums">
                    {formatNullableMoney(row.revenue)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNullableMoney(row.expense)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNullableMoney(row.net)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatPercent(row.marginPct)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatPercent(row.expenseRatioPct)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

export function TrendsComparisonTab({ filters }: TrendsComparisonTabProps) {
  const query = useBusinessPerformancePnl(filters);
  const queryState = deriveFinanceQueryState(query);
  const hasPhysicalScope = filters.buildingIds.length > 0;
  const physicalRows = useMemo(() => {
    const allowedBuildingIds = new Set(filters.buildingIds);
    return (query.data ?? []).filter(
      (row) => !row.is_virtual && allowedBuildingIds.has(row.building_id),
    );
  }, [filters.buildingIds, query.data]);
  const byMonth = useMemo(
    () =>
      aggregateBusinessPerformancePnl(physicalRows, [
        filters.yoyMonth,
        ...filters.months12,
      ]),
    [filters.months12, filters.yoyMonth, physicalRows],
  );
  const chartRows = useMemo(
    () => buildTrendRows(filters, byMonth),
    [byMonth, filters],
  );
  const comparison = useMemo(
    () => buildBusinessPerformanceComparison(physicalRows, filters),
    [filters, physicalRows],
  );

  if (!hasPhysicalScope) {
    return (
      <FinanceEmptyState
        title="Chưa có tòa vật lý trong phạm vi"
        description="Hãy chọn ít nhất một tòa vật lý để tải chuỗi xu hướng. Báo cáo không tự mở rộng sang tòa ảo."
      />
    );
  }

  if (queryState.showLoading) {
    return <FinanceLoadingGrid count={6} />;
  }

  if (queryState.hasBlockingError) {
    return (
      <FinanceQueryError
        title="Không thể tải xu hướng tài chính"
        error={queryState.blockingError}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {queryState.showStaleWarning ? (
        <StaleDataWarning onRetry={() => void query.refetch()} />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle id="money-trend-title" className="text-lg">
            Doanh thu, chi phí và lợi nhuận — 13 tháng
          </CardTitle>
          <CardDescription>
            Ba chuỗi dùng chung một trục tiền; tháng không có hoạt động được hiển thị bằng 0.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <figure aria-labelledby="money-trend-title">
            <div
              className="max-w-full overflow-x-auto"
              role="region"
              aria-labelledby="money-trend-title"
              tabIndex={0}
            >
              <div className="h-[320px] min-w-[680px] sm:h-[380px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={chartRows}
                    margin={{ top: 8, right: 12, bottom: 8, left: 0 }}
                    accessibilityLayer={false}
                  >
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                    <YAxis
                      tick={{ fontSize: 12 }}
                      tickFormatter={(value) => formatCompactMoney(Number(value))}
                      width={72}
                    />
                    <Tooltip content={<MoneyTooltip />} />
                    <Legend content={<PatternLegend series={MONEY_LEGEND_SERIES} />} />
                    <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="4 4" />
                    {(Object.keys(MONEY_SERIES) as ComparisonMetricKey[]).map((key) => (
                      <Line
                        key={key}
                        type="monotone"
                        dataKey={key}
                        name={MONEY_SERIES[key].label}
                        stroke={MONEY_SERIES[key].color}
                        strokeDasharray={MONEY_SERIES_STYLES[key].strokeDasharray}
                        strokeWidth={2.25}
                        dot={MONEY_SERIES_STYLES[key].dot}
                        activeDot={{ r: 5 }}
                        connectNulls={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            <figcaption className="sr-only">
              Biểu đồ đường doanh thu, chi phí và lợi nhuận trên cùng trục tiền.
              Bảng dữ liệu đầy đủ nằm sau các biểu đồ.
            </figcaption>
          </figure>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="ratio-trend-title" className="text-lg">
            Biên lợi nhuận và tỷ lệ chi phí — 13 tháng
          </CardTitle>
          <CardDescription>
            Hai chuỗi cùng đơn vị phần trăm và dùng một trục riêng, không ghép với trục tiền.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <figure aria-labelledby="ratio-trend-title">
            <div
              className="max-w-full overflow-x-auto"
              role="region"
              aria-labelledby="ratio-trend-title"
              tabIndex={0}
            >
              <div className="h-[300px] min-w-[680px] sm:h-[340px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={chartRows}
                    margin={{ top: 8, right: 12, bottom: 8, left: 0 }}
                    accessibilityLayer={false}
                  >
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                    <YAxis
                      tick={{ fontSize: 12 }}
                      tickFormatter={(value) => `${Number(value).toFixed(0)}%`}
                      width={56}
                    />
                    <Tooltip content={<PercentTooltip />} />
                    <Legend content={<PatternLegend series={RATIO_LEGEND_SERIES} />} />
                    <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="4 4" />
                    <Line
                      type="monotone"
                      dataKey="marginPct"
                      name={RATIO_SERIES.marginPct.label}
                      stroke={RATIO_SERIES.marginPct.color}
                      strokeWidth={2.25}
                      strokeDasharray={RATIO_SERIES.marginPct.strokeDasharray}
                      dot={RATIO_SERIES.marginPct.dot}
                      activeDot={{ r: 5 }}
                      connectNulls={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="expenseRatioPct"
                      name={RATIO_SERIES.expenseRatioPct.label}
                      stroke={RATIO_SERIES.expenseRatioPct.color}
                      strokeWidth={2.25}
                      strokeDasharray={RATIO_SERIES.expenseRatioPct.strokeDasharray}
                      dot={RATIO_SERIES.expenseRatioPct.dot}
                      activeDot={{ r: 5 }}
                      connectNulls={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            <figcaption className="sr-only">
              Biểu đồ đường biên lợi nhuận và tỷ lệ chi phí trên cùng một trục phần trăm.
              Bảng dữ liệu đầy đủ nằm ngay sau phần so sánh.
            </figcaption>
          </figure>
        </CardContent>
      </Card>

      <ComparisonTable comparison={comparison} filters={filters} />
      <TrendDataTable rows={chartRows} />
    </div>
  );
}
