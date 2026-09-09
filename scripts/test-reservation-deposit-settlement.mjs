// Local PostgreSQL integration tests. No production connection is accepted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import pg from 'pg';

const url = process.env.RESERVATION_TEST_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:55487/postgres';
const target = new URL(url);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
  throw new Error('Reservation settlement tests require an isolated loopback database.');
}
const org = 'dddd0000-0000-4000-8000-000000000001';
const actor = 'de6f33f3-349f-4bec-bd3d-106192f6715e';

async function fixture(run, { amount = 3000000, other = 0, posted = true, connectionString=url, commitFixture=false } = {}) {
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(connectionString).hostname));
  const db = new pg.Client({ connectionString });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [actor]);
    const { rows: [scope] } = await db.query(
      "SELECT r.id AS room, r.building_id AS building, a.id AS account, m.id AS membership " +
      "FROM public.rooms r JOIN public.buildings b ON b.id=r.building_id " +
      "JOIN public.organization_memberships m ON m.organization_id=b.organization_id AND m.user_id=$2 " +
      "JOIN public.cashbook_possession_bindings cb ON cb.membership_id=m.id AND cb.possession_kind='CUSTODIAN' " +
      "JOIN public.accounts a ON a.id=cb.cashbook_id AND NOT a.is_virtual AND a.deleted_at IS NULL " +
      "WHERE b.organization_id=$1 AND NOT b.is_virtual AND b.deleted_at IS NULL AND r.deleted_at IS NULL LIMIT 1",
      [org, actor]);
    assert.ok(scope, 'DEMO fixture needs a room and owner cashbook custodian');
    const id = randomUUID();
    const depType = randomUUID(), otherType = randomUUID(), postId = randomUUID();
    // Fixture-only import, on an isolated database, never inside production code.
    await db.query('SET LOCAL session_replication_role = replica');
    await db.query("UPDATE public.rooms SET status='AVAILABLE' WHERE id=$1", [scope.room]);
    await db.query(
      "INSERT INTO public.income_expense_types(id,user_id,organization_id,name,type,is_deposit) VALUES ($1,$2,$3,$4,'income',true),($5,$2,$3,$6,'income',false)",
      [depType, actor, org, 'Test deposit '+id, otherType, 'Test fee '+id]);
    await db.query(
      "INSERT INTO public.income_expenses(id,user_id,organization_id,type,name,building_id,room_id,account_id,total_amount,approval_status,posting_mode,posting_status,voucher_date) " +
      "VALUES($1,$2,$3,'INCOME',$4,$5,$6,$7,$8,'APPROVED','CASHBOOK',$9,public.org_today_v1($3))",
      [id, actor, org, 'Reservation test '+id, scope.building, scope.room, scope.account, amount + other, posted ? 'POSTED' : 'UNPOSTED']);
    await db.query(
      "INSERT INTO public.income_expense_items(organization_id,income_expense_id,income_expense_type_id,description,quantity,unit_price,amount,accounting_class) VALUES($1,$2,$3,'Deposit',1,$4,$4,'DEPOSIT')",
      [org,id,depType,amount]);
    if (other) await db.query(
      "INSERT INTO public.income_expense_items(organization_id,income_expense_id,income_expense_type_id,description,quantity,unit_price,amount,accounting_class) VALUES($1,$2,$3,'Fee',1,$4,$4,'PNL')",
      [org,id,otherType,other]);
    if (posted) {
      await db.query(
        "INSERT INTO public.income_expense_postings(id,organization_id,voucher_id,posting_subject_id,direction,account_id,gross_amount,voucher_amount_snapshot,amount_basis,net_cash_effect,posted_on,posted_by_membership_id,posted_by_user_id,approval_version,event_kind,idempotency_key,source_kind,posting_generation) " +
        "VALUES($1,$2,$3,$3,'INCOME',$4,$5,$5,'VOUCHER_TOTAL',$5,public.org_today_v1($2),$6,$7,1,'POSTING',$8,'TEST_FIXTURE',1)",
        [postId,org,id,scope.account,amount+other,scope.membership,actor,'fixture-'+id]);
      await db.query("INSERT INTO public.income_expense_posting_lines(organization_id,posting_id,account_id,line_kind,signed_amount) VALUES($1,$2,$3,'MAIN',$4)",[org,postId,scope.account,amount+other]);
      await db.query("UPDATE public.income_expenses SET active_posting_id_v2=$2,posting_id=$2 WHERE id=$1",[id,postId]);
    }
    await db.query('SET LOCAL session_replication_role = origin');
    const [{today}] = (await db.query('SELECT public.org_today_v1($1)::text AS today',[org])).rows;
    const rpc = async (name, args) => {
      const { rows: [row] } = await db.query('SELECT public.'+name+'($1) AS result', [args]);
      return row.result;
    };
    const preview = () => rpc('preview_reservation_settlement_v1', id);
    const settle = async (refundAmount=0, refundMode='NONE', overrides={}) => {
      const p = await preview();
      return rpc('settle_reservation_deposit_v1', {
        voucherId:id,refundAmount,refundMode,settlementDate:today,
        reasonCode:'CHANGED_MIND',reasonText:'',refundAccountId:refundMode==='NOW'?scope.account:null,
        basisFingerprint:p.fingerprint,idempotencyKey:'settle-'+id,...overrides,
      });
    };
    const money = async () => Number((await db.query(
      "SELECT COALESCE(SUM(l.signed_amount),0) AS total FROM public.income_expense_posting_lines l WHERE l.organization_id=$1",[org])).rows[0].total);
    const rejects = async (action, pattern) => {
      await db.query('SAVEPOINT expected_error');
      try { await assert.rejects(action, pattern); }
      finally { await db.query('ROLLBACK TO SAVEPOINT expected_error'); }
    };
    const summary = async () => (await db.query('SELECT public.get_reservation_settlement_summary_v1($1) AS result',[[scope.building]])).rows[0].result;
    const list = async (state=null, cursor=null, limit=50) => (await db.query('SELECT public.get_reservation_settlements_v1($1,$2,$3,$4) AS result',[[scope.building],state,cursor,limit])).rows[0].result;
    const prepareContract = async () => {
      const customer=randomUUID();
      await db.query('SET LOCAL session_replication_role=replica');
      await db.query("INSERT INTO public.customers(id,user_id,organization_id,full_name,phone) VALUES($1,$2,$3,'Settlement test customer',$4)",[customer,actor,org,'09'+String(parseInt(customer.slice(0,8),16)).slice(-8).padStart(8,'0')]);
      await db.query("INSERT INTO app_private.server_feature_flags(feature_key,domain,mode,commit_sha,migration_sha256,maintenance_window_id,approval_reference) VALUES('contract.create.v2','contracts','ON','LOCAL_TEST','LOCAL_TEST','LOCAL_TEST','LOCAL_TEST') ON CONFLICT(feature_key) DO NOTHING");
      await db.query('SET LOCAL session_replication_role=origin');
      return {contract:{room_id:scope.room,start_date:today,end_date:today,rent_price:3000000,total_deposit:3000000},customers:[{customer_id:customer,is_representative:true}],existing_deposit_voucher_ids:[id]};
    };
    if(commitFixture) {
      await db.query('COMMIT');
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[actor]);
    }
    await run({db,id,depType,postId,scope,today,rpc,preview,settle,money,rejects,summary,list,prepareContract,connectionString});
    // Exercise deferred linkage constraints; ordinary expected-error tests can leave the
    // transaction aborted and are rolled back below without claiming a successful commit.
    if(!commitFixture) {
      const state=await db.query('SELECT 1').catch(e=> {if(e.code!=='25P02')throw e;return null;});
      if(state) await db.query('SET CONSTRAINTS ALL IMMEDIATE');
    }
  } finally {
    await db.query('ROLLBACK').catch(()=>{});
    await db.end();
  }
}

