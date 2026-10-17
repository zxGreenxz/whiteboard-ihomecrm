import test from 'node:test';
import assert from 'node:assert/strict';
// Imported before broker.mjs on purpose: it imports broker.mjs back, so the
// broker must not read the tool arrays while modules are still loading.
import { EXTERNAL_GROUP_TOOLS } from './external-group-mount.mjs';
import { GROUP_DIRECTORY_TOOL, GROUP_PREVIEW_TOOL, GROUP_SEND_TOOL, GROUP_SEND_STATUS_TOOL } from './group-preview-mount.mjs';
import { TOOLS_LIST_MAX_BYTES, createBroker } from './broker.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
import { advertisedTool, normalizeToolArguments } from './tool-argument-shape.mjs';
import { TASK_TOOLS } from './task-contract.mjs';
import { TASK_INPUT_TOOLS, taskActionInput } from './task-input-contract.mjs';
import { ROOM_PASS_TOOLS, roomPassInput } from './room-pass-contract.mjs';
import { DOMAIN_TOOLS, ALL_DOMAIN_READ_CAPABILITIES, domainInput } from './domain-contract.mjs';
import { SCHEDULE_TOOLS } from './schedule-contract.mjs';
import { WORK_MEMORY_TOOLS } from './work-memory-contract.mjs';
import { CUSTOMER_ACTION_TOOLS } from './customer-action-contract.mjs';
import { EXPENSE_ACTION_TOOLS } from './expense-action-contract.mjs';
import { NEW_REQUEST_ID_TOOL } from './request-id-contract.mjs';
import { ZALO_BROADCAST_TOOLS } from './zalo-broadcast-contract.mjs';
import { HERMES_READ_CAPABILITIES, HERMES_ACTION_CAPABILITIES } from './capability-contract.mjs';
import { DOMAIN_QUERY_HINT, DOMAIN_BUILDING_HINT, EMPTY_RESULT_HINT } from './domain-contract.mjs';

const NIL = '00000000-0000-0000-0000-000000000000';
const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const ALL = [...TASK_TOOLS, ...TASK_INPUT_TOOLS, ...ROOM_PASS_TOOLS, ...DOMAIN_TOOLS, ...SCHEDULE_TOOLS, ...WORK_MEMORY_TOOLS,
  ...CUSTOMER_ACTION_TOOLS, ...EXPENSE_ACTION_TOOLS, ...EXTERNAL_GROUP_TOOLS, ...ZALO_BROADCAST_TOOLS, NEW_REQUEST_ID_TOOL];
const tool = name => ALL.find(value => value.name === name);
const nullable = property => Array.isArray(property?.type) && property.type.includes('null');
const requiredNullable = value => (value.inputSchema.required ?? []).filter(key => nullable(value.inputSchema.properties?.[key]));
// Exact production arguments of 16/10/2026 (cx/gpt-6-sol via 9router), sent three times.
const INCIDENT = Object.freeze({ kind: 'buildings', buildingId: NIL, query: '', limit: 50, cursor: NIL });

test('advertised schemas make required nullable fields omittable and leave every original unchanged', () => {
  const before = JSON.stringify(ALL);
  assert.deepEqual(ALL.filter(value => requiredNullable(value).length).map(value => value.name).sort(), ['crm_customer_create',
    'crm_expense_create', 'crm_lead_create', 'crm_task_create', 'crm_task_input_options', 'crm_work_memory_upsert', 'crm_zalo_broadcast_send']);
  for (const original of ALL) {
    const listed = advertisedTool(original), dropped = requiredNullable(original), properties = original.inputSchema.properties ?? {};
    assert.deepEqual(requiredNullable(listed), [], original.name);
    assert.deepEqual(listed.inputSchema.required, original.inputSchema.required?.filter(key => !dropped.includes(key)));
    assert.equal(listed.inputSchema.additionalProperties, original.inputSchema.additionalProperties);
    assert.deepEqual(Object.keys(listed.inputSchema.properties ?? {}), Object.keys(properties));
    for (const [key, property] of Object.entries(properties)) {
      assert.deepEqual(listed.inputSchema.properties[key], dropped.includes(key) ?
        { ...property, description: [property.description, 'Bỏ trống nếu không có.'].filter(Boolean).join(' ') } : property);
    }
    assert.deepEqual({ ...listed, inputSchema: null }, { ...original, inputSchema: null });
  }
  assert.equal(JSON.stringify(ALL), before, 'definitions are never mutated');
  assert.deepEqual(advertisedTool(tool('crm_task_input_options')).inputSchema.required, ['kind', 'query', 'limit']);
  assert.ok(tool('crm_task_input_options').inputSchema.required.includes('cursor'), 'validator input stays complete');
  // building_profit rejects null dates, so they are plain required strings.
  assert.deepEqual(advertisedTool(tool('crm_read_building_profit')).inputSchema.required, ['fromDate', 'toDate']);
  assert.equal(tool('crm_read_building_profit').inputSchema.properties.fromDate.type, 'string');
  assert.deepEqual(tool('crm_read_income_expenses').inputSchema.properties.fromDate.type, ['string', 'null']);
  // Host-only private group tools are listed without shaping; keep them free of the pattern.
  for (const value of [GROUP_DIRECTORY_TOOL, GROUP_PREVIEW_TOOL, GROUP_SEND_TOOL, GROUP_SEND_STATUS_TOOL]) assert.deepEqual(requiredNullable(value), []);
});

