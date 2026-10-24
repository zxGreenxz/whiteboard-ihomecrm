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
import { CONSENT_HINT } from './consent-guard.mjs';
import { CONTRACT_ACTIONS, CONTRACT_DRAFT, CONTRACT_NOTICE_CANCEL, CONTRACT_NOTICE_SET, CONTRACT_OCCUPANT_ADD, CONTRACT_RENEW, CONTRACT_RENEW_BATCH,
  CONTRACT_RETURN, CONTRACT_ROOM_LOCK, CONTRACT_ROOM_UNLOCK }
  from './contract-action-contract.mjs';

// Danh mục thao tác trang HỢP ĐỒNG (HOP-DONG-THAO-TAC-GHI.md mục 3–5) qua khung chung: khuôn tham số, lớp ghi thẳng (Q2 = a,
// D-HĐ1), mã lý do riêng trang tới mô hình đúng dạng (needs_input là kết quả thường, rejected là action_rejected + câu tĩnh),
// và 0 byte tools/list so với danh mục thử.
const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const TOKEN = `hc_${'A'.repeat(43)}`;
const KEYS = ['contracts.terminate', 'sale_phong.lock_room', 'contracts.renew', 'contracts.edit', 'contracts.create'];

function setup(t, { action = KEYS, respond, audits } = {}) {
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
    dependencyScope: scope, audit: async event => { audits?.push(structuredClone(event)); }, actions: runtime });
  const call = async (name, args) => { const result = await broker.callTool(TOKEN, name, args); assert.equal(result.isError, false); return JSON.parse(result.content[0].text); };
  return { broker, requests, call };
}

