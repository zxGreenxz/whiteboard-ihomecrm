import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { newFixture, provisionSql, validateFixture } from '../test-env/meter-capture-fixture.mjs';
import { requestTestJson } from '../test-env/meter-capture-live.mjs';

const fresh=()=>newFixture(randomUUID(),'a'.repeat(40),'meter-test@example.invalid','2026-10-23');
test('TEST meter fixture refuses production, missing disposable marker and reused subject IDs',()=>{
 const fixture=fresh();
 for(const change of [{projectRef:'tryymsxyyckgbrmmvozx'},{disposable:false},{marker:'existing-contract'},{meterId:'not-an-id'},{organizationId:randomUUID()}]){
  assert.throws(()=>provisionSql({...fixture,...change}));
 }
 assert.equal(validateFixture(fixture),fixture);
});
test('each meter fixture owns fresh synthetic subjects and its SQL pins TEST membership before insert',()=>{
 const first=fresh(),second=fresh(),keys=['fixtureId','buildingId','roomId','contractId','meterId','serviceId','customerId','internalAccountId','operatingAccountId'];
 assert.equal(new Set([...keys.map(key=>first[key]),...keys.map(key=>second[key])]).size,18);
 const sql=provisionSql(first);
 assert(sql.indexOf('TEST marker mismatch')<sql.indexOf('INSERT INTO public.buildings'));
 assert(sql.includes('TEST actor membership mismatch'));
 assert(sql.includes(first.marker));assert(sql.includes(first.contractId));
 assert(!/session_replication_role|DISABLE TRIGGER|DELETE FROM|TRUNCATE/i.test(sql));
});
test('fixture baseline date must support both in-month confirmation and strictly scoped baseline',()=>{
 assert.throws(()=>newFixture(randomUUID(),'a'.repeat(40),'meter-test@example.invalid','2026-10-01'));
 assert.throws(()=>provisionSql({...fresh(),previousValue:'99.00'}));
 assert.throws(()=>provisionSql({...fresh(),currentValue:'0.00'}));
});
test('parent TEST HTTP client handles native Response.ok and does not expose error bodies',async()=>{
 const url='https://hzulujxgonszuleqticb.supabase.co/auth/v1/token';
 assert.deepEqual(await requestTestJson(url,{},async()=>new Response('{"ok":true}',{status:200})),{ok:true});
 await assert.rejects(requestTestJson(url,{},async()=>new Response('private server body',{status:403})),error=>error.message.includes('HTTP 403')&&!error.message.includes('private server body'));
 let called=false;await assert.rejects(requestTestJson('https://tryymsxyyckgbrmmvozx.supabase.co/auth/v1/token',{},async()=>{called=true;return new Response('{}');}));assert.equal(called,false);
});