test('required nullable fields: absent, blank and nil UUID become null; everything else is exact', () => {
  const options = tool('crm_task_input_options');
  const shaped = normalizeToolArguments(options, INCIDENT);
  assert.deepEqual(shaped, { ...INCIDENT, buildingId: null, cursor: null });
  assert.notEqual(shaped, INCIDENT);
  assert.throws(() => taskActionInput('options', INCIDENT), 'the validator itself is unchanged');
  assert.deepEqual(taskActionInput('options', shaped), { ...INCIDENT, buildingId: null, cursor: null });
  for (const placeholder of [`\t${NIL}\n`, ` ${NIL}`, '', ' ', '\r\n\t']) {
    assert.deepEqual(normalizeToolArguments(options, { ...INCIDENT, buildingId: placeholder, cursor: placeholder }), { ...INCIDENT, buildingId: null, cursor: null });
  }
  assert.deepEqual(normalizeToolArguments(options, { kind: 'buildings', query: '', limit: 50 }), { kind: 'buildings', query: '', limit: 50, buildingId: null, cursor: null });
  // Real ids are not trimmed; other fields keep spacing, type and unknown keys for the validator.
  const real = { kind: 'rooms\t', buildingId: ` ${id('1')}`, query: '  Nhà A ', limit: '50', cursor: id('2'), extra: NIL };
  assert.deepEqual(normalizeToolArguments(options, real), real);
  for (const value of [null, 0, false, 7, {}, []]) assert.equal(normalizeToolArguments(options, { ...INCIDENT, cursor: value }).cursor, value);
  // Only the top level: nested lines and non-nullable UUIDs reach the validator as sent.
  const lines = [{ categoryId: NIL, amount: 1, description: ' ' }];
  const expense = normalizeToolArguments(tool('crm_expense_create'), { requestId: id('3'), buildingId: id('4'), cashbookId: NIL, voucherDate: '2026-10-16', name: 'x', vendor: '  ', lines });
  assert.equal(expense.lines, lines); assert.deepEqual(lines, [{ categoryId: NIL, amount: 1, description: ' ' }]);
  assert.equal(expense.roomId, null); assert.equal(expense.vendor, null); assert.equal(expense.cashbookId, NIL);
  // A required nullable text field is not a UUID: the nil-UUID string is real text there.
  assert.equal(normalizeToolArguments(tool('crm_customer_create'), { notes: NIL }).notes, NIL);
  assert.deepEqual(normalizeToolArguments(tool('crm_customer_create'), { notes: ' \n' }), { notes: null, email: null });
  assert.equal(normalizeToolArguments(tool('crm_work_memory_upsert'), { expectedId: NIL }).expectedId, null);
});

test('non-objects, unknown tools, prototypes, accessors and hostile proxies pass through', () => {
  const options = tool('crm_task_input_options');
  for (const value of [undefined, null, [], [NIL], 'x', 5, new Date(0), new Map()]) assert.equal(normalizeToolArguments(options, value), value);
  assert.deepEqual(normalizeToolArguments(undefined, { cursor: NIL }), { cursor: NIL });
  assert.deepEqual(normalizeToolArguments(NEW_REQUEST_ID_TOOL, { cursor: NIL }), { cursor: NIL });
  const bare = Object.assign(Object.create(null), { ...INCIDENT });
  const shaped = normalizeToolArguments(options, bare);
  assert.equal(Object.getPrototypeOf(shaped), null); assert.equal(shaped.cursor, null); assert.equal(bare.cursor, NIL);
  let reads = 0;
  const accessor = Object.defineProperty({ kind: 'buildings' }, 'cursor', { enumerable: true, get() { reads += 1; return NIL; } });
  const kept = normalizeToolArguments(options, accessor);
  assert.equal(reads, 0); assert.equal(typeof Object.getOwnPropertyDescriptor(kept, 'cursor').get, 'function');
  assert.throws(() => taskActionInput('options', kept));
  const hostile = new Proxy({}, { ownKeys() { throw new Error('private'); } });
  assert.equal(normalizeToolArguments(options, hostile), hostile);
});

