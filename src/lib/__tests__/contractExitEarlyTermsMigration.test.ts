import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Trả phòng trước hạn: ba trường hợp, giữ phòng, phí môi giới, hoa hồng (plan sang nhượng phòng, đợt 2).
// Hàm hiện hành nạp từ định nghĩa SỐNG cuối cùng của corpus migration, kiểm md5 bằng đúng md5 production
// đọc 24/11/2026, rồi mới chạy migration (hai lượt). Máy quyết toán và writer hoa hồng là bản giả ở biên.
const MIGRATION = 'supabase/migrations/20261124075933_tra_phong_truoc_han_ba_truong_hop.sql';
const migrationSql = readFileSync(MIGRATION, 'utf8');
const migrationCorpus = readdirSync('supabase/migrations').filter(file => file.endsWith('.sql')).sort().reverse()
  .map(file => ({ file, sql: readFileSync(join('supabase/migrations', file), 'utf8') }));
function liveDefinitionOf(qualified: string): string {
  const pattern = new RegExp('CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+' + qualified.replace(/\./g, '\\.')
    + '\\s*\\([\\s\\S]*?\\bAS\\s+(\\$[a-zA-Z_]*\\$)[\\s\\S]*?\\1\\s*;', 'i');
  for (const migration of migrationCorpus) {
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

// md5(pg_get_functiondef) production 24/11/2026 (_bao-cao-nhuong-hd/than-ham-prod-24-11/_danh-sach-md5.json + đọc lại).
const PROD_MD5: Record<string, string> = {
  'public.confirm_contract_return_v1(uuid,uuid,timestamp with time zone,text,date,text,text,jsonb,jsonb,text)': 'bd0839dc8dca04223770f83cac355c40',
  'public.finalize_contract_exit_case_v1(uuid,uuid,bigint,text,text,text,jsonb)': '51950e73cbe205f4fd17f0fda7d56d5d',
  'app_private.room_sale_workflow_fact_v1(uuid,uuid,text,boolean,integer)': '12f45a7e99cd0d6f2ef1755596d69094',
  'app_private.room_sale_workflow_base_fact_v1(uuid,uuid,text,boolean,integer)': 'ce899102cacced8793739a362c02f74c',
  'public.create_commission_voucher(uuid,text,numeric,date,uuid,text,text,text,text,text,jsonb)': '26100576d7adde1bba05cb84ca8ffdc0',
  'public.get_my_available_rooms()': '797f061518ae382194335d9fad08686f',
  'public.get_sale_room_inventory_v1(uuid,uuid,uuid)': '68b9279ca5e6f6a21a1aed1ab6503b1f',
  'public.real_estate_renewals_transfers_v1(uuid,uuid[],date,date)': '2b0d3cabdda7957f4698006bb0861026',
  'public.create_sale_bonus_from_deposit_v1(uuid,numeric,text,text,text,date,uuid,jsonb)': '5c120cb4a699f4520cbd68cc75ee4071',
};
// Sau migration (đo trên PGlite; đối chiếu lại trên TEST sau khi áp).
const AFTER_MD5: Record<string, string> = {
  'public.confirm_contract_return_v1(uuid,uuid,timestamp with time zone,text,date,text,text,jsonb,jsonb,text)': 'b871e6cb887a8c6434f26ca2b46a04dd',
  'public.finalize_contract_exit_case_v1(uuid,uuid,bigint,text,text,text,jsonb)': '52b77bf569607a6122570bbd14e7ccd5',
  'app_private.room_sale_workflow_fact_v1(uuid,uuid,text,boolean,integer)': '3e0c53200c740916992a6a02b69fda49',
  'app_private.room_sale_workflow_base_fact_v1(uuid,uuid,text,boolean,integer)': 'ce899102cacced8793739a362c02f74c',
  'public.create_commission_voucher(uuid,text,numeric,date,uuid,text,text,text,text,text,jsonb)': '6fc44789fd3c7d2f93c34025482b99fb',
  'public.get_my_available_rooms()': 'b78b8c84dd6a9b05e2173bc6cbe66b92',
  'public.get_sale_room_inventory_v1(uuid,uuid,uuid)': '1888552bcb8a6322145e29f2750e1adc',
  'public.real_estate_renewals_transfers_v1(uuid,uuid[],date,date)': 'db708bfd1c72fa132ada633f9961c5c5',
  'public.create_sale_bonus_from_deposit_v1(uuid,numeric,text,text,text,date,uuid,jsonb)': '951c24f3d555907cfeec88cfcf79df7a',
};

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const org = id(1), actor = id(2), building = id(3), manager = id(4), owner = id(5);
const rooms = [id(11), id(12), id(13), id(14)];
const olds = [id(21), id(22), id(23), id(24)];
const customers = [id(31), id(32), id(33), id(34)];
const MOVE_OUT = '2026-11-20';
const NOTE = 'Khách đã bàn giao chìa khoá';
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
    INSERT INTO auth.users VALUES('${actor}'),('${manager}'),('${owner}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.actor',true),'')::uuid $$;
    CREATE TABLE public.organizations(id uuid PRIMARY KEY,status text DEFAULT 'ACTIVE');
    INSERT INTO public.organizations(id) VALUES('${org}');
    CREATE TABLE public.buildings(id uuid PRIMARY KEY,organization_id uuid,name text,code text,district text,ward text,street_address text,province text,
      total_floors int,images jsonb,public_contact_name text,public_contact_phone text,public_map_url text,public_lift_type text,floor_layouts jsonb,
      user_id uuid,is_virtual boolean DEFAULT false,deleted_at timestamptz,UNIQUE(organization_id,id));
    INSERT INTO public.buildings(id,organization_id,name,user_id) VALUES('${building}','${org}','Toà A','${owner}');
    CREATE TABLE public.rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,floor int DEFAULT 1,name text,code text,area numeric,rent_price numeric,
      deposit_amount numeric,max_occupants int,amenities jsonb,images jsonb,description text,sale_note text,sale_bonus_note text,room_type text,
      sale_status_note text,sale_status_note_key text,status text DEFAULT 'OCCUPIED',updated_at timestamptz DEFAULT now(),deleted_at timestamptz,UNIQUE(organization_id,id));
    CREATE TABLE public.contracts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,room_id uuid,contract_number text,status text DEFAULT 'ACTIVE',
      start_date date DEFAULT '2026-01-01',start_billing_date date,end_date date DEFAULT '2026-12-31',actual_end_date date,expected_move_out_date date,
      total_deposit numeric DEFAULT 4000000,deposit_paid numeric DEFAULT 4000000,rent_price numeric DEFAULT 3000000,
      user_id uuid,tenant_id uuid,parent_contract_id uuid,notes text,created_at timestamptz DEFAULT clock_timestamp(),
      updated_at timestamptz DEFAULT '2026-11-01',deleted_at timestamptz,UNIQUE(organization_id,id));
    CREATE TABLE public.customers(id uuid PRIMARY KEY,organization_id uuid,full_name text,deleted_at timestamptz);
    CREATE TABLE public.profiles(id uuid PRIMARY KEY,full_name text);
    INSERT INTO public.profiles VALUES('${actor}','Người ghi A'),('${manager}','Quản lý B'),('${owner}','Chủ C');
    CREATE TABLE public.contract_customers(contract_id uuid,customer_id uuid,is_representative boolean,created_at timestamptz DEFAULT now(),id uuid DEFAULT gen_random_uuid());
    CREATE TABLE public.contract_tenants(contract_id uuid,tenant_id uuid);
    CREATE TABLE public.room_pass_listings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),room_id uuid,organization_id uuid,user_id uuid,active boolean,
      contact_manager boolean,contact_name text,contact_phone text,sale_policy text,pass_price numeric,avail_date date,updated_at timestamptz);
    CREATE TABLE public.contract_terminations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),contract_id uuid UNIQUE,actual_move_out_date date,status text);
    CREATE TABLE public.income_expenses(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,contract_id uuid,type text,commission_kind text,
      total_amount numeric,notes text,approval_status text,deleted_at timestamptz,code text,created_at timestamptz DEFAULT clock_timestamp(),
      room_id uuid,building_id uuid);
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
    -- Reader nội bộ (Sale Phòng).
    CREATE TABLE public.public_room_settings(owner_id uuid,soon_days int,hotline_id uuid,sale_policy text);
    CREATE TABLE public.staff_assignments(staff_id uuid,user_id uuid);
    CREATE TABLE public.area_buildings(area_id uuid,building_id uuid,organization_id uuid);
    CREATE TABLE public.areas(id uuid,organization_id uuid,user_id uuid,name text,deleted_at timestamptz);
    CREATE TABLE public.hotlines(id uuid,user_id uuid,name text,phone_number text,is_active boolean,created_at timestamptz);
    CREATE TABLE public.building_services(building_id uuid,service_id uuid,unit_price_override numeric,is_active boolean);
    CREATE TABLE public.services(id uuid,unit_price numeric,deleted_at timestamptz,unit text,type text);
    CREATE TABLE app_private.sale_room_change_receipts(room_id uuid,organization_id uuid,actor_id uuid,response jsonb,created_at timestamptz);
    CREATE TABLE app_private.room_sale_policies_v1(id uuid,organization_id uuid,room_id uuid,starts_at timestamptz,ends_at timestamptz,cancelled_at timestamptz);
    -- Biên ghi log của bản giả.
    CREATE TABLE engine_calls(case_id uuid,kind text,payload jsonb);
    CREATE TABLE commission_calls(contract_id uuid,kind text,amount numeric,recipient text,description text);
    CREATE TABLE reason_calls(contract_id uuid,kind text,stage text,baseline jsonb);

    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT ARRAY['${org}'::uuid] $$;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY[]::uuid[] $$;
    CREATE FUNCTION public.org_today_v1(uuid DEFAULT NULL) RETURNS date LANGUAGE sql STABLE AS $$ SELECT '2026-11-24'::date $$;
    CREATE FUNCTION public.can_do_on_building(text,text,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
    CREATE FUNCTION public.room_has_holding_deposit(p_room_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT coalesce(current_setting('test.deposit_room',true),'')=p_room_id::text $$;
    CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;
    CREATE FUNCTION app_private.assert_contract_exit_writer_v1(uuid,uuid) RETURNS void LANGUAGE plpgsql AS $$
      BEGIN IF coalesce(current_setting('test.deny_edit',true),'')='yes' THEN RAISE EXCEPTION 'Missing contracts.edit permission' USING ERRCODE='42501'; END IF; END $$;
    CREATE FUNCTION app_private.has_building_perm_v1(p_building_id uuid,VARIADIC p_permission_keys text[]) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT coalesce(current_setting('test.deny_terminate',true),'')<>'yes' $$;
    CREATE FUNCTION app_private.require_building_perm_v1(p_building_id uuid,p_viec text,VARIADIC p_permission_keys text[]) RETURNS void LANGUAGE plpgsql AS $$
      BEGIN IF NOT app_private.has_building_perm_v1(p_building_id,VARIADIC p_permission_keys) THEN
        RAISE EXCEPTION '[THIEU_QUYEN] %',p_viec USING ERRCODE='42501'; END IF; END $$;
    CREATE FUNCTION app_private.contract_draft_scope_allowed(p_organization_id uuid,p_building_id uuid,p_action text) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT auth.uid() IS NOT NULL AND p_organization_id='${org}'::uuid AND coalesce(current_setting('test.deny_view',true),'')<>'yes' $$;
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
        INSERT INTO public.income_expenses(id,organization_id,contract_id,type,commission_kind,total_amount,notes,approval_status,code)
          SELECT v_id,c.organization_id,c.id,'EXPENSE',p_kind,p_amount,CASE WHEN coalesce(p_recipient_name,'')<>'' THEN 'Người nhận: '||p_recipient_name END,'UNAPPROVED','HH-1' FROM public.contracts c WHERE c.id=p_contract_id;
        RETURN jsonb_build_object('id',v_id); END $$;
    CREATE FUNCTION app_private.begin_commission_reason_v1(p_voucher uuid,p_contract uuid,p_kind text,p_stage text,p_reason text,p_baseline jsonb DEFAULT NULL)
      RETURNS uuid LANGUAGE sql AS $$ INSERT INTO public.reason_calls VALUES(p_contract,p_kind,p_stage,p_baseline) RETURNING gen_random_uuid() $$;
    CREATE FUNCTION app_private.authorize_commission_request_v1(uuid,uuid) RETURNS void LANGUAGE plpgsql AS $$
      BEGIN IF coalesce(current_setting('test.deny_commission',true),'')='yes' THEN RAISE EXCEPTION 'Thiếu quyền hoa hồng' USING ERRCODE='42501'; END IF; END $$;
    -- Thưởng sale từ phiếu cọc (create_sale_bonus_from_deposit_v1 nạp thân production).
    CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
    CREATE FUNCTION public.ie_all_buildings_scope(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION app_private.rent_support_legacy_deposit_bonus_v1(p_deposit uuid,p_amount numeric,p_recipient text,p_account_number text,p_bank text,
      p_voucher_date date,p_account_id uuid,p_attachments jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
      DECLARE v_id uuid:=gen_random_uuid(); BEGIN
        INSERT INTO public.income_expenses(id,organization_id,contract_id,type,commission_kind,total_amount,notes,approval_status,code)
          SELECT v_id,d.organization_id,d.contract_id,'EXPENSE','sale',p_amount,'Người nhận: '||coalesce(p_recipient,''),'UNAPPROVED','TN-1'
          FROM public.income_expenses d WHERE d.id=p_deposit;
        RETURN jsonb_build_object('id',v_id); END $$;
    CREATE FUNCTION app_private.sale_room_can_edit_v1(uuid,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
    CREATE FUNCTION app_private.sale_room_can_v1(uuid,uuid,text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
    CREATE FUNCTION app_private.sale_room_fact_key_v1(uuid,uuid) RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'k' $$;
    CREATE FUNCTION app_private.room_sale_policy_current_v1(uuid,uuid,timestamptz) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT NULL::jsonb $$;
    CREATE FUNCTION app_private.room_sale_policy_json_v1(app_private.room_sale_policies_v1,timestamptz) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
    CREATE FUNCTION app_private.room_sale_policy_active_text_v1(uuid,uuid,timestamptz) RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULL::text $$;
    CREATE FUNCTION app_private.room_sale_policy_overlay_v1(jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT $1 $$;
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
  await db.exec('SET check_function_bodies = on');
  for (const signature of Object.keys(PROD_MD5)) before[signature] = await md5Of(signature);
  await db.exec(migrationSql);
  for (const signature of Object.keys(PROD_MD5)) after[signature] = await md5Of(signature);
  await db.exec(migrationSql);
  for (const signature of Object.keys(PROD_MD5)) afterSecond[signature] = await md5Of(signature);
  // Dữ liệu chung: bốn phòng, mỗi phòng một hợp đồng cũ đang ở.
  for (let i = 0; i < 4; i++) {
    await db.query(`INSERT INTO public.rooms(id,organization_id,building_id,name,status) VALUES($1,$2,$3,$4,'OCCUPIED')`, [rooms[i], org, building, `P10${i + 1}`]);
    await db.query(`INSERT INTO public.customers VALUES($1,$2,$3,null)`, [customers[i], org, `Khách cũ ${i + 1}`]);
    await db.query(`INSERT INTO public.contracts(id,organization_id,room_id,contract_number,user_id,deposit_paid) VALUES($1,$2,$3,$4,$5,$6)`,
      [olds[i], org, rooms[i], `HD-${i + 1}`, owner, i === 1 ? 1_000_000 : 4_000_000]);
    await db.query(`INSERT INTO public.contract_customers(contract_id,customer_id,is_representative) VALUES($1,$2,true)`, [olds[i], customers[i]]);
  }
}, 60000);
afterAll(async () => { await db.close(); });
beforeEach(async () => { await db.exec('BEGIN'); await db.query(`SELECT set_config('test.actor',$1,false)`, [actor]); });
afterEach(async () => {
  await db.exec('ROLLBACK');
  await db.exec(`RESET test.deny_terminate; RESET test.deny_edit; RESET test.deny_view; RESET test.deposit_room; RESET test.deny_commission`);
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
async function confirmArgs(i: number, terms: unknown, opts: { kind?: string; mode?: string; key?: string; settlement?: unknown } = {}) {
  const updated = (await db.query<{ u: string }>('SELECT updated_at::text u FROM public.contracts WHERE id=$1', [olds[i]])).rows[0].u;
  return [org, olds[i], updated, opts.key ?? `return-key-${i}-000`, MOVE_OUT, opts.kind ?? 'EARLY_RETURN', opts.mode ?? 'DEFERRED',
    opts.settlement === undefined ? null : JSON.stringify(opts.settlement), null, NOTE, terms === null ? null : JSON.stringify(terms)];
}
async function confirm(i: number, terms: unknown, opts: { kind?: string; mode?: string; key?: string; settlement?: unknown } = {}) {
  return (await db.query<{ r: Row }>(CONFIRM, await confirmArgs(i, terms, opts))).rows[0].r;
}
async function terms(i: number): Promise<Row> {
  return (await db.query<Row>(`SELECT t.* FROM public.contract_exit_early_terms t WHERE t.contract_id=$1`, [olds[i]])).rows[0];
}
async function caseOf(i: number): Promise<Row> {
  return (await db.query<Row>('SELECT * FROM public.contract_exit_cases WHERE contract_id=$1', [olds[i]])).rows[0];
}
async function fact(i: number) {
  return (await db.query<{ status_public: string; sale_state: string }>(
    `SELECT f.status_public,f.sale_state FROM public.rooms r CROSS JOIN LATERAL app_private.room_sale_workflow_fact_v1(r.id,r.organization_id,r.status,false,30) f WHERE r.id=$1`,
    [rooms[i]])).rows[0];
}
async function newContract(i: number, opts: { start?: string; deposit?: number; total?: number } = {}): Promise<string> {
  const contractId = (await db.query<{ id: string }>(`INSERT INTO public.contracts(organization_id,room_id,contract_number,user_id,start_date,total_deposit,deposit_paid)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [org, rooms[i], `HD-MOI-${i + 1}`, owner, opts.start ?? '2026-11-21', opts.total ?? 4_000_000,
    opts.deposit ?? opts.total ?? 4_000_000])).rows[0].id;
  return contractId;
}
const FINALIZE = 'SELECT public.finalize_contract_exit_case_v1($1,$2,$3,$4,$5,$6,$7::jsonb) AS r';
async function finalizeArgs(i: number, extra: unknown[], kind = 'EARLY_RETURN', key = `settle-key-${i}-0001`) {
  const e = await caseOf(i);
  return [org, e.id, e.version, key, kind, kind === e.current_kind ? null : 'Đổi loại khi quyết toán',
    JSON.stringify({ deposit_refund: 4_000_000, extra_charges: extra })];
}
const fee = (amount: number) => ({ kind: 'BROKER_FEE', description: 'Phí môi giới (50% cọc cũ)', amount });
const SET = 'SELECT public.set_contract_exit_early_terms_v1($1,$2,$3,$4,$5,$6,$7) AS r';

describe('migration', () => {
  it('thân hàm nạp vào đúng md5 production; chạy hai lượt không đổi gì thêm; md5 sau vá đúng bản đã ghim', () => {
    expect(before).toEqual(PROD_MD5);
    expect(afterSecond).toEqual(after);
    expect(after).toEqual(AFTER_MD5);
  });

  it('mỗi điểm nối xuất hiện đúng một lần; readers vẫn STABLE; ACL đóng helper, mở RPC', async () => {
    const count = async (sig: string, marker: string) => {
      const def = (await db.query<{ d: string }>('SELECT pg_get_functiondef($1::regprocedure) d', [sig])).rows[0].d;
      return def.split(marker).length - 1;
    };
    expect(await count('public.finalize_contract_exit_case_v1(uuid,uuid,bigint,text,text,text,jsonb)', 'assert_exit_early_terms_settlement_v1(')).toBe(1);
    expect(await count('public.finalize_contract_exit_case_v1(uuid,uuid,bigint,text,text,text,jsonb)', 'assert_contract_transfer_exit_terms_v1(')).toBe(1);
    expect(await count('public.create_commission_voucher(uuid,text,numeric,date,uuid,text,text,text,text,text,jsonb)', 'assert_exit_early_commission_v1(')).toBe(1);
    expect(await count('app_private.room_sale_workflow_fact_v1(uuid,uuid,text,boolean,integer)', 'room_exit_hold_open_v1(')).toBe(1);
    expect(await count('public.get_my_available_rooms()', 'room_exit_hold_json_v1(')).toBe(1);
    expect(await count('public.get_sale_room_inventory_v1(uuid,uuid,uuid)', 'room_exit_hold_json_v1(')).toBe(1);
    expect(await count('public.real_estate_renewals_transfers_v1(uuid,uuid[],date,date)', 'FROM early x')).toBe(1);
    expect(await count('public.confirm_contract_return_v1(uuid,uuid,timestamp with time zone,text,date,text,text,jsonb,jsonb,text)', 'app.exit_early_terms_v2')).toBe(1);
    expect(await count('public.create_sale_bonus_from_deposit_v1(uuid,numeric,text,text,text,date,uuid,jsonb)', 'assert_exit_early_deposit_bonus_v1(')).toBe(1);
    const vol = (await db.query<{ proname: string; v: string }>(`SELECT proname,provolatile::text v FROM pg_proc WHERE proname IN
      ('get_my_available_rooms','get_sale_room_inventory_v1','room_sale_workflow_fact_v1','read_contract_exit_early_terms_v1','room_exit_hold_open_v1') ORDER BY 1`)).rows;
    expect(vol.every(r => r.v === 's')).toBe(true);
    const priv = (await db.query<{ helper: boolean; rpc: boolean; ins: boolean; sel: boolean }>(`SELECT
      has_function_privilege('authenticated','app_private.assert_exit_early_commission_v1(uuid,uuid,text,numeric)','EXECUTE') helper,
      has_function_privilege('authenticated','public.confirm_contract_return_v2(uuid,uuid,timestamp with time zone,text,date,text,text,jsonb,jsonb,text,jsonb)','EXECUTE') rpc,
      has_table_privilege('authenticated','public.contract_exit_early_terms','INSERT') ins,
      has_table_privilege('authenticated','public.contract_exit_early_terms','SELECT') sel`)).rows[0];
    expect(priv).toEqual({ helper: false, rpc: true, ins: false, sel: true });
    expect((await db.query('SELECT 1 FROM app_private.feature_cutovers WHERE key=$1', ['exit_early_terms'])).rows).toHaveLength(1);
  });
});

describe('confirm_contract_return_v2', () => {
  it('từ chối dữ kiện sai trước khi đụng hồ sơ', async () => {
    await rejects(CONFIRM, await confirmArgs(0, null), '22023');
    await rejects(CONFIRM, await confirmArgs(0, { early_reason: 'OTHER' }), '22023');
    await rejects(CONFIRM, await confirmArgs(0, { early_reason: 'SELF_FOUND', extra: 1 }), '22023');
    await rejects(CONFIRM, await confirmArgs(0, { early_reason: 'SALE_ASSISTED' }), '22023', /tên sale/);
    await rejects(CONFIRM, await confirmArgs(0, { early_reason: 'SELF_FOUND', sale_name: 'X' }), '22023');
    await rejects(CONFIRM, await confirmArgs(0, { early_reason: 'SELF_FOUND' }, { mode: 'IMMEDIATE', settlement: { deposit_refund: 0 } }), '22023', /quyết toán sau/);
    await rejects(CONFIRM, await confirmArgs(0, { early_reason: 'SELF_FOUND' }, { kind: 'NATURAL_EXPIRY' }), '22023');
    await rejects(CONFIRM, await confirmArgs(0, { early_reason: 'LANDLORD_AGREEMENT' }, { mode: 'IMMEDIATE', settlement: { extra_charges: [fee(1)] } }), '22023');
    expect((await db.query('SELECT 1 FROM public.contract_exit_cases')).rows).toHaveLength(0);
  });

  it('nhờ sale: ghi trả phòng, phí 50% cọc, giữ 3 ngày; gọi lặp không ghi đôi; đổi ý cùng khoá bị chặn', async () => {
    const args = await confirmArgs(0, { early_reason: 'SALE_ASSISTED', sale_name: ' Sale Minh ' });
    const r = (await db.query<{ r: Row }>(CONFIRM, args)).rows[0].r;
    const t = await terms(0);
    expect(t).toMatchObject({ early_reason: 'SALE_ASSISTED', sale_name: 'Sale Minh', version: 1, new_contract_id: null, reopened_at: null });
    expect(Number(t.broker_fee)).toBe(2_000_000);
    expect(Number(t.deposit_base)).toBe(4_000_000);
    const hours = (await db.query<{ h: number }>(`SELECT extract(epoch FROM hold_until-now())/3600 h FROM public.contract_exit_early_terms WHERE contract_id=$1`, [olds[0]])).rows[0].h;
    expect(Number(hours)).toBeGreaterThan(71.9); expect(Number(hours)).toBeLessThan(72.1);
    expect((r.early_terms as Row).hold_open).toBe(true);
    expect((await db.query<{ status: string }>('SELECT status FROM public.contracts WHERE id=$1', [olds[0]])).rows[0].status).toBe('TERMINATED');
    const replay = [...args.slice(0, 10), JSON.stringify({ early_reason: 'SALE_ASSISTED', sale_name: 'Sale Minh' })];
    expect((await db.query<{ r: Row }>(CONFIRM, replay)).rows[0].r).toEqual(r);
    expect((await db.query(`SELECT 1 FROM app_private.contract_exit_early_term_events WHERE event='CREATED'`)).rows).toHaveLength(1);
    await rejects(CONFIRM, [...args.slice(0, 10), JSON.stringify({ early_reason: 'SELF_FOUND' })], '23505');
  });

  it('v1 gọi thẳng: trả phòng trước hạn + quyết toán ngay bị chặn; DEFERRED (Hermes) và loại khác vẫn qua; dấu v2 không rò sang lời gọi sau', async () => {
    const V1 = `SELECT public.confirm_contract_return_v1($1,$2,$3,$4,$5,$6,$7,$8::jsonb,null,$9) AS r`;
    const v1Args = async (i: number, kind: string, mode: string, key: string) => {
      const updated = (await db.query<{ u: string }>('SELECT updated_at::text u FROM public.contracts WHERE id=$1', [olds[i]])).rows[0].u;
      return [org, olds[i], updated, key, MOVE_OUT, kind, mode, mode === 'IMMEDIATE' ? JSON.stringify({ deposit_refund: 4_000_000 }) : null, NOTE];
    };
    await confirm(2, { early_reason: 'LANDLORD_AGREEMENT' }, { mode: 'IMMEDIATE', settlement: { deposit_refund: 4_000_000 } });
    expect((await db.query<{ v: string | null }>(`SELECT current_setting('app.exit_early_terms_v2',true) v`)).rows[0].v ?? '').toBe('');
    await rejects(V1, await v1Args(0, 'EARLY_RETURN', 'IMMEDIATE', 'v1-direct-0001'), '22023', /Tải lại trang để chọn trường hợp/);
    await db.query(V1, await v1Args(1, 'NATURAL_EXPIRY', 'IMMEDIATE', 'v1-direct-0002'));
    await db.query(V1, await v1Args(0, 'EARLY_RETURN', 'DEFERRED', 'v1-direct-0003'));
    expect((await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.contract_exit_cases`)).rows[0].n).toBe(3);
  });

  it('phí mặc định không vượt cọc đã thu; chủ nhà hỗ trợ quyết toán ngay ghi luôn mốc đã áp phí; hết hạn hợp đồng không có dòng', async () => {
    await confirm(1, { early_reason: 'SALE_ASSISTED', sale_name: 'Sale Lan' });
    expect(Number((await terms(1)).broker_fee)).toBe(1_000_000);
    const r = await confirm(2, { early_reason: 'LANDLORD_AGREEMENT' }, { mode: 'IMMEDIATE', settlement: { deposit_refund: 4_000_000 } });
    expect((r as Row).state).toBe('FINALIZED');
    expect(await terms(2)).toMatchObject({ early_reason: 'LANDLORD_AGREEMENT', hold_until: null });
    expect((await terms(2)).fee_applied_at).not.toBeNull();
    const n = await confirm(3, null, { kind: 'NATURAL_EXPIRY' });
    expect(n.early_terms).toBeNull();
    expect(await terms(3)).toBeUndefined();
  });
});

describe('giữ phòng', () => {
  it('fact che phòng đang giữ thành rented như Lock; mở bán lại, hết hạn, chủ nhà hỗ trợ thì về free; giữ tiếp thì che lại', async () => {
    expect(await fact(0)).toEqual({ status_public: 'rented', sale_state: 'RENTED' });
    await confirm(0, { early_reason: 'SELF_FOUND' });
    await confirm(2, { early_reason: 'LANDLORD_AGREEMENT' });
    expect((await db.query<{ status: string }>('SELECT status FROM public.rooms WHERE id=$1', [rooms[0]])).rows[0].status).toBe('AVAILABLE');
    expect(await fact(0)).toEqual({ status_public: 'rented', sale_state: 'RENTED' });
    expect(await fact(2)).toEqual({ status_public: 'free', sale_state: 'READY' });
    const e = await caseOf(0);
    await db.query('SELECT public.reopen_contract_exit_hold_v1($1,$2,1,$3,null)', [org, e.id, id(901)]);
    expect(await fact(0)).toEqual({ status_public: 'free', sale_state: 'READY' });
    await db.query('SELECT public.extend_contract_exit_hold_v1($1,$2,2,$3,3,null)', [org, e.id, id(902)]);
    expect(await fact(0)).toEqual({ status_public: 'rented', sale_state: 'RENTED' });
    await db.exec(`UPDATE public.contract_exit_early_terms SET hold_until=now()-interval '1 minute' WHERE contract_id='${olds[0]}'`);
    expect(await fact(0)).toEqual({ status_public: 'free', sale_state: 'READY' });
  });

  it('hai reader nội bộ vẫn trả phòng đang giữ kèm exit_hold; không thêm giá trị trạng thái mới', async () => {
    await confirm(0, { early_reason: 'SALE_ASSISTED', sale_name: 'Sale Minh' });
    const inventory = (await db.query<{ r: { rooms: Row[] } }>('SELECT public.get_sale_room_inventory_v1($1,null,null) r', [org])).rows[0].r;
    const held = inventory.rooms.find(room => room.id === rooms[0])!;
    expect(held).toMatchObject({ status_public: 'rented', sale_state: 'RENTED', sale_lock: null });
    expect(held.exit_hold).toMatchObject({ early_reason: 'SALE_ASSISTED', sale_name: 'Sale Minh', old_customer_name: 'Khách cũ 1',
      old_contract_number: 'HD-1', recorded_by_name: 'Người ghi A', recorded_by_me: true, active: true, can_manage: true, version: 1,
      exit_case_id: (await caseOf(0)).id });
    expect(inventory.rooms.find(room => room.id === rooms[1])!.exit_hold).toBeNull();
    await db.query(`SELECT set_config('test.actor',$1,false)`, [owner]);
    const mine = (await db.query<{ r: { rooms: Row[]; buildings: Row[] } }>('SELECT public.get_my_available_rooms() r')).rows[0].r;
    expect(mine.buildings.map(b => b.id)).toEqual([building]);
    expect(mine.rooms.find(room => room.id === rooms[0])).toMatchObject({ status_public: 'rented', exit_hold: { recorded_by_me: false } });
    const states = new Set(inventory.rooms.map(room => room.status_public));
    expect([...states].every(s => ['free', 'soon', 'rented', 'pass'].includes(String(s)))).toBe(true);
  });
});

describe('tự nối hợp đồng mới', () => {
  it('hợp đồng mới đầu tiên của phòng nối với hồ sơ chờ; bắt đầu trước ngày trả phòng hoặc đã mở bán lại thì không', async () => {
    await confirm(0, { early_reason: 'SALE_ASSISTED', sale_name: 'Sale Minh' });
    await confirm(1, { early_reason: 'SALE_ASSISTED', sale_name: 'Sale Lan' });
    const early = await newContract(1, { start: '2026-11-19' });
    expect((await terms(1)).new_contract_id).toBeNull();
    await db.exec(`DELETE FROM public.contracts WHERE id='${early}'`);
    const e1 = await caseOf(1);
    await db.query('SELECT public.reopen_contract_exit_hold_v1($1,$2,1,$3,$4)', [org, e1.id, id(903), 'Khách nhận huỷ']);
    await newContract(1);
    expect((await terms(1)).new_contract_id).toBeNull();
    const first = await newContract(0);
    const t = await terms(0);
    expect(t).toMatchObject({ new_contract_id: first, version: 2 });
    expect(t.linked_at).not.toBeNull();
    expect(await fact(0)).toEqual({ status_public: 'rented', sale_state: 'RENTED' });
    const events = (await db.query<{ event: string }>(`SELECT event FROM app_private.contract_exit_early_term_events WHERE exit_case_id=$1 ORDER BY event_order`, [t.exit_case_id])).rows;
    expect(events.map(e => e.event)).toEqual(['CREATED', 'NEW_CONTRACT_LINKED']);
    await db.exec(`UPDATE public.contracts SET status='TERMINATED' WHERE id='${first}'`);
    await newContract(0, { start: '2026-12-01' });
    expect((await terms(0)).new_contract_id).toBe(first);
    expect((await db.query(`SELECT 1 FROM public.contract_commission_events`)).rows).toHaveLength(0);
  });

  it('ca tự tìm: hợp đồng khách nhận ghi "không áp dụng" cho cả hoa hồng môi giới và thưởng sale', async () => {
    await confirm(0, { early_reason: 'SELF_FOUND' });
    const contractId = await newContract(0);
    const latest = (await db.query<{ kind: string; action: string; actor_id: string }>(`SELECT k.kind,l.action,l.actor_id FROM (VALUES('broker'),('sale')) k(kind)
      CROSS JOIN LATERAL app_private.contract_commission_latest_event_v1($1,$2,k.kind) l ORDER BY 1`, [org, contractId])).rows;
    expect(latest).toEqual([{ kind: 'broker', action: 'NOT_APPLICABLE', actor_id: actor }, { kind: 'sale', action: 'NOT_APPLICABLE', actor_id: actor }]);
  });
});

describe('kiểm quyết toán (bước 7)', () => {
  it('hồ sơ trước hạn tạo sau mốc mà chưa chọn trường hợp bị từ chối; hồ sơ tạo trước mốc thì không bị ép', async () => {
    const updated = (await db.query<{ u: string }>('SELECT updated_at::text u FROM public.contracts WHERE id=$1', [olds[0]])).rows[0].u;
    await db.query(`SELECT public.confirm_contract_return_v1($1,$2,$3,'hermes-key-0001',$4,'EARLY_RETURN','DEFERRED',null,null,$5)`, [org, olds[0], updated, MOVE_OUT, NOTE]);
    await rejects(FINALIZE, await finalizeArgs(0, []), '55000', /chưa chọn trường hợp/);
    await db.exec(`UPDATE public.contract_exit_cases SET created_at=(SELECT at FROM app_private.feature_cutovers WHERE key='exit_early_terms')-interval '1 day' WHERE contract_id='${olds[0]}'`);
    await rejects(FINALIZE, await finalizeArgs(0, [fee(100)]), '22023', /phí môi giới/);
    await db.query(FINALIZE, await finalizeArgs(0, []));
    expect((await caseOf(0)).state).toBe('FINALIZED');
  });

  it('nhờ sale: chặn khi chưa có hợp đồng mới, khi đổi khỏi trước hạn, khi thiếu/trùng/sai dòng phí; đúng thì qua và ghi mốc đã áp phí', async () => {
    await confirm(0, { early_reason: 'SALE_ASSISTED', sale_name: 'Sale Minh' });
    await rejects(FINALIZE, await finalizeArgs(0, [fee(2_000_000)]), '55000', /Chưa có hợp đồng của khách nhận/);
    await newContract(0);
    await rejects(FINALIZE, await finalizeArgs(0, [fee(2_000_000)], 'FORFEIT'), '55000', /chỉ quyết toán theo Trả phòng trước hạn/);
    await rejects(FINALIZE, await finalizeArgs(0, []), '22023', /đúng một dòng phí môi giới/);
    await rejects(FINALIZE, await finalizeArgs(0, [fee(2_000_000), fee(2_000_000)]), '22023', /đúng một dòng phí môi giới/);
    await rejects(FINALIZE, await finalizeArgs(0, [fee(1_999_999)]), '22023', /đúng một dòng phí môi giới/);
    await rejects(FINALIZE, await finalizeArgs(0, [{ ...fee(0), amount: 'x' }]), '22023');
    expect((await db.query('SELECT 1 FROM engine_calls')).rows).toHaveLength(0);
    await db.query(FINALIZE, await finalizeArgs(0, [fee(2_000_000)]));
    const t = await terms(0);
    expect(t.fee_applied_at).not.toBeNull();
    expect((await db.query<{ payload: Row }>('SELECT payload FROM engine_calls')).rows[0].payload).toMatchObject({ extra_charges: [fee(2_000_000)] });
    const events = (await db.query<{ event: string }>(`SELECT event FROM app_private.contract_exit_early_term_events WHERE exit_case_id=$1 ORDER BY event_order`, [t.exit_case_id])).rows;
    expect(events.map(e => e.event)).toEqual(['CREATED', 'NEW_CONTRACT_LINKED', 'FEE_APPLIED']);
  });

  it('trường hợp khác mà có dòng phí môi giới bị chặn; không có thì qua; phí lớn hơn cọc đã thu thì PT409', async () => {
    await confirm(0, { early_reason: 'SELF_FOUND' });
    await confirm(2, { early_reason: 'LANDLORD_AGREEMENT' });
    await newContract(0);
    await rejects(FINALIZE, await finalizeArgs(0, [fee(2_000_000)]), '22023', /chỉ dùng cho trường hợp nhờ sale/);
    await rejects(FINALIZE, await finalizeArgs(2, [fee(2_000_000)]), '22023', /chỉ dùng cho trường hợp nhờ sale/);
    await db.query(FINALIZE, await finalizeArgs(0, []));
    await db.query(FINALIZE, await finalizeArgs(2, [], 'NATURAL_EXPIRY'));
    await confirm(1, { early_reason: 'SALE_ASSISTED', sale_name: 'Sale Lan' });
    await newContract(1);
    await db.exec(`UPDATE public.contracts SET deposit_paid=500000 WHERE id='${olds[1]}'`);
    await rejects(FINALIZE, await finalizeArgs(1, [fee(1_000_000)]), 'PT409');
  });
});

describe('hoa hồng (bước 8)', () => {
  const CREATE = `SELECT public.create_commission_voucher($1,$2,$3,'2026-11-24') r`;
  const EXIT = 'SELECT public.create_contract_exit_commission_v1($1,$2,$3,$4) r';
  it('khách nhận của ca tự tìm: chặn cả môi giới và thưởng sale', async () => {
    await confirm(0, { early_reason: 'SELF_FOUND' });
    const contractId = await newContract(0);
    await rejects(CREATE, [contractId, 'broker', 1_000_000], '55000', /không có hoa hồng/);
    await rejects(CREATE, [contractId, 'sale', 500_000], '55000', /không có hoa hồng/);
    expect((await db.query('SELECT 1 FROM commission_calls')).rows).toHaveLength(0);
  });

  it('ca nhờ sale: môi giới chỉ qua hồ sơ trả phòng, sau quyết toán, khi khách mới nộp đủ cọc; thưởng sale đi đường chung', async () => {
    await confirm(0, { early_reason: 'SALE_ASSISTED', sale_name: 'Sale Minh' });
    const contractId = await newContract(0, { total: 4_000_000, deposit: 3_000_000 });
    await rejects(CREATE, [contractId, 'broker', 2_000_000], '55000', /chỉ lập từ hồ sơ trả phòng cũ/);
    await db.query(CREATE, [contractId, 'sale', 300_000]);
    const e = await caseOf(0);
    await rejects(EXIT, [org, e.id, 2, id(910)], '55000', /sau khi có hợp đồng khách mới và đã quyết toán/);
    await db.query(FINALIZE, await finalizeArgs(0, [fee(2_000_000)]));
    await rejects(EXIT, [org, e.id, 3, id(910)], '55000', /chưa nộp đủ cọc/);
    await db.exec(`UPDATE public.contracts SET deposit_paid=4000000 WHERE id='${contractId}'`);
    await rejects(EXIT, [org, e.id, 2, id(910)], 'PT409');
    const r = (await db.query<{ r: Row }>(EXIT, [org, e.id, 3, id(910)])).rows[0].r;
    expect(r).toMatchObject({ version: 4, commission_code: 'HH-1', commission_approval_status: 'UNAPPROVED' });
    expect((await db.query<{ r: Row }>(EXIT, [org, e.id, 3, id(910)])).rows[0].r).toEqual(r);
    await rejects('SELECT public.create_contract_exit_commission_v1($1,$2,$3,$4,$5) r', [org, e.id, 3, id(910), id(77)], '23505');
    const calls = (await db.query<Row>(`SELECT contract_id,kind,amount::float8 amount,recipient FROM commission_calls WHERE kind='broker'`)).rows;
    expect(calls).toEqual([{ contract_id: contractId, kind: 'broker', amount: 2_000_000, recipient: 'Sale Minh' }]);
    expect((await db.query<{ stage: string; baseline: Row }>(`SELECT stage,baseline FROM reason_calls WHERE kind='broker'`)).rows[0])
      .toMatchObject({ stage: 'CREATE_TRANSFER', baseline: { source: 'EXIT_EARLY_TERMS', submitted_amount: 2_000_000, requires_reason: false } });
    expect((await db.query('SELECT 1 FROM app_private.contract_exit_commission_authorizations')).rows).toHaveLength(0);
  });

  it('đã có phiếu môi giới trên hợp đồng khách nhận: đúng số và người nhận thì nối, lệch thì dừng, không tạo trùng', async () => {
    await confirm(0, { early_reason: 'SALE_ASSISTED', sale_name: 'Sale Minh' });
    const contractId = await newContract(0);
    const e = await caseOf(0);
    await db.query(FINALIZE, await finalizeArgs(0, [fee(2_000_000)]));
    await db.query(`INSERT INTO public.income_expenses(organization_id,contract_id,type,commission_kind,total_amount,notes,approval_status,code)
      VALUES($1,$2,'EXPENSE','broker',1000000,'Người nhận: Sale Minh','UNAPPROVED','HH-9')`, [org, contractId]);
    await rejects(EXIT, [org, e.id, 3, id(914)], '55000', /khác số tiền hoặc người nhận/);
    await db.exec(`UPDATE public.income_expenses SET total_amount=2000000,notes='Người nhận: Sale Khác' WHERE code='HH-9'`);
    await rejects(EXIT, [org, e.id, 3, id(914)], '55000', /khác số tiền hoặc người nhận/);
    // Tên sale là phần đầu của người nhận khác ("Sale Minh Anh") không được coi là khớp.
    await db.exec(`UPDATE public.income_expenses SET notes='Người nhận: Sale Minh Anh' WHERE code='HH-9'`);
    await rejects(EXIT, [org, e.id, 3, id(914)], '55000', /khác số tiền hoặc người nhận/);
    await db.exec(`UPDATE public.income_expenses SET notes='Người nhận: Sale Minh' WHERE code='HH-9'`);
    await db.exec(`SELECT set_config('test.deny_commission','yes',true)`);
    await rejects(EXIT, [org, e.id, 3, id(914)], '42501');
    await db.exec(`RESET test.deny_commission`);
    const r = (await db.query<{ r: Row }>(EXIT, [org, e.id, 3, id(914)])).rows[0].r;
    expect(r).toMatchObject({ commission_code: 'HH-9', version: 4, commission_live: true });
    expect((await db.query('SELECT 1 FROM commission_calls')).rows).toHaveLength(0);
  });

  it('phiếu môi giới đã nối bị huỷ hoặc xoá thì lập lại được phiếu mới; phiếu còn sống thì không thay', async () => {
    await confirm(0, { early_reason: 'SALE_ASSISTED', sale_name: 'Sale Minh' });
    await newContract(0);
    const e = await caseOf(0);
    await db.query(FINALIZE, await finalizeArgs(0, [fee(2_000_000)]));
    const first = (await db.query<{ r: Row }>(EXIT, [org, e.id, 3, id(920)])).rows[0].r;
    expect(first).toMatchObject({ version: 4, commission_live: true });
    await rejects(`UPDATE public.contract_exit_early_terms SET commission_voucher_id=NULL WHERE exit_case_id=$1`, [e.id], '42501');
    expect((await db.query<{ r: Row }>(EXIT, [org, e.id, 4, id(921)])).rows[0].r).toMatchObject({ commission_voucher_id: first.commission_voucher_id });
    await db.query(`UPDATE public.income_expenses SET approval_status='CANCELLED' WHERE id=$1`, [first.commission_voucher_id]);
    expect((await db.query<{ r: Row }>('SELECT public.read_contract_exit_early_terms_v1($1,NULL,$2,NULL) r', [org, e.id])).rows[0].r)
      .toEqual([expect.objectContaining({ commission_live: false })]);
    const second = (await db.query<{ r: Row }>(EXIT, [org, e.id, 4, id(922)])).rows[0].r;
    expect(second.commission_voucher_id).not.toBe(first.commission_voucher_id);
    expect(second).toMatchObject({ version: 5, commission_live: true });
    expect((await db.query(`SELECT 1 FROM commission_calls WHERE kind='broker'`)).rows).toHaveLength(2);
  });

  it('thưởng sale từ phiếu cọc: chặn khi phòng đang chờ khách tự tìm hoặc phiếu của hợp đồng khách nhận ca tự tìm; ca nhờ sale vẫn qua', async () => {
    const BONUS = `SELECT public.create_sale_bonus_from_deposit_v1($1,300000,'Sale Minh') r`;
    const deposit = async (room: string, contract: string | null) => (await db.query<{ id: string }>(`INSERT INTO public.income_expenses
      (organization_id,contract_id,room_id,building_id,type,total_amount,approval_status,code) VALUES($1,$2,$3,$4,'INCOME',4000000,'APPROVED','PT-1') RETURNING id`,
      [org, contract, room, building])).rows[0].id;
    await confirm(1, { early_reason: 'SELF_FOUND' });
    await rejects(BONUS, [await deposit(rooms[1], null)], '55000', /không có thưởng sale/);
    const receiving = await newContract(1, { total: 1_000_000 });
    await rejects(BONUS, [await deposit(rooms[1], receiving)], '55000', /không có thưởng sale/);
    await confirm(0, { early_reason: 'SALE_ASSISTED', sale_name: 'Sale Minh' });
    expect((await db.query<{ r: Row }>(BONUS, [await deposit(rooms[0], null)])).rows[0].r).toHaveProperty('id');
    expect((await db.query<{ r: Row }>(BONUS, [await deposit(rooms[3], null)])).rows[0].r).toHaveProperty('id');
  });

  it('phí 0 thì không tạo phiếu; ca khác bị từ chối', async () => {
    await confirm(0, { early_reason: 'SALE_ASSISTED', sale_name: 'Sale Minh' });
    const e = await caseOf(0);
    await db.query('SELECT public.update_contract_exit_broker_fee_v1($1,$2,1,$3,0,$4)', [org, e.id, id(911), 'Sale nhận phí trực tiếp từ khách']);
    await newContract(0);
    await db.query(FINALIZE, await finalizeArgs(0, []));
    const r = (await db.query<{ r: Row }>('SELECT public.create_contract_exit_commission_v1($1,$2,4,$3) r', [org, e.id, id(912)])).rows[0].r;
    expect(r.commission_voucher_id).toBeNull();
    expect((await db.query('SELECT 1 FROM commission_calls')).rows).toHaveLength(0);
    await confirm(2, { early_reason: 'LANDLORD_AGREEMENT' });
    const e2 = await caseOf(2);
    await rejects('SELECT public.create_contract_exit_commission_v1($1,$2,1,$3) r', [org, e2.id, id(913)], '55000');
  });
});

describe('đổi trường hợp, sửa phí, kiểm phiên bản', () => {
  it('phân loại hồ sơ ghi bằng v1 (Hermes) rồi đổi trường hợp: lý do, quyền, phiên bản, lịch sử', async () => {
    const updated = (await db.query<{ u: string }>('SELECT updated_at::text u FROM public.contracts WHERE id=$1', [olds[0]])).rows[0].u;
    await db.query(`SELECT public.confirm_contract_return_v1($1,$2,$3,'hermes-key-0002',$4,'EARLY_RETURN','DEFERRED',null,null,$5)`, [org, olds[0], updated, MOVE_OUT, NOTE]);
    const e = await caseOf(0);
    await rejects(SET, [org, e.id, 1, id(920), 'SALE_ASSISTED', 'Sale Minh', 'Phân loại sau'], 'PT409');
    await rejects(SET, [org, e.id, 0, id(920), 'SALE_ASSISTED', 'Sale Minh', '  '], '22023');
    await rejects(SET, [org, e.id, 0, id(920), 'SALE_ASSISTED', null, 'Phân loại sau'], '22023');
    await db.query(`SELECT set_config('test.deny_terminate','yes',false)`);
    await rejects(SET, [org, e.id, 0, id(920), 'SALE_ASSISTED', 'Sale Minh', 'Phân loại sau'], '42501');
    await db.query(`SELECT set_config('test.deny_terminate','',false)`);
    const contractId = await newContract(0);
    const first = (await db.query<{ r: Row }>(SET, [org, e.id, 0, id(920), 'SALE_ASSISTED', 'Sale Minh', 'Phân loại sau'])).rows[0].r;
    expect(first).toMatchObject({ early_reason: 'SALE_ASSISTED', new_contract_id: contractId, broker_fee: 2_000_000, version: 2 });
    expect((await db.query<{ r: Row }>(SET, [org, e.id, 0, id(920), 'SALE_ASSISTED', 'Sale Minh', 'Phân loại sau'])).rows[0].r).toEqual(first);
    await rejects(SET, [org, e.id, 2, id(920), 'SELF_FOUND', null, 'Khác'], '23505');
    await rejects(SET, [org, e.id, 1, id(921), 'SELF_FOUND', null, 'Khách tự tìm'], 'PT409');
    await rejects(SET, [org, e.id, 2, id(921), 'SALE_ASSISTED', 'Sale Minh', 'Không đổi'], '22023');
    const changed = (await db.query<{ r: Row }>(SET, [org, e.id, 2, id(921), 'SELF_FOUND', null, 'Khách tự tìm'])).rows[0].r;
    expect(changed).toMatchObject({ early_reason: 'SELF_FOUND', sale_name: null, broker_fee: 0, new_contract_id: contractId, version: 3 });
    const action = async () => (await db.query<{ action: string }>(`SELECT l.action FROM app_private.contract_commission_latest_event_v1($1,$2,'broker') l`, [org, contractId])).rows[0]?.action;
    expect(await action()).toBe('NOT_APPLICABLE');
    const back = (await db.query<{ r: Row }>(SET, [org, e.id, 3, id(922), 'LANDLORD_AGREEMENT', null, 'Khách nhận huỷ, chủ nhà đồng ý'])).rows[0].r;
    expect(back).toMatchObject({ early_reason: 'LANDLORD_AGREEMENT', new_contract_id: null, version: 4 });
    expect(await action()).toBe('REOPENED');
    const history = (back.history as Row[]).map(h => h.event);
    expect(history).toEqual(['CREATED', 'NEW_CONTRACT_LINKED', 'CASE_CHANGED', 'CASE_CHANGED']);
    await db.query(FINALIZE, await finalizeArgs(0, []));
    await rejects(SET, [org, e.id, 5, id(923), 'SELF_FOUND', null, 'Muộn'], '55000');
  });

  it('chọn tự tìm khi hợp đồng khách nhận đã có phiếu thưởng sale thì dừng', async () => {
    await confirm(0, { early_reason: 'SALE_ASSISTED', sale_name: 'Sale Minh' });
    const contractId = await newContract(0);
    await db.query(`SELECT public.create_commission_voucher($1,'sale',300000,'2026-11-24')`, [contractId]);
    const e = await caseOf(0);
    await rejects(SET, [org, e.id, 2, id(924), 'SELF_FOUND', null, 'Khách tự tìm'], '55000', /đã có phiếu/);
  });

  it('sửa phí: không vượt cọc đã thu, cần lý do, kiểm phiên bản; chỉ ca nhờ sale', async () => {
    await confirm(0, { early_reason: 'SALE_ASSISTED', sale_name: 'Sale Minh' });
    await confirm(2, { early_reason: 'SELF_FOUND' });
    const e = await caseOf(0);
    const FEE = 'SELECT public.update_contract_exit_broker_fee_v1($1,$2,$3,$4,$5,$6) r';
    await rejects(FEE, [org, e.id, 1, id(930), 4_000_001, 'Quá cọc'], '22023', /vượt cọc/);
    await rejects(FEE, [org, e.id, 1, id(930), 1_500_000, null], '22023');
    await rejects(FEE, [org, e.id, 7, id(930), 1_500_000, 'Thoả thuận'], 'PT409');
    const r = (await db.query<{ r: Row }>(FEE, [org, e.id, 1, id(930), 1_500_000, 'Thoả thuận lại với sale'])).rows[0].r;
    expect(r).toMatchObject({ broker_fee: 1_500_000, version: 2 });
    expect((r.history as Row[]).at(-1)).toMatchObject({ event: 'FEE_CHANGED', payload: { before: 2_000_000, after: 1_500_000 } });
    const e2 = await caseOf(2);
    await rejects(FEE, [org, e2.id, 1, id(931), 0, 'Không áp dụng'], '55000');
  });

  it('mở bán lại và giữ tiếp kiểm phiên bản, đọc theo phòng/hợp đồng, quyền đọc theo toà', async () => {
    await confirm(0, { early_reason: 'SALE_ASSISTED', sale_name: 'Sale Minh' });
    const e = await caseOf(0);
    await rejects('SELECT public.reopen_contract_exit_hold_v1($1,$2,9,$3)', [org, e.id, id(940)], 'PT409');
    await rejects('SELECT public.extend_contract_exit_hold_v1($1,$2,1,$3,0)', [org, e.id, id(941)], '22023');
    const byRoom = async () => (await db.query<{ r: Row[] }>('SELECT public.read_contract_exit_early_terms_v1($1,null,null,$2) r', [org, rooms[0]])).rows[0].r;
    expect(await byRoom()).toHaveLength(1);
    await db.query('SELECT public.reopen_contract_exit_hold_v1($1,$2,1,$3)', [org, e.id, id(940)]);
    expect(await byRoom()).toHaveLength(0);
    await rejects('SELECT public.reopen_contract_exit_hold_v1($1,$2,2,$3)', [org, e.id, id(942)], '55000');
    await db.query('SELECT public.extend_contract_exit_hold_v1($1,$2,2,$3,5)', [org, e.id, id(941)]);
    expect(await byRoom()).toHaveLength(1);
    const contractId = await newContract(0);
    const byNew = (await db.query<{ r: Row[] }>('SELECT public.read_contract_exit_early_terms_v1($1,$2) r', [org, contractId])).rows[0].r;
    expect(byNew).toHaveLength(1);
    expect(byNew[0]).toMatchObject({ new_contract_id: contractId, old_contract_number: 'HD-1', pending_link: false, hold_open: false });
    await rejects('SELECT public.read_contract_exit_early_terms_v1($1,$2,$3)', [org, olds[0], e.id], '22023');
    await db.query(`SELECT set_config('test.deny_view','yes',false)`);
    await rejects('SELECT public.read_contract_exit_early_terms_v1($1,$2)', [org, olds[0]], '42501');
  });
});

describe('nhắc hết hạn giữ (cron, không JWT)', () => {
  it('nhắc người ghi đúng một lần khi hết hạn mà phòng chưa có cọc; phòng đã có cọc thì không', async () => {
    await confirm(0, { early_reason: 'SALE_ASSISTED', sale_name: 'Sale Minh' });
    await confirm(1, { early_reason: 'SELF_FOUND' });
    await db.query(`SELECT set_config('test.deposit_room',$1,false)`, [rooms[1]]);
    await db.query(`SELECT set_config('test.actor','',false)`);
    const tick = async (p: string) => (await db.query<{ r: Row }>(`SELECT app_private.exit_hold_expiry_tick_v1(now()+$1::interval) r`, [p])).rows[0].r;
    expect(await tick('1 day')).toEqual({ notified: 0, skipped: 0, failed: 0 });
    expect(await tick('4 days')).toEqual({ notified: 1, skipped: 1, failed: 0 });
    expect(await tick('5 days')).toEqual({ notified: 0, skipped: 1, failed: 0 });
    const n = (await db.query<Row>('SELECT user_id,type,channel,contract_id,metadata FROM public.notifications')).rows;
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ user_id: actor, type: 'ACTION_REQUIRED', channel: 'IN_APP', contract_id: olds[0],
      metadata: { kind: 'exit_hold_expired', url: `/contracts/${olds[0]}` } });
    const ev = (await db.query<{ event: string; actor_id: string | null }>(`SELECT event,actor_id FROM app_private.contract_exit_early_term_events WHERE event='HOLD_EXPIRED_NOTIFIED'`)).rows;
    expect(ev).toEqual([{ event: 'HOLD_EXPIRED_NOTIFIED', actor_id: null }]);
  });
});
