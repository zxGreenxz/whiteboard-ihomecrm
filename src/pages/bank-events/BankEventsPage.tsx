import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowRight, Check, ChevronLeft, ChevronRight, Copy, Download, Inbox, KeyRound, Mail, Pause, Play, Plus, RefreshCw, Search, ShieldCheck, Smartphone, Wifi } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useBankEvents } from '@/hooks/bank-events/useBankEvents';
import MainLayout from '@/components/layout/MainLayout';
import { bankEventService, eventType, isGmailHeartbeat, type BankEvent, type BankSource, type BankSourceKind, type EventFilters } from '@/lib/bank-events/service';
import { GmailSetup } from './GmailSetup';

const eventLabels = { 'sms.received': 'SMS', 'notification.received': 'Thông báo app', 'email.received': 'Email', 'gateway.test': 'Tin thử' } as const;
const scheduleLabels = { 'day-1m': '1 phút/lần (ban ngày)', 'night-10m': '10 phút/lần (00:30–06:30)', 'saver-5m': '5 phút/lần (tiết kiệm hạn mức)' } as const;
const money = (value: number) => `${value < 0 ? '−' : ''}${new Intl.NumberFormat('vi-VN').format(Math.abs(value))} ₫`;
const time = (value: string | null | undefined) => value ? new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(value)) : 'Chưa ghi nhận';
const shortId = (value: string) => value.length > 18 ? `${value.slice(0, 9)}…${value.slice(-6)}` : value;
const selectClass = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm';
// APK release do CI ký trên main, đăng ở GitHub Release (repo public nên tải không cần đăng nhập). Bản mới: đăng release từ artifact ihome-bank-gateway-release-<sha> rồi đổi hằng này.
const gatewayApk = { version: '0.2.0', url: 'https://github.com/zxGreenxz/whiteboard-ihomecrm/releases/download/v0.2.0/app-release.apk' } as const;
type Secret = { actorId: string; name: string; token: string; kind: BankSourceKind; rotated: boolean };
type Detail = { actorId: string; event: BankEvent; payload: Record<string, unknown> };

function StateBlock({ loading, error, empty, retry, children }: { loading: boolean; error: boolean; empty: boolean; retry: () => void; children: React.ReactNode }) {
  if (error) return <div role="alert" className="rounded-xl border border-destructive/25 bg-destructive/5 p-6"><p className="font-medium">Chưa tải được dữ liệu</p><p className="mt-1 text-sm text-muted-foreground">Kiểm tra quyền truy cập và kết nối rồi thử lại.</p><Button variant="outline" size="sm" onClick={retry} className="mt-3">Thử lại</Button></div>;
  if (loading) return <div aria-label="Đang tải dữ liệu" className="space-y-3"><Skeleton className="h-24" /><Skeleton className="h-24" /></div>;
  if (empty) return <div className="rounded-xl border border-dashed bg-muted/20 px-6 py-14 text-center"><Inbox className="mx-auto mb-3 h-9 w-9 text-muted-foreground/60" /><p className="font-medium">Chưa có dữ liệu phù hợp</p><p className="mt-1 text-sm text-muted-foreground">Kết nối nguồn hoặc điều chỉnh bộ lọc để xem tin nhận được.</p></div>;
  return <>{children}</>;
}

function SummaryCell({ event }: { event: BankEvent }) {
  const summary = event.summary;
  if (summary && (summary.amount !== null || summary.description)) {
    const tone = summary.direction === 'in' ? 'text-emerald-700 dark:text-emerald-400' : summary.direction === 'out' ? 'text-red-600 dark:text-red-400' : '';
    const sign = summary.direction === 'in' ? '+' : summary.direction === 'out' ? '−' : '';
    const facts = [summary.bank, summary.account && `TK ${summary.account}`, summary.balance !== null && `Số dư ${money(summary.balance)}`].filter(Boolean).join(' · ');
    return <div className="min-w-0">
      <p className={`font-semibold tabular-nums ${tone}`}>{summary.amount === null ? 'Chưa tách được số tiền' : `${sign}${money(summary.amount)}`}</p>
      {summary.description && <p className="mt-0.5 line-clamp-2 break-words text-xs text-muted-foreground">{summary.description}</p>}
      {facts && <p className="mt-0.5 text-xs text-muted-foreground">{facts}</p>}
    </div>;
  }
  const text = event.summaryStatus === 'unavailable' ? 'Không giải mã được để tóm tắt'
    : event.eventType === 'gateway.test' ? 'Tin thử từ nguồn'
    : event.summaryStatus === 'unparsed' ? 'Không phải tin biến động số dư' : 'Chưa có tóm tắt';
  return <p className="text-sm text-muted-foreground">{text}</p>;
}

