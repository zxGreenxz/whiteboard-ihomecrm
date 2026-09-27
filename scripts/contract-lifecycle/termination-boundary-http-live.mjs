// Committed TEST fixtures only; finite cleanup rehearsed before any durable seed.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {docVault} from '../test-env/lib.mjs';
import {loadTestCredentialsFromVault,withTestTransaction,createTestHttp} from './transport.mjs';
import {seedLegacy,legacySnapshot} from './legacy-entrypoints-live.mjs';
import {triggerDigest} from './legacy-fixture-cleanup.mjs';
import {cleanupBoundary} from './termination-boundary-live.mjs';
import {observeLegacyApprovalCalls} from './legacy-entrypoints.mjs';

assert(process.argv.includes('--test-commit'),'Explicit --test-commit required');
const dir='.superpowers/sdd/2026-09-27-contract-lifecycle/';
const config=await loadTestCredentialsFromVault();config.db.ca=readFileSync(dir+'supabase-ca.crt','utf8');
const vault=docVault(),field=k=>process.env[k]||vault.match(new RegExp('(?:^|\\s)'+k+'=([^\\s`]+)','m'))?.[1];
const migration=readFileSync('supabase/migrations/20260927190750_termination_write_boundary.sql','utf8');
const e={kind:'REAL_JWT_BOUNDARY_TEST',checks:[],fixtures:[]};
const save=()=>writeFileSync(dir+'p1a2-http.json',JSON.stringify(e,null,2)+'\n');
const txn=(run,commit=false)=>withTestTransaction(config,{run,commit});
const snapshot=f=>withTestTransaction(config,{readOnly:true,run:ctx=>legacySnapshot(ctx,f)});
let guards,baselines;
try {
  await txn(async ctx=>{await ctx.query(migration);await ctx.query(migration);const digest=await triggerDigest(ctx);const before=(await ctx.query("SELECT id,total_rooms FROM public.buildings WHERE organization_id='dddd0000-0000-4000-8000-000000000001'")).rows;
    const f=await seedLegacy(ctx,{status:'ACTIVE',draftAdapter:true});await ctx.query('SELECT public.approve_contract_termination_v1($1,NULL)',[f.termination]);
    e.rehearsal=await cleanupBoundary(ctx,[f],digest,before.filter(b=>b.id===f.building));
    const absent=await seedLegacy(ctx,{status:'ACTIVE',omitTermination:true});
    e.absentRehearsal=await cleanupBoundary(ctx,[absent],digest,before.filter(b=>b.id===absent.building));
  });
  await txn(async ctx=>{await ctx.query(migration);await ctx.query(migration);},true);
  e.schema='TEST committed, twice idempotent';save();
  await withTestTransaction(config,{readOnly:true,run:async ctx=>{
    guards=await triggerDigest(ctx);baselines=(await ctx.query("SELECT id,total_rooms FROM public.buildings WHERE organization_id='dddd0000-0000-4000-8000-000000000001'")).rows;
    e.constraints=(await ctx.query("SELECT conrelid::regclass::text AS relation,conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid IN ('app_private.termination_write_capabilities'::regclass,'app_private.canonical_write_operations'::regclass) ORDER BY 1,2")).rows;
  }});
  await withTestTransaction(config,{readOnly:true,run:async verified=>{
    try {
    const http=createTestHttp(config,{verified,apiKey:field('TEST_SUPABASE_PUBLISHABLE_KEY')});
    const token=await http.signIn({email:'demo.chunha@username.ihomecrm.local',password:field('FLEET_PASS_CHUNHA')});
    const call=(name,args,allowEmpty=false)=>http.rpc(name,args,{token,allowEmpty});
    const draftArgs=f=>({p_contract_id:f.contract,p_move_out_date:'2026-09-28',p_idempotency_key:f.marker+':http',p_total_deposit:0,p_outstanding_debt:0,p_notes:f.marker});
    const seed=async(name,{draft=true,deduction=0}={})=>{
      const f=await txn(ctx=>seedLegacy(ctx,{status:'ACTIVE',draftAdapter:draft,omitTermination:!draft,deduction,marker:'p1a2-'+randomUUID()}),true);f.name=name;e.fixtures.push(f);save();return f;
    };
    const f=await seed('http-draft',{draft:false});
    const created=await call('create_contract_termination_draft_v1',draftArgs(f));f.termination=created.termination_id;save();
    assert.deepEqual(await call('create_contract_termination_draft_v1',draftArgs(f)),created);
    await assert.rejects(call('create_contract_termination_draft_v1',{...draftArgs(f),p_total_deposit:1}),/23505/);
    e.checks.push({name:'JWT-draft-positive-replay-conflict',status:'PASS'});
    const original=await snapshot(f);
    // This fixed table endpoint uses the already-admitted TEST target and JWT.
    for(const [method,body]of [['POST',{contract_id:f.contract,user_id:f.actor,organization_id:f.organizationId,actual_move_out_date:'2026-09-28',termination_type:'NORMAL',total_deposit:0}],['PATCH',{damage_fee:1}],['DELETE',undefined]]) {
      const response=await fetch(config.url+'/rest/v1/contract_terminations'+(method==='POST'?'':'?id=eq.'+f.termination),{method,headers:{apikey:field('TEST_SUPABASE_PUBLISHABLE_KEY'),Authorization:'Bearer '+token,'Content-Type':'application/json','Content-Profile':'public','Accept-Profile':'public'},body:body===undefined?undefined:JSON.stringify(body)});
      const code=(await response.json()).code;e.lastWrite={method,status:response.status,code};assert.equal(response.ok,false);assert.equal(code,'42501');assert.deepEqual(await snapshot(f),original);
      e.checks.push({name:'JWT-direct-'+method,status:'PASS'});
    }
    for(const reason of ['first','second'])await call('reject_contract_termination_v1',{p_termination_id:f.termination,p_reason:reason},true);
    assert.equal((await snapshot(f)).terminations[0].notes,'[Từ chối] second');
    e.checks.push({name:'JWT-reject-repeat',status:'PASS'});
    for(const [name,raw] of [['same-approve',null],['raw-credit-forfeit','forfeit'],['raw-credit-moveout','move_out'],['approve-forfeit','forfeit'],['reject-moveout','move_out']]) {
      const isRaw=name.startsWith('raw-credit');
      const race=await seed(name,{draft:!isRaw,deduction:name==='same-approve'||name==='approve-forfeit'?100:0});
      const rawArgs={p_contract_id:race.contract,...(raw==='forfeit'?{p_forfeit_date:'2026-09-28',p_extra_charges:[]}:{p_move_out_date:'2026-09-28',p_deposit_refund:0,p_penalty_fee:0,p_excess_rent:0,p_outstanding_debt:0,p_notes:null,p_extra_charges:[],p_shortfall_mode:'PAID',p_receipt_account_id:null,p_refund_items:[]})};
      const approve=()=>call('approve_contract_termination_v1',{p_termination_id:race.termination,p_note:'race'});
      const reject=()=>call('reject_contract_termination_v1',{p_termination_id:race.termination,p_reason:'race'},true);
      const rawCall=()=>call('terminate_contract_'+raw,rawArgs);
      let unlock,ready;const release=new Promise(r=>{unlock=r;}),started=new Promise(r=>{ready=r;});
      const holder=txn(async ctx=>{await ctx.query("SET LOCAL statement_timeout='45s'; SET LOCAL lock_timeout='10s'");await ctx.query('SELECT id FROM public.contracts WHERE id=$1 FOR UPDATE',[race.contract]);ready();await release;});
      await Promise.race([holder,started]);
      const calls=Promise.allSettled(name==='same-approve'?[approve(),approve()]:isRaw?[rawCall(),call('terminate_contract_'+raw+'_with_credit_v1',{...rawArgs,p_idempotency_key:race.marker+':credit'})]:[name==='reject-moveout'?reject():approve(),rawCall()]);
      const observed=await observeLegacyApprovalCalls({holder,unlock,calls,pollWaiters:async()=>{
        let count=0;for(let i=0;i<30;i++){
          count=await withTestTransaction(config,{readOnly:true,run:async ctx=>Number((await ctx.query("SELECT count(*) AS n FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND state='active' AND (query LIKE '%terminate_contract_%' OR query LIKE '%approve_contract_termination_v1%')")).rows[0].n)});
          if(count>=(name==='reject-moveout'?1:2))break;await new Promise(r=>setTimeout(r,100));
        }return count;
      }});
      assert(observed.waiters>=(name==='reject-moveout'?1:2));
      const results=observed.results;
      if(name==='same-approve'){assert.equal(results.filter(r=>r.status==='fulfilled').length,2);assert.equal(results.filter(r=>r.value?.noop).length,1);}
      else {assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.match(results.find(r=>r.status==='rejected').reason.message,/P0001|23505/);}
      const after=await snapshot(race);assert.equal(after.terminations.length,1);race.termination=after.terminations[0].id;save();
      assert.equal(after.postings.length,0);assert.equal(after.vouchers.length,name==='same-approve'||name==='approve-forfeit'?1:0);
      if(isRaw){await assert.rejects(rawCall(),/P0001/);assert.deepEqual(await snapshot(race),after);assert.equal(after.terminations[0].user_id,race.actor);}
      e.checks.push({name,status:'PASS',waiters:observed.waiters,outcomes:results.map(r=>r.status==='fulfilled'?'SUCCESS':r.reason.message)});save();
    }
    } catch(error){e.error={message:error.message,code:error.code};throw error;}
  }});
  e.status='PASS';
}catch(error){e.status='FAIL';e.error??={message:error.message,code:error.code};process.exitCode=1;}
finally {
  if(e.fixtures.length)try {
    e.cleanup=await txn(async ctx=>{
      try {
        for(const f of e.fixtures) {
          // Re-read owned roots before restoring test-only notes to their marker.
          const own=await ctx.query('SELECT c.id FROM public.contracts c JOIN public.rooms r ON r.id=c.room_id WHERE c.id=$1 AND c.organization_id=$2 AND r.id=$3 AND r.building_id=$4 AND r.name=$5',[f.contract,f.organizationId,f.room,f.building,f.marker]);assert.equal(own.rowCount,1);
          await ctx.query('UPDATE public.contracts SET notes=$2 WHERE id=$1',[f.contract,f.marker]);
          if(!f.termination){const terms=(await ctx.query('SELECT id FROM public.contract_terminations WHERE contract_id=$1',[f.contract])).rows;assert(terms.length<=1);f.termination=terms[0]?.id??null;}
        }
        return await cleanupBoundary(ctx,e.fixtures,guards,baselines.filter(b=>e.fixtures.some(f=>f.building===b.id)));
      }catch(error){e.cleanupError={message:error.message,code:error.code};throw error;}
    },true);
  }catch{e.status='FAIL';process.exitCode=1;}
  save();console.log(JSON.stringify({status:e.status,checks:e.checks,error:e.error,cleanupError:e.cleanupError,cleanup:e.cleanup?{closure:e.cleanup.closure,deleted:e.cleanup.deleted,guardsUnchanged:e.cleanup.guardsUnchanged}:null}));
}
