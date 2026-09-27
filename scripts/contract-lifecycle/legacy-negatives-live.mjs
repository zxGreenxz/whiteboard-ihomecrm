import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {loadTestCredentialsFromVault,withTestTransaction} from './transport.mjs';
import {seedLegacy,legacySnapshot} from './legacy-entrypoints-live.mjs';
assert(process.argv.includes('--test-rollback'),'Explicit --test-rollback required');
const dir='.superpowers/sdd/2026-09-27-contract-lifecycle/';
const config=await loadTestCredentialsFromVault();config.db.ca=readFileSync(dir+'supabase-ca.crt','utf8');
const migration=readFileSync('supabase/migrations/20260927180948_approve_termination_eligibility.sql','utf8');
const e={mode:'TEST_ROLLBACK_NOT_JWT',cases:[],target:config.expectedRef,at:new Date().toISOString()};
try{await withTestTransaction(config,{run:async ctx=>{
  await ctx.query(migration);
  const cases=[
    ['DRAFT-contract','55000',async(c,f)=>c.query("UPDATE public.contracts SET status='DRAFT' WHERE id=$1",[f.contract])],
    ['deleted-active','55000',async(c,f)=>c.query('UPDATE public.contracts SET deleted_at=now() WHERE id=$1',[f.contract])],
    ['term-org-mismatch','42501',async(c,f)=>c.query("UPDATE public.contract_terminations SET organization_id='aaaa0000-0000-4000-8000-000000000001' WHERE id=$1",[f.termination])],
    ['room-org-mismatch','42501',async(c,f)=>c.query("UPDATE public.rooms SET organization_id='aaaa0000-0000-4000-8000-000000000001' WHERE id=$1",[f.room])],
    ['room-building-cross-org','42501',async(c,f)=>c.query("UPDATE public.rooms SET building_id=(SELECT id FROM public.buildings WHERE organization_id='aaaa0000-0000-4000-8000-000000000001' ORDER BY id LIMIT 1) WHERE id=$1",[f.room])],
    ['missing-room-link','42501',async(c,f)=>c.query('UPDATE public.contracts SET room_id=NULL WHERE id=$1',[f.contract])],
    ['missing-termination','42501',async(_c,f)=>{f.callId=randomUUID();}],
    ['voucher-insert-failure','23514',async(c,f)=>c.query(`ALTER TABLE public.income_expenses ADD CONSTRAINT p1a1_injected_failure CHECK(contract_id IS DISTINCT FROM '${f.contract}'::uuid) NOT VALID`)],
    ['item-insert-failure','23514',async(c,f)=>c.query(`ALTER TABLE public.income_expense_items ADD CONSTRAINT p1a1_injected_failure CHECK(description NOT LIKE '%${f.termination.slice(0,8)}%') NOT VALID`)],
  ];
  for(const [name,want,prepare]of cases) {
    const r={name};e.cases.push(r);
    try {
      await ctx.query('SAVEPOINT scenario');const f=await seedLegacy(ctx,{status:'ACTIVE'});await prepare(ctx,f);
      const before=await legacySnapshot(ctx,f);await ctx.query('SAVEPOINT call');
      try {await ctx.query('SELECT public.approve_contract_termination_v1($1,NULL)',[f.callId??f.termination]);}
      catch(err){r.sqlstate=err.code;}
      finally {await ctx.query('ROLLBACK TO SAVEPOINT call');}
      assert.equal(r.sqlstate,want,name);assert.deepEqual(await legacySnapshot(ctx,f),before,'Failed call must be atomic');
      r.status='PASS';await ctx.query('ROLLBACK TO SAVEPOINT scenario');
    }catch(err){r.status='FAIL';r.error={code:err.code,message:err.message};throw err;}
  }
  e.uniqueIndex=(await ctx.query("SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='idx_terminations_unique_contract'")).rows;
  assert.equal(e.uniqueIndex.length,1);
  await ctx.query('SAVEPOINT duplicate_fixture');
  const f=await seedLegacy(ctx,{status:'ACTIVE'});await ctx.query('SAVEPOINT duplicate_insert');
  let duplicateCode;
  try{await ctx.query("INSERT INTO public.contract_terminations(id,organization_id,user_id,contract_id,actual_move_out_date,termination_type,total_deposit,outstanding_debt,prorated_rent,prorated_services,refund_method,notes) SELECT $2,organization_id,user_id,contract_id,actual_move_out_date,termination_type,total_deposit,outstanding_debt,prorated_rent,prorated_services,refund_method,notes FROM public.contract_terminations WHERE id=$1",[f.termination,randomUUID()]);}
  catch(err){duplicateCode=err.code;}
  await ctx.query('ROLLBACK TO SAVEPOINT duplicate_insert');assert.equal(duplicateCode,'23505');
  assert.equal(Number((await ctx.query('SELECT count(*) AS n FROM public.contract_terminations WHERE contract_id=$1',[f.contract])).rows[0].n),1);
  e.twoDraftRace={status:'NOT_ADMISSIBLE_CURRENT_SCHEMA',duplicateCode,remainingTerminations:1};
  await ctx.query('ROLLBACK TO SAVEPOINT duplicate_fixture');
}});}catch{process.exitCode=1;}
writeFileSync(dir+'p1a1-negatives.json',JSON.stringify(e,null,2)+'\n');console.log(JSON.stringify(e));
