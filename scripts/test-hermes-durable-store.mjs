// First live slice for P2A: isolated TEST fixtures and an actual restricted login.
// No migration application, provider refresh, scheduler or concurrency certification.
// The disposable LOGIN is a permission change and requires a verified full backup.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { dichKetNoi } from './db-query.mjs';
import { PROD_REF, batBuocDichTest, dangKyMatKhau, uri, psqlJson, lit, ident } from './test-env/lib.mjs';
import { assertTestLease, markTestCleanupRequired, withTestCleanup, withTestLock } from './test-env/lock.mjs';
import { readTestCredentials, fixturePlan as baseFixturePlan, fixtureSetupSql as baseFixtureSetupSql,
  fixtureCleanupSql as baseFixtureCleanupSql, testFetch, writeFixtureSql, validateCleanupEvidence } from './test-hermes-broker-authz.mjs';
import { extractFunctionDefinitions } from './network-center-function-bodies.mjs';
import { docManifestBackup, SAN_BANG_CO_DU_LIEU } from './apply-reviewed-migration.mjs';
import { createStorePool } from '../infra/hermes-broker/store-pool.mjs';
import { createStoreTransport } from '../infra/hermes-broker/store-transport.mjs';
import { createSessionCrypto } from '../infra/hermes-broker/session-crypto.mjs';
import { createSupabaseRefreshProvider } from '../infra/hermes-broker/supabase-refresh-provider.mjs';
import { createDurableConnectionStore } from '../infra/hermes-broker/durable-connection-store.mjs';
import { createDurableAuthority } from '../infra/hermes-broker/durable-authority.mjs';
import { createSupabaseDurableAuthAdapter } from '../infra/hermes-broker/supabase-durable-auth-adapter.mjs';
import { createBroker } from '../infra/hermes-broker/broker.mjs';
import { createConnectionControlPlane, createSupabaseAssistantSignIn,
  createSupabaseConnectionPreparation } from '../infra/hermes-broker/connection-control-plane.mjs';
import { createRoomReadService, createSupabaseRoomReads } from '../infra/hermes-broker/room-read-service.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const REPORT = '.cache/hermes-durable-store.json';
const CA_FILE = 'infra/hermes-broker/certs/supabase-ca-2021.crt';
const CA_FINGERPRINT = '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROLE = /^hermes_store_fixture_[0-9a-f]{32}$/;
const SHARE_LABEL = 'Hermes P3 sale page fixture';
const OPS = ['activate', 'read_connection', 'restrict_connection', 'renew_connection', 'revoke_connection', 'acquire_refresh',
  'dispatch_refresh', 'stage_refresh', 'publish_refresh', 'reconnect_session', 'revoke_session', 'release_refresh'];
const TABLES = ['capabilities', 'assistants', 'org_policies', 'sessions', 'connections', 'connection_tokens'];
const RPC_NAMES = new Set(['hermes_set_org_policy_v1', 'hermes_prepare_connection_v1', 'hermes_my_connections_v1',
  'hermes_connection_context_v1', 'get_my_organizations']);
const HERMES_MARKERS = new Set(['hermes_membership_required', 'hermes_ordinary_org_ambiguous', 'hermes_limits_invalid',
  'hermes_policy_invalid', 'hermes_context_changed', 'hermes_not_permitted']);
const INPUTS = ['scripts/test-hermes-durable-store.mjs', 'scripts/test-hermes-broker-authz.mjs',
  'scripts/test-env/lib.mjs', 'scripts/test-env/lock.mjs', 'scripts/db-query.mjs', 'scripts/lib/vault.mjs',
  'scripts/backup-before-schema.mjs', 'scripts/apply-reviewed-migration.mjs', 'scripts/lib/migration-target.mjs',
  'scripts/network-center-function-bodies.mjs', 'scripts/network-center-rollout-common.mjs', 'infra/hermes-broker/store-pool.mjs',
  'infra/hermes-broker/store-transport.mjs', 'infra/hermes-broker/session-crypto.mjs',
  'infra/hermes-broker/supabase-refresh-provider.mjs', 'infra/hermes-broker/supabase-adapter.mjs',
  'infra/hermes-broker/durable-connection-store.mjs', 'infra/hermes-broker/durable-authority.mjs',
  'infra/hermes-broker/supabase-durable-auth-adapter.mjs',
  'infra/hermes-broker/connection-control-plane.mjs',
  'infra/hermes-broker/room-read-service.mjs', 'infra/hermes-broker/room-read-projection.mjs', 'src/lib/roomSaleFacts.ts',
  'infra/hermes-broker/broker.mjs', 'infra/hermes-broker/stores.mjs', CA_FILE];
const BACKUP_MAX_AGE = 60 * 60_000;
const verifiedBackups = new WeakSet();
const demand = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }); };
const digest = value => createHash('sha256').update(value).digest('hex');
const ids = values => values.map(value => { demand(UUID.test(value), 'fixture_uuid_required'); return lit(value); }).join(',') || 'NULL';
const TLS_CODES = new Set(['SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID']);
export const safeError = error => TLS_CODES.has(error?.code) || /^[a-z][a-z0-9_]{0,80}$/.test(error?.code ?? '')
  ? error.code : 'assertion_or_dependency_failed';

// Public Supabase CA, verified against the official Studio custom-content URL:
// https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt
// Pin DER identity, so LF/CRLF checkout differences cannot change trust. Source
// receipts still hash the actual tracked bytes before and after the run.
export function loadFixtureCa({ read = file => readFileSync(file), clock = Date.now } = {}) {
  let certificate;
  try {
    const pem = Buffer.from(read(join(ROOT, CA_FILE))).toString('utf8');
    demand(/^-----BEGIN CERTIFICATE-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END CERTIFICATE-----(?:\r?\n)?$/.test(pem), 'fixture_ca_invalid');
    certificate = new X509Certificate(pem);
    demand(certificate.ca && certificate.fingerprint256.replaceAll(':', '') === CA_FINGERPRINT
      && certificate.verify(certificate.publicKey), 'fixture_ca_invalid');
  } catch { throw Object.assign(new Error('fixture_ca_invalid'), { code: 'fixture_ca_invalid' }); }
  const now = clock(), from = Date.parse(certificate.validFrom), to = Date.parse(certificate.validTo);
  demand(Number.isSafeInteger(now) && now >= from && now < to, 'fixture_ca_expired_or_not_yet_valid');
  return Object.freeze({ rejectUnauthorized: true, ca: certificate.toString() });
}
export function fixtureCleanupOutcome({ required, verified, uncertain }) {
  return { noFixturesCreated: !required, cleanupRequired: required,
    cleanupVerified: required && verified && !uncertain,
    cleanupStatus: !required ? 'not_required' : verified && !uncertain ? 'verified' : 'unverified' };
}
export function rpcDiagnostic(name, status, body, responseKind = 'json') {
  demand(RPC_NAMES.has(name) && ['json', 'invalid_json', 'no_response'].includes(responseKind), 'fixture_rpc_refused');
  const object = body !== null && typeof body === 'object' && !Array.isArray(body);
  return { endpoint: `/rest/v1/rpc/${name}`,
    httpStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null, responseKind,
    errorCode: object && typeof body.code === 'string' && /^(?:[0-9A-Z]{5}|PGRST[0-9]{3})$/.test(body.code) ? body.code : null,
    hermesMarker: object && HERMES_MARKERS.has(body.message) ? body.message : null,
    version: object && Number.isSafeInteger(body.version) && body.version >= 0 ? body.version : null };
}
export async function captureRpcResponse(name, response, diagnostics) {
  demand(RPC_NAMES.has(name), 'fixture_rpc_refused');
  let body;
  try { body = await response.json(); }
  catch {
    if (diagnostics.length < 128) diagnostics.push(rpcDiagnostic(name, response.status, null, 'invalid_json'));
    throw Object.assign(new Error('fixture_rpc_invalid_json'), { code: 'fixture_rpc_invalid_json' });
  }
  if (diagnostics.length < 128) diagnostics.push(rpcDiagnostic(name, response.status, body));
  return { status: response.status, body };
}

