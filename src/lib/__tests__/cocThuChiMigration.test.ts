import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEPOSIT_AMOUNT_SERVER_MESSAGE } from '../incomeExpenseValidation';

// Mỗi ca dựng CSDL PGlite riêng mất 10–20 giây trên máy chậm.
vi.setConfig({ testTimeout: 120_000 });

// Sale phòng đợt 3 «Cọc ở Thu chi», phạm vi rút gọn sau #499 (20261125165113): constraint trigger chặn phiếu THU chưa gắn
// HĐ có hạng mục cọc mà tổng tiền cọc ≤ 0 (chạy TRƯỚC bind_unlinked_deposit_income của #499); khối «đang giữ bằng cọc»
// (deposit_hold) theo đợt giữ chỗ của #499 ở hai reader nội bộ, link công khai không đổi. Fixture là fixture của đợt 2
// (20261125034429) + bảng phiếu thu chi / đợt giữ chỗ tối thiểu và THÂN PRODUCTION của room_has_holding_deposit /
// ie_has_deposit_item / reservation_deposit_is_settled_v1; fact phòng giản lược coi phòng có phiếu cọc giữ phòng hoặc đợt
// giữ chỗ sống là 'rented' như production. Dựng thân hai reader như production: file đợt 2 (bỏ khối md5 của nó) rồi khối
// vá $inventory$ của #499 (20261125133852), rồi file đợt 3 (tiền kiểm ghim md5 production sau #499).
const FILE = 'supabase/migrations/20261125165113_coc_thu_chi_chan_0d_va_khoi_da_coc_tren_dot_giu_cho.sql';
const DOT2 = 'supabase/migrations/20261125034429_sale_phong_theo_cong_ty.sql';
const PR499 = 'supabase/migrations/20261125133852_unified_deposit_voucher_workflow.sql';
const sql = readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');
// Ca hành vi chạy file KHÔNG có hậu kiểm md5 (đột biến thân hàm phải làm đỏ ca hành vi, không chỉ ca md5); hậu kiểm chạy
// riêng ở ca «chạy lại CẢ FILE».
const behaviourSql = sql.replace(/DO \$sau\$[\s\S]*?\$sau\$;/, '');
const dot2Sql = readFileSync(DOT2, 'utf8').replace(/\r\n/g, '\n')
  .replace(/DO \$truoc\$[\s\S]*?\$truoc\$;/, '').replace(/DO \$sau\$[\s\S]*?\$sau\$;/, '');
