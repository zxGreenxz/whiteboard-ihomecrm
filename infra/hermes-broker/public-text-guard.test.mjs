import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// external-group-mount nạp broker.mjs ngược lại: nạp trước (như tool-argument-shape.test.mjs).
import './external-group-mount.mjs';
import { createBroker } from './broker.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
import { DOMAIN_TOOLS } from './domain-contract.mjs';
import { PRIVATE_HINT } from './full-read-contract.mjs';
import { ROOM_PASS_TOOLS, roomPassInput } from './room-pass-contract.mjs';
import { W2 } from './wave2-registry.mjs';
import { CONFIRM_TTL_MS, PRIVATE_READ_TOOLS, PRIVATE_READ_TTL_MS, PUBLIC_TEXT_TOOLS, REPORT_READ_TOOL, privateRead,
  splitConfirmToken } from './public-text-guard.mjs';

// Rào chữ công khai sau khi đọc dữ liệu riêng: broker thật, cổng dịch vụ giả ghi lại mọi lần prepare.
const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const TOKEN_A = `hc_${'A'.repeat(43)}`, TOKEN_B = `hc_${'B'.repeat(43)}`;
const CONNECTIONS = { [TOKEN_A]: id('a'), [TOKEN_B]: id('9') };
const ROOM = id('6'), ROOM2 = id('7'), CUSTOMER = id('5');
const START = Date.parse('2026-10-18T03:00:00.000Z');
const read = ['customers.view', 'contracts.view', 'leads.view', 'cashbooks.view'];
const action = ['sale_phong.manage_pass_listings'];
const upsert = (extra = {}) => ({ requestId: id('1'), roomId: ROOM, salePolicy: '  Điện 3.5k/số; nước 100k/người  ', ...extra });
const CF = /^cf_[A-Za-z0-9_-]{43}$/;

function setup(t, { failRead = false, startTainted = false } = {}) {
  const scope = createDependencyScope(); t.after(() => scope.close());
  const clock = { now: START }, writes = [], reads = [];
  const identity = token => ({ row: { id: CONNECTIONS[token], assistantId: id('b'), userId: id('c'), organizationId: id('d'), expiresAt: START + 86_400_000,
    epoch: 1, state: 'active', restrictions: { read, action } }, effective: { read, action }, isSuperadmin: false,
  policyEpoch: 'a'.repeat(64), contextVersion: 'b'.repeat(64), assistantScopeIds: [id('e')],
  scopesByPermission: Object.fromEntries([...read, ...action].map(key => [key, { buildingIds: [id('f')], cashbookIds: [] }])) });
  const authority = { identifyConnection: async token => ({ connectionId: CONNECTIONS[token] }), resolve: async token => identity(token), checkUnchanged: async () => {} };
  const audits = [];
  const broker = createBroker({ authority, dependencyScope: scope, audit: async event => { audits.push(event); }, clock: () => clock.now,
    publicTextStartTainted: startTainted,
    domains: { async prepareDomain(_token, operation, input) { reads.push([operation, input]); return Object.freeze({}); },
      async finalizeDomain() { if (failRead) throw new Error('read failed'); return { items: [] }; } },
    roomPass: { async prepareRoomPass(_token, operation, input) { writes.push([operation, input]); return Object.freeze({}); },
      async finalizeRoomPass(_token, _receipt, { onDispatch }) { onDispatch(); return { outcome: 'applied' }; } } });
  const call = async (token, name, args) => {
    const result = await broker.callTool(token, name, args);
    return JSON.parse(result.content[0].text);
  };
  const refused = async (token, args, code = 'confirmation_invalid') => {
    const before = writes.length;
    await assert.rejects(broker.callTool(token, 'crm_room_pass_upsert', args), error => error.code === code);
    assert.equal(writes.length, before, 'không ghi');
  };
  const privateLookup = token => call(token, 'crm_read_customer_detail', { customerId: CUSTOMER });
  return { broker, clock, writes, reads, audits, call, refused, privateLookup };
}

