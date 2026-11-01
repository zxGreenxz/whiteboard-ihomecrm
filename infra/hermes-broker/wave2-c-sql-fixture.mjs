import { readFileSync } from 'node:fs';
import { sharedW2, BUILDING, OTHER_BUILDING, ROOM, OTHER_ROOM, USER, ORG, FOREIGN } from './wave2-sql-fixture.mjs';
import { CUSTOMER_A, CUSTOMER_B, CONTRACT_A } from './full-read-sql-fixture.mjs';

// Gói C đợt 2 (xe, kho vật tư, kho tài sản, thông báo, lương, Network Center) — fixture RIÊNG của Gói C, chỉ
// Gói C sửa. Dựng trên sharedW2 (đọc đầy đủ đợt 1 + nền đợt 2 + migration của CHÍNH gói C, dải 2026101803xxxx).
// Bảng: lấy NGUYÊN khối CREATE TABLE trong supabase/baseline/schema.sql (cột/kiểu/CHECK thật; khoá ngoại, trigger
// không có). RLS: bật trên mọi bảng hàm Gói C đọc, policy SELECT/ALL THẬT chép nguyên văn từ baseline + org_boundary
// của 20260808010000/20260808020000; các hàm mà policy gọi là cổng tổng hợp cùng chữ ký (fixture_acl,
// fixture_building_access, fixture_visible_owners, super_admins, organization_memberships). RPC web THẬT (định nghĩa
// cuối): network_center_* (baseline; list_h196a_v1 từ 20260829010000), app_private.network_center_require_view_v1,
// salary_staff_months (20260720180000). Mô hình INVOKER + RLS (18/10): hàm đọc của Gói C chạy bằng vai authenticated
// qua lối vào public.hermes_w2_read_v1 (authenticated KHÔNG có USAGE trên app_private). Không chứng minh JWT thật hay PostgREST.
// MỘT PGlite cho cả file test, mỗi ca BEGIN … ROLLBACK (shared.isolated).
const baseline = readFileSync('supabase/baseline/schema.sql', 'utf8');
const migration = name => readFileSync(`supabase/migrations/${name}.sql`, 'utf8');
export function tableDdl(name, src = baseline) {
  const start = src.indexOf(`CREATE TABLE public.${name} (\n`);
  if (start < 0) throw new Error(`missing table ${name}`);
  return src.slice(start, src.indexOf('\n);', start) + 3);
}
export function functionDdl(src, name) {
  const match = src.match(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION ${name.replaceAll('.', '\\.')}\\(`));
  if (!match) throw new Error(`missing function ${name}`);
  const tag = src.slice(match.index).match(/\bAS\s+(\$[a-z_]*\$)/i);
  const open = match.index + tag.index + tag[0].length;
  const close = src.indexOf(`${tag[1]};`, open);
  return src.slice(match.index, close + tag[1].length + 1);
}

const u = n => `0c0c0c0c-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const STAFF2 = u(1), OUTSIDER = u(2), FOREIGN_BUILDING = '0e0e0e0e-0000-4000-8000-000000000012';
export const VEHICLE = { mine: u(11), other: u(12), unassigned: u(13), foreign: u(14), deleted: u(15), hidden: u(16), stranger: u(17), foreignFree: u(18) };
export const HIDDEN_CUSTOMER = u(19);
export const CATEGORY = u(21), FOREIGN_CATEGORY = u(22), MATERIAL = { low: u(23), ok: u(24), deleted: u(25), foreign: u(26) };
export const SUPPLIER = u(27), HIDDEN_SUPPLIER = u(28), PURCHASE = { visible: u(29), hidden: u(30), foreign: u(31) };
export const JOB_A = u(32), JOB_B = u(33), USAGE = { a: u(34), b: u(35) }, ADJUSTMENT = { in: u(36), out: u(37) };
export const WAREHOUSE = { a: u(41), b: u(42), free: u(43), foreign: u(44) };
export const NOTE = { unread: u(51), read: u(52), legacy: u(53), otherOrg: u(54), otherUser: u(55), email: u(56), lifecycleFree: u(57), lifecycle: u(58) };
export const SALARY = { mine: u(61), staff2: u(62), mineOct: u(63), foreign: u(64) };
export const ROUTER = { a: u(71), b: u(72), foreign: u(73) }, PORT = { wan: u(74), lan: u(75) }, INCIDENT = u(76), SNAPSHOT = { old: u(77), new: u(78) };
export const CLIENT = { linked: u(81), hidden: u(82), loose: u(83) }, ARUBA = u(84), H196A = u(85), COMMAND = u(86), AUDIT = u(87);

const BEFORE = `
  ALTER TABLE public.buildings ADD COLUMN total_rooms integer,ADD COLUMN user_id uuid;
  ALTER TABLE public.staff_assignments ADD COLUMN user_id uuid;
  CREATE OR REPLACE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public
    AS $$SELECT EXISTS(SELECT 1 FROM public.super_admins WHERE user_id=auth.uid())$$;
  -- Cổng tổng hợp cùng chữ ký bản thật (20260725210000:110): quyền theo toà từ fixture_acl.
  CREATE OR REPLACE FUNCTION public.can_do_on_building(_table text,_action text,_building_id uuid) RETURNS boolean LANGUAGE sql STABLE
    SECURITY DEFINER SET search_path=pg_catalog,public AS $$
    SELECT EXISTS(SELECT 1 FROM public.fixture_acl a JOIN public.buildings b ON b.id=_building_id AND b.organization_id='${ORG}'
      WHERE a.permission=_table||'.'||_action AND a.allowed AND (a.org_wide OR _building_id=ANY(a.building_ids)))$$;
  -- Cổng tổng hợp cho các hàm mà policy RLS thật gọi (cùng chữ ký bản thật).
  CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public
    AS $$SELECT public.is_super_admin()$$;
  CREATE OR REPLACE FUNCTION public.is_user_super_admin(_user uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public
    AS $$SELECT EXISTS(SELECT 1 FROM public.super_admins WHERE user_id=_user)$$;
  CREATE OR REPLACE FUNCTION public.has_full_building_scope() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public
    AS $$SELECT public.is_super_admin()$$;
  CREATE OR REPLACE FUNCTION public.demo_user_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$SELECT '{}'::uuid[]$$;
  CREATE OR REPLACE FUNCTION public.demo_building_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$SELECT '{}'::uuid[]$$;
  CREATE OR REPLACE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$SELECT '{}'::uuid[]$$;
  CREATE OR REPLACE FUNCTION public.can_access_org_entity(_resource text,_action text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path=pg_catalog,public AS $$SELECT public.is_super_admin() OR EXISTS(SELECT 1 FROM public.fixture_acl
      WHERE permission=_resource||'.'||_action AND allowed AND auth.uid()='${USER}'::uuid)$$;
  CREATE OR REPLACE FUNCTION public.accessible_building_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public
    AS $$SELECT building_id FROM public.fixture_building_access WHERE auth.uid()='${USER}'::uuid$$;
  CREATE OR REPLACE FUNCTION public.accessible_room_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public
    AS $$SELECT r.id FROM public.rooms r WHERE r.building_id IN (SELECT public.accessible_building_ids())$$;
  CREATE OR REPLACE FUNCTION public.same_team(_target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public
    AS $$SELECT EXISTS(SELECT 1 FROM public.organization_memberships a JOIN public.organization_memberships b ON b.organization_id=a.organization_id
      WHERE a.user_id=auth.uid() AND a.status='ACTIVE' AND b.user_id=_target AND b.status='ACTIVE')$$;
  ALTER TABLE public.contracts ADD COLUMN IF NOT EXISTS user_id uuid;
  GRANT SELECT ON public.fixture_acl,public.fixture_visible_owners,public.fixture_building_access,public.staff_assignments TO authenticated;
  CREATE TYPE public.vehicle_type AS ENUM('MOTORBIKE','CAR','BICYCLE','OTHER','ELECTRIC_BIKE');
  CREATE TYPE public.notification_type AS ENUM('NEW_INVOICE','PAYMENT_REMINDER','OVERDUE_INVOICE','CONTRACT_EXPIRING','ISSUE_RESOLVED',
    'GENERAL_ANNOUNCEMENT','CUSTOM','DEPOSIT_SHORTFALL','SALARY_BONUS','ACTION_REQUIRED','APPROVAL_RESULT');
  CREATE TYPE public.notification_channel AS ENUM('IN_APP','EMAIL','SMS','ZALO','PUSH');
  CREATE TYPE public.notification_status AS ENUM('PENDING','SENT','FAILED','CANCELLED','READ');`;
const TABLES = ['vehicles', 'materials', 'material_categories', 'material_purchases', 'material_purchase_items', 'material_usages', 'material_usage_items',
  'material_adjustments', 'material_adjustment_items', 'asset_warehouses', 'notifications', 'suppliers', 'jobs', 'profiles', 'salary_monthly',
  'salary_adjustments', 'salary_work_ledger_snapshot', 'manager_salary_config', 'salary_bonus_rules', 'network_devices', 'network_device_current',
  'network_device_connections', 'network_interfaces', 'network_interface_current', 'network_incidents', 'network_maintenance_windows',
  'network_config_snapshots', 'network_site_settings', 'network_sla_daily', 'network_client_current', 'network_client_links', 'network_commands',
  'network_audit_events'];
const H196A_SRC = migration('20260829010000_network_center_h196a_downstream');
const h196aTable = () => {
  const start = H196A_SRC.indexOf('CREATE TABLE IF NOT EXISTS app_private.network_h196a_profiles (');
  return H196A_SRC.slice(start, H196A_SRC.indexOf('\n);', start) + 3).replace(/ REFERENCES public\.network_devices\(id\) ON DELETE CASCADE/g, '');
};
export const WEB_RPCS = [
  [baseline, 'app_private.network_center_require_view_v1'], [baseline, 'app_private.network_center_list_fleet_base_v1'],
  [baseline, 'public.network_center_list_fleet_v1'], [baseline, 'app_private.network_center_get_building_base_v1'],
  [baseline, 'public.network_center_get_building_v1'], [baseline, 'public.network_center_list_clients_v1'],
  [baseline, 'public.network_center_list_aruba_v1'], [H196A_SRC, 'public.network_center_list_h196a_v1'],
  [baseline, 'public.network_center_list_commands_v1'], [baseline, 'public.network_center_list_audit_v1'],
  [baseline, 'public.network_center_compare_snapshots_v1'],
  [migration('20260720180000_fix_salary_staff_months_owner'), 'public.salary_staff_months'],
];

// Bảng Gói C đọc dưới RLS (mỗi bảng: policy SELECT/ALL thật trong baseline + org_boundary sau baseline).
const RLS_TABLES = ['vehicles', 'materials', 'material_categories', 'material_purchases', 'material_purchase_items', 'material_usages',
  'material_usage_items', 'material_adjustments', 'material_adjustment_items', 'asset_warehouses', 'notifications', 'suppliers', 'jobs', 'profiles',
  'salary_monthly', 'salary_adjustments', 'salary_work_ledger_snapshot', 'manager_salary_config', 'customers', 'buildings', 'rooms', 'contracts'];
const statements = src => src.match(/^CREATE POLICY [\s\S]*?;$/gm) ?? [];
export function rlsPolicies() {
  const later = ['20260808010000_gd3_rao_bang_an_toan', '20260808020000_gd4_rao_bang_dang_ro'].flatMap(name => statements(migration(name)));
  const out = [];
  for (const table of RLS_TABLES) {
    const own = sql => sql.includes(` ON public.${table}\n`) || sql.includes(` ON public.${table} `);
    const mine = statements(baseline).filter(sql => own(sql) && !/ FOR (INSERT|UPDATE|DELETE) /.test(sql) && !/ TO (ie_canonical_writer|openclaw_\w+) /.test(sql));
    const boundary = later.filter(sql => own(sql) && sql.includes(`${table}_org_boundary`));
    if (!mine.length) throw new Error(`no policy for ${table}`);
    out.push(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`, `GRANT SELECT ON public.${table} TO authenticated;`, ...mine,
      ...(mine.some(sql => sql.includes(`${table}_org_boundary`)) ? [] : boundary));
  }
  return out;
}

// Thân production của hàm đọc gói C (20261019040948, nền của 20261022180402 tasks_board) gọi public.vehicles_list_core_v1(…, p_allow_copied_owner):
// bản thật cho chép tên chủ xe khi kết nối inherit_crm (cờ allowCopiedCustomerText của cổng 040948). Cổng đợt 2 của fixture (185339) không bao
// giờ đặt cờ ⇒ bản thật với cờ false = vehicles_list_v1 của gói (tên chủ xe chỉ khi hồ sơ khách hiện). Cổng thế chỗ cùng chữ ký uỷ cho
// vehicles_list_v1, nên các ca + đột biến xe của gói vẫn đo đúng hàm dùng chung; copied-text-parity-sql.test.mjs đo bản thật.
const VEHICLES_CORE_PORT = `CREATE OR REPLACE FUNCTION public.vehicles_list_core_v1(p_organization_id uuid,p_building_ids uuid[] DEFAULT NULL,
    p_customer_building_ids uuid[] DEFAULT NULL,p_include_unassigned boolean DEFAULT true,p_query text DEFAULT NULL,p_vehicle_type text DEFAULT NULL,
    p_room_id uuid DEFAULT NULL,p_customer_id uuid DEFAULT NULL,p_limit integer DEFAULT NULL,p_offset integer DEFAULT 0,p_allow_copied_owner boolean DEFAULT true)
  RETURNS TABLE(id uuid,vehicle_type text,vehicle_name text,license_plate text,color text,owner_name text,ticket_number text,parking_fee numeric,
    building_id uuid,building_name text,room_id uuid,room_name text,customer_id uuid,customer_name text,customer_phone text,created_at timestamptz,
    total_count bigint,organization_id uuid)
  LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $port$
  BEGIN
    IF p_allow_copied_owner THEN RAISE EXCEPTION 'fixture_port_copied_owner_not_ported' USING ERRCODE='0A000'; END IF;
    RETURN QUERY SELECT * FROM public.vehicles_list_v1(p_organization_id,p_building_ids,p_customer_building_ids,p_include_unassigned,p_query,
      p_vehicle_type,p_room_id,p_customer_id,p_limit,p_offset);
  END $port$;
  GRANT EXECUTE ON FUNCTION public.vehicles_list_core_v1(uuid,uuid[],uuid[],boolean,text,text,uuid,uuid,integer,integer,boolean) TO authenticated;
  -- Công việc Mốc 4 (tasks_board): loại việc + múi giờ công ty đọc dưới vai authenticated (cột tối thiểu mà jobs_board_v1 đọc; không policy).
  CREATE TABLE public.job_types(id uuid PRIMARY KEY,organization_id uuid,name text,is_active boolean);
  CREATE TABLE public.organization_timezones(organization_id uuid PRIMARY KEY,timezone text NOT NULL);
  GRANT SELECT ON public.job_types,public.organization_timezones TO authenticated;`;

async function before(db) {
  await db.exec(BEFORE);
  for (const name of TABLES) await db.exec(tableDdl(name));
  await db.exec(VEHICLES_CORE_PORT);
  // 20260829010000:50-54 mở loại ZTE_H196A (baseline chỉ MIKROTIK/ARUBA).
  await db.exec(`ALTER TABLE public.network_devices DROP CONSTRAINT IF EXISTS network_devices_kind_check;
    ALTER TABLE public.network_devices ADD CONSTRAINT network_devices_kind_check CHECK (device_kind = ANY (ARRAY['MIKROTIK'::text,'ARUBA'::text,'ZTE_H196A'::text]));`);
  await db.exec(h196aTable());
  for (const [src, name] of WEB_RPCS) await db.exec(functionDdl(src, name));
  for (const sql of rlsPolicies()) await db.exec(sql);
}

const ts = minutes => `'2026-10-16T08:00:00Z'::timestamptz-interval '${minutes} minutes'`;
const SEED = `
  INSERT INTO public.organization_memberships(id,user_id,organization_id,status) VALUES('${STAFF2}','${STAFF2}','${ORG}','ACTIVE');
  INSERT INTO public.profiles(id,full_name) VALUES('${USER}','Quản lý Một'),('${STAFF2}','Quản lý Hai'),('${OUTSIDER}','Người ngoài');
  INSERT INTO public.customers(id,organization_id,user_id,full_name,phone) VALUES('${HIDDEN_CUSTOMER}','${ORG}','${OUTSIDER}','Khách Chủ Khác','0977777777');
  -- C1 xe
  INSERT INTO public.vehicles(id,user_id,organization_id,vehicle_type,vehicle_name,license_plate,color,owner_name,ticket_number,parking_fee,
      building_id,room_id,customer_id,created_at,deleted_at) VALUES
    ('${VEHICLE.mine}','${USER}','${ORG}','MOTORBIKE','Wave','59A1-11111','Đỏ','Chủ xe An','V-01',150000,'${BUILDING}','${ROOM}','${CUSTOMER_A}',${ts(1)},null),
    ('${VEHICLE.other}','${USER}','${ORG}','CAR','Vios','51F-22222',null,null,null,0,'${OTHER_BUILDING}','${OTHER_ROOM}','${CUSTOMER_B}',${ts(2)},null),
    ('${VEHICLE.unassigned}','${USER}','${ORG}','MOTORBIKE','Sirius','59X-33333',null,'Chủ tự do',null,0,null,null,null,${ts(3)},null),
    ('${VEHICLE.foreign}','${USER}','${FOREIGN}','MOTORBIKE','Ngoài','59A1-44444',null,null,null,0,'${FOREIGN_BUILDING}',null,null,${ts(4)},null),
    ('${VEHICLE.deleted}','${USER}','${ORG}','MOTORBIKE','Đã xoá','59A1-55555',null,null,null,0,'${BUILDING}',null,null,${ts(5)},${ts(0)}),
    ('${VEHICLE.hidden}','${USER}','${ORG}','ELECTRIC_BIKE','VinFast','59A1-66666',null,null,null,0,'${BUILDING}',null,'${HIDDEN_CUSTOMER}',${ts(6)},null),
    ('${VEHICLE.stranger}','${OUTSIDER}','${ORG}','MOTORBIKE','Lạ','59A1-77777',null,null,null,0,null,null,null,${ts(7)},null),
    ('${VEHICLE.foreignFree}','${USER}','${FOREIGN}','MOTORBIKE','Ngoài tự do','59A1-88888',null,null,null,0,null,null,null,${ts(8)},null);
  -- C2–C5 kho vật tư
  INSERT INTO public.material_categories(id,user_id,organization_id,name,description) VALUES('${CATEGORY}','${USER}','${ORG}','Điện','Vật tư điện'),
    ('${FOREIGN_CATEGORY}','${USER}','${FOREIGN}','Ngoài',null);
  INSERT INTO public.materials(id,user_id,organization_id,code,name,category_id,unit,description,reorder_level,on_hand,avg_unit_cost,deleted_at) VALUES
    ('${MATERIAL.low}','${USER}','${ORG}','VT-01','Bóng đèn LED','${CATEGORY}','cái','Đèn trần',5,2,45000,null),
    ('${MATERIAL.ok}','${USER}','${ORG}','VT-02','Ổ cắm','${CATEGORY}','cái',null,1,10,30000,null),
    ('${MATERIAL.deleted}','${USER}','${ORG}','VT-03','Đã xoá',null,'cái',null,0,0,0,${ts(0)}),
    ('${MATERIAL.foreign}','${USER}','${FOREIGN}','VT-X','Vật tư ngoài','${FOREIGN_CATEGORY}','cái',null,9,0,1,null);
  INSERT INTO public.suppliers(id,user_id,organization_id,name,phone) VALUES('${SUPPLIER}','${USER}','${ORG}','NCC Ánh Sáng','0281234567'),
    ('${HIDDEN_SUPPLIER}','${OUTSIDER}','${ORG}','NCC Chủ Khác','0287654321');
  INSERT INTO public.material_purchases(id,user_id,organization_id,code,purchase_date,supplier_id,total,notes,created_at) VALUES
    ('${PURCHASE.visible}','${USER}','${ORG}','PN-01','2026-10-10','${SUPPLIER}',95000,'Nhập đèn',${ts(10)}),
    ('${PURCHASE.hidden}','${USER}','${ORG}','PN-02','2026-10-12','${HIDDEN_SUPPLIER}',30000,null,${ts(9)}),
    ('${PURCHASE.foreign}','${USER}','${FOREIGN}','PN-X','2026-10-11',null,1,null,${ts(8)});
  INSERT INTO public.material_purchase_items(purchase_id,material_id,quantity,unit_price,organization_id) VALUES
    ('${PURCHASE.visible}','${MATERIAL.low}',1,45000,'${ORG}'),('${PURCHASE.visible}','${MATERIAL.ok}',2,25000,'${ORG}'),
    ('${PURCHASE.hidden}','${MATERIAL.ok}',1,30000,'${ORG}');
  INSERT INTO public.jobs(id,user_id,organization_id,code,title,building_id) VALUES('${JOB_A}','${USER}','${ORG}','CV-A','Thay đèn hành lang','${BUILDING}'),
    ('${JOB_B}','${USER}','${ORG}','CV-B','Sửa ổ cắm P201','${OTHER_BUILDING}');
  INSERT INTO public.material_usages(id,user_id,organization_id,code,usage_date,job_id,notes,created_at) VALUES
    ('${USAGE.a}','${USER}','${ORG}','PX-01','2026-10-13','${JOB_A}',null,${ts(5)}),('${USAGE.b}','${STAFF2}','${ORG}','PX-02','2026-10-14','${JOB_B}','gấp',${ts(4)});
  INSERT INTO public.material_usage_items(usage_id,material_id,quantity,unit_cost_at_usage,organization_id) VALUES
    ('${USAGE.a}','${MATERIAL.low}',2,45000,'${ORG}'),('${USAGE.b}','${MATERIAL.ok}',1,30000,'${ORG}');
  INSERT INTO public.material_adjustments(id,user_id,organization_id,code,adjustment_date,type,reason,created_at) VALUES
    ('${ADJUSTMENT.in}','${USER}','${ORG}','KK-01','2026-10-01','IN','Kiểm kê thừa',${ts(30)}),
    ('${ADJUSTMENT.out}','${USER}','${ORG}','KK-02','2026-10-02','OUT','Hỏng',${ts(20)});
  INSERT INTO public.material_adjustment_items(adjustment_id,material_id,quantity,organization_id) VALUES('${ADJUSTMENT.in}','${MATERIAL.ok}',3,'${ORG}'),
    ('${ADJUSTMENT.out}','${MATERIAL.low}',1,'${ORG}');
  -- C6 kho tài sản
  INSERT INTO public.asset_warehouses(id,name,location,building_id,user_id,organization_id) VALUES
    ('${WAREHOUSE.a}','Kho A','Tầng trệt','${BUILDING}','${USER}','${ORG}'),('${WAREHOUSE.b}','Kho B',null,'${OTHER_BUILDING}','${USER}','${ORG}'),
    ('${WAREHOUSE.free}','Kho chung','Văn phòng',null,'${USER}','${ORG}'),('${WAREHOUSE.foreign}','Kho ngoài',null,null,'${USER}','${FOREIGN}');
  -- C9 thông báo
  INSERT INTO public.notifications(id,user_id,organization_id,type,channel,subject,content,status,metadata,created_at) VALUES
    ('${NOTE.unread}','${USER}','${ORG}','NEW_INVOICE','IN_APP','Hoá đơn mới','Phòng P101 có hoá đơn T10','PENDING','{}',${ts(1)}),
    ('${NOTE.read}','${USER}','${ORG}','APPROVAL_RESULT','IN_APP','Đã duyệt','Phiếu chi đã duyệt','READ','{}',${ts(2)}),
    ('${NOTE.legacy}','${USER}',null,'CUSTOM','IN_APP',null,'Thông báo chung','PENDING','{}',${ts(3)}),
    ('${NOTE.otherOrg}','${USER}','${FOREIGN}','CUSTOM','IN_APP',null,'Việc công ty khác','PENDING','{}',${ts(4)}),
    ('${NOTE.otherUser}','${OUTSIDER}','${ORG}','CUSTOM','IN_APP',null,'Của người khác','PENDING','{}',${ts(5)}),
    ('${NOTE.email}','${USER}','${ORG}','CUSTOM','EMAIL',null,'Kênh email','PENDING','{}',${ts(6)}),
    ('${NOTE.lifecycleFree}','${USER}',null,'ACTION_REQUIRED','IN_APP',null,'Vòng đời không công ty','PENDING','{"event":"LIFECYCLE"}',${ts(7)}),
    ('${NOTE.lifecycle}','${USER}','${ORG}','ACTION_REQUIRED','IN_APP',null,'Vòng đời công ty này','READ','{"event":"LIFECYCLE"}',${ts(8)});
  -- C7/C8 lương
  INSERT INTO public.manager_salary_config(user_id,staff_id,base_salary,role_title,alias,effective_from,effective_to,is_active,organization_id) VALUES
    ('${USER}','${USER}',8000000,'Quản lý toà','Một','2026-01-01',null,true,'${ORG}'),
    ('${USER}','${STAFF2}',7000000,'Quản lý khu',null,'2026-01-01',null,true,'${ORG}'),
    ('${USER}','${OUTSIDER}',6000000,'Ngoài',null,'2026-01-01',null,true,'${FOREIGN}');
  INSERT INTO public.salary_monthly(id,user_id,staff_id,period_month,status,base_salary,work_bonus,contract_bonus,commission_total,investment_profit,
      adjustments_total,advances_total,room_rent,gross_total,take_home,paid,locked_at,organization_id) VALUES
    ('${SALARY.mine}','${USER}','${USER}','2026-09-01','LOCKED',8000000,1200000,300000,2500000,400000,300000,1000000,1500000,12700000,10200000,4000000,
      '2026-10-05T03:00:00Z','${ORG}'),
    ('${SALARY.staff2}','${USER}','${STAFF2}','2026-09-01','DRAFT',7000000,1,1,1,1,1,1,1,9999999,9999999,0,null,'${ORG}'),
    ('${SALARY.mineOct}','${USER}','${USER}','2026-10-01','DRAFT',8000000,1,1,1,1,1,1,1,8888888,8888888,0,null,'${ORG}'),
    ('${SALARY.foreign}','${USER}','${OUTSIDER}','2026-09-01','LOCKED',6000000,0,0,0,0,0,0,0,6000000,6000000,0,'2026-10-05T03:00:00Z','${FOREIGN}');
  INSERT INTO public.salary_adjustments(user_id,salary_monthly_id,kind,label,amount,note,source,organization_id,created_at) VALUES
    ('${USER}','${SALARY.mine}','BONUS','Thưởng KPI',500000,'Đạt chỉ tiêu','MANUAL','${ORG}',${ts(3)}),
    ('${USER}','${SALARY.mine}','DEDUCTION','Đi trễ',200000,null,'MANUAL','${ORG}',${ts(2)});
  INSERT INTO public.salary_work_ledger_snapshot(user_id,salary_monthly_id,staff_id,item_type,occurred_date,content,place,job_type_name,is_repair,
      is_contract,bonus_amount,organization_id) VALUES
    ('${USER}','${SALARY.mine}','${USER}','JOB','2026-09-03','Sửa vòi nước','P101','Sửa chữa',true,false,30000,'${ORG}'),
    ('${USER}','${SALARY.mine}','${USER}','DAY_BONUS','2026-09-07','CN có sửa chữa',null,null,false,false,20000,'${ORG}');
  -- C10–C14 Network Center
  UPDATE public.buildings SET total_rooms=12 WHERE id='${BUILDING}';
  INSERT INTO public.network_devices(id,organization_id,building_id,device_kind,external_key,display_name,vendor,model,sort_order,lifecycle_status,is_active,
      inventory_metadata,parent_device_id,aruba_stable_key,aruba_identity_source,aruba_discovery_state,aruba_discovery_first_seen_at,
      aruba_discovery_last_seen_at) VALUES
    ('${ROUTER.a}','${ORG}','${BUILDING}','MIKROTIK','rb-a','Router A','MikroTik','RB5009',0,'ONLINE',true,'{}',null,null,null,null,null,null),
    ('${ROUTER.b}','${ORG}','${OTHER_BUILDING}','MIKROTIK','rb-b','Router B','MikroTik','RB5009',0,'OFFLINE',true,'{}',null,null,null,null,null,null),
    ('${ROUTER.foreign}','${FOREIGN}','${FOREIGN_BUILDING}','MIKROTIK','rb-x','Router X','MikroTik','RB5009',0,'ONLINE',true,'{}',null,null,null,null,null,null),
    ('${ARUBA}','${ORG}','${BUILDING}','ARUBA','serial:CN123','AP Tầng 2','Aruba','AP-505',1,'ONLINE',true,'{"managementAddress":"10.0.0.21"}','${ROUTER.a}',
      'serial:CN123','SERIAL','PINNED',${ts(500)},${ts(1)}),
    ('${H196A}','${ORG}','${BUILDING}','ZTE_H196A','mac:a0:11:22:33:44:55','H196A 445566','ZTE','H196A',2,'ONLINE',true,'{}','${ROUTER.a}',
      null,null,null,null,null);
  INSERT INTO public.network_device_current(device_id,organization_id,building_id,observed_at,last_seen_at,reachable,health_status,identity_name,
      routeros_version,cpu_pct,memory_used_bytes,memory_total_bytes,pppoe_state,connection_count) VALUES
    ('${ROUTER.a}','${ORG}','${BUILDING}',${ts(1)},${ts(1)},true,'HEALTHY','rb-toa-a','7.15',12.5,268435456,1073741824,'UP',42),
    ('${ROUTER.b}','${ORG}','${OTHER_BUILDING}',${ts(1)},${ts(1)},false,'OFFLINE','rb-toa-b','7.14',null,null,null,'UNKNOWN',null);
  INSERT INTO public.network_interfaces(id,organization_id,building_id,device_id,interface_key,display_name,interface_role,is_protected,sort_order) VALUES
    ('${PORT.wan}','${ORG}','${BUILDING}','${ROUTER.a}','ether1','WAN VNPT','WAN',true,0),
    ('${PORT.lan}','${ORG}','${BUILDING}','${ROUTER.a}','ether2','LAN tầng 1','LAN',false,1);
  INSERT INTO public.network_interface_current(interface_id,organization_id,building_id,device_id,observed_at,link_state,rx_bps,tx_bps,utilization_pct,error_count)
    VALUES('${PORT.wan}','${ORG}','${BUILDING}','${ROUTER.a}',${ts(1)},'UP',1000000,250000,8.5,0);
  INSERT INTO public.network_incidents(id,organization_id,building_id,device_id,fingerprint,incident_type,severity,status,title,summary,opened_at,last_observed_at)
    VALUES('${INCIDENT}','${ORG}','${BUILDING}','${ROUTER.a}','fp-incident-1','LINK_DOWN','WARNING','OPEN','Mất link LAN tầng 1','Cổng ether2 down',${ts(30)},${ts(1)});
  INSERT INTO public.network_config_snapshots(id,organization_id,building_id,device_id,source,schema_version,normalized_content,redacted_lines,content_hash,
      worker_id,created_at) VALUES
    ('${SNAPSHOT.old}','${ORG}','${BUILDING}','${ROUTER.a}','SCHEDULED',1,'{}','["/ip address","add address=10.0.0.1/24","/system identity"]',repeat('1',64),
      'worker-a',${ts(60)}),
    ('${SNAPSHOT.new}','${ORG}','${BUILDING}','${ROUTER.a}','SCHEDULED',1,'{}','["/ip address","add address=10.0.0.2/24","/system identity"]',repeat('2',64),
      'worker-a',${ts(10)});
  INSERT INTO public.network_site_settings(organization_id,building_id,rollout_state,changes_paused) VALUES('${ORG}','${BUILDING}','READ_ONLY',false);
  INSERT INTO public.network_client_current(id,organization_id,building_id,device_id,session_key,client_fingerprint,observed_mac,observed_ip,hostname,
      connection_type,room_hint,session_type,rx_bps,tx_bps,first_seen_at,last_seen_at,observed_at,expires_at) VALUES
    ('${CLIENT.linked}','${ORG}','${BUILDING}','${ROUTER.a}','session-01','fp-client-01','aa:bb:cc:00:00:01','10.0.0.101','iphone-an','WIFI','P101','HOTSPOT',1000,200,
      ${ts(60)},${ts(1)},${ts(1)},'2999-01-01T00:00:00Z'),
    ('${CLIENT.hidden}','${ORG}','${BUILDING}','${ROUTER.a}','session-02','fp-client-02','aa:bb:cc:00:00:02','10.0.0.102','laptop-x','WIFI',null,'HOTSPOT',10,20,
      ${ts(60)},${ts(2)},${ts(2)},'2999-01-01T00:00:00Z'),
    ('${CLIENT.loose}','${ORG}','${BUILDING}','${ROUTER.a}','session-03','fp-client-03','aa:bb:cc:00:00:03','10.0.0.103',null,'ETHERNET',null,'DHCP',0,0,
      ${ts(60)},${ts(3)},${ts(3)},'2999-01-01T00:00:00Z');
  INSERT INTO public.network_client_links(organization_id,building_id,client_fingerprint,room_id,contract_id,customer_id,source,confidence,valid_from) VALUES
    ('${ORG}','${BUILDING}','fp-client-01','${ROOM}','${CONTRACT_A}','${CUSTOMER_A}','MANUAL',1,${ts(1000)}),
    ('${ORG}','${BUILDING}','fp-client-02','${ROOM}',null,'${HIDDEN_CUSTOMER}','MANUAL',1,${ts(1000)});
  INSERT INTO public.network_device_current(device_id,organization_id,building_id,observed_at,last_seen_at,reachable,health_status)
    VALUES('${ARUBA}','${ORG}','${BUILDING}',${ts(1)},${ts(1)},true,'HEALTHY');
  INSERT INTO app_private.network_h196a_profiles(device_id,organization_id,building_id,gateway_device_id,stable_key,mac_address,observed_ip,observed_health,
      observed_health_reason,first_seen_at,last_seen_at) VALUES('${H196A}','${ORG}','${BUILDING}','${ROUTER.a}','mac:a0:11:22:33:44:55','a0:11:22:33:44:55',
      '10.0.0.30','ONLINE','bridge',${ts(100)},${ts(1)});
  INSERT INTO public.network_commands(id,organization_id,building_id,device_id,action_type,reason,sanitized_parameters,target_display,requested_by,request_hash,
      idempotency_key,status,attempt_count,result,semantic_fingerprint,managed_target,intent_type,expected_postcondition,observation_deadline,created_at,
      started_at,finished_at)
    VALUES('${COMMAND}','${ORG}','${BUILDING}','${ROUTER.a}','FLUSH_DNS_CACHE','Khách báo lỗi DNS','{}','{"label":"Router A"}','${USER}',repeat('b',64),
      'idem-command-1','SUCCEEDED',1,'{"secret":"không trả"}',repeat('a',64),'{}','FLUSH_DNS_CACHE','{}',${ts(0)},${ts(20)},${ts(20)},${ts(19)});
  INSERT INTO public.network_audit_events(id,organization_id,building_id,actor_type,actor_id,action,target_type,target_display,reason,outcome,occurred_at)
    VALUES('${AUDIT}','${ORG}','${BUILDING}','USER','${OUTSIDER}','settings.update','site','{}','Đổi chu kỳ poll','SUCCEEDED',${ts(15)});`;

// Mặc định gói C + dải Z (review PR #215 P3-1): test gói kiểm định nghĩa CUỐI sẽ phát hành, không phải bản gói đã bị Z thay.
export async function sharedW2c(options = {}) {
  return sharedW2({ packages: ['c', 'z'], before, seed: db => db.exec(SEED), ...options });
}
