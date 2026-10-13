import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { MemoryAssistantStore, MemoryConnectionStore, MemorySessionStore } from './stores.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[a-z][a-z0-9_.:-]{0,127}$/;
const TOKEN = /^hc_[A-Za-z0-9_-]{43}$/;
const CONTEXT_PERMISSION = 'assistant.context.read';
const TOOL = Object.freeze({
  name: 'crm_auth_context',
  description: 'Read the verified identity and effective assistant permissions of this connection.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
});
const ROOM_PERMISSION = 'rooms.view';
const ROOM_TOOL = Object.freeze({
  name: 'crm_available_rooms',
  description: 'Read free and soon-available rooms within this connection’s current CRM and assistant building scope. Pagination belongs to one read snapshot.',
  inputSchema: { type: 'object', properties: {
    buildingName: { type: 'string', maxLength: 120 },
    offset: { type: 'integer', minimum: 0, maximum: 2000, default: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
  }, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
});
const DEFAULT_LIMITS = Object.freeze({
  tokenLifetimeMs: 15 * 60_000,
  maxRequestsPerMinute: 60,
  maxConcurrentCalls: 2,
  timeoutMs: 10_000,
  maxResultBytes: 16_384,
});
const ERROR_STATUS = Object.freeze({
  unauthorized: 401, forbidden: 403, context_changed: 409, invalid_request: 400,
  tool_not_available: 403, rate_limited: 429, busy: 429, timeout: 504,
  backend_unavailable: 503, response_too_large: 502,
});

export class BrokerError extends Error {
  constructor(code) {
    super(Object.hasOwn(ERROR_STATUS, code) ? code : 'backend_unavailable');
    this.name = 'BrokerError';
    this.code = this.message;
    this.status = ERROR_STATUS[this.code];
  }
}

const fail = (code) => { throw new BrokerError(code); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const token = () => `hc_${randomBytes(32).toString('base64url')}`;
const exactKeys = (value, allowed) => object(value) && Object.keys(value).every((key) => allowed.includes(key));
const validId = (value) => typeof value === 'string' && UUID.test(value);
const record = (value) => object(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exactRecord = (value, keys) => record(value) && Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const canonicalId = (value) => validId(value) && value === value.toLowerCase();
const positive = (value) => Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
const dataRecord = value => record(value) && Reflect.ownKeys(value).every(key => typeof key === 'string' &&
  Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const exactData = (value, keys) => dataRecord(value) && exactRecord(value, keys);

function roomFilters(value) {
  if (!dataRecord(value) || Object.keys(value).some(key => !['buildingName', 'offset', 'limit'].includes(key))) fail('invalid_request');
  const { buildingName = '', offset = 0, limit = 50 } = value;
  if (typeof buildingName !== 'string' || buildingName.length > 120 || !Number.isInteger(offset) || offset < 0 || offset > 2000 ||
      !Number.isInteger(limit) || limit < 1 || limit > 100) fail('invalid_request');
  return Object.freeze({ buildingName, offset, limit });
}

// Protocol validation only. Sale facts and authorization are owned by the shared
// room service/projection. Never serialize extra fields from a dependency.
function roomResult(value, request, identity) {
  const text = (value, cap, nullable = false) => (nullable && value === null) || (typeof value === 'string' && value.length <= cap);
  const amount = value => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER);
  const day = value => value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value);
  if (!exactData(value, ['source', 'readAt', 'currency', 'completeness', 'totalInSnapshot', 'offset', 'nextOffset', 'rooms']) ||
      value.source !== 'copilot_available_rooms_v1' || value.currency !== 'VND' ||
      !['complete', 'source_capped'].includes(value.completeness) || typeof value.readAt !== 'string' ||
      !Number.isFinite(Date.parse(value.readAt)) || new Date(value.readAt).toISOString() !== value.readAt ||
      !Number.isInteger(value.totalInSnapshot) || value.totalInSnapshot < 0 || value.totalInSnapshot > 2000 ||
      value.offset !== request.offset || value.nextOffset !== (request.offset + request.limit < value.totalInSnapshot ? request.offset + request.limit : null) ||
      !Array.isArray(value.rooms) || value.rooms.length !== Math.min(request.limit, Math.max(0, value.totalInSnapshot - request.offset))) fail('backend_unavailable');
  const seen = new Set(), buildings = identity.scopesByPermission[ROOM_PERMISSION].buildingIds;
  for (const room of value.rooms) {
    if (!exactData(room, ['id', 'code', 'name', 'building', 'floor', 'areaM2', 'rentVnd', 'depositVnd', 'status', 'availability']) ||
        !canonicalId(room.id) || seen.has(room.id) || !text(room.code, 256, true) || !text(room.name, 500) ||
        !exactData(room.building, ['id', 'name', 'code']) || !canonicalId(room.building.id) || !buildings.includes(room.building.id) ||
        !text(room.building.name, 500) || !room.building.name.toLowerCase().includes(request.buildingName.toLowerCase()) || !text(room.building.code, 256, true) ||
        !(room.floor === null || (Number.isInteger(room.floor) && room.floor >= -100 && room.floor <= 1000)) ||
        ![room.areaM2, room.rentVnd, room.depositVnd].every(amount) || !['free', 'soon'].includes(room.status) ||
        !exactData(room.availability, ['kind', 'label', 'availableOn']) ||
        !['ready', 'notice', 'confirm_notice', 'preparing'].includes(room.availability.kind) ||
        !text(room.availability.label, 256) || !day(room.availability.availableOn)) fail('backend_unavailable');
    seen.add(room.id);
  }
  return { content: [{ type: 'text', text: JSON.stringify(structuredClone(value)) }], isError: false };
}

function authorityList(value, predicate) {
  if (!Array.isArray(value) || value.length > 256 || Array.from(value).some((item) => !predicate(item)) ||
      new Set(value).size !== value.length) fail('backend_unavailable');
}

function authorityPermissions(value) {
  if (!exactRecord(value, ['read', 'action'])) fail('backend_unavailable');
  for (const kind of ['read', 'action']) authorityList(value[kind], (key) => typeof key === 'string' && KEY.test(key));
}

// The injected authority is a trusted backend dependency. Still validate its
// complete result before any handler or audit sees it, and detach the projection
// from its branded comparison receipt. Credential fields are never accepted here.
function authorityIdentity(value, now) {
  if (!exactRecord(value, ['row', 'effective', 'policyEpoch', 'isSuperadmin', 'assistantScopeIds', 'scopesByPermission', 'contextVersion']) ||
      !exactRecord(value.row, ['id', 'assistantId', 'userId', 'organizationId', 'expiresAt', 'epoch', 'state', 'restrictions']) ||
      ['id', 'assistantId', 'userId', 'organizationId'].some((key) => !canonicalId(value.row[key])) ||
      value.row.state !== 'active' || !positive(value.row.epoch) || !positive(value.row.expiresAt) ||
      typeof value.isSuperadmin !== 'boolean' ||
      ![value.policyEpoch, value.contextVersion].every((version) => typeof version === 'string' && /^[a-f0-9]{64}$/.test(version))) {
    fail('backend_unavailable');
  }
  if (value.row.expiresAt <= now) fail('unauthorized');
  authorityPermissions(value.row.restrictions); authorityPermissions(value.effective);
  for (const kind of ['read', 'action']) {
    if (value.effective[kind].some((key) => !value.row.restrictions[kind].includes(key))) fail('backend_unavailable');
  }
  authorityList(value.assistantScopeIds, canonicalId);
  const scopes = value.scopesByPermission;
  if (!record(scopes) || Object.keys(scopes).length > 256 ||
      [...value.effective.read, ...value.effective.action].some((key) => !Object.hasOwn(scopes, key))) fail('backend_unavailable');
  for (const [key, scope] of Object.entries(scopes)) {
    if (!KEY.test(key) || !exactRecord(scope, ['buildingIds', 'cashbookIds'])) fail('backend_unavailable');
    authorityList(scope.buildingIds, canonicalId); authorityList(scope.cashbookIds, canonicalId);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 131_072) fail('backend_unavailable');
  return structuredClone(value);
}

function permissions(value, error = 'invalid_request') {
  if (!exactKeys(value, ['read', 'action'])) fail(error);
  const result = {};
  for (const kind of ['read', 'action']) {
    if (!Array.isArray(value[kind]) || value[kind].length > 256 ||
        value[kind].some((key) => typeof key !== 'string' || !KEY.test(key))) fail(error);
    result[kind] = [...new Set(value[kind])].sort();
  }
  return result;
}

function effectivePermissions(current, ceiling, restriction) {
  return Object.fromEntries(['read', 'action'].map((kind) => [kind,
    current[kind].filter((key) => ceiling[kind].includes(key) && restriction[kind].includes(key)),
  ]));
}

function safeConnection(row) {
  return {
    id: row.id, assistantId: row.assistantId, userId: row.userId,
    organizationId: row.organizationId, expiresAt: row.expiresAt,
    epoch: row.epoch, state: row.state, restrictions: structuredClone(row.restrictions),
  };
}

function validSession(value, now) {
  if (!object(value) || !validId(value.userId) || typeof value.sessionId !== 'string' ||
      value.sessionId.length < 1 || value.sessionId.length > 256 ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now) fail('unauthorized');
  return { userId: value.userId, sessionId: value.sessionId, expiresAt: value.expiresAt };
}

function validAuthorization(value, userId, organizationId, now) {
  if (!object(value) || value.userId !== userId || typeof value.isSuperadmin !== 'boolean' ||
      typeof value.epoch !== 'string' || !value.epoch || value.epoch.length > 256 ||
      !Array.isArray(value.activeOrganizationIds) || value.activeOrganizationIds.some((id) => !validId(id))) {
    fail('forbidden');
  }
  const organizations = [...new Set(value.activeOrganizationIds)];
  // Ordinary users have exactly one company. A directory entry alone is never authority.
  if (!value.isSuperadmin && (organizations.length !== 1 || organizations[0] !== organizationId)) fail('forbidden');
  const member = value.membership;
  if (!object(member) || member.organizationId !== organizationId || member.status !== 'ACTIVE' ||
      member.revokedAt !== null ||
      !(member.validFrom === null || (Number.isSafeInteger(member.validFrom) && member.validFrom <= now)) ||
      !(member.validTo === null || (Number.isSafeInteger(member.validTo) && member.validTo > now))) fail('forbidden');
  return {
    isSuperadmin: value.isSuperadmin, epoch: value.epoch,
    permissions: permissions(value.permissions, 'forbidden'),
    companyCeilings: permissions(value.companyCeilings, 'forbidden'),
  };
}

/**
 * All adapters are trusted backend dependencies, never MCP arguments.
 * auth.verifySession({accessToken, signal}) -> {userId, sessionId, expiresAt: epochMs}
 * auth.readAuthorization({accessToken,userId,organizationId,signal}) -> current server
 * {userId,isSuperadmin,activeOrganizationIds,membership,epoch,permissions,companyCeilings}.
 * The adapter must independently verify current CRM authority, not echo client claims.
 * No service-role, raw RPC forwarding, password input, token minting, or refresh exists here.
 * Alternatively inject authority.{identifyConnection,resolve,checkUnchanged}.
 * identifyConnection binds the opaque token to a current connection id before
 * per-connection admission; resolve supplies the branded authority receipt.
 * This mode disables all P1 control-plane methods and never falls back to memory.
 * crm_available_rooms additionally requires an explicitly injected room service
 * and nonempty rooms.view + assistant scopes. No generic RPC route is exposed.
 */
export function createBroker({
  auth,
  authority,
  roomReads,
  clock = Date.now,
  limits: suppliedLimits = {},
  sessionStore,
  connectionStore,
  assistantStore,
  audit,
} = {}) {
  let injectedAuthority;
  if (authority !== undefined) {
    if (!authority || ['identifyConnection', 'resolve', 'checkUnchanged'].some((key) => typeof authority[key] !== 'function')) {
      throw new TypeError('trusted_authority_adapter_required');
    }
    // Capture one adapter instance, including its comparison-receipt brand.
    injectedAuthority = Object.fromEntries(['identifyConnection', 'resolve', 'checkUnchanged']
      .map((key) => [key, authority[key].bind(authority)]));
  } else {
    if (typeof auth?.verifySession !== 'function' || typeof auth?.readAuthorization !== 'function') {
      throw new TypeError('trusted_auth_adapter_required');
    }
    sessionStore ??= new MemorySessionStore();
    connectionStore ??= new MemoryConnectionStore();
    assistantStore ??= new MemoryAssistantStore();
  }
  let rooms;
  if (roomReads !== undefined) {
    if (!injectedAuthority || !roomReads || ['prepareAvailableRooms', 'finalizeAvailableRooms'].some(key => typeof roomReads[key] !== 'function')) {
      throw new TypeError('trusted_durable_room_service_required');
    }
    rooms = Object.fromEntries(['prepareAvailableRooms', 'finalizeAvailableRooms'].map(key => [key, roomReads[key].bind(roomReads)]));
  }
  const mayReadRooms = identity => Boolean(rooms && identity.effective.read.includes(ROOM_PERMISSION) &&
    identity.assistantScopeIds.length && identity.scopesByPermission[ROOM_PERMISSION]?.buildingIds.length);
  if (!exactKeys(suppliedLimits, Object.keys(DEFAULT_LIMITS))) throw new TypeError('invalid_limits');
  const limits = { ...DEFAULT_LIMITS, ...suppliedLimits };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('invalid_limits');
  }
  if (limits.tokenLifetimeMs > DEFAULT_LIMITS.tokenLifetimeMs || limits.timeoutMs > 30_000 ||
      limits.maxResultBytes > 65_536) throw new TypeError('unsafe_limits');
  const usage = new Map();
  const receipts = [];
  const writeAudit = audit ?? (async (event) => {
    receipts.push(structuredClone(event));
    if (receipts.length > 1000) receipts.shift();
  });
  if (typeof writeAudit !== 'function') throw new TypeError('invalid_audit_adapter');

  async function bounded(operation) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        operation(controller.signal),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new BrokerError('timeout'));
          }, limits.timeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof BrokerError) throw error;
      throw new BrokerError('backend_unavailable');
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  async function resolveIdentity(accessToken, organizationId, signal) {
    const session = validSession(await auth.verifySession({ accessToken, signal }), clock());
    if (signal.aborted) fail('timeout');
    const authorization = validAuthorization(await auth.readAuthorization({
      accessToken, userId: session.userId, organizationId, signal,
    }), session.userId, organizationId, clock());
    if (signal.aborted) fail('timeout');
    return { session, authorization };
  }

  async function authorize(presentedToken, signal) {
    if (typeof presentedToken !== 'string' || !TOKEN.test(presentedToken)) fail('unauthorized');
    const digest = hash(presentedToken);
    const row = await connectionStore.getByDigest(digest);
    if (!row || row.state !== 'active' || row.expiresAt <= clock()) fail('unauthorized');
    const credential = await sessionStore.get(row.credentialRef);
    if (!credential || credential.expiresAt <= clock()) fail('unauthorized');
    const current = await resolveIdentity(credential.accessToken, row.organizationId, signal);
    if (current.session.userId !== row.userId || current.session.sessionId !== credential.sessionId ||
        current.session.userId !== credential.userId) fail('unauthorized');
    const latest = await connectionStore.get(row.id);
    // Recheck after awaited identity calls; a revoke/rotation may have raced them.
    if (!latest || latest.state !== 'active' || latest.expiresAt <= clock() || latest.tokenDigest !== digest) fail('unauthorized');
    if (latest.epoch !== row.epoch) fail('context_changed');
    const effective = effectivePermissions(current.authorization.permissions,
      current.authorization.companyCeilings, row.restrictions);
    return { row, effective, policyEpoch: current.authorization.epoch,
      isSuperadmin: current.authorization.isSuperadmin,
      contextVersion: hash(JSON.stringify({ connectionEpoch: row.epoch,
        authorizationEpoch: current.authorization.epoch, isSuperadmin: current.authorization.isSuperadmin, effective })) };
  }

  async function checkUnchanged(presentedToken, before, signal) {
    const after = await authorize(presentedToken, signal);
    if (after.row.id !== before.row.id || after.row.epoch !== before.row.epoch ||
        after.policyEpoch !== before.policyEpoch || after.isSuperadmin !== before.isSuperadmin ||
        JSON.stringify(after.effective) !== JSON.stringify(before.effective)) fail('context_changed');
  }

  function enter(id) {
    const now = clock();
    let entry = usage.get(id);
    if (!entry) { entry = { window: now, count: 0, active: 0 }; usage.set(id, entry); }
    if (now - entry.window >= 60_000) { entry.window = now; entry.count = 0; }
    if (entry.active >= limits.maxConcurrentCalls) fail('busy');
    if (entry.count >= limits.maxRequestsPerMinute) fail('rate_limited');
    entry.count += 1;
    entry.active += 1;
    return () => { entry.active -= 1; };
  }

  async function invoke(presentedToken, operation, handler, finalize) {
    let release;
    let identity;
    let comparisonReceipt;
    const requestId = randomUUID();
    try {
      return await bounded(async (signal) => {
        if (typeof presentedToken !== 'string' || !TOKEN.test(presentedToken)) fail('unauthorized');
        let connectionId;
        if (injectedAuthority) {
          const identified = await injectedAuthority.identifyConnection(presentedToken, { signal });
          if (!exactRecord(identified, ['connectionId']) || !canonicalId(identified.connectionId)) fail('backend_unavailable');
          connectionId = identified.connectionId;
        } else {
          const cheap = await connectionStore.getByDigest(hash(presentedToken));
          if (!cheap || cheap.state !== 'active' || cheap.expiresAt <= clock()) fail('unauthorized');
          connectionId = cheap.id;
        }
        if (signal.aborted) fail('timeout');
        // The joined identify read precedes admission; expensive Auth/crypto does not.
        release = enter(connectionId);
        if (injectedAuthority) {
          comparisonReceipt = await injectedAuthority.resolve(presentedToken, { signal });
          identity = authorityIdentity(comparisonReceipt, clock());
        } else identity = await authorize(presentedToken, signal);
        if (signal.aborted) fail('timeout');
        // A token cannot switch actors after reserving another connection's quota.
        if (identity.row.id !== connectionId) fail('context_changed');
        let result = await handler(identity, signal);
        if (signal.aborted) fail('timeout');
        if (!finalize && Buffer.byteLength(JSON.stringify(result)) > limits.maxResultBytes) fail('response_too_large');
        // This receipt means a response was prepared, not delivered. An async
        // audit sink can wait while DB authority changes, so the authoritative
        // post-read check must be the LAST awaited step before releasing data.
        await writeAudit({ requestId, operation, connectionId: identity.row.id, outcome: 'prepared' });
        if (injectedAuthority) {
          const checked = await injectedAuthority.checkUnchanged(presentedToken, comparisonReceipt, { signal });
          if (checked !== undefined) fail('backend_unavailable');
          if (comparisonReceipt.contextVersion !== identity.contextVersion) fail('context_changed');
        } else await checkUnchanged(presentedToken, identity, signal);
        if (signal.aborted) fail('timeout');
        // The room service consumes a private receipt after the audit and original
        // branded authority check. Its bound scope decision is the last I/O here;
        // only local protocol/byte validation and serialization may follow it.
        if (finalize) result = await finalize(result, identity, signal);
        if (signal.aborted) fail('timeout');
        if (Buffer.byteLength(JSON.stringify(result)) > limits.maxResultBytes) fail('response_too_large');
        return result;
      });
    } catch (error) {
      const safe = error instanceof BrokerError ? error : new BrokerError('backend_unavailable');
      // Audit failure is fail-closed. Never return a successful data response without a receipt.
      await bounded(() => writeAudit({ requestId, operation, connectionId: identity?.row.id ?? null,
        outcome: safe.code === 'timeout' ? 'timeout' : 'denied', code: safe.code }));
      throw safe;
    } finally {
      release?.();
    }
  }

  return Object.freeze({
    auditReceipts() { return structuredClone(receipts); },
    async issueConnection(input) {
      if (injectedAuthority) fail('forbidden');
      if (!exactKeys(input, ['accessToken', 'organizationId', 'restrictions']) ||
          typeof input.accessToken !== 'string' || input.accessToken.length < 1 || input.accessToken.length > 16_384 ||
          !validId(input.organizationId)) fail('invalid_request');
      const restrictions = permissions(input.restrictions);
      return bounded(async (signal) => {
        const current = await resolveIdentity(input.accessToken, input.organizationId, signal);
        const now = clock();
        const row = {
          id: randomUUID(), userId: current.session.userId, organizationId: input.organizationId,
          assistantId: await assistantStore.getOrCreate(current.session.userId, input.organizationId),
          restrictions, state: 'active', epoch: 1,
          expiresAt: Math.min(current.session.expiresAt, now + limits.tokenLifetimeMs),
        };
        const issuedToken = token();
        row.tokenDigest = hash(issuedToken);
        row.credentialRef = await sessionStore.put({ ...current.session, accessToken: input.accessToken });
        if (signal.aborted) { await sessionStore.delete(row.credentialRef); fail('timeout'); }
        try {
          await connectionStore.create(row);
          if (signal.aborted) fail('timeout');
        } catch (error) {
          await connectionStore.delete(row.id);
          await sessionStore.delete(row.credentialRef);
          throw error;
        }
        return { token: issuedToken, connection: safeConnection(row) };
      });
    },
    // Trusted control-plane methods. They are intentionally absent from MCP.
    async revokeConnection(id) {
      if (injectedAuthority) fail('forbidden');
      const row = await connectionStore.get(id);
      if (!row) fail('unauthorized');
      if (row.state === 'revoked') return;
      if (!await connectionStore.replace(id, row.epoch, { ...row, state: 'revoked', epoch: row.epoch + 1 })) fail('context_changed');
      await sessionStore.delete(row.credentialRef);
    },
    async restrictConnection(id, nextRestrictions) {
      if (injectedAuthority) fail('forbidden');
      const restrictions = permissions(nextRestrictions);
      const row = await connectionStore.get(id);
      if (!row || row.state !== 'active') fail('unauthorized');
      // P1 management only tightens. Regrant/rotation requires a fresh verified connection.
      for (const kind of ['read', 'action']) {
        if (restrictions[kind].some((key) => !row.restrictions[kind].includes(key))) fail('forbidden');
      }
      if (!await connectionStore.replace(id, row.epoch, { ...row, restrictions, epoch: row.epoch + 1 })) fail('context_changed');
    },
    async authenticate(presentedToken) {
      return invoke(presentedToken, 'authenticate', (identity) => safeConnection(identity.row));
    },
    async listTools(presentedToken) {
      return invoke(presentedToken, 'tools/list', (identity) => ({
        tools: [...(identity.effective.read.includes(CONTEXT_PERMISSION) ? [structuredClone(TOOL)] : []),
          ...(mayReadRooms(identity) ? [structuredClone(ROOM_TOOL)] : [])],
      }));
    },
    async callTool(presentedToken, name, args) {
      // Snapshot caller-controlled filters before any awaited admission. Invalid
      // input still goes through the shared admission/audit path.
      let request, invalidFilters = false;
      if (name === ROOM_TOOL.name) { try { request = roomFilters(args); } catch { invalidFilters = true; } }
      return invoke(presentedToken, 'tools/call', async (identity, signal) => {
        if (name === ROOM_TOOL.name) {
          if (!mayReadRooms(identity)) fail('tool_not_available');
          if (invalidFilters) fail('invalid_request');
          const prepared = await rooms.prepareAvailableRooms(presentedToken, request, { signal });
          if (!exactData(prepared, []) || !Object.isFrozen(prepared)) fail('backend_unavailable');
          return prepared;
        }
        if (name !== TOOL.name || !identity.effective.read.includes(CONTEXT_PERMISSION)) fail('tool_not_available');
        if (!exactKeys(args, []) || Object.keys(args).length !== 0) fail('invalid_request');
        const result = {
          assistantId: identity.row.assistantId, userId: identity.row.userId,
          organizationId: identity.row.organizationId, permissions: identity.effective,
          contextVersion: identity.contextVersion,
        };
        return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
      }, name === ROOM_TOOL.name && rooms ? async (prepared, identity, signal) =>
        roomResult(await rooms.finalizeAvailableRooms(presentedToken, prepared, { signal }), request, identity) : undefined);
    },
  });
}
