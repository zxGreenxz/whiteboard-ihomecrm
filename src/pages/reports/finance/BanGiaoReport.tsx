// =============================================
// Báo cáo Bàn giao tiền & Đối soát sổ — cho CHỦ theo dõi:
//  - Theo TỪNG sổ: đã thu / đã chi (kỳ) · đã bàn giao cho chủ · CÒN PHẢI NỘP
//    (= số dư hiện tại). Sổ chuyển khoản (tkHiep) có nút "Chốt số" (đối soát).
//  - Danh sách phiên bàn giao trong kỳ (thu − chi = thực nộp).
// Dữ liệu: RPC cashbook_settlement_report (useSettlementReport).
// =============================================

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, HandCoins, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import MainLayout from '@/components/layout/MainLayout';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { DateRangePicker } from '@/components/reports/DateRangePicker';
import { format, startOfMonth } from 'date-fns';
import { useSettlementReport, type SettlementAccount } from '@/hooks/useSettlementReport';
import { usePersistedDateRange } from '@/hooks/usePersistedState';
import { useProposeReconciliation, useCreateOpeningAdjustment } from '@/hooks/useReconciliations';
import { fmtDateTime } from '@/lib/handover';
import { useStaffUsers } from '@/hooks/useStaffUsers';
import { useAuth } from '@/hooks/useAuth';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';

const fmt = (n: number) =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(n || 0);
const toDate = (d: Date) => format(d, 'yyyy-MM-dd');
const fmtDay = (d?: string | null) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '');

