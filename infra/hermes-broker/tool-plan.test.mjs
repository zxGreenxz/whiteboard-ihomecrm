import test from 'node:test';
import assert from 'node:assert/strict';
import { fullGrantBroker, fullGrantId, FULL_GRANT_ORGANIZATION } from './full-grant-broker.fixture.mjs';
import * as domainContract from './domain-contract.mjs';
import { W2 } from './wave2-registry.mjs';
import { roomPassResult } from './room-pass-contract.mjs';
import { normalizeToolArguments } from './tool-argument-shape.mjs';
import { READ_MISUSE_HINTS, READ_MISUSE_HINT_TEXTS, BUILDING_ID_HINT, readMisuseHint } from './read-misuse-hints.mjs';
import { TOOL_PLAN_CASES, SUMMARY_PENDING } from './tool-plan-cases.mjs';

// T4 (R2b, 21/10/2026; plan R2 §B.6): chọn đúng tool cho các câu của bộ 79 câu production, không gọi model, không SQL.
// Hermes kiểm đối số của `tool_call` theo schema QUẢNG BÁO trước khi gọi connector (validate_deferred_call_args; trace
// full50c: 17/17 lời gọi sai dừng ở đó) — nên mỗi lời gọi đúng phải qua cả schema quảng bá lẫn validator của broker, và
// mỗi lời gọi sai ghi rõ Hermes chặn hay để qua.
const { DOMAIN_READS, DOMAIN_TOOLS, domainOperation } = domainContract;

// Tập con JSON Schema mà schema quảng bá của tool dùng (type, enum, properties, additionalProperties, required, min/max,
// minLength/maxLength, pattern); `format` không kiểm (jsonschema mặc định cũng không) — như Hermes ở cấp đối số.
function schemaAccepts(schema, value) {
  const typeOk = (type, item) => ({ string: typeof item === 'string', integer: Number.isInteger(item), number: typeof item === 'number',
    boolean: typeof item === 'boolean', null: item === null, array: Array.isArray(item),
    object: item !== null && typeof item === 'object' && !Array.isArray(item) })[type] ?? false;
  const check = (rule, item) => {
    if (rule.type !== undefined && ![].concat(rule.type).some(type => typeOk(type, item))) return false;
    if (Array.isArray(rule.enum) && !rule.enum.includes(item)) return false;
    if (typeof item === 'string' && (rule.maxLength !== undefined && [...item].length > rule.maxLength ||
        rule.minLength !== undefined && [...item].length < rule.minLength || rule.pattern !== undefined && !new RegExp(rule.pattern, 'u').test(item))) return false;
    if (typeof item === 'number' && (rule.minimum !== undefined && item < rule.minimum || rule.maximum !== undefined && item > rule.maximum)) return false;
    if (rule.properties !== undefined || rule.type === 'object') {
      if (!typeOk('object', item) || (rule.required ?? []).some(key => !Object.hasOwn(item, key))) return false;
      for (const [key, sub] of Object.entries(item)) {
        if (rule.properties && Object.hasOwn(rule.properties, key)) { if (!check(rule.properties[key], sub)) return false; } else if (rule.additionalProperties === false) return false;
      }
    }
    return true;
  };
  return check(schema, value);
}
const listing = description => [...description].slice(0, 60).join('');
async function catalogue(t) {
  const fixture = fullGrantBroker(t);
  const tools = new Map((await fixture.broker.listTools(fixture.token)).tools.map(tool => [tool.name, tool]));
  return { ...fixture, tools };
}
const ORIGINALS = new Map(DOMAIN_TOOLS.map(tool => [tool.name, tool]));
const LOOKUP_SAMPLE = Object.freeze({ organizationId: FULL_GRANT_ORGANIZATION, truncated: false, rooms: [{ roomId: fullGrantId('1'), roomName: '305', roomCode: null,
  roomStatus: 'OCCUPIED', buildingId: fullGrantId('2'), buildingName: '102LVT', hasActiveContract: true, representative: { name: 'Đại diện', phone: null }, passListing: null }] });
