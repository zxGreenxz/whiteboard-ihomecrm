import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {splitSqlStatements} from '../network-center-function-bodies.mjs';
const read=name=>readFileSync(new URL(`../../supabase/migrations/${name}`,import.meta.url),'utf8').replace(/\r\n?/g,'\n');
const next=read('20261012165809_hermes_public_conflict_http_v1.sql');
const items=[['20261012083047_hermes_room_scope_read_v1.sql','hermes_room_scope_map_v1','uuid,uuid[],uuid,text,bigint,bigint,uuid,bigint,bigint',4],
 ['20261012061447_hermes_assistant_identity_policy_v1.sql','hermes_set_org_policy_v1','uuid,bigint,boolean,text[],text[],uuid[]',2]];
const body=(sql,name)=>sql.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$fn\\$;`))?.[0];
function delta(sql){
 assert.equal((sql.match(/CREATE OR REPLACE FUNCTION /g)||[]).length,2);
 for(const [file,name,signature,count] of items){
  const previous=body(read(file),name),current=body(sql,name);assert(previous&&current);
  assert.equal(current,previous.replaceAll("ERRCODE='40001'","ERRCODE='PT409'"));
  assert.equal((current.match(/ERRCODE='PT409'/g)||[]).length,count);assert(!current.includes('40001'));
  for(const clause of [`ALTER FUNCTION public.${name}(${signature}) OWNER TO postgres;`,
   `REVOKE ALL ON FUNCTION public.${name}(${signature}) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;`,
   `GRANT EXECUTE ON FUNCTION public.${name}(${signature}) TO authenticated;`])assert(sql.includes(clause));
 }
 const statements=splitSqlStatements(sql).map(x=>x.replace(/--[^\n]*/g,'').trim()).filter(Boolean);
 assert.equal(statements.length,12);assert.equal(statements[0],'BEGIN');assert.equal(statements.at(-1),'COMMIT');
}
test('public conflict forward patch changes only six deliberate error codes, preserving full bodies/owners/ACL',()=>delta(next));
test('guard rejects protocol regression, weakened permission fence or broadened ACL',()=>{
 for(const broken of [next.replace("ERRCODE='PT409'","ERRCODE='40001'"),next.replace("AND state='ACTIVE'","AND true"),next.replace('TO authenticated;','TO authenticated,anon;')])assert.throws(()=>delta(broken));
});
test('private store CAS protocol remains unchanged by this migration',()=>{
 assert(!/CREATE OR REPLACE FUNCTION app_private\./.test(next));
 assert(read('20261012062043_hermes_encrypted_session_store_v1.sql').includes("ERRCODE='40001'"));
});
