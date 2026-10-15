import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BrokerError, createBroker } from './broker.mjs';
import { createMcpHttpServer } from './mcp-http.mjs';
import { createDurableAuthority } from './durable-authority.mjs';
import { createDurableConnectionStore } from './durable-connection-store.mjs';
import { createSessionCrypto } from './session-crypto.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
import { NEW_REQUEST_ID_TOOL, REQUEST_ID_GUIDANCE, REQUEST_ID_PROPERTY, REQUEST_ID_STATUS_GUIDANCE, startsCrmRequest } from './request-id-contract.mjs';
import { TASK_TOOLS, taskInput } from './task-contract.mjs';
import { TASK_INPUT_TOOLS } from './task-input-contract.mjs';
import { ROOM_PASS_TOOLS } from './room-pass-contract.mjs';
import { CUSTOMER_ACTION_TOOLS, customerActionInput } from './customer-action-contract.mjs';
import { EXPENSE_ACTION_TOOLS } from './expense-action-contract.mjs';
import { DOMAIN_TOOLS } from './domain-contract.mjs';
import { SCHEDULE_TOOLS } from './schedule-contract.mjs';
import { WORK_MEMORY_TOOLS } from './work-memory-contract.mjs';
import { EXTERNAL_GROUP_TOOLS } from './external-group-mount.mjs';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const ids = { connection: id('1'), assistant: id('2'), user: id('3'), org: id('4'), session: id('5'), credential: id('6'),
  membership: id('7'), scope: id('8') };
const NOW = 1_800_000_000_000;
const token = `hc_${Buffer.alloc(32, 7).toString('base64url')}`;
const tokenDigest = createHash('sha256').update(token).digest('hex');
const code = expected => error => error instanceof BrokerError && error.code === expected;
const issued = result => { assert.equal(result.isError, false); const value = JSON.parse(result.content[0].text);
  assert.deepEqual(Object.keys(value), ['requestId']); assert.match(value.requestId, UUID_V4); return value.requestId; };
const ALL_TOOLS = [...TASK_TOOLS, ...TASK_INPUT_TOOLS, ...ROOM_PASS_TOOLS, ...CUSTOMER_ACTION_TOOLS, ...EXPENSE_ACTION_TOOLS,
  ...DOMAIN_TOOLS, ...SCHEDULE_TOOLS, ...WORK_MEMORY_TOOLS, ...EXTERNAL_GROUP_TOOLS];

