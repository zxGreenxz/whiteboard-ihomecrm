import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { HermesCallerScope } from './connectionClient';
import { createHermesReconcileClient, HermesReconcileError, type HermesReconcileInput, type HermesReconcileSnapshot,
  type HermesUnknownDelivery } from './deliveryReconcileClient';

interface Props { userId: string; organizationId: string; currentScope: () => HermesCallerScope }
type Decision = 'sent' | 'not_sent';
interface State {
  opened: boolean; busy: boolean; snapshot: HermesReconcileSnapshot | null; message: string | null;
  selected: { item: HermesUnknownDelivery; decision: Decision } | null;
  // A write whose reply was lost. It may be repeated only with the same ID.
  pending: HermesReconcileInput | null;
}
const initial = (): State => ({ opened: false, busy: false, snapshot: null, message: null, selected: null, pending: null });
const origins: Record<HermesUnknownDelivery['origin'], string> = {
  automation: 'Tự động hóa phòng trống', hermes_schedule: 'Lịch Hermes', hermes_connector: 'Hermes gửi nhóm',
  hermes_private_command: 'Hermes gửi nhóm theo lệnh riêng', private_reply: 'Trả lời riêng của Hermes',
};
const decisions: Record<Decision, string> = { sent: 'đã tới nơi', not_sent: 'chưa tới nơi' };
const time = (value: string | null) => value ? new Date(value).toLocaleString('vi-VN') : 'chưa ghi nhận';
function readMessage(error: unknown) {
  if (error instanceof HermesReconcileError) {
    if (error.code === 'forbidden') return 'Bạn chưa có quyền xem đối soát tin Zalo trong công ty này.';
    if (error.code === 'reauthentication_required') return 'Phiên CRM cần được xác minh lại. Hãy đăng nhập lại.';
    if (error.code === 'context_changed') return 'Tài khoản hoặc công ty đã thay đổi. Tải lại trang trước khi tiếp tục.';
  }
  return 'Chưa đọc được danh sách đối soát. Tải lại khi dịch vụ sẵn sàng.';
}
function writeMessage(error: unknown) {
  if (error instanceof HermesReconcileError) {
    if (error.outcomeUnknown) return 'Chưa rõ máy chủ đã ghi nhận xác nhận này chưa. Ghi lại với cùng mã hoặc tải lại danh sách để đối chiếu; không có tin nào được gửi lại.';
    if (error.code === 'forbidden') return 'Bạn không còn quyền ghi nhận tin này.';
    if (error.code === 'conflict') return 'Tin này đã được ghi nhận hoặc không còn ở trạng thái chưa rõ. Danh sách đã được tải lại.';
    if (error.code === 'invalid_request') return 'Ghi chú chưa hợp lệ. Nhập tối đa 500 ký tự, không để trống.';
    if (error.code === 'reauthentication_required') return 'Phiên CRM cần được xác minh lại. Hãy đăng nhập lại.';
  }
  return 'Chưa ghi nhận được. Tải lại danh sách khi dịch vụ sẵn sàng.';
}

/** CRM-side human attestation for UNKNOWN_EFFECT deliveries. Visibility of a
 * row is decided by SQL with the caller JWT; this component never resends. */
