import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setupUpsert, fullReadChain, ROOM, LISTING, PHONE, binding } from './room-pass-upsert-sql-fixture.mjs';
import { extract, forward } from './room-pass-sql-fixture.mjs';
import { USER, ORG, FOREIGN, SESSION, ASSISTANT, id } from '../hermes-zalo-router/private-command-fixture.mjs';
import { createRoomPassAuth, createRoomPassReads, createRoomPassService } from './room-pass-adapter.mjs';
import { createBroker } from './broker.mjs';
import { createMcpHttpServer } from './mcp-http.mjs';
import { createDurableAuthority } from './durable-authority.mjs';
import { createDurableConnectionStore } from './durable-connection-store.mjs';
import { createSessionCrypto } from './session-crypto.mjs';
import { createDependencyScope } from './dependency-scope.mjs';

const token = 'hc_' + 'B'.repeat(43), digest = createHash('sha256').update(token).digest('hex');
const req = n => `0f0f0f0f-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PATHS = Object.freeze({ capability: '/rest/v1/rpc/hermes_room_pass_capabilities_v1', v1: '/rest/v1/rpc/hermes_room_pass_action_v1',
  upsert: '/rest/v1/rpc/hermes_room_pass_upsert_v1', full: '/rest/v1/rpc/hermes_room_pass_upsert_v2' });

async function compose(t) {
  const fixture = await setupUpsert(t, { fullRead: fullReadChain() }), { f, db, rpc, call, call2 } = fixture, events = [];
  await db.exec(extract(forward, 'app_private.hermes_store_read_connection_v1'));
  await db.query('UPDATE app_private.hermes_connection_tokens SET token_digest=$1', [digest]);
  // Read customers.view kept: the private reply may show the full phone (P2, review 9aef3a21).
  await db.exec("UPDATE app_private.hermes_connections SET read_capabilities='{customers.view}';UPDATE app_private.hermes_org_policies SET read_capabilities='{customers.view}'");
  const expiresAt = (Math.floor(Date.now() / 1000) + 3600) * 1000;
  const accessToken = ['header', Buffer.from(JSON.stringify({ role: 'authenticated', sub: USER, session_id: SESSION, exp: expiresAt / 1000 })).toString('base64url'), 'signature'].join('.');
  const crypto = createSessionCrypto({ activeKeyVersion: 'test', keys: new Map([['test', randomBytes(32)]]) }); t.after(() => crypto.destroy());
  const envelope = crypto.seal({ accessToken, refreshToken: 'SYNTHETIC_REFRESH', expiresAt }, { assistantId: ASSISTANT, userId: USER, organizationId: ORG, sessionId: SESSION });
  await db.query('UPDATE app_private.hermes_sessions SET envelope=$1::jsonb,expires_at=to_timestamp($2/1000.0)', [JSON.stringify(envelope), expiresAt]);
  const dependencyScope = createDependencyScope(); t.after(() => dependencyScope.close());
  // fullAbsent = connector before the full-read migration (v2 missing); upsertAbsent
  // = before the v1 upsert migration too (then v2, which wraps v1, is missing as well).
  const state = { loseAck: false, upsertAbsent: false, fullAbsent: false, writes: 0 };
  const transport = async (url, options) => {
    assert.equal(options.headers.authorization, 'Bearer ' + accessToken);
    const path = new URL(url).pathname, args = JSON.parse(options.body);
    assert.ok(Object.values(PATHS).includes(path), path);
    if (path === PATHS.full && (state.fullAbsent || state.upsertAbsent) || path === PATHS.upsert && state.upsertAbsent) {
      events.push(`absent${path === PATHS.full ? '2' : ''}:${args.p_operation}`);
      return Response.json({ code: 'PGRST202', message: 'Could not find the function', details: null, hint: null }, { status: 404 });
    }
    events.push(path === PATHS.capability ? 'capability' : `${path === PATHS.full ? 'upsert2' : path === PATHS.upsert ? 'upsert' : 'v1'}:${args.p_operation}`);
    try {
      const result = path === PATHS.capability ? await rpc('capabilities', {}) : path === PATHS.v1 ? await rpc(args.p_operation, args.p_input, args.p_binding)
        : path === PATHS.full ? await call2(args.p_operation, args.p_input, args.p_binding) : await call(args.p_operation, args.p_input, args.p_binding);
      if ([PATHS.upsert, PATHS.full].includes(path) && args.p_operation === 'upsert') { state.writes++; if (state.loseAck) { state.loseAck = false; throw new Error('synthetic_ack_lost'); } }
      return Response.json(result);
    } catch (error) {
      if (!error.code) throw error;
      return Response.json({ code: error.code, message: error.message, details: null, hint: null }, { status: error.code === '42501' ? 403 : error.code === 'PT409' ? 409 : 400 });
    }
  };
  const supabase = { url: 'https://example.invalid/', publishableKey: 'sb_publishable_test' };
  const baseAuth = { async verifySession() { return { userId: USER, sessionId: SESSION, expiresAt }; }, async readAuthorization() { return {
    userId: USER, isSuperadmin: false, activeOrganizationIds: [ORG], epoch: 'base', membership: { organizationId: ORG, status: 'ACTIVE', revokedAt: null, validFrom: null, validTo: null,
      membershipId: USER, authorizationVersion: 1 }, permissions: { read: [], action: [] }, companyCeilings: { read: [], action: [] }, scopesByPermission: {} }; } };
  const auth = createRoomPassAuth({ baseAuth, reads: createRoomPassReads({ ...supabase, fetch: transport, dependencyScope }) });
  const connectionStore = createDurableConnectionStore({ transport: { async call(operation, payload) { assert.equal(operation, 'readConnection'); return f.rpc('app_private.hermes_store_read_connection_v1', payload); } } });
  const authority = createDurableAuthority({ connectionStore, crypto, auth });
  const roomPass = createRoomPassService({ authority, connectionStore, crypto, auth, supabase, dependencyScope, fetch: transport });
  const broker = createBroker({ authority, roomPass, dependencyScope, audit: async entry => { events.push(`audit:${entry.outcome}`); } });
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

test('MCP pass message flow: lookup → requestId → upsert through bound JWT SQL; ACK loss reconciles by status, never re-writes', { timeout: 90000 }, async t => {
  const { broker, mcp, events, state, db, count, accessToken } = await compose(t);
  assert.deepEqual((await broker.listTools(token)).tools.map(tool => tool.name).sort(), ['crm_new_request_id', 'crm_room_lookup', 'crm_room_pass_observe',
    'crm_room_pass_set_active', 'crm_room_pass_status', 'crm_room_pass_upsert']);
  const lookup = await mcp('crm_room_lookup', { buildingName: '417/57 Lê Văn Thọ', roomCode: '103' });
  assert.equal(lookup.isError, false); assert.deepEqual(lookup.value.rooms.map(room => room.roomId), [ROOM]);
  // 16/10: trả lời riêng người hỏi thấy SĐT đầy đủ như web (v2); nhóm không đi đường này.
  assert.deepEqual(lookup.value.rooms[0].representative, { name: 'Nguyễn Duẩn', phone: PHONE }, 'full phone for the private reply');
  const issued = await mcp('crm_new_request_id'); assert.match(issued.value.requestId, /^[0-9a-f-]{36}$/);
  const requestId = issued.value.requestId;
  const input = { requestId, roomId: ROOM, customerPhone: '0900 000 001', customerName: 'Duẩn', passPrice: 3500000, availDate: '2026-11-01',
    salePolicy: 'Điện 3.5k; nước 100k/người; phí DV 150k/phòng; tối đa 2 người 2 xe', contactManager: false, active: true };
  // Rào chữ công khai (public-text-guard.mjs): có tên/SĐT/chính sách ⇒ lần đầu chỉ trả bản xem trước, không chạm SQL.
  events.length = 0;
  const preview = await mcp('crm_room_pass_upsert', input);
  assert.equal(preview.isError, false); assert.equal(preview.value.outcome, 'confirmation_required');
  assert.deepEqual(preview.value.preview, { customerName: 'Duẩn', customerPhone: '0900000001', salePolicy: input.salePolicy });
  assert.equal(events.some(event => event.endsWith(':upsert')), false); assert.equal(state.writes, 0);
  const confirmed = { ...input, confirmToken: preview.value.confirmToken };
  events.length = 0; state.loseAck = true;
  const unknown = await mcp('crm_room_pass_upsert', confirmed);
  assert.equal(unknown.isError, true); assert.deepEqual(unknown.value, { error: 'room_pass_outcome_unknown', requestId });
  assert.ok(events.indexOf('audit:prepared') < events.indexOf('upsert2:upsert'), 'audited before the write');
  assert.equal(events.filter(event => event.endsWith(':upsert')).length, 1, 'ACK loss is never retried (nor routed to v1)');
  assert.equal(state.writes, 1);
  const status = await mcp('crm_room_pass_status', { requestId });
  assert.equal(status.value.outcome, 'applied'); assert.equal(status.value.change, 'created'); assert.equal(status.value.contactSource, 'provided');
  assert.deepEqual(status.value.contact, { name: 'Duẩn', phone: '0900000001' });
  // Token đã dùng; gọi lại cùng requestId vẫn xin xác nhận, rồi SQL trả biên nhận cũ chứ không ghi lại.
  assert.deepEqual((await mcp('crm_room_pass_upsert', confirmed)).value, { error: 'confirmation_invalid' });
  const again = await mcp('crm_room_pass_upsert', input);
  assert.equal(again.value.outcome, 'confirmation_required');
  const replay = await mcp('crm_room_pass_upsert', { ...input, confirmToken: again.value.confirmToken });
  assert.deepEqual(replay.value, status.value, 'retry with the same requestId returns the receipt');
  assert.equal(await count('public.room_pass_listings'), 2);
  const stored = (await db.query('SELECT contact_phone,pass_price::text,avail_date::text,active FROM public.room_pass_listings WHERE id=$1', [status.value.listing.listingId])).rows[0];
  assert.deepEqual(stored, { contact_phone: '0900000001', pass_price: '3500000', avail_date: '2026-11-01', active: true });
  const driftPreview = await mcp('crm_room_pass_upsert', { ...input, passPrice: 3600000 });
  const drift = await mcp('crm_room_pass_upsert', { ...input, passPrice: 3600000, confirmToken: driftPreview.value.confirmToken });
  assert.deepEqual(drift.value, { error: 'context_changed' }, 'a reused requestId cannot carry another intent');
  for (const extra of [{ userId: FOREIGN }, { organizationId: FOREIGN }, { rpc: 'upsert_room_pass_listing' }, { listingId: LISTING }])
    assert.equal((await mcp('crm_room_pass_upsert', { ...input, requestId: req(9), ...extra })).value.error, 'invalid_request');
  assert.equal((await mcp('crm_room_pass_upsert', { ...input, requestId: req(9), passPrice: 0 })).value.error, 'invalid_request');
  assert.equal(JSON.stringify([preview, unknown, status, replay]).includes(accessToken), false);
  // The Action overlay is re-read per call: removing it hides every tool.
  await db.exec("UPDATE app_private.hermes_connections SET action_capabilities='{}'");
  assert.equal((await mcp('crm_room_lookup', { buildingName: 'Lê Văn Thọ', roomCode: '103' })).value.error, 'tool_not_available');
  assert.deepEqual((await broker.listTools(token)).tools, []);
});

test('connector before the full-read migration: lookup/upsert fail closed; status reads a v1 upsert receipt (masked contact) through v1', { timeout: 90000 }, async t => {
  const { mcp, events, state, call, count } = await compose(t);
  const bound = { ...binding, tokenDigest: digest };
  const receipt = await call('upsert', { requestId: req(3), roomId: ROOM, customerPhone: '0900000001', customerName: 'Duẩn', passPrice: 3500000 }, bound);
  assert.deepEqual(receipt.contact, { name: 'Duẩn', phoneMasked: '***0001' });
  state.fullAbsent = true; events.length = 0;
  assert.deepEqual((await mcp('crm_room_pass_status', { requestId: req(3) })).value, receipt, 'legacy masked receipt still reconciles');
  assert.deepEqual(events.filter(event => !event.startsWith('audit') && event !== 'capability'), ['absent2:status', 'upsert:status']);
  assert.deepEqual((await mcp('crm_room_pass_upsert', { requestId: req(4), roomId: ROOM, passPrice: 3500000 })).value, { error: 'backend_unavailable' });
  assert.equal((await mcp('crm_room_lookup', { buildingName: 'Lê Văn Thọ', roomCode: '103' })).value.error, 'backend_unavailable');
  assert.equal(events.some(event => event === 'upsert:upsert' || event === 'upsert:lookup'), false, 'never silently routed to the masked v1 path');
  assert.equal(await count('public.room_pass_listings'), 2);
  state.fullAbsent = false;
  assert.deepEqual((await mcp('crm_room_pass_status', { requestId: req(3) })).value.contact, { name: 'Duẩn', phone: '0900000001' }, 'v2 unmasks the same receipt');
});

test('connector before migration: upsert/lookup fail closed, status falls back to the applied v1 receipt reader', { timeout: 90000 }, async t => {
  const { mcp, events, state, rpc, count } = await compose(t);
  const bound = { ...binding, tokenDigest: digest };
  const observed = await rpc('observe', { listingId: LISTING }, bound);
  const applied = await rpc('set_active', { requestId: req(1), listingId: LISTING, active: true, expectedRevision: observed.listing.revision }, bound);
  state.upsertAbsent = true; events.length = 0;
  assert.deepEqual((await mcp('crm_room_pass_status', { requestId: req(1) })).value, applied);
  assert.deepEqual(events.filter(event => !event.startsWith('audit') && event !== 'capability'), ['absent2:status', 'absent:status', 'v1:status']);
  const missing = await mcp('crm_room_pass_upsert', { requestId: req(2), roomId: ROOM, passPrice: 3500000 });
  assert.deepEqual(missing.value, { error: 'backend_unavailable' }, 'PGRST202 is a confirmed rejection, not an unknown write');
  assert.equal((await mcp('crm_room_lookup', { buildingName: 'Lê Văn Thọ', roomCode: '103' })).value.error, 'backend_unavailable');
  assert.equal(events.some(event => ['v1:upsert', 'v1:lookup', 'upsert:upsert', 'upsert:lookup'].includes(event)), false, 'never routed to an older RPC');
  assert.equal(await count('public.room_pass_listings'), 1);
  state.upsertAbsent = false;
  assert.deepEqual((await mcp('crm_room_pass_status', { requestId: req(1) })).value, applied, 'v2 reader answers v1 receipts too');
  assert.deepEqual((await mcp('crm_room_pass_status', { requestId: id('9') })).value, { requestId: id('9'), outcome: 'not_found', listing: null });
});
