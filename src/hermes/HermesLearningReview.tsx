import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { HermesCallerScope } from './connectionClient';
import { createHermesLearningClient, HermesLearningError, type HermesLearningCursor, type HermesLearningDecideInput,
  type HermesLearningProposal } from './learningReviewClient';

interface Props { userId: string; organizationId: string; currentScope: () => HermesCallerScope }
type Decision = HermesLearningDecideInput['decision'];
interface State {
  busy: boolean; loaded: boolean; message: string | null; pendingCount: number;
  pending: HermesLearningProposal[]; history: HermesLearningProposal[]; cursor: HermesLearningCursor | null;
  selected: { item: HermesLearningProposal; decision: Decision } | null;
  // Lệnh ghi mất phản hồi: chỉ được gửi lại đúng lệnh này (cùng requestId). Giữ cả số đề xuất vì lần tải lại có thể đã gỡ
  // đề xuất khỏi danh sách chờ (máy chủ thật ra đã ghi).
  unknown: { input: HermesLearningDecideInput; seq: number } | null;
}
const initial = (): State => ({ busy: false, loaded: false, message: null, pendingCount: 0, pending: [], history: [], cursor: null,
  selected: null, unknown: null });
const kinds: Record<HermesLearningProposal['kind'], string> = { skill_crm_write: 'Skill', memory_crm_write: 'Bộ nhớ' };
const verbs: Record<Decision, string> = { approve: 'Duyệt', reject: 'Bỏ' };
const time = (value: string | null) => value ? new Date(value).toLocaleString('vi-VN') : '';
const text = (value: unknown, max = 80) => typeof value === 'string' && value.trim() ? Array.from(value.trim()).slice(0, max).join('') : null;

function sourceLine(item: HermesLearningProposal) {
  const { source } = item;
  const parts: string[] = [];
  if (source.type === 'curator_ledger') {
    const skill = text(source.skill), session = text(source.sessionId, 64);
    const who = source.actor === 'curator' ? 'curator (tự học sau phiên)' : source.actor === 'agent' ? 'trợ lý trong phiên' : text(source.actor);
    parts.push(`Skill ${skill ?? '(không rõ)'}${who ? ` · ${who} ${source.action === 'create' ? 'tạo' : 'sửa'}` : ''}`);
    if (session) parts.push(`phiên …${session.slice(-8)}`);
    if (source.diffUnavailable === true) parts.push('không dựng lại được bản trước — nội dung là cả file');
  } else if (source.type === 'memory') {
    parts.push(`Bộ nhớ ${text(source.file) ?? ''}`.trim());
  }
  const reasons = Array.isArray(source.reasons) ? source.reasons.map(reason => text(reason, 120)).filter(Boolean).slice(0, 3) : [];
  if (reasons.length) parts.push(`dấu hiệu: ${reasons.join('; ')}`);
  return parts.join(' · ');
}
function readMessage(error: unknown) {
  if (error instanceof HermesLearningError) {
    if (error.code === 'forbidden') return 'Chỉ chủ hoặc quản trị viên công ty (quyền quản lý người dùng) mới xem và duyệt được bài học của trợ lý.';
    if (error.code === 'not_supported') return 'Máy chủ chưa có chức năng duyệt bài học (cơ sở dữ liệu chưa được cập nhật).';
    if (error.code === 'reauthentication_required') return 'Phiên CRM cần được xác minh lại. Hãy đăng nhập lại.';
    if (error.code === 'context_changed') return 'Tài khoản hoặc công ty đã thay đổi. Tải lại trang trước khi tiếp tục.';
  }
  return 'Chưa đọc được danh sách bài học. Tải lại khi dịch vụ sẵn sàng.';
}
function writeMessage(error: unknown) {
  if (error instanceof HermesLearningError) {
    if (error.outcomeUnknown) return 'Chưa rõ máy chủ đã ghi quyết định này chưa. Gửi lại với cùng mã hoặc tải lại danh sách để đối chiếu.';
    if (error.code === 'forbidden') return 'Bạn không còn quyền duyệt bài học của trợ lý trong công ty này.';
    if (error.code === 'conflict') return 'Đề xuất này đã được quyết định trước đó. Danh sách đã được tải lại.';
    if (error.code === 'invalid_request') return 'Quyết định chưa hợp lệ. Ghi chú tối đa 500 ký tự; đề xuất có thể không còn trong công ty này.';
    if (error.code === 'not_supported') return 'Máy chủ chưa có chức năng duyệt bài học (cơ sở dữ liệu chưa được cập nhật).';
    if (error.code === 'reauthentication_required') return 'Phiên CRM cần được xác minh lại. Hãy đăng nhập lại.';
  }
  return 'Chưa ghi được quyết định. Tải lại danh sách khi dịch vụ sẵn sàng.';
}

