import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { runDisposableLocalClusterMatrix } from './network-center-disposable-db.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const migrationPath = 'supabase/migrations/20261022145352_network_center_camera_monitoring_v1.sql';
// Forward fix on top of the camera schema: third vendor + vendor in the worker
// connections payload. Applied twice after the base, in production order.
const vendorMigrationPath = 'supabase/migrations/20261110160847_network_center_camera_vendor_hikvision_v1.sql';
// Cảnh báo camera v2 (spec docs/superpowers/plans/2026-11-24-canh-bao-camera-v2.md).
export const CAMERA_ALERTS_MIGRATION_PATH = 'supabase/migrations/20261124171943_network_center_camera_alerts_v2.sql';

export async function runCameraProof({ repoRoot = root, environment = process.env, mutation, vendorMutation } = {}) {
  const source = await readFile(resolve(repoRoot, migrationPath), 'utf8');
  const migration = mutation ? mutation(source) : source;
  if (mutation && source === migration) throw new Error('Camera proof mutation did not change its input');
  const vendorSource = await readFile(resolve(repoRoot, vendorMigrationPath), 'utf8');
  const vendorMigration = vendorMutation ? vendorMutation(vendorSource) : vendorSource;
  if (vendorMutation && vendorSource === vendorMigration) throw new Error('Camera vendor proof mutation did not change its input');
  const proof = await readFile(new URL('./__tests__/network-center-camera-runtime.sql', import.meta.url), 'utf8');
  return runDisposableLocalClusterMatrix({ repoRoot, environment,
    buildSql: ({ localProof }) => `
DO $bind$ BEGIN IF NOT EXISTS(SELECT FROM app_private.network_center_disposable_proof WHERE proof_nonce='${localProof.proofNonce}') THEN RAISE EXCEPTION 'Wrong disposable target'; END IF; END $bind$;
-- This harness models network RBAC; can_access_building is supplied as the
-- same scoped predicate, not claimed as full production/PostgREST evidence.
${migration}
${migration}
${vendorMigration}
${vendorMigration}
${proof}`,
    parseVerdict: (output) => {
      if (!output.includes('CAMERA_PROOF_OK')) throw new Error('Camera proof did not finish');
      return { passed: true, migrationAppliedTwice: true, productionPostgrestVerified: false };
    },
  });
}

