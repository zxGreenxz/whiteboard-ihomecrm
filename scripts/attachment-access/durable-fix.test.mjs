import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup, org, otherOrg, owner, staff, outsider, bucket, prefix, evidence, readable, commitForDisposableTest, fingerprint } from './test-fixture.mjs';

const draft=readFileSync(new URL('./durable-fix.review.sql',import.meta.url),'utf8');
function rpcFromMigration(file,name,tag){
  const sql=readFileSync(new URL(`../../supabase/migrations/${file}`,import.meta.url),'utf8');
  const start=sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const end=sql.indexOf(tag+';',sql.indexOf(tag,start)+tag.length)+tag.length+1;
  assert.ok(start>=0&&end>start);
  return sql.slice(start,end);
}
const adopt=rpcFromMigration('20260725050000_adopt_voucher_attachment_as_evidence.sql','adopt_voucher_attachments_as_evidence_v2','$fn$');
const finalize=rpcFromMigration('20260723210000_finance_v2_evidence_rpcs.sql','finalize_finance_evidence_v2','$fn$');
async function financeSetup(){
  const db=await setup();
  try {
    await db.exec(`CREATE ROLE service_role;
      CREATE TABLE public.organizations(id uuid,status text);
      INSERT INTO public.organizations VALUES('${org}','ACTIVE'),('${otherOrg}','ACTIVE');
      ALTER TABLE public.organization_memberships ADD COLUMN valid_from timestamptz;
      ALTER TABLE public.organization_memberships ADD COLUMN valid_to timestamptz;
      ${readFileSync(new URL('../org-context-repair/working-organization.sql',import.meta.url),'utf8')}
      ALTER TABLE storage.objects ADD COLUMN metadata jsonb DEFAULT '{"size":1000,"mimetype":"image/webp"}';
      ALTER TABLE public.finance_evidence_objects ADD COLUMN id uuid DEFAULT gen_random_uuid();
      ALTER TABLE public.finance_evidence_objects ADD COLUMN uploader_user_id uuid;
      ALTER TABLE public.finance_evidence_objects ADD COLUMN uploader_membership_id uuid;
      ALTER TABLE public.finance_evidence_objects ADD COLUMN provenance_kind text;
      ALTER TABLE public.finance_evidence_objects ADD COLUMN finalized_at timestamptz;
      ALTER TABLE public.finance_evidence_objects ADD COLUMN byte_size bigint;
      ALTER TABLE public.finance_evidence_objects ADD COLUMN mime_type text;
      ALTER TABLE public.finance_evidence_objects ADD UNIQUE(organization_id,bucket_id,object_name);
      DELETE FROM public.finance_evidence_objects;
      CREATE FUNCTION app_private.ie_compat_actor_v2(p_org uuid) RETURNS TABLE(membership_id uuid,user_id uuid)
      LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT auth.uid(),auth.uid() FROM public.organization_memberships WHERE user_id=auth.uid() AND organization_id=p_org AND status='ACTIVE'$$;
      ${adopt}
      ${finalize}
      REVOKE ALL ON FUNCTION public.adopt_voucher_attachments_as_evidence_v2(uuid) FROM PUBLIC;
      REVOKE ALL ON FUNCTION public.finalize_finance_evidence_v2(uuid) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.adopt_voucher_attachments_as_evidence_v2(uuid),public.finalize_finance_evidence_v2(uuid) TO authenticated;`);
    return db;
  }catch(e){await db.close();throw e;}
}
async function call(db,user,sql,args){
  await db.exec(`SELECT set_config('request.jwt.claim.sub','${user}',false); SET ROLE authenticated;`);
  try{return (await db.query(sql,args)).rows;}finally{await db.exec('RESET ROLE');}
}
const doAdopt=(db,user=owner)=>call(db,user,'SELECT public.adopt_voucher_attachments_as_evidence_v2($1) result',[evidence[0].vouchers[0].id]);
const getLink=async db=>(await db.query('SELECT * FROM app_private.storage_object_links WHERE object_name=$1',[evidence[0].object_name])).rows[0];
const functionCatalog=async db=>(await db.query(`SELECT oid::regprocedure::text signature,proacl,prosecdef,proconfig,provolatile FROM pg_proc WHERE oid IN ('public.adopt_voucher_attachments_as_evidence_v2(uuid)'::regprocedure,'public.finalize_finance_evidence_v2(uuid)'::regprocedure) ORDER BY signature`)).rows;

