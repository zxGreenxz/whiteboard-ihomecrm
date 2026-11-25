import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Số tiền khách cũ hỗ trợ khách mới khi sang nhượng phòng (plan sang nhượng phòng, đợt 3): cặp phiếu chuyển cọc trên
// sổ nội bộ ghi lúc tạo hợp đồng khách nhận, hai trần, chặn huỷ/xoá, đảo có lý do. Thân create_contract_v2 và ba hàm
// được vá nạp đúng bản production 24/11/2026 (fixture), kiểm md5 trước vá, rồi chạy migration đợt 2 và đợt 3 (hai lượt).
const MIGRATION_D2 = 'supabase/migrations/20261124075933_tra_phong_truoc_han_ba_truong_hop.sql';
const MIGRATION = 'supabase/migrations/20261124154554_so_ho_tro_sang_nhuong_chuyen_coc.sql';
const BEFORE_FIXTURE = 'src/lib/__tests__/fixtures/exit-support-before.sql';
const migrationSql = readFileSync(MIGRATION, 'utf8');
const migrationCorpus = readdirSync('supabase/migrations').filter(file => file.endsWith('.sql')).sort().reverse()
  .map(file => ({ file, sql: readFileSync(join('supabase/migrations', file), 'utf8') }));
// Fixture dựng lại trạng thái NGAY TRƯỚC đợt 2 (20261124075933 vá thân đang chạy, không CREATE lại) rồi chạy đợt 2 và
// đợt 3, nên định nghĩa nền là bản cuối ở các file TRƯỚC đợt 2. Migration sau có thể thay hẳn hàm (đợt 2 Sale phòng
// 20261125034429 thay get_my_available_rooms() bằng bản (uuid); bản sống đo ở contractExitEarlyTermsMigration.test.ts).
const MIGRATION_D2_FILE = MIGRATION_D2.split('/').pop()!;
function liveDefinitionOf(qualified: string): string {
  const pattern = new RegExp('CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+' + qualified.replace(/\./g, '\\.')
    + '\\s*\\([\\s\\S]*?\\bAS\\s+(\\$[a-zA-Z_]*\\$)[\\s\\S]*?\\1\\s*;', 'i');
  for (const migration of migrationCorpus.filter(m => m.file < MIGRATION_D2_FILE)) {
    const match = migration.sql.match(pattern);
    if (match) return match[0].replace(/^CREATE FUNCTION/i, 'CREATE OR REPLACE FUNCTION');
  }
  throw new Error('Missing live function: ' + qualified);
}
function sliceStatement(file: string, start: string, end: string): string {
  const sql = readFileSync(join('supabase/migrations', file), 'utf8');
  const from = sql.indexOf(start);
  if (from < 0) throw new Error(`Missing ${start} in ${file}`);
  return sql.slice(from, sql.indexOf(end, from) + end.length);
}

// md5(pg_get_functiondef) production đọc lại ngày 24/11/2026 (npm run db:query, chỉ đọc).
const PROD_MD5: Record<string, string> = {
  'public.create_contract_v2(jsonb,text)': '1df4fcbebf3ff4fea861618612b48d4d',
  'public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[])': '048ce2e383f642b10e375166b6a3416e',
  'public.meter_capture_exit_v1(uuid,text,jsonb,jsonb)': '3de2baa15f7c204c6f1ac3da08c909a7',
  'app_private.meter_capture_invoke_writer_v1(text,jsonb)': 'f77b040aff83c5e1078f22ff9a9d1623',
  'app_private.contract_exit_early_terms_response_v1(uuid)': '9343fc2c9b81316cc545df5647209861',
};
// Sau migration (đo trên PGlite; đối chiếu lại trên TEST sau khi áp).
const AFTER_MD5: Record<string, string> = {
  'public.create_contract_v2(jsonb,text)': '1dc7d6e43d58f73ddd66b5f057a27087',
  'public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[])': 'ec6464d08b8d22552c4cd97d53fa1ac5',
  'public.meter_capture_exit_v1(uuid,text,jsonb,jsonb)': '0fbd9bd63df1c43f436ce546bd0e6854',
  'app_private.meter_capture_invoke_writer_v1(text,jsonb)': 'd586ed3134d585ec8ceb8eeb666e9588',
  'app_private.contract_exit_early_terms_response_v1(uuid)': '0011eaf47395dfa7fd44c480ed71107b',
};

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const org = id(1), actor = id(2), building = id(3), owner = id(5), internalAccount = id(6), cashAccount = id(7);
const rooms = [id(11), id(12), id(13), id(14)];
const olds = [id(21), id(22), id(23), id(24)];
const oldCustomers = [id(31), id(32), id(33), id(34)];
const newCustomers = [id(41), id(42), id(43), id(44)];
const MOVE_OUT = '2026-11-20';
const START = '2026-11-21';
const db = new PGlite();
type Row = Record<string, unknown>;

async function md5Of(signature: string): Promise<string> {
  return (await db.query<{ m: string }>('SELECT md5(pg_get_functiondef($1::regprocedure)) m', [signature])).rows[0].m;
}
const before: Record<string, string> = {};
const after: Record<string, string> = {};
const afterSecond: Record<string, string> = {};

