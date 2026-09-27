import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {docVault} from '../test-env/lib.mjs';
import {loadTestCredentialsFromVault,withTestTransaction,createTestHttp} from './transport.mjs';
import {legacySnapshot} from './legacy-entrypoints-live.mjs';
import {triggerDigest} from './legacy-fixture-cleanup.mjs';
import {seedAuth,denyAuth,cleanupAuth} from './legacy-auth-fixture.mjs';
import {assertApprovalSources} from './legacy-entrypoints.mjs';
assert(process.argv.includes('--test-commit'),'Explicit --test-commit required');
const dir='.superpowers/sdd/2026-09-27-contract-lifecycle/';
const config=await loadTestCredentialsFromVault();config.db.ca=readFileSync(dir+'supabase-ca.crt','utf8');
const vault=docVault(),field=k=>process.env[k]||vault.match(new RegExp('(?:^|\\s)'+k+'=([^\\s`]+)','m'))?.[1];
const e={kind:'REAL_JWT_AUTHORIZATION_TEST_ONLY',at:new Date().toISOString(),target:config.expectedRef,checks:[]};
const save=()=>writeFileSync(dir+'p1a1-auth-http.json',JSON.stringify(e,null,2)+'\n');
let fixture,guards;
const txn=(run,commit=false)=>withTestTransaction(config,{run,commit});
try {
  await txn(async ctx=>{try{
    guards=await triggerDigest(ctx);const f=await seedAuth(ctx);
    await ctx.query('SELECT public.approve_contract_termination_v1($1,NULL)',[f.termination]);await denyAuth(ctx,f);
    e.rehearsal=await cleanupAuth(ctx,f,guards);
  }catch(err){e.error={stage:'rehearsal',code:err.code,message:err.message};throw err;}});
  fixture=await txn(seedAuth,true);e.fixture=fixture;save();
  const snapshot=()=>withTestTransaction(config,{readOnly:true,run:ctx=>legacySnapshot(ctx,fixture)});
  await withTestTransaction(config,{readOnly:true,run:async verified=>{
    const http=createTestHttp(config,{verified,apiKey:field('TEST_SUPABASE_PUBLISHABLE_KEY')});
    const token=await http.signIn({email:'demo.quanly@username.ihomecrm.local',password:field('FLEET_PASS_QUANLY')});
    const call=()=>http.rpc('approve_contract_termination_v1',{p_termination_id:fixture.termination,p_note:'actual manager JWT'},{token});
    // A scoped cross-org linkage rejection before any money, with own fixture only.
    await txn(ctx=>ctx.query("UPDATE public.contract_terminations SET organization_id='aaaa0000-0000-4000-8000-000000000001' WHERE id=$1",[fixture.termination]),true);
    try{const before=await snapshot();await assert.rejects(call(),/42501/);assert.deepEqual(await snapshot(),before);e.checks.push({name:'cross-org-linkage-before-money',status:'PASS'});}
    finally{await txn(ctx=>ctx.query('UPDATE public.contract_terminations SET organization_id=$2 WHERE id=$1',[fixture.termination,fixture.organizationId]),true);}
    await txn(ctx=>denyAuth(ctx,fixture),true);
    const deniedDraft=await snapshot();await assert.rejects(call(),/42501/);assert.deepEqual(await snapshot(),deniedDraft);e.checks.push({name:'revoked-scoped-authority-before-money',status:'PASS'});
    await txn(async ctx=>{assert.equal((await ctx.query("UPDATE public.member_permission_overrides SET effect='ALLOW' WHERE id=$1 AND reason=$2",[fixture.override,fixture.marker])).rowCount,1);await ctx.query('SET CONSTRAINTS ALL IMMEDIATE');},true);
    const before=await snapshot(),response=await call();assertApprovalSources({before,after:await snapshot(),response,want:-100,capped:false});e.checks.push({name:'manager-scoped-positive',status:'PASS'});
    await txn(ctx=>denyAuth(ctx,fixture),true);const completed=await snapshot();await assert.rejects(call(),/42501/);assert.deepEqual(await snapshot(),completed);e.checks.push({name:'revoked-scoped-authority-before-COMPLETED-replay',status:'PASS'});
  }});e.status='PASS';
}catch(err){e.status='FAIL';e.error??={message:err.message,code:err.code};process.exitCode=1;}
finally {
  if(fixture)try{e.cleanup=await txn(async ctx=>{try{return await cleanupAuth(ctx,fixture,guards);}catch(err){e.cleanupError={message:err.message,code:err.code};throw err;}},true);}catch{e.status='FAIL';process.exitCode=1;}
  save();console.log(JSON.stringify({status:e.status,checks:e.checks,error:e.error,cleanupError:e.cleanupError,cleanup:e.cleanup?{guardsUnchanged:e.cleanup.guardsUnchanged,existingManagerDecisionsUnchanged:e.cleanup.existingManagerDecisionsUnchanged,deleted:e.cleanup.deleted}:null}));
}
