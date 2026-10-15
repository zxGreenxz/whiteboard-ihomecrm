import test from 'node:test';
import assert from 'node:assert/strict';
import { taskFollowInput, taskFollowResult, mayUseTaskFollow, taskFollowOperation, TASK_FOLLOW_TOOLS } from './task-follow-contract.mjs';
import { extendTaskFollowAuthorization } from './task-follow-adapter.mjs';
import { taskActionOperation, mayUseTaskAction, TASK_INPUT_TOOLS } from './task-input-contract.mjs';
import { workMemoryInput, workMemoryResult, mayUseWorkMemory } from './work-memory-contract.mjs';
import { HERMES_ACTION_CAPABILITIES, HERMES_READ_CAPABILITIES, requiresBuildingScope } from './capability-contract.mjs';

const u = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = u(1), ME = u(2), OTHER = u(3), BUILDING = u(4), JOB = u(5), FOLLOW = u(6), REQ = u(7), FOREIGN_BUILDING = u(8);
const identity = { row: { userId: ME, organizationId: ORG }, isSuperadmin: false, effective: { read: ['tasks.view'], action: [] },
  scopesByPermission: { 'tasks.view': { buildingIds: [BUILDING], cashbookIds: [] } } };
const follow = (extra = {}) => ({ id: FOLLOW, version: 1, state: 'active', closeReason: null, jobId: JOB, jobCode: 'JOB-1', assignerUserId: ME,
  executorUserId: OTHER, mode: 'self', depth: 0, parentFollowId: null, objective: 'Theo dõi', remindBeforeMinutes: 30, notifyAssigner: true,
  createdAt: '2026-10-15T01:00:00.000Z', ...extra });
const item = (extra = {}) => ({ id: JOB, code: 'JOB-1', title: 'Sửa vòi', status: 'IN_PROGRESS', buildingId: BUILDING, roomId: null,
  deadline: '2026-10-16T01:00:00.000Z', overdue: false, assigneeId: OTHER, assigneeName: 'Người làm', createdBy: ME, progressNote: null,
  progressDigest: 'd41d8cd98f00b204e9800998ecf8427e', follows: [follow()], ...extra });

test('follow tools join the task family and map only existing CRM task permissions', () => {
  assert.deepEqual(TASK_FOLLOW_TOOLS.map(tool => taskFollowOperation(tool.name)), ['list', 'set', 'stop', 'progress', 'cancel']);
  for (const tool of TASK_FOLLOW_TOOLS) assert.ok(TASK_INPUT_TOOLS.includes(tool));
  for (const name of ['__proto__', 'toString', 'crm_task_follow', 'crm_read_tasks']) { assert.equal(taskFollowOperation(name), null); }
  assert.equal(taskActionOperation('crm_task_cancel'), 'cancel');
  const none = { read: [], action: [] };
  assert.equal(mayUseTaskFollow({ read: ['tasks.view'], action: [] }, 'list'), true);
  assert.equal(mayUseTaskFollow({ read: [], action: ['tasks.create'] }, 'set'), false, 'a follow reports status, so it needs task Read');
  assert.equal(mayUseTaskFollow({ read: ['tasks.view'], action: ['tasks.create'] }, 'set'), true);
  assert.equal(mayUseTaskFollow({ read: ['tasks.view'], action: ['tasks.create'] }, 'progress'), false);
  assert.equal(mayUseTaskFollow({ read: [], action: ['tasks.edit'] }, 'progress'), true);
  assert.equal(mayUseTaskFollow({ read: ['tasks.view'], action: ['tasks.create', 'tasks.edit'] }, 'cancel'), false);
  assert.equal(mayUseTaskAction({ read: [], action: ['tasks.delete'] }, 'cancel'), true);
  assert.equal(mayUseTaskAction(none, 'list'), false);
  assert.ok(HERMES_ACTION_CAPABILITIES.includes('tasks.edit') && HERMES_ACTION_CAPABILITIES.includes('tasks.delete'));
  assert.ok(HERMES_READ_CAPABILITIES.includes('assistant.memory.supervise'));
  assert.equal(requiresBuildingScope([], ['tasks.delete']), true); assert.equal(requiresBuildingScope(['assistant.memory.supervise']), false);
});

