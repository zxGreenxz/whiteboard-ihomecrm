import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { readRoomPassFlag, createEmergencyFixture, removeEmergencyFixture, assertDeniedUnchanged, assertLinkedExecution, withScopeRevocation } from '../lib/copilot-room-pass-admin-fixtures.mjs';
import { createRoomPassTransport } from '../lib/copilot-room-pass-transport.mjs';
import { recoverRoomPassRun } from '../lib/copilot-room-pass-recovery.mjs';

const api = await import('../lib/copilot-room-pass-live.mjs').catch(() => ({}));
const ACTOR = '11111111-1111-4111-8111-111111111111';
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'room-pass-test-'));
  try {
    const journalPath = join(dir, 'run.json');
    const run = await api.prepareRoomPassRun({ organizationId: api.DEMO, actorId: ACTOR, journalPath });
    const state = { buildings: [], rooms: [], room_pass_listings: [], requests: [] };
    const transport = {
      identity: async () => ({ actorId: ACTOR, organizationId: api.DEMO, authenticated: true }),
      request: async (ctx, request) => {
        assert.equal(ctx.organizationId, api.DEMO); assert.equal(ctx.actorId, ACTOR);
        state.requests.push(request);
        if (request.method === 'GET') return { status: 200, body: state[request.table].filter(row => Object.entries(request.filters).every(([key, value]) => row[key] === value)) };
        if (request.method === 'POST' && request.table) { state[request.table].push({ ...request.body, deleted_at: null }); return { status: 201, body: [] }; }
        if (request.rpc === 'upsert_room_pass_listing') {
          state.room_pass_listings.push({ id: '22222222-2222-4222-8222-222222222222', organization_id: api.DEMO, user_id: ACTOR, created_by: ACTOR,
            building_id: run.fixtures.building.id, room_id: run.fixtures.room.id, sale_policy: run.marker, active: false });
          return { status: 200, body: state.room_pass_listings[0] };
        }
        throw new Error('unhandled_transport_request');
      },
    };
    const runner = new api.RoomPassRun({ run, journalPath, transport });
    await fn({ run, runner, transport, state, journalPath });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
test('exposes an import-safe fixture journal before any transport is configured', () => {
  assert.equal(typeof api.prepareRoomPassRun, 'function');
});

test('unknown committed setup is journaled before request and never creates a duplicate or starts cleanup', async () => fixture(async ({ runner, run, transport, state, journalPath }) => {
  const request = transport.request;
  transport.request = async (ctx, req) => {
    if (req.rpc === 'upsert_room_pass_listing') {
      const saved = JSON.parse(await readFile(journalPath, 'utf8'));
      assert.equal(saved.operations.at(-1).name, 'create_listing');
      assert.equal(saved.operations.at(-1).state, 'intent');
      await request(ctx, req); throw new Error('JWT secret body contact_name');
    }
    return request(ctx, req);
  };
  await assert.rejects(runner.setup(), /transport_unknown/);
  assert.equal(state.room_pass_listings.length, 1);
  await assert.rejects(runner.setup(), /setup_already_started/);
  await assert.rejects(runner.cleanupFixtures(), /unsettled_operation/);
  assert.equal(run.operations.at(-1).state, 'unknown');
  const saved = await readFile(journalPath, 'utf8');
  assert.ok(!saved.includes('secret')); assert.ok(!saved.includes('contact_name'));
}));

test('ownership cannot be repaired when canonical upsert yields a different organization', async () => fixture(async ({ runner, transport, state }) => {
  const request = transport.request;
  transport.request = async (ctx, req) => {
    const result = await request(ctx, req);
    if (req.rpc === 'upsert_room_pass_listing') state.room_pass_listings[0].organization_id = 'aaaa0000-0000-4000-8000-000000000001';
    return result;
  };
  await assert.rejects(runner.setup(), /listing_ownership_ambiguous/);
  assert.equal(state.requests.filter(req => req.method === 'PATCH').length, 0);
}));

test('scope identity is checked again before every mutation', async () => fixture(async ({ runner, transport, state }) => {
  transport.identity = async () => ({ actorId: ACTOR, organizationId: 'aaaa0000-0000-4000-8000-000000000001', authenticated: true });
  await assert.rejects(runner.setup(), /identity_mismatch/);
  assert.equal(state.requests.length, 0);
}));

test('unknown operation recovery requires terminal evidence before exact ownership reconciliation', async () => fixture(async ({ runner, run }) => {
  run.operations.push({ id: '33333333-3333-4333-8333-333333333333', name: 'create_building', target: run.fixtures.building.id, state: 'unknown' });
  assert.equal(typeof runner.reconcileUnknown, 'function');
  await assert.rejects(runner.reconcileUnknown({ operationId: run.operations[0].id, terminal: false }), /terminal_evidence_required/);
}));

test('flag CAS never adopts someone else’s newer action revision or enables globally', async () => fixture(async ({ runner, transport, run }) => {
  let flag = { scope: 'action', contract_id: api.ACTION, state: 'disabled', canary_org: null, expires_at: null,
    revision: 8, updated_by: ACTOR, updated_at: '2026-09-08T00:00:00Z', reason: 'initial', evidence_link: 'initial', rollback_reference: 'initial' };
  const calls = [];
  transport.readFlag = async () => ({ flag: structuredClone(flag), globalRevision: flag.revision });
  transport.request = async (_, req) => {
    calls.push(req.args);
    flag = { ...flag, state: req.args.p_state, revision: flag.revision + 1, canary_org: req.args.p_canary_org,
      expires_at: req.args.p_expires_at, reason: req.args.p_reason, evidence_link: req.args.p_evidence_link,
      rollback_reference: req.args.p_rollback_reference };
    return { status: 200, body: structuredClone(flag) };
  };
  await runner.enable();
  assert.deepEqual(calls.map(call => call.p_state), ['shadow', 'enabled']);
  assert.ok(calls.every(call => call.p_canary_org === api.DEMO && Date.parse(call.p_expires_at) > Date.now()));
  assert.equal(run.controls.prior.state, 'disabled');
  flag.reason = 'concurrent operator'; flag.revision += 1;
  await assert.rejects(runner.restoreControl(), /control_concurrent_change/);
  assert.equal(calls.length, 2);
}));

test('contact values and arbitrary RPC errors cannot become evidence', () => {
  assert.equal(api.responseCode({ status: 400, body: { message: 'Bearer secret nonce x' } }), 'request_rejected');
  assert.equal(api.responseCode({ status: 403, body: { message: 'payload_changed secret' } }), 'request_rejected');
  assert.equal(api.responseCode({ status: 403, body: { message: 'payload_changed' } }), 'payload_changed');
});

test('administrative emergency CAS removes only its exact owned row and refuses changed state', async () => fixture(async ({ runner, run }) => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE SCHEMA app_private; CREATE TABLE buildings(id uuid,organization_id uuid,user_id uuid,name text);
      CREATE TABLE app_private.tenant_emergency_denies(id uuid PRIMARY KEY,organization_id uuid,permission_key text,
        active_from timestamptz,expires_at timestamptz,reason text,created_by uuid,created_at timestamptz DEFAULT clock_timestamp());`);
    await db.query('INSERT INTO buildings VALUES($1,$2,$3,$4)', [run.fixtures.building.id, api.DEMO, ACTOR, run.marker]);
    await db.query('INSERT INTO app_private.tenant_emergency_denies(id,organization_id,reason) VALUES($1,$2,$3)',
      ['33333333-3333-4333-8333-333333333333', api.DEMO, 'pre-existing fixture']);
    const management = { query: async sql => {
      try { const results = await db.exec(sql); return results.findLast(result => result.fields?.length)?.rows ?? []; }
      catch (error) { await db.exec('ROLLBACK'); throw error; }
    } };
    const own = await createEmergencyFixture(runner, management, { permission: api.PERMISSION });
    assert.equal(own.row.organization_id, api.DEMO);
    await removeEmergencyFixture(runner, management, own);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM app_private.tenant_emergency_denies')).rows[0].n, 1);
    const changed = await createEmergencyFixture(runner, management);
    await db.query('UPDATE app_private.tenant_emergency_denies SET reason=$1 WHERE id=$2', ['concurrent change', changed.id]);
    await assert.rejects(removeEmergencyFixture(runner, management, changed), /transport_unknown/);
    assert.equal((await db.query('SELECT reason FROM app_private.tenant_emergency_denies WHERE id=$1', [changed.id])).rows[0].reason, 'concurrent change');
    assert.equal(run.operations.at(-1).state, 'unknown');
  } finally { await db.close(); }
}));

test('ordinary REST transport rejects other-org rows, global flags and private direct writes before fetch', async () => {
  let requests = 0;
  const transport = createRoomPassTransport({ baseUrl: 'https://example.supabase.co', apikey: 'test-only', jwt: 'test-only', actorId: ACTOR,
    fetchImpl: async () => { requests++; return new Response('[]'); } });
  const context = { actorId: ACTOR, organizationId: api.DEMO, runId: ACTOR };
  await assert.rejects(transport.request(context, { method: 'PATCH', table: 'rooms', filters: { organization_id: 'aaaa0000-0000-4000-8000-000000000001' }, body: {} }), /table_scope_invalid/);
  await assert.rejects(transport.request(context, { method: 'POST', table: 'room_pass_listings', body: { organization_id: api.DEMO } }), /direct_write_forbidden/);
  await assert.rejects(transport.request(context, { method: 'POST', rpc: 'set_copilot_feature_flag_v2', args: {
    p_scope: 'action', p_contract_id: api.ACTION, p_state: 'enabled', p_canary_org: null,
  } }), /flag_scope_invalid/);
  assert.equal(requests, 0);
});

test('atomic denial oracle detects consumed consent, extra audit, and wrong audit-ledger linkage', () => {
  const before = { listing: { active: false }, audits: [], ledger: [], consent: { id: ACTOR, consumed: false } };
  assert.doesNotThrow(() => assertDeniedUnchanged(before, structuredClone(before)));
  assert.throws(() => assertDeniedUnchanged(before, { ...before, consent: { id: ACTOR, consumed: true } }), /denial_not_atomic/);
  assert.throws(() => assertDeniedUnchanged(before, { ...before, audits: [{ id: ACTOR }] }), /denial_not_atomic/);
  const after = { listing: { active: true }, audits: [{ id: 'audit', idempotency_key: `copilot_action:${api.ACTION}:${ACTOR}` }],
    ledger: [{ id: 'ledger', audit_id: 'wrong', consent_id: ACTOR }], consent: { id: ACTOR, consumed: true } };
  assert.throws(() => assertLinkedExecution(before, after, { audit_id: 'audit', ledger_id: 'ledger' }), /audit_ledger_linkage_invalid/);
  after.ledger[0].audit_id = 'audit';
  assert.doesNotThrow(() => assertLinkedExecution(before, after, { audit_id: 'audit', ledger_id: 'ledger' }));
});

test('cleanup takes fresh consent before canonical delete and verifies retained parent tombstones', async () => fixture(async ({ runner, run, transport, state, journalPath }) => {
  await runner.setup(); state.room_pass_listings[0].active = true;
  const original = transport.request, writes = [];
  transport.request = async (ctx, req) => {
    if (req.method === 'GET') return original(ctx, req);
    writes.push(req.rpc ?? `PATCH:${req.table}`);
    if (req.rpc === 'copilot_preview_room_pass_active_v1') return { status: 200, body: {
      confirmation_nonce: 'a'.repeat(64), canonical: { organization_id: api.DEMO, listing_id: run.fixtures.listing.id,
        building_id: run.fixtures.building.id, room_id: run.fixtures.room.id, before_active: true, active: false,
        before_revision: 'b'.repeat(64), building_label: run.marker, room_label: run.marker }, preview: {},
    } };
    if (req.rpc === 'copilot_execute_room_pass_active_v1') {
      assert.equal(req.args.p_confirmation_nonce, 'a'.repeat(64));
      assert.equal(JSON.parse(await readFile(journalPath, 'utf8')).operations.at(-1).state, 'intent');
      state.room_pass_listings[0].active = false;
      return { status: 200, body: { entity_table: 'room_pass_listings', entity_id: run.fixtures.listing.id,
        audit_id: ACTOR, ledger_id: ACTOR, active: false } };
    }
    if (req.rpc === 'delete_room_pass_listing') {
      assert.equal(state.room_pass_listings[0].active, false); state.room_pass_listings = []; return { status: 204, body: null };
    }
    if (req.method === 'PATCH') {
      state[req.table].filter(row => Object.entries(req.filters).every(([key, value]) => row[key] === value)).forEach(row => Object.assign(row, req.body));
      return { status: 200, body: [] };
    }
    throw new Error('unexpected');
  };
  await runner.cleanupFixtures();
  assert.ok(writes.indexOf('copilot_preview_room_pass_active_v1') < writes.indexOf('copilot_execute_room_pass_active_v1'));
  assert.ok(writes.indexOf('copilot_execute_room_pass_active_v1') < writes.indexOf('delete_room_pass_listing'));
  assert.equal(run.fixtureCleanup.status, 'done'); assert.equal(run.fixtureCleanup.retainedParentTombstones, 3);
  assert.equal(state.room_pass_listings.length, 0);
  const saved = await readFile(journalPath, 'utf8');
  assert.ok(!saved.includes('a'.repeat(64))); assert.ok(!saved.includes('p_confirmation_nonce'));
}));

test('recovery will not read or write while any original operation lacks verified terminal evidence', async () => fixture(async ({ runner, run, transport, journalPath, state }) => {
  run.operations.push({ id: ACTOR, name: 'create_building', state: 'unknown', target: run.fixtures.building.id });
  transport.verifyTerminal = async (_ctx, claim) => claim.operationId.startsWith('operator:');
  const evidence = { [`operator:${run.runId}`]: 'a'.repeat(64), [ACTOR]: 'b'.repeat(64) };
  await assert.rejects(recoverRoomPassRun({ run, journalPath, transport, management: {}, terminalEvidence: evidence }), /terminal_evidence_unverified/);
  assert.equal(state.requests.length, 0); assert.equal(run.operations[0].state, 'unknown');
}));

test('an unrelated surviving room blocks parent deletion', async () => fixture(async ({ runner, state, run }) => {
  await runner.setup();
  state.rooms.push({ id: ACTOR, organization_id: api.DEMO, building_id: run.fixtures.building.id, name: 'different marker', deleted_at: null });
  // The second (scope-only) building is removed first, but never the parent of
  // this unrelated room. Keep the assertion scoped to the protected parent.
  const original = runner.transport.request;
  runner.transport.request = async (ctx, req) => {
    if (req.method === 'PATCH') {
      for (const row of state[req.table]) if (row.id === req.filters.id) Object.assign(row, req.body);
      return { status: 200, body: [] };
    }
    return original(ctx, req);
  };
  await assert.rejects(runner.cleanupFixtures(), /room_ownership_ambiguous/);
  assert.equal(state.buildings.find(row => row.id === run.fixtures.building.id).deleted_at, null);
  assert.equal(state.room_pass_listings.length, 1);
}));

test('membership revoke uses exact CAS and does not overwrite concurrent bindings on restoration', async () => fixture(async ({ runner, run }) => {
  const admin = '44444444-4444-4444-8444-444444444444';
  const current = { id: ACTOR, user_id: ACTOR, organization_id: api.DEMO, status: 'ACTIVE', version: 3, member_type: 'STAFF',
    valid_from: null, valid_to: null, revoked_at: null, bindings: [{ id: ACTOR, role_id: ACTOR }], binding_scopes: [], overrides: [], override_scopes: [] };
  const writes = [];
  const management = { query: async sql => sql.startsWith('SELECT m.id') ? [structuredClone(current)] : [{ id: run.ownedAuthorizationScope.id }] };
  const adminTransport = {
    identity: async () => ({ actorId: admin, organizationId: api.DEMO, authenticated: true }),
    request: async (ctx, req) => {
      assert.equal(ctx.actorId, admin); assert.equal(ctx.organizationId, api.DEMO);
      assert.equal(req.args.p_membership, ACTOR); assert.equal(req.args.p_expected_version, current.version);
      assert.equal(req.args.p_role_bindings, null); writes.push(req.args);
      current.version++;
      current.overrides = req.args.p_overrides.map(override => ({ ...override, id: ACTOR, organization_id: api.DEMO,
        membership_id: ACTOR, created_by: admin, revoked_at: null }));
      current.override_scopes = current.overrides.map(override => ({ organization_id: api.DEMO, override_id: override.id, scope_id: override.scope_ids[0] }));
      return { status: 200, body: { membershipId: ACTOR, version: current.version } };
    },
  };
  await assert.rejects(withScopeRevocation(runner, management, adminTransport, admin, async () => {
    assert.equal(current.overrides[0].scope_mode, 'SCOPED');
    assert.equal(current.override_scopes[0].scope_id, run.ownedAuthorizationScope.id);
    current.bindings[0].role_id = admin;
  }), /membership_concurrent_change/);
  assert.equal(writes.length, 1);
  assert.equal(current.bindings[0].role_id, admin);
  assert.equal(run.scopeRevocation.state, 'active');
}));

test('unknown browser handle prevents fixture cleanup while disabled control remains a separate action', async () => fixture(async ({ runner, run, state }) => {
  run.browser = { state: 'intent' };
  await assert.rejects(runner.cleanupFixtures(), /unsettled_browser/);
  assert.equal(state.requests.length, 0);
}));

test('exclusive journal lease rejects a second operator and remains on unknown outcome', async () => fixture(async ({ runner, run, transport, journalPath }) => {
  await runner.acquireLease();
  const second = new api.RoomPassRun({ run, transport, journalPath });
  await assert.rejects(second.acquireLease(), /EEXIST/);
  run.operations.push({ state: 'unknown', id: ACTOR, name: 'create_building' });
  await runner.releaseLease();
  const lease = JSON.parse(await readFile(`${journalPath}.lock`, 'utf8'));
  assert.equal(lease.runId, run.runId);
}));

test('preparation persists assigned parent IDs and rejects non-DEMO scope without a request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'room-pass-test-'));
  try {
    const config = { organizationId: 'dddd0000-0000-4000-8000-000000000001', actorId: '11111111-1111-4111-8111-111111111111', journalPath: join(dir, 'run.json') };
    const run = await api.prepareRoomPassRun(config);
    const saved = JSON.parse(await readFile(config.journalPath, 'utf8'));
    assert.equal(saved.status, 'prepared');
    assert.match(saved.fixtures.building.id, /^[0-9a-f-]{36}$/);
    assert.equal(saved.fixtures.room.building_id, saved.fixtures.building.id);
    assert.equal(saved.fixtures.listing.id, null);
    assert.equal(run.actorId, config.actorId);
    await assert.rejects(api.prepareRoomPassRun({ ...config, organizationId: 'aaaa0000-0000-4000-8000-000000000001' }), /scope_invalid/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('flag read adapter is exact and read only when ordinary flag SELECT is unavailable', async () => fixture(async ({ run, runner, transport }) => {
  const queries = [];
  const flag = { scope: 'action', contract_id: api.ACTION, revision: 8 };
  const management = { query: async sql => { queries.push(sql); return [{ flag, globalRevision: 9 }]; } };
  transport.readFlag = context => readRoomPassFlag(management, context);
  transport.request = async () => { throw new Error('ordinary flag SELECT forbidden'); };
  assert.deepEqual(await runner.readFlag(), { flag, globalRevision: 9 });
  assert.match(queries[0], /WHERE f.scope='action' AND f.contract_id='room_pass.set_active'/);
  assert.doesNotMatch(queries[0], /INSERT|UPDATE|DELETE|GRANT/);
  await assert.rejects(readRoomPassFlag(management, { ...runner.context, organizationId: ACTOR }), /flag_read_scope_invalid/);
  assert.equal(queries.length, 1);
  transport.readFlag = async () => ({ flag: { ...flag, contract_id: 'other' }, globalRevision: 9 });
  await assert.rejects(runner.readFlag(), /flag_revision_invalid/);
  assert.equal(run.organizationId, api.DEMO);
}));

for (const state of ['shadow', 'enabled', 'disabled', 'rejected']) test('recovery reconciles post-CAS readback failure: ' + state, async () => fixture(async ({ run, runner, transport, journalPath }) => {
  let flag = { scope: 'action', contract_id: api.ACTION, state: 'disabled', canary_org: null, expires_at: null,
    revision: 8, updated_by: ACTOR, reason: 'initial', evidence_link: 'initial', rollback_reference: 'initial' };
  let failRead = false;
  const request = transport.request;
  transport.verifyTerminal = async () => true;
  transport.readFlag = async () => { if (failRead) { failRead = false; throw new Error('read_failed'); } return { flag: structuredClone(flag), globalRevision: flag.revision }; };
  transport.request = async (ctx, req) => {
    if (req.rpc !== 'set_copilot_feature_flag_v2') return request(ctx, req);
    if (state === 'rejected') return { status: 409, body: { message: 'copilot_rollout_stale_revision' } };
    flag = { ...flag, state: req.args.p_state, revision: flag.revision + 1, canary_org: req.args.p_canary_org,
      expires_at: req.args.p_expires_at, reason: req.args.p_reason, evidence_link: req.args.p_evidence_link, rollback_reference: req.args.p_rollback_reference };
    failRead = true;
    return { status: 200, body: structuredClone(flag) };
  };
  await runner.captureControl();
  if (state === 'enabled' || state === 'disabled') {
    flag = { ...flag, state: 'shadow', canary_org: api.DEMO, expires_at: new Date(Date.now() + 600000).toISOString() };
    run.controls.current = structuredClone(flag);
  }
  await assert.rejects(runner.transitionFlag(state === 'rejected' ? 'shadow' : state,
    state === 'disabled' ? null : new Date(Date.now() + 600000).toISOString()));
  const op = run.operations.at(-1);
  assert.equal(op.state, state === 'rejected' ? 'rejected' : 'acknowledged');
  const evidence = { ['operator:' + run.runId]: 'a'.repeat(64), [op.id]: 'b'.repeat(64) };
  await assert.rejects(recoverRoomPassRun({ run, journalPath, transport, terminalEvidence: { ['operator:' + run.runId]: 'a'.repeat(64) } }), /terminal_evidence_required/);
  // Subsequent disable has a successful readback; only the original CAS loses it.
  const originalRequest = transport.request;
  transport.request = async (ctx, req) => { const result = await originalRequest(ctx, req); failRead = false; return result; };
  const committed = structuredClone(flag);
  flag = { ...flag, revision: flag.revision + 1, reason: 'concurrent operator' };
  await assert.rejects(recoverRoomPassRun({ run, journalPath, transport, terminalEvidence: evidence }), /control_recovery_ownership_invalid/);
  assert.ok(run.controls.pending);
  flag = committed;
  const result = await recoverRoomPassRun({ run, journalPath, transport, terminalEvidence: evidence });
  assert.equal(result.controlsRestored, true); assert.equal(flag.state, 'disabled');
  assert.equal(run.controls.pending, undefined);
  assert.equal(op.state, state === 'rejected' ? 'reconciled_absent' : 'reconciled_committed');
}));

async function browserGuardModule() {
  const { transpileModule, ModuleKind, ScriptTarget } = await import('typescript');
  const source = await readFile(new URL('../../.e2e-fleet/specs/copilotRoomPassGuard.ts', import.meta.url), 'utf8');
  const { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } });
  return import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
}
test('browser guard delegates reads, owns chat and denies every unexpected business mutation', async () => {
  const { createRoomPassBrowserGuard } = await browserGuardModule();
  const listingId = '22222222-2222-4222-8222-222222222222';
  const guard = createRoomPassBrowserGuard({ actorId: ACTOR, listingId, organizationId: api.DEMO });
  const request = (path, method = 'POST', body = {}) => ({ url: () => 'https://fixture.invalid/rest/v1/' + path, method: () => method, postDataJSON: () => body });
  const dispatch = async req => { const calls = []; await guard.route({ request: () => req, fallback: async () => calls.push('fallback'), abort: async () => calls.push('abort') }); return calls; };
  assert.deepEqual(await dispatch(request('profiles?select=ui_preferences', 'GET')), ['fallback']);
  const preview = { p_organization_id: api.DEMO, p_payload: { listing_id: listingId, active: true } };
  assert.deepEqual(await dispatch(request('rpc/copilot_preview_room_pass_active_v1', 'POST', preview)), ['fallback']);
  assert.deepEqual(await dispatch(request('rpc/copilot_preview_room_pass_active_v1', 'POST', { ...preview, p_organization_id: ACTOR })), ['abort']);
  assert.deepEqual(await dispatch(request('rpc/get_my_copilot_availability_v1', 'POST', { p_organization_id: api.DEMO })), ['fallback']);
  assert.deepEqual(await dispatch(request('rpc/get_my_copilot_availability_v1', 'POST', { p_organization_id: ACTOR })), ['abort']);
  for (const path of ['income_expenses','ai_write_audit','rpc/ie_compat_insert_v2','rpc/create_income_expense_v1','rpc/copilot_execute_income_expense_v1','rpc/unknown_future_write']) {
    assert.deepEqual(await dispatch(request(path, 'POST', { organization_id: ACTOR })), ['abort']);
  }
  assert.deepEqual(await dispatch(request('ai_chat_messages', 'POST', [{ user_id: ACTOR, organization_id: api.DEMO, thread_id: ACTOR }])), ['abort']);
  const chat = request('ai_chat_threads', 'POST', { user_id: ACTOR, organization_id: api.DEMO, title: 'owned' });
  assert.deepEqual(await dispatch(chat), ['fallback']);
  guard.observeThread(chat, { id: ACTOR });
  assert.deepEqual(await dispatch(request('ai_chat_messages', 'POST', [{ user_id: ACTOR, organization_id: api.DEMO, thread_id: ACTOR, role: 'user', content: 'fixture' }])), ['fallback']);
  assert.deepEqual(await dispatch(request('ai_chat_threads', 'PATCH', { organization_id: api.DEMO })), ['abort']);
  assert.deepEqual(await dispatch(request('ai_chat_threads', 'POST', { user_id: ACTOR, organization_id: ACTOR })), ['abort']);
  const canonical = { organization_id: api.DEMO, listing_id: listingId, active: true };
  guard.setProposal({ canonical, nonce: 'a'.repeat(64) });
  const execute = request('rpc/copilot_execute_room_pass_active_v1', 'POST', { p_payload: canonical, p_confirmation_nonce: 'a'.repeat(64) });
  assert.deepEqual(await dispatch(execute), ['abort']); guard.click();
  assert.deepEqual(await dispatch(execute), ['fallback']);
  assert.deepEqual(await dispatch(execute), ['abort']);
  assert.equal(guard.counters().acceptedExecutions, 1);
  assert.ok(guard.counters().illegalWrites >= 10);
});
