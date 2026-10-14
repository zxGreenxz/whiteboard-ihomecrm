import test from 'node:test';
import assert from 'node:assert/strict';
import { createBroker } from './broker.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const current = { row: { id: id('1'), assistantId: id('2'), userId: id('3'), organizationId: id('4'), expiresAt: Date.now() + 600000,
  epoch: 1, state: 'active', restrictions: { read: ['assistant.memory.read'], action: ['assistant.memory.write'] } },
  effective: { read: ['assistant.memory.read'], action: ['assistant.memory.write'] }, isSuperadmin: false,
  policyEpoch: 'a'.repeat(64), contextVersion: 'b'.repeat(64), assistantScopeIds: [],
  scopesByPermission: { 'assistant.memory.read': { buildingIds: [], cashbookIds: [] }, 'assistant.memory.write': { buildingIds: [], cashbookIds: [] } } };
const token = 'hc_' + 'A'.repeat(43);
test('MCP broker discovers memory by current overlay and awaits audit before SQL finalization', async t => {
  const scope = createDependencyScope(); t.after(() => scope.close());
  const events = [], state = { identity: structuredClone(current), unknown: false, denyAudit: false };
  const broker = createBroker({ authority: { identifyConnection: async () => ({ connectionId: current.row.id }), resolve: async () => state.identity, checkUnchanged: async () => {} },
    dependencyScope: scope, audit: async value => { events.push(['audit', value]); if (state.denyAudit) throw new Error('audit_unavailable'); },
    workMemory: { async prepareMemory(_token, operation, input) { events.push(['prepare', operation, input]); return Object.freeze({}); },
      async finalizeMemory(_token, _receipt, options) { events.push(['finalize']); if (state.unknown) { options.onDispatch(); throw new Error('lost ACK'); }
        return { storage: 'crm', contents: [] }; } } });
  assert.equal((await broker.listTools(token)).tools.length, 5);
  events.length = 0;
  const result = await broker.callTool(token, 'crm_work_memory_status', {});
  assert.deepEqual(JSON.parse(result.content[0].text), { storage: 'crm', contents: [] });
  assert.deepEqual(events.map(v => v[0]), ['prepare', 'audit', 'finalize']);
  state.identity.effective.action = [];
  assert.equal((await broker.listTools(token)).tools.length, 2);
  await assert.rejects(broker.callTool(token, 'crm_work_memory_configure', { enabled: true, sharing: 'owner', retentionDays: 30, expectedAccessVersion: 0 }), /tool_not_available/);
  state.identity.effective.action = ['assistant.memory.write']; state.unknown = true;
  await assert.rejects(broker.callTool(token, 'crm_work_memory_configure', { enabled: true, sharing: 'owner', retentionDays: 30, expectedAccessVersion: 0 }), error => error.code === 'memory_outcome_unknown');
  state.unknown = false; state.denyAudit = true; events.length = 0;
  await assert.rejects(broker.callTool(token, 'crm_work_memory_status', {}));
  assert.equal(events.some(event => event[0] === 'finalize'), false);
});
