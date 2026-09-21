#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
const file = 'supabase/migrations/20260920235823_shared_voucher_recipient_sparse_update.sql';
const body = fs.readFileSync(file, 'utf8').replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
const name = 'public.update_income_expense_recipient_v1(uuid,uuid,jsonb,jsonb)';
const db = new pg.Client({ connectionString: 'postgresql://postgres@127.0.0.1:55488/settlement_t7' });
await db.connect();
const rollback = async fn => { await db.query('BEGIN'); try { await fn(); } finally { await db.query('ROLLBACK'); } };
try {
  await rollback(async () => { await db.query(body); await db.query(body); });
  await rollback(async () => { await db.query(`ALTER FUNCTION ${name} SET search_path=public`); await assert.rejects(db.query(body), /definition or ACL drift/); });
  await rollback(async () => { await db.query(`GRANT EXECUTE ON FUNCTION ${name} TO anon`); await assert.rejects(db.query(body), /definition or ACL drift/); });
  await rollback(async () => { await db.query('GRANT ie_action_snapshot_reader TO anon'); await assert.rejects(db.query(body), /membership drift/); });
  const shape = (await db.query(`SELECT has_function_privilege('authenticated',$1,'EXECUTE') auth,has_function_privilege('anon',$1,'EXECUTE') anon,
    has_function_privilege('service_role',$1,'EXECUTE') service,provolatile,prosecdef FROM pg_proc WHERE oid=$1::regprocedure`, [name])).rows[0];
  assert.deepEqual(shape, { auth: true, anon: false, service: false, provolatile: 'v', prosecdef: true });
  const role = 't5_recipient_deployer_' + randomUUID().replaceAll('-', '');
  try {
    await db.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER CREATEROLE BYPASSRLS INHERIT`);
    await db.query(`GRANT postgres TO ${role}`);
    await rollback(async () => { await db.query(`DROP FUNCTION ${name}`); await db.query(`SET LOCAL SESSION AUTHORIZATION ${role}`); await db.query(body); await db.query(body); });
  } finally { await db.query(`DROP ROLE IF EXISTS ${role}`); }
  console.log('Recipient schema exact reapply, ACL/owner/hash/reader-membership drift and first nonsuperuser apply PASS');
} finally { await db.end(); }
