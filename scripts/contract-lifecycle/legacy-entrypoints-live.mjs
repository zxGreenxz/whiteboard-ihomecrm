// Explicit TEST integration; never imported by the credential-free test glob.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadTestCredentialsFromVault, withTestTransaction } from './transport.mjs';
import { assertEligibilityDenied } from './legacy-entrypoints.mjs';

const ORG='dddd0000-0000-4000-8000-000000000001';
export async function seedLegacy({query}, {status='TERMINATED', terminationStatus='DRAFT', deduction=100, deposit=0, paid=0, buildingId, marker=`p1a1-${randomUUID()}`, draftAdapter=false, omitTermination=false}={}) {
  await query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='90s'");
  const one=async(sql,params)=>{const r=await query(sql,params);assert.equal(r.rows.length,1);return r.rows[0];};
  const actor=(await one("SELECT id FROM auth.users WHERE email='demo.chunha@username.ihomecrm.local'")).id;
  await query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[actor,JSON.stringify({sub:actor,role:'authenticated'})]);
  const building=buildingId??(await one("SELECT id FROM public.buildings WHERE organization_id=$1 AND deleted_at IS NULL AND NOT is_virtual AND public.can_do_on_building('contracts','edit',id) ORDER BY id LIMIT 1",[ORG])).id;
  const room=randomUUID(),customer=randomUUID();
  let termination=randomUUID();
  let contract=randomUUID(),account;
  await query("INSERT INTO public.rooms(id,organization_id,building_id,name,rent_price,deposit_amount,status) VALUES($1,$2,$3,$4,300000,0,'AVAILABLE')",[room,ORG,building,marker]);
  await query('INSERT INTO public.customers(id,organization_id,user_id,full_name,phone) VALUES($1,$2,$3,$4,$5)',[customer,ORG,actor,marker,'0000000000']);
  if(paid>0) {
    const today=(await one('SELECT public.org_today_v1($1)::text AS v',[ORG])).v;
    const member=(await one('SELECT app_private.member_of_org_v1($1,$2) AS v',[ORG,actor])).v;
    assert.equal(Number((await one('SELECT count(*) AS n FROM app_private.personal_cash_books WHERE membership_id=$1 AND valid_to IS NULL',[member])).n),0,'Do not replace an existing cashbook assignment');
    account=(await one('SELECT public.create_cashbook_v1($1,0,$2,NULL,NULL,NULL,$3,NULL,false,$4,$5) AS v',[marker,today,marker+':cashbook',actor,ORG])).v.cashbook_id;
    await query('SELECT public.set_personal_cash_book_v1($1,$2)',[member,account]);
    contract=(await one('SELECT public.create_contract_v2($1::jsonb,$2) AS v',[JSON.stringify({contract:{room_id:room,start_date:today,end_date:'2028-12-31',rent_price:300000,total_deposit:paid,notes:marker},customers:[{customer_id:customer,is_representative:true}],deposit_receipts:[{amount:paid,account_id:account,received_date:today}]}),marker+':create'])).v.contract.id;
    await query('UPDATE public.contracts SET status=$2 WHERE id=$1',[contract,status]);
  } else {
    await query("INSERT INTO public.contracts(id,organization_id,user_id,room_id,status,signed_date,start_date,end_date,rent_price,total_deposit,notes) VALUES($1,$2,$3,$4,$5,'2026-01-01','2026-01-01','2028-12-31',300000,$6,$7)",[contract,ORG,actor,room,status,deposit,marker]);
    await query('INSERT INTO public.contract_customers(contract_id,customer_id,is_representative) VALUES($1,$2,true)',[contract,customer]);
  }
  if(omitTermination) {
    termination=null;
  } else if(draftAdapter) {
    assert.equal(terminationStatus,'DRAFT','Boundary fixtures enter through authorized DRAFT');
    const result=await one("SELECT public.create_contract_termination_draft_v1($1,public.org_today_v1($2),$3,'NORMAL',$4,$5,0,0,0,0,0,0,0,0,'TM',$6) AS v",[contract,ORG,marker+':draft',deposit,deduction,marker]);
    termination=result.v.termination_id;
  } else {
    await query("INSERT INTO public.contract_terminations(id,organization_id,user_id,contract_id,actual_move_out_date,termination_type,total_deposit,outstanding_debt,prorated_rent,prorated_services,refund_method,notes) VALUES($1,$2,$3,$4,public.org_today_v1($2),'NORMAL',$5,$6,0,0,'TM',$7)",[termination,ORG,actor,contract,deposit,deduction,marker]);
  }
  if(terminationStatus!=='DRAFT')await query('UPDATE public.contract_terminations SET status=$2 WHERE id=$1',[termination,terminationStatus]);
  return {actor,building,room,customer,contract,termination,marker,organizationId:ORG,...(account?{account}:{})};
}

