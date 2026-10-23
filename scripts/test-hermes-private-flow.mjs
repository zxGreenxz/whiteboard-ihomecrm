// TEST-only database/JWT integration. Importing or previewing is offline.
// No provider send, Docker/model process, schema application or JWT fabrication.
// Only a newly generated, restricted TEST login is provisioned and removed.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { CDE_RPCS, cdeExecutionPlan, runCdeChecks, cdeCleanupSql, cdeCountsSql, verifyCdeLiveSurface } from './test-hermes-cde-live.mjs';
import { dichKetNoi } from './db-query.mjs';
import { batBuocDichTest, dangKyMatKhau, uri, psqlJson, lit } from './test-env/lib.mjs';
import { assertTestLease, markTestCleanupRequired, withTestCleanup, withTestLock } from './test-env/lock.mjs';
import { readTestCredentials, fixtureCleanupSql as baseCleanup, testFetch, writeFixtureSql, validateCleanupEvidence } from './test-hermes-broker-authz.mjs';
import { fixturePlan as basePlan, fixtureSetupSql as baseSetup, privateCleanupSql as durableCleanup,
  countsSql as durableCounts, loadFixtureCa, targetMatches, createSerializedLeaseAssertions,
  roleSetupSql, roleCleanupSql, guardedQuery } from './test-hermes-durable-store.mjs';
import { splitSqlStatements } from './network-center-function-bodies.mjs';
import { extractHermesFunctionDefinitions as extractFunctionDefinitions, splitHermesFunctionStatements, verifyTaskFunctionCatalog, verifyCustomerFunctionCatalog, TASK_FUNCTIONS, CUSTOMER_FUNCTIONS } from './hermes-task-function-contract.mjs';
import { HERMES_READ_STANDARD_FUNCTIONS } from './hermes-read-function-specs.mjs';
import { createStorePool } from '../infra/hermes-broker/store-pool.mjs';
import { createSessionCrypto } from '../infra/hermes-broker/session-crypto.mjs';
import { createDurableConnectionStore } from '../infra/hermes-broker/durable-connection-store.mjs';
import { createSupabaseRefreshProvider } from '../infra/hermes-broker/supabase-refresh-provider.mjs';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const TEST_REF = 'hzulujxgonszuleqticb';
export const CANDIDATES = Object.freeze({
  '20261012165523_hermes_zalo_binding_v1.sql': 'd57bf2f2f25dd890951c0de64006f89cf478f401b19f1e422c30f7338c224f54',
  '20261013055055_hermes_zalo_private_command_v1.sql': 'a03b0abd71b5a44c008f67eac361172f6ee2c07823bd158a165b37b759b38347',
  '20261013084000_hermes_private_command_dispatch_v1.sql': 'a03317beaf250c373e1ccea29a921161979b72e4dc4420eb32d3a46714cdde29',
  '20261013095000_hermes_zalo_private_reply_v1.sql': 'db9f4b38f5c7394ca15dfd54c9708def78740b14e4cf5496f7bdab688233369a',
  '20261013115741_hermes_org_policy_options_v1.sql': '67aa0a792195a380be24798c29e7a9fed41c972508422049dd3210c738290b6c',
  '20261013183000_hermes_connection_options_v1.sql': '5ead8ede6928980d83a2df42a4a6e172f15a6d80dc38b73b7a5812aa31db36f1',
});
const FIXTURE_ROLE = /^hermes_store_fixture_[0-9a-f]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const demand = (value, code) => { if (!value) fail(code); };
export const sha = value => createHash('sha256').update(value).digest('hex');
const safeCode = error => /^[a-z][a-z0-9_]{0,80}$/.test(error?.code ?? '') ? error.code : 'assertion_or_dependency_failed';
const sqlIds = values => values.map(value => { demand(UUID.test(value), 'fixture_uuid_invalid'); return lit(value); }).join(',') || 'NULL';
const STORE = Object.freeze({ activate: 'activate', readConnection: 'read_connection',
  claimPrivateCommand: 'claim_private_command', dispatchPrivateCommand: 'dispatch_private_command',
  finishPrivateCommand: 'finish_private_command', failPrivateCommand: 'fail_private_command' });
const RPCS = new Set([...CDE_RPCS, 'get_my_organizations', 'hermes_set_org_policy_v1', 'hermes_prepare_connection_v1',
  'hermes_connection_options_v1', 'hermes_org_policy_options_v1', 'hermes_zalo_binding_v1', 'hermes_zalo_ingress_v1',
  'hermes_zalo_private_command_v1', 'hermes_zalo_private_reply_v1']);

export function executionMode(options = {}) {
  const mode = options.mode ?? 'full';
  demand(mode === 'full' || mode === 'jwt-management' || mode === 'cde', 'fixture_mode_invalid');
  return mode;
}

export function executionPlan(options = {}) {
  const mode = executionMode(options);
  if (mode === 'cde') return { mode: 'offline-plan', ...cdeExecutionPlan() };
  return { mode: 'offline-plan', scope: mode, environment: 'test', projectRef: TEST_REF,
    liveExecuted: false, fullPrivateFlowExecuted: false,
    requires: ['--run', 'all Hermes apply evidence', 'candidate source digests unchanged', 'exclusive TEST lease',
      ...(mode === 'full' ? ['empty worker lease'] : [])],
    proof: mode === 'full'
      ? ['real Auth JWT + PostgREST binding/options/worker ACL', 'restricted dedicated TEST login and executor ACL', 'intake dedup → claim → dispatch → finish → reply gates → revoke', 'exact fixture cleanup']
      : ['real Auth JWT for 3 new actors in 2 fixture orgs', 'connection and policy options with actor/org denials', 'bot management and unobserved challenge ownership/version/revocation', 'exact fixture cleanup'],
    excluded: ['production', 'schema apply', 'real Zalo/model', 'production login deployment proof',
      ...(mode === 'jwt-management' ? ['worker lease ownership or mutations', 'ingress observe and binding confirm', 'private intake/dispatch/reply'] : [])] };
}

export async function runChannelScope(mode, { management, full, cde }) {
  executionMode({ mode });
  return mode === 'cde' ? cde() : mode === 'jwt-management' ? management() : full();
}

export function fixtureRpcDiagnostic(name, status, body) {
  demand(RPCS.has(name), 'fixture_rpc_refused');
  const code = body !== null && typeof body === 'object' ? Object.getOwnPropertyDescriptor(body, 'code')?.value : undefined;
  return { name, status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    code: typeof code === 'string' && /^(?:[0-9A-Z]{5}|PGRST[0-9]{3})$/.test(code) ? code : null };
}

export function fixtureRequestHeaders(path, key, token) {
  demand(path.startsWith('/auth/v1/') || /^\/rest\/v1\/rpc\/[a-z0-9_]+$/.test(path), 'fixture_endpoint_refused');
  return { apikey: key, ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json',
    ...(path.startsWith('/rest/v1/rpc/') ? { 'Content-Profile': 'public' } : {}) };
}

export function parseArguments(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === '--plan')) return { run: false };
  let mode;
  if (args.length >= 3 && args.at(-2) === '--mode') {
    mode = executionMode({ mode: args.at(-1) }); args = args.slice(0, -2);
    if (args.length === 1 && args[0] === '--plan') return { run: false, mode };
  }
  demand(args.length === 5 && args[0] === '--run' && args[1] === '--env' && args[2] === 'test'
    && args[3] === '--expected-project-ref' && args[4] === TEST_REF, 'explicit_test_run_required');
  return { run: true, environment: 'test', expectedProjectRef: TEST_REF, ...(mode ? { mode } : {}) };
}

export function migrationSources() {
  return readdirSync(resolve(ROOT, 'supabase/migrations')).filter(name => /_hermes_.*\.sql$/.test(name)
    || HERMES_READ_STANDARD_FUNCTIONS.some(spec => spec.sourcePath === `supabase/migrations/${name}`)).sort()
    .map(name => ({ name, path: `supabase/migrations/${name}`, bytes: readFileSync(resolve(ROOT, 'supabase/migrations', name)) }));
}

// Follow all local static imports, including reexports, so changed helper code
// invalidates the receipt. External runtime identity is package-lock + Node.
export function captureSourceIdentity() {
  const inputs = new Set(['package-lock.json', '.gitattributes', 'infra/hermes-broker/certs/supabase-ca-2021.crt']);
  const visit = file => {
    const name = relative(ROOT, file).replaceAll('\\', '/');
    demand(!name.startsWith('../'), 'source_outside_repository');
    if (inputs.has(name)) return;
    inputs.add(name);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
      const child = resolve(dirname(file), match[1]);
      if (/\.(?:mjs|js|ts)$/.test(child)) visit(child);
    }
  };
  visit(fileURLToPath(import.meta.url));
  for (const testFile of ['scripts/__tests__/hermes-private-flow.test.mjs', 'scripts/__tests__/hermes-cde-live.test.mjs']) inputs.add(testFile);
  for (const source of migrationSources()) inputs.add(source.path);
  return Object.fromEntries([...inputs].sort().map(file => [file, sha(readFileSync(resolve(ROOT, file)))]));
}

