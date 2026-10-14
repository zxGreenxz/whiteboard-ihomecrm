import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setup,input} from '../../infra/hermes-broker/task-fixture.mjs';
import {prepareTaskMetadata} from '../../infra/hermes-broker/task-input-fixture.mjs';
import {TASK_FUNCTIONS,extractHermesFunctionDefinitions,verifyTaskFunctionCatalog} from '../hermes-task-function-contract.mjs';
const paths=['supabase/migrations/20261014092945_hermes_task_create_action_v1.sql','supabase/migrations/20261014094913_hermes_assistant_capabilities_v5.sql'];
const customerPath='supabase/migrations/20261014104442_hermes_customer_lead_create_action_v1.sql';
const sources=()=>paths.map(path=>({path,bytes:readFileSync(path)}));
async function fixture(t){
 const original=await setup(t),{db}=original;await prepareTaskMetadata(db);await db.exec(sources()[1].bytes.toString('utf8'));
 const pool={async connect(){return{query:(...args)=>db.query(...args),release(){}};}};
 return{...original,pool,verify:()=>verifyTaskFunctionCatalog(pool,sources())};
}

test('exact 13 task catalog bodies, signatures, dependencies and ACL verify in actual PostgreSQL',{timeout:60000},async t=>{
 const{db,verify}=await fixture(t);const before=(await db.query('SHOW search_path')).rows;
 await verify();assert.deepEqual((await db.query('SHOW search_path')).rows,before,'local deparser configuration rolls back');
 const rows=(await db.query("SELECT prosrc,prosqlbody IS NOT NULL parsed FROM pg_proc WHERE oid=ANY($1::regprocedure[])",[TASK_FUNCTIONS.filter(item=>item.standard).map(item=>item.signature)])).rows;
 assert.equal(rows.length,3);assert.ok(rows.every(row=>row.prosrc===''&&row.parsed));
});

test('catalog verification rejects actual changed callee even with empty prosrc and rejects mode widening',{timeout:60000},async t=>{
 const{db,verify}=await fixture(t),spec=TASK_FUNCTIONS.find(item=>item.name==='public.hermes_task_input_options_v1');
 await db.exec('CREATE FUNCTION app_private.wrong_task_guard(jsonb,jsonb) RETURNS jsonb LANGUAGE sql AS $$SELECT $2$$');
 await db.exec(spec.statement.replace('app_private.hermes_task_input_guard_v1','app_private.wrong_task_guard')+';');
 const dependency=(await db.query("SELECT count(*)::int n FROM pg_depend WHERE objid=$1::regprocedure AND refobjid='app_private.wrong_task_guard(jsonb,jsonb)'::regprocedure",[spec.signature])).rows[0];
 assert.equal(dependency.n,1);await assert.rejects(verify(),{code:'live_task_sql_standard_body_mismatch'});
 await db.exec(spec.statement+';');await verify();
 for(const item of TASK_FUNCTIONS.filter(item=>!item.definer)){
  await db.exec('ALTER FUNCTION '+item.signature+' SECURITY DEFINER');
  await assert.rejects(verify(),{code:'live_task_definition_mismatch'});
  await db.exec('ALTER FUNCTION '+item.signature+' SECURITY INVOKER');
 }
 await verify();
});

