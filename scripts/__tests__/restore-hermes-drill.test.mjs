import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { HERMES_RESTORE_BEFORE, HERMES_RESTORE_SOURCES, assertHermesRestoreStops,
  buildHermesRestoreFixture, hermesRestoreWitnessSql } from '../lib/restore-hermes-prerequisites.mjs';

const sources = Object.fromEntries(Object.keys(HERMES_RESTORE_SOURCES).map(file =>
  [file, readFileSync(new URL(`../../supabase/migrations/${file}`, import.meta.url), 'utf8')]));
const expectations = JSON.parse(readFileSync(new URL('../../supabase/baseline/forward-lane-expectations.json', import.meta.url), 'utf8')).expectations;
const stopFiles = [...Object.keys(sources), '20260830163815_zalo_tu_dong_hoa_broadcast_va_auto_reply.sql'].sort();
const results = () => stopFiles.map(ten => ({ ten, ok: false, stderr: `ERROR: ${expectations[ten].thongDiep}` }));
const sql = buildHermesRestoreFixture(sources);

async function database(run) {
  const db = new PGlite();
  try {
    // A focused compile/privilege fixture. The complete baseline/lane replay is
    // separately measured with PostgreSQL; these tiny rowtypes are not that proof.
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA app_private;
      CREATE TABLE public.zalo_send_queue(id uuid); CREATE TABLE public.zalo_conversations(id uuid);
      CREATE TABLE public.zalo_automations(id uuid);
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated, anon, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated, anon, service_role;`);
    await run(db);
  } finally { await db.close(); }
}

test('restore uses immutable source bodies and ACLs after measured legacy stops', () => {
  assertHermesRestoreStops(results(), expectations);
  assert(stopFiles.every(file => file < HERMES_RESTORE_BEFORE));
  assert.equal(buildHermesRestoreFixture(Object.fromEntries(Object.entries(sources).map(([file, text]) =>
    [file, text.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n')]))), sql);
  assert.equal((sql.match(/CREATE TABLE/g) ?? []).length, 1);
  assert.equal((sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length, 1);
  assert.doesNotMatch(sql, /CREATE (?:OR REPLACE )?FUNCTION public\.zalo_authorized_org_ids|INSERT INTO|CREATE POLICY/);
  for (const file of Object.keys(sources)) {
    assert.throws(() => buildHermesRestoreFixture({ ...sources, [file]: sources[file] + '\n-- altered' }), /digest mismatch/);
    const missing = { ...sources }; delete missing[file];
    assert.throws(() => buildHermesRestoreFixture(missing), /digest mismatch/);
  }
});

test('missing, duplicated, unexpectedly successful or differently failing legacy stop is mandatory', () => {
  for (const file of stopFiles) {
    for (const mutation of [
      rows => rows.filter(row => row.ten !== file),
      rows => [...rows, rows.find(row => row.ten === file)],
      rows => rows.map(row => row.ten === file ? { ...row, ok: true } : row),
      rows => rows.map(row => row.ten === file ? { ...row, stderr: 'ERROR: another schema failure' } : row),
    ]) assert.throws(() => assertHermesRestoreStops(mutation(results()), expectations), /stop mismatch/);
    const changed = structuredClone(expectations); changed[file].thongDiep = 'another error';
    assert.throws(() => assertHermesRestoreStops(results(), changed), /stop mismatch/);
  }
});

test('canonical fixture compiles, has exact security metadata, and denies an absent lease', { timeout: 30_000 }, async () => database(async db => {
  await db.exec(sql);
  const { rows } = await db.query(`SELECT public.zalo_worker_begin_provider_v1(NULL,NULL) allowed,
    (SELECT count(*) FROM public.zalo_worker_lease)::int leases,
    to_regclass('public.zalo_automation_runs') automation,
    to_regprocedure('public.zalo_authorized_org_ids(text)') helper`);
  assert.deepEqual(rows, [{ allowed: false, leases: 0, automation: null, helper: null }]);
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`SET ROLE ${role}`);
    await assert.rejects(db.query('SELECT public.zalo_worker_begin_provider_v1(NULL,NULL)'), /permission denied/);
    await assert.rejects(db.query('SELECT * FROM public.zalo_worker_lease'), /permission denied/);
    await db.exec('RESET ROLE');
  }
  await assert.rejects(db.exec(sql), /before catalog drift/);
  await db.exec('ROLLBACK');
}));

test('catalog witnesses detect body, ACL, owner, volatility, search path, RLS and row drift', { timeout: 30_000 }, async () => database(async db => {
  await db.exec(sql);
  const mutants = [
    `DO $mutation$ DECLARE definition text; BEGIN
      SELECT pg_get_functiondef('public.zalo_worker_begin_provider_v1(uuid,uuid)'::regprocedure) INTO definition;
      EXECUTE replace(definition,'RETURN true;','RETURN false;'); END $mutation$`,
    'GRANT EXECUTE ON FUNCTION public.zalo_worker_begin_provider_v1(uuid,uuid) TO anon',
    'ALTER FUNCTION public.zalo_worker_begin_provider_v1(uuid,uuid) OWNER TO authenticated',
    'ALTER FUNCTION public.zalo_worker_begin_provider_v1(uuid,uuid) STABLE',
    'ALTER FUNCTION public.zalo_worker_begin_provider_v1(uuid,uuid) SECURITY INVOKER',
    'ALTER FUNCTION public.zalo_worker_begin_provider_v1(uuid,uuid) SET search_path=public',
    'ALTER TABLE public.zalo_worker_lease DISABLE ROW LEVEL SECURITY',
    'GRANT SELECT ON public.zalo_worker_lease TO authenticated',
    'CREATE POLICY unexpected ON public.zalo_worker_lease USING (true)',
    'ALTER TABLE public.zalo_worker_lease ALTER COLUMN instance_id DROP NOT NULL',
    'ALTER TABLE public.zalo_worker_lease DROP CONSTRAINT zalo_worker_lease_id_check',
    'ALTER TABLE public.zalo_send_queue ALTER COLUMN result SET NOT NULL',
    "ALTER TABLE public.zalo_send_queue ALTER COLUMN result SET DEFAULT '{}'::jsonb",
    "INSERT INTO public.zalo_worker_lease(instance_id) VALUES ('00000000-0000-0000-0000-000000000001')",
  ];
  for (const mutant of mutants) {
    await db.exec(`BEGIN; ${mutant};`);
    await assert.rejects(db.exec(hermesRestoreWitnessSql()), /witness drift/, mutant);
    await db.exec('ROLLBACK');
  }
  await db.exec(hermesRestoreWitnessSql());
}));
