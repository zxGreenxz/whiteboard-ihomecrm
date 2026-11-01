// Thanh tab dính của trang Quyết toán vận hành v3: Thu chi · Quyết toán · Bàn giao · Thống kê.
// Chấm vàng ở Bàn giao khi tháng đã chốt mà chủ nhà chưa xác nhận; dấu ✓ khi đã xác nhận.
import { forwardRef } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

const SETTLEMENT_TABS = [
  { key: 'thuchi', label: 'Thu chi' },
  { key: 'quyettoan', label: 'Quyết toán' },
  { key: 'bangiao', label: 'Bàn giao' },
  { key: 'thongke', label: 'Thống kê' },
] as const;
export type SettlementTab = typeof SETTLEMENT_TABS[number]['key'];

export const SettlementTabBar = forwardRef<HTMLDivElement, {
  /** id của khối nội dung tab; nút tab có id `${panelId}-${tab}`. */
  panelId: string;
  active: SettlementTab;
  onSelect: (tab: SettlementTab) => void;
  narrow: boolean;
  /** Bàn giao: 'wait' = đã chốt, chủ nhà chưa xác nhận · 'ok' = đã xác nhận. */
  handoverMark: 'wait' | 'ok' | null;
  /** Vị trí dính (vd 'top-16 lg:top-0' trong MainLayout có thanh đầu trên điện thoại). */
  stickyClassName?: string;
}>(({ panelId, active, onSelect, narrow, handoverMark, stickyClassName = 'top-0' }, ref) => (
  <div ref={ref} className={cn('sticky z-20 border-t border-white/10 bg-emerald-950 shadow-[0_6px_14px_-10px_rgba(2,44,34,0.6)]', stickyClassName)}>
    <div role="tablist" aria-label="Phần của trang quyết toán"
      className={cn('mx-auto flex max-w-[1180px] gap-1.5 overflow-x-auto [scrollbar-width:none]', narrow ? 'px-3 pb-3 pt-2.5' : 'px-6 pb-3 pt-2.5')}>
      {SETTLEMENT_TABS.map((t) => {
        const on = t.key === active;
        return (
          <button key={t.key} type="button" role="tab" id={`${panelId}-${t.key}`} aria-selected={on} aria-controls={panelId}
            onClick={() => onSelect(t.key)}
            className={cn(
              'inline-flex min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full border transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60',
              narrow ? 'flex-1 px-1 py-[7px] text-xs' : 'flex-none px-3.5 py-[7px] text-[12.5px]',
              on ? 'border-white bg-white font-bold text-emerald-900' : 'border-white/20 font-medium text-white/80 hover:bg-white/10 hover:text-white',
            )}>
            {t.label}
            {t.key === 'bangiao' && handoverMark === 'wait' && (
              <>
                <span className="h-[7px] w-[7px] rounded-full bg-amber-400" data-testid="tab-handover-wait" aria-hidden />
                <span className="sr-only"> (chờ chủ nhà xác nhận)</span>
              </>
            )}
            {t.key === 'bangiao' && handoverMark === 'ok' && (
              <>
                <Check className={cn('h-3.5 w-3.5', on ? 'text-emerald-700' : 'text-emerald-300')} data-testid="tab-handover-ok" aria-hidden />
                <span className="sr-only"> (chủ nhà đã xác nhận)</span>
              </>
            )}
          </button>
        );
      })}
    </div>
  </div>
));
SettlementTabBar.displayName = 'SettlementTabBar';