test('danh sách: tool đọc riêng = tool mang PRIVATE_HINT; báo cáo theo cờ private; trường rào có trong schema', () => {
  const marked = DOMAIN_TOOLS.filter(tool => tool.name !== REPORT_READ_TOOL && tool.description.includes(PRIVATE_HINT)).map(tool => tool.name).sort();
  assert.deepEqual([...PRIVATE_READ_TOOLS].sort(), marked);
  for (const [reportId, spec] of Object.entries(W2.reports)) assert.equal(privateRead(REPORT_READ_TOOL, { report: reportId }), spec.private === true, reportId);
  for (const input of [{}, { report: 'khong_co' }, { report: '__proto__' }, null]) assert.equal(privateRead(REPORT_READ_TOOL, input), false);
  for (const name of ['crm_read_report_list', 'crm_read_leads', 'crm_available_rooms', 'crm_room_lookup']) assert.equal(privateRead(name, {}), false, name);
  assert.deepEqual(Object.keys(PUBLIC_TEXT_TOOLS), ['crm_room_pass_upsert']);
  const tool = ROOM_PASS_TOOLS.find(value => value.name === 'crm_room_pass_upsert');
  for (const field of [...PUBLIC_TEXT_TOOLS.crm_room_pass_upsert.fields, PUBLIC_TEXT_TOOLS.crm_room_pass_upsert.object, 'confirmToken'])
    assert.ok(Object.hasOwn(tool.inputSchema.properties, field), field);
  assert.match(tool.description, /confirmation_required = CHƯA ghi: cho người dùng xem nguyên văn preview, chỉ gọi lại kèm confirmToken khi họ đồng ý rõ ràng/);
  // Tool khác không nhận confirmToken: đối số giữ nguyên để validator từ chối như cũ.
  const other = { requestId: id('1'), confirmToken: `cf_${'x'.repeat(43)}` };
  assert.equal(splitConfirmToken('crm_room_pass_set_active', other).args, other);
  assert.deepEqual(splitConfirmToken('crm_room_pass_upsert', { ...upsert(), confirmToken: ' ' }), { args: upsert(), confirmToken: undefined, invalid: false });
  assert.equal(splitConfirmToken('crm_room_pass_upsert', { ...upsert(), confirmToken: 'abc' }).invalid, true);
  const accessor = Object.defineProperty(upsert(), 'confirmToken', { enumerable: true, get: () => `cf_${'x'.repeat(43)}` });
  assert.equal(splitConfirmToken('crm_room_pass_upsert', accessor).invalid, true);
});

test('không nhiễm ⇒ ghi thẳng như cũ; đọc không riêng tư hoặc đọc lỗi không nhiễm', async t => {
  const env = setup(t);
  assert.deepEqual(await env.call(TOKEN_A, 'crm_room_pass_upsert', upsert()), { outcome: 'applied' });
  assert.deepEqual(env.writes, [['upsert', roomPassInput('upsert', upsert())]]);
  await env.call(TOKEN_A, 'crm_read_leads', {});
  await env.call(TOKEN_A, 'crm_read_report_list', {});
  assert.deepEqual(await env.call(TOKEN_A, 'crm_room_pass_upsert', upsert({ requestId: id('2') })), { outcome: 'applied' });
  assert.equal(env.writes.length, 2);
  const failing = setup(t, { failRead: true });
  await assert.rejects(failing.privateLookup(TOKEN_A), error => error.code === 'backend_unavailable');
  assert.deepEqual(await failing.call(TOKEN_A, 'crm_room_pass_upsert', upsert()), { outcome: 'applied' }, 'đọc riêng thất bại không nhiễm');
});

