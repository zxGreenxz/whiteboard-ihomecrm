// Real authenticated-role tests against an owned loopback PostgreSQL restore only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import pg from 'pg';

const url = process.env.SUPPLEMENT_TEST_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:55487/reservation_evidence_storage';
if (!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname)) throw new Error('Loopback restore required');
const migration = new URL('../supabase/migrations/20260910042229_income_expense_supplements_v1.sql', import.meta.url);
const org='dddd0000-0000-4000-8000-000000000001', actor='de6f33f3-349f-4bec-bd3d-106192f6715e';
const prefix=`https://tryymsxyyckgbrmmvozx.supabase.co/storage/v1/object/public/income-expense-attachments/${actor}/`;
const migrationBody=()=>readFileSync(migration,'utf8').replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,'');
async function fixture(run,{connectionString=url,committed=false}={}) {
  const db=new pg.Client({connectionString}); await db.connect();
  try {
    await db.query('BEGIN');
    if(existsSync(migration)) await db.query(migrationBody());
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[actor]);
    const scope=(await db.query("SELECT r.id room,r.building_id building,a.id account FROM public.rooms r JOIN public.buildings b ON b.id=r.building_id JOIN public.accounts a ON a.organization_id=b.organization_id WHERE b.organization_id=$1 AND NOT b.is_virtual AND NOT a.is_virtual AND b.deleted_at IS NULL AND a.deleted_at IS NULL LIMIT 1",[org])).rows[0];
    assert.ok(scope);
    const id=randomUUID();
    await db.query('SET LOCAL session_replication_role=replica');
    await db.query("INSERT INTO public.income_expenses(id,user_id,organization_id,type,name,building_id,room_id,account_id,total_amount,approval_status,posting_mode,posting_status,voucher_date,notes,attachments) VALUES($1,$2,$3,'INCOME','Supplement test',$4,$5,$6,123456,'APPROVED','CASHBOOK','POSTED',CURRENT_DATE,$7,$8)",[id,actor,org,scope.building,scope.room,scope.account,'[THU TACH COC '+id+']\n'+ 'x'.repeat(6000),JSON.stringify(['https://legacy.example/proof.png'])]);
    await db.query('SET LOCAL session_replication_role=origin');
    const asActor=async(user=actor)=>{await db.query('RESET ROLE');await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[user]);await db.query('SET LOCAL ROLE authenticated');};
    const append=async(note='Bổ sung',attachments=[],key=randomUUID(),voucher=id)=>(await db.query('SELECT public.append_income_expense_supplement_v1($1,$2,$3,$4) result',[voucher,note,JSON.stringify(attachments),key])).rows[0].result;
    const reject=async(fn,code)=>{await db.query('SAVEPOINT rejection');try {await assert.rejects(fn,e=>e.code===code);}finally{await db.query('ROLLBACK TO SAVEPOINT rejection');}};
    const snapshot=async()=>{await db.query('RESET ROLE');return (await db.query("SELECT jsonb_build_object('header',(SELECT to_jsonb(v) FROM public.income_expenses v WHERE id=$1),'items',(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM public.income_expense_items i WHERE organization_id=$2),'postings',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM public.income_expense_postings p WHERE organization_id=$2),'lines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM public.income_expense_posting_lines l WHERE organization_id=$2),'settlements',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM public.reservation_deposit_settlements s WHERE organization_id=$2)) state",[id,org])).rows[0].state;};
    const upload=async(name=randomUUID()+'.png',owner=actor)=>{await db.query('RESET ROLE');await db.query("INSERT INTO storage.buckets(id,name,public) VALUES('income-expense-attachments','income-expense-attachments',false) ON CONFLICT DO NOTHING");await db.query("INSERT INTO storage.objects(bucket_id,name,owner,owner_id,metadata) VALUES('income-expense-attachments',$1,$2::uuid,($2::uuid)::text,'{\"size\":128,\"mimetype\":\"image/png\"}')",[actor+'/'+name,owner]);return prefix+name;};
    if(committed) {await db.query('COMMIT');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[actor]);}
    await asActor(); await run({db,id,scope,append,reject,asActor,snapshot,upload});
  } finally {await db.query('ROLLBACK');await db.end();}
}

