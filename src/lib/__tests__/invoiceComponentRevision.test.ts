import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const patchPath = 'supabase/migrations/20261112120719_invoice_component_revision_consistency.sql';
const beforeSql = readFileSync('src/lib/__tests__/fixtures/invoice-component-revision-before.sql', 'utf8');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const org = id(1), actor = id(2), building = id(3), invoice = id(4);
const db = new PGlite();

// Real captured adjustment, manifest, pin and allocator bodies. Unrelated rent
// support/meter helpers are stubs; their call sites remain in the captured body.
const setup = `
CREATE SCHEMA app_private; CREATE SCHEMA auth;
CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
CREATE TYPE invoice_item_type AS ENUM ('RENT','SERVICE','OTHER');
CREATE TYPE invoice_status AS ENUM ('DRAFT','PENDING_APPROVAL','APPROVED','PARTIAL_PAID','PAID','OVERDUE','CANCELLED');
CREATE TABLE buildings(id uuid PRIMARY KEY, organization_id uuid, deleted_at timestamptz);
CREATE TABLE services(id uuid PRIMARY KEY, organization_id uuid, deleted_at timestamptz);
CREATE TABLE invoices(id uuid PRIMARY KEY, organization_id uuid, building_id uuid, contract_id uuid,
 room_id uuid, user_id uuid, invoice_number text, kind text DEFAULT 'MONTHLY', billing_month text DEFAULT '2090-01',
 status invoice_status DEFAULT 'APPROVED', deleted_at timestamptz, total_amount numeric DEFAULT 0,
 subtotal numeric DEFAULT 0, discount_amount numeric DEFAULT 0, discount_notes text, notes text,
 previous_debt numeric DEFAULT 0, previous_debt_sources jsonb DEFAULT '[]', paid_amount numeric DEFAULT 0,
 adjustment_revision bigint DEFAULT 0, adjustment_review_status text DEFAULT 'NONE',
 updated_at timestamptz DEFAULT clock_timestamp(), rent_support_plan_revision bigint,
 invoice_support_amount numeric DEFAULT 0, credit_discount_amount numeric, manual_discount_amount numeric);
CREATE TABLE invoice_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid, organization_id uuid,
 service_id uuid, type invoice_item_type, accounting_class text, description text, unit_price numeric,
 quantity numeric DEFAULT 1, coefficient numeric DEFAULT 1, amount numeric, previous_reading numeric,
 current_reading numeric, from_date date, to_date date, sort_order int, created_at timestamptz DEFAULT clock_timestamp());
CREATE TABLE invoice_adjustments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, invoice_id uuid,
 revision bigint, idempotency_key text, request_fingerprint text, reason text, before_snapshot jsonb, after_snapshot jsonb,
 before_total numeric, after_total numeric, delta numeric, adjusted_by uuid, review_status text DEFAULT 'PENDING',
 UNIQUE(invoice_id,revision), UNIQUE(invoice_id,idempotency_key));
CREATE TABLE finance_invoice_component_manifests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid,
 invoice_id uuid, component_status text, invoice_total numeric, component_total numeric, component_version int,
 anomaly_code text, source_updated_at timestamptz, captured_at timestamptz, finalized_at timestamptz,
 adjustment_revision bigint, source_adjustment_id uuid, UNIQUE(invoice_id,adjustment_revision));
CREATE TABLE finance_invoice_components(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), manifest_id uuid,
 organization_id uuid, invoice_id uuid, component_kind text, amount numeric, component_order int,
 UNIQUE(manifest_id,component_kind));
CREATE TABLE invoice_payment_collections(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid,
 organization_id uuid, component_manifest_id uuid, status text DEFAULT 'ACTIVE', applied_amount numeric,
 rounding_amount numeric DEFAULT 0);
CREATE TABLE finance_invoice_component_allocations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid,
 collection_id uuid, invoice_id uuid, component_id uuid, amount numeric, UNIQUE(collection_id,component_id));
CREATE TABLE payments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid, collection_id uuid,
 amount numeric, reversed_at timestamptz, rounding_amount numeric DEFAULT 0);
CREATE TABLE income_expenses(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid, payment_id uuid,
 payment_collection_id uuid, type text, approval_status text, deleted_at timestamptz, rounding_amount numeric DEFAULT 0);
CREATE TABLE income_expense_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), income_expense_id uuid,
 amount numeric, unit_price numeric, quantity numeric, accounting_class text);
CREATE TABLE customer_credit_applications(invoice_id uuid, reversed_at timestamptz);
CREATE TABLE app_private.rent_support_invoice_update_requests(id uuid);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.actor',true),'')::uuid $$;
CREATE FUNCTION can_access_building(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT auth.uid()='${actor}'::uuid AND $1='${building}'::uuid $$;
CREATE FUNCTION can_do_on_building(text,text,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT can_access_building($3) $$;
CREATE FUNCTION app_private.round_invoice_total_v1(numeric) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$ SELECT $1 $$;
CREATE FUNCTION app_private.invoice_rent_support_lock_v1(uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;
CREATE FUNCTION app_private.invoice_rent_support_items_open_v1(uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;
CREATE FUNCTION app_private.invoice_rent_support_items_close_v1(uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;
CREATE FUNCTION app_private.meter_capture_assert_invoice_facts_v1(uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;
CREATE FUNCTION recompute_invoice_for_id(uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;
CREATE FUNCTION noop_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER meter_capture_invoice_items_consistent AFTER INSERT OR UPDATE OR DELETE ON invoice_items
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION noop_trigger();
GRANT USAGE ON SCHEMA public,auth,app_private TO authenticated,anon,service_role;
`;

