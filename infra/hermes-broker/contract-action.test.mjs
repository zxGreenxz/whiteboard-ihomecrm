import test from 'node:test';
import assert from 'node:assert/strict';
// external-group-mount nạp broker.mjs ngược lại: nạp trước (như tool-argument-shape.test.mjs).
import './external-group-mount.mjs';
import { createBroker } from './broker.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
import { createActionCatalog, validateActionParams } from './action-catalog.mjs';
import { createActionRuntime } from './action-runtime.mjs';
import { ACTION_PAGE_REASON_BLOCKS, ACTION_REASONS } from './action-reasons.mjs';
import { HERMES_ACTION_CAPABILITIES } from './capability-contract.mjs';
import { probeCatalog, PROBE_KEY } from './action-probe-contract.mjs';
import { fullGrantBroker } from './full-grant-broker.fixture.mjs';
import { CONTRACT_ACTIONS, CONTRACT_NOTICE_CANCEL, CONTRACT_NOTICE_SET, CONTRACT_RENEW, CONTRACT_ROOM_LOCK, CONTRACT_ROOM_UNLOCK } from './contract-action-contract.mjs';

// Danh mục thao tác trang HỢP ĐỒNG (HOP-DONG-THAO-TAC-GHI.md mục 3–5) qua khung chung: khuôn tham số, lớp ghi thẳng (Q2 = a,
// D-HĐ1), mã lý do riêng trang tới mô hình đúng dạng (needs_input là kết quả thường, rejected là action_rejected + câu tĩnh),
// và 0 byte tools/list so với danh mục thử.
const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const TOKEN = `hc_${'A'.repeat(43)}`;
const KEYS = ['contracts.terminate', 'sale_phong.lock_room', 'contracts.renew'];

function setup(t, { action = KEYS, respond } = {}) {
  const scope = createDependencyScope(); t.after(() => scope.close());
  const requests = [];
  const identity = () => ({ row: { id: id('a'), assistantId: id('b'), userId: id('c'), organizationId: id('d'), expiresAt: Date.now() + 86_400_000,
    epoch: 1, state: 'active', restrictions: { read: [], action } }, effective: { read: [], action }, isSuperadmin: false,
  policyEpoch: 'a'.repeat(64), contextVersion: 'b'.repeat(64), assistantScopeIds: [id('e')],
  scopesByPermission: Object.fromEntries(action.map(key => [key, { buildingIds: [id('f')], cashbookIds: [] }])) });
  let next = 0;
  const service = {
    async prepareAction(_token, request) { requests.push(structuredClone(request)); return Object.freeze({}); },
    async finalizeAction(_token, _receipt, hooks) { hooks.onDispatch?.(); return respond(requests.at(-1)); },
  };
  const runtime = createActionRuntime({ catalog: createActionCatalog([...CONTRACT_ACTIONS]), service, mintRequestId: () => id(String(++next)) });
  const broker = createBroker({ authority: { identifyConnection: async () => ({ connectionId: id('a') }), resolve: async () => identity(), checkUnchanged: async () => {} },
    dependencyScope: scope, audit: async () => {}, actions: runtime });
  const call = async (name, args) => { const result = await broker.callTool(TOKEN, name, args); assert.equal(result.isError, false); return JSON.parse(result.content[0].text); };
  return { broker, requests, call };
}

test('danh mục: bốn thao tác Mốc 2 + gia hạn Mốc 3, khoá ⊆ hợp đồng khoá Action, một RPC trang, lý do ∈ khối Hợp đồng', () => {
  const catalog = createActionCatalog([...CONTRACT_ACTIONS]);
  assert.deepEqual(catalog.ids, ['contract.notice_set', 'contract.notice_cancel', 'contract.room_lock', 'contract.room_unlock', 'contract.renew']);
  assert.deepEqual(catalog.rpcs, ['hermes_contract_action_v1']);
  assert.deepEqual(catalog.keys, [...KEYS].sort());
  assert.ok(catalog.keys.every(key => HERMES_ACTION_CAPABILITIES.includes(key)));
  for (const action of CONTRACT_ACTIONS) {
    // Q2 = a: báo trả / khoá tạm ghi thẳng; gia hạn không lùi được ⇒ luôn xem trước (sàn trong mã).
    assert.equal(action.class, action.id === 'contract.renew' ? 'irreversible' : 'reversible', action.id);
    assert.ok(action.reasons.every(code => ACTION_PAGE_REASON_BLOCKS.contract.includes(code)), action.id);
    assert.deepEqual(Object.keys(action.params).slice(0, 2), ['buildingName', 'roomName'], `${action.id}: toà + phòng`);
    assert.ok(!action.params.buildingName.optional && !action.params.roomName.optional, `${action.id}: toà và phòng bắt buộc`);
  }
  // Danh mục chung (probe + trang) nạp được: không trùng mã, cùng khung.
  assert.equal(createActionCatalog([...probeCatalog().ids.map(idValue => probeCatalog().get(idValue)), ...CONTRACT_ACTIONS]).ids.length, 7);
});