test('arbitrary supplemental narrative preserves the entire header and money state',()=>fixture(async f=>{
  const before=await f.snapshot();await f.asActor();
  const r=await f.append('[Hoàn trả thanh lý]\n[CẤN CỌC BỎ CỌC x]\n mô tả tự do ');
  assert.equal(r.income_expense_id,f.id);assert.equal(r.changed,true);
  const entry=(await f.db.query('SELECT * FROM public.income_expense_supplements WHERE id=$1',[r.id])).rows[0];
  assert.equal(entry.actor_id,actor);assert.equal(entry.actor_name,'DEMO Chủ Nhà');assert.ok(entry.created_at);
  assert.equal(entry.note,'[Hoàn trả thanh lý]\n[CẤN CỌC BỎ CỌC x]\n mô tả tự do ');
  assert.deepEqual(await f.snapshot(),before);
}));
test('protected migration replay preserves saved evidence and reestablishes all invariants',()=>fixture(async f=>{
  const proof=await f.upload();await f.asActor();const key=randomUUID();const first=await f.append('Before replay',[proof],key);
  const before=await f.snapshot();await f.db.query(migrationBody());await f.asActor();
  const retry=await f.append('Before replay',[proof],key);assert.equal(retry.id,first.id);assert.equal(retry.changed,false);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM public.income_expense_supplements WHERE income_expense_id=$1',[f.id])).rows[0].n,1);
  await f.reject(()=>f.db.query('DELETE FROM public.income_expense_supplements WHERE id=$1',[first.id]),'42501');
  assert.deepEqual(await f.snapshot(),before);
  await f.reject(()=>f.db.query("UPDATE storage.objects SET name=name||'.replace' WHERE name=$1",[proof.split('/income-expense-attachments/')[1]]),'55000');
}));
test('migration replay refuses an incompatible existing table, index or extra read policy',()=>fixture(async f=>{
  await f.db.query('RESET ROLE');
  for(const drift of [
    'ALTER TABLE public.income_expense_supplements ALTER COLUMN actor_name DROP NOT NULL',
    'ALTER TABLE public.income_expense_supplements DROP CONSTRAINT income_expense_supplements_note_check',
    'DROP INDEX public.income_expense_supplements_voucher_order; CREATE INDEX income_expense_supplements_voucher_order ON public.income_expense_supplements(actor_id)',
    'CREATE POLICY unexpected_read ON public.income_expense_supplements FOR SELECT TO authenticated USING(true)',
    'GRANT UPDATE ON public.income_expense_supplements TO authenticated',
    'GRANT UPDATE(note) ON public.income_expense_supplements TO authenticated',
    'CREATE UNIQUE INDEX unexpected_actor_unique ON public.income_expense_supplements(actor_id)',
  ]) {
    await f.db.query('SAVEPOINT drift');await f.db.query(drift);
    await assert.rejects(()=>f.db.query(migrationBody()),e=>e.code==='55000'&&e.message.includes('Supplement schema mismatch'));
    await f.db.query('ROLLBACK TO SAVEPOINT drift');
  }
}));
test('same request replays once and conflicting payload is rejected',()=>fixture(async f=>{
  const key=randomUUID(),a=await f.append('first',[],key),b=await f.append('first',[],key);
  assert.equal(b.id,a.id);assert.equal(b.replayed,true);assert.equal(b.changed,false);
  await f.reject(()=>f.append('changed',[],key),'23505');
  assert.equal((await f.db.query('SELECT count(*)::int n FROM public.income_expense_supplements WHERE income_expense_id=$1',[f.id])).rows[0].n,1);
}));
test('server actor name remains the historical snapshot after profile changes',()=>fixture(async f=>{
  const r=await f.append();await f.db.query('RESET ROLE');
  await f.db.query("UPDATE public.profiles SET full_name='A later name' WHERE id=$1",[actor]);await f.asActor();
  assert.equal((await f.db.query('SELECT actor_name FROM public.income_expense_supplements WHERE id=$1',[r.id])).rows[0].actor_name,'DEMO Chủ Nhà');
}));
test('every lifecycle and source shape accepts additions with no financial-row change',()=>fixture(async f=>{
  await f.db.query('RESET ROLE');await f.db.query('UPDATE public.accounts SET lock_date=CURRENT_DATE WHERE id=$1',[f.scope.account]);
  for(const [approval,posting,source] of [
    ['UNAPPROVED','UNPOSTED',null],['APPROVED','POSTED',null],['CANCELLED','REVERSED',null],
    ['APPROVED','NOT_APPLICABLE','reservation.forfeit_revenue'],['APPROVED','NOT_APPLICABLE','reservation.forfeit_offset'],
    ['APPROVED','POSTED','reservation.refund'],['APPROVED','NOT_APPLICABLE','termination.forfeit_revenue'],
    ['APPROVED','POSTED','profit_payout'],['APPROVED','POSTED','invoice.collection'],
  ]) {
    await f.db.query('RESET ROLE');await f.db.query('SET LOCAL session_replication_role=replica');
    await f.db.query("UPDATE public.income_expenses SET approval_status=$2,posting_status=$3,system_source=$4,review_state='PENDING',voucher_date='2020-01-01' WHERE id=$1",[f.id,approval,posting,source]);
    await f.db.query('SET LOCAL session_replication_role=origin');const before=await f.snapshot();await f.asActor();await f.append('Supplement for '+approval+' '+source);assert.deepEqual(await f.snapshot(),before);
  }
}));
test('per-addition validation rejects empty, oversized, malformed and missing-key input',()=>fixture(async f=>{
  for(const [note,images,key] of [['  ',[],randomUUID()],['x'.repeat(5001),[],randomUUID()],['x',Array(21).fill('a'),randomUUID()],['x',{},randomUUID()],['x',[5],randomUUID()],['x',[],null],['x',[],'x'.repeat(201)]]) await f.reject(()=>f.append(note,images,key),'22023');
}));
test('images-only binds real current-owned files and protects storage against replacement/deletion',()=>fixture(async f=>{
  const ref=await f.upload();await f.asActor();const result=await f.append(null,[ref]);
  assert.deepEqual((await f.db.query('SELECT attachments FROM public.income_expense_supplements WHERE id=$1',[result.id])).rows[0].attachments,[ref]);
  const path=ref.split('/income-expense-attachments/')[1];
  for(const sql of ['DELETE FROM storage.objects WHERE name=$1','UPDATE storage.objects SET metadata=\'{"size":999}\' WHERE name=$1']) {
    // Restrictive policies may hide the row; no row may be mutated.
    await f.db.query('SAVEPOINT storage_write');
    try {const r=await f.db.query(sql,[path]);assert.equal(r.rowCount,0);}catch(e){assert.ok(['42501','55000'].includes(e.code));}finally{await f.db.query('ROLLBACK TO SAVEPOINT storage_write');}
  }
  await f.db.query('RESET ROLE');
  await f.reject(()=>f.db.query('UPDATE storage.objects SET name=name||\'.x\' WHERE name=$1',[path]),'55000');
  await f.reject(()=>f.db.query('DELETE FROM app_private.storage_object_links WHERE object_name=$1',[path]),'55000');
  assert.equal((await f.db.query('SELECT organization_id FROM app_private.storage_object_links WHERE object_name=$1',[path])).rows[0].organization_id,org);
}));
test('fabricated host, missing object, wrong owner and cross-org link reject the whole addition',()=>fixture(async f=>{
  const good=await f.upload();const wrongOwner=await f.upload(randomUUID()+'.png',randomUUID());
  for(const ref of [good.replace('tryymsxyyckgbrmmvozx.supabase.co','evil.example'),prefix+'missing.png',wrongOwner]) {await f.asActor();await f.reject(()=>f.append('must rollback',[good,ref]),'22023');}
  await f.db.query('RESET ROLE');await f.db.query("UPDATE app_private.storage_object_links SET organization_id='cccc0000-0000-4000-8000-000000000001' WHERE object_name=$1",[good.split('/income-expense-attachments/')[1]]);
  await f.asActor();await f.reject(()=>f.append('wrong tenant',[good]),'22023');
  assert.equal((await f.db.query('SELECT count(*)::int n FROM public.income_expense_supplements WHERE income_expense_id=$1',[f.id])).rows[0].n,0);
}));
test('supplement storage read follows parent visibility and allows a shared accessible parent',()=>fixture(async f=>{
  const staff='fb0651bb-1cbd-4016-b0bf-3611dae49a63';
  const proof=await f.upload(),legacy=await f.upload();await f.asActor();await f.append(null,[proof]);
  const proofPath=proof.split('/income-expense-attachments/')[1],legacyPath=legacy.split('/income-expense-attachments/')[1];
  const visible=async(path)=>(await f.db.query("SELECT id FROM storage.objects WHERE bucket_id='income-expense-attachments' AND name=$1",[path])).rowCount;
  // Give the ordinary legacy object its normal org binding so the test isolates
  // the new parent gate from existing organization/quarantine Storage policies.
  await f.db.query('RESET ROLE');await f.db.query('UPDATE app_private.storage_object_links SET organization_id=$2 WHERE object_name=$1',[legacyPath,org]);
  await f.asActor(staff);assert.equal((await f.db.query('SELECT public.can_view_restricted_ie() value')).rows[0].value,false);
  assert.equal(await visible(proofPath),1);assert.equal(await visible(legacyPath),1);
  await f.db.query('RESET ROLE');await f.db.query('SET LOCAL session_replication_role=replica');
  await f.db.query('UPDATE public.income_expenses SET has_restricted_item=true WHERE id=$1',[f.id]);await f.db.query('SET LOCAL session_replication_role=origin');
  await f.asActor(staff);
  assert.equal((await f.db.query('SELECT id FROM public.income_expense_supplements WHERE income_expense_id=$1',[f.id])).rowCount,0);
  assert.equal(await visible(proofPath),0,'restricted supplemental proof must not leak through Storage SELECT');
  assert.equal(await visible(legacyPath),1,'unreferenced legacy Storage visibility remains unchanged');
  await f.asActor();assert.equal(await visible(proofPath),1,'authorized parent reader retains proof access');
  const other=randomUUID();await f.db.query('RESET ROLE');await f.db.query('SET LOCAL session_replication_role=replica');
  await f.db.query("INSERT INTO public.income_expenses(id,user_id,organization_id,type,name,building_id,room_id,account_id,total_amount,approval_status,posting_mode,posting_status,voucher_date) SELECT $2,user_id,organization_id,type,'Accessible shared proof',building_id,room_id,account_id,total_amount,approval_status,posting_mode,posting_status,voucher_date FROM public.income_expenses WHERE id=$1",[f.id,other]);
  await f.db.query('SET LOCAL session_replication_role=origin');await f.asActor();await f.append('Shared proof',[proof],randomUUID(),other);
  await f.asActor(staff);assert.equal(await visible(proofPath),1,'any accessible referencing parent permits shared proof');
  await f.asActor(randomUUID());assert.equal(await visible(proofPath),0,'unrelated actor gains no access from sharing');
}));
test('direct ledger mutations and anonymous/service-role execute are denied',()=>fixture(async f=>{
  const r=await f.append();
  for(const sql of ['UPDATE public.income_expense_supplements SET note=\'tamper\' WHERE id=$1','DELETE FROM public.income_expense_supplements WHERE id=$1']) await f.reject(()=>f.db.query(sql,[r.id]),'42501');
  await f.reject(()=>f.db.query('TRUNCATE public.income_expense_supplements'),'42501');
  await f.db.query('RESET ROLE');
  await f.reject(()=>f.db.query('UPDATE public.income_expense_supplements SET note=\'tamper\' WHERE id=$1',[r.id]),'55000');
  for(const role of ['anon','service_role']) {await f.db.query('SET LOCAL ROLE '+role);await f.reject(()=>f.append(),'42501');await f.db.query('RESET ROLE');}
}));
test('inactive and unrelated actors cannot append, read or replay',()=>fixture(async f=>{
  const key=randomUUID();await f.append('original',[],key);
  await f.asActor(randomUUID());await f.reject(()=>f.append('original',[],key),'42501');
  assert.equal((await f.db.query('SELECT * FROM public.income_expense_supplements WHERE income_expense_id=$1',[f.id])).rowCount,0);
  await f.db.query('RESET ROLE');await f.db.query("UPDATE public.organization_memberships SET status='SUSPENDED' WHERE user_id=$1 AND organization_id=$2",[actor,org]);
  await f.asActor();await f.reject(()=>f.append(),'42501');
}));

