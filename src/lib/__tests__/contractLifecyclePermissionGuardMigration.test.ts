// Câu 26 (chủ chốt 21/10/2026): kiểm quyền ở MÁY CHỦ khớp đúng quyền web cho thanh lý, gia hạn và
// sửa trạng thái hợp đồng. Trước vá: web gác nút bằng contracts.terminate / contracts.renew nhưng
// RPC chỉ hỏi contracts.edit, và PATCH thẳng contracts.status chỉ cần contracts.edit (RLS).
//
// Chạy logic THẬT trên PGlite: thân production của 8 hàm (= thân trong migration bỏ đúng dòng mang
// dấu [q26]; md5 phải khớp md5 production ghim trong tiền kiểm), luồng trả phòng/quyết toán
// (20260928015559 + 20260929123356), adapter gia hạn (20260928035250) và renew_contract
// (20261011074456). Quyền giả lập bằng test.perms = danh sách khoá người gọi có ở toà A; đường REST =
// SET LOCAL ROLE authenticated; writer SECURITY DEFINER chạy dưới chủ hàm như production. Hàm tiền cũ
// (_impl) là stub ghi một hồ sơ COMPLETED — ranh giới tiền ngoài phạm vi vá.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PATCH = 'supabase/migrations/20261021180057_contract_lifecycle_permission_guard_v1.sql';
const EXIT_SOURCE = 'supabase/migrations/20260928015559_contract_exit_case_workflow.sql';
const EXIT_NOTE_SOURCE = 'supabase/migrations/20260929123356_contract_exit_return_note.sql';
const NOTICE_ADAPTER_SOURCE = 'supabase/migrations/20260928035250_contract_notice_action_adapters.sql';
const COMMISSION_REASON_SOURCE = 'supabase/migrations/20261011074456_commission_reason_audit_flow.sql';
const MARK = '-- [q26] kiểm quyền máy chủ khớp web';

const org = '00000000-0000-4000-8000-000000000001';
const actor = '00000000-0000-4000-8000-000000000002';
const building = '00000000-0000-4000-8000-000000000003';
const room = '00000000-0000-4000-8000-000000000004';
const contract = '00000000-0000-4000-8000-000000000005';
const room2 = '00000000-0000-4000-8000-000000000006';
const contract2 = '00000000-0000-4000-8000-000000000007';
const returnNote = 'Khách trả phòng, quyết toán sau.';
const FULL = 'contracts.view,contracts.create,contracts.edit,contracts.renew,contracts.terminate';
const NO_TERMINATE = 'contracts.view,contracts.create,contracts.edit,contracts.renew';
const NO_RENEW = 'contracts.view,contracts.create,contracts.edit,contracts.terminate';
const NO_EDIT = 'contracts.view,contracts.create,contracts.renew,contracts.terminate';

// Khớp từng chữ khuôn mà seam của 20260928015559 vá vào hàm tiền cũ.
const legacyGuard = "IF v_contract.status IN ('TERMINATED','EXPIRED') THEN RAISE EXCEPTION 'Hợp đồng đã thanh lý/hết hạn'; END IF;";
const physical = (date: string) =>
  `  UPDATE contracts\n     SET status = 'TERMINATED', actual_end_date = ${date}, notes = 'Legacy', updated_at = NOW()\n   WHERE id = p_contract_id;`;

function sliceFunction(path: string, header: string, end: string): string {
  const sql = readFileSync(path, 'utf8');
  const start = sql.indexOf(header);
  if (start < 0) throw new Error(`Không thấy ${header} trong ${path}`);
  return sql.slice(start, sql.indexOf(end, start) + end.length);
}

const patchSql = readFileSync(PATCH, 'utf8');

/**
 * Các khối CREATE OR REPLACE chép nguyên từ pg_get_functiondef (dòng 2 là " RETURNS …", thân bọc
 * $function$) — đúng những hàm được vá. Helper/trigger viết tay ("RETURNS" sát lề, $fn$) không khớp.
 */
function patchedBlocks(): string[] {
  return [...patchSql.matchAll(/CREATE OR REPLACE FUNCTION [^\n]*\n RETURNS [\s\S]*?\$function\$;\n/g)].map((m) => m[0]);
}

/** Thân production = khối vá bỏ đúng các dòng mang dấu [q26]. */
const prodBlock = (block: string) => block.split('\n').filter((line) => !line.includes(MARK)).join('\n');

