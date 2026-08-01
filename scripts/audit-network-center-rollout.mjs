#!/usr/bin/env node
import {
  executeManagementQuery,
  isEntrypoint,
  loadManagementConfig,
  loadManifest,
  redactSecrets,
  sha256,
} from "./network-center-rollout-common.mjs";
import { catalogDescriptorSql } from "./apply-network-center-rollout.mjs";

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

export function classifyCatalog(manifest, presentNames) {
  const present = new Set(presentNames);
  const foundation = manifest.preflight?.required ?? [];
  if (foundation.some((item) => !present.has(item))) return { state: "foundation_mismatch", prefix: 0 };
  let prefix = 0;
  for (const migration of manifest.migrations) {
    const required = migration.postApply?.required ?? [];
    const complete = required.every((item) => present.has(item));
    if (!complete) break;
    prefix += 1;
  }
  const allNetworkDescriptors = [
    ...new Set(manifest.migrations.flatMap((migration) => migration.postApply?.required ?? [])),
  ];
  const expectedAtPrefix = new Set(
    manifest.migrations.slice(0, prefix).flatMap((migration) => migration.postApply?.required ?? []),
  );
  const unexpected = allNetworkDescriptors.filter(
    (item) => present.has(item) && !expectedAtPrefix.has(item),
  );
  if (unexpected.length) return { state: "divergent", prefix, unexpected };
  if (prefix === 0) return { state: "not_started", prefix };
  if (prefix === manifest.migrations.length) return { state: "complete", prefix };
  return { state: "prefix", prefix };
}

export async function auditRollout({ manifest, query, mode = "post-apply" } = {}) {
  const descriptors = [
    ...(manifest.preflight?.required ?? []),
    ...manifest.migrations.flatMap((migration) => migration.postApply?.required ?? []),
    ...(manifest.postApply?.required ?? []),
  ];
  const uniqueDescriptors = [...new Set(descriptors)];
  const result = await query(buildAuditSql(uniqueDescriptors));
  const rows = rowsFromManagementResult(result);
  const presentNames = rows.filter((row) => row.present === true).map((row) => row.name);
  const classification = classifyCatalog(manifest, presentNames);
  if (mode === "preflight" && !["not_started", "prefix"].includes(classification.state)) {
    throw new Error(`Network Center preflight catalog is ${classification.state}`);
  }
  if (mode === "post-apply" && classification.state !== "complete") {
    throw new Error(`Network Center post-apply catalog is ${classification.state}`);
  }
  return {
    ...classification,
    catalogFingerprint: sha256(JSON.stringify([...presentNames].sort())),
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