beforeAll(async () => {
  await db.exec(`
    SET check_function_bodies = off;
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES('${actor}'),('${owner}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.actor',true),'')::uuid $$;
    CREATE TYPE public.payment_cycle AS ENUM('MONTHLY','QUARTERLY');
    CREATE TYPE public.room_status AS ENUM('AVAILABLE','RESERVED','OCCUPIED','MAINTENANCE');
    CREATE TYPE public.invoice_item_type AS ENUM('RENT','SERVICE','PENALTY','DISCOUNT','OTHER');
    CREATE TABLE public.organizations(id uuid PRIMARY KEY,status text DEFAULT 'ACTIVE');
    INSERT INTO public.organizations(id) VALUES('${org}');
    CREATE TABLE public.buildings(id uuid PRIMARY KEY,organization_id uuid,name text,code text,district text,ward text,street_address text,province text,
      total_floors int,images jsonb,public_contact_name text,public_contact_phone text,public_map_url text,public_lift_type text,floor_layouts jsonb,
      user_id uuid,is_virtual boolean DEFAULT false,deleted_at timestamptz,UNIQUE(organization_id,id));
    INSERT INTO public.buildings(id,organization_id,name,user_id) VALUES('${building}','${org}','Toà A','${owner}');
    CREATE TABLE public.rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,floor int DEFAULT 1,name text,code text,area numeric,rent_price numeric,
      deposit_amount numeric,max_occupants int,amenities jsonb,images jsonb,description text,sale_note text,sale_bonus_note text,room_type text,
      sale_status_note text,sale_status_note_key text,status text DEFAULT 'OCCUPIED',updated_at timestamptz DEFAULT now(),deleted_at timestamptz,UNIQUE(organization_id,id));
    CREATE SEQUENCE contract_numbers;
    CREATE TABLE public.contracts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,room_id uuid,contract_number text,status text DEFAULT 'ACTIVE',
      signed_date date,start_date date DEFAULT '2026-01-01',start_billing_date date,end_date date DEFAULT '2026-12-31',end_billing_date date,
      actual_end_date date,expected_move_out_date date,total_deposit numeric DEFAULT 4000000,deposit_paid numeric DEFAULT 4000000,
      rent_price numeric DEFAULT 3000000,payment_cycle public.payment_cycle DEFAULT 'MONTHLY',user_id uuid,tenant_id uuid,parent_contract_id uuid,notes text,
      contract_template_id uuid,invoice_template_id uuid,discounts jsonb DEFAULT '[]',deposit_debt_acknowledged boolean DEFAULT false,
      deposit_debt_mode text,deposit_debt_reason text,deposit_topup_due_date date,
      created_at timestamptz DEFAULT clock_timestamp(),updated_at timestamptz DEFAULT '2026-11-01',deleted_at timestamptz,UNIQUE(organization_id,id));
    CREATE FUNCTION public.test_contract_number() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.contract_number IS NULL THEN NEW.contract_number:='HD-MOI-'||nextval('contract_numbers'); END IF; RETURN NEW; END $$;
    CREATE TRIGGER trg_generate_contract_number BEFORE INSERT ON public.contracts FOR EACH ROW EXECUTE FUNCTION public.test_contract_number();
    CREATE TABLE public.customers(id uuid PRIMARY KEY,organization_id uuid,full_name text,deleted_at timestamptz);
    CREATE TABLE public.profiles(id uuid PRIMARY KEY,full_name text);
    INSERT INTO public.profiles VALUES('${actor}','Người ghi A'),('${owner}','Chủ C');
    CREATE TABLE public.contract_customers(id uuid DEFAULT gen_random_uuid(),organization_id uuid,contract_id uuid,customer_id uuid,is_representative boolean,
      notes text,created_at timestamptz DEFAULT now());
    CREATE TABLE public.contract_services(organization_id uuid,contract_id uuid,service_id uuid,unit_price numeric,initial_reading numeric);
    CREATE TABLE public.contract_tenants(contract_id uuid,tenant_id uuid);
    CREATE TABLE public.room_pass_listings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),room_id uuid,organization_id uuid,user_id uuid,active boolean,
      contact_manager boolean,contact_name text,contact_phone text,sale_policy text,pass_price numeric,avail_date date,updated_at timestamptz);
    CREATE TABLE public.contract_terminations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),contract_id uuid UNIQUE,actual_move_out_date date,status text);
    CREATE TABLE public.accounts(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,name text,is_virtual boolean DEFAULT false,is_default boolean DEFAULT false,
      deleted_at timestamptz,created_at timestamptz DEFAULT now());
    INSERT INTO public.accounts(id,organization_id,user_id,name,is_virtual) VALUES('${internalAccount}','${org}','${owner}','Cấn trừ thanh lý (nội bộ)',true),
      ('${cashAccount}','${org}','${owner}','Tiền mặt thu',false);
    CREATE TABLE public.income_expense_types(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,user_id uuid,type text,name text,description text,
      is_deposit boolean DEFAULT false,internal_transfer boolean DEFAULT false,force_approval boolean DEFAULT false,created_at timestamptz DEFAULT now());
    CREATE FUNCTION public.normalize_income_expense_type_name(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT lower(btrim($1)) $$;
    CREATE UNIQUE INDEX income_expense_types_org_side_normalized_name_uq ON public.income_expense_types(organization_id,lower(btrim(type)),public.normalize_income_expense_type_name(name));
    INSERT INTO public.income_expense_types(organization_id,user_id,type,name,is_deposit) VALUES('${org}','${owner}','income','Tiền cọc',true);
    CREATE TABLE public.income_expenses(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,organization_id uuid,contract_id uuid,room_id uuid,
      building_id uuid,account_id uuid,invoice_id uuid,type text,name text,commission_kind text,total_amount numeric,notes text,
      approval_status text DEFAULT 'APPROVED',approved_by uuid,approved_at timestamptz,voucher_date date,attachments jsonb DEFAULT '[]',
      business_result_accounting boolean,creator_name text,system_source text,idempotency_key text,posting_status text,review_state text,
      approval_version integer DEFAULT 0,deleted_at timestamptz,code text,created_at timestamptz DEFAULT clock_timestamp(),updated_at timestamptz DEFAULT now());
    CREATE TABLE public.income_expense_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),income_expense_id uuid REFERENCES public.income_expenses(id),
      organization_id uuid,income_expense_type_id uuid,description text,quantity numeric,unit_price numeric,amount numeric,start_date date,end_date date,
      accounting_class text);
    CREATE TABLE public.contract_deposit_links(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,contract_id uuid,income_expense_id uuid UNIQUE,
      link_source text,linked_by uuid);
    CREATE TABLE public.invoices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,organization_id uuid,contract_id uuid,building_id uuid,room_id uuid,
      invoice_number text,billing_month text,issue_date date,due_date date,status text,subtotal numeric,discount_amount numeric,discount_notes text,
      total_amount numeric,prepaid_amount numeric,paid_amount numeric,previous_debt numeric,notes text,template_id uuid,approved_at timestamptz,
      approved_by uuid,kind text,invoice_support_amount numeric,manual_discount_amount numeric,credit_discount_amount numeric,
      rent_support_plan_revision bigint,rent_support_request_id uuid);
    CREATE TABLE public.invoice_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,invoice_id uuid,service_id uuid,
      type public.invoice_item_type,description text,unit_price numeric,quantity numeric,coefficient numeric,amount numeric,previous_reading numeric,
      current_reading numeric,from_date date,to_date date,sort_order int,accounting_class text);
    CREATE TABLE public.room_reservation_holds(room_id uuid,status text,expires_at timestamptz,held_by uuid,contract_id uuid);
    CREATE TABLE app_private.canonical_write_operations(organization_id uuid,operation text,subject_scope text,actor_id uuid,idempotency_key text,
      payload_hash text,subject_id uuid,completed_at timestamptz,response_payload jsonb,
      UNIQUE(organization_id,operation,subject_scope,actor_id,idempotency_key));
    CREATE TABLE app_private.ie_transition_authorization(income_expense_id uuid,xid xid8,purpose text);
    CREATE TABLE app_private.sale_bonus_claims(organization_id uuid,deposit_voucher_id uuid,bonus_voucher_id uuid);
    CREATE TABLE public.notifications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES auth.users(id),organization_id uuid,
      type text,channel text,status text,subject text,content text NOT NULL,contract_id uuid,metadata jsonb DEFAULT '{}',created_at timestamptz DEFAULT now());
    CREATE TABLE public.room_next_claims(organization_id uuid,room_id uuid,status text);
    CREATE TABLE public.room_turnovers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),room_id uuid,organization_id uuid,status text,expected_ready_on date);
    CREATE TABLE public.room_sale_locks(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,room_id uuid,hours int,note text,
      locked_at timestamptz,expires_at timestamptz,released_at timestamptz,locked_by uuid);
    CREATE TABLE app_private.contract_rent_support_plans(organization_id uuid,contract_id uuid);
    CREATE TABLE app_private.rent_support_payout_authorizations(organization_id uuid,contract_id uuid,kind text,net numeric,xid xid8,backend_pid int);
    CREATE TABLE app_private.contract_exit_kind_history(case_id uuid,before_kind text,after_kind text,reason text,version bigint,actor_id uuid,
      idempotency_key text,payload_hash text,changed_at timestamptz DEFAULT now());
    CREATE TABLE public.public_room_settings(owner_id uuid,soon_days int,hotline_id uuid,sale_policy text);
    CREATE TABLE public.staff_assignments(staff_id uuid,user_id uuid);
    CREATE TABLE public.area_buildings(area_id uuid,building_id uuid,organization_id uuid);
    CREATE TABLE public.areas(id uuid,organization_id uuid,user_id uuid,name text,deleted_at timestamptz);
    CREATE TABLE public.hotlines(id uuid,user_id uuid,name text,phone_number text,is_active boolean,created_at timestamptz);
    CREATE TABLE public.building_services(building_id uuid,service_id uuid,unit_price_override numeric,is_active boolean);
    CREATE TABLE public.services(id uuid,organization_id uuid,unit_price numeric,deleted_at timestamptz,unit text,type text);
    CREATE TABLE app_private.sale_room_change_receipts(room_id uuid,organization_id uuid,actor_id uuid,response jsonb,created_at timestamptz);
    CREATE TABLE app_private.room_sale_policies_v1(id uuid,organization_id uuid,room_id uuid,starts_at timestamptz,ends_at timestamptz,cancelled_at timestamptz);
    -- Kiểu %ROWTYPE của đường nháp và đường ảnh đồng hồ (chỉ cần để biên dịch thân hàm; không chạy hai đường đó ở đây).
    CREATE TABLE public.contract_drafts(id uuid PRIMARY KEY);
    CREATE TABLE public.contract_draft_documents(id uuid PRIMARY KEY);
    CREATE TABLE public.contract_draft_signings(id uuid PRIMARY KEY);
    CREATE TABLE app_private.meter_capture_document_requests(organization_id uuid,actor_id uuid,request_key text,payload_hash text,result jsonb);
    CREATE TABLE engine_calls(case_id uuid,kind text,payload jsonb);
    CREATE TABLE commission_calls(contract_id uuid,kind text,amount numeric,recipient text,description text);
    CREATE TABLE reason_calls(contract_id uuid,kind text,stage text,baseline jsonb);

    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT ARRAY['${org}'::uuid] $$;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY[]::uuid[] $$;
    CREATE FUNCTION public.org_today_v1(uuid DEFAULT NULL) RETURNS date LANGUAGE sql STABLE AS $$ SELECT '2026-11-24'::date $$;
    CREATE FUNCTION public.can_do_on_building(text,text,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
    CREATE FUNCTION public.room_has_holding_deposit(p_room_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;
    CREATE FUNCTION app_private.assert_contract_exit_writer_v1(uuid,uuid) RETURNS void LANGUAGE plpgsql AS $$
      BEGIN IF coalesce(current_setting('test.deny_edit',true),'')='yes' THEN RAISE EXCEPTION 'Missing contracts.edit permission' USING ERRCODE='42501'; END IF; END $$;
    CREATE FUNCTION app_private.has_building_perm_v1(p_building_id uuid,VARIADIC p_permission_keys text[]) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT coalesce(current_setting('test.deny_terminate',true),'')<>'yes' $$;
    CREATE FUNCTION app_private.require_building_perm_v1(p_building_id uuid,p_viec text,VARIADIC p_permission_keys text[]) RETURNS void LANGUAGE plpgsql AS $$
      BEGIN IF NOT app_private.has_building_perm_v1(p_building_id,VARIADIC p_permission_keys) THEN
        RAISE EXCEPTION '[THIEU_QUYEN] %',p_viec USING ERRCODE='42501'; END IF; END $$;
    CREATE FUNCTION app_private.contract_draft_scope_allowed(p_organization_id uuid,p_building_id uuid,p_action text) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT auth.uid() IS NOT NULL AND p_organization_id='${org}'::uuid $$;
    CREATE FUNCTION app_private.contract_exit_case_response_v1(p_case uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
      SELECT jsonb_build_object('id',id,'state',state,'version',version,'current_kind',current_kind) FROM public.contract_exit_cases WHERE id=p_case $$;
    CREATE FUNCTION app_private.record_contract_meter_boundary_set_v1(uuid,uuid,uuid,text,date,jsonb,text DEFAULT 'contracts.edit') RETURNS jsonb
      LANGUAGE sql AS $$ SELECT $6 $$;
    CREATE FUNCTION app_private.assert_contract_transfer_exit_terms_v1(uuid,text,jsonb) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
    CREATE FUNCTION app_private.run_contract_exit_settlement_v1(p_case uuid,p_kind text,p_payload jsonb,p_key text,p_skip boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
      DECLARE e public.contract_exit_cases%ROWTYPE; BEGIN
        SELECT * INTO e FROM public.contract_exit_cases WHERE id=p_case;
        INSERT INTO public.engine_calls VALUES(p_case,p_kind,p_payload);
        IF NOT p_skip THEN UPDATE public.contracts SET status='TERMINATED',actual_end_date=e.actual_move_out_on,updated_at=clock_timestamp() WHERE id=e.contract_id; END IF;
        INSERT INTO public.contract_terminations(contract_id,actual_move_out_date,status) VALUES(e.contract_id,e.actual_move_out_on,'COMPLETED');
        RETURN jsonb_build_object('ok',true,'kind',p_kind); END $$;
    CREATE FUNCTION app_private.rent_support_payout_lock_v1(uuid,uuid) RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
    CREATE FUNCTION app_private.rent_support_legacy_commission_v1(p_contract_id uuid,p_kind text,p_amount numeric,p_voucher_date date,
      p_account_id uuid DEFAULT NULL,p_payer_name text DEFAULT NULL,p_recipient_name text DEFAULT NULL,p_recipient_bank text DEFAULT NULL,
      p_recipient_account text DEFAULT NULL,p_item_description text DEFAULT NULL,p_attachments jsonb DEFAULT '[]') RETURNS jsonb LANGUAGE plpgsql AS $$
      DECLARE v_id uuid:=gen_random_uuid(); BEGIN
        INSERT INTO public.commission_calls VALUES(p_contract_id,p_kind,p_amount,p_recipient_name,p_item_description);
        RETURN jsonb_build_object('id',v_id); END $$;
    CREATE FUNCTION app_private.begin_commission_reason_v1(p_voucher uuid,p_contract uuid,p_kind text,p_stage text,p_reason text,p_baseline jsonb DEFAULT NULL)
      RETURNS uuid LANGUAGE sql AS $$ INSERT INTO public.reason_calls VALUES(p_contract,p_kind,p_stage,p_baseline) RETURNING gen_random_uuid() $$;
    CREATE FUNCTION app_private.authorize_commission_request_v1(uuid,uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
    CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
    CREATE FUNCTION public.ie_all_buildings_scope(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION app_private.rent_support_legacy_deposit_bonus_v1(p_deposit uuid,p_amount numeric,p_recipient text,p_account_number text,p_bank text,
      p_voucher_date date,p_account_id uuid,p_attachments jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('id',gen_random_uuid()) $$;
    CREATE FUNCTION app_private.sale_room_can_edit_v1(uuid,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
    CREATE FUNCTION app_private.sale_room_can_v1(uuid,uuid,text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
    CREATE FUNCTION app_private.sale_room_fact_key_v1(uuid,uuid) RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'k' $$;
    CREATE FUNCTION app_private.room_sale_policy_current_v1(uuid,uuid,timestamptz) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT NULL::jsonb $$;
    CREATE FUNCTION app_private.room_sale_policy_json_v1(app_private.room_sale_policies_v1,timestamptz) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
    CREATE FUNCTION app_private.room_sale_policy_active_text_v1(uuid,uuid,timestamptz) RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULL::text $$;
    CREATE FUNCTION app_private.room_sale_policy_overlay_v1(jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT $1 $$;
    -- Biên của create_contract_v2 (quyền, cờ writer, giữ chỗ, hoá đơn đầu) là bản giả; thân hàm là bản production.
    CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean) LANGUAGE sql STABLE AS $$
      SELECT coalesce(current_setting('test.deny_create',true),'')<>'yes' $$;
    CREATE FUNCTION app_private.evaluate_feature_route(text,uuid) RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'CANONICAL' $$;
    CREATE FUNCTION app_private.assert_room_next_claim_for_signing_v1(uuid,uuid,uuid,bigint,uuid[],uuid[]) RETURNS void LANGUAGE sql AS $$ SELECT $$;
    CREATE FUNCTION app_private.consume_room_next_claim_v1(uuid,uuid,bigint,uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
    CREATE FUNCTION app_private.reservation_deposit_is_settled_v1(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION app_private.begin_ie_flex_write_v1(uuid,text) RETURNS void LANGUAGE sql AS $$ SELECT $$;
    CREATE FUNCTION app_private.end_ie_flex_write_v1(uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
    CREATE FUNCTION app_private.claim_feature_operation_v1(text,uuid,text,uuid,text,numeric) RETURNS void LANGUAGE sql AS $$ SELECT $$;
    CREATE FUNCTION app_private.invoice_rent_support_items_open_v1(uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
    CREATE FUNCTION app_private.invoice_rent_support_items_close_v1(uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
    CREATE FUNCTION public.compute_first_billing_month_v2(date,date) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT to_char($1,'YYYY-MM') $$;
    CREATE FUNCTION public._internal_settlement_account(p_user_id uuid) RETURNS uuid LANGUAGE sql AS $$ SELECT '${internalAccount}'::uuid $$;
    -- Mã phiếu như trigger auto_generate_voucher_code.
    CREATE SEQUENCE voucher_codes;
    CREATE FUNCTION public.test_voucher_code() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.code IS NULL THEN NEW.code:=CASE WHEN NEW.type='INCOME' THEN 'PT' ELSE 'PC' END||nextval('voucher_codes'); END IF; RETURN NEW; END $$;
    CREATE TRIGGER trigger_auto_generate_voucher_code BEFORE INSERT ON public.income_expenses FOR EACH ROW EXECUTE FUNCTION public.test_voucher_code();
  `);
  await db.exec(sliceStatement('20260928015559_contract_exit_case_workflow.sql', 'CREATE TABLE IF NOT EXISTS public.contract_exit_cases', '\n);'));
  await db.exec('ALTER TABLE public.contract_exit_cases ADD COLUMN IF NOT EXISTS return_note text');
  await db.exec(sliceStatement('20260929130117_contract_commission_followups.sql', 'CREATE TABLE IF NOT EXISTS public.contract_commission_events', '\n);'));
  await db.exec(`ALTER TABLE public.contract_commission_events DROP CONSTRAINT IF EXISTS contract_commission_events_action_check;
    ALTER TABLE public.contract_commission_events ADD CONSTRAINT contract_commission_events_action_check CHECK (action IN ('ATTEMPTED','FAILED','NOT_APPLICABLE','REOPENED','COMPLETED'))`);
  const roomTrigger = readFileSync('supabase/migrations/20260915144610_trang_thai_phong_theo_hop_dong_definer.sql', 'utf8');
  const start = roomTrigger.indexOf('CREATE OR REPLACE FUNCTION public.update_room_status_on_contract_change()');
  await db.exec(roomTrigger.slice(start, roomTrigger.indexOf('$fn$;', start) + 6));
  await db.exec('CREATE TRIGGER trigger_update_room_status AFTER INSERT OR UPDATE ON public.contracts FOR EACH ROW EXECUTE FUNCTION public.update_room_status_on_contract_change()');
  for (const name of ['public.confirm_contract_return_v1', 'public.finalize_contract_exit_case_v1', 'app_private.room_sale_workflow_base_fact_v1',
    'app_private.room_sale_lock_open_id_v1', 'app_private.room_sale_workflow_fact_v1', 'public.create_commission_voucher',
    'app_private.contract_commission_live_voucher_v1', 'app_private.contract_commission_latest_event_v1',
    'public.get_my_available_rooms', 'public.get_sale_room_inventory_v1', 'public.real_estate_renewals_transfers_v1',
    'public.create_sale_bonus_from_deposit_v1']) {
    await db.exec(liveDefinitionOf(name));
  }
  await db.exec(readFileSync(BEFORE_FIXTURE, 'utf8'));
  await db.exec('SET check_function_bodies = on');
  await db.exec(readFileSync(MIGRATION_D2, 'utf8'));
  for (const signature of Object.keys(PROD_MD5)) before[signature] = await md5Of(signature);
  await db.exec(migrationSql);
  for (const signature of Object.keys(PROD_MD5)) after[signature] = await md5Of(signature);
  await db.exec(migrationSql);
  for (const signature of Object.keys(PROD_MD5)) afterSecond[signature] = await md5Of(signature);
  // Bốn phòng, mỗi phòng một hợp đồng cũ đang ở, cọc 4.000.000 đã thu đủ bằng một phiếu thu cọc.
  for (let i = 0; i < 4; i++) {
    await db.query(`INSERT INTO public.rooms(id,organization_id,building_id,name,status) VALUES($1,$2,$3,$4,'OCCUPIED')`, [rooms[i], org, building, `P10${i + 1}`]);
    await db.query(`INSERT INTO public.customers VALUES($1,$2,$3,null),($4,$2,$5,null)`, [oldCustomers[i], org, `Khách cũ ${i + 1}`, newCustomers[i], `Khách nhận ${i + 1}`]);
    await db.query(`INSERT INTO public.contracts(id,organization_id,room_id,contract_number,user_id,deposit_paid) VALUES($1,$2,$3,$4,$5,0)`,
      [olds[i], org, rooms[i], `HD-${i + 1}`, owner]);
    await db.query(`INSERT INTO public.contract_customers(organization_id,contract_id,customer_id,is_representative) VALUES($1,$2,$3,true)`, [org, olds[i], oldCustomers[i]]);
    const voucher = (await db.query<{ id: string }>(`INSERT INTO public.income_expenses(user_id,organization_id,contract_id,room_id,building_id,account_id,type,
      total_amount,approval_status,voucher_date,system_source) VALUES($1,$2,$3,$4,$5,$6,'INCOME',4000000,'APPROVED','2026-01-01','contract.create.v2') RETURNING id`,
      [owner, org, olds[i], rooms[i], building, cashAccount])).rows[0].id;
    await db.query(`INSERT INTO public.income_expense_items(income_expense_id,organization_id,income_expense_type_id,quantity,unit_price,amount,accounting_class)
      SELECT $1,$2,t.id,1,4000000,4000000,'DEPOSIT' FROM public.income_expense_types t WHERE t.name='Tiền cọc'`, [voucher, org]);
    await db.query('SELECT public.recompute_contract_deposit_paid($1)', [olds[i]]);
  }
}, 60000);
afterAll(async () => { await db.close(); });
beforeEach(async () => { await db.exec('BEGIN'); await db.query(`SELECT set_config('test.actor',$1,false)`, [actor]); });
afterEach(async () => {
  await db.exec('ROLLBACK');
  await db.exec('RESET test.deny_terminate; RESET test.deny_edit; RESET test.deny_create');
});