test('full forfeiture produces revenue without a new cash posting or reusable deposit', async () => fixture(async f => {
  const before=await f.money();
  const s=await f.settle();
  assert.equal(s.retainedAmount,3000000);
  assert.equal(s.refundState,'NOT_REQUIRED');
  assert.equal(await f.money(),before);
  assert.equal(s.roomReleased,true);
  const {rows}=await f.db.query("SELECT system_source,total_amount,kqkd_amount,posting_mode FROM public.income_expenses WHERE id=ANY($1::uuid[]) ORDER BY system_source",[[s.revenueVoucherId,s.offsetVoucherId]]);
  assert.equal(rows.length,2);
  assert.deepEqual(rows.map(r=>Number(r.kqkd_amount)),[0,3000000]);
  assert.ok(rows.every(r=>r.posting_mode==='NON_CASH'));
  assert.equal((await f.preview()).canSettle,false);
}));

test('partial deferred refund creates no cash until pay, and pay is idempotent', async () => fixture(async f => {
  const before=await f.money();
  const s=await f.settle(1000000,'LATER');
  assert.equal(s.retainedAmount,2000000);assert.equal(s.refundRemaining,1000000);
  assert.equal(s.refundVoucherId,null);assert.equal(await f.money(),before);
  const input={settlementId:s.id,accountId:f.scope.account,paidOn:f.today,idempotencyKey:'pay-'+f.id};
  const paid=await f.rpc('pay_reservation_refund_v1',input);
  assert.equal(paid.refundState,'PAID');assert.equal(paid.refundRemaining,0);
  assert.equal(await f.money(),before-1000000);
  const retry=await f.rpc('pay_reservation_refund_v1',input);
  assert.equal(retry.refundVoucherId,paid.refundVoucherId);assert.equal(await f.money(),before-1000000);
}));

test('immediate full refund produces no revenue pair and decreases cash only once', async () => fixture(async f => {
  const before=await f.money();const s=await f.settle(3000000,'NOW');
  assert.equal(s.retainedAmount,0);assert.equal(s.revenueVoucherId,null);assert.equal(s.offsetVoucherId,null);
  assert.equal(s.refundState,'PAID');assert.equal(await f.money(),before-3000000);
}));

