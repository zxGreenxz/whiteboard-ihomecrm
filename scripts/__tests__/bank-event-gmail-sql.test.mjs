import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const SUPER='10000000-0000-4000-8000-000000000001';
const OWNER='10000000-0000-4000-8000-000000000002';
const PHONE='20000000-0000-4000-8000-000000000001';
const SCRIPT='20000000-0000-4000-8000-000000000002';
const read=name=>readFile(new URL(`../../supabase/migrations/${name}`,import.meta.url),'utf8');
const base=await read('20261009042140_bank_event_raw_inbox.sql');
const gmail=await read('20261009103855_bank_event_gmail_nguon_va_tom_tat.sql');

test('Gmail sources, kind-bound ingest and admin summaries on top of the raw inbox',async(t)=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  CREATE SCHEMA auth; CREATE SCHEMA app_private;
  CREATE TABLE public.organizations(id uuid PRIMARY KEY);
  CREATE TABLE public.super_admins(user_id uuid PRIMARY KEY);
  INSERT INTO public.super_admins VALUES ('${SUPER}');
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
  CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS(SELECT 1 FROM public.super_admins WHERE user_id=auth.uid()) $$;
  GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;`);
 await db.exec(base);
 async function roleCall(role,user,work){
  await db.exec(`BEGIN; SET LOCAL ROLE ${role};`);
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[user??'']);
  try{const value=await work();await db.exec('COMMIT');return value;}catch(error){await db.exec('ROLLBACK');throw error;}
 }
 const admin=(action,input={},user=SUPER)=>roleCall('authenticated',user,async()=>
  (await db.query('SELECT public.bank_event_admin_v1($1,$2::jsonb) AS data',[action,JSON.stringify(input)])).rows[0].data);
 const args=(overrides={})=>({digest:'a'.repeat(64),externalId:'b'.repeat(64),deviceId:PHONE,type:'sms.received',at:'2026-10-09T01:02:03Z',hash:'c'.repeat(64),cipher:'X'.repeat(40),nonce:'a'.repeat(16),key:'v1',heartbeat:null,...overrides});
 const ingest=(input=args())=>roleCall('service_role',null,async()=>
  (await db.query('SELECT public.bank_event_ingest_v1($1,$2,$3::uuid,$4,$5::timestamptz,$6,$7,$8,$9,$10::jsonb) AS data',[
   input.digest,input.externalId,input.deviceId,input.type,input.at,input.hash,input.cipher,input.nonce,input.key,JSON.stringify(input.heartbeat),
  ])).rows[0].data);
 const credential=char=>({credentialDigest:char.repeat(64),fingerprint:'sha256:'+char.repeat(12)});

 // Dữ liệu có sẵn trên production trước migration: một điện thoại và một tin.
 const phone=(await admin('create_source',{name:'DEMO điện thoại',...credential('a')})).source;
 const sms=await ingest();assert.equal(sms.status,'accepted');
 await db.exec(gmail);await db.exec(gmail);

 await t.test('existing sources become android and keep their events; kind is constrained',async()=>{
  const sources=(await admin('list_sources')).sources;
  assert.equal(sources.length,1);assert.equal(sources[0].id,phone.id);assert.equal(sources[0].kind,'android');
  assert.equal((await admin('status')).totalEvents,1);
  await assert.rejects(db.query("UPDATE app_private.bank_event_sources SET kind='imap'"),e=>e.code==='23514');
  await assert.rejects(admin('create_source',{name:'Sai loại',kind:'imap',...credential('d')}),e=>e.code==='22023');
  await assert.rejects(db.query(`INSERT INTO app_private.bank_inbound_events(source_id,external_id,device_id,event_type,occurred_at,payload_hash,ciphertext,nonce,key_id)
   VALUES('${phone.id}','${'e'.repeat(64)}','${PHONE}','mail.unknown',now(),'${'c'.repeat(64)}','${'X'.repeat(40)}','${'a'.repeat(16)}','v1')`),e=>e.code==='23514');
 });
 let mailbox,email;
 await t.test('gmail source accepts only email, test and gmail heartbeat',async()=>{
  mailbox=(await admin('create_source',{name:'DEMO Gmail',kind:'gmail',...credential('9')})).source;
  assert.equal(mailbox.kind,'gmail');assert.equal(mailbox.deviceId,null);
  const mail=(overrides={})=>args({digest:'9'.repeat(64),deviceId:SCRIPT,type:'email.received',externalId:'f'.repeat(64),...overrides});
  email=await ingest(mail());assert.equal(email.status,'accepted');assert.equal(email.sourceId,mailbox.id);
  assert.equal((await ingest(mail())).status,'duplicate');
  await assert.rejects(ingest(mail({type:'sms.received',externalId:'1'.repeat(64)})),e=>e.code==='42501');
  await assert.rejects(ingest(mail({type:'notification.received',externalId:'1'.repeat(64)})),e=>e.code==='42501');
  assert.equal((await ingest(mail({type:'gateway.test',externalId:'2'.repeat(64)}))).status,'accepted');
  const heartbeat={channel:'gmail',appVersion:'gmail-script-1',schedule:'day-1m',usedSecondsToday:12,receivedAt:'2026-10-09T01:02:03Z'};
  assert.equal((await ingest(mail({type:'gateway.heartbeat',externalId:'3'.repeat(64),heartbeat}))).status,'heartbeat');
  await assert.rejects(ingest(mail({type:'gateway.heartbeat',externalId:'4'.repeat(64),heartbeat:{smsEnabled:true,receivedAt:'2026-10-09T01:02:04Z'}})),e=>e.code==='42501');
  const listed=(await admin('list_sources')).sources.find(source=>source.id===mailbox.id);
  assert.equal(listed.deviceId,SCRIPT);assert.equal(listed.heartbeat.schedule,'day-1m');
 });
 await t.test('android credentials cannot submit email or gmail heartbeats',async()=>{
  await assert.rejects(ingest(args({type:'email.received',externalId:'5'.repeat(64)})),e=>e.code==='42501');
  await assert.rejects(ingest(args({type:'gateway.heartbeat',externalId:'6'.repeat(64),heartbeat:{channel:'gmail',receivedAt:'2026-10-09T01:02:03Z'}})),e=>e.code==='42501');
  assert.equal((await ingest(args({type:'gateway.heartbeat',externalId:'7'.repeat(64),heartbeat:{smsEnabled:true,receivedAt:'2026-10-09T01:02:03Z'}}))).status,'heartbeat');
 });
 await t.test('ciphertext enters the list only on explicit request and is audited at most every 10 minutes',async()=>{
  const plain=(await admin('list_events')).events;
  assert.equal(plain.length,3);assert.equal('ciphertext'in plain[0],false);
  const withPayload=(await admin('list_events',{withPayload:true})).events;
  assert.ok(withPayload.every(row=>row.ciphertext==='X'.repeat(40)&&row.nonce==='a'.repeat(16)&&row.keyId==='v1'&&row.payloadHash==='c'.repeat(64)));
  await admin('list_events',{withPayload:true});
  const audits=async()=>(await db.query("SELECT detail FROM app_private.bank_event_audit WHERE action='list_event_summaries' ORDER BY id")).rows.map(row=>row.detail);
  assert.deepEqual(await audits(),[{filters:{limit:25},count:3}]);
  // Bộ lọc hay trang khác là một lần đọc khác: phải để lại dấu vết riêng kèm số tin.
  const last=withPayload.at(-1);
  await admin('list_events',{withPayload:true,eventType:'email.received'});
  await admin('list_events',{withPayload:true,beforeTime:last.receivedAt,beforeId:last.id});
  const trail=await audits();
  assert.equal(trail.length,3);assert.deepEqual(trail[1],{filters:{limit:25,eventType:'email.received'},count:1});
  assert.equal(trail[2].filters.beforeId,last.id);assert.equal(trail[2].count,0);
  await assert.rejects(admin('list_events',{withPayload:'yes'}),e=>e.code==='22023');
  await assert.rejects(admin('list_events',{withPayload:true},OWNER),e=>e.code==='42501');
  const emails=(await admin('list_events',{eventType:'email.received'})).events;
  assert.deepEqual(emails.map(row=>row.id),[email.eventId]);
 });
 await t.test('rotating a gmail key unbinds the old script; rotating a phone key keeps its device',async()=>{
  await admin('rotate_source',{sourceId:mailbox.id,...credential('8')});
  assert.equal((await admin('list_sources')).sources.find(source=>source.id===mailbox.id).deviceId,null);
  const NEW_SCRIPT='20000000-0000-4000-8000-000000000003';
  const fresh=await ingest(args({digest:'8'.repeat(64),deviceId:NEW_SCRIPT,type:'email.received',externalId:'0'.repeat(64)}));
  assert.equal(fresh.status,'accepted');
  await assert.rejects(ingest(args({digest:'9'.repeat(64),deviceId:SCRIPT,type:'email.received',externalId:'1'.repeat(64)})),e=>e.code==='28000');
  await admin('rotate_source',{sourceId:phone.id,...credential('7')});
  assert.equal((await admin('list_sources')).sources.find(source=>source.id===phone.id).deviceId,PHONE);
 });
 await t.test('anonymous and service roles still cannot call the admin surface',async()=>{
  await assert.rejects(roleCall('anon',null,()=>db.query("SELECT public.bank_event_admin_v1('list_events','{\"withPayload\":true}')")),e=>e.code==='42501');
  await assert.rejects(roleCall('service_role',SUPER,()=>db.query("SELECT public.bank_event_admin_v1('list_sources','{}')")),e=>e.code==='42501');
  await assert.rejects(roleCall('authenticated',SUPER,()=>db.query("SELECT public.bank_event_ingest_v1(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)")),e=>e.code==='42501');
 });
});
