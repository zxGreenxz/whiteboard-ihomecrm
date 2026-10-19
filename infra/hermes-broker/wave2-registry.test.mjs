import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBroker } from './broker.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
import { advertisedTool } from './tool-argument-shape.mjs';
import { DOMAIN_TOOLS, DOMAIN_READS, domainInput, domainResult, mayUseDomain } from './domain-contract.mjs';
import { HERMES_READ_CAPABILITIES, HERMES_ACTION_CAPABILITIES, HERMES_CAPABILITIES, requiresBuildingScope } from './capability-contract.mjs';
import { W2, W2_READ_KEYS, W2_READ_KEY_LIST, W2_SELF_KEYS, W2_TOOL_NAMES, createW2Registry } from './wave2-registry.mjs';
import { W2_TOPICS, PRIVATE_HINT, w2Report, w2Params, w2CatalogEntry, id, nullable, longText, amount } from './wave2-kit.mjs';
import { W2A_REPORTS } from './wave2-a-contract.mjs';
import { W2B_REPORTS } from './wave2-b-contract.mjs';
import { W2C_REPORTS } from './wave2-c-contract.mjs';
import { W2D_REPORTS } from './wave2-d-contract.mjs';

// Gói 0 — mặt tool đợt 2 ở broker (không PGlite): sổ báo cáo, hai tool meta, rào quyền theo báo cáo,
// chuẩn hoá tham số, rào đầu ra theo phạm vi CRM, ngân sách byte tools/list.
const uuid = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const ORG = uuid('d'), A = uuid('a'), B = uuid('b'), C = uuid('c');
const fields = { buildingId: nullable(id), name: nullable(longText(100)), total: amount };
const PROBE = createW2Registry({
  a: { probe_rows: w2Report({ permission: 'vehicles.view', source: 'crm.probe_rows', scope: 'rows', title: 'Thăm dò hàng có toà',
    params: ['query', 'buildingId', 'fromDate', 'toDate', 'status'], statuses: ['open', 'closed'], scopeKeys: ['customers.view'], fields,
    summary: { total: amount }, private: true }) },
  b: { probe_org: w2Report({ permission: 'materials.view', source: 'crm.probe_org', scope: 'organization', title: 'Thăm dò toàn công ty',
    params: ['query'], fields }) },
  c: { probe_self: w2Report({ permission: 'assistant.salary.self', source: 'crm.probe_self', scope: 'self', title: 'Thăm dò của tôi',
    params: ['month'], required: ['month'], fields: { month: longText(7), total: amount } }) },
  d: { probe_invoice: w2Report({ permission: 'invoices.view', source: 'crm.probe_invoice', scope: 'rows', title: 'Thăm dò khoá đợt 1',
    params: ['invoiceId'], required: ['invoiceId'], fields }) },
});
const identity = (read, buildings = [A, B]) => ({ row: { organizationId: ORG }, effective: { read, action: [] },
  scopesByPermission: Object.fromEntries(read.map(key => [key, { buildingIds: buildings, cashbookIds: [] }])) });
const FENCE_A = Object.freeze({ buildings: [A], cashbooks: [], orgWide: false }), NO_FENCE = Object.freeze({ buildings: [], cashbooks: [], orgWide: false });
const envelope = (report, items, extra = {}) => ({ organizationId: ORG, domain: 'report', fetchedAt: '2026-10-18T00:00:00.000Z', report,
  source: PROBE.reports[report].source, unavailable: null, summary: null, items, offset: 0, nextOffset: null, sourceCapped: false,
  fence: ['rows', 'buildings'].includes(PROBE.reports[report].scope) ? FENCE_A : NO_FENCE, ...extra });

