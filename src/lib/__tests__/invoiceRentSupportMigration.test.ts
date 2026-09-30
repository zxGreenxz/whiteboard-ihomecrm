import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, expect, it } from 'vitest';

// Auth helpers are fixture doubles. Actual JWT/connection proofs run on guarded TEST.
const db = new PGlite();
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const org = uid(1), actor = uid(2), building = uid(3), room = uid(4), contract = uid(5);
const plan = { version: 2, start_billing_month: '2026-09', payer: 'BUILDING', sale_party_id: null,
  deduction_policy: 'COMMISSION_ONLY', collection_mode: 'UPFRONT_COMMITTED',
  segments: [{ month_count: 3, monthly_amount: '300000' }, { month_count: 9, monthly_amount: '100000' }] };
const item = (amount = 1_000_000, accounting_class = 'REVENUE') => ({ type: 'RENT', amount, unit_price: amount, quantity: 1, coefficient: 1, accounting_class });
async function quote(month: string, revenue = 1_000_000, kind = 'MONTHLY', manual = '0', credit = '0', revision = 1) {
  return (await db.query<{ result: Record<string, unknown> }>('SELECT app_private.invoice_rent_support_quote_v1($1,$2,$3,$4,$5,$6,$7,$8) result',
    [org, contract, month, kind, JSON.stringify([item(revenue), item(4_000_000, 'DEPOSIT')]), manual, credit, revision])).rows[0].result;
}
async function invoice(id: string, month: string, kind = 'MONTHLY', revenue = 1_000_000, support = 300_000) {
  await db.query('INSERT INTO public.invoices(id,organization_id,contract_id,building_id,billing_month,kind,status,subtotal,discount_amount,total_amount,invoice_support_amount,manual_discount_amount,credit_discount_amount,rent_support_plan_revision,rent_support_request_id) VALUES($1,$2,$3,$4,$5,$6,\'DRAFT\',$7,$8,$7::numeric-$8::numeric,$8,0,0,1,$1)', [id, org, contract, building, month, kind, revenue, support]);
  await db.exec(`DO $$ BEGIN PERFORM app_private.invoice_rent_support_items_open_v1('${id}');
    INSERT INTO public.invoice_items(invoice_id,organization_id,accounting_class,amount) VALUES('${id}','${org}','REVENUE',${revenue});
    PERFORM app_private.invoice_rent_support_items_close_v1('${id}'); END $$`);
}
async function claim(id: string, month: string, revision = 1) {
  return (await db.query<{ result: Record<string, unknown> }>('SELECT app_private.resolve_invoice_rent_support_v1($1,$2,$3,$4,$5,$6,$7) result',
    [org, contract, id, month, JSON.stringify([{ billing_month: month }]), revision, id])).rows[0].result;
}
beforeAll(async () => {
  await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role; CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '${actor}'::uuid $$;
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT ARRAY['${org}'::uuid] $$;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT '{}'::uuid[] $$;
    CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT $1='${building}'::uuid $$;
    CREATE FUNCTION app_private.authorized_scope_v3(text,uuid) RETURNS TABLE(org_wide boolean,building_ids uuid[],cashbook_ids uuid[]) LANGUAGE sql STABLE AS $$ SELECT false, CASE WHEN current_setting('test.deny',true)='yes' AND $1 LIKE 'invoices.%' THEN '{}'::uuid[] ELSE ARRAY['${building}'::uuid] END, '{}'::uuid[] $$;
    CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
    CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean) LANGUAGE sql STABLE AS $$ SELECT $2='${org}'::uuid AND $4='${building}'::uuid AND current_setting('test.deny',true) IS DISTINCT FROM 'yes' $$;
    CREATE TABLE public.rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,deleted_at timestamptz);
    INSERT INTO public.rooms VALUES('${room}','${org}','${building}',NULL);
    CREATE TABLE public.contracts(id uuid PRIMARY KEY,organization_id uuid,room_id uuid,start_date date,end_date date,discounts jsonb,deleted_at timestamptz,UNIQUE(organization_id,id));
    INSERT INTO public.contracts VALUES('${contract}','${org}','${room}','2026-09-01','2027-09-01','{"version":2}',NULL);
    ALTER TABLE public.contracts ADD COLUMN payment_cycle text DEFAULT 'MONTHLY';
    CREATE TABLE public.contract_drafts(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,payload jsonb,revision integer);
    CREATE TABLE public.invoices(id uuid PRIMARY KEY,organization_id uuid,contract_id uuid,building_id uuid,billing_month text,kind text,status text,deleted_at timestamptz,adjustment_revision bigint DEFAULT 0,subtotal numeric,discount_amount numeric,total_amount numeric,paid_amount numeric DEFAULT 0,UNIQUE(organization_id,id));
    CREATE TABLE public.invoice_items(id uuid DEFAULT gen_random_uuid(),invoice_id uuid,organization_id uuid,accounting_class text,amount numeric);
  `);
  await db.exec(readFileSync('supabase/migrations/20260929151043_contract_rent_support_plans.sql', 'utf8'));
  const filename = readdirSync('supabase/migrations').find(value => value.endsWith('_invoice_rent_support_claims.sql'));
  if (filename) {
    const sql = readFileSync(`supabase/migrations/${filename}`, 'utf8').split('-- Replacing signatures')[0];
    await db.exec(sql); await db.exec(sql);
  }
  await db.query('SELECT app_private.persist_contract_rent_support_v1($1,$2,$3)', [org, contract, JSON.stringify(plan)]);
  await db.exec('CREATE OR REPLACE FUNCTION app_private.rent_support_writers_enabled_v1() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$');
}, 30000);
afterAll(async () => { await db.close(); });

it('selects November before October and December independently of invoice count', async () => {
  expect(await quote('2026-11')).toMatchObject({ invoice_support: '300000', state: 'READY' });
  expect(await quote('2026-10')).toMatchObject({ invoice_support: '300000', state: 'READY' });
  expect(await quote('2026-12')).toMatchObject({ invoice_support: '100000', state: 'READY' });
});
it.each(['MONTHLY', 'QUARTERLY', 'SEMI_ANNUAL', 'ANNUAL'])('one canonical month receives one amount for payment cycle %s', async (cycle) => {
  await db.query('UPDATE public.contracts SET payment_cycle=$1 WHERE id=$2', [cycle, contract]);
  expect(await quote('2026-10')).toMatchObject({ invoice_support: '300000' });
});
it('does not consume a support month for SETTLEMENT', async () => {
  expect(await quote('2026-10', 1_000_000, 'SETTLEMENT')).toMatchObject({ invoice_support: '0', state: 'READY' });
});
it('keeps the full commitment under revenue cap review and excludes deposits', async () => {
  expect(await quote('2026-09', 200_000)).toMatchObject({ invoice_support: '0', agreed_amount: '300000', state: 'NEEDS_REVIEW', issue: 'REVENUE_CAP_REVIEW' });
  expect(await quote('2026-09', 400_000, 'MONTHLY', '50000', '100000')).toMatchObject({ state: 'NEEDS_REVIEW', issue: 'REVENUE_CAP_REVIEW' });
});
it('rejects stale revision and invalid scope', async () => {
  await expect(quote('2026-10', 1_000_000, 'MONTHLY', '0', '0', 99)).rejects.toMatchObject({ code: 'PT409' });
  await db.exec("SELECT set_config('test.deny','yes',false)");
  try { await expect(quote('2026-10')).rejects.toMatchObject({ code: '42501' }); }
  finally { await db.exec("SELECT set_config('test.deny','',false)"); }
});
it('claims once and replays the same identity without duplicate event', async () => {
  await invoice(uid(20), '2026-11');
  const result = await claim(uid(20), '2026-11');
  expect(result).toMatchObject({ invoice_support: '300000' });
  expect(await claim(uid(20), '2026-11')).toEqual(result);
  expect((await db.query('SELECT * FROM app_private.rent_support_invoice_claims WHERE released_at IS NULL')).rows).toHaveLength(1);
  expect((await db.query('SELECT * FROM app_private.rent_support_invoice_events')).rows).toHaveLength(1);
});
it('independently rejects a second claim across plan revisions, without invoice unique index', async () => {
  // This fixture deliberately has no MONTHLY unique index: the claim must defend itself.
  await db.exec(`INSERT INTO app_private.contract_rent_support_plans(organization_id,contract_id,revision,payload,committed_total,payer,sale_party_id,deduction_policy,state,customer_hash,created_by)
    SELECT organization_id,contract_id,2,payload,committed_total,payer,sale_party_id,deduction_policy,state,customer_hash,created_by FROM app_private.contract_rent_support_plans WHERE revision=1;
    INSERT INTO app_private.contract_rent_support_months(organization_id,contract_id,plan_id,billing_month,agreed_amount)
    SELECT m.organization_id,m.contract_id,p.id,m.billing_month,m.agreed_amount FROM app_private.contract_rent_support_months m JOIN app_private.contract_rent_support_plans p ON p.revision=2 WHERE m.plan_id=(SELECT id FROM app_private.contract_rent_support_plans WHERE revision=1);`);
  await invoice(uid(21), '2026-11');
  await db.query('UPDATE public.invoices SET rent_support_plan_revision=2 WHERE id=$1', [uid(21)]);
  await expect(claim(uid(21), '2026-11', 2)).rejects.toMatchObject({ code: 'PT409' });
  expect((await db.query('SELECT * FROM app_private.rent_support_invoice_claims WHERE released_at IS NULL')).rows).toHaveLength(1);
});
it('rolls back invoice and claim when the transaction fails after claiming', async () => {
  await db.exec('BEGIN');
  try {
    await invoice(uid(22), '2026-10');
    await db.query('UPDATE public.invoices SET rent_support_plan_revision=2 WHERE id=$1', [uid(22)]);
    await claim(uid(22), '2026-10', 2);
    await expect(db.exec('SELECT 1/0')).rejects.toMatchObject({ code: '22012' });
  } finally { await db.exec('ROLLBACK'); }
  expect((await db.query('SELECT id FROM public.invoices WHERE id=$1', [uid(22)])).rows).toHaveLength(0);
  expect((await db.query('SELECT * FROM app_private.rent_support_invoice_claims WHERE invoice_id=$1', [uid(22)])).rows).toHaveLength(0);
});
it('rejects client subperiods that do not match the canonical invoice month', async () => {
  await expect(db.query('SELECT app_private.resolve_invoice_rent_support_v1($1,$2,$3,$4,$5,$6,$7)',
    [org, contract, uid(20), '2026-11', JSON.stringify([{ billing_month: '2026-10' }, { billing_month: '2026-11' }]), 2, uid(24)])).rejects.toMatchObject({ code: '22023' });
});
it('cancel releases once, replacement claims the month, and restore conflicts', async () => {
  await db.query("UPDATE public.invoices SET status='CANCELLED' WHERE id=$1", [uid(20)]);
  await db.query("UPDATE public.invoices SET status='CANCELLED' WHERE id=$1", [uid(20)]);
  expect((await db.query("SELECT * FROM app_private.rent_support_invoice_events WHERE action='RELEASED'")).rows).toHaveLength(1);
  await claim(uid(21), '2026-11', 2);
  // Production enforces the live MONTHLY invoice index before AFTER triggers.
  // Conflict translation must therefore occur before index enforcement.
  await db.exec("CREATE UNIQUE INDEX fixture_live_monthly ON public.invoices(contract_id,billing_month) WHERE kind='MONTHLY' AND deleted_at IS NULL AND status<>'CANCELLED'");
  await expect(db.query("UPDATE public.invoices SET status='APPROVED' WHERE id=$1", [uid(20)])).rejects.toMatchObject({ code: 'PT409' });
  expect((await db.query('SELECT * FROM app_private.rent_support_invoice_claims WHERE released_at IS NULL')).rows).toHaveLength(1);
});
it('rejects malformed context and a manual discount that silently hides support', async () => {
  const context = { version: 1, expected_plan_revision: 2, manual_discount_amount: '0', request_id: uid(30) };
  for (const invalid of [{ ...context, unknown: 1 }, { ...context, manual_discount_amount: 300000 }, { ...context, expected_plan_revision: 0 }]) {
    await expect(db.query('SELECT app_private.invoice_rent_support_context_v1($1)', [JSON.stringify(invalid)])).rejects.toMatchObject({ code: '22023' });
  }
  await expect(db.query('SELECT app_private.invoice_rent_support_before_v1($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [org, contract, '2026-10', 'MONTHLY', JSON.stringify([item()]), 0, 0, JSON.stringify(context), uid(30)])).rejects.toMatchObject({ code: '22023' });
});
it('direct DML cannot forge or erase support even when contract rows are hidden by RLS', async () => {
  await db.exec('GRANT SELECT,INSERT,UPDATE ON public.invoices TO authenticated; GRANT SELECT ON public.contracts TO authenticated; ALTER TABLE public.contracts ENABLE ROW LEVEL SECURITY; SET ROLE authenticated');
  try {
    await expect(db.query("INSERT INTO public.invoices(id,organization_id,contract_id,building_id,billing_month,kind,status,subtotal,discount_amount,total_amount) VALUES($1,$2,$3,$4,'2026-10','MONTHLY','DRAFT',1000000,0,1000000)", [uid(31), org, contract, building])).rejects.toMatchObject({ code: '42501' });
    await expect(db.query('UPDATE public.invoices SET rent_support_plan_revision=NULL,invoice_support_amount=0,manual_discount_amount=discount_amount WHERE id=$1', [uid(21)])).rejects.toMatchObject({ code: '42501' });
    await expect(invoice(uid(32), '2026-10')).rejects.toMatchObject({ code: '42501' });
  } finally { await db.exec('RESET ROLE'); }
});
it('denies direct item insert/update/delete on a draft support invoice', async () => {
  await db.exec('GRANT SELECT,INSERT,UPDATE,DELETE ON public.invoice_items TO authenticated; SET ROLE authenticated');
  try {
    await expect(db.query('UPDATE public.invoice_items SET amount=1 WHERE invoice_id=$1', [uid(21)])).rejects.toMatchObject({ code: '42501' });
    await expect(db.query('DELETE FROM public.invoice_items WHERE invoice_id=$1', [uid(21)])).rejects.toMatchObject({ code: '42501' });
    await expect(db.query("INSERT INTO public.invoice_items(invoice_id,organization_id,accounting_class,amount) VALUES($1,$2,'REVENUE',1)", [uid(21), org])).rejects.toMatchObject({ code: '42501' });
  } finally { await db.exec('RESET ROLE'); }
});
it('expires item capability on commit and rolls it back with its transaction', async () => {
  for (const ending of ['COMMIT', 'ROLLBACK']) {
    await db.exec('BEGIN');
    await db.query('SELECT app_private.invoice_rent_support_items_open_v1($1)', [uid(21)]);
    expect((await db.query('SELECT * FROM app_private.invoice_rent_support_item_capabilities')).rows).toHaveLength(1);
    await db.exec(ending);
    expect((await db.query('SELECT * FROM app_private.invoice_rent_support_item_capabilities')).rows).toHaveLength(0);
  }
});
it('checks private parent despite invoice RLS hiding the v2 invoice', async () => {
  await db.exec('ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY; SET ROLE authenticated');
  try {
    expect((await db.query('SELECT * FROM public.invoices')).rows).toHaveLength(0);
    await expect(db.query("INSERT INTO public.invoice_items(invoice_id,organization_id,accounting_class,amount) VALUES($1,$2,'REVENUE',1)", [uid(21), org])).rejects.toMatchObject({ code: '42501' });
  } finally { await db.exec('RESET ROLE'); }
});

// Removing the live-claim replay check makes this resolve READY after release.
it('rejects replay of a released claim identity and rolls the release back', async () => {
  const id = uid(50);
  await invoice(id, '2027-04', 'MONTHLY', 1_000_000, 100_000);
  await db.query('UPDATE public.invoices SET rent_support_plan_revision=2 WHERE id=$1', [id]);
  await claim(id, '2027-04', 2);
  await db.exec('BEGIN');
  try {
    await db.query('SELECT app_private.invoice_rent_support_release_v1($1,$2)', [id, 'Canonical draft invoice update']);
    await expect(claim(id, '2027-04', 2)).rejects.toMatchObject({ code: 'PT409' });
  } finally { await db.exec('ROLLBACK'); }
  expect((await db.query('SELECT * FROM app_private.rent_support_invoice_claims WHERE invoice_id=$1 AND released_at IS NULL', [id])).rows).toHaveLength(1);
  expect((await db.query("SELECT * FROM app_private.rent_support_invoice_events WHERE invoice_id=$1 AND action='RELEASED'", [id])).rows).toHaveLength(0);
});
it('rejects an old released identity after restore creates a new live claim', async () => {
  const id = uid(51);
  await invoice(id, '2027-05', 'MONTHLY', 1_000_000, 100_000);
  await db.query('UPDATE public.invoices SET rent_support_plan_revision=2 WHERE id=$1', [id]);
  await claim(id, '2027-05', 2);
  await db.query("UPDATE public.invoices SET status='CANCELLED' WHERE id=$1", [id]);
  await db.query("UPDATE public.invoices SET status='DRAFT' WHERE id=$1", [id]);
  await expect(claim(id, '2027-05', 2)).rejects.toMatchObject({ code: 'PT409' });
  expect((await db.query('SELECT claimed_amount::text amount FROM app_private.rent_support_invoice_claims WHERE invoice_id=$1 AND released_at IS NULL', [id])).rows).toEqual([{ amount: '100000' }]);
});