// Real durable authority (digest-bound joined read, sealed session, live Auth)
// over a synthetic store: revoke = the store answers unavailable.
function fixture(t, { read = [], action = ['customers.create'], limits, onAudit } = {}) {
  const crypto = createSessionCrypto({ activeKeyVersion: 'k', keys: new Map([['k', Buffer.alloc(32, 9)]]) });
  t.after(() => crypto.destroy());
  const dependencyScope = createDependencyScope(); t.after(() => dependencyScope.close());
  const binding = { assistantId: ids.assistant, userId: ids.user, organizationId: ids.org, sessionId: ids.session };
  const material = { accessToken: 'PRIVATE_ACCESS_TOKEN', refreshToken: 'PRIVATE_REFRESH_TOKEN', expiresAt: NOW + 3_600_000 };
  const envelope = crypto.seal(material, binding), grants = { read, action };
  const state = { clock: NOW, revoked: false, operations: [],
    connection: { id: ids.connection, assistantId: ids.assistant, organizationId: ids.org, userId: ids.user, state: 'active', epoch: 1,
      restrictions: grants, scopeIds: [ids.scope], tokenDigest, credentialRef: ids.credential, expiresAt: NOW + 600_000 } };
  const connectionStore = createDurableConnectionStore({ clock: () => state.clock, transport: { call: async operation => {
    state.operations.push(operation);
    return state.revoked ? { status: 'unavailable' } : structuredClone({ status: 'active', connection: state.connection,
      session: { credentialRef: ids.credential, revision: 1, envelope, expiresAt: material.expiresAt, binding },
      membership: { membershipId: ids.membership, authorizationVersion: 1, isSuperadmin: false },
      policy: { version: 1, ...grants, scopeIds: [ids.scope] } });
  } } });
  const auth = {
    verifySession: async () => ({ userId: ids.user, sessionId: ids.session, expiresAt: material.expiresAt }),
    readAuthorization: async () => ({ userId: ids.user, isSuperadmin: false, activeOrganizationIds: [ids.org], epoch: 'crm-1',
      membership: { organizationId: ids.org, status: 'ACTIVE', revokedAt: null, validFrom: null, validTo: null,
        membershipId: ids.membership, authorizationVersion: 1 },
      permissions: structuredClone(grants), companyCeilings: structuredClone(grants),
      scopesByPermission: Object.fromEntries([...read, ...action].map(key => [key, { buildingIds: [], cashbookIds: [] }])) }),
  };
  const authority = createDurableAuthority({ connectionStore, crypto, auth, clock: () => state.clock });
  // Every CRM business call lands here; crm_new_request_id must never add one.
  const crm = [];
  const service = suffix => ({
    [`prepare${suffix}`]: async () => { crm.push(`prepare${suffix}`); return Object.freeze({}); },
    [`finalize${suffix}`]: async () => { crm.push(`finalize${suffix}`); return { outcome: 'not_found' }; },
  });
  const audits = [];
  const broker = createBroker({ authority, dependencyScope, clock: () => state.clock,
    customers: service('CustomerAction'), domains: service('Domain'), ...(limits ? { limits } : {}),
    audit: async event => { audits.push(event); await onAudit?.(event, state); } });
  return { broker, state, crm, audits };
}

test('every requestId action points to crm_new_request_id; status tools reuse the original id; validation stays UUID', () => {
  assert.deepEqual(ALL_TOOLS.filter(startsCrmRequest).map(tool => tool.name).sort(), ['crm_customer_create', 'crm_expense_create',
    'crm_group_room_send', 'crm_lead_create', 'crm_room_pass_set_active', 'crm_room_pass_upsert', 'crm_room_schedule_create', 'crm_room_schedule_reconcile',
    'crm_room_schedule_revoke', 'crm_room_schedule_update', 'crm_task_cancel', 'crm_task_create', 'crm_task_follow_set',
    'crm_task_follow_stop', 'crm_task_progress']);
  const takesRequestId = ALL_TOOLS.filter(tool => Object.hasOwn(tool.inputSchema.properties ?? {}, 'requestId'));
  assert.deepEqual(takesRequestId.filter(tool => !startsCrmRequest(tool)).map(tool => tool.name).sort(),
    ['crm_customer_status', 'crm_expense_status', 'crm_lead_status', 'crm_room_pass_status', 'crm_task_status']);
  for (const tool of takesRequestId) {
    assert.ok(tool.inputSchema.required.includes('requestId'), tool.name);
    if (startsCrmRequest(tool)) {
      assert.ok(tool.description.includes(REQUEST_ID_GUIDANCE), tool.name);
      assert.deepEqual(tool.inputSchema.properties.requestId, REQUEST_ID_PROPERTY, tool.name);
    } else {
      assert.ok(tool.description.includes(REQUEST_ID_STATUS_GUIDANCE) && !tool.description.includes(REQUEST_ID_GUIDANCE), tool.name);
      assert.deepEqual(tool.inputSchema.properties.requestId, { type: 'string', format: 'uuid' }, tool.name);
    }
  }
  assert.match(REQUEST_ID_GUIDANCE, /MỘT lần cho mỗi lệnh mới; dùng lại đúng mã đó khi thử lại hoặc tra trạng thái; không tự tạo mã, không dùng lại mã của lệnh khác/);
  assert.deepEqual([REQUEST_ID_PROPERTY.type, REQUEST_ID_PROPERTY.format], ['string', 'uuid']);
  assert.equal(startsCrmRequest(NEW_REQUEST_ID_TOOL), false);
  assert.deepEqual(NEW_REQUEST_ID_TOOL.inputSchema, { type: 'object', properties: {}, additionalProperties: false });
  assert.equal(NEW_REQUEST_ID_TOOL.annotations.readOnlyHint, true);
  const customer = { name: 'Khách', phone: '0900000000', email: null, notes: null };
  const task = { title: 'Sửa', description: null, buildingId: id('9'), roomId: null, jobTypeId: id('a'), priority: 'NORMAL', assigneeId: null, deadline: null };
  for (const bad of ['', 'req-1', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 42]) {
    assert.throws(() => customerActionInput('customer.create', { ...customer, requestId: bad }));
    assert.throws(() => taskInput('create', { ...task, requestId: bad }));
  }
  assert.equal(customerActionInput('customer.create', { ...customer, requestId: id('b') }).requestId, id('b'));
});

