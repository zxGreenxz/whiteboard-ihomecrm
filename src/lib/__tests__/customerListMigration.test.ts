// customer_list_v1 (20261017115708) so với ĐÚNG đường web cũ của màn Khách hàng, trên cùng một
// database PGlite có RLS thật của năm bảng (chép từ pg_policies TEST 17/10/2026):
//   web cũ = PostgREST customers (RLS) + customerSearchFilter + get_customer_residence_location_ids_v1
//            + order created_at desc + range/count + chuỗi nhúng contract_customers→contracts→rooms→buildings
//            + get_customer_stats / 4 count khi có từ khoá.
// Một instance PGlite cho cả file, mỗi ca BEGIN…ROLLBACK.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { customerSearchFilter } from '@/lib/customerSearch';

const db = new PGlite();
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const [ORG_A, ORG_B, SANDBOX] = [1, 2, 3].map(id);
const [OWNER, STAFF, NOVIEW, OTHER, SUPER, OUTSIDER, DEMO] = [10, 11, 12, 13, 14, 15, 16].map(id);
const [B1, B2, B3, BX] = [20, 21, 22, 23].map(id);
const [R1A, R1B, R2A, R3A, RXA] = [30, 31, 32, 33, 34].map(id);
const C = (n: number) => id(100 + n);
const MIGRATION = 'supabase/migrations/20261017115708_customer_list_v1.sql';

type Row = Record<string, unknown> & { id: string };
type Stats = { total: number; individual: number; organization: number; foreign: number };
type ListResult = { total: number; stats: Stats; rows: Row[] };
type Filters = { status?: string; statFilter?: string; search?: string; building_id?: string; room_id?: string };
type Page = { page: number; pageSize: number };
type Location = { bid: string | null; bn: string | null; rn: string | null };

const grants: Array<[string, string, string | null]> = [
  [OWNER, 'member', ORG_A], [OWNER, 'customers.view', null],
  ...[B1, B2, B3].flatMap(b => [[OWNER, 'buildings.view', b], [OWNER, 'contracts.view', b]] as Array<[string, string, string]>),
  // Nhân viên: xem toà B1+B2 nhưng chỉ có contracts.view ở B1 ⇒ lọc lưu trú B2 phải rỗng.
  [STAFF, 'member', ORG_A], [STAFF, 'customers.view', null], [STAFF, 'buildings.view', B1], [STAFF, 'buildings.view', B2],
  [STAFF, 'contracts.view', B1],
  [NOVIEW, 'member', ORG_A], [NOVIEW, 'buildings.view', B1], [NOVIEW, 'contracts.view', B1],
  [OTHER, 'member', ORG_B], [OTHER, 'customers.view', null], [OTHER, 'buildings.view', BX], [OTHER, 'contracts.view', BX],
  [SUPER, 'super', null], [SUPER, 'member', ORG_A], [SUPER, 'member', ORG_B],
  [DEMO, 'member', ORG_A],
];

// [n, org, owner, name, type, foreign, phone, email, id_number, deleted]
const customers: Array<[number, string, string, string, string, boolean, string | null, string | null, string | null, boolean]> = [
  [1, ORG_A, OWNER, 'Nguyễn Văn An', 'INDIVIDUAL', false, '0901 234 567', null, '079200000001', false],
  [2, ORG_A, STAFF, 'NGUYỄN THỊ BÌNH', 'INDIVIDUAL', false, '0912000111', 'binh@example.test', null, false],
  [3, ORG_A, OWNER, 'Đặng Quốc Dũng'.normalize('NFD'), 'INDIVIDUAL', false, '0933000222', null, null, false],
  [4, ORG_A, OWNER, 'Công ty TNHH đông á', 'ORGANIZATION', false, '02873000333', 'dong-a@example.test', null, false],
  [5, ORG_A, OWNER, 'John Smith', 'INDIVIDUAL', true, '+1 555 0100', 'john@example.test', 'P1234567', false],
  [6, ORG_A, OWNER, 'Trần (Test) [x]', 'INDIVIDUAL', false, '+84.90*1', null, '079.123', false],
  [7, ORG_A, OWNER, 'lê thị hoa', 'INDIVIDUAL', false, '0977000444', null, null, false],
  [8, ORG_A, OWNER, 'phạm minh đức', 'INDIVIDUAL', false, '0988000555', 'duc+1@example.test', null, false],
  [9, ORG_A, OUTSIDER, 'Hidden Owner', 'INDIVIDUAL', false, '0999000666', null, null, false],
  [10, ORG_A, OWNER, 'Deleted Person', 'INDIVIDUAL', false, '0900000777', null, null, true],
  [11, ORG_A, DEMO, 'Demo khách', 'INDIVIDUAL', false, '0900000888', null, null, false],
  [12, ORG_B, OTHER, 'Org B Nguyễn', 'INDIVIDUAL', false, '0900000999', null, null, false],
  [13, ORG_A, OWNER, 'Nguyen Nhat An', 'INDIVIDUAL', false, '0900001000', null, null, false],
  [14, ORG_A, STAFF, 'đỗ thùy dương', 'ORGANIZATION', true, '0900001111', null, null, false],
  [15, SANDBOX, OWNER, 'Sandbox Person', 'INDIVIDUAL', false, '0900001222', null, null, false],
  ...[16, 17, 18, 19, 20].map(n => [n, ORG_A, n % 2 ? OWNER : STAFF, `Khach ${n}`, 'INDIVIDUAL', n === 19, `09100${n}`, null, null, false] as
    [number, string, string, string, string, boolean, string, null, null, boolean]),
];