test('danh mục: bốn thao tác Mốc 2 + gia hạn Mốc 3 + trả phòng Mốc 4 + người ở / nháp Mốc 5 + gia hạn lô Mốc 6, khoá ⊆ hợp đồng khoá Action, một RPC trang, lý do ∈ khối Hợp đồng', () => {
  const catalog = createActionCatalog([...CONTRACT_ACTIONS]);
  assert.deepEqual(catalog.ids, ['contract.notice_set', 'contract.notice_cancel', 'contract.room_lock', 'contract.room_unlock', 'contract.renew',
    'contract.return', 'contract.occupant_add', 'contract.occupant_remove', 'contract.draft', 'contract.renew_batch']);
  assert.deepEqual(catalog.rpcs, ['hermes_contract_action_v1']);
  assert.deepEqual(catalog.keys, [...KEYS].sort());
  assert.ok(catalog.keys.every(key => HERMES_ACTION_CAPABILITIES.includes(key)));
  for (const action of CONTRACT_ACTIONS) {
    // Q2 = a: báo trả / khoá tạm ghi thẳng; gia hạn (lẻ và lô) / trả phòng không lùi được ⇒ luôn xem trước (sàn trong mã).
    assert.equal(action.class, ['contract.renew', 'contract.return', 'contract.renew_batch'].includes(action.id) ? 'irreversible' : 'reversible', action.id);
    assert.ok(action.reasons.every(code => ACTION_PAGE_REASON_BLOCKS.contract.includes(code)), action.id);
    if (action.id === 'contract.renew_batch') continue;
    assert.deepEqual(Object.keys(action.params).slice(0, 2), ['buildingName', 'roomName'], `${action.id}: toà + phòng`);
    assert.ok(!action.params.buildingName.optional && !action.params.roomName.optional, `${action.id}: toà và phòng bắt buộc`);
  }
  // Lô: không có phòng; toà tuỳ chọn (vắng = mọi toà trong phạm vi khoá); cùng khoá contracts.renew với gia hạn lẻ.
  assert.deepEqual(Object.keys(CONTRACT_RENEW_BATCH.params), ['buildingName', 'endMonth', 'months', 'reason', 'noReason']);
  assert.ok(CONTRACT_RENEW_BATCH.params.buildingName.optional && !CONTRACT_RENEW_BATCH.params.endMonth.optional && !CONTRACT_RENEW_BATCH.params.months.optional);
  assert.equal(CONTRACT_RENEW_BATCH.key, CONTRACT_RENEW.key);
  // Danh mục chung (probe + trang) nạp được: không trùng mã, cùng khung.
  assert.equal(createActionCatalog([...probeCatalog().ids.map(idValue => probeCatalog().get(idValue)), ...CONTRACT_ACTIONS]).ids.length, 12);
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
  // Trả phòng: ngày + nội dung thanh lý bắt buộc; forfeit là boolean; không nhận loại trả phòng từ mô hình (máy chủ suy).
  assert.deepEqual(validateActionParams(CONTRACT_RETURN, { buildingName: 'Toà A', roomName: '302', date: '2026-10-20', note: 'Bàn giao đủ' }).value,
    { buildingName: 'Toà A', roomName: '302', date: '2026-10-20', note: 'Bàn giao đủ' });
  for (const bad of [{ note: 'Bàn giao đủ' }, { date: '2026-10-20' }, { date: '2026-10-20', note: 'ok' }, { date: '2026-10-20', note: 'Bàn giao đủ', forfeit: 'có' },
    { date: '2026-10-20', note: 'Bàn giao đủ', kind: 'FORFEIT' }])
    assert.equal(validateActionParams(CONTRACT_RETURN, { buildingName: 'Toà A', roomName: '302', ...bad }).ok, false, JSON.stringify(bad));
  // Người ở: khách theo SĐT (chữ 6–20, SQL chuẩn hoá) hoặc tên; không nhận id khách từ mô hình.
  assert.deepEqual(validateActionParams(CONTRACT_OCCUPANT_ADD, { buildingName: 'Toà A', roomName: '302', customerPhone: '0912.345.678' }).value,
    { buildingName: 'Toà A', roomName: '302', customerPhone: '0912.345.678' });
  for (const bad of [{ customerPhone: '12345' }, { customerId: id('1') }])
    assert.equal(validateActionParams(CONTRACT_OCCUPANT_ADD, { buildingName: 'Toà A', roomName: '302', ...bad }).ok, false, JSON.stringify(bad));
  // Nháp: ngày bắt đầu/kết thúc + giá + cọc bắt buộc (không tự cộng tháng); không nhận months.
  const draft = { buildingName: 'Toà A', roomName: '302', startDate: '2026-11-01', endDate: '2027-10-31', rentPrice: '3200000', deposit: 0 };
  assert.deepEqual(validateActionParams(CONTRACT_DRAFT, draft).value, { ...draft, rentPrice: 3200000 });
  for (const bad of [{ endDate: undefined }, { months: 12 }, { rentPrice: 0 }, { deposit: -1 }])
    assert.equal(validateActionParams(CONTRACT_DRAFT, { ...draft, ...bad }).ok, false, JSON.stringify(bad));
  // Lô: tháng YYYY-MM + months 1–24 bắt buộc; toà tuỳ chọn; không nhận phòng hay danh sách HĐ từ mô hình (máy chủ chọn).
  assert.deepEqual(validateActionParams(CONTRACT_RENEW_BATCH, { endMonth: '2026-11', months: '6', noReason: true }).value,
    { endMonth: '2026-11', months: 6, noReason: true });
  assert.deepEqual(validateActionParams(CONTRACT_RENEW_BATCH, { buildingName: 'Toà A', endMonth: '2026-11', months: 12, reason: 'Khách xin ở tiếp' }).value,
    { buildingName: 'Toà A', endMonth: '2026-11', months: 12, reason: 'Khách xin ở tiếp' });
  for (const bad of [{ endMonth: '2026-11-30', months: 6 }, { endMonth: '11/2026', months: 6 }, { endMonth: '2026-11' }, { endMonth: '2026-11', months: 25 },
    { endMonth: '2026-11', months: 0 }, { endMonth: '2026-11', months: 6, roomName: '302' }, { endMonth: '2026-11', months: 6, contractIds: [id('1')] },
    { endMonth: '2026-11', months: 6, reason: 'ngắn' }])
    assert.equal(validateActionParams(CONTRACT_RENEW_BATCH, bad).ok, false, JSON.stringify(bad));
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
    requestId: first.requestId, confirmToken: first.confirmToken, consentText: 'Ok em, gia hạn đi' });
  assert.equal(done.outcome, 'applied');
  assert.deepEqual([env.requests.at(-1).phase, env.requests.at(-1).requestId, env.requests.at(-1).resolved, env.requests.at(-1).basis],
    ['apply', first.requestId, { contractId: id('9') }, 'b'.repeat(32)]);
  await assert.rejects(env.broker.callTool(TOKEN, 'crm_action_run', { action: 'contract.renew', params: { ...place, months: 6, newRentPrice: 5000000, noReason: true } }),
    error => error.code === 'action_rejected' && error.reason === 'renew_price_change_web_only');
});

