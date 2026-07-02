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
import {
  useProfitAllocations,
  useShareholderDistributions,
  computeShareholderSummary,
} from "@/hooks/useShareholderProfit";
import { useMyShareBuildings, type Shareholder } from "@/hooks/useShareholders";

const ALL = "all";

export default function ShareholderSelfView({ me }: { me: Shareholder }) {
  const [year, setYear] = useState(currentYear());
  const [month, setMonth] = useState<string>(ALL); // "all" | "1".."12"
  const { data: allocations = [] } = useProfitAllocations(); // RLS: chỉ của mình
  const { data: distributions = [] } = useShareholderDistributions(); // RLS: chỉ của mình
  // Tên tòa qua RPC riêng (cổ đông không còn quyền đọc bảng buildings).
  const { data: buildings = [] } = useMyShareBuildings();

  const buildingName = (id?: string) => buildings.find((b) => b.id === id)?.name ?? "—";
  const monthOf = (p?: string) => Number((p ?? "").slice(5, 7));

  const summary = useMemo(
    () => computeShareholderSummary([me.id], allocations, distributions)[me.id],
    [me.id, allocations, distributions]
  );

  const allocYear = useMemo(
    () => allocations.filter((a) => (a.period_month ?? "").startsWith(String(year))),
    [allocations, year]
  );

  // Thêm lọc tháng cho biểu đồ cơ cấu theo nhà + 2 bảng (biểu đồ cột giữ cả 12 tháng).
  const allocScoped = useMemo(
    () => allocYear.filter((a) => month === ALL || monthOf(a.period_month) === Number(month)),
    [allocYear, month]
  );

  const profitThisYear = useMemo(() => allocYear.reduce((s, a) => s + a.amount, 0), [allocYear]);

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
    return Array.from(m.entries()).map(([bid, value]) => ({ name: buildingName(bid), value })).filter((x) => x.value !== 0);
  }, [allocScoped, buildings]);

  // ---- Ma trận Nhà × Tháng (được chia) ----
  const buildingIdsInYear = useMemo(
    () => Array.from(new Set(allocScoped.map((a) => a.building_id).filter(Boolean) as string[])),
    [allocScoped]
  );
  const cell = (bid: string, m: number) => {
    const rows = allocYear.filter((a) => a.building_id === bid && monthOf(a.period_month) === m);
    return rows.length ? rows.reduce((s, a) => s + a.amount, 0) : undefined;
  };
  const monthsToShow = month === ALL ? Array.from({ length: 12 }, (_, i) => i + 1) : [Number(month)];

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

      {/* Ma trận Nhà × Tháng — số được chia của tôi */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">LN được chia Nhà × Tháng — {year}</CardTitle></CardHeader>
        <CardContent>
          {buildingIdsInYear.length === 0 ? (
            <p className="text-sm text-muted-foreground">Chưa có phần chia trong {month === ALL ? `năm ${year}` : `tháng ${month}/${year}`}.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="sticky left-0 bg-background z-10">Tháng</TableHead>
                    {buildingIdsInYear.map((bid) => (
                      <TableHead key={bid} className="text-right min-w-[110px]">{buildingName(bid)}</TableHead>
                    ))}
                    <TableHead className="text-right font-semibold">Tổng chia</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {monthsToShow.map((m) => {
                    const rowTotal = buildingIdsInYear.reduce((s, bid) => s + (cell(bid, m) ?? 0), 0);
                    if (rowTotal === 0 && !buildingIdsInYear.some((bid) => cell(bid, m) != null)) return null;
                    return (
                      <TableRow key={m}>
                        <TableCell className="font-medium sticky left-0 bg-background z-10">T{m}</TableCell>
                        {buildingIdsInYear.map((bid) => {
                          const v = cell(bid, m);
                          return (
                            <TableCell key={bid} className="text-right tabular-nums">
                              {v == null ? <span className="text-muted-foreground">—</span> : formatCurrency(v)}
                            </TableCell>
                          );
                        })}
                        <TableCell className="text-right font-semibold tabular-nums">{formatCurrency(rowTotal)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <div>
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
