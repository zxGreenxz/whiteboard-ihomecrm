import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { splitSqlStatements } from '../network-center-function-bodies.mjs';

export const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const [org, actor, building, oldRoom, newRoom, contract, otherBuilding, otherRoom, request, owner] =
  Array.from({ length: 10 }, (_, i) => id(i + 1));
export const snapshot = '2026-01-04T12:00:00Z';
export const reason = 'Khách đổi sang phòng trống';
export const date = '2026-02-10';
export const notice = '2026-03-01';
export const migration = name => readFileSync(`supabase/migrations/${name}.sql`, 'utf8');

// Run the relevant production DDL from multi-domain migrations without installing unrelated writers.
export async function installStatements(db, name, prefixes) {
  const statements = splitSqlStatements(migration(name));
  for (const prefix of prefixes) {
    const matches = statements.filter(statement => statement.split('\n').some(line => line.startsWith(prefix)));
    assert.equal(matches.length, 1, prefix);
    await db.exec(matches[0]);
  }
}

export async function installRoomTransferFixture(db) {
  // The actor's membership and building grants are fixture data. Writers, permission guard,
  // notice cancellation, transfer history and commission audit execute their repository SQL.
  await db.exec(`
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${actor}'::uuid $$;
    CREATE TABLE organizations(id uuid PRIMARY KEY);
    CREATE TABLE profiles(id uuid PRIMARY KEY, full_name text);
    CREATE TABLE buildings(id uuid PRIMARY KEY, organization_id uuid, name text);
    CREATE TABLE rooms(id uuid PRIMARY KEY, building_id uuid, organization_id uuid, name text,
      status text, updated_at timestamptz, deleted_at timestamptz);
    CREATE TABLE contracts(id uuid PRIMARY KEY, organization_id uuid, user_id uuid, room_id uuid,
      contract_number text, status text, start_date date, end_date date, actual_end_date date, rent_price numeric, notes text,
      commission_change_reason text, expected_move_out_date date, updated_at timestamptz, deleted_at timestamptz);
    CREATE TABLE contract_transfers(contract_id uuid, user_id uuid, transfer_type text, transfer_date date,
      old_room_id uuid, new_room_id uuid, new_rent_price numeric, move_out_date date, move_in_date date,
      reason text, notes text, status text, approved_at timestamptz, approved_by uuid);
    CREATE TABLE contract_move_out_notice_events(organization_id uuid, contract_id uuid, actor_id uuid,
      previous_date date, new_date date, reason text, contract_updated_at timestamptz);
    CREATE TABLE room_next_claims(organization_id uuid,room_id uuid,status text);
    CREATE TABLE room_reservation_holds(organization_id uuid,room_id uuid,status text,contract_id uuid,expires_at timestamptz);
    CREATE TABLE room_turnovers(organization_id uuid,room_id uuid,status text,expected_ready_on date);
    CREATE TABLE room_sale_locks(id uuid DEFAULT gen_random_uuid(),organization_id uuid,room_id uuid,
      released_at timestamptz,expires_at timestamptz);
    CREATE TABLE deposit_held_rooms(room_id uuid);
    CREATE FUNCTION public.org_today_v1(uuid) RETURNS date LANGUAGE sql AS $$SELECT DATE '2026-02-20'$$;
    CREATE FUNCTION public.room_has_holding_deposit(uuid) RETURNS boolean LANGUAGE sql AS $$
      SELECT EXISTS(SELECT FROM deposit_held_rooms WHERE room_id=$1)$$;
    CREATE TABLE grants_by_building(building_id uuid, permission text, PRIMARY KEY (building_id, permission));
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql AS $$SELECT ARRAY['${org}'::uuid]$$;
    CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql AS $$SELECT '{}'::uuid[]$$;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
    CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql AS $$
      SELECT EXISTS(SELECT FROM public.grants_by_building WHERE building_id=$1)$$;
    CREATE FUNCTION public.can_do_on_building(text,text,uuid) RETURNS boolean LANGUAGE sql AS $$
      SELECT EXISTS(SELECT FROM public.grants_by_building WHERE building_id=$3 AND permission=$1||'.'||$2)$$;
    CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid)
      RETURNS TABLE(allowed boolean) LANGUAGE sql AS $$ SELECT $1=auth.uid() AND $2=ANY(public.my_org_ids())
        AND EXISTS(SELECT FROM public.grants_by_building WHERE building_id=$4 AND permission=$3) $$;
    CREATE FUNCTION app_private.authorized_scope_v3(text,uuid) RETURNS TABLE(org_wide boolean,building_ids uuid[])
      LANGUAGE sql AS $$SELECT false, ARRAY(SELECT building_id FROM public.grants_by_building WHERE permission=$1)$$;
    CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS void LANGUAGE sql AS $$
      SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0)) $$;
    INSERT INTO organizations VALUES ('${org}');
    INSERT INTO profiles VALUES ('${actor}','Người chuyển thử');
    INSERT INTO buildings VALUES ('${building}','${org}','Tòa A'), ('${otherBuilding}','${org}','Tòa B');
    INSERT INTO rooms(id,building_id,organization_id,name,status) VALUES
      ('${oldRoom}','${building}','${org}','P1','OCCUPIED'),
      ('${newRoom}','${building}','${org}','P2','AVAILABLE'),
      ('${otherRoom}','${otherBuilding}','${org}','P2','AVAILABLE');
    INSERT INTO contracts(id,organization_id,user_id,room_id,contract_number,status,start_date,end_date,
      rent_price,notes,expected_move_out_date,updated_at) VALUES
      ('${contract}','${org}','${owner}','${oldRoom}','HD-TEST','ACTIVE','2026-01-01','2026-12-31',
       150,'Ghi chú cũ','${notice}','${snapshot}');
    INSERT INTO grants_by_building VALUES ('${building}','contracts.edit'), ('${building}','contracts.transfer'),
      ('${otherBuilding}','contracts.edit'), ('${otherBuilding}','contracts.transfer');
  `);
  await installStatements(db, '20260731050000_contract_transfer_audit_hardening', [
    'CREATE OR REPLACE FUNCTION public.transfer_room(',
  ]);
  await db.exec(migration('20260928035250_contract_notice_action_adapters'));
  await installStatements(db, '20261010114500_giu_cho_ten_goi_nho_va_lock_tam_phong', [
    'CREATE OR REPLACE FUNCTION app_private.room_sale_workflow_base_fact_v1(',
    'CREATE OR REPLACE FUNCTION app_private.room_sale_lock_open_id_v1(',
    'CREATE OR REPLACE FUNCTION app_private.room_sale_workflow_fact_v1(',
  ]);
  // The October migration preserves the July core under this private name before wrapping it.
  await db.exec(`ALTER FUNCTION public.transfer_room(uuid,uuid,numeric,date,text) SET SCHEMA app_private;
    ALTER FUNCTION app_private.transfer_room(uuid,uuid,numeric,date,text) RENAME TO commission_reason_transfer_room_before_v1`);
  await installStatements(db, '20261011074456_commission_reason_audit_flow', [
    'CREATE TABLE IF NOT EXISTS app_private.commission_reason_contexts',
    'CREATE TABLE IF NOT EXISTS app_private.commission_intervention_events',
    'CREATE OR REPLACE FUNCTION app_private.commission_reason_v1(',
    'CREATE OR REPLACE FUNCTION app_private.begin_commission_reason_v1(',
    'CREATE OR REPLACE FUNCTION app_private.commission_reason_snapshot_names_v1(',
    'CREATE OR REPLACE FUNCTION app_private.append_commission_intervention_v1(',
    'CREATE OR REPLACE FUNCTION app_private.guard_commission_basis_v1(',
    'CREATE TRIGGER z98_commission_basis BEFORE UPDATE ON public.contracts',
    'CREATE OR REPLACE FUNCTION public.transfer_room(',
  ]);
  await installStatements(db, '20261021231237_chan_tu_duyet_phieu_chi_vuot_nguong_v1', [
    'CREATE OR REPLACE FUNCTION app_private.has_building_perm_v1(',
    'CREATE OR REPLACE FUNCTION app_private.require_building_perm_v1(',
  ]);
  const forward = migration('20261120083952_chuyen_phong_quyen_va_trang_thai');
  await db.exec(forward);
  await db.exec(forward);
}
