import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { PermissionPicker } from '@/components/authorization/PermissionPicker';
import { ScopePicker } from '@/components/authorization/ScopePicker';
import type { HermesCallerScope } from '@/hermes/connectionClient';
import { createHermesOrgPolicyClient, HermesOrgPolicyError, type HermesOrgPolicyInput, type HermesOrgPolicySnapshot } from './orgPolicyClient';

interface Props {
  userId: string; organizationId: string; currentScope: () => HermesCallerScope; onPolicyChanged: () => void;
  onPolicyChanging?: () => void;
}
interface State {
  opened: boolean; busy: boolean; blocked: boolean; snapshot: HermesOrgPolicySnapshot | null;
  draft: HermesOrgPolicyInput | null; message: string | null;
}
const initial = (): State => ({ opened: false, busy: false, blocked: false, snapshot: null, draft: null, message: null });
function messageFor(error: unknown) {
  if (error instanceof HermesOrgPolicyError) {
    if (error.outcomeUnknown) return 'Chưa xác định kết quả lưu chính sách. Tải lại chính sách để đối chiếu trước khi thao tác tiếp.';
    if (error.code === 'forbidden') return 'Bạn cần quyền quản lý người dùng của công ty để cấu hình Hermes.';
    if (error.code === 'context_changed') return 'Chính sách, tài khoản hoặc công ty đã thay đổi. Tải lại chính sách trước khi tiếp tục.';
    if (error.code === 'reauthentication_required') return 'Phiên CRM cần được xác minh lại. Hãy đăng nhập lại.';
    if (error.code === 'invalid_request') return 'Chính sách chưa hợp lệ hoặc có quyền đã ngừng hỗ trợ. Tải lại, kiểm tra các mục đang lưu rồi thử lại.';
  }
  return 'Chưa đọc được kết quả từ máy chủ. Tải lại chính sách khi dịch vụ sẵn sàng.';
}
const editable = (snapshot: HermesOrgPolicySnapshot): HermesOrgPolicyInput => ({ expectedVersion: snapshot.policy.version,
  enabled: snapshot.policy.enabled, read: [...snapshot.policy.read], action: [...snapshot.policy.action], scopeIds: [...snapshot.policy.scopeIds] });
const unchanged = (draft: HermesOrgPolicyInput, snapshot: HermesOrgPolicySnapshot) => JSON.stringify(draft) === JSON.stringify(editable(snapshot));

/** Mount keyed by account/org generation, like HermesZaloBotSettings. The SQL
 * writer authorizes users.edit; visibility and choices never grant authority. */
