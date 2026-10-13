#!/usr/bin/env node
// Offline comparison of static inventory with metadata captured by the existing
// db-query --env test lane. Presence/ACL is not JWT/RLS or function-body parity.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ACTION_FIELDS = ['version', 'permission', 'risk', 'executorKind', 'consentRequired', 'previewRpc', 'executeRpc', 'pinAlways'];
const sha = value => createHash('sha256').update(value).digest('hex');
const required = (condition, message) => { if (!condition) throw new Error(message); };
const nonempty = (value, label) => required(Array.isArray(value) && value.length > 0, `${label} must be nonempty`);

export function compareCatalog(inventory, catalog, identity = {}) {
  required(inventory?.schemaVersion === 2, 'Inventory schemaVersion 2 required');
  nonempty(inventory.actions, 'inventory.actions');
  nonempty(inventory.rpcReferences, 'inventory.rpcReferences');
  required(catalog?.transaction_read_only === 'on' && catalog.test_marker_present === true,
    'Read-only TEST marker required; production is not a substitute');
  required(typeof catalog.test_marker_digest === 'string' && /^[a-f0-9]{32}$/.test(catalog.test_marker_digest), 'TEST marker digest required');
  required(Number.isFinite(Date.parse(catalog.captured_at)), 'Capture time required');
  nonempty(catalog.functions, 'catalog.functions');
  nonempty(catalog.registry, 'catalog.registry');
  nonempty(catalog.migrations, 'catalog.migrations');
  nonempty(catalog.flags, 'catalog.flags');
  for (const fn of catalog.functions) {
    required(['public', 'app_private'].includes(fn.schema) && typeof fn.name === 'string' && fn.name.length > 0
      && typeof fn.arguments === 'string' && typeof fn.result === 'string'
      && /^[a-f0-9]{32}$/.test(fn.definition_digest_md5 ?? ''), 'Invalid function identity or digest');
    required(['security_definer', 'authenticated_execute', 'anon_execute', 'service_role_execute'].every(key => typeof fn[key] === 'boolean'),
      'Function ACL observation incomplete');
  }
  const observed = new Map();
  for (const action of catalog.registry) {
    required(typeof action.id === 'string' && !observed.has(action.id), 'Duplicate or invalid registry action');
    observed.set(action.id, action);
  }
  const sourceIds = new Set();
  const actionComparison = inventory.actions.map(action => {
    required(typeof action.id === 'string' && !sourceIds.has(action.id), 'Duplicate or invalid source action');
    sourceIds.add(action.id);
    const actual = observed.get(action.id);
    const differences = actual ? ACTION_FIELDS.filter(field => action[field] !== actual[field]).map(field => ({ field, source: action[field] ?? null, observed: actual[field] ?? null })) : [];
    return { id: action.id, retired: action.retired === true, status: !actual ? 'missing' : differences.length ? 'drift' : 'match', differences,
      runtime: actual ? { enabled: actual.enabled, grantable: actual.grantable } : null };
  });
  const references = inventory.rpcReferences;
  const names = [...new Set(references.map(ref => ref.name).filter(name => typeof name === 'string'))].sort();
  required(names.length > 0, 'At least one resolved RPC required');
  const rpcComparison = names.map(name => {
    const calls = references.filter(ref => ref.name === name);
    // maker_submit_v1 is an internal plan executor, not a public PostgREST RPC.
    // Its catalog fields are descriptive (actionCatalog.ts); a direct literal
    // client call with the same name must still be treated as a public caller.
    const internalOnly = calls.every(ref => ['catalog_preview', 'catalog_execute'].includes(ref.role)
      && inventory.actions.find(action => action.id === ref.actionId)?.executorKind === 'maker_submit_v1');
    const expectedSchema = internalOnly ? 'app_private' : 'public';
    const overloads = catalog.functions.filter(fn => fn.schema === expectedSchema && fn.name === name);
    const exposedInternal = internalOnly && (catalog.functions.some(fn => fn.schema === 'public' && fn.name === name)
      || overloads.some(fn => fn.authenticated_execute || fn.anon_execute || fn.service_role_execute));
    return { name, expectedSchema, status: exposedInternal ? 'internal_helper_exposed' : overloads.length ? 'present' : 'missing', retiredOnly: calls.every(ref => ref.retired === true),
      overloads, references: calls.map(ref => ({ source: ref.source, role: ref.role, actionId: ref.actionId ?? null })) };
  });
  const unresolved = references.filter(ref => ref.name === null).map(ref => ({ source: ref.source, expression: ref.expression, role: ref.role }));
  required(references.every(ref => ref.name === null || (typeof ref.name === 'string' && ref.name.length > 0)), 'Invalid RPC reference name');
  const extraRegistryActions = [...observed.keys()].filter(id => !sourceIds.has(id)).sort();
  const flagStates = {};
  for (const flag of catalog.flags) {
    required(['enabled', 'disabled', 'shadow'].includes(flag.state), 'Unknown flag state');
    flagStates[flag.state] = (flagStates[flag.state] ?? 0) + 1;
  }
  const issues = actionComparison.filter(row => row.status !== 'match').length + rpcComparison.filter(row => row.status === 'internal_helper_exposed' || (row.status === 'missing' && !row.retiredOnly)).length + extraRegistryActions.length;
  return {
    schemaVersion: 1, purpose: 'P0.03 TEST catalog observation, not authorization certification',
    identity, capturedAt: catalog.captured_at, target: { environment: 'TEST', markerDigest: catalog.test_marker_digest, readOnly: true },
    status: issues ? 'gaps_observed' : 'catalog_compared',
    summary: { actions: actionComparison.length, actionMatches: actionComparison.filter(row => row.status === 'match').length,
      resolvedRpcNames: names.length, presentRpcNames: rpcComparison.filter(row => row.status === 'present').length,
      unresolvedCallsites: unresolved.length, flagStates, settings: catalog.settings,
      ledgerRows: catalog.migrations.length, ledgerLatest: [...catalog.migrations].sort().at(-1) },
    actionComparison, extraRegistryActions, rpcComparison, unresolved,
    limitations: [
      'Catalog observation is TEST only; production state and feature eligibility are not inferred.',
      'EXECUTE ACL and source permission names do not prove auth.uid/RLS/current scope enforcement.',
      'Presence and recorded function digest do not establish source/deployed function-body equality.',
      'Dynamic helper callsites must be traced separately; action catalog RPCs are enumerated independently.',
      'Frozen legacy migration ledger is not deployment truth; never replay or backfill based on ledger gaps.',
      'No credential, business row, organization identity or private memory is included in this report.',
    ],
  };
}

export function main(argv = process.argv.slice(2)) {
  required(argv.length === 3, 'Usage: node scripts/compare-hermes-crm-catalog.mjs <inventory.json> <db-query-catalog.json> <report.json>');
  const [inventoryPath, catalogPath, reportPath] = argv;
  const inventoryBytes = readFileSync(inventoryPath, 'utf8').replace(/^\uFEFF/, '');
  const catalogBytes = readFileSync(catalogPath, 'utf8').replace(/^\uFEFF/, '');
  const rows = JSON.parse(catalogBytes);
  required(Array.isArray(rows) && rows.length === 1 && rows[0]?.catalog, 'Expected one db-query catalog row');
  const report = compareCatalog(JSON.parse(inventoryBytes), rows[0].catalog,
    { inventorySha256: sha(inventoryBytes), catalogSha256: sha(catalogBytes) });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, ...report.summary }));
  // Observed gaps are evidence requiring disposition, not a successful verifier.
  return report.status === 'gaps_observed' ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = main(); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
