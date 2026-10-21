import test from 'node:test';
import assert from 'node:assert/strict';
// external-group-mount nạp broker.mjs ngược lại: nạp trước (như tool-argument-shape.test.mjs).
import './external-group-mount.mjs';
import { createBroker } from './broker.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
import { createActionCatalog, defineAction, param } from './action-catalog.mjs';
import { createActionRuntime } from './action-runtime.mjs';
import { ACTION_REASONS } from './action-reasons.mjs';
import { CONFIRM_TTL_MS } from './confirm-guard.mjs';
import { PROBE_CONFIRM, PROBE_KEY, PROBE_NOTE } from './action-probe-contract.mjs';

// Vòng đời một lệnh ghi qua broker thật (NEN-CHUNG-THAO-TAC-GHI.md mục 3): needs_input là kết quả thường, sàn xác nhận
// cho money, requestId do connector cấp, token một lần gắn nội dung, lượt 2 gửi bản đã giải + basis của lượt 1,
// từ chối thật mang reason, mất phản hồi ⇒ action_outcome_unknown + requestId. Cổng dịch vụ giả ghi lại mọi yêu cầu.
const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const TOKEN_A = `hc_${'A'.repeat(43)}`, TOKEN_B = `hc_${'B'.repeat(43)}`;
const CONNECTIONS = { [TOKEN_A]: id('a'), [TOKEN_B]: id('9') };
const START = Date.parse('2026-10-21T12:00:00.000Z');
const OTHER = defineAction({ id: 'task.create', page: 'task', key: 'tasks.create', class: 'reversible', rpc: 'hermes_task_action_v1', title: 'Tạo việc', params: { title: param.text(1, 200) } });
const CF = /^cf_[A-Za-z0-9_-]{43}$/;

function setup(t, { action = [PROBE_KEY], respond } = {}) {
  const scope = createDependencyScope(); t.after(() => scope.close());
  const clock = { now: START }, requests = [], audits = [];
  const identity = token => ({ row: { id: CONNECTIONS[token], assistantId: id('b'), userId: id('c'), organizationId: id('d'), expiresAt: START + 86_400_000,
    epoch: 1, state: 'active', restrictions: { read: [], action } }, effective: { read: [], action }, isSuperadmin: false,
  policyEpoch: 'a'.repeat(64), contextVersion: 'b'.repeat(64), assistantScopeIds: [id('e')],
  scopesByPermission: Object.fromEntries(action.map(key => [key, { buildingIds: [id('f')], cashbookIds: [] }])) });
  let next = 0;
  const service = {
    async prepareAction(token, request) { requests.push([CONNECTIONS[token], structuredClone(request)]); return Object.freeze({}); },
    async finalizeAction(_token, _receipt, hooks) { return respond(requests.at(-1)[1], hooks); },
  };
  const runtime = createActionRuntime({ catalog: createActionCatalog([PROBE_NOTE, PROBE_CONFIRM, OTHER], { keys: [PROBE_KEY, 'tasks.create'] }),
    service, clock: () => clock.now, mintRequestId: () => id(String(++next)) });
  const broker = createBroker({ authority: { identifyConnection: async token => ({ connectionId: CONNECTIONS[token] }), resolve: async token => identity(token),
    checkUnchanged: async () => {} }, dependencyScope: scope, audit: async event => { audits.push(event); }, clock: () => clock.now, actions: runtime });
  const call = async (name, args, token = TOKEN_A) => {
    const result = await broker.callTool(token, name, args);
    assert.equal(result.isError, false);
    return JSON.parse(result.content[0].text);
  };
  return { broker, clock, requests, audits, call };
}
const PREVIEW = request => ({ kind: 'preview', preview: { building: 'Toà A', amount: '1000' }, basis: `b-${request.requestId}`,
  resolved: { buildingId: id('f') }, confirm: 'required', warnings: ['Ngày lùi 2 ngày'] });
const APPLIED = request => ({ kind: 'applied', result: { code: 'PT-1', phase: request.phase }, link: '/probe/1' });