export function parseArguments(args) {
  demand(args.length === 6 && args[0] === '--env' && args[1] === 'test' && args[2] === '--expected-project-ref'
    && /^[a-z0-9]{20}$/.test(args[3] ?? '') && args[3] !== PROD_REF && args[4] === '--backup-manifest'
    && typeof args[5] === 'string' && args[5].length > 0 && !args[5].startsWith('--'), 'explicit_test_target_and_backup_required');
  return { environment: 'test', expectedProjectRef: args[3], backupManifestPath: args[5] };
}
export function validateBackupManifest(manifest, { expectedProjectRef, now, bytes, sha256 }) {
  demand(manifest?.environment === 'test' && manifest.projectRef === expectedProjectRef && expectedProjectRef !== PROD_REF,
    'backup_target_mismatch');
  const full = docManifestBackup('BACKUP_MANIFEST=verified-fixture-manifest', () => JSON.stringify(manifest), () => true,
    { environment: 'test', projectRef: expectedProjectRef });
  demand(full.ok && manifest.kind === 'full' && Array.isArray(manifest.excludedTableData)
    && Number.isInteger(manifest.tablesWithData) && manifest.tablesWithData >= SAN_BANG_CO_DU_LIEU, 'full_backup_required');
  const createdAt = Date.parse(manifest.createdAt);
  demand(Number.isFinite(now) && Number.isFinite(createdAt) && now >= createdAt && now - createdAt <= BACKUP_MAX_AGE, 'fresh_backup_required');
  demand(Number.isSafeInteger(bytes) && bytes > 0 && manifest.bytes === bytes && /^[a-f0-9]{64}$/.test(manifest.sha256 ?? '')
    && sha256 === manifest.sha256, 'backup_dump_integrity_mismatch');
  return Object.freeze({ environment: 'test', projectRef: expectedProjectRef, createdAt: manifest.createdAt,
    bytes, sha256, tablesWithData: manifest.tablesWithData });
}
export async function verifyBackup(path, expectedProjectRef, { readManifest = value => JSON.parse(readFileSync(value, 'utf8')),
  fileSize = value => statSync(value).size, fileHash = async value => {
    const hash = createHash('sha256'); for await (const chunk of createReadStream(value)) hash.update(chunk); return hash.digest('hex');
  }, clock = Date.now } = {}) {
  demand(typeof path === 'string' && path.length > 0, 'verified_backup_required');
  const manifest = readManifest(path);
  // Validate target before even opening a dump supplied by another environment.
  demand(manifest?.environment === 'test' && manifest.projectRef === expectedProjectRef && expectedProjectRef !== PROD_REF, 'backup_target_mismatch');
  demand(typeof manifest.file === 'string' && manifest.file.length > 0, 'backup_dump_required');
  const evidence = validateBackupManifest(manifest, { expectedProjectRef, now: clock(), bytes: fileSize(manifest.file), sha256: await fileHash(manifest.file) });
  verifiedBackups.add(evidence); return evidence;
}
export function targetMatches(expected, cred, db) {
  demand(expected && expected !== PROD_REF && cred.testRef === expected && db.ref === expected
    && db.user === `postgres.${expected}` && db.port === 5432, 'test_target_mismatch');
}
function sqlSources() {
  const dir = join(ROOT, 'supabase/migrations');
  return readdirSync(dir).filter(name => name.endsWith('.sql')).sort()
    .map(name => ({ path: `supabase/migrations/${name}`, sql: readFileSync(join(dir, name), 'utf8') }))
    .filter(({ sql }) => /\bhermes_/i.test(sql));
}
export function captureSourceIdentity({ readSource = file => readFileSync(join(ROOT, file)), migrations = sqlSources() } = {}) {
  return Object.fromEntries([...INPUTS, ...migrations.map(item => item.path)].map(file => [file, digest(readSource(file))]));
}
export function finalizeReceipt(report, reportPath, { capture = captureSourceIdentity } = {}) {
  // An unreadable final input is failed evidence, not a reason to leave the
  // previous run's PASS receipt as the only visible result.
  let finalSha256 = null, inputsUnchanged = false;
  try {
    finalSha256 = capture();
    inputsUnchanged = JSON.stringify(report.sourceIdentity.initialSha256) === JSON.stringify(finalSha256);
  } catch {
    report.cases.push({ name: 'evidence.source_identity_read', status: 'FAIL', code: 'source_unreadable_after_run' });
  }
  if (!inputsUnchanged) report.cases.push({ name: 'evidence.inputs_unchanged', status: 'FAIL', code: 'source_changed_during_run' });
  report.sourceIdentity = { ...report.sourceIdentity, finalSha256, inputsUnchanged };
  report.passed = report.cases.filter(item => item.status === 'PASS').length;
  report.failed = report.cases.filter(item => item.status === 'FAIL').length;
  const path = resolve(reportPath); mkdirSync(dirname(path), { recursive: true });
  const bytes = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(path.replace(/\.json$/, '') + `.${report.fixture.runId}.json`, bytes, { flag: 'wx' });
  writeFileSync(path, bytes);
  return report;
}
export function fixturePlan() {
  const plan = baseFixturePlan();
  plan.actors.forEach(actor => { actor.email = actor.email.replace('hermes-p1-', 'hermes-p2-'); });
  plan.orgs.forEach(org => { org.slug = org.slug.replace('hermes-p1-', 'hermes-p2-'); });
  return { ...plan, role: `hermes_store_fixture_${plan.run.replaceAll('-', '')}`,
    rolePassword: randomBytes(32).toString('base64url'), connectionIds: [],
    roomRead: { areaId: randomUUID(), scopeId: randomUUID(), buildingId: randomUUID(), roomId: randomUUID() } };
}
export function fixtureSetupSql(plan) {
  // New organizations have no trigger that provisions this scope. users.edit is
  // ORGANIZATION-only, so merely selecting a nonexistent scope grants nothing.
  const organizationScopes = plan.orgs.map(org => `insert into public.authorization_scopes(organization_id,scope_type)
    values (${lit(org.id)},'ORGANIZATION');`).join('\n');
  const extra = plan.orgs.map(org => `insert into public.role_permissions(organization_id,role_id,permission_key,effect)
    values (${lit(org.id)},${lit(org.roleId)},'users.edit','ALLOW');`).join('\n');
  const scopes = plan.memberships.map(m => `insert into public.role_binding_scopes(organization_id,role_binding_id,scope_id)
    select ${lit(plan.orgs[m.org].id)},${lit(m.bindingId)},s.id from public.authorization_scopes s
    where s.organization_id=${lit(plan.orgs[m.org].id)} and s.scope_type='ORGANIZATION'
    on conflict do nothing;`).join('\n');
  return baseFixtureSetupSql(plan).replace(/COMMIT;\s*$/, `${organizationScopes}\n${extra}\n${scopes}\nCOMMIT;`);
}
export function fixtureOrganizationScopeCountsSql(plan) {
  const orgs = ids(plan.orgs.map(org => org.id)), bindings = ids(plan.memberships.map(member => member.bindingId));
  return `select (select count(*)::int from public.authorization_scopes where organization_id in (${orgs}) and scope_type='ORGANIZATION') scope_rows,
    (select count(*)::int from public.role_binding_scopes e join public.authorization_scopes s
      on s.id=e.scope_id and s.organization_id=e.organization_id where e.organization_id in (${orgs})
      and e.role_binding_id in (${bindings}) and s.scope_type='ORGANIZATION') binding_edges`;
}
export function privateCleanupSql(plan) {
  const orgs = ids(plan.orgs.map(org => org.id));
  return `BEGIN;
    delete from app_private.hermes_connection_tokens where connection_id in (select id from app_private.hermes_connections where organization_id in (${orgs}));
    delete from app_private.hermes_connections where organization_id in (${orgs});
    delete from app_private.hermes_sessions where organization_id in (${orgs});
    delete from app_private.hermes_assistants where organization_id in (${orgs});
    delete from app_private.hermes_org_policies where organization_id in (${orgs});
    ${roomReadCleanupSql(plan)}
    delete from public.authorization_audit_events where organization_id in (${orgs});
    COMMIT;`;
}
export function roomReadFixtureSql(plan) {
  const org = plan.orgs[0], owner = plan.actors[2].id, r = plan.roomRead;
  demand([org.id, owner, r.areaId, r.scopeId, r.buildingId, r.roomId].every(id => UUID.test(id ?? '')), 'fixture_room_ids_required');
  // crm_available_rooms reads the published sale page (live share link per building
  // owner). Contact/description are public page columns now; the private negative
  // control is media, which the page reader returns and the projection never emits.
  return `BEGIN;
    insert into public.buildings(id,user_id,organization_id,name,province,district,ward,images)
      values (${lit(r.buildingId)},${lit(owner)},${lit(org.id)},'Hermes synthetic building','TEST','TEST','TEST','["PRIVATE_HERMES_FIXTURE"]'::jsonb);
    insert into public.rooms(id,building_id,organization_id,name,rent_price,deposit_amount,status,images)
      values (${lit(r.roomId)},${lit(r.buildingId)},${lit(org.id)},'Hermes synthetic extra room',200,200,'AVAILABLE','["PRIVATE_HERMES_FIXTURE"]'::jsonb);
    update public.buildings set images='["PRIVATE_HERMES_FIXTURE"]'::jsonb
      where id=${lit(org.buildingId)} and organization_id=${lit(org.id)};
    update public.rooms set images='["PRIVATE_HERMES_FIXTURE"]'::jsonb where id=${lit(org.roomId)} and organization_id=${lit(org.id)};
    insert into public.public_room_share_tokens(token,owner_id,organization_id,label)
      select 'hermes-p3-'||b.id::text,b.user_id,b.organization_id,${lit(SHARE_LABEL)} from public.buildings b
      where b.id in (${ids([r.buildingId, ...plan.orgs.map(value => value.buildingId)])}) and b.user_id is not null
      on conflict do nothing;
    insert into public.areas(id,user_id,organization_id,name) values (${lit(r.areaId)},${lit(owner)},${lit(org.id)},'Hermes synthetic area');
    insert into public.area_buildings(area_id,building_id,user_id,organization_id)
      values (${lit(r.areaId)},${lit(org.buildingId)},${lit(owner)},${lit(org.id)});
    insert into public.authorization_scopes(id,organization_id,scope_type,area_id)
      values (${lit(r.scopeId)},${lit(org.id)},'AREA',${lit(r.areaId)});
    COMMIT;`;
}
export function roomReadCleanupSql(plan) {
  const r = plan.roomRead, org = plan.orgs[0];
  demand([org.id, r?.areaId, r?.scopeId, r?.buildingId, r?.roomId].every(id => UUID.test(id ?? '')), 'fixture_room_ids_required');
  const shareTokens = [r?.buildingId, ...plan.orgs.map(value => value.buildingId)].map(value => { demand(UUID.test(value ?? ''), 'fixture_room_ids_required');
    return lit(`hermes-p3-${value}`); }).join(',');
  return `delete from public.public_room_share_tokens where label=${lit(SHARE_LABEL)} and token in (${shareTokens});
    delete from public.area_buildings where area_id=${lit(r.areaId)} and organization_id=${lit(org.id)};
    delete from public.authorization_scopes where organization_id=${lit(org.id)}
      and (id=${lit(r.scopeId)} or (scope_type='BUILDING' and building_id=${lit(r.buildingId)}));
    delete from public.rooms where id=${lit(r.roomId)} and organization_id=${lit(org.id)};
    delete from public.buildings where id=${lit(r.buildingId)} and organization_id=${lit(org.id)};
    delete from public.areas where id=${lit(r.areaId)} and organization_id=${lit(org.id)};`;
}
export function roleSetupSql(plan) {
  demand(ROLE.test(plan.role) && /^[A-Za-z0-9_-]{40,64}$/.test(plan.rolePassword), 'fixture_role_invalid');
  // Only an ephemeral TEST principal; never alter a pre-existing/deployed login.
  return `CREATE ROLE ${ident(plan.role)} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${lit(plan.rolePassword)}`;
}
export function roleCleanupSql(plan) {
  demand(ROLE.test(plan.role), 'fixture_role_invalid');
  return `DROP ROLE IF EXISTS ${ident(plan.role)}`;
}
export function countsSql(plan) {
  const orgs = ids(plan.orgs.map(org => org.id));
  const actors = ids(plan.actors.map(actor => actor.id).filter(Boolean));
  const specs = [
    ...['assistants', 'org_policies', 'sessions', 'connections'].map(name => [name, `app_private.hermes_${name}`, `organization_id in (${orgs})`]),
    ['tokens', 'app_private.hermes_connection_tokens', `connection_id in (${ids(plan.connectionIds)})`],
    ...['organizations', 'organization_memberships', 'organization_roles', 'role_permissions', 'role_bindings', 'role_binding_scopes', 'authorization_scopes', 'authorization_audit_events']
      .map(name => [name, `public.${name}`, `${name === 'organizations' ? 'id' : 'organization_id'} in (${orgs})`]),
    ['rooms', 'public.rooms', `id in (${ids(plan.orgs.map(org => org.roomId))})`],
    ['buildings', 'public.buildings', `id in (${ids(plan.orgs.map(org => org.buildingId))})`],
    ['room_read_rooms', 'public.rooms', `id=${lit(plan.roomRead.roomId)}`],
    ['room_read_buildings', 'public.buildings', `id=${lit(plan.roomRead.buildingId)}`],
    ['room_read_areas', 'public.areas', `id=${lit(plan.roomRead.areaId)}`],
    ['room_read_edges', 'public.area_buildings', `area_id=${lit(plan.roomRead.areaId)}`],
    ['profiles', 'public.profiles', `id in (${actors})`], ['superadmins', 'public.super_admins', `user_id in (${actors})`],
    ['auth_sessions', 'auth.sessions', `user_id in (${actors})`],
    ['auth_users', 'auth.users', `email in (${plan.actors.map(actor => lit(actor.email)).join(',')})`],
    ['fixture_role', 'pg_catalog.pg_roles', `rolname=${lit(plan.role)}`],
  ];
  return `select ${specs.map(([name, table, where]) => `(select count(*) from ${table} where ${where})::int ${name}`).join(',')}`;
}
export async function expectRejection(operation, codes, label = 'unlabelled') {
  let observed, rejected = false;
  try { await operation(); } catch (error) { rejected = true; observed = error?.code; }
  if (!codes.includes(observed)) {
    const safeCodes = ['timeout', 'forbidden', 'unauthorized', 'context_changed', 'backend_unavailable', 'invalid_request', 'store_denied', 'store_unavailable'];
    throw Object.assign(new Error('expected_rejection_missing'), { code: 'expected_rejection_missing',
      rejectionDiagnostics: { label: /^[a-z_]{1,64}$/.test(label) ? label : 'invalid_label', rejected,
        observed: safeCodes.includes(observed) ? observed : rejected ? 'other_error' : 'no_rejection' } });
  }
}
// All in-flight writes settle before cleanup. Unknown write outcome permanently
// retains the TEST lease marker, even when the cleanup query currently sees zero.
export async function guardedQuery(ctx, client, text, values = [], { write = false, lease = ctx.lease, assertLease = ctx.assertLease ?? assertTestLease } = {}) {
  await assertLease(lease, ctx.test);
  try { return await client.query({ text, values, queryMode: 'extended' }); }
  catch (error) {
    const rejected = error?.severity === 'ERROR' &&
      ((/^(?:22|23|42|40)[A-Z0-9]{3}$/.test(error.code ?? '') && error.code !== '40003') || ['P0001', '57014'].includes(error.code));
    if (write && !rejected) ctx.writeState.uncertain = true;
    throw error;
  }
}

