import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { setupZaloBroadcast, WHOLE_DAY, G1, G2, G4, ACCOUNT2, USER, ORG, SESSION, ACCOUNT } from './zalo-broadcast-sql-fixture.mjs';
import { ASSISTANT } from '../hermes-zalo-router/private-command-fixture.mjs';
import { createZaloBroadcastService } from './zalo-broadcast-adapter.mjs';
import { createBroker } from './broker.mjs';
import { createMcpHttpServer } from './mcp-http.mjs';
import { createDurableAuthority } from './durable-authority.mjs';
import { createDurableConnectionStore } from './durable-connection-store.mjs';
import { createSessionCrypto } from './session-crypto.mjs';
import { createDependencyScope } from './dependency-scope.mjs';

// Broker → bound-user operation → caller-JWT RPC → actual candidate SQL, over a
// real MCP HTTP server. CRM grants come from a synthetic base auth (the group and
// schedule capability adapters are covered by their own tests); the SQL wrapper
// still re-checks the saved overlay and CRM authority on every call.
const token = 'hc_' + 'C'.repeat(43), digest = createHash('sha256').update(token).digest('hex');
const PATH = '/rest/v1/rpc/hermes_zalo_broadcast_v1';

async function compose(t) {
  const fixture = await setupZaloBroadcast(t), { f, db, as } = fixture, events = [];
  await db.query('UPDATE app_private.hermes_connection_tokens SET token_digest=$1', [digest]);
  const expiresAt = (Math.floor(Date.now() / 1000) + 3600) * 1000;
  const accessToken = ['header', Buffer.from(JSON.stringify({ role: 'authenticated', sub: USER, session_id: SESSION, exp: expiresAt / 1000 })).toString('base64url'), 'signature'].join('.');
  const crypto = createSessionCrypto({ activeKeyVersion: 'test', keys: new Map([['test', randomBytes(32)]]) }); t.after(() => crypto.destroy());
  const envelope = crypto.seal({ accessToken, refreshToken: 'SYNTHETIC_REFRESH', expiresAt }, { assistantId: ASSISTANT, userId: USER, organizationId: ORG, sessionId: SESSION });
  await db.query('UPDATE app_private.hermes_sessions SET envelope=$1::jsonb,expires_at=to_timestamp($2/1000.0)', [JSON.stringify(envelope), expiresAt]);
  const dependencyScope = createDependencyScope(); t.after(() => dependencyScope.close());
  const state = { loseAck: false, writes: 0 };
  const transport = async (url, options) => {
    assert.equal(options.headers.authorization, 'Bearer ' + accessToken);
    assert.equal(new URL(url).pathname, PATH);
    const args = JSON.parse(options.body);
    assert.deepEqual(Object.keys(args), ['p']);
    events.push(`sql:${args.p.operation}`);
    try {
      const result = await as('SELECT public.hermes_zalo_broadcast_v1($1::jsonb) v', [JSON.stringify(args.p)]);
      if (['send', 'cancel', 'update'].includes(args.p.operation)) { state.writes++; if (state.loseAck) { state.loseAck = false; throw new Error('synthetic_ack_lost'); } }
      return Response.json(result);
    } catch (error) {
      if (!error.code) throw error;
      return Response.json({ code: error.code, message: error.message, details: null, hint: null }, { status: error.code === '42501' ? 403 : error.code === 'PT409' ? 409 : 400 });
    }
  };
  const grants = { read: ['chat_zalo.view'], action: ['chat_zalo.manage_automation', 'chat_zalo.send'] };
  const auth = { async verifySession() { return { userId: USER, sessionId: SESSION, expiresAt }; }, async readAuthorization() { return {
    userId: USER, isSuperadmin: false, activeOrganizationIds: [ORG], epoch: 'base', membership: { organizationId: ORG, status: 'ACTIVE', revokedAt: null, validFrom: null,
      validTo: null, membershipId: USER, authorizationVersion: 1 }, permissions: structuredClone(grants), companyCeilings: structuredClone(grants),
    scopesByPermission: Object.fromEntries([...grants.read, ...grants.action].map(key => [key, { buildingIds: [], cashbookIds: [] }])) }; } };
  const connectionStore = createDurableConnectionStore({ transport: { async call(operation, payload) {
    assert.equal(operation, 'readConnection'); return f.rpc('app_private.hermes_store_read_connection_v1', payload); } } });
  const authority = createDurableAuthority({ connectionStore, crypto, auth });
  const supabase = { url: 'https://example.invalid/', publishableKey: 'sb_publishable_test' };
  const zaloBroadcasts = createZaloBroadcastService({ authority, connectionStore, crypto, auth, supabase, dependencyScope, fetch: transport });
  const broker = createBroker({ authority, zaloBroadcasts, dependencyScope, audit: async entry => { events.push(`audit:${entry.outcome}`); } });
  const server = createMcpHttpServer({ broker, allowedHosts: ['127.0.0.1'], allowedOrigins: [] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  let rpcId = 0;
  const mcp = async (name, args = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
    assert.equal(response.status, 200); const message = await response.json();
    return { isError: message.result.isError, value: JSON.parse(message.result.content[0].text), raw: JSON.stringify(message) };
  };
  return { ...fixture, broker, mcp, events, state, accessToken };
}

test('MCP: status → recipients by label → requestId → send; lost ACK reconciles by the same requestId, never a second run', { timeout: 120000 }, async t => {
  const { broker, mcp, events, state, db, setConfig, scalar, accessToken } = await compose(t);
  await setConfig(WHOLE_DAY);
  assert.deepEqual((await broker.listTools(token)).tools.map(tool => tool.name).sort(), ['crm_new_request_id', 'crm_zalo_broadcast_cancel',
    'crm_zalo_broadcast_recipients', 'crm_zalo_broadcast_send', 'crm_zalo_broadcast_status', 'crm_zalo_broadcast_update']);
  const status = await mcp('crm_zalo_broadcast_status');
  assert.equal(status.isError, false); assert.match(status.value.version, /^[0-9a-f]{64}$/);
  const found = await mcp('crm_zalo_broadcast_recipients', { labelName: 'Group MG IHOME' });
  assert.deepEqual(found.value.groups.map(group => group.conversationId).sort(), [G1, G2].sort());
  assert.deepEqual(found.value.labels.map(label => label.key).sort(), [`${ACCOUNT}:1`, `${ACCOUNT2}:1`].sort());
  const requestId = (await mcp('crm_new_request_id')).value.requestId;
  const input = { requestId, conversationIds: found.value.groups.map(group => group.conversationId) };
  events.length = 0; state.loseAck = true;
  const unknown = await mcp('crm_zalo_broadcast_send', input);
  assert.deepEqual([unknown.isError, unknown.value], [true, { error: 'zalo_broadcast_outcome_unknown', requestId }]);
  assert.ok(events.indexOf('audit:prepared') < events.indexOf('sql:send'), 'audited before the write');
  assert.equal(events.filter(event => event === 'sql:send').length, 1, 'ACK loss is never retried');
  const again = await mcp('crm_zalo_broadcast_send', input);
  assert.deepEqual([again.value.ok, again.value.reused, again.value.oneshot.mode, again.value.oneshot.origin], [true, true, 'full', 'hermes']);
  assert.equal(await scalar('SELECT count(*)::int v FROM public.zalo_automation_oneshots'), 1);
  assert.equal(state.writes, 2);
  const listed = await mcp('crm_zalo_broadcast_status');
  assert.deepEqual(listed.value.oneshots.map(item => [item.oneshotId, item.requestId]), [[again.value.oneshot.oneshotId, requestId]]);
  // Not yet claimed by the worker: still cancellable; a second cancel is reused.
  const cancel = await mcp('crm_zalo_broadcast_cancel', { oneshotId: again.value.oneshot.oneshotId });
  assert.deepEqual([cancel.value.ok, cancel.value.reused, cancel.value.oneshot.status], [true, false, 'cancelled']);
  assert.equal((await mcp('crm_zalo_broadcast_cancel', { oneshotId: again.value.oneshot.oneshotId })).value.reused, true);
  assert.equal(await scalar('SELECT status v FROM public.zalo_automation_oneshots'), 'cancelled');
  assert.equal(JSON.stringify([status, found, unknown, again, listed, cancel]).includes(accessToken), false);
  assert.equal(JSON.stringify(await db.query('SELECT * FROM public.fixture_audit')).includes(accessToken), false);
});

test('MCP update: version from status, only requested fields, stale version refused; overlay removal hides writes', { timeout: 120000 }, async t => {
  const { broker, mcp, db, setConfig, row } = await compose(t);
  await setConfig({ ...WHOLE_DAY, template: { introText: 'Mẫu riêng' }, recipients: [G1] });
  const { version } = (await mcp('crm_zalo_broadcast_status')).value;
  const requestId = (await mcp('crm_new_request_id')).value.requestId;
  const patch = { requestId, expectedVersion: version, enabled: true, time: '9:00', days: { sun: 'full' }, addConversationIds: [G4] };
  const applied = await mcp('crm_zalo_broadcast_update', patch);
  assert.deepEqual([applied.value.ok, applied.value.changed], [true, ['enabled', 'time', 'days', 'recipients']]);
  assert.deepEqual((await row()).config, { ...WHOLE_DAY, template: { introText: 'Mẫu riêng' }, recipients: [G1, G4], schedule: { time: '09:00', days: { sun: 'full' } } });
  assert.equal((await mcp('crm_zalo_broadcast_update', patch)).value.reused, true);
  const stale = await mcp('crm_zalo_broadcast_update', { ...patch, requestId: (await mcp('crm_new_request_id')).value.requestId, enabled: false });
  assert.deepEqual([stale.isError, stale.value.ok, stale.value.code], [false, false, 'cau_hinh_vua_doi']);
  assert.equal((await row()).enabled, true);
  await db.exec("UPDATE app_private.hermes_connections SET action_capabilities='{}'");
  assert.deepEqual((await broker.listTools(token)).tools.map(tool => tool.name).sort(), ['crm_zalo_broadcast_recipients', 'crm_zalo_broadcast_status']);
  assert.equal((await mcp('crm_zalo_broadcast_update', { ...patch, expectedVersion: applied.value.settings.version })).value.error, 'tool_not_available');
});