test('kiểm tham số: ngày YYYY-MM-DD, lý do huỷ ≥ 8 ký tự, giờ khoá là số nguyên; gợi ý tĩnh không nhắc giá trị đã gửi', () => {
  const ok = validateActionParams(CONTRACT_NOTICE_SET, { building_name: 'Toà A', roomName: '302', date: '2026-10-31' });
  assert.deepEqual(ok, { ok: true, value: { buildingName: 'Toà A', roomName: '302', date: '2026-10-31' } });
  const badDate = validateActionParams(CONTRACT_NOTICE_SET, { buildingName: 'Toà A', roomName: '302', date: '31/10/2026' });
  assert.equal(badDate.ok, false); assert.match(badDate.detail, /date \(ngày YYYY-MM-DD/); assert.doesNotMatch(badDate.detail, /31\/10/);
  assert.equal(validateActionParams(CONTRACT_NOTICE_CANCEL, { buildingName: 'Toà A', roomName: '302', reason: 'ở tiếp' }).ok, false);
  assert.deepEqual(validateActionParams(CONTRACT_ROOM_LOCK, { buildingName: 'Toà A', roomName: '205', hours: '12' }).value.hours, 12);
  assert.equal(validateActionParams(CONTRACT_ROOM_LOCK, { buildingName: 'Toà A', roomName: '205', hours: 48 }).ok, false);
  assert.equal(validateActionParams(CONTRACT_ROOM_UNLOCK, { buildingName: 'Toà A' }).ok, false, 'thiếu phòng');
  assert.equal(validateActionParams(CONTRACT_NOTICE_SET, { buildingName: 'Toà A', roomName: '302', date: '2026-10-31', contractId: id('1') }).ok, false,
    'không nhận id HĐ từ mô hình');
  // Gia hạn: months 1–60, ngày YYYY-MM-DD, lý do ≥ 8, giá/cọc là số VND; ĐÚNG MỘT trong months/newEndDate do SQL kiểm.
  assert.deepEqual(validateActionParams(CONTRACT_RENEW, { buildingName: 'Toà A', roomName: '302', months: '6', noReason: true }).value,
    { buildingName: 'Toà A', roomName: '302', months: 6, noReason: true });
  for (const bad of [{ months: 0 }, { months: 61 }, { newEndDate: '31/08/2027' }, { months: 6, reason: 'ngắn' }, { months: 6, newRentPrice: -1 }])
    assert.equal(validateActionParams(CONTRACT_RENEW, { buildingName: 'Toà A', roomName: '302', ...bad }).ok, false, JSON.stringify(bad));
});

test('vòng đời: ghi thẳng ở lượt 1 (auto, không confirmToken); mã trang needs_input là kết quả thường; rejected mang câu tĩnh', async t => {
  const outcomes = {
    '2026-10-31': { kind: 'applied', result: { text: 'Đã ghi báo trả phòng 302 toà A' }, link: '/contracts/x' },
    '2026-10-01': { kind: 'needs_input', reason: 'notice_date_past' },
    '2026-11-30': { kind: 'needs_input', reason: 'room_has_no_active_contract' },
    '2026-12-31': { kind: 'rejected', reason: 'already_returned' },
  };
  const env = setup(t, { respond: request => outcomes[request.params.date] });
  const place = { buildingName: 'Toà A', roomName: '302' };
  const applied = await env.call('crm_action_run', { action: 'contract.notice_set', params: { ...place, date: '2026-10-31' } });
  assert.equal(applied.outcome, 'applied'); assert.equal(applied.requestId, id('1'));
  assert.equal(env.requests.at(-1).phase, 'auto', 'reversible ⇒ auto: SQL ghi thẳng theo chính sách');
  for (const [date, reason] of [['2026-10-01', 'notice_date_past'], ['2026-11-30', 'room_has_no_active_contract']]) {
    const needs = await env.call('crm_action_run', { action: 'contract.notice_set', params: { ...place, date } });
    assert.deepEqual([needs.outcome, needs.applied, needs.reason, needs.detail], ['needs_input', false, reason, ACTION_REASONS[reason].text]);
  }
  await assert.rejects(env.broker.callTool(TOKEN, 'crm_action_run', { action: 'contract.notice_set', params: { ...place, date: '2026-12-31' } }),
    error => error.code === 'action_rejected' && error.reason === 'already_returned');
  const listing = await env.call('crm_action_list', { page: 'contract' });
  assert.deepEqual(listing.items.map(item => [item.action, item.confirm]),
    CONTRACT_ACTIONS.map(action => [action.id, action.class === 'reversible' ? 'if_required' : 'always']));
});

test('gia hạn: lượt 1 luôn xem trước (phase preview) dù không có confirmToken; đồng ý ⇒ apply mang resolved + basis của bản xem trước', async t => {
  const env = setup(t, { respond: request => request.params.newRentPrice !== undefined ? { kind: 'rejected', reason: 'renew_price_change_web_only' }
    : request.phase === 'preview' ? (request.params.months === 6 ? { kind: 'preview', preview: { text: 'Sẽ gia hạn phòng 302 toà A …' }, basis: 'b'.repeat(32), resolved: { contractId: id('9') },
      confirm: 'required', warnings: ['HĐ vừa được gia hạn lúc …'] } : { kind: 'needs_input', reason: 'renew_reason_ask' })
    : request.phase === 'apply' ? { kind: 'applied', result: { text: 'Đã gia hạn phòng 302 toà A' }, link: '/contracts/x' } : { kind: 'rejected', reason: 'crm_refused' } });
  const place = { buildingName: 'Toà A', roomName: '302' };
  const ask = await env.call('crm_action_run', { action: 'contract.renew', params: { ...place, months: 12 } });
  assert.deepEqual([ask.outcome, ask.reason], ['needs_input', 'renew_reason_ask']);
  const first = await env.call('crm_action_run', { action: 'contract.renew', params: { ...place, months: 6, noReason: true } });
  assert.equal(env.requests.at(-1).phase, 'preview', 'irreversible: không bao giờ auto');
  assert.equal(first.outcome, 'confirmation_required'); assert.deepEqual(first.warnings, ['HĐ vừa được gia hạn lúc …']);
  const done = await env.call('crm_action_run', { action: 'contract.renew', params: { ...place, months: 6, noReason: true },
    requestId: first.requestId, confirmToken: first.confirmToken });
  assert.equal(done.outcome, 'applied');
  assert.deepEqual([env.requests.at(-1).phase, env.requests.at(-1).requestId, env.requests.at(-1).resolved, env.requests.at(-1).basis],
    ['apply', first.requestId, { contractId: id('9') }, 'b'.repeat(32)]);
  await assert.rejects(env.broker.callTool(TOKEN, 'crm_action_run', { action: 'contract.renew', params: { ...place, months: 6, newRentPrice: 5000000, noReason: true } }),
    error => error.code === 'action_rejected' && error.reason === 'renew_price_change_web_only');
});

test('kết nối chỉ giữ khoá khoá tạm ⇒ chỉ hai thao tác khoá; báo trả ⇒ action_disabled', async t => {
  const env = setup(t, { action: ['sale_phong.lock_room'], respond: () => ({ kind: 'applied', result: {} }) });
  const listing = await env.call('crm_action_list', {});
  assert.deepEqual(listing.items.map(item => item.action), ['contract.room_lock', 'contract.room_unlock']);
  await assert.rejects(env.broker.callTool(TOKEN, 'crm_action_run', { action: 'contract.notice_set', params: { buildingName: 'A', roomName: '1', date: '2026-10-31' } }),
    error => error.code === 'action_rejected' && error.reason === 'action_disabled');
  assert.deepEqual(env.requests, []);
});

test('tools/list: danh mục Hợp đồng không thêm byte so với danh mục thử (cùng ba tool chung)', async t => {
  const service = { async prepareAction() { return Object.freeze({}); }, async finalizeAction() { return { kind: 'applied', result: {} }; } };
  const bytesOf = tools => Buffer.byteLength(JSON.stringify({ tools }));
  const probe = fullGrantBroker(t, undefined, { actions: createActionRuntime({ catalog: probeCatalog(), service }), actionKeys: [PROBE_KEY] });
  const contract = fullGrantBroker(t, undefined, { actions: createActionRuntime({ catalog: createActionCatalog([...CONTRACT_ACTIONS]), service }), actionKeys: KEYS });
  const a = (await probe.broker.listTools(probe.token)).tools, b = (await contract.broker.listTools(contract.token)).tools;
  assert.deepEqual(b.filter(tool => tool.name.startsWith('crm_action_')).map(tool => tool.name), ['crm_action_list', 'crm_action_run', 'crm_action_status']);
  assert.equal(bytesOf(b.filter(tool => tool.name.startsWith('crm_action_'))), bytesOf(a.filter(tool => tool.name.startsWith('crm_action_'))));
  // Mục lục của trang nằm trong KẾT QUẢ crm_action_list: giữ gọn.
  const listing = createActionCatalog([...CONTRACT_ACTIONS]).listing({ action: KEYS });
  assert.ok(Buffer.byteLength(JSON.stringify(listing)) <= 8_192, 'mục lục trang ≤ 8 KB');
});
