import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEPOSIT_RETAINED_KIND, DEPOSIT_RETAINED_LABEL } from '@/lib/terminationSettlement';

// Cọc giữ lại theo thoả thuận (plan sang nhượng phòng, đợt 4): luật sàn ở hàm lõi quyết toán rời phòng, dòng
// DEPOSIT_RETAINED thành doanh thu đúng hạng mục, hai trường hợp sang nhượng và Bỏ cọc không nhận dòng này.
// Thân bốn hàm production (terminate_contract_move_out_impl, _termination_apply_extra_charges,
// run_contract_exit_settlement_v1, assert_exit_early_terms_settlement_v1) nạp đúng bản 25/11/2026 (fixture), kiểm md5
// trước vá, chạy migration hai lượt. Hàm lõi chạy THẬT trên PGlite; chỉ các biên (sổ, hạng mục, quyền) là bản giả.
const MIGRATION = 'supabase/migrations/20261124201133_coc_giu_lai_theo_thoa_thuan.sql';
const BEFORE_FIXTURE = 'src/lib/__tests__/fixtures/deposit-retained-before.sql';
const migrationSql = readFileSync(MIGRATION, 'utf8');
const fixtureSql = readFileSync(BEFORE_FIXTURE, 'utf8');

const IMPL = 'public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)';
const RUN = 'app_private.run_contract_exit_settlement_v1(uuid,text,jsonb,text,boolean)';
const ASSERT = 'app_private.assert_exit_early_terms_settlement_v1(uuid,text,jsonb)';
// md5(pg_get_functiondef) production đọc lại ngày 25/11/2026 (npm run db:query, chỉ đọc).
const PROD_MD5: Record<string, string> = {
  [IMPL]: '0280c34c7c89755ffc0f5cf9dbb4f516',
  [RUN]: '2f7fad68da0224ea6693be7e2c058ac7',
  [ASSERT]: 'a8f25f4ed5a29e5dae89fd053fa4798a',
};
// Sau migration (đo trên PGlite; đối chiếu lại trên TEST sau khi áp).
const AFTER_MD5: Record<string, string> = {
  [IMPL]: '4140915710480b59d8d22cfeb4aef31f',
  [RUN]: '560ed9dc8d6f63d5c7f93789bf0bb886',
  [ASSERT]: '4cdd578c773da9e1cf17d3d512c8c0e6',
};
const LABEL = 'Cọc giữ lại theo thoả thuận';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const org = id(1), actor = id(2), building = id(3), owner = id(5), internalAccount = id(6), cashAccount = id(7);
const MOVE_OUT = '2026-11-20';
type Row = Record<string, unknown>;

