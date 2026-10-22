import test from 'node:test';
import assert from 'node:assert/strict';
// external-group-mount nạp broker.mjs ngược lại: nạp trước (như tool-argument-shape.test.mjs).
import './external-group-mount.mjs';
import { ACTION_INPUT_REASONS, ACTION_REASON_CODES, ACTION_REASON_FORMS, ACTION_REASON_RETRIES, ACTION_REASONS, ACTION_REJECT_REASONS,
  actionReason, actionReasonText } from './action-reasons.mjs';
import { BrokerError, ERROR_STATUS, REQUEST_RECEIPT_UNKNOWN, actionRejected, createBroker } from './broker.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
import { createMcpHttpServer } from './mcp-http.mjs';

// Danh sách đóng lý do của thao tác ghi (NEN-CHUNG-THAO-TAC-GHI.md mục 6). Chỉ mã + câu tĩnh trong danh sách tới mô
// hình; thiếu/mơ hồ đầu vào là kết quả needs_input (không phải lỗi — rào 3 lần bị từ chối của Hermes, ca thử 21/10).
const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;

test('danh sách đóng: 20 mã chung + mã trang, mỗi mã một dạng/chỉ dẫn hợp lệ và một câu tĩnh không chứa số liệu hay ID', () => {
  assert.ok(Object.isFrozen(ACTION_REASONS) && ACTION_REASON_CODES.every(code => Object.isFrozen(ACTION_REASONS[code])));
  // 20 mã chung của Đợt 1 + khối riêng từng trang (Công việc: task_quota_user, task_quota_pair).
  assert.equal(ACTION_REASON_CODES.length, 20 + 2);
  assert.deepEqual([...ACTION_INPUT_REASONS], ['unknown_action', 'invalid_params', 'name_unresolved', 'reason_required', 'amount_out_of_range',
    'date_out_of_range', 'not_found']);
  assert.equal(ACTION_REJECT_REASONS.length, 13 + 2);
  assert.deepEqual([...ACTION_INPUT_REASONS, ...ACTION_REJECT_REASONS].sort(), [...ACTION_REASON_CODES].sort(), 'mỗi mã đúng một dạng');
  const texts = new Set();
  for (const code of ACTION_REASON_CODES) {
    const { form, retry, text } = ACTION_REASONS[code];
    assert.ok(/^[a-z][a-z_]{2,40}$/.test(code), code);
    assert.ok(ACTION_REASON_FORMS.includes(form) && ACTION_REASON_RETRIES.includes(retry), code);
    assert.ok(typeof text === 'string' && text.length >= 15 && text.length <= 160, code);
    assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}|\d{4,}/, `${code}: câu tĩnh không mang ID/số liệu`);
    assert.ok(!texts.has(text), `${code}: câu trùng`); texts.add(text);
  }
  // Câu "không thấy" phải nói trong phạm vi quyền (RLS có thể ẩn đối tượng có thật).
  for (const code of ['name_unresolved', 'not_found']) assert.match(ACTION_REASONS[code].text, /phạm vi quyền/);
  assert.equal(actionReason('period_locked'), 'period_locked');
  for (const bad of ['PERIOD_LOCKED', 'hermes_expense_rejected', '', null, undefined, 42, 'toString', '__proto__']) assert.equal(actionReason(bad), 'crm_refused');
  assert.equal(actionReasonText('nope'), ACTION_REASONS.crm_refused.text);
});

test('broker: action_rejected (400) và action_outcome_unknown (503, kèm requestId); actionRejected chỉ mang lý do dạng rejected', () => {
  assert.equal(ERROR_STATUS.action_rejected, 400);
  assert.equal(ERROR_STATUS.action_outcome_unknown, 503);
  assert.ok(REQUEST_RECEIPT_UNKNOWN.includes('action_outcome_unknown'));
  assert.equal(Object.hasOwn(ERROR_STATUS, 'action_input_unresolved'), false, 'tên không giải được là needs_input, không phải lỗi');
  for (const code of ACTION_REJECT_REASONS) {
    const error = actionRejected(code);
    assert.ok(error instanceof BrokerError);
    assert.deepEqual([error.code, error.status, error.reason, error.detail], ['action_rejected', 400, code, ACTION_REASONS[code].text]);
  }
  // Mã dạng needs_input hay mã lạ không bao giờ đi đường lỗi với chính nó.
  for (const code of [...ACTION_INPUT_REASONS, 'nope', undefined]) assert.equal(actionRejected(code).reason, 'crm_refused', String(code));
});

