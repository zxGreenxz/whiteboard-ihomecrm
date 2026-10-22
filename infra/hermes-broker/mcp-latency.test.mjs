import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createHermesBackend } from './server.mjs';
import { createSessionCrypto } from './session-crypto.mjs';
import { DOMAIN_READ_CAPABILITIES } from './domain-contract.mjs';

// Local latency model for the real composed connector: every SQL statement is
// one pooler round trip, a cold pool connection pays TCP+TLS+SCRAM, Supabase
// Auth is slower than PostgREST. Numbers are synthetic, not a VPS measurement.
// roomSnapshot: extra server time of the whole-company hermes_sale_listing_rooms_v1
// read (an assumption; production compute time was not measured separately).
const LATENCY = Object.freeze({ connect: 250, db: 60, auth: 150, rest: 60, roomSnapshot: 400, audit: 5 });
const HOST = 'connector.example:8443', NOW = 1_800_000_000_000;
const id = n => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const I = { org: id(1), user: id(2), session: id(3), assistant: id(4), connection: id(5), member: id(6), credential: id(7), building: id(8), item: id(9),
  scope: id(10), room: id(11) };
const TOKEN = `hc_${'L'.repeat(43)}`, DIGEST = createHash('sha256').update(TOKEN).digest('hex');
const SESSION_EXPIRES = NOW + 3_600_000;
const accessToken = `header.${Buffer.from(JSON.stringify({ sub: I.user, role: 'authenticated', session_id: I.session, exp: SESSION_EXPIRES / 1000 })).toString('base64url')}.signature`;
const READS = ['assistant.context.read', 'customers.view', 'rooms.view'];
// Every optional capability family of the production auth chain that is not
// granted here answers PGRST202, exactly like an absent SQL family.
const optional = ['hermes_group_action_context_v1', 'hermes_work_memory_capabilities_v1', 'hermes_room_schedule_capabilities_v1',
  'hermes_room_pass_capabilities_v1', 'hermes_task_create_capabilities_v1', 'hermes_task_follow_capabilities_v1',
  // Đợt 2 Thu chi: phiếu chi đi danh mục thao tác chung (hermes_action_capabilities_v1); họ crm_expense_* cũ đã gỡ.
  'hermes_customer_create_capabilities_v1', 'hermes_action_capabilities_v1', 'hermes_domain_capabilities_v2', 'hermes_domain_capabilities_v3',
  // B5d: crm_auth_context directory (company name, buildings) — absent SQL degrades to null, one extra store read and one REST wave.
  'hermes_organization_name_v1', 'hermes_building_directory_v1',
  // R2c part 2 (c): the asker's display name, same optional degradation.
  'hermes_user_display_name_v1',
  // Đợt 2b: danh mục production có task.create ⇒ lớp thao tác ghi dùng chung đọc capability của nó (vắng ⇒ không cấp khoá).
  'hermes_action_capabilities_v1'].map(name => `/rest/v1/rpc/${name}`);
const principal = { role: 'hermes_store_test', session_role: 'hermes_store_test', scoped: true, privileged_member: false,
  rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false };

