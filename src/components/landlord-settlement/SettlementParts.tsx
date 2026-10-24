// Mảnh giao diện dùng chung của trang Quyết toán vận hành v3 (thiết kế Claude Design v3b, 23/10/2026):
// thẻ trắng viền nhạt, nhãn chữ hoa nhỏ, dòng "Cách tính" và hộp kết quả bàn giao. Chỉ hiển thị — mọi số
// tiền truyền vào đều là số server trả; ở đây không cộng trừ (dòng "Cách tính" dựng ở calcLines của lib).
import type { ReactNode } from 'react';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { cn, formatVND } from '@/lib/utils';
import { NET_DIRECTION_LABEL, describeNet, type CalcLine } from '@/lib/landlordSettlement';

export function SectionCard({ title, description, actions, children, className, testId }: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section className={cn('min-w-0 overflow-hidden rounded-xl border bg-card text-card-foreground', className)} data-testid={testId}>
      {(title || description || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 pb-2.5 pt-3">
          <div className="min-w-0 flex-[1_1_240px]">
            {title && <h2 className="text-[13.5px] font-bold">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

/** Nhãn nhóm chữ hoa nhỏ ("CÁCH TÍNH", "SỔ CHỦ NHÀ"…). */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground', className)}>{children}</p>;
}

export function CalcRows({ lines, compact = false }: { lines: readonly CalcLine[]; compact?: boolean }) {
  return (
    <div className="flex flex-col">
      {lines.map((l) => (
        <div key={l.key} data-testid="calc-row" data-key={l.key}
          className={cn('flex items-baseline justify-between gap-3 border-t first:border-t-0', compact ? 'py-1.5' : 'py-2')}>
          <div className="min-w-0">
            <p className={cn('font-semibold text-foreground/80', compact ? 'text-[12.5px]' : 'text-[13px]')} data-testid="calc-label">{l.label}</p>
            {l.sub && <p className="text-[11px] text-muted-foreground">{l.sub}</p>}
          </div>
          <p className={cn('whitespace-nowrap font-bold tabular-nums', compact ? 'text-[13px]' : 'text-[13.5px]', l.muted && 'text-muted-foreground')}
            data-testid="calc-amount">
            {formatVND(l.amount)}
          </p>
        </div>
      ))}
    </div>
  );
}

/** Hộp kết quả "Chủ nhà trả quản lý · 20.000.000 đ" — `net` là landlord_owes_manager server trả. */
export function NetResult({ net, compact = false }: { net: number; compact?: boolean }) {
  const d = describeNet(net);
  return (
    <div data-testid="settlement-net-result"
      className={cn('flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl border-2 border-primary/30 bg-primary/5',
        compact ? 'px-3 py-2' : 'px-3.5 py-2.5')}>
      <span className={cn('flex items-center gap-1.5 font-bold', compact ? 'text-[13px]' : 'text-sm')}>
        {d.direction === 'EVEN' ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <ArrowRight className="h-4 w-4" />}
        {NET_DIRECTION_LABEL[d.direction]}
      </span>
      <span className={cn('whitespace-nowrap font-extrabold tabular-nums text-emerald-800 dark:text-emerald-300',
        compact ? 'text-lg' : 'text-[22px]')}>
        {formatVND(d.amount)}
      </span>
    </div>
  );
}
