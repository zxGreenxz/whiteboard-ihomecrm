import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setupFollow, u, USER, ORG, FOREIGN, ASSIGNEE, BUILDING, SESSION } from './task-follow-fixture.mjs';
import { ASSISTANT } from '../hermes-zalo-router/private-command-fixture.mjs';
import { createTaskAuth, createTaskReads } from './task-adapter.mjs';
import { createTaskServiceWithOptions } from './task-input-adapter.mjs';
import { createBroker } from './broker.mjs';
import { createMcpHttpServer } from './mcp-http.mjs';
import { createDurableAuthority } from './durable-authority.mjs';
import { createDurableConnectionStore } from './durable-connection-store.mjs';
import { createSessionCrypto } from './session-crypto.mjs';
import { createDependencyScope } from './dependency-scope.mjs';

const forward = readFileSync('supabase/migrations/20261014000503_hermes_optional_org_policy_v1.sql', 'utf8');
const extract = name => forward.match(new RegExp('CREATE OR REPLACE FUNCTION ' + name.replaceAll('.', '\\.') + '[\\s\\S]*?\\$(?:fn)?\\$;'))[0];
const token = 'hc_' + 'F'.repeat(43), digest = createHash('sha256').update(token).digest('hex');
const SQL = Object.freeze({
  '/rest/v1/rpc/hermes_task_create_capabilities_v1': ['SELECT public.hermes_task_create_capabilities_v1($1::uuid) result', a => [a.p_organization_id]],
  '/rest/v1/rpc/hermes_task_follow_capabilities_v1': ['SELECT public.hermes_task_follow_capabilities_v1($1::uuid) result', a => [a.p_organization_id]],
  '/rest/v1/rpc/hermes_task_follow_read_v1': ['SELECT public.hermes_task_follow_read_v1($1::jsonb,$2::jsonb) result', a => [JSON.stringify(a.p_binding), JSON.stringify(a.p_input)]],
  '/rest/v1/rpc/hermes_task_follow_action_v1': ['SELECT public.hermes_task_follow_action_v1($1::jsonb,$2::text,$3::jsonb) result',
    a => [JSON.stringify(a.p_binding), a.p_operation, JSON.stringify(a.p_input)]],
});

