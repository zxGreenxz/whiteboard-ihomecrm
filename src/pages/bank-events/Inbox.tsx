import type { ReactNode } from 'react';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Inbox as InboxIcon, Info, Search, SlidersHorizontal, Smartphone, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { BankEvent } from '@/lib/bank-events/service';
import { dayLabel, dayText, eventFacts, money, shortId, vnClock, weekday, type DayGroup, type FlowFilter, type FlowTotals } from '@/lib/bank-events/view';
import { cn } from '@/lib/utils';
import { eventIcons, eventLabels, flowTone } from './labels';
import { BankTile, FlowIcon } from './parts';

const mono = 'font-numeric tabular-nums';
const flowOptions: [FlowFilter, string, string][] = [
  ['all', 'Tất cả', 'text-foreground'], ['in', 'Tiền vào', 'text-emerald-700 dark:text-emerald-400'],
  ['out', 'Tiền ra', 'text-red-600 dark:text-red-400'], ['other', 'Khác', 'text-muted-foreground'],
];
const fieldClass = 'h-[34px] rounded-lg border border-input bg-background px-2.5 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export interface TodayState { totals: FlowTotals; count: number; partial: boolean; loading: boolean; error: boolean }
export interface SourceHealth { enabled: number; total: number; silent: number; loading: boolean }

function Figure({ loading, error, children }: { loading: boolean; error: boolean; children: ReactNode }) {
  // Khung chờ cao bằng con số + dòng phụ để bảng bên dưới không bị xô khi số liệu về.
  if (loading) return <div aria-label="Đang tải" className="mt-2.5 space-y-1.5"><Skeleton className="h-7 w-32" /><Skeleton className="h-3.5 w-20" /></div>;
  if (error) return <p className="mt-2.5 text-sm text-muted-foreground">Chưa tải được</p>;
  return <>{children}</>;
}