test('trả phòng: lượt 1 luôn xem trước; đồng ý ⇒ apply đúng resolved + basis; return_date_future là kết quả thường', async t => {
  const env = setup(t, { respond: request => request.params.date === '2026-10-30' ? { kind: 'needs_input', reason: 'return_date_future' }
    : request.phase === 'preview' ? { kind: 'preview', preview: { text: 'Sẽ ghi nhận khách TRẢ PHÒNG … KHÔNG lùi được …' }, basis: 'c'.repeat(32),
      resolved: { contractId: id('8') }, confirm: 'required', warnings: [] }
    : request.phase === 'apply' ? { kind: 'applied', result: { text: 'Đã ghi nhận khách trả phòng …', nextStep: 'Quyết toán trên web: /contracts/x' }, link: '/contracts/x' }
    : { kind: 'rejected', reason: 'crm_refused' } });
  const params = { buildingName: 'Toà A', roomName: '302', date: '2026-10-20', note: 'Bàn giao đủ' };
  const future = await env.call('crm_action_run', { action: 'contract.return', params: { ...params, date: '2026-10-30' } });
  assert.deepEqual([future.outcome, future.reason, future.detail], ['needs_input', 'return_date_future', ACTION_REASONS.return_date_future.text]);
  const first = await env.call('crm_action_run', { action: 'contract.return', params });
  assert.equal(env.requests.at(-1).phase, 'preview', 'irreversible: không bao giờ auto'); assert.equal(first.outcome, 'confirmation_required');
  const done = await env.call('crm_action_run', { action: 'contract.return', params, requestId: first.requestId, confirmToken: first.confirmToken, consentText: 'đồng ý' });
  assert.deepEqual([done.outcome, done.result.nextStep], ['applied', 'Quyết toán trên web: /contracts/x']);
  assert.deepEqual([env.requests.at(-1).phase, env.requests.at(-1).resolved, env.requests.at(-1).basis], ['apply', { contractId: id('8') }, 'c'.repeat(32)]);
});

