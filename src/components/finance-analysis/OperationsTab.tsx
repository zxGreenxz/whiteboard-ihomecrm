import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { FileSignature, HandCoins, Wallet } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatCurrency } from "@/lib/utils";
import { ExportButtons } from "@/components/reports/ExportButtons";
import {
  useFaInvoiceCollection,
  useFaLeaseEvents,
  useFaOccupancyMonthly,
  useFaSnapshotKpis,
} from "@/hooks/useFinancialAnalysis";
import type { AnalysisFilters } from "./types";
import {
  collectionRate,
  colorAt,
  compactVnd,
  COLOR_EXPENSE,
  COLOR_INCOME,
  COLOR_MUTED,
  COLOR_NET,
  COLOR_RATIO,
  fmtPct,
  monthLabel,
  occupancyAgg,
  sharePct,
  ymOf,
} from "./utils";
import { ChartCard } from "./ChartCard";

interface Props {
  filters: AnalysisFilters;
}

const ROOM_STATUS_META: { key: string; label: string; color: string }[] = [
  { key: "rooms_occupied", label: "Đang thuê", color: COLOR_INCOME },
  { key: "rooms_available", label: "Trống", color: COLOR_MUTED },
  { key: "rooms_reserved", label: "Đã cọc", color: COLOR_RATIO },
  { key: "rooms_maintenance", label: "Bảo trì", color: COLOR_EXPENSE },
  { key: "rooms_unavailable", label: "Ngưng cho thuê", color: "#475569" },
];

