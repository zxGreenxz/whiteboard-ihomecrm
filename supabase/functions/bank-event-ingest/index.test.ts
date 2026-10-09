import assert from 'node:assert/strict';
import {createHandler} from './index.ts';
import {decryptPayload,JsonObject,sha256} from '../_shared/bank-events.ts';
const sourceId='10000000-0000-4000-8000-000000000001',eventId='20000000-0000-4000-8000-000000000001';
const token='fixture-device-token-'.repeat(3);
const env=(name:string)=>({BANK_EVENT_KEY_ID:'v1',BANK_EVENT_ENCRYPTION_KEYS:JSON.stringify({v1:btoa('x'.repeat(32))})})[name];
const event=(overrides:JsonObject={}):JsonObject=>({schemaVersion:1,event:'sms.received',id:'a'.repeat(64),deviceId:'30000000-0000-4000-8000-000000000001',receivedAt:'2026-10-09T01:02:03.456Z',sender:'DEMO',body:'Thử nghiệm\n😊',subscriptionId:null,...overrides});
const request=(payload:unknown=event(),authorization=`Bearer ${token}`,key='a'.repeat(64))=>new Request('https://example.test/ingest',{method:'POST',headers:{authorization,'content-type':'application/json','x-idempotency-key':key},body:JSON.stringify(payload)});
const receipt=(status='accepted')=>({status,sourceId,eventId:status==='heartbeat'?null:eventId,externalId:'a'.repeat(64),acceptedAt:'2026-10-09T01:02:03.456Z'});

