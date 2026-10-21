import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {localCluster,setup,jwt,fast,normal,live,settings,id,ORG,FOREIGN,USER,MEMBER,ROLE,BUILDING,OTHER_BUILDING,BUILDING_SCOPE,ROOM,CUSTOMER,CUSTOMER2,HIDDEN,CONTRACT,
 SUMMARY_PATH,LARGEST_BY_TYPE_PATH,CUSTOMER_STATUS_PATH,INVOICE} from './crm-shared-read-sql-fixture.mjs';
import { DOMAIN_SUMMARY_ENTRY_TOLERANT, domainInput, domainResult, summarizeRows } from './domain-contract.mjs';
import { domainFastResult } from './domain-read-fast.mjs';

// R2a (20261020233934) on real PostgreSQL 16+/17: the `summary` of crm_read_receivables on both lanes — the fast
// INVOKER reader (asker's RLS) and hermes_domain_read_v2 (DEFINER) — is computed over the WHOLE filtered set: same
// WHERE as the page without cursor/LIMIT. Proved here by (1) concrete totals on synthetic debts, (2) the oracle
// summary === summarizeRows(every row of the filtered set, read page by page), (3) the same summary on every page,
// (4) the filters narrowing it exactly like the rows, (5) empty sets giving zeros/containers, never NULL, (6) mutants of
// the summary statement (cursor kept, building scope dropped, status filter dropped) turning these checks red, and
// (7) the $requires$ guard stopping the file before it replaces anything when B5c step 2 is not live, and (8) the
// prepared revert artifact restoring the exact B5c step 2 bodies (then R2a forward again).
// R2c (20261021035022, second test below): byType.<INCOME|EXPENSE>.largest of crm_read_income_expenses on v2.
// Synthetic rows only (no customer data).
const [B2,R2,R3,R4,B3,R5]=[300,301,302,303,304,305].map(id);
const inv=n=>id(300+n);
const DEBTS=[INVOICE,inv(10),inv(11),inv(18),inv(20)];
const summarySql=readFileSync(SUMMARY_PATH,'utf8'),largestSql=readFileSync(LARGEST_BY_TYPE_PATH,'utf8'),customerStatusSql=readFileSync(CUSTOMER_STATUS_PATH,'utf8');
// Prepared rollbacks (not migrations): R2a → the 20261020173818 bodies of the three functions; R2c → the R2a v2 body;
// R2c part 2 → the R2a reader and v1 bodies.
const REVERT=readFileSync('docs/plans/hermes-crm/revert/hermes_domain_summary_revert_v1.sql','utf8');
const REVERT_LARGEST=readFileSync('docs/plans/hermes-crm/revert/hermes_domain_summary_largest_by_type_revert_v1.sql','utf8');
const REVERT_CUSTOMER_STATUS=readFileSync('docs/plans/hermes-crm/revert/hermes_domain_customer_status_asset_created_revert_v1.sql','utf8');
// The CREATE statement of one function in a file (plpgsql ends at $fn$;, the SQL-standard reader at END;).
const statement=(name,end,sql=summarySql)=>{const start=sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`),stop=sql.indexOf(end,start);
 assert.ok(start>=0&&stop>start,name);return sql.slice(start,stop+end.length);};
// The live bodies: the reader of R2c part 2 (receivables unchanged since R2a) and the R2c v2, so a restored mutant is live.
const READER=statement('app_private.hermes_domain_read_rows_fast_v1','\nEND;',customerStatusSql),V2=statement('public.hermes_domain_read_v2','$fn$;',largestSql);
const R2A_READER=statement('app_private.hermes_domain_read_rows_fast_v1','\nEND;');
const R2A_V2=statement('public.hermes_domain_read_v2','$fn$;'),B5C_V2=statement('public.hermes_domain_read_v2','$fn$;',
 readFileSync('supabase/migrations/20261020173818_hermes_domain_reads_building_name_v1.sql','utf8'));
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
  // The live bodies: the R2c part 2 reader and v1, R2c v2 (its R2a summary extended). The R2a artifact runs over the R2c
  // v2 but refuses the part 2 v1 (one more building name): its own revert runs first, as the artifact header says.
  const r2a=await bodies();
  await assert.rejects(pool.query(REVERT),/hermes_domain_summary_revert_unexpected_reads_v1/);
  assert.deepEqual(await bodies(),r2a,'refused: nothing replaced');
  await pool.query(REVERT_CUSTOMER_STATUS);
  await pool.query(REVERT);
  const reverted=await bodies();
  for(const [index,row] of reverted.entries())assert.notEqual(row.body,r2a[index].body,`${row.proname}: replaced`);
  const legacy=await normal(pool,bind7,'receivables'),quick=(await fast(pool,bind4,'receivables')).result;
  assert.deepEqual([Object.hasOwn(legacy,'summary'),Object.hasOwn(quick,'summary')],[false,false],'no summary on either lane');
  assert.deepEqual({...quick,fetchedAt:null},{...legacy,fetchedAt:null},'the lanes still agree');
  assert.deepEqual(quick.items.map(row=>row.id),DEBTS,'rows unchanged');
  assert.equal(Object.hasOwn((await fast(pool,bind4,'contracts')).result,'summary'),false);
  // The R2a window is closed (DOMAIN_SUMMARY_TOLERANT = [], R2c connector): the reverted SQL is refused. The artifact's
  // SAFE ORDER rolls the connector back to the R2a release (3762b3a0) before applying it.
  const withoutSummary=await fast(pool,bind4,'receivables',{});
  assert.throws(()=>domainFastResult('receivables',withoutSummary,who,domainInput('receivables',{})),'summary is required: the reverted SQL is refused');
  // Byte-identical to B5c step 2: running its file again changes no body.
  await pool.query(readFileSync('supabase/migrations/20261020173818_hermes_domain_reads_building_name_v1.sql','utf8'));
  assert.deepEqual(await bodies(),reverted,'the revert bodies are the 20261020173818 bodies');
  await pool.query(REVERT);assert.deepEqual(await bodies(),reverted,'a second run changes nothing');
  await pool.query(summarySql);await pool.query(largestSql);await pool.query(customerStatusSql);
  assert.deepEqual(await bodies(),r2a,'R2a, R2c and R2c part 2 forward again: the reviewed bodies');
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
  await pool.query(summarySql);await pool.query(largestSql);await pool.query(customerStatusSql);
  assert.equal((await lanes()).summary.count,5,'a third run changes nothing');
 });
});

// R2c (20261021035022) on real PostgreSQL 16+/17: crm_read_income_expenses runs on hermes_domain_read_v2 only (DEFINER;
// the fast reader has no income_expenses branch). Production 21/10: "khoản chi lớn nhất tháng này" ⇒ {fromDate,toDate}
// (no type parameter) ⇒ summary.largest was an income voucher. Each byType entry now names the largest live voucher of
// ITS type over the whole filtered set. Proved by concrete synthetic vouchers (tie by id, CANCELLED and excluded vouchers
// left out, every filter), the oracle summarizeRows(every row read page by page) on every page, the connector accepting
// it, mutants of the per-type statement turning the checks red (three also refused by the connector's own invariants),
// $requires$ stopping the file before R2a, the prepared revert artifact restoring the exact R2a body (accepted by this
// connector release: DOMAIN_SUMMARY_ENTRY_TOLERANT), and catalog/idempotency.
const ie=n=>id(400+n);
const [E7,I1,E2,E3,I2,I3,E1]=[11,12,13,14,15,16,20].map(ie);
test('R2c income_expenses: byType.<type>.largest = the largest live voucher of that type on the whole filtered set; mutants are caught',{timeout:240000},async t=>{
 const {pool,cleanup}=await localCluster(t);t.after(async()=>{await pool.end();cleanup();});await setup(pool);
 // The production columns the v2 branch reads (amounts >= 0 like CHECK income_expenses_total_amount_non_negative).
 await pool.query(`CREATE TABLE public.income_expenses(id uuid PRIMARY KEY,organization_id uuid NOT NULL,user_id uuid,code text,
  type text NOT NULL CHECK(type IN('INCOME','EXPENSE')),name text NOT NULL,building_id uuid NOT NULL,room_id uuid,voucher_date date NOT NULL,
  total_amount numeric(15,2) NOT NULL DEFAULT 0 CHECK(total_amount>=0),approval_status text NOT NULL DEFAULT 'APPROVED',
  has_restricted_item boolean NOT NULL DEFAULT false,salary_staff_id uuid,shareholder_id uuid,profit_manager_id uuid,deleted_at timestamptz);
 INSERT INTO public.permission_definitions(key) VALUES('income_expenses.view') ON CONFLICT DO NOTHING;
 INSERT INTO public.role_permissions VALUES('${ORG}','${ROLE}','income_expenses.view','ALLOW');
 INSERT INTO app_private.hermes_capabilities VALUES('income_expenses.view','read',true) ON CONFLICT DO NOTHING;
 INSERT INTO public.buildings(id,organization_id,user_id,name,name_sort,code,deleted_at) VALUES('${B2}','${ORG}','${USER}','Second building','second',null,null),
 ('${B3}','${ORG}','${USER}','Deleted building','deleted','DEL',now());
 INSERT INTO public.rooms VALUES('${R2}','${ORG}','${B2}','P201','p201',null);
 INSERT INTO public.income_expenses(id,organization_id,user_id,code,type,name,building_id,room_id,voucher_date,total_amount,approval_status,
  has_restricted_item,salary_staff_id,shareholder_id,profit_manager_id,deleted_at) VALUES
 ('${E7}','${ORG}','${USER}','PC07','EXPENSE','Sơn lại','${B2}',null,'2026-10-20',4500000,'APPROVED',false,null,null,null,null),
 ('${I1}','${ORG}','${USER}','PT01','INCOME','Thu tiền phòng','${BUILDING}','${ROOM}','2026-10-01',6000000,'APPROVED',false,null,null,null,null),
 ('${E2}','${ORG}','${USER}','PC02','EXPENSE','Vật tư điện','${BUILDING}',null,'2026-10-12',1200000.50,'UNAPPROVED',false,null,null,null,null),
 ('${E3}','${ORG}','${USER}','PC03','EXPENSE','Huỷ lớn','${BUILDING}',null,'2026-10-08',90000000,'CANCELLED',false,null,null,null,null),
 ('${I2}','${ORG}','${USER}','PT02','INCOME','Thu cọc','${BUILDING}',null,'2026-09-28',3000000,'APPROVED',false,null,null,null,null),
 ('${I3}','${ORG}','${USER}','PT03','INCOME','Thu điện nước','${B2}','${R2}','2026-10-15',800000,'UNAPPROVED',false,null,null,null,null),
 ('${E1}','${ORG}','${USER}','PC01','EXPENSE','Sửa máy bơm','${BUILDING}',null,'2026-10-05',4500000,'APPROVED',false,null,null,null,null),
 ('${ie(30)}','${ORG}','${USER}','PC30','EXPENSE','Lương','${BUILDING}',null,'2026-10-06',99999999,'APPROVED',false,'${USER}',null,null,null),
 ('${ie(31)}','${ORG}','${USER}','PC31','EXPENSE','Hạn chế','${BUILDING}',null,'2026-10-06',88888888,'APPROVED',true,null,null,null,null),
 ('${ie(32)}','${ORG}','${USER}','PC32','EXPENSE','Cổ đông','${BUILDING}',null,'2026-10-06',77777777,'APPROVED',false,null,'${USER}',null,null),
 ('${ie(33)}','${ORG}','${USER}','PC33','EXPENSE','Quản lý lợi nhuận','${BUILDING}',null,'2026-10-06',66666666,'APPROVED',false,null,null,'${USER}',null),
 ('${ie(34)}','${ORG}','${USER}','PC34','EXPENSE','Đã xoá','${BUILDING}',null,'2026-10-06',55555555,'APPROVED',false,null,null,null,now()),
 ('${ie(35)}','${FOREIGN}','${USER}','PC35','EXPENSE','Công ty khác','${OTHER_BUILDING}',null,'2026-10-06',44444444,'APPROVED',false,null,null,null,null),
 ('${ie(36)}','${ORG}','${USER}','PC36','EXPENSE','Toà đã xoá','${B3}',null,'2026-10-06',33333333,'APPROVED',false,null,null,null,null);`);
 const prepared=await jwt(pool,async c=>(await c.query("SELECT public.hermes_prepare_connection_v2($1,'{}','{}','unrestricted','{}') value",[ORG])).rows[0].value);
 const tokenDigest='c'.repeat(64),expiry=Date.now()+600000;
 const activated=(await pool.query('SELECT app_private.hermes_store_activate_v1($1::jsonb) value',[JSON.stringify({connectionId:prepared.id,expectedEpoch:1,operationId:id(53),intentSecret:prepared.intentSecret,
  userId:USER,providerSessionId:id(32),credentialRef:id(51),tokenDigest,tokenExpiresAt:expiry,sessionExpiresAt:Date.now()+3600000,
  sessionEnvelope:{v:1,algorithm:'A256GCM',keyVersion:'fixture',nonce:'a'.repeat(16),tag:'a'.repeat(22),ciphertext:'abcd'}})])).rows[0].value;
 const bind7={connectionId:prepared.id,tokenDigest,expectedEpoch:activated.connection.epoch,expectedSessionRevision:1,expectedPolicyVersion:0,expectedMembershipId:MEMBER,expectedAuthorizationVersion:1};
 const who={row:{id:prepared.id,userId:USER,organizationId:ORG},scopesByPermission:{'income_expenses.view':{buildingIds:[BUILDING,B2],cashbookIds:[]}}};
 const read=(input={})=>normal(pool,bind7,'income_expenses',input);
 const voucher=(voucherId,code,name,type,totalAmount,voucherDate)=>({id:voucherId,code,name,type,totalAmount,voucherDate});
 const V={E7:voucher(E7,'PC07','Sơn lại','EXPENSE','4500000.00','2026-10-20'),I1:voucher(I1,'PT01','Thu tiền phòng','INCOME','6000000.00','2026-10-01'),
  E2:voucher(E2,'PC02','Vật tư điện','EXPENSE','1200000.50','2026-10-12'),I3:voucher(I3,'PT03','Thu điện nước','INCOME','800000.00','2026-10-15'),
  E1:voucher(E1,'PC01','Sửa máy bơm','EXPENSE','4500000.00','2026-10-05')};
 // Oracle: the SQL summary equals the summary of every row of the filtered set (read one row per page), on every page,
 // and the connector accepts it.
 const oracle=async(input={},label=JSON.stringify(input))=>{
  const whole=await read(input),rows=[],summaries=[];
  for(let cursor=null,n=0;n<20;n++){
   const page=await read({...input,limit:1,cursor});
   rows.push(...page.items);summaries.push(page.summary);cursor=page.nextCursor;if(cursor===null)break;
  }
  assert.deepEqual(whole.summary,summarizeRows('income_expenses',rows),`${label}: summary = summarizeRows(every row)`);
  assert.equal(whole.summary.count,rows.length,`${label}: count = rows once every page is read`);
  for(const summary of summaries)assert.deepEqual(summary,whole.summary,`${label}: every page carries the whole set`);
  assert.deepEqual(domainResult('income_expenses',whole,who,domainInput('income_expenses',input)).summary,whole.summary,`${label}: the connector accepts it`);
  return whole.summary;
 };
 const month={fromDate:'2026-10-01',toDate:'2026-10-31'};

 await t.test('whole set and the production question (this month): byType.EXPENSE.largest is the largest expense while summary.largest is an income voucher',async()=>{
  assert.deepEqual(await oracle(),{count:7,byStatus:{APPROVED:4,UNAPPROVED:2,CANCELLED:1},sum:{totalAmount:'20000000.50'},
   byType:{INCOME:{count:3,sum:'9800000.00',largest:V.I1},EXPENSE:{count:3,sum:'10200000.50',largest:V.E7}},largest:V.I1},
   'the 90 000 000 voucher is CANCELLED; salary, restricted, shareholder, profit-manager, deleted, foreign and deleted-building vouchers never count');
  const october=await oracle(month);
  assert.deepEqual([october.largest.type,october.byType.EXPENSE.largest,october.byType.INCOME],['INCOME',V.E7,{count:2,sum:'6800000.00',largest:V.I1}],
   'summary.largest stays the income voucher (compatibility); the answer is byType.EXPENSE.largest');
  assert.equal(october.byType.EXPENSE.largest.id,E7,'4 500 000 twice: the smaller id, like ORDER BY total_amount DESC, id');
 });
 await t.test('filters narrow each type like the rows: status, period, building, query; an absent type has no entry; CANCELLED only or nothing: {} and null',async()=>{
  assert.deepEqual((await oracle({status:'APPROVED'})).byType,{INCOME:{count:2,sum:'9000000.00',largest:V.I1},EXPENSE:{count:2,sum:'9000000.00',largest:V.E7}});
  const pending=await oracle({status:'UNAPPROVED'});
  assert.deepEqual([pending.byType.INCOME.largest,pending.byType.EXPENSE.largest,pending.largest],[V.I3,V.E2,V.E2]);
  const early=await oracle({fromDate:'2026-10-01',toDate:'2026-10-10'});
  assert.deepEqual([early.byType.EXPENSE,early.byType.INCOME.largest],[{count:1,sum:'4500000.00',largest:V.E1},V.I1],'the CANCELLED voucher of the period is left out');
  const second=await oracle({buildingId:B2});
  assert.deepEqual([second.byType.EXPENSE.largest,second.byType.INCOME.largest,second.largest],[V.E7,V.I3,V.E7]);
  const income=await oracle({query:'thu'});
  assert.deepEqual([Object.keys(income.byType),income.byType.INCOME.count,income.largest.id],[['INCOME'],3,I1],'no expense matches: no EXPENSE entry, so no largest expense');
  assert.deepEqual(await oracle({status:'CANCELLED'}),{count:1,byStatus:{CANCELLED:1},sum:{totalAmount:'0'},byType:{},largest:null});
  assert.deepEqual(await oracle({query:'khong-co-phieu'}),{count:0,byStatus:{},sum:{totalAmount:'0'},byType:{},largest:null},'empty set: never a NULL summary');
 });
 await t.test('mutants of the per-type statement are caught by the oracle; three also by the connector invariants; the reviewed body is restored',async()=>{
  for(const [label,from,to,refusedByConnector] of [
   ['the per-type largest ignores the type','FROM live big WHERE big.type=t.type ORDER BY','FROM live big ORDER BY',true],
   ['the per-type largest keeps CANCELLED vouchers','FROM live big WHERE','FROM f big WHERE',true],
   ['the per-type largest takes the smallest voucher','ORDER BY big.total_amount DESC,big.id LIMIT 1','ORDER BY big.total_amount,big.id LIMIT 1',true],
   ['the per-type tie is broken the wrong way','ORDER BY big.total_amount DESC,big.id LIMIT 1','ORDER BY big.total_amount DESC,big.id DESC LIMIT 1',false]]){
   await oracle(month);
   await pool.query(once(V2,from,to));
   try{
    await assert.rejects(oracle(month),{code:'ERR_ASSERTION'},`${label}: the mutant is detected`);
    const mutated=await read(month);
    if(refusedByConnector)assert.throws(()=>domainResult('income_expenses',mutated,who,domainInput('income_expenses',month)),`${label}: refused by the connector`);
    else assert.deepEqual(domainResult('income_expenses',mutated,who,domainInput('income_expenses',month)).summary.byType.EXPENSE.largest,V.E1,`${label}: only the oracle sees it`);
   }finally{await pool.query(V2);}
   await oracle(month);
  }
 });
 await t.test('$requires$: before R2a (v2 without summary) the file stops and replaces nothing (one transaction)',async()=>{
  const client=await pool.connect();
  const body=async()=>(await client.query("SELECT md5(prosrc) v FROM pg_proc WHERE oid='public.hermes_domain_read_v2(jsonb,text,jsonb)'::regprocedure")).rows[0].v;
  try{
   const before=await body();
   await client.query('BEGIN');
   await client.query(B5C_V2); // the 20261020173818 body — as on a database where R2a has not run
   await assert.rejects(client.query(largestSql),/hermes_domain_summary_largest_requires_applied_r2a_reads_v2/);
   await client.query('ROLLBACK');
   assert.equal(await body(),before,'v2 untouched');
  }finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
  await oracle();
 });
 await t.test('revert artifact (docs/plans/hermes-crm/revert): the exact R2a body (byType without largest, nothing else changed), runs twice, this connector release accepts it, R2c forward again',async()=>{
  const body=async()=>(await pool.query("SELECT md5(prosrc) v FROM pg_proc WHERE oid='public.hermes_domain_read_v2(jsonb,text,jsonb)'::regprocedure")).rows[0].v;
  const r2c=await body(),forward=await read(month);
  assert.equal(REVERT_LARGEST.split('\nBEGIN;\n').length,2);assert.equal(REVERT_LARGEST.split('\nCOMMIT;\n').length,2);
  await pool.query(REVERT_LARGEST);
  const reverted=await body();assert.notEqual(reverted,r2c,'replaced');
  await pool.query(R2A_V2);assert.equal(await body(),reverted,'the revert body is the 20261020233934 body');
  await pool.query(REVERT_LARGEST);assert.equal(await body(),reverted,'a second run changes nothing');
  const legacy=await read(month);
  const strip=summary=>({...summary,byType:Object.fromEntries(Object.entries(summary.byType).map(([type,{largest,...rest}])=>[type,rest]))});
  assert.deepEqual([legacy.items,legacy.summary],[forward.items,strip(forward.summary)],'only byType.<type>.largest differs between R2a and R2c');
  // Release window: an R2a summary (no largest in ANY entry) still passes this connector release; a mixed one never does.
  assert.deepEqual(DOMAIN_SUMMARY_ENTRY_TOLERANT,{income_expenses:{byType:['largest']}});
  assert.deepEqual(domainResult('income_expenses',legacy,who,domainInput('income_expenses',month)).summary,legacy.summary);
  const mixed=structuredClone(legacy);mixed.summary.byType.EXPENSE.largest=V.E7;
  assert.throws(()=>domainResult('income_expenses',mixed,who,domainInput('income_expenses',month)),'largest in one entry only');
  // The artifact refuses a v2 that is neither R2c nor R2a (here the B5c step 2 body): it would undo it.
  const client=await pool.connect();
  try{
   await client.query('BEGIN');await client.query(B5C_V2);
   await assert.rejects(client.query(REVERT_LARGEST),/hermes_domain_summary_largest_revert_unexpected_reads_v2/);
   await client.query('ROLLBACK');
  }finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
  assert.equal(await body(),reverted);
  await pool.query(largestSql);
  assert.equal(await body(),r2c,'R2c forward again: the reviewed body');
  const again=await read(month);
  assert.deepEqual({...again,fetchedAt:null},{...forward,fetchedAt:null},'the R2c output again');
 });
 await t.test('catalog: applied twice (idempotent) — one definition, signature, owner, DEFINER, search path and ACL kept',async()=>{
  const rows=(await pool.query(`SELECT p.oid::regprocedure::text signature,p.prosecdef,p.provolatile,pg_get_userbyid(p.proowner) owner,p.proconfig
   FROM pg_proc p WHERE p.proname='hermes_domain_read_v2'`)).rows;
  assert.deepEqual(rows.map(row=>[row.signature,row.prosecdef,row.provolatile,row.owner]),[['hermes_domain_read_v2(jsonb,text,jsonb)',true,'v','postgres']]);
  assert.deepEqual(rows[0].proconfig,['search_path=pg_catalog, public, app_private']);
  for(const [role,expected] of [['authenticated',true],['anon',false],['service_role',false],['hermes_store_executor',false]])
   assert.equal((await pool.query('SELECT has_function_privilege($1,$2,$3) value',[role,'public.hermes_domain_read_v2(jsonb,text,jsonb)','EXECUTE'])).rows[0].value,expected,role);
  await pool.query(largestSql);
  assert.equal((await oracle()).byType.EXPENSE.largest.id,E7,'a third run changes nothing');
 });
});

// R2c part 2 (20261021044801) on real PostgreSQL 16+/17: summary.byStatus of crm_read_customers on the fast reader (the
// live lane) — "Có bao nhiêu khách chưa có hợp đồng nào?" — counts the core's set by customers.status_v2, the three tabs
// of /customers (RENTING đang thuê, MOVED_OUT đã chuyển đi, WALK_IN vãng lai = chưa có hợp đồng), under the asker's RLS.
// Oracle: the web core itself per tab (customer_list_v1 p_status). With a query: null (search not copied). A
// building-scoped connection sees only customers the core locates in its buildings (WALK_IN customers have none).
// Mutants of the status statement turn it red; the prepared revert restores the exact R2a reader and v1; $requires$
// stops before R2a. Synthetic customers only.
const C=n=>id(450+n);
test('R2c part 2 customers: byStatus by contract status on the fast reader, as the web tabs count them; null with a query; revert and $requires$',{timeout:240000},async t=>{
 const {pool,cleanup}=await localCluster(t);t.after(async()=>{await pool.end();cleanup();});await setup(pool);
 // Fixture owner-visible customers: CUSTOMER (active contract, fixture building), CUSTOMER2 (terminated contract). HIDDEN
 // (owner not visible) and the foreign customer never count; a deleted walk-in neither; one customer has no status yet.
 await pool.query(`UPDATE public.customers SET status_v2='RENTING' WHERE id='${CUSTOMER}';
  UPDATE public.customers SET status_v2='MOVED_OUT' WHERE id='${CUSTOMER2}';
  INSERT INTO public.customers(id,organization_id,user_id,full_name,phone,created_at,status_v2,deleted_at) VALUES
  ('${C(1)}','${ORG}','${USER}','Khách vãng lai','0920000001','2026-10-20','WALK_IN',null),
  ('${C(2)}','${ORG}','${USER}','Khách đã xoá','0920000002','2026-10-20','WALK_IN',now()),
  ('${C(3)}','${ORG}','${USER}','Khách chưa phân loại','0920000003','2026-10-20',null,null);`);
 const prepared=await jwt(pool,async c=>(await c.query("SELECT public.hermes_prepare_connection_v2($1,'{}','{}','unrestricted','{}') value",[ORG])).rows[0].value);
 const tokenDigest='e'.repeat(64),expiry=Date.now()+600000;
 const activated=(await pool.query('SELECT app_private.hermes_store_activate_v1($1::jsonb) value',[JSON.stringify({connectionId:prepared.id,expectedEpoch:1,operationId:id(53),intentSecret:prepared.intentSecret,
  userId:USER,providerSessionId:id(32),credentialRef:id(51),tokenDigest,tokenExpiresAt:expiry,sessionExpiresAt:Date.now()+3600000,
  sessionEnvelope:{v:1,algorithm:'A256GCM',keyVersion:'fixture',nonce:'a'.repeat(16),tag:'a'.repeat(22),ciphertext:'abcd'}})])).rows[0].value;
 let connection={...activated.connection};
 const value=async(input={})=>fast(pool,{connectionId:prepared.id,tokenDigest,expectedEpoch:connection.epoch,expectedSessionRevision:1},'customers',input);
 const read=async(input={})=>(await value(input)).result;
 const who={row:{id:prepared.id,userId:USER,organizationId:ORG},scopesByPermission:{}};
 // The web's own count of one tab (customer_list_v1 = the core, p_status), whole company.
 const tab=async status=>(await jwt(pool,async c=>(await c.query('SELECT public.customer_list_v1($1::uuid,$2) value',[ORG,status])).rows[0].value)).total;
 const reader=async()=>(await pool.query("SELECT md5(pg_get_function_sqlbody(oid)) v FROM pg_proc WHERE proname='hermes_domain_read_rows_fast_v1'")).rows[0].v;
 const v1=async()=>(await pool.query("SELECT md5(prosrc) v FROM pg_proc WHERE oid='public.hermes_domain_read_v1(jsonb,text,jsonb)'::regprocedure")).rows[0].v;

 await t.test('Toàn tổ chức: count of the core, byStatus of every tab equal to the web tab, the same on every page; the connector accepts it',async()=>{
  const whole=await read();
  assert.deepEqual(whole.summary,{count:4,byStatus:{RENTING:1,MOVED_OUT:1,WALK_IN:1},sum:{}},'deleted, hidden-owner and foreign customers never count; no status: counted, no tab');
  for(const status of ['RENTING','MOVED_OUT','WALK_IN'])assert.equal(whole.summary.byStatus[status],await tab(status),`${status}: the web tab`);
  assert.equal(whole.summary.byStatus.WALK_IN,1,'the answer to "bao nhiêu khách chưa có hợp đồng"');
  const first=await read({limit:1}),second=await read({limit:1,cursor:first.nextCursor});
  assert.deepEqual([first.summary,second.summary],[whole.summary,whole.summary],'limit and cursor never narrow it');
  assert.deepEqual(domainFastResult('customers',await value(),who,domainInput('customers',{})).summary,whole.summary);
 });
 await t.test('a query: count of the core search, byStatus null (the search patterns are not copied); no match: 0 and null',async()=>{
  assert.deepEqual((await read({query:'khách'})).summary,{count:2,byStatus:null,sum:{}},'the walk-in and the unclassified customer (the deleted one never)');
  assert.deepEqual((await read({query:'không-ai-cả'})).summary,{count:0,byStatus:null,sum:{}});
  assert.equal(domainFastResult('customers',await value({query:'khách'}),who,domainInput('customers',{query:'khách'})).summary.byStatus,null);
 });
 await t.test('building-scoped connection: only the customers the core locates in its buildings (WALK_IN customers have none)',async()=>{
  await pool.query(`INSERT INTO public.authorization_scopes(id,organization_id,scope_type,building_id) VALUES('${BUILDING_SCOPE}','${ORG}','BUILDING','${BUILDING}')`);
  connection=await settings(pool,connection,{read:[],action:[]},'restricted',[BUILDING_SCOPE]);
  try{
   const scoped=await read();
   assert.deepEqual([scoped.items.map(row=>row.id),scoped.summary],[[CUSTOMER],{count:1,byStatus:{RENTING:1},sum:{}}]);
   assert.equal(scoped.summary.count,(await jwt(pool,async c=>(await c.query('SELECT public.customer_list_v1($1::uuid,NULL,NULL,NULL,$2::uuid[]) value',[ORG,[BUILDING]])).rows[0].value)).total,
    'the same set as the web list filtered to the building');
  }finally{connection=await settings(pool,connection);}
 });
 await t.test('mutants of the status statement are caught: location filter dropped (also refused by the connector), deleted customers counted',async()=>{
  const whole=(await read()).summary;
  // Building-scoped read under each body: the summary of the core's located set, and the connector's verdict on it.
  const scopedRead=async()=>{
   connection=await settings(pool,connection,{read:[],action:[]},'restricted',[BUILDING_SCOPE]);
   try{const scoped=await value();let refused=false;
    try{domainFastResult('customers',scoped,who,domainInput('customers',{}));}catch{refused=true;}
    return [scoped.result.summary,refused];}
   finally{connection=await settings(pool,connection);}
  };
  const tabs=async summary=>{for(const status of ['RENTING','MOVED_OUT','WALK_IN'])assert.equal(summary.byStatus[status],await tab(status),status);};
  assert.deepEqual(await scopedRead(),[{count:1,byStatus:{RENTING:1},sum:{}},false],'reviewed body');
  await pool.query(once(READER,"AND ((p->>'orgWide')::boolean OR cu.id=ANY(","AND (true OR cu.id=ANY("));
  try{
   const [summary,refused]=await scopedRead();
   assert.deepEqual([summary.byStatus,refused],[{RENTING:1,MOVED_OUT:1,WALK_IN:1},true],'the mutant counts every tab and the connector refuses it (Σ byStatus > count)');
  }finally{await pool.query(READER);}
  assert.deepEqual(await scopedRead(),[{count:1,byStatus:{RENTING:1},sum:{}},false],'restored');
  await tabs(whole);
  await pool.query(once(READER,"WHERE cu.organization_id=(p->>'organizationId')::uuid AND cu.deleted_at IS NULL AND cu.status_v2 IS NOT NULL",
   "WHERE cu.organization_id=(p->>'organizationId')::uuid AND cu.status_v2 IS NOT NULL"));
  try{await assert.rejects(tabs((await read()).summary),{code:'ERR_ASSERTION'},'the deleted walk-in is counted: only the web tab (oracle) sees it');}
  finally{await pool.query(READER);}
  assert.deepEqual((await read()).summary,whole,'reviewed body restored');
 });
 await t.test('$requires$: before R2a (the B5c step 2 reader) the file stops and replaces nothing (one transaction)',async()=>{
  const client=await pool.connect();
  try{
   const before=[await reader(),await v1()];
   await client.query('BEGIN');
   await client.query(statement('app_private.hermes_domain_read_rows_fast_v1','\nEND;',readFileSync('supabase/migrations/20261020173818_hermes_domain_reads_building_name_v1.sql','utf8')));
   await assert.rejects(client.query(customerStatusSql),/hermes_customer_status_asset_requires_applied_r2a_reader/);
   await client.query('ROLLBACK');
   assert.deepEqual([await reader(),await v1()],before,'reader and v1 untouched');
  }finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
 });
 await t.test('revert artifact: the exact R2a reader and v1 (customers byStatus {} again, accepted), twice; part 2 forward again',async()=>{
  const live=[await reader(),await v1()];
  assert.equal(REVERT_CUSTOMER_STATUS.split('\nBEGIN;\n').length,2);assert.equal(REVERT_CUSTOMER_STATUS.split('\nCOMMIT;\n').length,2);
  await pool.query(REVERT_CUSTOMER_STATUS);
  const reverted=[await reader(),await v1()];
  assert.ok(reverted[0]!==live[0]&&reverted[1]!==live[1],'both replaced');
  await pool.query(R2A_READER);await pool.query(statement('public.hermes_domain_read_v1','$fn$;'));
  assert.deepEqual([await reader(),await v1()],reverted,'the revert bodies are the 20261020233934 bodies');
  await pool.query(REVERT_CUSTOMER_STATUS);assert.deepEqual([await reader(),await v1()],reverted,'a second run changes nothing');
  const legacy=await value();
  assert.deepEqual(legacy.result.summary,{count:4,byStatus:{},sum:{}});
  assert.deepEqual(domainFastResult('customers',legacy,who,domainInput('customers',{})).summary,{count:4,byStatus:{},sum:{}},'this connector accepts the R2a summary');
  await pool.query(customerStatusSql);
  assert.deepEqual([await reader(),await v1()],live,'part 2 forward again: the reviewed bodies');
  assert.equal((await read()).summary.byStatus.WALK_IN,1);
 });
 await t.test('catalog: applied three times — one definition each, owner, ACL, reader path and DEFINER v1 kept',async()=>{
  await pool.query(customerStatusSql);
  const rows=(await pool.query(`SELECT n.nspname||'.'||p.proname name,p.prosecdef,p.provolatile,pg_get_userbyid(p.proowner) owner,p.proconfig
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proname IN ('hermes_domain_read_rows_fast_v1','hermes_domain_read_v1') ORDER BY 1`)).rows;
  assert.deepEqual(rows.map(row=>[row.name,row.prosecdef,row.provolatile,row.owner]),[['app_private.hermes_domain_read_rows_fast_v1',false,'s','postgres'],
   ['public.hermes_domain_read_v1',true,'v','postgres']]);
  assert.deepEqual(rows[0].proconfig.map(item=>item.replace(/"/g,'')),['search_path=']);
  for(const signature of ['app_private.hermes_domain_read_rows_fast_v1(jsonb)','public.hermes_domain_read_v1(jsonb,text,jsonb)'])
   for(const [role,expected] of [['authenticated',true],['anon',false],['service_role',false],['hermes_store_executor',false]])
    assert.equal((await pool.query('SELECT has_function_privilege($1,$2,$3) value',[role,signature,'EXECUTE'])).rows[0].value,expected,`${role} ${signature}`);
  assert.equal((await read()).summary.byStatus.RENTING,1);
 });
});
