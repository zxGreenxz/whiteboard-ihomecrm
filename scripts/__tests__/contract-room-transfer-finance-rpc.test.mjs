import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { id, org, actor, building, oldRoom, newRoom, contract, request, notice, snapshot, reason,
  installRoomTransferAuthorization, installRoomTransferFixture, installStatements, migration } from '../lib/room-transfer-test-fixture.mjs';

const db = new PGlite();
const day = '2026-02-15';
const invoice = id(11);
const rentItem = id(12);
const initialRent = 2_800_000;
const nextRent = 5_600_000;
const held = 800_000;
const required = 1_000_000;
const nextDeposit = 2_000_000;

// Install the real pricing, transfer, commission, receipt, refund, adjustment builder and deferred
// invoice trigger. The two invoice write RPCs below are narrow doubles for the separate billing
// system. They check the scope, persist its supplied line amounts, and expose which writer ran.
beforeAll(async () => {
  await installRoomTransferFixture(db);
  await db.exec(`
    ALTER TABLE contracts ADD COLUMN total_deposit numeric DEFAULT ${required}, ADD COLUMN deposit_paid numeric DEFAULT ${held},
      ADD COLUMN start_billing_date date, ADD COLUMN end_billing_date date,
      ADD COLUMN deposit_debt_mode text, ADD COLUMN deposit_debt_reason text;
    ALTER TABLE buildings ADD COLUMN deleted_at timestamptz;
    ALTER TABLE rooms ADD COLUMN deposit_amount numeric;
    ALTER TABLE contracts DISABLE TRIGGER z98_commission_basis;
    UPDATE contracts SET rent_price=${initialRent};
    ALTER TABLE contracts ENABLE TRIGGER z98_commission_basis;
    UPDATE rooms SET deposit_amount=${nextDeposit} WHERE id='${newRoom}';
    INSERT INTO grants_by_building VALUES ('${building}','invoices.edit'),('${building}','invoices.record_payment'),
      ('${building}','invoices.create'), ('${building}','invoices.view');
    CREATE TABLE invoices(id uuid PRIMARY KEY, organization_id uuid, contract_id uuid, building_id uuid, room_id uuid,
      billing_month text, invoice_number text, kind text DEFAULT 'MONTHLY', status text, subtotal numeric,
      total_amount numeric, paid_amount numeric DEFAULT 0, discount_amount numeric DEFAULT 0, previous_debt numeric DEFAULT 0,
      prepaid_amount numeric DEFAULT 0, previous_debt_sources jsonb DEFAULT '[]', discount_notes text, notes text,
      template_id uuid, electricity_prev_overridden boolean, issue_date date, due_date date, adjustment_revision bigint DEFAULT 0,
      adjustment_review_status text DEFAULT 'NONE', updated_at timestamptz DEFAULT now(), deleted_at timestamptz,
      rent_support_plan_revision bigint, manual_discount_amount numeric, credit_discount_amount numeric, invoice_support_amount numeric);
    CREATE TABLE invoice_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid, type text, accounting_class text,
      amount numeric, unit_price numeric, quantity numeric DEFAULT 1, coefficient numeric DEFAULT 1, sort_order int DEFAULT 0,
      description text, from_date date, to_date date, previous_reading numeric, current_reading numeric, service_id uuid);
    CREATE TABLE income_expenses(id uuid PRIMARY KEY, invoice_id uuid, type text, approval_status text, deleted_at timestamptz,
      payment_collection_id uuid, payment_id uuid, notes text, user_id uuid, name text, building_id uuid, voucher_date date,
      total_amount numeric, organization_id uuid, account_id uuid, system_source text, posting_mode text, posting_status text,
      review_state text, review_version int, approval_version int, posting_version int, maker_user_id uuid, maker_membership_id uuid,
      birth_operation_id uuid, birth_txid xid8, source_payload_hash text, counts_in_business_result boolean, kqkd_amount numeric,
      recognition_date date, recognition_source_mode text, business_result_accounting boolean);
    CREATE TABLE income_expense_items(income_expense_id uuid, amount numeric, quantity numeric, unit_price numeric, accounting_class text);
    CREATE TABLE payments(id uuid, reversed_at timestamptz);
    CREATE TABLE invoice_payment_collections(id uuid, status text);
    CREATE TABLE app_private.invoice_refund_reservations(id uuid PRIMARY KEY, organization_id uuid, invoice_id uuid,
      refund_voucher_id uuid REFERENCES income_expenses, amount numeric, refund_class text, reservation_state text, state_version int,
      idempotency_key text, source_payload_hash text, created_by_user_id uuid, created_at timestamptz, UNIQUE(organization_id,idempotency_key));
    CREATE TABLE app_private.income_expense_flow_ownership(income_expense_id uuid, organization_id uuid, flow_kind text,
      flow_version int, lifecycle_owner text, lifecycle_state text, writer_operation text, payload_hash_scheme text,
      payload_hash_value text, maker_user_id uuid, claimed_by_user_id uuid, correlation_id uuid);
    CREATE FUNCTION app_private.ie_compat_actor_v2(uuid) RETURNS TABLE(user_id uuid,membership_id uuid)
      LANGUAGE sql AS $$ SELECT auth.uid(),'${id(15)}'::uuid $$;
    CREATE TABLE invoice_writes(writer text, invoice_id uuid, total numeric);
    CREATE TABLE app_private.contract_rent_support_plans(organization_id uuid,contract_id uuid,state text);
    CREATE FUNCTION app_private.invoice_rent_support_quote_v1(uuid,uuid,text,text,jsonb,numeric,numeric,bigint)
    RETURNS jsonb LANGUAGE sql AS $$
      SELECT jsonb_build_object('invoice_support',inv.invoice_support_amount,'state',
        CASE WHEN inv.invoice_support_amount+$6+$7<=(SELECT coalesce(sum((it->>'amount')::numeric),0)
          FROM jsonb_array_elements($5) it WHERE it->>'accounting_class'='REVENUE') THEN 'READY' ELSE 'NEEDS_REVIEW' END)
      FROM public.invoices inv WHERE inv.organization_id=$1 AND inv.contract_id=$2 AND inv.billing_month=$3
    $$;
    CREATE FUNCTION fixture_write_items(writer text,bill uuid,items jsonb) RETURNS numeric LANGUAGE plpgsql AS $$
    DECLARE item jsonb; n numeric; subtotal_new numeric:=0;
    BEGIN
      PERFORM app_private.require_building_perm_v1((SELECT building_id FROM public.invoices WHERE id=bill),
        'sửa hóa đơn','invoices.edit');
      DELETE FROM public.invoice_items WHERE invoice_id=bill;
      FOR item IN SELECT value FROM jsonb_array_elements(items) LOOP
        n:=(item->>'unit_price')::numeric*(item->>'quantity')::numeric*(item->>'coefficient')::numeric;
        INSERT INTO public.invoice_items(id,invoice_id,type,accounting_class,amount,unit_price,quantity,coefficient,sort_order,
          description,from_date,to_date) VALUES(coalesce((item->>'id')::uuid,gen_random_uuid()),bill,item->>'type',
          item->>'accounting_class',n,(item->>'unit_price')::numeric,(item->>'quantity')::numeric,(item->>'coefficient')::numeric,
          (item->>'sort_order')::int,item->>'description',(item->>'from_date')::date,(item->>'to_date')::date);
        subtotal_new:=subtotal_new+n;
      END LOOP;
      UPDATE public.invoices SET subtotal=subtotal_new,total_amount=app_private.round_invoice_total_v1(subtotal_new-discount_amount+previous_debt),
        adjustment_revision=adjustment_revision+1 WHERE id=bill;
      INSERT INTO public.invoice_writes VALUES(writer,bill,subtotal_new);
      RETURN subtotal_new;
    END $$;
    CREATE FUNCTION public.update_invoice_v1(p_invoice_id uuid,p_contract_id uuid,p_building_id uuid,p_room_id uuid,p_billing_month text,
      p_issue_date date,p_due_date date,p_subtotal numeric,p_discount_amount numeric,p_total_amount numeric,p_previous_debt numeric,
      p_items jsonb,p_prepaid_amount numeric,p_discount_notes text,p_electricity_prev_overridden boolean,p_previous_debt_sources jsonb,
      p_template_id uuid,p_notes text,p_rent_support_context jsonb DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      IF (SELECT rent_support_plan_revision FROM public.invoices WHERE id=p_invoice_id) IS NOT NULL THEN
        PERFORM app_private.invoice_rent_support_context_v1(p_rent_support_context);
        IF NOT EXISTS (SELECT 1 FROM public.invoices WHERE id=p_invoice_id
          AND rent_support_plan_revision=(p_rent_support_context->>'expected_plan_revision')::bigint
          AND manual_discount_amount=(p_rent_support_context->>'manual_discount_amount')::numeric) THEN
          RAISE EXCEPTION 'wrong support snapshot'; END IF;
      END IF;
      IF public.fixture_write_items('draft',p_invoice_id,p_items) IS DISTINCT FROM p_subtotal OR
        p_total_amount IS DISTINCT FROM app_private.round_invoice_total_v1(p_subtotal-p_discount_amount+p_previous_debt)
        THEN RAISE EXCEPTION 'draft header mismatch'; END IF;
    END $$;
    CREATE FUNCTION public.adjust_invoice_v2(bill uuid,items jsonb,discount numeric,discount_note text,note text,reason text,
      revision bigint,paid numeric,version timestamptz,key text) RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS(SELECT FROM public.invoices WHERE id=bill AND adjustment_revision=revision AND paid_amount=paid
        AND updated_at=version) THEN RAISE EXCEPTION 'invalid invoice snapshot'; END IF;
      PERFORM public.fixture_write_items('issued',bill,items);
    END $$;
  `);
  await installStatements(db,'20260930065906_invoice_rent_support_claims',[
    'CREATE OR REPLACE FUNCTION app_private.invoice_rent_support_context_v1(',
  ]);
  await installStatements(db,'20260731070000_current_date_to_org_today',[
    'CREATE OR REPLACE FUNCTION app_private.reserve_invoice_refund_obligation_v2(',
    'CREATE OR REPLACE FUNCTION public.generate_invoices_for_building(',
  ]);
  await installStatements(db,'20261021181209_invoice_cancel_refund_permission_guard_v1',[
    'CREATE OR REPLACE FUNCTION public.create_invoice_refund_obligation_v2(',
  ]);
  await installStatements(db,'20261023042242_invoice_adjustment_build_v1',[
    'CREATE OR REPLACE FUNCTION public.invoice_adjustment_build_v1(',
  ]);
  const baseline = readFileSync('supabase/baseline/schema.sql', 'utf8');
  await installRoomTransferAuthorization(db, baseline);
  const rounding = baseline.match(/^CREATE FUNCTION app_private\.round_invoice_total_v1\([\s\S]*?^\$\$;/m);
  expect(rounding, 'production invoice rounding').not.toBeNull();
  await db.exec(rounding[0]);
  for (const name of ['20261120093546_chuyen_phong_tien_coc','20261120093620_tien_thue_ky_chuyen_phong',
    '20261120093840_quyet_toan_khi_chuyen_phong','20261120094154_tien_phong_ky_chuyen_khi_lap_hoa_don',
    '20261120105505_xem_truoc_chuyen_phong_khoa_quyen']) {
    await db.exec(migration(name));
  }
}, 30000);

beforeEach(() => db.exec('BEGIN'));
afterEach(() => db.exec('ROLLBACK'));
afterAll(() => db.close());

async function row(sql, params = []) {
  return (await db.query(sql, params)).rows[0];
}
async function preview({ price=nextRent, deposit=null } = {}) {
  return (await row('SELECT public.preview_room_transfer_v1($1,$2,$3,$4,$5,$6) AS quote', [org,contract,newRoom,day,price,deposit])).quote;
}

it('previews as authenticated with the transaction mode PostgREST selects for this POST RPC', async () => {
  const { provolatile } = await row(`SELECT provolatile FROM pg_proc
    WHERE oid='public.preview_room_transfer_v1(uuid,uuid,uuid,date,numeric,numeric)'::regprocedure`);
  // PostgreSQL must refuse the authority's row lock in the mode used for a STABLE RPC.
  await db.exec('ROLLBACK; BEGIN READ ONLY; SET LOCAL ROLE authenticated');
  await rejects(preview,'25006');
  const mode = provolatile === 'v' ? 'READ WRITE' : 'READ ONLY';
  await db.exec(`ROLLBACK; BEGIN ${mode}; SET LOCAL ROLE authenticated`);
  await expect(preview()).resolves.toMatchObject({period_rent:4_200_000,deposit_shortfall:1_200_000});
  expect(provolatile).toBe('v');
  await db.exec('RESET ROLE');
  expect(await state()).toMatchObject({room_id:oldRoom,transfers:0,receipts:0,rents:0});
});
async function move(quote, { price=nextRent, deposit=null } = {}) {
  return (await row('SELECT public.transfer_room_with_notice_v2($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10) AS id',
    [org,contract,snapshot,newRoom,day,request,price,reason,deposit,quote.quote_key])).id;
}
async function rejects(run, code) {
  await db.exec('SAVEPOINT attempt');
  await expect(run()).rejects.toMatchObject({ code });
  await db.exec('ROLLBACK TO SAVEPOINT attempt; RELEASE SAVEPOINT attempt');
}
async function seedInvoice({ status='APPROVED', paid=0, rent=initialRent, service=0 } = {}) {
  await db.query(`INSERT INTO invoices(id,organization_id,contract_id,building_id,room_id,billing_month,status,subtotal,total_amount,paid_amount)
    VALUES ($1,$2,$3,$4,(SELECT room_id FROM contracts WHERE id=$3),'2026-02',$5,$6,$6,$7)`,
    [invoice,org,contract,building,status,rent+service,paid]);
  await db.query(`INSERT INTO invoice_items(id,invoice_id,type,accounting_class,amount,unit_price,description)
    VALUES ($1,$2,'RENT','REVENUE',$3,$3,'Tiền thuê')`,[rentItem,invoice,rent]);
  if (service) await db.query(`INSERT INTO invoice_items(invoice_id,type,accounting_class,amount,unit_price,description,sort_order)
    VALUES ($1,'SERVICE','REVENUE',$2,$2,'Dịch vụ',1)`,[invoice,service]);
  await db.exec('SET CONSTRAINTS room_transfer_check_new_invoice IMMEDIATE; SET CONSTRAINTS room_transfer_check_new_invoice DEFERRED');
}
async function state() {
  return row(`SELECT room_id, rent_price::int, total_deposit::int, deposit_paid::int, expected_move_out_date::text,
    (SELECT count(*) FROM contract_notice_transition_events) AS receipts,
    (SELECT count(*) FROM app_private.room_transfer_rent_events) AS rents,
    (SELECT count(*) FROM contract_transfers) AS transfers,
    (SELECT count(*) FROM app_private.commission_intervention_events) AS commissions,
    (SELECT count(*) FROM income_expenses) AS vouchers,
    (SELECT count(*) FROM invoice_writes) AS writes,
    (SELECT count(*) FROM app_private.invoice_refund_reservations) AS refunds,
    (SELECT array_agg(status ORDER BY id) FROM rooms WHERE id IN ($2,$3)) AS rooms
    FROM contracts WHERE id=$1`,[contract,oldRoom,newRoom]);
}
async function bill() {
  return row(`SELECT i.subtotal::int, i.total_amount::int, i.paid_amount::int, i.adjustment_revision::int,
    (SELECT sum(amount)::int FROM invoice_items WHERE invoice_id=i.id AND type='RENT') AS rent,
    (SELECT sum(amount)::int FROM invoice_items WHERE invoice_id=i.id AND type='SERVICE') AS service FROM invoices i WHERE id=$1`,[invoice]);
}

it('previews the unbilled period and room deposit, moves once, and rejects modified deposit on replay', async () => {
  const quote=await preview();
  expect(quote).toMatchObject({ period_start:'2026-02-01',period_end:'2026-02-28',old_days:14,new_days:14,
    period_rent:4_200_000,billed_rent:0,rent_delta:4_200_000,invoice_id:null,required_deposit:nextDeposit,
    held_deposit:held,deposit_shortfall:1_200_000,deposit_surplus:0 });
  expect(await move(quote)).toBe(contract);
  expect(await move(quote)).toBe(contract);
  await rejects(() => move(quote,{deposit:nextDeposit+1}), '23505');
  expect(await state()).toMatchObject({room_id:newRoom,rent_price:nextRent,total_deposit:nextDeposit,deposit_paid:held,
    expected_move_out_date:null,transfers:1,commissions:1,receipts:1,rents:1,vouchers:0,refunds:0,writes:0,
    rooms:['AVAILABLE','OCCUPIED']});
  expect(await bill()).toBeUndefined();
  const prices=await row('SELECT public.room_transfer_invoice_rents_v1($1,$2) AS prices',[building,'2026-02']);
  expect(prices.prices).toEqual({[contract]:4_200_000});
  await rejects(() => seedInvoice({rent:nextRent}), 'PT409');
  await seedInvoice({rent:4_200_000});
  expect(await bill()).toMatchObject({rent:4_200_000,paid_amount:0});
});

it('accepts an explicit zero deposit and preserves the full cash surplus',async () => {
  const choice={deposit:0};
  const quote=await preview(choice);
  expect(quote).toMatchObject({required_deposit:0,deposit_surplus:held,deposit_shortfall:0});
  await move(quote,choice);
  expect(await state()).toMatchObject({total_deposit:0,deposit_paid:held,vouchers:0,refunds:0});
});

it.each(['contracts.edit','contracts.transfer'])('enforces %s on preview and submit before returning any result',async permission => {
  const quote=await preview();
  const before=await state();
  await db.query('DELETE FROM grants_by_building WHERE building_id=$1 AND permission=$2',[building,permission]);
  await rejects(() => preview(),'42501');
  await rejects(() => move(quote),'42501');
  expect(await state()).toEqual(before);
});

it('requires invoice view before showing or applying an existing bill',async () => {
  await seedInvoice({status:'PAID',paid:initialRent});
  const quote=await preview();
  await db.query("DELETE FROM grants_by_building WHERE building_id=$1 AND permission='invoices.view'",[building]);
  await rejects(() => preview(),'42501');
  await rejects(() => move(quote),'42501');
  expect(await state()).toMatchObject({receipts:0,rents:0,refunds:0,writes:0});
});

it('keeps the revised invoice above the amount already paid when the receipt is between thousands',async () => {
  await seedInvoice({status:'PARTIAL_PAID',paid:1_500_500});
  const choice={price:0};
  const quote=await preview(choice);
  expect(quote).toMatchObject({period_rent:1_400_000,invoice_total_after:1_501_000,remaining_after:500,refund_pending:101_000});
  await move(quote,choice);
  expect(await bill()).toMatchObject({total_amount:1_501_000,paid_amount:1_500_500});
  expect(await row('SELECT amount::int FROM app_private.invoice_refund_reservations')).toEqual({amount:101_000});
});

it('preserves all three existing draft discounts and validates the explicit support context',async () => {
  await seedInvoice({status:'DRAFT'});
  await db.query(`UPDATE invoices SET rent_support_plan_revision=2,invoice_support_amount=300000,
    manual_discount_amount=20000,credit_discount_amount=50000,discount_amount=370000,total_amount=subtotal-370000 WHERE id=$1`,[invoice]);
  const quote=await preview();
  expect(quote.invoice_total_after).toBe(3_830_000);
  await move(quote);
  await move(quote);
  expect(await bill()).toMatchObject({rent:4_200_000,total_amount:3_830_000});
  expect(await state()).toMatchObject({receipts:1,writes:1});
});

it('requires reconciliation if the new draft cannot cover the agreed support',async () => {
  await seedInvoice({status:'DRAFT',service:1_000_000});
  await db.query("UPDATE invoice_items SET accounting_class='NON_PNL' WHERE invoice_id=$1 AND type='SERVICE'",[invoice]);
  await db.query(`UPDATE invoices SET rent_support_plan_revision=2,invoice_support_amount=2000000,manual_discount_amount=0,
    credit_discount_amount=0,discount_amount=2000000,total_amount=subtotal-2000000 WHERE id=$1`,[invoice]);
  await rejects(() => preview({price:0}),'55000');
  expect(await state()).toMatchObject({receipts:0,writes:0});
});

it('requires reconciliation before adopting a later support plan on a legacy draft',async () => {
  await seedInvoice({status:'DRAFT'});
  await db.query("INSERT INTO app_private.contract_rent_support_plans VALUES($1,$2,'ACTIVE')",[org,contract]);
  await rejects(() => preview(),'55000');
  expect(await state()).toMatchObject({receipts:0,writes:0});
});

it.each(['payment','deposit'])('requires a fresh quote after another %s was recorded', async change => {
  await seedInvoice();
  const quote=await preview();
  if (change==='payment') await db.query('UPDATE invoices SET paid_amount=100000 WHERE id=$1',[invoice]);
  else await db.query('UPDATE contracts SET deposit_paid=900000 WHERE id=$1',[contract]);
  const before=await state();
  await rejects(() => move(quote),'PT409');
  expect(await state()).toEqual(before);
  const refreshed=await preview();
  expect(refreshed.quote_key).not.toBe(quote.quote_key);
  await move(refreshed);
  expect(await state()).toMatchObject({transfers:1,receipts:1});
});

it.each([['APPROVED','issued'],['DRAFT','draft']])('increases only the rent on a %s invoice',async (status,writer) => {
  await seedInvoice({status,service:100_000});
  const quote=await preview();
  expect(quote).toMatchObject({invoice_id:invoice,invoice_status:status,period_rent:4_200_000,billed_rent:initialRent,rent_delta:1_400_000});
  await move(quote);
  expect(await bill()).toMatchObject({rent:4_200_000,service:100_000,total_amount:4_300_000,paid_amount:0});
  expect(await row('SELECT writer FROM invoice_writes')).toEqual({writer});
  expect(await state()).toMatchObject({writes:1,refunds:0,vouchers:0,deposit_paid:held});
});

it.each([
  ['APPROVED',0,1_400_000,0],['PARTIAL_PAID',2_500_000,2_500_000,1_100_000],['PAID',2_800_000,2_800_000,1_400_000],
])('reduces outstanding rent and reserves only cash paid in excess for %s',async (status,paid,rentAfter,refund) => {
  await seedInvoice({status,paid});
  const choice={price:0};
  const quote=await preview(choice);
  expect(quote).toMatchObject({billed_rent:initialRent,rent_delta:-1_400_000,period_rent:1_400_000});
  await move(quote,choice);
  await move(quote,choice);
  expect(await bill()).toMatchObject({rent:rentAfter,total_amount:rentAfter,paid_amount:paid});
  expect(await state()).toMatchObject({refunds:refund?1:0,vouchers:refund?1:0,deposit_paid:held,rents:1});
  if (refund) {
    expect(await row(`SELECT r.amount::int,r.refund_class,r.reservation_state,v.type,v.approval_status,v.posting_status
      FROM app_private.room_transfer_rent_events e JOIN app_private.invoice_refund_reservations r ON r.id=e.refund_reservation_id
      JOIN income_expenses v ON v.id=r.refund_voucher_id`)).toEqual({amount:refund,refund_class:'REFUND_CONTRA_REVENUE',
      reservation_state:'HELD',type:'EXPENSE',approval_status:'UNAPPROVED',posting_status:'UNPOSTED'});
  }
});

it.each(['invoices.edit','invoices.record_payment'])('rolls back all transfer and invoice effects without %s',async permission => {
  await seedInvoice({status:'PARTIAL_PAID',paid:2_500_000});
  await db.query('DELETE FROM grants_by_building WHERE building_id=$1 AND permission=$2',[building,permission]);
  const choice={price:0};
  const quote=await preview(choice);
  const before=await state();
  const originalBill=await bill();
  await rejects(() => move(quote,choice),'42501');
  expect(await state()).toEqual(before);
  expect(await bill()).toEqual(originalBill);
});

it('undoes invoice, pending refund, deposits, transfer and commission if the last receipt insert fails',async () => {
  await seedInvoice({status:'PARTIAL_PAID',paid:2_500_000});
  await db.exec("ALTER TABLE contract_notice_transition_events ADD CHECK (operation<>'TRANSFER_ROOM')");
  const choice={price:0,deposit:0};
  const quote=await preview(choice);
  const originalBill=await bill();
  const before=await state();
  expect(before).toMatchObject({room_id:oldRoom,expected_move_out_date:notice});
  await rejects(() => move(quote,choice),'23514');
  expect(await bill()).toEqual(originalBill);
  expect(await state()).toEqual(before);
});
