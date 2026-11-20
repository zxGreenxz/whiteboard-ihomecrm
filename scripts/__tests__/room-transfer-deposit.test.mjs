import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';

const db = new PGlite();
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [org, contract, room, other, invoice, voucher] = Array.from({ length: 6 }, (_, i) => id(i + 1));
const helper = async (name, amount, dest = room) => (await db.query(
  `SELECT app_private.${name}_room_transfer_deposit_v1($1,$2,$3) AS quote`,
  [contract, dest, amount],
)).rows[0].quote;

beforeAll(async () => {
  await db.exec(`
    CREATE SCHEMA app_private;
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE contracts(id uuid PRIMARY KEY, organization_id uuid, room_id uuid, deleted_at timestamptz,
      total_deposit numeric(15,2), deposit_paid numeric(15,2),
      deposit_debt_mode text, deposit_debt_reason text, start_billing_date date, end_billing_date date,
      deposit_remaining numeric GENERATED ALWAYS AS (total_deposit - COALESCE(deposit_paid,0)) STORED);
    CREATE TABLE rooms(id uuid PRIMARY KEY, organization_id uuid, deleted_at timestamptz, deposit_amount numeric(15,2));
    CREATE TABLE invoices(id uuid PRIMARY KEY, organization_id uuid, contract_id uuid, status text, deleted_at timestamptz,
      total_amount numeric, paid_amount numeric, previous_debt_sources jsonb, kind text DEFAULT 'MONTHLY', billing_month text);
    CREATE TABLE app_private.canonical_write_operations(organization_id uuid,subject_id uuid,operation text,
      completed_at timestamptz,response_payload jsonb);
    CREATE FUNCTION public.compute_first_billing_month_v2(date,date) RETURNS text LANGUAGE sql AS $$SELECT to_char($1,'YYYY-MM')$$;
    CREATE TABLE invoice_items(invoice_id uuid, accounting_class text, amount numeric);
    CREATE TABLE income_expenses(id uuid, invoice_id uuid, type text, approval_status text, deleted_at timestamptz,
      payment_collection_id uuid, payment_id uuid);
    CREATE TABLE income_expense_items(income_expense_id uuid, accounting_class text, amount numeric, quantity numeric, unit_price numeric);
    CREATE TABLE payments(id uuid, reversed_at timestamptz);
    CREATE TABLE invoice_payment_collections(id uuid, status text);
    INSERT INTO contracts(id,organization_id,room_id,total_deposit,deposit_paid) VALUES ('${contract}','${org}','${room}',2000,1500);
    INSERT INTO rooms VALUES ('${room}','${org}',NULL,2500), ('${other}','${id(99)}',NULL,500);
  `);
  const migration = readFileSync('supabase/migrations/20261120093546_chuyen_phong_tien_coc.sql', 'utf8');
  await db.exec(migration);
  await db.exec(migration);
}, 30_000);

beforeEach(() => db.exec('BEGIN'));
afterEach(() => db.exec('ROLLBACK'));
afterAll(() => db.close());

it.each([
  [null, 2500, 1000, 0], [3000, 3000, 1500, 0], [1500, 1500, 0, 0], [1000, 1000, 0, 500], [0, 0, 0, 1500],
])('quotes and applies requirement %s without changing cash held', async (amount, required, shortfall, surplus) => {
  const expected = { required_deposit: required, held_deposit: 1500, deposit_shortfall: shortfall,
    deposit_surplus: surplus, deposit_invoiced_shortfall: 0, deposit_unbilled_shortfall: shortfall };
  expect(await helper('quote', amount)).toEqual(expected);
  expect(await helper('apply', amount)).toEqual(expected);
  expect(await helper('apply', amount)).toEqual(expected);
  expect((await db.query('SELECT total_deposit, deposit_paid, deposit_remaining FROM contracts')).rows[0])
    .toMatchObject({ total_deposit: required.toFixed(2), deposit_paid: '1500.00', deposit_remaining: (required - 1500).toFixed(2) });
  expect((await db.query('SELECT (SELECT count(*) FROM invoices) + (SELECT count(*) FROM income_expenses) AS created')).rows[0].created).toBe(0);
});
it('uses a zero room deposit and falls back only for a missing room deposit', async () => {
  await db.exec('UPDATE rooms SET deposit_amount = 0');
  expect((await helper('quote', null)).required_deposit).toBe(0);
  await db.exec('UPDATE rooms SET deposit_amount = NULL');
  expect((await helper('quote', null)).required_deposit).toBe(2000);
});
it.each(['-1', '0.001', '10000000000000', 'NaN', 'Infinity'])('rejects invalid deposit %s', async amount => {
  await expect(helper('quote', amount)).rejects.toMatchObject({ code: '22023' });
});
it('protects the wrong organization or an unapplied room move', async () => {
  await expect(helper('quote', null, other)).rejects.toMatchObject({ code: 'P0002' });
});
it('requires the transfer to have succeeded to apply the quote', async () => {
  await expect(helper('apply', null, other)).rejects.toMatchObject({ code: '55000' });
});
it('keeps private helpers uncallable by client and service roles', async () => {
  expect((await db.query(`SELECT bool_or(has_function_privilege(r, 'app_private.'||f||'_room_transfer_deposit_v1(uuid,uuid,numeric)', 'EXECUTE')) AS allowed
      FROM unnest(ARRAY['authenticated','anon','service_role']) r, unnest(ARRAY['apply','quote']) f`)).rows[0].allowed).toBe(false);
});