test('mcp-http: action_rejected chuyển đúng reason + câu tĩnh; reason lạ, dạng needs_input hay detail khác đều bị bỏ', async t => {
  let problem;
  const server = createMcpHttpServer({ broker: { callTool: async () => { throw problem; } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const invoke = async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: {
      'content-type': 'application/json', authorization: `Bearer hc_${'a'.repeat(43)}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'crm_action_run', arguments: { action: 'probe.confirm' } } }) });
    const body = await response.json(); assert.equal(response.status, 200); assert.equal(body.result.isError, true);
    return JSON.parse(body.result.content[0].text);
  };
  for (const code of ACTION_REJECT_REASONS) {
    problem = actionRejected(code);
    assert.deepEqual(await invoke(), { error: 'action_rejected', reason: code, detail: ACTION_REASONS[code].text }, code);
  }
  const forged = (reason, detail) => Object.assign(new BrokerError('action_rejected'), { reason, detail });
  for (const [reason, detail] of [['period_locked', 'Kỳ đã chốt — tok-PRIVATE-fake-r1'], ['invalid_params', ACTION_REASONS.invalid_params.text],
    ['nope', ACTION_REASONS.crm_refused.text], [null, null], ['period_locked', { text: ACTION_REASONS.period_locked.text }]]) {
    problem = forged(reason, detail);
    assert.deepEqual(await invoke(), { error: 'action_rejected' }, String(reason));
  }
  // Câu tĩnh của action_rejected không đi theo mã khác.
  problem = Object.assign(new BrokerError('forbidden'), { reason: 'not_allowed', detail: ACTION_REASONS.not_allowed.text });
  assert.deepEqual(await invoke(), { error: 'forbidden' });
  problem = Object.assign(new BrokerError('action_outcome_unknown'), { requestId: id('1') });
  assert.deepEqual(await invoke(), { error: 'action_outcome_unknown', requestId: id('1') });
});

test('audit broker: action_rejected ghi kèm reason (D9); lỗi khác không có reason', async t => {
  const scope = createDependencyScope(); t.after(() => scope.close());
  const CONNECTION = id('a'), read = ['customers.view'], audits = [];
  const identity = { row: { id: CONNECTION, assistantId: id('b'), userId: id('c'), organizationId: id('d'), expiresAt: Date.now() + 600_000, epoch: 1,
    state: 'active', restrictions: { read, action: [] } }, effective: { read, action: [] }, isSuperadmin: false, policyEpoch: 'a'.repeat(64),
  contextVersion: 'b'.repeat(64), assistantScopeIds: [id('e')], scopesByPermission: { 'customers.view': { buildingIds: [id('f')], cashbookIds: [] } } };
  let thrown;
  const broker = createBroker({ authority: { identifyConnection: async () => ({ connectionId: CONNECTION }), resolve: async () => identity, checkUnchanged: async () => {} },
    dependencyScope: scope, audit: async event => { audits.push(event); },
    domains: { async prepareDomain() { throw thrown; }, async finalizeDomain() { return {}; } } });
  thrown = actionRejected('not_allowed');
  await assert.rejects(broker.callTool(`hc_${'A'.repeat(43)}`, 'crm_read_customers', {}), error => error.code === 'action_rejected' && error.reason === 'not_allowed');
  assert.deepEqual(audits.at(-1), { requestId: audits.at(-1).requestId, operation: 'tools/call', connectionId: CONNECTION, outcome: 'denied', code: 'action_rejected', reason: 'not_allowed' });
  // reason giả trên lỗi khác, hay reason ngoài danh sách trên action_rejected: không vào sổ.
  thrown = Object.assign(new BrokerError('forbidden'), { reason: 'not_allowed' });
  await assert.rejects(broker.callTool(`hc_${'A'.repeat(43)}`, 'crm_read_customers', {}), error => error.code === 'forbidden');
  assert.equal(Object.hasOwn(audits.at(-1), 'reason'), false);
  thrown = Object.assign(new BrokerError('action_rejected'), { reason: 'invalid_params' });
  await assert.rejects(broker.callTool(`hc_${'A'.repeat(43)}`, 'crm_read_customers', {}));
  assert.equal(audits.at(-1).code, 'action_rejected');
  assert.equal(Object.hasOwn(audits.at(-1), 'reason'), false, 'dạng needs_input không phải lý do lỗi');
});
