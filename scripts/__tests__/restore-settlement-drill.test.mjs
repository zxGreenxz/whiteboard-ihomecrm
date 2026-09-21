import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { taoFixtureAcl, kiemCatalogPhucHoi } from '../dien-tap-forward-lane.mjs';

const fixtureText=readFileSync(new URL('../../supabase/baseline/restore-settlement-acl-fixture.json',import.meta.url),'utf8');
const fixture=JSON.parse(fixtureText);
const group=JSON.parse(readFileSync(new URL('../../supabase/migration-policy.json',import.meta.url),'utf8')).idempotencyRetirements[0];
const digest=createHash('sha256').update(fixtureText.replaceAll('\r\n','\n')).digest('hex');
const catalog=(restored=false)=>({functions:[...group.witness.functions.map(f=>({signature:f.signature,...f[restored?'after':'before']})),...group.witness.removedFunctions.map(f=>restored?{signature:f.signature,md5:null,owner:null,acl:null}:f)],triggers:[...group.witness.removedTriggers.map(t=>restored?{...t,md5:null,enabled:null}:t),...group.witness.retainedTriggers],rolePresent:!restored});
test('ACL fixture reconstructs captured privileges only, with before/after guards',()=>{
 const sql=taoFixtureAcl(fixtureText,digest,group);
 assert.equal(taoFixtureAcl(fixtureText.replaceAll('\r\n','\n').replaceAll('\n','\r\n'),digest,group),sql);
 assert.match(sql,/BEGIN;/);assert.match(sql,/drill ACL before drift/);assert.match(sql,/drill ACL after drift/);assert.match(sql,/REVOKE ALL ON FUNCTION/);assert.match(sql,/COMMIT;/);
 assert.doesNotMatch(sql,/CREATE OR REPLACE|ALTER FUNCTION|INSERT INTO|UPDATE |DELETE FROM/);
});
test('fixture bytes, empty entries, forged metadata and changing definitions fail closed',()=>{
 assert.throws(()=>taoFixtureAcl(fixtureText+' ',digest,group),/digest/);
 for(const mutate of [f=>f.functions=[],f=>f.functions[0].after.md5='0'.repeat(32),f=>f.functions[0].after.acl='{anon=X/postgres}',f=>f.functions.push(f.functions[0])]){
  const f=structuredClone(fixture);mutate(f);const text=JSON.stringify(f);assert.throws(()=>taoFixtureAcl(text,createHash('sha256').update(text).digest('hex'),group));
 }
});
test('full catalog witnesses require all44 functions,5 triggers and correct role in both states',()=>{
 for(const restored of [false,true]){
  assert.doesNotThrow(()=>kiemCatalogPhucHoi(group,catalog(restored),restored));
  for(const mutate of [c=>c.functions.pop(),c=>c.functions[0].md5='0'.repeat(32),c=>c.functions[0].acl=null,c=>c.functions[0].owner='anon',c=>c.triggers.pop(),c=>c.triggers[4].enabled='D',c=>c.rolePresent=!c.rolePresent]){
   const c=structuredClone(catalog(restored));mutate(c);assert.throws(()=>kiemCatalogPhucHoi(group,c,restored),/catalog/);
  }
 }
 assert.throws(()=>kiemCatalogPhucHoi(group,{comment:'all44 matched'},false),/catalog/);
});
