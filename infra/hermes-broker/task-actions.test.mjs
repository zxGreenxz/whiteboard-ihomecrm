import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createActionCatalog, validateActionParams } from './action-catalog.mjs';
import { createActionRuntime } from './action-runtime.mjs';
import { ACTION_REASONS } from './action-reasons.mjs';
import { nameUnresolvedDetail } from './action-contract.mjs';
import { TASK_ACTIONS, TASK_CREATE, TASK_CREATE_BATCH, TASK_BATCH_MAX, TASK_UPDATE, TASK_CANCEL, TASK_RETIRED_OPERATIONS, TASK_RETIRED_BY,
  TASK_RECURRING_CREATE, TASK_RECURRING_UPDATE, TASK_RECURRING_PAUSE, TASK_RECURRING_DELETE } from './task-actions-contract.mjs';
import { TASK_TOOLS } from './task-contract.mjs';
import { TASK_INPUT_TOOLS } from './task-input-contract.mjs';
import { TASK_FOLLOW_TOOLS } from './task-follow-contract.mjs';
import { createTaskAuth } from './task-adapter.mjs';
import { createActionAuth, createActionLiveCatalog } from './action-adapter.mjs';
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
  assert.deepEqual([...TASK_RETIRED_OPERATIONS], ['create', 'status', 'options', 'progress', 'cancel']);
  // Mốc 3: sửa dưới tasks.edit (reversible, máy chủ quyết xem trước), huỷ dưới tasks.delete (irreversible ⇒ luôn xem trước).
  assert.deepEqual([TASK_UPDATE.key, TASK_UPDATE.class, TASK_CANCEL.key, TASK_CANCEL.class], ['tasks.edit', 'reversible', 'tasks.delete', 'irreversible']);
  assert.deepEqual(TASK_RETIRED_BY, { create: 'task.create', status: 'task.create', options: 'task.create', progress: 'task.update', cancel: 'task.cancel' });
  const all = catalog.listing({ read: [], action: [TASK_KEY, 'tasks.edit', 'tasks.delete'] });
  assert.deepEqual(all.map(item => [item.action, item.confirm]), [['task.create', 'if_required'], ['task.create_batch', 'if_required'], ['task.update', 'if_required'],
    ['task.cancel', 'always'], ['task.recurring_create', 'if_required'], ['task.recurring_update', 'if_required'], ['task.recurring_pause', 'if_required'],
    ['task.recurring_delete', 'if_required']]);
  assert.deepEqual(all.slice(2, 4).map(item => Object.entries(item.params).filter(([, spec]) => spec.required).map(([name]) => name)), [['job'], ['job']]);
  // Mốc 5: việc định kỳ — tạo dưới tasks.create, sửa / tạm dừng dưới tasks.edit, xoá (mềm) dưới tasks.delete; reversible + chính sách DB
  // always (máy chủ luôn xem trước). Quy tắc là tên kiểu recurrence (mã DK-… hoặc nội dung); thứ trong tuần là danh sách oneOf.
  assert.deepEqual([TASK_RECURRING_CREATE, TASK_RECURRING_UPDATE, TASK_RECURRING_PAUSE, TASK_RECURRING_DELETE].map(action => [action.key, action.class, action.reasons]),
    [['tasks.create', 'reversible', ['recurrence_quota']], ['tasks.edit', 'reversible', ['recurrence_unchanged']],
      ['tasks.edit', 'reversible', ['recurrence_unchanged']], ['tasks.delete', 'reversible', []]]);
  assert.deepEqual(all.slice(4).map(item => Object.entries(item.params).filter(([, spec]) => spec.required).map(([name]) => name)),
    [['content', 'frequency'], ['rule'], ['rule'], ['rule']]);
  assert.equal(all[5].params.rule.hint, 'mã việc định kỳ (DK-…) hoặc nội dung như người dùng nói');
  assert.deepEqual([all[4].params.weekdays.type, all[4].params.weekdays.max, all[4].params.weekdays.item.values, all[4].params.monthDay.hint],
    ['list', 7, ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'], 'số nguyên -1–31']);
  for (const action of [TASK_RECURRING_CREATE, TASK_RECURRING_UPDATE, TASK_RECURRING_PAUSE, TASK_RECURRING_DELETE])
    assert.ok(action.title.length <= 120 && Object.keys(action.params).length <= 16, action.id);
  assert.equal(all[2].params.job.hint, 'mã việc (JOB-…, 4 số cuối) hoặc tiêu đề như người dùng nói');
  // Mốc 4: lô dưới CÙNG khoá tasks.create (chính sách DB always ⇒ máy chủ luôn xem trước); items ≤ 20 mục, mỗi mục là record có giờ hạn;
  // không tham số bắt buộc ở connector (SQL đòi đúng một trong items / buildingsManagedBy).
  assert.deepEqual([TASK_CREATE_BATCH.key, TASK_CREATE_BATCH.class, TASK_CREATE_BATCH.reasons], ['tasks.create', 'reversible', ['task_quota_user', 'task_quota_pair', 'batch_too_large']]);
  const batch = all[1].params;
  assert.deepEqual(Object.entries(batch).filter(([, spec]) => spec.required), []);
  assert.deepEqual([batch.items.type, batch.items.min, batch.items.max, batch.items.item.type, batch.items.item.fields.deadlineTime.type, batch.buildingsManagedBy.type],
    ['list', 1, TASK_BATCH_MAX, 'record', 'time', 'name']);
  assert.ok(TASK_CREATE_BATCH.title.length <= 120 && Object.keys(TASK_CREATE_BATCH.params).length <= 16);
  for (const action of [TASK_UPDATE, TASK_CANCEL]) assert.ok(action.title.length <= 120 && Object.keys(action.params).length <= 16);
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

test('broker: live task.create retires crm_task_create/status/input_options; live task.update / task.cancel retire crm_task_progress / crm_task_cancel; follow tools stay', async t => {
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
  // Mốc 3: runtime không có danh mục sống ⇒ mọi thao tác của danh mục coi là sống ⇒ tiến độ / huỷ cũ cũng nghỉ; theo dõi còn.
  for (const tool of TASK_FOLLOW_TOOLS) assert.equal(names.includes(tool.name), !['crm_task_progress', 'crm_task_cancel'].includes(tool.name), tool.name);
  for (const name of ['crm_task_progress', 'crm_task_cancel']) await assert.rejects(after.broker.callTool(after.token, name, {}), error => error.code === 'tool_not_available', name);
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

test('createTaskAuth (CV1 + review Mốc 2 mục 6): task.create sống ⇒ tasks.create của lớp khung chung; chưa sống ⇒ lớp task cũ cấp như trước', async () => {
  const input = { accessToken: 'x', organizationId: '00000000-0000-4000-8000-000000000002', userId: '00000000-0000-4000-8000-000000000003', signal: undefined };
  const fromActions = { permissions: { read: [], action: [TASK_KEY] }, companyCeilings: { read: [], action: [TASK_KEY] }, scopesByPermission: { [TASK_KEY]: { buildingIds: [B], cashbookIds: [] } },
    membership: { membershipId: 'm', authorizationVersion: 1 }, isSuperadmin: false, epoch: 'e' };
  const withoutKey = { ...fromActions, permissions: { read: [], action: [] }, companyCeilings: { read: [], action: [] }, scopesByPermission: {} };
  const follow = { organizationId: input.organizationId, userId: input.userId, membershipId: 'm', authorizationVersion: 1, isSuperadmin: false, policyVersion: 1,
    permissions: { 'tasks.edit': { allowed: true, companyEnabled: true, buildingIds: [B] }, 'tasks.delete': { allowed: false, companyEnabled: false, buildingIds: [] },
      'assistant.memory.supervise': { allowed: false, companyEnabled: false, buildingIds: [] } } };
  const legacyCap = { organizationId: input.organizationId, userId: input.userId, membershipId: 'm', authorizationVersion: 1, isSuperadmin: false, policyVersion: 1,
    allowed: true, companyEnabled: true, buildingIds: [B] };
  let legacyReads = 0;
  const reads = { capabilities: async () => { legacyReads++; return legacyCap; }, followCapabilities: async () => follow };
  const live = createActionLiveCatalog();
  // DB mới: lớp khung chung đã cấp tasks.create; lớp task chỉ thêm khoá theo dõi, bỏ qua capability cũ.
  live.observe({ 'task.create': {} });
  const alive = await createTaskAuth({ baseAuth: { verifySession: async () => ({}), readAuthorization: async () => fromActions }, reads, createFromActions: true, live })
    .readAuthorization(input);
  assert.deepEqual(alive.permissions.action, [TASK_KEY, 'tasks.edit']);
  assert.deepEqual(alive.scopesByPermission[TASK_KEY], { buildingIds: [B], cashbookIds: [] });
  assert.equal(legacyReads, 0, 'DB mới: không tốn lời gọi capability cũ (mcp-latency giữ 16 lời gọi REST)');
  // Connector mới + DB cũ: SQL chưa có dòng task.create ⇒ lớp khung chung không cấp; lớp task cấp tasks.create từ capability cũ.
  live.observe({});
  const fallback = await createTaskAuth({ baseAuth: { verifySession: async () => ({}), readAuthorization: async () => withoutKey }, reads, createFromActions: true, live })
    .readAuthorization(input);
  assert.deepEqual(fallback.permissions.action, [TASK_KEY, 'tasks.edit'], 'tạo việc và theo dõi cũ không mất');
  assert.equal(legacyReads, 1);
  // DB mất dòng task.create ngay trong lời gọi này (lớp khung chung ghi danh mục sống trống) ⇒ đọc bù capability cũ, vẫn đủ quyền.
  live.observe({ 'task.create': {} });
  const lost = await createTaskAuth({ baseAuth: { verifySession: async () => ({}), readAuthorization: async () => { live.observe({}); return withoutKey; } }, reads, createFromActions: true, live })
    .readAuthorization(input);
  assert.deepEqual(lost.permissions.action, [TASK_KEY, 'tasks.edit']);
  assert.equal(legacyReads, 2, 'đọc bù tuần tự đúng một lần');
  // Chế độ cũ mà khoá đã có từ lớp dưới ⇒ context_changed (một nguồn mỗi lời gọi).
  await assert.rejects(createTaskAuth({ baseAuth: { verifySession: async () => ({}), readAuthorization: async () => fromActions }, reads }).readAuthorization(input),
    error => error.code === 'context_changed');
  assert.throws(() => createTaskAuth({ baseAuth: { verifySession: async () => ({}), readAuthorization: async () => fromActions }, reads: {} }), /invalid_task_auth/);
  assert.throws(() => createTaskAuth({ baseAuth: { verifySession: async () => ({}), readAuthorization: async () => fromActions }, reads, live: {} }), /invalid_task_auth/);
});

test('tổ hợp connector mới + DB cũ: lớp khung chung ghi danh mục sống; task.create chưa sống ⇒ không quảng bá, tool tạo việc cũ còn; sống ⇒ ngược lại', async t => {
  const input = { accessToken: 'x', organizationId: '00000000-0000-4000-8000-000000000002', userId: '00000000-0000-4000-8000-000000000003', signal: undefined };
  const base = { permissions: { read: [], action: [] }, companyCeilings: { read: [], action: [] }, scopesByPermission: {},
    membership: { membershipId: 'm', authorizationVersion: 1 }, isSuperadmin: false, epoch: 'e' };
  const catalog = createActionCatalog(TASK_ACTIONS);
  const capability = sqlHasTask => ({ organizationId: input.organizationId, userId: input.userId, membershipId: 'm', authorizationVersion: 1, isSuperadmin: false, policyVersion: 1,
    permissions: sqlHasTask ? { [TASK_KEY]: { allowed: true, companyEnabled: true, buildingIds: [B] } } : {},
    actions: sqlHasTask ? { 'task.create': { capability: TASK_KEY, actionClass: 'reversible', confirm: 'never', privateOnly: true } } : {} });
  const live = createActionLiveCatalog();
  for (const sqlHasTask of [false, true]) {
    const auth = createActionAuth({ baseAuth: { verifySession: async () => ({}), readAuthorization: async () => base }, catalog, live,
      reads: { capabilities: async () => capability(sqlHasTask) } });
    const result = await auth.readAuthorization(input);
    assert.equal(live.has('task.create'), sqlHasTask, 'danh mục sống theo dòng SQL');
    assert.equal(result.permissions.action.includes(TASK_KEY), sqlHasTask, 'DB cũ: lớp khung chung không cấp khoá SQL chưa khai');
  }
  // RPC capability vắng hẳn (PGRST202 ⇒ null) ⇒ không thao tác nào sống.
  await createActionAuth({ baseAuth: { verifySession: async () => ({}), readAuthorization: async () => base }, catalog, live, reads: { capabilities: async () => null } })
    .readAuthorization(input);
  assert.equal(live.has('task.create'), false);
  // Broker: kết nối giữ tasks.create (DB cũ: do lớp task cũ cấp) nhưng task.create chưa sống ⇒ crm_action_* không hiện, tool cũ còn.
  const service = { async prepareAction() { return Object.freeze({}); }, async finalizeAction() { return { kind: 'applied', result: {} }; } };
  const legacy = ['crm_task_create', 'crm_task_status', 'crm_task_input_options'];
  const old = fullGrantBroker(t, undefined, { actions: createActionRuntime({ catalog, service, live }), actionKeys: [TASK_KEY] });
  const oldNames = (await old.broker.listTools(old.token)).tools.map(tool => tool.name);
  assert.ok(legacy.every(name => oldNames.includes(name)), 'DB cũ: tool tạo việc cũ còn');
  assert.ok(!oldNames.includes('crm_action_run'), 'DB cũ: không quảng bá task.create');
  await assert.rejects(old.broker.callTool(old.token, 'crm_action_run', { action: 'task.create', params: { content: 'x' } }), error => error.code === 'tool_not_available');
  live.observe({ 'task.create': {} });
  const fresh = (await old.broker.listTools(old.token)).tools.map(tool => tool.name);
  assert.ok(fresh.includes('crm_action_run') && legacy.every(name => !fresh.includes(name)), 'DB mới (cùng connector): đổi ngay ở lời gọi kế');
});

test('Mốc 3: live task.update / task.cancel retire crm_task_progress / crm_task_cancel one by one; follow layer drops tasks.edit / tasks.delete only when the replacing action is live', async t => {
  const service = { async prepareAction() { return Object.freeze({}); }, async finalizeAction() { return { kind: 'applied', result: {} }; } };
  const catalog = createActionCatalog(TASK_ACTIONS);
  const live = createActionLiveCatalog();
  const env = fullGrantBroker(t, undefined, { actions: createActionRuntime({ catalog, service, live }), actionKeys: [TASK_KEY, 'tasks.edit', 'tasks.delete'] });
  const visible = async () => { const listed = (await env.broker.listTools(env.token)).tools.map(tool => tool.name);
    return ['crm_task_progress', 'crm_task_cancel'].map(name => listed.includes(name)); };
  live.observe({ 'task.create': {} });
  assert.deepEqual(await visible(), [true, true], 'DB chưa có Mốc 3: tiến độ / huỷ cũ còn');
  live.observe({ 'task.create': {}, 'task.update': {} });
  assert.deepEqual(await visible(), [false, true]);
  await assert.rejects(env.broker.callTool(env.token, 'crm_task_progress', {}), error => error.code === 'tool_not_available');
  live.observe({ 'task.create': {}, 'task.update': {}, 'task.cancel': {} });
  assert.deepEqual(await visible(), [false, false]);
  await assert.rejects(env.broker.callTool(env.token, 'crm_task_cancel', {}), error => error.code === 'tool_not_available');

  // Lớp quyền: tasks.edit / tasks.delete chỉ một nguồn mỗi lời gọi.
  const input = { accessToken: 'x', organizationId: '00000000-0000-4000-8000-000000000002', userId: '00000000-0000-4000-8000-000000000003', signal: undefined };
  const allowed = { allowed: true, companyEnabled: true, buildingIds: [B] };
  const follow = { organizationId: input.organizationId, userId: input.userId, membershipId: 'm', authorizationVersion: 1, isSuperadmin: false, policyVersion: 1,
    permissions: { 'tasks.edit': allowed, 'tasks.delete': allowed, 'assistant.memory.supervise': { allowed: false, companyEnabled: false, buildingIds: [] } } };
  const reads = { capabilities: async () => null, followCapabilities: async () => follow };
  const base = keys => ({ permissions: { read: [], action: keys }, companyCeilings: { read: [], action: keys },
    scopesByPermission: Object.fromEntries(keys.map(key => [key, { buildingIds: [B], cashbookIds: [] }])),
    membership: { membershipId: 'm', authorizationVersion: 1 }, isSuperadmin: false, epoch: 'e' });
  const auth = keys => createTaskAuth({ baseAuth: { verifySession: async () => ({}), readAuthorization: async () => base(keys) }, reads,
    createFromActions: true, actionIds: catalog.ids, live });
  // DB mới: khung chung cấp cả ba khoá; lớp theo dõi không cấp lại, không context_changed.
  assert.deepEqual((await auth([TASK_KEY, 'tasks.edit', 'tasks.delete']).readAuthorization(input)).permissions.action, [TASK_KEY, 'tasks.edit', 'tasks.delete']);
  // Chỉ task.update sống: tasks.delete vẫn do lớp theo dõi cấp.
  live.observe({ 'task.create': {}, 'task.update': {} });
  assert.deepEqual((await auth([TASK_KEY, 'tasks.edit']).readAuthorization(input)).permissions.action, [TASK_KEY, 'tasks.edit', 'tasks.delete']);
  // DB cũ (chỉ task.create): lớp theo dõi cấp tasks.edit / tasks.delete như trước; khung chung mà cũng cấp ⇒ context_changed.
  live.observe({ 'task.create': {} });
  assert.deepEqual((await auth([TASK_KEY]).readAuthorization(input)).permissions.action, [TASK_KEY, 'tasks.edit', 'tasks.delete']);
  await assert.rejects(auth([TASK_KEY, 'tasks.edit']).readAuthorization(input), error => error.code === 'context_changed');
  assert.throws(() => createTaskAuth({ baseAuth: { verifySession: async () => ({}), readAuthorization: async () => base([]) }, reads, actionIds: 'task.update' }), /invalid_task_auth/);
});
