import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CONTRACT_STATUS_CONFIG, getContractDisplayStatus, type Contract } from "@/types/contract";

/**
 * Migration 20261017115636 — public.contract_list_v1: danh sách Hợp đồng dùng chung web/Hermes/báo
 * cáo. Chạy THẬT trên PostgreSQL nhúng, MỘT instance cho cả file, mỗi ca BEGIN…ROLLBACK.
 * Quyền dựng lại theo pg_policies TEST 17/10/2026 (cùng tên hàm, cùng biểu thức) để kiểm hàm
 * DEFINER ra ĐÚNG tập hàng mà RLS cho web đọc. Migration chạy HAI lượt (idempotent).
 */
const FILE = "supabase/migrations/20261017115636_contract_list_v1.sql";
const SIG = "public.contract_list_v1(text, uuid[], text, text, text, text, integer, integer, boolean)";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const ORG_A = id(1), ORG_B = id(2), SANDBOX = "cccc0000-0000-4000-8000-000000000001";
const OWNER_A = id(11), STAFF_X = id(12), STAFF_NO_CUST = id(13), STAFF_CUST_Y = id(14), OUTSIDER = id(15), SUPER = id(16), DEMO_USER = id(17), OWNER_B = id(18);
const B_X = id(21), B_Y = id(22), B_B = id(23), B_DEMO = id(24), B_SANDBOX = id(25);
const R_X1 = id(31), R_X2 = id(32), R_Y1 = id(33), R_B1 = id(34), R_DEMO = id(35), R_SANDBOX = id(36);
const CU_1 = id(41), CU_2 = id(42), CU_FOREIGN_OWNER = id(43), CU_B = id(44);
const TODAY = "2026-10-17";

const db = new PGlite();

type Row = {
  id: string; contract_number: string | null; status: string; end_date: string; display_status: string; display_label: string;
  room: { id: string; name: string; building_id: string; building: { id: string; name: string } | null } | null;
  contract_customers: { id: string; is_representative: boolean; customer: { id: string; full_name: string; phone: string } | null }[];
};
type Result = { total: number; today: string; rows: Row[] };
type Args = Partial<{ search: string; buildings: string[]; room: string; lifecycle: string; stat: string; month: string; limit: number; offset: number; withCustomers: boolean }>;

async function asUser(user: string | null) {
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [user ?? ""]);
  await db.exec("SET LOCAL ROLE authenticated");
}
async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("BEGIN");
  try { return await fn(); } finally { await db.exec("ROLLBACK"); }
}
async function list(user: string | null, a: Args = {}, today = TODAY): Promise<Result> {
  return inTx(async () => {
    await db.query("SELECT set_config('test.today',$1,true)", [today]);
    await asUser(user);
    const r = await db.query<{ v: Result }>(
      `SELECT public.contract_list_v1(p_search=>$1, p_building_ids=>$2::uuid[], p_room_name=>$3, p_lifecycle=>$4, p_stat=>$5,
         p_month=>$6, p_limit=>$7, p_offset=>$8, p_with_customers=>$9) v`,
      [a.search ?? null, a.buildings ?? null, a.room ?? null, a.lifecycle ?? "ALL", a.stat ?? "ALL", a.month ?? null,
        a.limit ?? 1000, a.offset ?? 0, a.withCustomers ?? true]);
    return r.rows[0].v;
  });
}
const nums = (r: Result) => r.rows.map((x) => x.contract_number);
async function errorCode(user: string | null, a: Args): Promise<string | undefined> {
  try { await list(user, a); return undefined; } catch (e) { return (e as { code?: string }).code; }
}

