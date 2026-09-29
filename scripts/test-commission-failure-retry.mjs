#!/usr/bin/env node
// Isolated TEST fixtures; all public behavior asserted over real JWT/PostgREST.
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {testConnection,originalTestSession,signInTest,request} from './test-voucher-detail-read-authz.mjs';
import {psql,psqlJson,lit} from './test-env/lib.mjs';

if(process.argv[2]!=='--env' || process.argv[3]!=='test') throw new Error('Usage: node scripts/test-commission-failure-retry.mjs --env test');
const ctx=await testConnection();
const originalWriter=psqlJson(ctx.test,"select pg_get_functiondef(oid) body from pg_proc where proname='create_commission_voucher'")[0].body;
const session=await originalTestSession(ctx); const jwt=session.access_token;
const org='aaaa0000-0000-4000-8000-000000000001';
const contracts=Array.from({length:5},()=>randomUUID());const suffix=randomBytes(6).toString('hex');
const vouchers=[];const passes=[];let deniedActor;let deniedJwt;const member=randomUUID();
const mutation=sql=>psql(ctx.test,`BEGIN; SET LOCAL session_replication_role=replica; ${sql} COMMIT;`);
const rpc=async(name,body,token=jwt)=>request(ctx,token,`rpc/${name}`,body);
const ok=async(name,body,token=jwt)=>{const r=await rpc(name,body,token);assert.equal(r.status,200,`${name}: HTTP ${r.status}, ${r.json.code}: ${r.json.message}`);return r.json;};
const check=async(name,fn)=>{await fn();passes.push(name);console.log(`PASS ${name}`);};
const payload=(contract=contracts[0],kind='broker',id=randomUUID())=>({request_id:id,contract_id:contract,kind,amount:1234,voucher_date:'2026-09-29',item_description:`TEST retry ${suffix}`});
const prepare=intents=>ok('prepare_commission_requests_v1',{p_organization_id:org,p_intents:intents});
const exec=(p,token=jwt)=>ok('execute_commission_request_v1',{p_organization_id:org,p_contract_id:p.contract_id,p_kind:p.kind,p_request_id:p.request_id},token);
const list=(unresolved=true,extra={})=>ok('list_contract_commission_followups_v2',{p_organization_id:org,p_contract_ids:contracts,p_unresolved_only:unresolved,...extra});
const source=(await ok('list_contract_commission_followups_v1',{p_organization_id:org,p_limit:100})).rows.find(r=>r.can_manage);
assert(source,'real actor needs a manageable building fixture');
try {
 mutation(contracts.map((id,i)=>`INSERT INTO public.contracts(id,user_id,room_id,organization_id,status,signed_date,start_date,end_date,rent_price,public_code,contract_number)
 SELECT ${lit(id)},user_id,room_id,organization_id,'TERMINATED',current_date,current_date,current_date+365,1000000,${lit(`RETRY${suffix}${i}`)},${lit(`TEST-RETRY-${suffix}-${i}`)} FROM public.contracts WHERE id=${lit(source.contract_id)};`).join('\n'));
 await check('unattempted contracts same room are not failures',async()=>{assert.equal((await list()).total,0);assert.equal((await list(false)).total,10);});
 const p=payload(), sale=payload(contracts[0],'sale');
 await check('prepare both intents before executing either',async()=>{assert.equal((await prepare([p,sale])).length,2);assert.equal((await list()).total,0);assert.equal((await list(false)).rows.filter(r=>r.state==='PROCESSING').length,2);});
 await check('concurrent same request creates exactly one voucher',async()=>{
  const results=await Promise.all([exec(p),exec(p)]);assert.equal(results[0].status,'COMPLETED');assert.deepEqual(results[0],results[1]);assert(results[0].id);vouchers.push(results[0].id);
  assert.equal(psqlJson(ctx.test,`select count(*)::int n from public.income_expenses where contract_id=${lit(p.contract_id)} and commission_kind='broker'`)[0].n,1);
 });
 await check('lost response retry returns durable original identity',async()=>{assert.equal((await exec(p)).id,vouchers[0]);});
 await check('changed payload conflicts and failed execute not success',async()=>{
  const changed=await rpc('prepare_commission_requests_v1',{p_organization_id:org,p_intents:[{...p,amount:9999}]});assert.equal(changed.status,409);
  const fail={...payload(contracts[1]),account_id:randomUUID(),recipient_bank:'PRIVATE TEST BANK',recipient_account:'PRIVATE ACCOUNT'};await prepare([fail]);const result=await exec(fail);assert.equal(result.status,'FAILED');assert.equal(result.id,null);
  assert.equal((await list()).rows.filter(r=>r.state==='FAILED').length,1);
 });
 await check('two distinct concurrent requests reconcile under same canonical lock',async()=>{
  const a=payload(contracts[2],'sale'),b=payload(contracts[2],'sale');await prepare([a,b]);const r=await Promise.all([exec(a),exec(b)]);
  assert.deepEqual(r.map(x=>x.status).sort(),['ALREADY_EXISTS','COMPLETED']);assert.equal(r[0].id,r[1].id);vouchers.push(r[0].id);
 });
 await check('different contract in same room remains independent',async()=>{
  const a=payload(contracts[3]);await prepare([a]);const r=await exec(a);assert.equal(r.status,'COMPLETED');assert.notEqual(r.id,vouchers[0]);vouchers.push(r.id);
 });
 await check('deposit-linked alias reconciles existing bonus identity',async()=>{
  const dep=randomUUID(),bon=randomUUID();vouchers.push(dep,bon);
  mutation(`INSERT INTO public.income_expenses(id,user_id,organization_id,building_id,contract_id,code,type,name,voucher_date,approval_status) VALUES
   (${lit(dep)},${lit(session.user.id)},${lit(org)},${lit(source.building_id)},${lit(contracts[0])},${lit(`TEST-DEP-${suffix}`)},'INCOME','TEST deposit',current_date,'UNAPPROVED'),
   (${lit(bon)},${lit(session.user.id)},${lit(org)},${lit(source.building_id)},NULL,${lit(`TEST-BON-${suffix}`)},'EXPENSE','TEST bonus',current_date,'UNAPPROVED');
   INSERT INTO app_private.sale_bonus_claims(organization_id,deposit_voucher_id,bonus_voucher_id,amount,created_by) VALUES(${lit(org)},${lit(dep)},${lit(bon)},1234,${lit(session.user.id)});`);
  assert.deepEqual(await exec(sale),{status:'ALREADY_EXISTS',id:bon,code:`TEST-BON-${suffix}`});
 });
 await check('completed then cancelled never resurfaces or creates again',async()=>{
  mutation(`UPDATE public.income_expenses SET approval_status='CANCELLED',deleted_at=now() WHERE id=${lit(vouchers[0])};`);
  const r=await exec(p);assert.equal(r.status,'COMPLETED');assert.equal((await list()).rows.some(r=>r.contract_id===p.contract_id && r.kind==='broker'),false);
  assert.equal(psqlJson(ctx.test,`select count(*)::int n from public.income_expenses where contract_id=${lit(p.contract_id)} and commission_kind='broker'`)[0].n,1);
 });
 await check('legacy open-tab direct success then cancellation and late error stays resolved',async()=>{
  const legacy=payload(contracts[4]);
  const event={p_organization_id:org,p_contract_id:legacy.contract_id,p_kind:legacy.kind,p_request_id:legacy.request_id,p_amount:legacy.amount};
  await ok('record_contract_commission_event_v1',{...event,p_action:'ATTEMPTED'});
  const v=await ok('create_commission_voucher',{p_contract_id:legacy.contract_id,p_kind:legacy.kind,p_amount:legacy.amount,p_voucher_date:legacy.voucher_date});vouchers.push(v.id);
  mutation(`UPDATE public.income_expenses SET approval_status='CANCELLED',deleted_at=now() WHERE id=${lit(v.id)};`);
  await ok('record_contract_commission_event_v1',{...event,p_action:'FAILED',p_reason:'Lost response after actual success'});
  assert.equal((await list()).rows.some(row=>row.contract_id===legacy.contract_id),false);
  const receipt=psqlJson(ctx.test,`SELECT voucher_id FROM public.contract_commission_events WHERE contract_id=${lit(legacy.contract_id)} AND action='COMPLETED'`);assert.equal(receipt.length,1);assert.equal(receipt[0].voucher_id,v.id);
  const replacement=payload(contracts[4]);await prepare([replacement]);const created=await exec(replacement);assert.equal(created.status,'COMPLETED');assert.notEqual(created.id,v.id);vouchers.push(created.id);
 });
 await check('real JWT without membership denied all new public boundaries',async()=>{
  const email=`retry-${suffix}@example.invalid`,password=`Tt!${randomBytes(22).toString('base64url')}`;
  const created=await fetch(`${ctx.url}/auth/v1/admin/users`,{method:'POST',headers:{apikey:ctx.cred.testSecretKey,Authorization:`Bearer ${ctx.cred.testSecretKey}`,'Content-Type':'application/json'},body:JSON.stringify({email,password,email_confirm:true})});assert.equal(created.status,200);deniedActor=(await created.json()).id;
  const other=(await signInTest(ctx,email,password)).access_token;deniedJwt=other;
  for(const [name,body] of [
   ['prepare_commission_requests_v1',{p_organization_id:org,p_intents:[payload()]}],
   ['execute_commission_request_v1',{p_organization_id:org,p_contract_id:p.contract_id,p_kind:p.kind,p_request_id:p.request_id}],
   ['list_contract_commission_followups_v2',{p_organization_id:org}],
  ]) { const r=await rpc(name,body,other);assert.equal(r.status,403);assert.equal(r.json.code,'42501'); }
  for(const name of ['contract_commission_requests','contract_commission_events']) {const r=await request(ctx,other,`${name}?select=*&limit=1`);assert.equal(r.status,403);}
 });
 await check('same-org contract-only JWT sees failure state but no financial details or execute',async()=>{
  mutation(`INSERT INTO public.organization_memberships(id,organization_id,user_id,member_type,status,valid_from) VALUES(${lit(member)},${lit(org)},${lit(deniedActor)},'STAFF','ACTIVE',now()-interval '1 day');
   WITH overrides AS (INSERT INTO public.member_permission_overrides(organization_id,membership_id,permission_key,effect,reason,created_by,scope_mode)
    SELECT ${lit(org)},${lit(member)},permission,'ALLOW','TEST commission read-only',${lit(session.user.id)},'SCOPED' FROM unnest(ARRAY['contracts.view','buildings.view']) permission RETURNING id)
   INSERT INTO public.member_override_scopes(organization_id,override_id,scope_id) SELECT ${lit(org)},overrides.id,s.id FROM overrides CROSS JOIN public.authorization_scopes s WHERE s.organization_id=${lit(org)} AND s.scope_type='BUILDING' AND s.building_id=${lit(source.building_id)};`);
  const result=await ok('list_contract_commission_followups_v2',{p_organization_id:org,p_contract_ids:contracts,p_unresolved_only:true},deniedJwt);
  assert.equal(result.total,1);const row=result.rows[0];assert.equal(row.state,'FAILED');assert.equal(row.attempted_amount,null);assert.equal(row.last_reason,null);assert.equal(row.can_manage,false);assert.equal(row.can_retry,false);assert(row.events.every(e=>e.amount===null && e.reason===null));assert(!JSON.stringify(result).includes('PRIVATE'));
  const denied=await rpc('execute_commission_request_v1',{p_organization_id:org,p_contract_id:row.contract_id,p_kind:row.kind,p_request_id:row.request_id},deniedJwt);assert.equal(denied.status,403);
  const prep=await rpc('prepare_commission_requests_v1',{p_organization_id:org,p_intents:[payload()]},deniedJwt);assert.equal(prep.status,403);
  for(const token of [jwt,deniedJwt]) {const raw=await request(ctx,token,'contract_commission_requests?select=*&limit=1');assert.equal(raw.status,403);}
 });
 await check('ACL volatility and canonical body stable during fixtures',async()=>{
  const rows=psqlJson(ctx.test,`select p.proname,p.provolatile,p.prosecdef,pg_get_userbyid(p.proowner) owner,has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('prepare_commission_requests_v1','execute_commission_request_v1','list_contract_commission_followups_v2')`);
  assert.equal(rows.length,3);for(const r of rows){assert.equal(r.anon,false);assert.equal(r.authenticated,true);assert.equal(r.prosecdef,true);assert.equal(r.owner,'postgres');assert.equal(r.provolatile,r.proname.startsWith('list_')?'s':'v');}
  const body=psqlJson(ctx.test,`select pg_get_functiondef(oid) body from pg_proc where proname='create_commission_voucher'`)[0].body;
  assert.equal(body,originalWriter);
 });
} finally {
 const all=contracts.map(lit).join(',');const vids=psqlJson(ctx.test,`select id from public.income_expenses where contract_id in (${all})`).map(r=>r.id);const ids=[...new Set([...vids,...vouchers])].map(lit).join(',')||'NULL';
 mutation(`DELETE FROM app_private.sale_bonus_claims WHERE deposit_voucher_id IN (${ids}) OR bonus_voucher_id IN (${ids});DELETE FROM public.contract_commission_requests WHERE contract_id IN (${all});DELETE FROM public.contract_commission_events WHERE contract_id IN (${all});DELETE FROM public.income_expense_items WHERE income_expense_id IN (${ids});DELETE FROM public.income_expenses WHERE id IN (${ids});DELETE FROM public.contracts WHERE id IN (${all});`);
 if(deniedActor){mutation(`DELETE FROM public.member_override_scopes WHERE override_id IN (SELECT id FROM public.member_permission_overrides WHERE membership_id=${lit(member)});DELETE FROM public.member_permission_overrides WHERE membership_id=${lit(member)};DELETE FROM public.organization_memberships WHERE id=${lit(member)};`);const r=await fetch(`${ctx.url}/auth/v1/admin/users/${deniedActor}`,{method:'DELETE',headers:{apikey:ctx.cred.testSecretKey,Authorization:`Bearer ${ctx.cred.testSecretKey}`}});assert.equal(r.status,200);}
 assert.equal(psqlJson(ctx.test,`select count(*)::int n from public.contracts where id in (${all})`)[0].n,0);
 writeFileSync('.superpowers/sdd/2026-09-29-commission-failure-retry/task-1-jwt-report.json',JSON.stringify({date:new Date().toISOString(),target:ctx.cred.testRef,passed:passes,cleanup:true,migration_sha256:createHash('sha256').update(readFileSync('supabase/migrations/20260929154941_commission_failure_retry.sql')).digest('hex')},null,2));
}
console.log(`PASS ${passes.length} actual TEST JWT/concurrency cases; fixtures cleaned`);
