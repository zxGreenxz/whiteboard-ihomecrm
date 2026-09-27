import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const quote=s=>{assert(/^[a-z][a-z0-9_]*$/.test(s));return `"${s}"`;};
const table=s=>s.split('.').map(quote).join('.');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export async function triggerDigest({query}) {
  return hash((await query("SELECT tgrelid::regclass::text,tgname,tgenabled,pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1,2")).rows);
}
export async function legacyLedger({query},fixtures) {
  assert(fixtures.length>0 && fixtures.every(f=>!f.account),'Committed cleanup excludes deposit/cashbook fixtures');
  const ids=key=>fixtures.map(f=>f[key]);
  const select=async(t,sql,params)=>(await query(`SELECT * FROM ${t} WHERE ${sql} ORDER BY id`,params)).rows;
  const ledger={};
  for(const [t,key]of [['public.rooms','room'],['public.customers','customer'],['public.contracts','contract'],['public.contract_terminations','termination']]) {
    ledger[t]=await select(t,'id=ANY($1::uuid[])',[ids(key)]);
    assert.equal(ledger[t].length,key==='termination'?fixtures.filter(f=>f.termination!==null).length:fixtures.length,'Every owned root must exist');
  }
  for(const f of fixtures) {
    const row=t=>ledger['public.'+t].find(r=>r.id===f[{rooms:'room',customers:'customer',contracts:'contract',contract_terminations:'termination'}[t]]);
    for(const t of ['rooms','customers','contracts'])assert.equal(row(t).organization_id,f.organizationId);
    assert.equal(row('rooms').name,f.marker); assert.equal(row('rooms').building_id,f.building);
    assert.equal(row('customers').full_name,f.marker);assert.equal(row('contracts').notes,f.marker);
    assert.equal(row('contracts').room_id,f.room);
    if(f.termination===null) {
      assert.equal((await query('SELECT id FROM public.contract_terminations WHERE contract_id=$1',[f.contract])).rowCount,0,'Absent termination must have no substitute row');
    } else {
      assert.equal(row('contract_terminations').organization_id,f.organizationId);
      assert.equal(row('contract_terminations').notes,f.marker);
      assert.equal(row('contract_terminations').contract_id,f.contract);
    }
  }
  // Additional exact term IDs (two-DRAFT race) are supplied by the fixture owner.
  const terms=fixtures.flatMap(f=>f.additionalTerminations??[]);
  if(terms.length) {
    const extra=await select('public.contract_terminations','id=ANY($1::uuid[])',[terms]);
    assert.equal(extra.length,terms.length);
    for(const r of extra){const f=fixtures.find(f=>f.contract===r.contract_id);assert(f);assert.equal(r.organization_id,f.organizationId);assert.equal(r.notes,f.marker);}
    ledger['public.contract_terminations'].push(...extra);
  }
  for(const t of ['public.contract_customers','public.room_price_history','public.income_expenses'])ledger[t]=await select(t,'contract_id=ANY($1::uuid[])',[ids('contract')]);
  for(const r of ledger['public.contract_customers'])assert(fixtures.some(f=>f.contract===r.contract_id&&f.customer===r.customer_id));
  for(const r of ledger['public.room_price_history'])assert(fixtures.some(f=>f.contract===r.contract_id&&f.room===r.room_id&&f.building===r.building_id));
  for(const r of ledger['public.income_expenses']){
    const f=fixtures.find(f=>f.contract===r.contract_id);assert(f);
    assert.equal(r.organization_id,f.organizationId);assert.equal(r.room_id,f.room);assert.equal(r.building_id,f.building);
    assert.equal(r.account_id,null);assert.equal(r.approval_status,'UNAPPROVED');assert.equal(r.posting_status,'UNPOSTED');
    assert.equal(r.type,'INCOME');assert.equal(Number(r.total_amount),100);
  }
  ledger['public.income_expense_items']=await select('public.income_expense_items','income_expense_id=ANY($1::uuid[])',[ledger['public.income_expenses'].map(r=>r.id)]);
  return ledger;
}