const openInvoice = async () => db.exec(`
  INSERT INTO invoices VALUES ('${invoice}','${org}','${contract}','PARTIAL_PAID',NULL,1000,200,'[{"type":"deposit","amount":100}]');
  INSERT INTO invoice_items VALUES ('${invoice}','DEPOSIT',300),('${invoice}','REVENUE',600);
  INSERT INTO income_expenses(id,invoice_id,type,approval_status) VALUES ('${voucher}','${invoice}','INCOME','APPROVED');
  INSERT INTO income_expense_items VALUES ('${voucher}','DEPOSIT',100,1,100);
`);
it('allows a reduction exactly to the remaining invoiced deposit and leaves its payments intact', async () => {
  await openInvoice();
  expect((await helper('apply', 1800)).deposit_shortfall).toBe(300);
  expect((await db.query('SELECT paid_amount FROM invoices')).rows[0].paid_amount).toBe('200');
  expect((await db.query('SELECT count(*) AS n FROM income_expenses')).rows[0].n).toBe(1);
});
it.each(['approve', 'pending', 'reversed', 'cancelled collection'])('refuses excess open invoice charges (%s coverage)', async mode => {
  await openInvoice();
  if (mode === 'pending') await db.exec("UPDATE income_expenses SET approval_status = 'PENDING'");
  if (mode === 'reversed') await db.exec(`INSERT INTO payments VALUES ('${id(33)}',now()); UPDATE income_expenses SET payment_id='${id(33)}'`);
  if (mode === 'cancelled collection') await db.exec(`INSERT INTO invoice_payment_collections VALUES ('${id(33)}','REVERSED'); UPDATE income_expenses SET payment_collection_id='${id(33)}'`);
  await expect(helper('apply', mode === 'approve' ? 1799 : 1800)).rejects.toMatchObject({ code: '55000' });
});
it.each(["status='CANCELLED'", 'deleted_at=now()', 'paid_amount=total_amount'])('ignores uncollectible old invoices (%s)', async update => {
  await openInvoice();
  await db.exec(`UPDATE invoices SET ${update}`);
  expect((await helper('apply', 0)).deposit_surplus).toBe(1500);
});
it.each(['create receipt', 'first billing month'])('keeps the old billed deposit collectible and routes only a proven new top-up to debt (%s)', async proof => {
  await openInvoice();
  await db.exec(`UPDATE contracts SET deposit_debt_mode='FIRST_INVOICE', deposit_debt_reason='Ghi chú cũ',
    start_billing_date='2026-10-01',end_billing_date='2026-10-31'`);
  if (proof === 'create receipt') {
    await db.exec(`INSERT INTO app_private.canonical_write_operations VALUES
      ('${org}','${contract}','contract.create.v2',now(),'{"invoice":{"id":"${invoice}"}}')`);
  } else {
    await db.exec("UPDATE invoices SET billing_month='2026-10'");
  }
  expect(await helper('apply', 2400)).toMatchObject({ held_deposit: 1500, deposit_shortfall: 900,
    deposit_invoiced_shortfall: 300, deposit_unbilled_shortfall: 600 });
  const c = (await db.query('SELECT * FROM contracts')).rows[0];
  expect(c.deposit_debt_mode).toBe('DEBT');
  expect(c.deposit_debt_reason).toContain('Ghi chú cũ');
  expect(c.deposit_debt_reason).toContain('qua hóa đơn đó');
  expect((await db.query('SELECT amount FROM invoice_items WHERE accounting_class=\'DEPOSIT\'')).rows[0].amount).toBe('300');
  await db.exec(`UPDATE invoices SET paid_amount=total_amount; UPDATE contracts SET deposit_paid=1800`);
  expect(await helper('quote', 2400)).toMatchObject({ deposit_shortfall: 600, deposit_invoiced_shortfall: 0, deposit_unbilled_shortfall: 600 });
});
it.each(['no first invoice', 'another month', 'cancelled first invoice', 'new target covered by first invoice'])('preserves first-invoice mode for %s', async scenario => {
  await db.exec(`UPDATE contracts SET deposit_debt_mode='FIRST_INVOICE',start_billing_date='2026-10-01',end_billing_date='2026-10-31'`);
  if (scenario !== 'no first invoice') {
    await openInvoice();
    await db.exec("UPDATE invoices SET billing_month='2026-10'");
    if (scenario === 'another month') await db.exec("UPDATE invoices SET billing_month='2026-11'");
    if (scenario === 'cancelled first invoice') await db.exec("UPDATE invoices SET status='CANCELLED'");
    if (scenario === 'new target covered by first invoice') await db.exec("UPDATE invoice_items SET amount=700 WHERE accounting_class='DEPOSIT'");
  }
  await helper('apply', 2200);
  expect((await db.query('SELECT deposit_debt_mode FROM contracts')).rows[0].deposit_debt_mode).toBe('FIRST_INVOICE');
});
