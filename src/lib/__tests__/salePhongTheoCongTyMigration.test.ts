import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mỗi ca dựng CSDL PGlite riêng mất 10–20 giây trên máy chậm.
vi.setConfig({ testTimeout: 120_000 });

// Sale phòng đợt 2 (20261125034429): link, cài đặt chung, «Phòng trống», bot Zalo và Hermes theo CÔNG TY; chuyển
// 45/3 TTT về đứng tên nick chủ; toà mới đứng tên người đứng tên chung của công ty; RPC quản link / lưu cài đặt có kiểm
// quyền và CAS; đóng ghi thẳng bảng link / cài đặt. Fixture dựng các bảng và hàm phụ thuộc tối thiểu (fact phòng là bản
// giản lược có thể đoán trước), chạy THÂN HÀNH VI của migration hai lượt; khối md5 tiền kiểm / hậu kiểm kiểm riêng.
const FILE = 'supabase/migrations/20261125034429_sale_phong_theo_cong_ty.sql';
const sql = readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');
const behaviourSql = sql.replace(/DO \$truoc\$[\s\S]*?\$truoc\$;/, '').replace(/DO \$sau\$[\s\S]*?\$sau\$;/, '');

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// Mã thật mà khối dữ liệu của migration nhắm tới (đã có trong repo ở các migration trước).
const ORG = 'aaaa0000-0000-4000-8000-000000000001';
const CHU = '90450d5f-29b6-4897-bdef-cdb5fb53f339'; // nick chủ: đứng tên mọi toà khác, super admin
const NATHAN = 'df8d1df5-1c24-4723-9733-4640c43c382b'; // quản lý đang đứng tên 45/3 TTT
const TOA_45 = 'c4eb87df-758d-4e16-82dc-040f49e6adfc';
const ORG_B = id(102);
const QUANLY = id(2); // quản lý một công ty, quyền Sale phạm vi công ty
const NOPERM = id(3); // thành viên, không có quyền Sale nào
const VIEWER = id(4); // chỉ xem trang Sale
const LA = id(5); // không thuộc công ty
const CHU_B = id(6); // chủ công ty B
const QL_TOA = id(7); // quản lý chỉ có quyền Sale theo TOÀ (không phạm vi công ty)
const TOA_A1 = id(201), TOA_A2 = id(202), TOA_AO = id(203), TOA_XOA = id(204), TOA_B1 = id(205);
const P_TRONG = id(301), P_THUE = id(302), P_45 = id(303), P_PASS = id(304), P_B = id(305), P_AO = id(306), P_XOA = id(307);
const HOT_CHU = id(401), HOT_QL = id(402);

