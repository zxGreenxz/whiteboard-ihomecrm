import { createHash } from 'node:crypto';
import { BrokerError } from './broker.mjs';
import { ModelRelayError } from './model-relay.mjs';
import { validateSessionMaterial } from './session-crypto.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^hc_[A-Za-z0-9_-]{43}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const CAPABILITY = /^[a-z][a-z0-9_.:-]{0,127}$/;
const TOOL = /^mcp__crm__[a-z][a-z0-9_]{0,95}$/;
const CALL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const OWNER = ['assistantId', 'userId', 'organizationId', 'sessionId'];
const SAFE = new Set(['invalid_request', 'unauthorized', 'forbidden', 'context_changed', 'busy', 'closed',
  'cancelled', 'timeout', 'backend_unavailable', 'model_unknown']);
const DEFINITE_RELAY = new Set(['model_not_enabled', 'stream_not_enabled', 'invalid_request', 'request_too_large',
  'invalid_context', 'unauthorized', 'organization_required', 'organization_forbidden', 'copilot_disabled',
  'not_entitled', 'not_permitted', 'provider_disabled', 'bad_model', 'bad_pricing', 'daily_token_quota',
  'daily_quota', 'rate_limited', 'busy']);
const id = value => typeof value === 'string' && UUID.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
const hash = value => createHash('sha256').update(value).digest('hex');
const record = value => value !== null && typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && property.enumerable && Object.hasOwn(property, 'value');
  });
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const allowed = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key));

export class RuntimeModelServiceError extends Error {
  constructor(code) { super(SAFE.has(code) ? code : 'backend_unavailable'); this.name = 'RuntimeModelServiceError'; this.code = this.message; }
}
const fail = code => { throw new RuntimeModelServiceError(code); };