/** (chữ ký, md5 production) ghim trong tiền kiểm của migration. */
function pinnedMd5(): Array<[string, string]> {
  const values = patchSql.slice(patchSql.indexOf('FOR r IN SELECT * FROM (VALUES'), patchSql.indexOf(') AS t(sig, md5)'));
  return [...values.matchAll(/\('([^']+)', '([0-9a-f]{32})'\)/g)].map((m) => [m[1], m[2]]);
}

async function build(db: PGlite, { patch }: { patch: boolean }) {
  // Stub kiểu sql tham chiếu hàm nạp sau (hàm thanh lý cũ, thân production) ⇒ không kiểm thân lúc tạo.
  await db.exec(`SET check_function_bodies = off;
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE TABLE auth.users(id uuid PRIMARY KEY); INSERT INTO auth.users VALUES('${actor}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT coalesce(nullif(current_setting('test.actor',true),''),'${actor}')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO authenticated, anon, service_role;
    CREATE TABLE organizations(id uuid PRIMARY KEY,status text DEFAULT 'ACTIVE'); INSERT INTO organizations(id) VALUES('${org}');
    CREATE TABLE buildings(id uuid PRIMARY KEY,organization_id uuid,name text,deleted_at timestamptz,UNIQUE(organization_id,id));
    INSERT INTO buildings(id,organization_id,name) VALUES('${building}','${org}','Building A');
    CREATE TABLE rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,name text,status text DEFAULT 'OCCUPIED',updated_at timestamptz,deleted_at timestamptz,UNIQUE(organization_id,id));
    INSERT INTO rooms(id,organization_id,building_id,name) VALUES('${room}','${org}','${building}','Room A'),('${room2}','${org}','${building}','Room A2');
    CREATE TABLE contracts(id uuid PRIMARY KEY,organization_id uuid,room_id uuid,contract_number text,status text DEFAULT 'ACTIVE',actual_end_date date,
      start_date date DEFAULT '2026-01-01',end_date date DEFAULT '2026-12-31',rent_price numeric DEFAULT 3000000,total_deposit numeric DEFAULT 3000000,
      deposit_paid numeric DEFAULT 3000000,expected_move_out_date date,commission_change_reason text,
      user_id uuid,tenant_id uuid,parent_contract_id uuid,notes text,updated_at timestamptz DEFAULT '2026-10-20',deleted_at timestamptz,UNIQUE(organization_id,id));
    GRANT SELECT, UPDATE ON contracts TO authenticated, service_role;
    CREATE TABLE customers(id uuid PRIMARY KEY,organization_id uuid,full_name text);
    CREATE TABLE profiles(id uuid PRIMARY KEY,full_name text,email text); INSERT INTO profiles VALUES('${actor}','Actor A',null);
    CREATE TABLE contract_customers(contract_id uuid,customer_id uuid,is_representative boolean);
    CREATE TABLE contract_tenants(contract_id uuid,tenant_id uuid);
    CREATE TABLE room_pass_listings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),room_id uuid,organization_id uuid,user_id uuid,active boolean,updated_at timestamptz);
    CREATE TABLE contract_terminations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),contract_id uuid UNIQUE REFERENCES contracts(id),organization_id uuid,user_id uuid,
      status text DEFAULT 'DRAFT',termination_type text,termination_date date,actual_move_out_date date,refund_method text,notes text,
      total_deposit numeric DEFAULT 0,outstanding_debt numeric DEFAULT 0,early_termination_fee numeric DEFAULT 0,notice_violation_fee numeric DEFAULT 0,
      damage_fee numeric DEFAULT 0,cleaning_fee numeric DEFAULT 0,other_fees numeric DEFAULT 0,prorated_rent numeric DEFAULT 0,prorated_services numeric DEFAULT 0,prorated_days integer DEFAULT 0,
      refund_amount numeric GENERATED ALWAYS AS (total_deposit - outstanding_debt - early_termination_fee - notice_violation_fee - damage_fee - cleaning_fee - other_fees - prorated_rent - prorated_services) STORED,
      approved_by uuid,approved_at timestamptz,refund_date timestamptz);
    CREATE TABLE income_expense_types(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,type text,name text,created_at timestamptz DEFAULT now());
    INSERT INTO income_expense_types(organization_id,type,name) VALUES('${org}','EXPENSE','Hoàn cọc thanh lý'),('${org}','INCOME','Thu thanh lý (khách trả thêm)');
    CREATE TABLE income_expenses(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,creator_name text,type text,name text,building_id uuid,room_id uuid,contract_id uuid,account_id uuid,
      payer_name text,approval_status text,voucher_date date,attachments jsonb,notes text,organization_id uuid,system_source text);
    CREATE TABLE income_expense_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),income_expense_id uuid,income_expense_type_id uuid,description text,quantity numeric,unit_price numeric,amount numeric,start_date date,end_date date);
    CREATE TABLE contract_move_out_notice_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,contract_id uuid,actor_id uuid,
      previous_date date,new_date date,reason text,contract_updated_at timestamptz,created_at timestamptz DEFAULT now());
    CREATE TABLE contract_notice_transition_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,contract_id uuid,building_id uuid,
      previous_room_id uuid,result_contract_id uuid,operation text,notice_choice text,previous_notice_date date,expected_updated_at timestamptz,
      reason text,actor_id uuid,request_id uuid UNIQUE,intent_hash text,created_at timestamptz DEFAULT now());
    CREATE TABLE app_private.commission_reason_contexts(context_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),xid xid8,backend_pid int,actor_id uuid,
      voucher_id uuid,contract_id uuid,kind text,stage text,reason text,baseline jsonb,created_at timestamptz DEFAULT clock_timestamp());
    CREATE TABLE accounts(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz,is_virtual boolean DEFAULT false);
    CREATE TABLE app_private.accounting_chain_writer_xids(transaction_id bigint,backend_pid int);
    CREATE TABLE app_private.termination_move_out_writer_context(transaction_id bigint,backend_pid int,organization_id uuid,user_id uuid,contract_id uuid,
      building_id uuid,room_id uuid,move_out_date date,opened_at timestamptz,PRIMARY KEY(transaction_id,backend_pid));
    CREATE TABLE canonical_calls(kind text,contract_id uuid,on_date date,args jsonb);
    CREATE FUNCTION app_private.record_contract_meter_boundary_set_v1(uuid,uuid,uuid,text,date,jsonb,text DEFAULT 'contracts.edit') RETURNS jsonb LANGUAGE sql AS $$ SELECT $6 $$;
    CREATE FUNCTION app_private.assert_contract_transfer_exit_terms_v1(uuid,text,jsonb) RETURNS void LANGUAGE sql AS $$ SELECT $$;
    -- Quyền giả lập: test.perms = khoá người gọi có ở toà A (mặc định đủ bộ); test.super = super admin.
    CREATE FUNCTION public.test_perms() RETURNS text[] LANGUAGE sql AS $$
      SELECT string_to_array(coalesce(nullif(current_setting('test.perms',true),''),'${FULL}'),',') $$;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('test.super',true),'')='yes' $$;
    CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1='${building}' $$;
    -- test.org_wide: mô phỏng can_v3 thật — quyền phạm vi toàn công ty trả true cả khi toà NULL.
    CREATE FUNCTION public.can_do_on_building(text,text,uuid) RETURNS boolean LANGUAGE sql AS $$
      SELECT public.is_super_admin() OR (($3='${building}' OR ($3 IS NULL AND coalesce(current_setting('test.org_wide',true),'')='yes'))
        AND ($1||'.'||$2)=ANY(public.test_perms())) $$;
    CREATE FUNCTION app_private.buildings_for_v3(text) RETURNS uuid[] LANGUAGE sql AS $$
      SELECT CASE WHEN $1=ANY(public.test_perms()) THEN ARRAY['${building}'::uuid] ELSE '{}'::uuid[] END $$;
    CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean) LANGUAGE sql AS $$
      SELECT $1=auth.uid() AND $2=ANY(public.my_org_ids()) AND $4='${building}' AND $3=ANY(public.test_perms()) $$;
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql AS $$ SELECT ARRAY['${org}'::uuid] $$;
    CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql AS $$ SELECT ARRAY[]::uuid[] $$;
    CREATE FUNCTION public.org_today_v1(uuid) RETURNS date LANGUAGE sql AS $$ SELECT '2026-10-21'::date $$;
    CREATE FUNCTION public.building_of_contract(uuid) RETURNS uuid LANGUAGE sql SECURITY DEFINER AS $$ SELECT r.building_id FROM contracts c JOIN rooms r ON r.id=c.room_id WHERE c.id=$1 $$;
    CREATE FUNCTION public.contract_deposit_paid_derived(uuid) RETURNS numeric LANGUAGE sql AS $$ SELECT 5000000::numeric $$;
    CREATE FUNCTION public.recompute_room_reservation(uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
    CREATE FUNCTION public.has_contract_termination_write_v1(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
    CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS bigint LANGUAGE plpgsql AS $$ BEGIN PERFORM 1 FROM organizations WHERE id=$1 FOR NO KEY UPDATE; RETURN 1; END $$;
    CREATE FUNCTION app_private.assert_contract_has_no_customer_credit_v1(uuid,uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
    CREATE FUNCTION app_private.begin_accounting_chain_write_v1() RETURNS void LANGUAGE sql AS $$
      INSERT INTO app_private.accounting_chain_writer_xids VALUES(txid_current(),pg_backend_pid()) $$;
    CREATE FUNCTION app_private.end_accounting_chain_write_v1() RETURNS void LANGUAGE sql AS $$
      DELETE FROM app_private.accounting_chain_writer_xids WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid() $$;
    -- Hàm tiền cũ (stub): một hồ sơ COMPLETED + một phiếu termination.*, như writer thật.
    CREATE FUNCTION public.terminate_contract_forfeit_impl(p_contract_id uuid,p_forfeit_date date,p_extra_charges jsonb DEFAULT '[]') RETURNS jsonb LANGUAGE plpgsql AS $fn$
    DECLARE v_contract record; BEGIN SELECT * INTO v_contract FROM contracts WHERE id=p_contract_id FOR UPDATE; ${legacyGuard}
    INSERT INTO canonical_calls VALUES('FORFEIT',p_contract_id,p_forfeit_date,'{}');
${physical('p_forfeit_date')}
    INSERT INTO contract_terminations(contract_id,organization_id,actual_move_out_date,status,termination_type) VALUES(p_contract_id,v_contract.organization_id,p_forfeit_date,'COMPLETED','FORFEIT');
    INSERT INTO income_expenses(type,name,contract_id,organization_id,system_source,approval_status) VALUES('INCOME','Bỏ cọc',p_contract_id,v_contract.organization_id,'termination.forfeit','UNAPPROVED');
    RETURN jsonb_build_object('contract_id',p_contract_id); END $fn$;
    CREATE FUNCTION public.terminate_contract_move_out_impl(p_contract_id uuid,p_move_out_date date,p_deposit_refund numeric,p_penalty_fee numeric,p_excess_rent numeric,p_outstanding_debt numeric,p_notes text,p_extra_charges jsonb,p_shortfall_mode text,p_receipt_account_id uuid,p_refund_items jsonb) RETURNS jsonb LANGUAGE plpgsql AS $fn$
    DECLARE v_contract record; BEGIN SELECT * INTO v_contract FROM contracts WHERE id=p_contract_id FOR UPDATE; ${legacyGuard}
    INSERT INTO canonical_calls VALUES('MOVE_OUT',p_contract_id,p_move_out_date,jsonb_build_object('deposit_refund',p_deposit_refund));
${physical('p_move_out_date')}
    INSERT INTO contract_terminations(contract_id,organization_id,actual_move_out_date,status,termination_type) VALUES(p_contract_id,v_contract.organization_id,p_move_out_date,'COMPLETED','NORMAL');
    INSERT INTO income_expenses(type,name,contract_id,organization_id,system_source,approval_status) VALUES('EXPENSE','Hoàn cọc',p_contract_id,v_contract.organization_id,'termination.refund','UNAPPROVED');
    RETURN jsonb_build_object('contract_id',p_contract_id); END $fn$;
    -- Bọc credit (stub): gọi đúng hàm thanh lý cũ (đã vá) như bản thật.
    CREATE FUNCTION public.terminate_contract_forfeit_with_credit_v1(uuid,date,jsonb,text) RETURNS jsonb LANGUAGE sql AS $$
      SELECT jsonb_build_object('termination',public.terminate_contract_forfeit($1,$2,$3)) $$;
    CREATE FUNCTION public.terminate_contract_move_out_with_credit_v1(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,text,jsonb DEFAULT '[]') RETURNS jsonb LANGUAGE sql AS $$
      SELECT jsonb_build_object('termination',public.terminate_contract_move_out($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$12)) $$;
    CREATE FUNCTION public.renew_contract_impl(p_contract_id uuid,p_new_end_date date,p_new_rent_price numeric DEFAULT NULL,p_new_deposit numeric DEFAULT NULL,p_notes text DEFAULT NULL)
      RETURNS uuid LANGUAGE plpgsql AS $fn$ BEGIN
      UPDATE contracts SET end_date=p_new_end_date,updated_at=clock_timestamp() WHERE id=p_contract_id;
      INSERT INTO canonical_calls VALUES('RENEW',p_contract_id,p_new_end_date,'{}'); RETURN p_contract_id; END $fn$;
  `);
  // Bảng + hàm luồng trả phòng (bản cũ), rồi adapter gia hạn và renew_contract đang chạy.
  await db.exec(readFileSync(EXIT_SOURCE, 'utf8'));
  await db.exec(readFileSync(EXIT_NOTE_SOURCE, 'utf8'));
  await db.exec(sliceFunction(COMMISSION_REASON_SOURCE, 'CREATE OR REPLACE FUNCTION app_private.begin_commission_reason_v1', 'END $$;'));
  await db.exec(sliceFunction(COMMISSION_REASON_SOURCE, 'CREATE OR REPLACE FUNCTION public.renew_contract(', 'END $$;'));
  await db.exec(sliceFunction(NOTICE_ADAPTER_SOURCE, 'CREATE OR REPLACE FUNCTION app_private.apply_contract_notice_transition_v1', 'END $fn$;'));
  await db.exec(sliceFunction(NOTICE_ADAPTER_SOURCE, 'CREATE OR REPLACE FUNCTION public.renew_contract_with_notice_v1', 'END $fn$;'));
  // Thân production của 8 hàm sẽ vá (đúng bytes production — xem test md5 bên dưới).
  for (const block of patchedBlocks()) await db.exec(prodBlock(block));
  await db.exec('RESET check_function_bodies');
  if (patch) {
    // Áp hai lượt: lane kiểm idempotency, lượt hai phải đi nhánh "đã vá".
    await db.exec(patchSql);
    await db.exec(patchSql);
  }
}

const before = new PGlite();
const after = new PGlite();

beforeAll(async () => {
  await Promise.all([build(before, { patch: false }), build(after, { patch: true })]);
}, 60000);
afterAll(async () => {
  await Promise.all([before.close(), after.close()]);
});

type Row = Record<string, unknown>;
type DbError = { code?: string; message?: string };

async function scenario(db: PGlite, fn: () => Promise<void>) {
  await db.exec(`BEGIN;
    INSERT INTO contracts(id,organization_id,room_id,contract_number,user_id) VALUES
      ('${contract}','${org}','${room}','HD-A','${actor}'),
      ('${contract2}','${org}','${room2}','HD-A2','${actor}');`);
  try {
    await fn();
  } finally {
    await db.exec('ROLLBACK');
  }
}

const grantPerms = (db: PGlite, perms: string) => db.exec(`SELECT set_config('test.perms','${perms}',true)`);

/** Gọi như trình duyệt qua PostgREST: vai authenticated. Edge/cron dùng service_role. */
async function asUser<T extends Row>(db: PGlite, sql: string, params: unknown[] = [], role = 'authenticated') {
  await db.exec(`SET LOCAL ROLE ${role}`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function rejectedAsUser(db: PGlite, sql: string, params: unknown[], code: string, message?: RegExp) {
  await db.exec('SAVEPOINT expected_failure; SET LOCAL ROLE authenticated');
  try {
    const err = await db.query(sql, params).then(() => null, (e: unknown) => e as DbError);
    expect(err, `phải lỗi ${code}: ${sql}`).not.toBeNull();
    expect(err?.code).toBe(code);
    if (message) expect(err?.message).toMatch(message);
  } finally {
    await db.exec('ROLLBACK TO SAVEPOINT expected_failure; RELEASE SAVEPOINT expected_failure');
  }
}

async function count(db: PGlite, sql: string, params: unknown[] = []) {
  return (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) q`, params)).rows[0].n;
}

async function contractRow(db: PGlite, id = contract) {
  return (await db.query<Row>('SELECT status, actual_end_date::text AS actual_end_date, end_date::text AS end_date, expected_move_out_date::text AS notice FROM contracts WHERE id=$1', [id])).rows[0];
}

const CONFIRM = 'SELECT confirm_contract_return_v1($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10) AS result';
const confirmArgs = (mode: 'DEFERRED' | 'IMMEDIATE', kind = 'EARLY_RETURN', target = contract) =>
  [org, target, '2026-10-20', `physical-key-${target.slice(-4)}`, '2026-10-21', kind, mode, mode === 'IMMEDIATE' ? '{}' : null, null, returnNote];
const FINALIZE = 'SELECT finalize_contract_exit_case_v1($1,$2,$3,$4,$5,$6,$7::jsonb) AS result';
const finalizeArgs = (caseId: unknown) =>
  [org, caseId, 1, 'settlement-key-0001', 'EARLY_RETURN', null, JSON.stringify({ deposit_refund: 100, shortfall_mode: 'DEBT' })];
const KIND = 'SELECT update_contract_exit_case_kind_v1($1,$2,$3,$4,$5,$6) AS result';
const kindArgs = (caseId: unknown) => [org, caseId, 1, 'NATURAL_EXPIRY', 'Hết hạn đúng hợp đồng', 'kind-key-0001'];
const MOVE_OUT = "SELECT terminate_contract_move_out($1,'2026-10-21',100,0,0,0,'ghi chú','[]'::jsonb,'DEBT',NULL,'[]'::jsonb) AS result";
const FORFEIT = "SELECT terminate_contract_forfeit($1,'2026-10-21','[]'::jsonb) AS result";
const APPROVE = 'SELECT approve_contract_termination_v1($1, NULL) AS result';
const NOTICE = "SELECT set_contract_move_out_notice_v1($1,$2,'2026-10-20','2026-11-15',NULL) AS result";
const RENEW_NOTICE = "SELECT renew_contract_with_notice_v1($1,$2,'2026-10-20','2027-06-30','KEEP',$3) AS result";
const RENEW = "SELECT renew_contract($1,'2027-06-30',NULL,NULL,'Gia hạn 6 tháng') AS result";
const requestId = '00000000-0000-4000-8000-0000000000a1';

async function pendingCase(db: PGlite) {
  await grantPerms(db, FULL);
  const [{ result }] = await asUser<{ result: Row }>(db, CONFIRM, confirmArgs('DEFERRED'));
  return result.id;
}

async function seedDraft(db: PGlite) {
  return (await db.query<{ id: string }>(
    `INSERT INTO contract_terminations(contract_id,organization_id,status,total_deposit,refund_method) VALUES($1,$2,'DRAFT',3000000,'CASH') RETURNING id`,
    [contract, org])).rows[0].id;
}

const TERMINATE = /\[THIEU_QUYEN:contracts\.terminate\]/;
const RENEW_DENIED = /\[THIEU_QUYEN:contracts\.renew\]/;
const LIFECYCLE = /\[HOP_DONG_VONG_DOI_QUA_RPC\]/;

describe('migration — ghim thân production và tự kiểm catalog', () => {
  it('8 thân nạp từ migration (bỏ dòng [q26]) có đúng md5 production đã ghim', async () => {
    const pins = pinnedMd5();
    expect(pins).toHaveLength(8);
    expect(patchedBlocks()).toHaveLength(8);
    for (const [sig, md5] of pins) {
      const got = (await before.query<{ md5: string }>('SELECT md5(pg_get_functiondef($1::regprocedure)) AS md5', [sig])).rows[0].md5;
      expect(got, sig).toBe(md5);
    }
  });

  it('mỗi hàm vá chỉ thêm đúng một dòng kiểm quyền, còn lại giữ nguyên từng chữ', async () => {
    for (const [sig] of pinnedMd5()) {
      const [b, a] = await Promise.all([before, after].map(async (db) =>
        (await db.query<{ def: string }>('SELECT pg_get_functiondef($1::regprocedure) AS def', [sig])).rows[0].def));
      const added = a.split('\n').filter((line) => !b.split('\n').includes(line));
      expect(added, sig).toHaveLength(1);
      expect(added[0]).toContain('app_private.require_building_perm_v1(');
      expect(added[0]).toContain(MARK);
      expect(prodBlock(a)).toBe(b);
    }
  });

  it('ACL các hàm vá giữ nguyên (CREATE OR REPLACE không đổi quyền gọi)', async () => {
    for (const [sig] of pinnedMd5()) {
      const [b, a] = await Promise.all([before, after].map(async (db) =>
        (await db.query<{ acl: string | null; definer: boolean }>(
          'SELECT proacl::text AS acl, prosecdef AS definer FROM pg_proc WHERE oid=$1::regprocedure', [sig])).rows[0]));
      expect(a, sig).toEqual(b);
      expect(a.definer).toBe(true);
    }
  });

  it('dừng 55000 khi thân đang chạy khác bản đã đối chiếu', async () => {
    await before.exec('BEGIN');
    try {
      await before.exec(prodBlock(patchedBlocks()[0]).replace('USING ERRCODE', 'USING  ERRCODE'));
      await expect(before.exec(patchSql)).rejects.toMatchObject({ code: '55000' });
    } finally {
      await before.exec('ROLLBACK');
    }
  });

  it('helper kiểm quyền và hàm trigger không ai gọi trực tiếp được; trigger chỉ chạy trên đường REST', async () => {
    const helper = (await after.query<Row>(`SELECT prosecdef, provolatile,
        has_function_privilege('authenticated', oid, 'EXECUTE') AS auth_exec,
        has_function_privilege('anon', oid, 'EXECUTE') AS anon_exec
      FROM pg_proc WHERE oid = 'app_private.require_building_perm_v1(uuid,text,text[])'::regprocedure`)).rows[0];
    expect(helper).toEqual({ prosecdef: true, provolatile: 'v', auth_exec: false, anon_exec: false });
    const trg = (await after.query<Row>(`SELECT pg_get_triggerdef(t.oid) AS def,
        has_function_privilege('authenticated', t.tgfoid, 'EXECUTE') AS auth_exec
      FROM pg_trigger t WHERE t.tgname = 'a01_contract_lifecycle_columns_guard'`)).rows;
    expect(trg).toHaveLength(1);
    expect(trg[0].def).toMatch(/BEFORE UPDATE OF status, actual_end_date, expected_move_out_date ON public\.contracts/);
    expect(trg[0].def).toMatch(/WHEN \(\(CURRENT_USER = ANY \(ARRAY\['authenticated'::name, 'anon'::name\]\)\)\)/);
    expect(trg[0].auth_exec).toBe(false);
  });
});

/** Lỗi mong đợi khi gọi dưới vai chủ DB (helper app_private chỉ chủ hàm gọi được). */
async function rejected(db: PGlite, sql: string, code: string, message?: RegExp) {
  await db.exec('SAVEPOINT expected_failure');
  try {
    const err = await db.query(sql).then(() => null, (e: unknown) => e as DbError);
    expect(err, `phải lỗi ${code}: ${sql}`).not.toBeNull();
    expect(err?.code).toBe(code);
    if (message) expect(err?.message).toMatch(message);
  } finally {
    await db.exec('ROLLBACK TO SAVEPOINT expected_failure; RELEASE SAVEPOINT expected_failure');
  }
}

describe('hàm dùng chung require_building_perm_v1', () => {
  const call = (building: string, ...keys: string[]) =>
    `SELECT app_private.require_building_perm_v1(${building}, 'thử', ${keys.map((k) => `'${k}'`).join(', ')})`;

  it('đủ một trong các khoá ở đúng toà ⇒ qua; không khoá nào ⇒ 42501 nêu đủ các khoá', () => scenario(after, async () => {
    await grantPerms(after, 'contracts.renew');
    await after.query(call(`'${building}'`, 'contracts.terminate', 'contracts.renew'));
    await rejected(after, call(`'${building}'`, 'contracts.terminate', 'contracts.edit'), '42501',
      /\[THIEU_QUYEN:contracts\.terminate\|contracts\.edit\] Bạn không có quyền thử ở toà nhà này/);
  }));

  it('toà NULL: người thường bị từ chối kể cả khi quyền toàn công ty trả true; super admin qua', () => scenario(after, async () => {
    await after.exec("SELECT set_config('test.org_wide','yes',true)");
    await grantPerms(after, FULL);
    expect((await after.query<{ ok: boolean }>("SELECT public.can_do_on_building('contracts','terminate',NULL) AS ok")).rows[0].ok).toBe(true);
    await rejected(after, call('NULL', 'contracts.terminate'), '42501', TERMINATE);
    await after.exec("SELECT set_config('test.super','yes',true)");
    await after.query(call('NULL', 'contracts.terminate'));
  }));

  it('khoá sai dạng ⇒ 22023; chưa đăng nhập ⇒ 42501', () => scenario(after, async () => {
    await rejected(after, call(`'${building}'`, 'contracts terminate'), '22023');
    await after.exec(`SELECT set_config('test.actor','',true)`);
    await after.exec(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$`);
    await rejected(after, call(`'${building}'`, 'contracts.terminate'), '42501', /chưa đăng nhập/);
  }));
});

