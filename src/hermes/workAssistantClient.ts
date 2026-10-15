import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';
import type { HermesCallerScope } from '@/hermes/connectionClient';

const MAX_VERSION = Number.MAX_SAFE_INTEGER - 2;
const MAX_BYTES = 262144;
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const isoTime = z.string().max(64).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/)
  .refine(value => Number.isFinite(Date.parse(value)));
const version = z.number().int().min(0).max(MAX_VERSION);
const positiveVersion = z.number().int().min(1).max(MAX_VERSION);
const offset = z.number().int().min(0).max(200);
const nextOffset = z.number().int().min(0).max(100000).nullable();
const sharing = z.enum(['owner', 'superadmin', 'managers']);

function isPlainText(value: string) {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || code >= 127 && code < 160 || code === 0x2028 || code === 0x2029) return false;
  }
  return true;
}
/** One line of plain text, 1..1000 characters, no control characters or line breaks. */
export const hermesWorkMemoryContent = z.string().min(1).max(1000).refine(isPlainText).refine(value => value.trim().length > 0);

const settingsShape = z.object({ enabled: z.boolean(), sharing, retentionDays: z.number().int().min(1).max(365), accessVersion: version }).strict();
const memoryItem = z.object({
  id: uuid, key: z.string().regex(/^[a-z0-9_]{1,64}$/), content: z.string().min(1).max(1000), version: positiveVersion,
  assistantId: z.string().min(1).max(128), connectionId: z.string().min(1).max(128),
  source: z.object({ channel: z.literal('external_mcp'), label: z.string().min(1).max(200) }).strict(),
  createdAt: isoTime, updatedAt: isoTime, expiresAt: isoTime,
}).strict();
const memoryPage = z.object({
  organizationId: uuid, ownerUserId: uuid, settings: settingsShape,
  personalMemory: z.literal('outside_crm'), remoteCopies: z.literal('not_revocable'),
  items: z.array(memoryItem).max(50), offset, nextOffset, total: z.number().int().min(0).max(1000000),
}).strict().refine(value => new Set(value.items.map(item => item.id)).size === value.items.length);
const configured = z.object({
  organizationId: uuid, ownerUserId: uuid, settings: settingsShape,
  personalMemory: z.literal('outside_crm'), remoteCopies: z.literal('not_revocable'),
}).strict();
const edited = z.object({ organizationId: uuid, ownerUserId: uuid, id: uuid, key: z.string().regex(/^[a-z0-9_]{1,64}$/), version: positiveVersion, expiresAt: isoTime }).strict();
const forgotten = z.object({ organizationId: uuid, ownerUserId: uuid, id: uuid, forgotten: z.literal(true), auditRetained: z.literal(true), remoteCopies: z.literal('not_revocable') }).strict();

const followRole = z.enum(['assigned_by_me', 'assigned_to_me']);
const followState = z.enum(['active', 'closed']);
const followItem = z.object({
  id: uuid, version: positiveVersion, state: z.enum(['active', 'done', 'cancelled', 'revoked']),
  closeReason: z.enum(['stopped', 'job_cancelled', 'job_deleted', 'completed', 'permission_lost', 'membership_lost']).nullable(),
  objective: z.string().max(500), jobId: uuid.nullable(), jobCode: z.string().max(200), jobTitle: z.string().max(1000),
  jobStatus: z.enum(['IN_PROGRESS', 'COMPLETED', 'DELETED', 'UNKNOWN']), deadline: isoTime.nullable(), overdue: z.boolean(),
  assignerUserId: uuid, assignerName: z.string().max(500).nullable(), executorUserId: uuid.nullable(), executorName: z.string().max(500).nullable(),
  mode: z.enum(['self', 'supervisor']), depth: z.number().int().min(0).max(3), remindBeforeMinutes: z.number().int().min(0).max(525600).nullable(),
  notifyAssigner: z.boolean(), createdAt: isoTime, updatedAt: isoTime, closedAt: isoTime.nullable(),
}).strict();
const followPage = z.object({
  organizationId: uuid, userId: uuid, role: followRole, state: followState,
  items: z.array(followItem).max(50), offset, nextOffset,
}).strict().refine(value => new Set(value.items.map(item => item.id)).size === value.items.length);
const followStopped = z.object({ organizationId: uuid, userId: uuid, id: uuid, version: positiveVersion, state: z.literal('cancelled'), closeReason: z.literal('stopped') }).strict();

const configureInput = z.object({ enabled: z.boolean(), sharing, retentionDays: z.number().int().min(1).max(365), expectedAccessVersion: version }).strict();
const editInput = z.object({ id: uuid, expectedVersion: positiveVersion, content: hermesWorkMemoryContent }).strict();
const forgetInput = z.object({ id: uuid, expectedVersion: positiveVersion }).strict();
const followsInput = z.object({ role: followRole, state: followState, offset }).strict();
const stopInput = z.object({ followId: uuid, expectedVersion: positiveVersion }).strict();

