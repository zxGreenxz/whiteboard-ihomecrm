import { HERMES_READ_CAPABILITIES, HERMES_ACTION_CAPABILITIES, requiresBuildingScope } from '../../infra/hermes-broker/capability-contract.mjs';
import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const policyVersion = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1);
const unique = <T extends z.ZodTypeAny>(item: T) => z.array(item).max(256)
  .refine(values => new Set(values).size === values.length);
const ids = unique(uuid);
const capabilities = unique(z.string().regex(/^[a-z][a-z0-9_.:-]{0,127}$/));
const restrictions = z.object({ read: capabilities, action: capabilities }).strict();
const scopeChoice = z.object({ scopeId: uuid, scopeType: z.enum(['ORGANIZATION', 'AREA', 'BUILDING']),
  label: z.string().min(1).refine(value => value.trim().length > 0 && !value.includes('\0') && new TextEncoder().encode(value).byteLength <= 1024),
  buildingId: uuid.nullable(), areaId: uuid.nullable(), cashbookId: z.null(),
}).strict().refine(value => value.scopeType === 'BUILDING' ? value.buildingId !== null && value.areaId === null
  : value.scopeType === 'AREA' ? value.areaId !== null && value.buildingId === null : value.buildingId === null && value.areaId === null)
  // Keep required output keys in both strict islands and the non-strict app
  // compiler; Zod's object inference otherwise makes them optional in the latter.
  .transform(value => ({ scopeId: value.scopeId, scopeType: value.scopeType, label: value.label,
    buildingId: value.buildingId, areaId: value.areaId, cashbookId: value.cashbookId }));
const grantOptions = z.object({ userId: uuid, organizationId: uuid, membershipId: uuid, authorizationVersion: positive,
  isSuperadmin: z.boolean(), policyVersion, enabled: z.boolean(),
  read: unique(z.string().refine(key => HERMES_READ_CAPABILITIES.includes(key))), action: unique(z.string().refine(key => HERMES_ACTION_CAPABILITIES.includes(key))),
  scopes: z.array(scopeChoice).max(256).refine(value => new Set(value.map(scope => scope.scopeId)).size === value.length),
}).strict().refine(value =>
  (value.enabled || value.read.length === 0 && value.action.length === 0 && value.scopes.length === 0) && requiresBuildingScope(value.read, value.action) === (value.scopes.length > 0));
const row = z.object({
  id: uuid, assistantId: uuid, organizationId: uuid, userId: uuid,
  state: z.enum(['pending', 'active', 'revoked']), epoch: positive, restrictions, scopeIds: ids,
}).strict();
const context = row.extend({
  state: z.literal('active'), membershipId: uuid, authorizationVersion: positive,
  isSuperadmin: z.boolean(), policyVersion, companyCeilings: restrictions, effective: restrictions,
}).refine(value => (['read', 'action'] as const).every(kind => value.effective[kind]
  .every(key => value.restrictions[kind].includes(key) && value.companyCeilings[kind].includes(key))));
const emptyInput = z.object({}).strict();
const contextInput = z.object({ connectionId: uuid }).strict();
const revokeInput = contextInput.extend({ expectedEpoch: positive });
const restrictInput = revokeInput.extend({ restrictions, scopeIds: ids });
const connectInput = z.object({
  email: z.string().max(320).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)
    .refine(value => [...value].every(char => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127)),
  password: z.string().min(1).refine(value => new TextEncoder().encode(value).byteLength <= 4096),
  restrictions, scopeIds: ids,
}).strict().refine(value => value.restrictions.action.every(key => HERMES_ACTION_CAPABILITIES.includes(key)) &&
  value.restrictions.read.every(key => HERMES_READ_CAPABILITIES.includes(key)));
const listResult = z.object({ connections: z.array(row).max(256)
  .refine(values => new Set(values.map(value => value.id)).size === values.length) }).strict();
const contextResult = z.object({ context }).strict();
const optionsResult = z.object({ options: grantOptions }).strict();
const connectResult = z.object({ status: z.literal('active'), connection: row.extend({ state: z.literal('active') }),
  token: z.string().regex(/^hc_[A-Za-z0-9_-]{43}$/), tokenExpiresAt: positive }).strict();
