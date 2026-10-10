import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20260928021213_room_sale_workflow_facts.sql', 'utf8');
// Reader hiện hành = 0928 + chính sách sale chung (thêm khoá sale_policy, thân hàm giữ nguyên):
// mọi ca dưới đây chạy trên bản sau cùng để chứng minh migration sau không làm trôi sale facts.
const salePolicySql = readFileSync('supabase/migrations/20261010022101_public_room_sale_policy.sql', 'utf8');
// Định nghĩa sống của fact/reader trong app (lock tạm 10/10): mọi ca dưới đây chạy trên bản này.
const saleLockSql = readFileSync('supabase/migrations/20261010114500_giu_cho_ten_goi_nho_va_lock_tam_phong.sql', 'utf8');
const db = new PGlite();
const owner = '00000000-0000-4000-8000-000000000010';
const org = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const building = '00000000-0000-4000-8000-000000000011';
const room = '00000000-0000-4000-8000-000000000012';
const contract = '00000000-0000-4000-8000-000000000013';
interface Payload { buildings: unknown[]; rooms: Array<Record<string, unknown>>; contact: unknown }
async function read(kind = 'public'): Promise<Payload | null> {
  if (kind === 'copilot' || kind === 'zalo') return (await db.query<{ payload: Payload }>(
    `SELECT public.${kind === 'copilot' ? 'copilot_available_rooms_v1' : 'zalo_phong_trong_cho_worker_v1'}($1) AS payload`, [org])).rows[0].payload;
  const result = await db.query<{ payload: Payload | null }>(kind === 'public'
    ? `SELECT public.get_public_available_rooms('valid-link') AS payload`
    : `SELECT public.get_my_available_rooms() AS payload`);
  return result.rows[0].payload;
}
async function roomFact(kind = 'public') { return (await read(kind))?.rooms.find((r) => r.id === room); }
async function snapshot() {
  return (await db.query(`SELECT (SELECT jsonb_agg(to_jsonb(r)) FROM public.rooms r) rooms,
    (SELECT jsonb_agg(to_jsonb(c)) FROM public.contracts c) contracts,
    (SELECT jsonb_agg(to_jsonb(t)) FROM public.room_turnovers t) turnovers,
    (SELECT jsonb_agg(to_jsonb(m)) FROM public.money m) money`)).rows;
}

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
    CREATE SCHEMA auth;CREATE SCHEMA app_private;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('test.actor',true),'')::uuid $$;
    CREATE FUNCTION public.org_today_v1(uuid) RETURNS date LANGUAGE sql STABLE AS $$ SELECT CASE WHEN $1='${other}' THEN DATE '2026-09-29' ELSE DATE '2026-09-28' END $$;
    CREATE TABLE public.staff_assignments(staff_id uuid,user_id uuid);
    CREATE TABLE public.public_room_settings(owner_id uuid,soon_days integer,hotline_id uuid);
    CREATE TABLE public.public_room_share_tokens(owner_id uuid,token text,revoked boolean);
    CREATE TABLE public.buildings(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,name text,code text,district text,ward text,
      street_address text,province text,total_floors integer,floor_layouts jsonb,images jsonb,
      public_contact_name text,public_contact_phone text,public_map_url text,public_lift_type text,is_virtual boolean,deleted_at timestamptz);
    CREATE TABLE public.rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,floor integer,name text,code text,area numeric,
      rent_price numeric,deposit_amount numeric,max_occupants integer,amenities jsonb,images jsonb,description text,
      sale_note text,sale_bonus_note text,room_type text,status text,deleted_at timestamptz);
    CREATE TABLE public.contracts(id uuid,organization_id uuid,room_id uuid,status text,start_date date,
      expected_move_out_date date,end_date date,actual_end_date date,deleted_at timestamptz,customer_name text);
    CREATE TABLE public.room_turnovers(id uuid,organization_id uuid,room_id uuid,status text,expected_ready_on date,epoch integer,source_contract_id uuid);
    CREATE TABLE public.room_pass_listings(id uuid,room_id uuid,user_id uuid,active boolean,contact_manager boolean,
      contact_name text,contact_phone text,sale_policy text,pass_price numeric,avail_date date);
    CREATE TABLE public.holds(room_id uuid);
    CREATE TABLE public.room_next_claims(organization_id uuid,room_id uuid,status text);
    CREATE TABLE public.money(id integer PRIMARY KEY,amount numeric);
    CREATE FUNCTION public.room_has_holding_deposit(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT EXISTS(SELECT 1 FROM public.holds WHERE room_id=$1) $$;
    CREATE TABLE public.areas(id uuid,user_id uuid,name text,deleted_at timestamptz);
    CREATE TABLE public.area_buildings(building_id uuid,area_id uuid);
    CREATE TABLE public.building_services(building_id uuid,service_id uuid,is_active boolean,unit_price_override numeric);
    CREATE TABLE public.services(id uuid,unit text,unit_price numeric,type text,deleted_at timestamptz);
    CREATE TABLE public.hotlines(id uuid,user_id uuid,name text,phone_number text,is_active boolean,created_at timestamptz);
    -- Match existing authenticated reader ACL; replacement must retain it.
    CREATE FUNCTION public.get_my_available_rooms() RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$;
    REVOKE ALL ON FUNCTION public.get_my_available_rooms() FROM PUBLIC,anon;
    GRANT EXECUTE ON FUNCTION public.get_my_available_rooms() TO authenticated;
    GRANT USAGE ON SCHEMA public,app_private,auth TO anon,authenticated;
    INSERT INTO public.public_room_settings VALUES('${owner}',30,NULL);
    INSERT INTO public.public_room_share_tokens VALUES('${owner}','valid-link',false);
    INSERT INTO public.money VALUES(1,4000000);
    ALTER TABLE public.public_room_settings ADD COLUMN organization_id uuid;
    ALTER TABLE public.room_pass_listings ADD COLUMN organization_id uuid;
    ALTER TABLE public.areas ADD COLUMN organization_id uuid;
    ALTER TABLE public.area_buildings ADD COLUMN organization_id uuid;
    ALTER TABLE public.hotlines ADD COLUMN organization_id uuid;
    CREATE FUNCTION public.copilot_org_scope_buildings_v1(text,uuid) RETURNS uuid[] LANGUAGE sql STABLE AS $$
      SELECT coalesce(array_agg(id),ARRAY[]::uuid[]) FROM public.buildings WHERE organization_id=$2 AND user_id=auth.uid() $$;
  `);
  await db.exec(sql);
  await db.exec(salePolicySql);
  // Replay verifies idempotent function/ACL replacement.
  await db.exec(sql);
  await db.exec(salePolicySql);
  // Lock tạm cần các bảng giữ chỗ/quyền tối thiểu; thân hàm giữ chỗ không chạy trong file này
  // (roomSaleLockMigration.test.ts thử chúng trên đủ chuỗi) nên tắt kiểm thân hàm lúc tạo.
  await db.exec(`
    CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE TABLE public.organizations(id uuid PRIMARY KEY);
    CREATE TABLE public.profiles(id uuid PRIMARY KEY,full_name text);
    CREATE TABLE public.permission_definitions(key text PRIMARY KEY,resource text,action text,sensitivity text,permission_domain text,scope_kinds text[],is_active boolean);
    CREATE TABLE public.organization_roles(id uuid PRIMARY KEY,organization_id uuid,name text,system_key text);
    CREATE TABLE public.role_permissions(organization_id uuid,role_id uuid,permission_key text,effect text,UNIQUE(organization_id,role_id,permission_key));
    CREATE TABLE public.room_reservations(id uuid PRIMARY KEY,customer_id uuid NOT NULL);
    CREATE TABLE public.reservation_receipts(id uuid PRIMARY KEY,customer_id uuid NOT NULL);
    SET check_function_bodies = off;
  `);
  await db.exec(saleLockSql);
  await db.exec(saleLockSql);
  await db.exec('RESET check_function_bodies');
}, 20000);
beforeEach(async () => {
  await db.exec(`RESET ROLE;SELECT set_config('test.actor','${owner}',false);
    DELETE FROM public.contracts;DELETE FROM public.rooms;DELETE FROM public.buildings;
    DELETE FROM public.room_turnovers;DELETE FROM public.room_pass_listings;DELETE FROM public.holds;DELETE FROM public.room_next_claims;
    INSERT INTO public.buildings(id,organization_id,user_id,name,is_virtual) VALUES('${building}','${org}','${owner}','Toà thật',false);
    INSERT INTO public.rooms(id,organization_id,building_id,floor,name,status,sale_bonus_note) VALUES('${room}','${org}','${building}',1,'101','AVAILABLE','Private bonus');
  `);
});
afterAll(async () => { await db.close(); });

describe('actual sale reader SQL', () => {
  it('advertises valid notices equally on public and authenticated readers', async () => {
    await db.exec(`UPDATE public.rooms SET status='OCCUPIED';INSERT INTO public.contracts VALUES('${contract}','${org}','${room}','ACTIVE','2026-09-01','2026-10-01','2026-10-31',NULL,NULL,'Tenant private');`);
    for (const kind of ['public', 'app', 'copilot', 'zalo']) expect(await roomFact(kind)).toMatchObject({ status_public: 'soon', sale_state: 'NOTICE', avail_date: '2026-10-01', sale_today: '2026-09-28' });
  });
  it('keeps overdue occupied notices visible without advertising an old date', async () => {
    await db.exec(`UPDATE public.rooms SET status='OCCUPIED';INSERT INTO public.contracts VALUES('${contract}','${org}','${room}','ACTIVE','2026-09-01','2026-09-27','2026-10-01',NULL,NULL,NULL);`);
    for (const kind of ['public', 'app', 'copilot', 'zalo']) expect(await roomFact(kind)).toMatchObject({ status_public: 'soon', sale_state: 'NOTICE_OVERDUE', avail_date: null });
  });
  it('does not treat contract expiry or a future tenancy notice as confirmed availability', async () => {
    await db.exec(`UPDATE public.rooms SET status='OCCUPIED';INSERT INTO public.contracts VALUES('${contract}','${org}','${room}','ACTIVE','2026-09-01',NULL,'2026-10-01',NULL,NULL,NULL);`);
    expect((await read())?.rooms).toEqual([]);
    await db.exec(`UPDATE public.contracts SET start_date='2026-10-01',expected_move_out_date='2026-10-02';`);
    expect((await read())?.rooms).toEqual([]);
  });
  it('keeps vacant pending preparation visible with date, unknown and overdue facts', async () => {
    await db.exec(`INSERT INTO public.room_turnovers VALUES('${contract}','${org}','${room}','PENDING','2026-10-02',1,NULL);`);
    for (const day of ['2026-10-02', null, '2026-09-27']) {
      await db.query('UPDATE public.room_turnovers SET expected_ready_on=$1', [day]);
      for (const kind of ['public', 'app', 'copilot', 'zalo']) expect(await roomFact(kind)).toMatchObject({ status_public: 'free', sale_state: 'PREPARING', expected_ready_on: day });
    }
    await db.exec(`UPDATE public.room_turnovers SET status='READY';`);
    expect(await roomFact()).toMatchObject({ status_public: 'free', sale_state: 'READY', expected_ready_on: null });
  });
  it('preserves deposit and reserved blockers before any pass overlay', async () => {
    await db.exec(`INSERT INTO public.room_turnovers VALUES('${contract}','${org}','${room}','PENDING','2026-10-02',1,NULL);INSERT INTO public.holds VALUES('${room}');`);
    expect((await read())?.rooms).toEqual([]);
    await db.exec(`INSERT INTO public.room_pass_listings(id,room_id,user_id,active,contact_manager,contact_name,contact_phone) VALUES('${contract}','${room}','${owner}',true,true,'Hidden contact','0900000000');`);
    expect((await read())?.rooms).toEqual([]);
    await db.exec(`DELETE FROM public.holds;UPDATE public.rooms SET status='RESERVED';`);
    expect((await read())?.rooms).toEqual([]);
  });
  it('only exposes an active occupancy pass and drops its public contact after physical exit', async () => {
    await db.exec(`UPDATE public.rooms SET status='OCCUPIED';
      INSERT INTO public.contracts VALUES('${contract}','${org}','${room}','ACTIVE','2026-09-01',NULL,'2026-10-31',NULL,NULL,NULL);
      INSERT INTO public.room_pass_listings(id,room_id,user_id,active,contact_manager,contact_name,contact_phone) VALUES('${contract}','${room}','${owner}',true,false,'Consented contact','0900000000');`);
    expect(await roomFact()).toMatchObject({ status_public: 'pass', sale_state: 'PASS', pass_contact_name: 'Consented contact', pass_contact_phone: '0900000000' });
    await db.exec(`UPDATE public.contracts SET actual_end_date='2026-09-28';UPDATE public.rooms SET status='AVAILABLE';`);
    expect(await roomFact()).toMatchObject({ status_public: 'free', sale_state: 'READY', pass_contact_name: null, pass_contact_phone: null, pass_sale_policy: null });
    await db.exec(`UPDATE public.contracts SET actual_end_date=NULL,start_date='2026-10-01';UPDATE public.rooms SET status='OCCUPIED';`);
    expect((await read())?.rooms).toEqual([]);
  });
  it('keeps token/owner scope, tenant isolation and public projection without internal notes', async () => {
    await db.exec(`INSERT INTO public.contracts VALUES('${contract}','${other}','${room}','ACTIVE','2026-09-01','2026-09-27',NULL,NULL,NULL,'Other tenant');
      INSERT INTO public.room_turnovers VALUES('${contract}','${other}','${room}','PENDING','2026-10-01',1,NULL);`);
    const value = await roomFact();
    expect(value).toMatchObject({ sale_state: 'READY', expected_ready_on: null });
    expect(value).not.toHaveProperty('sale_bonus_note');
    expect(value).not.toHaveProperty('customer_name');
    expect(value).not.toHaveProperty('source_contract_id');
    expect(await roomFact('app')).toHaveProperty('sale_bonus_note', 'Private bonus');
    const invalid = await db.query<{ v: unknown }>(`SELECT public.get_public_available_rooms('revoked-link') v`);
    expect(invalid.rows[0].v).toBeNull();
    await db.exec(`UPDATE public.rooms SET organization_id='${other}';`);
    expect((await read())?.rooms).toEqual([]);
    await db.exec(`UPDATE public.rooms SET organization_id='${org}';UPDATE public.buildings SET user_id='${other}';`);
    expect((await read())?.rooms).toEqual([]);
  });
  it('uses room organization day and leaves money plus occupancy unchanged', async () => {
    await db.exec(`UPDATE public.buildings SET organization_id='${other}';UPDATE public.rooms SET organization_id='${other}';`);
    const before = await snapshot();
    expect(await roomFact()).toMatchObject({ sale_today: '2026-09-29' });
    await read('app');
    expect(await snapshot()).toEqual(before);
  });
  it('allows token readers for anon but denies the private helper and authenticated RPC', async () => {
    await db.exec(`SELECT set_config('test.actor','',false);SET ROLE anon;`);
    expect(await roomFact()).toMatchObject({ sale_state: 'READY' });
    await expect(read('app')).rejects.toMatchObject({ code: '42501' });
    await expect(db.query(`SELECT * FROM app_private.room_sale_workflow_fact_v1('${room}','${org}','AVAILABLE',false,30)`)).rejects.toMatchObject({ code: '42501' });
    await expect(read('copilot')).rejects.toMatchObject({ code: '42501' });
    await expect(read('zalo')).rejects.toMatchObject({ code: '42501' });
  });
  it('keeps Copilot org scope and denies worker data to authenticated callers', async () => {
    await db.exec(`SELECT set_config('test.actor','${other}',false);`);
    expect((await read('copilot'))?.rooms).toEqual([]);
    await db.exec('SET ROLE authenticated;');
    await expect(read('zalo')).rejects.toMatchObject({ code: '42501' });
  });
  it('returns the trimmed general sale policy on public, app and Zalo readers only', async () => {
    await db.exec(`RESET ROLE;UPDATE public.public_room_settings SET organization_id='${org}',sale_policy=NULL;`);
    for (const kind of ['public', 'app', 'zalo']) expect(await read(kind)).toHaveProperty('sale_policy', null);
    await db.exec(`UPDATE public.public_room_settings SET sale_policy=E'  Nước 100k/người\\nXe free  ';`);
    for (const kind of ['public', 'app', 'zalo']) expect(await read(kind)).toHaveProperty('sale_policy', 'Nước 100k/người\nXe free');
    expect(await read('copilot')).not.toHaveProperty('sale_policy');
    await db.exec(`UPDATE public.public_room_settings SET sale_policy='   ';`);
    expect(await read()).toHaveProperty('sale_policy', null);
    await expect(db.query(`UPDATE public.public_room_settings SET sale_policy=repeat('x',2001)`)).rejects.toMatchObject({ code: '23514' });
    await db.exec(`UPDATE public.public_room_settings SET sale_policy=NULL,organization_id=NULL;`);
  });
  it('hides a pure next-customer hold on every sale channel until explicitly released', async () => {
    await db.exec(`INSERT INTO public.room_next_claims VALUES('${org}','${room}','LIVE');`);
    for (const kind of ['public', 'app', 'copilot', 'zalo']) expect((await read(kind))?.rooms).toEqual([]);
    await db.exec(`UPDATE public.room_next_claims SET status='CANCELLED';`);
    for (const kind of ['public', 'app', 'copilot', 'zalo']) expect(await roomFact(kind)).toMatchObject({ sale_state: 'READY' });
    await db.exec(`UPDATE public.room_next_claims SET status='LIVE',organization_id='${other}';`);
    expect(await roomFact()).toMatchObject({ sale_state: 'READY' });
  });
});
