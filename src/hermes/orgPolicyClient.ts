import { HERMES_READ_CAPABILITIES, HERMES_ACTION_CAPABILITIES } from '../../infra/hermes-broker/capability-contract.mjs';
import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';
import type { HermesCallerScope } from '@/hermes/connectionClient';

const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 2);
const capability = z.string().regex(/^[a-z][a-z0-9_.:-]{0,127}$/);
const ids = z.array(uuid).max(256).refine(values => new Set(values).size === values.length);
const capabilities = z.array(capability).max(256);
const knownRead = z.array(z.string().refine(key => HERMES_READ_CAPABILITIES.includes(key))).max(HERMES_READ_CAPABILITIES.length).refine(values => new Set(values).size === values.length);
const scope = z.object({ scopeId: uuid, scopeType: z.enum(['ORGANIZATION','AREA','BUILDING']), label: z.string().min(1).max(1024),
  buildingId: uuid.nullable(), areaId: uuid.nullable(), cashbookId: z.null() }).strict().refine(value =>
  value.scopeType === 'ORGANIZATION' ? value.buildingId === null && value.areaId === null :
    value.scopeType === 'BUILDING' ? value.buildingId !== null && value.areaId === null : value.areaId !== null && value.buildingId === null)
  // Preserve required picker keys under both the app compiler and strict islands.
  .transform(value => ({ scopeId: value.scopeId, scopeType: value.scopeType, label: value.label,
    buildingId: value.buildingId, areaId: value.areaId, cashbookId: value.cashbookId }));
// Version 0 is the server's neutral ceiling when no explicit policy exists.
// It is read metadata only; a successful explicit policy write starts at 1.
const policy = z.object({ organizationId: uuid, version, enabled: z.boolean(), read: capabilities, action: capabilities, scopeIds: ids }).strict();
const snapshot = z.object({ userId: uuid, organizationId: uuid, membershipId: uuid, authorizationVersion: version, isSuperadmin: z.boolean(),
  policy, choices: z.object({ read: knownRead, action: z.array(z.string().refine(key => HERMES_ACTION_CAPABILITIES.includes(key))).max(HERMES_ACTION_CAPABILITIES.length).refine(values => new Set(values).size === values.length), scopes: z.array(scope).max(256) }).strict(),
  storedScopes: z.array(z.object({ scopeId: uuid, label: z.string().min(1).max(1024), available: z.boolean() }).strict()).max(256),
}).strict().refine(value => {
  const scopeIds = value.choices.scopes.map(item => item.scopeId), stored = value.storedScopes.map(item => item.scopeId);
  return value.policy.organizationId === value.organizationId && new Set(scopeIds).size === scopeIds.length &&
    new Set(stored).size === stored.length && sameSet(stored, value.policy.scopeIds) &&
    value.storedScopes.every(item => item.available === scopeIds.includes(item.scopeId));
});
const saveInput = z.object({ expectedVersion: version, enabled: z.boolean(), read: capabilities, action: capabilities, scopeIds: ids }).strict();
export type HermesOrgPolicy = z.infer<typeof policy>;
export type HermesOrgPolicySnapshot = z.infer<typeof snapshot>;
export type HermesOrgPolicyInput = z.infer<typeof saveInput>;
type ErrorCode = 'invalid_request' | 'context_changed' | 'forbidden' | 'reauthentication_required' | 'cancelled' | 'timeout' | 'invalid_response' | 'backend_unavailable' | 'policy_outcome_unknown';
export class HermesOrgPolicyError extends Error {
  constructor(readonly code: ErrorCode, readonly outcomeUnknown = false) { super(code); }
}
interface Session { data: { session: { access_token: string; user: { id: string } } | null }; error: unknown }
interface Options {
  userId: string; organizationId: string; currentScope: () => HermesCallerScope;
  getSession?: () => Promise<Session>; fetch?: typeof globalThis.fetch; timeoutMs?: number;
}
const sameSet = (left: string[], right: string[]) => left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
const subset = (next: string[], allowed: string[]) => next.every(value => allowed.includes(value));
const positiveAck = policy.refine(value => value.version > 0);

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

/** Human CRM JWT only; no model-facing port, service key, cached policy authority,
 * automatic policy defaults, actor argument, or automatic mutation retry. */
