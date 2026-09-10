import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareRepair, marker } from './prepare-repair.mjs';
import { setup, org, otherOrg, owner, staff, outsider, revoked, admin, noOrg, bucket, evidence, prefix, readable, commitForDisposableTest, fingerprint } from './test-fixture.mjs';

test('the deployed derivation explains mixed image visibility for a multi-org uploader',async()=>{
  const db=await setup(); try {
    assert.deepEqual((await db.query('SELECT * FROM app_private.derive_uploader_org_v1($1)',[owner])).rows,[{org:null,how:'quarantine'}]);
    assert.equal((await readable(db,owner)).length,3);
    assert.equal((await readable(db,staff)).length,0);
    await db.query('UPDATE app_private.storage_object_links SET organization_id=$1,derivation=\'uploader_owner_org\' WHERE object_name=$2',[org,evidence[0].object_name]);
    assert.deepEqual(await readable(db,staff),[evidence[0].object_name]);
  } finally {await db.close();}
});
test('review SQL rolls back by default',async()=>{
  const db=await setup();try{
    await db.exec(prepareRepair(evidence));
    assert.equal((await readable(db,staff)).length,0);
  }finally{await db.close();}
});
test('repair respects actual authenticated/anon roles, tenant boundaries, and unchanged financial records',async()=>{
  const db=await setup();try{
    const policies=await fingerprint(db);
    const money=(await db.query('SELECT * FROM public.income_expenses ORDER BY id')).rows;
    const finance=(await db.query('SELECT * FROM public.finance_evidence_objects ORDER BY object_name')).rows;
    await db.exec(commitForDisposableTest(prepareRepair(evidence)));
    await db.exec(commitForDisposableTest(prepareRepair(evidence))); // idempotent
    assert.deepEqual(await readable(db,staff),evidence.map(x=>x.object_name));
    assert.equal((await readable(db,owner)).length,3);
    assert.equal((await readable(db,admin)).length,3);
    for(const user of [outsider,revoked,noOrg]) assert.deepEqual(await readable(db,user),[]);
    assert.deepEqual(await readable(db,'','anon'),[]);
    assert.deepEqual(await fingerprint(db),policies);
    assert.deepEqual((await db.query('SELECT * FROM public.income_expenses ORDER BY id')).rows,money);
    assert.deepEqual((await db.query('SELECT * FROM public.finance_evidence_objects ORDER BY object_name')).rows,finance);
    assert.equal((await db.query('SELECT count(*)::int n FROM app_private.storage_object_links WHERE derivation=$1',[marker])).rows[0].n,2);
  }finally{await db.close();}
});
test('changed or protected targets abort the entire repair, including earlier valid rows',async()=>{
  const cases=[
    [`UPDATE app_private.storage_object_links SET organization_id='${otherOrg}' WHERE object_name='${evidence[1].object_name}'`,/already classified/],
    [`UPDATE storage.objects SET owner_id='${outsider}' WHERE name='${evidence[1].object_name}'`,/identity changed/],
    [`UPDATE public.income_expenses SET organization_id='${otherOrg}' WHERE id='${evidence[1].vouchers[0].id}'`,/Voucher changed/],
    [`UPDATE public.finance_evidence_objects SET state='QUARANTINED' WHERE object_name='${evidence[1].object_name}'`,/Finance evidence changed/],
    [`INSERT INTO app_private.ie_supplement_objects VALUES ('${bucket}','${evidence[1].object_name}')`,/Protected supplement/],
    [`INSERT INTO public.income_expenses(id,organization_id,attachments) VALUES ('00000000-0000-4000-8002-000000000099','${otherOrg}','${JSON.stringify([prefix+evidence[1].object_name])}')`,/Cross-organization reference/],
    [`UPDATE storage.objects SET archived_at=now() WHERE name='${evidence[1].object_name}'`,/identity changed/],
  ];
  for(const [change,expected] of cases){
    const db=await setup();try{
      await db.exec(change);
      await assert.rejects(db.exec(commitForDisposableTest(prepareRepair(evidence))),expected);
      await db.exec('ROLLBACK');
      assert.equal((await db.query('SELECT organization_id FROM app_private.storage_object_links WHERE object_name=$1',[evidence[0].object_name])).rows[0].organization_id,null);
    }finally{await db.close();}
  }
});
test('ordinary callers cannot run the administrative repair',async()=>{
  const db=await setup();try{
    await db.exec('SET ROLE authenticated');
    await assert.rejects(db.exec(commitForDisposableTest(prepareRepair(evidence))),/Administrative reviewed repair required|permission denied/);
    await db.exec('ROLLBACK; RESET ROLE;');
  }finally{await db.close();}
});

test('FINALIZED and explicitly absent finance rows use the unique voucher without changing finance state',async()=>{
  const db=await setup();try{
    const reviewed=structuredClone(evidence);
    reviewed[0].finance_evidence[0].state='FINALIZED';
    reviewed[1].finance_evidence=[];
    await db.query("UPDATE public.finance_evidence_objects SET state='FINALIZED' WHERE object_name=$1",[reviewed[0].object_name]);
    await db.query('DELETE FROM public.finance_evidence_objects WHERE object_name=$1',[reviewed[1].object_name]);
    const before=(await db.query('SELECT * FROM public.finance_evidence_objects')).rows;
    await db.exec(commitForDisposableTest(prepareRepair(reviewed)));
    assert.deepEqual(await readable(db,staff),reviewed.map(x=>x.object_name));
    assert.deepEqual(await readable(db,outsider),[]);
    assert.deepEqual((await db.query('SELECT * FROM public.finance_evidence_objects')).rows,before);
    for (const value of [undefined,null,[{org,state:'QUARANTINED'}],[{org:otherOrg,state:'FINALIZED'}]]) {
      const bad=structuredClone(reviewed);bad[1].finance_evidence=value;
      assert.throws(()=>prepareRepair(bad),/incomplete, protected, or ambiguous/);
    }
  }finally{await db.close();}
});

test('new finance rows, changed FINALIZED state, or duplicate voucher references invalidate reviewed evidence',async()=>{
  for(const mode of ['new-finance','changed-state','duplicate-voucher']){
    const db=await setup();try{
      const reviewed=structuredClone(evidence);
      if(mode==='new-finance') reviewed[1].finance_evidence=[]; // actual row now exists
      if(mode==='changed-state') reviewed[1].finance_evidence[0].state='FINALIZED'; // actual ATTACHED
      if(mode==='duplicate-voucher') await db.query('INSERT INTO public.income_expenses(id,organization_id,attachments) VALUES($1,$2,$3)',[
        '00000000-0000-4000-8002-000000000098',org,JSON.stringify([prefix+reviewed[1].object_name])]);
      await assert.rejects(db.exec(commitForDisposableTest(prepareRepair(reviewed))),/Finance evidence|no longer unique/);
      await db.exec('ROLLBACK');
      assert.equal((await readable(db,staff)).length,0);
    }finally{await db.close();}
  }
});
