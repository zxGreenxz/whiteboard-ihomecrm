import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';
import type { HermesCallerScope } from './connectionClient';

const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const kind = z.enum(['queue_job', 'private_command']);
const decision = z.enum(['sent', 'not_sent']);
// Same printable-text rule as the SQL ledger; newline and tab are allowed.
// eslint-disable-next-line no-control-regex
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// SQL bounds (char_length, left(...,160)) count code points. UTF-16 `.length`
// would count an emoji twice and turn the whole list into invalid_response.
const codePoints = (value: string) => Array.from(value).length;
const bounded = (max: number) => z.string().refine(value => codePoints(value) <= max);
const note = z.string().refine(value => codePoints(value) >= 1 && codePoints(value) <= 500 && value.trim() !== '' && !controls.test(value));
const item = z.object({ kind, id: uuid,
  origin: z.enum(['automation', 'hermes_schedule', 'hermes_connector', 'hermes_private_command', 'private_reply']),
  scheduleId: uuid.nullable(), conversationId: uuid.nullable(), conversationName: bounded(160).nullable(),
  preview: bounded(160).nullable(), errorCode: z.string().regex(/^[A-Za-z][A-Za-z_]{0,63}$/).nullable(),
  createdAt: iso, processedAt: iso.nullable() }).strict()
  .refine(value => value.kind === 'private_command'
    ? value.origin === 'private_reply' && value.conversationId === null && value.preview === null && value.scheduleId === null
    : value.origin !== 'private_reply' && (value.origin === 'hermes_schedule') === (value.scheduleId !== null));
const decided = z.object({ id: uuid, kind, targetId: uuid, decision, note, via: z.enum(['crm_ui', 'hermes_connector']), createdAt: iso }).strict();
const snapshot = z.object({ organizationId: uuid, userId: uuid, canManage: z.boolean(), items: z.array(item).max(50),
  recent: z.array(decided.extend({ mine: z.boolean() }).strict()).max(20) }).strict()
  .refine(value => new Set(value.items.map(entry => entry.id)).size === value.items.length);
const ack = z.object({ organizationId: uuid, userId: uuid, reconciliation: decided }).strict();
const resolveInput = z.object({ requestId: uuid, kind, targetId: uuid, decision, note }).strict();
export type HermesUnknownDelivery = z.infer<typeof item>;
export type HermesDeliveryDecision = z.infer<typeof decided>;
export type HermesReconcileSnapshot = z.infer<typeof snapshot>;
export type HermesReconcileInput = z.infer<typeof resolveInput>;
type ErrorCode = 'invalid_request' | 'forbidden' | 'conflict' | 'context_changed' | 'reauthentication_required' | 'cancelled' | 'timeout'
  | 'invalid_response' | 'backend_unavailable' | 'reconcile_outcome_unknown';
export class HermesReconcileError extends Error {
  constructor(readonly code: ErrorCode, readonly outcomeUnknown = false) { super(code); }
}
interface Session { data: { session: { access_token: string; user: { id: string } } | null }; error: unknown }
interface Options {
  userId: string; organizationId: string; currentScope: () => HermesCallerScope;
  getSession?: () => Promise<Session>; fetch?: typeof globalThis.fetch; timeoutMs?: number;
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (response.redirected || !response.body || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '') ||
      length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > 262144)) {
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
        const buffer = new Uint8Array(bytes); let offset = 0;
        for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) as unknown;
      }
      bytes += next.value.byteLength; if (bytes > 262144) throw new Error('invalid_response'); chunks.push(next.value);
    }
    throw new Error('cancelled');
  } finally { signal.removeEventListener('abort', cancel); cancel(); try { reader.releaseLock(); } catch { /* Aborted stream still settling. */ } }
}

/** Human CRM JWT only. Reading and recording an attestation never sends a
 * Zalo message; a lost write reply is reported as unknown and may be repeated
 * only with the SAME request ID (the SQL ledger is idempotent per request). */