export function HermesOrgPolicySettings({ userId, organizationId, currentScope, onPolicyChanged, onPolicyChanging }: Props) {
  const client = useMemo(() => createHermesOrgPolicyClient({ userId, organizationId, currentScope }), [userId, organizationId, currentScope]);
  const [state, setState] = useState<State>(initial);
  const life = useRef({ alive: false, generation: 0, controller: null as AbortController | null, blocked: false });
  useLayoutEffect(() => {
    const current = life.current; current.alive = true; current.generation++;
    return () => { current.alive = false; current.generation++; current.controller?.abort(); current.controller = null; };
  }, []);
  async function run<T>(write: boolean, work: (signal: AbortSignal) => Promise<T>, success: (result: T, previous: State) => State) {
    const current = life.current, scope = { ...currentScope() }, generation = current.generation;
    if (!current.alive || current.controller || write && current.blocked || scope.userId !== userId || scope.organizationId !== organizationId) return;
    const controller = new AbortController(); current.controller = controller;
    const valid = () => {
      const now = currentScope();
      return current.alive && current.generation === generation && !controller.signal.aborted && now.userId === userId &&
        now.organizationId === organizationId && now.generation === scope.generation;
    };
    setState(previous => ({ ...previous, opened: true, busy: true, message: null }));
    try {
      if (write) onPolicyChanging?.();
      const result = await work(controller.signal);
      if (!valid()) return;
      current.blocked = write; // A new edit requires a fresh authoritative read.
      setState(previous => success(result, { ...previous, busy: false, blocked: write }));
      if (write) onPolicyChanged();
    } catch (error) {
      if (!valid()) return;
      if (write) current.blocked = true;
      setState(previous => ({ ...previous, busy: false, blocked: current.blocked, snapshot: null, draft: null, message: messageFor(error) }));
      if (write) onPolicyChanged();
    } finally { if (current.controller === controller) current.controller = null; }
  }
  function reload() {
    void run(false, signal => client.load({ signal }), (snapshot, previous) => ({ ...previous, snapshot, draft: editable(snapshot), blocked: false }));
  }
  function close() {
    if (life.current.controller) return;
    life.current.generation++; setState({ ...initial(), blocked: life.current.blocked });
  }
  function save() {
    const { draft, snapshot } = state;
    if (!draft || !snapshot || state.busy || state.blocked || unchanged(draft, snapshot)) return;
    void run(true, signal => client.save(draft, { signal }), (policy, previous) => ({ ...previous, snapshot: null, draft: null,
      message: policy.enabled ? 'Đã lưu chính sách Hermes của công ty. Tải lại để tiếp tục chỉnh sửa.' : 'Đã tắt Hermes của công ty. Tải lại để tiếp tục chỉnh sửa.' }));
  }
  const { draft, snapshot } = state;
  const disabled = state.busy || state.blocked;
  const choices = new Set(snapshot?.choices.read ?? []), scopeIds = new Set(snapshot?.choices.scopes.map(item => item.scopeId) ?? []);
  const toggleRead = (keys: string[], enabled: boolean) => {
    if (!draft || disabled) return;
    const allowed = keys.filter(key => choices.has(key as 'assistant.context.read' | 'rooms.view'));
    setState(previous => ({ ...previous, draft: { ...draft, read: enabled ? [...new Set([...draft.read, ...allowed])] : draft.read.filter(key => !allowed.includes(key)) } }));
  };
  const removeStored = (kind: 'read' | 'action' | 'scopeIds', key: string) => {
    if (draft && !disabled) setState(previous => ({ ...previous, draft: { ...draft, [kind]: draft[kind].filter(value => value !== key) } }));
  };
  return <section aria-label="Chính sách Hermes của công ty" className="space-y-4 rounded-xl border bg-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">Chính sách Hermes của công ty</h2>
      <Button variant="outline" disabled={state.busy} onClick={state.opened ? close : reload}>{state.opened ? 'Ẩn chính sách' : 'Cấu hình chính sách công ty'}</Button></div>
    <p className="text-sm text-muted-foreground">Người có quyền quản lý người dùng chọn giới hạn chung cho Hermes. Mỗi kết nối vẫn chỉ dùng phần giao với quyền CRM của chính người dùng và giới hạn riêng của kết nối.</p>
    {state.opened && <>
      <Button variant="outline" disabled={state.busy} onClick={reload}>Tải lại chính sách</Button>
      {state.busy && <p role="status" className="text-sm">Đang kiểm tra chính sách…</p>}
      {state.message && <p role="status" className="rounded-lg bg-muted p-3 text-sm">{state.message}</p>}
      {state.blocked && <p className="text-sm">Tải lại chính sách thành công trước khi thay đổi tiếp.</p>}
      {draft && snapshot && <div className="space-y-4">
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={draft.enabled} disabled={disabled}
          onChange={event => setState(previous => ({ ...previous, draft: { ...draft, enabled: event.target.checked } }))} />Bật Hermes cho công ty</label>
        {!draft.enabled && <p className="text-sm text-muted-foreground">Khi lưu trạng thái tắt, yêu cầu Hermes của công ty sẽ bị từ chối ở lần kiểm quyền tiếp theo. Các giới hạn đang chọn được giữ lại.</p>}
        <fieldset disabled={disabled} className="min-w-0 space-y-3 rounded-lg border p-3"><legend className="px-1 font-medium">Đọc dữ liệu</legend>
          {choices.has('assistant.context.read') && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={draft.read.includes('assistant.context.read')} disabled={disabled}
            onChange={event => toggleRead(['assistant.context.read'], event.target.checked)} />Xem thông tin phiên và quyền của người dùng</label>}
          {choices.has('rooms.view') && <PermissionPicker value={new Set(draft.read)} availableKeys={new Set(['rooms.view'])} visibleKeys={new Set(['rooms.view'])}
            onToggle={(key, enabled) => toggleRead([key], enabled)} onToggleMany={toggleRead} disabled={disabled} height="h-[240px]" />}
          {draft.read.filter(key => !choices.has(key as 'assistant.context.read' | 'rooms.view')).map(key => <label key={key} className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked disabled={disabled} onChange={() => removeStored('read', key)} /><span className="break-all">{key} — quyền đã lưu, chưa hỗ trợ thêm mới</span></label>)}
        </fieldset>
        <fieldset disabled={disabled} className="space-y-3 rounded-lg border p-3"><legend className="px-1 font-medium">Thao tác dữ liệu</legend>
          <p className="text-sm text-muted-foreground">Hiện chưa cấp thêm quyền thao tác CRM. Quyền đã lưu dưới đây được giữ lại nếu bạn không bỏ chọn.</p>
          {draft.action.length === 0 && <p className="text-sm">Chưa cấp quyền thao tác.</p>}
          {draft.action.map(key => <label key={key} className="flex items-start gap-2 text-sm"><input type="checkbox" checked disabled={disabled}
            onChange={() => removeStored('action', key)} /><span className="break-all">{key} — quyền đã lưu</span></label>)}
        </fieldset>
        <fieldset disabled={disabled} className="space-y-3 rounded-lg border p-3"><legend className="px-1 font-medium">Phạm vi dữ liệu phòng</legend>
          <p className="text-sm text-muted-foreground">Đây là giới hạn công ty. Hermes vẫn chỉ đọc các tòa nhà mà người dùng được phép xem.</p>
          <ScopePicker scopes={snapshot.choices.scopes} allowedKinds={['ORGANIZATION','AREA','BUILDING']} value={draft.scopeIds.filter(id => scopeIds.has(id))} disabled={disabled}
            onChange={next => { if (!disabled && next.every(id => scopeIds.has(id))) setState(previous => ({ ...previous,
              draft: { ...draft, scopeIds: [...draft.scopeIds.filter(id => !scopeIds.has(id)), ...next] } })); }} />
          {draft.scopeIds.filter(id => !scopeIds.has(id)).map(id => <label key={id} className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked disabled={disabled} onChange={() => removeStored('scopeIds', id)} /><span>{snapshot.storedScopes.find(item => item.scopeId === id)?.label ?? 'Phạm vi đã lưu'}
              <span className="block break-all text-xs text-muted-foreground">{id} · Chỉ giữ lại hoặc bỏ chọn.</span></span></label>)}
        </fieldset>
        <Button disabled={disabled || unchanged(draft, snapshot)} onClick={save}>Lưu chính sách Hermes</Button>
      </div>}
    </>}
  </section>;
}
