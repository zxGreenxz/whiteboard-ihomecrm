import { useCallback, useEffect, useRef, useState } from 'react';
import type { HermesCallerScope } from './connectionClient';
import {
  HermesWorkAssistantError, type HermesTaskFollowItem, type HermesTaskFollowRole, type HermesTaskFollowState, type HermesWorkAssistantClient,
  type HermesWorkAssistantErrorCode, type HermesWorkMemoryItem, type HermesWorkMemorySettings, type HermesWorkMemorySharing,
} from './workAssistantClient';

export interface WorkFailure { code: HermesWorkAssistantErrorCode; outcomeUnknown: boolean }
export interface WorkSection<T> {
  status: 'loading' | 'ready' | 'error'; data: T | null; error: WorkFailure | null; loadingMore: boolean;
}
export interface WorkAction { busy: boolean; error: WorkFailure | null; notice: string | null }
export interface WorkMemoryData { settings: HermesWorkMemorySettings; items: HermesWorkMemoryItem[]; nextOffset: number | null; total: number }
export interface WorkFollowsData { items: HermesTaskFollowItem[]; nextOffset: number | null }
export interface WorkFollowFilter { role: HermesTaskFollowRole; state: HermesTaskFollowState }
export interface WorkSettingsDraft { enabled: boolean; sharing: HermesWorkMemorySharing; retentionDays: number }

const loadingSection = <T,>(): WorkSection<T> => ({ status: 'loading', data: null, error: null, loadingMore: false });
const idle: WorkAction = { busy: false, error: null, notice: null };
const toFailure = (error: unknown): WorkFailure => error instanceof HermesWorkAssistantError
  ? { code: error.code, outcomeUnknown: error.outcomeUnknown } : { code: 'backend_unavailable', outcomeUnknown: false };
const refused: WorkFailure = { code: 'invalid_request', outcomeUnknown: false };

/** Manual state (no shared cache): data belongs to one user/company generation and is
 * dropped, never committed, when the account or company changes while a call is in flight. */