function connector({ latency = LATENCY, onAudit = () => {}, limits } = {}) {
  const events = [], key = randomBytes(32), binding = { assistantId: I.assistant, userId: I.user, organizationId: I.org, sessionId: I.session };
  const state = { revoked: false, authorizationVersion: 1 };
  const sealer = createSessionCrypto({ activeKeyVersion: 'k1', keys: new Map([['k1', key]]) });
  const envelope = sealer.seal({ accessToken, refreshToken: 'SYNTHETIC-REFRESH', expiresAt: SESSION_EXPIRES }, binding);
  sealer.destroy();
  const joined = { status: 'active', connection: { id: I.connection, assistantId: I.assistant, organizationId: I.org, userId: I.user,
    state: 'active', epoch: 2, restrictions: { read: [...READS], action: [] }, scopeIds: [I.scope], tokenDigest: DIGEST,
    credentialRef: I.credential, expiresAt: NOW + 600_000 },
  session: { credentialRef: I.credential, revision: 1, envelope, expiresAt: SESSION_EXPIRES, binding },
  membership: { membershipId: I.member, authorizationVersion: 1, isSuperadmin: false }, policy: { version: 1, read: [...READS], action: [], scopeIds: [I.scope] } };
  const wait = async (kind, ms) => {
    const start = performance.now(); await new Promise(done => setTimeout(done, ms));
    events.push({ kind, start, end: performance.now() });
  };
  const idle = []; let opened = 0;
  const client = () => {
    const self = { async query(statement) {
      await wait('db', latency.db);
      if (/pg_catalog\.pg_roles/.test(statement.text)) return { rows: [principal] };
      const operation = /^SELECT app_private\.hermes_store_(\w+)_v1\(\$1::jsonb\) AS result$/.exec(statement.text)?.[1];
      assert.equal(operation, 'read_connection', 'MCP reads only the joined connection');
      return { rows: [{ result: state.revoked ? { status: 'unavailable' } : structuredClone(joined) }] };
    }, release(destroy) { if (!destroy) idle.push(self); } };
    return self;
  };
  const pool = { async connect() {
    const reused = idle.pop(); if (reused) return reused;
    opened++; await wait('connect', latency.connect); return client();
  }, async end() {} };
  const fetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === '/auth/v1/user') { await wait('auth', latency.auth); return Response.json({ id: I.user }); }
    await wait('rest', latency.rest + (path === '/rest/v1/rpc/hermes_sale_listing_rooms_v1' ? latency.roomSnapshot : 0));
    if (optional.includes(path)) return Response.json({ code: 'PGRST202', message: 'absent', details: null, hint: null }, { status: 404 });
    if (path === '/rest/v1/rpc/get_authorization_context_v1') return Response.json({ organizationId: I.org, membershipId: I.member,
      authorizationVersion: state.authorizationVersion, isPlatformAdmin: false, isOffboarded: false, permissions: { 'rooms.view': true } });
    if (path === '/rest/v1/rpc/hermes_room_scope_map_v1') {
      const args = JSON.parse(options.body);
      return Response.json({ organizationId: I.org, complete: true,
        scopes: [{ id: I.scope, scopeType: 'BUILDING', buildingId: I.building, areaId: null, cashbookId: null }], areaBuildings: [],
        permissionBuildingIds: [I.building], binding: { connectionId: I.connection, epoch: args.p_expected_epoch, policyVersion: args.p_expected_policy_version,
          membershipId: I.member, authorizationVersion: args.p_expected_authorization_version, sessionRevision: args.p_expected_session_revision } });
    }
    if (path === '/rest/v1/rpc/hermes_sale_listing_rooms_v1') return Response.json({ pages: 1, buildings: [{ id: I.building, name: 'House A', code: 'A' }],
      rooms: [{ id: I.room, building_id: I.building, code: '101', name: '101', floor: 1, area: 20, rent_price: 3000000, deposit_amount: 3000000,
        status_public: 'free', sale_state: null, sale_today: '2026-10-15', avail_date: null, expected_ready_on: null }] });
    if (path === '/rest/v1/rpc/get_my_organizations') return Response.json({ user_id: I.user, organizations: [{ id: I.org }] });
    if (path === '/rest/v1/rpc/hermes_scope_buildings_v1') return Response.json([I.building]);
    if (path === '/rest/v1/rpc/hermes_domain_capabilities_v1') return Response.json({ organizationId: I.org, userId: I.user,
      membershipId: I.member, authorizationVersion: state.authorizationVersion, isSuperadmin: false, policyVersion: 1,
      permissions: Object.fromEntries(DOMAIN_READ_CAPABILITIES.map(name => [name, name === 'customers.view'
        ? { allowed: true, companyEnabled: true, buildingIds: [I.building] } : { allowed: false, companyEnabled: false, buildingIds: [] }])) });
    // crm_read_customers reads through the v3 full-read family (16/10): full phone for the private reply.
    if (path === '/rest/v1/rpc/hermes_domain_read_v3') {
      const args = JSON.parse(options.body);
      assert.equal(args.p_domain, 'customers'); assert.equal(args.p_binding.tokenDigest, DIGEST);
      // summary is required since the R2a release window closed (R2c connector).
      return Response.json({ organizationId: I.org, domain: 'customers', summary: { count: 1, byStatus: {}, sum: {} }, nextCursor: null, fetchedAt: '2026-10-16T00:00:00.000Z', items: [{ id: I.item,
        name: 'Synthetic resident', phone: '0900000567', contractId: I.item, buildingId: I.building, buildingName: 'Toà mẫu', roomId: I.item, roomName: '101' }] });
    }
    assert.fail(`unexpected ${path}`);
  };
  const backend = createHermesBackend({ supabase: { url: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture' },
    store: { pool, expectedRole: 'hermes_store_test' }, encryption: { activeKeyVersion: 'k1', keys: new Map([['k1', key]]) },
    http: { allowedHosts: [HOST], allowedOrigins: [] }, fetch, clock: () => NOW, connectorOnly: true, ...(limits ? { limits } : {}),
    audit: async event => { await wait('audit', latency.audit); onAudit(event, state); } });
  return { backend, events, state, opened: () => opened };
}
const FAST = Object.freeze({ connect: 1, db: 1, auth: 1, rest: 1, audit: 1 });
async function started(t, options) {
  const f = connector(options);
  await new Promise(done => f.backend.server.listen(0, '127.0.0.1', done));
  t.after(() => f.backend.close());
  return f;
}
const customers = f => measure(f.backend, f.events, 'tools/call', { name: 'crm_read_customers', arguments: { query: '' } });