const SCHEMA = `
  SET check_function_bodies = off;
  CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
  CREATE SCHEMA auth; CREATE SCHEMA app_private;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.actor',true),'')::uuid $$;
  CREATE TYPE public.invoice_status AS ENUM('DRAFT','APPROVED','PAID','PARTIAL_PAID','OVERDUE','CANCELLED');
  CREATE TYPE public.payment_method AS ENUM('TM','CK','CT');
  CREATE TYPE public.invoice_item_type AS ENUM('RENT','SERVICE','PENALTY','DISCOUNT','OTHER');
  CREATE TABLE public.rooms(id uuid PRIMARY KEY,building_id uuid);
  CREATE TABLE public.accounts(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,name text,is_virtual boolean DEFAULT false,deleted_at timestamptz);
  INSERT INTO public.accounts(id,organization_id,user_id,name,is_virtual) VALUES('${internalAccount}','${org}','${owner}','Cấn trừ thanh lý (nội bộ)',true),
    ('${cashAccount}','${org}','${owner}','Tiền mặt',false);
  CREATE TABLE public.contracts(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,room_id uuid,contract_number text,status text DEFAULT 'ACTIVE',
    start_date date DEFAULT '2026-01-01',actual_end_date date,total_deposit numeric,deposit_paid numeric,notes text,updated_at timestamptz DEFAULT now(),
    deleted_at timestamptz);
  CREATE TABLE public.invoices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,contract_id uuid,building_id uuid,room_id uuid,kind text,
    billing_month text,issue_date date,due_date date,status public.invoice_status,subtotal numeric DEFAULT 0,total_amount numeric DEFAULT 0,
    paid_amount numeric DEFAULT 0,notes text,deleted_at timestamptz,created_at timestamptz DEFAULT clock_timestamp(),updated_at timestamptz);
  CREATE TABLE public.invoice_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),invoice_id uuid,type public.invoice_item_type,description text,
    unit_price numeric,quantity numeric,coefficient numeric,amount numeric,previous_reading numeric,current_reading numeric,sort_order int);
  CREATE TABLE public.payments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,invoice_id uuid,amount numeric,
    payment_method public.payment_method,payment_date date,notes text);
  CREATE TABLE public.income_expense_types(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,organization_id uuid,type text,name text,
    description text,is_deposit boolean DEFAULT false,force_approval boolean DEFAULT false);
  INSERT INTO public.income_expense_types(user_id,organization_id,type,name,is_deposit) VALUES('${owner}','${org}','income','Tiền cọc',true);
  CREATE TABLE public.income_expenses(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,type text,name text,building_id uuid,room_id uuid,
    contract_id uuid,account_id uuid,invoice_id uuid,voucher_date date,total_amount numeric,approval_status text,notes text,system_source text,
    deleted_at timestamptz,created_at timestamptz DEFAULT clock_timestamp());
  CREATE TABLE public.income_expense_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),income_expense_id uuid REFERENCES public.income_expenses(id),
    income_expense_type_id uuid REFERENCES public.income_expense_types(id),description text,quantity numeric,unit_price numeric,
    amount numeric GENERATED ALWAYS AS (quantity*unit_price) STORED,start_date date,end_date date,created_at timestamptz DEFAULT clock_timestamp());
  CREATE TABLE public.contract_terminations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,contract_id uuid,termination_date date,
    actual_move_out_date date,termination_type text,outstanding_debt numeric,early_termination_fee numeric,prorated_rent numeric,prorated_days int,
    prorated_services numeric,total_deposit numeric,rent_refund_amount numeric,refund_method public.payment_method,status text,approved_by uuid,
    approved_at timestamptz,notes text);
  CREATE TABLE public.contract_exit_cases(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,contract_id uuid,actual_move_out_on date,
    state text DEFAULT 'PENDING',version bigint DEFAULT 1,created_at timestamptz DEFAULT now());
  CREATE TABLE app_private.contract_exit_writer_context(transaction_id bigint,backend_pid int,case_id uuid,case_version bigint,actor_id uuid,skip_physical boolean);
  CREATE TABLE public.contract_exit_early_terms(exit_case_id uuid PRIMARY KEY,contract_id uuid,organization_id uuid,early_reason text,sale_name text,
    broker_fee numeric DEFAULT 0,new_contract_id uuid,fee_applied_at timestamptz,version bigint DEFAULT 1,updated_at timestamptz);
  CREATE TABLE app_private.feature_cutovers(key text PRIMARY KEY,at timestamptz);
  INSERT INTO app_private.feature_cutovers VALUES('exit_early_terms','2026-11-24 14:46:02+00');
  CREATE TABLE public.engine_calls(kind text,contract_id uuid,payload jsonb);
  CREATE FUNCTION app_private.contract_exit_early_term_event_v1(uuid,text,text,uuid,text,jsonb) RETURNS void LANGUAGE sql AS $$ SELECT $$;
  CREATE FUNCTION app_private.assert_contract_exit_writer_v1(uuid,uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
  CREATE FUNCTION public.org_today_v1(uuid DEFAULT NULL) RETURNS date LANGUAGE sql STABLE AS $$ SELECT '2026-11-25'::date $$;
  CREATE FUNCTION public._termination_pick_account(uuid,uuid) RETURNS uuid LANGUAGE sql AS $$ SELECT '${cashAccount}'::uuid $$;
  CREATE FUNCTION public._internal_settlement_account(uuid) RETURNS uuid LANGUAGE sql AS $$ SELECT '${internalAccount}'::uuid $$;
  CREATE FUNCTION public._collector_thu_account(uuid) RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
  CREATE FUNCTION public._termination_ensure_type(p_user_id uuid,p_type text,p_name text) RETURNS uuid LANGUAGE plpgsql AS $$
    DECLARE v_id uuid; BEGIN
      SELECT t.id INTO v_id FROM public.income_expense_types t WHERE t.user_id=p_user_id AND lower(t.type)=lower(p_type) AND t.name=p_name;
      IF v_id IS NULL THEN INSERT INTO public.income_expense_types(user_id,organization_id,type,name,force_approval)
        VALUES(p_user_id,'${org}',lower(p_type),p_name,true) RETURNING id INTO v_id; END IF;
      RETURN v_id; END $$;
  CREATE FUNCTION public.recompute_invoice_for_id(uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
  CREATE FUNCTION app_private.termination_refund_name_v1(uuid,date) RETURNS text LANGUAGE sql AS $$ SELECT NULL::text $$;
  -- Hai lớp bọc quyết toán là bản giả: Bỏ cọc chỉ ghi lời gọi, rời phòng gọi thẳng hàm lõi thật.
  CREATE FUNCTION public.terminate_contract_forfeit_with_credit_v1(p_contract uuid,p_date date,p_extra jsonb,p_key text) RETURNS jsonb LANGUAGE sql AS $$
    INSERT INTO public.engine_calls VALUES('FORFEIT',p_contract,p_extra); SELECT jsonb_build_object('forfeit',true) $$;
  CREATE FUNCTION public.terminate_contract_move_out_with_credit_v1(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,text,jsonb DEFAULT '[]')
    RETURNS jsonb LANGUAGE sql AS $$
    SELECT jsonb_build_object('termination',public.terminate_contract_move_out_impl($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$12)) $$;
`;
const ACL = `
  REVOKE ALL ON FUNCTION ${IMPL} FROM PUBLIC; GRANT EXECUTE ON FUNCTION ${IMPL} TO service_role;
  REVOKE ALL ON FUNCTION ${RUN} FROM PUBLIC; REVOKE ALL ON FUNCTION ${ASSERT} FROM PUBLIC;
`;

