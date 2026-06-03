import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, PieChart, Pie, Cell,
} from "recharts";
import { Wallet, HandCoins, Scale, TrendingUp } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { StatCard } from "./StatCard";
import { colorAt, currentYear, periodToLabel } from "./shareholderUtils";
import { useBuildings } from "@/hooks/useBuildings";
import {
  useProfitAllocations,
  useShareholderDistributions,
  computeShareholderSummary,
} from "@/hooks/useShareholderProfit";
import type { Shareholder } from "@/hooks/useShareholders";

export default function ShareholderSelfView({ me }: { me: Shareholder }) {
  const [year, setYear] = useState(currentYear());
  const { data: allocations = [] } = useProfitAllocations(); // RLS: chỉ của mình
  const { data: distributions = [] } = useShareholderDistributions(); // RLS: chỉ của mình
  const { data: buildings = [] } = useBuildings();

  const buildingName = (id?: string) => buildings.find((b: any) => b.id === id)?.name ?? "—";

  const summary = useMemo(
    () => computeShareholderSummary([me.id], allocations, distributions)[me.id],
    [me.id, allocations, distributions]
  );

  const allocYear = useMemo(
    () => allocations.filter((a) => (a.period_month ?? "").startsWith(String(year))),
    [allocations, year]
  );

  const profitThisYear = useMemo(() => allocYear.reduce((s, a) => s + a.amount, 0), [allocYear]);

  const monthlyChart = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) => {
        const m = i + 1;
        const amount = allocYear
          .filter((a) => Number((a.period_month ?? "").slice(5, 7)) === m)
          .reduce((s, a) => s + a.amount, 0);
        return { month: `T${m}`, amount };
      }),
    [allocYear]
  );

  const byBuilding = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of allocYear) m.set(a.building_id ?? "?", (m.get(a.building_id ?? "?") ?? 0) + a.amount);
    return Array.from(m.entries()).map(([bid, value]) => ({ name: buildingName(bid), value })).filter((x) => x.value !== 0);
  }, [allocYear, buildings]);

  const years = [currentYear() + 1, currentYear(), currentYear() - 1, currentYear() - 2];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Lợi nhuận của tôi — {me.name}</h2>
        <p className="text-sm text-muted-foreground">Theo dõi phần lợi nhuận được chia, các khoản đã ứng và số còn lại.</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Được chia (luỹ kế)" value={formatCurrency(summary?.accrued ?? 0)} icon={Wallet} tone="green" />
        <StatCard label="Đã ứng / đã lấy" value={formatCurrency(summary?.paid ?? 0)} icon={HandCoins} tone="amber" />
        <StatCard label="Còn lại" value={formatCurrency(summary?.remaining ?? 0)} icon={Scale} tone={(summary?.remaining ?? 0) >= 0 ? "blue" : "red"} />
        <StatCard label={`LN năm ${year}`} value={formatCurrency(profitThisYear)} icon={TrendingUp} tone="default" />
      </div>

      <div className="flex items-center gap-2">
        <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
          <SelectTrigger className="w-[120px]"><SelectValue /></SelectTrigger>
          <SelectContent>{years.map((y) => <SelectItem key={y} value={String(y)}>Năm {y}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Lợi nhuận theo tháng — {year}</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={monthlyChart}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => `${(v / 1_000_000).toFixed(0)}M`} />
                <Tooltip formatter={(v: number) => formatCurrency(v)} />
                <Bar dataKey="amount" fill="#10b981" name="Được chia" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Theo nhà — {year}</CardTitle></CardHeader>
          <CardContent>
            {byBuilding.length === 0 ? (
              <div className="h-[260px] grid place-items-center text-muted-foreground text-sm">Chưa có dữ liệu</div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                  <Pie data={byBuilding} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label={(e: any) => e.name}>
                    {byBuilding.map((_, i) => <Cell key={i} fill={colorAt(i)} />)}
                  </Pie>
                  <Tooltip formatter={(v: number) => formatCurrency(v)} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Lợi nhuận từng tháng/nhà</CardTitle></CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tháng</TableHead>
                    <TableHead>Nhà</TableHead>
                    <TableHead className="text-right">Tỷ lệ</TableHead>
                    <TableHead className="text-right">Được chia</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {allocYear.length === 0 && (
                    <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">Chưa có dữ liệu</TableCell></TableRow>
                  )}
                  {allocYear
                    .slice()
                    .sort((a, b) => (b.period_month ?? "").localeCompare(a.period_month ?? ""))
                    .map((a) => (
                      <TableRow key={a.id}>
                        <TableCell>{a.period_month ? periodToLabel(a.period_month) : "—"}</TableCell>
                        <TableCell>{buildingName(a.building_id)}</TableCell>
                        <TableCell className="text-right tabular-nums">{a.percent}%</TableCell>
                        <TableCell className="text-right tabular-nums font-medium">{formatCurrency(a.amount)}</TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Lịch sử đã ứng / đã lấy</CardTitle></CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ngày</TableHead>
                    <TableHead>Diễn giải</TableHead>
                    <TableHead className="text-right">Số tiền</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {distributions.length === 0 && (
                    <TableRow><TableCell colSpan={3} className="text-center text-muted-foreground">Chưa có khoản ứng nào</TableCell></TableRow>
                  )}
                  {distributions.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell>{d.voucher_date}</TableCell>
                      <TableCell className="max-w-[200px] truncate">{d.name}</TableCell>
                      <TableCell className="text-right tabular-nums text-amber-600">{formatCurrency(d.total_amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
