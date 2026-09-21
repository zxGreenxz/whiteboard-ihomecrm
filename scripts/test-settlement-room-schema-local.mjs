#!/usr/bin/env node
// Only the disposable T7 copy. Schema rehearsals always roll back.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
const migration = fs.readFileSync('supabase/migrations/20260920194951_shared_room_lifecycle_rls.sql','utf8');
const body = migration.replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,'');
const db = new pg.Client({connectionString:'postgresql://postgres@127.0.0.1:55488/settlement_t7'});
const publicNames = ['public.get_room_cash_lifecycle_v1(uuid,date,date)','public.get_room_residence_segments_v1(uuid[])'];
const helper = 'app_private.room_lifecycle_org_visible_v1(uuid)';
async function rollback(fn) { await db.query('BEGIN'); try { await fn(); } finally { await db.query('ROLLBACK'); } }
await db.connect();
try {
  await rollback(async()=>{ await db.query(body); await db.query(body); });
  for(const name of [...publicNames,helper]) await rollback(async()=>{
    await db.query(`ALTER FUNCTION ${name} SET search_path=public`);
    await assert.rejects(db.query(body),/definition drift/);
  });
  await rollback(async()=>{ await db.query(`GRANT EXECUTE ON FUNCTION ${helper} TO authenticated`); await assert.rejects(db.query(body),/ACL\/owner drift/); });
  await rollback(async()=>{ await db.query('GRANT ie_action_snapshot_reader TO anon'); await assert.rejects(db.query(body),/membership drift/); });
  await rollback(async()=>{ await db.query('ALTER ROLE ie_action_snapshot_reader BYPASSRLS'); await assert.rejects(db.query(body),/role prerequisite\/drift/); });
  for(const name of publicNames) {
    const row = (await db.query(`SELECT has_function_privilege('authenticated',$1,'EXECUTE') AS auth,
      has_function_privilege('anon',$1,'EXECUTE') AS anon,has_function_privilege('service_role',$1,'EXECUTE') AS service,
      pg_get_userbyid(proowner) AS owner,provolatile,prosecdef,proconfig FROM pg_proc WHERE oid=$1::regprocedure`,[name])).rows[0];
    assert.deepEqual(row,{auth:true,anon:false,service:false,owner:'ie_action_snapshot_reader',provolatile:'s',prosecdef:true,proconfig:['search_path=pg_catalog, public, app_private','row_security=on']});
  }
  const privileges=(await db.query(`SELECT has_schema_privilege('ie_action_snapshot_reader','public','CREATE') AS ddl,
    has_function_privilege('authenticated',$1,'EXECUTE') AS helper,pg_has_role('authenticated','ie_action_snapshot_reader','SET') AS client_set`,[helper])).rows[0];
  assert.deepEqual(privileges,{ddl:false,helper:false,client_set:false});
  const gate=fs.readFileSync('scripts/check-stable-fn-locks.mjs','utf8');
  const literal=gate.match(/const sql = (`[\s\S]*?`);/)[1];
  const locks=await db.query(vm.runInNewContext(literal));
  assert.equal(locks.rows.filter(row=>['get_room_cash_lifecycle_v1','get_room_residence_segments_v1'].includes(row.fn_name)).length,0);
  // Captured READ ONLY catalog is required to rehearse the original definitions,
  // not a synthetic weakened baseline. These definitions are never sent to shared.
  const catalog=JSON.parse(fs.readFileSync('.superpowers/sdd/2026-09-20-hop-dong-quyet-toan/live-room-reader-catalog.json','utf8')).rows;
  const deploy='t7_deployer_'+randomUUID().replaceAll('-','');
  try {
    await db.query(`CREATE ROLE ${deploy} NOLOGIN NOSUPERUSER CREATEROLE BYPASSRLS INHERIT`);
    await db.query(`GRANT postgres TO ${deploy}`);
    await rollback(async()=>{
      for(const name of publicNames){
        const original=catalog.find(row=>row.signature===name.replace('public.',''));
        assert.ok(original); await db.query(original.definition+';');
        await db.query(`ALTER FUNCTION ${name} OWNER TO postgres`);
        const hash=(await db.query('SELECT md5(pg_get_functiondef($1::regprocedure)) hash',[name])).rows[0].hash;
        assert.equal(hash,original.definition_md5);
      }
      await db.query(`DROP FUNCTION ${helper}`);
      await db.query(`SET LOCAL SESSION AUTHORIZATION ${deploy}`);
      await db.query(body); await db.query(body);
    });
  } finally { await db.query(`DROP ROLE IF EXISTS ${deploy}`); }
  console.log('T7 schema: reapply, exact definitions, role/ACL drift, RLS owner, STABLE gate, non-superuser first/reapply PASS');
} finally { await db.end(); }
