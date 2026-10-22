import test from 'node:test';
import assert from 'node:assert/strict';
// external-group-mount nạp broker.mjs ngược lại: nạp trước (như tool-argument-shape.test.mjs).
import './external-group-mount.mjs';
import { createBroker } from './broker.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
import { createActionCatalog, validateActionParams } from './action-catalog.mjs';
import { createActionRuntime } from './action-runtime.mjs';
import { ACTION_REASONS } from './action-reasons.mjs';
import { HERMES_ACTION_CAPABILITIES } from './capability-contract.mjs';
import { EXPENSE_ACTIONS, EXPENSE_CREATE, EXPENSE_CREATE_KEY, EXPENSE_NOTE, EXPENSE_RPC, expenseCatalog } from './expense-actions-contract.mjs';

// Danh mục trang THU CHI (Đợt 2, THU-CHI-THAO-TAC-GHI.md mục 2) qua broker + lõi chạy thật, cổng dịch vụ giả: khuôn tham số
// (lô ≤ 5 khoản), sàn xác nhận (create luôn xem trước dù SQL nói không cần; note ghi thẳng), một token cho cả lô, lượt 2 gửi
// đúng bản đã giải + basis, needs_input cho hạng mục/sổ/mã phiếu không giải được, lý do riêng của trang tới mô hình.
const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const TOKEN = `hc_${'A'.repeat(43)}`;
const START = Date.parse('2026-10-22T05:00:00.000Z');
const ITEM = { buildingName: '1392QT', roomName: '201', amount: 350_000, content: 'mua vòi nước', payee: 'anh thợ' };

function setup(t, { action = [EXPENSE_CREATE_KEY], respond } = {}) {
  const scope = createDependencyScope(); t.after(() => scope.close());
  const requests = [];
  const identity = { row: { id: id('a'), assistantId: id('b'), userId: id('c'), organizationId: id('d'), expiresAt: START + 86_400_000,
    epoch: 1, state: 'active', restrictions: { read: [], action } }, effective: { read: [], action }, isSuperadmin: false,
  policyEpoch: 'a'.repeat(64), contextVersion: 'b'.repeat(64), assistantScopeIds: [id('e')],
  scopesByPermission: Object.fromEntries(action.map(key => [key, { buildingIds: [id('f')], cashbookIds: [] }])) };
  let next = 0;
  const service = {
    async prepareAction(_token, request) { requests.push(structuredClone(request)); return Object.freeze({}); },
    async finalizeAction(_token, _receipt, hooks) { return respond(requests.at(-1), hooks); },
  };
  const runtime = createActionRuntime({ catalog: expenseCatalog(), service, clock: () => START, mintRequestId: () => id(String(++next)) });
  const broker = createBroker({ authority: { identifyConnection: async () => ({ connectionId: id('a') }), resolve: async () => identity, checkUnchanged: async () => {} },
    dependencyScope: scope, audit: async () => {}, clock: () => START, actions: runtime });
  const call = async (args, name = 'crm_action_run') => {
    const result = await broker.callTool(TOKEN, name, args);
    assert.equal(result.isError, false);
    return JSON.parse(result.content[0].text);
  };
  return { broker, requests, call };
}
const RESOLVED = { items: [{ buildingId: id('f'), roomId: id('1'), typeId: id('2'), cashbookId: id('3') }] };
const preview = (confirm = 'required') => ({ kind: 'preview', preview: { summary: 'Ghi 1 phiếu chi, tổng 350.000đ.' }, basis: 'b'.repeat(32),
  resolved: RESOLVED, confirm, warnings: ['Khoản 1: tiền không tròn nghìn'] });

