import { Check, KeyRound, Mail, Pause, Play, Plus, Smartphone, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { isGmailHeartbeat, type BankSource } from '@/lib/bank-events/service';
import { relativeTime, shortId, sourceState, vnStamp } from '@/lib/bank-events/view';
import { cn } from '@/lib/utils';
import { scheduleLabels } from './labels';
import { SourceBadge } from './parts';

const mono = 'font-numeric tabular-nums';
const SILENT_HELP = 'Hơn 30 phút chưa nhận tin từ script. Mở dự án Apps Script, xem mục Trình kích hoạt và Lần thực thi; nếu trống thì chạy lại hàm caiDat.';
const subtitle = (source: BankSource) => source.kind === 'gmail'
  ? (source.deviceId ? 'Gmail · script đã kết nối' : 'Gmail · đang chờ script chạy lần đầu')
  : source.deviceId ? `Thiết bị ${shortId(source.deviceId)}` : 'Đang chờ thiết bị kết nối';

export interface SourceActions { busy: boolean; onToggle: (source: BankSource) => void; onRotate: (source: BankSource) => void; onRevoke: (source: BankSource) => void }

function Ready({ ok, label, phone }: { ok: boolean; label: string; phone: boolean }) {
  const Icon = ok ? Check : X;
  return <span className={cn('inline-flex items-center gap-1', ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-300')}>
    <Icon aria-hidden className="h-[13px] w-[13px]" strokeWidth={2.5} />{label}{phone && ok ? '' : ` ${ok ? 'sẵn sàng' : 'chưa sẵn sàng'}`}
  </span>;
}

function Heartbeat({ source, phone }: { source: BankSource; phone: boolean }) {
  const beat = source.heartbeat;
  if (!beat) return null;
  if (isGmailHeartbeat(beat)) {
    const used = Math.round(beat.usedSecondsToday / 60);
    return <div className={cn('mt-3.5 bg-muted/60 text-xs text-muted-foreground', phone ? 'mt-3 rounded-[10px] px-2.5 py-2' : 'rounded-lg px-3 py-[9px]')}>
      <div className="flex justify-between gap-3"><span>Script {beat.appVersion} · quét {scheduleLabels[beat.schedule]}</span><span className="shrink-0 font-semibold text-foreground">{phone ? '' : 'Hôm nay dùng '}{used}/90 phút</span></div>
      <div aria-hidden className="mt-[7px] h-[5px] overflow-hidden rounded-full bg-border"><div className={cn('h-full rounded-full', used > 60 ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${Math.min(100, Math.round(used / 90 * 100))}%` }} /></div>
    </div>;
  }
  return <div className={cn('flex flex-wrap items-center bg-muted/60 text-xs text-muted-foreground', phone ? 'mt-3 gap-3 rounded-[10px] px-2.5 py-2' : 'mt-3.5 gap-4 rounded-lg px-3 py-[9px]')}>
    <span>App {beat.appVersion}</span>
    <Ready ok={beat.smsEnabled && beat.smsPermission} label="SMS" phone={phone} />
    <Ready ok={beat.notificationsEnabled && beat.notificationAccess} label="Thông báo" phone={phone} />
  </div>;
}

function SourceCard({ source, serverTime, actions, phone }: { source: BankSource; serverTime: string | undefined; actions: SourceActions; phone: boolean }) {
  const state = sourceState(source, serverTime), revoked = state === 'revoked', silent = state === 'silent';
  const Icon = source.kind === 'gmail' ? Mail : Smartphone;
  const icon = <span aria-hidden className={cn('grid h-10 w-10 shrink-0 place-items-center', phone ? 'rounded-[11px]' : 'rounded-[10px]', revoked ? 'bg-muted text-muted-foreground' : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400')}><Icon className="h-[19px] w-[19px]" /></span>;
  const warning = silent && <p role="status" className={cn('mt-2 border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-[18px] text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200', phone ? 'rounded-[10px]' : 'rounded-lg')}>{SILENT_HELP}</p>;
  const toggle = <Button variant="outline" size="sm" disabled={actions.busy} onClick={() => actions.onToggle(source)} className={phone ? 'h-[38px] rounded-[10px] px-1 text-[12.5px] font-semibold' : 'h-8 px-[11px] text-[12.5px]'}>
    {source.enabled ? <Pause className="mr-1.5 h-3.5 w-3.5" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}{source.enabled ? 'Tạm dừng' : 'Bật lại'}
  </Button>;
  const rotate = <Button variant="outline" size="sm" disabled={actions.busy} onClick={() => actions.onRotate(source)} className={phone ? 'h-[38px] rounded-[10px] px-1 text-[12.5px] font-semibold' : 'h-8 px-[11px] text-[12.5px]'}><KeyRound className="mr-1.5 h-3.5 w-3.5" />Cấp lại khóa</Button>;
  const revoke = <Button variant={phone ? 'outline' : 'ghost'} size="sm" disabled={actions.busy} onClick={() => actions.onRevoke(source)} className={cn('text-destructive hover:text-destructive', phone ? 'h-[38px] rounded-[10px] border-red-200 px-1 text-[12.5px] font-semibold dark:border-red-900' : 'h-8 px-[11px] text-[12.5px]')}>Thu hồi</Button>;
  const revokedText = `Đã thu hồi lúc ${vnStamp(source.revokedAt)} · ${phone ? 'tin đã nhận vẫn được giữ' : 'các tin đã nhận vẫn được giữ'}`;
  const org = source.organizationId ? 'Đã có mã công ty' : 'Chưa gắn công ty';

  if (phone) return <article className={cn('rounded-2xl border p-3.5 shadow-sm', silent && 'border-amber-300 dark:border-amber-800', revoked ? 'bg-muted/30' : 'bg-card')}>
    <div className="flex items-start gap-3">{icon}<div className="min-w-0 flex-1">
      <div className="flex items-center justify-between gap-2"><h3 className="truncate text-[15px] font-semibold">{source.name}</h3><SourceBadge state={state} compact /></div>
      <p className="mt-0.5 text-xs text-muted-foreground">{subtitle(source)}</p>
    </div></div>
    <Heartbeat source={source} phone />
    {warning}
    <dl className="mt-3 grid grid-cols-2 gap-2.5">
      <div><dt className="text-[11.5px] text-muted-foreground">Liên lạc gần nhất</dt><dd className={cn('mt-0.5 text-[13px] font-medium', silent && 'text-amber-700 dark:text-amber-300')}>{relativeTime(source.lastSeenAt, serverTime)}</dd></div>
      <div><dt className="text-[11.5px] text-muted-foreground">Tin gần nhất</dt><dd className="mt-0.5 text-[13px] font-medium">{relativeTime(source.lastEventAt, serverTime)}</dd></div>
    </dl>
    <p className="mt-2 text-[11.5px] text-muted-foreground">Khóa {source.credentialFingerprint ? <span className={cn(mono, 'break-all text-foreground/80')}>{source.credentialFingerprint}</span> : 'không còn hoạt động'} · {org}</p>
    {revoked ? <p className="mt-2.5 text-xs text-muted-foreground">{revokedText}</p> : <div className="mt-3 grid grid-cols-3 gap-1.5">{toggle}{rotate}{revoke}</div>}
  </article>;

  return <article className={cn('flex flex-col rounded-xl border px-5 py-[18px] shadow-sm', silent && 'border-amber-300 dark:border-amber-800', revoked ? 'bg-muted/30' : 'bg-card')}>
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">{icon}<div className="min-w-0"><h3 className="truncate text-[15px] font-semibold">{source.name}</h3><p className="mt-0.5 text-xs text-muted-foreground">{subtitle(source)}</p></div></div>
      <SourceBadge state={state} />
    </div>
    <Heartbeat source={source} phone={false} />
    {warning}
    <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
      <div><dt className="text-[11.5px] text-muted-foreground">Liên lạc gần nhất</dt><dd className={cn('mt-[3px] text-[13px] font-medium', silent && 'text-amber-700 dark:text-amber-300')}>{relativeTime(source.lastSeenAt, serverTime)}</dd>{source.lastSeenAt && <dd className={cn(mono, 'mt-px text-[11px] text-muted-foreground/80')}>{vnStamp(source.lastSeenAt)}</dd>}</div>
      <div><dt className="text-[11.5px] text-muted-foreground">Tin gần nhất</dt><dd className="mt-[3px] text-[13px] font-medium">{relativeTime(source.lastEventAt, serverTime)}</dd>{source.lastEventAt && <dd className={cn(mono, 'mt-px text-[11px] text-muted-foreground/80')}>{vnStamp(source.lastEventAt)}</dd>}</div>
      <div><dt className="text-[11.5px] text-muted-foreground">Dấu nhận diện khóa</dt><dd className={cn('mt-[3px]', source.credentialFingerprint ? cn(mono, 'break-all text-[11.5px]') : 'text-[13px] text-muted-foreground')}>{source.credentialFingerprint ?? 'Không còn khóa hoạt động'}</dd></div>
      <div><dt className="text-[11.5px] text-muted-foreground">Phạm vi dữ liệu</dt><dd className="mt-[3px] text-[13px]">{org}</dd></div>
    </dl>
    <div className="flex-1" />
    <div className="mt-4 flex items-center gap-2 border-t pt-3.5">
      {revoked ? <span className="text-[12.5px] text-muted-foreground">{revokedText}</span> : <>{toggle}{rotate}<div className="flex-1" />{revoke}</>}
    </div>
  </article>;
}

export function SourcesPanel({ phone, sources, serverTime, actions, onAdd }: { phone: boolean; sources: BankSource[]; serverTime: string | undefined; actions: SourceActions; onAdd: () => void }) {
  return <div className="space-y-4">
    {!phone && <div className="flex flex-wrap items-end justify-between gap-4">
      <div><h2 className="text-[17px] font-semibold">Điện thoại, Gmail và nguồn gửi</h2><p className="mt-1 text-[13px] text-muted-foreground">Mỗi nguồn có khóa riêng. Thiết bị hoặc script được gắn khi gửi tin hợp lệ đầu tiên.</p></div>
      <Button onClick={onAdd} disabled={actions.busy}><Plus className="mr-2 h-4 w-4" />Thêm nguồn</Button>
    </div>}
    <div className={phone ? 'flex flex-col gap-3' : 'grid gap-4 lg:grid-cols-2'}>
      {sources.map(source => <SourceCard key={source.id} source={source} serverTime={serverTime} actions={actions} phone={phone} />)}
    </div>
  </div>;
}
