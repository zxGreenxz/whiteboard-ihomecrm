// Positive money evidence through the restored canonical writer, never imported postings.
// This fixture accepts only the loopback sale_quick_* database guarded by saleQuickClient.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {saleQuickClient} from './sale-quick-local-fixture.mjs';
import {seedSaleReservationFixture} from './sale-reservation-local-fixture.mjs';

const f=await seedSaleReservationFixture();
const admin=await saleQuickClient(),sale=await saleQuickClient(f.actors.sale),owner=await saleQuickClient(f.actors.landlord);
const result={name:'PG-M08 scoped Sale report → custodian canonical posting → actual received; exact retry adds no money',status:'failed'};
try{
  await admin.query(`INSERT INTO app_private.server_feature_flags(feature_key,domain,mode,commit_sha,migration_sha256,maintenance_window_id,approval_reference)
    VALUES('income_expense.post.v2','income_expenses','ON','LOCAL_TEST','LOCAL_TEST','LOCAL_TEST','LOCAL_TEST')
    ON CONFLICT(feature_key) DO NOTHING`);
  const reservation=(await sale.query('SELECT create_room_reservation_v1($1,$2,$3) r',[f.org,'native-post-create-'+randomUUID(),{
    room_id:f.rooms[0],customer_id:f.customer,hold_until:f.deadline,deposit_target:500000,
    receipt:{amount:500000,account_id:f.account,voucher_date:f.today,attachments:[]},
  }])).rows[0].r;
  const voucher=reservation.receipts[0].source_voucher_id;
  const read=async()=> (await sale.query('SELECT read_reservation_deposit_received_v1($1,$2) r',[f.org,[voucher]])).rows[0].r[0];
  assert.equal((await read()).received_amount,0);
  const before=(await admin.query('SELECT approval_status,approval_version,posting_status,posting_version FROM income_expenses WHERE id=$1',[voucher])).rows[0];
  assert.equal(before.approval_status,'APPROVED');
  assert.equal(before.posting_status,'UNPOSTED');
  const input={
    subjectKind:'VOUCHER',subjectId:voucher,cashbookId:f.account,postedOn:f.today,
    expectedApprovalVersion:Number(before.approval_version),expectedPostingVersion:Number(before.posting_version),
    evidenceIds:[],idempotencyKey:'native-post-'+randomUUID(),
  };
  await assert.rejects(sale.query('SELECT post_approved_income_expense_v2($1) r',[{...input,idempotencyKey:'sale-denied-'+randomUUID()}]),{code:'42501'});
  await assert.rejects(owner.query('SELECT post_approved_income_expense_v2($1) r',[input]),{
    code:'55000',message:'finance_v2_post_manual_voucher: at least one FINALIZED evidence is required',
  });
  // The fixture supplies finalized upload metadata only. Storage upload itself
  // is outside this SQL integration test; the posting/lines are never seeded.
  const evidence=randomUUID();
  await admin.query(`INSERT INTO finance_evidence_objects(id,organization_id,bucket_id,object_name,uploader_membership_id,uploader_user_id,
    sha256,byte_size,mime_type,provenance_kind,state,finalized_at)
    VALUES($1,$2,'local-test-evidence',$3,$4,$5,$6,128,'image/png','UPLOAD','FINALIZED',now())`,
  [evidence,f.org,'synthetic/'+evidence+'.png',f.memberships.landlord,f.actors.landlord,'0'.repeat(64)]);
  input.evidenceIds=[evidence];
  const posted=(await owner.query('SELECT post_approved_income_expense_v2($1) r',[input])).rows[0].r;
  assert.equal(posted.postingStatus,'POSTED');
  assert.deepEqual((await owner.query('SELECT post_approved_income_expense_v2($1) r',[input])).rows[0].r,posted);
  const fact=await read();
  assert.deepEqual(fact,{voucher_id:voucher,reservation_id:reservation.id,received_amount:500000});
  const basis=(await admin.query('SELECT app_private.reservation_settlement_basis_v1($1) b',[voucher])).rows[0].b;
  assert.equal(basis.received,true);
  assert.equal(basis.amount,500000);
  assert.equal((await admin.query("SELECT count(*)::int n FROM income_expense_postings WHERE voucher_id=$1 AND event_kind='POSTING'",[voucher])).rows[0].n,1);
  assert.equal((await admin.query('SELECT state FROM finance_evidence_objects WHERE id=$1',[evidence])).rows[0].state,'ATTACHED');
  result.status='passed';
  Object.assign(result,{voucherId:voucher,reservationId:reservation.id,postingId:posted.postingId,receivedAmount:fact.received_amount});
  console.log('PASS '+result.name);
}catch(error){
  Object.assign(result,{code:error.code??null,message:error.message});
  console.error('FAIL '+result.name+': '+error.message);
  process.exitCode=1;
}finally{
  writeFileSync('docs/plans/sale-phong-actions-20261021/deposit-native-posting-results.json',JSON.stringify({
    fixtureOrganization:f.org,scope:'Synthetic local PostgreSQL; real auth/canonical create and post writer; finalized evidence metadata fixture, no Storage upload; no imported money/posting rows.',results:[result],
  },null,2)+'\n');
  await Promise.all([admin,sale,owner].map(db=>db.end()));
}
