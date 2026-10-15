import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setup, token, BUILDING, OTHER_BUILDING, ROOM, CASHBOOK, CATEGORY, USER, ORG, FOREIGN, SESSION, ASSISTANT } from './finance-fixture.mjs';
import { createExpenseActionAuth, createExpenseActionReads, createExpenseActionService } from './expense-action-adapter.mjs';
import { createBroker } from './broker.mjs';
import { createMcpHttpServer } from './mcp-http.mjs';
import { createDurableAuthority } from './durable-authority.mjs';
import { createDurableConnectionStore } from './durable-connection-store.mjs';
import { createSessionCrypto } from './session-crypto.mjs';
import { createDependencyScope } from './dependency-scope.mjs';

// Synthetic fixture amounts only. The canonical writer and CRM permission graph
// are fixture ports with the real signatures (finance-fixture); this proves the
// MCP/broker/adapter/SQL composition, not the live writer, posting or RLS.
const create = (extra = {}) => ({ requestId: randomUUID(), buildingId: BUILDING, roomId: ROOM, cashbookId: CASHBOOK, voucherDate: '2026-10-15',
  name: 'Sửa điện phòng', vendor: null, lines: [{ categoryId: CATEGORY, amount: 150000, description: 'Thay ổ cắm' }], ...extra });

