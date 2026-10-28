// Lỗ 3 (18/10/2026): get_room_cash_lifecycle_v1 chỉ kiểm quyền xem toà, không kiểm khoá màn nào,
// nên buildings.view là đủ để đọc giá thuê/cọc/tiền của mọi hợp đồng từng ở phòng. Một PGlite cho
// cả file; mỗi ca BEGIN…ROLLBACK. Ca trước chạy thân sống 20260921085952 (lộ), ca sau chạy
// migration vá (chặn), đột biến chứng minh các phép kiểm cắn. Cuối file nối thân sống kế tiếp
// (20261028203816, vòng đời tiền một nguồn) vào chuỗi và đo lại cửa trên thân đó.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const FIX_FILE = '20261018052932_vong_doi_tien_phong_doi_khoa_man_hinh.sql';
const NEXT_FILE = '20261028203816_vong_doi_tien_phong_mot_nguon.sql';
const read = (name) => readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');
const FIX = read(FIX_FILE);
const NEXT = read(NEXT_FILE);
const OLD = read('20260921085952_restore_before_contract_settlement.sql');
const POLICY = JSON.parse(readFileSync(new URL('../../supabase/migration-policy.json', import.meta.url), 'utf8'));

const SIG = 'public.get_room_cash_lifecycle_v1';
function fn(sql) {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${SIG}(`);
  const open = sql.indexOf('AS $function$', start);
  const close = sql.indexOf('$function$', open + 13);
  if (start < 0 || open < 0 || close < 0) throw new Error('không thấy thân hàm');
  return sql.slice(start, close + 10) + ';';
}

const org = 'a0000000-0000-4000-8000-000000000001';
const building = 'b0000000-0000-4000-8000-000000000001';
const otherBuilding = 'b0000000-0000-4000-8000-000000000002';
const room = 'f0000000-0000-4000-8000-000000000001';
const contract = 'e0000000-0000-4000-8000-000000000001';
const viewer = 'c0000000-0000-4000-8000-000000000001';

let db;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE public.buildings(id uuid PRIMARY KEY, name text, organization_id uuid);
    CREATE TABLE public.rooms(id uuid PRIMARY KEY, name text, building_id uuid, deleted_at timestamptz);
    CREATE TABLE public.tenants(id uuid PRIMARY KEY, full_name text);
    CREATE TABLE public.contracts(id uuid PRIMARY KEY, room_id uuid, tenant_id uuid, contract_number text, status text,
      start_date date, end_date date, actual_end_date date, rent_price numeric, total_deposit numeric, deleted_at timestamptz);
    CREATE TABLE public.contract_transfers(id uuid PRIMARY KEY, contract_id uuid, status text, old_room_id uuid, new_room_id uuid,
      move_out_date date, transfer_date date);
    CREATE TABLE public.income_expenses(id uuid PRIMARY KEY, contract_id uuid, voucher_date date, total_amount numeric, code text, name text,
      posting_status text, active_posting_id_v2 uuid, system_source text, approval_status text, deleted_at timestamptz,
      organization_id uuid, type text, room_id uuid, invoice_id uuid, commission_kind text, commission_legacy_dup boolean DEFAULT false);
    CREATE TABLE public.invoices(id uuid PRIMARY KEY, contract_id uuid, room_id uuid, issue_date date, billing_month text, total_amount numeric,
      status text, paid_date date, paid_amount numeric, updated_at timestamptz, deleted_at timestamptz,
      kind text DEFAULT 'MONTHLY', previous_debt numeric DEFAULT 0, previous_debt_sources jsonb DEFAULT '[]');
    CREATE TABLE public.contract_terminations(id uuid PRIMARY KEY, contract_id uuid, termination_date date, created_at timestamptz,
      refund_amount numeric, status text, termination_type text);
    -- Nguồn dùng chung mà thân 20261028203816 đọc: bản giả tối thiểu (file này chỉ đo cửa quyền; số tiền của thân đó
    -- có test riêng chạy thân thật — room-cash-lifecycle-one-source-sql.test.mjs).
    CREATE TABLE public.payments(id uuid PRIMARY KEY, invoice_id uuid, amount numeric, received_amount numeric, payment_date date,
      reversed_at timestamptz);
    CREATE TABLE public.invoice_items(invoice_id uuid, type text, accounting_class text, amount numeric);
    CREATE TABLE public.income_expense_items(income_expense_id uuid, accounting_class text, amount numeric, unit_price numeric, quantity numeric);
    CREATE TABLE public.contract_extensions(contract_id uuid, old_end_date date, status text);
    CREATE TABLE app_private.sale_bonus_claims(id uuid PRIMARY KEY, organization_id uuid, deposit_voucher_id uuid, bonus_voucher_id uuid,
      created_at timestamptz);
    CREATE TABLE app_private.termination_forfeit_authorizations(payment_id uuid);
    CREATE FUNCTION app_private.invoice_direct_paid_v1(uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
      SELECT COALESCE(i.paid_amount, 0) FROM public.invoices i WHERE i.id = $1 $$;
    CREATE FUNCTION app_private.invoice_carried_debt_v1(uuid) RETURNS numeric LANGUAGE sql STABLE AS $$ SELECT 0::numeric $$;
    CREATE FUNCTION public.invoice_effective_outstanding_v1(uuid[]) RETURNS TABLE(invoice_id uuid, remaining_amount numeric,
      carried_out_amount numeric, carried_in_amount numeric, effective_outstanding numeric, effective_outstanding_at_carrier numeric)
      LANGUAGE sql STABLE AS $$ SELECT i.id, i.total_amount - i.paid_amount, 0, 0, i.total_amount - i.paid_amount, i.total_amount - i.paid_amount
        FROM public.invoices i WHERE i.id = ANY ($1) $$;
    CREATE FUNCTION app_private.is_commission_voucher_v1(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.get_room_residence_segments_v1(uuid[]) RETURNS TABLE(contract_id uuid, contract_number text, room_id uuid,
      seg_index integer, from_date date, to_date date, source_path text, trusted boolean, diagnostic text)
      LANGUAGE sql STABLE AS $$ SELECT c.id, c.contract_number, c.room_id, 0, c.start_date, NULL::date, 'contract', true, NULL::text
        FROM public.contracts c WHERE c.id = ANY ($1) $$;
    CREATE FUNCTION public.org_today_v1(uuid) RETURNS date LANGUAGE sql STABLE AS $$ SELECT DATE '2026-10-18' $$;
    -- Quyền giả: 'khoá@toà' trong test.grants; buildings.view do can_access_building đọc.
    CREATE FUNCTION public.has_grant(text, uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT ($1 || '@' || $2::text) = ANY (string_to_array(coalesce(current_setting('test.grants', true), ''), ',')) $$;
    CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT public.has_grant('buildings.view', $1) $$;
    CREATE FUNCTION public.ie_all_buildings_scope(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT public.has_grant('income_expenses.all_buildings', $1) $$;
    CREATE FUNCTION public.can_do_on_building(text, text, uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT public.has_grant($1 || '.' || $2, $3) $$;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_setting('test.super', true) = 'true' $$;
    CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT public.is_super_admin() $$;
    GRANT USAGE ON SCHEMA public, auth, app_private TO authenticated;
    INSERT INTO buildings VALUES ('${building}', 'Toà A', '${org}'), ('${otherBuilding}', 'Toà B', '${org}');
    INSERT INTO rooms VALUES ('${room}', 'P101', '${building}', null);
    INSERT INTO tenants VALUES ('d0000000-0000-4000-8000-000000000001', 'Khách Một');
    INSERT INTO contracts VALUES ('${contract}', '${room}', 'd0000000-0000-4000-8000-000000000001', 'HD-1', 'ACTIVE',
      DATE '2026-01-01', DATE '2026-12-31', null, 4500000, 9000000, null);
    INSERT INTO income_expenses VALUES ('10000000-0000-4000-8000-000000000001', '${contract}', DATE '2026-01-01', 9000000, 'PT-1', 'Cọc',
      'POSTED', '10000000-0000-4000-8000-0000000000aa', 'contract.deposit', 'APPROVED', null);
    INSERT INTO invoices VALUES ('20000000-0000-4000-8000-000000000001', '${contract}', '${room}', DATE '2026-02-01', '2026-02', 5000000,
      'PAID', DATE '2026-02-05', 5000000, now(), null);`);
  await db.exec(fn(OLD));
  await db.exec(`GRANT EXECUTE ON FUNCTION ${SIG}(uuid,date,date) TO authenticated, service_role`);
});
afterAll(async () => { await db?.close(); });

