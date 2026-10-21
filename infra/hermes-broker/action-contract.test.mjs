import test from 'node:test';
import assert from 'node:assert/strict';
import { advertisedTool } from './tool-argument-shape.mjs';
import { createActionCatalog, defineAction, param } from './action-catalog.mjs';
import { ACTION_LIST_TOOL, ACTION_RUN_TOOL, ACTION_STATUS_TOOL, ACTION_TOOL_SHAPE, actionEnvelope, actionToolRoute, actionTools, listedActionTools,
  nameUnresolvedDetail, needsInput, pageActionTool } from './action-contract.mjs';
import { ACTION_REASONS } from './action-reasons.mjs';
import { PROBE_KEY, probeCatalog } from './action-probe.fixture.mjs';

// Mặt tool của thao tác ghi dùng chung (NEN-CHUNG-THAO-TAC-GHI.md mục 4). D1 = A; khuôn B sinh từ cùng danh mục.
const bytes = tool => Buffer.byteLength(JSON.stringify(advertisedTool(tool)));
const firstSentence = tool => tool.description.split(/(?<=[.!?])\s/)[0];
const TASK = defineAction({ id: 'task.create', page: 'task', key: 'tasks.create', class: 'reversible', title: 'Tạo việc', params: { title: param.text(1, 200) } });
const mixed = () => createActionCatalog([...probeCatalog().ids.map(id => probeCatalog().actions[id]), TASK], { keys: [PROBE_KEY, 'tasks.create'] });

test('A (D1): ba tool chung ≤ 2 000 B tools/list, câu đầu ≤ 60 ký tự có từ khoá ASCII; khuôn B sinh từ cùng danh mục', t => {
  assert.equal(ACTION_TOOL_SHAPE, 'shared');
  const shared = [ACTION_LIST_TOOL, ACTION_RUN_TOOL, ACTION_STATUS_TOOL], sizes = shared.map(bytes), total = sizes.reduce((a, b) => a + b, 0);
  t.diagnostic(`crm_action_list ${sizes[0]} B, crm_action_run ${sizes[1]} B, crm_action_status ${sizes[2]} B = ${total} B`);
  assert.ok(total <= 2_000, `ba tool chung ${total} B > 2 000 B`);
  for (const tool of shared) {
    assert.ok(Object.isFrozen(tool) && Object.isFrozen(tool.inputSchema.properties), tool.name);
    const first = firstSentence(tool);
    assert.ok(first.length <= 60, `${tool.name}: câu đầu ${first.length} ký tự`);
    assert.match(first, /^[\x20-\x7e]+$/, `${tool.name}: câu đầu ASCII cho tool_search BM25`);
    assert.match(first, /CRM write action/);
  }
  // Không bắt buộc requestId ⇒ không kéo theo crm_new_request_id; confirmToken không bắt buộc.
  assert.deepEqual(ACTION_RUN_TOOL.inputSchema.required, ['action']);
  assert.match(ACTION_RUN_TOOL.description, /needs_input = CHƯA ghi/);
  assert.deepEqual(actionTools(probeCatalog()).map(tool => tool.name), ['crm_action_list', 'crm_action_run', 'crm_action_status']);
  const b = actionTools(mixed(), 'page');
  assert.deepEqual(b.map(tool => tool.name), ['crm_action_list', 'crm_probe_action', 'crm_task_action', 'crm_action_status']);
  assert.deepEqual(b[1].inputSchema.properties.operation.enum, ['note', 'confirm']);
  t.diagnostic(`khuôn B: ${b.map(tool => `${tool.name} ${bytes(tool)} B`).join(', ')}`);
  for (const tool of b) assert.ok(firstSentence(tool).length <= 60 && /^[\x20-\x7e]+$/.test(firstSentence(tool)), tool.name);
  assert.throws(() => pageActionTool('payroll', ['x']), /invalid_page_action_tool/);
  assert.throws(() => actionTools(probeCatalog(), 'other'), /invalid_action_tool_shape/);
});

test('định tuyến và liệt kê: không thao tác nào được cấp (hoặc danh mục rỗng) ⇒ không hiện tool nào', () => {
  const catalog = mixed(), empty = createActionCatalog([], { keys: [] });
  assert.deepEqual(actionToolRoute('crm_action_run', catalog), { op: 'run' });
  assert.deepEqual(actionToolRoute('crm_action_list', catalog), { op: 'list' });
  assert.deepEqual(actionToolRoute('crm_action_status', catalog), { op: 'status' });
  assert.equal(actionToolRoute('crm_task_action', catalog), undefined, 'khuôn A không có tool trang');
  assert.deepEqual(actionToolRoute('crm_task_action', catalog, 'page'), { op: 'run', page: 'task' });
  assert.equal(actionToolRoute('crm_contract_action', catalog, 'page'), undefined);
  assert.equal(actionToolRoute('crm_action_run', catalog, 'page'), undefined);
  assert.deepEqual(listedActionTools(empty, { action: [PROBE_KEY] }), []);
  assert.deepEqual(listedActionTools(catalog, { action: ['tasks.edit'] }), []);
  assert.deepEqual(listedActionTools(catalog, { action: ['tasks.create'] }).map(tool => tool.name), ['crm_action_list', 'crm_action_run', 'crm_action_status']);
  assert.deepEqual(listedActionTools(catalog, { action: ['tasks.create'] }, 'page').map(tool => tool.name), ['crm_action_list', 'crm_task_action', 'crm_action_status']);
});

