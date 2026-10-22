// Câu 25 (chủ chốt 21/10/2026) — người lập KHÔNG tự duyệt phiếu chi vượt ngưỡng của mình.
//
// Chạy logic THẬT trên PGlite: approve_income_expense_v1 + approve_pending_income_expense_
// checked_v1 bản đang chạy (20260925080906), approve_voucher + lock_salary_month_v1 bản
// baseline, pay_draft_fee_voucher (20260831161000) — md5 của bốn writer duyệt khớp production
// 22/10/2026 — rồi migration vá (áp hai lượt như lane). Helper quyền (super admin, quyền
// income_expenses.approve theo toà, ngưỡng) là stub đọc bảng giả; engine/sổ sách ngoài phạm vi.
// Copilot/Hermes không dựng lại được trên PGlite (xác nhận + kế hoạch L5): soi thân định nghĩa
// SỐNG — chỉ duyệt qua hai writer đã vá hoặc cửa cặp bỏ cọc (đòi quyền duyệt).
// require_building_perm_v1 (câu 26, md5 production) đổi sang gọi has_building_perm_v1: ma trận
// người × toà × khoá chạy trước/sau vá phải trùng từng ca.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PATCH = 'supabase/migrations/20261021231237_chan_tu_duyet_phieu_chi_vuot_nguong_v1.sql';
const SUA_PHIEU = 'supabase/migrations/20260925080906_sua_phieu_cho_duyet.sql';
const PAY_DRAFT = 'supabase/migrations/20260831161000_pay_draft_fee_voucher_gate_truoc_doc.sql';
const COPILOT_DUYET = 'supabase/migrations/20260906012317_copilot_ie_duyet_thang_ba_bac_v1.sql';
const HERMES_EXPENSE = 'supabase/migrations/20261015120100_hermes_expense_create_action_v1.sql';
const CAU26 = 'supabase/migrations/20261021180057_contract_lifecycle_permission_guard_v1.sql';
const BASELINE = 'supabase/baseline/schema.sql';

// md5(pg_get_functiondef) đọc trên production 22/10/2026 (chỉ đọc; TEST cùng md5).
const PROD_MD5 = {
  v1: '10fdb43c85df855db3ab9c26be7ee6e1',
  approveVoucher: 'b8529fc96ee1ba71f6af780f8dcc97b3',
  checked: '69e9e4eb240089dfb6020d916e51ca0f',
  payDraft: '9001f16232b91291ee47d8fcb63e151f',
  lockSalary: '4dd21e9c38ddb3249ce144a543d27764',
  requirePerm: '57e80783ec9c9157a92d47798a06fe24',
};

const MSG = 'Phiếu chi từ ngưỡng tự duyệt trở lên cần người có quyền duyệt thu chi duyệt — người lập phiếu không tự duyệt được.';
// Mã máy đọc ở HINT — cùng khuôn ie_system_only_manual_blocked mà web/Hermes đã đọc.
const REASON = 'ie_self_approve_over_threshold';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = id(1);
const ORG_NO_THRESHOLD = id(2);
const B_A = id(11);
const B_B = id(12);
const B_FREE = id(13); // toà của công ty chưa đặt ngưỡng
const B_VIRTUAL = id(14);
const MAKER = id(21); // người lập, KHÔNG có quyền duyệt
const APPROVER = id(22); // có income_expenses.approve ở toà A
const OWNER = id(23); // super admin
const MAKER_APPROVER = id(24); // người lập CÓ quyền duyệt ở toà A (câu 05)
const OTHER_SCOPE = id(25); // có quyền duyệt CHỈ ở toà B
const LOCKER_NO_APPROVE = id(26); // có salary.lock nhưng không có quyền duyệt (giả định)
const OFFBOARDED = id(27);
const STAFF = id(28);
const ORG_APPROVER = id(29); // có quyền duyệt phạm vi CÔNG TY, không super admin
const ACC_MAKER = id(31);
const ACC_MAKER_APPROVER = id(32);
const ACC_LOCKER = id(33);

function cut(path: string, header: string, end: string): string {
  const sql = readFileSync(path, 'utf8');
  const start = sql.indexOf(header);
  if (start < 0) throw new Error(`Không thấy ${header} trong ${path}`);
  const stop = sql.indexOf(end, start);
  if (stop < 0) throw new Error(`Không thấy ${end} sau ${header}`);
  return sql.slice(start, stop + end.length);
}

const SOURCES = {
  v1: () => cut(SUA_PHIEU, 'CREATE OR REPLACE FUNCTION public.approve_income_expense_v1', '$function$;'),
  checked: () => cut(SUA_PHIEU, 'CREATE OR REPLACE FUNCTION public.approve_pending_income_expense_checked_v1', '$function$;'),
  approveVoucher: () => cut(BASELINE, 'CREATE FUNCTION public.approve_voucher(voucher_id uuid)', '\n$$;'),
  lockSalary: () => cut(BASELINE, 'CREATE FUNCTION public.lock_salary_month_v1(', '\n$$;'),
  payDraft: () => cut(PAY_DRAFT, 'CREATE OR REPLACE FUNCTION public.pay_draft_fee_voucher', '\n$$;'),
  // Câu 26 (đã lên production): hàm kiểm quyền RAISE mà migration câu 25 đổi sang gọi has_building_perm_v1.
  requirePerm: () => `${cut(CAU26, 'CREATE OR REPLACE FUNCTION app_private.require_building_perm_v1', '$fn$;')}
    REVOKE ALL ON FUNCTION app_private.require_building_perm_v1(uuid, text, text[]) FROM PUBLIC, anon, authenticated, service_role;`,
};

