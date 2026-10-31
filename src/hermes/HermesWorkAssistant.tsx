import { useMemo, useState, type ReactNode } from 'react';
import { ClipboardList, NotebookPen, RefreshCw } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import type { HermesCallerScope } from './connectionClient';
import {
  useHermesWorkAssistant, type WorkAction, type WorkFailure, type WorkFollowFilter, type WorkMemoryData, type WorkSection, type WorkFollowsData,
} from './useHermesWorkAssistant';
import {
  createHermesWorkAssistantClient, hermesWorkMemoryContent, type HermesTaskFollowItem, type HermesWorkMemoryItem,
  type HermesWorkMemorySettings, type HermesWorkMemorySharing,
} from './workAssistantClient';

interface Props {
  userId: string; organizationId: string; currentScope: () => HermesCallerScope;
  /** Dành cho component đối soát UNKNOWN_EFFECT `HermesDeliveryReconcile` (do phần việc khác làm). */
  reconcileSlot?: ReactNode;
}

const sharingLabels: Record<HermesWorkMemorySharing, string> = {
  owner: 'Chỉ mình tôi',
  superadmin: 'Superadmin của công ty',
  managers: 'Quản lý có quyền xem người dùng (gồm superadmin)',
};
const jobStatusLabels = { IN_PROGRESS: 'Đang làm', COMPLETED: 'Hoàn thành', DELETED: 'Đã xoá', UNKNOWN: 'Không còn quyền xem trạng thái việc' } as const;
const followStateLabels = { active: 'Đang theo dõi', done: 'Đã xong', cancelled: 'Đã dừng', revoked: 'Đã thu hồi (mất quyền/thành viên)' } as const;
const closeReasonLabels = {
  stopped: 'người giao dừng theo dõi', job_cancelled: 'việc đã bị huỷ', job_deleted: 'việc đã bị xoá', completed: 'việc đã hoàn thành',
  permission_lost: 'mất quyền theo dõi', membership_lost: 'không còn trong công ty',
} as const;

const formatTime = (value: string) => new Date(value).toLocaleString('vi-VN');

/** Lỗi quyền, dữ liệu sai, xung đột phiên bản và kết quả chưa rõ phải khác nhau, không bao giờ biến thành "trống". */
function messageFor(failure: WorkFailure, write: boolean): string {
  if (failure.outcomeUnknown) return 'Kết quả chưa xác định — tải lại để đối chiếu trước khi thao tác tiếp. Thao tác không được tự gửi lại.';
  switch (failure.code) {
    case 'forbidden': return 'Bạn chưa có quyền thực hiện thao tác này trong công ty này.';
    case 'invalid_request': return 'Dữ liệu chưa hợp lệ. Kiểm tra lại nội dung rồi thử lại.';
    case 'context_changed': return 'Dữ liệu đã thay đổi (hoặc tài khoản/công ty đã đổi). Đã tải lại — hãy kiểm tra rồi thử lại.';
    case 'reauthentication_required': return 'Phiên CRM cần được xác minh lại. Hãy đăng nhập lại.';
    case 'not_supported': return 'Máy chủ chưa hỗ trợ tính năng này.';
    default: return write ? 'Chưa gửi được thao tác tới máy chủ. Có thể thử lại.' : 'Chưa đọc được dữ liệu từ máy chủ. Tải lại khi dịch vụ sẵn sàng.';
  }
}

function Loading({ label }: { label: string }) {
  return <div role="status" aria-label={label} className="space-y-2"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>;
}
function LoadError({ failure, onRetry }: { failure: WorkFailure; onRetry: () => void }) {
  return <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
    <span>{messageFor(failure, false)}</span>
    <Button variant="outline" size="sm" onClick={onRetry}><RefreshCw className="h-4 w-4" />Tải lại</Button>
  </div>;
}
function ActionMessage({ action }: { action: WorkAction }) {
  if (action.error) return <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">{messageFor(action.error, true)}</p>;
  if (action.busy) return <p role="status" className="text-sm text-muted-foreground">Đang chờ máy chủ xác nhận…</p>;
  return action.notice ? <p role="status" className="rounded-lg border bg-muted/50 p-3 text-sm">{action.notice}</p> : null;
}