// Number of non-overlapping waves: concurrent calls count once, a dependent
// call that starts after the previous one finished counts again.
function waves(events, kinds) {
  const spans = events.filter(event => kinds.includes(event.kind)).sort((a, b) => a.start - b.start);
  let count = 0, end = -Infinity;
  for (const span of spans) { if (span.start >= end - 1) count++; end = Math.max(end, span.end); }
  return count;
}
async function measure(backend, events, method, params) {
  const port = backend.server.address().port, first = events.length, started = performance.now();
  const response = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 7, method, params });
    const request = httpRequest({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { host: HOST,
      authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); request.on('error', reject); request.end(body);
  });
  const elapsedMs = Math.round(performance.now() - started), slice = events.slice(first);
  const count = kinds => slice.filter(event => kinds.includes(event.kind)).length;
  return { response, stats: { elapsedMs, sqlStatements: count(['db']), poolConnects: count(['connect']), authCalls: count(['auth']),
    restCalls: count(['rest']), sequentialDb: waves(slice, ['db', 'connect']), sequentialHttp: waves(slice, ['auth', 'rest']),
    sequentialNetwork: waves(slice, ['db', 'connect', 'auth', 'rest']) } };
}

// Baseline before P9 (same model and file, main 35cdde32): crm_available_rooms
// 72 sequential network steps / 20 SQL / 5 Auth + 51 PostgREST, about 5.8 s;
// crm_read_customers 70 steps, about 5.4 s; tools/list 34 steps, about 2.5 s.
// Production at higher real latency timed out the room tool at 10 s.
test('one CRM tools/call through the real connector stays within a bounded number of sequential round trips', async t => {
  const f = await started(t);
  const cold = await customers(f), warm = await customers(f);
  const context = await measure(f.backend, f.events, 'tools/call', { name: 'crm_auth_context', arguments: {} });
  const rooms = await measure(f.backend, f.events, 'tools/call', { name: 'crm_available_rooms', arguments: {} });
  const listed = await measure(f.backend, f.events, 'tools/list');
  const outcome = value => value.response.status !== 200 ? value.response.body.error : value.response.body.result.isError ? value.response.body.result.content[0].text : 'ok';
  t.diagnostic(`latency model ${JSON.stringify(LATENCY)}`);
  for (const [label, value] of [['crm_read_customers cold', cold], ['crm_read_customers warm', warm], ['crm_auth_context warm', context],
    ['crm_available_rooms warm', rooms], ['tools/list warm', listed]]) t.diagnostic(`${label} ${outcome(value)} ${JSON.stringify(value.stats)}`);
  for (const value of [cold, warm, context, rooms]) { assert.equal(value.response.status, 200); assert.equal(value.response.body.result.isError, false); }
  assert.equal(listed.response.status, 200);
  assert.equal(JSON.parse(cold.response.body.result.content[0].text).items.length, 1);
  assert.equal(JSON.parse(rooms.response.body.result.content[0].text).rooms.length, 1);
  // Room discovery keeps its reviewed order: bound scope map, then the snapshot.
  assert.ok(rooms.stats.sequentialNetwork <= 7 && rooms.stats.elapsedMs < 2500, JSON.stringify(rooms.stats));
  assert.equal(rooms.stats.sqlStatements, 3); assert.equal(rooms.stats.authCalls, 2);
  // One full admission plus initial scope map + room snapshot. Thu chi (#271) gỡ capability của họ phiếu chi cũ (−1); Công việc (Đợt 2b):
  // SQL ở đây chưa có task.create (capability khung chung vắng) ⇒ lớp task đọc thêm capability tạo việc cũ CÙNG ĐỢT (+1,
  // sequentialNetwork không đổi); DB có dòng task.create thì bỏ lời gọi này (task-actions.test.mjs đếm).
  assert.equal(rooms.stats.restCalls, 16);
  assert.ok(listed.stats.sequentialNetwork <= 6, JSON.stringify(listed.stats));
  // A warm pool reuses its verified session: no reconnect and no per-call principal query.
  assert.equal(cold.stats.poolConnects, 1); assert.equal(warm.stats.poolConnects, 0); assert.equal(f.opened(), 1);
  assert.ok(warm.stats.sqlStatements <= 5, 'identify + opening/closing reads + prepare read + final-check reads');
  assert.ok(warm.stats.authCalls <= 3, 'admission, prepare and the post-audit check each verify the session once');
  assert.ok(warm.stats.sequentialHttp <= 4 && warm.stats.sequentialNetwork <= 10);
  // B5d (21/10): crm_auth_context also reads the company name and the buildings in scope — one store read for the
  // asker JWT before the audit and one REST wave (two RPCs in parallel) after it: 6 → 8 sequential steps, no more.
  // R2c part 2 (c): the display name joins that same wave (three RPCs in parallel): one more call, no extra step.
  assert.ok(context.stats.sequentialNetwork <= 8, JSON.stringify(context.stats));
  // Hai lần đọc quyền ở đây: Thu chi (#271) bớt capability phiếu chi cũ (−2), Công việc thêm capability tạo việc cũ cùng đợt khi SQL
  // chưa có task.create (+2) ⇒ vẫn 31, không thêm bước.
  assert.equal(context.stats.sequentialHttp, 3); assert.equal(context.stats.restCalls, 31);
  assert.ok(warm.stats.elapsedMs < 2000, `warm call took ${warm.stats.elapsedMs} ms`);
});

