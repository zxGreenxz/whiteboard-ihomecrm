import { createHash } from 'node:crypto';
import { BrokerError } from './broker.mjs';
import { validateSessionMaterial } from './session-crypto.mjs';
import { projectAvailableRooms, projectAvailableRoomsPage } from './room-read-projection.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPAQUE = /^hc_[A-Za-z0-9_-]{43}$/;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const CAP = /^[a-z][a-z0-9_.:-]{0,127}$/;
const PERMISSION = 'rooms.view';
const BOUND_INPUT = ['connectionId', 'tokenDigest', 'expectedEpoch', 'expectedPolicyVersion', 'expectedMembershipId',
  'expectedAuthorizationVersion', 'expectedSessionRevision'];
const MAP_BINDING = ['connectionId', 'epoch', 'policyVersion', 'membershipId', 'authorizationVersion', 'sessionRevision'];
/** The page RPC binds only the connection/token/epoch/session revision; membership,
 * policy and scope are decided by that one STABLE SQL statement (like the fast domain read). */
const PAGE_BINDING = ['connectionId', 'tokenDigest', 'expectedEpoch', 'expectedSessionRevision'];
const PAGE_AUTHORITY = ['organizationId', 'userId', 'connectionId', 'permission', 'buildingIds', 'cashbookIds'];
export const ROOM_READ_MODES = Object.freeze(['legacy', 'page']);
const PAGE_RPC = 'hermes_available_rooms_page_v1';
const record = value => value !== null && typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key => typeof key === 'string' &&
    Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const id = value => typeof value === 'string' && UUID.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
const fail = code => { throw new BrokerError(code); };
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function userJwt(value) {
  if (typeof value !== 'string' || value.length > 16384 || !JWT.test(value)) return false;
  // This only rejects privileged/malformed input. It never authenticates claims;
  // the service's actual Auth verification is still required before using reads.
  try { const claims = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString('utf8'));
    return record(claims) && claims.role === 'authenticated' && id(claims.sub) && id(claims.session_id); }
  catch { return false; }
}
function list(value, predicate = id, cap = 256, code = 'backend_unavailable') {
  if (!Array.isArray(value) || value.length > cap || Array.from(value).some(item => !predicate(item)) || new Set(value).size !== value.length) fail(code);
  return [...value].sort();
}
function permissions(value) {
  if (!exact(value, ['read', 'action'])) fail('backend_unavailable');
  return Object.fromEntries(['read', 'action'].map(kind => [kind, list(value[kind], key => typeof key === 'string' && CAP.test(key))]));
}
function filters(value) {
  if (!record(value) || Object.keys(value).some(key => !['buildingName', 'offset', 'limit'].includes(key))) fail('invalid_request');
  const { buildingName = '', offset = 0, limit = 50 } = value;
  if (typeof buildingName !== 'string' || buildingName.length > 120 || !Number.isInteger(offset) || offset < 0 || offset > 2000 ||
      !Number.isInteger(limit) || limit < 1 || limit > 100) fail('invalid_request');
  return { buildingName, offset, limit };
}
function pageBinding(value) {
  if (!exact(value, PAGE_BINDING) || !id(value.connectionId) || typeof value.tokenDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.tokenDigest) ||
      !positive(value.expectedEpoch) || !positive(value.expectedSessionRevision)) fail('invalid_request');
  return Object.fromEntries(PAGE_BINDING.map(key => [key, value[key]]));
}
function authoritySnapshot(value, now) {
  if (!exact(value, ['row', 'effective', 'policyEpoch', 'isSuperadmin', 'assistantScopeIds', 'scopesByPermission', 'contextVersion']) ||
      !exact(value.row, ['id', 'assistantId', 'userId', 'organizationId', 'state', 'epoch', 'expiresAt', 'restrictions']) ||
      ['id', 'assistantId', 'userId', 'organizationId'].some(key => !id(value.row[key])) || value.row.state !== 'active' ||
      !positive(value.row.epoch) || !positive(value.row.expiresAt) || typeof value.isSuperadmin !== 'boolean' ||
      ![value.policyEpoch, value.contextVersion].every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v))) fail('backend_unavailable');
  if (value.row.expiresAt <= now) fail('unauthorized');
  const effective = permissions(value.effective), restrictions = permissions(value.row.restrictions);
  if (!effective.read.includes(PERMISSION) || !restrictions.read.includes(PERMISSION)) fail('forbidden');
  const scopes = value.scopesByPermission;
  if (!record(scopes) || Object.keys(scopes).length > 256 || !exact(scopes[PERMISSION], ['buildingIds', 'cashbookIds'])) fail('backend_unavailable');
  // No union with other permission scopes, cashbook IDs, or isSuperadmin bypass.
  const buildingIds = list(scopes[PERMISSION].buildingIds); list(scopes[PERMISSION].cashbookIds);
  const assistantScopeIds = list(value.assistantScopeIds);
  if (!buildingIds.length || !assistantScopeIds.length) fail('forbidden');
  return { row: { id: value.row.id, assistantId: value.row.assistantId, userId: value.row.userId, organizationId: value.row.organizationId,
    state: value.row.state, epoch: value.row.epoch, expiresAt: value.row.expiresAt, restrictions },
  contextVersion: value.contextVersion, assistantScopeIds, buildingIds };
}

