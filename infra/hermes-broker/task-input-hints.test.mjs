// crm_task_input_options gọi sai cách (22/10/2026, câu 29): một câu hướng dẫn tĩnh trong danh sách đóng, trả như KẾT QUẢ
// THƯỜNG (isError false) — trên TEST 21/10 Hermes tạm khoá cả MCP server ~59 s sau ba kết quả isError liền nhau. Connector
// chạy trước migration 20261021172540 nên chịu cả SQL v5: 22023 của lời gọi toàn công ty ⇒ câu hướng dẫn "legacy".
import test from 'node:test';
import assert from 'node:assert/strict';
// external-group-mount.mjs imports broker.mjs back: load it first (as full-grant-broker.fixture.mjs does).
import { EXTERNAL_GROUP_TOOLS } from './external-group-mount.mjs';
import { BrokerError, createBroker } from './broker.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
import { normalizeToolArguments } from './tool-argument-shape.mjs';
import { TASK_INPUT_TOOLS, TASK_OPTIONS_HINTS, TASK_OPTIONS_HINT_TEXTS, taskActionInput, taskOptionsHint, taskOptionsRetry, taskOptionsCompanyWide } from './task-input-contract.mjs';

void EXTERNAL_GROUP_TOOLS;
const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const TOOL = TASK_INPUT_TOOLS.find(tool => tool.name === 'crm_task_input_options');
const BUILDING = id('f'), NIL = '00000000-0000-0000-0000-000000000000';
const shaped = args => normalizeToolArguments(TOOL, args);

// One connection; `finalizeTask` decides what the CRM side answers (a value or a BrokerError).
function brokerWith(t, { action = ['tasks.create'], finalizeTask = async () => ({ ok: true }) } = {}) {
  const scope = createDependencyScope(); t.after(() => scope.close());
  const CONNECTION = id('a'), read = [], seen = [], audits = [];
  const identity = { row: { id: CONNECTION, assistantId: id('b'), userId: id('c'), organizationId: id('d'), expiresAt: Date.now() + 600_000,
    epoch: 1, state: 'active', restrictions: { read, action } }, effective: { read, action }, isSuperadmin: false,
  policyEpoch: 'a'.repeat(64), contextVersion: 'b'.repeat(64), assistantScopeIds: [id('e')],
  scopesByPermission: Object.fromEntries(action.map(key => [key, { buildingIds: [BUILDING], cashbookIds: [] }])) };
  const broker = createBroker({ authority: { identifyConnection: async () => ({ connectionId: CONNECTION }), resolve: async () => identity, checkUnchanged: async () => {} },
    dependencyScope: scope, audit: async entry => { audits.push(entry.outcome); }, limits: { maxResultBytes: 65_536 },
    tasks: { async prepareTask(_token, operation, input) { seen.push([operation, input]); return Object.freeze({}); }, finalizeTask } });
  return { broker, seen, audits, token: `hc_${'A'.repeat(43)}` };
}
const payload = result => JSON.parse(result.content[0].text);

test('static hints: closed list, ASCII parameter keywords, never the sent values, only for refused input', () => {
  assert.equal(TASK_OPTIONS_HINT_TEXTS.length, 5);
  assert.equal(new Set(TASK_OPTIONS_HINT_TEXTS).size, 5);
  for (const hint of TASK_OPTIONS_HINT_TEXTS) {
    assert.ok(hint.length <= 160 && /buildingId|kind/.test(hint), hint);
    assert.ok(Object.isFrozen(TASK_OPTIONS_HINTS));
  }
  const cases = [
    [{ kind: 'staff' }, 'kind'], [{ kind: 'Assignees', buildingId: null }, 'kind'], [{ buildingId: BUILDING }, 'kind'],
    [{ kind: 'rooms' }, 'rooms'], [{ kind: 'rooms', buildingId: NIL }, 'rooms'], [{ kind: 'rooms', buildingId: '417LVT' }, 'rooms'],
    [{ kind: 'rooms', buildingId: BUILDING.toUpperCase() }, 'rooms'],
    [{ kind: 'assignees', buildingId: '417LVT' }, 'buildingId'], [{ kind: 'jobTypes', buildingId: 'Nhà A' }, 'buildingId'],
    [{ kind: 'assignees', buildingId: 7 }, 'buildingId'],
    [{ kind: 'assignees', organizationId: id('d') }, 'input'], [{ kind: 'jobTypes', query: 'x'.repeat(101) }, 'input'],
    [{ kind: 'buildings', buildingId: 7 }, 'input'], [{ kind: 'rooms', buildingId: BUILDING, limit: '20' }, 'input'],
    [{ kind: 'assignees', cursor: 'trang-2' }, 'input'],
  ];
  for (const [args, key] of cases) {
    const value = shaped({ query: '', limit: 20, ...args });
    assert.throws(() => taskActionInput('options', value), JSON.stringify(args));
    const hint = taskOptionsHint(value);
    assert.equal(hint, TASK_OPTIONS_HINTS[key], JSON.stringify(args));
    // Free-form values never come back (kind members are the hints' own vocabulary).
    for (const sent of [args.buildingId, args.kind, args.query, args.cursor, args.organizationId]
      .filter(item => typeof item === 'string' && item.length > 3 && !TOOL.inputSchema.properties.kind.enum.includes(item)))
      assert.equal(hint.includes(sent), false, 'hint never echoes ' + sent);
  }
  // Valid company-wide calls are not refused (no hint involved).
  for (const kind of ['jobTypes', 'assignees']) assert.deepEqual(taskActionInput('options', shaped({ kind, query: '', limit: 20 })), { kind, query: '', limit: 20, buildingId: null, cursor: null });
  // Non-objects stay a plain invalid_request; accessors are never invoked; hostile proxies give no hint.
  for (const value of [undefined, null, 'rooms', 5, [], new Date(0)]) assert.equal(taskOptionsHint(value), null);
  let reads = 0;
  const getter = Object.defineProperty({ query: '', limit: 20, buildingId: null, cursor: null }, 'kind', { enumerable: true, get() { reads += 1; return 'rooms'; } });
  assert.equal(taskOptionsHint(getter), TASK_OPTIONS_HINTS.kind); assert.equal(reads, 0);
  assert.equal(taskOptionsHint(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('private'); }, has() { throw new Error('private'); } })), null);
  // The result builder only ever carries a listed sentence.
  assert.deepEqual(taskOptionsRetry(TASK_OPTIONS_HINTS.rooms), { ok: false, code: 'invalid_request', huongDan: TASK_OPTIONS_HINTS.rooms });
  for (const other of ['', 'free text', TASK_OPTIONS_HINTS.rooms + ' ', undefined]) assert.throws(() => taskOptionsRetry(other));
  // Only the validated company-wide lookup is eligible for the legacy-SQL hint.
  assert.equal(taskOptionsCompanyWide('options', { kind: 'assignees', buildingId: null }), true);
  for (const [operation, input] of [['options', { kind: 'assignees', buildingId: BUILDING }], ['options', { kind: 'rooms', buildingId: null }],
    ['options', { kind: 'buildings', buildingId: null }], ['create', { kind: 'assignees', buildingId: null }], ['options', undefined]])
    assert.equal(taskOptionsCompanyWide(operation, input), false, JSON.stringify([operation, input]));
});