// Helpers the alert evaluator and its RPCs call are loaded from their SHIPPED
// source, not re-typed: a cron path that silently depends on a JWT-only helper
// is exactly the failure a stub would hide (recipients resolve without claims).
const REAL_HELPERS = [
  ['supabase/baseline/schema.sql', /CREATE FUNCTION app_private\.raise_malformed_override\([\s\S]*?\n\$\$;/u],
  ['supabase/baseline/schema.sql', /CREATE FUNCTION app_private\.authorize_tenant_action_v3\([\s\S]*?\n\$\$;/u],
  ['supabase/migrations/20261018044046_toi_uu_ham_quyen_rls_v1.sql', /CREATE OR REPLACE FUNCTION public\.demo_user_ids\(\)[\s\S]*?\n\$fn\$;/u],
  ['supabase/migrations/20260731061000_org_timezone_today.sql', /CREATE OR REPLACE FUNCTION app_private\.org_timezone_v1\(p_organization_id uuid\)[\s\S]*?\n\$function\$;/u],
  ['supabase/migrations/20260827140000_chu_cong_ty_doi_co_kqkd_phieu_bo_coc.sql', /CREATE OR REPLACE FUNCTION app_private\.ie_actor_is_company_owner_v1\(p_org uuid, p_actor uuid\)[\s\S]*?\n\$fn\$;/u],
];

export async function loadRealAlertHelpers(repoRoot = root) {
  const bodies = [];
  for (const [file, pattern] of REAL_HELPERS) {
    const match = pattern.exec(await readFile(resolve(repoRoot, file), 'utf8'));
    if (!match) throw new Error(`Real helper ${pattern} not found in ${file}; the alert proof would test a stand-in`);
    bodies.push(`-- shipped source: ${file}\n${match[0]}`);
  }
  return bodies.join('\n\n');
}

/** Tách file ca: phần chung trước dòng `-- @@case <tên>` đầu tiên, rồi từng ca. */
export function splitAlertCases(proof) {
  const [fixture, ...chunks] = proof.split(/^-- @@case /mu);
  const cases = chunks.map((chunk) => {
    const name = chunk.slice(0, chunk.indexOf('\n')).trim();
    return { name, sql: `-- @@case ${chunk}` };
  });
  if (!cases.length || new Set(cases.map((item) => item.name)).size !== cases.length) {
    throw new Error('Camera alert proof cases are missing or duplicated');
  }
  return { fixture, cases };
}

const sharePath = 'supabase/migrations/20261110070438_network_center_camera_share_v1.sql';

/**
 * Camera alert proof (spec 2026-11-24 §8). The runner applies the 20260729
 * Network Center batch on the bootstrap; this applies the camera migrations in
 * production order, the alert migration ONCE on that bare surface (no cron, no
 * Zalo/notification tables: the DDL must not depend on them), then the
 * platform surface (Zalo / notification / cron stand-ins), the real helpers,
 * the alert migration twice more (its cron block now runs), then each case in
 * its own rolled-back transaction. `cases` narrows the run for mutation
 * proofs; omitted means all.
 */
export async function runCameraAlertsProof({ repoRoot = root, environment = process.env, mutation, cases } = {}) {
  const camera = await readFile(resolve(repoRoot, migrationPath), 'utf8');
  const share = await readFile(resolve(repoRoot, sharePath), 'utf8');
  const vendor = await readFile(resolve(repoRoot, vendorMigrationPath), 'utf8');
  const source = await readFile(resolve(repoRoot, CAMERA_ALERTS_MIGRATION_PATH), 'utf8');
  const alerts = mutation ? mutation(source) : source;
  if (mutation && source === alerts) throw new Error('Camera alert proof mutation did not change its input');
  const platform = await readFile(new URL('./__tests__/network-center-camera-alerts-platform.sql', import.meta.url), 'utf8');
  const helpers = await loadRealAlertHelpers(repoRoot);
  const proof = await readFile(new URL('./__tests__/network-center-camera-alerts-runtime.sql', import.meta.url), 'utf8');
  const split = splitAlertCases(proof);
  const selected = cases ? split.cases.filter((item) => cases.includes(item.name)) : split.cases;
  if (cases && selected.length !== cases.length) throw new Error(`Unknown camera alert proof case in ${cases.join(',')}`);
  return runDisposableLocalClusterMatrix({ repoRoot, environment,
    buildSql: ({ localProof }) => `
DO $bind$ BEGIN IF NOT EXISTS(SELECT FROM app_private.network_center_disposable_proof WHERE proof_nonce='${localProof.proofNonce}') THEN RAISE EXCEPTION 'Wrong disposable target'; END IF; END $bind$;
${camera}
${share}
${vendor}
${alerts}
${platform}
${helpers}
${alerts}
${alerts}
${split.fixture}
${selected.map((item) => item.sql).join('\n')}
SELECT 'CAMERA_ALERTS_PROOF_OK' AS verdict, ${selected.length} AS cases;`,
    parseVerdict: (output) => {
      if (!output.includes('CAMERA_ALERTS_PROOF_OK')) throw new Error('Camera alert proof did not finish');
      return { passed: true, cases: selected.map((item) => item.name), migrationAppliedTwice: true, productionPostgrestVerified: false };
    },
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const caseArg = process.argv.find((arg) => arg.startsWith('--cases='));
  const run = process.argv.includes('--alerts')
    ? () => runCameraAlertsProof({ cases: caseArg ? caseArg.slice('--cases='.length).split(',') : undefined })
    : runCameraProof;
  run().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