test('khai báo: w2Report từ chối khai báo sai (tham số lạ, bắt buộc ngoài params, status thiếu danh sách, nguồn sai dạng, tham số gắn toà ngoài rows/buildings, khoá ↔ scope)', () => {
  const ok = { permission: 'vehicles.view', source: 'crm.vehicles', scope: 'rows', title: 'Xe', params: ['query'], fields };
  assert.ok(Object.isFrozen(w2Report(ok)));
  for (const bad of [{ params: ['foo'] }, { required: ['month'] }, { params: ['status'] }, { params: ['kind'], kinds: [] }, { statuses: ['x'] },
    { source: 'crm.Vehicles' }, { source: 'vehicles' }, { scope: 'global' }, { scope: 'organization', params: ['buildingId'] },
    { scope: 'self', params: ['buildingId'] }, { title: '' }, { title: 'x'.repeat(301) }, { permission: 'Vehicles' }, { fields: { a: 1 } },
    { summary: [] }, { private: 'yes' }, { extra: 1 }, { params: ['query', 'query'] },
    // P2-1 (review PR #195): khoá ↔ scope, khoá ngoài danh sách, tham số gắn toà chỉ ở rows/buildings.
    { scope: 'self' }, { permission: 'assistant.salary.self' }, { permission: 'assistant.bank_events.read', scope: 'organization' },
    { scope: 'platform' }, { permission: 'users.view' }, { permission: 'customers.create' }, { permission: 'contracts.view' },
    { scope: 'organization', params: ['roomId'] }, { scope: 'cashbooks', params: ['invoiceId'] }, { scope: 'organization', params: ['areaId'] },
    // P2-b (review cổng INVOKER): khoá organization_scope chỉ scope organization/cashbooks.
    { permission: 'salary.view' }, { permission: 'materials.view', scope: 'buildings' }, { permission: 'cashbooks.view', scope: 'rows' },
    // P2-a: theo toà phải khai buildingId; organizationId là trường rào (cổng gỡ), chỉ platform được khai.
    { fields: { name: nullable(longText(100)), total: amount } }, { fields: { ...fields, organizationId: id } },
    { permission: 'materials.view', scope: 'organization', fields: { organizationId: id, total: amount } }])
    assert.throws(() => w2Report({ ...ok, ...bad }), JSON.stringify(bad));
  for (const good of [{ permission: 'notifications.view', scope: 'self' }, { permission: 'assistant.bank_events.read', scope: 'platform' },
    { permission: 'assistant.bank_events.read', scope: 'platform', fields: { organizationId: nullable(id), total: amount } },
    { permission: 'materials.view', scope: 'organization', fields: { name: nullable(longText(100)), total: amount } },
    { permission: 'cashbooks.view', scope: 'cashbooks', params: ['cashbookId'] }, { permission: 'invoices.view', params: ['invoiceId', 'roomId'] },
    { permission: 'salary.view', scope: 'organization', params: ['staffId', 'month'] }, { permission: 'rooms.view', scope: 'buildings', params: ['areaId'] }])
    assert.ok(w2Report({ ...ok, ...good }), JSON.stringify(good));
});

test('sổ báo cáo: bốn gói đúng chữ cái, mã duy nhất xuyên gói, chỉ nhận khai báo của w2Report', () => {
  const spec = PROBE.reports.probe_rows, plain = Object.freeze(Object.fromEntries(Object.entries(spec).filter(([key]) => key !== 'package')));
  const empty = { a: {}, b: {}, c: {}, d: {} };
  assert.deepEqual(createW2Registry(empty).permissions, []);
  for (const bad of [{ ...empty, a: { dup: plain }, b: { dup: plain } }, { ...empty, a: { Bad: plain } }, { ...empty, a: { x: { ...plain } } },
    { a: {}, b: {}, c: {} }, { ...empty, e: {} }, { ...empty, a: { x: Object.freeze({ ...plain, extra: 1 }) } }])
    assert.throws(() => createW2Registry(bad), JSON.stringify(Object.keys(bad)));
  assert.deepEqual(PROBE.permissions, ['assistant.salary.self', 'invoices.view', 'materials.view', 'vehicles.view']);
  assert.deepEqual(PROBE.sqlSpec('probe_rows'), { permission: 'vehicles.view', source: 'crm.probe_rows', scope: 'rows',
    params: ['query', 'buildingId', 'fromDate', 'toDate', 'status'], required: [], statuses: ['open', 'closed'], kinds: null, scopeKeys: ['customers.view'], package: 'a' });
  // Sổ thật (Gói 0): bốn file gói còn rỗng — mã của gói nào nằm ở file gói đó.
  for (const [letter, reports] of Object.entries({ a: W2A_REPORTS, b: W2B_REPORTS, c: W2C_REPORTS, d: W2D_REPORTS }))
    for (const reportId of Object.keys(reports)) assert.equal(W2.reports[reportId].package, letter);
});