test('liệt kê: kết nối không giữ khoá thao tác nào ⇒ không có tool, gọi ⇒ tool_not_available; có khoá ⇒ ba tool + mục lục theo quyền', async t => {
  const none = setup(t, { action: ['tasks.edit'], respond: APPLIED });
  assert.deepEqual((await none.broker.listTools(TOKEN_A)).tools.map(tool => tool.name), []);
  await assert.rejects(none.broker.callTool(TOKEN_A, 'crm_action_list', {}), error => error.code === 'tool_not_available');
  await assert.rejects(none.broker.callTool(TOKEN_A, 'crm_action_run', { action: 'probe.note' }), error => error.code === 'tool_not_available');
  const env = setup(t, { respond: APPLIED });
  assert.deepEqual((await env.broker.listTools(TOKEN_A)).tools.map(tool => tool.name), ['crm_action_list', 'crm_action_run', 'crm_action_status']);
  const listing = await env.call('crm_action_list', {});
  assert.deepEqual(listing.items.map(item => [item.action, item.confirm]), [['probe.note', 'if_required'], ['probe.confirm', 'always']]);
  assert.deepEqual(env.requests, [], 'mục lục không gọi CRM');
});

test('thiếu/sai đầu vào là KẾT QUẢ needs_input (không phải lỗi), không gọi CRM: ba lần liên tiếp vẫn không có lỗi MCP nào', async t => {
  const env = setup(t, { respond: APPLIED });
  const unknown = await env.call('crm_action_run', { action: 'probe.nope' });
  assert.deepEqual([unknown.outcome, unknown.reason, unknown.applied], ['needs_input', 'unknown_action', false]);
  const missing = await env.call('crm_action_run', { action: 'probe.confirm', params: { buildingName: 'A' } });
  assert.equal(missing.reason, 'invalid_params');
  assert.match(missing.detail, /^Thiếu hoặc sai: amount \(số nguyên VND/);
  const wrong = await env.call('crm_action_run', { action: 'probe.confirm', params: { amount: '3tr5', buildingName: 'A' } });
  assert.equal(wrong.reason, 'invalid_params');
  assert.deepEqual(env.requests, []);
  assert.ok(env.audits.every(event => event.outcome === 'prepared'), 'không có dòng denied nào');
});

test('money: lượt 1 luôn xem trước (requestId do connector cấp) ⇒ lượt 2 gửi đúng bản đã giải + basis của lượt 1; token một lần', async t => {
  const env = setup(t, { respond: request => request.phase === 'apply' ? APPLIED(request) : PREVIEW(request) });
  const args = { action: 'probe.confirm', params: { amount: '1000', building_name: 'Toà A' } };
  const first = await env.call('crm_action_run', args);
  assert.equal(first.outcome, 'confirmation_required'); assert.equal(first.applied, false);
  assert.equal(first.requestId, id('1'));
  assert.match(first.confirmToken, CF);
  assert.equal(first.expiresAt, new Date(START + CONFIRM_TTL_MS).toISOString());
  assert.deepEqual(first.preview, { building: 'Toà A', amount: '1000' });
  assert.deepEqual(first.warnings, ['Ngày lùi 2 ngày']);
  assert.match(first.huongDan, /chỉ khi họ đồng ý rõ ràng SAU khi xem/);
  assert.deepEqual(env.requests.at(-1)[1], { op: 'run', action: 'probe.confirm', phase: 'preview', requestId: id('1'), params: { amount: 1000, buildingName: 'Toà A' } });
  // Lượt 2: cùng nội dung (dạng khác nhưng chuẩn hoá như nhau), cùng requestId, kèm token.
  const second = await env.call('crm_action_run', { action: 'probe.confirm', params: { buildingName: 'Toà A', amount: 1000 }, requestId: first.requestId, confirmToken: first.confirmToken });
  assert.deepEqual(second, { outcome: 'applied', applied: true, action: 'probe.confirm', requestId: id('1'), result: { code: 'PT-1', phase: 'apply' }, link: '/probe/1' });
  assert.deepEqual(env.requests.at(-1)[1], { op: 'run', action: 'probe.confirm', phase: 'apply', requestId: id('1'),
    params: { amount: 1000, buildingName: 'Toà A' }, resolved: { buildingId: id('f') }, basis: `b-${id('1')}` });
  const before = env.requests.length;
  await assert.rejects(env.broker.callTool(TOKEN_A, 'crm_action_run', { ...args, requestId: first.requestId, confirmToken: first.confirmToken }),
    error => error.code === 'confirmation_invalid', 'token đã dùng');
  assert.equal(env.requests.length, before, 'không gọi CRM');
});

test('lượt 2 lệch bất cứ gì đã xem ⇒ confirmation_invalid, không ghi: nội dung, requestId, thiếu requestId, kết nối khác, quá 10 phút, token sai dạng', async t => {
  const env = setup(t, { respond: request => request.phase === 'apply' ? APPLIED(request) : PREVIEW(request) });
  const base = { action: 'probe.confirm', params: { amount: 1000, buildingName: 'Toà A' } };
  const fresh = async () => env.call('crm_action_run', base);
  const cases = [
    first => [TOKEN_A, { ...base, params: { amount: 2000, buildingName: 'Toà A' }, requestId: first.requestId, confirmToken: first.confirmToken }],
    first => [TOKEN_A, { ...base, requestId: id('e'), confirmToken: first.confirmToken }],
    first => [TOKEN_A, { ...base, confirmToken: first.confirmToken }],
    first => [TOKEN_B, { ...base, requestId: first.requestId, confirmToken: first.confirmToken }],
    first => { env.clock.now += CONFIRM_TTL_MS; return [TOKEN_A, { ...base, requestId: first.requestId, confirmToken: first.confirmToken }]; },
    first => [TOKEN_A, { ...base, requestId: first.requestId, confirmToken: 'cf_short' }],
  ];
  for (const [index, build] of cases.entries()) {
    const [token, args] = build(await fresh());
    const before = env.requests.length;
    await assert.rejects(env.broker.callTool(token, 'crm_action_run', args), error => error.code === 'confirmation_invalid', `ca ${index}`);
    assert.equal(env.requests.filter(([, request]) => request.phase === 'apply').length, 0, `ca ${index}: không lượt apply nào`);
    assert.equal(env.requests.length, before, `ca ${index}: không gọi CRM`);
  }
});

test('reversible: phase auto ⇒ SQL ghi thẳng (applied) hoặc đòi xác nhận (preview); money mà SQL ghi ở lượt xem trước ⇒ backend_unavailable', async t => {
  let mode = 'apply';
  const env = setup(t, { respond: request => mode === 'apply' ? APPLIED(request) : PREVIEW(request) });
  const direct = await env.call('crm_action_run', { action: 'probe.note', params: { note: 'kiểm nền chung' } });
  assert.deepEqual(direct, { outcome: 'applied', applied: true, action: 'probe.note', requestId: id('1'), result: { code: 'PT-1', phase: 'auto' }, link: '/probe/1' });
  assert.equal(env.requests.at(-1)[1].phase, 'auto');
  mode = 'preview';
  const asked = await env.call('crm_action_run', { action: 'probe.note', params: { note: 'chính sách siết' } });
  assert.equal(asked.outcome, 'confirmation_required');
  // Sàn D2: thao tác money không bao giờ đi 'auto'; SQL trả applied ở lượt xem trước là sai khuôn.
  mode = 'apply';
  await assert.rejects(env.broker.callTool(TOKEN_A, 'crm_action_run', { action: 'probe.confirm', params: { amount: 1000, buildingName: 'A' } }),
    error => error.code === 'backend_unavailable');
  assert.equal(env.requests.at(-1)[1].phase, 'preview');
});

test('từ chối thật của SQL ⇒ lỗi action_rejected mang reason + câu tĩnh (audit có reason), không thành mã bất định dù đã gửi lệnh ghi', async t => {
  let reply;
  const env = setup(t, { respond: (_request, hooks) => { hooks.onDispatch(); return reply; } });
  reply = { kind: 'rejected', reason: 'period_locked' };
  await assert.rejects(env.broker.callTool(TOKEN_A, 'crm_action_run', { action: 'probe.note', params: { note: 'x' } }),
    error => error.code === 'action_rejected' && error.reason === 'period_locked' && error.detail === ACTION_REASONS.period_locked.text);
  assert.deepEqual([env.audits.at(-1).code, env.audits.at(-1).reason], ['action_rejected', 'period_locked']);
  reply = { kind: 'rejected', reason: 'sql said: tok-PRIVATE-fake-s1' };
  await assert.rejects(env.broker.callTool(TOKEN_A, 'crm_action_run', { action: 'probe.note', params: { note: 'x' } }),
    error => error.code === 'action_rejected' && error.reason === 'crm_refused');
  // Lý do dạng needs_input từ SQL (thiếu lý do lúc ghi) vẫn là kết quả thường.
  reply = { kind: 'rejected', reason: 'reason_required' };
  assert.equal((await env.call('crm_action_run', { action: 'probe.note', params: { note: 'x' } })).reason, 'reason_required');
  // Tên không giải được: chỉ chuỗi mô hình gửi + ứng viên trong phạm vi quyền.
  reply = { kind: 'needs_input', reason: 'name_unresolved', field: 'room', wanted: '201', candidates: [{ name: '201', buildingName: 'Toà A' }, { name: '201', buildingName: 'Toà B' }] };
  const unresolved = await env.call('crm_action_run', { action: 'probe.note', params: { note: 'x' } });
  assert.deepEqual([unresolved.outcome, unresolved.reason, unresolved.detail], ['needs_input', 'name_unresolved',
    "Phòng '201' khớp nhiều: 201 (Toà A), 201 (Toà B) — hỏi người dùng nêu rõ."]);
  assert.equal(unresolved.candidates.length, 2);
  reply = { kind: 'needs_input', reason: 'name_unresolved', field: 'building', wanted: '44TL', why: 'outside_scope', candidates: [{ name: '44TL' }], more: false };
  assert.match((await env.call('crm_action_run', { action: 'probe.note', params: { note: 'x' } })).detail, /ngoài phạm vi toà mà kết nối được ghi/);
  reply = { kind: 'needs_input', reason: 'name_unresolved', field: 'room', wanted: '201', why: 'nope', candidates: [] };
  await assert.rejects(env.broker.callTool(TOKEN_A, 'crm_action_run', { action: 'probe.note', params: { note: 'x' } }), error => error.code === 'backend_unavailable');
  reply = { kind: 'needs_input', reason: 'name_unresolved', field: 'room', wanted: '201', candidates: [{ name: '201', id: id('f') }] };
  await assert.rejects(env.broker.callTool(TOKEN_A, 'crm_action_run', { action: 'probe.note', params: { note: 'x' } }), error => error.code === 'backend_unavailable',
    'ứng viên mang thêm trường (ID) ⇒ sai khuôn');
});

test('mất phản hồi sau khi gửi lệnh ghi ⇒ action_outcome_unknown kèm requestId; tra trạng thái theo requestId', async t => {
  let mode = 'lost';
  const env = setup(t, { respond: (request, hooks) => {
    if (request.op === 'status') return { kind: 'status', outcome: 'applied', action: 'probe.note', result: { code: 'PT-1' } };
    if (mode === 'lost') { hooks.onDispatch(); throw new Error('socket hang up'); }
    hooks.onDispatch(); hooks.onRejected(); throw new Error('rejected before write');
  } });
  await assert.rejects(env.broker.callTool(TOKEN_A, 'crm_action_run', { action: 'probe.note', params: { note: 'x' } }),
    error => error.code === 'action_outcome_unknown' && error.requestId === id('1'));
  mode = 'refused';
  await assert.rejects(env.broker.callTool(TOKEN_A, 'crm_action_run', { action: 'probe.note', params: { note: 'x' } }),
    error => error.code === 'backend_unavailable', 'bị từ chối trước khi ghi ⇒ không bất định');
  const status = await env.call('crm_action_status', { requestId: id('1') });
  assert.deepEqual(status, { requestId: id('1'), outcome: 'applied', action: 'probe.note', result: { code: 'PT-1' } });
  assert.deepEqual(env.requests.at(-1)[1], { op: 'status', requestId: id('1') });
  await assert.rejects(env.broker.callTool(TOKEN_A, 'crm_action_status', {}), error => error.code === 'invalid_request');
});

test('thao tác có trong danh mục nhưng kết nối thiếu khoá của nó ⇒ action_rejected action_disabled (lỗi thật), không gọi CRM', async t => {
  const env = setup(t, { action: ['tasks.create'], respond: APPLIED });
  await assert.rejects(env.broker.callTool(TOKEN_A, 'crm_action_run', { action: 'probe.note', params: { note: 'x' } }),
    error => error.code === 'action_rejected' && error.reason === 'action_disabled');
  assert.deepEqual((await env.call('crm_action_list', {})).items.map(item => item.action), ['task.create']);
  assert.deepEqual(env.requests, []);
});
