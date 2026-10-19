import { permissionShape, connectionPermissionSettings } from './connection-permissions.mjs';
import { HERMES_READ_CAPABILITIES, HERMES_ACTION_CAPABILITIES } from './capability-contract.mjs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { BrokerError } from './broker.mjs';
import { DurableConnectionStoreError } from './durable-connection-store.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[\x21-\x7e]{1,16384}$/;
const DIGEST = /^[a-f0-9]{64}$/;
// hermes_prepare_connection_v1 issues clock_timestamp() + interval '5 minutes'.
// Its reviewed server timestamp anchors expiry; the source contract is tested.
const PREPARE_INTENT_LIFETIME_MS = 5 * 60_000;
const MAX_PREPARE_CLOCK_SKEW_MS = 30_000;
const MAX_TOKEN_LIFETIME_MS = 15 * 60_000;
const EMAIL = /^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]+$/;
const ROW = ['id', 'assistantId', 'organizationId', 'userId', 'state', 'epoch', 'restrictions', 'scopeIds'];
const CODES = new Set(['invalid_request', 'reauthentication_required', 'forbidden', 'context_changed', 'cancelled',
  'backend_unavailable', 'sign_in_outcome_unknown', 'additional_authentication_required',
  'prepare_rejected', 'prepare_outcome_unknown', 'activation_rejected', 'activation_outcome_unknown']);
const record = value => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exact = (value, keys) => record(value) && Reflect.ownKeys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key) && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const uuid = value => typeof value === 'string' && UUID.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
const sameSet = (a, b) => a.length === b.length && a.every(item => b.includes(item));
const digest = value => createHash('sha256').update(value).digest('hex');

