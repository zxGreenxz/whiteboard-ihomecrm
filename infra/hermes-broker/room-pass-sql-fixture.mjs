import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture,id,USER,ORG,FOREIGN,SESSION,CONNECTION } from '../hermes-zalo-router/private-command-fixture.mjs';
import { roomPassInput,roomPassResult,mayUseRoomPass } from './room-pass-contract.mjs';
import { createRoomPassReads } from './room-pass-adapter.mjs';
const source=name=>readFileSync(`supabase/migrations/${name}.sql`,'utf8');
const candidate=readFileSync(process.env.HERMES_ACTION_SQL??new URL('../../supabase/migrations/20261014083337_hermes_room_pass_action_v1.sql',import.meta.url),'utf8');
const forward=source('20261014000503_hermes_optional_org_policy_v1');
const extract=(src,name)=>src.match(new RegExp(`CREATE OR REPLACE FUNCTION ${name.replaceAll('.', '\\.')}[\\s\\S]*?\\$(?:fn)?\\$;`))[0];
const BUILDING=id('a'),ROOM=id('b'),LISTING=id('c'),SCOPE=id('e'),REQUEST=id('f');
const binding={connectionId:CONNECTION,tokenDigest:'b'.repeat(64),expectedEpoch:1,expectedPolicyVersion:1,expectedMembershipId:USER,expectedAuthorizationVersion:1,expectedSessionRevision:1};
const code=expected=>error=>error.code===expected;
export async function setup(t){
 const f=await fixture(t,{migrations:['20261013084000_hermes_private_command_dispatch_v1']}),{db}=f;
 await db.exec(`CREATE SCHEMA extensions;
   -- Synthetic digest port only; revision tuple/CAS is exercised, not SHA cryptography.
   CREATE FUNCTION extensions.digest(value bytea,algorithm text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$SELECT decode(md5(value)||md5(value),'hex')$$;
   CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('session_id',current_setting('request.jwt.claim.session',true))$$;
   CREATE TABLE public.buildings(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz);
   CREATE TABLE public.rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,deleted_at timestamptz);
   CREATE TABLE public.room_pass_listings(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,building_id uuid,room_id uuid,active boolean,updated_at timestamptz NOT NULL DEFAULT now());
   CREATE TABLE public.authorization_scopes(id uuid PRIMARY KEY,organization_id uuid,scope_type text,building_id uuid,area_id uuid,cashbook_id uuid);
   CREATE TABLE public.areas(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz);
   CREATE TABLE public.area_buildings(organization_id uuid,area_id uuid,building_id uuid);
   CREATE TABLE public.fixture_action_acl(allowed boolean,building_id uuid,deadline timestamptz);INSERT INTO public.fixture_action_acl VALUES(true,'${BUILDING}',null);
   CREATE TABLE public.fixture_action_audit(event text,metadata jsonb);
   CREATE FUNCTION app_private.append_authz_audit_v1(o uuid,e text,k text,i uuid,m jsonb) RETURNS void LANGUAGE sql AS $$INSERT INTO public.fixture_action_audit VALUES(e,m)$$;
   CREATE FUNCTION public.can_do_on_building(text,text,uuid) RETURNS boolean LANGUAGE sql AS $$SELECT allowed AND $3=building_id FROM public.fixture_action_acl$$;
   CREATE FUNCTION app_private.authorized_scope_v3(text,uuid) RETURNS TABLE(org_wide boolean,building_ids uuid[],cashbook_ids uuid[]) LANGUAGE sql AS $$
     SELECT false,CASE WHEN allowed AND $2='${ORG}'::uuid THEN ARRAY[building_id] ELSE '{}'::uuid[] END,'{}'::uuid[] FROM public.fixture_action_acl$$;
   CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean,authorization_version bigint,nearest_deadline timestamptz) LANGUAGE sql AS $$
     SELECT allowed AND $1='${USER}'::uuid AND $2='${ORG}'::uuid AND $3='sale_phong.manage_pass_listings' AND $4=building_id,1::bigint,deadline FROM public.fixture_action_acl$$;
   CREATE FUNCTION public.get_authorization_context_v1(p_org uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('organizationId',p_org,'isOffboarded',false,
     'membershipId','${USER}','authorizationVersion',1,'permissions',jsonb_build_object('sale_phong.manage_pass_listings',allowed)) FROM public.fixture_action_acl$$;
   INSERT INTO public.buildings VALUES('${BUILDING}','${ORG}',null);INSERT INTO public.rooms VALUES('${ROOM}','${ORG}','${BUILDING}',null);
   INSERT INTO public.room_pass_listings(id,organization_id,user_id,building_id,room_id,active) VALUES('${LISTING}','${ORG}','${USER}','${BUILDING}','${ROOM}',false);
   INSERT INTO public.authorization_scopes VALUES('${SCOPE}','${ORG}','BUILDING','${BUILDING}',null,null);
   UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['sale_phong.manage_pass_listings'],scope_ids=ARRAY['${SCOPE}'::uuid];
   UPDATE app_private.hermes_org_policies SET action_capabilities=ARRAY['sale_phong.manage_pass_listings'],scope_ids=ARRAY['${SCOPE}'::uuid];`);
 const canonical=source('20260617090000_room_pass_listings');
 for(const name of ['public.can_manage_pass_listing','public.set_room_pass_listing_active'])await db.exec(extract(canonical,name));
 for(const name of ['app_private.hermes_effective_org_policy_v1','app_private.hermes_private_command_connection_v1','app_private.hermes_session_gate_v1'])await db.exec(extract(forward,name));
 await db.exec(candidate);await db.exec(candidate);
 assert.equal((await db.query("SELECT enabled FROM app_private.hermes_capabilities WHERE capability='sale_phong.manage_pass_listings'")).rows[0].enabled,false);
 await db.exec("UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='sale_phong.manage_pass_listings'");
 async function rpc(operation,input,b=binding,role='authenticated',actor=USER){
   await db.exec('BEGIN');await db.query("SELECT set_config('request.jwt.claim.role',$1,true),set_config('request.jwt.claim.sub',$2,true),set_config('request.jwt.claim.session',$3,true)",[role,actor,SESSION]);
   await db.exec(`SET LOCAL ROLE ${role}`);
   try{const result=operation==='capabilities'?(await db.query('SELECT public.hermes_room_pass_capabilities_v1($1::uuid) result',[ORG])).rows[0].result:
     (await db.query('SELECT public.hermes_room_pass_action_v1($1::jsonb,$2::text,$3::jsonb) result',[JSON.stringify(b),operation,JSON.stringify(input)])).rows[0].result;await db.exec('COMMIT');return result;}
   catch(error){await db.exec('ROLLBACK');throw error;}finally{await db.exec('RESET ROLE');}
 }
 return{f,db,rpc};
}

export { BUILDING, ROOM, LISTING, SCOPE, REQUEST, binding, extract, forward, code };