test('durable fix reproduces the old conflict bug and recovers it through the existing adoption RPC',async()=>{
  const db=await financeSetup();try{
    await doAdopt(db);
    assert.equal((await getLink(db)).organization_id,null,'old RPC leaves the upload link quarantined');
    assert.deepEqual(await readable(db,staff),[]);
    const policies=await fingerprint(db);
    const catalog=await functionCatalog(db);
    const voucher=(await db.query('SELECT * FROM public.income_expenses ORDER BY id')).rows;
    await db.exec(commitForDisposableTest(draft));
    await db.exec(commitForDisposableTest(draft));
    await doAdopt(db);
    assert.equal((await getLink(db)).organization_id,org);
    assert.equal((await getLink(db)).owner_user_id,owner);
    assert.deepEqual(await readable(db,staff),[evidence[0].object_name]);
    assert.deepEqual(await readable(db,outsider),[]);
    assert.deepEqual((await db.query('SELECT * FROM public.income_expenses ORDER BY id')).rows,voucher);
    assert.equal((await db.query('SELECT count(*)::int n FROM public.finance_evidence_objects')).rows[0].n,1);
    assert.deepEqual(await fingerprint(db),policies);
    assert.deepEqual(await functionCatalog(db),catalog,'ACL, volatility, definer and search_path of public RPCs are unchanged');
    for(const role of ['anon','authenticated','service_role']){
      assert.equal((await db.query("SELECT has_function_privilege($1,'app_private.bind_finance_storage_org_v1(uuid,text,text)','EXECUTE') allowed",[role])).rows[0].allowed,false);
    }
  }finally{await db.close();}
});

test('durable fix binds direct upload finalization to its validated organization',async()=>{
  const db=await financeSetup();try{
    await db.exec(commitForDisposableTest(draft));
    const id=(await db.query("INSERT INTO public.finance_evidence_objects(bucket_id,object_name,organization_id,state,uploader_user_id) VALUES($1,$2,$3,'UPLOAD_INTENT',$4) RETURNING id",[bucket,evidence[0].object_name,org,owner])).rows[0].id;
    await call(db,owner,'SELECT public.finalize_finance_evidence_v2($1)',[id]);
    assert.equal((await getLink(db)).organization_id,org);
    assert.equal((await db.query('SELECT state FROM public.finance_evidence_objects WHERE id=$1',[id])).rows[0].state,'FINALIZED');
    await call(db,owner,'SELECT public.finalize_finance_evidence_v2($1)',[id]);
    assert.equal((await getLink(db)).owner_user_id,owner);
  }finally{await db.close();}
});

test('durable fix leaves the existing payment-receipts flow unchanged',async()=>{
  const db=await financeSetup();try{
    await db.exec(commitForDisposableTest(draft));
    const name=`${owner}/payment.webp`;
    await db.query("INSERT INTO storage.objects(id,bucket_id,name,owner,owner_id) VALUES(gen_random_uuid(),'payment-receipts',$1,$2::uuid,$2::text)",[name,owner]);
    await db.query("INSERT INTO app_private.storage_object_links VALUES ('payment-receipts',$1,NULL,$2,'quarantine',now())",[name,owner]);
    const id=(await db.query("INSERT INTO public.finance_evidence_objects(bucket_id,object_name,organization_id,state,uploader_user_id) VALUES('payment-receipts',$1,$2,'UPLOAD_INTENT',$3) RETURNING id",[name,org,owner])).rows[0].id;
    const before=(await db.query("SELECT * FROM app_private.storage_object_links WHERE bucket_id='payment-receipts'")).rows;
    await call(db,owner,'SELECT public.finalize_finance_evidence_v2($1)',[id]);
    assert.deepEqual((await db.query("SELECT * FROM app_private.storage_object_links WHERE bucket_id='payment-receipts'")).rows,before);
    assert.equal((await db.query('SELECT state FROM public.finance_evidence_objects WHERE id=$1',[id])).rows[0].state,'FINALIZED');
  }finally{await db.close();}
});

