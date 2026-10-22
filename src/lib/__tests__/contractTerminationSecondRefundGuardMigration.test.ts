// P0a — lỗ "phiếu hoàn cọc thứ hai" ở thanh lý hợp đồng (chủ duyệt 21/10/2026).
//
// Chuỗi lỗ: người có contracts.create INSERT một dòng contract_terminations DRAFT qua
// REST cho hợp đồng ĐÃ trả phòng, rồi approve_contract_termination_v1 ghi thêm phiếu
// hoàn/thu nháp (system_source rỗng) và dòng DRAFT chiếm UNIQUE(contract_id) khiến
// finalize_contract_exit_case_v1 kẹt 23505.
//
// Chạy logic THẬT trên PGlite: approve bản đang chạy (20260915074638), guard a00
// (20260731011000), luồng trả phòng/quyết toán (20260928015559 + 20260929123356), rồi
// migration vá. Đường REST = SET LOCAL ROLE authenticated + RLS rút gọn; writer
// SECURITY DEFINER chạy dưới chủ hàm như production. Hàm tiền cũ (trả phòng/bỏ cọc) là
// stub ghi một phiếu termination.* — ranh giới tiền ngoài phạm vi vá.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PATCH = 'supabase/migrations/20261021114556_contract_termination_second_refund_guard_v1.sql';
// Câu 26 (22/10/2026) thay định nghĩa sống của approve: thân P0a + một dòng kiểm contracts.terminate.
const Q26_SOURCE = 'supabase/migrations/20261021180057_contract_lifecycle_permission_guard_v1.sql';
const APPROVE_SOURCE = 'supabase/migrations/20260915074638_coc_thanh_ly_va_cap_hoan_coc.sql';
const GUARD_SOURCE = 'supabase/migrations/20260731011000_slice_minus1_guards.sql';
const EXIT_SOURCE = 'supabase/migrations/20260928015559_contract_exit_case_workflow.sql';
const EXIT_NOTE_SOURCE = 'supabase/migrations/20260929123356_contract_exit_return_note.sql';
const PROD_APPROVE_MD5 = '750d2d72248d9557713ff6c82eedfe51';

const org = '00000000-0000-4000-8000-000000000001';
const actor = '00000000-0000-4000-8000-000000000002';
const building = '00000000-0000-4000-8000-000000000003';
const room = '00000000-0000-4000-8000-000000000004';
const contract = '00000000-0000-4000-8000-000000000005';
const room2 = '00000000-0000-4000-8000-000000000006';
const contract2 = '00000000-0000-4000-8000-000000000007';
const otherOrg = '00000000-0000-4000-8000-000000000011';
const otherBuilding = '00000000-0000-4000-8000-000000000013';
const otherRoom = '00000000-0000-4000-8000-000000000014';
const otherContract = '00000000-0000-4000-8000-000000000015';
const returnNote = 'Khách trả phòng, quyết toán sau.';

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

