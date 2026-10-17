import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createConnectionMaintenance } from './connection-maintenance.mjs';
import { createConnectionRenewal } from './connection-renewal.mjs';
import { createDurableAuthority } from './durable-authority.mjs';
import { createSessionCrypto } from './session-crypto.mjs';
import { createDependencyScope } from './dependency-scope.mjs';

const NOW = 1800000000000, token = `hc_${'a'.repeat(43)}`, digest = createHash('sha256').update(token).digest('hex');
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const grants = () => ({ read: ['assistant.context.read'], action: [] });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(done => setImmediate(done));
function fixture(t, hooks = {}) {
  const crypto = createSessionCrypto({ activeKeyVersion: 'fixture', keys: new Map([['fixture', Buffer.alloc(32, 7)]]) });
  const scope = createDependencyScope(), binding = { assistantId: id(2), userId: id(3), organizationId: id(4), sessionId: id(5) };
  const expiry = NOW + (hooks.fresh ? 3600000 : 240000), sessions = new Map([['PRIVATE-OLD', expiry], ['PRIVATE-NEW', NOW + 3600000]]);
  const row = { status: 'active', connection: { id: id(1), assistantId: id(2), userId: id(3), organizationId: id(4), state: 'active', epoch: 2,
    expiresAt: NOW + 180000, restrictions: grants(), scopeIds: [id(8)], tokenDigest: digest, credentialRef: id(6) },
    session: { credentialRef: id(6), revision: 1, expiresAt: expiry, binding,
      envelope: crypto.seal({ accessToken: 'PRIVATE-OLD', refreshToken: 'PRIVATE-REFRESH', expiresAt: expiry }, binding) },
    membership: { membershipId: id(7), authorizationVersion: 1, isSuperadmin: false }, policy: { version: 1, ...grants(), scopeIds: [id(8)] } };
  const calls = [], timers = new Map(); let nextTimer = 0;
  const store = { async readConnection(input, options) { assert.deepEqual(input, { tokenDigest: digest }); await hooks.read?.(scope, options); return structuredClone(row); },
    async renewConnection(input) { calls.push('renew'); await hooks.renew?.(row); assert.equal(input.expectedRevision, row.session.revision);
      row.connection.expiresAt = NOW + 900000 + (hooks.dbAhead ?? 0); return { ok: true, status: 'renewed', expiresAt: row.connection.expiresAt }; } };
  const authority = createDurableAuthority({ connectionStore: store, crypto, clock: () => NOW, auth: {
    async verifySession({ accessToken }) { calls.push('auth:' + accessToken); assert(sessions.has(accessToken));
      return { userId: binding.userId, sessionId: binding.sessionId, expiresAt: sessions.get(accessToken) }; },
    async readAuthorization() { return { userId: binding.userId, isSuperadmin: false, activeOrganizationIds: [binding.organizationId], epoch: 'crm-1',
      membership: { organizationId: binding.organizationId, status: 'ACTIVE', revokedAt: null, validFrom: null, validTo: null,
        membershipId: id(7), authorizationVersion: 1 }, permissions: grants(), companyCeilings: grants(),
      scopesByPermission: { 'assistant.context.read': { buildingIds: [], cashbookIds: [] } } }; },
  } });
  const renewal = createConnectionRenewal({ authority, connectionStore: store, clock: () => NOW });
  const publish = () => { row.session.revision++; row.session.expiresAt = NOW + 3600000;
    row.session.envelope = crypto.seal({ accessToken: 'PRIVATE-NEW', refreshToken: 'PRIVATE-NEW-REFRESH', expiresAt: row.session.expiresAt }, binding);
    hooks.published?.(row); return { credentialRef: id(6), expiresAt: row.session.expiresAt }; };
  const manager = { beginRefresh(ref, supplied, options) {
    calls.push('refresh'); assert.equal(ref, id(6)); assert.deepEqual(supplied, binding); assert(options.signal instanceof AbortSignal);
    return hooks.refresh?.({ publish, row, signal: options.signal }) ?? Object.freeze({ result: Promise.resolve(publish()), drained: Promise.resolve() });
  } };
  const maintenance = createConnectionMaintenance({ authority, connectionStore: store, refreshManager: manager, renewal,
    dependencyScope: scope, clock: () => NOW, timers: { setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); } } });
  t.after(async () => { await maintenance.close().catch(() => {}); await renewal.close(); await scope.close(); crypto.destroy(); });
  return { maintenance, calls, row, scope, timers, begin: signal => maintenance.begin(token, { signal: signal ?? new AbortController().signal }) };
}

