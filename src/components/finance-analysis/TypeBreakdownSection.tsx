import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatCurrency } from "@/lib/utils";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { useFaMonthlyPnl, useFaTypeBreakdown } from "@/hooks/useFinancialAnalysis";
import type { AnalysisFilters } from "./types";
import {
  analyzeTypeBreakdown,
  compactVnd,
  COLOR_MUTED,
  fmtPct,
  monthTitle,
  sharePct,
  ymOf,
} from "./utils";
import { ChartCard } from "./ChartCard";
import { DeltaBadge } from "./DeltaBadge";

interface Props {
  filters: AnalysisFilters;
  side: "INCOME" | "EXPENSE";
  /** Màu series chính (thu emerald / chi đỏ). */
  mainColor: string;
  colorFn: (i: number) => string;
  /** true cho chi phí: tăng = xấu. */
  invert: boolean;
  /** "thu" | "chi" — ghép vào tiêu đề/labels. */
  noun: string;
  exportPrefix: string;
}

/** Khối phân tích cơ cấu theo hạng mục — dùng chung tab Doanh thu & Chi phí. */
export function TypeBreakdownSection({
  filters, side, mainColor, colorFn, invert, noun, exportPrefix,
}: Props) {
  const { ym, prevYm, t13Start, t13End, months12, buildingIds, accrual } = filters;
  const { data: breakdown = [], isLoading: bdLoading } = useFaTypeBreakdown(
    t13Start, t13End, buildingIds, accrual,
  );
  const { data: pnl = [], isLoading: pnlLoading } = useFaMonthlyPnl(t13Start, t13End, buildingIds, accrual);

  const analysis = useMemo(
    () => analyzeTypeBreakdown(breakdown, side, months12, ym, prevYm),
    [breakdown, side, months12, ym, prevYm],
  );

  const stackKeys = useMemo(
    () => [...analysis.topNames, ...(analysis.hasOther ? ["Khác"] : [])],
    [analysis],
  );

  const top5 = useMemo(
    () => analysis.donut.filter((d) => d.name !== "Khác").slice(0, 5),
    [analysis],
  );

  // Theo toà nhà (từ pnl — cache chung): giá trị side của tháng chọn vs tháng trước
  const buildingRows = useMemo(() => {
    const field = (r: { revenue: number; expense: number }) =>
      side === "INCOME" ? r.revenue : r.expense;
    const cur = pnl.filter((r) => ymOf(r.month) === ym);
    const prevBy = new Map(
      pnl.filter((r) => ymOf(r.month) === prevYm).map((r) => [r.building_id, field(r)]),
    );
    const total = cur.reduce((s, r) => s + field(r), 0);
    const rows = cur
      .map((r) => ({
        id: r.building_id,
        name: r.building_name,
        isVirtual: r.is_virtual,
        current: field(r),
        previous: prevBy.get(r.building_id) ?? null,
        share: sharePct(field(r), total),
      }))
      .filter((r) => r.current !== 0 || (r.previous ?? 0) !== 0);
    const real = rows.filter((r) => !r.isVirtual).sort((a, b) => b.current - a.current);
    return { rows: [...real, ...rows.filter((r) => r.isVirtual)], total };
  }, [pnl, side, ym, prevYm]);

  const typeExport = useMemo(
    () => [
      ...analysis.tableRows.map((r) => ({
        [`Loại ${noun}`]: r.name,
        "Nhóm": r.category ?? "",
        "Kỳ này": r.current,
        "Tỷ trọng (%)": r.share == null ? "" : Math.round(r.share * 10) / 10,
        "Kỳ trước": r.previous ?? "",
      })),
      { [`Loại ${noun}`]: "Tổng", "Nhóm": "", "Kỳ này": analysis.curTotal, "Tỷ trọng (%)": 100, "Kỳ trước": "" },
    ],
    [analysis, noun],
  );

  const qualityNote =
    analysis.uncategorizedPct != null && analysis.uncategorizedPct > 0 ? (
      <p className="text-xs text-amber-600">
        ⚠ {fmtPct(analysis.uncategorizedPct)} giá trị {noun} tháng này chưa gắn hạng mục — bổ sung
        hạng mục khi lập phiếu để cơ cấu chính xác hơn.
      </p>
    ) : undefined;

  const sideLabel = side === "INCOME" ? "Doanh thu" : "Chi phí";

  return (
    <div className="space-y-4">
      <ChartCard
        title={`${sideLabel} theo hạng mục — 12 tháng`}
        loading={bdLoading}
        empty={analysis.stacked.every((d) => stackKeys.every((k) => !d[k]))}
        height={360}
      >
        <ResponsiveContainer width="100%" height={360}>
          <BarChart data={analysis.stacked} barCategoryGap="22%">
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis dataKey="label" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} tickFormatter={compactVnd} width={70} />
            <Tooltip formatter={(v: any) => formatCurrency(Number(v))} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {stackKeys.map((k, i) => (
              <Bar
                key={k}
                dataKey={k}
                stackId="s"
                name={k}
                fill={k === "Khác" ? COLOR_MUTED : colorFn(i)}
                maxBarSize={36}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard
          title={`Cơ cấu ${noun} — ${monthTitle(ym)}`}
          loading={bdLoading}
          empty={analysis.donut.length === 0}
          footnote={qualityNote}
        >
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={analysis.donut}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={55}
                outerRadius={92}
                label={(e: any) => {
                  const p = sharePct(e.value, analysis.curTotal);
                  return p != null && p >= 4 ? `${Math.round(p)}%` : "";
                }}
              >
                {analysis.donut.map((d, i) => (
                  <Cell key={d.name} fill={d.name === "Khác" ? COLOR_MUTED : colorFn(i)} />
                ))}
              </Pie>
              <Tooltip formatter={(v: any) => formatCurrency(Number(v))} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title={`Top 5 ${side === "INCOME" ? "nguồn thu" : "khoản chi"} — ${monthTitle(ym)}`}
          loading={bdLoading}
          empty={top5.length === 0}
        >
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={top5} layout="vertical" margin={{ left: 8, right: 16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 12 }} tickFormatter={compactVnd} />
              <YAxis
                type="category"
                dataKey="name"
                width={150}
                tick={{ fontSize: 12 }}
              />
              <Tooltip formatter={(v: any) => formatCurrency(Number(v))} />
              <Bar dataKey="value" name={sideLabel} fill={mainColor} radius={[0, 4, 4, 0]} maxBarSize={22} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <ChartCard
        title={`${sideLabel} theo hạng mục — ${monthTitle(ym)}`}
        action={<ExportButtons data={typeExport} filename={`${exportPrefix}-theo-loai-${ym}`} />}
        height={200}
      >
        <div className="overflow-x-auto -mx-6 px-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Loại {noun}</TableHead>
                <TableHead>Nhóm</TableHead>
                <TableHead className="text-right">Kỳ này</TableHead>
                <TableHead className="text-right">Tỷ trọng</TableHead>
                <TableHead className="text-right">Kỳ trước</TableHead>
                <TableHead className="text-right">Δ</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bdLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={6}><Skeleton className="h-6 w-full" /></TableCell>
                  </TableRow>
                ))
              ) : analysis.tableRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                    Không có dữ liệu trong kỳ này
                  </TableCell>
                </TableRow>
              ) : (
                <>
                  {analysis.tableRows.map((r) => (
                    <TableRow key={r.name}>
                      <TableCell className="font-medium">{r.name}</TableCell>
                      <TableCell className="text-muted-foreground">{r.category ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(r.current)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtPct(r.share)}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {r.previous == null ? "—" : formatCurrency(r.previous)}
                      </TableCell>
                      <TableCell className="text-right">
                        <DeltaBadge current={r.current} previous={r.previous} invert={invert} />
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="bg-muted/60 font-bold border-t-2">
                    <TableCell>Tổng</TableCell>
                    <TableCell />
                    <TableCell className="text-right tabular-nums">{formatCurrency(analysis.curTotal)}</TableCell>
                    <TableCell className="text-right">100%</TableCell>
                    <TableCell />
                    <TableCell />
                  </TableRow>
                </>
              )}
            </TableBody>
          </Table>
        </div>
      </ChartCard>

      <ChartCard title={`${sideLabel} theo toà nhà — ${monthTitle(ym)}`} height={200}>
        <div className="overflow-x-auto -mx-6 px-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Toà nhà</TableHead>
                <TableHead className="text-right">Kỳ này</TableHead>
                <TableHead className="text-right">Tỷ trọng</TableHead>
                <TableHead className="text-right">Kỳ trước</TableHead>
                <TableHead className="text-right">Δ</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pnlLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={5}><Skeleton className="h-6 w-full" /></TableCell>
                  </TableRow>
                ))
              ) : buildingRows.rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                    Không có dữ liệu trong kỳ này
                  </TableCell>
                </TableRow>
              ) : (
                <>
                  {buildingRows.rows.map((r) => (
                    <TableRow key={r.id} className={r.isVirtual ? "bg-muted/30" : undefined}>
                      <TableCell className="font-medium whitespace-nowrap">
                        {r.name}
                        {r.isVirtual && (
                          <span className="ml-1 text-xs text-muted-foreground">(chi phí chung)</span>
                        )}
                      </TableCell>
                      <TableCell className={cn("text-right tabular-nums", side === "INCOME" ? "text-emerald-700" : "text-red-700")}>
                        {formatCurrency(r.current)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmtPct(r.share)}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {r.previous == null ? "—" : formatCurrency(r.previous)}
                      </TableCell>
                      <TableCell className="text-right">
                        <DeltaBadge current={r.current} previous={r.previous} invert={invert} />
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="bg-muted/60 font-bold border-t-2">
                    <TableCell>Tổng</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(buildingRows.total)}</TableCell>
                    <TableCell className="text-right">100%</TableCell>
                    <TableCell />
                    <TableCell />
                  </TableRow>
                </>
              )}
            </TableBody>
          </Table>
        </div>
      </ChartCard>
    </div>
  );
}
