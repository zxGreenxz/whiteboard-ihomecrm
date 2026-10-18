import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AMOUNT_SEARCH_TOLERANCE } from '@/lib/roomCodeSearch';

// Hàm đọc hoá đơn dùng chung (chủ chốt 17/10/2026): danh sách + thẻ thống kê của /invoices.
// Một PGlite cho cả file; mỗi ca chạy trong BEGIN … ROLLBACK. Migration nạp HAI lượt (idempotent).
const MIGRATION = 'supabase/migrations/20261017115809_invoice_read_shared_v1.sql';
const migrationSql = readFileSync(MIGRATION, 'utf8');

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG_A = 'aaaa0000-0000-4000-8000-0000000000a1';
const ORG_B = 'bbbb0000-0000-4000-8000-0000000000b1';
const SANDBOX = 'cccc0000-0000-4000-8000-000000000001';
const DEMO_ORG = 'dddd0000-0000-4000-8000-0000000000d1';
// Người dùng
const OWNER = u(11); // chủ công ty: quyền toàn công ty, KHÔNG có phân công toà
const STAFF = u(12); // buildings.view B1+B2, invoices.view chỉ B1, không customers.view
const STAFF_CUST = u(13); // B1 đủ quyền + customers.view
const OTHER = u(14); // công ty khác
const SUPER = u(15);
const DEMO_USER = u(16);
const NOBODY = u(17);
const NOPERM = u(18); // chỉ buildings.view toàn công ty, không invoices.view
const EX_MEMBER = u(19); // người tạo hồ sơ khách đã rời công ty
// Toà / phòng
const B1 = u(21), B2 = u(22), B3 = u(23), BX = u(24), BS = u(25), BD = u(26); // B3: toà đã xoá mềm
const R1 = u(31), R2 = u(32), R3 = u(33), RX = u(34), RD = u(35), RS = u(36);
// Khách / hợp đồng
const CU1 = u(41), CU2 = u(42), CU3 = u(43), CUX = u(44);
const C1 = u(51), C2 = u(52), CX = u(53), C3 = u(54);
const CC1 = u(61);
// Hoá đơn
const I1 = u(71), I2 = u(72), I3 = u(73), I4 = u(74), I5 = u(75), I6 = u(76), I7 = u(77), IX = u(78), IS = u(79), ID = u(80), I8 = u(85);