test('reservation refund annotation reproduces legacy rejection while append preserves guarded rows',()=>fixture(async f=>{
  await f.db.query('RESET ROLE');await f.db.query('SET LOCAL session_replication_role=replica');
  await f.db.query("UPDATE public.income_expenses SET notes='Original refund',review_state='RESOLVED',system_source='reservation.refund' WHERE id=$1",[f.id]);
  await f.db.query("INSERT INTO public.reservation_settlement_vouchers(voucher_id,settlement_id,organization_id,kind) VALUES($1,$2,$3,'REFUND')",[f.id,randomUUID(),org]);
  await f.db.query('SET LOCAL session_replication_role=origin');
  const before=await f.snapshot();await f.asActor();
  await f.db.query('SAVEPOINT old_annotate');
  try {await assert.rejects(()=>f.db.query("SELECT public.annotate_income_expense_v1($1,NULL,NULL,'Additional','APPEND',$2)",[f.id,randomUUID()]),/Bút toán bỏ cọc chỉ được ghi qua xử lý cọc/);}finally{await f.db.query('ROLLBACK TO SAVEPOINT old_annotate');}
  await f.append('Giải thích hoàn cọc');assert.deepEqual(await f.snapshot(),before);
}));

test('restricted-category, cross-organization and forbidden-building voucher reads remain denied',()=>fixture(async f=>{
  await f.append('owner entry');
  const staff='fb0651bb-1cbd-4016-b0bf-3611dae49a63';
  await f.asActor(staff);
  assert.equal((await f.db.query('SELECT public.can_view_restricted_ie() value')).rows[0].value,false);
  await f.db.query('RESET ROLE');await f.db.query('SET LOCAL session_replication_role=replica');
  await f.db.query('UPDATE public.income_expenses SET has_restricted_item=true WHERE id=$1',[f.id]);
  await f.db.query('SET LOCAL session_replication_role=origin');await f.asActor(staff);
  await f.reject(()=>f.append(),'42501');assert.equal((await f.db.query('SELECT * FROM public.income_expense_supplements WHERE income_expense_id=$1',[f.id])).rowCount,0);
  await f.db.query('RESET ROLE');await f.db.query('SET LOCAL session_replication_role=replica');
  await f.db.query("UPDATE public.income_expenses SET has_restricted_item=false,organization_id='cccc0000-0000-4000-8000-000000000001' WHERE id=$1",[f.id]);
  await f.db.query('SET LOCAL session_replication_role=origin');await f.asActor();await f.reject(()=>f.append(),'42501');
  await f.db.query('RESET ROLE');await f.db.query('SET LOCAL session_replication_role=replica');
  await f.db.query('UPDATE public.income_expenses SET organization_id=$2 WHERE id=$1',[f.id,org]);
  await f.db.query("UPDATE public.buildings SET organization_id='cccc0000-0000-4000-8000-000000000001' WHERE id=$1",[f.scope.building]);
  await f.db.query('SET LOCAL session_replication_role=origin');await f.asActor();await f.reject(()=>f.append(),'42501');
}));

