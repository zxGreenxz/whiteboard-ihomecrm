#!/usr/bin/env node
// TEST-only: real scoped JWT/PostgREST behavior, concurrency and complete cleanup.
import assert from 'node:assert/strict';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import { testConnection, signInTest, request } from './test-voucher-detail-read-authz.mjs';
import { matKhauTest } from './test-env/hau-ky.mjs';
import { assertTestLease, markTestCleanupRequired, withTestCleanup, withTestLock } from './test-env/lock.mjs';
import { createScopedActor, assertScopedActor } from './lib/commission-e2e-scoped-actor.mjs';

assert.deepEqual(process.argv.slice(2),['--env','test'],'Explicit --env test required');
const connection=await testConnection();
const ORG='aaaa0000-0000-4000-8000-000000000001';
const marker=`reason-${randomBytes(6).toString('hex')}`;
const ids=Array.from({length:4},()=>randomUUID());
const reason='TEST: điều chỉnh theo thỏa thuận đã xác nhận';
const report={at:new Date().toISOString(),target:connection.cred.testRef,migrationSha256:createHash('sha256').update(readFileSync('supabase/migrations/20261011074456_commission_reason_audit_flow.sql')).digest('hex'),fixture:{marker,contracts:ids},checks:[],cleanup:false};
const reportPath=resolve('.superpowers/commission-reason-audit/jwt-result.json');
const checkpoint=()=>{mkdirSync(dirname(reportPath),{recursive:true});writeFileSync(reportPath,JSON.stringify(report,null,2));};
let db,actor,session,existingTypes=[];
const rpc=(name,body,token=session.access_token)=>request(connection,token,`rpc/${name}`,body);
const ok=async(name,body)=>{const r=await rpc(name,body);assert.equal(r.status,200,`${name}: HTTP ${r.status} ${r.json?.code??''} ${r.json?.message??''}`);return r.json;};
const deny=async(name,body,code)=>{const r=await rpc(name,body);assert.equal(r.json?.code,code,`${name}: expected ${code}, HTTP ${r.status} ${r.json?.code??''}`);};
const check=async(name,fn)=>{report.currentCheck=name;checkpoint();await fn();report.checks.push(name);checkpoint();console.log(`PASS ${name}`);};
const intent=(contract,amount=1111111,why=reason)=>({contract_id:contract,request_id:randomUUID(),kind:'broker',amount,voucher_date:'2026-10-11',item_description:'TEST commission reason',commission_reason:why});
const prepare=p=>ok('prepare_commission_requests_v1',{p_organization_id:ORG,p_intents:[p]});
const execute=p=>ok('execute_commission_request_v1',{p_organization_id:ORG,p_contract_id:p.contract_id,p_kind:p.kind,p_request_id:p.request_id});
const history=id=>ok('read_commission_interventions_v1',{p_voucher_id:id});
const intervene=(id,stage,payload,why=reason)=>ok('intervene_commission_v1',{p_voucher_id:id,p_stage:stage,p_reason:why,p_payload:payload});

