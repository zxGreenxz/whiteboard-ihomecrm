import test from 'node:test';
import assert from 'node:assert/strict';
import { createBroker } from './broker.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
import { advertisedTool, normalizeToolArguments } from './tool-argument-shape.mjs';
import { REQUEST_ID_GUIDANCE, REQUEST_ID_PROPERTY, startsCrmRequest } from './request-id-contract.mjs';
import { ALL_DOMAIN_READ_CAPABILITIES } from './domain-contract.mjs';
import { SCHEDULE_TOOLS } from './schedule-contract.mjs';
import { ZALO_BROADCAST_TOOLS, mayUseZaloBroadcast, zaloBroadcastInput, zaloBroadcastOperation, zaloBroadcastResult } from './zalo-broadcast-contract.mjs';

const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const A = id('a'), B = id('b'), C = id('c'), V = 'f'.repeat(64);
const tool = name => ZALO_BROADCAST_TOOLS.find(value => value.name === name);
const days = { mon: 'full', tue: 'compact', wed: 'compact', thu: 'compact', fri: 'compact', sat: 'compact', sun: 'off' };
const view = (overrides = {}) => ({ version: V, enabled: true, emergencyStop: false, timeZone: 'Asia/Ho_Chi_Minh', time: '08:30', days,
  allowedHours: { from: '08:00', to: '20:00' }, dailyCap: 120, queuedToday: 0, recipientCount: 1,
  recipients: [{ conversationId: A, name: 'Nhóm MG', accountName: 'Ihome', valid: true }], ...overrides });
const shot = (overrides = {}) => ({ oneshotId: C, status: 'queued', mode: 'full', runAt: '2026-10-16T02:00:00.000Z', sendNow: true, origin: 'hermes',
  requestId: B, createdAt: '2026-10-16T02:00:00.000Z', recipientCount: 1, resultCode: null, recipients: [A], ...overrides });

test('capability gate: Read for everything, manage for writes, send only for send; existing keys only', () => {
  const read = ['chat_zalo.view'], all = { read, action: ['chat_zalo.manage_automation', 'chat_zalo.send'] };
  const allowed = effective => ZALO_BROADCAST_TOOLS.map(t => zaloBroadcastOperation(t.name)).filter(op => mayUseZaloBroadcast(effective, op));
  assert.deepEqual(allowed(all), ['status', 'recipients', 'send', 'cancel', 'update']);
  assert.deepEqual(allowed({ read, action: ['chat_zalo.manage_automation'] }), ['status', 'recipients', 'cancel', 'update']);
  assert.deepEqual(allowed({ read, action: ['chat_zalo.send'] }), ['status', 'recipients']);
  assert.deepEqual(allowed({ read: [], action: all.action }), []);
  assert.deepEqual(allowed({ read: ['rooms.view'], action: all.action }), []);
  assert.equal(mayUseZaloBroadcast(all, 'create'), false); assert.equal(zaloBroadcastOperation('crm_room_schedule_create'), null);
  // An update that can start sends also needs chat_zalo.send (conservative: only explicit enabled:false waives it).
  const manageOnly = { read, action: ['chat_zalo.manage_automation'] };
  for (const input of [{ enabled: true }, { addConversationIds: [A] }, { setConversationIds: [A] }, { enabled: true, removeConversationIds: [A] }])
    assert.equal(mayUseZaloBroadcast(manageOnly, 'update', input), false, JSON.stringify(input));
  for (const input of [{ enabled: false }, { time: '09:00' }, { days: { mon: 'off' } }, { removeConversationIds: [A] }, { enabled: false, addConversationIds: [A] }])
    assert.equal(mayUseZaloBroadcast(manageOnly, 'update', input), true, JSON.stringify(input));
  assert.equal(mayUseZaloBroadcast(all, 'update', { enabled: true, setConversationIds: [A] }), true);
});

