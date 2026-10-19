import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertTriangle, ArrowRight, Check, ChevronRight, Copy, Download, Inbox, Info, Landmark, Mail, Plus, RefreshCw, ShieldCheck, Smartphone, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePhoneViewport } from '@/hooks/use-mobile';
import { useBankEvents } from '@/hooks/bank-events/useBankEvents';
import MainLayout from '@/components/layout/MainLayout';
import { bankEventService, eventType, type BankEvent, type BankSource, type BankSourceKind, type EventFilters } from '@/lib/bank-events/service';
import { arrivals, bankCode, eventFacts, flowCounts, flowOf, flowTotals, groupByDay, isSilentGmail, silentMinutes, vnClock, type FlowFilter } from '@/lib/bank-events/view';
import { cn } from '@/lib/utils';
import { GmailSetup } from './GmailSetup';
import { DesktopEventDrawer, MobileEventSheet, type RawState } from './EventDetail';
import { DesktopFilterBar, EmptyInbox, EventCards, EventTable, MobileFilterSheet, MobileQuickFilters, Pager, TodaySummary, type FilterControls } from './Inbox';
import { OperationsPanel } from './OperationsPanel';
import { SourcesPanel } from './SourcesPanel';
import { gatewayApk } from './labels';
import { LiveDot, ResponsiveModal } from './parts';

type Tab = 'events' | 'sources' | 'operations';
type Secret = { actorId: string; name: string; token: string; kind: BankSourceKind; rotated: boolean };
type Raw = { actorId: string; eventId: string; payload: Record<string, unknown> };
interface FilterForm { query: string; sourceId: string; kind: string; from: string; to: string }
const PAGE_SIZE = 25;
const emptyForm: FilterForm = { query: '', sourceId: '', kind: '', from: '', to: '' };

function filterProblem({ query, from, to }: FilterForm) {
  if (from && to && from > to) return 'Ngày kết thúc phải bằng hoặc sau ngày bắt đầu.';
  if (new TextEncoder().encode(query.trim()).length > 120) return 'Từ khóa quá dài. Hãy nhập một phần tên nguồn hoặc mã sự kiện.';
  return null;
}
function buildFilters({ query, sourceId, kind, from, to }: FilterForm): EventFilters {
  const next: EventFilters = { limit: PAGE_SIZE };
  if (query.trim()) next.query = query.trim();
  if (sourceId) next.sourceId = sourceId;
  // hermes-parity:begin bank-events — Hermes chép vùng này, xem infra/hermes-broker/web-parity.json
  const type = eventType.safeParse(kind);
  if (type.success) next.eventType = type.data;
  if (from) next.from = new Date(`${from}T00:00:00+07:00`).toISOString();
  if (to) next.to = new Date(new Date(`${to}T00:00:00+07:00`).getTime() + 86_400_000).toISOString();
  // hermes-parity:end bank-events
  return next;
}

function StateBlock({ loading, error, empty, retry, children }: { loading: boolean; error: boolean; empty: boolean; retry: () => void; children: React.ReactNode }) {
  if (error) return <div role="alert" className="rounded-xl border border-destructive/25 bg-destructive/5 p-6"><p className="font-medium">Chưa tải được dữ liệu</p><p className="mt-1 text-sm text-muted-foreground">Kiểm tra quyền truy cập và kết nối rồi thử lại.</p><Button variant="outline" size="sm" onClick={retry} className="mt-3">Thử lại</Button></div>;
  if (loading) return <div aria-label="Đang tải dữ liệu" className="space-y-3"><Skeleton className="h-24" /><Skeleton className="h-24" /></div>;
  if (empty) return <div className="rounded-xl border border-dashed bg-muted/20 px-6 py-14 text-center"><Inbox className="mx-auto mb-3 h-9 w-9 text-muted-foreground/60" /><p className="font-medium">Chưa có dữ liệu phù hợp</p><p className="mt-1 text-sm text-muted-foreground">Kết nối nguồn hoặc điều chỉnh bộ lọc để xem tin nhận được.</p></div>;
  return <>{children}</>;
}