export async function assertIncomingClosure({query},ledger) {
  const fks=(await query(`SELECT cn.nspname AS child_schema,cc.relname AS child_table,pn.nspname AS parent_schema,pc.relname AS parent_table,k.conname,
    ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY u(n,i) JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=u.n ORDER BY u.i) AS child_columns,
    ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY u(n,i) JOIN pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=u.n ORDER BY u.i) AS parent_columns
    FROM pg_constraint k JOIN pg_class cc ON cc.oid=k.conrelid JOIN pg_namespace cn ON cn.oid=cc.relnamespace
    JOIN pg_class pc ON pc.oid=k.confrelid JOIN pg_namespace pn ON pn.oid=pc.relnamespace WHERE k.contype='f' ORDER BY 1,2,5`)).rows;
  assert(fks.length>0,'FK catalog cannot be empty');
  let checked=0;
  for(const fk of fks) {
    const parent=fk.parent_schema+'.'+fk.parent_table,child=fk.child_schema+'.'+fk.child_table;
    if(!ledger[parent]?.length)continue;
    assert(ledger[parent].every(r=>r.id!==undefined),'Incoming parent identity must be explicit');
    const join=fk.child_columns.map((c,i)=>`c.${quote(c)}=p.${quote(fk.parent_columns[i])}`).join(' AND ');
    const rows=(await query(`SELECT c.* FROM ${table(child)} c JOIN ${table(parent)} p ON ${join} WHERE p.id=ANY($1::uuid[])`,[ledger[parent].map(r=>r.id)])).rows;
    for(const r of rows)assert(ledger[child]?.some(owned=>owned.id!==undefined?owned.id===r.id:JSON.stringify(owned)===JSON.stringify(r)),`Unexpected descendant through ${fk.conname}`);
    checked++;
  }
  assert(checked>0);return {catalogHash:hash(fks),checked};
}

export async function cleanupLegacy(ctx,{fixtures,ledger,expectedTriggerDigest,buildingBaselines}) {
  const {query}=ctx;
  assert.equal(await triggerDigest(ctx),expectedTriggerDigest,'No business guard state change');
  assert.deepEqual(await legacyLedger(ctx,fixtures),ledger,'Fixture changed after quiescent ledger capture');
  const closure=await assertIncomingClosure(ctx,ledger),deleted=[];
  for(const t of ['public.income_expense_items','public.income_expenses','public.contract_terminations','public.room_price_history','public.contract_customers','public.contracts','public.customers','public.rooms']) {
    const ids=ledger[t].map(r=>r.id);
    if(ids.length){const result=await query(`DELETE FROM ${table(t)} WHERE id=ANY($1::uuid[])`,[ids]);assert.equal(result.rowCount,ids.length);}
    assert.equal(Number((await query(`SELECT count(*) AS n FROM ${table(t)} WHERE id=ANY($1::uuid[])`,[ids])).rows[0].n),0);
    deleted.push({table:t,count:ids.length});
  }
  await query('SET CONSTRAINTS ALL IMMEDIATE');
  for(const baseline of buildingBaselines)assert.equal((await query('SELECT total_rooms FROM public.buildings WHERE id=$1',[baseline.id])).rows[0].total_rooms,baseline.total_rooms,'Building projection restored');
  const vouchers=ledger['public.income_expenses'].map(r=>r.id),items=ledger['public.income_expense_items'].map(r=>r.id);
  assert.equal(Number((await query('SELECT count(*) AS n FROM public.income_expense_postings WHERE voucher_id=ANY($1::uuid[])',[vouchers])).rows[0].n),0);
  const residual={
    operations:(await query('SELECT organization_id,operation,subject_scope,actor_id,idempotency_key,subject_id,outcome_kind FROM app_private.canonical_write_operations WHERE subject_id=ANY($1::uuid[]) ORDER BY organization_id,operation,subject_scope,actor_id,idempotency_key',[vouchers])).rows,
    audit:(await query('SELECT id,income_expense_id FROM app_private.income_expense_change_log WHERE income_expense_id=ANY($1::uuid[]) ORDER BY id',[vouchers])).rows,
    changeCapture:(await query("SELECT sequence_id,source_table,source_pk FROM app_private.finance_v2_backfill_change_log WHERE (source_table='public.income_expenses' AND source_pk::text=ANY($1::text[])) OR (source_table='public.income_expense_items' AND source_pk::text=ANY($2::text[])) ORDER BY sequence_id",[vouchers,items])).rows,
  };
  assert.equal(await triggerDigest(ctx),expectedTriggerDigest);
  return {closure,deleted,residual,fixturePostingCount:0,guardsUnchanged:true,counters:'Retained; never rewound'};
}