// Một ca = một giao dịch. Trả 'denied' (42501) hoặc payload; lỗi khác ném ra.
async function call({ grants = [], superAdmin = false, uid = viewer, body = null } = {}) {
  await db.exec('BEGIN');
  try {
    if (body) await db.exec(body);
    await db.query(`SELECT set_config('request.jwt.claim.sub', $1, true), set_config('test.grants', $2, true), set_config('test.super', $3, true)`,
      [uid ?? '', grants.join(','), String(superAdmin)]);
    await db.exec('SET LOCAL ROLE authenticated');
    try {
      const { rows } = await db.query(`SELECT ${SIG}($1) AS out`, [room]);
      return rows[0].out;
    } catch (error) {
      if (error.code === '42501') return 'denied';
      throw error;
    }
  } finally { await db.exec('ROLLBACK'); }
}
const B = `buildings.view@${building}`;
const THU = `thu_tien.view@${building}`;
const LN = `reports_finance.profit_distribution@${building}`;

test('TRƯỚC vá: chỉ buildings.view đã đọc được giá thuê, cọc và tiền hoá đơn', async () => {
  const out = await call({ grants: [B] });
  expect(out.contracts[0]).toMatchObject({ rentPrice: 4500000, totalDeposit: 9000000, tenantName: 'Khách Một' });
  expect(out.events.map((e) => e.type)).toEqual(expect.arrayContaining(['DEPOSIT_RECEIVED', 'INVOICE_COLLECTION_POSTED']));
});

