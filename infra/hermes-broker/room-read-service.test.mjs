import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { createRoomReadService, createSupabaseRoomReads, mapRoomBuildingScope } from './room-read-service.mjs';
import { createDurableAuthority } from './durable-authority.mjs';
import { createSessionCrypto } from './session-crypto.mjs';
import { BrokerError } from './broker.mjs';

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const I = { org: id(1), user: id(2), assistant: id(3), connection: id(4), session: id(5), credential: id(6), membership: id(7),
  a: id(11), b: id(12), foreign: id(13), area: id(21), scope: id(31), otherScope: id(32), book: id(41) };
const NOW = Date.parse('2026-10-12T08:00:00Z'), opaque = 'hc_' + 'A'.repeat(43);
const digest = createHash('sha256').update(opaque).digest('hex');
const jwt = role => ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ role: role ?? 'authenticated', sub: I.user,
  session_id: I.session, exp: NOW / 1000 + 600 })).toString('base64url'), 'signature'].join('.');
const limits = () => ({ read: ['assistant.context.read', 'rooms.view'], action: [] });
const scope = (scopeType = 'BUILDING', identifier = I.scope, target = I.a) => ({ id: identifier, scopeType,
  buildingId: scopeType === 'BUILDING' ? target : null, areaId: scopeType === 'AREA' ? target : null, cashbookId: scopeType === 'CASHBOOK' ? target : null });
const mapping = (scopes = [scope()], areaBuildings = []) => ({ organizationId: I.org, complete: true, scopes, areaBuildings });
const edge = (buildingId = I.a, areaId = I.area) => ({ organizationId: I.org, areaId, buildingId });
const mapInput = (assistantScopeIds = [I.scope], permissionBuildingIds = [I.a, I.b]) => ({ organizationId: I.org, assistantScopeIds, permissionBuildingIds });
const boundInput = () => ({ connectionId: I.connection, tokenDigest: digest, expectedEpoch: 1, expectedPolicyVersion: 1,
  expectedMembershipId: I.membership, expectedAuthorizationVersion: 1, expectedSessionRevision: 1 });
const proof = (value = mapping()) => ({ ...value, permissionBuildingIds: [I.a, I.b], binding: { connectionId: I.connection,
  epoch: 1, policyVersion: 1, membershipId: I.membership, authorizationVersion: 1, sessionRevision: 1 } });
const building = value => ({ id: value, name: 'Cùng tên', code: 'B', secret: 'PRIVATE BUILDING' });
const room = (value, buildingId) => ({ id: value, building_id: buildingId, code: 'P101', name: 'Phòng', floor: 1, area: 24,
  rent_price: 4_000_000, deposit_amount: 8_000_000, status_public: 'free', sale_state: 'VACANT', sale_today: '2026-10-12',
  avail_date: null, expected_ready_on: null, contact: 'PRIVATE PHONE', internal_note: 'PRIVATE NOTE' });
const payload = () => ({ pages: 1, buildings: [building(I.a), building(I.b), building(I.foreign)],
  rooms: [room(id(51), I.a), room(id(52), I.b), room(id(53), I.foreign)], contact: 'PRIVATE CONTACT' });
