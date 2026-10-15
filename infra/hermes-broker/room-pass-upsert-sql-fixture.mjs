import { readFileSync } from 'node:fs';
import { setup as setupRoomPass, BUILDING, ROOM, LISTING, SCOPE, binding, extract, code } from './room-pass-sql-fixture.mjs';
import { id, USER, ORG, FOREIGN, SESSION } from '../hermes-zalo-router/private-command-fixture.mjs';

// The applied v1 room-pass fixture plus the CRM columns the canonical writer and
// the lookup need. Real candidate SQL, the real canonical writer
// (public.upsert_room_pass_listing, latest 20260629100000) and real
// can_manage_pass_listing on minimal disposable tables. CRM authorization ports
// stay synthetic, now keyed per building so one building can be allowed while
// another is not. No PostgREST/JWT/RLS or concurrent MVCC evidence.
export const upsertPath = new URL('../../supabase/migrations/20261015162454_hermes_room_pass_upsert_v1.sql', import.meta.url);
export const enablePath = new URL('../../supabase/migrations/20261015163023_hermes_room_pass_registry_enable_v1.sql', import.meta.url);
const migration = name => readFileSync(`supabase/migrations/${name}.sql`, 'utf8');
export const OWNER = id('3'), BUILDING2 = id('4'), ROOM2 = id('5'), FOREIGN_BUILDING = id('6'), FOREIGN_ROOM = id('7'), SCOPE2 = id('8');
export const ROOM3 = id('9'), CONTRACT = id('e'), CUSTOMER = '0c0c0c0c-0000-4000-8000-000000000001', PHONE = '0354058160';