const db = new PGlite();

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
    CREATE TYPE public.invoice_status AS ENUM ('DRAFT','APPROVED','PARTIAL_PAID','PAID','OVERDUE','CANCELLED');
    CREATE TYPE public.payment_method AS ENUM ('TM','TK','TT','CT');

    CREATE TABLE memberships(user_id uuid, organization_id uuid, status text);
    CREATE TABLE super_admins(user_id uuid);
    CREATE TABLE demo_users(user_id uuid);
    -- Cạnh quyền thử: building_id NULL = toàn công ty org_id.
    CREATE TABLE test_grants(user_id uuid, perm text, org_id uuid, building_id uuid);

    CREATE TABLE buildings(id uuid PRIMARY KEY, organization_id uuid, user_id uuid, name text, name_sort text,
      default_account_id_tt uuid, default_account_id_tk uuid, deleted_at timestamptz);
    CREATE TABLE rooms(id uuid PRIMARY KEY, organization_id uuid, building_id uuid, name text, name_sort text);
    CREATE TABLE customers(id uuid PRIMARY KEY, organization_id uuid, user_id uuid, full_name text, phone text, deleted_at timestamptz);
    CREATE TABLE contracts(id uuid PRIMARY KEY, organization_id uuid, user_id uuid, room_id uuid, contract_number text,
      status text, public_code text, start_billing_date date);
    CREATE TABLE contract_customers(id uuid PRIMARY KEY, organization_id uuid, contract_id uuid, customer_id uuid,
      is_representative boolean, created_at timestamptz DEFAULT now());
    CREATE TABLE invoices(id uuid PRIMARY KEY, organization_id uuid, user_id uuid, contract_id uuid, building_id uuid, room_id uuid,
      invoice_number text, billing_month text, issue_date date, due_date date, status public.invoice_status,
      total_amount numeric(15,2), paid_amount numeric(15,2) DEFAULT 0,
      remaining_amount numeric(15,2) GENERATED ALWAYS AS (total_amount - paid_amount) STORED,
      notes text, adjustment_review_status text, created_at timestamptz, deleted_at timestamptz);
    CREATE TABLE invoice_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, invoice_id uuid, type text,
      accounting_class text, description text, unit_price numeric, quantity numeric, coefficient numeric, amount numeric,
      service_id uuid, previous_reading numeric, current_reading numeric, from_date date, to_date date, sort_order integer);
    CREATE TABLE payments(id uuid PRIMARY KEY, organization_id uuid, user_id uuid, invoice_id uuid, amount numeric,
      payment_date date, payment_method public.payment_method, notes text, receipt_image_url text, collection_id uuid, reversed_at timestamptz);
    CREATE VIEW active_payments WITH (security_invoker = true) AS SELECT * FROM payments WHERE reversed_at IS NULL;
    CREATE TABLE active_payment_receipts(organization_id uuid, invoice_id uuid, payment_method public.payment_method, collected_amount numeric);
    CREATE TABLE invoice_adjustments(id uuid PRIMARY KEY, organization_id uuid, invoice_id uuid, revision bigint, idempotency_key text,
      reason text, before_snapshot jsonb, after_snapshot jsonb, before_total numeric, after_total numeric, delta numeric,
      adjusted_by uuid, adjusted_at timestamptz, review_status text, checked_by uuid, checked_at timestamptz);
    CREATE TABLE invoice_payment_collections(id uuid PRIMARY KEY, status text);
    CREATE TABLE income_expense_types(id uuid PRIMARY KEY, organization_id uuid, is_deposit boolean);
    CREATE TABLE income_expenses(id uuid PRIMARY KEY, organization_id uuid, user_id uuid, building_id uuid, room_id uuid, invoice_id uuid,
      type text, approval_status text, voucher_date date, change_amount numeric DEFAULT 0, payment_collection_id uuid,
      payment_id uuid, deleted_at timestamptz);
    CREATE TABLE income_expense_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, income_expense_id uuid,
      income_expense_type_id uuid, amount numeric);

    -- Bản thu nhỏ đúng ngữ nghĩa các hàm quyền production (17/10/2026); DEFINER như production.
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT EXISTS(SELECT 1 FROM super_admins WHERE user_id = auth.uid()) $$;
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT coalesce(array_agg(organization_id), '{}') FROM memberships WHERE user_id = auth.uid() AND status = 'ACTIVE' $$;
    CREATE FUNCTION public.demo_user_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT coalesce(array_agg(user_id), '{}') FROM demo_users $$;
    CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql STABLE SET search_path = public AS $$ SELECT ARRAY['${SANDBOX}'::uuid] $$;
    CREATE FUNCTION public.demo_building_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT coalesce(array_agg(id), '{}') FROM buildings WHERE user_id = ANY (public.demo_user_ids()) $$;
    CREATE FUNCTION public.current_visible_owner_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT coalesce(array_agg(DISTINCT user_id), '{}') FROM memberships WHERE status = 'ACTIVE' AND organization_id = ANY (public.my_org_ids()) $$;
    CREATE FUNCTION public.can_access_org_entity(text, text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT public.is_super_admin() OR EXISTS(SELECT 1 FROM test_grants g WHERE g.user_id = auth.uid() AND g.perm = $1 || '.' || $2
        AND g.org_id = ANY (public.my_org_ids())) $$;
    -- Bộ giải chung: một dòng {org_wide, building_ids} gộp mọi công ty của người gọi (như production).
    CREATE FUNCTION app_private.authorized_scope_all_v3(p_permission_key text)
      RETURNS TABLE(org_wide boolean, building_ids uuid[], cashbook_ids uuid[]) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT coalesce(bool_or(g.building_id IS NULL), false),
             coalesce(array_agg(DISTINCT g.building_id) FILTER (WHERE g.building_id IS NOT NULL), '{}'), '{}'::uuid[]
        FROM test_grants g WHERE g.user_id = auth.uid() AND g.perm = p_permission_key AND g.org_id = ANY (public.my_org_ids()) $$;
    -- Hàm mà RLS production dùng (accessible_* = buildings_for_v3('buildings.view') …).
    CREATE FUNCTION public.accessible_building_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT b.id FROM buildings b, app_private.authorized_scope_all_v3('buildings.view') s
       WHERE b.deleted_at IS NULL AND (b.id = ANY (s.building_ids) OR (s.org_wide AND b.organization_id = ANY (public.my_org_ids()))) $$;
    CREATE FUNCTION public.accessible_room_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT r.id FROM rooms r WHERE r.building_id IN (SELECT public.accessible_building_ids()) $$;
    CREATE FUNCTION public.accessible_contract_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT c.id FROM contracts c JOIN rooms r ON r.id = c.room_id WHERE r.building_id IN (SELECT public.accessible_building_ids()) $$;
    CREATE FUNCTION public.accessible_invoice_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT i.id FROM invoices i WHERE i.building_id IN (SELECT public.accessible_building_ids()) $$;
    CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT public.is_super_admin() OR $1 IN (SELECT public.accessible_building_ids()) $$;
    CREATE FUNCTION public.can_do_on_building(text, text, uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT public.is_super_admin() OR EXISTS(SELECT 1 FROM test_grants g JOIN buildings b ON b.id = $3
        WHERE g.user_id = auth.uid() AND g.perm = $1 || '.' || $2 AND (g.building_id = b.id OR (g.building_id IS NULL AND g.org_id = b.organization_id))) $$;
    GRANT USAGE ON SCHEMA public, auth TO authenticated, anon, service_role;
    -- app_private KHÔNG cấp USAGE cho authenticated (như production): hàm INVOKER không được gọi thẳng vào đó.

    INSERT INTO memberships VALUES
      ('${OWNER}','${ORG_A}','ACTIVE'),('${STAFF}','${ORG_A}','ACTIVE'),('${STAFF_CUST}','${ORG_A}','ACTIVE'),
      ('${OTHER}','${ORG_B}','ACTIVE'),('${SUPER}','${ORG_A}','ACTIVE'),('${DEMO_USER}','${DEMO_ORG}','ACTIVE'),
      ('${NOPERM}','${ORG_A}','ACTIVE'),('${EX_MEMBER}','${ORG_A}','REVOKED');
    INSERT INTO super_admins VALUES ('${SUPER}');
    INSERT INTO demo_users VALUES ('${DEMO_USER}');
    INSERT INTO test_grants VALUES
      ('${OWNER}','invoices.view','${ORG_A}',NULL),('${OWNER}','buildings.view','${ORG_A}',NULL),('${OWNER}','customers.view','${ORG_A}',NULL),
      ('${STAFF}','buildings.view','${ORG_A}','${B1}'),('${STAFF}','buildings.view','${ORG_A}','${B2}'),('${STAFF}','invoices.view','${ORG_A}','${B1}'),
      ('${STAFF_CUST}','buildings.view','${ORG_A}','${B1}'),('${STAFF_CUST}','invoices.view','${ORG_A}','${B1}'),('${STAFF_CUST}','customers.view','${ORG_A}','${B1}'),
      ('${OTHER}','invoices.view','${ORG_B}',NULL),('${OTHER}','buildings.view','${ORG_B}',NULL),('${OTHER}','customers.view','${ORG_B}',NULL),
      ('${NOPERM}','buildings.view','${ORG_A}',NULL);

    INSERT INTO buildings VALUES
      ('${B1}','${ORG_A}','${OWNER}','Toà A','toa a',NULL,NULL,NULL),('${B2}','${ORG_A}','${OWNER}','Toà B','toa b',NULL,NULL,NULL),
      ('${BX}','${ORG_B}','${OTHER}','Toà X','toa x',NULL,NULL,NULL),('${BS}','${SANDBOX}','${OWNER}','Sandbox','sandbox',NULL,NULL,NULL),
      ('${BD}','${DEMO_ORG}','${DEMO_USER}','Demo','demo',NULL,NULL,NULL),
      ('${B3}','${ORG_A}','${OWNER}','Toà đã xoá','toa da xoa',NULL,NULL,'2026-08-01');
    INSERT INTO rooms VALUES ('${R1}','${ORG_A}','${B1}','101','101'),('${R2}','${ORG_A}','${B1}','102','102'),
      ('${R3}','${ORG_A}','${B2}','201','201'),('${RX}','${ORG_B}','${BX}','X1','x1'),('${RD}','${DEMO_ORG}','${BD}','D1','d1'),
      ('${RS}','${SANDBOX}','${BS}','S1','s1');
    INSERT INTO customers VALUES ('${CU1}','${ORG_A}','${OWNER}','Nguyễn Văn An','0901',NULL),
      ('${CU2}','${ORG_A}','${STAFF}','Trần Thị Bình','0902',NULL),('${CU3}','${ORG_A}','${EX_MEMBER}','Lê Cũ','0903',NULL),
      ('${CUX}','${ORG_B}','${OTHER}','An Khác','0904',NULL);
    INSERT INTO contracts VALUES ('${C1}','${ORG_A}','${OWNER}','${R1}','HĐ-1','ACTIVE','P1',NULL),
      ('${C2}','${ORG_A}','${OWNER}','${R3}','HĐ-2','ACTIVE','P2',NULL),('${CX}','${ORG_B}','${OTHER}','${RX}','HĐ-X','ACTIVE','PX',NULL),
      ('${C3}','${ORG_A}','${OWNER}','${R2}','HĐ-3','ACTIVE','P3',NULL);
    INSERT INTO contract_customers VALUES ('${CC1}','${ORG_A}','${C1}','${CU1}',true,'2026-01-01'),
      ('${u(62)}','${ORG_A}','${C2}','${CU2}',true,'2026-01-01'),('${u(63)}','${ORG_A}','${C3}','${CU3}',true,'2026-01-01'),
      ('${u(64)}','${ORG_B}','${CX}','${CUX}',true,'2026-01-01');
    INSERT INTO invoices(id,organization_id,user_id,contract_id,building_id,room_id,invoice_number,billing_month,issue_date,status,
        total_amount,paid_amount,adjustment_review_status,created_at,deleted_at) VALUES
      ('${I1}','${ORG_A}','${OWNER}','${C1}','${B1}','${R1}','HD-001','2026-10','2026-10-01','APPROVED',1000000,0,NULL,'2026-10-01 10:00+00',NULL),
      ('${I2}','${ORG_A}','${OWNER}','${C3}','${B1}','${R2}','HD-002','2026-10','2026-10-02','PAID',500000,500000,'CHECKED','2026-10-01 10:01+00',NULL),
      ('${I3}','${ORG_A}','${OWNER}','${C2}','${B2}','${R3}','HD-003','2026-10','2026-10-03','PARTIAL_PAID',800000,300000,NULL,'2026-10-01 10:02+00',NULL),
      ('${I4}','${ORG_A}','${OWNER}','${C1}','${B1}','${R1}','HD-004','2026-09','2026-09-01','CANCELLED',700000,0,NULL,'2026-09-01 10:00+00',NULL),
      ('${I5}','${ORG_A}','${OWNER}','${C1}','${B1}','${R1}','HD-005','2026-09','2026-09-02','OVERDUE',1002000,0,'PENDING','2026-09-02 10:00+00',NULL),
      ('${I6}','${ORG_A}','${OWNER}','${C1}','${B1}','${R1}','HD-006','2026-10','2026-10-01','APPROVED',1000000,0,NULL,'2026-10-01 09:00+00','2026-10-02'),
      ('${I7}','${ORG_A}','${OWNER}','${C1}','${B1}','${R1}','HD-007','2026-10','2026-10-04','DRAFT',1000000,0,NULL,'2026-10-01 10:05+00',NULL),
      ('${IX}','${ORG_B}','${OTHER}','${CX}','${BX}','${RX}','HD-X','2026-10','2026-10-01','APPROVED',999000,0,NULL,'2026-10-01 10:00+00',NULL),
      ('${IS}','${SANDBOX}','${OWNER}',NULL,'${BS}','${RS}','HD-S','2026-10','2026-10-01','APPROVED',1000,0,NULL,'2026-10-01 10:00+00',NULL),
      ('${ID}','${DEMO_ORG}','${DEMO_USER}',NULL,'${BD}','${RD}','HD-D','2026-10','2026-10-01','APPROVED',2000,0,NULL,'2026-10-01 10:00+00',NULL),
      ('${I8}','${ORG_A}','${OWNER}',NULL,'${B3}',NULL,'HD-008','2026-07','2026-07-01','APPROVED',3000,0,NULL,'2026-07-01 10:00+00',NULL);
    INSERT INTO invoice_items(organization_id,invoice_id,type,description,amount,sort_order) VALUES
      ('${ORG_A}','${I1}','RENT','Tiền phòng',900000,1),('${ORG_A}','${I1}','SERVICE','Tiền điện',60000,2),
      ('${ORG_A}','${I1}','SERVICE','Tiền nước',40000,3),('${ORG_A}','${I2}','RENT','Tiền phòng',450000,1),
      ('${ORG_A}','${I2}','SERVICE','Phí dịch vụ',50000,2),('${ORG_A}','${I3}','RENT','Tiền phòng',800000,1),
      ('${ORG_A}','${I4}','RENT','Tiền phòng',700000,1),('${ORG_A}','${I5}','RENT','Tiền phòng',1002000,1),
      ('${ORG_A}','${I7}','RENT','Tiền phòng',1000000,1),('${ORG_A}','${I7}','DISCOUNT','Giảm giá',-5000,2),
      ('${ORG_B}','${IX}','RENT','Tiền phòng',999000,1);
    INSERT INTO payments VALUES ('${u(81)}','${ORG_A}','${OWNER}','${I2}',500000,'2026-10-05','TM',NULL,NULL,NULL,NULL),
      ('${u(82)}','${ORG_A}','${OWNER}','${I3}',300000,'2026-10-05','TK',NULL,NULL,NULL,NULL),
      ('${u(83)}','${ORG_A}','${OWNER}','${I3}',100000,'2026-10-04','TM',NULL,NULL,NULL,'2026-10-06');
    INSERT INTO active_payment_receipts VALUES ('${ORG_A}','${I2}','TM',500000),('${ORG_A}','${I3}','TK',300000),
      ('${ORG_A}','${I3}','CT',0),('${ORG_B}','${IX}','TT',100000);
    INSERT INTO invoice_adjustments(id,organization_id,invoice_id,revision,reason,review_status) VALUES
      ('${u(91)}','${ORG_A}','${I5}',1,'Sửa số điện','PENDING'),('${u(92)}','${ORG_B}','${I5}',2,'Khác công ty','PENDING');
    UPDATE invoice_items SET accounting_class = 'REVENUE';
    INSERT INTO income_expense_types VALUES ('${u(111)}','${ORG_A}',true),('${u(112)}','${ORG_A}',false),('${u(113)}','${ORG_B}',true);
    INSERT INTO income_expenses(id,organization_id,building_id,room_id,invoice_id,type,approval_status,voucher_date,change_amount) VALUES
      ('${u(101)}','${ORG_A}','${B1}','${R2}','${I2}','INCOME','APPROVED','2026-10-05',20000),
      ('${u(102)}','${ORG_A}','${B1}','${R1}',NULL,'INCOME','APPROVED','2026-10-06',0),
      ('${u(103)}','${ORG_A}','${B2}','${R3}',NULL,'INCOME','APPROVED','2026-10-07',0),
      ('${u(104)}','${ORG_A}','${B1}','${R1}',NULL,'INCOME','UNAPPROVED','2026-10-08',0),
      ('${u(105)}','${ORG_B}','${BX}','${RX}',NULL,'INCOME','APPROVED','2026-10-08',0),
      ('${u(106)}','${ORG_A}','${B1}','${R1}','${I4}','INCOME','APPROVED','2026-09-05',7000),
      ('${u(107)}','${SANDBOX}','${BS}','${RS}',NULL,'INCOME','APPROVED','2026-10-08',0),
      ('${u(108)}','${ORG_A}','${B2}','${R3}','${I3}','INCOME','APPROVED','2026-10-06',3000);
    INSERT INTO income_expense_items(organization_id,income_expense_id,income_expense_type_id,amount) VALUES
      ('${ORG_A}','${u(102)}','${u(111)}',2000000),('${ORG_A}','${u(102)}','${u(112)}',150000),('${ORG_A}','${u(103)}','${u(111)}',1000000),
      ('${ORG_A}','${u(104)}','${u(111)}',5000000),('${ORG_B}','${u(105)}','${u(113)}',7000000),
      -- Cọc ở toà sandbox: super admin cũng KHÔNG được tính.
      ('${SANDBOX}','${u(107)}','${u(111)}',300000);
    UPDATE income_expenses SET user_id = '${OWNER}';
    -- Chủ có categories.view; nhân viên KHÔNG (RLS loại thu ẩn với họ) — thẻ cọc vẫn phải tính như v2.
    INSERT INTO test_grants VALUES ('${OWNER}','categories.view','${ORG_A}',NULL);

    -- RLS thu nhỏ theo đúng cấu trúc policy production 17/10 (permissive rbac + restrictive
    -- org_boundary/hide_demo/hide_sandbox + super_admin_all). Hàm INVOKER đọc QUA các policy này.
    DO $rls$ DECLARE t text; BEGIN
      FOREACH t IN ARRAY ARRAY['buildings','rooms','customers','contracts','contract_customers','invoices','invoice_items',
        'payments','active_payment_receipts','invoice_adjustments','invoice_payment_collections','income_expense_types',
        'income_expenses','income_expense_items'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('GRANT SELECT ON %I TO authenticated', t);
        IF t <> 'invoice_payment_collections' THEN
          EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL TO authenticated USING (organization_id IS NULL OR public.is_super_admin() OR organization_id = ANY (public.my_org_ids()))', t || '_org_boundary', t);
          EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR SELECT TO authenticated USING (NOT (public.is_super_admin() AND coalesce(organization_id = ANY (public.sandbox_org_ids()), false)))', t || '_hide_sandbox_admin', t);
        END IF;
        IF t NOT IN ('invoice_adjustments','invoice_payment_collections') THEN
          EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO authenticated USING (public.is_super_admin())', t || '_super_admin_all', t);
        END IF;
      END LOOP;
      FOREACH t IN ARRAY ARRAY['buildings','customers','contracts','invoices','payments','income_expenses'] LOOP
        EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR SELECT TO authenticated USING (NOT (public.is_super_admin() AND user_id = ANY (public.demo_user_ids())))', t || '_hide_demo_admin', t);
      END LOOP;
    END $rls$;
    GRANT SELECT ON active_payments TO authenticated;
    CREATE POLICY rooms_hide_demo_admin ON rooms AS RESTRICTIVE FOR SELECT TO authenticated USING (NOT (public.is_super_admin() AND building_id = ANY (public.demo_building_ids())));
    CREATE POLICY buildings_select_rbac ON buildings FOR SELECT USING (id IN (SELECT public.accessible_building_ids()));
    CREATE POLICY rooms_select_rbac ON rooms FOR SELECT USING (building_id IN (SELECT public.accessible_building_ids()));
    CREATE POLICY invoices_select_rbac ON invoices FOR SELECT USING (building_id IN (SELECT public.accessible_building_ids()));
    CREATE POLICY contracts_select_rbac ON contracts FOR SELECT USING (room_id IS NOT NULL AND room_id IN (SELECT public.accessible_room_ids()));
    CREATE POLICY contract_customers_select_rbac ON contract_customers FOR SELECT USING (contract_id IN (SELECT public.accessible_contract_ids()));
    CREATE POLICY customers_select_rbac ON customers FOR SELECT
      USING ((SELECT public.can_access_org_entity('customers', 'view')) AND user_id = ANY (public.current_visible_owner_ids()));
    CREATE POLICY invoice_items_select_rbac ON invoice_items FOR SELECT USING (invoice_id IN (SELECT public.accessible_invoice_ids()));
    CREATE POLICY payments_select_rbac ON payments FOR SELECT USING (invoice_id IN (SELECT public.accessible_invoice_ids()));
    -- Phiếu thu: production kiểm can_access_building TỪNG DÒNG — vì vậy hàm dùng chung vượt RLS qua helper DEFINER.
    CREATE POLICY active_payment_receipts_select ON active_payment_receipts FOR SELECT
      USING (EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id AND public.can_access_building(i.building_id)));
    CREATE POLICY invoice_adjustments_select_scope ON invoice_adjustments FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_adjustments.invoice_id AND i.organization_id = invoice_adjustments.organization_id
        AND public.can_access_building(i.building_id) AND public.can_do_on_building('invoices', 'view', i.building_id)));
    CREATE POLICY invoice_payment_collections_select ON invoice_payment_collections FOR SELECT TO authenticated USING (true);
    CREATE POLICY income_expense_types_select_rbac ON income_expense_types FOR SELECT USING (public.can_access_org_entity('categories', 'view'));
    CREATE POLICY income_expenses_select_rbac ON income_expenses FOR SELECT
      USING (building_id IS NOT NULL AND building_id IN (SELECT public.accessible_building_ids()));
    CREATE POLICY income_expense_items_select_rbac ON income_expense_items FOR SELECT
      USING (EXISTS (SELECT 1 FROM income_expenses v WHERE v.id = income_expense_items.income_expense_id AND v.organization_id = income_expense_items.organization_id));
  `);
  await db.exec(migrationSql);
  await db.exec(migrationSql);
}, 60_000);

afterAll(async () => { await db.close(); });

type Row = Record<string, unknown> & { id: string };
type ListResult = { total_count: number; rows: Row[] };

const LIST_TYPES: Record<string, string> = {
  p_billing_month: 'text', p_view_status: 'text', p_status: 'public.invoice_status', p_payment_status: 'text',
  p_filter_building_ids: 'uuid[]', p_room_ids: 'uuid[]', p_contract_id: 'uuid', p_issue_date_from: 'date',
  p_issue_date_to: 'date', p_amount_target: 'numeric', p_search: 'text', p_adjustment_review_status: 'text',
  p_payment_method: 'public.payment_method', p_building_ids: 'uuid[]', p_limit: 'integer', p_offset: 'integer',
};
const STAT_TYPES: Record<string, string> = {
  p_billing_month: 'text', p_status: 'public.invoice_status', p_payment_status: 'text', p_filter_building_ids: 'uuid[]',
  p_room_ids: 'uuid[]', p_issue_date_from: 'date', p_issue_date_to: 'date', p_building_ids: 'uuid[]',
};
const LIST_SIG = 'public.invoice_list_v1(text,text,public.invoice_status,text,uuid[],uuid[],uuid,date,date,numeric,text,text,public.payment_method,uuid[],integer,integer)';
const STAT_SIG = 'public.invoice_statistics_v3(text,public.invoice_status,text,uuid[],uuid[],date,date,uuid[])';

const toParam = (v: unknown) => (Array.isArray(v) ? `{${v.join(',')}}` : v);

async function tx<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec('BEGIN');
  try { return await fn(); } finally { await db.exec('ROLLBACK'); }
}

async function call(fnName: string, types: Record<string, string>, uid: string | null, args: Record<string, unknown>) {
  const names = Object.keys(args);
  for (const n of names) if (!types[n]) throw new Error(`tham số lạ ${n}`);
  await db.query("SELECT set_config('test.uid', $1, true)", [uid ?? '']);
  await db.exec('SET LOCAL ROLE authenticated');
  const params = names.map((n, i) => `${n} => $${i + 1}::${types[n]}`).join(', ');
  try {
    const sql = fnName === 'list'
      ? `SELECT public.invoice_list_v1(${params}) AS r`
      : `SELECT * FROM public.invoice_statistics_v3(${params})`;
    return await db.query<Record<string, unknown>>(sql, names.map((n) => toParam(args[n])));
  } finally {
    await db.exec('RESET ROLE').catch(() => undefined);
  }
}

async function list(uid: string | null, args: Record<string, unknown> = {}): Promise<ListResult> {
  const res = await call('list', LIST_TYPES, uid, args);
  return res.rows[0].r as ListResult;
}
async function ids(uid: string | null, args: Record<string, unknown> = {}) {
  const r = await list(uid, { p_limit: 100, ...args });
  expect(r.total_count).toBe(r.rows.length);
  return r.rows.map((row) => row.id);
}
async function stats(uid: string | null, args: Record<string, unknown> = {}) {
  const res = await call('stats', STAT_TYPES, uid, args);
  expect(res.rows).toHaveLength(1);
  return Object.fromEntries(Object.entries(res.rows[0]).map(([k, v]) => [k, Number(v)]));
}

const ZERO_STATS = {
  total_amount: 0, total_paid: 0, total_remaining: 0, total_refunded: 0, total_count: 0, rent_amount: 0,
  electric_amount: 0, water_amount: 0, pdv_amount: 0, total_collected: 0, payment_tm: 0, payment_tk: 0,
  payment_tt: 0, payment_ct: 0, change_amount: 0, deposit_collected: 0,
};

describe('invoice_list_v1 — quyền', () => {
  it('chủ công ty KHÔNG có phân công toà vẫn thấy đủ hoá đơn công ty, đúng thứ tự kỳ → toà → phòng → mới tạo', async () => {
    await tx(async () => {
      // I8 ở toà đã xoá mềm: như RLS web (buildings_for_v3 bỏ toà xoá) người thường không thấy.
      expect(await ids(OWNER)).toEqual([I7, I1, I2, I3, I5]);
      expect(await ids(OWNER, { p_filter_building_ids: [B3] })).toEqual([]);
    });
  });

  it('nhân viên chỉ thấy toà có invoices.view (buildings.view thôi chưa đủ)', async () => {
    await tx(async () => {
      expect(await ids(STAFF)).toEqual([I7, I1, I2, I5]);
      expect(await ids(NOPERM)).toEqual([]);
    });
  });

  it('công ty khác bị chặn; người không thuộc công ty nào nhận rỗng', async () => {
    await tx(async () => {
      expect(await ids(OTHER)).toEqual([IX]);
      expect(await ids(NOBODY)).toEqual([]);
      expect(await ids(OWNER, { p_filter_building_ids: [BX] })).toEqual([]);
    });
  });

  it('thu hồi invoices.view thì mất hoá đơn ngay trong lượt sau', async () => {
    await tx(async () => {
      await db.exec(`DELETE FROM test_grants WHERE user_id = '${OWNER}' AND perm = 'invoices.view'`);
      expect(await ids(OWNER)).toEqual([]);
    });
  });

  it('p_building_ids chỉ THU HẸP, không bao giờ mở rộng', async () => {
    await tx(async () => {
      expect(await ids(STAFF, { p_building_ids: [B1, B2] })).toEqual([I7, I1, I2, I5]);
      expect(await ids(STAFF, { p_building_ids: [B2] })).toEqual([]);
      expect(await ids(STAFF, { p_building_ids: [BX] })).toEqual([]);
      expect(await ids(OWNER, { p_building_ids: [B2] })).toEqual([I3]);
      // NULL = toàn phạm vi RLS; '{}' = không dòng nào (danh sách lẫn thẻ).
      expect(await ids(OWNER, { p_building_ids: null })).toEqual([I7, I1, I2, I3, I5]);
      expect(await ids(OWNER, { p_building_ids: [] })).toEqual([]);
      expect(await stats(OWNER, { p_building_ids: [] })).toEqual(ZERO_STATS);
      expect(await stats(OWNER, { p_building_ids: null })).toMatchObject({ total_count: 5 });
      expect(await ids(OWNER, { p_building_ids: [B1], p_filter_building_ids: [B2] })).toEqual([]);
    });
  });

  it('super admin thấy mọi công ty trừ sandbox và toà demo', async () => {
    await tx(async () => {
      const seen = await ids(SUPER);
      expect(seen).toContain(IX);
      expect(seen).not.toContain(IS);
      expect(seen).not.toContain(ID);
      // Super admin (như nhánh đặc quyền của v2 và RLS super_admin_all) vẫn thấy toà đã xoá mềm.
      expect(seen).toContain(I8);
      expect(seen).toHaveLength(7);
      // Điều chỉnh phải cùng công ty với hoá đơn (RLS select_scope), kể cả với super admin.
      const i5 = (await list(SUPER, { p_limit: 100 })).rows.find((r) => r.id === I5)!;
      expect((i5.invoice_adjustments as Row[]).map((a) => a.id)).toEqual([u(91)]);
    });
  });

  it('không có JWT ⇒ 42501, không trả rỗng giả (kể cả khi bộ lọc không khớp dòng nào)', async () => {
    await tx(async () => {
      await expect(list(null)).rejects.toMatchObject({ code: '42501' });
    });
    await tx(async () => {
      await expect(list(null, { p_billing_month: '1999-01' })).rejects.toMatchObject({ code: '42501' });
    });
    await tx(async () => {
      await expect(stats(null, { p_billing_month: '1999-01' })).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('ACL + mô hình: hai hàm chính INVOKER search_path rỗng; helper DEFINER chỉ cho authenticated', async () => {
    await tx(async () => {
      const helpers = ['public.invoice_scope_building_ids_v1()', 'public.invoice_receipt_methods_v1(uuid[])',
        'public.invoice_receipt_totals_v1(uuid[])', 'public.invoice_change_voucher_ids_v1(uuid[])',
        'public.invoice_deposit_item_ids_v1(text,uuid[],uuid[],date,date,uuid[])'];
      const r = await db.query<Record<string, unknown>>(`SELECT
        has_function_privilege('authenticated', '${LIST_SIG}', 'EXECUTE') AS list_auth,
        has_function_privilege('anon', '${LIST_SIG}', 'EXECUTE') AS list_anon,
        has_function_privilege('service_role', '${LIST_SIG}', 'EXECUTE') AS list_service,
        has_function_privilege('authenticated', '${STAT_SIG}', 'EXECUTE') AS stat_auth,
        has_function_privilege('anon', '${STAT_SIG}', 'EXECUTE') AS stat_anon,
        (SELECT bool_and(prosecdef) FROM pg_proc WHERE oid = ANY (ARRAY[${helpers.map((h) => `'${h}'::regprocedure`).join(',')}]::oid[])) AS helpers_definer,
        (SELECT bool_and(has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE'))
           FROM pg_proc WHERE oid = ANY (ARRAY[${helpers.map((h) => `'${h}'::regprocedure`).join(',')}]::oid[])) AS helpers_acl,
        (SELECT bool_or(prosecdef) FROM pg_proc WHERE oid IN ('${LIST_SIG}'::regprocedure, '${STAT_SIG}'::regprocedure)) AS main_definer,
        (SELECT bool_and(array_to_string(proconfig, ',') LIKE '%search_path=""%') FROM pg_proc WHERE oid IN ('${LIST_SIG}'::regprocedure, '${STAT_SIG}'::regprocedure)) AS main_empty_path,
        (SELECT count(*) FROM pg_proc WHERE proname IN ('invoice_read_context_v1', 'invoice_read_args_v1', 'invoice_search_pattern_v1', 'invoice_deposit_type_ids_v1'))::int AS draft_left`);
      expect(r.rows[0]).toEqual({
        list_auth: true, list_anon: false, list_service: false, stat_auth: true, stat_anon: false,
        helpers_definer: true, helpers_acl: true, main_definer: false, main_empty_path: true, draft_left: 0,
      });
    });
  });

  it('helper DEFINER chỉ trả trong phạm vi CHÍNH người gọi, kể cả khi bị gọi thẳng với id ngoài phạm vi', async () => {
    const asUser = async (uid: string | null, sql: string, params: unknown[] = []) => {
      await db.query("SELECT set_config('test.uid', $1, true)", [uid ?? '']);
      await db.exec('SET LOCAL ROLE authenticated');
      try { return (await db.query<Record<string, unknown>>(sql, params)).rows; } finally { await db.exec('RESET ROLE').catch(() => undefined); }
    };
    await tx(async () => {
      expect((await asUser(STAFF, 'SELECT public.invoice_scope_building_ids_v1() AS s'))[0].s).toEqual([B1]);
      const superScope = (await asUser(SUPER, 'SELECT public.invoice_scope_building_ids_v1() AS s'))[0].s as string[];
      expect(superScope).toContain(B3);
      expect(superScope).not.toContain(BS);
      expect(superScope).not.toContain(BD);
      // I3 ở B2: nhân viên có buildings.view B2 nhưng không có invoices.view ⇒ helper không cộng.
      expect((await asUser(STAFF, 'SELECT * FROM public.invoice_receipt_totals_v1($1::uuid[])', [`{${I2},${I3}}`]))[0])
        .toMatchObject({ total_collected: '500000', payment_tm: '500000', payment_tk: '0' });
      // Phiếu tiền thối của I3 (B2) không lọt qua helper cho nhân viên không có invoices.view ở B2.
      expect((await asUser(STAFF, 'SELECT public.invoice_change_voucher_ids_v1($1::uuid[]) AS v', [`{${I2},${I3}}`]))[0].v).toEqual([u(101)]);
      expect((await asUser(OWNER, 'SELECT public.invoice_change_voucher_ids_v1($1::uuid[]) AS v', [`{${I2},${I3}}`]))[0].v).toEqual([u(101), u(108)]);
      expect(await asUser(STAFF, 'SELECT payment_method, invoice_ids FROM public.invoice_receipt_methods_v1(NULL) ORDER BY 1'))
        .toEqual([{ payment_method: 'TM', invoice_ids: [I2] }]);
      expect(await asUser(OWNER, 'SELECT payment_method, invoice_ids FROM public.invoice_receipt_methods_v1(NULL) ORDER BY 1'))
        .toEqual([{ payment_method: 'TK', invoice_ids: [I3] }, { payment_method: 'TM', invoice_ids: [I2] }]);
    });
    await tx(async () => {
      await expect(asUser(null, 'SELECT public.invoice_scope_building_ids_v1()')).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('gọi từ thân hàm DEFINER (RLS bị bỏ qua) ⇒ 42501', async () => {
    await tx(async () => {
      await db.exec(`CREATE FUNCTION public.test_definer_wrapper() RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$ SELECT public.invoice_list_v1() $$;
        GRANT EXECUTE ON FUNCTION public.test_definer_wrapper() TO authenticated;`);
      await db.query("SELECT set_config('test.uid', $1, true)", [OWNER]);
      await db.exec('SET LOCAL ROLE authenticated');
      await expect(db.query('SELECT public.test_definer_wrapper()')).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('đọc QUA RLS của người gọi: thêm policy ẩn một hoá đơn ⇒ danh sách và thẻ cùng mất nó', async () => {
    await tx(async () => {
      await db.exec(`CREATE POLICY test_hide_i1 ON invoices AS RESTRICTIVE FOR SELECT TO authenticated USING (id <> '${I1}')`);
      expect(await ids(OWNER)).toEqual([I7, I2, I3, I5]);
      expect(await stats(OWNER, { p_billing_month: '2026-10' })).toMatchObject({ total_count: 3, total_amount: 2300000 });
    });
  });
});

describe('invoice_list_v1 — bộ lọc', () => {
  it('mặc định ẩn hoá đơn huỷ; cancelled/all; chọn đích danh trạng thái thì bỏ ẩn', async () => {
    await tx(async () => {
      expect(await ids(OWNER, { p_view_status: 'cancelled' })).toEqual([I4]);
      expect(await ids(OWNER, { p_view_status: 'all' })).toEqual([I7, I1, I2, I3, I5, I4]);
      expect(await ids(OWNER, { p_status: 'CANCELLED' })).toEqual([I4]);
      expect(await ids(OWNER, { p_view_status: 'cancelled', p_status: 'PAID' })).toEqual([]);
      expect(await ids(OWNER, { p_view_status: null })).toEqual([I7, I1, I2, I3, I5]);
    });
  });

  it('trạng thái thanh toán paid/partial/unpaid', async () => {
    await tx(async () => {
      expect(await ids(OWNER, { p_payment_status: 'paid' })).toEqual([I2]);
      expect(await ids(OWNER, { p_payment_status: 'partial' })).toEqual([I3]);
      expect(await ids(OWNER, { p_payment_status: 'unpaid' })).toEqual([I7, I1, I5]);
      expect(await ids(OWNER, { p_payment_status: 'unpaid', p_view_status: 'all' })).toEqual([I7, I1, I5, I4]);
    });
  });

  it('kỳ, phòng, hợp đồng, toà, ngày lập', async () => {
    await tx(async () => {
      expect(await ids(OWNER, { p_billing_month: '2026-09' })).toEqual([I5]);
      expect(await ids(OWNER, { p_room_ids: [R2] })).toEqual([I2]);
      expect(await ids(OWNER, { p_room_ids: [R2, R3] })).toEqual([I2, I3]);
      expect(await ids(OWNER, { p_contract_id: C2 })).toEqual([I3]);
      expect(await ids(OWNER, { p_filter_building_ids: [B2] })).toEqual([I3]);
      expect(await ids(OWNER, { p_issue_date_from: '2026-10-02', p_issue_date_to: '2026-10-03' })).toEqual([I2, I3]);
    });
  });

  it('số tiền ±5.000đ đúng hằng AMOUNT_SEARCH_TOLERANCE của web (hai mép)', async () => {
    expect(migrationSql).toContain(`p_amount_target - ${AMOUNT_SEARCH_TOLERANCE} AND p_amount_target + ${AMOUNT_SEARCH_TOLERANCE}`);
    await tx(async () => {
      expect(await ids(OWNER, { p_amount_target: 1000000 })).toEqual([I7, I1, I5]);
      expect(await ids(OWNER, { p_amount_target: 997000 })).toEqual([I7, I1, I5]);
      expect(await ids(OWNER, { p_amount_target: 996999 })).toEqual([I7, I1]);
    });
  });

  it('tìm số HĐ hoặc tên khách; chuẩn hoá , ( ) khoảng trắng Unicode và * như web/PostgREST', async () => {
    await tx(async () => {
      expect(await ids(OWNER, { p_search: 'hd-00' })).toEqual([I7, I1, I2, I3, I5]);
      expect(await ids(OWNER, { p_search: 'Văn An' })).toEqual([I7, I1, I5]);
      expect(await ids(OWNER, { p_search: '  (Văn,   An)  ' })).toEqual([I7, I1, I5]);
      expect(await ids(OWNER, { p_search: 'Văn An' })).toEqual([I7, I1, I5]);
      expect(await ids(OWNER, { p_search: 'Nguyễn*An' })).toEqual([I7, I1, I5]);
      expect(await ids(OWNER, { p_search: ' , ' })).toEqual([I7, I1, I2, I3, I5]);
      // Khách do người đã rời công ty tạo: RLS customers giấu ⇒ không tìm ra.
      expect(await ids(OWNER, { p_search: 'Lê Cũ' })).toEqual([]);
      // Không có customers.view ⇒ chỉ còn tìm theo số HĐ.
      expect(await ids(STAFF, { p_search: 'Văn An' })).toEqual([]);
      expect(await ids(STAFF_CUST, { p_search: 'Văn An' })).toEqual([I7, I1, I5]);
    });
  });

  it('kiểm tra điều chỉnh và phương thức thu', async () => {
    await tx(async () => {
      expect(await ids(OWNER, { p_adjustment_review_status: 'pending' })).toEqual([I5]);
      expect(await ids(OWNER, { p_adjustment_review_status: 'checked' })).toEqual([I2]);
      expect(await ids(OWNER, { p_payment_method: 'TM' })).toEqual([I2]);
      expect(await ids(OWNER, { p_payment_method: 'TK' })).toEqual([I3]);
      expect(await ids(OWNER, { p_payment_method: 'CT' })).toEqual([]);
    });
  });

  it('phân trang: tổng số đủ, trang đúng lát, quá trang thì rỗng nhưng vẫn có tổng', async () => {
    await tx(async () => {
      const p1 = await list(OWNER, { p_limit: 2, p_offset: 0 });
      const p2 = await list(OWNER, { p_limit: 2, p_offset: 2 });
      const p3 = await list(OWNER, { p_limit: 2, p_offset: 4 });
      const p9 = await list(OWNER, { p_limit: 2, p_offset: 40 });
      expect([p1, p2, p3, p9].map((p) => p.total_count)).toEqual([5, 5, 5, 5]);
      expect([...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.id)).toEqual([I7, I1, I2, I3, I5]);
      expect(p9.rows).toEqual([]);
      expect((await list(OWNER)).rows).toHaveLength(5); // mặc định 20 dòng
    });
  });

  it('tham số sai ⇒ 22023', async () => {
    for (const args of [{ p_view_status: 'xoa' }, { p_payment_status: 'x' }, { p_adjustment_review_status: 'x' }, { p_limit: 0 }, { p_offset: -1 }]) {
      await tx(async () => {
        await expect(list(OWNER, args)).rejects.toMatchObject({ code: '22023' });
      });
    }
  });
});

describe('invoice_list_v1 — dòng trả về', () => {
  it('đủ cột hoá đơn + quan hệ lồng như select của web; phiếu đã đảo bị bỏ', async () => {
    await tx(async () => {
      const rows = (await list(OWNER, { p_limit: 100 })).rows;
      const byId = new Map(rows.map((r) => [r.id, r]));
      const i1 = byId.get(I1)!;
      expect(i1).toMatchObject({
        invoice_number: 'HD-001', billing_month: '2026-10', status: 'APPROVED', total_amount: 1000000, remaining_amount: 1000000,
        building: { id: B1, name: 'Toà A', name_sort: 'toa a', default_account_id_tt: null, default_account_id_tk: null },
        room: { id: R1, name: '101', name_sort: '101' },
        contract: { id: C1, contract_number: 'HĐ-1', status: 'ACTIVE', public_code: 'P1', start_billing_date: null,
          contract_customers: [{ id: CC1, is_representative: true, customer: { id: CU1, full_name: 'Nguyễn Văn An', phone: '0901' } }] },
        payments: [], invoice_adjustments: [], active_payment_methods: [],
      });
      expect((i1.invoice_items as Row[]).map((x) => x.description)).toEqual(['Tiền phòng', 'Tiền điện', 'Tiền nước']);
      // Form sửa đọc accounting_class từ dòng danh sách.
      expect((i1.invoice_items as Row[]).map((x) => x.accounting_class)).toEqual(['REVENUE', 'REVENUE', 'REVENUE']);
      expect(byId.get(I3)).toMatchObject({ payments: [{ id: u(82), payment_method: 'TK', reversed_at: null }], active_payment_methods: ['TK'] });
      expect(byId.get(I2)).toMatchObject({ active_payment_methods: ['TM'], contract: { contract_customers: [{ customer: null }] } });
      // Điều chỉnh khác công ty với hoá đơn không lộ.
      expect((byId.get(I5)!.invoice_adjustments as Row[]).map((a) => a.id)).toEqual([u(91)]);
    });
  });

  it('thiếu customers.view: hợp đồng vẫn hiện, khách là null (như RLS web)', async () => {
    await tx(async () => {
      const i1 = (await list(STAFF, { p_limit: 100 })).rows.find((r) => r.id === I1)!;
      expect(i1).toMatchObject({ contract: { id: C1, contract_customers: [{ id: CC1, customer: null }] } });
      const i1c = (await list(STAFF_CUST, { p_limit: 100 })).rows.find((r) => r.id === I1)!;
      expect(i1c).toMatchObject({ contract: { contract_customers: [{ customer: { id: CU1 } }] } });
    });
  });
});

describe('invoice_statistics_v3', () => {
  it('chủ công ty không phân công toà RA SỐ THẬT (v2 ra 0)', async () => {
    await tx(async () => {
      expect(await stats(OWNER, { p_billing_month: '2026-10' })).toEqual({
        total_amount: 3300000, total_paid: 800000, total_remaining: 2500000, total_refunded: 0, total_count: 4,
        rent_amount: 3150000, electric_amount: 60000, water_amount: 40000, pdv_amount: 50000,
        total_collected: 800000, payment_tm: 500000, payment_tk: 300000, payment_tt: 0, payment_ct: 0,
        change_amount: 23000, deposit_collected: 3000000,
      });
    });
  });

  it('nhân viên: chỉ toà có invoices.view, kể cả cọc', async () => {
    await tx(async () => {
      expect(await stats(STAFF, { p_billing_month: '2026-10' })).toEqual({
        total_amount: 2500000, total_paid: 500000, total_remaining: 2000000, total_refunded: 0, total_count: 3,
        rent_amount: 2350000, electric_amount: 60000, water_amount: 40000, pdv_amount: 50000,
        total_collected: 500000, payment_tm: 500000, payment_tk: 0, payment_tt: 0, payment_ct: 0,
        change_amount: 20000, deposit_collected: 2000000,
      });
      expect(await stats(STAFF, { p_billing_month: '2026-10', p_building_ids: [B2] })).toEqual(ZERO_STATS);
      expect(await stats(OTHER, { p_billing_month: '2026-10', p_filter_building_ids: [B1] })).toEqual(ZERO_STATS);
      expect(await stats(NOBODY, { p_billing_month: '2026-10' })).toEqual(ZERO_STATS);
    });
  });

  it('huỷ chỉ tính khi hỏi đích danh CANCELLED; bộ lọc phòng/toà/trạng thái thanh toán', async () => {
    await tx(async () => {
      expect(await stats(OWNER, { p_status: 'CANCELLED' })).toMatchObject({ total_count: 1, total_amount: 700000, rent_amount: 700000, change_amount: 7000 });
      expect(await stats(OWNER)).toMatchObject({ total_count: 5, total_amount: 4302000 });
      expect(await stats(OWNER, { p_billing_month: '2026-10', p_room_ids: [R3] })).toMatchObject({ total_count: 1, total_amount: 800000, deposit_collected: 1000000 });
      expect(await stats(OWNER, { p_billing_month: '2026-10', p_filter_building_ids: [B2] })).toMatchObject({ total_count: 1, deposit_collected: 1000000 });
      expect(await stats(OWNER, { p_billing_month: '2026-10', p_payment_status: 'unpaid' })).toMatchObject({ total_count: 2, total_amount: 2000000 });
      expect(await stats(OWNER, { p_issue_date_from: '2026-10-06', p_issue_date_to: '2026-10-07' })).toMatchObject({ total_count: 0, deposit_collected: 3000000 });
    });
  });

  it('khớp danh sách: số hoá đơn và tổng tiền của thẻ = tập dòng của bảng cùng bộ lọc', async () => {
    await tx(async () => {
      for (const uid of [OWNER, STAFF, OTHER, SUPER]) {
        const rows = (await list(uid, { p_billing_month: '2026-10', p_limit: 1000 })).rows;
        const s = await stats(uid, { p_billing_month: '2026-10' });
        expect(s.total_count).toBe(rows.length);
        expect(s.total_amount).toBe(rows.reduce((sum, r) => sum + Number(r.total_amount), 0));
      }
    });
  });

  it('super admin: mọi công ty trừ sandbox/demo; không JWT ⇒ 42501', async () => {
    await tx(async () => {
      expect(await stats(SUPER, { p_billing_month: '2026-10' })).toMatchObject({ total_count: 5, total_amount: 4299000, deposit_collected: 10000000 });
    });
    await tx(async () => {
      await expect(stats(null)).rejects.toMatchObject({ code: '42501' });
    });
  });
});