// [n, room, org, status, start, actual_end, deleted, customers]
const contracts: Array<[number, string, string, string, string, string | null, boolean, number[]]> = [
  [40, R1A, ORG_A, 'ACTIVE', '2026-01-01', null, false, [1, 8]],
  [41, R1B, ORG_A, 'ACTIVE', '2026-03-01', null, false, [2, 16]],
  [42, R2A, ORG_A, 'ACTIVE', '2025-06-01', null, false, [3, 8, 17]],
  [43, R3A, ORG_A, 'ACTIVE', '2026-02-01', null, false, [4, 18]],
  [44, R1A, ORG_A, 'TERMINATED', '2025-01-01', '2025-12-31', false, [5, 19]],
  [45, R2A, ORG_A, 'EXPIRED', '2024-01-01', null, false, [6]],
  [46, RXA, ORG_B, 'ACTIVE', '2026-01-01', null, false, [12]],
  [47, R2A, ORG_A, 'ACTIVE', '2025-02-01', null, true, [13]],
  [48, R1B, ORG_A, 'TERMINATED', '2024-05-01', '2024-12-31', false, [14, 20]],
];

const lit = (v: unknown) => v === null ? 'NULL' : typeof v === 'boolean' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;

beforeAll(async () => {
  await db.exec(`
CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
CREATE SCHEMA auth; CREATE SCHEMA app_private;
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
CREATE TABLE public.test_grants(uid uuid, perm text, target uuid);
CREATE SEQUENCE public.test_building_checks;
CREATE TYPE public.customer_status_v2 AS ENUM ('RENTING','MOVED_OUT','WALK_IN');
CREATE TABLE public.customers(id uuid PRIMARY KEY, organization_id uuid, user_id uuid, customer_type text NOT NULL DEFAULT 'INDIVIDUAL',
  full_name text NOT NULL, phone text, email text, id_number text, is_foreign boolean NOT NULL DEFAULT false,
  status_v2 public.customer_status_v2 DEFAULT 'WALK_IN', detailed_address text, id_images jsonb, date_of_birth date,
  created_at timestamptz NOT NULL, updated_at timestamptz, deleted_at timestamptz);
CREATE TABLE public.profiles(id uuid PRIMARY KEY, full_name text);
CREATE TABLE public.buildings(id uuid PRIMARY KEY, organization_id uuid, user_id uuid, name text, deleted_at timestamptz);
CREATE TABLE public.rooms(id uuid PRIMARY KEY, building_id uuid, organization_id uuid, name text, deleted_at timestamptz);
CREATE TABLE public.contracts(id uuid PRIMARY KEY, organization_id uuid, room_id uuid, user_id uuid, status text, contract_number text,
  start_date date, end_date date, actual_end_date date, created_at timestamptz DEFAULT now(), deleted_at timestamptz, notes text,
  signed_date date, parent_contract_id uuid);
CREATE TABLE public.contract_customers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contract_id uuid REFERENCES public.contracts(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES public.customers(id), organization_id uuid, is_representative boolean DEFAULT false, notes text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), UNIQUE(contract_id, customer_id));
CREATE TABLE public.contract_draft_signings(id uuid PRIMARY KEY, organization_id uuid, contract_id uuid, party_snapshot jsonb, received_on date, signed_at timestamptz, signed_by uuid);
CREATE TABLE public.contract_exit_cases(id uuid PRIMARY KEY, organization_id uuid, contract_id uuid, party_snapshot jsonb, actual_move_out_on date, initial_kind text, return_note text, physical_actor uuid, created_at timestamptz DEFAULT now());
CREATE TABLE public.contract_terminations(id uuid PRIMARY KEY, contract_id uuid, actual_move_out_date date, termination_type text, status text, notes text, approved_by uuid, created_at timestamptz DEFAULT now());
CREATE TABLE public.contract_transfers(id uuid PRIMARY KEY, contract_id uuid, transfer_type text, status text, transfer_date date, old_room_id uuid, new_room_id uuid, reason text, approved_by uuid, created_at timestamptz DEFAULT now(), approved_at timestamptz, move_out_date date, move_in_date date);
CREATE TABLE public.contract_extensions(id uuid PRIMARY KEY, contract_id uuid, status text, extension_date date, notes text, approved_by uuid, created_at timestamptz DEFAULT now(), extension_type text, new_contract_id uuid);

CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COALESCE(array_agg(target), '{}') FROM public.test_grants WHERE uid = auth.uid() AND perm = 'member' $$;
CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (SELECT 1 FROM public.test_grants WHERE uid = auth.uid() AND perm = 'super') $$;
CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT public.is_super_admin() $$;
CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT ARRAY['${SANDBOX}'::uuid] $$;
CREATE FUNCTION public.demo_user_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT ARRAY['${DEMO}'::uuid] $$;
CREATE FUNCTION public.demo_building_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT '{}'::uuid[] $$;
CREATE FUNCTION public.can_access_org_entity(text, text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT public.is_super_admin() OR EXISTS (SELECT 1 FROM public.test_grants WHERE uid = auth.uid() AND perm = $1 || '.' || $2) $$;
CREATE FUNCTION public.current_visible_owner_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COALESCE(array_agg(DISTINCT g.uid), '{}') FROM public.test_grants g WHERE g.perm = 'member' AND g.target = ANY (public.my_org_ids()) $$;
CREATE FUNCTION public.has_full_building_scope() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT public.is_super_admin() $$;
CREATE FUNCTION public.accessible_building_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT target FROM public.test_grants WHERE uid = auth.uid() AND perm = 'buildings.view' $$;
CREATE FUNCTION public.accessible_room_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT r.id FROM public.rooms r WHERE r.building_id IN (SELECT public.accessible_building_ids()) $$;
CREATE FUNCTION public.accessible_contract_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT c.id FROM public.contracts c JOIN public.rooms r ON r.id = c.room_id WHERE r.building_id IN (SELECT public.accessible_building_ids()) $$;
-- Đếm số lần kiểm quyền toà (residence_scope_v1 → can_access_building).
CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER AS $$
BEGIN PERFORM nextval('public.test_building_checks');
  RETURN public.is_super_admin() OR EXISTS (SELECT 1 FROM public.test_grants WHERE uid = auth.uid() AND perm = 'buildings.view' AND target = $1);
END $$;
CREATE FUNCTION public.can_do_on_building(text, text, uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT public.is_super_admin() OR EXISTS (SELECT 1 FROM public.test_grants WHERE uid = auth.uid() AND perm = $1 || '.' || $2 AND target = $3) $$;
CREATE FUNCTION public.org_today_v1(uuid) RETURNS date LANGUAGE sql AS $$ SELECT '2026-10-17'::date $$;
CREATE FUNCTION public.ie_all_buildings_scope(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.buildings ENABLE ROW LEVEL SECURITY;
CREATE POLICY customers_select_rbac ON public.customers FOR SELECT USING ((SELECT can_access_org_entity('customers', 'view')) AND user_id IN (SELECT unnest(current_visible_owner_ids())));
CREATE POLICY customers_super_admin_all ON public.customers FOR ALL TO authenticated USING ((SELECT is_super_admin()));
CREATE POLICY customers_hide_demo_admin ON public.customers AS RESTRICTIVE FOR SELECT TO authenticated USING (NOT ((SELECT ((SELECT is_super_admin()) OR (SELECT is_admin()))) AND user_id IN (SELECT unnest(demo_user_ids()))));
CREATE POLICY customers_hide_sandbox_admin ON public.customers AS RESTRICTIVE FOR SELECT TO authenticated USING (NOT ((SELECT is_super_admin()) AND COALESCE(organization_id = ANY (sandbox_org_ids()), false)));
CREATE POLICY customers_org_boundary ON public.customers AS RESTRICTIVE FOR ALL TO authenticated USING (organization_id IS NULL OR (SELECT is_super_admin()) OR organization_id IN (SELECT unnest(my_org_ids())));
CREATE POLICY contract_customers_select_rbac ON public.contract_customers FOR SELECT USING ((SELECT has_full_building_scope()) OR contract_id IN (SELECT accessible_contract_ids()));
CREATE POLICY contract_customers_super_admin_all ON public.contract_customers FOR ALL TO authenticated USING ((SELECT is_super_admin()));
CREATE POLICY contract_customers_hide_sandbox_admin ON public.contract_customers AS RESTRICTIVE FOR SELECT TO authenticated USING (NOT ((SELECT is_super_admin()) AND COALESCE(organization_id = ANY (sandbox_org_ids()), false)));
CREATE POLICY contract_customers_org_boundary ON public.contract_customers AS RESTRICTIVE FOR ALL TO authenticated USING (organization_id IS NULL OR (SELECT is_super_admin()) OR organization_id IN (SELECT unnest(my_org_ids())));
CREATE POLICY contracts_select_rbac ON public.contracts FOR SELECT USING ((SELECT is_super_admin()) OR (SELECT is_admin()) OR (room_id IS NOT NULL AND ((SELECT has_full_building_scope()) OR room_id IN (SELECT accessible_room_ids()))));
CREATE POLICY contracts_super_admin_all ON public.contracts FOR ALL TO authenticated USING ((SELECT is_super_admin()));
CREATE POLICY contracts_hide_demo_admin ON public.contracts AS RESTRICTIVE FOR SELECT TO authenticated USING (NOT ((SELECT ((SELECT is_super_admin()) OR (SELECT is_admin()))) AND user_id IN (SELECT unnest(demo_user_ids()))));
CREATE POLICY contracts_hide_sandbox_admin ON public.contracts AS RESTRICTIVE FOR SELECT TO authenticated USING (NOT ((SELECT is_super_admin()) AND COALESCE(organization_id = ANY (sandbox_org_ids()), false)));
CREATE POLICY contracts_org_boundary ON public.contracts AS RESTRICTIVE FOR ALL TO authenticated USING (organization_id IS NULL OR (SELECT is_super_admin()) OR organization_id IN (SELECT unnest(my_org_ids())));
CREATE POLICY rooms_select_rbac ON public.rooms FOR SELECT USING ((SELECT has_full_building_scope()) OR building_id IN (SELECT accessible_building_ids()));
CREATE POLICY rooms_super_admin_all ON public.rooms FOR ALL TO authenticated USING ((SELECT is_super_admin()));
CREATE POLICY rooms_hide_demo_admin ON public.rooms AS RESTRICTIVE FOR SELECT TO authenticated USING (NOT ((SELECT ((SELECT is_super_admin()) OR (SELECT is_admin()))) AND building_id IN (SELECT unnest(demo_building_ids()))));
CREATE POLICY rooms_hide_sandbox_admin ON public.rooms AS RESTRICTIVE FOR SELECT TO authenticated USING (NOT ((SELECT is_super_admin()) AND COALESCE(organization_id = ANY (sandbox_org_ids()), false)));
CREATE POLICY rooms_org_boundary ON public.rooms AS RESTRICTIVE FOR ALL TO authenticated USING (organization_id IS NULL OR (SELECT is_super_admin()) OR organization_id IN (SELECT unnest(my_org_ids())));
CREATE POLICY buildings_select_rbac ON public.buildings FOR SELECT USING ((SELECT has_full_building_scope()) OR id IN (SELECT accessible_building_ids()));
CREATE POLICY buildings_super_admin_all ON public.buildings FOR ALL TO authenticated USING ((SELECT is_super_admin()));
CREATE POLICY buildings_hide_demo_admin ON public.buildings AS RESTRICTIVE FOR SELECT TO authenticated USING (NOT ((SELECT ((SELECT is_super_admin()) OR (SELECT is_admin()))) AND user_id IN (SELECT unnest(demo_user_ids()))));
CREATE POLICY buildings_hide_sandbox_admin ON public.buildings AS RESTRICTIVE FOR SELECT TO authenticated USING (NOT ((SELECT is_super_admin()) AND COALESCE(organization_id = ANY (sandbox_org_ids()), false)));
CREATE POLICY buildings_org_boundary ON public.buildings AS RESTRICTIVE FOR ALL TO authenticated USING (organization_id IS NULL OR (SELECT is_super_admin()) OR organization_id IN (SELECT unnest(my_org_ids())));
GRANT SELECT ON public.customers, public.contract_customers, public.contracts, public.rooms, public.buildings TO authenticated;
`);
  const values = (rows: unknown[][]) => rows.map(r => `(${r.map(lit).join(',')})`).join(',');
  await db.exec(`
INSERT INTO public.test_grants(uid, perm, target) VALUES ${values(grants)};
INSERT INTO public.buildings(id, organization_id, user_id, name) VALUES ${values([[B1, ORG_A, OWNER, 'Toà Một'], [B2, ORG_A, OWNER, 'Toà Hai'], [B3, ORG_A, OWNER, ''], [BX, ORG_B, OTHER, 'Toà B']])};
INSERT INTO public.rooms(id, building_id, organization_id, name) VALUES ${values([[R1A, B1, ORG_A, '101'], [R1B, B1, ORG_A, '102'], [R2A, B2, ORG_A, '201'], [R3A, B3, ORG_A, ''], [RXA, BX, ORG_B, 'X1']])};
INSERT INTO public.customers(id, organization_id, user_id, full_name, customer_type, is_foreign, phone, email, id_number, deleted_at, created_at) VALUES ${values(customers.map(([n, org, owner, name, type, foreign, phone, email, idn, deleted]) =>
    [C(n), org, owner, name, type, foreign, phone, email, idn, deleted ? '2026-10-01T00:00:00Z' : null, new Date(Date.UTC(2026, 8, 1, 0, n)).toISOString()]))};
INSERT INTO public.contracts(id, room_id, organization_id, user_id, status, start_date, end_date, actual_end_date, deleted_at, created_at) VALUES ${values(contracts.map(([n, room, org, status, start, end, deleted]) =>
    [id(n), room, org, OWNER, status, start, '2027-01-01', end, deleted ? '2026-10-01T00:00:00Z' : null, `${start}T00:00:00Z`]))};
INSERT INTO public.contract_customers(contract_id, customer_id, organization_id, created_at) VALUES ${values(contracts.flatMap(([n, , org, , start, , , members]) =>
    members.map(m => [id(n), C(m), org, `${start}T00:00:00Z`])))};
`);
  const segment = readFileSync('supabase/migrations/20260921085952_restore_before_contract_settlement.sql', 'utf8');
  const start = segment.indexOf('CREATE OR REPLACE FUNCTION public.get_room_residence_segments_v1(');
  await db.exec(segment.slice(start, segment.indexOf('$function$\n;', start) + '$function$\n;'.length));
  for (const file of ['supabase/migrations/20261007064802_customer_residence_history.sql', 'supabase/migrations/20261007160000_customer_residence_evidence.sql']) {
    await db.exec(readFileSync(file, 'utf8'));
  }
  // Hai lượt: migration phải idempotent.
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  await db.exec(`UPDATE public.customers SET status_v2 = 'WALK_IN' WHERE id IN ('${C(7)}', '${C(9)}', '${C(11)}');
    UPDATE public.customers SET status_v2 = 'MOVED_OUT' WHERE id IN ('${C(14)}', '${C(20)}');`);
}, 60_000);
afterAll(() => db.close());
beforeEach(() => db.exec('BEGIN'));
afterEach(() => db.exec('ROLLBACK'));

