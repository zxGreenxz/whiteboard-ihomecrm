// Tiến trình con của public-text-guard.test.mjs: broker THẬT với sổ thăm dò (hook chỉ thay sổ gói A bằng
// probe_rows/probe_org, không private). In một dòng JSON: đọc báo cáo không private không nhiễm, báo cáo
// private (gói B thật) thì nhiễm.
import { register } from 'node:module';
register('./wave2-probe-hooks.fixture.mjs', import.meta.url);
await import('./external-group-mount.mjs');
const { createBroker } = await import('./broker.mjs');
const { createDependencyScope } = await import('./dependency-scope.mjs');
const { W2 } = await import('./wave2-registry.mjs');

const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const CONNECTION = id('a'), token = `hc_${'A'.repeat(43)}`, writes = [];
const read = ['vehicles.view', 'cashbooks.view'], action = ['sale_phong.manage_pass_listings'];
const identity = { row: { id: CONNECTION, assistantId: id('b'), userId: id('c'), organizationId: id('d'), expiresAt: Date.now() + 600_000,
  epoch: 1, state: 'active', restrictions: { read, action } }, effective: { read, action }, isSuperadmin: false,
policyEpoch: 'a'.repeat(64), contextVersion: 'b'.repeat(64), assistantScopeIds: [id('e')],
scopesByPermission: Object.fromEntries([...read, ...action].map(key => [key, { buildingIds: [id('f')], cashbookIds: [] }])) };
const scope = createDependencyScope();
try {
  const broker = createBroker({ authority: { identifyConnection: async () => ({ connectionId: CONNECTION }), resolve: async () => identity, checkUnchanged: async () => {} },
    dependencyScope: scope, audit: async () => {},
    domains: { async prepareDomain() { return Object.freeze({}); }, async finalizeDomain() { return { items: [] }; } },
    roomPass: { async prepareRoomPass(_token, operation, input) { writes.push([operation, input]); return Object.freeze({}); },
      async finalizeRoomPass(_token, _receipt, { onDispatch }) { onDispatch(); return { outcome: 'applied' }; } } });
  const outcome = async args => JSON.parse((await broker.callTool(token, 'crm_room_pass_upsert', args)).content[0].text).outcome;
  const upsert = n => ({ requestId: id(n), roomId: id('6'), salePolicy: 'Điện 3.5k/số' });
  await broker.callTool(token, 'crm_read_report', { report: 'probe_rows', params: { month: '2026-10' } });
  const afterPublicReport = await outcome(upsert('1'));
  await broker.callTool(token, 'crm_read_report', { report: 'cashbooks' });
  const afterPrivateReport = await outcome(upsert('2'));
  console.log(JSON.stringify({ probePrivate: W2.reports.probe_rows.private, afterPublicReport, afterPrivateReport, writes: writes.length }));
} finally { await scope.close(); }
