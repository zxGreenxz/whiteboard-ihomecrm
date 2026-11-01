// Lỗ 4 (18/10/2026): areas_select_rbac đọc staff_assignments (hệ cũ, ngừng đồng bộ từ 25/07) nên
// nhân viên cấp quyền qua mô hình mới thấy area_buildings mà không thấy khu (embed null), còn phân
// công cũ sót lại của người đã bị thu hẹp quyền vẫn mở mọi khu của công ty. Một PGlite cho cả file;
// mỗi ca BEGIN…ROLLBACK, RLS thật dưới SET ROLE authenticated với các policy NGUYÊN VĂN của bản sống
// (ranh giới công ty, area_buildings select + write theo staff_assignments). Ca trước dùng policy
// sống (lộ/thiếu), ca sau chạy migration vá, đột biến chứng minh các phép kiểm cắn.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const read = (path) => readFileSync(new URL(`../../supabase/${path}`, import.meta.url), 'utf8');
const FIX = read('migrations/20261018053756_areas_select_theo_bo_giai_quyen_hien_hanh.sql');
const LIVE_POLICY = read('migrations/20260710140000_rls_initplan_wrap_remaining.sql')
  .match(/ALTER POLICY areas_select_rbac ON public\.areas USING [\s\S]*?\)\)\)\)\)\)\)\)\)\);/)[0]
  .replace('FROM staff_assignments', 'FROM public.staff_assignments').replace('FROM area_buildings', 'FROM public.area_buildings');
const GD3 = read('migrations/20260808010000_gd3_rao_bang_an_toan.sql');
const BASELINE = read('baseline/schema.sql');
const policy = (sql, name) => sql.match(new RegExp(`CREATE POLICY ${name} ON [\\s\\S]*?;\\n`))[0];

const org = 'a0000000-0000-4000-8000-000000000001';
const otherOrg = 'a0000000-0000-4000-8000-000000000002';
const b1 = 'b0000000-0000-4000-8000-000000000001';
const b2 = 'b0000000-0000-4000-8000-000000000002';
const bx = 'b0000000-0000-4000-8000-0000000000ff';
const a1 = 'aa000000-0000-4000-8000-000000000001'; // chứa b1
const a2 = 'aa000000-0000-4000-8000-000000000002'; // chứa b2
const a3 = 'aa000000-0000-4000-8000-000000000003'; // chưa gắn toà
const ax = 'aa000000-0000-4000-8000-0000000000ff'; // công ty khác
const adminRole = 'ee000000-0000-4000-8000-000000000001';
const newStaff = 'c0000000-0000-4000-8000-000000000001'; // quyền từ role_bindings, không có staff_assignments
const narrowed = 'c0000000-0000-4000-8000-000000000002'; // vẫn là thành viên, còn phân công Admin toàn tổ chức cũ, nay hết quyền
const manager = 'c0000000-0000-4000-8000-000000000003'; // khoá khu toàn công ty