async function as(uid: string | null) {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('test.uid', $1, true)", [uid ?? '']);
  await db.exec('SET LOCAL ROLE authenticated');
}

type Outcome<T> = { ok: true; value: T; code?: undefined } | { ok: false; code: string; value?: undefined };
async function attempt<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  await db.exec('SAVEPOINT attempt');
  try {
    const value = await run();
    await db.exec('RELEASE SAVEPOINT attempt');
    return { ok: true, value };
  } catch (error) {
    await db.exec('ROLLBACK TO SAVEPOINT attempt');
    return { ok: false, code: String((error as { code?: string }).code) };
  }
}

type Args = { status?: string | null; kind?: string | null; search?: string | null; buildings?: string[] | null; room?: string | null;
  limit?: number | null; offset?: number | null; location?: boolean | null };
async function list(org: string, a: Args = {}): Promise<ListResult> {
  const r = await db.query<{ v: ListResult }>('SELECT public.customer_list_v1($1, $2, $3, $4, $5::uuid[], $6, $7, $8, $9) v',
    [org, a.status ?? null, a.kind ?? null, a.search ?? null, a.buildings ?? null, a.room ?? null, a.limit ?? null,
      a.offset === undefined ? 0 : a.offset, a.location === undefined ? true : a.location]);
  return r.rows[0].v;
}

