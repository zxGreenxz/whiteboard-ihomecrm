// Đầu trang Quyết toán vận hành v3 (nền xanh đậm): tên trang, toà · chủ nhà, chuyển tháng ‹ › , Doanh thu −
// Chi phí = Lợi nhuận, thanh phần quản lý, thẻ "Quyết toán tháng X" và các chip trạng thái. Rộng ≥ 720px và
// hẹp < 720px khác bố cục (đo bề rộng khối, không theo cửa sổ — màn quản trị nằm trong MainLayout).
// Chỉ hiển thị: số lấy nguyên server; tỷ lệ thanh chỉ để vẽ.
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';
import { ArrowRight, Check, ChevronLeft, ChevronRight, Handshake, Lock } from 'lucide-react';
import { cn, formatVND } from '@/lib/utils';
import {
  CLOSE_BLOCKER_LABEL,
  CLOSE_BLOCKER_SHORT,
  NET_DIRECTION_LABEL,
  barPercent,
  depositAdjustmentLine,
  describeNet,
  managerTermsLabel,
  managerTermsShort,
  monthKey,
  monthLabel,
  monthShort,
  vnDate,
  vnDateTime,
  type SettlementMonth,
  type SettlementStatement,
} from '@/lib/landlordSettlement';

/** Nút trên nền tối của đầu trang (Ghi nhận thanh toán, Link cho chủ nhà…). */
export const HeroButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }>(
  ({ className, primary = false, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-[9px] px-3 py-1.5 text-[12.5px] transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:cursor-not-allowed',
        primary
          ? 'bg-emerald-400 font-bold text-emerald-950 hover:bg-emerald-300 disabled:opacity-55 disabled:hover:bg-emerald-400'
          : 'border border-white/20 font-medium text-white hover:bg-white/10 disabled:opacity-50 disabled:hover:bg-transparent',
        className,
      )}
      {...props}
    />
  ),
);
HeroButton.displayName = 'HeroButton';

