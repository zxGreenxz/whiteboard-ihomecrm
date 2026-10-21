import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {localCluster,setup,jwt,fast,normal,live,id,ORG,FOREIGN,USER,MEMBER,BUILDING,OTHER_BUILDING,ROOM,INVOICE,SUMMARY_PATH} from './crm-shared-read-sql-fixture.mjs';
import { domainInput, domainResult, summarizeRows } from './domain-contract.mjs';
import { domainFastResult } from './domain-read-fast.mjs';

// R2a (20261020233934) on real PostgreSQL 16+/17: the `summary` of crm_read_receivables on both lanes — the fast
// INVOKER reader (asker's RLS) and hermes_domain_read_v2 (DEFINER) — is computed over the WHOLE filtered set: same
// WHERE as the page without cursor/LIMIT. Proved here by (1) concrete totals on synthetic debts, (2) the oracle
// summary === summarizeRows(every row of the filtered set, read page by page), (3) the same summary on every page,
// (4) the filters narrowing it exactly like the rows, (5) empty sets giving zeros/containers, never NULL, (6) mutants of
// the summary statement (cursor kept, building scope dropped, status filter dropped) turning these checks red, and
// (7) the $requires$ guard stopping the file before it replaces anything when B5c step 2 is not live, and (8) the
// prepared revert artifact restoring the exact B5c step 2 bodies (then R2a forward again).
// Synthetic rows only (no customer data).
const [B2,R2,R3,R4,B3,R5]=[300,301,302,303,304,305].map(id);
const inv=n=>id(300+n);
const DEBTS=[INVOICE,inv(10),inv(11),inv(18),inv(20)];
const summarySql=readFileSync(SUMMARY_PATH,'utf8');
// Prepared rollback (not a migration): the 20261020173818 bodies of the three functions, with its own guards.
const REVERT=readFileSync('docs/plans/hermes-crm/revert/hermes_domain_summary_revert_v1.sql','utf8');
// The CREATE statement of one function in the R2a file (plpgsql ends at $fn$;, the SQL-standard reader at END;).
const statement=(name,end)=>{const start=summarySql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`),stop=summarySql.indexOf(end,start);
 assert.ok(start>=0&&stop>start,name);return summarySql.slice(start,stop+end.length);};
const READER=statement('app_private.hermes_domain_read_rows_fast_v1','\nEND;'),V2=statement('public.hermes_domain_read_v2','$fn$;');
const once=(sql,from,to)=>{assert.equal(sql.split(from).length,2,`anchor: ${from.trim()}`);return sql.replace(from,()=>to);};

test('R2a receivables summary: whole filtered set on both lanes, every page alike, filters and RLS narrow it like the rows; mutants are caught',{timeout:240000},async t=>{
 const {pool,cleanup}=await localCluster(t);t.after(async()=>{await pool.end();cleanup();});await setup(pool);
 const prepared=await jwt(pool,async c=>(await c.query("SELECT public.hermes_prepare_connection_v2($1,'{}','{}','unrestricted','{}') value",[ORG])).rows[0].value);
 const tokenDigest='c'.repeat(64),expiry=Date.now()+600000;
 const activated=(await pool.query('SELECT app_private.hermes_store_activate_v1($1::jsonb) value',[JSON.stringify({connectionId:prepared.id,expectedEpoch:1,operationId:id(53),intentSecret:prepared.intentSecret,
  userId:USER,providerSessionId:id(32),credentialRef:id(51),tokenDigest,tokenExpiresAt:expiry,sessionExpiresAt:Date.now()+3600000,
  sessionEnvelope:{v:1,algorithm:'A256GCM',keyVersion:'fixture',nonce:'a'.repeat(16),tag:'a'.repeat(22),ciphertext:'abcd'}})])).rows[0].value;
 const epoch=activated.connection.epoch;assert.equal(epoch,2);
 const bind4={connectionId:prepared.id,tokenDigest,expectedEpoch:epoch,expectedSessionRevision:1};
 const bind7={...bind4,expectedPolicyVersion:0,expectedMembershipId:MEMBER,expectedAuthorizationVersion:1};
 // Same synthetic debts as domain-receivables-fast-sql.test.mjs. Open debts: INVOICE (fixture BUILDING, 123456.75 − 456.50),
 // 310 PARTIAL_PAID (B2), 311 OVERDUE (B2), 318 APPROVED (BUILDING), 320 OVERDUE (BUILDING). Never counted: 312 settled,
 // 313 DRAFT, 314 PAID, 315 soft-deleted, 316 deleted room, 317 room of another building, 319 foreign company,
 // 321 open debt of the soft-deleted building B3 (outside the admitted scope), INVOICE2 CANCELLED.
 await pool.query(`INSERT INTO public.buildings(id,organization_id,user_id,name,name_sort,code,deleted_at) VALUES('${B2}','${ORG}','${USER}','Second building','second',null,null),
 ('${B3}','${ORG}','${USER}','Deleted building','deleted','DEL',now());
 INSERT INTO public.rooms VALUES('${R2}','${ORG}','${B2}','P201','p201',null),('${R3}','${ORG}','${B2}','P202','p202',now()),('${R4}','${FOREIGN}','${OTHER_BUILDING}','P301','p301',null),
 ('${R5}','${ORG}','${B3}','P501','p501',null);
 INSERT INTO public.invoices(id,organization_id,user_id,building_id,room_id,invoice_number,billing_month,due_date,status,total_amount,paid_amount,created_at,deleted_at) VALUES
 ('${inv(10)}','${ORG}','${USER}','${B2}','${R2}','HDON310','2026-10','2026-10-15','PARTIAL_PAID',1000,300,now(),null),
 ('${inv(11)}','${ORG}','${USER}','${B2}','${R2}','HDON311','2026-09','2026-09-30','OVERDUE',2000,0,now(),null),
 ('${inv(12)}','${ORG}','${USER}','${B2}','${R2}','HDON312','2026-10','2026-10-16','APPROVED',500,500,now(),null),
 ('${inv(13)}','${ORG}','${USER}','${B2}','${R2}','HDON313','2026-10','2026-10-20','DRAFT',700,0,now(),null),
 ('${inv(14)}','${ORG}','${USER}','${B2}','${R2}','HDON314','2026-10','2026-10-21','PAID',800,800,now(),null),
 ('${inv(15)}','${ORG}','${USER}','${B2}','${R2}','HDON315','2026-10','2026-10-01','APPROVED',900,0,now(),now()),
 ('${inv(16)}','${ORG}','${USER}','${B2}','${R3}','HDON316','2026-10','2026-10-02','APPROVED',950,0,now(),null),
 ('${inv(17)}','${ORG}','${USER}','${B2}','${ROOM}','HDON317','2026-10','2026-10-03','APPROVED',960,0,now(),null),
 ('${inv(18)}','${ORG}','${USER}','${BUILDING}','${ROOM}','HDON318','2026-11','2026-11-05','APPROVED',1100,100,now(),null),
 ('${inv(19)}','${FOREIGN}','${USER}','${OTHER_BUILDING}','${R4}','HDON319','2026-10','2026-10-04','APPROVED',970,0,now(),null),
 ('${inv(20)}','${ORG}','${USER}','${BUILDING}','${ROOM}','HDON320','2026-10',null,'OVERDUE',1200,0,now(),null),
 ('${inv(21)}','${ORG}','${USER}','${B3}','${R5}','HDON321','2026-10','2026-10-05','APPROVED',1300,0,now(),null);`);

 // Both lanes, one input: the two summaries are equal (v2 DEFINER vs the asker's RLS see the same set here).
 const lanes=async(input={})=>{
  const legacy=await normal(pool,bind7,'receivables',input),quick=(await fast(pool,bind4,'receivables',input)).result;
  assert.deepEqual(quick.summary,legacy.summary,`fast-vs-v2 summary ${JSON.stringify(input)}`);
  return quick;
 };
 // Every row of the filtered set, read page by page (limit 1) on the fast lane; every page's summary.
 const walk=async(input={})=>{
  const rows=[],summaries=[];
  for(let cursor=null,n=0;n<20;n++){
   const page=(await fast(pool,bind4,'receivables',{...input,limit:1,cursor})).result;
   rows.push(...page.items);summaries.push(page.summary);cursor=page.nextCursor;if(cursor===null)break;
  }
  return {rows,summaries};
 };
 // Oracle: the SQL summary equals the summary of every row of the filtered set, on every page.
 const oracle=async(input={},label=JSON.stringify(input))=>{
  const whole=await lanes(input),{rows,summaries}=await walk(input);
  assert.deepEqual(whole.summary,summarizeRows('receivables',rows),`${label}: summary = summarizeRows(every row)`);
  assert.equal(whole.summary.count,rows.length,`${label}: count = rows once every page is read`);
  for(const summary of summaries)assert.deepEqual(summary,whole.summary,`${label}: every page carries the whole set`);
  return whole;
 };
 const who={row:{id:prepared.id,userId:USER,organizationId:ORG},scopesByPermission:{}};

 await t.test('whole set: totals, byStatus and byBuilding (descending, admitted buildings only) — the summary of every row',async()=>{
  const whole=await oracle();
  assert.deepEqual(whole.items.map(row=>row.id),DEBTS);assert.equal(whole.nextCursor,null);
  assert.deepEqual(whole.summary,{count:5,byStatus:{APPROVED:2,PARTIAL_PAID:1,OVERDUE:2},
   sum:{totalAmount:'128756.75',paidAmount:'856.50',remainingAmount:'127900.25'},
   byBuilding:[{buildingId:BUILDING,buildingName:'Fixture building',count:3,remainingAmount:'125200.25'},
    {buildingId:B2,buildingName:'Second building',count:2,remainingAmount:'2700'}]},'HDON321 of the soft-deleted B3 is never counted');
  assert.equal(whole.summary.count,whole.items.length,'one page, no cursor: count === items.length');
 });
 await t.test('every page carries the same summary (limit 2, cursor); limit equal to the count has no cursor',async()=>{
  const whole=(await lanes()).summary;
  const first=await lanes({limit:2}),second=await lanes({limit:2,cursor:first.nextCursor}),third=await lanes({limit:2,cursor:second.nextCursor});
  assert.deepEqual([first.items.length,second.items.length,third.items.length,third.nextCursor],[2,2,1,null]);
  for(const page of [first,second,third])assert.deepEqual(page.summary,whole);
  assert.deepEqual(summarizeRows('receivables',[first,second,third].flatMap(page=>page.items)),whole,'reading every page gives back the summary');
 });
 await t.test('filters narrow the summary exactly like the rows: status, due dates, query (number or room), building',async()=>{
  const overdue=await oracle({status:'OVERDUE'});
  assert.deepEqual([overdue.summary.count,overdue.summary.byStatus,overdue.summary.byBuilding.map(entry=>[entry.buildingId,entry.remainingAmount])],
   [2,{OVERDUE:2},[[B2,'2000'],[BUILDING,'1200']]],'2000 (B2) before 1200 (BUILDING)');
  assert.deepEqual((await oracle({fromDate:'2026-10-01',toDate:'2026-10-31'})).summary,{count:1,byStatus:{PARTIAL_PAID:1},
   sum:{totalAmount:'1000',paidAmount:'300',remainingAmount:'700'},byBuilding:[{buildingId:B2,buildingName:'Second building',count:1,remainingAmount:'700'}]});
  assert.equal((await oracle({fromDate:'2026-10-01'})).summary.count,2,'a null due date never matches a range');
  assert.equal((await oracle({toDate:'2026-09-30'})).summary.count,1);
  assert.deepEqual((await oracle({query:'hdon31'})).summary.byStatus,{PARTIAL_PAID:1,OVERDUE:1,APPROVED:1});
  assert.deepEqual((await oracle({query:'  P201 '})).summary.byBuilding.map(entry=>entry.buildingId),[B2],'room name, trimmed');
  assert.deepEqual((await oracle({buildingId:B2})).summary.byBuilding.map(entry=>[entry.buildingId,entry.count]),[[B2,2]]);
  assert.deepEqual((await oracle({buildingId:BUILDING,status:'APPROVED'})).summary.sum,{totalAmount:'124556.75',paidAmount:'556.50',remainingAmount:'124000.25'});
 });
 await t.test('empty filtered set: count 0, empty byStatus/byBuilding and zero sums — never a NULL summary',async()=>{
  const empty={count:0,byStatus:{},sum:{totalAmount:'0',paidAmount:'0',remainingAmount:'0'},byBuilding:[]};
  for(const input of [{fromDate:'2027-01-01',toDate:'2027-01-31'},{query:'nothing-here'},{fromDate:'2026-09-30',toDate:'2026-09-30',status:'APPROVED'}])
   assert.deepEqual((await oracle(input)).summary,empty,JSON.stringify(input));
 });
 await t.test('the connector takes the SQL summary on both lanes and fences byBuilding with the live scope of the statement',async()=>{
  const value=await fast(pool,bind4,'receivables',{});
  assert.deepEqual(domainFastResult('receivables',value,who,domainInput('receivables',{})).summary,value.result.summary);
  const legacy=await normal(pool,bind7,'receivables',{}),scoped={...who,scopesByPermission:{'invoices.view':{buildingIds:[BUILDING,B2],cashbookIds:[]}}};
  assert.deepEqual(domainResult('receivables',legacy,scoped,domainInput('receivables',{})).summary,legacy.summary);
  const narrow={...value,authority:{...value.authority,buildingIds:[BUILDING]},result:{...value.result,items:value.result.items.filter(row=>row.buildingId===BUILDING)}};
  assert.throws(()=>domainFastResult('receivables',narrow,who,domainInput('receivables',{})),'a group of a building outside the live scope is refused');
 });
 await t.test('RLS narrowing: rooms hidden from the asker drop out of the fast summary exactly like its rows; v2 (DEFINER) keeps them',async()=>{
  await pool.query("UPDATE role_permissions SET effect='DENY' WHERE permission_key='buildings.view'");
  try{
   const legacy=await normal(pool,bind7,'receivables'),quick=(await fast(pool,bind4,'receivables')).result;
   assert.deepEqual([legacy.items.length,legacy.summary.count],[5,5]);
   assert.deepEqual([quick.items,quick.summary],[[],{count:0,byStatus:{},sum:{totalAmount:'0',paidAmount:'0',remainingAmount:'0'},byBuilding:[]}],
    'the summary never counts rows the asker cannot read');
  }finally{await pool.query("UPDATE role_permissions SET effect='ALLOW' WHERE permission_key='buildings.view'");}
  assert.equal((await lanes()).summary.count,5);
 });
 await t.test('mutants of the summary (fast: cursor kept, building scope dropped; v2: status filter dropped) are caught; the reviewed bodies are restored',async()=>{
  const probes=[
   ['fast summary follows the cursor',once(READER,"      AND (p->>'status' IS NULL OR invoice.status::text=p->>'status')\n",
    "      AND (p->>'status' IS NULL OR invoice.status::text=p->>'status') AND (p->>'cursor' IS NULL OR invoice.id>(p->>'cursor')::uuid)\n"),READER,()=>oracle({})],
   ['fast summary leaves the admitted buildings',once(READER,"      AND room.building_id=ANY(ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(p->'buildingIds') x))\n",''),READER,()=>oracle({buildingId:B2})],
   ['v2 summary ignores the status filter',once(V2,"          AND invoice.remaining_amount>0 AND (v_status IS NULL OR invoice.status::text=v_status)\n","          AND invoice.remaining_amount>0\n"),V2,()=>oracle({status:'OVERDUE'})],
  ];
  for(const [label,mutant,reviewed,probe] of probes){
   await probe();
   await pool.query(mutant);
   try{await assert.rejects(probe(),{code:'ERR_ASSERTION'},`${label}: the mutant is detected`);}
   finally{await pool.query(reviewed);}
   await probe();
  }
 });
 await t.test('$requires$: before B5c step 2 the file stops and replaces nothing (one transaction)',async()=>{
  const client=await pool.connect();
  const body=async()=>(await client.query("SELECT md5(prosrc) v FROM pg_proc WHERE oid='public.hermes_domain_read_v2(jsonb,text,jsonb)'::regprocedure")).rows[0].v;
  try{
   const before=await body();
   await client.query('BEGIN');
   // The v1 body before B5c (no building names) — as on a database where 20261020173818 has not run.
   await client.query(live.get('public.hermes_domain_read_v1'));
   await assert.rejects(client.query(summarySql),/hermes_domain_summary_requires_applied_b5c_step2_reads_v1/);
   await client.query('ROLLBACK');
   assert.equal(await body(),before,'v2 untouched');
  }finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
  assert.equal((await lanes()).summary.count,5,'the live bodies still answer');
 });
 await t.test('revert artifact (docs/plans/hermes-crm/revert): restores the exact 20261020173818 bodies (no summary), runs twice, and R2a re-applies after it',async()=>{
  const bodies=async()=>(await pool.query(`SELECT p.proname,CASE WHEN p.prosqlbody IS NULL THEN md5(p.prosrc) ELSE md5(pg_get_function_sqlbody(p.oid)) END body
   FROM pg_proc p WHERE p.proname IN ('hermes_domain_read_rows_fast_v1','hermes_domain_read_v1','hermes_domain_read_v2') ORDER BY 1`)).rows;
  const r2a=await bodies();
  await pool.query(REVERT);
  const reverted=await bodies();
  for(const [index,row] of reverted.entries())assert.notEqual(row.body,r2a[index].body,`${row.proname}: replaced`);
  const legacy=await normal(pool,bind7,'receivables'),quick=(await fast(pool,bind4,'receivables')).result;
  assert.deepEqual([Object.hasOwn(legacy,'summary'),Object.hasOwn(quick,'summary')],[false,false],'no summary on either lane');
  assert.deepEqual({...quick,fetchedAt:null},{...legacy,fetchedAt:null},'the lanes still agree');
  assert.deepEqual(quick.items.map(row=>row.id),DEBTS,'rows unchanged');
  assert.equal(Object.hasOwn((await fast(pool,bind4,'contracts')).result,'summary'),false);
  assert.deepEqual(domainFastResult('receivables',await fast(pool,bind4,'receivables',{}),who,domainInput('receivables',{})).items.length,5,
   'this connector release still accepts the reverted SQL (summary tolerant)');
  // Byte-identical to B5c step 2: running its file again changes no body.
  await pool.query(readFileSync('supabase/migrations/20261020173818_hermes_domain_reads_building_name_v1.sql','utf8'));
  assert.deepEqual(await bodies(),reverted,'the revert bodies are the 20261020173818 bodies');
  await pool.query(REVERT);assert.deepEqual(await bodies(),reverted,'a second run changes nothing');
  await pool.query(summarySql);
  assert.deepEqual(await bodies(),r2a,'R2a forward again: the reviewed bodies');
  assert.equal((await lanes()).summary.count,5);
 });
 await t.test('catalog: applied twice (idempotent) — one definition each, signatures, owner, ACL and the reader path kept',async()=>{
  const rows=(await pool.query(`SELECT n.nspname||'.'||p.proname name,p.prosecdef,p.provolatile,pg_get_userbyid(p.proowner) owner,p.proconfig
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proname IN ('hermes_domain_read_rows_fast_v1','hermes_domain_read_v1','hermes_domain_read_v2') ORDER BY 1`)).rows;
  assert.deepEqual(rows.map(row=>[row.name,row.prosecdef,row.provolatile]),[['app_private.hermes_domain_read_rows_fast_v1',false,'s'],
   ['public.hermes_domain_read_v1',true,'v'],['public.hermes_domain_read_v2',true,'v']]);
  assert.deepEqual(rows[0].proconfig.map(value=>value.replace(/"/g,'')),['search_path=']);
  for(const signature of ['app_private.hermes_domain_read_rows_fast_v1(jsonb)','public.hermes_domain_read_v1(jsonb,text,jsonb)','public.hermes_domain_read_v2(jsonb,text,jsonb)'])
   for(const [role,expected] of [['authenticated',true],['anon',false],['service_role',false],['hermes_store_executor',false]])
    assert.equal((await pool.query('SELECT has_function_privilege($1,$2,$3) value',[role,signature,'EXECUTE'])).rows[0].value,expected,`${role} ${signature}`);
  await pool.query(summarySql);
  assert.equal((await lanes()).summary.count,5,'a third run changes nothing');
 });
});