export function createSerializedLeaseAssertions(assertLease = assertTestLease) {
  let tail = Promise.resolve();
  return (lease, test) => {
    // The shared TEST lease owns one PhienPsql session, whose chay() rejects
    // concurrent commands. Serialize only these checks, not HTTP/DB requests.
    const current = tail.then(() => assertLease(lease, test));
    tail = current.then(() => undefined, () => undefined);
    return current; // Never turn a failed lease assertion into successful admission.
  };
}

function fixtureWorkTracker(ctx, drainTimeoutMs) {
  demand(Number.isSafeInteger(drainTimeoutMs) && drainTimeoutMs > 0 && drainTimeoutMs <= 30_000, 'invalid_drain_timeout');
  const pending = new Set(); let closing = false;
  return {
    track(operation) {
      demand(!closing, 'fixture_transport_closing');
      // Register even the lease wait. A deadline may return before it finishes.
      const work = Promise.resolve().then(operation); pending.add(work);
      work.then(() => pending.delete(work), () => pending.delete(work)); return work;
    },
    async drain() {
      closing = true; if (!pending.size) return;
      let timer;
      try { await Promise.race([Promise.allSettled([...pending]), new Promise((_, reject) => {
        timer = setTimeout(() => {
          ctx.writeState.uncertain = true;
          reject(Object.assign(new Error('fixture_work_settlement_unknown'), { code: 'fixture_work_settlement_unknown' }));
        }, drainTimeoutMs);
      })]); } finally { clearTimeout(timer); }
    },
  };
}
export function createGuardedStoreTransport(ctx, transport, { assertLease = ctx.assertLease ?? assertTestLease, drainTimeoutMs = 30_000 } = {}) {
  const tracker = fixtureWorkTracker(ctx, drainTimeoutMs);
  return Object.freeze({ call(operation, payload, { signal = ctx.lease.signal } = {}) {
    return tracker.track(async () => {
      demand(signal instanceof AbortSignal && ctx.lease.signal instanceof AbortSignal, 'fixture_signal_required');
      const combined = AbortSignal.any([signal, ctx.lease.signal]); combined.throwIfAborted();
      await assertLease(ctx.lease, ctx.test); combined.throwIfAborted();
      try { return await transport.call(operation, payload, { signal: combined }); }
      catch (error) { if (error?.code === 'store_outcome_unknown') ctx.writeState.uncertain = true; throw error; }
    });
  }, drain: tracker.drain });
}
export async function guardedConnectionCall(ctx, store, operation, input, { signal = ctx.lease.signal } = {}) {
  demand(['activate', 'readConnection', 'restrictConnection', 'renewConnection', 'revokeConnection'].includes(operation), 'fixture_store_operation_refused');
  try { return await store[operation](input, { signal }); }
  catch (error) {
    // The protocol adapter can identify an unknown ACK after the transport has
    // returned JSON successfully. That uncertainty must also retain the marker.
    if (error?.code === 'store_outcome_unknown') ctx.writeState.uncertain = true;
    throw error;
  }
}
// Live caller preparation, not a replacement auth implementation. The injected
// authority is the same DB/AAD/actual-Auth/CRM resolver exercised by the broker.
export async function prepareFixtureRenewal(authority, connectionStore, token, signal) {
  demand(/^hc_[A-Za-z0-9_-]{43}$/.test(token ?? '') && signal instanceof AbortSignal, 'fixture_renewal_input_invalid');
  signal.throwIfAborted();
  const receipt = await authority.resolve(token, { signal }); signal.throwIfAborted();
  const tokenDigest = digest(token), joined = await connectionStore.readConnection({ tokenDigest }, { signal }); signal.throwIfAborted();
  demand(joined?.status === 'active' && joined.connection?.tokenDigest === tokenDigest
    && ['id', 'assistantId', 'userId', 'organizationId', 'epoch', 'expiresAt'].every(key => joined.connection[key] === receipt?.row?.[key])
    && UUID.test(joined.session?.credentialRef ?? '') && joined.session.credentialRef === joined.connection.credentialRef
    && Number.isSafeInteger(joined.session.revision) && joined.session.revision > 0, 'fixture_renewal_context_changed');
  const input = { tokenDigest, connectionId: joined.connection.id, expectedEpoch: joined.connection.epoch,
    credentialRef: joined.session.credentialRef, expectedRevision: joined.session.revision,
    expectedExpiresAt: joined.connection.expiresAt, requestedTtlMs: 900_000 };
  demand(await authority.checkUnchanged(token, receipt, { signal }) === undefined, 'fixture_renewal_context_changed'); signal.throwIfAborted();
  return input;
}
// Boundary probes mutate only rows belonging to this run's synthetic user/org,
// selected connection, credential and token. They are fixture data edits under
// the same TEST lease/backup/uncertainty guard, never authority used in production.
export function fixtureRenewalBoundaryMutation(plan, item, mode) {
  demand(['session_cap', 'hard_age_cap', 'expired'].includes(mode)
    && plan?.connectionIds?.includes(item?.connection?.id)
    && plan.memberships.some(m => m.actor === item.actorIndex && m.org === item.orgIndex)
    && plan.actors[item.actorIndex]?.id === item.binding?.userId && plan.orgs[item.orgIndex]?.id === item.binding?.organizationId
    && [item.connection.id, item.credentialRef, item.binding.assistantId, item.binding.userId, item.binding.organizationId].every(v => UUID.test(v ?? ''))
    && /^[a-f0-9]{64}$/.test(item.activation?.tokenDigest ?? ''), 'fixture_renewal_owner_required');
  const values = [item.activation.tokenDigest, item.connection.id, item.credentialRef,
    item.binding.organizationId, item.binding.userId, item.binding.assistantId];
  const owned = `WITH owned AS (SELECT c.id,c.credential_ref FROM app_private.hermes_connections c
    WHERE c.id=$2 AND c.credential_ref=$3 AND c.organization_id=$4 AND c.user_id=$5 AND c.assistant_id=$6),
    bounds AS (SELECT date_trunc('milliseconds',clock_timestamp()) AS now)`;
  if (mode === 'session_cap') return { values, text: `${owned},
    adjusted_session AS (UPDATE app_private.hermes_sessions s SET expires_at=b.now+interval '90 seconds'
      FROM bounds b WHERE s.id=$3 AND s.organization_id=$4 AND s.user_id=$5 AND s.assistant_id=$6
        AND EXISTS(SELECT 1 FROM owned) RETURNING s.expires_at),
    adjusted_token AS (UPDATE app_private.hermes_connection_tokens t SET expires_at=b.now+interval '30 seconds'
      FROM bounds b WHERE t.token_digest=$1 AND t.connection_id=$2 AND EXISTS(SELECT 1 FROM owned)
        AND EXISTS(SELECT 1 FROM adjusted_session) RETURNING t.expires_at)
    SELECT (SELECT count(*)::int FROM adjusted_session) AS session_rows,(SELECT count(*)::int FROM adjusted_token) AS token_rows,
      (SELECT floor(extract(epoch FROM expires_at)*1000)::bigint FROM adjusted_session) AS cap,
      (SELECT floor(extract(epoch FROM expires_at)*1000)::bigint FROM adjusted_token) AS expires` };
  return { values, text: `${owned}, adjusted_token AS (
    UPDATE app_private.hermes_connection_tokens t SET ${mode === 'hard_age_cap'
      ? "created_at=b.now-interval '30 days'+interval '120 seconds',expires_at=b.now+interval '30 seconds'"
      : "expires_at=b.now-interval '1 second'"}
    FROM bounds b WHERE t.token_digest=$1 AND t.connection_id=$2 AND EXISTS(SELECT 1 FROM owned)
    RETURNING t.expires_at,t.created_at)
    SELECT count(*)::int AS token_rows,max(floor(extract(epoch FROM expires_at)*1000))::bigint AS expires,
      max(floor(extract(epoch FROM created_at+interval '30 days')*1000))::bigint AS cap FROM adjusted_token` };
}
// Deterministic request interleaving, NOT a transaction-internal MVCC test. The
// real read pauses at an explicit JS await, a guarded SQL mutation commits, then
// the real final RPC runs. Always release and settle the read before cleanup.
export async function runFixtureReadInterleaving({ read, mutate, signal, timeoutMs = 15000 }) {
  demand(typeof read === 'function' && typeof mutate === 'function' && signal instanceof AbortSignal
    && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000, 'fixture_barrier_invalid');
  signal.throwIfAborted();
  const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]);
  let enter, release, entered = false;
  const reached = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
  const barrier = async () => { demand(!entered, 'fixture_barrier_reused'); entered = true; enter(); await held; combined.throwIfAborted(); };
  const pending = Promise.resolve().then(() => read(barrier, combined));
  const completed = pending.then(() => { throw Object.assign(new Error('fixture_barrier_missing'), { code: 'fixture_barrier_missing' }); });
  let rejectAbort;
  const cancelled = new Promise((_, reject) => { rejectAbort = reject; });
  // Keep cancellation observed even when a caller is aborted synchronously by
  // the read before Promise.race is reached, or the mutation itself rejects.
  void cancelled.catch(() => {});
  const onAbort = () => rejectAbort(Object.assign(new Error('fixture_barrier_cancelled'), { code: 'fixture_barrier_cancelled' }));
  combined.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    combined.throwIfAborted(); await Promise.race([reached, completed, cancelled]); combined.throwIfAborted();
    await mutate(); combined.throwIfAborted(); release();
    return await pending;
  } finally {
    release(); controller.abort(); clearTimeout(timer); combined.removeEventListener('abort', onAbort);
    await Promise.allSettled([pending, completed, cancelled]);
  }
}
export function assertRoomProjection(result, roomIds, buildingIds) {
  const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
  demand(exact(result, ['source', 'readAt', 'currency', 'completeness', 'listing', 'notice', 'publishedPages', 'totalInSnapshot', 'offset', 'nextOffset',
    'salePolicies', 'buildings', 'rooms'])
    && result.source === 'hermes_sale_listing_rooms_v1' && result.listing === 'published' && result.currency === 'VND' && result.completeness === 'complete'
    && Array.isArray(result.rooms) && result.totalInSnapshot === roomIds.length, 'fixture_room_projection_invalid');
  assert.deepEqual(result.rooms.map(row => row.id).sort(), [...roomIds].sort());
  assert.deepEqual([...new Set(result.rooms.map(row => row.building?.id))].sort(), [...buildingIds].sort());
  assert.deepEqual(result.buildings.map(row => row.id).sort(), [...buildingIds].sort());
  for (const row of result.rooms) {
    demand(exact(row, ['id', 'code', 'name', 'building', 'floor', 'areaM2', 'priceVnd', 'rentVnd', 'depositVnd', 'status', 'availability',
      'statusLines', 'roomType', 'amenities', 'salePolicy'])
      && exact(row.building, ['id', 'name', 'code']) && exact(row.availability, ['kind', 'label', 'availableOn']), 'fixture_room_projection_invalid');
  }
  demand(!JSON.stringify(result).includes('PRIVATE_HERMES_FIXTURE'), 'fixture_room_projection_contains_private_data');
  return result;
}
export function createLeaseReadFetch(ctx, { assertLease = ctx.assertLease ?? assertTestLease, request = fetch, drainTimeoutMs = 30_000 } = {}) {
  const tracker = fixtureWorkTracker(ctx, drainTimeoutMs);
  const paths = new Map([['/auth/v1/user', 'GET'], ['/rest/v1/rpc/get_authorization_context_v1', 'POST'],
    ['/rest/v1/rpc/get_my_organizations', 'POST'], ['/rest/v1/rpc/hermes_scope_buildings_v1', 'POST'],
    ['/rest/v1/rpc/hermes_room_scope_map_v1', 'POST'], ['/rest/v1/rpc/hermes_sale_listing_rooms_v1', 'POST']]);
  const read = async (url, options) => tracker.track(async () => {
    const parsed = new URL(url);
    demand(parsed.origin === ctx.url && !parsed.search && !parsed.hash && !parsed.username && !parsed.password
      && paths.get(parsed.pathname) === options?.method && options.redirect === 'error', 'fixture_read_endpoint_refused');
    demand(options.signal instanceof AbortSignal && ctx.lease.signal instanceof AbortSignal, 'fixture_signal_required');
    const signal = AbortSignal.any([options.signal, ctx.lease.signal]); signal.throwIfAborted();
    await assertLease(ctx.lease, ctx.test); signal.throwIfAborted();
    const started = Date.now();
    try {
      const response = await request(url, { ...options, signal });
      if (parsed.pathname === '/rest/v1/rpc/hermes_room_scope_map_v1' && Array.isArray(ctx.rpcDiagnostics) && ctx.rpcDiagnostics.length < 128) {
        let sqlState = null;
        // Error bodies only, bounded diagnostics; never record request/JWT/body.
        if (!response.ok) {
          const reader = response.clone().body?.getReader();
          try {
            const chunks=[]; let size=0;
            while(reader) { const part=await reader.read(); if(part.done)break; size+=part.value.byteLength;
              if(size>8192)break; chunks.push(Buffer.from(part.value)); }
            if(size<=8192) { const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if(/^[0-9A-Z]{5}$/.test(data?.code??''))sqlState=data.code; }
          } catch {} finally { reader?.cancel().catch(()=>{}); }
        }
        ctx.rpcDiagnostics.push({ endpoint: parsed.pathname, httpStatus: response.status, sqlState, elapsedMs: Date.now() - started });
      }
      return response;
    } catch(error) {
      if(parsed.pathname === '/rest/v1/rpc/hermes_room_scope_map_v1' && Array.isArray(ctx.rpcDiagnostics) && ctx.rpcDiagnostics.length < 128)
        ctx.rpcDiagnostics.push({ endpoint: parsed.pathname, httpStatus: null, sqlState: null, elapsedMs: Date.now() - started, aborted: signal.aborted });
      throw error;
    }
  });
  return Object.assign(read, { drain: tracker.drain });
}
export function createTrackedControlFetch(ctx, { assertLease = ctx.assertLease ?? assertTestLease, request = fetch, drainTimeoutMs = 30_000 } = {}) {
  const tracker = fixtureWorkTracker(ctx, drainTimeoutMs);
  return Object.freeze({ fetch(url, options) {
    const parsed = new URL(url);
    demand(parsed.origin === ctx.url && !parsed.hash && !parsed.username && !parsed.password
      && options?.method === 'POST' && options.redirect === 'error'
      && ((parsed.pathname === '/auth/v1/token' && parsed.search === '?grant_type=password')
        || (parsed.pathname === '/rest/v1/rpc/hermes_prepare_connection_v1' && !parsed.search)), 'fixture_control_endpoint_refused');
    demand(options.signal instanceof AbortSignal && ctx.lease.signal instanceof AbortSignal, 'fixture_signal_required');
    const signal = AbortSignal.any([options.signal, ctx.lease.signal]);
    return tracker.track(async () => {
      signal.throwIfAborted(); await assertLease(ctx.lease, ctx.test); signal.throwIfAborted();
      // Never cancel a dispatched Auth/prepare POST and mistake client timeout
      // for a rolled-back server write. Cleanup drains this exact promise.
      return testFetch(ctx, url, { ...options, signal: undefined }, { write: true, fetchImpl: request });
    });
  }, drainWrites: tracker.drain });
}
export async function guardedControlConnect(ctx, control, input, { signal = ctx.lease.signal } = {}) {
  try { return await control.connect(input, { signal }); }
  catch (error) {
    if (['sign_in_outcome_unknown', 'prepare_outcome_unknown', 'activation_outcome_unknown'].includes(error?.code)) ctx.writeState.uncertain = true;
    throw error;
  }
}
export function assertBrokerContext(result, binding) {
  demand(result?.isError === false && result.content?.length === 1 && result.content[0]?.type === 'text', 'broker_context_invalid');
  const value = JSON.parse(result.content[0].text);
  assert.deepEqual(Object.keys(value).sort(), ['assistantId', 'contextVersion', 'organizationId', 'permissions', 'userId']);
  for (const key of ['assistantId', 'userId', 'organizationId']) assert.equal(value[key], binding[key]);
  assert.deepEqual(value.permissions, { read: ['assistant.context.read'], action: [] });
  assert.match(value.contextVersion, /^[a-f0-9]{64}$/);
  return value;
}

