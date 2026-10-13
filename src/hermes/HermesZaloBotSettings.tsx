import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { HermesCallerScope } from './connectionClient';
import { createHermesZaloClient, HermesZaloClientError, type HermesManagedZaloBot } from './zaloBindingClient';

interface Props {
  userId: string; organizationId: string; currentScope: () => HermesCallerScope;
  onConfigurationChanged: () => void;
}
interface State {
  opened: boolean; busy: boolean; blocked: boolean;
  bots: HermesManagedZaloBot[] | null; cursor: string | null;
  selected: HermesManagedZaloBot | null; message: string | null;
}
const initial = (): State => ({ opened: false, busy: false, blocked: false, bots: null, cursor: null, selected: null, message: null });
function messageFor(error: unknown) {
  if (error instanceof HermesZaloClientError) {
    if (error.outcomeUnknown) return 'Chưa xác định kết quả đổi cấu hình. Tải lại cấu hình để đối chiếu trước khi thao tác tiếp.';
    if (error.code === 'forbidden') return 'Bạn chưa có đủ quyền quản lý người dùng và tự động hóa Zalo trong công ty này.';
    if (error.code === 'context_changed') return 'Cấu hình hoặc phiên Zalo đã thay đổi. Tải lại cấu hình trước khi tiếp tục.';
    if (error.code === 'reauthentication_required') return 'Phiên CRM cần được xác minh lại. Hãy đăng nhập lại.';
  }
  return 'Chưa đọc được kết quả từ máy chủ. Tải lại cấu hình khi dịch vụ sẵn sàng.';
}

/** The page keys this component by user/company generation. Administration is
 * authorized by the caller-JWT SQL operation, never by visibility of this UI. */
