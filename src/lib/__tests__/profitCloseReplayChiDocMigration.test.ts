// Migration 20261116082842: lượt gửi lại cùng khoá idempotency (replay) của chốt / chốt lại lợi nhuận là
// thao tác CHỈ ĐỌC.
//
// Chạy logic THẬT trên PGlite, hai cơ sở dữ liệu cùng dữ liệu giả:
//   - `cu`:  lớp bọc public._profit_write_close_v2 đúng thân production trước migration (md5 78d8a5b4…);
//   - `moi`: cùng trạng thái đó rồi áp migration HAI lượt.
// Phần lõi, preview, mở khoá / đặt lại, lương điều hành… là định nghĩa SỐNG trong thư mục migration; chỉ
// phần quyền là stub cho qua. Mỗi ca chạy trên CẢ HAI: thân cũ phải hỏng đúng kiểu đã mô tả (ném 55000 /
// ghi đè 5 cột / thêm dòng quyết định), thân mới không ghi gì — test tự chứng minh nó bắt được lỗi.
// Mọi tên, số tiền, id ở đây là giả.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readProfitActionResult } from '../profitFeedback';

const FILE = 'supabase/migrations/20261116082842_profit_close_replay_chi_doc.sql';
const NGUON_CU = 'supabase/migrations/20260721110000_profit_unallocated_integrity_v3.sql';
const BASELINE = 'supabase/baseline/schema.sql';
const SQL = readFileSync(FILE, 'utf8').replace(/\r/g, '');
const HAM = 'public._profit_write_close_v2(text,uuid,date,text,text,text,uuid[],jsonb)';
/** md5(prosrc) của lớp bọc trên production (đọc 22/10/2026, cũng ghim ở dauVanTayChotLnMigration.test.ts). */
const MD5_CU = '78d8a5b474320e663622da7df461e0a8';
/** proacl đã ghim: như phần lõi _profit_write_close_v2_base (cùng chuỗi REVOKE ở 20260721110000). */
const ACL = '{postgres=X/postgres,service_role=X/postgres}';
/** Nhánh DUY NHẤT được thêm vào thân. */
const NHANH_TRA_SOM = `
  -- Replay idempotent: phan loi tra lai ket qua cua luot da ghi (cung khoa, cung noi dung) va
  -- khong ghi gi. Tra ngay: khong ghi lai profit_monthly / profit_unallocated_decisions bang so
  -- cua luot cu (ban chot hien tai co the da mo khoa / dat lai / chot lai sau luot do).
  IF (v_result->'idempotent_replay') = 'true'::jsonb THEN
    RETURN public._profit_enrich_unallocated_v3(v_result, p_adjustments);
  END IF;

`;

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

// ---------------------------------------------------------------- nạp định nghĩa
function cutCreate(rest: string, label: string): string {
  const open = /\bAS\s+(\$[A-Za-z0-9_]*\$)/.exec(rest);
  if (!open) throw new Error(`${label}: không thấy thân hàm`);
  const close = rest.indexOf(open[1], open.index + open[0].length);
  return `${rest.slice(0, close + open[1].length)};`;
}

/** Cắt đúng một CREATE từ một file. */
function sliceFunction(path: string, header: string): string {
  const sql = readFileSync(path, 'utf8').replace(/\r/g, '');
  const start = sql.indexOf(header);
  if (start < 0) throw new Error(`Không thấy ${header} trong ${path}`);
  return cutCreate(sql.slice(start), header);
}

/** prosrc = phần giữa hai dấu dollar. */
function prosrc(createSql: string): string {
  const open = /\bAS\s+(\$[A-Za-z0-9_]*\$)/.exec(createSql);
  if (!open) throw new Error('không thấy thân hàm');
  const from = open.index + open[0].length;
  return createSql.slice(from, createSql.indexOf(open[1], from));
}

