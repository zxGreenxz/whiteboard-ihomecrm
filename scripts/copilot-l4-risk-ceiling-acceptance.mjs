import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const root = fileURLToPath(new URL('../', import.meta.url));
const org = 'dddd0000-0000-4000-8000-000000000001';
const actor = 'dddd2000-0000-4000-8000-000000000005';
const input = { organizationId: org, clientRequestId: 'isolated-ca2-risk-ceiling', steps: [
  { hanh_dong: 'income_expense.duyet', du_lieu: { income_expense_id: '00000000-0000-4000-8000-000000000000' } },
] };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const read = path => readFileSync(resolve(root, path), 'utf8');

// Return every byte from CREATE through the closing dollar quote and semicolon.
// Nothing in the acceptance path rewrites the function under test or its helpers.
function extract(source, name) {
  const start = source.search(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION\\s+${name.replaceAll('.', '\\.')}\\s*\\(`, 'i'));
  assert.notEqual(start, -1, `missing source definition: ${name}`);
  const tail = source.slice(start);
  const quote = tail.match(/\bAS\s+(\$[A-Za-z0-9_]*\$)/i);
  assert.ok(quote, `missing function body: ${name}`);
  const close = tail.indexOf(quote[1], quote.index + quote[0].length);
  assert.notEqual(close, -1, `unterminated function: ${name}`);
  const end = tail.indexOf(';', close + quote[1].length);
  assert.notEqual(end, -1, `missing terminator: ${name}`);
  return tail.slice(0, end + 1);
}

function bodySha256(sql) {
  const quote = sql.match(/\bAS\s+(\$[A-Za-z0-9_]*\$)/i);
  const start = quote.index + quote[0].length;
  return sha256(sql.slice(start, sql.indexOf(quote[1], start)).replaceAll('\r\n', '\n'));
}

const specifications = [
  ['supabase/migrations/20260905091725_copilot_plan_create_grant_lock_fix_v1.sql', 'public.copilot_plan_create_v1', 'uuid,text,jsonb'],
  ['supabase/baseline/schema.sql', 'public.is_super_admin', ''],
  ['supabase/migrations/20260903043956_copilot_action_registry_policy_ledger_v1.sql', 'app_private.copilot_plan_role_allowed_v1', 'uuid'],
  ['supabase/migrations/20260903100253_copilot_execution_plan_v1.sql', 'app_private.copilot_action_flag_allows_v1', 'text,uuid'],
  ['supabase/migrations/20260903100253_copilot_execution_plan_v1.sql', 'app_private.copilot_plan_registry_revision_v1', ''],
];

// Explicit reduced rowtypes: enough for DECLARE compilation and pre-risk queries.
// No downstream functions are installed, and none synthesizes the expected error.
const bootstrap = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE function_owner;
CREATE SCHEMA auth; CREATE SCHEMA app_private; CREATE SCHEMA extensions;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
CREATE TABLE public.super_admins(user_id uuid PRIMARY KEY);
CREATE TABLE public.organizations(id uuid PRIMARY KEY, status text);
CREATE TABLE public.copilot_feature_flags(scope text, contract_id text, state text, canary_org uuid, expires_at timestamptz);
CREATE TABLE app_private.copilot_action_policy(id boolean PRIMARY KEY, max_direct_risk text, revision bigint, allowed_roles text[]);
CREATE TABLE app_private.copilot_action_registry(
 action_id text PRIMARY KEY, version integer, label_vi text, permission_key text, risk text,
 executor_kind text, consent_required text, preview_rpc text, execute_rpc text, verify_kind text,
 produces_entity_table text, consumes_ref_table text, rollback_rpc text, rollback_note text,
 flag_contract_id text, enabled boolean, grantable boolean
);
CREATE TABLE app_private.copilot_plans(id uuid, user_id uuid, organization_id uuid, client_request_id text,
 status text, expires_at timestamptz, execute_deadline timestamptz);
CREATE TABLE public.income_expenses(id uuid);
CREATE TABLE app_private.copilot_standing_grants(id uuid);
CREATE TABLE app_private.copilot_plan_steps(id uuid);
CREATE TABLE app_private.copilot_write_confirmations(id uuid);
CREATE TABLE app_private.copilot_action_ledger(id uuid);
CREATE TABLE public.income_expense_items(id uuid);
CREATE TABLE public.ai_write_audit(id uuid);
INSERT INTO public.super_admins VALUES ('${actor}');
INSERT INTO public.organizations VALUES ('${org}', 'ACTIVE');
INSERT INTO app_private.copilot_action_policy VALUES (true, 'L4', 1, ARRAY['superadmin']);
INSERT INTO public.copilot_feature_flags VALUES ('action', 'copilot.execution_plan', 'enabled', '${org}', NULL);
GRANT USAGE ON SCHEMA auth, app_private, public, extensions TO function_owner;
GRANT SELECT ON ALL TABLES IN SCHEMA public, app_private TO function_owner;
GRANT USAGE ON SCHEMA auth, public TO authenticated;
REVOKE ALL ON FUNCTION auth.uid() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO function_owner, authenticated;
`;
const countTables = {
  plans: 'app_private.copilot_plans', steps: 'app_private.copilot_plan_steps',
  confirmations: 'app_private.copilot_write_confirmations', ledger: 'app_private.copilot_action_ledger',
  vouchers: 'public.income_expenses', items: 'public.income_expense_items', audits: 'public.ai_write_audit',
};
async function counts(db) {
  return (await db.query('SELECT ' + Object.entries(countTables).map(
    ([key, table]) => `(SELECT count(*)::integer FROM ${table}) AS ${key}`,
  ).join(', '))).rows[0];
}

export function assertRiskRejection(receipt) {
  assert.equal(receipt.error?.code, '42501', 'risk ceiling must raise SQLSTATE 42501');
  assert.equal(receipt.error.message, 'plan_risk_not_allowed: income_expense.duyet la L5 nhung tran hien tai la L4');
  assert.deepEqual(receipt.before, Object.fromEntries(Object.keys(countTables).map(key => [key, 0])));
  assert.deepEqual(receipt.after, receipt.before, 'risk rejection must leave all observed tables unchanged');
  assert.equal(receipt.cleanup.closed, true);
}

export async function runL4RiskCeilingAcceptance({ disableRiskPredicate = false } = {}) {
  const definitions = specifications.map(([path, name, args]) => ({ path, name, args, sql: extract(read(path), name) }));
  let createSql = definitions[0].sql;
  if (disableRiskPredicate) {
    const predicate = "IF v_reg.executor_kind <> 'maker_submit_v1'";
    assert.equal(createSql.split(predicate).length, 2, 'mutation must have exactly one anchor');
    createSql = createSql.replace(predicate, `IF false AND v_reg.executor_kind <> 'maker_submit_v1'`);
    assert.notEqual(sha256(createSql), sha256(definitions[0].sql));
  }
  const seedPath = 'supabase/migrations/20260903190255_copilot_action_ie_duyet_v1.sql';
  const seed = read(seedPath).match(/INSERT INTO app_private\.copilot_action_registry\s*\([\s\S]*?ON CONFLICT \(action_id\) DO NOTHING;/)?.[0];
  assert.ok(seed?.includes("'income_expense.duyet'"), 'exact registry seed missing');
  const receipt = {
    measuredAt: new Date().toISOString(),
    scope: 'isolated-source-sql-risk-ceiling', liveHttpVerified: false, fullPlanAccepted: false,
    deploymentEquality: 'unverified', mutation: disableRiskPredicate, input,
    sources: {
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      functions: definitions.map(({ path, name, sql }) => ({ path, name, sha256: sha256(sql), bodySha256: bodySha256(sql), bodyNormalization: 'CRLF to LF only', bytes: Buffer.byteLength(sql) })),
      executedCreateSha256: sha256(createSql), registrySeed: { path: seedPath, sha256: sha256(seed) },
      fixtureSha256: sha256(bootstrap),
    },
    caveats: [
      'PGlite in-memory PostgreSQL; no HTTP/PostgREST, browser, real Supabase JWT verification, or deployed catalog parity.',
      'Synthetic superadmin actor, fixture auth.uid claim adapter, DEMO organization and isolated L4 singleton.',
      'Explicit reduced fixture tables omit production constraints, triggers, RLS and downstream rowtype fields; receipt proves only the pre-risk path.',
      'No downstream function installed. Mutation must reach undefined copilot_action_gate_v1 (42883), not a mocked risk rejection.',
      'Zero counts cover only the listed fixture tables; no production/business execution is claimed.',
      'Dedicated function owner has SELECT only on fixture tables. This is a negative-path test, not proof of successful write privileges.',
    ],
    cleanup: { storage: 'memory', closed: false },
  };
  const db = new PGlite();
  try {
    await db.exec(bootstrap);
    await db.exec(seed);
    for (const definition of [...definitions.slice(1), { ...definitions[0], sql: createSql }]) {
      await db.exec(definition.sql);
      const signature = `${definition.name}(${definition.args})`;
      await db.exec(`ALTER FUNCTION ${signature} OWNER TO function_owner;
        REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated, service_role;`);
      const installed = (await db.query(`SELECT prosrc, prosecdef, proconfig
        FROM pg_proc WHERE oid = $1::regprocedure`, [signature])).rows[0];
      assert.equal(sha256(installed.prosrc.replaceAll('\r\n', '\n')), bodySha256(definition.sql), 'installed body must equal extracted source');
      const evidence = receipt.sources.functions.find(item => item.name === definition.name);
      evidence.installedBodySha256 = sha256(installed.prosrc.replaceAll('\r\n', '\n'));
      evidence.securityDefiner = installed.prosecdef;
      evidence.config = installed.proconfig;
    }
    await db.exec('GRANT EXECUTE ON FUNCTION public.copilot_plan_create_v1(uuid,text,jsonb) TO authenticated;');
    receipt.engine = { kind: 'PGlite', version: (await db.query('SELECT version() AS version')).rows[0].version };
    receipt.functionSecurity = (await db.query(`SELECT pg_get_userbyid(proowner) AS owner, prosecdef, proconfig,
      has_function_privilege('authenticated', oid, 'EXECUTE') AS authenticated_execute,
      has_function_privilege('anon', oid, 'EXECUTE') AS anon_execute,
      has_function_privilege('service_role', oid, 'EXECUTE') AS service_role_execute
      FROM pg_proc WHERE oid = 'public.copilot_plan_create_v1(uuid,text,jsonb)'::regprocedure`)).rows[0];
    assert.equal(receipt.functionSecurity.owner, 'function_owner');
    assert.equal(receipt.functionSecurity.prosecdef, true);
    assert.equal(receipt.functionSecurity.authenticated_execute, true);
    assert.equal(receipt.functionSecurity.anon_execute, false);
    assert.equal(receipt.functionSecurity.service_role_execute, false);
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [actor]);
    // Pre-read as owner since private helpers are intentionally not callable by authenticated.
    await db.exec('SET ROLE function_owner');
    receipt.prerequisites = (await db.query(`SELECT auth.uid() AS actor,
      app_private.copilot_plan_role_allowed_v1($1::uuid) AS role_allowed,
      app_private.copilot_action_flag_allows_v1('copilot.execution_plan', $1::uuid) AS flag_allowed,
      app_private.copilot_plan_registry_revision_v1() AS registry_revision,
      (SELECT status FROM public.organizations WHERE id=$1::uuid) AS organization_status,
      (SELECT max_direct_risk FROM app_private.copilot_action_policy WHERE id) AS max_direct_risk,
      (SELECT revision::integer FROM app_private.copilot_action_policy WHERE id) AS policy_revision,
      (SELECT risk FROM app_private.copilot_action_registry WHERE action_id='income_expense.duyet') AS action_risk`, [org])).rows[0];
    assert.equal(receipt.prerequisites.actor, actor);
    assert.equal(receipt.prerequisites.role_allowed, true);
    assert.equal(receipt.prerequisites.flag_allowed, true);
    assert.equal(receipt.prerequisites.organization_status, 'ACTIVE');
    assert.equal(receipt.prerequisites.max_direct_risk, 'L4');
    assert.equal(receipt.prerequisites.action_risk, 'L5');
    receipt.before = await counts(db);
    await db.exec('RESET ROLE; BEGIN; SET LOCAL ROLE authenticated');
    receipt.caller = (await db.query('SELECT current_user, auth.uid() AS actor')).rows[0];
    assert.deepEqual(receipt.caller, { current_user: 'authenticated', actor });
    try {
      await db.query('SELECT public.copilot_plan_create_v1($1::uuid,$2,$3::jsonb)', [org, input.clientRequestId, JSON.stringify(input.steps)]);
      receipt.error = null;
    } catch (error) {
      receipt.error = { code: error.code, message: error.message };
    } finally {
      await db.exec('ROLLBACK');
    }
    receipt.after = await counts(db);
  } finally {
    await db.close();
    receipt.cleanup.closed = db.closed;
  }
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (!(args.length === 1 && args[0] === '--pglite') &&
      !(args.length === 3 && args[0] === '--pglite' && args[1] === '--output')) {
    throw new Error('Usage: node scripts/copilot-l4-risk-ceiling-acceptance.mjs --pglite [--output path]');
  }
  const receipt = await runL4RiskCeilingAcceptance();
  assertRiskRejection(receipt);
  const json = JSON.stringify(receipt, null, 2) + '\n';
  if (args[2]) writeFileSync(resolve(args[2]), json, { flag: 'wx' });
  process.stdout.write(json);
}
