// Archived pre-fix characterization: passing assertions reproduce gaps, NOT acceptance of correctness.
// Not an active test suite. Current regression coverage lives in
// src/lib/__tests__/saleReservationIntegrityMigration.test.ts and depositWorkQueue.test.ts.
// Historical evidence JSON deliberately retains the original .test.ts path used at audit time.
import {buildDepositWorkQueue} from '@/lib/depositWorkQueue';
import { readFileSync } from 'node:fs';
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
    CREATE FUNCTION public.get_my_available_rooms() RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$;
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

describe('audit-only evidence: reproduced gaps, not passing acceptance criteria', () => {
  it('create with deadlines writes reservation but leaves voucher deadline projection absent', async () => {
    const r = await create({
      room_id: room, customer_id: customer, hold_until: '2026-10-01',
      topup_due_on: '2026-09-30', deposit_target: 2000000, receipt,
    });
    expect(r).toMatchObject({ hold_until: '2026-10-01', topup_due_on: '2026-09-30', deposit_target: 2000000 });
    const voucher = (r.receipts as {source_voucher_id:string}[])[0].source_voucher_id;
    const projection = await db.query('SELECT h.hold_until, h.topup_due_date, h.deposit_target FROM income_expenses ie LEFT JOIN reservation_hold_deadlines h ON h.income_expense_id=ie.id WHERE ie.id=$1', [voucher]);
    expect(projection.rows).toEqual([{hold_until:null, topup_due_date:null, deposit_target:null}]);
  });

  it('updating reservation deadline leaves the existing voucher deadline unchanged', async () => {
    const r = await create({room_id:room, customer_id:customer, hold_until:'2026-10-01', receipt});
    const voucher = (r.receipts as {source_voucher_id:string}[])[0].source_voucher_id;
    await db.query("SELECT set_reservation_hold_terms_v1($1,'2026-10-01',NULL,NULL)", [voucher]);
    const changed = (await db.query<{r:Row}>("SELECT update_room_reservation_v1($1,$2,1,'audit-change-0001','UPDATE','{\"hold_until\":\"2026-10-05\"}'::jsonb,NULL) r", [org,r.id])).rows[0].r;
    expect(changed.hold_until).toBe('2026-10-05');
    const deadline = (await db.query<{deadline_day:string}>("SELECT hold_until::text AS deadline_day FROM reservation_hold_deadlines WHERE income_expense_id=$1", [voucher])).rows[0];
    expect(deadline.deadline_day).toBe('2026-10-01');
  });

  it('deadline RPC succeeds although deposits.edit and income_expenses.edit are explicitly denied in the fixture', async () => {
    const r = await create({room_id:room, customer_id:customer, hold_until:'2026-10-01', receipt});
    const voucher = (r.receipts as {source_voucher_id:string}[])[0].source_voucher_id;
    await db.exec("SELECT set_config('test.deny_keys','deposits.edit,income_expenses.edit',false)");
    expect((await db.query<{allowed:boolean}>("SELECT allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),$1,'deposits.edit',$2,NULL)", [org,building])).rows[0].allowed).toBe(false);
    const wrote = (await db.query<{r:Row}>("SELECT set_reservation_hold_terms_v1($1,'2026-10-06',NULL,NULL) r", [voucher])).rows[0].r;
    expect(wrote.holdUntil).toBe('2026-10-06');
  });

  it('unapproved topup removes shortage warning from an approved source voucher', () => {
    const base = {
      id:'v1',code:'AUDIT-1',name:'Synthetic audit deposit',payer_name:'Fixture customer',
      total_amount:2000000,voucher_date:'2026-10-01',approval_status:'APPROVED' as const,
      approval_version:1,settlement_status:'UNSETTLED' as const,settlement:null,
      building_id:'b1',building_name:'Fixture building',room_id:'r1',room_name:'101',
    };
    const terms = {v1:{holdUntil:'2026-10-30',topupDueDate:'2026-10-10',depositTarget:5000000}};
    const before = buildDepositWorkQueue({today:'2026-10-21',held:[],reservations:[base],holdTerms:terms});
    expect(before.map(g=>g.kind)).toContain('RESV_TOPUP_OVERDUE');
    const after = buildDepositWorkQueue({today:'2026-10-21',held:[],reservations:[
      base,{...base,id:'v2',code:'AUDIT-2',total_amount:3000000,approval_status:'UNAPPROVED' as const},
    ],holdTerms:terms});
    expect(after.map(g=>g.kind)).not.toContain('RESV_TOPUP_OVERDUE');
    expect(after.find(g=>g.kind==='HOLD_READY')?.tasks.some(t=>t.voucherId==='v1')).toBe(true);
    expect(after.find(g=>g.kind==='PENDING_APPROVAL')?.tasks.some(t=>t.voucherId==='v2')).toBe(true);
  });
});
