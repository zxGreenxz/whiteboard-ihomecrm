import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as lifecycle from '../copilot-c02-fixture-lifecycle.mjs';
import { digest, DEMO_ORG } from '../copilot-golden-browser-evidence.mjs';
import { bindCustomerScenario } from '../copilot-customer-fixtures.mjs';

test('crash after association delete commit reconciles absence before soft deleting customer',async()=>{
 const h=harness(),run=await opened(h);await run.setup();const journal=run.journal();
 journal.state='cleanup_required';journal.associationDelete='may_be_in_flight';h.store.save(journal);
 await h.client.deleteAssociation(h.plan);
 renameSync(join(h.directory,'lock.json'),join(h.directory,'operator-quarantined-lock.json'));
 const recovered=await lifecycle.openC02Lifecycle({...h,store:lifecycle.createC02FileStore({directory:h.directory}),recovery:true});
 assert.equal((await recovered.cleanup()).state,'finalized');assert.equal(h.calls.filter(c=>c==='deleteAssociation').length,1);assert.ok(h.customers()[0].deleted_at);
});
const actorId = 'aaaa4000-0000-4000-8000-000000000001', hostId = '10b1a785-6344-4598-812c-6dc6e98837ed';
function harness() {
    const plan = lifecycle.createC02FixturePlan({ contextId: 'controlled-c02', actorId });
    const host = { id: hostId, organization_id: DEMO_ORG, status: 'TERMINATED', deleted_at: null, room_id: 'aaaa4000-0000-4000-8000-000000000002', building_id: 'aaaa4000-0000-4000-8000-000000000003', untouched: 'original' };
    const existing = [{ id: 'aaaa4000-0000-4000-8000-000000000004', contract_id: hostId, is_representative: true, notes: 'existing' }];
    const review = { implementationSha: 'a'.repeat(40), hostId, hostDigest: digest(host), associationsDigest: digest(existing), actorDigest: digest(actorId), triggerDigest: 'b'.repeat(64), cleanupBodyDigest: 'c'.repeat(64), designationActorDigest: lifecycle.rawSha256(actorId), designationAssociationDigest: lifecycle.designationAssociationDigest(existing) };
    const preflight = { measuredAt: new Date().toISOString(), actorId, organizationId: DEMO_ORG, host, associations: existing, review, actorCanReadHost: true, permissions: { 'customers.view': true, 'customers.create': true, 'contracts.create': true, 'contracts.delete': true }, exactNameMatches: 0, phoneMatches: 0, markerMatches: 0, customerIdMatches: 0, associationIdMatches: 0, triggerDigest: review.triggerDigest, cleanupBodyDigest: review.cleanupBodyDigest, authenticatedExecute: true, anonExecute: false };
    const directory = mkdtempSync(join(tmpdir(), 'c02-controlled-')), store = lifecycle.createC02FileStore({ directory }), calls = [], modes = {};
    let customers = [], associations = structuredClone(existing);
    const lateCustomer = () => { customers = [{ ...lifecycle.customerInsert(plan), deleted_at: null, updated_at: '2026-09-07T00:00:00Z' }]; };
    const lateAssociation = () => associations.push(lifecycle.associationInsert(plan));
    const client = { readPreflight: async () => structuredClone(preflight), readSnapshot: async () => ({ host: structuredClone(host), associations: structuredClone(associations) }), readCustomers: async () => structuredClone(customers), readAssociations: async () => structuredClone(associations.filter(a => a.id === plan.associationId || a.customer_id === plan.customerId)),
        search: async () => customers.filter(c => !c.deleted_at && associations.some(a => a.customer_id === c.id)).map(c => ({ customer_id: c.id, customer_name: c.full_name, phone: c.phone, contract_id: hostId, contract_status: 'TERMINATED', contract_number: 'HD-GOLDEN', room_id: host.room_id, room_name: 'G1', building_id: host.building_id, building_name: 'DEMO', is_representative: false })),
        createCustomer: async () => { calls.push('createCustomer'); if (modes.customer === 'rejected')
            return { outcome: 'rejected' }; if (modes.customer !== 'late')
            lateCustomer(); if (modes.customer)
            throw Error('lost'); return { outcome: 'success' }; },
        createAssociation: async () => { calls.push('createAssociation'); if (modes.association === 'rejected')
            return { outcome: 'rejected' }; if (modes.association !== 'late')
            lateAssociation(); if (modes.association)
            throw Error('lost'); return { outcome: 'success' }; },
        deleteAssociation: async () => { calls.push('deleteAssociation'); if (modes.delete === 'denied')
            return { outcome: 'rejected' }; associations = associations.filter(a => a.id !== plan.associationId); if (modes.delete)
            throw Error('lost'); return { outcome: 'success' }; },
        softDeleteCustomer: async () => { calls.push('softDeleteCustomer'); customers.forEach(c => { c.deleted_at = '2026-09-07T01:00:00Z'; c.updated_at = c.deleted_at; }); if (modes.softDelete)
            throw Error('lost'); return { outcome: 'success' }; } };
    return { plan, preflight, client, store, directory, calls, modes, host, existing, customers: () => customers, associations: () => associations, lateCustomer, lateAssociation };
}
const opened = h => lifecycle.openC02Lifecycle(h);
test('recovery after crash before first write cannot setup and cleans the unstarted journal', async () => {
    const h = harness();
    const initial = await opened(h);
    assert.equal(initial.journal().state, 'preflight');
    assert.equal(initial.journal().customer, 'not_started');
    assert.equal(initial.journal().association, 'not_started');
    renameSync(join(h.directory, 'lock.json'), join(h.directory, 'operator-quarantined-lock.json'));
    // A recovery path cannot rely on the initial preflight still being current.
    h.preflight.measuredAt = '2020-01-01T00:00:00Z';
    const recovered = await lifecycle.openC02Lifecycle({ ...h, store: lifecycle.createC02FileStore({ directory: h.directory }), recovery: true });
    await assert.rejects(recovered.setup(), /setup_already_started/);
    assert.deepEqual(h.calls, []);
    const receipt = await recovered.cleanup();
    assert.equal(receipt.state, 'finalized');
    assert.equal(receipt.customerSoftDeleted, false);
    assert.equal(receipt.retainedSyntheticTombstone, false);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.associations(), h.existing);
});
test('owned append cleanup retains tombstone and preserves whole original host and occupants', async () => {
    const h = harness(), run = await opened(h);
    await run.setup();
    const proof = await run.ownershipAttestation(await h.client.search());
    assert.equal(proof.phoneDigest, digest(h.plan.phone));
    const receipt = await run.cleanup();
    assert.equal(receipt.state, 'finalized');
    assert.equal(receipt.customerSoftDeleted, true);
    assert.equal(receipt.physicalCustomerDeletion, false);
    assert.equal(receipt.retainedSyntheticTombstone, true);
    assert.deepEqual(h.calls, ['createCustomer', 'createAssociation', 'deleteAssociation', 'softDeleteCustomer']);
    assert.deepEqual(h.associations(), h.existing);
    assert.ok(h.customers()[0].deleted_at);
    assert.equal(readFileSync(join(h.directory, 'journal.json'), 'utf8').includes(h.plan.phone), false);
});
test('known rejected and committed ambiguous inserts clean partial state without retry', async () => {
    for (const field of ['customer', 'association'])
        for (const mode of ['rejected', 'lost']) {
            const h = harness();
            h.modes[field] = mode;
            const run = await opened(h);
            await assert.rejects(run.setup());
            assert.equal((await run.cleanup()).state, 'finalized');
            assert.equal(h.calls.filter(c => c === 'createCustomer').length, 1);
        }
});
test('absent ambiguous insert stays pending until late commit then exact cleanup', async () => {
    for (const field of ['customer', 'association']) {
        const h = harness();
        h.modes[field] = 'late';
        const run = await opened(h);
        await assert.rejects(run.setup());
        await assert.rejects(run.cleanup(), /cleanup_required/);
        assert.equal(run.journal().state, 'cleanup_required');
        await assert.rejects(opened(h), /lock|pending/);
        if (field === 'customer')
            h.lateCustomer();
        else
            h.lateAssociation();
        assert.equal((await run.cleanup()).state, 'finalized');
        assert.equal(h.calls.filter(c => c.startsWith('create')).length, field === 'customer' ? 1 : 2);
    }
});
test('all ownership predicates and row uniqueness guard cleanup writes', async () => {
    for (const [kind, key, value] of [['customer', 'id', actorId], ['customer', 'user_id', 'wrong'], ['customer', 'organization_id', 'wrong'], ['customer', 'full_name', 'wrong'], ['customer', 'notes', 'wrong'], ['customer', 'phone', '0009999999'], ['association', 'id', actorId], ['association', 'contract_id', 'wrong'], ['association', 'customer_id', 'wrong'], ['association', 'organization_id', 'wrong'], ['association', 'notes', 'wrong'], ['association', 'is_representative', true]]) {
        const h = harness(), run = await opened(h);
        await run.setup();
        (kind === 'customer' ? h.customers()[0] : h.associations().at(-1))[key] = value;
        await assert.rejects(run.cleanup(), /ownership|cleanup_required/);
        assert.equal(h.calls.length, 2, `${kind}.${key}`);
    }
    const h = harness(), run = await opened(h);
    await run.setup();
    h.customers().push({ ...h.customers()[0] });
    await assert.rejects(run.cleanup());
    assert.equal(h.calls.length, 2);
});
test('preflight rejects identity snapshot permissions and body drift before writes', async () => {
    for (const mutate of [p => p.actorId = 'wrong', p => p.organizationId = 'wrong', p => p.host.status = 'ACTIVE', p => p.host.id = actorId, p => p.host.room_id = actorId, p => p.host.untouched = 'changed', p => p.associations[0].notes = 'changed', p => p.authenticatedExecute = false, p => p.anonExecute = true, p => p.triggerDigest = 'd'.repeat(64), p => p.cleanupBodyDigest = 'd'.repeat(64), p => p.exactNameMatches = 1, ...['customers.view', 'customers.create', 'contracts.create', 'contracts.delete'].map(k => p => p.permissions[k] = false)]) {
        const h = harness();
        mutate(h.preflight);
        await assert.rejects(opened(h), /preflight/);
        assert.equal(h.calls.length, 0);
    }
});
test('lost cleanup responses use canonical proof; denied delete leaves customer untouched', async () => {
    for (const key of ['delete', 'softDelete']) {
        const h = harness();
        h.modes[key] = 'lost';
        const run = await opened(h);
        await run.setup();
        assert.equal((await run.cleanup()).state, 'finalized');
    }
    const h = harness();
    h.modes.delete = 'denied';
    const run = await opened(h);
    await run.setup();
    await assert.rejects(run.cleanup());
    assert.equal(h.customers()[0].deleted_at, null);
});
test('unrelated drift is reported and never restored', async () => { const h = harness(), run = await opened(h); await run.setup(); h.host.untouched = 'external'; await assert.rejects(run.cleanup(), /drift/); assert.equal(h.host.untouched, 'external'); assert.equal(run.journal().state, 'cleanup_required'); });
test('journal lock ownership loss prevents requests and crash journal blocks relaunch', async () => { const h = harness(), run = await opened(h); await run.setup(); writeFileSync(join(h.directory, 'lock.json'), JSON.stringify({ token: 'other' })); await assert.rejects(run.cleanup(), /lock/); assert.equal(h.calls.length, 2); await assert.rejects(opened(h), /lock|pending/); });
test('ordinary REST client sends exact bodies and guarded deletion; SQL is read-only', async () => {
    const h = harness(), requests = [], queries = [];
    const client = lifecycle.createC02AppClient({ apiOrigin: 'https://fixture.supabase.co', credentialProvider: async () => ({ accessToken: 'fake-user-token', apikey: 'fake-anon-key', actorId }), fetch: async (url, init) => { requests.push({ url, init }); return { ok: true, json: async () => [] }; }, readonlySql: async (query) => { queries.push(query); return query.includes('JOIN public.rooms') ? [h.host] : []; }, readPreflight: async () => h.preflight });
    await client.createCustomer(lifecycle.customerInsert(h.plan), h.plan);
    await client.createAssociation(lifecycle.associationInsert(h.plan), h.plan);
    await client.deleteAssociation(h.plan);
    await client.softDeleteCustomer(h.plan);
    await client.readCustomers(h.plan);
    await client.readAssociations(h.plan);
    await client.readSnapshot(h.plan);
    assert.deepEqual(JSON.parse(requests[0].init.body), { id: h.plan.customerId, organization_id: DEMO_ORG, user_id: actorId, full_name: 'Nguyễn An', phone: h.plan.phone, customer_type: 'INDIVIDUAL', status_v2: 'RENTING', notes: h.plan.marker });
    assert.deepEqual(JSON.parse(requests[1].init.body), { id: h.plan.associationId, organization_id: DEMO_ORG, contract_id: hostId, customer_id: h.plan.customerId, is_representative: false, notes: h.plan.marker });
    const del = new URL(requests[2].url);
    assert.equal(requests[2].init.method, 'DELETE');
    for (const [k, v] of Object.entries(lifecycle.associationInsert(h.plan)))
        assert.equal(del.searchParams.get(k), `eq.${v}`);
    assert.equal(new URL(requests[3].url).pathname, '/rest/v1/rpc/soft_delete_customer');
    assert.deepEqual(JSON.parse(requests[3].init.body), { p_customer_id: h.plan.customerId });
    assert.ok(queries.every(q => /^SELECT\b/.test(q)));
    assert.equal(requests.every(r => r.init.headers.Authorization === 'Bearer fake-user-token'), true);
});
test('browser binding requires complete owned attestation and fresh payload, never ID alone', async () => {
    const h = harness(), run = await opened(h);
    await run.setup();
    const payload = await h.client.search(), ownership = await run.ownershipAttestation(payload);
    const scenario = { id: 'C02', oracle: 'customer-nguyen-an-v1', prompt: 'Tìm khách hàng Nguyễn An' }, input = { query: 'Nguyễn An', contextId: h.plan.contextId, actorDigest: digest(actorId), payload, ownership };
    assert.throws(() => bindCustomerScenario(scenario, { ...input, ownership: undefined, ownedCustomerId: h.plan.customerId }), /fixture_unbound/);
    for (const key of Object.keys(ownership)) {
        const wrong = { ...ownership };
        delete wrong[key];
        assert.throws(() => bindCustomerScenario(scenario, { ...input, ownership: wrong }), /fixture_unbound/, key);
    }
    for (const mutate of [p => p[0].phone = '0009999999', p => p[0].customer_id = actorId, p => p[0].contract_id = actorId, p => p[0].is_representative = true, p => p[0].room_id = actorId]) {
        const bad = structuredClone(payload);
        mutate(bad);
        assert.throws(() => bindCustomerScenario(scenario, { ...input, payload: bad }), /fixture_unbound/);
    }
    assert.deepEqual(bindCustomerScenario(scenario, input).attestation.ownership, ownership);
    await run.cleanup();
});
test('credential DI rejects missing aliases extra keys and actor mismatch before transport', async () => {
    for (const credentials of [null, {}, { apikey: 'fake', accessToken: 'fake', actorId: 'wrong' }, { anon: 'fake', token: 'fake', actorId }, { apikey: 'fake', accessToken: 'fake', actorId, serviceRole: 'fake' }, { apikey: ' ', accessToken: 'fake', actorId }]) {
        const h = harness();
        let requests = 0;
        const client = lifecycle.createC02AppClient({ apiOrigin: 'https://fixture.supabase.co', credentialProvider: async () => credentials, fetch: async () => { requests++; return { ok: true, json: async () => [] }; }, readonlySql: async () => [], readPreflight: async () => h.preflight });
        await assert.rejects(client.createCustomer(lifecycle.customerInsert(h.plan), h.plan), /credential_identity/);
        assert.equal(requests, 0);
    }
});
test('HTTP errors including proxy timeout cannot prove a create rolled back', async () => {
    const h = harness();
    for (const status of [408, 429, 500]) {
        const client = lifecycle.createC02AppClient({ apiOrigin: 'https://fixture.supabase.co', credentialProvider: async () => ({ apikey: 'fake', accessToken: 'fake', actorId }), fetch: async () => ({ ok: false, status }), readonlySql: async () => [], readPreflight: async () => h.preflight });
        assert.equal((await client.createCustomer(lifecycle.customerInsert(h.plan), h.plan)).outcome, 'ambiguous');
    }
});
test('a failed duplicate acquisition does not invalidate the original lock owner', async () => {
    const h = harness();
    h.store.acquire();
    assert.throws(() => h.store.acquire());
    h.store.assertOwner();
});
test('journal records canonical row digests before use and preserves original designation hashes', async () => {
    const h = harness(), run = await opened(h);
    await run.setup();
    const journal = run.journal();
    assert.equal(journal.customerDigest, digest(h.customers()[0]));
    assert.equal(journal.associationDigest, digest(h.associations().at(-1)));
    assert.equal(journal.designationActorDigest, h.preflight.review.designationActorDigest);
    assert.equal(journal.designationAssociationDigest, h.preflight.review.designationAssociationDigest);
    assert.notEqual(journal.designationActorDigest, journal.actorDigest);
    assert.notEqual(journal.designationAssociationDigest, journal.associationsDigest);
    await run.cleanup();
});
test('explicit lock quarantine recovers crash after soft-delete commit without recreating', async () => {
    const h = harness(), run = await opened(h);
    await run.setup();
    const base = run.journal();
    base.state = 'cleanup_required';
    base.association = 'cleaned';
    base.customerSoftDelete = 'may_be_in_flight';
    await h.client.deleteAssociation(h.plan);
    await h.client.softDeleteCustomer(h.plan);
    h.store.save(base);
    renameSync(join(h.directory, 'lock.json'), join(h.directory, 'operator-quarantined-lock.json'));
    const recovered = await lifecycle.openC02Lifecycle({ ...h, store: lifecycle.createC02FileStore({ directory: h.directory }), recovery: true });
    await assert.rejects(recovered.setup(), /setup_already_started/);
    assert.equal((await recovered.cleanup()).state, 'finalized');
    assert.equal(h.calls.filter(c => c === 'createCustomer').length, 1);
});
test('every create is durable in-flight before transport and completed cleanup is idempotent', async () => {
    const h = harness();
    for (const [method, step] of [['createCustomer', 'customer'], ['createAssociation', 'association']]) {
        const operation = h.client[method];
        h.client[method] = async (...args) => {
            const saved = JSON.parse(readFileSync(join(h.directory, 'journal.json'), 'utf8'));
            assert.equal(saved[step], 'may_be_in_flight');
            assert.equal(saved.attempts.at(-1).step, step);
            return operation(...args);
        };
    }
    const run = await opened(h);
    await run.setup();
    const receipt = await run.cleanup();
    assert.deepEqual(await run.cleanup(), receipt);
    assert.equal(h.calls.length, 4);
});
test('missing tombstone advanced time or active-search absence never finalizes cleanup', async () => {
    for (const mode of ['physical', 'unchanged-time', 'still-visible']) {
        const h = harness(), run = await opened(h);
        await run.setup();
        const operation = h.client.softDeleteCustomer;
        h.client.softDeleteCustomer = async () => { await operation(); if (mode === 'physical')
            h.customers().splice(0); if (mode === 'unchanged-time')
            h.customers()[0].updated_at = '2026-09-07T00:00:00Z'; return { outcome: 'success' }; };
        if (mode === 'still-visible')
            h.client.search = async () => [{ customer_id: h.plan.customerId }];
        await assert.rejects(run.cleanup(), /cleanup_required/);
        assert.equal(run.journal().state, 'cleanup_required');
    }
});