export async function legacySnapshot({query}, f) {
  const get=async(sql,params=[f.contract])=>(await query(sql,params)).rows;
  return {
    contracts:await get('SELECT * FROM public.contracts WHERE id=$1 ORDER BY id'),
    rooms:await get('SELECT * FROM public.rooms WHERE id=$1',[f.room]),
    terminations:await get('SELECT * FROM public.contract_terminations WHERE contract_id=$1 ORDER BY id'),
    invoices:await get('SELECT * FROM public.invoices WHERE contract_id=$1 ORDER BY id'),
    vouchers:await get('SELECT * FROM public.income_expenses WHERE contract_id=$1 ORDER BY id'),
    items:await get('SELECT i.* FROM public.income_expense_items i JOIN public.income_expenses v ON v.id=i.income_expense_id WHERE v.contract_id=$1 ORDER BY i.id'),
    postings:await get('SELECT p.* FROM public.income_expense_postings p JOIN public.income_expenses v ON v.id=p.voucher_id WHERE v.contract_id=$1 ORDER BY p.id'),
    credits:await get('SELECT * FROM public.customer_credit_lots WHERE contract_id=$1 ORDER BY id'),
    audit:await get('SELECT a.* FROM app_private.income_expense_change_log a WHERE a.income_expense_id IN (SELECT id FROM public.income_expenses WHERE contract_id=$1) ORDER BY a.id'),
    operations:await get('SELECT o.* FROM app_private.canonical_write_operations o WHERE o.subject_id=$1 OR o.subject_id IN (SELECT id FROM public.income_expenses WHERE contract_id=$1) ORDER BY organization_id,operation,subject_scope,actor_id,idempotency_key'),
    history:await get('SELECT * FROM public.room_price_history WHERE contract_id=$1 ORDER BY id'),
  };
}

async function main() {
  assert(process.argv.includes('--test-rollback'),'Explicit --test-rollback required');
  const config=await loadTestCredentialsFromVault();
  config.db.ca=readFileSync('.superpowers/sdd/2026-09-27-contract-lifecycle/supabase-ca.crt','utf8');
  const evidence={target:config.expectedRef,mode:'TEST_ROLLBACK',at:new Date().toISOString()};
  try {
    await withTestTransaction(config,{run:async ctx=>{
      try {
        const migration=process.argv[process.argv.indexOf('--migration')+1];
        if(process.argv.includes('--migration')) {
          assert(/^supabase\/migrations\/\d{14}_approve_termination_eligibility\.sql$/.test(migration));
          const sql=readFileSync(migration,'utf8');
          if(process.argv.includes('--candidate-definition')) {
            const definition=sql.match(/\$definition\$([\s\S]+?)\$definition\$/)?.[1];
            assert(definition,'Candidate definition required');await ctx.query(definition);
            evidence.definitionOnlyRollbackMutation=true;
          } else {
            await ctx.query(sql); await ctx.query(sql);
            evidence.migrationAppliedTwice=true;
          }
        }
        const f=await seedLegacy(ctx);
        evidence.fixture=f;
        evidence.before=await legacySnapshot(ctx,f);
        await ctx.query('SAVEPOINT approval');
        try { evidence.response=(await ctx.query('SELECT public.approve_contract_termination_v1($1,$2) AS result',[f.termination,f.marker])).rows[0].result; }
        catch(e) { evidence.sqlstate=e.code; await ctx.query('ROLLBACK TO SAVEPOINT approval'); }
        evidence.after=await legacySnapshot(ctx,f);
        assertEligibilityDenied(evidence);
      } catch(e) { evidence.error={code:e.code??null,message:e.message}; throw e; }
    }});
    evidence.status='PASS';
  } catch { evidence.status='FAIL'; process.exitCode=1; }
  writeFileSync('.superpowers/sdd/2026-09-27-contract-lifecycle/p1a1-regression.json',JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify({target:evidence.target,status:evidence.status,sqlstate:evidence.sqlstate,response:evidence.response,error:evidence.error}));
}
if(process.argv[1]?.replaceAll('\\','/').endsWith('/legacy-entrypoints-live.mjs'))await main();
