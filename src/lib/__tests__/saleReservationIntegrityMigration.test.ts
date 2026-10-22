// Local PGlite fixture. Authorization primitives and money posting are synthetic; writer bodies are real.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Lock tạm + tên khách gợi nhớ (chủ chốt 10/10/2026) chạy trên đúng chuỗi forward đang ở production:
// sale facts 0928 → giữ chỗ 0928 → chính sách sale 1010 → migration này (hai lượt để kiểm idempotent).
const files = [
  'supabase/migrations/20260928021213_room_sale_workflow_facts.sql',
  'supabase/migrations/20260928025848_room_reservation_workflow.sql',
  'supabase/migrations/20261010022101_public_room_sale_policy.sql',
];
const lockSql = readFileSync('supabase/migrations/20261010114500_giu_cho_ten_goi_nho_va_lock_tam_phong.sql', 'utf8');
// Nối tiếp: chỉ đổi câu báo của list_room_sale_locks_v1 (gate khoá-trong-hàm-STABLE báo nhầm).
const lockListMessageSql = readFileSync('supabase/migrations/20261010124153_list_room_sale_locks_cau_bao.sql', 'utf8');
// Reader trong app hiện hành: chép nguyên bản lock tạm, chỉ thêm cột Tình trạng gõ tay.
const statusNoteSql = readFileSync('supabase/migrations/20261010160612_room_sale_status_note.sql', 'utf8');

// Historical migrations below still build/replay their original schema. Reader
// assertions run the latest exact function and its real policy dependencies.
const migrationCorpus = readdirSync('supabase/migrations').filter(file => file.endsWith('.sql')).sort().reverse()
  .map(file => ({ file, sql: readFileSync(join('supabase/migrations', file), 'utf8') }));
function liveDefinitionOf(qualified: string): { file: string; sql: string } {
  const pattern = new RegExp('CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+' + qualified.replace(/\./g, '\\.')
    + '\\s*\\([\\s\\S]*?\\bAS\\s+(\\$[a-zA-Z_]*\\$)[\\s\\S]*?\\1\\s*;', 'i');
  for (const migration of migrationCorpus) {
    const match = migration.sql.match(pattern);
    if (match) return { file: migration.file, sql: match[0].replace(/^CREATE FUNCTION/i, 'CREATE OR REPLACE FUNCTION') };
  }
  throw new Error('Missing live function: ' + qualified);
}
async function installLiveSaleReader() {
  const tablePattern = /CREATE TABLE IF NOT EXISTS app_private\.room_sale_policies_v1\([\s\S]*?\n\);/;
  const table = migrationCorpus.map(migration => migration.sql.match(tablePattern)?.[0]).find(Boolean);
  if (!table) throw new Error('Missing live room policy table definition');
  await db.exec(table);
  for (const name of ['app_private.room_sale_policy_json_v1', 'app_private.room_sale_policy_current_v1',
    'app_private.room_sale_policy_active_text_v1', 'app_private.room_sale_policy_overlay_v1',
    'public.get_my_available_rooms']) {
    await db.exec(liveDefinitionOf(name).sql);
  }
}