// Traverse descriptors before reading any value: JSON.stringify/structuredClone
// alone would invoke caller getters. Bound traversal before serializing as well.
function snapshot(value, byteCap, code = 'backend_unavailable') {
  let nodes = 0, bytes = 0;
  const seen = new Set();
  const visit = (source, depth) => {
    if (++nodes > 16384 || depth > 32) fail(code);
    if (source === null || typeof source === 'boolean') return source;
    if (typeof source === 'number') { if (!Number.isFinite(source)) fail(code); return source; }
    if (typeof source === 'string') { bytes += Buffer.byteLength(source); if (bytes > byteCap || source.includes('\0')) fail(code); return source; }
    if (typeof source !== 'object' || seen.has(source)) fail(code);
    seen.add(source); let result;
    if (Array.isArray(source)) {
      if (Object.getPrototypeOf(source) !== Array.prototype || source.length > 8192 ||
          Reflect.ownKeys(source).length !== source.length + 1) fail(code);
      result = [];
      for (let index = 0; index < source.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(source, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
        result.push(visit(descriptor.value, depth + 1));
      }
    } else {
      if (!record(source) || Object.keys(source).length > 8192) fail(code);
      result = Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(source)).map(([key, descriptor]) => {
        bytes += Buffer.byteLength(key); if (bytes > byteCap) fail(code);
        return [key, visit(descriptor.value, depth + 1)];
      }));
    }
    seen.delete(source); return Object.freeze(result);
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > byteCap) fail(code);
  return result;
}
function permissions(value) {
  if (!exact(value, ['read', 'action'])) fail('backend_unavailable');
  for (const kind of ['read', 'action']) if (!Array.isArray(value[kind]) || value[kind].length > 256 ||
    value[kind].some(key => typeof key !== 'string' || !CAPABILITY.test(key)) || new Set(value[kind]).size !== value[kind].length) fail('backend_unavailable');
}
function authoritySnapshot(receipt, now) {
  const value = snapshot(receipt, 131072);
  if (!exact(value, ['row', 'effective', 'policyEpoch', 'isSuperadmin', 'assistantScopeIds', 'scopesByPermission', 'contextVersion']) ||
      !exact(value.row, ['id', 'assistantId', 'userId', 'organizationId', 'state', 'epoch', 'expiresAt', 'restrictions']) ||
      ['id', ...OWNER.slice(0, 3)].some(key => !id(value.row[key])) || value.row.state !== 'active' ||
      !positive(value.row.epoch) || !positive(value.row.expiresAt) || typeof value.isSuperadmin !== 'boolean' ||
      !DIGEST.test(value.contextVersion ?? '') || !DIGEST.test(value.policyEpoch ?? '')) fail('backend_unavailable');
  permissions(value.effective); permissions(value.row.restrictions);
  if (!value.effective.read.includes('assistant.context.read') || !value.row.restrictions.read.includes('assistant.context.read')) fail('forbidden');
  if (value.row.expiresAt <= now) fail('unauthorized');
  return value;
}
function requestBody(value) {
  const body = snapshot(value, 262144, 'invalid_request');
  if (!allowed(body, ['model', 'messages', 'max_tokens', 'temperature', 'tools', 'tool_choice', 'stream']) ||
      typeof body.model !== 'string' || !/^[a-z][a-z0-9_-]*:[A-Za-z0-9_./:-]{1,128}$/.test(body.model) ||
      !Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 64 ||
      !Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 4096 ||
      (body.stream !== undefined && body.stream !== false)) fail('invalid_request');
  return body; // Relay owns full model/tool validation and model entitlement.
}
function completion(value, body) {
  const result = snapshot(value, 131072);
  if (!allowed(result, ['id', 'object', 'choices', 'created', 'model', 'usage']) || typeof result.id !== 'string' || result.id.length > 256 ||
      result.object !== 'chat.completion' || !Array.isArray(result.choices) || result.choices.length !== 1) fail('backend_unavailable');
  const choice = result.choices[0], message = choice?.message;
  if (!exact(choice, ['index', 'message', 'finish_reason']) || choice.index !== 0 ||
      !['stop', 'length', 'tool_calls', 'content_filter'].includes(choice.finish_reason) ||
      !allowed(message, ['role', 'content', 'refusal', 'tool_calls']) || message.role !== 'assistant' ||
      !(typeof message.content === 'string' || message.content === null) ||
      (message.refusal !== undefined && typeof message.refusal !== 'string')) fail('backend_unavailable');
  if (message.tool_calls !== undefined) {
    const names = new Set((body.tools ?? []).map(tool => tool.function?.name));
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length < 1 || message.tool_calls.length > 32) fail('backend_unavailable');
    for (const call of message.tool_calls) if (!exact(call, ['id', 'type', 'function']) || !CALL_ID.test(call.id ?? '') || call.type !== 'function' ||
      !exact(call.function, ['name', 'arguments']) || !TOOL.test(call.function.name ?? '') || !names.has(call.function.name) ||
      typeof call.function.arguments !== 'string') fail('backend_unavailable');
  }
  if (message.content === null && !message.tool_calls && !message.refusal) fail('backend_unavailable');
  if (result.created !== undefined && (!Number.isSafeInteger(result.created) || result.created < 0)) fail('backend_unavailable');
  if (result.model !== undefined && (typeof result.model !== 'string' || result.model.length > 256)) fail('backend_unavailable');
  if (result.usage !== undefined && (!allowed(result.usage, ['prompt_tokens', 'completion_tokens', 'total_tokens']) ||
      Object.values(result.usage).some(value => !Number.isSafeInteger(value) || value < 0))) fail('backend_unavailable');
  return result;
}
function validateJwt(token, binding, expiresAt) {
  if (typeof token !== 'string' || token.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) fail('unauthorized');
  let claims; try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { fail('unauthorized'); }
  // A structural rejection only. Real Auth verification below is mandatory.
  if (!record(claims) || claims.role !== 'authenticated' || claims.sub !== binding.userId || claims.session_id !== binding.sessionId ||
      !positive(claims.exp) || claims.exp * 1000 !== expiresAt) fail('unauthorized');
}
function handle(value) {
  if (!exact(value, ['result', 'drained']) || !(value.result instanceof Promise) || !(value.drained instanceof Promise)) fail('backend_unavailable');
  return value;
}

