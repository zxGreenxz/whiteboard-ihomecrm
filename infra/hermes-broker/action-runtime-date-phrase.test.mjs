import test from 'node:test';
import assert from 'node:assert/strict';
// external-group-mount nạp broker.mjs ngược lại: nạp trước (như action-runtime.test.mjs).
import './external-group-mount.mjs';
import { createBroker } from './broker.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
import { createActionCatalog, defineAction, param } from './action-catalog.mjs';
import { createActionRuntime } from './action-runtime.mjs';

// Công việc lượt 15 (nghiệm thu C3h, Chủ nhật 25/10/2026): cụm ngày NGUYÊN VĂN qua vòng đời thật của broker — SQL nhận ngày connector
// tự tính (không còn cụm), bản xem trước nêu "Hiểu '…' là …" trước cảnh báo của SQL, lượt đồng ý gửi y nguyên vẫn khớp token và gửi
// đúng ngày đã tính; cụm không hiểu ⇒ needs_input, không gửi gì xuống SQL. Đột biến bỏ quy đổi ⇒ SQL nhận ngày sai của mô hình.
const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const TOKEN = `hc_${'A'.repeat(43)}`;
const SUNDAY = Date.parse('2026-10-25T07:00:00.000Z'); // 14:00 giờ VN, Chủ nhật
const TASK = defineAction({ id: 'task.create', page: 'task', key: 'tasks.create', class: 'reversible', rpc: 'hermes_task_action_v1', title: 'Tạo việc',
  params: { content: param.text(1, 200), deadline: param.date({ optional: true }), deadlineTime: param.time({ optional: true }),
    deadlinePhrase: param.text(1, 80, { optional: true }) } });

function setup(t, { factory = createActionRuntime } = {}) {
  const scope = createDependencyScope(); t.after(() => scope.close());
  const requests = [];
  const identity = () => ({ row: { id: id('a'), assistantId: id('b'), userId: id('c'), organizationId: id('d'), expiresAt: SUNDAY + 86_400_000,
    epoch: 1, state: 'active', restrictions: { read: [], action: ['tasks.create'] } }, effective: { read: [], action: ['tasks.create'] }, isSuperadmin: false,
  policyEpoch: 'a'.repeat(64), contextVersion: 'b'.repeat(64), assistantScopeIds: [id('e')],
  scopesByPermission: { 'tasks.create': { buildingIds: [id('f')], cashbookIds: [] } } });
  let next = 0;
  const service = {
    async prepareAction(_token, request) { requests.push(structuredClone(request)); return Object.freeze({}); },
    async finalizeAction() {
      const request = requests.at(-1);
      return request.phase === 'apply' ? { kind: 'applied', result: { code: 'JOB-1', deadline: request.params.deadline }, link: '/tasks/1' }
        : { kind: 'preview', preview: { deadline: request.params.deadline }, basis: `b-${request.requestId}`, resolved: { buildingId: id('f') },
          confirm: 'required', warnings: ['Việc mới'] };
    },
  };
  const runtime = factory({ catalog: createActionCatalog([TASK], { keys: ['tasks.create'] }), service, clock: () => SUNDAY, mintRequestId: () => id(String(++next)) });
  const broker = createBroker({ authority: { identifyConnection: async () => ({ connectionId: id('a') }), resolve: async () => identity(), checkUnchanged: async () => {} },
    dependencyScope: scope, audit: async () => {}, clock: () => SUNDAY, actions: runtime });
  const call = async args => { const result = await broker.callTool(TOKEN, 'crm_action_run', args); assert.equal(result.isError, false); return JSON.parse(result.content[0].text); };
  return { requests, call };
}

test('cụm ngày: SQL nhận ngày đã quy đổi, xem trước nêu câu đọc lại, lượt đồng ý gửi y nguyên vẫn khớp', async t => {
  const { requests, call } = setup(t);
  const params = { content: 'Trang trí lại sảnh', deadline: '2026-11-06', deadlinePhrase: 'thứ sáu tuần sau' };
  const preview = await call({ action: 'task.create', params });
  assert.equal(preview.outcome, 'confirmation_required');
  assert.deepEqual(requests[0].params, { content: 'Trang trí lại sảnh', deadline: '2026-10-30' }, 'không phải 06/11 mô hình tính; cụm không xuống SQL');
  assert.match(preview.warnings[0], /^Hiểu "thứ sáu tuần sau" là thứ Sáu 30\/10\/2026 \(không phải thứ Sáu 06\/11\/2026/);
  assert.equal(preview.warnings[1], 'Việc mới');
  const applied = await call({ action: 'task.create', params, requestId: preview.requestId, confirmToken: preview.confirmToken });
  assert.equal(applied.outcome, 'applied');
  assert.equal(requests[1].phase, 'apply');
  assert.equal(requests[1].params.deadline, '2026-10-30');
  assert.ok(!Object.hasOwn(requests[1].params, 'deadlinePhrase'));
  assert.match(applied.notes[0], /thứ Sáu 30\/10\/2026/);
});

test('cụm ngày không hiểu ⇒ needs_input hỏi lại ngày, không gửi gì xuống SQL', async t => {
  const { requests, call } = setup(t);
  const result = await call({ action: 'task.create', params: { content: 'Sửa vòi', deadlinePhrase: 'sớm nhất có thể' } });
  assert.deepEqual([result.outcome, result.reason], ['needs_input', 'date_out_of_range']);
  assert.match(result.detail, /Chưa hiểu ngày "sớm nhất có thể"/);
  assert.equal(requests.length, 0);
});

test('không có cụm ⇒ như cũ (ngày mô hình gửi xuống SQL nguyên vẹn, không thêm câu)', async t => {
  const { requests, call } = setup(t);
  const preview = await call({ action: 'task.create', params: { content: 'Sửa vòi', deadline: '2026-10-28' } });
  assert.equal(requests[0].params.deadline, '2026-10-28');
  assert.deepEqual(preview.warnings, ['Việc mới']);
});
