#!/usr/bin/env node
import {
  REPO_ROOT,
  executeManagementQuery,
  isEntrypoint,
  loadManagementConfig,
  loadManifest,
  redactSecrets,
  sha256,
} from "./network-center-rollout-common.mjs";
import { catalogDescriptorSql } from "./apply-network-center-rollout.mjs";
import {
  buildFunctionBodyProbeSql,
  evaluateStageFunctionBodies,
  expectedFunctionNames,
  functionBodyFingerprint,
  liveFunctionBodiesFromResult,
  loadMigrationSources,
  resolveStageFunctionExpectations,
} from "./network-center-function-bodies.mjs";

export const NETWORK_CENTER_AUDIT_SQL = `BEGIN READ ONLY;
SELECT current_database() AS database_name,
  current_user AS database_user,
  txid_current_if_assigned() IS NULL AS no_write_transaction_assigned;
COMMIT;`;

export function buildAuditSql(descriptors) {
  const rows = descriptors
    .map((descriptor) => `('${descriptor.replaceAll("'", "''")}', ${catalogDescriptorSql(descriptor)})`)
    .join(",\n    ");
  return `BEGIN READ ONLY;
SELECT name, present
FROM (VALUES
    ${rows || "('__empty__', true)"}
) catalog(name, present)
ORDER BY name;
COMMIT;`;
}

function rowsFromManagementResult(result) {
  if (!Array.isArray(result)) return [];
  const rows = [];
  for (const candidate of result) {
    if (typeof candidate?.name === "string") rows.push(candidate);
    if (Array.isArray(candidate?.result)) rows.push(...candidate.result);
  }
  return rows;
}

function describeBodyMismatches(mismatches, limit = 3) {
  return mismatches
    .slice(0, limit)
    .map((item) => `${item.qualifiedName} (owned by ${item.migration})`)
    .join(", ");
}

/**
 * Classify the live database against the reviewed release.
 *
 * `evidence` carries function-body digests. Without it this answers only "do the
 * objects exist", which is what let a stage that replaced a function body look
 * complete before it had ever run. With it, a stage counts as applied only when
 * its catalog descriptors are present AND every function body it owns at the end
 * of the release matches what is live.
 *
 * Divergence is still judged against the CATALOG prefix, deliberately. A stale
 * body means "this stage has not run yet", not "somebody created objects out of
 * order", and calling it divergent would block the very forward-fix the operator
 * needs to apply. The one case that IS divergence is a stage held back by a body
 * whose catalog objects are already present: resuming there could not work,
 * because the in-lock precondition requires those objects to be absent.
 */
export function classifyCatalog(manifest, presentNames, evidence) {
  const present = new Set(presentNames);
  const foundation = manifest.preflight?.required ?? [];
  const { satisfied: bodySatisfied, mismatches: bodyMismatches } = evaluateStageFunctionBodies(
    manifest,
    evidence,
  );
  const base = { bodyMismatches, bodyChecked: Boolean(evidence) };
  if (foundation.some((item) => !present.has(item))) {
    return { state: "foundation_mismatch", prefix: 0, ...base };
  }
  let catalogPrefix = 0;
  for (const migration of manifest.migrations) {
    const required = migration.postApply?.required ?? [];
    if (!required.every((item) => present.has(item))) break;
    catalogPrefix += 1;
  }
  let prefix = 0;
  while (prefix < catalogPrefix && bodySatisfied.get(manifest.migrations[prefix].path) !== false) {
    prefix += 1;
  }
  const allNetworkDescriptors = [
    ...new Set(manifest.migrations.flatMap((migration) => migration.postApply?.required ?? [])),
  ];
  const expectedAtCatalogPrefix = new Set(
    manifest.migrations
      .slice(0, catalogPrefix)
      .flatMap((migration) => migration.postApply?.required ?? []),
  );
  const unexpected = allNetworkDescriptors.filter(
    (item) => present.has(item) && !expectedAtCatalogPrefix.has(item),
  );
  if (unexpected.length) return { state: "divergent", prefix, unexpected, ...base };
  if (prefix < catalogPrefix) {
    const blocked = manifest.migrations[prefix];
    const alreadyRequired = new Set(
      manifest.migrations.slice(0, prefix).flatMap((migration) => migration.postApply?.required ?? []),
    );
    const introduced = (blocked.postApply?.required ?? []).filter(
      (descriptor) => !alreadyRequired.has(descriptor),
    );
    if (introduced.length) {
      return {
        state: "divergent",
        prefix,
        unexpected: introduced,
        bodyBlockedAt: blocked.path,
        ...base,
      };
    }
    return { state: "prefix", prefix, bodyBlockedAt: blocked.path, ...base };
  }
  if (prefix === 0) return { state: "not_started", prefix, ...base };
  if (prefix === manifest.migrations.length) return { state: "complete", prefix, ...base };
  return { state: "prefix", prefix, ...base };
}

export async function auditRollout({
  manifest,
  query,
  mode = "post-apply",
  sources,
  repoRoot = REPO_ROOT,
} = {}) {
  const descriptors = [
    ...(manifest.preflight?.required ?? []),
    ...manifest.migrations.flatMap((migration) => migration.postApply?.required ?? []),
    ...(manifest.postApply?.required ?? []),
  ];
  const uniqueDescriptors = [...new Set(descriptors)];
  const result = await query(buildAuditSql(uniqueDescriptors));
  const rows = rowsFromManagementResult(result);
  const presentNames = rows.filter((row) => row.present === true).map((row) => row.name);
  // Body evidence is not optional here. A catalog-only audit is exactly the gate
  // that passed while public.network_center_admin_status_v1 raised 42703 on
  // every call.
  const expectations = resolveStageFunctionExpectations(
    manifest,
    sources ?? (await loadMigrationSources(manifest, repoRoot)),
  );
  const names = expectedFunctionNames(expectations);
  const live = liveFunctionBodiesFromResult(await query(buildFunctionBodyProbeSql(names)));
  const classification = classifyCatalog(manifest, presentNames, { expectations, live });
  const bodyReason = classification.bodyMismatches.length
    ? `; function bodies differ from the reviewed release: ${describeBodyMismatches(classification.bodyMismatches)}`
    : "";
  if (mode === "preflight" && !["not_started", "prefix"].includes(classification.state)) {
    throw new Error(`Network Center preflight catalog is ${classification.state}${bodyReason}`);
  }
  if (mode === "post-apply" && classification.state !== "complete") {
    throw new Error(`Network Center post-apply catalog is ${classification.state}${bodyReason}`);
  }
  return {
    ...classification,
    catalogFingerprint: sha256(JSON.stringify([...presentNames].sort())),
    functionBodyFingerprint: functionBodyFingerprint(expectations, live),
    functionsVerified: names.length,
    present: presentNames,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--preflight") options.mode = "preflight";
    else if (argv[index] === "--post-apply") options.mode = "post-apply";
    else if (argv[index] === "--revision") options.revision = argv[++index];
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!options.mode) throw new Error("Choose exactly one of --preflight or --post-apply");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = await loadManifest();
  const { validateRolloutCli } = await import("./validate-network-center-rollout.mjs");
  await validateRolloutCli({ revision: options.revision, manifest });
  const config = await loadManagementConfig();
  if (config.projectRef !== manifest.projectRef) throw new Error("Supabase project mismatch");
  const result = await auditRollout({
    manifest,
    mode: options.mode,
    query: (sql) => executeManagementQuery({ ...config, sql }),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error) => {
    console.error(redactSecrets(error?.message ?? error));
    process.exitCode = 1;
  });
}
