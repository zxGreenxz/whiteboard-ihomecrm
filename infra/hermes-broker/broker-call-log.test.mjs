import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { BrokerError, createBroker } from './broker.mjs';

const USER = '10000000-0000-4000-8000-000000000001';
const ORG = '20000000-0000-4000-8000-000000000001';
const CONNECTION = '30000000-0000-4000-8000-000000000001';
const BUILDING = '50000000-0000-4000-8000-000000000001';
const ROOM_SCOPE = '60000000-0000-4000-8000-000000000001';
const rights = { read: ['assistant.context.read', 'rooms.view'], action: ['rooms.edit'] };
// Đúng tập khoá, đúng thứ tự: một dòng journal mỗi lần invoke, không có gì khác.
const KEYS = ['event', 'ts', 'operation', 'tool', 'path', 'identifyMs', 'resolveMs', 'handlerMs', 'auditMs', 'checkMs',
  'finalizeMs', 'totalMs', 'resultBytes', 'outcome', 'code', 'connection'];
const short = id => createHash('sha256').update(id).digest('hex').slice(0, 8);
const ms = value => Number.isSafeInteger(value) && value >= 0;
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const code = expected => error => error instanceof BrokerError && error.code === expected;

/** P1 auth-adapter broker with in-memory stores: identify = digest read, resolve = Auth, check = second authorize. */
function fixture(options = {}) {
  const records = [];
  const state = { userId: USER, isSuperadmin: false, activeOrganizationIds: [ORG], epoch: '1',
    permissions: structuredClone(rights), companyCeilings: structuredClone(rights),
    membership: { organizationId: ORG, status: 'ACTIVE', revokedAt: null, validFrom: null, validTo: null } };
  const auth = {
    async verifySession({ accessToken }) {
      if (accessToken !== 'jwt-a') throw new Error('sensitive upstream');
      await options.beforeVerify?.();
      return { userId: USER, sessionId: 'jwt-a', expiresAt: 2_000_000 };
    },
    async readAuthorization() { return structuredClone(state); },
  };
  const broker = createBroker({ auth, clock: () => 1_000_000, callLog: options.callLog ?? (record => { records.push(record); }), ...options.broker });
  return { auth, broker, records, issue: () => broker.issueConnection({ accessToken: 'jwt-a', organizationId: ORG, restrictions: rights }) };
}

function roomPayload() {
  return { source: 'hermes_sale_listing_rooms_v1', readAt: new Date(1_000_000).toISOString(), currency: 'VND',
    completeness: 'complete', listing: 'published', notice: null, publishedPages: 1, totalInSnapshot: 1, offset: 0, nextOffset: null, salePolicies: [],
    buildings: [{ id: BUILDING, name: 'House A', code: 'A', address: 'Đường Thử', contact: { name: 'Hotline thử', phone: '0900000001' } }],
    rooms: [{ id: '70000000-0000-4000-8000-000000000001', code: '101', name: '101',
      building: { id: BUILDING, name: 'House A', code: 'A' }, floor: 1, areaM2: 20, priceVnd: 3000000, rentVnd: 3000000,
      depositVnd: 3000000, status: 'free', availability: { kind: 'ready', label: 'Trống sẵn', availableOn: null },
      statusLines: ['TRỐNG SẴN'], roomType: 'Phòng 20m²', amenities: null, salePolicy: null }] };
}

/** Injected authority + durable room service: crm_available_rooms completes on its initial admission (no checkUnchanged). */
function roomFixture() {
  const records = [], branded = new WeakSet(), prepared = new WeakSet();
  const state = { row: { id: CONNECTION, assistantId: '40000000-0000-4000-8000-000000000001', userId: USER, organizationId: ORG,
    state: 'active', epoch: 2, expiresAt: 1_060_000, restrictions: structuredClone(rights) },
    effective: structuredClone(rights), policyEpoch: '1'.repeat(64), isSuperadmin: false, assistantScopeIds: [ROOM_SCOPE],
    scopesByPermission: Object.fromEntries([...rights.read, ...rights.action].map(key => [key, { buildingIds: [], cashbookIds: [] }])),
    contextVersion: '2'.repeat(64) };
  state.scopesByPermission['rooms.view'].buildingIds = [BUILDING];
  const authority = {
    async identifyConnection() { return { connectionId: CONNECTION }; },
    async resolve() { const receipt = structuredClone(state); branded.add(receipt); return receipt; },
    async checkUnchanged(_token, before) { if (!branded.has(before)) throw new BrokerError('context_changed'); },
  };
  const roomReads = {
    async prepareAvailableRooms() { const receipt = Object.freeze({}); prepared.add(receipt); return receipt; },
    async finalizeAvailableRooms(_token, receipt) { assert(prepared.has(receipt)); return roomPayload(); },
  };
  const broker = createBroker({ authority, roomReads, clock: () => 1_000_000, callLog: record => { records.push(record); } });
  return { broker, records, token: `hc_${'a'.repeat(43)}` };
}