// List-shaped reads (query/cursor/buildingId). Detail/report reads of the v3 full-read
// family have their own schema (full-read-contract) and are checked separately.
const LIST_READS = DOMAIN_TOOLS.filter(read => Object.hasOwn(read.inputSchema.properties, 'cursor'));
test('optional nullable UUID fields (crm_read_*) map nil/blank to null and keep absence', () => {
  assert.ok(LIST_READS.length >= 13);
  for (const read of LIST_READS) {
    assert.deepEqual(normalizeToolArguments(read, { cursor: NIL, buildingId: ` ${NIL}\t` }), { cursor: null, buildingId: null }, read.name);
    assert.deepEqual(normalizeToolArguments(read, { cursor: '', buildingId: '  ' }), { cursor: null, buildingId: null }, read.name);
    assert.deepEqual(normalizeToolArguments(read, { query: ' ', limit: 5 }), { query: ' ', limit: 5 }, read.name);
  }
  assert.throws(() => domainInput('customers', { cursor: NIL, buildingId: NIL }));
  assert.deepEqual(domainInput('customers', normalizeToolArguments(tool('crm_read_customers'), { cursor: NIL, buildingId: NIL, limit: 5 })),
    domainInput('customers', { limit: 5 }));
  // Dates are not UUIDs: an optional blank date stays for the validator to reject.
  assert.deepEqual(normalizeToolArguments(tool('crm_read_income_expenses'), { fromDate: ' ' }), { fromDate: ' ' });
  assert.deepEqual(normalizeToolArguments(tool('crm_expense_input_options'), { kind: 'rooms', buildingId: NIL }), { kind: 'rooms', buildingId: null });
});

test('16/10 19:44Z: read tools say query is a row text filter, buildingId is not the company id, [] is final', () => {
  // 17/10 rút gọn (tools/list ≤ ngân sách) nhưng giữ đủ ba ý của sự cố.
  const EMPTY = EMPTY_RESULT_HINT;
  assert.match(EMPTY, /kết quả thật; không gọi lại cùng đối số\.$/);
  assert.match(DOMAIN_QUERY_HINT, /^Lọc chữ trong từng mục .*lọc toà thì dùng buildingId\.$/);
  assert.match(DOMAIN_BUILDING_HINT, /^ID toà, không phải ID công ty; trống = mọi toà\.$/);
  for (const read of LIST_READS) {
    const listed = advertisedTool(read), { query, buildingId } = listed.inputSchema.properties;
    assert.ok(listed.description.endsWith(`. ${EMPTY}`), read.name);
    assert.equal(query.description, DOMAIN_QUERY_HINT, read.name);
    assert.equal(buildingId.description, DOMAIN_BUILDING_HINT, read.name);
    // Text only: types and formats are what the validators already enforce.
    assert.deepEqual([query.type, query.maxLength, buildingId.type, buildingId.format], ['string', 200, ['string', 'null'], 'uuid'], read.name);
  }
  const options = advertisedTool(tool('crm_task_input_options'));
  assert.ok(options.description.endsWith(` ${EMPTY}`));
  assert.match(options.inputSchema.properties.query.description, /^Lọc theo tên/);
  assert.match(options.inputSchema.properties.buildingId.description, /không phải ID công ty\. kind=buildings: không cần buildingId\./);
});

