import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';
import type { HermesCallerScope } from './connectionClient';

const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const uid = z.string().regex(/^[1-9][0-9]{0,39}$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1);
const owner = { userId: uuid, organizationId: uuid };
type ResponseOwner = z.infer<z.ZodObject<typeof owner>>;
const bot = z.object({ accountId: uuid, name: z.string().max(160), zaloUid: uid }).strict();
const managedBot = z.object({ accountId: uuid, name: z.string().max(160), zaloUid: uid.nullable(), connected: z.boolean(),
  enabled: z.boolean(), version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1) }).strict()
  .refine(value => (!value.connected || value.zaloUid !== null) && (value.version > 0 || !value.enabled));
const binding = z.object({ bindingId: uuid, epoch: positive, state: z.enum(['active', 'revoked']), accountId: uuid, connectionId: uuid, senderUid: uid }).strict();
const page = z.object({ ...owner, status: z.literal('listed'), bindings: z.array(binding).max(100), nextCursor: uuid.nullable() }).strict();
const bots = z.object({ ...owner, status: z.literal('listed'), bots: z.array(bot).max(100), nextCursor: uuid.nullable() }).strict();
const managedBots = z.object({ ...owner, status: z.literal('listed'), bots: z.array(managedBot).max(100), nextCursor: uuid.nullable() }).strict();
const configuredBot = z.object({ ...owner, status: z.literal('configured'), accountId: uuid, version: positive, enabled: z.boolean() }).strict();
const begin = z.object({ ...owner, status: z.literal('waiting'), challengeId: uuid, challenge: z.string().regex(/^hz_[a-f0-9]{64}$/),
  accountId: uuid, connectionId: uuid, expiresAt: positive }).strict();
const status = z.object({ ...owner, status: z.enum(['waiting', 'observed', 'confirmed']), challengeId: uuid, accountId: uuid, connectionId: uuid,
  candidateVersion: z.number().int().min(0).max(1), senderUid: uid.nullable(), expiresAt: positive }).strict()
  .refine(value => value.status === 'waiting' ? value.candidateVersion === 0 && value.senderUid === null : value.candidateVersion === 1 && value.senderUid !== null);
const confirmed = z.object({ ...owner, status: z.literal('active'), bindingId: uuid, epoch: positive, accountId: uuid, connectionId: uuid, senderUid: uid }).strict();
const unlinked = z.object({ ...owner, status: z.literal('revoked'), bindingId: uuid, epoch: positive }).strict();
const beginInput = z.object({ connectionId: uuid, expectedConnectionEpoch: positive, accountId: uuid }).strict();
const confirmInput = z.object({ challengeId: uuid, expectedCandidateVersion: z.literal(1), expectedSenderUid: uid }).strict();
const unlinkInput = z.object({ bindingId: uuid, expectedEpoch: positive }).strict();
const statusInput = z.object({ challengeId: uuid }).strict();
const listInput = z.object({ afterBindingId: uuid.nullable() }).strict();
const botsInput = z.object({ afterAccountId: uuid.nullable() }).strict();
const setBotInput = z.object({ accountId: uuid, expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 2), enabled: z.boolean() }).strict();
export type HermesZaloBot = z.infer<typeof bot>;
export type HermesManagedZaloBot = z.infer<typeof managedBot>;
export type HermesZaloBinding = z.infer<typeof binding>;
export type HermesZaloChallenge = z.infer<typeof begin>;
export type HermesZaloStatus = z.infer<typeof status>;
const statuses = { invalid_request: 400, forbidden: 403, reauthentication_required: 401, context_changed: 409,
  backend_unavailable: 503, binding_outcome_unknown: 503, cancelled: 408, timeout: 504, busy: 429, backend_closed: 503 } as const;
type ErrorCode = keyof typeof statuses | 'invalid_response';
type Operation = 'bots' | 'manageBots' | 'setBot' | 'list' | 'begin' | 'status' | 'confirm' | 'unlink';
const isWrite = (operation: Operation) => ['begin','confirm','unlink','setBot'].includes(operation);
export class HermesZaloClientError extends Error {
  constructor(readonly code: ErrorCode, readonly outcomeUnknown: boolean) { super(code); }
}
interface Session { data: { session: { access_token: string; user: { id: string } } | null }; error: unknown }
interface Options {
  userId: string;
  organizationId: string;
  currentScope: () => HermesCallerScope;
  getSession?: () => Promise<Session>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}
interface RequestOptions { signal?: AbortSignal }
const ordered = (ids: string[], after: string | null, cursor: string | null) => ids.every((id, index) => index === 0 ? after === null || id > after : id > ids[index - 1]) &&
  (cursor === null || ids.length === 100 && cursor === ids.at(-1));

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (response.redirected || !response.body || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '') ||
      length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > 65536)) {
    void response.body?.cancel().catch(() => { /* The invalid response is already rejected. */ });
    throw new Error('invalid_response');
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  const cancel = () => { void reader.cancel().catch(() => { /* Cancellation cannot turn a rejected response into success. */ }); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (!signal.aborted) {
      const next = await reader.read();
      if (signal.aborted) throw new Error('cancelled');
      if (next.done) {
        const data = new Uint8Array(bytes); let offset = 0;
        for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)) as unknown;
      }
      bytes += next.value.byteLength; if (bytes > 65536) throw new Error('invalid_response'); chunks.push(next.value);
    }
    throw new Error('cancelled');
  } finally {
    signal.removeEventListener('abort', cancel); cancel();
    try { reader.releaseLock(); } catch { /* The aborted reader may still be settling. */ }
  }
}