async function freshDb(migration: string | null): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(SCHEMA);
  await pg.exec(fixtureSql);
  await pg.exec(ACL);
  await pg.exec('SET check_function_bodies = on');
  if (migration) await pg.exec(migration);
  return pg;
}
async function md5Of(pg: PGlite, signature: string): Promise<string> {
  return (await pg.query<{ m: string }>('SELECT md5(pg_get_functiondef($1::regprocedure)) m', [signature])).rows[0].m;
}
async function defOf(pg: PGlite, signature: string): Promise<string> {
  return (await pg.query<{ d: string }>('SELECT pg_get_functiondef($1::regprocedure) d', [signature])).rows[0].d;
}

let counter = 100;
interface Seed { paid: number | null; total: number | null }
/** Một phòng, một hợp đồng đang ở; cọc đã thu ghi bằng một phiếu thu cọc đã duyệt (cột deposit_paid giữ đúng số đó). */
async function seedContract(pg: PGlite, seed: Seed): Promise<string> {
  const room = id(++counter), contract = id(++counter);
  await pg.query('INSERT INTO public.rooms VALUES($1,$2)', [room, building]);
  await pg.query(`INSERT INTO public.contracts(id,organization_id,user_id,room_id,contract_number,total_deposit,deposit_paid) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [contract, org, owner, room, `HD-${counter}`, seed.total, seed.paid]);
  if ((seed.paid ?? 0) > 0) {
    const voucher = (await pg.query<{ id: string }>(`INSERT INTO public.income_expenses(user_id,type,name,building_id,room_id,contract_id,account_id,
      voucher_date,total_amount,approval_status,system_source) VALUES($1,'INCOME','Thu cọc',$2,$3,$4,$5,'2026-01-01',$6,'APPROVED','contract.create.v2') RETURNING id`,
      [owner, building, room, contract, cashAccount, seed.paid])).rows[0].id;
    await pg.query(`INSERT INTO public.income_expense_items(income_expense_id,income_expense_type_id,description,quantity,unit_price)
      SELECT $1,t.id,'Tiền cọc',1,$2 FROM public.income_expense_types t WHERE t.name='Tiền cọc'`, [voucher, seed.paid]);
  }
  return contract;
}
const IMPL_CALL = `SELECT public.terminate_contract_move_out_impl($1,$2,$3,0,0,$4,NULL,$5::jsonb,'PAID',NULL,'[]'::jsonb) AS r`;
async function settle(pg: PGlite, contract: string, depositRefund: number, extra: Row[] = [], debt = 0): Promise<Row> {
  return (await pg.query<{ r: Row }>(IMPL_CALL, [contract, MOVE_OUT, depositRefund, debt, JSON.stringify(extra)])).rows[0].r;
}
async function rejects(pg: PGlite, run: () => Promise<unknown>, code: string, message?: RegExp) {
  await pg.exec('SAVEPOINT failure');
  const error = await run().then(() => null, (e: { code?: string; message?: string }) => e);
  await pg.exec('ROLLBACK TO SAVEPOINT failure');
  expect(error, `phải lỗi ${code}`).not.toBeNull();
  expect(error?.code).toBe(code);
  if (message) expect(error?.message).toMatch(message);
}
/** Cọc còn ghi trên hợp đồng theo phiếu đã duyệt (thu cọc cộng, chi cọc trừ), như contract_deposit_paid_derived. */
async function depositLedger(pg: PGlite, contract: string): Promise<number> {
  return Number((await pg.query<{ s: string }>(`SELECT COALESCE(SUM(CASE WHEN v.type='INCOME' THEN i.amount ELSE -i.amount END),0)::text s
    FROM public.income_expense_items i JOIN public.income_expenses v ON v.id=i.income_expense_id
    JOIN public.income_expense_types t ON t.id=i.income_expense_type_id
    WHERE v.contract_id=$1 AND v.approval_status='APPROVED' AND v.deleted_at IS NULL AND t.is_deposit`, [contract])).rows[0].s);
}
async function approveRefund(pg: PGlite, contract: string) {
  await pg.query(`UPDATE public.income_expenses SET approval_status='APPROVED' WHERE contract_id=$1 AND system_source='termination.refund'`, [contract]);
}
async function revenueItems(pg: PGlite, contract: string) {
  return (await pg.query<{ description: string; amount: number; type_name: string; is_deposit: boolean; total: number }>(`SELECT i.description,
    i.amount::float8 amount,t.name type_name,t.is_deposit,v.total_amount::float8 total FROM public.income_expense_items i
    JOIN public.income_expenses v ON v.id=i.income_expense_id JOIN public.income_expense_types t ON t.id=i.income_expense_type_id
    WHERE v.contract_id=$1 AND v.system_source='termination.revenue' ORDER BY i.created_at`, [contract])).rows;
}
async function settlementLines(pg: PGlite, contract: string) {
  return (await pg.query<{ description: string; amount: number; type: string }>(`SELECT ii.description,ii.amount::float8 amount,ii.type::text type
    FROM public.invoice_items ii JOIN public.invoices iv ON iv.id=ii.invoice_id WHERE iv.contract_id=$1 AND iv.kind='SETTLEMENT' ORDER BY ii.sort_order`,
    [contract])).rows;
}
const retained = (amount: number, description = LABEL) => ({ kind: 'DEPOSIT_RETAINED', description, amount });
const cleaning = (amount: number) => ({ kind: 'CLEANING', description: 'Vệ sinh', amount });

let db: PGlite;
let before: PGlite;
const md5Before: Record<string, string> = {};
const md5After: Record<string, string> = {};
const md5Second: Record<string, string> = {};

beforeAll(async () => {
  db = await freshDb(null);
  for (const sig of Object.keys(PROD_MD5)) md5Before[sig] = await md5Of(db, sig);
  await db.exec(migrationSql);
  for (const sig of Object.keys(PROD_MD5)) md5After[sig] = await md5Of(db, sig);
  await db.exec(migrationSql);
  for (const sig of Object.keys(PROD_MD5)) md5Second[sig] = await md5Of(db, sig);
  before = await freshDb(null);
}, 120000);
afterAll(async () => { await db.close(); await before.close(); });
beforeEach(async () => {
  for (const pg of [db, before]) { await pg.exec('BEGIN'); await pg.query(`SELECT set_config('test.actor',$1,false)`, [actor]); }
});
afterEach(async () => { for (const pg of [db, before]) await pg.exec('ROLLBACK'); });

describe('migration', () => {
  it('thân hàm production đúng md5 trước vá; chạy hai lượt không đổi gì thêm; md5 sau vá đúng bản đã ghim', () => {
    expect(md5Before).toEqual(PROD_MD5);
    expect(md5Second).toEqual(md5After);
    expect(md5After).toEqual(AFTER_MD5);
  });

  it('mỗi điểm nối đúng một lần, đúng chỗ; giữ hai điểm nối is_contract_exit_settlement_v1; không đụng hàm bỏ cọc', async () => {
    const count = (body: string, marker: string) => body.split(marker).length - 1;
    const impl = await defOf(db, IMPL);
    expect(count(impl, 'app_private.is_contract_exit_settlement_v1(p_contract_id,p_move_out_date)')).toBe(2);
    expect(count(impl, 'v_deposit_floor := LEAST(')).toBe(1);
    // Kiểm sàn đứng ngay trước dòng tính cọc đem ra; kiểm dòng giữ lại đứng sau.
    const floor = impl.indexOf('IF GREATEST(COALESCE(p_deposit_refund, 0), 0) < v_deposit_floor THEN');
    const deposit = impl.indexOf('v_deposit := LEAST(GREATEST(COALESCE(p_deposit_refund, 0), 0), COALESCE(v_contract.deposit_paid, 0));');
    expect(floor).toBeGreaterThan(0);
    expect(floor).toBeLessThan(deposit);
    expect(impl.indexOf("WHERE j->>'kind' = 'DEPOSIT_RETAINED'")).toBeGreaterThan(deposit);
    expect(count(impl, `'${LABEL}', 1, LEAST(v_retained, v_applied_dep)`)).toBe(1);
    expect(count(impl, "'Doanh thu thanh lý (cấn cọc)'")).toBe(1);
    const assertBody = await defOf(db, ASSERT);
    expect(assertBody.indexOf(`không có dòng "${LABEL}"`)).toBeLessThan(assertBody.indexOf("IF p_kind IS DISTINCT FROM 'EARLY_RETURN' THEN"));
    const run = await defOf(db, RUN);
    expect(run.indexOf('Bỏ cọc đã giữ toàn bộ cọc')).toBeLessThan(run.indexOf('INSERT INTO app_private.contract_exit_writer_context'));
    expect(migrationSql).not.toMatch(/terminate_contract_forfeit|approve_contract_termination/);
    // Giao diện gửi đúng tên và kind mà máy chủ kiểm (từng byte).
    expect(DEPOSIT_RETAINED_LABEL).toBe(LABEL);
    expect(count(impl, `<> '${DEPOSIT_RETAINED_LABEL}'`)).toBe(1);
    expect(count(impl, `WHERE j->>'kind' = '${DEPOSIT_RETAINED_KIND}'`)).toBe(1);
    const acl = await db.query<{ a: boolean; s: boolean }>(`SELECT has_function_privilege('authenticated',$1::regprocedure,'EXECUTE') a,
      has_function_privilege('service_role',$1::regprocedure,'EXECUTE') s`, [IMPL]);
    expect(acl.rows[0]).toEqual({ a: false, s: true });
  });
});

describe('luật sàn: cọc đem ra không thấp hơn số nhỏ hơn giữa cọc đã thu và cọc theo hợp đồng', () => {
  it('hoàn thấp hơn cọc đã thu mà không có dòng giữ lại ⇒ từ chối, câu lỗi nói rõ cách làm; bản cũ thì cho qua và treo cọc', async () => {
    const contract = await seedContract(db, { paid: 4_500_000, total: 4_500_000 });
    await rejects(db, () => settle(db, contract, 2_500_000, [cleaning(200_000)]), '22023',
      /Cọc đem ra quyết toán \(2500000 đ\) thấp hơn cọc phải xử lý \(4500000 đ\)\. Hoàn đủ cọc, hoặc ghi phần không hoàn thành dòng "Cọc giữ lại theo thoả thuận"/);
    // Bản production hiện hành: qua được, 2.000.000 treo trên hợp đồng sau khi duyệt phiếu hoàn (ca 4 của báo cáo).
    const old = await seedContract(before, { paid: 4_500_000, total: 4_500_000 });
    const r = await settle(before, old, 2_500_000, [cleaning(200_000)]);
    expect(Number(r.refund_deposit)).toBe(2_300_000);
    await approveRefund(before, old);
    expect(await depositLedger(before, old)).toBe(2_000_000);
  });

  it('ca 4 của báo cáo làm đúng: đem đủ cọc, dòng giữ lại 2.000.000 ⇒ khách nhận như cũ, doanh thu đúng hạng mục, cọc về 0', async () => {
    const contract = await seedContract(db, { paid: 4_500_000, total: 4_500_000 });
    const r = await settle(db, contract, 4_500_000, [retained(2_000_000), cleaning(200_000)]);
    expect(Number(r.refund_deposit)).toBe(2_300_000);
    expect(Number(r.applied_deposit)).toBe(2_200_000);
    expect(Number(r.extra_charges_total)).toBe(2_200_000);
    expect(await settlementLines(db, contract)).toEqual([
      { description: LABEL, amount: 2_000_000, type: 'OTHER' }, { description: 'Vệ sinh', amount: 200_000, type: 'OTHER' }]);
    const items = await revenueItems(db, contract);
    expect(items).toEqual([
      { description: 'Doanh thu thanh lý (cấn cọc)', amount: 200_000, type_name: 'Doanh thu thanh lý', is_deposit: false, total: 2_200_000 },
      { description: LABEL, amount: 2_000_000, type_name: LABEL, is_deposit: false, total: 2_200_000 }]);
    const notes = (await db.query<{ n: string }>(`SELECT notes n FROM public.contract_terminations WHERE contract_id=$1`, [contract])).rows[0].n;
    expect(notes).toContain(`• Trong đó cọc giữ lại theo thoả thuận: 2,000,000đ (doanh thu thanh lý)`);
    // Trước khi duyệt phiếu hoàn: còn đúng số sẽ hoàn cho khách.
    expect(await depositLedger(db, contract)).toBe(2_300_000);
    await approveRefund(db, contract);
    expect(await depositLedger(db, contract)).toBe(0);
  });

  it('hoàn đủ: không có dòng giữ lại thì phiếu doanh thu giữ đúng một hạng mục cũ, không tạo hạng mục mới', async () => {
    const contract = await seedContract(db, { paid: 4_500_000, total: 4_500_000 });
    const r = await settle(db, contract, 4_500_000, [cleaning(200_000)]);
    expect(Number(r.refund_deposit)).toBe(4_300_000);
    expect(await revenueItems(db, contract)).toEqual([
      { description: 'Doanh thu thanh lý (cấn cọc)', amount: 200_000, type_name: 'Doanh thu thanh lý', is_deposit: false, total: 200_000 }]);
    expect((await db.query(`SELECT 1 FROM public.income_expense_types WHERE name=$1`, [LABEL])).rows).toHaveLength(0);
    await approveRefund(db, contract);
    expect(await depositLedger(db, contract)).toBe(0);
    // Không đổi gì so với bản production hiện hành.
    const old = await seedContract(before, { paid: 4_500_000, total: 4_500_000 });
    const o = await settle(before, old, 4_500_000, [cleaning(200_000)]);
    for (const key of ['refund_deposit', 'applied_deposit', 'charges', 'net_settlement']) expect(r[key]).toEqual(o[key]);
  });

  it('giữ lại toàn bộ cọc theo thoả thuận: không phiếu hoàn, phiếu doanh thu chỉ một dòng giữ lại (không có dòng 0 đồng)', async () => {
    const contract = await seedContract(db, { paid: 4_500_000, total: 4_500_000 });
    const r = await settle(db, contract, 4_500_000, [retained(4_500_000)]);
    expect(Number(r.refund_deposit)).toBe(0);
    expect(r.refund_voucher_id).toBeNull();
    expect(await revenueItems(db, contract)).toEqual([
      { description: LABEL, amount: 4_500_000, type_name: LABEL, is_deposit: false, total: 4_500_000 }]);
    expect(await depositLedger(db, contract)).toBe(0);
  });

  it('nợ vượt cọc: phần giữ lại vẫn là doanh thu riêng, khách trả thêm đúng như cũ, tổng doanh thu = nợ + giữ lại', async () => {
    const contract = await seedContract(db, { paid: 4_000_000, total: 4_000_000 });
    const r = await settle(db, contract, 4_000_000, [retained(3_000_000)], 5_000_000);
    expect(Number(r.net_settlement)).toBe(-4_000_000);
    const items = await revenueItems(db, contract);
    expect(items.map(i => [i.description, i.amount])).toEqual([['Doanh thu thanh lý (cấn cọc)', 1_000_000], [LABEL, 3_000_000]]);
    const receipt = (await db.query<{ t: number }>(`SELECT total_amount::float8 t FROM public.income_expenses WHERE contract_id=$1
      AND system_source='termination.extra_receipt'`, [contract])).rows[0].t;
    expect(receipt + items.reduce((s, i) => s + i.amount, 0)).toBe(5_000_000 + 3_000_000);
    // Bản cũ (đem ra 1.000.000, không dòng giữ lại): khách cũng trả thêm 4.000.000 nhưng 3.000.000 cọc treo lại.
    const old = await seedContract(before, { paid: 4_000_000, total: 4_000_000 });
    const o = await settle(before, old, 1_000_000, [], 5_000_000);
    expect(Number(o.net_settlement)).toBe(-4_000_000);
    expect(await depositLedger(before, old)).toBe(3_000_000);
    expect(await depositLedger(db, contract)).toBe(0);
  });

  it('sổ cọc ghi dôi trên cọc hợp đồng: từ sàn trở lên cho qua, phần dôi để nguyên (không thành doanh thu); dưới sàn phải có dòng giữ lại', async () => {
    const atFloor = await seedContract(db, { paid: 5_000_000, total: 4_000_000 });
    const r = await settle(db, atFloor, 4_000_000, []);
    expect(Number(r.refund_deposit)).toBe(4_000_000);
    expect(await revenueItems(db, atFloor)).toEqual([]);
    await approveRefund(db, atFloor);
    expect(await depositLedger(db, atFloor)).toBe(1_000_000);
    const between = await seedContract(db, { paid: 5_000_000, total: 4_000_000 });
    expect(Number((await settle(db, between, 4_600_000, [])).refund_deposit)).toBe(4_600_000);
    const below = await seedContract(db, { paid: 5_000_000, total: 4_000_000 });
    await rejects(db, () => settle(db, below, 3_000_000, []), '22023', /thấp hơn cọc phải xử lý \(4000000 đ\)/);
    // Giao diện gửi sàn + dòng giữ lại 1.000.000: chỉ phần dưới cọc hợp đồng thành doanh thu.
    const r2 = await settle(db, below, 4_000_000, [retained(1_000_000)]);
    expect(Number(r2.refund_deposit)).toBe(3_000_000);
    expect((await revenueItems(db, below)).map(i => [i.description, i.amount])).toEqual([[LABEL, 1_000_000]]);
    await approveRefund(db, below);
    expect(await depositLedger(db, below)).toBe(1_000_000);
  });

  it('cọc theo hợp đồng bằng 0 hoặc NULL, hoặc chưa thu cọc: sàn = 0, không chặn nhầm', async () => {
    for (const seed of [{ paid: 4_000_000, total: 0 }, { paid: 4_000_000, total: null }, { paid: 0, total: 4_000_000 },
      { paid: null, total: 4_000_000 }, { paid: 0, total: 0 }]) {
      const contract = await seedContract(db, seed);
      const r = await settle(db, contract, 0, [cleaning(100_000)]);
      expect(Number(r.applied_deposit), JSON.stringify(seed)).toBe(0);
    }
    // Cọc đã thu âm (hoàn quá) cũng là sàn 0.
    const negative = await seedContract(db, { paid: -100_000, total: 4_000_000 });
    expect(Number((await settle(db, negative, 0, [])).refund_deposit)).toBe(0);
  });

  it('đã cấn số hỗ trợ sang hợp đồng mới: sàn là cọc đã thu còn lại', async () => {
    const contract = await seedContract(db, { paid: 3_000_000, total: 4_000_000 });
    await rejects(db, () => settle(db, contract, 2_900_000, []), '22023', /thấp hơn cọc phải xử lý \(3000000 đ\)/);
    const r = await settle(db, contract, 3_000_000, [retained(1_000_000)]);
    expect(Number(r.refund_deposit)).toBe(2_000_000);
  });

  it('dòng giữ lại sai dạng ⇒ từ chối: hai dòng, sai tên, số 0, vượt cọc đem ra', async () => {
    const contract = await seedContract(db, { paid: 4_500_000, total: 4_500_000 });
    await rejects(db, () => settle(db, contract, 4_500_000, [retained(1_000_000), retained(500_000)]), '22023', /tối đa một dòng/);
    await rejects(db, () => settle(db, contract, 4_500_000, [retained(1_000_000, 'Giữ cọc')]), '22023', /đúng tên đó/);
    await rejects(db, () => settle(db, contract, 4_500_000, [{ kind: 'DEPOSIT_RETAINED', description: LABEL, amount: 0 }]), '22023', /lớn hơn 0/);
    await rejects(db, () => settle(db, contract, 4_500_000, [retained(5_000_000)]), '22023',
      /Cọc giữ lại theo thoả thuận \(5000000 đ\) lớn hơn cọc đem ra quyết toán \(4500000 đ\)/);
  });
});

describe('các đường quyết toán qua run_contract_exit_settlement_v1', () => {
  async function exitCase(pg: PGlite, contract: string): Promise<string> {
    const caseId = id(++counter);
    await pg.query(`INSERT INTO public.contract_exit_cases(id,organization_id,building_id,contract_id,actual_move_out_on) VALUES($1,$2,$3,$4,$5)`,
      [caseId, org, building, contract, MOVE_OUT]);
    return caseId;
  }
  const RUN_CALL = 'SELECT app_private.run_contract_exit_settlement_v1($1,$2,$3::jsonb,$4,false) AS r';

  it('Hết hạn hợp đồng hoàn đủ vẫn chạy; hoàn thấp hơn sàn bị chặn ngay ở hàm lõi', async () => {
    const contract = await seedContract(db, { paid: 4_000_000, total: 4_000_000 });
    const caseId = await exitCase(db, contract);
    await rejects(db, () => db.query(RUN_CALL, [caseId, 'NATURAL_EXPIRY', JSON.stringify({ deposit_refund: 3_000_000 }), 'exit-key-0001']),
      '22023', /thấp hơn cọc phải xử lý/);
    const r = (await db.query<{ r: Row }>(RUN_CALL, [caseId, 'NATURAL_EXPIRY', JSON.stringify({ deposit_refund: 4_000_000 }), 'exit-key-0002'])).rows[0].r;
    expect(Number((r.termination as Row).refund_deposit)).toBe(4_000_000);
  });

  it('Bỏ cọc vẫn chạy như cũ; Bỏ cọc kèm dòng giữ lại bị từ chối trước khi tới hàm bỏ cọc', async () => {
    const contract = await seedContract(db, { paid: 4_000_000, total: 4_000_000 });
    const caseId = await exitCase(db, contract);
    await rejects(db, () => db.query(RUN_CALL, [caseId, 'FORFEIT', JSON.stringify({ extra_charges: [retained(1_000_000)] }), 'exit-key-0003']),
      '22023', /Bỏ cọc đã giữ toàn bộ cọc thành doanh thu bỏ cọc/);
    expect((await db.query('SELECT 1 FROM public.engine_calls')).rows).toHaveLength(0);
    await db.query(RUN_CALL, [caseId, 'FORFEIT', JSON.stringify({ extra_charges: [cleaning(200_000)] }), 'exit-key-0004']);
    expect((await db.query<{ kind: string }>('SELECT kind FROM public.engine_calls')).rows).toEqual([{ kind: 'FORFEIT' }]);
  });
});

describe('hai trường hợp sang nhượng hoàn đủ cọc (assert_exit_early_terms_settlement_v1)', () => {
  const ASSERT_CALL = 'SELECT app_private.assert_exit_early_terms_settlement_v1($1,$2,$3::jsonb)';
  async function earlyCase(pg: PGlite, reason: string, fee = 0): Promise<string> {
    const contract = await seedContract(pg, { paid: 4_000_000, total: 4_000_000 });
    const fresh = await seedContract(pg, { paid: 0, total: 4_000_000 });
    const caseId = id(++counter);
    await pg.query(`INSERT INTO public.contract_exit_cases(id,organization_id,building_id,contract_id,actual_move_out_on) VALUES($1,$2,$3,$4,$5)`,
      [caseId, org, building, contract, MOVE_OUT]);
    await pg.query(`INSERT INTO public.contract_exit_early_terms(exit_case_id,contract_id,organization_id,early_reason,sale_name,broker_fee,new_contract_id)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [caseId, contract, org, reason, reason === 'SALE_ASSISTED' ? 'Sale A' : null, fee,
      reason === 'LANDLORD_AGREEMENT' ? null : fresh]);
    return caseId;
  }
  const fee = (amount: number) => ({ kind: 'BROKER_FEE', description: 'Phí môi giới (50% cọc cũ)', amount });

  it('nhờ sale và tự tìm: có dòng giữ lại ⇒ từ chối; không có thì qua như đợt 2', async () => {
    const sale = await earlyCase(db, 'SALE_ASSISTED', 2_000_000);
    await rejects(db, () => db.query(ASSERT_CALL, [sale, 'EARLY_RETURN', JSON.stringify({ deposit_refund: 4_000_000,
      extra_charges: [fee(2_000_000), retained(500_000)] })]), '22023', /Hồ sơ sang nhượng phòng hoàn đủ cọc cho khách cũ/);
    await db.query(ASSERT_CALL, [sale, 'EARLY_RETURN', JSON.stringify({ deposit_refund: 4_000_000, extra_charges: [fee(2_000_000)] })]);
    const self = await earlyCase(db, 'SELF_FOUND');
    await rejects(db, () => db.query(ASSERT_CALL, [self, 'EARLY_RETURN', JSON.stringify({ deposit_refund: 4_000_000,
      extra_charges: [retained(500_000)] })]), '22023', /hoàn đủ cọc/);
    await db.query(ASSERT_CALL, [self, 'EARLY_RETURN', JSON.stringify({ deposit_refund: 4_000_000, extra_charges: [] })]);
  });

  it('chủ nhà hỗ trợ: dòng giữ lại theo thoả thuận được nhận', async () => {
    const landlord = await earlyCase(db, 'LANDLORD_AGREEMENT');
    await db.query(ASSERT_CALL, [landlord, 'EARLY_RETURN', JSON.stringify({ deposit_refund: 4_000_000, extra_charges: [retained(2_000_000)] })]);
  });
});

