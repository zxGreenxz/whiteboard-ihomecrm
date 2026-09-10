// Runs a disposable local PostgreSQL engine against exported function bodies.
// No production connection or financial fixtures. This does not replace live
// role/tenant verification: authorization and feature-route dependencies below
// are bounded fixture implementations, explicitly recorded in the receipt.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {buildReview} from './build-review.mjs';
import {verifyBusinessOrganization} from './verify-business-organization.mjs';
const [,,catalogFile,reportFile]=process.argv;
if(!catalogFile||!reportFile)throw new Error('Usage: node verify-live-review.mjs LOCAL_CATALOG_JSON LOCAL_REPORT_JSON');
const snapshot=JSON.parse(readFileSync(catalogFile,'utf8'));
const review=buildReview(snapshot);
assert.equal(review.sql.includes('\r'),false,'Review source must survive Git line-ending normalization without changing catalog bytes');
const quote=s=>'"'+s.replaceAll('"','""')+'"';
const sig=f=>`${f.schema}.${f.name}(${f.arguments.split(',').filter(Boolean).map(x=>x.trim().replace(/^\w+\s+/, '')).join(',')})`;
const selected=snapshot.functions.filter(f=>review.changes.some(c=>c.signature===sig(f)));
const orgA='dddd0000-0000-4000-8000-000000000001',orgB='cccc0000-0000-4000-8000-000000000001';
const actor='00000000-0000-4000-8000-000000000001',staffA='00000000-0000-4000-8000-000000000002',staffB='00000000-0000-4000-8000-000000000003';
const db=new PGlite();
let failed=false;
try{
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
 CREATE SCHEMA auth;CREATE SCHEMA app_private;CREATE SCHEMA storage;CREATE SCHEMA extensions;
 CREATE FUNCTION public.org_today_v1(uuid) RETURNS date LANGUAGE sql STABLE AS $$SELECT current_date$$;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;`);
 const tables=new Map();
 for(const c of snapshot.columns){
  const key=quote(c.table_schema)+'.'+quote(c.table_name);
  if(!tables.has(key))tables.set(key,[]);
  const type=c.udt_schema==='pg_catalog'?'pg_catalog.'+quote(c.udt_name):c.data_type==='ARRAY'?'text[]':'text';
  tables.get(key).push(quote(c.column_name)+' '+type+(c.column_name==='id'&&c.udt_name==='uuid'?' DEFAULT gen_random_uuid()':''));
 }
 await db.exec([...tables].map(([table,columns])=>`CREATE TABLE ${table} (${columns.join(',')});`).join('\n'));
 await db.exec(`CREATE TABLE auth.users(id uuid,email text);
 ALTER TABLE app_private.canonical_write_operations ADD UNIQUE(organization_id,operation,subject_scope,actor_id,idempotency_key);
 ALTER TABLE public.salary_monthly ADD UNIQUE(staff_id,period_month);`);
 for(const f of selected){
  await db.exec(f.definition);
  const actual=(await db.query('SELECT md5(pg_get_functiondef($1::regprocedure)) digest',[sig(f)])).rows[0].digest;
  assert.equal(actual,f.digest,'Exported definition must reproduce the live catalog identity: '+f.name);
 }
 const businessTables=JSON.parse(readFileSync(new URL('./business-organization-tables.json',import.meta.url),'utf8')).map(([table])=>table);
 const neededTriggers=snapshot.triggers.filter(t=>t.schema==='public'&&['buildings','areas','building_utility_accounts','settings','salary_monthly','salary_adjustments',...businessTables].includes(t.table));
 const triggerFunctions=new Set(neededTriggers.map(t=>/EXECUTE FUNCTION ([\w.]+)\(/.exec(t.definition)?.[1]));
 for(const name of triggerFunctions){
  const qualified=name.includes('.')?name:'public.'+name;
  const f=snapshot.functions.find(f=>f.schema+'.'+f.name===qualified);
  assert.ok(f,'Known baseline trigger function '+name);await db.exec(f.definition);
 }
 for(const t of neededTriggers)await db.exec(t.definition);
 await db.exec(`
 CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS void LANGUAGE sql AS $$SELECT$$;
 CREATE FUNCTION app_private.authorize_tenant_action_v3(p_actor uuid,p_org uuid,p_permission text,p_building uuid,p_cashbook uuid)
 RETURNS TABLE(allowed boolean) LANGUAGE sql AS $$SELECT EXISTS(SELECT 1 FROM public.organization_memberships WHERE user_id=p_actor AND organization_id=p_org AND status='ACTIVE')$$;
 CREATE FUNCTION app_private.evaluate_feature_route(text,uuid) RETURNS text LANGUAGE sql AS $$SELECT 'CANONICAL'::text$$;
 INSERT INTO public.organizations(id,status) VALUES('${orgA}','ACTIVE'),('${orgB}','ACTIVE');
 INSERT INTO public.organization_memberships(user_id,organization_id,status) VALUES('${actor}','${orgA}','ACTIVE'),('${staffA}','${orgA}','ACTIVE'),('${staffB}','${orgB}','ACTIVE');
 INSERT INTO public.salary_monthly(staff_id,period_month,organization_id,status) VALUES('${staffA}','2026-09-01','${orgA}','LOCKED'),('${staffB}','2026-09-01','${orgB}','LOCKED');
 GRANT USAGE ON SCHEMA auth TO authenticated;
 REVOKE ALL ON FUNCTION public.unlock_salary_month_v1(date,uuid[],text) FROM PUBLIC;
 GRANT EXECUTE ON FUNCTION public.unlock_salary_month_v1(date,uuid[],text) TO authenticated;`);
 const metadata=async()=> (await db.query(`SELECT p.oid::regprocedure::text signature,p.prosecdef,p.provolatile,p.proacl,p.proconfig,pg_get_userbyid(p.proowner) owner
  FROM pg_proc p WHERE p.oid=ANY($1::regprocedure[]) ORDER BY 1`,[review.changes.map(c=>c.signature)])).rows;
 const beforeMetadata=await metadata();
 const salaryRows=async()=> (await db.query('SELECT staff_id,organization_id,status FROM public.salary_monthly ORDER BY staff_id')).rows;
 const beforeRows=await salaryRows();
 const unlock=async (user,ids,key)=>{
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.headers','{}',false)",[user]);
  await db.exec('SET ROLE authenticated');
  try{return(await db.query('SELECT public.unlock_salary_month_v1($1,$2,$3) result',['2026-09-01',ids,key])).rows[0].result;}
  finally{await db.exec('RESET ROLE');}
 };
 await db.exec('BEGIN');
 const oldResult=await unlock(actor,[staffA,staffB],'org-review-before');
 assert.equal(oldResult.unlocked_count,2,'Reproduce the cross-company batch defect in the old body');
 await db.exec('ROLLBACK');
 assert.deepEqual(await salaryRows(),beforeRows);
 // The default review compiles every selected definition, then rolls back.
 await db.exec(review.sql);
 assert.equal((await db.query("SELECT to_regprocedure('app_private.working_organization_v1(boolean)') value")).rows[0].value,null);
 const commit=review.sql.replace(/ROLLBACK;\s*$/,'COMMIT;');
 await db.exec(commit);
 await db.exec(commit);
 assert.deepEqual(await metadata(),beforeMetadata,'Existing function ACLs, owners and execution settings are unchanged');
 await assert.rejects(unlock(actor,[staffA,staffB],'org-review-after'),/Không xác định|công ty khác/);
 assert.deepEqual(await salaryRows(),beforeRows,'Rejected batch changes no salary row');
 const result=await unlock(actor,[staffA],'org-review-one');
 assert.equal(result.unlocked_count,1);
 assert.equal((await salaryRows()).find(x=>x.staff_id===staffB).status,'LOCKED');
 assert.deepEqual(await unlock(actor,[staffA],'org-review-one'),result,'Idempotent replay returns the original response');
 await assert.rejects(unlock(staffB,[staffA],'org-review-denied'),/Không xác định|Không có quyền/);
 await db.exec(`INSERT INTO public.organization_memberships(user_id,organization_id,status) VALUES('${actor}','${orgB}','ACTIVE');`);
 await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.headers',$2,false)",[actor,JSON.stringify({'x-ihomecrm-organization-id':orgB})]);
 const building=(await db.query('INSERT INTO public.buildings(user_id) VALUES($1) RETURNING organization_id',[actor])).rows[0];
 assert.equal(building.organization_id,orgB,'A root insert derives the selected company, not the old hardcoded production fallback');
 await db.query("SELECT set_config('request.headers','{}',false)");
 await assert.rejects(db.query('INSERT INTO public.areas(user_id) VALUES($1)',[actor]),/chọn công ty/);
 // Exercise the actual generated parent helpers against same-name records in
 // both companies. Normalization/demo-list dependencies are bounded fixtures.
 await db.exec(`CREATE FUNCTION public.normalize_income_expense_type_name(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT lower(btrim($1))$$;
 CREATE FUNCTION public.demo_user_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$SELECT '{}'::uuid[]$$;
 CREATE DOMAIN public.building_type AS text; CREATE DOMAIN public.building_status AS text;
 INSERT INTO public.income_expense_types(id,organization_id,user_id,type,name,force_approval)
 VALUES('00000000-0000-4000-8002-000000000001','${orgA}','${actor}','expense','Same type',false),
 ('00000000-0000-4000-8002-000000000002','${orgB}','${actor}','expense','Same type',false);
 INSERT INTO public.accounts(id,organization_id,user_id,name,is_virtual,created_at)
 VALUES('00000000-0000-4000-8003-000000000001','${orgA}','${actor}','Cấn trừ thanh lý (nội bộ)',false,now()),
 ('00000000-0000-4000-8003-000000000002','${orgB}','${actor}','Cấn trừ thanh lý (nội bộ)',false,now()-interval '1 day'),
 ('00000000-0000-4000-8003-000000000003','${orgA}','${actor}','Operating A',false,now());
 INSERT INTO public.buildings(id,organization_id,user_id,name,is_virtual)
 VALUES('00000000-0000-4000-8004-000000000001','${orgA}','${actor}','Chung',true),
 ('00000000-0000-4000-8004-000000000002','${orgB}','${actor}','Chung',true);`);
 await db.query("SELECT set_config('request.headers',$1,false)",[JSON.stringify({'x-ihomecrm-organization-id':orgB})]);
 const parentType=(await db.query("SELECT app_private.ensure_termination_type_in_org_v1($1,'expense','Same type',$2) id",[actor,orgA])).rows[0].id;
 assert.equal(parentType,'00000000-0000-4000-8002-000000000001');
 assert.equal((await db.query("SELECT force_approval FROM income_expense_types WHERE organization_id=$1",[orgB])).rows[0].force_approval,false);
 assert.equal((await db.query("SELECT public._termination_ensure_type($1,'expense','Same type') id",[actor])).rows[0].id,'00000000-0000-4000-8002-000000000002');
 assert.equal((await db.query('SELECT app_private.internal_settlement_account_in_org_v1($1,$2) id',[actor,orgA])).rows[0].id,'00000000-0000-4000-8003-000000000001');
 assert.equal((await db.query('SELECT is_virtual FROM accounts WHERE id=$1',['00000000-0000-4000-8003-000000000002'])).rows[0].is_virtual,false);
 assert.equal((await db.query('SELECT app_private.chung_building_in_org_v1($1,$2) id',[actor,orgA])).rows[0].id,'00000000-0000-4000-8004-000000000001');
 assert.equal((await db.query('SELECT public._chung_building($1) id',[actor])).rows[0].id,'00000000-0000-4000-8004-000000000002');
 await db.exec("UPDATE buildings SET default_account_id_tt='00000000-0000-4000-8003-000000000002' WHERE id='00000000-0000-4000-8004-000000000001'");
 assert.equal((await db.query('SELECT public._termination_pick_account($1,$2) id',[actor,'00000000-0000-4000-8004-000000000001'])).rows[0].id,'00000000-0000-4000-8003-000000000003');
 // Exercise the original and patched staff-removal bodies on the same fixture.
 // Do not install assignment/RLS dependencies: their live behavior is a separate gate.
 await db.exec(`CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE
 AS $$SELECT current_setting('fixture.super_admin',true)='true'$$;
 UPDATE public.organizations SET authorization_version=10;
 INSERT INTO public.organization_memberships(user_id,organization_id,status,version) VALUES('${staffA}','${orgB}','ACTIVE',1);
 INSERT INTO public.staff_assignments(staff_id,user_id,organization_id)
 VALUES('${staffA}','${actor}','${orgA}'),('${staffA}','${actor}','${orgB}');
 INSERT INTO public.roles(user_id) VALUES('${staffA}');`);
 await db.query("SELECT set_config('request.headers',$1,false),set_config('fixture.super_admin','true',false)",[JSON.stringify({'x-ihomecrm-organization-id':orgA})]);
 const staffState=async()=>({
   memberships:(await db.query('SELECT organization_id,status FROM organization_memberships WHERE user_id=$1 ORDER BY organization_id',[staffA])).rows,
   assignments:(await db.query('SELECT organization_id FROM staff_assignments WHERE staff_id=$1 ORDER BY organization_id',[staffA])).rows,
   roles:(await db.query('SELECT count(*)::int n FROM roles WHERE user_id=$1',[staffA])).rows[0].n,
 });
 const originalStaffState=await staffState();
 await db.exec('BEGIN');
 await db.exec(snapshot.functions.find(f=>f.name==='delete_staff_member').definition);
 await db.query('SELECT delete_staff_member($1)',[staffA]);
 assert.equal((await staffState()).memberships.filter(m=>m.status==='REVOKED').length,2,'Old removal crosses both companies');
 await db.exec('ROLLBACK');
 assert.deepEqual(await staffState(),originalStaffState);
 const scopedStaffBody=(await db.query("SELECT pg_get_functiondef('public.delete_staff_member(uuid)'::regprocedure) body")).rows[0].body;
 const scopedAssignmentDelete='delete from public.staff_assignments where staff_id = p_staff_id and organization_id = v_org;';
 assert.ok(scopedStaffBody.includes(scopedAssignmentDelete));
 let staffScopeMutationCaught=false;
 await db.exec('BEGIN');
 try{
   await db.exec(scopedStaffBody.replace(scopedAssignmentDelete,'delete from public.staff_assignments where staff_id = p_staff_id;'));
   await db.query('SELECT delete_staff_member($1)',[staffA]);
   const foreignAssignments=(await staffState()).assignments.filter(a=>a.organization_id===orgB);
   try{assert.equal(foreignAssignments.length,1,'Foreign assignment must survive removal');}
   catch(error){if(error.code!=='ERR_ASSERTION')throw error;staffScopeMutationCaught=true;}
 }finally{await db.exec('ROLLBACK');}
 assert.ok(staffScopeMutationCaught,'Removing the company filter must be caught by the regression assertion');
 assert.deepEqual(await staffState(),originalStaffState);
 await db.query('SELECT delete_staff_member($1)',[staffA]);
 const removed=await staffState();
 assert.equal(removed.memberships.find(m=>m.organization_id===orgA).status,'REVOKED');
 assert.equal(removed.memberships.find(m=>m.organization_id===orgB).status,'ACTIVE');
 assert.deepEqual(removed.assignments,[{organization_id:orgB}]);
 assert.equal(removed.roles,1,'Other-company legacy role remains');
 assert.equal((await db.query('SELECT authorization_version FROM organizations WHERE id=$1',[orgB])).rows[0].authorization_version,10);
 await db.query("SELECT set_config('request.headers',$1,false)",[JSON.stringify({'x-ihomecrm-organization-id':orgB})]);
 await db.exec(`INSERT INTO public.organization_roles(id,organization_id,name)
 VALUES('00000000-0000-4000-8005-000000000001','${orgB}','Chủ sở hữu tổ chức');
 INSERT INTO public.role_bindings(organization_id,membership_id,role_id,valid_from)
 SELECT '${orgB}',id,'00000000-0000-4000-8005-000000000001',now() FROM organization_memberships WHERE user_id='${staffA}' AND organization_id='${orgB}';`);
 await assert.rejects(db.query('SELECT delete_staff_member($1)',[staffA]),/CHỦ SỞ HỮU CUỐI CÙNG/);
 assert.deepEqual(await staffState(),removed,'Last-owner rejection changes nothing');
 await db.query("SELECT set_config('request.headers','{}',false)");
 await assert.rejects(db.query('SELECT delete_staff_member($1)',[staffA]),/chọn công ty/);
 const businessChecks=await verifyBusinessOrganization(db,snapshot,{orgA,orgB,actor});
 const report={...businessChecks,checkedAt:new Date().toISOString(),catalogCapturedAt:snapshot.captured_at,reviewSha256:createHash('sha256').update(review.sql).digest('hex'),
  functionsCompiled:selected.length,idempotent:true,originalCrossCompanyUnlockReproduced:true,mixedBatchRejected:true,foreignSalaryPreserved:true,
  existingFunctionSecurityMetadataUnchanged:true,rootInsertContextVerified:true,parentTypeAndAccountIsolationVerified:true,
  staffRemovalCrossCompanyDefectReproduced:true,staffRemovalScopedAndLastOwnerProtected:true,staffScopeMutationCaught,
  limits:'Disposable local PostgreSQL with exported live function bodies and column types; enum columns represented as text. Authorization, date, normalization, demo-list and feature-route dependencies are fixture implementations. This is not a production mutation or a substitute for live role/tenant checks.'};
 writeFileSync(reportFile,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){console.error(JSON.stringify({message:error.message,code:error.code,context:error.where?.slice(0,1500)}));failed=true;}
finally{await db.close();}
if(failed)process.exitCode=1;
