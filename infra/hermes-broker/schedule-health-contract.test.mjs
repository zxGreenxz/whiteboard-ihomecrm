import test from 'node:test';
import assert from 'node:assert/strict';
import { SCHEDULE_TOOLS, mayUseSchedule, scheduleInput, scheduleOperation, scheduleResult } from './schedule-contract.mjs';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
const now = Date.parse('2026-10-15T00:00:00.000Z');
const settings = (template = 'rooms_public_text_v1') => ({ template, buildingIds: [A], conversationIds: [B], weekdays: [1], time: '08:30',
  timeZone: 'Asia/Ho_Chi_Minh', maxRooms: 5, maxMessagesPerDay: 2, expiresAt: '2026-10-20T00:00:00.000Z' });
const summary = (over = {}) => ({ scheduleId: A, revision: 1, state: 'ACTIVE', settings: settings('sale_policy_public_text_v1'),
  createdAt: '2026-10-15T00:00:00.000Z', lastRuns: [], openIssues: [], ...over });

test('schedule contract: policy template, issues/reconcile inputs and fixed vocabulary', () => {
  assert.equal(scheduleInput('create', { requestId: A, settings: settings('sale_policy_public_text_v1') }, now).settings.template, 'sale_policy_public_text_v1');
  assert.throws(() => scheduleInput('create', { requestId: A, settings: settings('free_text_v1') }, now));
  assert.deepEqual(scheduleInput('issues', {}, now), { limit: 20, scheduleId: null });
  assert.deepEqual(scheduleInput('issues', { limit: 3, scheduleId: A }, now), { limit: 3, scheduleId: A });
  for (const bad of [{ limit: 21 }, { scheduleId: 'x' }, { scheduleId: A, extra: 1 }]) assert.throws(() => scheduleInput('issues', bad, now));
  const input = { requestId: A, jobId: B, decision: 'sent', note: 'Đã thấy tin trong nhóm\nlúc 9 giờ' };
  assert.deepEqual(scheduleInput('reconcile', input, now), input);
  // SQL char_length bound: 500 emoji (1000 UTF-16 units) is a valid note.
  assert.equal(scheduleInput('reconcile', { ...input, note: '✅'.repeat(250) + '🏠'.repeat(250) }, now).note.length, 750);
  for (const bad of [{ ...input, decision: 'resend' }, { ...input, note: '   ' }, { ...input, note: '' }, { ...input, note: 'x'.repeat(501) },
    { ...input, note: '🏠'.repeat(501) },
    { ...input, note: 'bad\u0000note' }, { ...input, jobId: 'job' }, { ...input, actor: C }, { requestId: A, jobId: B, decision: 'sent' }]) {
    assert.throws(() => scheduleInput('reconcile', bad, now));
  }
  assert.equal(scheduleOperation('crm_room_schedule_issues'), 'issues');
  assert.equal(scheduleOperation('crm_room_schedule_reconcile'), 'reconcile');
});

test('schedule contract: tool availability follows the effective overlay, attestation needs the producing Action', () => {
  const view = { read: ['chat_zalo.view'], action: [] };
  assert.equal(mayUseSchedule(view, 'issues'), true);
  assert.equal(mayUseSchedule({ read: [], action: ['chat_zalo.manage_automation'] }, 'issues'), false);
  assert.equal(mayUseSchedule(view, 'reconcile'), false);
  assert.equal(mayUseSchedule({ ...view, action: ['chat_zalo.send'] }, 'reconcile'), true);
  assert.equal(mayUseSchedule({ ...view, action: ['chat_zalo.manage_automation'] }, 'reconcile'), true);
  assert.equal(mayUseSchedule({ read: [], action: ['chat_zalo.send'] }, 'reconcile'), false);
  const tools = Object.fromEntries(SCHEDULE_TOOLS.map(tool => [tool.name, tool]));
  assert.deepEqual(Object.keys(tools).sort(), ['crm_room_schedule_create', 'crm_room_schedule_issues', 'crm_room_schedule_list',
    'crm_room_schedule_reconcile', 'crm_room_schedule_revoke', 'crm_room_schedule_update']);
  assert.equal(tools.crm_room_schedule_issues.annotations.readOnlyHint, true);
  assert.equal(tools.crm_room_schedule_reconcile.annotations.readOnlyHint, false);
  assert.match(tools.crm_room_schedule_reconcile.description, /never sends again/);
  assert.deepEqual(tools.crm_room_schedule_create.inputSchema.properties.settings.properties.template.enum,
    ['rooms_public_text_v1', 'sale_policy_public_text_v1']);
  assert.deepEqual(tools.crm_room_schedule_reconcile.inputSchema.required, ['requestId', 'jobId', 'decision', 'note']);
});