test('external MCP → broker → audited bound SQL: expense options/create/status, ACK loss is expense_outcome_unknown and never retried', { timeout: 120000 }, async t => {
  const env = await setup(t), { db, call: sql, counts } = env, events = [];
  // Action-only connection: Read v2 keys are cleared; the action tools still list.
  await db.exec("UPDATE app_private.hermes_connections SET read_capabilities='{}';UPDATE app_private.hermes_org_policies SET read_capabilities='{}'");
  const expiresAt = (Math.floor(Date.now() / 1000) + 3600) * 1000;
  const accessToken = ['header', Buffer.from(JSON.stringify({ role: 'authenticated', sub: USER, session_id: SESSION, exp: expiresAt / 1000 })).toString('base64url'), 'signature'].join('.');
  const crypto = createSessionCrypto({ activeKeyVersion: 'test', keys: new Map([['test', randomBytes(32)]]) }); t.after(() => crypto.destroy());
  const envelope = crypto.seal({ accessToken, refreshToken: 'SYNTHETIC_REFRESH', expiresAt }, { assistantId: ASSISTANT, userId: USER, organizationId: ORG, sessionId: SESSION });
  await db.query('UPDATE app_private.hermes_sessions SET envelope=$1::jsonb,expires_at=to_timestamp($2/1000.0)', [JSON.stringify(envelope), expiresAt]);
  const dependencyScope = createDependencyScope(); t.after(() => dependencyScope.close());
  let beforeFinal, loseAck = false, creates = 0;
  const transport = async (url, options) => {
    assert.equal(new URL(url).origin, 'https://example.invalid'); assert.equal(options.headers.authorization, 'Bearer ' + accessToken);
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    const path = new URL(url).pathname, args = JSON.parse(options.body);
    const capability = path === '/rest/v1/rpc/hermes_expense_capabilities_v1';
    assert.ok(capability || path === '/rest/v1/rpc/hermes_expense_action_v1', path);
    if (capability) assert.deepEqual(args, { p_organization_id: ORG });
    else {
      assert.deepEqual(Object.keys(args).sort(), ['p_binding', 'p_input', 'p_operation']);
      if (beforeFinal) { const hook = beforeFinal; beforeFinal = undefined; await hook(); }
    }
    events.push(capability ? 'capability' : `sql:${args.p_operation}`);
    if (args.p_operation === 'create') creates++;
    try {
      const result = capability ? await sql('SELECT public.hermes_expense_capabilities_v1($1::uuid) result', [args.p_organization_id])
        : await sql('SELECT public.hermes_expense_action_v1($1::jsonb,$2::text,$3::jsonb) result', [JSON.stringify(args.p_binding), args.p_operation, JSON.stringify(args.p_input)]);
      if (args.p_operation === 'create' && loseAck) { loseAck = false; throw new Error('synthetic_ack_lost'); }
      return Response.json(result);
    } catch (error) {
      if (!error.code) throw error;
      return Response.json({ code: error.code, message: error.message, details: null, hint: null }, { status: error.code === '42501' ? 403 : error.code === 'PT409' ? 409 : 400 });
    }
  };
  const supabase = { url: 'https://example.invalid/', publishableKey: 'sb_publishable_test' };
  const baseAuth = { async verifySession() { return { userId: USER, sessionId: SESSION, expiresAt }; }, async readAuthorization() { return {
    userId: USER, isSuperadmin: false, activeOrganizationIds: [ORG], epoch: 'synthetic-base',
    membership: { organizationId: ORG, status: 'ACTIVE', revokedAt: null, validFrom: null, validTo: null, membershipId: USER, authorizationVersion: 1 },
    permissions: { read: [], action: [] }, companyCeilings: { read: [], action: [] }, scopesByPermission: {} }; } };
  const auth = createExpenseActionAuth({ baseAuth, reads: createExpenseActionReads({ ...supabase, fetch: transport, dependencyScope }) });
  const connectionStore = createDurableConnectionStore({ transport: { async call(operation, payload) {
    assert.equal(operation, 'readConnection'); return env.rpc('app_private.hermes_store_read_connection_v1', payload); } } });
  const authority = createDurableAuthority({ connectionStore, crypto, auth });
  const expenses = createExpenseActionService({ authority, connectionStore, crypto, auth, supabase, dependencyScope, fetch: transport });
  let afterAudit;
  const broker = createBroker({ authority, expenses, dependencyScope, audit: async entry => {
    events.push(`audit:${entry.outcome}`);
    if (afterAudit && entry.outcome === 'prepared') { const hook = afterAudit; afterAudit = undefined; await hook(); }
  } });
  const server = createMcpHttpServer({ broker, allowedHosts: ['127.0.0.1'], allowedOrigins: [] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  let rpcId = 0;
  const mcp = async (method, params) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
    assert.equal(response.status, 200); return (await response.json()).result;
  };
  const callTool = async (name, args) => { const result = await mcp('tools/call', { name, arguments: args }); return { ...result, value: JSON.parse(result.content[0].text) }; };
  const listed = async () => (await mcp('tools/list')).tools.map(tool => tool.name).sort();

  assert.deepEqual(await listed(), ['crm_expense_create', 'crm_expense_input_options', 'crm_expense_status']);
  for (const name of ['crm_read_income_expenses', 'crm_customer_create', 'crm_task_create']) assert.equal((await callTool(name, {})).value.error, 'tool_not_available');
  assert.deepEqual((await callTool('crm_expense_input_options', { kind: 'buildings' })).value.items, [{ id: BUILDING, label: 'Toà A' }], 'overlay scope, not every CRM building');
  assert.deepEqual((await callTool('crm_expense_input_options', { kind: 'cashbooks' })).value.items, [{ id: CASHBOOK, label: 'Quỹ VCB ***' }]);
  const before = await counts();
  assert.equal(creates, 0);

  const input = create();
  events.length = 0; loseAck = true;
  const unknown = await callTool('crm_expense_create', input);
  assert.deepEqual(unknown.value, { error: 'expense_outcome_unknown', requestId: input.requestId }); assert.equal(unknown.isError, true);
  assert.ok(events.indexOf('audit:prepared') < events.indexOf('sql:create'), 'audit precedes the final write');
  assert.equal(events.filter(event => event === 'sql:create').length, 1, 'ACK loss is never retried');
  const status = await callTool('crm_expense_status', { requestId: input.requestId });
  assert.equal(status.value.outcome, 'applied'); assert.equal(status.value.voucher.createdBy, USER); assert.equal(status.value.voucher.buildingId, BUILDING);
  assert.deepEqual(await counts(), { vouchers: before.vouchers + 1, receipts: before.receipts + 1, audits: before.audits + 1 });
  assert.deepEqual((await callTool('crm_expense_create', input)).value, status.value, 'same requestId replays the durable receipt');
  assert.equal((await counts()).vouchers, before.vouchers + 1);
  const missing = randomUUID();
  assert.deepEqual((await callTool('crm_expense_status', { requestId: missing })).value, { organizationId: ORG, requestId: missing, outcome: 'not_found', voucher: null });
  assert.equal((await callTool('crm_expense_create', { ...input, lines: [{ ...input.lines[0], amount: 160000 }] })).value.error, 'context_changed', 'changed intent');
  for (const extra of [{ approvalStatus: 'APPROVED' }, { organizationId: FOREIGN }, { receiveBankAccount: '0123' }, { lines: [{ categoryId: CATEGORY, amount: 1.5, description: null }] }])
    assert.equal((await callTool('crm_expense_create', create(extra))).value.error, 'invalid_request');
  const sqlCreates = creates;
  assert.equal(sqlCreates, 3, 'invalid DTOs never reach SQL');

  const outside = await callTool('crm_expense_create', create({ buildingId: OTHER_BUILDING, roomId: null }));
  assert.equal(outside.value.error, 'forbidden', 'CRM allows the building, the Hermes overlay scope does not');
  await db.query('INSERT INTO public.fixture_approvers VALUES($1)', [BUILDING]);
  assert.equal((await callTool('crm_expense_create', create())).value.error, 'forbidden', 'approve-capable maker without the approve overlay');
  await db.exec('DELETE FROM public.fixture_approvers');
  afterAudit = () => db.exec("UPDATE public.fixture_acl SET allowed=false WHERE permission='income_expenses.create'");
  assert.equal((await callTool('crm_expense_status', { requestId: input.requestId })).value.error, 'context_changed', 'CRM revoke between audit and final read');
  assert.deepEqual(await listed(), []);
  await db.exec("UPDATE public.fixture_acl SET allowed=true WHERE permission='income_expenses.create'");
  beforeFinal = () => db.exec("UPDATE app_private.hermes_connections SET action_capabilities='{}'");
  assert.equal((await callTool('crm_expense_create', create())).value.error, 'forbidden', 'definitive SQL denial is not an unknown outcome');
  assert.deepEqual(await counts(), { vouchers: before.vouchers + 1, receipts: before.receipts + 1, audits: before.audits + 1 });
  for (const value of [unknown, status]) {
    assert.equal(JSON.stringify(value).includes(accessToken), false); assert.equal(JSON.stringify(value).includes('SYNTHETIC_REFRESH'), false);
  }
});