test('tiến trình thật: dấu chỉ trong bộ nhớ ⇒ 30 phút đầu sau khởi động mọi kết nối coi như đã đọc riêng', async t => {
  const env = setup(t, { startTainted: true });
  for (const token of [TOKEN_A, TOKEN_B]) {
    const first = await env.call(token, 'crm_room_pass_upsert', upsert());
    assert.equal(first.outcome, 'confirmation_required');
    assert.match(first.confirmToken, CF);
  }
  assert.equal(env.writes.length, 0, 'không ghi khi vừa khởi động');
  env.clock.now = START + PRIVATE_READ_TTL_MS - 1;
  assert.equal((await env.call(TOKEN_A, 'crm_room_pass_upsert', upsert({ requestId: id('2') }))).outcome, 'confirmation_required');
  env.clock.now = START + PRIVATE_READ_TTL_MS;
  assert.deepEqual(await env.call(TOKEN_A, 'crm_room_pass_upsert', upsert({ requestId: id('3') })), { outcome: 'applied' });
  await env.privateLookup(TOKEN_A);
  assert.equal((await env.call(TOKEN_A, 'crm_room_pass_upsert', upsert({ requestId: id('4') }))).outcome, 'confirmation_required');
  assert.deepEqual(await env.call(TOKEN_B, 'crm_room_pass_upsert', upsert({ requestId: id('5') })), { outcome: 'applied' });
  const server = readFileSync(fileURLToPath(new URL('./server.mjs', import.meta.url)), 'utf8');
  assert.match(server, /createBroker\(\{[^}]*publicTextStartTainted: true/s, 'server.mjs phải bật dấu nhiễm lúc khởi động');
});

test('nhiễm ⇒ lần đầu không ghi, trả preview nguyên văn + token; token đúng ⇒ ghi đúng đầu vào CRM', async t => {
  const env = setup(t);
  await env.privateLookup(TOKEN_A);
  const args = upsert({ customerName: ' Anh Bình ', customerPhone: '+84 354 058 160', passPrice: 3_500_000 });
  const first = await env.call(TOKEN_A, 'crm_room_pass_upsert', args);
  assert.deepEqual(env.writes, [], 'lần đầu không ghi');
  assert.equal(first.outcome, 'confirmation_required'); assert.equal(first.applied, false);
  assert.deepEqual(first.preview, { customerName: 'Anh Bình', customerPhone: '0354058160', salePolicy: 'Điện 3.5k/số; nước 100k/người' });
  assert.equal(first.roomId, ROOM); assert.equal(first.tool, 'crm_room_pass_upsert');
  assert.match(first.confirmToken, CF);
  assert.equal(first.expiresAt, new Date(START + CONFIRM_TTL_MS).toISOString());
  assert.match(first.huongDan, /nguyên văn preview/);
  env.clock.now += 60_000;
  assert.deepEqual(await env.call(TOKEN_A, 'crm_room_pass_upsert', { ...args, confirmToken: first.confirmToken }), { outcome: 'applied' });
  assert.deepEqual(env.writes, [['upsert', roomPassInput('upsert', args)]], 'confirmToken không tới CRM');
  // Không có chữ mới (vắng/trống = giữ, null = xoá) ⇒ ghi thẳng dù đang nhiễm.
  for (const value of [{ passPrice: 3_600_000 }, { salePolicy: '  ', customerName: '' }, { salePolicy: null, customerName: null, customerPhone: null }]) {
    const plain = { requestId: id('3'), roomId: ROOM, ...value };
    assert.deepEqual(await env.call(TOKEN_A, 'crm_room_pass_upsert', plain), { outcome: 'applied' }, JSON.stringify(value));
  }
  assert.equal(env.writes.length, 4);
});

test('token sai, dùng lại, hết hạn, đổi nội dung, đổi phòng, khác kết nối ⇒ từ chối, không ghi', async t => {
  const env = setup(t);
  await env.privateLookup(TOKEN_A); await env.privateLookup(TOKEN_B);
  const issue = async (token = TOKEN_A, args = upsert()) => (await env.call(token, 'crm_room_pass_upsert', args)).confirmToken;
  // Sai: đúng dạng nhưng không do broker cấp; sai dạng ⇒ invalid_request.
  await env.refused(TOKEN_A, { ...upsert(), confirmToken: `cf_${'Q'.repeat(43)}` });
  await env.refused(TOKEN_A, { ...upsert(), confirmToken: 'cf_ngan' }, 'invalid_request');
  await env.refused(TOKEN_A, { ...upsert(), confirmToken: 42 }, 'invalid_request');
  // Dùng lại.
  const once = await issue();
  assert.deepEqual(await env.call(TOKEN_A, 'crm_room_pass_upsert', { ...upsert(), confirmToken: once }), { outcome: 'applied' });
  await env.refused(TOKEN_A, { ...upsert(), confirmToken: once });
  // Hết hạn 10 phút (vẫn nhiễm).
  const late = await issue();
  env.clock.now += CONFIRM_TTL_MS;
  await env.refused(TOKEN_A, { ...upsert(), confirmToken: late });
  // Đổi nội dung chữ: token mất luôn, kể cả khi trình lại đúng nội dung cũ.
  const changed = await issue();
  await env.refused(TOKEN_A, { ...upsert({ salePolicy: 'Điện 4k/số' }), confirmToken: changed });
  await env.refused(TOKEN_A, { ...upsert(), confirmToken: changed });
  const added = await issue();
  await env.refused(TOKEN_A, { ...upsert({ customerName: 'Chị Lan' }), confirmToken: added });
  // Đổi đối tượng (phòng khác).
  const room = await issue();
  await env.refused(TOKEN_A, { ...upsert({ roomId: ROOM2 }), confirmToken: room });
  // Khác kết nối (B cũng đang nhiễm) cầm token của A.
  const foreign = await issue();
  await env.refused(TOKEN_B, { ...upsert(), confirmToken: foreign });
  await env.refused(TOKEN_A, { ...upsert(), confirmToken: foreign }, 'confirmation_invalid');
  // Đồng hồ lùi: token coi như hết hạn.
  const skew = await issue();
  env.clock.now -= 1;
  await env.refused(TOKEN_A, { ...upsert(), confirmToken: skew });
  assert.equal(env.writes.length, 1, 'chỉ một lần ghi với token đúng');
  // Sổ audit ghi đúng mã từ chối (host-ownership.mjs nhận mã này).
  assert.ok(env.audits.some(event => event.outcome === 'denied' && event.code === 'confirmation_invalid'));
});

test('dấu nhiễm theo kết nối, hết sau 30 phút kể từ lần đọc riêng cuối; báo cáo private của đợt 2 cũng nhiễm', async t => {
  const env = setup(t);
  await env.privateLookup(TOKEN_A);
  assert.deepEqual(await env.call(TOKEN_B, 'crm_room_pass_upsert', upsert()), { outcome: 'applied' }, 'kết nối B không nhiễm theo A');
  env.clock.now += PRIVATE_READ_TTL_MS - 1;
  assert.equal((await env.call(TOKEN_A, 'crm_room_pass_upsert', upsert())).outcome, 'confirmation_required', '29:59 vẫn nhiễm');
  await env.call(TOKEN_A, 'crm_read_contract_search', {});
  env.clock.now += PRIVATE_READ_TTL_MS - 1;
  assert.equal((await env.call(TOKEN_A, 'crm_room_pass_upsert', upsert())).outcome, 'confirmation_required', 'đọc riêng mới gia hạn từ lần cuối');
  env.clock.now += 1;
  assert.deepEqual(await env.call(TOKEN_A, 'crm_room_pass_upsert', upsert()), { outcome: 'applied' }, 'đủ 30 phút ⇒ hết nhiễm');
  assert.equal(W2.reports.cashbooks.private, true);
  await env.call(TOKEN_B, 'crm_read_report', { report: 'cashbooks' });
  assert.deepEqual(env.reads.at(-1), ['report', { report: 'cashbooks', params: { query: null }, limit: 20, offset: 0 }]);
  assert.equal((await env.call(TOKEN_B, 'crm_room_pass_upsert', upsert())).outcome, 'confirmation_required');
  assert.equal(env.writes.length, 2);
});

// Sổ thật chỉ có báo cáo private: ca "báo cáo KHÔNG private" chạy trong tiến trình con với sổ thăm dò
// (wave2-probe-hooks.fixture.mjs thay sổ gói A bằng probe_rows/probe_org, không private).
test('đọc báo cáo KHÔNG private ⇒ không nhiễm (tiến trình con, sổ thăm dò)', () => {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('./public-text-guard-probe.fixture.mjs', import.meta.url))], { encoding: 'utf8', timeout: 90_000 });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim().split('\n').at(-1));
  assert.deepEqual(result, { probePrivate: false, afterPublicReport: 'applied', afterPrivateReport: 'confirmation_required', writes: 1 });
});
