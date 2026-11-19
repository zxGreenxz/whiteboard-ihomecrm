import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// external-group-mount nạp broker.mjs ngược lại: nạp trước.
import './external-group-mount.mjs';
import { createActionAuth } from './action-adapter.mjs';
import { createActionCatalog } from './action-catalog.mjs';
import { createSaleActionAuth } from './sale-action-adapter.mjs';
import { SALE_ACTIONS } from './sale-action-contract.mjs';
import { SALE_POLICY_CAPABILITIES } from './sale-policy-contract.mjs';
import { CUSTOMER_ACTIONS } from './customer-action-contract.mjs';
import { ROOM_PASS_ACTION } from './room-pass-contract.mjs';
import { TASK_ACTION } from './task-contract.mjs';
import { TASK_PROGRESS_ACTION, TASK_CANCEL_ACTION } from './task-follow-contract.mjs';
import { EXPENSE_ACTIONS } from './expense-actions-contract.mjs';
import { TASK_ACTIONS } from './task-actions-contract.mjs';
import { INVOICE_ACTIONS } from './invoice-actions-contract.mjs';
import { CONTRACT_ACTIONS } from './contract-action-contract.mjs';

// Sự cố TEST 23/10 (connector 82f97339): host bật actionPages contract ⇒ khoá sale_phong.lock_room (contract.room_lock / room_unlock)
// được CẢ lớp thao tác lẫn lớp Sale cấp; lớp sau thấy khoá đã có ⇒ context_changed cho MỌI kết nối (tạo kết nối 409). Sửa: một khoá
// chỉ một nguồn — khoá của lớp Sale do lớp Sale cấp, lớp thao tác mượn (borrowedKeys), như server.mjs nối.
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = id(5), USER = id(1), B1 = id(10), B2 = id(11);
const membership = { membershipId: id(4), authorizationVersion: 1 };
const input = { accessToken: 'jwt', userId: USER, organizationId: ORG, signal: new AbortController().signal };
const base = { verifySession: async () => ({}), readAuthorization: async () => ({ userId: USER, isSuperadmin: false, membership, epoch: 'e',
  permissions: { read: [], action: [] }, companyCeilings: { read: [], action: [] }, scopesByPermission: {} }) };
const capOf = (permissions, extra = {}) => ({ organizationId: ORG, userId: USER, membershipId: id(4), authorizationVersion: 1, isSuperadmin: false,
  policyVersion: 0, permissions, ...extra });
const grant = (allowed, buildingIds = []) => ({ allowed, companyEnabled: allowed, buildingIds: allowed ? buildingIds : [] });
const PRODUCTION = [...EXPENSE_ACTIONS, ...TASK_ACTIONS, ...INVOICE_ACTIONS];
// Chuỗi như server.mjs: … → lớp thao tác → lớp Sale. actionPages contract bật/tắt; capability Sale có/không/tắt khoá.
// hermes_action_capabilities_v1 trả quyền theo MỌI dòng chính sách trong DB, không theo danh mục của connector ⇒ cùng một câu trả lời
// dù host có bật actionPages contract hay không.
const ALL = createActionCatalog([...PRODUCTION, ...CONTRACT_ACTIONS]);
const ACTION_CAP = capOf(Object.fromEntries(ALL.keys.map(key => [key, grant(true, [B1])])), { actions: Object.fromEntries(ALL.ids.map(action => [action, {}])) });
function chain({ contract = true, borrow = true, sale = 'on' } = {}) {
  const catalog = createActionCatalog([...PRODUCTION, ...(contract ? CONTRACT_ACTIONS : [])]);
  const actionCap = structuredClone(ACTION_CAP);
  const actionAuth = createActionAuth({ baseAuth: base, catalog, reads: { capabilities: async () => actionCap },
    borrowedKeys: borrow ? catalog.keys.filter(key => SALE_ACTIONS.includes(key)) : [] });
  const saleCap = sale === 'absent' ? null : capOf(Object.fromEntries(SALE_ACTIONS.map(key => [key, grant(sale === 'on', [B1, B2])])));
  return { catalog, auth: createSaleActionAuth({ baseAuth: actionAuth, reads: { capabilities: async () => saleCap } }) };
}
const effective = authorization => ({ read: authorization.permissions.read, action: authorization.permissions.action });

test('tái hiện: actionPages contract + Sale cùng cấp sale_phong.lock_room (không mượn khoá) ⇒ context_changed', async () => {
  await assert.rejects(chain({ borrow: false }).auth.readAuthorization(input), error => error.code === 'context_changed');
});

