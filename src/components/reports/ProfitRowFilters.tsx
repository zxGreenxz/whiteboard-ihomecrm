// Ô tìm + thanh "Đang lọc" của hai khung Khoản thu / Khoản chi — Báo cáo LN desktop và điện thoại dùng chung
// (chủ chốt 28/10/2026). Chỉ hiển thị; luật lọc ở src/lib/profitReportFilters.ts.
import { Search, X } from 'lucide-react';
import { cn, formatVND } from '@/lib/utils';

type Side = 'income' | 'expense';
type Variant = 'desktop' | 'mobile';

export function ProfitRowSearchInput({ value, onChange, side, variant = 'desktop', className }: {
  value: string;
  onChange: (value: string) => void;
  side: Side;
  variant?: Variant;
  className?: string;
}) {
  const mobile = variant === 'mobile';
  return (
    <div className={cn('relative flex min-w-0 items-center', className)}>
      <Search className={cn('pointer-events-none absolute text-muted-foreground', mobile ? 'left-3 h-4 w-4' : 'left-2 h-3.5 w-3.5')} aria-hidden />
      <input
        type="text"
        inputMode="search"
        enterKeyHint="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape' && value) { e.stopPropagation(); onChange(''); } }}
        placeholder="Tên/mã phiếu, mã phòng…"
        aria-label={side === 'income' ? 'Tìm khoản thu theo tên phiếu, mã phiếu hoặc mã phòng' : 'Tìm khoản chi theo tên phiếu, mã phiếu hoặc mã phòng'}
        data-testid={`profit-search-${side}`}
        className={cn(
          'w-full min-w-0 border bg-white text-foreground outline-none placeholder:text-muted-foreground/80 focus-visible:ring-2',
          mobile
            ? 'h-10 rounded-xl border-[#e7e3da] pl-9 pr-9 text-[13px] focus-visible:ring-[#1f7a52]/30'
            : 'h-7 rounded-md border-black/10 pl-7 pr-7 text-xs focus-visible:ring-black/10',
        )}
      />
      {value && (
        <button type="button" onClick={() => onChange('')} aria-label="Xoá ô tìm"
          className={cn('absolute grid place-items-center rounded text-muted-foreground hover:text-foreground', mobile ? 'right-2 h-7 w-7' : 'right-1 h-5 w-5')}>
          <X className={mobile ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
        </button>
      )}
    </div>
  );
}

/**
 * "Đang lọc: Tiền điện, Nợ cũ · tìm "301" · 5/21 khoản · phần hạng mục đã chọn 4.278.800 ₫ · Bỏ lọc" — vẫn hiện khi
 * khối "Theo hạng mục" thu gọn để không ai tưởng danh sách bị thiếu.
 */
export function ProfitFilterBar({ side, categories, search, shown, total, amount, amountLabel, onClear, className }: {
  side: Side;
  categories: readonly string[];
  search: string;
  shown: number;
  total: number;
  amount: number;
  amountLabel: string;
  onClear: () => void;
  className?: string;
}) {
  const parts = [
    categories.length > 0 ? `Đang lọc: ${categories.join(', ')}` : 'Đang lọc',
    search ? `tìm "${search}"` : null,
    `${shown}/${total} khoản`,
  ].filter(Boolean);
  return (
    <div role="status" data-testid={`profit-filter-bar-${side}`}
      className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] leading-snug text-foreground/75', className)}>
      <span className="min-w-0">{parts.join(' · ')}</span>
      <span className="whitespace-nowrap">
        · {amountLabel} <b className="tabular-nums text-foreground">{formatVND(amount)}</b>
      </span>
      <button type="button" onClick={onClear} className="ml-auto whitespace-nowrap font-semibold underline underline-offset-2 hover:text-foreground"
        data-testid={`profit-filter-clear-${side}`}>
        Bỏ lọc
      </button>
    </div>
  );
}
