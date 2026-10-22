// Bảng quyết toán MỘT tháng của toà vận hành cho chủ nhà — dùng chung cho màn quản
// trị và link chỉ đọc của chủ nhà. Chỉ hiển thị: mọi con số lấy nguyên từ server.
import { AlertTriangle, ArrowRight, CheckCircle2, Clock, Lock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatVND } from '@/lib/utils';
import {
  CLOSE_BLOCKER_LABEL,
  NET_DIRECTION_LABEL,
  describeNet,
  monthLabel,
  monthShort,
  type SettlementMonth,
  type SettlementStatement,
} from '@/lib/landlordSettlement';
import { KqkdBridgeBlock, SettlementWarningsBlock } from './SettlementChecks';
import { VoucherBreakdown } from './VoucherBreakdown';

function StatusBadge({ month, mode }: { month: SettlementMonth; mode: 'admin' | 'public' }) {
  if (month.status === 'CLOSED' && month.is_stale) {
    return mode === 'admin'
      ? <Badge variant="destructive" className="gap-1"><AlertTriangle className="h-3 w-3" />Phiếu đã đổi sau khi chốt</Badge>
      : <Badge variant="secondary" className="gap-1"><Lock className="h-3 w-3" />Đã chốt — đang chờ chốt lại</Badge>;
  }
  if (month.status === 'CLOSED') {
    return <Badge className="gap-1 bg-emerald-600 hover:bg-emerald-600"><Lock className="h-3 w-3" />Đã chốt</Badge>;
  }
  if (month.status === 'OPEN') {
    return <Badge variant="secondary" className="gap-1"><Clock className="h-3 w-3" />{month.is_current_month ? 'Tạm tính — tháng đang chạy' : 'Tạm tính — chưa chốt'}</Badge>;
  }
  return <Badge variant="outline">Chưa áp dụng</Badge>;
}

