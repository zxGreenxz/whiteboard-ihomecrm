import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createHermesConnectionClient, HermesConnectionClientError, type HermesCallerScope,
  type HermesConnectionContext, type HermesConnectionMetadata, type HermesConnectInput,
  type HermesConnectResult, type HermesConnectionRestrictions, type HermesGrantOptions } from './connectionClient';

type Operation = 'list' | 'context' | 'connect' | 'restrict' | 'revoke';
interface State {
  connections: HermesConnectionMetadata[] | null;
  context: HermesConnectionContext | null;
  options: HermesGrantOptions | null;
  handoff: HermesConnectResult | null;
  busy: Operation | null;
  message: string | null;
  needsReload: boolean;
}
const initial = (): State => ({ connections: null, context: null, options: null, handoff: null, busy: null, message: null, needsReload: false });
const errorMessage = (error: unknown, write: boolean) => {
  if (error instanceof HermesConnectionClientError) {
    if (error.outcomeUnknown) return 'Chưa xác định thao tác đã hoàn tất. Hãy tải lại danh sách để đối chiếu trước khi gửi yêu cầu khác.';
    if (error.code === 'additional_authentication_required') return 'Tài khoản yêu cầu thêm bước xác minh mà kết nối Hermes hiện chưa hỗ trợ.';
    if (error.code === 'reauthentication_required') return 'Cần xác minh lại thông tin đăng nhập. Kiểm tra mật khẩu; nếu phiên CRM đã hết hạn, hãy đăng nhập lại.';
    if (error.code === 'forbidden') return 'Bạn chưa được phép thực hiện yêu cầu này. Quyền của bạn hoặc chính sách Hermes của công ty có thể đã thay đổi.';
    if (error.code === 'context_changed') return 'Thông tin kết nối hoặc quyền đã thay đổi. Hãy tải lại danh sách.';
    if (error.code === 'invalid_request') return 'Thông tin gửi đi chưa hợp lệ. Kiểm tra lại trước khi tiếp tục.';
    if (error.code === 'operation_rejected' || error.code === 'prepare_rejected' || error.code === 'activation_rejected') return 'Máy chủ chưa chấp nhận thao tác. Hãy tải lại danh sách để kiểm tra.';
  }
  return write ? 'Chưa xác định thao tác đã hoàn tất. Hãy tải lại danh sách để đối chiếu trước khi gửi yêu cầu khác.'
    : 'Chưa kết nối được dịch vụ Hermes. Hãy tải lại danh sách khi dịch vụ sẵn sàng.';
};

/** Component-local state only. No React Query mutation cache, browser storage,
 * persisted password, automatic write replay, or cross-account result reuse.
 * The page keys this hook's component by account/company generation. Both the
 * client and this hook fence late completions; mock/abort-ignorant clients cannot
 * put results into an unmounted or newly selected workspace.
 */
