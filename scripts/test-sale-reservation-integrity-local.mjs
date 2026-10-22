// Only synthetic loopback databases are accepted by the shared fixture guard.
// Real restored business functions, authenticated role and two PG connections.
// JWT request claims are injected locally; no HTTP/PostgREST verification.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {saleQuickClient} from './sale-quick-local-fixture.mjs';
import {seedSaleReservationFixture} from './sale-reservation-local-fixture.mjs';
const f=await seedSaleReservationFixture();
const admin=await saleQuickClient(),sale=await saleQuickClient(f.actors.sale),manager=await saleQuickClient(f.actors.manager);
const owner=await saleQuickClient(f.actors.landlord),outsider=await saleQuickClient(f.actors.other);
const results=[];
async function check(name,run){
  try{await run();results.push({name,status:'passed'});console.log('PASS '+name);}
  catch(error){results.push({name,status:'failed',code:error.code??null,message:error.message});console.log('FAIL '+name+': '+error.message);}
}
async function create(db,room,key,payload={}){
  return (await db.query('SELECT public.create_room_reservation_v1($1,$2,$3) r',
    [f.org,key,{room_id:room,customer_id:f.customer,hold_until:f.deadline,topup_due_on:f.topup,deposit_target:2000000,...payload}])).rows[0].r;
}
const receipt={amount:500000,account_id:f.account,voucher_date:f.today,attachments:[]};
async function read(db,ids){return(await db.query('SELECT public.read_reservation_deposit_received_v1($1,$2) r',[f.org,ids])).rows[0].r;}
async function waitForLock(pid){
  for(let attempt=0;attempt<100;attempt++){
    if((await admin.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.wait_event_type==='Lock')return;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.fail('Expected the second real connection to wait on a database lock');
}
let held;
try{
  await check('PG-M01 Sale creates a scoped reservation; real posting facts define received money and exact replay',async()=>{
    const key='local-receipt-'+randomUUID();
    held=await create(sale,f.rooms[0],key,{receipt});
    assert.equal(held.status,'HOLD');assert.equal(held.receipts.length,1);
    const voucher=held.receipts[0].source_voucher_id;
    assert.equal((await create(sale,f.rooms[0],key,{receipt})).id,held.id);
    const received=await read(sale,[voucher]);
    assert.equal(received.length,1);assert.equal(received[0].reservation_id,held.id);
    const basis=(await admin.query('SELECT app_private.reservation_settlement_basis_v1($1) b',[voucher])).rows[0].b;
    assert.equal(received[0].received_amount,basis.received?basis.amount:0);
    assert.equal(held.received_amount,received[0].received_amount);
    const terms=(await admin.query("SELECT hold_until::text,topup_due_date::text,deposit_target FROM reservation_hold_deadlines WHERE income_expense_id=$1",[voucher])).rows[0];
    assert.deepEqual(terms,{hold_until:f.deadline,topup_due_date:f.topup,deposit_target:'2000000'});
    assert.equal((await admin.query('SELECT count(*)::int n FROM reservation_receipts WHERE reservation_id=$1',[held.id])).rows[0].n,1);
  });
  await check('PG-M02 Sale cannot edit terms; manager can use legacy terms route and source/history agree',async()=>{
    assert.ok(held,'PG-M01 must create the source reservation');
    const voucher=held.receipts[0].source_voucher_id;
    await assert.rejects(sale.query('SELECT set_reservation_hold_terms_v1($1,$2,$3,3000000)',[voucher,f.extension,f.topup]),{code:'42501'});
    const result=(await manager.query('SELECT set_reservation_hold_terms_v1($1,$2,$3,3000000) r',[voucher,f.extension,f.topup])).rows[0].r;
    assert.equal(result.holdUntil,f.extension);
    const canonical=(await admin.query('SELECT revision,hold_until::text,deposit_target FROM room_reservations WHERE id=$1',[held.id])).rows[0];
    assert.deepEqual(canonical,{revision:'2',hold_until:f.extension,deposit_target:'3000000'});
    assert.equal((await admin.query('SELECT count(*)::int n FROM app_private.room_reservation_history WHERE reservation_id=$1',[held.id])).rows[0].n,2);
    await assert.rejects(manager.query("SELECT update_room_reservation_v1($1,$2,1,$3,'UPDATE','{}',NULL)",[f.org,held.id,'local-stale-'+randomUUID()]),{code:'PT409'});
  });
  await check('PG-M03 received RPC respects actual RLS and rejects foreign organization actors',async()=>{
    assert.ok(held,'PG-M01 must create the source reservation');
    const voucher=held.receipts[0].source_voucher_id;
    await assert.rejects(read(outsider,[voucher]),{code:'42501'});
    const guard=(await admin.query(`SELECT r.rolname,r.rolsuper,r.rolbypassrls FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
      WHERE p.oid='app_private.ie_supplement_can_read_v1(uuid)'::regprocedure`)).rows[0];
    assert.deepEqual(guard,{rolname:'ie_detail_reader',rolsuper:false,rolbypassrls:false});
    await assert.rejects(sale.query('UPDATE reservation_hold_deadlines SET deposit_target=1 WHERE income_expense_id=$1',[voucher]),{code:'42501'});
  });
  await check('PG-M04 Sale Admin scope cannot create reservation on building B or another company',async()=>{
    const staff=await saleQuickClient(f.actors.saleAdmin);
    try{
      await assert.rejects(create(staff,f.rooms[2],'local-scope-'+randomUUID()),{code:'42501'});
      await assert.rejects(create(staff,f.rooms[3],'local-org-'+randomUUID()),{code:'42501'});
    }finally{await staff.end();}
  });
  await check('PG-M05 two real sessions competing for the same temporary lock have exactly one winner',async()=>{
    await sale.query('BEGIN');
    let pending;
    try{
      const lock=(await sale.query('SELECT lock_room_for_sale_v1($1,$2,6,$3) r',[f.org,f.extraRooms[0],'Sale first'])).rows[0].r;
      pending=manager.query('SELECT lock_room_for_sale_v1($1,$2,12,$3) r',[f.org,f.extraRooms[0],'Manager second']).then(value=>({value}),error=>({error}));
      await waitForLock(manager.processID);
      await sale.query('COMMIT');
      const loser=await pending;
      assert.equal(loser.error?.code,'55000');
      const rows=(await admin.query('SELECT id FROM room_sale_locks WHERE room_id=$1 AND released_at IS NULL',[f.extraRooms[0]])).rows;
      assert.deepEqual(rows,[{id:lock.id}]);
    }finally{await sale.query('ROLLBACK');if(pending)await pending;}
  });
  await check('PG-M06 two real sessions cannot acquire two live reservation claims on one room',async()=>{
    await sale.query('BEGIN');
    let pending;
    try{
      const first=await create(sale,f.extraRooms[1],'local-first-'+randomUUID());
      pending=create(manager,f.extraRooms[1],'local-second-'+randomUUID()).then(value=>({value}),error=>({error}));
      await waitForLock(manager.processID);
      await sale.query('COMMIT');
      const loser=await pending;
      assert.equal(loser.error?.code,'55000');
      const rows=(await admin.query("SELECT reservation_id FROM room_next_claims WHERE room_id=$1 AND status='LIVE'",[f.extraRooms[1]])).rows;
      assert.deepEqual(rows,[{reservation_id:first.id}]);
    }finally{await sale.query('ROLLBACK');if(pending)await pending;}
  });
  await check('PG-M07 APPROVED alone has no received cash without a real unreversed posting',async()=>{
    // Deliberately imported historical state; never claim this is an approval
    // writer test. The reader and RLS authorizers are the real restored code.
    const voucher=randomUUID();
    await admin.query('BEGIN');
    try{
      await admin.query('SET LOCAL session_replication_role=replica');
      await admin.query(`INSERT INTO income_expenses(id,user_id,organization_id,type,name,building_id,room_id,account_id,total_amount,approval_status,voucher_date,posting_status)
        VALUES($1,$2,$3,'INCOME','Approved without cash fixture',$4,$5,$6,500000,'APPROVED',$7,'UNPOSTED')`,
      [voucher,f.actors.landlord,f.org,f.buildings[0],f.extraRooms[2],f.account,f.today]);
      await admin.query(`INSERT INTO income_expense_items(organization_id,income_expense_id,income_expense_type_id,description,quantity,unit_price,amount,accounting_class)
        VALUES($1,$2,$3,'Synthetic deposit',1,500000,500000,'DEPOSIT')`,[f.org,voucher,f.depositType]);
      await admin.query('COMMIT');
      const fact=(await read(owner,[voucher]))[0];
      assert.equal(fact.received_amount,0);assert.equal(fact.reservation_id,null);
    }catch(error){await admin.query('ROLLBACK');throw error;}
  });
}finally{
  const version=(await admin.query('SHOW server_version')).rows[0].server_version;
  writeFileSync('docs/plans/sale-phong-actions-20261021/deposit-lock-actual-pg-results.json',JSON.stringify({
    version,fixtureOrganization:f.org,scope:'Loopback synthetic fixtures; real business functions and auth role; no HTTP JWT/PostgREST.',
    results,
  },null,2)+'\n');
  await Promise.all([admin,sale,manager,owner,outsider].map(db=>db.end()));
}
if(results.some(r=>r.status!=='passed'))process.exitCode=1;