/** Thông báo nổi khi có tin mới trong lúc đang xem trang đầu. */
function ArrivalToast({ event, phone }: { event: BankEvent; phone: boolean }) {
  const facts = eventFacts(event);
  const title = facts.bank ? `Tin mới · ${facts.bank}${facts.account && !phone ? ` ${facts.account}` : ''}` : `Tin mới · ${event.sourceName}`;
  return <div role="status" className={cn('fixed z-40 flex items-center gap-3 bg-[#12211c] text-[13px] text-white shadow-2xl motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-2',
    phone ? 'inset-x-3 top-3 rounded-2xl px-3.5 py-[11px]' : 'right-6 top-5 w-[340px] rounded-xl px-3.5 py-3')}>
    <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full', facts.flow === 'out' ? 'bg-red-400' : facts.flow === 'in' ? 'bg-emerald-400' : 'bg-white/50')} />
    <div className="min-w-0 flex-1"><p className="font-semibold">{title}</p><p className="mt-0.5 truncate text-xs text-white/70">{facts.description}</p></div>
    {facts.amountText && <span className={cn('shrink-0 font-numeric font-bold', facts.flow === 'out' ? 'text-red-300' : 'text-emerald-300')}>{facts.amountText}</span>}
  </div>;
}

export default function BankEventsPage() {
  const phone = usePhoneViewport();
  const [form, setForm] = useState<FilterForm>(emptyForm);
  const [appliedQuery, setAppliedQuery] = useState('');
  const [base, setBase] = useState<EventFilters>({ limit: PAGE_SIZE });
  const baseKey = JSON.stringify(base);
  const [paging, setPaging] = useState<{ key: string; history: (string | undefined)[]; cursor?: string }>({ key: baseKey, history: [] });
  const page = paging.key === baseKey ? paging : { key: baseKey, history: [] as (string | undefined)[], cursor: undefined };
  const filters = useMemo<EventFilters>(() => page.cursor ? { ...base, cursor: page.cursor } : base, [base, page.cursor]);
  const data = useBankEvents(filters);
  const { actorId, allowed, day, events, sources, status, today } = data;
  const [tab, setTab] = useState<Tab>('events');
  const [flow, setFlow] = useState<FlowFilter>('all');
  const [bank, setBank] = useState('');
  const [filterSheet, setFilterSheet] = useState(false);
  const [alertOff, setAlertOff] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [newKind, setNewKind] = useState<BankSourceKind>('android');
  const [secret, setSecret] = useState<Secret | null>(null);
  const [copied, setCopied] = useState(false);
  const [selected, setSelected] = useState<BankEvent | null>(null);
  const [raw, setRaw] = useState<Raw | null>(null);
  const [rawLoading, setRawLoading] = useState(false);
  const [rawError, setRawError] = useState<string | null>(null);
  const detailRequest = useRef(0);
  const [confirm, setConfirm] = useState<{ source: BankSource; action: 'rotate' | 'revoke' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const [flash, setFlash] = useState<ReadonlySet<string>>(() => new Set());
  const [toast, setToast] = useState<BankEvent | null>(null);
  const [unseen, setUnseen] = useState(0);
  const baseline = useRef<{ scope: string; events: BankEvent[] } | null>(null);
  const timers = useRef<number[]>([]);
  const tabRef = useRef<Tab>(tab);
  useEffect(() => { tabRef.current = tab; }, [tab]);

  useEffect(() => { detailRequest.current++; setRawLoading(false); setSecret(null); setSelected(null); setRaw(null); setConfirm(null); setCreateOpen(false); setError(null); }, [actorId, allowed]);
  useEffect(() => () => { timers.current.forEach(window.clearTimeout); }, []);
  // Ô tìm gõ xong mới hỏi máy chủ; nguồn, loại, ngày đổi là lọc ngay.
  useEffect(() => { const timer = window.setTimeout(() => setAppliedQuery(form.query), 450); return () => window.clearTimeout(timer); }, [form.query]);
  const { sourceId, kind, from, to } = form;
  useEffect(() => {
    const applied = { query: appliedQuery, sourceId, kind, from, to };
    if (filterProblem(applied)) return;
    const next = buildFilters(applied);
    setBase(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
  }, [appliedQuery, sourceId, kind, from, to]);

  // Tin mới: so với lần tải trước của cùng bộ lọc và cùng trang; đổi bộ lọc hay trang thì lấy mốc mới, không báo oan.
  const scope = `${actorId}|${JSON.stringify(filters)}`;
  const loaded = events.data?.events;
  useEffect(() => {
    if (!loaded) return;
    const previous = baseline.current;
    baseline.current = { scope, events: loaded };
    if (!previous || previous.scope !== scope) return;
    const arrived = arrivals(previous.events, loaded);
    if (!arrived.length) return;
    const ids = arrived.map(event => event.id);
    setFresh(current => new Set([...current, ...ids]));
    setFlash(current => new Set([...current, ...ids]));
    setToast(arrived[0]);
    if (tabRef.current !== 'events') setUnseen(count => count + arrived.length);
    timers.current.push(
      window.setTimeout(() => setFlash(current => new Set([...current].filter(id => !ids.includes(id)))), 5000),
      window.setTimeout(() => setToast(current => current?.id === arrived[0].id ? null : current), 4500),
    );
  }, [loaded, scope]);

  const reload = () => { void data.refresh(); };
  const sourceList = sources.isError ? [] : sources.data?.sources ?? [];
  const summary = status.isError ? undefined : status.data;
  const serverTime = summary?.serverTime;
  const silentSources = sourceList.filter(source => isSilentGmail(source, serverTime));
  const pageEvents = useMemo(() => events.isError ? [] : events.data?.events ?? [], [events.isError, events.data]);
  const banks = useMemo(() => {
    const tally = new Map<string, number>();
    for (const event of pageEvents) if (event.summary?.bank) tally.set(event.summary.bank, (tally.get(event.summary.bank) ?? 0) + 1);
    if (bank && !tally.has(bank)) tally.set(bank, 0);
    return [...tally].sort((a, b) => b[1] - a[1]).map(([bankName]) => ({ name: bankName, code: bankCode(bankName) }));
  }, [pageEvents, bank]);
  const bankRows = bank ? pageEvents.filter(event => event.summary?.bank === bank) : pageEvents;
  const counts = flowCounts(bankRows);
  const rows = flow === 'all' ? bankRows : bankRows.filter(event => flowOf(event) === flow);
  const groups = groupByDay(rows);
  const todayEvents = today.isError ? [] : today.data?.events ?? [];
  const serverFilterCount = [form.sourceId, form.kind, form.query.trim(), form.from || form.to].filter(Boolean).length;
  const quickActive = flow !== 'all' || !!bank;
  const pageNumber = page.history.length + 1;

  const clearFilters = () => { setForm(emptyForm); setAppliedQuery(''); setFlow('all'); setBank(''); };
  const controls: FilterControls = {
    flow, setFlow, counts, bank, setBank, banks,
    query: form.query, setQuery: query => setForm(current => ({ ...current, query })), submitQuery: () => setAppliedQuery(form.query),
    sourceId: form.sourceId, setSourceId: id => setForm(current => ({ ...current, sourceId: id })), sources: sourceList.map(source => ({ id: source.id, name: source.name })),
    kind: form.kind, setKind: value => setForm(current => ({ ...current, kind: value })),
    from: form.from, setFrom: value => setForm(current => ({ ...current, from: value })), to: form.to, setTo: value => setForm(current => ({ ...current, to: value })),
    serverFilterCount, active: serverFilterCount > 0 || quickActive, clear: clearFilters, problem: filterProblem(form),
  };

  async function action(work: (id: string) => Promise<void>) {
    if (!actorId || !allowed || busy) return;
    setBusy(true); setError(null);
    try { await work(actorId); await data.refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Không hoàn tất thao tác. Vui lòng thử lại.'); }
    finally { setBusy(false); }
  }
  async function loadRaw(event: BankEvent) {
    if (!actorId || !allowed) return;
    const request = ++detailRequest.current;
    setRaw(null); setRawError(null); setRawLoading(true);
    try { const result = await bankEventService(actorId).detail(event.id); if (request === detailRequest.current) setRaw({ actorId, eventId: event.id, payload: result.payload }); }
    catch (failure) { if (request === detailRequest.current) setRawError(failure instanceof Error ? failure.message : 'Không đọc được nội dung tin.'); }
    finally { if (request === detailRequest.current) setRawLoading(false); }
  }
  function openEvent(event: BankEvent) {
    detailRequest.current++; setRaw(null); setRawError(null); setRawLoading(false); setSelected(event);
    // Điện thoại: tóm tắt hiện ngay, nội dung nguyên văn chỉ tải khi người xem bấm.
    if (!phone) void loadRaw(event);
  }
  function closeEvent() { detailRequest.current++; setSelected(null); setRaw(null); setRawLoading(false); setRawError(null); }
  function pickTab(next: string) { setTab(next as Tab); if (next === 'events') setUnseen(0); }

  const activeSecret = allowed && secret?.actorId === actorId ? secret : null;
  const activeEvent = allowed ? selected : null;
  const rawState: RawState = { loading: rawLoading, error: rawError, payload: raw && raw.actorId === actorId && raw.eventId === selected?.id ? raw.payload : null };
  const selectedIndex = activeEvent ? rows.findIndex(event => event.id === activeEvent.id) : -1;
  const onNewer = selectedIndex > 0 ? () => openEvent(rows[selectedIndex - 1]) : null;
  const onOlder = selectedIndex >= 0 && selectedIndex < rows.length - 1 ? () => openEvent(rows[selectedIndex + 1]) : null;
  if (!allowed) return null;

  const firstSilent = silentSources[0];
  const silentMin = firstSilent && serverTime ? silentMinutes(firstSilent, serverTime) : null;
  const alertTitle = firstSilent ? `${firstSilent.name} ${silentMin === null ? 'chưa báo liên lạc' : `im lặng ${silentMin} phút`}` : '';
  const live = !page.cursor && !events.isError;
  const liveText = events.isError ? 'Chưa tải được tin' : live ? 'Trực tiếp · cập nhật 15 giây/lần' : `Đang xem trang ${pageNumber} · tạm dừng tự cập nhật`;
  const marks = { fresh, flash, selectedId: activeEvent?.id ?? null };
  const resultText = `${rows.length} tin · trang ${pageNumber}${quickActive ? ' · lọc trên trang này' : ''}`;
  const pager = <Pager phone={phone} page={pageNumber} canBack={!!page.history.length && !events.isFetching} canNext={!!events.data?.nextCursor && !events.isError && !events.isFetching}
    onBack={() => setPaging({ key: baseKey, history: page.history.slice(0, -1), cursor: page.history.at(-1) })}
    onNext={() => { if (events.data?.nextCursor) setPaging({ key: baseKey, history: [...page.history, page.cursor], cursor: events.data.nextCursor }); }} />;
  const list = events.isError
    ? <div role="alert" className={cn('p-6', phone && 'rounded-xl border border-destructive/25 bg-destructive/5')}><p className="font-medium">Chưa tải được tin nhận được</p><p className="mt-1 text-sm text-muted-foreground">Kiểm tra quyền truy cập và kết nối rồi thử lại.</p><Button variant="outline" size="sm" onClick={reload} className="mt-3">Thử lại</Button></div>
    : events.isPending ? <div aria-label="Đang tải dữ liệu" className={cn('space-y-2', !phone && 'p-4')}>{[0, 1, 2, 3].map(index => <Skeleton key={index} className={phone ? 'h-16 rounded-[14px]' : 'h-12'} />)}</div>
    : !rows.length ? <EmptyInbox phone={phone} onClear={clearFilters} canClear={controls.active} />
    : phone ? <EventCards groups={groups} today={day} marks={marks} onOpen={openEvent} /> : <EventTable groups={groups} today={day} marks={marks} onOpen={openEvent} />;
  const todaySummary = <TodaySummary phone={phone} day={day} totalEvents={summary?.totalEvents}
    today={{ totals: flowTotals(todayEvents), count: todayEvents.length, partial: !!today.data?.nextCursor, loading: today.isPending, error: today.isError }}
    health={{ enabled: sourceList.filter(source => source.enabled && !source.revokedAt).length, total: sourceList.length, silent: silentSources.length, loading: sources.isPending }} />;
  const footnote = 'Số tiền và nội dung được tách tự động từ tin ngân hàng để tiện theo dõi; chưa dùng để tự xác nhận thanh toán hoặc ghi sổ.';
  const sourcesBlock = <StateBlock loading={sources.isPending} error={sources.isError} empty={!sourceList.length} retry={reload}>
    <SourcesPanel phone={phone} sources={sourceList} serverTime={serverTime} onAdd={() => { setError(null); setName(''); setNewKind('android'); setCreateOpen(true); }}
      actions={{ busy, onToggle: source => { void action(async id => { await bankEventService(id).enabled(source.id, !source.enabled); }); }, onRotate: source => { setError(null); setConfirm({ source, action: 'rotate' }); }, onRevoke: source => { setError(null); setConfirm({ source, action: 'revoke' }); } }} />
  </StateBlock>;
  const errors = <>
    {status.isError && <p role="alert" className="text-sm text-destructive">Chưa tải được số liệu vận hành. Bấm Làm mới để thử lại.</p>}
    {error && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">{error}</div>}
  </>;
  const refreshing = events.isFetching || sources.isFetching || status.isFetching || today.isFetching;

  const dialogs = <>
    <ResponsiveModal phone={phone} open={createOpen} onOpenChange={open => { if (!busy) setCreateOpen(open); }} title="Thêm nguồn kết nối" description="Chọn loại nguồn và đặt tên để nhận ra nơi gửi tin. Khóa mới chỉ hiện một lần sau khi tạo.">
      {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
      <form onSubmit={event => { event.preventDefault(); void action(async id => { const result = await bankEventService(id).create(name.trim(), newKind); setCreateOpen(false); setSecret({ actorId: id, name: result.source.name, token: result.token, kind: result.source.kind, rotated: false }); setCopied(false); }); }} className="space-y-4">
        <fieldset><legend className="text-[13px] font-semibold">Loại nguồn</legend>
          <div className={cn('mt-2 grid gap-2.5', !phone && 'grid-cols-2')}>{(['android', 'gmail'] as const).map(option => {
            const Icon = option === 'android' ? Smartphone : Mail;
            return <label key={option} className={cn('flex cursor-pointer items-start gap-2.5 rounded-[10px] border-[1.5px] p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring', newKind === option ? 'border-primary bg-primary/5 dark:border-emerald-500' : 'border-border')}>
              <input type="radio" name="source-kind" value={option} className="sr-only" checked={newKind === option} onChange={() => setNewKind(option)} />
              <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400"><Icon className="h-4 w-4" /></span>
              <span className="flex-1"><span className="block text-[13px] font-semibold">{option === 'android' ? 'Điện thoại Android' : 'Gmail'}</span><span className="mt-0.5 block text-xs leading-[17px] text-muted-foreground">{option === 'android' ? 'App iHome Gateway chuyển SMS và thông báo ngân hàng.' : 'Script trong Gmail của bạn chuyển email ngân hàng.'}</span></span>
              {phone && <span aria-hidden className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-full border-2', newKind === option ? 'border-primary' : 'border-border')}>{newKind === option && <span className="h-2.5 w-2.5 rounded-full bg-primary" />}</span>}
            </label>;
          })}</div>
        </fieldset>
        <div><Label htmlFor="source-name" className="text-[13px] font-semibold">Tên nguồn</Label><Input id="source-name" autoFocus={!phone} className={cn('mt-2', phone && 'h-[46px] rounded-xl text-base')} value={name} onChange={event => setName(event.target.value)} placeholder={newKind === 'gmail' ? 'Gmail nhận báo ngân hàng' : 'Điện thoại kế toán'} maxLength={100} required /></div>
        <Button type="submit" className={cn('w-full', phone && 'h-[46px] rounded-xl')} disabled={busy || !name.trim()}>{busy ? 'Đang tạo…' : 'Tạo nguồn và cấp khóa'}</Button>
      </form>
    </ResponsiveModal>
    <ResponsiveModal phone={phone} open={!!confirm} onOpenChange={open => { if (!open && !busy) setConfirm(null); }} title={confirm?.action === 'rotate' ? 'Cấp lại khóa kết nối?' : 'Thu hồi nguồn kết nối?'}
      description={confirm?.action === 'rotate' ? (confirm.source.kind === 'gmail' ? 'Khóa cũ ngừng hoạt động ngay. Sau đó dán script mới thay toàn bộ script cũ trong Apps Script rồi chạy lại hàm caiDat; email chưa gửi sẽ được gửi bù.' : 'Trước khi cấp lại, hãy mở iHome Gateway và gửi hết tin đang chờ. Khóa cũ ngừng hoạt động ngay; tin còn gắn với khóa cũ sẽ không gửi được bằng khóa mới. Sau đó cập nhật khóa mới trên điện thoại.') : 'Nguồn này sẽ ngừng nhận dữ liệu và không thể bật lại. Các tin đã nhận vẫn được giữ.'}>
      <p className="rounded-lg bg-muted/60 px-3 py-2.5 text-sm font-semibold">{confirm?.source.name}</p>
      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
      <div className={cn('mt-4 flex gap-2', phone ? '' : 'justify-end')}>
        <Button variant="outline" className={cn(phone && 'h-[46px] flex-1 rounded-xl')} onClick={() => setConfirm(null)} disabled={busy}>Hủy</Button>
        <Button variant={confirm?.action === 'revoke' ? 'destructive' : 'default'} className={cn(phone && 'h-[46px] flex-[1.4] rounded-xl')} disabled={busy} onClick={() => { const pending = confirm; if (!pending) return; void action(async id => { if (pending.action === 'rotate') { const result = await bankEventService(id).rotate(pending.source.id); setSecret({ actorId: id, name: result.source.name, token: result.token, kind: result.source.kind, rotated: true }); setCopied(false); } else await bankEventService(id).revoke(pending.source.id); setConfirm(null); }); }}>{busy ? 'Đang xử lý…' : confirm?.action === 'rotate' ? 'Cấp lại khóa' : 'Thu hồi nguồn'}</Button>
      </div>
    </ResponsiveModal>
    {activeSecret?.kind === 'gmail'
      ? <Dialog open onOpenChange={open => { if (!open) setSecret(null); }}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl"><GmailSetup key={activeSecret.token} name={activeSecret.name} token={activeSecret.token} rotated={activeSecret.rotated} ingestUrl={summary?.ingestUrl ?? null} onClose={() => setSecret(null)} /></DialogContent></Dialog>
      : <ResponsiveModal phone={phone} dismissible={false} open={!!activeSecret} onOpenChange={open => { if (!open) { setSecret(null); setCopied(false); } }} title={`Khóa kết nối · ${activeSecret?.name ?? ''}`} description="Chỉ hiển thị lần này. Sao chép vào iHome Gateway trên điện thoại trước khi đóng.">
        <div className="space-y-3">
          <div><p className="text-[12.5px] font-semibold">Địa chỉ webhook</p><p className="mt-1.5 break-all rounded-lg bg-muted p-3 font-numeric text-xs">{summary?.ingestUrl ?? 'Chưa cấu hình địa chỉ nhận. Kiểm tra tab Vận hành.'}</p></div>
          <div><Label htmlFor="source-token" className="text-[12.5px] font-semibold">Khóa xác thực</Label><Input id="source-token" readOnly autoComplete="off" value={activeSecret?.token ?? ''} className="mt-1.5 h-10 font-numeric text-xs" /></div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className={cn('grid gap-2 pt-1', !phone && 'grid-cols-2')}>
            <Button className={cn(phone && 'h-[46px] rounded-xl')} onClick={() => { if (activeSecret) void navigator.clipboard.writeText(activeSecret.token).then(() => setCopied(true)).catch(() => setError('Không truy cập được clipboard. Hãy chọn và sao chép khóa trực tiếp.')); }}>{copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}{copied ? 'Đã sao chép khóa' : 'Sao chép khóa'}</Button>
            <Button variant="outline" className={cn(phone && 'h-[46px] rounded-xl')} onClick={() => setSecret(null)}>Tôi đã lưu khóa · Đóng</Button>
          </div>
        </div>
      </ResponsiveModal>}
    {phone
      ? <MobileEventSheet event={activeEvent} raw={rawState} onClose={closeEvent} onShowRaw={() => { if (activeEvent) void loadRaw(activeEvent); }} />
      : <DesktopEventDrawer event={activeEvent} raw={rawState} onClose={closeEvent} onNewer={onNewer} onOlder={onOlder} />}
    {phone && <ResponsiveModal phone open={filterSheet} onOpenChange={setFilterSheet} title="Bộ lọc"><MobileFilterSheet f={controls} rowCount={rows.length} onDone={() => setFilterSheet(false)} /></ResponsiveModal>}
    {toast && <ArrivalToast key={toast.id} event={toast} phone={phone} />}
  </>;

  if (phone) {
    const head = tab === 'sources'
      ? { eyebrow: 'Biến động số dư', Icon: Landmark, title: 'Nguồn kết nối', sub: `${sourceList.filter(source => source.enabled && !source.revokedAt).length}/${sourceList.length} đang bật${silentSources.length ? ` · ${silentSources.length} cần kiểm tra` : ''}`, warn: silentSources.length > 0 }
      : tab === 'operations' ? { eyebrow: 'Biến động số dư', Icon: Landmark, title: 'Vận hành', sub: 'Toàn hệ thống · Chỉ super admin', warn: false }
      : { eyebrow: 'Trung tâm tiếp nhận', Icon: Activity, title: 'Biến động số dư', sub: null, warn: false };
    const navItems: [Tab, string, typeof Inbox, number | '!' | null, string][] = [
      ['events', 'Tin nhận', Inbox, unseen || null, 'bg-red-500'], ['sources', 'Nguồn', Smartphone, silentSources.length ? '!' : null, 'bg-amber-500'], ['operations', 'Vận hành', Activity, null, ''],
    ];
    return <MainLayout><Tabs value={tab} onValueChange={pickTab} className="mx-auto w-full max-w-xl pb-28">
      <header className="flex items-end justify-between gap-3 pb-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400"><head.Icon className="h-[13px] w-[13px]" />{head.eyebrow}</p>
          <h1 className="mt-[3px] whitespace-nowrap text-[26px] font-bold leading-8 tracking-tight">{head.title}</h1>
          {head.sub && <p className={cn('mt-0.5 text-[12.5px] font-medium', head.warn ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground')}>{head.sub}</p>}
        </div>
        {tab === 'sources'
          ? <Button size="icon" aria-label="Thêm nguồn" disabled={busy} onClick={() => { setError(null); setName(''); setNewKind('android'); setCreateOpen(true); }} className="h-[42px] w-[42px] shrink-0 rounded-full shadow-lg shadow-primary/30"><Plus className="h-5 w-5" strokeWidth={2.4} /></Button>
          : <Button size="icon" variant="outline" aria-label="Làm mới" disabled={refreshing} onClick={reload} className="h-[42px] w-[42px] shrink-0 rounded-full"><RefreshCw className="h-[18px] w-[18px]" /></Button>}
      </header>
      <div className="space-y-3">{errors}</div>
      <TabsContent value="events" className="mt-0 flex flex-col gap-3">
        <div className="flex items-center justify-between px-0.5">
          <span className={cn('inline-flex items-center gap-2 text-xs font-semibold', live ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground')}><LiveDot paused={!live} />{live ? 'Trực tiếp · 15 giây/lần' : liveText}</span>
          {summary?.lastReceivedAt && <span className="text-[11.5px] text-muted-foreground">Gần nhất <span className="font-numeric text-foreground">{vnClock(summary.lastReceivedAt)}</span></span>}
        </div>
        {todaySummary}
        {firstSilent && <button type="button" onClick={() => pickTab('sources')} className="flex w-full items-center gap-3 rounded-[14px] border border-amber-200 bg-amber-50 p-3 text-left text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px] bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-300"><AlertTriangle className="h-4 w-4" /></span>
          <span className="min-w-0 flex-1"><span className="block text-[13px] font-semibold">{alertTitle}</span><span className="mt-px block text-xs opacity-80">Hơn 30 phút chưa nhận tin từ script</span></span>
          <ChevronRight aria-hidden className="h-[18px] w-[18px]" />
        </button>}
        <MobileQuickFilters f={controls} onOpenFilters={() => setFilterSheet(true)} />
        {list}
        {!events.isError && !events.isPending && pager}
        <p className="px-2 text-center text-[11.5px] leading-[17px] text-muted-foreground/80">{footnote}</p>
      </TabsContent>
      <TabsContent value="sources" className="mt-0">{sourcesBlock}</TabsContent>
      <TabsContent value="operations" className="mt-0"><OperationsPanel phone status={summary} failed={status.isError} /></TabsContent>
      <TabsList className="fixed inset-x-0 bottom-0 z-30 flex h-auto items-stretch justify-around rounded-none border-t bg-background/95 px-0 pb-[calc(env(safe-area-inset-bottom)+10px)] pt-2 backdrop-blur">
        {navItems.map(([value, label, Icon, badge, badgeTone]) => <TabsTrigger key={value} value={value} className="group flex flex-1 flex-col items-center gap-[3px] rounded-none bg-transparent p-0 text-muted-foreground shadow-none data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none dark:data-[state=active]:text-emerald-400">
          <span className="relative grid h-[30px] w-[52px] place-items-center rounded-full group-data-[state=active]:bg-primary/10"><Icon className="h-[21px] w-[21px]" />
            {badge !== null && <span className={cn('absolute -top-0.5 right-1 grid h-[17px] min-w-[17px] place-items-center rounded-full border-2 border-background px-1 text-[10px] font-bold text-white', badgeTone)}>{badge}</span>}
          </span>
          <span className="text-[11px] font-semibold">{label}</span>
        </TabsTrigger>)}
      </TabsList>
      {dialogs}
    </Tabs></MainLayout>;
  }

  const tabDefs: [Tab, string, string][] = [
    ['events', 'Tin nhận được', summary ? summary.totalEvents.toLocaleString('vi-VN') : '—'], ['sources', 'Nguồn kết nối', String(sourceList.length)], ['operations', 'Vận hành', silentSources.length ? '!' : 'OK'],
  ];
  const tabNote = tab === 'events' ? 'Lọc theo thời điểm máy chủ nhận · giờ Việt Nam' : tab === 'sources' ? 'Khóa chỉ hiện một lần sau khi tạo hoặc cấp lại' : serverTime ? `Đồng hồ máy chủ ${vnClock(serverTime)}` : '';
  return <MainLayout><main className="mx-auto w-full max-w-7xl space-y-5 pb-12 lg:px-4 lg:pt-1">
    <header className="flex flex-wrap items-end justify-between gap-6">
      <div>
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400"><Activity className="h-[15px] w-[15px]" />Trung tâm tiếp nhận</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-3">
          <h1 className="text-[26px] font-bold leading-8 tracking-tight">Biến động số dư</h1>
          <span title="Không giới hạn theo công ty đang chọn." className="inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-full border bg-card px-2.5 text-xs font-medium text-muted-foreground"><ShieldCheck className="h-[13px] w-[13px] text-emerald-700 dark:text-emerald-400" />Toàn hệ thống · Chỉ super admin</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('inline-flex h-8 items-center gap-2 whitespace-nowrap rounded-full border px-3 text-xs font-semibold', live ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-muted text-muted-foreground')}><LiveDot paused={!live} />{liveText}</span>
        <Button variant="outline" asChild className="h-9 px-3 text-[13px]"><a href={gatewayApk.url} target="_blank" rel="noopener noreferrer"><Download className="mr-2 h-[15px] w-[15px]" />Tải app Android<span className="ml-1.5 text-xs text-muted-foreground">v{gatewayApk.version}</span></a></Button>
        <Button variant="outline" onClick={reload} disabled={refreshing} className="h-9 px-3 text-[13px]"><RefreshCw className="mr-2 h-[15px] w-[15px]" />Làm mới</Button>
      </div>
    </header>
    {firstSilent && !alertOff && <div className="flex items-center gap-3 rounded-[10px] border border-amber-200 bg-amber-50 py-2.5 pl-3.5 pr-3 text-[13px] leading-[19px] text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
      <span aria-hidden className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-300"><AlertTriangle className="h-4 w-4" /></span>
      <p className="flex min-w-0 flex-1 flex-wrap gap-x-2.5"><strong className="font-semibold">{alertTitle}</strong><span className="text-amber-800 dark:text-amber-200/80">Mở dự án Apps Script, xem mục Trình kích hoạt và Lần thực thi; nếu trống thì chạy lại hàm caiDat.</span></p>
      <Button variant="outline" size="sm" onClick={() => pickTab('sources')} className="h-[30px] shrink-0 border-amber-300 bg-background px-2.5 text-xs font-semibold text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-100">Xem nguồn<ArrowRight className="ml-1.5 h-[13px] w-[13px]" /></Button>
      <button type="button" aria-label="Ẩn cảnh báo" onClick={() => setAlertOff(true)} className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-md text-amber-700 hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-900/50"><X className="h-[15px] w-[15px]" /></button>
    </div>}
    {todaySummary}
    {errors}
    <Tabs value={tab} onValueChange={pickTab} className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-x-4 border-b">
        <TabsList className="h-auto gap-7 rounded-none bg-transparent p-0">
          {tabDefs.map(([value, label, count]) => {
            const warn = value === 'operations' && silentSources.length > 0;
            return <TabsTrigger key={value} value={value} className="group relative gap-2 rounded-none px-0 pb-3 pt-2.5 text-sm font-medium text-muted-foreground shadow-none after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full data-[state=active]:bg-transparent data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:shadow-none data-[state=active]:after:bg-primary dark:data-[state=active]:after:bg-emerald-500">
              {label}<span className={cn('inline-grid h-5 min-w-[22px] place-items-center rounded-full px-[7px] text-[11.5px] font-semibold', warn ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-300' : 'bg-muted text-muted-foreground group-data-[state=active]:bg-primary/10 group-data-[state=active]:text-primary dark:group-data-[state=active]:text-emerald-300')}>{count}</span>
            </TabsTrigger>;
          })}
        </TabsList>
        <span className="pb-3 text-xs text-muted-foreground">{tabNote}</span>
      </div>
      <TabsContent value="events" className="mt-0 space-y-3">
        <section aria-label="Tin nhận được" className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <DesktopFilterBar f={controls} resultText={resultText} />
          {list}
          {!events.isError && !events.isPending && pager}
        </section>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Info aria-hidden className="h-[13px] w-[13px] shrink-0" />{footnote}</p>
      </TabsContent>
      <TabsContent value="sources" className="mt-0">{sourcesBlock}</TabsContent>
      <TabsContent value="operations" className="mt-0"><OperationsPanel phone={false} status={summary} failed={status.isError} /></TabsContent>
    </Tabs>
    {dialogs}
  </main></MainLayout>;
}