async function build(db: PGlite, { patch }: { patch: boolean }) {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
      AS $$ SELECT nullif(current_setting('test.actor', true), '')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO authenticated, anon;

    CREATE TABLE public.organizations(id uuid PRIMARY KEY, status text DEFAULT 'ACTIVE');
    INSERT INTO public.organizations(id) VALUES ('${ORG}'), ('${ORG_NO_THRESHOLD}');
    CREATE TABLE public.buildings(id uuid PRIMARY KEY, organization_id uuid, user_id uuid,
      is_virtual boolean DEFAULT false, deleted_at timestamptz, created_at timestamptz DEFAULT now());
    INSERT INTO public.buildings(id, organization_id, user_id, is_virtual) VALUES
      ('${B_A}', '${ORG}', '${OWNER}', false), ('${B_B}', '${ORG}', '${OWNER}', false),
      ('${B_FREE}', '${ORG_NO_THRESHOLD}', '${OWNER}', false), ('${B_VIRTUAL}', '${ORG}', '${OWNER}', true);
    CREATE TABLE public.accounts(id uuid PRIMARY KEY, user_id uuid, deleted_at timestamptz);
    INSERT INTO public.accounts(id, user_id) VALUES
      ('${ACC_MAKER}', '${MAKER}'), ('${ACC_MAKER_APPROVER}', '${MAKER_APPROVER}'), ('${ACC_LOCKER}', '${LOCKER_NO_APPROVE}');

    CREATE TABLE public.income_expenses(
      id uuid PRIMARY KEY, organization_id uuid, user_id uuid, type text, name text, code text,
      building_id uuid, account_id uuid, total_amount numeric,
      approval_status text NOT NULL DEFAULT 'UNAPPROVED', approval_version bigint NOT NULL DEFAULT 1,
      approved_by uuid, approved_at timestamptz, deleted_at timestamptz, attachments jsonb DEFAULT '[]');

    CREATE TABLE app_private.ie_auto_approve_config(organization_id uuid PRIMARY KEY, threshold numeric);
    INSERT INTO app_private.ie_auto_approve_config VALUES ('${ORG}', 600000), ('${ORG_NO_THRESHOLD}', NULL);
    CREATE TABLE app_private.ie_transition_authorization(income_expense_id uuid, xid xid8, purpose text);
    CREATE TABLE app_private.income_expense_flow_ownership(income_expense_id uuid PRIMARY KEY);
    CREATE TABLE app_private.events(income_expense_id uuid, actor uuid, note text);
    CREATE TABLE app_private.termination_forfeit_authorizations(revenue_voucher_id uuid, offset_voucher_id uuid);
    -- Quyền giả: một dòng = income_expenses.approve ở một toà; building_id NULL = phạm vi công ty.
    CREATE TABLE app_private.approve_grants(actor uuid, building_id uuid);
    INSERT INTO app_private.approve_grants VALUES
      ('${APPROVER}', '${B_A}'), ('${MAKER_APPROVER}', '${B_A}'), ('${OTHER_SCOPE}', '${B_B}'), ('${OFFBOARDED}', NULL),
      ('${ORG_APPROVER}', NULL);
    CREATE TABLE app_private.salary_lock_grants(actor uuid);
    INSERT INTO app_private.salary_lock_grants VALUES ('${MAKER_APPROVER}'), ('${LOCKER_NO_APPROVE}');
    CREATE TABLE app_private.offboarded(actor uuid);
    INSERT INTO app_private.offboarded VALUES ('${OFFBOARDED}');
    CREATE TABLE public.super_admins(user_id uuid, created_at timestamptz DEFAULT now());
    INSERT INTO public.super_admins(user_id) VALUES ('${OWNER}');

    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE
      AS $$ SELECT EXISTS (SELECT 1 FROM public.super_admins WHERE user_id = auth.uid()) $$;
    CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT public.is_super_admin() $$;
    CREATE FUNCTION app_private.is_actor_offboarded_v1() RETURNS boolean LANGUAGE sql STABLE
      AS $$ SELECT EXISTS (SELECT 1 FROM app_private.offboarded WHERE actor = auth.uid()) $$;
    -- Cùng hình với production: NOT offboarded AND (super admin OR can_v3(khoá, toà)).
    CREATE FUNCTION public.can_do_on_building(text, text, uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT NOT app_private.is_actor_offboarded_v1()
         AND (public.is_super_admin()
              OR ($1 || '.' || $2 = 'income_expenses.approve'
                  AND EXISTS (SELECT 1 FROM app_private.approve_grants g
                               WHERE g.actor = auth.uid() AND (g.building_id = $3 OR g.building_id IS NULL)))) $$;
    CREATE FUNCTION app_private.has_any_scope_v3(text) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT $1 = 'income_expenses.approve' AND EXISTS (SELECT 1 FROM app_private.approve_grants g WHERE g.actor = auth.uid()) $$;
    CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
    CREATE FUNCTION public.ie_all_buildings_scope(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION app_private.assert_no_engine_request_v1(uuid) RETURNS void LANGUAGE sql STABLE AS $$ SELECT $$;
    CREATE FUNCTION app_private.is_income_expense_flow_owned(uuid) RETURNS boolean LANGUAGE sql STABLE
      AS $$ SELECT EXISTS (SELECT 1 FROM app_private.income_expense_flow_ownership WHERE income_expense_id = $1) $$;
    CREATE FUNCTION app_private.ie_actor_display_name_v1(uuid) RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'Người thử' $$;
    CREATE FUNCTION app_private.append_income_expense_event_v1(uuid, uuid, text, uuid, text, text, text, text)
      RETURNS uuid LANGUAGE sql AS $$ INSERT INTO app_private.events VALUES ($2, $4, $8) RETURNING $2 $$;
    CREATE FUNCTION app_private.current_uid_v1() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT auth.uid() $$;
    CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;
    CREATE FUNCTION public.set_termination_forfeit_status_v1(uuid, text) RETURNS void LANGUAGE sql AS $$ SELECT $$;

    -- Nền tối thiểu cho lock_salary_month_v1 (bản baseline = production).
    CREATE TABLE public.manager_salary_config(staff_id uuid, organization_id uuid, user_id uuid,
      is_active boolean DEFAULT true, effective_from date DEFAULT '2026-01-01', effective_to date,
      created_at timestamptz DEFAULT now());
    INSERT INTO public.manager_salary_config(staff_id, organization_id, user_id) VALUES ('${STAFF}', '${ORG}', '${OWNER}');
    CREATE TABLE public.organization_memberships(user_id uuid, organization_id uuid, status text DEFAULT 'ACTIVE');
    INSERT INTO public.organization_memberships(user_id, organization_id) VALUES ('${STAFF}', '${ORG}');
    CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid, uuid, text, uuid, uuid)
      RETURNS TABLE(allowed boolean) LANGUAGE sql AS $$
      SELECT $3 = 'salary.lock' AND EXISTS (SELECT 1 FROM app_private.salary_lock_grants WHERE actor = $1) $$;
    CREATE TABLE app_private.canonical_write_operations(organization_id uuid, operation text, subject_scope text,
      actor_id uuid, idempotency_key text, payload_hash text, subject_id uuid, response_payload jsonb,
      created_at timestamptz DEFAULT now(), completed_at timestamptz,
      UNIQUE (organization_id, operation, subject_scope, actor_id, idempotency_key));
    CREATE FUNCTION app_private.evaluate_feature_route(text, uuid) RETURNS text LANGUAGE sql AS $$ SELECT 'CANONICAL' $$;
    CREATE TABLE public.profit_monthly(organization_id uuid, period_month date, status text);
    CREATE TABLE public.salary_monthly(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, staff_id uuid,
      period_month date, status text, base_salary numeric, work_bonus numeric, contract_bonus numeric,
      commission_total numeric, investment_profit numeric, adjustments_total numeric, advances_total numeric,
      room_rent numeric, gross_total numeric, take_home numeric, paid numeric, locked_at timestamptz,
      locked_by uuid, organization_id uuid, UNIQUE (staff_id, period_month));
    CREATE TABLE public.salary_work_ledger_snapshot(user_id uuid, salary_monthly_id uuid, staff_id uuid,
      item_type text, source_id uuid, occurred_date date, day_label text, content text, place text,
      job_type_name text, is_repair boolean, is_contract boolean, base_amount numeric, weekend_amount numeric,
      after_amount numeric, cash_amount numeric, has_photo boolean, bonus_amount numeric, reason text,
      organization_id uuid);
  `);
  await db.exec(SOURCES.v1());
  await db.exec(SOURCES.checked());
  await db.exec(SOURCES.approveVoucher());
  await db.exec(SOURCES.lockSalary());
  await db.exec(SOURCES.payDraft());
  await db.exec(SOURCES.requirePerm());
  if (patch) {
    // Lane chạy file hai lượt: lượt hai phải đi nhánh "đã vá".
    await db.exec(readFileSync(PATCH, 'utf8'));
    await db.exec(readFileSync(PATCH, 'utf8'));
  }
}

type Voucher = {
  id: string;
  maker: string;
  total: number;
  type?: 'EXPENSE' | 'INCOME';
  building?: string | null;
  org?: string;
  account?: string | null;
  owned?: boolean;
};

async function seed(db: PGlite, v: Voucher) {
  await db.query(
    `INSERT INTO public.income_expenses(id, organization_id, user_id, type, name, code, building_id, account_id, total_amount)
     VALUES ($1, $2, $3, $4, 'Phiếu thử', 'PC-THU', $5, $6, $7)`,
    [v.id, v.org ?? ORG, v.maker, v.type ?? 'EXPENSE', v.building === undefined ? B_A : v.building,
      v.account === undefined ? ACC_MAKER : v.account, v.total],
  );
  if (v.owned) await db.query('INSERT INTO app_private.income_expense_flow_ownership VALUES ($1)', [v.id]);
}

async function as(db: PGlite, actor: string | null) {
  await db.query(`SELECT set_config('test.actor', $1, false)`, [actor ?? '']);
}

async function status(db: PGlite, voucher: string) {
  const r = await db.query<{ approval_status: string; approved_by: string | null; account_id: string | null }>(
    'SELECT approval_status, approved_by, account_id FROM public.income_expenses WHERE id = $1', [voucher]);
  return r.rows[0];
}

type PgError = { code?: string; message?: string; detail?: string; hint?: string };

async function failure(run: Promise<unknown>): Promise<PgError> {
  try {
    await run;
  } catch (error) {
    return error as PgError;
  }
  throw new Error('Mong lỗi nhưng lệnh chạy thành công');
}

async function expectSelfApproveBlocked(run: Promise<unknown>) {
  const e = await failure(run);
  expect(e.code).toBe('42501');
  expect(e.message).toBe(MSG);
  expect(e.hint).toBe(REASON);
}

const md5 = async (db: PGlite, sig: string) =>
  (await db.query<{ m: string }>('SELECT md5(pg_get_functiondef($1::regprocedure)) AS m', [sig])).rows[0].m;

describe('câu 25 — nền: bản đang chạy khớp production và lỗ có thật', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await build(db, { patch: false });
  });
  afterAll(async () => db.close());

  it('năm writer duyệt + require_building_perm_v1 (câu 26) dựng trên PGlite khớp md5 production 22/10/2026', async () => {
    expect(await md5(db, 'public.approve_income_expense_v1(uuid)')).toBe(PROD_MD5.v1);
    expect(await md5(db, 'public.approve_voucher(uuid)')).toBe(PROD_MD5.approveVoucher);
    expect(await md5(db, 'public.approve_pending_income_expense_checked_v1(uuid,bigint)')).toBe(PROD_MD5.checked);
    expect(await md5(db, 'public.pay_draft_fee_voucher(uuid,uuid,jsonb)')).toBe(PROD_MD5.payDraft);
    expect(await md5(db, 'public.lock_salary_month_v1(date,jsonb,text)')).toBe(PROD_MD5.lockSalary);
    expect(await md5(db, 'app_private.require_building_perm_v1(uuid,text,text[])')).toBe(PROD_MD5.requirePerm);
  });

  it('TRƯỚC vá: người lập không có quyền duyệt tự duyệt phiếu chi 1,2tr của mình (cả hai writer)', async () => {
    await seed(db, { id: id(101), maker: MAKER, total: 1_200_000 });
    await seed(db, { id: id(102), maker: MAKER, total: 1_200_000, owned: true });
    await as(db, MAKER);
    await db.query('SELECT public.approve_voucher($1)', [id(101)]);
    await db.query('SELECT public.approve_income_expense_v1($1)', [id(102)]);
    expect(await status(db, id(101))).toMatchObject({ approval_status: 'APPROVED', approved_by: MAKER });
    expect(await status(db, id(102))).toMatchObject({ approval_status: 'APPROVED', approved_by: MAKER });
  });

  it('TRƯỚC vá: chốt lương bởi người có salary.lock nhưng không có quyền duyệt dựa vào nhánh người lập', async () => {
    await seed(db, { id: id(103), maker: LOCKER_NO_APPROVE, total: 1_500_000, account: ACC_LOCKER });
    await as(db, LOCKER_NO_APPROVE);
    await db.query(`SELECT public.lock_salary_month_v1('2026-09-01', $1::jsonb, 'q25-before-lock-0001')`,
      [JSON.stringify([{ staff_id: STAFF, commission_voucher_ids: [id(103)] }])]);
    expect(await status(db, id(103))).toMatchObject({ approval_status: 'APPROVED', approved_by: LOCKER_NO_APPROVE });
  });
});

describe('câu 25 — sau vá', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await build(db, { patch: true });
  });
  afterAll(async () => db.close());

  it('người lập không có quyền duyệt: phiếu chi 1,2tr ⇒ 42501 + HINT mã đọc được, phiếu vẫn chờ duyệt (approve_voucher)', async () => {
    await seed(db, { id: id(201), maker: MAKER, total: 1_200_000 });
    await as(db, MAKER);
    await expectSelfApproveBlocked(db.query('SELECT public.approve_voucher($1)', [id(201)]));
    expect(await status(db, id(201))).toMatchObject({ approval_status: 'UNAPPROVED', approved_by: null });
  });

  it('cùng luật ở approve_income_expense_v1, không ghi sự kiện duyệt', async () => {
    await seed(db, { id: id(202), maker: MAKER, total: 1_200_000, owned: true });
    await as(db, MAKER);
    await expectSelfApproveBlocked(db.query('SELECT public.approve_income_expense_v1($1)', [id(202)]));
    expect((await status(db, id(202))).approval_status).toBe('UNAPPROVED');
    expect((await db.query('SELECT 1 FROM app_private.events WHERE income_expense_id = $1', [id(202)])).rows).toHaveLength(0);
  });

  it('nút Duyệt trên web (approve_pending_income_expense_checked_v1) chặn cả phiếu thuộc luồng lẫn phiếu cũ', async () => {
    await seed(db, { id: id(203), maker: MAKER, total: 2_000_000, owned: true });
    await seed(db, { id: id(204), maker: MAKER, total: 2_000_000 });
    await as(db, MAKER);
    await expectSelfApproveBlocked(db.query('SELECT public.approve_pending_income_expense_checked_v1($1, 1)', [id(203)]));
    await expectSelfApproveBlocked(db.query('SELECT public.approve_pending_income_expense_checked_v1($1, 1)', [id(204)]));
    expect((await status(db, id(203))).approval_status).toBe('UNAPPROVED');
    expect((await status(db, id(204))).approval_status).toBe('UNAPPROVED');
  });

  it('đúng bằng ngưỡng là vượt (>=, cùng phép so lúc lập); 599.999đ thì người lập vẫn tự duyệt như cũ', async () => {
    await seed(db, { id: id(205), maker: MAKER, total: 600_000 });
    await seed(db, { id: id(206), maker: MAKER, total: 599_999 });
    await as(db, MAKER);
    await expectSelfApproveBlocked(db.query('SELECT public.approve_voucher($1)', [id(205)]));
    await db.query('SELECT public.approve_voucher($1)', [id(206)]);
    expect(await status(db, id(206))).toMatchObject({ approval_status: 'APPROVED', approved_by: MAKER });
  });

  it('phiếu 300k chờ duyệt (vd hạng mục bắt buộc duyệt): người lập vẫn duyệt được như cũ, cả hai writer', async () => {
    await seed(db, { id: id(207), maker: MAKER, total: 300_000 });
    await seed(db, { id: id(208), maker: MAKER, total: 300_000, owned: true });
    await as(db, MAKER);
    await db.query('SELECT public.approve_pending_income_expense_checked_v1($1, 1)', [id(207)]);
    await db.query('SELECT public.approve_pending_income_expense_checked_v1($1, 1)', [id(208)]);
    expect((await status(db, id(207))).approval_status).toBe('APPROVED');
    expect((await status(db, id(208))).approval_status).toBe('APPROVED');
  });

  it('người khác có quyền duyệt ở toà của phiếu ⇒ duyệt được (cả hai writer + nút web)', async () => {
    await seed(db, { id: id(209), maker: MAKER, total: 1_200_000 });
    await seed(db, { id: id(210), maker: MAKER, total: 1_200_000, owned: true });
    await seed(db, { id: id(211), maker: MAKER, total: 1_200_000 });
    await as(db, APPROVER);
    await db.query('SELECT public.approve_voucher($1)', [id(209)]);
    await db.query('SELECT public.approve_income_expense_v1($1)', [id(210)]);
    await db.query('SELECT public.approve_pending_income_expense_checked_v1($1, 1)', [id(211)]);
    for (const v of [id(209), id(210), id(211)]) {
      expect(await status(db, v)).toMatchObject({ approval_status: 'APPROVED', approved_by: APPROVER });
    }
  });

  it('người lập CÓ quyền duyệt ở toà (câu 05) và super admin vẫn tự duyệt phiếu vượt ngưỡng', async () => {
    await seed(db, { id: id(212), maker: MAKER_APPROVER, total: 5_000_000, account: ACC_MAKER_APPROVER });
    await seed(db, { id: id(213), maker: OWNER, total: 5_000_000, owned: true });
    await as(db, MAKER_APPROVER);
    await db.query('SELECT public.approve_voucher($1)', [id(212)]);
    await as(db, OWNER);
    await db.query('SELECT public.approve_income_expense_v1($1)', [id(213)]);
    expect(await status(db, id(212))).toMatchObject({ approval_status: 'APPROVED', approved_by: MAKER_APPROVER });
    expect(await status(db, id(213))).toMatchObject({ approval_status: 'APPROVED', approved_by: OWNER });
  });

  it('quyền duyệt tính theo TOÀ của phiếu: có quyền ở toà B không tự duyệt được phiếu toà A', async () => {
    await seed(db, { id: id(214), maker: OTHER_SCOPE, total: 1_200_000 });
    await as(db, OTHER_SCOPE);
    await expectSelfApproveBlocked(db.query('SELECT public.approve_voucher($1)', [id(214)]));
  });

  it('phiếu không gắn toà: đúng rào duyệt của writer — chỉ super admin tự duyệt; quyền ở toà khác hay cả công ty đều KHÔNG đủ', async () => {
    await seed(db, { id: id(215), maker: OTHER_SCOPE, total: 1_200_000, building: null });
    await seed(db, { id: id(216), maker: MAKER, total: 1_200_000, building: null });
    await seed(db, { id: id(217), maker: OFFBOARDED, total: 1_200_000, building: null });
    await seed(db, { id: id(226), maker: OWNER, total: 1_200_000, building: null });
    await seed(db, { id: id(227), maker: ORG_APPROVER, total: 1_200_000, building: null });
    await seed(db, { id: id(228), maker: ORG_APPROVER, total: 1_200_000 });
    // Có quyền duyệt ở toà B (has_any_scope_v3 cũ sẽ cho qua — lỗ review A) ⇒ nay chặn.
    await as(db, OTHER_SCOPE);
    await expectSelfApproveBlocked(db.query('SELECT public.approve_voucher($1)', [id(215)]));
    // Quyền duyệt cả công ty: phiếu toà A tự duyệt được, phiếu không toà thì không (writer cũng
    // chỉ cho super admin duyệt phiếu không toà).
    await as(db, ORG_APPROVER);
    await expectSelfApproveBlocked(db.query('SELECT public.approve_voucher($1)', [id(227)]));
    await db.query('SELECT public.approve_voucher($1)', [id(228)]);
    expect((await status(db, id(228))).approval_status).toBe('APPROVED');
    // Super admin không có dòng quyền nào: vẫn là người có quyền duyệt.
    await as(db, OWNER);
    await db.query('SELECT public.approve_voucher($1)', [id(226)]);
    expect((await status(db, id(226))).approval_status).toBe('APPROVED');
    await as(db, MAKER);
    await expectSelfApproveBlocked(db.query('SELECT public.approve_voucher($1)', [id(216)]));
    await as(db, OFFBOARDED);
    await expectSelfApproveBlocked(db.query('SELECT public.approve_voucher($1)', [id(217)]));
    for (const v of [id(215), id(216), id(217), id(227)]) {
      expect((await status(db, v)).approval_status).toBe('UNAPPROVED');
    }
  });

  it('has_building_perm_v1: một khoá đủ trong nhiều khoá, toà NULL chỉ super admin, khoá sai ⇒ 22023, chưa đăng nhập ⇒ false', async () => {
    const co = async (actor: string | null, building: string | null, ...keys: string[]) => {
      await as(db, actor);
      const r = await db.query<{ ok: boolean }>(
        `SELECT app_private.has_building_perm_v1($1::uuid, VARIADIC $2::text[]) AS ok`, [building, keys]);
      return r.rows[0].ok;
    };
    expect(await co(APPROVER, B_A, 'income_expenses.approve')).toBe(true);
    expect(await co(APPROVER, B_B, 'income_expenses.approve')).toBe(false);
    expect(await co(APPROVER, B_B, 'contracts.terminate', 'income_expenses.approve')).toBe(false);
    expect(await co(APPROVER, B_A, 'contracts.terminate', 'income_expenses.approve')).toBe(true);
    expect(await co(ORG_APPROVER, B_B, 'income_expenses.approve')).toBe(true);
    expect(await co(ORG_APPROVER, null, 'income_expenses.approve')).toBe(false);
    expect(await co(OWNER, null, 'income_expenses.approve')).toBe(true);
    expect(await co(OFFBOARDED, B_A, 'income_expenses.approve')).toBe(false);
    expect(await co(null, B_A, 'income_expenses.approve')).toBe(false);
    await as(db, APPROVER);
    const e = await failure(db.query(`SELECT app_private.has_building_perm_v1($1::uuid, VARIADIC $2::text[])`, [B_A, ['khong hop le']]));
    expect(e.code).toBe('22023');
  });

  it('phiếu THU và công ty chưa đặt ngưỡng: luật không áp (ngưỡng chỉ cho phiếu chi)', async () => {
    await seed(db, { id: id(218), maker: MAKER, total: 9_000_000, type: 'INCOME' });
    await seed(db, { id: id(219), maker: MAKER, total: 9_000_000, org: ORG_NO_THRESHOLD, building: B_FREE });
    await as(db, MAKER);
    await db.query('SELECT public.approve_voucher($1)', [id(218)]);
    await db.query('SELECT public.approve_voucher($1)', [id(219)]);
    expect((await status(db, id(218))).approval_status).toBe('APPROVED');
    expect((await status(db, id(219))).approval_status).toBe('APPROVED');
  });

  it('luồng nội bộ "Thanh toán phiếu phí nháp": người lập có quyền duyệt vẫn trả + duyệt; không có quyền ⇒ chặn, sổ quỹ không bị ghi', async () => {
    await seed(db, { id: id(220), maker: MAKER_APPROVER, total: 3_000_000, account: null });
    await seed(db, { id: id(221), maker: MAKER, total: 3_000_000, account: null });
    await as(db, MAKER_APPROVER);
    await db.query('SELECT public.pay_draft_fee_voucher($1, $2, NULL)', [id(220), ACC_MAKER_APPROVER]);
    expect(await status(db, id(220))).toMatchObject({ approval_status: 'APPROVED', approved_by: MAKER_APPROVER, account_id: ACC_MAKER_APPROVER });
    await as(db, MAKER);
    await expectSelfApproveBlocked(db.query('SELECT public.pay_draft_fee_voucher($1, $2, NULL)', [id(221), ACC_MAKER]));
    expect(await status(db, id(221))).toMatchObject({ approval_status: 'UNAPPROVED', account_id: null });
  });

  it('luồng nội bộ "Chốt lương": người chốt có quyền duyệt vẫn duyệt phiếu hoa hồng vượt ngưỡng do mình lập', async () => {
    await seed(db, { id: id(222), maker: MAKER_APPROVER, total: 1_500_000, account: ACC_MAKER_APPROVER });
    await as(db, MAKER_APPROVER);
    const r = await db.query<{ r: { commission_approved: number; state: string } }>(
      `SELECT public.lock_salary_month_v1('2026-09-01', $1::jsonb, 'q25-after-lock-0001')::jsonb AS r`,
      [JSON.stringify([{ staff_id: STAFF, commission_voucher_ids: [id(222)] }])]);
    expect(r.rows[0].r).toMatchObject({ commission_approved: 1, state: 'LOCKED' });
    expect(await status(db, id(222))).toMatchObject({ approval_status: 'APPROVED', approved_by: MAKER_APPROVER });
  });

  it('chốt lương bởi người KHÔNG có quyền duyệt mà là người lập phiếu vượt ngưỡng ⇒ cả lượt dừng (không có cửa hậu)', async () => {
    await seed(db, { id: id(223), maker: LOCKER_NO_APPROVE, total: 1_500_000, account: ACC_LOCKER });
    await as(db, LOCKER_NO_APPROVE);
    await expectSelfApproveBlocked(db.query(
      `SELECT public.lock_salary_month_v1('2026-08-01', $1::jsonb, 'q25-after-lock-0002')`,
      [JSON.stringify([{ staff_id: STAFF, commission_voucher_ids: [id(223)] }])]));
    expect((await status(db, id(223))).approval_status).toBe('UNAPPROVED');
    const locked = await db.query(`SELECT 1 FROM public.salary_monthly WHERE period_month = '2026-08-01'`);
    expect(locked.rows).toHaveLength(0);
  });

  it('cổng web ie_self_approve_gate_v1: chỉ báo chặn cho người lập không có quyền, trên phiếu của chính họ', async () => {
    await seed(db, { id: id(224), maker: MAKER, total: 1_200_000 });
    await seed(db, { id: id(225), maker: MAKER, total: 300_000 });
    const gate = async (actor: string, voucher: string) => {
      await as(db, actor);
      return (await db.query<{ g: Record<string, unknown> }>('SELECT public.ie_self_approve_gate_v1($1) AS g', [voucher])).rows[0].g;
    };
    expect(await gate(MAKER, id(224))).toEqual({
      voucherId: id(224), selfApproveBlocked: true, reason: REASON, threshold: 600000,
    });
    expect(await gate(MAKER, id(225))).toMatchObject({ selfApproveBlocked: false, reason: null, threshold: null });
    // Phiếu người khác / phiếu không tồn tại: luôn false — cổng không thành máy dò.
    expect(await gate(APPROVER, id(224))).toMatchObject({ selfApproveBlocked: false, threshold: null });
    expect(await gate(OTHER_SCOPE, id(224))).toMatchObject({ selfApproveBlocked: false, threshold: null });
    expect(await gate(MAKER, id(999))).toMatchObject({ selfApproveBlocked: false });
    await as(db, null);
    const e = await failure(db.query('SELECT public.ie_self_approve_gate_v1($1)', [id(224)]));
    expect(e.code).toBe('42501');
  });

  it('ACL: authenticated gọi được cổng, không gọi được hàm luật; anon không gọi được cổng', async () => {
    const priv = async (role: string, sig: string) =>
      (await db.query<{ ok: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, sig])).rows[0].ok;
    expect(await priv('authenticated', 'public.ie_self_approve_gate_v1(uuid)')).toBe(true);
    expect(await priv('anon', 'public.ie_self_approve_gate_v1(uuid)')).toBe(false);
    for (const sig of ['app_private.ie_self_approve_over_threshold_blocked_v1(uuid)', 'app_private.has_building_perm_v1(uuid, text[])',
      'app_private.require_building_perm_v1(uuid, text, text[])']) {
      for (const role of ['authenticated', 'anon', 'service_role']) {
        expect(await priv(role, sig), `${role} → ${sig}`).toBe(false);
      }
    }
    // Đường REST thật: SET ROLE authenticated rồi gọi.
    await as(db, MAKER);
    await db.exec('SET ROLE authenticated');
    try {
      const g = await db.query<{ g: { selfApproveBlocked: boolean } }>('SELECT public.ie_self_approve_gate_v1($1) AS g', [id(224)]);
      expect(g.rows[0].g.selfApproveBlocked).toBe(true);
      const e = await failure(db.query('SELECT app_private.ie_self_approve_over_threshold_blocked_v1($1)', [id(224)]));
      expect(e.code).toBe('42501');
    } finally {
      await db.exec('RESET ROLE');
    }
  });

  it('chữ ký / số overload không đổi: mỗi tên đúng một hàm, writer vẫn SECURITY DEFINER', async () => {
    const r = await db.query<{ proname: string; n: number; definer: boolean }>(`
      SELECT p.proname, count(*)::int AS n, bool_and(p.prosecdef) AS definer
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.proname IN ('approve_income_expense_v1', 'approve_voucher', 'ie_self_approve_gate_v1',
                           'ie_self_approve_over_threshold_blocked_v1', 'has_building_perm_v1', 'require_building_perm_v1')
       GROUP BY p.proname ORDER BY p.proname`);
    expect(r.rows).toEqual([
      { proname: 'approve_income_expense_v1', n: 1, definer: true },
      { proname: 'approve_voucher', n: 1, definer: true },
      { proname: 'has_building_perm_v1', n: 1, definer: true },
      { proname: 'ie_self_approve_gate_v1', n: 1, definer: true },
      { proname: 'ie_self_approve_over_threshold_blocked_v1', n: 1, definer: true },
      { proname: 'require_building_perm_v1', n: 1, definer: true },
    ]);
  });
});

describe('câu 25 — require_building_perm_v1 (câu 26) gọi has_building_perm_v1: hành vi y hệt bản production', () => {
  // Một ma trận người × toà × khoá × việc; ghi kết quả TRƯỚC vá (bản câu 26 đang chạy) rồi SAU vá
  // (hai lượt như lane) — phải trùng từng ca: qua / ERRCODE / câu báo / HINT.
  const NGUOI = [null, MAKER, APPROVER, OTHER_SCOPE, ORG_APPROVER, OWNER, OFFBOARDED];
  const TOA = [B_A, B_B, null];
  const KHOA: string[][] = [
    ['income_expenses.approve'], ['contracts.terminate'], ['contracts.terminate', 'income_expenses.approve'],
    ['khong hop le'], [],
  ];
  const VIEC = ['thanh lý hợp đồng', ''];

  async function chayMaTran(db: PGlite) {
    const ketQua: string[] = [];
    for (const nguoi of NGUOI) {
      await as(db, nguoi);
      for (const toa of TOA) {
        for (const khoa of KHOA) {
          for (const viec of VIEC) {
            const ca = `${nguoi ?? 'chưa đăng nhập'} · ${toa ?? 'toà NULL'} · [${khoa.join('|')}] · "${viec}"`;
            try {
              await db.query('SELECT app_private.require_building_perm_v1($1::uuid, $2, VARIADIC $3::text[])', [toa, viec, khoa]);
              ketQua.push(`${ca} ⇒ qua`);
            } catch (error) {
              const e = error as PgError;
              ketQua.push(`${ca} ⇒ ${e.code} | ${e.message} | ${e.hint ?? ''}`);
            }
          }
        }
      }
    }
    return ketQua;
  }

  it('trùng từng ca trước/sau vá; ma trận có đủ qua, 42501 [THIEU_QUYEN] và 22023', async () => {
    const db = new PGlite();
    try {
      await build(db, { patch: false });
      const truoc = await chayMaTran(db);
      await db.exec(readFileSync(PATCH, 'utf8'));
      await db.exec(readFileSync(PATCH, 'utf8'));
      expect(await md5(db, 'app_private.require_building_perm_v1(uuid,text,text[])')).not.toBe(PROD_MD5.requirePerm);
      const sau = await chayMaTran(db);
      expect(sau).toEqual(truoc);
      expect(truoc).toHaveLength(NGUOI.length * TOA.length * KHOA.length * VIEC.length);
      expect(truoc.filter((x) => x.endsWith('⇒ qua')).length).toBeGreaterThan(10);
      expect(truoc.some((x) => x.includes('⇒ 42501 | [THIEU_QUYEN:income_expenses.approve] Bạn không có quyền thanh lý hợp đồng ở toà nhà này.'))).toBe(true);
      expect(truoc.some((x) => x.includes('⇒ 42501 | [THIEU_QUYEN] Bạn chưa đăng nhập.'))).toBe(true);
      expect(truoc.some((x) => x.includes('⇒ 22023 | require_building_perm_v1: khoá quyền không hợp lệ'))).toBe(true);
      // Toà NULL: chỉ super admin qua (kể cả người có quyền cả công ty).
      expect(truoc.filter((x) => x.includes('· toà NULL ·') && x.endsWith('⇒ qua')).every((x) => x.startsWith(OWNER))).toBe(true);
    } finally {
      await db.close();
    }
  });

  it('tiền kiểm: require_building_perm_v1 khác bản câu 26 đã đối chiếu ⇒ dừng 55000', async () => {
    const db = new PGlite();
    try {
      await build(db, { patch: false });
      await db.exec(SOURCES.requirePerm().replace('Bạn chưa đăng nhập.', 'Bạn chưa đăng nhập!'));
      const e = await failure(db.exec(readFileSync(PATCH, 'utf8')));
      expect(e.code).toBe('55000');
      expect(e.message).toContain('app_private.require_building_perm_v1(uuid, text, text[]) KHÁC bản đã đối chiếu');
    } finally {
      await db.close();
    }
  });
});

describe('câu 25 — tiền kiểm của migration', () => {
  it('approve_voucher khác bản đã đối chiếu ⇒ dừng 55000, không vá mù', async () => {
    const db = new PGlite();
    try {
      await build(db, { patch: false });
      await db.exec(SOURCES.approveVoucher()
        .replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')
        .replace('-- t5_26: phiếu thuộc engine', '-- bản lạ: phiếu thuộc engine'));
      const e = await failure(db.exec(readFileSync(PATCH, 'utf8')));
      expect(e.code).toBe('55000');
      expect(e.message).toContain('public.approve_voucher(uuid) KHÁC bản đã đối chiếu');
    } finally {
      await db.close();
    }
  });
});

describe('câu 25 — Copilot / Hermes đi cùng luật', () => {
  // Định nghĩa CUỐI trong file (lastIndexOf) đến hết thân dollar-quoted của nó.
  const thanHam = (path: string, header: string) => {
    const sql = readFileSync(path, 'utf8');
    const start = sql.lastIndexOf(header);
    expect(start, `không thấy ${header}`).toBeGreaterThan(-1);
    const mo = /\bAS\s+(\$[A-Za-z0-9_]*\$)/.exec(sql.slice(start));
    expect(mo, `không thấy thân hàm sau ${header}`).not.toBeNull();
    const tag = mo![1];
    const open = start + mo!.index + mo![0].length;
    return sql.slice(start, sql.indexOf(tag, open) + tag.length);
  };

  it('Copilot duyệt (copilot_execute_ie_duyet_v1, bản sống) chỉ đi cặp bỏ cọc / approve_income_expense_v1 / approve_voucher', () => {
    const fn = thanHam(COPILOT_DUYET, 'CREATE OR REPLACE FUNCTION public.copilot_execute_ie_duyet_v1');
    expect(fn).toContain('PERFORM public.set_termination_forfeit_status_v1(v_ie_id, \'APPROVED\');');
    expect(fn).toContain('PERFORM public.approve_income_expense_v1(v_ie_id);');
    expect(fn).toContain('PERFORM public.approve_voucher(v_ie_id);');
    expect(fn).not.toMatch(/UPDATE\s+public\.income_expenses/i);
    expect(fn).toContain("v_row.permission_key IS DISTINCT FROM 'income_expenses.approve'");
  });

  it('Hermes chưa có đường duyệt: ghi phiếu chi chỉ qua create_income_expense_v1, không gọi writer duyệt', () => {
    const fn = thanHam(HERMES_EXPENSE, 'CREATE OR REPLACE FUNCTION public.hermes_expense_action_v1');
    expect(fn).toContain('public.create_income_expense_v1(');
    expect(fn).not.toMatch(/approve_voucher|approve_income_expense_v1|approve_pending_income_expense_checked_v1/);
    expect(fn).not.toMatch(/UPDATE\s+public\.income_expenses/i);
  });
});