test('near-expiry refresh is derived from real branded authority and verified before same-token renewal', async t => {
  const f = fixture(t), operation = f.begin(); assert(Object.isFrozen(operation));
  const result = await operation.result; await operation.drained;
  assert.deepEqual(result, { ok: true, status: 'renewed', connectionId: id(1), expiresAt: NOW + 900000, reconciled: false });
  assert.equal(f.calls.filter(x => x === 'refresh').length, 1); assert.equal(f.calls.filter(x => x === 'renew').length, 1);
  assert(f.calls.indexOf('refresh') < f.calls.indexOf('auth:PRIVATE-NEW')); assert(f.calls.indexOf('auth:PRIVATE-NEW') < f.calls.indexOf('renew'));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|hc_|credential|sessionId|binding|tokenDigest/);
});
// Renewal target is DB clock_timestamp() + 15 min; dbAhead shifts only that target (session stays valid).
for (const ahead of [50, 4000]) {
  test(`renewal target ${ahead} ms past the 15-minute TTL (DB clock ahead) is still accepted`, async t => {
    const f = fixture(t, { dbAhead: ahead }), operation = f.begin();
    assert.deepEqual(await operation.result, { ok: true, status: 'renewed', connectionId: id(1), expiresAt: NOW + 900000 + ahead, reconciled: false });
    await operation.drained; assert.equal(f.calls.filter(x => x === 'renew').length, 1);
  });
}
test('renewal target 6000 ms past the 15-minute TTL is not reported as success', async t => {
  const f = fixture(t, { dbAhead: 6000 }), operation = f.begin();
  // The renewal write was already dispatched, so the rejected ACK surfaces as unknown outcome.
  await assert.rejects(operation.result, { code: 'maintenance_outcome_unknown' }); await operation.drained;
  assert.equal(f.calls.filter(x => x === 'renew').length, 1);
});
test('fresh provider session only renews opaque connection; invalid actors/getters never reach dependencies', async t => {
  const f = fixture(t, { fresh: true }); let reads = 0;
  assert.throws(() => f.maintenance.begin(token, { signal: new AbortController().signal, credentialRef: id(99) }), /invalid_request/);
  assert.throws(() => f.maintenance.begin(token, { get signal() { reads++; return new AbortController().signal; } }), /invalid_request/);
  assert.equal(reads, 0); assert.deepEqual(f.calls, []);
  const operation = f.begin(); await operation.result; await operation.drained;
  assert(!f.calls.includes('refresh')); assert.equal(f.row.session.revision, 1);
});
for (const mutation of [row => row.session.revision++, row => row.session.binding.sessionId = id(99),
  row => row.policy.version++, row => row.connection.scopeIds.push(id(99)), row => row.connection.epoch++]) {
  test('refresh with changed session, policy, scope or epoch cannot renew or report success', async t => {
    const f = fixture(t, { published: mutation }), operation = f.begin();
    await assert.rejects(operation.result, { code: 'maintenance_outcome_unknown' }); await operation.drained;
    assert(!f.calls.includes('renew')); assert.equal(f.calls.filter(x => x === 'refresh').length, 1);
  });
}
test('public provider success cannot resume authority/renewal before its actual drain', async t => {
  const entered = deferred(), drain = deferred();
  const f = fixture(t, { refresh: ({ publish }) => { entered.resolve(); return { result: Promise.resolve(publish()), drained: drain.promise }; } });
  const operation = f.begin(); await entered.promise; await tick();
  try { assert(!f.calls.includes('renew')); assert(!f.calls.includes('auth:PRIVATE-NEW')); assert.throws(() => f.begin(), /busy/); }
  finally { drain.resolve(); }
  await operation.result; await operation.drained;
});
test('failed provider drain retains capacity and failed close, even with a successful result', async t => {
  const f = fixture(t, { refresh: ({ publish }) => ({ result: Promise.resolve(publish()), drained: Promise.reject(Error('unknown')) }) });
  const operation = f.begin(); await assert.rejects(operation.result, { code: 'maintenance_outcome_unknown' });
  await assert.rejects(operation.drained, { code: 'maintenance_outcome_unknown' }); assert.throws(() => f.begin(), /busy/);
  await assert.rejects(f.maintenance.close(), { code: 'maintenance_outcome_unknown' }); assert(!f.calls.includes('renew'));
});
for (const invalid of ['missing drain', 'drain getter', 'extra field', 'begin throws']) {
  test(`unproven refresh drain retains ownership when ${invalid}`, async t => {
    const held = deferred(); let getterReads = 0;
    const f = fixture(t, { refresh: () => {
      if (invalid === 'begin throws') throw Error('refresh may already be running');
      if (invalid === 'drain getter') return { result: held.promise, get drained() { getterReads++; return Promise.resolve(); } };
      if (invalid === 'extra field') return { result: held.promise, drained: Promise.resolve(), unexpected: true };
      return { result: held.promise, drained: null };
    } });
    const operation = f.begin();
    await assert.rejects(operation.result, { code: 'maintenance_outcome_unknown' });
    try {
      await assert.rejects(operation.drained, { code: 'maintenance_outcome_unknown' });
      assert.throws(() => f.begin(), /busy/);
      await assert.rejects(f.maintenance.close(), { code: 'maintenance_outcome_unknown' });
      assert.equal(f.calls.filter(x => x === 'refresh').length, 1);
      assert(!f.calls.includes('renew')); assert.equal(getterReads, 0);
    } finally {
      // Invalid handles can still contain a real result which rejects later.
      // The thrown-begin case exposes no Promise, so the fixture owns that sink.
      if (invalid === 'begin throws') void held.promise.catch(() => {});
      held.reject(Error('late private provider failure')); await tick();
    }
  });
}

