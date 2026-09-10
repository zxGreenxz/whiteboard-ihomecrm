import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setup,org,otherOrg,owner,staff,outsider} from '../attachment-access/test-fixture.mjs';
async function fixture(){
 const db=await setup();
 await db.exec(`CREATE ROLE service_role;
 ALTER TABLE public.organization_memberships ADD valid_from timestamptz,ADD valid_to timestamptz;
 CREATE TABLE public.organizations(id uuid PRIMARY KEY,status text);
 INSERT INTO public.organizations VALUES('${org}','ACTIVE'),('${otherOrg}','ACTIVE');
 CREATE TABLE public.salary_monthly(staff_id uuid,period_month date,organization_id uuid);
 CREATE TABLE public.manager_salary_config(staff_id uuid,organization_id uuid,is_active boolean,effective_from date,effective_to date);
 CREATE TABLE public.accounts(id uuid,organization_id uuid,deleted_at timestamptz);
 ALTER TABLE public.finance_evidence_objects ADD uploader_user_id uuid;
 ALTER TABLE storage.objects ADD user_metadata jsonb;
 ${readFileSync(new URL('./working-organization.sql',import.meta.url),'utf8')}
 CREATE FUNCTION app_private.storage_object_link_maintain() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,app_private,public AS $body$${readFileSync(new URL('./storage-upload-body.sql',import.meta.url),'utf8')}$body$;
 CREATE TRIGGER link_upload BEFORE INSERT ON storage.objects FOR EACH ROW EXECUTE FUNCTION app_private.storage_object_link_maintain();`);
 return db;
}
async function upload(db,user,name,company,bucket='income-expense-attachments'){
 await db.query(`INSERT INTO storage.objects(id,bucket_id,name,owner_id,user_metadata) VALUES(gen_random_uuid(),$1,$2,$3,$4)`,
  [bucket,name,user,JSON.stringify(company===undefined?{}:{ihomecrm_organization_id:company})]);
 return (await db.query('SELECT organization_id,owner_user_id,derivation FROM app_private.storage_object_links WHERE bucket_id=$1 AND object_name=$2',[bucket,name])).rows[0];
}
test('all seven private upload buckets bind explicit valid company and preserve old single-company clients',async()=>{
 const db=await fixture();try{
  for(const bucket of ['customer-id-cards','customer-images','income-expense-attachments','job-attachments','payment-receipts','meter-images','document-templates']){
   assert.equal((await upload(db,owner,owner+'/selected.webp',otherOrg,bucket)).organization_id,otherOrg);
   assert.equal((await upload(db,staff,staff+'/legacy.webp',undefined,bucket)).organization_id,org);
   assert.equal((await upload(db,owner,owner+'/legacy.webp',undefined,bucket)).organization_id,null);
  }
  assert.equal(await upload(db,owner,owner+'/avatar.webp',otherOrg,'avatars'),undefined);
 }finally{await db.close();}
});
test('explicit metadata cannot bypass active membership or reclassify an existing path',async()=>{
 const db=await fixture();try{
  await assert.rejects(upload(db,staff,staff+'/foreign.webp',otherOrg),/không còn quyền/);
  await db.exec(`UPDATE organization_memberships SET valid_to=now()-interval '1 second' WHERE user_id='${owner}' AND organization_id='${otherOrg}'`);
  await assert.rejects(upload(db,owner,owner+'/expired.webp',otherOrg),/không còn quyền/);
  await assert.rejects(upload(db,owner,owner+'/invalid.webp','invalid'),/uuid/);
  const path=owner+'/retained.webp';
  await upload(db,owner,path,org);
  await db.query('DELETE FROM storage.objects WHERE name=$1',[path]);
  await assert.rejects(upload(db,outsider,path,otherOrg),/đã thuộc/);
  assert.equal((await db.query('SELECT organization_id FROM app_private.storage_object_links WHERE object_name=$1',[path])).rows[0].organization_id,org);
 }finally{await db.close();}
});
test('server-issued v2 intent takes precedence and checks its uploader and metadata',async()=>{
 const db=await fixture();try{
  const path='v2/'+otherOrg+'/member/intent';
  await db.query(`INSERT INTO finance_evidence_objects(bucket_id,object_name,organization_id,state,uploader_user_id) VALUES('income-expense-attachments',$1,$2,'UPLOAD_INTENT',$3)`,[path,otherOrg,owner]);
  await assert.rejects(upload(db,outsider,path,otherOrg),/Người tải không khớp/);
  await assert.rejects(upload(db,owner,path,org),/Công ty ảnh không khớp/);
  const result=await upload(db,owner,path);
  assert.deepEqual(result,{organization_id:otherOrg,owner_user_id:owner,derivation:'finance-intent'});
 }finally{await db.close();}
});

test('quarantined and conflicting cross-company evidence cannot classify a new object',async()=>{
 const db=await fixture();try{
  const path=owner+'/conflicting.webp';
  await db.query(`INSERT INTO finance_evidence_objects(bucket_id,object_name,organization_id,state,uploader_user_id)
    VALUES('income-expense-attachments',$1,$2,'ATTACHED',$4),('income-expense-attachments',$1,$3,'ATTACHED',$4)`,[path,org,otherOrg,owner]);
  await assert.rejects(upload(db,owner,path,org),/mâu thuẫn công ty/);
  await db.query('DELETE FROM finance_evidence_objects WHERE object_name=$1 AND organization_id=$2',[path,otherOrg]);
  await db.query("UPDATE finance_evidence_objects SET state='QUARANTINED' WHERE object_name=$1",[path]);
  await assert.rejects(upload(db,owner,path,org),/cách ly/);
  assert.equal((await db.query('SELECT count(*) n FROM storage.objects WHERE name=$1',[path])).rows[0].n,0);
 }finally{await db.close();}
});