// Đường sâu hơn summary.<khoá> (vd summary.byType.EXPENSE.largest, R2c): đi đúng đường trên kết quả mà connector trả cho
// summary của hàng mẫu tổng hợp (summarizeRows → domainResult, cùng bộ lọc của câu) — khoá con phải có thật, không chỉ
// khoá cấp một. Miền chưa có hàng mẫu ⇒ false (thêm mẫu khi câu mới cần).
const sampleId = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SAMPLE_BUILDING = sampleId(900), SAMPLE_PLACE = Object.freeze({ buildingId: SAMPLE_BUILDING, buildingName: 'Toà mẫu', roomId: sampleId(904), roomName: 'P1' });
const SUMMARY_SAMPLES = Object.freeze({
  income_expenses: status => [
    { id: sampleId(901), code: 'PT1', type: 'INCOME', name: 'Thu mẫu', ...SAMPLE_PLACE, voucherDate: '2026-10-05', totalAmount: '5', approvalStatus: status ?? 'APPROVED' },
    { id: sampleId(902), code: 'PC1', type: 'EXPENSE', name: 'Chi mẫu', ...SAMPLE_PLACE, voucherDate: '2026-10-06', totalAmount: '3', approvalStatus: status ?? 'APPROVED' }],
  receivables: status => [{ id: sampleId(903), number: 'HD1', status: status ?? 'APPROVED', ...SAMPLE_PLACE, buildingCode: null, billingMonth: '2026-10',
    dueDate: '2026-10-10', totalAmount: '2', paidAmount: '1', remainingAmount: '1' }],
});
function deepSummaryPath(operation, args, path) {
  if (!Object.hasOwn(SUMMARY_SAMPLES, operation)) return false;
  const definition = DOMAIN_READS[operation], family = domainContract.DOMAIN_FAMILIES[definition.family];
  const input = domainContract.domainInput(operation, domainContract.splitReadNames(operation, args).args), rows = SUMMARY_SAMPLES[operation](input.status);
  const value = { organizationId: FULL_GRANT_ORGANIZATION, domain: operation, summary: domainContract.summarizeRows(operation, rows), items: rows, nextCursor: null,
    ...(family.resultKeys.includes('source') ? { source: definition.source } : {}), ...(family.resultKeys.includes('fetchedAt') ? { fetchedAt: '2026-10-21T00:00:00.000Z' } : {}) };
  let node = domainContract.domainResult(operation, value, { row: { organizationId: FULL_GRANT_ORGANIZATION },
    scopesByPermission: { [definition.permission]: { buildingIds: [SAMPLE_BUILDING] } } }, input);
  for (const key of path.split('.')) {
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, key)) return false;
    node = node[key];
  }
  return node !== null && node !== undefined;
}
// 'declared' | 'pending' | false — đường answerFrom có trong khuôn kết quả mà connector kiểm và trả cho mô hình không.
function answerShape(tool, args, path) {
  if (tool === 'crm_room_lookup') {
    const out = roomPassResult('lookup', structuredClone(LOOKUP_SAMPLE), { row: { organizationId: FULL_GRANT_ORGANIZATION } });
    const [head, field] = path.split('[].');
    return field === undefined ? (Object.hasOwn(out, head) ? 'declared' : false) : (Object.hasOwn(out[head][0], field) ? 'declared' : false);
  }
  const operation = domainOperation(tool), definition = DOMAIN_READS[operation];
  const [head, field] = path.startsWith('items[].') ? ['items', path.slice(8)] : path.split('.');
  let fields = definition.fields, summary = null;
  if (operation === 'report') ({ fields, summary } = W2.reports[args.report]);
  else if (definition.reports) {
    const names = Object.keys(definition.reports), spec = definition.reports[args.report ?? (names.length === 1 ? names[0] : '')];
    ({ fields, summary } = spec);
  } else summary = domainContract.DOMAIN_SUMMARIES?.[operation]?.fields ?? null;   // R2a: khuôn summary của tool danh sách
  if (head === 'items') return Object.hasOwn(fields, field) ? 'declared' : false;
  if (head !== 'summary') return false;
  if (summary !== null && Object.hasOwn(summary, field))
    return path.split('.').length === 2 || deepSummaryPath(operation, args, path) ? 'declared' : false;
  return SUMMARY_PENDING.includes(`${tool} ${path}`) ? 'pending' : false;
}