describe('trước vá — tái hiện lỗ trên định nghĩa đang chạy', () => {
  it('thiếu contracts.terminate vẫn trả phòng được (web giấu nút, máy chủ chỉ hỏi contracts.edit)', () => scenario(before, async () => {
    await grantPerms(before, NO_TERMINATE);
    const [{ result }] = await asUser<{ result: Row }>(before, CONFIRM, confirmArgs('DEFERRED'));
    expect(result).toMatchObject({ state: 'PENDING' });
    expect(await contractRow(before)).toMatchObject({ status: 'TERMINATED', actual_end_date: '2026-10-21' });
  }));

  it('thiếu contracts.renew vẫn gia hạn được', () => scenario(before, async () => {
    await grantPerms(before, NO_RENEW);
    await asUser(before, RENEW, [contract]);
    expect(await contractRow(before)).toMatchObject({ end_date: '2027-06-30' });
  }));

  it('PATCH thẳng contracts.status qua REST lách mọi luồng thanh lý', () => scenario(before, async () => {
    await asUser(before, "UPDATE contracts SET status='TERMINATED', actual_end_date='2026-10-21' WHERE id=$1", [contract]);
    expect(await contractRow(before)).toMatchObject({ status: 'TERMINATED' });
    expect(await count(before, 'SELECT 1 FROM contract_terminations')).toBe(0);
  }));
});

