import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixture,id,ORG,USER,ACCOUNT,CONNECTION,SESSION,ASSISTANT,GENERATION,FOREIGN} from '../hermes-zalo-router/private-command-fixture.mjs';
const HERE=new URL('../../supabase/migrations/',import.meta.url);
const sql=readFileSync(new URL('20261013163623_hermes_group_preview_authority_v1.sql',HERE),'utf8');
const migration=name=>readFileSync(`supabase/migrations/${name}.sql`,'utf8');
const SCOPE=id('e'),BUILDING=id('f'),ROOM='01234567-1234-4567-8123-123456789abc',GROUP='12345678-1234-4567-8123-123456789abc',CLAIM='23456789-1234-4567-8123-123456789abc',REQUEST='34567890-1234-4567-8123-123456789abc';
const baseline={connectionId:CONNECTION,tokenDigest:'b'.repeat(64),commandId:null,claimId:CLAIM,expectedEpoch:1,expectedPolicyVersion:1,expectedMembershipId:USER,expectedAuthorizationVersion:1,expectedSessionRevision:1,requestId:REQUEST};
const body={pages:1,buildings:[{id:BUILDING,name:'Synthetic building',code:'B',public_contact_phone:'not-to-cross'}],rooms:[{id:ROOM,building_id:BUILDING,name:'101',code:'101',floor:1,area:25,rent_price:5000000,deposit_amount:5000000,status_public:'free',avail_date:null,sale_state:null,sale_today:'2026-10-13',expected_ready_on:null,description:'PRIVATE',sale_note:'PRIVATE'}]};

