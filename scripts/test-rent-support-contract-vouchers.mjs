// Actual JWT + concurrent PostgREST regression, only guarded TEST synthetic data.
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, delimiter } from 'node:path';
import { testConnection, signInTest, request } from './test-voucher-detail-read-authz.mjs';
import { psql, psqlJson, lit } from './test-env/lib.mjs';
import { matKhauTest } from './test-env/hau-ky.mjs';
process.env.PATH=dirname(process.execPath)+delimiter+process.env.PATH;
const root='outputs/rent-support-contract-vouchers/';mkdirSync(root,{recursive:true});
const ctx=await testConnection();assert.equal(ctx.cred.testRef,'hzulujxgonszuleqticb');
const f={org:randomUUID(),marker:'contract-vouchers-'+randomUUID(),building:randomUUID(),otherBuilding:randomUUID(),scope:randomUUID(),room:randomUUID(),account:randomUUID(),actors:[],contracts:[]};
const save=()=>writeFileSync(root+'fixture.json',JSON.stringify(f,null,2));
const flag=psqlJson(ctx.test,"SELECT pg_get_functiondef('app_private.rent_support_writers_enabled_v1()'::regprocedure) definition")[0].definition;
writeFileSync(root+'flag-before.sql',flag);
const lane=(file)=>{const result=spawnSync(process.execPath,['scripts/test-env/thu-sql.mjs',root+file,'--ghi'],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stdout+result.stderr);};
const fixture=sql=>psql(ctx.test,'BEGIN;SET LOCAL session_replication_role=replica;'+sql+'COMMIT;');
const tokens={},cases=[];
const post=async(name,body,role='creator')=>{const r=await request(ctx,tokens[role],'rpc/'+name,body);assert.equal(r.status,200,name+' '+JSON.stringify(r.json));return r.json;};
const pass=name=>{cases.push(name);console.log('PASS '+name);};
const plan=(policy='COMMISSION_ONLY')=>({version:2,start_billing_month:'2026-09',payer:'SALE',sale_party_id:null,deduction_policy:policy,collection_mode:'UPFRONT_COMMITTED',segments:[{month_count:3,monthly_amount:'300000'},{month_count:9,monthly_amount:'100000'}]});
async function subject({commission='3000000',bonus='500000',policy='COMMISSION_ONLY',bonusParty=f.otherParty,account=f.account,contract=randomUUID(),payer='SALE',legacy=false}={}){
 const support={...plan(policy),payer,sale_party_id:null},room=randomUUID();f.contracts.push(contract);writeFileSync(root+'fixture.json',JSON.stringify(f,null,2));
 fixture(`INSERT INTO public.rooms(id,organization_id,building_id,name,rent_price,deposit_amount,status) VALUES(${lit(room)},${lit(f.org)},${lit(f.building)},${lit('Task6 '+room)},5000000,0,'AVAILABLE');INSERT INTO public.contracts(id,organization_id,user_id,room_id,status,signed_date,start_date,end_date,rent_price,total_deposit,public_code,contract_number,notes) VALUES(${lit(contract)},${lit(f.org)},${lit(f.actors[0].id)},${lit(room)},'ACTIVE','2026-09-01','2026-09-01','2027-09-01',5000000,0,${lit('task6-'+contract)},${lit('T6-'+contract.slice(0,8))},${lit(f.marker)});`);
 if(!legacy)psql(ctx.test,`BEGIN;SELECT set_config('request.jwt.claim.sub',${lit(f.actors[0].id)},true);SELECT app_private.persist_contract_rent_support_v1(${lit(f.org)},${lit(contract)},${lit(JSON.stringify(support))}::jsonb);COMMIT;`);
 const payload={version:3,intents:[['COMMISSION',commission,f.party],['BONUS',bonus,bonusParty]].filter(([,amount])=>amount!=='0').map(([kind,gross,party])=>({action:'ISSUE_NEW',intent_id:randomUUID(),source_id:null,kind,party_id:party,gross_amount:gross,route:'CASHBOOK',manager_id:null,account_id:account,voucher_date:'2026-09-30',payer_name:'Synthetic payer',recipient_name:'Synthetic verified recipient',recipient_bank:null,recipient_account:null,item_description:'Task6 synthetic entitlement',attachments:[]}))};
 return {contract,room,support,payload,request:randomUUID()};
}
const quote=async s=>post('quote_contract_rent_support_v1',{p_organization_id:f.org,p_contract_id:s.contract,p_draft_id:null,p_payload:s.support,p_invoice_context:null,p_payout_context:s.payload});
const args=(s,q)=>({p_organization_id:f.org,p_contract_id:s.contract,p_plan_revision:1,p_quote_hash:q.quote_hash,p_payload:s.payload,p_request_id:s.request});
const prepare=async(s,q)=>post('prepare_contract_payouts_with_support_v1',args(s,q));
async function execute(s,q){const r=await post('create_contract_payouts_with_support_v1',args(s,q));if(r.status==='FAILED'){const reason=psqlJson(ctx.test,`SELECT reason FROM app_private.rent_support_payout_executions WHERE operation_id=${lit(r.operation_id)} AND outcome='FAILED' ORDER BY created_at DESC LIMIT 1`)[0];throw Error('Unexpected bundle failure '+reason?.reason);}return r;}