test('simultaneous independent and same-key appends serialize without losing narrative',async()=>{
  const admin=new pg.Client({connectionString:url});await admin.connect();
  const name='supplement_concurrency_'+randomUUID().replaceAll('-','');
  const target=new URL(url);target.pathname='/'+name;
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${new URL(url).pathname.slice(1)}"`);
    await fixture(async f=>{
      const before=await f.snapshot();
      const send=async(note,key)=>{const c=new pg.Client({connectionString:target.toString()});await c.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[actor]);await c.query('SET LOCAL ROLE authenticated');const r=(await c.query('SELECT public.append_income_expense_supplement_v1($1,$2,\'[]\',$3) result',[f.id,note,key])).rows[0].result;await c.query('COMMIT');return r;}finally{await c.end();}};
      const distinct=await Promise.all([send('a',randomUUID()),send('b',randomUUID())]);assert.notEqual(distinct[0].id,distinct[1].id);
      const key=randomUUID(),same=await Promise.all([send('retry',key),send('retry',key)]);assert.equal(same[0].id,same[1].id);assert.equal(same.filter(r=>r.changed).length,1);
      assert.deepEqual(await f.snapshot(),before);
      assert.equal((await f.db.query('SELECT count(*)::int n FROM public.income_expense_supplements WHERE income_expense_id=$1',[f.id])).rows[0].n,3);
      const proof=await f.upload();await f.asActor();await f.append('Readonly proof',[proof]);
      const reader=new pg.Client({connectionString:target.toString()});await reader.connect();
      try {await reader.query('BEGIN READ ONLY');await reader.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[actor]);await reader.query('SET LOCAL ROLE authenticated');assert.equal((await reader.query('SELECT id,organization_id,income_expense_id,note,attachments,actor_id,actor_name,created_at FROM public.income_expense_supplements WHERE income_expense_id=ANY($1::uuid[]) ORDER BY created_at,id LIMIT 1000 OFFSET 0',[[f.id]])).rowCount,4);assert.equal((await reader.query("SELECT id FROM storage.objects WHERE bucket_id='income-expense-attachments' AND name=$1",[proof.split('/income-expense-attachments/')[1]])).rowCount,1);await reader.query('COMMIT');}finally{await reader.end();}
    },{connectionString:target.toString(),committed:true});
  } finally {await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);await admin.end();}
});
