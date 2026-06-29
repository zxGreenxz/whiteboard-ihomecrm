import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { TrendingUp, Wallet, HandCoins, Scale, Plus, Briefcase } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { StatCard } from "./StatCard";
import { colorAt, currentYear } from "./shareholderUtils";
import { useShareholders } from "@/hooks/useShareholders";
import { useProfitManagers } from "@/hooks/useProfitManagers";
import { useBuildings } from "@/hooks/useBuildings";
import {
  useProfitMonthly,
  useProfitAllocations,
  useShareholderDistributions,
  useProfitManagerAllocations,
  useManagerSalaryPayouts,
  computeShareholderSummary,
} from "@/hooks/useShareholderProfit";
import ProfitDistributeDialog from "./ProfitDistributeDialog";
import ManagerSalaryPayoutDialog from "./ManagerSalaryPayoutDialog";

const ALL = "all";

export default function ProfitOverviewTab() {
  const [year, setYear] = useState(currentYear());
  const [month, setMonth] = useState<string>(ALL); // "all" | "1".."12"
  const [shId, setShId] = useState<string>(ALL); // "all" | shareholder_id
  const [distOpen, setDistOpen] = useState(false);
  const [distShareholder, setDistShareholder] = useState<string | null>(null);
  const [payoutOpen, setPayoutOpen] = useState(false);
  const [payoutManager, setPayoutManager] = useState<string | null>(null);

  const { data: shareholders = [] } = useShareholders();
  const { data: buildings = [] } = useBuildings();
  const { data: profitMonthly = [] } = useProfitMonthly();
  const { data: allocations = [] } = useProfitAllocations();
  const { data: distributions = [] } = useShareholderDistributions();

  const { data: managers = [] } = useProfitManagers();
  const { data: managerAllocations = [] } = useProfitManagerAllocations();
  const { data: managerPayouts = [] } = useManagerSalaryPayouts();

  const buildingName = (id: string) => buildings.find((b: any) => b.id === id)?.name ?? "—";
  const monthOf = (period?: string) => Number((period ?? "").slice(5, 7));

  // Chỉ tính phần của cổ đông CÒN HIỆU LỰC: phân bổ/phiếu chi gắn cổ đông đã xoá
  // (vd "Green") không được cộng vào tổng — nếu không "Tổng được chia" sẽ phồng
  // hơn tổng từng cổ đông đang hiển thị. (shareholders đã loại deleted_at.)
  const activeIds = useMemo(() => new Set(shareholders.map((s) => s.id)), [shareholders]);
  const allocActive = useMemo(
    () => allocations.filter((a) => activeIds.has(a.shareholder_id)),
    [allocations, activeIds]
  );
  const distActive = useMemo(
    () => distributions.filter((d) => activeIds.has(d.shareholder_id)),
    [distributions, activeIds]
  );

  // ---- Phân bổ (đã GẮN % cổ đông) lọc theo năm + cổ đông ----
  // Charts/bảng lấy từ profit_allocations (amount = LN nhà × % cổ đông) thay vì
  // adjusted_profit thô của profit_monthly → đúng phần CỔ ĐÔNG ĐƯỢC CHIA.
  const allocYear = useMemo(
    () =>
      allocActive.filter(
        (a) =>
          (a.period_month ?? "").startsWith(String(year)) &&
          (shId === ALL || a.shareholder_id === shId)
      ),
    [allocActive, year, shId]
  );

  // Thêm lọc tháng (cho biểu đồ cơ cấu theo nhà + bảng).
  const allocScoped = useMemo(
    () => allocYear.filter((a) => month === ALL || monthOf(a.period_month) === Number(month)),
    [allocYear, month]
  );

  const buildingIdsInYear = useMemo(
    () => Array.from(new Set(allocScoped.map((a) => a.building_id).filter(Boolean) as string[])),
    [allocScoped]
  );

  const cell = (bid: string, m: number) => {
    const rows = allocYear.filter((a) => a.building_id === bid && monthOf(a.period_month) === m);
    return rows.length ? rows.reduce((s, a) => s + a.amount, 0) : undefined;
  };

  // ---- Charts (số ĐƯỢC CHIA) ----
  const monthlyChart = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) => {
        const m = i + 1;
        const profit = allocYear
          .filter((a) => monthOf(a.period_month) === m)
          .reduce((s, a) => s + a.amount, 0);
        return { month: `T${m}`, profit };
      }),
    [allocYear]
  );

  const byBuildingChart = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of allocScoped) {
      if (!a.building_id) continue;
      m.set(a.building_id, (m.get(a.building_id) ?? 0) + a.amount);
    }
    return [...m.entries()]
      .map(([bid, value]) => ({ name: buildingName(bid), value }))
      .filter((x) => x.value !== 0);
  }, [allocScoped]);

  // ---- KPI: settlement luỹ kế, lọc theo cổ đông ----
  const summary = useMemo(
    () => computeShareholderSummary(shareholders.map((s) => s.id), allocActive, distActive),
    [shareholders, allocActive, distActive]
  );

  // ---- Lương điều hành: settlement luỹ kế theo quản lý (tái dùng computeShareholderSummary) ----
  const activeMgrIds = useMemo(() => new Set(managers.map((m) => m.id)), [managers]);
  const managerSummary = useMemo(
    () =>
      computeShareholderSummary(
        managers.map((m) => m.id),
        managerAllocations
          .filter((a) => activeMgrIds.has(a.manager_id))
          .map((a) => ({ shareholder_id: a.manager_id, amount: a.amount })),
        managerPayouts
          .filter((p) => activeMgrIds.has(p.manager_id))
          .map((p) => ({ shareholder_id: p.manager_id, total_amount: p.total_amount }))
      ),
    [managers, managerAllocations, managerPayouts, activeMgrIds]
  );

  const totals = useMemo(() => {
    // Tổng LN đã chốt = toàn bộ LN doanh nghiệp đã khoá (KHÔNG theo cổ đông — là gốc trước chia).
    const lockedProfit = profitMonthly
      .filter((p) => p.status === "LOCKED")
      .reduce((s, p) => s + p.adjusted_profit, 0);
    // Được chia / Đã ứng / Còn lại = luỹ kế, lọc theo cổ đông đang chọn (đã loại cổ đông xoá).
    const allocF = allocActive.filter((a) => shId === ALL || a.shareholder_id === shId);
    const distF = distActive.filter((d) => shId === ALL || d.shareholder_id === shId);
    const accrued = allocF.reduce((s, a) => s + a.amount, 0);
    const paid = distF.reduce((s, d) => s + d.total_amount, 0);
    return { lockedProfit, accrued, paid, remaining: accrued - paid };
  }, [profitMonthly, allocActive, distActive, shId]);

  const remainingChart = useMemo(
    () =>
      shareholders
        .map((s) => ({ name: s.name, value: summary[s.id]?.remaining ?? 0 }))
        .filter((x) => x.value !== 0),
    [shareholders, summary]
  );

  const years = [currentYear() + 1, currentYear(), currentYear() - 1, currentYear() - 2];
  const shName = shId === ALL ? null : shareholders.find((s) => s.id === shId)?.name ?? null;
  const scopeLabel = shName ? ` · ${shName}` : "";
  const monthsToShow =
    month === ALL ? Array.from({ length: 12 }, (_, i) => i + 1) : [Number(month)];

  return (
    <div className="space-y-4">
      {/* KPI */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Tổng LN đã chốt (luỹ kế)" value={formatCurrency(totals.lockedProfit)} icon={TrendingUp} tone="blue" sub="Trước chia cổ đông" />
        <StatCard label={shName ? `Được chia · ${shName}` : "Tổng được chia cổ đông"} value={formatCurrency(totals.accrued)} icon={Wallet} tone="green" />
        <StatCard label="Đã ứng / đã chia" value={formatCurrency(totals.paid)} icon={HandCoins} tone="amber" />
        <StatCard label="Còn phải trả" value={formatCurrency(totals.remaining)} icon={Scale} tone={totals.remaining >= 0 ? "default" : "red"} />
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
        <Select value={shId} onValueChange={setShId}>
          <SelectTrigger className="w-[180px]"><SelectValue placeholder="Cổ đông" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Tất cả cổ đông</SelectItem>
            {shareholders.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button className="ml-auto" onClick={() => { setDistShareholder(shId === ALL ? null : shId); setDistOpen(true); }}>
          <Plus className="h-4 w-4 mr-2" /> Chi lợi nhuận
        </Button>
      </div>

      {/* Charts (số ĐƯỢC CHIA cho cổ đông) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">LN được chia theo tháng — {year}{scopeLabel}</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={monthlyChart}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => `${(v / 1_000_000).toFixed(0)}M`} />
                <Tooltip formatter={(v: number) => formatCurrency(v)} />
                <Bar dataKey="profit" fill="#3b82f6" name="Được chia" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Cơ cấu LN được chia theo nhà — {year}{month === ALL ? "" : ` · T${month}`}{scopeLabel}</CardTitle></CardHeader>
          <CardContent>
            {byBuildingChart.length === 0 ? (
              <div className="h-[260px] grid place-items-center text-muted-foreground text-sm">Chưa có dữ liệu</div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                  <Pie data={byBuildingChart} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label={(e: any) => e.name}>
                    {byBuildingChart.map((_, i) => <Cell key={i} fill={colorAt(i)} />)}
                  </Pie>
                  <Tooltip formatter={(v: number) => formatCurrency(v)} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Ma trận Nhà × Tháng (số ĐƯỢC CHIA) */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">LN được chia Nhà × Tháng — {year}{scopeLabel}</CardTitle></CardHeader>
        <CardContent>
          {buildingIdsInYear.length === 0 ? (
            <p className="text-sm text-muted-foreground">Chưa có phần chia cho cổ đông trong {month === ALL ? `năm ${year}` : `tháng ${month}/${year}`}.</p>
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

      {/* Theo cổ đông */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Theo cổ đông (luỹ kế)</CardTitle></CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Cổ đông</TableHead>
                    <TableHead className="text-right">Được chia</TableHead>
                    <TableHead className="text-right">Đã ứng</TableHead>
                    <TableHead className="text-right">Còn lại</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shareholders.length === 0 && (
                    <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">Chưa có cổ đông</TableCell></TableRow>
                  )}
                  {shareholders.map((s) => {
                    const r = summary[s.id] ?? { accrued: 0, paid: 0, remaining: 0 };
                    const active = shId !== ALL && shId === s.id;
                    return (
                      <TableRow key={s.id} className={active ? "bg-emerald-50/60" : undefined}>
                        <TableCell className="font-medium">
                          <button type="button" className="hover:underline" onClick={() => setShId(active ? ALL : s.id)}>{s.name}</button>
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-emerald-600">{formatCurrency(r.accrued)}</TableCell>
                        <TableCell className="text-right tabular-nums text-amber-600">{formatCurrency(r.paid)}</TableCell>
                        <TableCell className={`text-right tabular-nums font-semibold ${r.remaining < 0 ? "text-red-600" : ""}`}>{formatCurrency(r.remaining)}</TableCell>
                        <TableCell className="text-right">
                          <Button variant="outline" size="sm" onClick={() => { setDistShareholder(s.id); setDistOpen(true); }}>Chi</Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Còn lại theo cổ đông</CardTitle></CardHeader>
          <CardContent>
            {remainingChart.length === 0 ? (
              <div className="h-[260px] grid place-items-center text-muted-foreground text-sm">Chưa có dữ liệu</div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={remainingChart} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" tick={{ fontSize: 12 }} tickFormatter={(v) => `${(v / 1_000_000).toFixed(0)}M`} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 12 }} width={80} />
                  <Tooltip formatter={(v: number) => formatCurrency(v)} />
                  <Bar dataKey="value" fill="#10b981" name="Còn lại" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Lương điều hành (luỹ kế) */}
      {managers.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Briefcase className="h-4 w-4 text-orange-600" /> Lương điều hành (luỹ kế)
            </CardTitle>
            <Button variant="outline" size="sm" onClick={() => { setPayoutManager(null); setPayoutOpen(true); }}>
              <Plus className="h-4 w-4 mr-1" /> Chi lương điều hành
            </Button>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Quản lý</TableHead>
                    <TableHead className="text-right">Được nhận</TableHead>
                    <TableHead className="text-right">Đã trả</TableHead>
                    <TableHead className="text-right">Còn lại</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {managers.map((m) => {
                    const r = managerSummary[m.id] ?? { accrued: 0, paid: 0, remaining: 0 };
                    return (
                      <TableRow key={m.id}>
                        <TableCell className="font-medium">{m.name}</TableCell>
                        <TableCell className="text-right tabular-nums text-orange-600">{formatCurrency(r.accrued)}</TableCell>
                        <TableCell className="text-right tabular-nums text-amber-600">{formatCurrency(r.paid)}</TableCell>
                        <TableCell className={`text-right tabular-nums font-semibold ${r.remaining < 0 ? "text-red-600" : ""}`}>{formatCurrency(r.remaining)}</TableCell>
                        <TableCell className="text-right">
                          <Button variant="outline" size="sm" onClick={() => { setPayoutManager(m.id); setPayoutOpen(true); }}>Chi</Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      <ProfitDistributeDialog
        open={distOpen}
        onOpenChange={setDistOpen}
        shareholders={shareholders}
        defaultShareholderId={distShareholder}
      />
      <ManagerSalaryPayoutDialog
        open={payoutOpen}
        onOpenChange={setPayoutOpen}
        managers={managers}
        defaultManagerId={payoutManager}
      />
    </div>
  );
}