const org = '00000000-0000-4000-8000-000000000001';
const actor = '00000000-0000-4000-8000-000000000002';
const room = '00000000-0000-4000-8000-000000000003';
const building = '00000000-0000-4000-8000-000000000004';
const customer = '00000000-0000-4000-8000-000000000005';
const account = '00000000-0000-4000-8000-000000000006';
const type = '00000000-0000-4000-8000-000000000007';
const manager = '00000000-0000-4000-8000-000000000008';
const stranger = '00000000-0000-4000-8000-000000000009';
const ownerRole = '00000000-0000-4000-8000-000000000010';
const db = new PGlite();
type Row = Record<string, unknown>;

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE authenticated;CREATE ROLE anon;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE SCHEMA app_private;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);INSERT INTO auth.users VALUES('${actor}'),('${manager}'),('${stranger}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('test.actor',true),''),'${actor}')::uuid $$;
    CREATE TABLE organizations(id uuid PRIMARY KEY);INSERT INTO organizations VALUES('${org}');
    CREATE TABLE profiles(id uuid PRIMARY KEY,full_name text);INSERT INTO profiles VALUES('${actor}','Sale A'),('${manager}','Quản lý B');
    CREATE TABLE permission_definitions(key text PRIMARY KEY,resource text,action text,sensitivity text,permission_domain text,scope_kinds text[],is_active boolean);
    CREATE TABLE organization_roles(id uuid PRIMARY KEY,organization_id uuid,name text,system_key text);
    INSERT INTO organization_roles VALUES('${ownerRole}','${org}','Chủ sở hữu tổ chức','TENANT_OWNER');
    CREATE TABLE role_permissions(organization_id uuid,role_id uuid,permission_key text REFERENCES permission_definitions(key),effect text,UNIQUE(organization_id,role_id,permission_key));
    CREATE TABLE staff_assignments(staff_id uuid,user_id uuid);INSERT INTO staff_assignments VALUES('${manager}','${actor}');
    CREATE TABLE public_room_settings(owner_id uuid,soon_days integer,hotline_id uuid,organization_id uuid);
    CREATE TABLE public_room_share_tokens(owner_id uuid,token text,revoked boolean);
    INSERT INTO public_room_settings VALUES('${actor}',30,NULL,'${org}');INSERT INTO public_room_share_tokens VALUES('${actor}','valid-link',false);
    CREATE TABLE buildings(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,name text,code text,district text,ward text,street_address text,province text,
      total_floors integer,floor_layouts jsonb,images jsonb,public_contact_name text,public_contact_phone text,public_map_url text,public_lift_type text,is_virtual boolean,deleted_at timestamptz);
    CREATE TABLE rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,floor integer,name text,code text,area numeric,rent_price numeric,deposit_amount numeric,
      max_occupants integer,amenities jsonb,images jsonb,description text,sale_note text,sale_bonus_note text,room_type text,status text,deleted_at timestamptz);
    CREATE TABLE customers(id uuid PRIMARY KEY,organization_id uuid,full_name text,phone text,deleted_at timestamptz);
    CREATE TABLE contracts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,room_id uuid,status text,start_date date,expected_move_out_date date,end_date date,
      actual_end_date date,deleted_at timestamptz,customer_name text,created_at timestamptz DEFAULT now());
    CREATE TABLE contract_customers(contract_id uuid,customer_id uuid);
    CREATE TABLE deposits(id uuid PRIMARY KEY,room_id uuid,contract_id uuid,status text,deleted_at timestamptz,organization_id uuid);
    CREATE TABLE room_reservation_holds(id uuid PRIMARY KEY,room_id uuid,status text,expires_at timestamptz,held_by uuid,contract_id uuid);
    CREATE TABLE room_turnovers(id uuid,organization_id uuid,room_id uuid,status text,expected_ready_on date,epoch integer,source_contract_id uuid);
    CREATE TABLE room_pass_listings(id uuid,room_id uuid,user_id uuid,active boolean,contact_manager boolean,contact_name text,contact_phone text,sale_policy text,
      pass_price numeric,avail_date date,organization_id uuid);
    CREATE TABLE areas(id uuid,user_id uuid,name text,deleted_at timestamptz,organization_id uuid);
    CREATE TABLE area_buildings(building_id uuid,area_id uuid,organization_id uuid);
    CREATE TABLE building_services(building_id uuid,service_id uuid,is_active boolean,unit_price_override numeric);
    CREATE TABLE services(id uuid,unit text,unit_price numeric,type text,deleted_at timestamptz);
    CREATE TABLE hotlines(id uuid,user_id uuid,name text,phone_number text,is_active boolean,created_at timestamptz,organization_id uuid);
    CREATE TABLE income_expense_types(id uuid PRIMARY KEY,organization_id uuid,type text,is_deposit boolean,deleted_at timestamptz);
    INSERT INTO income_expense_types VALUES('${type}','${org}','INCOME',true,NULL);
    CREATE TABLE accounts(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz,is_virtual boolean);INSERT INTO accounts VALUES('${account}','${org}',NULL,false);
    CREATE TABLE income_expenses(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,building_id uuid,room_id uuid,contract_id uuid,type text,name text,payer_name text,
      notes text,approval_status text DEFAULT 'UNAPPROVED',deleted_at timestamptz,total_amount numeric,code text DEFAULT 'PT001');
    CREATE TABLE income_expense_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),income_expense_id uuid,income_expense_type_id uuid,accounting_class text,amount numeric);
    CREATE TABLE contract_deposit_links(organization_id uuid,contract_id uuid,income_expense_id uuid);
    CREATE TABLE writer_calls(args jsonb);
    CREATE FUNCTION my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT CASE WHEN auth.uid()='${stranger}' THEN ARRAY[]::uuid[] ELSE ARRAY['${org}'::uuid] END $$;
    CREATE FUNCTION can_access_building(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT $1='${building}'::uuid AND coalesce(current_setting('test.denied',true),'')<>'yes' $$;
    CREATE FUNCTION can_do_on_building(text,text,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT can_access_building($3) $$;
    CREATE FUNCTION is_super_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;CREATE FUNCTION sandbox_org_ids() RETURNS uuid[] LANGUAGE sql AS $$ SELECT ARRAY[]::uuid[] $$;
    CREATE FUNCTION org_today_v1(uuid) RETURNS date LANGUAGE sql STABLE AS $$ SELECT '2026-09-28'::date $$;
    CREATE FUNCTION room_has_holding_deposit(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION copilot_org_scope_buildings_v1(text,uuid) RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT coalesce(array_agg(id),ARRAY[]::uuid[]) FROM buildings WHERE organization_id=$2 $$;
    CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;
    -- test.deny_keys: danh sách khoá quyền bị từ chối cho người đang gọi (phân cách dấu phẩy).
    CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean) LANGUAGE sql AS $$
      SELECT $2=ANY(my_org_ids()) AND can_access_building($4) AND EXISTS(SELECT 1 FROM permission_definitions WHERE key=$3 AND is_active)
        AND NOT ($3 = ANY(string_to_array(coalesce(current_setting('test.deny_keys',true),''),','))) $$;
    CREATE FUNCTION ie_has_deposit_item(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT EXISTS(SELECT 1 FROM income_expense_items WHERE income_expense_id=$1 AND accounting_class='DEPOSIT') $$;
    CREATE FUNCTION app_private.reservation_deposit_is_settled_v1(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
    CREATE FUNCTION app_private.reservation_settlement_basis_v1(uuid) RETURNS jsonb LANGUAGE sql AS $$
      SELECT jsonb_build_object('amount',v.total_amount,'received',v.approval_status='APPROVED','mismatch',false) FROM income_expenses v WHERE id=$1 $$;
    CREATE FUNCTION public.create_reservation_deposit_v1(uuid,numeric,text) RETURNS json LANGUAGE sql AS $$ SELECT '{}'::json $$;
    CREATE FUNCTION public.create_income_expense_v1(p_type text,p_name text,p_building_id uuid,p_room_id uuid,p_tenant_id uuid,p_contract_id uuid,p_payer_name text,
      p_receive_bank_account text,p_receive_bank_name text,p_account_id uuid,p_attachments jsonb,p_business_result_accounting boolean,p_notes text,p_voucher_date date,
      p_items jsonb,p_idempotency_key text) RETURNS income_expenses LANGUAGE plpgsql AS $$ DECLARE v income_expenses;BEGIN
      INSERT INTO writer_calls VALUES(jsonb_build_object('room',p_room_id,'payer',p_payer_name,'notes',p_notes,'key',p_idempotency_key));
      INSERT INTO income_expenses(organization_id,building_id,room_id,type,name,payer_name,notes,total_amount)
        VALUES('${org}',p_building_id,p_room_id,p_type,p_name,p_payer_name,p_notes,(p_items->0->>'unit_price')::numeric) RETURNING * INTO v;
      INSERT INTO income_expense_items(income_expense_id,income_expense_type_id,accounting_class,amount) VALUES(v.id,'${type}','DEPOSIT',v.total_amount);RETURN v;END $$;
    CREATE FUNCTION public.ie_compat_insert_v2(jsonb,jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
    CREATE FUNCTION public.create_contract_v2(p_payload jsonb,p_idempotency_key text) RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE v_org uuid:='${org}';
      v_room_id uuid:=(p_payload->'contract'->>'room_id')::uuid;v_contract_id uuid;v_response jsonb;BEGIN
      UPDATE public.room_reservation_holds
     SET status = 'EXPIRED'
       WHERE room_id = v_room_id AND status='PENDING_APPROVAL' AND expires_at<=now();
      INSERT INTO contracts(organization_id,room_id,status) VALUES(v_org,v_room_id,'ACTIVE') RETURNING id INTO v_contract_id;
      INSERT INTO contract_customers SELECT v_contract_id,(value->>'customer_id')::uuid FROM jsonb_array_elements(p_payload->'customers');
      INSERT INTO contract_deposit_links SELECT v_org,v_contract_id,(value#>>'{}')::uuid FROM jsonb_array_elements(coalesce(p_payload->'existing_deposit_voucher_ids','[]'));
      UPDATE income_expenses SET contract_id=v_contract_id WHERE id IN(SELECT (value#>>'{}')::uuid FROM jsonb_array_elements(coalesce(p_payload->'existing_deposit_voucher_ids','[]')));
      v_response := jsonb_build_object('contract',jsonb_build_object('id',v_contract_id));RETURN v_response;END $$;
    ${liveDefinitionOf('public.get_my_available_rooms').sql}
    REVOKE ALL ON FUNCTION public.get_my_available_rooms() FROM PUBLIC,anon;GRANT EXECUTE ON FUNCTION public.get_my_available_rooms() TO authenticated;
    GRANT USAGE ON SCHEMA public,app_private,auth TO anon,authenticated;
    -- Khoá quyền có sẵn ở production trước migration này.
    INSERT INTO permission_definitions VALUES('deposits.create','deposits','create','ELEVATED','TENANT',ARRAY['BUILDING'],true),
      ('deposits.edit','deposits','edit','ELEVATED','TENANT',ARRAY['BUILDING'],true),('contracts.create','contracts','create','ELEVATED','TENANT',ARRAY['BUILDING'],true);
  `);
  for (const file of files) await db.exec(readFileSync(file, 'utf8'));
  await db.exec(lockSql);
  await db.exec(lockListMessageSql);
  await db.exec(lockSql);
  await db.exec(lockListMessageSql);
  await db.exec(statusNoteSql);
  await installLiveSaleReader();
}, 30000);
beforeEach(async () => {
  await db.exec(`RESET ROLE;SELECT set_config('test.actor','',false);SELECT set_config('test.deny_keys','',false);SELECT set_config('test.denied','',false);
    DELETE FROM room_sale_locks;DELETE FROM writer_calls;DELETE FROM contract_customers;DELETE FROM contract_deposit_links;
    ALTER TABLE reservation_receipts DISABLE TRIGGER USER;DELETE FROM reservation_receipts;ALTER TABLE reservation_receipts ENABLE TRIGGER USER;
    ALTER TABLE app_private.room_reservation_history DISABLE TRIGGER USER;DELETE FROM app_private.room_reservation_history;ALTER TABLE app_private.room_reservation_history ENABLE TRIGGER USER;
    DELETE FROM room_next_claims;DELETE FROM room_reservations;DELETE FROM income_expense_items;DELETE FROM income_expenses;DELETE FROM contracts;
    DELETE FROM customers;DELETE FROM rooms;DELETE FROM buildings;
    INSERT INTO buildings(id,organization_id,user_id,name,is_virtual) VALUES('${building}','${org}','${actor}','Toà thật',false);
    -- Phòng 102 còn trống giữ toà trên danh sách, để reader vẫn trả phòng 101 khi 101 hết bán.
    INSERT INTO rooms(id,organization_id,building_id,floor,name,code,status) VALUES('${room}','${org}','${building}',1,'101','P101','AVAILABLE'),
      (gen_random_uuid(),'${org}','${building}',1,'102','P102','AVAILABLE');
    INSERT INTO customers VALUES('${customer}','${org}','Khách Thật','0900',NULL);
  `);
});
afterAll(async () => { await db.close(); });

async function as(user: string) { await db.query("SELECT set_config('test.actor',$1,false)", [user]); }
async function deny(fn: () => Promise<unknown>, code: string) {
  await expect(fn()).rejects.toMatchObject({ code });
}
async function lock(hours = 24, note: string | null = 'Khách xem tối nay') {
  return (await db.query<{ r: Row }>('SELECT lock_room_for_sale_v1($1,$2,$3,$4) r', [org, room, hours, note])).rows[0].r;
}
async function release(id: unknown) {
  return (await db.query<{ r: Row }>('SELECT release_room_sale_lock_v1($1,$2) r', [org, id])).rows[0].r;
}
async function reader(kind: 'public' | 'app' | 'zalo'): Promise<Row | undefined> {
  const sql = kind === 'public' ? "SELECT get_public_available_rooms('valid-link') p"
    : kind === 'app' ? 'SELECT get_my_available_rooms() p' : `SELECT zalo_phong_trong_cho_worker_v1('${org}') p`;
  const payload = (await db.query<{ p: { rooms: Row[] } | null }>(sql)).rows[0].p;
  return payload?.rooms.find((r) => r.id === room);
}
async function create(payload: Row, key = 'hold-key-0001') {
  return (await db.query<{ r: Row }>('SELECT create_room_reservation_v1($1,$2,$3::jsonb) r', [org, key, JSON.stringify(payload)])).rows[0].r;
}
async function assign(id: unknown, revision: number, customerId = customer, key = 'assign-key-0001') {
  return (await db.query<{ r: Row }>('SELECT assign_room_reservation_customer_v1($1,$2,$3,$4,$5) r', [org, id, revision, customerId, key])).rows[0].r;
}
const receipt = { amount: 500000, account_id: account, voucher_date: '2026-09-28', attachments: [] };

// Keep exact existing PGlite fixture above (writers/auth stubs are NOT a full DB).
// Load the current deadline RPC body, with a minimal compatible table to observe
// which source the real reservation RPCs mutate.
beforeAll(async () => {
  await db.exec(`
    CREATE TABLE reservation_hold_deadlines(
      income_expense_id uuid PRIMARY KEY, organization_id uuid, hold_until date,
      topup_due_date date, deposit_target numeric, created_by uuid, updated_at timestamptz
    );
    ALTER TABLE income_expenses ADD COLUMN voucher_date date DEFAULT '2026-09-28';
    CREATE FUNCTION ie_all_buildings_scope(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
    CREATE FUNCTION is_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
  `);
  const deadlineSql = readFileSync('supabase/migrations/20260822120000_han_bo_sung_coc_cho_phieu_giu_cho.sql', 'utf8');
  const start = deadlineSql.indexOf('CREATE OR REPLACE FUNCTION public.set_reservation_hold_terms_v1(');
  const end = deadlineSql.indexOf('$fn$;', start);
  if (start < 0 || end < 0) throw new Error('Exact deadline RPC anchors changed');
  await db.exec(deadlineSql.slice(start, end + '$fn$;'.length));
});
beforeEach(async () => { await db.exec('DELETE FROM reservation_hold_deadlines'); });

const sourceForwardSql = readFileSync('supabase/migrations/20261020183008_sale_reservation_deadline_received_scope_v1.sql','utf8');
// Mutate only the disposable fixture definition, never repository/remote SQL.
const mutations:Record<string,(sql:string)=>string>={
  pass_source:sql=>sql.replace(/IF NOT FOUND OR v_row.organization_id[\s\S]*? THEN/,'IF NOT FOUND THEN'),
  deadline_auth:sql=>sql.replace("PERFORM app_private.authorize_room_reservation_writer_v1(v_ie.organization_id,v_ie.building_id,'deposits.edit');",'NULL;'),
  terms_sync:sql=>sql.replace(/PERFORM app_private.sync_reservation_hold_terms_v1\(NEW\.(reservation_id|id)\);/g,'NULL;'),
  received_truth:sql=>sql.replace("COALESCE((basis.fact->>'received')::boolean,false)",'true'),
  parent_rls:sql=>sql.replace('AND app_private.ie_supplement_can_read_v1(v.id)','AND true'),
};
const mutant=process.env.SALE_RESERVATION_MUTATION;
const forwardSql=mutant && mutations[mutant] ? mutations[mutant](sourceForwardSql) : sourceForwardSql;
if(mutant && mutations[mutant] && forwardSql===sourceForwardSql)throw new Error(`Mutation anchor not found: ${mutant}`);
const deniedBuilding = '00000000-0000-4000-8000-000000000021';
const deniedRoom = '00000000-0000-4000-8000-000000000022';
const foreignOrg = '00000000-0000-4000-8000-000000000023';
function definition(sql:string, name:string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const match=sql.match(new RegExp(`CREATE(?: OR REPLACE)? FUNCTION ${escaped}\\([\\s\\S]*?\\bAS (\\$[a-zA-Z_]*\\$)[\\s\\S]*?\\1;`));
  if(!match) throw new Error(`Missing function ${name}`);
  return match[0].replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION');
}
beforeAll(async()=>{
  await db.exec(`
    ALTER TABLE room_pass_listings ADD COLUMN building_id uuid, ADD COLUMN created_by uuid, ADD COLUMN updated_at timestamptz;
    ALTER TABLE room_pass_listings ALTER COLUMN id SET DEFAULT gen_random_uuid();
    CREATE UNIQUE INDEX room_pass_one_active ON room_pass_listings(room_id) WHERE active;
    CREATE TABLE income_expense_postings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,voucher_id uuid,
      event_kind text,direction text,account_id uuid,voucher_amount_snapshot numeric,net_cash_effect numeric,reversal_of_id uuid);
    CREATE TABLE income_expense_posting_lines(posting_id uuid,organization_id uuid,signed_amount numeric);
    CREATE ROLE ie_detail_reader NOLOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
    GRANT authenticated TO ie_detail_reader;
    GRANT USAGE ON SCHEMA public,auth,app_private TO ie_detail_reader;
    GRANT SELECT ON income_expenses TO authenticated;
    ALTER TABLE income_expenses ENABLE ROW LEVEL SECURITY;
    CREATE POLICY fixture_voucher_select ON income_expenses FOR SELECT TO authenticated
      USING(organization_id=ANY(my_org_ids()) AND (can_access_building(building_id)
        OR current_setting('test.fund_member',true)='yes') AND coalesce(current_setting('test.withhold',true),'')<>id::text);
  `);
  await db.exec(definition(readFileSync('supabase/migrations/20260617090000_room_pass_listings.sql','utf8'),'public.can_manage_pass_listing'));
  await db.exec(definition(readFileSync('supabase/migrations/20260909172332_reservation_deposit_settlement_v1.sql','utf8'),'app_private.reservation_settlement_basis_v1'));
  await db.exec(definition(readFileSync('supabase/migrations/20260928091816_align_voucher_detail_read.sql','utf8'),'app_private.ie_supplement_can_read_v1'));
  await db.exec(`ALTER FUNCTION app_private.ie_supplement_can_read_v1(uuid) OWNER TO ie_detail_reader;
    REVOKE ALL ON FUNCTION app_private.ie_supplement_can_read_v1(uuid) FROM PUBLIC,anon,service_role;
    GRANT EXECUTE ON FUNCTION app_private.ie_supplement_can_read_v1(uuid) TO authenticated;`);
  await db.exec(forwardSql);
  await db.exec(forwardSql);
  if(mutant==='bypass_owner')await db.exec('ALTER FUNCTION app_private.ie_supplement_can_read_v1(uuid) OWNER TO postgres');
},30000);
beforeEach(async()=>{
  await db.exec(`DELETE FROM room_pass_listings;DELETE FROM income_expense_posting_lines;DELETE FROM income_expense_postings;
    SELECT set_config('test.withhold','',false);SELECT set_config('test.fund_member','',false);
    INSERT INTO buildings(id,organization_id,user_id,name,is_virtual) VALUES('${deniedBuilding}','${org}','${manager}','Toà ngoài quyền',false);
    INSERT INTO rooms(id,organization_id,building_id,name,status) VALUES('${deniedRoom}','${org}','${deniedBuilding}','201','AVAILABLE');`);
});
async function voucherOf(r:Row) {return (r.receipts as {source_voucher_id:string}[])[0].source_voucher_id;}
async function terms(id:string) {return (await db.query("SELECT hold_until::text,topup_due_date::text,deposit_target FROM reservation_hold_deadlines WHERE income_expense_id=$1",[id])).rows[0];}
async function received(ids:string[],organization=org) {return (await db.query<{r:{voucher_id:string;reservation_id:string|null;received_amount:number}[]}>('SELECT read_reservation_deposit_received_v1($1,$2) r',[organization,ids])).rows[0].r;}
async function post(id:string) {
  await db.query("UPDATE income_expenses SET approval_status='APPROVED' WHERE id=$1",[id]);
  await db.query(`WITH p AS (INSERT INTO income_expense_postings(organization_id,voucher_id,event_kind,direction,account_id,voucher_amount_snapshot,net_cash_effect)
    SELECT organization_id,id,'POSTING','INCOME',$2,total_amount,total_amount FROM income_expenses WHERE id=$1 RETURNING *)
    INSERT INTO income_expense_posting_lines SELECT id,organization_id,net_cash_effect FROM p`,[id,account]);
}
describe('sale reservation forward integrity',()=>{
  it('create, replay, topup, update and old terms writer keep every projection atomic and revisioned',async()=>{
    const payload={room_id:room,customer_id:customer,hold_until:'2026-10-10',topup_due_on:'2026-10-02',deposit_target:2000000,receipt};
    const r=await create(payload);
    const voucher=await voucherOf(r);
    expect(await terms(voucher)).toEqual({hold_until:'2026-10-10',topup_due_date:'2026-10-02',deposit_target:'2000000'});
    expect((await create(payload)).id).toBe(r.id);
    await deny(()=>create({...payload,deposit_target:3000000}),'23505');
    const topup=(await db.query<{r:Row}>(`SELECT update_room_reservation_v1($1,$2,1,'topup-test-0001','TOPUP','{}',$3) r`,[org,r.id,JSON.stringify(receipt)])).rows[0].r;
    const vouchers=[...new Set((topup.receipts as {source_voucher_id:string}[]).map(x=>x.source_voucher_id))];
    expect(vouchers).toHaveLength(2);
    for(const id of vouchers)expect(await terms(id)).toEqual(await terms(voucher));
    const wrote=(await db.query<{r:Row}>("SELECT set_reservation_hold_terms_v1($1,'2026-10-12','2026-10-04',3000000) r",[voucher])).rows[0].r;
    expect(wrote.holdUntil).toBe('2026-10-12');
    expect((await db.query<{revision:number;hold_until:string}>('SELECT revision,hold_until::text FROM room_reservations WHERE id=$1',[r.id])).rows[0]).toEqual({revision:3,hold_until:'2026-10-12'});
    for(const id of vouchers)expect(await terms(id)).toMatchObject({hold_until:'2026-10-12',topup_due_date:'2026-10-04',deposit_target:'3000000'});
    await deny(()=>db.query(`SELECT update_room_reservation_v1($1,$2,2,'stale-test-0001','UPDATE','{"hold_until":"2026-10-15"}',NULL)`,[org,r.id]),'PT409');
    await db.query('SELECT set_reservation_hold_terms_v1($1,NULL,NULL,NULL)',[voucher]);
    expect(await terms(voucher)).toBeUndefined();
    expect((await db.query<{n:number}>('SELECT count(*)::int n FROM app_private.room_reservation_history WHERE reservation_id=$1',[r.id])).rows[0].n).toBe(4);
  });
  it('denies deadline edits without deposits.edit, including unlinked legacy vouchers and foreign actors',async()=>{
    const r=await create({room_id:room,customer_id:customer,hold_until:'2026-10-01',receipt});
    const voucher=await voucherOf(r);
    await db.exec("SELECT set_config('test.deny_keys','deposits.edit',false)");
    await deny(()=>db.query("SELECT set_reservation_hold_terms_v1($1,'2026-10-06',NULL,NULL)",[voucher]),'42501');
    await db.exec('ALTER TABLE reservation_receipts DISABLE TRIGGER USER;DELETE FROM reservation_receipts;ALTER TABLE reservation_receipts ENABLE TRIGGER USER');
    await deny(()=>db.query("SELECT set_reservation_hold_terms_v1($1,'2026-10-06',NULL,NULL)",[voucher]),'42501');
    await db.exec("SELECT set_config('test.deny_keys','',false)");
    await as(stranger);
    await deny(()=>db.query("SELECT set_reservation_hold_terms_v1($1,'2026-10-06',NULL,NULL)",[voucher]),'42501');
    await as(actor);
    await db.query("SELECT set_reservation_hold_terms_v1($1,'2026-10-06',NULL,NULL)",[voucher]);
    expect(await terms(voucher)).toMatchObject({hold_until:'2026-10-06'});
  });
  it('old deadline-only RPC preserves canonical topup/target instead of stale legacy projection',async()=>{
    const r=await create({room_id:room,customer_id:customer,hold_until:'2026-10-10',topup_due_on:'2026-10-02',deposit_target:2000000,receipt});
    const voucher=await voucherOf(r);
    // Represents a pre-migration discrepancy; no bulk repair is performed.
    await db.query("UPDATE reservation_hold_deadlines SET topup_due_date='2026-10-01',deposit_target=999 WHERE income_expense_id=$1",[voucher]);
    await db.query("SELECT set_reservation_hold_deadline_v1($1,'2026-10-12')",[voucher]);
    expect(await terms(voucher)).toEqual({hold_until:'2026-10-12',topup_due_date:'2026-10-02',deposit_target:'2000000'});
    await db.exec("SELECT set_config('test.deny_keys','deposits.edit',false)");
    await deny(()=>db.query("SELECT set_reservation_hold_deadline_v1($1,'2026-10-15')",[voucher]),'42501');
  });
  it('a linked late topup keeps overdue canonical terms; unlinked voucher date validation remains strict',async()=>{
    const r=await create({room_id:room,customer_id:customer,hold_until:'2026-10-10',topup_due_on:'2026-10-02',deposit_target:2000000,receipt});
    const topup=(await db.query<{r:Row}>(`SELECT update_room_reservation_v1($1,$2,1,'late-topup-0001','TOPUP','{}',$3) r`,[org,r.id,JSON.stringify({...receipt,voucher_date:'2026-10-05'})])).rows[0].r;
    const vouchers=[...new Set((topup.receipts as {source_voucher_id:string}[]).map(x=>x.source_voucher_id))];
    const later=vouchers.find(id=>id!==(r.receipts as {source_voucher_id:string}[])[0].source_voucher_id)!;
    // Fixture money writer omits the supplied date; set that input explicitly.
    await db.query("UPDATE income_expenses SET voucher_date='2026-10-05' WHERE id=$1",[later]);
    await db.query("SELECT set_reservation_hold_terms_v1($1,'2026-10-12','2026-10-02',2000000)",[later]);
    expect(await terms(later)).toMatchObject({hold_until:'2026-10-12',topup_due_date:'2026-10-02'});
    await db.exec('ALTER TABLE reservation_receipts DISABLE TRIGGER USER;DELETE FROM reservation_receipts;ALTER TABLE reservation_receipts ENABLE TRIGGER USER');
    await deny(()=>db.query("SELECT set_reservation_hold_terms_v1($1,'2026-10-12','2026-10-02',2000000)",[later]),'23514');
  });
  it('keeps a reservation with no money deadline; target zero projects as null; failed projection rolls back create',async()=>{
    const r=await create({room_id:room,customer_id:customer,hold_until:'2026-10-01',deposit_target:0});
    expect((await db.query('SELECT * FROM reservation_hold_deadlines')).rows).toHaveLength(0);
    await deny(()=>db.query(`SELECT update_room_reservation_v1($1,$2,1,'clear-empty-0001','UPDATE','{"hold_until":null}',NULL)`,[org,r.id]),'22023');
    await db.query(`SELECT update_room_reservation_v1($1,$2,1,'topup-zero-0001','TOPUP','{}',$3)`,[org,r.id,JSON.stringify(receipt)]);
    expect((await db.query('SELECT deposit_target FROM reservation_hold_deadlines')).rows).toEqual([{deposit_target:null}]);
    const otherRoom=(await db.query<{id:string}>('SELECT id FROM rooms WHERE building_id=$1 AND id<>$2',[building,room])).rows[0].id;
    await db.exec(`CREATE FUNCTION app_private.test_reject_terms() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'fixture projection failure' USING ERRCODE='23514'; END $$;
      CREATE TRIGGER fixture_reject_terms BEFORE INSERT ON reservation_hold_deadlines FOR EACH ROW EXECUTE FUNCTION app_private.test_reject_terms();`);
    try {
      await deny(()=>create({room_id:otherRoom,customer_id:customer,hold_until:'2026-10-01',receipt},'atomic-test-0001'),'23514');
      expect((await db.query('SELECT id FROM room_reservations WHERE room_id=$1',[otherRoom])).rows).toEqual([]);
      expect((await db.query('SELECT id FROM income_expenses WHERE room_id=$1',[otherRoom])).rows).toEqual([]);
    } finally {
      await db.exec('DROP TRIGGER fixture_reject_terms ON reservation_hold_deadlines;DROP FUNCTION app_private.test_reject_terms()');
    }
  });
  it('only counts an actual matching unreversed real-account posting, never approval or draft alone',async()=>{
    const r=await create({room_id:room,customer_id:customer,hold_until:'2026-10-01',receipt});
    const voucher=await voucherOf(r);
    expect(r.received_amount).toBe(0);
    expect((await db.query<{approval_status:string}>('SELECT approval_status FROM income_expenses WHERE id=$1',[voucher])).rows[0].approval_status).toBe('UNAPPROVED');
    expect((await db.query('SELECT id FROM income_expense_postings WHERE voucher_id=$1',[voucher])).rows).toHaveLength(0);
    expect(await received([voucher])).toEqual([{voucher_id:voucher,reservation_id:r.id,received_amount:0}]);
    await db.query("UPDATE income_expenses SET approval_status='APPROVED' WHERE id=$1",[voucher]);
    expect((await received([voucher]))[0].received_amount).toBe(0);
    await post(voucher);
    expect((await received([voucher,voucher]))).toEqual([{voucher_id:voucher,reservation_id:r.id,received_amount:500000}]);
    await db.query('UPDATE accounts SET is_virtual=true WHERE id=$1',[account]);
    expect((await received([voucher]))[0].received_amount).toBe(0);
    await db.query('UPDATE accounts SET is_virtual=false WHERE id=$1',[account]);
    await db.exec('UPDATE income_expense_posting_lines SET signed_amount=499999');
    expect((await received([voucher]))[0].received_amount).toBe(0);
    await db.exec('UPDATE income_expense_posting_lines SET signed_amount=500000');
    await db.query(`INSERT INTO income_expense_postings(reversal_of_id) SELECT id FROM income_expense_postings WHERE voucher_id=$1`,[voucher]);
    expect((await received([voucher]))[0].received_amount).toBe(0);
  });
  it('reader preserves nonbypass parent RLS, fund-member visibility, org/auth and max200 cap',async()=>{
    const r=await create({room_id:room,customer_id:customer,hold_until:'2026-10-01',receipt});
    const voucher=await voucherOf(r);
    await post(voucher);
    await db.exec('SET ROLE authenticated');
    expect((await received([voucher]))[0].received_amount).toBe(500000);
    await db.query("SELECT set_config('test.withhold',$1,false)",[voucher]);
    expect(await received([voucher])).toEqual([]);
    await db.exec("SELECT set_config('test.withhold','',false);SELECT set_config('test.denied','yes',false)");
    expect(await received([voucher])).toEqual([]);
    await db.exec("SELECT set_config('test.fund_member','yes',false)");
    expect((await received([voucher]))[0].received_amount).toBe(500000);
    await deny(()=>received([voucher],foreignOrg),'42501');
    await deny(()=>received(Array(201).fill(voucher)),'22023');
    await as(stranger);
    await deny(()=>received([voucher]),'42501');
    await db.exec('RESET ROLE;SET ROLE anon');
    await deny(()=>received([voucher]),'42501');
    await db.exec('RESET ROLE');
    const role=(await db.query<{rolsuper:boolean;rolbypassrls:boolean}>(`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='ie_detail_reader'`)).rows[0];
    expect(role).toEqual({rolsuper:false,rolbypassrls:false});
    expect((await db.query<{owner:string}>(`SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid='app_private.ie_supplement_can_read_v1(uuid)'::regprocedure`)).rows[0].owner).toBe('ie_detail_reader');
    const grant=(await db.query<{write:boolean;private:boolean}>(`SELECT has_table_privilege('authenticated','reservation_hold_deadlines','UPDATE') AS write,
      has_function_privilege('authenticated','app_private.sync_reservation_hold_terms_v1(uuid)','EXECUTE') AS private`)).rows[0];
    expect(grant).toEqual({write:false,private:false});
  });
  it('pass update checks original listing scope; same-room updates and implicit upsert remain valid',async()=>{
    const listing=(await db.query<{id:string}>(`INSERT INTO room_pass_listings(room_id,user_id,building_id,organization_id,active)
      VALUES($1,$2,$3,$4,true) RETURNING id`,[deniedRoom,manager,deniedBuilding,org])).rows[0].id;
    await deny(()=>db.query("SELECT upsert_room_pass_listing($1,$2,'Stolen',NULL,NULL,NULL,true)",[listing,room]),'42501');
    await deny(()=>db.query("SELECT upsert_room_pass_listing($1,$2,'Denied',NULL,NULL,NULL,true)",[listing,deniedRoom]),'42501');
    const own=(await db.query<{r:{id:string}}>("SELECT to_jsonb(upsert_room_pass_listing(NULL,$1,'Allowed',NULL,NULL,2000000,true)) r",[room])).rows[0].r;
    const otherRoom=(await db.query<{id:string}>('SELECT id FROM rooms WHERE building_id=$1 AND id<>$2',[building,room])).rows[0].id;
    await deny(()=>db.query("SELECT upsert_room_pass_listing($1,$2,'Moved inside same scope',NULL,NULL,NULL,true)",[own.id,otherRoom]),'42501');
    expect((await db.query<{r:{id:string;contact_name:string}}>("SELECT to_jsonb(upsert_room_pass_listing(NULL,$1,'Updated',NULL,NULL,2500000,true)) r",[room])).rows[0].r).toMatchObject({id:own.id,contact_name:'Updated'});
    expect((await db.query<{room_id:string}>('SELECT room_id FROM room_pass_listings WHERE id=$1',[listing])).rows[0].room_id).toBe(deniedRoom);
    await as(stranger);
    await deny(()=>db.query("SELECT upsert_room_pass_listing($1,$2,'Wrong org',NULL,NULL,NULL,true)",[own.id,room]),'42501');
  });
});


// Existing lock behavior, now exercised after the new forward migration.
describe('lock tạm phòng khỏi danh sách bán', () => {
  it('seeds the permission for the owner role and keeps helper/RPC ACL narrow', async () => {
    expect((await db.query('SELECT permission_key FROM role_permissions WHERE role_id=$1', [ownerRole])).rows).toEqual([{ permission_key: 'sale_phong.lock_room' }]);
    const acl = (await db.query<Row>(`SELECT
      has_function_privilege('anon','lock_room_for_sale_v1(uuid,uuid,integer,text)','EXECUTE') anon_lock,
      has_function_privilege('authenticated','lock_room_for_sale_v1(uuid,uuid,integer,text)','EXECUTE') auth_lock,
      has_function_privilege('authenticated','app_private.room_sale_workflow_base_fact_v1(uuid,uuid,text,boolean,integer)','EXECUTE') auth_base,
      has_table_privilege('authenticated','room_sale_locks','SELECT') auth_table`)).rows[0];
    expect(acl).toEqual({ anon_lock: false, auth_lock: true, auth_base: false, auth_table: false });
  });

  it('hides a locked room from every sale reader and shows lock facts only in-app', async () => {
    expect(await reader('public')).toMatchObject({ status_public: 'free' });
    const l = await lock();
    expect(l).toMatchObject({ hours: 24, note: 'Khách xem tối nay', locked_by_name: 'Sale A', active: true, room_name: '101' });
    expect(Date.parse(String(l.expires_at)) - Date.parse(String(l.locked_at))).toBe(24 * 3600 * 1000);
    const pub = await reader('public');
    expect(pub).toMatchObject({ status_public: 'rented', sale_state: 'RENTED', avail_date: null });
    expect(pub).not.toHaveProperty('sale_lock');
    expect(await reader('zalo')).toBeUndefined();
    expect(await reader('app')).toMatchObject({ status_public: 'rented', sale_state: 'RENTED',
      sale_lock: { id: l.id, hours: 24, note: 'Khách xem tối nay', locked_by_name: 'Sale A', locked_by_me: true } });
    await as(manager);
    expect((await reader('app'))?.sale_lock).toMatchObject({ locked_by_me: false });
  });

  it('accepts only 6/12/24 hours, a permitted user and a room still on sale', async () => {
    await deny(() => lock(3), '22023');
    await deny(() => lock(24, 'x'.repeat(301)), '22023');
    await db.exec("SELECT set_config('test.deny_keys','sale_phong.lock_room',false)");
    await deny(() => lock(), '42501');
    await db.exec("SELECT set_config('test.deny_keys','',false)");
    await as(stranger);
    await deny(() => lock(), '42501');
    await as(actor);
    await db.exec(`UPDATE rooms SET status='OCCUPIED' WHERE id='${room}';INSERT INTO contracts(organization_id,room_id,status,start_date) VALUES('${org}','${room}','ACTIVE','2026-09-01')`);
    await deny(() => lock(), '55000');
  });

  it('replays the same click, refuses a second lock and needs no job to expire', async () => {
    const first = await lock(12);
    expect((await lock(12)).id).toBe(first.id);
    await deny(() => lock(6), '55000');
    await db.query("UPDATE room_sale_locks SET locked_at=locked_at-interval '13 hours',expires_at=expires_at-interval '13 hours' WHERE id=$1", [first.id]);
    expect(await reader('public')).toMatchObject({ status_public: 'free' });
    expect((await reader('app'))?.sale_lock).toBeNull();
    const second = await lock(6);
    expect(second.id).not.toBe(first.id);
    const closed = (await db.query<Row>('SELECT release_reason, released_at=expires_at AS at_expiry FROM room_sale_locks WHERE id=$1', [first.id])).rows[0];
    expect(closed).toEqual({ release_reason: 'EXPIRED', at_expiry: true });
  });

  it('lets the locker or a deposit creator release, idempotently', async () => {
    const l = await lock();
    await db.exec("SELECT set_config('test.deny_keys','deposits.create',false)");
    await as(manager);
    await deny(() => release(l.id), '42501');
    await as(actor);
    expect(await release(l.id)).toMatchObject({ active: false, release_reason: 'MANUAL' });
    expect(await release(l.id)).toMatchObject({ release_reason: 'MANUAL' });
    expect(await reader('public')).toMatchObject({ status_public: 'free' });
    await db.exec("SELECT set_config('test.deny_keys','',false)");
    const again = await lock();
    await as(manager);
    expect(await release(again.id)).toMatchObject({ release_reason: 'MANUAL' });
  });

  it('lists open locks read-only for the deposits screen and refuses outsiders plainly', async () => {
    const l = await lock();
    await db.exec('BEGIN READ ONLY');
    try {
      const list = (await db.query<{ r: { locks: Row[] } }>('SELECT list_room_sale_locks_v1($1) r', [org])).rows[0].r;
      expect(list.locks).toMatchObject([{ id: l.id, building_name: 'Toà thật', room_code: 'P101', active: true }]);
    } finally { await db.exec('ROLLBACK'); }
    await as(stranger);
    await expect(db.query('SELECT list_room_sale_locks_v1($1)', [org])).rejects.toMatchObject({ code: '42501', message: 'Không có quyền xem phòng đang khoá tạm trong tổ chức' });
  });

  it('a reservation on the locked room releases the lock in the same transaction', async () => {
    const l = await lock();
    await as(manager);
    const r = await create({ room_id: room, customer_id: customer, receipt });
    expect((await db.query<Row>('SELECT release_reason, reservation_id, released_by FROM room_sale_locks WHERE id=$1', [l.id])).rows[0])
      .toEqual({ release_reason: 'RESERVED', reservation_id: r.id, released_by: manager });
    expect(await reader('app')).toMatchObject({ status_public: 'rented', sale_lock: null });
  });

  it('does not badge or list a lock on a room that became occupied for another reason', async () => {
    await lock();
    expect((await db.query<{ r: { locks: Row[] } }>('SELECT list_room_sale_locks_v1($1) r', [org])).rows[0].r.locks).toHaveLength(1);
    await db.exec(`UPDATE rooms SET status='OCCUPIED' WHERE id='${room}';INSERT INTO contracts(organization_id,room_id,status,start_date) VALUES('${org}','${room}','ACTIVE','2026-09-01')`);
    expect(await reader('app')).toMatchObject({ status_public: 'rented', sale_lock: null });
    expect((await db.query<{ r: { locks: Row[] } }>('SELECT list_room_sale_locks_v1($1) r', [org])).rows[0].r.locks).toEqual([]);
  });
});
