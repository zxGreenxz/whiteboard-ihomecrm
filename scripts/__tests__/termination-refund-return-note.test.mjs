import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const original = readFileSync(new URL('../../supabase/migrations/20260902104355_ten_phieu_tra_khach_thanh_ly_va_ghi_chu_luc_xem.sql', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../../supabase/migrations/20260929123724_termination_refund_return_note.sql', import.meta.url), 'utf8');
const functionSql = name => original.match(new RegExp(`CREATE OR REPLACE FUNCTION ${name.replaceAll('.', '\\.')}\\([\\s\\S]*?\\$fn\\$;`))[0];
const id = value => `10000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const [org, otherOrg, building, contract, voucher, termination, user] = [1, 2, 3, 4, 5, 6, 7].map(id);
const note = 'Khách chuyển công tác.\nBàn giao đủ chìa khóa.';
const db = new PGlite();
let priorFacts;
let priorMetadata;

const metadata = async () => (await db.query(`SELECT p.oid::regprocedure::text AS name, p.prosecdef, p.provolatile,
  p.proconfig, p.proacl::text, p.proowner FROM pg_proc p WHERE p.oid IN
  ('app_private.termination_refund_facts_v1(uuid)'::regprocedure, 'public.get_termination_refund_facts_v1(uuid[])'::regprocedure)
  ORDER BY name`)).rows;
const facts = async () => (await db.query('SELECT facts FROM public.get_termination_refund_facts_v1($1::uuid[])', [[voucher]])).rows[0]?.facts;

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE FUNCTION public.can_access_building(p_id uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT p_id::text=current_setting('test.building',true) $$;
    CREATE FUNCTION public.ie_all_buildings_scope(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
    CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
    CREATE TABLE buildings(id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE contracts(id uuid PRIMARY KEY, organization_id uuid, actual_end_date date);
    CREATE TABLE income_expenses(id uuid PRIMARY KEY, code text, contract_id uuid, organization_id uuid,
      building_id uuid, total_amount numeric, voucher_date date, approval_status text, account_id uuid,
      notes text, deleted_at timestamptz, system_source text);
    CREATE TABLE contract_terminations(id uuid PRIMARY KEY, contract_id uuid, created_at timestamptz,
      termination_date date, actual_move_out_date date, outstanding_debt numeric, early_termination_fee numeric,
      total_deposit numeric, rent_refund_amount numeric, total_deductions numeric, refund_amount numeric, status text, notes text);
    CREATE TABLE contract_exit_cases(id uuid PRIMARY KEY, contract_id uuid UNIQUE, organization_id uuid,
      legacy_termination_id uuid UNIQUE, state text, return_note text);
    CREATE TABLE invoices(id uuid PRIMARY KEY, contract_id uuid, kind text, deleted_at timestamptz, status text, created_at timestamptz);
    CREATE TABLE invoice_items(id uuid PRIMARY KEY, invoice_id uuid, description text, amount numeric, type text, sort_order integer);
    CREATE TABLE income_expense_items(id uuid PRIMARY KEY, income_expense_id uuid, income_expense_type_id uuid,
      description text, amount numeric, unit_price numeric, quantity numeric, created_at timestamptz);
    CREATE TABLE income_expense_types(id uuid PRIMARY KEY, name text, is_deposit boolean);
    CREATE FUNCTION app_private.commission_contract_facts_v1(p_id uuid) RETURNS jsonb LANGUAGE sql AS
      $$ SELECT jsonb_build_object('organization_id',organization_id,'contract_id',id) FROM contracts WHERE id=p_id $$;
    INSERT INTO buildings VALUES ('${building}','${id(8)}');
    INSERT INTO contracts VALUES ('${contract}','${org}','2026-09-29');
    INSERT INTO income_expenses VALUES ('${voucher}','REFUND','${contract}','${org}','${building}',2000000,'2026-09-29',
      'APPROVED','${id(9)}','Original generated note',null,'termination.refund');
    INSERT INTO contract_terminations VALUES ('${termination}','${contract}','2026-09-29',
      '2026-09-29','2026-09-29',100000,400000,2500000,0,500000,2000000,'COMPLETED','Original settlement note');
    INSERT INTO contract_exit_cases VALUES ('${id(10)}','${contract}','${org}','${termination}','FINALIZED',null);
    GRANT USAGE ON SCHEMA public,auth TO authenticated;
  `);
  await db.query('UPDATE contract_exit_cases SET return_note=$1', [note]);
  await db.exec(functionSql('app_private.termination_refund_facts_v1'));
  await db.exec(functionSql('public.get_termination_refund_facts_v1'));
  await db.exec(`REVOKE ALL ON FUNCTION app_private.termination_refund_facts_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;
    REVOKE ALL ON FUNCTION public.get_termination_refund_facts_v1(uuid[]) FROM PUBLIC,anon,service_role;
    GRANT EXECUTE ON FUNCTION public.get_termination_refund_facts_v1(uuid[]) TO authenticated;
    SELECT set_config('request.jwt.claim.sub','${user}',false), set_config('test.building','${building}',false);`);
  priorFacts = await facts();
  priorMetadata = await metadata();
  await db.exec(migration);
}, 30000);
beforeEach(async () => { await db.exec('BEGIN'); });
afterEach(async () => { await db.exec('ROLLBACK'); });
afterAll(async () => { await db.close(); });