export default function BanGiaoReport() {
  const [dateRange, setDateRange] = usePersistedDateRange('flt:rpt-ban-giao:dateRange', {
    from: startOfMonth(new Date()),
    to: new Date(),
  });
  const from = dateRange?.from ? toDate(dateRange.from) : '';
  const to = dateRange?.to ? toDate(dateRange.to) : '';

  const { data, isLoading } = useSettlementReport(from, to);
  const { data: perms } = useMyPermissions();
  const canReconcile = canUse(perms, 'reports_finance', 'reconcile');

  const accounts = data?.accounts ?? [];
  const sessions = data?.sessions ?? [];

  const totals = useMemo(() => {
    return accounts.reduce(
      (t, a) => ({
        collected: t.collected + a.period_collected,
        spent: t.spent + a.period_spent,
        handed: t.handed + a.period_handed_over,
        balance: t.balance + a.current_balance,
      }),
      { collected: 0, spent: 0, handed: 0, balance: 0 },
    );
  }, [accounts]);

  const [reconFor, setReconFor] = useState<SettlementAccount | null>(null);

  const stat = (label: string, value: number, tone?: string) => (
    <Card>
      <CardContent className="pt-5">
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <div className={`mt-1 text-xl font-bold tabular-nums ${tone ?? ''}`}>{fmt(value)}</div>
      </CardContent>
    </Card>
  );

  return (
    <MainLayout>
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link to="/reports/finance" className="hover:text-primary">Báo cáo tài chính</Link>
          <ChevronRight className="h-4 w-4" />
          <span className="text-foreground font-medium">Bàn giao tiền & Đối soát sổ</span>
        </div>

        <div className="flex items-center gap-2">
          <HandCoins className="h-7 w-7 text-primary" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Bàn giao tiền & Đối soát sổ</h1>
            <p className="text-sm text-muted-foreground">
              Theo từng sổ: đã thu · đã chi · đã bàn giao · còn phải nộp (số dư hiện tại).
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <DateRangePicker value={dateRange} onChange={setDateRange} />
        </div>

        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          {stat('Đã thu (kỳ)', totals.collected, 'text-emerald-700')}
          {stat('Đã chi (kỳ)', totals.spent, 'text-red-700')}
          {stat('Đã bàn giao cho chủ (kỳ)', totals.handed, 'text-blue-700')}
          {stat('Đang giữ (số dư hiện tại)', totals.balance)}
        </div>

        {/* Bảng theo sổ */}
        <div className="rounded-md border bg-card overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="border-r font-semibold">Sổ quỹ</TableHead>
                <TableHead className="border-r font-semibold">Người giữ</TableHead>
                <TableHead className="border-r text-right font-semibold">Đã thu (kỳ)</TableHead>
                <TableHead className="border-r text-right font-semibold">Đã chi (kỳ)</TableHead>
                <TableHead className="border-r text-right font-semibold">Đã bàn giao</TableHead>
                <TableHead className="border-r text-right font-semibold">Còn phải nộp</TableHead>
                <TableHead className="text-right font-semibold">Đối soát</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}><TableCell colSpan={7}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                ))
              ) : accounts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                    Không có sổ quỹ nào có phát sinh trong kỳ.
                  </TableCell>
                </TableRow>
              ) : (
                accounts.map((a, idx) => (
                  <TableRow key={a.account_id} className={idx % 2 === 1 ? 'bg-muted/20' : ''}>
                    <TableCell className="border-r font-medium">
                      {a.name}
                      {a.is_bank && <Badge variant="outline" className="ml-2 text-[10px]">Chuyển khoản</Badge>}
                    </TableCell>
                    <TableCell className="border-r">{a.owner_name ?? '—'}</TableCell>
                    <TableCell className="border-r text-right tabular-nums text-emerald-700">{fmt(a.period_collected)}</TableCell>
                    <TableCell className="border-r text-right tabular-nums text-red-700">{fmt(a.period_spent)}</TableCell>
                    <TableCell className="border-r text-right tabular-nums text-blue-700">{fmt(a.period_handed_over)}</TableCell>
                    <TableCell className="border-r text-right tabular-nums font-semibold">
                      <span className={a.current_balance < 0 ? 'text-red-700' : ''}>{fmt(a.current_balance)}</span>
                    </TableCell>
                    <TableCell className="text-right">
                      {a.last_reconciliation ? (
                        <div className="text-[11px] text-muted-foreground leading-tight">
                          <span className="inline-flex items-center gap-1 text-emerald-700">
                            <CheckCircle2 className="h-3 w-3" /> {fmtDay(a.last_reconciliation.as_of_date)}
                          </span>
                          {a.last_reconciliation.diff !== 0 && (
                            <div className={a.last_reconciliation.diff < 0 ? 'text-red-600' : 'text-amber-600'}>
                              lệch {fmt(a.last_reconciliation.diff)}
                            </div>
                          )}
                        </div>
                      ) : null}
                      {canReconcile && (
                        <Button size="sm" variant="outline" className="mt-1 h-7 text-xs" onClick={() => setReconFor(a)}>
                          Chốt số
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {/* Phiên bàn giao trong kỳ */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Phiên bàn giao trong kỳ ({sessions.length})</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {sessions.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">Chưa có phiên bàn giao nào hoàn tất trong kỳ.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead className="border-r font-semibold">Mã</TableHead>
                    <TableHead className="border-r font-semibold">Người giao → nhận</TableHead>
                    <TableHead className="border-r text-right font-semibold">Đã thu</TableHead>
                    <TableHead className="border-r text-right font-semibold">Đã chi</TableHead>
                    <TableHead className="border-r text-right font-semibold">Thực nộp</TableHead>
                    <TableHead className="text-right font-semibold">Nhận lúc</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sessions.map((s, idx) => (
                    <TableRow key={(s.code ?? '') + idx} className={idx % 2 === 1 ? 'bg-muted/20' : ''}>
                      <TableCell className="border-r font-mono text-xs">{s.code}</TableCell>
                      <TableCell className="border-r text-sm">
                        {s.giver_name} → {s.receiver_name}
                        {s.from_account ? <span className="text-muted-foreground"> · {s.from_account}</span> : ''}
                      </TableCell>
                      <TableCell className="border-r text-right tabular-nums text-emerald-700">{fmt(s.gross)}</TableCell>
                      <TableCell className="border-r text-right tabular-nums text-red-700">{s.expense ? fmt(s.expense) : '—'}</TableCell>
                      <TableCell className="border-r text-right tabular-nums font-semibold">{fmt(s.net)}</TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">{fmtDateTime(s.confirmed_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* "Chốt số" đối soát SỐ DƯ HIỆN TẠI → as_of = hôm nay (khớp cơ sở số dư
          hệ thống), KHÔNG dùng `to` của khoảng lọc báo cáo. */}
      {reconFor && (
        <ReconcileDialog account={reconFor} asOf={toDate(new Date())} onClose={() => setReconFor(null)} />
      )}
    </MainLayout>
  );
}

// ── Dialog "Chốt số / đối soát" 1 sổ ─────────────────────────────────
function ReconcileDialog({
  account, asOf, onClose,
}: { account: SettlementAccount; asOf: string; onClose: () => void }) {
  const { data: currentUser } = useAuth();
  const { data: staff = [] } = useStaffUsers();
  const proposeMut = useProposeReconciliation();
  const adjustMut = useCreateOpeningAdjustment();

  const [counted, setCounted] = useState<string>(String(Math.round(account.current_balance)));
  const [note, setNote] = useState('');
  const [counterparty, setCounterparty] = useState('');
  // B6 cut-over: khoá sổ tới ngày D + phiếu điều chỉnh chênh (ngoài-KQKD).
  const [lockAfter, setLockAfter] = useState(false);

  const countedNum = Number(counted.replace(/[^\d-]/g, '')) || 0;
  const diff = countedNum - account.current_balance;

  const submit = async () => {
    try {
      const res = await proposeMut.mutateAsync({
        accountId: account.account_id,
        asOf: asOf || format(new Date(), 'yyyy-MM-dd'),
        countedBalance: countedNum,
        counterpartyId: counterparty || null,
        note,
      });
      toast.success(
        res.status === 'CONFIRMED'
          ? `Đã chốt số sổ ${account.name} — lệch ${fmt(res.diff)}`
          : `Đã gửi đối soát sổ ${account.name} — chờ xác nhận`,
      );
      if (lockAfter) {
        const adj = await adjustMut.mutateAsync({
          accountId: account.account_id,
          countedBalance: countedNum,
          asOf: asOf || format(new Date(), 'yyyy-MM-dd'),
        });
        toast.success(
          adj.voucher_id
            ? `Đã khoá sổ tới ${fmtDay(adj.locked_to)} + phiếu điều chỉnh ${fmt(adj.diff)} (ngoài KQKD)`
            : `Đã khoá sổ tới ${fmtDay(adj.locked_to)} — số dư khớp, không cần phiếu điều chỉnh`,
        );
      }
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const others = staff.filter((u: any) => u.id !== currentUser?.id);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Chốt số / đối soát — {account.name}</DialogTitle>
          <DialogDescription>
            Ghi nhận số dư đã đối chiếu thực tế. Không dịch chuyển tiền — chỉ xác nhận con số.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-md bg-muted/40 px-3 py-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Số dư hệ thống</span>
              <span className="font-semibold tabular-nums">{fmt(account.current_balance)}</span>
            </div>
          </div>

          <div>
            <Label className="text-xs">Số đếm/đối chiếu thực tế</Label>
            <Input
              inputMode="numeric"
              value={counted}
              onChange={(e) => setCounted(e.target.value)}
              className="tabular-nums"
            />
            <div className={`mt-1 text-xs ${diff === 0 ? 'text-muted-foreground' : diff < 0 ? 'text-red-600' : 'text-amber-600'}`}>
              Lệch: {fmt(diff)} {diff !== 0 ? '(đếm − hệ thống)' : '· khớp'}
            </div>
          </div>

          <label className="flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={lockAfter}
              onChange={(e) => setLockAfter(e.target.checked)}
            />
            <span>
              <b>Chốt số &amp; KHOÁ SỔ</b> tới hôm nay
              <span className="block text-xs text-muted-foreground">
                Số hệ thống lệch với số đếm sẽ được ghi 1 phiếu "Điều chỉnh số dư
                đầu kỳ" (ngoài KQKD — không ảnh hưởng lợi nhuận); phiếu trước ngày
                này bị chặn sửa. Không đổi số quá khứ.
              </span>
            </span>
          </label>

          <div>
            <Label className="text-xs">Người xác nhận cùng (không bắt buộc)</Label>
            <SearchableSelect
              value={counterparty}
              onValueChange={setCounterparty}
              placeholder="Chốt 1 mình (bỏ trống)"
              options={[
                { value: '', label: 'Chốt 1 mình (không cần xác nhận)' },
                ...others.map((u: any) => ({ value: u.id, label: u.full_name || u.email })),
              ]}
            />
          </div>

          <div>
            <Label className="text-xs">Ghi chú</Label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="vd: đối chiếu sao kê ngân hàng" />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Đóng</Button>
          <Button onClick={submit} disabled={proposeMut.isPending}>
            {counterparty ? 'Gửi đối soát' : 'Chốt số'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
