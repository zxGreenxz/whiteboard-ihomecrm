import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';

const db = new PGlite();
const sql = readFileSync('supabase/migrations/20261120093620_tien_thue_ky_chuyen_phong.sql', 'utf8');
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const [org,otherOrg,contract,r1,r2,r3,invoice,item] = Array.from({ length: 8 }, (_, i) => id(i+1));
beforeAll(async () => {
  await db.exec(`CREATE SCHEMA app_private; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE organizations(id uuid PRIMARY KEY);
    CREATE TABLE rooms(id uuid PRIMARY KEY);
    CREATE TABLE contracts(id uuid PRIMARY KEY,organization_id uuid,rent_price numeric(15,2),
      start_date date,start_billing_date date,end_billing_date date,deleted_at timestamptz);
    CREATE TABLE contract_transfers(contract_id uuid,transfer_type text,status text,
      transfer_date date,move_in_date date,old_room_id uuid,new_room_id uuid);
    CREATE TABLE invoices(id uuid PRIMARY KEY,organization_id uuid,contract_id uuid,billing_month text,
      kind text DEFAULT 'MONTHLY',status text DEFAULT 'APPROVED',total_amount numeric DEFAULT 0,
      subtotal numeric DEFAULT 0,paid_amount numeric DEFAULT 0,adjustment_revision bigint DEFAULT 0,
      updated_at timestamptz DEFAULT '2026-05-05T00:00:00Z',deleted_at timestamptz);
    CREATE TABLE invoice_items(id uuid PRIMARY KEY, invoice_id uuid, type text DEFAULT 'RENT',
      accounting_class text DEFAULT 'REVENUE', amount numeric, from_date date,to_date date);
    CREATE TABLE app_private.invoice_refund_reservations(id uuid PRIMARY KEY,organization_id uuid,invoice_id uuid,
      refund_voucher_id uuid,amount numeric,idempotency_key text,reservation_state text);
    INSERT INTO organizations VALUES('${org}'),('${otherOrg}');
    INSERT INTO rooms VALUES('${r1}'),('${r2}'),('${r3}');
    INSERT INTO contracts(id,organization_id,start_date,rent_price) VALUES('${contract}','${org}','2020-01-01',2000000)`);
  await db.exec(sql);
  await db.exec(sql);
}, 30000);
beforeEach(() => db.exec('BEGIN'));
afterEach(() => db.exec('ROLLBACK'));
afterAll(() => db.close());

async function quote(moveDate, rate = 4000000) {
  const result = await db.query('SELECT app_private.quote_room_transfer_rent_v1($1,$2,$3,$4) AS q', [org,contract,moveDate,rate]);
  return result.rows[0].q;
}

async function record(date, oldRoom, newRoom, oldRate, newRate, quoted = null) {
  await db.query('SELECT app_private.record_room_transfer_rent_v1($1,$2,$3,$4,$5,$6,$7,$8)',
    [org,contract,date,oldRoom,newRoom,oldRate,newRate,quoted]);
}

async function bill(from,to) {
  return (await db.query('SELECT app_private.room_transfer_rent_for_period_v1($1,$2,$3,$4)::int AS amount',
    [org,contract,from,to])).rows[0].amount;
}

async function issued({
  month='2026-06',amount=2000000,paid=0,status='APPROVED',from=null,to=null,invoiceId=invoice,itemId=item,orgId=org,
}={}) {
  await db.query(`INSERT INTO invoices(id,organization_id,contract_id,billing_month,status,paid_amount,subtotal,total_amount)
    VALUES($1,$2,$3,$4,$5,$6,$7,$7)`,[invoiceId,orgId,contract,month,status,paid,amount]);
  await db.query('INSERT INTO invoice_items(id,invoice_id,amount,from_date,to_date) VALUES($1,$2,$3,$4,$5)',
    [itemId,invoiceId,amount,from,to]);
}

it('quotes the full transition period before an invoice exists and returns the same amount when later billed', async () => {
  const result = await quote('2026-06-16');
  expect(result).toMatchObject({ period_start:'2026-06-01',period_end:'2026-06-30',billing_month:'2026-06',
    old_days:15,new_days:15,period_rent:3000000,billed_rent:0,rent_delta:3000000,invoice_id:null });
  await record('2026-06-16',r1,r2,2000000,4000000);
  expect(await bill('2026-06-01','2026-06-30')).toBe(result.period_rent);
  expect(await bill('2026-07-01','2026-07-31')).toBeNull();
});

