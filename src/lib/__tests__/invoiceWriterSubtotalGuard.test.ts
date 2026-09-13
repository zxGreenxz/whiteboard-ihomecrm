// Guard tạm tính cho create_invoice_v1 / update_invoice_v1 — đo ĐỊNH NGHĨA SỐNG
// (CREATE cuối cùng trong supabase/migrations), chạy trên PGlite với fixture tối
// thiểu, mỗi ca trong một giao dịch rồi ROLLBACK.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const MIG_DIR = 'supabase/migrations';
const org = 'dddd0000-0000-4000-8000-000000000001';
const actor = 'dddd0000-0000-4000-8000-0000000000aa';
const building = 'dddd0000-0000-4000-8000-0000000000b1';
const contract = 'dddd0000-0000-4000-8000-0000000000c1';
const room = 'dddd0000-0000-4000-8000-0000000000d1';

/** Định nghĩa SỐNG = CREATE cuối cùng theo thứ tự timestamp (quét toàn bộ migration). */
function liveDefinitionOf(fnName: string): string {
  const files = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
  const marker = `CREATE OR REPLACE FUNCTION public.${fnName}(`;
  let hit: string | null = null;
  for (const f of files) {
    const sql = readFileSync(join(MIG_DIR, f), 'utf8');
    const start = sql.indexOf(marker);
    if (start < 0) continue;
    const tail = sql.slice(start);
    const end = tail.indexOf('$function$', tail.indexOf('AS $function$') + 14) + '$function$'.length;
    hit = tail.slice(0, end) + ';';
  }
  if (!hit) throw new Error(`Không tìm thấy public.${fnName}`);
  return hit;
}