// Định nghĩa SỐNG = lần CREATE cuối theo timestamp migration (khuôn liveDefinitionOf ở
// salaryCompletionDate.test.ts), cắt từ CREATE tới hết thân dollar-quoted. Đọc thư mục một lần.
let migrationCorpus: string[] | null = null;
function liveFunctionSql(schema: string, fnName: string): string {
  migrationCorpus ??= readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort()
    .map((f) => readFileSync(join('supabase/migrations', f), 'utf8').replace(/--[^\n]*/g, ''));
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${schema}\\.${fnName}\\s*\\(`, 'gi');
  let hit: string | null = null;
  for (const sql of migrationCorpus) {
    for (const m of sql.matchAll(re)) hit = sql.slice(m.index);
  }
  if (!hit) throw new Error(`Không tìm thấy định nghĩa nào của ${schema}.${fnName}`);
  const tag = /\bAS\s+(\$[A-Za-z0-9_]*\$)/.exec(hit);
  if (!tag) throw new Error(`Không thấy thân hàm ${schema}.${fnName}`);
  return `${hit.slice(0, hit.indexOf(tag[1], tag.index + tag[0].length) + tag[1].length)};`;
}

async function build(db: PGlite, { patch }: { patch: boolean }) {
  await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE TABLE auth.users(id uuid PRIMARY KEY); INSERT INTO auth.users VALUES('${actor}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT coalesce(nullif(current_setting('test.actor',true),''),'${actor}')::uuid $$;
    CREATE TABLE organizations(id uuid PRIMARY KEY); INSERT INTO organizations VALUES('${org}'),('${otherOrg}');
    CREATE TABLE buildings(id uuid PRIMARY KEY,organization_id uuid,name text,UNIQUE(organization_id,id));
    INSERT INTO buildings VALUES('${building}','${org}','Building A'),('${otherBuilding}','${otherOrg}','Building B');
    CREATE TABLE rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,name text,status text DEFAULT 'OCCUPIED',updated_at timestamptz,UNIQUE(organization_id,id));
    INSERT INTO rooms(id,organization_id,building_id,name) VALUES('${room}','${org}','${building}','Room A'),('${room2}','${org}','${building}','Room A2'),('${otherRoom}','${otherOrg}','${otherBuilding}','Room B');
    CREATE TABLE contracts(id uuid PRIMARY KEY,organization_id uuid,room_id uuid,contract_number text,status text DEFAULT 'ACTIVE',actual_end_date date,start_date date DEFAULT '2026-01-01',user_id uuid,tenant_id uuid,parent_contract_id uuid,notes text,updated_at timestamptz DEFAULT '2026-10-20',deleted_at timestamptz,UNIQUE(organization_id,id));
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
    CREATE TABLE canonical_calls(kind text,contract_id uuid,on_date date,args jsonb);
    CREATE FUNCTION app_private.record_contract_meter_boundary_set_v1(uuid,uuid,uuid,text,date,jsonb,text DEFAULT 'contracts.edit') RETURNS jsonb LANGUAGE sql AS $$ SELECT $6 $$;
    -- test.cross_building: có quyền ở toà công ty khác dù không là thành viên (trạng thái lệch) — để thử riêng vế công ty.
    -- test.view_denied: thiếu buildings.view; test.deny_key: thiếu đúng một khoá quyền (vd contracts.create).
    CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql AS $$
      SELECT ($1='${building}' OR ($1='${otherBuilding}' AND coalesce(current_setting('test.cross_building',true),'')='yes'))
        AND coalesce(current_setting('test.denied',true),'')<>'yes' AND coalesce(current_setting('test.view_denied',true),'')<>'yes' $$;
    CREATE FUNCTION app_private.buildings_for_v3(text) RETURNS uuid[] LANGUAGE sql AS $$
      SELECT ARRAY(SELECT b FROM unnest(ARRAY['${building}'::uuid,'${otherBuilding}'::uuid]) b
        WHERE (b='${building}' OR coalesce(current_setting('test.cross_building',true),'')='yes')
          AND coalesce(current_setting('test.denied',true),'')<>'yes' AND coalesce(current_setting('test.deny_key',true),'')<>$1) $$;
    CREATE FUNCTION public.can_do_on_building(text,text,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT can_access_building($3) $$;
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql AS $$ SELECT ARRAY['${org}'::uuid] $$;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('test.super',true),'')='yes' $$;
    CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql AS $$ SELECT ARRAY[]::uuid[] $$;
    CREATE FUNCTION public.org_today_v1(uuid) RETURNS date LANGUAGE sql AS $$ SELECT '2026-10-21'::date $$;
    CREATE FUNCTION public.building_of_contract(uuid) RETURNS uuid LANGUAGE sql SECURITY DEFINER AS $$ SELECT r.building_id FROM contracts c JOIN rooms r ON r.id=c.room_id WHERE c.id=$1 $$;
    CREATE FUNCTION public.contract_deposit_paid_derived(uuid) RETURNS numeric LANGUAGE sql AS $$ SELECT 5000000::numeric $$;
    CREATE FUNCTION public.recompute_room_reservation(uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
    -- Cửa writer của guard a00: mở bằng cờ để thử nhánh bỏ qua.
    CREATE FUNCTION public.has_contract_termination_write_v1(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('test.writer',true),'')='yes' $$;
    CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS bigint LANGUAGE plpgsql AS $$ BEGIN PERFORM 1 FROM organizations WHERE id=$1 FOR NO KEY UPDATE; RETURN 1; END $$;
    CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean) LANGUAGE sql AS $$ SELECT $1=auth.uid() AND $2=ANY(my_org_ids()) AND $3='contracts.edit' AND can_access_building($4) $$;
    -- Hàm tiền cũ (stub): một phiếu termination.* + dòng hồ sơ COMPLETED, như writer thật.
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
    CREATE FUNCTION public.terminate_contract_forfeit_with_credit_v1(uuid,date,jsonb,text) RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('termination',terminate_contract_forfeit_impl($1,$2,$3)) $$;
    CREATE FUNCTION public.terminate_contract_move_out_with_credit_v1(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,text,jsonb DEFAULT '[]') RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('termination',terminate_contract_move_out_impl($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$12)) $$;
  `);
  await db.exec(readFileSync(EXIT_SOURCE, 'utf8'));
  await db.exec(readFileSync(EXIT_NOTE_SOURCE, 'utf8'));
  // Bản đang chạy của approve và guard a00, rồi đường REST rút gọn: RLS theo policy production
  // (INSERT = contracts.create, UPDATE = contracts.edit, ranh giới công ty).
  await db.exec(sliceFunction(APPROVE_SOURCE, 'CREATE OR REPLACE FUNCTION public.approve_contract_termination_v1', '$function$;'));
  await db.exec(sliceFunction(GUARD_SOURCE, 'CREATE OR REPLACE FUNCTION public.guard_contract_termination_settlement()', '$fn$;'));
  await db.exec(`CREATE TRIGGER a00_contract_termination_settlement_guard BEFORE INSERT OR UPDATE ON contract_terminations
      FOR EACH ROW EXECUTE FUNCTION public.guard_contract_termination_settlement();
    ALTER TABLE contract_terminations ENABLE ROW LEVEL SECURITY;
    CREATE POLICY ct_select ON contract_terminations FOR SELECT USING (organization_id = ANY (public.my_org_ids()));
    CREATE POLICY ct_insert ON contract_terminations FOR INSERT WITH CHECK (organization_id = ANY (public.my_org_ids())
      AND public.building_of_contract(contract_id) = ANY (app_private.buildings_for_v3('contracts.create')));
    CREATE POLICY ct_update ON contract_terminations FOR UPDATE USING (organization_id = ANY (public.my_org_ids()))
      WITH CHECK (organization_id = ANY (public.my_org_ids()) AND public.building_of_contract(contract_id) = ANY (app_private.buildings_for_v3('contracts.edit')));
    CREATE POLICY ct_super_admin_all ON contract_terminations TO authenticated USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());
    GRANT SELECT, INSERT, UPDATE ON contract_terminations TO authenticated, service_role;
    ALTER ROLE service_role BYPASSRLS;`);
  if (patch) {
    // Áp hai lượt: lane kiểm idempotency, lượt hai phải đi nhánh "đã vá".
    await db.exec(readFileSync(PATCH, 'utf8'));
    await db.exec(readFileSync(PATCH, 'utf8'));
    // Rồi định nghĩa SỐNG của approve (câu 26) — mọi khẳng định P0a bên dưới chạy trên bản đó.
    // Stub can_do_on_building ở trên không xét khoá, nên dòng kiểm contracts.terminate qua được
    // đúng như người đủ quyền; ca thiếu quyền của câu 26 nằm ở contractLifecyclePermissionGuardMigration.
    // Hàm kiểm quyền lấy định nghĩa SỐNG: câu 25 chuyển phép kiểm sang has_building_perm_v1.
    await db.exec(liveFunctionSql('app_private', 'has_building_perm_v1'));
    await db.exec(liveFunctionSql('app_private', 'require_building_perm_v1'));
    await db.exec(sliceFunction(Q26_SOURCE, 'CREATE OR REPLACE FUNCTION public.approve_contract_termination_v1', '$function$;'));
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

async function scenario(db: PGlite, fn: () => Promise<void>) {
  await db.exec(`BEGIN;
    INSERT INTO contracts(id,organization_id,room_id,contract_number,user_id) VALUES
      ('${contract}','${org}','${room}','HD-A','${actor}'),
      ('${contract2}','${org}','${room2}','HD-A2','${actor}'),
      ('${otherContract}','${otherOrg}','${otherRoom}','HD-B','${actor}');`);
  try {
    await fn();
  } finally {
    await db.exec('ROLLBACK');
  }
}

/** Gọi như trình duyệt qua PostgREST: vai authenticated, RLS bật. Edge dùng service_role. */
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
    const err = await db.query(sql, params).then(() => null, (e: unknown) => e as { code?: string; message?: string });
    expect(err, `phải lỗi ${code}: ${sql}`).not.toBeNull();
    expect(err?.code).toBe(code);
    if (message) expect(err?.message).toMatch(message);
  } finally {
    await db.exec('ROLLBACK TO SAVEPOINT expected_failure; RELEASE SAVEPOINT expected_failure');
  }
}

