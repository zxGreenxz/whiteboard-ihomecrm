import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {docVault} from '../test-env/lib.mjs';
import {loadTestCredentialsFromVault,withTestTransaction,createTestHttp} from './transport.mjs';
import {seedBoundaryAuth,boundaryAuthMode,deleteOwnedDraft,cleanupBoundaryAuth,rehearseBoundaryAuth} from './termination-boundary-auth-fixture.mjs';
import {legacySnapshot} from './legacy-entrypoints-live.mjs';
import {triggerDigest} from './legacy-fixture-cleanup.mjs';
assert(process.argv.includes('--test-commit'),'Explicit --test-commit required');
const dir='.superpowers/sdd/2026-09-27-contract-lifecycle/';
const config=await loadTestCredentialsFromVault();config.db.ca=readFileSync(dir+'supabase-ca.crt','utf8');
const vault=docVault(),field=k=>process.env[k]||vault.match(new RegExp('(?:^|\\s)'+k+'=([^\\s`]+)','m'))?.[1];
const e={kind:'REAL_JWT_SCOPED_CREATE_EDIT',checks:[]};let fixture,guards;
const save=()=>writeFileSync(dir+'p1a2-auth-http.json',JSON.stringify(e,null,2)+'\n');
const txn=(run,commit=false)=>withTestTransaction(config,{run,commit});
try {
  guards=await withTestTransaction(config,{readOnly:true,run:triggerDigest});
  e.rehearsal=await txn(ctx=>rehearseBoundaryAuth(ctx,guards));save();
  fixture=await txn(seedBoundaryAuth,true);e.fixture=fixture;save();
  const f=fixture,snapshot=()=>withTestTransaction(config,{readOnly:true,run:ctx=>legacySnapshot(ctx,f)});
  await withTestTransaction(config,{readOnly:true,run:async verified=>{try{
    const http=createTestHttp(config,{verified,apiKey:field('TEST_SUPABASE_PUBLISHABLE_KEY')});
    const token=await http.signIn({email:'demo.quanly@username.ihomecrm.local',password:field('FLEET_PASS_QUANLY')});
    const call=(name,args,allowEmpty=false)=>http.rpc(name,args,{token,allowEmpty});
    const args={p_contract_id:f.contract,p_move_out_date:'2026-09-28',p_idempotency_key:f.marker+':manager-draft',p_total_deposit:0,p_outstanding_debt:0,p_notes:f.marker};
    await assert.rejects(call('create_contract_termination_draft_v1',args),/42501/);
    await call('reject_contract_termination_v1',{p_termination_id:f.termination,p_reason:'edit only'},true);
    e.checks.push({name:'edit-only-create-denied-reject-allowed',status:'PASS'});
    await txn(ctx=>deleteOwnedDraft(ctx,f),true);
    await txn(ctx=>boundaryAuthMode(ctx,f,'ALLOW','DENY'),true);
    const created=await call('create_contract_termination_draft_v1',args);f.termination=created.termination_id;save();
    const draft=await snapshot();assert.equal(draft.terminations[0].user_id,f.manager);assert.notEqual(f.manager,draft.contracts[0].user_id);
    await assert.rejects(call('approve_contract_termination_v1',{p_termination_id:f.termination}),/42501/);
    assert.deepEqual(await snapshot(),draft);
    assert.deepEqual(await call('create_contract_termination_draft_v1',args),created);
    e.checks.push({name:'create-only-staff-draft-attribution-approve-denied-replay',status:'PASS'});
    await txn(ctx=>boundaryAuthMode(ctx,f,'DENY','DENY'),true);
    await assert.rejects(call('create_contract_termination_draft_v1',args),/42501/);
    assert.deepEqual(await snapshot(),draft);
    e.checks.push({name:'create-replay-revoked-authority',status:'PASS'});
    await txn(ctx=>deleteOwnedDraft(ctx,f),true);
    await txn(ctx=>boundaryAuthMode(ctx,f,'DENY','ALLOW'),true);
    const creditArgs={p_contract_id:f.contract,p_forfeit_date:'2026-09-28',p_extra_charges:[],p_idempotency_key:f.marker+':manager-credit'};
    const result=await call('terminate_contract_forfeit_with_credit_v1',creditArgs);
    const after=await snapshot();f.termination=after.terminations[0].id;save();assert.equal(after.terminations[0].user_id,f.actor);assert.notEqual(f.actor,f.manager);
    assert.deepEqual(await call('terminate_contract_forfeit_with_credit_v1',creditArgs),result);
    await txn(ctx=>boundaryAuthMode(ctx,f,'DENY','DENY'),true);
    await assert.rejects(call('terminate_contract_forfeit_with_credit_v1',creditArgs),/42501/);
    assert.deepEqual(await snapshot(),after);
    e.checks.push({name:'raw-audit-owner-attribution-credit-replay-authority',status:'PASS'});
  }catch(error){e.error={message:error.message,code:error.code};throw error;}}});e.status='PASS';
}catch(error){e.status='FAIL';e.error??={message:error.message,code:error.code};process.exitCode=1;}
finally {
  if(fixture)try{e.cleanup=await txn(async ctx=>{try{return await cleanupBoundaryAuth(ctx,fixture,guards);}catch(error){e.cleanupError={message:error.message,code:error.code};throw error;}},true);}catch{e.status='FAIL';process.exitCode=1;}
  save();console.log(JSON.stringify({status:e.status,checks:e.checks,error:e.error,cleanupError:e.cleanupError,cleanup:e.cleanup?{closure:e.cleanup.closure,createClosure:e.cleanup.createClosure,buildingClosure:e.cleanup.buildingClosure,guardsUnchanged:e.cleanup.guardsUnchanged,existingManagerDecisionsUnchanged:e.cleanup.existingManagerDecisionsUnchanged}:null}));
}
