import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {settings,localCluster,setup,jwt,fast,normal,id,ORG,FOREIGN,USER,MEMBER,BUILDING,OTHER_BUILDING,BUILDING_SCOPE,ROOM,INVOICE,RECEIVABLES_OUTSTANDING_PATH} from './crm-shared-read-sql-fixture.mjs';
import {summarizeRows} from './domain-contract.mjs';

// B2 (20261020101836): crm_read_receivables through the fixed private read plan
// must return the same rows, order, fields and cursor as the receivables branch
// of hermes_domain_read_v2 on the same data and JWT, and fail closed the same
// way. The v2 reader is SECURITY DEFINER with hand-written filters; the fast
// reader runs under the asker's RLS, so it may only ever narrow (last subtest
// documents that narrowing), never widen. B5c (20261020171321): both lanes name
// the building of each debt (buildingName/buildingCode). Real PostgreSQL 16+/17 only.
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const [B2,R2,R3,R4,B3,R5]=[300,301,302,303,304,305].map(id);
const inv=n=>id(300+n);
const DEBTS=[INVOICE,inv(10),inv(11),inv(18),inv(20)];

test('B2/B5c receivables: fast plan equals hermes_domain_read_v2 (rows, order, fields, building, cursor) and denies the same way',{timeout:240000},async t=>{
 const {pool,cleanup}=await localCluster(t);t.after(async()=>{await pool.end();cleanup();});await setup(pool);
 const prepared=await jwt(pool,async c=>(await c.query("SELECT public.hermes_prepare_connection_v2($1,'{}','{}','unrestricted','{}') value",[ORG])).rows[0].value);
 const tokenDigest='b'.repeat(64),expiry=Date.now()+600000;
 const activated=(await pool.query('SELECT app_private.hermes_store_activate_v1($1::jsonb) value',[JSON.stringify({connectionId:prepared.id,expectedEpoch:1,operationId:id(43),intentSecret:prepared.intentSecret,
  userId:USER,providerSessionId:id(32),credentialRef:id(41),tokenDigest,tokenExpiresAt:expiry,sessionExpiresAt:Date.now()+3600000,
  sessionEnvelope:{v:1,algorithm:'A256GCM',keyVersion:'fixture',nonce:'a'.repeat(16),tag:'a'.repeat(22),ciphertext:'abcd'}})])).rows[0].value;
 let epoch=activated.connection.epoch;assert.equal(epoch,2);
 const bind4=()=>({connectionId:prepared.id,tokenDigest,expectedEpoch:epoch,expectedSessionRevision:1});
 // Normal lane binds the full seven keys; no org policy row ⇒ policy version 0 (hermes_effective_org_policy_v1 fallback).
 const bind7=()=>({...bind4(),expectedPolicyVersion:0,expectedMembershipId:MEMBER,expectedAuthorizationVersion:1});
 // Synthetic rows only. Included (ORG, live room of the same building, debt status, remaining>0): INVOICE (fixture, due NULL),
 // 310 PARTIAL_PAID due 2026-10-15, 311 OVERDUE due 2026-09-30, 318 APPROVED due 2026-11-05, 320 OVERDUE due NULL.
 // Excluded on both lanes: 312 settled, 313 DRAFT, 314 PAID, 315 soft-deleted, 316 deleted room, 317 room of another
 // building, 319 foreign company, 321 soft-deleted building (B3, out of the admitted scope), INVOICE2 CANCELLED.
 // Buildings: fixture BUILDING has code FB, B2 has no code (buildingCode null), B3 is soft-deleted with code DEL.
 await pool.query(`INSERT INTO public.buildings(id,organization_id,user_id,name,name_sort,code,deleted_at) VALUES('${B2}','${ORG}','${USER}','Second building','second',null,null),
 ('${B3}','${ORG}','${USER}','Deleted building','deleted','DEL',now());
 UPDATE public.buildings SET code='FB' WHERE id='${BUILDING}';
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

 const same=async(input={},label=JSON.stringify(input))=>{
  const legacy=await normal(pool,bind7(),'receivables',input);
  const quick=(await fast(pool,bind4(),'receivables',input)).result;
  assert.equal(quick.source,'crm.invoices',label);assert.match(quick.fetchedAt,ISO,label);assert.match(legacy.fetchedAt,ISO,label);
  assert.deepEqual({...quick,fetchedAt:null},{...legacy,fetchedAt:null},`normal-vs-fast ${label}`);
  return quick;
 };
 const bothReject=async(input,expected,label)=>{
  await assert.rejects(normal(pool,bind7(),'receivables',input),expected,`v2 ${label}`);
  await assert.rejects(fast(pool,bind4(),'receivables',input),expected,`fast ${label}`);
 };
 const ids=r=>r.items.map(x=>x.id);

 await t.test('no filter: the same five debts in UUID order, v2 envelope and row shape',async()=>{
  const r=await same();
  assert.deepEqual(ids(r),DEBTS);assert.equal(r.nextCursor,null);
  // R2a (20261020233934): both lanes add the same `summary` of the whole filtered set (same() compares it).
  assert.deepEqual(Object.keys(r).sort(),['domain','fetchedAt','items','nextCursor','organizationId','source','summary']);
  assert.equal(r.organizationId,ORG);assert.equal(r.domain,'receivables');
  assert.deepEqual(r.items[1],{id:inv(10),number:'HDON310',status:'PARTIAL_PAID',buildingId:B2,buildingName:'Second building',buildingCode:null,roomId:R2,roomName:'P201',
   billingMonth:'2026-10',dueDate:'2026-10-15',totalAmount:'1000',paidAmount:'300',remainingAmount:'700'});
  assert.equal(r.items[0].remainingAmount,'123000.25');assert.equal(r.items[0].dueDate,null);assert.equal(r.items[4].dueDate,null);
  assert.equal(JSON.stringify(r).includes('HDON31'),true);for(const hidden of ['HDON312','HDON313','HDON314','HDON315','HDON316','HDON317','HDON319','HDON321','HDON002'])assert.equal(JSON.stringify(r).includes(hidden),false,hidden);
 });
 await t.test('B5c: building name/code ride on every row of both lanes; a soft-deleted building is outside both scopes yet still named by the reader',async()=>{
  const r=await same();
  assert.deepEqual(r.items.map(x=>[x.id,x.buildingId,x.buildingName,x.buildingCode]),[
   [INVOICE,BUILDING,'Fixture building','FB'],[inv(10),B2,'Second building',null],[inv(11),B2,'Second building',null],
   [inv(18),BUILDING,'Fixture building','FB'],[inv(20),BUILDING,'Fixture building','FB']]);
  assert.deepEqual(Object.keys(r.items[0]).sort(),['billingMonth','buildingCode','buildingId','buildingName','dueDate','id','number','paidAmount','remainingAmount','roomId','roomName','status','totalAmount']);
  // Control characters and line separators in a building name/code are stripped the same way on both lanes.
  await pool.query(`UPDATE public.buildings SET name='Second'||chr(10)||'building'||chr(8232)||'x',code='B2'||chr(9) WHERE id='${B2}'`);
  const renamed=await same({buildingId:B2});
  assert.deepEqual([renamed.items[0].buildingName,renamed.items[0].buildingCode],['Secondbuilding x','B2']);
  await pool.query(`UPDATE public.buildings SET name='Second building',code=null WHERE id='${B2}'`);
  // Soft-deleted building B3 has a live room and an open debt (HDON321). The admission of both lanes keeps only
  // buildings with deleted_at IS NULL, so neither lane lists it and asking for it by id is denied on both.
  assert.equal(JSON.stringify(await same()).includes('HDON321'),false);
  await bothReject({buildingId:B3},{code:'42501'},'soft-deleted building is outside the admitted scope');
  // The reader itself (LEFT JOIN without deleted_at) still names a listed invoice of a soft-deleted building.
  const plan={userId:USER,organizationId:ORG,domain:'receivables',buildingIds:[B3],limit:5,cursor:null,status:null,fromDate:null,toDate:null,query:'',fetchedAt:'2026-10-21T00:00:00.000Z'};
  const direct=await jwt(pool,async c=>(await c.query('SELECT app_private.hermes_domain_read_rows_fast_v1($1::jsonb) value',[JSON.stringify(plan)])).rows[0].value);
  assert.deepEqual(direct.items.map(x=>[x.id,x.roomName,x.buildingName,x.buildingCode]),[[inv(21),'P501','Deleted building','DEL']]);
  assert.equal(direct.source,'crm.invoices');assert.equal(direct.nextCursor,null);
 });
 await t.test('cursor pages of two stay aligned, limit equal to the row count has no cursor',async()=>{
  const first=await same({limit:2});assert.deepEqual(ids(first),DEBTS.slice(0,2));assert.equal(first.nextCursor,inv(10));
  const second=await same({limit:2,cursor:first.nextCursor});assert.deepEqual(ids(second),DEBTS.slice(2,4));assert.equal(second.nextCursor,inv(18));
  const third=await same({limit:2,cursor:second.nextCursor});assert.deepEqual(ids(third),DEBTS.slice(4));assert.equal(third.nextCursor,null);
  const exact=await same({limit:5});assert.equal(exact.items.length,5);assert.equal(exact.nextCursor,null);
  const one=await same({limit:1,cursor:inv(18)});assert.deepEqual(ids(one),[inv(20)]);assert.equal(one.nextCursor,null);
 });
 await t.test('status, due-date range, literal query and building filters agree',async()=>{
  assert.deepEqual(ids(await same({status:'OVERDUE'})),[inv(11),inv(20)]);
  assert.deepEqual(ids(await same({status:'APPROVED'})),[INVOICE,inv(18)]);
  assert.deepEqual(ids(await same({status:'PARTIAL_PAID'})),[inv(10)]);
  assert.deepEqual(ids(await same({fromDate:'2026-10-01',toDate:'2026-10-31'})),[inv(10)]);
  assert.deepEqual(ids(await same({fromDate:'2026-10-01'})),[inv(10),inv(18)]);
  assert.deepEqual(ids(await same({toDate:'2026-09-30'})),[inv(11)]);
  assert.deepEqual(ids(await same({fromDate:'2026-09-30',toDate:'2026-09-30',status:'OVERDUE'})),[inv(11)]);
  assert.deepEqual(ids(await same({fromDate:'2026-09-30',toDate:'2026-09-30',status:'APPROVED'})),[]);
  const empty=await same({fromDate:'2027-01-01',toDate:'2027-01-31'});assert.deepEqual(empty.items,[]);assert.equal(empty.nextCursor,null);
  assert.deepEqual(ids(await same({query:'hdon31'})),[inv(10),inv(11),inv(18)],'literal substring of the invoice number (HDON310/311/318)');
  assert.deepEqual(ids(await same({query:'HDON310'})),[inv(10)]);
  assert.deepEqual(ids(await same({query:'  P201 '})),[inv(10),inv(11)]);
  assert.deepEqual(ids(await same({query:'p101'})),[INVOICE,inv(18),inv(20)]);
  assert.deepEqual((await same({query:'nothing-here'})).items,[]);
  assert.deepEqual(ids(await same({buildingId:B2})),[inv(10),inv(11)]);
  assert.deepEqual(ids(await same({buildingId:BUILDING})),[INVOICE,inv(18),inv(20)]);
  assert.deepEqual(ids(await same({buildingId:B2,status:'OVERDUE',query:'hdon'})),[inv(11)]);
  assert.deepEqual(ids(await same({buildingId:B2,limit:1,cursor:inv(10)})),[inv(11)]);
 });
 await t.test('nợ thực (20261021185540): nợ đã kéo sang hoá đơn gánh còn mở cùng tập chỉ đếm một lần, hai lane như nhau, summary = các dòng',async()=>{
  // Khuôn thật đã che (TEST 22/10): chuỗi 3 tầng c1→c2→c3→c4 (gánh trọn dư nợ tầng trước), một cặp d1→d2 mà hoá đơn gánh
  // đã thu một phần, và một cặp e1→e2 chỉ kéo MỘT PHẦN (nguồn tăng sau khi kéo: phần chưa kéo vẫn là nợ của nguồn).
  // Phòng riêng P209 ở toà B2; dọn ở finally để các ca sau vẫn thấy đúng DEBTS.
  const R6=id(306),[c1,c2,c3,c4,d1,d2,e1,e2]=[30,31,32,33,35,36,37,38].map(inv);
  const src=(source,amount)=>JSON.stringify([{type:'invoice',id:source,amount,label:'nhãn'}]);
  try {
   await pool.query(`INSERT INTO public.rooms VALUES('${R6}','${ORG}','${B2}','P209','p209',null);
   INSERT INTO public.invoices(id,organization_id,user_id,building_id,room_id,invoice_number,billing_month,due_date,status,total_amount,paid_amount,created_at,previous_debt,previous_debt_sources) VALUES
   ('${c1}','${ORG}','${USER}','${B2}','${R6}','HDON330','2026-07','2026-07-31','OVERDUE',1600,1000,'2026-07-01',0,'[]'),
   ('${c2}','${ORG}','${USER}','${B2}','${R6}','HDON331','2026-08','2026-08-31','OVERDUE',1340,0,'2026-08-01',600,'${src(c1,600)}'),
   ('${c3}','${ORG}','${USER}','${B2}','${R6}','HDON332','2026-09','2026-09-30','OVERDUE',2380,0,'2026-09-01',1340,'${src(c2,1340)}'),
   ('${c4}','${ORG}','${USER}','${B2}','${R6}','HDON333','2026-10','2026-11-05','APPROVED',3380,0,'2026-10-01',2380,'${src(c3,2380)}'),
   ('${d1}','${ORG}','${USER}','${B2}','${R6}','HDON335','2026-09','2026-09-30','OVERDUE',500,0,'2026-09-02',0,'[]'),
   ('${d2}','${ORG}','${USER}','${B2}','${R6}','HDON336','2026-10','2026-10-20','PARTIAL_PAID',1500,700,'2026-10-02',500,'${src(d1,500)}'),
   ('${e1}','${ORG}','${USER}','${B2}','${R6}','HDON337','2026-09','2026-09-30','OVERDUE',1500,0,'2026-09-03',0,'[]'),
   ('${e2}','${ORG}','${USER}','${B2}','${R6}','HDON338','2026-10','2026-11-05','APPROVED',2000,0,'2026-10-03',1000,'${src(e1,1000)}');`);
   const money=r=>[r.summary.count,r.summary.sum.remainingAmount,r.items.map(x=>[x.id,x.remainingAmount])];
   // Cả toà B2: c1..c3 và d1 đã nằm trọn trong c4/d2 ⇒ rơi khỏi danh sách; e1 chỉ còn phần chưa kéo (1500 − 1000).
   // Cộng thẳng sẽ là 15200.
   const ALL=[[inv(10),'700'],[inv(11),'2000'],[c4,'3380'],[d2,'800'],[e1,'500'],[e2,'2000']];
   const all=await same({buildingId:B2});
   assert.deepEqual(money(all),[6,'9380',ALL]);
   assert.deepEqual(all.summary.byBuilding,[{buildingId:B2,buildingName:'Second building',count:6,remainingAmount:'9380'}]);
   assert.deepEqual(all.summary,summarizeRows('receivables',all.items),'summary của SQL = cộng các dòng (như connector gộp lọc phòng)');
   // Nợ quá hạn theo trạng thái / theo hạn: hoá đơn gánh chưa tới hạn (c4, e2) hay đã thu một phần (d2) nằm NGOÀI tập ⇒
   // nợ cũ vẫn là nợ quá hạn ở tầng cuối trong tập (c3 gom c1, c2), không mất cũng không đếm hai lần.
   for (const input of [{buildingId:B2,status:'OVERDUE'},{buildingId:B2,toDate:'2026-09-30'}])
    assert.deepEqual(money(await same(input)),[4,'6380',[[inv(11),'2000'],[c3,'2380'],[d1,'500'],[e1,'1500']]],JSON.stringify(input));
   assert.deepEqual(money(await same({query:'p209'})),[4,'6680',[[c4,'3380'],[d2,'800'],[e1,'500'],[e2,'2000']]]);
   // Trang con trỏ đọc nợ thực của CẢ tập lọc: trang sau không làm sống lại nguồn đã bị gánh.
   const page1=await same({buildingId:B2,limit:2}),page2=await same({buildingId:B2,limit:2,cursor:page1.nextCursor});
   const page3=await same({buildingId:B2,limit:2,cursor:page2.nextCursor});
   assert.deepEqual([...page1.items,...page2.items,...page3.items].map(x=>[x.id,x.remainingAmount]),ALL);assert.equal(page3.nextCursor,null);
   // Bản lùi chuẩn bị sẵn (docs/plans/hermes-crm/revert): về đúng thân R2c/R2d — cộng thẳng (đếm trùng 5820), hai lane vẫn
   // như nhau; chạy hai lần. Rồi forward lại (hai lần) về nợ thực.
   const revert=readFileSync('docs/plans/hermes-crm/revert/hermes_receivables_effective_outstanding_revert_v1.sql','utf8');
   await pool.query(revert);await pool.query(revert);
   assert.deepEqual(money(await same({buildingId:B2})),[10,'15200',[[inv(10),'700'],[inv(11),'2000'],[c1,'600'],[c2,'1340'],[c3,'2380'],[c4,'3380'],
    [d1,'500'],[d2,'800'],[e1,'1500'],[e2,'2000']]]);
   const forward=readFileSync(RECEIVABLES_OUTSTANDING_PATH,'utf8');
   await pool.query(forward);await pool.query(forward);
   assert.deepEqual(money(await same({buildingId:B2})),[6,'9380',ALL]);
   // Hoá đơn gánh bị huỷ ⇒ nợ trở lại nguồn.
   await pool.query(`UPDATE public.invoices SET status='CANCELLED' WHERE id='${c4}'`);
   assert.deepEqual(money(await same({query:'p209'})),[4,'5680',[[c3,'2380'],[d2,'800'],[e1,'500'],[e2,'2000']]]);
  } finally {
   await pool.query(`DELETE FROM public.invoices WHERE id IN ('${c1}','${c2}','${c3}','${c4}','${d1}','${d2}','${e1}','${e2}');DELETE FROM public.rooms WHERE id='${R6}';`);
  }
  assert.deepEqual(ids(await same()),DEBTS);
 });
 await t.test('invalid input is refused identically (22023) and families keep their exact input shape',async()=>{
  await bothReject({status:'DRAFT'},{code:'22023'},'status outside the debt set');
  await bothReject({status:'PAID'},{code:'22023'},'status outside the debt set');
  await bothReject({fromDate:'2026-10-02',toDate:'2026-10-01'},{code:'22023'},'reversed range');
  await bothReject({fromDate:'2026-02-30'},{code:'22023'},'impossible date');
  await bothReject({toDate:'20261001'},{code:'22023'},'date format');
  await bothReject({limit:51},{code:'22023'},'limit above 50');
  await bothReject({query:'x'.repeat(201)},{code:'22023'},'query too long');
  const raw=(domain,input)=>jwt(pool,async c=>{await c.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:USER,session_id:id(32)})]);
   return (await c.query('SELECT public.hermes_domain_read_fast_v1($1::jsonb,$2,$3::jsonb) value',[JSON.stringify(bind4()),domain,JSON.stringify(input)])).rows[0].value;});
  await assert.rejects(raw('receivables',{query:'',limit:20,cursor:null,buildingId:null,status:null}),{code:'22023'},'v1 shape is not accepted for receivables');
  await assert.rejects(raw('invoices',{query:'',limit:20,cursor:null,buildingId:null,status:null,fromDate:null,toDate:null}),{code:'22023'},'v2 shape is not accepted for invoices');
  await assert.rejects(raw('invoices',{query:'',limit:20,cursor:null,buildingId:null,status:'APPROVED'}),{code:'22023'},'invoices still has no status filter');
  await assert.rejects(raw('contracts',{query:'',limit:20,cursor:null,buildingId:null,status:'OVERDUE'}),{code:'22023'},'debt statuses do not leak into contracts');
 });
 await t.test('narrow connection scope: both lanes see one building; the other building is denied',async()=>{
  await pool.query(`INSERT INTO public.authorization_scopes(id,organization_id,scope_type,building_id) VALUES('${BUILDING_SCOPE}','${ORG}','BUILDING','${BUILDING}')`);
  let changed=await settings(pool,{...activated.connection,epoch},{read:[],action:[]},'restricted',[BUILDING_SCOPE]);epoch=changed.epoch;
  assert.deepEqual(ids(await same()),[INVOICE,inv(18),inv(20)]);
  assert.deepEqual(ids(await same({buildingId:BUILDING})),[INVOICE,inv(18),inv(20)]);
  await bothReject({buildingId:B2},{code:'42501'},'building outside the connection scope');
  changed=await settings(pool,changed);epoch=changed.epoch;
  assert.deepEqual(ids(await same()),DEBTS);
  await bothReject({buildingId:OTHER_BUILDING},{code:'42501'},'building of another company');
 });
 await t.test('exclusion, CRM revocation, stale binding, foreign session and revoked token deny on both lanes',async()=>{
  let changed=await settings(pool,{...activated.connection,epoch},{read:['invoices.view'],action:[]});epoch=changed.epoch;
  await bothReject({},{code:'42501'},'invoices.view excluded on the connection');
  changed=await settings(pool,changed);epoch=changed.epoch;
  await pool.query("UPDATE role_permissions SET effect='DENY' WHERE permission_key='invoices.view'");
  await bothReject({},{code:'42501'},'CRM grant revoked');
  await pool.query("UPDATE role_permissions SET effect='ALLOW' WHERE permission_key='invoices.view'");
  assert.deepEqual(ids(await same()),DEBTS);
  await pool.query("UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='invoices.view'");
  await bothReject({},{code:'42501'},'registry kill switch');
  await pool.query("UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='invoices.view'");
  await assert.rejects(normal(pool,{...bind7(),expectedEpoch:epoch-1},'receivables'),{code:'PT409'});
  await assert.rejects(fast(pool,{...bind4(),expectedEpoch:epoch-1},'receivables'),{code:'PT409'});
  await assert.rejects(normal(pool,{...bind7(),expectedSessionRevision:2},'receivables'),{code:'PT409'});
  await assert.rejects(fast(pool,{...bind4(),expectedSessionRevision:2},'receivables'),{code:'PT409'});
  await assert.rejects(normal(pool,bind7(),'receivables',{},{session:id(998)}),{code:'42501'});
  await assert.rejects(fast(pool,bind4(),'receivables',{},{session:id(998)}),{code:'42501'});
  await assert.rejects(fast(pool,bind4(),'receivables',{},{user:id(997)}),{code:'42501'});
  await pool.query('UPDATE app_private.hermes_connection_tokens SET revoked_at=now() WHERE token_digest=$1',[tokenDigest]);
  await bothReject({},{code:'42501'},'token revoked');
  await pool.query('UPDATE app_private.hermes_connection_tokens SET revoked_at=null WHERE token_digest=$1',[tokenDigest]);
  assert.deepEqual(ids(await same()),DEBTS);
 });
 await t.test('documented narrowing: rooms hidden by RLS drop out of the fast lane while v2 (DEFINER) still lists them',async()=>{
  // Fixture rooms policy = buildings.view, like production rooms_select_rbac (accessible_building_ids = buildings.view).
  // The normal lane copies the filter under SECURITY DEFINER and never consults rooms RLS. Fast ⊆ v2 holds; equality does not.
  await pool.query("UPDATE role_permissions SET effect='DENY' WHERE permission_key='buildings.view'");
  const legacy=await normal(pool,bind7(),'receivables'),quick=(await fast(pool,bind4(),'receivables')).result;
  assert.equal(legacy.items.length,5,'v2 keeps every debt without buildings.view');
  assert.deepEqual(quick.items,[],'fast reads invoices/rooms under RLS: fewer rows, never more (B2 decision point)');
  assert.equal(quick.source,'crm.invoices');assert.equal(quick.nextCursor,null);
  await pool.query("UPDATE role_permissions SET effect='ALLOW' WHERE permission_key='buildings.view'");
  assert.deepEqual(ids(await same()),DEBTS);
 });
 await t.test('catalog after the forward migrations: signatures kept, parsed INVOKER reader with empty search_path, DEFINER reserve lane, authenticated-only ACL',async()=>{
  const rows=(await pool.query(`SELECT n.nspname||'.'||p.proname||'('||array_to_string(p.proargtypes::oid[]::regtype[],',')||')' signature,p.prosecdef,p.provolatile,p.prosqlbody IS NOT NULL parsed,p.proconfig
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname||'.'||p.proname IN
   ('app_private.hermes_domain_read_scope_fast_v1','app_private.hermes_domain_read_rows_fast_v1','public.hermes_domain_read_fast_v1','public.hermes_domain_read_v2') ORDER BY 1`)).rows;
  assert.deepEqual(rows.map(r=>[r.signature,r.prosecdef,r.provolatile,r.parsed]),[
   ['app_private.hermes_domain_read_rows_fast_v1(jsonb)',false,'s',true],
   ['app_private.hermes_domain_read_scope_fast_v1(jsonb,text,jsonb,text)',true,'s',false],
   ['public.hermes_domain_read_fast_v1(jsonb,text,jsonb)',false,'s',true],
   ['public.hermes_domain_read_v2(jsonb,text,jsonb)',true,'v',false]]);
  assert.deepEqual(rows[0].proconfig.map(v=>v.replace(/"/g,'')),['search_path='],'empty search_path (stored as search_path="")');
  for(const {signature} of rows)for(const [role,expected] of [['authenticated',true],['anon',false],['service_role',false],['hermes_store_executor',false]])
   assert.equal((await pool.query('SELECT has_function_privilege($1,$2,$3) value',[role,signature,'EXECUTE'])).rows[0].value,expected,`${role} ${signature}`);
  assert.equal((await pool.query("SELECT count(*)::int value FROM pg_proc WHERE proname IN ('hermes_domain_read_scope_fast_v1','hermes_domain_read_rows_fast_v1','hermes_domain_read_fast_v1','hermes_domain_read_v2')")).rows[0].value,4,'no overload was created');
 });
});