type ChipTone = 'amber' | 'green' | 'neutral' | 'red';
const CHIP_TONE: Record<ChipTone, string> = {
  amber: 'border-amber-500/35 bg-amber-500/15 text-amber-100',
  green: 'border-emerald-400/40 bg-emerald-400/15 text-emerald-200',
  neutral: 'border-white/20 bg-white/10 text-white/75',
  red: 'border-red-400/50 bg-red-500/20 text-red-100',
};
function Chip({ tone, children, title, dot = false, icon, testId }: {
  tone: ChipTone; children: ReactNode; title?: string; dot?: boolean; icon?: ReactNode; testId?: string;
}) {
  return (
    <span title={title} data-testid={testId}
      className={cn('inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-semibold', CHIP_TONE[tone])}>
      {dot && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" aria-hidden />}
      {icon}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

/** Chuyển tháng ‹ Tháng 10/2026 ›. months: 'YYYY-MM', mới nhất trước. */
function MonthNav({ months, selected, onSelect, narrow }: {
  months: readonly string[]; selected: string | null; onSelect: (m: string) => void; narrow: boolean;
}) {
  const i = selected ? months.indexOf(selected) : -1;
  const older = i >= 0 && i + 1 < months.length ? months[i + 1] : null;
  const newer = i > 0 ? months[i - 1] : null;
  const btn = cn('flex items-center px-2.5 py-1.5 leading-none text-white/70 hover:bg-white/10 disabled:text-white/30 disabled:hover:bg-transparent',
    narrow && 'px-1.5');
  return (
    <div className="flex shrink-0 items-center overflow-hidden rounded-[9px] border border-white/20" data-testid="settlement-month-nav">
      <button type="button" className={cn(btn, !narrow && 'border-r border-white/15')} disabled={!older}
        onClick={older ? () => onSelect(older) : undefined}
        title={older ? `Về ${monthLabel(older).toLowerCase()}` : 'Đây là tháng đầu tiên áp dụng'} aria-label="Tháng trước">
        <ChevronLeft className={narrow ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
      </button>
      <span className={cn('whitespace-nowrap font-semibold tabular-nums text-white', narrow ? 'px-1 py-1.5 text-xs font-bold' : 'px-3 py-1.5 text-[12.5px]')}
        data-testid="settlement-month-label">
        {selected ? (narrow ? `T${Number(selected.slice(5, 7))}/${selected.slice(0, 4)}` : monthLabel(selected)) : '—'}
      </span>
      <button type="button" className={cn(btn, !narrow && 'border-l border-white/15')} disabled={!newer}
        onClick={newer ? () => onSelect(newer) : undefined}
        title={newer ? `Sang ${monthLabel(newer).toLowerCase()}` : 'Chưa có tháng sau'} aria-label="Tháng sau">
        <ChevronRight className={narrow ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
      </button>
    </div>
  );
}

/** "Phần quản lý X + quản lý chi hộ Y − quản lý thu hộ Z + cọc … + tiền thối …" — chép số server, không tính. */
function netFormula(st: SettlementStatement): string {
  const t = st.totals;
  const parts = [
    `Phần quản lý ${formatVND(t.manager_share)}`,
    `+ quản lý chi hộ ${formatVND(t.manager_paid)}`,
    `− quản lý thu hộ ${formatVND(t.manager_collected)}`,
  ];
  if (t.deposit_adjustment !== 0) {
    const d = depositAdjustmentLine(st.deposit_holder, t.deposit_adjustment);
    parts.push(`${d.label.replace(/^([+−] )(\S)/, (_m, s: string, c: string) => s + c.toLowerCase())} ${formatVND(d.amount)}`);
  }
  if (t.landlord_extra_cash !== 0) {
    parts.push(`${t.landlord_extra_cash > 0 ? '+' : '−'} tiền thối ${formatVND(Math.abs(t.landlord_extra_cash))}`);
  }
  return parts.join(' ');
}

function Kpi({ label, value, tone, sub, big = false }: { label: string; value: number; tone: string; sub?: string; big?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="whitespace-nowrap text-[10.5px] font-bold uppercase tracking-widest text-white/55">{label}</p>
      <p className={cn('mt-0.5 whitespace-nowrap font-extrabold tabular-nums', big ? 'text-[26px] leading-tight' : 'text-[22px] leading-tight', tone)}>
        {formatVND(value)}
      </p>
      {sub && <p className="mt-0.5 text-[11px] text-white/50">{sub}</p>}
    </div>
  );
}

const Op = ({ children }: { children: ReactNode }) => (
  <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-white/10 font-bold text-white/70" aria-hidden>
    {children}
  </span>
);

function ManagerBar({ st, narrow }: { st: SettlementStatement; narrow: boolean }) {
  const t = st.totals;
  const w = barPercent(t.manager_share, t.profit);
  return (
    <>
      <div className={cn('flex overflow-hidden rounded-full bg-white/10', narrow ? 'mt-2.5 h-[5px]' : 'mt-2 h-1.5 max-w-[300px]')} aria-hidden>
        <div className="bg-blue-100" style={{ width: `${w}%` }} data-testid="settlement-manager-bar" />
      </div>
      <p className={cn('mt-1.5 flex flex-wrap gap-x-3.5 text-white/75', narrow ? 'text-[11.5px]' : 'text-xs')}>
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <span className="h-[7px] w-[7px] rounded-full bg-blue-100" aria-hidden />
          Quản lý {managerTermsShort(st)} ·{' '}
          <b className="font-extrabold tabular-nums text-white">{formatVND(t.manager_share)}</b>
        </span>
      </p>
    </>
  );
}

function NetCard({ month, st, narrow, onShowCalc }: { month: SettlementMonth; st: SettlementStatement; narrow: boolean; onShowCalc: () => void }) {
  const net = describeNet(st.totals.landlord_owes_manager);
  const thang = monthShort(month.period_month);
  if (narrow) {
    return (
      <button type="button" onClick={onShowCalc} data-testid="settlement-hero-net"
        className="mt-3 flex w-full items-center gap-2.5 rounded-xl border border-amber-200/30 bg-amber-200/10 px-3 py-2.5 text-left">
        <span className="min-w-0 flex-1">
          <span className="block text-[9.5px] font-bold uppercase tracking-wider text-white/55">Quyết toán tháng {Number(thang.slice(0, 2))}</span>
          <span className="mt-px block text-[12.5px] font-semibold text-white">{NET_DIRECTION_LABEL[net.direction]}</span>
        </span>
        <span className="whitespace-nowrap text-[19px] font-extrabold tabular-nums text-amber-200">{formatVND(net.amount)}</span>
        <ChevronRight className="h-4 w-4 shrink-0 text-white/50" aria-hidden />
      </button>
    );
  }
  return (
    <button type="button" onClick={onShowCalc} data-testid="settlement-hero-net"
      className="min-w-0 max-w-[340px] flex-[1_1_260px] rounded-xl border border-white/15 bg-white/[0.06] px-4 py-3.5 text-left transition-colors hover:bg-white/10">
      <span className="block text-[10.5px] font-bold uppercase tracking-widest text-white/55">Quyết toán tháng {thang}</span>
      <span className="mt-1.5 flex items-center gap-1.5 text-[13px] font-semibold text-white">
        {net.direction === 'EVEN' ? <Check className="h-4 w-4" /> : <ArrowRight className="h-4 w-4" />}
        {NET_DIRECTION_LABEL[net.direction]}
      </span>
      <span className="mt-0.5 block whitespace-nowrap text-[28px] font-extrabold leading-tight tabular-nums text-amber-200">{formatVND(net.amount)}</span>
      <span className="mt-1 block text-[11.5px] leading-normal text-white/60">{netFormula(st)}</span>
      <span className="mt-2 flex items-center gap-1 text-[11.5px] font-semibold text-emerald-200">
        Xem cách tính<ChevronRight className="h-3.5 w-3.5" />
      </span>
    </button>
  );
}

function StatusChips({ month, mode, narrow, isFetching }: {
  month: SettlementMonth; mode: 'admin' | 'public'; narrow: boolean; isFetching: boolean;
}) {
  const st = month.statement;
  const chips: ReactNode[] = [];
  const closed = month.closed;
  const lockIcon = <Lock className="h-3 w-3 shrink-0" aria-hidden />;
  if (month.status === 'OPEN') {
    chips.push(<Chip key="st" tone="amber" dot testId="chip-status">{month.is_current_month ? 'Tạm tính — tháng đang chạy' : 'Tạm tính — chưa chốt'}</Chip>);
  } else if (month.status === 'CLOSED' && month.is_stale) {
    chips.push(mode === 'admin'
      ? <Chip key="st" tone="red" testId="chip-status">Phiếu đã đổi sau khi chốt</Chip>
      : <Chip key="st" tone="neutral" icon={lockIcon} testId="chip-status">Đã chốt — đang chờ chốt lại</Chip>);
  } else if (month.status === 'CLOSED' && closed) {
    const by = mode === 'admin' && closed.closed_by_name ? ` bởi ${closed.closed_by_name}` : '';
    if (narrow && month.confirmation) {
      chips.push(<Chip key="st" tone="green" icon={<Check className="h-3 w-3 shrink-0" />} testId="chip-status">Đã chốt · chủ nhà đã xác nhận</Chip>);
    } else {
      chips.push(
        <Chip key="st" tone="green" icon={lockIcon} testId="chip-status" title={`Chốt lúc ${vnDateTime(closed.closed_at)}${by}`}>
          {narrow ? `Đã chốt ${vnDate(closed.closed_at)}` : `Đã chốt lúc ${vnDateTime(closed.closed_at)}${by}`}
        </Chip>,
      );
    }
  }
  if (!narrow && month.status === 'CLOSED' && month.confirmation) {
    chips.push(
      <Chip key="cf" tone="green" icon={<Check className="h-3 w-3 shrink-0" />} testId="chip-confirmed">
        Chủ nhà đã xác nhận {vnDateTime(month.confirmation.confirmed_at)}
      </Chip>,
    );
  }
  if (st) {
    chips.push(st.pending.voucher_count > 0
      ? <Chip key="pd" tone="amber" dot testId="chip-pending">{st.pending.voucher_count} phiếu chờ duyệt</Chip>
      : <Chip key="pd" tone="neutral" testId="chip-pending">Không còn phiếu chờ duyệt</Chip>);
  }
  if (mode === 'admin' && month.kqkd_bridge) {
    const b = month.kqkd_bridge;
    const khop = Math.abs(b.kqkd_profit - b.settlement_profit) < 0.5 && b.rows.length === 0;
    chips.push(khop
      ? <Chip key="kq" tone="green" testId="chip-bridge">Khớp Báo cáo LN · {formatVND(b.kqkd_profit)}</Chip>
      : <Chip key="kq" tone={b.rows.some((r) => r.reason === 'FORMULA_DRIFT') ? 'red' : 'amber'} testId="chip-bridge"
          title="Xem chi tiết ở tab Quyết toán — Đối chiếu với Báo cáo LN">
          Lệch Báo cáo LN · {b.rows.length} phiếu
        </Chip>);
  }
  if (mode === 'admin' && month.status === 'OPEN' && month.close_blockers.length > 0) {
    const first = month.close_blockers[0];
    const more = month.close_blockers.length - 1;
    chips.push(
      <Chip key="bl" tone="amber" dot testId="chip-blocker" title={month.close_blockers.map((b) => CLOSE_BLOCKER_LABEL[b]).join('\n')}>
        Chưa chốt được: {CLOSE_BLOCKER_SHORT[first]}{more > 0 ? ` (+${more} lý do)` : ''}
      </Chip>,
    );
  }
  if (isFetching) chips.push(<Chip key="ft" tone="neutral">Đang cập nhật…</Chip>);
  return <div className={cn('flex flex-wrap items-center', narrow ? 'mt-2.5 gap-1.5' : 'mt-4 gap-2')}>{chips}</div>;
}

function TermsLine({ month, st }: { month: SettlementMonth; st: SettlementStatement }) {
  const note = st.manager_percent <= 0 ? '' : st.manager_fixed_amount > 0 ? ' · phần % lỗ thì không tính' : ' · lỗ không tính';
  return (
    <span className="text-[11px] text-white/55">
      Quản lý nhận {managerTermsLabel(st, formatVND)}{note}
      {monthKey(st.terms_from) !== monthKey(month.effective_from) && <> · điều khoản áp từ {monthShort(st.terms_from)}</>}
    </span>
  );
}

export function SettlementHero({
  mode, buildingName, landlordName, month, months, selectedMonth, onSelectMonth, narrow,
  buildingPicker, actions, onShowCalc, loading = false, isFetching = false,
}: {
  mode: 'admin' | 'public';
  buildingName: string | null;
  landlordName: string | null;
  month: SettlementMonth | null;
  /** 'YYYY-MM', mới nhất trước. */
  months: readonly string[];
  selectedMonth: string | null;
  onSelectMonth: (m: string) => void;
  narrow: boolean;
  /** Màn quản trị: nút chọn toà. */
  buildingPicker?: ReactNode;
  /** Màn quản trị: Chốt tháng / Mở chốt, Ghi nhận thanh toán, Link, Cài đặt, Thêm toà. */
  actions?: ReactNode;
  onShowCalc: () => void;
  loading?: boolean;
  isFetching?: boolean;
}) {
  const st = month?.statement ?? null;
  const t = st?.totals;
  const sub = buildingName ? `${buildingName}${landlordName ? ` · Chủ nhà: ${landlordName}` : ''}` : null;
  const pnl = st ? st.vouchers.filter((v) => v.status === 'APPROVED' && v.group === 'PNL') : [];
  const soThu = pnl.filter((v) => v.type === 'INCOME').length;
  const soChi = pnl.filter((v) => v.type === 'EXPENSE').length;
  const nav = months.length > 0
    ? <MonthNav months={months} selected={selectedMonth} onSelect={onSelectMonth} narrow={narrow} />
    : null;
  const icon = (
    <span className={cn('flex shrink-0 items-center justify-center rounded-[10px] bg-white/10 text-emerald-300', narrow ? 'h-8 w-8' : 'h-[38px] w-[38px]')}>
      <Handshake className={narrow ? 'h-[17px] w-[17px]' : 'h-5 w-5'} aria-hidden />
    </span>
  );
  const skeleton = loading && !st && (
    <div className="mt-4 flex flex-wrap gap-3" aria-busy="true" data-testid="settlement-hero-skeleton">
      <span className="h-12 w-36 animate-pulse rounded-lg bg-white/10" />
      <span className="h-12 w-36 animate-pulse rounded-lg bg-white/10" />
      <span className="h-12 w-44 animate-pulse rounded-lg bg-white/10" />
    </div>
  );

  return (
    <header className="bg-emerald-950 bg-gradient-to-br from-emerald-900/70 to-emerald-950 text-white" data-testid="settlement-hero">
      {narrow ? (
        <div className="px-3.5 pb-3 pt-3.5">
          <div className="flex items-center gap-2.5">
            {icon}
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-[15px] font-extrabold tracking-tight">Quyết toán vận hành</h1>
              {sub && <p className="truncate text-[11px] text-white/55">{sub}</p>}
            </div>
            {nav}
          </div>
          {(buildingPicker || actions) && <div className="mt-2.5 flex flex-wrap gap-1.5">{buildingPicker}{actions}</div>}
          {skeleton}
          {month && st && t && (
            <>
              <div className="mt-3 flex items-stretch rounded-xl border border-white/15 bg-white/[0.06] px-0.5 py-2.5" data-testid="settlement-hero-kpis">
                {[
                  { k: 'Doanh thu', v: t.revenue, c: 'text-emerald-300' },
                  { k: '− Chi phí', v: t.expense, c: 'text-orange-300' },
                  { k: '= Lợi nhuận', v: t.profit, c: 'text-white' },
                ].map((x, i) => (
                  <div key={x.k} className={cn('min-w-0 flex-1 px-2', i > 0 && 'border-l border-white/10')}>
                    <p className="whitespace-nowrap text-[9.5px] font-bold uppercase tracking-wider text-white/55">{x.k}</p>
                    <p className={cn('mt-0.5 truncate text-sm font-extrabold tabular-nums', x.c)}>{formatVND(x.v)}</p>
                  </div>
                ))}
              </div>
              <ManagerBar st={st} narrow />
              <NetCard month={month} st={st} narrow onShowCalc={onShowCalc} />
            </>
          )}
          {month && (
            <>
              <StatusChips month={month} mode={mode} narrow isFetching={isFetching} />
              {st && <p className="mt-1.5"><TermsLine month={month} st={st} /></p>}
            </>
          )}
        </div>
      ) : (
        <div className="mx-auto max-w-[1180px] px-6 pb-4 pt-5">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex min-w-0 flex-[1_1_240px] items-center gap-3">
              {icon}
              <div className="min-w-0">
                <h1 className="text-[17px] font-extrabold tracking-tight">Quyết toán vận hành</h1>
                {sub && <p className="mt-px truncate text-[11.5px] text-white/55">{sub}</p>}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {buildingPicker}
              {nav}
              {actions}
            </div>
          </div>
          {skeleton}
          {month && st && t && (
            <div className="mt-5 flex flex-wrap items-center gap-x-8 gap-y-5">
              <div className="flex min-w-0 flex-[1_1_480px] flex-wrap items-center gap-x-4 gap-y-3.5" data-testid="settlement-hero-kpis">
                <Kpi label="Doanh thu" value={t.revenue} tone="text-emerald-300" sub={`${soThu} khoản thu`} />
                <div className="flex min-w-0 items-center gap-3.5">
                  <Op>−</Op>
                  <Kpi label="Chi phí" value={t.expense} tone="text-orange-300" sub={`${soChi} khoản chi`} />
                </div>
                <div className="flex min-w-0 flex-[1_1_300px] items-center gap-3.5">
                  <Op>=</Op>
                  <div className="min-w-0">
                    <Kpi label="Lợi nhuận" value={t.profit} tone={t.profit < 0 ? 'text-orange-200' : 'text-white'} big />
                    <ManagerBar st={st} narrow={false} />
                  </div>
                </div>
              </div>
              <NetCard month={month} st={st} narrow={false} onShowCalc={onShowCalc} />
            </div>
          )}
          {month && (
            <>
              <StatusChips month={month} mode={mode} narrow={false} isFetching={isFetching} />
              {st && <p className="mt-2"><TermsLine month={month} st={st} /></p>}
            </>
          )}
        </div>
      )}
    </header>
  );
}
