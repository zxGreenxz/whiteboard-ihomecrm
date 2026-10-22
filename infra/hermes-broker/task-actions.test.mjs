import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createActionCatalog, validateActionParams } from './action-catalog.mjs';
import { createActionRuntime } from './action-runtime.mjs';
import { ACTION_REASONS } from './action-reasons.mjs';
import { nameUnresolvedDetail } from './action-contract.mjs';
import { TASK_ACTIONS, TASK_CREATE, TASK_RETIRED_OPERATIONS } from './task-actions-contract.mjs';
import { TASK_TOOLS } from './task-contract.mjs';
import { TASK_INPUT_TOOLS } from './task-input-contract.mjs';
import { TASK_FOLLOW_TOOLS } from './task-follow-contract.mjs';
import { createTaskAuth } from './task-adapter.mjs';
import { fullGrantBroker } from './full-grant-broker.fixture.mjs';

// Trang Công việc, Mốc 2 (CONG-VIEC-THAO-TAC-GHI.md mục 2, 7): danh mục task.create, kiểu giờ, why unspecified (Q31), lý do hạn mức
// khớp seed SQL, tool tạo việc cũ ẩn + bị từ chối khi danh mục có task.create, một nguồn quyền cho tasks.create (CV1), byte.
const TASK_KEY = 'tasks.create';
const B = '00000000-0000-4000-8000-0000000000b1';
const effective = { read: [], action: [TASK_KEY] };
const content = result => JSON.parse(result.content[0].text);
const bytesOf = tools => Buffer.byteLength(JSON.stringify({ tools }));
const seedSql = () => { const [name] = readdirSync('supabase/migrations').filter(file => /^\d{14}_hermes_task_action_create_v1\.sql$/.test(file));
  return readFileSync(`supabase/migrations/${name}`, 'utf8'); };

test('catalog: task.create under tasks.create, reversible (server decides confirm), page task, params incl. time; listing', () => {
  assert.deepEqual([TASK_CREATE.id, TASK_CREATE.key, TASK_CREATE.class, TASK_CREATE.page, TASK_CREATE.rpc],
    ['task.create', 'tasks.create', 'reversible', 'task', 'hermes_task_action_v1']);
  assert.ok(TASK_CREATE.title.length <= 120);
  const catalog = createActionCatalog(TASK_ACTIONS);
  const [listed] = catalog.listing(effective);
  assert.equal(listed.confirm, 'if_required');
  assert.deepEqual(Object.entries(listed.params).filter(([, spec]) => spec.required).map(([name]) => name), ['content']);
  assert.deepEqual([listed.params.deadlineTime.type, listed.params.jobType.type, listed.params.priority.values], ['time', 'name', ['NORMAL', 'URGENT', 'LOW']]);
  assert.deepEqual(catalog.listing({ read: [], action: [] }), []);
  assert.deepEqual([...TASK_RETIRED_OPERATIONS], ['create', 'status', 'options']);
});

test('params: time HH:MM only; snake_case accepted; content required; static hint never echoes values', () => {
  const ok = validateActionParams(TASK_CREATE, { building_name: 'Toà A', content: 'sửa vòi', deadline: '2026-10-25', deadline_time: '17:00' });
  assert.deepEqual(ok, { ok: true, value: { buildingName: 'Toà A', content: 'sửa vòi', deadline: '2026-10-25', deadlineTime: '17:00' } });
  for (const bad of ['25:00', '5pm', '17h', '7:00']) {
    const refused = validateActionParams(TASK_CREATE, { content: 'x', deadlineTime: bad });
    assert.equal(refused.ok, false, bad);
    assert.match(refused.detail, /deadlineTime \(giờ HH:MM \(giờ Việt Nam\)\)/);
    assert.ok(!refused.detail.includes(bad), 'không nhắc lại giá trị đã gửi');
  }
  assert.equal(validateActionParams(TASK_CREATE, { buildingName: 'Toà A' }).ok, false, 'thiếu content');
});