describe('sau vá — thanh lý đòi contracts.terminate ở mọi đường', () => {
  it.each([
    ['trả phòng, quyết toán sau (DEFERRED)', CONFIRM, () => confirmArgs('DEFERRED')],
    ['trả phòng + quyết toán ngay (IMMEDIATE)', CONFIRM, () => confirmArgs('IMMEDIATE')],
    ['thanh lý cũ gọi thẳng (terminate_contract_move_out)', MOVE_OUT, () => [contract]],
    ['bỏ cọc cũ gọi thẳng (terminate_contract_forfeit)', FORFEIT, () => [contract]],
    ['báo ngày trả phòng (set_contract_move_out_notice_v1)', NOTICE, () => [org, contract]],
  ])('%s thiếu contracts.terminate ⇒ 42501, không ghi gì', (_label, sql, args) => scenario(after, async () => {
    await grantPerms(after, NO_TERMINATE);
    await rejectedAsUser(after, sql, args(), '42501', TERMINATE);
    expect(await contractRow(after)).toMatchObject({ status: 'ACTIVE', actual_end_date: null, notice: null });
    expect(await count(after, 'SELECT 1 FROM contract_exit_cases')).toBe(0);
    expect(await count(after, 'SELECT 1 FROM contract_terminations')).toBe(0);
    expect(await count(after, 'SELECT 1 FROM income_expenses')).toBe(0);
  }));

  it.each([
    ['quyết toán ca chờ (finalize_contract_exit_case_v1)', FINALIZE, finalizeArgs],
    ['đổi loại thanh lý (update_contract_exit_case_kind_v1)', KIND, kindArgs],
  ])('%s thiếu contracts.terminate ⇒ 42501, ca vẫn PENDING', (_label, sql, args) => scenario(after, async () => {
    const caseId = await pendingCase(after);
    await grantPerms(after, NO_TERMINATE);
    await rejectedAsUser(after, sql, args(caseId), '42501', TERMINATE);
    const row = (await after.query<Row>('SELECT state, current_kind, version::int AS version FROM contract_exit_cases WHERE id=$1', [caseId])).rows[0];
    expect(row).toEqual({ state: 'PENDING', current_kind: 'EARLY_RETURN', version: 1 });
    expect(await count(after, 'SELECT 1 FROM contract_terminations')).toBe(0);
  }));

  it('duyệt hồ sơ thanh lý cũ (approve_contract_termination_v1) thiếu contracts.terminate ⇒ 42501, không phiếu', () => scenario(after, async () => {
    const id = await seedDraft(after);
    await grantPerms(after, NO_TERMINATE);
    await rejectedAsUser(after, APPROVE, [id], '42501', TERMINATE);
    expect(await count(after, 'SELECT 1 FROM income_expenses')).toBe(0);
    expect(await contractRow(after)).toMatchObject({ status: 'ACTIVE' });
  }));

  it('thiếu contracts.edit thì vẫn bị rào cũ chặn (không nới quyền): 42501 không phải [THIEU_QUYEN]', () => scenario(after, async () => {
    await grantPerms(after, NO_EDIT);
    for (const [sql, args] of [[CONFIRM, confirmArgs('DEFERRED')], [MOVE_OUT, [contract]], [FORFEIT, [contract]], [NOTICE, [org, contract]]] as const) {
      await rejectedAsUser(after, sql, [...args], '42501', /^(?!.*THIEU_QUYEN)/);
    }
  }));
});

