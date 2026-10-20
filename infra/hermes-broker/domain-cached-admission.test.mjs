import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { BrokerError } from './broker.mjs';
import { BOUND_USER_ADMISSIONS, createBoundUserOperationService } from './bound-user-operation.mjs';
import { createReadCatalogAuthority } from './read-catalog-authority.mjs';
import { createDomainMount } from './domain-mount.mjs';
import { createSessionCrypto } from './session-crypto.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
import { ALL_DOMAIN_READ_CAPABILITIES, CACHED_READ_OPERATIONS, DOMAIN_FAMILIES, DOMAIN_READS, FAST_READ_OPERATIONS } from './domain-contract.mjs';
import { W2 } from './wave2-registry.mjs';

// B2-2 (20/10/2026): the cached admission of the domain reads outside the fast plan. No PostgreSQL here:
// the SQL statements themselves are proven in domain-composition/domain-v2/domain-v3 (PGlite); this file
// proves the broker-side contract — which domains, which binding, which calls are gone, which remain.
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [CONNECTION, ASSISTANT, USER, ORG, SESSION, CREDENTIAL, MEMBER, SCOPE, BUILDING] = Array.from({ length: 9 }, (_, n) => id(n + 1));
const NOW = 1_800_000_000_000, EXPIRES_AT = NOW + 3_600_000;
const TOKEN = 'hc_' + 'A'.repeat(43), DIGEST = createHash('sha256').update(TOKEN).digest('hex');
const SEVEN = ['connectionId', 'tokenDigest', 'expectedEpoch', 'expectedPolicyVersion', 'expectedMembershipId', 'expectedAuthorizationVersion', 'expectedSessionRevision'];
const FOUR = ['connectionId', 'tokenDigest', 'expectedEpoch', 'expectedSessionRevision'];
const code = expected => error => error instanceof BrokerError && error.code === expected;
const sorted = values => [...values].sort();
// Bearer in the shape the bound-user RPC transport accepts (role, sub, session_id); a fixture, never a credential.
const bearer = ['header', Buffer.from(JSON.stringify({ role: 'authenticated', sub: USER, session_id: SESSION, exp: EXPIRES_AT / 1000 })).toString('base64url'), 'signature'].join('.');
const DOMAIN_KEYS = [...new Set(Object.values(DOMAIN_READS).flatMap(definition => definition.family === 'w2' ? [...W2.permissions] : [definition.permission]))];
// What the read catalog authority can grant (base Auth + the three capability families) versus the full chain.
const READ_GRANTS = DOMAIN_KEYS.filter(key => key !== 'chat_zalo.view'), FULL_GRANTS = [...DOMAIN_KEYS];

function fixture(t) {
  const clock = { now: NOW }, counts = { verify: 0 };
  const crypto = createSessionCrypto({ activeKeyVersion: 'fixture', keys: new Map([['fixture', randomBytes(32)]]) }); t.after(() => crypto.destroy());
  const owner = { assistantId: ASSISTANT, userId: USER, organizationId: ORG, sessionId: SESSION };
  const snapshot = { status: 'active',
    connection: { id: CONNECTION, assistantId: ASSISTANT, organizationId: ORG, userId: USER, state: 'active', epoch: 2, restrictions: { read: [...FULL_GRANTS], action: [] },
      scopeIds: [SCOPE], tokenDigest: DIGEST, credentialRef: CREDENTIAL, expiresAt: NOW + 600_000 },
    session: { credentialRef: CREDENTIAL, revision: 1, envelope: crypto.seal({ accessToken: bearer, refreshToken: 'SYNTHETIC_REFRESH', expiresAt: EXPIRES_AT }, owner),
      expiresAt: EXPIRES_AT, binding: owner },
    membership: { membershipId: MEMBER, authorizationVersion: 1, isSuperadmin: false }, policy: { version: 1, read: [...FULL_GRANTS], action: [], scopeIds: [SCOPE] } };
  const connectionStore = { async readConnection({ tokenDigest }) { return tokenDigest === DIGEST ? structuredClone(snapshot) : null; } };
  const auth = { async verifySession() { counts.verify++; return { userId: USER, sessionId: SESSION, expiresAt: EXPIRES_AT }; },
    async readAuthorization() { throw new Error('fixture: never consulted'); } };
  // A stub authority with its own tally. Its identity row is fixed at construction, exactly like a cache entry.
  const stub = grants => {
    const tally = { resolve: 0, check: 0 }, branded = new WeakSet();
    const identity = { row: { id: CONNECTION, assistantId: ASSISTANT, userId: USER, organizationId: ORG, state: 'active', epoch: snapshot.connection.epoch,
      expiresAt: snapshot.connection.expiresAt, restrictions: { read: [...grants], action: [] } }, effective: { read: [...grants], action: [] },
    policyEpoch: '1'.repeat(64), isSuperadmin: false, assistantScopeIds: [SCOPE],
    scopesByPermission: Object.fromEntries(grants.map(key => [key, { buildingIds: [BUILDING], cashbookIds: [] }])), contextVersion: '2'.repeat(64) };
    return { tally, async identifyConnection() { return { connectionId: CONNECTION }; },
      async resolve() { tally.resolve++; const value = structuredClone(identity); branded.add(value); return value; },
      async checkUnchanged(_token, before) { tally.check++; if (!branded.has(before)) throw new BrokerError('context_changed'); } };
  };
  return { clock, crypto, snapshot, connectionStore, auth, counts, stub, signal: new AbortController().signal };
}