export class ConnectionControlError extends Error {
  constructor(code, receipt) {
    super(CODES.has(code) ? code : 'backend_unavailable');
    this.name = 'ConnectionControlError'; this.code = this.message;
    // Identifiers only. Never attach a cause, token, intent secret or ciphertext.
    if (receipt && uuid(receipt.connectionId) && uuid(receipt.operationId)) {
      this.receipt = Object.freeze({ connectionId: receipt.connectionId, operationId: receipt.operationId });
    }
  }
}
const fail = code => { throw new ConnectionControlError(code); };
function ids(value, code) {
  if (!Array.isArray(value) || value.length > 256 || Array.from(value).some(item => !uuid(item)) ||
      new Set(value).size !== value.length) fail(code);
  return [...value].sort();
}
function restrictions(value, code) {
  if (!exact(value, ['read', 'action']) || !Array.isArray(value.read) || !Array.isArray(value.action) ||
      value.read.length > HERMES_READ_CAPABILITIES.length || new Set(value.read).size !== value.read.length || value.action.length > HERMES_ACTION_CAPABILITIES.length || new Set(value.action).size !== value.action.length || Array.from(value.action).some(key => !HERMES_ACTION_CAPABILITIES.includes(key)) ||
      Array.from(value.read).some(key => !HERMES_READ_CAPABILITIES.includes(key))) fail(code);
  return { read: [...value.read], action: [...value.action] };
}
function credentials(value) {
  if (typeof value.email !== 'string' || value.email.length > 320 || !EMAIL.test(value.email) ||
      typeof value.password !== 'string' || value.password.length < 1 || Buffer.byteLength(value.password) > 4096) fail('invalid_request');
  return { email: value.email, password: value.password };
}
function request(value, withCredentials) {
  if (!record(value)) fail('invalid_request');
  const inherited = Object.getOwnPropertyDescriptor(value, 'permissionMode')?.value === 'inherit_crm';
  const limits = inherited ? ['permissionMode', 'exclusions', 'scopeMode', 'scopeIds'] : ['restrictions', 'scopeIds'];
  const keys = withCredentials ? ['browserAccessToken', 'email', 'password', 'organizationId', ...limits]
    : ['accessToken', 'organizationId', ...limits];
  if (!exact(value, keys) || !uuid(value.organizationId)) fail('invalid_request');
  const bearer = value[withCredentials ? 'browserAccessToken' : 'accessToken'];
  if (typeof bearer !== 'string' || !TOKEN.test(bearer)) fail('invalid_request');
  if (withCredentials) credentials(value);
  const scopeIds = ids(value.scopeIds, 'invalid_request');
  if (inherited) {
    if (!['restricted', 'unrestricted'].includes(value.scopeMode) || value.scopeMode === 'unrestricted' && scopeIds.length) fail('invalid_request');
    return { ...value, exclusions: restrictions(value.exclusions, 'invalid_request'), scopeIds };
  }
  return { ...value, restrictions: restrictions(value.restrictions, 'invalid_request'), scopeIds };
}
function session(value, now) {
  if (!exact(value, ['userId', 'sessionId', 'expiresAt']) || !uuid(value.userId) || !uuid(value.sessionId) ||
      !positive(value.expiresAt) || value.expiresAt <= now) fail('reauthentication_required');
  return { ...value };
}
function allowed(value, actor, org, requested, now) {
  if (!record(value) || value.userId !== actor || typeof value.isSuperadmin !== 'boolean' ||
      !Array.isArray(value.activeOrganizationIds) || value.activeOrganizationIds.length > 256 ||
      Array.from(value.activeOrganizationIds).some(id => !uuid(id)) || !value.activeOrganizationIds.includes(org)) fail('forbidden');
  if (!value.isSuperadmin && (new Set(value.activeOrganizationIds).size !== 1)) fail('forbidden');
  const member = value.membership;
  if (!record(member) || member.organizationId !== org || member.status !== 'ACTIVE' || member.revokedAt !== null ||
      !(member.validFrom === null || (positive(member.validFrom) && member.validFrom <= now)) ||
      !(member.validTo === null || (positive(member.validTo) && member.validTo > now))) fail('forbidden');
  for (const source of [value.permissions, value.companyCeilings]) {
    if (!exact(source, ['read', 'action']) || ['read', 'action'].some(kind => !Array.isArray(source[kind]) || source[kind].length > 256 ||
        Array.from(source[kind]).some(key => typeof key !== 'string' || !/^[a-z][a-z0-9_.:-]{0,127}$/.test(key)))) fail('forbidden');
    for (const kind of ['read', 'action']) if (requested[kind].some(key => !source[kind].includes(key))) fail('forbidden');
  }
}
function prepared(value, expected, now) {
  if (!permissionShape(value, [...ROW, 'intentSecret', 'intentExpiresAt']) || ROW.slice(0, 4).some(key => !uuid(value[key])) ||
      value.userId !== expected.userId || value.organizationId !== expected.organizationId || value.state !== 'pending' ||
      !positive(value.epoch) || typeof value.intentSecret !== 'string' || !DIGEST.test(value.intentSecret) ||
      !positive(value.intentExpiresAt) || value.intentExpiresAt <= now ||
      value.intentExpiresAt > now + PREPARE_INTENT_LIFETIME_MS + MAX_PREPARE_CLOCK_SKEW_MS) fail('prepare_outcome_unknown');
  const invalid = () => fail('prepare_outcome_unknown');
  connectionPermissionSettings(value, x => restrictions(x, 'prepare_outcome_unknown'), invalid);
  restrictions(value.restrictions, 'prepare_outcome_unknown');
  ids(value.scopeIds, 'prepare_outcome_unknown');
  if (expected.permissionMode === 'inherit_crm') {
    if (value.permissionMode !== expected.permissionMode || value.scopeMode !== expected.scopeMode ||
        ['read', 'action'].some(kind => !sameSet(value.exclusions[kind], expected.exclusions[kind])) ||
        expected.scopeMode === 'restricted' && !sameSet(value.scopeIds, expected.scopeIds)) invalid();
  } else if ((value.permissionMode ?? 'legacy_allowlist') !== 'legacy_allowlist' ||
      ['read', 'action'].some(kind => !sameSet(value.restrictions[kind], expected.restrictions[kind])) ||
      !sameSet(value.scopeIds, expected.scopeIds)) invalid();
  return structuredClone(value);
}
function activated(value, input) {
  const expected = input.prepared;
  if (!exact(value, ['ok', 'status', 'connection', 'credentialRef']) || value.ok !== true ||
      !['activated', 'already_activated'].includes(value.status) || value.credentialRef !== input.credentialRef ||
      !permissionShape(value.connection, ROW)) fail('activation_outcome_unknown');
  const row = value.connection;
  connectionPermissionSettings(row, x => restrictions(x, 'activation_outcome_unknown'), () => fail('activation_outcome_unknown'));
  if ((row.permissionMode ?? 'legacy_allowlist') !== (expected.permissionMode ?? 'legacy_allowlist') ||
      (row.scopeMode ?? 'restricted') !== (expected.scopeMode ?? 'restricted') ||
      ['read', 'action'].some(kind => !sameSet(row.exclusions?.[kind] ?? [], expected.exclusions?.[kind] ?? []))) fail('activation_outcome_unknown');
  if (ROW.slice(0, 4).some(key => row[key] !== expected[key]) || row.state !== 'active' || row.epoch !== expected.epoch + 1 ||
      ['read', 'action'].some(kind => !sameSet(restrictions(row.restrictions, 'activation_outcome_unknown')[kind], expected.restrictions[kind])) ||
      !sameSet(ids(row.scopeIds, 'activation_outcome_unknown'), expected.scopeIds)) fail('activation_outcome_unknown');
  return structuredClone(row);
}
function safeError(error, stage, receipt) {
  if (error instanceof ConnectionControlError) return new ConnectionControlError(error.code, receipt);
  if (error instanceof BrokerError && ['unauthorized', 'forbidden', 'context_changed'].includes(error.code)) {
    return new ConnectionControlError(error.code === 'unauthorized' ? 'reauthentication_required' : error.code, receipt);
  }
  if (stage === 'activate' && error instanceof DurableConnectionStoreError) {
    const known = { store_denied: 'forbidden', store_conflict: 'context_changed', store_rejected: 'activation_rejected' };
    if (known[error.code]) return new ConnectionControlError(known[error.code], receipt);
  }
  return new ConnectionControlError(['activate', 'handoff'].includes(stage) ? 'activation_outcome_unknown' : stage === 'prepare' ? 'prepare_outcome_unknown'
    : stage === 'signIn' ? 'sign_in_outcome_unknown' : 'backend_unavailable', receipt);
}