describe('sau vá — gia hạn đòi contracts.renew ở mọi đường', () => {
  it.each([
    ['web (renew_contract_with_notice_v1)', RENEW_NOTICE, () => [org, contract, requestId]],
    ['gọi thẳng renew_contract', RENEW, () => [contract]],
  ])('%s thiếu contracts.renew ⇒ 42501, hạn hợp đồng không đổi', (_label, sql, args) => scenario(after, async () => {
    await grantPerms(after, NO_RENEW);
    await rejectedAsUser(after, sql, args(), '42501', RENEW_DENIED);
    expect(await contractRow(after)).toMatchObject({ end_date: '2026-12-31' });
    expect(await count(after, 'SELECT 1 FROM contract_notice_transition_events')).toBe(0);
  }));

  it('thiếu contracts.renew không ảnh hưởng thanh lý', () => scenario(after, async () => {
    await grantPerms(after, NO_RENEW);
    const [{ result }] = await asUser<{ result: Row }>(after, CONFIRM, confirmArgs('DEFERRED'));
    expect(result).toMatchObject({ state: 'PENDING' });
  }));
});

describe('sau vá — đủ quyền (và super admin) vẫn chạy như cũ', () => {
  it('trả phòng DEFERRED → quyết toán sau: writer DEFINER đổi trạng thái, đúng 1 hồ sơ COMPLETED', () => scenario(after, async () => {
    const caseId = await pendingCase(after);
    expect(await contractRow(after)).toMatchObject({ status: 'TERMINATED', actual_end_date: '2026-10-21' });
    const [{ result }] = await asUser<{ result: Row }>(after, FINALIZE, finalizeArgs(caseId));
    expect(result).toMatchObject({ state: 'FINALIZED' });
    expect(await count(after, "SELECT 1 FROM contract_terminations WHERE status='COMPLETED'")).toBe(1);
    expect(await count(after, "SELECT 1 FROM canonical_calls WHERE kind='MOVE_OUT'")).toBe(1);
  }));

  it('trả phòng IMMEDIATE (chuỗi run_contract_exit_settlement → bọc credit → hàm thanh lý cũ đã vá) chạy', () => scenario(after, async () => {
    await grantPerms(after, FULL);
    const [{ result }] = await asUser<{ result: Row }>(after, CONFIRM, confirmArgs('IMMEDIATE'));
    expect(result).toMatchObject({ state: 'FINALIZED' });
  }));

  it('bỏ cọc IMMEDIATE (FORFEIT) đi qua terminate_contract_forfeit đã vá', () => scenario(after, async () => {
    await grantPerms(after, FULL);
    const [{ result }] = await asUser<{ result: Row }>(after, CONFIRM, confirmArgs('IMMEDIATE', 'FORFEIT'));
    expect(result).toMatchObject({ state: 'FINALIZED' });
    expect(await count(after, "SELECT 1 FROM canonical_calls WHERE kind='FORFEIT'")).toBe(1);
  }));

  it('đổi loại thanh lý, báo trả, gia hạn qua web, duyệt hồ sơ cũ đều chạy khi đủ quyền', () => scenario(after, async () => {
    const caseId = await pendingCase(after);
    const [{ result: kind }] = await asUser<{ result: Row }>(after, KIND, kindArgs(caseId));
    expect(kind).toMatchObject({ current_kind: 'NATURAL_EXPIRY' });
    const [{ result: notice }] = await asUser<{ result: Row }>(after, NOTICE, [org, contract2]);
    expect(notice).toMatchObject({ expected_move_out_date: '2026-11-15' });
    await after.exec(`UPDATE contracts SET updated_at='2026-10-20' WHERE id='${contract2}'`);
    await asUser(after, RENEW_NOTICE, [org, contract2, requestId]);
    expect(await contractRow(after, contract2)).toMatchObject({ end_date: '2027-06-30', notice: '2026-11-15' });
  }));

  it('duyệt hồ sơ thanh lý cũ khi đủ quyền vẫn chạy', () => scenario(after, async () => {
    await grantPerms(after, FULL);
    const id = await seedDraft(after);
    const [{ result }] = await asUser<{ result: Row }>(after, APPROVE, [id]);
    expect(result).toMatchObject({ status: 'COMPLETED' });
    expect(await contractRow(after)).toMatchObject({ status: 'TERMINATED' });
  }));

  it('super admin không có khoá tenant vẫn qua rào mới ở hàm vốn cho super admin', () => scenario(after, async () => {
    await grantPerms(after, 'none.none');
    await after.exec("SELECT set_config('test.super','yes',true)");
    await asUser(after, RENEW, [contract]);
    expect(await contractRow(after)).toMatchObject({ end_date: '2027-06-30' });
    await asUser(after, FORFEIT, [contract2]);
    expect(await contractRow(after, contract2)).toMatchObject({ status: 'TERMINATED' });
  }));
});

