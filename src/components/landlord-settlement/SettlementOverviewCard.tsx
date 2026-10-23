// Tab "Thống kê" của Quyết toán vận hành v3: từng tháng theo năm (lợi nhuận, phần quản lý, tiền bàn giao +
// "Cách tính" mở trong dòng, xác nhận của chủ nhà), rồi tổng quyết toán từ tháng bắt đầu áp dụng: còn lại
// sau các khoản hai bên đã trả nhau. Mọi tổng do server cộng.
import { useState } from 'react';
import { Ban, CheckCircle2, ChevronDown, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn, formatVND } from '@/lib/utils';
import {
  NET_DIRECTION_LABEL,
  PAYMENT_DIRECTION_LABEL,
  calcLines,
  describeNet,
  managerTermsShort,
  monthConfirmState,
  monthKey,
  monthLabel,
  settlementYears,
  vnDate,
  type SettlementOverview,
  type SettlementPayment,
} from '@/lib/landlordSettlement';
import { CalcRows, Eyebrow, NetResult, SectionCard } from './SettlementParts';

type OverviewMonth = SettlementOverview['months'][number];

function NetText({ value, className = '' }: { value: number; className?: string }) {
  const net = describeNet(value);
  if (net.direction === 'EVEN') return <span className={`text-muted-foreground ${className}`}>0 đ</span>;
  return (
    <span className={`tabular-nums ${className}`}>
      <span className={net.direction === 'LANDLORD_PAYS' ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}>
        {net.direction === 'LANDLORD_PAYS' ? 'Chủ nhà trả ' : 'Quản lý trả '}
      </span>
      {formatVND(net.amount)}
    </span>
  );
}

const fmtDay = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

const DIR_SHORT = { LANDLORD_PAYS: 'Chủ nhà trả', MANAGER_PAYS: 'Quản lý trả', EVEN: 'Không ai trả' } as const;
const DIR_COLOR = {
  LANDLORD_PAYS: 'text-emerald-700 dark:text-emerald-400',
  MANAGER_PAYS: 'text-orange-700 dark:text-orange-400',
  EVEN: 'text-muted-foreground',
} as const;

/** Cột "Chủ nhà": đã xác nhận / chờ — chưa xác nhận / đang chạy — tạm tính, kèm đổi sau chốt và phiếu chờ. */
function ConfirmStatus({ m, viewing, mode }: { m: OverviewMonth; viewing: boolean; mode: 'admin' | 'public' }) {
  const s = monthConfirmState(m, viewing);
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5" data-testid="settlement-stat-status">
      {s.kind === 'CONFIRMED' && (
        <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-semibold text-green-700 dark:text-green-400">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden />Đã xác nhận{' '}
          <span className="font-normal text-muted-foreground">{vnDate(s.at)}</span>
        </span>
      )}
      {s.kind === 'WAITING' && (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-semibold text-amber-700 dark:text-amber-400">
          <span className="h-[7px] w-[7px] rounded-full bg-amber-500" aria-hidden />{s.text}
        </span>
      )}
      {s.kind === 'OPEN' && (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-semibold text-muted-foreground">
          <span className="h-[7px] w-[7px] rounded-full bg-slate-300" aria-hidden />{s.text}
        </span>
      )}
      {m.status === 'CLOSED' && m.is_stale && (
        <span className={cn('whitespace-nowrap text-[11px]', mode === 'admin' ? 'font-semibold text-destructive' : 'text-muted-foreground')}>
          {mode === 'admin' ? 'Đổi sau khi chốt' : 'Chờ chốt lại'}
        </span>
      )}
      {m.pending_count > 0 && <span className="whitespace-nowrap text-[11px] text-amber-700 dark:text-amber-400">{m.pending_count} phiếu chờ</span>}
    </span>
  );
}