test('gia hạn lô: lượt 1 luôn xem trước dạng bảng (một lần đồng ý); đồng ý ⇒ apply đúng resolved + basis; lô rỗng là kết quả thường', async t => {
  const rows = Array.from({ length: 20 }, (_, n) => ({ buildingName: 'Toà A', roomName: `P${100 + n}`, contractNumber: `HĐ-${n}`,
    endDate: { from: '2026-11-30', to: '2027-05-31' } }));
  const env = setup(t, { respond: request => request.params.endMonth === '2026-12' ? { kind: 'needs_input', reason: 'renew_batch_empty' }
    : request.phase === 'preview' ? { kind: 'preview', preview: { text: 'Sẽ gia hạn 20 HĐ hết hạn tháng 11/2026 …', months: 6, count: 20, more: 2, rows },
      basis: 'd'.repeat(32), resolved: { buildingId: id('f'), buildingName: 'Toà A', count: 20 }, confirm: 'required',
      warnings: ['Không gia hạn 1 HĐ đang có báo trả …', 'Còn 2 HĐ hết hạn tháng 11/2026 chưa vào lô này …'] }
    : request.phase === 'apply' ? { kind: 'applied', result: { text: 'Đã gia hạn 19/20 HĐ …', renewed: 19, failed: 1,
      rows: rows.map((row, n) => ({ ...row, renewed: n > 0, ...(n === 0 ? { reason: 'crm_refused' } : {}) })) }, link: '/contracts' }
    : { kind: 'rejected', reason: 'crm_refused' } });
  const params = { buildingName: 'Toà A', endMonth: '2026-11', months: 6, noReason: true };
  const empty = await env.call('crm_action_run', { action: 'contract.renew_batch', params: { ...params, endMonth: '2026-12' } });
  assert.deepEqual([empty.outcome, empty.reason, empty.detail], ['needs_input', 'renew_batch_empty', ACTION_REASONS.renew_batch_empty.text]);
  const first = await env.call('crm_action_run', { action: 'contract.renew_batch', params });
  assert.equal(env.requests.at(-1).phase, 'preview', 'irreversible: không bao giờ auto');
  assert.deepEqual([first.outcome, first.preview.rows.length, first.preview.more, first.warnings.length], ['confirmation_required', 20, 2, 2]);
  const done = await env.call('crm_action_run', { action: 'contract.renew_batch', params, requestId: first.requestId, confirmToken: first.confirmToken, consentText: 'chốt' });
  assert.deepEqual([done.outcome, done.result.renewed, done.result.failed, done.result.rows[0].reason], ['applied', 19, 1, 'crm_refused']);
  assert.deepEqual([env.requests.at(-1).phase, env.requests.at(-1).resolved, env.requests.at(-1).basis],
    ['apply', { buildingId: id('f'), buildingName: 'Toà A', count: 20 }, 'd'.repeat(32)]);
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

// Lượt 12 (rào đồng ý, consent-guard.mjs; nghiệm thu 24/10 — ghi sai thật lần 3): bot gọi lại contract.return kèm confirmToken khi người dùng
// CHỈ bổ sung chi tiết. Lượt xác nhận của thao tác không lùi được nay phải kèm consentText = nguyên văn câu người dùng; không phải lời đồng ý rõ
// ⇒ needs_input consent_unclear, chưa gửi lệnh ghi, token chưa tiêu. Đột biến bỏ kiểm (hoặc kiểm SAU khi đổi token) ⇒ các khẳng định dưới đỏ.
test('rào đồng ý: trả phòng chỉ ghi khi consentText là lời đồng ý rõ; chỉ chi tiết / "ok nhưng khoan đã" / vắng ⇒ consent_unclear, token còn dùng', async t => {
  const audits = [];
  const env = setup(t, { audits, respond: request => request.phase === 'preview' ? { kind: 'preview', preview: { text: 'Sẽ ghi nhận khách TRẢ PHÒNG … KHÔNG lùi được …' },
    basis: 'c'.repeat(32), resolved: { contractId: id('8') }, confirm: 'required', warnings: [] }
    : request.phase === 'apply' ? { kind: 'applied', result: { text: 'Đã ghi nhận khách trả phòng …' }, link: '/contracts/x' } : { kind: 'rejected', reason: 'crm_refused' } });
  const params = { buildingName: '950', roomName: 'LONDON 4', date: '2026-10-12', note: 'Trả sớm, quyết toán sau' };
  const first = await env.call('crm_action_run', { action: 'contract.return', params });
  assert.equal(first.outcome, 'confirmation_required');
  assert.match(first.huongDan, /phải kèm consentText = NGUYÊN VĂN câu người dùng vừa đáp/);
  const confirm = { action: 'contract.return', params, requestId: first.requestId, confirmToken: first.confirmToken };
  const sent = env.requests.length;
  for (const consentText of [undefined, null, '', 'Trả sớm, quyết toán sau, khách đã trả chìa rồi', 'ok nhưng khoan đã', 'khách đồng ý trả sớm', 'ok?',
    'Người dùng đồng ý', 'ok '.repeat(101)]) {
    const unclear = await env.call('crm_action_run', { ...confirm, ...(consentText === undefined ? {} : { consentText }) });
    assert.deepEqual([unclear.outcome, unclear.applied, unclear.reason, unclear.detail], ['needs_input', false, 'consent_unclear', ACTION_REASONS.consent_unclear.text],
      String(consentText));
    assert.match(unclear.huongDan, /token xác nhận chưa dùng, còn hạn thì dùng lại được/);
  }
  assert.equal(env.requests.length, sent, 'chưa gửi lệnh ghi nào xuống SQL');
  assert.ok(audits.every(event => !Object.hasOwn(event, 'consent')), 'câu chưa qua rào không vào sổ audit');
  // Token chưa bị tiêu: người dùng đáp "ok" ⇒ cùng token ghi được; consentText không xuống SQL, vào dòng prepared của sổ audit.
  const done = await env.call('crm_action_run', { ...confirm, consentText: 'Ok em,\nghi đi' });
  assert.equal(done.outcome, 'applied');
  assert.deepEqual(Object.keys(env.requests.at(-1)).sort(), ['action', 'basis', 'op', 'params', 'phase', 'requestId', 'resolved']);
  assert.equal(env.requests.at(-1).phase, 'apply');
  assert.deepEqual(audits.filter(event => Object.hasOwn(event, 'consent')).map(event => [event.outcome, event.consent]),
    [['prepared', { action: 'contract.return', requestId: first.requestId, text: 'Ok em, ghi đi' }]]);
  await assert.rejects(env.broker.callTool(TOKEN, 'crm_action_run', { ...confirm, consentText: 'ok' }), error => error.code === 'confirmation_invalid', 'token dùng một lần');
  await assert.rejects(env.broker.callTool(TOKEN, 'crm_action_run', { ...confirm, consentText: 42 }), error => error.code === 'invalid_request', 'consentText phải là chuỗi');
});

test('rào đồng ý chỉ áp thao tác không lùi được: thao tác thường xác nhận không cần consentText; mục lục nói rõ thao tác nào cần', async t => {
  const listing = createActionCatalog([...CONTRACT_ACTIONS]).listing({ action: KEYS });
  assert.deepEqual(listing.filter(item => Object.hasOwn(item, 'consentText')).map(item => item.action), ['contract.renew', 'contract.return', 'contract.renew_batch']);
  assert.ok(listing.filter(item => Object.hasOwn(item, 'consentText')).every(item => item.consentText === CONSENT_HINT && item.confirm === 'always'));
  // contract.notice_set (reversible) mà SQL đòi xác nhận ở lượt auto: lượt xác nhận không kèm consentText vẫn ghi.
  const env = setup(t, { respond: request => request.phase === 'auto' ? { kind: 'preview', preview: { text: 'Sẽ báo trả …' }, basis: 'e'.repeat(32),
    resolved: { contractId: id('7') }, confirm: 'required', warnings: [] } : { kind: 'applied', result: { text: 'Đã báo trả' }, link: '/contracts/y' } });
  const params = { buildingName: 'Toà A', roomName: '302', date: '2026-11-30' };
  const first = await env.call('crm_action_run', { action: 'contract.notice_set', params });
  assert.equal(first.outcome, 'confirmation_required');
  assert.doesNotMatch(first.huongDan, /consentText/);
  const done = await env.call('crm_action_run', { action: 'contract.notice_set', params, requestId: first.requestId, confirmToken: first.confirmToken });
  assert.deepEqual([done.outcome, env.requests.at(-1).phase], ['applied', 'apply']);
});
