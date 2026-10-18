import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// external-group-mount nạp broker.mjs ngược lại: nạp trước (như tool-argument-shape.test.mjs).
import './external-group-mount.mjs';
import { createBroker } from './broker.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
import { ROOM_PASS_TOOLS, roomPassInput } from './room-pass-contract.mjs';
import * as guard from './public-text-guard.mjs';

const { CONFIRM_TTL_MS, PUBLIC_TEXT_TOOLS, splitConfirmToken } = guard;
// Rào chữ công khai: mọi lần ghi chữ tự do mới ra trang công khai đều qua xác nhận hai bước, bất kể
// kết nối đã đọc gì trước đó. Broker thật, cổng dịch vụ giả ghi lại mọi lần prepare.
const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const TOKEN_A = `hc_${'A'.repeat(43)}`, TOKEN_B = `hc_${'B'.repeat(43)}`;
const CONNECTIONS = { [TOKEN_A]: id('a'), [TOKEN_B]: id('9') };
const ROOM = id('6'), ROOM2 = id('7'), CUSTOMER = id('5');
const START = Date.parse('2026-10-18T03:00:00.000Z');
const read = ['customers.view', 'contracts.view', 'leads.view', 'cashbooks.view'];
const action = ['sale_phong.manage_pass_listings'];
const upsert = (extra = {}) => ({ requestId: id('1'), roomId: ROOM, salePolicy: '  Điện 3.5k/số; nước 100k/người  ', ...extra });
const CF = /^cf_[A-Za-z0-9_-]{43}$/;

