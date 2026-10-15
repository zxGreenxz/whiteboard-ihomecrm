import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setup, USER, ORG, SESSION, SCOPE, CONNECTION } from './customer-action-fixture.mjs';
import { installV7, baseOptions } from './customer-options-fixture.mjs';
import { ASSISTANT } from '../hermes-zalo-router/private-command-fixture.mjs';
import { createCustomerActionAuth, createCustomerActionReads, createCustomerActionService } from './customer-action-adapter.mjs';
import { createConnectionManagement, createSupabaseConnectionManagementReads } from './connection-management.mjs';
import { createBroker } from './broker.mjs';
import { createMcpHttpServer } from './mcp-http.mjs';
import { createDurableAuthority } from './durable-authority.mjs';
import { createDurableConnectionStore } from './durable-connection-store.mjs';
import { createSessionCrypto } from './session-crypto.mjs';
import { createDependencyScope } from './dependency-scope.mjs';

// Candidate: supabase/migrations/20261015191139_hermes_customer_options_v7.sql
const forward = readFileSync('supabase/migrations/20261014000503_hermes_optional_org_policy_v1.sql', 'utf8');
const extract = (src, name) => src.match(new RegExp('CREATE OR REPLACE FUNCTION ' + name.replaceAll('.', '\\.') + '[\\s\\S]*?\\$(?:fn)?\\$;'))[0];
const token = 'hc_' + 'D'.repeat(43), digest = createHash('sha256').update(token).digest('hex');
const CUSTOMER_TOOLS = ['crm_customer_create', 'crm_customer_status', 'crm_lead_create', 'crm_lead_status'];