test('phong bì đối số: sai kiểu ⇒ TypeError (invalid_request); mã thao tác lạ không lỗi ở đây; requestId chuẩn hoá chữ thường', () => {
  const RID = 'ABCDEF01-2345-4678-89AB-0123456789AB';
  assert.deepEqual(actionEnvelope({ op: 'run' }, { action: ' probe.note ', params: { note: 'x' }, requestId: RID }),
    { action: 'probe.note', params: { note: 'x' }, requestId: RID.toLowerCase() });
  assert.deepEqual(actionEnvelope({ op: 'run' }, { action: 'nope.nope' }), { action: 'nope.nope', params: undefined, requestId: undefined });
  // params là chuỗi JSON của object ⇒ đọc; chuỗi khác giữ nguyên để validator trả needs_input.
  assert.deepEqual(actionEnvelope({ op: 'run' }, { action: 'probe.note', params: ' {"note":"x"} ' }).params, { note: 'x' });
  for (const raw of ['[1]', '{bad', 'note=x', `{"a":"${'x'.repeat(4000)}"}`]) assert.equal(actionEnvelope({ op: 'run' }, { action: 'probe.note', params: raw }).params, raw);
  assert.deepEqual(actionEnvelope({ op: 'run', page: 'task' }, { operation: 'create', params: {} }), { action: 'task.create', params: {}, requestId: undefined });
  assert.deepEqual(actionEnvelope({ op: 'status' }, { requestId: RID }), { requestId: RID.toLowerCase() });
  assert.deepEqual(actionEnvelope({ op: 'list' }, {}), { page: null });
  assert.deepEqual(actionEnvelope({ op: 'list' }, { page: 'contract' }), { page: 'contract' });
  for (const [route, args] of [[{ op: 'run' }, {}], [{ op: 'run' }, { action: 1 }], [{ op: 'run' }, { action: 'probe.note', extra: 1 }],
    [{ op: 'run' }, { action: 'probe.note', requestId: 'not-a-uuid' }], [{ op: 'run', page: 'task' }, { action: 'task.create' }], [{ op: 'status' }, {}],
    [{ op: 'status' }, { requestId: RID, x: 1 }], [{ op: 'list' }, { page: 'payroll' }], [{ op: 'nope' }, {}], [{ op: 'run' }, null]])
    assert.throws(() => actionEnvelope(route, args), /invalid_action_envelope/, JSON.stringify(args));
});

test('needs_input là kết quả thường có huongDan; detail tên chỉ nêu chuỗi mô hình gửi + ứng viên trong phạm vi quyền', () => {
  assert.deepEqual(needsInput({ action: 'probe.note', reason: 'unknown_action' }), { outcome: 'needs_input', applied: false, action: 'probe.note',
    reason: 'unknown_action', detail: ACTION_REASONS.unknown_action.text, huongDan: 'CHƯA ghi. Gọi crm_action_list để lấy đúng mã thao tác và khuôn tham số.' });
  assert.equal(needsInput({ action: 'x.y', reason: 'invalid_params', detail: 'Thiếu: a' }).detail, 'Thiếu: a');
  assert.throws(() => needsInput({ action: 'x.y', reason: 'period_locked' }), /invalid_needs_input_reason/, 'lỗi thật không đi đường needs_input');
  assert.equal(nameUnresolvedDetail({ field: 'room', wanted: '201' }), "Không thấy phòng '201' trong phạm vi quyền của anh/chị; hỏi lại người dùng.");
  const many = Array.from({ length: 9 }, (_, i) => ({ name: '201', buildingName: `Toà ${i}` }));
  assert.equal(nameUnresolvedDetail({ field: 'room', wanted: 'p.201', candidates: many.slice(0, 2) }),
    "Phòng 'p.201' khớp nhiều: 201 (Toà 0), 201 (Toà 1) — hỏi người dùng nêu rõ.");
  assert.match(nameUnresolvedDetail({ field: 'building', wanted: 'x', candidates: many }), /201 \(Toà 7\), …/);
  assert.equal(nameUnresolvedDetail({ field: 'building', wanted: `a\nb${'c'.repeat(80)}` }).includes('\n'), false);
  assert.throws(() => nameUnresolvedDetail({ field: 'planet', wanted: 'x' }), /invalid_name_detail/);
});