/** Cài đặt › Hermes › "Bài học chờ duyệt". Bài học về cách GHI dữ liệu CRM mà trợ lý tự học chỉ là đề xuất: chủ/admin
 * duyệt hoặc bỏ ở đây (quyền do SQL quyết định). Sở thích, cách nói chuyện, việc ngoài CRM không vào danh sách này. */
export function HermesLearningReview({ userId, organizationId, currentScope }: Props) {
  const client = useMemo(() => createHermesLearningClient({ userId, organizationId, currentScope }), [userId, organizationId, currentScope]);
  const [state, setState] = useState<State>(initial);
  const [note, setNote] = useState('');
  const life = useRef({ alive: false, generation: 0, controller: null as AbortController | null });
  useLayoutEffect(() => {
    const current = life.current; current.alive = true; current.generation++;
    return () => { current.alive = false; current.generation++; current.controller?.abort(); current.controller = null; };
  }, []);
  async function run<T>(work: (signal: AbortSignal) => Promise<T>, done: (result: T, previous: State) => State,
    failed: (error: unknown, previous: State) => State) {
    const current = life.current, scope = { ...currentScope() }, generation = current.generation;
    if (!current.alive || current.controller || scope.userId !== userId || scope.organizationId !== organizationId) return;
    const controller = new AbortController(); current.controller = controller;
    const valid = () => {
      const now = currentScope();
      return current.alive && current.generation === generation && !controller.signal.aborted && now.userId === userId &&
        now.organizationId === organizationId && now.generation === scope.generation;
    };
    setState(previous => ({ ...previous, busy: true }));
    try {
      const result = await work(controller.signal);
      if (valid()) setState(previous => done(result, { ...previous, busy: false }));
    } catch (error) {
      if (valid()) setState(previous => failed(error, { ...previous, busy: false }));
    } finally { if (current.controller === controller) current.controller = null; }
  }
  const load = (message: string | null = null) => run(signal => client.review(null, { signal }),
    (snapshot, previous) => ({ ...previous, loaded: true, message: message ?? previous.message, pendingCount: snapshot.pendingCount,
      pending: snapshot.pending, history: snapshot.history, cursor: snapshot.nextHistoryCursor,
      selected: previous.selected && snapshot.pending.some(item => item.id === previous.selected?.item.id) ? previous.selected : null }),
    (error, previous) => ({ ...previous, loaded: false, pending: [], history: [], cursor: null, pendingCount: 0, selected: null,
      message: readMessage(error) }));
  // Tab chỉ được mount khi người dùng mở nó: đọc ngay khi hiện (một lần mỗi lần mount; tải lại bằng nút).
  const initialLoad = useRef(load); initialLoad.current = load;
  useEffect(() => { void initialLoad.current(); }, []);
  function more() {
    const from = state.cursor; if (!from) return;
    void run(signal => client.review(from, { signal }),
      (snapshot, previous) => ({ ...previous, history: [...previous.history, ...snapshot.history.filter(item =>
        !previous.history.some(seen => seen.id === item.id))], cursor: snapshot.nextHistoryCursor }),
      (error, previous) => ({ ...previous, message: readMessage(error) }));
  }
  function choose(item: HermesLearningProposal, decision: Decision) {
    if (state.busy || state.unknown) return;
    setNote('');
    setState(previous => ({ ...previous, selected: { item, decision }, message: null }));
  }
  function submit(input: HermesLearningDecideInput, seq: number) {
    void run(signal => client.decide(input, { signal }),
      (result, previous) => ({ ...previous, unknown: null, selected: null,
        message: `${result.decision === 'approve' ? 'Đã duyệt' : 'Đã bỏ'} đề xuất #${seq}.${result.replayed ? ' (Máy chủ đã ghi từ lần gửi trước.)' : ''}` }),
      (error, previous) => {
        const unknown = error instanceof HermesLearningError && error.outcomeUnknown;
        return { ...previous, unknown: unknown ? { input, seq } : null, selected: unknown ? previous.selected : null, message: writeMessage(error) };
      })
      .then(() => { const current = life.current; if (current.alive && !current.controller) void load(); });
  }
  function confirm() {
    const selected = state.selected, value = note.trim();
    if (!selected || Array.from(value).length > 500 || state.busy || state.unknown) return;
    submit({ requestId: crypto.randomUUID(), proposalIds: [selected.item.id], decision: selected.decision, note: value || null }, selected.item.seq);
  }
  const locked = state.busy || Boolean(state.unknown);
  return <section aria-label="Bài học chờ duyệt" className="space-y-4 rounded-xl border bg-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="font-semibold">Bài học chờ duyệt{state.loaded ? ` (${state.pendingCount})` : ''}</h2>
      <Button variant="outline" disabled={state.busy} onClick={() => { setState(previous => ({ ...previous, message: null })); void load(); }}>
        <RefreshCw className="h-4 w-4" />Tải lại</Button>
    </div>
    <p className="text-sm text-muted-foreground">Trợ lý tự học sau các cuộc trò chuyện. Sở thích, cách nói chuyện và việc ngoài CRM được áp dụng ngay.
      Bài học về cách <strong>ghi dữ liệu CRM</strong> chỉ là đề xuất: <strong>Duyệt</strong> để đồng ý trợ lý làm theo, <strong>Bỏ</strong> nếu bài học sai — bài học bị bỏ sẽ được gỡ khỏi trợ lý.
      Số thứ tự dùng chung với tin nhắn Zalo buổi tối.</p>
    {state.busy && <p role="status" className="text-sm">Đang làm việc với máy chủ…</p>}
    {state.message && <p role="status" className="rounded-lg bg-muted p-3 text-sm">{state.message}</p>}
    {state.unknown && <div className="flex flex-wrap gap-2">
      <Button disabled={state.busy} onClick={() => state.unknown && submit(state.unknown.input, state.unknown.seq)}>Gửi lại với cùng mã</Button>
      <Button variant="outline" disabled={state.busy} onClick={() => { setState(previous => ({ ...previous, unknown: null, selected: null })); void load(); }}>
        Bỏ qua và tải lại</Button>
    </div>}
    {state.loaded && !state.pending.length && <p className="text-sm text-muted-foreground">Không có bài học nào đang chờ duyệt.</p>}
    {state.pending.map(item => <article key={item.id} aria-label={`Đề xuất #${item.seq}`} className="space-y-2 rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2"><Badge variant="secondary">#{item.seq}</Badge>
        <h3 className="font-medium break-words">{item.title}</h3></div>
      <p className="text-muted-foreground">{kinds[item.kind]} · hồ sơ {item.profile}{item.userName ? ` · ${item.userName}` : ''} · phát hiện {time(item.detectedAt)}</p>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 font-sans text-sm">{item.content}</pre>
      {sourceLine(item) && <p className="break-words text-xs text-muted-foreground">{sourceLine(item)}</p>}
      {state.selected?.item.id === item.id ? <div aria-label="Xác nhận quyết định" className="space-y-2 rounded-lg border p-3">
        <h4 className="font-medium">{verbs[state.selected.decision]} đề xuất #{item.seq}</h4>
        <Label htmlFor={`hermes-learning-note-${item.id}`}>Ghi chú (không bắt buộc)</Label>
        <Textarea id={`hermes-learning-note-${item.id}`} value={note} maxLength={500} disabled={locked}
          onChange={event => setNote(event.target.value)} placeholder="Ví dụ: đúng quy trình thu cọc / sai, phải dùng phiếu cọc giữ chỗ" />
        <div className="flex flex-wrap gap-2">
          <Button disabled={locked} variant={state.selected.decision === 'reject' ? 'destructive' : 'default'} onClick={confirm}>
            Xác nhận {verbs[state.selected.decision].toLowerCase()}</Button>
          <Button variant="outline" disabled={locked} onClick={() => setState(previous => ({ ...previous, selected: null }))}>Huỷ</Button>
        </div>
      </div> : <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={locked} onClick={() => choose(item, 'approve')}>Duyệt</Button>
        <Button size="sm" variant="outline" disabled={locked} onClick={() => choose(item, 'reject')}>Bỏ</Button>
      </div>}
    </article>)}
    {state.pendingCount > state.pending.length && <p className="text-sm text-muted-foreground">
      Còn {state.pendingCount - state.pending.length} đề xuất mới hơn chưa hiện; duyệt bớt rồi tải lại để xem tiếp.</p>}
    {state.history.length > 0 && <div aria-label="Lịch sử duyệt" className="space-y-2 text-sm">
      <h3 className="font-medium">Lịch sử</h3>
      {state.history.map(item => <p key={item.id} className="break-words text-muted-foreground">
        #{item.seq} · {item.status === 'approved' ? 'Đã duyệt' : 'Đã bỏ'} · {item.decidedByName ?? 'người duyệt'} · {time(item.decidedAt)}
        {item.via === 'hermes_connector' ? ' · qua Zalo' : ''} — {item.title}{item.note ? ` — ghi chú: ${item.note}` : ''}</p>)}
      {state.cursor && <Button variant="outline" size="sm" disabled={state.busy} onClick={more}>Xem thêm lịch sử</Button>}
    </div>}
  </section>;
}
