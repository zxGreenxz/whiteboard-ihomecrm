import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { installRoomTransferFixture, installStatements, migration, org, owner, building, contract, oldRoom, newRoom } from '../lib/room-transfer-test-fixture.mjs';

const db = new PGlite();
const bulk = "SELECT public.generate_invoices_for_building($1,$2,$3,$4)";
const queryPrices = (month='2026-02') => db.query('SELECT public.room_transfer_invoice_rents_v1($1,$2) AS prices',[building,month]);
beforeAll(async () => {
  await installRoomTransferFixture(db);
  await db.exec(`
    ALTER TABLE public.buildings ADD deleted_at timestamptz;
    ALTER TABLE public.contracts ADD start_billing_date date, ADD end_billing_date date;
    CREATE TABLE public.invoices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,contract_id uuid,
      organization_id uuid DEFAULT '${org}',building_id uuid,room_id uuid,billing_month text,issue_date date,due_date date,
      status text DEFAULT 'DRAFT',approved_at timestamptz,approved_by uuid,subtotal numeric,total_amount numeric,
      kind text DEFAULT 'MONTHLY', deleted_at timestamptz);
    CREATE TABLE public.invoice_items(invoice_id uuid,type text,description text,unit_price numeric,quantity numeric,
      coefficient numeric,amount numeric,sort_order int,from_date date,to_date date,accounting_class text DEFAULT 'REVENUE');
    CREATE TABLE public.services(id uuid, name text, type text);
    CREATE TABLE public.contract_services(contract_id uuid, service_id uuid,unit_price numeric);
    CREATE TABLE app_private.invoice_refund_reservations(id uuid PRIMARY KEY);
    INSERT INTO public.grants_by_building VALUES ('${building}','invoices.create');
  `);
  await installStatements(db,'20260731070000_current_date_to_org_today',['CREATE OR REPLACE FUNCTION public.generate_invoices_for_building(']);
  await db.exec(migration('20261120093620_tien_thue_ky_chuyen_phong'));
  const billing = migration('20261120094154_tien_phong_ky_chuyen_khi_lap_hoa_don');
  await db.exec(billing);
  await db.exec(billing);
},30000);
beforeEach(() => db.exec('BEGIN'));
afterEach(() => db.exec('ROLLBACK'));
afterAll(() => db.close());

async function move(day='2026-02-15') {
  await db.query('SELECT app_private.record_room_transfer_rent_v1($1,$2,$3,$4,$5,2800000,5600000)',
    [org,contract,day,oldRoom,newRoom]);
  await db.query("UPDATE public.contracts SET room_id=$1,rent_price=5600000,commission_change_reason='Khách đổi phòng' WHERE id=$2",[newRoom,contract]);
}

it('uses the same prorated price in the UI quote and the existing bulk writer',async () => {
  await move();
  expect((await queryPrices()).rows[0].prices).toEqual({[contract]:4200000});
  await db.query(bulk,[owner,building,'2026-02','rent_only']);
  await db.exec('SET CONSTRAINTS ALL IMMEDIATE');
  expect((await db.query('SELECT amount::int,unit_price::int FROM invoice_items')).rows).toEqual([{amount:4200000,unit_price:4200000}]);
  expect((await db.query('SELECT total_amount::int FROM invoices')).rows).toEqual([{total_amount:4200000}]);
  expect((await queryPrices('2026-03')).rows[0].prices).toEqual({});
});

it('rejects a stale whole-month rent submitted by a legacy/manual invoice writer',async () => {
  await move();
  const { id }=(await db.query("INSERT INTO invoices(contract_id,billing_month) VALUES($1,'2026-02') RETURNING id",[contract])).rows[0];
  await db.query("INSERT INTO invoice_items(invoice_id,type,amount) VALUES($1,'RENT',5600000)",[id]);
  await expect(db.exec('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toMatchObject({code:'PT409'});
});

it('preserves a service-only invoice',async () => {
  await move();
  const { id }=(await db.query("INSERT INTO invoices(contract_id,billing_month) VALUES($1,'2026-02') RETURNING id",[contract])).rows[0];
  await db.query("INSERT INTO invoice_items(invoice_id,type,amount) VALUES($1,'SERVICE',120000)",[id]);
  await db.exec('SET CONSTRAINTS ALL IMMEDIATE');
  expect((await db.query('SELECT amount::int FROM invoice_items')).rows).toEqual([{amount:120000}]);
});

it('includes the agreed rent from the first billable day after a free initial period', async () => {
  await db.query("UPDATE contracts SET start_billing_date='2026-03-01',end_billing_date='2026-03-31' WHERE id=$1",[contract]);
  await move();
  expect((await queryPrices('2026-03')).rows[0].prices).toEqual({[contract]:5600000});
});

it('rejects invalid billing months',async () => {
  await expect(queryPrices('2026-13')).rejects.toMatchObject({code:'22023'});
});

it('bills a first period spanning two months only in its accounting month',async () => {
  await db.query("UPDATE contracts SET start_billing_date='2026-01-16',end_billing_date='2026-02-28' WHERE id=$1",[contract]);
  await move('2026-01-20');
  const first=(await queryPrices('2026-01')).rows[0].prices[contract];
  const second=(await queryPrices('2026-02')).rows[0].prices[contract];
  expect(first).toBe(0);
  expect(second).toBe(Math.round((4*2800000+12*5600000)/31+5600000));
  await db.query(bulk,[owner,building,'2026-01','rent_only']);
  await db.query(bulk,[owner,building,'2026-02','rent_only']);
  await db.exec('SET CONSTRAINTS ALL IMMEDIATE');
  expect((await db.query('SELECT sum(total_amount)::int AS total FROM invoices')).rows[0].total).toBe(second);
});

it('requires invoice access even if the user can edit contracts',async () => {
  await db.query("DELETE FROM grants_by_building WHERE permission='invoices.create'");
  await expect(queryPrices()).rejects.toMatchObject({code:'42501'});
});