test('crm_new_request_id lists and works exactly while an action that starts a request is granted', async t => {
  const f = fixture(t);
  const tools = (await f.broker.listTools(token)).tools;
  assert.deepEqual(tools.map(tool => tool.name), ['crm_customer_create', 'crm_customer_status', 'crm_new_request_id']);
  assert.deepEqual(tools.at(-1), JSON.parse(JSON.stringify(NEW_REQUEST_ID_TOOL)));
  const first = issued(await f.broker.callTool(token, 'crm_new_request_id', {}));
  // The issued id is accepted by the action's unchanged validation.
  assert.equal(customerActionInput('customer.create', { name: 'Khách', phone: '0900000000', email: null, notes: null, requestId: first }).requestId, first);
  const many = new Set([first]);
  for (let i = 0; i < 24; i++) many.add(issued(await f.broker.callTool(token, 'crm_new_request_id', {})));
  assert.equal(many.size, 25, 'a fresh random id per call');
  for (const args of [{ requestId: id('9') }, { seed: 1 }, null, [], 'x'])
    await assert.rejects(f.broker.callTool(token, 'crm_new_request_id', args), code('invalid_request'));
  // No CRM business read/write and nothing stored: only the authority's own connection reads.
  assert.deepEqual(f.crm, []);
  assert.deepEqual([...new Set(f.state.operations)], ['readConnection']);
  assert.equal(f.audits.filter(event => event.operation === 'tools/call' && event.outcome === 'prepared').length, 25);
  const exposed = JSON.stringify(f.audits);
  for (const secret of [token, tokenDigest, 'PRIVATE_ACCESS_TOKEN', first]) assert.equal(exposed.includes(secret), false);

  for (const grants of [{ read: ['contracts.view'], action: [] }, { read: ['assistant.context.read'], action: [] }, { read: [], action: [] }]) {
    const g = fixture(t, grants);
    const names = (await g.broker.listTools(token)).tools.map(tool => tool.name);
    assert.equal(names.includes('crm_new_request_id'), false, JSON.stringify(grants));
    assert.equal(names.some(name => name.startsWith('crm_customer_')), false);
    await assert.rejects(g.broker.callTool(token, 'crm_new_request_id', {}), code('tool_not_available'));
    assert.deepEqual(g.crm, []);
  }
  // Any granted action that starts a request lists it; a grant whose service is
  // not mounted on this broker lists nothing, so neither does the id tool.
  const leads = fixture(t, { action: ['leads.create'] });
  assert.deepEqual((await leads.broker.listTools(token)).tools.map(tool => tool.name), ['crm_lead_create', 'crm_lead_status', 'crm_new_request_id']);
  const unmounted = fixture(t, { action: ['income_expenses.create'] });
  assert.deepEqual((await unmounted.broker.listTools(token)).tools, []);
  await assert.rejects(unmounted.broker.callTool(token, 'crm_new_request_id', {}), code('tool_not_available'));
});