async function rejects(sql: string, args: unknown[], code: string, message?: RegExp) {
  await db.exec('SAVEPOINT failure');
  const error = await db.query(sql, args).then(() => null, (e: { code?: string; message?: string }) => e);
  await db.exec('ROLLBACK TO SAVEPOINT failure');
  expect(error, `${sql} phải lỗi ${code}`).not.toBeNull();
  expect(error?.code).toBe(code);
  if (message) expect(error?.message).toMatch(message);
}
const CONFIRM = 'SELECT public.confirm_contract_return_v2($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11::jsonb) AS r';
async function confirm(i: number, terms: Row) {
  const updated = (await db.query<{ u: string }>('SELECT updated_at::text u FROM public.contracts WHERE id=$1', [olds[i]])).rows[0].u;
  return (await db.query<{ r: Row }>(CONFIRM, [org, olds[i], updated, `return-key-${i}-000`, MOVE_OUT, 'EARLY_RETURN', 'DEFERRED', null, null,
    'Khách đã bàn giao', JSON.stringify(terms)])).rows[0].r;
}
async function terms(i: number): Promise<Row> {
  return (await db.query<Row>('SELECT * FROM public.contract_exit_early_terms WHERE contract_id=$1', [olds[i]])).rows[0];
}
async function caseOf(i: number): Promise<Row> {
  return (await db.query<Row>('SELECT * FROM public.contract_exit_cases WHERE contract_id=$1', [olds[i]])).rows[0];
}
async function paid(contractId: string): Promise<number> {
  const r = (await db.query<{ p: string; d: string }>('SELECT deposit_paid::text p,public.contract_deposit_paid_derived(id)::text d FROM public.contracts WHERE id=$1', [contractId])).rows[0];
  expect(Number(r.p)).toBe(Number(r.d));
  return Number(r.p);
}
interface NewContractOptions { total?: number; receipt?: number; support?: unknown; existing?: string[]; start?: string; firstInvoice?: number; key?: string }
function contractPayload(i: number, o: NewContractOptions = {}) {
  const total = o.total ?? 4_000_000;
  const receipt = o.receipt ?? 0;
  const payload: Row = {
    contract: { room_id: rooms[i], signed_date: o.start ?? START, start_date: o.start ?? START, end_date: '2027-05-20', rent_price: 3_000_000,
      total_deposit: total, payment_cycle: 'MONTHLY', ...(o.firstInvoice === undefined ? { deposit_debt_mode: 'DEBT', deposit_debt_reason: 'Nộp sau',
        deposit_topup_due_date: '2026-12-01' } : { deposit_debt_mode: 'FIRST_INVOICE' }) },
    customers: [{ customer_id: newCustomers[i], is_representative: true }],
    services: [],
    deposit_receipts: receipt > 0 ? [{ amount: receipt, account_id: cashAccount, received_date: START }] : [],
    existing_deposit_voucher_ids: o.existing ?? [],
  };
  if (o.support !== undefined) payload.transfer_support_amount = o.support;
  if (o.firstInvoice !== undefined) payload.first_invoice = { items: [
    { type: 'RENT', description: 'Tiền phòng', unit_price: 3_000_000, quantity: 1, accounting_class: 'REVENUE' },
    ...(o.firstInvoice > 0 ? [{ type: 'OTHER', description: 'Tiền cọc còn thiếu', unit_price: o.firstInvoice, quantity: 1, accounting_class: 'DEPOSIT' }] : []),
  ] };
  return payload;
}
const CREATE = 'SELECT public.create_contract_v2($1::jsonb,$2) AS r';
async function createContract(i: number, o: NewContractOptions = {}) {
  return (await db.query<{ r: Row }>(CREATE, [JSON.stringify(contractPayload(i, o)), o.key ?? `create-key-${i}-0001`])).rows[0].r;
}
const supportVouchers = async () => (await db.query<Row>(`SELECT v.id,v.type,v.contract_id,v.account_id,v.total_amount::float8 amount,v.approval_status,
  v.voucher_date::text voucher_date,v.system_source,v.code,(SELECT string_agg(i.accounting_class,',') FROM public.income_expense_items i WHERE i.income_expense_id=v.id) classes
  FROM public.income_expenses v WHERE v.system_source LIKE 'exit.support%' ORDER BY v.system_source DESC`)).rows;