test('khoá đợt 2: 35 khoá đọc trong capability contract (không trùng khoá cũ), resource đúng, self không cần phạm vi', () => {
  assert.equal(W2_READ_KEY_LIST.length, 35);
  for (const key of W2_READ_KEY_LIST) {
    assert.ok(HERMES_READ_CAPABILITIES.includes(key), key);
    assert.deepEqual(HERMES_CAPABILITIES[key], { mode: 'read', resource: W2_READ_KEYS[key] }, key);
    assert.equal(HERMES_ACTION_CAPABILITIES.includes(key), false);
  }
  assert.deepEqual([...W2_SELF_KEYS].sort(), ['assistant.bank_events.read', 'assistant.salary.self', 'notifications.view', 'personal_finance.view']);
  assert.equal(requiresBuildingScope(W2_SELF_KEYS), false, 'kết nối chỉ khoá self: không bắt chọn phạm vi');
  assert.equal(requiresBuildingScope(['vehicles.view']), true); assert.equal(requiresBuildingScope(['salary.view']), true);
  for (const key of ['shareholder_profit.view', 'personal_finance.view', 'assistant.bank_events.read', 'salary.view', 'assistant.salary.self',
    'reports_finance.profit_distribution', 'cashbooks.view', 'network_center.view', 'reports_real_estate.vacant_rooms', 'reports_real_estate.expense_ratio'])
    assert.ok(W2_READ_KEY_LIST.includes(key), `chủ chốt 17/10: ${key}`);
  for (const key of ['shareholder_profit.lock', 'reports_finance.reconcile', 'network_center.execute', 'salary.lock', 'personal_finance.create'])
    assert.equal(Object.hasOwn(HERMES_CAPABILITIES, key), false, `không mở khoá ghi/quản trị: ${key}`);
});