test('schedule contract: receipts are bound to the request and to the fixed SQL shape', () => {
  const input = scheduleInput('reconcile', { requestId: A, jobId: B, decision: 'not_sent', note: 'Không thấy tin' }, now);
  const receipt = { id: C, kind: 'queue_job', targetId: B, decision: 'not_sent', note: 'Không thấy tin', via: 'hermes_connector', createdAt: '2026-10-15T01:00:00.000Z' };
  assert.deepEqual(scheduleResult('reconcile', { reconciliation: receipt }, null, input), { reconciliation: receipt });
  for (const bad of [{ ...receipt, targetId: A }, { ...receipt, decision: 'sent' }, { ...receipt, note: 'khác' }, { ...receipt, via: 'crm_ui' },
    { ...receipt, kind: 'private_command' }, { ...receipt, extra: true }]) {
    assert.throws(() => scheduleResult('reconcile', { reconciliation: bad }, null, input));
  }
  const issuesInput = scheduleInput('issues', { scheduleId: A }, now);
  const incident = { incidentId: C, scheduleId: A, kind: 'authority', reason: 'scope_narrowed', detail: { buildingIds: [B] }, occurrences: 2,
    openedAt: '2026-10-15T01:00:00.000Z', lastSeenAt: '2026-10-15T01:05:00.000Z', closedAt: null, closeReason: null };
  const unknown = { jobId: B, dispatchId: C, origin: 'standing_grant', scheduleId: A, conversationId: B, createdAt: '2026-10-15T01:00:00.000Z' };
  assert.equal(scheduleResult('issues', { issues: [incident], unknownDeliveries: [unknown] }, null, issuesInput).issues[0].detail.buildingIds[0], B);
  for (const bad of [{ issues: [{ ...incident, scheduleId: B }], unknownDeliveries: [] }, { issues: [{ ...incident, closedAt: '2026-10-15T02:00:00.000Z' }], unknownDeliveries: [] },
    { issues: [{ ...incident, reason: 'Free text' }], unknownDeliveries: [] }, { issues: [{ ...incident, detail: { blob: 'x'.repeat(5000) } }], unknownDeliveries: [] },
    { issues: [], unknownDeliveries: [{ ...unknown, origin: 'external_mcp' }] }, { issues: [incident, incident], unknownDeliveries: [] }]) {
    assert.throws(() => scheduleResult('issues', bad, null, issuesInput));
  }
  const listInput = scheduleInput('list', {}, now);
  const run = { date: '2026-10-15', conversationId: B, outcome: 'missed', reason: 'user_permission_revoked', dispatchId: null, deliveryStatus: null };
  assert.equal(scheduleResult('list', { schedules: [summary({ lastRuns: [run] })], nextCursor: null }, null, listInput).schedules[0].lastRuns[0].reason, 'user_permission_revoked');
  const queued = { ...run, outcome: 'queued', reason: null, dispatchId: C, deliveryStatus: 'confirmed_not_sent' };
  assert.equal(scheduleResult('list', { schedules: [summary({ lastRuns: [queued] })], nextCursor: null }, null, listInput).schedules[0].lastRuns[0].deliveryStatus, 'confirmed_not_sent');
  for (const bad of [summary({ lastRuns: [{ ...run, outcome: 'queued', dispatchId: C, deliveryStatus: 'sent' }] }), summary({ lastRuns: [{ ...run, outcome: 'blocked' }] }),
    summary({ openIssues: undefined }), summary({ openIssues: [{ kind: 'run', reason: 'room_limit', occurrences: 0, openedAt: '2026-10-15T01:00:00.000Z' }] })]) {
    assert.throws(() => scheduleResult('list', { schedules: [bad], nextCursor: null }, null, listInput));
  }
});