async function seed(stale = false) {
  await db.exec(`INSERT INTO buildings VALUES('${building}','${org}',NULL);
    INSERT INTO invoices(id,organization_id,building_id,total_amount,subtotal)
      VALUES('${invoice}','${org}','${building}',100000,100000);
    INSERT INTO invoice_items(id,invoice_id,organization_id,type,accounting_class,description,unit_price,amount,sort_order)
      VALUES('${id(5)}','${invoice}','${org}','RENT','REVENUE','Synthetic rent',100000,100000,1);
    SELECT app_private.sync_finance_invoice_components_v1('${invoice}');`);
  if (stale) await db.exec(`INSERT INTO invoice_items(id,invoice_id,organization_id,type,accounting_class,description,unit_price,amount,sort_order)
      VALUES('${id(6)}','${invoice}','${org}','SERVICE','REVENUE','Synthetic service',30000,30000,2);
    UPDATE invoices SET total_amount=130000,subtotal=130000 WHERE id='${invoice}';`);
}

async function adjustment(key = 'fixture-adjust-1', change?: number) {
  const { rows } = await db.query<{ items: unknown[]; adjustment_revision: number; paid_amount: string; updated_at: string }>(`
    SELECT i.adjustment_revision,i.paid_amount,i.updated_at,
      (SELECT jsonb_agg(to_jsonb(it) ORDER BY it.sort_order,it.id) FROM invoice_items it WHERE it.invoice_id=i.id) AS items
    FROM invoices i WHERE id='${invoice}'`);
  const row = rows[0];
  if (change !== undefined) Object.assign(row.items[0] as object, { unit_price: change, amount: change });
  return [invoice, JSON.stringify(row.items), 0, null, null, 'Reconcile invoice components', Number(row.adjustment_revision), Number(row.paid_amount), row.updated_at, key];
}
const adjust = (args: unknown[]) => db.query<{ id: string; revision: number; delta: string }>(
  'SELECT id,revision,delta FROM adjust_invoice_v2($1,$2::jsonb,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10)', args);
async function scenario(fn: () => Promise<void>) {
  await db.exec(`BEGIN; SET LOCAL test.actor='${actor}';`);
  try { await fn(); } finally { await db.exec('ROLLBACK'); }
}
async function collect(amount: number, collection = id(20)) {
  await db.exec(`INSERT INTO invoice_payment_collections(id,invoice_id,organization_id,applied_amount)
      VALUES('${collection}','${invoice}','${org}',${amount});
    SELECT app_private.allocate_finance_collection_components_v1('${collection}');`);
  return db.query(`SELECT sum(amount)::text AS amount FROM finance_invoice_component_allocations WHERE collection_id='${collection}'`);
}

beforeAll(async () => {
  await db.exec(setup);
  await db.exec(beforeSql);
  await db.exec(`REVOKE ALL ON FUNCTION app_private.sync_finance_invoice_components_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;
    REVOKE ALL ON FUNCTION public.adjust_invoice_v2(uuid,jsonb,numeric,text,text,text,bigint,numeric,timestamptz,text) FROM PUBLIC,anon;
    GRANT EXECUTE ON FUNCTION public.adjust_invoice_v2(uuid,jsonb,numeric,text,text,text,bigint,numeric,timestamptz,text) TO authenticated;
    CREATE TRIGGER pin_manifest BEFORE INSERT OR UPDATE ON invoice_payment_collections
    FOR EACH ROW EXECUTE FUNCTION app_private.pin_invoice_collection_manifest_v2();`);
}, 60000);
afterAll(async () => { await db.close(); });