/** Tab Vận hành — lấp đầy, biến động HĐ, thu hồi hoá đơn, tuổi nợ, trạng thái phòng. */
export function OperationsTab({ filters }: Props) {
  const { ym, t13Start, t13End, t13StartYm, months12, buildingIds } = filters;

  const { data: occupancy = [], isLoading: occLoading } = useFaOccupancyMonthly(
    t13Start, t13End, buildingIds,
  );
  const { data: leaseEvents = [], isLoading: leaseLoading } = useFaLeaseEvents(
    t13Start, t13End, buildingIds,
  );
  const { data: collection = [], isLoading: colLoading } = useFaInvoiceCollection(
    t13StartYm, ym, buildingIds,
  );
  const { data: snapshot = [], isLoading: snapLoading } = useFaSnapshotKpis(buildingIds);

  // ── Lấp đầy 12 tháng: đường "Tổng" + từng toà khi ≤ 8 toà ──────────
  const occBuildings = useMemo(
    () => [...new Set(occupancy.map((r) => r.building_name))].sort((a, b) => a.localeCompare(b, "vi")),
    [occupancy],
  );
  const showPerBuilding = occBuildings.length > 1 && occBuildings.length <= 8;
  const occChart = useMemo(
    () =>
      months12.map((m) => {
        const rows = occupancy.filter((r) => ymOf(r.month) === m);
        const d: Record<string, number | string | null> = {
          label: monthLabel(m),
          "Tổng": occupancyAgg(rows),
        };
        if (showPerBuilding) {
          for (const r of rows) d[r.building_name] = r.total_rooms > 0 ? r.occupancy_pct : null;
        }
        return d;
      }),
    [occupancy, months12, showPerBuilding],
  );

  // ── Biến động hợp đồng (cộng mọi toà theo tháng) ────────────────────
  const leaseChart = useMemo(
    () =>
      months12.map((m) => {
        const rows = leaseEvents.filter((r) => ymOf(r.month) === m);
        return {
          label: monthLabel(m),
          new_contracts: rows.reduce((s, r) => s + r.new_contracts, 0),
          renewals: rows.reduce((s, r) => s + r.renewals, 0),
          terminations: rows.reduce((s, r) => s + r.terminations, 0),
        };
      }),
    [leaseEvents, months12],
  );

  // ── Thu hồi hoá đơn theo kỳ ─────────────────────────────────────────
  const collectionRows = useMemo(
    () =>
      months12.map((m) => {
        const rows = collection.filter((r) => r.billing_month === m);
        const billed = rows.reduce((s, r) => s + r.billed, 0);
        const collected = rows.reduce((s, r) => s + r.collected, 0);
        const remaining = rows.reduce((s, r) => s + r.remaining, 0);
        return { ym: m, label: monthLabel(m), billed, collected, remaining, rate: collectionRate(collected, billed) };
      }),
    [collection, months12],
  );
  const collectionExport = useMemo(
    () =>
      collectionRows.map((r) => ({
        "Kỳ": r.ym,
        "Phải thu": r.billed,
        "Đã thu": r.collected,
        "Còn lại": r.remaining,
        "Tỷ lệ thu (%)": r.rate == null ? "" : Math.round(r.rate * 10) / 10,
      })),
    [collectionRows],
  );

  // ── Snapshot gộp: tuổi nợ + trạng thái phòng + chỉ số HĐ ────────────
  const snap = useMemo(() => {
    const s: Record<string, number> = {
      rooms_occupied: 0, rooms_available: 0, rooms_reserved: 0,
      rooms_maintenance: 0, rooms_unavailable: 0,
      receivable: 0, not_due: 0, a1: 0, a2: 0, a3: 0, a4: 0,
      actives: 0, rentSum: 0, deposit: 0,
    };
    for (const r of snapshot) {
      s.rooms_occupied += r.rooms_occupied;
      s.rooms_available += r.rooms_available;
      s.rooms_reserved += r.rooms_reserved;
      s.rooms_maintenance += r.rooms_maintenance;
      s.rooms_unavailable += r.rooms_unavailable;
      s.receivable += r.receivable_total;
      s.not_due += r.aging_not_due;
      s.a1 += r.aging_1_30;
      s.a2 += r.aging_31_60;
      s.a3 += r.aging_61_90;
      s.a4 += r.aging_over_90;
      s.actives += r.active_contracts;
      s.rentSum += r.avg_rent * r.active_contracts;
      s.deposit += r.deposit_held;
    }
    return s;
  }, [snapshot]);

  const agingCards = [
    { label: "Chưa tới hạn", value: snap.not_due, cls: "border-l-slate-400" },
    { label: "Quá hạn 1–30 ngày", value: snap.a1, cls: "border-l-amber-500" },
    { label: "Quá hạn 31–60 ngày", value: snap.a2, cls: "border-l-orange-500" },
    { label: "Quá hạn 61–90 ngày", value: snap.a3, cls: "border-l-red-400" },
    { label: "Quá hạn > 90 ngày", value: snap.a4, cls: "border-l-red-700" },
  ];

  const roomDonut = ROOM_STATUS_META.map((m) => ({
    name: m.label,
    value: snap[m.key] ?? 0,
    color: m.color,
  })).filter((d) => d.value > 0);
  const totalRooms = roomDonut.reduce((s, d) => s + d.value, 0);
  const arpu = snap.actives > 0 ? snap.rentSum / snap.actives : 0;

  return (
    <div className="space-y-4">
      <ChartCard
        title="Tỷ lệ lấp đầy — 12 tháng"
        loading={occLoading}
        empty={occupancy.length === 0}
        height={320}
        footnote={
          !showPerBuilding && occBuildings.length > 8 ? (
            <p className="text-xs text-muted-foreground">
              Đang xem {occBuildings.length} toà — chọn ≤ 8 toà ở bộ lọc để xem đường từng toà.
            </p>
          ) : undefined
        }
      >
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={occChart}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis dataKey="label" tick={{ fontSize: 12 }} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 12 }} tickFormatter={(v: number) => `${v}%`} />
            <Tooltip formatter={(v: any) => (v == null ? "—" : `${Number(v).toFixed(1)}%`)} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line
              type="monotone"
              dataKey="Tổng"
              stroke="#111827"
              strokeWidth={2.5}
              dot={{ r: 3 }}
            />
            {showPerBuilding &&
              occBuildings.map((name, i) => (
                <Line
                  key={name}
                  type="monotone"
                  dataKey={name}
                  stroke={colorAt(i)}
                  strokeWidth={1.5}
                  dot={false}
                  connectNulls={false}
                />
              ))}
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard
        title="Biến động hợp đồng — 12 tháng"
        loading={leaseLoading}
        empty={leaseChart.every((d) => !d.new_contracts && !d.renewals && !d.terminations)}
        height={300}
      >
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={leaseChart} barCategoryGap="20%">
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis dataKey="label" tick={{ fontSize: 12 }} />
            <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
            <Tooltip />
            <Legend />
            <Bar dataKey="new_contracts" name="HĐ ký mới" fill={COLOR_INCOME} maxBarSize={16} radius={[3, 3, 0, 0]} />
            <Bar dataKey="renewals" name="Gia hạn" fill={COLOR_NET} maxBarSize={16} radius={[3, 3, 0, 0]} />
            <Bar dataKey="terminations" name="Trả phòng / thanh lý" fill={COLOR_EXPENSE} maxBarSize={16} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard
        title="Thu hồi hoá đơn theo kỳ — 12 tháng"
        action={<ExportButtons data={collectionExport} filename={`thu-hoi-hoa-don-${ym}`} />}
        loading={colLoading}
        empty={collectionRows.every((d) => d.billed === 0)}
        height={320}
        footnote={
          <p className="text-xs text-muted-foreground">
            "Phải thu" = tổng hoá đơn phát hành theo kỳ (đã trừ hoá đơn điều chỉnh âm). Tuổi nợ tính
            theo ngày đáo hạn, không phụ thuộc trạng thái hoá đơn.
          </p>
        }
      >
        <div className="space-y-4">
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={collectionRows} barCategoryGap="20%">
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} />
              <YAxis yAxisId="left" tick={{ fontSize: 12 }} tickFormatter={compactVnd} width={70} />
              <YAxis
                yAxisId="right"
                orientation="right"
                domain={[0, 100]}
                tick={{ fontSize: 12 }}
                tickFormatter={(v: number) => `${v}%`}
              />
              <Tooltip
                formatter={(value: any, name: any) =>
                  name === "Tỷ lệ thu"
                    ? value == null
                      ? "—"
                      : `${Number(value).toFixed(1)}%`
                    : formatCurrency(Number(value))
                }
              />
              <Legend />
              <Bar yAxisId="left" dataKey="billed" name="Phải thu" fill={COLOR_MUTED} maxBarSize={22} radius={[3, 3, 0, 0]} />
              <Bar yAxisId="left" dataKey="collected" name="Đã thu" fill={COLOR_INCOME} maxBarSize={22} radius={[3, 3, 0, 0]} />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="rate"
                name="Tỷ lệ thu"
                stroke={COLOR_RATIO}
                strokeWidth={2}
                dot={{ r: 3 }}
                connectNulls={false}
              />
            </ComposedChart>
          </ResponsiveContainer>

          <div className="overflow-x-auto -mx-6 px-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Kỳ</TableHead>
                  <TableHead className="text-right">Phải thu</TableHead>
                  <TableHead className="text-right">Đã thu</TableHead>
                  <TableHead className="text-right">Còn lại</TableHead>
                  <TableHead className="text-right">Tỷ lệ thu</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...collectionRows].reverse().filter((r) => r.billed !== 0 || r.collected !== 0).map((r) => (
                  <TableRow key={r.ym}>
                    <TableCell className="whitespace-nowrap font-medium">{r.ym}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(r.billed)}</TableCell>
                    <TableCell className="text-right tabular-nums text-emerald-700">
                      {formatCurrency(r.collected)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-red-700">
                      {formatCurrency(r.remaining)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtPct(r.rate)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </ChartCard>

      {/* Tuổi nợ phải thu */}
      <div>
        <h3 className="text-base font-semibold mb-3">
          Tuổi nợ phải thu — hiện còn {formatCurrency(snap.receivable)}
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          {snapLoading
            ? Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)
            : agingCards.map((c) => (
                <Card key={c.label} className={cn("border-l-4", c.cls)}>
                  <CardContent className="p-3">
                    <div className="text-lg font-bold tabular-nums truncate" title={formatCurrency(c.value)}>
                      {formatCurrency(c.value)}
                    </div>
                    <div className="text-xs text-muted-foreground">{c.label}</div>
                    <div className="text-xs text-muted-foreground">
                      {fmtPct(sharePct(c.value, snap.receivable))} tổng phải thu
                    </div>
                  </CardContent>
                </Card>
              ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard
          title="Trạng thái phòng hiện tại"
          loading={snapLoading}
          empty={roomDonut.length === 0}
        >
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie
                data={roomDonut}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={55}
                outerRadius={92}
                label={(e: any) => `${e.value}`}
              >
                {roomDonut.map((d) => (
                  <Cell key={d.name} fill={d.color} />
                ))}
              </Pie>
              <Tooltip formatter={(v: any, _n: any) => `${v} phòng (${fmtPct(sharePct(Number(v), totalRooms))})`} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Chỉ số hợp đồng hiện tại</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {snapLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : (
              <>
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-blue-100 flex items-center justify-center">
                    <FileSignature className="h-5 w-5 text-blue-600" />
                  </div>
                  <div>
                    <div className="text-lg font-bold">{snap.actives} hợp đồng</div>
                    <div className="text-xs text-muted-foreground">Đang hiệu lực</div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-emerald-100 flex items-center justify-center">
                    <HandCoins className="h-5 w-5 text-emerald-600" />
                  </div>
                  <div>
                    <div className="text-lg font-bold">{formatCurrency(arpu)}</div>
                    <div className="text-xs text-muted-foreground">
                      Giá thuê trung bình / hợp đồng (ARPU)
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-slate-100 flex items-center justify-center">
                    <Wallet className="h-5 w-5 text-slate-600" />
                  </div>
                  <div>
                    <div className="text-lg font-bold">{formatCurrency(snap.deposit)}</div>
                    <div className="text-xs text-muted-foreground">
                      Tổng cọc đang giữ (nghĩa vụ hoàn trả — không phải doanh thu)
                    </div>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
