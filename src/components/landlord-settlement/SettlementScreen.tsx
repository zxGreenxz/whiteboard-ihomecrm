// Khung trang Quyết toán vận hành v3 (thiết kế Claude Design v3b, 23/10/2026) — dùng chung cho màn quản
// trị (/reports/… trong MainLayout) và link chỉ đọc của chủ nhà (/qt/:token): đầu trang xanh đậm, thanh tab
// dính, thân theo tab, chân trang. Bố cục hẹp/rộng theo bề rộng KHỐI (ngưỡng 720px như thiết kế), không theo
// cửa sổ — màn quản trị bị thanh bên ăn bớt chỗ.
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { cn } from '@/lib/utils';
import {
  monthKey,
  type DepositHolder,
  type SettlementMonth,
  type SettlementOverview,
  type SettlementPayment,
} from '@/lib/landlordSettlement';
import { SettlementCashTab } from './SettlementCashTab';
import { SettlementHandoverTab } from './SettlementHandoverTab';
import { SettlementHero } from './SettlementHero';
import { SettlementOverviewCard } from './SettlementOverviewCard';
import { SettlementStatementCard } from './SettlementStatementCard';
import { SettlementTabBar, type SettlementTab } from './SettlementTabBar';

const NARROW_WIDTH = 720;
const PANEL_ID = 'qt-tab-panel';

/** Khối hẹp hơn `limit` px? Đo bằng ResizeObserver; chưa đo được (bề rộng 0) thì đoán theo cửa sổ. */
function useIsNarrow(ref: RefObject<HTMLElement>, limit = NARROW_WIDTH): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < limit);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setNarrow(w < limit);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, limit]);
  return narrow;
}

const nextFrame = (cb: () => void) => {
  if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(cb);
  else window.setTimeout(cb, 0);
};

export function SettlementScreen({
  mode, buildingName, landlordName, month, overview, months, selectedMonth, onSelectMonth,
  buildingPicker, actions, notice, emptyBody, wrapBody, stickyClassName, loading = false, isFetching = false, busy = false,
  buildingId, token, onVoidPayment, onRequestDepositHolder,
}: {
  mode: 'admin' | 'public';
  buildingName: string | null;
  landlordName: string | null;
  month: SettlementMonth | null;
  overview: SettlementOverview | null;
  /** 'YYYY-MM', mới nhất trước. */
  months: readonly string[];
  /** 'YYYY-MM' */
  selectedMonth: string | null;
  onSelectMonth: (month: string) => void;
  buildingPicker?: ReactNode;
  actions?: ReactNode;
  /** Khối báo trên đầu thân trang (vd toà ngừng áp dụng). */
  notice?: ReactNode;
  /** Thân thay cho các tab (link sai, chưa tới tháng áp dụng, đang tải…). */
  emptyBody?: ReactNode;
  /** Bọc thân trang (màn quản trị: QueryRegion lo chờ / lỗi / số cũ). */
  wrapBody?: (body: ReactNode) => ReactNode;
  stickyClassName?: string;
  loading?: boolean;
  isFetching?: boolean;
  /** Đang đổi tháng — số đang hiện là của tháng trước (khoá xác nhận). */
  busy?: boolean;
  buildingId?: string;
  token?: string;
  onVoidPayment?: (payment: SettlementPayment) => void;
  onRequestDepositHolder?: (holder: DepositHolder) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const narrow = useIsNarrow(rootRef);
  const [tab, setTab] = useState<SettlementTab>('thuchi');

  // chọn tab khi đã cuộn quá thanh tab ⇒ đưa đầu thân trang về ngay dưới thanh tab (thanh dính)
  const selectTab = (next: SettlementTab) => {
    setTab(next);
    nextFrame(() => {
      const body = bodyRef.current;
      const bar = barRef.current;
      if (!body || !bar) return;
      const barBottom = bar.getBoundingClientRect().bottom;
      const top = body.getBoundingClientRect().top;
      if (top < barBottom - 1) window.scrollBy({ top: top - barBottom });
    });
  };

  const st = month?.statement ?? null;
  const tabsOn = !emptyBody && !!month && !!overview && !!st;
  const handoverMark = month?.status === 'CLOSED' ? (month.confirmation ? 'ok' : 'wait') : null;

  let body: ReactNode = null;
  if (emptyBody) {
    body = emptyBody;
  } else if (month && overview) {
    const stale = month.status === 'CLOSED' && month.is_stale && (mode === 'admin' ? (
      <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-2.5 text-sm text-destructive" data-testid="settlement-stale">
        Có phiếu của tháng này được sửa/thêm/huỷ sau khi chốt. Số dưới đây là số lúc chốt — mở chốt rồi chốt lại để cập nhật.
      </p>
    ) : (
      <p className="rounded-lg border bg-card p-2.5 text-sm text-muted-foreground" data-testid="settlement-stale">
        Số dưới đây là số lúc chốt. Sau khi chốt có phiếu của tháng được điều chỉnh; bên quản lý sẽ chốt lại.
      </p>
    ));
    body = !st ? (
      <>
        <SettlementStatementCard month={month} mode={mode} />
        <SettlementOverviewCard overview={overview} mode={mode} selectedMonth={selectedMonth} onSelectMonth={onSelectMonth}
          onVoidPayment={onVoidPayment} narrow={narrow} />
      </>
    ) : (
      <>
        {stale}
        <div role="tabpanel" id={PANEL_ID} aria-labelledby={`${PANEL_ID}-${tab}`} className="min-w-0">
          {tab === 'thuchi' && <SettlementCashTab key={monthKey(month.period_month)} st={st} mode={mode} narrow={narrow} />}
          {tab === 'quyettoan' && (
            <SettlementStatementCard month={month} mode={mode} onRequestDepositHolder={onRequestDepositHolder}
              onGoHandover={() => selectTab('bangiao')} />
          )}
          {tab === 'bangiao' && <SettlementHandoverTab month={month} mode={mode} buildingId={buildingId} token={token} busy={busy} />}
          {tab === 'thongke' && (
            <SettlementOverviewCard overview={overview} mode={mode} selectedMonth={selectedMonth} onSelectMonth={onSelectMonth}
              onVoidPayment={onVoidPayment} narrow={narrow} />
          )}
        </div>
      </>
    );
  }

  return (
    <div ref={rootRef} className="min-w-0" data-testid="settlement-screen" data-narrow={narrow ? 'true' : 'false'}>
      <SettlementHero mode={mode} buildingName={buildingName} landlordName={landlordName} month={emptyBody ? null : month}
        months={months} selectedMonth={selectedMonth} onSelectMonth={onSelectMonth} narrow={narrow}
        buildingPicker={buildingPicker} actions={actions} onShowCalc={() => selectTab('quyettoan')}
        loading={loading} isFetching={isFetching} />
      {tabsOn && (
        <SettlementTabBar ref={barRef} panelId={PANEL_ID} active={tab} onSelect={selectTab} narrow={narrow} handoverMark={handoverMark}
          stickyClassName={stickyClassName} />
      )}
      <div ref={bodyRef} className={cn('mx-auto flex max-w-[1180px] flex-col gap-3 pb-8 pt-3.5', narrow ? 'px-2.5' : 'px-6')}>
        {notice}
        {wrapBody ? wrapBody(body) : body}
        <p className="mt-0.5 text-center text-[11.5px] text-muted-foreground">
          Số liệu lấy trực tiếp từ sổ sách của bên quản lý. Tháng "tạm tính" còn thay đổi cho tới khi được chốt.
        </p>
      </div>
    </div>
  );
}
