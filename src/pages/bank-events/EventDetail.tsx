import { useState } from 'react';
import { Check, ChevronDown, ChevronUp, Copy, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import type { BankEvent } from '@/lib/bank-events/service';
import { eventFacts, vnStamp } from '@/lib/bank-events/view';
import { cn } from '@/lib/utils';
import { eventLabels, flowLabel, flowTone } from './labels';
import { FlowIcon } from './parts';

const mono = 'font-numeric tabular-nums';
export interface RawState { loading: boolean; error: string | null; payload: Record<string, unknown> | null }

function RawPayload({ raw, compact }: { raw: RawState; compact: boolean }) {
  if (raw.loading) return <Skeleton aria-label="Đang tải nội dung nguyên văn" className="mt-2 h-40" />;
  if (raw.error) return <p role="alert" className="mt-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">{raw.error}</p>;
  if (!raw.payload) return null;
  return <pre className={cn(mono, 'mt-2 whitespace-pre-wrap break-all rounded-[10px] border bg-muted/50 px-4 py-3.5', compact ? 'text-[11px] leading-[18px]' : 'text-[11.5px] leading-[19px]')}>{JSON.stringify(raw.payload, null, 2)}</pre>;
}

function Headline({ event, large }: { event: BankEvent; large: boolean }) {
  const facts = eventFacts(event);
  return <>
    <div className="flex flex-wrap items-center gap-2.5">
      <span className={cn('inline-flex h-6 items-center gap-1.5 rounded-full pl-1 pr-2.5 text-xs font-semibold', facts.flow === 'other' ? 'bg-muted text-muted-foreground' : facts.flow === 'in' ? 'bg-emerald-50 dark:bg-emerald-950/50' : 'bg-red-50 dark:bg-red-950/50', facts.flow !== 'other' && flowTone[facts.flow])}>
        <FlowIcon flow={facts.flow} className="h-4 w-4 bg-transparent dark:bg-transparent" />{facts.amountText ? flowLabel[facts.flow] : 'Không phải biến động'}
      </span>
      <span className="text-[12.5px] text-muted-foreground">{facts.bank ?? eventLabels[event.eventType]}</span>
    </div>
    <p className={cn(mono, 'font-bold tracking-tight', large ? 'mt-3 text-[32px] leading-[38px]' : 'mt-2.5 text-[30px] leading-9', facts.amountText ? flowTone[facts.flow] : flowTone.other)}>{facts.amountText ? `${facts.amountText} ₫` : '—'}</p>
    <p className={cn('mt-2 text-sm leading-[21px]', !facts.hasDescription && 'text-muted-foreground')}>{facts.description}</p>
  </>;
}

/** Ngăn kéo bên phải trên máy tính: nội dung nguyên văn tải ngay khi mở (mỗi lần mở được ghi dấu vết đọc). */
export function DesktopEventDrawer({ event, raw, onClose, onNewer, onOlder }: {
  event: BankEvent | null; raw: RawState; onClose: () => void; onNewer: (() => void) | null; onOlder: (() => void) | null;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const facts = event ? eventFacts(event) : null;
  return <Sheet open={!!event} onOpenChange={open => { if (!open) onClose(); }}>
    <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[480px]">
      <SheetHeader className="space-y-0.5 border-b px-6 py-[18px] pr-14 text-left">
        <SheetTitle className="text-base">Chi tiết tin nhận được</SheetTitle>
        <SheetDescription className="text-xs">Nội dung nguyên văn chỉ được tải khi mở chi tiết.</SheetDescription>
      </SheetHeader>
      {event && facts && <div className="min-h-0 flex-1 overflow-y-auto px-6 py-[22px]">
        <Headline event={event} large />
        {facts.balanceText && <p className="mt-1.5 text-[12.5px] text-muted-foreground">Số dư sau giao dịch <span className={cn(mono, 'font-bold text-foreground')}>{facts.balanceText} ₫</span></p>}
        <dl className="mt-5 grid grid-cols-2 gap-x-5 gap-y-4 border-t pt-[18px] text-[13px]">
          <div><dt className="text-xs text-muted-foreground">Nguồn</dt><dd className="mt-[3px] font-medium">{event.sourceName}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Loại</dt><dd className="mt-[3px]">{eventLabels[event.eventType]}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Thời điểm trên điện thoại</dt><dd className={cn(mono, 'mt-[3px] text-[12.5px]')}>{vnStamp(event.occurredAt)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Máy chủ nhận</dt><dd className={cn(mono, 'mt-[3px] text-[12.5px]')}>{vnStamp(event.receivedAt)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Gửi lặp</dt><dd className="mt-[3px]">{event.duplicateCount > 0 ? `${event.duplicateCount} lần gửi lặp` : 'Nhận lần đầu'}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Tài khoản</dt><dd className={cn(mono, 'mt-[3px] text-[12.5px]')}>{facts.account ?? '—'}</dd></div>
          <div className="col-span-2"><dt className="text-xs text-muted-foreground">Mã sự kiện</dt><dd className="mt-[3px] flex items-center gap-2">
            <code className={cn(mono, 'break-all text-xs')}>{event.externalId}</code>
            <button type="button" title="Sao chép mã sự kiện" aria-label="Sao chép mã sự kiện" onClick={() => { void navigator.clipboard?.writeText(event.externalId).then(() => setCopied(event.externalId)).catch(() => setCopied(null)); }}
              className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-md border text-muted-foreground hover:text-foreground">{copied === event.externalId ? <Check className="h-[13px] w-[13px]" /> : <Copy className="h-[13px] w-[13px]" />}</button>
          </dd></div>
        </dl>
        <div className="mt-[22px] flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11.5px] font-semibold uppercase tracking-wider text-muted-foreground">Nội dung nguyên văn</span>
          <span className="inline-flex h-[22px] items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 text-[11px] font-semibold text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"><Lock className="h-[11px] w-[11px]" />Có thể chứa OTP hoặc thông tin cá nhân</span>
        </div>
        <RawPayload raw={raw} compact={false} />
        <p className="mt-2.5 text-[11.5px] text-muted-foreground/80">Mỗi lần mở chi tiết được ghi dấu vết đọc.</p>
      </div>}
      <div className="flex items-center gap-2 border-t px-6 py-3">
        <Button variant="outline" size="sm" className="h-[34px]" disabled={!onNewer} onClick={() => onNewer?.()}><ChevronUp className="mr-1 h-[15px] w-[15px]" />Tin mới hơn</Button>
        <Button variant="outline" size="sm" className="h-[34px]" disabled={!onOlder} onClick={() => onOlder?.()}><ChevronDown className="mr-1 h-[15px] w-[15px]" />Tin cũ hơn</Button>
        <div className="flex-1" />
        <Button size="sm" className="h-[34px] bg-foreground px-3.5 text-background hover:bg-foreground/90" onClick={onClose}>Đóng</Button>
      </div>
    </SheetContent>
  </Sheet>;
}

/** Bottom sheet trên điện thoại: tóm tắt hiện ngay, nội dung nguyên văn chỉ tải khi bấm xem. */
export function MobileEventSheet({ event, raw, onClose, onShowRaw }: { event: BankEvent | null; raw: RawState; onClose: () => void; onShowRaw: () => void }) {
  const facts = event ? eventFacts(event) : null;
  const rows: [string, string, boolean][] = event && facts ? [
    ...(facts.balanceText ? [['Số dư sau', `${facts.balanceText} ₫`, true] as [string, string, boolean]] : []),
    ...(facts.bank ? [['Tài khoản', `${facts.bank}${facts.account ? ` ${facts.account}` : ''}`, false] as [string, string, boolean]] : []),
    ['Nguồn', event.sourceName, false], ['Loại tin', eventLabels[event.eventType], false],
    ['Trên điện thoại', vnStamp(event.occurredAt), true], ['Máy chủ nhận', vnStamp(event.receivedAt), true],
    ['Gửi lặp', event.duplicateCount > 0 ? `${event.duplicateCount} lần gửi lặp` : 'Nhận lần đầu', false], ['Mã sự kiện', event.externalId, true],
  ] : [];
  const rawOpen = raw.loading || !!raw.payload || !!raw.error;
  return <Sheet open={!!event} onOpenChange={open => { if (!open) onClose(); }}>
    <SheetContent side="bottom" className="flex max-h-[88dvh] flex-col gap-0 rounded-t-3xl p-0 pb-[env(safe-area-inset-bottom)]">
      <div aria-hidden className="grid flex-none place-items-center pt-2"><span className="h-1.5 w-10 rounded-full bg-muted-foreground/25" /></div>
      <SheetHeader className="flex-none px-[18px] pb-2 pt-2.5 text-left"><SheetTitle className="text-[17px] font-bold">Chi tiết tin</SheetTitle><SheetDescription className="sr-only">Tóm tắt tin đã tách; nội dung nguyên văn chỉ tải khi bấm xem.</SheetDescription></SheetHeader>
      {event && <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[18px] pb-4 pt-1">
        <Headline event={event} large={false} />
        <dl className="mt-3.5 rounded-[14px] bg-muted/50 px-3.5 py-1 text-[13px]">
          {rows.map(([label, value, numeric], index) => <div key={label} className={cn('flex justify-between gap-3 py-[9px]', index > 0 && 'border-t border-border/70')}>
            <dt className="shrink-0 text-muted-foreground">{label}</dt><dd className={cn('break-all text-right', numeric ? cn(mono, 'text-xs') : 'font-medium')}>{value}</dd>
          </div>)}
        </dl>
        {rawOpen ? <>
          <div className="mt-3.5 flex items-center justify-between"><span className="text-[11.5px] font-semibold uppercase tracking-wider text-muted-foreground">Nội dung nguyên văn</span><span className="text-[11px] font-semibold text-amber-800 dark:text-amber-300">Có thể chứa OTP</span></div>
          <RawPayload raw={raw} compact />
        </> : <>
          <Button variant="outline" className="mt-3 h-11 w-full rounded-xl text-[13.5px] font-semibold" onClick={onShowRaw}><Lock className="mr-2 h-[15px] w-[15px]" />Xem nội dung nguyên văn</Button>
          <p className="mt-2 text-center text-[11.5px] leading-[17px] text-muted-foreground/80">Có thể chứa OTP hoặc thông tin cá nhân. Mỗi lần mở chi tiết được ghi dấu vết đọc.</p>
        </>}
      </div>}
      <div className="flex-none border-t px-[18px] pb-4 pt-2.5"><Button className="h-[46px] w-full rounded-xl bg-foreground text-sm font-semibold text-background hover:bg-foreground/90" onClick={onClose}>Đóng</Button></div>
    </SheetContent>
  </Sheet>;
}