export function validateSchemaEvidence(evidence, source, { reviewedBlob, reviewedBlobBytes } = {}) {
  demand(evidence?.environment === 'test' && evidence.projectRef === TEST_REF && evidence.evidenceComplete === true,
    'schema_evidence_target_invalid');
  demand(evidence.file === source.path && evidence.sha256 === sha(source.bytes)
    && evidence.statementBytes === source.bytes.length && /^[a-f0-9]{40,64}$/.test(reviewedBlob ?? '')
    && /^[a-f0-9]{40,64}$/.test(evidence.reviewedBlob ?? '') && Buffer.isBuffer(reviewedBlobBytes), 'schema_evidence_source_mismatch');
  // This one applied CRLF file predates its -text pin. The historical review
  // blob used Git's LF clean projection, while its receipt SHA/length already
  // bound the exact CRLF SQL sent to TEST. Do not normalize any other source.
  const legacyEol = source.path === 'supabase/migrations/20261012165809_hermes_public_conflict_http_v1.sql'
    && evidence.sha256 === 'b2f087aa089334446dfef3606a6c81ea6ae5b7cf4ec122da0630e30ba4a79e50'
    && evidence.reviewedBlob === '7a42c3c73b224ab31a26575883c455c9a0fd8f15'
    && reviewedBlob === '4264c3269ca1eee9c1a2990c08629b6df885acc8'
    && reviewedBlobBytes.equals(Buffer.from(source.bytes.toString('utf8').replaceAll('\r\n', '\n')));
  // This exact applied schedule retained three CRLFs. The forward lane bound
  // its raw SHA/length separately from Git's LF-clean review blob. Permit only
  // this attested projection, including its byte-preserving -text Git identity.
  const scheduleEol = source.path === 'supabase/migrations/20261014081344_hermes_room_schedule_v1.sql'
    && evidence.sha256 === '874b4debc81af7b4a004793d8888f96e3eca4f29349b85a8e7e12562602aeca2'
    && evidence.statementBytes === 46708
    && evidence.reviewedBlob === '8fe4ed4ea8982e69720b69f668d83edb842ec633'
    && ['8fe4ed4ea8982e69720b69f668d83edb842ec633', '5e47e86308e2f8ebe3b17234d9734227f27ed8e3'].includes(reviewedBlob)
    && reviewedBlobBytes.equals(Buffer.from(source.bytes.toString('utf8').replaceAll('\r\n', '\n')));
  const storedBlob = createHash(evidence.reviewedBlob.length === 64 ? 'sha256' : 'sha1')
    .update(`blob ${reviewedBlobBytes.length}\0`).update(reviewedBlobBytes).digest('hex');
  demand(storedBlob === evidence.reviewedBlob && (legacyEol || scheduleEol
    || (evidence.reviewedBlob === reviewedBlob && reviewedBlobBytes.equals(source.bytes))), 'schema_evidence_source_mismatch');
  demand(Number.isFinite(Date.parse(evidence.appliedAt)) && Date.parse(evidence.appliedAt) <= Date.now()
    && HASH.test(evidence.catalog?.before ?? '') && HASH.test(evidence.catalog?.after ?? ''), 'schema_evidence_incomplete');
  const backup = evidence.authorization;
  demand(backup?.loai === 'bien-nhan-backup' && backup.backupProjectRef === TEST_REF && backup.backupEnvironment === 'test'
    && HASH.test(backup.backupSha256 ?? '') && Number.isFinite(Date.parse(backup.backupCreatedAt))
    && Date.parse(backup.backupCreatedAt) <= Date.parse(evidence.appliedAt)
    && Number.isSafeInteger(backup.backupTablesWithData) && backup.backupTablesWithData >= 450
    && typeof backup.backupFile === 'string' && isAbsolute(backup.backupFile),
  'schema_backup_evidence_required');
  return { file: source.path, sha256: evidence.sha256, reviewedBlob: evidence.reviewedBlob, sourceBlob: reviewedBlob,
    reviewedProjection: legacyEol ? 'pinned_legacy_crlf_to_lf' : scheduleEol ? 'pinned_schedule_crlf_to_lf' : 'exact_bytes', appliedAt: evidence.appliedAt,
    backupSha256: backup.backupSha256, catalogAfter: evidence.catalog.after };
}