let corpus: { file: string; sql: string }[] | null = null;
/** File migration có CREATE (không nằm trong dòng chú thích) của một hàm, theo thứ tự tên file. */
function definitionsOf(schema: string, fnName: string): { file: string; sql: string; start: number }[] {
  corpus ??= readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort()
    .map((file) => ({ file, sql: readFileSync(join('supabase/migrations', file), 'utf8').replace(/\r/g, '') }));
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${schema}\\.${fnName}\\s*\\(`, 'gi');
  const hits: { file: string; sql: string; start: number }[] = [];
  for (const { file, sql } of corpus) {
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

const WRAPPER_CU = sliceFunction(NGUON_CU, 'CREATE OR REPLACE FUNCTION public._profit_write_close_v2(');
const WRAPPER_MOI = sliceFunction(FILE, 'CREATE OR REPLACE FUNCTION public._profit_write_close_v2(');
const THAN_CU = prosrc(WRAPPER_CU);
const THAN_MOI = prosrc(WRAPPER_MOI);

function khoi(tag: string): string {
  const m = new RegExp(`DO \\$${tag}\\$[\\s\\S]*?\\$${tag}\\$;`).exec(SQL);
  if (!m) throw new Error(`Không thấy khối ${tag}`);
  return m[0];
}

// ---------------------------------------------------------------- dữ liệu giả
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = id(1);
const OWNER = id(2);
const ACTOR = id(3);
/** A: cổ đông đủ 100% (không có phần chưa phân bổ). D: cổ đông 50% (có phần chưa phân bổ). */
const [A, D] = [11, 14].map(id);
const BUILDINGS = [A, D];
const [T_THU, T_CHI] = [21, 22].map(id);
const [S1, S2] = [31, 32].map(id);
const AUG = '2026-08-01';
const REASON_D = 'Giu lai cho cong ty (thu nghiem)';

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

/** Định nghĩa SỐNG của mọi hàm đường chốt — TRỪ lớp bọc (nạp riêng: thân cũ, rồi migration). */
const LIVE = [
  ['public', 'fa_accrual_allocations'],
  ['public', 'fa_monthly_pnl_accrual'],
  ['public', '_profit_management_allocations_v2'],
  ['public', '_profit_enrich_unallocated_v3'],
  ['public', '_profit_write_close_v2_base'],
  ['public', '_profit_state_change_v2'],
  ['public', '_profit_close_preview_core_v2'],
  ['app_private', 'current_profit_building_source_hash_v1'],
  ['app_private', 'profit_building_source_hash_v2_2'],
  ['app_private', 'profit_building_source_hash_algorithm_v1'],
  ['app_private', 'current_profit_building_source_hash_v2'],
  ['app_private', 'profit_monthly_source_is_current_v1'],
] as const;

/** Lớp bọc đúng trạng thái production: thân cũ + quyền đã ghim. */
async function napWrapperCu(db: PGlite, cau: string = WRAPPER_CU) {
  await db.exec(cau);
  await db.exec(`REVOKE ALL ON FUNCTION ${HAM} FROM PUBLIC; GRANT EXECUTE ON FUNCTION ${HAM} TO service_role;`);
}

async function buildDb(apMigration: boolean): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec('SET check_function_bodies = off;');
  for (const [schema, fn] of LIVE) await db.exec(liveFunctionSql(schema, fn));
  await napWrapperCu(db);
  await db.exec(`
    INSERT INTO public.buildings(id, organization_id, user_id, name) VALUES
      ('${A}','${ORG}','${OWNER}','Toa A'),('${D}','${ORG}','${OWNER}','Toa D');
    INSERT INTO public.income_expense_types(id, organization_id, name, type, category) VALUES
      ('${T_THU}','${ORG}','Tien phong','income','Phong'),('${T_CHI}','${ORG}','Tien dien','expense','Dien');
    INSERT INTO public.shareholders(id, organization_id, name) VALUES
      ('${S1}','${ORG}','Co dong mot'),('${S2}','${ORG}','Co dong hai');
    INSERT INTO public.building_shareholders(organization_id, building_id, shareholder_id, percent) VALUES
      ('${ORG}','${A}','${S1}',60),('${ORG}','${A}','${S2}',40),('${ORG}','${D}','${S1}',50);
  `);
  const vouchers: [string, 'INCOME' | 'EXPENSE', string, string][] = [
    [A, 'INCOME', T_THU, '10000000.00'], [A, 'EXPENSE', T_CHI, '3000000.00'],
    [D, 'INCOME', T_THU, '4000000.00'], [D, 'EXPENSE', T_CHI, '500000.00'],
  ];
  let n = 100;
  for (const [building, side, type, amount] of vouchers) {
    n += 1;
    await db.query(
      `INSERT INTO public.income_expenses(id, organization_id, building_id, type, voucher_date, total_amount)
       VALUES ($1, $2, $3, $4, $5, $6)`, [id(n), ORG, building, side, AUG, amount]);
    await db.query(
      `INSERT INTO public.income_expense_items(id, income_expense_id, income_expense_type_id, unit_price, amount,
         start_date, end_date, accounting_class) VALUES ($1, $2, $3, $4, $4, $5, '2026-08-31', 'PNL')`,
      [id(n + 5000), id(n), type, amount, AUG]);
  }
  if (apMigration) {
    await db.exec(SQL);
    await db.exec(SQL);
  }
  await db.query(`SELECT set_config('test.uid', $1, false)`, [ACTOR]);
  return db;
}

// ---------------------------------------------------------------- thao tác
type Json = Record<string, unknown>;
type LoiGoi = { code?: string; message?: string };

async function sourceHash(db: PGlite): Promise<string> {
  const { rows } = await db.query<{ h: string }>(
    `SELECT public._profit_close_preview_core_v2($1, $2::date, $3::uuid[],
       jsonb_build_array(jsonb_build_object('building_id', $4::uuid, 'adjustment_amount', 0)),
       'shareholder_profit.view', false)->>'source_hash' AS h`,
    [ORG, AUG, `{${BUILDINGS.join(',')}}`, D]);
  return rows[0].h;
}

/** Đối số của MỘT lời gọi chốt — giữ lại để gửi lại y nguyên (replay). */
type LoiGoiChot = unknown[];
async function doiSoChot(db: PGlite, operation: 'CLOSE' | 'RECLOSE', key: string, buildings: string[] | null): Promise<LoiGoiChot> {
  return [operation, ORG, AUG, await sourceHash(db), `Chot thu nghiem ${key}`, `khoa-chot-${key}`, D, REASON_D,
    buildings ? `{${buildings.join(',')}}` : null];
}
async function goi(db: PGlite, args: LoiGoiChot): Promise<Json> {
  const { rows } = await db.query<{ r: Json }>(
    `SELECT public._profit_write_close_v2($1, $2, $3::date, $4, $5, $6, $9::uuid[],
       jsonb_build_array(jsonb_build_object('building_id', $7::uuid, 'adjustment_amount', 0,
         'unallocated_disposition', 'RETAINED_EARNINGS', 'unallocated_disposition_reason', $8::text))) AS r`, args);
  return rows[0].r;
}
async function chot(db: PGlite, operation: 'CLOSE' | 'RECLOSE', key: string, buildings: string[] | null = null) {
  const args = await doiSoChot(db, operation, key, buildings);
  return { args, ketQua: await goi(db, args) };
}
const loiCua = (p: Promise<unknown>) =>
  p.then(() => null, (e: LoiGoi) => ({ code: e.code, message: e.message }));

/** Đặt lại (xoá bản chốt của nhà) bằng _profit_state_change_v2 thật. */
async function datLai(db: PGlite, building: string, key: string) {
  await db.query(
    `SELECT public._profit_state_change_v2('RESET', $1, $2::date, $3, $4, ARRAY[$5::uuid], NULL)`,
    [ORG, AUG, `Dat lai thu nghiem ${key}`, `khoa-dat-lai-${key}`, building]);
}
const doiTyLeCoDong = (db: PGlite, building: string, percent: number) =>
  db.query(`UPDATE public.building_shareholders SET percent = $2 WHERE building_id = $1`, [building, percent]);

type NamCot = {
  id: string; shareholder_percent_total: string; shareholder_allocated_amount: string; unallocated_profit: string;
  unallocated_disposition: string | null; unallocated_disposition_reason: string | null; tong_phan_bo: string;
};
/** 5 cột lớp bọc ghi + tổng profit_allocations của chính bản chốt đó. */
async function namCot(db: PGlite, building: string): Promise<NamCot | undefined> {
  const { rows } = await db.query<NamCot>(
    `SELECT pm.id::text, pm.shareholder_percent_total::text, pm.shareholder_allocated_amount::text,
            pm.unallocated_profit::text, pm.unallocated_disposition, pm.unallocated_disposition_reason,
            (SELECT COALESCE(sum(pa.amount), 0)::numeric(15,2)::text
               FROM public.profit_allocations pa WHERE pa.profit_monthly_id = pm.id) AS tong_phan_bo
       FROM public.profit_monthly pm WHERE pm.building_id = $1 AND pm.period_month = $2::date`, [building, AUG]);
  return rows[0];
}
async function soQuyetDinh(db: PGlite): Promise<number> {
  return (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.profit_unallocated_decisions`)).rows[0].n;
}
/** Toàn bộ dữ liệu chốt — replay chỉ-đọc thì ảnh này không đổi một byte. */
async function anhDuLieu(db: PGlite): Promise<unknown> {
  const bang = ['profit_monthly', 'profit_allocations', 'profit_manager_allocations', 'profit_close_runs',
    'profit_close_revisions', 'profit_unallocated_decisions'];
  const out: Record<string, unknown> = {};
  for (const t of bang) {
    out[t] = (await db.query(`SELECT to_jsonb(x) AS r FROM public.${t} x ORDER BY x.id`)).rows;
  }
  return out;
}

