import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type { HermesCallerScope, HermesConnectionMetadata } from './connectionClient';
import { hermesConnectionNames, shortConnectionId } from './HermesSetupGuide';
import { createHermesZaloClient, HermesZaloClientError, type HermesZaloBinding, type HermesZaloBot,
  type HermesZaloChallenge, type HermesZaloStatus } from './zaloBindingClient';

/** Tóm tắt chỉ để trang vẽ tiến độ; không mang mã, UID hay quyền nào ra ngoài. */
export interface HermesZaloSummary {
  bots: number | null;
  stage: 'none' | 'code' | 'observed' | 'linked';
  provisioningState: HermesZaloBinding['provisioningState'] | null;
}
interface Props {
  userId: string; organizationId: string; currentScope: () => HermesCallerScope;
  connections: HermesConnectionMetadata[]; disabled: boolean;
  onSummary?: (summary: HermesZaloSummary) => void;
}
interface State {
  bots: HermesZaloBot[] | null; bindings: HermesZaloBinding[] | null;
  botCursor: string | null; bindingCursor: string | null;
  challenge: HermesZaloChallenge | null; observed: HermesZaloStatus | null;
  busy: boolean; blocked: boolean; message: string | null;
}
const initial = (): State => ({ bots: null, bindings: null, botCursor: null, bindingCursor: null,
  challenge: null, observed: null, busy: false, blocked: false, message: null });

function mergeBindings(previous: HermesZaloBinding[], incoming: HermesZaloBinding[]) {
  // A confirmed link may already be displayed before its keyset page arrives.
  const rows = new Map(previous.map(row => [row.bindingId, row]));
  for (const row of incoming) {
    const current = rows.get(row.bindingId);
    if (!current || row.epoch >= current.epoch) rows.set(row.bindingId, row);
  }
  return [...rows.values()];
}

function messageFor(error: unknown, write: boolean) {
  if (error instanceof HermesZaloClientError) {
    if (error.outcomeUnknown) return 'Chưa xác định thao tác liên kết đã hoàn tất. Tải lại danh sách để đối chiếu trước khi thao tác tiếp.';
    if (error.code === 'forbidden') return 'Bạn chưa được phép liên kết với bot này, hoặc quyền trong công ty đã thay đổi.';
    if (error.code === 'reauthentication_required') return 'Phiên CRM cần được xác minh lại. Hãy đăng nhập lại.';
    if (error.code === 'sender_already_linked') return 'Nick Zalo này đã có liên kết với bot. Hãy kiểm tra tài khoản CRM đang đăng nhập. Nếu muốn chuyển tài khoản, hãy ngắt liên kết ở tài khoản cũ trước khi ghép lại.';
    if (error.code === 'context_changed') return 'Liên kết, phiên bot hoặc quyền đã thay đổi. Tải lại danh sách để kiểm tra.';
  }
  return write ? 'Chưa xác định kết quả liên kết. Tải lại danh sách trước khi thao tác tiếp.' : 'Chưa đọc được thông tin liên kết Zalo. Hãy tải lại khi dịch vụ sẵn sàng.';
}

/** Parent keys this workspace by user/company generation. Challenges stay in
 * component memory only and are cleared on expiry, scope change or unmount. */
