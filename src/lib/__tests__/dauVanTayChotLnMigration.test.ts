// Dấu vân tay Chốt LN theo SỐ TIỀN (22/10/2026 — đợt rà Báo cáo Lợi nhuận 21/10: F19).
//
// Chạy logic THẬT trên PGlite. Hai cơ sở dữ liệu cùng dữ liệu giả, cùng id:
//   - `truoc`: thân PRODUCTION trước migration — preview core lấy từ baseline (md5 prosrc
//     ff014d6c…), kiểm độ tươi lấy từ 20260721120000 (b33478e0…) — làm ĐỐI CHỨNG;
//   - `sau`: cùng thân đó, chốt tháng 7 bằng thuật toán CŨ, rồi áp migration HAI lượt và nạp
//     định nghĩa SỐNG (lần CREATE cuối trong thư mục migration), chốt tháng 8 bằng thuật toán MỚI.
// Writer, wrapper, mở chốt, fa_accrual_allocations, lương điều hành… là thân production thật
// (md5 đối chiếu bên dưới); chỉ phần quyền (_profit_assert_authorized_v2, authorize_v2,
// can_access_building, is_super_admin) là stub cho qua. Mọi tên, số tiền, id ở đây là giả.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PATCH = 'supabase/migrations/20261022172459_dau_van_tay_chot_ln_theo_so_tien.sql';
const PAYOUT_V2 = 'supabase/migrations/20260721120000_profit_payout_reservations_v2.sql';
const BASELINE = 'supabase/baseline/schema.sql';

const SIG = {
  preview: 'public._profit_close_preview_core_v2(uuid,date,uuid[],jsonb,text,boolean)',
  dispatch: 'app_private.profit_monthly_source_is_current_v1(uuid)',
  hashV1: 'app_private.current_profit_building_source_hash_v1(uuid)',
  hashV2: 'app_private.current_profit_building_source_hash_v2(uuid)',
  project: 'app_private.profit_building_source_hash_v2_2(jsonb,uuid)',
  algorithm: 'app_private.profit_building_source_hash_algorithm_v1(uuid)',
} as const;

/** md5(prosrc bỏ CR) đọc trên PRODUCTION 22/10/2026 (chỉ đọc, pg_proc). */
const PROD_MD5: Record<string, string> = {
  [SIG.preview]: 'ff014d6c3b84fb5c4e04f4579f787ce4',
  [SIG.dispatch]: 'b33478e043a11eb08ad7d265ae156522',
  [SIG.hashV1]: '366110557ac4e6c4ec2b6c0176ba3f89',
  'public.fa_accrual_allocations(date,date,uuid[])': '31204e1e440e0836d1dde1eabf3d56d4',
  'public.fa_monthly_pnl_accrual(date,date,uuid[])': '3d79458205720d956429d3520d2f800a',
  'public._profit_management_allocations_v2(uuid,jsonb)': '96cd3e197c9c2a6c031a2ac8e04700f7',
  'public._profit_write_close_v2_base(text,uuid,date,text,text,text,uuid[],jsonb)':
    '67f05808d05d408d584e230dce94d2dc',
  'public._profit_write_close_v2(text,uuid,date,text,text,text,uuid[],jsonb)':
    '78d8a5b474320e663622da7df461e0a8',
  'public._profit_enrich_unallocated_v3(jsonb,jsonb)': 'c911bbb05da544255e8d114e55259618',
  'public._profit_state_change_v2(text,uuid,date,text,text,uuid[],text)':
    '04473f29d8ab55fced31d18ac7708698',
};

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = id(1);
const OWNER = id(2);
const ACTOR = id(3);
const [A, B, C, D] = [11, 12, 13, 14].map(id);
const BUILDINGS = [A, B, C, D];
const [T_THU, T_CHI] = [21, 22].map(id);
const [S1, S2] = [31, 32].map(id);
const M1 = id(41);
const [R_NHOM, R_TUNG_TOA] = [51, 52].map(id);
const JUL = '2026-07-01';
const AUG = '2026-08-01';
const REASON_D = 'Giu lai cho cong ty (thu nghiem)';

