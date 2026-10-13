import test from 'node:test';
import assert from 'node:assert/strict';
import { compareCatalog } from '../compare-hermes-crm-catalog.mjs';

function fixture() {
  const action = { id: 'rooms.fixture', version: 1, permission: 'rooms.view', risk: 'L1', executorKind: 'fixture', consentRequired: 'none', previewRpc: 'preview_room', executeRpc: 'execute_room', pinAlways: false };
  return {
    inventory: { schemaVersion: 2, actions: [action], rpcReferences: [{ name: 'preview_room', source: { path: 'fixture.ts', line: 1 }, role: 'literal_call' }, { name: null, source: { path: 'fixture.ts', line: 2 }, expression: 'name', role: 'dynamic_call' }] },
    catalog: { captured_at: '2026-10-12T00:00:00Z', transaction_read_only: 'on', test_marker_present: true, test_marker_digest: 'a'.repeat(32),
      functions: [{ schema: 'public', name: 'preview_room', arguments: 'organization_id uuid', result: 'jsonb', definition_digest_md5: 'b'.repeat(32), security_definer: true, authenticated_execute: true, anon_execute: false, service_role_execute: false }],
      registry: [{ ...action, enabled: true, grantable: false }], flags: [{ state: 'enabled' }], settings: { org_rows: 1 }, migrations: ['20260727095000'] },
  };
}
test('reports observed matches without claiming RLS or deployment parity', () => {
  const { inventory, catalog } = fixture();
  const result = compareCatalog(inventory, catalog);
  assert.equal(result.status, 'catalog_compared');
  assert.equal(result.summary.actionMatches, 1);
  assert.equal(result.summary.unresolvedCallsites, 1);
  assert.equal(result.summary.ledgerLatest, '20260727095000');
  assert(result.limitations.some(value => value.includes('function-body equality')));
  assert(result.limitations.some(value => value.includes('never replay')));
});
test('missing public RPC is a gap even if private function has the same name', () => {
  const { inventory, catalog } = fixture(); catalog.functions[0].schema = 'app_private';
  const result = compareCatalog(inventory, catalog);
  assert.equal(result.status, 'gaps_observed'); assert.equal(result.rpcComparison[0].status, 'missing');
});
test('all public overload ACLs are retained, not collapsed to one permissive row', () => {
  const { inventory, catalog } = fixture(); catalog.functions.push({ ...catalog.functions[0], arguments: 'organization_id uuid, scope text', authenticated_execute: false });
  assert.equal(compareCatalog(inventory, catalog).rpcComparison[0].overloads.length, 2);
});
test('retired-only RPC absence is explicit and does not demand resurrection', () => {
  const { inventory, catalog } = fixture(); inventory.rpcReferences[0].retired = true; catalog.functions[0].name = 'unrelated';
  const result = compareCatalog(inventory, catalog); assert.equal(result.status, 'catalog_compared'); assert.equal(result.rpcComparison[0].status, 'missing');
});
test('maker submit descriptions resolve to a private helper, never a public API', () => {
  const { inventory, catalog } = fixture();
  inventory.actions[0].executorKind = catalog.registry[0].executorKind = 'maker_submit_v1';
  Object.assign(inventory.rpcReferences[0], { role: 'catalog_preview', actionId: 'rooms.fixture' });
  Object.assign(catalog.functions[0], { schema: 'app_private', authenticated_execute: false });
  const result = compareCatalog(inventory, catalog);
  assert.equal(result.status, 'catalog_compared'); assert.equal(result.rpcComparison[0].expectedSchema, 'app_private');
  catalog.functions[0].authenticated_execute = true;
  assert.equal(compareCatalog(inventory, catalog).rpcComparison[0].status, 'internal_helper_exposed');
});
test('a literal client call cannot hide behind a maker-submit description', () => {
  const { inventory, catalog } = fixture();
  inventory.actions[0].executorKind = catalog.registry[0].executorKind = 'maker_submit_v1';
  Object.assign(inventory.rpcReferences[0], { role: 'catalog_preview', actionId: 'rooms.fixture' });
  inventory.rpcReferences.push({ name: 'preview_room', role: 'literal_call' });
  Object.assign(catalog.functions[0], { schema: 'app_private', authenticated_execute: false });
  assert.equal(compareCatalog(inventory, catalog).status, 'gaps_observed');
});
test('registry permission drift cannot pass', () => {
  const { inventory, catalog } = fixture(); catalog.registry[0].permission = 'rooms.delete';
  const result = compareCatalog(inventory, catalog); assert.equal(result.status, 'gaps_observed'); assert.equal(result.actionComparison[0].differences[0].field, 'permission');
});
test('missing and extra actions cannot pass', () => {
  const { inventory, catalog } = fixture(); catalog.registry[0].id = 'unmapped';
  const result = compareCatalog(inventory, catalog); assert.equal(result.status, 'gaps_observed'); assert.equal(result.actionComparison[0].status, 'missing'); assert.deepEqual(result.extraRegistryActions, ['unmapped']);
});
for (const [label, mutate] of [
  ['wrong schema', d => { d.inventory.schemaVersion = 1; }],
  ['empty source', d => { d.inventory.actions = []; }],
  ['empty catalog', d => { d.catalog.functions = []; }],
  ['empty registry', d => { d.catalog.registry = []; }],
  ['empty ledger', d => { d.catalog.migrations = []; }],
  ['non TEST', d => { d.catalog.test_marker_present = false; }],
  ['write transaction', d => { d.catalog.transaction_read_only = 'off'; }],
  ['missing capture time', d => { delete d.catalog.captured_at; }],
  ['missing marker digest', d => { delete d.catalog.test_marker_digest; }],
  ['duplicate action', d => { d.catalog.registry.push(d.catalog.registry[0]); }],
  ['duplicate source', d => { d.inventory.actions.push(d.inventory.actions[0]); }],
  ['malformed RPC', d => { delete d.inventory.rpcReferences[1].name; }],
  ['unknown flag', d => { d.catalog.flags[0].state = 'oops'; }],
  ['incomplete ACL', d => { delete d.catalog.functions[0].authenticated_execute; }],
  ['incomplete function digest', d => { delete d.catalog.functions[0].definition_digest_md5; }],
]) test(`rejects ${label}`, () => { const d = fixture(); mutate(d); assert.throws(() => compareCatalog(d.inventory, d.catalog)); });