const code = expected => error => error instanceof BrokerError && error.code === expected && error.message === expected && error.cause === undefined;
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture() {
  let time = NOW; const events = [], controller = new AbortController();
  const crypto = createSessionCrypto({ activeKeyVersion: 'test', keys: new Map([['test', randomBytes(32)]]) });
  const binding = { assistantId: I.assistant, userId: I.user, organizationId: I.org, sessionId: I.session };
  const material = { accessToken: jwt(), refreshToken: 'PRIVATE_REFRESH', expiresAt: NOW + 600_000 };
  const joined = { status: 'active', connection: { id: I.connection, assistantId: I.assistant, userId: I.user,
    organizationId: I.org, state: 'active', epoch: 1, expiresAt: NOW + 300_000, restrictions: limits(), scopeIds: [I.scope],
    tokenDigest: digest, credentialRef: I.credential },
  session: { credentialRef: I.credential, revision: 1, envelope: crypto.seal(material, binding), expiresAt: material.expiresAt, binding },
  membership: { membershipId: I.membership, authorizationVersion: 1, isSuperadmin: false },
  policy: { version: 1, read: limits().read, action: [], scopeIds: [I.scope] } };
  const authz = { userId: I.user, isSuperadmin: false, activeOrganizationIds: [I.org], epoch: 'crm-1',
    membership: { organizationId: I.org, status: 'ACTIVE', revokedAt: null, validFrom: null, validTo: null,
      membershipId: I.membership, authorizationVersion: 1 }, permissions: limits(), companyCeilings: limits(),
    scopesByPermission: { 'assistant.context.read': { buildingIds: [], cashbookIds: [] },
      'rooms.view': { buildingIds: [I.a, I.b], cashbookIds: [] } } };
  const auth = {
    async verifySession({ accessToken }) { events.push('verify'); assert.equal(accessToken, material.accessToken);
      return { userId: I.user, sessionId: I.session, expiresAt: material.expiresAt }; },
    async readAuthorization() { events.push('authz'); return structuredClone(authz); },
  };
  const connectionStore = { async readConnection(input) { events.push('store'); assert.deepEqual(input, { tokenDigest: digest }); return structuredClone(joined); } };
  const authority = createDurableAuthority({ auth, connectionStore, crypto, clock: () => time });
  const reads = {
    async scopeMap(input) { events.push('map'); assert.deepEqual(input, { accessToken: material.accessToken,
      organizationId: I.org, scopeIds: [I.scope], ...boundInput() }); return proof(); },
    async availableRooms(input) { events.push('rooms'); assert.equal(input.accessToken, material.accessToken); assert.equal(input.organizationId, I.org); return payload(); },
  };
  const create = extra => createRoomReadService({ authority, connectionStore, crypto, auth, reads, clock: () => time, ...extra });
  return { create, authority, auth, authz, reads, connectionStore, crypto, joined, material, events, controller,
    options: { signal: controller.signal }, time: value => { time = value; } };
}

test('scope mapping distinguishes authorization-scope IDs from resource IDs and intersects only the supplied permission', () => {
  assert.deepEqual(mapRoomBuildingScope(mapInput(), mapping()), [I.a]);
  assert.deepEqual(mapRoomBuildingScope(mapInput(), mapping([scope('ORGANIZATION')])), [I.a, I.b]);
  assert.deepEqual(mapRoomBuildingScope(mapInput(), mapping([scope('AREA', I.scope, I.area)], [edge(I.b)])), [I.b]);
  assert.throws(() => mapRoomBuildingScope(mapInput([I.a]), mapping()), code('backend_unavailable'));
  assert.throws(() => mapRoomBuildingScope(mapInput(), mapping([scope('BUILDING', I.scope, I.foreign)])), code('forbidden'));
});
test('CASHBOOK never grants rooms while a mixed legitimate building remains usable', () => {
  assert.throws(() => mapRoomBuildingScope(mapInput(), mapping([scope('CASHBOOK', I.scope, I.book)])), code('forbidden'));
  assert.deepEqual(mapRoomBuildingScope(mapInput([I.scope, I.otherScope]), mapping([
    scope('CASHBOOK', I.otherScope, I.book), scope(),
  ])), [I.a]);
});
test('missing/truncated/ambiguous/foreign scope nodes and cross-org or unselected edges fail closed', () => {
  const mutations = [value => { value.complete = false; }, value => { delete value.complete; }, value => { value.organizationId = I.foreign; },
    value => { value.scopes = []; }, value => { value.scopes[0].id = I.otherScope; }, value => { value.scopes[0].buildingId = null; },
    value => { value.scopes[0].areaId = I.area; }, value => { value.scopes[0].scopeType = 'NAME'; },
    value => { value.scopes[0].buildingId = '*'; }, value => { value.scopes[0].buildingId = -1; },
    value => { value.scopes[0].label = 'Cùng tên'; }, value => { value.areaBuildings = [edge()]; }];
  for (const mutate of mutations) { const value = mapping(); mutate(value); assert.throws(() => mapRoomBuildingScope(mapInput(), value), code('backend_unavailable')); }
  for (const edges of [[{ ...edge(), organizationId: I.foreign }], [edge(I.foreign)], [edge(I.a, I.foreign)], [edge(), edge()], Array(4096).fill(edge())]) {
    assert.throws(() => mapRoomBuildingScope(mapInput(), mapping([scope('AREA', I.scope, I.area)], edges)), code('backend_unavailable'));
  }
  assert.throws(() => mapRoomBuildingScope(mapInput([I.scope, I.otherScope]), mapping([scope(), scope('BUILDING', I.otherScope)])), code('backend_unavailable'));
  for (const scopeIds of [[], [I.scope, I.scope], ['Cùng tên'], new Array(1), Array(257).fill(I.scope)]) {
    assert.throws(() => mapRoomBuildingScope(mapInput(scopeIds), mapping()), error => error instanceof BrokerError);
  }
});
test('real authority and crypto with fake backend return only the existing room projection after final recheck', async () => {
  const f = fixture(); const out = await f.create().availableRooms(opaque, {}, f.options);
  assert.deepEqual(out.rooms.map(r => r.building.id), [I.a]); assert.equal(out.currency, 'VND');
  assert(!JSON.stringify(out).includes('PRIVATE')); assert(!JSON.stringify(out).includes(jwt()));
  assert.equal(f.events.filter(e => e === 'map').length, 2); assert.equal(f.events.filter(e => e === 'rooms').length, 1);
  assert.equal(f.events.at(-1), 'map'); // Coherent bound decision follows final Auth/store rechecks.
  assert.equal(getEventListeners(f.controller.signal, 'abort').length, 0); f.crypto.destroy();
});

