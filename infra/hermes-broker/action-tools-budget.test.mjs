import test from 'node:test';
import assert from 'node:assert/strict';
import { fullGrantBroker } from './full-grant-broker.fixture.mjs';
import { createActionRuntime } from './action-runtime.mjs';
import { createActionCatalog } from './action-catalog.mjs';
import { EXPENSE_ACTION_TOOLS } from './expense-action-contract.mjs';
import { PROBE_KEY, probeCatalog } from './action-probe.fixture.mjs';

// Ngân sách tools/list khi họ thao tác ghi dùng chung hiện (NEN-CHUNG-THAO-TAC-GHI.md mục 10). Trần chung 64 000 B
// (tool-argument-shape.test.mjs) giữ nguyên. Đợt 1: production không nạp danh mục nào ⇒ ba tool ẩn, tools/list không
// đổi một byte. Họ thao tác chỉ hiện được cùng lúc họ phiếu chi cũ đã tắt (D4: chủ đồng ý câu 4; registry
// income_expenses.create = TẮT, draft PR #254), nên phép đo bỏ khoá đó khỏi kết nối.
const TOOLS_LIST_BUDGET = 64_000;
const service = { async prepareAction() { return Object.freeze({}); }, async finalizeAction() { return { kind: 'applied', result: {} }; } };
const bytesOf = tools => Buffer.byteLength(JSON.stringify({ tools }));

test('danh mục rỗng (production Đợt 1): ba tool không hiện, tools/list y như không có họ thao tác', async t => {
  const plain = fullGrantBroker(t);
  const empty = fullGrantBroker(t, undefined, { actions: createActionRuntime({ catalog: createActionCatalog([], { keys: [] }), service }), actionKeys: [PROBE_KEY] });
  const before = (await plain.broker.listTools(plain.token)).tools, after = (await empty.broker.listTools(empty.token)).tools;
  assert.deepEqual(after, before);
});

test('họ thao tác hiện (danh mục thử) + họ phiếu chi cũ tắt: tools/list ≤ 64 000 B; hai họ không cùng hiện', async t => {
  const runtime = createActionRuntime({ catalog: probeCatalog(), service });
  const { broker, token } = fullGrantBroker(t, undefined, { actions: runtime, actionKeys: [PROBE_KEY], withoutAction: ['income_expenses.create'] });
  const listed = (await broker.listTools(token)).tools, names = listed.map(tool => tool.name);
  for (const name of ['crm_action_list', 'crm_action_run', 'crm_action_status']) assert.ok(names.includes(name), name);
  assert.deepEqual(names.filter(name => EXPENSE_ACTION_TOOLS.some(tool => tool.name === name)), [], 'họ phiếu chi cũ không hiện');
  const bytes = bytesOf(listed);
  const family = bytesOf(listed.filter(tool => tool.name.startsWith('crm_action_'))) - bytesOf([]);
  t.diagnostic(`tools/list ${listed.length} tools, ${bytes} bytes; họ thao tác ${family} B`);
  assert.ok(bytes <= TOOLS_LIST_BUDGET, `tools/list ${bytes} bytes > ${TOOLS_LIST_BUDGET}`);
  assert.ok(family <= 2_000, `họ thao tác ${family} B > 2 000 B`);
  // Ghi lại vì sao D4 là điều kiện: còn họ phiếu chi cũ thì họ thao tác không vừa trần.
  const both = fullGrantBroker(t, undefined, { actions: runtime, actionKeys: [PROBE_KEY] });
  const withOld = bytesOf((await both.broker.listTools(both.token)).tools);
  t.diagnostic(`nếu còn họ phiếu chi cũ: ${withOld} bytes (trần ${TOOLS_LIST_BUDGET})`);
  assert.ok(withOld > TOOLS_LIST_BUDGET, 'nếu phép đo này hết vượt trần thì cập nhật mục 10 của tài liệu');
});
