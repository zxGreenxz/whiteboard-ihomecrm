// Explicit TEST-only behavioral checks; importing does not read credentials.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {loadTestCredentialsFromVault,withTestTransaction} from './transport.mjs';
import {seedLegacy,legacySnapshot} from './legacy-entrypoints-live.mjs';
import {triggerDigest,legacyLedger,cleanupLegacy} from './legacy-fixture-cleanup.mjs';
import {assertApprovalSources} from './legacy-entrypoints.mjs';

export async function denyBoundary(ctx,sql,values,code='42501') {
  await ctx.query('SAVEPOINT boundary_denial');let observed;
  try {await ctx.query(sql,values);}catch(error){observed=error.code;}
  await ctx.query('ROLLBACK TO SAVEPOINT boundary_denial');
  assert.equal(observed,code,'Exact denied write SQLSTATE');
  return observed;
}
export async function authorizeFixtureDelete({query},f) {
  // Exact owner-only issuer; production guard/validator remain enabled.
  await query("SELECT set_config('request.jwt.claim.sub',$1,true)",[f.actor]);
  await query("SELECT app_private.open_termination_write_v2(id,contract_id,organization_id,'DELETE',md5(to_jsonb(t)::text),to_jsonb(t),NULL) FROM public.contract_terminations t WHERE id=$1 AND contract_id=$2 AND organization_id=$3",[f.termination,f.contract,f.organizationId]);
}
export async function cleanupBoundary(ctx,fixtures,guards,baselines) {
  assert(fixtures.length>0 && fixtures.every(f=>f.actor===fixtures[0].actor),'Bulk cleanup requires one exact actor');
  for(const f of fixtures) {
    if(f.termination===null)continue; // legacyLedger verifies every other root and zero substitute rows.
    const owned=await ctx.query('SELECT t.id FROM public.contract_terminations t JOIN public.contracts c ON c.id=t.contract_id JOIN public.rooms r ON r.id=c.room_id JOIN public.contract_customers cc ON cc.contract_id=c.id JOIN public.customers u ON u.id=cc.customer_id WHERE t.id=$1 AND t.contract_id=$2 AND t.organization_id=$3 AND c.organization_id=$3 AND r.organization_id=$3 AND r.id=$4 AND r.building_id=$5 AND r.name=$6 AND u.id=$7 AND u.full_name=$6',[f.termination,f.contract,f.organizationId,f.room,f.building,f.marker,f.customer]);
    assert.equal(owned.rowCount,1,'Exact ownership before fixture metadata normalization');
    await ctx.query('UPDATE public.contract_terminations SET notes=$2 WHERE id=$1 AND contract_id=$3 AND organization_id=$4',[f.termination,f.marker,f.contract,f.organizationId]);
  }
  const ledger=await legacyLedger(ctx,fixtures);
  for(const f of fixtures)if(f.termination!==null)await authorizeFixtureDelete(ctx,f);
  const result=await cleanupLegacy(ctx,{fixtures,ledger,expectedTriggerDigest:guards,buildingBaselines:baselines});
  result.residual.terminationOperations=(await ctx.query('SELECT organization_id,operation,subject_scope,actor_id,idempotency_key,subject_id,outcome_kind FROM app_private.canonical_write_operations WHERE subject_id=ANY($1::uuid[]) OR subject_scope=ANY($2::text[]) ORDER BY organization_id,operation,subject_scope,actor_id,idempotency_key',[fixtures.flatMap(f=>[f.contract,f.termination]),fixtures.map(f=>f.contract)])).rows;
  for(const f of fixtures)if(f.termination!==null)await ctx.query('SELECT app_private.close_termination_write_v2($1)',[f.termination]);
  assert.equal(Number((await ctx.query('SELECT count(*) AS n FROM app_private.termination_write_capabilities WHERE transaction_id=pg_current_xact_id()')).rows[0].n),0);
  return result;
}
export async function seedTerminatedBoundary(ctx,draft) {
  const f=await seedLegacy(ctx,{status:draft?'ACTIVE':'TERMINATED',draftAdapter:draft,omitTermination:!draft,deduction:0,marker:'p1a2-term-'+randomUUID()});
  if(draft) {
    const before=await legacySnapshot(ctx,f);
    assert.equal(before.contracts[0].status,'ACTIVE');assert.equal(before.terminations[0].status,'DRAFT');
    const changed=await ctx.query("UPDATE public.contracts SET status='TERMINATED' WHERE id=$1 AND organization_id=$2 AND room_id=$3 AND notes=$4 AND status='ACTIVE'",[f.contract,f.organizationId,f.room,f.marker]);assert.equal(changed.rowCount,1);
  }
  return f;
}
export async function rehearseTerminatedBoundary(ctx,guards,baselines) {
  const fixtures=[];
  for(const draft of [false,true]) {
    const f=await seedTerminatedBoundary(ctx,draft);fixtures.push(f);const before=await legacySnapshot(ctx,f);
    assert.equal(before.contracts[0].status,'TERMINATED');assert.equal(before.terminations.length,draft?1:0);
    if(draft)await denyBoundary(ctx,'SELECT public.approve_contract_termination_v1($1,NULL)',[f.termination],'55000');
    else await denyBoundary(ctx,"INSERT INTO public.contract_terminations(contract_id,user_id,organization_id,actual_move_out_date,termination_type,total_deposit) VALUES($1,$2,$3,current_date,'NORMAL',0)",[f.contract,f.actor,f.organizationId]);
    assert.deepEqual(await legacySnapshot(ctx,f),before);
  }
  return {fixtures,cleanup:await cleanupBoundary(ctx,fixtures,guards,baselines.filter(b=>fixtures.some(f=>f.building===b.id)))};
}
export async function runBoundaryChecks(ctx) {
  const {query}=ctx,checks=[];
  const f=await seedLegacy(ctx,{status:'ACTIVE',draftAdapter:true,marker:'p1a2-'+randomUUID()});
  const before=await legacySnapshot(ctx,f);
  await assert.rejects(legacyLedger(ctx,[{...f,termination:null}]),/Absent termination must have no substitute row/);
  checks.push({name:'cleanup-false-absent-root-denied',status:'PASS'});
  for(const [name,sql,params]of [
    ['protected-update','UPDATE public.contract_terminations SET damage_fee=123 WHERE id=$1',[f.termination]],
    ['status-update',"UPDATE public.contract_terminations SET status='APPROVED' WHERE id=$1",[f.termination]],
    ['delete','DELETE FROM public.contract_terminations WHERE id=$1',[f.termination]],
    ['direct-draft',"INSERT INTO public.contract_terminations(contract_id,user_id,organization_id,actual_move_out_date,termination_type,total_deposit) VALUES($1,$2,$3,current_date,'NORMAL',0)",[f.contract,f.actor,f.organizationId]],
  ]) {checks.push({name,code:await denyBoundary(ctx,sql,params)});assert.deepEqual(await legacySnapshot(ctx,f),before);}
  await query("SELECT set_config('app.contract_termination_write','true',true),set_config('app.termination_id',$1,true)",[f.termination]);
  checks.push({name:'forged-guc',code:await denyBoundary(ctx,'UPDATE public.contract_terminations SET other_fees=1 WHERE id=$1',[f.termination])});
  await query('SET LOCAL ROLE authenticated');
  checks.push({name:'authenticated-delete',code:await denyBoundary(ctx,'DELETE FROM public.contract_terminations WHERE id=$1',[f.termination])});
  checks.push({name:'private-issuer-denied',code:await denyBoundary(ctx,"SELECT app_private.open_termination_write_v2($1,$2,$3,'DELETE','x',NULL,NULL)",[f.termination,f.contract,f.organizationId])});
  checks.push({name:'retired-reader-denied',code:await denyBoundary(ctx,'SELECT public.has_contract_termination_write_v1($1)',[f.termination])});
  await query('RESET ROLE');
  await query('SET LOCAL ROLE service_role');
  for(const kind of ['forfeit','move_out'])checks.push({name:'service-impl-'+kind,code:await denyBoundary(ctx,"SELECT public.terminate_contract_"+kind+"_impl($1,current_date)",[f.contract])});
  await query('RESET ROLE');
  for(const field of ['actor_id','organization_id','contract_id','termination_id','backend_pid','transaction_id','action','expected_after']) {
    await query('SAVEPOINT forged_proof');
    await authorizeFixtureDelete(ctx,f);
    const value=field==='backend_pid'?'backend_pid+1':field==='transaction_id'?"'1'::xid8":field==='action'?"'REJECT'":field==='expected_after'?"'{}'::jsonb":'gen_random_uuid()';
    await query(`UPDATE app_private.termination_write_capabilities SET ${field}=${value} WHERE termination_id=$1`,[f.termination]);
    checks.push({name:'wrong-proof-'+field,code:await denyBoundary(ctx,'DELETE FROM public.contract_terminations WHERE id=$1',[f.termination])});
    await query('ROLLBACK TO SAVEPOINT forged_proof');
  }
  await query('UPDATE public.contract_terminations SET notes=$2 WHERE id=$1',[f.termination,'metadata']);
  const afterMetadata=await legacySnapshot(ctx,f);
  assert.deepEqual({...afterMetadata.terminations[0],notes:f.marker},before.terminations[0]);
  checks.push({name:'metadata',status:'PASS'});
  for(const reason of ['first','second']) {
    await query('SELECT public.reject_contract_termination_v1($1,$2)',[f.termination,reason]);
    assert.equal((await query('SELECT notes FROM public.contract_terminations WHERE id=$1',[f.termination])).rows[0].notes,'[Từ chối] '+reason);
  }
  checks.push({name:'reject-repeat-new-reason',status:'PASS'});
  checks.push({name:'unique-draft-admission',code:await denyBoundary(ctx,'SELECT public.create_contract_termination_draft_v1($1,current_date,$2)',[f.contract,f.marker+':second'],'23505')});
  await query("UPDATE public.contracts SET status='TERMINATED' WHERE id=$1",[f.contract]);
  const ended=await legacySnapshot(ctx,f);
  await denyBoundary(ctx,'SELECT public.approve_contract_termination_v1($1,NULL)',[f.termination],'55000');
  await denyBoundary(ctx,'SELECT public.create_contract_termination_draft_v1($1,current_date,$2)',[f.contract,f.marker+':ended'],'55000');
  await denyBoundary(ctx,"INSERT INTO public.contract_terminations(contract_id,user_id,organization_id,actual_move_out_date,termination_type,total_deposit) VALUES($1,$2,$3,current_date,'NORMAL',0)",[f.contract,f.actor,f.organizationId]);
  assert.deepEqual(await legacySnapshot(ctx,f),ended);
  checks.push({name:'ended-contract-draft-insert-and-approval-zero-effects',status:'PASS'});
  await query("UPDATE public.contracts SET status='ACTIVE' WHERE id=$1",[f.contract]);
  const response=(await query('SELECT public.approve_contract_termination_v1($1,$2) AS v',[f.termination,'approve'])).rows[0].v;
  assert.equal(response.status,'COMPLETED');assert.equal(response.refund_amount,-100);
  await query('UPDATE public.contracts SET deleted_at=now() WHERE id=$1',[f.contract]);
  const completed=await legacySnapshot(ctx,f);
  const replay=(await query('SELECT public.approve_contract_termination_v1($1,$2) AS v',[f.termination,'changed-note'])).rows[0].v;
  assert.deepEqual(replay,{termination_id:f.termination,status:'COMPLETED',voucher_id:null,noop:true});
  assert.deepEqual(await legacySnapshot(ctx,f),completed);
  checks.push({name:'completed-deleted-changed-note-noop',status:'PASS'});
  assert.equal(Number((await query('SELECT count(*) AS n FROM app_private.termination_write_capabilities WHERE transaction_id=pg_current_xact_id()')).rows[0].n),0);
  return {checks,fixture:f};
}