test('catalog rejects execute grants, private usage, table grants and RLS weakening',{timeout:60000},async t=>{
 const{db,verify}=await fixture(t);
 for(const [change,undo,code] of [
  ['GRANT EXECUTE ON FUNCTION public.hermes_task_input_options_v1(jsonb,jsonb) TO service_role','REVOKE EXECUTE ON FUNCTION public.hermes_task_input_options_v1(jsonb,jsonb) FROM service_role','live_task_acl_mismatch'],
  ['GRANT EXECUTE ON FUNCTION app_private.hermes_task_extend_options_v1(jsonb,text) TO authenticated','REVOKE EXECUTE ON FUNCTION app_private.hermes_task_extend_options_v1(jsonb,text) FROM authenticated','live_task_acl_mismatch'],
  ['GRANT EXECUTE ON FUNCTION public.hermes_task_create_action_v1(jsonb,text,jsonb) TO PUBLIC','REVOKE EXECUTE ON FUNCTION public.hermes_task_create_action_v1(jsonb,text,jsonb) FROM PUBLIC','live_task_acl_mismatch'],
  ['GRANT USAGE ON SCHEMA app_private TO authenticated','REVOKE USAGE ON SCHEMA app_private FROM authenticated','live_task_private_boundary_mismatch'],
  ['GRANT SELECT ON app_private.hermes_task_create_receipts TO authenticated','REVOKE SELECT ON app_private.hermes_task_create_receipts FROM authenticated','live_task_private_boundary_mismatch'],
  ['ALTER TABLE app_private.hermes_task_create_receipts DISABLE ROW LEVEL SECURITY','ALTER TABLE app_private.hermes_task_create_receipts ENABLE ROW LEVEL SECURITY','live_task_private_boundary_mismatch'],
 ]){await db.exec(change);await assert.rejects(verify(),{code});await db.exec(undo);}
 await verify();
});

test('catalog AS bodies stay exact and altered bound-OID evidence fails independently of deparse',{timeout:60000},async t=>{
 const{db,pool,verify}=await fixture(t),name='app_private.hermes_task_assignee_member_v1(uuid,uuid)';
 const original=(await db.query('SELECT pg_get_functiondef($1::regprocedure) definition',[name])).rows[0].definition;
 await db.exec(original.replace("SELECT auth.role()", "SELECT  auth.role()"));
 await assert.rejects(verify(),{code:'live_task_body_mismatch'});await db.exec(original);await verify();
 const changed={async connect(){const client=await pool.connect();return{...client,async query(...args){const result=await client.query(...args);
  if(args[0].includes('pg_get_function_identity_arguments'))result.rows.find(row=>row.name==='public.hermes_task_input_options_v1').dependencies[0].resolved_oid++;
  return result;}};}};
 await assert.rejects(verifyTaskFunctionCatalog(changed,sources()),{code:'live_task_dependency_mismatch'});
});

test('source extraction retains legacy AS-body checks and refuses an unreviewed SQL-standard body',()=>{
 for(const source of sources())assert.ok(extractHermesFunctionDefinitions(source.bytes.toString('utf8'),source.path).length>0);
 const spec=TASK_FUNCTIONS.find(item=>item.standard);
 for(const text of [spec.statement.replace('app_private.hermes_task_insert_v1','app_private.changed_insert'),
  spec.statement.replace('BEGIN ATOMIC','BEGIN ATOMIC SELECT 1;'),spec.statement.replace(spec.name,'public.hermes_unreviewed_standard_v1')]){
  assert.throws(()=>extractHermesFunctionDefinitions(text+';'),/task_sql_standard_source_mismatch/);
 }
 assert.throws(()=>extractHermesFunctionDefinitions("CREATE FUNCTION public.hermes_opaque() RETURNS void LANGUAGE c AS 'x','y';"),/Unreadable function body/);
});

test('external SQL-standard source is accepted only through its exact migration allowlist',()=>{
 const source=readFileSync(customerPath,'utf8');
 const definitions=extractHermesFunctionDefinitions(source,customerPath);
 assert.equal(definitions.find(item=>item.qualifiedName==='public.hermes_customer_create_action_v1')?.bodyKind,'sql-standard');
 assert.throws(()=>extractHermesFunctionDefinitions(source,'migration.sql'),/task_sql_standard_source_mismatch/);
 assert.throws(()=>extractHermesFunctionDefinitions(source.replace('public.hermes_customer_create_action_v1','public.hermes_unreviewed_customer_action_v1'),customerPath),/task_sql_standard_source_mismatch/);
});