test('mixed receipt uses only deposit items', async () => fixture(async f => {
  assert.equal((await f.preview()).depositAmount,3000000);
  assert.equal((await f.settle()).retainedAmount,3000000);
},{other:500000}));

test('fractional source deposits cannot be silently rounded into revenue', async () => fixture(async f => {
  await f.rejects(()=>f.settle(),/nguyên|VND|hợp lệ/);
  assert.equal((await f.summary()).retainedCount,0);
},{amount:3000000.5}));

test('unposted receipt is not evidence of money received', async () => fixture(async f => {
  const p=await f.preview();assert.equal(p.canSettle,false);assert.ok(p.blockers.includes('NOT_RECEIVED'));
},{posted:false}));

test('reversed source posting is not usable deposit money', async () => fixture(async f => {
  await f.db.query('SELECT public.reverse_posted_income_expense_v2($1,$2,$3,$4,$5)',[f.id,f.scope.account,f.today,'Fixture receipt refunded','source-reverse-'+f.id]);
  const p=await f.preview();assert.equal(p.canSettle,false);assert.ok(p.blockers.includes('NOT_RECEIVED'));
  await f.rejects(()=>f.settle(),/chưa nhận tiền/);
}));

test('NOW pays today even when the forfeiture recognition date is earlier', async () => fixture(async f => {
  await f.db.query('SET LOCAL session_replication_role=replica');
  await f.db.query('UPDATE public.income_expenses SET voucher_date=$2::date-2 WHERE id=$1',[f.id,f.today]);
  await f.db.query('UPDATE public.income_expense_postings SET posted_on=$2::date-2 WHERE id=$1',[f.postId,f.today]);
  await f.db.query('SET LOCAL session_replication_role=origin');
  const {rows:[dates]}=await f.db.query('SELECT ($1::date-1)::text AS yesterday',[f.today]);
  const s=await f.settle(1000000,'NOW',{settlementDate:dates.yesterday});
  const {rows}=await f.db.query('SELECT id,voucher_date::text AS day FROM public.income_expenses WHERE id=ANY($1::uuid[])',[[s.revenueVoucherId,s.refundVoucherId]]);
  assert.equal(rows.find(r=>r.id===s.revenueVoucherId).day,dates.yesterday);
  assert.equal(rows.find(r=>r.id===s.refundVoucherId).day,f.today);
}));

test('refund above received deposit is rejected', async () => fixture(async f => {
  await assert.rejects(f.settle(3000001,'LATER'),/hoàn|refund|hợp lệ/i);
}));

test('settlement blocks later edits to original receipt money', async () => fixture(async f => {
  await f.settle();
  await assert.rejects(f.db.query("UPDATE public.income_expenses SET total_amount=1 WHERE id=$1",[f.id]),/cọc|settle/i);
}));

test('unprivileged actor cannot inspect settlement eligibility', async () => fixture(async f => {
  await f.db.query("SELECT set_config('request.jwt.claim.sub',$1,true)",['b163f4b1-455d-4ef4-bf18-18bf2d2a5c7f']);
  await assert.rejects(f.preview(),/quyền|permission/i);
}));

test('authenticated role can use the writer but cannot write settlement records or call private helpers', async () => fixture(async f => {
  await f.db.query('SET LOCAL ROLE authenticated');
  const s=await f.settle();assert.equal(s.retainedAmount,3000000);
  await f.rejects(()=>f.db.query('UPDATE public.reservation_deposit_settlements SET refund_amount=1 WHERE id=$1',[s.id]),/permission denied/);
  await f.rejects(()=>f.db.query('SELECT app_private.reservation_pay_refund_v1($1,$2,$3)',[s.id,f.scope.account,f.today]),/permission denied/);
}));

test('settlement replay checks payload and current authorization', async () => fixture(async f => {
  const s=await f.settle(1000000,'LATER');
  assert.equal((await f.settle(1000000,'LATER')).id,s.id);
  await f.rejects(()=>f.settle(2000000,'LATER'),/nội dung khác/);
  await f.db.query("SELECT set_config('request.jwt.claim.sub',$1,true)",['b163f4b1-455d-4ef4-bf18-18bf2d2a5c7f']);
  await f.rejects(()=>f.settle(1000000,'LATER'),/quyền/);
}));

test('immediate settlement replay rechecks cashbook custody', async () => fixture(async f => {
  await f.settle(1000000,'NOW');
  await f.db.query("UPDATE public.cashbook_possession_bindings SET valid_to=now()-interval '1 minute' WHERE membership_id=$1 AND cashbook_id=$2 AND possession_kind='CUSTODIAN'",[f.scope.membership,f.scope.account]);
  await f.rejects(()=>f.settle(1000000,'NOW'),/custodian|quyền|access/i);
}));