export type HermesWorkMemoryPage = z.infer<typeof memoryPage>;
export type HermesWorkMemoryItem = HermesWorkMemoryPage['items'][number];
export type HermesWorkMemorySettings = z.infer<typeof settingsShape>;
export type HermesWorkMemorySharing = z.infer<typeof sharing>;
export type HermesWorkMemoryConfigureInput = z.infer<typeof configureInput>;
export type HermesWorkMemoryEditInput = z.infer<typeof editInput>;
export type HermesWorkMemoryForgetInput = z.infer<typeof forgetInput>;
export type HermesTaskFollowsInput = z.infer<typeof followsInput>;
export type HermesTaskFollowStopInput = z.infer<typeof stopInput>;
export type HermesTaskFollowPage = z.infer<typeof followPage>;
export type HermesTaskFollowItem = HermesTaskFollowPage['items'][number];
export type HermesTaskFollowRole = z.infer<typeof followRole>;
export type HermesTaskFollowState = z.infer<typeof followState>;

export type HermesWorkAssistantErrorCode = 'forbidden' | 'invalid_request' | 'context_changed' | 'reauthentication_required' | 'not_supported'
  | 'cancelled' | 'timeout' | 'invalid_response' | 'backend_unavailable';
export class HermesWorkAssistantError extends Error {
  /** `outcomeUnknown` is true only for writes that may already have reached the server. */
  constructor(readonly code: HermesWorkAssistantErrorCode, readonly outcomeUnknown = false) { super(code); }
}
interface Session { data: { session: { access_token: string; user: { id: string } } | null }; error: unknown }
interface Options {
  userId: string; organizationId: string; currentScope: () => HermesCallerScope;
  getSession?: () => Promise<Session>; fetch?: typeof globalThis.fetch; timeoutMs?: number;
}
interface CallOptions { signal?: AbortSignal }

const rpcError = z.object({ code: z.string() }).passthrough();

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (response.redirected || !response.body || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '') ||
      length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > MAX_BYTES)) {
    void response.body?.cancel().catch(() => { /* Invalid response is already rejected. */ }); throw new Error('invalid_response');
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  const cancel = () => { void reader.cancel().catch(() => { /* Aborted response cannot become successful. */ }); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (!signal.aborted) {
      const next = await reader.read();
      if (signal.aborted) throw new Error('cancelled');
      if (next.done) {
        const buffer = new Uint8Array(bytes); let position = 0;
        for (const chunk of chunks) { buffer.set(chunk, position); position += chunk.byteLength; }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) as unknown;
      }
      bytes += next.value.byteLength; if (bytes > MAX_BYTES) throw new Error('invalid_response'); chunks.push(next.value);
    }
    throw new Error('cancelled');
  } finally { signal.removeEventListener('abort', cancel); cancel(); try { reader.releaseLock(); } catch { /* Aborted stream still settling. */ } }
}

/** Human CRM JWT only. Every call names the selected company and signed-in user; there is
 * no actor argument, no cached authority and no automatic retry of a write. */