describe('nội dung thanh lý qua facts của phiếu chi', () => {
  it('người chỉ đọc phiếu xem được nội dung đã lưu, không cần SELECT hợp đồng', async () => {
    await db.exec('SET LOCAL ROLE authenticated');
    expect((await facts()).return_note).toBe(note);
    const access = await db.query("SELECT has_table_privilege('authenticated','contracts','SELECT') AS contracts_read");
    expect(access.rows[0].contracts_read).toBe(false);
  });

  it('giữ nguyên toàn bộ facts tiền, ghi chú cũ và dữ liệu nguồn', async () => {
    const before = (await db.query('SELECT to_jsonb(v) AS row FROM income_expenses v')).rows;
    const { return_note: saved, ...after } = await facts();
    expect(saved).toBe(note);
    expect(after).toEqual(priorFacts);
    expect((await db.query('SELECT to_jsonb(v) AS row FROM income_expenses v')).rows).toEqual(before);
  });

  it('hồ sơ cũ không có exit case trả NULL, không dùng ghi chú của phiếu', async () => {
    await db.exec('DELETE FROM contract_exit_cases');
    expect((await facts()).return_note).toBeNull();
  });

  it('exit case chưa có nội dung trả NULL', async () => {
    await db.exec('UPDATE contract_exit_cases SET return_note=NULL');
    expect((await facts()).return_note).toBeNull();
  });

  it('không lấy nội dung của hồ sơ tổ chức khác', async () => {
    await db.query('UPDATE contract_exit_cases SET organization_id=$1', [otherOrg]);
    expect((await facts()).return_note).toBeNull();
  });

  it('không lấy nội dung của hồ sơ không liên kết lần quyết toán này', async () => {
    await db.query('UPDATE contract_exit_cases SET legacy_termination_id=$1', [id(99)]);
    expect((await facts()).return_note).toBeNull();
  });

  it('không trả facts khi người dùng ngoài phạm vi tòa', async () => {
    await db.exec(`SELECT set_config('test.building','${id(99)}',true); SET LOCAL ROLE authenticated;`);
    expect(await facts()).toBeUndefined();
  });

  it('giữ chặn phiếu và hợp đồng khác tổ chức', async () => {
    await db.query('UPDATE contracts SET organization_id=$1', [otherOrg]);
    await db.exec('SET LOCAL ROLE authenticated');
    expect(await facts()).toBeUndefined();
  });

  it('replay giữ nội dung và không đổi ACL/owner/search_path/volatility', async () => {
    await db.exec(migration);
    expect((await facts()).return_note).toBe(note);
    expect(await metadata()).toEqual(priorMetadata);
  });
});