describe('kiểm đột biến: gỡ từng kiểm mới thì test phải đỏ', () => {
  const withoutCheck = (sql: string) => sql.slice(0, sql.indexOf('DO $check$'));
  async function mutated(from: string, to: string): Promise<PGlite> {
    const body = withoutCheck(migrationSql);
    expect(body.split(from).length - 1, from).toBe(1);
    return freshDb(body.replace(from, to));
  }

  it('gỡ luật sàn ⇒ hoàn thấp hơn cọc đã thu lại qua được và treo cọc', async () => {
    const pg = await mutated('IF GREATEST(COALESCE(p_deposit_refund, 0), 0) < v_deposit_floor THEN',
      'IF GREATEST(COALESCE(p_deposit_refund, 0), 0) < v_deposit_floor - 1e15 THEN');
    try {
      await pg.query(`SELECT set_config('test.actor',$1,false)`, [actor]);
      const contract = await seedContract(pg, { paid: 4_500_000, total: 4_500_000 });
      await settle(pg, contract, 2_500_000, []);
      await approveRefund(pg, contract);
      expect(await depositLedger(pg, contract)).toBe(2_000_000);
    } finally { await pg.close(); }
  }, 60000);

  it('gỡ kiểm sang nhượng ⇒ dòng giữ lại lọt vào quyết toán ca tự tìm', async () => {
    const pg = await mutated(`WHERE j->>'kind'='DEPOSIT_RETAINED') THEN
    RAISE EXCEPTION 'Hồ sơ sang nhượng`, `WHERE j->>'kind'='KHONG_CO') THEN
    RAISE EXCEPTION 'Hồ sơ sang nhượng`);
    try {
      const contract = await seedContract(pg, { paid: 4_000_000, total: 4_000_000 });
      const fresh = await seedContract(pg, { paid: 0, total: 4_000_000 });
      const caseId = id(++counter);
      await pg.query(`INSERT INTO public.contract_exit_cases(id,organization_id,building_id,contract_id,actual_move_out_on) VALUES($1,$2,$3,$4,$5)`,
        [caseId, org, building, contract, MOVE_OUT]);
      await pg.query(`INSERT INTO public.contract_exit_early_terms(exit_case_id,contract_id,organization_id,early_reason,new_contract_id)
        VALUES($1,$2,$3,'SELF_FOUND',$4)`, [caseId, contract, org, fresh]);
      await pg.query('SELECT app_private.assert_exit_early_terms_settlement_v1($1,$2,$3::jsonb)',
        [caseId, 'EARLY_RETURN', JSON.stringify({ deposit_refund: 4_000_000, extra_charges: [retained(500_000)] })]);
    } finally { await pg.close(); }
  }, 60000);

  it('gỡ kiểm Bỏ cọc ⇒ dòng giữ lại đi tới hàm bỏ cọc (sẽ thành hoá đơn thu thêm của khách)', async () => {
    const pg = await mutated(`WHERE j->>'kind'='DEPOSIT_RETAINED') THEN
    RAISE EXCEPTION 'Bỏ cọc`, `WHERE j->>'kind'='KHONG_CO') THEN
    RAISE EXCEPTION 'Bỏ cọc`);
    try {
      await pg.query(`SELECT set_config('test.actor',$1,false)`, [actor]);
      const contract = await seedContract(pg, { paid: 4_000_000, total: 4_000_000 });
      const caseId = id(++counter);
      await pg.query(`INSERT INTO public.contract_exit_cases(id,organization_id,building_id,contract_id,actual_move_out_on) VALUES($1,$2,$3,$4,$5)`,
        [caseId, org, building, contract, MOVE_OUT]);
      await pg.query('SELECT app_private.run_contract_exit_settlement_v1($1,$2,$3::jsonb,$4,false)',
        [caseId, 'FORFEIT', JSON.stringify({ extra_charges: [retained(1_000_000)] }), 'exit-key-0009']);
      expect((await pg.query('SELECT 1 FROM public.engine_calls')).rows).toHaveLength(1);
    } finally { await pg.close(); }
  }, 60000);
});