export async function runLegacyNullMetadata(ctx) {
  const {query}=ctx;
  const f=await seedLegacy(ctx,{status:'ACTIVE',omitTermination:true,marker:'p1a2-null-'+randomUUID()});
  const guards=await triggerDigest(ctx);
  const bodies=(await query("SELECT oid::regprocedure::text,md5(pg_get_functiondef(oid)) AS hash FROM pg_proc WHERE proname IN ('auto_calculate_termination_financials','update_contract_on_termination_approved','guard_contract_termination_settlement') ORDER BY 1")).rows;
  // Controlled historical shape, rollback-only. The four nullable fields are
  // already NULL in the exact DRAFT proof. No capability is minted here.
  await query(`CREATE FUNCTION app_private.p1a2_legacy_null_fixture() RETURNS trigger LANGUAGE plpgsql AS $body$
  BEGIN
    IF NEW.contract_id='${f.contract}'::uuid AND NEW.organization_id='${f.organizationId}'::uuid AND NEW.notes='${f.marker}'
      AND EXISTS(SELECT 1 FROM app_private.termination_write_capabilities p WHERE p.termination_id=NEW.id AND p.contract_id=NEW.contract_id AND p.organization_id=NEW.organization_id AND p.actor_id=auth.uid() AND p.transaction_id=pg_current_xact_id() AND p.backend_pid=pg_backend_pid() AND p.action='DRAFT' AND p.phase=1 AND p.expected_after->>'id'=NEW.id::text AND p.expected_after->'outstanding_debt'='null'::jsonb AND p.expected_after->'prorated_rent'='null'::jsonb AND p.expected_after->'prorated_days'='null'::jsonb AND p.expected_after->'prorated_services'='null'::jsonb)
    THEN NEW.outstanding_debt:=NULL;NEW.prorated_rent:=NULL;NEW.prorated_days:=NULL;NEW.prorated_services:=NULL; END IF;
    RETURN NEW;
  END $body$;
  CREATE TRIGGER trigger_legacy_null_fixture BEFORE INSERT ON public.contract_terminations FOR EACH ROW EXECUTE FUNCTION app_private.p1a2_legacy_null_fixture();`);
  const result=(await query("SELECT public.create_contract_termination_draft_v1($1,'2026-09-28',$2,'NORMAL',0,NULL,NULL,NULL,NULL,0,0,0,0,0,'TM',$3) AS v",[f.contract,f.marker+':draft',f.marker])).rows[0].v;
  f.termination=result.termination_id;
  await query('DROP TRIGGER trigger_legacy_null_fixture ON public.contract_terminations; DROP FUNCTION app_private.p1a2_legacy_null_fixture()');
  assert.equal(await triggerDigest(ctx),guards);
  assert.deepEqual((await query("SELECT oid::regprocedure::text,md5(pg_get_functiondef(oid)) AS hash FROM pg_proc WHERE proname IN ('auto_calculate_termination_financials','update_contract_on_termination_approved','guard_contract_termination_settlement') ORDER BY 1")).rows,bodies);
  await query("SELECT public.create_invoice_v1($1,$2,$3,'2026-09','2026-09-28','2026-09-28','SETTLEMENT',100000,0,100000,0,$4::jsonb,$5)",[f.contract,f.building,f.room,JSON.stringify([{type:'RENT',description:f.marker,unit_price:100000,quantity:1,coefficient:1,amount:100000,accounting_class:'REVENUE'}]),f.marker+':invoice']);
  const service=randomUUID();
  await query("INSERT INTO public.services(id,organization_id,user_id,name,type,unit_price) VALUES($1,$2,$3,$4,'FIXED',300)",[service,f.organizationId,f.actor,f.marker]);
  await query('INSERT INTO public.contract_services(contract_id,organization_id,service_id,unit_price) VALUES($1,$2,$3,300)',[f.contract,f.organizationId,service]);
  const before=(await query('SELECT * FROM public.contract_terminations WHERE id=$1',[f.termination])).rows[0];
  for(const field of ['outstanding_debt','prorated_rent','prorated_days','prorated_services'])assert.equal(before[field],null);
  assert.equal(Number((await query('SELECT sum(remaining_amount) AS n FROM public.invoices WHERE contract_id=$1',[f.contract])).rows[0].n),100000);
  await query('UPDATE public.contract_terminations SET notes=$2 WHERE id=$1',[f.termination,'legacy metadata']);
  const after=(await query('SELECT * FROM public.contract_terminations WHERE id=$1',[f.termination])).rows[0];
  assert.deepEqual({...after,notes:before.notes},before,'All protected values and stored generated money remain unchanged');
  await denyBoundary(ctx,'UPDATE public.contract_terminations SET notes=$2,outstanding_debt=999 WHERE id=$1',[f.termination,'smuggled']);
  assert.deepEqual((await query('SELECT * FROM public.contract_terminations WHERE id=$1',[f.termination])).rows[0],after);
  return {name:'legacy-null-metadata-live-debt-services',status:'PASS',fixtureShape:'Controlled rollback-only historical NULL; fixture trigger removed before assertions',guardsRestored:true};
}

