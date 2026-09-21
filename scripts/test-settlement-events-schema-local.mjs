#!/usr/bin/env node
// Disposable copy only. All DDL experiments roll back, including deploy-role rehearsal.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
const db=new pg.Client({connectionString:'postgresql://postgres@127.0.0.1:55488/settlement_t7'});
const sql=fs.readFileSync('supabase/migrations/20260920202321_contract_settlement_event_reader.sql','utf8').replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,'');
const reader='public.read_contract_settlement_events_v1(uuid,uuid[],text,text,integer)';
const helper='app_private.settlement_event_expense_ids_v1(uuid,uuid,uuid[],uuid)';
async function rollback(fn){await db.query('BEGIN');try {await fn();}finally {await db.query('ROLLBACK');}}
await db.connect();
try {
 await rollback(async()=>{await db.query(sql);await db.query(sql);});
 for(const name of [reader,helper])await rollback(async()=>{await db.query(`ALTER FUNCTION ${name} SET search_path=public`);await assert.rejects(db.query(sql),/definition drift/);});
 await rollback(async()=>{await db.query(`GRANT EXECUTE ON FUNCTION ${helper} TO authenticated`);await assert.rejects(db.query(sql),/ACL\/owner drift/);});
 await rollback(async()=>{await db.query(`GRANT EXECUTE ON FUNCTION ${reader} TO service_role`);await assert.rejects(db.query(sql),/ACL\/owner drift/);});
 await rollback(async()=>{await db.query('GRANT ie_action_snapshot_reader TO anon');await assert.rejects(db.query(sql),/membership drift/);});
 await rollback(async()=>{await db.query('ALTER ROLE ie_action_snapshot_reader BYPASSRLS');await assert.rejects(db.query(sql),/role prerequisite\/drift/);});
 const privileges=(await db.query(`SELECT has_function_privilege('authenticated',$1,'EXECUTE') auth,has_function_privilege('anon',$1,'EXECUTE') anon,
  has_function_privilege('authenticated',$2,'EXECUTE') helper,has_schema_privilege('ie_action_snapshot_reader','public','CREATE') ddl,
  pg_has_role('authenticated','ie_action_snapshot_reader','SET') role_set`,[reader,helper])).rows[0];
 assert.deepEqual(privileges,{auth:true,anon:false,helper:false,ddl:false,role_set:false});
 const row=(await db.query('SELECT pg_get_userbyid(proowner) owner,provolatile,prosecdef,proconfig FROM pg_proc WHERE oid=$1::regprocedure',[reader])).rows[0];
 assert.deepEqual(row,{owner:'ie_action_snapshot_reader',provolatile:'s',prosecdef:true,proconfig:['search_path=pg_catalog, public, app_private','row_security=on']});
 const gate=fs.readFileSync('scripts/check-stable-fn-locks.mjs','utf8');const literal=gate.match(/const sql = (`[\s\S]*?`);/)[1];
 assert.equal((await db.query(vm.runInNewContext(literal))).rows.filter(r=>r.fn_name==='read_contract_settlement_events_v1').length,0);
 const deploy='t7b_deployer_'+randomUUID().replaceAll('-','');
 try {
  await db.query(`CREATE ROLE ${deploy} NOLOGIN NOSUPERUSER CREATEROLE BYPASSRLS INHERIT`);await db.query(`GRANT postgres TO ${deploy}`);
  await rollback(async()=>{await db.query(`DROP FUNCTION ${reader}`);await db.query(`DROP FUNCTION ${helper}`);
   await db.query(`SET LOCAL SESSION AUTHORIZATION ${deploy}`);await db.query(sql);await db.query(sql);});
 }finally {await db.query(`DROP ROLE IF EXISTS ${deploy}`);}
 console.log('T7B schema: reapply, exact definition/ACL/role drift, no client helper or role SET, STABLE graph, non-superuser first/reapply PASS');
}finally {await db.end();}