async function testContext(expectedProjectRef) {
  const cred = readTestCredentials();
  demand(cred.testRef === expectedProjectRef && cred.testRef !== PROD_REF, 'test_target_mismatch');
  const db = await dichKetNoi('test'); targetMatches(expectedProjectRef, cred, db);
  dangKyMatKhau([db]);
  const test = uri(db.host, db.ref);
  const [markers] = psqlJson(test, `select to_regclass('test_env.danh_dau') is not null marker, to_regclass('test_env.active_run') is not null lease_marker`);
  demand(markers?.marker && markers?.lease_marker, 'existing_test_markers_required');
  await batBuocDichTest(cred, test);
  return { cred, db, test, url: `https://${cred.testRef}.supabase.co` };
}
async function rpc(ctx, accessToken, name, args, write = false) {
  demand(RPC_NAMES.has(name), 'fixture_rpc_refused');
  await ctx.assertLease(ctx.lease, ctx.test);
  let response;
  try {
    response = await testFetch(ctx, `${ctx.url}/rest/v1/rpc/${name}`, { method: 'POST',
      headers: { apikey: ctx.cred.testPublishableKey, Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json', 'Content-Profile': 'public' }, body: JSON.stringify(args) }, { write });
  } catch (error) {
    if (ctx.rpcDiagnostics.length < 128) ctx.rpcDiagnostics.push(rpcDiagnostic(name, null, null, 'no_response'));
    throw error;
  }
  return captureRpcResponse(name, response, ctx.rpcDiagnostics);
}

export async function runHarness({ expectedProjectRef, backupManifestPath, verifiedBackup, context, lease, reportPath = REPORT, sourceIdentity } = {}) {
  demand(/^[a-z0-9]{20}$/.test(expectedProjectRef ?? '') && expectedProjectRef !== PROD_REF, 'explicit_test_target_required');
  const backup = verifiedBackup ?? await verifyBackup(backupManifestPath, expectedProjectRef);
  demand(verifiedBackups.has(backup) && backup.projectRef === expectedProjectRef, 'verified_backup_required');
  const initialSources = sourceIdentity ?? captureSourceIdentity();
  const connection = context ?? await testContext(expectedProjectRef);
  targetMatches(expectedProjectRef, connection.cred, connection.db);
  if (!lease) return withTestLock(connection, held => runHarness({ expectedProjectRef, verifiedBackup: backup, context: connection, lease: held, reportPath, sourceIdentity: initialSources }));
  const ctx = { ...connection, lease, signal: lease.signal, writeState: { uncertain: false }, rpcDiagnostics: [],
    assertLease: createSerializedLeaseAssertions() };
  const plan = fixturePlan(), cases = [];
  const brokerEvidence = { independentControlPlaneSession: false, contextAndScopeIsolation: false, inputDenials: false, quotaIsolation: false,
    restrictionAndRevocation: false, postAuditRecheck: false };
  let cleanupRequired = false, cleanupVerified = false, principalVerified = false, authenticatedActors = 0, adminClosed = false;
  let admin, restricted, tls, guardedTransport, trackedControl, trackedReads, roleCreationConfirmed = false, fixtureScopeEvidence = null;
  const crypto = createSessionCrypto({ activeKeyVersion: 'fixture', keys: new Map([['fixture', randomBytes(32)]]) });
  const provider = createSupabaseRefreshProvider({ url: ctx.url, publishableKey: ctx.cred.testPublishableKey });
  const query = (text, values = [], options = {}) => guardedQuery(ctx, admin, text, values, options);
  const sqlWrite = (sql, held = lease) => writeFixtureSql(ctx, sql, { lease: held, assertLease: ctx.assertLease });
  const check = async (name, operation) => {
    await ctx.assertLease(lease, ctx.test);
    try { await operation(); cases.push({ name, status: 'PASS' }); }
    catch (error) { cases.push({ name, status: 'FAIL', code: safeError(error),
      ...(error?.code === 'expected_rejection_missing' ? { rejectionDiagnostics: error.rejectionDiagnostics } : {}) }); }
  };
  const signIn = async actor => {
    await ctx.assertLease(lease, ctx.test);
    const response = await testFetch(ctx, `${ctx.url}/auth/v1/token?grant_type=password`, { method: 'POST',
      headers: { apikey: ctx.cred.testPublishableKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: actor.email, password: actor.password }) }, { write: true });
    demand(response.ok, 'fixture_signin_failed'); const result = await response.json();
    const verified = await provider.verifySession({ accessToken: result.access_token, signal: lease.signal });
    demand(verified.userId === actor.id && UUID.test(verified.sessionId), 'fixture_auth_identity_mismatch');
    return { accessToken: result.access_token, refreshToken: result.refresh_token, verified };
  };
  try {
    await ctx.assertLease(lease, ctx.test);
    tls = loadFixtureCa();
    admin = new pg.Pool({ ...connection.db, database: 'postgres', ssl: tls, max: 2,
      connectionTimeoutMillis: 5000, query_timeout: 15000, statement_timeout: 12000, lock_timeout: 3000,
      options: '-c statement_timeout=12000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=15000', application_name: 'hermes-durable-fixture-admin' });
    admin.on('error', () => { if (cleanupRequired) ctx.writeState.uncertain = true; });
    // Guard exact function bodies before creating credentials or fixtures.
    const expected = new Map(sqlSources().flatMap(source => extractFunctionDefinitions(source.sql, source.path))
      .filter(d => /^(?:app_private|public)\.hermes_/.test(d.qualifiedName)).map(d => [d.qualifiedName, d.bodyDigest]));
    demand(OPS.every(name => expected.has(`app_private.hermes_store_${name}_v1`)), 'reviewed_store_schema_required');
    const live = (await query(`select n.nspname||'.'||p.proname name,p.prosrc,p.prosecdef,pg_get_userbyid(p.proowner) owner,p.proconfig
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname=any($1::text[])`, [[...expected.keys()]])).rows;
    demand(live.length === expected.size && live.every(row => row.prosecdef && row.owner === 'postgres'
      && row.proconfig?.some(value => value.startsWith('search_path=pg_catalog,'))
      && digest(row.prosrc.replace(/\r\n?/g, '\n')) === expected.get(row.name)), 'reviewed_store_schema_required');
    cases.push({ name: 'schema.reviewed_function_bodies_and_owner', status: 'PASS' });
    demand((await query('select 1 from pg_catalog.pg_roles where rolname=$1', [plan.role])).rowCount === 0,
      'fixture_role_already_exists');
    const backupAge = Date.now() - Date.parse(backup.createdAt);
    demand(backupAge >= 0 && backupAge <= BACKUP_MAX_AGE, 'fresh_backup_required');
    markTestCleanupRequired(lease, ctx.test); cleanupRequired = true;
    await query(roleSetupSql(plan), [], { write: true });
    roleCreationConfirmed = true;
    await query(`GRANT hermes_store_executor TO ${ident(plan.role)}`, [], { write: true });
    restricted = createStorePool({ projectRef: ctx.db.ref, host: ctx.db.host, role: plan.role, password: plan.rolePassword, ca: tls.ca,
      onIdleFailure: () => { ctx.writeState.uncertain = true; } });
    const transport = createStoreTransport({ pool: restricted, expectedRole: plan.role });
    guardedTransport = createGuardedStoreTransport(ctx, transport);
    const store = (operation, payload) => guardedTransport.call(operation, payload);
    const connectionStore = createDurableConnectionStore({ transport: guardedTransport });
    const connectionCall = (operation, payload) => guardedConnectionCall(ctx, connectionStore, operation, payload);
    trackedReads = createLeaseReadFetch(ctx);
    const auth = createSupabaseDurableAuthAdapter({ url: ctx.url, publishableKey: ctx.cred.testPublishableKey,
      fetch: trackedReads });
    const authCalls = { verifySession: 0, readAuthorization: 0 };
    const countedAuth = Object.fromEntries(Object.keys(authCalls).map(name => [name, async input => {
      authCalls[name] += 1; return auth[name](input);
    }]));
    const authority = createDurableAuthority({ connectionStore, crypto, auth: countedAuth, timeoutMs: 15_000 });
    const broker = createBroker({ authority, limits: { timeoutMs: 30_000 } });
    const contextOf = async (item, selectedBroker = broker) => assertBrokerContext(
      await selectedBroker.callTool(item.token, 'crm_auth_context', {}), item.binding);
    let brokerSubjects;
    trackedControl = createTrackedControlFetch(ctx);
    const control = createConnectionControlPlane({ auth,
      signInProvider: createSupabaseAssistantSignIn({ url: ctx.url, publishableKey: ctx.cred.testPublishableKey, fetch: trackedControl.fetch }),
      preparation: createSupabaseConnectionPreparation({ url: ctx.url, publishableKey: ctx.cred.testPublishableKey, fetch: trackedControl.fetch }),
      connectionStore: { activate: (input, options) => guardedConnectionCall(ctx, connectionStore, 'activate', input, options) }, crypto });
    await check('acl.private_surface_and_table_denials', async () => {
      const functions = OPS.map(name => `app_private.hermes_store_${name}_v1(jsonb)`);
      const acl = (await query(`select r.role,f.signature,has_function_privilege(r.role,f.signature,'EXECUTE') allowed
        from unnest($1::text[]) r(role) cross join unnest($2::text[]) f(signature)`, [['anon', 'authenticated', 'service_role', plan.role], functions])).rows;
      demand(acl.length === functions.length * 4 && acl.every(row => row.allowed === (row.role === plan.role)), 'function_acl_mismatch');
      const tables = (await query(`select r.role,t.name,p.privilege,has_table_privilege(r.role,t.name,p.privilege) allowed
        from unnest($1::text[]) r(role) cross join unnest($2::text[]) t(name) cross join unnest($3::text[]) p(privilege)`,
      [['anon', 'authenticated', 'service_role', plan.role], TABLES.map(name => `app_private.hermes_${name}`), ['SELECT', 'INSERT', 'UPDATE', 'DELETE']])).rows;
      demand(tables.length === 4 * TABLES.length * 4 && tables.every(row => row.allowed === false), 'private_table_acl_mismatch');
      const rls = (await query(`select relrowsecurity enabled from pg_class where oid=any($1::regclass[])`, [TABLES.map(name => `app_private.hermes_${name}`)])).rows;
      demand(rls.length === TABLES.length && rls.every(row => row.enabled), 'private_table_rls_mismatch');
      await expectRejection(() => guardedQuery(ctx, restricted, 'select count(*) from app_private.hermes_sessions'), ['42501']);
      const response = await store('readConnection', { tokenDigest: '0'.repeat(64) });
      demand(response.status === 'unavailable', 'restricted_login_store_failed'); principalVerified = true;
    });
    demand(principalVerified, 'restricted_principal_required');
    for (const actor of plan.actors) {
      await ctx.assertLease(lease, ctx.test);
      const response = await testFetch(ctx, `${ctx.url}/auth/v1/admin/users`, { method: 'POST',
        headers: { apikey: ctx.cred.testSecretKey, Authorization: `Bearer ${ctx.cred.testSecretKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: actor.email, password: actor.password, email_confirm: true, user_metadata: { full_name: 'Hermes P2 synthetic fixture' } }) }, { write: true });
      demand(response.ok, 'fixture_auth_create_failed'); actor.id = (await response.json()).id;
      demand(UUID.test(actor.id ?? ''), 'fixture_actor_id_invalid');
      actor.session = await signIn(actor); authenticatedActors += 1;
    }
    await sqlWrite(fixtureSetupSql(plan));
    const scopeCounts = (await query(fixtureOrganizationScopeCountsSql(plan))).rows[0];
    fixtureScopeEvidence = { scopeRows: Number.isSafeInteger(scopeCounts?.scope_rows) ? scopeCounts.scope_rows : null,
      bindingEdges: Number.isSafeInteger(scopeCounts?.binding_edges) ? scopeCounts.binding_edges : null };
    demand(fixtureScopeEvidence.scopeRows === plan.orgs.length && fixtureScopeEvidence.bindingEdges === plan.memberships.length,
      'fixture_organization_scope_missing');
    cases.push({ name: 'fixture.organization_policy_scopes', status: 'PASS' });
    for (const [index, org] of plan.orgs.entries()) {
      const result = await rpc(ctx, plan.actors[index].session.accessToken, 'hermes_set_org_policy_v1', {
        p_org: org.id, p_expected_version: 0, p_enabled: true, p_read: ['assistant.context.read'], p_action: [], p_scope_ids: [],
      }, true); demand(result.status === 200 && result.body.version === 1, 'fixture_policy_setup_failed');
    }
    const issue = async (actorIndex = 0, orgIndex = 0, { readCapabilities = ['assistant.context.read'], scopeIds = [] } = {}) => {
      const actor = plan.actors[actorIndex], org = plan.orgs[orgIndex], session = await signIn(actor);
      const result = await rpc(ctx, session.accessToken, 'hermes_prepare_connection_v1', {
        p_org: org.id, p_read: readCapabilities, p_action: [], p_scope_ids: scopeIds,
      }, true); demand(result.status === 200 && result.body.userId === actor.id && result.body.organizationId === org.id, 'fixture_prepare_failed');
      const prepared = result.body, credentialRef = randomUUID(), token = `hc_${randomBytes(32).toString('base64url')}`;
      plan.connectionIds.push(prepared.id);
      const binding = { assistantId: prepared.assistantId, userId: actor.id, organizationId: org.id, sessionId: session.verified.sessionId };
      const material = { accessToken: session.accessToken, refreshToken: session.refreshToken, expiresAt: session.verified.expiresAt };
      const activation = { connectionId: prepared.id, expectedEpoch: prepared.epoch, operationId: randomUUID(), intentSecret: prepared.intentSecret,
        userId: actor.id, providerSessionId: binding.sessionId, credentialRef, tokenDigest: digest(token),
        tokenExpiresAt: Math.min(Date.now() + 10 * 60_000, material.expiresAt), sessionEnvelope: crypto.seal(material, binding), sessionExpiresAt: material.expiresAt };
      const activationBundle = { prepared, operationId: activation.operationId, credentialRef, binding,
        tokenDigest: activation.tokenDigest, tokenExpiresAt: activation.tokenExpiresAt,
        sessionEnvelope: activation.sessionEnvelope, sessionExpiresAt: activation.sessionExpiresAt };
      const activated = await connectionCall('activate', activationBundle);
      demand(activated.ok && activated.status === 'activated', 'fixture_activation_failed');
      return { token, binding, material, activation, activationBundle, connection: activated.connection, credentialRef, actorIndex, orgIndex };
    };
    const acquire = async issued => {
      const ownerId = randomUUID();
      const result = await store('acquireRefresh', { credentialRef: issued.credentialRef, binding: issued.binding, ownerId, leaseMs: 30000 });
      demand(result.status === 'acquired', 'refresh_acquisition_failed');
      return { credentialRef: issued.credentialRef, binding: issued.binding, ownerId, revision: result.credential.revision, fence: result.lease.fence };
    };
    const read = issued => store('readConnection', { tokenDigest: issued.activation.tokenDigest });
    const stage = async issued => {
      const claim = await acquire(issued);
      demand((await store('dispatchRefresh', claim)).ok, 'refresh_dispatch_failed');
      const payload = { ...claim, envelope: crypto.seal(issued.material, issued.binding), expiresAt: issued.material.expiresAt };
      demand((await store('stageRefresh', payload)).ok, 'refresh_stage_failed'); return { claim, payload };
    };
    await check('jwt.self_context_and_cross_company_denials', async () => {
      for (const [index, actor] of plan.actors.entries()) {
        const own = await rpc(ctx, actor.session.accessToken, 'get_my_organizations', {});
        demand(own.status === 200 && own.body.user_id === actor.id, 'auth_uid_mismatch');
        if (index < 2) {
          const denied = await rpc(ctx, actor.session.accessToken, 'hermes_prepare_connection_v1', {
            p_org: plan.orgs[1 - index].id, p_read: ['assistant.context.read'], p_action: [], p_scope_ids: [],
          }, true); demand(denied.status === 403 && denied.body.code === '42501', 'cross_company_not_denied');
        }
      }
      const a = await issue(), b = await issue(1, 1), sa = await issue(2, 0), sb = await issue(2, 1);
      demand(sa.binding.assistantId !== sb.binding.assistantId, 'superadmin_namespace_shared');
      for (const item of [a, b, sa, sb]) {
        const current = await read(item); demand(current.status === 'active', 'joined_read_failed');
        assert.deepEqual(current.session.binding, item.binding);
        assert.deepEqual(crypto.open(current.session.envelope, item.binding), item.material);
        const own = await rpc(ctx, plan.actors[item.actorIndex].session.accessToken, 'hermes_connection_context_v1', { p_connection_id: item.connection.id });
        demand(own.status === 200 && own.body.userId === item.binding.userId && own.body.organizationId === item.binding.organizationId,
          'public_context_identity_mismatch');
        assert.deepEqual(own.body.effective, { read: ['assistant.context.read'], action: [] });
        demand(!/"(?:envelope|sessionEnvelope|credentialRef|tokenDigest|intentSecret|accessToken|refreshToken)"/.test(JSON.stringify(own.body)),
          'public_context_contains_credentials');
      }
      const cross = await rpc(ctx, plan.actors[1].session.accessToken, 'hermes_connection_context_v1', { p_connection_id: a.connection.id });
      demand(cross.status === 403 && cross.body.code === '42501', 'cross_user_context_not_denied');
      await expectRejection(() => store('acquireRefresh', { credentialRef: a.credentialRef, binding: b.binding, ownerId: randomUUID(), leaseMs: 30000 }), ['store_denied']);
      brokerSubjects = { a, b, sa, sb };
    });
    await check('broker.opaque_context_and_resource_metadata_isolation', async () => {
      demand(brokerSubjects, 'broker_subjects_unavailable');
      for (const item of Object.values(brokerSubjects)) {
        const tools = await broker.listTools(item.token);
        assert.deepEqual(tools.tools.map(tool => tool.name), ['crm_auth_context']);
        item.initialContext = await contextOf(item);
        const current = await authority.resolve(item.token, { signal: lease.signal });
        assert.deepEqual(current.assistantScopeIds, []);
        assert.deepEqual(current.effective, { read: ['assistant.context.read'], action: [] });
        assert.deepEqual(current.scopesByPermission['assistant.context.read'], { buildingIds: [], cashbookIds: [] });
        assert.deepEqual(current.scopesByPermission['rooms.view'], { buildingIds: [plan.orgs[item.orgIndex].buildingId], cashbookIds: [] });
        assert.equal(current.isSuperadmin, item.actorIndex === 2);
      }
      demand(brokerSubjects.sa.initialContext.assistantId !== brokerSubjects.sb.initialContext.assistantId, 'broker_superadmin_namespace_shared');
      brokerEvidence.contextAndScopeIsolation = true;
    });
    await check('broker.control_plane_creates_independent_assistant_session', async () => {
      const actor = plan.actors[0], browserToken = actor.session.accessToken;
      const before = await auth.verifySession({ accessToken: browserToken, signal: lease.signal });
      const connected = await guardedControlConnect(ctx, control, { browserAccessToken: browserToken,
        email: actor.email, password: actor.password, organizationId: plan.orgs[0].id,
        restrictions: { read: ['assistant.context.read'], action: [] }, scopeIds: [] });
      demand(connected.status === 'active' && /^hc_[A-Za-z0-9_-]{43}$/.test(connected.token), 'control_connection_invalid');
      plan.connectionIds.push(connected.connection.id);
      const joined = await connectionCall('readConnection', { tokenDigest: digest(connected.token) });
      demand(joined?.status === 'active', 'control_joined_read_failed');
      const material = crypto.open(joined.session.envelope, joined.session.binding);
      const assistant = await auth.verifySession({ accessToken: material.accessToken, signal: lease.signal });
      const after = await auth.verifySession({ accessToken: browserToken, signal: lease.signal });
      assert.deepEqual(after, before);
      assert.equal(assistant.userId, actor.id);
      assert.equal(assistant.sessionId, joined.session.binding.sessionId);
      assert.notEqual(assistant.sessionId, before.sessionId);
      assert.notEqual(material.accessToken, browserToken);
      assertBrokerContext(await broker.callTool(connected.token, 'crm_auth_context', {}), joined.session.binding);
      brokerEvidence.independentControlPlaneSession = true;
    });
    await check('broker.invalid_args_unknown_tool_and_legacy_control_denied', async () => {
      demand(brokerSubjects, 'broker_subjects_unavailable');
      const { a } = brokerSubjects;
      await assert.rejects(broker.callTool(a.token, 'crm_auth_context', { organizationId: plan.orgs[1].id }), { code: 'invalid_request', status: 400 });
      await assert.rejects(broker.callTool(a.token, 'phong_trong', {}), { code: 'tool_not_available', status: 403 });
      await assert.rejects(broker.issueConnection({}), { code: 'forbidden', status: 403 });
      await assert.rejects(broker.restrictConnection(a.connection.id, { read: [], action: [] }), { code: 'forbidden', status: 403 });
      await assert.rejects(broker.revokeConnection(a.connection.id), { code: 'forbidden', status: 403 });
      brokerEvidence.inputDenials = true;
    });
    await check('broker.quota_per_connection_before_expensive_auth', async () => {
      demand(brokerSubjects, 'broker_subjects_unavailable');
      const fixedQuotaClock = Date.now();
      const limited = createBroker({ authority, clock: () => fixedQuotaClock,
        limits: { maxRequestsPerMinute: 1, timeoutMs: 30_000 } });
      await contextOf(brokerSubjects.a, limited);
      const before = { ...authCalls };
      await assert.rejects(limited.callTool(brokerSubjects.a.token, 'crm_auth_context', {}), { code: 'rate_limited', status: 429 });
      assert.deepEqual(authCalls, before, 'rejected quota admission must not call Auth');
      await contextOf(brokerSubjects.b, limited);
      demand(authCalls.verifySession > before.verifySession && authCalls.readAuthorization > before.readAuthorization, 'broker_quota_not_isolated');
      brokerEvidence.quotaIsolation = true;
    });
    await check('broker.restriction_and_connection_revocation_isolation', async () => {
      demand(brokerSubjects, 'broker_subjects_unavailable');
      const { a, b } = brokerSubjects;
      const narrowed = await connectionCall('restrictConnection', { connection: a.connection, restrictions: { read: [], action: [] }, scopeIds: [] });
      assert.equal(narrowed.connection.epoch, a.connection.epoch + 1);
      assert.deepEqual(await broker.listTools(a.token), { tools: [] });
      await assert.rejects(broker.callTool(a.token, 'crm_auth_context', {}), { code: 'tool_not_available', status: 403 });
      const revoked = await connectionCall('revokeConnection', { connectionId: a.connection.id, expectedEpoch: narrowed.connection.epoch });
      assert.deepEqual(revoked, { ok: true, status: 'revoked' });
      await assert.rejects(broker.callTool(a.token, 'crm_auth_context', {}), { code: 'unauthorized', status: 401 });
      const other = await contextOf(b);
      assert.equal(other.contextVersion, b.initialContext.contextVersion);
      const row = (await query('select state from app_private.hermes_sessions where id=$1', [a.credentialRef])).rows[0];
      demand(row?.state === 'ACTIVE', 'broker_revoke_deleted_session');
      brokerEvidence.restrictionAndRevocation = true;
    });
    await check('broker.post_audit_context_change_denied', async () => {
      const item = await issue(); let narrowed = false;
      const changing = createBroker({ authority, limits: { timeoutMs: 30_000 }, audit: async event => {
        if (event.outcome === 'prepared' && !narrowed) {
          await connectionCall('restrictConnection', { connection: item.connection, restrictions: { read: [], action: [] }, scopeIds: [] });
          narrowed = true;
        }
      } });
      await assert.rejects(changing.callTool(item.token, 'crm_auth_context', {}), { code: 'context_changed', status: 409 });
      demand(narrowed, 'broker_audit_mutation_not_observed');
      assert.deepEqual(await broker.listTools(item.token), { tools: [] });
      brokerEvidence.postAuditRecheck = true;
    });
    await check('activation.identical_retry_and_conflicting_payload', async () => {
      const item = await issue();
      demand((await connectionCall('activate', item.activationBundle)).status === 'already_activated', 'activation_retry_failed');
      await expectRejection(() => store('activate', { ...item.activation, tokenDigest: 'f'.repeat(64) }), ['store_conflict']);
      const rows = (await query('select count(*)::int count from app_private.hermes_sessions where id=$1', [item.credentialRef])).rows;
      demand(rows[0].count === 1, 'duplicate_session_created');
    });
    await check('constraints.cross_company_composite_fk_and_provider_session_owner', async () => {
      const a = await issue(), b = await issue(1, 1);
      await expectRejection(() => query(`update app_private.hermes_connections set credential_ref=$1 where id=$2`, [a.credentialRef, b.connection.id], { write: true }), ['23503']);
      await expectRejection(() => query(`update app_private.hermes_sessions set provider_session_id=$1 where id=$2`, [a.binding.sessionId, b.credentialRef], { write: true }), ['23505']);
      demand((await read(b)).status === 'active', 'failed_constraint_mutated_fixture');
    });
    await check('refresh.staged_hidden_and_idempotent_publication_receipt', async () => {
      const item = await issue(), { claim, payload } = await stage(item);
      demand((await read(item)).status === 'unavailable', 'staged_material_visible');
      demand((await store('stageRefresh', payload)).ok === true, 'identical_stage_retry_failed');
      demand((await store('stageRefresh', { ...payload, envelope: crypto.seal(item.material, item.binding) })).ok === false, 'different_stage_payload_accepted');
      const first = await store('publishRefresh', claim), retry = await store('publishRefresh', claim);
      assert.deepEqual(first, { ok: true, status: 'published', revision: claim.revision + 1, fence: claim.fence });
      assert.deepEqual(retry, { ...first, status: 'already_published' });
      const current = await read(item); demand(current.status === 'active', 'published_material_unavailable');
      assert.deepEqual(current.session.envelope, payload.envelope);
    });
    await check('refresh.expired_reserved_lease_advances_fence_and_rejects_old_claim', async () => {
      const item = await issue(), first = await acquire(item);
      await query("update app_private.hermes_sessions set lease_until=clock_timestamp()-interval '1 second' where id=$1", [item.credentialRef], { write: true });
      const second = await acquire(item); demand(second.fence > first.fence, 'fence_not_monotonic');
      await expectRejection(() => store('dispatchRefresh', first), ['store_conflict']);
      demand((await store('releaseRefresh', second)).ok === true, 'reserved_release_failed');
    });
    await check('refresh.expired_dispatched_lease_never_reuses_old_token', async () => {
      const item = await issue(), claim = await acquire(item);
      demand((await store('dispatchRefresh', claim)).ok, 'refresh_dispatch_failed');
      await query("update app_private.hermes_sessions set lease_until=clock_timestamp()-interval '1 second' where id=$1", [item.credentialRef], { write: true });
      const next = await store('acquireRefresh', { credentialRef: item.credentialRef, binding: item.binding, ownerId: randomUUID(), leaseMs: 30000 });
      demand(next.status === 'reconnect_required' && (await read(item)).status === 'unavailable', 'expired_dispatch_reused');
    });
    await check('revocation.connection_blocks_publication_without_deleting_session', async () => {
      const item = await issue(), { claim } = await stage(item);
      demand((await store('revokeConnection', { connectionId: item.connection.id, expectedEpoch: item.connection.epoch })).ok, 'connection_revoke_failed');
      demand((await store('publishRefresh', claim)).ok === false && (await read(item)).status === 'unavailable', 'revoked_connection_published');
      const row = (await query('select state from app_private.hermes_sessions where id=$1', [item.credentialRef])).rows[0];
      demand(row.state === 'STAGED', 'connection_revoke_changed_session_ownership');
    });
    await check('revocation.session_tombstone_invalidates_stale_publish', async () => {
      const item = await issue(), { claim } = await stage(item);
      demand((await store('revokeSession', { credentialRef: item.credentialRef })).ok, 'session_revoke_failed');
      await expectRejection(() => store('publishRefresh', claim), ['store_conflict']);
      const row = (await query('select state,envelope,staged_envelope,fence from app_private.hermes_sessions where id=$1', [item.credentialRef])).rows[0];
      demand(row.state === 'REVOKED' && row.envelope === null && row.staged_envelope === null && Number(row.fence) > claim.fence, 'session_tombstone_invalid');
    });
    // Five additive renewal cases. The existing 18 acceptance cases above and
    // cleanup remain separate; old receipts do not cover this new SQL surface.
    const renewalInput = item => prepareFixtureRenewal(authority, connectionStore, item.token, lease.signal);
    const boundary = async (item, mode) => {
      const { text, values } = fixtureRenewalBoundaryMutation(plan, item, mode);
      const result = (await query(text, values, { write: true })).rows[0];
      demand(result?.token_rows === 1 && (mode !== 'session_cap' || result.session_rows === 1)
        && Number.isSafeInteger(Number(result.expires)) && Number.isSafeInteger(Number(result.cap)), 'fixture_renewal_boundary_failed');
      return { expiresAt: Number(result.expires), cap: Number(result.cap) };
    };
    await check('renewal.server_clock_stable_opaque_and_bounded_ttl', async () => {
      const item = await issue(), input = await renewalInput(item);
      const bounds = async () => (await query(`select floor(extract(epoch FROM clock_timestamp())*1000)::bigint as now,
        floor(extract(epoch FROM s.expires_at)*1000)::bigint as session_cap,
        floor(extract(epoch FROM t.created_at+interval '30 days')*1000)::bigint as age_cap
        from app_private.hermes_connection_tokens t join app_private.hermes_connections c on c.id=t.connection_id
        join app_private.hermes_sessions s on s.id=c.credential_ref
        where t.token_digest=$1 and c.id=$2 and c.organization_id=$3 and c.user_id=$4`,
      [input.tokenDigest, input.connectionId, item.binding.organizationId, item.binding.userId])).rows[0];
      const before = await bounds(); demand(before, 'fixture_renewal_clock_missing');
      // A deliberately skewed host clock must not choose/refuse the lease. Real
      // Auth/CRM admission used the normal clock just before this private call.
      let skewClockCalls = 0;
      const skewedStore = createDurableConnectionStore({ transport: guardedTransport,
        clock: () => { skewClockCalls++; return Date.now() + 86_400_000; } });
      const renewed = await guardedConnectionCall(ctx, skewedStore, 'renewConnection', input);
      const after = await bounds(); demand(after && skewClockCalls === 0, 'renewal_depended_on_host_clock');
      const cap = Math.min(Number(before.session_cap), Number(before.age_cap));
      demand(renewed.expiresAt > input.expectedExpiresAt
        && renewed.expiresAt >= Math.min(Number(before.now) + input.requestedTtlMs, cap)
        && renewed.expiresAt <= Math.min(Number(after.now) + input.requestedTtlMs, cap), 'renewal_db_lease_out_of_bounds');
      const current = await connectionCall('readConnection', { tokenDigest: input.tokenDigest });
      demand(current?.connection.expiresAt === renewed.expiresAt && current.connection.id === input.connectionId
        && current.session.revision === input.expectedRevision, 'renewal_joined_ack_mismatch');
      await contextOf(item); // The same opaque is admitted again via actual Auth.
    });
    await check('renewal.stale_expiry_revision_epoch_and_invalid_ttl_denied', async () => {
      const item = await issue(), input = await renewalInput(item);
      for (const delta of [{ expectedExpiresAt: input.expectedExpiresAt + 1 }, { expectedRevision: input.expectedRevision + 1 },
        { expectedEpoch: input.expectedEpoch + 1 }]) {
        await expectRejection(() => connectionCall('renewConnection', { ...input, ...delta }), ['store_conflict']);
      }
      // Bypass only the input adapter, using the same restricted DB principal,
      // to prove SQL independently rejects malformed/oversized requested TTL.
      for (const requestedTtlMs of [0, 900001, null]) {
        await expectRejection(() => store('renewConnection', { ...input, requestedTtlMs }), ['store_rejected']);
      }
      const current = await connectionCall('readConnection', { tokenDigest: input.tokenDigest });
      demand(current?.connection.expiresAt === input.expectedExpiresAt, 'denied_renewal_changed_expiry'); await contextOf(item);
    });
    await check('renewal.session_cap_is_enforced_by_sql', async () => {
      const item = await issue(), input = await renewalInput(item), limited = await boundary(item, 'session_cap');
      const renewed = await connectionCall('renewConnection', { ...input, expectedExpiresAt: limited.expiresAt });
      demand(renewed.expiresAt === limited.cap, 'renewal_exceeded_session_cap');
      // This admin fixture deliberately shortens the DB session metadata only.
      // It is a SQL boundary probe, not a valid shortened provider JWT. Actual
      // authority must reject its mismatch with sealed/verified session expiry.
      await expectRejection(() => authority.resolve(item.token, { signal: lease.signal }), ['unauthorized']);
    });
    await check('renewal.hard_age_cap_and_expired_token_denied', async () => {
      const item = await issue(), initial = await renewalInput(item), limited = await boundary(item, 'hard_age_cap');
      const input = { ...initial, expectedExpiresAt: limited.expiresAt };
      const renewed = await connectionCall('renewConnection', input);
      demand(renewed.expiresAt === limited.cap, 'renewal_exceeded_hard_age'); await contextOf(item);
      const expired = await boundary(item, 'expired');
      await expectRejection(() => connectionCall('renewConnection', { ...input, expectedExpiresAt: expired.expiresAt }), ['store_conflict']);
      demand((await read(item)).status === 'unavailable', 'expired_opaque_readmitted');
    });
    await check('renewal.revocation_and_reserved_refresh_block_extension', async () => {
      const revoked = await issue(), beforeRevoke = await renewalInput(revoked);
      await connectionCall('revokeConnection', { connectionId: revoked.connection.id, expectedEpoch: revoked.connection.epoch });
      await expectRejection(() => connectionCall('renewConnection', beforeRevoke), ['store_conflict']);
      demand((await read(revoked)).status === 'unavailable', 'revoked_opaque_readmitted');
      const reserved = await issue(), beforeAcquire = await renewalInput(reserved), claim = await acquire(reserved);
      await expectRejection(() => connectionCall('renewConnection', beforeAcquire), ['store_conflict']);
      demand((await store('releaseRefresh', claim)).ok === true, 'renewal_probe_reserved_release_failed'); await contextOf(reserved);
    });
    // Five additive P3 cases follow the unchanged 18 baseline + 5 renewal
    // cases. This invokes the trusted service directly with real assistant JWTs;
    // transport/model exposure is a separate acceptance lane.
    await sqlWrite(roomReadFixtureSql(plan));
    const organizationScopes = (await query(`select id,organization_id from public.authorization_scopes
      where organization_id=any($1::uuid[]) and scope_type='ORGANIZATION'`, [plan.orgs.map(org => org.id)])).rows;
    demand(organizationScopes.length === 2 && plan.orgs.every(org => organizationScopes.filter(row => row.organization_id === org.id).length === 1),
      'fixture_room_scope_missing');
    const roomScopes = [[plan.roomRead.scopeId], [organizationScopes.find(row => row.organization_id === plan.orgs[1].id).id]];
    const policyVersions = [1, 1], roomCapabilities = ['assistant.context.read', 'rooms.view'];
    const setRoomPolicy = async (orgIndex, enabled) => {
      const changed = await rpc(ctx, plan.actors[orgIndex].session.accessToken, 'hermes_set_org_policy_v1', {
        p_org: plan.orgs[orgIndex].id, p_expected_version: policyVersions[orgIndex], p_enabled: enabled,
        p_read: roomCapabilities, p_action: [], p_scope_ids: roomScopes[orgIndex],
      }, true);
      demand(changed.status === 200 && changed.body.version === policyVersions[orgIndex] + 1, 'fixture_room_policy_failed');
      policyVersions[orgIndex] = changed.body.version;
    };
    await setRoomPolicy(0, true); await setRoomPolicy(1, true);
    const roomReads = createSupabaseRoomReads({ url: ctx.url, publishableKey: ctx.cred.testPublishableKey, fetch: trackedReads });
    const roomService = createRoomReadService({ authority, connectionStore, crypto, auth, reads: roomReads });
    const issueRooms = (actorIndex, orgIndex) => issue(actorIndex, orgIndex,
      { readCapabilities: roomCapabilities, scopeIds: roomScopes[orgIndex] });
    const roomOptions = { signal: lease.signal };
    let roomSubjects;
    const roomBinding = async item => {
      const admitted = await authority.resolve(item.token, roomOptions);
      const joined = await connectionCall('readConnection', { tokenDigest: item.activation.tokenDigest });
      demand(joined?.status === 'active' && joined.connection.id === admitted.row.id, 'fixture_room_binding_changed');
      await authority.checkUnchanged(item.token, admitted, roomOptions);
      return { accessToken: item.material.accessToken, organizationId: admitted.row.organizationId,
        scopeIds: admitted.assistantScopeIds, connectionId: admitted.row.id, tokenDigest: item.activation.tokenDigest,
        expectedEpoch: admitted.row.epoch, expectedPolicyVersion: joined.policy.version,
        expectedMembershipId: joined.membership.membershipId, expectedAuthorizationVersion: joined.membership.authorizationVersion,
        expectedSessionRevision: joined.session.revision };
    };
    await check('rooms.jwt_selected_company_and_assistant_area_projection', async () => {
      const a = await issueRooms(0, 0), b = await issueRooms(1, 1), sa = await issueRooms(2, 0), sb = await issueRooms(2, 1);
      roomSubjects = { a, b, sa, sb };
      demand(sa.binding.assistantId !== sb.binding.assistantId, 'fixture_room_superadmin_namespace_shared');
      const raw = await roomReads.availableRooms({ accessToken: a.material.accessToken, organizationId: plan.orgs[0].id }, roomOptions);
      assert.deepEqual(raw.rooms.map(row => row.id).sort(), [plan.orgs[0].roomId, plan.roomRead.roomId].sort());
      demand(JSON.stringify(raw).includes('PRIVATE_HERMES_FIXTURE'), 'fixture_room_private_negative_control_missing');
      // Both same-name buildings are visible to the real CRM user. Only the
      // current AREA edge is admitted to their assistant, including superadmin.
      assert.deepEqual(raw.buildings.map(row => row.name), ['Hermes synthetic building', 'Hermes synthetic building']);
      for (const item of [a, b, sa, sb]) {
        const org = plan.orgs[item.orgIndex];
        assertRoomProjection(await roomService.availableRooms(item.token, {}, roomOptions), [org.roomId], [org.buildingId]);
      }
      await expectRejection(() => roomReads.availableRooms({ accessToken: a.material.accessToken,
        organizationId: plan.orgs[1].id }, roomOptions), ['forbidden']);
    });
    await check('rooms.bound_rpc_rejects_actor_session_scope_and_version_spoofing', async () => {
      demand(roomSubjects, 'fixture_room_subjects_unavailable');
      const bound = await roomBinding(roomSubjects.a);
      const allowed = await roomReads.scopeMap(bound, roomOptions);
      assert.equal(allowed.organizationId, plan.orgs[0].id);
      assert.deepEqual(allowed.areaBuildings.map(edge => edge.buildingId), [plan.orgs[0].buildingId]);
      for (const delta of [{ accessToken: roomSubjects.b.material.accessToken },
        { accessToken: plan.actors[0].session.accessToken }, { organizationId: plan.orgs[1].id },
        { tokenDigest: 'f'.repeat(64) }]) {
        await expectRejection(() => roomReads.scopeMap({ ...bound, ...delta }, roomOptions), ['forbidden'], `spoof_${Object.keys(delta)[0].replace(/[A-Z]/g, c => '_' + c.toLowerCase())}`);
      }
      for (const delta of [{ expectedEpoch: bound.expectedEpoch + 1 }, { expectedPolicyVersion: bound.expectedPolicyVersion + 1 },
        { expectedAuthorizationVersion: bound.expectedAuthorizationVersion + 1 }, { expectedSessionRevision: bound.expectedSessionRevision + 1 },
        { expectedMembershipId: randomUUID() }, { scopeIds: roomScopes[1] }]) {
        await expectRejection(() => roomReads.scopeMap({ ...bound, ...delta }, roomOptions), ['context_changed'], `spoof_${Object.keys(delta)[0].replace(/[A-Z]/g, c => '_' + c.toLowerCase())}`);
      }
    });
    await check('rooms.area_commit_after_final_auth_invalidates_old_projection', async () => {
      demand(roomSubjects, 'fixture_room_subjects_unavailable');
      const item = roomSubjects.a;
      await expectRejection(() => runFixtureReadInterleaving({ signal: lease.signal, timeoutMs: 30000,
        read: async (barrier, signal) => {
          const pausedAuthority = { ...authority, async checkUnchanged(...args) {
            await authority.checkUnchanged(...args); await barrier();
          } };
          const paused = createRoomReadService({ authority: pausedAuthority, connectionStore, crypto, auth, reads: roomReads });
          return paused.availableRooms(item.token, {}, { signal });
        },
        mutate: async () => {
          const changed = await query(`update public.area_buildings set building_id=$1
            where area_id=$2 and organization_id=$3 and building_id=$4`,
          [plan.roomRead.buildingId, plan.roomRead.areaId, plan.orgs[0].id, plan.orgs[0].buildingId], { write: true });
          demand(changed.rowCount === 1, 'fixture_area_mutation_missing');
        },
      }), ['context_changed']);
      assertRoomProjection(await roomService.availableRooms(item.token, {}, roomOptions), [plan.roomRead.roomId], [plan.roomRead.buildingId]);
      assertRoomProjection(await roomService.availableRooms(roomSubjects.b.token, {}, roomOptions), [plan.orgs[1].roomId], [plan.orgs[1].buildingId]);
    });
    await check('rooms.policy_revoke_committed_before_final_map_denies_output', async () => {
      demand(roomSubjects, 'fixture_room_subjects_unavailable');
      let maps = 0;
      try {
        await expectRejection(() => runFixtureReadInterleaving({ signal: lease.signal, timeoutMs: 30000,
          read: async (barrier, signal) => {
            const pausedReads = { ...roomReads, async scopeMap(...args) {
              if (++maps === 2) await barrier();
              return roomReads.scopeMap(...args);
            } };
            const paused = createRoomReadService({ authority, connectionStore, crypto, auth, reads: pausedReads });
            return paused.availableRooms(roomSubjects.a.token, {}, { signal });
          }, mutate: () => setRoomPolicy(0, false),
        }), ['forbidden']);
        demand(maps === 2, 'fixture_final_map_barrier_missing');
        assertRoomProjection(await roomService.availableRooms(roomSubjects.b.token, {}, roomOptions), [plan.orgs[1].roomId], [plan.orgs[1].buildingId]);
      } finally {
        // Only our exact synthetic policy is restored, using its acknowledged
        // version. An unknown mutation keeps the lease marker via testFetch.
        if (policyVersions[0] > 2) await setRoomPolicy(0, true);
      }
      assertRoomProjection(await roomService.availableRooms(roomSubjects.a.token, {}, roomOptions), [plan.roomRead.roomId], [plan.roomRead.buildingId]);
    });
    await check('rooms.live_crm_permission_and_membership_revocation_denied', async () => {
      demand(roomSubjects, 'fixture_room_subjects_unavailable');
      const org = plan.orgs[0], membership = plan.memberships.find(member => member.actor === 0 && member.org === 0);
      const removed = await query(`delete from public.role_permissions where organization_id=$1 and role_id=$2 and permission_key='rooms.view'`,
        [org.id, org.roleId], { write: true });
      demand(removed.rowCount === 1, 'fixture_permission_mutation_missing');
      await expectRejection(() => roomService.availableRooms(roomSubjects.a.token, {}, roomOptions), ['forbidden'], 'crm_permission_revoked');
      const restored = await query(`insert into public.role_permissions(organization_id,role_id,permission_key,effect)
        values($1,$2,'rooms.view','ALLOW')`, [org.id, org.roleId], { write: true });
      demand(restored.rowCount === 1, 'fixture_permission_restore_missing');
      assertRoomProjection(await roomService.availableRooms(roomSubjects.a.token, {}, roomOptions), [plan.roomRead.roomId], [plan.roomRead.buildingId]);
      const revoked = await query(`update public.organization_memberships set revoked_at=clock_timestamp()
        where id=$1 and user_id=$2 and organization_id=$3 and status='ACTIVE' and revoked_at is null`,
      [membership.id, plan.actors[0].id, org.id], { write: true });
      demand(revoked.rowCount === 1, 'fixture_membership_mutation_missing');
      await expectRejection(() => roomService.availableRooms(roomSubjects.a.token, {}, roomOptions), ['forbidden', 'unauthorized'], 'crm_membership_revoked');
      assertRoomProjection(await roomService.availableRooms(roomSubjects.b.token, {}, roomOptions), [plan.orgs[1].roomId], [plan.orgs[1].buildingId]);
    });
  } catch (error) { cases.push({ name: 'fixture_or_schema_setup', status: 'FAIL', code: safeError(error) }); }
  finally {
    // A provider/broker timeout can leave an underlying lease wait or POST in
    // flight. Close admission and drain before ending the pool/deleting fixtures.
    for (const drain of [trackedControl?.drainWrites, trackedReads?.drain, guardedTransport?.drain].filter(Boolean)) {
      try { await drain(); }
      catch (error) { cases.push({ name: 'fixture.pending_work_settlement', status: 'FAIL', code: safeError(error) }); }
    }
    if (restricted) await restricted.end().catch(() => { ctx.writeState.uncertain = true; });
    if (cleanupRequired) {
      try {
        await withTestCleanup(lease, ctx.test, async cleanupLease => {
          const cleanupCtx = { ...ctx, signal: cleanupLease.signal };
          const rows = psqlJson(ctx.test, `select id,email from auth.users where email in (${plan.actors.map(actor => lit(actor.email)).join(',')})`);
          for (const actor of plan.actors) actor.id ??= rows.find(row => row.email === actor.email)?.id ?? null;
          // Retain child IDs before removing parents; a zero parent count alone
          // must not hide leftover opaque-token rows from cleanup evidence.
          const connections = psqlJson(ctx.test, `select id from app_private.hermes_connections where organization_id in (${ids(plan.orgs.map(org => org.id))})`);
          plan.connectionIds = [...new Set([...plan.connectionIds, ...connections.map(row => row.id)])];
          await sqlWrite(privateCleanupSql(plan), cleanupLease);
          await sqlWrite(baseFixtureCleanupSql(plan), cleanupLease);
          for (const actor of plan.actors.filter(actor => actor.id)) {
            await ctx.assertLease(cleanupLease, ctx.test);
            const response = await testFetch(cleanupCtx, `${ctx.url}/auth/v1/admin/users/${actor.id}`, { method: 'DELETE',
              headers: { apikey: ctx.cred.testSecretKey, Authorization: `Bearer ${ctx.cred.testSecretKey}` } }, { write: true });
            demand(response.status === 200 || response.status === 404, 'fixture_auth_cleanup_failed');
          }
          await query(roleCleanupSql(plan), [], { write: true, lease: cleanupLease });
          await admin.end(); adminClosed = true;
          const [counts] = psqlJson(ctx.test, countsSql(plan)); validateCleanupEvidence(counts, ctx.writeState);
          cleanupVerified = true;
        });
        cases.push({ name: 'fixture.cleanup_verified', status: 'PASS' });
      } catch (error) { cases.push({ name: 'fixture.cleanup_verified', status: 'FAIL', code: safeError(error) }); }
    }
    if (admin && !adminClosed) await admin.end().catch(() => { if (cleanupRequired) ctx.writeState.uncertain = true; }); crypto.destroy();
    const report = { version: 1, observedAt: new Date().toISOString(), environment: 'guarded-ihomecrm-test',
      sourceIdentity: { initialSha256: initialSources },
      fixture: { runId: plan.run, actors: 3, organizations: 2, copiedAccountsUsed: false,
        ...fixtureCleanupOutcome({ required: cleanupRequired, verified: cleanupVerified, uncertain: ctx.writeState.uncertain }) },
      backupEvidence: backup,
      tls: { rejectUnauthorized: true, caFingerprint256: tls ? CA_FINGERPRINT : null },
      fixtureScopeEvidence, rpcDiagnostics: ctx.rpcDiagnostics,
      evidence: { restrictedLogin: principalVerified, realJwt: authenticatedActors === 3, schemaAppliedByHarness: false,
        ephemeralRoleChanges: roleCreationConfirmed, ephemeralRoleChangesAttempted: cleanupRequired,
        durableBroker: brokerEvidence,
        renewal: { existingAcceptanceCases: 18, additionalCases: 5,
          passed: cases.filter(item => item.name.startsWith('renewal.') && item.status === 'PASS').length,
          failed: cases.filter(item => item.name.startsWith('renewal.') && item.status === 'FAIL').length },
        roomReads: { existingAcceptanceCases: 23, additionalCases: 5, interleaving: 'between_requests', internalStatementSnapshot: false,
          passed: cases.filter(item => item.name.startsWith('rooms.') && item.status === 'PASS').length,
          failed: cases.filter(item => item.name.startsWith('rooms.') && item.status === 'FAIL').length },
        providerRefresh: false, concurrentTransactions: false, productionWrites: false },
      limitations: ['Sequential SQL-store and in-process injected broker acceptance; no concurrent publish/revoke schedule proof.',
        'Baseline broker is context-only; five P3 cases invoke the trusted room service directly, with actual Auth/CRM reads.',
        'Quota proof is per-connection in-memory with a fixed test clock, not a distributed or durable quota proof.',
        'No MCP HTTP room dispatch or Zalo/model traffic in this lane; registered broker/server composition is tested separately.',
        'Control-plane proof uses fresh synthetic accounts without MFA; no challenge flow or token-delivery recovery proof.',
        'No provider refresh request: staged candidate material reuses a verified synthetic Auth session.',
        'Renewal adds five sequential cases; session/hard-age boundary probes deliberately mutate only synthetic fixture timestamps.',
        'Session-cap metadata probe is not a provider JWT refresh; verified authority rejects that deliberately inconsistent session.',
        'P3 AREA/policy writes commit between requests at JS barriers; this does not prove PostgreSQL statement-internal MVCC concurrency.',
        'No scheduler, process-crash recovery, durable pending journal or production rollout certification.'],
      cases };
    finalizeReceipt(report, reportPath);
  }
  demand((!cleanupRequired || cleanupVerified) && !ctx.writeState.uncertain, 'fixture_cleanup_not_verified');
  demand(!cases.some(item => item.status === 'FAIL'), 'durable_store_harness_failed');
  return { passed: cases.length, report: reportPath, cleanupVerified };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { const options = parseArguments(process.argv.slice(2)); runHarness(options).then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(safeError(error)); process.exitCode = 1; }); }
  catch (error) { console.error(safeError(error)); process.exitCode = 1; }
}