export async function runAuditFault(ctx) {
  const {query}=ctx;
  const f=await seedLegacy(ctx,{status:'ACTIVE',omitTermination:true,marker:'p1a2-audit-'+randomUUID()});
  await query("SELECT public.create_invoice_v1($1,$2,$3,'2026-09','2026-09-28','2026-09-28','SETTLEMENT',100000,0,100000,0,$4::jsonb,$5)",[f.contract,f.building,f.room,JSON.stringify([{type:'RENT',description:f.marker,unit_price:100000,quantity:1,coefficient:1,amount:100000,accounting_class:'REVENUE'}]),f.marker+':invoice']);
  const before=await legacySnapshot(ctx,f);assert.equal(before.invoices.length,1);
  await query(`ALTER TABLE public.contract_terminations ADD CONSTRAINT p1a2_exact_audit_fault CHECK (contract_id<>'${f.contract}'::uuid) NOT VALID`);
  await denyBoundary(ctx,"SELECT public.terminate_contract_forfeit($1,'2026-09-28')",[f.contract],'23514');
  assert.deepEqual(await legacySnapshot(ctx,f),before,'Audit failure rolls back invoice cancellation, contract and all money');
  await query('ALTER TABLE public.contract_terminations DROP CONSTRAINT p1a2_exact_audit_fault');
  await query("UPDATE public.contracts SET status='DRAFT' WHERE id=$1",[f.contract]);
  const ineligible=await legacySnapshot(ctx,f);
  for(const kind of ['forfeit','move_out'])await denyBoundary(ctx,"SELECT public.terminate_contract_"+kind+"($1,'2026-09-28')",[f.contract],'55000');
  assert.deepEqual(await legacySnapshot(ctx,f),ineligible,'Ineligible raw entry has zero effects');
  await query("UPDATE public.contracts SET status='ACTIVE' WHERE id=$1",[f.contract]);
  await query("UPDATE public.rooms SET organization_id='aaaa0000-0000-4000-8000-000000000001' WHERE id=$1",[f.room]);
  const wrongScope=await legacySnapshot(ctx,f);
  await denyBoundary(ctx,"SELECT public.terminate_contract_forfeit($1,'2026-09-28')",[f.contract]);
  await denyBoundary(ctx,"SELECT public.create_contract_termination_draft_v1($1,'2026-09-28',$2)",[f.contract,f.marker+':wrong-scope']);
  assert.deepEqual(await legacySnapshot(ctx,f),wrongScope,'Forged linkage cannot create financial effects');
  return {name:'audit-fault-atomic-and-raw-entry-eligibility',status:'PASS'};
}