/** No query cache, persistent challenge, automatic write retry, or client-side
 * authority. Every result is tied to the original account/company generation. */
export function createHermesZaloClient({ userId, organizationId, currentScope, getSession = () => supabase.auth.getSession(),
  fetch: request = globalThis.fetch.bind(globalThis), timeoutMs = 30000 }: Options) {
  if (!uuid.safeParse(userId).success || !uuid.safeParse(organizationId).success || typeof currentScope !== 'function' ||
      typeof getSession !== 'function' || typeof request !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new TypeError('invalid_zalo_client');
  async function invoke<I, O extends ResponseOwner>(operation: Operation, input: I, inputSchema: z.ZodType<I>,
    schema: z.ZodType<O>, matches: (result: O, input: I) => boolean, { signal }: RequestOptions = {}): Promise<O> {
    let dispatched = false;
    const failure = (code: ErrorCode, uncertain = dispatched && isWrite(operation)) => new HermesZaloClientError(code, uncertain);
    if (signal?.aborted) throw failure('cancelled');
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw failure('invalid_request');
    const scope = { ...currentScope() };
    const checkScope = () => {
      const current = currentScope();
      if (scope.userId !== userId || scope.organizationId !== organizationId || !Number.isSafeInteger(scope.generation) || scope.generation < 0 ||
          current.userId !== userId || current.organizationId !== organizationId || current.generation !== scope.generation) throw failure('context_changed');
    };
    checkScope();
    const controller = new AbortController(); let rejectStop: (error: HermesZaloClientError) => void = () => {};
    const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
    const stop = (code: ErrorCode) => { rejectStop(failure(dispatched && isWrite(operation) ? 'binding_outcome_unknown' : code)); controller.abort(); };
    const cancel = () => stop('cancelled'); signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const check = () => { checkScope(); if (controller.signal.aborted) throw failure('cancelled'); };
    const session = async () => {
      check(); const result = await getSession(); check();
      const value = result.data.session;
      if (result.error || !value || value.user.id !== userId || value.access_token.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.access_token)) throw failure('reauthentication_required');
      return value.access_token;
    };
    const work = async () => {
      const token = await session(); check();
      const body = JSON.stringify({ ...parsed.data, organizationId });
      if (new TextEncoder().encode(body).byteLength > 4096) throw failure('invalid_request');
      dispatched = true;
      const response = await request('/api/hermes/zalo/' + operation, { method: 'POST', mode: 'same-origin', credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json' }, body, signal: controller.signal });
      check(); const raw = await readJson(response, controller.signal); check(); await session(); check();
      if (response.status !== 200) {
        const error = z.object({ error: z.string() }).strict().safeParse(raw);
        if (!error.success || !Object.prototype.hasOwnProperty.call(statuses, error.data.error)) throw failure('invalid_response');
        const code = error.data.error as keyof typeof statuses;
        if (response.status !== statuses[code]) throw failure('invalid_response');
        throw failure(code, isWrite(operation) && ['backend_unavailable','binding_outcome_unknown','cancelled','timeout'].includes(code));
      }
      const result = schema.safeParse(raw);
      if (!result.success || result.data.userId !== userId || result.data.organizationId !== organizationId || !matches(result.data, parsed.data)) throw failure('invalid_response');
      return result.data;
    };
    try { return await Promise.race([work(), stopped]); }
    catch (error) {
      if (error instanceof HermesZaloClientError) throw error;
      throw failure(dispatched && isWrite(operation) ? 'binding_outcome_unknown' : 'backend_unavailable');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); controller.abort(); }
  }
  return {
    manageBots: (input: z.infer<typeof botsInput>, options?: RequestOptions) => invoke('manageBots', input, botsInput, managedBots,
      (r, q) => ordered(r.bots.map(b => b.accountId), q.afterAccountId, r.nextCursor), options),
    setBot: (input: z.infer<typeof setBotInput>, options?: RequestOptions) => invoke('setBot', input, setBotInput, configuredBot,
      (r, q) => r.accountId === q.accountId && r.enabled === q.enabled && r.version === q.expectedVersion + 1, options),
    bots: (input: z.infer<typeof botsInput>, options?: RequestOptions) => invoke('bots', input, botsInput, bots, (r, q) => ordered(r.bots.map(b => b.accountId), q.afterAccountId, r.nextCursor), options),
    list: (input: z.infer<typeof listInput>, options?: RequestOptions) => invoke('list', input, listInput, page, (r, q) => ordered(r.bindings.map(b => b.bindingId), q.afterBindingId, r.nextCursor), options),
    begin: (input: z.infer<typeof beginInput>, options?: RequestOptions) => invoke('begin', input, beginInput, begin, (r, q) => r.accountId === q.accountId && r.connectionId === q.connectionId && r.expiresAt > Date.now(), options),
    status: (input: z.infer<typeof statusInput>, options?: RequestOptions) => invoke('status', input, statusInput, status, (r, q) => r.challengeId === q.challengeId, options),
    confirm: (input: z.infer<typeof confirmInput>, options?: RequestOptions) => invoke('confirm', input, confirmInput, confirmed, (r, q) => r.senderUid === q.expectedSenderUid, options),
    unlink: (input: z.infer<typeof unlinkInput>, options?: RequestOptions) => invoke('unlink', input, unlinkInput, unlinked, (r, q) => r.bindingId === q.bindingId && [q.expectedEpoch, q.expectedEpoch + 1].includes(r.epoch), options),
  };
}
