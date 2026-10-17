import { readFileSync } from 'node:fs';
import { setup as setupFinance, BUILDING, OTHER_BUILDING, ROOM, OTHER_ROOM, SCOPE, UNSELECTED_ORG_SCOPE, binding, token, USER, ORG, FOREIGN, SESSION, CONNECTION }
  from './finance-fixture.mjs';
export { BUILDING, OTHER_BUILDING, ROOM, OTHER_ROOM, SCOPE, UNSELECTED_ORG_SCOPE, binding, token, USER, ORG, FOREIGN, SESSION, CONNECTION };

// Đọc đầy đủ (20261016162104) trên fixture tài chính: nền Hermes thật (binding,
// phiên, chính sách, overlay), v1/v2 thật; cổng quyền CRM (context,
// authorized_scope_v3, current_visible_owner_ids) và các hàm copilot_* là cổng
// tổng hợp cùng chữ ký. Chứng minh phép giao quyền của Hermes, không chứng minh
// RLS, JWT thật hay thân hàm copilot_* trên production. Dữ liệu tổng hợp.
export const FULL_READ_PATH = 'supabase/migrations/20261016162104_hermes_full_read_v1.sql';
// Sửa sau review 9aef3a21 (P1/P2/P3): thay thân v2/v3/báo cáo; định nghĩa SỐNG ở file này.
export const FULL_READ_FIX_PATH = 'supabase/migrations/20261016172206_hermes_full_read_review_fixes_v1.sql';
export const fullReadSql = () => readFileSync(process.env.HERMES_FULL_READ_SQL ?? FULL_READ_PATH, 'utf8');
export const fullReadFixSql = () => readFileSync(process.env.HERMES_FULL_READ_FIX_SQL ?? FULL_READ_FIX_PATH, 'utf8');
const u = n => `0e0e0e0e-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const CUSTOMER_A = u(1), CUSTOMER_B = u(2), CUSTOMER_C = u(3), CUSTOMER_F = u(4), CONTRACT_A = u(5), CONTRACT_B = u(6), CONTRACT_F = u(7);
export const SERVICE = u(8), ORG_SCOPE = UNSELECTED_ORG_SCOPE, FOREIGN_ROOM = u(9), CO_TENANT = u(10), OLD_CONTRACT = u(11);
export const PHONE_A = '0901234567', CCCD_A = '079123456789', BANK_A = '999888777666', SECRET_IMAGE = 'customers/secret-cccd-front.jpg';
export const INVOICE_A = u(13), INVOICE_B = u(14), PENDING = u(15), VOUCHER = u(16), CONVERSATION = u(17), ZALO_PHONE = '0987654321';
export const FULL_READ_KEYS = ['customers.view', 'contracts.view'];
export const REPORT_KEYS = ['reports_real_estate.occupancy', 'invoices.view', 'reports_finance.analysis', 'income_expenses.view', 'chat_zalo.view', 'contracts.view'];

export async function setupFullRead(t, { sql = fullReadSql(), fix = fullReadFixSql(), reads = [...FULL_READ_KEYS], before = null } = {}) {
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
  // Cổng copilot_* tổng hợp: cùng chữ ký/kiểu trả về với bản production (pg_proc
  // 16/10), tự kiểm khoá CRM qua copilot_org_scope_buildings_v1 như bản thật. Sáu hàm
  // được bọc không kiểm cờ trang copilot_feature_flags (như production).
  // get_invoice_statistics_v2 giữ đúng cách lấy phạm vi của bản thật: staff_assignments
  // (chủ công ty không có phân công ⇒ 0) — bản sửa không được gọi nó nữa.
  await db.exec(`CREATE TABLE public.staff_assignments(staff_id uuid,building_id uuid,area_id uuid);
    CREATE TABLE public.invoice_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),invoice_id uuid,type text,description text,amount numeric);
    INSERT INTO public.invoice_items(invoice_id,type,description,amount) VALUES('${INVOICE_A}','RENT','Tiền phòng',3000000),
      ('${INVOICE_A}','SERVICE','Tiền điện T10',350000),('${INVOICE_A}','SERVICE','Tiền nước T10',100000),('${INVOICE_A}','SERVICE','Phí dịch vụ',50000),
      ('${INVOICE_B}','RENT','Tiền phòng',9100000);
    CREATE FUNCTION app_private.copilot_fold_text_v1(p_text text) RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT lower(COALESCE(p_text,''))$$;
    INSERT INTO app_private.hermes_capabilities(capability,mode,enabled) VALUES('chat_zalo.view','read',false) ON CONFLICT(capability) DO NOTHING;
    INSERT INTO public.fixture_acl(permission,building_ids) VALUES('chat_zalo.view',ARRAY['${BUILDING}'::uuid,'${OTHER_BUILDING}'::uuid]) ON CONFLICT DO NOTHING;
    INSERT INTO public.invoices(id,organization_id,invoice_number,status,building_id,room_id,billing_month,due_date,total_amount,paid_amount,notes) VALUES
      ('${INVOICE_A}','${ORG}','INV-A','APPROVED','${BUILDING}','${ROOM}','2026-10','2026-10-10',3500000,1000000,null),
      ('${INVOICE_B}','${ORG}','INV-B','APPROVED','${OTHER_BUILDING}','${OTHER_ROOM}','2026-10','2026-10-10',9100000,0,null);
    CREATE FUNCTION public.org_today_v1(p_organization_id uuid DEFAULT NULL) RETURNS date LANGUAGE sql AS $$SELECT DATE '2026-10-16'$$;
    CREATE FUNCTION public.copilot_org_scope_buildings_v1(p_permission_key text,p_organization_id uuid) RETURNS uuid[] LANGUAGE sql AS $$
      SELECT COALESCE((SELECT building_ids FROM public.fixture_acl WHERE permission=p_permission_key AND allowed AND p_organization_id='${ORG}'::uuid),'{}'::uuid[])$$;
    CREATE FUNCTION public.copilot_occupancy_v1(p_organization_id uuid,p_as_of_date date,p_window_days integer DEFAULT 30)
      RETURNS TABLE(building_id uuid,building_name text,total integer,occupied integer,reserved integer,maintenance integer,unavailable integer,available integer,
        occupancy_pct numeric,committed_pct numeric,missed_revenue numeric,generated_at timestamptz) LANGUAGE sql AS $$
      SELECT b.id,b.name,2,1,0,0,0,1,50.0,50.0,1500000,now() FROM public.buildings b WHERE b.organization_id=p_organization_id AND b.deleted_at IS NULL
        AND b.id=ANY(public.copilot_org_scope_buildings_v1('reports_real_estate.occupancy',p_organization_id)) ORDER BY b.name$$;
    CREATE FUNCTION public.copilot_occupancy_upcoming_v1(p_organization_id uuid,p_as_of_date date,p_window_days integer DEFAULT 30)
      RETURNS TABLE(contract_id uuid,contract_number text,building_id uuid,building_name text,room_id uuid,room_name text,effective_end_date date,
        days_remaining integer,rent_price numeric,extension_applied boolean) LANGUAGE sql AS $$
      SELECT ct.id,ct.contract_number,r.building_id,b.name,r.id,r.name,ct.end_date,(ct.end_date-p_as_of_date)::integer,ct.rent_price,false
        FROM public.contracts ct JOIN public.rooms r ON r.id=ct.room_id JOIN public.buildings b ON b.id=r.building_id
        WHERE ct.organization_id=p_organization_id AND ct.deleted_at IS NULL AND ct.end_date BETWEEN p_as_of_date AND p_as_of_date+p_window_days
          AND r.building_id=ANY(public.copilot_org_scope_buildings_v1('reports_real_estate.occupancy',p_organization_id))$$;
    CREATE FUNCTION public.copilot_invoice_search_v1(p_organization_id uuid,p_billing_month text DEFAULT NULL,p_payment_status text DEFAULT NULL,p_search text DEFAULT NULL)
      RETURNS jsonb LANGUAGE sql AS $$
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id',i.id,'invoice_number',i.invoice_number,'billing_month',i.billing_month,'total_amount',i.total_amount,
        'status',i.status,'building_id',i.building_id,'building_name',b.name,'room_id',i.room_id,'room_name',r.name) ORDER BY i.billing_month DESC,i.id),'[]'::jsonb)
      FROM public.invoices i JOIN public.rooms r ON r.id=i.room_id JOIN public.buildings b ON b.id=r.building_id
      WHERE i.organization_id=p_organization_id AND i.deleted_at IS NULL
        AND r.building_id=ANY(public.copilot_org_scope_buildings_v1('invoices.view',p_organization_id))
        AND (p_billing_month IS NULL OR i.billing_month=p_billing_month)
        AND (p_payment_status IS NULL OR (p_payment_status='paid' AND i.status='PAID') OR (p_payment_status='unpaid' AND i.status NOT IN ('PAID','PARTIAL_PAID')))
        AND (p_search IS NULL OR i.invoice_number ILIKE '%'||p_search||'%')$$;
    CREATE FUNCTION public.get_invoice_statistics_v2(p_building_id uuid,p_room_id uuid,p_status text,p_start_date date,p_end_date date,p_billing_month text,
      p_payment_status text,p_building_ids uuid[]) RETURNS json LANGUAGE sql AS $$
      SELECT json_build_object('total_amount',COALESCE(sum(total_amount),0),'total_paid',COALESCE(sum(paid_amount),0),'total_remaining',COALESCE(sum(remaining_amount),0),
        'total_refunded',0,'total_count',count(*),'rent_amount',0,'electric_amount',0,'water_amount',0,'pdv_amount',0)
      FROM public.invoices WHERE deleted_at IS NULL AND (p_building_ids IS NULL OR building_id=ANY(p_building_ids))
        AND (p_billing_month IS NULL OR billing_month=p_billing_month)
        AND building_id IN (SELECT building_id FROM public.staff_assignments WHERE staff_id=auth.uid())$$;
    CREATE FUNCTION public.copilot_financial_pnl_v1(p_organization_id uuid,p_start_date date,p_end_date date,p_accrual boolean DEFAULT false)
      RETURNS TABLE(month date,building_id uuid,building_name text,is_virtual boolean,revenue numeric,expense numeric,net numeric) LANGUAGE sql AS $$
      SELECT m.month::date,b.id,b.name,false,1000000::numeric,400000::numeric,600000::numeric FROM public.buildings b
        CROSS JOIN generate_series(date_trunc('month',p_start_date),date_trunc('month',p_end_date),interval '1 month') m(month)
        WHERE b.organization_id=p_organization_id AND b.id=ANY(public.copilot_org_scope_buildings_v1('reports_finance.analysis',p_organization_id))$$;
    CREATE FUNCTION public.copilot_pending_requests_v1(p_organization_id uuid,p_limit integer DEFAULT 20) RETURNS jsonb LANGUAGE plpgsql AS $$
    BEGIN
      IF cardinality(public.copilot_org_scope_buildings_v1('income_expenses.view',p_organization_id))=0 THEN RAISE EXCEPTION 'not_permitted' USING ERRCODE='42501'; END IF;
      RETURN jsonb_build_object('gioi_han',p_limit,'so_luong',1,'hop_cho',jsonb_build_array(jsonb_build_object('yeu_cau_id','${PENDING}','lan_gui',1,
        'gui_luc','2026-10-15T03:04:05.678+00:00','so_tien',2500000,'phieu_id','${VOUCHER}','ma_phieu','PC-9','ten_phieu','Sửa máy bơm','loai','EXPENSE',
        'nguoi_lap','Kế toán A','buoc',1)));
    END $$;
    CREATE FUNCTION public.copilot_zalo_conversations_v1(p_organization_id uuid,p_query text DEFAULT NULL,p_limit integer DEFAULT 20) RETURNS jsonb LANGUAGE plpgsql AS $$
    BEGIN
      IF cardinality(public.copilot_org_scope_buildings_v1('chat_zalo.view',p_organization_id))=0 THEN RAISE EXCEPTION 'not_permitted' USING ERRCODE='42501'; END IF;
      RETURN jsonb_build_object('gioi_han',p_limit,'so_luong',1,'tong_hop',jsonb_build_object('so_hoi_thoai',3,'so_chua_doc',1,'tong_tin_chua_doc',4,'so_ghim',0),
        'hoi_thoai',jsonb_build_array(jsonb_build_object('hoi_thoai_id','${CONVERSATION}','nguoi_nhan','Khách Zalo','dien_thoai','${ZALO_PHONE}','loai','user',
          'nhom','customer','chua_doc',4,'danh_dau_chua_doc',false,'ghim',false,'phong','P101','toa_nha','Toà A','nhan',null,
          'tin_cuoi_luc','2026-10-16T01:02:03+00:00','tin_cuoi_chieu','in','tin_cuoi','Anh ơi'||chr(10)||'phòng còn không?')));
    END $$;
    CREATE FUNCTION public.copilot_contract_search_v1(p_organization_id uuid,p_query text DEFAULT NULL,p_status text DEFAULT NULL,p_limit integer DEFAULT 20)
      RETURNS jsonb LANGUAGE plpgsql AS $$
    BEGIN
      RETURN jsonb_build_object('gioi_han',p_limit,'so_luong',1,'hop_dong',(SELECT COALESCE(jsonb_agg(jsonb_build_object('hop_dong_id',ct.id,'so_hop_dong',ct.contract_number,
        'khach_hang','Nguyễn Văn An','phong',r.name,'toa_nha',b.name,'ngay_bat_dau',ct.start_date,'ngay_ket_thuc',ct.end_date,'trang_thai',ct.status,
        'tien_thue',ct.rent_price,'tien_coc',ct.total_deposit,'coc_da_thu',ct.deposit_paid) ORDER BY ct.id),'[]'::jsonb)
        FROM public.contracts ct JOIN public.rooms r ON r.id=ct.room_id JOIN public.buildings b ON b.id=r.building_id
        WHERE ct.organization_id=p_organization_id AND r.building_id=ANY(public.copilot_org_scope_buildings_v1('contracts.view',p_organization_id))
          AND (p_status IS NULL OR ct.status=p_status)
          AND (p_query IS NULL OR lower(concat_ws(' ',ct.contract_number,r.name,b.name,'Nguyễn Văn An')) LIKE '%'||lower(p_query)||'%')));
    END $$;`);
  if (before) await before(db);
  await db.exec(sql); await db.exec(sql);
  if (fix !== null) { await db.exec(fix); await db.exec(fix); }
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