test('a stale preview cannot settle a changed source', async () => fixture(async f => {
  await f.rejects(()=>f.settle(0,'NONE',{basisFingerprint:'stale-preview'}),/thay đổi/);
  assert.equal((await f.summary()).retainedCount,0);
}));

test('refund failure rolls back the whole immediate settlement', async () => fixture(async f => {
  const before=await f.money();
  await f.db.query('UPDATE public.accounts SET lock_date=$2 WHERE id=$1',[f.scope.account,f.today]);
  await f.rejects(()=>f.settle(1000000,'NOW'),/locked|closed|khóa/i);
  assert.equal((await f.preview()).canSettle,true);
  assert.equal(await f.money(),before);
  assert.equal((await f.summary()).retainedCount,0);
}));

test('refund refuses virtual or unauthorized cashbook', async () => fixture(async f => {
  const {rows:[virtual]}=await f.db.query('SELECT id FROM public.accounts WHERE organization_id=$1 AND is_virtual AND deleted_at IS NULL LIMIT 1',[org]);
  assert.ok(virtual);
  await f.rejects(()=>f.settle(1000000,'NOW',{refundAccountId:virtual.id}),/sổ quỹ|quyền/i);
  await f.rejects(()=>f.settle(1000000,'NOW',{refundAccountId:randomUUID()}),/sổ quỹ|quyền/i);
  assert.equal((await f.preview()).canSettle,true);
}));

test('deferred totals and filtered pagination follow effective refund postings', async () => fixture(async f => {
  const s=await f.settle(1000000,'LATER');
  assert.deepEqual(await f.summary(),{retainedAmount:2000000,retainedCount:1,refundPendingAmount:1000000,refundPendingCount:1,refundPaidAmount:0,refundPaidCount:0});
  assert.equal((await f.list('PENDING')).rows[0].id,s.id);
  assert.equal((await f.list('PAID')).rows.length,0);
  await f.rpc('pay_reservation_refund_v1',{settlementId:s.id,accountId:f.scope.account,paidOn:f.today,idempotencyKey:'pay-'+f.id});
  assert.deepEqual(await f.summary(),{retainedAmount:2000000,retainedCount:1,refundPendingAmount:0,refundPendingCount:0,refundPaidAmount:1000000,refundPaidCount:1});
  assert.equal((await f.list('PENDING')).rows.length,0);
  assert.equal((await f.list('PAID')).rows[0].id,s.id);
}));

test('reversing a refund reopens debt; old retry does not pay it again', async () => fixture(async f => {
  const before=await f.money();const s=await f.settle(1000000,'LATER');
  const input={settlementId:s.id,accountId:f.scope.account,paidOn:f.today,idempotencyKey:'pay-'+f.id};
  const paid=await f.rpc('pay_reservation_refund_v1',input);
  await f.db.query('SELECT public.reverse_posted_income_expense_v2($1,$2,$3,$4,$5)',[paid.refundVoucherId,f.scope.account,f.today,'Refund returned to cashbook','reverse-'+f.id]);
  assert.equal(await f.money(),before);
  assert.equal((await f.summary()).refundPendingAmount,1000000);
  const retry=await f.rpc('pay_reservation_refund_v1',input);
  assert.equal(retry.refundState,'PENDING');assert.equal(await f.money(),before);
  const repaid=await f.rpc('pay_reservation_refund_v1',{...input,idempotencyKey:'repay-'+f.id});
  assert.equal(repaid.refundState,'PAID');assert.notEqual(repaid.refundVoucherId,paid.refundVoucherId);
  assert.equal(await f.money(),before-1000000);
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM public.reservation_settlement_vouchers WHERE settlement_id=$1 AND kind='REFUND'",[s.id])).rows[0].n,2);
}));

test('settled source and internal pair cannot be repurposed', async () => fixture(async f => {
  const s=await f.settle();
  await f.rejects(()=>f.db.query("UPDATE public.income_expense_items SET amount=1 WHERE income_expense_id=$1",[f.id]),/cọc/);
  await f.rejects(()=>f.db.query("UPDATE public.income_expenses SET contract_id=$2 WHERE id=$1",[f.id,randomUUID()]),/cọc/);
  await f.rejects(()=>f.db.query("UPDATE public.income_expenses SET account_id=$2,posting_mode='CASHBOOK' WHERE id=$1",[s.revenueVoucherId,f.scope.account]),/cọc/);
  await f.rejects(()=>f.db.query('SELECT public.reverse_posted_income_expense_v2($1,$2,$3,$4,$5)',[f.id,f.scope.account,f.today,'Invalid reversal','reverse-'+f.id]),/cọc/);
  await f.rejects(()=>f.db.query("INSERT INTO public.contract_deposit_links(organization_id,contract_id,income_expense_id,link_source,linked_by) VALUES($1,$2,$3,'EXPLICIT_V2',$4)",[org,randomUUID(),f.id,actor]),/cọc/);
}));

test('maintenance and independent holds are preserved', async () => fixture(async f => {
  await f.db.query("UPDATE public.rooms SET status='MAINTENANCE' WHERE id=$1",[f.scope.room]);
  const s=await f.settle();assert.equal(s.roomReleased,false);assert.ok(s.roomBlockers.includes('ROOM_UNAVAILABLE'));
}));