test('neutral policy read binds version zero through both room scope checks and rejects stale explicit proof', async t => {
  const f = fixture(); t.after(() => f.crypto.destroy()); f.joined.policy.version = 0;
  const versions = [];
  f.reads.scopeMap = async input => { versions.push(input.expectedPolicyVersion); return { ...proof(), binding: { ...proof().binding, policyVersion: 0 } }; };
  assert.deepEqual((await f.create().availableRooms(opaque, {}, f.options)).rooms.map(r => r.building.id), [I.a]);
  assert.deepEqual(versions, [0, 0]);
  f.reads.scopeMap = async () => proof();
  await assert.rejects(f.create().availableRooms(opaque, {}, f.options), code('context_changed'));
});
test('caller cannot supply org, JWT, resource scopes, RPC, wildcard or arbitrary endpoint', async () => {
  const f = fixture();
  for (const args of [{ organizationId: I.foreign }, { accessToken: jwt() }, { allowedBuildingIds: [I.foreign] },
    { scopeIds: [I.scope] }, { rpc: 'read_private' }, { url: 'https://foreign.invalid' }, { limit: 101 }, { offset: -1 }]) {
    await assert.rejects(f.create().availableRooms(opaque, args, f.options), code('invalid_request'));
  }
  await assert.rejects(f.create().availableRooms(jwt(), {}, f.options), code('unauthorized'));
  assert.equal(f.events.length, 0); f.crypto.destroy();
});
test('no rooms.view grant, empty assistant scopes or another permission namespace never reaches business reads', async () => {
  for (const mutate of [f => { f.authz.permissions.read = ['assistant.context.read']; },
    f => { f.joined.connection.scopeIds = []; }, f => { f.joined.policy.scopeIds = []; },
    f => { f.authz.scopesByPermission['rooms.view'].buildingIds = []; f.authz.scopesByPermission['assistant.context.read'].buildingIds = [I.a]; },
    f => { f.joined.policy.read = ['assistant.context.read']; }, f => { f.joined.connection.restrictions.read = ['assistant.context.read']; }]) {
    const f = fixture(); mutate(f); await assert.rejects(f.create().availableRooms(opaque, {}, f.options), code('forbidden'));
    assert(!f.events.includes('map')); assert(!f.events.includes('rooms')); f.crypto.destroy();
  }
});
test('assistant AREA intersections filter equal-name buildings and mapping changes during read discard the result', async () => {
  const f = fixture(); let calls = 0;
  f.reads.scopeMap = async () => { calls++; return proof(mapping([scope('AREA', I.scope, I.area)], [edge(calls === 1 ? I.a : I.b)])); };
  await assert.rejects(f.create().availableRooms(opaque, { buildingName: 'Cùng tên' }, f.options), code('context_changed'));
  assert.equal(calls, 2); assert.equal(f.events.filter(e => e === 'rooms').length, 1); f.crypto.destroy();
});
test('revocation or permission reduction while reading is detected by actual final authority, never returned as successful data', async () => {
  for (const mutate of [f => { f.joined.connection.epoch++; }, f => { f.authz.permissions.read = ['assistant.context.read']; },
    f => { f.authz.membership.revokedAt = NOW; }, f => { f.joined.policy.version++; }]) {
    const f = fixture(); const original = f.reads.availableRooms;
    f.reads.availableRooms = async input => { const result = await original(input); mutate(f); return result; };
    await assert.rejects(f.create().availableRooms(opaque, {}, f.options), error => error instanceof BrokerError && ['context_changed', 'forbidden'].includes(error.code));
    f.crypto.destroy();
  }
});
test('foreign/dead joined credentials and a mismatched verified provider session are refused before RPC use', async () => {
  for (const mutate of [value => { value.connection.tokenDigest = 'b'.repeat(64); }, value => { value.session.binding.userId = I.foreign; },
    value => { value.connection.id = I.foreign; }, value => { value.session.expiresAt = NOW; }, value => { value.session.binding.sessionId = I.foreign; }]) {
    const f = fixture(); const original = f.connectionStore.readConnection; let calls = 0;
    f.connectionStore.readConnection = async input => { const result = await original(input); if (++calls === 3) mutate(result); return result; };
    await assert.rejects(f.create().availableRooms(opaque, {}, f.options), error => error instanceof BrokerError);
    assert(!f.events.includes('map')); f.crypto.destroy();
  }
  const f = fixture(); const original = f.auth.verifySession; let calls = 0;
  f.auth.verifySession = async input => ({ ...await original(input), ...( ++calls === 2 ? { sessionId: I.foreign } : {}) });
  await assert.rejects(f.create().availableRooms(opaque, {}, f.options), code('unauthorized'));
  assert(!f.events.includes('map')); f.crypto.destroy();
});
test('final authority must return void and payload failures cannot bypass that fence', async () => {
  const f = fixture(); const authority = { ...f.authority, async checkUnchanged() { return { ok: true }; } };
  await assert.rejects(f.create({ authority }).availableRooms(opaque, {}, f.options), code('context_changed'));
  f.reads.availableRooms = async () => ({ error: 'PRIVATE_BACKEND_FAILURE' });
  await assert.rejects(f.create().availableRooms(opaque, {}, f.options), code('backend_unavailable')); f.crypto.destroy();
});
test('expiry, cancellation and deadline never release late data or continue to a subsequent dependency', async () => {
  for (const cause of ['expiry', 'cancel', 'deadline']) {
    const f = fixture(), started = deferred(), wait = deferred();
    f.reads.availableRooms = async () => { started.resolve(); await wait.promise; return payload(); };
    const pending = f.create({ timeoutMs: cause === 'deadline' ? 10 : 1000 }).availableRooms(opaque, {}, f.options);
    const rejection = assert.rejects(pending, code(cause === 'expiry' ? 'unauthorized' : 'timeout'));
    await started.promise;
    if (cause === 'expiry') { f.time(NOW + 600_000); wait.resolve(); }
    if (cause === 'cancel') f.controller.abort();
    await rejection; wait.resolve(); await tick();
    assert.equal(f.events.filter(e => e === 'map').length, 1); assert.equal(getEventListeners(f.controller.signal, 'abort').length, 0); f.crypto.destroy();
  }
});
test('caller filter mutation and scope reply ordering cannot widen the room result', async () => {
  const f = fixture(), source = { buildingName: 'missing', limit: 1 }, original = f.reads.availableRooms;
  f.reads.availableRooms = async input => { source.buildingName = ''; source.limit = 100; return original(input); };
  const result = await f.create().availableRooms(opaque, source, f.options); assert.equal(result.rooms.length, 0); f.crypto.destroy();
});