const REVERSE = 'SELECT public.reverse_contract_exit_support_v1($1,$2,$3,$4,$5) AS r';

describe('migration', () => {
  it('thân hàm production đúng md5 trước vá; chạy hai lượt không đổi gì thêm; md5 sau vá đúng bản đã ghim', () => {
    expect(before).toEqual(PROD_MD5);
    expect(afterSecond).toEqual(after);
    expect(after).toEqual(AFTER_MD5);
  });

  it('mỗi điểm nối đúng một lần, đúng chỗ; trigger chặn có mặt; helper đóng, RPC đảo mở', async () => {
    const def = async (sig: string) => (await db.query<{ d: string }>('SELECT pg_get_functiondef($1::regprocedure) d', [sig])).rows[0].d;
    const count = (body: string, marker: string) => body.split(marker).length - 1;
    const create = await def('public.create_contract_v2(jsonb,text)');
    expect(count(create, 'apply_exit_support_on_contract_create_v1(')).toBe(1);
    expect(create).toContain("PERFORM app_private.apply_exit_support_on_contract_create_v1(v_org,v_contract_id,p_payload->'transfer_support_amount',v_key);\n  PERFORM public.recompute_contract_deposit_paid(v_contract_id);");
    const sign = await def('public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[])');
    expect(count(sign, "'invoice_template_id','transfer_support_amount'))")).toBe(1);
    expect(count(sign, "-'existing_deposit_voucher_ids'-'transfer_support_amount'),")).toBe(1);
    expect(count(sign, "jsonb_build_object('transfer_support_amount',p_creation_options->'transfer_support_amount')")).toBe(1);
    // Số hỗ trợ đi vào payload TRƯỚC khi gọi create_contract_v2.
    expect(sign.indexOf("jsonb_build_object('transfer_support_amount'")).toBeLessThan(sign.indexOf('public.create_contract_v2('));
    const meter = await def('public.meter_capture_exit_v1(uuid,text,jsonb,jsonb)');
    expect(count(meter, "'confirm_contract_return_v2'")).toBe(2);
    expect(count(await def('app_private.meter_capture_invoke_writer_v1(text,jsonb)'), "'confirm_contract_return_v2'")).toBe(1);
    const response = await def('app_private.contract_exit_early_terms_response_v1(uuid)');
    expect(count(response, "'support_out_code'")).toBe(1);
    expect(count(response, "'support_in_code'")).toBe(1);
    const triggers = (await db.query<{ t: string }>(`SELECT tgrelid::regclass::text||':'||tgname t FROM pg_trigger WHERE tgname IN
      ('a00_exit_support_voucher_guard','a00_exit_support_item_guard','a02_contract_exit_support_guard','a00_exit_support_bonus_claim_guard')
      ORDER BY 1`)).rows.map(r => r.t);
    expect(triggers).toEqual(['app_private.sale_bonus_claims:a00_exit_support_bonus_claim_guard', 'contracts:a02_contract_exit_support_guard',
      'income_expense_items:a00_exit_support_item_guard', 'income_expenses:a00_exit_support_voucher_guard']);
    const priv = (await db.query<Row>(`SELECT
      has_function_privilege('authenticated','app_private.apply_exit_support_on_contract_create_v1(uuid,uuid,jsonb,text)','EXECUTE') apply,
      has_function_privilege('authenticated','public.reverse_contract_exit_support_v1(uuid,uuid,bigint,uuid,text)','EXECUTE') reverse,
      has_function_privilege('anon','public.reverse_contract_exit_support_v1(uuid,uuid,bigint,uuid,text)','EXECUTE') anon`)).rows[0];
    expect(priv).toEqual({ apply: false, reverse: true, anon: false });
  });
});