async function bounded(signal, timeoutMs, operation, abortedError) {
  if (!(signal instanceof AbortSignal)) fail('invalid_request');
  if (signal.aborted) throw abortedError();
  const controller = new AbortController(); let rejectAbort;
  const abort = new Promise((_, reject) => { rejectAbort = reject; });
  const stop = () => { controller.abort(); rejectAbort(abortedError()); };
  signal.addEventListener('abort', stop, { once: true }); const timer = setTimeout(stop, timeoutMs);
  const check = () => { if (signal.aborted || controller.signal.aborted) throw abortedError(); };
  try { return await Promise.race([Promise.resolve().then(() => { check(); return operation(controller.signal, check); }), abort]); }
  finally { clearTimeout(timer); signal.removeEventListener('abort', stop); controller.abort(); }
}

/** Server-only connection creation for fixed read capabilities and the registered Zalo action. Not an HTTP/MCP endpoint.
 * The caller supplies a primary browser bearer and explicit password reauth over
 * the trusted backend's TLS route. A fixed Auth provider creates a NEW session;
 * callers cannot hand off an existing session/token pair or select an Auth URL.
 * Actual Auth verification must bind the new session to the browser's user and
 * a DIFFERENT provider session. No refresh of an already-owned session occurs.
 * Password is never stored/sealed/logged; local references are dropped after the
 * single sign-in attempt. JS strings cannot promise cryptographic memory erasure.
 * SQL prepare runs as the primary user; private activation receives only sealed
 * material and token digest. SQL remains the membership/policy/intent authority.
 *
 * One connect makes at most one sign-in, one prepare and one activation call. Unknown outcomes
 * return NO opaque credential and must not be interpreted as permission to retry
 * connect. A product host supplies handoff.stage: its immutable encrypted WAL
 * must persist the opaque token and verified owner before activation. No provider
 * credentials enter that port. Unknown stage prevents activation; unknown DB ACK
 * preserves the WAL for read-only authority reconciliation, never write replay.
 * Without a handoff port this legacy primitive alone has no durable delivery.
 * Expired credentials/crashed runtime leases still need separate recovery.
 * No memory authority fallback, provider logout, destructive compensation, UI or
 * long-lived token rotation is supplied. Activation is not a business-tool grant.
 * Prepare ACK validation permits at most 30s of server-ahead clock skew; this
 * allowance never extends an opaque token's lifetime or the SQL 15-minute cap.
 * Expiry starts from the earlier of host time and the server's prepare time.
 */