export async function setupUpsert(t, { sql = readFileSync(upsertPath, 'utf8') } = {}) {
  const base = await setupRoomPass(t), { db } = base;
  await db.exec(`
    ALTER TABLE public.buildings ADD COLUMN user_id uuid,ADD COLUMN name text,ADD COLUMN code text,ADD COLUMN street_address text,ADD COLUMN is_virtual boolean NOT NULL DEFAULT false;
    ALTER TABLE public.rooms ADD COLUMN name text,ADD COLUMN code text,ADD COLUMN status text NOT NULL DEFAULT 'OCCUPIED';
    ALTER TABLE public.room_pass_listings ALTER COLUMN id SET DEFAULT gen_random_uuid(),ALTER COLUMN active SET DEFAULT true,
      ADD COLUMN contact_name text,ADD COLUMN contact_phone text,ADD COLUMN sale_policy text,ADD COLUMN pass_price numeric,ADD COLUMN avail_date date,
      ADD COLUMN contact_manager boolean NOT NULL DEFAULT false,ADD COLUMN created_by uuid,ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
    CREATE UNIQUE INDEX room_pass_listings_room_active_uniq ON public.room_pass_listings(room_id) WHERE active;
    -- Stand-in for app_private.autofill_org_strict(): organization from the room.
    CREATE FUNCTION public.fixture_listing_org() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
      IF NEW.organization_id IS NULL THEN SELECT organization_id INTO NEW.organization_id FROM public.rooms WHERE id=NEW.room_id; END IF; RETURN NEW; END$$;
    CREATE TRIGGER trg_autofill_org_strict BEFORE INSERT ON public.room_pass_listings FOR EACH ROW EXECUTE FUNCTION public.fixture_listing_org();
    CREATE TABLE public.contracts(id uuid PRIMARY KEY,room_id uuid,status text,deleted_at timestamptz);
    CREATE TABLE public.customers(id uuid PRIMARY KEY,full_name text,phone text,deleted_at timestamptz);
    CREATE TABLE public.contract_customers(contract_id uuid,customer_id uuid,is_representative boolean);
    -- CRM read scope of the pass form (owner or can_access_building) and the
    -- canonical can_do_on_building port, separate from the action decision.
    CREATE TABLE public.fixture_read_acl(building_id uuid PRIMARY KEY);
    CREATE TABLE public.fixture_manage_acl(building_id uuid PRIMARY KEY);
    CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql AS $$SELECT EXISTS(SELECT 1 FROM public.fixture_read_acl WHERE building_id=$1)$$;
    CREATE OR REPLACE FUNCTION public.can_do_on_building(text,text,uuid) RETURNS boolean LANGUAGE sql AS $$
      SELECT $1='sale_phong' AND $2='manage_pass_listings' AND EXISTS(SELECT 1 FROM public.fixture_manage_acl WHERE building_id=$3)$$;
    CREATE OR REPLACE FUNCTION app_private.authorized_scope_v3(text,uuid) RETURNS TABLE(org_wide boolean,building_ids uuid[],cashbook_ids uuid[]) LANGUAGE sql AS $$
      SELECT false,COALESCE(array_agg(building_id ORDER BY building_id) FILTER (WHERE allowed AND $1='sale_phong.manage_pass_listings' AND $2='${ORG}'::uuid),'{}'::uuid[]),'{}'::uuid[]
      FROM public.fixture_action_acl$$;
    CREATE OR REPLACE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean,authorization_version bigint,nearest_deadline timestamptz) LANGUAGE sql AS $$
      SELECT COALESCE(bool_or(allowed),false) AND $1='${USER}'::uuid AND $2='${ORG}'::uuid AND $3='sale_phong.manage_pass_listings',1::bigint,max(deadline)
      FROM public.fixture_action_acl WHERE building_id=$4$$;
    CREATE OR REPLACE FUNCTION public.get_authorization_context_v1(p_org uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('organizationId',p_org,'isOffboarded',false,
      'membershipId','${USER}','authorizationVersion',1,'permissions',jsonb_build_object('sale_phong.manage_pass_listings',COALESCE(bool_or(allowed),false))) FROM public.fixture_action_acl$$;
    UPDATE public.buildings SET user_id='${OWNER}',name='Toà 417/57 Lê Văn Thọ',code='LVT',street_address='417/57 Lê Văn Thọ';
    UPDATE public.rooms SET name='103',code='P103';
    INSERT INTO public.buildings(id,organization_id,user_id,name,code,street_address) VALUES
      ('${BUILDING2}','${ORG}','${OWNER}','Nhà Quang Trung','QT','12 Quang Trung'),
      ('${FOREIGN_BUILDING}','${FOREIGN}','${OWNER}','Toà 417/57 Lê Văn Thọ','LVT','417/57 Lê Văn Thọ');
    INSERT INTO public.rooms(id,organization_id,building_id,deleted_at,name,code,status) VALUES
      ('${ROOM2}','${ORG}','${BUILDING2}',null,'103',null,'OCCUPIED'),
      ('${ROOM3}','${ORG}','${BUILDING}',null,'1103',null,'AVAILABLE'),
      ('${FOREIGN_ROOM}','${FOREIGN}','${FOREIGN_BUILDING}',null,'103',null,'OCCUPIED');
    INSERT INTO public.fixture_action_acl VALUES(true,'${BUILDING2}',null);
    INSERT INTO public.fixture_read_acl VALUES('${BUILDING}'),('${BUILDING2}');
    INSERT INTO public.fixture_manage_acl VALUES('${BUILDING}'),('${BUILDING2}');
    INSERT INTO public.authorization_scopes VALUES('${SCOPE2}','${ORG}','BUILDING','${BUILDING2}',null,null);
    UPDATE app_private.hermes_org_policies SET scope_ids=ARRAY['${SCOPE}'::uuid,'${SCOPE2}'::uuid];
    INSERT INTO public.contracts VALUES('${CONTRACT}','${ROOM}','ACTIVE',null);
    INSERT INTO public.customers VALUES('${CUSTOMER}','Nguyễn Duẩn','${PHONE}',null),('${id('f')}','Khách phụ','0911111111',null);
    INSERT INTO public.contract_customers VALUES('${CONTRACT}','${id('f')}',false),('${CONTRACT}','${CUSTOMER}',true);
  `);
  const writer = migration('20260629100000_room_pass_listings_contact_manager');
  await db.exec(extract(writer, 'public.upsert_room_pass_listing'));
  await db.exec(extract(migration('20261014081902_hermes_domain_reads_v1'), 'app_private.hermes_domain_text_v1'));
  await db.exec(sql); await db.exec(sql);
  async function call(operation, input, b = binding, role = 'authenticated', actor = USER) {
    await db.exec('BEGIN');
    await db.query("SELECT set_config('request.jwt.claim.role',$1,true),set_config('request.jwt.claim.sub',$2,true),set_config('request.jwt.claim.session',$3,true)", [role, actor, SESSION]);
    await db.exec(`SET LOCAL ROLE ${role}`);
    try {
      const result = (await db.query('SELECT public.hermes_room_pass_upsert_v1($1::jsonb,$2::text,$3::jsonb) result', [JSON.stringify(b), operation, JSON.stringify(input)])).rows[0].result;
      await db.exec('COMMIT'); return result;
    } catch (error) { await db.exec('ROLLBACK'); throw error; } finally { await db.exec('RESET ROLE'); }
  }
  const count = async table => (await db.query(`SELECT count(*)::integer n FROM ${table}`)).rows[0].n;
  return { ...base, call, count };
}

export { BUILDING, ROOM, LISTING, SCOPE, binding, code };