function SettingsForm({ settings, busy, onSave }: { settings: HermesWorkMemorySettings; busy: boolean;
  onSave: (value: { enabled: boolean; sharing: HermesWorkMemorySharing; retentionDays: number }) => void }) {
  const [enabled, setEnabled] = useState(settings.enabled), [sharing, setSharing] = useState(settings.sharing);
  const [days, setDays] = useState(String(settings.retentionDays));
  const parsed = /^\d{1,3}$/.test(days) ? Number(days) : NaN;
  const validDays = Number.isInteger(parsed) && parsed >= 1 && parsed <= 365;
  const changed = enabled !== settings.enabled || sharing !== settings.sharing || parsed !== settings.retentionDays;
  return <form aria-label="Cài đặt ghi nhớ công việc" className="space-y-4 rounded-lg border p-3"
    onSubmit={event => { event.preventDefault(); if (validDays && changed && !busy) onSave({ enabled, sharing, retentionDays: parsed }); }}>
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor="work-memory-enabled">Cho phép lưu ghi nhớ công việc vào CRM</Label>
      <Switch id="work-memory-enabled" checked={enabled} disabled={busy} onCheckedChange={setEnabled} />
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1">
        <Label htmlFor="work-memory-sharing">Ai được xem ghi nhớ của tôi</Label>
        <Select value={sharing} disabled={busy} onValueChange={value => setSharing(value as HermesWorkMemorySharing)}>
          <SelectTrigger id="work-memory-sharing"><SelectValue /></SelectTrigger>
          <SelectContent>{(Object.keys(sharingLabels) as HermesWorkMemorySharing[]).map(key => <SelectItem key={key} value={key}>{sharingLabels[key]}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="work-memory-days">Số ngày lưu (1–365)</Label>
        <Input id="work-memory-days" inputMode="numeric" value={days} disabled={busy} maxLength={3} aria-invalid={!validDays}
          onChange={event => setDays(event.target.value)} />
        {!validDays && <p className="text-xs text-destructive">Nhập số nguyên từ 1 đến 365.</p>}
      </div>
    </div>
    <Button type="submit" disabled={busy || !validDays || !changed}>Lưu cài đặt</Button>
  </form>;
}

function MemoryItemRow({ item, enabled, busy, onEdit, onForget }: { item: HermesWorkMemoryItem; enabled: boolean; busy: boolean;
  onEdit: (item: HermesWorkMemoryItem, content: string) => Promise<WorkFailure | null>; onForget: (item: HermesWorkMemoryItem) => void }) {
  const [draft, setDraft] = useState<{ version: number; content: string } | null>(null);
  const check = draft ? hermesWorkMemoryContent.safeParse(draft.content) : null;
  const save = async () => {
    if (!draft || !check?.success || draft.content === item.content) return;
    const failure = await onEdit({ ...item, version: draft.version }, draft.content);
    if (!failure || failure.code === 'context_changed' || failure.outcomeUnknown) setDraft(null);
  };
  return <article aria-label={`Ghi chú ${item.key}`} className="space-y-2 rounded-lg border p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <code className="break-all text-sm font-medium">{item.key}</code>
      <div className="flex gap-2">
        {!draft && <Button variant="outline" size="sm" disabled={busy || !enabled} aria-label={`Sửa ghi chú ${item.key}`}
          onClick={() => setDraft({ version: item.version, content: item.content })}>Sửa</Button>}
        <AlertDialog>
          <AlertDialogTrigger asChild><Button variant="destructive" size="sm" disabled={busy} aria-label={`Quên ghi chú ${item.key}`}>Quên</Button></AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Quên ghi chú “{item.key}”?</AlertDialogTitle>
              <AlertDialogDescription>CRM sẽ không còn trả ghi chú này cho trợ lý. Nếu Hermes đã nhận và lưu bản sao ở ngoài CRM, CRM không xoá được bản đó. Bản ghi kiểm toán của thao tác vẫn được giữ.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Giữ lại</AlertDialogCancel>
              <AlertDialogAction onClick={() => onForget(item)}>Quên ghi chú này</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
    {draft ? <div className="space-y-2">
      <Textarea aria-label={`Nội dung ghi chú ${item.key}`} value={draft.content} maxLength={1000} rows={3} disabled={busy}
        onChange={event => setDraft({ ...draft, content: event.target.value })} />
      {check && !check.success && <p className="text-xs text-destructive">Nội dung 1–1000 ký tự, một dòng, không có ký tự điều khiển.</p>}
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || !check?.success || draft.content === item.content} onClick={() => void save()}>Lưu ghi chú</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setDraft(null)}>Hủy</Button>
      </div>
    </div> : <p className="whitespace-pre-wrap break-words text-sm">{item.content}</p>}
    <p className="text-xs text-muted-foreground">Nguồn: {item.source.label} (Hermes bên ngoài) · Cập nhật {formatTime(item.updatedAt)} · Hết hạn {formatTime(item.expiresAt)}</p>
  </article>;
}

