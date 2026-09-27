import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {assertApprovalSources} from './legacy-entrypoints.mjs';
assert(process.argv.includes('--test-rollback'),'Explicit --test-rollback required');
const dir='.superpowers/sdd/2026-09-27-contract-lifecycle/';
import {readFileSync,writeFileSync} from 'node:fs';
import {loadTestCredentialsFromVault,withTestTransaction} from './transport.mjs';
import {seedLegacy,legacySnapshot} from './legacy-entrypoints-live.mjs';
const config=await loadTestCredentialsFromVault();config.db.ca=readFileSync(dir+'supabase-ca.crt','utf8');
const migration=readFileSync('supabase/migrations/20260927180948_approve_termination_eligibility.sql','utf8');
const candidate=migration.match(/\$definition\$([\s\S]+?)\$definition\$/)[1];
const baseline=candidate.replace(/  -- Validate the locked termination[\s\S]*?(?=  -- contracts KHÔNG)/,'').replace(/  -- Authorized COMPLETED replay[\s\S]*?(?=  select coalesce\(nullif\(btrim\(full_name\))/,'');
assert.equal(createHash('md5').update(baseline).digest('hex'),'750d2d72248d9557713ff6c82eedfe51','Exact baseline definition');
const scenarios=[{name:'PENDING-APPROVAL',status:'ACTIVE',terminationStatus:'PENDING_APPROVAL',deposit:0,deduction:100,want:-100},{name:'ACTIVE-negative',status:'ACTIVE',deposit:0,deduction:100,want:-100},{name:'EXTENDED-zero',status:'EXTENDED',deposit:0,deduction:0,want:0},{name:'ACTIVE-capped',status:'ACTIVE',deposit:1000,paid:400,deduction:0,want:400},{name:'EXTENDED-uncapped',status:'EXTENDED',deposit:400,paid:400,deduction:100,want:300}];
const e={kind:'REAL_SQL_ROLLBACK_PARITY_NOT_JWT',target:config.expectedRef,at:new Date().toISOString(),scenarios:[]};
const semantic=(s,f)=>({contracts:s.contracts.map(({status,actual_end_date,deposit_paid,deleted_at})=>({status,actual_end_date,deposit_paid,deleted_at})),rooms:s.rooms.map(({status})=>({status})),terminations:s.terminations.map(({status,refund_amount,refund_date,approved_by,actual_move_out_date})=>({status,refund_amount,refund_date,approved_by,actual_move_out_date})),vouchers:s.vouchers.map(({type,total_amount,approval_status,review_state,account_id,system_source,posting_mode,posting_status,voucher_date,notes})=>({type,total_amount,approval_status,review_state,account_id,system_source,posting_mode,posting_status,voucher_date,notes})).sort((a,b)=>a.type.localeCompare(b.type)||Number(a.total_amount)-Number(b.total_amount)),items:s.items.map(({amount,accounting_class,start_date,end_date})=>({amount,accounting_class,start_date,end_date})).sort((a,b)=>Number(a.amount)-Number(b.amount)),postings:s.postings.map(({direction,net_cash_effect,event_kind,source_kind})=>({direction,net_cash_effect,event_kind,source_kind})),invoices:s.invoices,credits:s.credits});
try{await withTestTransaction(config,{run:async ctx=>{await ctx.query(baseline);for(const scenario of scenarios){const r={name:scenario.name};e.scenarios.push(r);try{
await ctx.query('SAVEPOINT scenario');const f=await seedLegacy(ctx,scenario);r.fixture=f;r.before=await legacySnapshot(ctx,f);
await ctx.query('SAVEPOINT compare');r.baseline=(await ctx.query('SELECT public.approve_contract_termination_v1($1,$2) AS result',[f.termination,f.marker])).rows[0].result;r.baselineAfter=semantic(await legacySnapshot(ctx,f),f);
await ctx.query('ROLLBACK TO SAVEPOINT compare');await ctx.query(migration);r.candidate=(await ctx.query('SELECT public.approve_contract_termination_v1($1,$2) AS result',[f.termination,f.marker])).rows[0].result;const after=await legacySnapshot(ctx,f);r.candidateAfter=semantic(after,f);assertApprovalSources({before:r.before,after,response:r.candidate,want:scenario.want,capped:scenario.name==='ACTIVE-capped'});
assert.equal(r.candidate.refund_amount,scenario.want);assert.deepEqual({...r.candidate,voucher_id:null},{...r.baseline,voucher_id:null});assert.deepEqual(r.candidateAfter,r.baselineAfter);
const beforeReplay=await legacySnapshot(ctx,f);await ctx.query('UPDATE public.contracts SET deleted_at=now() WHERE id=$1',[f.contract]);const deleted=await legacySnapshot(ctx,f);r.replay=(await ctx.query('SELECT public.approve_contract_termination_v1($1,$2) AS result',[f.termination,'changed note'])).rows[0].result;assert.deepEqual(r.replay,{termination_id:f.termination,status:'COMPLETED',voucher_id:null,noop:true});assert.deepEqual(await legacySnapshot(ctx,f),deleted);r.status='PASS';await ctx.query('ROLLBACK TO SAVEPOINT scenario');
}catch(err){r.status='FAIL';r.error={code:err.code,message:err.message};throw err;}}}});}catch{process.exitCode=1;}
writeFileSync(dir+'p1a1-parity.json',JSON.stringify(e,null,2)+'\n');console.log(JSON.stringify(e.scenarios.map(({name,status,error,candidate,replay})=>({name,status,error,candidate,replay}))));