/** Trusted host only: no endpoint, refresh, model fallback or new permission engine.
 * dependencyScope.begin(work) must track ACTUAL nested transport/body/pool work,
 * including work surviving an adapter's Promise.race. relay.beginCompletion has
 * the same {result,drained} contract. A rejected drain never frees capacity and
 * makes close reject; a hung drain keeps close pending. The owner must retain its
 * runtime lease in either case. Closing this service does not destroy caller crypto.
 * requestId tombstones and unknown-token latches live for this bounded service
 * lifetime; they are no substitute for a gateway turn fence across process restarts.
 */
export function createRuntimeModelService({ authority, connectionStore, crypto, auth, relay, dependencyScope,
  clock = Date.now, timeoutMs = 90000, maxConcurrent = 4, maxRequests = 4096 } = {}) {
  if ([authority?.resolve, authority?.checkUnchanged, connectionStore?.readConnection, crypto?.open,
    auth?.verifySession, relay?.beginCompletion, dependencyScope?.begin, clock].some(fn => typeof fn !== 'function') ||
    !positive(timeoutMs) || timeoutMs > 180000 || !positive(maxConcurrent) || maxConcurrent > 64 ||
    !positive(maxRequests) || maxRequests > 65536) throw new TypeError('invalid_runtime_model_service_config');
  const active = new Set(), seen = new Set(), uncertain = new Set();
  let closed = false, drainFailed = false, closing;
  const now = () => { const time = clock(); if (!positive(time) || time > 8640000000000000) fail('backend_unavailable'); return time; };
  function beginCompletion(input) {
    if (!exact(input, ['token', 'requestId', 'body', 'signal']) || !(input.signal instanceof AbortSignal) || !id(input.requestId)) fail('invalid_request');
    const { token, requestId, signal } = input;
    if (typeof token !== 'string' || !TOKEN.test(token)) fail('unauthorized');
    const body = requestBody(input.body), tokenDigest = hash(token);
    if (closed || drainFailed) fail('closed');
    if (signal.aborted) fail('cancelled');
    if (uncertain.has(tokenDigest)) fail('model_unknown');
    if (seen.has(requestId)) fail('invalid_request');
    if (active.size >= maxConcurrent || seen.size >= maxRequests) fail('busy');
    const deadline = now() + timeoutMs;
    seen.add(requestId);
    const controller = new AbortController(), entry = { controller }, relayDrains = [];
    active.add(entry);
    let relayStarted = false, modelFinished = false, drainInvalid = false, timer, rejectAbort, workPromise, workValue, workSettled = false, settleWork;
    const workDone = new Promise(resolve => { settleWork = resolve; });
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    aborted.catch(() => {});
    const error = (cause, fallback = 'backend_unavailable') => {
      if (relayStarted && !modelFinished && !(cause instanceof ModelRelayError && DEFINITE_RELAY.has(cause.code))) {
        uncertain.add(tokenDigest); return new RuntimeModelServiceError('model_unknown');
      }
      if (cause instanceof RuntimeModelServiceError) return new RuntimeModelServiceError(cause.code);
      if (cause instanceof BrokerError && ['unauthorized', 'forbidden', 'context_changed'].includes(cause.code)) return new RuntimeModelServiceError(cause.code);
      if (cause instanceof ModelRelayError && DEFINITE_RELAY.has(cause.code)) return new RuntimeModelServiceError('forbidden');
      return new RuntimeModelServiceError(fallback);
    };
    const stop = code => { if (controller.signal.aborted) return; const reason = error(new RuntimeModelServiceError(code));
      controller.abort(reason); rejectAbort(reason); };
    entry.stop = stop;
    const onAbort = () => stop('cancelled');
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => stop('timeout'), timeoutMs);
    const fresh = () => {
      if (controller.signal.aborted || signal.aborted) throw controller.signal.reason ?? new RuntimeModelServiceError('cancelled');
      if (now() >= deadline) { stop('timeout'); throw controller.signal.reason; }
    };
    const work = () => {
      if (workPromise) fail('backend_unavailable');
      workPromise = (async () => {
        fresh();
        const receipt = await authority.resolve(token, { signal: controller.signal }); fresh();
        const current = authoritySnapshot(receipt, now());
        const joined = snapshot(await connectionStore.readConnection({ tokenDigest }, { signal: controller.signal }), 131072); fresh();
        if (!record(joined) || joined.status !== 'active' || !record(joined.connection) || !record(joined.session)) fail('unauthorized');
        const row = joined.connection, session = joined.session;
        if (['id', 'assistantId', 'userId', 'organizationId', 'state', 'epoch', 'expiresAt'].some(key => row[key] !== current.row[key]) ||
          row.tokenDigest !== tokenDigest || !id(row.credentialRef) || session.credentialRef !== row.credentialRef || !positive(session.revision) ||
          !positive(session.expiresAt) || !exact(session.binding, OWNER) || OWNER.some(key => !id(session.binding[key])) ||
          OWNER.slice(0, 3).some(key => session.binding[key] !== current.row[key])) fail('context_changed');
        const opened = validateSessionMaterial(snapshot(crypto.open(session.envelope, session.binding), 40000));
        const { accessToken, expiresAt } = opened; opened.refreshToken = undefined;
        if (expiresAt !== session.expiresAt) fail('context_changed');
        const live = () => { fresh(); if (expiresAt <= now() || current.row.expiresAt <= now()) fail('unauthorized'); };
        live(); validateJwt(accessToken, session.binding, expiresAt);
        const verified = snapshot(await auth.verifySession({ accessToken, signal: controller.signal }), 4096); live();
        if (!exact(verified, ['userId', 'sessionId', 'expiresAt']) || verified.userId !== session.binding.userId ||
            verified.sessionId !== session.binding.sessionId || verified.expiresAt !== expiresAt) fail('unauthorized');
        const unchanged = async () => {
          const result = await authority.checkUnchanged(token, receipt, { signal: controller.signal }); live();
          if (result !== undefined || receipt.contextVersion !== current.contextVersion) fail('context_changed');
        };
        await unchanged(); live();
        relayStarted = true;
        let started;
        try { started = handle(relay.beginCompletion({ accessToken, organizationId: current.row.organizationId, requestId, body, signal: controller.signal })); }
        catch (cause) { drainInvalid = true; throw cause; }
        relayDrains.push(started.drained); started.drained.catch(() => {});
        const value = await started.result; live();
        const result = completion(value, body); modelFinished = true;
        await unchanged(); live();
        workValue = result; return result;
      })().finally(() => { workSettled = true; settleWork(); });
      workPromise.catch(() => {}); return workPromise;
    };
    let scoped;
    try { scoped = handle(dependencyScope.begin(work)); }
    catch (cause) {
      stop('backend_unavailable');
      scoped = { result: Promise.reject(error(cause)), drained: Promise.reject(new RuntimeModelServiceError('backend_unavailable')) };
    }
    scoped.result.catch(() => {}); scoped.drained.catch(() => {});
    const drained = (async () => {
      try {
        await Promise.all([scoped.drained, workDone]);
        await Promise.all(relayDrains);
        if (drainInvalid) fail('backend_unavailable');
        active.delete(entry);
      } catch { drainFailed = true; throw new RuntimeModelServiceError('backend_unavailable'); }
    })();
    drained.catch(() => {}); entry.drained = drained; entry.stop = stop;
    const result = Promise.race([scoped.result, aborted]).then(value => {
      fresh(); if (!workSettled || value !== workValue) fail('backend_unavailable'); return value;
    }).catch(cause => { throw error(cause); }).finally(() => {
      clearTimeout(timer); signal.removeEventListener('abort', onAbort); controller.abort();
    });
    result.catch(() => {});
    return Object.freeze({ result, drained });
  }
  return Object.freeze({ beginCompletion,
    async complete(input) { return beginCompletion(input).result; },
    close() {
      if (closing) return closing;
      closed = true;
      for (const entry of active) entry.stop('cancelled');
      closing = Promise.all([...active].map(entry => entry.drained)).then(() => { if (drainFailed) fail('backend_unavailable'); });
      closing.catch(() => {}); return closing;
    },
  });
}