test('input: canonical, idempotent, zone-required times; ids only, never names', () => {
  const send = zaloBroadcastInput('send', { requestId: B, conversationIds: [A, C], runAt: '2026-10-17T09:00+07:00' });
  assert.deepEqual(send, { requestId: B, conversationIds: [A, C], mode: 'full', runAt: '2026-10-17T02:00:00.000Z' }, 'mode defaults to full');
  assert.deepEqual(zaloBroadcastInput('send', send), send, 'fixed point (prepare and execute validate again)');
  assert.equal(zaloBroadcastInput('send', normalizeToolArguments(tool('crm_zalo_broadcast_send'), { requestId: B, conversationIds: [A] })).runAt, null);
  assert.equal(zaloBroadcastInput('send', normalizeToolArguments(tool('crm_zalo_broadcast_send'), { requestId: B, conversationIds: [A], runAt: ' ' })).runAt, null);
  for (const bad of [{ runAt: '2026-10-17T09:00:00' }, { mode: 'off' }, { conversationIds: [] }, { conversationIds: ['Nhóm MG'] }, { conversationIds: [A, A] },
    { conversationIds: Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) }, { requestId: 'r1' }, { extra: true }])
    assert.throws(() => zaloBroadcastInput('send', { requestId: B, conversationIds: [A], ...bad }), JSON.stringify(bad));
  const update = zaloBroadcastInput('update', { requestId: B, expectedVersion: V, time: ' 7:05 ', days: { sun: 'full', mon: 'off' }, addConversationIds: [A] });
  assert.deepEqual(update, { requestId: B, expectedVersion: V, time: '07:05', days: { mon: 'off', sun: 'full' }, addConversationIds: [A] });
  assert.deepEqual(zaloBroadcastInput('update', update), update);
  for (const bad of [{}, { time: '24:00' }, { time: '8h30' }, { days: {} }, { days: { monday: 'full' } }, { days: { mon: 'gon' } }, { enabled: 'yes' },
    { setConversationIds: [A], addConversationIds: [C] }, { addConversationIds: [A], removeConversationIds: [A] }, { recipients: [A] }])
    assert.throws(() => zaloBroadcastInput('update', { requestId: B, expectedVersion: V, ...bad }), JSON.stringify(bad));
  assert.throws(() => zaloBroadcastInput('update', { requestId: B, expectedVersion: 'v1', enabled: true }));
  assert.deepEqual(zaloBroadcastInput('recipients', { labelName: '  Group   MG IHOME ', groupName: '' }),
    { groupName: null, labelName: 'Group MG IHOME', labelKey: null, limit: 30 });
  for (const bad of [{ limit: 0 }, { limit: 51 }, { labelKey: 'Group MG' }, { labelName: `a${String.fromCharCode(7)}b` }, { groupName: 'x'.repeat(121) }, { query: 'x' }])
    assert.throws(() => zaloBroadcastInput('recipients', bad), JSON.stringify(bad));
  assert.deepEqual(zaloBroadcastInput('status', {}), {}); assert.throws(() => zaloBroadcastInput('status', { all: true }));
  assert.deepEqual(zaloBroadcastInput('cancel', { oneshotId: C }), { oneshotId: C }); assert.throws(() => zaloBroadcastInput('cancel', { oneshotId: C, requestId: B }));
});