describe('sau vá — sửa trạng thái hợp đồng thẳng qua REST bị chặn', () => {
  it.each([
    ['status', "SET status='TERMINATED'"],
    ['actual_end_date', "SET actual_end_date='2026-10-21'"],
    ['expected_move_out_date', "SET expected_move_out_date='2026-11-15'"],
  ])('authenticated đổi %s ⇒ 42501, không đổi gì', (_col, set) => scenario(after, async () => {
    await rejectedAsUser(after, `UPDATE contracts ${set} WHERE id=$1`, [contract], '42501', LIFECYCLE);
    expect(await contractRow(after)).toMatchObject({ status: 'ACTIVE', actual_end_date: null, notice: null });
  }));

  it('super admin đi đường REST cũng bị chặn (sửa dữ liệu dùng service_role)', () => scenario(after, async () => {
    await after.exec("SELECT set_config('test.super','yes',true)");
    await rejectedAsUser(after, "UPDATE contracts SET status='TERMINATED' WHERE id=$1", [contract], '42501', LIFECYCLE);
  }));

  it('sửa cột khác, hoặc gửi lại đúng trạng thái đang có, vẫn được', () => scenario(after, async () => {
    await asUser(after, "UPDATE contracts SET notes='ghi chú', status='ACTIVE', expected_move_out_date=NULL WHERE id=$1", [contract]);
    expect((await after.query<Row>('SELECT notes FROM contracts WHERE id=$1', [contract])).rows[0].notes).toBe('ghi chú');
  }));

  it('service_role (Edge/cron) đi thẳng như cũ', () => scenario(after, async () => {
    await asUser(after, "UPDATE contracts SET status='TERMINATED', actual_end_date='2026-10-21' WHERE id=$1", [contract], 'service_role');
    expect(await contractRow(after)).toMatchObject({ status: 'TERMINATED' });
  }));
});