test('revoked or expired connections never receive an id, including a revoke during the call', async t => {
  const revoked = fixture(t);
  issued(await revoked.broker.callTool(token, 'crm_new_request_id', {}));
  revoked.state.revoked = true;
  await assert.rejects(revoked.broker.callTool(token, 'crm_new_request_id', {}), code('unauthorized'));
  await assert.rejects(revoked.broker.listTools(token), code('unauthorized'));
  assert.equal(revoked.audits.at(-1).outcome, 'denied');

  const expired = fixture(t); expired.state.connection.expiresAt = NOW;
  await assert.rejects(expired.broker.callTool(token, 'crm_new_request_id', {}), code('unauthorized'));
  const lapsed = fixture(t);
  issued(await lapsed.broker.callTool(token, 'crm_new_request_id', {}));
  lapsed.state.clock = NOW + 600_000;
  await assert.rejects(lapsed.broker.callTool(token, 'crm_new_request_id', {}), code('unauthorized'));

  // The id exists only after the audit and the post-audit authority reread.
  const racing = fixture(t, { onAudit: (event, state) => { if (event.outcome === 'prepared') state.revoked = true; } });
  await assert.rejects(racing.broker.callTool(token, 'crm_new_request_id', {}), code('unauthorized'));
  assert.deepEqual(racing.audits.map(event => event.outcome), ['prepared', 'denied']);

  for (const bad of ['', 'hc_short', `Bearer ${token}`, token.toUpperCase()])
    await assert.rejects(revoked.broker.callTool(bad, 'crm_new_request_id', {}), code('unauthorized'));
});

test('crm_new_request_id counts against the shared per-connection tools/call quota', async t => {
  const f = fixture(t, { limits: { maxToolCallsPerMinute: 2 } });
  await f.broker.callTool(token, 'crm_customer_status', { requestId: id('9') });
  issued(await f.broker.callTool(token, 'crm_new_request_id', {}));
  const limited = await f.broker.callTool(token, 'crm_new_request_id', {}).then(() => null, error => error);
  assert.ok(code('rate_limited')(limited)); assert.ok(limited.retryAfterMs >= 1000);
  await assert.rejects(f.broker.callTool(token, 'crm_customer_status', { requestId: id('9') }), code('rate_limited'), 'shared with other tools');
  assert.ok((await f.broker.listTools(token)).tools.length, 'listing is not a tools/call');
  f.state.clock += 60_000;
  issued(await f.broker.callTool(token, 'crm_new_request_id', {}));
  const only = fixture(t, { limits: { maxToolCallsPerMinute: 1 } });
  issued(await only.broker.callTool(token, 'crm_new_request_id', {}));
  await assert.rejects(only.broker.callTool(token, 'crm_customer_status', { requestId: id('9') }), code('rate_limited'));
  assert.deepEqual(only.crm, []);
});

test('external MCP: tools/list, tools/call, quota as tool result and revoke as 401', async t => {
  const f = fixture(t, { limits: { maxToolCallsPerMinute: 1 } });
  const server = createMcpHttpServer({ broker: f.broker, allowedHosts: ['127.0.0.1'], allowedOrigins: [] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  let rpc = 0;
  const mcp = async (method, params) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method, ...(params === undefined ? {} : { params }) }) });
    return { status: response.status, body: await response.json() };
  };
  const listed = await mcp('tools/list');
  assert.equal(listed.status, 200); assert.ok(listed.body.result.tools.some(tool => tool.name === 'crm_new_request_id'));
  const call = await mcp('tools/call', { name: 'crm_new_request_id' });
  assert.equal(call.status, 200); issued(call.body.result);
  const limited = await mcp('tools/call', { name: 'crm_new_request_id', arguments: {} });
  assert.equal(limited.status, 200); assert.equal(limited.body.result.isError, true);
  const receipt = JSON.parse(limited.body.result.content[0].text);
  assert.equal(receipt.error, 'rate_limited'); assert.ok(receipt.retryAfterSeconds >= 1); assert.equal(receipt.requestId, undefined);
  f.state.clock += 60_000; f.state.revoked = true;
  const denied = await mcp('tools/call', { name: 'crm_new_request_id', arguments: {} });
  assert.equal(denied.status, 401); assert.deepEqual(denied.body, { error: 'unauthorized' });
  assert.deepEqual(f.crm, []);
});