test('danh mục Thu chi: hai thao tác, một RPC, khoá trong hợp đồng; lô 1–5 khoản với khuôn từng trường', () => {
  assert.deepEqual(EXPENSE_ACTIONS.map(action => [action.id, action.key, action.class, action.rpc]),
    [['expense.create', 'income_expenses.create', 'money', EXPENSE_RPC], ['expense.note', 'income_expenses.create', 'reversible', EXPENSE_RPC]]);
  assert.ok(HERMES_ACTION_CAPABILITIES.includes(EXPENSE_CREATE_KEY));
  const catalog = expenseCatalog();
  assert.deepEqual([...catalog.keys], [EXPENSE_CREATE_KEY]);
  const [create, note] = catalog.listing({ action: [EXPENSE_CREATE_KEY] });
  assert.deepEqual([create.confirm, note.confirm], ['always', 'if_required']);
  assert.deepEqual(Object.keys(create.params.items.item.fields), ['buildingName', 'roomName', 'amount', 'content', 'category', 'payee', 'voucherDate', 'period', 'cashbook']);
  assert.deepEqual(Object.entries(create.params.items.item.fields).filter(([, spec]) => spec.required).map(([name]) => name), ['buildingName', 'amount', 'content']);
  assert.equal(create.params.items.max, 5);
  assert.deepEqual(validateActionParams(EXPENSE_CREATE, { items: [{ ...ITEM, amount: '350000', voucher_date: '2026-10-21', period: '2026-10' }] }),
    { ok: true, value: { items: [{ ...ITEM, voucherDate: '2026-10-21', period: '2026-10' }] } });
  for (const items of [[], Array.from({ length: 6 }, () => ITEM), [{ ...ITEM, amount: 0 }], [{ ...ITEM, content: '' }], [{ ...ITEM, voucherDate: '21/10/2026' }],
    [{ ...ITEM, period: '2026-13' }], [{ ...ITEM, cashbookId: id('3') }], [{ ...ITEM, buildingName: 'A\nB' }]])
    assert.equal(validateActionParams(EXPENSE_CREATE, { items }).ok, false, JSON.stringify(items).slice(0, 80));
  assert.equal(validateActionParams(EXPENSE_NOTE, { voucherCode: 'PC2610001', note: 'đã lấy hoá đơn đỏ' }).ok, true);
  assert.equal(validateActionParams(EXPENSE_NOTE, { voucherCode: 'PC2610001', note: 'x'.repeat(1001) }).ok, false);
  assert.throws(() => createActionCatalog(EXPENSE_ACTIONS, { keys: ['income_expenses.edit'] }), /invalid_action_catalog/, 'khoá phải nằm trong tập được nhận');
});

test('expense.create: luôn xem trước (sàn money) kể cả khi SQL nói không cần; một token cho cả lô; lượt 2 gửi đúng bản đã giải', async t => {
  const env = setup(t, { respond: request => request.phase === 'apply'
    ? { kind: 'applied', result: { vouchers: [{ code: 'PC2610001', statusText: 'Đã duyệt và CHI khỏi sổ' }] }, link: '/income-expense' }
    : preview('not_required') });
  const params = { items: [ITEM, { ...ITEM, buildingName: '44TL', amount: 450_000, content: 'điện lạnh' }] };
  const first = await env.call({ action: 'expense.create', params });
  assert.deepEqual([first.outcome, first.applied, first.action], ['confirmation_required', false, 'expense.create']);
  assert.deepEqual(env.requests[0], { op: 'run', action: 'expense.create', phase: 'preview', requestId: id('1'), params });
  assert.deepEqual(first.warnings, ['Khoản 1: tiền không tròn nghìn']);
  // Đổi một khoản sau khi xem ⇒ token không khớp, không gửi lệnh ghi.
  const changed = { items: [ITEM, { ...ITEM, buildingName: '44TL', amount: 500_000, content: 'điện lạnh' }] };
  await assert.rejects(env.broker.callTool(TOKEN, 'crm_action_run', { action: 'expense.create', params: changed, requestId: first.requestId, confirmToken: first.confirmToken }),
    error => error.code === 'confirmation_invalid');
  assert.equal(env.requests.length, 1);
  const again = await env.call({ action: 'expense.create', params });
  const applied = await env.call({ action: 'expense.create', params, requestId: again.requestId, confirmToken: again.confirmToken });
  assert.deepEqual([applied.outcome, applied.applied, applied.link], ['applied', true, '/income-expense']);
  assert.deepEqual(env.requests.at(-1), { op: 'run', action: 'expense.create', phase: 'apply', requestId: again.requestId, params, resolved: RESOLVED, basis: 'b'.repeat(32) });
});

