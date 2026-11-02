import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { runDisposableLocalClusterMatrix } from './network-center-disposable-db.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const migrationPath = 'supabase/migrations/20261022145352_network_center_camera_monitoring_v1.sql';
export const CAMERA_ALERTS_MIGRATION_PATH = 'supabase/migrations/20261102072602_network_center_camera_alerts_v1.sql';

export async function runCameraProof({ repoRoot = root, environment = process.env, mutation } = {}) {
  const source = await readFile(resolve(repoRoot, migrationPath), 'utf8');
  const migration = mutation ? mutation(source) : source;
  if (mutation && source === migration) throw new Error('Camera proof mutation did not change its input');
  const proof = await readFile(new URL('./__tests__/network-center-camera-runtime.sql', import.meta.url), 'utf8');
  return runDisposableLocalClusterMatrix({ repoRoot, environment,
    buildSql: ({ localProof }) => `
DO $bind$ BEGIN IF NOT EXISTS(SELECT FROM app_private.network_center_disposable_proof WHERE proof_nonce='${localProof.proofNonce}') THEN RAISE EXCEPTION 'Wrong disposable target'; END IF; END $bind$;
-- This harness models network RBAC; can_access_building is supplied as the
-- same scoped predicate, not claimed as full production/PostgREST evidence.
${migration}
${migration}
${proof}`,
    parseVerdict: (output) => {
      if (!output.includes('CAMERA_PROOF_OK')) throw new Error('Camera proof did not finish');
      return { passed: true, migrationAppliedTwice: true, productionPostgrestVerified: false };
    },
  });
}

// Helpers the alert evaluator calls are loaded from their SHIPPED source, not
// re-typed: a cron path that silently depends on a JWT-only helper is exactly
// the failure a stub would hide (the recipient resolver runs without claims).
const REAL_HELPERS = [
  ['supabase/baseline/schema.sql', /CREATE FUNCTION app_private\.raise_malformed_override\([\s\S]*?\n\$\$;/u],
  ['supabase/baseline/schema.sql', /CREATE FUNCTION app_private\.authorize_tenant_action_v3\([\s\S]*?\n\$\$;/u],
  ['supabase/baseline/schema.sql', /CREATE FUNCTION public\.demo_user_ids\(\)[\s\S]*?\n\$\$;/u],
  ['supabase/migrations/20260731061000_org_timezone_today.sql', /CREATE OR REPLACE FUNCTION app_private\.org_timezone_v1\(p_organization_id uuid\)[\s\S]*?\n\$function\$;/u],
  ['supabase/migrations/20260827140000_chu_cong_ty_doi_co_kqkd_phieu_bo_coc.sql', /CREATE OR REPLACE FUNCTION app_private\.ie_actor_is_company_owner_v1\(p_org uuid, p_actor uuid\)[\s\S]*?\n\$fn\$;/u],
  ['supabase/migrations/20260928042301_lifecycle_reminder_cron.sql', /CREATE OR REPLACE FUNCTION app_private\.lifecycle_reminder_service_jwt_v1\(\)[\s\S]*?END \$credential\$;/u],
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

/**
 * Camera alert proof (plan 2026-11-01 §6.1): camera monitoring, the platform
 * surface (incl. pg_cron/pg_net/Vault stand-ins), the real helpers, then the
 * alert migration applied twice, then every scenario in one rolled-back
 * transaction per case.
 */
export async function runCameraAlertsProof({ repoRoot = root, environment = process.env, mutation } = {}) {
  const camera = await readFile(resolve(repoRoot, migrationPath), 'utf8');
  const source = await readFile(resolve(repoRoot, CAMERA_ALERTS_MIGRATION_PATH), 'utf8');
  const alerts = mutation ? mutation(source) : source;
  if (mutation && source === alerts) throw new Error('Camera alert proof mutation did not change its input');
  const platform = await readFile(new URL('./__tests__/network-center-camera-alerts-platform.sql', import.meta.url), 'utf8');
  const helpers = await loadRealAlertHelpers(repoRoot);
  const proof = await readFile(new URL('./__tests__/network-center-camera-alerts-runtime.sql', import.meta.url), 'utf8');
  return runDisposableLocalClusterMatrix({ repoRoot, environment,
    buildSql: ({ localProof }) => `
DO $bind$ BEGIN IF NOT EXISTS(SELECT FROM app_private.network_center_disposable_proof WHERE proof_nonce='${localProof.proofNonce}') THEN RAISE EXCEPTION 'Wrong disposable target'; END IF; END $bind$;
${camera}
${platform}
${helpers}
${alerts}
${alerts}
${proof}`,
    parseVerdict: (output) => {
      if (!output.includes('CAMERA_ALERTS_PROOF_OK')) throw new Error('Camera alert proof did not finish');
      return { passed: true, migrationAppliedTwice: true, productionPostgrestVerified: false };
    },
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const run = process.argv.includes('--alerts') ? runCameraAlertsProof : runCameraProof;
  run().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