test('quota reasons: static texts carry the seeded limits of hermes_task_limits (change seed ⇒ change text)', () => {
  const seed = seedSql().match(/VALUES\(NULL,'member',(\d+),(\d+)\),\(NULL,'owner',(\d+),(\d+)\)/);
  assert.ok(seed, 'seed hạn mức có trong migration');
  const [, memberActor, memberPair, ownerActor, ownerPair] = seed;
  assert.match(ACTION_REASONS.task_quota_user.text, new RegExp(`mặc định ${memberActor} việc/giờ; chủ sở hữu ${ownerActor}\\)`));
  assert.match(ACTION_REASONS.task_quota_pair.text, new RegExp(`mặc định ${memberPair} việc/giờ; chủ sở hữu ${ownerPair}\\)`));
  assert.deepEqual([ACTION_REASONS.task_quota_user.form, ACTION_REASONS.task_quota_pair.form], ['rejected', 'rejected']);
});

test('why unspecified (Q31): detail lists suggestions or asks plainly; non-empty wanted with unspecified is refused', async () => {
  assert.equal(nameUnresolvedDetail({ field: 'person', wanted: '', why: 'unspecified', candidates: [{ name: 'Nathan' }, { name: 'Joey' }] }),
    'Chưa nêu người; gợi ý: Nathan, Joey — hỏi người dùng chọn một, không tự chọn.');
  assert.equal(nameUnresolvedDetail({ field: 'jobType', wanted: '', why: 'unspecified' }), 'Chưa nêu loại việc; hỏi người dùng.');
  const outcomes = [];
  const service = { async prepareAction() { return Object.freeze({}); }, async finalizeAction() { return outcomes.shift(); } };
  const runtime = createActionRuntime({ catalog: createActionCatalog(TASK_ACTIONS), service });
  const identity = { row: { id: '00000000-0000-4000-8000-000000000001', organizationId: '00000000-0000-4000-8000-000000000002' }, effective };
  const run = async params => {
    const plan = runtime.begin(runtime.route('crm_action_run'), { action: 'task.create', params });
    const receipt = await runtime.handle(plan, 'token', identity);
    return runtime.finish(plan, 'token', receipt, identity);
  };
  outcomes.push({ kind: 'needs_input', reason: 'name_unresolved', field: 'person', wanted: '', why: 'unspecified', candidates: [{ name: 'Nathan' }], more: false });
  const asked = await run({ buildingName: 'Toà B', content: 'khoá cửa' });
  assert.equal(asked.isError, false);
  assert.deepEqual(content(asked).candidates, [{ name: 'Nathan' }]);
  assert.match(content(asked).detail, /^Chưa nêu người; gợi ý: Nathan/);
  outcomes.push({ kind: 'needs_input', reason: 'name_unresolved', field: 'person', wanted: 'Nathan', why: 'unspecified', candidates: [], more: false });
  await assert.rejects(run({ buildingName: 'Toà B', content: 'khoá cửa' }), error => error.code === 'backend_unavailable');
  outcomes.push({ kind: 'applied', result: { text: 'Đã tạo việc' }, link: '/tasks?job=00000000-0000-4000-8000-000000000009' });
  assert.equal(content(await run({ buildingName: 'Toà A', content: 'sửa vòi', assigneeName: 'tôi' })).outcome, 'applied', 'reversible tự giao: một lượt');
});

