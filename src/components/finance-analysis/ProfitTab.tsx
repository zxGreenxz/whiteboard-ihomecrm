import { useMemo } from "react";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn, formatCurrency } from "@/lib/utils";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { useFaMonthlyPnl } from "@/hooks/useFinancialAnalysis";
import type { AnalysisFilters } from "./types";
import {
  aggregatePnlByMonth,
  compactVnd,
  COLOR_EXPENSE,
  COLOR_NET,
  COLOR_RATIO,
  heatClass,
  marginPct,
  monthLabel,
  monthsRange,
  scaffoldMonths,
  ymOf,
} from "./utils";
import { ChartCard } from "./ChartCard";

interface Props {
  filters: AnalysisFilters;
}

/** Tab Lợi nhuận — biên LN, ma trận LN toà × tháng, luỹ kế YTD. */
export function ProfitTab({ filters }: Props) {
  const { ym, t13Start, t13End, months12, buildingIds } = filters;
  const { data: pnl = [], isLoading } = useFaMonthlyPnl(t13Start, t13End, buildingIds);

  const byMonth = useMemo(() => aggregatePnlByMonth(pnl), [pnl]);

  const chartData = useMemo(
    () =>
      scaffoldMonths(months12, byMonth).map((m) => ({
        label: monthLabel(m.ym),
        net: m.net,
        margin: marginPct(m.net, m.revenue),
      })),
    [months12, byMonth],
  );

  // Ma trận LN: toà thật A→Z, "Chung" cuối; cột = months12 + "Cả kỳ"
  const matrix = useMemo(() => {
    const monthSet = new Set(months12);
    const byBuilding = new Map<
      string,
      { name: string; isVirtual: boolean; byYm: Map<string, number>; total: number }
    >();
    for (const r of pnl) {
      const rym = ymOf(r.month);
      if (!monthSet.has(rym)) continue;
      const b =
        byBuilding.get(r.building_id) ??
        { name: r.building_name, isVirtual: r.is_virtual, byYm: new Map(), total: 0 };
      b.byYm.set(rym, (b.byYm.get(rym) ?? 0) + r.net);
      b.total += r.net;
      byBuilding.set(r.building_id, b);
    }
    const all = [...byBuilding.values()];
    const rows = [
      ...all.filter((b) => !b.isVirtual).sort((a, b) => a.name.localeCompare(b.name, "vi")),
      ...all.filter((b) => b.isVirtual),
    ];
    let maxAbs = 0;
    for (const b of rows) for (const v of b.byYm.values()) maxAbs = Math.max(maxAbs, Math.abs(v));
    const colTotals = months12.map((m) =>
      rows.reduce((s, b) => s + (b.byYm.get(m) ?? 0), 0),
    );
    const grand = colTotals.reduce((s, v) => s + v, 0);
    return { rows, maxAbs, colTotals, grand };
  }, [pnl, months12]);

  // Luỹ kế YTD của năm đang chọn (T1 → tháng chọn)
  const ytdData = useMemo(() => {
    const year = ym.slice(0, 4);
    const count = Number(ym.slice(5, 7));
    const months = monthsRange(ym, count).filter((m) => m.startsWith(year));
    let cum = 0;
    return months.map((m) => {
      cum += byMonth.get(m)?.net ?? 0;
      return { label: `T${Number(m.slice(5, 7))}`, cumNet: cum };
    });
  }, [ym, byMonth]);

  const matrixExport = useMemo(
    () => [
      ...matrix.rows.map((b) => ({
        "Toà nhà": b.name,
        ...Object.fromEntries(months12.map((m) => [monthLabel(m), b.byYm.get(m) ?? 0])),
        "Cả kỳ": b.total,
      })),
      {
        "Toà nhà": "Tổng",
        ...Object.fromEntries(months12.map((m, i) => [monthLabel(m), matrix.colTotals[i]])),
        "Cả kỳ": matrix.grand,
      },
    ],
    [matrix, months12],
  );

  return (
    <div className="space-y-4">
      <ChartCard
        title="Lợi nhuận & biên lợi nhuận — 12 tháng"
        loading={isLoading}
        empty={chartData.every((d) => d.net === 0)}
        height={340}
      >
        <ResponsiveContainer width="100%" height={340}>
          <ComposedChart data={chartData} barCategoryGap="22%">
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
                name === "Biên LN"
                  ? value == null
                    ? "—"
                    : `${Number(value).toFixed(1)}%`
                  : formatCurrency(Number(value))
              }
            />
            <Legend />
            <Bar yAxisId="left" dataKey="net" name="Lợi nhuận" radius={[4, 4, 0, 0]} maxBarSize={32}>
              {chartData.map((d, i) => (
                <Cell key={i} fill={d.net >= 0 ? COLOR_NET : COLOR_EXPENSE} />
              ))}
            </Bar>
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="margin"
              name="Biên LN"
              stroke={COLOR_RATIO}
              strokeWidth={2}
              dot={{ r: 3 }}
              connectNulls={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard
        title="Ma trận lợi nhuận — toà × tháng"
        action={<ExportButtons data={matrixExport} filename={`loi-nhuan-toa-x-thang-${ym}`} />}
        loading={isLoading}
        empty={matrix.rows.length === 0}
        height={240}
        footnote={
          <p className="text-xs text-muted-foreground">
            Ô màu xanh = lãi, đỏ = lỗ (đậm dần theo độ lớn). Di chuột lên ô để xem số đầy đủ.
          </p>
        }
      >
        <div className="overflow-x-auto -mx-6 px-6">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b">
                <th className="sticky left-0 z-10 bg-card text-left font-medium px-2 py-2 whitespace-nowrap">
                  Toà nhà
                </th>
                {months12.map((m) => (
                  <th key={m} className="text-right font-medium px-2 py-2 whitespace-nowrap">
                    {monthLabel(m)}
                  </th>
                ))}
                <th className="text-right font-semibold px-2 py-2 whitespace-nowrap">Cả kỳ</th>
              </tr>
            </thead>
            <tbody>
              {matrix.rows.map((b) => (
                <tr key={b.name} className="border-b last:border-0">
                  <td
                    className={cn(
                      "sticky left-0 z-10 bg-card px-2 py-1.5 font-medium whitespace-nowrap",
                      b.isVirtual && "text-muted-foreground",
                    )}
                  >
                    {b.name}
                  </td>
                  {months12.map((m) => {
                    const v = b.byYm.get(m) ?? 0;
                    return (
                      <td
                        key={m}
                        title={formatCurrency(v)}
                        className={cn(
                          "text-right tabular-nums px-2 py-1.5 whitespace-nowrap",
                          heatClass(v, matrix.maxAbs),
                        )}
                      >
                        {v === 0 ? "·" : compactVnd(v)}
                      </td>
                    );
                  })}
                  <td
                    title={formatCurrency(b.total)}
                    className={cn(
                      "text-right tabular-nums px-2 py-1.5 font-semibold whitespace-nowrap",
                      b.total >= 0 ? "text-blue-700" : "text-red-700",
                    )}
                  >
                    {compactVnd(b.total)}
                  </td>
                </tr>
              ))}
              <tr className="bg-muted/60 font-bold border-t-2">
                <td className="sticky left-0 z-10 bg-muted px-2 py-1.5">Tổng</td>
                {matrix.colTotals.map((v, i) => (
                  <td
                    key={i}
                    title={formatCurrency(v)}
                    className={cn(
                      "text-right tabular-nums px-2 py-1.5 whitespace-nowrap",
                      v >= 0 ? "text-blue-700" : "text-red-700",
                    )}
                  >
                    {compactVnd(v)}
                  </td>
                ))}
                <td
                  title={formatCurrency(matrix.grand)}
                  className={cn(
                    "text-right tabular-nums px-2 py-1.5 whitespace-nowrap",
                    matrix.grand >= 0 ? "text-blue-700" : "text-red-700",
                  )}
                >
                  {compactVnd(matrix.grand)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </ChartCard>

      <ChartCard
        title={`Lợi nhuận luỹ kế từ đầu năm ${ym.slice(0, 4)}`}
        loading={isLoading}
        empty={ytdData.length === 0}
        height={300}
      >
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={ytdData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis dataKey="label" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} tickFormatter={compactVnd} width={70} />
            <Tooltip formatter={(v: any) => formatCurrency(Number(v))} />
            <ReferenceLine y={0} stroke="#9CA3AF" strokeDasharray="3 3" />
            <Line
              type="monotone"
              dataKey="cumNet"
              name="LN luỹ kế"
              stroke={COLOR_NET}
              strokeWidth={2}
              dot={{ r: 4 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}