test('mỗi lần invoke đúng một record với tập khoá cố định: tools/list, tools/call và authenticate thành công', async () => {
  const f = fixture(); const a = await f.issue();
  assert.equal(f.records.length, 0, 'issueConnection is not an invocation');
  const listed = await f.broker.listTools(a.token);
  assert.equal(f.records.length, 1);
  const list = f.records[0];
  assert.deepEqual(Object.keys(list), KEYS);
  assert.equal(list.event, 'tool_call_timing'); assert.equal(list.ts, '1970-01-01T00:16:40.000Z');
  assert.equal(list.operation, 'tools/list'); assert.equal(list.tool, null); assert.equal(list.path, 'normal');
  for (const key of ['identifyMs', 'resolveMs', 'handlerMs', 'auditMs', 'checkMs', 'totalMs']) assert(ms(list[key]), key);
  assert.equal(list.finalizeMs, null, 'tools/list has no finalizer');
  assert.equal(list.resultBytes, bytes(listed)); assert(list.resultBytes > 0);
  assert.equal(list.outcome, 'ok'); assert.equal(list.code, null); assert.equal(list.connection, short(a.connection.id));

  const reply = await f.broker.callTool(a.token, 'crm_auth_context', {});
  assert.equal(f.records.length, 2);
  const call = f.records[1];
  assert.deepEqual(Object.keys(call), KEYS);
  assert.equal(call.operation, 'tools/call'); assert.equal(call.tool, 'crm_auth_context'); assert.equal(call.path, 'normal');
  assert.equal(call.outcome, 'ok'); assert.equal(call.code, null); assert.equal(call.resultBytes, bytes(reply));
  assert.equal(call.connection, short(a.connection.id)); assert(ms(call.checkMs)); assert(call.totalMs >= call.handlerMs);

  await f.broker.authenticate(a.token);
  assert.equal(f.records.length, 3); assert.equal(f.records[2].operation, 'authenticate'); assert.equal(f.records[2].tool, null);
});

test('lỗi: outcome/code đúng, pha chưa chạy là null, resultBytes 0; tên tool lạ không vào log; token sai không có connection', async () => {
  const f = fixture(); const a = await f.issue();
  await f.broker.restrictConnection(a.connection.id, { read: [], action: [] });
  await assert.rejects(f.broker.callTool(a.token, 'crm_auth_context', {}), code('tool_not_available'));
  assert.equal(f.records.length, 1);
  const denied = f.records[0];
  assert.deepEqual(Object.keys(denied), KEYS);
  assert.equal(denied.tool, 'crm_auth_context'); assert.equal(denied.outcome, 'error'); assert.equal(denied.code, 'tool_not_available');
  assert.equal(denied.resultBytes, 0); assert.equal(denied.connection, short(a.connection.id));
  for (const key of ['identifyMs', 'resolveMs', 'handlerMs', 'totalMs']) assert(ms(denied[key]), key);
  for (const key of ['auditMs', 'checkMs', 'finalizeMs']) assert.equal(denied[key], null, key);

  await assert.rejects(f.broker.callTool(a.token, 'execute_sql', {}), code('tool_not_available'));
  assert.equal(f.records.length, 2); assert.equal(f.records[1].operation, 'tools/call'); assert.equal(f.records[1].tool, null);

  await assert.rejects(f.broker.callTool(`hc_${'x'.repeat(43)}`, 'crm_auth_context', {}), code('unauthorized'));
  assert.equal(f.records.length, 3);
  const unauthorized = f.records[2];
  assert.equal(unauthorized.outcome, 'error'); assert.equal(unauthorized.code, 'unauthorized'); assert.equal(unauthorized.connection, null);
  assert(ms(unauthorized.identifyMs)); assert.equal(unauthorized.resolveMs, null); assert.equal(unauthorized.handlerMs, null);
});

