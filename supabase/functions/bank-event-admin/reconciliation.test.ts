import assert from 'node:assert/strict';
import { createHandler } from './index.ts';
import { createHandler as ingestHandler } from '../bank-event-ingest/index.ts';
import { reconciliationFacts } from '../_shared/bank-reconciliation.ts';
import { encryptPayload, type JsonObject, sha256 } from '../_shared/bank-events.ts';
const org='10000000-0000-4000-8000-000000000001',source='20000000-0000-4000-8000-000000000001',id='30000000-0000-4000-8000-000000000001';
const env=(name:string)=>({BANK_EVENT_KEY_ID:'v1',BANK_EVENT_ENCRYPTION_KEYS:JSON.stringify({v1:btoa('x'.repeat(32))})}[name]);
const payload:JsonObject={schemaVersion:1,event:'sms.received',id:'a'.repeat(64),deviceId:source,receivedAt:'2026-10-01T02:00:00Z',sender:'BANK-DEMO',body:'TK 0000001234 GD: +100,000VND 01/10/2026 09:00 SD: 200,000VND ND: KHACH MAU PHONG A01',subscriptionId:null};
const request=(body:unknown)=>new Request('https://example.test',{method:'POST',headers:{authorization:'Bearer fixture-user', 'content-type':'application/json'},body:JSON.stringify(body)});
Deno.test('routing identities use exact SMS sender, package and email mailbox; OTP and gateway test are excluded',()=>{
 assert.equal(reconciliationFacts(payload)?.origin,'bank-demo');
 assert.equal(reconciliationFacts({...payload,event:'notification.received',packageName:'Com.Bank.Fixture'})?.origin,'com.bank.fixture');
 assert.equal(reconciliationFacts({...payload,event:'email.received',from:'Bank Demo <Alert@example.test>'})?.origin,'alert@example.test');
 assert.equal(reconciliationFacts({...payload,event:'gateway.test'}),null);
 assert.equal(reconciliationFacts({...payload,body:'OTP 123456 dang nhap tai khoan'}),null);
});
Deno.test('cannot forge facts through reconcile operation or skip organization authorization',async()=>{
 let calls=0;const handler=createHandler({env,authorizeAdmin:async()=>true,rpc:async()=>{calls++;return {data:null,error:{code:'42501'}};}});
 assert.equal((await handler(request({action:'reconcile',organizationId:org,operation:'cache',input:{amount:100}}))).status,400);
 assert.equal(calls,0);
 assert.equal((await handler(request({action:'reconcile',organizationId:org,operation:'sync',input:{sourceId:source}}))).status,403);
 assert.equal(calls,1);
});
Deno.test('sync decrypts server payload, checks source organization, and only privileged cache receives facts',async()=>{
 const hash=await sha256(JSON.stringify(payload)),encrypted=await encryptPayload(env,payload,hash);
 let cached:JsonObject|undefined;
 const handler=createHandler({env,authorizeAdmin:async()=>true,rpc:async(name,args,authorization)=>{
  if(name==='bank_reconciliation_cache_v1'){assert.equal(authorization,undefined);cached=args;return {data:true,error:null};}
  assert.equal(authorization,'Bearer fixture-user');
  if(name==='bank_reconciliation_v1')return {data:{books:[],rules:[]},error:null};
  if(args.p_action==='list_sources')return {data:{sources:[{id:source,organizationId:org}]},error:null};
  return {data:{events:[{id,externalId:payload.id,deviceId:source,receivedAt:payload.receivedAt,...encrypted,payloadHash:hash}]},error:null};
 }});
 const response=await handler(request({action:'reconcile',organizationId:org,operation:'sync',input:{sourceId:source}}));
 assert.equal(response.status,200);assert.equal((await response.json()).data.cached,1);
 assert.equal(cached?.p_event_id,id);assert.equal((cached?.p_facts as JsonObject).amount,100000);
 assert.equal(JSON.stringify(cached).includes('0000001234'),false);
});
Deno.test('ingest with bank facts is acknowledged only after durable cache; retry keeps original event id',async()=>{
 const names:string[]=[];let cacheFails=true;
 const handler=ingestHandler({env,rpc:async(name)=>{
  names.push(name);if(name==='bank_reconciliation_cache_v1')return cacheFails?{data:null,error:{code:'XX000'}}:{data:true,error:null};
  return {data:{status:'accepted',sourceId:source,eventId:id,externalId:payload.id,acceptedAt:payload.receivedAt},error:null};
 }});
 const make=()=>new Request('https://example.test',{method:'POST',headers:{authorization:'Bearer '+'x'.repeat(48),'content-type':'application/json','x-idempotency-key':String(payload.id)},body:JSON.stringify(payload)});
 assert.equal((await handler(make())).status,503);cacheFails=false;assert.equal((await handler(make())).status,201);
 assert.deepEqual(names,['bank_event_ingest_v1','bank_reconciliation_cache_v1','bank_event_ingest_v1','bank_reconciliation_cache_v1']);
});