test('T4: dữ liệu — đúng 21 câu §B.6 + câu 5, 59 (R2c phần 2), số câu không trùng, không SĐT/mã dài, mọi mục SUMMARY_PENDING có câu dùng', () => {
  assert.deepEqual(TOOL_PLAN_CASES.map(entry => entry.n), [3, 5, 10, 13, 14, 15, 16, 19, 21, 26, 29, 32, 33, 35, 36, 40, 47, 49, 58, 59, 72, 73, 76]);
  for (const entry of TOOL_PLAN_CASES) {
    assert.doesNotMatch(JSON.stringify(entry, (_, value) => value instanceof RegExp ? String(value) : value), /\d{7,}/, `câu ${entry.n}: không SĐT/số dài`);
    assert.ok(entry.answerFrom.length > 0, `câu ${entry.n}`);
  }
  const used = new Set(TOOL_PLAN_CASES.flatMap(entry => entry.answerFrom.map(path => `${entry.tool} ${path}`)));
  for (const pending of SUMMARY_PENDING) assert.ok(used.has(pending), `SUMMARY_PENDING thừa: ${pending}`);
});

test('T4: lời gọi đúng — tool có trong tools/list đủ quyền, qua schema quảng bá (Hermes) và broker tới đúng cổng prepare', async t => {
  const { broker, token, seen, tools } = await catalogue(t);
  for (const entry of TOOL_PLAN_CASES) {
    const listed = tools.get(entry.tool);
    assert.ok(listed, `câu ${entry.n}: ${entry.tool} không có trong tools/list`);
    assert.equal(schemaAccepts(listed.inputSchema, entry.args), true, `câu ${entry.n}: Hermes sẽ từ chối ${JSON.stringify(entry.args)}`);
    seen.length = 0;
    const result = await broker.callTool(token, entry.tool, entry.args);
    assert.equal(result.isError, false, `câu ${entry.n}`);
    assert.equal(seen.length, 1, `câu ${entry.n}: đúng một lần prepare`);
    assert.equal(seen[0][0], entry.tool === 'crm_room_lookup' ? 'lookup' : domainOperation(entry.tool), `câu ${entry.n}`);
    // Tên toà/phòng rời đối số trước validator và tới mount dưới dạng names (B5d); không bao giờ thành query.
    const names = entry.tool === 'crm_room_lookup' ? undefined : entry.args.buildingName ?? entry.args.params?.buildingName;
    if (names !== undefined) assert.deepEqual(seen[0][2], { buildingName: names }, `câu ${entry.n}`);
  }
});

test('T4: answerFrom nằm trong khuôn kết quả khai báo; summary của tool danh sách chờ R2a (SUMMARY_PENDING)', t => {
  const pending = [], declaredNow = [];
  for (const entry of TOOL_PLAN_CASES) for (const path of entry.answerFrom) {
    const shape = answerShape(entry.tool, entry.args, path);
    assert.ok(shape, `câu ${entry.n}: ${entry.tool} không có ${path}`);
    if (shape === 'pending') pending.push(`${entry.n} ${entry.tool} ${path}`);
    if (shape === 'declared' && SUMMARY_PENDING.includes(`${entry.tool} ${path}`)) declaredNow.push(`${entry.tool} ${path}`);
  }
  t.diagnostic(`answerFrom chờ R2a: ${pending.length}${pending.length ? ` (${pending.join('; ')})` : ''}`);
  // Khi R2a gộp, summary được khai ⇒ gỡ các mục này khỏi SUMMARY_PENDING để test siết lại.
  if (declaredNow.length) t.diagnostic(`đã khai, gỡ khỏi SUMMARY_PENDING: ${[...new Set(declaredNow)].join('; ')}`);
  // Đường sâu được đi thật (không chỉ khoá cấp một): khoá con lạ, loại lạ hay miền chưa có hàng mẫu đều không qua.
  const month = { fromDate: '2026-10-01', toDate: '2026-10-31' };
  for (const [tool, args, path] of [['crm_read_income_expenses', month, 'summary.byType.EXPENSE.payer'], ['crm_read_income_expenses', month, 'summary.byType.TRANSFER.largest'],
    ['crm_read_income_expenses', month, 'summary.largest.payer'], ['crm_read_meter_readings', month, 'summary.byType.WATER']])
    assert.equal(answerShape(tool, args, path), false, `${tool} ${path}`);
  assert.equal(answerShape('crm_read_income_expenses', month, 'summary.byType.INCOME.largest'), 'declared');
});