it.each([
  ['2026-02-15',14,14,3000000], ['2024-02-15',14,15,3034483],
  ['2026-07-01',0,31,4000000], ['2026-07-31',30,1,2064516],
])('weights actual days around %s and bills the move day at the new rate', async (d,oldDays,newDays,amount) => {
  expect(await quote(d)).toMatchObject({ old_days:oldDays,new_days:newDays,period_rent:amount });
});

it.each([[0,'DRAFT'],[500000,'PARTIAL_PAID'],[2000000,'PAID']])('uses gross rent billed independently of %s already paid', async (paid,status) => {
  await issued({ paid,status });
  await db.query("INSERT INTO invoice_items(id,invoice_id,amount,type) VALUES($1,$2,500000,'SERVICE')", [id(80),invoice]);
  expect(await quote('2026-06-16')).toMatchObject({ invoice_id:invoice,invoice_status:status,invoice_paid:paid,invoice_revision:0,
    rent_item_id:item,rent_item_amount:2000000,billed_rent:2000000,period_rent:3000000,rent_delta:1000000 });
});

it('lower rent after full payment produces the amount to credit only once across subsequent moves', async () => {
  await issued({ paid:2000000,status:'PAID' });
  const first = await quote('2026-06-16',1000000);
  expect(first).toMatchObject({ period_rent:1500000,rent_delta:-500000 });
  await record('2026-06-16',r1,r2,2000000,1000000,first);
  await db.query('UPDATE contracts SET rent_price=1000000 WHERE id=$1',[contract]);
  for (const [n,amount,key,state,orgId] of [
    [50,500000,'room-transfer:a','CONSUMED',org], [51,2000,'room-transfer:b','HELD',otherOrg],
    [52,1000,'room-transfer:c','RELEASED',org], [53,800,'other','HELD',org], [54,300,'room-transfer:d','REVERSED',org],
    [55,5000,'room-transfer:public-refund-with-same-prefix','HELD',org],
  ]) {
    await db.query('INSERT INTO app_private.invoice_refund_reservations VALUES($1,$2,$3,$4,$5,$6,$7)',
      [id(n),orgId,invoice,id(n+10),amount,key,state]);
  }
  await db.query('UPDATE app_private.room_transfer_rent_events SET refund_reservation_id=$1 WHERE contract_id=$2',[id(50),contract]);
  expect(await quote('2026-06-26',4000000)).toMatchObject({
    period_rent:2000000,billed_rent:1500000,refund_reserved:500000,rent_delta:500000 });
  await db.query("UPDATE app_private.invoice_refund_reservations SET reservation_state='RELEASED' WHERE id=$1",[id(50)]);
  expect(await quote('2026-06-26',4000000)).toMatchObject({ billed_rent:2000000,refund_reserved:0,rent_delta:0 });
});

it('reuses a first invoice spanning months and weights each month separately', async () => {
  await db.query("UPDATE contracts SET start_billing_date='2026-01-16',end_billing_date='2026-02-28' WHERE id=$1",[contract]);
  const q = await quote('2026-01-17');
  expect(q).toMatchObject({billing_month:'2026-02',period_start:'2026-01-16',period_end:'2026-02-28',period_rent:6000000});
  await issued({month:'2026-02',from:'2026-01-16',to:'2026-02-28',amount:3032258});
  expect(await quote('2026-01-17')).toMatchObject({invoice_id:invoice,rent_delta:2967742});
});

it('excludes days owned by a different booking month, with and without explicit invoice dates', async () => {
  await db.query("UPDATE contracts SET start_billing_date='2026-01-16',end_billing_date='2026-02-28' WHERE id=$1",[contract]);
  const q=await quote('2026-01-20');
  await record('2026-01-20',r1,r2,2000000,4000000,q);
  const sibling=(month,from=null,to=null)=>db.query('SELECT app_private.room_transfer_sibling_rent_v1($1,$2,$3,$4,$5)::int AS rent',
    [org,contract,month,from,to]).then(x=>x.rows[0].rent);
  expect(await sibling('2026-01')).toBe(0);
  expect(await sibling('2026-01','2026-01-01','2026-01-31')).toBe(0);
  expect(await sibling('2026-02')).toBeNull();
  expect(await bill('2026-01-16','2026-02-28')).toBe(q.period_rent);
});