describe('ghi số hỗ trợ khi tạo hợp đồng khách nhận', () => {
  it('nhờ sale, hoá đơn đầu: cặp phiếu đã duyệt trên sổ nội bộ, cọc hai bên đổi đúng số, dòng cọc hoá đơn đầu nhỏ đi; gọi lặp không ghi đôi', async () => {
    await confirm(0, { early_reason: 'SALE_ASSISTED', sale_name: 'Sale Minh' });
    expect(await paid(olds[0])).toBe(4_000_000);
    // Cọc mới 4.000.000 = nộp 1.000.000 + hỗ trợ 1.500.000 + dòng cọc hoá đơn đầu 1.500.000.
    const r = await createContract(0, { receipt: 1_000_000, support: 1_500_000, firstInvoice: 1_500_000 });
    const contract = r.contract as Row;
    expect(Number(r.deposit_paid)).toBe(2_500_000);
    expect(Number(r.deposit_shortfall)).toBe(1_500_000);
    expect(await paid(olds[0])).toBe(2_500_000);
    expect(await paid(String(contract.id))).toBe(2_500_000);
    const vouchers = await supportVouchers();
    expect(vouchers).toEqual([
      expect.objectContaining({ type: 'EXPENSE', contract_id: olds[0], account_id: internalAccount, amount: 1_500_000, approval_status: 'APPROVED',
        voucher_date: '2026-11-24', system_source: 'exit.support_out', classes: 'DEPOSIT' }),
      expect.objectContaining({ type: 'INCOME', contract_id: contract.id, account_id: internalAccount, amount: 1_500_000, approval_status: 'APPROVED',
        voucher_date: '2026-11-24', system_source: 'exit.support_in', classes: 'DEPOSIT' }),
    ]);
    const t = await terms(0);
    expect(t).toMatchObject({ new_contract_id: contract.id, support_out_voucher_id: vouchers[0].id, support_in_voucher_id: vouchers[1].id, version: 3 });
    expect(Number(t.support_amount)).toBe(1_500_000);
    // Hạng mục hai phiếu: loại cọc, đúng tổ chức của hồ sơ, tạo một lần.
    expect((await db.query(`SELECT t.type,t.is_deposit,t.organization_id FROM public.income_expense_types t JOIN public.income_expense_items i ON i.income_expense_type_id=t.id
      WHERE i.income_expense_id IN ($1,$2) ORDER BY t.type`, [vouchers[0].id, vouchers[1].id])).rows).toEqual([
      { type: 'expense', is_deposit: true, organization_id: org }, { type: 'income', is_deposit: true, organization_id: org }]);
    const read = (await db.query<{ r: Row[] }>('SELECT public.read_contract_exit_early_terms_v1($1,$2) r', [org, contract.id])).rows[0].r[0];
    expect(read).toMatchObject({ support_amount: 1_500_000, support_out_code: vouchers[0].code, support_in_code: vouchers[1].code,
      old_contract_deposit_paid: 2_500_000, new_contract_deposit_paid: 2_500_000 });
    expect((read.history as Row[]).map(h => h.event)).toEqual(['CREATED', 'NEW_CONTRACT_LINKED', 'SUPPORT_APPLIED']);
    expect((read.history as Row[]).at(-1)).toMatchObject({ payload: { amount: 1_500_000, old_deposit_paid_before: 4_000_000,
      new_deposit_paid_before: 1_000_000, broker_fee: 2_000_000 } });
    const deposits = (await db.query<{ amount: number }>(`SELECT ii.amount::float8 amount FROM public.invoice_items ii JOIN public.invoices i ON i.id=ii.invoice_id
      WHERE i.contract_id=$1 AND ii.accounting_class='DEPOSIT'`, [contract.id])).rows;
    expect(deposits).toEqual([{ amount: 1_500_000 }]);
    // Gọi lại đúng khoá và nội dung: trả kết quả cũ, không ghi thêm phiếu.
    expect((await db.query<{ r: Row }>(CREATE, [JSON.stringify(contractPayload(0, { receipt: 1_000_000, support: 1_500_000, firstInvoice: 1_500_000 })),
      'create-key-0-0001'])).rows[0].r).toEqual(r);
    expect(await supportVouchers()).toHaveLength(2);
    expect(await paid(olds[0])).toBe(2_500_000);
  });

  it('tự tìm, đường Cọc: phiếu cọc giữ chỗ có sẵn cộng số hỗ trợ đủ cọc mới, không cần nợ cọc', async () => {
    await confirm(1, { early_reason: 'SELF_FOUND' });
    const reservation = (await db.query<{ id: string }>(`INSERT INTO public.income_expenses(user_id,organization_id,room_id,building_id,account_id,type,
      total_amount,approval_status,voucher_date) VALUES($1,$2,$3,$4,$5,'INCOME',1000000,'APPROVED','2026-11-21') RETURNING id`,
      [owner, org, rooms[1], building, cashAccount])).rows[0].id;
    await db.query(`INSERT INTO public.income_expense_items(income_expense_id,organization_id,income_expense_type_id,quantity,unit_price,amount,accounting_class)
      SELECT $1,$2,t.id,1,1000000,1000000,'DEPOSIT' FROM public.income_expense_types t WHERE t.name='Tiền cọc'`, [reservation, org]);
    const r = await createContract(1, { total: 3_000_000, existing: [reservation], support: 2_000_000 });
    expect(Number(r.deposit_paid)).toBe(3_000_000);
    expect(Number(r.deposit_shortfall)).toBe(0);
    expect((r.contract as Row).deposit_debt_mode).toBeNull();
    expect(await paid(olds[1])).toBe(2_000_000);
    expect(Number((await terms(1)).support_amount)).toBe(2_000_000);
  });

  it('trần cọc cũ: không vượt cọc cũ đã thu trừ phí môi giới; đúng bằng trần thì qua; vượt thì không ghi gì', async () => {
    await confirm(0, { early_reason: 'SALE_ASSISTED', sale_name: 'Sale Minh' });
    await rejects(CREATE, [JSON.stringify(contractPayload(0, { receipt: 1_000_000, support: 2_000_001 })), 'create-key-cap-old-1'], '22023',
      /vượt cọc cũ đã thu sau khi trừ phí môi giới \(tối đa 2.000.000đ\)/);
    expect(await supportVouchers()).toHaveLength(0);
    expect((await db.query('SELECT 1 FROM public.contracts WHERE room_id=$1 AND id<>$2', [rooms[0], olds[0]])).rows).toHaveLength(0);
    await createContract(0, { receipt: 1_000_000, support: 2_000_000, key: 'create-key-cap-old-2' });
    expect(await paid(olds[0])).toBe(2_000_000);
  });

  it('trần cọc mới: không vượt phần cọc còn thiếu của hợp đồng mới; đúng bằng trần thì qua', async () => {
    await confirm(2, { early_reason: 'SELF_FOUND' });
    await rejects(CREATE, [JSON.stringify(contractPayload(2, { total: 1_000_000, receipt: 600_000, support: 400_001 })), 'create-key-cap-new-1'], '22023',
      /vượt phần cọc còn thiếu của hợp đồng mới \(tối đa 400.000đ\)/);
    expect(await supportVouchers()).toHaveLength(0);
    const r = await createContract(2, { total: 1_000_000, receipt: 600_000, support: 400_000, key: 'create-key-cap-new-2' });
    expect(Number(r.deposit_shortfall)).toBe(0);
    expect(await paid(olds[2])).toBe(3_600_000);
  });

  it('không có hồ sơ chờ nối, bắt đầu trước ngày trả phòng, hoặc chủ nhà hỗ trợ: số hỗ trợ bị từ chối; số 0 hay bỏ trống thì không ghi gì', async () => {
    // Phòng 4 trống vì hợp đồng cũ đã kết thúc theo đường khác (không có hồ sơ trả phòng trước hạn).
    await db.query(`UPDATE public.contracts SET status='TERMINATED' WHERE id=$1`, [olds[3]]);
    await rejects(CREATE, [JSON.stringify(contractPayload(3, { support: 100_000 })), 'create-key-nolink-1'], '55000', /không nối với hồ sơ khách cũ/);
    await confirm(0, { early_reason: 'SALE_ASSISTED', sale_name: 'Sale Minh' });
    await rejects(CREATE, [JSON.stringify(contractPayload(0, { support: 100_000, start: '2026-11-19' })), 'create-key-nolink-2'], '55000', /không nối/);
    await confirm(2, { early_reason: 'LANDLORD_AGREEMENT' });
    await rejects(CREATE, [JSON.stringify(contractPayload(2, { support: 100_000 })), 'create-key-nolink-3'], '55000', /không nối/);
    await createContract(0, { support: 0, key: 'create-key-zero' });
    await createContract(2, { support: null, key: 'create-key-null' });
    expect(await supportVouchers()).toHaveLength(0);
    expect(Number((await terms(0)).support_amount)).toBe(0);
  });

  it('số tiền sai dạng bị từ chối 22023; thiếu quyền thanh lý ở toà thì 42501; không ghi gì', async () => {
    await confirm(0, { early_reason: 'SALE_ASSISTED', sale_name: 'Sale Minh' });
    for (const [n, value] of [[1, -1], [2, 'abc'], [3, 1.234], [4, { amount: 1 }], [5, 'NaN'], [6, [1]]] as const) {
      await rejects(CREATE, [JSON.stringify(contractPayload(0, { support: value })), `create-key-bad-${n}`], '22023', /không hợp lệ/);
    }
    await db.query(`SELECT set_config('test.deny_terminate','yes',true)`);
    await rejects(CREATE, [JSON.stringify(contractPayload(0, { support: 100_000 })), 'create-key-deny'], '42501');
    expect(await supportVouchers()).toHaveLength(0);
  });
});