export async function runApprovalMoney(ctx) {
  const checks=[];
  for(const scenario of [
    {name:'ACTIVE-capped',status:'ACTIVE',deposit:1000,paid:400,deduction:0,want:400,capped:true},
    {name:'EXTENDED-uncapped',status:'EXTENDED',deposit:400,paid:400,deduction:100,want:300,capped:false},
    {name:'EXTENDED-zero',status:'EXTENDED',deposit:0,paid:0,deduction:0,want:0,capped:false},
  ]) {
    await ctx.query('SAVEPOINT approval_money');
    const f=await seedLegacy(ctx,{...scenario,draftAdapter:true});
    const before=await legacySnapshot(ctx,f);
    const response=(await ctx.query('SELECT public.approve_contract_termination_v1($1,NULL) AS v',[f.termination])).rows[0].v;
    assertApprovalSources({before,after:await legacySnapshot(ctx,f),response,want:scenario.want,capped:scenario.capped});
    checks.push({name:scenario.name,status:'PASS',refund:response.refund_amount,capped:response.refund_capped});
    await ctx.query('ROLLBACK TO SAVEPOINT approval_money');
  }
  return checks;
}

async function main() {
  assert(process.argv.includes('--test-rollback'),'Explicit --test-rollback required');
  const dir='.superpowers/sdd/2026-09-27-contract-lifecycle/';
  const config=await loadTestCredentialsFromVault();config.db.ca=readFileSync(dir+'supabase-ca.crt','utf8');
  const report={mode:'TEST_ROLLBACK',checks:[]};
  try {
    await withTestTransaction(config,{run:async ctx=>{
      try {
        if(process.argv.includes('--migration')) {
          const sql=readFileSync(process.argv[process.argv.indexOf('--migration')+1],'utf8');
          if(process.argv.includes('--candidate-definitions')) {
            const install=sql.match(/EXECUTE \$install\$([\s\S]*?)\$install\$;/)?.[1];assert(install);
            await ctx.query(install);report.definitionOnlyRollbackMutation=true;
          } else {await ctx.query(sql);await ctx.query(sql);}
        }
        Object.assign(report,await runBoundaryChecks(ctx));
        report.checks.push(await runLegacyNullMetadata(ctx));
        report.checks.push(await runAuditFault(ctx));
        report.checks.push(...await runApprovalMoney(ctx));
      }catch(error){report.error={code:error.code,message:error.message,where:error.where};throw error;}
    }});report.status='PASS';
  }catch{report.status='FAIL';process.exitCode=1;}
  writeFileSync(dir+'p1a2-boundary.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({status:report.status,checks:report.checks,error:report.error}));
}
if(process.argv[1]?.replaceAll('\\','/').endsWith('/termination-boundary-live.mjs'))await main();