// P2-1 (review 85280779): kết nối đủ quyền thấy MỌI họ tool cùng lúc (cả crm_available_rooms,
// nhóm Zalo, sửa/huỷ việc). Trước 17/10 tools/list dùng chung trần dữ liệu 65 536 B: vượt là mất cả danh sách.
// Từ 17/10 tools/list có trần riêng TOOLS_LIST_MAX_BYTES (192 KiB); tools/call giữ 65 536 B (server.mjs).
// Ngân sách 64 000 B vẫn giữ để connector bản cũ (một trần chung) nhận đủ danh sách.
// 85280779: 67 988 B (đã vượt); rút họ đọc: 63 743 B; rút chữ requestId (15 tool): 62 168 B.
const TOOLS_LIST_BUDGET = 64_000;
function fullGrantBroker(t, limits = { maxResultBytes: 65_536 }) {
  const scope = createDependencyScope(); t.after(() => scope.close());
  const CONNECTION = id('a'), BUILDING = id('f');
  const read = [...new Set([...HERMES_READ_CAPABILITIES, ...ALL_DOMAIN_READ_CAPABILITIES, 'chat_zalo.view', 'rooms.view', 'assistant.context.read', 'assistant.memory.read'])];
  const action = [...new Set([...HERMES_ACTION_CAPABILITIES, 'tasks.create', 'tasks.edit', 'tasks.delete', 'sale_phong.manage_pass_listings', 'customers.create',
    'leads.create', 'income_expenses.create', 'chat_zalo.manage_automation', 'chat_zalo.send', 'assistant.memory.write'])];
  const identity = { row: { id: CONNECTION, assistantId: id('b'), userId: id('c'), organizationId: id('d'), expiresAt: Date.now() + 600_000,
    epoch: 1, state: 'active', restrictions: { read, action } }, effective: { read, action }, isSuperadmin: false,
  policyEpoch: 'a'.repeat(64), contextVersion: 'b'.repeat(64), assistantScopeIds: [id('e')],
  scopesByPermission: Object.fromEntries([...read, ...action].map(key => [key, { buildingIds: [BUILDING], cashbookIds: [] }])) };
  const authority = { identifyConnection: async () => ({ connectionId: CONNECTION }), resolve: async () => identity, checkUnchanged: async () => {} };
  const port = (prepare, finalize) => ({ async [prepare]() { return Object.freeze({}); }, async [finalize]() { return { ok: true }; } });
  const broker = createBroker({ authority, dependencyScope: scope, audit: async () => {}, limits,
    tasks: port('prepareTask', 'finalizeTask'), domains: port('prepareDomain', 'finalizeDomain'), roomPass: port('prepareRoomPass', 'finalizeRoomPass'),
    customers: port('prepareCustomerAction', 'finalizeCustomerAction'), expenses: port('prepareExpenseAction', 'finalizeExpenseAction'),
    schedules: port('prepareSchedule', 'finalizeSchedule'), workMemory: port('prepareMemory', 'finalizeMemory'),
    zaloBroadcasts: port('prepareZaloBroadcast', 'finalizeZaloBroadcast'), roomReads: port('prepareAvailableRooms', 'finalizeAvailableRooms'),
    externalGroups: { authority, createService: () => ({}) },
    // Host-only private port (never in tools/list): a directory result of a few hundred bytes.
    groupPreviews: { authority, createService: () => ({ async prepareGroupDirectory() { return Object.freeze({}); },
      async finalizeGroupDirectory() { return { groups: ['1', '2', '3', '4'].map(n => ({ conversationId: id(n), name: `Nhóm ${n}` })) }; } }) } });
  return { broker, token: `hc_${'A'.repeat(43)}` };
}

test('tools/list of a connection holding every grantable key lists every family and stays inside the budget', async t => {
  const { broker, token } = fullGrantBroker(t);
  const listed = (await broker.listTools(token)).tools, names = listed.map(value => value.name);
  const expected = [...ALL.filter(value => !['crm_room_schedule_create', 'crm_room_schedule_update'].includes(value.name)).map(value => value.name),
    'crm_auth_context', 'crm_available_rooms'];
  assert.deepEqual([...names].sort(), [...new Set(expected)].sort(), 'every family, every non-retired tool');
  const bytes = Buffer.byteLength(JSON.stringify({ tools: listed }));
  t.diagnostic(`tools/list ${listed.length} tools, ${bytes} bytes`);
  assert.ok(bytes <= TOOLS_LIST_BUDGET, `tools/list ${bytes} bytes > ${TOOLS_LIST_BUDGET}`);
  // Họ đọc đầy đủ v3 (10 tool) giữ mô tả gọn: ý riêng tư + ý chọn đúng tool.
  const full = listed.filter(value => ['crm_read_customers', 'crm_read_occupancy', 'crm_read_customer_detail', 'crm_read_contract_detail', 'crm_read_occupancy_report',
    'crm_read_invoice_report', 'crm_read_monthly_pnl', 'crm_read_pending_approvals', 'crm_read_zalo_conversations', 'crm_read_contract_search'].includes(value.name));
  assert.equal(full.length, 10);
  assert.ok(Buffer.byteLength(JSON.stringify(full)) <= 10_000, 'full-read family stays compact');
});

