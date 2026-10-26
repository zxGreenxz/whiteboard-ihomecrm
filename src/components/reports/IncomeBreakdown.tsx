// Mảnh hiển thị dùng chung của Quyết toán vận hành (màn quản trị + link chủ nhà) và Báo cáo LN (thiết kế
// "Quyet toan van hanh v2", chủ chốt 25/10/2026): khối "Theo hạng mục" có thanh tỷ trọng, và các ô Tiền phòng /
// Điện / Nước / PDV của một khoản thu theo hoá đơn. Số do server trả (src/lib/invoiceAmountParts.ts) — ở đây
// chỉ hiển thị, tỷ trọng chỉ chia để vẽ.
import { ChevronDown } from 'lucide-react';
import { cn, formatVND } from '@/lib/utils';
import {
  INVOICE_PART_COLUMNS,
  invoicePartColumnAmount,
  type InvoiceAmountParts,
} from '@/lib/invoiceAmountParts';
import { barPercent, shareText } from '@/lib/landlordSettlement';

type Kind = 'INCOME' | 'EXPENSE';

const INCOME_COLORS = ['bg-emerald-700', 'bg-emerald-500', 'bg-emerald-300', 'bg-emerald-200', 'bg-teal-200', 'bg-emerald-100', 'bg-teal-100', 'bg-slate-200'];
const EXPENSE_COLORS = ['bg-orange-700', 'bg-orange-600', 'bg-orange-500', 'bg-orange-400', 'bg-orange-300', 'bg-orange-200', 'bg-orange-100', 'bg-amber-100'];
const colorAt = (list: readonly string[], i: number) => list[Math.min(i, list.length - 1)];

const eyebrow = 'text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground';

export type CategoryShare = { name: string; amount: number };

/**
 * "Theo hạng mục" — mặc định THU GỌN (chủ nhắn 24/10/2026: thu và chi khác số hạng mục làm hai cột lệch nhau):
 * gọn chỉ còn dòng tiêu đề + thanh tỷ trọng, cao bằng nhau ở hai thẻ; trạng thái mở do nơi dùng giữ để bấm ở
 * thẻ nào cũng mở cả hai. Không có hạng mục vẫn giữ dòng tiêu đề để hai cột không lệch.
 */
