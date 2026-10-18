// Tiến trình con của wave2-registry.test.mjs: broker THẬT với sổ thăm dò hai báo cáo khác khoá.
// In một dòng JSON: byte tools/list đủ quyền (khi hai tool meta đã hiện), kết quả ca forbidden/được phép.
import { register } from 'node:module';
register('./wave2-probe-hooks.fixture.mjs', import.meta.url);
// external-group-mount nạp trước broker (vòng import, như tool-argument-shape.test.mjs).
await import('./external-group-mount.mjs');
const { createBroker } = await import('./broker.mjs');
const { createDependencyScope } = await import('./dependency-scope.mjs');
const { HERMES_READ_CAPABILITIES, HERMES_ACTION_CAPABILITIES } = await import('./capability-contract.mjs');
const { ALL_DOMAIN_READ_CAPABILITIES, domainInput } = await import('./domain-contract.mjs');
const { W2 } = await import('./wave2-registry.mjs');

const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const scopes = [];
function broker(read, action = []) {
  const scope = createDependencyScope(); scopes.push(scope);
  const CONNECTION = id('a'), BUILDING = id('f'), seen = [];
  const identity = { row: { id: CONNECTION, assistantId: id('b'), userId: id('c'), organizationId: id('d'), expiresAt: Date.now() + 600_000,
    epoch: 1, state: 'active', restrictions: { read, action } }, effective: { read, action }, isSuperadmin: false,
  policyEpoch: 'a'.repeat(64), contextVersion: 'b'.repeat(64), assistantScopeIds: [id('e')],
  scopesByPermission: Object.fromEntries([...read, ...action].map(key => [key, { buildingIds: [BUILDING], cashbookIds: [] }])) };
  const authority = { identifyConnection: async () => ({ connectionId: CONNECTION }), resolve: async () => identity, checkUnchanged: async () => {} };
  const port = (prepare, finalize) => ({ async [prepare](_token, operation, input) { seen.push([operation, input]); return Object.freeze({}); },
    async [finalize]() { return { ok: true }; } });
  const value = createBroker({ authority, dependencyScope: scope, audit: async () => {}, limits: { maxResultBytes: 65_536 },
    tasks: port('prepareTask', 'finalizeTask'), domains: port('prepareDomain', 'finalizeDomain'), roomPass: port('prepareRoomPass', 'finalizeRoomPass'),
    customers: port('prepareCustomerAction', 'finalizeCustomerAction'), expenses: port('prepareExpenseAction', 'finalizeExpenseAction'),
    schedules: port('prepareSchedule', 'finalizeSchedule'), workMemory: port('prepareMemory', 'finalizeMemory'),
    zaloBroadcasts: port('prepareZaloBroadcast', 'finalizeZaloBroadcast'), roomReads: port('prepareAvailableRooms', 'finalizeAvailableRooms'),
    externalGroups: { authority, createService: () => ({}) } });
  return { broker: value, seen, token: `hc_${'A'.repeat(43)}` };
}
const outcome = async promise => promise.then(() => 'ok', error => error.code ?? String(error));
try {
  const read = [...new Set([...HERMES_READ_CAPABILITIES, ...ALL_DOMAIN_READ_CAPABILITIES, 'chat_zalo.view', 'rooms.view', 'assistant.context.read', 'assistant.memory.read'])];
  const action = [...new Set([...HERMES_ACTION_CAPABILITIES, 'tasks.create', 'tasks.edit', 'tasks.delete', 'sale_phong.manage_pass_listings', 'customers.create',
    'leads.create', 'income_expenses.create', 'chat_zalo.manage_automation', 'chat_zalo.send', 'assistant.memory.write'])];
  const full = broker(read, action), listed = (await full.broker.listTools(full.token)).tools;
  const args = { report: 'probe_rows', params: { month: '2026-10' } };
  const other = broker(['materials.view']), denied = await outcome(other.broker.callTool(other.token, 'crm_read_report', args));
  const otherList = (await other.broker.listTools(other.token)).tools.map(tool => tool.name);
  const allowed = broker(['vehicles.view']), allowedOutcome = await outcome(allowed.broker.callTool(allowed.token, 'crm_read_report', args));
  const none = broker(['customers.view']), noneList = (await none.broker.listTools(none.token)).tools.map(tool => tool.name);
  // Hook chỉ thay sổ gói A; sổ gói khác (đã có báo cáo thật) giữ nguyên ⇒ chỉ in báo cáo gói A.
  const reportsA = Object.keys(W2.reports).filter(reportId => W2.reports[reportId].package === 'a');
  console.log(JSON.stringify({ reports: reportsA, fullCount: listed.length, fullBytes: Buffer.byteLength(JSON.stringify({ tools: listed })),
    fullNames: listed.map(tool => tool.name), otherList, denied, deniedSeen: other.seen, allowed: allowedOutcome, allowedSeen: allowed.seen,
    expectedInput: domainInput('report', args), noneList }));
} finally { for (const scope of scopes) await scope.close(); }