test('tools/list has its own 192 KiB cap; tools/call data keeps the result cap', async t => {
  assert.equal(TOOLS_LIST_MAX_BYTES, 192 * 1024);
  const reference = fullGrantBroker(t), all = await reference.broker.listTools(reference.token);
  const bytes = Buffer.byteLength(JSON.stringify(all));
  // A catalogue larger than the data cap still lists in full and unchanged ...
  const narrow = fullGrantBroker(t, { maxResultBytes: 4096 });
  assert.ok(bytes > 4096);
  assert.deepEqual(await narrow.broker.listTools(narrow.token), all);
  // ... while a tools/call result is still measured against maxResultBytes alone.
  assert.equal((await narrow.broker.callTool(narrow.token, 'crm_new_request_id', {})).isError, false);
  const tight = fullGrantBroker(t, { maxResultBytes: 64 });
  const tooLarge = error => error.code === 'response_too_large' && error.status === 502;
  await assert.rejects(tight.broker.callTool(tight.token, 'crm_new_request_id', {}), tooLarge);
  assert.deepEqual(await tight.broker.listTools(tight.token), all);
  // Only tools/list: authenticate and the host-only private operations keep the data cap too.
  const directory = broker => broker.groupDirectory(reference.token, { commandId: id('7'), claimId: id('8') }, { signal: AbortSignal.timeout(5000) });
  assert.equal((await reference.broker.authenticate(reference.token)).id, id('a'));
  assert.equal((await directory(reference.broker)).groups.length, 4);
  await assert.rejects(tight.broker.authenticate(tight.token), tooLarge);
  await assert.rejects(directory(tight.broker), tooLarge);
  // Over its own cap the listing still fails closed: never a truncated catalogue.
  const exact = fullGrantBroker(t, { maxResultBytes: 65_536, maxToolsListBytes: bytes });
  assert.deepEqual(await exact.broker.listTools(exact.token), all);
  const over = fullGrantBroker(t, { maxResultBytes: 65_536, maxToolsListBytes: bytes - 1 });
  await assert.rejects(over.broker.listTools(over.token), error => error.code === 'response_too_large' && error.status === 502);
  // The ceiling is bounded like the data cap.
  assert.throws(() => fullGrantBroker(t, { maxToolsListBytes: TOOLS_LIST_MAX_BYTES + 1 }), /unsafe_limits/);
  assert.throws(() => fullGrantBroker(t, { maxResultBytes: 65_537 }), /unsafe_limits/);
  for (const value of [0, 1.5, '196608']) assert.throws(() => fullGrantBroker(t, { maxToolsListBytes: value }), /invalid_limits/);
});

test('crm_room_pass_upsert keeps absent = keep, blank = keep, null = clear', () => {
  const upsert = tool('crm_room_pass_upsert'), base = { requestId: id('5'), roomId: id('6') };
  for (const args of [base, { ...base, customerName: '  ', customerPhone: '', salePolicy: ' \n' },
    { ...base, customerName: null, customerPhone: null, passPrice: null, availDate: null, salePolicy: null },
    { ...base, customerName: ' Anh Bình ', passPrice: 3_500_000, availDate: '2026-11-01' }]) {
    const shaped = normalizeToolArguments(upsert, args);
    assert.deepEqual(shaped, args); assert.deepEqual(roomPassInput('upsert', shaped), roomPassInput('upsert', args));
  }
  assert.deepEqual(roomPassInput('upsert', normalizeToolArguments(upsert, { ...base, customerName: '  ' })), base, 'blank never becomes a clear');
});