test('result: strict shapes; refusals keep the CRM code/reason verbatim and add plain-Vietnamese guidance', () => {
  const sendInput = zaloBroadcastInput('send', { requestId: B, conversationIds: [A] });
  assert.deepEqual(zaloBroadcastResult('send', { ok: true, reused: false, oneshot: shot() }, null, sendInput).oneshot.recipients, [A]);
  for (const bad of [shot({ mode: 'compact' }), shot({ recipients: [C] }), shot({ requestId: C }), shot({ sendNow: false }), shot({ resultCode: 'Lỗi' }),
    { ...shot(), extra: 1 }])
    assert.throws(() => zaloBroadcastResult('send', { ok: true, reused: false, oneshot: bad }, null, sendInput));
  const refusal = { ok: false, code: 'ngoai_khung_gio', reason: 'Ngoài khung giờ được phép gửi 08:00–20:00 (giờ Việt Nam). Hãy hẹn giờ trong khung.',
    allowedHours: { from: '08:00', to: '20:00' }, suggestedRunAt: '2026-10-17T01:00:00.000Z', invalidRecipients: [] };
  const out = zaloBroadcastResult('send', refusal, null, sendInput);
  assert.equal(out.reason, refusal.reason, 'CRM reason verbatim');
  assert.match(out.huongDan, /08:00 ngày 17\/10\/2026/); assert.match(out.huongDan, /runAt=2026-10-17T01:00:00.000Z/);
  assert.match(zaloBroadcastResult('send', { ...refusal, code: 'ma_moi_cua_crm', allowedHours: null, suggestedRunAt: null }, null, sendInput).huongDan, /nguyên văn/);
  assert.throws(() => zaloBroadcastResult('send', { ...refusal, invalidRecipients: [C] }, null, sendInput), 'only ids that were sent');
  assert.throws(() => zaloBroadcastResult('send', { ...refusal, code: 'Ngoài giờ' }, null, sendInput));
  const status = zaloBroadcastResult('status', { ...view(), oneshots: [{ ...shot(), recipients: undefined }].map(({ recipients, ...rest }) => rest) }, null, {});
  assert.equal(status.oneshots[0].oneshotId, C);
  for (const bad of [view({ days: { ...days, mon: 'FULL' } }), view({ time: '8:30' }), view({ version: 'v1' }), view({ recipientCount: 0 }),
    view({ recipients: [{ conversationId: A, name: null, accountName: null, valid: true }] }), view({ timeZone: 'UTC' })])
    assert.throws(() => zaloBroadcastResult('status', { ...bad, oneshots: [] }, null, {}));
  const updateInput = zaloBroadcastInput('update', { requestId: B, expectedVersion: V, time: '09:00' });
  const applied = { ok: true, reused: false, changed: ['time'], settings: view({ time: '09:00' }), warnings: ['gio_gui_ngoai_khung_gio'] };
  assert.equal(zaloBroadcastResult('update', applied, null, updateInput).warnings[0].code, 'gio_gui_ngoai_khung_gio');
  assert.throws(() => zaloBroadcastResult('update', { ...applied, settings: view() }, null, updateInput), 'settings must reflect the patch');
  assert.throws(() => zaloBroadcastResult('update', { ...applied, warnings: ['khac'] }, null, updateInput));
  const stale = zaloBroadcastResult('update', { ok: false, code: 'cau_hinh_vua_doi', reason: 'Cài đặt vừa được sửa.', version: V, invalidRecipients: [] }, null, updateInput);
  assert.match(stale.huongDan, /crm_zalo_broadcast_status/);
  assert.throws(() => zaloBroadcastResult('update', { ok: false, code: 'cau_hinh_vua_doi', reason: 'x', version: null, invalidRecipients: [] }, null, updateInput));
  const recipientsInput = zaloBroadcastInput('recipients', { labelKey: `${A}:1` });
  const group = { conversationId: A, name: 'Nhóm MG', accountName: 'Ihome', inSchedule: false, labels: [{ key: `${A}:1`, name: 'Group MG IHOME' }] };
  assert.equal(zaloBroadcastResult('recipients', { groups: [group], labels: [{ key: `${A}:1`, name: 'Group MG IHOME', accountName: 'Ihome', groupCount: 1 }],
    total: 1, truncated: false }, null, recipientsInput).groups.length, 1);
  assert.throws(() => zaloBroadcastResult('recipients', { groups: [group], labels: [{ key: `${C}:1`, name: 'X', accountName: 'Y', groupCount: 1 }], total: 1, truncated: false },
    null, recipientsInput), 'a label outside the requested key');
  assert.throws(() => zaloBroadcastResult('recipients', { groups: [], labels: [], total: 1, truncated: false }, null, recipientsInput));
});

