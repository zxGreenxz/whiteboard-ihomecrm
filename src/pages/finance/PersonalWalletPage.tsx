import { useMemo, useState } from "react";
import MainLayout from "@/components/layout/MainLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, PieChart, Pie, Cell, Legend,
} from "recharts";
import { Wallet, Plus, Pencil, Trash2, ArrowDownCircle, ArrowUpCircle, Scale } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { StatCard } from "@/components/shareholders/StatCard";
import { colorAt, currentYear } from "@/components/shareholders/shareholderUtils";
import PersonalTxnDialog from "@/components/shareholders/PersonalTxnDialog";
import {
  usePersonalTransactions,
  useDeletePersonalTransaction,
  type PersonalTransaction,
} from "@/hooks/usePersonalTransactions";
import { useMyShareholder } from "@/hooks/useShareholders";
import {
  useProfitAllocations,
  useShareholderDistributions,
  computeShareholderSummary,
} from "@/hooks/useShareholderProfit";

export default function PersonalWalletPage() {
  const [year, setYear] = useState(currentYear());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PersonalTransaction | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const { data: txns = [] } = usePersonalTransactions();
  const deleteMut = useDeletePersonalTransaction();

  // Banner cổ đông (nếu user là cổ đông): còn lại được nhận từ công ty.
  const { data: me } = useMyShareholder();
  const { data: allocations = [] } = useProfitAllocations();
  const { data: distributions = [] } = useShareholderDistributions();
  const companyRemaining = useMemo(() => {
    if (!me) return null;
    const s = computeShareholderSummary([me.id], allocations, distributions)[me.id];
    return s ?? null;
  }, [me, allocations, distributions]);

  const totals = useMemo(() => {
    let income = 0, expense = 0;
    for (const t of txns) {
      if (t.type === "INCOME") income += t.amount;
      else expense += t.amount;
    }
    return { income, expense, balance: income - expense };
  }, [txns]);

  const txnsYear = useMemo(() => txns.filter((t) => t.txn_date.startsWith(String(year))), [txns, year]);

  const monthlyChart = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) => {
        const m = i + 1;
        const rows = txnsYear.filter((t) => Number(t.txn_date.slice(5, 7)) === m);
        return {
          month: `T${m}`,
          income: rows.filter((t) => t.type === "INCOME").reduce((s, t) => s + t.amount, 0),
          expense: rows.filter((t) => t.type === "EXPENSE").reduce((s, t) => s + t.amount, 0),
        };
      }),
    [txnsYear]
  );

  const expenseByCategory = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of txnsYear) {
      if (t.type !== "EXPENSE") continue;
      const key = t.category?.trim() || "Khác";
      m.set(key, (m.get(key) ?? 0) + t.amount);
    }
    return Array.from(m.entries()).map(([name, value]) => ({ name, value }));
  }, [txnsYear]);

  const years = [currentYear() + 1, currentYear(), currentYear() - 1, currentYear() - 2];

  return (
    <MainLayout title="Ví thu chi cá nhân" subtitle="Tài chính → Cá nhân" icon={Wallet}>
      <div className="space-y-4">
        {companyRemaining && (
          <Card className="border-blue-200 bg-blue-50">
            <CardContent className="p-4 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
              <span className="font-medium text-blue-900">Từ công ty:</span>
              <span>Được chia: <b className="tabular-nums">{formatCurrency(companyRemaining.accrued)}</b></span>
              <span>Đã ứng: <b className="tabular-nums">{formatCurrency(companyRemaining.paid)}</b></span>
              <span>Còn lại được nhận: <b className="tabular-nums text-blue-700">{formatCurrency(companyRemaining.remaining)}</b></span>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          <StatCard label="Tổng thu" value={formatCurrency(totals.income)} icon={ArrowDownCircle} tone="green" />
          <StatCard label="Tổng chi" value={formatCurrency(totals.expense)} icon={ArrowUpCircle} tone="red" />
          <StatCard label="Số dư" value={formatCurrency(totals.balance)} icon={Scale} tone={totals.balance >= 0 ? "blue" : "red"} />
        </div>

        <div className="flex items-center gap-2">
          <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
            <SelectTrigger className="w-[120px]"><SelectValue /></SelectTrigger>
            <SelectContent>{years.map((y) => <SelectItem key={y} value={String(y)}>Năm {y}</SelectItem>)}</SelectContent>
          </Select>
          <Button className="ml-auto" onClick={() => { setEditing(null); setDialogOpen(true); }}>
            <Plus className="h-4 w-4 mr-2" /> Thêm khoản
          </Button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Thu / Chi theo tháng — {year}</CardTitle></CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={monthlyChart}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => `${(v / 1_000_000).toFixed(0)}M`} />
                  <Tooltip formatter={(v: number) => formatCurrency(v)} />
                  <Legend />
                  <Bar dataKey="income" fill="#10b981" name="Thu" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="expense" fill="#ef4444" name="Chi" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Cơ cấu chi theo danh mục — {year}</CardTitle></CardHeader>
            <CardContent>
              {expenseByCategory.length === 0 ? (
                <div className="h-[260px] grid place-items-center text-muted-foreground text-sm">Chưa có dữ liệu</div>
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <PieChart>
                    <Pie data={expenseByCategory} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label={(e: any) => e.name}>
                      {expenseByCategory.map((_, i) => <Cell key={i} fill={colorAt(i)} />)}
                    </Pie>
                    <Tooltip formatter={(v: number) => formatCurrency(v)} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Giao dịch</CardTitle></CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ngày</TableHead>
                    <TableHead>Loại</TableHead>
                    <TableHead>Danh mục</TableHead>
                    <TableHead>Mô tả</TableHead>
                    <TableHead className="text-right">Số tiền</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {txnsYear.length === 0 && (
                    <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">Chưa có giao dịch năm {year}</TableCell></TableRow>
                  )}
                  {txnsYear.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell>{t.txn_date}</TableCell>
                      <TableCell>
                        <span className={t.type === "INCOME" ? "text-emerald-600" : "text-red-600"}>
                          {t.type === "INCOME" ? "Thu" : "Chi"}
                        </span>
                      </TableCell>
                      <TableCell>{t.category ?? "—"}</TableCell>
                      <TableCell className="max-w-[200px] truncate">{t.description ?? "—"}</TableCell>
                      <TableCell className={`text-right tabular-nums ${t.type === "INCOME" ? "text-emerald-600" : "text-red-600"}`}>
                        {t.type === "INCOME" ? "+" : "−"}{formatCurrency(t.amount)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="icon" onClick={() => { setEditing(t); setDialogOpen(true); }}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => setDeleteId(t.id)}>
                            <Trash2 className="h-4 w-4 text-red-600" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      <PersonalTxnDialog open={dialogOpen} onOpenChange={(o) => { setDialogOpen(o); if (!o) setEditing(null); }} txn={editing} />

      <AlertDialog open={!!deleteId} onOpenChange={(o) => { if (!o) setDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xoá khoản này?</AlertDialogTitle>
            <AlertDialogDescription>Thao tác này sẽ ẩn khoản khỏi ví cá nhân của bạn.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Huỷ</AlertDialogCancel>
            <AlertDialogAction className="bg-red-600 hover:bg-red-700" onClick={async () => { if (deleteId) await deleteMut.mutateAsync(deleteId); setDeleteId(null); }}>Xoá</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </MainLayout>
  );
}