export function CategoryShareBlock({ cats, total, kind, open, onToggle, testId, className }: {
  cats: readonly CategoryShare[]; total: number; kind: Kind; open: boolean; onToggle: () => void; testId?: string;
  className?: string;
}) {
  const colors = kind === 'INCOME' ? INCOME_COLORS : EXPENSE_COLORS;
  const shown = cats.filter((c) => c.amount !== 0).sort((a, b) => b.amount - a.amount);
  const slug = kind === 'INCOME' ? 'income' : 'expense';
  const listId = `${testId ?? 'categories'}-list-${slug}`;
  return (
    <div className={cn('border-b px-3.5 pb-3 pt-2', className)} data-testid={testId ? `${testId}-${slug}` : undefined}>
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={listId}
          disabled={shown.length === 0}
          className="-ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent">
          <span className={eyebrow}>Theo hạng mục{shown.length > 0 ? ` (${shown.length})` : ' · không có'}</span>
          {shown.length > 0 && (
            <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden />
          )}
        </button>
        {open && shown.length > 0 && <p className={eyebrow}>Tỷ trọng</p>}
      </div>
      <div className="mt-1.5 flex h-2 overflow-hidden rounded bg-muted" aria-hidden>
        {/* hai dòng có thể cùng tên (server gom theo tên + cờ hạn chế): key kèm thứ tự */}
        {shown.map((c, i) => <div key={`${c.name}-${i}`} className={cn('h-full', colorAt(colors, i))} style={{ width: `${barPercent(c.amount, total)}%` }} />)}
      </div>
      {open && shown.length > 0 && (
        <ul id={listId} className="mt-2.5 flex flex-col gap-1.5">
          {shown.map((c, i) => (
            <li key={`${c.name}-${i}`} className="grid grid-cols-[10px_minmax(0,1fr)_auto_44px] items-center gap-2 text-[12.5px]">
              <span className={cn('h-2.5 w-2.5 rounded-[3px]', colorAt(colors, i))} aria-hidden />
              <span className="truncate text-foreground/75">{c.name}</span>
              <span className="whitespace-nowrap font-bold tabular-nums">{formatVND(c.amount)}</span>
              {/* khoản âm (giảm trừ, làm tròn) không có tỷ trọng */}
              <span className="text-right text-[11.5px] tabular-nums text-muted-foreground">{c.amount > 0 ? shareText(c.amount, total) ?? '' : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Lưới bảng Khoản thu: ô phòng · 4 cột tiền · Tổng. */
export const PARTS_GRID = 'grid grid-cols-[56px_repeat(4,minmax(0,1fr))_92px] gap-x-2';

const NUM = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 });

/** Rê chuột vào cột PDV thấy phần khoản khác đã gộp (chủ chốt 25/10/2026: khoản khác gộp vào PDV). */
function cellTitle(p: InvoiceAmountParts, key: (typeof INVOICE_PART_COLUMNS)[number]['key']): string | undefined {
  if (key !== 'service' || p.other === 0) return undefined;
  return `Phí dịch vụ ${NUM.format(p.service)} + khoản khác trên hoá đơn ${NUM.format(p.other)}`;
}

export function IncomePartsHeader({ first = 'Phòng' }: { first?: string }) {
  return (
    <div className={cn(PARTS_GRID, 'items-end px-3.5 py-1.5 text-[10px] font-bold uppercase leading-[1.2] tracking-[0.03em] text-muted-foreground')}>
      <span>{first}</span>
      {INVOICE_PART_COLUMNS.map((c) => <span key={c.key} className="text-right">{c.label}</span>)}
      <span className="text-right">Tổng</span>
    </div>
  );
}

/** Bốn ô tiền của một dòng bảng (cột 2–5 của PARTS_GRID); cột không có tiền ⇒ "—". */
export function IncomePartCells({ parts }: { parts: InvoiceAmountParts }) {
  return (
    <>
      {INVOICE_PART_COLUMNS.map((c) => {
        const v = invoicePartColumnAmount(parts, c.key);
        return (
          <span key={c.key} title={cellTitle(parts, c.key)} data-testid="income-part-cell" data-col={c.key}
            className={cn('min-w-0 whitespace-nowrap text-right text-xs tabular-nums', v ? 'text-foreground/85' : 'text-muted-foreground')}>
            {v ? NUM.format(v) : '—'}
          </span>
        );
      })}
    </>
  );
}

/**
 * Màn hẹp: bốn ô có nhãn xếp thành một hàng dưới dòng "Tổng thu". Cột tiền phòng rộng hơn — nhãn "TIỀN PHÒNG"
 * dài hơn cột chia đều ở khổ 390px (đã đo: tràn sang cột Điện).
 */
export function IncomePartsGrid({ parts }: { parts: InvoiceAmountParts }) {
  return (
    <div className="grid grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,0.875fr)_minmax(0,0.875fr)] gap-1.5 rounded-lg bg-muted/60 px-2 py-1.5 tabular-nums">
      {INVOICE_PART_COLUMNS.map((c) => {
        const v = invoicePartColumnAmount(parts, c.key);
        return (
          <div key={c.key} className="min-w-0" title={cellTitle(parts, c.key)} data-testid="income-part-cell" data-col={c.key}>
            <p className="whitespace-nowrap text-[9.5px] font-bold uppercase tracking-[0.03em] text-muted-foreground">{c.label}</p>
            <p className={cn('truncate text-xs font-semibold', v ? 'text-foreground/85' : 'text-muted-foreground')}>{v ? NUM.format(v) : '—'}</p>
          </div>
        );
      })}
    </div>
  );
}