/** Mỗi ca chạy trong giao dịch riêng rồi ROLLBACK. */
async function ca<T>(db: PGlite, fn: () => Promise<T>): Promise<T> {
  await db.exec('BEGIN');
  try {
    return await fn();
  } finally {
    await db.exec('ROLLBACK');
  }
}

async function trangThaiHam(db: PGlite) {
  const { rows } = await db.query<{ md5: string; acl: string; bao_mat: boolean; cau_hinh: string }>(
    `SELECT md5(p.prosrc) AS md5, p.proacl::text AS acl, p.prosecdef AS bao_mat, p.proconfig::text AS cau_hinh
       FROM pg_proc p WHERE p.oid = to_regprocedure($1)`, [HAM]);
  return rows[0];
}

// ---------------------------------------------------------------- file migration (tĩnh)
describe('20261116082842 — file chỉ thêm đúng một nhánh trả sớm vào thân production', () => {
  it('thân cũ đã ghim = thân trong 20260721110000 = thân baseline (đường Restore Drill); chưa file forward nào thay', () => {
    expect(md5(THAN_CU)).toBe(MD5_CU);
    expect(md5(prosrc(sliceFunction(BASELINE, 'CREATE FUNCTION public._profit_write_close_v2(')))).toBe(MD5_CU);
    expect([...new Set(definitionsOf('public', '_profit_write_close_v2').map((d) => d.file))]).toEqual([
      '20260720210000_profit_close_v2.sql', // bản gốc, đã đổi tên thành _base ở file kế
      NGUON_CU.split('/').at(-1),
      FILE.split('/').at(-1),
    ]);
  });

  it('thân mới = thân cũ + đúng MỘT nhánh, đặt ngay sau lời gọi phần lõi và trước mọi lệnh ghi / ném lỗi', () => {
    expect(THAN_MOI.split(NHANH_TRA_SOM).length).toBe(2);
    expect(THAN_MOI.replace(NHANH_TRA_SOM, '')).toBe(THAN_CU);
    const truoc = THAN_MOI.slice(0, THAN_MOI.indexOf(NHANH_TRA_SOM));
    expect(truoc.trimEnd().endsWith('p_reason, p_idempotency_key, p_building_ids, p_adjustments\n  );')).toBe(true);
    expect(truoc).toContain('v_result := public._profit_write_close_v2_base(');
    expect(truoc).not.toMatch(/\b(UPDATE|INSERT|DELETE|RAISE)\b/);
  });

  it('hai khối kiểm ghim đúng md5 cũ / md5 mới của chính file, SECURITY DEFINER, search_path, quyền', () => {
    const dong = `('${HAM}', '${MD5_CU}', '${md5(THAN_MOI)}', true, '{"search_path=pg_catalog, public"}', 'service_role')`;
    expect(khoi('kiem_truoc')).toContain(dong);
    expect(khoi('kiem_sau')).toContain(dong.replace(`'${MD5_CU}', `, ''));
  });

  it('một câu CREATE đúng chữ ký production; cấp lại quyền đúng thứ tự REVOKE PUBLIC + vai API, GRANT service_role', () => {
    expect(SQL.split('CREATE OR REPLACE FUNCTION').length).toBe(2);
    expect(WRAPPER_MOI.startsWith(
      'CREATE OR REPLACE FUNCTION public._profit_write_close_v2(p_operation text, p_organization_id uuid, '
      + 'p_period_month date, p_expected_source_hash text, p_reason text, p_idempotency_key text, '
      + 'p_building_ids uuid[], p_adjustments jsonb)\n RETURNS jsonb\n LANGUAGE plpgsql\n SECURITY DEFINER\n'
      + " SET search_path TO 'pg_catalog', 'public'\nAS $function$")).toBe(true);
    const sau = SQL.slice(SQL.indexOf(WRAPPER_MOI) + WRAPPER_MOI.length).split('\n').slice(1, 4);
    expect(sau).toEqual([
      `REVOKE ALL ON FUNCTION ${HAM} FROM PUBLIC;`,
      `REVOKE ALL ON FUNCTION ${HAM} FROM anon, authenticated, service_role;`,
      `GRANT EXECUTE ON FUNCTION ${HAM} TO service_role;`,
    ]);
  });

  it('phần lõi SỐNG vẫn giữ giao kèo mà nhánh trả sớm dựa vào: replay trả ảnh cũ + idempotent_replay = true, lượt ghi = false', () => {
    const loi = prosrc(liveFunctionSql('public', '_profit_write_close_v2_base'));
    expect(loi).toMatch(/RETURN v_existing_run\.result_snapshot\s*\|\|\s*jsonb_build_object\('idempotent_replay', true\);/);
    expect(loi).toMatch(/'idempotent_replay', false/);
    // Nhánh replay của phần lõi nằm TRƯỚC mọi lệnh ghi bảng ⇒ lượt replay không ghi gì ở phần lõi.
    const truocReplay = loi.slice(0, loi.indexOf("jsonb_build_object('idempotent_replay', true)"));
    expect(truocReplay).not.toMatch(/\b(UPDATE|INSERT INTO|DELETE FROM)\b/);
  });

  it('profit_close_v2 / profit_reclose_v2 SỐNG chỉ chuyển tiếp vào lớp bọc ⇒ sửa lớp bọc phủ cả hai RPC', () => {
    for (const rpc of ['profit_close_v2', 'profit_reclose_v2']) {
      expect(prosrc(liveFunctionSql('public', rpc)).replace(/\s+/g, ' ').trim(), rpc)
        .toMatch(/^SELECT public\._profit_write_close_v2\( '(CLOSE|RECLOSE)', p_organization_id, p_period_month, p_expected_source_hash, p_reason, p_idempotency_key, p_building_ids, p_adjustments \);$/);
    }
  });
});