export function HermesZaloBotSettings({ userId, organizationId, currentScope, onConfigurationChanged }: Props) {
  const client = useMemo(() => createHermesZaloClient({ userId, organizationId, currentScope }), [userId, organizationId, currentScope]);
  const [state, setState] = useState<State>(initial), [agreed, setAgreed] = useState(false);
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
      const result = await work(controller.signal);
      if (!valid()) return;
      current.blocked = false;
      setState(previous => success(result, { ...previous, busy: false, blocked: false }));
      if (write) onConfigurationChanged();
    } catch (error) {
      if (!valid()) return;
      if (write) current.blocked = true;
      setAgreed(false);
      setState(previous => ({ ...previous, busy: false, blocked: current.blocked, bots: null, cursor: null, selected: null, message: messageFor(error) }));
      if (write) onConfigurationChanged();
    } finally { if (current.controller === controller) current.controller = null; }
  }
  function reload() {
    if (life.current.controller) return;
    setAgreed(false); setState(previous => ({ ...previous, bots: null, cursor: null, selected: null }));
    void run(false, signal => client.manageBots({ afterAccountId: null }, { signal }),
      (result, previous) => ({ ...previous, bots: result.bots, cursor: result.nextCursor }));
  }
  function close() {
    if (life.current.controller) return;
    life.current.generation++; setAgreed(false);
    setState({ ...initial(), blocked: life.current.blocked });
  }
  function configure() {
    const selected = state.selected;
    if (!selected || !agreed || state.busy || state.blocked || !state.bots?.some(bot => bot.accountId === selected.accountId && bot.version === selected.version && bot.enabled === selected.enabled)) return;
    const enabled = !selected.enabled;
    void run(true, signal => client.setBot({ accountId: selected.accountId, expectedVersion: selected.version, enabled }, { signal }),
      (result, previous) => ({ ...previous, selected: null, bots: (previous.bots ?? []).map(bot => bot.accountId === result.accountId ?
        { ...bot, enabled: result.enabled, version: result.version } : bot),
      message: enabled ? 'Đã bật nick phụ làm bot Hermes. Người dùng có thể tạo liên kết Zalo mới.' : 'Đã tắt bot Hermes và ngắt các liên kết đang dùng bot này.' }));
  }
  return <section aria-label="Quản trị bot Zalo của công ty" className="space-y-4 rounded-xl border bg-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">Bot Zalo của công ty</h2>
      <Button variant="outline" disabled={state.busy} onClick={state.opened ? close : reload}>{state.opened ? 'Ẩn cấu hình bot' : 'Cấu hình bot của công ty'}</Button></div>
    <p className="text-sm text-muted-foreground">Chọn nick Zalo phụ đã kết nối trong CRM để làm bot Hermes. Chỉ người được cấp quyền quản trị phù hợp mới thay đổi được cấu hình.</p>
    {state.opened && <>
      <Button variant="outline" disabled={state.busy} onClick={reload}>Tải lại cấu hình bot</Button>
      {state.busy && <p role="status" className="text-sm">Đang kiểm tra cấu hình bot…</p>}
      {state.message && <p role="status" className="rounded-lg bg-muted p-3 text-sm">{state.message}</p>}
      {state.blocked && <p className="text-sm">Thao tác thay đổi đang tạm dừng đến khi tải lại cấu hình thành công.</p>}
      {state.bots?.length === 0 && <p className="text-sm text-muted-foreground">Công ty chưa có nick Zalo phụ để cấu hình. Kết nối nick phụ trong phần quản lý Zalo trước.</p>}
      {state.bots?.map(bot => <article key={bot.accountId} aria-label={`Tài khoản Zalo ${bot.name}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
        <div className="min-w-0 text-sm"><p className="break-all font-medium">{bot.name}</p>
          <p className="break-all text-muted-foreground">UID: {bot.zaloUid ?? 'Chưa xác định'} · {bot.connected ? 'Đã kết nối' : 'Chưa sẵn sàng'}</p>
          <p>{bot.enabled ? 'Đang bật Hermes' : 'Chưa bật Hermes'}</p></div>
        <Button variant={bot.enabled ? 'outline' : 'default'} disabled={state.busy || state.blocked || !bot.enabled && !bot.connected}
          onClick={() => { setAgreed(false); setState(previous => ({ ...previous, selected: { ...bot }, message: null })); }}>{bot.enabled ? 'Tắt bot' : 'Bật làm bot'}</Button>
      </article>)}
      {state.cursor && <Button variant="outline" disabled={state.busy || state.blocked} onClick={() => {
        setAgreed(false); setState(previous => ({ ...previous, selected: null }));
        void run(false, signal => client.manageBots({ afterAccountId: state.cursor }, { signal }),
          (result, previous) => ({ ...previous, bots: [...(previous.bots ?? []), ...result.bots], cursor: result.nextCursor }));
      }}>Xem thêm tài khoản Zalo</Button>}
      {state.selected && <div aria-label="Xác nhận đổi bot" className="space-y-3 rounded-lg border p-3">
        <h3 className="break-all font-medium">{state.selected.enabled ? 'Tắt bot' : 'Bật bot'}: {state.selected.name}</h3>
        <p className="text-sm">Thay đổi này ngắt các liên kết cũ và hủy mã xác minh đang chờ của bot. Người dùng cần liên kết lại sau khi bot được bật.</p>
        <p className="text-sm">Tin nhắn riêng tới nick này không vào hộp thư Zalo chung, kể cả sau khi tắt bot. Chỉ dùng nick dành riêng cho Hermes.</p>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={agreed} disabled={state.busy}
          onChange={event => setAgreed(event.target.checked)} />{state.selected.enabled ? 'Tôi đồng ý ngắt các liên kết đang dùng bot này.' : 'Tôi xác nhận đây là nick phụ dùng làm bot của công ty và đồng ý ngắt các liên kết cũ.'}</label>
        <div className="flex flex-wrap gap-2"><Button disabled={!agreed || state.busy || state.blocked} onClick={configure}>Xác nhận đổi cấu hình</Button>
          <Button variant="outline" disabled={state.busy} onClick={() => { setAgreed(false); setState(previous => ({ ...previous, selected: null })); }}>Hủy thay đổi</Button></div>
      </div>}
    </>}
  </section>;
}