const fixture = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
  CREATE SCHEMA app_private; CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth, public TO anon, authenticated;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
  CREATE TABLE public.organizations(id uuid PRIMARY KEY, status text NOT NULL DEFAULT 'ACTIVE');
  CREATE TABLE public.organization_memberships(user_id uuid, organization_id uuid, status text);
  CREATE TABLE public.super_admins(user_id uuid PRIMARY KEY);
  CREATE TABLE public.profiles(id uuid PRIMARY KEY, full_name text);
  CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT COALESCE(array_agg(organization_id), '{}'::uuid[]) FROM public.organization_memberships WHERE user_id = auth.uid() AND status = 'ACTIVE' $$;
  CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT EXISTS (SELECT 1 FROM public.super_admins WHERE user_id = auth.uid()) $$;
  CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT '{}'::uuid[] $$;
  CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
  -- Tài khoản demo theo cấu hình test (test.demo_users, phân cách dấu phẩy).
  CREATE FUNCTION public.demo_user_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$
    SELECT COALESCE(string_to_array(NULLIF(current_setting('test.demo_users', true), ''), ',')::uuid[], '{}'::uuid[]) $$;
  CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
  -- authorized_scope_v3 thật luôn trả đúng một dòng (không quyền ⇒ org_wide=false, building_ids rỗng).
  CREATE TABLE app_private.test_grants(user_id uuid, org uuid, permission text, org_wide boolean, building_ids uuid[]);
  CREATE FUNCTION app_private.authorized_scope_v3(p_permission_key text, p_org uuid)
  RETURNS TABLE(org_wide boolean, building_ids uuid[], cashbook_ids uuid[]) LANGUAGE sql STABLE AS $$
    SELECT COALESCE(bool_or(g.org_wide), false), COALESCE((SELECT array_agg(DISTINCT x) FROM app_private.test_grants g2, unnest(g2.building_ids) x
        WHERE g2.user_id = auth.uid() AND g2.org = p_org AND g2.permission = p_permission_key), '{}'::uuid[]), '{}'::uuid[]
      FROM (SELECT 1) one LEFT JOIN app_private.test_grants g ON g.user_id = auth.uid() AND g.org = p_org AND g.permission = p_permission_key
  $$;
  -- Thân production của sale_room_can_v1 (đo 25/11/2026).
  CREATE FUNCTION app_private.sale_room_can_v1(p_org uuid, p_building uuid, p_permission text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'app_private' AS $$
    SELECT auth.uid() IS NOT NULL AND COALESCE(p_org = ANY(public.my_org_ids()), false) AND COALESCE(public.can_access_building(p_building), false)
      AND EXISTS (SELECT 1 FROM app_private.authorized_scope_v3(p_permission, p_org) s WHERE s.org_wide OR p_building = ANY(s.building_ids)) $$;
  CREATE FUNCTION app_private.sale_room_can_edit_v1(p_org uuid, p_building uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT app_private.sale_room_can_v1(p_org, p_building, 'sale_phong.edit') $$;
  CREATE TABLE public.buildings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, user_id uuid NOT NULL, name text NOT NULL,
    code text, district text, ward text, street_address text, province text, total_floors integer, floor_layouts jsonb, images jsonb,
    public_contact_name text, public_contact_phone text, public_map_url text, public_lift_type text,
    is_virtual boolean NOT NULL DEFAULT false, deleted_at timestamptz, updated_at timestamptz DEFAULT now());
  CREATE FUNCTION public.set_user_id_from_auth() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
  BEGIN IF NEW.user_id IS NULL THEN NEW.user_id := auth.uid(); END IF; RETURN NEW; END $$;
  CREATE TRIGGER buildings_set_user_id_audit BEFORE INSERT ON public.buildings FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
  CREATE TABLE public.rooms(id uuid PRIMARY KEY, organization_id uuid, building_id uuid, floor integer, name text, code text, area numeric,
    rent_price numeric, deposit_amount numeric, max_occupants integer, amenities jsonb, images jsonb, description text, sale_note text,
    sale_bonus_note text, room_type text, status text, sale_status_note text, sale_status_note_key text, deleted_at timestamptz,
    updated_at timestamptz DEFAULT now());
  CREATE TABLE public.public_room_settings(owner_id uuid PRIMARY KEY, organization_id uuid, soon_days integer NOT NULL DEFAULT 30,
    show_rented boolean NOT NULL DEFAULT true, hotline_id uuid, sale_policy text, updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.public_room_share_tokens(token text PRIMARY KEY, owner_id uuid NOT NULL, label text, revoked boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(), organization_id uuid);
  ALTER TABLE public.public_room_share_tokens ENABLE ROW LEVEL SECURITY;
  CREATE POLICY prst_owner_all ON public.public_room_share_tokens FOR ALL TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
  ALTER TABLE public.public_room_settings ENABLE ROW LEVEL SECURITY;
  CREATE POLICY prs_owner_all ON public.public_room_settings FOR ALL TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
  REVOKE INSERT ON public.public_room_share_tokens FROM PUBLIC, anon, authenticated;
  CREATE TABLE public.hotlines(id uuid PRIMARY KEY, user_id uuid, organization_id uuid, name text, phone_number text, is_active boolean,
    created_at timestamptz DEFAULT now());
  CREATE TABLE public.areas(id uuid PRIMARY KEY, user_id uuid, organization_id uuid, name text, deleted_at timestamptz);
  CREATE TABLE public.area_buildings(building_id uuid, area_id uuid, organization_id uuid);
  CREATE TABLE public.building_services(building_id uuid, service_id uuid, is_active boolean, unit_price_override numeric);
  CREATE TABLE public.services(id uuid, unit text, unit_price numeric, type text, deleted_at timestamptz);
  CREATE TABLE public.room_pass_listings(id uuid PRIMARY KEY, room_id uuid, user_id uuid, organization_id uuid, active boolean,
    contact_manager boolean, contact_name text, contact_phone text, sale_policy text, pass_price numeric, avail_date date);
  CREATE TABLE public.room_sale_locks(id uuid, room_id uuid, organization_id uuid, released_at timestamptz, expires_at timestamptz,
    locked_at timestamptz, locked_by uuid, hours integer, note text);
  CREATE TABLE app_private.room_sale_policies_v1(id uuid, organization_id uuid, room_id uuid, cancelled_at timestamptz, starts_at timestamptz, ends_at timestamptz);
  CREATE TABLE app_private.sale_room_change_receipts(room_id uuid, organization_id uuid, actor_id uuid, response jsonb, created_at timestamptz);
  CREATE TABLE public.accounting_repair_audit(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, entity_type text NOT NULL,
    entity_id uuid NOT NULL, repair_code text NOT NULL, before_snapshot jsonb NOT NULL, after_snapshot jsonb NOT NULL,
    details jsonb NOT NULL DEFAULT '{}'::jsonb, repaired_at timestamptz NOT NULL DEFAULT clock_timestamp(), repaired_by uuid);
  CREATE UNIQUE INDEX accounting_repair_audit_entity_code_uq ON public.accounting_repair_audit(entity_type, entity_id, repair_code);
  -- Fact phòng giản lược, đoán trước được: AVAILABLE ⇒ free, NOTICE ⇒ soon (avail_date = 2026-01-01 + số ngày sắp trống
  -- được dùng ⇒ test thấy số ngày lấy theo ai), có tin pass ⇒ pass, còn lại ⇒ rented.
  CREATE FUNCTION app_private.room_sale_workflow_fact_v1(p_room_id uuid, p_organization_id uuid, p_room_status text, p_has_pass boolean, p_soon_days integer)
  RETURNS TABLE(status_public text, sale_state text, avail_date date, sale_today date, expected_ready_on date) LANGUAGE sql STABLE AS $$
    SELECT CASE WHEN p_has_pass THEN 'pass' WHEN p_room_status='AVAILABLE' THEN 'free' WHEN p_room_status='NOTICE' THEN 'soon' ELSE 'rented' END,
      CASE WHEN p_has_pass THEN 'PASS' WHEN p_room_status='AVAILABLE' THEN 'READY' WHEN p_room_status='NOTICE' THEN 'NOTICE' ELSE 'RENTED' END,
      CASE WHEN p_room_status='NOTICE' THEN DATE '2026-01-01' + p_soon_days END, DATE '2026-01-01', NULL::date $$;
  CREATE FUNCTION app_private.room_sale_workflow_base_fact_v1(p_room_id uuid, p_organization_id uuid, p_room_status text, p_has_pass boolean, p_soon_days integer)
  RETURNS TABLE(status_public text, sale_state text, avail_date date, sale_today date, expected_ready_on date) LANGUAGE sql STABLE AS $$
    SELECT * FROM app_private.room_sale_workflow_fact_v1(p_room_id, p_organization_id, p_room_status, p_has_pass, p_soon_days) $$;
  CREATE FUNCTION app_private.room_sale_policy_overlay_v1(p_payload jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$
    SELECT CASE WHEN p_payload IS NULL THEN NULL ELSE p_payload || jsonb_build_object('server_now', statement_timestamp(),
      'rooms', COALESCE((SELECT jsonb_agg(item || jsonb_build_object('sale_note_base', item->'sale_note', 'active_policy_text', 'KM thử')) FROM jsonb_array_elements(p_payload->'rooms') item), '[]'::jsonb)) END $$;
  CREATE FUNCTION app_private.room_sale_policy_active_text_v1(uuid, uuid, timestamptz) RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULL::text $$;
  CREATE FUNCTION app_private.room_sale_policy_current_v1(uuid, uuid, timestamptz) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT NULL::jsonb $$;
  CREATE FUNCTION app_private.room_sale_policy_json_v1(p app_private.room_sale_policies_v1, at timestamptz) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
  CREATE FUNCTION app_private.sale_room_fact_key_v1(uuid, uuid) RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'k' $$;
  CREATE FUNCTION app_private.room_exit_hold_json_v1(uuid, uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT NULL::jsonb $$;
  CREATE FUNCTION app_private.hermes_room_page_admission_v1(p_binding jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT p_binding $$;
  -- Bản cũ của các hàm sẽ bị thay (thân rút gọn; thân production được kiểm ở tiền kiểm md5 trên TEST/production).
  CREATE FUNCTION public.get_my_available_rooms() RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
  REVOKE ALL ON FUNCTION public.get_my_available_rooms() FROM PUBLIC, anon;
  CREATE FUNCTION public.get_public_available_rooms(p_token text) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$;
  CREATE FUNCTION public.hermes_available_rooms_page_v1(p_binding jsonb, p_organization_id uuid, p_building_ids uuid[] DEFAULT NULL,
    p_building_name text DEFAULT '', p_statuses text[] DEFAULT NULL, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$;
  REVOKE ALL ON FUNCTION public.hermes_available_rooms_page_v1(jsonb,uuid,uuid[],text,text[],integer,integer) FROM PUBLIC, anon, service_role;
  CREATE FUNCTION public.get_sale_room_inventory_v1(p_organization_id uuid, p_building_id uuid DEFAULT NULL, p_room_id uuid DEFAULT NULL)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$;
  REVOKE ALL ON FUNCTION public.get_sale_room_inventory_v1(uuid,uuid,uuid) FROM PUBLIC, anon;
  CREATE FUNCTION public.zalo_sale_advice_delivery_v1(p_job uuid, p_instance uuid, p_generation uuid, p_signature text DEFAULT NULL, p_memory jsonb DEFAULT NULL)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$;
  REVOKE ALL ON FUNCTION public.zalo_sale_advice_delivery_v1(uuid,uuid,uuid,text,jsonb) FROM PUBLIC, anon, authenticated;
  SET check_function_bodies = off;
`;

const seed = `
  INSERT INTO public.organizations(id) VALUES ('${ORG}'),('${ORG_B}');
  INSERT INTO public.organization_memberships VALUES
    ('${CHU}','${ORG}','ACTIVE'),('${CHU}','${ORG_B}','ACTIVE'),('${NATHAN}','${ORG}','ACTIVE'),('${QUANLY}','${ORG}','ACTIVE'),
    ('${NOPERM}','${ORG}','ACTIVE'),('${VIEWER}','${ORG}','ACTIVE'),('${CHU_B}','${ORG_B}','ACTIVE'),('${QL_TOA}','${ORG}','ACTIVE');
  INSERT INTO public.super_admins VALUES ('${CHU}');
  INSERT INTO public.profiles VALUES ('${CHU}','Anh Chủ'),('${QUANLY}','Quản Lý'),('${NATHAN}','Nathan');
  INSERT INTO app_private.test_grants
    SELECT u, '${ORG}', p, true, '{}' FROM unnest(ARRAY['${QUANLY}','${NATHAN}']::uuid[]) u,
      unnest(ARRAY['sale_phong.view','rooms.view','sale_phong.manage_settings','sale_phong.manage_tokens','sale_phong.edit']) p;
  -- Nick chủ: vai chủ công ty phạm vi công ty (xem phòng / trang Sale); quyền sửa cài đặt đi đường super admin.
  INSERT INTO app_private.test_grants VALUES ('${CHU}','${ORG}','sale_phong.view',true,'{}'),('${CHU}','${ORG}','rooms.view',true,'{}');
  INSERT INTO app_private.test_grants SELECT '${QL_TOA}', '${ORG}', p, false, ARRAY['${TOA_A1}']::uuid[]
    FROM unnest(ARRAY['sale_phong.view','rooms.view','sale_phong.manage_settings','sale_phong.manage_tokens']) p;
  INSERT INTO public.profiles VALUES ('${QL_TOA}','Quản lý toà A1');
  INSERT INTO app_private.test_grants VALUES ('${VIEWER}','${ORG}','sale_phong.view',true,'{}'),
    ('${CHU_B}','${ORG_B}','sale_phong.view',true,'{}'),('${CHU_B}','${ORG_B}','sale_phong.manage_tokens',true,'{}');
  INSERT INTO public.buildings(id, organization_id, user_id, name, is_virtual, deleted_at, floor_layouts) VALUES
    ('${TOA_A1}','${ORG}','${CHU}','A1 toà chủ',false,NULL,'{"1":{"x":1}}'),
    ('${TOA_45}','${ORG}','${NATHAN}','45/3 Trần Thái Tông',false,NULL,'{"2":{"x":2}}'),
    ('${TOA_AO}','${ORG}','${CHU}','Kho Văn Phòng Chung',true,NULL,NULL),
    ('${TOA_XOA}','${ORG}','${QUANLY}','Toà đã xoá',false,now(),NULL),
    ('${TOA_B1}','${ORG_B}','${CHU_B}','B1 công ty khác',false,NULL,NULL);
  INSERT INTO public.rooms(id, organization_id, building_id, floor, name, code, area, rent_price, deposit_amount, max_occupants, amenities, images,
      description, sale_note, room_type, status) VALUES
    ('${P_TRONG}','${ORG}','${TOA_A1}',1,'101','A1-101',20,4000000,4000000,2,'["máy lạnh"]','["a.jpg"]','Phòng đẹp','Giảm 200k','Studio','AVAILABLE'),
    ('${P_THUE}','${ORG}','${TOA_A1}',1,'102','A1-102',25,5000000,5000000,2,'["máy lạnh"]','["b.jpg"]','Phòng thuê','KM bí mật','1PN','OCCUPIED'),
    ('${P_PASS}','${ORG}','${TOA_A1}',2,'201','A1-201',18,3500000,3500000,1,'[]','[]',NULL,NULL,'Studio','OCCUPIED'),
    ('${P_45}','${ORG}','${TOA_45}',2,'P204','P204',22,4200000,4200000,2,'[]','["c.jpg"]',NULL,NULL,'Studio','NOTICE'),
    ('${P_AO}','${ORG}','${TOA_AO}',1,'K1','K1',1,1,1,1,'[]','[]',NULL,NULL,NULL,'AVAILABLE'),
    ('${P_XOA}','${ORG}','${TOA_XOA}',1,'X1','X1',1,1,1,1,'[]','[]',NULL,NULL,NULL,'AVAILABLE'),
    ('${P_B}','${ORG_B}','${TOA_B1}',1,'B101','B101',30,6000000,6000000,3,'[]','[]',NULL,NULL,NULL,'AVAILABLE');
  INSERT INTO public.room_pass_listings VALUES ('${id(501)}','${P_PASS}','${CHU}','${ORG}',true,false,'Khách pass','0900000000','Pass nhanh',3300000,NULL);
  INSERT INTO public.public_room_settings(owner_id, organization_id, soon_days, hotline_id, sale_policy, updated_at) VALUES
    ('${CHU}','${ORG}',16,NULL,'Điện 3.500/kWh','2026-11-01T00:00:00Z'),('${NATHAN}','${ORG}',30,NULL,'Chính sách cũ của quản lý','2026-10-01T00:00:00Z');
  INSERT INTO public.hotlines VALUES ('${HOT_CHU}','${CHU}','${ORG}','Hotline chung','0911111111',true,'2026-01-01'),
    ('${HOT_QL}','${QUANLY}','${ORG}','Hotline quản lý','0922222222',true,'2026-01-02');
  INSERT INTO public.areas VALUES ('${id(601)}','${CHU}','${ORG}','Tân Bình',NULL),('${id(602)}','${CHU_B}','${ORG_B}','Khu B',NULL);
  INSERT INTO public.public_room_share_tokens(token, owner_id, label, organization_id, created_at) VALUES
    ('demo','${CHU}','Demo','${ORG}','2026-06-06'),('cua-quan-ly','${QUANLY}','Link quản lý','${ORG}','2026-11-25'),
    ('cong-ty-b','${CHU_B}',NULL,'${ORG_B}','2026-08-01'),('khong-org','${CHU}',NULL,NULL,'2026-01-01');
`;

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(fixture);
  await db.exec(seed);
  return db;
}
async function asUser<T>(db: PGlite, uid: string | null, text: string, params: unknown[] = []) {
  await db.query("SELECT set_config('test.uid', $1, false)", [uid ?? '']);
  return db.query<T>(text, params);
}
async function asAuthenticated<T>(db: PGlite, uid: string, text: string, params: unknown[] = []) {
  await db.query("SELECT set_config('test.uid', $1, false)", [uid]);
  await db.exec('SET ROLE authenticated');
  try { return await db.query<T>(text, params); } finally { await db.exec('RESET ROLE'); }
}
type Room = Record<string, unknown> & { id: string; status_public: string };
type Page = { rooms: Room[]; buildings: Array<Record<string, unknown> & { id: string }>; contact: { name: string; phone: string } | null;
  sale_policy: string | null; areas: Array<{ id: string; name: string }>; pages?: number };
const page = async (db: PGlite, token: string) =>
  (await asUser<{ p: Page | null }>(db, null, 'SELECT public.get_public_available_rooms($1) p', [token])).rows[0].p;
const bot = async (db: PGlite, org = ORG) => (await asUser<{ p: Page }>(db, null, 'SELECT app_private.public_sale_rooms_payload_v1($1) p', [org])).rows[0].p;
const myRooms = async (db: PGlite, uid: string, org: string | null = null) =>
  (await asUser<{ p: Page | null }>(db, uid, 'SELECT public.get_my_available_rooms($1::uuid) p', [org])).rows[0].p;
const hermes = async (db: PGlite, org = ORG, scope = [TOA_A1, TOA_45, TOA_AO]) =>
  (await asUser<{ p: { result: { publishedPages: number; totalCount: number; rooms: Room[]; buildings: Array<Record<string, unknown>>; salePolicies: string[] } } }>(
    db, null, "SELECT public.hermes_available_rooms_page_v1($1::jsonb, $2::uuid) p", [JSON.stringify({ organizationId: org, buildingIds: scope }), org])).rows[0].p.result;
const settingsOf = async (db: PGlite, uid: string, org = ORG) =>
  (await asUser<{ s: Record<string, unknown> }>(db, uid, 'SELECT public.get_public_room_settings_v1($1) s', [org])).rows[0].s;
const save = (db: PGlite, uid: string, expected: string | null, soon: number, hotline: string | null = null, policy: string | null = 'Chính sách mới', org = ORG) =>
  asUser<{ s: Record<string, unknown> }>(db, uid, 'SELECT public.save_public_room_settings_v1($1, $2::timestamptz, $3, true, $4::uuid, $5) s', [org, expected, soon, hotline, policy]);
const manage = (db: PGlite, uid: string, token: string, action: string, label: string | null = null, org = ORG) =>
  asUser<{ r: Record<string, unknown> }>(db, uid, 'SELECT public.manage_public_room_token_v1($1, $2, $3, $4) r', [org, token, action, label]);
const ownerOf = async (db: PGlite, building: string) =>
  (await db.query<{ u: string }>('SELECT user_id u FROM public.buildings WHERE id=$1', [building])).rows[0]?.u;
const roomIds = (p: { rooms: Room[] } | null) => (p?.rooms ?? []).map(r => r.id).sort();
const offered = (p: { rooms: Room[] } | null) => (p?.rooms ?? []).filter(r => ['free', 'soon', 'pass'].includes(r.status_public)).map(r => r.id).sort();

let db: PGlite;
beforeAll(async () => {
  db = await freshDb();
  await db.exec(behaviourSql);
  await db.exec(behaviourSql);
}, 60_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => { await db.exec('RESET ROLE'); });

describe('dữ liệu: 45/3 TTT về đứng tên nick chủ (đúng 1 dòng, guard, biên nhận)', () => {
  it('đổi đúng một dòng, ghi biên nhận giá trị cũ để lùi; chạy lại không đổi thêm', async () => {
    expect(await ownerOf(db, TOA_45)).toBe(CHU);
    const audit = await db.query<{ before: string; after: string }>(
      "SELECT before_snapshot->>'user_id' AS before, after_snapshot->>'user_id' AS after FROM public.accounting_repair_audit WHERE entity_id=$1 AND repair_code='SALE_PHONG_DOT2_NGUOI_DUNG_TEN_TOA'", [TOA_45]);
    expect(audit.rows).toEqual([{ before: NATHAN, after: CHU }]);
    expect(await ownerOf(db, TOA_A1)).toBe(CHU);
    expect(await ownerOf(db, TOA_XOA)).toBe(QUANLY); // toà đã xoá không bị đụng
  });

  it('đứng tên người thứ ba hoặc các toà khác không cùng một người ⇒ 55000, không đổi gì', async () => {
    const other = await freshDb();
    try {
      await other.exec(`UPDATE public.buildings SET user_id='${QUANLY}' WHERE id='${TOA_45}'`);
      await expect(other.exec(behaviourSql)).rejects.toThrow(/đứng tên người khác giá trị đã rà/);
      expect(await ownerOf(other, TOA_45)).toBe(QUANLY);
      await other.exec(`UPDATE public.buildings SET user_id='${NATHAN}' WHERE id='${TOA_45}'; UPDATE public.buildings SET user_id='${QUANLY}' WHERE id='${TOA_AO}'`);
      await expect(other.exec(behaviourSql)).rejects.toThrow(/không cùng đứng tên nick chủ/);
      expect(await ownerOf(other, TOA_45)).toBe(NATHAN);
      expect((await other.query<{ n: number }>('SELECT count(*)::int n FROM public.accounting_repair_audit')).rows[0].n).toBe(0);
    } finally { await other.close(); }
  });

  it('CSDL không có toà 45/3 TTT ⇒ bỏ qua bước dữ liệu', async () => {
    const other = await freshDb();
    try {
      await other.exec(`DELETE FROM public.rooms WHERE building_id='${TOA_45}'; DELETE FROM public.buildings WHERE id='${TOA_45}'`);
      await other.exec(behaviourSql);
      expect((await other.query<{ n: number }>('SELECT count(*)::int n FROM public.accounting_repair_audit')).rows[0].n).toBe(0);
    } finally { await other.close(); }
  });
});

describe('luật toà mới: đứng tên người đứng tên chung của công ty', () => {
  it('quản lý tạo toà ở công ty một người đứng tên ⇒ toà đứng tên chủ, kể cả khi gửi user_id khác', async () => {
    await asUser(db, QUANLY, `INSERT INTO public.buildings(id, organization_id, name) VALUES ('${id(701)}','${ORG}','Toà thử của quản lý')`);
    expect(await ownerOf(db, id(701))).toBe(CHU);
    await asUser(db, QUANLY, `INSERT INTO public.buildings(id, organization_id, user_id, name) VALUES ('${id(702)}','${ORG}','${QUANLY}','Toà gửi user_id')`);
    expect(await ownerOf(db, id(702))).toBe(CHU);
    await db.exec(`DELETE FROM public.buildings WHERE id IN ('${id(701)}','${id(702)}')`);
  });

  it('công ty chưa có toà, hoặc đang lẫn nhiều người đứng tên ⇒ giữ người tạo; toà chưa có công ty ⇒ giữ người tạo', async () => {
    const other = await freshDb();
    try {
      await other.exec(behaviourSql);
      const empty = id(103);
      await other.exec(`INSERT INTO public.organizations(id) VALUES ('${empty}')`);
      await asUser(other, QUANLY, `INSERT INTO public.buildings(id, organization_id, name) VALUES ('${id(711)}','${empty}','Toà đầu tiên')`);
      expect(await ownerOf(other, id(711))).toBe(QUANLY);
      await asUser(other, CHU_B, `INSERT INTO public.buildings(id, organization_id, name) VALUES ('${id(712)}','${empty}','Toà thứ hai')`);
      expect(await ownerOf(other, id(712))).toBe(QUANLY); // đã có toà đứng tên QUANLY
      await other.exec(`UPDATE public.buildings SET user_id='${CHU_B}' WHERE id='${id(712)}'`);
      await asUser(other, NOPERM, `INSERT INTO public.buildings(id, organization_id, name) VALUES ('${id(713)}','${empty}','Toà lẫn')`);
      expect(await ownerOf(other, id(713))).toBe(NOPERM);
      await asUser(other, NOPERM, `INSERT INTO public.buildings(id, name) VALUES ('${id(714)}','Chung')`);
      expect(await ownerOf(other, id(714))).toBe(NOPERM);
    } finally { await other.close(); }
  });
});

describe('link công khai, bot Zalo, Hermes: cùng danh sách theo công ty', () => {
  it('link của quản lý ra đúng trang như link của chủ: mọi toà thật của công ty, hotline + chính sách của chủ', async () => {
    const chu = await page(db, 'demo');
    const ql = await page(db, 'cua-quan-ly');
    expect(ql).toEqual({ ...chu, server_now: (ql as unknown as { server_now: string }).server_now });
    expect(offered(ql)).toEqual([P_TRONG, P_45, P_PASS].sort());
    expect(roomIds(ql)).toEqual([P_TRONG, P_THUE, P_45, P_PASS].sort()); // toà ảo, toà đã xoá, công ty khác thì không
    expect(ql?.contact).toEqual({ name: 'Hotline chung', phone: '0911111111' });
    expect(ql?.sale_policy).toBe('Điện 3.500/kWh');
    expect(ql?.areas).toEqual([{ id: id(601), name: 'Tân Bình' }]);
    // Sơ đồ tầng cho mọi toà của trang (trước đây chỉ toà đứng tên người tạo link).
    expect(ql?.buildings.find(b => b.id === TOA_45)?.floor_layouts).toEqual({ 2: { x: 2 } });
  });

  it('phòng đã thuê chỉ còn mã/tầng/tên/diện tích/loại + trạng thái; giá, cọc, ảnh, nội thất, mô tả, khuyến mãi rỗng', async () => {
    const rented = (await page(db, 'demo'))?.rooms.find(r => r.id === P_THUE);
    expect(rented).toMatchObject({ code: 'A1-102', floor: 1, name: '102', area: 25, room_type: '1PN', status_public: 'rented',
      rent_price: null, deposit_amount: null, max_occupants: null, amenities: [], images: [], description: null, sale_note: null,
      sale_note_base: null, active_policy_text: null });
    const free = (await page(db, 'demo'))?.rooms.find(r => r.id === P_TRONG);
    expect(free).toMatchObject({ rent_price: 4000000, images: ['a.jpg'], description: 'Phòng đẹp', sale_note: 'Giảm 200k', active_policy_text: 'KM thử' });
  });

  it('sắp trống theo người đứng tên từng toà; tin pass theo phòng (đúng công ty)', async () => {
    const p = await page(db, 'demo');
    expect(p?.rooms.find(r => r.id === P_45)).toMatchObject({ status_public: 'soon', avail_date: '2026-01-17' }); // 16 ngày của chủ
    expect(p?.rooms.find(r => r.id === P_PASS)).toMatchObject({ status_public: 'pass', pass_price: 3300000, pass_contact_name: 'Khách pass' });
  });

  it('link thu hồi, link chưa ghi công ty, link công ty khác ⇒ không lẫn', async () => {
    expect(await page(db, 'khong-org')).toBeNull();
    expect(await page(db, 'khong-co')).toBeNull();
    const b = await page(db, 'cong-ty-b');
    expect(roomIds(b)).toEqual([P_B]);
    expect(b?.contact).toBeNull();
  });

  it('bot Zalo: cùng phòng chào được như link, pages=1; hết link hoạt động ⇒ pages=0 và không chào phòng', async () => {
    const z = await bot(db);
    expect(z.pages).toBe(1);
    expect(roomIds(z)).toEqual(offered(await page(db, 'demo')));
    expect(z.contact).toEqual({ name: 'Hotline chung', phone: '0911111111' });
    expect(z.buildings.map(b => b.id).sort()).toEqual([TOA_A1, TOA_45].sort());
    expect(z.buildings.every(b => b.floor_layouts === undefined && b.page_contact_phone === '0911111111')).toBe(true);
    await db.exec("UPDATE public.public_room_share_tokens SET revoked=true WHERE token='demo'");
    expect(roomIds(await bot(db))).toEqual(roomIds(z)); // chỉ còn link của quản lý: vẫn đủ phòng của công ty
    await db.exec("UPDATE public.public_room_share_tokens SET revoked=true WHERE token='cua-quan-ly'");
    expect(await bot(db)).toMatchObject({ pages: 0, rooms: [], buildings: [] });
    await db.exec("UPDATE public.public_room_share_tokens SET revoked=false WHERE token IN ('demo','cua-quan-ly')");
  });

  it('Hermes: cùng danh sách phòng chào được, publishedPages 1/0, chính sách/hotline của chủ', async () => {
    const h = await hermes(db);
    expect(h.publishedPages).toBe(1);
    expect(h.rooms.map(r => r.id).sort()).toEqual(roomIds(await bot(db)));
    expect(h.salePolicies).toEqual(['Điện 3.500/kWh']);
    expect(h.buildings.every(b => b.page_contact_phone === '0911111111')).toBe(true);
    await db.exec("UPDATE public.public_room_share_tokens SET revoked=true WHERE organization_id='" + ORG + "'");
    expect(await hermes(db)).toMatchObject({ publishedPages: 0, totalCount: 0, rooms: [] });
    await db.exec("UPDATE public.public_room_share_tokens SET revoked=false WHERE token IN ('demo','cua-quan-ly')");
  });
});

describe('«Phòng trống» trong app theo công ty đang chọn và quyền xem', () => {
  it('quản lý và chủ thấy cùng phòng của công ty (kể cả 45/3 TTT); người không có quyền xem phòng thì không thấy toà nào', async () => {
    const ql = await myRooms(db, QUANLY, ORG);
    expect(offered(ql)).toEqual([P_TRONG, P_45, P_PASS].sort());
    expect(offered(await myRooms(db, CHU, ORG))).toEqual(offered(ql));
    expect(ql?.contact).toEqual({ name: 'Hotline chung', phone: '0911111111' });
    expect((await myRooms(db, NOPERM, ORG))?.rooms).toEqual([]);
    expect(offered(await myRooms(db, VIEWER, ORG))).toEqual(offered(ql));
  });

  it('không gửi công ty: một công ty thì lấy công ty đó; nhiều công ty thì công ty có toà người gọi đứng tên; không thì 22023', async () => {
    expect(offered(await myRooms(db, QUANLY))).toEqual(offered(await myRooms(db, QUANLY, ORG)));
    expect(offered(await myRooms(db, CHU))).toEqual(offered(await myRooms(db, CHU, ORG))); // chủ đứng tên toà ở công ty A
    const other = await freshDb();
    try {
      await other.exec(behaviourSql);
      await other.exec(`INSERT INTO public.organization_memberships VALUES ('${QUANLY}','${ORG_B}','ACTIVE')`);
      await expect(myRooms(other, QUANLY)).rejects.toThrow(/my_available_rooms_org_required/);
    } finally { await other.close(); }
  });

  it('công ty không thuộc ⇒ 42501; chưa đăng nhập ⇒ NULL', async () => {
    await expect(myRooms(db, QUANLY, ORG_B)).rejects.toThrow(/my_available_rooms_not_member/);
    expect((await asUser<{ p: unknown }>(db, null, 'SELECT public.get_my_available_rooms() p')).rows[0].p).toBeNull();
  });
});

describe('bảng nội bộ: cài đặt chung theo công ty, quyền sửa theo phân quyền', () => {
  const inv = async (uid: string) => (await asUser<{ p: Record<string, unknown> }>(db, uid, 'SELECT public.get_sale_room_inventory_v1($1) p', [ORG])).rows[0].p;
  it('settings_owner_id, chính sách, hotline theo người đứng tên chung; quản lý có manage_settings được sửa', async () => {
    const q = await inv(QUANLY);
    expect(q).toMatchObject({ settings_owner_id: CHU, can_manage_account_settings: true, sale_policy: 'Điện 3.500/kWh',
      contact: { name: 'Hotline chung', phone: '0911111111' } });
    expect((await inv(VIEWER)).can_manage_account_settings).toBe(false);
    expect((await inv(CHU)).can_manage_account_settings).toBe(true); // super admin giữ đường cũ
  });
  it('công ty lẫn nhiều người đứng tên ⇒ không ai sửa được cài đặt chung (không đoán chủ)', async () => {
    const other = await freshDb();
    try {
      await other.exec(behaviourSql);
      await other.exec(`UPDATE public.buildings SET user_id='${QUANLY}' WHERE id='${TOA_AO}'`);
      const p = (await asUser<{ p: Record<string, unknown> }>(other, QUANLY, 'SELECT public.get_sale_room_inventory_v1($1) p', [ORG])).rows[0].p;
      expect(p).toMatchObject({ settings_owner_id: null, can_manage_account_settings: false, sale_policy: null, contact: null });
      await expect(save(other, QUANLY, null, 10)).rejects.toThrow(/public_room_settings_owner_ambiguous/);
    } finally { await other.close(); }
  });
});

describe('cài đặt chung: đọc / lưu có kiểm quyền và CAS', () => {
  it('quản lý có quyền đọc đúng dòng của chủ (kèm hotline của chủ) và lưu được; chủ đọc lại thấy số mới', async () => {
    const s = await settingsOf(db, QUANLY);
    expect(s).toMatchObject({ owner_id: CHU, soon_days: 16, sale_policy: 'Điện 3.500/kWh', can_manage: true, exists: true });
    expect((s.hotlines as Array<{ id: string }>).map(h => h.id)).toEqual([HOT_CHU]);
    const saved = (await save(db, QUANLY, String(s.updated_at), 20, HOT_CHU)).rows[0].s;
    expect(saved).toMatchObject({ owner_id: CHU, soon_days: 20, hotline_id: HOT_CHU, sale_policy: 'Chính sách mới', changed: true });
    expect(await settingsOf(db, CHU)).toMatchObject({ soon_days: 20, hotline_id: HOT_CHU });
    expect((await page(db, 'demo'))?.sale_policy).toBe('Chính sách mới');
    expect((await page(db, 'demo'))?.rooms.find(r => r.id === P_45)?.avail_date).toBe('2026-01-21');
  });

  it('người lưu sau bằng bản cũ bị báo «đã có người sửa» (PT409); gửi lại đúng giá trị đã lưu thì trả như cũ', async () => {
    const before = await settingsOf(db, CHU);
    await save(db, CHU, String(before.updated_at), 21);
    await expect(save(db, QUANLY, String(before.updated_at), 25)).rejects.toMatchObject({ code: 'PT409' });
    expect((await settingsOf(db, QUANLY)).soon_days).toBe(21);
    const again = (await save(db, QUANLY, String(before.updated_at), 21)).rows[0].s;
    expect(again).toMatchObject({ soon_days: 21, changed: false });
  });

  it('hotline của người khác (không phải chủ cài đặt chung) bị từ chối; số ngày sai bị từ chối', async () => {
    const s = await settingsOf(db, QUANLY);
    await expect(save(db, QUANLY, String(s.updated_at), 10, HOT_QL)).rejects.toThrow(/public_room_settings_hotline_invalid/);
    await expect(save(db, QUANLY, String(s.updated_at), 400)).rejects.toThrow(/public_room_settings_invalid/);
  });

  it('không có quyền manage_settings ⇒ 42501 khi lưu (người chỉ xem vẫn đọc được); không thuộc công ty ⇒ 42501', async () => {
    const s = await settingsOf(db, VIEWER);
    expect(s).toMatchObject({ can_manage: false, owner_id: CHU });
    await expect(save(db, VIEWER, String(s.updated_at), 10)).rejects.toThrow(/public_room_settings_permission/);
    await expect(save(db, NOPERM, String(s.updated_at), 10)).rejects.toThrow(/public_room_settings_permission/);
    await expect(settingsOf(db, NOPERM)).rejects.toThrow(/public_room_settings_permission/);
    await expect(settingsOf(db, LA)).rejects.toThrow(/public_room_settings_not_member/);
    await expect(save(db, QUANLY, null, 10, null, null, ORG_B)).rejects.toThrow(/public_room_settings_not_member/);
  });

  it('ghi thẳng bảng cài đặt bị chặn kể cả với dòng của chính mình', async () => {
    await expect(asAuthenticated(db, CHU, "UPDATE public.public_room_settings SET soon_days=1 WHERE owner_id=auth.uid()")).rejects.toThrow(/permission denied/);
    await expect(asAuthenticated(db, QUANLY, `INSERT INTO public.public_room_settings(owner_id, soon_days) VALUES ('${QUANLY}', 1)`)).rejects.toThrow(/permission denied/);
    expect((await asAuthenticated<{ n: number }>(db, CHU, 'SELECT count(*)::int n FROM public.public_room_settings')).rows[0].n).toBe(1);
  });
});

describe('link chia sẻ của công ty: xem / đổi nhãn / thu hồi / khôi phục / xoá có kiểm quyền', () => {
  it('người có manage_tokens thấy mọi link của công ty kèm người tạo (không thấy link công ty khác)', async () => {
    const list = (await asUser<{ l: Array<Record<string, unknown>> }>(db, QUANLY, 'SELECT public.list_public_room_tokens_v1($1) l', [ORG])).rows[0].l;
    expect(list.map(t => t.token)).toEqual(['cua-quan-ly', 'demo']);
    expect(list.find(t => t.token === 'demo')).toMatchObject({ owner_id: CHU, owner_name: 'Anh Chủ', revoked: false, organization_id: ORG });
    await expect(asUser(db, VIEWER, 'SELECT public.list_public_room_tokens_v1($1)', [ORG])).rejects.toThrow(/public_room_token_permission/);
    await expect(asUser(db, LA, 'SELECT public.list_public_room_tokens_v1($1)', [ORG])).rejects.toThrow(/public_room_token_not_member/);
  });

  it('quản lý đổi nhãn, thu hồi, khôi phục link của người khác; xoá link; xoá lại link đã xoá thì removed=false', async () => {
    expect((await manage(db, QUANLY, 'demo', 'rename', '  Danh sách phòng trống  ')).rows[0].r).toMatchObject({ token: 'demo', label: 'Danh sách phòng trống', removed: false });
    expect((await manage(db, QUANLY, 'demo', 'revoke')).rows[0].r).toMatchObject({ revoked: true });
    expect(await page(db, 'demo')).toBeNull();
    expect((await manage(db, QUANLY, 'demo', 'restore')).rows[0].r).toMatchObject({ revoked: false });
    await db.exec(`INSERT INTO public.public_room_share_tokens(token, owner_id, organization_id) VALUES ('xoa-thu','${CHU}','${ORG}')`);
    expect((await manage(db, QUANLY, 'xoa-thu', 'delete')).rows[0].r).toMatchObject({ token: 'xoa-thu', removed: true, owner_name: 'Anh Chủ' });
    expect((await manage(db, QUANLY, 'xoa-thu', 'delete')).rows[0].r).toEqual({ token: 'xoa-thu', removed: false });
  });

  it('link của công ty khác: không thấy (P0002), không đổi; thiếu quyền ⇒ 42501; thao tác lạ ⇒ 22023', async () => {
    await expect(manage(db, QUANLY, 'cong-ty-b', 'revoke')).rejects.toMatchObject({ code: 'P0002' });
    expect((await manage(db, QUANLY, 'cong-ty-b', 'delete')).rows[0].r).toEqual({ token: 'cong-ty-b', removed: false });
    expect((await db.query<{ revoked: boolean }>("SELECT revoked FROM public.public_room_share_tokens WHERE token='cong-ty-b'")).rows).toEqual([{ revoked: false }]);
    await expect(manage(db, VIEWER, 'demo', 'revoke')).rejects.toThrow(/public_room_token_permission/);
    await expect(manage(db, NOPERM, 'demo', 'delete')).rejects.toThrow(/public_room_token_permission/);
    await expect(manage(db, QUANLY, 'demo', 'truncate')).rejects.toThrow(/public_room_token_invalid/);
  });

  it('ghi thẳng bảng link (UPDATE/DELETE) bị chặn kể cả link của chính mình; vẫn đọc được link của mình', async () => {
    await expect(asAuthenticated(db, CHU, "UPDATE public.public_room_share_tokens SET revoked=true WHERE token='demo'")).rejects.toThrow(/permission denied/);
    await expect(asAuthenticated(db, QUANLY, "DELETE FROM public.public_room_share_tokens WHERE token='cua-quan-ly'")).rejects.toThrow(/permission denied/);
    expect((await asAuthenticated<{ n: number }>(db, QUANLY, 'SELECT count(*)::int n FROM public.public_room_share_tokens')).rows[0].n).toBe(1);
  });
});

describe('sau review 25/11: cài đặt theo công ty, quyền phạm vi công ty, khoá người đứng tên, guard dữ liệu', () => {
  it('người đứng tên chung ở HAI công ty: trang công ty B không đọc cài đặt / hotline của công ty A; lưu cho B ⇒ 55000', async () => {
    const other = await freshDb();
    try {
      await other.exec(behaviourSql);
      // Nick chủ đứng tên luôn toà công ty B (là thành viên B): dòng cài đặt của nick chủ thuộc công ty A.
      await other.exec(`UPDATE public.buildings SET user_id='${CHU}' WHERE organization_id='${ORG_B}'`);
      const b = await page(other, 'cong-ty-b');
      expect(b).toMatchObject({ sale_policy: null, contact: null });
      expect(roomIds(b)).toEqual([P_B]);
      const inv = (await asUser<{ p: Record<string, unknown> }>(other, CHU, 'SELECT public.get_sale_room_inventory_v1($1) p', [ORG_B])).rows[0].p;
      expect(inv).toMatchObject({ settings_owner_id: CHU, sale_policy: null, contact: null });
      expect(await settingsOf(other, CHU, ORG_B)).toMatchObject({ owner_id: CHU, exists: false, soon_days: 30, sale_policy: null, hotlines: [] });
      await expect(save(other, CHU, null, 10, null, 'x', ORG_B)).rejects.toThrow(/public_room_settings_owner_other_org/);
      // Công ty A vẫn đọc đúng dòng của mình.
      expect((await page(other, 'demo'))?.sale_policy).toBe('Điện 3.500/kWh');
    } finally { await other.close(); }
  });

  it('quyền Cài đặt hiển thị chỉ theo TOÀ: đọc được, không lưu được cài đặt chung (cờ can_manage false)', async () => {
    const s = await settingsOf(db, QL_TOA);
    expect(s).toMatchObject({ owner_id: CHU, can_manage: false });
    await expect(save(db, QL_TOA, String(s.updated_at), 12)).rejects.toThrow(/public_room_settings_permission/);
    const inv = (await asUser<{ p: Record<string, unknown> }>(db, QL_TOA, 'SELECT public.get_sale_room_inventory_v1($1) p', [ORG])).rows[0].p;
    expect(inv.can_manage_account_settings).toBe(false);
  });

  it('quyền Quản lý link chỉ theo TOÀ: xem mọi link, sửa link của mình; link người khác ⇒ 42501 (cờ can_manage false)', async () => {
    await db.exec(`INSERT INTO public.public_room_share_tokens(token, owner_id, label, organization_id) VALUES ('cua-ql-toa','${QL_TOA}','Link QL toà','${ORG}')
      ON CONFLICT (token) DO NOTHING`);
    const list = (await asUser<{ l: Array<Record<string, unknown>> }>(db, QL_TOA, 'SELECT public.list_public_room_tokens_v1($1) l', [ORG])).rows[0].l;
    expect(Object.fromEntries(list.map(t => [t.token, t.can_manage]))).toMatchObject({ 'cua-ql-toa': true, demo: false, 'cua-quan-ly': false });
    expect((await manage(db, QL_TOA, 'cua-ql-toa', 'rename', 'Đổi được')).rows[0].r).toMatchObject({ label: 'Đổi được' });
    for (const action of ['rename', 'revoke', 'delete']) {
      await expect(manage(db, QL_TOA, 'demo', action, 'x')).rejects.toThrow(/public_room_token_permission_org/);
    }
    expect((await db.query<{ revoked: boolean }>("SELECT revoked FROM public.public_room_share_tokens WHERE token='demo'")).rows).toEqual([{ revoked: false }]);
    // Quản lý có quyền phạm vi công ty: cờ true với mọi link.
    const full = (await asUser<{ l: Array<Record<string, unknown>> }>(db, QUANLY, 'SELECT public.list_public_room_tokens_v1($1) l', [ORG])).rows[0].l;
    expect(full.every(t => t.can_manage === true)).toBe(true);
    expect((await manage(db, QL_TOA, 'cua-ql-toa', 'delete')).rows[0].r).toMatchObject({ removed: true });
  });

  it('client không đổi được người đứng tên toà (42501); sửa cột khác hoặc gửi lại đúng người cũ vẫn được; mã máy chủ đổi được', async () => {
    await db.exec('GRANT USAGE ON SCHEMA public TO authenticated; GRANT SELECT, UPDATE ON public.buildings TO authenticated');
    await expect(asAuthenticated(db, QUANLY, `UPDATE public.buildings SET user_id='${QUANLY}' WHERE id='${TOA_A1}'`)).rejects.toThrow(/building_owner_locked/);
    await asAuthenticated(db, QUANLY, `UPDATE public.buildings SET name='A1 toà chủ', user_id='${CHU}' WHERE id='${TOA_A1}'`);
    expect(await ownerOf(db, TOA_A1)).toBe(CHU);
    await db.exec(`UPDATE public.buildings SET user_id='${QUANLY}' WHERE id='${TOA_A1}'; UPDATE public.buildings SET user_id='${CHU}' WHERE id='${TOA_A1}'`);
    expect(await ownerOf(db, TOA_A1)).toBe(CHU);
  });

  it('khối dữ liệu dừng (55000) khi 45/3 TTT còn tin pass đang bật đứng tên người khác nick chủ', async () => {
    const other = await freshDb();
    try {
      await other.exec(`INSERT INTO public.room_pass_listings VALUES ('${id(502)}','${P_45}','${NATHAN}','${ORG}',true,false,'Khách','0900000001',NULL,NULL,NULL)`);
      await expect(other.exec(behaviourSql)).rejects.toThrow(/còn tin pass đang bật/);
      expect(await ownerOf(other, TOA_45)).toBe(NATHAN);
    } finally { await other.close(); }
  });

  it('admin/super admin tạo toà ở công ty mà người đứng tên chung là tài khoản demo ⇒ giữ người tạo', async () => {
    await db.query("SELECT set_config('test.demo_users', $1, false)", [CHU_B]);
    try {
      await asUser(db, QUANLY, `INSERT INTO public.buildings(id, organization_id, name) VALUES ('${id(722)}','${ORG_B}','Toà người thường ở công ty demo')`);
      expect(await ownerOf(db, id(722))).toBe(CHU_B);
      await asUser(db, CHU, `INSERT INTO public.buildings(id, organization_id, name) VALUES ('${id(721)}','${ORG_B}','Toà super admin ở công ty demo')`);
      expect(await ownerOf(db, id(721))).toBe(CHU);
    } finally {
      await db.query("SELECT set_config('test.demo_users', '', false)");
      await db.exec(`DELETE FROM public.buildings WHERE id IN ('${id(721)}','${id(722)}')`);
    }
  });

  it('«Phòng trống» người không thuộc công ty nào ⇒ 42501 my_available_rooms_not_member (không phải «nhiều công ty»)', async () => {
    await expect(myRooms(db, LA)).rejects.toThrow(/my_available_rooms_not_member/);
  });
});

describe('quyền gọi hàm', () => {
  const can = async (role: string, fn: string) =>
    (await db.query<{ v: boolean }>('SELECT has_function_privilege($1, $2, \'EXECUTE\') v', [role, fn])).rows[0].v;
  it('RPC web: authenticated; anon không; hàm riêng: không vai API nào; chỉ còn một bản get_my_available_rooms', async () => {
    for (const fn of ['public.get_my_available_rooms(uuid)', 'public.get_public_room_settings_v1(uuid)',
      'public.save_public_room_settings_v1(uuid,timestamptz,integer,boolean,uuid,text)', 'public.list_public_room_tokens_v1(uuid)',
      'public.manage_public_room_token_v1(uuid,text,text,text)']) {
      expect(await can('authenticated', fn)).toBe(true);
      expect(await can('anon', fn)).toBe(false);
    }
    for (const fn of ['app_private.org_building_owner_v1(uuid)', 'app_private.sale_org_permission_v1(uuid,text)',
      'app_private.public_room_settings_json_v1(uuid)', 'app_private.buildings_nguoi_dung_ten_theo_cong_ty_v1()',
      'app_private.sale_org_wide_permission_v1(uuid,text)', 'app_private.buildings_khoa_nguoi_dung_ten_v1()']) {
      for (const role of ['anon', 'authenticated', 'service_role']) expect(await can(role, fn)).toBe(false);
    }
    expect((await db.query("SELECT 1 FROM pg_proc WHERE proname='get_my_available_rooms'")).rows).toHaveLength(1);
  });
});

describe('tiền kiểm và hậu kiểm md5 của file migration', () => {
  const bodyMd5 = (name: string) => {
    const m = new RegExp(`CREATE OR REPLACE FUNCTION ${name.replace('.', '\\.')}\\([\\s\\S]*?AS \\$fn\\$([\\s\\S]*?)\\$fn\\$`).exec(sql);
    if (!m) throw new Error(name);
    return createHash('md5').update(m[1]).digest('hex');
  };
  it('mỗi md5 ghim trong file là md5 đúng thân của file', () => {
    const post = /DO \$sau\$[\s\S]*?\$sau\$;/.exec(sql)![0];
    const pins = [...post.matchAll(/\('((?:public|app_private)\.\w+)\([^']*\)', '([0-9a-f]{32})'\)/g)];
    expect(pins.length).toBe(17);
    for (const [, name, pin] of pins) expect(pin, name).toBe(bodyMd5(name));
    const pre = /DO \$truoc\$[\s\S]*?\$truoc\$;/.exec(sql)![0];
    for (const name of ['public.get_public_available_rooms', 'app_private.public_sale_rooms_payload_v1', 'public.hermes_available_rooms_page_v1',
      'public.zalo_sale_advice_delivery_v1', 'public.get_sale_room_inventory_v1', 'public.get_my_available_rooms']) {
      expect(pre.includes(`'${bodyMd5(name)}'`), name).toBe(true);
    }
  });

  it('thân đang chạy khác thân đã rà ⇒ dừng ngay ở tiền kiểm, không ghi gì', async () => {
    const other = await freshDb();
    try {
      await expect(other.exec(sql)).rejects.toThrow(/KHÁC thân đã rà/);
      expect(await ownerOf(other, TOA_45)).toBe(NATHAN);
      expect((await other.query("SELECT 1 FROM pg_proc WHERE proname='org_building_owner_v1'")).rows).toHaveLength(0);
    } finally { await other.close(); }
  });

  it('chạy lại CẢ FILE sau khi đã áp: tiền kiểm nhận thân của file, hậu kiểm (thân, quyền, bảng, trigger, 45/3 TTT) đạt', async () => {
    await db.exec(sql);
    expect(await ownerOf(db, TOA_45)).toBe(CHU);
  });
});