function MemoryCard({ section, action, busy, onReload, onMore, onSave, onEdit, onForget }: {
  section: WorkSection<WorkMemoryData>; action: WorkAction; busy: boolean; onReload: () => void; onMore: () => void;
  onSave: (value: { enabled: boolean; sharing: HermesWorkMemorySharing; retentionDays: number }) => void;
  onEdit: (item: HermesWorkMemoryItem, content: string) => Promise<WorkFailure | null>; onForget: (item: HermesWorkMemoryItem) => void;
}) {
  const data = section.data;
  return <Card aria-label="Ghi nhớ công việc CRM">
    <CardHeader>
      <CardTitle className="flex items-center gap-2 text-base"><NotebookPen className="h-5 w-5" />Ghi nhớ công việc CRM</CardTitle>
      <CardDescription>
        Ghi nhớ cá nhân, lịch sử trò chuyện và công cụ riêng của Hermes do bạn quản lý ngoài CRM; CRM không đọc và không giới hạn phần đó.
        Ở đây chỉ là các ghi chú công việc bạn chọn chia sẻ vào CRM. Quên hoặc thu hồi ghi chú sẽ chặn việc truy hồi từ CRM,
        nhưng không xoá được bản đã chuyển tới Hermes.
      </CardDescription>
    </CardHeader>
    <CardContent className="space-y-3">
      <ActionMessage action={action} />
      {section.status === 'loading' && !data && <Loading label="Đang tải ghi nhớ công việc" />}
      {section.status === 'error' && <LoadError failure={section.error ?? { code: 'backend_unavailable', outcomeUnknown: false }} onRetry={onReload} />}
      {data && <>
        <SettingsForm key={data.settings.accessVersion} settings={data.settings} busy={busy} onSave={onSave} />
        {!data.settings.enabled && <p className="text-sm text-muted-foreground">Đang tắt lưu ghi nhớ: không thể sửa ghi chú, nhưng bạn vẫn có thể quên ghi chú đã lưu.</p>}
        {data.items.length === 0 && section.status === 'ready' && <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">Chưa có ghi chú công việc nào được lưu vào CRM.</p>}
        {data.items.map(item => <MemoryItemRow key={`${item.id}:${item.version}`} item={item} enabled={data.settings.enabled} busy={busy} onEdit={onEdit} onForget={onForget} />)}
        {data.nextOffset !== null && <Button variant="outline" disabled={busy || section.loadingMore} onClick={onMore}>Xem thêm ghi chú</Button>}
        {section.loadingMore && <Loading label="Đang tải thêm ghi chú" />}
        <p className="text-xs text-muted-foreground">Tổng cộng {data.total} ghi chú.</p>
      </>}
    </CardContent>
  </Card>;
}

function FollowRow({ item, canStop, busy, onStop }: { item: HermesTaskFollowItem; canStop: boolean; busy: boolean; onStop: (item: HermesTaskFollowItem) => void }) {
  return <article aria-label={`Việc ${item.jobCode || item.id.slice(-8)}`} className="space-y-1 rounded-lg border p-3 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="min-w-0 break-words font-medium">{item.jobCode ? `${item.jobCode} · ` : ''}{item.jobTitle}</p>
      <div className="flex flex-wrap gap-1">
        <Badge variant="secondary">{jobStatusLabels[item.jobStatus]}</Badge>
        {item.overdue && <Badge variant="destructive">Quá hạn</Badge>}
        <Badge variant="outline">{followStateLabels[item.state]}</Badge>
      </div>
    </div>
    {item.objective && <p>Mục tiêu: {item.objective}</p>}
    <p className="text-muted-foreground">Người giao: {item.assignerName ?? 'Chưa rõ'} · Người thực hiện: {item.executorName ?? 'Chưa giao'}</p>
    <p className="text-muted-foreground">Hạn: {item.deadline ? formatTime(item.deadline) : 'Không có hạn'}
      {item.remindBeforeMinutes !== null && ` · Nhắc trước ${item.remindBeforeMinutes} phút`}
      {` · ${item.mode === 'self' ? 'Tự theo dõi' : 'Giám sát'}`}</p>
    {item.closeReason && <p className="text-muted-foreground">Đã đóng: {closeReasonLabels[item.closeReason]}{item.closedAt ? ` (${formatTime(item.closedAt)})` : ''}</p>}
    {canStop && <Button variant="outline" size="sm" disabled={busy} aria-label={`Dừng theo dõi ${item.jobCode || item.id.slice(-8)}`} onClick={() => onStop(item)}>Dừng theo dõi</Button>}
  </article>;
}

function FollowsCard({ section, filter, action, busy, onFilter, onReload, onMore, onStop }: {
  section: WorkSection<WorkFollowsData>; filter: WorkFollowFilter; action: WorkAction; busy: boolean; onFilter: (value: WorkFollowFilter) => void;
  onReload: () => void; onMore: () => void; onStop: (item: HermesTaskFollowItem) => void;
}) {
  const data = section.data;
  const choose = <V extends string>(label: string, value: V, current: V, set: (value: V) => void) =>
    <Button size="sm" variant={value === current ? 'default' : 'outline'} aria-pressed={value === current} disabled={busy} onClick={() => { if (value !== current) set(value); }}>{label}</Button>;
  return <Card aria-label="Việc trợ lý theo dõi">
    <CardHeader>
      <CardTitle className="flex items-center gap-2 text-base"><ClipboardList className="h-5 w-5" />Việc trợ lý theo dõi</CardTitle>
      <CardDescription>Hoàn thành việc làm trong CRM (ảnh, vị trí); trợ lý chỉ theo dõi và nhắc.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <div role="group" aria-label="Vai trò trong việc" className="flex gap-1">
          {choose('Tôi giao', 'assigned_by_me', filter.role, role => onFilter({ ...filter, role }))}
          {choose('Giao cho tôi', 'assigned_to_me', filter.role, role => onFilter({ ...filter, role }))}
        </div>
        <div role="group" aria-label="Trạng thái theo dõi" className="flex gap-1">
          {choose('Đang theo dõi', 'active', filter.state, state => onFilter({ ...filter, state }))}
          {choose('Đã đóng', 'closed', filter.state, state => onFilter({ ...filter, state }))}
        </div>
      </div>
      <ActionMessage action={action} />
      {section.status === 'loading' && !data && <Loading label="Đang tải việc theo dõi" />}
      {section.status === 'error' && <LoadError failure={section.error ?? { code: 'backend_unavailable', outcomeUnknown: false }} onRetry={onReload} />}
      {data && <>
        {data.items.length === 0 && section.status === 'ready' && <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">Không có việc nào trong mục này.</p>}
        {data.items.map(item => <FollowRow key={item.id} item={item} busy={busy} onStop={onStop}
          canStop={filter.role === 'assigned_by_me' && item.state === 'active'} />)}
        {data.nextOffset !== null && <Button variant="outline" disabled={busy || section.loadingMore} onClick={onMore}>Xem thêm việc</Button>}
        {section.loadingMore && <Loading label="Đang tải thêm việc" />}
      </>}
    </CardContent>
  </Card>;
}

function WorkAssistantPanel({ userId, organizationId, currentScope }: Omit<Props, 'reconcileSlot'>) {
  const client = useMemo(() => createHermesWorkAssistantClient({ userId, organizationId, currentScope }), [userId, organizationId, currentScope]);
  const model = useHermesWorkAssistant(client, userId, organizationId, currentScope);
  return <>
    <MemoryCard section={model.memory} action={model.memoryAction} busy={model.busy} onReload={() => void model.reloadMemory()} onMore={() => void model.moreMemory()}
      onSave={value => void model.saveSettings(value)} onEdit={model.editMemory} onForget={item => void model.forgetMemory(item)} />
    <FollowsCard section={model.follows} filter={model.filter} action={model.followAction} busy={model.busy} onFilter={model.setFilter}
      onReload={() => void model.reloadFollows()} onMore={() => void model.moreFollows()} onStop={item => void model.stopFollow(item)} />
  </>;
}

/** Trang cha gắn key theo tài khoản/công ty. Quyền do SQL theo JWT người dùng quyết định,
 * không phải việc UI hiển thị hay ẩn. Không có màn duyệt/PIN ở đây. Như các khối Hermes
 * khác trên trang, dữ liệu chỉ được đọc khi người dùng mở khối này. */
export function HermesWorkAssistant({ userId, organizationId, currentScope, reconcileSlot }: Props) {
  const [opened, setOpened] = useState(false);
  return <section aria-label="Trợ lý của tôi" className="space-y-4 rounded-xl border bg-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="font-semibold">Ghi nhớ và việc trợ lý theo dõi</h2>
        <p className="text-sm text-muted-foreground">Ghi chú công việc bạn cho Hermes nhớ, và các việc Hermes đang theo dõi, nhắc hạn.</p></div>
      <Button variant="outline" onClick={() => setOpened(value => !value)}>{opened ? 'Thu gọn' : 'Mở trợ lý của tôi'}</Button>
    </div>
    {opened && <WorkAssistantPanel userId={userId} organizationId={organizationId} currentScope={currentScope} />}
    {reconcileSlot}
  </section>;
}
