import { sharedW2, BUILDING, OTHER_BUILDING, ROOM, OTHER_ROOM, USER, ORG, FOREIGN } from './wave2-sql-fixture.mjs';
import { CUSTOMER_A, CUSTOMER_B, CUSTOMER_C, CO_TENANT, CONTRACT_A, CONTRACT_B, SERVICE } from './full-read-sql-fixture.mjs';
import { CATEGORY, RESTRICTED_CATEGORY, HIDDEN_CATEGORY } from './finance-fixture.mjs';

// Gói D đợt 2 (tài sản, danh mục, toà/phòng, báo cáo BĐS) — fixture RIÊNG của Gói D, chỉ Gói D sửa.
// Dựng trên sharedW2: fixture đọc đầy đủ đợt 1 + nền đợt 2 + migration của CHÍNH gói D (dải
// 2026101804xxxx). before: cột/bảng mà hàm LANGUAGE sql của gói cần lúc tạo (tên và kiểu như bảng thật,
// rút gọn: enum thành text) + cổng tổng hợp cùng chữ ký cho hàm web ngoài gói (can_view_restricted_ie, is_admin,
// accessible_building_ids, has_full_building_scope, get_room_cash_lifecycle_v1 — bản thật không chạy được trên PGlite).
// RLS GIẢ LẬP (mô hình INVOKER + RLS, 18/10): policy SELECT rút gọn theo đúng hình dạng policy web (toà theo
// fixture_building_access, khoá org-entity theo fixture_acl, chủ hồ sơ theo fixture_visible_owners, hạn chế theo
// fixture_restricted_viewers; RLS areas chỉ quản trị — như areas_select_rbac còn đọc staff_assignments cũ). seed: dữ
// liệu tổng hợp. Khoá web của màn (can_access_org_entity) giả lập theo fixture_acl. Hàm gói chạy qua lối vào INVOKER
// thật của nền (public.hermes_w2_read_v1, vai authenticated, KHÔNG USAGE trên app_private). Không chứng minh RLS thật
// của production, JWT thật, PostgREST hay thân RPC dòng tiền phòng.
// MỘT PGlite cho cả file test, mỗi ca BEGIN … ROLLBACK (shared.isolated).
const u = n => `0d0d0d0d-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const D = Object.freeze({
  ROOM_A2: u(1), ROOM_A3: u(2), ROOM_A4: u(3), ROOM_A5: u(4), ROOM_B2: u(5),
  C_END: u(11), C_EXP: u(12), C_SOON: u(13), C_DRAFT: u(14), C_DELETED: u(15), C_TRANSFER: u(16), C_B2: u(17),
  EXT_A: u(21), EXT_PENDING: u(22), EXT_B: u(23),
  ASSET_A: u(31), ASSET_B: u(32), ASSET_FREE: u(33), ASSET_DELETED: u(34), ASSET_BROKEN: u(35), ASSET_CAT: u(36), SUPPLIER: u(37), SUPPLIER_HIDDEN: u(38),
  SERVICE_B: u(41), SERVICE_FREE: u(42), QUOTA: u(43),
  METER_A: u(51), METER_B: u(52), METER_DELETED: u(53),
  AREA_AB: u(61), AREA_B: u(62), AREA_EMPTY: u(63),
  FLOOR_A1: u(71), FLOOR_A2: u(72), FLOOR_B1: u(73),
  JOB_TYPE: u(81), JOB_GROUP: u(82), DEPARTMENT: u(83), HOTLINE: u(84), HOTLINE_HIDDEN: u(85),
  IE_TYPE_INCOME: u(91), IE_TYPE_SALARY: u(92), IE_TYPE_DUP: u(93),
});

const BEFORE = `
  ALTER TABLE public.buildings ADD COLUMN code text,ADD COLUMN type text DEFAULT 'APARTMENT',ADD COLUMN status text DEFAULT 'ACTIVE',ADD COLUMN total_floors integer,
    ADD COLUMN description text,ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp(),ADD COLUMN updated_at timestamptz,
    ADD COLUMN commission_tiers jsonb,ADD COLUMN commission_change_reason text,ADD COLUMN default_account_id_tt uuid,ADD COLUMN public_contact_phone text;
  ALTER TABLE public.rooms ADD COLUMN code text,ADD COLUMN floor integer NOT NULL DEFAULT 1,ADD COLUMN area numeric,ADD COLUMN deposit_amount numeric NOT NULL DEFAULT 0,
    ADD COLUMN max_occupants integer;
  ALTER TABLE public.contracts ADD COLUMN discounts jsonb,ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),ADD COLUMN tenant_id uuid;
  ALTER TABLE public.contract_customers ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
  ALTER TABLE public.contract_extensions ADD COLUMN extension_date date,ADD COLUMN new_rent_price numeric;
  CREATE TABLE public.contract_terminations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,contract_id uuid,termination_type text,notes text,
    internal_notes text,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE TABLE public.organization_timezones(organization_id uuid PRIMARY KEY,timezone text NOT NULL);
  ALTER TABLE public.income_expense_types ADD COLUMN rule_key text,ADD COLUMN description text,ADD COLUMN is_default boolean,ADD COLUMN sort_order integer,
    ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp(),ADD COLUMN user_id uuid;
  ALTER TABLE public.services ADD COLUMN code text,ADD COLUMN fee_type text,ADD COLUMN is_default boolean,ADD COLUMN is_mandatory boolean;
  CREATE TABLE IF NOT EXISTS public.building_services(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,building_id uuid,service_id uuid,
    is_active boolean NOT NULL DEFAULT true);
  CREATE TABLE public.service_quotas(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,name text,description text,deleted_at timestamptz);
  CREATE TABLE public.service_quota_tiers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,quota_id uuid,tier_number integer,from_value numeric,
    to_value numeric,unit_price numeric);
  CREATE TABLE public.asset_categories(id uuid PRIMARY KEY,organization_id uuid,name text);
  CREATE TABLE public.suppliers(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,name text,phone text,email text,address text,deleted_at timestamptz);
  CREATE TABLE public.assets(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,building_id uuid,room_id uuid,category_id uuid,supplier_id uuid,code text,name text,
    quantity integer,purchase_price numeric,condition text,purchase_date date,description text,images jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz);
  CREATE TABLE public.meters(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,room_id uuid,code text,name text,meter_type text,status text,initial_reading numeric,
    serial_number text,manufacturer text,deleted_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  ALTER TABLE public.meter_readings ADD COLUMN meter_id uuid,ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
  ALTER TABLE public.areas ADD COLUMN code text,ADD COLUMN status text DEFAULT 'ACTIVE',ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
  CREATE TABLE public.floors(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,floor_number integer,name text,description text,status text);
  CREATE TABLE public.departments(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,name text);
  CREATE TABLE public.job_groups(id uuid PRIMARY KEY,organization_id uuid,name text);
  CREATE TABLE public.job_types(id uuid PRIMARY KEY,organization_id uuid,name text,default_department_id uuid,job_group_id uuid,customer_contact_deadline integer,
    acceptance_deadline integer,completion_deadline integer,business_hours_only boolean,is_active boolean,bonus_amount numeric,counts_for_salary boolean,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE TABLE public.hotlines(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,name text,phone_number text,description text,is_active boolean,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE TABLE public.fixture_restricted_viewers(user_id uuid PRIMARY KEY);
  CREATE TABLE public.fixture_admins(user_id uuid PRIMARY KEY);
  CREATE TABLE public.fixture_lifecycle(room_id uuid PRIMARY KEY,value jsonb NOT NULL);
  CREATE FUNCTION public.fixture_can(p_key text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS
    $$SELECT EXISTS(SELECT 1 FROM public.fixture_acl WHERE permission=p_key AND allowed)$$;
  CREATE FUNCTION public.fixture_bld(p_building uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS
    $$SELECT EXISTS(SELECT 1 FROM public.fixture_building_access WHERE building_id=p_building)$$;
  CREATE FUNCTION public.fixture_owner(p_user uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS
    $$SELECT EXISTS(SELECT 1 FROM public.fixture_visible_owners WHERE user_id=p_user)$$;
  CREATE OR REPLACE FUNCTION public.accessible_building_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER AS
    $$SELECT building_id FROM public.fixture_building_access$$;
  CREATE OR REPLACE FUNCTION public.has_full_building_scope() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS
    $$SELECT EXISTS(SELECT 1 FROM public.fixture_admins WHERE user_id=auth.uid())$$;
  CREATE OR REPLACE FUNCTION public.can_access_org_entity(_resource text,_action text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS
    $$SELECT public.fixture_can(_resource||'.'||_action) OR EXISTS(SELECT 1 FROM public.fixture_admins WHERE user_id=auth.uid())$$;
  CREATE FUNCTION public.can_view_restricted_ie() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT EXISTS(SELECT 1 FROM public.fixture_restricted_viewers WHERE user_id=auth.uid())$$;
  CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT EXISTS(SELECT 1 FROM public.fixture_admins WHERE user_id=auth.uid())$$;
  CREATE OR REPLACE FUNCTION app_private.org_timezone_v1(p_organization_id uuid) RETURNS text LANGUAGE sql STABLE AS
    $$SELECT COALESCE((SELECT t.timezone FROM public.organization_timezones t WHERE t.organization_id=p_organization_id),'Asia/Ho_Chi_Minh')$$;
  -- Cổng tổng hợp cùng chữ ký RPC web: đăng nhập, phòng chưa xoá, can_access_building như bản thật; thân trả ảnh chụp cài sẵn.
  CREATE FUNCTION public.get_room_cash_lifecycle_v1(p_room_id uuid,p_from date DEFAULT NULL,p_to date DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql
    SECURITY DEFINER SET search_path=public,app_private AS $$
  DECLARE v_building uuid;
  BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;
    SELECT r.building_id INTO v_building FROM rooms r WHERE r.id=p_room_id AND r.deleted_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy phòng' USING ERRCODE='P0002'; END IF;
    IF NOT public.can_access_building(v_building) THEN RAISE EXCEPTION 'Bạn không có quyền xem toà này' USING ERRCODE='42501'; END IF;
    RETURN (SELECT value FROM public.fixture_lifecycle WHERE room_id=p_room_id);
  END $$;
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
  DO $rls$ DECLARE t text; BEGIN
    FOREACH t IN ARRAY ARRAY['buildings','rooms','contracts','customers','contract_customers','contract_extensions','contract_terminations',
      'income_expenses','income_expense_items','income_expense_types','assets','asset_categories','suppliers','services','building_services',
      'service_quotas','service_quota_tiers','meters','meter_readings','areas','area_buildings','floors','job_types','job_groups','departments','hotlines'] LOOP
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    END LOOP;
  END $rls$;
  CREATE POLICY f ON public.buildings FOR SELECT TO authenticated USING (public.fixture_bld(id));
  CREATE POLICY f ON public.rooms FOR SELECT TO authenticated USING (public.fixture_bld(building_id));
  CREATE POLICY f ON public.contracts FOR SELECT TO authenticated USING (EXISTS(SELECT 1 FROM public.rooms r WHERE r.id=room_id));
  CREATE POLICY f ON public.customers FOR SELECT TO authenticated USING (public.fixture_can('customers.view') AND public.fixture_owner(user_id));
  CREATE POLICY f ON public.contract_customers FOR SELECT TO authenticated USING (EXISTS(SELECT 1 FROM public.contracts c WHERE c.id=contract_id));
  CREATE POLICY f ON public.contract_extensions FOR SELECT TO authenticated USING (EXISTS(SELECT 1 FROM public.contracts c WHERE c.id=contract_id));
  CREATE POLICY f ON public.contract_terminations FOR SELECT TO authenticated USING (EXISTS(SELECT 1 FROM public.contracts c WHERE c.id=contract_id));
  CREATE POLICY f ON public.income_expenses FOR SELECT TO authenticated USING (public.fixture_bld(building_id)
    AND (NOT has_restricted_item OR user_id=auth.uid() OR public.can_view_restricted_ie()));
  CREATE POLICY f ON public.income_expense_items FOR SELECT TO authenticated USING (EXISTS(SELECT 1 FROM public.income_expenses v WHERE v.id=income_expense_id));
  CREATE POLICY f ON public.income_expense_types FOR SELECT TO authenticated USING (public.fixture_can('categories.view')
    AND (NOT is_restricted OR public.can_view_restricted_ie()));
  CREATE POLICY f ON public.assets FOR SELECT TO authenticated USING (public.fixture_bld(building_id)
    OR building_id IS NULL AND public.fixture_can('assets.view') AND public.fixture_owner(user_id));
  CREATE POLICY f ON public.asset_categories FOR SELECT TO authenticated USING (public.fixture_can('assets.view'));
  CREATE POLICY f ON public.suppliers FOR SELECT TO authenticated USING (public.fixture_can('suppliers.view') AND public.fixture_owner(user_id));
  CREATE POLICY f ON public.services FOR SELECT TO authenticated USING (public.fixture_can('services.view'));
  CREATE POLICY f ON public.building_services FOR SELECT TO authenticated USING (public.fixture_bld(building_id));
  CREATE POLICY f ON public.service_quotas FOR SELECT TO authenticated USING (public.fixture_can('service_quotas.view'));
  CREATE POLICY f ON public.service_quota_tiers FOR SELECT TO authenticated USING (public.fixture_can('service_quotas.view'));
  CREATE POLICY f ON public.meters FOR SELECT TO authenticated USING (public.fixture_bld(building_id));
  CREATE POLICY f ON public.meter_readings FOR SELECT TO authenticated USING (public.fixture_bld(building_id));
  CREATE POLICY f ON public.areas FOR SELECT TO authenticated USING (public.is_admin());
  CREATE POLICY f ON public.area_buildings FOR SELECT TO authenticated USING (public.fixture_bld(building_id));
  CREATE POLICY f ON public.floors FOR SELECT TO authenticated USING (public.fixture_bld(building_id));
  CREATE POLICY f ON public.job_types FOR SELECT TO authenticated USING (public.fixture_can('task_types.view'));
  CREATE POLICY f ON public.job_groups FOR SELECT TO authenticated USING (public.fixture_can('tasks.view'));
  CREATE POLICY f ON public.departments FOR SELECT TO authenticated USING (user_id=auth.uid() OR public.is_admin());
  CREATE POLICY f ON public.hotlines FOR SELECT TO authenticated USING (public.fixture_can('hotline.view') AND public.fixture_owner(user_id));`;

const SEED = `
  INSERT INTO public.organization_timezones VALUES('${ORG}','Asia/Ho_Chi_Minh');
  INSERT INTO app_private.hermes_capabilities(capability,mode,enabled) VALUES('rooms.view','read',false),('assets.view','read',false),
    ('services.view','read',false),('tasks.view','read',false) ON CONFLICT(capability) DO NOTHING;
  UPDATE public.buildings SET code='A',total_floors=5,description='Toà mẫu',commission_tiers='[{"rate":5}]',commission_change_reason='bí mật',
    default_account_id_tt='${u(99)}',public_contact_phone='0909000000',created_at='2026-01-01T00:00:00Z',updated_at='2026-10-15T20:00:00Z' WHERE id='${BUILDING}';
  UPDATE public.buildings SET code='B',created_at='2026-02-01T00:00:00Z' WHERE id='${OTHER_BUILDING}';
  UPDATE public.rooms SET floor=1,area=25,rent_price=3500000,code='A101' WHERE id='${ROOM}';
  UPDATE public.rooms SET floor=1,area=20,rent_price=2000000 WHERE id='${OTHER_ROOM}';
  INSERT INTO public.rooms(id,organization_id,building_id,name,status,deleted_at,rent_price,floor,area,code) VALUES
    ('${D.ROOM_A2}','${ORG}','${BUILDING}','P102','AVAILABLE',null,3000000,1,22,'A102'),
    ('${D.ROOM_A3}','${ORG}','${BUILDING}','P103','RESERVED',null,3100000,1,22,null),
    ('${D.ROOM_A4}','${ORG}','${BUILDING}','P204','MAINTENANCE',null,3200000,2,30,null),
    ('${D.ROOM_A5}','${ORG}','${BUILDING}','P205','OCCUPIED',null,4000000,2,30,null),
    ('${D.ROOM_B2}','${ORG}','${OTHER_BUILDING}','P202','AVAILABLE',null,2500000,2,18,null);
  UPDATE public.contracts SET discounts='{"type":"percent","amount":10,"name":"Giảm 10%"}' WHERE id='${CONTRACT_A}';
  INSERT INTO public.contracts(id,organization_id,room_id,status,total_deposit,deleted_at,contract_number,signed_date,start_date,end_date,actual_end_date,rent_price,
      payment_cycle,discounts,updated_at) VALUES
    ('${D.C_END}','${ORG}','${D.ROOM_A2}','TERMINATED',3000000,null,'HD-END','2025-09-28','2025-10-01','2026-12-31','2026-10-10',3000000,'MONTHLY','[]','2026-10-10T03:00:00Z'),
    ('${D.C_EXP}','${ORG}','${D.ROOM_A4}','EXPIRED',3200000,null,'HD-EXP','2025-07-30','2025-08-01','2026-08-01',null,3200000,'MONTHLY',null,'2026-08-01T03:00:00Z'),
    ('${D.C_SOON}','${ORG}','${D.ROOM_A5}','ACTIVE',4000000,null,'HD-SOON','2026-03-30','2026-04-01','2026-10-25',null,4000000,'MONTHLY',
      '{"months":3,"amount_per_month":500000}','2026-04-01T03:00:00Z'),
    ('${D.C_DRAFT}','${ORG}','${D.ROOM_A2}','DRAFT',3000000,null,'HD-DRAFT','2026-10-05','2026-11-01','2027-11-01',null,3000000,'MONTHLY',null,'2026-10-05T03:00:00Z'),
    ('${D.C_DELETED}','${ORG}','${D.ROOM_A2}','ACTIVE',1,'2026-10-01T00:00:00Z','HD-DEL','2026-10-02','2026-10-02','2026-10-20',null,1,'MONTHLY','{"amount":1}',
      '2026-10-02T03:00:00Z'),
    ('${D.C_TRANSFER}','${ORG}','${ROOM}','TRANSFERRED',3500000,null,'HD-TR','2026-08-30','2026-09-01','2027-09-01',null,3600000,'MONTHLY',null,
      '2026-09-15T20:00:00Z'),
    ('${D.C_B2}','${ORG}','${D.ROOM_B2}','ACTIVE',2500000,null,'HD-B2','2026-10-01','2026-10-01','2026-10-20',null,2500000,'MONTHLY','{"amount":100000}',
      '2026-10-01T03:00:00Z');
  INSERT INTO public.contract_customers(organization_id,contract_id,customer_id,is_representative) VALUES
    ('${ORG}','${D.C_SOON}','${CUSTOMER_C}',true),('${ORG}','${D.C_END}','${CO_TENANT}',false),('${ORG}','${D.C_TRANSFER}','${CUSTOMER_A}',true),
    ('${ORG}','${D.C_B2}','${CUSTOMER_B}',true);
  INSERT INTO public.contract_terminations(organization_id,contract_id,termination_type,notes,created_at) VALUES
    ('${ORG}','${D.C_END}','EARLY','Khách chuyển đi sớm','2026-10-09T00:00:00Z'),('${ORG}','${D.C_END}','NORMAL','bản cũ','2026-10-01T00:00:00Z');
  INSERT INTO public.contract_extensions(id,contract_id,status,new_end_date,extension_date,new_rent_price) VALUES
    ('${D.EXT_A}','${CONTRACT_A}','APPROVED','2027-06-01','2026-09-20',3800000),
    ('${D.EXT_PENDING}','${CONTRACT_A}','PENDING','2027-07-01','2026-09-21',3900000),
    ('${D.EXT_B}','${CONTRACT_B}','COMPLETED','2027-06-01','2026-09-22',null);
  UPDATE public.income_expense_types SET category='Bảo trì',created_at='2026-01-01T00:00:00Z' WHERE id='${CATEGORY}';
  UPDATE public.income_expense_types SET category='Nhân sự' WHERE id='${RESTRICTED_CATEGORY}';
  UPDATE public.income_expense_types SET category=null WHERE id='${HIDDEN_CATEGORY}';
  INSERT INTO public.income_expense_types(id,organization_id,type,name,category,is_restricted,rule_key,created_at) VALUES
    ('${D.IE_TYPE_INCOME}','${ORG}','income','Tiền phòng','Doanh thu',false,null,'2026-01-01T00:00:00Z'),
    ('${D.IE_TYPE_SALARY}','${ORG}','expense','Ứng lương','Nhân sự',false,'ung_luong','2026-01-01T00:00:00Z'),
    ('${D.IE_TYPE_DUP}','${ORG}','expense',' sửa chữa ','Bảo trì',false,null,'2026-06-01T00:00:00Z'),
    ('${u(94)}','${FOREIGN}','expense','Loại công ty khác','Khác',false,null,'2026-01-01T00:00:00Z');
  INSERT INTO public.income_expenses(id,organization_id,user_id,code,type,name,building_id,voucher_date,total_amount,approval_status,has_restricted_item) VALUES
    ('${u(101)}','${ORG}','${FOREIGN}','PT-1','INCOME','Thu T10','${BUILDING}','2026-10-05',10000000,'APPROVED',false),
    ('${u(102)}','${ORG}','${FOREIGN}','PT-2','INCOME','Thu T9','${BUILDING}','2026-09-05',8000000,'APPROVED',false),
    ('${u(103)}','${ORG}','${FOREIGN}','PT-3','INCOME','Chờ duyệt','${BUILDING}','2026-10-06',999,'PENDING',false),
    ('${u(104)}','${ORG}','${FOREIGN}','PT-4','INCOME','Toà B','${OTHER_BUILDING}','2026-10-05',7777,'APPROVED',false),
    ('${u(105)}','${ORG}','${FOREIGN}','PC-1','EXPENSE','Sửa máy','${BUILDING}','2026-10-06',1200000,'APPROVED',false),
    ('${u(106)}','${ORG}','${FOREIGN}','PC-2','EXPENSE','Lương','${BUILDING}','2026-10-07',500000,'APPROVED',true),
    ('${u(107)}','${ORG}','${FOREIGN}','PC-3','EXPENSE','Toà B','${OTHER_BUILDING}','2026-10-07',4444,'APPROVED',false),
    ('${u(108)}','${ORG}','${FOREIGN}','PC-4','EXPENSE','Ứng lương','${BUILDING}','2026-08-07',300000,'APPROVED',false);
  INSERT INTO public.income_expense_items(income_expense_id,income_expense_type_id,amount) VALUES
    ('${u(105)}','${CATEGORY}',1200000),('${u(105)}','${CATEGORY}',0),('${u(105)}','${D.IE_TYPE_INCOME}',50000),
    ('${u(106)}','${RESTRICTED_CATEGORY}',500000),('${u(107)}','${CATEGORY}',4444),('${u(108)}','${D.IE_TYPE_SALARY}',300000);
  INSERT INTO public.asset_categories VALUES('${D.ASSET_CAT}','${ORG}','Điều hoà');
  INSERT INTO public.suppliers VALUES('${D.SUPPLIER}','${ORG}','${USER}','Điện máy Xanh','0281234567','ncc@example.invalid','1 Đường NCC',null),
    ('${D.SUPPLIER_HIDDEN}','${ORG}','${FOREIGN}','NCC chủ hồ sơ ngoài','0280000000',null,null,null);
  INSERT INTO public.assets(id,organization_id,user_id,building_id,room_id,category_id,supplier_id,code,name,quantity,purchase_price,condition,purchase_date,description,images,created_at,deleted_at) VALUES
    ('${D.ASSET_A}','${ORG}','${FOREIGN}','${BUILDING}','${ROOM}','${D.ASSET_CAT}','${D.SUPPLIER}','TS-1','Máy lạnh',2,1000000,'GOOD','2026-01-05','mô tả',
      '["assets/a.jpg"]','2026-01-05T00:00:00Z',null),
    ('${D.ASSET_BROKEN}','${ORG}','${FOREIGN}','${BUILDING}',null,null,'${D.SUPPLIER_HIDDEN}','TS-2','Bình nóng lạnh',0,null,'BROKEN',null,null,null,'2026-02-05T00:00:00Z',null),
    ('${D.ASSET_B}','${ORG}','${FOREIGN}','${OTHER_BUILDING}',null,null,null,'TS-3','Tủ lạnh toà B',1,500000,'NEW',null,null,null,'2026-03-05T00:00:00Z',null),
    ('${D.ASSET_FREE}','${ORG}','${USER}',null,null,null,null,'TS-4','Kho chung',1,200000,null,null,null,null,'2026-04-05T00:00:00Z',null),
    ('${D.ASSET_DELETED}','${ORG}','${USER}','${BUILDING}',null,null,null,'TS-5','Đã xoá',1,1,'GOOD',null,null,null,'2026-05-05T00:00:00Z','2026-06-01T00:00:00Z'),
    ('${u(39)}','${FOREIGN}','${USER}','${u(12)}',null,null,null,'TS-F','Công ty khác',1,1,'GOOD',null,null,null,'2026-05-05T00:00:00Z',null);
  UPDATE public.services SET code='DV-DIEN',fee_type='TIEN_DIEN',is_default=true WHERE id='${SERVICE}';
  INSERT INTO public.services(id,organization_id,name,unit,type,pricing_type,unit_price,user_id,deleted_at,code,fee_type,is_default) VALUES
    ('${D.SERVICE_B}','${ORG}','Nước toà B','m3','METER_READING','DON_GIA_CO_DINH_DONG_HO',20000,'${USER}',null,'DV-NUOC','TIEN_NUOC',false),
    ('${D.SERVICE_FREE}','${ORG}','Phí khác','tháng','FIXED','DON_GIA_CO_DINH_THANG',50000,'${USER}',null,'DV-KHAC','TIEN_PHI_KHAC',false);
  INSERT INTO public.building_services(organization_id,building_id,service_id,is_active) VALUES
    ('${ORG}','${BUILDING}','${SERVICE}',true),('${ORG}','${OTHER_BUILDING}','${SERVICE}',true),('${ORG}','${OTHER_BUILDING}','${D.SERVICE_B}',true);
  INSERT INTO public.service_quotas VALUES('${D.QUOTA}','${ORG}','${USER}','Bậc điện sinh hoạt','EVN',null),('${u(44)}','${FOREIGN}','${USER}','Khác công ty',null,null);
  INSERT INTO public.service_quota_tiers(organization_id,quota_id,tier_number,from_value,to_value,unit_price) VALUES
    ('${ORG}','${D.QUOTA}',2,51,null,2000),('${ORG}','${D.QUOTA}',1,0,50,1800);
  INSERT INTO public.meters(id,organization_id,building_id,room_id,code,name,meter_type,status,initial_reading,serial_number,deleted_at) VALUES
    ('${D.METER_A}','${ORG}','${BUILDING}','${ROOM}','CT-1','Điện P101','ELECTRICITY','ACTIVE',100,'SERIAL-BI-MAT',null),
    ('${D.METER_B}','${ORG}','${OTHER_BUILDING}',null,'CT-2','Nước B','WATER','ACTIVE',5,null,null),
    ('${D.METER_DELETED}','${ORG}','${BUILDING}',null,'CT-3','Đã xoá','WATER','REMOVED',0,null,'2026-01-01T00:00:00Z');
  INSERT INTO public.meter_readings(id,organization_id,building_id,room_id,meter_type,reading_date,previous_reading,current_reading,meter_id,deleted_at,created_at) VALUES
    ('${u(54)}','${ORG}','${BUILDING}','${ROOM}','ELECTRICITY','2026-09-30',100,180,'${D.METER_A}',null,'2026-09-30T01:00:00Z'),
    ('${u(55)}','${ORG}','${BUILDING}','${ROOM}','ELECTRICITY','2026-10-31',180,999,'${D.METER_A}','2026-10-01T00:00:00Z','2026-10-01T01:00:00Z'),
    ('${u(56)}','${ORG}','${BUILDING}','${ROOM}','ELECTRICITY','2026-10-15',180,240,'${D.METER_A}',null,'2026-10-15T01:00:00Z');
  INSERT INTO public.areas(id,organization_id,name,deleted_at,code,created_at) VALUES('${D.AREA_AB}','${ORG}','Khu Trung tâm',null,'KTT','2026-01-01T00:00:00Z'),
    ('${D.AREA_B}','${ORG}','Khu B',null,'KB','2026-02-01T00:00:00Z'),('${D.AREA_EMPTY}','${ORG}','Khu trống',null,'KT','2026-03-01T00:00:00Z');
  INSERT INTO public.area_buildings VALUES('${ORG}','${D.AREA_AB}','${BUILDING}'),('${ORG}','${D.AREA_AB}','${OTHER_BUILDING}'),('${ORG}','${D.AREA_B}','${OTHER_BUILDING}');
  INSERT INTO public.floors VALUES('${D.FLOOR_A2}','${ORG}','${BUILDING}',2,'Tầng 2',null,'active'),('${D.FLOOR_A1}','${ORG}','${BUILDING}',1,'Tầng 1','sảnh','active'),
    ('${D.FLOOR_B1}','${ORG}','${OTHER_BUILDING}',1,'Tầng 1 B',null,'inactive');
  INSERT INTO public.departments VALUES('${D.DEPARTMENT}','${ORG}','${USER}','Kỹ thuật'),('${u(86)}','${ORG}','${FOREIGN}','Phòng người khác');
  INSERT INTO public.job_groups VALUES('${D.JOB_GROUP}','${ORG}','Sửa chữa');
  INSERT INTO public.job_types(id,organization_id,name,default_department_id,job_group_id,customer_contact_deadline,acceptance_deadline,completion_deadline,
      business_hours_only,is_active,bonus_amount,counts_for_salary,created_at) VALUES
    ('${D.JOB_TYPE}','${ORG}','Sửa điện','${D.DEPARTMENT}','${D.JOB_GROUP}',30,60,1440,true,true,50000,true,'2026-01-01T00:00:00Z'),
    ('${u(87)}','${ORG}','Dọn phòng','${u(86)}',null,null,null,null,false,false,10000,false,'2026-02-01T00:00:00Z'),
    ('${u(88)}','${FOREIGN}','Việc công ty khác',null,null,null,null,null,null,null,null,null,'2026-02-01T00:00:00Z');
  INSERT INTO public.hotlines(id,organization_id,user_id,name,phone_number,description,is_active,created_at) VALUES
    ('${D.HOTLINE}','${ORG}','${USER}','Kỹ thuật 24/7','0900000001','gọi đêm',true,'2026-01-01T00:00:00Z'),
    ('${D.HOTLINE_HIDDEN}','${ORG}','${FOREIGN}','Chủ hồ sơ ngoài','0900000002',null,true,'2026-02-01T00:00:00Z');
  INSERT INTO public.fixture_lifecycle VALUES('${ROOM}',jsonb_build_object('room',jsonb_build_object('id','${ROOM}','name','P101','buildingId','${BUILDING}',
      'buildingName','Toà A'),'range',jsonb_build_object('from',null,'to',null),
    'contracts',jsonb_build_array(jsonb_build_object('id','${CONTRACT_A}','number','HD-A','status','ACTIVE','startDate','2026-01-02','endDate','2027-01-01',
      'actualEndDate',null,'rentPrice',3500000,'totalDeposit',6000000,'tenantName','Tên bảng tenants cũ')),
    'segments',jsonb_build_array(jsonb_build_object('contractId','${CONTRACT_A}','sourcePath','x','diagnostic','y')),
    'events',jsonb_build_array(jsonb_build_object('type','CONTRACT_OPENED','date','2026-01-02','contractId','${CONTRACT_A}','amount',null,'trusted',true,
        'meta',jsonb_build_object('sourcePath','x')),
      jsonb_build_object('type','COMMISSION_PAID','date','2026-01-03','contractId','${CONTRACT_A}','amount',350000,'trusted',false,
        'meta',jsonb_build_object('code','PC-HH','name','Hoa hồng cho Nguyễn Văn An'))),
    'vacancies',jsonb_build_array(jsonb_build_object('fromDate','2025-12-01','toDate','2026-01-02','days',32)),'generatedAt','2026-10-16T00:00:00Z'));`;

// Mặc định gói D + dải Z (review PR #215 P3-1): test gói kiểm định nghĩa CUỐI sẽ phát hành, không phải bản gói đã bị Z thay.
export async function sharedW2d(options = {}) {
  return sharedW2({ packages: ['d', 'z'], before: db => db.exec(BEFORE), seed: db => db.exec(SEED), ...options });
}
export { BUILDING, OTHER_BUILDING, ROOM, OTHER_ROOM, USER, ORG, FOREIGN, CUSTOMER_A, CUSTOMER_B, CUSTOMER_C, CO_TENANT, CONTRACT_A, CONTRACT_B, SERVICE,
  CATEGORY, RESTRICTED_CATEGORY, HIDDEN_CATEGORY };