test('contract: the cached lane is every catalogued read outside the fast plan whose key the read catalog can grant; zalo_conversations stays on the full authority', () => {
  assert.deepEqual([...BOUND_USER_ADMISSIONS], ['full', 'initialRead', 'cachedBinding']);
  assert.deepEqual(sorted([...FAST_READ_OPERATIONS, ...CACHED_READ_OPERATIONS, 'zalo_conversations']), sorted(Object.keys(DOMAIN_READS)));
  assert.equal(CACHED_READ_OPERATIONS.some(operation => FAST_READ_OPERATIONS.includes(operation)), false);
  assert.equal(DOMAIN_READS.zalo_conversations.permission, 'chat_zalo.view');
  assert.equal(ALL_DOMAIN_READ_CAPABILITIES.includes('chat_zalo.view'), false, 'granted by the group adapter, outside the read catalog authority');
  const grantable = new Set(['assistant.context.read', 'rooms.view', ...ALL_DOMAIN_READ_CAPABILITIES]);
  for (const operation of CACHED_READ_OPERATIONS) {
    const definition = DOMAIN_READS[operation];
    assert.ok(['v1', 'v2', 'v3', 'w2'].includes(definition.family), operation);
    for (const key of definition.family === 'w2' ? W2.permissions : [definition.permission]) assert.ok(grantable.has(key), `${operation}: ${key}`);
  }
  assert.ok(Object.isFrozen(CACHED_READ_OPERATIONS) && CACHED_READ_OPERATIONS.length === Object.keys(DOMAIN_READS).length - FAST_READ_OPERATIONS.length - 1);
});

