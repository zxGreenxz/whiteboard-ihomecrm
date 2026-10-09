// Real JWT, PostgREST and Edge acceptance on the separately guarded TEST project.
// Requires reviewed migration + both Edge functions already deployed to TEST.
// Creates only fresh synthetic users/sources/events and verifies cleanup under the TEST lease.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { credential, ketNoi, kiemCongCu, lit, psql, psqlJson } from './test-env/lib.mjs';
import { assertTestLease, markTestCleanupRequired, withTestCleanup, withTestLock } from './test-env/lock.mjs';

const runId=randomUUID();
const accounts=[{kind:'admin',email:`bank-inbox-admin-${runId}@example.test`},{kind:'member',email:`bank-inbox-member-${runId}@example.test`}];
const migration=new URL('../supabase/migrations/20261009042140_bank_event_raw_inbox.sql',import.meta.url);
const evidence={schemaVersion:1,runId,migrationSha256:createHash('sha256').update(readFileSync(migration)).digest('hex'),checks:[],cleanup:false};
const pass=name=>{evidence.checks.push(name);console.log(`PASS ${name}`);};

async function main(){
 kiemCongCu();const cred=credential();const {test}=await ketNoi(cred);
 if(!cred.testPublishableKey)throw new Error('TEST publishable key required.');
 const base=`https://${cred.testRef}.supabase.co`;
 evidence.testProjectRef=cred.testRef;
 await withTestLock({cred,test},async lease=>{
  const users=[];
  let uncertainRequest=false;
  async function http(path,body,{token,apikey=cred.testPublishableKey,method='POST',signal=lease.signal}={}){
   const headers={'content-type':'application/json'};
   if(path.startsWith('/rest/v1/')){headers['content-profile']='public';headers['accept-profile']='public';}
   if(token)headers.authorization=`Bearer ${token}`;
   if(apikey)headers.apikey=apikey;
   let response;
   try{response=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])});}
   catch(error){uncertainRequest=true;throw error;}
   let data;try{data=await response.json();}catch{data=null;}
   return {status:response.status,data};
  }
  const edgeAdmin=(action,input={},token=users[0]?.jwt)=>http('/functions/v1/bank-event-admin',{action,...input},{token});
  const makeEvent=(deviceId,overrides={})=>({schemaVersion:1,event:'sms.received',id:createHash('sha256').update(randomUUID()).digest('hex'),deviceId,receivedAt:new Date().toISOString(),sender:'DEMO-FIXTURE',body:'Tin thử nghiệm tổng hợp\nUnicode 😊; không có tài khoản thật.',subscriptionId:null,...overrides});
  async function ingest(payload,token){
   let response;
   try{response=await fetch(base+'/functions/v1/bank-event-ingest',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','x-idempotency-key':payload.id},body:JSON.stringify(payload),signal:AbortSignal.any([lease.signal,AbortSignal.timeout(30000)])});}
   catch(error){uncertainRequest=true;throw error;}
   let data;try{data=await response.json();}catch{data=null;}
   return {status:response.status,data};
  }
  await assertTestLease(lease,test);
  const ready=psqlJson(test,"SELECT to_regprocedure('public.bank_event_admin_v1(text,jsonb)') IS NOT NULL AS admin,to_regprocedure('public.bank_event_ingest_v1(text,text,uuid,text,timestamptz,text,text,text,text,jsonb)') IS NOT NULL AS ingest")[0];
  assert(ready.admin&&ready.ingest,'Reviewed migration must be applied to TEST before acceptance.');
  markTestCleanupRequired(lease,test);
  try{
   for(const fixture of accounts){
    await assertTestLease(lease,test);
    const password=randomBytes(32).toString('base64url');
    const created=await http('/auth/v1/admin/users',{email:fixture.email,password,email_confirm:true,user_metadata:{full_name:`BANK INBOX ${fixture.kind} FIXTURE`}},{token:cred.testSecretKey,apikey:cred.testSecretKey});
    assert.equal(created.status,200,'Synthetic auth creation must succeed.');
    assert.match(created.data.id,/^[0-9a-f-]{36}$/);
    const logged=await http('/auth/v1/token?grant_type=password',{email:fixture.email,password});
    assert.equal(logged.status,200,'Synthetic login must succeed.');
    assert.equal(typeof logged.data.access_token,'string');
    users.push({id:created.data.id,jwt:logged.data.access_token});
   }
   psql(test,`INSERT INTO public.super_admins(user_id) VALUES (${lit(users[0].id)}::uuid);`);
   const adminToken=users[0].jwt,memberToken=users[1].jwt;
   const memberStatus=await edgeAdmin('status',{},memberToken);
   if(memberStatus.status!==403){
    const permission=await http('/rest/v1/rpc/is_super_admin',{}, {token:memberToken});
    const bankPermission=await http('/rest/v1/rpc/bank_event_admin_v1',{p_action:'status',p_input:{}},{token:memberToken});
    const code=memberStatus.data?.error??memberStatus.data?.code;
    const alg=JSON.parse(Buffer.from(memberToken.split('.')[0],'base64url').toString()).alg;
    evidence.diagnostic={stage:'member_edge_status',httpStatus:memberStatus.status,
     errorCode:typeof code==='string'&&/^[A-Za-z0-9_ -]{1,64}$/.test(code)?code:null,
     jwtAlgorithm:typeof alg==='string'&&/^[A-Za-z0-9]{1,16}$/.test(alg)?alg:null,
     directPermissionStatus:permission.status,directPermissionCode:permission.data?.code??null,
     directBankPermissionStatus:bankPermission.status,directBankPermissionCode:bankPermission.data?.code??null};
   }
   assert.equal(memberStatus.status,403);
   assert.equal((await http('/rest/v1/rpc/bank_event_admin_v1',{p_action:'list_sources',p_input:{}},{token:memberToken})).status,403);
   assert([401,403].includes((await http('/rest/v1/rpc/bank_event_admin_v1',{p_action:'list_sources',p_input:{}},{token:undefined})).status));
   pass('real JWT member and anonymous callers denied at Edge/RPC');

   const created=await edgeAdmin('create_source',{name:`FIXTURE ${runId}`},adminToken);
   assert.equal(created.status,200);assert.match(created.data.data.token,/^[a-f0-9]{64}$/);
   const source=created.data.data.source;let deviceToken=created.data.data.token;const deviceId=randomUUID();
   const payload=makeEvent(deviceId);
   await assertTestLease(lease,test);
   const pairResults=await Promise.allSettled([ingest(payload,deviceToken),ingest(payload,deviceToken)]);
   assert(pairResults.every(result=>result.status==='fulfilled'),'Concurrent deliveries must settle before cleanup.');
   const pair=pairResults.map(result=>result.value);
   assert.deepEqual(pair.map(r=>r.status).sort(),[200,201]);
   assert(pair.every(r=>r.data.schemaVersion===1&&r.data.ok===true&&r.data.data.sourceId===source.id&&r.data.data.externalId===payload.id));
   assert.equal(pair[0].data.data.eventId,pair[1].data.data.eventId);
   const eventId=pair[0].data.data.eventId;
   pass('two concurrent direct HTTPS deliveries without apikey commit exactly one event');

   const listed=await edgeAdmin('list_events',{sourceId:source.id});
   assert.equal(listed.status,200);assert.equal(listed.data.data.events.length,1);
   assert.equal('body'in listed.data.data.events[0],false);assert.equal('ciphertext'in listed.data.data.events[0],false);
   assert.equal((await edgeAdmin('get_event',{eventId},memberToken)).status,403);
   const detail=await edgeAdmin('get_event',{eventId});assert.equal(detail.status,200);assert.deepEqual(detail.data.data.payload,payload);
   assert.equal(psqlJson(test,`SELECT count(*)::int AS n FROM app_private.bank_event_audit WHERE event_id=${lit(eventId)}::uuid AND action='read_event'`)[0].n,1);
   const encrypted=psqlJson(test,`SELECT ciphertext FROM app_private.bank_inbound_events WHERE id=${lit(eventId)}::uuid`)[0].ciphertext;
   assert.equal(encrypted.includes(payload.body),false);
   pass('metadata list, encrypted storage, authorized detail decryption and read audit');

   assert.equal((await ingest({...payload,body:'Khác nội dung fixture'},deviceToken)).status,409);
   assert.equal((await ingest({...payload,deviceId:randomUUID()},deviceToken)).status,409);
   assert.equal((await ingest({...payload,organizationId:randomUUID()},deviceToken)).status,400);
   await edgeAdmin('set_source_enabled',{sourceId:source.id,enabled:false});
   assert.equal((await ingest(payload,deviceToken)).status,401);
   await edgeAdmin('set_source_enabled',{sourceId:source.id,enabled:true});
   assert.equal((await ingest(payload,deviceToken)).status,200);
   const rotated=await edgeAdmin('rotate_source',{sourceId:source.id});assert.equal(rotated.status,200);
   assert.equal((await ingest(payload,deviceToken)).status,401);deviceToken=rotated.data.data.token;
   assert.equal((await ingest(payload,deviceToken)).status,200);
   pass('collision, bound device, forged attribution, pause and rotation are enforced immediately');

   const heartbeat={schemaVersion:1,event:'gateway.heartbeat',id:createHash('sha256').update(randomUUID()).digest('hex'),deviceId,receivedAt:new Date().toISOString(),smsEnabled:true,notificationsEnabled:false,notificationAccess:false,smsPermission:true,appVersion:'TEST-fixture'};
   const beat=await ingest(heartbeat,deviceToken);assert.equal(beat.status,200);assert.equal(beat.data.data.status,'heartbeat');assert.equal(beat.data.data.eventId,null);
   assert.equal((await edgeAdmin('list_events',{sourceId:source.id})).data.data.events.length,1);
   const competing=await edgeAdmin('create_source',{name:`FIXTURE RACE ${runId}`});assert.equal(competing.status,200);
   const raceToken=competing.data.data.token;
   const raceResults=await Promise.allSettled([ingest(makeEvent(randomUUID()),raceToken),ingest(makeEvent(randomUUID()),raceToken)]);
   assert(raceResults.every(result=>result.status==='fulfilled'),'Concurrent binding requests must settle before cleanup.');
   const races=raceResults.map(result=>result.value);
   assert.deepEqual(races.map(r=>r.status).sort(),[201,409]);
   assert.equal((await edgeAdmin('list_events',{sourceId:competing.data.data.source.id})).data.data.events.length,1);
   await edgeAdmin('revoke_source',{sourceId:source.id});assert.equal((await ingest(payload,deviceToken)).status,401);
   assert.equal((await edgeAdmin('set_source_enabled',{sourceId:source.id,enabled:true})).status,409);
   pass('heartbeat leaves inbox unchanged; concurrent first binding admits one device; revoke is permanent');

   const actors=users.map(user=>lit(user.id)+'::uuid').join(',');
   assert.equal(psqlJson(test,`SELECT count(*)::int AS n FROM public.payments WHERE user_id IN (${actors})`)[0].n,0);
   assert.equal(psqlJson(test,`SELECT count(*)::int AS n FROM public.income_expenses WHERE user_id IN (${actors})`)[0].n,0);
   pass('fresh fixture users created no payment or income-expense records');
  }finally{
   // A timed-out HTTP write may still be executing remotely. Preserve the lease marker
   // and fixtures for reconciliation rather than claiming cleanup while a write is uncertain.
   if(uncertainRequest)throw new Error('Remote request outcome is uncertain; TEST cleanup marker retained.');
   await withTestCleanup(lease,test,async cleanupLease=>{
    await assertTestLease(cleanupLease,test);
    const emails=accounts.map(fixture=>lit(fixture.email)).join(',');
    const fixtureIds=psqlJson(test,`SELECT id::text FROM auth.users WHERE email IN (${emails})`).map(row=>row.id);
    if(fixtureIds.length){
     const ids=fixtureIds.map(id=>lit(id)+'::uuid').join(',');
     psql(test,`BEGIN;
      DELETE FROM app_private.bank_event_audit WHERE actor_id IN (${ids}) OR source_id IN (SELECT id FROM app_private.bank_event_sources WHERE created_by IN (${ids}));
      DELETE FROM app_private.bank_inbound_events WHERE source_id IN (SELECT id FROM app_private.bank_event_sources WHERE created_by IN (${ids}));
      DELETE FROM app_private.bank_event_credentials WHERE source_id IN (SELECT id FROM app_private.bank_event_sources WHERE created_by IN (${ids}));
      DELETE FROM app_private.bank_event_sources WHERE created_by IN (${ids});
      DELETE FROM public.super_admins WHERE user_id IN (${ids}); COMMIT;`);
     for(const id of fixtureIds){
      const deleted=await http('/auth/v1/admin/users/'+id,undefined,{token:cred.testSecretKey,apikey:cred.testSecretKey,method:'DELETE',signal:cleanupLease.signal});
      assert([200,404].includes(deleted.status),'Synthetic auth cleanup must succeed.');
     }
     assert.equal(psqlJson(test,`SELECT count(*)::int AS n FROM app_private.bank_event_sources WHERE created_by IN (${ids})`)[0].n,0);
    }
    assert.equal(psqlJson(test,`SELECT count(*)::int AS n FROM auth.users WHERE email IN (${emails})`)[0].n,0);
    evidence.cleanup=true;
   });
  }
 });
 console.log(JSON.stringify(evidence));
}
main().catch(error=>{const location=String(error?.stack??'').match(/test-bank-event-inbox-live\.mjs:\d+:\d+/)?.[0]??null;console.error(JSON.stringify({...evidence,status:'FAILED',location,error:'Acceptance failed; inspect named check and cleanup status. No payload, token or password is logged.'}));process.exitCode=1;});