/** Hai regex mà trình duyệt gửi cho PostgREST (imatch = ~*), bóc ra từ chính customerSearchFilter. */
function webPatterns(search: string): [string, string] {
  const match = /^full_name\.imatch\.(".*"),phone\.imatch\.(".*"),email\.imatch\.\2,id_number\.imatch\.\2$/su.exec(customerSearchFilter(search));
  if (!match) throw new Error(`unexpected filter for ${search}`);
  return [JSON.parse(match[1]) as string, JSON.parse(match[2]) as string];
}

async function oldLocationIds(org: string, building: string | null, room: string | null, history: boolean) {
  const ids: string[] = [];
  let after: string | null = null;
  for (;;) {
    const page: string[] = (await db.query<{ v: string[] }>('SELECT public.get_customer_residence_location_ids_v1($1, $2, $3, $4, $5, 500) v',
      [org, building, room, history, after])).rows[0].v;
    ids.push(...page);
    if (page.length < 500) return ids;
    after = page[page.length - 1];
  }
}

/** Đường web cũ (useCustomers trước 17/10) chạy bằng SQL dưới cùng RLS. */
async function webList(uid: string, org: string, f: Filters, page?: Page, includeLocation = true) {
  await as(uid);
  const search = f.search?.trim();
  let ids: string[] | null = null;
  if (f.building_id || f.room_id) {
    ids = await oldLocationIds(org, f.building_id ?? null, f.room_id ?? null, f.status !== 'RENTING');
    if (ids.length === 0) return { rows: [] as Row[], total: 0, locations: new Map<string, Location[]>() };
  }
  const params: unknown[] = [org];
  const where = ['deleted_at IS NULL', 'organization_id = $1'];
  const add = (sql: string, value: unknown) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
  if (f.status) add('status_v2::text = ?', f.status);
  if (f.statFilter === 'INDIVIDUAL' || f.statFilter === 'ORGANIZATION') add('customer_type = ?', f.statFilter);
  if (f.statFilter === 'FOREIGN') where.push('is_foreign = true');
  if (search) {
    const [name, literal] = webPatterns(search);
    params.push(name, literal);
    const n = params.length;
    where.push(`(full_name ~* $${n - 1} OR phone ~* $${n} OR email ~* $${n} OR id_number ~* $${n})`);
  }
  if (ids) add('id = ANY (?::uuid[])', ids);
  const range = page ? ` OFFSET ${(page.page - 1) * page.pageSize} LIMIT ${page.pageSize}` : '';
  const rows = (await db.query<{ j: Row }>(`SELECT to_jsonb(c) j FROM public.customers c WHERE ${where.join(' AND ')} ORDER BY created_at DESC${range}`, params)).rows.map(r => r.j);
  const total = page ? (await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.customers c WHERE ${where.join(' AND ')}`, params)).rows[0].n : rows.length;
  const locations = new Map<string, Location[]>();
  if (includeLocation && rows.length) {
    const links = (await db.query<{ customer_id: string; status: string | null; rn: string | null; bid: string | null; bn: string | null }>(
      `SELECT cc.customer_id, c.status, r.name rn, b.id bid, b.name bn FROM public.contract_customers cc
       LEFT JOIN public.contracts c ON c.id = cc.contract_id LEFT JOIN public.rooms r ON r.id = c.room_id
       LEFT JOIN public.buildings b ON b.id = r.building_id WHERE cc.customer_id = ANY ($1::uuid[])`, [rows.map(r => r.id)])).rows;
    // Vòng lặp cũ lấy liên kết hợp lệ ĐẦU TIÊN theo thứ tự trả về (không order) ⇒ mọi ứng viên đều là "web".
    for (const l of links) {
      if (l.status !== 'ACTIVE' || (!l.bid && !l.bn && !l.rn)) continue;
      locations.set(l.customer_id, [...(locations.get(l.customer_id) ?? []), { bid: l.bid || null, bn: l.bn || null, rn: l.rn || null }]);
    }
  }
  return { rows, total, locations };
}

async function webStats(uid: string, org: string, f: Filters): Promise<Stats> {
  await as(uid);
  const search = f.search?.trim();
  if (!search) {
    return (await db.query<{ v: Stats }>('SELECT public.get_customer_stats($1, NULL, $2, $3) v', [f.status ?? null, f.building_id ?? null, f.room_id ?? null])).rows[0].v;
  }
  let ids: string[] | null = null;
  if (f.building_id || f.room_id) {
    ids = await oldLocationIds(org, f.building_id ?? null, f.room_id ?? null, f.status !== 'RENTING');
    if (ids.length === 0) return { total: 0, individual: 0, organization: 0, foreign: 0 };
  }
  const [name, literal] = webPatterns(search);
  const count = async (extra: string) => (await db.query<{ n: number }>(
    `SELECT count(*)::int n FROM public.customers WHERE deleted_at IS NULL AND organization_id = $1
       AND (full_name ~* $2 OR phone ~* $3 OR email ~* $3 OR id_number ~* $3)
       AND ($4::text IS NULL OR status_v2::text = $4) AND ($5::uuid[] IS NULL OR id = ANY ($5)) ${extra}`,
    [org, name, literal, f.status ?? null, ids])).rows[0].n;
  return { total: await count(''), individual: await count("AND customer_type = 'INDIVIDUAL'"),
    organization: await count("AND customer_type = 'ORGANIZATION'"), foreign: await count('AND is_foreign = true') };
}

function argsOf(f: Filters, page?: Page, includeLocation = true): Args {
  return { status: f.status ?? null, kind: f.statFilter ?? null, search: f.search ?? null,
    buildings: f.building_id ? [f.building_id] : null, room: f.room_id ?? null,
    limit: page ? page.pageSize : null, offset: page ? (page.page - 1) * page.pageSize : 0, location: includeLocation };
}

const LOCATION_KEYS = ['current_building_id', 'current_building_name', 'current_room_name'];
async function expectParity(uid: string, org: string, f: Filters, page?: Page, includeLocation = true) {
  const web = await attempt(() => webList(uid, org, f, page, includeLocation));
  await as(uid);
  const next = await attempt(() => list(org, argsOf(f, page, includeLocation)));
  const label = JSON.stringify({ uid, org, f, page, includeLocation });
  if (!web.ok || !next.ok) {
    expect(next.ok ? 'ok' : next.code, label).toBe(web.ok ? 'ok' : web.code);
    return null;
  }
  expect(next.value.total, label).toBe(web.value.total);
  expect(next.value.rows.map(r => r.id), label).toEqual(web.value.rows.map(r => r.id));
  next.value.rows.forEach((row, i) => {
    const plain = Object.fromEntries(Object.entries(row).filter(([k]) => !LOCATION_KEYS.includes(k)));
    expect(plain, label).toEqual(web.value.rows[i]);
    if (!includeLocation) {
      expect(LOCATION_KEYS.some(k => k in row), label).toBe(false);
      return;
    }
    const got: Location = { bid: row.current_building_id as string | null, bn: row.current_building_name as string | null, rn: row.current_room_name as string | null };
    const candidates = web.value.locations.get(row.id) ?? [];
    if (candidates.length === 0) expect(got, label).toEqual({ bid: null, bn: null, rn: null });
    else expect(candidates, label).toContainEqual(got);
  });
  return next.value;
}

const USERS = [OWNER, STAFF, NOVIEW, OTHER, SUPER];
const STATUSES = [undefined, 'RENTING', 'MOVED_OUT', 'WALK_IN'];
const KINDS = [undefined, 'ALL', 'INDIVIDUAL', 'ORGANIZATION', 'FOREIGN'];
const SEARCHES = [undefined, '  ', 'an', 'nguyen', 'nguyễn', 'NGUYỄN', 'Nguyen Nhat An', 'dang', 'đặng', 'dung', 'dong a', 'duong',
  'hoa', 'duc', '0901', '0901 234', '+84.90*1', '(test)', '[x]', 'binh@example', 'duc+1', '079.123', 'é', 'khach 1', 'zzz'];
const LOCATIONS: Array<Pick<Filters, 'building_id' | 'room_id'>> = [{}, { building_id: B1 }, { building_id: B1, room_id: R1A },
  { building_id: B2 }, { building_id: B3 }, { building_id: BX }, { room_id: R1B }, { building_id: id(999) }];
const PAGES: Array<Page | undefined> = [undefined, { page: 1, pageSize: 3 }, { page: 2, pageSize: 3 }, { page: 9, pageSize: 3 }];

/** PRNG tất định để lấy mẫu tổ hợp lặp lại được. */
function rng(seed: number) {
  let s = seed >>> 0;
  return <T>(items: readonly T[]): T => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return items[s % items.length];
  };
}

describe('customer_list_v1 khớp đường web cũ', () => {
  it('mọi người dùng × trạng thái × toà/phòng, trang 1 và trang 2', async () => {
    let nonEmpty = 0;
    for (const uid of USERS) for (const status of STATUSES) for (const loc of LOCATIONS) for (const page of [undefined, { page: 2, pageSize: 2 }]) {
      const result = await expectParity(uid, uid === OTHER ? ORG_B : ORG_A, { status, ...loc }, page);
      if (result && result.total > 0) nonEmpty += 1;
    }
    expect(nonEmpty).toBeGreaterThan(40);
  }, 60_000);

  it('tìm không dấu: mọi từ khoá × người dùng, thẻ "Tất cả" và "Nước ngoài"', async () => {
    let matched = 0;
    for (const uid of [OWNER, STAFF, OTHER, SUPER]) for (const search of SEARCHES) for (const statFilter of ['ALL', 'FOREIGN']) {
      const result = await expectParity(uid, uid === OTHER ? ORG_B : ORG_A, { search, statFilter });
      if (result && search?.trim() && result.total > 0) matched += 1;
    }
    expect(matched).toBeGreaterThan(30);
  }, 60_000);

  it('150 tổ hợp lấy mẫu gồm cả công ty khác, mọi loại thẻ, phân trang và bỏ chuỗi toà', async () => {
    const pick = rng(17102026);
    for (let i = 0; i < 150; i += 1) {
      const uid = pick(USERS);
      await expectParity(uid, pick([ORG_A, ORG_A, ORG_B, SANDBOX]), {
        status: pick(STATUSES), statFilter: pick(KINDS), search: pick(SEARCHES), ...pick(LOCATIONS),
      }, pick(PAGES), pick([true, true, false]));
    }
  }, 120_000);

  it('thống kê trùng get_customer_stats/4 count của web cho người một công ty', async () => {
    const pick = rng(4242);
    for (let i = 0; i < 80; i += 1) {
      const uid = pick([OWNER, STAFF, NOVIEW, OTHER]);
      const org = uid === OTHER ? ORG_B : ORG_A;
      const f: Filters = { status: pick(STATUSES), search: pick(SEARCHES), ...pick(LOCATIONS) };
      const web = await attempt(() => webStats(uid, org, f));
      await as(uid);
      const next = await attempt(() => list(org, { ...argsOf(f), kind: pick(KINDS), limit: 0 }));
      expect(next.ok ? next.value.stats : next.code, JSON.stringify({ uid, f })).toEqual(web.ok ? web.value : web.code);
    }
  }, 60_000);

  it('khác biệt có chủ đích: super admin nhiều công ty — stats theo đúng công ty đang chọn', async () => {
    await as(SUPER);
    const crossOrg = (await db.query<{ v: Stats }>('SELECT public.get_customer_stats(NULL, NULL, NULL, NULL) v')).rows[0].v;
    const next = await list(ORG_A, { limit: 0 });
    const rows = await list(ORG_A, {});
    expect(next.stats.total).toBe(rows.total);
    expect(crossOrg.total).toBe(rows.total + 1); // get_customer_stats không lọc công ty: đếm cả khách Org B.
  });
});

describe('quyền và phạm vi', () => {
  it('đúng tập dòng theo RLS: chủ hồ sơ ngoài công ty, đã xoá, demo, sandbox, không có customers.view', async () => {
    await as(OWNER);
    const owner = await list(ORG_A);
    expect(owner.rows.map(r => r.id)).not.toContain(C(9));
    expect(owner.rows.map(r => r.id)).not.toContain(C(10));
    expect(owner.rows.map(r => r.id)).toContain(C(11));
    expect(owner.total).toBe(16);
    await as(SUPER);
    const sup = await list(ORG_A);
    expect(sup.rows.map(r => r.id)).toContain(C(9));
    expect(sup.rows.map(r => r.id)).not.toContain(C(11));
    expect((await list(SANDBOX)).total).toBe(0);
    await as(NOVIEW);
    expect(await list(ORG_A)).toEqual({ total: 0, stats: { total: 0, individual: 0, organization: 0, foreign: 0 }, rows: [] });
    await as(OTHER);
    expect((await list(ORG_A)).total).toBe(0);
    expect((await attempt(() => list(ORG_A, { buildings: [B1] }))).ok).toBe(false);
  });

  it('p_building_ids chỉ thu hẹp: tập con của không lọc, bằng hợp các toà cũ, toà ngoài phạm vi không thêm gì', async () => {
    const pick = rng(99);
    const pool = [B1, B2, B3, BX, id(998)];
    for (const uid of [OWNER, STAFF, SUPER]) {
      for (let i = 0; i < 12; i += 1) {
        const status = pick(STATUSES);
        const subset = pool.filter(() => pick([true, false]));
        await as(uid);
        const all = new Set((await list(ORG_A, { status })).rows.map(r => r.id));
        const narrowed = (await list(ORG_A, { status, buildings: subset })).rows.map(r => r.id);
        for (const c of narrowed) expect(all.has(c)).toBe(true);
        const union = new Set<string>();
        for (const b of subset) for (const c of await oldLocationIds(ORG_A, b, null, status !== 'RENTING')) union.add(c);
        expect(new Set(narrowed)).toEqual(new Set([...all].filter(c => union.has(c))));
      }
    }
    await as(STAFF);
    expect((await list(ORG_A, { buildings: [B2] })).total).toBe(0);
    await as(OWNER);
    expect((await list(ORG_A, { buildings: [B2] })).total).toBeGreaterThan(0);
    expect((await list(ORG_A, { buildings: [] })).total).toBe(0);
  }, 60_000);

  it('kiểm quyền toà MỘT lần mỗi toà, không theo dòng như hàm cũ', async () => {
    const checks = async (run: () => Promise<unknown>) => {
      await db.exec('RESET ROLE');
      await db.query("SELECT setval('public.test_building_checks', 1, false)");
      await as(OWNER);
      await run();
      await db.exec('RESET ROLE');
      const r = (await db.query<{ last_value: number; is_called: boolean }>('SELECT last_value, is_called FROM public.test_building_checks')).rows[0];
      return r.is_called ? Number(r.last_value) : 0;
    };
    const fresh = await checks(() => list(ORG_A, { status: 'MOVED_OUT', buildings: [B1] }));
    const old = await checks(() => oldLocationIds(ORG_A, B1, null, true));
    expect(fresh).toBe(1);
    expect(old).toBeGreaterThan(3);
    expect(await checks(() => list(ORG_A, { buildings: [B1, B2, B3] }))).toBe(3);
    expect(await checks(() => list(ORG_A, { search: 'an' }))).toBe(0);
  });

  it('chỉ chạy bằng JWT người dùng: anon, thiếu uid, gọi từ thân hàm DEFINER đều bị chặn', async () => {
    await db.exec('RESET ROLE');
    await db.exec(`CREATE FUNCTION public.test_definer_wrapper(uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$ SELECT public.customer_list_v1($1) $$;
      GRANT EXECUTE ON FUNCTION public.test_definer_wrapper(uuid) TO authenticated`);
    await as(OWNER);
    expect(await attempt(() => db.query('SELECT public.test_definer_wrapper($1)', [ORG_A]))).toMatchObject({ ok: false, code: '42501' });
    await as(null);
    expect(await attempt(() => list(ORG_A))).toMatchObject({ ok: false, code: '42501' });
    await db.exec('RESET ROLE');
    await db.exec('SET LOCAL ROLE anon');
    expect(await attempt(() => list(ORG_A))).toMatchObject({ ok: false, code: '42501' });
    await db.exec('RESET ROLE');
    expect(await attempt(() => list(ORG_A))).toMatchObject({ ok: false, code: '42501' });
  });

  it('tham số sai báo 22023 thay vì trả rỗng', async () => {
    await as(OWNER);
    for (const bad of [{ status: 'ACTIVE' }, { kind: 'VIP' }, { limit: -1 }, { offset: -1 }, { offset: null },
      { location: null }, { buildings: [B1, null as unknown as string] }] as Args[]) {
      expect(await attempt(() => list(ORG_A, bad)), JSON.stringify(bad)).toMatchObject({ ok: false, code: '22023' });
    }
    expect(await attempt(() => db.query('SELECT public.customer_list_v1(NULL)'))).toMatchObject({ ok: false, code: '22023' });
  });
});

describe('sắp xếp, phân trang, toà hiện tại', () => {
  it('ghép các trang bằng đúng danh sách đầy đủ; trang ngoài cùng rỗng nhưng vẫn có tổng', async () => {
    await as(OWNER);
    const full = await list(ORG_A);
    const pages: string[] = [];
    for (let offset = 0; offset < full.total; offset += 4) {
      const page = await list(ORG_A, { limit: 4, offset });
      expect(page.total).toBe(full.total);
      pages.push(...page.rows.map(r => r.id));
    }
    expect(pages).toEqual(full.rows.map(r => r.id));
    expect(await list(ORG_A, { limit: 4, offset: 400 })).toMatchObject({ total: full.total, rows: [] });
  });

  it('trùng created_at: thứ tự xác định theo id giảm dần, không lặp/sót giữa các trang', async () => {
    await db.exec('RESET ROLE');
    await db.exec(`UPDATE public.customers SET created_at = '2026-09-01T00:00:00Z' WHERE organization_id = '${ORG_A}'`);
    await as(OWNER);
    const full = await list(ORG_A);
    expect(full.rows.map(r => r.id)).toEqual([...full.rows.map(r => r.id)].sort().reverse());
    const paged = [...(await list(ORG_A, { limit: 5 })).rows, ...(await list(ORG_A, { limit: 5, offset: 5 })).rows,
      ...(await list(ORG_A, { limit: 50, offset: 10 })).rows].map(r => r.id);
    expect(paged).toEqual(full.rows.map(r => r.id));
  });

  it('toà hiện tại: HĐ ACTIVE thấy được qua RLS; nhiều HĐ lấy HĐ bắt đầu muộn nhất; tên rỗng thành null', async () => {
    await as(OWNER);
    const byId = new Map((await list(ORG_A)).rows.map(r => [r.id, r]));
    expect(byId.get(C(8))).toMatchObject({ current_building_id: B1, current_room_name: '101' });
    expect(byId.get(C(4))).toMatchObject({ current_building_id: B3, current_building_name: null, current_room_name: null });
    expect(byId.get(C(13))).toMatchObject({ current_building_id: B2, current_room_name: '201' });
    expect(byId.get(C(6))).toMatchObject({ current_building_id: null });
    await as(STAFF);
    const staff = new Map((await list(ORG_A)).rows.map(r => [r.id, r]));
    expect(staff.get(C(4))).toMatchObject({ current_building_id: null });
    expect(staff.get(C(3))).toMatchObject({ current_building_id: B2 });
  });
});

describe('customer_search_patterns_v1 = customerSearchFilter', () => {
  const groups = ['aàáạảãâầấậẩẫăằắặẳẵ', 'eèéẹẻẽêềếệểễ', 'iìíịỉĩ', 'oòóọỏõôồốộổỗơờớợởỡ', 'uùúụủũưừứựửữ', 'yỳýỵỷỹ', 'dđ'];
  const letters = groups.flatMap(g => Array.from(g));
  const corpus = [...letters, ...letters.map(l => l.toUpperCase()), letters.join(''), letters.join('').toUpperCase(),
    'Nguyễn Văn An', 'NGUYỄN'.normalize('NFD'), 'é', '  nguyen　﻿', '\tan\n', '.*+?^${}()|[]\\', 'a-b_c/d',
    '"quoted", phone.imatch.x', "o'neil", '0901 234 567', 'duc+1@example.test', 'X Æ'.toLowerCase(), '12%_'];

  it('cùng regex tên và chuỗi thô cho mọi chữ Việt hoa/thường, NFD, khoảng trắng JS và ký tự đặc biệt', async () => {
    for (const s of corpus) {
      const sql = (await db.query<{ v: string[] | null }>('SELECT public.customer_search_patterns_v1($1) v', [s])).rows[0].v;
      const trimmed = s.trim();
      expect(sql, JSON.stringify(s)).toEqual(trimmed ? webPatterns(trimmed) : null);
    }
    for (const empty of [null, '', ' ', ' 　﻿']) {
      expect((await db.query<{ v: string[] | null }>('SELECT public.customer_search_patterns_v1($1) v', [empty])).rows[0].v).toBeNull();
    }
  });

  it('tìm không dấu tìm được tên có dấu, kể cả tên lưu dạng NFD', async () => {
    await as(OWNER);
    const names = async (search: string) => (await list(ORG_A, { search })).rows.map(r => String(r.full_name).normalize('NFC'));
    expect(await names('nguyen van an')).toEqual(['Nguyễn Văn An']);
    expect(await names('quoc dung')).toEqual(['Đặng Quốc Dũng']);
    expect(await names('dong a')).toEqual(['Công ty TNHH đông á']);
    expect(await names('THUY DUONG')).toEqual(['đỗ thùy dương']);
    expect(await names('le thi hoa')).toEqual(['lê thị hoa']);
    expect(await names('079.123')).toEqual(['Trần (Test) [x]']);
    expect(await names('079x123')).toEqual([]);
  });
});