// Witness sau vá; phiên apply khai đúng giá trị này làm forward succession cùng biên nhận.
const AFTER = { md5: 'a637b2312d020da2f7de2da01d5b6435', owner: 'postgres', acl: '{postgres=X/postgres,authenticated=X/postgres}' };

test('migration vá chạy hai lượt (idempotent), ACL chỉ authenticated, witness khớp sổ retirement', async () => {
  await db.exec(FIX);
  await db.exec(FIX);
  const { rows } = await db.query(`SELECT md5(pg_get_functiondef(p.oid)) AS md5, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl,
      has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
    FROM pg_proc p WHERE p.oid = to_regprocedure('${SIG}(uuid,date,date)')`);
  expect({ md5: rows[0].md5, owner: rows[0].owner, acl: rows[0].acl }).toEqual(AFTER);
  expect([rows[0].anon, rows[0].service]).toEqual([false, false]);
  // Bước trước là witness after của compensation. Succession khác của hàm này chỉ được đứng SAU file vá
  // và nối liền chuỗi md5: bước kế tiếp có before = AFTER, mỗi bước sau có before = after của bước trước.
  const group = POLICY.idempotencyRetirements.find((g) => g.id === 'restore-before-contract-settlement-2026-09-21');
  const before = group.witness.functions.find((f) => f.signature === `${SIG}(uuid,date,date)`).after;
  const others = group.forwardSuccessions
    .filter((s) => s.file !== FIX_FILE && s.functions.some((f) => f.signature === `${SIG}(uuid,date,date)`))
    .sort((a, b) => a.file.localeCompare(b.file));
  let prev = AFTER;
  for (const s of others) {
    expect(s.file > FIX_FILE, s.file).toBe(true);
    const step = s.functions.find((f) => f.signature === `${SIG}(uuid,date,date)`);
    expect(step.before, s.file).toEqual(prev);
    prev = step.after;
  }
  expect(before.md5).toBe('2c5c0f54d345ca35c3cac80232c3d837');
  // Khi succession đã được khai (sau apply), nó phải đúng file, digest và witness này.
  const succession = group.forwardSuccessions.find((s) => s.file === FIX_FILE);
  if (succession) {
    expect(succession.sha256).toBe(createHash('sha256').update(FIX).digest('hex'));
    expect(succession.functions).toEqual([{ signature: `${SIG}(uuid,date,date)`, before, after: AFTER }]);
  }
});

