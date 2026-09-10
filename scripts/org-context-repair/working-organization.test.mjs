import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
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
