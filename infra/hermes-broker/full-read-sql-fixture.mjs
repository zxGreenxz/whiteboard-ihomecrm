import { readFileSync } from 'node:fs';
import { setup as setupFinance, BUILDING, OTHER_BUILDING, ROOM, OTHER_ROOM, SCOPE, UNSELECTED_ORG_SCOPE, binding, token, USER, ORG, FOREIGN, SESSION, CONNECTION }
  from './finance-fixture.mjs';
export { BUILDING, OTHER_BUILDING, ROOM, OTHER_ROOM, SCOPE, UNSELECTED_ORG_SCOPE, binding, token, USER, ORG, FOREIGN, SESSION, CONNECTION };

// Đọc đầy đủ (20261016162104 → 20261016172206 → 20261017021554) trên fixture tài chính:
// nền Hermes thật (binding, phiên, chính sách, overlay), v1/v2 thật; các RPC web THẬT
// (định nghĩa cuối trong baseline/migration): occupancy_snapshot_v2,
// occupancy_upcoming_vacancy_v2, fa_monthly_pnl, fa_monthly_pnl_accrual, fa_accrual_allocations,
// zalo_authorized_org_ids. Cổng tổng hợp cùng chữ ký: quyền CRM (context, authorized_scope_v3,
// can_access_building, my_org_ids, current_visible_owner_ids), list_my_pending_approvals_v1,
// org_today_v1 và get_invoice_statistics_v2 (giữ cổng staff_assignments như bản thật). Không
// có hàm copilot_* nào: cổng Hermes còn gọi copilot là test đỏ. Không chứng minh RLS, JWT thật
// hay PostgREST. Dữ liệu tổng hợp.
export const FULL_READ_PATH = 'supabase/migrations/20261016162104_hermes_full_read_v1.sql';
// Sửa sau review 9aef3a21 (P1/P2/P3): thay thân v2/v3/báo cáo; định nghĩa SỐNG ở file này.
export const FULL_READ_FIX_PATH = 'supabase/migrations/20261016172206_hermes_full_read_review_fixes_v1.sql';
export const fullReadSql = () => readFileSync(process.env.HERMES_FULL_READ_SQL ?? FULL_READ_PATH, 'utf8');
export const fullReadFixSql = () => readFileSync(process.env.HERMES_FULL_READ_FIX_SQL ?? FULL_READ_FIX_PATH, 'utf8');
// Khớp màn web, không còn copilot_* (đợt 1b): định nghĩa SỐNG của v3/báo cáo ở file này.
export const FULL_READ_PARITY_PATH = 'supabase/migrations/20261017021554_hermes_full_read_web_parity_v1.sql';
export const fullReadParitySql = () => readFileSync(process.env.HERMES_FULL_READ_PARITY_SQL ?? FULL_READ_PARITY_PATH, 'utf8');
const baseline = readFileSync('supabase/baseline/schema.sql', 'utf8');
const migrationSql = name => readFileSync(`supabase/migrations/${name}.sql`, 'utf8');
const definition = (src, name) => {
  // pg_dump quotes some bodies as $_$ (fa_accrual_allocations).
  const match = src.match(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION ${name.replaceAll('.', '\\.')}\\([\\s\\S]*?\\$(?:fn|function|_)?\\$;`, 'i'));
  if (!match) throw new Error(`missing definition ${name}`);
  return match[0];
};
const u = n => `0e0e0e0e-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const CUSTOMER_A = u(1), CUSTOMER_B = u(2), CUSTOMER_C = u(3), CUSTOMER_F = u(4), CONTRACT_A = u(5), CONTRACT_B = u(6), CONTRACT_F = u(7);
export const SERVICE = u(8), ORG_SCOPE = UNSELECTED_ORG_SCOPE, FOREIGN_ROOM = u(9), CO_TENANT = u(10), OLD_CONTRACT = u(11);
export const PHONE_A = '0901234567', CCCD_A = '079123456789', BANK_A = '999888777666', SECRET_IMAGE = 'customers/secret-cccd-front.jpg';
export const INVOICE_A = u(13), INVOICE_B = u(14), PENDING = u(15), VOUCHER = u(16), CONVERSATION = u(17), ZALO_PHONE = '0987654321';
export const INVOICE_CANCELLED = u(18), INVOICE_PARTIAL = u(19), FOREIGN_PENDING = u(20);
export const FULL_READ_KEYS = ['customers.view', 'contracts.view'];
export const REPORT_KEYS = ['reports_real_estate.occupancy', 'invoices.view', 'reports_finance.analysis', 'income_expenses.view', 'chat_zalo.view', 'contracts.view'];

export async function setupFullRead(t, { sql = fullReadSql(), fix = fullReadFixSql(), parity = fullReadParitySql(), reads = [...FULL_READ_KEYS], before = null } = {}) {
  const env = await setupFinance(t), { db } = env;
  await db.exec(`ALTER TABLE public.buildings ADD COLUMN street_address text,ADD COLUMN ward text,ADD COLUMN district text,ADD COLUMN province text;
    ALTER TABLE public.contracts ADD COLUMN contract_number text,ADD COLUMN signed_date date,ADD COLUMN start_date date,ADD COLUMN end_date date,
      ADD COLUMN actual_end_date date,ADD COLUMN expected_move_out_date date,ADD COLUMN start_billing_date date,ADD COLUMN end_billing_date date,
      ADD COLUMN rent_price numeric(15,2),ADD COLUMN payment_cycle text,ADD COLUMN deposit_debt_reason text,ADD COLUMN deposit_topup_due_date date,
      ADD COLUMN initial_electricity_reading numeric(10,2),ADD COLUMN initial_water_reading numeric(10,2),ADD COLUMN notes text,
      ADD COLUMN parent_contract_id uuid,ADD COLUMN public_code text,ADD COLUMN contract_file_url text;
    CREATE TABLE public.customers(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,full_name text NOT NULL,phone text NOT NULL,email text,customer_type text,
      status text,status_v2 text,id_type text,id_number text,id_issue_date date,id_issue_place text,date_of_birth date,gender text,is_foreign boolean,
      occupation text,workplace text,detailed_address text,ward text,district text,province text,current_residence text,permanent_address text,
      company_name text,contact_person text,contact_person_phone text,emergency_contact_name text,emergency_contact_phone text,
      emergency_contact_relationship text,notes text,id_images jsonb,bank_account_number text,bank_name text,fingerprint_code text,deleted_at timestamptz);
    CREATE TABLE public.contract_customers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,contract_id uuid,customer_id uuid,
      is_representative boolean NOT NULL DEFAULT false,notes text);
    CREATE TABLE public.services(id uuid PRIMARY KEY,organization_id uuid,name text,unit text,type text,pricing_type text,unit_price numeric,user_id uuid,deleted_at timestamptz);
    CREATE TABLE public.contract_services(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,contract_id uuid,service_id uuid,
      unit_price numeric NOT NULL,initial_reading numeric);
    CREATE TABLE public.fixture_visible_owners(user_id uuid PRIMARY KEY);
    CREATE FUNCTION public.current_visible_owner_ids() RETURNS uuid[] LANGUAGE sql AS $$SELECT COALESCE(array_agg(user_id),'{}'::uuid[]) FROM public.fixture_visible_owners$$;
    INSERT INTO public.fixture_visible_owners VALUES('${USER}');
    INSERT INTO public.buildings(id,organization_id,name,street_address,ward,district,province) VALUES('${u(12)}','${FOREIGN}','Toà ngoài','1 Ngoài',null,null,null);
    UPDATE public.buildings SET street_address='12 Lê Lợi',ward='Phường 1',district='Quận 3',province='TP HCM' WHERE id='${BUILDING}';
    INSERT INTO public.rooms VALUES('${FOREIGN_ROOM}','${FOREIGN}','${u(12)}','F1','OCCUPIED',null);
    INSERT INTO public.customers(id,organization_id,user_id,full_name,phone,email,customer_type,status_v2,id_type,id_number,id_issue_date,id_issue_place,
      date_of_birth,gender,is_foreign,occupation,workplace,detailed_address,ward,district,province,current_residence,permanent_address,
      emergency_contact_name,emergency_contact_phone,emergency_contact_relationship,notes,id_images,bank_account_number,bank_name,fingerprint_code) VALUES
      ('${CUSTOMER_A}','${ORG}','${USER}','Nguyễn Văn An','${PHONE_A}','an@example.invalid','INDIVIDUAL','RENTING','CCCD','${CCCD_A}','2021-04-10','Cục CS QLHC',
        '1990-05-01','Nam',false,'Kỹ sư','Công ty X','Số 1 ngõ 2','Phường 4','Quận 5','Hà Nội','Phòng P101','Thôn Đông'||chr(10)||'Xã Tây, Tỉnh Nam',
        'Trần Thị Bình','0912345678','Mẹ','khách quen'||chr(7)||' ghi chú',jsonb_build_object('front','${SECRET_IMAGE}'),'${BANK_A}','VCB','FP-1'),
      ('${CO_TENANT}','${ORG}','${USER}','Lê Ở Ghép','0933333333',null,'INDIVIDUAL','RENTING','CCCD','001200000001',null,null,null,'Nữ',false,null,null,
        null,null,null,null,null,'Quê B',null,null,null,null,null,null,null,null),
      ('${CUSTOMER_B}','${ORG}','${USER}','Phạm Toà Khác','0944444444',null,null,null,null,'002200000002',null,null,null,null,null,null,null,null,null,null,null,null,
        null,null,null,null,null,null,null,null,null),
      ('${CUSTOMER_C}','${ORG}','${USER}','Khách Chưa Hợp Đồng','0955555555',null,null,null,null,'003200000003',null,null,null,null,null,null,null,null,null,null,null,
        null,null,null,null,null,null,null,null,null,null),
      ('${CUSTOMER_F}','${FOREIGN}','${USER}','Khách Công Ty Khác','0966666666',null,null,null,null,'004200000004',null,null,null,null,null,null,null,null,null,null,
        null,null,null,null,null,null,null,null,null,null,null);
    INSERT INTO public.contracts(id,organization_id,room_id,status,total_deposit,deposit_paid,deposit_remaining,deposit_debt_mode,deleted_at,contract_number,
      signed_date,start_date,end_date,rent_price,payment_cycle,initial_electricity_reading,initial_water_reading,notes,public_code,contract_file_url,deposit_debt_reason) VALUES
      ('${CONTRACT_A}','${ORG}','${ROOM}','ACTIVE',6000000,4000000,2000000,'DEBT',null,'HD-A','2026-01-01','2026-01-02','2027-01-01',3500000,'MONTHLY',120.5,10,
        'Hợp đồng A'||chr(10)||'dòng 2','PUBLIC-CODE-A','contracts/secret-file.pdf','Khách xin nợ'),
      ('${CONTRACT_B}','${ORG}','${OTHER_ROOM}','ACTIVE',1,1,0,null,null,'HD-B','2026-01-01','2026-01-01','2027-01-01',1,'MONTHLY',null,null,null,'PUBLIC-CODE-B',null,null),
      ('${CONTRACT_F}','${FOREIGN}','${FOREIGN_ROOM}','ACTIVE',1,1,0,null,null,'HD-F','2026-01-01','2026-01-01','2027-01-01',1,'MONTHLY',null,null,null,'PUBLIC-CODE-F',null,null);
    INSERT INTO public.contract_customers(organization_id,contract_id,customer_id,is_representative,notes) VALUES
      ('${ORG}','${CONTRACT_A}','${CUSTOMER_A}',true,'Đại diện'),('${ORG}','${CONTRACT_A}','${CO_TENANT}',false,null),
      ('${ORG}','${CONTRACT_B}','${CUSTOMER_B}',true,null),('${FOREIGN}','${CONTRACT_F}','${CUSTOMER_F}',true,null);
    INSERT INTO public.services VALUES('${SERVICE}','${ORG}','Điện','kWh','ELECTRICITY','PER_UNIT',3500,'${USER}',null);
    INSERT INTO public.contract_services(organization_id,contract_id,service_id,unit_price,initial_reading) VALUES('${ORG}','${CONTRACT_A}','${SERVICE}',3800,120.5);`);
  // Bảng/cột mà các RPC web thật cần; cổng tổng hợp cùng chữ ký; dữ liệu hoá đơn/hội thoại.
  await db.exec(`ALTER TABLE public.rooms ADD COLUMN rent_price numeric;
    ALTER TABLE public.contracts ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
    ALTER TABLE public.invoices ADD COLUMN contract_id uuid,ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
    ALTER TABLE public.income_expenses ADD COLUMN business_result_accounting boolean,ADD COLUMN invoice_id uuid;
    ALTER TABLE public.income_expense_types ADD COLUMN category text;
    CREATE TABLE public.income_expense_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),income_expense_id uuid,income_expense_type_id uuid,
      amount numeric,unit_price numeric,quantity numeric,accounting_class text,start_date date,end_date date);
    CREATE TABLE public.contract_extensions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),contract_id uuid,status text,new_end_date date);
    ALTER TABLE public.zalo_conversations ADD COLUMN peer_name text,ADD COLUMN peer_phone text,ADD COLUMN kind text,ADD COLUMN marked_unread boolean,
      ADD COLUMN is_pinned boolean,ADD COLUMN last_message_at timestamptz,ADD COLUMN last_message_dir text,ADD COLUMN sub_label text,ADD COLUMN room_id uuid;
    CREATE TABLE public.staff_assignments(staff_id uuid,building_id uuid,area_id uuid);
    CREATE TABLE public.invoice_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),invoice_id uuid,type text,description text,amount numeric);
    INSERT INTO public.invoice_items(invoice_id,type,description,amount) VALUES('${INVOICE_A}','RENT','Tiền phòng',3000000),
      ('${INVOICE_A}','SERVICE','Tiền điện T10',350000),('${INVOICE_A}','SERVICE','Tiền nước T10',100000),('${INVOICE_A}','SERVICE','Phí dịch vụ',50000),
      ('${INVOICE_B}','RENT','Tiền phòng',9100000);
    INSERT INTO app_private.hermes_capabilities(capability,mode,enabled) VALUES('chat_zalo.view','read',false) ON CONFLICT(capability) DO NOTHING;
    -- Chat Zalo của web cần chat_zalo.view phạm vi toàn công ty (zalo_authorized_org_ids).
    INSERT INTO public.fixture_acl(permission,org_wide,building_ids) VALUES('chat_zalo.view',true,ARRAY['${BUILDING}'::uuid,'${OTHER_BUILDING}'::uuid]) ON CONFLICT DO NOTHING;
    INSERT INTO public.invoices(id,organization_id,invoice_number,status,building_id,room_id,billing_month,due_date,total_amount,paid_amount,notes,contract_id) VALUES
      ('${INVOICE_A}','${ORG}','INV-A','APPROVED','${BUILDING}','${ROOM}','2026-10','2026-10-10',3500000,1000000,null,'${CONTRACT_A}'),
      ('${INVOICE_B}','${ORG}','INV-B','APPROVED','${OTHER_BUILDING}','${OTHER_ROOM}','2026-10','2026-10-10',9100000,0,null,'${CONTRACT_B}');
    INSERT INTO public.zalo_conversations(id,account_id,organization_id,thread_type,thread_id,peer_zalo_uid,last_message_text,unread_count,
        peer_name,peer_phone,kind,marked_unread,is_pinned,last_message_at,last_message_dir,sub_label,room_id) VALUES
      ('${CONVERSATION}',null,'${ORG}','user','999','999','Anh ơi'||chr(10)||'phòng còn không?',4,'Khách Zalo','${ZALO_PHONE}','customer',false,false,
        '2026-10-16T01:02:03+00:00','in',null,'${ROOM}'),
      ('${u(21)}',null,'${FOREIGN}','user','998','998','công ty khác',1,'Khách lạ','0911000111','customer',false,true,'2026-10-16T05:00:00+00:00','in',null,null);
    CREATE FUNCTION public.org_today_v1(p_organization_id uuid DEFAULT NULL) RETURNS date LANGUAGE sql AS $$SELECT DATE '2026-10-16'$$;
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql AS $$
      SELECT CASE WHEN auth.uid()='${USER}'::uuid THEN ARRAY['${ORG}'::uuid] ELSE '{}'::uuid[] END$$;
    CREATE FUNCTION public.get_invoice_statistics_v2(p_building_id uuid,p_room_id uuid,p_status text,p_start_date date,p_end_date date,p_billing_month text,
      p_payment_status text,p_building_ids uuid[]) RETURNS json LANGUAGE sql AS $$
      SELECT json_build_object('total_amount',COALESCE(sum(total_amount),0),'total_paid',COALESCE(sum(paid_amount),0),'total_remaining',COALESCE(sum(remaining_amount),0),
        'total_refunded',0,'total_count',count(*),'rent_amount',0,'electric_amount',0,'water_amount',0,'pdv_amount',0)
      FROM public.invoices WHERE deleted_at IS NULL AND (p_building_ids IS NULL OR building_id=ANY(p_building_ids))
        AND (p_billing_month IS NULL OR billing_month=p_billing_month)
        AND building_id IN (SELECT building_id FROM public.staff_assignments WHERE staff_id=auth.uid())$$;
    -- Hộp chờ duyệt của người gọi trên MỌI công ty của họ (như bản thật): Hermes phải lọc công ty.
    CREATE FUNCTION public.list_my_pending_approvals_v1() RETURNS TABLE(request_id uuid,submission_no bigint,submitted_at timestamptz,amount numeric,
      voucher_id uuid,voucher_code text,voucher_name text,voucher_type text,maker_name text,step_no integer,request_version bigint,organization_id uuid,
      approval_version bigint,posting_version bigint) LANGUAGE sql AS $$
      SELECT '${PENDING}'::uuid,1::bigint,'2026-10-15T03:04:05.678Z'::timestamptz,2500000::numeric,'${VOUCHER}'::uuid,'PC-9','Sửa máy bơm','EXPENSE',
        'Kế toán A',1,1::bigint,'${ORG}'::uuid,1::bigint,1::bigint WHERE auth.uid()='${USER}'::uuid
      UNION ALL SELECT '${FOREIGN_PENDING}'::uuid,1::bigint,'2026-10-15T04:00:00Z'::timestamptz,1::numeric,null,'PC-X','Công ty khác','EXPENSE','X',1,1::bigint,
        '${FOREIGN}'::uuid,1::bigint,1::bigint WHERE auth.uid()='${USER}'::uuid$$;`);
  for (const name of ['public.occupancy_snapshot_v2', 'public.occupancy_upcoming_vacancy_v2', 'public.fa_accrual_allocations', 'public.fa_monthly_pnl_accrual'])
    await db.exec(definition(baseline, name));
  await db.exec(definition(migrationSql('20260813100000_zalo_khu_rieng_theo_cong_ty'), 'public.zalo_authorized_org_ids'));
  await db.exec(definition(migrationSql('20261016111855_hermes_zalo_broadcast_v1'), 'app_private.hermes_zalo_fold_v1'));
  if (before) await before(db);
  await db.exec(sql); await db.exec(sql);
  if (fix !== null) { await db.exec(fix); await db.exec(fix); }
  if (parity !== null) { await db.exec(parity); await db.exec(parity); }
  await db.query('UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability=ANY($1)', [reads]);
  await db.query('UPDATE app_private.hermes_org_policies SET read_capabilities=read_capabilities||$1::text[]', [reads]);
  await db.query('UPDATE app_private.hermes_connections SET read_capabilities=read_capabilities||$1::text[]', [reads]);
  const read3 = (domain, input, b = binding, options) => env.call('SELECT public.hermes_domain_read_v3($1::jsonb,$2::text,$3::jsonb) result',
    [JSON.stringify(b), domain, JSON.stringify(input)], options);
  // Toàn tổ chức: CRM org_wide cho khoá + kết nối và chính sách chọn scope ORGANIZATION.
  async function orgWide(permission, on = true) {
    await db.query('UPDATE public.fixture_acl SET org_wide=$2 WHERE permission=$1', [permission, on]);
    await db.query(on ? 'UPDATE app_private.hermes_connections SET scope_ids=array_append(scope_ids,$1::uuid)'
      : 'UPDATE app_private.hermes_connections SET scope_ids=array_remove(scope_ids,$1::uuid)', [ORG_SCOPE]);
    await db.query(on ? 'UPDATE app_private.hermes_org_policies SET scope_ids=array_append(scope_ids,$1::uuid)'
      : 'UPDATE app_private.hermes_org_policies SET scope_ids=array_remove(scope_ids,$1::uuid)', [ORG_SCOPE]);
  }
  return { ...env, read3, orgWide };
}
