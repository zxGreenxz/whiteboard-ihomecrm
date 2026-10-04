#!/usr/bin/env node
// TEST-only integration: real roles, authorization and canonical V5 inside ROLLBACK.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { credential, ketNoi, batBuocDichTest, psql, psqlJson, PhienPsql, lit, docVault } from './test-env/lib.mjs';
import { matKhauTest } from './test-env/hau-ky.mjs';
import { fixtureInvoiceSql, actAsFixtureActorSql, fixtureMarker, newRunId } from './lib/v5-collection-harness.mjs';

const migration = readFileSync(new URL('../supabase/migrations/20261004205216_acb_email_realtime.sql', import.meta.url),'utf8');
const run = newRunId();
async function networkChecks({cred,test,candidate,fixture,preparedSetup}) {
 const password=Array.from(docVault().matchAll(/^TEST_PASS (\S+) (\S+)\s*$/gm)).find(m=>m[1]===candidate.email)?.[2]??matKhauTest(cred.passwordSeed,candidate.email);
 const login=await fetch(`https://${cred.testRef}.supabase.co/auth/v1/token?grant_type=password`,{method:'POST',signal:AbortSignal.timeout(30000),headers:{apikey:cred.testPublishableKey,'Content-Type':'application/json'},body:JSON.stringify({email:candidate.email,password})});
 const auth=await login.json(); assert(login.ok&&auth.access_token,`TEST login HTTP ${login.status}`);
 const rpc=async(name,body,service=false)=>{
  console.log(`TEST PostgREST probe: ${name}`);
  let response;
  try {response=await fetch(`https://${cred.testRef}.supabase.co/rest/v1/rpc/${name}`,{method:'POST',signal:AbortSignal.timeout(30000),headers:{apikey:service?cred.testSecretKey:cred.testPublishableKey,...(service?{}:{Authorization:`Bearer ${auth.access_token}`}), 'Content-Type':'application/json','Content-Profile':'public','Accept-Profile':'public'},body:JSON.stringify(body)});}
  catch(error){throw new Error(`TEST PostgREST ${name}: ${error.name}`);}
  return {status:response.status,body:await response.json()};
 };
 const denied=await rpc('bank_email_worker_v1',{p_operation:'claim',p_payload:{}}); assert.equal(denied.body.code,'42501');
 const listed=await rpc('bank_email_list_v1',{p_organization_id:candidate.org}); assert.equal(listed.status,200,`REST list ${listed.body.code}`);
 const one=new PhienPsql(test),two=new PhienPsql(test); let context;
 try {
  await one.chay(`BEGIN; SET LOCAL statement_timeout='60s'; ${fixture} ${preparedSetup.slice(0,preparedSetup.indexOf('DO $ingest$'))}`);
  [context]=await one.json(`SELECT current_setting('acbh.payload')::jsonb payload,current_setting('v5h.invoice') invoice,current_setting('acbh.account') account,current_setting('acbh.connection') connection`);
  await one.chay('COMMIT;');
  const begin=(session,name)=>session.chay(`BEGIN;SET LOCAL statement_timeout='30s'; SET LOCAL application_name=${lit(name)};SELECT set_config('request.jwt.claims','{"role":"service_role"}',true),set_config('request.jwt.claim.sub','',true);SET LOCAL ROLE service_role;`);
  const ingest=`SELECT public.bank_email_worker_v1('ingest',${lit(JSON.stringify(context.payload))}::jsonb) result`;
  await begin(one,'acb-race-source-one'); await begin(two,'acb-race-source-two');
  const [first]=await one.json(ingest); assert.equal(first.result.status,'POSTED');
  const waiting=two.json(ingest); let blocked=false;
  try {
   for(let i=0;i<30;i++) {
    blocked=psqlJson(test,"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='acb-race-source-two' AND wait_event_type='Lock') yes")[0].yes;
    if(blocked) break; await new Promise(resolve=>setTimeout(resolve,50));
   }
   assert(blocked,'Second source writer did not wait on the connection/source lock');
  } finally { await one.chay('ROLLBACK;'); }
  const [second]=await waiting; assert.equal(second.result.status,'POSTED');
  await two.chay('RESET ROLE;');
  const [count]=await two.json(`SELECT count(*)::integer n FROM public.invoice_payment_collections WHERE invoice_id=${lit(context.invoice)}`);assert.equal(count.n,1);
  await two.chay('ROLLBACK;');
  // Manual V5 owns the same invoice lock; automatic posting must wait, then recheck outstanding.
  await one.chay(`BEGIN;SET LOCAL statement_timeout='30s';SELECT set_config('request.jwt.claims',${lit(JSON.stringify({sub:candidate.actor,role:'authenticated'}))},true);SET LOCAL ROLE authenticated;`);
  await one.json(`SELECT public.record_invoice_collection_v5(${lit(context.invoice)},current_date,${lit(JSON.stringify([{payment_method:'TK',gross_amount:5000000,account_id:context.account}]))}::jsonb,'REJECT',false,'ACB manual concurrency fixture',NULL,0,'acb-manual-${run}') result`);
  await begin(two,'acb-race-manual-two'); const manualWait=two.json(ingest);
  try {
   let manualBlocked=false;
   for(let i=0;i<30;i++) {
    manualBlocked=psqlJson(test,"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='acb-race-manual-two' AND wait_event_type='Lock') yes")[0].yes;
    if(manualBlocked) break; await new Promise(resolve=>setTimeout(resolve,50));
   }
   assert(manualBlocked,'Automatic writer did not wait for manual invoice lock');
  } finally {await one.chay('ROLLBACK;');}
  assert.equal((await manualWait)[0].result.status,'POSTED'); await two.chay('ROLLBACK;');
  const pending=await rpc('bank_email_worker_v1',{p_operation:'ingest',p_payload:{...context.payload,messageId:'rest-unverified',parsed:null,verified:false,parseError:'UNVERIFIED'}},true);
  assert.equal(pending.status,200,`REST service ingest ${pending.body.code}`);assert.equal(pending.body.status,'PENDING');
  const wrongSelection=await rpc('bank_email_review_v1',{p_transaction_id:pending.body.id,p_invoice_number:'NO-INVOICE',p_ignore:false,p_expected_invoice_id:context.invoice,p_expected_amount:5000000});assert.equal(wrongSelection.status,409);assert.equal(wrongSelection.body.code,'PT409');
  const reviewed=await rpc('bank_email_review_v1',{p_transaction_id:pending.body.id,p_invoice_number:null,p_ignore:true});assert.equal(reviewed.status,200);assert.equal(reviewed.body.status,'IGNORED');
  const exact=await rpc('bank_email_transaction_v1',{p_transaction_id:pending.body.id});assert.equal(exact.status,200);assert.equal(exact.body.id,pending.body.id);
  const own=await rpc('bank_email_my_connections_v1',{});assert.equal(own.status,200);assert(own.body.connections.some(c=>c.id===context.connection));
  console.log('PASS TEST network: authenticated PostgREST list/review, service ingest pending, user worker denied; two-session source and manual invoice lock races (money rolled back).');
 } finally {
  // PhienPsql.dong waits forever if a pooler has already closed the process.
  // End only our two sessions; abrupt disconnection rolls uncommitted money back.
  for(const session of [one,two]) if(session.p.exitCode===null){
   const closed=new Promise(resolve=>session.p.once('close',resolve));
   session.p.stdin.end('ROLLBACK;\n\\q\n');
   let timeout; await Promise.race([closed,new Promise(resolve=>{timeout=setTimeout(()=>{session.p.kill();resolve();},5000);})]);clearTimeout(timeout);
  }
  if(context) psql(test,`BEGIN;SET LOCAL statement_timeout='30s';
   DO $clean$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM public.invoices WHERE id=${lit(context.invoice)} AND organization_id=${lit(candidate.org)} AND notes=${lit(fixtureMarker(run))}) THEN RAISE EXCEPTION 'Fixture cleanup marker mismatch'; END IF;
    IF EXISTS(SELECT 1 FROM public.invoice_payment_collections WHERE invoice_id=${lit(context.invoice)}) THEN RAISE EXCEPTION 'Refuse cleanup: persisted money requires canonical reversal'; END IF;
   END $clean$;
   DELETE FROM public.notifications WHERE metadata->>'bankEmailTransactionId' IN(SELECT id::text FROM public.bank_email_transactions WHERE connection_id=${lit(context.connection)});
   DELETE FROM app_private.bank_email_sources WHERE transaction_id IN(SELECT id FROM public.bank_email_transactions WHERE connection_id=${lit(context.connection)});
   DELETE FROM public.bank_email_transactions WHERE connection_id=${lit(context.connection)};
   DELETE FROM app_private.bank_email_jobs WHERE connection_id=${lit(context.connection)};
   DELETE FROM app_private.bank_email_credentials WHERE connection_id=${lit(context.connection)};
   DELETE FROM app_private.bank_email_oauth_states WHERE connection_id=${lit(context.connection)};
   DELETE FROM public.bank_email_connections WHERE id=${lit(context.connection)};
   SELECT set_config('request.jwt.claims',${lit(JSON.stringify({sub:candidate.actor,role:'authenticated'}))},true),set_config('request.jwt.claim.sub',${lit(candidate.actor)},true);
   SET LOCAL ROLE authenticated;
   SELECT public.soft_delete_invoice_with_credit_v1(${lit(context.invoice)},${lit(`acb-fixture-cleanup-${run}`)});
   COMMIT;`);
 }
}
const setup = `
DO $catalog$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'bank_email_%'
  AND (pg_get_userbyid(p.proowner)<>'postgres' OR NOT p.prosecdef OR p.proconfig IS NULL OR has_function_privilege('anon',p.oid,'EXECUTE')
   OR (p.proname='bank_email_worker_v1' AND has_function_privilege('authenticated',p.oid,'EXECUTE'))
   OR (p.proname<>'bank_email_worker_v1' AND has_function_privilege('service_role',p.oid,'EXECUTE')))) THEN RAISE EXCEPTION 'ACB RPC ACL/owner/search_path catalog mismatch'; END IF;
 IF has_table_privilege('authenticated','app_private.bank_email_credentials','SELECT') OR has_table_privilege('service_role','app_private.bank_email_credentials','SELECT') THEN RAISE EXCEPTION 'Private credentials directly readable'; END IF;
 IF to_regprocedure('public.bank_email_review_v1(uuid,text,boolean)') IS NOT NULL THEN RAISE EXCEPTION 'Unsafe legacy review overload remains'; END IF;
END $catalog$;
DO $setup$
DECLARE a uuid; m uuid; c jsonb; inv public.invoices;
BEGIN
 SELECT * INTO inv FROM public.invoices WHERE id=current_setting('v5h.invoice')::uuid;
 SELECT id INTO m FROM public.organization_memberships WHERE user_id=current_setting('v5h.actor')::uuid AND organization_id=inv.organization_id AND status='ACTIVE';
 a:=(app_private.receiving_cashbook_ids_v1(inv.organization_id,inv.building_id,'TK',m))[1];
 IF a IS NULL THEN RAISE EXCEPTION 'TEST fixture requires a configured receiving cashbook'; END IF;
 PERFORM set_config('acbh.account',a::text,true);
END $setup$;
${actAsFixtureActorSql()}
DO $setup_user$
DECLARE c jsonb;
BEGIN
 c:=public.bank_email_setup_v1('dddd0000-0000-4000-8000-000000000001','999999991234567890',current_setting('acbh.account')::uuid);
 PERFORM set_config('acbh.connection',c->>'id',true);
 PERFORM public.bank_email_oauth_begin_v1((c->>'id')::uuid,repeat('b',64),'synthetic-ciphertext');
 BEGIN PERFORM public.bank_email_worker_v1('claim','{}'); RAISE EXCEPTION 'authenticated reached service RPC'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM 1 FROM app_private.bank_email_credentials; RAISE EXCEPTION 'authenticated read private credentials'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 IF (public.bank_email_list_v1('dddd0000-0000-4000-8000-000000000001')->'connections'->0->>'id') IS NULL THEN RAISE EXCEPTION 'owner cannot list'; END IF;
END $setup_user$;
RESET ROLE;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true),set_config('request.jwt.claim.sub','',true);
SET LOCAL ROLE service_role;
DO $oauth$
DECLARE r jsonb;
BEGIN
 r:=public.bank_email_worker_v1('oauth_consume',jsonb_build_object('stateHash',repeat('b',64)));
 BEGIN PERFORM public.bank_email_worker_v1('oauth_consume',jsonb_build_object('stateHash',repeat('b',64))); RAISE EXCEPTION 'replayed OAuth'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 PERFORM public.bank_email_worker_v1('oauth_complete',jsonb_build_object('stateHash',repeat('b',64),'email','acb-harness@example.test','encryptedRefreshToken','synthetic-ciphertext','historyId','100','watchExpiresAt',clock_timestamp()+interval '1 day'));
 r:=public.bank_email_worker_v1('claim','{}');
 PERFORM set_config('acbh.lease',r->'jobs'->0->>'leaseToken',true);
 IF current_setting('acbh.lease',true) IS NULL THEN RAISE EXCEPTION 'job not claimed'; END IF;
 IF jsonb_array_length(public.bank_email_worker_v1('claim','{}')->'jobs')<>0 THEN RAISE EXCEPTION 'live lease reclaimed'; END IF;
END $oauth$;
RESET ROLE;
${actAsFixtureActorSql()}
SELECT public.bank_email_set_enabled_v1(current_setting('acbh.connection')::uuid,true);
RESET ROLE;
DO $payload$
DECLARE i public.invoices;
BEGIN
 SELECT * INTO i FROM public.invoices WHERE id=current_setting('v5h.invoice')::uuid;
 PERFORM set_config('acbh.payload',jsonb_build_object('connectionId',current_setting('acbh.connection'),'leaseToken',current_setting('acbh.lease'),
 'messageId','synthetic-message-1','internalDate',clock_timestamp(),'verified',true,'parseError',NULL,
 'parsed',jsonb_build_object('account','999999991234567890','amount',i.total_amount,'balance',90000000,'currency','VND','direction','CREDIT',
 'occurredAt',clock_timestamp(),'bankReference','SYNTHETIC-ACB-REF-1','description','Thanh toan '||i.invoice_number))::text,true);
END $payload$;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true),set_config('request.jwt.claim.sub','',true);
SET LOCAL ROLE service_role;
DO $ingest$
DECLARE p jsonb:=current_setting('acbh.payload')::jsonb; r jsonb; r2 jsonb;
BEGIN
 r:=public.bank_email_worker_v1('ingest',p);
 IF r->>'status'<>'POSTED' THEN RAISE EXCEPTION 'exact verified invoice was not POSTED: %',r->>'reason'; END IF;
 PERFORM set_config('acbh.transaction',r->>'id',true);
 r2:=public.bank_email_worker_v1('ingest',p);
 IF r->>'id'<>r2->>'id' THEN RAISE EXCEPTION 'message replay changed id'; END IF;
 r2:=public.bank_email_worker_v1('ingest',p||jsonb_build_object('messageId','synthetic-message-2'));
 IF r->>'id'<>r2->>'id' THEN RAISE EXCEPTION 'source redelivery changed id'; END IF;
 IF auth.uid() IS NOT NULL OR auth.role()<>'service_role' THEN RAISE EXCEPTION 'delegation leaked JWT claims'; END IF;
 BEGIN PERFORM public.bank_email_worker_v1('checkpoint',p||jsonb_build_object('leaseToken',gen_random_uuid(),'historyId','101')); RAISE EXCEPTION 'wrong lease accepted'; EXCEPTION WHEN serialization_failure THEN NULL; END;
END $ingest$;
RESET ROLE;
DO $assert_money$
DECLARE n integer; i public.invoices;
BEGIN
 SELECT * INTO i FROM public.invoices WHERE id=current_setting('v5h.invoice')::uuid;
 SELECT count(*) INTO n FROM public.invoice_payment_collections WHERE invoice_id=i.id;
 IF n<>1 OR i.paid_amount<>i.total_amount THEN RAISE EXCEPTION 'double post or money mismatch'; END IF;
 SELECT count(*) INTO n FROM public.notifications WHERE metadata->>'bankEmailTransactionId'=current_setting('acbh.transaction');
 IF n<>1 THEN RAISE EXCEPTION 'source notification count %',n; END IF;
END $assert_money$;
SELECT set_config('request.jwt.claims',jsonb_build_object('sub',gen_random_uuid(),'role','authenticated')::text,true);
SET LOCAL ROLE authenticated;
DO $isolation$
BEGIN
 IF EXISTS(SELECT 1 FROM public.bank_email_connections WHERE id=current_setting('acbh.connection')::uuid) THEN RAISE EXCEPTION 'RLS disclosed another owner connection'; END IF;
 BEGIN PERFORM public.bank_email_review_v1(current_setting('acbh.transaction')::uuid,'irrelevant',false); RAISE EXCEPTION 'other owner reviewed source'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $isolation$;
RESET ROLE;
UPDATE public.organization_memberships SET valid_to=clock_timestamp()-interval '1 second' WHERE user_id=current_setting('v5h.actor')::uuid AND organization_id='dddd0000-0000-4000-8000-000000000001';
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true),set_config('request.jwt.claim.sub','',true);
SET LOCAL ROLE service_role;
DO $revoked$
BEGIN
 BEGIN PERFORM public.bank_email_worker_v1('ingest',current_setting('acbh.payload')::jsonb); RAISE EXCEPTION 'revoked owner replay accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $revoked$;
RESET ROLE;
${actAsFixtureActorSql()}
DO $revoke_grant$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(public.bank_email_my_connections_v1()->'connections') c WHERE c->>'id'=current_setting('acbh.connection')) THEN RAISE EXCEPTION 'revoked owner cannot find OAuth grant'; END IF;
 PERFORM public.bank_email_disconnect_v1(current_setting('acbh.connection')::uuid);
END $revoke_grant$;
RESET ROLE;
`;
try {
 const cred=credential(); const {test}=await ketNoi(cred); await batBuocDichTest(cred,test);
 const [candidate]=psqlJson(test,`SELECT m.user_id actor,m.organization_id org,u.email FROM public.organization_memberships m JOIN auth.users u ON u.id=m.user_id
 WHERE m.status='ACTIVE' AND app_private.ie_actor_is_company_owner_v1(m.organization_id,m.user_id)
 AND EXISTS(SELECT 1 FROM public.buildings b WHERE b.organization_id=m.organization_id AND b.deleted_at IS NULL
 AND cardinality(app_private.receiving_cashbook_ids_v1(m.organization_id,b.id,'TK',m.id))>0) ORDER BY m.organization_id,m.user_id LIMIT 1`);
 if(!candidate) throw new Error('No TEST actor with current owner rights and receiving cashbook');
 const fixture=fixtureInvoiceSql({marker:fixtureMarker(run),billingMonth:'2094-11',rent:3000000,deposit:2000000})
  .replaceAll('dddd0000-0000-4000-8000-000000000001',candidate.org)
  .replace("SELECT id INTO v_actor FROM auth.users WHERE email = 'demo.chunha@username.ihomecrm.local';",`SELECT '${candidate.actor}'::uuid INTO v_actor;`)
  .replace('AND NOT building_row.is_virtual',`AND NOT building_row.is_virtual AND cardinality(app_private.receiving_cashbook_ids_v1(v_org,building_row.id,'TK',(SELECT id FROM public.organization_memberships WHERE organization_id=v_org AND user_id=v_actor AND status='ACTIVE' LIMIT 1)))>0`);
 const sql=`BEGIN; SET LOCAL statement_timeout='120s'; SET LOCAL client_min_messages=warning;\n${migration}\n${migration}\n${fixture}\n${setup.replaceAll('dddd0000-0000-4000-8000-000000000001',candidate.org)}\nROLLBACK;`;
 psql(test,sql,{timeoutMs:180000});
 console.log('PASS TEST ROLLBACK: migration twice, real authenticated/service roles, OAuth one-use, private ACL, RLS isolation, exact canonical V5, source/message replay, notification once, stale lease, revoked membership replay.');
 if(process.argv.includes('--network')) await networkChecks({cred,test,candidate,fixture,preparedSetup:setup.replaceAll('dddd0000-0000-4000-8000-000000000001',candidate.org)});
} catch(error) { console.error(error.message); process.exitCode=1; }
