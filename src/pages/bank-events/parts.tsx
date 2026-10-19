import type { ReactNode } from 'react';
import { ArrowDownLeft, ArrowUpRight, Minus } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { Flow, SourceState } from '@/lib/bank-events/view';
import { cn } from '@/lib/utils';

/** Chấm xanh nhấp nháy báo trang đang tự cập nhật. */
export function LiveDot({ paused = false }: { paused?: boolean }) {
  return <span aria-hidden className="relative inline-flex h-2 w-2 shrink-0">
    {!paused && <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 motion-safe:animate-ping" />}
    <span className={cn('relative inline-flex h-2 w-2 rounded-full', paused ? 'bg-muted-foreground/50' : 'bg-emerald-500')} />
  </span>;
}

export function FlowIcon({ flow, className }: { flow: Flow; className?: string }) {
  const Icon = flow === 'in' ? ArrowDownLeft : flow === 'out' ? ArrowUpRight : Minus;
  return <span aria-hidden className={cn('grid shrink-0 place-items-center rounded-full',
    flow === 'in' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400'
      : flow === 'out' ? 'bg-red-50 text-red-600 dark:bg-red-950/50 dark:text-red-400' : 'bg-muted text-muted-foreground', className)}>
    <Icon className="h-[60%] w-[60%]" strokeWidth={2.5} />
  </span>;
}

export function BankTile({ code, className }: { code: string | null; className?: string }) {
  return <span aria-hidden className={cn('grid shrink-0 place-items-center rounded-lg border bg-card text-[9.5px] font-bold tracking-wide',
    code ? 'text-foreground' : 'text-muted-foreground/60', className)}>{code ?? '—'}</span>;
}

const stateStyle: Record<SourceState, [string, string, string]> = {
  revoked: ['Đã thu hồi', 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300', 'bg-red-500'],
  silent: ['Cần kiểm tra', 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300', 'bg-amber-500'],
  enabled: ['Đang bật', 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300', 'bg-emerald-500'],
  paused: ['Tạm dừng', 'bg-muted text-muted-foreground', 'bg-muted-foreground/50'],
};
export function SourceBadge({ state, compact = false }: { state: SourceState; compact?: boolean }) {
  const [label, tone, dot] = stateStyle[state];
  return <span className={cn('inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full font-semibold', compact ? 'h-[22px] px-2 text-[11px]' : 'h-6 px-2.5 text-xs', tone)}>
    <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', dot)} />{label}
  </span>;
}

/** Hộp thoại giữa màn trên máy tính, bottom sheet trên điện thoại; cùng nội dung và cùng role="dialog". */
export function ResponsiveModal({ phone, open, onOpenChange, title, description, className, dismissible = true, children }: {
  phone: boolean; open: boolean; onOpenChange: (open: boolean) => void; title: ReactNode; description?: ReactNode; className?: string;
  /** false: chạm ra ngoài hay Esc không đóng (vd khóa chỉ hiện một lần). Hộp thoại desktop vốn đã chặn. */
  dismissible?: boolean; children: ReactNode;
}) {
  const guard = (event: Event) => { if (!dismissible) event.preventDefault(); };
  if (phone) return <Sheet open={open} onOpenChange={onOpenChange}>
    <SheetContent side="bottom" onPointerDownOutside={guard} onInteractOutside={guard} onEscapeKeyDown={guard} className={cn('flex max-h-[88dvh] flex-col gap-0 overflow-hidden rounded-t-3xl p-0 pb-[env(safe-area-inset-bottom)]', className)}>
      <div aria-hidden className="grid flex-none place-items-center pt-2"><span className="h-1.5 w-10 rounded-full bg-muted-foreground/25" /></div>
      <SheetHeader className="flex-none px-5 pb-2 pt-2 text-left"><SheetTitle className="pr-8 text-[17px] font-bold">{title}</SheetTitle>{description && <SheetDescription className="text-[13px] leading-5">{description}</SheetDescription>}</SheetHeader>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5">{children}</div>
    </SheetContent>
  </Sheet>;
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className={cn('max-h-[90dvh] overflow-y-auto', className)}>
      <DialogHeader><DialogTitle>{title}</DialogTitle>{description && <DialogDescription>{description}</DialogDescription>}</DialogHeader>
      {children}
    </DialogContent>
  </Dialog>;
}