test('another customer deposit keeps the room reserved', async () => fixture(async f => {
  const otherId=randomUUID();
  await f.db.query('SET LOCAL session_replication_role=replica');
  await f.db.query("INSERT INTO public.income_expenses(id,user_id,organization_id,type,name,building_id,room_id,account_id,total_amount,approval_status,voucher_date) VALUES($1,$2,$3,'INCOME','Other customer deposit',$4,$5,$6,500000,'APPROVED',$7)",[otherId,actor,org,f.scope.building,f.scope.room,f.scope.account,f.today]);
  await f.db.query("INSERT INTO public.income_expense_items(organization_id,income_expense_id,income_expense_type_id,quantity,unit_price,amount,accounting_class) VALUES($1,$2,$3,1,500000,500000,'DEPOSIT')",[org,otherId,f.depType]);
  await f.db.query("UPDATE public.rooms SET status='RESERVED' WHERE id=$1",[f.scope.room]);
  await f.db.query('SET LOCAL session_replication_role=origin');
  const s=await f.settle();assert.equal(s.roomReleased,false);assert.ok(s.roomBlockers.includes('OTHER_DEPOSIT'));
  assert.equal((await f.db.query('SELECT status FROM public.rooms WHERE id=$1',[f.scope.room])).rows[0].status,'RESERVED');
}));

test('an unrelated 24-hour hold is not cancelled', async () => fixture(async f => {
  await f.db.query("INSERT INTO public.room_reservation_holds(organization_id,building_id,room_id,amount,held_by,expires_at) VALUES($1,$2,$3,500000,$4,now()+interval '24 hours')",[org,f.scope.building,f.scope.room,actor]);
  const s=await f.settle();assert.equal(s.roomReleased,false);assert.ok(s.roomBlockers.includes('UNRELATED_HOLD'));
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM public.room_reservation_holds WHERE room_id=$1 AND status='PENDING_APPROVAL'",[f.scope.room])).rows[0].n,1);
}));

test('approved unexpired holds also prevent releasing the room', async () => fixture(async f => {
  await f.db.query("INSERT INTO public.room_reservation_holds(organization_id,building_id,room_id,amount,held_by,expires_at,status) VALUES($1,$2,$3,500000,$4,now()+interval '24 hours','APPROVED')",[org,f.scope.building,f.scope.room,actor]);
  const s=await f.settle();assert.equal(s.roomReleased,false);assert.ok(s.roomBlockers.includes('UNRELATED_HOLD'));
}));

test('original deposit type cannot change its accounting meaning', async () => fixture(async f => {
  await f.settle();
  await f.rejects(()=>f.db.query('UPDATE public.income_expense_types SET is_deposit=false WHERE id=$1',[f.depType]),/cọc/);
}));

test('RLS and summary prevent access after membership ends', async () => fixture(async f => {
  const s=await f.settle();
  await f.db.query("UPDATE public.organization_memberships SET valid_to=now()-interval '1 minute' WHERE id=$1",[f.scope.membership]);
  await f.db.query('SET LOCAL ROLE authenticated');
  assert.equal((await f.db.query('SELECT id FROM public.reservation_deposit_settlements WHERE id=$1',[s.id])).rows.length,0);
  assert.equal((await f.summary()).retainedAmount,0);
}));

test('explicit contract creation rejects settled source, while a fresh contract receives zero old deposit', async () => fixture(async f => {
  const payload=await f.prepareContract();await f.settle();
  await f.rejects(()=>f.db.query('SELECT public.create_contract_v2($1,$2)',[payload,'contract-'+f.id]),/Phiếu cọc được chọn không hợp lệ hoặc đã được dùng/);
  payload.existing_deposit_voucher_ids=[];payload.contract.total_deposit=0;
  const {rows:[row]}=await f.db.query('SELECT public.create_contract_v2($1,$2) AS result',[payload,'fresh-contract-'+f.id]);
  const source=(await f.db.query('SELECT contract_id FROM public.income_expenses WHERE id=$1',[f.id])).rows[0];
  assert.equal(source.contract_id,null);
  assert.equal(Number((await f.db.query('SELECT deposit_paid FROM public.contracts WHERE room_id=$1',[f.scope.room])).rows[0].deposit_paid),0);
  assert.ok(row.result);
}));

test('legacy contract insertion does not relink a settled receipt', async () => fixture(async f => {
  await f.settle();
  const {rows:[c]}=await f.db.query("INSERT INTO public.contracts(user_id,organization_id,room_id,status,signed_date,start_date,end_date,start_billing_date,end_billing_date,rent_price,total_deposit,deposit_paid) VALUES($1,$2,$3,'ACTIVE',$4,$4,$4,$4,$4,3000000,0,0) RETURNING id,deposit_paid",[actor,org,f.scope.room,f.today]);
  assert.equal(Number(c.deposit_paid),0);
  assert.equal((await f.db.query('SELECT contract_id FROM public.income_expenses WHERE id=$1',[f.id])).rows[0].contract_id,null);
}));

