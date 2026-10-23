import test from 'node:test';
import assert from 'node:assert/strict';
// external-group-mount nạp broker.mjs ngược lại: nạp trước (như tool-argument-shape.test.mjs).
import './external-group-mount.mjs';
import { createBroker } from './broker.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
import { createActionCatalog, validateActionParams } from './action-catalog.mjs';
import { createActionRuntime } from './action-runtime.mjs';
import { ACTION_REASONS } from './action-reasons.mjs';
import { HERMES_ACTION_CAPABILITIES, HERMES_ACTION_FOUNDATION_KEYS } from './capability-contract.mjs';
import { EXPENSE_ACTIONS } from './expense-actions-contract.mjs';
import { INVOICE_ACTIONS, INVOICE_COLLECT, INVOICE_COLLECT_KEY, INVOICE_RPC, invoiceCatalog } from './invoice-actions-contract.mjs';

// Danh mục trang HOÁ ĐƠN (Đợt 3 Mốc 3, HOA-DON-THAO-TAC-GHI.md mục 3–4) qua broker + lõi chạy thật, cổng dịch vụ giả: khuôn tham số
// (một phòng hoặc lô ≤ 10), sàn xác nhận (luôn xem trước), câu hỏi giữ lại/trả lại ở bản xem trước (choiceRequired) ⇒ lượt 2 hỏi lại,
// tiền mặt bị từ chối có chỉ đường, lý do riêng của trang tới mô hình, hoá đơn mơ hồ ⇒ hỏi lại kèm ứng viên.
const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const TOKEN = `hc_${'A'.repeat(43)}`;
const START = Date.parse('2026-10-22T05:00:00.000Z');
const ONE = { buildingName: '44TL', roomName: '201', method: 'TK' };

function setup(t, { action = [INVOICE_COLLECT_KEY], respond } = {}) {
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
  const runtime = createActionRuntime({ catalog: invoiceCatalog(), service, clock: () => START, mintRequestId: () => id(String(++next)) });
  const broker = createBroker({ authority: { identifyConnection: async () => ({ connectionId: id('a') }), resolve: async () => identity, checkUnchanged: async () => {} },
    dependencyScope: scope, audit: async () => {}, clock: () => START, actions: runtime });
  const call = async (args, name = 'crm_action_run') => {
    const result = await broker.callTool(TOKEN, name, args);
    assert.equal(result.isError, false);
    return JSON.parse(result.content[0].text);
  };
  return { broker, requests, call };
}
const RESOLVED = { buildingId: id('f'), buildingName: '44TL', method: 'TK', items: [{ invoiceId: id('1'), roomId: id('2'), roomName: '201', invoiceNumber: 'INV-1', billingMonth: '2026-10' }] };
const preview = (extra = {}) => ({ kind: 'preview', basis: 'b'.repeat(32), resolved: RESOLVED, confirm: 'required', warnings: [],
  preview: { summary: 'Sẽ ghi THU 3.650.000đ chuyển khoản ngày 22/10/2026 (thứ Năm, hôm nay) vào sổ «VCB ***» cho hoá đơn INV-1.', ...extra } });