test('AREA changes during final authority await are rejected by the LAST bound scope decision', async () => {
  const f = fixture(); let selected = I.a;
  f.reads.scopeMap = async () => { f.events.push('map'); return proof(mapping([scope('AREA', I.scope, I.area)], [edge(selected)])); };
  const authority = { ...f.authority, async checkUnchanged(...args) {
    await f.authority.checkUnchanged(...args); selected = I.b;
  } };
  await assert.rejects(f.create({ authority }).availableRooms(opaque, {}, f.options), code('context_changed'));
  assert.equal(f.events.at(-1), 'map'); f.crypto.destroy();
});

test('final map must bind the current connection/policy/member/session and live CRM building set, not an unbound old map', async () => {
  const mutations = [value => { value.binding.connectionId = I.foreign; }, value => { value.binding.epoch++; },
    value => { value.binding.policyVersion++; }, value => { value.binding.membershipId = I.foreign; },
    value => { value.binding.authorizationVersion++; }, value => { value.binding.sessionRevision++; },
    value => { value.permissionBuildingIds = [I.b]; }, value => { value.permissionBuildingIds.push(I.foreign); }];
  for (const mutate of mutations) {
    const f = fixture(); let calls = 0;
    f.reads.scopeMap = async () => { calls++; const value = proof(); if (calls === 2) mutate(value); return value; };
    await assert.rejects(f.create().availableRooms(opaque, {}, f.options), code('context_changed'));
    assert.equal(calls, 2); f.crypto.destroy();
  }
  for (const outcome of ['forbidden', 'context_changed']) {
    const f = fixture(); let calls = 0;
    f.reads.scopeMap = async () => { if (++calls === 2) throw new BrokerError(outcome); return proof(); };
    await assert.rejects(f.create().availableRooms(opaque, {}, f.options), code(outcome)); f.crypto.destroy();
  }
  const f = fixture(); f.reads.scopeMap = async () => mapping();
  await assert.rejects(f.create().availableRooms(opaque, {}, f.options), code('backend_unavailable'));
  assert(!f.events.includes('rooms')); f.crypto.destroy();
});