describe.sequential('invoice component revision regression', () => {
  it('reproduces the legacy frozen-manifest failure before the patch', async () => {
    await scenario(async () => {
      await seed(true);
      await expect(collect(130000)).rejects.toMatchObject({code:'55000',message:'Phân bổ thành phần không đủ; cần đối soát các lần thu trước'});
    });
  });
  it('installs the migration twice without changing existing invoice data', async () => {
    const patch = readFileSync(patchPath, 'utf8');
    await db.exec(patch);
    await db.exec(patch);
  });
  it('repairs the current revision with unchanged content, preserves the old manifest, and collects the full amount', async () => {
    await scenario(async () => {
      await seed(true);
      const old = await db.query('SELECT to_jsonb(m) AS row FROM finance_invoice_component_manifests m');
      const request = await adjustment();
      const fixed = await adjust(request);
      expect(fixed.rows[0].revision).toBe(1);
      expect(Number(fixed.rows[0].delta)).toBe(0);
      expect((await adjust(request)).rows).toEqual(fixed.rows);
      expect((await db.query('SELECT to_jsonb(m) AS row FROM finance_invoice_component_manifests m WHERE adjustment_revision=0')).rows).toEqual(old.rows);
      expect((await collect(130000)).rows).toEqual([{amount:'130000'}]);
      expect((await db.query('SELECT count(*)::int AS n FROM invoice_adjustments')).rows).toEqual([{n:1}]);
    });
  });
  it('still rejects an unchanged healthy invoice', async () => {
    await scenario(async () => { await seed(); await expect(adjust(await adjustment())).rejects.toMatchObject({code:'22023'}); });
  });
  it('blocks collection of a stale manifest before creating a money record', async () => {
    await scenario(async () => {
      await seed(true);
      await db.exec('SAVEPOINT rejected_collection');
      await expect(collect(130000)).rejects.toMatchObject({code:'55000',hint:'INVOICE_COMPONENT_MISMATCH'});
      await db.exec('ROLLBACK TO SAVEPOINT rejected_collection');
      expect((await db.query('SELECT count(*)::int AS n FROM invoice_payment_collections')).rows).toEqual([{n:0}]);
    });
  });
  it('keeps draft components current and freezes only the complete issued version', async () => {
    await scenario(async () => {
      await db.exec(`INSERT INTO invoices(id,organization_id,building_id,status,total_amount,subtotal)
        VALUES('${invoice}','${org}','${building}','DRAFT',100000,100000);
        SELECT app_private.sync_finance_invoice_components_v1('${invoice}');
        INSERT INTO invoice_items(invoice_id,organization_id,type,accounting_class,amount)
        VALUES('${invoice}','${org}','OTHER','DEPOSIT',20000);
        UPDATE invoices SET total_amount=140000,status='APPROVED' WHERE id='${invoice}';
        SELECT app_private.sync_finance_invoice_components_v1('${invoice}');`);
      expect((await db.query(`SELECT component_kind,amount::int AS amount FROM finance_invoice_components ORDER BY component_order`)).rows)
        .toEqual([{component_kind:'CURRENT_CHARGE',amount:120000},{component_kind:'CURRENT_DEPOSIT',amount:20000}]);
      expect((await db.query(`SELECT app_private.invoice_component_manifest_matches_v1('${invoice}') AS matches`)).rows).toEqual([{matches:true}]);
    });
  });
  it('uses the same formula for debt, deposit, internal charges and settlement', async () => {
    await scenario(async () => {
      await db.exec(`INSERT INTO invoices(id,organization_id,building_id,total_amount,previous_debt,previous_debt_sources)
        VALUES('${invoice}','${org}','${building}',190000,50000,'[{"type":"invoice","amount":30000},{"type":"deposit","amount":20000}]');
        INSERT INTO invoice_items(invoice_id,organization_id,type,accounting_class,amount) VALUES
          ('${invoice}','${org}','OTHER','DEPOSIT',40000), ('${invoice}','${org}','OTHER','NON_PNL',10000);
        SELECT app_private.sync_finance_invoice_components_v1('${invoice}');`);
      expect((await db.query(`SELECT component_kind,amount::int AS amount FROM finance_invoice_components ORDER BY component_order`)).rows).toEqual([
        {component_kind:'CARRIED_INVOICE_DEBT',amount:30000},{component_kind:'CURRENT_CHARGE',amount:90000},
        {component_kind:'CARRIED_DEPOSIT_DEBT',amount:20000},{component_kind:'CURRENT_DEPOSIT',amount:40000},{component_kind:'INTERNAL',amount:10000},
      ]);
      await db.exec(`UPDATE invoices SET kind='SETTLEMENT',adjustment_revision=1 WHERE id='${invoice}'; SELECT app_private.sync_finance_invoice_components_v1('${invoice}');`);
      expect((await db.query(`SELECT c.component_kind,c.amount::int AS amount FROM finance_invoice_components c JOIN finance_invoice_component_manifests m ON m.id=c.manifest_id WHERE m.adjustment_revision=1`)).rows)
        .toEqual([{component_kind:'SETTLEMENT',amount:190000}]);
    });
  });
  it('increasing an issued invoice creates a matching new revision and leaves its old allocation immutable', async () => {
    await scenario(async () => {
      await seed();
      await collect(40000);
      await db.exec(`INSERT INTO payments(invoice_id,collection_id,amount) VALUES('${invoice}','${id(20)}',40000);
        INSERT INTO income_expenses(id,invoice_id,payment_collection_id,type,approval_status) VALUES('${id(21)}','${invoice}','${id(20)}','INCOME','APPROVED');
        INSERT INTO income_expense_items(income_expense_id,amount,accounting_class) VALUES('${id(21)}',40000,'PNL');
        UPDATE invoices SET paid_amount=40000,status='PARTIAL_PAID' WHERE id='${invoice}';`);
      const old = await db.query('SELECT to_jsonb(a) AS row FROM finance_invoice_component_allocations a');
      await adjust(await adjustment('fixture-increase',150000));
      expect((await collect(110000,id(22))).rows).toEqual([{amount:'110000'}]);
      expect((await db.query(`SELECT to_jsonb(a) AS row FROM finance_invoice_component_allocations a WHERE collection_id='${id(20)}'`)).rows).toEqual(old.rows);
    });
  });
  it('detects classification drift even when the total is unchanged', async () => {
    await scenario(async () => {
      await seed();
      await db.exec(`UPDATE invoice_items SET accounting_class='DEPOSIT',type='OTHER' WHERE invoice_id='${invoice}';`);
      await adjust(await adjustment('fixture-reclassify'));
      expect((await db.query(`SELECT c.component_kind,c.amount FROM finance_invoice_components c JOIN finance_invoice_component_manifests m ON m.id=c.manifest_id WHERE m.adjustment_revision=1`)).rows)
        .toEqual([{component_kind:'CURRENT_DEPOSIT',amount:'100000.00'}]);
    });
  });
  it('rejects a stale repair request and other building/organization actors', async () => {
    await scenario(async () => { await seed(true); const args = await adjustment(); args[6]=99;
      await expect(adjust(args)).rejects.toMatchObject({code:'PT409'}); });
    await scenario(async () => { await seed(true); const args = await adjustment(); await db.exec(`SET LOCAL test.actor='${id(99)}'; SET LOCAL ROLE authenticated;`);
      await expect(adjust(args)).rejects.toMatchObject({code:'42501'}); });
  });
  it('does not turn a debt-source anomaly into a valid repair', async () => {
    await scenario(async () => {
      await seed(true);
      await db.exec(`UPDATE invoices SET previous_debt=10000 WHERE id='${invoice}'; SAVEPOINT bad_repair;`);
      await expect(adjust(await adjustment('fixture-anomaly'))).rejects.toMatchObject({code:'55000'});
      await db.exec('ROLLBACK TO SAVEPOINT bad_repair');
      expect((await db.query('SELECT adjustment_revision FROM invoices')).rows).toEqual([{adjustment_revision:0}]);
      expect((await db.query('SELECT count(*)::int AS n FROM invoice_adjustments')).rows).toEqual([{n:0}]);
    });
  });
  it('rejects an adjustment whose synchronizer fails to produce the current revision', async () => {
    await scenario(async () => {
      await seed();
      await db.exec(`CREATE OR REPLACE FUNCTION app_private.sync_finance_invoice_components_v1(p_invoice_id uuid) RETURNS uuid
        LANGUAGE sql AS $$ SELECT id FROM public.finance_invoice_component_manifests WHERE invoice_id=p_invoice_id AND adjustment_revision=0 $$;`);
      await expect(adjust(await adjustment('fixture-stale-sync',150000))).rejects.toMatchObject({code:'55000'});
    });
  });
  it('keeps private calculations inaccessible and preserves public writer permissions', async () => {
    const {rows} = await db.query(`SELECT
      has_function_privilege('anon','app_private.invoice_component_basis_v1(uuid)','EXECUTE') AS anon_basis,
      has_function_privilege('authenticated','app_private.invoice_component_manifest_matches_v1(uuid)','EXECUTE') AS auth_matches,
      has_function_privilege('authenticated','app_private.sync_finance_invoice_components_v1(uuid)','EXECUTE') AS auth_sync,
      has_function_privilege('authenticated','public.adjust_invoice_v2(uuid,jsonb,numeric,text,text,text,bigint,numeric,timestamptz,text)','EXECUTE') AS auth_adjust,
      has_function_privilege('anon','public.adjust_invoice_v2(uuid,jsonb,numeric,text,text,text,bigint,numeric,timestamptz,text)','EXECUTE') AS anon_adjust`);
    expect(rows).toEqual([{anon_basis:false,auth_matches:false,auth_sync:false,auth_adjust:true,anon_adjust:false}]);
  });
});