async function clean(lease){
 await assertTestLease(lease,connection.test);
 await db.query('rollback');await db.query('begin');await db.query('set local session_replication_role=replica');
 const vouchers=(await db.query('select id from income_expenses where contract_id=any($1::uuid[])',[ids])).rows.map(r=>r.id);
 const newTypes=(await db.query(`select id from income_expense_types t where not(id=any($1::uuid[])) and
  (user_id=$2 or exists(select 1 from income_expense_items i where i.income_expense_type_id=t.id and i.income_expense_id=any($3::uuid[])))`,[existingTypes,actor?.id??null,vouchers])).rows.map(r=>r.id);
 assert.equal((await db.query('select count(*)::int n from income_expense_items where income_expense_type_id=any($1::uuid[]) and not(income_expense_id=any($2::uuid[]))',[newTypes,vouchers])).rows[0].n,0,'fixture type cannot have unrelated references');
 const accounts=actor?(await db.query('select id from accounts where user_id=$1',[actor.id])).rows.map(r=>r.id):[];
 const overrides=actor?(await db.query('select id from member_permission_overrides where membership_id=$1',[actor.membershipId])).rows.map(r=>r.id):[];
 const exactIds=[...ids,...vouchers,...newTypes,...accounts,...overrides,...(actor?[actor.id,actor.membershipId,actor.accountId]:[])];
 assert(!exactIds.includes(ORG),'never delete shared org');
 const targets=(await db.query(`select n.nspname,c.relname,array_agg(a.attname::text) cols from pg_class c join pg_namespace n on n.oid=c.relnamespace
  join pg_attribute a on a.attrelid=c.oid where n.nspname in('public','app_private') and c.relkind in('r','p') and not c.relispartition
  and a.attnum>0 and not a.attisdropped and a.atttypid='uuid'::regtype group by n.nspname,c.relname`)).rows;
 const q=s=>`"${s.replaceAll('"','""')}"`;
 const retained=['public.income_expense_audit_log','app_private.commission_intervention_events','app_private.income_expense_flow_ownership_events','app_private.income_expense_audit_chain_heads'];
 const guards=(await db.query("select tgrelid::regclass::text table_name,tgname,tgenabled from pg_trigger where not tgisinternal and tgenabled='A' order by 1,2")).rows;
 for(const t of targets.filter(t=>!retained.includes(`${t.nspname}.${t.relname}`)))await db.query(`delete from ${q(t.nspname)}.${q(t.relname)} where ${t.cols.map(c=>`${q(c)}=any($1::uuid[])`).join(' or ')}`,[exactIds]);
 for(const t of targets.filter(t=>!retained.includes(`${t.nspname}.${t.relname}`)))assert.equal((await db.query(`select count(*)::int n from ${q(t.nspname)}.${q(t.relname)} where ${t.cols.map(c=>`${q(c)}=any($1::uuid[])`).join(' or ')}`,[exactIds])).rows[0].n,0);
 await db.query('commit');
 if(actor){const r=await fetch(`${connection.url}/auth/v1/admin/users/${actor.id}`,{method:'DELETE',headers:{apikey:connection.cred.testSecretKey,Authorization:`Bearer ${connection.cred.testSecretKey}`}});assert.equal(r.status,200);}
 assert.deepEqual((await db.query("select tgrelid::regclass::text table_name,tgname,tgenabled from pg_trigger where not tgisinternal and tgenabled='A' order by 1,2")).rows,guards);
 report.retainedAudit=[];
 for(const t of targets.filter(t=>retained.includes(`${t.nspname}.${t.relname}`)))report.retainedAudit.push({table:`${t.nspname}.${t.relname}`,count:(await db.query(`select count(*)::int n from ${q(t.nspname)}.${q(t.relname)} where ${t.cols.map(c=>`${q(c)}=any($1::uuid[])`).join(' or ')}`,[exactIds])).rows[0].n});
 report.cleanup=true;report.cleaned={contracts:ids.length,vouchers:vouchers.length,types:newTypes.length,actor:!!actor};
}

