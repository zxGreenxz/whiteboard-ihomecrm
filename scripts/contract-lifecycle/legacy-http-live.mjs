// Explicit committed TEST fixtures with reviewed, guard-preserving finite cleanup.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {docVault} from '../test-env/lib.mjs';
import {loadTestCredentialsFromVault,withTestTransaction,createTestHttp} from './transport.mjs';
import {seedLegacy,legacySnapshot} from './legacy-entrypoints-live.mjs';
import {triggerDigest,legacyLedger,cleanupLegacy} from './legacy-fixture-cleanup.mjs';
import {assertApprovalSources} from './legacy-entrypoints.mjs';

assert(process.argv.includes('--test-commit'),'Explicit --test-commit required');
const dir='.superpowers/sdd/2026-09-27-contract-lifecycle/';
const config=await loadTestCredentialsFromVault();config.db.ca=readFileSync(dir+'supabase-ca.crt','utf8');
const vault=docVault(),field=k=>process.env[k]||vault.match(new RegExp('(?:^|\\s)'+k+'=([^\\s`]+)','m'))?.[1];
const apiKey=field('TEST_SUPABASE_PUBLISHABLE_KEY');
const migration=readFileSync('supabase/migrations/20260927180948_approve_termination_eligibility.sql','utf8');
const e={kind:'REAL_JWT_HTTP_TEST_ONLY',target:config.expectedRef,at:new Date().toISOString(),checks:[],fixtures:[]};
const save=()=>writeFileSync(dir+'p1a1-http.json',JSON.stringify(e,null,2)+'\n');
let guards,baselines;
try {
  // Executable admission + cleanup rehearsal before any committed seed.
  await withTestTransaction(config,{run:async ctx=>{
    try {
      guards=await triggerDigest(ctx);baselines=(await ctx.query("SELECT id,total_rooms FROM public.buildings WHERE organization_id='dddd0000-0000-4000-8000-000000000001' ORDER BY id")).rows;
      const f=await seedLegacy(ctx,{status:'ACTIVE'});await ctx.query('SELECT public.approve_contract_termination_v1($1,NULL)',[f.termination]);
      await ctx.query('SET CONSTRAINTS ALL IMMEDIATE');const ledger=await legacyLedger(ctx,[f]);
      e.rehearsal=await cleanupLegacy(ctx,{fixtures:[f],ledger,expectedTriggerDigest:guards,buildingBaselines:baselines.filter(b=>b.id===f.building)});
    } catch(err){e.error={stage:'rehearsal',message:err.message,code:err.code};throw err;}
  }});
  await withTestTransaction(config,{commit:true,run:async ctx=>{await ctx.query(migration);await ctx.query(migration);}});
  e.migration='Committed TEST only; idempotency twice';save();
  for(const [name,status,deduction]of [['same','ACTIVE',100],['ended','TERMINATED',100],['zero','EXTENDED',0]]) {
    const f=await withTestTransaction(config,{commit:true,run:async ctx=>{
      try {
      const fixture=await seedLegacy(ctx,{status,deduction});fixture.name=name;
      await ctx.query('SET CONSTRAINTS ALL IMMEDIATE');return fixture;
      } catch(err){e.error={stage:'seed-'+name,code:err.code,message:err.message};throw err;}
    }});e.fixtures.push(f);save();
  }
  const snapshot=f=>withTestTransaction(config,{readOnly:true,run:ctx=>legacySnapshot(ctx,f)});
  await withTestTransaction(config,{readOnly:true,run:async verified=>{
    const http=createTestHttp(config,{apiKey,verified});
    const token=await http.signIn({email:'demo.chunha@username.ihomecrm.local',password:field('FLEET_PASS_CHUNHA')});
    const call=(id,note='P1a1 HTTP')=>http.rpc('approve_contract_termination_v1',{p_termination_id:id,p_note:note},{token});
    for(const f of e.fixtures) {
      const before=await snapshot(f);
      if(f.name==='ended') {
        await assert.rejects(call(f.termination),/55000/);assert.deepEqual(await snapshot(f),before);e.checks.push({name:'ended-entry',status:'PASS',sqlstate:'55000'});
        continue;
      }
      if(f.name==='zero') {
        const response=await call(f.termination);assertApprovalSources({before,after:await snapshot(f),response,want:0,capped:false});e.checks.push({name:'EXTENDED-zero',status:'PASS'});continue;
      }
      // Hold the actual lower contract lock, dispatch both HTTP transactions,
      // and prove both wait on a database lock before releasing the holder.
      let unlock,ready;
      const readyPromise=new Promise(r=>{ready=r;}),release=new Promise(r=>{unlock=r;});
      const holder=withTestTransaction(config,{run:async ctx=>{await ctx.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='45s'");await ctx.query('SELECT id FROM public.contracts WHERE id=$1 FOR UPDATE',[f.contract]);ready();await release;}});
      await Promise.race([readyPromise,holder]);
      const calls=Promise.allSettled([call(f.termination),call(f.termination)]);
      let waiters=0;
      try {
        for(let i=0;i<40;i++){
          waiters=await withTestTransaction(config,{readOnly:true,run:async ctx=>Number((await ctx.query("SELECT count(*) AS n FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%approve_contract_termination_v1%' AND state='active'")).rows[0].n)});
          if(waiters>=2)break;await new Promise(r=>setTimeout(r,100));
        }
      } finally {unlock();await holder;}
      const results=await calls;assert(waiters>=2,'Both actual RPCs must be observed waiting on locks');
      const successful=results.filter(r=>r.status==='fulfilled').map(r=>r.value);
      assert.equal(successful.length,2);assert.equal(successful.filter(r=>r.noop===true).length,1);
      const after=await snapshot(f);assert.equal(after.vouchers.length-before.vouchers.length,1);assert.equal(after.items.length-before.items.length,1);
      assert.equal(after.postings.length,before.postings.length);assert.equal(after.contracts[0].status,'TERMINATED');
      e.checks.push({name:'same-termination-concurrency',status:'PASS',waiters,results:results.map(r=>({status:r.status,result:r.value}))});
      const completed=after.terminations.find(t=>t.status==='COMPLETED').id;
      await withTestTransaction(config,{commit:true,run:ctx=>ctx.query('UPDATE public.contracts SET deleted_at=now() WHERE id=$1',[f.contract])});
      const soft=await snapshot(f);assert.deepEqual(await call(completed,'different note'),{termination_id:completed,status:'COMPLETED',voucher_id:null,noop:true});assert.deepEqual(await snapshot(f),soft);
      e.checks.push({name:f.name+'-softdeleted-replay',status:'PASS'});
    }
  }});
  e.status='PASS';
} catch(err) {e.status='FAIL';e.error??={message:err.message,code:err.code};process.exitCode=1;}
finally {
  if(e.fixtures.length) {
    try {
      e.cleanup=await withTestTransaction(config,{commit:true,run:async ctx=>{
        try {const ledger=await legacyLedger(ctx,e.fixtures);e.ledger=ledger;save();return await cleanupLegacy(ctx,{fixtures:e.fixtures,ledger,expectedTriggerDigest:guards,buildingBaselines:baselines.filter(b=>e.fixtures.some(f=>f.building===b.id))});}
        catch(err){e.cleanupError={message:err.message,code:err.code};throw err;}
      }});
    } catch {e.status='FAIL';process.exitCode=1;}
  }
  save();console.log(JSON.stringify({status:e.status,checks:e.checks,error:e.error,cleanupError:e.cleanupError,cleanup:e.cleanup?{deleted:e.cleanup.deleted,closure:e.cleanup.closure,guardsUnchanged:e.cleanup.guardsUnchanged}:null}));
}