export function createHermesWorkAssistantClient({ userId, organizationId, currentScope, getSession = () => supabase.auth.getSession(),
  fetch: request = globalThis.fetch.bind(globalThis), timeoutMs = 30000 }: Options) {
  if (!uuid.safeParse(userId).success || !uuid.safeParse(organizationId).success || typeof currentScope !== 'function' ||
      typeof getSession !== 'function' || typeof request !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new TypeError('invalid_work_assistant_client');
  let writing = false;

  async function invoke<T>(write: boolean, rpc: string, input: Record<string, unknown>, output: z.ZodType<T>, verify: (value: T) => boolean, signal?: AbortSignal): Promise<T> {
    let dispatched = false;
    const failure = (code: HermesWorkAssistantErrorCode, unknown = write && dispatched) => new HermesWorkAssistantError(code, unknown);
    if (signal?.aborted) throw failure('cancelled');
    if (write && writing) throw failure('invalid_request');
    const caller = { ...currentScope() };
    const checkScope = () => {
      const now = currentScope();
      if (caller.userId !== userId || caller.organizationId !== organizationId || !Number.isSafeInteger(caller.generation) || caller.generation < 0 ||
          now.userId !== userId || now.organizationId !== organizationId || now.generation !== caller.generation) throw failure('context_changed');
    };
    checkScope();
    if (write) writing = true;
    const controller = new AbortController(); let stopped = false;
    let rejectStop: (error: HermesWorkAssistantError) => void = () => {};
    const stopPromise = new Promise<never>((_, reject) => { rejectStop = reject; });
    const stop = (code: 'cancelled' | 'timeout') => { if (stopped) return; stopped = true; rejectStop(failure(code)); controller.abort(); };
    const cancel = () => stop('cancelled'); signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const check = () => { checkScope(); if (stopped) throw failure('cancelled'); };
    const work = async () => {
      check(); const result = await getSession(); check(); const session = result.data.session;
      if (result.error || !session || session.user.id !== userId || session.access_token.length > 16384 ||
          !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(session.access_token)) throw failure('reauthentication_required');
      const base = import.meta.env.VITE_SUPABASE_URL, apiKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      if (typeof base !== 'string' || !/^https:\/\/[a-z0-9]{20}\.supabase\.co\/?$/.test(base) || typeof apiKey !== 'string' || !apiKey || apiKey.length > 16384) throw failure('backend_unavailable');
      const body = JSON.stringify({ p_org: organizationId, ...input });
      if (new TextEncoder().encode(body).byteLength > 131072) throw failure('invalid_request');
      check(); dispatched = true;
      const response = await request(base.replace(/\/$/, '') + '/rest/v1/rpc/' + rpc, {
        method: 'POST', mode: 'cors', credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: { authorization: 'Bearer ' + session.access_token, apikey: apiKey, 'content-type': 'application/json', accept: 'application/json',
          'accept-profile': 'public', 'content-profile': 'public', 'x-organization-id': organizationId }, body, signal: controller.signal,
      });
      check();
      if (response.status === 401) { void response.body?.cancel().catch(() => { /* Rejected response. */ }); throw failure('reauthentication_required', false); }
      const raw = await readJson(response, controller.signal); check();
      if (response.status !== 200) {
        const error = rpcError.safeParse(raw);
        if (error.success) {
          const { code } = error.data;
          if (code === '42501' && response.status === 403) throw failure('forbidden', false);
          if (['PT409', '40001'].includes(code) && response.status === 409) throw failure('context_changed', false);
          if (code === '22023' && response.status === 400) throw failure('invalid_request', false);
          if (code === 'PGRST202' && response.status === 404) throw failure('not_supported', false);
          if (code === 'PGRST301') throw failure('reauthentication_required', false);
        }
        throw failure('backend_unavailable');
      }
      const parsed = output.safeParse(raw);
      if (!parsed.success || !verify(parsed.data)) throw failure('invalid_response');
      return parsed.data;
    };
    try { return await Promise.race([work(), stopPromise]); }
    catch (error) { if (error instanceof HermesWorkAssistantError) throw error; throw failure(stopped ? 'cancelled' : 'backend_unavailable'); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); controller.abort(); if (write) writing = false; }
  }
  const invalid = () => new HermesWorkAssistantError('invalid_request', false);
  const same = (value: { organizationId?: string }) => value.organizationId === organizationId;
  const mine = (value: { organizationId?: string; ownerUserId?: string }) => same(value) && value.ownerUserId === userId;

  return {
    memory(position: number, options?: CallOptions): Promise<HermesWorkMemoryPage> {
      const parsed = offset.safeParse(position); if (!parsed.success) return Promise.reject(invalid());
      return invoke(false, 'hermes_my_work_memory_v1', { p_offset: parsed.data }, memoryPage,
        value => mine(value) && value.offset === parsed.data && (value.nextOffset === null || value.nextOffset > value.offset), options?.signal);
    },
    configureMemory(input: HermesWorkMemoryConfigureInput, options?: CallOptions) {
      const parsed = configureInput.safeParse(input); if (!parsed.success) return Promise.reject(invalid());
      const want = parsed.data;
      return invoke(true, 'hermes_my_work_memory_configure_v1', { p_input: want }, configured,
        value => mine(value) && value.settings.enabled === want.enabled && value.settings.sharing === want.sharing &&
          value.settings.retentionDays === want.retentionDays && value.settings.accessVersion === want.expectedAccessVersion + 1, options?.signal);
    },
    editMemory(input: HermesWorkMemoryEditInput, options?: CallOptions) {
      const parsed = editInput.safeParse(input); if (!parsed.success) return Promise.reject(invalid());
      const want = parsed.data;
      return invoke(true, 'hermes_my_work_memory_edit_v1', { p_input: want }, edited,
        value => mine(value) && value.id === want.id && value.version === want.expectedVersion + 1, options?.signal);
    },
    forgetMemory(input: HermesWorkMemoryForgetInput, options?: CallOptions) {
      const parsed = forgetInput.safeParse(input); if (!parsed.success) return Promise.reject(invalid());
      const want = parsed.data;
      return invoke(true, 'hermes_my_work_memory_forget_v1', { p_input: want }, forgotten,
        value => mine(value) && value.id === want.id, options?.signal);
    },
    follows(input: HermesTaskFollowsInput, options?: CallOptions): Promise<HermesTaskFollowPage> {
      const parsed = followsInput.safeParse(input); if (!parsed.success) return Promise.reject(invalid());
      const want = parsed.data;
      return invoke(false, 'hermes_my_task_follows_v1', { p_input: want }, followPage,
        value => same(value) && value.userId === userId && value.role === want.role && value.state === want.state &&
          value.offset === want.offset && (value.nextOffset === null || value.nextOffset > value.offset), options?.signal);
    },
    stopFollow(input: HermesTaskFollowStopInput, options?: CallOptions) {
      const parsed = stopInput.safeParse(input); if (!parsed.success) return Promise.reject(invalid());
      const want = parsed.data;
      return invoke(true, 'hermes_my_task_follow_stop_v1', { p_input: want }, followStopped,
        value => same(value) && value.userId === userId && value.id === want.followId, options?.signal);
    },
  };
}
export type HermesWorkAssistantClient = ReturnType<typeof createHermesWorkAssistantClient>;
