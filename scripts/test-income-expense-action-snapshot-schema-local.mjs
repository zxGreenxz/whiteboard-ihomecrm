#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
const path = 'supabase/migrations/20260920192452_shared_income_expense_action_snapshot.sql';
const migration = fs.readFileSync(path, 'utf8');
const body = migration.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
const db = new pg.Client({ connectionString: 'postgresql://postgres@127.0.0.1:55488/postgres' });
await db.connect();
async function rollback(fn) { await db.query('BEGIN'); try { await fn(); } finally { await db.query('ROLLBACK'); } }
try {
  if (process.argv.includes('--apply')) { await db.query(migration); console.log('Applied disposable T4A migration'); }
  await rollback(async () => { await db.query(body); await db.query(body); });
  for (const name of ['public.read_income_expense_action_snapshots_v1(uuid,uuid[])', 'app_private.income_expense_action_scope_v1(uuid)', 'public.list_cashbooks_for_expense_v2()']) {
    await rollback(async () => {
      await db.query(`ALTER FUNCTION ${name} SET search_path = public`);
      await assert.rejects(db.query(body), /definition drift/, `${name} drift must not be overwritten`);
    });
  }
  await rollback(async () => {
    await db.query('GRANT SELECT ON app_private.income_expense_flow_ownership TO ie_action_snapshot_reader');
    await assert.rejects(db.query(body), /privilege drift/);
  });
  await rollback(async () => {
    await db.query('ALTER ROLE ie_action_snapshot_reader BYPASSRLS');
    await assert.rejects(db.query(body), /role attribute drift/);
  });
  const acl = (await db.query(`SELECT
    has_function_privilege('authenticated','public.read_income_expense_action_snapshots_v1(uuid,uuid[])','EXECUTE') AS authenticated,
    has_function_privilege('anon','public.read_income_expense_action_snapshots_v1(uuid,uuid[])','EXECUTE') AS anon,
    has_function_privilege('service_role','public.read_income_expense_action_snapshots_v1(uuid,uuid[])','EXECUTE') AS service,
    has_function_privilege('authenticated','app_private.income_expense_action_scope_v1(uuid)','EXECUTE') AS helper,
    has_table_privilege('authenticated','app_private.income_expense_flow_ownership','SELECT') AS private_read,
    has_table_privilege('ie_action_snapshot_reader','app_private.income_expense_flow_ownership','INSERT,UPDATE,DELETE') AS private_write,
    has_schema_privilege('ie_action_snapshot_reader','public','CREATE') AS schema_create,
    pg_has_role('authenticated','ie_action_snapshot_reader','SET') AS client_set,
    pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid='public.read_income_expense_action_snapshots_v1(uuid,uuid[])'::regprocedure)) AS owner`)).rows[0];
  assert.deepEqual(acl, { authenticated: true, anon: false, service: false, helper: false, private_read: false, private_write: false, schema_create: false, client_set: false, owner: 'ie_action_snapshot_reader' });
  // Reuse the repository gate's SQL literal, without running its credential/network wrapper.
  const gate = fs.readFileSync('scripts/check-stable-fn-locks.mjs', 'utf8');
  const literal = gate.match(/const sql = (`[\s\S]*?`);/)[1];
  const locks = await db.query(vm.runInNewContext(literal));
  assert.equal(locks.rows.filter(row => ['read_income_expense_action_snapshots_v1', 'list_cashbooks_for_expense_v2'].includes(row.fn_name)).length, 0);
  console.log('PASS reapply, definition/role/ACL drift, least privilege and existing transitive STABLE-lock gate for T4A');

  // Simulate the verified shared deployment role: NOT SUPERUSER, CREATEROLE,
  // BYPASSRLS, authenticated ADMIN option and ownership privileges via postgres.
  // Names are isolated and every schema/role change rolls back before cleanup.
  const deploy = 't4a_deployer_' + randomUUID().replaceAll('-', '');
  try {
    await db.query(`CREATE ROLE ${deploy} NOLOGIN NOSUPERUSER CREATEROLE NOCREATEDB BYPASSRLS INHERIT`);
    await db.query(`GRANT postgres TO ${deploy}`);
    await db.query(`GRANT authenticated TO ${deploy} WITH ADMIN TRUE`);
    await rollback(async () => {
      await db.query(`SET LOCAL SESSION AUTHORIZATION ${deploy}`);
      let isolated = body.replaceAll('ie_action_snapshot_reader', 't4a_test_reader')
        .replaceAll('read_income_expense_action_snapshots_v1', 't4a_test_snapshots')
        .replaceAll('income_expense_action_scope_v1', 't4a_test_scope')
        .replaceAll("'postgres'::regrole", `'${deploy}'::regrole`).replaceAll('TO postgres WITH', `TO ${deploy} WITH`);
      await db.query(isolated);
      // The same definitions have different identifiers in this isolated rehearsal.
      for (const [name, originalHash] of [['public.t4a_test_snapshots(uuid,uuid[])', '6e1e6dbcad5f54f4a5690640d70094ca'], ['app_private.t4a_test_scope(uuid)', '38d6b30b15990db2c3ab043eb2161865']]) {
        const hash = (await db.query('SELECT md5(pg_get_functiondef($1::regprocedure)) hash', [name])).rows[0].hash;
        isolated = isolated.replaceAll(originalHash, hash);
      }
      await db.query(isolated);
    });
  } finally { await db.query(`DROP ROLE IF EXISTS ${deploy}`); }
  console.log('PASS initial apply + reapply under non-superuser deployment role; rehearsal rolled back');
} finally { await db.end(); }