describe('chặn huỷ, xoá và đổi trường hợp khi có số hỗ trợ', () => {
  async function applied() {
    await confirm(0, { early_reason: 'SALE_ASSISTED', sale_name: 'Sale Minh' });
    const r = await createContract(0, { receipt: 1_000_000, support: 1_000_000 });
    return { newId: String((r.contract as Row).id), vouchers: await supportVouchers() };
  }

  it('phiếu và dòng phiếu không huỷ, xoá, sửa tiền được; sửa ghi chú vẫn được; không ai tự ghi phiếu nguồn exit.support', async () => {
    const { vouchers } = await applied();
    const [out, inn] = vouchers.map(v => String(v.id));
    await rejects(`UPDATE public.income_expenses SET approval_status='CANCELLED' WHERE id=$1`, [out], '55000', /đảo số hỗ trợ ở hồ sơ trả phòng/);
    await rejects(`UPDATE public.income_expenses SET deleted_at=now() WHERE id=$1`, [inn], '55000');
    await rejects(`UPDATE public.income_expenses SET total_amount=1 WHERE id=$1`, [inn], '55000');
    await rejects(`UPDATE public.income_expenses SET contract_id=NULL WHERE id=$1`, [out], '55000');
    await rejects(`UPDATE public.income_expenses SET account_id=$2 WHERE id=$1`, [out, cashAccount], '55000');
    await rejects(`UPDATE public.income_expenses SET system_source='manual' WHERE id=$1`, [out], '55000');
    await rejects(`DELETE FROM public.income_expense_items WHERE income_expense_id=$1`, [out], '55000');
    await rejects(`DELETE FROM public.income_expenses WHERE id=$1`, [out], '55000');
    await rejects(`UPDATE public.income_expense_items SET amount=1 WHERE income_expense_id=$1`, [inn], '55000');
    await rejects(`INSERT INTO public.income_expense_items(income_expense_id,organization_id,amount,accounting_class) VALUES($1,$2,1,'DEPOSIT')`, [inn, org], '55000');
    await db.query(`UPDATE public.income_expenses SET notes='Bổ sung ghi chú' WHERE id=$1`, [out]);
    await db.query(`UPDATE public.income_expense_items SET description='Mô tả mới' WHERE income_expense_id=$1`, [out]);
    await rejects(`INSERT INTO public.income_expenses(organization_id,type,total_amount,system_source) VALUES($1,'INCOME',1,'exit.support_in')`, [org], '42501');
    expect(await paid(olds[0])).toBe(3_000_000);
  });

  it('phiếu chuyển cọc không làm nguồn thưởng Sale theo phiếu cọc; phiếu cọc khác vẫn ghi claim được', async () => {
    const { vouchers } = await applied();
    const [out, inn] = vouchers.map(v => String(v.id));
    const bonus = '30000000-0000-4000-8000-0000000000b1';
    await rejects(`INSERT INTO app_private.sale_bonus_claims(organization_id,deposit_voucher_id,bonus_voucher_id) VALUES($1,$2,$3)`,
      [org, inn, bonus], '22023', /không dùng làm nguồn thưởng Sale/);
    await rejects(`INSERT INTO app_private.sale_bonus_claims(organization_id,deposit_voucher_id,bonus_voucher_id) VALUES($1,$2,$3)`,
      [org, out, bonus], '22023');
    const other = String((await db.query<Row>(`INSERT INTO public.income_expenses(organization_id,type,total_amount,system_source)
      VALUES($1,'INCOME',500000,'manual') RETURNING id`, [org])).rows[0].id);
    await db.query(`INSERT INTO app_private.sale_bonus_claims(organization_id,deposit_voucher_id,bonus_voucher_id) VALUES($1,$2,$3)`, [org, other, bonus]);
    await rejects(`UPDATE app_private.sale_bonus_claims SET deposit_voucher_id=$1 WHERE deposit_voucher_id=$2`, [inn, other], '22023');
    await db.query(`DELETE FROM app_private.sale_bonus_claims WHERE deposit_voucher_id=$1`, [other]);
  });

  it('hợp đồng mới và cũ không xoá được; đổi trường hợp bị chặn; quyết toán cũ vẫn đi với cọc còn lại', async () => {
    const { newId } = await applied();
    await rejects(`UPDATE public.contracts SET deleted_at=now() WHERE id=$1`, [newId], '55000', /đảo số hỗ trợ/);
    await rejects(`DELETE FROM public.contracts WHERE id=$1`, [newId], '55000');
    await rejects(`UPDATE public.contracts SET deleted_at=now() WHERE id=$1`, [olds[0]], '55000');
    await db.query(`UPDATE public.contracts SET notes='Sửa ghi chú' WHERE id=$1`, [newId]);
    const e = await caseOf(0);
    const t = await terms(0);
    await rejects('SELECT public.set_contract_exit_early_terms_v1($1,$2,$3,$4,$5,$6,$7)',
      [org, e.id, t.version, id(950), 'LANDLORD_AGREEMENT', null, 'Khách nhận huỷ'], '55000', /tiền hỗ trợ/);
    // Phí môi giới vẫn không vượt cọc còn lại (4.000.000 - 1.000.000 hỗ trợ).
    await rejects('SELECT public.update_contract_exit_broker_fee_v1($1,$2,$3,$4,$5,$6)', [org, e.id, t.version, id(951), 3_000_001, 'Thử'], '22023', /vượt cọc/);
    await db.query('SELECT public.finalize_contract_exit_case_v1($1,$2,$3,$4,$5,$6,$7::jsonb)', [org, e.id, e.version, 'settle-key-0-0001', 'EARLY_RETURN', null,
      JSON.stringify({ deposit_refund: 3_000_000, extra_charges: [{ kind: 'BROKER_FEE', description: 'Phí môi giới (50% cọc cũ)', amount: 2_000_000 }] })]);
    expect((await caseOf(0)).state).toBe('FINALIZED');
  });
});

