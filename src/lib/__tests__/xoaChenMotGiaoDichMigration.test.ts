import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';

// Đợt 10b: «xoá rồi chèn lại» gộp vào MỘT giao dịch trên máy chủ — năm hàm SECURITY INVOKER mới. Dựng các bảng với RLS
// chép NGUYÊN điều kiện chính sách đang chạy trên production (pg_policies đọc 26/11/2026; hàm quyền thay bằng bản giả theo
// bảng quyền thử) và trigger chạy THÂN SỐNG (autofill_org_strict, khoa_organization_id_v1, recompute_material_stock,
// material_items_after_change, material_purchase_recompute_total, set_user_id_from_auth, set_material_*_code: md5 prosrc
// trong repo = production). Áp tệp migration HAI lượt, rồi so từng hàm với đúng chuỗi lệnh trình duyệt ghi thẳng hôm nay:
// cùng người, cùng trạng thái đầu ⇒ hàm chỉ thành công khi ghi thẳng cũng đạt đúng bộ đích (không nới quyền, không thu hẹp),
// và khi từ chối thì không đổi gì. PGlite chỉ có một kết nối: hai phiên song song thử trên project TEST (mô tả PR).
const MIG_DIR = 'supabase/migrations';
const MIGRATION_FILE = '20261126180450_xoa_chen_mot_giao_dich.sql';
const migrationSql = readFileSync(join(MIG_DIR, MIGRATION_FILE), 'utf8').replace(/\r\n/g, '\n');