// Historical receipts attest the backup verified by the forward lane at apply
// time; retention may retire those dumps. The latest apply must still have its
// own full recovery dump, with no fallback to a surviving older one.
export function validateRecoveryBackup(evidence, { backupRoot = resolve(homedir(), 'ihomecrm-backups', 'test', TEST_REF) } = {}) {
  demand(Array.isArray(evidence) && evidence.length > 0, 'schema_recovery_evidence_required');
  const ordered = [...evidence].sort((a, b) => Date.parse(a.appliedAt) - Date.parse(b.appliedAt));
  demand(ordered.every((item, index) => Number.isFinite(Date.parse(item.appliedAt))
    && (!index || Date.parse(ordered[index - 1].appliedAt) < Date.parse(item.appliedAt))), 'schema_recovery_order_invalid');
  const latest = ordered.at(-1), backup = latest.authorization;
  const file = backup?.backupFile;
  demand(typeof file === 'string' && isAbsolute(file) && relative(resolve(backupRoot), dirname(resolve(file))) === '',
    'schema_recovery_path_invalid');
  const readRegular = path => {
    try {
      const stat = lstatSync(path);
      demand(stat.isFile() && !stat.isSymbolicLink() && relative(resolve(path), realpathSync(path)) === '', 'schema_recovery_path_invalid');
      return readFileSync(path);
    } catch (error) { if (error?.code === 'schema_recovery_path_invalid') throw error; fail('schema_recovery_file_unavailable'); }
  };
  let manifest;
  const manifestBytes = readRegular(`${file}.json`);
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { fail('schema_recovery_manifest_invalid'); }
  demand(manifest?.environment === 'test' && manifest.projectRef === TEST_REF && manifest.kind === 'full'
    && Array.isArray(manifest.excludedTableData) && manifest.excludedTableData.length === 0
    && Number.isSafeInteger(manifest.tablesWithData) && manifest.tablesWithData >= 450
    && manifest.tablesWithData === backup.backupTablesWithData && manifest.sha256 === backup.backupSha256
    && HASH.test(manifest.sha256 ?? '') && manifest.createdAt === backup.backupCreatedAt
    && typeof manifest.file === 'string' && isAbsolute(manifest.file) && relative(resolve(file), resolve(manifest.file)) === ''
    && manifest.reason === `apply ${basename(latest.file)}`, 'schema_recovery_manifest_invalid');
  // The lane names the dump BEFORE pg_dump and records createdAt AFTER it.
  // Completion alone cannot prove that earlier applies were in the snapshot.
  const stamp = basename(file).match(/^ihomecrm-full-(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.dump$/);
  const startedAt = stamp ? `${stamp[1]}${stamp[2]}:${stamp[3]}:${stamp[4]}.${stamp[5]}Z` : '';
  const start = Date.parse(startedAt), end = Date.parse(manifest.createdAt);
  demand(Number.isFinite(start) && new Date(start).toISOString() === startedAt && start <= end
    && end <= Date.parse(latest.appliedAt) && Date.parse(latest.appliedAt) <= Date.now()
    && Number.isSafeInteger(manifest.durationSeconds) && manifest.durationSeconds >= 0
    && manifest.durationSeconds * 1000 <= end - start + 1000
    && ordered.slice(0, -1).every(item => Date.parse(item.appliedAt) <= start), 'schema_recovery_order_invalid');
  const bytes = readRegular(file);
  demand(Number.isSafeInteger(manifest.bytes) && manifest.bytes >= 1024 && manifest.bytes === bytes.length
    && sha(bytes) === backup.backupSha256, 'schema_recovery_dump_mismatch');
  return { migration: latest.file, sha256: backup.backupSha256, manifestSha256: sha(manifestBytes), bytes: bytes.length,
    backupNamedAt: startedAt, backupCompletedAt: manifest.createdAt, appliedAt: latest.appliedAt,
    recovery: 'restore_pre_latest_apply_then_replay_reviewed_latest_migration', restoredByHarness: false };
}

export function requireSchemaEvidence() {
  const sources = migrationSources();
  demand(Object.keys(CANDIDATES).every(name => sources.some(source => source.name === name)), 'candidate_missing');
  const applied = [];
  const migrations = sources.map(source => {
    if (CANDIDATES[source.name]) demand(sha(source.bytes) === CANDIDATES[source.name], 'reviewed_candidate_changed');
    const blob = spawnSync('git', ['hash-object', source.path], { cwd: ROOT, encoding: 'utf8' });
    demand(blob.status === 0, 'source_blob_unavailable');
    const path = resolve(ROOT, '.cache/migration-targets/test', TEST_REF, 'schema-change-evidence', source.name.replace(/\.sql$/, '.json'));
    let evidence; try { evidence = JSON.parse(readFileSync(path, 'utf8')); } catch { fail('schema_apply_evidence_missing'); }
    demand(/^[a-f0-9]{40,64}$/.test(evidence.reviewedBlob ?? ''), 'schema_evidence_source_mismatch');
    const reviewed = spawnSync('git', ['cat-file', 'blob', evidence.reviewedBlob], { cwd: ROOT });
    demand(reviewed.status === 0, 'reviewed_blob_unavailable');
    const validated = validateSchemaEvidence(evidence, source, { reviewedBlob: blob.stdout.trim(), reviewedBlobBytes: reviewed.stdout });
    applied.push(evidence);
    return validated;
  });
  return { migrations, recoveryPoint: validateRecoveryBackup(applied) };
}

export function fixturePlan() {
  const plan = basePlan();
  plan.actors.forEach(actor => { actor.email = actor.email.replace('hermes-p2-', 'hermes-p4-'); });
  plan.orgs.forEach(org => { org.slug = org.slug.replace('hermes-p2-', 'hermes-p4-'); });
  plan.instanceId = randomUUID();
  plan.channels = plan.orgs.map((org, index) => ({ accountId: randomUUID(), conversationId: randomUUID(), messageId: randomUUID(),
    orgIndex: index, ownUid: `8${BigInt('0x' + randomBytes(7).toString('hex'))}`, senderUid: `7${BigInt('0x' + randomBytes(7).toString('hex'))}`,
    linkMessageId: `fixture_link_${randomUUID().replaceAll('-', '')}` }));
  return plan;
}


export function accountSetupSql(plan) {
  return plan.channels.map(channel => `INSERT INTO public.zalo_accounts(id,user_id,organization_id,kind,name,zalo_uid,status,meta)
      VALUES(${lit(channel.accountId)},${lit(plan.actors[channel.orgIndex].id)},${lit(plan.orgs[channel.orgIndex].id)},
      'personal','Hermes P4 synthetic; no provider credentials',${lit(channel.ownUid)},'connected',
      jsonb_build_object('hermesFixtureRun',${lit(plan.run)},'providerDisabled',true));`).join('\n');
}

export function channelSetupSql(plan) {
  // Never upsert/take over a previous worker lease, even if expired.
  return `BEGIN;
    INSERT INTO public.zalo_worker_lease(id,instance_id,hostname,heartbeat_at)
      VALUES('singleton',${lit(plan.instanceId)},'hermes-p4-synthetic-no-provider',clock_timestamp());
    ${accountSetupSql(plan)}
    COMMIT;`;
}

export function channelCleanupSql(plan, { mode = 'full' } = {}) {
  executionMode({ mode });
  const accounts = sqlIds(plan.channels.map(channel => channel.accountId));
  const orgs = sqlIds(plan.orgs.map(org => org.id));
  return `BEGIN;
    DELETE FROM app_private.hermes_zalo_private_commands WHERE account_id IN (${accounts}) AND organization_id IN (${orgs});
    DELETE FROM app_private.hermes_zalo_bindings WHERE account_id IN (${accounts}) AND organization_id IN (${orgs});
    DELETE FROM app_private.hermes_zalo_link_challenges WHERE account_id IN (${accounts}) AND organization_id IN (${orgs});
    DELETE FROM app_private.hermes_zalo_ingress_sessions WHERE account_id IN (${accounts}) AND organization_id IN (${orgs});
    DELETE FROM app_private.hermes_zalo_bots WHERE account_id IN (${accounts}) AND organization_id IN (${orgs});
    DELETE FROM public.zalo_messages WHERE account_id IN (${accounts}) AND organization_id IN (${orgs});
    DELETE FROM public.zalo_conversations WHERE account_id IN (${accounts}) AND organization_id IN (${orgs});
    DELETE FROM public.zalo_accounts WHERE id IN (${accounts}) AND organization_id IN (${orgs}) AND meta->>'hermesFixtureRun'=${lit(plan.run)};
    ${mode === 'full' ? `DELETE FROM public.zalo_worker_lease WHERE id='singleton' AND instance_id=${lit(plan.instanceId)};` : ''}
    COMMIT;`;
}

export function channelCountsSql(plan) {
  const accounts = sqlIds(plan.channels.map(channel => channel.accountId));
  const tables = ['app_private.hermes_zalo_private_commands', 'app_private.hermes_zalo_bindings',
    'app_private.hermes_zalo_link_challenges', 'app_private.hermes_zalo_ingress_sessions', 'app_private.hermes_zalo_bots',
    'public.zalo_messages', 'public.zalo_conversations'];
  return `SELECT ${tables.map((table, i) => `(SELECT count(*) FROM ${table} WHERE account_id IN (${accounts}))::int c${i}`).join(',')},
    (SELECT count(*) FROM public.zalo_accounts WHERE id IN (${accounts}))::int accounts,
    (SELECT count(*) FROM public.zalo_worker_lease WHERE instance_id=${lit(plan.instanceId)})::int worker`;
}

export async function expectSqlDenied(operation, codes = ['42501']) {
  let observed;
  try { await operation(); } catch (error) { observed = error?.code; }
  demand(codes.includes(observed), 'expected_sql_denial_missing');
}

// Every store call authenticates as the dedicated TEST LOGIN; there is no role
// switch, admin fallback, caller-supplied identity or fabricated JWT claim.
export async function createExecutorRole(ctx, pool, plan, state) {
  demand(state?.attempted === false && state.confirmed === false && state.cleanupRequired === false, 'executor_setup_reused');
  const sql = roleSetupSql(plan); // validates both generated role name and password
  state.attempted = true;
  try {
    // The extended protocol keeps the password out of shell/psql command text.
    await guardedQuery(ctx, pool, sql, [], { write: true }); state.confirmed = true; state.cleanupRequired = true;
  } catch (error) {
    // A definite CREATE rejection proves no owned role was created. In
    // particular, never DROP a foreign role after a duplicate-name rejection.
    state.cleanupRequired = ctx.writeState.uncertain; throw error;
  }
  await guardedQuery(ctx, pool, 'GRANT hermes_store_executor TO "' + plan.role + '"', [], { write: true });
}

const EXECUTOR_IDENTITY_SQL = `SELECT current_user AS role,session_user AS session_role,
  r.rolcanlogin,r.rolinherit,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,r.rolreplication,
  pg_catalog.pg_has_role(current_user,'hermes_store_executor','USAGE') AS scoped,
  EXISTS (SELECT 1 FROM pg_catalog.pg_roles p WHERE p.rolname IN
    ('postgres','service_role','authenticated','anon','authenticator','supabase_admin')
    AND pg_catalog.pg_has_role(current_user,p.oid,'MEMBER')) AS privileged_member
  FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`;

async function assertExecutorIdentity(ctx, client) {
  demand(FIXTURE_ROLE.test(ctx.expectedRole ?? ''), 'executor_role_required');
  const result = await client.query(EXECUTOR_IDENTITY_SQL), who = result.rows?.[0];
  demand(result.rows?.length === 1 && who?.role === ctx.expectedRole && who.session_role === ctx.expectedRole
    && who.rolcanlogin === true && who.rolinherit === true && who.scoped === true && who.privileged_member === false
    && ['rolsuper', 'rolbypassrls', 'rolcreaterole', 'rolcreatedb', 'rolreplication'].every(key => who[key] === false),
  'executor_role_probe_invalid');
}

// All queries in this preflight are inside a read-only transaction. It must
// succeed before any Auth user is created or connection is activated.
export async function verifyExecutorPrincipal(ctx, pool) {
  demand(FIXTURE_ROLE.test(ctx.expectedRole ?? ''), 'executor_role_required');
  await ctx.assertLease(ctx.lease, ctx.test);
  const client = await pool.connect(); let begun = false, broken = false;
  try {
    await client.query('BEGIN READ ONLY'); begun = true;
    await assertExecutorIdentity(ctx, client);
    const membership = (await client.query(`SELECT parent.rolname AS role,m.admin_option,m.inherit_option
      FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles parent ON parent.oid=m.roleid
      JOIN pg_catalog.pg_roles member ON member.oid=m.member WHERE member.rolname=current_user`)).rows;
    demand(membership.length === 1 && membership[0].role === 'hermes_store_executor'
      && membership[0].admin_option === false && membership[0].inherit_option === true, 'executor_membership_invalid');
    const schema = (await client.query(`SELECT has_schema_privilege(current_user,'app_private','USAGE') AS allowed,
      has_schema_privilege(current_user,'app_private','CREATE') AS can_create`)).rows;
    demand(schema.length === 1 && schema[0].allowed === true && schema[0].can_create === false, 'executor_schema_acl_invalid');
    const privateFunctions = Object.values(STORE).map(name => `app_private.hermes_store_${name}_v1(jsonb)`);
    const publicFunctions = ['public.hermes_zalo_binding_v1(jsonb)', 'public.hermes_connection_options_v1(uuid)',
      'public.hermes_org_policy_options_v1(uuid)', ...['ingress', 'private_command', 'private_reply'].map(name => `public.hermes_zalo_${name}_v1(jsonb)`)];
    const functions = (await client.query({ text: `SELECT signature,has_function_privilege(current_user,signature,'EXECUTE') AS allowed
      FROM unnest($1::text[]) signature`, values: [[...privateFunctions, ...publicFunctions]], queryMode: 'extended' })).rows;
    demand(functions.length === privateFunctions.length + publicFunctions.length
      && functions.every(row => row.allowed === privateFunctions.includes(row.signature)), 'executor_function_acl_invalid');
    const tables = [...['capabilities', 'assistants', 'org_policies', 'sessions', 'connections', 'connection_tokens'].map(name => `app_private.hermes_${name}`),
      ...['bots', 'ingress_sessions', 'link_challenges', 'bindings', 'private_commands'].map(name => `app_private.hermes_zalo_${name}`)];
    const tableAcl = (await client.query({ text: `SELECT has_table_privilege(current_user,t.name,p.privilege) AS allowed
      FROM unnest($1::text[]) t(name) CROSS JOIN unnest($2::text[]) p(privilege)`,
    values: [tables, ['SELECT', 'INSERT', 'UPDATE', 'DELETE']], queryMode: 'extended' })).rows;
    demand(tableAcl.length === tables.length * 4 && tableAcl.every(row => row.allowed === false), 'executor_table_acl_invalid');
    const probe = (await client.query({ text: 'SELECT app_private.hermes_store_read_connection_v1($1::jsonb) AS result',
      values: [JSON.stringify({ tokenDigest: '0'.repeat(64) })], queryMode: 'extended' })).rows;
    demand(probe.length === 1 && probe[0].result?.status === 'unavailable', 'executor_read_probe_invalid');
    await client.query('COMMIT'); begun = false;
  } catch (error) {
    if (begun) try { await client.query('ROLLBACK'); } catch { broken = true; ctx.writeState.uncertain = true; }
    throw error;
  } finally { client.release(broken); }
}

export async function roleProbe(ctx, pool, operation, payload) {
  demand(Object.hasOwn(STORE, operation), 'store_operation_invalid');
  demand(FIXTURE_ROLE.test(ctx.expectedRole ?? ''), 'executor_role_required');
  await ctx.assertLease(ctx.lease, ctx.test);
  const client = await pool.connect(); let begun = false, dispatched = false, committing = false, broken = false;
  try {
    await client.query('BEGIN'); begun = true;
    await assertExecutorIdentity(ctx, client);
    dispatched = true;
    const result = await client.query({ text: `SELECT app_private.hermes_store_${STORE[operation]}_v1($1::jsonb) AS result`,
      values: [JSON.stringify(payload)], queryMode: 'extended' });
    committing = true;
    await client.query('COMMIT'); begun = false;
    return result.rows[0].result;
  } catch (error) {
    // Known ERROR + acknowledged ROLLBACK is safe; uncertain COMMIT is retained.
    const known = error?.severity === 'ERROR' && /^(?:22|23|40|42)[A-Z0-9]{3}$/.test(error.code ?? '') && error.code !== '40003';
    if (committing || (dispatched && !known)) ctx.writeState.uncertain = true;
    if (begun) try { await client.query('ROLLBACK'); } catch { broken = true; ctx.writeState.uncertain = true; }
    throw error;
  } finally { client.release(broken); }
}

export async function activateFixtureConnection(ctx, connectionStore, input, options) {
  try { return await connectionStore.activate(input, options); }
  catch (error) {
    // The adapter can reject an ACK after roleProbe has acknowledged COMMIT,
    // or observe cancellation after transport returns. Preserve this uncertainty
    // at the adapter boundary, without retrying or reclassifying local validation.
    if (error?.code === 'store_outcome_unknown') ctx.writeState.uncertain = true;
    throw error;
  }
}

export async function verifyPolicyOptionsFixture(plan, { okRpc, deniedRpc, write }) {
  const getter = 'hermes_org_policy_options_v1';
  for (const index of [0, 1]) {
    const actor = plan.actors[index]; const org = plan.orgs[index];
    const options = await okRpc(actor, getter, { p_org: org.id });
    demand(options.userId === actor.id && options.organizationId === org.id && options.policy?.organizationId === org.id
      && options.policy.version === 1 && options.policy.enabled === true, 'jwt_policy_options_owner_mismatch');
    assert.deepEqual(options.policy.read, ['assistant.context.read']);
    assert.deepEqual(options.policy.action, []); assert.deepEqual(options.choices.action, []);
    await deniedRpc(actor, getter, { p_org: plan.orgs[1 - index].id });
  }
  // Superadmin selects an organization explicitly; an org's policy never changes
  // the identity derived from this actor's real bearer.
  for (const org of plan.orgs) {
    const options = await okRpc(plan.actors[2], getter, { p_org: org.id });
    demand(options.userId === plan.actors[2].id && options.organizationId === org.id
      && options.policy?.organizationId === org.id, 'jwt_super_policy_options_owner_mismatch');
  }
  const org = plan.orgs[0];
  // Exact fixture role only. If denial fails, outer fixture cleanup removes the
  // role; no compensation/retry is attempted after an unknown write.
  await write(`BEGIN; DELETE FROM public.role_permissions WHERE organization_id=${lit(org.id)}
    AND role_id=${lit(org.roleId)} AND permission_key='users.edit'; COMMIT;`);
  await deniedRpc(plan.actors[0], getter, { p_org: org.id });
  await write(`BEGIN; INSERT INTO public.role_permissions(organization_id,role_id,permission_key,effect)
    VALUES(${lit(org.id)},${lit(org.roleId)},'users.edit','ALLOW'); COMMIT;`);
}

// This probe deliberately leaves challenges WAITING, then revokes them through
// the authenticated management API. No worker identity or observed sender is
// invented. Confirmation belongs exclusively to the full private-flow mode.
export async function verifyBindingManagementFixture(plan, subjects, { okRpc, deniedRpc, write }) {
  for (const channel of plan.channels) {
    const index = channel.orgIndex, actor = plan.actors[index], org = plan.orgs[index];
    const organizationId = org.id, accountId = channel.accountId;
    const rpc = p => okRpc(actor, 'hermes_zalo_binding_v1', { p });
    const configured = await rpc({ operation: 'setBot', organizationId, accountId, expectedVersion: 0, enabled: true });
    demand(configured.status === 'configured' && configured.accountId === accountId
      && configured.version === 1 && configured.enabled === true, 'jwt_bot_configuration_invalid');
    const managed = await rpc({ operation: 'manageBots', organizationId, afterAccountId: null });
    demand(managed.status === 'listed' && managed.bots?.length === 1 && managed.nextCursor === null
      && managed.bots[0].accountId === accountId && managed.bots[0].enabled === true
      && managed.bots[0].version === 1, 'jwt_bot_listing_invalid');
    const begin = { operation: 'begin', organizationId, accountId, connectionId: subjects[index].connection.id,
      expectedConnectionEpoch: subjects[index].connection.epoch };
    const challenge = await rpc(begin);
    demand(challenge.status === 'waiting' && UUID.test(challenge.challengeId ?? '')
      && /^hz_[a-f0-9]{64}$/.test(challenge.challenge ?? '') && challenge.accountId === accountId
      && challenge.connectionId === begin.connectionId, 'jwt_unobserved_challenge_invalid');
    const statusInput = { operation: 'status', organizationId, challengeId: challenge.challengeId };
    const status = await rpc(statusInput);
    demand(status.status === 'waiting' && status.challengeId === challenge.challengeId
      && status.accountId === accountId && status.connectionId === begin.connectionId
      && status.candidateVersion === 0 && status.senderUid === null, 'jwt_unobserved_status_invalid');
    for (const other of [plan.actors[2], plan.actors[1 - index]]) {
      await deniedRpc(other, 'hermes_zalo_binding_v1', { p: begin });
      await deniedRpc(other, 'hermes_zalo_binding_v1', { p: statusInput });
    }
    // Same actor/selected org with a foreign account must not be sufficient.
    await deniedRpc(actor, 'hermes_zalo_binding_v1', { p: { operation: 'setBot', organizationId,
      accountId: plan.channels[1 - index].accountId, expectedVersion: 0, enabled: true } });
    await deniedRpc(actor, 'hermes_zalo_binding_v1', { p: { operation: 'setBot', organizationId,
      accountId, expectedVersion: 0, enabled: false } }, [409], ['PT409']);
    // Exact fixture role only; an unknown mutation is handled by the existing
    // writeFixtureSql/outer cleanup path and never retried/compensated here.
    await write(`BEGIN; DELETE FROM public.role_permissions WHERE organization_id=${lit(organizationId)}
      AND role_id=${lit(org.roleId)} AND permission_key='chat_zalo.manage_automation'; COMMIT;`);
    await deniedRpc(actor, 'hermes_zalo_binding_v1', { p: { operation: 'manageBots', organizationId, afterAccountId: null } });
    await deniedRpc(actor, 'hermes_zalo_binding_v1', { p: { operation: 'setBot', organizationId,
      accountId, expectedVersion: 1, enabled: false } });
    await write(`BEGIN; INSERT INTO public.role_permissions(organization_id,role_id,permission_key,effect)
      VALUES(${lit(organizationId)},${lit(org.roleId)},'chat_zalo.manage_automation','ALLOW'); COMMIT;`);
    const disabled = await rpc({ operation: 'setBot', organizationId, accountId, expectedVersion: 1, enabled: false });
    demand(disabled.status === 'configured' && disabled.accountId === accountId
      && disabled.version === 2 && disabled.enabled === false, 'jwt_bot_disable_invalid');
    await deniedRpc(actor, 'hermes_zalo_binding_v1', { p: statusInput }, [409], ['PT409']);
  }
}

async function context() {
  const cred = readTestCredentials(); demand(cred.testRef === TEST_REF, 'test_target_mismatch');
  const db = await dichKetNoi('test'); targetMatches(TEST_REF, cred, db);
  dangKyMatKhau([db]); const test = uri(db.host, db.ref);
  const [markers] = psqlJson(test, "SELECT to_regclass('test_env.danh_dau') IS NOT NULL marker,to_regclass('test_env.active_run') IS NOT NULL lease_marker");
  demand(markers?.marker && markers?.lease_marker, 'existing_test_markers_required');
  await batBuocDichTest(cred, test);
  return { cred, db, test, url: `https://${TEST_REF}.supabase.co` };
}

const normalizeSearchPath = value => value.replace(/["\s]/g, '');
// One name may hold several reviewed (file, bytes) pairs: the applied file of a
// replaced reader is immutable, so its historical statement still verifies.
const REVIEWED_EMPTY_SEARCH_PATH = new Map();
for (const spec of [
  ...HERMES_READ_STANDARD_FUNCTIONS.filter(spec => ['app_private.hermes_domain_read_rows_fast_v1', 'public.hermes_write_name_resolve_v1',
    'public.hermes_write_name_resolve_v2'].includes(spec.name)),
  { name: 'public.hermes_read_text_v1',
    sourcePath: 'supabase/migrations/20261019040055_crm_shared_read_cores_v1.sql',
    statementSha256: '01afb4b8b3e12e971e8e54ccda6122c8f4d2f1d237bc0168e14e0c764ad11105' },
  // Shared write foundation name resolution (20261021132433): two pure IMMUTABLE helpers and the plpgsql INVOKER core
  // whose body names only schema-qualified public objects; its SQL-standard wrapper is pinned above.
  { name: 'public.hermes_name_fold_v1',
    sourcePath: 'supabase/migrations/20261021132433_hermes_write_name_resolve_v1.sql',
    statementSha256: '16ad1c3501346ab5b730a97acafdc918e233b9f27e0a7bc08e3148c42ff2a82a' },
  { name: 'public.hermes_room_key_v1',
    sourcePath: 'supabase/migrations/20261021132433_hermes_write_name_resolve_v1.sql',
    statementSha256: '801ff7b91a46c35be4fd9f1f0dd338d20a89738d7e97e94baa3eb2dc25b96527' },
  { name: 'app_private.hermes_write_name_resolve_core_v1',
    sourcePath: 'supabase/migrations/20261021132433_hermes_write_name_resolve_v1.sql',
    statementSha256: 'ece48834a6430d821319960b66abe342b819e2547a442aef34c0b0d0c0a88c3d' },
  // Contract page write RPC (20261022022951): the plpgsql INVOKER lookup under the caller's RLS names only schema-qualified
  // public/auth objects; its SQL-standard wrapper is pinned in hermes-task-function-contract.
  { name: 'public.hermes_contract_action_lookup_v1',
    sourcePath: 'supabase/migrations/20261022022951_hermes_contract_action_v1.sql',
    statementSha256: '4ddf5730093afb09b04c566c774e9b10e27643d7a0ae65bea2d5e66d26f4e301' },
  // Contract return (20261022061813) replaces that lookup: same body plus the unpaid invoices of the contract, only when the asker
  // may view invoices in that building (public.can_do_on_building) and through the shared invoice_effective_outstanding_v1.
  { name: 'public.hermes_contract_action_lookup_v1',
    sourcePath: 'supabase/migrations/20261022061813_hermes_contract_return_v1.sql',
    statementSha256: '49a183d7254c6579d68004d51a0bc99008e2efe79c3d8381618eed88199275a6' },
  // Đợt 2 Thu chi (20261022024834): lõi giải tên plpgsql INVOKER của expense.* — chỉ tên public đủ schema; vỏ SQL-standard ghim ở
  // hermes-task-function-contract.
  { name: 'app_private.hermes_expense_resolve_core_v1',
    sourcePath: 'supabase/migrations/20261022024834_hermes_expense_write_v1.sql',
    statementSha256: '2555857f637fe17ea488547ca6c0bd34318f2b1d2f50964cb3dd5683c5deea7a' },
  // Thu chi Mốc 3: lõi giải tên ghi _v2 nhận toà ảo (20261022044120: lõi plpgsql INVOKER = lõi v1 + p_include_virtual; vỏ SQL-standard ghim
  // ở hermes-read-function-specs) và lõi giải tên expense.* thay thân để gọi _v2 (20261022044123). Chỉ tên public đủ schema.
  { name: 'app_private.hermes_write_name_resolve_core_v2',
    sourcePath: 'supabase/migrations/20261022044120_hermes_name_directory_virtual_v1.sql',
    statementSha256: '1fc89a8af790a6669fc73f0883783327a780913dbce27e6266983ebd2ce4305d' },
  { name: 'app_private.hermes_expense_resolve_core_v1',
    sourcePath: 'supabase/migrations/20261022044123_hermes_expense_scope_v1.sql',
    statementSha256: 'e5f59a97d1fc3036d7c03efccbc24921f1d2b784e8ac092ba32ed101f4f1bbf8' },
  // Occupants + drafts (20261022074815): INVOKER customer lookup under the caller's RLS ∩ the connection's buildings (phone first, else
  // exact folded name, or the chosen customerId on the apply turn; candidates carry only a name and the last three phone digits);
  // schema-qualified public/auth objects only.
  { name: 'public.hermes_contract_party_lookup_v1',
    sourcePath: 'supabase/migrations/20261022074815_hermes_contract_party_draft_v1.sql',
    statementSha256: '4d9c7d8d0de7c484c833dcba263f91d024103f48e4fa1ab8986d2343e6c79cbe' },
  // Renew batch (20261023030305): INVOKER batch lookup under the caller's RLS ∩ the connection's buildings — ACTIVE contracts ending in
  // one month, ids + move-out flag + counts only (no names, no customer data); schema-qualified public/auth objects only.
  { name: 'public.hermes_contract_batch_lookup_v1',
    sourcePath: 'supabase/migrations/20261023030305_hermes_contract_renew_batch_v1.sql',
    statementSha256: 'abc42f34682088fec505d7103d3102d6793b24a66181d80135dbe4ca79bee97e' },
]) REVIEWED_EMPTY_SEARCH_PATH.set(spec.name, [...(REVIEWED_EMPTY_SEARCH_PATH.get(spec.name) ?? []), spec]);

/** SECURITY mode and search_path of each Hermes function, read from its last
 * CREATE statement (later migrations replace earlier ones, as in the catalog).
 * Deriving them from source instead of a hand list keeps new pure/invoker
 * helpers exact: a reviewed `SET search_path=pg_catalog` stays that narrow. */
export function hermesFunctionAttributes(sources) {
  const attributes = new Map();
  for (const source of sources) for (const raw of splitHermesFunctionStatements(source.bytes.toString('utf8'))) {
    const statement = raw.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, '').trim();
    const head = /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+((?:public|app_private)\.hermes_\w+)\s*\(/i.exec(statement);
    if (!head) continue;
    // Dollar-quoted body, or an SQL-standard body (BEGIN ATOMIC / RETURN).
    const bodyStart = statement.search(/\bAS\s+\$[A-Za-z_0-9]*\$|\bBEGIN\s+ATOMIC\b|\bRETURN\b/i);
    demand(bodyStart > head[0].length, 'live_schema_source_unreadable');
    const header = statement.slice(0, bodyStart);
    // Identifier list only: a later clause such as SET lock_timeout is separate.
    const empty = /\bSET\s+search_path\s*(?:=|\bTO\b)\s*''(?:\s|$)/i.test(header);
    if (empty) {
      const reviewed = REVIEWED_EMPTY_SEARCH_PATH.get(head[1]) ?? [];
      demand(reviewed.some(spec => spec.sourcePath === source.path && sha(statement.replace(/\r\n?/g, '\n')) === spec.statementSha256),
        'live_schema_empty_path_unreviewed');
    }
    const path = /\bSET\s+search_path\s*(?:=|\bTO\b)\s*((?:"?[A-Za-z_][A-Za-z_0-9]*"?\s*,\s*)*"?[A-Za-z_][A-Za-z_0-9]*"?)/i.exec(header)?.[1];
    attributes.set(head[1], { definer: /\bSECURITY\s+DEFINER\b/i.test(header), searchPath: empty ? '' : path ? normalizeSearchPath(path) : null });
  }
  return attributes;
}

export async function verifyLiveSchema(pool) {
  const catalogFunctions = new Map([...TASK_FUNCTIONS, ...CUSTOMER_FUNCTIONS].map(spec => [spec.name, spec]));
  const expected = new Map(migrationSources().flatMap(source => extractFunctionDefinitions(source.bytes.toString('utf8'), source.path))
    .filter(item => /^(?:public|app_private)\.hermes_/.test(item.qualifiedName) && item.bodyKind !== 'sql-standard' && !catalogFunctions.has(item.qualifiedName)).map(item => [item.qualifiedName, item.bodyDigest]));
  const attributes = hermesFunctionAttributes(migrationSources());
  const rows = (await pool.query(`SELECT n.nspname||'.'||p.proname name,p.prosrc,p.prosecdef,pg_get_userbyid(p.proowner) owner,p.proconfig
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname||'.'||p.proname=ANY($1::text[])`, [[...expected.keys()]])).rows;
  const livePath = row => (row.proconfig ?? []).filter(value => value.startsWith('search_path=')).map(value => normalizeSearchPath(value.slice(12)));
  // Paths are rooted at pg_catalog, except the byte-bound empty-path
  // readers above; exact value and SECURITY mode still match the source.
  demand(rows.length === expected.size && rows.every(row => {
    const source = attributes.get(row.name), live = livePath(row);
    return (source?.searchPath?.startsWith('pg_catalog') || source?.searchPath === '') && row.owner === 'postgres'
      && row.prosecdef === (catalogFunctions.get(row.name)?.definer ?? source.definer)
      && live.length === 1 && live[0] === source.searchPath
      && sha(row.prosrc.replace(/\r\n?/g, '\n')) === expected.get(row.name);
  }), 'live_schema_body_mismatch');
  await verifyTaskFunctionCatalog(pool, migrationSources());
  await verifyCustomerFunctionCatalog(pool, migrationSources());
  const signatures = [
    ['public.hermes_zalo_binding_v1(jsonb)', 'authenticated'], ['public.hermes_connection_options_v1(uuid)', 'authenticated'],
    ['public.hermes_org_policy_options_v1(uuid)', 'authenticated'],
    ...['ingress', 'private_command', 'private_reply'].map(name => [`public.hermes_zalo_${name}_v1(jsonb)`, 'service_role']),
    ...Object.values(STORE).map(name => [`app_private.hermes_store_${name}_v1(jsonb)`, 'hermes_store_executor']),
  ];
  for (const [signature, allowed] of signatures) {
    const acl = (await pool.query(`SELECT role,has_function_privilege(role,$1,'EXECUTE') allowed
      FROM unnest($2::text[]) AS role`, [signature, ['anon', 'authenticated', 'service_role', 'hermes_store_executor']])).rows;
    demand(acl.length === 4 && acl.every(row => row.allowed === (row.role === allowed)), 'live_rpc_acl_mismatch');
  }
  const tables = ['bots', 'ingress_sessions', 'link_challenges', 'bindings', 'private_commands'].map(name => `app_private.hermes_zalo_${name}`);
  const acl = (await pool.query(`SELECT has_table_privilege(r.role,t.name,p.privilege) allowed
    FROM unnest($1::text[]) r(role) CROSS JOIN unnest($2::text[]) t(name) CROSS JOIN unnest($3::text[]) p(privilege)`,
  [['anon', 'authenticated', 'service_role', 'hermes_store_executor'], tables, ['SELECT', 'INSERT', 'UPDATE', 'DELETE']])).rows;
  demand(acl.length === 80 && acl.every(row => row.allowed === false), 'live_private_table_acl_mismatch');
  const rls = (await pool.query('SELECT relrowsecurity FROM pg_class WHERE oid=ANY($1::regclass[])', [tables])).rows;
  demand(rls.length === 5 && rls.every(row => row.relrowsecurity), 'live_private_rls_missing');
  const triggers = (await pool.query(`SELECT tgname,tgenabled FROM pg_trigger WHERE tgname=ANY($1::text[]) AND NOT tgisinternal`,
    [['hermes_zalo_private_conversation_guard', 'hermes_zalo_private_message_guard', 'hermes_private_command_authority']])).rows;
  demand(triggers.length === 3 && triggers.every(row => row.tgenabled === 'O'), 'live_guard_trigger_missing');
}

// Nonsecret exact IDs for diagnosing cleanup; never persist passwords, tokens or envelopes.
export function fixtureCleanupIdentity(plan) {
  return { runId: plan.run, role: plan.role, instanceId: plan.instanceId,
    actors: plan.actors.map(({ id, email }) => ({ id: id ?? null, email })),
    organizations: plan.orgs.map(({ id, slug, roleId, buildingId, roomId }) => ({ id, slug, roleId, buildingId, roomId })),
    memberships: plan.memberships.map(({ id, bindingId, actor, org }) => ({ id, bindingId, actor, org })),
    connectionIds: [...plan.connectionIds], channelAccountIds: plan.channels.map(channel => channel.accountId),
    roomRead: { areaId: plan.roomRead.areaId, scopeId: plan.roomRead.scopeId, buildingId: plan.roomRead.buildingId, roomId: plan.roomRead.roomId } };
}

export async function runHarness(options) {
  demand(options?.run === true && options.environment === 'test' && options.expectedProjectRef === TEST_REF, 'explicit_test_run_required');
  const mode = executionMode(options);
  // Missing unapplied candidate evidence fails here, before credentials/network/lease.
  const sourceIdentity = captureSourceIdentity(); const schemaEvidence = requireSchemaEvidence();
  const connection = await context();
  return withTestLock(connection, async lease => {
    const plan = fixturePlan(); const cases = [], rpcDiagnostics = []; const cdeEvidence = {}; let cleanupRequired = false, cleanupVerified = false, workerOwned = false, cleanupPhase = 'not_started';
    let authenticatedActors = 0; let postgrestResponses = 0; let executorRoleProbes = 0; let fatal;
    let restricted, principalVerified = false;
    const executorRole = { attempted: false, confirmed: false, cleanupRequired: false };
    const ctx = { ...connection, lease, signal: lease.signal, expectedRole: plan.role, assertLease: createSerializedLeaseAssertions(), writeState: { uncertain: false } };
    const tls = loadFixtureCa();
    const pool = new pg.Pool({ ...connection.db, database: 'postgres', ssl: tls, max: 1,
      connectionTimeoutMillis: 5000, statement_timeout: 12000, lock_timeout: 3000,
      options: '-c statement_timeout=12000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=15000', application_name: 'hermes-p4-private-fixture' });
    pool.on('error', () => { if (cleanupRequired) ctx.writeState.uncertain = true; });
    const crypto = createSessionCrypto({ activeKeyVersion: 'fixture', keys: new Map([['fixture', randomBytes(32)]]) });
    const provider = createSupabaseRefreshProvider({ url: ctx.url, publishableKey: ctx.cred.testPublishableKey });
    const write = (sql, held = lease) => writeFixtureSql(ctx, sql, { lease: held, assertLease: ctx.assertLease });
    const refreshWorker = async () => {
      if (!workerOwned) return;
      await ctx.assertLease(lease, ctx.test);
      let result;
      try { result = await pool.query('UPDATE public.zalo_worker_lease SET heartbeat_at=clock_timestamp() WHERE id=$1 AND instance_id=$2 RETURNING instance_id', ['singleton', plan.instanceId]); }
      catch (error) { ctx.writeState.uncertain = true; throw error; }
      demand(result.rowCount === 1, 'fixture_worker_ownership_lost');
    };
    const request = async (path, key, token, body, { write: mutation = true, method = 'POST', held = lease } = {}) => {
      demand(path.startsWith('/auth/v1/') || /^\/rest\/v1\/rpc\/[a-z0-9_]+$/.test(path), 'fixture_endpoint_refused');
      await ctx.assertLease(held, ctx.test);
      const response = await testFetch({ ...ctx, signal: held.signal }, `${ctx.url}${path}`, { method, redirect: 'error',
        headers: fixtureRequestHeaders(path, key, token),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, { write: mutation });
      let value; try { value = await response.json(); } catch { if (mutation) ctx.writeState.uncertain = true; fail('fixture_response_invalid'); }
      return { status: response.status, body: value };
    };
    const rpc = async (actor, name, body, mutation = true) => {
      demand(RPCS.has(name), 'fixture_rpc_refused');
      demand(mode === 'full' || actor !== 'worker', 'fixture_worker_forbidden_in_jwt_mode'); await refreshWorker();
      const service = actor === 'worker';
      const result = await request(`/rest/v1/rpc/${name}`, service ? ctx.cred.testSecretKey : ctx.cred.testPublishableKey,
        service ? ctx.cred.testSecretKey : actor.session.accessToken, body, { write: mutation });
      postgrestResponses += 1;
      if (rpcDiagnostics.length < 128) rpcDiagnostics.push(fixtureRpcDiagnostic(name, result.status, result.body));
      return result;
    };
    const okRpc = async (actor, name, body, expected = 200) => {
      const value = await rpc(actor, name, body); demand(value.status === expected, 'rpc_status_unexpected'); return value.body;
    };
    const deniedRpc = async (actor, name, body, statuses = [403], codes = ['42501']) => {
      const value = await rpc(actor, name, body); demand(statuses.includes(value.status) && codes.includes(value.body?.code), 'expected_rpc_denial_missing');
    };
    const store = async (operation, payload) => {
      demand(mode === 'full' || operation === 'activate' || operation === 'readConnection', 'fixture_command_forbidden_in_jwt_mode');
      await refreshWorker(); const result = await roleProbe(ctx, restricted, operation, payload); executorRoleProbes += 1; return result;
    };
    const connectionStore = createDurableConnectionStore({ transport: { call: store } });
    const check = async (name, operation) => {
      await ctx.assertLease(lease, ctx.test);
      try { await operation(); cases.push({ name, status: 'PASS' }); }
      catch (error) { cases.push({ name, status: 'FAIL', code: safeCode(error) }); throw error; }
    };
    const signIn = async actor => {
      const response = await request('/auth/v1/token?grant_type=password', ctx.cred.testPublishableKey, null, { email: actor.email, password: actor.password });
      demand(response.status === 200, 'fixture_signin_failed'); const value = response.body;
      const pending = provider.beginVerifySession({ accessToken: value.access_token, signal: lease.signal });
      let verified; try { verified = await pending.result; } finally { await pending.drained; }
      demand(verified.userId === actor.id && UUID.test(verified.sessionId), 'fixture_auth_identity_mismatch');
      return { accessToken: value.access_token, refreshToken: value.refresh_token, verified };
    };
    const issue = async (actorIndex, orgIndex) => {
      const actor = plan.actors[actorIndex]; const org = plan.orgs[orgIndex]; const session = await signIn(actor);
      const prepared = await okRpc({ session }, 'hermes_prepare_connection_v1', { p_org: org.id, p_read: ['assistant.context.read'], p_action: [], p_scope_ids: [] });
      demand(prepared.userId === actor.id && prepared.organizationId === org.id, 'fixture_prepare_owner_invalid');
      plan.connectionIds.push(prepared.id);
      const binding = { assistantId: prepared.assistantId, userId: actor.id, organizationId: org.id, sessionId: session.verified.sessionId };
      const material = { accessToken: session.accessToken, refreshToken: session.refreshToken, expiresAt: session.verified.expiresAt };
      const tokenDigest = sha(`hc_${randomBytes(32).toString('base64url')}`);
      const activated = await activateFixtureConnection(ctx, connectionStore, { prepared, binding, credentialRef: randomUUID(), operationId: randomUUID(), tokenDigest,
        tokenExpiresAt: Math.min(Date.now() + 10 * 60_000, material.expiresAt), sessionExpiresAt: material.expiresAt,
        sessionEnvelope: crypto.seal(material, binding) }, { signal: lease.signal });
      demand(activated.ok && activated.status === 'activated', 'fixture_activation_failed');
      return { connection: activated.connection, tokenDigest, actorIndex, orgIndex, session };
    };
    try {
      await verifyLiveSchema(pool);
      if (mode === 'cde') await verifyCdeLiveSurface(pool);
      demand(JSON.stringify(sourceIdentity) === JSON.stringify(captureSourceIdentity()), 'source_changed_before_fixture');
      if (mode === 'full') demand((await pool.query("SELECT count(*)::int n FROM public.zalo_worker_lease WHERE id='singleton'")).rows[0].n === 0, 'worker_lease_must_be_absent');
      cases.push({ name: 'schema.evidence_body_acl_rls_triggers', status: 'PASS' });
      demand((await guardedQuery(ctx, pool, 'SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=$1', [plan.role])).rowCount === 0,
        'fixture_role_already_exists');
      markTestCleanupRequired(lease, ctx.test); cleanupRequired = true;
      await createExecutorRole(ctx, pool, plan, executorRole);
      restricted = createStorePool({ projectRef: ctx.db.ref, host: ctx.db.host, role: plan.role, password: plan.rolePassword, ca: tls.ca,
        onIdleFailure: () => { ctx.writeState.uncertain = true; } });
      delete plan.rolePassword;
      await check('executor.dedicated_login_identity_acl_before_auth', async () => {
        await verifyExecutorPrincipal(ctx, restricted); principalVerified = true;
      });
      for (const actor of plan.actors) {
        const created = await request('/auth/v1/admin/users', ctx.cred.testSecretKey, ctx.cred.testSecretKey,
          { email: actor.email, password: actor.password, email_confirm: true, user_metadata: { full_name: 'Hermes P4 synthetic TEST fixture' } });
        demand(created.status === 200 || created.status === 201, 'fixture_auth_create_failed'); actor.id = created.body.id;
        demand(UUID.test(actor.id ?? ''), 'fixture_actor_id_invalid'); actor.session = await signIn(actor); authenticatedActors += 1;
      }
      await write(baseSetup(plan));
      await write(`BEGIN; ${plan.orgs.map(org => `INSERT INTO public.role_permissions(organization_id,role_id,permission_key,effect)
        VALUES(${lit(org.id)},${lit(org.roleId)},'chat_zalo.manage_automation','ALLOW');`).join('\n')} COMMIT;`);
      for (const [index, org] of plan.orgs.entries()) {
        const policy = await okRpc(plan.actors[index], 'hermes_set_org_policy_v1', { p_org: org.id, p_expected_version: 0,
          p_enabled: true, p_read: ['assistant.context.read'], p_action: [], p_scope_ids: [] });
        demand(policy.version === 1, 'fixture_policy_setup_failed');
      }
      const subjects = [await issue(0, 0), await issue(1, 1)];
      await check('jwt.real_self_and_cross_org_options', async () => {
        for (const index of [0, 1]) {
          const actor = plan.actors[index];
          const own = await okRpc(actor, 'get_my_organizations', {}); demand(own.user_id === actor.id, 'jwt_database_uid_mismatch');
          const options = await okRpc(actor, 'hermes_connection_options_v1', { p_org: plan.orgs[index].id });
          demand(options.userId === actor.id && options.organizationId === plan.orgs[index].id, 'jwt_options_owner_mismatch');
          await deniedRpc(actor, 'hermes_connection_options_v1', { p_org: plan.orgs[1 - index].id });
        }
      });
      await check('jwt.org_policy_self_cross_org_superadmin_and_missing_users_edit', async () => {
        await verifyPolicyOptionsFixture(plan, { okRpc, deniedRpc, write });
      });
      await runChannelScope(mode, { cde: async () => runCdeChecks({ctx,plan,subjects,issue,write,okRpc,deniedRpc,check,evidence:cdeEvidence}), management: async () => {
        await check('jwt.binding_management_without_worker', async () => {
          await write(`BEGIN; ${accountSetupSql(plan)} COMMIT;`);
          await verifyBindingManagementFixture(plan, subjects, { okRpc, deniedRpc, write });
        });
      }, full: async () => {
      await write(channelSetupSql(plan)); workerOwned = true;
      for (const channel of plan.channels) {
        const index = channel.orgIndex; const actor = plan.actors[index]; const organizationId = plan.orgs[index].id;
        const accountId = channel.accountId; const subject = subjects[index];
        demand((await okRpc(actor, 'hermes_zalo_binding_v1', { p: { operation: 'setBot', organizationId, accountId, expectedVersion: 0, enabled: true } })).status === 'configured', 'bot_setup_failed');
        const source = { accountId, organizationId, instanceId: plan.instanceId, accountOwnerId: actor.id, ownUid: channel.ownUid, loginRequestedAt: null };
        const registered = await okRpc('worker', 'hermes_zalo_ingress_v1', { p: { operation: 'register', ...source } });
        demand(registered.status === 'registered' && UUID.test(registered.generation), 'ingress_setup_failed');
        channel.source = { ...source, generation: registered.generation };
        const begin = { operation: 'begin', organizationId, accountId, connectionId: subject.connection.id, expectedConnectionEpoch: subject.connection.epoch };
        const challenge = await okRpc(actor, 'hermes_zalo_binding_v1', { p: begin });
        demand(challenge.status === 'waiting' && /^hz_[a-f0-9]{64}$/.test(challenge.challenge), 'challenge_setup_failed');
        await check(`jwt.binding_${index}_cross_user_and_org_denied`, async () => {
          await deniedRpc(plan.actors[2], 'hermes_zalo_binding_v1', { p: begin });
          await deniedRpc(plan.actors[2], 'hermes_zalo_binding_v1', { p: { operation: 'status', organizationId, challengeId: challenge.challengeId } });
          await deniedRpc(plan.actors[1 - index], 'hermes_zalo_binding_v1', { p: { operation: 'status', organizationId, challengeId: challenge.challengeId } });
        });
        await write(`BEGIN;
          INSERT INTO public.zalo_conversations(id,user_id,organization_id,account_id,thread_id,thread_type,peer_name,peer_zalo_uid)
            VALUES(${lit(channel.conversationId)},${lit(actor.id)},${lit(organizationId)},${lit(accountId)},${lit(channel.senderUid)},'user','Synthetic sender',${lit(channel.senderUid)});
          INSERT INTO public.zalo_messages(id,user_id,organization_id,account_id,conversation_id,direction,msg_type,body,zalo_msg_id,zalo_raw)
            VALUES(${lit(channel.messageId)},${lit(actor.id)},${lit(organizationId)},${lit(accountId)},${lit(channel.conversationId)},'in','text','[Hermes link - hidden]',${lit(channel.linkMessageId)},
              jsonb_build_object('uidFrom',${lit(channel.senderUid)},'idTo',${lit(channel.ownUid)},'msgType','webchat'));
          COMMIT;`);
        const observed = await okRpc('worker', 'hermes_zalo_ingress_v1', { p: { operation: 'observe', accountId, organizationId, instanceId: plan.instanceId,
          generation: registered.generation, senderUid: channel.senderUid, providerMessageId: channel.linkMessageId, challengeDigest: sha(challenge.challenge) } });
        demand(observed.status === 'observed', 'challenge_observe_failed');
        channel.binding = await okRpc(actor, 'hermes_zalo_binding_v1', { p: { operation: 'confirm', organizationId, challengeId: challenge.challengeId,
          expectedCandidateVersion: 1, expectedSenderUid: channel.senderUid } });
        demand(channel.binding.status === 'active', 'binding_confirm_failed');
      }
      const intakePayload = index => {
        const channel = plan.channels[index];
        return { operation: 'acceptPrivateCommand', accountId: channel.accountId, organizationId: plan.orgs[index].id, instanceId: plan.instanceId,
          generation: channel.source.generation, senderUid: channel.senderUid, providerMessageId: `fixture_cmd_${randomUUID().replaceAll('-', '')}`,
          sentAt: Date.now(), text: 'Synthetic private command; no provider or model execution' };
      };
      let command, claimed; const payload = intakePayload(0); const claimId = randomUUID();
      await check('jwt.worker_only_endpoints_deny_real_user', async () => {
        await deniedRpc(plan.actors[0], 'hermes_zalo_ingress_v1', { p: { operation: 'privacy', ...Object.fromEntries(Object.entries(plan.channels[0].source).filter(([key]) => key !== 'generation')) } });
        await deniedRpc(plan.actors[0], 'hermes_zalo_private_command_v1', { p: payload });
        await deniedRpc(plan.actors[0], 'hermes_zalo_private_reply_v1', { p: { operation: 'claim', ...plan.channels[0].source, deliveryId: randomUUID() } });
      });
      await check('intake.actual_rpc_dedup_conflict_and_scoped_identity', async () => {
        command = await okRpc('worker', 'hermes_zalo_private_command_v1', { p: payload }); demand(command.status === 'queued', 'intake_not_queued');
        const duplicate = await okRpc('worker', 'hermes_zalo_private_command_v1', { p: payload });
        demand(duplicate.status === 'duplicate' && duplicate.commandId === command.commandId, 'intake_duplicate_not_same');
        await deniedRpc('worker', 'hermes_zalo_private_command_v1', { p: { ...payload, text: 'changed body' } }, [409], ['PT409']);
        await deniedRpc('worker', 'hermes_zalo_private_command_v1', { p: { ...payload, generation: randomUUID() } }, [409], ['PT409']);
        await deniedRpc('worker', 'hermes_zalo_private_command_v1', { p: { ...payload, organizationId: plan.orgs[1].id } });
        const row = (await pool.query('SELECT user_id,organization_id,connection_id FROM app_private.hermes_zalo_private_commands WHERE id=$1', [command.commandId])).rows[0];
        demand(row.user_id === plan.actors[0].id && row.organization_id === plan.orgs[0].id && row.connection_id === subjects[0].connection.id, 'intake_owner_mismatch');
      });
      await check('executor_role_probe.cross_actor_and_ordered_dispatch_finish', async () => {
        demand((await store('claimPrivateCommand', { tokenDigest: subjects[1].tokenDigest, claimId: randomUUID() })).status === 'empty', 'cross_actor_discovery_leak');
        claimed = await store('claimPrivateCommand', { tokenDigest: subjects[0].tokenDigest, claimId });
        demand(claimed.status === 'claimed' && claimed.command.commandId === command.commandId && claimed.command.text === payload.text, 'claim_identity_invalid');
        await expectSqlDenied(() => store('dispatchPrivateCommand', { tokenDigest: subjects[1].tokenDigest, claimId }));
        await expectSqlDenied(() => store('finishPrivateCommand', { tokenDigest: subjects[0].tokenDigest, claimId, text: 'Synthetic reply' }), ['40001']);
        demand((await store('dispatchPrivateCommand', { tokenDigest: subjects[0].tokenDigest, claimId })).status === 'dispatched', 'dispatch_not_admitted');
        demand((await store('dispatchPrivateCommand', { tokenDigest: subjects[0].tokenDigest, claimId })).status === 'already_dispatched', 'duplicate_dispatch_not_fenced');
        demand((await store('finishPrivateCommand', { tokenDigest: subjects[0].tokenDigest, claimId, text: 'Synthetic reply' })).status === 'ready', 'finish_not_ready');
        demand((await store('finishPrivateCommand', { tokenDigest: subjects[0].tokenDigest, claimId, text: 'Synthetic reply' })).status === 'already_ready', 'finish_same_result_not_idempotent');
      });
      await check('reply.rpc_unknown_receipt_is_terminal_without_provider_send', async () => {
        const deliveryId = randomUUID(); const source = plan.channels[0].source;
        const reply = await okRpc('worker', 'hermes_zalo_private_reply_v1', { p: { operation: 'claim', ...source, deliveryId } });
        demand(reply.status === 'claimed' && reply.text === 'Synthetic reply' && reply.recipientUid === plan.channels[0].senderUid
          && reply.commandId === command.commandId, 'reply_wrong_recipient_or_content');
        await deniedRpc('worker', 'hermes_zalo_private_reply_v1', { p: { operation: 'dispatch', ...source, generation: randomUUID(), deliveryId } });
        demand((await okRpc('worker', 'hermes_zalo_private_reply_v1', { p: { operation: 'dispatch', ...source, deliveryId } })).status === 'dispatched', 'reply_dispatch_not_admitted');
        demand((await okRpc('worker', 'hermes_zalo_private_reply_v1', { p: { operation: 'dispatch', ...source, deliveryId } })).status === 'already_dispatched', 'reply_duplicate_not_fenced');
        const ack = { operation: 'ack', ...source, deliveryId, outcome: 'unknown', providerMessageId: null };
        demand((await okRpc('worker', 'hermes_zalo_private_reply_v1', { p: ack })).status === 'unknown', 'reply_unknown_not_terminal');
        demand((await okRpc('worker', 'hermes_zalo_private_reply_v1', { p: ack })).status === 'unknown', 'reply_receipt_not_idempotent');
        await deniedRpc('worker', 'hermes_zalo_private_reply_v1', { p: { operation: 'dispatch', ...source, deliveryId } }, [409], ['PT409']);
        const row = (await pool.query('SELECT state,body,reply_body FROM app_private.hermes_zalo_private_commands WHERE id=$1', [command.commandId])).rows[0];
        assert.deepEqual(row, { state: 'UNKNOWN_EFFECT', body: null, reply_body: null });
      });
      await check('authority.crm_permission_revision_blocks_finish_and_reply', async () => {
        const items = [];
        for (const index of [0, 1]) {
          const queued = await okRpc('worker', 'hermes_zalo_private_command_v1', { p: intakePayload(index) });
          const nextClaim = randomUUID(); const tokenDigest = subjects[index].tokenDigest;
          demand((await store('claimPrivateCommand', { tokenDigest, claimId: nextClaim })).command?.commandId === queued.commandId, 'revision_fixture_claim_failed');
          await store('dispatchPrivateCommand', { tokenDigest, claimId: nextClaim });
          if (index === 0) await store('finishPrivateCommand', { tokenDigest, claimId: nextClaim, text: 'Must not be delivered after CRM revision changes' });
          items.push({ tokenDigest, claimId: nextClaim, commandId: queued.commandId });
        }
        const deliveryId = randomUUID(); const source = plan.channels[0].source;
        demand((await okRpc('worker', 'hermes_zalo_private_reply_v1', { p: { operation: 'claim', ...source, deliveryId } })).status === 'claimed', 'revision_reply_claim_failed');
        // Real CRM permission mutation on our exact synthetic roles. The bound
        // assistant uses context-only rights; conservative revision fencing
        // must still reject an answer generated before this permission change.
        await write(`BEGIN; ${plan.orgs.map(org => `DELETE FROM public.role_permissions
          WHERE organization_id=${lit(org.id)} AND role_id=${lit(org.roleId)} AND permission_key='rooms.view';`).join('\n')} COMMIT;`);
        const revisions = (await pool.query(`SELECT q.authorization_version captured_version,o.authorization_version current_version
          FROM app_private.hermes_zalo_private_commands q JOIN public.organizations o ON o.id=q.organization_id
          WHERE q.id=ANY($1::uuid[])`, [items.map(item => item.commandId)])).rows;
        demand(revisions.length === 2 && revisions.every(row => BigInt(row.current_version) > BigInt(row.captured_version)), 'fixture_permission_revision_not_bumped');
        await expectSqlDenied(() => store('finishPrivateCommand', { tokenDigest: items[1].tokenDigest, claimId: items[1].claimId, text: 'Stale authority reply' }));
        await deniedRpc('worker', 'hermes_zalo_private_reply_v1', { p: { operation: 'dispatch', ...source, deliveryId } });
        demand((await okRpc('worker', 'hermes_zalo_private_reply_v1', { p: { operation: 'ack', ...source, deliveryId,
          outcome: 'cancelled', providerMessageId: null } })).status === 'cancelled', 'stale_reply_cancel_failed');
        demand((await store('failPrivateCommand', { tokenDigest: items[1].tokenDigest, claimId: items[1].claimId,
          reason: 'runtime_unknown' })).status === 'unknown', 'stale_runtime_not_terminal');
      });
      await check('authority.revoke_blocks_finish_and_prepared_reply', async () => {
        // A: prepare reply first; B: leave model dispatch in progress. Revoke
        // each exact synthetic binding through its owner's real JWT.
        const items = [];
        for (const index of [0, 1]) {
          const queued = await okRpc('worker', 'hermes_zalo_private_command_v1', { p: intakePayload(index) });
          const nextClaim = randomUUID(); const tokenDigest = subjects[index].tokenDigest;
          demand((await store('claimPrivateCommand', { tokenDigest, claimId: nextClaim })).command?.commandId === queued.commandId, 'revoke_fixture_claim_failed');
          await store('dispatchPrivateCommand', { tokenDigest, claimId: nextClaim });
          if (index === 0) await store('finishPrivateCommand', { tokenDigest, claimId: nextClaim, text: 'Must not be delivered after unlink' });
          items.push({ tokenDigest, claimId: nextClaim, commandId: queued.commandId });
        }
        // Claim A's reply before unlink, so replay cannot be mistaken for empty discovery.
        const deliveryId = randomUUID(); const source = plan.channels[0].source;
        demand((await okRpc('worker', 'hermes_zalo_private_reply_v1', { p: { operation: 'claim', ...source, deliveryId } })).status === 'claimed', 'revoke_reply_claim_failed');
        for (const index of [0, 1]) {
          const binding = plan.channels[index].binding;
          demand((await okRpc(plan.actors[index], 'hermes_zalo_binding_v1', { p: { operation: 'unlink', organizationId: plan.orgs[index].id,
            bindingId: binding.bindingId, expectedEpoch: binding.epoch } })).status === 'revoked', 'unlink_failed');
        }
        await expectSqlDenied(() => store('finishPrivateCommand', { tokenDigest: items[1].tokenDigest, claimId: items[1].claimId, text: 'Revoked reply' }));
        await deniedRpc('worker', 'hermes_zalo_private_reply_v1', { p: { operation: 'dispatch', ...source, deliveryId } });
        // A cancellation is a fixture receipt, never evidence of a real send.
        demand((await okRpc('worker', 'hermes_zalo_private_reply_v1', { p: { operation: 'ack', ...source, deliveryId,
          outcome: 'cancelled', providerMessageId: null } })).status === 'cancelled', 'revoked_reply_cancel_failed');
      });
      } });
    } catch (error) { fatal = error; if (!cases.some(item => item.status === 'FAIL')) cases.push({ name: 'fixture_or_schema_setup', status: 'FAIL', code: safeCode(error) }); }
    finally {
      // Each SQL/HTTP mutation is awaited; provider verification also drains its
      // underlying request. Never release the TEST marker on unknown write ACK.
      try { await provider.close(); } catch { ctx.writeState.uncertain = true; }
      // No further pool operations are needed by cleanup. End it before the
      // cleanup capability can clear pendingCleanup, including idle failures.
      if (restricted) await restricted.end().catch(() => { ctx.writeState.uncertain = true; });
      await pool.end().catch(() => { ctx.writeState.uncertain = true; });
      if (cleanupRequired) {
        try {
            cleanupPhase = 'lease';
          await withTestCleanup(lease, ctx.test, async cleanupLease => {
            await ctx.assertLease(cleanupLease, ctx.test);
            cleanupPhase = 'recover_actor_ids';
            const found = psqlJson(ctx.test, `SELECT id,email FROM auth.users WHERE email IN (${plan.actors.map(actor => lit(actor.email)).join(',')})`);
            for (const actor of plan.actors) actor.id ??= found.find(row => row.email === actor.email)?.id ?? null;
            cleanupPhase = 'recover_connection_ids';
            const connections = psqlJson(ctx.test, `SELECT id FROM app_private.hermes_connections WHERE organization_id IN (${sqlIds(plan.orgs.map(org => org.id))})`);
            plan.connectionIds = [...new Set([...plan.connectionIds, ...connections.map(row => row.id)])];
            cleanupPhase = 'cde_cleanup';
            if (mode === 'cde') await write(cdeCleanupSql(plan), cleanupLease);
            cleanupPhase = 'channel_cleanup';
            await write(channelCleanupSql(plan, { mode }), cleanupLease);
            cleanupPhase = 'durable_cleanup';
            await write(durableCleanup(plan), cleanupLease);
            cleanupPhase = 'base_cleanup';
            await write(baseCleanup(plan), cleanupLease);
            cleanupPhase = 'auth_cleanup';
            for (const actor of plan.actors.filter(actor => actor.id)) {
              const deleted = await request(`/auth/v1/admin/users/${actor.id}`, ctx.cred.testSecretKey, ctx.cred.testSecretKey, undefined,
                { method: 'DELETE', held: cleanupLease });
              demand([200, 404].includes(deleted.status), 'fixture_auth_cleanup_failed');
            }
            cleanupPhase = 'role_cleanup';
            if (executorRole.cleanupRequired) await write(roleCleanupSql(plan), cleanupLease);
            cleanupPhase = 'base_channel_counts';
            const [baseCounts] = psqlJson(ctx.test, durableCounts(plan)); const [channelCounts] = psqlJson(ctx.test, channelCountsSql(plan));
            cleanupPhase = 'cde_counts';
            const cdeCounts = mode === 'cde' ? psqlJson(ctx.test, cdeCountsSql(plan))[0] : {};
            cleanupPhase = 'validate_counts';
            validateCleanupEvidence({ ...baseCounts, ...channelCounts, ...cdeCounts }, ctx.writeState); cleanupVerified = true;
          });
          cleanupPhase = 'verified';
          cases.push({ name: 'fixture.cleanup_verified', status: 'PASS' });
        } catch (error) { cases.push({ name: 'fixture.cleanup_verified', status: 'FAIL', code: safeCode(error) }); }
      }
      delete plan.rolePassword; crypto.destroy();
      let finalIdentity; try { finalIdentity = captureSourceIdentity(); } catch { /* recorded below */ }
      const unchanged = JSON.stringify(sourceIdentity) === JSON.stringify(finalIdentity);
      if (!unchanged) cases.push({ name: 'evidence.inputs_unchanged', status: 'FAIL', code: 'source_changed_during_run' });
      const receipt = { version: 1, scope: mode, observedAt: new Date().toISOString(), environment: 'test', projectRef: TEST_REF,
        fullPrivateFlowExecuted: mode === 'full' && workerOwned,
        fullPrivateFlowStatus: mode !== 'full' ? 'not_executed_scope'
          : (!fatal && cleanupVerified && !ctx.writeState.uncertain && !cases.some(item => item.status === 'FAIL') ? 'passed' : 'failed'),
        node: process.version, fixture: { runId: plan.run, cleanupRequired, cleanupVerified, uncertain: ctx.writeState.uncertain, cleanupPhase, cleanupIdentity: fixtureCleanupIdentity(plan) },
        sourceIdentity: { initial: sourceIdentity, final: finalIdentity, unchanged }, schemaEvidence, rpcDiagnostics, cdeEvidence,
        evidence: { realJwtActors: authenticatedActors, realPostgrest: postgrestResponses > 0, postgrestResponses,
          executorRoleProbe: executorRoleProbes > 0, executorRoleProbes,
          dedicatedLogin: principalVerified, ephemeralRoleChangesAttempted: executorRole.attempted,
          ephemeralRoleChanges: executorRole.confirmed, providerSend: false, modelExecution: false, schemaAppliedByHarness: false, productionWrites: false },
        limitations: [...(mode === 'cde' ? ['Positive SQL used exact payload claims from verified real Auth JWTs and rolled back; no positive PostgREST data claim.', 'The only concurrent writer changed exact fixture work-memory settings; no production row, worker lease or provider was touched.', 'Schedule revoke used an uncommitted inert grant with a REVOKED fixture binding; no live schedule creation or DM observation was proved.'] : []), ...(mode === 'jwt-management' ? ['JWT management scope only: worker lease, ingress, binding confirm, private intake/dispatch/reply were not executed.'] : []),
          'Executor cases use a freshly generated restricted TEST login with TLS; no production login is provisioned or validated.',
          'Zalo accounts/messages/lease are synthetic database fixtures; no provider or worker delivery is executed.',
          'Unknown/cancelled receipts are explicit synthetic protocol inputs, not observations of provider delivery.',
          'Only the specifically recorded CDE sharing-lock case proves a concurrent PostgreSQL interleaving; other cases do not prove concurrency, process-crash recovery, or runtime dispatch.',
          'Historical backups are apply-time attestations. The latest pre-apply dump is rehashed, but not restored; recovery also needs its reviewed forward migration.'], cases };
      const path = resolve(ROOT, mode === 'cde' ? '.cache/hermes-cde-live' : '.cache/hermes-private-flow', `receipt-${plan.run}.json`);
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    }
    demand(!fatal && (!cleanupRequired || cleanupVerified) && !ctx.writeState.uncertain && !cases.some(item => item.status === 'FAIL'), 'private_flow_harness_failed');
    return { runId: plan.run, scope: mode, fullPrivateFlowExecuted: mode === 'full' && workerOwned, passed: cases.length, cleanupVerified };
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (!options.run) console.log(JSON.stringify(executionPlan(options)));
    else runHarness(options).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(safeCode(error)); process.exitCode = 1; });
  } catch (error) { console.error(safeCode(error)); process.exitCode = 1; }
}