export function HermesDeliveryReconcile({ userId, organizationId, currentScope }: Props) {
  const client = useMemo(() => createHermesReconcileClient({ userId, organizationId, currentScope }), [userId, organizationId, currentScope]);
  const [state, setState] = useState<State>(initial);
  const [note, setNote] = useState(''), [checked, setChecked] = useState(false);
  const life = useRef({ alive: false, generation: 0, controller: null as AbortController | null });
  useLayoutEffect(() => {
    const current = life.current; current.alive = true; current.generation++;
    return () => { current.alive = false; current.generation++; current.controller?.abort(); current.controller = null; };
  }, []);
  async function run<T>(work: (signal: AbortSignal) => Promise<T>, done: (result: T, previous: State) => State, failed: (error: unknown, previous: State) => State) {
    const current = life.current, scope = { ...currentScope() }, generation = current.generation;
    if (!current.alive || current.controller || scope.userId !== userId || scope.organizationId !== organizationId) return;
    const controller = new AbortController(); current.controller = controller;
    const valid = () => {
      const now = currentScope();
      return current.alive && current.generation === generation && !controller.signal.aborted && now.userId === userId &&
        now.organizationId === organizationId && now.generation === scope.generation;
    };
    setState(previous => ({ ...previous, opened: true, busy: true }));
    try {
      const result = await work(controller.signal);
      if (valid()) setState(previous => done(result, { ...previous, busy: false }));
    } catch (error) {
      if (valid()) setState(previous => failed(error, { ...previous, busy: false }));
    } finally { if (current.controller === controller) current.controller = null; }
  }
  const load = (message: string | null = null) => run(signal => client.list({ signal }),
    (snapshot, previous) => ({ ...previous, snapshot, message: message ?? previous.message,
      selected: previous.selected && snapshot.items.some(item => item.id === previous.selected?.item.id) ? previous.selected : null }),
    (error, previous) => ({ ...previous, snapshot: null, selected: null, message: readMessage(error) }));
  function reload() { setState(previous => ({ ...previous, message: null })); void load(); }
  function choose(item: HermesUnknownDelivery, decision: Decision) {
    if (state.busy || state.pending) return;
    setNote(''); setChecked(false);
    setState(previous => ({ ...previous, selected: { item, decision }, message: null }));
  }
  function submit(input: HermesReconcileInput) {
    void run(signal => client.resolve(input, { signal }),
      (result, previous) => ({ ...previous, pending: null, selected: null,
        message: `Đã ghi nhận: tin ${decisions[result.decision]}. ${result.decision === 'not_sent' ? 'Hệ thống không tự gửi lại; muốn gửi, hãy tạo lệnh mới.' : ''}`.trim() }),
      (error, previous) => ({ ...previous, pending: error instanceof HermesReconcileError && error.outcomeUnknown ? input : null,
        selected: error instanceof HermesReconcileError && error.outcomeUnknown ? previous.selected : null, message: writeMessage(error) }))
      .then(() => {
        const current = life.current;
        if (current.alive && !current.controller) void load();
      });
  }
  function confirm() {
    const selected = state.selected, text = note.trim() ? note : '';
    if (!selected || !checked || !text || text.length > 500 || state.busy || state.pending) return;
    submit({ requestId: crypto.randomUUID(), kind: selected.item.kind, targetId: selected.item.id, decision: selected.decision, note: text });
  }
  const items = state.snapshot?.items ?? [];
  return <section aria-label="Đối soát tin chưa rõ kết quả" className="space-y-4 rounded-xl border bg-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">Tin Zalo chưa rõ đã gửi chưa</h2>
      <Button variant="outline" disabled={state.busy} onClick={reload}><RefreshCw className="h-4 w-4" />{state.opened ? 'Tải lại danh sách đối soát' : 'Kiểm tra tin chưa rõ kết quả'}</Button></div>
    <p className="text-sm text-muted-foreground">Đôi khi Hermes gửi tin rồi mất phản hồi, nên CRM không biết tin đã tới Zalo chưa và không tự gửi lại. Hãy xem trực tiếp trên Zalo rồi ghi nhận tại đây. Ghi nhận không gửi lại tin; muốn gửi lại, hãy tạo lệnh gửi mới.</p>
    {state.busy && <p role="status" className="text-sm">Đang kiểm tra với máy chủ…</p>}
    {state.message && <p role="status" className="rounded-lg bg-muted p-3 text-sm">{state.message}</p>}
    {state.pending && <div className="flex flex-wrap gap-2">
      <Button disabled={state.busy} onClick={() => state.pending && submit(state.pending)}>Ghi lại với cùng mã</Button>
      <Button variant="outline" disabled={state.busy} onClick={() => { setState(previous => ({ ...previous, pending: null, selected: null })); void load(); }}>Bỏ qua và tải lại</Button>
    </div>}
    {state.snapshot && !items.length && <p className="text-sm text-muted-foreground">Không có tin nào đang chờ đối soát.</p>}
    {items.map(item => <article key={item.id} aria-label={`Tin chưa rõ: ${origins[item.origin]}${item.conversationName ? ` · ${item.conversationName}` : ''}`}
      className="space-y-2 rounded-lg border p-3 text-sm">
      <p className="font-medium">{origins[item.origin]}{item.conversationName ? ` · ${item.conversationName}` : ''}</p>
      <p className="text-muted-foreground">Tạo lúc {time(item.createdAt)} · kết thúc {time(item.processedAt)}{item.errorCode ? ` · mã ${item.errorCode}` : ''}</p>
      {item.preview && <p className="whitespace-pre-wrap break-words rounded bg-muted/50 p-2">{item.preview}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={state.busy || !!state.pending} onClick={() => choose(item, 'sent')}>Đã tới nơi</Button>
        <Button size="sm" variant="outline" disabled={state.busy || !!state.pending} onClick={() => choose(item, 'not_sent')}>Chưa tới nơi</Button>
      </div>
    </article>)}
    {state.selected && <div aria-label="Xác nhận đối soát" className="space-y-3 rounded-lg border p-3">
      <h3 className="font-medium">Ghi nhận tin {decisions[state.selected.decision]}</h3>
      <Label htmlFor="hermes-reconcile-note">Ghi chú kiểm tra</Label>
      <Textarea id="hermes-reconcile-note" value={note} maxLength={500} disabled={state.busy || !!state.pending}
        onChange={event => setNote(event.target.value)} placeholder="Ví dụ: đã xem nhóm Zalo lúc 9 giờ, thấy/không thấy tin" />
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={checked} disabled={state.busy || !!state.pending}
        onChange={event => setChecked(event.target.checked)} />Tôi đã kiểm tra trực tiếp trên Zalo và hiểu ghi nhận này không gửi lại tin.</label>
      <div className="flex flex-wrap gap-2">
        <Button disabled={!checked || !note.trim() || state.busy || !!state.pending} onClick={confirm}>Ghi nhận</Button>
        <Button variant="outline" disabled={state.busy || !!state.pending} onClick={() => setState(previous => ({ ...previous, selected: null }))}>Hủy</Button>
      </div>
    </div>}
    {!!state.snapshot?.recent.length && <div aria-label="Ghi nhận gần đây" className="space-y-1 text-sm">
      <h3 className="font-medium">Ghi nhận gần đây</h3>
      {state.snapshot.recent.map(entry => <p key={entry.id} className="break-words text-muted-foreground">
        {time(entry.createdAt)} · {entry.decision === 'sent' ? 'Đã tới nơi' : 'Chưa tới nơi'} · {entry.via === 'hermes_connector' ? 'qua Hermes' : 'trong CRM'}{entry.mine ? '' : ' · người khác'}: {entry.note}</p>)}
    </div>}
  </section>;
}