const restrictResult = z.object({ ok: z.literal(true), connection: row.extend({ state: z.literal('active') }) }).strict();
const revokeResult = z.object({ ok: z.literal(true), status: z.enum(['revoked', 'already_revoked']), connectionId: uuid }).strict();

/** These states are stored connection metadata, not a runtime health check. */
export type HermesConnectionMetadata = z.infer<typeof row>;
export type HermesConnectionContext = z.infer<typeof context>;
export type HermesConnectionRestrictions = z.infer<typeof restrictions>;
export type HermesGrantOptions = z.infer<typeof grantOptions>;
export type HermesConnectInput = z.infer<typeof connectInput>;
export type HermesRestrictInput = z.infer<typeof restrictInput>;
export type HermesRevokeInput = z.infer<typeof revokeInput>;
/** One-time opaque handoff only. The caller must not put this result in a query cache or persistent browser storage. */
export type HermesConnectResult = z.infer<typeof connectResult>;

const statuses = {
  invalid_request: 400, reauthentication_required: 401, forbidden: 403, context_changed: 409,
  cancelled: 408, timeout: 504, backend_unavailable: 503, additional_authentication_required: 403,
  sign_in_outcome_unknown: 503, prepare_rejected: 409, prepare_outcome_unknown: 503,
  activation_rejected: 409, activation_outcome_unknown: 503, operation_rejected: 409, operation_outcome_unknown: 503,
  duplicate_header: 400, too_many_headers: 431, method_not_allowed: 405, unsupported_content_encoding: 415,
  unsupported_content_type: 415, invalid_json: 400, body_too_large: 413, busy: 429,
} as const;
type ServerCode = keyof typeof statuses;
export type HermesConnectionErrorCode = ServerCode | 'invalid_response';
type Operation = 'list' | 'context' | 'options' | 'connect' | 'restrict' | 'revoke';
type WriteOperation = 'connect' | 'restrict' | 'revoke';
type Outcome = 'not_dispatched' | 'rejected' | 'unknown';
const serverCode = z.custom<ServerCode>(value => typeof value === 'string' && Object.prototype.hasOwnProperty.call(statuses, value));
const connectReceipt = z.object({ connectionId: uuid, operationId: uuid }).strict();
const mutationReceipt = revokeInput.extend({ operation: z.enum(['restrict', 'revoke']) });
const errorResult = z.object({ error: serverCode, receipt: z.union([connectReceipt, mutationReceipt]).optional() }).strict();

/** Only locally pinned request identifiers; never a server message, JWT, password, token, or unbound server ID. */
export interface HermesRequestReceipt {
  readonly operation: WriteOperation;
  readonly userId: string;
  readonly organizationId: string;
  readonly connectionId?: string;
  readonly expectedEpoch?: number;
}
export class HermesConnectionClientError extends Error {
  readonly outcomeUnknown: boolean;
  constructor(readonly code: HermesConnectionErrorCode, readonly outcome: Outcome, readonly receipt?: HermesRequestReceipt) {
    super(code);
    this.name = 'HermesConnectionClientError';
    this.outcomeUnknown = outcome === 'unknown';
  }
}
export interface HermesCallerScope {
  userId: string | null;
  organizationId: string | null;
  /** Increment on every account/company transition, including A -> B -> A. */
  generation: number;
}
interface SessionResult {
  data: { session: { access_token: string; user: { id: string } } | null };
  error: unknown;
}
export interface HermesConnectionClientOptions {
  userId: string;
  organizationId: string;
  currentScope: () => HermesCallerScope;
  /** Dependency injection for tests; the default reads the existing CRM browser session. */
  getSession?: () => Promise<SessionResult>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}
export interface HermesRequestOptions { signal?: AbortSignal }

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(value => b.includes(value));
const sameRestrictions = (a: HermesConnectionRestrictions, b: HermesConnectionRestrictions) =>
  sameSet(a.read, b.read) && sameSet(a.action, b.action);
const writeOperation = (operation: Operation): operation is WriteOperation => !['list', 'context', 'options'].includes(operation);
const MAX_REQUEST_BYTES = 65_536;
const MAX_RESPONSE_BYTES = 1_048_576;