// ---------------------------------------------------------------- hành vi (thân cũ đối chứng thân mới)
describe('20261116082842 — replay là thao tác chỉ đọc (chạy thật trên PostgreSQL nhúng)', () => {
  let cu: PGlite;
  let moi: PGlite;
  beforeAll(async () => {
    [cu, moi] = [await buildDb(false), await buildDb(true)];
  }, 240_000);
  afterAll(async () => {
    await Promise.all([cu?.close(), moi?.close()]);
  });

  it('`cu` chạy đúng thân production, `moi` đã áp hai lượt: thân mới, proacl / SECURITY / search_path giữ nguyên', async () => {
    const [truoc, sau] = [await trangThaiHam(cu), await trangThaiHam(moi)];
    expect(truoc).toEqual({ md5: MD5_CU, acl: ACL, bao_mat: true, cau_hinh: '{"search_path=pg_catalog, public"}' });
    expect(sau).toEqual({ ...truoc, md5: md5(THAN_MOI) });
  });

  it('lượt ghi thật không đổi: cả hai thân ghi cùng 5 cột + cùng dòng quyết định; replay liền sau trả cùng hình dạng', async () => {
    const ketQua: unknown[] = [];
    for (const db of [cu, moi]) {
      ketQua.push(await ca(db, async () => {
        const { args, ketQua: lanDau } = await chot(db, 'CLOSE', 'k1');
        const sauChot = { a: await namCot(db, A), d: await namCot(db, D), quyetDinh: await soQuyetDinh(db) };
        const anhTruoc = await anhDuLieu(db);
        const lanHai = await goi(db, args);
        expect(await anhDuLieu(db)).toEqual(anhTruoc);
        // Hình dạng kết quả replay = kết quả lượt đầu, chỉ khác cờ idempotent_replay (web đọc qua readProfitActionResult).
        expect(lanDau.idempotent_replay).toBe(false);
        expect(lanHai).toEqual({ ...lanDau, idempotent_replay: true });
        expect(readProfitActionResult(lanHai, 2)).toEqual({ run_id: lanDau.run_id, affected_buildings: 2, idempotent_replay: true });
        const toaD = (lanHai.buildings as Json[]).find((b) => b.building_id === D);
        expect(toaD).toMatchObject({ unallocated_disposition: 'RETAINED_EARNINGS', unallocated_disposition_reason: REASON_D });
        return { ...sauChot, a: { ...sauChot.a, id: null }, d: { ...sauChot.d, id: null } };
      }));
    }
    expect(ketQua[1]).toEqual(ketQua[0]);
    // Lợi nhuận D = 4.000.000 − 500.000; cổ đông 50% ⇒ nửa còn lại chưa phân bổ, có đúng MỘT dòng quyết định.
    expect(ketQua[1]).toEqual({
      a: { id: null, shareholder_percent_total: '100.0000', shareholder_allocated_amount: '7000000.00', unallocated_profit: '0.00',
        unallocated_disposition: null, unallocated_disposition_reason: null, tong_phan_bo: '7000000.00' },
      d: { id: null, shareholder_percent_total: '50.0000', shareholder_allocated_amount: '1750000.00', unallocated_profit: '1750000.00',
        unallocated_disposition: 'RETAINED_EARNINGS', unallocated_disposition_reason: REASON_D, tong_phan_bo: '1750000.00' },
      quyetDinh: 1,
    });
  });

  it('replay sau khi nhà đã ĐẶT LẠI: thân cũ ném 55000 (kẹt); thân mới trả kết quả cũ, không ghi gì', async () => {
    const kichBan = async (db: PGlite) => {
      const { args, ketQua } = await chot(db, 'CLOSE', 'k1');
      await datLai(db, D, 'd1');
      expect(await namCot(db, D)).toBeUndefined();
      return { args, ketQua };
    };

    await ca(cu, async () => {
      const { args } = await kichBan(cu);
      expect(await loiCua(goi(cu, args))).toEqual({ code: '55000', message: `Profit close did not persist building ${D}` });
    });

    await ca(moi, async () => {
      const { args, ketQua } = await kichBan(moi);
      const anhTruoc = await anhDuLieu(moi);
      const replay = await goi(moi, args);
      expect(replay).toEqual({ ...ketQua, idempotent_replay: true });
      expect(await anhDuLieu(moi)).toEqual(anhTruoc);
      expect(await namCot(moi, D)).toBeUndefined();
    });
  });

  it('replay sau một lượt CHỐT LẠI khác: thân cũ ghi đè 5 cột bằng số cũ (lệch profit_allocations); thân mới giữ nguyên', async () => {
    const kichBan = async (db: PGlite) => {
      const { args } = await chot(db, 'CLOSE', 'k1');
      const lanDau = await namCot(db, D);
      await doiTyLeCoDong(db, D, 80);
      await chot(db, 'RECLOSE', 'k2', [D]);
      const hienTai = await namCot(db, D);
      // Bản chốt hiện tại: 80% của 3.500.000, khớp profit_allocations.
      expect(hienTai).toMatchObject({ id: lanDau?.id, shareholder_percent_total: '80.0000',
        shareholder_allocated_amount: '2800000.00', unallocated_profit: '700000.00', tong_phan_bo: '2800000.00' });
      return { args, lanDau, hienTai, quyetDinh: await soQuyetDinh(db), anh: await anhDuLieu(db) };
    };

    await ca(cu, async () => {
      const { args, lanDau, quyetDinh } = await kichBan(cu);
      await goi(cu, args);
      // LỖI CŨ: 5 cột quay về số của lượt k1 trong khi profit_allocations vẫn là của lượt k2.
      expect(await namCot(cu, D)).toEqual({ ...lanDau, tong_phan_bo: '2800000.00' });
      expect((await namCot(cu, D))?.shareholder_allocated_amount).toBe('1750000.00');
      // Cùng dòng profit_monthly ⇒ ON CONFLICT (run_id, profit_monthly_id) chặn dòng quyết định trùng ở ca này.
      expect(await soQuyetDinh(cu)).toBe(quyetDinh);
    });

    await ca(moi, async () => {
      const { args, hienTai, quyetDinh, anh } = await kichBan(moi);
      const replay = await goi(moi, args);
      expect(replay.idempotent_replay).toBe(true);
      expect(await namCot(moi, D)).toEqual(hienTai);
      expect(await soQuyetDinh(moi)).toBe(quyetDinh);
      expect(await anhDuLieu(moi)).toEqual(anh);
    });
  });

  it('replay sau ĐẶT LẠI rồi CHỐT MỚI: thân cũ ghi đè 5 cột VÀ thêm dòng quyết định của run cũ; thân mới không ghi gì', async () => {
    const kichBan = async (db: PGlite) => {
      const { args, ketQua } = await chot(db, 'CLOSE', 'k1');
      const lanDau = await namCot(db, D);
      await datLai(db, D, 'd1');
      await doiTyLeCoDong(db, D, 80);
      await chot(db, 'CLOSE', 'k3', [D]);
      const hienTai = await namCot(db, D);
      expect(hienTai?.id).not.toBe(lanDau?.id);
      expect(hienTai).toMatchObject({ shareholder_allocated_amount: '2800000.00', unallocated_profit: '700000.00' });
      return { args, runCu: ketQua.run_id as string, hienTai, quyetDinh: await soQuyetDinh(db), anh: await anhDuLieu(db) };
    };
    const quyetDinhCuaRunCu = async (db: PGlite, run: string, pm: string | undefined) =>
      (await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.profit_unallocated_decisions WHERE run_id = $1 AND profit_monthly_id = $2`,
        [run, pm])).rows[0].n;

    await ca(cu, async () => {
      const { args, runCu, hienTai, quyetDinh } = await kichBan(cu);
      expect(await quyetDinhCuaRunCu(cu, runCu, hienTai?.id)).toBe(0);
      await goi(cu, args);
      // LỖI CŨ: bản chốt MỚI mang số của lượt k1 và nhận thêm một dòng quyết định gắn run k1.
      expect(await namCot(cu, D)).toMatchObject({ id: hienTai?.id, shareholder_percent_total: '50.0000',
        shareholder_allocated_amount: '1750000.00', unallocated_profit: '1750000.00', tong_phan_bo: '2800000.00' });
      expect(await soQuyetDinh(cu)).toBe(quyetDinh + 1);
      expect(await quyetDinhCuaRunCu(cu, runCu, hienTai?.id)).toBe(1);
    });

    await ca(moi, async () => {
      const { args, runCu, hienTai, quyetDinh, anh } = await kichBan(moi);
      const replay = await goi(moi, args);
      expect(replay.idempotent_replay).toBe(true);
      expect(await namCot(moi, D)).toEqual(hienTai);
      expect(await soQuyetDinh(moi)).toBe(quyetDinh);
      expect(await quyetDinhCuaRunCu(moi, runCu, hienTai?.id)).toBe(0);
      expect(await anhDuLieu(moi)).toEqual(anh);
    });
  });

  it('cùng khoá nhưng KHÁC nội dung vẫn bị phần lõi từ chối 23505 (nhánh trả sớm không nuốt lỗi)', async () => {
    await ca(moi, async () => {
      const { args } = await chot(moi, 'CLOSE', 'k1');
      const khac = [...args];
      khac[4] = 'Ly do khac hoan toan';
      expect(await loiCua(goi(moi, khac))).toEqual({ code: '23505', message: 'Idempotency key was already used with a different request' });
    });
  });
});

// ---------------------------------------------------------------- forward lane
/** Cơ sở dữ liệu tối thiểu cho các ca của lane: chỉ cần đúng hàm bị thay (thân không kiểm lúc tạo). */
async function dbLane(cau: string = WRAPPER_CU): Promise<PGlite> {
  const la = new PGlite();
  await la.exec('CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role; SET check_function_bodies = off;');
  await napWrapperCu(la, cau);
  return la;
}

describe('20261116082842 — forward lane: dựng lại thì kéo quyền về đúng, lệch bản đã rà thì dừng', () => {
  it('database dựng lại (dư quyền PUBLIC / anon / authenticated) ⇒ vẫn chạy, quyền về đúng proacl đã ghim', async () => {
    const la = await dbLane();
    try {
      await la.exec(`GRANT EXECUTE ON FUNCTION ${HAM} TO PUBLIC, anon, authenticated, service_role;`);
      await la.exec(SQL);
      expect(await trangThaiHam(la)).toMatchObject({ md5: md5(THAN_MOI), acl: ACL });
    } finally {
      await la.close();
    }
  }, 60_000);

  const CA: [string, () => Promise<PGlite>, RegExp][] = [
    ['PR khác vừa sửa thân',
      () => dbLane(WRAPPER_CU.replace('AS $fn$', 'AS $fn$\n-- PR khác vừa sửa')),
      /Thân .* đã khác/],
    ['PR khác vừa thu quyền (file không được âm thầm cấp lại)',
      async () => { const la = await dbLane(); await la.exec(`REVOKE EXECUTE ON FUNCTION ${HAM} FROM service_role;`); return la; },
      /Thuộc tính .* đã khác/],
    ['PR khác vừa đổi search_path',
      async () => { const la = await dbLane(); await la.exec(`ALTER FUNCTION ${HAM} SET search_path = public;`); return la; },
      /Thuộc tính .* đã khác/],
  ];
  it.each(CA)('%s ⇒ 55000 nêu đúng hàm, thân không bị thay', async (_ten, dung, cau) => {
    const la = await dung();
    try {
      const truoc = await trangThaiHam(la);
      const loi = await loiCua(la.exec(SQL));
      expect(loi?.code).toBe('55000');
      expect(loi?.message).toContain(HAM);
      expect(loi?.message).toMatch(cau);
      await la.exec('ROLLBACK');
      expect(await trangThaiHam(la)).toEqual(truoc);
    } finally {
      await la.close();
    }
  }, 60_000);

  it('file cấp thừa quyền ⇒ kiểm sau ném 55000, ROLLBACK trả lại thân cũ', async () => {
    const la = await dbLane();
    try {
      const sqlSai = SQL.replace(`GRANT EXECUTE ON FUNCTION ${HAM} TO service_role;`,
        `GRANT EXECUTE ON FUNCTION ${HAM} TO authenticated, service_role;`);
      expect(sqlSai).not.toBe(SQL);
      const loi = await loiCua(la.exec(sqlSai));
      expect(loi?.code).toBe('55000');
      expect(loi?.message).toMatch(/lệch SECURITY \/ proconfig \/ quyền/);
      await la.exec('ROLLBACK');
      expect(await trangThaiHam(la)).toMatchObject({ md5: MD5_CU, acl: ACL });
    } finally {
      await la.close();
    }
  }, 60_000);
});