try {
 for(const role of ['creator','retry','denied']) {
  const email=`${f.marker}-${role}@example.invalid`,password=matKhauTest(ctx.cred.passwordSeed,email);
  const r=await fetch(ctx.url+'/auth/v1/admin/users',{method:'POST',headers:{apikey:ctx.cred.testSecretKey,Authorization:'Bearer '+ctx.cred.testSecretKey,'Content-Type':'application/json'},body:JSON.stringify({email,password,email_confirm:true})});assert.equal(r.status,200,'synthetic auth creation');
  const a={id:(await r.json()).id,email,role,membership:randomUUID()};f.actors.push(a);save();
 }
 const actor=f.actors[0].id;
 let sql=`INSERT INTO public.organizations(id,slug,name) VALUES(${lit(f.org)},${lit(f.marker)},${lit(f.marker)});
 INSERT INTO public.buildings(id,organization_id,user_id,name,status,province,district,ward,commission_tiers) VALUES(${lit(f.building)},${lit(f.org)},${lit(actor)},${lit(f.marker)},'ACTIVE','','','','[{"min_months":12,"max_months":12,"rate_percent":60}]'),(${lit(f.otherBuilding)},${lit(f.org)},${lit(actor)},'Task6 negative building','ACTIVE','','','','[]');
 INSERT INTO public.authorization_scopes(id,organization_id,scope_type,building_id) VALUES(${lit(f.scope)},${lit(f.org)},'BUILDING',${lit(f.building)});
 INSERT INTO public.rooms(id,organization_id,building_id,name,rent_price,deposit_amount,status) VALUES(${lit(f.room)},${lit(f.org)},${lit(f.building)},'Task6 synthetic room',5000000,0,'AVAILABLE');
 INSERT INTO public.accounts(id,user_id,organization_id,name,code,initial_amount,initial_date) VALUES(${lit(f.account)},${lit(actor)},${lit(f.org)},${lit(f.marker)},${lit('TASK6-'+f.account)},0,'2026-09-01');
 INSERT INTO public.organization_invoice_settings(organization_id,auto_approve_invoice,updated_by) VALUES(${lit(f.org)},false,${lit(actor)});`;
 for(const a of f.actors) {
  sql+=`INSERT INTO public.organization_memberships(id,organization_id,user_id,member_type,status,valid_from) VALUES(${lit(a.membership)},${lit(f.org)},${lit(a.id)},'STAFF','ACTIVE',now()-interval '1 day');`;
  if(a.role==='denied')continue;
  for(const permission of ['contracts.view','contracts.create','contracts.edit','income_expenses.view','income_expenses.create','income_expenses.approve','buildings.view','rooms.view','invoices.view','invoices.create','invoices.edit','invoices.delete']) {const key=randomUUID();sql+=`INSERT INTO public.member_permission_overrides(id,organization_id,membership_id,permission_key,effect,reason,scope_mode) VALUES(${lit(key)},${lit(f.org)},${lit(a.membership)},${lit(permission)},'ALLOW',${lit(f.marker)},'SCOPED');INSERT INTO public.member_override_scopes(organization_id,override_id,scope_id) VALUES(${lit(f.org)},${lit(key)},${lit(f.scope)});`;}
 }
 psql(ctx.test,'BEGIN;SET LOCAL session_replication_role=replica;'+sql+'COMMIT;');
 const session=await signInTest(ctx,f.actors[0].email,matKhauTest(ctx.cred.passwordSeed,f.actors[0].email));
 const party=await request(ctx,session.access_token,'rpc/register_rent_support_party_v1',{p_organization_id:f.org,p_building_id:f.building,p_profile_id:null,p_display_name:'Task6 verified support party',p_reason:'Synthetic TEST identity verification',p_request_id:randomUUID()});assert.equal(party.status,200,JSON.stringify(party.json));f.party=party.json.party_id;
 const other=await request(ctx,session.access_token,'rpc/register_rent_support_party_v1',{p_organization_id:f.org,p_building_id:f.building,p_profile_id:null,p_display_name:'Task6 other Sale',p_reason:'Synthetic TEST identity verification',p_request_id:randomUUID()});assert.equal(other.status,200,JSON.stringify(other.json));f.otherParty=other.json.party_id;save();

 for(const a of f.actors)tokens[a.role]=(await signInTest(ctx,a.email,matKhauTest(ctx.cred.passwordSeed,a.email))).access_token;
 writeFileSync(root+'flag-scoped.sql',`CREATE OR REPLACE FUNCTION app_private.rent_support_writers_enabled_v1() RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$ SELECT COALESCE(auth.uid()=ANY(ARRAY[${f.actors.filter(a=>a.role!=='denied').map(a=>lit(a.id)+'::uuid').join(',')}]),false) $$;`);
 lane('flag-scoped.sql');
 fixture(`INSERT INTO app_private.commission_tier_versions(organization_id,building_id,effective_from_month,min_months,max_months,rate_percent,status,created_by) VALUES(${lit(f.org)},${lit(f.building)},'2026-09-01',12,12,60,'PUBLISHED',${lit(f.actors[0].id)});`);
 if(!process.argv.includes('--remaining')) {
 for(const policy of ['COMMISSION_ONLY','BONUS_THEN_COMMISSION']) {
  const s=await subject({policy}),q=await quote(s);assert.equal(q.state,'READY',JSON.stringify(q.issues));
  assert.equal(q.sources.find(x=>x.kind==='COMMISSION').current_withheld,policy==='COMMISSION_ONLY'?'1800000':'1300000');
  assert.equal(q.sources.find(x=>x.kind==='BONUS').current_withheld,policy==='COMMISSION_ONLY'?'0':'500000');
  await prepare(s,q);const receipt=await execute(s,q);assert.equal(receipt.status,'COMPLETED');
  assert.deepEqual(await execute(s,q),receipt);
  assert.deepEqual(await post('read_contract_payout_request_v1',{p_organization_id:f.org,p_request_id:s.request}),receipt);
  const totals=psqlJson(ctx.test,`SELECT count(*) n,sum(amount)::text amount FROM app_private.rent_support_withholding_events WHERE operation_id=${lit(receipt.operation_id)} AND action='COMMITTED'`)[0];
  assert.equal(totals.amount,'1800000');assert.equal(totals.n,policy==='COMMISSION_ONLY'?1:2);
  const count=psqlJson(ctx.test,`SELECT count(*) n FROM public.income_expenses WHERE contract_id=${lit(s.contract)} AND organization_id=${lit(f.org)} AND type='EXPENSE'`)[0].n;
  assert.equal(count,policy==='COMMISSION_ONLY'?2:1);
  const changed=structuredClone(s);changed.request=randomUUID();changed.payload.intents.forEach(i=>i.intent_id=randomUUID());assert.equal((await quote(changed)).state,'NEEDS_REVIEW');
  pass(policy+': exact upfront withholding, ordinary different recipients, read/retry one bundle');
 }
 const building=await subject({payer:'BUILDING'}),bq=await quote(building);assert.equal(bq.state,'READY');assert(bq.sources.every(s=>s.current_withheld==='0'));await prepare(building,bq);assert.equal((await execute(building,bq)).status,'COMPLETED');pass('building pays: vouchers retain gross');
 const short=await subject({commission:'1500000',bonus:'0'}),sq=await quote(short);assert.equal(sq.state,'NEEDS_REVIEW');assert.equal(sq.unallocated,'300000');assert.equal((await request(ctx,tokens.creator,'rpc/prepare_contract_payouts_with_support_v1',args(short,sq))).json.code,'PT409');pass('insufficient source cannot prepare payment');
 const race=await subject(),second=structuredClone(race);second.request=randomUUID();second.payload.intents.forEach(i=>i.intent_id=randomUUID());
 const [qa,qb]=await Promise.all([quote(race),quote(second)]);await prepare(race,qa);await prepare(second,qb);
 const raced=await Promise.all([request(ctx,tokens.creator,'rpc/create_contract_payouts_with_support_v1',args(race,qa)),request(ctx,tokens.retry,'rpc/execute_contract_payout_operation_v1',{p_organization_id:f.org,p_operation_id:(await prepare(second,qb)).operation_id})]);
 assert.deepEqual(raced.map(x=>x.status).sort(),[200,409]);assert.equal(raced.find(x=>x.status===200).json.status,'COMPLETED');
 assert.equal(psqlJson(ctx.test,`SELECT count(*) n FROM app_private.rent_support_payout_sources WHERE organization_id=${lit(f.org)} AND contract_id=${lit(race.contract)}`)[0].n,2);pass('two actual concurrent operators create only one bundle');
 }
 const invalid=await subject();invalid.payload.intents[0].source_id=randomUUID();invalid.payload.intents.forEach(i=>delete i.action);invalid.payload.version=2;
 assert.equal((await request(ctx,tokens.creator,'rpc/quote_contract_rent_support_v1',{p_organization_id:f.org,p_contract_id:invalid.contract,p_draft_id:null,p_payload:invalid.support,p_invoice_context:null,p_payout_context:invalid.payload})).json.code,'PT409');pass('client cannot substitute a source from another contract');
 const bound=await subject();const legacy={...bound.support,sale_party_id:f.party};
 const lq=await post('quote_contract_rent_support_v1',{p_organization_id:f.org,p_contract_id:bound.contract,p_draft_id:null,p_invoice_context:null,p_payload:{...legacy,deduction_policy:'BONUS_THEN_COMMISSION'},p_payout_context:bound.payload});
 assert.equal(lq.sources.find(x=>x.kind==='BONUS').current_withheld,'0');pass('existing explicit party binding still excludes a different payee');
 for(const body of [{p_organization_id:f.org,p_contract_id:bound.contract,p_draft_id:null,p_invoice_context:null,p_payload:bound.support,p_payout_context:bound.payload},{p_organization_id:'aaaa0000-0000-4000-8000-000000000001',p_contract_id:bound.contract,p_draft_id:null,p_invoice_context:null,p_payload:bound.support,p_payout_context:bound.payload}]) {
  const r=await request(ctx,tokens.denied,'rpc/quote_contract_rent_support_v1',body);assert.equal(r.status,403);assert.equal(r.json.code,'42501');
 }
 pass('actual JWT denied role and cross-organization calls remain denied');
 if(process.argv.includes('--browser')) {
  const browserSubject=await subject({bonus:'0'});
  const session=await signInTest(ctx,f.actors[0].email,matKhauTest(ctx.cred.passwordSeed,f.actors[0].email));
  const {runBrowser}=await import('./test-rent-support-contract-vouchers-ui.mjs');
  await runBrowser(ctx,f,browserSubject,session);pass('headless actual TEST app ordinary voucher recipient → upfront net payout');
 }
 console.log('All database regression cases passed');
} finally {
 lane('flag-before.sql');
 assert.equal(psqlJson(ctx.test,"SELECT pg_get_functiondef('app_private.rent_support_writers_enabled_v1()'::regprocedure) definition")[0].definition,flag);
 assert(psqlJson(ctx.test,`SELECT name FROM public.organizations WHERE id=${lit(f.org)}`).every(x=>x.name===f.marker));
 const tables=psqlJson(ctx.test,`SELECT n.nspname schema,c.relname name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid WHERE c.relkind='r' AND n.nspname IN ('public','app_private') AND a.attname='organization_id' AND NOT a.attisdropped ORDER BY 1,2`);
 const ident=x=>'"'+x.replaceAll('"','""')+'"';
 fixture(tables.map(t=>`DELETE FROM ${ident(t.schema)}.${ident(t.name)} WHERE organization_id=${lit(f.org)};`).join('')+`DELETE FROM public.organizations WHERE id=${lit(f.org)};`);
 assert(psqlJson(ctx.test,tables.map(t=>`SELECT count(*) n FROM ${ident(t.schema)}.${ident(t.name)} WHERE organization_id=${lit(f.org)}`).join(' UNION ALL ')).every(x=>x.n===0));
 for(const a of f.actors){const r=await fetch(ctx.url+'/auth/v1/admin/users/'+a.id,{method:'DELETE',headers:{apikey:ctx.cred.testSecretKey,Authorization:'Bearer '+ctx.cred.testSecretKey}});assert([200,404].includes(r.status));}
 writeFileSync(root+'database-report.json',JSON.stringify({project:ctx.cred.testRef,organization:f.org,cases,cleanup:true},null,2));
 console.log('PASS flag restored and all synthetic org rows/actors removed');
}