let db;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE public.areas(id uuid PRIMARY KEY, organization_id uuid, user_id uuid, name text, deleted_at timestamptz);
    CREATE TABLE public.area_buildings(area_id uuid, building_id uuid, organization_id uuid, user_id uuid);
    CREATE TABLE public.roles(id uuid PRIMARY KEY, name varchar, permissions jsonb);
    CREATE TABLE public.staff_assignments(staff_id uuid, building_id uuid, area_id uuid, role_id uuid, permissions jsonb);
    -- Bộ giải quyền giả, đọc từ setting: toà xem được, công ty thành viên, 'khoá@công ty' toàn công ty.
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_setting('test.super', true) = 'true' $$;
    CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT public.is_super_admin() $$;
    CREATE FUNCTION public.has_full_building_scope() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT public.is_super_admin() $$;
    CREATE FUNCTION public.accessible_building_ids() RETURNS SETOF uuid LANGUAGE sql STABLE AS $$
      SELECT unnest(coalesce(string_to_array(nullif(current_setting('test.buildings', true), ''), ',')::uuid[], '{}')) $$;
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$
      SELECT coalesce(string_to_array(nullif(current_setting('test.orgs', true), ''), ',')::uuid[], '{}') $$;
    CREATE FUNCTION app_private.authorized_scope_v3(text, uuid) RETURNS TABLE(org_wide boolean, building_ids uuid[], cashbook_ids uuid[])
      LANGUAGE sql STABLE AS $$ SELECT ($1 || '@' || $2::text) = ANY (string_to_array(coalesce(current_setting('test.org_wide', true), ''), ',')),
        '{}'::uuid[], '{}'::uuid[] $$;
    ALTER TABLE public.areas ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.area_buildings ENABLE ROW LEVEL SECURITY;
    CREATE POLICY areas_select_rbac ON public.areas FOR SELECT USING (false);
    -- Hai policy ẩn demo/sandbox chỉ chạm super admin + dữ liệu demo/sandbox; ngoài phạm vi ca này.
    CREATE POLICY areas_hide_demo_admin ON public.areas AS RESTRICTIVE FOR SELECT TO authenticated USING (true);
    CREATE POLICY areas_hide_sandbox_admin ON public.areas AS RESTRICTIVE FOR SELECT TO authenticated USING (true);
    GRANT USAGE ON SCHEMA public, auth, app_private TO authenticated;
    GRANT SELECT ON public.areas, public.area_buildings, public.staff_assignments, public.roles TO authenticated;
    INSERT INTO roles VALUES ('${adminRole}', 'Admin', '{}');
    INSERT INTO areas VALUES ('${a1}', '${org}', null, 'Khu 1', null), ('${a2}', '${org}', null, 'Khu 2', null),
      ('${a3}', '${org}', null, 'Khu trống', null), ('${ax}', '${otherOrg}', null, 'Khu công ty khác', null);
    INSERT INTO area_buildings VALUES ('${a1}', '${b1}', '${org}', null), ('${a2}', '${b2}', '${org}', null), ('${ax}', '${bx}', '${otherOrg}', null);
    INSERT INTO staff_assignments VALUES ('${narrowed}', null, null, '${adminRole}', null);`);
  // Nguyên văn bản sống: ranh giới công ty (20260808010000) và hai policy area_buildings (baseline 06/08).
  await db.exec(policy(GD3, 'areas_org_boundary'));
  await db.exec(policy(GD3, 'area_buildings_org_boundary'));
  await db.exec(policy(BASELINE, 'area_buildings_select_rbac'));
  await db.exec(policy(BASELINE, 'area_buildings_write_rbac'));
  await db.exec(LIVE_POLICY);
});
afterAll(async () => { await db?.close(); });

// Một ca = một giao dịch: danh tính + phạm vi giả, (tuỳ) thay policy, đọc như authenticated, ROLLBACK.
async function look({ user, buildings = [], orgs = [], orgWide = [], superAdmin = false, policy = null }) {
  await db.exec('BEGIN');
  try {
    if (policy) await db.exec(policy);
    await db.query(`SELECT set_config('request.jwt.claim.sub', $1, true), set_config('test.buildings', $2, true),
      set_config('test.orgs', $3, true), set_config('test.org_wide', $4, true), set_config('test.super', $5, true)`,
      [user, buildings.join(','), orgs.join(','), orgWide.join(','), String(superAdmin)]);
    await db.exec('SET LOCAL ROLE authenticated');
    const areas = (await db.query('SELECT id FROM public.areas ORDER BY id')).rows.map((r) => r.id);
    // Như embed area_links:area_buildings(area_id, area:areas(id, name)) của useBuildings.
    const embed = (await db.query(`SELECT ab.building_id, a.name FROM public.area_buildings ab
      LEFT JOIN public.areas a ON a.id = ab.area_id ORDER BY ab.building_id`)).rows;
    return { areas, embed };
  } finally { await db.exec('ROLLBACK'); }
}
const staffCase = { user: newStaff, buildings: [b1], orgs: [org] };
const narrowedCase = { user: narrowed, orgs: [org] };
const managerCase = { user: manager, buildings: [b1, b2], orgs: [org], orgWide: [`areas.view@${org}`] };

test('TRƯỚC vá: nhân viên mới thấy toà mà khu null; phân công cũ của người đã hết quyền vẫn mở mọi khu công ty', async () => {
  const staff = await look(staffCase);
  expect(staff.areas).toEqual([]);
  expect(staff.embed).toEqual([{ building_id: b1, name: null }]);
  // areas_org_boundary đã chặn khu công ty khác; lỗ là trong công ty.
  expect((await look(narrowedCase)).areas).toEqual([a1, a2, a3].sort());
});

test('migration vá chạy hai lượt (idempotent) và giữ ba policy RESTRICTIVE', async () => {
  await db.exec(FIX);
  await db.exec(FIX);
  const { rows } = await db.query(`SELECT policyname, permissive, qual FROM pg_policies WHERE tablename = 'areas' ORDER BY policyname`);
  expect(rows.map((r) => [r.policyname, r.permissive])).toEqual([
    ['areas_hide_demo_admin', 'RESTRICTIVE'], ['areas_hide_sandbox_admin', 'RESTRICTIVE'],
    ['areas_org_boundary', 'RESTRICTIVE'], ['areas_select_rbac', 'PERMISSIVE']]);
  expect(rows[3].qual).not.toContain('staff_assignments');
});

// Kỳ vọng sau vá, gom lại để đột biến dùng chung.
async function fixedHolds(policy) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const staff = await look({ ...staffCase, policy });
  const narrowedView = await look({ ...narrowedCase, policy });
  const managerView = await look({ ...managerCase, policy });
  const creator = await look({ user: manager, orgs: [org], orgWide: [`areas.create@${org}`], policy });
  const foreignWide = await look({ user: manager, orgs: [org], orgWide: [`areas.view@${otherOrg}`], policy });
  const admin = await look({ user: manager, superAdmin: true, policy });
  return same(staff.areas, [a1])
    && same(staff.embed, [{ building_id: b1, name: 'Khu 1' }])
    // Phân công cũ vẫn mở SELECT area_buildings qua area_buildings_write_rbac, nhưng không mở khu.
    && narrowedView.areas.length === 0 && narrowedView.embed.length === 2
    && same(managerView.areas, [a1, a2, a3].sort())
    // Người tạo khu đọc lại được khu vừa tạo (chưa gắn toà).
    && same(creator.areas, [a1, a2, a3].sort())
    // Khoá khu của công ty mà mình không là thành viên không mở gì.
    && foreignWide.areas.length === 0
    && same(admin.areas, [a1, a2, a3, ax].sort());
}

test('SAU vá: khu theo toà xem được qua area_buildings; khu trống cho khoá khu toàn công ty; không xuyên công ty', async () => {
  expect(await fixedHolds()).toBe(true);
});

test('đột biến: bỏ hoặc nới từng vế thì phép kiểm phải đỏ', async () => {
  const alter = FIX.match(/ALTER POLICY areas_select_rbac[\s\S]*?\n  \);/)[0];
  const mutants = {
    'bỏ nhánh theo toà': alter.replace('WHERE ab.building_id IN (SELECT public.accessible_building_ids())', 'WHERE false'),
    // Không dựa được vào RLS area_buildings: area_buildings_write_rbac (FOR ALL, staff_assignments) vẫn mở SELECT.
    'nhánh theo toà không lọc toà': alter.replace('WHERE ab.building_id IN (SELECT public.accessible_building_ids())', ''),
    'nhánh theo toà không neo khu': alter.replace('OR id IN (', 'OR EXISTS ('),
    'bỏ nhánh khoá khu': alter.replace('WHERE s.org_wide', 'WHERE false'),
    'bỏ areas.create': alter.replace(", 'areas.create'", ''),
    'khoá khu không neo công ty': alter.replace('OR organization_id IN (', "OR EXISTS (SELECT 1 FROM app_private.authorized_scope_v3('areas.view', '" + otherOrg + "'::uuid) z WHERE z.org_wide) OR organization_id IN ("),
    'quay lại staff_assignments': LIVE_POLICY,
  };
  for (const [label, mutant] of Object.entries(mutants)) {
    expect(mutant, label).not.toBe(alter);
    expect(await fixedHolds(mutant), label).toBe(false);
  }
});
