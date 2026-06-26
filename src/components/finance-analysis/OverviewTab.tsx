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
import {
  DoorOpen,
  Home,
  Lock,
  Percent,
  Receipt,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, cn } from "@/lib/utils";
import { ExportButtons } from "@/components/reports/ExportButtons";
import {
  useFaInvoiceCollection,
  useFaMonthlyPnl,
  useFaOccupancyMonthly,
  useFaSnapshotKpis,
  useFaTypeBreakdown,
} from "@/hooks/useFinancialAnalysis";
import type { AnalysisFilters } from "./types";
import {
  aggregatePnlByMonth,
  buildInsights,
  collectionRate,
  compactVnd,
  COLOR_EXPENSE,
  COLOR_INCOME,
  COLOR_NET,
  fmtPct,
  marginPct,
  monthLabel,
  monthTitle,
  occupancyAgg,
  scaffoldMonths,
  sharePct,
  ymOf,
} from "./utils";
import { KpiCard } from "./KpiCard";
import { ChartCard } from "./ChartCard";
import { DeltaBadge } from "./DeltaBadge";
import { InsightsPanel } from "./InsightsPanel";

interface Props {
  filters: AnalysisFilters;
}

export function OverviewTab({ filters }: Props) {
  const { ym, prevYm, yoyYm, t13Start, t13End, t13StartYm, months12, buildingIds, accrual } = filters;

  const { data: pnl = [], isLoading: pnlLoading } = useFaMonthlyPnl(t13Start, t13End, buildingIds, accrual);
  const { data: snapshot = [], isLoading: snapLoading } = useFaSnapshotKpis(buildingIds);
  const { data: occupancy = [], isLoading: occLoading } = useFaOccupancyMonthly(
    t13Start, t13End, buildingIds,
  );
  // 2 query dưới fetch cả cửa sổ 13 tháng — tab Doanh thu/Chi phí/Vận hành
  // dùng chung query key nên không tốn thêm round-trip khi chuyển tab.
  const { data: breakdown = [] } = useFaTypeBreakdown(t13Start, t13End, buildingIds, accrual);
  const { data: collection = [] } = useFaInvoiceCollection(t13StartYm, ym, buildingIds);

  const byMonth = useMemo(() => aggregatePnlByMonth(pnl), [pnl]);
  const cur = byMonth.get(ym);
  const prev = byMonth.get(prevYm);
  const yoy = byMonth.get(yoyYm);

  const chartData = useMemo(
    () =>
      scaffoldMonths(months12, byMonth).map((m) => ({
        label: monthLabel(m.ym),
        revenue: m.revenue,
        expense: m.expense,
        net: m.net,
      })),
    [months12, byMonth],
  );

  // Lấp đầy tháng chọn / tháng trước / cùng kỳ (trọng số theo phòng)
  const occOf = (targetYm: string) => occupancy.filter((r) => ymOf(r.month) === targetYm);
  const occCur = occupancyAgg(occOf(ym));
  const occPrev = occupancyAgg(occOf(prevYm));
  const occYoy = occupancyAgg(occOf(yoyYm));
  const occCurRows = occOf(ym);
  const occTotalRooms = occCurRows.reduce((s, r) => s + r.total_rooms, 0);
  const occOccupied = occCurRows.reduce((s, r) => s + r.occupied_rooms, 0);

  // Snapshot gộp mọi toà
  const snap = useMemo(() => {
    const s = {
      vacancyLoss: 0, available: 0, receivable: 0, deposit: 0,
      actives: 0, rentSum: 0, agingOver90: 0,
    };
    for (const r of snapshot) {
      s.vacancyLoss += r.vacancy_loss_month;
      s.available += r.rooms_available;
      s.receivable += r.receivable_total;
      s.deposit += r.deposit_held;
      s.actives += r.active_contracts;
      s.rentSum += r.avg_rent * r.active_contracts;
      s.agingOver90 += r.aging_over_90;
    }
    return s;
  }, [snapshot]);
  const arpu = snap.actives > 0 ? snap.rentSum / snap.actives : 0;

  // Bảng so sánh theo toà (tháng chọn): toà thật sort DT desc, "Chung" ghim cuối
  const buildingRows = useMemo(() => {
    const curRows = pnl.filter((r) => ymOf(r.month) === ym);
    const prevNet = new Map(
      pnl.filter((r) => ymOf(r.month) === prevYm).map((r) => [r.building_id, r.net]),
    );
    const roomsBy = new Map(snapshot.map((r) => [r.building_id, r.total_rooms]));
    const rows = curRows.map((r) => ({
      id: r.building_id,
      name: r.building_name,
      isVirtual: r.is_virtual,
      revenue: r.revenue,
      expense: r.expense,
      net: r.net,
      margin: marginPct(r.net, r.revenue),
      netPerRoom:
        !r.is_virtual && (roomsBy.get(r.building_id) ?? 0) > 0
          ? r.net / roomsBy.get(r.building_id)!
          : null,
      prevNet: prevNet.get(r.building_id) ?? null,
    }));
    const real = rows.filter((r) => !r.isVirtual).sort((a, b) => b.revenue - a.revenue);
    const virtual = rows.filter((r) => r.isVirtual);
    return [...real, ...virtual];
  }, [pnl, snapshot, ym, prevYm]);

  const totals = useMemo(() => {
    const t = { revenue: 0, expense: 0, net: 0 };
    for (const r of buildingRows) {
      t.revenue += r.revenue;
      t.expense += r.expense;
      t.net += r.net;
    }
    return t;
  }, [buildingRows]);

  // Nhận định tự động
  const insights = useMemo(() => {
    const colCur = collection.filter((r) => r.billing_month === ym);
    const billed = colCur.reduce((s, r) => s + r.billed, 0);
    const collected = colCur.reduce((s, r) => s + r.collected, 0);
    const bdCur = breakdown.filter((r) => ymOf(r.month) === ym);
    const uncatPct = (side: "INCOME" | "EXPENSE") => {
      const rows = bdCur.filter((r) => r.side === side);
      const total = rows.reduce((s, r) => s + r.total_amount, 0);
      const uncat = rows.filter((r) => r.type_id == null).reduce((s, r) => s + r.total_amount, 0);
      return sharePct(uncat, total);
    };
    return buildInsights({
      ym,
      byMonth,
      occupancyPct: occCur,
      vacantRooms: snap.available,
      vacancyLoss: snap.vacancyLoss,
      collection: billed > 0 ? { billed, collected } : null,
      agingOver90: snap.agingOver90,
      buildingNets: buildingRows.map((r) => ({ name: r.name, net: r.net, isVirtual: r.isVirtual })),
      uncategorizedIncomePct: uncatPct("INCOME"),
      uncategorizedExpensePct: uncatPct("EXPENSE"),
    });
  }, [ym, byMonth, occCur, snap, buildingRows, collection, breakdown]);

  const exportRows = useMemo(
    () => [
      ...buildingRows.map((r) => ({
        "Toà nhà": r.name,
        "Doanh thu": r.revenue,
        "Chi phí": r.expense,
        "Lợi nhuận": r.net,
        "Biên LN (%)": r.margin == null ? "" : Math.round(r.margin * 10) / 10,
        "LN/phòng": r.netPerRoom == null ? "" : Math.round(r.netPerRoom),
        "LN kỳ trước": r.prevNet ?? "",
      })),
      {
        "Toà nhà": "Tổng",
        "Doanh thu": totals.revenue,
        "Chi phí": totals.expense,
        "Lợi nhuận": totals.net,
        "Biên LN (%)": marginPct(totals.net, totals.revenue) == null ? "" : Math.round(marginPct(totals.net, totals.revenue)! * 10) / 10,
        "LN/phòng": "",
        "LN kỳ trước": "",
      },
    ],
    [buildingRows, totals],
  );

  const margin = cur ? marginPct(cur.net, cur.revenue) : null;
  const prevMargin = prev ? marginPct(prev.net, prev.revenue) : null;
  const yoyMargin = yoy ? marginPct(yoy.net, yoy.revenue) : null;

  return (
    <div className="space-y-4">
      {/* KPI hàng 1 — tài chính */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <KpiCard
          label={`Doanh thu ${monthTitle(ym)}`}
          value={formatCurrency(cur?.revenue ?? 0)}
          icon={TrendingUp}
          accent="emerald"
          loading={pnlLoading}
          mom={{ current: cur?.revenue ?? 0, previous: prev?.revenue ?? null }}
          yoy={{ current: cur?.revenue ?? 0, previous: yoy?.revenue ?? null }}
        />
        <KpiCard
          label={`Chi phí ${monthTitle(ym)}`}
          value={formatCurrency(cur?.expense ?? 0)}
          icon={TrendingDown}
          accent="red"
          loading={pnlLoading}
          mom={{ current: cur?.expense ?? 0, previous: prev?.expense ?? null, invert: true }}
          yoy={{ current: cur?.expense ?? 0, previous: yoy?.expense ?? null, invert: true }}
        />
        <KpiCard
          label="Lợi nhuận ròng"
          value={formatCurrency(cur?.net ?? 0)}
          icon={Wallet}
          accent="blue"
          loading={pnlLoading}
          mom={{ current: cur?.net ?? 0, previous: prev?.net ?? null }}
          yoy={{ current: cur?.net ?? 0, previous: yoy?.net ?? null }}
        />
        <KpiCard
          label="Biên lợi nhuận"
          value={fmtPct(margin)}
          icon={Percent}
          accent="violet"
          loading={pnlLoading}
          mom={margin != null && prevMargin != null ? { current: margin, previous: prevMargin } : undefined}
          yoy={margin != null && yoyMargin != null ? { current: margin, previous: yoyMargin } : undefined}
        />
      </div>

      {/* KPI hàng 2 — vận hành */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <KpiCard
          label="Tỷ lệ lấp đầy"
          value={fmtPct(occCur)}
          icon={Home}
          accent="blue"
          loading={occLoading}
          sub={`${occOccupied}/${occTotalRooms} phòng có khách`}
          mom={occCur != null && occPrev != null ? { current: occCur, previous: occPrev } : undefined}
          yoy={occCur != null && occYoy != null ? { current: occCur, previous: occYoy } : undefined}
        />
        <KpiCard
          label="Phòng trống hiện tại"
          value={`${snap.available} phòng`}
          icon={DoorOpen}
          accent="amber"
          loading={snapLoading}
          sub={`Thiệt hại ~${formatCurrency(snap.vacancyLoss)}/tháng`}
        />
        <KpiCard
          label="Phải thu hoá đơn"
          value={formatCurrency(snap.receivable)}
          icon={Receipt}
          accent="red"
          loading={snapLoading}
          sub="Hoá đơn đã duyệt chưa thu đủ"
        />
        <KpiCard
          label="Cọc đang giữ"
          value={formatCurrency(snap.deposit)}
          icon={Lock}
          accent="slate"
          loading={snapLoading}
          sub={`${snap.actives} HĐ hiệu lực · TB ${compactVnd(arpu)}/HĐ`}
        />
      </div>

      <InsightsPanel insights={insights} loading={pnlLoading || snapLoading} />

      <ChartCard
        title="Doanh thu · Chi phí · Lợi nhuận — 12 tháng"
        loading={pnlLoading}
        empty={chartData.every((d) => d.revenue === 0 && d.expense === 0)}
        height={360}
      >
        <ResponsiveContainer width="100%" height={360}>
          <ComposedChart data={chartData} barCategoryGap="22%">
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis dataKey="label" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} tickFormatter={compactVnd} width={70} />
            <Tooltip formatter={(v: any) => formatCurrency(Number(v))} />
            <Legend />
            <Bar dataKey="revenue" name="Doanh thu" fill={COLOR_INCOME} radius={[4, 4, 0, 0]} maxBarSize={28} />
            <Bar dataKey="expense" name="Chi phí" fill={COLOR_EXPENSE} radius={[4, 4, 0, 0]} maxBarSize={28} />
            <Line type="monotone" dataKey="net" name="Lợi nhuận" stroke={COLOR_NET} strokeWidth={2} dot={{ r: 3 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard
        title={`So sánh theo toà nhà — ${monthTitle(ym)}`}
        action={<ExportButtons data={exportRows} filename={`phan-tich-theo-toa-${ym}`} />}
        loading={false}
        height={200}
      >
        <div className="overflow-x-auto -mx-6 px-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Toà nhà</TableHead>
                <TableHead className="text-right">Doanh thu</TableHead>
                <TableHead className="text-right">Chi phí</TableHead>
                <TableHead className="text-right">Lợi nhuận</TableHead>
                <TableHead className="text-right">Biên LN</TableHead>
                <TableHead className="text-right">LN/phòng</TableHead>
                <TableHead className="text-right">So kỳ trước</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pnlLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={7}><Skeleton className="h-6 w-full" /></TableCell>
                  </TableRow>
                ))
              ) : buildingRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                    Không có dữ liệu trong kỳ này
                  </TableCell>
                </TableRow>
              ) : (
                <>
                  {buildingRows.map((r) => (
                    <TableRow key={r.id} className={r.isVirtual ? "bg-muted/30" : undefined}>
                      <TableCell className="font-medium whitespace-nowrap">
                        {r.name}
                        {r.isVirtual && (
                          <span className="ml-1 text-xs text-muted-foreground">(chi phí chung)</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-emerald-700">
                        {formatCurrency(r.revenue)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-red-700">
                        {formatCurrency(r.expense)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right tabular-nums font-medium",
                          r.net >= 0 ? "text-blue-700" : "text-red-700",
                        )}
                      >
                        {formatCurrency(r.net)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmtPct(r.margin)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.netPerRoom == null ? "—" : formatCurrency(r.netPerRoom)}
                      </TableCell>
                      <TableCell className="text-right">
                        <DeltaBadge current={r.net} previous={r.prevNet} />
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="bg-muted/60 font-bold border-t-2">
                    <TableCell>Tổng</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(totals.revenue)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(totals.expense)}</TableCell>
                    <TableCell className={cn("text-right tabular-nums", totals.net >= 0 ? "text-blue-700" : "text-red-700")}>
                      {formatCurrency(totals.net)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmtPct(marginPct(totals.net, totals.revenue))}
                    </TableCell>
                    <TableCell className="text-right">—</TableCell>
                    <TableCell className="text-right">
                      <DeltaBadge current={totals.net} previous={prev?.net ?? null} />
                    </TableCell>
                  </TableRow>
                </>
              )}
            </TableBody>
          </Table>
        </div>
      </ChartCard>

      {/* Tỷ lệ thu hồi kỳ hiện tại (tham chiếu nhanh — chi tiết ở tab Vận hành) */}
      {(() => {
        const colCur = collection.filter((r) => r.billing_month === ym);
        const billed = colCur.reduce((s, r) => s + r.billed, 0);
        if (billed <= 0) return null;
        const collected = colCur.reduce((s, r) => s + r.collected, 0);
        const rate = collectionRate(collected, billed);
        return (
          <p className="text-xs text-muted-foreground">
            Thu hồi hoá đơn kỳ {monthTitle(ym)}: đã thu {formatCurrency(collected)} /{" "}
            {formatCurrency(billed)} ({fmtPct(rate)}) — xem chi tiết & tuổi nợ ở tab Vận hành.
          </p>
        );
      })()}
    </div>
  );
}