try{
 await withTestLock(connection,async lease=>{
  db=new pg.Client({host:connection.cred.testPoolerHost,port:5432,user:`postgres.${connection.cred.testRef}`,password:connection.cred.testDbPassword,database:'postgres',ssl:{rejectUnauthorized:false}});
  await db.connect();assert.equal((await db.query('select ref from test_env.danh_dau limit 1')).rows[0]?.ref,connection.cred.testRef);
  const ownerRow=(await db.query("select u.email,u.id from organization_memberships m join auth.users u on u.id=m.user_id where m.organization_id=$1 and m.member_type='OWNER' and m.status='ACTIVE' order by m.id limit 1",[ORG])).rows[0];assert(ownerRow);
  const owner=await signInTest(connection,ownerRow.email,matKhauTest(connection.cred.passwordSeed,ownerRow.email));
  const scope=await request(connection,owner.access_token,'rpc/list_contract_commission_followups_v2',{p_organization_id:ORG,p_unresolved_only:false,p_limit:100});assert.equal(scope.status,200);
  const seed=scope.json.rows.find(r=>r.can_manage);assert(seed);
  existingTypes=(await db.query('select id from income_expense_types')).rows.map(r=>r.id);
  markTestCleanupRequired(lease,connection.test);
  try{
   session=await createScopedActor({ctx:connection,db,organizationId:ORG,buildingId:seed.building_id,ownerId:owner.user.id,marker,record:r=>{actor=r;report.fixture.actor=r;checkpoint();}});
   const authScope=(await db.query("select id from authorization_scopes where organization_id=$1 and scope_type='BUILDING' and building_id=$2",[ORG,seed.building_id])).rows[0];
   await db.query(`with added as(insert into member_permission_overrides(organization_id,membership_id,permission_key,effect,reason,created_by,scope_mode)
    select $1,$2,k,'ALLOW',$3,$4,'SCOPED' from unnest(array['income_expenses.edit']) k returning id)
    insert into member_override_scopes(organization_id,override_id,scope_id) select $1,id,$5 from added`,[ORG,actor.membershipId,marker,owner.user.id,authScope.id]);
   await db.query('begin');await db.query('set local session_replication_role=replica');
   for(const [index,id]of ids.entries())await db.query(`insert into contracts(id,user_id,room_id,organization_id,status,signed_date,start_date,end_date,rent_price,public_code,contract_number)
    select $1,$2,room_id,organization_id,'TERMINATED','2026-01-01','2026-01-01','2026-11-30',2000000,$3,$3 from contracts where id=$4`,[id,actor.id,`${marker}-${index}`,seed.contract_id]);
   await db.query('commit');
   await check('scoped JWT sees fixture and denies other building',async()=>{report.scope=await assertScopedActor({ctx:connection,db,session,organizationId:ORG,buildingId:seed.building_id,fixtureContractId:ids[0]});});
   const p=intent(ids[0]);
   await check('override missing reason rejected before prepare, direct old writer cannot bypass',async()=>{
    await deny('prepare_commission_requests_v1',{p_organization_id:ORG,p_intents:[{...p,commission_reason:null}]},'22023');
    await deny('create_commission_voucher',{p_contract_id:ids[0],p_kind:'broker',p_amount:p.amount,p_voucher_date:p.voucher_date},'22023');
   });
   await prepare(p);let voucher;
   await check('prepared explanation is readable before voucher creation',async()=>{
    const result=await ok('list_contract_commission_followups_v2',{p_organization_id:ORG,p_contract_ids:[p.contract_id],p_unresolved_only:false});
    const row=result.rows.find(r=>r.kind===p.kind);assert.equal(row.request_id,p.request_id);assert.equal(row.voucher_id,null);
    assert.equal(row.preparation?.reason,reason);assert.equal(row.preparation?.request_id,p.request_id);assert.equal(row.preparation?.stage,'PREPARE');assert(row.preparation.created_at);
   });
   await check('two concurrent executions return the same exact voucher',async()=>{
    const results=await Promise.all([execute(p),execute(p)]);assert.equal(results[0].status,'COMPLETED');assert.deepEqual(results[0],results[1]);voucher=results[0].id;assert(voucher);
    assert.equal((await db.query('select count(*)::int n from income_expenses where contract_id=$1 and commission_kind=$2',[p.contract_id,p.kind])).rows[0].n,1);
   });
   await check('lost response replay and reason-conflict preserve immutable request',async()=>{
    assert.equal((await execute(p)).id,voucher);await deny('prepare_commission_requests_v1',{p_organization_id:ORG,p_intents:[{...p,commission_reason:'TEST: nội dung khác sau khi lưu'}]},'PT409');
   });
   await check('legacy request without baseline replays an existing live lifecycle',async()=>{
    const legacy=intent(ids[0]);const {request_id,commission_reason,...payload}=legacy;
    await db.query('insert into contract_commission_requests(organization_id,contract_id,kind,request_id,payload,actor_id) values($1,$2,$3,$4,$5,$6)',[ORG,legacy.contract_id,legacy.kind,request_id,payload,actor.id]);
    const result=await execute(legacy);assert.equal(result.id,voucher);assert.equal(result.status,'ALREADY_EXISTS');
    assert.equal((await db.query('select count(*)::int n from income_expenses where contract_id=$1',[legacy.contract_id])).rows[0].n,1);
   });
   await check('read history contains authoritative actor time baseline and reason',async()=>{
    const events=await history(voucher);const created=events.find(e=>e.stage==='CREATE'&&e.scope==='VOUCHER');assert(created);assert.equal(created.reason,reason);assert.equal(created.actor_id,actor.id);assert(created.at);assert.equal(created.baseline.submitted_amount,p.amount);assert.equal(created.baseline.months,10);
    assert(events.some(e=>e.stage==='PREPARE'));
   });
   await check('annotation requires reason; dispatcher logs it with before and after',async()=>{
    await deny('annotate_income_expense_v1',{p_voucher:voucher,p_notes:'TEST changed'},'22023');
    await intervene(voucher,'ANNOTATE',{notes:'TEST changed',note_mode:'APPEND',idempotency_key:randomUUID()});
    assert((await history(voucher)).some(e=>e.stage==='ANNOTATE'&&e.reason===reason));
   });
   await check('other building and other organization history remain unavailable',async()=>{
    const foreign=(await db.query(`select id from income_expenses where deleted_at is null and organization_id<>$1 limit 1`,[ORG])).rows[0];assert(foreign);
    await deny('read_commission_interventions_v1',{p_voucher_id:foreign.id},'42501');
    const other=(await db.query('select id from income_expenses where organization_id=$1 and building_id<>$2 and deleted_at is null limit 1',[ORG,seed.building_id])).rows[0];assert(other);
    await deny('intervene_commission_v1',{p_voucher_id:other.id,p_stage:'ANNOTATE',p_reason:reason,p_payload:{notes:'No write'}},'42501');
   });
   await check('changed contract basis needs explanation and invalidates prepared snapshot',async()=>{
    const pending=intent(ids[1]);await prepare(pending);
    const patch=async body=>{const r=await fetch(`${connection.url}/rest/v1/contracts?id=eq.${ids[1]}`,{method:'PATCH',headers:{apikey:connection.cred.testPublishableKey,Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json','Content-Profile':'public','Accept-Profile':'public',Prefer:'return=representation'},body:JSON.stringify(body)});return {status:r.status,json:await r.json()};};
    const denied=await patch({rent_price:2100000});assert.equal(denied.json.code,'22023',JSON.stringify(denied));
    const changed=await patch({rent_price:2100000,commission_change_reason:reason});assert.equal(changed.status,200,JSON.stringify(changed));assert.equal(changed.json[0].commission_change_reason,null);
    assert.equal((await execute(pending)).status,'FAILED');
    const failed=(await ok('list_contract_commission_followups_v2',{p_organization_id:ORG,p_contract_ids:[pending.contract_id],p_unresolved_only:false})).rows.find(r=>r.kind===pending.kind);
    assert.equal(failed.state,'FAILED');assert(failed.last_reason.includes('Cơ sở hoa hồng đã thay đổi'));
    const replacement=intent(ids[1]);await prepare(replacement);const v=await execute(replacement);assert.equal(v.status,'COMPLETED');assert((await history(v.id)).some(e=>e.stage==='REPREPARE'));
   });
   await check('ordinary voucher returns empty history; contexts clean at transaction end',async()=>{
    const ordinary=(await db.query("select id from income_expenses where user_id=$1 and organization_id=$2 and commission_kind is null and system_source is null limit 1",[actor.id,ORG])).rows[0];
    if(ordinary)assert.deepEqual(await history(ordinary.id),[]);
    assert.equal((await db.query('select count(*)::int n from app_private.commission_reason_contexts where actor_id=$1',[actor.id])).rows[0].n,0);
   });
  }catch(error){report.behaviorFailure=String(error.message);checkpoint();throw error;}
  finally{await withTestCleanup(lease,connection.test,clean);}
 });
 report.status='PASS';
}catch(error){report.status='FAIL';report.failure=String(error.message).replaceAll(connection.cred.testDbPassword,'[secret]');process.exitCode=1;}
finally{await db?.end();mkdirSync(dirname(reportPath),{recursive:true});writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,checks:report.checks.length,cleanup:report.cleanup,report:reportPath,failure:report.failure}));}