export function createHermesReconcileClient({ userId, organizationId, currentScope, getSession = () => supabase.auth.getSession(),
  fetch: request = globalThis.fetch.bind(globalThis), timeoutMs = 30000 }: Options) {
  if (!uuid.safeParse(userId).success || !uuid.safeParse(organizationId).success || typeof currentScope !== 'function' ||
      typeof getSession !== 'function' || typeof request !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new TypeError('invalid_reconcile_client');
  async function invoke(write: boolean, input: HermesReconcileInput | null, signal?: AbortSignal): Promise<unknown> {
    let dispatched = false;
    const failure = (code: ErrorCode, unknown = write && dispatched) => new HermesReconcileError(unknown ? 'reconcile_outcome_unknown' : code, unknown);
    if (signal?.aborted) throw failure('cancelled');
    const caller = { ...currentScope() };
    const checkScope = () => {
      const now = currentScope();
      if (caller.userId !== userId || caller.organizationId !== organizationId || !Number.isSafeInteger(caller.generation) || caller.generation < 0 ||
          now.userId !== userId || now.organizationId !== organizationId || now.generation !== caller.generation) throw failure('context_changed');
    };
    checkScope();
    const controller = new AbortController(); let stopped = false;
    let rejectStop: (error: HermesReconcileError) => void = () => {};
    const stopPromise = new Promise<never>((_, reject) => { rejectStop = reject; });
    const stop = (code: 'cancelled' | 'timeout') => { if (stopped) return; stopped = true; rejectStop(failure(code)); controller.abort(); };
    const cancel = () => stop('cancelled'); signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const check = () => { checkScope(); if (stopped) throw failure('cancelled'); };
    const session = async () => {
      check(); const result = await getSession(); check(); const value = result.data.session;
      if (result.error || !value || value.user.id !== userId || value.access_token.length > 16384 ||
          !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.access_token)) throw failure('reauthentication_required', false);
      return value.access_token;
    };
    const work = async () => {
      const token = await session(); check();
      const base = import.meta.env.VITE_SUPABASE_URL, apiKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      if (typeof base !== 'string' || !/^https:\/\/[a-z0-9]{20}\.supabase\.co\/?$/.test(base) || typeof apiKey !== 'string' || !apiKey || apiKey.length > 16384) throw failure('backend_unavailable', false);
      const body = JSON.stringify(input ? { p: { organizationId, ...input } } : { p_organization_id: organizationId });
      if (new TextEncoder().encode(body).byteLength > 8192) throw failure('invalid_request', false);
      dispatched = true;
      const response = await request(base.replace(/\/$/, '') + '/rest/v1/rpc/' + (write ? 'hermes_delivery_reconcile_resolve_v1' : 'hermes_delivery_reconcile_list_v1'), {
        method: 'POST', mode: 'cors', credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: { authorization: 'Bearer ' + token, apikey: apiKey, 'content-type': 'application/json', accept: 'application/json',
          'accept-profile': 'public', 'content-profile': 'public', 'x-organization-id': organizationId }, body, signal: controller.signal,
      });
      check(); const raw = await readJson(response, controller.signal); check(); await session(); check();
      if (response.status !== 200) {
        const error = z.object({ code: z.string(), message: z.string(), details: z.string().nullable(), hint: z.string().nullable() }).strict().safeParse(raw);
        // A definite refusal never applied the attestation.
        if (error.success) {
          const { code } = error.data;
          if (code === '42501' && response.status === 403) throw failure('forbidden', false);
          if (code === 'PT409' && response.status === 409) throw failure('conflict', false);
          if (code === '22023' && response.status === 400) throw failure('invalid_request', false);
          if (code === 'PGRST202' && response.status === 404) throw failure('backend_unavailable', false);
          if (code === 'PGRST301' && response.status === 401) throw failure('reauthentication_required', false);
        }
        throw failure('backend_unavailable');
      }
      if (input) {
        const result = ack.safeParse(raw);
        if (!result.success || result.data.organizationId !== organizationId || result.data.userId !== userId ||
            result.data.reconciliation.targetId !== input.targetId || result.data.reconciliation.kind !== input.kind ||
            result.data.reconciliation.decision !== input.decision || result.data.reconciliation.note !== input.note ||
            result.data.reconciliation.via !== 'crm_ui') throw failure('invalid_response');
        return result.data.reconciliation;
      }
      const result = snapshot.safeParse(raw);
      if (!result.success || result.data.organizationId !== organizationId || result.data.userId !== userId) throw failure('invalid_response');
      return result.data;
    };
    try { return await Promise.race([work(), stopPromise]); }
    catch (error) { if (error instanceof HermesReconcileError) throw error; throw failure('backend_unavailable'); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); controller.abort(); }
  }
  return {
    list: (options?: { signal?: AbortSignal }) => invoke(false, null, options?.signal) as Promise<HermesReconcileSnapshot>,
    resolve: (input: HermesReconcileInput, options?: { signal?: AbortSignal }) => {
      const parsed = resolveInput.safeParse(input);
      if (!parsed.success) return Promise.reject(new HermesReconcileError('invalid_request'));
      return invoke(true, parsed.data, options?.signal) as Promise<HermesDeliveryDecision>;
    },
  };
}