test('mặt tool: đúng hai tool meta, gọn (≤ 1 600 B), không nhắc bảng/RPC/copilot; chưa có báo cáo nào ⇒ không hiện dù đủ khoá', () => {
  const meta = DOMAIN_TOOLS.filter(tool => W2_TOOL_NAMES.includes(tool.name));
  assert.deepEqual(meta.map(tool => tool.name), W2_TOOL_NAMES);
  const bytes = Buffer.byteLength(JSON.stringify(meta.map(advertisedTool)));
  assert.ok(bytes <= 1600, `hai tool meta ${bytes} B`);
  for (const tool of meta) {
    assert.doesNotMatch(tool.description, /copilot|hermes_|SELECT|app_private/i, tool.name);
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  assert.ok(meta[1].description.includes(PRIVATE_HINT) && meta[1].description.includes('no_building_scope') && meta[1].description.includes('nextOffset'));
  assert.deepEqual(meta[0].inputSchema.properties.topic.enum, [null, ...Object.keys(W2_TOPICS)]);
  assert.deepEqual(meta[1].inputSchema.required, ['report']);
  const all = { read: [...HERMES_READ_CAPABILITIES], action: [] };
  assert.equal(W2.permissions.length === 0, !mayUseDomain(all, 'report_list'), 'hiện ⇔ có ít nhất một báo cáo đã đăng ký');
  // Lối vào INVOKER riêng (20261018000600): hàm gói chạy dưới RLS của người hỏi.
  assert.equal(DOMAIN_READS.report.family, 'w2'); assert.equal(DOMAIN_READS.report_list.family, 'w2');
});

test('quyền theo báo cáo: tool hiện khi giữ khoá của MỘT báo cáo; chạy đòi đúng khoá của báo cáo được gọi', () => {
  const { report_list: list, report } = PROBE.reads;
  assert.equal(list.mayUse({ read: [] }), false); assert.equal(list.mayUse(undefined), false);
  assert.equal(list.mayUse({ read: ['rooms.view', 'customers.view'] }), false, 'khoá không thuộc báo cáo nào');
  assert.equal(list.mayUse({ read: ['vehicles.view'] }), true);
  assert.equal(report.mayUse({ read: ['invoices.view'] }), true, 'khoá đợt 1 dùng lại được');
  const run = report.input({ report: 'probe_org' });
  assert.equal(report.mayUse({ read: ['vehicles.view'] }, run), false, 'khoá của báo cáo khác');
  assert.equal(report.mayUse({ read: ['materials.view'] }, run), true);
});

test('đầu vào: topic theo tên nhóm; params chuẩn hoá đủ tên (trống/UUID 0 = null), sai kiểu ⇒ từ chối trước SQL', () => {
  const { report_list: list, report } = PROBE.reads;
  assert.deepEqual(list.input({}), { topic: null }); assert.deepEqual(list.input({ topic: null }), { topic: null });
  assert.deepEqual(list.input({ topic: 'thu_tien' }), { topic: 'a' }); assert.deepEqual(list.input({ topic: 'danh_muc' }), { topic: 'd' });
  for (const bad of [{ topic: 'x' }, { topic: 'e' }, { topic: 'toString' }, { topic: 1 }, { other: 1 }, null, []]) assert.throws(() => list.input(bad), JSON.stringify(bad));
  // Broker, dịch vụ bound-user và adapter đều kiểm lại bản đã chuẩn hoá: phải bất biến.
  for (const value of [{}, { topic: 'thu_tien' }, { topic: 'van_hanh' }]) assert.deepEqual(list.input(list.input(value)), list.input(value), JSON.stringify(value));
  for (const value of [{ report: 'probe_rows', params: { query: '  xe ', buildingId: '00000000-0000-0000-0000-000000000000' } }, { report: 'probe_self', params: { month: '2026-09' }, limit: 3 }])
    assert.deepEqual(report.input(report.input(value)), report.input(value), JSON.stringify(value));
  assert.deepEqual(domainInput('report_list', domainInput('report_list', { topic: 'tai_chinh' })), { topic: 'b' }, 'sổ thật cũng bất biến');
  assert.deepEqual(report.input({ report: 'probe_rows' }), { report: 'probe_rows', params: { query: null, buildingId: null, fromDate: null, toDate: null, status: null }, limit: 20, offset: 0 });
  assert.deepEqual(report.input({ report: 'probe_rows', params: { query: '  xe  ', buildingId: '00000000-0000-0000-0000-000000000000', status: 'open' }, limit: 5, offset: 10 }),
    { report: 'probe_rows', params: { query: 'xe', buildingId: null, fromDate: null, toDate: null, status: 'open' }, limit: 5, offset: 10 });
  assert.deepEqual(report.input({ report: 'probe_self', params: { month: '2026-09' } }).params, { month: '2026-09' });
  for (const bad of [{ report: 'nope' }, { report: 'probe_rows', params: { foo: 1 } }, { report: 'probe_rows', params: { status: 'OPEN' } },
    { report: 'probe_rows', limit: 0 }, { report: 'probe_rows', limit: 51 }, { report: 'probe_rows', offset: 2001 }, { report: 'probe_rows', organizationId: ORG },
    { report: 'probe_self' }, { report: 'probe_self', params: { month: '2026-13' } }, { report: 'probe_invoice', params: { invoiceId: 'HD-1' } },
    { report: 'probe_rows', params: { fromDate: '2026-01-01', toDate: '2027-01-03' } }, { report: 'probe_rows', params: [] }])
    assert.throws(() => report.input(bad), JSON.stringify(bad));
  assert.throws(() => w2Params(PROBE.reports.probe_org, { buildingId: A }), 'organization không có buildingId');
});

test('mục lục: chiếu từ khai báo, chỉ báo cáo SQL vừa xác nhận và broker cũng thấy khoá; mã lạ bỏ qua, lệch khoá/nhóm ⇒ từ chối', () => {
  const { report_list: list } = PROBE.reads, input = list.input({});
  const sql = items => ({ organizationId: ORG, domain: 'report_list', fetchedAt: '2026-10-18T00:00:00.000Z', items });
  const value = list.result(sql([{ report: 'future_report', permission: 'x.view' }, { report: 'probe_org', permission: 'materials.view' },
    { report: 'probe_rows', permission: 'vehicles.view' }]), identity(['vehicles.view', 'materials.view']), input);
  assert.deepEqual(value.items, [w2CatalogEntry('probe_org', PROBE.reports.probe_org, 'b'), w2CatalogEntry('probe_rows', PROBE.reports.probe_rows, 'a')]);
  assert.deepEqual(value.items[1], { report: 'probe_rows', topic: 'thu_tien', title: 'Thăm dò hàng có toà', private: true,
    params: { query: 'chữ tìm ≤200 ký tự', buildingId: 'ID toà (không phải ID công ty)', fromDate: 'YYYY-MM-DD', toDate: 'YYYY-MM-DD', status: 'open|closed' } });
  assert.equal(list.result(sql([{ report: 'probe_self', permission: 'assistant.salary.self' }]), identity(['assistant.salary.self']), input).items[0].params.month,
    'YYYY-MM, bắt buộc');
  for (const [items, who, topic] of [[[{ report: 'probe_rows', permission: 'materials.view' }], ['vehicles.view', 'materials.view'], {}],
    [[{ report: 'probe_rows', permission: 'vehicles.view' }], ['materials.view'], {}],
    [[{ report: 'probe_rows', permission: 'vehicles.view' }, { report: 'probe_org', permission: 'materials.view' }], ['vehicles.view', 'materials.view'], {}],
    [[{ report: 'probe_org', permission: 'materials.view' }], ['materials.view'], { topic: 'thu_tien' }],
    [[{ report: 'probe_rows', permission: 'vehicles.view', extra: 1 }], ['vehicles.view'], {}]])
    assert.throws(() => list.result(sql(items), identity(who), list.input(topic)), JSON.stringify(items).slice(0, 60));
});

test('kết quả: rào khoá, nguồn, khuôn hàng, fence (⊆ CRM, toà của hàng ∈ fence, null chỉ khi org_wide, buildingIds), toà được hỏi; fence không ra mô hình', () => {
  const { report } = PROBE.reads, input = report.input({ report: 'probe_rows' }), sum = { summary: { total: '1' } };
  const row = { buildingId: A, name: 'Toà A', total: '1' }, who = identity(['vehicles.view']);
  const ok = report.result(envelope('probe_rows', [row], sum), who, input);
  assert.deepEqual([ok.items, Object.hasOwn(ok, 'fence')], [[row], false]);
  assert.deepEqual(report.outputKeys, ['organizationId', 'domain', 'fetchedAt', 'report', 'source', 'unavailable', 'summary', 'items', 'offset', 'nextOffset', 'sourceCapped']);
  assert.ok(report.resultKeys.includes('fence'), 'SQL phải gửi fence');
  const wide = { buildings: [A, B], cashbooks: [], orgWide: true };
  assert.equal(report.result(envelope('probe_rows', [{ ...row, buildingId: null }], { ...sum, fence: wide }), who, input).items[0].buildingId, null, 'null khi org_wide');
  assert.equal(report.result(envelope('probe_rows', [{ ...row, buildingId: B }], { ...sum, fence: wide }), who, input).items.length, 1);
  for (const bad of [envelope('probe_rows', [{ ...row, buildingId: C }], sum), envelope('probe_rows', [{ ...row, buildingId: B }], sum),
    envelope('probe_rows', [{ ...row, buildingId: null }], sum), envelope('probe_rows', [{ ...row, phone: '0900' }], sum),
    envelope('probe_rows', [row], { summary: null }), envelope('probe_rows', [row], { ...sum, source: 'crm.other_source' }),
    envelope('probe_rows', [row], { ...sum, nextOffset: 5 }), envelope('probe_rows', [row], { ...sum, report: 'probe_org' }),
    envelope('probe_rows', [row], { ...sum, fence: { buildings: [A, C], cashbooks: [], orgWide: false } }),
    envelope('probe_rows', [row], { ...sum, fence: { buildings: [A] } }), envelope('probe_rows', [row], { ...sum, fence: undefined }),
    envelope('probe_rows', [row], { ...sum, fence: { buildings: [A], cashbooks: [A], orgWide: false } })])
    assert.throws(() => report.result(bad, who, input), JSON.stringify(bad).slice(0, 90));
  assert.throws(() => report.result(envelope('probe_rows', [row], sum), identity(['materials.view']), input), 'mất khoá giữa chừng');
  assert.throws(() => report.result(envelope('probe_rows', [row], sum), identity(['vehicles.view'], [B]), input), 'fence ngoài phạm vi CRM');
  const onlyB = report.input({ report: 'probe_rows', params: { buildingId: B } });
  assert.throws(() => report.result(envelope('probe_rows', [row], sum), who, onlyB), 'hỏi toà B, fence/hàng toà A');
  assert.throws(() => report.result(envelope('probe_rows', [], { ...sum, fence: { buildings: [B], cashbooks: [], orgWide: true } }), who, onlyB), 'hỏi một toà mà fence org_wide');
  // Mảng buildingIds và báo cáo không theo toà.
  const multi = createW2Registry({ a: { probe_multi: w2Report({ permission: 'services.view', source: 'crm.probe_multi', scope: 'rows', title: 'Dịch vụ',
    fields: { buildingId: nullable(id), buildingIds: () => true, total: amount } }) }, b: {}, c: {}, d: {} }).reads.report, multiInput = multi.input({ report: 'probe_multi' });
  const multiEnv = (items, fence = FENCE_A) => ({ ...envelope('probe_rows', items), report: 'probe_multi', source: 'crm.probe_multi', fence });
  assert.equal(multi.result(multiEnv([{ buildingId: A, buildingIds: [A], total: '1' }]), identity(['services.view']), multiInput).items.length, 1);
  for (const buildingIds of [[A, B], [null], A])
    assert.throws(() => multi.result(multiEnv([{ buildingId: A, buildingIds, total: '1' }]), identity(['services.view']), multiInput), JSON.stringify(buildingIds));
  // P2-a: hàng theo toà thiếu buildingId (w2Report bắt khai nên khuôn hàng từ chối); organizationId (trường
  // rào SQL đã gỡ) lọt tới broker ⇒ từ chối.
  assert.throws(() => report.result(envelope('probe_rows', [{ name: 'Toà A', total: '1' }], sum), who, input), 'theo toà mà hàng không nêu toà');
  assert.throws(() => report.result(envelope('probe_rows', [{ ...row, organizationId: ORG }], sum), who, input), 'organizationId không được tới mô hình');
  const org = report.input({ report: 'probe_org' });
  assert.throws(() => report.result(envelope('probe_org', [{ buildingId: A, name: null, total: '1' }]), identity(['materials.view']), org), 'organization không nêu toà');
  assert.throws(() => report.result(envelope('probe_org', [], { fence: FENCE_A }), identity(['materials.view']), org), 'organization không có toà trong fence');
  for (const reason of ['not_implemented', 'source_unavailable', 'no_building_scope', 'organization_scope_required'])
    assert.equal(report.result(envelope('probe_rows', [], { unavailable: reason }), who, input).unavailable, reason);
  const self = report.input({ report: 'probe_self', params: { month: '2026-09' } });
  assert.throws(() => report.result(envelope('probe_self', [], { unavailable: 'no_building_scope' }), identity(['assistant.salary.self']), self), 'self không "hết toà"');
  for (const bad of [{ unavailable: 'copilot_feature_disabled' }, { unavailable: 'not_implemented', items: [row] }, { unavailable: 'not_implemented', summary: { total: '1' } }])
    assert.throws(() => report.result(envelope('probe_rows', bad.items ?? [], bad), who, input), JSON.stringify(bad));
});

function brokerFor(t, read) {
  const scope = createDependencyScope(); t.after(() => scope.close());
  const CONNECTION = uuid('1'), seen = [];
  const who = { row: { id: CONNECTION, assistantId: uuid('2'), userId: uuid('3'), organizationId: ORG, expiresAt: Date.now() + 600_000, epoch: 1, state: 'active',
    restrictions: { read, action: [] } }, effective: { read, action: [] }, isSuperadmin: false, policyEpoch: 'a'.repeat(64), contextVersion: 'b'.repeat(64),
  assistantScopeIds: [uuid('4')], scopesByPermission: Object.fromEntries(read.map(key => [key, { buildingIds: [A], cashbookIds: [] }])) };
  const broker = createBroker({ authority: { identifyConnection: async () => ({ connectionId: CONNECTION }), resolve: async () => who, checkUnchanged: async () => {} },
    dependencyScope: scope, audit: async () => {}, limits: { maxResultBytes: 65_536 },
    domains: { async prepareDomain(_token, operation, input) { seen.push([operation, input]); return Object.freeze({}); }, async finalizeDomain() { return {}; } } });
  return { broker, seen, token: `hc_${'A'.repeat(43)}` };
}

// Dây broker thật với sổ có báo cáo: tiến trình con nạp sổ thăm dò hai báo cáo khác khoá qua hook
// node:module (wave2-probe-*.fixture.mjs) — mã sản phẩm không có đường tiêm. Đo luôn tools/list đủ quyền
// khi hai tool meta đã hiện (ngân sách 64 000 B cho connector một trần chung).
test('broker có báo cáo (tiến trình con): forbidden khi khoá của báo cáo khác, được phép tới prepare, tools/list đủ quyền ≤ 64 000 B', () => {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('./wave2-probe-broker.fixture.mjs', import.meta.url))], { encoding: 'utf8', timeout: 90_000 });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim().split('\n').at(-1));
  // Sổ gói B/C/D thật vẫn nạp; hook chỉ thay sổ gói A.
  assert.deepEqual(result.reports.filter(reportId => !['b', 'c', 'd'].includes(W2.reports[reportId]?.package)), ['probe_rows', 'probe_org'],
    'hook đã thay sổ gói A');
  for (const name of W2_TOOL_NAMES) assert.ok(result.fullNames.includes(name), name);
  assert.ok(result.fullBytes <= 64_000, `tools/list đủ quyền ${result.fullBytes} B (${result.fullCount} tool)`);
  assert.deepEqual(result.otherList.filter(name => W2_TOOL_NAMES.includes(name)), W2_TOOL_NAMES, 'tool hiện nhờ khoá của báo cáo khác');
  assert.deepEqual([result.denied, result.deniedSeen], ['forbidden', []], 'khoá báo cáo khác ⇒ forbidden, không tới prepare');
  assert.deepEqual([result.allowed, result.allowedSeen], ['ok', [['report', result.expectedInput]]]);
  assert.equal(result.noneList.some(name => W2_TOOL_NAMES.includes(name)), false, 'không giữ khoá báo cáo nào ⇒ không hiện');
});