test('cachedBinding service: seven-key binding from the LIVE snapshot while the identity stays cached; no verifySession, no checkUnchanged; every other fence intact', async t => {
  const f = fixture(t), executed = [];
  const reads = { async execute(operation, value) { executed.push({ operation, ...structuredClone(value) }); return { operation, ok: true }; } };
  const service = (authority, options = {}) => createBoundUserOperationService({ authority, connectionStore: f.connectionStore, crypto: f.crypto, auth: f.auth, reads,
    mayUse: (effective, operation) => operation === 'leads' && effective.read.includes('leads.view'),
    validateInput: (operation, input) => { if (!['leads', 'other'].includes(operation)) throw new TypeError('invalid'); return { ...input }; },
    validateResult: (_operation, result) => result, clock: () => f.clock.now, ...options });
  const run = async (svc, operation = 'leads') => { const receipt = await svc.prepare(TOKEN, operation, { query: '' }, { signal: f.signal }); return svc.finalize(TOKEN, receipt, { signal: f.signal }); };
  const catalog = f.stub(READ_GRANTS), cached = service(catalog, { admission: 'cachedBinding' });
  assert.deepEqual(await run(cached), { operation: 'leads', ok: true });
  assert.deepEqual(Object.keys(executed[0].binding), SEVEN);
  assert.deepEqual(executed[0].binding, { connectionId: CONNECTION, tokenDigest: DIGEST, expectedEpoch: 2, expectedPolicyVersion: 1,
    expectedMembershipId: MEMBER, expectedAuthorizationVersion: 1, expectedSessionRevision: 1 });
  assert.equal(executed[0].accessToken, bearer);
  // The persisted snapshot moves on (session refresh, policy, membership) while the stub identity stays the same, as a cache hit would.
  f.snapshot.session.revision = 2; f.snapshot.policy.version = 3; f.snapshot.membership.authorizationVersion = 4;
  await run(cached);
  assert.deepEqual(executed[1].binding, { ...executed[0].binding, expectedSessionRevision: 2, expectedPolicyVersion: 3, expectedAuthorizationVersion: 4 });
  assert.deepEqual([f.counts.verify, catalog.tally.check, catalog.tally.resolve], [0, 0, 2], 'no provider verification, no second build; one resolve per prepare');
  // Default mode on the same fixture: one verifySession per prepare, one checkUnchanged per finalize, the same seven keys.
  const full = f.stub(FULL_GRANTS);
  await run(service(full));
  assert.deepEqual([f.counts.verify, full.tally.check, full.tally.resolve], [1, 1, 1]);
  assert.deepEqual(Object.keys(executed[2].binding), SEVEN);
  // The fixed private plan keeps its four keys through either spelling of the option.
  await run(service(f.stub(READ_GRANTS), { initialReadAdmission: true })); await run(service(f.stub(READ_GRANTS), { admission: 'initialRead' }));
  assert.deepEqual([Object.keys(executed[3].binding), Object.keys(executed[4].binding)], [FOUR, FOUR]);
  assert.equal(f.counts.verify, 1);
  for (const options of [{ admission: 'cached' }, { admission: null }, { initialReadAdmission: true, admission: 'full' },
    { initialReadAdmission: true, admission: 'cachedBinding' }, { initialReadAdmission: 'yes' }])
    assert.throws(() => service(catalog, options), /invalid_bound_user_operation_service/, JSON.stringify(options));
  // Every other fence of the service is unchanged on the cached lane.
  await assert.rejects(run(cached, 'other'), code('forbidden'));
  await assert.rejects(run(cached, 'nope'), code('invalid_request'));
  const receipt = await cached.prepare(TOKEN, 'leads', {}, { signal: f.signal });
  await cached.finalize(TOKEN, receipt, { signal: f.signal });
  await assert.rejects(cached.finalize(TOKEN, receipt, { signal: f.signal }), code('context_changed'), 'a receipt is consumed once');
  await assert.rejects(cached.prepare('hc_' + 'B'.repeat(43), 'leads', {}, { signal: f.signal }), code('context_changed'), 'another token has no live row');
  f.snapshot.connection.epoch = 3;
  await assert.rejects(run(cached), code('context_changed'), 'the live row disagrees with the identity');
  f.snapshot.connection.epoch = 2; f.snapshot.session.expiresAt = EXPIRES_AT + 1;
  await assert.rejects(run(cached), code('unauthorized'), 'the envelope lifetime must match the stored session');
  f.snapshot.session.expiresAt = EXPIRES_AT; f.clock.now = EXPIRES_AT;
  await assert.rejects(run(cached), code('unauthorized'), 'expired credential');
  f.clock.now = NOW; f.snapshot.policy.version = -1;
  await assert.rejects(run(cached), code('backend_unavailable'), 'malformed policy version');
  f.snapshot.policy.version = 3;
  assert.deepEqual(await run(cached), { operation: 'leads', ok: true });
  assert.deepEqual([f.counts.verify, catalog.tally.check], [1, 0]);
});

