import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDurableAuthority } from './durable-authority.mjs';
import { createReadCatalogAuthority } from './read-catalog-authority.mjs';
import { createSessionCrypto } from './session-crypto.mjs';
import { domainFastResult } from './domain-read-fast.mjs';
import { domainInput } from './domain-contract.mjs';
import { readFile } from 'node:fs/promises';

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [connection, assistant, user, org, session, credential, member, scope, building, other] = Array.from({ length: 10 }, (_, n) => id(n + 1));
const token = `hc_${Buffer.alloc(32, 3).toString('base64url')}`, digest = createHash('sha256').update(token).digest('hex');
const NOW = 1800000000000;
function fixture(t, options = {}) {
  const clock = { now: NOW }, counts = { auth: 0, capabilities: 0 };
  const crypto = createSessionCrypto({ activeKeyVersion: 'fixture', keys: new Map([['fixture', Buffer.alloc(32, 1)]]) });
  t.after(() => crypto.destroy());
  const binding = { assistantId: assistant, userId: user, organizationId: org, sessionId: session };
  const material = { accessToken: 'PRIVATE_ACCESS', refreshToken: 'PRIVATE_REFRESH', expiresAt: NOW + 3600000 };
  const grants = { read: ['customers.view'], action: [] };
  const snapshot = { status: 'active', connection: { id: connection, assistantId: assistant, organizationId: org, userId: user,
    state: 'active', epoch: 2, restrictions: structuredClone(grants), scopeIds: [scope], tokenDigest: digest, credentialRef: credential, expiresAt: NOW + 600000 },
  session: { credentialRef: credential, revision: 1, envelope: crypto.seal(material, binding), expiresAt: material.expiresAt, binding },
  membership: { membershipId: member, authorizationVersion: 1, isSuperadmin: false }, policy: { version: 1, ...structuredClone(grants), scopeIds: [scope] } };
  const auth = { async verifySession() { counts.auth++; return { userId: user, sessionId: session, expiresAt: material.expiresAt }; },
    async readAuthorization() { counts.capabilities++; return { userId: user, isSuperadmin: false, activeOrganizationIds: [org], epoch: 'crm-1',
      membership: { organizationId: org, status: 'ACTIVE', revokedAt: null, validFrom: null, validTo: null,
        membershipId: member, authorizationVersion: snapshot.membership.authorizationVersion }, permissions: grants, companyCeilings: grants,
      scopesByPermission: { 'customers.view': { buildingIds: [building], cashbookIds: [] } } }; } };
  const store = { async readConnection({ tokenDigest }) { return tokenDigest === digest ? structuredClone(snapshot) : null; } };
  const authority = createDurableAuthority({ connectionStore: store, crypto, auth, clock: () => clock.now });
  const { factory = createReadCatalogAuthority, ...configuration } = options;
  const cache = factory({ authority, connectionStore: store, clock: () => clock.now, ...configuration });
  const signal = new AbortController().signal;
  return { snapshot, clock, counts, cache, resolve: () => cache.resolve(token, { signal }), signal };
}

test('read catalog is bounded to five minutes and still reads token/session/settings on every lookup', async t => {
  const f = fixture(t), first = await f.resolve();
  for (let i = 0; i < 5; i++) assert.equal(await f.resolve(), first);
  assert.deepEqual(f.counts, { auth: 1, capabilities: 1 });
  for (const change of [() => { f.snapshot.connection.epoch++; }, () => { f.snapshot.session.revision++; },
    () => { f.snapshot.policy.version++; }, () => { f.snapshot.membership.authorizationVersion++; },
    () => { f.snapshot.connection.restrictions.read.push('registry.new'); }]) {
    const before = f.counts.auth; change(); await f.resolve(); assert.equal(f.counts.auth, before + 1);
  }
  const before = f.counts.auth; f.clock.now += 300000; await f.resolve(); assert.equal(f.counts.auth, before + 1);
  f.snapshot.connection.expiresAt = f.clock.now;
  await assert.rejects(f.resolve(), { code: 'unauthorized' });
  assert.throws(() => fixture(t, { ttlMs: 300001 }), /invalid_read_catalog_authority/);
});

test('cached authority cannot cross tokens, actors, organizations, provider sessions or survive revocation/expiry', async t => {
  for (const change of [f => { f.snapshot.connection.userId = other; }, f => { f.snapshot.connection.organizationId = other; },
    f => { f.snapshot.session.binding.sessionId = other; }, f => { f.snapshot.connection.state = 'revoked'; },
    f => { f.snapshot.session.expiresAt = NOW; }, f => { f.snapshot.connection.tokenDigest = 'f'.repeat(64); }]) {
    const f = fixture(t); await f.resolve(); change(f); await assert.rejects(f.resolve());
  }
  const f = fixture(t); await f.resolve();
  await assert.rejects(f.cache.resolve(`hc_${Buffer.alloc(32, 4).toString('base64url')}`, { signal: f.signal }), { code: 'unauthorized' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.cache.resolve(token, { signal: controller.signal }), { code: 'timeout' });
});

test('business-statement output authority replaces stale discovery scope and validates exact actor/org/permission', () => {
  const identity = { row: { id: connection, userId: user, organizationId: org }, scopesByPermission: { 'customers.view': { buildingIds: [building], cashbookIds: [] } } };
  const envelope = { authority: { organizationId: org, userId: user, connectionId: connection, permission: 'customers.view', buildingIds: [other], cashbookIds: [] },
    result: { organizationId: org, domain: 'customers', fetchedAt: new Date(NOW).toISOString(), nextCursor: null,
      items: [{ id: id(20), name: 'Fixture', phone: null, contractId: id(21), buildingId: other, buildingName: 'Toà B', roomId: id(22), roomName: 'A' }] } };
  assert.deepEqual(domainFastResult('customers', envelope, identity, domainInput('customers', {})), envelope.result);
  for (const change of [value => { value.authority.userId = other; }, value => { value.authority.organizationId = other; },
    value => { value.authority.connectionId = other; }, value => { value.authority.permission = 'contracts.view'; },
    value => { value.authority.buildingIds = [building]; }, value => { value.authority.cashbookIds = [building]; },
    value => { value.result.items[0].privateField = 'never'; }]) {
    const value = structuredClone(envelope); change(value); assert.throws(() => domainFastResult('customers', value, identity, domainInput('customers', {})));
  }
});

test('negative control: skipping the binding fingerprint makes the settings/session invalidation probe red', async t => {
  const probe = async factory => {
    const f = fixture(t, { factory }); await f.resolve(); const before = f.counts.auth;
    f.snapshot.session.revision++; await f.resolve(); assert.equal(f.counts.auth, before + 1);
  };
  await probe(createReadCatalogAuthority);
  const source = await readFile(new URL('./read-catalog-authority.mjs', import.meta.url), 'utf8');
  const changed = source.replace("'./broker.mjs'", JSON.stringify(new URL('./broker.mjs', import.meta.url).href))
    .replace("'./durable-connection-store.mjs'", JSON.stringify(new URL('./durable-connection-store.mjs', import.meta.url).href))
    .replace('entry?.key === key &&', 'entry &&');
  assert.notEqual(changed, source);
  const mutant = await import(`data:text/javascript;base64,${Buffer.from(changed).toString('base64')}`);
  await assert.rejects(probe(mutant.createReadCatalogAuthority), { code: 'ERR_ASSERTION' });
});
