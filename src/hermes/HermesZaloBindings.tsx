import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { HermesCallerScope, HermesConnectionMetadata } from './connectionClient';
import { createHermesZaloClient, HermesZaloClientError, type HermesZaloBinding, type HermesZaloBot,
  type HermesZaloChallenge, type HermesZaloStatus } from './zaloBindingClient';

interface Props {
  userId: string; organizationId: string; currentScope: () => HermesCallerScope;
  connections: HermesConnectionMetadata[]; disabled: boolean;
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
    if (error.code === 'context_changed') return 'Liên kết, phiên bot hoặc quyền đã thay đổi. Tải lại danh sách để kiểm tra.';
  }
  return write ? 'Chưa xác định kết quả liên kết. Tải lại danh sách trước khi thao tác tiếp.' : 'Chưa đọc được thông tin liên kết Zalo. Hãy tải lại khi dịch vụ sẵn sàng.';
}

/** Parent keys this workspace by user/company generation. Challenges stay in
 * component memory only and are cleared on expiry, scope change or unmount. */
export function HermesZaloBindings({ userId, organizationId, currentScope, connections, disabled }: Props) {
  const client = useMemo(() => createHermesZaloClient({ userId, organizationId, currentScope }), [userId, organizationId, currentScope]);
  const [state, setState] = useState<State>(initial);
  const [accountId, setAccountId] = useState(''), [connectionId, setConnectionId] = useState(''), [checked, setChecked] = useState(false);
  const life = useRef({ alive: false, generation: 0, controller: null as AbortController | null, blocked: false });
  const challengeId = useRef<string | null>(null); challengeId.current = state.challenge?.challengeId ?? null;
  const connectionEpoch = useRef<number | null>(null);
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
    setChecked(false);
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
      setChecked(false);
      setState(previous => previous.challenge?.challengeId === id ? { ...previous, challenge: null, observed: null, message: 'Mã liên kết đã hết hạn. Hãy tạo mã mới nếu bạn vẫn cần liên kết.' } : previous);
    }, Math.max(0, Math.min(2147483647, state.challenge.expiresAt - Date.now())));
    return () => clearTimeout(timer);
  }, [state.challenge]);
  useEffect(() => {
    if (!state.challenge) return;
    const current = connections.find(value => value.id === state.challenge?.connectionId);
    if (!current || current.state !== 'active' || current.epoch !== connectionEpoch.current) {
      setChecked(false); setState(previous => ({ ...previous, challenge: null, observed: null, message: 'Kết nối Hermes đã thay đổi. Chọn lại kết nối trước khi liên kết Zalo.' }));
    }
  }, [connections, state.challenge]);
  const activeConnections = connections.filter(value => value.state === 'active');
  const blocked = disabled || state.busy || state.blocked || state.bots === null || state.bindings === null;
  const begin = () => {
    const connection = activeConnections.find(value => value.id === connectionId);
    if (blocked || !connection || !state.bots?.some(bot => bot.accountId === accountId)) return;
    connectionEpoch.current = connection.epoch; setChecked(false);
    void run(true, signal => client.begin({ accountId, connectionId, expectedConnectionEpoch: connection.epoch }, { signal }),
      (challenge, previous) => ({ ...previous, challenge, observed: null }));
  };
  const checkMessage = () => {
    const challenge = state.challenge;
    if (blocked || !challenge) return;
    setChecked(false);
    void run(false, signal => client.status({ challengeId: challenge.challengeId }, { signal }), (observed, previous) => {
      if (observed.accountId !== challenge.accountId || observed.connectionId !== challenge.connectionId) return { ...previous, challenge: null, observed: null, message: 'Thông tin liên kết không khớp. Hãy tải lại danh sách.' };
      return { ...previous, observed, message: observed.status === 'waiting' ? 'Bot chưa ghi nhận mã. Gửi đúng mã qua tin nhắn riêng rồi kiểm tra lại.'
        : observed.status === 'confirmed' ? 'Liên kết đã được xác nhận. Tải lại danh sách để xem.' : null };
    });
  };
  const confirm = () => {
    const observed = state.observed, challenge = state.challenge;
    if (blocked || !checked || !challenge || observed?.status !== 'observed' || !observed.senderUid || challenge.expiresAt <= Date.now()) return;
    void run(true, signal => client.confirm({ challengeId: challenge.challengeId, expectedCandidateVersion: 1, expectedSenderUid: observed.senderUid! }, { signal }),
      (result, previous) => ({ ...previous, challenge: null, observed: null,
        bindings: [{ bindingId: result.bindingId, epoch: result.epoch, state: 'active', accountId: result.accountId, connectionId: result.connectionId, senderUid: result.senderUid },
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
  return <section aria-label="Liên kết Zalo của tôi" className="space-y-4 rounded-xl border bg-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">Điều khiển Hermes qua Zalo</h2>
      <Button variant="outline" disabled={state.busy || disabled} onClick={() => void reload()}>Tải lại liên kết</Button></div>
    <p className="text-sm text-muted-foreground">Dùng nick Zalo chính để nhắn riêng cho bot của công ty. Mỗi liên kết thuộc đúng tài khoản CRM và công ty đang chọn.</p>
    {state.message && <p role="status" className="rounded-lg bg-muted p-3 text-sm">{state.message}</p>}
    {state.busy && <p role="status" className="text-sm">Đang kiểm tra liên kết…</p>}
    {state.blocked && <p className="text-sm">Các thao tác đang tạm dừng. Tải lại liên kết để đối chiếu kết quả.</p>}
    {state.bots?.length === 0 && <p className="text-sm text-muted-foreground">Công ty chưa có bot sẵn sàng. Quản trị viên cần cấu hình bot trước khi bạn liên kết.</p>}
    {activeConnections.length === 0 && <p className="text-sm text-muted-foreground">Hãy tạo kết nối Hermes trước khi liên kết Zalo.</p>}
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1"><Label htmlFor="hermes-zalo-connection">1. Chọn kết nối Hermes</Label>
        <select id="hermes-zalo-connection" value={connectionId} disabled={blocked} onChange={event => setConnectionId(event.target.value)} className="h-10 w-full rounded-md border bg-background px-3 text-sm">
          <option value="">Chọn kết nối</option>{activeConnections.map(value => <option key={value.id} value={value.id}>Kết nối …{value.id.slice(-8)}</option>)}
        </select></div>
      <div className="space-y-1"><Label htmlFor="hermes-zalo-bot">Bot nhận tin nhắn</Label>
        <select id="hermes-zalo-bot" value={accountId} disabled={blocked} onChange={event => setAccountId(event.target.value)} className="h-10 w-full rounded-md border bg-background px-3 text-sm">
          <option value="">Chọn bot của công ty</option>{state.bots?.map(value => <option key={value.accountId} value={value.accountId}>{value.name} · {value.zaloUid}</option>)}
        </select></div>
    </div>
    {state.botCursor && <Button variant="outline" disabled={blocked} onClick={() => void run(false, signal => client.bots({ afterAccountId: state.botCursor }, { signal }),
      (result, previous) => ({ ...previous, bots: [...(previous.bots ?? []), ...result.bots], botCursor: result.nextCursor }))}>Xem thêm bot</Button>}
    <Button disabled={blocked || !accountId || !connectionId} onClick={begin}>Tạo mã liên kết Zalo</Button>
    {state.challenge && <div className="space-y-3 rounded-lg border p-3">
      <h3 className="font-medium">2. Gửi mã bằng nick Zalo chính</h3>
      <p className="text-sm">Gửi riêng cho bot {state.bots?.find(value => value.accountId === state.challenge?.accountId)?.name ?? 'đã chọn'}. Mã có hiệu lực tối đa 5 phút.</p>
      <Label htmlFor="hermes-zalo-code">Nội dung gửi cho bot</Label>
      <Input id="hermes-zalo-code" readOnly autoComplete="off" value={'/hermes-link ' + state.challenge.challenge} className="font-mono text-xs" />
      <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => void copy()}>Sao chép mã Zalo</Button>
        <Button variant="outline" disabled={blocked} onClick={checkMessage}>Tôi đã gửi, kiểm tra người gửi</Button></div>
      {state.observed?.status === 'observed' && <div className="space-y-3">
        <h3 className="font-medium">3. Xác nhận nick gửi mã</h3>
        <p className="break-all text-sm">Bot ghi nhận UID Zalo: <strong>{state.observed.senderUid}</strong></p>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={checked} disabled={blocked} onChange={event => setChecked(event.target.checked)} />
          Tôi đã kiểm tra đúng nick Zalo chính của mình gửi mã này.</label>
        <Button disabled={blocked || !checked} onClick={confirm}>Xác nhận liên kết nick này</Button>
      </div>}
    </div>}
    {state.bindings && <div className="space-y-2" aria-label="Danh sách liên kết Zalo">
      {state.bindings.length === 0 && <p className="text-sm text-muted-foreground">Bạn chưa có liên kết Zalo trong công ty này.</p>}
      {state.bindings.map(value => <div key={value.bindingId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
        <div className="min-w-0 text-sm"><p className="break-all">Nick của bạn: {value.senderUid}</p>
          <p className="text-muted-foreground">{state.bots?.find(bot => bot.accountId === value.accountId)?.name ?? `Bot …${value.accountId.slice(-8)}`} · {value.state === 'active' ? 'Đã liên kết' : 'Đã ngắt liên kết'}</p></div>
        <Button variant="outline" size="sm" disabled={blocked || value.state !== 'active'} onClick={() => void run(true,
          signal => client.unlink({ bindingId: value.bindingId, expectedEpoch: value.epoch }, { signal }),
          (result, previous) => ({ ...previous, bindings: (previous.bindings ?? []).map(row => row.bindingId === result.bindingId ? { ...row, state: 'revoked', epoch: result.epoch } : row),
            message: 'Đã ngắt liên kết nick Zalo.' }))}>Ngắt liên kết</Button>
      </div>)}
      {state.bindingCursor && <Button variant="outline" disabled={blocked} onClick={() => void run(false,
        signal => client.list({ afterBindingId: state.bindingCursor }, { signal }),
        (result, previous) => ({ ...previous, bindings: mergeBindings(previous.bindings ?? [], result.bindings), bindingCursor: result.nextCursor }))}>Xem thêm liên kết</Button>}
    </div>}
  </section>;
}