test('expense.note: ghi thẳng ở lượt 1 (phase auto, chính sách never); SQL đòi xác nhận thì vẫn có token', async t => {
  let confirm = false;
  const env = setup(t, { respond: request => confirm ? preview() : { kind: 'applied', result: { code: 'PC2610001', noted: true }, link: `/income-expense/voucher/${id('9')}` } });
  const noted = await env.call({ action: 'expense.note', params: { voucherCode: 'PC2610001', note: 'đã lấy hoá đơn đỏ' } });
  assert.deepEqual([noted.outcome, noted.result], ['applied', { code: 'PC2610001', noted: true }]);
  assert.equal(env.requests[0].phase, 'auto');
  confirm = true;
  const strict = await env.call({ action: 'expense.note', params: { voucherCode: 'PC2610001', note: 'ghi chú' } });
  assert.equal(strict.outcome, 'confirmation_required');
});

test('needs_input từ SQL: hạng mục / sổ / mã phiếu không giải được ⇒ câu hỏi lại có ứng viên, không phải lỗi MCP', async t => {
  let outcome;
  const env = setup(t, { respond: () => outcome });
  outcome = { kind: 'needs_input', reason: 'name_unresolved', field: 'category', wanted: 'đồ lặt vặt', why: 'ambiguous',
    candidates: [{ name: 'Mua đồ điện nước' }, { name: 'Chi khác (ghi rõ)' }], more: false };
  const category = await env.call({ action: 'expense.create', params: { items: [ITEM] } });
  assert.deepEqual([category.outcome, category.reason], ['needs_input', 'name_unresolved']);
  assert.match(category.detail, /^Hạng mục 'đồ lặt vặt' khớp nhiều: Mua đồ điện nước, Chi khác \(ghi rõ\)/);
  outcome = { kind: 'needs_input', reason: 'name_unresolved', field: 'cashbook', wanted: 'quỹ lạ', why: 'not_visible', candidates: [] };
  assert.match((await env.call({ action: 'expense.create', params: { items: [ITEM] } })).detail, /^Không thấy sổ quỹ 'quỹ lạ' trong phạm vi quyền/);
  outcome = { kind: 'needs_input', reason: 'name_unresolved', field: 'voucher', wanted: 'PC2609001', why: 'ambiguous',
    candidates: [{ name: 'PC2609001 · 03/09 · 1392QT · 350.000đ' }, { name: 'PC2609001 · 12/09 · 44TL · 1.200.000đ' }] };
  assert.match((await env.call({ action: 'expense.note', params: { voucherCode: 'PC2609001', note: 'x' } })).detail, /^Phiếu 'PC2609001' khớp nhiều/);
  outcome = { kind: 'rejected', reason: 'not_found' };
  assert.deepEqual((await env.call({ action: 'expense.note', params: { voucherCode: 'PC0000000', note: 'x' } })).reason, 'not_found');
});

test('lý do riêng Thu chi tới mô hình đúng câu tĩnh; lý do lạ ⇒ crm_refused', async t => {
  let reason;
  const env = setup(t, { respond: () => ({ kind: 'rejected', reason }) });
  for (reason of ['system_voucher', 'evidence_required', 'period_locked', 'cashbook_not_held']) {
    await assert.rejects(env.broker.callTool(TOKEN, 'crm_action_run', { action: 'expense.create', params: { items: [ITEM] } }), error =>
      error.code === 'action_rejected' && error.reason === reason && error.detail === ACTION_REASONS[reason].text, reason);
  }
  reason = 'Phiếu do hệ thống sinh — sửa ở luồng gốc';
  await assert.rejects(env.broker.callTool(TOKEN, 'crm_action_run', { action: 'expense.create', params: { items: [ITEM] } }),
    error => error.code === 'action_rejected' && error.reason === 'crm_refused');
});

test('kết nối không giữ income_expenses.create (khoá đang TẮT ở production, Q4) ⇒ không hiện tool, gọi ⇒ tool_not_available', async t => {
  const env = setup(t, { action: ['income_expenses.approve'], respond: () => preview() });
  assert.deepEqual((await env.broker.listTools(TOKEN)).tools, []);
  await assert.rejects(env.broker.callTool(TOKEN, 'crm_action_run', { action: 'expense.create', params: { items: [ITEM] } }), error => error.code === 'tool_not_available');
  assert.deepEqual(env.requests, []);
});