function setup(t) {
  const scope = createDependencyScope(); t.after(() => scope.close());
  const clock = { now: START }, writes = [], reads = [];
  const identity = token => ({ row: { id: CONNECTIONS[token], assistantId: id('b'), userId: id('c'), organizationId: id('d'), expiresAt: START + 86_400_000 * 30,
    epoch: 1, state: 'active', restrictions: { read, action } }, effective: { read, action }, isSuperadmin: false,
  policyEpoch: 'a'.repeat(64), contextVersion: 'b'.repeat(64), assistantScopeIds: [id('e')],
  scopesByPermission: Object.fromEntries([...read, ...action].map(key => [key, { buildingIds: [id('f')], cashbookIds: [] }])) });
  const authority = { identifyConnection: async token => ({ connectionId: CONNECTIONS[token] }), resolve: async token => identity(token), checkUnchanged: async () => {} };
  const audits = [];
  const broker = createBroker({ authority, dependencyScope: scope, audit: async event => { audits.push(event); }, clock: () => clock.now,
    domains: { async prepareDomain(_token, operation, input) { reads.push([operation, input]); return Object.freeze({}); },
      async finalizeDomain() { return { items: [] }; } },
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
  return { broker, clock, writes, reads, audits, call, refused };
}

test('danh sách và schema: trường rào có trong schema; không còn trạng thái theo lịch sử đọc', () => {
  assert.deepEqual(Object.keys(PUBLIC_TEXT_TOOLS), ['crm_room_pass_upsert']);
  assert.deepEqual([...PUBLIC_TEXT_TOOLS.crm_room_pass_upsert.fields], ['customerName', 'customerPhone', 'salePolicy']);
  const tool = ROOM_PASS_TOOLS.find(value => value.name === 'crm_room_pass_upsert');
  for (const field of [...PUBLIC_TEXT_TOOLS.crm_room_pass_upsert.fields, PUBLIC_TEXT_TOOLS.crm_room_pass_upsert.object, 'confirmToken'])
    assert.ok(Object.hasOwn(tool.inputSchema.properties, field), field);
  assert.match(tool.description, /lần đầu luôn nhận confirmation_required = CHƯA ghi: cho người dùng xem nguyên văn preview, chỉ gọi lại kèm confirmToken khi họ đồng ý rõ ràng/);
  // Rào không phụ thuộc dấu đọc riêng: module và broker không còn API gắn dấu.
  assert.deepEqual(Object.keys(guard).sort(), ['CONFIRM_TTL_MS', 'PUBLIC_TEXT_TOOLS', 'createPublicTextGuard', 'splitConfirmToken']);
  for (const file of ['./broker.mjs', './server.mjs']) {
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
    assert.doesNotMatch(source, /markPrivateRead|privateRead|StartTainted/, file);
  }
  // Tool khác không nhận confirmToken: đối số giữ nguyên để validator từ chối như cũ.
  const other = { requestId: id('1'), confirmToken: `cf_${'x'.repeat(43)}` };
  assert.equal(splitConfirmToken('crm_room_pass_set_active', other).args, other);
  assert.deepEqual(splitConfirmToken('crm_room_pass_upsert', { ...upsert(), confirmToken: ' ' }), { args: upsert(), confirmToken: undefined, invalid: false });
  assert.equal(splitConfirmToken('crm_room_pass_upsert', { ...upsert(), confirmToken: 'abc' }).invalid, true);
  const accessor = Object.defineProperty(upsert(), 'confirmToken', { enumerable: true, get: () => `cf_${'x'.repeat(43)}` });
  assert.equal(splitConfirmToken('crm_room_pass_upsert', accessor).invalid, true);
});

test('lần đầu LUÔN confirmation_required + preview nguyên văn, không ghi — bất kể đã đọc gì hay bao lâu', async t => {
  const env = setup(t);
  const expectConfirmation = async (token, args, preview, label) => {
    const before = env.writes.length;
    const first = await env.call(token, 'crm_room_pass_upsert', args);
    assert.equal(env.writes.length, before, `không ghi: ${label}`);
    assert.equal(first.outcome, 'confirmation_required', label); assert.equal(first.applied, false);
    assert.equal(first.tool, 'crm_room_pass_upsert'); assert.equal(first.roomId, args.roomId);
    assert.deepEqual(first.preview, preview, label);
    assert.match(first.confirmToken, CF);
    assert.equal(first.expiresAt, new Date(env.clock.now + CONFIRM_TTL_MS).toISOString());
    assert.match(first.huongDan, /nguyên văn preview/);
    return first;
  };
  // Kết nối mới, chưa đọc gì.
  await expectConfirmation(TOKEN_A, upsert(), { salePolicy: 'Điện 3.5k/số; nước 100k/người' }, 'chưa đọc gì');
  // Từng trường riêng lẻ đều bị rào; chuỗi đã chuẩn hoá là thứ được xem trước.
  await expectConfirmation(TOKEN_B, { requestId: id('2'), roomId: ROOM, customerName: ' Anh Bình ' }, { customerName: 'Anh Bình' }, 'chỉ tên');
  await expectConfirmation(TOKEN_B, { requestId: id('2'), roomId: ROOM, customerPhone: '+84 354 058 160' }, { customerPhone: '0354058160' }, 'chỉ SĐT');
  // Sau đọc không mang nhãn riêng tư, sau đọc riêng, và rất lâu sau đó: hành vi không đổi.
  await env.call(TOKEN_A, 'crm_read_leads', {});
  await expectConfirmation(TOKEN_A, upsert({ requestId: id('3') }), { salePolicy: 'Điện 3.5k/số; nước 100k/người' }, 'sau crm_read_leads');
  await env.call(TOKEN_A, 'crm_read_customer_detail', { customerId: CUSTOMER });
  env.clock.now += 7 * 86_400_000;
  const args = upsert({ requestId: id('4'), customerName: 'Chị Lan', passPrice: 3_500_000 });
  await expectConfirmation(TOKEN_A, args, { customerName: 'Chị Lan', salePolicy: 'Điện 3.5k/số; nước 100k/người' }, 'một tuần sau');
  assert.equal(env.reads.length, 2, 'đọc vẫn chạy bình thường');
  assert.deepEqual(env.writes, []);
});

test('token đúng ⇒ ghi đúng đầu vào CRM (confirmToken không tới CRM)', async t => {
  const env = setup(t);
  const args = upsert({ customerName: ' Anh Bình ', customerPhone: '+84 354 058 160', passPrice: 3_500_000 });
  const first = await env.call(TOKEN_A, 'crm_room_pass_upsert', args);
  assert.deepEqual(first.preview, { customerName: 'Anh Bình', customerPhone: '0354058160', salePolicy: 'Điện 3.5k/số; nước 100k/người' });
  env.clock.now += CONFIRM_TTL_MS - 1;
  assert.deepEqual(await env.call(TOKEN_A, 'crm_room_pass_upsert', { ...args, confirmToken: first.confirmToken }), { outcome: 'applied' });
  assert.deepEqual(env.writes, [['upsert', roomPassInput('upsert', args)]]);
  assert.ok(env.audits.some(event => event.outcome === 'prepared'));
});

test('chỉ đổi giá/ngày/cờ, chuỗi trống hoặc null ⇒ ghi thẳng, không cần xác nhận', async t => {
  const env = setup(t);
  const plain = [{ passPrice: 3_600_000 }, { availDate: '2026-11-01', active: false, contactManager: true }, { salePolicy: '  ', customerName: '', customerPhone: '' },
    { salePolicy: null, customerName: null, customerPhone: null }];
  for (const [index, value] of plain.entries()) {
    const args = { requestId: id(String(index + 1)), roomId: ROOM, ...value };
    assert.deepEqual(await env.call(TOKEN_A, 'crm_room_pass_upsert', args), { outcome: 'applied' }, JSON.stringify(value));
    assert.deepEqual(env.writes.at(-1), ['upsert', roomPassInput('upsert', args)]);
  }
  assert.equal(env.writes.length, plain.length);
});

test('token sai, dùng lại, hết hạn, đổi nội dung, đổi phòng, khác kết nối ⇒ từ chối, không ghi', async t => {
  const env = setup(t);
  const issue = async (token = TOKEN_A, args = upsert()) => (await env.call(token, 'crm_room_pass_upsert', args)).confirmToken;
  // Sai: đúng dạng nhưng không do broker cấp; sai dạng ⇒ invalid_request.
  await env.refused(TOKEN_A, { ...upsert(), confirmToken: `cf_${'Q'.repeat(43)}` });
  await env.refused(TOKEN_A, { ...upsert(), confirmToken: 'cf_ngan' }, 'invalid_request');
  await env.refused(TOKEN_A, { ...upsert(), confirmToken: 42 }, 'invalid_request');
  // Dùng lại.
  const once = await issue();
  assert.deepEqual(await env.call(TOKEN_A, 'crm_room_pass_upsert', { ...upsert(), confirmToken: once }), { outcome: 'applied' });
  await env.refused(TOKEN_A, { ...upsert(), confirmToken: once });
  // Hết hạn đúng 10 phút.
  const late = await issue();
  env.clock.now += CONFIRM_TTL_MS;
  await env.refused(TOKEN_A, { ...upsert(), confirmToken: late });
  // Đổi nội dung chữ: token mất luôn, kể cả khi trình lại đúng nội dung cũ.
  const changed = await issue();
  await env.refused(TOKEN_A, { ...upsert({ salePolicy: 'Điện 4k/số' }), confirmToken: changed });
  await env.refused(TOKEN_A, { ...upsert(), confirmToken: changed });
  const added = await issue();
  await env.refused(TOKEN_A, { ...upsert({ customerName: 'Chị Lan' }), confirmToken: added });
  const phone = await issue(TOKEN_A, upsert({ customerPhone: '0354058160' }));
  await env.refused(TOKEN_A, { ...upsert({ customerPhone: '0354058161' }), confirmToken: phone });
  // Đổi đối tượng (phòng khác).
  const room = await issue();
  await env.refused(TOKEN_A, { ...upsert({ roomId: ROOM2 }), confirmToken: room });
  // Khác kết nối cầm token của A; sau lần trình sai token cũng không còn cho A.
  const foreign = await issue();
  await env.refused(TOKEN_B, { ...upsert(), confirmToken: foreign });
  await env.refused(TOKEN_A, { ...upsert(), confirmToken: foreign });
  // Đồng hồ lùi: token coi như hết hạn.
  const skew = await issue();
  env.clock.now -= 1;
  await env.refused(TOKEN_A, { ...upsert(), confirmToken: skew });
  assert.equal(env.writes.length, 1, 'chỉ một lần ghi với token đúng');
  // Sổ audit ghi đúng mã từ chối (host-ownership.mjs nhận mã này).
  assert.ok(env.audits.some(event => event.outcome === 'denied' && event.code === 'confirmation_invalid'));
});
