import test from 'node:test';
import assert from 'node:assert/strict';
import { advertisedTool } from './tool-argument-shape.mjs';
import { createActionCatalog, defineAction, param } from './action-catalog.mjs';
import { ACTION_LIST_TOOL, ACTION_RUN_TOOL, ACTION_STATUS_TOOL, ACTION_TOOL_SHAPE, actionEnvelope, actionToolRoute, actionTools, listedActionTools,
  nameUnresolvedDetail, needsInput, pageActionTool, RequestIdShapeError, isRequestIdShapeDetail, requestIdShapeDetail } from './action-contract.mjs';
import { ACTION_REASONS } from './action-reasons.mjs';
import { PROBE_KEY, probeCatalog } from './action-probe-contract.mjs';

// Mặt tool của thao tác ghi dùng chung (NEN-CHUNG-THAO-TAC-GHI.md mục 4). D1 = A; khuôn B sinh từ cùng danh mục.
const bytes = tool => Buffer.byteLength(JSON.stringify(advertisedTool(tool)));
const firstSentence = tool => tool.description.split(/(?<=[.!?])\s/)[0];
const TASK = defineAction({ id: 'task.create', page: 'task', key: 'tasks.create', class: 'reversible', rpc: 'hermes_task_action_v1', title: 'Tạo việc', params: { title: param.text(1, 200) } });
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
  // Lượt 16: requestId sai khuôn ⇒ RequestIdShapeError mang số ký tự (không mang chuỗi); lượt xác nhận (confirming) không ném — requestId lấy
  // theo token — nhưng mọi lỗi phong bì khác vẫn ném.
  const short = RID.slice(0, -1);
  assert.throws(() => actionEnvelope({ op: 'run' }, { action: 'probe.note', requestId: short }), error => error instanceof RequestIdShapeError && error.length === 35 &&
    !String(error.message).includes(short));
  assert.throws(() => actionEnvelope({ op: 'status' }, { requestId: short }), error => error instanceof RequestIdShapeError && error.length === 35);
  assert.throws(() => actionEnvelope({ op: 'run' }, { action: 'probe.note', requestId: 7 }), error => error instanceof RequestIdShapeError && error.length === null);
  assert.deepEqual(actionEnvelope({ op: 'run' }, { action: 'probe.note', requestId: short }, { confirming: true }),
    { action: 'probe.note', params: undefined, requestId: undefined, requestIdMalformed: true });
  assert.deepEqual(actionEnvelope({ op: 'run' }, { action: 'probe.note', requestId: RID }, { confirming: true }),
    { action: 'probe.note', params: undefined, requestId: RID.toLowerCase() });
  assert.throws(() => actionEnvelope({ op: 'run' }, { action: 'probe.note', extra: 1, requestId: short }, { confirming: true }), /invalid_action_envelope/);
  assert.equal(requestIdShapeDetail(35).includes(short), false);
  assert.equal(isRequestIdShapeDetail(requestIdShapeDetail(35)), true);
  assert.equal(isRequestIdShapeDetail(requestIdShapeDetail(null)), true);
  for (const bad of [null, '', 'requestId không đúng khuôn UUID (35 ký tự, cần 36)', requestIdShapeDetail(35).replace('35', '3a'), `${requestIdShapeDetail(1)}.`])
    assert.equal(isRequestIdShapeDetail(bad), false, String(bad));
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
  // why của hermes_write_name_resolve_v1: ngoài phạm vi ghi ≠ không thấy; không bao giờ "không có".
  // outside_scope: câu tĩnh, không bao giờ nêu tên ứng viên (kể cả khi được đưa vào).
  for (const candidates of [[], [{ name: 'Toà ngoài overlay' }]])
    assert.equal(nameUnresolvedDetail({ field: 'building', wanted: '44TL', why: 'outside_scope', candidates }),
      "Toà '44TL' nằm ngoài phạm vi toà mà kết nối được ghi; không làm được ở đó, báo người dùng.");
  assert.equal(nameUnresolvedDetail({ field: 'jobType', wanted: 'lau', why: 'not_visible' }), "Không thấy loại việc 'lau' trong phạm vi quyền của anh/chị; hỏi lại người dùng.");
  assert.equal(nameUnresolvedDetail({ field: 'person', wanted: 'nguyen van', why: 'ambiguous', candidates: [{ name: 'An' }, { name: 'Anh' }] }),
    "Người 'nguyen van' khớp nhiều: An, Anh — hỏi người dùng nêu rõ.");
  for (const why of ['outside_scope', 'ambiguous', 'not_visible', undefined]) assert.doesNotMatch(nameUnresolvedDetail({ field: 'room', wanted: 'x', why }), /không có/);
  assert.throws(() => nameUnresolvedDetail({ field: 'room', wanted: 'x', why: 'missing' }), /invalid_name_detail/);
});

