import { existsSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { stripMigrationTransactionControl } from '../../../scripts/apply-accounting-rollout.mjs';

const migrationPath = 'supabase/migrations/20260912065909_invoice_adjustment_atomic_revisions.sql';
const conflictMigrationPath = 'supabase/migrations/20260912091403_invoice_domain_conflicts_http409.sql';
const org = 'dddd0000-0000-4000-8000-000000000001';
const invoice = '00000000-0000-4000-8000-000000000001';
const actor = '00000000-0000-4000-8000-000000000002';
const building = '00000000-0000-4000-8000-000000000003';
const collection = '00000000-0000-4000-8000-000000000004';
const componentSource = readFileSync('supabase/migrations/20260728030000_business_performance_invoice_cohort_and_categories.sql', 'utf8');
const adjustmentSource = readFileSync('supabase/migrations/20260911093834_invoice_adjustment_review.sql', 'utf8');
const collectionSource = readFileSync('supabase/migrations/20260908041231_invoice_actual_change_rounding_report.sql','utf8');
const collectionStart = collectionSource.indexOf('CREATE OR REPLACE FUNCTION public.record_invoice_collection_v5(');
const collectionEnd = collectionSource.indexOf('$function$',collectionSource.indexOf('AS $function$',collectionStart)+14)+11;
const db = new PGlite();
const item = (price = 100, cls = 'REVENUE') => ({type:'RENT', accounting_class:cls, unit_price:price, quantity:1, coefficient:1, description:'Rent'});

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE TYPE public.payment_method AS ENUM ('TM','TK','TT');
    CREATE TABLE app_private.canonical_write_operations(id uuid,organization_id uuid,operation text,subject_scope text,actor_id uuid,idempotency_key text,payload_hash text,completed_at timestamptz,response_payload jsonb);
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES ('${actor}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${actor}'::uuid $$;
    CREATE TABLE organizations(id uuid PRIMARY KEY); INSERT INTO organizations VALUES ('${org}');
    CREATE TYPE invoice_status AS ENUM ('DRAFT','PENDING_APPROVAL','APPROVED','PARTIAL_PAID','PAID','OVERDUE','CANCELLED');
    CREATE TYPE invoice_item_type AS ENUM ('RENT','SERVICE','PENALTY','DISCOUNT','OTHER');
    CREATE TABLE buildings(id uuid PRIMARY KEY, organization_id uuid, deleted_at timestamptz, name text, is_virtual boolean DEFAULT false);
    INSERT INTO buildings VALUES ('${building}','${org}',NULL,'Fixture',false);
    CREATE TABLE invoices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, building_id uuid,
      contract_id uuid, room_id uuid, user_id uuid, billing_month text DEFAULT '2026-09', kind text DEFAULT 'MONTHLY',
      status invoice_status DEFAULT 'APPROVED', deleted_at timestamptz, updated_at timestamptz DEFAULT '2026-09-01',
      total_amount numeric DEFAULT 100, subtotal numeric DEFAULT 100, paid_amount numeric DEFAULT 0,
      discount_amount numeric DEFAULT 0, discount_notes text, notes text, previous_debt numeric DEFAULT 0,
      previous_debt_sources jsonb DEFAULT '[]', UNIQUE(id,organization_id));
    CREATE TABLE invoice_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz DEFAULT clock_timestamp(), invoice_id uuid REFERENCES invoices,
      organization_id uuid, service_id uuid, type invoice_item_type DEFAULT 'OTHER', description text,
      unit_price numeric, quantity numeric, coefficient numeric, amount numeric, previous_reading numeric,
      current_reading numeric, from_date date, to_date date, sort_order int, accounting_class text DEFAULT 'REVENUE');
    CREATE TABLE services(id uuid PRIMARY KEY, organization_id uuid, deleted_at timestamptz);
    CREATE TABLE invoice_payment_collections(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid,
      invoice_id uuid, status text DEFAULT 'ACTIVE', applied_amount numeric, rounding_amount numeric DEFAULT 0,
      created_at timestamptz DEFAULT clock_timestamp(), UNIQUE(id,organization_id));
    CREATE TABLE invoice_payment_allocations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), collection_id uuid, accounting_class text, amount numeric);
    CREATE TABLE payments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid, collection_id uuid, amount numeric, reversed_at timestamptz, rounding_amount numeric DEFAULT 0);
    CREATE TABLE income_expenses(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid, type text DEFAULT 'INCOME',
      approval_status text DEFAULT 'APPROVED', deleted_at timestamptz, payment_collection_id uuid, payment_id uuid,rounding_amount numeric DEFAULT 0);
    CREATE TABLE income_expense_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), income_expense_id uuid, accounting_class text,
      amount numeric, unit_price numeric, quantity numeric);
    CREATE TABLE customer_credit_applications(invoice_id uuid, reversed_at timestamptz);
    CREATE TABLE excess_amounts(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1='${building}'::uuid AND coalesce(current_setting('test.deny',true),'')<> 'true' $$;
    CREATE FUNCTION public.can_do_on_building(text,text,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT public.can_access_building($3) AND NOT ($2='approve' AND coalesce(current_setting('test.deny_review',true),'')='true') $$;
    CREATE FUNCTION public.building_of_invoice(uuid) RETURNS uuid LANGUAGE sql AS $$ SELECT building_id FROM invoices WHERE id=$1 $$;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
    CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql AS $$ SELECT ARRAY['${org}'::uuid] $$;
    CREATE FUNCTION app_private.round_invoice_total_v1(numeric) RETURNS numeric LANGUAGE sql AS $$ SELECT round($1 / 1000) * 1000 $$;
    CREATE FUNCTION public.recompute_invoice_for_id(uuid) RETURNS void LANGUAGE sql AS $$ SELECT NULL::void $$;
    CREATE FUNCTION app_private.business_performance_exact_scope_v1(p_organization_id uuid,p_building_ids uuid[],p_require_restricted boolean)
      RETURNS TABLE(building_ids uuid[]) LANGUAGE sql AS $$ SELECT p_building_ids $$;
    ${componentSource.slice(componentSource.indexOf('CREATE TABLE public.finance_invoice_component_manifests'),componentSource.indexOf('-- Backfill only canonical'))}
    ${componentSource.slice(componentSource.indexOf('CREATE OR REPLACE FUNCTION app_private.allocate_finance_collection_components_v1'),componentSource.indexOf('CREATE OR REPLACE FUNCTION public.business_performance_invoice_cohort_v1'))}
    ${adjustmentSource.slice(adjustmentSource.indexOf('CREATE TABLE IF NOT EXISTS'),adjustmentSource.indexOf('CREATE OR REPLACE FUNCTION public.guard_paid_invoice_direct_adjustment'))}
  `);
  if (existsSync(migrationPath)) await db.exec(readFileSync(migrationPath,'utf8'));
  await db.exec(collectionSource.slice(collectionStart,collectionEnd)+';');
  if (existsSync(conflictMigrationPath)) await db.exec(readFileSync(conflictMigrationPath,'utf8'));
  await db.exec('GRANT SELECT,INSERT,UPDATE,DELETE ON invoices,invoice_items TO authenticated');
},30000);
afterAll(async () => { await db.close(); });

async function fixture(deposit=0,debt=0) {
  await db.exec(`BEGIN; INSERT INTO invoices(id,organization_id,building_id,total_amount,subtotal,previous_debt,previous_debt_sources) VALUES ('${invoice}','${org}','${building}',${100000+deposit+debt},${100000+deposit},${debt},'${debt?'[{"type":"invoice","amount":'+debt+'}]':'[]'}');
    INSERT INTO invoice_items(invoice_id,organization_id,type,description,unit_price,quantity,coefficient,amount,sort_order,accounting_class)
    VALUES ('${invoice}','${org}','RENT','Rent',100000,1,1,100000,1,'REVENUE');
    ${deposit?`INSERT INTO invoice_items(invoice_id,organization_id,type,description,unit_price,quantity,coefficient,amount,sort_order,accounting_class)
      VALUES ('${invoice}','${org}','OTHER','Deposit',${deposit},1,1,${deposit},2,'DEPOSIT');`:''}
    SELECT app_private.sync_finance_invoice_components_v1('${invoice}');`);
}
async function adjust(items = [item(120000)], opts: Record<string,unknown>={}) {
  const state = (await db.query<{adjustment_revision:number;paid_amount:string;updated_at:string}>(`SELECT * FROM invoices WHERE id='${invoice}'`)).rows[0];
  return db.query(`SELECT * FROM public.adjust_invoice_v2($1,$2::jsonb,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [invoice,JSON.stringify(items),opts.discount??0,opts.discountNotes??null,opts.notes??null,opts.reason??'Correct invoice',opts.revision??state.adjustment_revision,opts.paid??state.paid_amount,opts.updated??state.updated_at,opts.key??'test-key-0001']);
}
async function scenario(fn:()=>Promise<void>,deposit=0,debt=0) { await fixture(deposit,debt); try { await fn(); } finally {await db.exec('ROLLBACK');} }
async function paid(amount=50000, id=collection, cls='PNL', allocate=true) {
  await db.exec(`INSERT INTO invoice_payment_collections(id,organization_id,invoice_id,applied_amount) VALUES ('${id}','${org}','${invoice}',${amount});
    INSERT INTO payments(id,invoice_id,collection_id,amount) VALUES ('${id}','${invoice}','${id}',${amount});
    INSERT INTO income_expenses(id,invoice_id,payment_collection_id,payment_id) VALUES ('${id}','${invoice}','${id}','${id}');
    INSERT INTO income_expense_items(income_expense_id,accounting_class,amount) VALUES ('${id}','${cls}',${amount});
    UPDATE invoices SET paid_amount=paid_amount+${amount} WHERE id='${invoice}';
    ${allocate?`SELECT app_private.allocate_finance_collection_components_v1('${id}');`:''}`);
}

describe('atomic issued invoice adjustment SQL',()=>{
  const namedArgs = {
    p_invoice_id: `'${invoice}'::uuid`, p_after_items: `'${JSON.stringify([item(120000)])}'::jsonb`,
    p_discount_amount: '0', p_reason: "'Correct invoice'", p_expected_revision: '0',
    p_expected_paid_amount: '0', p_expected_updated_at: "'2026-09-01'::timestamptz", p_idempotency_key: "'test-key-0001'",
  };
  const namedCall = (omit?: string) => `SELECT * FROM public.adjust_invoice_v2(${Object.entries(namedArgs)
    .filter(([name]) => name !== omit).map(([name,value]) => `${name} => ${value}`).join(',')})`;
  it.each([false,true])('omitted nullable notes are SQL NULL with stable replay (existing notes: %s)',existing=>scenario(async()=>{
    if(existing) await db.exec(`UPDATE invoices SET notes='Old note',discount_notes='Old discount note' WHERE id='${invoice}'`);
    const result=await db.query(namedCall());
    expect((await db.query(`SELECT notes,discount_notes FROM invoices WHERE id='${invoice}'`)).rows).toEqual([{notes:null,discount_notes:null}]);
    expect((await adjust([item(120000)],{revision:0,paid:0,updated:'2026-09-01'})).rows).toEqual(result.rows);
  }));
  it.each([
    ['p_reason','22023'],['p_idempotency_key','22023'],['p_expected_revision','PT409'],
    ['p_expected_paid_amount','PT409'],['p_expected_updated_at','PT409'],
  ])('rejects omitted required adjustment field %s', (field,code)=>scenario(async()=>{
    await db.exec('SAVEPOINT missing_arg');
    await expect(db.query(namedCall(field))).rejects.toMatchObject({code});
    await db.exec('ROLLBACK TO SAVEPOINT missing_arg');
    expect((await db.query('SELECT count(*)::int AS count FROM invoice_adjustments')).rows).toEqual([{count:0}]);
    expect((await db.query(`SELECT adjustment_revision FROM invoices WHERE id='${invoice}'`)).rows).toEqual([{adjustment_revision:0}]);
  }));
  it('keeps explicit empty notes distinct from omitted SQL NULL',()=>scenario(async()=>{
    await db.query(namedCall());
    await db.exec('SAVEPOINT note_mismatch');
    await expect(adjust([item(120000)],{notes:'',discountNotes:'',revision:0,paid:0,updated:'2026-09-01'})).rejects.toMatchObject({code:'23505'});
    await db.exec('ROLLBACK TO SAVEPOINT note_mismatch');
    await adjust([item(130000)],{key:'test-key-0002',notes:'',discountNotes:''});
    expect((await db.query(`SELECT notes,discount_notes FROM invoices WHERE id='${invoice}'`)).rows).toEqual([{notes:'',discount_notes:''}]);
  }));
  it('persists two revisions with complete current items and editable headers',()=>scenario(async()=>{
    const first=await adjust([item(120000)],{discount:10000,discountNotes:'Discount',notes:'Updated'});
    expect(first.rows[0]).toMatchObject({revision:1,after_total:'110000.00'});
    await adjust([item(130000)],{key:'test-key-0002'});
    expect((await db.query(`SELECT adjustment_revision,adjustment_review_status,total_amount FROM invoices WHERE id='${invoice}'`)).rows[0]).toMatchObject({adjustment_revision:2,adjustment_review_status:'PENDING',total_amount:'130000'});
    expect((await db.query(`SELECT amount FROM invoice_items WHERE invoice_id='${invoice}'`)).rows).toEqual([{amount:'130000.00'}]);
    expect((await db.query(`SELECT adjustment_revision FROM finance_invoice_component_manifests WHERE invoice_id='${invoice}' ORDER BY adjustment_revision`)).rows).toEqual([{adjustment_revision:0},{adjustment_revision:1},{adjustment_revision:2}]);
  }));
  it('replays normalized identical key before stale checks but rejects a changed request',()=>scenario(async()=>{
    const opts={key:'  test-key-0001  ',revision:0,paid:0,updated:'2026-09-01'};
    const first=await adjust([item(120000)],opts);
    expect((await adjust([item(120000)],opts)).rows).toEqual(first.rows);
    await expect(adjust([item(121000)],opts)).rejects.toMatchObject({code:'23505'});
  }));
  it.each([{revision:4},{paid:1},{updated:'2026-09-02'}])('rejects stale state %j',opts=>scenario(async()=>{
    await expect(adjust([item(120000)],opts)).rejects.toMatchObject({code:'PT409'});
  }));
  it('authorizes before replay',()=>scenario(async()=>{
    await adjust(); await db.exec("SELECT set_config('test.deny','true',true)");
    await expect(adjust()).rejects.toMatchObject({code:'42501'});
  }));
  it.each([[],[null],[{...item(),quantity:-1}],[{...item(),unit_price:'NaN'}],[{...item(),accounting_class:'INVALID'}],[{...item(),type:'INVALID'}]].map(items=>({items})))('rejects malformed document %j',({items})=>scenario(async()=>{
    await expect(adjust(items as ReturnType<typeof item>[])).rejects.toMatchObject({code:'22023'});
  }));
  it('ignores client amount and accepts same-total line semantics and metadata changes',()=>scenario(async()=>{
    await adjust([{...item(100000),description:'Corrected',amount:1} as ReturnType<typeof item>],{notes:'Header'});
    expect((await db.query(`SELECT amount,description FROM invoice_items WHERE invoice_id='${invoice}'`)).rows).toEqual([{amount:'100000.00',description:'Corrected'}]);
  }));
  it('review is current-revision only and preserves financial snapshots',()=>scenario(async()=>{
    const a=(await adjust()).rows[0] as {id:string};
    const before=(await db.query(`SELECT to_jsonb(a)-'review_status'-'checked_at'-'checked_by' AS snapshot FROM invoice_adjustments a WHERE id='${a.id}'`)).rows;
    await db.query('SELECT public.review_invoice_adjustment_v2($1,1)',[a.id]);
    expect((await db.query(`SELECT to_jsonb(a)-'review_status'-'checked_at'-'checked_by' AS snapshot FROM invoice_adjustments a WHERE id='${a.id}'`)).rows).toEqual(before);
    await adjust([item(130000)],{key:'test-key-0002'});
    await expect(db.query('SELECT public.review_invoice_adjustment_v2($1,1)',[a.id])).rejects.toMatchObject({code:'PT409'});
  }));
  it('applies migration twice without altering finalized historical components',async()=>{
    expect(existsSync(migrationPath)).toBe(true);
    await db.exec(readFileSync(migrationPath,'utf8'));
    await db.exec(readFileSync(conflictMigrationPath,'utf8'));
    await db.exec(readFileSync(conflictMigrationPath,'utf8'));
  });
  it('rejects an unexpected writer definition before applying the conflict migration',()=>scenario(async()=>{
    await db.exec(`ALTER FUNCTION public.adjust_invoice_v2(uuid,jsonb,numeric,text,text,text,bigint,numeric,timestamptz,text) SET search_path=public`);
    const body=stripMigrationTransactionControl(readFileSync(conflictMigrationPath,'utf8'),conflictMigrationPath);
    await expect(db.exec(body)).rejects.toMatchObject({code:'55000'});
  }));
  it('uses non-retryable domain conflicts in every affected deployed writer',async()=>{
    const rows=(await db.query<{name:string;source:string}>(`SELECT proname AS name,prosrc AS source FROM pg_proc WHERE proname IN ('adjust_invoice_v2','review_invoice_adjustment_v2','pin_invoice_collection_manifest_v2','record_invoice_collection_v5') ORDER BY proname`)).rows;
    expect(rows).toHaveLength(4);
    for(const row of rows){expect(row.source).toMatch(/ERRCODE\s*=\s*'PT409'/);expect(row.source).not.toMatch(/ERRCODE\s*=\s*'40001'/);}
  });
  it('rejects metadata that would otherwise be silently discarded',()=>scenario(async()=>{
    await expect(adjust([{...item(120000),billing_month:'2027-01'} as ReturnType<typeof item>])).rejects.toMatchObject({code:'22023'});
  }));
  it('includes the fixed header and debt sources in the after snapshot',()=>scenario(async()=>{
    expect((await adjust()).rows[0]).toMatchObject({after_snapshot:{building_id:building,previous_debt_sources:[]}});
  }));
  it('allocates against active coverage by kind across revisions and preserves reversed allocation rows',()=>scenario(async()=>{
    await paid();
    const before=(await db.query(`SELECT to_jsonb(a) AS row FROM finance_invoice_component_allocations a WHERE collection_id='${collection}'`)).rows;
    await adjust([item(80000),{...item(30000,'DEPOSIT'),sort_order:2} as ReturnType<typeof item>]);
    const next='00000000-0000-4000-8000-000000000005';
    await paid(60000,next);
    const allocations=await db.query(`SELECT c.component_kind,a.amount,m.adjustment_revision FROM finance_invoice_component_allocations a
      JOIN finance_invoice_components c ON c.id=a.component_id JOIN finance_invoice_component_manifests m ON m.id=c.manifest_id WHERE collection_id='${next}' ORDER BY c.component_order`);
    expect(allocations.rows).toEqual([{component_kind:'CURRENT_CHARGE',amount:'30000.00',adjustment_revision:1},{component_kind:'CURRENT_DEPOSIT',amount:'30000.00',adjustment_revision:1}]);
    await db.exec(`UPDATE invoice_payment_collections SET status='REVERSED' WHERE id='${next}'; UPDATE payments SET reversed_at=now() WHERE collection_id='${next}'; UPDATE invoices SET paid_amount=50000 WHERE id='${invoice}'`);
    expect((await db.query(`SELECT to_jsonb(a) AS row FROM finance_invoice_component_allocations a WHERE collection_id='${collection}'`)).rows).toEqual(before);
    await adjust([item(90000),item(30000,'DEPOSIT')],{key:'after-reverse-0001'});
  },20000));
  it('rejects reducing already covered semantic money even when total remains the same',()=>scenario(async()=>{
    await paid();
    await expect(adjust([item(40000),item(60000,'DEPOSIT')])).rejects.toMatchObject({code:'55000'});
  }));
  it('rejects changing active component kind although PNL semantic remains sufficient',()=>scenario(async()=>{
    await paid();
    await paid(50000,'00000000-0000-4000-8000-000000000005');
    await db.exec(`UPDATE invoice_payment_collections SET status='REVERSED' WHERE id='${collection}'; UPDATE payments SET reversed_at=now() WHERE collection_id='${collection}'; UPDATE invoices SET paid_amount=50000 WHERE id='${invoice}'`);
    // Active 50k CURRENT_CHARGE remains after reversing the 50k carried debt payment.
    // New PNL is 90k (40k current + 50k carried), but current capacity is only 40k.
    await expect(adjust([item(40000)])).rejects.toMatchObject({code:'55000',message:expect.stringContaining('CURRENT_CHARGE')});
  },0,50000));
  it('rejects mixed legacy money without proved component allocations',()=>scenario(async()=>{
    await paid(50000,collection,'PNL',false);
    await expect(adjust([item(110000),item(20000,'DEPOSIT')])).rejects.toMatchObject({code:'55000'});
  },20000));
  it('accepts independently proved pure PNL legacy coverage and never fabricates historical allocations',()=>scenario(async()=>{
    await paid(50000,collection,'PNL',false);
    await adjust([item(80000),item(20000,'DEPOSIT')]);
    expect((await db.query(`SELECT count(*)::int AS n FROM finance_invoice_component_allocations WHERE collection_id='${collection}'`)).rows).toEqual([{n:0}]);
    await paid(30000,'00000000-0000-4000-8000-000000000005');
    expect((await db.query(`SELECT amount FROM finance_invoice_component_allocations`)).rows).toEqual([{amount:'30000.00'}]);
  }));
  it.each(['rounding','credit'])('rejects active %s',kind=>scenario(async()=>{
    if(kind==='rounding') await db.exec(`INSERT INTO invoice_payment_collections(organization_id,invoice_id,applied_amount,rounding_amount) VALUES ('${org}','${invoice}',0,1000)`);
    else await db.exec(`INSERT INTO customer_credit_applications VALUES ('${invoice}',NULL)`);
    await expect(adjust()).rejects.toMatchObject({code:'55000'});
  }));
  it('rejects a no-op document',()=>scenario(async()=>{
    await expect(adjust([item(100000)])).rejects.toMatchObject({code:'22023'});
  }));
  it('requires approve capability for review',()=>scenario(async()=>{
    const a=(await adjust()).rows[0] as {id:string};
    await db.exec("SELECT set_config('test.deny_review','true',true)");
    await expect(db.query('SELECT public.review_invoice_adjustment_v2($1,1)',[a.id])).rejects.toMatchObject({code:'42501'});
  }));
  it('captures all new items when deferred constraints are forced immediate',()=>scenario(async()=>{
    await db.exec('SET CONSTRAINTS ALL IMMEDIATE');
    await adjust([item(80000),item(30000,'DEPOSIT')]);
    expect((await db.query(`SELECT c.amount FROM finance_invoice_components c JOIN finance_invoice_component_manifests m ON m.id=c.manifest_id
      WHERE m.invoice_id='${invoice}' AND m.adjustment_revision=1 AND c.component_kind='CURRENT_DEPOSIT'`)).rows).toEqual([{amount:'30000.00'}]);
  },20000));
  it.each(['payment','voucher'])('rejects legacy active rounding on %s',kind=>scenario(async()=>{
    if(kind==='payment') await db.exec(`INSERT INTO payments(invoice_id,amount,rounding_amount) VALUES ('${invoice}',0,1000)`);
    else await db.exec(`INSERT INTO income_expenses(invoice_id,rounding_amount) VALUES ('${invoice}',1000)`);
    await expect(adjust()).rejects.toMatchObject({code:'55000',message:expect.stringContaining('làm tròn')});
  }));
  it('fails closed when a building authorization helper returns NULL',()=>scenario(async()=>{
    await db.exec('CREATE OR REPLACE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT NULL::boolean $$');
    await expect(adjust()).rejects.toMatchObject({code:'42501'});
  }));
  it('rejects a missing item description before database constraints',()=>scenario(async()=>{
    await expect(adjust([{...item(120000),description:null} as unknown as ReturnType<typeof item>])).rejects.toMatchObject({code:'22023'});
  }));
  it('preserves item identity and fractional/service/date/reading metadata on a notes-only revision',()=>scenario(async()=>{
    await db.exec(`UPDATE invoice_items SET unit_price=12500,quantity=2.5,coefficient=3.2,previous_reading=3,current_reading=7,from_date='2026-09-01',to_date='2026-09-12',sort_order=17,type='SERVICE' WHERE invoice_id='${invoice}'`);
    const before=(await db.query<{item:ReturnType<typeof item>}>(`SELECT to_jsonb(i) AS item FROM invoice_items i WHERE invoice_id='${invoice}'`)).rows[0].item;
    const result=(await adjust([before],{notes:'Only notes changed'})).rows[0];
    expect((await db.query(`SELECT to_jsonb(i) AS item FROM invoice_items i WHERE invoice_id='${invoice}'`)).rows[0]).toEqual({item:before});
    expect(result).toMatchObject({after_snapshot:{items:[expect.objectContaining({id:(before as unknown as {id:string}).id,quantity:2.5,coefficient:3.2,sort_order:17})]}});
  }));
  it('rejects item IDs not owned by this invoice',()=>scenario(async()=>{
    await expect(adjust([{...item(120000),id:'00000000-0000-4000-8000-000000000099'} as ReturnType<typeof item>])).rejects.toMatchObject({code:'42501'});
  }));
  it('reports one invoice with latest obligations and collections from all revisions',()=>scenario(async()=>{
    await paid(); await adjust([item(80000),item(30000,'DEPOSIT')]);
    await paid(60000,'00000000-0000-4000-8000-000000000005');
    const cohort=await db.query(`SELECT invoice_count,billed_current_charge,collected_current_charge,current_deposit FROM public.business_performance_invoice_cohort_v1('${org}','2026-09-01',ARRAY['${building}'::uuid])`);
    expect(cohort.rows).toEqual([{invoice_count:1,billed_current_charge:'80000.00',collected_current_charge:'80000.00',current_deposit:'30000.00'}]);
  },20000));
  it('scopes history reads and hides sandbox data from super admins',()=>scenario(async()=>{
    await adjust(); await db.exec('SET LOCAL ROLE authenticated');
    expect((await db.query('SELECT count(*)::int n FROM invoice_adjustments')).rows).toEqual([{n:1}]);
    await db.exec("SELECT set_config('test.deny','true',true)");
    expect((await db.query('SELECT count(*)::int n FROM invoice_adjustments')).rows).toEqual([{n:0}]);
    await db.exec("RESET ROLE; SELECT set_config('test.deny','false',true); CREATE OR REPLACE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$; SET LOCAL ROLE authenticated");
    expect((await db.query('SELECT count(*)::int n FROM invoice_adjustments')).rows).toEqual([{n:0}]);
  }));
  it('prevents deletion or money mutation of adjustment history even as owner',()=>scenario(async()=>{
    const result=(await adjust()).rows[0] as {id:string};
    await db.exec('SAVEPOINT guard_check');
    await expect(db.query('DELETE FROM invoice_adjustments WHERE id=$1',[result.id])).rejects.toMatchObject({code:'42501'});
    await db.exec('ROLLBACK TO guard_check');
    await expect(db.query("UPDATE invoice_adjustments SET reason='Tampered',review_status='CHECKED',checked_by=$2,checked_at=now() WHERE id=$1",[result.id,actor])).rejects.toMatchObject({code:'42501'});
  }));
  it('rejects debt carried to a later invoice',()=>scenario(async()=>{
    await db.exec(`UPDATE invoices SET contract_id='${actor}' WHERE id='${invoice}';
      INSERT INTO invoices(organization_id,building_id,contract_id,billing_month,previous_debt_sources) VALUES ('${org}','${building}','${actor}','2026-10','[{"type":"invoice","id":"${invoice}","amount":10000}]')`);
    await expect(adjust()).rejects.toMatchObject({code:'55000',message:expect.stringContaining('Nợ đã chuyển')});
  }));
  it.each([-1,120001,'NaN'])('rejects invalid discount %s',discount=>scenario(async()=>{
    await expect(adjust([item(120000)],{discount})).rejects.toMatchObject({code:'22023'});
  }));
  it('rejects legacy issued writer bypass',()=>scenario(async()=>{
    await expect(db.query(`SELECT public.update_invoice_v1('${invoice}',NULL,NULL,NULL,'2026-09',NULL,NULL,100000,0,100000,0,'[]')`)).rejects.toMatchObject({code:'55000'});
  }));
  it('rejects services outside the invoice organization',()=>scenario(async()=>{
    await expect(adjust([{...item(120000),service_id:actor} as ReturnType<typeof item>])).rejects.toMatchObject({code:'42501'});
  }));
  it('uses ordinary quantity/coefficient defaults and derives amount on server',()=>scenario(async()=>{
    await adjust([{type:'OTHER',description:'Default factors',accounting_class:'REVENUE',unit_price:125000} as ReturnType<typeof item>]);
    expect((await db.query(`SELECT quantity,coefficient,amount FROM invoice_items WHERE invoice_id='${invoice}'`)).rows).toEqual([{quantity:'1',coefficient:'1',amount:'125000.00'}]);
  }));
  it('prevents repinning a collection to another manifest',()=>scenario(async()=>{
    await paid(); await adjust();
    await expect(db.exec(`UPDATE invoice_payment_collections SET component_manifest_id=(SELECT id FROM finance_invoice_component_manifests WHERE adjustment_revision=1) WHERE id='${collection}'`)).rejects.toMatchObject({code:'55000'});
  }));
  it('keeps proved legacy PNL reportable after the latest document becomes mixed',()=>scenario(async()=>{
    await paid(50000,collection,'PNL',false);
    const cohort=()=>db.query(`SELECT cohort_available,billed_current_charge,collected_current_charge,allocation_unknown_count
      FROM public.business_performance_invoice_cohort_v1('${org}','2026-09-01',ARRAY['${building}'::uuid])`);
    expect((await cohort()).rows).toEqual([{cohort_available:true,billed_current_charge:'100000.00',collected_current_charge:'50000',allocation_unknown_count:0}]);
    await adjust([item(80000),item(20000,'DEPOSIT')]);
    expect((await cohort()).rows).toEqual([{cohort_available:true,billed_current_charge:'80000.00',collected_current_charge:'50000',allocation_unknown_count:0}]);
    expect((await db.query(`SELECT count(*)::int n FROM finance_invoice_component_allocations WHERE collection_id='${collection}'`)).rows).toEqual([{n:0}]);
  }));
  it('subtracts known deposit allocations before proving residual legacy PNL on another adjustment',()=>scenario(async()=>{
    await paid(50000,collection,'PNL',false);
    await adjust([item(80000),item(20000,'DEPOSIT')]);
    const next='00000000-0000-4000-8000-000000000005';
    await paid(50000,next);
    // The real V5 writer emits 30k PNL + 20k DEPOSIT for this collection.
    await db.exec(`UPDATE income_expense_items SET amount=30000 WHERE income_expense_id='${next}';
      INSERT INTO income_expense_items(income_expense_id,accounting_class,amount) VALUES ('${next}','DEPOSIT',20000)`);
    const allocationRows=(await db.query(`SELECT to_jsonb(a) row FROM finance_invoice_component_allocations a ORDER BY a.id`)).rows;
    const revised=await adjust([item(90000),item(30000,'DEPOSIT')],{key:'residual-second-revision'});
    expect(revised.rows[0]).toMatchObject({revision:2,after_total:'120000.00'});
    expect((await db.query(`SELECT cohort_available,billed_current_charge,collected_current_charge,allocation_unknown_count
      FROM public.business_performance_invoice_cohort_v1('${org}','2026-09-01',ARRAY['${building}'::uuid])`)).rows)
      .toEqual([{cohort_available:true,billed_current_charge:'90000.00',collected_current_charge:'80000.00',allocation_unknown_count:0}]);
    expect((await db.query(`SELECT to_jsonb(a) row FROM finance_invoice_component_allocations a ORDER BY a.id`)).rows).toEqual(allocationRows);
  }));
  it('still rejects a genuinely mixed unallocated residual after newer allocated collections',()=>scenario(async()=>{
    await paid(50000,collection,'PNL',false);
    await adjust([item(80000),item(20000,'DEPOSIT')]);
    const next='00000000-0000-4000-8000-000000000005';
    await paid(50000,next);
    await db.exec(`UPDATE income_expense_items SET amount=30000 WHERE income_expense_id='${next}';
      INSERT INTO income_expense_items(income_expense_id,accounting_class,amount) VALUES ('${next}','DEPOSIT',20000)`);
    await paid(5000,'00000000-0000-4000-8000-000000000006','DEPOSIT',false);
    expect((await db.query(`SELECT cohort_available,allocation_unknown_count FROM public.business_performance_invoice_cohort_v1('${org}','2026-09-01',ARRAY['${building}'::uuid])`)).rows)
      .toEqual([{cohort_available:false,allocation_unknown_count:1}]);
    await expect(adjust([item(90000),item(30000,'DEPOSIT')],{key:'ambiguous-residual'})).rejects.toMatchObject({code:'55000',message:expect.stringContaining('hỗn hợp')});
  }));
});