test('SQL-standard body edit with unchanged dependency identities is rejected',{timeout:60000},async t=>{
 const{db,verify}=await fixture(t),spec=TASK_FUNCTIONS.find(item=>item.name==='app_private.hermes_task_input_rows_v1');
 const deps=async()=>(await db.query("SELECT refclassid,refobjid,refobjsubid,deptype FROM pg_depend WHERE classid='pg_proc'::regclass AND objid=$1::regprocedure ORDER BY refclassid,refobjid,refobjsubid,deptype",[spec.signature])).rows;
 const before=await deps();
 await db.exec(spec.statement.replace("x.input->>'kind'='assignees'","x.input->>'kind'='rooms'")+';');
 assert.deepEqual(await deps(),before,'callee/relation OIDs alone cannot prove the body');
 await assert.rejects(verify(),{code:'live_task_sql_standard_body_mismatch'});
 await db.exec(spec.statement+';');await verify();
});

test('receipt REVOKE ALL rejects actual TRUNCATE and every non-DML privilege drift',{timeout:60000},async t=>{
 const{db,rpc,counts,verify}=await fixture(t);await verify();await rpc('create',input);
 assert.deepEqual(await counts(),{jobs:1,receipts:1,audits:1});
 await db.exec('GRANT TRUNCATE ON app_private.hermes_task_create_receipts TO hermes_store_executor');
 assert.deepEqual((await db.query("SELECT has_schema_privilege('hermes_store_executor','app_private','USAGE') schema_usage,has_table_privilege('hermes_store_executor','app_private.hermes_task_create_receipts','TRUNCATE') allowed")).rows,[{schema_usage:true,allowed:true}]);
 await assert.rejects(verify(),{code:'live_task_private_boundary_mismatch'});
 // RLS does not protect TRUNCATE. Prove the injected grant can destroy the
 // ledger independently of the surviving canonical job/audit, then roll back.
 await db.exec('BEGIN;SET LOCAL ROLE hermes_store_executor;TRUNCATE app_private.hermes_task_create_receipts;RESET ROLE');
 assert.deepEqual(await counts(),{jobs:1,receipts:0,audits:1});await db.exec('ROLLBACK');
 await db.exec('REVOKE TRUNCATE ON app_private.hermes_task_create_receipts FROM hermes_store_executor');await verify();
 await db.exec('CREATE ROLE task_receipt_observer');
 for(const [privilege,role]of [['REFERENCES','authenticated'],['TRIGGER','service_role'],['MAINTAIN','hermes_store_executor'],['TRUNCATE','PUBLIC'],['TRUNCATE','task_receipt_observer']]){
  await db.exec(`GRANT ${privilege} ON app_private.hermes_task_create_receipts TO ${role}`);
  await assert.rejects(verify(),{code:'live_task_private_boundary_mismatch'});
  await db.exec(`REVOKE ${privilege} ON app_private.hermes_task_create_receipts FROM ${role}`);await verify();
 }
 assert.deepEqual(await counts(),{jobs:1,receipts:1,audits:1});
});

test('receipt effective table privileges reject inherited owner rights despite unchanged direct ACL',{timeout:60000},async t=>{
 const{db,verify}=await fixture(t);await verify();
 await db.exec('GRANT postgres TO hermes_store_executor WITH INHERIT TRUE');
 const row=(await db.query("SELECT COALESCE(c.relacl,acldefault('r',c.relowner))=acldefault('r',c.relowner) owner_only_acl,has_table_privilege('hermes_store_executor',c.oid,'TRUNCATE') allowed FROM pg_class c WHERE c.oid='app_private.hermes_task_create_receipts'::regclass")).rows[0];
 assert.deepEqual(row,{owner_only_acl:true,allowed:true});
 await assert.rejects(verify(),{code:'live_task_acl_mismatch'}); // Function rights also widen through the owner.
 // Isolate the receipt check from the earlier function check using real rows;
 // only the function effective-ACL response is pinned to its verified baseline.
 const pool={async connect(){return{release(){},async query(sql,args){
  if(sql.startsWith('SELECT role,has_function_privilege'))return{rows:args[1].map(role=>({role,allowed:role==='authenticated'&&TASK_FUNCTIONS.find(item=>item.signature===args[0]).authenticated}))};
  return db.query(sql,args);
 }}}};
 await assert.rejects(verifyTaskFunctionCatalog(pool,sources()),{code:'live_task_private_boundary_mismatch'});
 await db.exec('REVOKE postgres FROM hermes_store_executor');await verify();
});