test('tool definitions: Vietnamese meaning, requestId on writes that start a command, no required nullable after shaping', () => {
  assert.deepEqual(ZALO_BROADCAST_TOOLS.map(t => t.name), ['crm_zalo_broadcast_status', 'crm_zalo_broadcast_recipients', 'crm_zalo_broadcast_send',
    'crm_zalo_broadcast_cancel', 'crm_zalo_broadcast_update']);
  assert.deepEqual(ZALO_BROADCAST_TOOLS.filter(startsCrmRequest).map(t => t.name), ['crm_zalo_broadcast_send', 'crm_zalo_broadcast_update']);
  for (const name of ['crm_zalo_broadcast_send', 'crm_zalo_broadcast_update']) {
    assert.ok(tool(name).description.includes(REQUEST_ID_GUIDANCE)); assert.deepEqual(tool(name).inputSchema.properties.requestId, REQUEST_ID_PROPERTY);
  }
  assert.match(tool('crm_zalo_broadcast_send').description, /ảnh danh sách phòng trống kèm thông tin/);
  assert.match(tool('crm_zalo_broadcast_send').description, /mặc định full/);
  assert.match(tool('crm_zalo_broadcast_recipients').description, /hai nick có thể trùng tên phân loại/);
  assert.deepEqual(advertisedTool(tool('crm_zalo_broadcast_send')).inputSchema.required, ['requestId', 'conversationIds'], 'runAt is omittable = send now');
  for (const t of ZALO_BROADCAST_TOOLS) assert.ok(Buffer.byteLength(JSON.stringify(advertisedTool(t))) < 4096, t.name);
});

function brokerFixture(t, effective) {
  const scope = createDependencyScope(); t.after(() => scope.close());
  const seen = [], CONNECTION = id('d');
  const identity = { row: { id: CONNECTION, assistantId: id('e'), userId: id('1'), organizationId: id('2'), expiresAt: Date.now() + 600_000, epoch: 1, state: 'active',
    restrictions: effective }, effective, isSuperadmin: false, policyEpoch: 'a'.repeat(64), contextVersion: 'b'.repeat(64), assistantScopeIds: [],
  scopesByPermission: Object.fromEntries([...effective.read, ...effective.action].map(key => [key, { buildingIds: [], cashbookIds: [] }])) };
  const port = (prepare, finalize, result = { ok: true }) => ({
    async [prepare](_token, operation, input) { seen.push([operation, input]); return Object.freeze({}); },
    async [finalize](_token, _receipt, options) { if (typeof result === 'function') return result(options); return result; },
  });
  const make = (zaloResult) => createBroker({
    authority: { identifyConnection: async () => ({ connectionId: CONNECTION }), resolve: async () => identity, checkUnchanged: async () => {} },
    dependencyScope: scope, audit: async () => {}, limits: { maxResultBytes: 65_536 },
    tasks: port('prepareTask', 'finalizeTask'), domains: port('prepareDomain', 'finalizeDomain'), roomPass: port('prepareRoomPass', 'finalizeRoomPass'),
    customers: port('prepareCustomerAction', 'finalizeCustomerAction'), expenses: port('prepareExpenseAction', 'finalizeExpenseAction'),
    schedules: port('prepareSchedule', 'finalizeSchedule'), workMemory: port('prepareMemory', 'finalizeMemory'),
    zaloBroadcasts: port('prepareZaloBroadcast', 'finalizeZaloBroadcast', zaloResult),
  });
  return { make, seen, token: `hc_${'A'.repeat(43)}`, identity };
}