Deno.test('ingest encrypts exact canonical payload and sends only credential digest to SQL',async()=>{
 let saved:JsonObject={};
 const handler=createHandler({env,rpc:async(_name,args)=>{saved=args;return {data:receipt(),error:null};}});
 const response=await handler(request());assert.equal(response.status,201);
 assert.equal(saved.p_digest,await sha256(token));assert.equal(JSON.stringify(saved).includes(token),false);
 assert.equal(JSON.stringify(saved).includes('Thử nghiệm'),false);
 const raw=await decryptPayload(env,{event:{externalId:saved.p_external_id,deviceId:saved.p_device_id},keyId:saved.p_key_id,nonce:saved.p_nonce,ciphertext:saved.p_ciphertext,payloadHash:saved.p_payload_hash});
 assert.deepEqual(raw,event());
 assert.deepEqual(await response.json(),{schemaVersion:1,ok:true,data:receipt()});
});
Deno.test('UUID case normalization keeps stored ciphertext decryptable after PostgreSQL canonicalizes metadata',async()=>{
 let saved:JsonObject={};const handler=createHandler({env,rpc:async(_name,args)=>{saved=args;return {data:receipt(),error:null};}});
 const deviceId='AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
 assert.equal((await handler(request(event({deviceId})))).status,201);
 assert.equal(saved.p_device_id,deviceId.toLowerCase());
 const payload=await decryptPayload(env,{event:{externalId:saved.p_external_id,deviceId:deviceId.toLowerCase()},keyId:saved.p_key_id,nonce:saved.p_nonce,ciphertext:saved.p_ciphertext,payloadHash:saved.p_payload_hash});
 assert.deepEqual(payload,event({deviceId:deviceId.toLowerCase()}));
});
Deno.test('ingest rejects authentication/header/schema/UTF-8 byte violations before storage',async()=>{
 let calls=0;const handler=createHandler({env,rpc:async()=>{calls++;return {data:receipt(),error:null};}});
 for(const [payload,auth,key,status] of [
  [event(),'','a'.repeat(64),401],[event(),'Bearer short','a'.repeat(64),401],
  [event(),`Bearer ${token}`,'b'.repeat(64),400],
  [event({organizationId:'forged'}),`Bearer ${token}`,'a'.repeat(64),400],
  [event({receivedAt:'2026-02-30T01:02:03Z'}),`Bearer ${token}`,'a'.repeat(64),400],
  [event({body:'😊'.repeat(2049)}),`Bearer ${token}`,'a'.repeat(64),400],
  [event({body:'\ud800'}),`Bearer ${token}`,'a'.repeat(64),400],
 ] as const)assert.equal((await handler(request(payload,auth,key))).status,status);
 assert.equal(calls,0);
});
Deno.test('ingest accepts escaped control characters and notification union; fails closed without encryption',async()=>{
 let calls=0;const handler=createHandler({env,rpc:async()=>{calls++;return {data:receipt(),error:null};}});
 assert.equal((await handler(request(event({body:'\u0001'.repeat(8192)})))).status,201);
 const notification={schemaVersion:1,event:'notification.received',id:'a'.repeat(64),deviceId:event().deviceId,receivedAt:event().receivedAt,packageName:'vn.example.demo',appName:'DEMO',title:'Thử',body:'Nội dung thử'};
 assert.equal((await handler(request(notification))).status,201);
 assert.equal((await handler(request({...notification,sender:'extra'}))).status,400);
 assert.equal(calls,2);
 const noKey=createHandler({env:()=>undefined,rpc:async()=>{throw new Error('must not store');}});
 assert.equal((await noKey(request())).status,503);
 const huge=new Request('https://example.test',{method:'POST',headers:{authorization:`Bearer ${token}`,'x-idempotency-key':'a'.repeat(64),'content-type':'application/json'},body:' '.repeat(65537)});
 assert.equal((await handler(huge)).status,413);
});
Deno.test('heartbeat has a durable source receipt and never contains a stored ciphertext',async()=>{
 let saved:JsonObject={};const handler=createHandler({env,rpc:async(_name,args)=>{saved=args;return {data:receipt('heartbeat'),error:null};}});
 const beat={schemaVersion:1,event:'gateway.heartbeat',id:'a'.repeat(64),deviceId:event().deviceId,receivedAt:event().receivedAt,smsEnabled:true,notificationsEnabled:false,notificationAccess:false,smsPermission:true,appVersion:'1.0'};
 assert.equal((await handler(request(beat))).status,200);assert.equal(saved.p_ciphertext,null);
 assert.deepEqual(saved.p_heartbeat,{smsEnabled:true,notificationsEnabled:false,notificationAccess:false,smsPermission:true,appVersion:'1.0',receivedAt:event().receivedAt});
});
Deno.test('receipt time from PostgreSQL (+00:00, microseconds) is returned as UTC Z for Android Instant.parse',async()=>{
 for(const status of ['accepted','duplicate','heartbeat']) {
  const handler=createHandler({env,rpc:async()=>({data:{...receipt(status),acceptedAt:'2026-10-09T09:29:31.432663+00:00'},error:null})});
  const payload=status==='heartbeat'?{schemaVersion:1,event:'gateway.heartbeat',id:'a'.repeat(64),deviceId:event().deviceId,receivedAt:event().receivedAt,smsEnabled:true,notificationsEnabled:false,notificationAccess:false,smsPermission:true,appVersion:'1.0'}:event();
  const body=await (await handler(request(payload))).json();
  assert.equal(body.data.acceptedAt,'2026-10-09T09:29:31.432Z');
 }
});
Deno.test('revocation, collision and storage errors are not acknowledged; malformed receipts fail closed',async()=>{
 for(const [code,status] of [['28000',401],['PT409',409],['XX000',503]] as const) {
  const handler=createHandler({env,rpc:async()=>({data:null,error:{code}})});
  assert.equal((await handler(request())).status,status);
 }
 const handler=createHandler({env,rpc:async()=>({data:{status:'accepted'},error:null})});
 assert.equal((await handler(request())).status,502);
 const duplicate=createHandler({env,rpc:async()=>({data:receipt('duplicate'),error:null})});
 assert.equal((await duplicate(request())).status,200);
});
Deno.test('email events and gmail heartbeats have their own exact shape; android fields cannot be mixed in',async()=>{
 const saved:JsonObject[]=[];const handler=createHandler({env,rpc:async(_name,args)=>{saved.push(args);return {data:receipt(args.p_event_type==='gateway.heartbeat'?'heartbeat':'accepted'),error:null};}});
 const email={schemaVersion:1,event:'email.received',id:'a'.repeat(64),deviceId:event().deviceId,receivedAt:event().receivedAt,from:'"DEMO" <alert@example.test>',subject:'Thử',body:'Ghi có +1,000 VND'};
 assert.equal((await handler(request(email))).status,201);assert.equal(saved[0].p_event_type,'email.received');
 for(const bad of [{...email,sender:'extra'},{...email,subject:'x'.repeat(1025)},{...email,body:'😊'.repeat(2049)},{...email,from:undefined}])
  assert.equal((await handler(request(bad))).status,400);
 const beat={schemaVersion:1,event:'gateway.heartbeat',id:'a'.repeat(64),deviceId:event().deviceId,receivedAt:event().receivedAt,channel:'gmail',appVersion:'gmail-script-1',schedule:'night-10m',usedSecondsToday:42};
 assert.equal((await handler(request(beat))).status,200);
 assert.deepEqual(saved.at(-1)?.p_heartbeat,{channel:'gmail',appVersion:'gmail-script-1',schedule:'night-10m',usedSecondsToday:42,receivedAt:event().receivedAt});
 for(const bad of [{...beat,schedule:'every-second'},{...beat,usedSecondsToday:86401},{...beat,usedSecondsToday:1.5},{...beat,smsEnabled:true},{...beat,channel:'imap'}])
  assert.equal((await handler(request(bad))).status,400);
 assert.equal(saved.length,2);
});