it('bills only the uncovered tail when the first booking month also covered the start of the next month', async () => {
  await db.query("UPDATE contracts SET start_billing_date='2026-01-16',end_billing_date='2026-02-10' WHERE id=$1",[contract]);
  const q=await quote('2026-01-20',2800000);
  expect(q.billing_month).toBe('2026-01');
  await record('2026-01-20',r1,r2,2000000,2800000,q);
  const sibling=(from,to)=>db.query("SELECT app_private.room_transfer_sibling_rent_v1($1,$2,'2026-02',$3,$4)::int AS rent",
    [org,contract,from,to]).then(x=>x.rows[0].rent);
  expect(await sibling(null,null)).toBe(1800000);
  expect(await sibling('2026-02-01','2026-02-28')).toBe(1800000);
  expect(await sibling('2026-02-01','2026-02-10')).toBe(0);
  expect(await sibling('2026-02-21','2026-02-28')).toBe(800000);
  await db.query('UPDATE contracts SET rent_price=2800000 WHERE id=$1',[contract]);
  await issued({month:'2026-02',from:'2026-02-01',to:'2026-02-28',amount:1800000});
  expect((await quote('2026-02-02',2800000)).billing_month).toBe('2026-01');
  await expect(quote('2026-02-02',3200000)).rejects.toMatchObject({code:'55000',message:expect.stringContaining('các ngày sau')});
});

it('requires reconciliation when an older active sibling invoice already billed days covered by the transfer period', async () => {
  await db.query("UPDATE contracts SET start_billing_date='2026-01-16',end_billing_date='2026-02-28' WHERE id=$1",[contract]);
  await issued({month:'2026-01',amount:1000000});
  await db.exec('SAVEPOINT old_bill');
  await expect(quote('2026-02-15')).rejects.toMatchObject({code:'55000',message:expect.stringContaining('chồng lên')});
  await db.exec('ROLLBACK TO old_bill');
  await db.query("UPDATE invoice_items SET from_date='2026-01-16',to_date='2026-01-31' WHERE id=$1",[item]);
  await expect(quote('2026-01-20')).rejects.toMatchObject({code:'55000',message:expect.stringContaining('chồng lên')});
  await db.exec('ROLLBACK TO old_bill');
  await db.query('UPDATE invoice_items SET amount=0 WHERE id=$1',[item]);
  expect((await quote('2026-02-15')).billing_month).toBe('2026-02');
});

it('respects an explicitly shorter invoiced period, without charging a whole month', async () => {
  await issued({ from:'2026-06-11',to:'2026-06-30',amount:1333333 });
  const initial = await quote('2026-06-16');
  expect(initial).toMatchObject({old_days:5,new_days:15,period_rent:2333333,rent_delta:1000000});
  await record('2026-06-16',r1,r2,2000000,4000000,initial);
  await db.query("UPDATE invoices SET status='CANCELLED' WHERE id=$1",[invoice]);
  const span = (await db.query("SELECT period_start::text,period_end::text FROM app_private.room_transfer_billing_period_v1($1,$2,'2026-06',NULL,NULL)",[org,contract])).rows[0];
  expect(span).toEqual({period_start:'2026-06-11',period_end:'2026-06-30'});
  expect(await bill(span.period_start,span.period_end)).toBe(initial.period_rent);
});

it('preserves a negotiated rent line on equal-price moves, later moves, and reissue of the same period', async () => {
  await issued({amount:1700000});
  expect(await quote('2026-06-16',2000000)).toMatchObject({rent_override:-300000,period_rent:1700000,rent_delta:0});
  const first = await quote('2026-06-16',4000000);
  expect(first).toMatchObject({rent_override:-300000,scheduled_rent:3000000,period_rent:2700000,rent_delta:1000000});
  await record('2026-06-16',r1,r2,2000000,4000000,first);
  await db.query('UPDATE contracts SET rent_price=4000000 WHERE id=$1',[contract]);
  await db.query('UPDATE invoice_items SET amount=2700000 WHERE id=$1',[item]);
  expect(await quote('2026-06-26',1000000)).toMatchObject({rent_override:-300000,scheduled_rent:2500000,period_rent:2200000,rent_delta:-500000});
  await db.query("UPDATE invoices SET status='CANCELLED' WHERE id=$1",[invoice]);
  expect(await bill('2026-06-01','2026-06-30')).toBe(2700000);
  expect(await quote('2026-06-26',1000000)).toMatchObject({invoice_id:null,rent_override:-300000,period_rent:2200000,rent_delta:2200000});
  await expect(bill('2026-06-01','2026-06-15')).rejects.toMatchObject({code:'55000'});
});