function brokerFixture(t) {
  const scope = createDependencyScope(); t.after(() => scope.close());
  const seen = [], CONNECTION = id('a');
  // Every domain read is granted so tools/list below is measured with all of them.
  const read = [...ALL_DOMAIN_READ_CAPABILITIES, 'chat_zalo.view', 'assistant.memory.read'];
  const action = ['tasks.create', 'sale_phong.manage_pass_listings', 'customers.create', 'leads.create', 'income_expenses.create',
    'chat_zalo.manage_automation', 'chat_zalo.send', 'assistant.memory.write'];
  const identity = { row: { id: CONNECTION, assistantId: id('b'), userId: id('c'), organizationId: id('d'), expiresAt: Date.now() + 600_000,
    epoch: 1, state: 'active', restrictions: { read, action } }, effective: { read, action }, isSuperadmin: false,
  policyEpoch: 'a'.repeat(64), contextVersion: 'b'.repeat(64), assistantScopeIds: [],
  scopesByPermission: Object.fromEntries([...read, ...action].map(key => [key, { buildingIds: [], cashbookIds: [] }])) };
  const port = (prepare, finalize) => ({
    async [prepare](_token, operation, input) { seen.push([operation, input]); return Object.freeze({}); },
    async [finalize]() { return { ok: true }; },
  });
  const broker = createBroker({
    authority: { identifyConnection: async () => ({ connectionId: CONNECTION }), resolve: async () => identity, checkUnchanged: async () => {} },
    // Same data cap as server.mjs; tools/list has its own cap (TOOLS_LIST_MAX_BYTES).
    dependencyScope: scope, audit: async () => {}, limits: { maxResultBytes: 65_536 },
    tasks: port('prepareTask', 'finalizeTask'), domains: port('prepareDomain', 'finalizeDomain'), roomPass: port('prepareRoomPass', 'finalizeRoomPass'),
    customers: port('prepareCustomerAction', 'finalizeCustomerAction'), expenses: port('prepareExpenseAction', 'finalizeExpenseAction'),
    schedules: port('prepareSchedule', 'finalizeSchedule'), workMemory: port('prepareMemory', 'finalizeMemory'),
    zaloBroadcasts: port('prepareZaloBroadcast', 'finalizeZaloBroadcast'),
  });
  return { broker, seen, token: `hc_${'A'.repeat(43)}` };
}

test('broker tools/list advertises no required nullable field across mounted families', async t => {
  const { broker, token } = brokerFixture(t);
  const listed = (await broker.listTools(token)).tools;
  for (const name of ['crm_task_input_options', 'crm_task_create', 'crm_customer_create', 'crm_lead_create', 'crm_expense_create',
    'crm_work_memory_upsert', 'crm_read_customers', 'crm_room_pass_upsert', 'crm_room_schedule_list', 'crm_zalo_broadcast_send', 'crm_zalo_broadcast_update', 'crm_new_request_id']) {
    assert.ok(listed.some(value => value.name === name), name);
  }
  for (const value of listed) assert.deepEqual(requiredNullable(value), [], value.name);
  assert.equal(listed.filter(value => value.name.startsWith('crm_read_')).length, DOMAIN_TOOLS.length);
  assert.ok(Buffer.byteLength(JSON.stringify({ tools: listed })) <= TOOLS_LIST_BUDGET, 'tools/list stays inside the budget');
  assert.deepEqual(listed.find(value => value.name === 'crm_task_input_options').inputSchema.required, ['kind', 'query', 'limit']);
  assert.deepEqual(listed.find(value => value.name === 'crm_task_create').inputSchema.required, ['requestId', 'title', 'buildingId', 'jobTypeId', 'priority']);
});

test('broker turns the 16/10 incident call into the null call before any validator', async t => {
  const { broker, seen, token } = brokerFixture(t);
  const expected = [['options', { ...INCIDENT, buildingId: null, cursor: null }]];
  for (const args of [INCIDENT, { ...INCIDENT, buildingId: `${NIL}\n`, cursor: `\t${NIL}` }, { kind: 'buildings', query: '', limit: 50 }]) {
    seen.length = 0;
    assert.equal((await broker.callTool(token, 'crm_task_input_options', args)).isError, false);
    assert.deepEqual(seen, expected);
  }
  // A placeholder never stands in for a needed id: same code and status as before.
  seen.length = 0;
  await assert.rejects(broker.callTool(token, 'crm_task_input_options', { ...INCIDENT, kind: 'rooms' }),
    error => error.code === 'invalid_request' && error.status === 400);
  assert.deepEqual(seen, []);
  await broker.callTool(token, 'crm_read_customers', { cursor: NIL, buildingId: ' ', limit: 5 });
  assert.deepEqual(seen, [['customers', domainInput('customers', { limit: 5 })]]);
  seen.length = 0;
  const base = { requestId: id('5'), roomId: id('6') };
  await broker.callTool(token, 'crm_room_pass_upsert', { ...base, customerName: '  ', customerPhone: '' });
  await broker.callTool(token, 'crm_room_pass_upsert', { ...base, customerName: null });
  assert.deepEqual(seen, [['upsert', base], ['upsert', { ...base, customerName: null }]]);
});