test('timeout giữa pha: pha đang treo ghi số ms đã trôi, pha sau là null, code timeout', async () => {
  let release, hang = null;
  const f = fixture({ broker: { limits: { timeoutMs: 20 } }, beforeVerify: () => hang });
  const a = await f.issue();
  hang = new Promise(resolve => { release = resolve; });
  await assert.rejects(f.broker.callTool(a.token, 'crm_auth_context', {}), code('timeout'));
  assert.equal(f.records.length, 1);
  const record = f.records[0];
  assert.deepEqual(Object.keys(record), KEYS);
  assert.equal(record.outcome, 'error'); assert.equal(record.code, 'timeout'); assert.equal(record.resultBytes, 0);
  assert(ms(record.identifyMs)); assert(ms(record.resolveMs) && record.resolveMs >= 10, `resolveMs=${record.resolveMs}`);
  assert.equal(record.handlerMs, null); assert.equal(record.connection, short(a.connection.id));
  assert(record.totalMs >= record.resolveMs);
  release();
});

test('record không chứa tham số, token, JWT, ID đầy đủ hay tên tool do client bịa', async () => {
  const f = fixture(); const a = await f.issue();
  const marker = 'MARKER-0909090909';
  await f.broker.callTool(a.token, 'crm_auth_context', { buildingName: marker }).then(() => {}, error => assert(error instanceof BrokerError));
  await assert.rejects(f.broker.callTool(a.token, `crm_${marker}`, {}), code('tool_not_available'));
  await f.broker.callTool(a.token, 'crm_auth_context', {});
  assert.equal(f.records.length, 3);
  const exposed = JSON.stringify(f.records);
  for (const secret of [marker, a.token, 'jwt-a', a.connection.id, a.connection.assistantId, USER, ORG]) assert(!exposed.includes(secret), secret);
});

test('callLog ném lỗi không đổi kết quả hay mã lỗi; callLog không phải hàm bị từ chối', async () => {
  let calls = 0;
  const f = fixture({ callLog: () => { calls += 1; throw new Error('sink down'); } });
  const a = await f.issue();
  assert.equal((await f.broker.listTools(a.token)).tools.length, 1);
  assert.equal(JSON.parse((await f.broker.callTool(a.token, 'crm_auth_context', {})).content[0].text).userId, USER);
  await assert.rejects(f.broker.callTool(a.token, 'execute_sql', {}), code('tool_not_available'));
  assert.equal(calls, 3);
  assert.throws(() => createBroker({ auth: f.auth, callLog: 'stdout' }), /invalid_call_log/);
});

test("đường room (crm_available_rooms) ghi path 'room', bỏ checkUnchanged (checkMs null) và có finalizeMs", async () => {
  const f = roomFixture();
  const reply = await f.broker.callTool(f.token, 'crm_available_rooms', {});
  assert.equal(f.records.length, 1);
  const room = f.records[0];
  assert.deepEqual(Object.keys(room), KEYS);
  assert.equal(room.tool, 'crm_available_rooms'); assert.equal(room.path, 'room'); assert.equal(room.checkMs, null);
  for (const key of ['identifyMs', 'resolveMs', 'handlerMs', 'auditMs', 'finalizeMs', 'totalMs']) assert(ms(room[key]), key);
  assert.equal(room.outcome, 'ok'); assert.equal(room.code, null); assert.equal(room.resultBytes, bytes(reply));
  assert.equal(room.connection, short(CONNECTION));
  await f.broker.callTool(f.token, 'crm_auth_context', {});
  assert.equal(f.records.length, 2); assert.equal(f.records[1].path, 'normal'); assert(ms(f.records[1].checkMs));
  assert.equal(f.records[1].finalizeMs, null);
});