// Một hợp đồng thử: số HĐ, toà/phòng, trạng thái, ngày, khách.
type Seed = { n: string; org: string; room: string | null; status?: string; start?: string; end: string; moveOut?: string; created: string; deleted?: boolean; user?: string };
const SEEDS: Seed[] = [
  { n: "HD-X-ACT", org: ORG_A, room: R_X1, end: "2027-06-30", created: "2026-10-10 10:00:00+00" },
  { n: "HD-X-EXPIRED", org: ORG_A, room: R_X1, end: "2026-10-16", created: "2026-10-09 10:00:00+00" },
  { n: "HD-X-TODAY", org: ORG_A, room: R_X2, end: "2026-10-17", created: "2026-10-08 10:00:00+00" },
  { n: "HD-X-D30", org: ORG_A, room: R_X2, end: "2026-11-16", created: "2026-10-07 10:00:00+00" },
  { n: "HD-X-D31", org: ORG_A, room: R_X2, end: "2026-11-17", created: "2026-10-06 10:00:00+00" },
  { n: "HD-X-MOVE", org: ORG_A, room: R_X1, end: "2026-01-01", moveOut: "2026-10-20", created: "2026-10-05 10:00:00+00" },
  { n: "HD-X-TERM", org: ORG_A, room: R_X1, status: "TERMINATED", end: "2026-01-01", created: "2026-10-04 10:00:00+00" },
  { n: "HD-X-TRANS", org: ORG_A, room: R_X2, status: "TRANSFERRED", end: "2026-01-01", created: "2026-10-03 10:00:00+00" },
  { n: "HD-X-DRAFT", org: ORG_A, room: R_X2, status: "DRAFT", end: "2026-10-18", created: "2026-10-02 10:00:00+00" },
  { n: "HD-X-ENUM-EXPIRED", org: ORG_A, room: R_X1, status: "EXPIRED", end: "2027-12-31", created: "2026-10-01 10:00:00+00" },
  { n: "HD-X-DELETED", org: ORG_A, room: R_X1, end: "2027-01-01", created: "2026-10-11 10:00:00+00", deleted: true },
  { n: "HD-Y-ACT", org: ORG_A, room: R_Y1, start: "2026-09-01", end: "2026-09-30", created: "2026-09-30 10:00:00+00" },
  { n: "HD-Y-TIE-A", org: ORG_A, room: R_Y1, end: "2027-01-01", created: "2026-09-01 10:00:00+00" },
  { n: "HD-Y-TIE-B", org: ORG_A, room: R_Y1, end: "2027-01-01", created: "2026-09-01 10:00:00+00" },
  { n: "HD-B-ACT", org: ORG_B, room: R_B1, end: "2027-01-01", created: "2026-10-12 10:00:00+00" },
  { n: "HD-DEMO", org: ORG_A, room: R_DEMO, end: "2027-01-01", created: "2026-10-12 11:00:00+00", user: DEMO_USER },
  { n: "HD-SANDBOX", org: SANDBOX, room: R_SANDBOX, end: "2027-01-01", created: "2026-10-12 12:00:00+00" },
];

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role; CREATE SCHEMA auth; CREATE SCHEMA app_private;
    GRANT USAGE ON SCHEMA public, auth, app_private TO authenticated, anon;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;

    -- Dữ liệu quyền thử: thành viên, quyền theo toà (NULL = cả công ty), super admin, user demo.
    CREATE TABLE public.t_member(user_id uuid, organization_id uuid);
    CREATE TABLE public.t_perm(user_id uuid, perm text, building_id uuid);
    CREATE TABLE public.t_super(user_id uuid);
    CREATE TABLE public.t_demo(user_id uuid);

    CREATE TYPE public.contract_status AS ENUM ('DRAFT','ACTIVE','EXTENDED','TRANSFERRED','TERMINATED','EXPIRED');
    CREATE TABLE public.buildings(id uuid PRIMARY KEY, organization_id uuid, user_id uuid, name text, deleted_at timestamptz);
    CREATE TABLE public.rooms(id uuid PRIMARY KEY, organization_id uuid, building_id uuid, name text);
    CREATE TABLE public.customers(id uuid PRIMARY KEY, organization_id uuid, user_id uuid, full_name text, phone text);
    CREATE TABLE public.contracts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, user_id uuid NOT NULL, room_id uuid,
      contract_number text, status public.contract_status NOT NULL DEFAULT 'ACTIVE', start_date date NOT NULL DEFAULT '2026-01-01',
      end_date date NOT NULL, expected_move_out_date date, rent_price numeric NOT NULL DEFAULT 3500000, total_deposit numeric NOT NULL DEFAULT 0,
      deposit_paid numeric DEFAULT 0, public_code text NOT NULL DEFAULT 'ABC123', created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz);
    CREATE TABLE public.contract_customers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, contract_id uuid, customer_id uuid,
      is_representative boolean, created_at timestamptz NOT NULL DEFAULT now());

    -- Hàm quyền cùng TÊN với production, lấy từ bảng thử.
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS (SELECT 1 FROM public.t_super WHERE user_id = auth.uid()) $$;
    CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT public.is_super_admin() $$;
    CREATE FUNCTION public.has_full_building_scope() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT public.is_super_admin() $$;
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT COALESCE(array_agg(organization_id),'{}') FROM public.t_member WHERE user_id = auth.uid() $$;
    CREATE FUNCTION public.accessible_building_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$
      SELECT b.id FROM public.buildings b JOIN public.t_member m ON m.organization_id = b.organization_id AND m.user_id = auth.uid()
       WHERE b.deleted_at IS NULL AND EXISTS (SELECT 1 FROM public.t_perm p WHERE p.user_id = auth.uid() AND p.perm = 'buildings.view' AND (p.building_id IS NULL OR p.building_id = b.id)) $$;
    CREATE FUNCTION public.can_access_org_entity(_resource text, _action text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
      SELECT public.is_super_admin() OR EXISTS (SELECT 1 FROM public.t_perm p WHERE p.user_id = auth.uid() AND p.perm = _resource || '.' || _action) $$;
    CREATE FUNCTION public.current_visible_owner_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER AS $$
      SELECT COALESCE(array_agg(DISTINCT m.user_id),'{}') FROM public.t_member m WHERE m.organization_id = ANY (public.my_org_ids()) $$;
    CREATE FUNCTION public.demo_user_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT COALESCE(array_agg(user_id),'{}') FROM public.t_demo $$;
    CREATE FUNCTION public.demo_building_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT COALESCE(array_agg(id),'{}') FROM public.buildings WHERE user_id = ANY (public.demo_user_ids()) $$;
    CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT ARRAY['${SANDBOX}'::uuid] $$;
    CREATE FUNCTION public.accessible_room_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT r.id FROM public.rooms r WHERE r.building_id IN (SELECT public.accessible_building_ids()) $$;
    CREATE FUNCTION public.accessible_contract_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$
      SELECT c.id FROM public.contracts c JOIN public.rooms r ON r.id = c.room_id WHERE r.building_id IN (SELECT public.accessible_building_ids()) $$;
    -- Ngày công ty: production đọc múi giờ công ty; ở đây ghim bằng GUC để thử biên ngày.
    CREATE FUNCTION public.org_today_v1(p_organization_id uuid DEFAULT NULL) RETURNS date LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT current_setting('test.today')::date $$;

    -- RLS SELECT như production (pg_policies TEST 17/10/2026) — để so hàm DEFINER với đường đọc web.
    ALTER TABLE public.contracts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.buildings ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.contract_customers ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
    CREATE POLICY contracts_select_rbac ON public.contracts FOR SELECT USING ((( SELECT is_super_admin() AS is_super_admin) OR ( SELECT is_admin() AS is_admin) OR ((room_id IS NOT NULL) AND (( SELECT has_full_building_scope() AS has_full_building_scope) OR (room_id IN ( SELECT accessible_room_ids() AS accessible_room_ids))))));
    CREATE POLICY contracts_super_admin_all ON public.contracts FOR ALL TO authenticated USING (( SELECT is_super_admin() AS is_super_admin));
    CREATE POLICY contracts_org_boundary ON public.contracts AS RESTRICTIVE FOR ALL TO authenticated USING (((organization_id IS NULL) OR ( SELECT is_super_admin() AS is_super_admin) OR (organization_id IN ( SELECT unnest(my_org_ids()) AS unnest))));
    CREATE POLICY contracts_hide_demo_admin ON public.contracts AS RESTRICTIVE FOR SELECT TO authenticated USING ((NOT (( SELECT (( SELECT is_super_admin() AS is_super_admin) OR ( SELECT is_admin() AS is_admin))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
    CREATE POLICY contracts_hide_sandbox_admin ON public.contracts AS RESTRICTIVE FOR SELECT TO authenticated USING ((NOT (( SELECT is_super_admin() AS is_super_admin) AND COALESCE((organization_id = ANY (sandbox_org_ids())), false))));
    CREATE POLICY rooms_select_rbac ON public.rooms FOR SELECT USING ((( SELECT has_full_building_scope() AS has_full_building_scope) OR (building_id IN ( SELECT accessible_building_ids() AS accessible_building_ids))));
    CREATE POLICY rooms_super_admin_all ON public.rooms FOR ALL TO authenticated USING (( SELECT is_super_admin() AS is_super_admin));
    CREATE POLICY rooms_org_boundary ON public.rooms AS RESTRICTIVE FOR ALL TO authenticated USING (((organization_id IS NULL) OR ( SELECT is_super_admin() AS is_super_admin) OR (organization_id IN ( SELECT unnest(my_org_ids()) AS unnest))));
    CREATE POLICY rooms_hide_demo_admin ON public.rooms AS RESTRICTIVE FOR SELECT TO authenticated USING ((NOT (( SELECT (( SELECT is_super_admin() AS is_super_admin) OR ( SELECT is_admin() AS is_admin))) AND (building_id IN ( SELECT unnest(demo_building_ids()) AS unnest)))));
    CREATE POLICY rooms_hide_sandbox_admin ON public.rooms AS RESTRICTIVE FOR SELECT TO authenticated USING ((NOT (( SELECT is_super_admin() AS is_super_admin) AND COALESCE((organization_id = ANY (sandbox_org_ids())), false))));
    CREATE POLICY buildings_select_rbac ON public.buildings FOR SELECT USING ((( SELECT has_full_building_scope() AS has_full_building_scope) OR (id IN ( SELECT accessible_building_ids() AS accessible_building_ids))));
    CREATE POLICY buildings_super_admin_all ON public.buildings FOR ALL TO authenticated USING (( SELECT is_super_admin() AS is_super_admin));
    CREATE POLICY buildings_org_boundary ON public.buildings AS RESTRICTIVE FOR ALL TO authenticated USING (((organization_id IS NULL) OR ( SELECT is_super_admin() AS is_super_admin) OR (organization_id IN ( SELECT unnest(my_org_ids()) AS unnest))));
    CREATE POLICY buildings_hide_demo_admin ON public.buildings AS RESTRICTIVE FOR SELECT TO authenticated USING ((NOT (( SELECT (( SELECT is_super_admin() AS is_super_admin) OR ( SELECT is_admin() AS is_admin))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
    CREATE POLICY buildings_hide_sandbox_admin ON public.buildings AS RESTRICTIVE FOR SELECT TO authenticated USING ((NOT (( SELECT is_super_admin() AS is_super_admin) AND COALESCE((organization_id = ANY (sandbox_org_ids())), false))));
    CREATE POLICY contract_customers_select_rbac ON public.contract_customers FOR SELECT USING ((( SELECT has_full_building_scope() AS has_full_building_scope) OR (contract_id IN ( SELECT accessible_contract_ids() AS accessible_contract_ids))));
    CREATE POLICY contract_customers_super_admin_all ON public.contract_customers FOR ALL TO authenticated USING (( SELECT is_super_admin() AS is_super_admin));
    CREATE POLICY contract_customers_org_boundary ON public.contract_customers AS RESTRICTIVE FOR ALL TO authenticated USING (((organization_id IS NULL) OR ( SELECT is_super_admin() AS is_super_admin) OR (organization_id IN ( SELECT unnest(my_org_ids()) AS unnest))));
    CREATE POLICY contract_customers_hide_sandbox_admin ON public.contract_customers AS RESTRICTIVE FOR SELECT TO authenticated USING ((NOT (( SELECT is_super_admin() AS is_super_admin) AND COALESCE((organization_id = ANY (sandbox_org_ids())), false))));
    CREATE POLICY customers_select_rbac ON public.customers FOR SELECT USING ((( SELECT can_access_org_entity('customers'::text, 'view'::text) AS can_access_org_entity) AND (user_id IN ( SELECT unnest(current_visible_owner_ids()) AS unnest))));
    CREATE POLICY customers_super_admin_all ON public.customers FOR ALL TO authenticated USING (( SELECT is_super_admin() AS is_super_admin));
    CREATE POLICY customers_org_boundary ON public.customers AS RESTRICTIVE FOR ALL TO authenticated USING (((organization_id IS NULL) OR ( SELECT is_super_admin() AS is_super_admin) OR (organization_id IN ( SELECT unnest(my_org_ids()) AS unnest))));
    CREATE POLICY customers_hide_demo_admin ON public.customers AS RESTRICTIVE FOR SELECT TO authenticated USING ((NOT (( SELECT (( SELECT is_super_admin() AS is_super_admin) OR ( SELECT is_admin() AS is_admin))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
    CREATE POLICY customers_hide_sandbox_admin ON public.customers AS RESTRICTIVE FOR SELECT TO authenticated USING ((NOT (( SELECT is_super_admin() AS is_super_admin) AND COALESCE((organization_id = ANY (sandbox_org_ids())), false))));
    GRANT SELECT ON public.contracts, public.rooms, public.buildings, public.contract_customers, public.customers TO authenticated;

    INSERT INTO public.t_member VALUES ('${OWNER_A}','${ORG_A}'),('${STAFF_X}','${ORG_A}'),('${STAFF_NO_CUST}','${ORG_A}'),('${STAFF_CUST_Y}','${ORG_A}'),
      ('${OUTSIDER}','${ORG_B}'),('${OWNER_B}','${ORG_B}'),('${SUPER}','${ORG_A}');
    INSERT INTO public.t_perm VALUES
      ('${OWNER_A}','buildings.view',NULL),('${OWNER_A}','customers.view',NULL),
      ('${STAFF_X}','buildings.view','${B_X}'),('${STAFF_X}','customers.view','${B_X}'),
      ('${STAFF_NO_CUST}','buildings.view','${B_X}'),
      -- Thấy hai toà, customers.view chỉ ở toà Y: web vẫn hiện khách ở toà X (quyền ở BẤT KỲ phạm vi).
      ('${STAFF_CUST_Y}','buildings.view','${B_X}'),('${STAFF_CUST_Y}','buildings.view','${B_Y}'),('${STAFF_CUST_Y}','customers.view','${B_Y}'),
      ('${OUTSIDER}','buildings.view',NULL),('${OUTSIDER}','customers.view',NULL),
      ('${OWNER_B}','buildings.view',NULL),('${OWNER_B}','customers.view',NULL);
    INSERT INTO public.t_super VALUES ('${SUPER}');
    INSERT INTO public.t_demo VALUES ('${DEMO_USER}');
    INSERT INTO public.buildings VALUES ('${B_X}','${ORG_A}','${OWNER_A}','Toà X',NULL),('${B_Y}','${ORG_A}','${OWNER_A}','Toà Y',NULL),
      ('${B_B}','${ORG_B}','${OWNER_B}','Toà B',NULL),('${B_DEMO}','${ORG_A}','${DEMO_USER}','Toà Demo',NULL),('${B_SANDBOX}','${SANDBOX}',NULL,'Toà Sandbox',NULL);
    INSERT INTO public.rooms VALUES ('${R_X1}','${ORG_A}','${B_X}','101'),('${R_X2}','${ORG_A}','${B_X}','102'),('${R_Y1}','${ORG_A}','${B_Y}','101'),
      ('${R_B1}','${ORG_B}','${B_B}','101'),('${R_DEMO}','${ORG_A}','${B_DEMO}','D1'),('${R_SANDBOX}','${SANDBOX}','${B_SANDBOX}','S1');
    INSERT INTO public.customers VALUES ('${CU_1}','${ORG_A}','${OWNER_A}','Nguyễn Văn An','0901111222'),('${CU_2}','${ORG_A}','${STAFF_X}','Trần Thị Bình','0903333444'),
      -- Chủ bản ghi không thuộc công ty A ⇒ RLS customers giấu với người công ty A.
      ('${CU_FOREIGN_OWNER}','${ORG_A}','${OUTSIDER}','Lê Khách Lạ','0905555666'),('${CU_B}','${ORG_B}','${OWNER_B}','Phạm Công Ty B','0907777888');
  `);
  for (const s of SEEDS) {
    await db.query(
      `INSERT INTO public.contracts(organization_id, user_id, room_id, contract_number, status, start_date, end_date, expected_move_out_date, created_at, deleted_at)
       VALUES ($1,$2,$3,$4,$5::public.contract_status,$6,$7,$8,$9,$10)`,
      [s.org, s.user ?? OWNER_A, s.room, s.n, s.status ?? "ACTIVE", s.start ?? "2026-01-01", s.end, s.moveOut ?? null, s.created, s.deleted ? "2026-10-12 00:00:00+00" : null]);
  }
  // Khách: HĐ X-ACT có đại diện An + người ở cùng Bình; X-EXPIRED có khách lạ chủ; Y-ACT có Bình; B-ACT có khách B.
  await db.exec(`
    INSERT INTO public.contract_customers(organization_id, contract_id, customer_id, is_representative, created_at)
      SELECT '${ORG_A}'::uuid, id, '${CU_2}'::uuid, false, '2026-10-01'::timestamptz FROM public.contracts WHERE contract_number = 'HD-X-ACT'
      UNION ALL SELECT '${ORG_A}', id, '${CU_1}', true, '2026-10-02' FROM public.contracts WHERE contract_number = 'HD-X-ACT'
      UNION ALL SELECT '${ORG_A}', id, '${CU_FOREIGN_OWNER}', true, '2026-10-01' FROM public.contracts WHERE contract_number = 'HD-X-EXPIRED'
      UNION ALL SELECT '${ORG_A}', id, '${CU_2}', true, '2026-10-01' FROM public.contracts WHERE contract_number = 'HD-Y-ACT'
      UNION ALL SELECT '${ORG_B}', id, '${CU_B}', true, '2026-10-01' FROM public.contracts WHERE contract_number = 'HD-B-ACT';
  `);
  const sql = readFileSync(FILE, "utf8");
  await db.exec(sql);
  await db.exec(sql);
}, 60000);
afterAll(() => db.close());

const ORG_A_VISIBLE = ["HD-X-ACT", "HD-X-EXPIRED", "HD-X-TODAY", "HD-X-D30", "HD-X-D31", "HD-X-MOVE", "HD-X-TERM", "HD-X-TRANS", "HD-X-DRAFT",
  "HD-X-ENUM-EXPIRED", "HD-Y-ACT", "HD-Y-TIE-A", "HD-Y-TIE-B"];
const X_ONLY = ORG_A_VISIBLE.filter((n) => n.startsWith("HD-X"));

describe("contract_list_v1 — quyền và phạm vi", () => {
  it("chưa đăng nhập ⇒ 42501; chỉ authenticated EXECUTE (không anon/service_role); helper nội bộ đóng", async () => {
    expect(await errorCode(null, {})).toBe("42501");
    await inTx(async () => {
      await db.exec("SET LOCAL ROLE anon");
      await expect(db.query("SELECT public.contract_list_v1()")).rejects.toMatchObject({ code: "42501" });
    });
    const acl = await db.query<{ anon: boolean; auth: boolean; svc: boolean; helper: boolean; label: boolean }>(
      `SELECT has_function_privilege('anon','${SIG}','EXECUTE') anon, has_function_privilege('authenticated','${SIG}','EXECUTE') auth,
              has_function_privilege('service_role','${SIG}','EXECUTE') svc,
              has_function_privilege('authenticated','app_private.contract_list_args_v1(text,text,text,text,integer,integer)','EXECUTE') helper,
              has_function_privilege('authenticated','app_private.contract_display_status_v1(text,date,date,date)','EXECUTE') label`);
    expect(acl.rows[0]).toEqual({ anon: false, auth: true, svc: false, helper: false, label: false });
  });

  it("chủ công ty thấy mọi HĐ chưa xoá của công ty mình, không thấy công ty khác; mới tạo trước, hoà theo id", async () => {
    const r = await list(OWNER_A);
    expect(r.total).toBe(ORG_A_VISIBLE.length + 1); // + HD-DEMO: chủ (không phải super admin) vẫn thấy toà demo của công ty mình
    expect(nums(r)).not.toContain("HD-X-DELETED");
    expect(nums(r)).not.toContain("HD-B-ACT");
    const created = r.rows.map((x) => (x as unknown as { created_at: string }).created_at);
    expect([...created].sort().reverse()).toEqual(created);
    const ties = r.rows.filter((x) => x.contract_number?.startsWith("HD-Y-TIE")).map((x) => x.id);
    expect(ties).toEqual([...ties].sort());
    expect(r.today).toBe(TODAY);
  });

  it("nhân viên theo toà chỉ thấy toà được giao; p_building_ids CHỈ thu hẹp, '{}' = không gì", async () => {
    expect(nums(await list(STAFF_X)).sort()).toEqual([...X_ONLY].sort());
    expect((await list(STAFF_X, { buildings: [B_Y] })).total).toBe(0);
    expect((await list(STAFF_X, { buildings: [B_X, B_Y, B_B] })).total).toBe(X_ONLY.length);
    expect((await list(STAFF_X, { buildings: [] })).total).toBe(0);
    expect(nums(await list(OWNER_A, { buildings: [B_Y] })).sort()).toEqual(["HD-Y-ACT", "HD-Y-TIE-A", "HD-Y-TIE-B"]);
    expect((await list(OUTSIDER, { buildings: [B_X] })).total).toBe(0);
  });

  it("phân trang: limit/offset trên đúng thứ tự, tổng giữ nguyên; trang quá cuối vẫn có tổng", async () => {
    const all = await list(OWNER_A);
    const p1 = await list(OWNER_A, { limit: 5, offset: 0 });
    const p3 = await list(OWNER_A, { limit: 5, offset: 10 });
    expect(p1.total).toBe(all.total);
    expect(nums(p1)).toEqual(nums(all).slice(0, 5));
    expect(nums(p3)).toEqual(nums(all).slice(10, 15));
    // Hai HĐ cuối cùng created_at: ranh trang cắt giữa cặp hoà vẫn đúng thứ id (không trùng, không sót).
    const n = all.total;
    expect(nums(await list(OWNER_A, { limit: n - 1 }))).toEqual(nums(all).slice(0, n - 1));
    expect(nums(await list(OWNER_A, { limit: 1, offset: n - 1 }))).toEqual(nums(all).slice(n - 1));
    const past = await list(OWNER_A, { limit: 5, offset: 100 });
    expect(past).toMatchObject({ total: all.total, rows: [] });
    expect(await errorCode(OWNER_A, { limit: 1001 })).toBe("22023");
    expect(await errorCode(OWNER_A, { limit: 0 })).toBe("22023");
    expect(await errorCode(OWNER_A, { offset: -1 })).toBe("22023");
  });

  it("super admin: như RLS — thấy công ty khác, ẩn HĐ của user demo và công ty sandbox", async () => {
    const r = nums(await list(SUPER));
    expect(r).toContain("HD-B-ACT");
    expect(r).not.toContain("HD-DEMO");
    expect(r).not.toContain("HD-SANDBOX");
  });
});

describe("contract_list_v1 — khách (customers.view như web)", () => {
  const rep = (r: Result, n: string) => r.rows.find((x) => x.contract_number === n)!.contract_customers;

  it("có customers.view: tên/SĐT khách, đại diện đứng đầu; chủ bản ghi ngoài công ty bị giấu", async () => {
    const r = await list(STAFF_X);
    const cc = rep(r, "HD-X-ACT");
    expect(cc.map((x) => x.customer?.full_name)).toEqual(["Nguyễn Văn An", "Trần Thị Bình"]);
    expect(cc[0].is_representative).toBe(true);
    expect(rep(r, "HD-X-EXPIRED")).toHaveLength(1);
    expect(rep(r, "HD-X-EXPIRED")[0].customer).toBeNull();
  });

  it("không có customers.view: liên kết khách còn nhưng customer = null, không tìm được theo tên/SĐT", async () => {
    const r = await list(STAFF_NO_CUST);
    expect(rep(r, "HD-X-ACT").map((x) => x.customer)).toEqual([null, null]);
    expect((await list(STAFF_NO_CUST, { search: "Nguyễn Văn" })).total).toBe(0);
    expect((await list(STAFF_NO_CUST, { search: "0901111" })).total).toBe(0);
    expect(nums(await list(STAFF_NO_CUST, { search: "hd-x-act" }))).toEqual(["HD-X-ACT"]);
  });

  it("customers.view ở toà KHÁC vẫn cho thấy khách toà X — đúng RLS web (quyền ở bất kỳ phạm vi)", async () => {
    const r = await list(STAFF_CUST_Y, { buildings: [B_X] });
    expect(rep(r, "HD-X-ACT")[0].customer?.full_name).toBe("Nguyễn Văn An");
    expect(nums(await list(STAFF_CUST_Y, { search: "văn an" }))).toEqual(["HD-X-ACT"]);
  });

  it("p_with_customers=false chỉ ẩn thêm: không tên, không tìm theo khách", async () => {
    const r = await list(OWNER_A, { withCustomers: false });
    expect(rep(r, "HD-X-ACT").every((x) => x.customer === null)).toBe(true);
    expect((await list(OWNER_A, { search: "Bình", withCustomers: false })).total).toBe(0);
    expect(nums(await list(OWNER_A, { search: "Bình" })).sort()).toEqual(["HD-X-ACT", "HD-Y-ACT"]);
  });

  it("hàm DEFINER ra ĐÚNG tập HĐ, phòng, toà và khách mà RLS cho đọc thẳng (mọi vai)", async () => {
    for (const user of [OWNER_A, STAFF_X, STAFF_NO_CUST, STAFF_CUST_Y, OUTSIDER, SUPER]) {
      const fn = await list(user);
      const viaRls = await inTx(async () => {
        await asUser(user);
        const ids = (await db.query<{ id: string }>("SELECT id FROM public.contracts WHERE deleted_at IS NULL ORDER BY id")).rows.map((x) => x.id);
        const embeds = (await db.query<{ id: string; room: string | null; building: string | null; names: string | null }>(
          `SELECT c.id, r.name room, b.name building,
                  (SELECT string_agg(coalesce(cu.full_name,'∅'), ',' ORDER BY coalesce(cc.is_representative,false) DESC, cc.created_at, cc.id)
                     FROM public.contract_customers cc LEFT JOIN public.customers cu ON cu.id = cc.customer_id WHERE cc.contract_id = c.id) names
             FROM public.contracts c LEFT JOIN public.rooms r ON r.id = c.room_id LEFT JOIN public.buildings b ON b.id = r.building_id
            WHERE c.deleted_at IS NULL ORDER BY c.id`)).rows;
        return { ids, embeds };
      });
      expect(fn.rows.map((x) => x.id).sort(), user).toEqual(viaRls.ids);
      const mine = [...fn.rows].sort((a, b) => a.id.localeCompare(b.id)).map((x) => ({
        id: x.id, room: x.room?.name ?? null, building: x.room?.building?.name ?? null,
        names: x.contract_customers.length ? x.contract_customers.map((c) => c.customer?.full_name ?? "∅").join(",") : null,
      }));
      expect(mine, user).toEqual(viaRls.embeds);
    }
  });
});

describe("contract_list_v1 — nhãn hiển thị và bộ lọc", () => {
  const label = (r: Result, n: string) => r.rows.find((x) => x.contract_number === n)?.display_status;

  it("biên ngày theo ngày công ty: hôm qua Quá hạn, hôm nay và +30 Sắp hết hạn, +31 Còn hạn", async () => {
    const r = await list(OWNER_A);
    expect(label(r, "HD-X-EXPIRED")).toBe("EXPIRED");
    expect(label(r, "HD-X-TODAY")).toBe("EXPIRING");
    expect(label(r, "HD-X-D30")).toBe("EXPIRING");
    expect(label(r, "HD-X-D31")).toBe("ACTIVE");
    expect(label(r, "HD-X-MOVE")).toBe("MOVING_OUT");
    expect(label(r, "HD-X-TERM")).toBe("TERMINATED");
    expect(label(r, "HD-X-TRANS")).toBe("TRANSFERRED");
    expect(label(r, "HD-X-DRAFT")).toBe("DRAFT");
    expect(label(r, "HD-X-ENUM-EXPIRED")).toBe("ACTIVE");
    // Một ngày sau: HĐ hết hạn hôm nay chuyển Quá hạn, HĐ +31 vào Sắp hết hạn.
    const next = await list(OWNER_A, {}, "2026-10-18");
    expect(label(next, "HD-X-TODAY")).toBe("EXPIRED");
    expect(label(next, "HD-X-D31")).toBe("EXPIRING");
  });

  it("chữ nhãn khớp CONTRACT_STATUS_CONFIG của web", async () => {
    const r = await list(OWNER_A);
    for (const row of r.rows) {
      expect(row.display_label).toBe(CONTRACT_STATUS_CONFIG[row.display_status as keyof typeof CONTRACT_STATUS_CONFIG].label);
    }
    expect(new Set(r.rows.map((x) => x.display_status))).toEqual(new Set(Object.keys(CONTRACT_STATUS_CONFIG)));
  });

  it("ô thống kê lọc đúng bằng nhãn; vòng đời ACTIVE = mọi trạng thái trừ thanh lý; tổ hợp mâu thuẫn = 0", async () => {
    expect(nums(await list(OWNER_A, { stat: "EXPIRING" })).sort()).toEqual(["HD-X-D30", "HD-X-TODAY"]);
    expect(nums(await list(OWNER_A, { stat: "EXPIRED" })).sort()).toEqual(["HD-X-EXPIRED", "HD-Y-ACT"]);
    expect(nums(await list(OWNER_A, { stat: "TERMINATED", lifecycle: "TERMINATED" }))).toEqual(["HD-X-TERM"]);
    const active = nums(await list(OWNER_A, { lifecycle: "ACTIVE" }));
    expect(active).not.toContain("HD-X-TERM");
    expect(active).toEqual(expect.arrayContaining(["HD-X-TRANS", "HD-X-DRAFT", "HD-X-MOVE"]));
    expect((await list(OWNER_A, { lifecycle: "ACTIVE", stat: "TERMINATED" })).total).toBe(0);
    expect((await list(OWNER_A, { lifecycle: "TERMINATED", stat: "EXPIRING" })).total).toBe(0);
    expect(await errorCode(OWNER_A, { stat: "MOVING_OUT" })).toBe("22023");
    expect(await errorCode(OWNER_A, { lifecycle: "active" })).toBe("22023");
  });

  it("tháng: khoảng hiệu lực giao tháng (chạm biên vẫn tính); sai dạng ⇒ 22023; '' = không lọc", async () => {
    const sep = nums(await list(OWNER_A, { month: "2026-09" }));
    expect(sep).toContain("HD-Y-ACT"); // 01/09–30/09
    expect(nums(await list(OWNER_A, { month: "2026-10" }))).not.toContain("HD-Y-ACT");
    expect(nums(await list(OWNER_A, { month: "2026-08" }))).not.toContain("HD-Y-ACT");
    expect(await errorCode(OWNER_A, { month: "2026-13" })).toBe("22023");
    expect(await errorCode(OWNER_A, { month: "10/2026" })).toBe("22023");
    expect((await list(OWNER_A, { month: "" })).total).toBe((await list(OWNER_A)).total);
  });

  it("tìm: làm sạch như web, ILIKE, '*' là ký tự đại diện; tên phòng; lọc phòng theo đúng tên", async () => {
    expect(nums(await list(OWNER_A, { search: "  (hd-x-term)  " }))).toEqual(["HD-X-TERM"]);
    // Khoảng trắng Unicode (NBSP, khoảng trắng chữ Hán) bị bỏ như String.trim của web.
    const [nbsp, ideo] = [String.fromCharCode(0xa0), String.fromCharCode(0x3000)];
    expect(nums(await list(OWNER_A, { search: `${ideo}hd-x-term${nbsp}` }))).toEqual(["HD-X-TERM"]);
    // Dấu \ bị bỏ như web (để lại thì thành ký tự thoát của LIKE).
    expect(nums(await list(OWNER_A, { search: `hd-x-term${String.fromCharCode(92)}` }))).toEqual(["HD-X-TERM"]);
    expect((await list(OWNER_A, { search: "%,()" })).total).toBe((await list(OWNER_A)).total);
    expect(nums(await list(OWNER_A, { search: "HD-X*TERM" }))).toEqual(["HD-X-TERM"]);
    expect(nums(await list(OWNER_A, { search: "0903333" })).sort()).toEqual(["HD-X-ACT", "HD-Y-ACT"]);
    const room101 = nums(await list(OWNER_A, { room: "101" }));
    expect(room101).toEqual(expect.arrayContaining(["HD-X-ACT", "HD-Y-ACT"]));
    expect(room101).not.toContain("HD-X-TODAY");
    expect(nums(await list(OWNER_A, { room: "102", buildings: [B_X] })).sort()).toEqual(["HD-X-D30", "HD-X-D31", "HD-X-DRAFT", "HD-X-TODAY", "HD-X-TRANS"]);
    expect(nums(await list(OWNER_A, { search: "D1" }))).toEqual(["HD-DEMO"]);
  });

  it("JS getContractDisplayStatus = SQL khi giờ VN 07:00–24:00; lệch đúng hai biên trong 00:00–07:00", async () => {
    const statuses = ["ACTIVE", "TERMINATED", "TRANSFERRED", "DRAFT", "EXPIRED"];
    const ends = ["2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-11-15", "2026-11-16", "2026-11-17"];
    const sql = await db.query<{ s: string; e: string; m: boolean; d: string }>(
      `SELECT s, e, m, app_private.contract_display_status_v1(s, CASE WHEN m THEN DATE '2026-10-30' END, e::date, DATE '${TODAY}') d
         FROM unnest($1::text[]) s, unnest($2::text[]) e, unnest(ARRAY[false,true]) m`, [statuses, ends]);
    const jsAt = (iso: string) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(iso));
      try {
        return sql.rows.map((x) => getContractDisplayStatus({ status: x.s, end_date: x.e, expected_move_out_date: x.m ? "2026-10-30" : null } as unknown as Contract));
      } finally { vi.useRealTimers(); }
    };
    const noonVn = jsAt("2026-10-17T05:00:00Z");
    expect(noonVn).toEqual(sql.rows.map((x) => x.d));
    const lateNight = jsAt("2026-10-16T20:00:00Z"); // 03:00 ngày 17/10 giờ VN
    const diff = sql.rows.filter((x, i) => lateNight[i] !== x.d).map((x) => `${x.s}/${x.e}/${x.m}`);
    expect(diff.sort()).toEqual(["ACTIVE/2026-10-16/false", "ACTIVE/2026-11-16/false", "EXPIRED/2026-10-16/false", "EXPIRED/2026-11-16/false"]);
    // Hàng danh sách mang sẵn nhãn SQL ⇒ web hiện đúng nhãn đó, không tính lại.
    expect(getContractDisplayStatus({ status: "ACTIVE", end_date: "2020-01-01", expected_move_out_date: null, display_status: "EXPIRING" } as unknown as Contract)).toBe("EXPIRING");
  });
});