test('danh mục Hoá đơn: một thao tác thu tiền, một RPC, khoá riêng Hermes trong hợp đồng; một phòng hoặc lô ≤ 10', () => {
  assert.deepEqual(INVOICE_ACTIONS.map(action => [action.id, action.key, action.class, action.rpc]), [['invoice.collect', 'thu_tien.collect_transfer', 'money', INVOICE_RPC]]);
  assert.ok(HERMES_ACTION_CAPABILITIES.includes(INVOICE_COLLECT_KEY));
  assert.ok(!HERMES_ACTION_FOUNDATION_KEYS.includes(INVOICE_COLLECT_KEY) && !HERMES_ACTION_CAPABILITIES.includes('thu_tien.collect'), 'không bao giờ là thu_tien.collect');
  const [collect] = invoiceCatalog().listing({ action: [INVOICE_COLLECT_KEY] });
  assert.equal(collect.confirm, 'always');
  assert.deepEqual(Object.keys(collect.params), ['buildingName', 'roomName', 'month', 'invoiceNumber', 'items', 'method', 'amount', 'date', 'overpay', 'cashbookName', 'note']);
  assert.deepEqual(Object.entries(collect.params).filter(([, spec]) => spec.required).map(([name]) => name), ['buildingName', 'method']);
  assert.deepEqual([collect.params.items.max, collect.params.method.values, collect.params.overpay.values], [10, ['TK', 'TT', 'TM'], ['keep', 'return']]);
  assert.deepEqual(validateActionParams(INVOICE_COLLECT, { building_name: '44TL', room_name: '201', method: 'TK', amount: '3650000', cashbook_name: 'mb' }),
    { ok: true, value: { buildingName: '44TL', roomName: '201', method: 'TK', amount: 3650000, cashbookName: 'mb' } });
  assert.equal(validateActionParams(INVOICE_COLLECT, { buildingName: '44TL', method: 'TT', items: [{ roomName: '201' }, { roomName: '202', month: '2026-09', invoiceNumber: 'INV-2', amount: 1200000 }] }).ok, true);
  for (const params of [{ ...ONE, method: 'CK' }, { ...ONE, amount: 0 }, { ...ONE, overpay: 'refund' }, { ...ONE, date: '22/10/2026' }, { ...ONE, month: '2026-13' },
    { buildingName: '44TL', method: 'TK', items: Array.from({ length: 11 }, (_, i) => ({ roomName: String(101 + i) })) }, { ...ONE, invoiceId: id('1') }])
    assert.equal(validateActionParams(INVOICE_COLLECT, params).ok, false, JSON.stringify(params).slice(0, 80));
  // Hai trang cùng một danh mục production (server.mjs): không trùng mã, không khoá ngoài hợp đồng.
  assert.deepEqual([...createActionCatalog([...EXPENSE_ACTIONS, ...INVOICE_ACTIONS]).pages], ['expense', 'invoice']);
});

test('invoice.collect: luôn xem trước (sàn money) kể cả khi SQL nói không cần; lượt 2 gửi đúng bản đã giải + basis', async t => {
  const env = setup(t, { respond: request => request.phase === 'apply'
    ? { kind: 'applied', result: { invoices: [{ invoiceNumber: 'INV-1', applied: '3650000', statusAfter: 'PAID' }], applied: '3650000' }, link: `/invoices/${id('1')}` }
    : { ...preview(), confirm: 'not_required' } });
  const first = await env.call({ action: 'invoice.collect', params: ONE });
  assert.deepEqual([first.outcome, first.applied], ['confirmation_required', false]);
  assert.deepEqual(env.requests[0], { op: 'run', action: 'invoice.collect', phase: 'preview', requestId: id('1'), params: ONE });
  await assert.rejects(env.broker.callTool(TOKEN, 'crm_action_run', { action: 'invoice.collect', params: { ...ONE, amount: 1000000 }, requestId: first.requestId,
    confirmToken: first.confirmToken }), error => error.code === 'confirmation_invalid', 'đổi số tiền sau khi xem ⇒ token không khớp');
  assert.equal(env.requests.length, 1, 'không gửi lệnh ghi');
  const again = await env.call({ action: 'invoice.collect', params: ONE });
  const applied = await env.call({ action: 'invoice.collect', params: ONE, requestId: again.requestId, confirmToken: again.confirmToken });
  assert.deepEqual([applied.outcome, applied.link], ['applied', `/invoices/${id('1')}`]);
  assert.deepEqual(env.requests.at(-1), { op: 'run', action: 'invoice.collect', phase: 'apply', requestId: again.requestId, params: ONE, resolved: RESOLVED, basis: 'b'.repeat(32) });
});