function Kpi({ label, value, hint, tone }: { label: string; value: number; hint?: string; tone?: 'pos' | 'neg' | 'muted' }) {
  const color = tone === 'neg' ? 'text-destructive' : tone === 'pos' ? 'text-emerald-700 dark:text-emerald-400' : 'text-foreground';
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 whitespace-nowrap text-base font-semibold tabular-nums sm:text-lg ${color}`}>{formatVND(value)}</p>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Thanh lý hợp đồng trong tháng — số lấy nguyên từ server (đã nằm trong các tổng phía trên). */
function TerminationBlock({ st }: { st: SettlementStatement }) {
  const tl = st.termination;
  const rows: { label: string; value: number; note: string }[] = [
    { label: 'Cấn cọc vào khoản khách phải trả (điện, nước, ngày ở, phí…)', value: tl.revenue_from_deposit, note: 'doanh thu · tiền nằm ở sổ cọc của quản lý' },
    { label: 'Khách bỏ cọc', value: tl.forfeit_revenue, note: 'doanh thu · tiền nằm ở sổ cọc của quản lý' },
    { label: 'Khách trả thêm phần phí vượt cọc', value: tl.extra_receipt, note: 'doanh thu · bên giữ tiền theo sổ nhận' },
    { label: 'Trả thêm cho khách ngoài cọc (hoàn tiền phòng/tiền thừa)', value: tl.refund_beyond_deposit, note: 'chi phí · quản lý chi' },
    { label: 'Hoàn cọc cho khách', value: tl.deposit_refunded, note: 'trả lại tiền cọc · không tính lợi nhuận' },
  ];
  const shown = rows.filter((r) => r.value !== 0);
  if (shown.length === 0 && tl.pending_refund === 0) return null;
  return (
    <div className="rounded-lg border p-3" data-testid="settlement-termination">
      <p className="mb-2 text-sm font-medium">Thanh lý hợp đồng trong tháng</p>
      <dl className="space-y-1.5 text-sm">
        {shown.map((r) => (
          <div key={r.label} className="flex justify-between gap-3">
            <dt>
              {r.label}
              <span className="block text-[11px] text-muted-foreground">{r.note}</span>
            </dt>
            <dd className="whitespace-nowrap tabular-nums">{formatVND(r.value)}</dd>
          </div>
        ))}
      </dl>
      {tl.pending_refund > 0 && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
          Còn {formatVND(tl.pending_refund)} tiền trả thêm cho khách đang chờ duyệt — chưa tính, duyệt xong mới vào quyết toán.
        </p>
      )}
    </div>
  );
}

export function SettlementStatementCard({ month, mode }: { month: SettlementMonth; mode: 'admin' | 'public' }) {
  const st = month.statement;

  if (month.status === 'NOT_APPLICABLE' || !st) {
    const chuaToi = month.period_month.slice(0, 7) >= month.effective_from.slice(0, 7);
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{monthLabel(month.period_month)}</CardTitle>
          <CardDescription>
            {chuaToi
              ? <>Thoả thuận bắt đầu từ {monthLabel(month.effective_from).toLowerCase()} — số liệu có từ khi tháng đó bắt đầu.</>
              : <>Tháng này chưa thuộc thời gian áp dụng (bắt đầu từ {monthLabel(month.effective_from).toLowerCase()}).</>}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const t = st.totals;
  const net = describeNet(t.landlord_owes_manager);
  const pct = st.manager_percent.toLocaleString('vi-VN');
  const closedAt = month.closed ? new Date(month.closed.closed_at).toLocaleString('vi-VN') : null;

  return (
    <Card data-testid="settlement-statement">
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">{monthLabel(month.period_month)}</CardTitle>
          <StatusBadge month={month} mode={mode} />
        </div>
        <CardDescription>
          {month.building_name} · Chủ nhà: {month.landlord_name} · Quản lý nhận {pct}% lợi nhuận tháng (lỗ thì không tính)
          {st.terms_from !== month.effective_from && <> — tỷ lệ áp từ {monthShort(st.terms_from)}</>}
          {closedAt && <> · Chốt lúc {closedAt}{month.closed?.closed_by_name ? ` bởi ${month.closed.closed_by_name}` : ''}</>}
        </CardDescription>
        {month.closed?.note && <p className="text-sm">Ghi chú khi chốt: {month.closed.note}</p>}
        {month.status === 'CLOSED' && month.is_stale && mode === 'public' && (
          <p className="rounded-md border p-2 text-sm text-muted-foreground">
            Số dưới đây là số lúc chốt. Sau khi chốt có phiếu của tháng được điều chỉnh; bên quản lý sẽ chốt lại.
          </p>
        )}
        {month.status === 'CLOSED' && month.is_stale && mode === 'admin' && (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">
            Có phiếu của tháng này được sửa/thêm/huỷ sau khi chốt. Số dưới đây là số lúc chốt — mở chốt rồi chốt lại để cập nhật.
          </p>
        )}
        {st.reversed_voucher_count > 0 && mode === 'admin' && (
          <p role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {st.reversed_voucher_count} phiếu đã duyệt nhưng bút toán sổ quỹ đã bị đảo — tiền không còn ở sổ nào. Phiếu vẫn được tính như Báo cáo Lợi Nhuận; xử lý phiếu (đăng lại hoặc huỷ) trước khi chốt.
            </span>
          </p>
        )}
        {st.unposted_voucher_count > 0 && mode === 'admin' && (
          <p role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {st.unposted_voucher_count} phiếu đã duyệt nhưng chưa ghi sổ quỹ — tiền chưa thực vào/ra. Ghi sổ hoặc huỷ trước khi chốt.
            </span>
          </p>
        )}
        {(st.reversed_voucher_count > 0 || st.unposted_voucher_count > 0) && mode === 'public' && (
          <p className="rounded-md border p-2 text-sm text-muted-foreground">
            Có phiếu của tháng đang được bên quản lý xử lý trên sổ quỹ — số tháng này có thể còn điều chỉnh.
          </p>
        )}
        {mode === 'admin' && st.foreign_account_voucher_count > 0 && (
          <p role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {st.foreign_account_voucher_count} phiếu dùng sổ chủ nhà của toà vận hành khác — không biết tiền đang ở chủ nhà nào. Chuyển phiếu về đúng sổ, hoặc thêm sổ đó vào sổ chủ nhà của toà này.
            </span>
          </p>
        )}
        {st.pending.voucher_count > 0 && (
          <p className="flex items-start gap-2 rounded-md border border-amber-400 bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Còn {st.pending.voucher_count} phiếu chờ duyệt (thu {formatVND(st.pending.income)}, chi {formatVND(st.pending.expense)}
              {st.pending.landlord_deposit !== 0 && <>, cọc/trả thừa ở sổ chủ nhà {formatVND(st.pending.landlord_deposit)}</>}) — chưa tính vào quyết toán.
            </span>
          </p>
        )}
        {mode === 'admin' && month.status === 'OPEN' && month.close_blockers.length > 0 && (
          <ul className="list-disc pl-5 text-xs text-muted-foreground">
            {month.close_blockers.map((b) => <li key={b}>Chưa chốt được: {CLOSE_BLOCKER_LABEL[b]}</li>)}
          </ul>
        )}
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <Kpi label="Doanh thu" value={t.revenue} hint="đã duyệt · theo kỳ trên phiếu" />
          <Kpi label="Chi phí" value={t.expense} hint="đã duyệt · theo kỳ trên phiếu" />
          <Kpi label="Lợi nhuận" value={t.profit} tone={t.profit < 0 ? 'neg' : 'pos'} />
          <Kpi label={`Phần quản lý (${pct}%)`} value={t.manager_share} hint={t.profit <= 0 ? 'Lỗ hoặc hoà — không tính' : undefined} />
          <Kpi label="Phần chủ nhà" value={t.landlord_share} tone={t.landlord_share < 0 ? 'neg' : undefined} />
        </div>

        <div>
          <p className="mb-2 text-sm font-medium">Ai đang giữ tiền</p>
          <div className="overflow-hidden rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium" />
                  <th className="px-3 py-2 text-right font-medium">Thu (doanh thu)</th>
                  <th className="px-3 py-2 text-right font-medium">Chi (chi phí)</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t">
                  <td className="px-3 py-2">Sổ chủ nhà</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatVND(t.landlord_collected)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatVND(t.landlord_paid)}</td>
                </tr>
                <tr className="border-t">
                  <td className="px-3 py-2">Sổ quản lý</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatVND(t.manager_collected)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatVND(t.manager_paid)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-lg border-2 border-primary/30 bg-primary/5 p-4" data-testid="settlement-net">
          <p className="mb-2 text-sm font-medium">Quyết toán tháng</p>
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Phần quản lý ({pct}% lợi nhuận)</dt>
              <dd className="whitespace-nowrap tabular-nums">{formatVND(t.manager_share)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">+ Quản lý đã chi hộ</dt>
              <dd className="whitespace-nowrap tabular-nums">{formatVND(t.manager_paid)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">− Quản lý đã thu hộ (tiền lọt vào sổ quản lý)</dt>
              <dd className="whitespace-nowrap tabular-nums">{formatVND(t.manager_collected)}</dd>
            </div>
            {t.landlord_held_deposits !== 0 && (
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">
                  {t.landlord_held_deposits > 0 ? '+ Cọc/tiền khách trả thừa vào sổ chủ nhà (quản lý phải hoàn cho khách)' : '− Cọc chủ nhà đã chi trả khách thay quản lý'}
                </dt>
                <dd className="whitespace-nowrap tabular-nums">{formatVND(Math.abs(t.landlord_held_deposits))}</dd>
              </div>
            )}
            {t.landlord_extra_cash !== 0 && (
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">
                  {t.landlord_extra_cash > 0 ? '+ Tiền thối của khách nằm ở sổ chủ nhà' : '− Tiền thối chủ nhà đã chi'}
                </dt>
                <dd className="whitespace-nowrap tabular-nums">{formatVND(Math.abs(t.landlord_extra_cash))}</dd>
              </div>
            )}
          </dl>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
            <span className="flex items-center gap-1.5 font-semibold">
              {net.direction === 'EVEN' ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <ArrowRight className="h-4 w-4" />}
              {NET_DIRECTION_LABEL[net.direction]}
            </span>
            <span className="text-xl font-bold tabular-nums">{formatVND(net.amount)}</span>
          </div>
        </div>

        {mode === 'admin' && month.warnings && <SettlementWarningsBlock warnings={month.warnings} />}

        <TerminationBlock st={st} />

        {(st.deposits.received > 0 || st.deposits.paid_out > 0) && (
          <p className="text-xs text-muted-foreground">
            Cọc & tiền khách trả thừa trong tháng: thu {formatVND(st.deposits.received)} · chi/hoàn/cấn {formatVND(st.deposits.paid_out)}.
            Phần ở sổ quản lý không tính quyết toán (quản lý giữ để hoàn khách); phần vào sổ chủ nhà đã đưa vào bù trừ ở trên.
          </p>
        )}
        {st.excluded.voucher_count > 0 && (
          <p className="text-xs text-muted-foreground">
            {st.excluded.voucher_count} phiếu không tính vào lợi nhuận (khoản nội bộ hoặc phiếu tắt tính KQKD): thu {formatVND(st.excluded.income)} · chi {formatVND(st.excluded.expense)} — xem tab "Không tính".
          </p>
        )}

        <VoucherBreakdown vouchers={st.vouchers} totals={t} mode={mode} periodMonth={st.period_month} />

        {mode === 'admin' && month.kqkd_bridge && <KqkdBridgeBlock bridge={month.kqkd_bridge} />}
      </CardContent>
    </Card>
  );
}
