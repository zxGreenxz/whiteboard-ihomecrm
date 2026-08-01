#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  MANIFEST_PATH,
  RECEIPT_ROOT,
  REPO_ROOT,
  executeManagementQuery,
  isEntrypoint,
  loadManagementConfig,
  loadManifest,
  redactSecrets,
  sha256,
} from "./network-center-rollout-common.mjs";

export const NETWORK_CENTER_ROLLOUT_LOCK = "ihomecrm:network-center-rollout:v1";

export function assertLiveApplyAllowed(environment = process.env, dryRun = false) {
  if (!dryRun && String(environment.GITHUB_ACTIONS).toLowerCase() === "true") {
    throw new Error("Live Network Center rollout is disabled in GitHub Actions/CI");
  }
}

export function stripMigrationTransactionControl(source, path = "migration.sql") {
  const lines = String(source).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  let beginCount = 0;
  let commitCount = 0;
  let notifyCount = 0;
  const body = lines.filter((line) => {
    if (/^\s*BEGIN\s*;\s*(?:--.*)?$/i.test(line)) {
      beginCount += 1;
      return false;
    }
    if (/^\s*COMMIT\s*;\s*(?:--.*)?$/i.test(line)) {
      commitCount += 1;
      return false;
    }
    if (/^\s*NOTIFY\s+pgrst\s*,\s*['"]reload schema['"]\s*;\s*(?:--.*)?$/i.test(line)) {
      notifyCount += 1;
      return false;
    }
    return true;
  });
  const hasNoWrapper = beginCount === 0 && commitCount === 0 && notifyCount === 0;
  const hasCanonicalWrapper = beginCount === 1 && commitCount === 1 && notifyCount <= 1;
  if (!hasNoWrapper && !hasCanonicalWrapper) {
    throw new Error(`Unsafe transaction wrapper in ${path}`);
  }
  return body.join("\n").trim();
}

export function catalogDescriptorSql(descriptor) {
  const parts = String(descriptor).split(":");
  const [kind, ...rest] = parts.length === 1 ? ["table", ...parts] : parts;
  const identity = rest.join(":").replaceAll("'", "''");
  if (kind === "function") return `to_regprocedure('${identity}') IS NOT NULL`;
  if (kind === "table" || kind === "view") return `to_regclass('${identity}') IS NOT NULL`;
  if (kind === "function_service_only") {
    return `EXISTS (
      SELECT 1
      FROM pg_proc function_row
      WHERE function_row.oid = to_regprocedure('${identity}')
        AND function_row.prosecdef
        AND pg_get_userbyid(function_row.proowner) = 'postgres'
        AND EXISTS (
          SELECT 1
          FROM aclexplode(coalesce(
            function_row.proacl,
            acldefault('f', function_row.proowner)
          )) function_acl
          JOIN pg_roles grantee ON grantee.oid = function_acl.grantee
          WHERE grantee.rolname = 'service_role'
            AND function_acl.privilege_type = 'EXECUTE'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM aclexplode(coalesce(
            function_row.proacl,
            acldefault('f', function_row.proowner)
          )) function_acl
          LEFT JOIN pg_roles grantee ON grantee.oid = function_acl.grantee
          WHERE function_acl.privilege_type = 'EXECUTE'
            AND (
              function_acl.grantee = 0
              OR grantee.rolname NOT IN ('postgres', 'service_role')
            )
        )
    )`;
  }
  if (kind === "rls") {
    return `EXISTS (
      SELECT 1 FROM pg_class relation
      WHERE relation.oid = to_regclass('${identity}')
        AND relation.relrowsecurity
    )`;
  }
  if (kind === "column" && rest.length === 2) {
    const table = rest[0].replaceAll("'", "''");
    const column = rest[1].replaceAll("'", "''");
    return `EXISTS (
      SELECT 1 FROM pg_attribute attribute
      WHERE attribute.attrelid = to_regclass('${table}')
        AND attribute.attname = '${column}'
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    )`;
  }
  if (kind === "index" && rest.length === 2) {
    const schema = rest[0].replaceAll("'", "''");
    const index = rest[1].replaceAll("'", "''");
    return `EXISTS (
      SELECT 1
      FROM pg_class index_relation
      JOIN pg_namespace index_schema ON index_schema.oid = index_relation.relnamespace
      WHERE index_schema.nspname = '${schema}'
        AND index_relation.relname = '${index}'
        AND index_relation.relkind = 'i'
    )`;
  }
  if (kind === "realtime" && rest.length === 2) {
    const schema = rest[0].replaceAll("'", "''");
    const table = rest[1].replaceAll("'", "''");
    return `EXISTS (
      SELECT 1 FROM pg_publication_tables publication_table
      WHERE publication_table.pubname = 'supabase_realtime'
        AND publication_table.schemaname = '${schema}'
        AND publication_table.tablename = '${table}'
    )`;
  }
  if (kind === "rows_rollout_off" && identity === "public.network_site_settings") {
    return `(
      EXISTS (
        SELECT 1 FROM pg_attribute attribute
        WHERE attribute.attrelid = to_regclass('public.network_site_settings')
          AND attribute.attname = 'rollout_state'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.network_site_settings settings
        WHERE to_jsonb(settings)->>'rollout_state' IS DISTINCT FROM 'OFF'
      )
    )`;
  }
  throw new Error(`Unsupported catalog descriptor: ${descriptor}`);
}

export function buildCatalogReadSql(required = []) {
  const rows = required.length
    ? required
        .map((descriptor) => {
          const escaped = descriptor.replaceAll("'", "''");
          return `('${escaped}', ${catalogDescriptorSql(descriptor)})`;
        })
        .join(",\n      ")
    : "('__foundation__', true)";
  return `BEGIN READ ONLY;
SELECT coalesce(array_agg(name ORDER BY name) FILTER (WHERE present), '{}'::text[]) AS objects
FROM (VALUES
      ${rows}
) required(name, present);
COMMIT;`;
}

function buildCatalogAssertion(required = [], label = "catalog", forbidden = []) {
  if (!required.length && !forbidden.length) return "";
  const condition = [
    ...required.map(catalogDescriptorSql),
    ...forbidden.map((descriptor) => `NOT (${catalogDescriptorSql(descriptor)})`),
  ].join(" AND ");
  const escapedLabel = label.replaceAll("'", "''");
  return `DO $catalog$
BEGIN
  IF NOT (${condition}) THEN
    RAISE EXCEPTION 'Network Center ${escapedLabel} mismatch';
  END IF;
END;
$catalog$;`;
}

function buildCatalogReadback(required = []) {
  const values = required.map((item) => `'${item.replaceAll("'", "''")}'`).join(", ");
  return `SELECT ARRAY[${values}]::text[] AS objects;`;
}

export function buildMigrationTransaction({
  migration,
  body,
  priorRequired = [],
  futureForbidden = [],
}) {
  const postRequired = migration.postApply?.required ?? [];
  const postForbidden = futureForbidden.filter((descriptor) => !postRequired.includes(descriptor));
  return `BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
DO $lock$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('${NETWORK_CENTER_ROLLOUT_LOCK}', 0)) THEN
    RAISE EXCEPTION 'Another Network Center rollout transaction holds the advisory lock';
  END IF;
END;
$lock$;
${buildCatalogAssertion(priorRequired, "expected prefix", futureForbidden)}
-- Network Center rollout stage: ${migration.path}
${body}
${buildCatalogAssertion(postRequired, `postcondition for ${migration.path}`, postForbidden)}
${buildCatalogReadback(postRequired)}
NOTIFY pgrst, 'reload schema';
COMMIT;`;
}

function resultObjects(result) {
  if (Array.isArray(result?.objects)) return result.objects;
  if (Array.isArray(result)) {
    for (const candidate of result) {
      if (Array.isArray(candidate?.objects)) return candidate.objects;
      if (Array.isArray(candidate?.result)) {
        for (const row of candidate.result) if (Array.isArray(row?.objects)) return row.objects;
      }
    }
  }
  return [];
}

function assertRequiredObjects(result, required, label) {
  if (!required?.length) return;
  const present = new Set(resultObjects(result));
  const missing = required.filter((item) => !present.has(item));
  if (missing.length) throw new Error(`${label} catalog mismatch: missing ${missing.join(", ")}`);
}

function catalogFingerprint(required, result) {
  const objects = resultObjects(result);
  return sha256(JSON.stringify({ required: [...required].sort(), objects: [...objects].sort() }));
}

export async function writeReceiptAtomic(
  receipt,
  { receiptRoot = RECEIPT_ROOT, allowExisting = false } = {},
) {
  const projectRef = String(receipt.projectRef ?? "");
  const manifestDigest = String(receipt.manifestDigest ?? "");
  const migrationDigest = String(receipt.migrationSha256 ?? "");
  if (!/^[a-z0-9]{8,32}$/.test(projectRef) || !/^[a-f0-9]{64}$/.test(manifestDigest)) {
    throw new Error("Invalid receipt identity");
  }
  if (!/^[a-f0-9]{64}$/.test(migrationDigest)) throw new Error("Invalid receipt migration digest");
  const directory = join(receiptRoot, projectRef, manifestDigest);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(
    directory,
    `${String(receipt.ordinal ?? 0).padStart(2, "0")}-${migrationDigest}.json`,
  );
  const contents = `${JSON.stringify(receipt)}\n`;
  if (Buffer.byteLength(contents) >= 4096) throw new Error("Rollout receipt exceeds 4096 bytes");
  const temporary = join(directory, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, target);
    return target;
  } catch (error) {
    if (error?.code === "EEXIST") {
      if (!allowExisting) throw new Error(`Rollout receipt already exists: ${target}`);
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error(`Existing rollout receipt is not a regular file: ${target}`);
      }
      let existing;
      try {
        existing = JSON.parse(await readFile(target, "utf8"));
      } catch {
        throw new Error(`Existing rollout receipt is invalid: ${target}`);
      }
      const identityFields = [
        "schemaVersion",
        "manifestDigest",
        "projectRef",
        "reviewedGitSha",
        "releaseSha",
        "ordinal",
        "migration",
        "migrationSha256",
      ];
      const identityMatches = identityFields.every((field) => existing[field] === receipt[field]);
      if (
        !identityMatches ||
        !["committed", "reconciled-existing"].includes(existing.outcome)
      ) {
        throw new Error(`Existing rollout receipt does not match the reviewed release: ${target}`);
      }
      return target;
    }
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function applyRollout({
  manifest,
  migrationBodies,
  query,
  writeReceipt = writeReceiptAtomic,
  now = () => new Date(),
  secrets = [],
  manifestDigest = sha256(JSON.stringify(manifest)),
  releaseSha = "unknown",
  startIndex = 0,
  reconcileExisting = false,
} = {}) {
  const foundationRequired = manifest.preflight?.required ?? [];
  const preflightResult = await query(buildCatalogReadSql(foundationRequired));
  assertRequiredObjects(preflightResult, foundationRequired, "Preflight");
  let beforeFingerprint = catalogFingerprint(foundationRequired, preflightResult);
  const applied = [];
  let priorRequired = [...foundationRequired];
  const allNetworkDescriptors = [
    ...new Set([
      ...manifest.migrations.flatMap((migration) => migration.postApply?.required ?? []),
      ...(manifest.postApply?.required ?? []),
    ]),
  ];
  if (reconcileExisting) {
    for (let index = 0; index < startIndex; index += 1) {
      const migration = manifest.migrations[index];
      const afterRequired = migration.postApply?.required ?? priorRequired;
      const observedAt = now().toISOString();
      const afterFingerprint = sha256(JSON.stringify([...afterRequired].sort()));
      const receipt = {
        schemaVersion: 1,
        manifestDigest,
        projectRef: manifest.projectRef ?? "unknownref",
        reviewedGitSha: manifest.reviewedGitSha ?? "unknown",
        releaseSha,
        ordinal: index + 1,
        migration: migration.path,
        migrationSha256: migration.sha256,
        outcome: "reconciled-existing",
        startedAt: observedAt,
        observedAt,
        beforeCatalogFingerprint: beforeFingerprint,
        afterCatalogFingerprint: afterFingerprint,
      };
      await writeReceipt(receipt, { allowExisting: true });
      applied.push(receipt);
      priorRequired = afterRequired;
      beforeFingerprint = afterFingerprint;
    }
  }
  for (let index = 0; index < manifest.migrations.length; index += 1) {
    const migration = manifest.migrations[index];
    if (index < startIndex) {
      priorRequired = migration.postApply?.required ?? priorRequired;
      continue;
    }
    const startedAt = now().toISOString();
    try {
      const source = migrationBodies.get(migration.path);
      if (source === undefined) throw new Error(`Migration body missing: ${migration.path}`);
      const sql = buildMigrationTransaction({
        migration,
        body: stripMigrationTransactionControl(source, migration.path),
        priorRequired,
        futureForbidden: allNetworkDescriptors.filter(
          (descriptor) => !priorRequired.includes(descriptor),
        ),
      });
      const stageResult = await query(sql);
      const afterRequired = migration.postApply?.required ?? priorRequired;
      const afterFingerprint = catalogFingerprint(afterRequired, stageResult);
      const receipt = {
        schemaVersion: 1,
        manifestDigest,
        projectRef: manifest.projectRef ?? "unknownref",
        reviewedGitSha: manifest.reviewedGitSha ?? "unknown",
        releaseSha,
        ordinal: index + 1,
        migration: migration.path,
        migrationSha256: migration.sha256,
        outcome: "committed",
        startedAt,
        observedAt: now().toISOString(),
        beforeCatalogFingerprint: beforeFingerprint,
        afterCatalogFingerprint: afterFingerprint,
      };
      try {
        await writeReceipt(receipt);
      } catch (receiptError) {
        throw new Error(
          `Database stage committed but receipt reconciliation is required for ${migration.path}: ${receiptError?.message}`,
        );
      }
      applied.push(receipt);
      beforeFingerprint = afterFingerprint;
      priorRequired = afterRequired;
    } catch (error) {
      const expectedPrefix = sha256(
        manifest.migrations.slice(0, index).map((item) => item.sha256).join(":"),
      );
      const forwardFix =
        `forward-fix: node scripts/apply-network-center-rollout.mjs --resume-from ${migration.path} ` +
        `--expected-prefix ${expectedPrefix}. Use an additive forward-fix only; do not down-migrate.`;
      throw new Error(redactSecrets(`${forwardFix} Cause: ${error?.message}`, secrets));
    }
  }
  const postRequired = manifest.postApply?.required ?? [];
  const postResult = await query(buildCatalogReadSql(postRequired));
  assertRequiredObjects(postResult, postRequired, "Post-apply");
  return { applied, postApplyFingerprint: catalogFingerprint(postRequired, postResult) };
}

function prefixDigest(manifest, prefix) {
  return sha256(manifest.migrations.slice(0, prefix).map((item) => item.sha256).join(":"));
}

export function resolveResumeIndex(manifest, classification, options = {}) {
  if (classification.state === "divergent" || classification.state === "foundation_mismatch") {
    throw new Error(
      `Network Center catalog is ${classification.state}; automatic rollout is blocked. ` +
        "Create and review an additive forward-fix; do not down-migrate.",
    );
  }
  if (classification.state === "not_started") {
    if (options.resumeFrom || options.expectedPrefix) {
      throw new Error("A fresh catalog must not use resume arguments");
    }
    return 0;
  }
  if (classification.state === "complete") return manifest.migrations.length;
  if (classification.state !== "prefix") {
    throw new Error(`Unsupported Network Center catalog state: ${classification.state}`);
  }
  const prefix = classification.prefix;
  const next = manifest.migrations[prefix];
  const expectedPrefix = prefixDigest(manifest, prefix);
  if (
    !next ||
    options.resumeFrom !== next.path ||
    options.expectedPrefix !== expectedPrefix
  ) {
    throw new Error(
      `Catalog already contains exact prefix ${prefix}. Reconcile receipts, then resume explicitly: ` +
        `node scripts/apply-network-center-rollout.mjs --resume-from ${next?.path ?? "<complete>"} ` +
        `--expected-prefix ${expectedPrefix}`,
    );
  }
  return prefix;
}

function parseArgs(argv) {
  const options = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--revision") options.revision = argv[++index];
    else if (arg === "--resume-from") options.resumeFrom = argv[++index];
    else if (arg === "--expected-prefix") options.expectedPrefix = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  assertLiveApplyAllowed(process.env, options.dryRun);
  const manifest = await loadManifest();
  const { validateRolloutCli } = await import("./validate-network-center-rollout.mjs");
  const validation = await validateRolloutCli({ revision: options.revision, manifest });
  let requestedStartIndex = 0;
  if (options.resumeFrom) {
    requestedStartIndex = manifest.migrations.findIndex((item) => item.path === options.resumeFrom);
    if (requestedStartIndex < 0 || !/^[a-f0-9]{64}$/.test(options.expectedPrefix ?? "")) {
      throw new Error("Resume requires a manifest migration and exact --expected-prefix digest");
    }
    const actualPrefix = prefixDigest(manifest, requestedStartIndex);
    if (actualPrefix !== options.expectedPrefix) throw new Error("Resume prefix digest mismatch");
  }
  if (options.dryRun) {
    process.stdout.write(
      `Dry run validated ${manifest.migrations.length - requestedStartIndex} ordered migrations for ${validation.releaseSha}\n`,
    );
    return;
  }
  const config = await loadManagementConfig();
  if (config.projectRef !== manifest.projectRef) throw new Error("Supabase project mismatch");
  const { auditRollout } = await import("./audit-network-center-rollout.mjs");
  const query = (sql) => executeManagementQuery({ ...config, sql });
  const classification = await auditRollout({ manifest, mode: "classify", query });
  const startIndex = resolveResumeIndex(manifest, classification, options);
  const migrationBodies = new Map(
    await Promise.all(
      manifest.migrations.map(async (migration) => [
        migration.path,
        await readFile(join(REPO_ROOT, migration.path), "utf8"),
      ]),
    ),
  );
  const rawManifest = await readFile(MANIFEST_PATH);
  const result = await applyRollout({
    manifest,
    migrationBodies,
    query,
    secrets: [config.pat],
    manifestDigest: createHash("sha256").update(rawManifest).digest("hex"),
    releaseSha: validation.releaseSha,
    startIndex,
    reconcileExisting: startIndex > 0,
  });
  process.stdout.write(
    `Applied ${result.applied.length} Network Center migration(s); postApply=${result.postApplyFingerprint}\n`,
  );
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error) => {
    console.error(redactSecrets(error?.message ?? error));
    process.exitCode = 1;
  });
}
