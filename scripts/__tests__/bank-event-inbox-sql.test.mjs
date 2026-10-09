import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const SUPER='10000000-0000-4000-8000-000000000001';
const OWNER='10000000-0000-4000-8000-000000000002';
const DEVICE='20000000-0000-4000-8000-000000000001';
const OTHER_DEVICE='20000000-0000-4000-8000-000000000002';
const migration=await readFile(new URL('../../supabase/migrations/20261009042140_bank_event_raw_inbox.sql',import.meta.url),'utf8');

test('bank event SQL ACL, credentials, atomic deduplication and global admin inbox',async(t)=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  CREATE SCHEMA auth; CREATE SCHEMA app_private;
  CREATE TABLE public.organizations(id uuid PRIMARY KEY);
  CREATE TABLE public.super_admins(user_id uuid PRIMARY KEY);
  INSERT INTO public.super_admins VALUES ('${SUPER}');
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
  CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS(SELECT 1 FROM public.super_admins WHERE user_id=auth.uid()) $$;
  GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;`);
 await db.exec(migration);await db.exec(migration);
 async function roleCall(role,user,work){
  await db.exec(`BEGIN; SET LOCAL ROLE ${role};`);
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[user??'']);
  try{const value=await work();await db.exec('COMMIT');return value;}catch(error){await db.exec('ROLLBACK');throw error;}
 }
 const admin=(action,input={},user=SUPER)=>roleCall('authenticated',user,async()=>
  (await db.query('SELECT public.bank_event_admin_v1($1,$2::jsonb) AS data',[action,JSON.stringify(input)])).rows[0].data);
 const args=(overrides={})=>({digest:'a'.repeat(64),externalId:'b'.repeat(64),deviceId:DEVICE,type:'sms.received',at:'2026-10-09T01:02:03Z',hash:'c'.repeat(64),cipher:'X'.repeat(40),nonce:'a'.repeat(16),key:'v1',heartbeat:null,...overrides});
 const ingest=(input=args(),role='service_role')=>roleCall(role,null,async()=>
  (await db.query('SELECT public.bank_event_ingest_v1($1,$2,$3::uuid,$4,$5::timestamptz,$6,$7,$8,$9,$10::jsonb) AS data',[
   input.digest,input.externalId,input.deviceId,input.type,input.at,input.hash,input.cipher,input.nonce,input.key,JSON.stringify(input.heartbeat),
  ])).rows[0].data);
 let source,event;
 await t.test('anonymous/member/company-owner cannot read or manage; service token cannot act as super admin',async()=>{
  for(const role of ['anon','authenticated','service_role'])await assert.rejects(roleCall(role,OWNER,()=>db.query('SELECT * FROM app_private.bank_inbound_events')),e=>e.code==='42501');
  await assert.rejects(admin('list_sources',{},OWNER),e=>e.code==='42501');
  await assert.rejects(roleCall('anon',null,()=>db.query("SELECT public.bank_event_admin_v1('status','{}')")),e=>e.code==='42501');
  await assert.rejects(roleCall('service_role',SUPER,()=>db.query("SELECT public.bank_event_admin_v1('status','{}')")),e=>e.code==='42501');
  await assert.rejects(ingest(args(),'authenticated'),e=>e.code==='42501');
 });
 await t.test('global admin creates source, only digest is stored and source is unbound',async()=>{
  const result=await admin('create_source',{name:'DEMO nguồn A',credentialDigest:'a'.repeat(64),fingerprint:'sha256:'+('a'.repeat(12))});
  source=result.source;assert.equal(source.deviceId,null);assert.equal(source.organizationId,null);
  assert.equal('digest'in source,false);assert.equal('token'in source,false);
  assert.equal((await admin('list_sources')).sources.length,1);
 });
 await t.test('receipt follows committed insert, duplicate is durable, collisions do not overwrite',async()=>{
  event=await ingest();assert.equal(event.status,'accepted');assert.equal(event.sourceId,source.id);assert.equal(event.externalId,'b'.repeat(64));
  const duplicate=await ingest();assert.equal(duplicate.status,'duplicate');assert.equal(duplicate.eventId,event.eventId);
  await assert.rejects(ingest(args({hash:'d'.repeat(64)})),e=>e.code==='PT409');
  await assert.rejects(ingest(args({deviceId:OTHER_DEVICE})),e=>e.code==='PT409');
  const result=await admin('list_events');assert.equal(result.events.length,1);assert.equal(result.events[0].duplicateCount,1);
  assert.equal('ciphertext'in result.events[0],false);assert.equal('payload'in result.events[0],false);
 });
 await t.test('heartbeat updates liveness without adding raw event; all filters/cursor use metadata',async()=>{
  const result=await ingest(args({type:'gateway.heartbeat',externalId:'e'.repeat(64),heartbeat:{smsEnabled:true,receivedAt:'2026-10-09T01:02:03Z'}}));
  assert.equal(result.status,'heartbeat');assert.equal(result.eventId,null);
  const sources=await admin('list_sources');assert.equal(sources.sources[0].deviceId,DEVICE);assert.ok(sources.sources[0].lastSeenAt);
  await ingest(args({type:'gateway.heartbeat',at:'2026-10-08T01:02:03Z',heartbeat:{smsEnabled:false,receivedAt:'2026-10-08T01:02:03Z'}}));
  assert.equal((await admin('list_sources')).sources[0].heartbeat.smsEnabled,true);
  assert.equal((await admin('status')).totalEvents,1);
  assert.equal((await admin('list_events',{sourceId:source.id,query:'nguồn',eventType:'sms.received'})).events.length,1);
  assert.equal((await admin('list_events',{query:'missing'})).events.length,0);
  const row=(await admin('list_events')).events[0];assert.equal((await admin('list_events',{beforeTime:row.receivedAt,beforeId:row.id})).events.length,0);
 });
 await t.test('raw ciphertext access is admin gated and audited; no payment tables are involved',async()=>{
  await assert.rejects(admin('get_event',{eventId:event.eventId},OWNER),e=>e.code==='42501');
  const detail=await admin('get_event',{eventId:event.eventId});assert.equal(detail.ciphertext,'X'.repeat(40));
  assert.equal((await db.query("SELECT count(*)::int AS n FROM app_private.bank_event_audit WHERE action='read_event'")).rows[0].n,1);
  assert.equal((await db.query("SELECT to_regclass('public.payments') AS t")).rows[0].t,null);
 });
 await t.test('pause, resume, rotation and permanent revoke apply to the next request without cache',async()=>{
  await admin('set_source_enabled',{sourceId:source.id,enabled:false});
  await assert.rejects(ingest(),e=>e.code==='28000');
  await admin('set_source_enabled',{sourceId:source.id,enabled:true});assert.equal((await ingest()).status,'duplicate');
  await admin('rotate_source',{sourceId:source.id,credentialDigest:'f'.repeat(64),fingerprint:'sha256:'+('f'.repeat(12))});
  await assert.rejects(ingest(),e=>e.code==='28000');
  assert.equal((await ingest(args({digest:'f'.repeat(64)}))).status,'duplicate');
  await admin('revoke_source',{sourceId:source.id});
  await assert.rejects(ingest(args({digest:'f'.repeat(64)})),e=>e.code==='28000');
  await assert.rejects(admin('set_source_enabled',{sourceId:source.id,enabled:true}),e=>e.code==='PT409');
 });
 await t.test('independent sources may reuse transport ids without merging their raw events',async()=>{
  const second=(await admin('create_source',{name:'DEMO nguồn B',credentialDigest:'9'.repeat(64),fingerprint:'sha256:'+('9'.repeat(12))})).source;
  const receipt=await ingest(args({digest:'9'.repeat(64),deviceId:OTHER_DEVICE}));
  assert.equal(receipt.status,'accepted');assert.equal(receipt.sourceId,second.id);assert.notEqual(receipt.eventId,event.eventId);
  assert.equal((await admin('status')).totalEvents,2);
  const detail=(await admin('list_events',{sourceId:second.id})).events;
  assert.equal(detail.length,1);assert.equal(detail[0].deviceId,OTHER_DEVICE);
 });
});