describe('đảo số hỗ trợ', () => {
  it('cần lý do, quyền, đúng phiên bản; đảo huỷ đúng cặp phiếu, cọc hai bên về như trước; gọi lặp trả cùng kết quả; sau đó mới xoá/đổi được', async () => {
    await confirm(0, { early_reason: 'SALE_ASSISTED', sale_name: 'Sale Minh' });
    const r = await createContract(0, { receipt: 1_000_000, support: 1_200_000 });
    const newId = String((r.contract as Row).id);
    const e = await caseOf(0);
    const version = Number((await terms(0)).version);
    await rejects(REVERSE, [org, e.id, version, id(960), '  '], '22023');
    await rejects(REVERSE, [org, e.id, version + 1, id(960), 'Khách nhận huỷ'], 'PT409');
    await db.query(`SELECT set_config('test.deny_terminate','yes',true)`);
    await rejects(REVERSE, [org, e.id, version, id(960), 'Khách nhận huỷ'], '42501');
    await db.query(`SELECT set_config('test.deny_terminate','',true)`);
    const reversed = (await db.query<{ r: Row }>(REVERSE, [org, e.id, version, id(960), 'Khách nhận huỷ'])).rows[0].r;
    expect(reversed).toMatchObject({ support_amount: 0, support_out_voucher_id: null, support_in_voucher_id: null, support_out_code: null,
      version: version + 1 });
    expect((reversed.history as Row[]).at(-1)).toMatchObject({ event: 'SUPPORT_REVERSED', reason: 'Khách nhận huỷ', payload: { amount: 1_200_000 } });
    expect((await supportVouchers()).map(v => v.approval_status)).toEqual(['CANCELLED', 'CANCELLED']);
    expect(await paid(olds[0])).toBe(4_000_000);
    expect(await paid(newId)).toBe(1_000_000);
    expect((await db.query<{ r: Row }>(REVERSE, [org, e.id, version, id(960), 'Khách nhận huỷ'])).rows[0].r).toEqual(reversed);
    await rejects(REVERSE, [org, e.id, version, id(960), 'Lý do khác'], '23505');
    await rejects(REVERSE, [org, e.id, version + 1, id(961), 'Đảo lần hai'], '55000', /không có số tiền/);
    // Phiếu đã huỷ vẫn không sửa/xoá được.
    await rejects(`DELETE FROM public.income_expenses WHERE system_source='exit.support_in'`, [], '55000');
    await db.query(`UPDATE public.contracts SET deleted_at=now() WHERE id=$1`, [newId]);
    await db.query('SELECT public.set_contract_exit_early_terms_v1($1,$2,$3,$4,$5,$6,$7)',
      [org, e.id, version + 1, id(962), 'LANDLORD_AGREEMENT', null, 'Khách nhận huỷ, chủ nhà đồng ý']);
  });

  it('hợp đồng khách nhận không còn hiệu lực thì không đảo được', async () => {
    await confirm(1, { early_reason: 'SELF_FOUND' });
    const r = await createContract(1, { receipt: 1_000_000, support: 300_000 });
    await db.query(`UPDATE public.contracts SET status='TERMINATED' WHERE id=$1`, [String((r.contract as Row).id)]);
    const e = await caseOf(1);
    await rejects(REVERSE, [org, e.id, Number((await terms(1)).version), id(980), 'Thử'], '55000', /không còn hiệu lực/);
  });

  it('hồ sơ cũ đã quyết toán thì không đảo được', async () => {
    await confirm(0, { early_reason: 'SELF_FOUND' });
    await createContract(0, { receipt: 1_000_000, support: 500_000 });
    const e = await caseOf(0);
    await db.query('SELECT public.finalize_contract_exit_case_v1($1,$2,$3,$4,$5,$6,$7::jsonb)', [org, e.id, e.version, 'settle-key-self', 'EARLY_RETURN', null,
      JSON.stringify({ deposit_refund: 3_500_000, extra_charges: [] })]);
    await rejects(REVERSE, [org, e.id, Number((await terms(0)).version), id(970), 'Muộn'], '55000', /đã quyết toán/);
    expect(await paid(olds[0])).toBe(3_500_000);
  });
});