test('broker: cutover hides crm_room_schedule_create/update, lists the broadcast tools, and tools/list stays under 64 KiB', async t => {
  const read = [...ALL_DOMAIN_READ_CAPABILITIES, 'chat_zalo.view', 'rooms.view', 'assistant.memory.read', 'assistant.context.read'];
  const action = ['tasks.create', 'sale_phong.manage_pass_listings', 'customers.create', 'leads.create', 'income_expenses.create',
    'chat_zalo.manage_automation', 'chat_zalo.send', 'assistant.memory.write'];
  const { make, seen, token } = brokerFixture(t, { read, action });
  const broker = make();
  const listed = (await broker.listTools(token)).tools, names = listed.map(value => value.name);
  for (const name of ZALO_BROADCAST_TOOLS.map(value => value.name)) assert.ok(names.includes(name), name);
  assert.deepEqual(names.filter(name => name.startsWith('crm_room_schedule')).sort(),
    ['crm_room_schedule_issues', 'crm_room_schedule_list', 'crm_room_schedule_reconcile', 'crm_room_schedule_revoke']);
  const bytes = Buffer.byteLength(JSON.stringify({ tools: listed }));
  assert.ok(bytes < 65_536, `tools/list ${bytes} bytes`);
  for (const value of SCHEDULE_TOOLS.filter(value => ['crm_room_schedule_list', 'crm_room_schedule_revoke'].includes(value.name)))
    assert.match(value.description, /crm_zalo_broadcast_status\/crm_zalo_broadcast_update/);
  // A retired name is refused even when called directly with a valid payload.
  for (const name of ['crm_room_schedule_create', 'crm_room_schedule_update'])
    await assert.rejects(broker.callTool(token, name, { requestId: id('5'), scheduleId: id('6'), expectedRevision: 1, settings: {} }), error => error.code === 'tool_not_available');
  assert.deepEqual(seen, []);
  t.diagnostic(`tools/list ${listed.length} tools, ${bytes} bytes`);
});

test('broker: gating per call, lost write ACK is zalo_broadcast_outcome_unknown with requestId and never retried', async t => {
  const fixture = brokerFixture(t, { read: ['chat_zalo.view'], action: ['chat_zalo.manage_automation'] });
  let finalizeCalls = 0;
  const broker = fixture.make(options => { finalizeCalls++; options.onDispatch(); throw new Error('lost ACK'); });
  const names = (await broker.listTools(fixture.token)).tools.map(value => value.name);
  assert.deepEqual(names.filter(name => name.startsWith('crm_zalo_broadcast')), ['crm_zalo_broadcast_status', 'crm_zalo_broadcast_recipients',
    'crm_zalo_broadcast_cancel', 'crm_zalo_broadcast_update']);
  await assert.rejects(broker.callTool(fixture.token, 'crm_zalo_broadcast_send', { requestId: B, conversationIds: [A] }), error => error.code === 'tool_not_available');
  const update = { requestId: B, expectedVersion: V, enabled: false };
  await assert.rejects(broker.callTool(fixture.token, 'crm_zalo_broadcast_update', update),
    error => error.code === 'zalo_broadcast_outcome_unknown' && error.requestId === B && error.status === 503);
  assert.equal(finalizeCalls, 1);
  await assert.rejects(broker.callTool(fixture.token, 'crm_zalo_broadcast_cancel', { oneshotId: C }),
    error => error.code === 'zalo_broadcast_outcome_unknown' && error.requestId === undefined);
  await assert.rejects(broker.callTool(fixture.token, 'crm_zalo_broadcast_update', { requestId: B, expectedVersion: V }), error => error.code === 'invalid_request');
  for (const patch of [{ enabled: true }, { addConversationIds: [A] }])
    await assert.rejects(broker.callTool(fixture.token, 'crm_zalo_broadcast_update', { requestId: B, expectedVersion: V, ...patch }),
      error => error.code === 'forbidden', 'turning sends on needs chat_zalo.send');
  assert.equal(finalizeCalls, 2, 'invalid or unauthorised input never reaches SQL');
  fixture.identity.effective = { read: [], action: ['chat_zalo.manage_automation'] };
  assert.deepEqual((await broker.listTools(fixture.token)).tools.filter(value => value.name.startsWith('crm_zalo_broadcast')), []);
  await assert.rejects(broker.callTool(fixture.token, 'crm_zalo_broadcast_status', {}), error => error.code === 'tool_not_available');
});