test('domain mount under the host opt-in: fast plan, cached seven-key admission through the read catalog, full lane for zalo_conversations; SQL verdicts map; a changed snapshot re-resolves', async t => {
  const f = fixture(t), catalog = f.stub(READ_GRANTS), full = f.stub(FULL_GRANTS);
  const readAuthority = createReadCatalogAuthority({ authority: catalog, connectionStore: f.connectionStore, clock: () => f.clock.now });
  const dependencyScope = createDependencyScope(); t.after(() => dependencyScope.close());
  const calls = [], fetchedAt = new Date(NOW).toISOString(); let verdict = null;
  const fetch = async (url, options) => {
    const name = new URL(url).pathname.replace('/rest/v1/rpc/', ''), args = JSON.parse(options.body);
    calls.push({ name, domain: args.p_domain, binding: args.p_binding, bearer: options.headers.authorization });
    if (verdict) { const { status, sqlstate } = verdict; verdict = null; return Response.json({ code: sqlstate, message: 'fixture', details: null, hint: null }, { status }); }
    const definition = DOMAIN_READS[args.p_domain], family = definition.family;
    const envelope = { organizationId: ORG, domain: args.p_domain, items: [], nextCursor: null,
      ...(family === 'v2' ? { source: definition.source, fetchedAt } : {}), ...(family === 'v3' ? { fetchedAt } : {}) };
    if (name === 'hermes_domain_read_fast_v1') return Response.json({ authority: { organizationId: ORG, userId: USER, connectionId: CONNECTION,
      permission: definition.permission, buildingIds: [BUILDING], cashbookIds: [] }, result: envelope });
    if (family === 'w2') return Response.json({ organizationId: ORG, domain: args.p_domain, fetchedAt, items: [] });
    if (args.p_domain === 'zalo_conversations') return Response.json({ organizationId: ORG, domain: args.p_domain, fetchedAt, report: 'list', source: 'crm.zalo_conversations',
      unavailable: 'organization_scope_required', summary: null, items: [], offset: 0, nextOffset: null, sourceCapped: false });
    return Response.json(envelope);
  };
  const supabase = { url: 'https://example.invalid/', publishableKey: 'sb_publishable_test' };
  const shared = { connectionStore: f.connectionStore, crypto: f.crypto, auth: f.auth, supabase, dependencyScope, fetch, clock: () => f.clock.now };
  const plain = createDomainMount({ authority: full, ...shared }).createService();
  assert.deepEqual(Object.keys(plain), ['prepareDomain', 'finalizeDomain'], 'without the opt-in nothing is advertised');
  const domains = createDomainMount({ authority: full, ...shared, readAuthority }).createService();
  assert.deepEqual(Object.keys(domains), ['readAuthority', 'fastReadOperations', 'cachedReadOperations', 'prepareDomain', 'finalizeDomain']);
  assert.deepEqual([...domains.fastReadOperations], [...FAST_READ_OPERATIONS]); assert.deepEqual([...domains.cachedReadOperations], [...CACHED_READ_OPERATIONS]);
  const options = { signal: f.signal };
  const run = async (operation, input = {}) => { const receipt = await domains.prepareDomain(TOKEN, operation, input, options); return domains.finalizeDomain(TOKEN, receipt, options); };
  const live = () => ({ connectionId: CONNECTION, tokenDigest: DIGEST, expectedEpoch: f.snapshot.connection.epoch, expectedPolicyVersion: f.snapshot.policy.version,
    expectedMembershipId: MEMBER, expectedAuthorizationVersion: f.snapshot.membership.authorizationVersion, expectedSessionRevision: f.snapshot.session.revision });
  // One reviewed RPC per family, the seven live keys, the decrypted bearer; the catalog resolves once for all of them.
  for (const operation of ['leads', 'income_expenses', 'occupancy', 'report_list']) {
    assert.equal((await run(operation)).domain, operation);
    const last = calls.at(-1);
    assert.equal(last.name, DOMAIN_FAMILIES[DOMAIN_READS[operation].family].readRpc, operation);
    assert.deepEqual(last.binding, live(), operation); assert.equal(last.bearer, `Bearer ${bearer}`);
  }
  assert.deepEqual([f.counts.verify, catalog.tally.check, catalog.tally.resolve, full.tally.resolve], [0, 0, 1, 0]);
  // The fast plan is untouched (four keys), still without verification.
  await run('customers');
  assert.equal(calls.at(-1).name, 'hermes_domain_read_fast_v1'); assert.deepEqual(Object.keys(calls.at(-1).binding), FOUR);
  // zalo_conversations: its key is granted outside the read catalog, so it keeps the full lane (verifySession, checkUnchanged, full authority).
  const zalo = await run('zalo_conversations');
  assert.equal(zalo.unavailable, 'organization_scope_required'); assert.equal(calls.at(-1).name, 'hermes_domain_read_v3'); assert.deepEqual(calls.at(-1).binding, live());
  assert.deepEqual([f.counts.verify, full.tally.resolve, full.tally.check, catalog.tally.resolve], [1, 1, 1, 1]);
  // SQL verdicts reach the caller unchanged on the cached lane, and the statement was actually asked (no broker-side verdict before it).
  for (const [status, sqlstate, expected] of [[409, 'PT409', 'context_changed'], [403, '42501', 'forbidden'], [404, 'PGRST202', 'backend_unavailable'], [401, 'PGRST301', 'unauthorized']]) {
    verdict = { status, sqlstate }; const count = calls.length;
    await assert.rejects(run('leads'), code(expected), sqlstate); assert.equal(calls.length, count + 1, sqlstate);
  }
  assert.equal(catalog.tally.resolve, 1, 'verdicts alone do not evict the cached identity');
  // Any change of the persisted snapshot misses the catalog: the next read resolves again and binds the new values.
  for (const change of [() => { f.snapshot.session.revision = 2; }, () => { f.snapshot.membership.authorizationVersion = 2; },
    () => { f.snapshot.policy.version = 2; }, () => { f.clock.now += 300_000; }]) {
    const resolves = catalog.tally.resolve; change(); await run('leads');
    assert.equal(catalog.tally.resolve, resolves + 1); assert.deepEqual(calls.at(-1).binding, live());
  }
  assert.deepEqual([f.counts.verify, catalog.tally.check], [1, 0], 'still only the zalo_conversations verification');
});