test('T4: lời gọi sai của trace — Hermes chặn/để qua đúng như ghi; broker trả invalid_request kèm đúng hint tĩnh hoặc không detail', async t => {
  const { broker, token, seen, tools } = await catalogue(t);
  let reachable = 0;
  for (const entry of TOOL_PLAN_CASES) for (const wrong of entry.wrong ?? []) {
    const label = `câu ${entry.n}: ${wrong.tool} ${JSON.stringify(wrong.args)}`;
    assert.equal(schemaAccepts(tools.get(wrong.tool).inputSchema, wrong.args) ? 'passes' : 'rejects', wrong.hermes, label);
    if (wrong.hermes === 'passes') reachable += 1;
    seen.length = 0;
    await assert.rejects(broker.callTool(token, wrong.tool, wrong.args), error => {
      assert.equal(error.code, 'invalid_request', label); assert.equal(error.status, 400, label);
      if (wrong.hint === null) assert.equal(error.detail, undefined, label);
      else { assert.match(error.detail, wrong.hint, label); assert.ok(READ_MISUSE_HINT_TEXTS.includes(error.detail), label); }
      return true;
    });
    assert.deepEqual(seen, [], `${label}: không tới cổng prepare`);
  }
  assert.ok(reachable >= 1, 'ít nhất một hint tới được broker qua schema quảng bá hôm nay');
});

test('T4: alias trạng thái — đúng lời gọi sai chữ của trace thành giá trị enum (Hermes vẫn chặn trước theo schema quảng bá)', async t => {
  const { broker, token, seen, tools } = await catalogue(t);
  for (const entry of TOOL_PLAN_CASES) for (const alias of entry.alias ?? []) {
    const label = `câu ${entry.n}: ${JSON.stringify(alias.args)}`;
    assert.equal(schemaAccepts(tools.get(alias.tool).inputSchema, alias.args) ? 'passes' : 'rejects', alias.hermes, label);
    assert.deepEqual({ ...normalizeToolArguments(ORIGINALS.get(alias.tool), alias.args) }, alias.expect, label);
    seen.length = 0;
    assert.equal((await broker.callTool(token, alias.tool, alias.args)).isError, false, label);
    assert.equal(seen[0][1].status, alias.expect.status, label);
  }
});

test('T4: mô tả quảng bá chỉ đường (mentions) và 60 ký tự đầu mang cụm phân biệt (listing)', async t => {
  const { tools } = await catalogue(t);
  for (const entry of TOOL_PLAN_CASES) {
    for (const { tool, match } of entry.mentions ?? []) assert.match(tools.get(tool).description, match, `câu ${entry.n}: ${tool}`);
    for (const { tool, match } of entry.listing ?? []) assert.match(listing(tools.get(tool).description), match, `câu ${entry.n}: ${tool} (60 ký tự đầu)`);
  }
});