// Browser grant form → broker connection management → caller-JWT options v7 SQL
// → the human-selected restrictions on a connection → MCP tools/list. v6 is a
// stub (legacy, tested elsewhere); v7, the CRM capability reader, policy,
// registry, scopes and the durable connection read are the PGlite SQL.
test('options v7 make Khách hàng selectable and a connection with customers.create lists crm_customer_* tools', { timeout: 90000 }, async t => {
  const { db, rpc } = await setup(t);
  const { base } = await installV7(db);
  await db.exec('GRANT SELECT ON public.fixture_v6 TO authenticated');
  await base('connection_options', baseOptions);
  await db.exec(extract(forward, 'app_private.hermes_store_read_connection_v1'));
  await db.query('UPDATE app_private.hermes_connection_tokens SET token_digest=$1', [digest]);
  // The connection starts with nothing selected (what v6 could offer).
  await db.exec("UPDATE app_private.hermes_connections SET read_capabilities='{}',action_capabilities='{}',scope_ids='{}';UPDATE app_private.hermes_org_policies SET read_capabilities='{}'");
  // v6 context projection of the stored row; v7 adds only the customer keys.
  await db.exec(`CREATE OR REPLACE FUNCTION public.hermes_connection_context_v6(p_connection_id uuid) RETURNS jsonb LANGUAGE sql AS $$
    SELECT app_private.hermes_connection_json_v1(c)||app_private.hermes_member_v1(c.user_id,c.organization_id)||jsonb_build_object('policyVersion',p.version,
      'companyCeilings',jsonb_build_object('read',p.read_capabilities,'action',p.action_capabilities),'effective',jsonb_build_object('read','[]'::jsonb,'action','[]'::jsonb))
    FROM app_private.hermes_connections c JOIN app_private.hermes_org_policies p ON p.organization_id=c.organization_id WHERE c.id=p_connection_id $$`);

  const expiresAt = (Math.floor(Date.now() / 1000) + 3600) * 1000;
  const accessToken = ['header', Buffer.from(JSON.stringify({ role: 'authenticated', sub: USER, session_id: SESSION, exp: expiresAt / 1000 })).toString('base64url'), 'signature'].join('.');
  const crypto = createSessionCrypto({ activeKeyVersion: 'test', keys: new Map([['test', randomBytes(32)]]) }); t.after(() => crypto.destroy());
  const envelope = crypto.seal({ accessToken, refreshToken: 'SYNTHETIC_REFRESH', expiresAt }, { assistantId: ASSISTANT, userId: USER, organizationId: ORG, sessionId: SESSION });
  await db.query('UPDATE app_private.hermes_sessions SET envelope=$1::jsonb,expires_at=to_timestamp($2/1000.0)', [JSON.stringify(envelope), expiresAt]);
  const dependencyScope = createDependencyScope(); t.after(() => dependencyScope.close());

  let v7Deployed = false; const paths = [];
  const caller = async (sql, arg) => {
    await db.exec('BEGIN');
    await db.query("SELECT set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.session',$2,true)", [USER, SESSION]);
    await db.exec('SET LOCAL ROLE authenticated');
    try { const value = (await db.query(sql, [arg])).rows[0].result; await db.exec('COMMIT'); return value; }
    catch (error) { await db.exec('ROLLBACK'); throw error; } finally { await db.exec('RESET ROLE'); }
  };
  const transport = async (url, options) => {
    assert.equal(new URL(url).origin, 'https://example.invalid'); assert.equal(options.headers.authorization, 'Bearer ' + accessToken);
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    const path = new URL(url).pathname, args = JSON.parse(options.body); paths.push(path.replace('/rest/v1/rpc/', ''));
    try {
      const reads = /^\/rest\/v1\/rpc\/hermes_connection_(options|context)_v([67])$/.exec(path);
      if (reads && reads[2] === '7' && !v7Deployed) return Response.json({ code: 'PGRST202', message: 'absent', details: null, hint: null }, { status: 404 });
      if (reads) return Response.json(await caller(`SELECT public.hermes_connection_${reads[1]}_v${reads[2]}($1::uuid) result`, reads[1] === 'options' ? args.p_org : args.p_connection_id));
      if (path === '/rest/v1/rpc/hermes_customer_create_capabilities_v1') { assert.deepEqual(args, { p_organization_id: ORG }); return Response.json(await rpc(null, 'capabilities', {})); }
      if (path === '/rest/v1/rpc/hermes_customer_create_action_v1') return Response.json(await rpc(args.p_kind, args.p_operation, args.p_input, args.p_binding));
      throw new Error('unexpected_fixture_rpc ' + path);
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
  const refuse = async () => { throw new Error('no_write_expected'); };
  const management = createConnectionManagement({ auth, reads: createSupabaseConnectionManagementReads({ ...supabase, url: 'https://example.invalid', fetch: transport, dependencyScope }),
    connectionStore: { restrictConnection: refuse, revokeConnection: refuse } });
  const browser = extra => ({ browserAccessToken: accessToken, organizationId: ORG, ...extra });
  const signal = () => ({ signal: new AbortController().signal });

  const connectionStore = createDurableConnectionStore({ transport: { async call(operation, payload) {
    assert.equal(operation, 'readConnection'); await db.exec('BEGIN;SET LOCAL ROLE hermes_store_executor');
    await db.query("SELECT set_config('request.jwt.claim.role','hermes_store_executor',true)");
    try { const value = (await db.query('SELECT app_private.hermes_store_read_connection_v1($1::jsonb) result', [JSON.stringify(payload)])).rows[0].result; await db.exec('COMMIT'); return value; }
    catch (error) { await db.exec('ROLLBACK'); throw error; } finally { await db.exec('RESET ROLE'); } } } });
  const authority = createDurableAuthority({ connectionStore, crypto, auth });
  const customers = createCustomerActionService({ authority, connectionStore, crypto, auth, supabase, dependencyScope, fetch: transport });
  const broker = createBroker({ authority, customers, dependencyScope, audit: async () => {} });
  const server = createMcpHttpServer({ broker, allowedHosts: ['127.0.0.1'], allowedOrigins: [] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  let rpcId = 0;
  const listed = async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list' }) });
    assert.equal(response.status, 200); return (await response.json()).result.tools.map(tool => tool.name).sort();
  };
  // The human ticks exactly what the grant form offered (connect/activation is
  // the separate prepare+activate lane; its stored restrictions are what the broker reads).
  const select = async (action, scopeIds) => db.query('UPDATE app_private.hermes_connections SET action_capabilities=$1::text[],scope_ids=$2::uuid[]', [action, scopeIds]);

  // Before v7 (lane not applied yet): negotiated v6 offers no Khách hàng action, so no customer tool can ever list.
  const legacy = (await management.options(browser(), signal())).options;
  assert.deepEqual(legacy.action, []); assert.deepEqual(legacy.scopes, []);
  assert.deepEqual(paths.filter(path => path.startsWith('hermes_connection_options')).slice(0, 2), ['hermes_connection_options_v7', 'hermes_connection_options_v6']);
  await select(legacy.action, legacy.scopes.map(scope => scope.scopeId));
  assert.equal((await listed()).some(name => CUSTOMER_TOOLS.includes(name)), false);

  v7Deployed = true;
  const { options } = await management.options(browser(), signal());
  assert.deepEqual(options.action, ['customers.create', 'leads.create']);
  assert.deepEqual(options.scopes.map(scope => [scope.scopeId, scope.scopeType, scope.label]), [[SCOPE, 'ORGANIZATION', 'Toàn tổ chức']]);
  await select(['customers.create'], [SCOPE]);
  const tools = await listed();
  assert.ok(tools.includes('crm_customer_create') && tools.includes('crm_customer_status'), tools.join(','));
  assert.equal(tools.includes('crm_lead_create'), false, 'unselected lead action stays closed');
  const { context } = await management.context(browser({ connectionId: CONNECTION }), signal());
  assert.deepEqual(context.effective.action, ['customers.create']);

  await select(['customers.create', 'leads.create'], [SCOPE]);
  assert.deepEqual((await listed()).filter(name => CUSTOMER_TOOLS.includes(name)), CUSTOMER_TOOLS);
  // CRM revoke after the connection was made: options stop offering it and the tools close.
  await db.exec("UPDATE public.fixture_customer_acl SET allowed=false WHERE permission='customers.create'");
  assert.deepEqual((await management.options(browser(), signal())).options.action, ['leads.create']);
  assert.deepEqual((await listed()).filter(name => CUSTOMER_TOOLS.includes(name)), ['crm_lead_create', 'crm_lead_status']);
  assert.deepEqual((await management.context(browser({ connectionId: CONNECTION }), signal())).context.effective.action, ['leads.create']);
});