it('can add rent to an invoice containing only service charges without treating services as rent', async () => {
  await issued({amount:200000,paid:50000,status:'PARTIAL_PAID'});
  await db.query("UPDATE invoice_items SET type='SERVICE' WHERE id=$1",[item]);
  expect(await quote('2026-06-16')).toMatchObject({invoice_id:invoice,rent_item_id:null,invoice_paid:50000,
    invoice_status:'PARTIAL_PAID',invoice_total:200000,billed_rent:0,rent_delta:3000000});
  await db.query('UPDATE contracts SET rent_price=0 WHERE id=$1',[contract]);
  expect(await quote('2026-06-16',0)).toMatchObject({rent_item_id:null,billed_rent:0,rent_delta:0});
});

it('excludes rent-free days before first billing, with the same quote before and after issuing', async () => {
  await db.query("UPDATE contracts SET start_date='2026-05-01',start_billing_date='2026-06-11',end_billing_date='2026-06-30' WHERE id=$1",[contract]);
  const before = await quote('2026-05-25',3000000);
  expect(before).toMatchObject({billing_month:'2026-06',period_start:'2026-06-11',period_end:'2026-06-30',
    old_days:0,new_days:20,period_rent:2000000,billed_rent:0});
  await issued({from:'2026-06-11',to:'2026-06-30',amount:1333333});
  expect(await quote('2026-05-25',3000000)).toMatchObject({invoice_id:invoice,rent_delta:666667});
  await record('2026-05-25',r1,r2,2000000,3000000);
  expect(await bill('2026-06-11','2026-06-30')).toBe(before.period_rent);
});

it('preserves signed room changes, exact replay, and all prior segments when moving twice in one month', async () => {
  await record('2026-06-11',r1,r2,2000000,3000000);
  await record('2026-06-11',r1,r2,2000000,3000000);
  await db.query('UPDATE contracts SET rent_price=3000000 WHERE id=$1',[contract]);
  expect(await quote('2026-06-21',4000000)).toMatchObject({period_rent:3000000});
  await record('2026-06-21',r2,r3,3000000,4000000);
  expect(await bill('2026-06-01','2026-06-30')).toBe(3000000);
  await expect(record('2026-06-11',r1,r3,2000000,4000000)).rejects.toMatchObject({code:'23505'});
});

it('keeps the agreed rent when no new price is entered, including zero rent', async () => {
  expect(await quote('2026-06-16',null)).toMatchObject({period_rent:2000000});
  expect(await quote('2026-06-16',0)).toMatchObject({period_rent:1000000});
});

it('ignores cancelled, soft-deleted, nonmonthly and other-org invoices', async () => {
  await issued({status:'CANCELLED'});
  await issued({invoiceId:id(40),itemId:id(41),orgId:otherOrg});
  await issued({invoiceId:id(42),itemId:id(43)});
  await issued({invoiceId:id(44),itemId:id(45)});
  await db.query("UPDATE invoices SET kind='SETTLEMENT' WHERE id=$1",[id(42)]);
  await db.query("UPDATE invoices SET deleted_at=now() WHERE id=$1",[id(44)]);
  expect(await quote('2026-06-16')).toMatchObject({invoice_id:null,billed_rent:0});
});

it('rejects ambiguous rent lines before touching an invoice', async () => {
  await issued();
  await db.query('INSERT INTO invoice_items(id,invoice_id,amount) VALUES($1,$2,5000)',[id(66),invoice]);
  await expect(quote('2026-06-16')).rejects.toMatchObject({code:'55000',message:expect.stringContaining('Nhiều dòng')});
});

it('rejects previous legacy moves within this period when no signed rent snapshot exists', async () => {
  await db.query("INSERT INTO contract_transfers VALUES($1,'ROOM_CHANGE','COMPLETED','2026-06-04','2026-06-04',$2,$3)",
    [contract,r1,r2]);
  await expect(quote('2026-06-16')).rejects.toMatchObject({code:'55000',message:expect.stringContaining('lịch sử')});
});

it('protects rent history, writer and quote against direct API roles', async () => {
  const acl = await db.query(`SELECT role,
    has_table_privilege(role,'app_private.room_transfer_rent_events','INSERT') AS may_write,
    has_function_privilege(role,'app_private.record_room_transfer_rent_v1(uuid,uuid,date,uuid,uuid,numeric,numeric,jsonb)','EXECUTE') AS may_record,
    has_function_privilege(role,'app_private.quote_room_transfer_rent_v1(uuid,uuid,date,numeric)','EXECUTE') AS may_quote
    FROM unnest(ARRAY['anon','authenticated','service_role']) role`);
  for (const row of acl.rows) expect(row).toMatchObject({may_write:false,may_record:false,may_quote:false});
});