test('khách trả dư chưa chọn: bản xem trước mang câu hỏi (choiceRequired); xác nhận nhầm ⇒ needs_input overpay_needs_choice, không phải lỗi', async t => {
  const env = setup(t, { respond: request => request.phase === 'apply' ? { kind: 'rejected', reason: 'overpay_needs_choice' }
    : preview({ summary: 'Khách trả 3.700.000đ, còn nợ 3.650.000đ, dư 50.000đ. CHƯA chọn: giữ lại cho kỳ sau (overpay=keep) hay trả lại khách (overpay=return)?', choiceRequired: 'overpay' }) });
  const params = { ...ONE, amount: 3700000 };
  const ask = await env.call({ action: 'invoice.collect', params });
  assert.deepEqual([ask.outcome, ask.preview.choiceRequired], ['confirmation_required', 'overpay']);
  const again = await env.call({ action: 'invoice.collect', params, requestId: ask.requestId, confirmToken: ask.confirmToken });
  assert.deepEqual([again.outcome, again.reason, again.detail], ['needs_input', 'overpay_needs_choice', ACTION_REASONS.overpay_needs_choice.text]);
});

test('lý do của trang: tiền mặt / hoá đơn huỷ / thiếu sổ nhận là lỗi có câu tĩnh; hết nợ / nợ đã kéo là câu hỏi lại; hoá đơn mơ hồ có ứng viên', async t => {
  let outcome;
  const env = setup(t, { respond: () => outcome });
  for (const reason of ['cash_collection_web_only', 'invoice_not_collectible', 'credit_requires_contract', 'receiving_book_missing', 'reconciliation_required']) {
    outcome = { kind: 'rejected', reason };
    await assert.rejects(env.broker.callTool(TOKEN, 'crm_action_run', { action: 'invoice.collect', params: { ...ONE, method: 'TM' } }), error =>
      error.code === 'action_rejected' && error.reason === reason && error.detail === ACTION_REASONS[reason].text, reason);
  }
  assert.match(ACTION_REASONS.cash_collection_web_only.text, /\/thu-tien/);
  for (const reason of ['nothing_to_collect', 'debt_carried']) {
    outcome = { kind: 'rejected', reason };
    const got = await env.call({ action: 'invoice.collect', params: ONE });
    assert.deepEqual([got.outcome, got.reason, got.detail], ['needs_input', reason, ACTION_REASONS[reason].text]);
  }
  outcome = { kind: 'needs_input', reason: 'name_unresolved', field: 'invoice', wanted: '201', why: 'ambiguous',
    candidates: [{ name: 'kỳ 10/2026 (còn 3.650.000đ)' }, { name: 'kỳ 09/2026 (còn 1.200.000đ)' }], more: false };
  assert.equal((await env.call({ action: 'invoice.collect', params: ONE })).detail,
    "Hoá đơn '201' khớp nhiều: kỳ 10/2026 (còn 3.650.000đ), kỳ 09/2026 (còn 1.200.000đ) — hỏi người dùng nêu rõ.");
  outcome = { kind: 'rejected', reason: 'Hóa đơn không còn số tiền có thể thu' };
  await assert.rejects(env.broker.callTool(TOKEN, 'crm_action_run', { action: 'invoice.collect', params: ONE }),
    error => error.code === 'action_rejected' && error.reason === 'crm_refused', 'chuỗi lạ ⇒ crm_refused, không lọt câu SQL');
});

test('kết nối không giữ thu_tien.collect_transfer (khoá TẮT ở production) ⇒ không hiện tool, gọi ⇒ tool_not_available; mục lục trang ≤ 8 KB', async t => {
  const off = setup(t, { action: ['income_expenses.approve'], respond: () => preview() });
  assert.deepEqual((await off.broker.listTools(TOKEN)).tools, []);
  await assert.rejects(off.broker.callTool(TOKEN, 'crm_action_run', { action: 'invoice.collect', params: ONE }), error => error.code === 'tool_not_available');
  assert.deepEqual(off.requests, []);
  const on = setup(t, { respond: () => preview() });
  const listed = await on.call({ page: 'invoice' }, 'crm_action_list');
  assert.deepEqual(listed.items.map(item => item.action), ['invoice.collect']);
  assert.ok(Buffer.byteLength(JSON.stringify(listed), 'utf8') <= 8192, 'crm_action_list của trang ≤ 8 KB');
});