test('Thu chi lượt 20: hạng mục chi chưa nêu có NHIỀU gợi ý ⇒ gọi lại NGAY với gợi ý hợp nội dung nhất; trường khác giữ "không tự chọn"; mã mơ hồ của tham số danh sách ⇒ "MÃ dd/mm/yyyy"', () => {
  const two = [{ name: 'Sửa chữa xây dựng' }, { name: 'Mua đồ điện máy' }];
  // A04: chỉ hạng mục (category). Người (assignee), toà, phòng, sổ, khách, loại việc: vẫn hỏi người dùng chọn một, không tự chọn.
  assert.equal(nameUnresolvedDetail({ field: 'category', wanted: '', why: 'unspecified', candidates: two }),
    'Chưa nêu hạng mục; gợi ý: Sửa chữa xây dựng, Mua đồ điện máy (gợi ý đầu khớp nhất) — gọi lại NGAY với category = gợi ý hợp nội dung nhất để lấy bản ' +
    'xem trước, nêu rõ hạng mục đã chọn và gợi ý còn lại; người dùng muốn hạng mục khác thì xem trước lại.');
  for (const field of ['person', 'building', 'room', 'cashbook', 'customer', 'jobType'])
    assert.equal(nameUnresolvedDetail({ field, wanted: '', why: 'unspecified', candidates: [{ name: 'A' }, { name: 'B' }] }).endsWith('— hỏi người dùng chọn một, không tự chọn.'), true, field);
  // Hạng mục MỘT gợi ý (C3n) giữ câu riêng; hạng mục đã nêu mà mơ hồ ⇒ câu cũ (hỏi người dùng nêu rõ).
  assert.match(nameUnresolvedDetail({ field: 'category', wanted: '', why: 'unspecified', candidates: two.slice(0, 1) }), /^Chưa nêu hạng mục; gợi ý duy nhất: Sửa chữa xây dựng — /);
  assert.equal(nameUnresolvedDetail({ field: 'category', wanted: 'sửa', why: 'ambiguous', candidates: two }),
    "Hạng mục 'sửa' khớp nhiều: Sửa chữa xây dựng, Mua đồ điện máy — hỏi người dùng nêu rõ.");
  // G02: mã phiếu mơ hồ thuộc tham số DANH SÁCH (listParam — runtime chỉ truyền khi thao tác luôn xem trước) ⇒ câu gọi lại theo từng mã; không
  // listParam (note / edit / cancel) ⇒ câu cũ. wanted nhiều mã không bị cắt ở 60 ký tự.
  const codes = 'PC2609064, PC2609077, PC2609090, PC2609091, PC2609092, PC2609093';
  const lot = nameUnresolvedDetail({ field: 'voucher', wanted: codes, why: 'ambiguous', candidates: [{ name: 'PC2609064 · 13/09/2026 · 331PHI · 45.000đ' }], listParam: 'voucherCodes' });
  assert.ok(lot.startsWith(`Mã phiếu '${codes}' khớp nhiều phiếu: PC2609064 · 13/09/2026 · 331PHI · 45.000đ — mỗi mã trên chọn MỘT phiếu rồi gọi lại voucherCodes`), lot);
  assert.match(lot, /'MÃ dd\/mm\/yyyy'/); assert.match(lot, /gọi lại NGAY/); assert.doesNotMatch(lot, /Còn ứng viên chưa nêu/);
  assert.match(nameUnresolvedDetail({ field: 'voucher', wanted: 'PC1', why: 'ambiguous', candidates: [{ name: 'PC1 · x' }], more: true, listParam: 'voucherCodes' }),
    / Còn ứng viên chưa nêu: mã chưa có ứng viên ở trên sẽ được nêu ở lượt gọi sau;/);
  assert.match(nameUnresolvedDetail({ field: 'voucher', wanted: 'PC2609052', why: 'ambiguous', candidates: [{ name: 'PC2609052 · 29/09/2026' }] }),
    /— hỏi người dùng chọn một, rồi gọi lại với voucherCode kèm ngày hoặc toà/);
  // listParam chỉ đổi câu mã phiếu mơ hồ: không thấy / ngoài phạm vi / trường khác giữ nguyên.
  assert.equal(nameUnresolvedDetail({ field: 'voucher', wanted: 'PC0000000', why: 'not_visible', listParam: 'voucherCodes' }),
    "Không thấy phiếu 'PC0000000' trong phạm vi quyền của anh/chị; hỏi lại người dùng.");
  assert.equal(nameUnresolvedDetail({ field: 'room', wanted: '201', why: 'ambiguous', candidates: [{ name: '201' }, { name: '201 ' }], listParam: 'rooms' }),
    "Phòng '201' khớp nhiều: 201, 201 — hỏi người dùng nêu rõ.");
  for (const listParam of ['', 'voucher codes', 7, '1x']) assert.throws(() => nameUnresolvedDetail({ field: 'voucher', wanted: 'x', listParam }), /invalid_name_detail/, String(listParam));
});