/** Pure mapper for the map projection within hermes_room_scope_map_v1.
 * Bound RPC metadata (binding and permissionBuildingIds) is validated separately
 * by boundMapping before this pure mapper is used by the service.
 * Projection: {organizationId,complete:true,scopes:[{id,scopeType,buildingId,
 * areaId,cashbookId}],areaBuildings:[{organizationId,areaId,buildingId}]}.
 * SQL must resolve EVERY requested authorization_scopes.id in this org, reject
 * missing/foreign nodes (and deleted targets for restricted/legacy selection).
 * Inherited unrestricted tombstones contribute zero buildings/AREA edges.
 * Return all selected live AREA edges intersected
 * with current rooms.view. It must not silently LIMIT/paginate: overflow denies.
 * No labels or names are used as authority. CASHBOOK adds no building permission.
 */
function mappingSnapshot(input, payload) {
  if (!exact(input, ['organizationId', 'assistantScopeIds', 'permissionBuildingIds']) || !id(input.organizationId)) fail('invalid_request');
  const requested = list(input.assistantScopeIds, id, 256, 'invalid_request');
  const permitted = list(input.permissionBuildingIds, id, 256, 'invalid_request');
  if (!requested.length || !permitted.length) fail('forbidden');
  if (!exact(payload, ['organizationId', 'complete', 'scopes', 'areaBuildings']) || payload.organizationId !== input.organizationId || payload.complete !== true ||
      !Array.isArray(payload.scopes) || payload.scopes.length !== requested.length || !Array.isArray(payload.areaBuildings) ||
      payload.areaBuildings.length >= 4096) fail('backend_unavailable');
  const seen = new Set(), nodes = new Set(), areas = new Set(), selected = new Set();
  const scopes = Array.from(payload.scopes, row => {
    if (!exact(row, ['id', 'scopeType', 'buildingId', 'areaId', 'cashbookId']) || !id(row.id) || !requested.includes(row.id) || seen.has(row.id)) fail('backend_unavailable');
    seen.add(row.id);
    if (!['ORGANIZATION', 'AREA', 'BUILDING', 'CASHBOOK'].includes(row.scopeType)) fail('backend_unavailable');
    const dimension = { ORGANIZATION: null, AREA: 'areaId', BUILDING: 'buildingId', CASHBOOK: 'cashbookId' }[row.scopeType];
    for (const key of ['buildingId', 'areaId', 'cashbookId']) if (key === dimension ? !id(row[key]) : row[key] !== null) fail('backend_unavailable');
    const node = `${row.scopeType}:${dimension ? row[dimension] : input.organizationId}`;
    if (nodes.has(node)) fail('backend_unavailable'); nodes.add(node);
    if (row.scopeType === 'ORGANIZATION') permitted.forEach(value => selected.add(value));
    if (row.scopeType === 'BUILDING' && permitted.includes(row.buildingId)) selected.add(row.buildingId);
    if (row.scopeType === 'AREA') areas.add(row.areaId);
    return { id: row.id, scopeType: row.scopeType, buildingId: row.buildingId, areaId: row.areaId, cashbookId: row.cashbookId };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const edges = new Set();
  const areaBuildings = Array.from(payload.areaBuildings, row => {
    if (!exact(row, ['organizationId', 'areaId', 'buildingId']) || row.organizationId !== input.organizationId ||
        !id(row.areaId) || !id(row.buildingId) || !areas.has(row.areaId) || !permitted.includes(row.buildingId)) fail('backend_unavailable');
    const edge = `${row.areaId}:${row.buildingId}`; if (edges.has(edge)) fail('backend_unavailable'); edges.add(edge);
    selected.add(row.buildingId);
    return { organizationId: row.organizationId, areaId: row.areaId, buildingId: row.buildingId };
  }).sort((a, b) => a.areaId.localeCompare(b.areaId) || a.buildingId.localeCompare(b.buildingId));
  return { organizationId: input.organizationId, scopes, areaBuildings, allowedBuildingIds: [...selected].sort() };
}
export function mapRoomBuildingScope(input, payload) {
  const result = mappingSnapshot(input, payload);
  if (!result.allowedBuildingIds.length) fail('forbidden');
  return result.allowedBuildingIds;
}

function boundScopeInput(value) {
  if (!id(value.connectionId) || typeof value.tokenDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.tokenDigest) ||
      !id(value.expectedMembershipId) || BOUND_INPUT.filter(key => key.startsWith('expected') && key !== 'expectedMembershipId')
        .some(key => !(key === 'expectedPolicyVersion' && value[key] === 0) && !positive(value[key]))) fail('invalid_request');
  return Object.fromEntries(BOUND_INPUT.map(key => [key, value[key]]));
}
function boundMapping(snapshot, payload) {
  if (!exact(payload, ['organizationId', 'complete', 'scopes', 'areaBuildings', 'permissionBuildingIds', 'binding']) ||
      !exact(payload.binding, MAP_BINDING)) fail('backend_unavailable');
  const expected = { connectionId: snapshot.bound.connectionId, epoch: snapshot.bound.expectedEpoch,
    policyVersion: snapshot.bound.expectedPolicyVersion, membershipId: snapshot.bound.expectedMembershipId,
    authorizationVersion: snapshot.bound.expectedAuthorizationVersion, sessionRevision: snapshot.bound.expectedSessionRevision };
  if (MAP_BINDING.some(key => payload.binding[key] !== expected[key])) fail('context_changed');
  const buildings = list(payload.permissionBuildingIds);
  if (!same(buildings, snapshot.scopeInput.permissionBuildingIds)) fail('context_changed');
  return mappingSnapshot(snapshot.scopeInput, Object.fromEntries(['organizationId', 'complete', 'scopes', 'areaBuildings'].map(key => [key, payload[key]])));
}
/** The page RPC's authority envelope must name this very admitted connection and
 * only buildings the connector's own rooms.view snapshot already allows. The SQL
 * decided the assistant/CRM scope; the result must still fit the admitted view. */
function pageEnvelope(payload, current, binding) {
  if (!exact(payload, ['authority', 'result'])) fail('backend_unavailable');
  const live = payload.authority;
  if (!exact(live, PAGE_AUTHORITY) || live.organizationId !== current.row.organizationId || live.userId !== current.row.userId ||
      live.connectionId !== binding.connectionId || live.permission !== PERMISSION || !Array.isArray(live.cashbookIds) || live.cashbookIds.length) fail('backend_unavailable');
  const buildings = list(live.buildingIds);
  if (!buildings.length) fail('forbidden');
  if (buildings.some(value => !current.buildingIds.includes(value))) fail('context_changed');
  // Every page building must be inside the set the same statement admitted.
  if (!record(payload.result) || !Array.isArray(payload.result.buildings) ||
      payload.result.buildings.some(row => !record(row) || !buildings.includes(row.id))) fail('backend_unavailable');
  return payload.result;
}

async function bounded(signal, timeoutMs, operation, dependencyScope) {
  if (!(signal instanceof AbortSignal)) fail('invalid_request');
  if (signal.aborted) fail('timeout');
  const controller = new AbortController(); let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const stop = () => { controller.abort(); rejectAbort(new BrokerError('timeout')); };
  signal.addEventListener('abort', stop, { once: true }); const timer = setTimeout(stop, timeoutMs);
  const check = () => { if (signal.aborted || controller.signal.aborted) fail('timeout'); };
  const run = () => { check(); return operation(controller.signal, check); };
  try { return await Promise.race([dependencyScope ? dependencyScope.track(run) : Promise.resolve().then(run), aborted]); }
  catch (error) { if (error instanceof BrokerError) throw error; fail('backend_unavailable'); }
  finally { clearTimeout(timer); signal.removeEventListener('abort', stop); controller.abort(); }
}

/** Candidate read service, NOT an exposed MCP tool or a second dispatcher.
 * Only the opaque token is accepted; JWT/refresh material remains backend-local.
 * Reuses actual authority/Auth/crypto/store and the existing room projection.
 * No refresh, quota, audit, retries, SQL or service-role identity is introduced.
 * prepareAvailableRooms returns an empty, process-local branded receipt. Only
 * finalizeAvailableRooms consumes it and returns data; no JWT or projected room
 * data is present on the receipt. The future broker must place its awaited audit
 * BETWEEN prepare and finalize. availableRooms is their trusted-only convenience
 * composition, not an audit/quota bypass suitable for a public endpoint.
 * Shared preview/send callers retain the final authority and bound SQL decision.
 * The direct read broker opts into useInitialAdmission after its awaited audit:
 * that read may finish with the initial permission/scope snapshot. Finalization
 * still consumes the receipt and enforces token, expiry, deadline and abort.
 * Receipt is single-use and expires within timeoutMs. No finalization retry or
 * cache is supplied; a changed context requires a fresh admission and room read.
 *
 * roomRead selects the DIRECT tool's source: 'legacy' (scope map RPC + whole
 * company sale page, filtered and paged here) or 'page' (one bound RPC
 * hermes_available_rooms_page_v1 that admits the connection, derives the building
 * set and returns the filtered page; no scope map call, no fallback when the RPC
 * is missing). Callers may pin a mode per call; group preview/send always pin
 * 'legacy' because their SQL decision recomputes the legacy digest. A page
 * receipt is only finalized with useInitialAdmission (the direct read lane).
 */
export function createRoomReadService({ authority, connectionStore, crypto, auth, reads, clock = Date.now, timeoutMs = 30000, roomRead = 'legacy' } = {}) {
  if ([authority?.resolve, authority?.checkUnchanged, connectionStore?.readConnection, crypto?.open, auth?.verifySession,
    reads?.scopeMap, reads?.availableRooms, clock].some(fn => typeof fn !== 'function') || !positive(timeoutMs) || timeoutMs > 30000 ||
    !ROOM_READ_MODES.includes(roomRead) || (roomRead === 'page' && typeof reads.availableRoomsPage !== 'function')) throw new TypeError('invalid_room_read_service_config');
  const now = () => { const value = clock(); if (!positive(value) || value > 8_640_000_000_000_000) fail('backend_unavailable'); return value; };
  const issued = new WeakMap();
  const map = async (snapshot, signal) => reads.scopeMap({ accessToken: snapshot.accessToken,
    organizationId: snapshot.scopeInput.organizationId, scopeIds: [...snapshot.scopeInput.assistantScopeIds],
    ...snapshot.bound }, { signal });
  async function prepareAvailableRooms(presentedToken, suppliedFilters = {}, { signal, roomRead: mode = roomRead } = {}) {
    if (typeof presentedToken !== 'string' || !OPAQUE.test(presentedToken)) fail('unauthorized');
    if (!ROOM_READ_MODES.includes(mode)) fail('invalid_request');
    if (mode === 'page' && typeof reads.availableRoomsPage !== 'function') fail('backend_unavailable');
    const options = filters(suppliedFilters), tokenDigest = hash(presentedToken);
    return bounded(signal, timeoutMs, async (innerSignal, check) => {
      const receipt = await authority.resolve(presentedToken, { signal: innerSignal }); check();
      const current = authoritySnapshot(receipt, now());
      const joined = await connectionStore.readConnection({ tokenDigest }, { signal: innerSignal }); check();
      if (!record(joined) || joined.status !== 'active' || !record(joined.connection) || !record(joined.session)) fail('unauthorized');
      const row = joined.connection, session = joined.session;
      if (['id', 'assistantId', 'userId', 'organizationId', 'state', 'epoch', 'expiresAt'].some(key => row[key] !== current.row[key]) ||
          row.tokenDigest !== tokenDigest || !id(row.credentialRef) || session.credentialRef !== row.credentialRef || !positive(session.revision) ||
          !positive(session.expiresAt) || !exact(session.binding, ['assistantId', 'userId', 'organizationId', 'sessionId']) ||
          ['assistantId', 'userId', 'organizationId'].some(key => session.binding[key] !== current.row[key]) || !id(session.binding.sessionId)) fail('context_changed');
      const binding = { ...session.binding };
      // Drop the refresh token immediately; no refresh API exists in this service.
      const opened = validateSessionMaterial(crypto.open(session.envelope, binding));
      const { accessToken, expiresAt } = opened; opened.refreshToken = undefined;
      const fresh = () => { check(); if (expiresAt <= now() || current.row.expiresAt <= now()) fail('unauthorized'); };
      if (expiresAt !== session.expiresAt) fail('context_changed'); fresh();
      const verified = await auth.verifySession({ accessToken, signal: innerSignal }); fresh();
      if (!exact(verified, ['userId', 'sessionId', 'expiresAt']) || verified.userId !== binding.userId ||
          verified.sessionId !== binding.sessionId || verified.expiresAt !== expiresAt) fail('unauthorized');
      const scopeInput = { organizationId: current.row.organizationId, assistantScopeIds: current.assistantScopeIds,
        permissionBuildingIds: current.buildingIds };
      if (!record(joined.membership) || !record(joined.policy)) fail('backend_unavailable');
      let bound;
      try { bound = boundScopeInput({ connectionId: current.row.id, tokenDigest, expectedEpoch: current.row.epoch,
        expectedPolicyVersion: joined.policy.version, expectedMembershipId: joined.membership.membershipId,
        expectedAuthorizationVersion: joined.membership.authorizationVersion, expectedSessionRevision: session.revision }); }
      catch { fail('backend_unavailable'); }
      const snapshot = { accessToken, tokenDigest, expiresAt, current, receipt, scopeInput, bound, mode };
      if (mode === 'page') {
        // One bound STABLE statement admits the connection, derives the building set
        // (rooms.view ∩ assistant scope) and returns the already filtered page.
        const pageBound = pageBinding({ connectionId: current.row.id, tokenDigest, expectedEpoch: current.row.epoch, expectedSessionRevision: session.revision });
        const payload = await reads.availableRoomsPage({ accessToken, organizationId: current.row.organizationId, binding: pageBound, filters: options }, { signal: innerSignal }); fresh();
        const result = projectAvailableRoomsPage(pageEnvelope(payload, current, pageBound), { offset: options.offset, limit: options.limit, readAt: now() });
        const prepared = Object.freeze({});
        issued.set(prepared, { ...snapshot, result, deadline: now() + timeoutMs });
        return prepared;
      }
      const initial = await map(snapshot, innerSignal); fresh();
      const before = boundMapping(snapshot, initial);
      if (!before.allowedBuildingIds.length) fail('forbidden');
      const payload = await reads.availableRooms({ accessToken, organizationId: current.row.organizationId }, { signal: innerSignal }); fresh();
      const result = projectAvailableRooms(payload, { ...options, allowedBuildingIds: before.allowedBuildingIds, readAt: now() });
      const prepared = Object.freeze({});
      issued.set(prepared, { ...snapshot, before, result, deadline: now() + timeoutMs });
      return prepared;
    });
  }
  async function finalizeAvailableRooms(presentedToken, prepared, { signal, useInitialAdmission = false } = {}) {
    if (typeof useInitialAdmission !== 'boolean') fail('invalid_request');
    if (typeof presentedToken !== 'string' || !OPAQUE.test(presentedToken)) fail('unauthorized');
    if (!issued.has(prepared)) fail('context_changed');
    const snapshot = issued.get(prepared); issued.delete(prepared);
    if (hash(presentedToken) !== snapshot.tokenDigest) fail('context_changed');
    // A page receipt carries no scope map to recompare: only the direct read lane
    // (initial admission after its audit) may consume it.
    if (snapshot.mode === 'page' && !useInitialAdmission) fail('invalid_request');
    return bounded(signal, timeoutMs, async (innerSignal, check) => {
      const fresh = () => { check(); const time = now();
        if (snapshot.expiresAt <= time || snapshot.current.row.expiresAt <= time) fail('unauthorized');
        if (time >= snapshot.deadline) fail('timeout'); };
      fresh();
      if (useInitialAdmission) return snapshot.result;
      const checked = await authority.checkUnchanged(presentedToken, snapshot.receipt, { signal: innerSignal }); fresh();
      if (checked !== undefined || snapshot.receipt.contextVersion !== snapshot.current.contextVersion) fail('context_changed');
      // Last await: one bound SQL snapshot checks both the assistant lifecycle
      // and scope mapping, so neither an earlier Auth await nor a later mapping
      // await can hide an intervening policy/revoke/AREA change from this fence.
      const final = await map(snapshot, innerSignal); fresh();
      const after = boundMapping(snapshot, final);
      if (!same(snapshot.before, after)) fail('context_changed');
      return snapshot.result;
    });
  }
  return Object.freeze({ prepareAvailableRooms, finalizeAvailableRooms,
    async availableRooms(presentedToken, suppliedFilters = {}, options = {}) {
      const prepared = await prepareAvailableRooms(presentedToken, suppliedFilters, options);
      return finalizeAvailableRooms(presentedToken, prepared, options);
    } });
}

async function jsonBody(response, cap, signal) {
  if (response.redirected || !response.body || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') ||
      Number(response.headers.get('content-length')) > cap) { await response.body?.cancel().catch(() => {}); fail('backend_unavailable'); }
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  let cancellation;
  const stop = () => cancellation ??= reader.cancel().catch(() => {}); signal.addEventListener('abort', stop, { once: true });
  try {
    while (true) { signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted(); if (part.done) break;
      bytes += part.value.byteLength; if (bytes > cap) fail('response_too_large'); chunks.push(part.value); }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { signal.removeEventListener('abort', stop); await stop(); reader.releaseLock(); }
}
/** PostgREST error envelope of the bound page RPC: the same status+SQLSTATE map as
 * bound-user-rpc. A missing function (PGRST202) is backend_unavailable, never a
 * fallback to the legacy whole-company read. */
function pageRpcError(response, data) {
  const error = exact(data, ['code', 'message', 'details', 'hint']) && typeof data.code === 'string' && typeof data.message === 'string' &&
    [data.details, data.hint].every(v => v === null || typeof v === 'string');
  if (response.status === 401) fail('unauthorized');
  if (response.status === 403 && error && data.code === '42501') fail('forbidden');
  if (response.status === 409 && error && data.code === 'PT409') fail('context_changed');
  if (response.status === 400 && error && data.code === '22023') fail('invalid_request');
  if (response.status === 413 && error && data.code === 'PT413') fail('result_too_large');
  if (!response.ok || !record(data) || ['error', 'error_code', 'error_description'].some(key => Object.hasOwn(data, key))) fail('backend_unavailable');
}

/** Exactly three fixed POST RPCs with the verified assistant's real JWT.
 * Rooms come from hermes_sale_listing_rooms_v1: the company's published sale page
 * (the same get_public_available_rooms reader as the share link), cut to the
 * caller's current rooms.view scope in SQL and to the assistant scope here.
 * hermes_room_scope_map_v1 requires its separately reviewed/applied migration;
 * this module neither creates it nor treats a missing RPC as an empty map.
 * availableRoomsPage posts the 4-field binding plus the caller's filters to
 * hermes_available_rooms_page_v1 (B3): the SQL admits the connection, derives
 * the building set and returns one filtered page. Its arguments are all seven
 * named parameters (narrowing lists are sent as null: this read never narrows
 * below the derived set); a missing RPC is backend_unavailable, no fallback.
 * The backend derives its expected binding and token digest from the admitted
 * connection; they must never become model/tool arguments. Its STABLE decision
 * checks live membership, rooms.view, connection lifecycle and mapping together.
 * The existing admin catalog is intentionally not a fallback.
 */
export function createSupabaseRoomReads({ url, publishableKey, fetch: request = globalThis.fetch,
  timeoutMs = 10000, maxResponseBytes = 2_097_152, dependencyScope } = {}) {
  let origin; try { origin = new URL(url); } catch { throw new TypeError('invalid_room_reads_config'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
      typeof publishableKey !== 'string' || !/^sb_publishable_[A-Za-z0-9_-]{1,512}$/.test(publishableKey) || typeof request !== 'function' ||
      !positive(timeoutMs) || timeoutMs > 30000 || !positive(maxResponseBytes) || maxResponseBytes > 4_194_304 ||
      (dependencyScope !== undefined && typeof dependencyScope?.track !== 'function')) throw new TypeError('invalid_room_reads_config');
  const post = (path, accessToken, body, signal) => request(new URL(`/rest/v1/rpc/${path}`, origin).href, { method: 'POST', redirect: 'error', signal,
    headers: { apikey: publishableKey, authorization: `Bearer ${accessToken}`, 'content-type': 'application/json',
      'content-profile': 'public', 'accept-profile': 'public' }, body });
  const legacy = Object.fromEntries(['scopeMap', 'availableRooms'].map(operation => [operation, async (input, { signal } = {}) => {
    if (!exact(input, operation === 'scopeMap' ? ['accessToken', 'organizationId', 'scopeIds', ...BOUND_INPUT] : ['accessToken', 'organizationId']) ||
        !userJwt(input.accessToken) || !id(input.organizationId)) fail('invalid_request');
    const accessToken = input.accessToken;
    const args = { p_organization_id: input.organizationId };
    if (operation === 'scopeMap') {
      const bound = boundScopeInput(input);
      args.p_scope_ids = list(input.scopeIds, id, 256, 'invalid_request'); if (!args.p_scope_ids.length) fail('invalid_request');
      Object.assign(args, { p_connection_id: bound.connectionId, p_token_digest: bound.tokenDigest, p_expected_epoch: bound.expectedEpoch,
        p_expected_policy_version: bound.expectedPolicyVersion, p_expected_membership_id: bound.expectedMembershipId,
        p_expected_authorization_version: bound.expectedAuthorizationVersion, p_expected_session_revision: bound.expectedSessionRevision });
    }
    const body = JSON.stringify(args), path = operation === 'scopeMap' ? 'hermes_room_scope_map_v1' : 'hermes_sale_listing_rooms_v1';
    return bounded(signal, timeoutMs, async (innerSignal, check) => {
      const response = await post(path, accessToken, body, innerSignal);
      if (innerSignal.aborted) { await response.body?.cancel().catch(() => {}); check(); }
      const data = await jsonBody(response, maxResponseBytes, innerSignal); check();
      if (response.status === 401) fail('unauthorized');
      if (response.status === 403 || data?.code === '42501') fail('forbidden');
      if (response.status === 409 && data?.code === 'PT409') fail('context_changed');
      if (!response.ok || !record(data) || ['error', 'error_code', 'error_description'].some(key => Object.hasOwn(data, key))) fail('backend_unavailable');
      return data;
    }, dependencyScope);
  }]));
  async function availableRoomsPage(input, { signal } = {}) {
    if (!exact(input, ['accessToken', 'organizationId', 'binding', 'filters']) || !userJwt(input.accessToken) || !id(input.organizationId)) fail('invalid_request');
    const binding = pageBinding(input.binding), page = filters(input.filters), accessToken = input.accessToken;
    const body = JSON.stringify({ p_binding: binding, p_organization_id: input.organizationId, p_building_ids: null,
      p_building_name: page.buildingName, p_statuses: null, p_limit: page.limit, p_offset: page.offset });
    return bounded(signal, timeoutMs, async (innerSignal, check) => {
      const response = await post(PAGE_RPC, accessToken, body, innerSignal);
      if (innerSignal.aborted) { await response.body?.cancel().catch(() => {}); check(); }
      const data = await jsonBody(response, maxResponseBytes, innerSignal); check();
      pageRpcError(response, data);
      return data;
    }, dependencyScope);
  }
  return Object.freeze({ ...legacy, availableRoomsPage });
}