export function createConnectionControlPlane({ auth, signInProvider, preparation, connectionStore, crypto,
  clock = Date.now, timeoutMs = 30000, tokenLifetimeMs = MAX_TOKEN_LIFETIME_MS, handoff } = {}) {
  if ([auth?.verifySession, auth?.readAuthorization, signInProvider?.signIn,
    preparation?.prepareConnection, connectionStore?.activate, crypto?.seal, clock].some(fn => typeof fn !== 'function') ||
    (handoff !== undefined && (!exact(handoff, ['stage']) || typeof handoff.stage !== 'function')) ||
    !positive(timeoutMs) || timeoutMs > 30000 || !positive(tokenLifetimeMs) || tokenLifetimeMs > MAX_TOKEN_LIFETIME_MS) {
    throw new TypeError('invalid_connection_control_config');
  }
  const stageHandoff = handoff?.stage.bind(handoff);
  const now = () => { const value = clock(); if (!positive(value)) fail('backend_unavailable'); return value; };
  return Object.freeze({
    async connect(input, { signal } = {}) {
      const requested = request(input, true); // Snapshot before the first await.
      let stage = 'auth', receipt;
      const abortError = () => new ConnectionControlError(['activate', 'handoff'].includes(stage) ? 'activation_outcome_unknown'
        : stage === 'prepare' ? 'prepare_outcome_unknown' : stage === 'signIn' ? 'sign_in_outcome_unknown' : 'cancelled', receipt);
      try {
        return await bounded(signal, timeoutMs, async (innerSignal, check) => {
          const verify = async token => { const value = await auth.verifySession({ accessToken: token, signal: innerSignal }); check(); return session(value, now()); };
          const browser = await verify(requested.browserAccessToken);
          const read = async token => {
            const value = await auth.readAuthorization({ accessToken: token, userId: browser.userId,
              organizationId: requested.organizationId, signal: innerSignal }); check();
            allowed(value, browser.userId, requested.organizationId, requested.permissionMode === 'inherit_crm' ? { read: [], action: [] } : requested.restrictions, now());
          };
          await read(requested.browserAccessToken);
          stage = 'signIn';
          let suppliedPair;
          const login = { email: requested.email, password: requested.password, signal: innerSignal };
          try { suppliedPair = await signInProvider.signIn(login); }
          finally { requested.password = ''; login.password = ''; }
          check();
          if (!exact(suppliedPair, ['accessToken', 'refreshToken']) || Object.values(suppliedPair).some(token => typeof token !== 'string' || !TOKEN.test(token))) fail('reauthentication_required');
          const pair = { ...suppliedPair };
          stage = 'auth';
          const assistant = await verify(pair.accessToken);
          if (assistant.userId !== browser.userId || assistant.sessionId === browser.sessionId ||
              assistant.expiresAt > now() + 24 * 60 * 60_000) fail('reauthentication_required');
          await read(pair.accessToken);
          const browserAgain = await verify(requested.browserAccessToken);
          if (browserAgain.userId !== browser.userId || browserAgain.sessionId !== browser.sessionId) fail('reauthentication_required');
          await read(requested.browserAccessToken);
          stage = 'prepare';
          const pending = prepared(await preparation.prepareConnection({ accessToken: requested.browserAccessToken,
            organizationId: requested.organizationId, ...(requested.permissionMode === 'inherit_crm'
              ? { permissionMode: requested.permissionMode, exclusions: requested.exclusions, scopeMode: requested.scopeMode }
              : { restrictions: requested.restrictions }), scopeIds: requested.scopeIds }, { signal: innerSignal }),
          { ...requested, userId: browser.userId }, now()); check();
          stage = 'seal';
          const operationId = randomUUID();
          receipt = { connectionId: pending.id, operationId };
          const binding = { assistantId: pending.assistantId, userId: browser.userId,
            organizationId: pending.organizationId, sessionId: assistant.sessionId };
          const activationNow = now();
          const issuedAt = Math.min(activationNow, pending.intentExpiresAt - PREPARE_INTENT_LIFETIME_MS);
          const tokenExpiresAt = Math.min(issuedAt + tokenLifetimeMs, assistant.expiresAt);
          if (!positive(tokenExpiresAt) || tokenExpiresAt <= activationNow) fail('reauthentication_required');
          const opaque = `hc_${randomBytes(32).toString('base64url')}`;
          const activation = { prepared: pending, operationId, credentialRef: randomUUID(), binding,
            tokenDigest: digest(opaque), tokenExpiresAt,
            sessionExpiresAt: assistant.expiresAt,
            sessionEnvelope: crypto.seal({ accessToken: pair.accessToken, refreshToken: pair.refreshToken, expiresAt: assistant.expiresAt }, binding) };
          check();
          if (stageHandoff) {
            stage = 'handoff';
            const record = Object.freeze({ connectionId: pending.id, assistantId: pending.assistantId,
              userId: browser.userId, organizationId: pending.organizationId, operationId, token: opaque });
            const saved = await stageHandoff(record, { signal: innerSignal }); check();
            if (!exact(saved, ['status', 'connectionId', 'operationId']) || saved.status !== 'stored' ||
                saved.connectionId !== pending.id || saved.operationId !== operationId) fail('activation_outcome_unknown');
            if (activation.tokenExpiresAt <= now()) fail('activation_outcome_unknown');
          }
          stage = 'activate';
          const value = await connectionStore.activate(activation, { signal: innerSignal }); check();
          const connection = activated(value, activation);
          if (activation.tokenExpiresAt <= now()) fail('activation_outcome_unknown');
          return { status: 'active', connection, token: opaque, tokenExpiresAt: activation.tokenExpiresAt };
        }, abortError);
      } catch (error) { throw safeError(error, stage, receipt); }
      finally { requested.password = ''; }
    },
  });
}