const insertDraft = `INSERT INTO contract_terminations(contract_id,organization_id,status,total_deposit,refund_method)
  VALUES($1,$2,'DRAFT',3000000,'CASH') RETURNING id`;
const approve = 'SELECT approve_contract_termination_v1($1, NULL) AS result';

async function confirmReturn(db: PGlite, mode: 'DEFERRED' | 'IMMEDIATE', target = contract) {
  const rows = await asUser<{ result: Row }>(
    db,
    'SELECT confirm_contract_return_v1($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10) AS result',
    [org, target, '2026-10-20', `physical-key-${target.slice(-4)}`, '2026-10-21', 'EARLY_RETURN', mode,
      mode === 'IMMEDIATE' ? '{}' : null, null, returnNote],
  );
  return rows[0].result;
}

async function finalize(db: PGlite, caseId: unknown) {
  const rows = await asUser<{ result: Row }>(
    db,
    'SELECT finalize_contract_exit_case_v1($1,$2,$3,$4,$5,$6,$7::jsonb) AS result',
    [org, caseId, 1, 'settlement-key-0001', 'EARLY_RETURN', null, JSON.stringify({ deposit_refund: 100, shortfall_mode: 'DEBT' })],
  );
  return rows[0].result;
}

/** Hồ sơ DRAFT có sẵn (vd tạo trước khi hợp đồng đóng, hoặc qua đường khác REST) — chỉ để thử rào (a). */
async function seedDraft(db: PGlite, target = contract) {
  return (await db.query<{ id: string }>(insertDraft, [target, org])).rows[0].id;
}