test('settlement summary and keyset pages include more than 1000 records', async () => fixture(async f => {
  await f.db.query('SET LOCAL session_replication_role=replica');
  await f.db.query("WITH sources AS (INSERT INTO public.income_expenses(id,user_id,organization_id,type,name,building_id,room_id,account_id,total_amount,approval_status,voucher_date) SELECT gen_random_uuid(),$1,$2,'INCOME','Pagination fixture',$3,$4,$5,1,'UNAPPROVED',$6 FROM generate_series(1,1105) RETURNING id) INSERT INTO public.reservation_deposit_settlements(organization_id,source_voucher_id,building_id,room_id,deposit_amount,retained_amount,refund_amount,settlement_date,reason_code,created_by,basis_fingerprint,request_hash,idempotency_key) SELECT $2,id,$3,$4,1,0,1,$6,'NO_SHOW',$1,'fixture','fixture',id::text FROM sources",[actor,org,f.scope.building,f.scope.room,f.scope.account,f.today]);
  await f.db.query('SET LOCAL session_replication_role=origin');
  const seen=new Set();let cursor=null;
  do {
    const page=await f.list('PENDING',cursor,127);
    for(const row of page.rows) {assert.equal(seen.has(row.id),false);seen.add(row.id);}
    cursor=page.nextCursor;
  } while(cursor);
  assert.equal(seen.size,1105);assert.equal((await f.summary()).refundPendingAmount,1105);
  const [{id:oldSource}]=(await f.db.query('SELECT source_voucher_id AS id FROM public.reservation_deposit_settlements ORDER BY created_at,id LIMIT 1')).rows;
  const {rows:[exact]}=await f.db.query('SELECT public.get_reservation_settlements_v1(NULL,NULL,NULL,50,$1) AS result',[oldSource]);
  assert.equal(exact.result.rows.length,1);assert.equal(exact.result.rows[0].sourceVoucherId,oldSource);
}));

async function raceFixture(run) {
  const dbname='reservation_race_'+randomUUID().replaceAll('-','');
  const base=new URL(url);const template=decodeURIComponent(base.pathname.slice(1));
  assert.match(template,/^[a-z0-9_]+$/i);
  const adminUrl=new URL(url);adminUrl.pathname='/postgres';
  const admin=new pg.Client({connectionString:adminUrl.toString()});await admin.connect();
  try {
    await admin.query('CREATE DATABASE '+dbname+' TEMPLATE '+template);
    base.pathname='/'+dbname;
    await fixture(run,{connectionString:base.toString(),commitFixture:true});
  } finally {
    await admin.query('DROP DATABASE IF EXISTS '+dbname+' WITH (FORCE)');
    await admin.end();
  }
}

async function secondSession(f) {
  const db=new pg.Client({connectionString:f.connectionString});await db.connect();
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[actor]);
  await db.query("SET statement_timeout='8s'");
  return db;
}

test('two simultaneous settlements consume the source only once', async () => raceFixture(async f => {
  const b=await secondSession(f);
  try {
    const preview=await f.preview();
    const input={voucherId:f.id,refundAmount:0,refundMode:'NONE',settlementDate:f.today,reasonCode:'NO_SHOW',reasonText:'',refundAccountId:null,basisFingerprint:preview.fingerprint,idempotencyKey:'race-'+f.id};
    const [aResult,bResult]=await Promise.all([f.db.query('SELECT public.settle_reservation_deposit_v1($1) AS result',[input]),b.query('SELECT public.settle_reservation_deposit_v1($1) AS result',[input])]);
    assert.equal(aResult.rows[0].result.id,bResult.rows[0].result.id);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM public.reservation_deposit_settlements WHERE source_voucher_id=$1',[f.id])).rows[0].n,1);
  } finally {await b.end();}
}));

test('two simultaneous refund payments create one effective payment', async () => raceFixture(async f => {
  const s=await f.settle(1000000,'LATER');const before=await f.money();const b=await secondSession(f);
  try {
    const input={settlementId:s.id,accountId:f.scope.account,paidOn:f.today,idempotencyKey:'pay-race-'+f.id};
    const [aResult,bResult]=await Promise.all([f.db.query('SELECT public.pay_reservation_refund_v1($1) AS result',[input]),b.query('SELECT public.pay_reservation_refund_v1($1) AS result',[{...input,idempotencyKey:'pay-race-b-'+f.id}])]);
    assert.equal(aResult.rows[0].result.refundVoucherId,bResult.rows[0].result.refundVoucherId);
    assert.equal(await f.money(),before-1000000);
  } finally {await b.end();}
}));

