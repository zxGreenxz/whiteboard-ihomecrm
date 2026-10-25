import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMAIN_READS, DOMAIN_TOOLS, domainInput, domainResult, summarizeRows } from './domain-contract.mjs';
import { createActionCatalog, validateActionParams } from './action-catalog.mjs';
import { createActionRuntime } from './action-runtime.mjs';
import { TASK_ACTIONS, TASK_CREATE_BATCH } from './task-actions-contract.mjs';

// Lượt 14 Công việc (nghiệm thu C3f), phía connector — SQL ở task-luot14-sql.test.mjs:
//  1. crm_read_tasks nhận cờ givenByMe (chỉ miền tasks): chỉ gửi SQL khi true (input năm khoá của SQL cũ không đổi khi không dùng);
//     lọc bật ⇒ summary.givenByMe phải trùng count / overdue (SQL cũ không lọc ⇒ lệch ⇒ từ chối).
//  2. task.create_batch nhận perRoom; needs_input batch_too_large của SQL mang số phòng thật (rooms) ⇒ câu "toà có N phòng … chia lô".
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = id(1), A = id(2), ROOM = id(5), USER = id(6), CONNECTION = id(7);
const identity = { row: { id: CONNECTION, organizationId: ORG, userId: USER }, scopesByPermission: { 'tasks.view': { buildingIds: [A], cashbookIds: [] } } };
const ROWS = [
  { id: id(11), title: 'Sửa vòi', code: null, status: 'IN_PROGRESS', buildingId: A, buildingName: 'Toà A', roomId: ROOM, roomName: 'P1', deadline: '2026-10-20T03:00:00+00:00', assigneeName: 'Người A' },
  { id: id(12), title: 'Thay đèn', code: null, status: 'IN_PROGRESS', buildingId: A, buildingName: 'Toà A', roomId: ROOM, roomName: 'P2', deadline: null, assigneeName: 'Người B' }];
const envelope = summary => ({ organizationId: ORG, domain: 'tasks', summary, items: ROWS, nextCursor: null });

test('crm_read_tasks givenByMe: only tasks accepts it, it reaches SQL only when true, and tools/list shows it on crm_read_tasks alone', () => {
  assert.deepEqual(domainInput('tasks', { givenByMe: true, status: 'IN_PROGRESS' }),
    { query: '', limit: 20, cursor: null, buildingId: null, status: 'IN_PROGRESS', givenByMe: true });
  for (const off of [false, null, undefined]) assert.equal(Object.hasOwn(domainInput('tasks', { givenByMe: off }), 'givenByMe'), false, String(off));
  for (const bad of ['true', 1, {}]) assert.throws(() => domainInput('tasks', { givenByMe: bad }), String(bad));
  assert.throws(() => domainInput('customers', { givenByMe: true }), 'miền khác không nhận cờ');
  const tools = Object.fromEntries(DOMAIN_TOOLS.map(tool => [tool.name, tool]));
  assert.deepEqual(tools.crm_read_tasks.inputSchema.properties.givenByMe.type, 'boolean');
  assert.match(tools.crm_read_tasks.description, /việc anh\/chị giao cho người khác: givenByMe=true/);
  for (const tool of DOMAIN_TOOLS.filter(entry => entry.name !== 'crm_read_tasks')) assert.equal(Object.hasOwn(tool.inputSchema.properties ?? {}, 'givenByMe'), false, tool.name);
  assert.deepEqual(Object.keys(DOMAIN_READS.tasks.flags), ['givenByMe']);
});

test('crm_read_tasks givenByMe: the whole summary must be the given set (givenByMe = count / overdue); an unfiltered summary from old SQL is refused', () => {
  const now = Date.parse('2026-10-21T00:00:00.000Z');
  const base = summarizeRows('tasks', ROWS, { now });
  const on = domainInput('tasks', { givenByMe: true }), off = domainInput('tasks', {});
  const given = { ...base, givenByMe: { count: base.count, overdue: base.overdue } };
  assert.deepEqual(domainResult('tasks', envelope(given), identity, on).summary.givenByMe, { count: 2, overdue: 1 });
  // SQL cũ (không lọc): givenByMe nhỏ hơn count ⇒ từ chối khi đã lọc, nhận khi không lọc.
  const old = { ...base, givenByMe: { count: 1, overdue: 0 } };
  assert.throws(() => domainResult('tasks', envelope(old), identity, on));
  assert.equal(domainResult('tasks', envelope(old), identity, off).summary.givenByMe.count, 1);
  assert.throws(() => domainResult('tasks', envelope({ ...base, givenByMe: null }), identity, on), 'không biết người tạo ⇒ không chứng minh được lọc');
});

test('task.create_batch perRoom (bool with a hint); SQL batch_too_large with rooms ⇒ "Toà có N phòng" detail; rooms on another reason is refused', async () => {
  assert.equal(TASK_CREATE_BATCH.params.perRoom.kind, 'bool');
  assert.match(TASK_CREATE_BATCH.params.perRoom.hint, /^true = mỗi phòng của buildingName một việc/);
  assert.deepEqual(validateActionParams(TASK_CREATE_BATCH, { buildingName: 'Toà A', perRoom: true, content: 'kiểm bình chữa cháy' }),
    { ok: true, value: { buildingName: 'Toà A', perRoom: true, content: 'kiểm bình chữa cháy' } });
  const outcomes = [];
  const service = { async prepareAction() { return Object.freeze({}); }, async finalizeAction() { return outcomes.shift(); } };
  const runtime = createActionRuntime({ catalog: createActionCatalog(TASK_ACTIONS), service });
  const who = { row: { id: CONNECTION, organizationId: ORG }, effective: { read: [], action: ['tasks.create'] } };
  const run = async () => {
    const plan = runtime.begin(runtime.route('crm_action_run'), { action: 'task.create_batch', params: { buildingName: 'Toà A', perRoom: true, content: 'kiểm điện' } });
    return JSON.parse((await runtime.finish(plan, 'token', await runtime.handle(plan, 'token', who), who)).content[0].text);
  };
  outcomes.push({ kind: 'needs_input', reason: 'batch_too_large', rooms: 40 });
  const out = await run();
  assert.deepEqual([out.outcome, out.reason], ['needs_input', 'batch_too_large']);
  assert.equal(out.detail, 'Toà có 40 phòng; tối đa 20 việc một lần — chia lô (vd theo tầng, gửi items từng phòng) hoặc tạo trên web.');
  for (const bad of [{ kind: 'needs_input', reason: 'invalid_params', rooms: 40 }, { kind: 'needs_input', reason: 'batch_too_large', rooms: 5 },
    { kind: 'needs_input', reason: 'batch_too_large', rooms: '40' }]) {
    outcomes.push(bad);
    await assert.rejects(run(), error => error.code === 'backend_unavailable', JSON.stringify(bad));
  }
});