async function count(db: PGlite, sql: string, params: unknown[] = []) {
  return (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) q`, params)).rows[0].n;
}

const nullSourceVouchers = (db: PGlite) => count(db, 'SELECT 1 FROM income_expenses WHERE system_source IS NULL');
const CLOSED = /TERMINATION_CONTRACT_CLOSED/;

describe('trước vá — tái hiện lỗ trên định nghĩa đang chạy', () => {
  it('bản approve nạp từ repo có đúng md5 production đã ghim', async () => {
    const md5 = (await before.query<{ md5: string }>(
      "SELECT md5(pg_get_functiondef('public.approve_contract_termination_v1(uuid,text)'::regprocedure)) AS md5")).rows[0].md5;
    expect(md5).toBe(PROD_APPROVE_MD5);
  });

  it('DEFERRED → DRAFT qua REST → approve sinh phiếu thứ hai, finalize kẹt 23505', () => scenario(before, async () => {
    const pending = await confirmReturn(before, 'DEFERRED');
    expect(pending).toMatchObject({ state: 'PENDING' });
    const [{ id }] = await asUser<{ id: string }>(before, insertDraft, [contract, org]);
    const [{ result }] = await asUser<{ result: Row }>(before, approve, [id]);
    expect(result).toMatchObject({ status: 'COMPLETED', refund_amount: 3000000 });
    expect(await nullSourceVouchers(before)).toBe(1);
    await rejectedAsUser(before, 'SELECT finalize_contract_exit_case_v1($1,$2,$3,$4,$5,$6,$7::jsonb)',
      [org, pending.id, 1, 'settlement-key-0001', 'EARLY_RETURN', null, '{}'], '23505');
  }));
});

describe('sau vá — (b) REST không tạo/chuyển hồ sơ cho hợp đồng đã đóng', () => {
  it('G2: hợp đồng đã trả phòng DEFERRED ⇒ 55000, không có dòng', () => scenario(after, async () => {
    await confirmReturn(after, 'DEFERRED');
    await rejectedAsUser(after, insertDraft, [contract, org], '55000', CLOSED);
    expect(await count(after, 'SELECT 1 FROM contract_terminations')).toBe(0);
  }));

  it.each([
    ['TERMINATED, chưa có ca trả phòng', `UPDATE contracts SET status='TERMINATED' WHERE id='${contract}'`],
    ['ACTIVE nhưng đã có actual_end_date', `UPDATE contracts SET actual_end_date='2026-10-21' WHERE id='${contract}'`],
    ['ACTIVE nhưng đã xoá mềm', `UPDATE contracts SET deleted_at=now() WHERE id='${contract}'`],
  ])('%s ⇒ 55000', (_label, setup) => scenario(after, async () => {
    await after.exec(setup);
    await rejectedAsUser(after, insertDraft, [contract, org], '55000', CLOSED);
  }));

  it('đã có ca trả phòng dù hợp đồng bị sửa ngược về ACTIVE ⇒ 55000', () => scenario(after, async () => {
    await confirmReturn(after, 'DEFERRED');
    await after.exec(`UPDATE contracts SET status='ACTIVE', actual_end_date=NULL WHERE id='${contract}'`);
    await rejectedAsUser(after, insertDraft, [contract, org], '55000', CLOSED);
  }));

  it('chuyển contract_id của hồ sơ DRAFT sang hợp đồng đã đóng ⇒ 55000; sửa cột khác vẫn được', () => scenario(after, async () => {
    const [{ id }] = await asUser<{ id: string }>(after, insertDraft, [contract2, org]);
    await after.exec(`UPDATE contracts SET status='TERMINATED', actual_end_date='2026-10-21' WHERE id='${contract}'`);
    await rejectedAsUser(after, 'UPDATE contract_terminations SET contract_id=$1 WHERE id=$2', [contract, id], '55000', CLOSED);
    await asUser(after, "UPDATE contract_terminations SET notes='ghi chú' WHERE id=$1", [id]);
    expect((await after.query<Row>('SELECT contract_id, notes FROM contract_terminations WHERE id=$1', [id])).rows[0])
      .toEqual({ contract_id: contract2, notes: 'ghi chú' });
  }));

  it.each(['no', 'yes'])('hợp đồng công ty khác (thấy toà lệch = %s): không trả lời trạng thái, để RLS từ chối (42501)', (cross) => scenario(after, async () => {
    await after.exec(`UPDATE contracts SET status='TERMINATED', actual_end_date='2026-10-21' WHERE id='${otherContract}'`);
    await after.exec(`SELECT set_config('test.cross_building','${cross}',true)`);
    await rejectedAsUser(after, insertDraft, [otherContract, otherOrg], '42501');
  }));

  it('cùng công ty nhưng thiếu contracts.create ở toà: không trả lời trạng thái, để RLS từ chối (42501)', () => scenario(after, async () => {
    await after.exec(`UPDATE contracts SET status='TERMINATED', actual_end_date='2026-10-21' WHERE id='${contract}'`);
    await after.exec("SELECT set_config('test.deny_key','contracts.create',true)");
    await rejectedAsUser(after, insertDraft, [contract, org], '42501');
  }));

  it('có contracts.create nhưng thiếu buildings.view: vẫn bị chặn 55000 (đúng vế của policy)', () => scenario(after, async () => {
    await after.exec(`UPDATE contracts SET status='TERMINATED', actual_end_date='2026-10-21' WHERE id='${contract}'`);
    await after.exec("SELECT set_config('test.view_denied','yes',true)");
    await rejectedAsUser(after, insertDraft, [contract, org], '55000', CLOSED);
  }));

  it('UPDATE contract_id: có contracts.edit nhưng thiếu contracts.create vẫn bị chặn 55000', () => scenario(after, async () => {
    const [{ id }] = await asUser<{ id: string }>(after, insertDraft, [contract2, org]);
    await after.exec(`UPDATE contracts SET status='TERMINATED', actual_end_date='2026-10-21' WHERE id='${contract}'`);
    await after.exec("SELECT set_config('test.deny_key','contracts.create',true)");
    await rejectedAsUser(after, 'UPDATE contract_terminations SET contract_id=$1 WHERE id=$2', [contract, id], '55000', CLOSED);
  }));

  it('super admin không lách được: hợp đồng đã đóng của công ty khác ⇒ 55000', () => scenario(after, async () => {
    await after.exec(`UPDATE contracts SET status='TERMINATED', actual_end_date='2026-10-21' WHERE id='${otherContract}'`);
    await after.exec("SELECT set_config('test.super','yes',true)");
    await rejectedAsUser(after, insertDraft, [otherContract, otherOrg], '55000', CLOSED);
  }));

  it('PATCH giữ nguyên contract_id trên hồ sơ của hợp đồng đã đóng ⇒ không chặn', () => scenario(after, async () => {
    const id = await seedDraft(after);
    await after.exec(`UPDATE contracts SET status='TERMINATED', actual_end_date='2026-10-21' WHERE id='${contract}'`);
    await asUser(after, "UPDATE contract_terminations SET contract_id=contract_id, notes='ghi chú' WHERE id=$1", [id]);
    expect((await after.query<Row>('SELECT notes FROM contract_terminations WHERE id=$1', [id])).rows[0].notes).toBe('ghi chú');
  }));

  it('service_role (Edge) đi thẳng như guard a00', () => scenario(after, async () => {
    await after.exec(`UPDATE contracts SET status='TERMINATED', actual_end_date='2026-10-21' WHERE id='${contract}'`);
    await asUser(after, insertDraft, [contract, org], 'service_role');
    expect(await count(after, 'SELECT 1 FROM contract_terminations')).toBe(1);
  }));

  it('cửa writer của guard a00 mở cho đúng hồ sơ ⇒ không chặn', () => scenario(after, async () => {
    await after.exec(`UPDATE contracts SET status='TERMINATED', actual_end_date='2026-10-21' WHERE id='${contract}'`);
    await after.exec("SELECT set_config('test.writer','yes',true)");
    await asUser(after, insertDraft, [contract, org]);
    expect(await count(after, 'SELECT 1 FROM contract_terminations')).toBe(1);
  }));
});

describe('sau vá — (a) approve từ chối hợp đồng đã đóng, không sinh phiếu', () => {
  it('G2: DEFERRED + hồ sơ DRAFT + approve ⇒ 55000, không phiếu, hồ sơ vẫn DRAFT', () => scenario(after, async () => {
    await confirmReturn(after, 'DEFERRED');
    const id = await seedDraft(after);
    await rejectedAsUser(after, approve, [id], '55000', CLOSED);
    expect(await count(after, 'SELECT 1 FROM income_expenses')).toBe(0);
    expect((await after.query<Row>('SELECT status FROM contract_terminations WHERE id=$1', [id])).rows[0].status).toBe('DRAFT');
  }));

  it.each([
    ['TERMINATED, chưa có ca trả phòng', `UPDATE contracts SET status='TERMINATED' WHERE id='${contract}'`],
    ['ACTIVE nhưng đã có actual_end_date', `UPDATE contracts SET actual_end_date='2026-10-21' WHERE id='${contract}'`],
    ['ACTIVE nhưng đã xoá mềm', `UPDATE contracts SET deleted_at=now() WHERE id='${contract}'`],
  ])('%s ⇒ 55000, không phiếu', (_label, setup) => scenario(after, async () => {
    const id = await seedDraft(after);
    await after.exec(setup);
    await rejectedAsUser(after, approve, [id], '55000', CLOSED);
    expect(await count(after, 'SELECT 1 FROM income_expenses')).toBe(0);
  }));

  it('đã có ca trả phòng dù hợp đồng bị sửa ngược về ACTIVE ⇒ 55000', () => scenario(after, async () => {
    await confirmReturn(after, 'DEFERRED');
    const id = await seedDraft(after);
    await after.exec(`UPDATE contracts SET status='ACTIVE', actual_end_date=NULL WHERE id='${contract}'`);
    await rejectedAsUser(after, approve, [id], '55000', CLOSED);
    expect(await count(after, 'SELECT 1 FROM income_expenses')).toBe(0);
  }));

  it('thiếu quyền duyệt thì vẫn là 42501, không lộ trạng thái hợp đồng', () => scenario(after, async () => {
    await confirmReturn(after, 'DEFERRED');
    const id = await seedDraft(after);
    await after.exec("SELECT set_config('test.denied','yes',true)");
    await rejectedAsUser(after, approve, [id], '42501');
  }));
});

describe('sau vá — hồi quy các đường hợp lệ', () => {
  it('G3: DEFERRED → finalize vẫn chạy, đúng 1 hồ sơ COMPLETED và 1 bộ phiếu termination.*', () => scenario(after, async () => {
    const pending = await confirmReturn(after, 'DEFERRED');
    expect(await count(after, 'SELECT 1 FROM income_expenses')).toBe(0);
    const settled = await finalize(after, pending.id);
    expect(settled).toMatchObject({ state: 'FINALIZED' });
    expect(await count(after, "SELECT 1 FROM contract_terminations WHERE contract_id=$1 AND status='COMPLETED'", [contract])).toBe(1);
    expect(await count(after, "SELECT 1 FROM income_expenses WHERE system_source LIKE 'termination.%'")).toBe(1);
    expect(await nullSourceVouchers(after)).toBe(0);
  }));

  it('trả phòng IMMEDIATE (writer DEFINER ghi hồ sơ cho hợp đồng vừa đóng) vẫn chạy', () => scenario(after, async () => {
    expect(await confirmReturn(after, 'IMMEDIATE')).toMatchObject({ state: 'FINALIZED' });
    expect(await count(after, "SELECT 1 FROM contract_terminations WHERE status='COMPLETED'")).toBe(1);
  }));

  it.each(['ACTIVE', 'EXTENDED'])('hợp đồng %s: DRAFT qua REST + approve vẫn chạy như cũ; duyệt lại là noop', (status) => scenario(after, async () => {
    await after.exec(`UPDATE contracts SET status='${status}' WHERE id='${contract}'`);
    const [{ id }] = await asUser<{ id: string }>(after, insertDraft, [contract, org]);
    const [{ result }] = await asUser<{ result: Row }>(after, approve, [id]);
    expect(result).toMatchObject({ status: 'COMPLETED', refund_amount: 3000000 });
    expect((await after.query<Row>('SELECT status FROM contracts WHERE id=$1', [contract])).rows[0].status).toBe('TERMINATED');
    expect(await nullSourceVouchers(after)).toBe(1);
    const [{ result: again }] = await asUser<{ result: Row }>(after, approve, [id]);
    expect(again).toMatchObject({ status: 'COMPLETED', noop: true });
    expect(await nullSourceVouchers(after)).toBe(1);
  }));
});

describe('migration — ghim bản đang chạy và tự kiểm catalog', () => {
  it('dừng khi approve khác bản đã đối chiếu', async () => {
    await after.exec('BEGIN');
    try {
      await after.exec(sliceFunction(APPROVE_SOURCE, 'CREATE OR REPLACE FUNCTION public.approve_contract_termination_v1', '$function$;')
        .replace("raise exception 'Chưa đăng nhập'", "raise exception 'Chưa đăng nhập!'"));
      await expect(after.exec(readFileSync(PATCH, 'utf8'))).rejects.toMatchObject({ code: '55000' });
    } finally {
      await after.exec('ROLLBACK');
    }
  });

  it('after chạy định nghĩa sống của approve (rào P0a + kiểm contracts.terminate của câu 26)', async () => {
    const def = (await after.query<{ def: string }>(
      "SELECT pg_get_functiondef('public.approve_contract_termination_v1(uuid,text)'::regprocedure) AS def")).rows[0].def;
    expect(def).toContain('[TERMINATION_CONTRACT_CLOSED]');
    expect(def).toContain("'contracts.terminate');");
  });

  it('trigger a01 chỉ chạy trên đường REST và hàm trigger không ai gọi trực tiếp được', async () => {
    const rows = (await after.query<Row>(`SELECT pg_get_triggerdef(t.oid) AS def, p.prosecdef,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
      FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgname = 'a01_contract_termination_open_contract_guard'`)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].def).toMatch(/BEFORE INSERT OR UPDATE OF contract_id ON public\.contract_terminations/);
    expect(rows[0].def).toMatch(/WHEN \(\(CURRENT_USER = ANY \(ARRAY\['authenticated'::name, 'anon'::name\]\)\)\)/);
    expect(rows[0]).toMatchObject({ prosecdef: true, auth_exec: false });
  });
});
