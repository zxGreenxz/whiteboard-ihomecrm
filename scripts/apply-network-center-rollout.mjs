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
import { loadMigrationSources } from "./network-center-function-bodies.mjs";

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

// ---------------------------------------------------------------------------
// policy: descriptors
// ---------------------------------------------------------------------------
//
// WHY THIS KIND EXISTS
// `rls:` says row level security is switched ON for a table. It says nothing
// about which policies gate it, so a stage whose entire effect is CREATE POLICY
// was invisible to the rollout: it added no catalog descriptor, owned no
// function body, and assertStagesObservable refused the manifest rather than let
// it be skipped in silence forever. pg_policy makes policies perfectly
// observable, so the vocabulary - not the guard - was the thing that was wrong.
//
// WHAT THE DESCRIPTOR PINS
//   policy:<schema>.<table>:<name>:<permissive|restrictive>:<cmd>:<roles>:<digest>
// Existence alone is not enough to be worth asserting. A policy that still
// exists under the reviewed name but has become `PERMISSIVE FOR ALL TO public`
// is not the policy anybody reviewed - it is a tenant boundary that has been
// deleted and replaced with a decoy. So the descriptor pins, in one atomic
// claim:
//   - the exact relation and the exact policy name (a different policy on the
//     same table cannot satisfy it, and a rename makes it MISSING);
//   - PERMISSIVE vs RESTRICTIVE, because a RESTRICTIVE hide-the-sandbox policy
//     downgraded to PERMISSIVE stops ANDing and the rows come back;
//   - the command, because FOR SELECT widened to FOR ALL changes what it gates;
//   - the exact role set, because a policy with a role list is not evaluated at
//     all for roles outside it - retargeting it is equivalent to dropping it;
//   - a digest of the USING and WITH CHECK expressions, because
//     `USING (true)` under the reviewed name is the cheapest possible neuter.
const POLICY_COMMAND_CODES = new Map([
  ["all", "*"],
  ["select", "r"],
  ["insert", "a"],
  ["update", "w"],
  ["delete", "d"],
]);

const POLICY_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const POLICY_RELATION = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/;
const POLICY_ROLE_LIST = /^[A-Za-z_][A-Za-z0-9_]*(?:,[A-Za-z_][A-Za-z0-9_]*)*$/;