test('contract room lock and settlement do not invert organization lock order', async () => raceFixture(async f => {
  const b=await secondSession(f);
  try {
    await b.query('BEGIN');
    await b.query('SELECT id FROM public.rooms WHERE id=$1 FOR UPDATE',[f.scope.room]);
    const preview=await f.preview();
    const input={voucherId:f.id,refundAmount:0,refundMode:'NONE',settlementDate:f.today,reasonCode:'NO_SHOW',reasonText:'',refundAccountId:null,basisFingerprint:preview.fingerprint,idempotencyKey:'lock-race-'+f.id};
    const settling=f.db.query('SELECT public.settle_reservation_deposit_v1($1) AS result',[input]);
    // Wait until the competing backend is actually blocked on the held room.
    for(let i=0;i<100;i++) {
      const {rows:[state]}=await b.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[f.db.processID]);
      if(state?.wait_event_type==='Lock')break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    await b.query('SELECT app_private.lock_org_for_decision_v1($1)',[org]);
    await b.query('COMMIT');
    assert.equal((await settling).rows[0].result.retainedAmount,3000000);
  } finally {await b.query('ROLLBACK').catch(()=>{});await b.end();}
}));

test('contract creation racing settlement has one consumer and no deadlock', async () => raceFixture(async f => {
  await f.db.query('BEGIN');const payload=await f.prepareContract();await f.db.query('COMMIT');
  const b=await secondSession(f);
  try {
    const preview=await f.preview();
    const input={voucherId:f.id,refundAmount:0,refundMode:'NONE',settlementDate:f.today,reasonCode:'NO_SHOW',reasonText:'',refundAccountId:null,basisFingerprint:preview.fingerprint,idempotencyKey:'consume-race-'+f.id};
    const results=await Promise.allSettled([f.db.query('SELECT public.settle_reservation_deposit_v1($1)',[input]),b.query('SELECT public.create_contract_v2($1,$2)',[payload,'contract-race-'+f.id])]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    const failed=results.find(r=>r.status==='rejected');assert.notEqual(failed?.reason?.code,'40P01');
    const {rows:[counts]}=await f.db.query('SELECT (SELECT count(*) FROM public.reservation_deposit_settlements WHERE source_voucher_id=$1)+(SELECT count(*) FROM public.contract_deposit_links WHERE income_expense_id=$1) AS n',[f.id]);
    assert.equal(Number(counts.n),1);
  } finally {await b.end();}
}));

// Optional HTTP boundary proof against an isolated PostgREST pointed at this same
// disposable local database. The key is test-only; production URLs are rejected.
if(process.env.RESERVATION_TEST_HTTP_URL) {
  const httpUrl=new URL(process.env.RESERVATION_TEST_HTTP_URL);
  assert.ok(['127.0.0.1','localhost'].includes(httpUrl.hostname));
  function localJwt(userId) {
    const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
    const value=encode({alg:'HS256',typ:'JWT'})+'.'+encode({role:'authenticated',sub:userId,exp:Math.floor(Date.now()/1000)+3600});
    return value+'.'+createHmac('sha256','local-reservation-test-only-secret-20260910').update(value).digest('base64url');
  }
  const call=async (path,body,userId=actor) => {
    const response=await fetch(new URL(path,httpUrl),{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+localJwt(userId),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    const data=await response.json();return {status:response.status,data};
  };
  test('HTTP FK anti-join, settlement, read-only summary and refund agree with PostgreSQL', async () => fixture(async f => {
    const path='income_expenses?select=id,settled:reservation_deposit_settlements!reservation_deposit_settlements_source_voucher_id_fkey(id)&id=eq.'+f.id+'&settled=is.null';
    const initial=await call(path);assert.equal(initial.status,200,JSON.stringify(initial.data));assert.equal(initial.data.length,1);
    const p=await call('rpc/preview_reservation_settlement_v1',{p_voucher_id:f.id});assert.equal(p.status,200,JSON.stringify(p.data));
    const input={voucherId:f.id,refundAmount:1000000,refundMode:'LATER',settlementDate:f.today,reasonCode:'NO_SHOW',reasonText:'',refundAccountId:null,basisFingerprint:p.data.fingerprint,idempotencyKey:'http-'+f.id};
    const settled=await call('rpc/settle_reservation_deposit_v1',{p_input:input});assert.equal(settled.status,200,JSON.stringify(settled.data));
    assert.equal(settled.data.retainedAmount,2000000);
    const after=await call(path);assert.equal(after.status,200,JSON.stringify(after.data));assert.equal(after.data.length,0);
    const history=await call(path.replace('&settled=is.null',''));assert.equal(history.status,200,JSON.stringify(history.data));assert.equal(history.data[0].settled.id,settled.data.id);
    const summary=await call('rpc/get_reservation_settlement_summary_v1',{p_building_ids:[f.scope.building]});assert.equal(summary.status,200,JSON.stringify(summary.data));assert.equal(summary.data.refundPendingAmount,1000000);
    const list=await call('rpc/get_reservation_settlements_v1',{p_source_voucher_id:f.id});assert.equal(list.status,200,JSON.stringify(list.data));assert.equal(list.data.rows[0].id,settled.data.id);
    const before=await f.money();
    const paid=await call('rpc/pay_reservation_refund_v1',{p_input:{settlementId:settled.data.id,accountId:f.scope.account,paidOn:f.today,idempotencyKey:'http-pay-'+f.id}});
    assert.equal(paid.status,200,JSON.stringify(paid.data));assert.equal(paid.data.refundState,'PAID');assert.equal(await f.money(),before-1000000);
    const denied=await call('rpc/preview_reservation_settlement_v1',{p_voucher_id:f.id},'b163f4b1-455d-4ef4-bf18-18bf2d2a5c7f');assert.equal(denied.status,403);
  },{commitFixture:true}));

  if (process.env.RESERVATION_TEST_BROWSER_URL) {
    const appUrl = new URL(process.env.RESERVATION_TEST_BROWSER_URL);
    assert.ok(['127.0.0.1', 'localhost'].includes(appUrl.hostname));
    const { chromium, expect } = await import('@playwright/test');
    for (const scenario of [
      { label: 'full forfeiture', refund: 0, mode: 'NONE' },
      { label: 'partial immediate refund', refund: 1000000, mode: 'NOW' },
      { label: 'partial deferred refund then actual payment', refund: 1000000, mode: 'LATER' },
      { label: 'full refund on mobile', refund: 3000000, mode: 'NOW', mobile: true },
    ]) test('Browser real RPC: ' + scenario.label, async () => fixture(async f => {
      const before = await f.money();
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: scenario.mobile ? { width: 390, height: 844 } : { width: 1280, height: 1000 } });
      await context.route('**/*', route => new URL(route.request().url()).origin === appUrl.origin
        ? route.continue() : route.abort('blockedbyclient'));
      const page = await context.newPage();
      await page.routeWebSocket('**/*', socket => socket.close());
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/rest/v1/**', async route => {
        const source = new URL(route.request().url());
        const path = source.pathname.split('/rest/v1/')[1];
        // Forward only to loopback, replacing auth with this fixture's local JWT.
        const response = await page.request.fetch(new URL(path + source.search, httpUrl).toString(), {
          method: route.request().method(),
          headers: { Authorization: 'Bearer ' + localJwt(actor), 'Content-Type': 'application/json' },
          data: route.request().postData() ?? undefined,
        });
        await route.fulfill({ response });
      });
      try {
        const entry = new URL('/.e2e-fleet/fixtures/reservation-settlement-app.html', appUrl);
        entry.searchParams.set('voucher', f.id);
        await page.goto(entry.toString());
        const dialog = page.getByRole('dialog', { name: 'Xử lý bỏ cọc', exact: true });
        await expect(dialog.getByLabel('Hoàn lại khách')).toBeVisible();
        // Cancel/reopen must make no settlement and reset the form.
        await dialog.getByLabel('Hoàn lại khách').fill('123');
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        assert.equal((await f.db.query('SELECT count(*) FROM public.reservation_deposit_settlements WHERE source_voucher_id=$1',[f.id])).rows[0].count, '0');
        await page.getByRole('button', { name: 'Mở xử lý', exact: true }).click();
        await expect(dialog.getByLabel('Hoàn lại khách')).toHaveValue('0');
        if (scenario.refund) {
          await dialog.getByLabel('Hoàn lại khách').fill(String(scenario.refund));
          await dialog.getByLabel('Cách hoàn').selectOption(scenario.mode);
          if (scenario.mode === 'NOW') {
            await dialog.getByLabel('Sổ quỹ đã chi').selectOption(f.scope.account);
            await dialog.getByRole('checkbox', { name: 'Xác nhận đã trả tiền cho khách' }).check();
          }
        }
        await dialog.getByRole('button', { name: 'Xác nhận xử lý', exact: true }).click();
        await expect(dialog).not.toBeVisible();
        const sourceList = await call('rpc/get_reservation_settlements_v1', { p_source_voucher_id: f.id });
        const result = sourceList.data.rows[0];
        assert.equal(result.retainedAmount, 3000000 - scenario.refund);
        assert.equal(await f.money(), before - (scenario.mode === 'NOW' ? scenario.refund : 0));
        assert.equal((await f.preview()).canSettle, false);
        if (scenario.mode === 'LATER') {
          await page.getByRole('button', { name: 'Hoàn tiền', exact: true }).click();
          const refund = page.getByRole('dialog', { name: 'Hoàn tiền cọc', exact: true });
          await refund.getByLabel('Sổ quỹ đã chi').selectOption(f.scope.account);
          await refund.getByRole('checkbox', { name: 'Xác nhận đã trả toàn bộ tiền hoàn' }).check();
          await refund.getByRole('button', { name: 'Ghi nhận hoàn tiền', exact: true }).click();
          await expect(refund).not.toBeVisible();
          assert.equal(await f.money(), before - scenario.refund);
          await expect(page.getByRole('button', { name: 'Hoàn tiền', exact: true })).not.toBeVisible();
        }
        await expect(page.getByRole('alert')).toHaveCount(0);
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    }, { commitFixture: true }));
  }
}
