import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fullGrantBroker } from './full-grant-broker.fixture.mjs';
import { createActionRuntime } from './action-runtime.mjs';
import { createActionCatalog } from './action-catalog.mjs';
import { ACTION_LIST_TOOL, ACTION_RUN_TOOL, ACTION_STATUS_TOOL } from './action-contract.mjs';
import { ACTION_PAGE_CATALOGS, PRODUCTION_ACTIONS } from './action-page-catalogs.mjs';
import { advertisedTool } from './tool-argument-shape.mjs';
import { EXPENSE_ACTIONS, EXPENSE_RETIRED_TOOLS } from './expense-actions-contract.mjs';
import { TASK_ACTIONS } from './task-actions-contract.mjs';
import { INVOICE_ACTIONS } from './invoice-actions-contract.mjs';
import { CONTRACT_ACTIONS } from './contract-action-contract.mjs';
import { LEARNING_ACTIONS } from './learning-action-contract.mjs';
import { PROBE_CONFIRM, PROBE_KEY, PROBE_NOTE } from './action-probe-contract.mjs';

// Ngân sách tools/list khi họ thao tác ghi dùng chung hiện (NEN-CHUNG-THAO-TAC-GHI.md mục 10). Trần chung 64 000 B
// (tool-argument-shape.test.mjs) giữ nguyên. Đợt 2 Thu chi: danh mục production = thao tác expense.*, họ phiếu chi cũ
// crm_expense_* đã gỡ khỏi connector (TC1) ⇒ thêm thao tác không thêm byte: khuôn tham số nằm trong KẾT QUẢ của crm_action_list.
const TOOLS_LIST_BUDGET = 64_000;
const OLD_EXPENSE_TOOLS = Object.keys(EXPENSE_RETIRED_TOOLS);
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
  // Bảng tên nghỉ hưu (EXPENSE_RETIRED_TOOLS) không được rỗng, không thì hai phép kiểm "đã gỡ" dưới đây xanh rỗng.
  assert.deepEqual([...OLD_EXPENSE_TOOLS].sort(), ['crm_expense_create', 'crm_expense_input_options', 'crm_expense_status']);
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

// Đợt 3 học có kiểm duyệt (HOC-CO-KIEM-DUYET.md mục 4.4): trang learning chỉ nạp khi host bật actionPages ["learning"]. Đo trên main
// f2473ba4a (04/11, trước trang Bài học) với cấu hình host actionPages ["contract"] — giá trị chép từ main, không dựng lại từ module đang
// kiểm: ba tool chung (JSON tools/list, kể cả ngoặc / dấu phẩy) và danh mục production + Hợp đồng. Đổi mô tả ba tool có chủ đích (vd thêm
// tên tool nghỉ hưu, infra/hermes-skills/README.md) thì cập nhật MAIN_ACTION_TOOLS cùng PR.
const MAIN_ACTION_TOOLS = Object.freeze({ sha256: 'b3378f1de25ed849c733499569b77fc0aa288d10f1b209470e3ae3e4930b4c58', bytes: 2001 });
const MAIN_CONTRACT_CATALOG = Object.freeze({
  ids: ['contract.draft', 'contract.notice_cancel', 'contract.notice_set', 'contract.occupant_add', 'contract.occupant_remove', 'contract.renew',
    'contract.renew_batch', 'contract.return', 'contract.room_lock', 'contract.room_unlock', 'expense.approve', 'expense.cancel', 'expense.create',
    'expense.edit', 'expense.note', 'invoice.adjust', 'invoice.adjustment_check', 'invoice.cancel', 'invoice.collect', 'invoice.meter_record',
    'invoice.restore', 'task.cancel', 'task.create', 'task.create_batch', 'task.recurring_create', 'task.recurring_delete', 'task.recurring_pause',
    'task.recurring_update', 'task.update'],
  keys: ['contracts.create', 'contracts.edit', 'contracts.renew', 'contracts.terminate', 'income_expenses.approve_vouchers', 'income_expenses.cancel',
    'income_expenses.create', 'income_expenses.edit', 'invoices.approve', 'invoices.cancel', 'invoices.edit', 'meter_readings.create', 'sale_phong.lock_room',
    'tasks.create', 'tasks.delete', 'tasks.edit', 'thu_tien.collect_transfer'],
  rpcs: ['hermes_contract_action_v1', 'hermes_expense_write_v1', 'hermes_invoice_action_v1', 'hermes_task_action_v1'],
  pages: ['expense', 'task', 'invoice', 'contract'],
});
const sha = value => createHash('sha256').update(value).digest('hex');

test('đợt 3: actionPages ["contract"] giữ nguyên ba tool và danh mục như main; bật thêm learning không thêm byte tools/list nào', async t => {
  const tools = JSON.stringify([ACTION_LIST_TOOL, ACTION_RUN_TOOL, ACTION_STATUS_TOOL].map(advertisedTool));
  assert.deepEqual({ sha256: sha(tools), bytes: Buffer.byteLength(tools) }, MAIN_ACTION_TOOLS, 'ba tool chung đúng từng byte như main');
  assert.deepEqual(ACTION_LIST_TOOL.inputSchema.properties.page.enum, [null, 'expense', 'invoice', 'contract', 'task'], 'enum page không có learning');
  const asHost = pages => createActionCatalog([...PRODUCTION_ACTIONS, ...pages.flatMap(page => ACTION_PAGE_CATALOGS[page])]);
  const contract = asHost(['contract']);
  assert.deepEqual({ ids: [...contract.ids].sort(), keys: [...contract.keys], rpcs: [...contract.rpcs], pages: [...contract.pages] }, MAIN_CONTRACT_CATALOG);
  const learning = asHost(['contract', 'learning']);
  assert.deepEqual(learning.ids.filter(id => !contract.ids.includes(id)), LEARNING_ACTIONS.map(action => action.id));
  assert.deepEqual(learning.keys.filter(key => !contract.keys.includes(key)), ['assistant.learning_review']);
  assert.deepEqual(learning.rpcs.filter(rpc => !contract.rpcs.includes(rpc)), ['hermes_learning_action_v1']);
  // Mục lục crm_action_list của các thao tác cũ y nguyên khi bật thêm trang.
  const all = catalog => ({ read: [], action: catalog.keys });
  assert.deepEqual(learning.listing(all(learning)).filter(item => item.page !== 'learning'), contract.listing(all(contract)));
  // tools/list của kết nối đủ quyền: cùng từng byte dù host có bật learning hay không (khuôn tham số nằm trong kết quả crm_action_list).
  const listed = async catalog => {
    const { broker, token } = fullGrantBroker(t, undefined, { actions: createActionRuntime({ catalog, service }) });
    return (await broker.listTools(token)).tools;
  };
  const before = await listed(contract), after = await listed(learning);
  assert.equal(bytesOf(after), bytesOf(before));
  assert.deepEqual(after, before);
  const family = bytesOf(after.filter(tool => tool.name.startsWith('crm_action_'))) - bytesOf([]);
  t.diagnostic(`họ thao tác ${family} B khi bật learning (≤ 2 000 B)`);
  assert.ok(family <= 2_000, `họ thao tác ${family} B > 2 000 B`);
});
