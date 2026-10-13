import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { giaTriVault, layMatKhauDb, layPat } from './vault.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PRODUCTION_REF = 'tryymsxyyckgbrmmvozx';
const REF = /^[a-z0-9]{20}$/;
const requireValue = (condition, code) => { if (!condition) throw new Error(code); };

// Parse before reading any credentials. Unknown spelling must not fall back to prod.
export function parseMigrationTargetArgs(argv) {
  let environment = 'prod', expectedProjectRef;
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (/^--(?:env|expected-project-ref)=/.test(arg)) throw new Error('migration_target_flag_requires_separate_value');
    if (arg !== '--env' && arg !== '--expected-project-ref') continue;
    requireValue(!seen.has(arg), 'duplicate_migration_target_flag');
    seen.add(arg);
    const value = argv[++i];
    requireValue(value && !value.startsWith('--'), 'migration_target_value_required');
    if (arg === '--env') environment = value;
    else expectedProjectRef = value;
  }
  requireValue(['prod', 'test'].includes(environment), 'migration_environment_invalid');
  requireValue(!expectedProjectRef || REF.test(expectedProjectRef), 'migration_expected_ref_invalid');
  return Object.freeze({ environment, expectedProjectRef });
}

export function linkedProductionRef(root = ROOT) {
  try { return readFileSync(join(root, 'supabase', '.temp', 'project-ref'), 'utf8').trim(); }
  catch { return PRODUCTION_REF; }
}

export async function resolveMigrationTarget(options, {
  env = process.env, needsPat = true, needsDatabase = false,
  readValue = name => giaTriVault(name, { env }),
  readProdRef = () => linkedProductionRef(),
  readProdPat = () => layPat({ bien: ['SUPABASE_PAT'], env }),
  readProdPassword = () => layMatKhauDb({ env }),
  resolveDatabase = async supplied => (await import('../db-query.mjs')).dichKetNoi('test', { env: supplied }),
} = {}) {
  const environment = options.environment;
  requireValue(['prod', 'test'].includes(environment), 'migration_environment_invalid');
  const testValue = name => env[name]?.trim() || readValue(name);
  const projectRef = environment === 'test' ? testValue('TEST_SUPABASE_REF') : readProdRef();
  requireValue(REF.test(projectRef ?? ''), 'migration_project_ref_invalid');
  requireValue(environment === 'test' ? projectRef !== PRODUCTION_REF : projectRef === PRODUCTION_REF,
    'migration_environment_ref_mismatch');
  requireValue(!options.expectedProjectRef || options.expectedProjectRef === projectRef, 'migration_target_mismatch');
  const pat = needsPat ? (environment === 'test' ? testValue('TEST_SUPABASE_PAT') : readProdPat()) : null;
  requireValue(!needsPat || pat, 'migration_pat_required');
  let database = null;
  if (needsDatabase) {
    if (environment === 'test') {
      // Only TEST names are ever read on this branch; never load production defaults.
      const supplied = { ...env, TEST_SUPABASE_REF: projectRef,
        TEST_SUPABASE_PAT: pat || testValue('TEST_SUPABASE_PAT'),
        TEST_SUPABASE_DB_PASSWORD: testValue('TEST_SUPABASE_DB_PASSWORD'),
        TEST_SUPABASE_POOLER_HOST: testValue('TEST_SUPABASE_POOLER_HOST') };
      database = await resolveDatabase(supplied);
    } else {
      database = { ref: projectRef, host: 'aws-1-ap-southeast-1.pooler.supabase.com', port: 5432,
        user: `postgres.${projectRef}`, password: readProdPassword() };
    }
    requireValue(database?.ref === projectRef && database.user === `postgres.${projectRef}`,
      'migration_database_target_mismatch');
    requireValue(database.password && database.host && database.port === 5432, 'migration_database_config_invalid');
    database = Object.freeze({ ...database });
  }
  return Object.freeze({ environment, projectRef, pat, database });
}

export function migrationTargetArgs(target) {
  return ['--env', target.environment, '--expected-project-ref', target.projectRef];
}

export function migrationTargetPaths(target, root = ROOT) {
  const directory = target.environment === 'test'
    ? join(root, '.cache', 'migration-targets', 'test', target.projectRef)
    : join(root, 'docs', 'generated');
  return Object.freeze({ directory, inventory: join(directory, 'database-inventory.json'),
    evidence: join(directory, 'schema-change-evidence'), provenance: target.environment === 'test'
      ? join(directory, 'migration-provenance.json') : join(root, 'supabase', 'migration-provenance.json') });
}

export function assertMigrationArtifactTarget(artifact, target) {
  requireValue(artifact?.projectRef === target.projectRef, 'migration_artifact_project_mismatch');
  requireValue(artifact.environment === target.environment ||
    (target.environment === 'prod' && artifact.environment === undefined), 'migration_artifact_environment_mismatch');
}

export async function verifyTestMigrationMarker(target, { query } = {}) {
  requireValue(target.environment === 'test' && target.projectRef !== PRODUCTION_REF, 'test_target_required');
  requireValue(typeof query === 'function', 'test_marker_query_required');
  const [markers] = await query("SELECT to_regclass('test_env.danh_dau') IS NOT NULL AS marker, to_regclass('test_env.active_run') IS NOT NULL AS lease_marker");
  requireValue(markers?.marker === true && markers?.lease_marker === true, 'existing_test_markers_required');
  const rows = await query('SELECT ref FROM test_env.danh_dau');
  requireValue(rows.length === 1 && rows[0].ref === target.projectRef, 'test_marker_target_mismatch');
}

// A successful response proves the entire transaction settled (COMMIT or ROLLBACK).
// A failed/uncertain HTTP write retains active_run, including a dry-run whose
// server-side completion is unknown. Never unlock merely because the client exited.
export async function withMigrationLease(target, work, injected) {
  if (target.environment === 'prod') return work({ assertReady: async () => {}, execute: write => write() });
  let deps = injected;
  if (!deps) {
    const lib = await import('../test-env/lib.mjs');
    const lock = await import('../test-env/lock.mjs');
    const db = target.database;
    requireValue(db?.ref === target.projectRef, 'migration_test_database_required');
    lib.dangKyMatKhau([db]);
    const test = lib.uri(db.host, db.ref);
    deps = { ...lock, test, cred: { testRef: target.projectRef, testPat: target.pat },
      query: sql => lib.psqlJson(test, sql) };
  }
  await verifyTestMigrationMarker(target, deps);
  return deps.withTestLock({ cred: deps.cred, test: deps.test }, async lease => {
    const assertReady = () => deps.assertTestLease(lease, deps.test);
    return work({ assertReady, execute: async write => {
      await assertReady();
      deps.markTestCleanupRequired(lease, deps.test);
      const result = await write();
      if (result?.ok === true) await deps.withTestCleanup(lease, deps.test, async cleanupLease => {
        await deps.assertTestLease(cleanupLease, deps.test);
      });
      return result;
    } });
  });
}