export default function BankEventsPage() {
  const [filters, setFilters] = useState<EventFilters>({ limit: 25 });
  const data = useBankEvents(filters);
  const { actorId, allowed, events, sources, status } = data;
  const [query, setQuery] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [kind, setKind] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [newKind, setNewKind] = useState<BankSourceKind>('android');
  const [secret, setSecret] = useState<Secret | null>(null);
  const [copied, setCopied] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const detailRequest = useRef(0);
  const [confirm, setConfirm] = useState<{ source: BankSource; action: 'rotate' | 'revoke' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { detailRequest.current++; setDetailLoading(false); setSecret(null); setDetail(null); setConfirm(null); setCreateOpen(false); setError(null); }, [actorId, allowed]);
  const reload = () => { void data.refresh(); };
  const sourceList = sources.isError ? [] : sources.data?.sources ?? [];
  const summary = status.isError ? undefined : status.data;
  // Script Gmail báo sống tối đa 10 phút/lần (đêm 10 phút/lượt): quá 30 phút theo đồng hồ máy chủ là đáng ngờ.
  const gmailSilent = (source: BankSource) => source.kind === 'gmail' && !!source.deviceId && source.enabled && !source.revokedAt && !!summary
    && (!source.lastSeenAt || Date.parse(summary.serverTime) - Date.parse(source.lastSeenAt) > 30 * 60_000);

  async function action(work: (id: string) => Promise<void>) {
    if (!actorId || !allowed || busy) return;
    setBusy(true); setError(null);
    try { await work(actorId); await data.refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Không hoàn tất thao tác. Vui lòng thử lại.'); }
    finally { setBusy(false); }
  }
  async function openDetail(event: BankEvent) {
    if (!actorId || !allowed || detailLoading) return;
    setDetail(null); setDetailLoading(true); setError(null);
    const request = ++detailRequest.current;
    try { const result = await bankEventService(actorId).detail(event.id); if (request === detailRequest.current) setDetail({ actorId, event: result.event, payload: result.payload }); }
    catch (failure) { if (request === detailRequest.current) setError(failure instanceof Error ? failure.message : 'Không đọc được nội dung tin.'); }
    finally { if (request === detailRequest.current) setDetailLoading(false); }
  }
  function applyFilters(event: React.FormEvent) {
    event.preventDefault(); setError(null);
    if (from && to && from > to) { setError('Ngày kết thúc phải bằng hoặc sau ngày bắt đầu.'); return; }
    if (new TextEncoder().encode(query.trim()).length > 120) { setError('Từ khóa quá dài. Hãy nhập một phần tên nguồn hoặc mã sự kiện.'); return; }
    const next: EventFilters = { limit: 25 };
    if (query.trim()) next.query = query.trim();
    if (sourceId) next.sourceId = sourceId;
    const type = eventType.safeParse(kind);
    if (type.success) next.eventType = type.data;
    if (from) next.from = new Date(`${from}T00:00:00+07:00`).toISOString();
    if (to) next.to = new Date(new Date(`${to}T00:00:00+07:00`).getTime() + 86_400_000).toISOString();
    setCursorHistory([]); setFilters(next);
  }
  const activeSecret = allowed && secret?.actorId === actorId ? secret : null;
  const activeDetail = allowed && detail?.actorId === actorId ? detail : null;
  if (!allowed) return null;

  return <MainLayout><main className="mx-auto w-full max-w-7xl space-y-6 p-4 pb-12 md:p-6 lg:p-8">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400"><Activity className="h-4 w-4" /> Trung tâm tiếp nhận</div><h1 className="text-2xl font-bold tracking-tight md:text-3xl">Biến động số dư</h1><p className="mt-2 max-w-2xl text-sm text-muted-foreground">Theo dõi tin từ điện thoại, Gmail và kiểm tra các nguồn kết nối tại một nơi.</p></div>
      <div className="flex flex-wrap gap-2"><Button variant="outline" asChild><a href={gatewayApk.url} target="_blank" rel="noopener noreferrer"><Download className="mr-2 h-4 w-4" />Tải app Android<span className="ml-1.5 text-xs text-muted-foreground">v{gatewayApk.version}</span></a></Button><Button variant="outline" onClick={reload} disabled={events.isFetching || sources.isFetching || status.isFetching}><RefreshCw className="mr-2 h-4 w-4" />Làm mới</Button></div>
    </header>
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-emerald-200/70 bg-emerald-50/70 px-4 py-3 text-sm dark:border-emerald-800 dark:bg-emerald-950/30"><ShieldCheck className="h-5 w-5 shrink-0 text-emerald-700 dark:text-emerald-400" /><p><strong>Toàn hệ thống · Chỉ super admin</strong><span className="ml-2 text-muted-foreground">Không giới hạn theo công ty đang chọn.</span></p></div>
    <section aria-label="Tổng quan tiếp nhận" className="grid gap-3 sm:grid-cols-3">
      {[{ label: 'Tin đã tiếp nhận', value: summary?.totalEvents.toLocaleString('vi-VN'), icon: Inbox }, { label: 'Nguồn đang bật', value: summary ? `${summary.enabledSources} / ${summary.totalSources}` : undefined, icon: Smartphone }, { label: 'Lần nhận gần nhất', value: summary ? time(summary.lastReceivedAt) : undefined, icon: Wifi }].map(item => <div key={item.label} className="rounded-xl border bg-card p-5"><div className="flex items-center justify-between text-sm text-muted-foreground"><span>{item.label}</span><item.icon className="h-4 w-4" /></div><div className="mt-3 text-xl font-semibold tracking-tight">{item.value ?? '—'}</div></div>)}
    </section>
    {status.isError && <p role="alert" className="text-sm text-destructive">Chưa tải được số liệu vận hành. Bấm Làm mới để thử lại.</p>}
    {error && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">{error}</div>}
    <Tabs defaultValue="events" className="space-y-5">
      <TabsList className="grid h-auto w-full grid-cols-3 p-1 md:w-fit"><TabsTrigger value="events" className="px-3 py-2">Tin nhận được</TabsTrigger><TabsTrigger value="sources" className="px-3 py-2">Nguồn kết nối</TabsTrigger><TabsTrigger value="operations" className="px-3 py-2">Vận hành</TabsTrigger></TabsList>
      <TabsContent value="events" className="space-y-4">
        <p className="text-xs text-muted-foreground">Tự cập nhật mỗi 15 giây ở trang đầu.</p>
        <form onSubmit={applyFilters} className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:grid-cols-6">
          <div className="sm:col-span-2"><Label htmlFor="bank-query">Tìm theo thông tin nguồn</Label><div className="relative mt-1.5"><Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input id="bank-query" className="pl-9" placeholder="Tên nguồn hoặc mã sự kiện" value={query} onChange={event => setQuery(event.target.value)} maxLength={120} /></div></div>
          <div><Label htmlFor="bank-source">Nguồn</Label><select id="bank-source" className={`${selectClass} mt-1.5`} value={sourceId} onChange={event => setSourceId(event.target.value)}><option value="">Tất cả nguồn</option>{sourceList.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}</select></div>
          <div><Label htmlFor="bank-kind">Loại tin</Label><select id="bank-kind" className={`${selectClass} mt-1.5`} value={kind} onChange={event => setKind(event.target.value)}><option value="">Tất cả loại</option>{Object.entries(eventLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
          <div><Label htmlFor="bank-from">Từ ngày</Label><Input id="bank-from" className="mt-1.5" type="date" value={from} onChange={event => setFrom(event.target.value)} /></div>
          <div><Label htmlFor="bank-to">Đến ngày</Label><Input id="bank-to" className="mt-1.5" type="date" value={to} onChange={event => setTo(event.target.value)} /></div>
          <div className="flex flex-wrap items-center justify-between gap-3 sm:col-span-2 lg:col-span-6"><p className="text-xs text-muted-foreground">Lọc theo thời điểm máy chủ nhận · giờ Việt Nam. Nội dung nguyên văn chỉ mở ở chi tiết.</p><Button size="sm" type="submit" disabled={events.isFetching}><Search className="mr-2 h-4 w-4" />Áp dụng bộ lọc</Button></div>
        </form>
        <StateBlock loading={events.isPending} error={events.isError} empty={!events.data?.events.length} retry={reload}>
          <div className="overflow-hidden rounded-xl border bg-card">
            <div className="hidden grid-cols-[1.2fr_1.8fr_1fr_2rem] gap-4 border-b bg-muted/30 px-5 py-3 text-xs font-medium uppercase tracking-wide text-muted-foreground md:grid"><span>Nguồn / loại tin</span><span>Biến động</span><span>Máy chủ nhận</span><span /></div>
            {events.data?.events.map(event => <button key={event.id} onClick={() => { void openDetail(event); }} disabled={detailLoading} className="grid w-full gap-3 border-b px-5 py-4 text-left transition-colors last:border-0 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:grid-cols-[1.2fr_1.8fr_1fr_2rem] md:items-center" aria-label={`Xem tin ${event.sourceName} ${shortId(event.externalId)}`}><div className="min-w-0"><p className="truncate font-medium">{event.sourceName}</p><div className="mt-1 flex flex-wrap items-center gap-2"><Badge variant="secondary">{eventLabels[event.eventType]}</Badge><span className="font-mono text-xs text-muted-foreground">{shortId(event.externalId)}</span></div></div><SummaryCell event={event} /><div className="text-sm text-muted-foreground"><p>{time(event.receivedAt)}</p><p className="mt-0.5 text-xs">{event.duplicateCount > 0 ? `${event.duplicateCount} lần gửi lặp` : 'Nhận lần đầu'}</p></div><ArrowRight className="hidden h-4 w-4 text-muted-foreground md:block" /></button>)}
          </div>
        </StateBlock>
        <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground"><span>Trang {cursorHistory.length + 1} · tối đa 25 tin</span><div className="flex gap-2"><Button variant="outline" size="sm" disabled={!cursorHistory.length || events.isFetching} onClick={() => { const previous = cursorHistory.at(-1); setCursorHistory(cursorHistory.slice(0, -1)); setFilters({ ...filters, cursor: previous }); }}><ChevronLeft className="mr-1 h-4 w-4" />Trước</Button><Button variant="outline" size="sm" disabled={!events.data?.nextCursor || events.isError || events.isFetching} onClick={() => { if (!events.data?.nextCursor) return; setCursorHistory([...cursorHistory, filters.cursor]); setFilters({ ...filters, cursor: events.data.nextCursor }); }}>Sau<ChevronRight className="ml-1 h-4 w-4" /></Button></div></div>
        <p className="text-xs text-muted-foreground">Số tiền và nội dung được tách tự động từ tin ngân hàng để tiện theo dõi; chưa dùng để tự xác nhận thanh toán hoặc ghi sổ.</p>
      </TabsContent>
      <TabsContent value="sources" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">Điện thoại, Gmail và nguồn gửi</h2><p className="mt-1 text-sm text-muted-foreground">Mỗi nguồn có khóa riêng. Thiết bị hoặc script được gắn khi gửi tin hợp lệ đầu tiên.</p></div><Button onClick={() => { setError(null); setName(''); setNewKind('android'); setCreateOpen(true); }} disabled={busy}><Plus className="mr-2 h-4 w-4" />Thêm nguồn</Button></div>
        <StateBlock loading={sources.isPending} error={sources.isError} empty={!sourceList.length} retry={reload}>
          <div className="grid gap-4 lg:grid-cols-2">{sourceList.map(source => <article key={source.id} className="rounded-xl border bg-card p-5"><div className="flex items-start justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><div className="rounded-xl bg-emerald-50 p-3 dark:bg-emerald-950">{source.kind === 'gmail' ? <Mail className="h-5 w-5 text-emerald-700 dark:text-emerald-400" /> : <Smartphone className="h-5 w-5 text-emerald-700 dark:text-emerald-400" />}</div><div className="min-w-0"><h3 className="truncate font-semibold">{source.name}</h3><p className="mt-1 text-xs text-muted-foreground">{source.kind === 'gmail' ? (source.deviceId ? 'Gmail · script đã kết nối' : 'Gmail · đang chờ script chạy lần đầu') : source.deviceId ? `Thiết bị ${shortId(source.deviceId)}` : 'Đang chờ thiết bị kết nối'}</p></div></div><Badge variant={source.revokedAt ? 'destructive' : source.enabled ? 'secondary' : 'outline'}>{source.revokedAt ? 'Đã thu hồi' : source.enabled ? 'Đang bật' : 'Tạm dừng'}</Badge></div><dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-xs text-muted-foreground">Liên lạc gần nhất</dt><dd className="mt-1">{time(source.lastSeenAt)}</dd></div><div><dt className="text-xs text-muted-foreground">Tin gần nhất</dt><dd className="mt-1">{time(source.lastEventAt)}</dd></div><div><dt className="text-xs text-muted-foreground">Dấu nhận diện khóa</dt><dd className="mt-1 font-mono text-xs">{source.credentialFingerprint ?? 'Không còn khóa hoạt động'}</dd></div><div><dt className="text-xs text-muted-foreground">Phạm vi dữ liệu</dt><dd className="mt-1">{source.organizationId ? 'Đã có mã công ty' : 'Chưa gắn công ty'}</dd></div></dl>{source.heartbeat && <p className="mt-4 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">{isGmailHeartbeat(source.heartbeat) ? `Script ${source.heartbeat.appVersion} · quét ${scheduleLabels[source.heartbeat.schedule]} · hôm nay dùng ${Math.round(source.heartbeat.usedSecondsToday / 60)}/90 phút` : `App ${source.heartbeat.appVersion} · SMS ${source.heartbeat.smsEnabled && source.heartbeat.smsPermission ? 'sẵn sàng' : 'chưa sẵn sàng'} · Thông báo ${source.heartbeat.notificationsEnabled && source.heartbeat.notificationAccess ? 'sẵn sàng' : 'chưa sẵn sàng'}`}</p>}{gmailSilent(source) && <p role="status" className="mt-2 rounded-lg border border-amber-300/70 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">Hơn 30 phút chưa nhận tin từ script. Mở dự án Apps Script, xem mục Trình kích hoạt và Lần thực thi; nếu trống thì chạy lại hàm caiDat.</p>}<div className="mt-5 flex flex-wrap gap-2 border-t pt-4"><Button variant="outline" size="sm" disabled={busy || !!source.revokedAt} onClick={() => { void action(async id => { await bankEventService(id).enabled(source.id, !source.enabled); }); }}>{source.enabled ? <Pause className="mr-2 h-3.5 w-3.5" /> : <Play className="mr-2 h-3.5 w-3.5" />}{source.enabled ? 'Tạm dừng' : 'Bật lại'}</Button><Button variant="outline" size="sm" disabled={busy || !!source.revokedAt} onClick={() => { setError(null); setConfirm({ source, action: 'rotate' }); }}><KeyRound className="mr-2 h-3.5 w-3.5" />Cấp lại khóa</Button><Button variant="ghost" size="sm" className="text-destructive" disabled={busy || !!source.revokedAt} onClick={() => { setError(null); setConfirm({ source, action: 'revoke' }); }}>Thu hồi</Button></div></article>)}</div>
        </StateBlock>
      </TabsContent>
      <TabsContent value="operations" className="space-y-4"><div className="grid gap-4 md:grid-cols-2"><article className="rounded-xl border bg-card p-6"><Activity className="mb-4 h-6 w-6 text-emerald-600" /><h2 className="text-lg font-semibold">Luồng tiếp nhận</h2><p className="mt-3 text-sm leading-6 text-muted-foreground">Điện thoại gửi SMS, thông báo được cấp quyền; script Gmail gửi email ngân hàng. Máy chủ xác thực nguồn, chống ghi trùng, mã hóa và tách số tiền để theo dõi.</p><dl className="mt-5 space-y-3 text-sm"><div><dt className="text-muted-foreground">Đồng hồ máy chủ</dt><dd className="mt-1">{summary ? time(summary.serverTime) : 'Chưa tải được'}</dd></div><div><dt className="text-muted-foreground">Địa chỉ nhận</dt><dd className="mt-1 break-all font-mono text-xs">{summary?.ingestUrl ?? 'Chưa có địa chỉ nhận được xác nhận'}</dd></div></dl></article><article className="rounded-xl border bg-card p-6"><Mail className="mb-4 h-6 w-6 text-emerald-600" /><h2 className="text-lg font-semibold">Kết nối Gmail</h2><p className="mt-3 text-sm leading-6 text-muted-foreground">Thêm nguồn loại Gmail rồi dán script vào Apps Script của tài khoản nhận email ngân hàng. Script chạy trên máy chủ Google bằng quyền của bạn; CRM không giữ mật khẩu Gmail.</p><ul className="mt-3 list-disc space-y-1 pl-5 text-sm leading-6 text-muted-foreground"><li>Lấy email từ các ngân hàng và email có nhãn bạn chọn.</li><li>Ban ngày quét 1 phút/lần; 00:30–06:30 quét 10 phút/lần.</li><li>Google cho 90 phút chạy mỗi ngày: dùng quá 60 phút thì tự giãn 5 phút/lần tới hết ngày.</li></ul></article></div><div className="rounded-xl border bg-muted/20 p-5 text-sm leading-6 text-muted-foreground"><strong className="text-foreground">Nội dung nguyên văn có thể chứa OTP và tin cá nhân.</strong> Chỉ super admin được xem trang tổng và mở chi tiết; danh sách chỉ hiện số tiền, số dư và nội dung đã tách. Không tự suy ra số dư hiện tại, không cộng các tin nhận được thành doanh thu. Android hoặc ứng dụng ngân hàng có thể ẩn một phần thông báo.</div></TabsContent>
    </Tabs>
    <Dialog open={createOpen} onOpenChange={open => { if (!busy) setCreateOpen(open); }}><DialogContent><DialogHeader><DialogTitle>Thêm nguồn kết nối</DialogTitle><DialogDescription>Chọn loại nguồn và đặt tên để nhận ra nơi gửi tin. Khóa mới chỉ hiện một lần sau khi tạo.</DialogDescription></DialogHeader>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<form onSubmit={event => { event.preventDefault(); void action(async id => { const result = await bankEventService(id).create(name.trim(), newKind); setCreateOpen(false); setSecret({ actorId: id, name: result.source.name, token: result.token, kind: result.source.kind, rotated: false }); setCopied(false); }); }} className="space-y-4"><fieldset><legend className="text-sm font-medium">Loại nguồn</legend><div className="mt-2 grid gap-2 sm:grid-cols-2">{(['android', 'gmail'] as const).map(option => <label key={option} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm ${newKind === option ? 'border-primary bg-primary/5' : ''}`}><input type="radio" name="source-kind" value={option} className="mt-1" checked={newKind === option} onChange={() => setNewKind(option)} /><span><span className="font-medium">{option === 'android' ? 'Điện thoại Android' : 'Gmail'}</span><span className="mt-0.5 block text-xs text-muted-foreground">{option === 'android' ? 'App iHome Gateway chuyển SMS và thông báo ngân hàng.' : 'Script trong Gmail của bạn chuyển email ngân hàng.'}</span></span></label>)}</div></fieldset><div><Label htmlFor="source-name">Tên nguồn</Label><Input id="source-name" autoFocus className="mt-2" value={name} onChange={event => setName(event.target.value)} placeholder={newKind === 'gmail' ? 'Gmail nhận báo ngân hàng' : 'Điện thoại kế toán'} maxLength={100} required /></div><Button type="submit" className="w-full" disabled={busy || !name.trim()}>{busy ? 'Đang tạo…' : 'Tạo nguồn và cấp khóa'}</Button></form></DialogContent></Dialog>
    <Dialog open={!!confirm} onOpenChange={open => { if (!open && !busy) setConfirm(null); }}><DialogContent><DialogHeader><DialogTitle>{confirm?.action === 'rotate' ? 'Cấp lại khóa kết nối?' : 'Thu hồi nguồn kết nối?'}</DialogTitle><DialogDescription>{confirm?.action === 'rotate' ? (confirm.source.kind === 'gmail' ? 'Khóa cũ ngừng hoạt động ngay. Sau đó dán script mới thay toàn bộ script cũ trong Apps Script rồi chạy lại hàm caiDat; email chưa gửi sẽ được gửi bù.' : 'Trước khi cấp lại, hãy mở iHome Gateway và gửi hết tin đang chờ. Khóa cũ ngừng hoạt động ngay; tin còn gắn với khóa cũ sẽ không gửi được bằng khóa mới. Sau đó cập nhật khóa mới trên điện thoại.') : 'Nguồn này sẽ ngừng nhận dữ liệu và không thể bật lại. Các tin đã nhận vẫn được giữ.'}</DialogDescription></DialogHeader><p className="font-medium">{confirm?.source.name}</p>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setConfirm(null)} disabled={busy}>Hủy</Button><Button variant={confirm?.action === 'revoke' ? 'destructive' : 'default'} disabled={busy} onClick={() => { const pending = confirm; if (!pending) return; void action(async id => { if (pending.action === 'rotate') { const result = await bankEventService(id).rotate(pending.source.id); setSecret({ actorId: id, name: result.source.name, token: result.token, kind: result.source.kind, rotated: true }); setCopied(false); } else await bankEventService(id).revoke(pending.source.id); setConfirm(null); }); }}>{busy ? 'Đang xử lý…' : confirm?.action === 'rotate' ? 'Cấp lại khóa' : 'Thu hồi nguồn'}</Button></div></DialogContent></Dialog>
    <Dialog open={!!activeSecret} onOpenChange={open => { if (!open) { setSecret(null); setCopied(false); } }}><DialogContent className={activeSecret?.kind === 'gmail' ? 'max-h-[90dvh] overflow-y-auto sm:max-w-2xl' : undefined}>{activeSecret?.kind === 'gmail' ? <GmailSetup key={activeSecret.token} name={activeSecret.name} token={activeSecret.token} rotated={activeSecret.rotated} ingestUrl={summary?.ingestUrl ?? null} onClose={() => setSecret(null)} /> : <><DialogHeader><DialogTitle>Khóa kết nối · {activeSecret?.name}</DialogTitle><DialogDescription>Chỉ hiển thị lần này. Sao chép vào iHome Gateway trên điện thoại trước khi đóng.</DialogDescription></DialogHeader><Label>Địa chỉ webhook</Label><p className="break-all rounded-md bg-muted p-3 font-mono text-xs">{summary?.ingestUrl ?? 'Chưa cấu hình địa chỉ nhận. Kiểm tra tab Vận hành.'}</p><Label htmlFor="source-token">Khóa xác thực</Label><Input id="source-token" readOnly autoComplete="off" value={activeSecret?.token ?? ''} className="font-mono text-xs" /><Button onClick={() => { if (activeSecret) void navigator.clipboard.writeText(activeSecret.token).then(() => setCopied(true)).catch(() => setError('Không truy cập được clipboard. Hãy chọn và sao chép khóa trực tiếp.')); }}>{copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}{copied ? 'Đã sao chép khóa' : 'Sao chép khóa'}</Button><Button variant="outline" onClick={() => setSecret(null)}>Tôi đã lưu khóa · Đóng</Button></>}</DialogContent></Dialog>
    <Dialog open={!!activeDetail || detailLoading} onOpenChange={open => { if (!open) { detailRequest.current++; setDetailLoading(false); setDetail(null); } }}><DialogContent className="max-h-[88dvh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>Chi tiết tin nhận được</DialogTitle><DialogDescription>Nội dung nguyên văn chỉ được tải khi mở chi tiết. Có thể chứa OTP hoặc thông tin cá nhân.</DialogDescription></DialogHeader>{detailLoading ? <Skeleton className="h-48" /> : activeDetail && <><dl className="grid gap-4 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">Nguồn</dt><dd className="mt-1 font-medium">{activeDetail.event.sourceName}</dd></div><div><dt className="text-muted-foreground">Loại</dt><dd className="mt-1">{eventLabels[activeDetail.event.eventType]}</dd></div><div><dt className="text-muted-foreground">Thời điểm trên điện thoại</dt><dd className="mt-1">{time(activeDetail.event.occurredAt)}</dd></div><div><dt className="text-muted-foreground">Máy chủ nhận</dt><dd className="mt-1">{time(activeDetail.event.receivedAt)}</dd></div><div className="sm:col-span-2"><dt className="text-muted-foreground">Mã sự kiện</dt><dd className="mt-1 break-all font-mono text-xs">{activeDetail.event.externalId}</dd></div></dl><div className="rounded-lg border bg-muted/30 p-4"><p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Nội dung nguyên văn</p><pre className="whitespace-pre-wrap break-all font-mono text-xs leading-6">{JSON.stringify(activeDetail.payload, null, 2)}</pre></div></>}</DialogContent></Dialog>
  </main></MainLayout>;
}