async function responseJson(response, limit, signal, unknown = 'prepare_outcome_unknown') {
  if (response.redirected || !response.body || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') ||
      Number(response.headers.get('content-length')) > limit) { void response.body?.cancel().catch(() => {}); fail(unknown); }
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  const stop = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener('abort', stop, { once: true });
  try {
    while (true) {
      if (signal.aborted) fail(unknown);
      const { done, value } = await reader.read();
      if (signal.aborted) fail(unknown);
      if (done) break;
      bytes += value.byteLength; if (bytes > limit) fail(unknown); chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { signal.removeEventListener('abort', stop); stop(); reader.releaseLock(); }
}

/** Fixed public RPC adapter. Uses the browser bearer, not the private SQL role.
 * There is no caller-selected endpoint, role, arbitrary RPC or retry.
 */
export function createSupabaseConnectionPreparation({ url, publishableKey, fetch: transport = globalThis.fetch,
  timeoutMs = 10000, maxResponseBytes = 65536 } = {}) {
  let origin; try { origin = new URL(url); } catch { throw new TypeError('invalid_connection_preparation_config'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
      typeof publishableKey !== 'string' || !/^sb_publishable_[A-Za-z0-9_-]{1,512}$/.test(publishableKey) || typeof transport !== 'function' ||
      !positive(timeoutMs) || timeoutMs > 30000 || !positive(maxResponseBytes) || maxResponseBytes > 131072) {
    throw new TypeError('invalid_connection_preparation_config');
  }
  const endpoint = new URL('/rest/v1/rpc/hermes_prepare_connection_v1', origin).href;
  return Object.freeze({
    async prepareConnection(input, { signal } = {}) {
      const value = request(input, false);
      const inherited = value.permissionMode === 'inherit_crm';
      const selectedEndpoint = inherited ? new URL('/rest/v1/rpc/hermes_prepare_connection_v2', origin).href : endpoint;
      const body = JSON.stringify(inherited ? { p_org: value.organizationId, p_excluded_read: value.exclusions.read,
        p_excluded_action: value.exclusions.action, p_scope_mode: value.scopeMode, p_scope_ids: value.scopeIds }
        : { p_org: value.organizationId, p_read: value.restrictions.read, p_action: value.restrictions.action, p_scope_ids: value.scopeIds });
      let dispatched = false;
      const abortError = () => new ConnectionControlError(dispatched ? 'prepare_outcome_unknown' : 'cancelled');
      try {
        return await bounded(signal, timeoutMs, async (innerSignal, check) => {
          dispatched = true;
          const response = await transport(selectedEndpoint, { method: 'POST', signal: innerSignal, redirect: 'error',
            headers: { apikey: publishableKey, authorization: `Bearer ${value.accessToken}`, 'content-type': 'application/json',
              'accept-profile': 'public', 'content-profile': 'public' }, body }); check();
          const data = await responseJson(response, maxResponseBytes, innerSignal); check();
          if (!response.ok) {
            if (response.status === 401) fail('reauthentication_required');
            if (response.status === 403 || data?.code === '42501') fail('forbidden');
            if (record(data) && typeof data.code === 'string' && (/^(22|23)[A-Z0-9]{3}$/.test(data.code) ||
                ['40001', '40P01', 'P0001', '57014'].includes(data.code))) fail('prepare_rejected');
            fail('prepare_outcome_unknown');
          }
          if (!record(data) || ['error', 'error_code', 'error_description', 'code'].some(key => Object.hasOwn(data, key))) fail('prepare_outcome_unknown');
          return data; // Full actor/limits/expiry ACK validation belongs to the factory.
        }, abortError);
      } catch (error) {
        if (error instanceof ConnectionControlError) throw error;
        fail(dispatched ? 'prepare_outcome_unknown' : 'backend_unavailable');
      }
    },
  });
}

/** Fixed, backend-owned fresh password sign-in. Never accepts tokens to refresh,
 * stores credentials, retries a login, or modifies a browser Supabase client.
 * MFA-enrolled accounts and additional Auth challenges are deliberately refused
 * until a separately reviewed challenge flow exists; no AAL downgrade fallback.
 * A token endpoint success is not identity proof for the factory: it MUST still
 * verify the access token with actual Auth and compare user/session bindings.
 */
export function createSupabaseAssistantSignIn({ url, publishableKey, fetch: transport = globalThis.fetch,
  timeoutMs = 10000, maxResponseBytes = 65536 } = {}) {
  let origin; try { origin = new URL(url); } catch { throw new TypeError('invalid_assistant_sign_in_config'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
      typeof publishableKey !== 'string' || !/^sb_publishable_[A-Za-z0-9_-]{1,512}$/.test(publishableKey) || typeof transport !== 'function' ||
      !positive(timeoutMs) || timeoutMs > 30000 || !positive(maxResponseBytes) || maxResponseBytes > 131072) {
    throw new TypeError('invalid_assistant_sign_in_config');
  }
  const endpoint = new URL('/auth/v1/token?grant_type=password', origin).href;
  return Object.freeze({
    async signIn(input) {
      if (!exact(input, ['email', 'password', 'signal'])) fail('invalid_request');
      const value = credentials(input);
      let body = JSON.stringify(value), dispatched = false;
      // Drop local password references; the bounded serialized request is the only
      // material passed to Auth. Caller must clear its own form/request references.
      value.password = '';
      const abortError = () => new ConnectionControlError(dispatched ? 'sign_in_outcome_unknown' : 'cancelled');
      try {
        return await bounded(input.signal, timeoutMs, async (signal, check) => {
          dispatched = true;
          const response = await transport(endpoint, { method: 'POST', signal, redirect: 'error',
            headers: { apikey: publishableKey, 'content-type': 'application/json', accept: 'application/json' }, body }); check();
          const data = await responseJson(response, maxResponseBytes, signal, 'sign_in_outcome_unknown'); check();
          const providerCode = typeof data?.error_code === 'string' ? data.error_code : data?.code;
          if ((typeof providerCode === 'string' && (/^(mfa_|captcha|sso_)/.test(providerCode) || providerCode === 'insufficient_aal')) ||
              (record(data) && ['mfa_required', 'challenge_id', 'factor_id', 'sso_required'].some(key => Object.hasOwn(data, key)))) {
            fail('additional_authentication_required');
          }
          if (!response.ok) {
            if ([400, 401, 403, 422, 429].includes(response.status)) fail('reauthentication_required');
            fail('sign_in_outcome_unknown');
          }
          if (!record(data) || ['error', 'error_code', 'error_description', 'code'].some(key => Object.hasOwn(data, key)) ||
              data.token_type !== 'bearer' || !record(data.user) || !uuid(data.user.id) ||
              typeof data.access_token !== 'string' || !TOKEN.test(data.access_token) ||
              typeof data.refresh_token !== 'string' || !TOKEN.test(data.refresh_token)) fail('sign_in_outcome_unknown');
          if (Object.hasOwn(data.user, 'factors')) {
            if (!Array.isArray(data.user.factors) || data.user.factors.length > 64 ||
                Array.from(data.user.factors).some(factor => !record(factor) || !['verified', 'unverified'].includes(factor.status))) {
              fail('sign_in_outcome_unknown');
            }
            if (data.user.factors.some(factor => factor.status === 'verified')) fail('additional_authentication_required');
          }
          return { accessToken: data.access_token, refreshToken: data.refresh_token };
        }, abortError);
      } catch (error) {
        if (error instanceof ConnectionControlError) throw error;
        fail(dispatched ? 'sign_in_outcome_unknown' : 'backend_unavailable');
      } finally { body = ''; }
    },
  });
}
