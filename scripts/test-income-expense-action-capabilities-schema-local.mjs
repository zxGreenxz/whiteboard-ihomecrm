#!/usr/bin/env node
// Disposable loopback schema rehearsal. Every drift/non-superuser case rolls back.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
const db = new pg.Client({ connectionString: 'postgresql://postgres@127.0.0.1:55488/postgres' });
const migration = fs.readFileSync('supabase/migrations/20260920200252_shared_income_expense_action_capabilities.sql', 'utf8');
const body = migration.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
const snapshot = 'public.read_income_expense_action_snapshots_v1(uuid,uuid[])';
const capability = 'app_private.income_expense_action_capabilities_v1(uuid,uuid)';
async function rollback(fn) { await db.query('BEGIN'); try { await fn(); } finally { await db.query('ROLLBACK'); } }
await db.connect();
try {
  if (process.argv.includes('--apply')) await db.query(migration);
  await rollback(async () => { await db.query(body); await db.query(body); });
  for (const name of [snapshot, capability, 'app_private.assert_manual_voucher_v1(uuid,text)']) {
    await rollback(async () => { await db.query(`ALTER FUNCTION ${name} SET search_path=public`); await assert.rejects(db.query(body), /definition drift/i); });
  }
  await rollback(async () => { await db.query(`GRANT EXECUTE ON FUNCTION ${capability} TO authenticated`); await assert.rejects(db.query(body), /Capability ACL drift/); });
  await rollback(async () => { await db.query(`ALTER FUNCTION ${capability} OWNER TO ie_action_snapshot_reader`); await assert.rejects(db.query(body), /Capability owner drift/); });
  await rollback(async () => { await db.query('ALTER ROLE ie_action_snapshot_reader BYPASSRLS'); await assert.rejects(db.query(body), /Reader role drift/); });
  await rollback(async () => { await db.query(`GRANT EXECUTE ON FUNCTION ${snapshot} TO anon`); await assert.rejects(db.query(body), /Snapshot ACL drift/); });
  const acl = (await db.query(`SELECT has_function_privilege('authenticated',$1,'EXECUTE') snapshot,
    has_function_privilege('authenticated',$2,'EXECUTE') helper,has_function_privilege('anon',$2,'EXECUTE') anon,
    has_function_privilege('service_role',$2,'EXECUTE') service,has_function_privilege('ie_action_snapshot_reader',$2,'EXECUTE') reader,
    has_table_privilege('authenticated','app_private.income_expense_flow_ownership','SELECT') private_read,
    pg_has_role('authenticated','ie_action_snapshot_reader','SET') client_set,
    pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid=$1::regprocedure)) snapshot_owner,
    pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid=$2::regprocedure)) helper_owner`, [snapshot, capability])).rows[0];
  assert.deepEqual(acl, { snapshot: true, helper: false, anon: false, service: false, reader: true, private_read: false, client_set: false, snapshot_owner: 'ie_action_snapshot_reader', helper_owner: 'postgres' });
  const literal = fs.readFileSync('scripts/check-stable-fn-locks.mjs','utf8').match(/const sql = (`[\s\S]*?`);/)[1];
  assert.equal((await db.query(vm.runInNewContext(literal))).rows.filter(r => ['read_income_expense_action_snapshots_v1','income_expense_action_capabilities_v1'].includes(r.fn_name)).length, 0);
  console.log('PASS T4B reapply, definition/owner/ACL/role drift, private capability ACL and transitive STABLE gate');
  const deploy = 't4b_deployer_' + randomUUID().replaceAll('-', '');
  try {
    await db.query(`CREATE ROLE ${deploy} NOLOGIN NOSUPERUSER CREATEROLE NOCREATEDB BYPASSRLS INHERIT`);
    await db.query(`GRANT postgres TO ${deploy}`);
    await db.query(`GRANT authenticated TO ${deploy} WITH ADMIN TRUE`);
    await rollback(async () => {
      // Restore only the prior public function definition, then exercise first B apply.
      const previous = fs.readFileSync('supabase/migrations/20260920192452_shared_income_expense_action_snapshot.sql','utf8');
      const aDefinition = previous.match(/CREATE OR REPLACE FUNCTION public\.read_income_expense_action_snapshots_v1[\s\S]*?\$fn\$;/)[0];
      await db.query(aDefinition);
      await db.query(`DROP FUNCTION ${capability}`);
      await db.query(`SET LOCAL SESSION AUTHORIZATION ${deploy}`);
      await db.query(body); await db.query(body);
      assert.equal((await db.query('SELECT pg_get_userbyid(proowner) owner FROM pg_proc WHERE oid=$1::regprocedure',[capability])).rows[0].owner,'postgres');
    });
  } finally { await db.query(`DROP ROLE IF EXISTS ${deploy}`); }
  console.log('PASS T4B first apply + reapply under non-superuser deployment role, no role/table grant expansion; rolled back');
} finally { await db.end(); }