test('broker: a refused lookup is an ordinary result with its hint, audited, and never reaches CRM', async t => {
  const { broker, seen, audits, token } = brokerWith(t);
  for (const [args, key] of [[{ kind: 'rooms', buildingId: NIL, query: '', limit: 20, cursor: NIL }, 'rooms'], [{ kind: 'users', query: '', limit: 20 }, 'kind'],
    [{ kind: 'assignees', buildingId: '417LVT', query: '', limit: 20 }, 'buildingId'], [{ kind: 'jobTypes', query: '', limit: 20, extra: true }, 'input']]) {
    const result = await broker.callTool(token, 'crm_task_input_options', args);
    assert.equal(result.isError, false, JSON.stringify(args));
    assert.deepEqual(payload(result), { ok: false, code: 'invalid_request', huongDan: TASK_OPTIONS_HINTS[key] });
    assert.equal(Object.hasOwn(payload(result), 'items'), false, 'never reads as an empty catalog');
  }
  assert.deepEqual(seen, []);
  assert.deepEqual(audits, ['prepared', 'prepared', 'prepared', 'prepared']);
  // A non-object stays the plain error; other task tools keep their plain invalid_request.
  await assert.rejects(broker.callTool(token, 'crm_task_input_options', 'rooms'), error => error.code === 'invalid_request');
  await assert.rejects(broker.callTool(token, 'crm_task_create', { title: 'x' }), error => error.code === 'invalid_request');
  // Company-wide lookups now reach the task port with buildingId null.
  for (const kind of ['jobTypes', 'assignees']) assert.equal((await broker.callTool(token, 'crm_task_input_options', { kind, query: '', limit: 20 })).isError, false);
  assert.deepEqual(seen.map(([, input]) => [input.kind, input.buildingId]), [['jobTypes', null], ['assignees', null]]);
});

test('broker: without tasks.create the tool stays unavailable, hint or not', async t => {
  const { broker, seen, token } = brokerWith(t, { action: [] });
  for (const args of [{ kind: 'rooms', query: '', limit: 20 }, { kind: 'assignees', query: '', limit: 20 }])
    await assert.rejects(broker.callTool(token, 'crm_task_input_options', args), error => error.code === 'tool_not_available');
  assert.deepEqual(seen, []);
});

test('broker: v5 SQL refusing a company-wide lookup (22023) becomes the legacy hint; every other refusal stays an error', async t => {
  let answer;
  const { broker, token } = brokerWith(t, { finalizeTask: async () => { throw answer; } });
  answer = new BrokerError('invalid_request');
  for (const kind of ['jobTypes', 'assignees']) {
    const result = await broker.callTool(token, 'crm_task_input_options', { kind, query: '', limit: 20 });
    assert.equal(result.isError, false);
    assert.deepEqual(payload(result), { ok: false, code: 'invalid_request', huongDan: TASK_OPTIONS_HINTS.legacy });
  }
  // With a building (or rooms) the old SQL answers as before: no hint.
  for (const args of [{ kind: 'assignees', buildingId: BUILDING, query: '', limit: 20 }, { kind: 'rooms', buildingId: BUILDING, query: '', limit: 20 }])
    await assert.rejects(broker.callTool(token, 'crm_task_input_options', args), error => error.code === 'invalid_request', JSON.stringify(args));
  // A denial, a changed context or an unknown failure is never turned into a hint.
  for (const [error, code] of [[new BrokerError('forbidden'), 'forbidden'], [new BrokerError('context_changed'), 'context_changed'], [new Error('boom'), 'backend_unavailable']]) {
    answer = error;
    await assert.rejects(broker.callTool(token, 'crm_task_input_options', { kind: 'assignees', query: '', limit: 20 }), failure => failure.code === code, code);
  }
});