const db = new PGlite();
const line = (price: number, qty = 1, coef = 1, extra: Record<string, unknown> = {}) => ({
  type: 'RENT', accounting_class: 'REVENUE', description: 'Rent', unit_price: price, quantity: qty, coefficient: coef,
  amount: price * qty * coef, ...extra,
});

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE TABLE auth.users(id uuid PRIMARY KEY); INSERT INTO auth.users VALUES ('${actor}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${actor}'::uuid $$;
    CREATE TYPE invoice_status AS ENUM ('DRAFT','PENDING_APPROVAL','APPROVED','PARTIAL_PAID','PAID','OVERDUE','CANCELLED');
    CREATE TYPE invoice_item_type AS ENUM ('RENT','SERVICE','PENALTY','DISCOUNT','OTHER');
    CREATE TABLE organizations(id uuid PRIMARY KEY, status text DEFAULT 'ACTIVE'); INSERT INTO organizations(id) VALUES ('${org}');
    CREATE TABLE buildings(id uuid PRIMARY KEY, organization_id uuid, deleted_at timestamptz); INSERT INTO buildings VALUES ('${building}','${org}',NULL);
    CREATE TABLE contracts(id uuid PRIMARY KEY, organization_id uuid, deleted_at timestamptz); INSERT INTO contracts VALUES ('${contract}','${org}',NULL);
    CREATE TABLE rooms(id uuid PRIMARY KEY, organization_id uuid, building_id uuid, deleted_at timestamptz); INSERT INTO rooms VALUES ('${room}','${org}','${building}',NULL);
    CREATE TABLE organization_invoice_settings(organization_id uuid PRIMARY KEY, auto_approve_invoice boolean); INSERT INTO organization_invoice_settings VALUES ('${org}', false);
    CREATE TABLE app_private.canonical_write_operations(id uuid DEFAULT gen_random_uuid(), organization_id uuid, operation text, subject_scope text, actor_id uuid, idempotency_key text, payload_hash text, subject_id uuid, completed_at timestamptz, response_payload jsonb, UNIQUE(organization_id,operation,subject_scope,actor_id,idempotency_key));
    CREATE SEQUENCE invoice_seq;
    CREATE TABLE invoices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_number text DEFAULT ('INV-'||nextval('invoice_seq')), user_id uuid, organization_id uuid, contract_id uuid, building_id uuid, room_id uuid,
      billing_month text, issue_date date, due_date date, kind text DEFAULT 'MONTHLY', status invoice_status DEFAULT 'DRAFT', subtotal numeric, discount_amount numeric DEFAULT 0, discount_notes text,
      electricity_prev_overridden boolean DEFAULT false, total_amount numeric, prepaid_amount numeric DEFAULT 0, paid_amount numeric DEFAULT 0, previous_debt numeric DEFAULT 0,
      previous_debt_sources jsonb DEFAULT '[]', notes text, template_id uuid, creator_name text, approved_by uuid, approved_at timestamptz, adjustment_revision int DEFAULT 0, deleted_at timestamptz);
    CREATE TABLE invoice_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid REFERENCES invoices, organization_id uuid, service_id uuid, type invoice_item_type, description text,
      unit_price numeric, quantity numeric, coefficient numeric, amount numeric, previous_reading numeric, current_reading numeric, from_date date, to_date date, sort_order int, accounting_class text);
    CREATE TABLE excess_amounts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, organization_id uuid, contract_id uuid, amount numeric, description text, source_invoice_id uuid, source_payment_id uuid);
    CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS void LANGUAGE sql AS $$ SELECT NULL::void $$;
    CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean) LANGUAGE sql AS $$ SELECT true $$;
    CREATE FUNCTION app_private.evaluate_feature_route(text,uuid) RETURNS text LANGUAGE sql AS $$ SELECT 'CANONICAL' $$;
    CREATE FUNCTION app_private.can_edit_invoice_building_v1(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
    -- Cùng luật với roundInvoiceTotal ở client: phần lẻ <900 xuống, >=900 lên.
    CREATE FUNCTION app_private.round_invoice_total_v1(t numeric) RETURNS numeric LANGUAGE sql AS $$
      SELECT CASE WHEN t <= 0 THEN t WHEN mod(t,1000)=0 THEN t WHEN mod(t,1000) >= 900 THEN ceil(t/1000)*1000 ELSE floor(t/1000)*1000 END $$;
  `);
  await db.exec(liveDefinitionOf('create_invoice_v1'));
  await db.exec(liveDefinitionOf('update_invoice_v1'));
}, 30000);
afterAll(async () => { await db.close(); });

/** Mỗi lời gọi trong một SAVEPOINT: lời gọi bị từ chối không làm hỏng phần còn lại của giao dịch. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec('SAVEPOINT call');
  try { return await fn(); } catch (e) { await db.exec('ROLLBACK TO SAVEPOINT call'); throw e; }
}
async function create(items: unknown[], subtotal: number, total: number, key = 'guard-test-0001') {
  return guarded(() => db.query(`SELECT public.create_invoice_v1($1,$2,$3,'2094-09','2094-09-01','2094-09-10','MONTHLY',$4,0,$5,0,$6::jsonb,$7) AS r`,
    [contract, building, room, subtotal, total, JSON.stringify(items), key]));
}
async function scenario(fn: () => Promise<void>) { await db.exec('BEGIN'); try { await fn(); } finally { await db.exec('ROLLBACK'); } }
const status = (r: { rows: unknown[] }) => (r.rows[0] as { r: { status: string } }).r.status;

describe('create_invoice_v1 tự cộng lại dòng', () => {
  it('nhận đúng khi tạm tính = Σ đơn giá × số lượng × hệ số', () => scenario(async () => {
    expect(status(await create([line(5_000_000), line(100_000, 3)], 5_300_000, 5_300_000))).toBe('DRAFT');
    const saved = await db.query<{ subtotal: string; sum: string }>(`SELECT i.subtotal, (SELECT sum(amount) FROM invoice_items WHERE invoice_id=i.id) AS sum FROM invoices i`);
    expect(Number(saved.rows[0].subtotal)).toBe(Number(saved.rows[0].sum));
  }));
  it('từ chối khi tạm tính client nhỏ hơn tổng dòng (dòng 5,5tr, tạm tính 1,5tr)', () => scenario(async () => {
    await expect(create([line(5_000_000), line(300_000), line(200_000)], 1_500_000, 1_500_000))
      .rejects.toMatchObject({ code: '22000', message: expect.stringMatching(/Tạm tính client/) });
    expect((await db.query('SELECT count(*)::int AS n FROM invoices')).rows[0]).toEqual({ n: 0 });
  }));
  it('từ chối khi thành tiền dòng không bằng đơn giá × số lượng × hệ số', () => scenario(async () => {
    await expect(create([line(5_000_000, 1, 1, { amount: 1_000_000 })], 1_000_000, 1_000_000))
      .rejects.toMatchObject({ code: '22023', message: expect.stringMatching(/Thành tiền dòng/) });
  }));
  it('từ chối đơn giá / số lượng / hệ số âm hoặc NaN', () => scenario(async () => {
    await expect(create([line(-5_000_000)], -5_000_000, 0)).rejects.toMatchObject({ code: '22023' });
    await expect(create([{ ...line(100), quantity: 'NaN' }], 100, 0)).rejects.toMatchObject({ code: '22023' });
  }));
  it('chấp nhận dòng client cũ không gửi amount (server tự tính) và lệch dưới 1 đồng', () => scenario(async () => {
    const noAmount = { type: 'SERVICE', accounting_class: 'REVENUE', description: 'Nước', unit_price: 33333.33, quantity: 3, coefficient: 1 };
    expect(status(await create([noAmount], 100_000, 100_000))).toBe('DRAFT');
    const withAmount = { ...noAmount, amount: 100_000 }; // 33333.33×3 = 99999.99, lệch 0,01
    expect(status(await create([withAmount], 100_000, 100_000, 'guard-test-0002'))).toBe('DRAFT');
  }));
});

describe('update_invoice_v1 tự cộng lại dòng', () => {
  async function draft() {
    await create([line(5_000_000)], 5_000_000, 5_000_000, 'guard-upd-0001');
    return (await db.query<{ id: string }>('SELECT id FROM invoices LIMIT 1')).rows[0].id;
  }
  const update = (id: string, items: unknown[], subtotal: number, total: number) =>
    guarded(() => db.query(`SELECT public.update_invoice_v1($1,$2,$3,$4,'2094-09','2094-09-01','2094-09-10',$5,0,$6,0,$7::jsonb) AS r`,
      [id, contract, building, room, subtotal, total, JSON.stringify(items)]));
  it('từ chối tạm tính lệch tổng dòng', () => scenario(async () => {
    const id = await draft();
    await expect(update(id, [line(5_000_000), line(300_000)], 5_000_000, 5_000_000))
      .rejects.toMatchObject({ code: '22000', message: expect.stringMatching(/Tạm tính client/) });
  }));
  it('từ chối thành tiền dòng lệch đơn giá × số lượng', () => scenario(async () => {
    const id = await draft();
    await expect(update(id, [line(5_000_000, 1, 1, { amount: 1_000_000 })], 1_000_000, 1_000_000))
      .rejects.toMatchObject({ code: '22023' });
  }));
  it('nhận khi khớp và ghi subtotal = Σ dòng', () => scenario(async () => {
    const id = await draft();
    await update(id, [line(5_000_000), line(300_000)], 5_300_000, 5_300_000);
    const saved = await db.query<{ subtotal: string }>(`SELECT subtotal FROM invoices WHERE id=$1`, [id]);
    expect(Number(saved.rows[0].subtotal)).toBe(5_300_000);
  }));
});