export function useHermesConnections(userId: string, organizationId: string, currentScope: () => HermesCallerScope) {
  const client = useMemo(() => createHermesConnectionClient({ userId, organizationId, currentScope }), [userId, organizationId, currentScope]);
  const [state, setState] = useState<State>(initial);
  const lifecycle = useRef({ alive: false, generation: 0, controller: null as AbortController | null, ready: false, needsReload: false });
  useLayoutEffect(() => {
    const life = lifecycle.current;
    life.alive = true; life.generation++;
    return () => { life.alive = false; life.generation++; life.controller?.abort(); life.controller = null; };
  }, []);

  const run = useCallback(async <T,>(operation: Operation, work: (signal: AbortSignal) => Promise<T>,
    success: (value: T, previous: State) => State) => {
    const life = lifecycle.current;
    if (!life.alive || life.controller || (operation !== 'list' && (!life.ready || life.needsReload))) return;
    const generation = life.generation, scope = { ...currentScope() };
    if (scope.userId !== userId || scope.organizationId !== organizationId) return;
    const controller = new AbortController(); life.controller = controller;
    const valid = () => {
      const current = currentScope();
      return life.alive && life.generation === generation && !controller.signal.aborted &&
        current.userId === scope.userId && current.organizationId === scope.organizationId && current.generation === scope.generation;
    };
    const write = !['list', 'context'].includes(operation);
    if (operation === 'list') life.ready = false;
    setState(previous => ({ ...previous, busy: operation, message: null,
      ...(operation === 'list' ? { connections: null, context: null, options: null } : {}),
      ...(operation === 'context' || write ? { context: null } : {}),
      ...(write ? { handoff: null } : {}) }));
    try {
      const value = await work(controller.signal);
      if (!valid()) return;
      if (operation === 'list') { life.ready = true; life.needsReload = false; }
      setState(previous => success(value, { ...previous, busy: null, message: null,
        ...(operation === 'list' ? { needsReload: false } : {}) }));
    } catch (error) {
      if (!valid()) return;
      if (write) life.needsReload = true;
      setState(previous => ({ ...previous, busy: null, context: null,
        message: errorMessage(error, write), needsReload: life.needsReload }));
    } finally {
      if (life.controller === controller) life.controller = null;
    }
  }, [client, currentScope, userId, organizationId]);
  const reload = useCallback(() => run('list', async signal => {
    const result = await client.list({ signal });
    try { return { ...result, options: (await client.options({ signal })).options }; }
    catch { return { ...result, options: null }; }
  }, (result, previous) => ({ ...previous, connections: result.connections, options: result.options })), [client, run]);
  useEffect(() => { void reload(); }, [reload]);

  // A handoff is intentionally short-lived in this mounted component. Clearing
  // it does not revoke the server connection or promise clipboard erasure.
  useEffect(() => {
    if (!state.handoff) return;
    const delay = Math.max(0, Math.min(2_147_483_647, state.handoff.tokenExpiresAt - Date.now()));
    const timer = setTimeout(() => setState(previous => ({ ...previous, handoff: null })), delay);
    return () => clearTimeout(timer);
  }, [state.handoff]);

  return {
    ...state, reload,
    clearHandoff: () => setState(previous => ({ ...previous, handoff: null })),
    contextFor: (connection: HermesConnectionMetadata) => run('context', signal => client.context({ connectionId: connection.id }, { signal }),
      (result, previous) => ({ ...previous, context: result.context })),
    connect: (input: HermesConnectInput) => run('connect', signal => client.connect(input, { signal }),
      (result, previous) => ({ ...previous, handoff: result, connections: [result.connection,
        ...(previous.connections ?? []).filter(item => item.id !== result.connection.id)] })),
    restrict: (connection: HermesConnectionContext, restrictions: HermesConnectionRestrictions, scopeIds = connection.scopeIds) => {
      // UI may only narrow the last authoritative connection sets. Never infer
      // new rights or an org-wide scope from labels, company ceilings or UUIDs.
      if ((['read', 'action'] as const).some(kind => restrictions[kind].some(key => !connection.restrictions[kind].includes(key)))) return Promise.resolve();
      if (scopeIds.some(id => !connection.scopeIds.includes(id))) return Promise.resolve();
      return run('restrict', signal => client.restrict({ connectionId: connection.id, expectedEpoch: connection.epoch,
        restrictions, scopeIds: [...scopeIds] }, { signal }),
      (result, previous) => ({ ...previous, connections: (previous.connections ?? []).map(item => item.id === result.connection.id ? result.connection : item),
        message: 'Đã lưu giới hạn mới. Mở lại quyền để xem hiệu lực hiện tại.' }));
    },
    revoke: (connection: HermesConnectionMetadata) => run('revoke', signal => client.revoke({ connectionId: connection.id, expectedEpoch: connection.epoch }, { signal }),
      (result, previous) => ({ ...previous, connections: (previous.connections ?? []).map(item => item.id === result.connectionId ? { ...item, state: 'revoked' } : item),
        message: 'Đã thu hồi kết nối.' })),
  };
}