function MonthCalc({ m, onClose, onOpenMonth }: { m: OverviewMonth; onClose: () => void; onOpenMonth?: () => void }) {
  const lines = calcLines({
    managerPercent: m.manager_percent,
    managerFixedAmount: m.manager_fixed_amount,
    managerShare: m.manager_share,
    fixedShare: m.manager_fixed_share,
    percentShare: m.manager_percent_share,
    profit: m.profit,
    managerPaid: m.manager_paid,
    managerCollected: m.manager_collected,
    depositHolder: m.deposit_holder,
    depositAdjustment: m.deposit_adjustment,
    extraCash: m.extra_cash,
  }, formatVND);
  const thieu = m.manager_paid === null || m.manager_collected === null || m.deposit_adjustment === null;
  return (
    <div className="ml-auto box-border max-w-[560px] rounded-[10px] border bg-card px-3.5 pb-3 pt-2.5" data-testid="settlement-stat-calc">
      <div className="flex items-center justify-between gap-2">
        <Eyebrow>Cách tính · {monthLabel(m.period_month)}</Eyebrow>
        <button type="button" onClick={onClose} aria-label="Đóng cách tính"
          className="flex h-[26px] w-[26px] items-center justify-center rounded-md border text-muted-foreground hover:bg-muted">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <CalcRows lines={lines} compact />
      {thieu && (
        <p className="py-1 text-[11px] text-muted-foreground">
          Chưa có đủ các dòng chi tiết của tháng này.{' '}
          {onOpenMonth && <button type="button" className="text-primary underline underline-offset-2" onClick={onOpenMonth}>Mở tháng để xem</button>}
        </p>
      )}
      <div className="mt-1.5"><NetResult net={m.landlord_owes_manager} compact /></div>
    </div>
  );
}

