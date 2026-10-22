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
import { TASK_INPUT_TOOLS, TASK_OPTIONS_HINTS, taskActionInput } from './task-input-contract.mjs';
import { ROOM_PASS_TOOLS, roomPassInput } from './room-pass-contract.mjs';
import { DOMAIN_TOOLS, ALL_DOMAIN_READ_CAPABILITIES, domainInput } from './domain-contract.mjs';
import { SCHEDULE_TOOLS } from './schedule-contract.mjs';
import { WORK_MEMORY_TOOLS } from './work-memory-contract.mjs';
import { CUSTOMER_ACTION_TOOLS } from './customer-action-contract.mjs';
import { NEW_REQUEST_ID_TOOL } from './request-id-contract.mjs';
import { ZALO_BROADCAST_TOOLS } from './zalo-broadcast-contract.mjs';
import { fullGrantBroker } from './full-grant-broker.fixture.mjs';
import { READ_QUERY_HINTS, READ_NAMES, DOMAIN_BUILDING_HINT, EMPTY_RESULT_HINT, BUILDING_NAME_HINT, ROOM_NAME_HINT, domainOperation } from './domain-contract.mjs';
import { W2, W2_TOOL_NAMES } from './wave2-registry.mjs';

const NIL = '00000000-0000-0000-0000-000000000000';
const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const ALL = [...TASK_TOOLS, ...TASK_INPUT_TOOLS, ...ROOM_PASS_TOOLS, ...DOMAIN_TOOLS, ...SCHEDULE_TOOLS, ...WORK_MEMORY_TOOLS,
  ...CUSTOMER_ACTION_TOOLS, ...EXTERNAL_GROUP_TOOLS, ...ZALO_BROADCAST_TOOLS, NEW_REQUEST_ID_TOOL];
const tool = name => ALL.find(value => value.name === name);
const nullable = property => Array.isArray(property?.type) && property.type.includes('null');
const requiredNullable = value => (value.inputSchema.required ?? []).filter(key => nullable(value.inputSchema.properties?.[key]));
const readOnly = value => value.annotations?.readOnlyHint === true;
const OMIT = 'Bỏ trống nếu không có.';
const withHint = property => property.description?.includes(OMIT) ? property : { ...property, description: [property.description, OMIT].filter(Boolean).join(' ') };
// 20/10/2026: a read tool advertises no null at the top level (Hermes turns ['string','null'] into
// nullable:true, which stalled gpt-6 on the OpenAI route). Non-null type, no format:uuid, enum without
// null (a property left with no value disappears); OMIT on every converted field except UUIDs, whose
// blank/nil placeholders normalizeToolArguments already turns into null.
function readAdvertised(property) {
  if (nullable(property)) {
    const { format, ...rest } = property, types = property.type.filter(type => type !== 'null');
    const shaped = { ...rest, type: types.length === 1 ? types[0] : types, ...(format === undefined || format === 'uuid' ? {} : { format }) };
    return format === 'uuid' ? shaped : withHint(shaped);
  }
  if (!Array.isArray(property.enum) || !property.enum.includes(null)) return property;
  const values = property.enum.filter(value => value !== null);
  return values.length ? withHint({ ...property, enum: values }) : undefined;
}
const nullFree = schema => Object.values(schema.properties ?? {}).every(property => !nullable(property) && !(Array.isArray(property.enum) && property.enum.includes(null)));
// Exact production arguments of 16/10/2026 (cx/gpt-6-sol via 9router), sent three times.
const INCIDENT = Object.freeze({ kind: 'buildings', buildingId: NIL, query: '', limit: 50, cursor: NIL });