/** Parse bytes before JSON and never preserve a failed response body in an error. */
async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (response.redirected || response.type === 'opaque' || response.type === 'opaqueredirect' ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '') ||
      (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > MAX_RESPONSE_BYTES)) || !response.body) {
    void response.body?.cancel().catch(() => { /* Cleanup cannot change the invalid-response rejection. */ });
    throw new Error('invalid_response');
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => { /* The request already reports cancellation or invalid response. */ }); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0, complete = false;
  try {
    while (!signal.aborted) {
      const next = await reader.read();
      if (signal.aborted) throw new Error('cancelled');
      if (next.done) { complete = true; break; }
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('invalid_response');
      chunks.push(next.value);
    }
    if (signal.aborted || !complete) throw new Error('cancelled');
    const combined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(combined)) as unknown;
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) cancel();
    try { reader.releaseLock(); } catch { /* An aborted read may still be settling. */ }
  }
}

/** Fixed, same-origin POST routes. The server verifies Auth and CRM rights.
 * This client adds stale-screen fences only; local session checks are not authority.
 * No retries, cookie fallback, arbitrary URL/RPC, password sign-in in the browser,
 * result cache, token persistence, or claims of durable one-time-token delivery.
 * Password/request references exist only for the call; JavaScript cannot promise erasure.
 */