test('two-phase seam exposes no data before audit, consumes its branded receipt once and rejects foreign/expired/replayed receipts', async () => {
  const f = fixture(), service = f.create({ timeoutMs: 1000 });
  const prepared = await service.prepareAvailableRooms(opaque, {}, f.options);
  assert.equal(JSON.stringify(prepared), '{}'); assert(Object.isFrozen(prepared));
  await assert.rejects(service.finalizeAvailableRooms(opaque, {}, f.options), code('context_changed'));
  // A trusted broker can await its audit here; a state change there must still
  // be caught by the actual authority + bound decision during finalization.
  f.joined.policy.version++;
  await assert.rejects(service.finalizeAvailableRooms(opaque, prepared, f.options), code('context_changed'));
  await assert.rejects(service.finalizeAvailableRooms(opaque, prepared, f.options), code('context_changed'));
  f.joined.policy.version--;
  const another = await service.prepareAvailableRooms(opaque, {}, f.options);
  await assert.rejects(service.finalizeAvailableRooms('hc_' + 'B'.repeat(43), another, f.options), code('context_changed'));
  const expired = await service.prepareAvailableRooms(opaque, {}, f.options); f.time(NOW + 1000);
  await assert.rejects(service.finalizeAvailableRooms(opaque, expired, f.options), code('timeout'));
  f.crypto.destroy();
});

