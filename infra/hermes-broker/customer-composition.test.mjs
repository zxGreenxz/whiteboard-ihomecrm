import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setup, id, customerInput, leadInput, USER, ORG, FOREIGN, SESSION, REQUEST } from './customer-action-fixture.mjs';
import { ASSISTANT } from '../hermes-zalo-router/private-command-fixture.mjs';
import { createCustomerActionAuth, createCustomerActionReads, createCustomerActionService } from './customer-action-adapter.mjs';
import { createBroker } from './broker.mjs';
import { createMcpHttpServer } from './mcp-http.mjs';
import { createDurableAuthority } from './durable-authority.mjs';
import { createDurableConnectionStore } from './durable-connection-store.mjs';
import { createSessionCrypto } from './session-crypto.mjs';
import { createDependencyScope } from './dependency-scope.mjs';

const forward = readFileSync('supabase/migrations/20261014000503_hermes_optional_org_policy_v1.sql', 'utf8');
const extract = (src, name) => src.match(new RegExp('CREATE OR REPLACE FUNCTION ' + name.replaceAll('.', '\\.') + '[\\s\\S]*?\\$(?:fn)?\\$;'))[0];
const token = 'hc_' + 'C'.repeat(43), digest = createHash('sha256').update(token).digest('hex');

// External MCP → broker → bound caller JWT → candidate customer/lead SQL on
// PGlite. The CRM permission graph behind context/scope helpers is a fixture
// port (customer-action-fixture); canonical tables, triggers and RLS are real.
test('external MCP → broker → audited bound SQL: customer/lead create, ACK loss reconciles by status, never retried', { timeout: 90000 }, async t => {
  const { db, rpc, counts } = await setup(t), events = [];
  await db.exec(extract(forward, 'app_private.hermes_store_read_connection_v1'));
  await db.query('UPDATE app_private.hermes_connection_tokens SET token_digest=$1', [digest]);
  // Action-only connection: Read is empty, the create tools still list.
  await db.exec("UPDATE app_private.hermes_connections SET read_capabilities='{}';UPDATE app_private.hermes_org_policies SET read_capabilities='{}'");
  const expiresAt = (Math.floor(Date.now() / 1000) + 3600) * 1000;
  const accessToken = ['header', Buffer.from(JSON.stringify({ role: 'authenticated', sub: USER, session_id: SESSION, exp: expiresAt / 1000 })).toString('base64url'), 'signature'].join('.');
  const crypto = createSessionCrypto({ activeKeyVersion: 'test', keys: new Map([['test', randomBytes(32)]]) }); t.after(() => crypto.destroy());
  const envelope = crypto.seal({ accessToken, refreshToken: 'SYNTHETIC_REFRESH', expiresAt }, { assistantId: ASSISTANT, userId: USER, organizationId: ORG, sessionId: SESSION });
  await db.query('UPDATE app_private.hermes_sessions SET envelope=$1::jsonb,expires_at=to_timestamp($2/1000.0)', [JSON.stringify(envelope), expiresAt]);
  const dependencyScope = createDependencyScope(); t.after(() => dependencyScope.close());
  let beforeFinal, loseAck = false, writes = 0;
  const transport = async (url, options) => {
    assert.equal(new URL(url).origin, 'https://example.invalid'); assert.equal(options.headers.authorization, 'Bearer ' + accessToken);
    assert.equal(options.headers.apikey, 'sb_publishable_test'); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    const path = new URL(url).pathname, args = JSON.parse(options.body);
    const capability = path === '/rest/v1/rpc/hermes_customer_create_capabilities_v1';
    assert.ok(capability || path === '/rest/v1/rpc/hermes_customer_create_action_v1', path);
    if (capability) assert.deepEqual(args, { p_organization_id: ORG });
    else {
      assert.deepEqual(Object.keys(args).sort(), ['p_binding', 'p_input', 'p_kind', 'p_operation']);
      if (beforeFinal) { const hook = beforeFinal; beforeFinal = undefined; await hook(); }
    }
    events.push(capability ? 'capability' : `sql:${args.p_kind}.${args.p_operation}`);
    if (args.p_operation === 'create') writes++;
    try {
      const result = capability ? await rpc(null, 'capabilities', {}) : await rpc(args.p_kind, args.p_operation, args.p_input, args.p_binding);
      if (args.p_operation === 'create' && loseAck) { loseAck = false; throw new Error('synthetic_ack_lost'); }
      return Response.json(result);
    } catch (error) {
      if (!error.code) throw error;
      return Response.json({ code: error.code, message: error.message, details: null, hint: null }, { status: error.code === '42501' ? 403 : error.code === 'PT409' ? 409 : 400 });
    }
  };
  const supabase = { url: 'https://example.invalid/', publishableKey: 'sb_publishable_test' };
  const baseAuth = { async verifySession({ accessToken: provided }) { assert.equal(provided, accessToken); return { userId: USER, sessionId: SESSION, expiresAt }; },
    async readAuthorization() { return { userId: USER, isSuperadmin: false, activeOrganizationIds: [ORG], epoch: 'base',
      membership: { organizationId: ORG, status: 'ACTIVE', revokedAt: null, validFrom: null, validTo: null, membershipId: USER, authorizationVersion: 1 },
      permissions: { read: [], action: [] }, companyCeilings: { read: [], action: [] }, scopesByPermission: {} }; } };
  const auth = createCustomerActionAuth({ baseAuth, reads: createCustomerActionReads({ ...supabase, fetch: transport, dependencyScope }) });
  const connectionStore = createDurableConnectionStore({ transport: { async call(operation, payload) {
    assert.equal(operation, 'readConnection'); await db.exec('BEGIN;SET LOCAL ROLE hermes_store_executor');
    await db.query("SELECT set_config('request.jwt.claim.role','hermes_store_executor',true)");
    try { const value = (await db.query('SELECT app_private.hermes_store_read_connection_v1($1::jsonb) result', [JSON.stringify(payload)])).rows[0].result; await db.exec('COMMIT'); return value; }
    catch (error) { await db.exec('ROLLBACK'); throw error; } finally { await db.exec('RESET ROLE'); } } } });
  const authority = createDurableAuthority({ connectionStore, crypto, auth });
  const customers = createCustomerActionService({ authority, connectionStore, crypto, auth, supabase, dependencyScope, fetch: transport });
  let afterAudit;
  const broker = createBroker({ authority, customers, dependencyScope, audit: async entry => {
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
  const call = async (name, args) => { const result = await mcp('tools/call', { name, arguments: args }); return { ...result, value: JSON.parse(result.content[0].text) }; };
  const listed = async () => (await mcp('tools/list')).tools.map(tool => tool.name).sort();

  assert.deepEqual(await listed(), ['crm_customer_create', 'crm_customer_status', 'crm_lead_create', 'crm_lead_status', 'crm_new_request_id']);
  await db.exec("UPDATE public.fixture_customer_acl SET allowed=false WHERE permission='leads.create'");
  assert.deepEqual(await listed(), ['crm_customer_create', 'crm_customer_status', 'crm_new_request_id'], 'CRM grant of each kind gates its own tools');
  assert.equal((await call('crm_lead_create', { ...leadInput, requestId: id('7') })).value.error, 'tool_not_available');
  await db.exec("UPDATE public.fixture_customer_acl SET allowed=true WHERE permission='leads.create'");
  // Read/other families are not mounted on this broker; their names stay closed.
  for (const name of ['crm_read_customers', 'crm_expense_create', 'crm_task_create']) assert.equal((await call(name, {})).value.error, 'tool_not_available');
  assert.equal(writes, 0); assert.deepEqual(await counts(), { customers: 0, leads: 0, receipts: 0, audits: 0, occurrences: 0 });

  const created = await call('crm_customer_create', customerInput);
  assert.equal(created.isError, false); assert.equal(created.value.outcome, 'applied'); assert.equal(created.value.record.createdBy, USER);
  assert.equal(created.value.record.status, 'WALK_IN'); assert.equal(writes, 1);
  assert.deepEqual((await call('crm_customer_create', customerInput)).value, created.value, 'same requestId replays the receipt');
  assert.equal(writes, 2); assert.equal((await counts()).customers, 1);

  // The model takes the requestId from the connector, then reuses it for status.
  const issued = await call('crm_new_request_id', {});
  assert.equal(issued.isError, false); assert.deepEqual(Object.keys(issued.value), ['requestId']);
  const lead = { ...leadInput, requestId: issued.value.requestId };
  events.length = 0; loseAck = true;
  const unknown = await call('crm_lead_create', lead);
  assert.deepEqual(unknown.value, { error: 'customer_outcome_unknown', requestId: lead.requestId }); assert.equal(unknown.isError, true);
  assert.ok(events.indexOf('audit:prepared') < events.indexOf('sql:lead.create'), 'audit precedes the final write');
  assert.equal(events.filter(event => event === 'sql:lead.create').length, 1, 'ACK loss is never retried');
  const status = await call('crm_lead_status', { requestId: lead.requestId });
  assert.equal(status.value.outcome, 'applied'); assert.equal(status.value.record.status, 'B1_LEAD'); assert.equal(status.value.record.createdBy, USER);
  assert.deepEqual(await counts(), { customers: 1, leads: 1, receipts: 2, audits: 2, occurrences: 1 });
  assert.deepEqual((await call('crm_lead_status', { requestId: id('8') })).value,
    { organizationId: ORG, requestId: id('8'), kind: 'lead', outcome: 'not_found', record: null });
  // Same requestId under the other kind or with changed intent is a conflict, not a new record.
  assert.equal((await call('crm_customer_create', { ...customerInput, requestId: lead.requestId })).value.error, 'context_changed');
  assert.equal((await call('crm_customer_create', { ...customerInput, name: 'Đổi ý' })).value.error, 'context_changed');
  for (const extra of [{ userId: FOREIGN }, { organizationId: FOREIGN }, { status: 'RENTING' }, { rpc: 'arbitrary' }])
    assert.equal((await call('crm_customer_create', { ...customerInput, requestId: id('6'), ...extra })).value.error, 'invalid_request');
  assert.equal(writes, 5, 'two conflicts reached SQL and were rejected there; invalid DTOs never did');

  afterAudit = () => db.exec("UPDATE public.fixture_customer_acl SET allowed=false WHERE permission='customers.create'");
  assert.equal((await call('crm_customer_status', { requestId: REQUEST })).value.error, 'context_changed', 'CRM revoke between audit and final read');
  assert.deepEqual(await listed(), ['crm_lead_create', 'crm_lead_status', 'crm_new_request_id']);
  await db.exec("UPDATE public.fixture_customer_acl SET allowed=true WHERE permission='customers.create'");
  beforeFinal = () => db.exec("UPDATE app_private.hermes_connections SET action_capabilities='{}'");
  const denied = await call('crm_customer_create', { ...customerInput, requestId: id('5') });
  assert.equal(denied.value.error, 'forbidden', 'definitive SQL denial is not an unknown outcome');
  assert.deepEqual(await counts(), { customers: 1, leads: 1, receipts: 2, audits: 2, occurrences: 1 });
  for (const value of [unknown, status, denied]) {
    assert.equal(JSON.stringify(value).includes(accessToken), false); assert.equal(JSON.stringify(value).includes('SYNTHETIC_REFRESH'), false);
  }
});
