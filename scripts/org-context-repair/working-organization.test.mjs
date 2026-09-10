import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import {verifyBusinessOrganization} from './verify-business-organization.mjs';
import {verifyMemberVisibility} from './verify-member-visibility.mjs';
const orgA='dddd0000-0000-4000-8000-000000000001',orgB='cccc0000-0000-4000-8000-000000000001';
const admin='00000000-0000-4000-8000-000000000001',staff='00000000-0000-4000-8000-000000000002',outsider='00000000-0000-4000-8000-000000000003';
async function setup(){
 const db=new PGlite();
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA app_private;CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 CREATE TABLE organizations(id uuid PRIMARY KEY,status text);
 CREATE TABLE organization_memberships(user_id uuid,organization_id uuid,status text,valid_from timestamptz,valid_to timestamptz);
 CREATE TABLE salary_monthly(id uuid,staff_id uuid,period_month date,organization_id uuid,status text);
 CREATE TABLE manager_salary_config(staff_id uuid,organization_id uuid,is_active boolean,effective_from date,effective_to date);
 CREATE TABLE accounts(id uuid,organization_id uuid,deleted_at timestamptz);
 INSERT INTO organizations VALUES('${orgA}','ACTIVE'),('${orgB}','ACTIVE');
 INSERT INTO organization_memberships(user_id,organization_id,status) VALUES
 ('${admin}','${orgA}','ACTIVE'),('${admin}','${orgB}','ACTIVE'),('${staff}','${orgA}','ACTIVE'),('${outsider}','${orgB}','ACTIVE');
 ${readFileSync(new URL('./working-organization.sql',import.meta.url),'utf8')}
 CREATE FUNCTION public.context_probe() RETURNS uuid LANGUAGE sql SECURITY DEFINER AS $$SELECT app_private.working_organization_v1()$$;
 CREATE FUNCTION public.salary_probe(p_staff uuid,p_period date,p_account uuid DEFAULT NULL) RETURNS uuid LANGUAGE sql SECURITY DEFINER AS $$SELECT app_private.salary_subject_organization_v1(p_staff,p_period,p_account)$$;
 REVOKE ALL ON FUNCTION context_probe(),salary_probe(uuid,date,uuid) FROM PUBLIC;GRANT EXECUTE ON FUNCTION context_probe(),salary_probe(uuid,date,uuid) TO authenticated;`);
 return db;
}
async function call(db,user,selected,sql='SELECT context_probe() org',args=[]){
 await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.headers',$2,false)",[user,JSON.stringify(selected===undefined?{}:{'x-ihomecrm-organization-id':selected})]);
 await db.exec('SET ROLE authenticated');
 try{return (await db.query(sql,args)).rows[0]?.org;}finally{await db.exec('RESET ROLE');}
}
test('working company is explicit for multi-company users and valid single-company callers remain compatible',async()=>{
 const db=await setup();try{
  assert.equal(await call(db,staff),orgA);
  await assert.rejects(call(db,admin),/chọn công ty/);
  assert.equal(await call(db,admin,orgB),orgB);
  assert.equal(await call(db,admin,orgA),orgA);
  await assert.rejects(call(db,staff,orgB),/Không còn quyền/);
  await assert.rejects(call(db,admin,'invalid'),/không hợp lệ/);
  await assert.rejects(call(db,'',orgA),/Chưa đăng nhập/);
  for(const role of ['anon','authenticated','service_role'])assert.equal((await db.query("SELECT has_function_privilege($1,'app_private.working_organization_v1(boolean)','EXECUTE') allowed",[role])).rows[0].allowed,false);
 }finally{await db.close();}
});
test('revoked, expired, future memberships and inactive companies cannot be selected',async()=>{
 const db=await setup();try{
  for(const change of ["status='REVOKED'","valid_to=now()-interval '1 minute'","valid_from=now()+interval '1 day'"]){
   await db.exec(`UPDATE organization_memberships SET ${change} WHERE user_id='${admin}' AND organization_id='${orgB}'`);
   await assert.rejects(call(db,admin,orgB),/Không còn quyền/);
   await db.exec(`UPDATE organization_memberships SET status='ACTIVE',valid_from=NULL,valid_to=NULL`);
  }
  await db.exec(`UPDATE organizations SET status='SUSPENDED' WHERE id='${orgB}'`);
  await assert.rejects(call(db,admin,orgB),/Không còn quyền/);
 }finally{await db.close();}
});
test('salary context follows the stored period and rejects a cashbook from another company',async()=>{
 const db=await setup();try{
  const book='00000000-0000-4000-8001-000000000001';
  await db.exec(`INSERT INTO salary_monthly VALUES(gen_random_uuid(),'${staff}','2026-09-01','${orgA}','LOCKED');
  INSERT INTO manager_salary_config VALUES('${staff}','${orgB}',true,'2026-01-01',NULL);
  INSERT INTO accounts VALUES('${book}','${orgB}',NULL);`);
  const sql='SELECT salary_probe($1,$2,$3) org';
  assert.equal(await call(db,admin,orgB,sql,[staff,'2026-09-01',null]),orgA);
  await assert.rejects(call(db,admin,orgB,sql,[staff,'2026-09-01',book]),/Sổ quỹ không thuộc/);
  await assert.rejects(call(db,outsider,orgB,sql,[staff,'2026-09-01',null]),/Không xác định/);
  await db.exec('UPDATE salary_monthly SET organization_id=NULL');
  await assert.rejects(call(db,admin,orgA,sql,[staff,'2026-09-01',null]),/chưa có công ty/);
 }finally{await db.close();}
});
test('new salary periods use the chosen valid company and never an arbitrary first membership',async()=>{
 const db=await setup();try{
  await db.exec(`INSERT INTO organization_memberships(user_id,organization_id,status) VALUES('${staff}','${orgB}','ACTIVE')`);
  const sql='SELECT salary_probe($1,$2) org',args=[staff,'2026-09-01'];
  await assert.rejects(call(db,admin,undefined,sql,args),/Không xác định/);
  assert.equal(await call(db,admin,orgB,sql,args),orgB);
  assert.equal(await call(db,admin,orgA,sql,args),orgA);
 }finally{await db.close();}
});


test('business inserts follow all parents and reject conflicting company references',async()=>{
 const db=await setup();try{
  const plans=JSON.parse(readFileSync(new URL('./business-organization-tables.json',import.meta.url),'utf8'));
  const tableColumns=new Map();
  for(const [table,parents] of plans){
   if(!tableColumns.has(table))tableColumns.set(table,new Set());
   for(const [column,parent] of parents){
    tableColumns.get(table).add(column);
    if(!tableColumns.has(parent))tableColumns.set(parent,new Set());
   }
  }
  for(const [table,columns] of tableColumns){
   await db.exec('CREATE TABLE IF NOT EXISTS public.'+table+'(id uuid DEFAULT gen_random_uuid(),organization_id uuid,user_id uuid)');
   await db.exec('ALTER TABLE public.'+table+' ADD COLUMN IF NOT EXISTS user_id uuid');
   for(const column of columns)await db.exec('ALTER TABLE public.'+table+' ADD COLUMN IF NOT EXISTS '+column+' uuid');
  }
  await db.exec(readFileSync(new URL('./business-organization.sql',import.meta.url),'utf8'));
  for(const [table,parents] of plans){
   const args=parents.flat().map(value=>"'"+value+"'").join(', ');
   await db.exec('CREATE TRIGGER a10_working_organization_insert BEFORE INSERT OR UPDATE OF '+['organization_id',...parents.map(([column])=>column)].join(', ')+' ON public.'+table+' FOR EACH ROW EXECUTE FUNCTION app_private.fill_business_organization_v1('+args+')');
  }
  const snapshot={columns:(await db.query('SELECT table_schema,table_name,column_name FROM information_schema.columns')).rows};
  const receipt=await verifyBusinessOrganization(db,snapshot,{orgA,orgB,actor:admin,verifySettings:false});
  assert.equal(receipt.businessTablesVerified,13);
  const businessBody=readFileSync(new URL('./business-organization.sql',import.meta.url),'utf8');
  const parentGuard='IF v_org IS NOT NULL AND v_org<>v_parent THEN';
  assert.ok(businessBody.includes(parentGuard));
  await db.exec(businessBody.replace(parentGuard,'IF false THEN'));
  await assert.rejects(verifyBusinessOrganization(db,snapshot,{orgA,orgB,actor:admin,verifySettings:false}),/Missing expected rejection/,
    'Removing the parent/company guard must fail the behavioral assertion');
  await db.exec(businessBody);
  for(const role of ['anon','authenticated','service_role'])assert.equal((await db.query("SELECT has_function_privilege($1,'app_private.fill_business_organization_v1()','EXECUTE') allowed",[role])).rows[0].allowed,false);
 }finally{await db.close();}
});


test('salary trigger prioritizes the stored period and fails closed for ambiguous background staff',async()=>{
 const db=await setup();try{
  const body=readFileSync(new URL('./salary-organization-body.sql',import.meta.url),'utf8');
  await db.exec('CREATE FUNCTION public._autofill_org_salary() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $body$'+body+'$body$');
  await db.exec('CREATE TABLE salary_adjustments(id uuid DEFAULT gen_random_uuid(),salary_monthly_id uuid,organization_id uuid)');
  await db.exec('CREATE TRIGGER salary_org BEFORE INSERT ON salary_monthly FOR EACH ROW EXECUTE FUNCTION public._autofill_org_salary()');
  await db.exec('CREATE TRIGGER adjustment_org BEFORE INSERT ON salary_adjustments FOR EACH ROW EXECUTE FUNCTION public._autofill_org_salary()');
  const monthly='00000000-0000-4000-8090-000000000001';
  await db.query('INSERT INTO salary_monthly(id,staff_id,period_month,organization_id) VALUES($1,$2,$3,$4)',[monthly,staff,'2026-08-01',orgA]);
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.headers',$2,false)",[admin,JSON.stringify({'x-ihomecrm-organization-id':orgB})]);
  const historical=(await db.query('INSERT INTO salary_adjustments(salary_monthly_id) VALUES($1) RETURNING organization_id',[monthly])).rows[0];
  assert.equal(historical.organization_id,orgA);
  await assert.rejects(db.query('INSERT INTO salary_adjustments(salary_monthly_id,organization_id) VALUES($1,$2)',[monthly,orgB]),/không khớp/);
  await assert.rejects(db.query('INSERT INTO salary_monthly(staff_id,period_month,organization_id) VALUES($1,$2,$3)',[staff,'2026-08-01',orgB]),/không khớp/);
  await db.query('INSERT INTO organization_memberships(user_id,organization_id,status) VALUES($1,$2,$3)',[staff,orgB,'ACTIVE']);
  await db.query('INSERT INTO manager_salary_config(staff_id,organization_id,is_active,effective_from) VALUES($1,$2,true,$3),($1,$4,true,$3)',[staff,orgA,'2026-01-01',orgB]);
  const chosen=(await db.query('INSERT INTO salary_monthly(staff_id,period_month) VALUES($1,$2) RETURNING organization_id',[staff,'2026-09-01'])).rows[0];
  assert.equal(chosen.organization_id,orgB);
  await db.query("SELECT set_config('request.jwt.claim.sub','',false),set_config('request.headers','{}',false)");
  await assert.rejects(db.query('INSERT INTO salary_monthly(staff_id,period_month) VALUES($1,$2)',[staff,'2026-10-01']),/nhiều công ty/);
  const explicit=(await db.query('INSERT INTO salary_monthly(staff_id,period_month,organization_id) VALUES($1,$2,$3) RETURNING organization_id',[staff,'2026-10-01',orgA])).rows[0];
  assert.equal(explicit.organization_id,orgA,'Background writers can retain explicit provenance');
 }finally{await db.close();}
});


test('company member visibility cannot borrow permission from another organization',async()=>{
 const db=await setup();try{
  await db.exec(readFileSync(new URL('./member-visibility-fixture.sql',import.meta.url),'utf8'));
  const review=readFileSync(new URL('./organization.review.sql',import.meta.url),'utf8');
  const header='CREATE OR REPLACE FUNCTION app_private.has_any_scope_for_org_v1(p_permission_key text, p_org uuid)';
  const start=review.indexOf(header),end=review.indexOf('$function$;',start);
  assert.ok(start>=0&&end>start,'Reviewed company permission helper must exist');
  const scoped=review.slice(start,end+'$function$;'.length);
  const condition='\n       and m.organization_id = p_org';
  assert.equal(scoped.split(condition).length,2);
  const legacy=scoped.replace('has_any_scope_for_org_v1(p_permission_key text, p_org uuid)','has_any_scope_v3(p_permission_key text)').replace(condition,'');
  await db.exec(legacy);
  await db.exec(scoped+"\nREVOKE ALL ON FUNCTION app_private.has_any_scope_for_org_v1(text,uuid) FROM PUBLIC,anon,authenticated,service_role;");
  const receipt=await verifyMemberVisibility(db,{orgA,orgB,actor:admin,withAdminResolver:false});
  assert.equal(receipt.memberVisibilityCompanyScoped,true);
  await db.exec(scoped.replace(condition,''));
  await assert.rejects(verifyMemberVisibility(db,{orgA,orgB,actor:admin,withAdminResolver:false}),
    error=>error.code==='ERR_ASSERTION'&&error.message.includes('Permission in A'),
    'Removing the company witness must fail the behavioral assertion');
 }finally{await db.close();}
});