test('broker: task.create in the catalog retires crm_task_create/status/input_options (hidden and refused); follow tools stay', async t => {
  const service = { async prepareAction() { return Object.freeze({}); }, async finalizeAction() { return { kind: 'applied', result: {} }; } };
  const legacy = [...TASK_TOOLS, ...TASK_INPUT_TOOLS].map(tool => tool.name).filter(name => ['crm_task_create', 'crm_task_status', 'crm_task_input_options'].includes(name));
  assert.equal(legacy.length, 3);
  const before = fullGrantBroker(t);
  const beforeNames = (await before.broker.listTools(before.token)).tools.map(tool => tool.name);
  assert.ok(legacy.every(name => beforeNames.includes(name)), 'không có danh mục Công việc: tool cũ còn hiện');
  const after = fullGrantBroker(t, undefined, { actions: createActionRuntime({ catalog: createActionCatalog(TASK_ACTIONS), service }), actionKeys: [TASK_KEY] });
  const listed = (await after.broker.listTools(after.token)).tools, names = listed.map(tool => tool.name);
  assert.deepEqual(names.filter(name => legacy.includes(name)), []);
  for (const name of ['crm_action_list', 'crm_action_run', 'crm_action_status']) assert.ok(names.includes(name), name);
  for (const tool of TASK_FOLLOW_TOOLS) assert.ok(names.includes(tool.name), `${tool.name} còn hiện`);
  for (const name of legacy) await assert.rejects(after.broker.callTool(after.token, name, {}), error => error.code === 'tool_not_available', name);
  const bytes = bytesOf(listed), beforeBytes = bytesOf((await before.broker.listTools(before.token)).tools);
  t.diagnostic(`tools/list đủ quyền: trước ${beforeBytes} B, sau ${bytes} B`);
  assert.ok(bytes <= 64_000 && bytes < beforeBytes);
  // Như production 22/10: registry tắt income_expenses.create (họ phiếu chi cũ) và tasks.delete (huỷ việc cũ).
  const now = fullGrantBroker(t, undefined, { actions: createActionRuntime({ catalog: createActionCatalog(TASK_ACTIONS), service }), actionKeys: [TASK_KEY],
    withoutAction: ['income_expenses.create', 'tasks.delete'] });
  const nowBefore = fullGrantBroker(t, undefined, { withoutAction: ['income_expenses.create', 'tasks.delete'] });
  const nowBytes = bytesOf((await now.broker.listTools(now.token)).tools), nowBeforeBytes = bytesOf((await nowBefore.broker.listTools(nowBefore.token)).tools);
  t.diagnostic(`như production 22/10: trước ${nowBeforeBytes} B, sau ${nowBytes} B (chênh ${nowBytes - nowBeforeBytes} B)`);
  assert.ok(nowBytes < nowBeforeBytes, 'họ thao tác (≈1,96 KB) nhỏ hơn bốn tool cũ được gỡ (≈3,9 KB)');
});

test('createTaskAuth createFromActions (CV1): tasks.create from the shared action layer is kept, follow keys added, no context_changed', async () => {
  const input = { accessToken: 'x', organizationId: '00000000-0000-4000-8000-000000000002', userId: '00000000-0000-4000-8000-000000000003', signal: undefined };
  const current = { permissions: { read: [], action: [TASK_KEY] }, companyCeilings: { read: [], action: [TASK_KEY] }, scopesByPermission: { [TASK_KEY]: { buildingIds: [B], cashbookIds: [] } },
    membership: { membershipId: 'm', authorizationVersion: 1 }, isSuperadmin: false, epoch: 'e' };
  const baseAuth = { verifySession: async () => ({}), readAuthorization: async () => current };
  let createRead = 0;
  const follow = { organizationId: input.organizationId, userId: input.userId, membershipId: 'm', authorizationVersion: 1, isSuperadmin: false, policyVersion: 1,
    permissions: { 'tasks.edit': { allowed: true, companyEnabled: true, buildingIds: [B] }, 'tasks.delete': { allowed: false, companyEnabled: false, buildingIds: [] },
      'assistant.memory.supervise': { allowed: false, companyEnabled: false, buildingIds: [] } } };
  const reads = { capabilities: async () => { createRead++; return null; }, followCapabilities: async () => follow };
  const auth = createTaskAuth({ baseAuth, reads, createFromActions: true });
  const result = await auth.readAuthorization(input);
  assert.equal(createRead, 0, 'không đọc hermes_task_create_capabilities_v1');
  assert.deepEqual(result.permissions.action, [TASK_KEY, 'tasks.edit']);
  assert.deepEqual(result.scopesByPermission[TASK_KEY], { buildingIds: [B], cashbookIds: [] }, 'phạm vi tasks.create giữ của lớp khung chung');
  const legacy = createTaskAuth({ baseAuth, reads });
  await assert.rejects(legacy.readAuthorization(input), error => error.code === 'context_changed', 'chế độ cũ + khoá đã có ⇒ context_changed');
  const noFollow = createTaskAuth({ baseAuth, reads: {}, createFromActions: true });
  assert.equal(await noFollow.readAuthorization(input), current);
  assert.throws(() => createTaskAuth({ baseAuth, reads: {} }), /invalid_task_auth/);
});