test('already attached or finalized proofs recover their storage link without changing evidence state',async()=>{
 for(const state of ['ATTACHED','FINALIZED']){
  const db=await financeSetup();try{
   const x=evidence[0];
   const id=(await db.query('INSERT INTO public.finance_evidence_objects(bucket_id,object_name,organization_id,state,uploader_user_id) VALUES($1,$2,$3,$4,$5) RETURNING id',[bucket,x.object_name,org,state,owner])).rows[0].id;
   await db.exec(commitForDisposableTest(draft));
   if(state==='ATTACHED')await doAdopt(db);
   else await call(db,owner,'SELECT public.finalize_finance_evidence_v2($1)',[id]);
   assert.equal((await getLink(db)).organization_id,org);
   assert.equal((await db.query('SELECT state FROM public.finance_evidence_objects WHERE id=$1',[id])).rows[0].state,state);
   assert.deepEqual(await readable(db,staff),[x.object_name]);
  }finally{await db.close();}
 }
});

test('v2 intent paths bind only through a matching organization and uploader proof',async()=>{
 const db=await financeSetup();try{
  await db.exec(commitForDisposableTest(draft));
  const name=`v2/${otherOrg}/${owner}/proof`;
  const id=(await db.query("INSERT INTO public.finance_evidence_objects(bucket_id,object_name,organization_id,state,uploader_user_id) VALUES($1,$2,$3,'UPLOAD_INTENT',$4) RETURNING id",[bucket,name,otherOrg,owner])).rows[0].id;
  await db.query('INSERT INTO storage.objects(id,bucket_id,name,owner,owner_id) VALUES(gen_random_uuid(),$1,$2,$3::uuid,$3::text)',[bucket,name,owner]);
  await db.query("INSERT INTO app_private.storage_object_links VALUES($1,$2,NULL,$3,'quarantine',now())",[bucket,name,owner]);
  await call(db,owner,'SELECT public.finalize_finance_evidence_v2($1)',[id]);
  assert.equal((await db.query('SELECT organization_id FROM app_private.storage_object_links WHERE object_name=$1',[name])).rows[0].organization_id,otherOrg);
  assert.deepEqual(await readable(db,staff),[]);
  assert.deepEqual(await readable(db,outsider),[name]);
 }finally{await db.close();}
});

test('creating and annotating a voucher binds newly added images in the parent transaction',async()=>{
 for(const mode of ['create','annotate']){
  const db=await financeSetup();try{
   await db.exec(commitForDisposableTest(draft));
   await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[owner]);
   const name=`${owner}/unrelated.webp`,url=prefix+name;
   const before=(await db.query('SELECT id,organization_id,amount FROM public.income_expenses ORDER BY id')).rows;
   if(mode==='create')await db.query('INSERT INTO public.income_expenses(id,organization_id,attachments) VALUES(gen_random_uuid(),$1,$2)',[otherOrg,JSON.stringify([url])]);
   else await db.query('UPDATE public.income_expenses SET attachments=attachments||$1::jsonb WHERE id=$2',[JSON.stringify([url]),evidence[0].vouchers[0].id]);
   const link=(await db.query('SELECT * FROM app_private.storage_object_links WHERE object_name=$1',[name])).rows[0];
   assert.equal(link.organization_id,mode==='create'?otherOrg:org);
   assert.equal(link.owner_user_id,owner);
   assert.equal((await db.query('SELECT count(*)::int n FROM public.finance_evidence_objects')).rows[0].n,0,'Binding is not a posting or evidence state transition');
   for(const previous of before)assert.deepEqual((await db.query('SELECT id,organization_id,amount FROM public.income_expenses WHERE id=$1',[previous.id])).rows[0],previous);
   assert.deepEqual(await readable(db,mode==='create'?outsider:staff),[name]);
  }finally{await db.close();}
 }
});