// pg_get_expr deparses a policy predicate through the CURRENT search_path: with
// `public` on the path a call comes back as `is_super_admin()`, without it as
// `public.is_super_admin()`. Both name the same function - a policy expression
// is stored as a parse tree of OIDs and is never re-resolved at read time - so
// the difference is cosmetic, but an unnormalized digest would depend on WHO
// read the catalog rather than on what the policy says. The manifest generator
// measures under `SET search_path = pg_catalog` and the rollout probes under the
// connection default, so the two would disagree on every predicate that calls a
// function. Stripping the schema qualifier in front of a function call makes the
// digest a property of the predicate. Verified on PostgreSQL 17: the same 34
// policies digest identically under `pg_catalog`, under `public, pg_catalog` and
// under the connection default, and identically again on production.
export function normalizedPolicyExpressionSql(expression) {
  return (
    `regexp_replace(coalesce(${expression}, ''), ` +
    `'(?<![A-Za-z0-9_."])[a-z_][a-z0-9_]*\\.(?=[a-z_][a-z0-9_]*\\()', '', 'g')`
  );
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
  if (kind === "policy" && rest.length === 6) {
    const [relation, name, permissive, command, roles, qualDigest] = rest;
    // Everything here is spelled with `:` separators, so a component that could
    // contain one has no unambiguous spelling and is refused rather than
    // approximated. The same goes for a role list, which is `,`-joined. This is
    // deliberately fail-closed: the manifest generator aborts on a policy it
    // cannot name exactly, instead of pinning a descriptor that means something
    // slightly different from the object it was measured from.
    if (!POLICY_RELATION.test(relation)) {
      throw new Error(`Unsupported catalog descriptor (policy relation): ${descriptor}`);
    }
    if (!POLICY_IDENTIFIER.test(name)) {
      throw new Error(`Unsupported catalog descriptor (policy name): ${descriptor}`);
    }
    if (permissive !== "permissive" && permissive !== "restrictive") {
      throw new Error(`Unsupported catalog descriptor (policy permissiveness): ${descriptor}`);
    }
    if (!POLICY_COMMAND_CODES.has(command)) {
      throw new Error(`Unsupported catalog descriptor (policy command): ${descriptor}`);
    }
    if (!POLICY_ROLE_LIST.test(roles)) {
      throw new Error(`Unsupported catalog descriptor (policy roles): ${descriptor}`);
    }
    if (!/^[a-f0-9]{64}$/.test(qualDigest)) {
      throw new Error(`Unsupported catalog descriptor (policy predicate digest): ${descriptor}`);
    }
    // to_regclass returns NULL for a table that does not exist yet, so the whole
    // EXISTS is simply false. That matters as much as the presence half: every
    // descriptor a stage has not yet introduced is asserted ABSENT inside the
    // rollout transaction, and a descriptor that ERRORED instead of returning
    // false would abort the stage on a healthy database.
    return `EXISTS (
      SELECT 1
      FROM pg_policy policy_row
      WHERE policy_row.polrelid = to_regclass('${relation}')
        AND policy_row.polname = '${name}'
        AND policy_row.polpermissive = ${permissive === "permissive"}
        AND policy_row.polcmd = '${POLICY_COMMAND_CODES.get(command)}'
        AND coalesce(
              CASE
                WHEN policy_row.polroles = '{0}'::oid[] THEN 'public'
                ELSE (
                  SELECT string_agg(policy_role.rolname, ',' ORDER BY policy_role.rolname)
                  FROM pg_roles policy_role
                  WHERE policy_role.oid = ANY (policy_row.polroles)
                )
              END, '') = '${roles}'
        AND encode(
              sha256(convert_to(
                ${normalizedPolicyExpressionSql("pg_get_expr(policy_row.polqual, policy_row.polrelid)")}
                || chr(10) ||
                ${normalizedPolicyExpressionSql("pg_get_expr(policy_row.polwithcheck, policy_row.polrelid)")},
                'UTF8')),
              'hex') = '${qualDigest}'
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

export function resolveReceiptPath(receipt, receiptRoot = RECEIPT_ROOT) {
  const projectRef = String(receipt.projectRef ?? "");
  const manifestDigest = String(receipt.manifestDigest ?? "");
  const migrationDigest = String(receipt.migrationSha256 ?? "");
  if (!/^[a-z0-9]{8,32}$/.test(projectRef) || !/^[a-f0-9]{64}$/.test(manifestDigest)) {
    throw new Error("Invalid receipt identity");
  }
  if (!/^[a-f0-9]{64}$/.test(migrationDigest)) throw new Error("Invalid receipt migration digest");
  const directory = join(receiptRoot, projectRef, manifestDigest);
  return {
    directory,
    target: join(
      directory,
      `${String(receipt.ordinal ?? 0).padStart(2, "0")}-${migrationDigest}.json`,
    ),
  };
}

/**
 * Refuse a stage whose receipt already exists, BEFORE the transaction runs.
 *
 * Receipts are immutable by design, so a pre-existing one used to be discovered
 * only after the stage had committed - the exact commit-then-fail shape this
 * rollout hardens against. It is not hypothetical: the 2026-08-02 no-op run
 * minted a full set of "reconciled-existing" receipts for work it never did, and
 * every one of them would have bricked the genuine apply that had to follow.
 */
export async function assertReceiptAbsent(identity, { receiptRoot = RECEIPT_ROOT } = {}) {
  const { target } = resolveReceiptPath(identity, receiptRoot);
  try {
    await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return target;
    throw error;
  }
  throw new Error(
    `Rollout receipt already exists for ${identity.migration ?? `ordinal ${identity.ordinal}`}: ${target}. ` +
      "Receipts are written only after a stage commits, so either this stage already ran under this " +
      "manifest digest or the receipt records work that was never performed. Confirm against the " +
      "database and remove the stale receipt before re-running.",
  );
}

export async function writeReceiptAtomic(
  receipt,
  { receiptRoot = RECEIPT_ROOT, allowExisting = false } = {},
) {
  const { directory, target } = resolveReceiptPath(receipt, receiptRoot);
  await mkdir(directory, { recursive: true, mode: 0o700 });
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
  reserveReceipt = assertReceiptAbsent,
  receiptRoot = RECEIPT_ROOT,
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
    // Outside the try: a receipt conflict is not a partial apply and must not be
    // dressed up as one with a forward-fix instruction.
    await reserveReceipt(
      {
        projectRef: manifest.projectRef ?? "unknownref",
        manifestDigest,
        ordinal: index + 1,
        migration: migration.path,
        migrationSha256: migration.sha256,
      },
      { receiptRoot },
    );
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
  return {
    applied,
    committed: applied.filter((receipt) => receipt.outcome === "committed"),
    reconciled: applied.filter((receipt) => receipt.outcome === "reconciled-existing"),
    total: manifest.migrations.length,
    postApplyFingerprint: catalogFingerprint(postRequired, postResult),
  };
}

/**
 * Report what ran, not what the manifest contains.
 *
 * The old message printed manifest.migrations.length unconditionally, so the
 * 2026-08-02 run that executed nothing announced "Applied 15 Network Center
 * migration(s)". A rollout tool that reports work it did not do is worse than
 * one that errors: it converts a recoverable skip into a false record.
 */
/**
 * Reconciliation receipts record stages an operator explicitly resumed past.
 * A rollout that resumes past nothing must mint nothing: the 2026-08-02 run
 * started at index 15 of 15 and wrote a full set of "reconciled-existing"
 * receipts for work it had not done, every one of which would then have blocked
 * the genuine apply that had to follow.
 */
export function shouldReconcileExisting(startIndex, total) {
  return startIndex > 0 && startIndex < total;
}

export function formatApplySummary({
  committed = [],
  reconciled = [],
  total = 0,
  postApplyFingerprint = "",
} = {}) {
  const parts = [`Applied ${committed.length} of ${total} Network Center migration(s)`];
  if (reconciled.length) parts.push(`reconciled ${reconciled.length} pre-existing stage(s)`);
  if (!committed.length) parts.push("no migration SQL was executed");
  return `${parts.join("; ")}; postApply=${postApplyFingerprint}`;
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
  // `complete` now means every stage is PROVED applied: its catalog objects are
  // present and every function body it owns matches the reviewed release. It no
  // longer means "the objects exist, so presumably everything ran" - which is
  // what silently swallowed a body-only forward fix.
  if (classification.state === "complete") {
    if (options.resumeFrom || options.expectedPrefix) {
      throw new Error(
        "Network Center rollout is already complete: every stage's catalog objects and function " +
          "bodies match the reviewed release, so there is nothing to resume. Drop --resume-from and " +
          "--expected-prefix, or author an additive forward-fix migration.",
      );
    }
    return manifest.migrations.length;
  }
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
    // A body-blocked stage lands here on purpose. It is resumable, but only
    // through the same explicit two-flag gate every other resume goes through:
    // the new evidence widens what the tool can SEE, never what it will do
    // without being told.
    const drifted = (classification.bodyMismatches ?? [])
      .filter((item) => item.migration === classification.bodyBlockedAt)
      .map((item) => item.qualifiedName)
      .slice(0, 3)
      .join(", ");
    const reason = classification.bodyBlockedAt
      ? `Stage ${classification.bodyBlockedAt} has not been applied: its catalog objects are all present ` +
        `but the live function body differs from the reviewed release (${drifted}). `
      : `Catalog already contains exact prefix ${prefix}. `;
    throw new Error(
      `${reason}Reconcile receipts, then resume explicitly: ` +
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
      `Dry run validated ${manifest.migrations.length - requestedStartIndex} of ` +
        `${manifest.migrations.length} ordered migrations for ${validation.releaseSha}; ` +
        "no database was contacted and nothing was applied\n",
    );
    return;
  }
  const config = await loadManagementConfig();
  if (config.projectRef !== manifest.projectRef) throw new Error("Supabase project mismatch");
  const { auditRollout } = await import("./audit-network-center-rollout.mjs");
  const query = (sql) => executeManagementQuery({ ...config, sql });
  // One read of the pinned files feeds both the evidence and the SQL, so the
  // bytes the classifier reasons about are the bytes that would be executed.
  const migrationBodies = await loadMigrationSources(manifest, REPO_ROOT);
  const classification = await auditRollout({
    manifest,
    mode: "classify",
    query,
    sources: migrationBodies,
  });
  const startIndex = resolveResumeIndex(manifest, classification, options);
  const rawManifest = await readFile(MANIFEST_PATH);
  const result = await applyRollout({
    manifest,
    migrationBodies,
    query,
    secrets: [config.pat],
    manifestDigest: createHash("sha256").update(rawManifest).digest("hex"),
    releaseSha: validation.releaseSha,
    startIndex,
    reconcileExisting: shouldReconcileExisting(startIndex, manifest.migrations.length),
  });
  process.stdout.write(`${formatApplySummary(result)}\n`);
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error) => {
    console.error(redactSecrets(error?.message ?? error));
    process.exitCode = 1;
  });
}
