import { readFileSync } from 'node:fs';
import { setup, BUILDING, ROOM, SCOPE, REQUEST, binding, code } from './room-pass-sql-fixture.mjs';
import { USER, ORG, FOREIGN, SESSION } from '../hermes-zalo-router/private-command-fixture.mjs';
export { BUILDING, ROOM, SCOPE, REQUEST, binding, code, USER, ORG, FOREIGN };
export const saleSql = readFileSync(new URL('../../supabase/migrations/20261020183546_hermes_sale_actions_v1.sql',import.meta.url),'utf8');
export async function saleSetup(t) {
 const {db,f}=await setup(t);
 await db.exec(`
 ALTER TABLE public.rooms ADD name text DEFAULT 'P101',ADD code text DEFAULT '101';
 ALTER TABLE public.buildings ADD name text DEFAULT 'Tòa A';
 ALTER TABLE public.areas ADD name text DEFAULT 'Khu A';
 CREATE TABLE public.room_sale_locks(id uuid,organization_id uuid,room_id uuid);
 CREATE TABLE public.room_reservations(id uuid,organization_id uuid,room_id uuid);
 CREATE TABLE public.fixture_sale_writes(operation text,input jsonb);
 CREATE TABLE public.fixture_sale_acl(key text PRIMARY KEY,allowed boolean DEFAULT true,building_id uuid DEFAULT '${BUILDING}');
 INSERT INTO public.fixture_sale_acl(key) VALUES ('rooms.edit'),('sale_phong.manage_images'),('sale_phong.lock_room'),('deposits.create'),('deposits.edit'),('income_expenses.create'),('income_expenses.approve');
 CREATE OR REPLACE FUNCTION public.get_authorization_context_v1(p_org uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('organizationId',p_org,'isOffboarded',false,
 'membershipId','${USER}','authorizationVersion',1,'permissions',(SELECT jsonb_object_agg(key,allowed) FROM public.fixture_sale_acl))$$;
 CREATE OR REPLACE FUNCTION app_private.authorized_scope_v3(text,uuid) RETURNS TABLE(org_wide boolean,building_ids uuid[],cashbook_ids uuid[]) LANGUAGE sql AS $$
 SELECT false,CASE WHEN allowed AND $2='${ORG}'::uuid THEN ARRAY[building_id] ELSE '{}'::uuid[] END,'{}'::uuid[] FROM public.fixture_sale_acl WHERE key=$1$$;
 CREATE FUNCTION app_private.can_v3(text,uuid) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
 CREATE FUNCTION app_private.is_actor_offboarded_v1() RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
 CREATE FUNCTION app_private.hermes_domain_date_v2(jsonb) RETURNS date LANGUAGE sql AS $$SELECT ($1#>>'{}')::date$$;
 CREATE FUNCTION app_private.hermes_domain_text_v1(text) RETURNS text LANGUAGE sql AS $$SELECT $1$$;
 CREATE FUNCTION app_private.append_authz_audit_v1(o uuid,e text,k text,i uuid,b jsonb,m jsonb,n text) RETURNS void LANGUAGE sql AS $$INSERT INTO public.fixture_action_audit VALUES(e,m)$$;
 CREATE FUNCTION public.get_sale_room_inventory_v1(uuid,uuid,uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('rooms',jsonb_build_array(jsonb_build_object(
 'id',$3,'building_id',$2,'revision',repeat('a',32),'updated_at','2026-10-21T00:00:00Z','rent_price',3000000,'sale_note','public','sale_bonus_note','internal','images','[]'::jsonb)))$$;
 CREATE FUNCTION public.update_room_sale_info_v1(uuid,uuid,text,uuid,jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN
 IF $3<>repeat('a',32) THEN RAISE EXCEPTION 'stale' USING ERRCODE='PT409';END IF;
 INSERT INTO public.fixture_sale_writes VALUES('patch',$5);
 RETURN jsonb_build_object('room_id',$2,'building_id','${BUILDING}','request_id',$4,'revision',repeat('b',32),
 'fields',(SELECT jsonb_agg(key ORDER BY key) FROM jsonb_object_keys($5) key));END$$;
 CREATE FUNCTION public.lock_room_for_sale_v1(uuid,uuid,int,text) RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN
 INSERT INTO public.fixture_sale_writes VALUES('lock',jsonb_build_object('hours',$3));
 INSERT INTO public.room_sale_locks VALUES('${REQUEST}',$1,$2);
 RETURN jsonb_build_object('id','${REQUEST}','organization_id',$1,'building_id','${BUILDING}','room_id',$2,'active',true,'expires_at','2026-10-22T00:00:00Z');END$$;
 CREATE FUNCTION public.release_room_sale_lock_v1(uuid,uuid) RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN
 INSERT INTO public.fixture_sale_writes VALUES('release','{}');RETURN jsonb_build_object('id',$2,'organization_id',$1,'building_id','${BUILDING}','room_id','${ROOM}','active',false,'expires_at','2026-10-22T00:00:00Z');END$$;
 CREATE FUNCTION public.create_room_reservation_v1(uuid,text,jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN
 INSERT INTO public.fixture_sale_writes VALUES('reservation_create',$3);
 RETURN jsonb_build_object('id','${REQUEST}','organization_id',$1,'building_id','${BUILDING}','room_id','${ROOM}','revision',1,'status','HOLD','received_amount',0,
 'customer_phone','must never leave wrapper','receipts',jsonb_build_array(jsonb_build_object('source_voucher_id','${REQUEST}','amount',2000000,'received',false,'approval_status','APPROVED')));END$$;
 CREATE FUNCTION public.update_room_reservation_v1(uuid,uuid,bigint,text,text,jsonb,jsonb) RETURNS jsonb LANGUAGE sql AS $$SELECT public.create_room_reservation_v1($1,$4,COALESCE($7,$6))$$;
 CREATE FUNCTION public.assign_room_reservation_customer_v1(uuid,uuid,bigint,uuid,text) RETURNS jsonb LANGUAGE sql AS $$SELECT public.create_room_reservation_v1($1,$5,'{}')$$;
 UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['rooms.edit','sale_phong.manage_images','sale_phong.lock_room','deposits.create','deposits.edit','income_expenses.create','income_expenses.approve'];
 UPDATE app_private.hermes_org_policies SET action_capabilities=ARRAY['rooms.edit','sale_phong.manage_images','sale_phong.lock_room','deposits.create','deposits.edit','income_expenses.create','income_expenses.approve'];
 INSERT INTO app_private.hermes_capabilities(capability,mode,enabled) VALUES('income_expenses.create','action',true),('income_expenses.approve','action',true) ON CONFLICT(capability) DO NOTHING;
 `);
 await db.exec(saleSql);await db.exec(saleSql);
 const seeded=(await db.query("SELECT bool_and(NOT enabled) disabled FROM app_private.hermes_capabilities WHERE capability IN ('rooms.edit','sale_phong.manage_images','sale_phong.lock_room','deposits.create','deposits.edit')")).rows[0].disabled;
 await db.exec("UPDATE app_private.hermes_capabilities SET enabled=true");
 async function rpc(operation,input,b=binding,role='authenticated',actor=USER) {
  await db.exec('BEGIN');await db.query("SELECT set_config('request.jwt.claim.role',$1,true),set_config('request.jwt.claim.sub',$2,true),set_config('request.jwt.claim.session',$3,true)",[role,actor,SESSION]);
  await db.exec(`SET LOCAL ROLE ${role}`);
  try { const result=(await db.query(operation==='capabilities'?'SELECT public.hermes_sale_capabilities_v1($1::uuid) result':
    'SELECT public.hermes_sale_actions_v1($1::jsonb,$2::text,$3::jsonb) result',
    operation==='capabilities'?[ORG]:[JSON.stringify(b),operation,JSON.stringify(input)])).rows[0].result;await db.exec('COMMIT');return result;
  } catch(error){await db.exec('ROLLBACK');throw error;} finally{await db.exec('RESET ROLE');}
 }
 return{db,f,rpc,seeded};
}