test('inputs: fixed shapes, explicit company, no actor/role override, bounded single-line text', () => {
  assert.deepEqual(taskFollowInput('list', { organizationId: ORG, role: 'assigned_to_me' }),
    { organizationId: ORG, role: 'assigned_to_me', assigneeUserId: null, status: 'open', limit: 20, offset: 0 });
  assert.deepEqual(taskFollowInput('set', { organizationId: ORG, requestId: REQ, jobId: JOB, objective: 'Theo dõi' }),
    { organizationId: ORG, requestId: REQ, jobId: JOB, objective: 'Theo dõi', remindBeforeMinutes: null, notifyAssigner: true, parentFollowId: null });
  assert.equal(taskFollowInput('progress', { organizationId: ORG, requestId: REQ, jobId: JOB, note: 'Dòng 1\nDòng 2', expectedNoteDigest: 'a'.repeat(32) }).note, 'Dòng 1\nDòng 2');
  for (const [operation, value] of [
    ['list', { role: 'team' }], ['list', { organizationId: ORG, role: 'team', assigneeUserId: 'Người làm' }],
    ['list', { organizationId: ORG, role: 'team', userId: OTHER }], ['list', { organizationId: ORG, role: 'all' }],
    ...[7, 0, true, {}, [], [OTHER], undefined].map(assigneeUserId => ['list', { organizationId: ORG, role: 'assigned_by_me', assigneeUserId }]),
    ['set', { organizationId: ORG, requestId: REQ, jobId: JOB, objective: 'a\nb' }],
    ['set', { organizationId: ORG, requestId: REQ, jobId: JOB, objective: 'hc_' + 'A'.repeat(43) }],
    ['set', { organizationId: ORG, requestId: REQ, jobId: JOB, objective: 'x', assignerUserId: OTHER }],
    ['set', { organizationId: ORG, requestId: REQ, jobId: JOB, objective: 'x', remindBeforeMinutes: 10081 }],
    ['stop', { organizationId: ORG, requestId: REQ, followId: FOLLOW, expectedVersion: 0 }],
    ['progress', { organizationId: ORG, requestId: REQ, jobId: JOB, note: ' lề', expectedNoteDigest: 'a'.repeat(32) }],
    ['cancel', { organizationId: ORG, requestId: REQ, jobId: JOB, reason: '' }], ['cancel', { organizationId: ORG, requestId: 'x', jobId: JOB, reason: 'r' }],
  ]) assert.throws(() => taskFollowInput(operation, value), /invalid_task_follow/, JSON.stringify(value));
});

test('16/10 20:44Z: assigneeUserId outside role=team is ignored (string/null -> null), never widened for team', () => {
  // Exact incident shape: a real user id with assigned_by_me was rejected three times.
  const incident = { organizationId: ORG, role: 'assigned_by_me', assigneeUserId: OTHER, status: 'open', limit: 20, offset: 0 };
  assert.deepEqual(taskFollowInput('list', incident), { ...incident, assigneeUserId: null });
  for (const role of ['assigned_to_me', 'assigned_by_me'])
    for (const assigneeUserId of [ME, OTHER, '', 'Người làm', null])
      assert.equal(taskFollowInput('list', { organizationId: ORG, role, assigneeUserId }).assigneeUserId, null, `${role} ${assigneeUserId}`);
  assert.equal(taskFollowInput('list', { organizationId: ORG, role: 'team', assigneeUserId: OTHER }).assigneeUserId, OTHER, 'team keeps the filter');
  assert.equal(taskFollowInput('list', { organizationId: ORG, role: 'team' }).assigneeUserId, null);
  // The result fence follows the normalized input: assigned_by_me items for any assignee are valid.
  const input = taskFollowInput('list', incident);
  const page = { organizationId: ORG, role: 'assigned_by_me', status: 'open', readAt: '2026-10-15T01:00:00.000Z', items: [item({ assigneeId: ME })], offset: 0, nextOffset: null };
  assert.deepEqual(taskFollowResult('list', page, identity, input), page);
  const team = taskFollowInput('list', { organizationId: ORG, role: 'team', assigneeUserId: OTHER });
  assert.throws(() => taskFollowResult('list', { ...page, role: 'team', items: [item({ assigneeId: ME })] }, identity, team), /invalid_task_follow/);
});

