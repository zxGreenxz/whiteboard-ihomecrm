#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
const file='supabase/migrations/20260920205323_contract_settlement_financial_context.sql';
const body=fs.readFileSync(file,'utf8').replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,'');
const names=['public.read_contract_settlement_financial_facts_v1(uuid,uuid,uuid,uuid,uuid,uuid)','app_private.settlement_financial_source_ids_v1(uuid,uuid,uuid)','app_private.settlement_financial_evidence_v1(uuid,uuid[],uuid)'];
const db=new pg.Client({connectionString:'postgresql://postgres@127.0.0.1:55488/settlement_t7'});await db.connect();
const rollback=async fn=>{await db.query('BEGIN');try{await fn();}finally{await db.query('ROLLBACK');}};
try{
 await rollback(async()=>{await db.query(body);await db.query(body);});
 for(const name of names)await rollback(async()=>{await db.query(`ALTER FUNCTION ${name} SET search_path=public`);await assert.rejects(db.query(body),/definition\/owner drift/);});
 await rollback(async()=>{await db.query(`GRANT EXECUTE ON FUNCTION ${names[1]} TO authenticated`);await assert.rejects(db.query(body),/ACL drift/);});
 await rollback(async()=>{await db.query('GRANT ie_action_snapshot_reader TO anon');await assert.rejects(db.query(body),/membership drift/);});
 for(const name of names){const r=(await db.query('SELECT has_function_privilege(\'authenticated\',$1,\'EXECUTE\') auth,has_function_privilege(\'anon\',$1,\'EXECUTE\') anon,provolatile,prosecdef FROM pg_proc WHERE oid=$1::regprocedure',[name])).rows[0];assert.deepEqual(r,{auth:name===names[0],anon:false,provolatile:'s',prosecdef:true});}
 const role='t7_fin_deployer_'+randomUUID().replaceAll('-','');
 try{await db.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER CREATEROLE BYPASSRLS INHERIT`);await db.query(`GRANT postgres TO ${role}`);
 await rollback(async()=>{for(const name of names)await db.query(`DROP FUNCTION ${name}`);await db.query(`SET LOCAL SESSION AUTHORIZATION ${role}`);await db.query(body);await db.query(body);});
 }finally{await db.query(`DROP ROLE IF EXISTS ${role}`);}
 console.log('Financial schema: exact reapply / private ACL / definition-role drift / first nonsuperuser PASS');
}finally{await db.end();}