// Đúng khối #499 đã dùng để thêm has_deposit_hold vào hai reader trên production.
const pr499InventorySql = /DO \$inventory\$[\s\S]*?\$inventory\$;/.exec(readFileSync(PR499, 'utf8').replace(/\r\n/g, '\n'))![0];

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = id(101), ORG_B = id(102);
const CHU = id(1); // đứng tên mọi toà
const SALE = id(2); // nhân viên xem trang Sale phạm vi công ty
const LA = id(5); // không thuộc công ty
const TOA = id(201), TOA_B = id(202);
const P_TRONG = id(301), P_COC = id(302), P_HAI = id(303), P_CU = id(304), P_THUE = id(305), P_THU = id(306), P_B = id(307);
const P_DOT = id(308), P_DOT0 = id(309); // phòng giữ bằng đợt giữ chỗ (#499): có hai phiếu / đợt cũ không phiếu
const DOT = id(901), DOT0 = id(902), KHACH_DB = id(903);
const T_COC = id(401), T_THUE = id(402), T_HOAN = id(403);
const KHACH = id(501), HD_CU = id(601), HD_KHAC = id(602);

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
  CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
  CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
  -- Tài khoản demo theo cấu hình test (test.demo_users, phân cách dấu phẩy).
  CREATE FUNCTION public.demo_user_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$
    SELECT COALESCE(string_to_array(NULLIF(current_setting('test.demo_users', true), ''), ',')::uuid[], '{}'::uuid[]) $$;
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
  -- Phiếu thu chi tối thiểu cho luật cọc. amount do trigger BEFORE tính lại như production (auto_calc_item_amount).
  CREATE TABLE public.tenants(id uuid PRIMARY KEY, full_name text);
  CREATE TABLE public.contracts(id uuid PRIMARY KEY, organization_id uuid, room_id uuid, status text, start_date date,
    actual_end_date date, expected_move_out_date date, deleted_at timestamptz);
  CREATE TABLE public.deposits(id uuid PRIMARY KEY, room_id uuid, contract_id uuid, status text, deleted_at timestamptz);
  CREATE TABLE public.income_expense_types(id uuid PRIMARY KEY, name text, type text, is_deposit boolean NOT NULL DEFAULT false);
  CREATE TABLE public.income_expenses(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, code text, type text NOT NULL,
    name text, room_id uuid, contract_id uuid, tenant_id uuid, payer_name text, voucher_date date NOT NULL DEFAULT DATE '2026-11-25',
    approval_status text, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.income_expense_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    income_expense_id uuid NOT NULL REFERENCES public.income_expenses(id) ON DELETE CASCADE,
    income_expense_type_id uuid, quantity numeric NOT NULL DEFAULT 1, unit_price numeric NOT NULL DEFAULT 0, amount numeric);
  CREATE TABLE public.reservation_deposit_settlements(source_voucher_id uuid);
  -- Đợt giữ chỗ của #499 (bảng tối thiểu).
  CREATE TABLE public.customers(id uuid PRIMARY KEY, full_name text);
  CREATE TABLE public.room_reservations(id uuid PRIMARY KEY, organization_id uuid, building_id uuid, room_id uuid, customer_id uuid,
    status text, customer_hint text, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.room_next_claims(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, room_id uuid, reservation_id uuid, status text);
  CREATE TABLE public.reservation_receipts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, reservation_id uuid,
    source_voucher_id uuid, source_item_id uuid);
  CREATE FUNCTION app_private.org_timezone_v1(uuid) RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'Asia/Ho_Chi_Minh' $$;
  -- Có mặt để tiền kiểm biết #499 đã áp (thân thật không dùng ở đây).
  CREATE FUNCTION app_private.attach_deposit_income_v1(uuid, jsonb, uuid, uuid[]) RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
  -- Mô phỏng bind_unlinked_deposit_income của #499: trigger hoãn trên dòng phiếu, từ chối cọc ≤ 0 bằng câu 22023. Luật đợt 3
  -- phải chạy TRƯỚC nó (người dùng thấy câu «Phiếu cọc phải có số tiền lớn hơn 0; …»).
  CREATE FUNCTION app_private.bind_unlinked_deposit_income_v1() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE v public.income_expenses%ROWTYPE;
  BEGIN
    SELECT * INTO v FROM public.income_expenses WHERE id = NEW.income_expense_id;
    IF v.id IS NULL OR v.type <> 'INCOME' OR v.deleted_at IS NOT NULL OR v.contract_id IS NOT NULL OR v.approval_status = 'CANCELLED' THEN RETURN NULL; END IF;
    IF (SELECT COALESCE(sum(i.amount), 0) FROM public.income_expense_items i JOIN public.income_expense_types t ON t.id = i.income_expense_type_id
        WHERE i.income_expense_id = v.id AND t.is_deposit) <= 0 AND EXISTS (SELECT 1 FROM public.income_expense_items i
        JOIN public.income_expense_types t ON t.id = i.income_expense_type_id WHERE i.income_expense_id = v.id AND t.is_deposit) THEN
      RAISE EXCEPTION 'Phiếu % thiếu dòng cọc hợp lệ', v.code USING ERRCODE = '22023';
    END IF;
    RETURN NULL;
  END $$;
  CREATE FUNCTION public.auto_calc_item_amount() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN NEW.amount := round(NEW.quantity * NEW.unit_price, 2); RETURN NEW; END $$;
  CREATE TRIGGER trigger_auto_calc_item_amount BEFORE INSERT OR UPDATE ON public.income_expense_items
    FOR EACH ROW EXECUTE FUNCTION public.auto_calc_item_amount();
  -- Ngày của công ty cố định để số ngày giữ đoán trước được.
  CREATE FUNCTION public.org_today_v1(p_organization_id uuid DEFAULT NULL) RETURNS date LANGUAGE sql STABLE AS $$ SELECT DATE '2026-11-25' $$;
  -- Thân production (đo 25/11/2026, nguyên văn: tiền kiểm ghim md5 của room_has_holding_deposit).
  CREATE FUNCTION public.ie_has_deposit_item(p_ie_id uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public' AS $body$
  SELECT EXISTS (
    SELECT 1
    FROM income_expense_items it
    JOIN income_expense_types t ON t.id = it.income_expense_type_id
    WHERE it.income_expense_id = p_ie_id
      AND t.is_deposit = TRUE
  );
$body$;
  CREATE FUNCTION app_private.reservation_deposit_is_settled_v1(p_voucher_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'pg_catalog', 'public' AS $body$
  SELECT EXISTS(SELECT 1 FROM public.reservation_deposit_settlements WHERE source_voucher_id=p_voucher_id)
$body$;
  CREATE FUNCTION public.room_has_holding_deposit(p_room_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'public' AS $body$
  SELECT p_room_id IS NOT NULL AND (
    EXISTS (
      SELECT 1 FROM public.deposits d
      WHERE d.room_id = p_room_id
        AND d.deleted_at IS NULL
        AND d.contract_id IS NULL
        AND d.status IN ('PENDING','CONFIRMED')
    )
    OR EXISTS (
      SELECT 1 FROM public.income_expenses ie
      WHERE ie.room_id = p_room_id
        AND ie.deleted_at IS NULL
        AND ie.contract_id IS NULL
        AND ie.type = 'INCOME'
        AND COALESCE(ie.approval_status, '') <> 'CANCELLED'
        AND public.ie_has_deposit_item(ie.id)
        AND NOT app_private.reservation_deposit_is_settled_v1(ie.id)
    )
  );
$body$;
  -- Fact phòng giản lược, đoán trước được: có phiếu cọc giữ phòng ⇒ rented (room_has_holding_deposit thật), AVAILABLE ⇒ free, NOTICE ⇒ soon (avail_date = 2026-01-01 + số ngày sắp trống
  -- được dùng ⇒ test thấy số ngày lấy theo ai), có tin pass ⇒ pass, còn lại ⇒ rented.
  CREATE FUNCTION app_private.room_sale_workflow_fact_v1(p_room_id uuid, p_organization_id uuid, p_room_status text, p_has_pass boolean, p_soon_days integer)
  RETURNS TABLE(status_public text, sale_state text, avail_date date, sale_today date, expected_ready_on date) LANGUAGE sql STABLE AS $$
    SELECT CASE WHEN public.room_has_holding_deposit(p_room_id) OR EXISTS (SELECT 1 FROM public.room_next_claims c WHERE c.room_id = p_room_id AND c.status = 'LIVE') THEN 'rented' WHEN p_has_pass THEN 'pass' WHEN p_room_status='AVAILABLE' THEN 'free' WHEN p_room_status='NOTICE' THEN 'soon' ELSE 'rented' END,
      CASE WHEN public.room_has_holding_deposit(p_room_id) OR EXISTS (SELECT 1 FROM public.room_next_claims c WHERE c.room_id = p_room_id AND c.status = 'LIVE') THEN 'RENTED' WHEN p_has_pass THEN 'PASS' WHEN p_room_status='AVAILABLE' THEN 'READY' WHEN p_room_status='NOTICE' THEN 'NOTICE' ELSE 'RENTED' END,
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

const V = { COC: id(701), H1: id(702), H2: id(703), CU: id(704), HUY: id(705), XOA: id(706), GAN_HD: id(707), QUYET_TOAN: id(708),
  CHI: id(709), DEMO: id(710), D1: id(711), D2: id(712) };
const seed = `
  INSERT INTO public.organizations(id) VALUES ('${ORG}'),('${ORG_B}');
  INSERT INTO public.organization_memberships VALUES ('${CHU}','${ORG}','ACTIVE'),('${SALE}','${ORG}','ACTIVE'),('${CHU}','${ORG_B}','ACTIVE');
  INSERT INTO public.profiles VALUES ('${CHU}','Anh Chủ'),('${SALE}','Sale Một');
  INSERT INTO app_private.test_grants VALUES ('${SALE}','${ORG}','sale_phong.view',true,'{}'),('${SALE}','${ORG}','rooms.view',true,'{}'),
    ('${CHU}','${ORG}','rooms.view',true,'{}'),('${CHU}','${ORG_B}','rooms.view',true,'{}');
  INSERT INTO public.buildings(id, organization_id, user_id, name) VALUES ('${TOA}','${ORG}','${CHU}','Toà A'),('${TOA_B}','${ORG_B}','${CHU}','Toà B');
  INSERT INTO public.rooms(id, organization_id, building_id, floor, name, code, area, rent_price, deposit_amount, max_occupants, amenities, images,
      description, sale_note, room_type, status) VALUES
    ('${P_TRONG}','${ORG}','${TOA}',1,'101','101',20,4000000,4000000,2,'[]','["a.jpg"]',NULL,NULL,'Studio','AVAILABLE'),
    ('${P_COC}','${ORG}','${TOA}',1,'102','102',20,4000000,4000000,2,'[]','["b.jpg"]',NULL,NULL,'Studio','AVAILABLE'),
    ('${P_HAI}','${ORG}','${TOA}',1,'103','103',20,4000000,4000000,2,'[]','[]',NULL,NULL,'Studio','AVAILABLE'),
    ('${P_CU}','${ORG}','${TOA}',2,'201','201',25,5000000,5000000,2,'[]','[]',NULL,NULL,'1PN','OCCUPIED'),
    ('${P_THUE}','${ORG}','${TOA}',2,'202','202',25,5000000,5000000,2,'[]','[]',NULL,NULL,'1PN','OCCUPIED'),
    ('${P_THU}','${ORG}','${TOA}',3,'301','301',18,3500000,3500000,1,'[]','[]',NULL,NULL,'Studio','AVAILABLE'),
    ('${P_B}','${ORG_B}','${TOA_B}',1,'B101','B101',30,6000000,6000000,3,'[]','[]',NULL,NULL,NULL,'AVAILABLE'),
    ('${P_DOT}','${ORG}','${TOA}',4,'401','401',20,4000000,4000000,2,'[]','[]',NULL,NULL,'Studio','AVAILABLE'),
    ('${P_DOT0}','${ORG}','${TOA}',4,'402','402',20,4000000,4000000,2,'[]','[]',NULL,NULL,'Studio','AVAILABLE');
  INSERT INTO public.public_room_settings(owner_id, organization_id, soon_days) VALUES ('${CHU}','${ORG}',16);
  INSERT INTO public.public_room_share_tokens(token, owner_id, label, organization_id) VALUES ('demo','${CHU}','Demo','${ORG}');
  INSERT INTO public.tenants VALUES ('${KHACH}','Nguyễn Văn Khách');
  INSERT INTO public.contracts VALUES ('${HD_CU}','${ORG}','${P_CU}','ACTIVE','2025-01-01',NULL,NULL,NULL),
    ('${HD_KHAC}','${ORG}','${P_THU}','TERMINATED','2024-01-01','2024-12-31',NULL,NULL);
  INSERT INTO public.income_expense_types VALUES ('${T_COC}','Tiền Cọc','income',true),('${T_THUE}','Tiền thuê','income',false),
    ('${T_HOAN}','Hoàn cọc','expense',true);
  INSERT INTO public.income_expenses(id, organization_id, code, type, room_id, contract_id, tenant_id, payer_name, voucher_date, approval_status, deleted_at, created_at) VALUES
    ('${V.COC}','${ORG}','PT2611001','INCOME','${P_COC}',NULL,NULL,'Chị Lan','2026-11-05','APPROVED',NULL,'2026-11-05T03:00:00Z'),
    ('${V.H1}','${ORG}','PT2611002','INCOME','${P_HAI}',NULL,'${KHACH}','  ','2026-11-01','UNAPPROVED',NULL,'2026-11-01T03:00:00Z'),
    ('${V.H2}','${ORG}','PT2611003','INCOME','${P_HAI}',NULL,NULL,'Anh Minh','2026-11-20','APPROVED',NULL,'2026-11-20T03:00:00Z'),
    ('${V.CU}','${ORG}','PT2605004','INCOME','${P_CU}',NULL,NULL,'Khách cũ','2026-05-27','APPROVED',NULL,'2026-05-27T03:00:00Z'),
    ('${V.HUY}','${ORG}','PT2611005','INCOME','${P_THU}',NULL,NULL,'Đã huỷ','2026-11-02','CANCELLED',NULL,'2026-11-02T03:00:00Z'),
    ('${V.XOA}','${ORG}','PT2611006','INCOME','${P_THU}',NULL,NULL,'Đã xoá','2026-11-02','APPROVED','2026-11-03','2026-11-02T03:00:00Z'),
    ('${V.GAN_HD}','${ORG}','PT2611007','INCOME','${P_THU}','${HD_KHAC}',NULL,'Gắn HĐ','2026-11-02','APPROVED',NULL,'2026-11-02T03:00:00Z'),
    ('${V.QUYET_TOAN}','${ORG}','PT2611008','INCOME','${P_THU}',NULL,NULL,'Đã quyết toán','2026-11-02','APPROVED',NULL,'2026-11-02T03:00:00Z'),
    ('${V.CHI}','${ORG}','PC2611009','EXPENSE','${P_THU}',NULL,NULL,'Hoàn cọc','2026-11-02','APPROVED',NULL,'2026-11-02T03:00:00Z'),
    ('${V.DEMO}','${ORG_B}','PT2608001','INCOME','${P_B}',NULL,NULL,NULL,'2026-08-10','APPROVED',NULL,'2026-08-13T03:00:00Z');
  INSERT INTO public.income_expense_items(income_expense_id, income_expense_type_id, quantity, unit_price) VALUES
    ('${V.COC}','${T_COC}',1,2000000),('${V.H1}','${T_COC}',1,1000000),('${V.H2}','${T_COC}',1,500000),('${V.CU}','${T_COC}',1,3000000),
    ('${V.HUY}','${T_COC}',1,1000000),('${V.XOA}','${T_COC}',1,1000000),('${V.GAN_HD}','${T_COC}',1,1000000),
    ('${V.QUYET_TOAN}','${T_COC}',1,1000000),('${V.CHI}','${T_HOAN}',1,1000000);
  -- Bộ dữ liệu mẫu Demo (20260812010000): dòng cọc chỉ ghi amount, unit_price mặc định 0 ⇒ trigger tính lại amount = 0.
  INSERT INTO public.income_expense_items(income_expense_id, income_expense_type_id, amount) VALUES ('${V.DEMO}','${T_COC}',6000000);
  INSERT INTO public.reservation_deposit_settlements VALUES ('${V.QUYET_TOAN}');
  -- Đợt giữ chỗ (#499) phòng 401: hai lần thu, người gửi khác nhau; phiếu thứ ba đã huỷ không tính. Đợt cũ phòng 402 không
  -- có phiếu (giữ chỗ 0 đ thời kỳ trước), khách trong danh bạ.
  INSERT INTO public.customers VALUES ('${KHACH_DB}','Khách Danh Bạ');
  INSERT INTO public.room_reservations(id, organization_id, building_id, room_id, customer_id, status, customer_hint, created_at) VALUES
    ('${DOT}','${ORG}','${TOA}','${P_DOT}',NULL,'HOLD','Chị Hoa','2026-11-10T02:00:00Z'),
    ('${DOT0}','${ORG}','${TOA}','${P_DOT0}','${KHACH_DB}','HOLD',NULL,'2026-11-01T18:00:00Z');
  INSERT INTO public.room_next_claims(organization_id, room_id, reservation_id, status) VALUES
    ('${ORG}','${P_DOT}','${DOT}','LIVE'),('${ORG}','${P_DOT0}','${DOT0}','LIVE');
  INSERT INTO public.income_expenses(id, organization_id, code, type, room_id, contract_id, payer_name, voucher_date, approval_status, created_at) VALUES
    ('${V.D1}','${ORG}','PT2611101','INCOME','${P_DOT}',NULL,'Chị Hoa','2026-11-10','APPROVED','2026-11-10T02:00:00Z'),
    ('${V.D2}','${ORG}','PT2611102','INCOME','${P_DOT}',NULL,'Anh Tú','2026-11-15','UNAPPROVED','2026-11-15T02:00:00Z'),
    ('${id(713)}','${ORG}','PT2611099','INCOME','${P_DOT}',NULL,'Đã huỷ','2026-11-09','CANCELLED','2026-11-09T02:00:00Z');
  INSERT INTO public.income_expense_items(income_expense_id, income_expense_type_id, quantity, unit_price) VALUES
    ('${V.D1}','${T_COC}',1,1000000),('${V.D2}','${T_COC}',1,2000000),('${id(713)}','${T_COC}',1,500000);
  INSERT INTO public.reservation_receipts(organization_id, reservation_id, source_voucher_id)
    SELECT '${ORG}','${DOT}',id FROM public.income_expenses WHERE id IN ('${V.D1}','${V.D2}','${id(713)}');
`;

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(fixture);
  await db.exec(seed);
  return db;
}
// Trigger mô phỏng #499 gắn SAU dữ liệu mẫu (như production: phiếu Demo 0 đ có trước #499).
const bindTriggerSql = `CREATE CONSTRAINT TRIGGER bind_unlinked_deposit_income AFTER INSERT OR UPDATE ON public.income_expense_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_private.bind_unlinked_deposit_income_v1();`;
/** CSDL ở trạng thái production trước đợt 3: đợt 2 rồi vá has_deposit_hold của #499. */
async function productionLikeDb(): Promise<PGlite> {
  const db = await freshDb();
  await db.exec(dot2Sql);
  await db.exec(pr499InventorySql);
  await db.exec(bindTriggerSql);
  return db;
}
const readerMd5 = async (db: PGlite) => Object.fromEntries((await db.query<{ fn: string; md5: string }>(
  `SELECT p.oid::regprocedure::text fn, md5(replace(p.prosrc, chr(13), '')) md5 FROM pg_proc p
    WHERE p.oid IN ('public.get_sale_room_inventory_v1(uuid,uuid,uuid)'::regprocedure, 'public.get_my_available_rooms(uuid)'::regprocedure)`)).rows
  .map(r => [r.fn, r.md5]));
async function asUser<T>(db: PGlite, uid: string | null, text: string, params: unknown[] = []) {
  await db.query("SELECT set_config('test.uid', $1, false)", [uid ?? '']);
  return db.query<T>(text, params);
}
type Hold = { source: 'hold' | 'voucher'; hold_id: string | null; voucher_id: string | null; code: string | null; codes: string[];
  voucher_date: string; payer_name: string | null; held_days: number; voucher_count: number; room_occupied: boolean };
type Room = Record<string, unknown> & { id: string; status_public: string; deposit_hold?: Hold | null };
const inventory = async (db: PGlite, uid = SALE) =>
  (await asUser<{ p: { rooms: Room[] } }>(db, uid, 'SELECT public.get_sale_room_inventory_v1($1) p', [ORG])).rows[0].p;
const myRooms = async (db: PGlite, uid = SALE) =>
  (await asUser<{ p: { rooms: Room[] } }>(db, uid, 'SELECT public.get_my_available_rooms($1::uuid) p', [ORG])).rows[0].p;
const roomOf = (p: { rooms: Room[] }, room: string) => p.rooms.find(r => r.id === room);
const holdOf = async (db: PGlite, room: string, org = ORG) =>
  (await db.query<{ h: Hold | null }>('SELECT app_private.room_deposit_hold_json_v1($1, $2) h', [org, room])).rows[0].h;

// Ghi phiếu trong MỘT giao dịch; luật chạy lúc COMMIT.
let seq = 800;
const nextId = () => id(seq++);
const ie = (v: { id: string; type?: 'INCOME' | 'EXPENSE'; room?: string; contract?: string | null; status?: string; deleted?: boolean }) =>
  `INSERT INTO public.income_expenses(id, organization_id, code, type, room_id, contract_id, approval_status, deleted_at) VALUES ('${v.id}','${ORG}',
    'PT-THU-${v.id.slice(-4)}','${v.type ?? 'INCOME'}','${v.room ?? P_THU}',${v.contract ? `'${v.contract}'` : 'NULL'},'${v.status ?? 'APPROVED'}',
    ${v.deleted ? 'now()' : 'NULL'})`;
const item = (voucher: string, type: string, unitPrice: number, itemId = nextId()) =>
  `INSERT INTO public.income_expense_items(id, income_expense_id, income_expense_type_id, quantity, unit_price) VALUES ('${itemId}','${voucher}','${type}',1,${unitPrice})`;
const tx = (db: PGlite, ...statements: string[]) => db.exec(`BEGIN; ${statements.join(';\n')}; COMMIT;`);
const exists = async (db: PGlite, voucher: string) =>
  (await db.query('SELECT 1 FROM public.income_expenses WHERE id=$1', [voucher])).rows.length === 1;
const expectBlocked = async (db: PGlite, write: Promise<unknown>) => {
  await expect(write).rejects.toMatchObject({ code: '23514', message: DEPOSIT_AMOUNT_SERVER_MESSAGE });
  await db.exec('ROLLBACK').catch(() => undefined);
};

let db: PGlite;
beforeAll(async () => {
  db = await productionLikeDb();
  await db.exec(behaviourSql);
}, 120_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => { await db.exec('RESET ROLE'); });

describe('khối «đang giữ bằng cọc» ở hai reader nội bộ (lỗi 21)', () => {
  it('đợt giữ chỗ (#499): người gửi phiếu đầu, ngày nhận phiếu đầu, các mã phiếu còn hiệu lực, số ngày giữ; giữ has_deposit_hold', async () => {
    const room = roomOf(await inventory(db), P_DOT);
    expect(room).toMatchObject({ status_public: 'rented', has_deposit_hold: true });
    expect(room?.deposit_hold).toEqual({ source: 'hold', hold_id: DOT, voucher_id: V.D1, code: 'PT2611101', codes: ['PT2611101', 'PT2611102'],
      voucher_date: '2026-11-10', payer_name: 'Chị Hoa', held_days: 15, voucher_count: 2, room_occupied: false });
  });

  it('đợt cũ không có phiếu: ngày lập đợt theo múi giờ công ty, người gửi lấy khách trong danh bạ', async () => {
    expect(roomOf(await inventory(db), P_DOT0)?.deposit_hold).toEqual({ source: 'hold', hold_id: DOT0, voucher_id: null, code: null, codes: [],
      voucher_date: '2026-11-02', payer_name: 'Khách Danh Bạ', held_days: 23, voucher_count: 0, room_occupied: false });
  });

  it('phiếu cọc chưa nối đợt: lấy theo phiếu (mã, ngày lập, người nộp, số ngày)', async () => {
    const room = roomOf(await inventory(db), P_COC);
    expect(room).toMatchObject({ status_public: 'rented', has_deposit_hold: false });
    expect(room?.deposit_hold).toEqual({ source: 'voucher', hold_id: null, voucher_id: V.COC, code: 'PT2611001', codes: ['PT2611001'],
      voucher_date: '2026-11-05', payer_name: 'Chị Lan', held_days: 20, voucher_count: 1, room_occupied: false });
  });

  it('nhiều phiếu treo chưa nối: lấy phiếu CŨ NHẤT, đếm số phiếu; người nộp trống ⇒ tên khách của phiếu', async () => {
    expect(roomOf(await inventory(db), P_HAI)?.deposit_hold).toMatchObject({ source: 'voucher', voucher_id: V.H1, code: 'PT2611002',
      codes: ['PT2611002', 'PT2611003'], voucher_date: '2026-11-01', payer_name: 'Nguyễn Văn Khách', held_days: 24, voucher_count: 2 });
  });

  it('phòng còn khách ở mà có phiếu cọc treo (ca 102LVT·104) ⇒ khối có room_occupied = true', async () => {
    expect(roomOf(await inventory(db), P_CU)?.deposit_hold).toMatchObject({ source: 'voucher', code: 'PT2605004', held_days: 182, room_occupied: true });
  });

  it('phòng trống, phòng đã thuê không có cọc ⇒ không có khối', async () => {
    const p = await inventory(db);
    expect(roomOf(p, P_TRONG)).toMatchObject({ status_public: 'free', deposit_hold: null });
    expect(roomOf(p, P_THUE)).toMatchObject({ status_public: 'rented', deposit_hold: null });
  });

  it('phiếu đã huỷ, đã xoá, đã gắn HĐ, đã quyết toán giữ chỗ, phiếu CHI ⇒ không giữ phòng, không vào khối', async () => {
    expect(roomOf(await inventory(db), P_THU)).toMatchObject({ status_public: 'free', deposit_hold: null });
    expect(await holdOf(db, P_THU)).toBeNull();
    expect(await holdOf(db, P_COC, ORG_B)).toBeNull(); // công ty khác
    expect(await holdOf(db, P_DOT, ORG_B)).toBeNull();
  });

  it('«Phòng trống» (get_my_available_rooms) trả cùng khối như bảng nội bộ, giữ has_deposit_hold', async () => {
    const mine = await myRooms(db);
    const inv = await inventory(db);
    for (const room of [P_DOT, P_DOT0, P_COC, P_HAI, P_CU, P_TRONG, P_THUE]) {
      expect(roomOf(mine, room)?.deposit_hold, room).toEqual(roomOf(inv, room)?.deposit_hold);
      expect(roomOf(mine, room)?.has_deposit_hold, room).toEqual(roomOf(inv, room)?.has_deposit_hold);
    }
  });

  it('link công khai, bot Zalo, Hermes: không có khối, không lộ tên người gửi hay mã phiếu', async () => {
    const pub = (await asUser<{ p: { rooms: Room[] } }>(db, null, 'SELECT public.get_public_available_rooms($1) p', ['demo'])).rows[0].p;
    expect(roomOf(pub, P_COC)?.status_public).toBe('rented');
    expect(roomOf(pub, P_DOT)?.status_public).toBe('rented');
    const botPayload = (await asUser<{ p: unknown }>(db, null, 'SELECT app_private.public_sale_rooms_payload_v1($1) p', [ORG])).rows[0].p;
    const hermes = (await asUser<{ p: unknown }>(db, null, 'SELECT public.hermes_available_rooms_page_v1($1::jsonb, $2::uuid) p',
      [JSON.stringify({ organizationId: ORG, buildingIds: [TOA] }), ORG])).rows[0].p;
    for (const payload of [pub, botPayload, hermes]) {
      const text = JSON.stringify(payload);
      for (const secret of ['deposit_hold', 'Chị Lan', 'Chị Hoa', 'Anh Tú', 'Khách Danh Bạ', 'Nguyễn Văn Khách', 'PT2611001', 'PT2611101', 'Khách cũ'])
        expect(text).not.toContain(secret);
    }
  });
});

describe('luật: phiếu cọc phải có số tiền lớn hơn 0 (lỗi 5)', () => {
  it('phiếu THU chưa gắn HĐ, dòng cọc 0 đ ⇒ bị chặn lúc COMMIT với câu của plan, không còn phiếu nào', async () => {
    const v = nextId();
    await expectBlocked(db, tx(db, ie({ id: v }), item(v, T_COC, 0)));
    expect(await exists(db, v)).toBe(false);
  });

  it('đúng đường đã sinh 4 phiếu Demo (chỉ ghi amount, đơn giá mặc định 0 ⇒ tính lại 0) ⇒ bị chặn', async () => {
    const v = nextId();
    await expectBlocked(db, tx(db, ie({ id: v }),
      `INSERT INTO public.income_expense_items(income_expense_id, income_expense_type_id, amount) VALUES ('${v}','${T_COC}',3500000)`));
    expect(await exists(db, v)).toBe(false);
  });

  it('cọc có tiền lưu được; sửa dòng cọc về 0 ⇒ chặn; đổi số lượng (vẫn > 0) ⇒ được', async () => {
    const v = nextId(), line = nextId();
    await tx(db, ie({ id: v }), item(v, T_COC, 1000000, line));
    await expectBlocked(db, tx(db, `UPDATE public.income_expense_items SET unit_price=0 WHERE id='${line}'`));
    await tx(db, `UPDATE public.income_expense_items SET quantity=2 WHERE id='${line}'`);
    expect((await db.query<{ ok: boolean }>('SELECT amount = 2000000 ok FROM public.income_expense_items WHERE id=$1', [line])).rows[0].ok).toBe(true);
  });

  it('tính theo TỔNG dòng cọc: 1.000.000 + 0 được; xoá dòng có tiền ⇒ chặn; cọc 0 + dòng khác có tiền ⇒ chặn', async () => {
    const v = nextId(), big = nextId();
    await tx(db, ie({ id: v }), item(v, T_COC, 1000000, big), item(v, T_COC, 0));
    await expectBlocked(db, tx(db, `DELETE FROM public.income_expense_items WHERE id='${big}'`));
    const w = nextId();
    await expectBlocked(db, tx(db, ie({ id: w }), item(w, T_COC, 0), item(w, T_THUE, 500000)));
    // Đổi hạng mục dòng có tiền sang hạng mục thường ⇒ còn dòng cọc 0 ⇒ chặn.
    await expectBlocked(db, tx(db, `UPDATE public.income_expense_items SET income_expense_type_id='${T_THUE}' WHERE id='${big}'`));
  });

  it('chuyển dòng cọc có tiền sang phiếu khác ⇒ kiểm cả phiếu cũ', async () => {
    const a = nextId(), b = nextId(), line = nextId();
    await tx(db, ie({ id: a }), item(a, T_COC, 1000000, line), item(a, T_COC, 0));
    await tx(db, ie({ id: b }), item(b, T_COC, 1000000));
    await expectBlocked(db, tx(db, `UPDATE public.income_expense_items SET income_expense_id='${b}' WHERE id='${line}'`));
  });

  it('không phải phiếu cọc (dòng thường 0 đ) ⇒ luật không chạm', async () => {
    const v = nextId();
    await tx(db, ie({ id: v }), item(v, T_THUE, 0));
    expect(await exists(db, v)).toBe(true);
  });

  it('phiếu cọc gắn hợp đồng: 0 đ không bị luật này chặn; gỡ hợp đồng ⇒ chặn', async () => {
    const v = nextId();
    await tx(db, ie({ id: v, contract: HD_KHAC }), item(v, T_COC, 0));
    expect(await exists(db, v)).toBe(true);
    await expectBlocked(db, tx(db, `UPDATE public.income_expenses SET contract_id=NULL WHERE id='${v}'`));
  });

  it('phiếu CHI hoàn cọc không bị chạm; đổi phiếu CHI 0 đ sang THU ⇒ chặn', async () => {
    const v = nextId();
    await tx(db, ie({ id: v, type: 'EXPENSE' }), item(v, T_HOAN, 0));
    expect(await exists(db, v)).toBe(true);
    await expectBlocked(db, tx(db, `UPDATE public.income_expenses SET type='INCOME' WHERE id='${v}'`));
  });

  it('phiếu đã huỷ / đã xoá mềm không bị chạm; bỏ huỷ hoặc khôi phục ⇒ chặn; xoá hẳn phiếu không lỗi', async () => {
    const huy = nextId(), xoa = nextId();
    await tx(db, ie({ id: huy, status: 'CANCELLED' }), item(huy, T_COC, 0));
    await tx(db, ie({ id: xoa, deleted: true }), item(xoa, T_COC, 0));
    await expectBlocked(db, tx(db, `UPDATE public.income_expenses SET approval_status='APPROVED' WHERE id='${huy}'`));
    await expectBlocked(db, tx(db, `UPDATE public.income_expenses SET deleted_at=NULL WHERE id='${xoa}'`));
    await tx(db, `DELETE FROM public.income_expenses WHERE id IN ('${huy}','${xoa}')`);
    expect(await exists(db, huy)).toBe(false);
  });

  it('kiểm TRẠNG THÁI CUỐI lúc COMMIT: ghi 0 rồi sửa thành có tiền, hoặc gắn HĐ trong cùng giao dịch ⇒ được', async () => {
    const a = nextId(), lineA = nextId(), b = nextId();
    await tx(db, ie({ id: a }), item(a, T_COC, 0, lineA), `UPDATE public.income_expense_items SET unit_price=800000 WHERE id='${lineA}'`);
    await tx(db, ie({ id: b }), item(b, T_COC, 0), `UPDATE public.income_expenses SET contract_id='${HD_KHAC}' WHERE id='${b}'`);
    expect(await exists(db, a) && await exists(db, b)).toBe(true);
  });

  it('client (vai authenticated, như PostgREST) cũng bị chặn: hàm kiểm DEFINER đọc được dòng dù RLS', async () => {
    const v = nextId();
    await db.query("SELECT set_config('test.uid', $1, false)", [SALE]);
    await db.exec('SET ROLE authenticated');
    try {
      await expectBlocked(db, tx(db, ie({ id: v }), item(v, T_COC, 0)));
    } finally { await db.exec('RESET ROLE'); }
    expect(await exists(db, v)).toBe(false);
  });

  it('chỉ kiểm khi ghi: phiếu Demo 0 đ có sẵn trước khi áp vẫn còn, sửa tên / huỷ được; bỏ huỷ thì phải có tiền', async () => {
    expect(await exists(db, V.DEMO)).toBe(true);
    await tx(db, `UPDATE public.income_expenses SET name='DEMO cọc giữ chỗ' WHERE id='${V.DEMO}'`);
    // Ghi lại cùng giá trị (trạng thái, hợp đồng, loại không đổi) không bị coi là sửa phiếu.
    await tx(db, `UPDATE public.income_expenses SET approval_status='APPROVED', contract_id=NULL, type='INCOME', deleted_at=NULL WHERE id='${V.DEMO}'`);
    await tx(db, `UPDATE public.income_expenses SET approval_status='CANCELLED' WHERE id='${V.DEMO}'`);
    await expectBlocked(db, tx(db, `UPDATE public.income_expenses SET approval_status='APPROVED' WHERE id='${V.DEMO}'`));
    expect((await db.query<{ s: string }>('SELECT approval_status s FROM public.income_expenses WHERE id=$1', [V.DEMO])).rows[0].s).toBe('CANCELLED');
  });
});

describe('catalog: trigger, quyền gọi', () => {
  const can = async (role: string, fn: string) =>
    (await db.query<{ v: boolean }>('SELECT has_function_privilege($1, $2, \'EXECUTE\') v', [role, fn])).rows[0].v;
  it('hai constraint trigger hoãn tới COMMIT, đúng hàm; hàm nội bộ không vai API nào gọi được', async () => {
    const triggers = (await db.query<{ tgname: string; d: boolean; i: boolean }>(
      "SELECT tgname, tgdeferrable d, tginitdeferred i FROM pg_trigger WHERE tgfoid='app_private.guard_deposit_voucher_amount_v1()'::regprocedure ORDER BY 1")).rows;
    expect(triggers).toEqual([{ tgname: 'a1_ie_deposit_amount_positive', d: true, i: true }, { tgname: 'a1_ie_item_deposit_amount_positive', d: true, i: true }]);
    for (const fn of ['app_private.guard_deposit_voucher_amount_v1()', 'app_private.room_deposit_hold_json_v1(uuid,uuid)']) {
      for (const role of ['anon', 'authenticated', 'service_role']) expect(await can(role, fn), `${role} ${fn}`).toBe(false);
    }
    for (const fn of ['public.get_sale_room_inventory_v1(uuid,uuid,uuid)', 'public.get_my_available_rooms(uuid)']) {
      expect(await can('authenticated', fn)).toBe(true);
      expect(await can('anon', fn)).toBe(false);
    }
  });
});

describe('tiền kiểm và hậu kiểm md5 của file migration', () => {
  const bodyMd5 = (text: string, name: string) => {
    const m = new RegExp(`CREATE OR REPLACE FUNCTION ${name.replace('.', '\\.')}\\([\\s\\S]*?AS \\$fn\\$([\\s\\S]*?)\\$fn\\$`).exec(text);
    if (!m) throw new Error(name);
    return createHash('md5').update(m[1]).digest('hex');
  };
  const bodyOf = (text: string, name: string) =>
    new RegExp(`CREATE OR REPLACE FUNCTION ${name.replace('.', '\\.')}\\([\\s\\S]*?AS \\$fn\\$([\\s\\S]*?)\\$fn\\$`).exec(text)![1];

  it('md5 ghim ở hậu kiểm là thân của file; tiền kiểm ghim đúng thân production (đợt 2 + vá #499) và thân của file này', async () => {
    const post = /DO \$sau\$[\s\S]*?\$sau\$;/.exec(sql)![0];
    const pins = [...post.matchAll(/\('((?:public|app_private)\.\w+)\([^']*\)', '([0-9a-f]{32})'\)/g)];
    expect(pins.length).toBe(4);
    for (const [, name, pin] of pins) expect(pin, name).toBe(bodyMd5(sql, name));
    // Dựng lại đúng chuỗi production trong PGlite (đợt 2 rồi khối vá của #499): md5 phải là md5 đã đo trên production.
    const other = await productionLikeDb();
    try {
      const live = await readerMd5(other);
      expect(live).toEqual({ 'get_sale_room_inventory_v1(uuid,uuid,uuid)': '0e3e37a193c5db71f34089c7fcb6f789',
        'get_my_available_rooms(uuid)': '7a25503d7a27eff1c424e1870f132ef3' });
      const pre = /DO \$truoc\$[\s\S]*?\$truoc\$;/.exec(sql)![0];
      expect(pre).toContain(`'0e3e37a193c5db71f34089c7fcb6f789', '${bodyMd5(sql, 'public.get_sale_room_inventory_v1')}'`);
      expect(pre).toContain(`'7a25503d7a27eff1c424e1870f132ef3', '${bodyMd5(sql, 'public.get_my_available_rooms')}'`);
    } finally { await other.close(); }
  });

  it('thân hai reader = thân production (đợt 2 + has_deposit_hold của #499) + đúng một dòng deposit_hold', async () => {
    const other = await productionLikeDb();
    try {
      const src = async (sig: string) => (await other.query<{ s: string }>('SELECT prosrc s FROM pg_proc WHERE oid = $1::regprocedure', [sig])).rows[0].s;
      expect(bodyOf(sql, 'public.get_sale_room_inventory_v1')
        .replace("      CASE WHEN fact.status_public='rented' THEN app_private.room_deposit_hold_json_v1(r.organization_id,r.id) END AS deposit_hold,\n", ''))
        .toBe(await src('public.get_sale_room_inventory_v1(uuid,uuid,uuid)'));
      expect(bodyOf(sql, 'public.get_my_available_rooms')
        .replace("AS has_deposit_hold,\n      CASE WHEN fact.status_public = 'rented' THEN app_private.room_deposit_hold_json_v1(rm.organization_id,rm.id) END AS deposit_hold\n", 'AS has_deposit_hold\n'))
        .toBe(await src('public.get_my_available_rooms(uuid)'));
    } finally { await other.close(); }
  });

  it('chưa áp #499 (hoặc đợt 2) ⇒ dừng ở tiền kiểm (thiếu phụ thuộc), không tạo trigger', async () => {
    const other = await freshDb();
    try {
      await other.exec('DROP FUNCTION app_private.attach_deposit_income_v1(uuid,jsonb,uuid,uuid[])');
      await other.exec(dot2Sql);
      await expect(other.exec(sql)).rejects.toThrow(/thiếu phụ thuộc/);
      expect((await other.query("SELECT 1 FROM pg_trigger WHERE tgname LIKE 'a1_ie%deposit_amount_positive'")).rows).toHaveLength(0);
    } finally { await other.close(); }
  });

  it('thân đang chạy khác thân đã rà ⇒ 55000, không ghi gì: reader chưa có vá #499 / room_has_holding_deposit lạ', async () => {
    const other = await freshDb();
    try {
      await other.exec(dot2Sql); // thiếu khối vá has_deposit_hold của #499
      await expect(other.exec(sql)).rejects.toThrow(/get_sale_room_inventory_v1\(uuid,uuid,uuid\) KHÁC thân đã rà/);
      await other.exec(pr499InventorySql);
      await other.exec("CREATE OR REPLACE FUNCTION public.room_has_holding_deposit(p_room_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$");
      await expect(other.exec(sql)).rejects.toThrow(/room_has_holding_deposit\(uuid\) KHÁC thân đã rà/);
      expect((await other.query("SELECT 1 FROM pg_proc WHERE proname='guard_deposit_voucher_amount_v1'")).rows).toHaveLength(0);
    } finally { await other.close(); }
  });

  it('chạy lại CẢ FILE sau khi đã áp: tiền kiểm nhận thân của file, hậu kiểm (thân, has_deposit_hold, thứ tự trigger, ACL) đạt', async () => {
    await db.exec(sql);
    expect((await db.query("SELECT 1 FROM pg_trigger WHERE tgname LIKE 'a1_ie%deposit_amount_positive'")).rows).toHaveLength(2);
    expect(roomOf(await inventory(db), P_DOT)?.deposit_hold).toMatchObject({ source: 'hold', code: 'PT2611101' });
  });

  it('khối vá của #499 chạy lại sau file này (thứ tự replay khác production) vẫn bỏ qua vì đã có has_deposit_hold', async () => {
    await db.exec(pr499InventorySql);
    const live = await readerMd5(db);
    expect(live['get_sale_room_inventory_v1(uuid,uuid,uuid)']).toBe(bodyMd5(sql, 'public.get_sale_room_inventory_v1'));
    expect(live['get_my_available_rooms(uuid)']).toBe(bodyMd5(sql, 'public.get_my_available_rooms'));
  });
});
