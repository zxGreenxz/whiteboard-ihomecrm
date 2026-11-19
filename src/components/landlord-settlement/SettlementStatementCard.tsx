// Tab "Quyết toán" của trang Quyết toán vận hành v3 — dùng chung cho màn quản trị và link chỉ đọc của chủ
// nhà: "Cách tính" số bàn giao tháng, tiền cọc của khách (người giữ cọc), các cảnh báo quanh quyết toán.
// Chỉ hiển thị: mọi con số lấy nguyên từ server (luật đầu src/lib/landlordSettlement.ts).
import type { ReactNode } from 'react';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import { cn, formatVND } from '@/lib/utils';
import {
  CLOSE_BLOCKER_LABEL,
  calcLines,
  DEPOSIT_HOLDERS,
  DEPOSIT_HOLDER_LABEL,
  landlordShortfallOf,
  monthLabel,
  type DepositHolder,
  type SettlementMonth,
  type SettlementStatement,
} from '@/lib/landlordSettlement';
import { KqkdBridgeBlock, SettlementWarningsBlock } from './SettlementChecks';
import { CalcRows, Eyebrow, NetResult, SectionCard } from './SettlementParts';

/** Thanh lý hợp đồng trong tháng — số lấy nguyên từ server (đã nằm trong các tổng phía trên). */
function TerminationBlock({ st }: { st: SettlementStatement }) {
  const tl = st.termination;
  const rows: { label: string; value: number; note: string }[] = [
    // cấn từ tiền cọc qua sổ cấn trừ (nội bộ) — không nói "sổ cọc của quản lý": chủ nhà có thể là bên giữ cọc
    { label: 'Cấn cọc vào khoản khách phải trả (điện, nước, ngày ở, phí…)', value: tl.revenue_from_deposit, note: 'doanh thu · cấn từ tiền cọc của khách' },
    { label: 'Khách bỏ cọc', value: tl.forfeit_revenue, note: 'doanh thu · cấn từ tiền cọc của khách' },
    { label: 'Khách trả thêm phần phí vượt cọc', value: tl.extra_receipt, note: 'doanh thu · bên giữ tiền theo sổ nhận' },
    { label: 'Trả thêm cho khách ngoài cọc (hoàn tiền phòng/tiền thừa)', value: tl.refund_beyond_deposit, note: 'chi phí · quản lý chi' },
    { label: 'Hoàn cọc cho khách', value: tl.deposit_refunded, note: 'trả lại tiền cọc · không tính lợi nhuận' },
  ];
  const shown = rows.filter((r) => r.value !== 0);
  if (shown.length === 0 && tl.pending_refund === 0) return null;
  return (
    <div className="rounded-[10px] border p-3" data-testid="settlement-termination">
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

function Alert({ children, tone = 'red' }: { children: ReactNode; tone?: 'red' | 'amber' | 'muted' }) {
  return (
    <p role={tone === 'red' ? 'alert' : undefined}
      className={cn('flex items-start gap-2 rounded-lg border p-2.5 text-sm',
        tone === 'red' && 'border-destructive/40 bg-destructive/5 text-destructive',
        tone === 'amber' && 'border-amber-400 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200',
        tone === 'muted' && 'bg-card text-muted-foreground')}>
      {tone !== 'muted' && <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
      <span>{children}</span>
    </p>
  );
}

/** Tiền cọc của khách: cọc ở hai sổ, người giữ cọc (admin đổi qua hộp Cài đặt toà — không gọi RPC ở đây). */
function DepositBlock({ month, st, mode, onRequestDepositHolder, lockedSince }: {
  month: SettlementMonth; st: SettlementStatement; mode: 'admin' | 'public';
  onRequestDepositHolder?: (holder: DepositHolder) => void;
  lockedSince: string | null;
}) {
  const t = st.totals;
  const d = st.deposits;
  const holder = st.deposit_holder;
  // người giữ cọc là cài đặt của TOÀ: đã chốt bất kỳ tháng nào thì không đổi được (cọc đang giữ không tự
  // bàn giao — chủ chốt 23/10/2026); tháng đang xem đã chốt cũng khoá
  const locked = month.status === 'CLOSED' || !!lockedSince;
  const lockTitle = lockedSince
    ? `Toà đã chốt ${monthLabel(lockedSince).toLowerCase()} — người giữ cọc chỉ đổi được khi chưa chốt tháng nào`
    : 'Tháng đã chốt — mở chốt để đổi';
  const dash = (v: number | null) => (v === null ? '—' : formatVND(v));
  return (
    <div className="mx-4 mb-3.5 rounded-[10px] border px-3.5 py-3" data-testid="settlement-deposits">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-[1_1_220px]">
          <Eyebrow>Tiền cọc của khách</Eyebrow>
          <p className="mt-0.5 text-[11.5px] text-muted-foreground">
            Cọc là tiền của khách, không tính doanh thu. Bên giữ cọc là bên hoàn cọc cho khách khi trả phòng.
          </p>
        </div>
        {mode === 'admin' ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-foreground/75" id="qt-holder-label">Người giữ cọc</span>
            <div role="radiogroup" aria-labelledby="qt-holder-label" className="inline-flex overflow-hidden rounded-[9px] border bg-card"
              title={locked ? lockTitle : undefined}>
              {DEPOSIT_HOLDERS.map((h, i) => {
                const on = h === holder;
                return (
                  <button key={h} type="button" role="radio" aria-checked={on}
                    disabled={locked || !onRequestDepositHolder}
                    title={locked ? lockTitle : on ? undefined : 'Đổi người giữ cọc của toà — áp cho mọi tháng (mở Cài đặt toà)'}
                    onClick={() => { if (!on && onRequestDepositHolder) onRequestDepositHolder(h); }}
                    className={cn('px-3 py-1.5 text-xs disabled:cursor-not-allowed', i > 0 && 'border-l',
                      on ? (h === 'MANAGER'
                        ? 'bg-orange-50 font-bold text-orange-700 dark:bg-orange-950 dark:text-orange-300'
                        : 'bg-emerald-50 font-bold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300')
                        : 'font-medium text-foreground/75 enabled:hover:bg-muted',
                      locked && !on && 'opacity-60')}>
                    {DEPOSIT_HOLDER_LABEL[h]}
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <span data-testid="settlement-holder-chip"
            className={cn('whitespace-nowrap rounded-full border px-2.5 py-1 text-[11.5px] font-bold',
              holder === 'MANAGER'
                ? 'border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-900 dark:bg-orange-950 dark:text-orange-300'
                : 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300')}>
            Người giữ cọc: {DEPOSIT_HOLDER_LABEL[holder]}
          </span>
        )}
      </div>
      <div className="mt-2.5 grid grid-cols-2 gap-2.5">
        <div className="min-w-0 rounded-[10px] border px-3 py-2">
          <Eyebrow className="text-emerald-800 dark:text-emerald-300">Cọc ở sổ chủ nhà</Eyebrow>
          <p className={cn('mt-0.5 truncate text-base font-extrabold tabular-nums', t.landlord_held_deposits === 0 && 'text-muted-foreground')}
            data-testid="settlement-deposit-landlord">
            {formatVND(t.landlord_held_deposits)}
          </p>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            Thu {formatVND(d.landlord_received)} · hoàn, cấn {formatVND(d.landlord_paid_out)}
          </p>
        </div>
        <div className="min-w-0 rounded-[10px] border px-3 py-2">
          <Eyebrow className="text-orange-700 dark:text-orange-300">Cọc ở sổ quản lý</Eyebrow>
          <p className={cn('mt-0.5 truncate text-base font-extrabold tabular-nums', !t.manager_held_deposits && 'text-muted-foreground')}
            data-testid="settlement-deposit-manager">
            {dash(t.manager_held_deposits)}
          </p>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            Thu {dash(d.manager_received)} · hoàn, cấn {dash(d.manager_paid_out)}
          </p>
        </div>
      </div>
      <p className="mt-2.5 flex items-start gap-2 rounded-[9px] border bg-muted/30 px-3 py-2 text-xs leading-normal text-foreground/80">
        <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        {holder === 'MANAGER' ? (
          <span>
            <b>Quản lý giữ cọc.</b> Cọc của khách nằm ở sổ chủ nhà ({formatVND(t.landlord_held_deposits)}) chủ nhà bàn giao cho quản lý,
            cộng vào cách tính ở trên. Cọc ở sổ quản lý thì quản lý giữ luôn.
          </span>
        ) : (
          <span>
            <b>Chủ nhà giữ cọc.</b> Cọc của khách nằm ở sổ quản lý ({dash(t.manager_held_deposits)}) quản lý bàn giao cho chủ nhà,
            trừ vào cách tính ở trên. Cọc ở sổ chủ nhà thì chủ nhà giữ luôn.
          </span>
        )}
      </p>
    </div>
  );
}

export function SettlementStatementCard({ month, mode, onRequestDepositHolder, holderLockedSince = null, onGoHandover }: {
  month: SettlementMonth;
  mode: 'admin' | 'public';
  /** Màn quản trị: bấm sang người giữ cọc khác ⇒ trang mở Cài đặt toà chọn sẵn giá trị đó. */
  onRequestDepositHolder?: (holder: DepositHolder) => void;
  /** Tháng chốt sớm nhất của toà ('YYYY-MM-DD'); có ⇒ người giữ cọc không đổi được nữa (cài đặt của toà). */
  holderLockedSince?: string | null;
  /** Link chủ nhà: thẻ "Số liệu đã đúng?" chuyển sang tab Bàn giao. */
  onGoHandover?: () => void;
}) {
  const st = month.statement;

  if (month.status === 'NOT_APPLICABLE' || !st) {
    const chuaToi = month.period_month.slice(0, 7) >= month.effective_from.slice(0, 7);
    return (
      <SectionCard title={monthLabel(month.period_month)} testId="settlement-statement"
        description={chuaToi
          ? <>Thoả thuận bắt đầu từ {monthLabel(month.effective_from).toLowerCase()} — số liệu có từ khi tháng đó bắt đầu.</>
          : <>Tháng này chưa thuộc thời gian áp dụng (bắt đầu từ {monthLabel(month.effective_from).toLowerCase()}).</>} />
    );
  }

  const t = st.totals;
  const shortfall = landlordShortfallOf(t);
  const pnl = st.vouchers.filter((v) => v.status === 'APPROVED' && v.group === 'PNL');
  const soChiQl = pnl.filter((v) => v.type === 'EXPENSE' && v.side === 'MANAGER').length;
  const soThuQl = pnl.filter((v) => v.type === 'INCOME' && v.side === 'MANAGER').length;
  const lines = calcLines({
    managerPercent: st.manager_percent,
    managerFixedAmount: st.manager_fixed_amount,
    managerShare: t.manager_share,
    fixedShare: t.manager_fixed_share,
    percentShare: t.manager_percent_share,
    profit: t.profit,
    managerPaid: t.manager_paid,
    managerCollected: t.manager_collected,
    paidSub: `${soChiQl} khoản chi từ sổ quản lý`,
    collectedSub: `tiền khách trả vào sổ quản lý (${soThuQl} khoản)`,
    depositHolder: st.deposit_holder,
    depositAdjustment: t.deposit_adjustment,
    extraCash: t.landlord_extra_cash,
  }, formatVND);
  const pendingSide = st.deposit_holder === 'MANAGER' ? 'sổ chủ nhà' : 'sổ quản lý';
  const sideBlocks = shortfall !== null || st.termination.pending_refund > 0
    || Object.entries(st.termination).some(([k, v]) => k !== 'deposit_offset' && k !== 'pending_refund' && v !== 0);

  return (
    <div className="flex flex-col gap-3" data-testid="settlement-statement">
      {st.reversed_voucher_count > 0 && mode === 'admin' && (
        <Alert>
          {st.reversed_voucher_count} phiếu đã duyệt nhưng bút toán sổ quỹ đã bị đảo — tiền không còn ở sổ nào. Phiếu vẫn được tính như Báo cáo Lợi Nhuận; xử lý phiếu (đăng lại hoặc huỷ) trước khi chốt.
        </Alert>
      )}
      {st.unposted_voucher_count > 0 && mode === 'admin' && (
        <Alert>
          {st.unposted_voucher_count} phiếu đã duyệt nhưng chưa ghi sổ quỹ — tiền chưa thực vào/ra. Ghi sổ hoặc huỷ trước khi chốt.
        </Alert>
      )}
      {(st.reversed_voucher_count > 0 || st.unposted_voucher_count > 0) && mode === 'public' && (
        <Alert tone="muted">Có phiếu của tháng đang được bên quản lý xử lý trên sổ quỹ — số tháng này có thể còn điều chỉnh.</Alert>
      )}
      {mode === 'admin' && st.foreign_account_voucher_count > 0 && (
        <Alert>
          {st.foreign_account_voucher_count} phiếu dùng sổ chủ nhà của toà vận hành khác — không biết tiền đang ở chủ nhà nào. Chuyển phiếu về đúng sổ, hoặc thêm sổ đó vào sổ chủ nhà của toà này.
        </Alert>
      )}
      {st.pending.voucher_count > 0 && (
        <Alert tone="amber">
          Còn {st.pending.voucher_count} phiếu chờ duyệt (thu {formatVND(st.pending.income)}, chi {formatVND(st.pending.expense)}
          {st.pending.deposit !== 0 && <>, cọc/trả thừa ở {pendingSide} {formatVND(st.pending.deposit)}</>}) — chưa tính vào quyết toán.
        </Alert>
      )}
      {mode === 'admin' && month.status === 'OPEN' && month.close_blockers.length > 0 && (
        <ul className="list-disc rounded-lg border bg-card py-2 pl-7 pr-3 text-xs text-muted-foreground" data-testid="settlement-close-blockers">
          {month.close_blockers.map((b) => <li key={b}>Chưa chốt được: {CLOSE_BLOCKER_LABEL[b]}</li>)}
        </ul>
      )}

      <SectionCard title={`Quyết toán ${monthLabel(month.period_month).toLowerCase()}`}
        description="Chia lợi nhuận xong, hai bên bù trừ phần mỗi bên đang giữ. Số dương là chủ nhà trả quản lý, số âm là quản lý trả lại chủ nhà.">
        <div className="grid gap-3 px-4 pb-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr))]">
          <div className="flex min-w-0 flex-col rounded-[10px] border px-3.5 py-3" data-testid="settlement-net">
            <Eyebrow>Cách tính</Eyebrow>
            <div className="mt-1"><CalcRows lines={lines} /></div>
            <div className="mt-auto pt-2"><NetResult net={t.landlord_owes_manager} /></div>
          </div>
          {sideBlocks && (
            <div className="flex min-w-0 flex-col gap-3">
              {shortfall !== null && (
                <p role="status" data-testid="settlement-landlord-shortfall"
                  className="flex items-start gap-2 rounded-[10px] border border-amber-400 bg-amber-50 p-2.5 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    {t.profit < 0
                      ? <>Tháng này lỗ {formatVND(-t.profit)} nhưng phí quản lý cố định vẫn tính đủ {formatVND(t.manager_fixed_share)}</>
                      : <>Lợi nhuận tháng này ({formatVND(t.profit)}) không đủ trả phí quản lý {formatVND(t.manager_share)}</>}
                    {' '}— chủ nhà phải bù <b className="tabular-nums">{formatVND(shortfall)}</b> (phần chủ nhà âm). Khoản này đã tính trong số quyết toán.
                  </span>
                </p>
              )}
              <TerminationBlock st={st} />
            </div>
          )}
        </div>
        <DepositBlock month={month} st={st} mode={mode} onRequestDepositHolder={onRequestDepositHolder}
          lockedSince={holderLockedSince} />
      </SectionCard>

      {mode === 'public' && month.status === 'CLOSED' && !month.confirmation && onGoHandover && (
        <button type="button" onClick={onGoHandover} data-testid="settlement-go-handover"
          className="flex items-center gap-2.5 rounded-xl border border-l-4 border-l-primary bg-card px-3.5 py-3 text-left hover:bg-muted/30">
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-bold">Số liệu đã đúng?</span>
            <span className="mt-px block text-[11.5px] text-muted-foreground">
              Sang tab Bàn giao để xác nhận đã xem số liệu {monthLabel(month.period_month).toLowerCase()}.
            </span>
          </span>
          <ArrowRight className="h-[18px] w-[18px] shrink-0 text-primary" aria-hidden />
        </button>
      )}

      {mode === 'admin' && month.warnings && <SettlementWarningsBlock warnings={month.warnings} />}
      {mode === 'admin' && month.kqkd_bridge && <KqkdBridgeBlock bridge={month.kqkd_bridge} />}
    </div>
  );
}