test('sửa: một nguồn cấp sale_phong.lock_room (lớp Sale); contract.room_lock / room_unlock chạy nhờ khoá đó; khoá khác của Hợp đồng vẫn từ lớp thao tác', async () => {
  const { catalog, auth } = chain();
  const authorization = await auth.readAuthorization(input);
  assert.equal(authorization.permissions.action.filter(key => key === 'sale_phong.lock_room').length, 1, 'khoá chỉ một lần');
  assert.deepEqual(authorization.scopesByPermission['sale_phong.lock_room'], { buildingIds: [B1, B2], cashbookIds: [] }, 'phạm vi của lớp Sale');
  for (const action of ['contract.room_lock', 'contract.room_unlock', 'contract.notice_set', 'contract.renew'])
    assert.equal(catalog.granted(effective(authorization), action), true, action);
  for (const key of ['contracts.terminate', 'contracts.renew', 'contracts.edit', 'contracts.create'])
    assert.deepEqual(authorization.scopesByPermission[key], { buildingIds: [B1], cashbookIds: [] }, key);
});

test('Sale tắt khoá / capability Sale vắng ⇒ không lỗi; khoá tạm của Hợp đồng ẩn, thao tác Hợp đồng khác vẫn cấp', async () => {
  for (const sale of ['off', 'absent']) {
    const { catalog, auth } = chain({ sale });
    const authorization = await auth.readAuthorization(input);
    assert.equal(authorization.permissions.action.includes('sale_phong.lock_room'), false, sale);
    assert.equal(catalog.granted(effective(authorization), 'contract.room_lock'), false, sale);
    assert.equal(catalog.granted(effective(authorization), 'contract.notice_set'), true, sale);
  }
});

test('cấu hình host đổi (bật / tắt actionPages contract) không đổi epoch, không context_changed cho kết nối cũ', async () => {
  const off = await chain({ contract: false }).auth.readAuthorization(input);
  const on = await chain({ contract: true }).auth.readAuthorization(input);
  assert.equal(off.permissions.action.includes('sale_phong.lock_room'), true, 'không có Hợp đồng: Sale cấp như production');
  assert.equal(on.permissions.action.filter(key => key === 'sale_phong.lock_room').length, 1);
  // Epoch của chuỗi băm từ các capability SQL (không từ danh mục connector): cùng câu trả lời SQL ⇒ cùng epoch dù host bật trang mới,
  // nên kết nối đã lưu không bị coi là đổi ngữ cảnh.
  assert.equal(on.epoch, off.epoch);
});

test('bất biến: sau khi mượn khoá, không khoá nào do hai lớp cùng cấp (ngoài tasks.* đã phối hợp bằng live trong task-adapter)', () => {
  const others = { customer: CUSTOMER_ACTIONS, roomPass: [ROOM_PASS_ACTION], sale: SALE_ACTIONS, salePolicy: SALE_POLICY_CAPABILITIES,
    schedule: ['chat_zalo.manage_automation'], memory: ['assistant.memory.write'] };
  // tasks.create / tasks.edit / tasks.delete: lớp task cũ thôi cấp khi thao tác Công việc sống (createTaskAuth: createFromActions + skip).
  const coordinated = new Set([TASK_ACTION, TASK_PROGRESS_ACTION, TASK_CANCEL_ACTION]);
  for (const contract of [false, true]) {
    const catalog = createActionCatalog([...PRODUCTION, ...(contract ? CONTRACT_ACTIONS : [])]);
    const own = catalog.keys.filter(key => !SALE_ACTIONS.includes(key));
    for (const [layer, keys] of Object.entries(others)) {
      const shared = own.filter(key => keys.includes(key) && !coordinated.has(key));
      assert.deepEqual(shared, [], `lớp thao tác (contract=${contract}) cấp trùng khoá với lớp ${layer}`);
    }
  }
  // Khoá Sale mà danh mục thao tác cần đều là khoá mượn (đúng một: sale_phong.lock_room).
  assert.deepEqual(createActionCatalog([...PRODUCTION, ...CONTRACT_ACTIONS]).keys.filter(key => SALE_ACTIONS.includes(key)), ['sale_phong.lock_room']);
});

test('server.mjs nối lớp thao tác với khoá mượn của lớp Sale; borrowedKeys sai khuôn ⇒ TypeError', () => {
  const source = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.match(source, /borrowedKeys: actionCatalog\.keys\.filter\(key => SALE_ACTIONS\.includes\(key\)\)/);
  const catalog = createActionCatalog([...CONTRACT_ACTIONS]);
  for (const borrowedKeys of [['rooms.edit'], ['sale_phong.lock_room', 'sale_phong.lock_room'], [1], 'sale_phong.lock_room'])
    assert.throws(() => createActionAuth({ baseAuth: base, catalog, reads: { capabilities: async () => null }, borrowedKeys }), /invalid_action_auth/,
      JSON.stringify(borrowedKeys));
});