// Kỳ vọng sau vá, gom lại để đột biến dùng chung.
async function fixedHolds(body) {
  const ok = (out) => out !== 'denied' && out.room.id === room && out.contracts.length === 1;
  return (await call({ grants: [B], body })) === 'denied'
    && ok(await call({ grants: [B, THU], body }))
    && ok(await call({ grants: [B, LN], body }))
    && ok(await call({ grants: [`income_expenses.all_buildings@${building}`, THU], body }))
    && (await call({ grants: [B, `thu_tien.view@${otherBuilding}`, `reports_finance.profit_distribution@${otherBuilding}`], body })) === 'denied'
    && (await call({ grants: [THU, LN], body })) === 'denied'
    && ok(await call({ superAdmin: true, body }));
}

test('SAU vá: cần quyền xem toà VÀ thu_tien.view hoặc reports_finance.profit_distribution ở đúng toà', async () => {
  expect(await fixedHolds()).toBe(true);
});

test('chưa đăng nhập vẫn bị chặn 42501', async () => {
  expect(await call({ uid: null, grants: [B, THU] })).toBe('denied');
});

// Đột biến trên một thân: bỏ từng vế của cửa thì phép kiểm phải đỏ.
async function gateMutantsBite(body) {
  const thu = "public.can_do_on_building('thu_tien', 'view', v_room.building_id)";
  const ln = "public.can_do_on_building('reports_finance', 'profit_distribution', v_room.building_id)";
  const mutants = {
    'bỏ khoá màn hình': body.replace(`(${thu}\n                   OR ${ln})`, 'true'),
    'bỏ nhánh Thu tiền': body.replace(thu, 'false'),
    'bỏ nhánh BC lợi nhuận': body.replace(ln, 'false'),
    'AND thành OR': body.replace("public.ie_all_buildings_scope(v_room.building_id))\n              AND (", "public.ie_all_buildings_scope(v_room.building_id))\n              OR ("),
    'khoá ở sai toà': body.replace(thu, `public.can_do_on_building('thu_tien', 'view', '${otherBuilding}'::uuid)`),
  };
  for (const [label, mutant] of Object.entries(mutants)) {
    expect(mutant, label).not.toBe(body);
    expect(await fixedHolds(mutant), label).toBe(false);
  }
}

test('đột biến: bỏ từng vế của cửa thì phép kiểm phải đỏ', async () => {
  await gateMutantsBite(fn(FIX));
});

// Định nghĩa sống đã dời sang NEXT_FILE (cùng chữ ký, cùng cửa; thêm tiền một nguồn): chạy hai lượt sau bản vá,
// cửa phải giữ nguyên trên thân đó.
test('thân sống kế tiếp (vòng đời tiền một nguồn) chạy hai lượt sau bản vá và giữ nguyên cửa', async () => {
  await db.exec(NEXT);
  await db.exec(NEXT);
  const { rows } = await db.query(`SELECT p.proacl::text AS acl FROM pg_proc p WHERE p.oid = to_regprocedure('${SIG}(uuid,date,date)')`);
  expect(rows[0].acl).toBe(AFTER.acl);
  expect(await fixedHolds()).toBe(true);
  expect(await call({ uid: null, grants: [B, THU] })).toBe('denied');
  await gateMutantsBite(fn(NEXT));
});