test('results: scope, role, party and echo checks fail closed', () => {
  const input = taskFollowInput('list', { organizationId: ORG, role: 'assigned_by_me' });
  const page = { organizationId: ORG, role: 'assigned_by_me', status: 'open', readAt: '2026-10-15T01:00:00.000Z', items: [item()], offset: 0, nextOffset: null };
  assert.deepEqual(taskFollowResult('list', page, identity, input), page);
  for (const bad of [{ ...page, organizationId: u(9) }, { ...page, items: [item({ buildingId: FOREIGN_BUILDING })] },
    { ...page, items: [item({ status: 'COMPLETED' })] }, { ...page, items: [item({ follows: [follow({ assignerUserId: OTHER, executorUserId: u(10) })] })] },
    { ...page, items: [item({ overdue: true, deadline: null })] }, { ...page, items: [item(), item()] }])
    assert.throws(() => taskFollowResult('list', bad, identity, input), /invalid_task_follow/);
  const mine = taskFollowInput('list', { organizationId: ORG, role: 'assigned_to_me' });
  assert.throws(() => taskFollowResult('list', { ...page, role: 'assigned_to_me' }, identity, mine), /invalid_task_follow/, 'assigned_to_me only returns my jobs');
  const setInput = taskFollowInput('set', { organizationId: ORG, requestId: REQ, jobId: JOB, objective: 'Theo dõi', remindBeforeMinutes: 30 });
  const set = { organizationId: ORG, requestId: REQ, outcome: 'applied', follow: { ...follow(), deadline: null } };
  assert.equal(taskFollowResult('set', set, identity, setInput).follow.id, FOLLOW);
  assert.throws(() => taskFollowResult('set', { ...set, follow: { ...set.follow, assignerUserId: OTHER } }, identity, setInput), /invalid_task_follow/);
  assert.throws(() => taskFollowResult('set', { ...set, follow: { ...set.follow, objective: 'Khác' } }, identity, setInput), /invalid_task_follow/);
  const cancelInput = taskFollowInput('cancel', { organizationId: ORG, requestId: REQ, jobId: JOB, reason: 'Không cần' });
  const cancelled = { organizationId: ORG, requestId: REQ, outcome: 'applied', job: { id: JOB, code: 'JOB-1', title: 'Sửa', status: 'DELETED', assigneeId: OTHER }, closedFollows: 1, notified: 1 };
  assert.equal(taskFollowResult('cancel', cancelled, identity, cancelInput).job.status, 'DELETED');
  assert.throws(() => taskFollowResult('cancel', { ...cancelled, job: { ...cancelled.job, status: 'IN_PROGRESS' } }, identity, cancelInput), /invalid_task_follow/);
});

