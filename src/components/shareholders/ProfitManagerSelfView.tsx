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
import { colorAt, currentYear } from "./shareholderUtils";
import { useMyShareBuildings } from "@/hooks/useShareholders";
import {
  useProfitManagerAllocations,
  useManagerSalaryPayouts,
  computeShareholderSummary,
} from "@/hooks/useShareholderProfit";
import type { ProfitManager } from "@/hooks/useProfitManagers";

const ALL = "all";

export default function ProfitManagerSelfView({ me }: { me: ProfitManager }) {
  const [year, setYear] = useState(currentYear());
  const [month, setMonth] = useState<string>(ALL);
  const { data: allocations = [] } = useProfitManagerAllocations(); // RLS: chỉ của mình
  const { data: payouts = [] } = useManagerSalaryPayouts(); // RLS: chỉ của mình
  // Tên tòa qua RPC riêng (vai lợi-nhuận không còn quyền đọc bảng buildings).
  const { data: buildings = [] } = useMyShareBuildings();

  const buildingName = (id?: string) => buildings.find((b) => b.id === id)?.name ?? "—";
  const monthOf = (p?: string) => Number((p ?? "").slice(5, 7));

  const summary = useMemo(
    () =>
      computeShareholderSummary(
        [me.id],
        allocations.map((a) => ({ shareholder_id: a.manager_id, amount: a.amount })),
        payouts.map((p) => ({ shareholder_id: p.manager_id, total_amount: p.total_amount }))
      )[me.id],
    [me.id, allocations, payouts]
  );

  const allocYear = useMemo(
    () => allocations.filter((a) => (a.period_month ?? "").startsWith(String(year))),
    [allocations, year]
  );
  const allocScoped = useMemo(
    () => allocYear.filter((a) => month === ALL || monthOf(a.period_month) === Number(month)),
    [allocYear, month]
  );
  const salaryThisYear = useMemo(() => allocYear.reduce((s, a) => s + a.amount, 0), [allocYear]);

  const monthlyChart = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) => {
        const m = i + 1;
        const amount = allocYear
          .filter((a) => monthOf(a.period_month) === m)
          .reduce((s, a) => s + a.amount, 0);
        return { month: `T${m}`, amount };
      }),
    [allocYear]
  );

  const byBuilding = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of allocScoped) m.set(a.building_id ?? "?", (m.get(a.building_id ?? "?") ?? 0) + a.amount);
    return Array.from(m.entries())
      .map(([bid, value]) => ({ name: buildingName(bid), value }))
      .filter((x) => x.value !== 0);
  }, [allocScoped, buildings]);

  const years = [currentYear() + 1, currentYear(), currentYear() - 1, currentYear() - 2];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Lương điều hành của tôi — {me.name}</h2>
        <p className="text-sm text-muted-foreground">Theo dõi lương điều hành được nhận, đã trả và số còn lại.</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Được nhận (luỹ kế)" value={formatCurrency(summary?.accrued ?? 0)} icon={Wallet} tone="green" />
        <StatCard label="Đã trả / đã lấy" value={formatCurrency(summary?.paid ?? 0)} icon={HandCoins} tone="amber" />
        <StatCard label="Còn lại" value={formatCurrency(summary?.remaining ?? 0)} icon={Scale} tone={(summary?.remaining ?? 0) >= 0 ? "blue" : "red"} />
        <StatCard label={`Lương năm ${year}`} value={formatCurrency(salaryThisYear)} icon={TrendingUp} tone="default" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
          <SelectTrigger className="w-[110px]"><SelectValue /></SelectTrigger>
          <SelectContent>{years.map((y) => <SelectItem key={y} value={String(y)}>Năm {y}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={month} onValueChange={setMonth}>
          <SelectTrigger className="w-[120px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Cả năm</SelectItem>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <SelectItem key={m} value={String(m)}>Tháng {m}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Lương điều hành theo tháng — {year}</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={monthlyChart}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => `${(v / 1_000_000).toFixed(0)}M`} />
                <Tooltip formatter={(v: number) => formatCurrency(v)} />
                <Bar dataKey="amount" fill="#f97316" name="Được nhận" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Theo nhà — {year}{month === ALL ? "" : ` · T${month}`}</CardTitle></CardHeader>
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

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Lịch sử đã trả / đã lấy</CardTitle></CardHeader>
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
                {payouts.length === 0 && (
                  <TableRow><TableCell colSpan={3} className="text-center text-muted-foreground">Chưa có khoản trả nào</TableCell></TableRow>
                )}
                {payouts.map((d) => (
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
  );
}