test('read-misuse-hints: chuỗi tĩnh, không chứa dữ liệu đã gửi, chỉ khi luật khớp; không đọc accessor', () => {
  assert.deepEqual(Object.keys(READ_MISUSE_HINTS).sort(), ['assets', 'contracts', 'income_expenses', 'invoices', 'pending_approvals']);
  assert.deepEqual(READ_MISUSE_HINT_TEXTS, [...Object.values(READ_MISUSE_HINTS).map(rule => rule.hint), BUILDING_ID_HINT]);
  assert.equal(new Set(READ_MISUSE_HINT_TEXTS).size, READ_MISUSE_HINT_TEXTS.length);
  for (const hint of READ_MISUSE_HINT_TEXTS) {
    assert.ok(Object.isFrozen(READ_MISUSE_HINT_TEXTS) && hint.length <= 300, hint);
    assert.doesNotMatch(hint, /\d{4,}|[0-9a-f]{8}-[0-9a-f]{4}/i, hint);
  }
  // Mọi giá trị mang dấu: hint không bao giờ lặp lại thứ mô hình đã gửi.
  const MARK = 'DẤU-riêng-ZQ';
  for (const [operation, args] of [['contracts', { fromDate: MARK, query: MARK }], ['invoices', { month: MARK, buildingName: MARK }],
    ['income_expenses', { type: MARK, buildingName: MARK }], ['pending_approvals', { buildingName: MARK }], ['assets', { query: `xe ${MARK}` }],
    ['receivables', { buildingId: MARK }], ['occupancy_report', { report: 'snapshot', buildingId: MARK }]]) {
    const hint = readMisuseHint(operation, args);
    assert.ok(READ_MISUSE_HINT_TEXTS.includes(hint), operation); assert.equal(hint.includes(MARK), false, operation);
  }
  // Lời gọi hợp lệ, miền không có luật, đối số không phải object thường: null.
  for (const [operation, args] of [['contracts', { status: 'ACTIVE', buildingName: '44TL' }], ['invoices', { status: null, query: 'HD-1' }],
    ['income_expenses', { status: 'UNAPPROVED', fromDate: '2026-10-01' }], ['pending_approvals', { query: '', limit: 50, offset: 0 }],
    ['assets', { query: 'xem kho' }], ['assets', { query: 'taxe' }], ['receivables', { buildingId: fullGrantId('f') }], ['receivables', { buildingId: '  ' }],
    ['report', { report: 'vehicles', params: { buildingId: '1392QT' } }], ['customer_detail', { buildingId: '1392QT' }], ['nope', { fromDate: 'x' }],
    [undefined, { fromDate: 'x' }], ['contracts', null], ['contracts', ['fromDate']], ['contracts', new Map([['fromDate', 1]])]])
    assert.equal(readMisuseHint(operation, args), null, JSON.stringify([operation, args]));
  // Xe/biển số là từ riêng, mọi dạng chữ (NFD, hoa) — chỉ trong query; trạng thái EXPIRING là luật của contracts.
  for (const query of ['xe máy', 'Xe đạp', 'biển số 59', 'biển số'.normalize('NFD'), 'BIỂN SỐ']) assert.equal(readMisuseHint('assets', { query }), READ_MISUSE_HINTS.assets.hint, query);
  assert.equal(readMisuseHint('contracts', { status: ' expiring ' }), READ_MISUSE_HINTS.contracts.hint);
  for (const key of ['from_date', 'endDate', 'month', 'days', 'billing_month', 'date']) assert.equal(readMisuseHint('contracts', { [key]: 1 }), READ_MISUSE_HINTS.contracts.hint, key);
  // Accessor: không bao giờ gọi getter (đối số đã chuẩn hoá có thể mang getter); khoá vẫn được thấy theo tên.
  let reads = 0;
  const getter = Object.defineProperty({}, 'query', { enumerable: true, get() { reads += 1; return 'xe'; } });
  assert.equal(readMisuseHint('assets', getter), null); assert.equal(reads, 0);
  const keyed = Object.defineProperty({}, 'fromDate', { enumerable: true, get() { reads += 1; return '2026-10-01'; } });
  assert.equal(readMisuseHint('contracts', keyed), READ_MISUSE_HINTS.contracts.hint); assert.equal(reads, 0);
  const hostile = new Proxy({}, { ownKeys() { throw new Error('private'); } });
  assert.equal(readMisuseHint('contracts', hostile), null);
});

test('broker: hint chỉ đi kèm lời gọi validator đã từ chối; có tên toà + hint ⇒ từ chối ngay, không hoãn tới mount', async t => {
  const { broker, token, seen } = fullGrantBroker(t);
  const refused = hint => error => error.code === 'invalid_request' && error.detail === hint;
  // Hợp lệ dù query nhắc "xe": chạy bình thường, không detail.
  assert.equal((await broker.callTool(token, 'crm_read_assets', { query: 'xe đẩy', buildingName: '162NVK' })).isError, false);
  assert.deepEqual(seen, [['assets', { query: 'xe đẩy', limit: 20, cursor: null, buildingId: null, status: null }, { buildingName: '162NVK' }]]);
  seen.length = 0;
  // Sai vì khoá lạ + nhắc xe: hint của assets; sai vì ngày ở hợp đồng kèm tên toà: từ chối trước mount (seen rỗng).
  await assert.rejects(broker.callTool(token, 'crm_read_assets', { query: 'xe', kind: 'vehicle' }), refused(READ_MISUSE_HINTS.assets.hint));
  await assert.rejects(broker.callTool(token, 'crm_read_contracts', { buildingName: '44TL', fromDate: '2026-10-01' }), refused(READ_MISUSE_HINTS.contracts.hint));
  await assert.rejects(broker.callTool(token, 'crm_read_invoices', { status: 'unpaid' }), refused(READ_MISUSE_HINTS.invoices.hint));
  await assert.rejects(broker.callTool(token, 'crm_read_occupancy_report', { report: 'snapshot', buildingId: '102LVT' }), refused(BUILDING_ID_HINT));
  // Sai nhưng không khớp luật nào: invalid_request trơn như trước R2b (có tên toà thì vẫn hoãn tới mount như B5d).
  await assert.rejects(broker.callTool(token, 'crm_read_contracts', { cursor: 'trang-2' }), error => error.code === 'invalid_request' && error.detail === undefined);
  await assert.rejects(broker.callTool(token, 'crm_read_customers', { status: 'ACTIVE' }), error => error.code === 'invalid_request' && error.detail === undefined);
  assert.deepEqual(seen, []);
});