test('an attachment with foreign ownership or expired membership aborts the entire parent edit',async()=>{
 for(const changed of ['owner','expired']){
  const db=await financeSetup();try{
   await db.exec(commitForDisposableTest(draft));
   const name=`${owner}/unrelated.webp`;
   if(changed==='owner')await db.query('UPDATE storage.objects SET owner=$1::uuid,owner_id=$1::text WHERE name=$2',[outsider,name]);
   else await db.query("UPDATE public.organization_memberships SET valid_to=now()-interval '1 minute' WHERE user_id=$1 AND organization_id=$2",[owner,org]);
   const before=(await db.query('SELECT * FROM public.income_expenses ORDER BY id')).rows;
   await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[owner]);
   await assert.rejects(db.query('UPDATE public.income_expenses SET attachments=attachments||$1::jsonb WHERE id=$2',[JSON.stringify([prefix+name]),evidence[0].vouchers[0].id]),/Only the uploader|Active membership/);
   assert.deepEqual((await db.query('SELECT * FROM public.income_expenses ORDER BY id')).rows,before);
   assert.equal((await db.query('SELECT organization_id FROM app_private.storage_object_links WHERE object_name=$1',[name])).rows[0].organization_id,null);
  }finally{await db.close();}
 }
});

test('durable adoption refuses to claim another uploader’s unclassified image',async()=>{
  const db=await financeSetup();try{
    await db.exec(commitForDisposableTest(draft));
    await assert.rejects(doAdopt(db,staff),/Only the uploader/);
    assert.equal((await getLink(db)).organization_id,null);
    assert.equal((await db.query('SELECT count(*)::int n FROM public.finance_evidence_objects')).rows[0].n,0,'failed adoption leaves no partial evidence record');
    await assert.rejects(doAdopt(db,outsider),/membership active/);
  }finally{await db.close();}
});

test('durable fix preserves existing classifications and rejects conflicting financial or protected references',async()=>{
  const cases=[
    [`INSERT INTO public.finance_evidence_objects(bucket_id,object_name,organization_id,state) VALUES ('${bucket}','${evidence[0].object_name}','${otherOrg}','ATTACHED')`,/Conflicting/],
    [`INSERT INTO public.income_expenses(id,organization_id,attachments) VALUES('00000000-0000-4000-8002-000000000099','${otherOrg}','${JSON.stringify([prefix+evidence[0].object_name])}')`,/another organization/],
    [`INSERT INTO app_private.ie_supplement_objects VALUES('${bucket}','${evidence[0].object_name}')`,/Protected supplemental/],
    [`UPDATE app_private.storage_object_links SET derivation='manual_quarantine' WHERE object_name='${evidence[0].object_name}'`,/Only the uploader/],
    [`UPDATE storage.objects SET archived_at=now() WHERE name='${evidence[0].object_name}'`,/Active storage/],
  ];
  for(const [change,expected] of cases){
    const db=await financeSetup();try{
      await db.exec(change);await db.exec(commitForDisposableTest(draft));
      await assert.rejects(doAdopt(db),expected);
      assert.equal((await getLink(db)).organization_id,null);
    }finally{await db.close();}
  }
  const db=await financeSetup();try{
    await db.exec(commitForDisposableTest(draft));
    await db.query('UPDATE app_private.storage_object_links SET organization_id=$1,derivation=\'existing_verified_source\' WHERE object_name=$2',[org,evidence[0].object_name]);
    const before=await getLink(db);
    await doAdopt(db,staff);
    assert.deepEqual(await getLink(db),before,'authorized staff can reuse an already classified same-org image without rewriting its owner');
    await db.query('UPDATE app_private.storage_object_links SET organization_id=$1 WHERE object_name=$2',[otherOrg,evidence[0].object_name]);
    const foreign=await getLink(db);
    const result=await doAdopt(db);
    assert.equal(result[0].result.skipped[0].reason,'FILE_THUOC_TO_CHUC_KHAC');
    assert.deepEqual(await getLink(db),foreign);
  }finally{await db.close();}
});