// ---------------------------------------------------------------- nạp định nghĩa
let corpus: { file: string; sql: string; lower: string }[] | null = null;
/** Mọi CREATE (không nằm trong dòng chú thích) của một hàm, theo thứ tự tên file migration. */
function definitionsOf(schema: string, fnName: string): { file: string; sql: string; start: number }[] {
  corpus ??= readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort().map((file) => {
    const sql = readFileSync(join('supabase/migrations', file), 'utf8').replace(/\r\n/g, '\n');
    return { file, sql, lower: sql.toLowerCase() };
  });
  const needle = `${schema}.${fnName}`.toLowerCase();
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${schema}\\.${fnName}\\s*\\(`, 'gi');
  const hits: { file: string; sql: string; start: number }[] = [];
  for (const { file, sql, lower } of corpus) {
    if (!lower.includes(needle)) continue;
    for (const m of sql.matchAll(re)) {
      const lineStart = sql.lastIndexOf('\n', m.index) + 1;
      if (!sql.slice(lineStart, m.index).includes('--')) hits.push({ file, sql, start: m.index });
    }
  }
  return hits;
}

/** Định nghĩa SỐNG = lần CREATE cuối theo tên file migration. */
function liveFunctionSql(schema: string, fnName: string): string {
  const hit = definitionsOf(schema, fnName).at(-1);
  if (!hit) throw new Error(`Không tìm thấy định nghĩa ${schema}.${fnName}`);
  return cutCreate(hit.sql.slice(hit.start), `${schema}.${fnName}`);
}

function cutCreate(rest: string, label: string): string {
  const open = /\bAS\s+(\$[A-Za-z0-9_]*\$)/.exec(rest);
  if (!open) throw new Error(`${label}: không thấy thân hàm`);
  const close = rest.indexOf(open[1], open.index + open[0].length);
  return `${rest.slice(0, close + open[1].length)};`;
}

/** Cắt đúng một CREATE từ một file (dùng cho thân production làm đối chứng). */
function sliceFunction(path: string, header: string): string {
  const sql = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const start = sql.indexOf(header);
  if (start < 0) throw new Error(`Không thấy ${header} trong ${path}`);
  return cutCreate(sql.slice(start), header);
}

/** md5 của prosrc (phần giữa hai dấu dollar) — cùng phép đo với tiền kiểm của migration. */
function prosrcMd5(createSql: string): string {
  const open = /\bAS\s+(\$[A-Za-z0-9_]*\$)/.exec(createSql);
  if (!open) throw new Error('không thấy thân hàm');
  const from = open.index + open[0].length;
  const body = createSql.slice(from, createSql.indexOf(open[1], from));
  return createHash('md5').update(body.replace(/\r/g, ''), 'utf8').digest('hex');
}

const OLD_PREVIEW = sliceFunction(BASELINE, 'CREATE FUNCTION public._profit_close_preview_core_v2(');
const OLD_DISPATCH = sliceFunction(PAYOUT_V2, 'CREATE OR REPLACE FUNCTION app_private.profit_monthly_source_is_current_v1(');
const STATE_CHANGE = sliceFunction(BASELINE, 'CREATE FUNCTION public._profit_state_change_v2(');
const PATCH_SQL = readFileSync(PATCH, 'utf8');

const SCHEMA = `
  CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
  CREATE SCHEMA app_private; CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
    AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
  -- Quyền: stub cho qua (ngoài phạm vi migration này).
  CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
  CREATE FUNCTION public.authorize_v2(text, uuid, text, uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
  CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
  CREATE FUNCTION public._profit_assert_authorized_v2(p_organization_id uuid, p_permission_key text)
    RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
  -- Bảng chỉ để LOCK TABLE của preview khi chốt.
  CREATE TABLE public.staff_assignments(id uuid);
  CREATE TABLE public.roles(id uuid);
  CREATE TABLE public.area_buildings(id uuid);
  CREATE TABLE public.super_admins(user_id uuid);

  CREATE TABLE public.buildings(id uuid PRIMARY KEY, organization_id uuid, user_id uuid NOT NULL, name text NOT NULL,
    is_virtual boolean NOT NULL DEFAULT false, deleted_at timestamptz);
  CREATE TABLE public.invoices(id uuid PRIMARY KEY, billing_month text, deleted_at timestamptz);
  CREATE TABLE public.income_expense_types(id uuid PRIMARY KEY, organization_id uuid NOT NULL, name text NOT NULL,
    type text NOT NULL, category text);
  CREATE TABLE public.income_expenses(id uuid PRIMARY KEY, organization_id uuid, building_id uuid, type text NOT NULL,
    voucher_date date NOT NULL, total_amount numeric(15,2) NOT NULL, business_result_accounting boolean,
    approval_status text NOT NULL DEFAULT 'APPROVED', invoice_id uuid, deleted_at timestamptz);
  CREATE TABLE public.income_expense_items(id uuid PRIMARY KEY, income_expense_id uuid NOT NULL,
    income_expense_type_id uuid NOT NULL, quantity integer NOT NULL DEFAULT 1, unit_price numeric(15,2) NOT NULL DEFAULT 0,
    amount numeric(15,2), start_date date, end_date date, accounting_class text NOT NULL);
  CREATE TABLE public.shareholders(id uuid PRIMARY KEY, organization_id uuid, name text NOT NULL,
    is_active boolean NOT NULL DEFAULT true, deleted_at timestamptz);
  CREATE TABLE public.building_shareholders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid,
    building_id uuid NOT NULL, shareholder_id uuid NOT NULL, percent numeric(5,2) NOT NULL DEFAULT 0);
  CREATE TABLE public.profit_managers(id uuid PRIMARY KEY, organization_id uuid, name text NOT NULL,
    is_active boolean NOT NULL DEFAULT true, deleted_at timestamptz);
  CREATE TABLE public.profit_manager_salaries(id uuid PRIMARY KEY, organization_id uuid, manager_id uuid NOT NULL,
    label text, form text NOT NULL, basis text NOT NULL, amount numeric(15,2) NOT NULL DEFAULT 0,
    percent numeric(5,2) NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true);
  CREATE TABLE public.profit_manager_salary_buildings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    salary_id uuid NOT NULL, building_id uuid NOT NULL, organization_id uuid);

  CREATE TABLE public.profit_monthly(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
    building_id uuid NOT NULL, period_month date NOT NULL, computed_profit numeric(15,2) NOT NULL DEFAULT 0,
    adjusted_profit numeric(15,2) NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'DRAFT', locked_at timestamptz,
    locked_by uuid, management_salary numeric(15,2) NOT NULL DEFAULT 0, organization_id uuid NOT NULL,
    adjustment_amount numeric(15,2) NOT NULL DEFAULT 0, adjustment_reason text, adjustment_by uuid,
    adjustment_at timestamptz, source_revenue numeric(15,2), source_expense numeric(15,2),
    source_net_profit numeric(15,2), source_hash text NOT NULL, source_captured_at timestamptz NOT NULL,
    is_stale boolean NOT NULL DEFAULT true, stale_reason text, revision_number bigint NOT NULL DEFAULT 1,
    shareholder_percent_total numeric(9,4) NOT NULL DEFAULT 0,
    shareholder_allocated_amount numeric(15,2) NOT NULL DEFAULT 0,
    unallocated_profit numeric(15,2) NOT NULL DEFAULT 0, unallocated_disposition text,
    unallocated_disposition_reason text,
    CONSTRAINT profit_monthly_building_period_uq UNIQUE (building_id, period_month),
    CONSTRAINT profit_monthly_source_hash_v2 CHECK (source_hash ~ '^[0-9a-f]{32}$'));
  CREATE TABLE public.profit_allocations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
    profit_monthly_id uuid NOT NULL, shareholder_id uuid NOT NULL, percent numeric(5,2) NOT NULL DEFAULT 0,
    amount numeric(15,2) NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), organization_id uuid);
  CREATE TABLE public.profit_manager_allocations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
    profit_monthly_id uuid NOT NULL, manager_id uuid NOT NULL, amount numeric(15,2) NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(), organization_id uuid);
  CREATE TABLE public.profit_close_runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
    period_month date NOT NULL, operation text NOT NULL, actor_id uuid, reason text NOT NULL,
    idempotency_key text NOT NULL, request_payload jsonb NOT NULL DEFAULT '{}', request_hash text NOT NULL,
    expected_source_hash text, source_hash text, source_captured_at timestamptz,
    source_snapshot jsonb NOT NULL DEFAULT '{}', allocation_snapshot jsonb NOT NULL DEFAULT '[]',
    result_snapshot jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE TABLE public.profit_close_revisions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL,
    organization_id uuid NOT NULL, profit_monthly_id uuid NOT NULL, building_id uuid NOT NULL,
    period_month date NOT NULL, revision_number bigint NOT NULL, operation text NOT NULL, actor_id uuid,
    reason text NOT NULL, source_hash text, source_captured_at timestamptz,
    source_snapshot jsonb NOT NULL DEFAULT '{}', shareholder_allocations jsonb NOT NULL DEFAULT '[]',
    manager_allocations jsonb NOT NULL DEFAULT '[]', previous_snapshot jsonb, current_snapshot jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT profit_close_revisions_number_v2 UNIQUE (organization_id, building_id, period_month, revision_number));
  CREATE TABLE public.profit_unallocated_decisions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid,
    organization_id uuid NOT NULL, profit_monthly_id uuid NOT NULL, building_id uuid NOT NULL,
    period_month date NOT NULL, unallocated_profit numeric(15,2) NOT NULL, disposition text NOT NULL,
    reason text NOT NULL, decision_source text NOT NULL, actor_id uuid,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE UNIQUE INDEX profit_unallocated_decisions_run_pm_uq
    ON public.profit_unallocated_decisions(run_id, profit_monthly_id) WHERE run_id IS NOT NULL;