const origin = 'https://fixture.supabase.co', publishableKey = 'sb_publishable_fixture';
test('HTTP adapter pins exactly two read RPCs, actual authenticated JWT and selected-org/scope arguments', async () => {
  const calls = [], f = new AbortController();
  const reads = createSupabaseRoomReads({ url: origin, publishableKey, fetch: async (url, options) => { calls.push({ url, ...options }); return Response.json(mapping()); } });
  await reads.scopeMap({ accessToken: jwt(), organizationId: I.org, scopeIds: [I.scope], ...boundInput() }, { signal: f.signal });
  await reads.availableRooms({ accessToken: jwt(), organizationId: I.org }, { signal: f.signal });
  assert.deepEqual(calls.map(c => c.url), [origin + '/rest/v1/rpc/hermes_room_scope_map_v1', origin + '/rest/v1/rpc/hermes_sale_listing_rooms_v1']);
  assert.deepEqual(calls.map(c => JSON.parse(c.body)), [{ p_organization_id: I.org, p_scope_ids: [I.scope],
    p_connection_id: I.connection, p_token_digest: digest, p_expected_epoch: 1, p_expected_policy_version: 1,
    p_expected_membership_id: I.membership, p_expected_authorization_version: 1, p_expected_session_revision: 1 }, { p_organization_id: I.org }]);
  for (const call of calls) { assert.equal(call.method, 'POST'); assert.equal(call.redirect, 'error'); assert.equal(call.headers.authorization, `Bearer ${jwt()}`);
    assert.equal(call.headers.apikey, publishableKey); assert.equal(call.headers['content-profile'], 'public'); assert.equal(call.headers['accept-profile'], 'public'); }
});
test('HTTP adapter rejects privileged tokens, arbitrary RPC and endpoint input before any network request', async () => {
  let calls = 0; const reads = createSupabaseRoomReads({ url: origin, publishableKey, fetch: async () => { calls++; return Response.json({}); } });
  const options = { signal: new AbortController().signal };
  for (const accessToken of [jwt('service_role'), jwt('anon'), 'sb_secret_private', 'not.a.jwt']) {
    await assert.rejects(reads.availableRooms({ accessToken, organizationId: I.org }, options), code('invalid_request'));
  }
  await assert.rejects(reads.availableRooms({ accessToken: jwt(), organizationId: I.org, rpc: 'other' }, options), code('invalid_request'));
  await assert.rejects(reads.scopeMap({ accessToken: jwt(), organizationId: I.org, scopeIds: [], ...boundInput() }, options), code('invalid_request'));
  await assert.rejects(reads.scopeMap({ accessToken: jwt(), organizationId: I.org, scopeIds: [I.scope] }, options), code('invalid_request'));
  for (const delta of [{ tokenDigest: opaque }, { expectedEpoch: 0 }, { expectedPolicyVersion: null },
    { expectedMembershipId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }, { expectedAuthorizationVersion: -1 }, { expectedSessionRevision: '1' }]) {
    await assert.rejects(reads.scopeMap({ accessToken: jwt(), organizationId: I.org, scopeIds: [I.scope], ...boundInput(), ...delta }, options), code('invalid_request'));
  }
  for (const url of ['http://fixture.supabase.co', origin + '/other', 'https://user:password@fixture.supabase.co', origin + '?x=y']) {
    assert.throws(() => createSupabaseRoomReads({ url, publishableKey }));
  }
  assert.throws(() => createSupabaseRoomReads({ url: origin, publishableKey: 'sb_secret_private' })); assert.equal(calls, 0);
});
test('HTTP reads fail safely on missing future RPC, denial, malformed/capped replies and never retry or fall back to admin catalog', async () => {
  for (const [reply, expected] of [[() => Response.json({ code: 'PGRST202', message: 'PRIVATE' }, { status: 404 }), 'backend_unavailable'],
    [() => Response.json({ message: 'PRIVATE' }, { status: 401 }), 'unauthorized'], [() => Response.json({ code: '42501' }, { status: 400 }), 'forbidden'],
    [() => Response.json({ code: 'PT409', message: 'PRIVATE' }, { status: 409 }), 'context_changed'],
    [() => Response.json({ code: '40001', message: 'PRIVATE' }, { status: 500 }), 'backend_unavailable'],
    [() => Response.json({ code: '23505', message: 'PRIVATE' }, { status: 409 }), 'backend_unavailable'],
    [() => Response.json({ code: 'PT409', message: 'PRIVATE' }, { status: 500 }), 'backend_unavailable'],
    [() => Response.json({ error: 'PRIVATE' }), 'backend_unavailable'], [() => new Response('not JSON', { headers: { 'content-type': 'application/json' } }), 'backend_unavailable'],
    [() => Response.json({ oversized: 'x'.repeat(1000) }), 'response_too_large']]) {
    let calls = 0; const reads = createSupabaseRoomReads({ url: origin, publishableKey, maxResponseBytes: 512,
      fetch: async () => { calls++; return reply(); } });
    await assert.rejects(reads.scopeMap({ accessToken: jwt(), organizationId: I.org, scopeIds: [I.scope], ...boundInput() }, { signal: new AbortController().signal }), code(expected));
    assert.equal(calls, 1);
  }
});
test('HTTP deadline aborts a hanging body, cleans listeners and ignores late responses', async () => {
  const controller = new AbortController(), wait = deferred(); let received, calls = 0;
  const reads = createSupabaseRoomReads({ url: origin, publishableKey, timeoutMs: 10,
    fetch: async (_url, { signal }) => { calls++; received = signal; return wait.promise; } });
  await assert.rejects(reads.availableRooms({ accessToken: jwt(), organizationId: I.org }, { signal: controller.signal }), code('timeout'));
  wait.resolve(Response.json(payload())); await tick(); assert.equal(calls, 1); assert(received.aborted);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