export async function setup(t){
  const f=await fixture(t,{migrations:['20261013084000_hermes_private_command_dispatch_v1']});
  await f.db.exec(`
    ALTER TABLE public.zalo_conversations ADD COLUMN peer_name text;
    INSERT INTO auth.users VALUES('${FOREIGN}');
    CREATE TABLE public.areas(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz);
    CREATE TABLE public.buildings(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz);
    CREATE TABLE public.accounts(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz);
    CREATE TABLE public.area_buildings(organization_id uuid,area_id uuid,building_id uuid);
    CREATE TABLE public.authorization_scopes(id uuid PRIMARY KEY,organization_id uuid,scope_type text,building_id uuid,area_id uuid,cashbook_id uuid);
    CREATE TABLE public.copilot_feature_flags(scope text,contract_id text,state text,canary_org uuid,expires_at timestamptz,revision bigint);
    CREATE TABLE app_private.copilot_action_registry(action_id text,permission_key text,flag_contract_id text,enabled boolean,version bigint);
    CREATE TABLE app_private.tenant_emergency_denies(organization_id uuid,permission_key text,active_from timestamptz,expires_at timestamptz);
    CREATE TABLE public.fixture_authority(rooms boolean,view_zalo boolean,send_zalo boolean,org_wide boolean,version bigint,superadmin boolean);
    INSERT INTO public.fixture_authority VALUES(true,true,true,true,1,false);
    CREATE TABLE public.fixture_rooms(payload jsonb);
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('session_id',current_setting('request.jwt.claim.session',true))$$;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT superadmin FROM public.fixture_authority$$;
    CREATE FUNCTION public.zalo_can(action text,org uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT org='${ORG}'::uuid AND CASE WHEN action='view' THEN view_zalo WHEN action='send' THEN send_zalo ELSE false END FROM public.fixture_authority$$;
    -- Explicit synthetic authorization port; the tested group SQL does not
    -- use Copilot rollout flags as a substitute for current CRM authorization.
    CREATE FUNCTION app_private.authorize_tenant_action_v3(p_actor uuid,p_organization_id uuid,p_permission_key text,p_building_id uuid DEFAULT NULL,p_cashbook_id uuid DEFAULT NULL)
      RETURNS TABLE(allowed boolean,authorization_version bigint,nearest_deadline timestamptz,evaluated_at timestamptz,decision_reason text)
      LANGUAGE sql STABLE AS $$ SELECT p_actor='${USER}'::uuid AND p_organization_id='${ORG}'::uuid AND
        CASE p_permission_key WHEN 'chat_zalo.send' THEN send_zalo AND org_wide WHEN 'chat_zalo.view' THEN view_zalo AND org_wide
          WHEN 'rooms.view' THEN rooms AND (p_building_id IS NULL OR p_building_id='${BUILDING}'::uuid) ELSE false END,
        version,NULL::timestamptz,statement_timestamp(),'synthetic_authorization'::text FROM public.fixture_authority $$;
    CREATE FUNCTION public.get_authorization_context_v1(org uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
      SELECT jsonb_build_object('organizationId',org,'membershipId','${USER}','authorizationVersion',version,'isOffboarded',false,'permissions',jsonb_build_object('rooms.view',rooms)) FROM public.fixture_authority$$;
    CREATE FUNCTION public.copilot_org_scope_buildings_v1(permission text,org uuid) RETURNS uuid[] LANGUAGE sql STABLE AS $$
      SELECT CASE WHEN rooms AND org='${ORG}'::uuid AND permission='rooms.view' THEN ARRAY['${BUILDING}'::uuid] ELSE '{}'::uuid[] END FROM public.fixture_authority$$;
    CREATE FUNCTION app_private.authorized_scope_v3(permission text,org uuid) RETURNS TABLE(org_wide boolean,building_ids uuid[],cashbook_ids uuid[]) LANGUAGE sql STABLE AS $$
      SELECT f.org_wide AND org='${ORG}'::uuid AND permission='chat_zalo.send' AND f.send_zalo,'{}'::uuid[],'{}'::uuid[] FROM public.fixture_authority f$$;
    CREATE FUNCTION public.copilot_available_rooms_v1(org uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT payload FROM public.fixture_rooms$$;
    INSERT INTO public.buildings VALUES('${BUILDING}','${ORG}',null);
    INSERT INTO public.authorization_scopes VALUES('${SCOPE}','${ORG}','BUILDING','${BUILDING}',null,null);
    INSERT INTO public.copilot_feature_flags VALUES('action','zalo.broadcast','enabled',null,null,1);
    INSERT INTO app_private.copilot_action_registry VALUES('zalo.broadcast','chat_zalo.send','zalo.broadcast',true,1);
    INSERT INTO app_private.hermes_capabilities VALUES('rooms.view','read',true),('chat_zalo.view','read',true),('chat_zalo.send','action',true);
    UPDATE app_private.hermes_org_policies SET read_capabilities=ARRAY['rooms.view','chat_zalo.view'],action_capabilities=ARRAY['chat_zalo.send'],scope_ids=ARRAY['${SCOPE}'::uuid];
    UPDATE app_private.hermes_connections SET read_capabilities=ARRAY['rooms.view','chat_zalo.view'],action_capabilities=ARRAY['chat_zalo.send'],scope_ids=ARRAY['${SCOPE}'::uuid];
    INSERT INTO public.zalo_conversations(id,account_id,organization_id,thread_type,thread_id,peer_name) VALUES('${GROUP}','${ACCOUNT}','${ORG}','group','987','Synthetic group');
  `);
  await f.db.query('INSERT INTO public.fixture_rooms VALUES($1)',[JSON.stringify(body)]);
  const roomMap=migration('20261012165809_hermes_public_conflict_http_v1').match(/CREATE OR REPLACE FUNCTION public\.hermes_room_scope_map_v1[\s\S]*?\$fn\$;/)[0];
  const actionGate=migration('20260903043956_copilot_action_registry_policy_ledger_v1').match(/CREATE OR REPLACE FUNCTION app_private\.copilot_action_gate_v1[\s\S]*?\$cong\$;/)[0];
  await f.db.exec(roomMap);await f.db.exec(actionGate);await f.db.exec(sql);await f.db.exec(sql);
  const accepted=await f.call();baseline.commandId=accepted.commandId;
  await f.rpc('app_private.hermes_store_claim_private_command_v1',{tokenDigest:baseline.tokenDigest,claimId:CLAIM});
  await f.rpc('app_private.hermes_store_dispatch_private_command_v1',{tokenDigest:baseline.tokenDigest,claimId:CLAIM});
return {f,baseline,body,SCOPE,BUILDING,ROOM,GROUP,CLAIM,REQUEST};
}