`;

/** Hàm sống không bị migration này thay (nạp trước, ở cả hai cơ sở dữ liệu). */
const LIVE_DEPENDENCIES = [
  ['public', 'fa_accrual_allocations'],
  ['public', 'fa_monthly_pnl_accrual'],
  ['public', '_profit_management_allocations_v2'],
  ['public', '_profit_enrich_unallocated_v3'],
  ['public', '_profit_write_close_v2_base'],
  ['public', '_profit_write_close_v2'],
  ['app_private', 'current_profit_building_source_hash_v1'],
] as const;
/** Hàm migration này định nghĩa — sau khi áp, nạp lại bản SỐNG. */
const LIVE_PATCHED = [
  ['app_private', 'profit_building_source_hash_v2_2'],
  ['app_private', 'profit_building_source_hash_algorithm_v1'],
  ['app_private', 'current_profit_building_source_hash_v2'],
  ['app_private', 'profit_monthly_source_is_current_v1'],
  ['public', '_profit_close_preview_core_v2'],
] as const;

const money = (n: number) => n.toFixed(2);

async function seed(db: PGlite) {
  await db.exec(`
    INSERT INTO public.buildings(id, organization_id, user_id, name) VALUES
      ('${A}','${ORG}','${OWNER}','Toa A'),('${B}','${ORG}','${OWNER}','Toa B'),
      ('${C}','${ORG}','${OWNER}','Toa C'),('${D}','${ORG}','${OWNER}','Toa D');
    INSERT INTO public.income_expense_types(id, organization_id, name, type, category) VALUES
      ('${T_THU}','${ORG}','Tien phong','income','Phong'),('${T_CHI}','${ORG}','Tien dien','expense','Dien');
    INSERT INTO public.shareholders(id, organization_id, name) VALUES
      ('${S1}','${ORG}','Co dong mot'),('${S2}','${ORG}','Co dong hai');
    INSERT INTO public.building_shareholders(organization_id, building_id, shareholder_id, percent) VALUES
      ('${ORG}','${A}','${S1}',60),('${ORG}','${A}','${S2}',40),('${ORG}','${B}','${S1}',100),
      ('${ORG}','${C}','${S2}',100),('${ORG}','${D}','${S1}',50);
    INSERT INTO public.profit_managers(id, organization_id, name) VALUES ('${M1}','${ORG}','Quan ly mot');
    -- A–C chung quy tắc TỔNG NHÓM; A–B chung quy tắc TỪNG TOÀ; D đứng riêng.
    INSERT INTO public.profit_manager_salaries(id, organization_id, manager_id, label, form, basis, amount, percent) VALUES
      ('${R_NHOM}','${ORG}','${M1}','Nhom AC','FIXED','TOTAL_GROUP',1000000,0),
      ('${R_TUNG_TOA}','${ORG}','${M1}','Tung toa','PERCENT','PER_BUILDING',0,5);
    INSERT INTO public.profit_manager_salary_buildings(salary_id, building_id, organization_id) VALUES
      ('${R_NHOM}','${A}','${ORG}'),('${R_NHOM}','${C}','${ORG}'),
      ('${R_TUNG_TOA}','${A}','${ORG}'),('${R_TUNG_TOA}','${B}','${ORG}');
  `);
  // Toà A có HAI phiếu thu để đo "chuyển tiền giữa hai phiếu, tổng toà không đổi".
  const vouchers: Record<string, ['INCOME' | 'EXPENSE', string, number][]> = {
    [A]: [['INCOME', T_THU, 10_000_000], ['INCOME', T_THU, 2_000_000], ['EXPENSE', T_CHI, 3_000_000]],
    [B]: [['INCOME', T_THU, 8_000_000], ['EXPENSE', T_CHI, 2_000_000]],
    [C]: [['INCOME', T_THU, 6_000_000], ['EXPENSE', T_CHI, 1_000_000]],
    [D]: [['INCOME', T_THU, 4_000_000], ['EXPENSE', T_CHI, 500_000]],
  };
  let n = 100;
  for (const month of [JUL, AUG]) {
    const last = month === JUL ? '2026-07-31' : '2026-08-31';
    for (const b of BUILDINGS) {
      for (const [side, type, amount] of vouchers[b]) {
        n += 1;
        await db.query(
          `INSERT INTO public.income_expenses(id, organization_id, building_id, type, voucher_date, total_amount)
           VALUES ($1, $2, $3, $4, $5, $6)`, [id(n), ORG, b, side, month, money(amount)]);
        await db.query(
          `INSERT INTO public.income_expense_items(id, income_expense_id, income_expense_type_id, unit_price, amount,
             start_date, end_date, accounting_class) VALUES ($1, $2, $3, $4, $4, $5, $6, 'PNL')`,
          [id(n + 5000), id(n), type, money(amount), month, last]);
      }
    }
  }
}

async function buildDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  for (const [schema, fn] of LIVE_DEPENDENCIES) await db.exec(liveFunctionSql(schema, fn));
  await db.exec(STATE_CHANGE);
  await db.exec(OLD_PREVIEW);
  await db.exec(OLD_DISPATCH);
  await seed(db);
  return db;
}

// ---------------------------------------------------------------- thao tác
type Json = Record<string, unknown>;

/** Preview trên tập toà cho trước (mặc định cả 4 toà — đúng phạm vi writer dùng khi chốt). */
async function preview(db: PGlite, month: string, buildings: string[] = BUILDINGS): Promise<Json> {
  const { rows } = await db.query<{ p: Json }>(
    `SELECT public._profit_close_preview_core_v2($1, $2::date, $3::uuid[],
       CASE WHEN $4::uuid = ANY($3::uuid[])
         THEN jsonb_build_array(jsonb_build_object('building_id', $4::uuid, 'adjustment_amount', 0))
         ELSE '[]'::jsonb END,
       'shareholder_profit.view', false) AS p`,
    [ORG, month, `{${buildings.join(',')}}`, D],
  );
  return rows[0].p;
}

/** Chốt bằng wrapper production; `buildings` = tập GHI (NULL = theo mặc định của writer). */
async function close(db: PGlite, operation: 'CLOSE' | 'RECLOSE', month: string, key: string,
  buildings: string[] | null = null): Promise<Json> {
  const p = await preview(db, month);
  await db.query(`SELECT set_config('test.uid', $1, false)`, [ACTOR]);
  const { rows } = await db.query<{ r: Json }>(
    `SELECT public._profit_write_close_v2($1, $2, $3::date, $4, $5, $6, $9::uuid[],
       jsonb_build_array(jsonb_build_object('building_id', $7::uuid, 'adjustment_amount', 0,
         'unallocated_disposition', 'RETAINED_EARNINGS', 'unallocated_disposition_reason', $8::text))) AS r`,
    [operation, ORG, month, p.source_hash, `Chot thu nghiem ${key}`, `khoa-${key}`, D, REASON_D,
      buildings ? `{${buildings.join(',')}}` : null],
  );
  return rows[0].r;
}

/** Mở chốt / đặt lại bằng _profit_state_change_v2 thật (thân baseline = production). */
async function stateChange(db: PGlite, operation: 'UNLOCK' | 'RESET', month: string, building: string, key: string) {
  await db.query(`SELECT set_config('test.uid', $1, false)`, [ACTOR]);
  await db.query(
    `SELECT public._profit_state_change_v2($6, $1, $2::date, $3, $4, ARRAY[$5::uuid], NULL)`,
    [ORG, month, `Mo chot thu nghiem ${key}`, `khoa-mo-${key}`, building, operation],
  );
}
const unlock = (db: PGlite, month: string, building: string, key: string) =>
  stateChange(db, 'UNLOCK', month, building, key);

async function isCurrent(db: PGlite, month: string): Promise<Record<string, boolean>> {
  const { rows } = await db.query<{ b: string; ok: boolean }>(
    `SELECT pm.building_id::text AS b, app_private.profit_monthly_source_is_current_v1(pm.id) AS ok
       FROM public.profit_monthly pm WHERE pm.period_month = $1::date ORDER BY 1`, [month]);
  return Object.fromEntries(rows.map((r) => [r.b, r.ok]));
}

type Flags = { mismatch: boolean; stale: boolean; reason: string | null };
async function previewFlags(db: PGlite, month: string, buildings: string[] = BUILDINGS): Promise<Record<string, Flags>> {
  const p = await preview(db, month, buildings);
  return Object.fromEntries((p.buildings as Json[]).map((row) => [row.building_id as string, {
    mismatch: row.current_hash_mismatch as boolean,
    stale: row.current_is_stale as boolean,
    reason: (row.current_stale_reason ?? null) as string | null,
  }]));
}

async function algorithm(db: PGlite, month: string): Promise<string[]> {
  const { rows } = await db.query<{ a: string }>(
    `SELECT DISTINCT app_private.profit_building_source_hash_algorithm_v1(pm.id) AS a
       FROM public.profit_monthly pm WHERE pm.period_month = $1::date`, [month]);
  return rows.map((r) => r.a).sort();
}

const all = (value: boolean) => Object.fromEntries(BUILDINGS.map((b) => [b, value]));

/** Mỗi ca chạy trong giao dịch riêng rồi ROLLBACK (mọi cơ sở dữ liệu truyền vào). */
async function scenario(dbs: PGlite[], fn: () => Promise<void>) {
  for (const db of dbs) await db.exec('BEGIN');
  try {
    await fn();
  } finally {
    for (const db of dbs) await db.exec('ROLLBACK');
  }
}

/** Đổi số tiền một dòng phiếu (và tổng phiếu) của toà trong tháng. */
async function changeAmount(db: PGlite, building: string, month: string, side: 'INCOME' | 'EXPENSE', delta: number) {
  await db.query(
    `UPDATE public.income_expense_items item SET amount = item.amount + $4, unit_price = item.unit_price + $4
       FROM public.income_expenses voucher
      WHERE voucher.id = item.income_expense_id AND voucher.building_id = $1 AND voucher.voucher_date = $2::date
        AND voucher.type = $3`, [building, month, side, delta]);
  await db.query(
    `UPDATE public.income_expenses SET total_amount = total_amount + $4
      WHERE building_id = $1 AND voucher_date = $2::date AND type = $3`, [building, month, side, delta]);
}

async function renameEverything(db: PGlite) {
  await db.exec(`
    UPDATE public.buildings SET name = name || ' (doi ten)';
    UPDATE public.income_expense_types SET name = name || ' moi', category = 'Nhom moi';
    UPDATE public.shareholders SET name = name || ' moi';
    UPDATE public.profit_managers SET name = 'Quan ly doi ten';
    UPDATE public.profit_manager_salaries SET label = label || ' (nhan moi)';
  `);
}

async function md5Of(db: PGlite, signature: string): Promise<string | null> {
  const { rows } = await db.query<{ m: string | null }>(
    `SELECT md5(replace(p.prosrc, chr(13), '')) AS m FROM pg_proc p WHERE p.oid = to_regprocedure($1)`, [signature]);
  return rows[0]?.m ?? null;
}

/** Preview bỏ phần dấu vân tay / trạng thái dòng hiện có — chỉ còn SỐ TIỀN và cấu trúc. */
function moneyOnly(p: Json): Json {
  const drop = new Set(['building_source_hash', 'current_status', 'current_revision_number', 'current_source_hash',
    'current_hash_mismatch', 'current_is_stale', 'current_stale_reason', 'current_snapshot']);
  return {
    source_hash: p.source_hash,
    source_snapshot: p.source_snapshot,
    totals: p.totals,
    buildings: (p.buildings as Json[]).map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => !drop.has(k)))),
  };
}

// ---------------------------------------------------------------- dựng
let truoc: PGlite;
let sau: PGlite;
let lane: PGlite;
const md5Truoc: Record<string, string | null> = {};
let julRowsBeforeMigration: unknown[] = [];
let previewTruoc: Json = {};

beforeAll(async () => {
  [truoc, sau, lane] = [await buildDb(), await buildDb(), await buildDb()];
  for (const signature of Object.keys(PROD_MD5)) md5Truoc[signature] = await md5Of(sau, signature);

  // Tháng 7 chốt bằng thuật toán CŨ ở cả hai nơi (đây là "30 dòng cũ").
  await close(truoc, 'CLOSE', JUL, 'jul');
  await close(sau, 'CLOSE', JUL, 'jul');
  previewTruoc = await preview(truoc, AUG);
  julRowsBeforeMigration = (await sau.query(
    `SELECT to_jsonb(pm) AS r FROM public.profit_monthly pm WHERE pm.period_month = $1::date ORDER BY pm.building_id`,
    [JUL])).rows;

  // Lane kiểm idempotency: áp HAI lượt; rồi nạp định nghĩa SỐNG của mọi hàm migration định nghĩa.
  await sau.exec(PATCH_SQL);
  await sau.exec(PATCH_SQL);
  for (const [schema, fn] of LIVE_PATCHED) await sau.exec(liveFunctionSql(schema, fn));

  // Tháng 8 chốt bằng thuật toán MỚI.
  await close(sau, 'CLOSE', AUG, 'aug');
}, 240_000);

afterAll(async () => {
  await Promise.all([truoc?.close(), sau?.close(), lane?.close()]);
});

describe('tiền kiểm + idempotency của migration', () => {
  it('PGlite chạy đúng thân PRODUCTION của mọi hàm liên quan (md5 prosrc)', () => {
    // Hàm phụ thuộc được forward-fix ở file SAU file này thì thân production đã đổi theo file
    // đó (có tiền kiểm riêng) — chỉ ghim những hàm chưa bị thay sau.
    const patchFile = PATCH.split('/').at(-1) ?? PATCH;
    const stillPinned = Object.keys(PROD_MD5).filter((signature) => {
      const [schema, fn] = signature.split('(')[0].split('.');
      return !definitionsOf(schema, fn).some((d) => d.file > patchFile);
    });
    expect(stillPinned).toEqual(expect.arrayContaining([SIG.preview, SIG.dispatch]));
    expect(Object.fromEntries(stillPinned.map((s) => [s, md5Truoc[s]])))
      .toEqual(Object.fromEntries(stillPinned.map((s) => [s, PROD_MD5[s]])));
  });

  it('baseline (đường Restore Drill) mang đúng ba thân production mà tiền kiểm ghim', () => {
    expect({
      preview: prosrcMd5(OLD_PREVIEW),
      dispatch: prosrcMd5(sliceFunction(BASELINE, 'CREATE FUNCTION app_private.profit_monthly_source_is_current_v1(')),
      hashV1: prosrcMd5(sliceFunction(BASELINE, 'CREATE FUNCTION app_private.current_profit_building_source_hash_v1(')),
    }).toEqual({ preview: PROD_MD5[SIG.preview], dispatch: PROD_MD5[SIG.dispatch], hashV1: PROD_MD5[SIG.hashV1] });
    // Không migration forward nào (sau mốc baseline, TRƯỚC file này) định nghĩa lại ba hàm đó
    // ⇒ trên bản dựng lại, tiền kiểm của file này gặp đúng thân production.
    const cutoff = JSON.parse(readFileSync('supabase/migration-policy.json', 'utf8')).provisionalCutoff.version as string;
    const patchFile = PATCH.split('/').at(-1) ?? PATCH;
    const forwardBefore = (schema: string, fn: string) =>
      [...new Set(definitionsOf(schema, fn).map((d) => d.file)
        .filter((f) => f.slice(0, 14) > cutoff && f < patchFile))];
    expect({
      preview: forwardBefore('public', '_profit_close_preview_core_v2'),
      dispatch: forwardBefore('app_private', 'profit_monthly_source_is_current_v1'),
      hashV1: forwardBefore('app_private', 'current_profit_building_source_hash_v1'),
    }).toEqual({ preview: [], dispatch: [], hashV1: [] });
  });

  it('tiền kiểm ghim đúng md5 production + md5 thân của chính file (chạy lại)', () => {
    for (const signature of [SIG.preview, SIG.dispatch, SIG.hashV1]) {
      expect(PATCH_SQL).toContain(`'${PROD_MD5[signature]}'`);
    }
    // md5 thân của CHÍNH file (đo prosrc trong file — cùng phép đo với tiền kiểm; phép đo JS này
    // trùng md5 PostgreSQL, xem ca baseline ở trên).
    for (const signature of [SIG.preview, SIG.dispatch, SIG.hashV2, SIG.project, SIG.algorithm]) {
      const own = prosrcMd5(sliceFunction(PATCH, `CREATE OR REPLACE FUNCTION ${signature.split('(')[0]}(`));
      expect(PATCH_SQL, signature).toContain(`'${own}'`);
    }
  });

  it('áp hai lượt; v1 KHÔNG bị thay; ACL hàm mới chỉ chủ hàm', async () => {
    expect(await md5Of(sau, SIG.hashV1)).toBe(PROD_MD5[SIG.hashV1]);
    expect(await md5Of(sau, SIG.preview)).not.toBe(PROD_MD5[SIG.preview]);
    expect(await md5Of(sau, SIG.dispatch)).not.toBe(PROD_MD5[SIG.dispatch]);
    const { rows } = await sau.query<{ sig: string; anon: boolean; auth: boolean; svc: boolean; definer: boolean }>(
      `SELECT p.oid::regprocedure::text AS sig, p.prosecdef AS definer,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app_private' AND p.proname IN ('profit_building_source_hash_v2_2',
          'profit_building_source_hash_algorithm_v1', 'current_profit_building_source_hash_v2',
          'profit_monthly_source_is_current_v1') ORDER BY 1`);
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row, row.sig).toMatchObject({ anon: false, auth: false, svc: false });
    expect(rows.find((r) => r.sig.includes('profit_building_source_hash_v2_2'))?.definer).toBe(false);
  });

  // Ba ca DỪNG dùng chung `lane` (chưa áp migration), mỗi ca bọc BEGIN … ROLLBACK: tiền kiểm
  // RAISE trước khi đổi gì nên giao dịch hỏng, ROLLBACK trả `lane` về trạng thái cũ.
  async function expectStop(prepare: () => Promise<void>, message: RegExp) {
    await lane.exec('BEGIN');
    try {
      await prepare();
      await expect(lane.exec(PATCH_SQL)).rejects.toThrow(message);
    } finally {
      await lane.exec('ROLLBACK');
    }
    expect(await md5Of(lane, SIG.preview)).toBe(PROD_MD5[SIG.preview]);
    expect(await md5Of(lane, SIG.dispatch)).toBe(PROD_MD5[SIG.dispatch]);
    expect(await md5Of(lane, SIG.hashV2)).toBeNull();
  }

  it('thân preview lạ ⇒ DỪNG 55000, không thay gì', async () => {
    await expectStop(async () => {
      await lane.exec(OLD_PREVIEW.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')
        .replace("'Canonical fa_monthly_pnl_accrual and fa_accrual_allocations totals disagree'",
          "'Canonical totals disagree'"));
    }, /_profit_close_preview_core_v2 KHÁC bản đã đối chiếu/);
  });

  it('thân v1 lạ ⇒ DỪNG (v2 sao từ v1 đang chạy)', async () => {
    await expectStop(async () => {
      await lane.exec(liveFunctionSql('app_private', 'current_profit_building_source_hash_v1')
        .replace("'profit-close-v2.1'", "'profit-close-v2.1' ")); // đổi một khoảng trắng trong thân
    }, /current_profit_building_source_hash_v1 KHÁC bản đã đối chiếu/);
  });

  it('lần áp đầu mà đã có revision mang dấu v2.2 ⇒ DỪNG (dòng cũ sẽ đổi cách so)', async () => {
    await expectStop(async () => {
      await close(lane, 'CLOSE', JUL, 'jul-lane');
      await lane.exec(`UPDATE public.profit_close_revisions
        SET source_snapshot = source_snapshot || '{"algorithm_version":"profit-close-v2.2"}'::jsonb`);
    }, /Đã có revision mang dấu profit-close-v2.2/);
  });

  it('chạy lại khi hàm mới đã bị sửa ⇒ DỪNG, không đè', async () => {
    await expect(lane.exec(PATCH_SQL)).resolves.toBeDefined(); // lượt 1 (COMMIT)
    await lane.exec('BEGIN');
    try {
      await lane.exec(liveFunctionSql('app_private', 'profit_building_source_hash_v2_2')
        .replace("'profit-close-v2.2'", "'profit-close-v2.2x'"));
      await expect(lane.exec(PATCH_SQL)).rejects.toThrow(/profit_building_source_hash_v2_2\(jsonb,uuid\) đã có với thân KHÁC/);
    } finally {
      await lane.exec('ROLLBACK');
    }
    await expect(lane.exec(PATCH_SQL)).resolves.toBeDefined(); // thân đúng ⇒ lượt 2 đạt
  });

  it('migration không đụng dòng đã chốt; CAS toàn tháng và mọi SỐ TIỀN preview giữ nguyên', async () => {
    const { rows } = await sau.query(
      `SELECT to_jsonb(pm) AS r FROM public.profit_monthly pm WHERE pm.period_month = $1::date ORDER BY pm.building_id`,
      [JUL]);
    expect(rows).toEqual(julRowsBeforeMigration);
    // source_hash toàn tháng (CAS expected_source_hash) + từng số tiền/ phân bổ: trước = sau.
    const previewSau = await preview(sau, AUG);
    expect(previewSau.source_hash).toBe(previewTruoc.source_hash);
    expect(moneyOnly(previewSau)).toEqual(moneyOnly(previewTruoc));
    expect(previewTruoc.algorithm_version).toBe('profit-close-v2.1');
    expect(previewSau.algorithm_version).toBe('profit-close-v2.2');
    expect((previewSau.source_snapshot as Json).algorithm_version).toBe('profit-close-v2.1');
  });
});

describe('lần chốt MỚI ghi dấu v2.2', () => {
  it('ghi phiên bản vào revision + run; mọi toà hiện hành ngay sau chốt', async () => {
    expect(await algorithm(sau, AUG)).toEqual(['profit-close-v2.2']);
    expect(await algorithm(sau, JUL)).toEqual(['profit-close-v2.1']);
    const { rows } = await sau.query<{ rev: string; run: string; src: string }>(
      `SELECT DISTINCT revision.source_snapshot->>'algorithm_version' AS rev,
              run.result_snapshot->>'algorithm_version' AS run, run.source_snapshot->>'algorithm_version' AS src
         FROM public.profit_close_revisions revision JOIN public.profit_close_runs run ON run.id = revision.run_id
        WHERE revision.period_month = $1::date`, [AUG]);
    expect(rows).toEqual([{ rev: 'profit-close-v2.2', run: 'profit-close-v2.2', src: 'profit-close-v2.1' }]);
    expect(await isCurrent(sau, AUG)).toEqual(all(true));
    const flags = await previewFlags(sau, AUG);
    for (const b of BUILDINGS) expect(flags[b], b).toEqual({ mismatch: false, stale: false, reason: null });
    // Dòng v2.2: source_hash = dấu dựng lại v2 (không phải v1).
    const { rows: hashes } = await sau.query<{ v2: boolean; v1: boolean }>(
      `SELECT bool_and(pm.source_hash = app_private.current_profit_building_source_hash_v2(pm.id)) AS v2,
              bool_or(app_private.current_profit_building_source_hash_v1(pm.id) IS NOT NULL) AS v1
         FROM public.profit_monthly pm WHERE pm.period_month = $1::date`, [AUG]);
    expect(hashes[0]).toEqual({ v2: true, v1: true });
  });

  it('(a) đổi tên toà / hạng mục / nhóm / cổ đông / quản lý / nhãn ⇒ VẪN khớp', async () => {
    await scenario([sau], async () => {
      await renameEverything(sau);
      expect(await isCurrent(sau, AUG)).toEqual(all(true));
      const flags = await previewFlags(sau, AUG);
      for (const b of BUILDINGS) expect(flags[b].stale, b).toBe(false);
    });
  });

  it('(b) đổi số tiền phiếu của chính toà ⇒ toà đó LỆCH', async () => {
    await scenario([sau], async () => {
      await changeAmount(sau, D, AUG, 'EXPENSE', 1);
      expect(await isCurrent(sau, AUG)).toEqual({ ...all(true), [D]: false });
      const flags = await previewFlags(sau, AUG);
      expect(flags[D]).toEqual({ mismatch: true, stale: true, reason: 'SOURCE_HASH_MISMATCH' });
      expect(flags[A].stale).toBe(false);
    });
  });

  it('(b) chuyển tiền giữa hai phiếu của cùng toà (tổng toà không đổi) ⇒ LỆCH', async () => {
    await scenario([sau], async () => {
      const { rows } = await sau.query<{ id: string }>(
        `SELECT id FROM public.income_expenses WHERE building_id = $1 AND voucher_date = $2::date AND type = 'INCOME'
          ORDER BY total_amount`, [A, AUG]);
      expect(rows).toHaveLength(2);
      for (const [voucher, delta] of [[rows[0].id, 100_000], [rows[1].id, -100_000]] as const) {
        await sau.query(`UPDATE public.income_expense_items SET amount = amount + $2, unit_price = unit_price + $2
          WHERE income_expense_id = $1`, [voucher, delta]);
        await sau.query(`UPDATE public.income_expenses SET total_amount = total_amount + $2 WHERE id = $1`,
          [voucher, delta]);
      }
      expect(await isCurrent(sau, AUG)).toEqual({ ...all(true), [A]: false });
    });
  });

  it('(b) đổi hạng mục (type_id) của dòng phiếu ⇒ LỆCH toà đó', async () => {
    await scenario([sau], async () => {
      await sau.query(
        `UPDATE public.income_expense_items item SET income_expense_type_id = $3
           FROM public.income_expenses voucher
          WHERE voucher.id = item.income_expense_id AND voucher.building_id = $1 AND voucher.voucher_date = $2::date
            AND voucher.type = 'EXPENSE'`, [B, AUG, T_THU]);
      expect(await isCurrent(sau, AUG)).toEqual({ ...all(true), [B]: false });
    });
  });

  it('(c) đổi số toà KHÔNG chung quy tắc lương nhóm ⇒ toà kia VẪN khớp', async () => {
    await scenario([sau], async () => {
      // B chỉ chung quy tắc TỪNG TOÀ với A; D không chung gì.
      await changeAmount(sau, B, AUG, 'INCOME', 500_000);
      await changeAmount(sau, D, AUG, 'INCOME', -250_000);
      expect(await isCurrent(sau, AUG)).toEqual({ [A]: true, [B]: false, [C]: true, [D]: false });
      const flags = await previewFlags(sau, AUG);
      expect(flags[A].stale).toBe(false);
      expect(flags[C].stale).toBe(false);
    });
  });

  it('(d) toà khác CHUNG quy tắc lương tổng nhóm đổi số ⇒ LỆCH cả nhóm', async () => {
    await scenario([sau], async () => {
      await changeAmount(sau, C, AUG, 'EXPENSE', 100_000);
      expect(await isCurrent(sau, AUG)).toEqual({ [A]: false, [B]: true, [C]: false, [D]: true });
      const flags = await previewFlags(sau, AUG);
      expect(flags[A].stale).toBe(true);
      expect(flags[B].stale).toBe(false);
    });
  });

  it('(e) đổi % cổ đông ⇒ LỆCH đúng toà đó', async () => {
    await scenario([sau], async () => {
      await sau.query(`UPDATE public.building_shareholders SET percent = 55 WHERE building_id = $1 AND shareholder_id = $2`,
        [A, S1]);
      expect(await isCurrent(sau, AUG)).toEqual({ ...all(true), [A]: false });
    });
  });

  it('đổi quy tắc lương (số tiền) ⇒ LỆCH các toà của quy tắc; tắt cổ đông ⇒ LỆCH', async () => {
    await scenario([sau], async () => {
      await sau.query(`UPDATE public.profit_manager_salaries SET amount = 1200000 WHERE id = $1`, [R_NHOM]);
      expect(await isCurrent(sau, AUG)).toEqual({ [A]: false, [B]: true, [C]: false, [D]: true });
    });
    await scenario([sau], async () => {
      await sau.query(`UPDATE public.profit_manager_salaries SET percent = 6 WHERE id = $1`, [R_TUNG_TOA]);
      expect(await isCurrent(sau, AUG)).toEqual({ [A]: false, [B]: false, [C]: true, [D]: true });
    });
    await scenario([sau], async () => {
      await sau.query(`UPDATE public.shareholders SET is_active = false WHERE id = $1`, [S2]);
      expect(await isCurrent(sau, AUG)).toEqual({ [A]: false, [B]: true, [C]: false, [D]: true });
    });
  });

  it('mở chốt (UNLOCK) dòng v2.2: không còn hiện hành, preview giữ lý do "UNLOCKED: …" (so bằng dấu v2.2)', async () => {
    await scenario([sau], async () => {
      await unlock(sau, AUG, D, 'aug-d');
      expect(await algorithm(sau, AUG)).toEqual(['profit-close-v2.2']);
      expect(await isCurrent(sau, AUG)).toEqual({ ...all(true), [D]: false });
      const flags = await previewFlags(sau, AUG);
      expect(flags[D]).toEqual({ mismatch: false, stale: true, reason: 'UNLOCKED: Mo chot thu nghiem aug-d' });
      // Mở chốt rồi đổi số ⇒ cờ preview mới báo lệch nguồn.
      await changeAmount(sau, D, AUG, 'INCOME', 1);
      expect((await previewFlags(sau, AUG))[D]).toEqual({ mismatch: true, stale: true, reason: 'SOURCE_HASH_MISMATCH' });
    });
  });

  // P2-a: kiểm cấu trúc chỉ trên toà + toà chung quy tắc nhóm ⇒ cửa chi và preview cùng kết luận.
  async function softDelete(building: string) {
    await sau.query(`UPDATE public.buildings SET deleted_at = now() WHERE id = $1`, [building]);
  }
  const others = (gone: string) => BUILDINGS.filter((b) => b !== gone);

  it('xoá mềm toà D (không chung gì) ⇒ A/B/C: cửa chi và preview cùng "khớp"', async () => {
    await scenario([sau], async () => {
      await softDelete(D);
      expect(await isCurrent(sau, AUG)).toEqual({ [A]: true, [B]: true, [C]: true, [D]: false });
      const flags = await previewFlags(sau, AUG, others(D));
      for (const b of others(D)) expect(flags[b], b).toEqual({ mismatch: false, stale: false, reason: null });
    });
  });

  it('xoá mềm toà B (chỉ chung quy tắc PER_BUILDING với A) ⇒ A/C/D: cửa chi và preview cùng "khớp"', async () => {
    await scenario([sau], async () => {
      await softDelete(B);
      expect(await isCurrent(sau, AUG)).toEqual({ [A]: true, [B]: false, [C]: true, [D]: true });
      const flags = await previewFlags(sau, AUG, others(B));
      for (const b of others(B)) expect(flags[b], b).toEqual({ mismatch: false, stale: false, reason: null });
    });
  });

  it('xoá mềm toà C (chung TOTAL_GROUP với A) ⇒ A, C lệch ở cửa chi; preview cũng báo A lệch', async () => {
    await scenario([sau], async () => {
      await softDelete(C);
      expect(await isCurrent(sau, AUG)).toEqual({ [A]: false, [B]: true, [C]: false, [D]: true });
      const flags = await previewFlags(sau, AUG, others(C));
      expect(flags[A]).toEqual({ mismatch: true, stale: true, reason: 'SOURCE_HASH_MISMATCH' });
      expect(flags[B].stale).toBe(false);
      expect(flags[D].stale).toBe(false);
    });
  });

  it('cổ đông vượt 100%: ở toà không liên quan ⇒ chỉ toà đó; ở toà chung nhóm ⇒ kéo cả nhóm', async () => {
    await scenario([sau], async () => {
      await sau.query(`INSERT INTO public.building_shareholders(organization_id, building_id, shareholder_id, percent)
        VALUES ($1, $2, $3, 60)`, [ORG, D, S2]); // D: 50 + 60 > 100
      expect(await isCurrent(sau, AUG)).toEqual({ [A]: true, [B]: true, [C]: true, [D]: false });
    });
    await scenario([sau], async () => {
      await sau.query(`INSERT INTO public.building_shareholders(organization_id, building_id, shareholder_id, percent)
        VALUES ($1, $2, $3, 10)`, [ORG, C, S1]); // C: 100 + 10 > 100
      expect(await isCurrent(sau, AUG)).toEqual({ [A]: false, [B]: true, [C]: false, [D]: true });
    });
  });

  // P2-b: danh sách toà của quy tắc PER_BUILDING không nằm trong dấu.
  it('thêm toà D vào quy tắc PER_BUILDING (A, B) ⇒ A, B vẫn khớp (cửa chi + preview); D lệch', async () => {
    await scenario([sau], async () => {
      await sau.query(`INSERT INTO public.profit_manager_salary_buildings(salary_id, building_id, organization_id)
        VALUES ($1, $2, $3)`, [R_TUNG_TOA, D, ORG]);
      expect(await isCurrent(sau, AUG)).toEqual({ [A]: true, [B]: true, [C]: true, [D]: false });
      const flags = await previewFlags(sau, AUG);
      expect([flags[A].stale, flags[B].stale, flags[C].stale, flags[D].stale]).toEqual([false, false, false, true]);
    });
  });

  it('thêm toà D vào quy tắc TOTAL_GROUP (A, C) ⇒ A, C, D lệch; B khớp', async () => {
    await scenario([sau], async () => {
      await sau.query(`INSERT INTO public.profit_manager_salary_buildings(salary_id, building_id, organization_id)
        VALUES ($1, $2, $3)`, [R_NHOM, D, ORG]);
      expect(await isCurrent(sau, AUG)).toEqual({ [A]: false, [B]: true, [C]: false, [D]: false });
      const flags = await previewFlags(sau, AUG);
      expect([flags[A].stale, flags[B].stale, flags[C].stale, flags[D].stale]).toEqual([true, false, true, true]);
    });
  });

  it('đặt lại (RESET) rồi CLOSE một toà: dòng mới mang v2.2, hiện hành; toà khác giữ nguyên', async () => {
    await scenario([sau], async () => {
      const before = await sau.query<{ id: string }>(
        `SELECT id FROM public.profit_monthly WHERE building_id = $1 AND period_month = $2::date`, [D, AUG]);
      await stateChange(sau, 'RESET', AUG, D, 'aug-reset-d');
      expect(Object.keys(await isCurrent(sau, AUG))).toHaveLength(3);
      await close(sau, 'CLOSE', AUG, 'aug-close-d', [D]);
      const after = await sau.query<{ id: string }>(
        `SELECT id FROM public.profit_monthly WHERE building_id = $1 AND period_month = $2::date`, [D, AUG]);
      expect(after.rows[0].id).not.toBe(before.rows[0].id);
      expect(await algorithm(sau, AUG)).toEqual(['profit-close-v2.2']);
      expect(await isCurrent(sau, AUG)).toEqual(all(true));
      await renameEverything(sau);
      expect(await isCurrent(sau, AUG)).toEqual(all(true));
    });
    // Tháng chốt bằng thuật toán CŨ: RESET + CLOSE toà D ⇒ D sang v2.2, A/B/C vẫn v2.1 và vẫn so như cũ.
    await scenario([sau], async () => {
      await stateChange(sau, 'RESET', JUL, D, 'jul-reset-d');
      await close(sau, 'CLOSE', JUL, 'jul-close-d', [D]);
      const { rows } = await sau.query<{ b: string; a: string }>(
        `SELECT pm.building_id::text AS b, app_private.profit_building_source_hash_algorithm_v1(pm.id) AS a
           FROM public.profit_monthly pm WHERE pm.period_month = $1::date ORDER BY 1`, [JUL]);
      expect(Object.fromEntries(rows.map((r) => [r.b, r.a]))).toEqual({
        [A]: 'profit-close-v2.1', [B]: 'profit-close-v2.1', [C]: 'profit-close-v2.1', [D]: 'profit-close-v2.2',
      });
      expect(await isCurrent(sau, JUL)).toEqual(all(true));
      await sau.query(`UPDATE public.buildings SET name = 'Toa D moi' WHERE id = $1`, [D]);
      // Dấu v2.1 của A/B/C có tên MỌI toà ⇒ lệch như trước; D (v2.2) vẫn khớp.
      expect(await isCurrent(sau, JUL)).toEqual({ [A]: false, [B]: false, [C]: false, [D]: true });
    });
  });

  it('chốt lại (RECLOSE) dòng cũ ⇒ ghi dấu v2.2, hiện hành, đổi tên vẫn khớp', async () => {
    await scenario([sau], async () => {
      expect(await isCurrent(sau, JUL)).toEqual(all(true));
      await renameEverything(sau);
      expect(await isCurrent(sau, JUL)).toEqual(all(false)); // dòng v2.1: tên vẫn nằm trong dấu cũ
      await close(sau, 'RECLOSE', JUL, 'jul-reclose');
      expect(await algorithm(sau, JUL)).toEqual(['profit-close-v2.2']);
      expect(await isCurrent(sau, JUL)).toEqual(all(true));
      await sau.exec(`UPDATE public.buildings SET name = name || ' lan hai'`);
      expect(await isCurrent(sau, JUL)).toEqual(all(true));
    });
  });
});

describe('(f) dòng chốt bằng thuật toán CŨ ⇒ kết quả y như trước migration', () => {
  const mutations: [string, (db: PGlite) => Promise<void>][] = [
    ['không đổi gì', async () => {}],
    ['đổi tên mọi thứ', renameEverything],
    ['đổi tên một toà', async (db) => { await db.query(`UPDATE public.buildings SET name = 'Toa B moi' WHERE id = $1`, [B]); }],
    ['đổi số toà D', (db) => changeAmount(db, D, JUL, 'INCOME', 1000)],
    ['đổi số toà C (nhóm với A)', (db) => changeAmount(db, C, JUL, 'EXPENSE', 1000)],
    ['đổi % cổ đông A', async (db) => {
      await db.query(`UPDATE public.building_shareholders SET percent = 55 WHERE building_id = $1 AND shareholder_id = $2`,
        [A, S1]);
    }],
    ['đổi số tháng 8 (không liên quan tháng 7)', (db) => changeAmount(db, A, AUG, 'INCOME', 1000)],
    ['mở chốt toà D', (db) => unlock(db, JUL, D, 'jul-d')],
    ['mở chốt toà D rồi đổi số D', async (db) => {
      await unlock(db, JUL, D, 'jul-d2');
      await changeAmount(db, D, JUL, 'EXPENSE', 1000);
    }],
  ];

  for (const [label, mutate] of mutations) {
    it(`${label}: kiểm độ tươi + cờ preview của tháng 7 trùng thân cũ`, async () => {
      await scenario([truoc, sau], async () => {
        await mutate(truoc);
        await mutate(sau);
        const [oldCurrent, newCurrent] = [await isCurrent(truoc, JUL), await isCurrent(sau, JUL)];
        expect(Object.keys(newCurrent)).toHaveLength(4);
        expect(newCurrent).toEqual(oldCurrent);
        expect(await previewFlags(sau, JUL)).toEqual(await previewFlags(truoc, JUL));
      });
    });
  }

  it('đối chứng thân cũ: dòng v2.1 vẫn so bằng current_profit_building_source_hash_v1', async () => {
    await scenario([sau], async () => {
      await renameEverything(sau);
      const { rows } = await sau.query<{ same: boolean }>(
        `SELECT bool_and(app_private.profit_monthly_source_is_current_v1(pm.id)
                 = COALESCE(pm.status = 'LOCKED' AND NOT pm.is_stale
                   AND pm.source_hash = app_private.current_profit_building_source_hash_v1(pm.id), false)) AS same
           FROM public.profit_monthly pm WHERE pm.period_month = $1::date`, [JUL]);
      expect(rows[0].same).toBe(true);
    });
  });
});