test('timeout after refresh dispatch is unknown; late provider completion cannot renew and close holds actual drain', async t => {
  const entered = deferred(), held = deferred(), drain = deferred(); let publish;
  const f = fixture(t, { refresh: value => { publish = value.publish; entered.resolve(); return { result: held.promise, drained: drain.promise }; } });
  const operation = f.begin(); await entered.promise; [...f.timers.values()][0]();
  await assert.rejects(operation.result, { code: 'maintenance_outcome_unknown' });
  let closed = false; const closing = f.maintenance.close().then(() => { closed = true; }); await tick();
  assert.equal(closed, false); held.resolve(publish()); await tick(); assert.equal(closed, false); drain.resolve();
  await operation.drained; await closing; assert(!f.calls.includes('renew')); assert.equal(f.calls.filter(x => x === 'refresh').length, 1);
});
test('actual hidden authority work retains close and admission after the public adapter fails', async t => {
  const entered = deferred(), held = deferred(); let failRead = true;
  const f = fixture(t, { read: scope => { if (failRead) { failRead = false; void scope.track(async () => { entered.resolve(); await held.promise; }); throw Error('public deadline'); } } });
  const operation = f.begin(); await entered.promise; await assert.rejects(operation.result, { code: 'maintenance_rejected' });
  let drained = false; void operation.drained.then(() => { drained = true; });
  try { await tick(); assert.equal(drained, false); assert.throws(() => f.begin(), /busy/); assert.deepEqual(f.calls, []); }
  finally { held.resolve(); await operation.drained; }
});
test('post-renewal authority change cannot report ready', async t => {
  const f = fixture(t, { renew: row => { row.policy.version++; } }), operation = f.begin();
  await assert.rejects(operation.result, { code: 'maintenance_outcome_unknown' }); await operation.drained;
  assert.equal(f.calls.filter(x => x === 'renew').length, 1);
});
