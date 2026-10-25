import test from 'node:test';
import assert from 'node:assert/strict';
// external-group-mount nạp broker.mjs ngược lại: nạp trước (như action-runtime.test.mjs).
import './external-group-mount.mjs';
import { createBroker } from './broker.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
import { createActionCatalog, defineAction, param } from './action-catalog.mjs';
import { createActionRuntime } from './action-runtime.mjs';
import { collectGuard } from './collect-guard.mjs';

// C3j (nghiệm thu C3i 26/10/2026, ghi sai thật TC-A03): lần thu có ghi chú "chưa thanh toán…" ⇒ hỏi lại, không gửi gì xuống SQL;
// tên sổ là nhãn ứng viên ⇒ phần mã. Đột biến bằng tay: bỏ nhánh unpaid ⇒ ca đầu đỏ (SQL nhận lệnh thu L06).
test('collectGuard: ghi chú nói chưa trả ⇒ unpaid; ghi chú thường giữ nguyên; nhãn sổ ⇒ mã', () => {
  for (const note of ['Chưa thanh toán phần còn thiếu tháng 10', 'khách chưa trả', 'CHUA CK', 'phòng này chưa đóng tiền', 'khách không trả nữa', 'chưa chuyển khoản'])
    assert.equal(collectGuard('invoice.collect', { note }).unpaid, note, note);
  for (const note of ['Khách chuyển khoản đủ phần còn thiếu tháng 10', 'trả nốt tiền tháng 10', 'thu tiền điện, vệ sinh khi trả phòng', 'chưa có biên lai'])
    assert.equal(collectGuard('invoice.collect', { note }).unpaid, null, note);
  assert.deepEqual(collectGuard('invoice.collect', { cashbookName: 'HKDHUY — thanh toán (TT)', method: 'TT' }).params, { cashbookName: 'HKDHUY', method: 'TT' });
  assert.deepEqual(collectGuard('invoice.collect', { cashbookName: 'HKD Tâm' }).params, { cashbookName: 'HKD Tâm' });
  assert.deepEqual(collectGuard('expense.create', { note: 'chưa thanh toán' }), { params: { note: 'chưa thanh toán' }, unpaid: null }, 'chỉ áp cho invoice.collect');
});

const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const TOKEN = `hc_${'A'.repeat(43)}`;
const NOW = Date.parse('2026-10-25T17:09:00.000Z');
const COLLECT = defineAction({ id: 'invoice.collect', page: 'invoice', key: 'thu_tien.collect_transfer', class: 'money', rpc: 'hermes_invoice_action_v1', title: 'Thu tiền',
  params: { buildingName: param.name('building', { optional: true }), roomName: param.name('room', { optional: true }), month: param.month({ optional: true }),
    method: param.oneOf(['TK', 'TT', 'TM']), cashbookName: param.name('cashbook', { optional: true }), note: param.text(1, 200, { optional: true }) } });

function setup(t) {
  const scope = createDependencyScope(); t.after(() => scope.close());
  const requests = [];
  const identity = () => ({ row: { id: id('a'), assistantId: id('b'), userId: id('c'), organizationId: id('d'), expiresAt: NOW + 86_400_000,
    epoch: 1, state: 'active', restrictions: { read: [], action: ['thu_tien.collect_transfer'] } }, effective: { read: [], action: ['thu_tien.collect_transfer'] }, isSuperadmin: false,
  policyEpoch: 'a'.repeat(64), contextVersion: 'b'.repeat(64), assistantScopeIds: [id('e')],
  scopesByPermission: { 'thu_tien.collect_transfer': { buildingIds: [id('f')], cashbookIds: [] } } });
  let next = 0;
  const service = {
    async prepareAction(_token, request) { requests.push(structuredClone(request)); return Object.freeze({}); },
    async finalizeAction() {
      const request = requests.at(-1);
      return { kind: 'preview', preview: { room: request.params.roomName }, basis: `b-${request.requestId}`, resolved: { invoiceId: id('f') }, confirm: 'required' };
    },
  };
  const runtime = createActionRuntime({ catalog: createActionCatalog([COLLECT], { keys: ['thu_tien.collect_transfer'] }), service, clock: () => NOW, mintRequestId: () => id(String(++next)) });
  const broker = createBroker({ authority: { identifyConnection: async () => ({ connectionId: id('a') }), resolve: async () => identity(), checkUnchanged: async () => {} },
    dependencyScope: scope, audit: async () => {}, clock: () => NOW, actions: runtime });
  const call = async args => { const result = await broker.callTool(TOKEN, 'crm_action_run', args); assert.equal(result.isError, false); return JSON.parse(result.content[0].text); };
  return { requests, call };
}

test('vòng đời thật: lần thu L06 "chưa thanh toán" ⇒ needs_input, không gửi gì xuống SQL', async t => {
  const { requests, call } = setup(t);
  const result = await call({ action: 'invoice.collect', params: { buildingName: '1392', roomName: 'L06', month: '2026-10', method: 'TK',
    note: 'Chưa thanh toán phần còn thiếu tháng 10' } });
  assert.deepEqual([result.outcome, result.reason], ['needs_input', 'invalid_params']);
  assert.match(result.detail, /CHƯA được trả/);
  assert.equal(requests.length, 0);
});

test('vòng đời thật: nhãn sổ ứng viên ⇒ SQL nhận mã sổ; ghi chú thường vẫn xem trước', async t => {
  const { requests, call } = setup(t);
  const preview = await call({ action: 'invoice.collect', params: { buildingName: '80', roomName: '204', method: 'TT', cashbookName: 'HKDHUY — thanh toán (TT)',
    note: 'tiền điện với vệ sinh khi trả phòng' } });
  assert.equal(preview.outcome, 'confirmation_required');
  assert.equal(requests[0].params.cashbookName, 'HKDHUY');
});