/** Tổng hôm nay: tham khảo từ tin đã tách, không phải sổ sách. */
export function TodaySummary({ phone, day, today, health, totalEvents }: { phone: boolean; day: string; today: TodayState; health: SourceHealth; totalEvents: number | undefined }) {
  const { totals } = today;
  const share = totals.inShare ?? 50;
  const bar = <div aria-hidden className="flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-muted">
    {totals.inShare !== null && <><div className="rounded-full bg-emerald-500 transition-[width] duration-500" style={{ width: `${share}%` }} /><div className="flex-1 rounded-full bg-red-400" /></>}
  </div>;
  const net = `${totals.net < 0 ? '−' : '+'}${money(totals.net)}`;
  const partial = today.partial && <p className="border-t px-5 py-2 text-xs text-amber-700 dark:text-amber-300">Hôm nay nhiều hơn 100 tin: tổng tiền chỉ tính trên 100 tin mới nhất.</p>;

  if (phone) return <section aria-label="Tổng quan hôm nay" className="rounded-2xl border bg-card shadow-sm">
    <div className="px-4 pb-3 pt-3.5">
      <div className="flex items-center justify-between gap-2"><span className="text-[12.5px] font-semibold">Hôm nay · {dayText(day).slice(0, 5)}</span><span className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground"><Info className="h-3 w-3" />Tham khảo, không phải sổ sách</span></div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        {(['in', 'out'] as const).map(flow => <div key={flow} className={flow === 'out' ? 'border-l pl-3' : undefined}>
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><FlowIcon flow={flow} className="h-5 w-5" />{flow === 'in' ? 'Tiền vào' : 'Tiền ra'}</div>
          <Figure loading={today.loading} error={today.error}>
            <p className={cn(mono, 'mt-1.5 whitespace-nowrap text-[17px] font-bold tracking-tight', flowTone[flow])}>{flow === 'in' ? '+' : '−'}{money(flow === 'in' ? totals.inSum : totals.outSum)}</p>
            <p className="text-[11.5px] text-muted-foreground">{flow === 'in' ? totals.inCount : totals.outCount} giao dịch</p>
          </Figure>
        </div>)}
      </div>
      <div className="mt-3">{bar}</div>
      <div className="mt-2.5 flex items-center justify-between border-t pt-2.5"><span className="text-[12.5px] text-muted-foreground">Chênh lệch vào − ra</span><span className={cn(mono, 'text-sm font-bold')}>{today.loading || today.error ? '—' : `${net} ₫`}</span></div>
    </div>
    {partial}
  </section>;

  const cell = 'px-5 pb-[18px] pt-4 xl:border-l xl:first:border-l-0';
  const caption = 'flex h-[22px] items-center gap-2 text-[12.5px] font-medium text-muted-foreground';
  return <section aria-label="Tổng quan hôm nay" className="rounded-xl border bg-card shadow-sm">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3">
      <span className="text-[13px] font-semibold">Hôm nay · {weekday(day)}, {dayText(day)}</span>
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Info className="h-[13px] w-[13px]" />Tham khảo · tách tự động từ tin ngân hàng, không phải số liệu sổ sách</span>
    </div>
    <div className="grid md:grid-cols-3 xl:grid-cols-[1.15fr_1.15fr_1.3fr_1fr_1fr]">
      {(['in', 'out'] as const).map(flow => <div key={flow} className={cell}>
        <div className={caption}><FlowIcon flow={flow} className="h-[22px] w-[22px]" />{flow === 'in' ? 'Tiền vào' : 'Tiền ra'}</div>
        <Figure loading={today.loading} error={today.error}>
          <p className={cn(mono, 'mt-2.5 text-[22px] font-bold leading-7 tracking-tight', flowTone[flow])}>{flow === 'in' ? '+' : '−'}{money(flow === 'in' ? totals.inSum : totals.outSum)}<span className="ml-1 text-sm">₫</span></p>
          <p className="mt-1 text-xs text-muted-foreground">{flow === 'in' ? totals.inCount : totals.outCount} giao dịch</p>
        </Figure>
      </div>)}
      <div className={cell}>
        <div className={caption}>Chênh lệch vào − ra</div>
        <Figure loading={today.loading} error={today.error}>
          <p className={cn(mono, 'mt-2.5 text-[22px] font-bold leading-7 tracking-tight')}>{net}<span className="ml-1 text-sm">₫</span></p>
          <div className="mt-2">{bar}</div>
          {totals.inShare !== null && <div className="mt-1.5 flex justify-between text-[11.5px] text-muted-foreground"><span>Vào {totals.inShare}%</span><span>Ra {100 - totals.inShare}%</span></div>}
        </Figure>
      </div>
      <div className={cell}>
        <div className={caption}><InboxIcon className="h-[15px] w-[15px]" />Tin tiếp nhận</div>
        <Figure loading={today.loading} error={today.error}>
          <p className="mt-2.5 text-[22px] font-bold leading-7">{today.partial ? '100+' : today.count}<span className="ml-1.5 text-[13px] font-medium text-muted-foreground">tin hôm nay</span></p>
          <p className="mt-1 text-xs text-muted-foreground">{totalEvents === undefined ? '—' : totalEvents.toLocaleString('vi-VN')} tin từ trước tới nay</p>
        </Figure>
      </div>
      <div className={cell}>
        <div className={caption}><Smartphone className="h-[15px] w-[15px]" />Nguồn đang bật</div>
        <Figure loading={health.loading} error={false}>
          <p className="mt-2.5 text-[22px] font-bold leading-7">{health.enabled} / {health.total}</p>
          <p className={cn('mt-1 text-xs font-medium', health.silent ? 'text-amber-700 dark:text-amber-300' : health.enabled ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground')}>
            {health.silent ? `${health.silent} nguồn cần kiểm tra` : health.enabled ? 'Các nguồn đang bật đều ổn định' : 'Chưa có nguồn nào đang bật'}
          </p>
        </Figure>
      </div>
    </div>
    {partial}
  </section>;
}

export interface FilterControls {
  flow: FlowFilter; setFlow: (flow: FlowFilter) => void; counts: Record<FlowFilter, number>;
  bank: string; setBank: (bank: string) => void; banks: { name: string; code: string }[];
  query: string; setQuery: (query: string) => void; submitQuery: () => void;
  sourceId: string; setSourceId: (id: string) => void; sources: { id: string; name: string }[];
  kind: string; setKind: (kind: string) => void; from: string; setFrom: (day: string) => void; to: string; setTo: (day: string) => void;
  serverFilterCount: number; active: boolean; clear: () => void; problem: string | null;
}

/** Thanh lọc desktop: chiều tiền và ngân hàng lọc ngay trên trang đang xem; nguồn, loại, ngày, từ khóa hỏi lại máy chủ. */
export function DesktopFilterBar({ f, resultText }: { f: FilterControls; resultText: string }) {
  return <>
    <div className="flex flex-wrap items-center gap-4 border-b px-4 py-3">
      <div role="group" aria-label="Chiều tiền" className="flex gap-0.5 rounded-[9px] bg-muted p-[3px]">
        {flowOptions.map(([id, label, tone]) => <button key={id} type="button" aria-pressed={f.flow === id} onClick={() => f.setFlow(id)}
          className={cn('inline-flex h-[30px] items-center gap-1.5 whitespace-nowrap rounded-[7px] px-3 text-[13px] font-semibold transition-colors',
            f.flow === id ? cn('bg-background shadow-sm', tone) : 'text-muted-foreground hover:text-foreground')}>
          {label}<span className="text-[11.5px] font-medium text-muted-foreground">{f.counts[id]}</span>
        </button>)}
      </div>
      {f.banks.length > 0 && <>
        <span aria-hidden className="h-6 w-px bg-border" />
        <div role="group" aria-label="Ngân hàng" className="flex flex-wrap items-center gap-1.5">
          {[{ name: '', code: 'Tất cả ngân hàng' }, ...f.banks].map(bank => <button key={bank.name} type="button" aria-pressed={f.bank === bank.name} title={bank.name || 'Tất cả ngân hàng'} onClick={() => f.setBank(bank.name)}
            className={cn('h-[30px] whitespace-nowrap rounded-full border px-[11px] text-[12.5px] font-semibold tracking-wide transition-colors',
              f.bank === bank.name ? 'border-primary bg-primary/10 text-primary dark:border-emerald-500 dark:text-emerald-300' : 'border-border bg-background text-muted-foreground hover:text-foreground')}>{bank.code}</button>)}
        </div>
      </>}
    </div>
    <form role="search" onSubmit={event => { event.preventDefault(); f.submitQuery(); }} className="flex flex-wrap items-center gap-2.5 border-b bg-muted/30 px-4 py-2.5">
      <div className="relative w-full sm:w-[280px]">
        <Search aria-hidden className="absolute left-[11px] top-[10px] h-[15px] w-[15px] text-muted-foreground" />
        <input value={f.query} onChange={event => f.setQuery(event.target.value)} placeholder="Tên nguồn hoặc mã sự kiện" maxLength={120} aria-label="Tìm theo thông tin nguồn" className={cn(fieldClass, 'w-full pl-[33px]')} />
      </div>
      <select value={f.sourceId} onChange={event => f.setSourceId(event.target.value)} aria-label="Nguồn" className={fieldClass}>
        <option value="">Tất cả nguồn</option>{f.sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}
      </select>
      <select value={f.kind} onChange={event => f.setKind(event.target.value)} aria-label="Loại tin" className={fieldClass}>
        <option value="">Tất cả loại tin</option>{Object.entries(eventLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <div className="inline-flex h-[34px] items-center gap-1.5 rounded-lg border border-input bg-background px-2 text-xs text-muted-foreground">
        <CalendarDays aria-hidden className="h-3.5 w-3.5" />
        <input type="date" value={f.from} onChange={event => f.setFrom(event.target.value)} aria-label="Từ ngày" className="bg-transparent text-[12.5px] text-foreground outline-none" />
        <span aria-hidden>→</span>
        <input type="date" value={f.to} onChange={event => f.setTo(event.target.value)} aria-label="Đến ngày" className="bg-transparent text-[12.5px] text-foreground outline-none" />
      </div>
      <div className="flex-1" />
      {f.active && <button type="button" onClick={f.clear} className="inline-flex h-[30px] items-center gap-1 px-2 text-[12.5px] font-semibold text-primary hover:underline dark:text-emerald-400"><X className="h-[13px] w-[13px]" />Xóa bộ lọc</button>}
      <span className="text-xs text-muted-foreground">{resultText}</span>
      {f.problem && <p role="alert" className="basis-full text-xs text-destructive">{f.problem}</p>}
    </form>
  </>;
}

const chip = (on: boolean) => cn('h-[34px] whitespace-nowrap rounded-full border px-3 text-[12.5px] font-semibold transition-colors',
  on ? 'border-primary bg-primary/10 text-primary dark:border-emerald-500 dark:text-emerald-300' : 'border-border bg-background text-muted-foreground');

/** Hàng chip lọc nhanh trên điện thoại; ngân hàng và bộ lọc khác mở trong bottom sheet. */
export function MobileQuickFilters({ f, onOpenFilters }: { f: FilterControls; onOpenFilters: () => void }) {
  const flowSolid: Record<FlowFilter, string> = { all: 'border-foreground bg-foreground text-background', in: 'border-emerald-600 bg-emerald-600 text-white', out: 'border-red-600 bg-red-600 text-white', other: 'border-slate-500 bg-slate-500 text-white' };
  const extra = f.serverFilterCount;
  return <div className="flex gap-2 overflow-x-auto pb-0.5 [scrollbar-width:none]">
    {flowOptions.map(([id, label]) => <button key={id} type="button" aria-pressed={f.flow === id} onClick={() => f.setFlow(id)}
      className={cn('inline-flex h-[34px] flex-none items-center gap-1.5 whitespace-nowrap rounded-full border px-[13px] text-[13px] font-semibold', f.flow === id ? flowSolid[id] : 'border-border bg-background text-foreground')}>
      {label}<span className="text-[11.5px] font-medium opacity-75">{f.counts[id]}</span>
    </button>)}
    <button type="button" onClick={onOpenFilters} className={cn(chip(!!f.bank), 'inline-flex flex-none items-center gap-1')}>{f.bank || 'Ngân hàng'}<ChevronDown className="h-3.5 w-3.5" /></button>
    <button type="button" onClick={onOpenFilters} className="inline-flex h-[34px] flex-none items-center gap-1.5 whitespace-nowrap rounded-full border bg-background px-3 text-[13px] font-semibold">
      <SlidersHorizontal className="h-3.5 w-3.5" />Bộ lọc{extra > 0 && <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-primary px-1 text-[11px] text-primary-foreground">{extra}</span>}
    </button>
  </div>;
}

/** Nội dung bottom sheet "Bộ lọc" trên điện thoại. */
export function MobileFilterSheet({ f, rowCount, onDone }: { f: FilterControls; rowCount: number; onDone: () => void }) {
  const heading = 'text-[12.5px] font-semibold text-muted-foreground';
  return <form onSubmit={event => { event.preventDefault(); f.submitQuery(); onDone(); }}>
    <p className={heading}>Chiều tiền</p>
    <div role="group" aria-label="Chiều tiền" className="mt-2 grid grid-cols-4 gap-0.5 rounded-[11px] bg-muted p-[3px]">
      {flowOptions.map(([id, label, tone]) => <button key={id} type="button" aria-pressed={f.flow === id} onClick={() => f.setFlow(id)}
        className={cn('h-[34px] whitespace-nowrap rounded-[9px] text-[12.5px] font-semibold', f.flow === id ? cn('bg-background shadow-sm', tone) : 'text-muted-foreground')}>{label}</button>)}
    </div>
    <p className={cn(heading, 'mt-4')}>Ngân hàng <span className="font-normal">· trên trang đang xem</span></p>
    <div className="mt-2 flex flex-wrap gap-1.5">
      {[{ name: '', code: '' }, ...f.banks].map(bank => <button key={bank.name} type="button" aria-pressed={f.bank === bank.name} onClick={() => f.setBank(bank.name)} className={chip(f.bank === bank.name)}>{bank.name || 'Tất cả'}</button>)}
    </div>
    <p className={cn(heading, 'mt-4')}>Nguồn</p>
    <div className="mt-2 flex flex-wrap gap-1.5">
      {[{ id: '', name: 'Tất cả' }, ...f.sources].map(source => <button key={source.id} type="button" aria-pressed={f.sourceId === source.id} onClick={() => f.setSourceId(source.id)} className={chip(f.sourceId === source.id)}>{source.name}</button>)}
    </div>
    <p className={cn(heading, 'mt-4')}>Loại tin</p>
    <div className="mt-2 flex flex-wrap gap-1.5">
      {[['', 'Tất cả'], ...Object.entries(eventLabels)].map(([value, label]) => <button key={value} type="button" aria-pressed={f.kind === value} onClick={() => f.setKind(value)} className={chip(f.kind === value)}>{label}</button>)}
    </div>
    <div className="mt-4 grid grid-cols-2 gap-2">
      <label className={heading}>Từ ngày<input type="date" value={f.from} onChange={event => f.setFrom(event.target.value)} className="mt-1.5 block h-[42px] w-full rounded-[10px] border bg-background px-2.5 text-base font-normal text-foreground" /></label>
      <label className={heading}>Đến ngày<input type="date" value={f.to} onChange={event => f.setTo(event.target.value)} className="mt-1.5 block h-[42px] w-full rounded-[10px] border bg-background px-2.5 text-base font-normal text-foreground" /></label>
    </div>
    <label className={cn(heading, 'mt-3.5 block')}>Tìm theo thông tin nguồn<input value={f.query} onChange={event => f.setQuery(event.target.value)} placeholder="Tên nguồn hoặc mã sự kiện" maxLength={120} enterKeyHint="search" className="mt-1.5 block h-[42px] w-full rounded-[10px] border bg-background px-3 text-base font-normal text-foreground" /></label>
    <p className="mt-2 text-[11.5px] text-muted-foreground">Lọc theo thời điểm máy chủ nhận · giờ Việt Nam.</p>
    {f.problem && <p role="alert" className="mt-2 text-sm text-destructive">{f.problem}</p>}
    <div className="sticky bottom-0 -mx-5 mt-4 flex gap-2 border-t bg-background px-5 pb-1 pt-3">
      <Button type="button" variant="outline" className="h-[46px] flex-1 rounded-xl text-sm font-semibold" onClick={f.clear}>Đặt lại</Button>
      <Button type="submit" className="h-[46px] flex-[1.6] rounded-xl text-sm font-semibold">Xem {rowCount} tin</Button>
    </div>
  </form>;
}

export interface RowMarks { fresh: ReadonlySet<string>; flash: ReadonlySet<string>; selectedId: string | null }
const rowAria = (event: BankEvent) => `Xem tin ${event.sourceName} ${shortId(event.externalId)}`;

/** Bảng desktop dày đặc, nhóm theo ngày máy chủ nhận. */
export function EventTable({ groups, today, marks, onOpen }: { groups: DayGroup[]; today: string; marks: RowMarks; onOpen: (event: BankEvent) => void }) {
  const cols = 'grid grid-cols-[76px_minmax(0,1.1fr)_minmax(0,1.6fr)_120px_16px] xl:grid-cols-[84px_190px_minmax(0,1fr)_200px_140px_130px_16px] gap-3.5';
  return <div>
    <div aria-hidden className={cn(cols, 'border-b bg-muted/30 px-4 py-[9px] text-[11px] font-semibold uppercase tracking-wider text-muted-foreground')}>
      <span>Giờ nhận</span><span>Ngân hàng · TK</span><span>Nội dung chuyển khoản</span><span className="hidden xl:block">Nguồn · loại tin</span><span className="text-right">Số tiền</span><span className="hidden text-right xl:block">Số dư sau</span><span />
    </div>
    {groups.map(group => <div key={group.day}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/50 px-4 py-[7px]">
        <span className="text-xs font-semibold">{dayLabel(group.day, today)}<span className="ml-1.5 font-medium text-muted-foreground">{weekday(group.day)}, {dayText(group.day)}</span></span>
        <span className={cn(mono, 'flex gap-3.5 text-[11.5px]')}><span className={flowTone.in}>Vào +{money(group.totals.inSum)}</span><span className={flowTone.out}>Ra −{money(group.totals.outSum)}</span><span className="font-sans text-muted-foreground">{group.events.length} tin</span></span>
      </div>
      {group.events.map(event => {
        const facts = eventFacts(event), TypeIcon = eventIcons[event.eventType];
        return <button key={event.id} type="button" onClick={() => onOpen(event)} aria-label={rowAria(event)} aria-current={marks.selectedId === event.id || undefined}
          className={cn(cols, 'w-full items-center border-b px-4 py-2.5 text-left transition-colors duration-1000 hover:bg-emerald-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:hover:bg-emerald-950/20',
            marks.selectedId === event.id ? 'bg-emerald-50 dark:bg-emerald-950/30' : marks.flash.has(event.id) ? 'bg-emerald-100 dark:bg-emerald-900/40' : 'bg-card')}>
          <div>
            <div className={cn(mono, 'text-[13px]')}>{vnClock(event.receivedAt)}</div>
            {marks.fresh.has(event.id) && <span className="mt-[3px] inline-flex h-[17px] items-center rounded-full bg-emerald-100 px-1.5 text-[10px] font-bold tracking-wide text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300">MỚI</span>}
            {event.duplicateCount > 0 && <span className="mt-[3px] block text-[11px] text-amber-700 dark:text-amber-300">Gửi lặp {event.duplicateCount} lần</span>}
          </div>
          <div className="flex min-w-0 items-center gap-2.5">
            <BankTile code={facts.code} className="h-8 w-8" />
            <div className="min-w-0">
              <div className={cn('truncate text-[13px] font-medium', !facts.bank && 'text-muted-foreground')}>{facts.bank ?? '—'}</div>
              {facts.account && <div className={cn(mono, 'text-[11.5px] text-muted-foreground')}>{facts.account}</div>}
            </div>
          </div>
          <div className="min-w-0">
            <div className={cn('truncate text-[13px]', !facts.hasDescription && 'text-muted-foreground')}>{facts.description}</div>
            <div className={cn(mono, 'truncate text-[11px] text-muted-foreground/80')}><span className="font-sans xl:hidden">{event.sourceName} · {eventLabels[event.eventType]} · </span>{shortId(event.externalId)}</div>
          </div>
          <div className="hidden min-w-0 xl:block">
            <div className="truncate text-[13px]">{event.sourceName}</div>
            <span className="mt-[3px] inline-flex h-5 items-center gap-1 rounded-md bg-muted px-[7px] text-[11px] font-medium text-muted-foreground"><TypeIcon aria-hidden className="h-3 w-3" />{eventLabels[event.eventType]}</span>
          </div>
          <div className="text-right">
            <div className={cn(mono, 'text-sm font-bold', facts.amountText ? flowTone[facts.flow] : flowTone.other)}>{facts.amountText ?? '—'}</div>
            {facts.balanceText && <div className={cn(mono, 'text-[11px] text-muted-foreground xl:hidden')}>SD {facts.balanceText}</div>}
          </div>
          <div className={cn(mono, 'hidden text-right text-[12.5px] text-muted-foreground xl:block')}>{facts.balanceText ?? ''}</div>
          <ChevronRight aria-hidden className="h-4 w-4 text-muted-foreground/60" />
        </button>;
      })}
    </div>)}
  </div>;
}

/** Danh sách thẻ trên điện thoại. */
export function EventCards({ groups, today, marks, onOpen }: { groups: DayGroup[]; today: string; marks: RowMarks; onOpen: (event: BankEvent) => void }) {
  return <>{groups.map(group => <div key={group.day} className="flex flex-col gap-1.5">
    <div className="flex items-baseline justify-between px-1 pt-1">
      <span className="text-[11.5px] font-bold uppercase tracking-wider text-muted-foreground">{dayLabel(group.day, today)} · {dayText(group.day).slice(0, 5)}</span>
      <span className={cn(mono, 'flex gap-2 text-[11px]')}><span className={flowTone.in}>+{money(group.totals.inSum)}</span><span className={flowTone.out}>−{money(group.totals.outSum)}</span></span>
    </div>
    <div className="overflow-hidden rounded-[14px] border bg-card">
      {group.events.map(event => {
        const facts = eventFacts(event);
        const meta = facts.code ? `${facts.code}${facts.account ? ` ${facts.account}` : ''} · ${eventLabels[event.eventType]}` : `${event.sourceName} · ${eventLabels[event.eventType]}`;
        return <button key={event.id} type="button" onClick={() => onOpen(event)} aria-label={rowAria(event)}
          className={cn('flex w-full items-center gap-3 border-t px-3.5 py-3 text-left transition-colors duration-1000 first:border-t-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
            marks.flash.has(event.id) ? 'bg-emerald-100 dark:bg-emerald-900/40' : 'bg-card')}>
          <span aria-hidden className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-[11px] bg-muted text-[10px] font-bold tracking-wide', facts.code ? 'text-foreground' : 'text-muted-foreground/60')}>{facts.code ?? '—'}</span>
          <div className="min-w-0 flex-1">
            <div className={cn('truncate text-sm font-medium', !facts.hasDescription && 'text-muted-foreground')}>{facts.description}</div>
            <div className="mt-0.5 flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-xs text-muted-foreground">
              {marks.fresh.has(event.id) && <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-emerald-500"><span className="sr-only">Tin mới</span></span>}
              <span className="truncate">{meta}</span>
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className={cn(mono, 'whitespace-nowrap text-sm font-bold', facts.amountText ? flowTone[facts.flow] : flowTone.other)}>{facts.amountText ?? '—'}</div>
            <div className={cn(mono, 'mt-0.5 text-[11px] text-muted-foreground')}>{vnClock(event.receivedAt).slice(0, 5)}</div>
          </div>
        </button>;
      })}
    </div>
  </div>)}</>;
}

export function EmptyInbox({ phone, onClear, canClear }: { phone: boolean; onClear: () => void; canClear: boolean }) {
  return <div className={cn('px-6 text-center', phone ? 'rounded-[14px] border border-dashed bg-card py-10' : 'py-14')}>
    <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-xl bg-muted text-muted-foreground"><InboxIcon className="h-6 w-6" /></div>
    <p className="font-semibold">Chưa có dữ liệu phù hợp</p>
    <p className="mb-3.5 mt-1 text-[13px] text-muted-foreground">Kết nối nguồn hoặc điều chỉnh bộ lọc để xem tin nhận được.</p>
    {canClear && <Button variant="outline" size="sm" onClick={onClear}>Xóa bộ lọc</Button>}
  </div>;
}

export function Pager({ phone, page, canBack, canNext, onBack, onNext }: { phone: boolean; page: number; canBack: boolean; canNext: boolean; onBack: () => void; onNext: () => void }) {
  if (phone) return <div className="flex flex-col gap-2">
    <div className="flex gap-2">
      {page > 1 && <Button variant="outline" className="h-[42px] flex-1 rounded-xl text-[13.5px] font-semibold" disabled={!canBack} onClick={onBack}><ChevronLeft className="mr-1 h-4 w-4" />Trang trước</Button>}
      <Button variant="outline" className="h-[42px] flex-1 rounded-xl text-[13.5px] font-semibold" disabled={!canNext} onClick={onNext}>Trang sau<ChevronRight className="ml-1 h-4 w-4" /></Button>
    </div>
    <p className="text-center text-xs text-muted-foreground">Trang {page} · tối đa 25 tin</p>
  </div>;
  return <div className="flex items-center justify-between px-4 py-2.5 text-[12.5px] text-muted-foreground">
    <span>Trang {page} · tối đa 25 tin</span>
    <div className="flex gap-1.5">
      <Button variant="outline" size="sm" className="h-8 px-2.5" disabled={!canBack} onClick={onBack}><ChevronLeft className="mr-1 h-4 w-4" />Trước</Button>
      <Button variant="outline" size="sm" className="h-8 px-2.5" disabled={!canNext} onClick={onNext}>Sau<ChevronRight className="ml-1 h-4 w-4" /></Button>
    </div>
  </div>;
}