test('capability merge adds only observed CRM grants and treats drift or upstream injection as context change', () => {
  const current = { membership: { membershipId: ME, authorizationVersion: 1 }, isSuperadmin: false, epoch: 'base',
    permissions: { read: ['tasks.view'], action: ['tasks.create'] }, companyCeilings: { read: ['tasks.view'], action: ['tasks.create'] }, scopesByPermission: {} };
  const request = { organizationId: ORG, userId: ME };
  const allowed = { allowed: true, companyEnabled: true, buildingIds: [BUILDING] }, off = { allowed: false, companyEnabled: false, buildingIds: [] };
  const cap = { organizationId: ORG, userId: ME, membershipId: ME, authorizationVersion: 1, isSuperadmin: false, policyVersion: 1,
    permissions: { 'tasks.edit': allowed, 'tasks.delete': off, 'assistant.memory.supervise': { allowed: true, companyEnabled: true, buildingIds: [] } } };
  assert.equal(extendTaskFollowAuthorization(current, null, request), current);
  const merged = extendTaskFollowAuthorization(current, cap, request);
  assert.deepEqual(merged.permissions, { read: ['tasks.view', 'assistant.memory.supervise'], action: ['tasks.create', 'tasks.edit'] });
  assert.deepEqual(merged.scopesByPermission['tasks.edit'].buildingIds, [BUILDING]); assert.notEqual(merged.epoch, current.epoch);
  for (const bad of [{ ...cap, userId: OTHER }, { ...cap, authorizationVersion: 2 }, { ...cap, isSuperadmin: true },
    { ...cap, permissions: { ...cap.permissions, 'tasks.delete': { allowed: true, companyEnabled: false, buildingIds: [BUILDING] } } },
    { ...cap, permissions: { ...cap.permissions, 'tasks.edit': { allowed: true, companyEnabled: true, buildingIds: [] } } },
    { ...cap, permissions: { ...cap.permissions, 'assistant.memory.supervise': { allowed: true, companyEnabled: true, buildingIds: [BUILDING] } } },
    { ...cap, permissions: { 'tasks.edit': allowed } }])
    assert.throws(() => extendTaskFollowAuthorization(current, bad, request), error => error.code === 'context_changed');
  assert.throws(() => extendTaskFollowAuthorization({ ...current, permissions: { read: ['assistant.memory.supervise'], action: [] } }, cap, request),
    error => error.code === 'context_changed', 'an upstream adapter cannot pre-seed supervision');
});

test('Hermes tổng memory search needs its own grant and only returns notes shared with this supervisor', () => {
  assert.equal(mayUseWorkMemory({ read: ['assistant.memory.read'], action: [] }, 'search'), false);
  assert.equal(mayUseWorkMemory({ read: ['assistant.memory.read', 'assistant.memory.supervise'], action: [] }, 'search'), true);
  assert.throws(() => workMemoryInput('search', {}), /invalid_request/);
  assert.throws(() => workMemoryInput('search', { organizationId: ORG, path: '/home/me/.hermes/memory' }), /invalid_request/);
  const input = workMemoryInput('search', { organizationId: ORG, query: 'ga' });
  const note = { id: u(20), ownerUserId: OTHER, ownerName: 'Chủ ghi chú', key: 'gas', content: 'Đồng hồ ga', version: 1, assistantId: u(21), connectionId: u(22),
    source: { channel: 'external_mcp', label: 'Ghi chú' }, sharing: 'managers', createdAt: '2026-10-15T01:00:00Z', updatedAt: '2026-10-15T01:00:00Z', expiresAt: '2099-01-01T00:00:00Z' };
  const raw = { organizationId: ORG, actorUserId: ME, classification: 'crm_work_memory', authority: 'reference_only', scope: 'shared_work_memory',
    personalMemory: 'not_accessible', readAt: '2026-10-15T02:00:00Z', items: [note], offset: 0, nextOffset: null };
  const me = { ...identity, effective: { read: ['assistant.memory.read', 'assistant.memory.supervise'], action: [] } };
  assert.equal(workMemoryResult('search', raw, me, input).items.length, 1);
  for (const bad of [{ ...note, ownerUserId: ME }, { ...note, sharing: 'superadmin' }, { ...note, sharing: 'owner' }, { ...note, source: { channel: 'native_memory', label: 'x' } }])
    assert.throws(() => workMemoryResult('search', { ...raw, items: [bad] }, me, input), /backend_unavailable/);
  assert.equal(workMemoryResult('search', { ...raw, items: [{ ...note, sharing: 'superadmin' }] }, { ...me, isSuperadmin: true }, input).items.length, 1);
  const list = workMemoryInput('list', { ownerUserId: OTHER });
  const shared = { organizationId: ORG, ownerUserId: OTHER, settings: { enabled: true, sharing: 'managers', retentionDays: 30, accessVersion: 2 },
    classification: 'crm_work_memory', authority: 'reference_only', readAt: '2026-10-15T02:00:00Z', items: [], offset: 0, nextOffset: null };
  assert.throws(() => workMemoryResult('list', shared, { ...identity, effective: { read: ['assistant.memory.read'], action: [] } }, list), /backend_unavailable/);
  assert.equal(workMemoryResult('list', shared, me, list).ownerUserId, OTHER);
});