export function createHermesConnectionClient(options: HermesConnectionClientOptions) {
  const { userId, organizationId, currentScope, getSession = () => supabase.auth.getSession(),
    fetch: fetcher = globalThis.fetch.bind(globalThis), timeoutMs = 30_000 } = options;
  if (!uuid.safeParse(userId).success || !uuid.safeParse(organizationId).success || typeof currentScope !== 'function' ||
      typeof getSession !== 'function' || typeof fetcher !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 ||
      Object.keys(options).some(key => !['userId', 'organizationId', 'currentScope', 'getSession', 'fetch', 'timeoutMs'].includes(key))) {
    throw new TypeError('invalid_hermes_client_config');
  }
  const ownRow = (value: HermesConnectionMetadata) => value.userId === userId && value.organizationId === organizationId;

  async function invoke<Input, Result>(operation: Operation, input: Input, inputSchema: z.ZodType<Input>,
    resultSchema: z.ZodType<Result, z.ZodTypeDef, unknown>, matches: (result: Result, request: Input) => boolean,
    { signal }: HermesRequestOptions = {}): Promise<Result> {
    let dispatched = false;
    const write = writeOperation(operation);
    let receipt: HermesRequestReceipt | undefined;
    const failure = (code: HermesConnectionErrorCode, outcome?: Outcome) => new HermesConnectionClientError(code,
      outcome ?? (dispatched ? write ? 'unknown' : 'rejected' : 'not_dispatched'), receipt);
    if (signal?.aborted) throw failure('cancelled');
    let parsed: z.SafeParseReturnType<Input, Input>;
    try { parsed = inputSchema.safeParse(input); } catch { throw failure('invalid_request'); }
    if (!parsed.success) throw failure('invalid_request');
    const request = parsed.data; // Zod gives a detached snapshot before any await.
    if (write) {
      const mutation = revokeInput.safeParse(Object.fromEntries(Object.entries(request as object)
        .filter(([key]) => key === 'connectionId' || key === 'expectedEpoch')));
      receipt = Object.freeze({ operation, userId, organizationId,
        ...(operation !== 'connect' && mutation.success ? mutation.data : {}) });
    }
    let serialized = JSON.stringify({ ...request, organizationId });
    if (new TextEncoder().encode(serialized).byteLength > MAX_REQUEST_BYTES) throw failure('invalid_request');
    const checkScope = (expectedGeneration?: number) => {
      let scope: HermesCallerScope;
      try { scope = currentScope(); } catch { throw failure('context_changed'); }
      if (!scope || scope.userId !== userId || scope.organizationId !== organizationId ||
          !Number.isSafeInteger(scope.generation) || scope.generation < 0 ||
          (expectedGeneration !== undefined && scope.generation !== expectedGeneration)) throw failure('context_changed');
      return scope.generation;
    };
    const generation = checkScope();
    const controller = new AbortController();
    let stopped: 'cancelled' | 'timeout' | undefined;
    let rejectStop: (reason: HermesConnectionClientError) => void = () => {};
    const stopPromise = new Promise<never>((_, reject) => { rejectStop = reject; });
    const stop = (code: 'cancelled' | 'timeout') => {
      if (stopped) return;
      stopped = code;
      rejectStop(failure(write && dispatched ? 'operation_outcome_unknown' : code));
      controller.abort();
    };
    const cancel = () => stop('cancelled');
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const check = () => {
      if (stopped) throw failure(write && dispatched ? 'operation_outcome_unknown' : stopped);
      checkScope(generation);
    };
    const session = async () => {
      check();
      const value = await getSession();
      check();
      const candidate = value?.data?.session;
      if (value?.error || !candidate || candidate.user?.id !== userId || typeof candidate.access_token !== 'string' ||
          candidate.access_token.length > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(candidate.access_token)) {
        throw failure('reauthentication_required');
      }
      return candidate.access_token;
    };
    const work = async () => {
      const accessToken = await session();
      check();
      dispatched = true; // Even a synchronous fetch rejection does not prove no write occurred.
      const response = await fetcher(`/api/hermes/connections/${operation}`, {
        method: 'POST', mode: 'same-origin', credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json' },
        body: serialized, signal: controller.signal,
      });
      check();
      const body = await readJson(response, controller.signal);
      check();
      await session();
      check();
      if (response.status !== 200) {
        const error = errorResult.safeParse(body);
        if (!error.success || statuses[error.data.error] !== response.status) throw failure(write ? 'operation_outcome_unknown' : 'invalid_response');
        if (error.data.receipt !== undefined) {
          const candidate = error.data.receipt;
          if (operation === 'connect') {
            if (!connectReceipt.safeParse(candidate).success) throw failure('operation_outcome_unknown');
          } else if (!write || !('operation' in candidate) || candidate.operation !== operation ||
              candidate.connectionId !== receipt?.connectionId || candidate.expectedEpoch !== receipt?.expectedEpoch) {
            throw failure(write ? 'operation_outcome_unknown' : 'invalid_response');
          }
        }
        // Explicit backend outcomes are the only known rejections. Uncertain
        // codes never tell the UI to repeat a potentially completed write.
        const unknown = write && (error.data.error.endsWith('_outcome_unknown') ||
          ['cancelled', 'timeout', 'backend_unavailable'].includes(error.data.error));
        throw failure(error.data.error, unknown ? 'unknown' : 'rejected');
      }
      const result = resultSchema.safeParse(body);
      if (!result.success || !matches(result.data, request)) throw failure(write ? 'operation_outcome_unknown' : 'invalid_response');
      check();
      return result.data;
    };
    try { return await Promise.race([work(), stopPromise]); }
    catch (error) {
      if (error instanceof HermesConnectionClientError) throw error;
      throw failure(write && dispatched ? 'operation_outcome_unknown' : dispatched ? 'invalid_response' : 'reauthentication_required');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      controller.abort();
      serialized = '';
    }
  }

  return {
    list: (requestOptions?: HermesRequestOptions) => invoke('list', {}, emptyInput, listResult,
      value => value.connections.every(ownRow), requestOptions),
    options: (requestOptions?: HermesRequestOptions) => invoke('options', {}, emptyInput, optionsResult,
      value => value.options.userId === userId && value.options.organizationId === organizationId, requestOptions),
    context: (input: z.infer<typeof contextInput>, requestOptions?: HermesRequestOptions) => invoke('context', input, contextInput, contextResult,
      (value, request) => ownRow(value.context) && value.context.id === request.connectionId, requestOptions),
    connect: (input: HermesConnectInput, requestOptions?: HermesRequestOptions) => invoke('connect', input, connectInput, connectResult,
      (value, request) => ownRow(value.connection) && sameRestrictions(value.connection.restrictions, request.restrictions) &&
        sameSet(value.connection.scopeIds, request.scopeIds), requestOptions),
    restrict: (input: HermesRestrictInput, requestOptions?: HermesRequestOptions) => invoke('restrict', input, restrictInput, restrictResult,
      (value, request) => ownRow(value.connection) && value.connection.id === request.connectionId && value.connection.epoch === request.expectedEpoch + 1 &&
        sameRestrictions(value.connection.restrictions, request.restrictions) && sameSet(value.connection.scopeIds, request.scopeIds), requestOptions),
    revoke: (input: HermesRevokeInput, requestOptions?: HermesRequestOptions) => invoke('revoke', input, revokeInput, revokeResult,
      (value, request) => value.connectionId === request.connectionId, requestOptions),
  };
}