test('advertised schemas make required nullable fields omittable, read tools null-free, and leave every original unchanged', () => {
  const before = JSON.stringify(ALL);
  assert.deepEqual(ALL.filter(value => requiredNullable(value).length).map(value => value.name).sort(), ['crm_customer_create',
    'crm_lead_create', 'crm_task_create', 'crm_task_input_options', 'crm_work_memory_upsert', 'crm_zalo_broadcast_send']);
  for (const original of ALL) {
    const listed = advertisedTool(original), dropped = requiredNullable(original), properties = original.inputSchema.properties ?? {};
    assert.deepEqual(requiredNullable(listed), [], original.name);
    assert.deepEqual(listed.inputSchema.required, original.inputSchema.required?.filter(key => !dropped.includes(key)));
    assert.equal(listed.inputSchema.additionalProperties, original.inputSchema.additionalProperties);
    // Every tool: required+nullable gets the hint. Read tools: the null-free shape on top; write tools: nothing else.
    const expected = Object.entries(properties).map(([key, property]) => [key, dropped.includes(key) ? withHint(property) : property])
      .map(([key, property]) => [key, readOnly(original) ? readAdvertised(property) : property]).filter(([, property]) => property !== undefined);
    assert.deepEqual(Object.keys(listed.inputSchema.properties ?? {}), expected.map(([key]) => key), original.name);
    assert.deepEqual(listed.inputSchema.properties, Object.fromEntries(expected), original.name);
    assert.equal(nullFree(listed.inputSchema), readOnly(original) || nullFree(original.inputSchema), original.name);
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

// 20/10/2026 (đo thật): Hermes upstream v0.21.6 chuẩn hoá ['string','null'] thành {"type":"string","nullable":true};
// trên đường OpenAI-compatible, gpt-6 (sol/astra) kẹt ngay sau `"cursor":` ở 6/6 lần gọi crm_read_customers.
test('20/10: read tools advertise no null at the top level; the originals, normalization and validators are untouched', () => {
  const before = JSON.stringify(DOMAIN_TOOLS);
  assert.ok(LIST_READS.length >= 13);
  for (const read of LIST_READS) {
    const listed = advertisedTool(read), { cursor, buildingId, status } = listed.inputSchema.properties, original = read.inputSchema.properties;
    assert.deepEqual(cursor, { type: 'string' }, read.name);
    assert.deepEqual(buildingId, { type: 'string', description: DOMAIN_BUILDING_HINT }, read.name);
    assert.ok(nullFree(listed.inputSchema), read.name);
    assert.ok(!JSON.stringify(listed.inputSchema).includes('uuid'), read.name);
    // status: a domain without statuses loses the property; otherwise the enum loses null and says it is omittable.
    if (original.status.enum.length === 1) assert.equal(status, undefined, read.name);
    else assert.deepEqual(status, { enum: original.status.enum.slice(1), description: OMIT }, read.name);
    assert.deepEqual(original.cursor, { type: ['string', 'null'], format: 'uuid' }, read.name);
    assert.deepEqual(original.buildingId, { type: ['string', 'null'], format: 'uuid', description: DOMAIN_BUILDING_HINT }, read.name);
    // The incident placeholders still normalize against the original and pass the unchanged validator.
    assert.deepEqual(normalizeToolArguments(read, { cursor: '', buildingId: NIL }), { cursor: null, buildingId: null }, read.name);
  }
  assert.deepEqual(domainInput('customers', normalizeToolArguments(tool('crm_read_customers'), { cursor: '', buildingId: NIL, limit: 1 })),
    domainInput('customers', { limit: 1 }));
  assert.throws(() => domainInput('customers', { status: 'ACTIVE' }), 'customers never had a status filter');
  // B5d (21/10): buildingName/roomName (tên) đứng sau buildingId; status của customers vẫn bị gỡ (enum rỗng).
  assert.deepEqual(Object.keys(advertisedTool(tool('crm_read_customers')).inputSchema.properties), ['query', 'limit', 'cursor', 'buildingId', 'buildingName', 'roomName']);
  assert.deepEqual(advertisedTool(tool('crm_read_income_expenses')).inputSchema.properties.status, { enum: ['UNAPPROVED', 'APPROVED', 'CANCELLED'], description: OMIT });
  // Non-UUID nullable fields keep their pattern/format and get the hint: a blank date would reach the validator.
  assert.deepEqual(advertisedTool(tool('crm_read_income_expenses')).inputSchema.properties.fromDate, { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: OMIT });
  assert.deepEqual(advertisedTool(tool('crm_read_occupancy_report')).inputSchema.properties.days, { type: 'integer', minimum: 1, maximum: 365, description: OMIT });
  assert.deepEqual(advertisedTool(tool('crm_read_invoice_report')).inputSchema.properties.month, { type: 'string', pattern: '^\\d{4}-\\d{2}$', description: OMIT });
  assert.deepEqual(advertisedTool(tool('crm_read_monthly_pnl')).inputSchema.properties.basis, { enum: ['accrual', 'cash'], description: OMIT });
  assert.deepEqual(advertisedTool(tool('crm_work_memory_list')).inputSchema.properties.updatedSince, { type: 'string', format: 'date-time', description: OMIT });
  // Required+nullable of a read tool: omittable (hint once) and null-free.
  const options = advertisedTool(tool('crm_task_input_options')).inputSchema;
  assert.deepEqual(options.required, ['kind', 'query', 'limit']);
  assert.deepEqual(options.properties.cursor, { type: 'string', description: OMIT });
  assert.deepEqual(options.properties.buildingId, { type: 'string', description: `${tool('crm_task_input_options').inputSchema.properties.buildingId.description} ${OMIT}` });
  // An own description of a UUID field is kept verbatim (task-follow-composition asserts it on tools/list).
  assert.deepEqual(advertisedTool(tool('crm_task_follow_list')).inputSchema.properties.assigneeUserId, { type: 'string', description: 'Chỉ dùng với role=team; khác thì bỏ qua.' });
  assert.deepEqual(advertisedTool(tool('crm_read_report_list')).inputSchema.properties.topic.enum.includes(null), false);
  for (const read of ALL.filter(readOnly)) assert.ok(nullFree(advertisedTool(read).inputSchema), read.name);
  assert.equal(JSON.stringify(DOMAIN_TOOLS), before, 'definitions are never mutated');
  // Synthetic edges: several non-null types stay a list; an enum left empty leaves `required` too; the hint is never doubled.
  const synthetic = { name: 'x', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', required: ['kind', 'mode'], properties: {
    kind: { enum: [null] }, mode: { type: ['integer', 'string', 'null'], description: OMIT }, when: { type: ['string', 'null'], format: 'date' } } } };
  assert.deepEqual(advertisedTool(synthetic).inputSchema, { type: 'object', required: [], properties: {
    mode: { type: ['integer', 'string'], description: OMIT }, when: { type: 'string', format: 'date', description: OMIT } } });
  // Not read-only: only the required-nullable path (mode omittable, hint already present), null and enum kept.
  const written = { ...synthetic.inputSchema, required: ['kind'] };
  assert.deepEqual(advertisedTool({ ...synthetic, annotations: { readOnlyHint: false } }).inputSchema, written, 'only readOnlyHint === true');
  assert.deepEqual(advertisedTool({ ...synthetic, annotations: undefined }).inputSchema, written);
});

test('write tools keep their advertised shape: only required+nullable becomes omittable', () => {
  for (const name of ['crm_room_pass_upsert', 'crm_task_create', 'crm_customer_create', 'crm_zalo_broadcast_send', 'crm_task_follow_set']) {
    const original = tool(name), listed = advertisedTool(original), dropped = requiredNullable(original);
    assert.equal(readOnly(original), false, name);
    assert.deepEqual(Object.keys(listed.inputSchema.properties), Object.keys(original.inputSchema.properties), name);
    for (const [key, property] of Object.entries(original.inputSchema.properties)) {
      assert.deepEqual(listed.inputSchema.properties[key], dropped.includes(key) ? withHint(property) : property, `${name}.${key}`);
    }
  }
  // Absent = keep, null = clear: the model must still be able to send null here.
  const upsert = advertisedTool(tool('crm_room_pass_upsert')).inputSchema.properties, original = tool('crm_room_pass_upsert').inputSchema.properties;
  for (const key of ['customerName', 'customerPhone', 'passPrice', 'availDate', 'salePolicy']) {
    assert.deepEqual(upsert[key], original[key], key); assert.ok(upsert[key].type.includes('null'), key); assert.equal(upsert[key].description, original[key].description, key);
  }
  assert.deepEqual(upsert.availDate.pattern, '^\\d{4}-\\d{2}-\\d{2}$');
  assert.deepEqual(advertisedTool(tool('crm_task_create')).inputSchema.properties.roomId, { type: ['string', 'null'], format: 'uuid', description: OMIT });
  assert.deepEqual(advertisedTool(tool('crm_task_create')).inputSchema.required, ['requestId', 'title', 'buildingId', 'jobTypeId', 'priority']);
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
  // A required nullable text field is not a UUID: the nil-UUID string is real text there.
  assert.equal(normalizeToolArguments(tool('crm_customer_create'), { notes: NIL }).notes, NIL);
  assert.deepEqual(normalizeToolArguments(tool('crm_customer_create'), { notes: ' \n' }), { notes: null, email: null });
  assert.equal(normalizeToolArguments(tool('crm_work_memory_upsert'), { expectedId: NIL }).expectedId, null);
});

// 20/10/2026 (production trace, 18 câu chuẩn): model gọi thẳng tool đọc bị ẩn, đoán tên snake_case rồi phải gọi lại:
// crm_read_monthly_pnl {from_date,to_date} → lỗi → {fromDate,toDate}; crm_read_income_expenses {start_date,end_date,type,limit:5}
// → lỗi → {fromDate,toDate,limit:50,query:''}; crm_read_invoices {limit:100} (trần 50) → lỗi. Mỗi lần lỗi ≈3–5 s.
test('B1c: read tools alias snake_case to a schema camelCase key and clamp limit; no synonym, no write tool, no advertised change', () => {
  const pnl = tool('crm_read_monthly_pnl'), invoices = tool('crm_read_invoices'), expenses = tool('crm_read_income_expenses');
  const before = JSON.stringify([pnl, invoices, expenses, advertisedTool(pnl), advertisedTool(invoices), advertisedTool(expenses)]);
  // Trace 1: the first (rejected) monthly_pnl call now reaches the validator as the second one did.
  assert.deepEqual(normalizeToolArguments(pnl, { from_date: '2026-09-01', to_date: '2026-09-30' }), { fromDate: '2026-09-01', toDate: '2026-09-30' });
  assert.deepEqual(domainInput('monthly_pnl', normalizeToolArguments(pnl, { from_date: '2026-09-01', to_date: '2026-09-30' })),
    domainInput('monthly_pnl', { fromDate: '2026-09-01', toDate: '2026-09-30' }));
  assert.throws(() => domainInput('monthly_pnl', { from_date: '2026-09-01', to_date: '2026-09-30' }), 'the validator itself is unchanged');
  // Trace 2: synonyms are not guessed; start_date/end_date/type stay unknown keys and the call stays invalid.
  const guessed = { start_date: '2026-09-01', end_date: '2026-09-30', type: 'EXPENSE', limit: 5 };
  assert.deepEqual(normalizeToolArguments(expenses, guessed), guessed);
  assert.throws(() => domainInput('income_expenses', normalizeToolArguments(expenses, guessed)));
  // Trace 3: an integer limit beyond the schema bound is clamped to the bound; anything non-integer is left for the validator.
  assert.deepEqual(normalizeToolArguments(invoices, { limit: 100 }), { limit: 50 });
  assert.deepEqual(domainInput('invoices', normalizeToolArguments(invoices, { limit: 100 })), domainInput('invoices', { limit: 50 }));
  for (const [limit, expected] of [[51, 50], [1_000_000, 50], [0, 1], [-7, 1], [1, 1], [50, 50], [20, 20]]) assert.equal(normalizeToolArguments(invoices, { limit }).limit, expected, String(limit));
  for (const limit of ['100', 100.5, 2 ** 53, Number.MAX_VALUE, -Infinity, NaN, null, true, [100], {}]) assert.deepEqual(normalizeToolArguments(invoices, { limit }), { limit }, String(limit));
  assert.throws(() => domainInput('invoices', normalizeToolArguments(invoices, { limit: '100' })));
  assert.deepEqual(normalizeToolArguments(invoices, { limit: 100, offset: 5000 }), { limit: 50, offset: 5000 }, 'only limit is clamped');
  // Alias rules: only an own camelCase schema key; both present keeps camelCase and drops the snake key; aliased
  // placeholders still become null; unknown, trailing/leading-underscore and upper-case keys are untouched.
  assert.deepEqual(normalizeToolArguments(invoices, { building_id: id('2') }), { buildingId: id('2') });
  assert.deepEqual(normalizeToolArguments(invoices, { building_id: NIL, buildingId: id('1') }), { buildingId: id('1') });
  assert.deepEqual(normalizeToolArguments(invoices, { building_id: id('2'), buildingId: NIL }), { buildingId: null });
  assert.deepEqual(normalizeToolArguments(invoices, { building_id: NIL }), { buildingId: null });
  assert.deepEqual(normalizeToolArguments(invoices, { building_id: '' }), { buildingId: null });
  for (const key of ['room_id', 'foo_bar', 'query_', '_query', 'FROM_DATE', 'from__date_', 'from_dates', 'organization_id', '__proto__', 'constructor_']) {
    assert.deepEqual(normalizeToolArguments(invoices, { [key]: 'x' }), { [key]: 'x' }, key);
  }
  assert.deepEqual(normalizeToolArguments(pnl, { from__date: '2026-09-01' }), { fromDate: '2026-09-01' }, 'repeated underscores collapse');
  assert.deepEqual(normalizeToolArguments(invoices, { from_date: '2026-09-01' }), { from_date: '2026-09-01' }, 'a key the tool does not have is never aliased');
  assert.deepEqual(normalizeToolArguments(tool('crm_read_occupancy_report'), { report: 'upcoming', from_date: '2026-10-01', days: 10 }), { report: 'upcoming', fromDate: '2026-10-01', days: 10 });
  // Accessors travel as descriptors: an aliased getter is neither read nor dropped (the validator rejects it as before).
  let reads = 0;
  const accessor = Object.defineProperty({ limit: 100 }, 'from_date', { enumerable: true, get() { reads += 1; return '2026-09-01'; } });
  const shaped = normalizeToolArguments(pnl, accessor);
  assert.equal(reads, 0); assert.equal(typeof Object.getOwnPropertyDescriptor(shaped, 'fromDate').get, 'function'); assert.equal(Object.hasOwn(shaped, 'from_date'), false);
  assert.equal(shaped.limit, 50); assert.throws(() => domainInput('monthly_pnl', shaped));
  const bare = Object.assign(Object.create(null), { to_date: '2026-09-30', limit: 99 });
  const bareShaped = normalizeToolArguments(pnl, bare);
  assert.equal(Object.getPrototypeOf(bareShaped), null); assert.deepEqual({ ...bareShaped }, { toDate: '2026-09-30', limit: 50 }); assert.deepEqual({ ...bare }, { to_date: '2026-09-30', limit: 99 });
  // The read task tool (readOnlyHint) takes the same aliases; every write tool keeps its arguments byte for byte.
  assert.deepEqual(normalizeToolArguments(tool('crm_task_follow_list'), { role: 'team', assignee_user_id: id('3'), limit: 99 }), { role: 'team', assigneeUserId: id('3'), limit: 50 });
  assert.deepEqual(taskActionInput('list', normalizeToolArguments(tool('crm_task_follow_list'), { role: 'team', assignee_user_id: id('3'), limit: 99 })),
    { role: 'team', assigneeUserId: id('3'), status: 'open', limit: 50, offset: 0 });
  const create = { requestId: id('3'), title: 'x', description: null, building_id: id('4'), roomId: null, jobTypeId: id('5'), priority: 'NORMAL', assigneeId: null, deadline: null };
  assert.deepEqual(normalizeToolArguments(tool('crm_task_create'), create), create);
  assert.throws(() => taskActionInput('create', normalizeToolArguments(tool('crm_task_create'), create)));
  const follow = { requestId: id('3'), job_id: id('5'), objective: 'x' };
  assert.deepEqual(normalizeToolArguments(tool('crm_task_follow_set'), follow), follow);
  assert.throws(() => taskActionInput('set', normalizeToolArguments(tool('crm_task_follow_set'), follow)));
  assert.deepEqual(normalizeToolArguments(tool('crm_work_memory_upsert'), { key: 'k', expected_version: 1 }).expected_version, 1);
  for (const write of ALL.filter(value => !readOnly(value))) assert.equal(Object.hasOwn(normalizeToolArguments(write, { limit: 10 ** 6, building_id: id('4') }), 'building_id'), true, write.name);
  // Nil/blank UUID behaviour of the 16/10 fix is unchanged next to the aliases.
  assert.deepEqual(normalizeToolArguments(tool('crm_read_customers'), { cursor: NIL, buildingId: ' ', limit: 100 }), { cursor: null, buildingId: null, limit: 50 });
  assert.deepEqual(normalizeToolArguments(tool('crm_task_input_options'), { kind: 'buildings', query: '', limit: 500 }), { kind: 'buildings', query: '', limit: 50, buildingId: null, cursor: null });
  // No read tool owns a snake_case property, so an alias can never shadow a real key (a new tool with one must revisit the rule).
  for (const read of ALL.filter(readOnly)) for (const key of Object.keys(read.inputSchema.properties ?? {})) assert.equal(key.includes('_'), false, `${read.name}.${key}`);
  // Neither the originals nor the advertised definitions moved: tools/list keeps its bytes (budget test below).
  assert.equal(JSON.stringify([pnl, invoices, expenses, advertisedTool(pnl), advertisedTool(invoices), advertisedTool(expenses)]), before);
  assert.deepEqual(Object.keys(advertisedTool(pnl).inputSchema.properties), Object.keys(pnl.inputSchema.properties));
  assert.equal(JSON.stringify(advertisedTool(pnl)).includes('from_date'), false);
});

test('B1c: the broker applies the read aliases before its validators; write tools and synonyms still fail as before', async t => {
  const { broker, seen, token } = brokerFixture(t);
  assert.equal((await broker.callTool(token, 'crm_read_monthly_pnl', { from_date: '2026-09-01', to_date: '2026-09-30' })).isError, false);
  assert.deepEqual(seen, [['monthly_pnl', domainInput('monthly_pnl', { fromDate: '2026-09-01', toDate: '2026-09-30' })]]);
  seen.length = 0;
  assert.equal((await broker.callTool(token, 'crm_read_invoices', { limit: 100, building_id: NIL })).isError, false);
  assert.deepEqual(seen, [['invoices', domainInput('invoices', { limit: 50 })]]);
  seen.length = 0;
  await assert.rejects(broker.callTool(token, 'crm_read_income_expenses', { start_date: '2026-09-01', end_date: '2026-09-30', type: 'EXPENSE', limit: 5 }),
    error => error.code === 'invalid_request' && error.status === 400);
  await assert.rejects(broker.callTool(token, 'crm_task_create', { requestId: id('3'), title: 'x', description: null, building_id: id('4'), roomId: null, jobTypeId: id('5'), priority: 'NORMAL', assigneeId: null, deadline: null }),
    error => error.code === 'invalid_request' && error.status === 400);
  assert.deepEqual(seen, []);
});

// R2b 21/10/2026 (full50c: 6/17 lời gọi bị schema từ chối vì trạng thái sai chữ — 'liquidated', 'overdue', 'approved',
// 'pending', 'OPEN' ×2): tool đọc đổi `status` cấp một thành đúng phần tử enum của CHÍNH tool đó — không phân biệt hoa
// thường, rồi bốn từ đồng nghĩa cố định khi đích có trong enum. Hermes kiểm schema quảng bá (enum) trước khi gọi connector,
// nên đây là lưới thứ hai cho client không tự kiểm; tools/list không đổi (định nghĩa gốc và bản quảng bá giữ nguyên).
test('R2b: read tools alias a status to a member of their own enum; anything else reaches the validator unchanged', () => {
  const before = JSON.stringify([...ALL, ...ALL.map(advertisedTool)]);
  for (const [name, status, expected] of [
    ['crm_read_contracts', 'active', 'ACTIVE'], ['crm_read_contracts', ' Terminated ', 'TERMINATED'], ['crm_read_contracts', 'liquidated', 'TERMINATED'],
    ['crm_read_income_expenses', 'approved', 'APPROVED'], ['crm_read_income_expenses', 'pending', 'UNAPPROVED'], ['crm_read_meter_readings', 'PENDING', 'UNAPPROVED'],
    ['crm_read_tasks', 'OPEN', 'IN_PROGRESS'], ['crm_read_tasks', 'completed', 'COMPLETED'], ['crm_task_follow_list', 'OPEN', 'open'],
    ['crm_read_receivables', 'overdue', 'OVERDUE'], ['crm_read_receivables', 'partial_paid', 'PARTIAL_PAID'], ['crm_read_invoice_report', 'UNPAID', 'unpaid'],
    ['crm_read_contract_search', 'expiring', 'EXPIRING'], ['crm_read_contract_search', 'liquidated', 'TERMINATED'], ['crm_read_leads', 'converted', 'CONVERTED'],
    // No member to name: unchanged for the validator (pending of invoice_report, open of contracts, a tool without statuses).
    ['crm_read_invoice_report', 'pending', 'pending'], ['crm_read_contracts', 'open', 'open'], ['crm_read_contracts', 'expiring', 'expiring'],
    ['crm_read_customers', 'active', 'active'], ['crm_read_contracts', 'ACTIVE', 'ACTIVE'], ['crm_read_contracts', '', ''], ['crm_read_contracts', 'đang ở', 'đang ở']])
    assert.deepEqual(normalizeToolArguments(tool(name), { status, limit: 5 }), { status: expected, limit: 5 }, `${name} ${JSON.stringify(status)}`);
  assert.deepEqual(domainInput('contracts', normalizeToolArguments(tool('crm_read_contracts'), { status: 'liquidated' })), domainInput('contracts', { status: 'TERMINATED' }));
  assert.throws(() => domainInput('contracts', { status: 'liquidated' }), 'the validator itself is unchanged');
  // Non-strings, accessors (never read), nested params.status of crm_read_report and write tools stay exactly as sent.
  for (const status of [null, 5, true, ['ACTIVE'], { value: 'ACTIVE' }]) assert.deepEqual(normalizeToolArguments(tool('crm_read_contracts'), { status }), { status }, JSON.stringify(status));
  let reads = 0;
  const accessor = Object.defineProperty({}, 'status', { enumerable: true, get() { reads += 1; return 'active'; } });
  assert.equal(typeof Object.getOwnPropertyDescriptor(normalizeToolArguments(tool('crm_read_contracts'), accessor), 'status').get, 'function'); assert.equal(reads, 0);
  assert.deepEqual(normalizeToolArguments(tool('crm_read_report'), { report: 'vehicles', params: { status: 'active' } }), { report: 'vehicles', params: { status: 'active' } });
  const written = { name: 'w', annotations: { readOnlyHint: false }, inputSchema: { type: 'object', properties: { status: { enum: ['ACTIVE'] } } } };
  assert.deepEqual(normalizeToolArguments(written, { status: 'active' }), { status: 'active' });
  assert.deepEqual(normalizeToolArguments({ ...written, annotations: { readOnlyHint: true } }, { status: 'active' }), { status: 'ACTIVE' });
  assert.equal(JSON.stringify([...ALL, ...ALL.map(advertisedTool)]), before, 'definitions and advertised schemas are untouched');
});

test('R2b: the broker applies the status alias before its validators; a word with no member still fails as before', async t => {
  const { broker, seen, token } = brokerFixture(t);
  assert.equal((await broker.callTool(token, 'crm_read_contracts', { status: 'liquidated', limit: 50 })).isError, false);
  assert.equal((await broker.callTool(token, 'crm_read_income_expenses', { status: 'approved', fromDate: '2026-10-01', toDate: '2026-10-21' })).isError, false);
  assert.deepEqual(seen, [['contracts', domainInput('contracts', { status: 'TERMINATED', limit: 50 })],
    ['income_expenses', domainInput('income_expenses', { status: 'APPROVED', fromDate: '2026-10-01', toDate: '2026-10-21' })]]);
  seen.length = 0;
  await assert.rejects(broker.callTool(token, 'crm_read_invoice_report', { report: 'search', status: 'pending' }), error => error.code === 'invalid_request' && error.detail === undefined);
  assert.deepEqual(seen, []);
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
});

test('16/10 19:44Z: read tools say query is a row text filter, buildingId is not the company id, [] is final', () => {
  // 17/10 rút gọn (tools/list ≤ ngân sách) nhưng giữ đủ ba ý của sự cố. 21/10 (B5d): hint `query` theo cột SQL
  // thật của từng miền thay cho một câu chung hứa "(tên, phòng, mã)" (audit L1); buildingName/roomName là tên.
  const EMPTY = EMPTY_RESULT_HINT;
  assert.match(EMPTY, /^Rỗng sau lọc đúng = không có\.$/);
  assert.match(DOMAIN_BUILDING_HINT, /^ID toà \(không phải công ty\)\.$/);
  assert.match(BUILDING_NAME_HINT, /thay buildingId\.$/); assert.match(ROOM_NAME_HINT, /lọc trang/);
  for (const [operation, hint] of Object.entries(READ_QUERY_HINTS)) assert.ok(/^[^\s].{6,70}\.$/u.test(hint) && !/\(tên, phòng, mã\)/.test(hint), operation);
  for (const read of LIST_READS) {
    const listed = advertisedTool(read), { query, buildingId, buildingName, roomName } = listed.inputSchema.properties, operation = domainOperation(read.name);
    assert.ok(listed.description.endsWith(`. ${EMPTY}`), read.name);
    assert.equal(query.description, READ_QUERY_HINTS[operation], read.name);
    assert.equal(buildingId.description, DOMAIN_BUILDING_HINT, read.name);
    // Tên: chuỗi thuần (không maxLength quảng bá — splitReadNames chặn 120/60; không null, không format).
    assert.deepEqual(buildingName, { type: 'string', description: BUILDING_NAME_HINT }, read.name);
    assert.deepEqual(roomName, READ_NAMES[operation].room === 'rows' ? { type: 'string', description: ROOM_NAME_HINT } : undefined, read.name);
    // Text only here; since 20/10 the advertised read shape is null-free and format-free (validators unchanged).
    assert.deepEqual([query.type, query.maxLength, buildingId.type, buildingId.format], ['string', 200, 'string', undefined], read.name);
    assert.deepEqual([read.inputSchema.properties.buildingId.type, read.inputSchema.properties.buildingId.format], [['string', 'null'], 'uuid'], read.name);
  }
  const options = advertisedTool(tool('crm_task_input_options'));
  assert.ok(options.description.endsWith(` ${EMPTY}`));
  assert.match(options.inputSchema.properties.query.description, /^Lọc theo tên/);
  // 22/10 (câu 29): buildingId is required only for kind=rooms (the advertised OMIT now reads true for every other kind);
  // the first sentence (≤60 characters, tool_search shows that much) carries the ASCII keywords.
  assert.equal(options.inputSchema.properties.buildingId.description, `Chỉ kind=rooms (bắt buộc): id toà từ kind=buildings, không phải ID công ty. ${OMIT}`);
  assert.match(options.description, /^Task assign IDs: buildings, rooms, jobTypes, assignees\. Chỉ kind=rooms cần buildingId/);
  assert.ok([...options.description.split('. ')[0]].length <= 60 && /^[\x20-\x7e]+$/.test(options.description.split('. ')[0]));
  assert.doesNotMatch(options.description, /assignees cần buildingId|jobTypes, assignees cần/);
});

// P2-1 (review 85280779): kết nối đủ quyền thấy MỌI họ tool cùng lúc (cả crm_available_rooms,
// nhóm Zalo, sửa/huỷ việc). Trước 17/10 tools/list dùng chung trần dữ liệu 65 536 B: vượt là mất cả danh sách.
// Từ 17/10 tools/list có trần riêng TOOLS_LIST_MAX_BYTES (192 KiB); tools/call giữ 65 536 B (server.mjs).
// Ngân sách 64 000 B vẫn giữ để connector bản cũ (một trần chung) nhận đủ danh sách.
// 85280779: 67 988 B (đã vượt); rút họ đọc: 63 743 B; rút chữ requestId (15 tool): 62 168 B.
// Gói Z 18/10/2026 (tích hợp đợt 2: Gói 0 + A + B + C + D + Z, hai tool meta crm_read_report_list/crm_read_report):
// 65 tool, 63 654 B. Rào chữ công khai sau khi đọc dữ liệu riêng (crm_room_pass_upsert: confirmToken + một câu, +187 B):
// 63 841 B. Rào chuyển sang luôn xác nhận hai bước (bỏ phụ thuộc dấu đọc riêng, rút một câu): 63 838 B — còn
// 162 B tới trần chung. 20/10 tool đọc không null (bỏ format uuid, bỏ status enum [null], OMITTABLE trừ UUID):
// 63 554 B; mô tả crm_read_customers theo HĐ đang hiệu lực: 63 769 B — còn 231 B. 20/10 B5b: 5 tool task
// (follow_list/set/stop, progress, cancel) bỏ organizationId khỏi properties + required: 62 619 B — còn 1 381 B.
// B1c (alias snake_case + kẹp limit) chỉ đổi normalizeToolArguments, không đổi một byte tools/list. B5c 21/10:
// crm_read_receivables thêm "; có tên toà — gom theo toà khi nhiều phòng" (+52 B): 62 671 B — còn 1 329 B. Trần tổng giữ
// 64 000 B (connector bản cũ một trần 65 536 B); thêm tool hoặc mô tả mới phải rút chỗ khác, không nâng trần này.
// Trước R2b (e2c525c88, sau B5d tên toà/phòng): 63 926 B — còn 74 B. R2b 21/10 (chọn đúng tool, câu đầu ≤ 60 ký tự vì danh sách
// tool_search của Hermes chỉ hiện chừng đó): C1 crm_available_rooms tiếng Anh → tiếng Việt gọn −155 B, C4 crm_read_customers
// −58 B; định tuyến contracts +91, assets +27, income_expenses −11, pending_approvals +10; hai tool meta W2 mang mã báo cáo
// ASCII cho tool_search (report_list −50, report +39; trần riêng 1 600 B ở wave2-registry.test.mjs): 63 819 B — còn 181 B.
// Hint invalid_request (read-misuse-hints.mjs) và alias trạng thái (normalizeToolArguments) không đổi một byte tools/list.
// Trước 22/10: 63 832 B (tập đang quảng bá thật, registry tắt 3 tool phiếu chi + crm_task_cancel: 61 tool, 59 739 B). 22/10
// (câu 29) crm_task_input_options: câu đầu ASCII "Task assign IDs: …" (55 ký tự), buildingId chỉ bắt buộc với rooms −31 B:
// 63 801 B — còn 199 B (tập thật 59 708 B). Câu hướng dẫn khi gọi sai (TASK_OPTIONS_HINTS) không đổi byte tools/list.
// fullGrantBroker: full-grant-broker.fixture.mjs (dùng chung với tool-plan.test.mjs).
const TOOLS_LIST_BUDGET = 64_000;

test('tools/list of a connection holding every grantable key lists every family and stays inside the budget', async t => {
  const { broker, token } = fullGrantBroker(t);
  const listed = (await broker.listTools(token)).tools, names = listed.map(value => value.name);
  // Hai tool meta đợt 2 chỉ hiện khi sổ báo cáo (wave2-registry) có ít nhất một báo cáo; khi đó
  // chúng nằm trong phép đo byte dưới đây (Gói 0 ước +1 488 B).
  const expected = [...ALL.filter(value => !['crm_room_schedule_create', 'crm_room_schedule_update'].includes(value.name) &&
    (W2.permissions.length > 0 || !W2_TOOL_NAMES.includes(value.name))).map(value => value.name), 'crm_auth_context', 'crm_available_rooms'];
  assert.deepEqual([...names].sort(), [...new Set(expected)].sort(), 'every family, every non-retired tool');
  const bytes = Buffer.byteLength(JSON.stringify({ tools: listed }));
  t.diagnostic(`tools/list ${listed.length} tools, ${bytes} bytes`);
  assert.ok(bytes <= TOOLS_LIST_BUDGET, `tools/list ${bytes} bytes > ${TOOLS_LIST_BUDGET}`);
  // Họ đọc đầy đủ v3 (10 tool) giữ mô tả gọn: ý riêng tư + ý chọn đúng tool.
  const full = listed.filter(value => ['crm_read_customers', 'crm_read_occupancy', 'crm_read_customer_detail', 'crm_read_contract_detail', 'crm_read_occupancy_report',
    'crm_read_invoice_report', 'crm_read_monthly_pnl', 'crm_read_pending_approvals', 'crm_read_zalo_conversations', 'crm_read_contract_search'].includes(value.name));
  assert.equal(full.length, 10);
  // 21/10 (B5d): +buildingName trên 4 báo cáo và customers, +roomName trên customers/invoice_report/contract_search, hint query
  // theo SQL thật ⇒ đo 10 518 B; trần nâng 10 000 → 11 000 B (tổng tools/list vẫn ≤ 64 000 B ở phép đo trên).
  assert.ok(Buffer.byteLength(JSON.stringify(full)) <= 11_000, 'full-read family stays compact');
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
  // confirmToken (rào chữ công khai) là chuỗi thường: không bị đổi thành null, broker tách nó trước roomPassInput.
  assert.deepEqual(upsert.inputSchema.properties.confirmToken, { type: 'string' });
  assert.deepEqual(normalizeToolArguments(upsert, { ...base, confirmToken: '' }), { ...base, confirmToken: '' });
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
    customers: port('prepareCustomerAction', 'finalizeCustomerAction'),
    schedules: port('prepareSchedule', 'finalizeSchedule'), workMemory: port('prepareMemory', 'finalizeMemory'),
    zaloBroadcasts: port('prepareZaloBroadcast', 'finalizeZaloBroadcast'),
  });
  return { broker, seen, token: `hc_${'A'.repeat(43)}` };
}