test('revocation is effective for the very next call; no authority survives between requests', async t => {
  const f = await started(t, { latency: FAST });
  assert.equal((await customers(f)).response.status, 200);
  f.state.revoked = true;
  const denied = await customers(f);
  assert.equal(denied.response.status, 401); assert.equal(denied.response.body.error, 'unauthorized');
  f.state.revoked = false;
  assert.equal((await customers(f)).response.status, 200);
});

test('revocation or a CRM authorization change during a call is caught after the audit checkpoint', async t => {
  for (const change of [state => { state.revoked = true; }, state => { state.authorizationVersion = 2; }]) {
    let armed = true;
    const f = await started(t, { latency: FAST, onAudit(event, state) {
      if (armed && event.outcome === 'prepared') { armed = false; change(state); }
    } });
    const { response } = await customers(f);
    // Reusing the admission result after the audit would wrongly return data here.
    assert.notEqual(response.status === 200 && response.body.result?.isError === false, true, JSON.stringify(response.body));
    assert(!JSON.stringify(response.body).includes('Synthetic resident'));
  }
});

test('direct room reads complete after audit-time revocation without repeated authority work; next request is denied', async t => {
  const f = await started(t, { latency: FAST, onAudit(event, state) { if (event.outcome === 'prepared') state.revoked = true; } });
  const { response, stats } = await measure(f.backend, f.events, 'tools/call', { name: 'crm_available_rooms', arguments: {} });
  assert.equal(response.status, 200); assert.equal(response.body.result.isError, false);
  assert.equal(JSON.parse(response.body.result.content[0].text).rooms.length, 1);
  assert.equal(stats.sqlStatements, 4); assert.equal(stats.poolConnects, 1); // Cold pool also verifies its principal once.
  assert.equal(stats.authCalls, 2); assert.equal(stats.restCalls, 16); // như trên: −1 Thu chi, +1 Công việc (DB chưa có task.create)
  const denied = await measure(f.backend, f.events, 'tools/call', { name: 'crm_available_rooms', arguments: {} });
  assert.equal(denied.response.status, 401); assert.equal(denied.stats.restCalls + denied.stats.authCalls, 0);
});

test('tools/call has its own sliding-window rate limit with a model-readable retry hint', async t => {
  const f = await started(t, { latency: FAST, limits: { requestsPerMinute: 10, toolCallsPerMinute: 2, callTimeoutMs: 10_000, maintenanceWaitMs: 0 } });
  for (let i = 0; i < 2; i++) assert.equal((await customers(f)).response.body.result.isError, false);
  const limited = await customers(f);
  assert.equal(limited.response.status, 200); assert.equal(limited.response.body.result.isError, true);
  const payload = JSON.parse(limited.response.body.result.content[0].text);
  assert.equal(payload.error, 'rate_limited'); assert.ok(payload.retryAfterSeconds >= 1 && payload.retryAfterSeconds <= 60);
  assert.equal(limited.stats.restCalls + limited.stats.authCalls, 0, 'a limited call does no Auth/CRM work');
  // Other MCP methods are still admitted by the separate request budget.
  const listed = await measure(f.backend, f.events, 'tools/list');
  assert.equal(listed.response.status, 200);
  assert.ok(listed.response.body.result.tools.some(tool => tool.name === 'crm_read_customers'));
});