test('broker: tool meta hiện ⇔ kết nối giữ khoá của ít nhất một báo cáo đã đăng ký; thiếu khoá ⇒ không hiện, gọi thẳng tool_not_available', async t => {
  const all = brokerFor(t, [...HERMES_READ_CAPABILITIES]);
  const names = (await all.broker.listTools(all.token)).tools.map(tool => tool.name);
  for (const name of W2_TOOL_NAMES) assert.equal(names.includes(name), W2.permissions.length > 0, `${name}: ${W2.permissions.length} khoá có báo cáo`);
  assert.ok(names.includes('crm_read_customers'), 'họ cũ vẫn hiện');
  // Không khoá nào của báo cáo đã đăng ký (Gói 0: sổ rỗng ⇒ mọi kết nối) ⇒ không hiện, gọi thẳng bị chặn trước SQL.
  const none = brokerFor(t, HERMES_READ_CAPABILITIES.filter(key => !W2.permissions.includes(key)));
  const visible = (await none.broker.listTools(none.token)).tools.map(tool => tool.name);
  for (const name of W2_TOOL_NAMES) assert.equal(visible.includes(name), false, name);
  await assert.rejects(none.broker.callTool(none.token, 'crm_read_report', { report: 'probe_rows' }), error => error.code === 'tool_not_available');
  await assert.rejects(none.broker.callTool(none.token, 'crm_read_report_list', {}), error => error.code === 'tool_not_available');
  assert.deepEqual(none.seen, []);
  assert.throws(() => domainInput('report', { report: 'probe_rows' }), 'sổ thật không có mã thăm dò');
  assert.deepEqual(domainResult('report_list', { organizationId: ORG, domain: 'report_list', fetchedAt: '2026-10-18T00:00:00.000Z',
    items: [{ report: 'future_report', permission: 'vehicles.view' }] }, identity(['vehicles.view']), domainInput('report_list', {})).items, [],
  'mã SQL mà bản broker này chưa biết bị bỏ qua');
});
