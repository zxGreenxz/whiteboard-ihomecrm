#!/usr/bin/env node
// Disposable loopback schema rehearsal only; every mutation is rolled back.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const file='supabase/migrations/20260921004455_contract_settlement_termination_breakdown.sql';
const source=fs.readFileSync(file,'utf8');
const body=source.replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,'').replace(/^NOTIFY pgrst,'reload schema';$/m,'');
const previous=fs.readFileSync('supabase/migrations/20260920205323_contract_settlement_financial_context.sql','utf8');
const marker='CREATE OR REPLACE FUNCTION public.read_contract_settlement_financial_facts_v1';
const start=previous.indexOf(marker),end=previous.indexOf('\nGRANT CREATE ON SCHEMA public',start);
assert.ok(start>=0&&end>start,'previous public reader definition must be extractable');
const previousReader=previous.slice(start,end);
const publicFn='public.read_contract_settlement_financial_facts_v1(uuid,uuid,uuid,uuid,uuid,uuid)';
const helperFn='app_private.settlement_termination_breakdown_v1(uuid,uuid,uuid,uuid,boolean,boolean)';
const linkFn='app_private.settlement_termination_voucher_link_v1(uuid,uuid,uuid,uuid)';
const db=new pg.Client({connectionString:'postgresql://postgres@127.0.0.1:55488/settlement_t7'});
await db.connect();
const rollback=async(fn)=>{await db.query('BEGIN');try{await fn();}finally{await db.query('ROLLBACK');}};
try{
  await rollback(async()=>{await db.query(body);await db.query(body);});
  await rollback(async()=>{await db.query('ALTER ROLE ie_action_snapshot_reader BYPASSRLS');await assert.rejects(db.query(body),/role drift/);});
  await rollback(async()=>{await db.query('GRANT ie_action_snapshot_reader TO anon');await assert.rejects(db.query(body),/membership drift/);});
  await rollback(async()=>{await db.query(`ALTER FUNCTION ${helperFn} SET search_path=public`);await assert.rejects(db.query(body),/definition\/owner drift/);});
  await rollback(async()=>{await db.query(`GRANT EXECUTE ON FUNCTION ${helperFn} TO authenticated`);await assert.rejects(db.query(body),/ACL drift/);});
  await rollback(async()=>{await db.query(`GRANT EXECUTE ON FUNCTION ${linkFn} TO authenticated`);await assert.rejects(db.query(body),/ACL drift/);});
  await rollback(async()=>{await db.query(`GRANT EXECUTE ON FUNCTION ${publicFn} TO service_role`);await assert.rejects(db.query(body),/ACL drift/);});
  const helper=(await db.query(`SELECT pg_get_userbyid(proowner) owner,provolatile,prosecdef,
    has_function_privilege('ie_action_snapshot_reader',$1,'EXECUTE') reader,
    has_function_privilege('authenticated',$1,'EXECUTE') auth,
    has_function_privilege('anon',$1,'EXECUTE') anon,
    has_function_privilege('service_role',$1,'EXECUTE') service
    FROM pg_proc WHERE oid=$1::regprocedure`,[helperFn])).rows[0];
  assert.deepEqual(helper,{owner:'ie_action_snapshot_reader',provolatile:'s',prosecdef:true,reader:true,auth:false,anon:false,service:false});
  await rollback(async()=>{await db.query(`GRANT CREATE ON SCHEMA app_private TO postgres`);await db.query(`ALTER FUNCTION ${helperFn} OWNER TO postgres`);await assert.rejects(db.query(body),/definition\/owner drift/);});
  const pub=(await db.query(`SELECT pg_get_userbyid(proowner) owner,provolatile,prosecdef,
    has_function_privilege('authenticated',$1,'EXECUTE') auth,
    has_function_privilege('anon',$1,'EXECUTE') anon,
    has_function_privilege('service_role',$1,'EXECUTE') service
    FROM pg_proc WHERE oid=$1::regprocedure`,[publicFn])).rows[0];
  assert.deepEqual(pub,{owner:'ie_action_snapshot_reader',provolatile:'s',prosecdef:true,auth:true,anon:false,service:false});
  const link=(await db.query(`SELECT pg_get_userbyid(proowner) owner,provolatile,prosecdef,
    has_function_privilege('ie_action_snapshot_reader',$1,'EXECUTE') reader,
    has_function_privilege('authenticated',$1,'EXECUTE') auth,
    has_function_privilege('anon',$1,'EXECUTE') anon,
    has_function_privilege('service_role',$1,'EXECUTE') service
    FROM pg_proc WHERE oid=$1::regprocedure`,[linkFn])).rows[0];
  assert.deepEqual(link,{owner:'postgres',provolatile:'s',prosecdef:true,reader:true,auth:false,anon:false,service:false});

  const role='t7_breakdown_deployer_'+randomUUID().replaceAll('-','');
  try{
    await db.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER CREATEROLE BYPASSRLS INHERIT`);
    await db.query(`GRANT postgres TO ${role}`);
    await rollback(async()=>{
      await db.query(previousReader);
      await db.query(`DROP FUNCTION ${helperFn}`);
      await db.query(`DROP FUNCTION ${linkFn}`);
      await db.query(`SET LOCAL SESSION AUTHORIZATION ${role}`);
      await db.query(body);
      await db.query(body);
    });
  }finally{await db.query(`DROP ROLE IF EXISTS ${role}`);}

  const gate=fs.readFileSync('scripts/check-stable-fn-locks.mjs','utf8');
  const literal=gate.match(/const sql = (`[\s\S]*?`);/u)?.[1];
  assert.ok(literal,'stable lock query must be extractable');
  const sql=vm.runInNewContext(literal);
  const violations=(await db.query(sql)).rows.filter(row=>['read_contract_settlement_financial_facts_v1'].includes(row.fn_name));
  assert.deepEqual(violations,[],'new reader/helper chain must not be STABLE with row locks');
  console.log('Termination breakdown schema: reapply / nonsuperuser / role-membership-owner-ACL drift / stable chain PASS');
}finally{await db.end();}