test('broker tools/list advertises no required nullable field across mounted families', async t => {
  const { broker, token } = brokerFixture(t);
  const listed = (await broker.listTools(token)).tools;
  for (const name of ['crm_task_input_options', 'crm_task_create', 'crm_customer_create', 'crm_lead_create',
    'crm_work_memory_upsert', 'crm_read_customers', 'crm_room_pass_upsert', 'crm_room_schedule_list', 'crm_zalo_broadcast_send', 'crm_zalo_broadcast_update', 'crm_new_request_id']) {
    assert.ok(listed.some(value => value.name === name), name);
  }
  for (const value of listed) assert.deepEqual(requiredNullable(value), [], value.name);
  assert.equal(listed.filter(value => value.name.startsWith('crm_read_')).length,
    DOMAIN_TOOLS.length - (W2.permissions.length > 0 ? 0 : W2_TOOL_NAMES.length), 'mọi tool đọc; meta đợt 2 khi đã có báo cáo');
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
  // A placeholder never stands in for a needed id: rooms is refused before any backend call. Since 22/10 (câu 29) the
  // refusal is an ordinary result carrying one static hint (Hermes pauses the MCP server after three isError results).
  seen.length = 0;
  const refused = await broker.callTool(token, 'crm_task_input_options', { ...INCIDENT, kind: 'rooms' });
  assert.equal(refused.isError, false);
  assert.deepEqual(JSON.parse(refused.content[0].text), { ok: false, code: 'invalid_request', huongDan: TASK_OPTIONS_HINTS.rooms });
  assert.deepEqual(seen, []);
  // ... while job types and assignees are company-wide: the placeholder is the null SQL answers without a building.
  for (const kind of ['jobTypes', 'assignees']) {
    seen.length = 0;
    assert.equal((await broker.callTool(token, 'crm_task_input_options', { ...INCIDENT, kind })).isError, false);
    assert.deepEqual(seen, [['options', { ...INCIDENT, kind, buildingId: null, cursor: null }]]);
  }
  seen.length = 0;
  await broker.callTool(token, 'crm_read_customers', { cursor: NIL, buildingId: ' ', limit: 5 });
  assert.deepEqual(seen, [['customers', domainInput('customers', { limit: 5 })]]);
  seen.length = 0;
  const base = { requestId: id('5'), roomId: id('6') };
  await broker.callTool(token, 'crm_room_pass_upsert', { ...base, customerName: '  ', customerPhone: '' });
  await broker.callTool(token, 'crm_room_pass_upsert', { ...base, customerName: null });
  assert.deepEqual(seen, [['upsert', base], ['upsert', { ...base, customerName: null }]]);
});
