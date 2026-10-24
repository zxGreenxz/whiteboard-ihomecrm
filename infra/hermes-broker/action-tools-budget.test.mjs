import test from 'node:test';
import assert from 'node:assert/strict';
import { fullGrantBroker } from './full-grant-broker.fixture.mjs';
import { createActionRuntime } from './action-runtime.mjs';
import { createActionCatalog } from './action-catalog.mjs';
import { EXPENSE_ACTIONS } from './expense-actions-contract.mjs';
import { TASK_ACTIONS } from './task-actions-contract.mjs';
import { INVOICE_ACTIONS } from './invoice-actions-contract.mjs';
import { CONTRACT_ACTIONS } from './contract-action-contract.mjs';
import { PROBE_CONFIRM, PROBE_KEY, PROBE_NOTE } from './action-probe-contract.mjs';

// Ngân sách tools/list khi họ thao tác ghi dùng chung hiện (NEN-CHUNG-THAO-TAC-GHI.md mục 10). Trần chung 64 000 B
// (tool-argument-shape.test.mjs) giữ nguyên. Đợt 2 Thu chi: danh mục production = thao tác expense.*, họ phiếu chi cũ
// crm_expense_* đã gỡ khỏi connector (TC1) ⇒ thêm thao tác không thêm byte: khuôn tham số nằm trong KẾT QUẢ của crm_action_list.
const TOOLS_LIST_BUDGET = 64_000;
const OLD_EXPENSE_TOOLS = ['crm_expense_input_options', 'crm_expense_create', 'crm_expense_status'];
const service = { async prepareAction() { return Object.freeze({}); }, async finalizeAction() { return { kind: 'applied', result: {} }; } };
const bytesOf = tools => Buffer.byteLength(JSON.stringify({ tools }));

test('danh mục rỗng: ba tool không hiện, tools/list y như không có họ thao tác', async t => {
  const plain = fullGrantBroker(t);
  const empty = fullGrantBroker(t, undefined, { actions: createActionRuntime({ catalog: createActionCatalog([], { keys: [] }), service }), actionKeys: [PROBE_KEY] });
  const before = (await plain.broker.listTools(plain.token)).tools, after = (await empty.broker.listTools(empty.token)).tools;
  assert.deepEqual(after, before);
});

// Lượt 14 Hoá đơn: mục notPermitted ({action, title, reason}) của mỗi thao tác nhỏ hơn mục items của chính nó ⇒ kết quả crm_action_list có
// notPermitted không bao giờ lớn hơn bản đủ quyền của cùng trang; tools/list không đổi (mô tả tool giữ nguyên).
test('lượt 14: mục notPermitted của mỗi thao tác production nhỏ hơn mục items của nó', () => {
  const catalog = createActionCatalog([...EXPENSE_ACTIONS, ...TASK_ACTIONS, ...INVOICE_ACTIONS, ...CONTRACT_ACTIONS]);
  const items = catalog.listing({ read: [], action: catalog.keys });
  assert.equal(items.length, catalog.ids.length);
  for (const item of items) {
    const entry = { action: item.action, title: item.title, reason: 'forbidden' };
    assert.ok(Buffer.byteLength(JSON.stringify(entry)) < Buffer.byteLength(JSON.stringify(item)), item.action);
  }
});

test('danh mục Thu chi (production): khoá income_expenses.create ⇒ ba tool chung hiện, họ phiếu chi cũ không còn; tools/list ≤ 64 000 B', async t => {
  const runtime = createActionRuntime({ catalog: createActionCatalog(EXPENSE_ACTIONS), service });
  const { broker, token } = fullGrantBroker(t, undefined, { actions: runtime });
  const listed = (await broker.listTools(token)).tools, names = listed.map(tool => tool.name);
  for (const name of ['crm_action_list', 'crm_action_run', 'crm_action_status']) assert.ok(names.includes(name), name);
  assert.deepEqual(names.filter(name => OLD_EXPENSE_TOOLS.includes(name)), [], 'họ phiếu chi cũ đã gỡ');
  for (const name of OLD_EXPENSE_TOOLS)
    await assert.rejects(broker.callTool(token, name, {}), error => error.code === 'tool_not_available', `${name} gọi thẳng cũng bị từ chối`);
  const bytes = bytesOf(listed);
  const family = bytesOf(listed.filter(tool => tool.name.startsWith('crm_action_'))) - bytesOf([]);
  t.diagnostic(`tools/list ${listed.length} tools, ${bytes} bytes; họ thao tác ${family} B`);
  assert.ok(bytes <= TOOLS_LIST_BUDGET, `tools/list ${bytes} bytes > ${TOOLS_LIST_BUDGET}`);
  assert.ok(family <= 2_000, `họ thao tác ${family} B > 2 000 B`);
  // Thêm thao tác (kể cả lô list/record) không đổi một byte: cùng ba tool với danh mục thử.
  const probeOnly = fullGrantBroker(t, undefined, { actions: createActionRuntime({ catalog: createActionCatalog([PROBE_NOTE, PROBE_CONFIRM]), service }),
    actionKeys: [PROBE_KEY] });
  assert.equal(bytesOf((await probeOnly.broker.listTools(probeOnly.token)).tools), bytes);
  // Kết nối không giữ khoá nào của Thu chi (create/edit/cancel/approve_vouchers đang TẮT ở registry production) ⇒ không hiện tool nào của họ thao tác;
  // chỉ giữ một khoá (vd income_expenses.cancel, Mốc 4) ⇒ ba tool chung hiện, cùng số byte.
  const off = fullGrantBroker(t, undefined, { actions: runtime, withoutAction: ['income_expenses.create', 'income_expenses.edit', 'income_expenses.cancel', 'income_expenses.approve_vouchers'] });
  assert.deepEqual((await off.broker.listTools(off.token)).tools.filter(tool => tool.name.startsWith('crm_action_')), []);
  const cancelOnly = fullGrantBroker(t, undefined, { actions: runtime, withoutAction: ['income_expenses.create', 'income_expenses.edit'] });
  assert.equal(bytesOf((await cancelOnly.broker.listTools(cancelOnly.token)).tools), bytes);
});