function StatsTable({ overview, mode, selectedMonth, onSelectMonth, narrow }: {
  overview: SettlementOverview; mode: 'admin' | 'public'; selectedMonth: string | null;
  onSelectMonth?: (month: string) => void; narrow: boolean;
}) {
  const years = settlementYears(overview.months);
  const [yearPick, setYearPick] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const viewYear = selectedMonth && years.includes(selectedMonth.slice(0, 4)) ? selectedMonth.slice(0, 4) : years[0] ?? null;
  const year = yearPick && years.includes(yearPick) ? yearPick : viewYear;
  const rows = overview.months
    .map((m) => ({ m, key: monthKey(m.period_month) }))
    .filter((r) => year !== null && r.key.startsWith(year))
    .sort((a, b) => b.key.localeCompare(a.key));
  const termsHead = managerTermsShort(overview);
  const toggle = (key: string) => setOpenKey((k) => (k === key ? null : key));

  const mgrNote = (m: OverviewMonth) => {
    const notes: string[] = [];
    if (managerTermsShort(m) !== termsHead) notes.push(managerTermsShort(m));
    if (m.profit <= 0 && m.manager_fixed_amount <= 0) notes.push('lỗ, không tính');
    return notes.join(' · ');
  };
  const monthBtn = (m: OverviewMonth, key: string, current: boolean) => (
    <button type="button" disabled={!onSelectMonth} onClick={onSelectMonth ? () => onSelectMonth(key) : undefined}
      title={current ? 'Tháng đang xem' : `Xem ${monthLabel(m.period_month).toLowerCase()}`}
      className={cn('whitespace-nowrap text-left font-bold enabled:hover:underline', current ? 'text-emerald-800 dark:text-emerald-300' : 'text-foreground')}>
      {monthLabel(m.period_month)}
    </button>
  );
  const netBtn = (m: OverviewMonth, key: string, open: boolean, full: boolean) => {
    const d = describeNet(m.landlord_owes_manager);
    return (
      <button type="button" onClick={() => toggle(key)} aria-expanded={open} title="Xem cách tính" data-testid="settlement-stat-net"
        className={cn('items-center gap-1.5 whitespace-nowrap',
          full
            ? 'mt-1.5 flex w-full justify-between border-t border-dashed pt-1.5 text-left'
            : '-mx-1.5 -my-0.5 inline-flex justify-self-end rounded-md border border-transparent px-1.5 py-0.5 hover:border-border hover:bg-muted')}>
        {full && <span className="text-[11.5px] text-muted-foreground">Tiền bàn giao · <span className={cn('font-semibold', DIR_COLOR[d.direction])}>{DIR_SHORT[d.direction]}</span></span>}
        <span className="inline-flex items-center gap-1.5">
          {!full && <span className={cn('text-[11.5px] font-semibold', DIR_COLOR[d.direction])}>{DIR_SHORT[d.direction]}</span>}
          <span className="font-extrabold tabular-nums">{formatVND(d.amount)}</span>
          <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden />
        </span>
      </button>
    );
  };

  return (
    <SectionCard title="Thống kê quyết toán" testId="settlement-stats"
      description="Theo dõi nhanh từng tháng: lợi nhuận, phần quản lý nhận, tiền bàn giao và xác nhận của chủ nhà."
      actions={years.length > 0 ? (
        <div role="tablist" aria-label="Chọn năm" className="inline-flex shrink-0 overflow-hidden rounded-[9px] border bg-card">
          {years.map((y, i) => (
            <button key={y} type="button" role="tab" aria-selected={y === year} onClick={() => setYearPick(y)}
              className={cn('px-3.5 py-1.5 text-xs', i > 0 && 'border-l',
                y === year ? 'bg-primary/10 font-bold text-primary dark:text-emerald-300' : 'font-medium text-foreground/75 hover:bg-muted')}>
              Năm {y}
            </button>
          ))}
        </div>
      ) : undefined}>
      {rows.length === 0 ? (
        <p className="border-t px-4 py-6 text-center text-sm text-muted-foreground">
          Chưa có tháng nào — thoả thuận bắt đầu từ {monthLabel(overview.effective_from).toLowerCase()}.
        </p>
      ) : narrow ? (
        <ul>
          {rows.map(({ m, key }) => {
            const current = key === selectedMonth;
            const open = openKey === key;
            const note = mgrNote(m);
            return (
              <li key={key} data-testid="settlement-stat-row" data-month={key} className={cn('border-t', current && 'bg-emerald-50/60 dark:bg-emerald-950/20')}>
                <div className="px-4 py-2.5 tabular-nums">
                  <div className="flex items-center justify-between gap-2 text-[13px]">
                    {monthBtn(m, key, current)}
                    <ConfirmStatus m={m} viewing={current} mode={mode} />
                  </div>
                  <div className="mt-1.5 grid grid-cols-2 gap-2 text-xs">
                    <div className="min-w-0">
                      <Eyebrow className="text-[10px]">Lợi nhuận</Eyebrow>
                      <p className={cn('whitespace-nowrap font-semibold', m.profit < 0 && 'text-amber-700 dark:text-amber-400')}>{formatVND(m.profit)}</p>
                    </div>
                    <div className="min-w-0">
                      <Eyebrow className="text-[10px]">Quản lý nhận</Eyebrow>
                      <p className="whitespace-nowrap font-semibold">
                        {formatVND(m.manager_share)}{note && <span className="ml-1 text-[11px] font-normal text-muted-foreground">{note}</span>}
                      </p>
                    </div>
                  </div>
                  {netBtn(m, key, open, true)}
                </div>
                {open && (
                  <div className="px-3 pb-3">
                    <MonthCalc m={m} onClose={() => toggle(key)} onOpenMonth={onSelectMonth ? () => onSelectMonth(key) : undefined} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <div>
          <div className="grid grid-cols-[minmax(110px,1fr)_minmax(0,1.1fr)_minmax(0,1.2fr)_minmax(0,1.5fr)_minmax(150px,1.1fr)] gap-3 border-t px-4 py-1.5 text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground">
            <span>Tháng</span><span className="text-right">Lợi nhuận</span><span className="text-right">Quản lý nhận ({termsHead})</span>
            <span className="text-right">Tiền bàn giao</span><span>Chủ nhà</span>
          </div>
          <ul>
            {rows.map(({ m, key }) => {
              const current = key === selectedMonth;
              const open = openKey === key;
              const note = mgrNote(m);
              return (
                <li key={key} data-testid="settlement-stat-row" data-month={key} className={cn('border-t', current && 'bg-emerald-50/60 dark:bg-emerald-950/20')}>
                  <div className="grid grid-cols-[minmax(110px,1fr)_minmax(0,1.1fr)_minmax(0,1.2fr)_minmax(0,1.5fr)_minmax(150px,1.1fr)] items-center gap-3 px-4 py-2 text-[12.5px] tabular-nums">
                    {monthBtn(m, key, current)}
                    <span className={cn('whitespace-nowrap text-right font-semibold', m.profit < 0 && 'text-amber-700 dark:text-amber-400')}>{formatVND(m.profit)}</span>
                    <span className="whitespace-nowrap text-right">
                      <span className="font-semibold">{formatVND(m.manager_share)}</span>
                      {note && <span className="block text-[11px] text-muted-foreground">{note}</span>}
                    </span>
                    {netBtn(m, key, open, false)}
                    <ConfirmStatus m={m} viewing={current} mode={mode} />
                  </div>
                  {open && (
                    <div className="px-4 pb-3">
                      <MonthCalc m={m} onClose={() => toggle(key)} onOpenMonth={onSelectMonth ? () => onSelectMonth(key) : undefined} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </SectionCard>
  );
}

export function SettlementOverviewCard({
  overview,
  mode,
  selectedMonth,
  onSelectMonth,
  onVoidPayment,
  narrow = false,
}: {
  overview: SettlementOverview;
  mode: 'admin' | 'public';
  /** 'YYYY-MM' */
  selectedMonth: string | null;
  onSelectMonth?: (month: string) => void;
  /** Chỉ màn quản trị truyền vào. */
  onVoidPayment?: (payment: SettlementPayment) => void;
  narrow?: boolean;
}) {
  const t = overview.totals;
  const balance = describeNet(t.balance_closed);
  const balanceAll = describeNet(t.balance_with_open);
  const hasOpen = overview.months.some((m) => m.status === 'OPEN');

  return (
    <div className="flex flex-col gap-3" data-testid="settlement-overview">
      <StatsTable overview={overview} mode={mode} selectedMonth={selectedMonth} onSelectMonth={onSelectMonth} narrow={narrow} />

      <SectionCard title="Tổng quyết toán"
        description={<>Từ {monthLabel(overview.effective_from).toLowerCase()} · số dương là chủ nhà trả quản lý, số âm là quản lý trả lại chủ nhà.</>}>
        <div className="space-y-4 px-4 pb-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-[10px] border-2 border-primary/30 bg-primary/5 p-3" data-testid="settlement-balance">
              <p className="text-xs text-muted-foreground">Còn lại (các tháng đã chốt, trừ phần đã trả)</p>
              {t.closed_month_count === 0 ? (
                // chưa chốt tháng nào: "0 đ — hai bên không còn nợ nhau" là SAI nghĩa
                <>
                  <p className="mt-1 font-semibold">Chưa chốt tháng nào</p>
                  <p className="text-xs text-muted-foreground">
                    {t.opening_balance !== 0 || t.paid_by_landlord !== 0 || t.paid_by_manager !== 0
                      ? <>Tính riêng số dư đầu kỳ và các khoản đã trả: {NET_DIRECTION_LABEL[balance.direction].toLowerCase()} {formatVND(balance.amount)}.</>
                      : 'Xem số tạm tính bên cạnh.'}
                  </p>
                </>
              ) : (
                <>
                  <p className="mt-1 font-semibold">{NET_DIRECTION_LABEL[balance.direction]}</p>
                  <p className="text-xl font-bold tabular-nums">{formatVND(balance.amount)}</p>
                  <p className="text-[11px] text-muted-foreground">{t.closed_month_count} tháng đã chốt</p>
                </>
              )}
            </div>
            <div className="rounded-[10px] border p-3">
              <p className="text-xs text-muted-foreground">Nếu tính cả tháng tạm tính</p>
              <p className="mt-1 font-semibold">{NET_DIRECTION_LABEL[balanceAll.direction]}</p>
              <p className="text-xl font-bold tabular-nums">{formatVND(balanceAll.amount)}</p>
              {overview.months.length === 0
                ? <p className="text-[11px] text-muted-foreground">Chưa tới tháng áp dụng ({monthLabel(overview.effective_from).toLowerCase()}).</p>
                : !hasOpen && <p className="text-[11px] text-muted-foreground">Mọi tháng đều đã chốt.</p>}
            </div>
          </div>
          {t.opening_balance !== 0 && (
            <p className="text-xs text-muted-foreground">
              Đã gồm số dư đầu kỳ: <NetText value={t.opening_balance} /> (khai ở Cài đặt toà
              {overview.opening_confirmed ? ', đã đối chiếu với chủ nhà' : ' — chưa đối chiếu với chủ nhà'}).
            </p>
          )}

          <div>
            <div className="mb-2 flex flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
              <p className="text-sm font-medium">Hai bên đã trả nhau</p>
              <p className="text-xs text-muted-foreground">
                Chủ nhà đã trả {formatVND(t.paid_by_landlord)} · Quản lý đã trả {formatVND(t.paid_by_manager)}
              </p>
            </div>
            {overview.payments.length === 0 ? (
              <p className="rounded-md border border-dashed p-3 text-center text-sm text-muted-foreground">Chưa ghi nhận khoản thanh toán nào.</p>
            ) : (
              <div className="divide-y rounded-lg border">
                {overview.payments.map((p, i) => (
                  <div key={p.id ?? `${p.paid_on}-${i}`} className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm ${p.voided ? 'opacity-60' : ''}`}>
                    <div className="min-w-0">
                      <p className={p.voided ? 'line-through' : ''}>
                        {fmtDay(p.paid_on)} · {PAYMENT_DIRECTION_LABEL[p.direction]}
                      </p>
                      {(p.note || p.voided) && (
                        <p className="text-xs text-muted-foreground">
                          {p.note}{p.voided ? ` · Đã huỷ: ${p.void_reason ?? ''}` : ''}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`font-medium tabular-nums ${p.voided ? 'line-through' : ''}`}>{formatVND(p.amount)}</span>
                      {onVoidPayment && !p.voided && p.id && (
                        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-muted-foreground" onClick={() => onVoidPayment(p)}>
                          <Ban className="mr-1 h-3.5 w-3.5" />Huỷ
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