export function useHermesWorkAssistant(client: HermesWorkAssistantClient, userId: string, organizationId: string, currentScope: () => HermesCallerScope) {
  const [memory, setMemory] = useState<WorkSection<WorkMemoryData>>(loadingSection);
  const [follows, setFollows] = useState<WorkSection<WorkFollowsData>>(loadingSection);
  const [filter, setFilterState] = useState<WorkFollowFilter>({ role: 'assigned_by_me', state: 'active' });
  const [memoryAction, setMemoryAction] = useState<WorkAction>(idle);
  const [followAction, setFollowAction] = useState<WorkAction>(idle);
  const alive = useRef(false), writing = useRef(false), filterRef = useRef(filter);
  const memorySeq = useRef(0), followsSeq = useRef(0);
  const memoryCtl = useRef<AbortController | null>(null), followsCtl = useRef<AbortController | null>(null), writeCtl = useRef<AbortController | null>(null);
  const memoryRef = useRef(memory.data); memoryRef.current = memory.data;
  const followsRef = useRef(follows.data); followsRef.current = follows.data;

  const sameScope = useCallback((started: HermesCallerScope) => {
    const now = currentScope();
    return now.userId === userId && now.organizationId === organizationId && now.generation === started.generation;
  }, [currentScope, userId, organizationId]);

  const loadMemory = useCallback(async (offset = 0) => {
    memoryCtl.current?.abort(); const controller = new AbortController(); memoryCtl.current = controller;
    const seq = ++memorySeq.current, started = { ...currentScope() };
    setMemory(previous => offset > 0 ? { ...previous, loadingMore: true, error: null } : loadingSection());
    try {
      const page = await client.memory(offset, { signal: controller.signal });
      if (!alive.current || memorySeq.current !== seq || !sameScope(started)) return;
      setMemory(previous => ({ status: 'ready', error: null, loadingMore: false, data: {
        settings: page.settings, nextOffset: page.nextOffset, total: page.total,
        items: offset > 0 && previous.data ? [...previous.data.items, ...page.items.filter(item => !previous.data?.items.some(known => known.id === item.id))] : page.items } }));
    } catch (error) {
      if (!alive.current || memorySeq.current !== seq || !sameScope(started)) return;
      setMemory(previous => ({ status: 'error', error: toFailure(error), loadingMore: false, data: offset > 0 ? previous.data : null }));
    }
  }, [client, currentScope, sameScope]);

  const loadFollows = useCallback(async (offset = 0, wanted: WorkFollowFilter = filterRef.current) => {
    followsCtl.current?.abort(); const controller = new AbortController(); followsCtl.current = controller;
    const seq = ++followsSeq.current, started = { ...currentScope() };
    setFollows(previous => offset > 0 ? { ...previous, loadingMore: true, error: null } : loadingSection());
    try {
      const page = await client.follows({ ...wanted, offset }, { signal: controller.signal });
      if (!alive.current || followsSeq.current !== seq || !sameScope(started)) return;
      setFollows(previous => ({ status: 'ready', error: null, loadingMore: false, data: {
        nextOffset: page.nextOffset,
        items: offset > 0 && previous.data ? [...previous.data.items, ...page.items.filter(item => !previous.data?.items.some(known => known.id === item.id))] : page.items } }));
    } catch (error) {
      if (!alive.current || followsSeq.current !== seq || !sameScope(started)) return;
      setFollows(previous => ({ status: 'error', error: toFailure(error), loadingMore: false, data: offset > 0 ? previous.data : null }));
    }
  }, [client, currentScope, sameScope]);

  useEffect(() => {
    alive.current = true;
    void loadMemory(0); void loadFollows(0);
    return () => {
      alive.current = false; memorySeq.current++; followsSeq.current++;
      memoryCtl.current?.abort(); followsCtl.current?.abort(); writeCtl.current?.abort();
      memoryCtl.current = null; followsCtl.current = null; writeCtl.current = null; writing.current = false;
    };
  }, [loadMemory, loadFollows]);

  /** One write at a time. A write whose outcome is unknown or conflicted is never repeated;
   * the list is re-read so the user compares with what the server actually holds. */
  const mutate = useCallback(async (setAction: (value: WorkAction) => void, work: (signal: AbortSignal) => Promise<unknown>,
    notice: string, refresh: () => Promise<void>): Promise<WorkFailure | null> => {
    if (!alive.current || writing.current) return refused;
    const started = { ...currentScope() };
    if (started.userId !== userId || started.organizationId !== organizationId) return refused;
    writing.current = true; const controller = new AbortController(); writeCtl.current = controller;
    setMemoryAction(previous => previous.error || previous.notice ? idle : previous); setFollowAction(previous => previous.error || previous.notice ? idle : previous);
    setAction({ busy: true, error: null, notice: null });
    try {
      await work(controller.signal);
      writing.current = false;
      if (!alive.current || !sameScope(started)) return null;
      setAction({ busy: false, error: null, notice });
      await refresh(); return null;
    } catch (error) {
      writing.current = false;
      if (!alive.current || !sameScope(started)) return null;
      const failure = toFailure(error);
      setAction({ busy: false, error: failure, notice: null });
      if (failure.code === 'context_changed' || failure.outcomeUnknown) await refresh();
      return failure;
    } finally { if (writeCtl.current === controller) writeCtl.current = null; }
  }, [currentScope, sameScope, userId, organizationId]);

  const saveSettings = useCallback((draft: WorkSettingsDraft) => {
    const settings = memoryRef.current?.settings;
    if (!settings) return Promise.resolve(refused);
    return mutate(setMemoryAction, signal => client.configureMemory({ ...draft, expectedAccessVersion: settings.accessVersion }, { signal }),
      'Đã lưu cài đặt ghi nhớ công việc.', () => loadMemory(0));
  }, [client, mutate, loadMemory]);
  const editMemory = useCallback((item: Pick<HermesWorkMemoryItem, 'id' | 'version'>, content: string) =>
    mutate(setMemoryAction, signal => client.editMemory({ id: item.id, expectedVersion: item.version, content }, { signal }),
      'Đã cập nhật ghi chú.', () => loadMemory(0)), [client, mutate, loadMemory]);
  const forgetMemory = useCallback((item: Pick<HermesWorkMemoryItem, 'id' | 'version'>) =>
    mutate(setMemoryAction, signal => client.forgetMemory({ id: item.id, expectedVersion: item.version }, { signal }),
      'Đã quên ghi chú. Bản đã được Hermes lưu ở ngoài CRM không thể thu hồi từ đây.', () => loadMemory(0)), [client, mutate, loadMemory]);
  const stopFollow = useCallback((item: Pick<HermesTaskFollowItem, 'id' | 'version'>) =>
    mutate(setFollowAction, signal => client.stopFollow({ followId: item.id, expectedVersion: item.version }, { signal }),
      'Đã dừng theo dõi. Việc trong CRM không bị đổi.', () => loadFollows(0)), [client, mutate, loadFollows]);

  const setFilter = useCallback((next: WorkFollowFilter) => {
    filterRef.current = next; setFilterState(next); setFollowAction(idle); void loadFollows(0, next);
  }, [loadFollows]);

  return {
    memory, follows, filter, memoryAction, followAction,
    reloadMemory: useCallback(() => loadMemory(0), [loadMemory]),
    moreMemory: useCallback(() => { const next = memoryRef.current?.nextOffset; return next == null ? Promise.resolve() : loadMemory(next); }, [loadMemory]),
    reloadFollows: useCallback(() => loadFollows(0), [loadFollows]),
    moreFollows: useCallback(() => { const next = followsRef.current?.nextOffset; return next == null ? Promise.resolve() : loadFollows(next); }, [loadFollows]),
    setFilter, saveSettings, editMemory, forgetMemory, stopFollow,
    busy: memoryAction.busy || followAction.busy,
  };
}