test('external MCP → bound JWT → audited final caller SQL: follow, list, cancel and lost-ACK reconciliation', { timeout: 90000 }, async t => {
  const { db, call, job } = await setupFollow(t);
  await db.exec(extract('app_private.hermes_store_read_connection_v1'));
  await db.query("UPDATE app_private.hermes_connection_tokens SET token_digest=$1 WHERE token_digest=repeat('b',64)", [digest]);
  const expiresAt = (Math.floor(Date.now() / 1000) + 3600) * 1000;
  const accessToken = ['header', Buffer.from(JSON.stringify({ role: 'authenticated', sub: USER, session_id: SESSION, exp: expiresAt / 1000 })).toString('base64url'), 'signature'].join('.');
  const crypto = createSessionCrypto({ activeKeyVersion: 'test', keys: new Map([['test', randomBytes(32)]]) }); t.after(() => crypto.destroy());
  const envelope = crypto.seal({ accessToken, refreshToken: 'SYNTHETIC_REFRESH', expiresAt }, { assistantId: ASSISTANT, userId: USER, organizationId: ORG, sessionId: SESSION });
  await db.query('UPDATE app_private.hermes_sessions SET envelope=$1::jsonb,expires_at=to_timestamp($2/1000.0) WHERE id=$3', [JSON.stringify(envelope), expiresAt, SESSION]);
  const dependencyScope = createDependencyScope(); t.after(() => dependencyScope.close());
  const events = [], listInputs = []; let loseAck = false, beforeFinal, storeReads = 0, verifies = 0;
  const transport = async (url, options) => {
    assert.equal(options.headers.authorization, 'Bearer ' + accessToken);
    const path = new URL(url).pathname, args = JSON.parse(options.body), entry = SQL[path];
    assert.ok(entry, `unexpected RPC ${path}`);
    events.push(path.split('/').at(-1) + (args.p_operation ? ':' + args.p_operation : ''));
    if (path.endsWith('/hermes_task_follow_read_v1')) listInputs.push(args.p_input);
    if (args.p_binding && beforeFinal) { const hook = beforeFinal; beforeFinal = undefined; await hook(); }
    try {
      const result = await call(entry[0], entry[1](args));
      if (loseAck && args.p_operation) { loseAck = false; throw new Error('synthetic_ack_lost'); }
      return Response.json(result);
    } catch (error) {
      if (!error.code) throw error;
      return Response.json({ code: error.code, message: error.message, details: null, hint: null }, { status: error.code === '42501' ? 403 : error.code === 'PT409' ? 409 : 400 });
    }
  };
  const supabase = { url: 'https://example.invalid/', publishableKey: 'sb_publishable_test' };
  // Base CRM resolver port: tasks.view is what the domain adapter contributes in
  // production; create/edit/delete come from the real capability RPCs above.
  const baseAuth = { async verifySession() { verifies += 1; return { userId: USER, sessionId: SESSION, expiresAt }; }, async readAuthorization() { return {
    userId: USER, isSuperadmin: false, activeOrganizationIds: [ORG], epoch: 'base',
    membership: { organizationId: ORG, status: 'ACTIVE', revokedAt: null, validFrom: null, validTo: null, membershipId: USER, authorizationVersion: 1 },
    permissions: { read: ['tasks.view'], action: [] }, companyCeilings: { read: ['tasks.view'], action: [] },
    scopesByPermission: { 'tasks.view': { buildingIds: [BUILDING], cashbookIds: [] } } }; } };
  const auth = createTaskAuth({ baseAuth, reads: createTaskReads({ ...supabase, fetch: transport, dependencyScope }) });
  const connectionStore = createDurableConnectionStore({ transport: { async call(operation, payload) {
    assert.equal(operation, 'readConnection'); storeReads += 1;
    await db.exec('BEGIN;SET LOCAL ROLE hermes_store_executor'); await db.query("SELECT set_config('request.jwt.claim.role','hermes_store_executor',true)");
    try { const value = (await db.query('SELECT app_private.hermes_store_read_connection_v1($1::jsonb) result', [JSON.stringify(payload)])).rows[0].result; await db.exec('COMMIT'); return value; }
    catch (error) { await db.exec('ROLLBACK'); throw error; } finally { await db.exec('RESET ROLE'); } } } });
  const authority = createDurableAuthority({ connectionStore, crypto, auth });
  const tasks = createTaskServiceWithOptions({ authority, connectionStore, crypto, auth, supabase, dependencyScope, fetch: transport });
  let afterAudit;
  const broker = createBroker({ authority, tasks, dependencyScope, audit: async entry => {
    events.push(`audit:${entry.outcome}`); if (afterAudit && entry.outcome === 'prepared') { const hook = afterAudit; afterAudit = undefined; await hook(); } } });
  const server = createMcpHttpServer({ broker, allowedHosts: ['127.0.0.1'], allowedOrigins: [] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  let id = 0;
  const mcp = async (name, args = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
    assert.equal(response.status, 200); const message = await response.json();
    return { isError: message.result.isError, value: JSON.parse(message.result.content[0].text) };
  };

  const names = (await broker.listTools(token)).tools.map(tool => tool.name).sort();
  assert.deepEqual(names, ['crm_new_request_id', 'crm_task_cancel', 'crm_task_create', 'crm_task_follow_list', 'crm_task_follow_set', 'crm_task_follow_stop',
    'crm_task_input_options', 'crm_task_progress', 'crm_task_status']);
  const J1 = await job({ title: 'Sơn lại cửa', deadline: new Date(Date.now() + 7200_000).toISOString() });
  const set = await mcp('crm_task_follow_set', { organizationId: ORG, requestId: u(1), jobId: J1, objective: 'Báo tôi khi xong', remindBeforeMinutes: 30 });
  assert.equal(set.value.outcome, 'applied'); assert.equal(set.value.follow.assignerUserId, USER); assert.equal(set.value.follow.executorUserId, ASSIGNEE);
  assert.ok(events.indexOf('audit:prepared') < events.indexOf('hermes_task_follow_action_v1:set'));
  const listed = await mcp('crm_task_follow_list', { organizationId: ORG, role: 'assigned_by_me' });
  assert.deepEqual(listed.value.items.map(item => item.id), [J1]); assert.equal(listed.value.items[0].follows[0].objective, 'Báo tôi khi xong');
  for (const extra of [{ userId: ASSIGNEE }, { actorId: ASSIGNEE }, { rpc: 'hermes_task_follow_action_v1' }])
    assert.equal((await mcp('crm_task_follow_list', { organizationId: ORG, role: 'team', ...extra })).value.error, 'invalid_request');
  // 16/10 20:44Z production: exact shape that was rejected three times (a real user id with assigned_by_me).
  listInputs.length = 0;
  const incident = await mcp('crm_task_follow_list', { organizationId: ORG, role: 'assigned_by_me', assigneeUserId: ASSIGNEE, status: 'open', limit: 20, offset: 0 });
  assert.equal(incident.isError, false); assert.deepEqual(incident.value.items.map(item => item.id), [J1]);
  assert.deepEqual(listInputs, [{ organizationId: ORG, role: 'assigned_by_me', assigneeUserId: null, status: 'open', limit: 20, offset: 0 }]);
  listInputs.length = 0;
  for (const assigneeUserId of [7, {}, [ASSIGNEE], true])
    assert.equal((await mcp('crm_task_follow_list', { organizationId: ORG, role: 'assigned_by_me', assigneeUserId })).value.error, 'invalid_request');
  assert.deepEqual(listInputs, [], 'non-string assigneeUserId never reaches SQL');
  const listedTool = (await broker.listTools(token)).tools.find(tool => tool.name === 'crm_task_follow_list');
  assert.equal(listedTool.inputSchema.properties.assigneeUserId.description, 'Chỉ dùng với role=team; khác thì bỏ qua.');

  // B5b (20/10/2026 production trace): the model no longer names the company. Without organizationId the
  // SQL input still carries the connection's company (no crm_auth_context round trip, no extra Auth/SQL read:
  // the broker's handed authority result serves the adapter and the operation service alike).
  const cost = async (name, args) => { const reads = storeReads, checks = verifies; const result = await mcp(name, args); return { result, reads: storeReads - reads, checks: verifies - checks }; };
  const restated = await cost('crm_task_follow_list', { organizationId: ORG, role: 'assigned_by_me' });
  listInputs.length = 0;
  const bare = await cost('crm_task_follow_list', { role: 'assigned_by_me' });
  assert.equal(bare.result.isError, false); assert.deepEqual(bare.result.value.items.map(item => item.id), [J1]); assert.equal(bare.result.value.organizationId, ORG);
  assert.deepEqual(listInputs, [{ organizationId: ORG, role: 'assigned_by_me', assigneeUserId: null, status: 'open', limit: 20, offset: 0 }]);
  assert.ok(restated.reads > 0 && restated.checks > 0);
  assert.deepEqual([bare.reads, bare.checks], [restated.reads, restated.checks], 'binding the company adds no connection read or Auth check');
  // A model that still names the company must restate it; another company is refused before any RPC.
  listInputs.length = 0;
  const reads = events.filter(event => event === 'hermes_task_follow_read_v1').length;
  const foreign = await mcp('crm_task_follow_list', { organizationId: FOREIGN, role: 'assigned_by_me' });
  assert.equal(foreign.value.error, 'forbidden'); assert.deepEqual(listInputs, []);
  assert.equal(events.filter(event => event === 'hermes_task_follow_read_v1').length, reads, 'no SQL for another company');
  assert.equal((await mcp('crm_task_follow_list', { organizationId: 'công ty', role: 'assigned_by_me' })).value.error, 'invalid_request');
  // A write without the company: the same bound input reaches the action RPC and the echo names the connection's company.
  const progressed = await mcp('crm_task_progress', { requestId: u(4), jobId: J1, note: 'Đã sơn lớp lót', expectedNoteDigest: createHash('md5').update('').digest('hex') });
  assert.equal(progressed.isError, false); assert.equal(progressed.value.outcome, 'applied'); assert.equal(progressed.value.organizationId, ORG); assert.equal(progressed.value.job.id, J1);
  assert.equal((await mcp('crm_task_follow_list', { role: 'assigned_by_me' })).value.items[0].progressNote, 'Đã sơn lớp lót');
  for (const tool of (await broker.listTools(token)).tools.filter(value => value.name.startsWith('crm_task_follow_') || ['crm_task_progress', 'crm_task_cancel'].includes(value.name))) {
    assert.equal(Object.hasOwn(tool.inputSchema.properties, 'organizationId'), false, tool.name);
    assert.equal(tool.inputSchema.required.includes('organizationId'), false, tool.name);
  }
  assert.deepEqual(listedTool.inputSchema.required, ['role']);

  // Lost ACK on a dispatched cancel: the broker reports unknown with the
  // requestId; calling again with the same requestId reconciles, never redoes.
  loseAck = true;
  const cancelInput = { organizationId: ORG, requestId: u(2), jobId: J1, reason: 'Khách huỷ yêu cầu' };
  const unknown = await mcp('crm_task_cancel', cancelInput);
  assert.deepEqual(unknown.value, { error: 'task_outcome_unknown', requestId: u(2) });
  const reconciled = await mcp('crm_task_cancel', cancelInput);
  assert.equal(reconciled.value.outcome, 'applied'); assert.equal(reconciled.value.job.status, 'DELETED'); assert.equal(reconciled.value.closedFollows, 1);
  assert.equal(events.filter(event => event === 'hermes_task_follow_action_v1:cancel').length, 2);
  assert.equal((await db.query("SELECT count(*)::int n FROM public.authorization_audit_events WHERE event_type='HERMES_TASK_CANCELLED'")).rows[0].n, 1);

  // Revocation between audit and final SQL denies; nothing is written.
  const J2 = await job({ deadline: new Date(Date.now() + 7200_000).toISOString() });
  afterAudit = () => db.exec(`DELETE FROM public.fixture_perm WHERE user_id='${USER}' AND permission='tasks.create'`);
  const denied = await mcp('crm_task_follow_set', { organizationId: ORG, requestId: u(3), jobId: J2, objective: 'Theo dõi' });
  assert.ok(['context_changed', 'forbidden'].includes(denied.value.error));
  assert.equal((await db.query('SELECT count(*)::int n FROM app_private.hermes_task_follows WHERE job_id=$1', [J2])).rows[0].n, 0);
  assert.equal(JSON.stringify(unknown).includes(accessToken), false);
});