export function createHermesOrgPolicyClient({ userId, organizationId, currentScope, getSession = () => supabase.auth.getSession(),
  fetch: request = globalThis.fetch.bind(globalThis), timeoutMs = 30000 }: Options) {
  if (!uuid.safeParse(userId).success || !uuid.safeParse(organizationId).success || typeof currentScope !== 'function' ||
      typeof getSession !== 'function' || typeof request !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new TypeError('invalid_policy_client');
  let observed: HermesOrgPolicySnapshot | null = null;
  let observedGeneration: number | null = null;
  let pending = false;
  async function invoke(write: boolean, input: unknown, signal?: AbortSignal): Promise<HermesOrgPolicySnapshot | HermesOrgPolicy> {
    let dispatched = false;
    const failure = (code: ErrorCode, unknown = write && dispatched) => new HermesOrgPolicyError(code, unknown);
    if (pending) throw failure('invalid_request');
    if (signal?.aborted) throw failure('cancelled');
    const caller = { ...currentScope() };
    const checkScope = () => {
      const now = currentScope();
      if (caller.userId !== userId || caller.organizationId !== organizationId || !Number.isSafeInteger(caller.generation) || caller.generation < 0 ||
          now.userId !== userId || now.organizationId !== organizationId || now.generation !== caller.generation) throw failure('context_changed');
    };
    checkScope();
    let target: HermesOrgPolicyInput | undefined;
    if (write) {
      let parsed: ReturnType<typeof saveInput.safeParse>;
      try { parsed = saveInput.safeParse(input); } catch { throw failure('invalid_request'); }
      if (!parsed.success || !observed || observedGeneration !== caller.generation || parsed.data.expectedVersion !== observed.policy.version ||
          !subset(parsed.data.read, [...observed.policy.read, ...observed.choices.read]) ||
          !subset(parsed.data.action, [...observed.policy.action, ...observed.choices.action]) ||
          !subset(parsed.data.scopeIds, [...observed.policy.scopeIds, ...observed.choices.scopes.map(item => item.scopeId)])) throw failure('invalid_request');
      target = parsed.data;
    }
    observed = null; observedGeneration = null; pending = true;
    const controller = new AbortController(); let stopped = false;
    let rejectStop: (error: HermesOrgPolicyError) => void = () => {};
    const stopPromise = new Promise<never>((_, reject) => { rejectStop = reject; });
    const stop = (code: 'cancelled' | 'timeout') => { if (stopped) return; stopped = true; rejectStop(failure(write && dispatched ? 'policy_outcome_unknown' : code)); controller.abort(); };
    const cancel = () => stop('cancelled'); signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const check = () => { checkScope(); if (stopped) throw failure(write && dispatched ? 'policy_outcome_unknown' : 'cancelled'); };
    const session = async () => {
      check(); const result = await getSession(); check(); const value = result.data.session;
      if (result.error || !value || value.user.id !== userId || value.access_token.length > 16384 ||
          !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.access_token)) throw failure('reauthentication_required');
      return value.access_token;
    };
    const work = async () => {
      const token = await session(); check();
      const base = import.meta.env.VITE_SUPABASE_URL, apiKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      if (typeof base !== 'string' || !/^https:\/\/[a-z0-9]{20}\.supabase\.co\/?$/.test(base) || typeof apiKey !== 'string' || !apiKey || apiKey.length > 16384) throw failure('backend_unavailable');
      const body = JSON.stringify(target ? { p_org: organizationId, p_expected_version: target.expectedVersion, p_enabled: target.enabled,
        p_read: target.read, p_action: target.action, p_scope_ids: target.scopeIds } : { p_org: organizationId });
      if (new TextEncoder().encode(body).byteLength > 131072) throw failure('invalid_request');
      dispatched = true;
      const send = async (rpc: string) => {
        const response = await request(base.replace(/\/$/, '') + '/rest/v1/rpc/' + rpc, {
          method: 'POST', mode: 'cors', credentials: 'omit', redirect: 'error', cache: 'no-store',
          headers: { authorization: 'Bearer ' + token, apikey: apiKey, 'content-type': 'application/json', accept: 'application/json',
            'accept-profile': 'public', 'content-profile': 'public', 'x-organization-id': organizationId }, body, signal: controller.signal,
        });
        check(); const raw = await readJson(response, controller.signal); check();
        return { response, raw };
      };
      // v6 = task-follow(v5), v5 = finance(task(v4)); older names only on exact PGRST202.
      let { response, raw } = await send(write ? 'hermes_set_org_policy_v1' : 'hermes_org_policy_options_v6');
      const missing = z.object({ code: z.literal('PGRST202'), message: z.string(), details: z.string().nullable(), hint: z.string().nullable() }).strict();
      for (const legacy of write ? [] : ['hermes_org_policy_options_v5', 'hermes_org_policy_options_v4', 'hermes_org_policy_options_v3', 'hermes_org_policy_options_v2', 'hermes_org_policy_options_v1']) {
        if (!(response.status === 404 && missing.safeParse(raw).success)) break;
        await session(); check();
        ({ response, raw } = await send(legacy));
      }
      await session(); check();
      if (response.status !== 200) {
        const error = z.object({ code: z.string(), message: z.string(), details: z.string().nullable(), hint: z.string().nullable() }).strict().safeParse(raw);
        if (error.success) {
          const { code } = error.data;
          if (code === '42501' && response.status === 403) throw failure('forbidden', false);
          if (['PT409','40001'].includes(code) && response.status === 409) throw failure('context_changed', false);
          if (code === '22023' && response.status === 400) throw failure('invalid_request', false);
          if (code === 'PGRST301' && response.status === 401) throw failure('reauthentication_required', false);
        }
        throw failure(write ? 'policy_outcome_unknown' : 'backend_unavailable');
      }
      if (target) {
        const result = positiveAck.safeParse(raw);
        if (!result.success || result.data.organizationId !== organizationId || result.data.version !== target.expectedVersion + 1 ||
            result.data.enabled !== target.enabled || !sameSet(result.data.read,target.read) || !sameSet(result.data.action,target.action) ||
            !sameSet(result.data.scopeIds,target.scopeIds)) throw failure('policy_outcome_unknown');
        return result.data;
      }
      const result = snapshot.safeParse(raw);
      if (!result.success || result.data.organizationId !== organizationId || result.data.userId !== userId) throw failure('invalid_response');
      observed = structuredClone(result.data);
      observedGeneration = caller.generation;
      return result.data;
    };
    try { return await Promise.race([work(), stopPromise]); }
    catch (error) { if (error instanceof HermesOrgPolicyError) throw error; throw failure(write && dispatched ? 'policy_outcome_unknown' : 'backend_unavailable'); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); controller.abort(); pending = false; }
  }
  return {
    load: (options?: { signal?: AbortSignal }) => invoke(false, undefined, options?.signal) as Promise<HermesOrgPolicySnapshot>,
    save: (input: HermesOrgPolicyInput, options?: { signal?: AbortSignal }) => invoke(true, input, options?.signal) as Promise<HermesOrgPolicy>,
  };
}
