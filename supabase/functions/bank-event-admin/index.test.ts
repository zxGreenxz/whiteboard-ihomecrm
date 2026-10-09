import assert from 'node:assert/strict';
import {createHandler} from './index.ts';
import {encryptPayload,JsonObject,sha256} from '../_shared/bank-events.ts';
const sourceId='10000000-0000-4000-8000-000000000001',eventId='20000000-0000-4000-8000-000000000001';
const env=(name:string)=>({BANK_EVENT_KEY_ID:'v1',BANK_EVENT_ENCRYPTION_KEYS:JSON.stringify({v1:btoa('x'.repeat(32))}),BANK_EVENT_INGEST_URL:'https://example.test/webhooks/sms'})[name];
const request=(body:unknown,auth='Bearer fixture-user-jwt')=>new Request('https://example.test/admin',{method:'POST',headers:{authorization:auth,'content-type':'application/json'},body:JSON.stringify(body)});
Deno.test('every admin request checks server authorization; denied users cannot reach RPC',async()=>{
 let checked=0,calls=0;const handler=createHandler({env,authorizeAdmin:async()=>{checked++;return false;},rpc:async()=>{calls++;return {data:{},error:null};}});
 assert.equal((await handler(request({action:'list_events'}))).status,403);
 assert.equal((await handler(request({action:'get_event',eventId}))).status,403);
 assert.equal((await handler(request({action:'create_source',name:'DEMO',super_admin:true}))).status,403);
 assert.equal((await handler(request({action:'status'},''))).status,401);
 assert.equal(checked,3);assert.equal(calls,0);
});
Deno.test('new credentials returned once; SQL receives only digest; list cannot expose token',async()=>{
 let saved:JsonObject={};const handler=createHandler({env,authorizeAdmin:async()=>true,rpc:async(_fn,args,authorization)=>{
  assert.equal(authorization,'Bearer fixture-user-jwt');saved=args;return {data:args.p_action==='list_sources'?{sources:[]}:{source:{id:sourceId}},error:null};}});
 const created=await (await handler(request({action:'create_source',name:'DEMO'}))).json();
 assert.match(created.data.token,/^[a-f0-9]{64}$/);
 const input=saved.p_input as JsonObject;assert.equal(input.credentialDigest,await sha256(created.data.token));
 assert.equal(JSON.stringify(saved).includes(created.data.token),false);
 const listed=await (await handler(request({action:'list_sources'}))).json();assert.equal('token'in listed.data,false);
});
Deno.test('get_event decrypts only for authorized caller and strips encrypted storage fields',async()=>{
 const payload={schemaVersion:1,event:'sms.received',id:'a'.repeat(64),deviceId:sourceId,receivedAt:'2026-10-09T01:02:03Z',sender:'DEMO',body:'Tin\nthử 😊',subscriptionId:null};
 const hash=await sha256(JSON.stringify(payload)),cipher=await encryptPayload(env,payload,hash);
 const stored={event:{id:eventId,externalId:payload.id,deviceId:sourceId},payloadHash:hash,...cipher};
 const handler=createHandler({env,authorizeAdmin:async()=>true,rpc:async()=>({data:stored,error:null})});
 const result=await (await handler(request({action:'get_event',eventId}))).json();
 assert.deepEqual(result.data,{event:stored.event,payload});
 const tampered=createHandler({env,authorizeAdmin:async()=>true,rpc:async()=>({data:{...stored,event:{...stored.event,deviceId:eventId}},error:null})});
 assert.equal((await tampered(request({action:'get_event',eventId}))).status,503);
});
Deno.test('pagination carries stable cursor, validates filters, and status exposes configured HTTPS URL',async()=>{
 let saved:JsonObject={};const handler=createHandler({env,authorizeAdmin:async()=>true,rpc:async(_fn,args)=>{saved=args;return {data:args.p_action==='status'?{totalEvents:0}:{events:[{id:eventId,receivedAt:'2026-10-09T01:02:03Z'},{id:sourceId,receivedAt:'2026-10-09T01:00:03Z'}]},error:null};}});
 const result=await (await handler(request({action:'list_events',limit:1}))).json();assert.equal(result.data.events.length,1);assert.ok(result.data.nextCursor);
 await handler(request({action:'list_events',limit:1,cursor:result.data.nextCursor}));
 assert.equal((saved.p_input as JsonObject).beforeId,eventId);
 for(const input of [{limit:101},{cursor:'garbage'},{from:'yesterday'},{sourceId:'invalid'},{query:'x'.repeat(121)},{organizationId:sourceId}])assert.equal((await handler(request({action:'list_events',...input}))).status,400);
 const status=await (await handler(request({action:'status'}))).json();assert.equal(status.data.ingestUrl,'https://example.test/webhooks/sms');
});
Deno.test('event list asks SQL for ciphertext, returns only metadata plus parsed money summary',async()=>{
 const stored=async(id:string,payload:JsonObject)=>{const hash=await sha256(JSON.stringify(payload)),cipher=await encryptPayload(env,payload,hash);
  return {id,externalId:payload.id,deviceId:sourceId,receivedAt:'2026-10-09T01:02:03Z',eventType:payload.event,payloadHash:hash,...cipher};};
 const email={schemaVersion:1,event:'email.received',id:'a'.repeat(64),deviceId:sourceId,receivedAt:'2026-10-09T01:02:03Z',from:'"ACB" <mailalert@acb.com.vn>',subject:'Thông báo biến động số dư',body:'Tài khoản: xxxx5847\nGhi có +14,000,000 VND\nNGUYEN VAN A CHUYEN TIEN PHONG 101\n17/03/2026 14:09:11'};
 const otp={schemaVersion:1,event:'sms.received',id:'b'.repeat(64),deviceId:sourceId,receivedAt:'2026-10-09T01:02:03Z',sender:'DEMO',body:'Ma OTP cua quy khach la 123456',subscriptionId:null};
 const rows=[await stored(eventId,email),await stored(sourceId,otp),{...await stored('30000000-0000-4000-8000-000000000001',email),nonce:'AAAAAAAAAAAAAAAA'}];
 let saved:JsonObject={};const handler=createHandler({env,authorizeAdmin:async()=>true,rpc:async(_fn,args)=>{saved=args;return {data:{events:rows},error:null};}});
 const response=await handler(request({action:'list_events',eventType:'email.received'}));assert.equal(response.status,200);
 assert.equal((saved.p_input as JsonObject).withPayload,true);assert.equal((saved.p_input as JsonObject).eventType,'email.received');
 const body=await response.json(),text=JSON.stringify(body);
 for(const secret of ['ciphertext','nonce','payloadHash','keyId','NGUYEN VAN A CHUYEN TIEN PHONG 101\\n','123456','xxxx5847'])assert.equal(text.includes(secret),false,secret);
 const [money,notMoney,broken]=body.data.events;
 assert.equal(money.summaryStatus,'parsed');assert.equal(money.summary.direction,'in');assert.equal(money.summary.amount,14000000);
 assert.equal(money.summary.account,'••5847');assert.match(money.summary.description,/NGUYEN VAN A/);
 assert.equal(notMoney.summaryStatus,'unparsed');assert.equal(notMoney.summary,null);
 assert.equal(broken.summaryStatus,'unavailable');assert.equal(broken.summary,null);assert.equal(broken.id,'30000000-0000-4000-8000-000000000001');
 for(const input of [{eventType:'mail'},{withPayload:false}])assert.equal((await handler(request({action:'list_events',...input}))).status,400);
});
Deno.test('source kind is limited to android or gmail before reaching SQL',async()=>{
 let saved:JsonObject={};const handler=createHandler({env,authorizeAdmin:async()=>true,rpc:async(_fn,args)=>{saved=args;return {data:{source:{id:sourceId}},error:null};}});
 assert.equal((await handler(request({action:'create_source',name:'DEMO',kind:'imap'}))).status,400);
 assert.equal((await handler(request({action:'create_source',name:'DEMO',kind:'gmail'}))).status,200);
 assert.equal((saved.p_input as JsonObject).kind,'gmail');
});
Deno.test('default admin authorization verifies user JWT then requires literal database super-admin result',async()=>{
 const originalFetch=globalThis.fetch;const paths:string[]=[];let permission:unknown='true';
 const authEnv=(name:string)=>({SUPABASE_URL:'https://backend.example.test',SUPABASE_ANON_KEY:'fixture-public-key'})[name];
 globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const path=String(input);paths.push(path);const headers=new Headers(init?.headers);assert.equal(headers.get('authorization'),'Bearer fixture-user-jwt');
  if(path.includes('/rest/v1/rpc/')){assert.equal(headers.get('content-profile'),'public');assert.equal(headers.get('accept-profile'),'public');}
  return new Response(JSON.stringify(path.endsWith('/auth/v1/user')?{id:sourceId,user_metadata:{super_admin:true}}:
    path.endsWith('/is_super_admin')?permission:{totalEvents:0}),{status:200,headers:{'content-type':'application/json'}});
 }) as typeof fetch;
 try {
  const handler=createHandler({env:authEnv});assert.equal((await handler(request({action:'status'}))).status,403);
  assert.equal(paths.some(path=>path.endsWith('/bank_event_admin_v1')),false);
  permission=true;assert.equal((await handler(request({action:'status'}))).status,200);
  assert.equal(paths.filter(path=>path.endsWith('/auth/v1/user')).length,2);
 }finally{globalThis.fetch=originalFetch;}
});