export function HermesZaloBindings({ userId, organizationId, currentScope, connections, disabled, onSummary }: Props) {
  const client = useMemo(() => createHermesZaloClient({ userId, organizationId, currentScope }), [userId, organizationId, currentScope]);
  const [state, setState] = useState<State>(initial);
  const [accountId, setAccountId] = useState(''), [connectionId, setConnectionId] = useState('');
  const [linkAnother, setLinkAnother] = useState(false);
  const life = useRef({ alive: false, generation: 0, controller: null as AbortController | null, blocked: false });
  const challengeId = useRef<string | null>(null); challengeId.current = state.challenge?.challengeId ?? null;
  useLayoutEffect(() => {
    const current = life.current; current.alive = true; current.generation++;
    return () => {
      current.alive = false; current.generation++; current.controller?.abort();
      // StrictMode remounts immediately; the abandoned read must not block it.
      current.controller = null; challengeId.current = null;
    };
  }, []);
  const run = useCallback(async <T,>(write: boolean, work: (signal: AbortSignal) => Promise<T>, success: (result: T, previous: State) => State, reload = false) => {
    const current = life.current;
    if (!current.alive || current.controller || write && current.blocked) return;
    const scope = { ...currentScope() }, generation = current.generation;
    if (scope.userId !== userId || scope.organizationId !== organizationId) return;
    const controller = new AbortController(); current.controller = controller;
    const valid = () => {
      const now = currentScope();
      return current.alive && current.generation === generation && !controller.signal.aborted && now.userId === userId &&
        now.organizationId === organizationId && now.generation === scope.generation;
    };
    setState(previous => ({ ...previous, busy: true, message: null,
      ...(reload ? { bots: null, bindings: null, challenge: null, observed: null } : {}) }));
    try {
      const result = await work(controller.signal);
      if (!valid()) return;
      if (reload) current.blocked = false;
      setState(previous => success(result, { ...previous, busy: false, blocked: current.blocked }));
    } catch (error) {
      if (!valid()) return;
      if (write) current.blocked = true;
      setState(previous => ({ ...previous, busy: false, blocked: current.blocked,
        observed: null, ...(write ? { challenge: null } : {}), message: messageFor(error, write) }));
    } finally { if (current.controller === controller) current.controller = null; }
  }, [currentScope, userId, organizationId]);
  const reload = useCallback(() => {
    return run(false, async signal => {
      const [bots, bindings] = await Promise.all([client.bots({ afterAccountId: null }, { signal }), client.list({ afterBindingId: null }, { signal })]);
      return { bots, bindings };
    }, (result, previous) => ({ ...previous, bots: result.bots.bots, botCursor: result.bots.nextCursor,
      bindings: result.bindings.bindings, bindingCursor: result.bindings.nextCursor }), true);
  }, [client, run]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    if (!state.challenge) return;
    const id = state.challenge.challengeId;
    const timer = setTimeout(() => {
      setState(previous => previous.challenge?.challengeId === id ? { ...previous, challenge: null, observed: null, message: 'Mã liên kết đã hết hạn. Hãy tạo mã mới nếu bạn vẫn cần liên kết.' } : previous);
    }, Math.max(0, Math.min(2147483647, state.challenge.expiresAt - Date.now())));
    return () => clearTimeout(timer);
  }, [state.challenge]);
  useEffect(() => {
    if (!state.challenge) return;
    const current = connections.find(value => value.id === state.challenge?.connectionId);
    if (!current || current.state !== 'active') {
      setState(previous => ({ ...previous, challenge: null, observed: null, message: 'Kết nối Hermes đã thay đổi. Chọn lại kết nối trước khi liên kết Zalo.' }));
    }
  }, [connections, state.challenge]);
  const activeConnections = connections.filter(value => value.state === 'active');
  // Chỉ có một lựa chọn thì tự dùng lựa chọn đó; người dùng vẫn phải bấm tạo mã. Máy chủ kiểm epoch như cũ.
  const selectedConnectionId = activeConnections.some(value => value.id === connectionId) ? connectionId
    : activeConnections.length === 1 ? activeConnections[0].id : '';
  const selectedAccountId = state.bots?.some(bot => bot.accountId === accountId) ? accountId
    : state.bots?.length === 1 ? state.bots[0].accountId : '';
  const blocked = disabled || state.busy || state.blocked || state.bots === null || state.bindings === null;
  const begin = () => {
    const connection = activeConnections.find(value => value.id === selectedConnectionId);
    if (blocked || !connection || !state.bots?.some(bot => bot.accountId === selectedAccountId)) return;
    void run(true, signal => client.begin({ accountId: selectedAccountId, connectionId: connection.id, expectedConnectionEpoch: connection.epoch }, { signal }),
      (challenge, previous) => ({ ...previous, challenge, observed: null }));
  };
  const checkMessage = useCallback(() => {
    const challenge = state.challenge;
    if (disabled || state.blocked || !challenge || state.observed?.status === 'observed') return;
    void run(false, signal => client.status({ challengeId: challenge.challengeId }, { signal }), (observed, previous) => {
      if (observed.accountId !== challenge.accountId || observed.connectionId !== challenge.connectionId) return { ...previous, challenge: null, observed: null, message: 'Thông tin liên kết không khớp. Hãy tải lại danh sách.' };
      // Trạng thái "đang chờ" đã hiện ngay ở bước 4, không lặp lại ở hộp thông báo.
      return { ...previous, observed, message: observed.status === 'waiting' ? null
        : observed.status === 'confirmed' ? 'Liên kết đã được xác nhận. Tải lại danh sách để xem.' : null };
    });
  }, [state.challenge, state.observed?.status, state.blocked, disabled, run, client]);
  useEffect(() => {
    if (!state.challenge || state.observed?.status === 'observed' || state.observed?.status === 'confirmed' || state.blocked || disabled) return;
    // Poll reads only; the run guard prevents overlapping requests.
    const first = setTimeout(checkMessage, 500);
    const timer = setInterval(checkMessage, 2000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [state.challenge, state.observed?.status, state.blocked, disabled, checkMessage]);
  const confirm = () => {
    const observed = state.observed, challenge = state.challenge;
    if (blocked || !challenge || observed?.status !== 'observed' || !observed.senderUid || challenge.expiresAt <= Date.now()) return;
    setLinkAnother(false);
    void run(true, signal => client.confirm({ challengeId: challenge.challengeId, expectedCandidateVersion: 1, expectedSenderUid: observed.senderUid! }, { signal }),
      (result, previous) => ({ ...previous, challenge: null, observed: null,
        bindings: [{ bindingId: result.bindingId, epoch: result.epoch, state: 'active', accountId: result.accountId, connectionId: result.connectionId, senderUid: result.senderUid, provisioningState: result.provisioningState },
          ...(previous.bindings ?? []).filter(value => value.bindingId !== result.bindingId)], message: 'Đã liên kết nick Zalo của bạn với kết nối Hermes.' }));
  };
  const copy = async () => {
    const challenge = state.challenge, scope = { ...currentScope() }, generation = life.current.generation;
    if (!challenge || challenge.expiresAt <= Date.now() || scope.userId !== userId || scope.organizationId !== organizationId) return;
    let message = 'Đã sao chép mã. Gửi mã bằng nick Zalo chính tới bot đã chọn.';
    try { await navigator.clipboard.writeText('/hermes-link ' + challenge.challenge); }
    catch { message = 'Chưa sao chép được. Bạn có thể chọn và sao chép mã thủ công.'; }
    const now = currentScope();
    if (life.current.alive && life.current.generation === generation && challengeId.current === challenge.challengeId &&
        now.userId === userId && now.organizationId === organizationId && now.generation === scope.generation) setState(previous => ({ ...previous, message }));
  };
  const names = hermesConnectionNames(connections);
  const botName = (id: string) => state.bots?.find(bot => bot.accountId === id)?.name ?? `Bot …${id.slice(-8)}`;
  const activeBindings = state.bindings?.filter(value => value.state === 'active') ?? [];
  const pastBindings = state.bindings?.filter(value => value.state !== 'active') ?? [];
  const linked = activeBindings[0] ?? null;
  const observedSender = state.challenge && state.observed?.status === 'observed' ? state.observed.senderUid : null;
  const stage: HermesZaloSummary['stage'] = linked ? 'linked' : observedSender ? 'observed' : state.challenge ? 'code' : 'none';
  // Các bước con đi theo mã đang làm, kể cả khi đã có một nick liên kết và người dùng liên kết thêm nick khác.
  const stepStage: HermesZaloSummary['stage'] = observedSender ? 'observed' : state.challenge ? 'code' : linked && !linkAnother ? 'linked' : 'none';
  const linkedConnectionActive = linked ? activeConnections.some(value => value.id === linked.connectionId) : false;
  const switchCredential = Boolean(linked && selectedConnectionId && selectedConnectionId !== linked.connectionId);
  const showLinkSteps = !linked || linkAnother || Boolean(state.challenge);
  const botCount = state.bots?.length ?? null, provisioningState = linked?.provisioningState ?? null;
  useEffect(() => { onSummary?.({ bots: botCount, stage, provisioningState }); }, [onSummary, botCount, stage, provisioningState]);
  const bindingRow = (value: HermesZaloBinding) => <div key={value.bindingId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
    <div className="min-w-0 text-sm"><p className="break-all font-medium">Nick của bạn: {value.senderUid}</p>
      <p className="text-muted-foreground">{botName(value.accountId)} · {value.state === 'active' ? 'Đã liên kết' : 'Đã ngắt liên kết'}</p>
      {value.state === 'active' && value.provisioningState && <p role="status" className="text-muted-foreground">{
        value.provisioningState === 'pending_credential' ? 'Đang chờ kết nối CRM của trợ lý.' :
        value.provisioningState === 'restart_pending' ? 'Đang chờ quản trị viên kích hoạt trợ lý.' :
        value.provisioningState === 'unavailable' ? 'Chưa đồng bộ được với trợ lý. Hệ thống sẽ thử lại.' :
        value.provisioningState === 'synchronized' ? 'Đã đồng bộ với trợ lý.' : 'Đang đồng bộ với trợ lý…'}</p>}</div>
    {value.state === 'active' && <Button variant="outline" size="sm" disabled={blocked} onClick={() => void run(true,
      signal => client.unlink({ bindingId: value.bindingId, expectedEpoch: value.epoch }, { signal }),
      (result, previous) => ({ ...previous, bindings: (previous.bindings ?? []).map(row => row.bindingId === result.bindingId ? { ...row, state: 'revoked', epoch: result.epoch } : row),
        message: 'Đã ngắt liên kết nick Zalo.' }))}>Ngắt liên kết</Button>}
  </div>;
  return <div role="region" aria-label="Liên kết Zalo của tôi" className="space-y-3">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">Dùng nick Zalo chính của bạn nhắn riêng cho bot của công ty. Liên kết chỉ thuộc tài khoản CRM và công ty đang chọn.</p>
      <Button variant="ghost" size="sm" disabled={state.busy || disabled} onClick={() => void reload()}><RefreshCw className="h-4 w-4" />Tải lại liên kết</Button>
    </div>
    {state.message && <p role="status" className="rounded-lg bg-muted p-3 text-sm">{state.message}</p>}
    {state.busy && <p role="status" className="text-sm text-muted-foreground">Đang kiểm tra liên kết…</p>}
    {state.blocked && <p className="text-sm">Các thao tác đang tạm dừng. Bấm “Tải lại liên kết” để đối chiếu kết quả.</p>}
    {activeConnections.length > 1 && <div className="space-y-1"><Label htmlFor="hermes-zalo-connection">Kết nối Hermes dùng cho Zalo</Label>
      <select id="hermes-zalo-connection" value={connectionId} disabled={blocked} onChange={event => setConnectionId(event.target.value)} className="h-10 w-full rounded-md border bg-background px-3 text-sm">
        <option value="">Chọn kết nối</option>{activeConnections.map(value => <option key={value.id} value={value.id}>{names(value.id)} · mã …{shortConnectionId(value.id)}</option>)}
      </select></div>}
    {activeBindings.length > 0 && <div aria-label="Nick Zalo đã liên kết" className="space-y-2">{activeBindings.map(bindingRow)}</div>}
    {linked && switchCredential && <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm">
      <p>{linkedConnectionActive ? `Trợ lý đang dùng ${names(linked.connectionId)}.` : 'Trợ lý đang dùng một kết nối đã ngắt hoặc hết hạn.'} Chuyển sang <strong>{names(selectedConnectionId)}</strong> (mã …{shortConnectionId(selectedConnectionId)}), nick Zalo vẫn giữ nguyên, không cần ghép lại.</p>
      <Button disabled={blocked} onClick={() => {
        const connection = activeConnections.find(value => value.id === selectedConnectionId);
        const existing = state.bindings?.find(value => value.state === 'active');
        if (!connection || !existing) return;
        void run(true, signal => client.selectCredential({ connectionId: connection.id, expectedConnectionEpoch: connection.epoch,
          expectedActiveConnectionId: existing.connectionId }, { signal }), (result, previous) => ({ ...previous,
          bindings: (previous.bindings ?? []).map(value => value.state === 'active' ? { ...value, connectionId: result.connectionId } : value),
          message: 'Đã chọn kết nối CRM cho trợ lý. Nick Zalo vẫn được giữ.' }));
      }}>Dùng kết nối này cho trợ lý</Button>
    </div>}
    {linked && !showLinkSteps && <Button variant="ghost" size="sm" disabled={blocked} onClick={() => setLinkAnother(true)}>Liên kết nick Zalo khác</Button>}
    {showLinkSteps && <ol aria-label="Các bước liên kết Zalo" className="space-y-2">
      <SubStep n={3} state={stepStage !== 'none' ? 'done' : activeConnections.length > 0 && (state.bots?.length ?? 0) > 0 ? 'current' : 'todo'} title="Tạo mã liên kết">
        {activeConnections.length === 0 && <p className="text-sm text-muted-foreground">Làm bước 2 (tạo kết nối) trước.</p>}
        {state.bots?.length === 0 && <p className="text-sm text-muted-foreground">Công ty chưa có bot sẵn sàng. Nhờ quản trị làm bước 1 trước khi bạn liên kết.</p>}
        {state.bots?.length === 1 && <p className="text-sm">Bot của công ty: <span className="font-medium">{state.bots[0].name}</span></p>}
        {state.bots && state.bots.length > 1 && <div className="space-y-1"><Label htmlFor="hermes-zalo-bot">Bot nhận tin nhắn</Label>
          <select id="hermes-zalo-bot" value={accountId} disabled={blocked} onChange={event => setAccountId(event.target.value)} className="h-10 w-full rounded-md border bg-background px-3 text-sm">
            <option value="">Chọn bot của công ty</option>{state.bots.map(value => <option key={value.accountId} value={value.accountId}>{value.name} · {value.zaloUid}</option>)}
          </select></div>}
        {state.botCursor && <Button variant="outline" size="sm" disabled={blocked} onClick={() => void run(false, signal => client.bots({ afterAccountId: state.botCursor }, { signal }),
          (result, previous) => ({ ...previous, bots: [...(previous.bots ?? []), ...result.bots], botCursor: result.nextCursor }))}>Xem thêm bot</Button>}
        <div className="flex flex-wrap gap-2">
          <Button variant={state.challenge ? 'outline' : 'default'} disabled={blocked || !selectedAccountId || !selectedConnectionId} onClick={begin}>Tạo mã liên kết Zalo</Button>
          {linked && !state.challenge && <Button variant="ghost" disabled={state.busy} onClick={() => setLinkAnother(false)}>Đóng</Button>}
        </div>
      </SubStep>
      <SubStep n={4} state={stepStage === 'code' ? 'current' : stepStage === 'none' ? 'todo' : 'done'} title="Nhắn mã cho bot bằng nick Zalo chính">
        {state.challenge && <>
          <p className="text-sm">Mở Zalo trên điện thoại bằng nick chính của bạn, nhắn riêng cho bot <span className="font-medium">{botName(state.challenge.accountId)}</span> đúng nội dung dưới đây.</p>
          <Label htmlFor="hermes-zalo-code">Nội dung gửi cho bot</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input id="hermes-zalo-code" readOnly autoComplete="off" value={'/hermes-link ' + state.challenge.challenge} className="font-mono text-xs" />
            <Button variant="outline" onClick={() => void copy()}><Copy className="h-4 w-4" />Sao chép mã Zalo</Button>
          </div>
          {stepStage === 'code' && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />
            Đang chờ bot nhận tin. Mã hết hạn lúc {new Date(state.challenge.expiresAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}.</p>}
        </>}
      </SubStep>
      <SubStep n={5} state={stepStage === 'observed' ? 'current' : stepStage === 'linked' ? 'done' : 'todo'} title="Xác nhận đúng nick của bạn">
        {observedSender && <>
          <p className="break-all text-sm">Bot nhận được tin từ nick Zalo có UID <strong>{observedSender}</strong>. Nếu đúng là nick của bạn, bấm ghép.</p>
          <Button disabled={blocked} onClick={confirm}>Ghép nick Zalo này</Button>
        </>}
      </SubStep>
    </ol>}
    {pastBindings.length > 0 && <details className="rounded-lg border p-3 text-sm">
      <summary className="cursor-pointer text-muted-foreground">Liên kết đã ngắt ({pastBindings.length})</summary>
      <div className="mt-2 space-y-2">{pastBindings.map(bindingRow)}</div>
    </details>}
    {state.bindings?.length === 0 && <p className="text-sm text-muted-foreground">Bạn chưa có liên kết Zalo trong công ty này.</p>}
    {state.bindingCursor && <Button variant="outline" size="sm" disabled={blocked} onClick={() => void run(false,
      signal => client.list({ afterBindingId: state.bindingCursor }, { signal }),
      (result, previous) => ({ ...previous, bindings: mergeBindings(previous.bindings ?? [], result.bindings), bindingCursor: result.nextCursor }))}>Xem thêm liên kết</Button>}
  </div>;
}

function SubStep({ n, state, title, children }: { n: number; state: 'done' | 'current' | 'todo'; title: string; children?: ReactNode }) {
  return <li className={cn('space-y-2 rounded-lg border p-3', state === 'current' && 'border-primary/60 bg-primary/5')}>
    <div className="flex items-center gap-2">
      <span className={cn('flex h-6 w-6 flex-none items-center justify-center rounded-full text-xs font-semibold',
        state === 'done' ? 'bg-primary/10 text-primary' : state === 'current' ? 'bg-primary text-primary-foreground' : 'border text-muted-foreground')}>
        {state === 'done' ? <Check className="h-3.5 w-3.5" aria-label="Đã xong" /> : n}</span>
      <h3 className={cn('text-sm font-medium', state === 'todo' && 'text-muted-foreground')}>{title}</h3>
    </div>
    {children && <div className="space-y-2 sm:pl-8">{children}</div>}
  </li>;
}