/** Lần CREATE cuối cùng của một hàm ở các tệp migration TRƯỚC tệp này (định nghĩa đang chạy khi tệp này áp). */
function liveBefore(name: string): string {
  const head = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${name.replace('.', '\\.')}\\s*\\(`, 'i');
  let sql = '';
  for (const f of readdirSync(MIG_DIR).filter((x) => x.endsWith('.sql') && x < MIGRATION_FILE).sort()) {
    const text = readFileSync(join(MIG_DIR, f), 'utf8').replace(/\r\n/g, '\n');
    let from = 0;
    for (;;) {
      const m = text.slice(from).match(head);
      if (!m || m.index === undefined) break;
      const start = from + m.index;
      const tag = text.slice(start).match(/\bAS\s+(\$[A-Za-z_]*\$)/i);
      if (!tag || tag.index === undefined) break;
      const bodyStart = start + tag.index + tag[0].length;
      const end = text.indexOf(tag[1], bodyStart);
      const stop = end < 0 ? -1 : text.indexOf(';', end + tag[1].length);
      if (stop < 0) break;
      sql = text.slice(start, stop + 1);
      from = stop + 1;
    }
  }
  if (!sql) throw new Error(`Không thấy định nghĩa trước của ${name}`);
  return sql;
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const orgA = id(1), orgB = id(2);
const full = id(11), noDelete = id(12), viewer = id(13), outsider = id(14), superUser = id(15), noEdit = id(16);
const b1 = id(21), bB = id(22), room1 = id(23), roomB = id(24);
const s1 = id(31), s2 = id(32), s3 = id(33), sB = id(34);
const q1 = id(41);
const m1 = id(51), m2 = id(52);
const p1 = id(61);
const job1 = id(71), job2 = id(72);
const usage1 = id(73);
const c1 = id(81), cB = id(82);
const adj = id(91);

const db = new PGlite();
/** Chạy một khối SQL dựng nền; lỗi thì nói rõ khối nào. */
async function setup(label: string, sql: string) {
  try { await db.exec(sql); } catch (error) { throw new Error(`dựng nền «${label}»: ${(error as Error).message}`); }
}
type Row = Record<string, unknown>;
type Failure = { code?: string; message?: string };

async function rows(sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await db.query<Row>(sql, params)).rows;
}
async function one(sql: string, params: unknown[] = []): Promise<Row> {
  return (await rows(sql, params))[0];
}

/** Mỗi ca một transaction, luôn ROLLBACK — các ca không dẫm dữ liệu của nhau. */
async function rollback<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec('BEGIN');
  try {
    return await fn();
  } finally {
    await db.exec('ROLLBACK');
  }
}

/**
 * Một lệnh như PostgREST: vai authenticated, auth.uid() = người gọi, giao dịch riêng (savepoint). Lỗi ⇒ lùi đúng lệnh đó
 * và trả {error}. `actor = null` = chưa đăng nhập.
 */
async function asUser(actor: string | null, sql: string, params: unknown[] = []): Promise<{ rows?: Row[]; error?: Failure }> {
  await db.exec('SAVEPOINT goi');
  await db.exec(`SET LOCAL ROLE authenticated; SELECT set_config('test.actor','${actor ?? ''}',true);`);
  try {
    const r = await rows(sql, params);
    await db.exec('RESET ROLE; RELEASE SAVEPOINT goi');
    return { rows: r };
  } catch (error) {
    await db.exec('ROLLBACK TO SAVEPOINT goi; RESET ROLE; RELEASE SAVEPOINT goi');
    const e = error as Failure;
    return { error: { code: e.code, message: e.message } };
  }
}

// ── Năm hàm mới ─────────────────────────────────────────────────────────────────────────────────────────────────────────
type Call = { result?: unknown; error?: Failure };
const rpc = async (actor: string | null, sql: string, params: unknown[]): Promise<Call> => {
  const r = await asUser(actor, sql, params);
  return r.error ? { error: r.error } : { result: r.rows?.[0]?.r };
};
const replaceBuilding = (actor: string | null, building: string, services: Row[]) =>
  rpc(actor, 'SELECT public.replace_building_services_v1($1::uuid, $2::jsonb) AS r', [building, JSON.stringify(services)]);
const replaceQuota = (actor: string | null, quota: string, name: string, description: string | null, tiers: Row[]) =>
  rpc(actor, 'SELECT public.replace_service_quota_v1($1::uuid, $2, $3, $4::jsonb) AS r', [quota, name, description, JSON.stringify(tiers)]);
const replacePurchase = (actor: string | null, purchase: string, date: string, supplier: string | null, notes: string | null, items: Row[]) =>
  rpc(actor, 'SELECT public.replace_material_purchase_v1($1::uuid, $2::date, $3::uuid, $4, $5::jsonb) AS r', [purchase, date, supplier, notes, JSON.stringify(items)]);
const saveUsage = (actor: string | null, job: string, date: string, notes: string | null, items: Row[]) =>
  rpc(actor, 'SELECT public.save_job_material_usage_v1($1::uuid, $2::date, $3, $4::jsonb) AS r', [job, date, notes, JSON.stringify(items)]);
const replaceContract = (actor: string | null, contract: string, services: Row[]) =>
  rpc(actor, 'SELECT public.replace_contract_services_v1($1::uuid, $2::jsonb) AS r', [contract, JSON.stringify(services)]);

// ── Ghi thẳng như trình duyệt hôm nay (mỗi lệnh một yêu cầu PostgREST, dừng ở lỗi đầu tiên) ─────────────────────────────
type Direct = { failed: boolean };
async function steps(actor: string | null, list: Array<() => [string, unknown[]] | null>, stopOnEmpty: boolean[] = []): Promise<Direct> {
  for (let i = 0; i < list.length; i += 1) {
    const step = list[i]();
    if (!step) continue;
    const r = await asUser(actor, step[0], step[1]);
    if (r.error) return { failed: true };
    // `.single()` của PostgREST: khớp 0 dòng ⇒ PGRST116, lùi lệnh đó và dừng (ở đây lệnh khớp 0 dòng không đổi gì).
    if (stopOnEmpty[i] && !(r.rows?.length)) return { failed: true };
  }
  return { failed: false };
}
const values = (list: Row[], columns: string[]) => list.map((row) => `(${columns.map((c) => (row[c] === null || row[c] === undefined ? 'NULL' : `'${String(row[c])}'`)).join(', ')})`).join(', ');
const directBuilding = (actor: string | null, building: string, services: Row[], selectedOrg: string) => steps(actor, [
  () => ['DELETE FROM public.building_services WHERE building_id = $1 RETURNING id', [building]],
  () => (services.length ? [`INSERT INTO public.building_services (building_id, service_id, is_active, unit_price_override, organization_id)
     SELECT $1::uuid, v.s::uuid, v.a::boolean, v.p::numeric, $2::uuid FROM (VALUES ${values(services, ['service_id', 'is_active', 'unit_price_override'])}) v(s, a, p) RETURNING id`, [building, selectedOrg]] : null),
]);
async function directQuota(actor: string | null, quota: string, name: string, description: string | null, tiers: Row[]): Promise<Direct> {
  const head = await asUser(actor, 'UPDATE public.service_quotas SET name = $2, description = $3 WHERE id = $1 RETURNING id, organization_id', [quota, name, description]);
  if (head.error || !head.rows?.length) return { failed: true };
  const org = head.rows[0].organization_id as string;
  return steps(actor, [
    () => ['DELETE FROM public.service_quota_tiers WHERE quota_id = $1 RETURNING id', [quota]],
    () => (tiers.length ? [`INSERT INTO public.service_quota_tiers (quota_id, tier_number, from_value, to_value, unit_price, organization_id)
       SELECT $1::uuid, v.t::int, v.f::numeric, v.u::numeric, v.p::numeric, $2::uuid FROM (VALUES ${values(tiers, ['tier_number', 'from_value', 'to_value', 'unit_price'])}) v(t, f, u, p) RETURNING id`, [quota, org]] : null),
  ]);
}
async function directPurchase(actor: string | null, purchase: string, date: string, supplier: string | null, notes: string | null, items: Row[]): Promise<Direct> {
  const head = await asUser(actor, 'UPDATE public.material_purchases SET purchase_date = $2, supplier_id = $3, notes = $4 WHERE id = $1 RETURNING id, organization_id', [purchase, date, supplier, notes]);
  if (head.error || !head.rows?.length) return { failed: true };
  const org = head.rows[0].organization_id as string;
  return steps(actor, [
    () => ['DELETE FROM public.material_purchase_items WHERE purchase_id = $1 RETURNING id', [purchase]],
    () => (items.length ? [`INSERT INTO public.material_purchase_items (purchase_id, material_id, quantity, unit_price, organization_id)
       SELECT $1::uuid, v.m::uuid, v.q::numeric, v.p::numeric, $2::uuid FROM (VALUES ${values(items, ['material_id', 'quantity', 'unit_price'])}) v(m, q, p) RETURNING id`, [purchase, org]] : null),
  ]);
}
async function directUsage(actor: string | null, job: string, date: string, notes: string | null, items: Row[]): Promise<Direct> {
  const read = await asUser(actor, 'SELECT id FROM public.material_usages WHERE job_id = $1', [job]);
  if (read.error) return { failed: true };
  let usage = read.rows?.[0]?.id as string | undefined;
  const insertItems = () => (items.length ? [`INSERT INTO public.material_usage_items (usage_id, material_id, quantity, unit_cost_at_usage)
     SELECT $1::uuid, v.m::uuid, v.q::numeric, v.c::numeric FROM (VALUES ${values(items, ['material_id', 'quantity', 'unit_cost_at_usage'])}) v(m, q, c) RETURNING id`, [usage]] as [string, unknown[]] : null);
  if (usage) {
    const head = await asUser(actor, 'UPDATE public.material_usages SET usage_date = $2, notes = $3 WHERE id = $1 RETURNING id', [usage, date, notes]);
    if (head.error || !head.rows?.length) return { failed: true };
    const del = await asUser(actor, 'DELETE FROM public.material_usage_items WHERE usage_id = $1 RETURNING id', [usage]);
    if (del.error) return { failed: true };
    if (items.length) return steps(actor, [insertItems]);
    const gone = await asUser(actor, 'DELETE FROM public.material_usages WHERE id = $1 RETURNING id', [usage]);
    return { failed: !!gone.error || !gone.rows?.length };
  }
  if (!items.length) return { failed: false };
  const created = await asUser(actor, 'INSERT INTO public.material_usages (job_id, usage_date, notes) VALUES ($1, $2, $3) RETURNING id', [job, date, notes]);
  if (created.error || !created.rows?.length) return { failed: true };
  usage = created.rows[0].id as string;
  return steps(actor, [insertItems]);
}
const directContract = (actor: string | null, contract: string, services: Row[], org: string) => steps(actor, [
  () => ['DELETE FROM public.contract_services WHERE contract_id = $1 RETURNING id', [contract]],
  () => (services.length ? [`INSERT INTO public.contract_services (contract_id, service_id, unit_price, initial_reading, organization_id)
     SELECT $1::uuid, v.s::uuid, v.p::numeric, v.i::numeric, $2::uuid FROM (VALUES ${values(services, ['service_id', 'unit_price', 'initial_reading'])}) v(s, p, i) RETURNING id`, [contract, org]] : null),
]);

// ── Ảnh chụp trạng thái (đọc bằng quyền chủ bảng, không theo RLS) ───────────────────────────────────────────────────────
const snapshot = async () => ({
  building: await rows(`SELECT building_id, service_id, is_active, unit_price_override::text AS p, organization_id FROM public.building_services
    WHERE building_id IN ('${b1}', '${bB}') ORDER BY building_id, service_id`),
  quota: await rows(`SELECT name, description FROM public.service_quotas WHERE id = '${q1}'`),
  tiers: await rows(`SELECT tier_number, from_value::text AS f, to_value::text AS t, unit_price::text AS p, organization_id FROM public.service_quota_tiers
    WHERE quota_id = '${q1}' ORDER BY tier_number`),
  purchase: await rows(`SELECT purchase_date::text AS d, supplier_id, notes, total::text AS total FROM public.material_purchases WHERE id = '${p1}'`),
  purchaseItems: await rows(`SELECT material_id, quantity::text AS q, unit_price::text AS p, line_total::text AS lt, organization_id
    FROM public.material_purchase_items WHERE purchase_id = '${p1}' ORDER BY material_id, quantity`),
  usages: await rows(`SELECT job_id, usage_date::text AS d, notes, organization_id FROM public.material_usages ORDER BY job_id`),
  usageItems: await rows(`SELECT u.job_id, i.material_id, i.quantity::text AS q, i.unit_cost_at_usage::text AS c, i.organization_id
    FROM public.material_usage_items i JOIN public.material_usages u ON u.id = i.usage_id ORDER BY u.job_id, i.material_id, i.quantity`),
  stock: await rows(`SELECT id, on_hand::text AS on_hand, round(avg_unit_cost, 6)::text AS avg FROM public.materials ORDER BY id`),
  contract: await rows(`SELECT contract_id, service_id, unit_price::text AS p, initial_reading::text AS i, organization_id FROM public.contract_services
    WHERE contract_id IN ('${c1}', '${cB}') ORDER BY contract_id, service_id`),
});
type Snapshot = Awaited<ReturnType<typeof snapshot>>;

/** Chạy `a` và `b` trên CÙNG trạng thái đầu (mỗi bên một giao dịch ROLLBACK riêng), trả ảnh chụp trước/sau của từng bên. */
async function compare<A, B>(a: () => Promise<A>, b: () => Promise<B>) {
  const left = await rollback(async () => { const before = await snapshot(); const out = await a(); return { before, out, after: await snapshot() }; });
  const right = await rollback(async () => { const before = await snapshot(); const out = await b(); return { before, out, after: await snapshot() }; });
  return { left, right };
}

const md5Of = async (fn: string) =>
  (await one(`SELECT md5(replace(prosrc, chr(13), '')) AS m FROM pg_proc WHERE oid = to_regprocedure('${fn}')`)).m as string | null;

const ORG_BOUNDARY_NULL = `((organization_id IS NULL) OR ( SELECT is_super_admin() AS is_super_admin) OR (organization_id IN ( SELECT unnest(my_org_ids()) AS unnest)))`;
const ORG_BOUNDARY = `(( SELECT is_super_admin() AS is_super_admin) OR (organization_id IN ( SELECT unnest(my_org_ids()) AS unnest)))`;
const SUPER = `( SELECT is_super_admin() AS is_super_admin)`;
const HIDE_SANDBOX = `(NOT (( SELECT is_super_admin() AS is_super_admin) AND COALESCE((organization_id = ANY (sandbox_org_ids())), false)))`;
const HIDE_DEMO_USER = `(NOT (( SELECT (( SELECT is_super_admin() AS is_super_admin) OR ( SELECT is_admin() AS is_admin))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest))))`;
/** Chính sách của bảng theo quyền công ty (can_access_org_entity) — chép đúng production. */
function entityPolicies(table: string, resource: string, deleteAction: string, superRole: string, hideDemo: boolean): string {
  return `
    ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;
    CREATE POLICY ${table}_org_boundary ON public.${table} AS RESTRICTIVE FOR ALL TO authenticated USING ${ORG_BOUNDARY} WITH CHECK ${ORG_BOUNDARY};
    CREATE POLICY ${table}_super_admin_all ON public.${table} FOR ALL TO ${superRole} USING (${SUPER}) WITH CHECK (${SUPER});
    CREATE POLICY ${table}_delete_rbac ON public.${table} FOR DELETE TO public USING (can_access_org_entity('${resource}'::text, '${deleteAction}'::text));
    CREATE POLICY ${table}_insert_rbac ON public.${table} FOR INSERT TO public WITH CHECK (can_access_org_entity('${resource}'::text, 'create'::text));
    CREATE POLICY ${table}_hide_sandbox_admin ON public.${table} AS RESTRICTIVE FOR SELECT TO authenticated USING ${HIDE_SANDBOX};
    ${hideDemo ? `CREATE POLICY ${table}_hide_demo_admin ON public.${table} AS RESTRICTIVE FOR SELECT TO authenticated USING ${HIDE_DEMO_USER};` : ''}
    CREATE POLICY ${table}_select_rbac ON public.${table} FOR SELECT TO public USING (can_access_org_entity('${resource}'::text, 'view'::text));
    CREATE POLICY ${table}_update_rbac ON public.${table} FOR UPDATE TO public USING (can_access_org_entity('${resource}'::text, 'edit'::text)) WITH CHECK (can_access_org_entity('${resource}'::text, 'edit'::text));`;
}

beforeAll(async () => {
  await setup('bảng và hàm quyền', `
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
    GRANT USAGE ON SCHEMA app_private TO service_role, anon, authenticated;
    GRANT USAGE ON SCHEMA auth TO service_role, anon, authenticated;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.actor', true), '')::uuid $$;

    CREATE TABLE public.organizations(id uuid PRIMARY KEY);
    CREATE TABLE public.organization_memberships(user_id uuid, organization_id uuid, status text);
    CREATE TABLE public.super_admins(user_id uuid PRIMARY KEY);
    -- Bảng quyền thử: building_id NULL = toàn công ty.
    CREATE TABLE app_private.test_perm(user_id uuid, perm text, building_id uuid);
    CREATE TABLE public.buildings(id uuid, organization_id uuid, user_id uuid, deleted_at timestamptz, PRIMARY KEY (id));
    CREATE TABLE public.rooms(id uuid, building_id uuid REFERENCES public.buildings(id), organization_id uuid, PRIMARY KEY (id));
    CREATE TABLE public.contracts(id uuid, room_id uuid REFERENCES public.rooms(id), organization_id uuid, user_id uuid, PRIMARY KEY (id));
    CREATE TABLE public.services(id uuid, organization_id uuid, PRIMARY KEY (id));
    CREATE TABLE public.jobs(id uuid, organization_id uuid, PRIMARY KEY (id));
    CREATE TABLE public.materials(id uuid, organization_id uuid NOT NULL, on_hand numeric NOT NULL DEFAULT 0,
      avg_unit_cost numeric NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (id));
    CREATE TABLE public.material_adjustments(id uuid, type text NOT NULL, organization_id uuid NOT NULL, PRIMARY KEY (id));
    CREATE TABLE public.material_adjustment_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      adjustment_id uuid NOT NULL REFERENCES public.material_adjustments(id) ON DELETE CASCADE, material_id uuid NOT NULL,
      quantity numeric NOT NULL, organization_id uuid NOT NULL);

    CREATE TABLE public.building_services(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      building_id uuid NOT NULL REFERENCES public.buildings(id) ON DELETE CASCADE,
      service_id uuid NOT NULL REFERENCES public.services(id) ON DELETE CASCADE,
      is_active boolean NOT NULL DEFAULT true, unit_price_override numeric,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT,
      CONSTRAINT building_services_unique UNIQUE (building_id, service_id),
      CONSTRAINT building_services_price_non_negative CHECK ((unit_price_override IS NULL) OR (unit_price_override >= (0)::numeric)));
    CREATE TABLE public.service_quotas(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, name text NOT NULL,
      description text, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT);
    CREATE TABLE public.service_quota_tiers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      quota_id uuid NOT NULL REFERENCES public.service_quotas(id) ON DELETE CASCADE, tier_number integer NOT NULL,
      from_value numeric NOT NULL DEFAULT 0, to_value numeric, unit_price numeric NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(), organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
      CONSTRAINT service_quota_tiers_quota_id_tier_number_key UNIQUE (quota_id, tier_number));
    CREATE TABLE public.material_purchases(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, code text NOT NULL,
      purchase_date date NOT NULL DEFAULT CURRENT_DATE, supplier_id uuid, total numeric NOT NULL DEFAULT 0, notes text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), organization_id uuid NOT NULL);
    CREATE TABLE public.material_purchase_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      purchase_id uuid NOT NULL REFERENCES public.material_purchases(id) ON DELETE CASCADE,
      material_id uuid NOT NULL REFERENCES public.materials(id) ON DELETE RESTRICT,
      quantity numeric NOT NULL CONSTRAINT material_purchase_items_quantity_check CHECK (quantity > (0)::numeric),
      unit_price numeric NOT NULL CONSTRAINT material_purchase_items_unit_price_check CHECK (unit_price >= (0)::numeric),
      line_total numeric GENERATED ALWAYS AS (quantity * unit_price) STORED, organization_id uuid NOT NULL);
    CREATE TABLE public.material_usages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, code text NOT NULL,
      usage_date date NOT NULL DEFAULT CURRENT_DATE, job_id uuid REFERENCES public.jobs(id) ON DELETE CASCADE, notes text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), organization_id uuid NOT NULL,
      CONSTRAINT material_usages_code_key UNIQUE (code));
    CREATE UNIQUE INDEX uq_material_usages_job ON public.material_usages USING btree (job_id) WHERE (job_id IS NOT NULL);
    CREATE TABLE public.material_usage_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      usage_id uuid NOT NULL REFERENCES public.material_usages(id) ON DELETE CASCADE,
      material_id uuid NOT NULL REFERENCES public.materials(id) ON DELETE RESTRICT,
      quantity numeric NOT NULL CONSTRAINT material_usage_items_quantity_check CHECK (quantity > (0)::numeric),
      unit_cost_at_usage numeric NOT NULL DEFAULT 0, organization_id uuid NOT NULL);
    CREATE TABLE public.contract_services(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contract_id uuid NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
      service_id uuid NOT NULL REFERENCES public.services(id) ON DELETE RESTRICT,
      unit_price numeric NOT NULL CONSTRAINT contract_services_unit_price_non_negative CHECK (unit_price >= (0)::numeric),
      initial_reading numeric, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT,
      CONSTRAINT contract_services_contract_id_service_id_key UNIQUE (contract_id, service_id));
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon, authenticated;

    -- Hàm quyền giả (production: DEFINER, đọc staff_assignments / roles; ở đây đọc bảng quyền thử).
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS
      $$ SELECT EXISTS (SELECT 1 FROM public.super_admins WHERE user_id = auth.uid()) $$;
    CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER AS
      $$ SELECT coalesce(array_agg(organization_id), '{}'::uuid[]) FROM public.organization_memberships WHERE user_id = auth.uid() AND status = 'ACTIVE' $$;
    CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql IMMUTABLE AS $$ SELECT '{}'::uuid[] $$;
    CREATE FUNCTION public.demo_user_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT '{}'::uuid[] $$;
    CREATE FUNCTION public.demo_building_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT '{}'::uuid[] $$;
    CREATE FUNCTION public.can_access_org_entity(_resource text, _action text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS
      $$ SELECT public.is_super_admin() OR EXISTS (SELECT 1 FROM app_private.test_perm WHERE user_id = auth.uid() AND perm = _resource || '.' || _action) $$;
    CREATE FUNCTION app_private.buildings_for_v3(p_permission_key text) RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER AS
      $$ SELECT coalesce(array_agg(b.id), '{}'::uuid[]) FROM public.buildings b
          WHERE b.deleted_at IS NULL AND b.organization_id = ANY (public.my_org_ids())
            AND EXISTS (SELECT 1 FROM app_private.test_perm p WHERE p.user_id = auth.uid() AND p.perm = p_permission_key
                          AND (p.building_id IS NULL OR p.building_id = b.id)) $$;
    CREATE FUNCTION public.can_access_building(_building_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS
      $$ SELECT public.is_super_admin() OR _building_id = ANY (app_private.buildings_for_v3('buildings.view')) $$;
    CREATE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;
  `);
  // Thân sống của trigger và hàm phụ (md5 prosrc = production, xem mô tả PR).
  for (const fn of ['public.building_of_contract', 'app_private.autofill_org_strict', 'app_private.khoa_organization_id_v1',
    'public.recompute_material_stock', 'public.material_items_after_change', 'public.material_purchase_recompute_total',
    'public.set_user_id_from_auth', 'public.set_material_purchase_code', 'public.set_material_usage_code']) {
    await setup(fn, liveBefore(fn));
  }
  await setup('trigger và RLS', `
    -- Trigger: đúng tên, đúng thời điểm, đúng sự kiện như production.
    CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.building_services FOR EACH ROW EXECUTE FUNCTION app_private.autofill_org_strict();
    CREATE TRIGGER update_building_services_updated_at BEFORE UPDATE ON public.building_services FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
    CREATE TRIGGER zz_khoa_organization_id BEFORE UPDATE ON public.building_services FOR EACH ROW EXECUTE FUNCTION app_private.khoa_organization_id_v1();
    CREATE TRIGGER set_contract_services_updated_at BEFORE UPDATE ON public.contract_services FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
    CREATE TRIGGER trg_autofill_org BEFORE INSERT ON public.contract_services FOR EACH ROW EXECUTE FUNCTION app_private.autofill_org_strict();
    CREATE TRIGGER zz_khoa_organization_id BEFORE UPDATE ON public.contract_services FOR EACH ROW EXECUTE FUNCTION app_private.khoa_organization_id_v1();
    CREATE TRIGGER trg_autofill_org_strict BEFORE INSERT ON public.material_purchase_items FOR EACH ROW EXECUTE FUNCTION app_private.autofill_org_strict();
    CREATE TRIGGER trg_mpi_recompute AFTER INSERT OR DELETE OR UPDATE ON public.material_purchase_items FOR EACH ROW EXECUTE FUNCTION public.material_items_after_change();
    CREATE TRIGGER trg_mpi_total AFTER INSERT OR DELETE OR UPDATE ON public.material_purchase_items FOR EACH ROW EXECUTE FUNCTION public.material_purchase_recompute_total();
    CREATE TRIGGER zz_khoa_organization_id BEFORE UPDATE ON public.material_purchase_items FOR EACH ROW EXECUTE FUNCTION app_private.khoa_organization_id_v1();
    CREATE TRIGGER material_purchases_set_user_id_audit BEFORE INSERT ON public.material_purchases FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
    CREATE TRIGGER set_material_purchases_updated_at BEFORE UPDATE ON public.material_purchases FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
    CREATE TRIGGER trg_autofill_org_strict BEFORE INSERT ON public.material_purchases FOR EACH ROW EXECUTE FUNCTION app_private.autofill_org_strict();
    CREATE TRIGGER trg_mp_code BEFORE INSERT ON public.material_purchases FOR EACH ROW EXECUTE FUNCTION public.set_material_purchase_code();
    CREATE TRIGGER zz_khoa_organization_id BEFORE UPDATE ON public.material_purchases FOR EACH ROW EXECUTE FUNCTION app_private.khoa_organization_id_v1();
    CREATE TRIGGER trg_autofill_org_strict BEFORE INSERT ON public.material_usage_items FOR EACH ROW EXECUTE FUNCTION app_private.autofill_org_strict();
    CREATE TRIGGER trg_mui_recompute AFTER INSERT OR DELETE OR UPDATE ON public.material_usage_items FOR EACH ROW EXECUTE FUNCTION public.material_items_after_change();
    CREATE TRIGGER zz_khoa_organization_id BEFORE UPDATE ON public.material_usage_items FOR EACH ROW EXECUTE FUNCTION app_private.khoa_organization_id_v1();
    CREATE TRIGGER material_usages_set_user_id_audit BEFORE INSERT ON public.material_usages FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
    CREATE TRIGGER set_material_usages_updated_at BEFORE UPDATE ON public.material_usages FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
    CREATE TRIGGER trg_autofill_org_strict BEFORE INSERT ON public.material_usages FOR EACH ROW EXECUTE FUNCTION app_private.autofill_org_strict();
    CREATE TRIGGER trg_mu_code BEFORE INSERT ON public.material_usages FOR EACH ROW EXECUTE FUNCTION public.set_material_usage_code();
    CREATE TRIGGER zz_khoa_organization_id BEFORE UPDATE ON public.material_usages FOR EACH ROW EXECUTE FUNCTION app_private.khoa_organization_id_v1();
    CREATE TRIGGER trg_autofill_org_strict BEFORE INSERT ON public.service_quota_tiers FOR EACH ROW EXECUTE FUNCTION app_private.autofill_org_strict();
    CREATE TRIGGER zz_khoa_organization_id BEFORE UPDATE ON public.service_quota_tiers FOR EACH ROW EXECUTE FUNCTION app_private.khoa_organization_id_v1();
    CREATE TRIGGER service_quotas_set_user_id_audit BEFORE INSERT ON public.service_quotas FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
    CREATE TRIGGER trg_autofill_org_strict BEFORE INSERT ON public.service_quotas FOR EACH ROW EXECUTE FUNCTION app_private.autofill_org_strict();
    CREATE TRIGGER zz_khoa_organization_id BEFORE UPDATE ON public.service_quotas FOR EACH ROW EXECUTE FUNCTION app_private.khoa_organization_id_v1();

    -- RLS: điều kiện chép đúng pg_policies production (26/11/2026).
    ALTER TABLE public.building_services ENABLE ROW LEVEL SECURITY;
    CREATE POLICY building_services_org_boundary ON public.building_services AS RESTRICTIVE FOR ALL TO authenticated USING ${ORG_BOUNDARY_NULL} WITH CHECK ${ORG_BOUNDARY_NULL};
    CREATE POLICY building_services_super_admin_all ON public.building_services FOR ALL TO authenticated USING (${SUPER}) WITH CHECK (${SUPER});
    CREATE POLICY building_services_delete_rbac ON public.building_services FOR DELETE TO public USING ((${SUPER} OR (building_id = ANY (app_private.buildings_for_v3('services.delete'::text)))));
    CREATE POLICY building_services_insert_rbac ON public.building_services FOR INSERT TO public WITH CHECK ((${SUPER} OR (building_id = ANY (app_private.buildings_for_v3('services.create'::text)))));
    CREATE POLICY building_services_hide_demo_admin ON public.building_services AS RESTRICTIVE FOR SELECT TO authenticated USING ((NOT (( SELECT (( SELECT is_super_admin() AS is_super_admin) OR ( SELECT is_admin() AS is_admin))) AND (building_id IN ( SELECT unnest(demo_building_ids()) AS unnest)))));
    CREATE POLICY building_services_hide_sandbox_admin ON public.building_services AS RESTRICTIVE FOR SELECT TO authenticated USING ${HIDE_SANDBOX};
    CREATE POLICY building_services_select_rbac ON public.building_services FOR SELECT TO public USING (can_access_building(building_id));
    CREATE POLICY building_services_update_rbac ON public.building_services FOR UPDATE TO public USING ((${SUPER} OR (building_id = ANY (app_private.buildings_for_v3('services.edit'::text))))) WITH CHECK ((${SUPER} OR (building_id = ANY (app_private.buildings_for_v3('services.edit'::text)))));

    ALTER TABLE public.contract_services ENABLE ROW LEVEL SECURITY;
    CREATE POLICY contract_services_org_boundary ON public.contract_services AS RESTRICTIVE FOR ALL TO authenticated USING ${ORG_BOUNDARY_NULL} WITH CHECK ${ORG_BOUNDARY_NULL};
    CREATE POLICY contract_services_super_admin_all ON public.contract_services FOR ALL TO authenticated USING (${SUPER}) WITH CHECK (${SUPER});
    CREATE POLICY contract_services_delete_rbac ON public.contract_services FOR DELETE TO public USING ((${SUPER} OR (building_of_contract(contract_id) = ANY (app_private.buildings_for_v3('contracts.delete'::text)))));
    CREATE POLICY contract_services_insert_rbac ON public.contract_services FOR INSERT TO public WITH CHECK ((${SUPER} OR (building_of_contract(contract_id) = ANY (app_private.buildings_for_v3('contracts.create'::text)))));
    CREATE POLICY contract_services_hide_sandbox_admin ON public.contract_services AS RESTRICTIVE FOR SELECT TO authenticated USING ${HIDE_SANDBOX};
    CREATE POLICY contract_services_select_rbac ON public.contract_services FOR SELECT TO public USING (can_access_building(building_of_contract(contract_id)));
    CREATE POLICY contract_services_update_rbac ON public.contract_services FOR UPDATE TO public USING ((${SUPER} OR (building_of_contract(contract_id) = ANY (app_private.buildings_for_v3('contracts.edit'::text))))) WITH CHECK ((${SUPER} OR (building_of_contract(contract_id) = ANY (app_private.buildings_for_v3('contracts.edit'::text)))));
    ${entityPolicies('material_purchases', 'materials', 'delete', 'public', true)}
    ${entityPolicies('material_purchase_items', 'materials', 'edit', 'public', false)}
    ${entityPolicies('material_usages', 'materials', 'delete', 'public', true)}
    ${entityPolicies('material_usage_items', 'materials', 'edit', 'public', false)}
    ${entityPolicies('service_quotas', 'service_quotas', 'delete', 'authenticated', false)}
    ${entityPolicies('service_quota_tiers', 'service_quotas', 'delete', 'authenticated', false)}
  `);

  // Dữ liệu: công ty A (toà b1, phòng room1, hợp đồng c1) và công ty B (toà bB, hợp đồng cB).
  const perms: Array<[string, string[]]> = [
    [full, ['buildings.view', 'services.create', 'services.delete', 'services.edit', 'materials.view', 'materials.create', 'materials.edit', 'materials.delete',
      'service_quotas.view', 'service_quotas.create', 'service_quotas.edit', 'service_quotas.delete', 'contracts.create', 'contracts.delete', 'contracts.edit']],
    // Có quyền thêm/sửa, KHÔNG có quyền xoá ở cả năm nơi.
    [noDelete, ['buildings.view', 'services.create', 'services.edit', 'materials.view', 'materials.create', 'materials.edit',
      'service_quotas.view', 'service_quotas.create', 'service_quotas.edit', 'contracts.create', 'contracts.edit']],
    // Có quyền xem/thêm/xoá nhưng KHÔNG có quyền sửa (vật tư, định mức): không sửa được đầu phiếu.
    [noEdit, ['buildings.view', 'materials.view', 'materials.create', 'materials.delete', 'service_quotas.view', 'service_quotas.create', 'service_quotas.delete']],
    // Vai trò chỉ xem.
    [viewer, ['buildings.view', 'materials.view', 'service_quotas.view']],
    // Đủ quyền nhưng ở công ty B.
    [outsider, ['buildings.view', 'services.create', 'services.delete', 'services.edit', 'materials.view', 'materials.create', 'materials.edit', 'materials.delete',
      'service_quotas.view', 'service_quotas.create', 'service_quotas.edit', 'service_quotas.delete', 'contracts.create', 'contracts.delete', 'contracts.edit']],
  ];
  await setup('dữ liệu', `
    INSERT INTO public.organizations VALUES ('${orgA}'), ('${orgB}');
    INSERT INTO public.organization_memberships VALUES ('${full}', '${orgA}', 'ACTIVE'), ('${noDelete}', '${orgA}', 'ACTIVE'),
      ('${noEdit}', '${orgA}', 'ACTIVE'), ('${viewer}', '${orgA}', 'ACTIVE'), ('${outsider}', '${orgB}', 'ACTIVE');
    INSERT INTO public.super_admins VALUES ('${superUser}');
    INSERT INTO public.buildings VALUES ('${b1}', '${orgA}', '${full}', NULL), ('${bB}', '${orgB}', '${outsider}', NULL);
    INSERT INTO public.rooms VALUES ('${room1}', '${b1}', '${orgA}'), ('${roomB}', '${bB}', '${orgB}');
    INSERT INTO public.contracts VALUES ('${c1}', '${room1}', '${orgA}', '${full}'), ('${cB}', '${roomB}', '${orgB}', '${outsider}');
    INSERT INTO public.services VALUES ('${s1}', '${orgA}'), ('${s2}', '${orgA}'), ('${s3}', '${orgA}'), ('${sB}', '${orgB}');
    INSERT INTO public.jobs VALUES ('${job1}', '${orgA}'), ('${job2}', '${orgA}');
    INSERT INTO public.materials (id, organization_id) VALUES ('${m1}', '${orgA}'), ('${m2}', '${orgA}');
    INSERT INTO public.building_services (building_id, service_id, is_active, unit_price_override, organization_id) VALUES
      ('${b1}', '${s1}', true, NULL, '${orgA}'), ('${b1}', '${s2}', false, 1000, '${orgA}'), ('${bB}', '${sB}', true, NULL, '${orgB}');
    INSERT INTO public.service_quotas (id, user_id, name, description, organization_id) VALUES ('${q1}', '${full}', 'Nước bậc thang', 'cũ', '${orgA}');
    INSERT INTO public.service_quota_tiers (quota_id, tier_number, from_value, to_value, unit_price, organization_id) VALUES
      ('${q1}', 1, 0, 10, 5000, '${orgA}'), ('${q1}', 2, 10, NULL, 8000, '${orgA}');
    INSERT INTO public.material_purchases (id, user_id, code, purchase_date, notes, organization_id) VALUES ('${p1}', '${full}', 'MP-20261120-0001', '2026-11-20', 'cũ', '${orgA}');
    INSERT INTO public.material_purchase_items (purchase_id, material_id, quantity, unit_price, organization_id) VALUES
      ('${p1}', '${m1}', 10, 100, '${orgA}'), ('${p1}', '${m2}', 5, 200, '${orgA}');
    INSERT INTO public.material_adjustments VALUES ('${adj}', 'IN', '${orgA}');
    INSERT INTO public.material_adjustment_items (adjustment_id, material_id, quantity, organization_id) VALUES ('${adj}', '${m2}', 3, '${orgA}');
    SELECT public.recompute_material_stock('${m2}');
    INSERT INTO public.material_usages (id, user_id, code, usage_date, job_id, notes, organization_id) VALUES ('${usage1}', '${full}', 'MU-20261120-0001', '2026-11-20', '${job1}', 'cũ', '${orgA}');
    INSERT INTO public.material_usage_items (usage_id, material_id, quantity, unit_cost_at_usage, organization_id) VALUES ('${usage1}', '${m1}', 2, 100, '${orgA}');
    INSERT INTO public.contract_services (contract_id, service_id, unit_price, initial_reading, organization_id) VALUES
      ('${c1}', '${s1}', 3500, 10, '${orgA}'), ('${c1}', '${s2}', 100000, NULL, '${orgA}'), ('${cB}', '${sB}', 3000, NULL, '${orgB}');
  `);
  for (const [user, keys] of perms) {
    for (const key of keys) await db.query('INSERT INTO app_private.test_perm VALUES ($1, $2, NULL)', [user, key]);
  }

  await setup('migration lượt một', migrationSql);
  await setup('migration lượt hai (chạy lại được)', migrationSql);
});

const servicesA = [{ service_id: s2, is_active: true, unit_price_override: 1500 }, { service_id: s3, is_active: false, unit_price_override: null }];
const tiersA = [{ tier_number: 1, from_value: 0, to_value: 5, unit_price: 6000 }, { tier_number: 2, from_value: 5, to_value: 20, unit_price: 7000 }, { tier_number: 3, from_value: 20, to_value: null, unit_price: 9000 }];
const purchaseItemsA = [{ material_id: m1, quantity: 4, unit_price: 150 }, { material_id: m1, quantity: 1, unit_price: 90 }, { material_id: m2, quantity: 7, unit_price: 210 }];
const usageItemsA = [{ material_id: m1, quantity: 3, unit_cost_at_usage: 100 }, { material_id: m2, quantity: 1, unit_cost_at_usage: 200 }];
const contractA = [{ service_id: s1, unit_price: 3800, initial_reading: 12 }, { service_id: s3, unit_price: 50000, initial_reading: null }];

describe('xoá rồi chèn lại một giao dịch — hình dạng', () => {
  it('năm hàm SECURITY INVOKER, VOLATILE, search_path ghim, chỉ authenticated gọi được; tệp chạy lại được', async () => {
    const fns = ['public.replace_building_services_v1(uuid,jsonb)', 'public.replace_service_quota_v1(uuid,text,text,jsonb)',
      'public.replace_material_purchase_v1(uuid,date,uuid,text,jsonb)', 'public.save_job_material_usage_v1(uuid,date,text,jsonb)',
      'public.replace_contract_services_v1(uuid,jsonb)'];
    for (const fn of fns) {
      const r = await one(`SELECT p.prosecdef, p.provolatile, p.proconfig, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
        has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc
        FROM pg_proc p WHERE p.oid = to_regprocedure($1)`, [fn]);
      expect(r).toMatchObject({ prosecdef: false, provolatile: 'v', proconfig: ['search_path=pg_catalog, public'], auth: true, anon: false, svc: false });
    }
    // Trigger được dựa vào chạy đúng thân production (md5 prosrc).
    expect(await md5Of('public.recompute_material_stock(uuid)')).toBe('2867345151e0ee5384270b00a993ab62');
    expect(await md5Of('app_private.autofill_org_strict()')).toBe('ffc89eb36fa19d996d27f1d10e3adc15');
  });

  it('khoá đứng TRƯỚC lệnh xoá ở cả năm hàm; ba nơi sửa đầu phiếu khoá FOR UPDATE, toà / hợp đồng / công việc khoá tư vấn', () => {
    const body = (fn: string) => {
      const head = migrationSql.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
      return migrationSql.slice(migrationSql.indexOf('AS $function$', head), migrationSql.indexOf('$function$;', head));
    };
    const cases: Array<[string, RegExp, string]> = [
      ['replace_building_services_v1', /pg_advisory_xact_lock\(hashtextextended\('replace_building_services_v1:'/, 'DELETE FROM public.building_services'],
      ['replace_service_quota_v1', /FROM public\.service_quotas WHERE id = p_quota_id FOR UPDATE/, 'DELETE FROM public.service_quota_tiers'],
      ['replace_material_purchase_v1', /FROM public\.material_purchases WHERE id = p_purchase_id FOR UPDATE/, 'DELETE FROM public.material_purchase_items'],
      ['save_job_material_usage_v1', /pg_advisory_xact_lock\(hashtextextended\('save_job_material_usage_v1:'/, 'DELETE FROM public.material_usage_items'],
      ['replace_contract_services_v1', /pg_advisory_xact_lock\(hashtextextended\('replace_contract_services_v1:'/, 'DELETE FROM public.contract_services'],
    ];
    for (const [fn, lock, del] of cases) {
      const text = body(fn);
      const at = text.search(lock);
      expect(at, fn).toBeGreaterThan(0);
      expect(at, fn).toBeLessThan(text.indexOf(del));
      expect(text, fn).not.toMatch(/SECURITY DEFINER/);
    }
    expect(body('save_job_material_usage_v1')).toMatch(/FROM public\.material_usages WHERE id = v_id FOR UPDATE/);
  });

  it('khoá tư vấn còn giữ tới hết giao dịch của người gọi (hai lệnh cùng cha xếp hàng)', async () => {
    await rollback(async () => {
      const lockCount = async (prefix: string, key: string) => Number((await one(`SELECT count(*)::int AS n FROM pg_locks l,
        (SELECT hashtextextended($1 || $2, 0) AS k) x WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
          AND l.classid::bigint = ((x.k >> 32) & 4294967295) AND l.objid::bigint = (x.k & 4294967295)`, [prefix, key])).n);
      expect(await lockCount('replace_building_services_v1:', b1)).toBe(0);
      expect((await replaceBuilding(full, b1, servicesA)).error).toBeUndefined();
      expect(await lockCount('replace_building_services_v1:', b1)).toBe(1);
      expect((await replaceContract(full, c1, contractA)).error).toBeUndefined();
      expect(await lockCount('replace_contract_services_v1:', c1)).toBe(1);
      expect((await saveUsage(full, job2, '2026-11-21', null, usageItemsA)).error).toBeUndefined();
      expect(await lockCount('save_job_material_usage_v1:', job2)).toBe(1);
    });
  });
});

describe('dịch vụ mặc định của toà', () => {
  it('thay đúng bộ đích; chạy lại cùng bộ ra đúng MỘT bộ dòng; công ty của dòng = công ty của toà (trigger suy)', async () => {
    await rollback(async () => {
      const first = await replaceBuilding(full, b1, servicesA);
      expect(first.error).toBeUndefined();
      const again = await replaceBuilding(full, b1, servicesA);
      const rowsNow = await rows(`SELECT service_id, is_active, unit_price_override::text AS p, organization_id FROM public.building_services WHERE building_id = '${b1}' ORDER BY service_id`);
      expect(rowsNow).toEqual([
        { service_id: s2, is_active: true, p: '1500', organization_id: orgA },
        { service_id: s3, is_active: false, p: null, organization_id: orgA },
      ]);
      // Biên nhận: đúng các dòng vừa ghi (mã mới mỗi lần, nội dung y hệt).
      const receipt = again.result as Row[];
      expect(receipt.map((r) => [r.building_id, r.service_id, r.is_active, r.unit_price_override]).sort()).toEqual([[b1, s2, true, 1500], [b1, s3, false, null]].sort());
      expect(new Set(receipt.map((r) => r.id)).size).toBe(2);
      expect(await rows(`SELECT id FROM public.building_services WHERE building_id = '${b1}' AND id = ANY ($1::uuid[])`, [receipt.map((r) => r.id)])).toHaveLength(2);
      // Toà khác không bị đụng.
      expect(await rows(`SELECT service_id FROM public.building_services WHERE building_id = '${bB}'`)).toEqual([{ service_id: sB }]);
    });
  });

  it('bộ rỗng ⇒ toà không còn dịch vụ mặc định nào', async () => {
    await rollback(async () => {
      expect(await replaceBuilding(full, b1, [])).toEqual({ result: [] });
      expect(await rows(`SELECT id FROM public.building_services WHERE building_id = '${b1}'`)).toEqual([]);
    });
  });

  it('một dòng vi phạm ràng buộc (trùng dịch vụ, giá âm) ⇒ lùi cả giao dịch, dịch vụ cũ còn nguyên', async () => {
    await rollback(async () => {
      const before = (await snapshot()).building;
      const dup = await replaceBuilding(full, b1, [{ service_id: s3, is_active: true, unit_price_override: null }, { service_id: s3, is_active: false, unit_price_override: 5 }]);
      expect(dup.error?.code).toBe('23505');
      const negative = await replaceBuilding(full, b1, [{ service_id: s3, is_active: true, unit_price_override: -1 }]);
      expect(negative.error?.code).toBe('23514');
      const unknownService = await replaceBuilding(full, b1, [{ service_id: id(999), is_active: true, unit_price_override: null }]);
      expect(unknownService.error?.code).toBe('23503');
      expect((await snapshot()).building).toEqual(before);
    });
  });

  it('đầu vào sai dạng ⇒ 22023; chưa đăng nhập ⇒ 42501; không đổi gì', async () => {
    await rollback(async () => {
      const before = (await snapshot()).building;
      expect((await replaceBuilding(full, b1, [{ service_id: s3, is_active: 'có', unit_price_override: null }])).error?.code).toBe('22023');
      expect((await rpc(full, 'SELECT public.replace_building_services_v1($1::uuid, $2::jsonb) AS r', [b1, '{"service_id":"x"}'])).error?.code).toBe('22023');
      expect((await replaceBuilding(null, b1, servicesA)).error).toEqual({ code: '42501', message: 'Chưa đăng nhập' });
      expect((await snapshot()).building).toEqual(before);
    });
  });
});

describe('bậc định mức (kèm tên, mô tả)', () => {
  it('đặt tên/mô tả và thay đủ bộ bậc; chạy lại cùng bộ ra đúng một bộ bậc', async () => {
    await rollback(async () => {
      expect((await replaceQuota(full, q1, 'Nước mới', null, tiersA)).error).toBeUndefined();
      const again = await replaceQuota(full, q1, 'Nước mới', null, tiersA);
      const result = again.result as { quota: Row; tiers: Row[] };
      expect(result.quota).toEqual({ id: q1, name: 'Nước mới', description: null, organization_id: orgA });
      expect(result.tiers.map((t) => [t.tier_number, t.from_value, t.to_value, t.unit_price, t.quota_id])).toEqual([[1, 0, 5, 6000, q1], [2, 5, 20, 7000, q1], [3, 20, null, 9000, q1]]);
      const s = await snapshot();
      expect(s.quota).toEqual([{ name: 'Nước mới', description: null }]);
      expect(s.tiers.map((t) => [t.tier_number, t.p, t.organization_id])).toEqual([[1, '6000', orgA], [2, '7000', orgA], [3, '9000', orgA]]);
    });
  });

  it('định mức không có / không được sửa ⇒ P0002, không đổi gì (kể cả tên)', async () => {
    await rollback(async () => {
      const before = await snapshot();
      expect((await replaceQuota(full, id(4040), 'X', null, tiersA)).error?.code).toBe('P0002');
      expect((await replaceQuota(noEdit, q1, 'X', null, tiersA)).error?.code).toBe('P0002');
      expect((await replaceQuota(viewer, q1, 'X', null, tiersA)).error?.code).toBe('P0002');
      expect((await replaceQuota(outsider, q1, 'X', null, tiersA)).error?.code).toBe('P0002');
      const after = await snapshot();
      expect(after.quota).toEqual(before.quota);
      expect(after.tiers).toEqual(before.tiers);
    });
  });

  it('bậc trùng số ⇒ 23505, tên và bậc cũ còn nguyên (không còn «đã gỡ bậc cũ nhưng chưa lưu bậc mới»)', async () => {
    await rollback(async () => {
      const before = await snapshot();
      const r = await replaceQuota(full, q1, 'Tên mới', 'mô tả', [{ tier_number: 1, from_value: 0, to_value: 5, unit_price: 1 }, { tier_number: 1, from_value: 5, to_value: null, unit_price: 2 }]);
      expect(r.error?.code).toBe('23505');
      const after = await snapshot();
      expect(after.quota).toEqual(before.quota);
      expect(after.tiers).toEqual(before.tiers);
    });
  });
});

describe('dòng phiếu nhập vật tư', () => {
  it('đặt đầu phiếu + thay dòng; tồn kho, giá vốn bình quân, tổng phiếu BẰNG ĐÚNG kết quả của cách ghi thẳng', async () => {
    const { left: viaRpc, right: viaDirect } = await compare(
      () => replacePurchase(full, p1, '2026-11-22', null, 'mới', purchaseItemsA),
      () => directPurchase(full, p1, '2026-11-22', null, 'mới', purchaseItemsA),
    );
    expect(viaRpc.out.error).toBeUndefined();
    expect(viaDirect.out.failed).toBe(false);
    expect(viaRpc.after.stock).toEqual(viaDirect.after.stock);
    expect(viaRpc.after.purchase).toEqual(viaDirect.after.purchase);
    expect(viaRpc.after.purchaseItems).toEqual(viaDirect.after.purchaseItems);
    // Con số cụ thể: m1 nhập 4 + 1 − xuất 2 = 3; giá vốn (4·150 + 1·90)/5 = 138; m2 nhập 7 + kiểm IN 3 = 10.
    expect(viaRpc.after.stock).toEqual([{ id: m1, on_hand: '3', avg: '138.000000' }, { id: m2, on_hand: '10', avg: '210.000000' }]);
    expect(viaRpc.after.purchase).toEqual([{ d: '2026-11-22', supplier_id: null, notes: 'mới', total: '2160' }]);
    const result = viaRpc.out.result as { purchase: Row; items: Row[] };
    expect(result.purchase).toMatchObject({ id: p1, organization_id: orgA, purchase_date: '2026-11-22', supplier_id: null, notes: 'mới', total: 2160 });
    expect(result.items.map((i) => [i.purchase_id, i.material_id, i.quantity, i.unit_price]).sort()).toEqual([[p1, m1, 1, 90], [p1, m1, 4, 150], [p1, m2, 7, 210]].sort());
  });

  it('chạy lại cùng bộ: đúng một bộ dòng, tồn không cộng hai lần', async () => {
    await rollback(async () => {
      expect((await replacePurchase(full, p1, '2026-11-22', null, 'mới', purchaseItemsA)).error).toBeUndefined();
      const once = await snapshot();
      expect((await replacePurchase(full, p1, '2026-11-22', null, 'mới', purchaseItemsA)).error).toBeUndefined();
      const twice = await snapshot();
      expect(twice.purchaseItems).toHaveLength(3);
      expect(twice.stock).toEqual(once.stock);
      expect(twice.purchase).toEqual(once.purchase);
    });
  });

  it('một dòng vi phạm ràng buộc (số lượng 0) ⇒ lùi cả giao dịch: đầu phiếu, dòng cũ, tồn kho, tổng còn nguyên', async () => {
    await rollback(async () => {
      const before = await snapshot();
      const r = await replacePurchase(full, p1, '2026-11-22', null, 'mới', [{ material_id: m1, quantity: 4, unit_price: 150 }, { material_id: m2, quantity: 0, unit_price: 1 }]);
      expect(r.error?.code).toBe('23514');
      const after = await snapshot();
      expect(after.purchase).toEqual(before.purchase);
      expect(after.purchaseItems).toEqual(before.purchaseItems);
      expect(after.stock).toEqual(before.stock);
    });
  });

  it('phiếu không có / không sửa được ⇒ P0002, không xoá dòng nào', async () => {
    await rollback(async () => {
      const before = await snapshot();
      expect((await replacePurchase(full, id(4041), '2026-11-22', null, null, purchaseItemsA)).error?.code).toBe('P0002');
      expect((await replacePurchase(viewer, p1, '2026-11-22', null, null, [])).error?.code).toBe('P0002');
      expect((await replacePurchase(noEdit, p1, '2026-11-22', null, null, [])).error?.code).toBe('P0002');
      expect((await replacePurchase(outsider, p1, '2026-11-22', null, null, [])).error?.code).toBe('P0002');
      expect(await snapshot()).toEqual(before);
    });
  });
});

describe('vật tư của công việc', () => {
  it('công việc chưa có phiếu ⇒ tạo phiếu (người lập, công ty, mã) + dòng; lần hai sửa đúng phiếu đó, không phiếu thứ hai', async () => {
    await rollback(async () => {
      const first = await saveUsage(full, job2, '2026-11-21', 'việc 2', usageItemsA);
      expect(first.error).toBeUndefined();
      const firstResult = first.result as { usage_id: string; usage: Row; removed: boolean; items: Row[] };
      expect(firstResult.removed).toBe(false);
      expect(firstResult.usage).toMatchObject({ id: firstResult.usage_id, job_id: job2, usage_date: '2026-11-21', notes: 'việc 2', organization_id: orgA });
      expect(String(firstResult.usage.code)).toMatch(/^MU-\d{8}-\d{4}$/);
      expect(await one(`SELECT user_id FROM public.material_usages WHERE id = $1`, [firstResult.usage_id])).toEqual({ user_id: full });
      const second = await saveUsage(full, job2, '2026-11-21', 'việc 2', usageItemsA);
      expect((second.result as { usage_id: string }).usage_id).toBe(firstResult.usage_id);
      expect(await rows(`SELECT id FROM public.material_usages WHERE job_id = '${job2}'`)).toHaveLength(1);
      expect(await rows(`SELECT i.id FROM public.material_usage_items i JOIN public.material_usages u ON u.id = i.usage_id WHERE u.job_id = '${job2}'`)).toHaveLength(2);
    });
  });

  it('tồn kho bằng đúng kết quả của cách ghi thẳng (sửa phiếu có sẵn, tạo phiếu mới, gỡ phiếu)', async () => {
    const cases: Array<[string, string, Row[]]> = [[job1, 'sửa', usageItemsA], [job2, 'tạo', usageItemsA], [job1, 'gỡ', []]];
    for (const [job, , items] of cases) {
      const { left: viaRpc, right: viaDirect } = await compare(
        () => saveUsage(full, job, '2026-11-23', 'mới', items),
        () => directUsage(full, job, '2026-11-23', 'mới', items),
      );
      expect(viaRpc.out.error).toBeUndefined();
      expect(viaDirect.out.failed).toBe(false);
      expect(viaRpc.after.stock).toEqual(viaDirect.after.stock);
      expect(viaRpc.after.usageItems).toEqual(viaDirect.after.usageItems);
      expect(viaRpc.after.usages.map((u) => [u.job_id, u.d, u.notes, u.organization_id])).toEqual(viaDirect.after.usages.map((u) => [u.job_id, u.d, u.notes, u.organization_id]));
    }
  });

  it('bộ rỗng: có phiếu ⇒ gỡ phiếu (removed); chưa có phiếu ⇒ không làm gì', async () => {
    await rollback(async () => {
      const removed = await saveUsage(full, job1, '2026-11-23', null, []);
      expect(removed.result).toMatchObject({ usage_id: usage1, usage: null, removed: true, items: [] });
      expect(await rows(`SELECT id FROM public.material_usages WHERE job_id = '${job1}'`)).toEqual([]);
      const nothing = await saveUsage(full, job2, '2026-11-23', null, []);
      expect(nothing.result).toEqual({ usage_id: null, usage: null, removed: false, items: [] });
      expect(await rows(`SELECT id FROM public.material_usages WHERE job_id = '${job2}'`)).toEqual([]);
    });
  });

  it('không có quyền xoá phiếu ⇒ dòng được gỡ, phiếu rỗng ở lại (y như ghi thẳng hôm nay), removed = false', async () => {
    const { left: viaRpc, right: viaDirect } = await compare(
      () => saveUsage(noDelete, job1, '2026-11-23', null, []),
      () => directUsage(noDelete, job1, '2026-11-23', null, []),
    );
    expect(viaRpc.out.result).toMatchObject({ usage_id: usage1, removed: false, items: [] });
    expect((viaRpc.out.result as { usage: Row }).usage).toMatchObject({ id: usage1, job_id: job1 });
    expect(viaDirect.out.failed).toBe(true); // trình duyệt hôm nay: «đã xoá hết vật tư … không có quyền xoá phiếu»
    expect(viaRpc.after).toEqual(viaDirect.after);
    expect(viaRpc.after.usageItems.filter((u) => u.job_id === job1)).toEqual([]);
  });

  it('một dòng vi phạm ràng buộc ⇒ lùi cả giao dịch: dòng cũ và tồn còn nguyên; tạo phiếu hỏng thì không còn phiếu rỗng', async () => {
    await rollback(async () => {
      const before = await snapshot();
      const bad = [{ material_id: m1, quantity: 1, unit_cost_at_usage: 100 }, { material_id: m2, quantity: -2, unit_cost_at_usage: 1 }];
      expect((await saveUsage(full, job1, '2026-11-23', 'x', bad)).error?.code).toBe('23514');
      expect((await saveUsage(full, job2, '2026-11-23', 'x', bad)).error?.code).toBe('23514');
      expect(await snapshot()).toEqual(before);
    });
  });

  it('không sửa được phiếu ⇒ P0002, không đổi gì; chưa đăng nhập ⇒ 42501', async () => {
    await rollback(async () => {
      const before = await snapshot();
      expect((await saveUsage(viewer, job1, '2026-11-23', null, usageItemsA)).error?.code).toBe('P0002');
      expect((await saveUsage(noEdit, job1, '2026-11-23', null, usageItemsA)).error?.code).toBe('P0002');
      expect((await saveUsage(null, job1, '2026-11-23', null, usageItemsA)).error?.code).toBe('42501');
      expect(await snapshot()).toEqual(before);
    });
  });
});

describe('dịch vụ của hợp đồng khi sửa', () => {
  it('thay đúng bộ đích; chạy lại ra đúng một bộ; công ty của dòng = công ty của hợp đồng', async () => {
    await rollback(async () => {
      expect((await replaceContract(full, c1, contractA)).error).toBeUndefined();
      const again = await replaceContract(full, c1, contractA);
      expect((again.result as Row[]).map((r) => [r.contract_id, r.service_id, r.unit_price, r.initial_reading]).sort()).toEqual([[c1, s1, 3800, 12], [c1, s3, 50000, null]].sort());
      expect((await snapshot()).contract.filter((r) => r.contract_id === c1)).toEqual([
        { contract_id: c1, service_id: s1, p: '3800', i: '12', organization_id: orgA },
        { contract_id: c1, service_id: s3, p: '50000', i: null, organization_id: orgA },
      ]);
    });
  });

  it('một dòng vi phạm ràng buộc ⇒ dịch vụ cũ còn nguyên', async () => {
    await rollback(async () => {
      const before = (await snapshot()).contract;
      expect((await replaceContract(full, c1, [{ service_id: s3, unit_price: 1, initial_reading: null }, { service_id: s1, unit_price: -5, initial_reading: null }])).error?.code).toBe('23514');
      expect((await snapshot()).contract).toEqual(before);
    });
  });
});

describe('quyền y như ghi thẳng bảng hôm nay', () => {
  // Với mỗi người và mỗi nơi: cùng trạng thái đầu, chạy chuỗi lệnh trình duyệt ghi thẳng hôm nay và hàm mới.
  // - Ghi thẳng đạt ĐÚNG bộ đích ⇒ hàm mới cũng đạt, cùng trạng thái cuối (không thu hẹp).
  // - Ghi thẳng bị từ chối / chỉ đạt một phần ⇒ hàm mới từ chối và KHÔNG đổi gì (không nới), trừ ca gỡ phiếu xuất khi không
  //   có quyền xoá phiếu: cả hai cùng để lại đúng một trạng thái (phiếu rỗng).
  const people: Array<[string, string | null, string]> = [
    ['đủ quyền', full, orgA], ['không có quyền xoá', noDelete, orgA], ['không có quyền sửa', noEdit, orgA],
    ['chỉ xem', viewer, orgA], ['công ty khác', outsider, orgB], ['superadmin', superUser, orgA], ['chưa đăng nhập', null, orgA],
  ];
  const targets: Array<{ name: string; fn: (actor: string | null) => Promise<Call>; direct: (actor: string | null, org: string) => Promise<Direct>; reached: (s: Snapshot) => boolean; part: (s: Snapshot) => unknown; reachedBy: string[] }> = [
    { name: 'dịch vụ toà', fn: (a) => replaceBuilding(a, b1, servicesA), direct: (a, o) => directBuilding(a, b1, servicesA, o),
      reached: (s) => JSON.stringify(s.building.filter((r) => r.building_id === b1).map((r) => [r.service_id, r.is_active, r.p])) === JSON.stringify([[s2, true, '1500'], [s3, false, null]]),
      part: (s) => s.building, reachedBy: ['đủ quyền', 'superadmin'] },
    { name: 'bậc định mức', fn: (a) => replaceQuota(a, q1, 'Tên mới', null, tiersA), direct: (a) => directQuota(a, q1, 'Tên mới', null, tiersA),
      reached: (s) => s.quota[0]?.name === 'Tên mới' && JSON.stringify(s.tiers.map((t) => [t.tier_number, t.p])) === JSON.stringify([[1, '6000'], [2, '7000'], [3, '9000']]),
      part: (s) => [s.quota, s.tiers], reachedBy: ['đủ quyền', 'superadmin'] },
    { name: 'phiếu nhập', fn: (a) => replacePurchase(a, p1, '2026-11-24', null, 'mới', purchaseItemsA), direct: (a) => directPurchase(a, p1, '2026-11-24', null, 'mới', purchaseItemsA),
      reached: (s) => s.purchase[0]?.notes === 'mới' && s.purchaseItems.length === 3,
      part: (s) => [s.purchase, s.purchaseItems, s.stock], reachedBy: ['đủ quyền', 'không có quyền xoá', 'superadmin'] },
    { name: 'vật tư công việc', fn: (a) => saveUsage(a, job1, '2026-11-24', 'mới', usageItemsA), direct: (a) => directUsage(a, job1, '2026-11-24', 'mới', usageItemsA),
      reached: (s) => s.usages.find((u) => u.job_id === job1)?.notes === 'mới' && s.usageItems.filter((u) => u.job_id === job1).length === 2,
      part: (s) => [s.usages, s.usageItems, s.stock], reachedBy: ['đủ quyền', 'không có quyền xoá', 'superadmin'] },
    { name: 'tạo phiếu xuất cho công việc', fn: (a) => saveUsage(a, job2, '2026-11-24', 'mới', usageItemsA), direct: (a) => directUsage(a, job2, '2026-11-24', 'mới', usageItemsA),
      reached: (s) => s.usageItems.filter((u) => u.job_id === job2).length === 2,
      part: (s) => [s.usages, s.usageItems, s.stock], reachedBy: ['đủ quyền', 'không có quyền xoá', 'không có quyền sửa', 'superadmin'] },
    { name: 'dịch vụ hợp đồng', fn: (a) => replaceContract(a, c1, contractA), direct: (a, o) => directContract(a, c1, contractA, o),
      reached: (s) => JSON.stringify(s.contract.filter((r) => r.contract_id === c1).map((r) => [r.service_id, r.p])) === JSON.stringify([[s1, '3800'], [s3, '50000']]),
      part: (s) => s.contract, reachedBy: ['đủ quyền', 'superadmin'] },
  ];
  for (const target of targets) {
    for (const [label, actor, org] of people) {
      it(`${target.name} — ${label}`, async () => {
        const { left: viaRpc, right: viaDirect } = await compare(() => target.fn(actor), () => target.direct(actor, org));
        const directReached = !viaDirect.out.failed && target.reached(viaDirect.after);
        // Ma trận quyền mong đợi: chặn trường hợp phép so «xanh rỗng» (ví dụ mọi người đều bị từ chối vì nền dựng sai).
        expect(directReached, 'ghi thẳng hôm nay').toBe(target.reachedBy.includes(label));
        if (directReached) {
          expect(viaRpc.out.error, JSON.stringify(viaRpc.out.error)).toBeUndefined();
          expect(target.reached(viaRpc.after)).toBe(true);
          expect(target.part(viaRpc.after)).toEqual(target.part(viaDirect.after));
        } else {
          expect(viaRpc.out.error, 'hàm mới không được làm được việc mà ghi thẳng không làm được').toBeDefined();
          expect(['42501', 'P0002', '23505', '23502', '23503']).toContain(viaRpc.out.error?.code);
          expect(viaRpc.after).toEqual(viaRpc.before);
        }
      });
    }
  }
  it('ca mẫu: hai cách cho cùng kết quả ở người đủ quyền, và người không có quyền xoá thì ghi thẳng ra bộ LẪN cũ + mới còn hàm mới từ chối', async () => {
    const { left: viaRpc, right: viaDirect } = await compare(
      () => replaceBuilding(noDelete, b1, [{ service_id: s3, is_active: true, unit_price_override: null }]),
      () => directBuilding(noDelete, b1, [{ service_id: s3, is_active: true, unit_price_override: null }], orgA),
    );
    expect(viaDirect.out.failed).toBe(false);
    expect(viaDirect.after.building.filter((r) => r.building_id === b1).map((r) => r.service_id)).toEqual([s1, s2, s3]);
    expect(viaRpc.out.error?.code).toBe('42501');
    expect(viaRpc.after).toEqual(viaRpc.before);
  });
  it('không có quyền xoá + bộ đích không trùng khoá với bộ cũ (bậc 5; dịch vụ s3): ghi thẳng ra bộ LẪN, hàm mới 42501 không đổi gì', async () => {
    const quota = await compare(
      () => replaceQuota(noDelete, q1, 'Nước bậc thang', 'cũ', [{ tier_number: 5, from_value: 0, to_value: null, unit_price: 1 }]),
      () => directQuota(noDelete, q1, 'Nước bậc thang', 'cũ', [{ tier_number: 5, from_value: 0, to_value: null, unit_price: 1 }]),
    );
    expect(quota.right.out.failed).toBe(false);
    expect(quota.right.after.tiers.map((t) => t.tier_number)).toEqual([1, 2, 5]);
    expect(quota.left.out.error?.code).toBe('42501');
    expect(quota.left.after).toEqual(quota.left.before);
    const contract = await compare(
      () => replaceContract(noDelete, c1, [{ service_id: s3, unit_price: 1, initial_reading: null }]),
      () => directContract(noDelete, c1, [{ service_id: s3, unit_price: 1, initial_reading: null }], orgA),
    );
    expect(contract.right.out.failed).toBe(false);
    expect(contract.right.after.contract.filter((r) => r.contract_id === c1).map((r) => r.service_id)).toEqual([s1, s2, s3]);
    expect(contract.left.out.error?.code).toBe('42501');
    expect(contract.left.after).toEqual(contract.left.before);
  });
});
