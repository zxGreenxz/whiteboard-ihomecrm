import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture, id, USER, ORG, FOREIGN, SESSION, CONNECTION } from '../hermes-zalo-router/private-command-fixture.mjs';
export { id, USER, ORG, FOREIGN, SESSION, CONNECTION };
export const BUILDING=id('a'), ROOM=id('b'), TYPE=id('c'), SCOPE=id('e'), REQUEST=id('f'), ASSIGNEE=id('0');
export const binding={connectionId:CONNECTION,tokenDigest:'b'.repeat(64),expectedEpoch:1,expectedPolicyVersion:1,expectedMembershipId:USER,expectedAuthorizationVersion:1,expectedSessionRevision:1};
export const input={requestId:REQUEST,title:'Sửa vòi nước',description:'Kiểm tra phòng\nvà thay gioăng nếu cần.',buildingId:BUILDING,roomId:ROOM,jobTypeId:TYPE,priority:'NORMAL',assigneeId:ASSIGNEE,deadline:'2026-10-20T08:30:00.000Z'};
export const candidatePath='supabase/migrations/20261014092945_hermes_task_create_action_v1.sql';
const source=name=>readFileSync(`supabase/migrations/${name}.sql`,'utf8');
const extract=(src,name)=>src.match(new RegExp(`CREATE OR REPLACE FUNCTION ${name.replaceAll('.', '\\.')}[\\s\\S]*?\\$(?:fn)?\\$;`,'i'))[0];
const policy=(src,name)=>src.match(new RegExp(`(?:CREATE|ALTER) POLICY "?${name}"? ON (?:public\\.)?\\w+[\\s\\S]*?;`,'i'))[0];
// `database`: a PGlite-shaped { exec, query, close } over real PostgreSQL (one-off PG17 checks); default PGlite.
export async function setup(t,{sql=readFileSync(process.env.HERMES_TASK_SQL??candidatePath,'utf8'),database}={}) {
 const {db}=await fixture(t,{migrations:['20261013084000_hermes_private_command_dispatch_v1'],database});
 await db.exec(`
  CREATE SCHEMA extensions;
  -- Digest port only: test actual audit invocation/transaction, not hash crypto.
  CREATE FUNCTION extensions.digest(value text,algorithm text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$SELECT decode(md5(value)||md5(value),'hex')$$;
  CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('session_id',current_setting('request.jwt.claim.session',true))$$;
  CREATE TABLE public.buildings(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz);
  CREATE TABLE public.rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,deleted_at timestamptz);
  CREATE TABLE public.beds(id uuid PRIMARY KEY);CREATE TABLE public.job_groups(id uuid PRIMARY KEY);
  CREATE TABLE public.job_types(id uuid PRIMARY KEY,organization_id uuid);
  CREATE TABLE public.profiles(id uuid PRIMARY KEY,full_name text);
  CREATE TABLE public.staff_assignments(user_id uuid,staff_id uuid);
  CREATE TABLE public.authorization_scopes(id uuid PRIMARY KEY,organization_id uuid,scope_type text,building_id uuid,area_id uuid,cashbook_id uuid);
  CREATE TABLE public.areas(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz);
  CREATE TABLE public.area_buildings(organization_id uuid,area_id uuid,building_id uuid);
  CREATE TABLE public.fixture_task_acl(allowed boolean,building_id uuid,deadline timestamptz,insert_rls boolean,select_rls boolean,profile_rls boolean,context_version bigint);
  INSERT INTO public.fixture_task_acl VALUES(true,'${BUILDING}',null,true,true,true,1);
  CREATE TABLE public.authorization_audit_events(id uuid,organization_id uuid,occurred_at timestamptz,actor_user_id uuid,actor_membership_id uuid,event_type text,
    resource_type text,resource_id uuid,old_state jsonb,new_state jsonb,reason text,prev_hash text,event_hash text);
  CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$SELECT EXISTS(SELECT 1 FROM public.super_admins WHERE user_id=auth.uid())$$;
  CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql AS $$SELECT public.is_super_admin()$$;
  CREATE FUNCTION public.can_access_org_entity(text,text) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
  CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$SELECT $1=building_id AND select_rls FROM public.fixture_task_acl$$;
  CREATE FUNCTION public.can_do_on_building(text,text,uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$SELECT $3=building_id AND insert_rls FROM public.fixture_task_acl$$;
  CREATE FUNCTION public.has_full_building_scope() RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
  CREATE FUNCTION public.accessible_building_ids() RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER AS $$SELECT building_id FROM public.fixture_task_acl WHERE select_rls$$;
  CREATE FUNCTION app_private.buildings_for_v3(text) RETURNS uuid[] LANGUAGE sql SECURITY DEFINER AS $$SELECT CASE WHEN insert_rls THEN ARRAY[building_id] ELSE '{}'::uuid[] END FROM public.fixture_task_acl$$;
  CREATE FUNCTION app_private.authorized_scope_v3(text,uuid) RETURNS TABLE(org_wide boolean,building_ids uuid[],cashbook_ids uuid[]) LANGUAGE sql AS $$
    SELECT false,CASE WHEN allowed AND $2='${ORG}'::uuid THEN ARRAY[building_id] ELSE '{}'::uuid[] END,'{}'::uuid[] FROM public.fixture_task_acl$$;
  CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean,authorization_version bigint,nearest_deadline timestamptz) LANGUAGE sql AS $$
    SELECT allowed AND $1='${USER}'::uuid AND $2='${ORG}'::uuid AND $3='tasks.create' AND $4=building_id,context_version,deadline FROM public.fixture_task_acl$$;
  CREATE FUNCTION public.get_authorization_context_v1(p_org uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('organizationId',p_org,'isOffboarded',false,
    'membershipId','${USER}','authorizationVersion',context_version,'permissions',jsonb_build_object('tasks.create',allowed)) FROM public.fixture_task_acl$$;
  CREATE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.updated_at=now();RETURN NEW;END$$;
  INSERT INTO auth.users VALUES('${ASSIGNEE}');
  INSERT INTO public.organization_memberships(id,user_id,organization_id,status) VALUES('${ASSIGNEE}','${ASSIGNEE}','${ORG}','ACTIVE');
  INSERT INTO public.profiles VALUES('${USER}','Actor'),('${ASSIGNEE}','Recipient');
  INSERT INTO public.staff_assignments VALUES('${USER}','${ASSIGNEE}');
  INSERT INTO public.buildings VALUES('${BUILDING}','${ORG}',null);
  INSERT INTO public.rooms VALUES('${ROOM}','${ORG}','${BUILDING}',null);
  INSERT INTO public.job_types VALUES('${TYPE}','${ORG}');
  INSERT INTO public.authorization_scopes VALUES('${SCOPE}','${ORG}','BUILDING','${BUILDING}',null,null);
  UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['tasks.create'],scope_ids=ARRAY['${SCOPE}'::uuid];
  UPDATE app_private.hermes_org_policies SET action_capabilities=ARRAY['tasks.create'],scope_ids=ARRAY['${SCOPE}'::uuid];`);
 // Actual canonical table, current status shape, code/audit/completion triggers,
 // and current jobs policies. Authorization graph behind helpers is a port.
 const jobs=source('20251121000001_create_jobs_table');
 await db.exec(jobs.slice(0,jobs.indexOf('-- 6. SUPABASE STORAGE BUCKET')));
 await db.exec(source('20260516000053_jobs_simplify_status'));
 await db.exec('ALTER TABLE public.jobs ADD COLUMN organization_id uuid,ADD COLUMN assignee_name text');
 await db.exec(extract(source('20260527000001_fix_generate_job_code_rls'),'public.generate_job_code'));
 await db.exec(extract(source('20260527000006_rbac_phase2_trigger_auto_user_id'),'public.set_user_id_from_auth'));
 await db.exec(extract(source('20260720181000_jobs_completion_time_integrity'),'public.jobs_stamp_completion_time'));
 await db.exec(`CREATE TRIGGER jobs_set_user_id_audit BEFORE INSERT ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
  CREATE TRIGGER trigger_jobs_stamp_completion_time BEFORE INSERT OR UPDATE ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.jobs_stamp_completion_time();
  DROP POLICY "Users can view own jobs" ON public.jobs;DROP POLICY "Users can create own jobs" ON public.jobs;
  DROP POLICY "Users can update own jobs" ON public.jobs;DROP POLICY "Users can delete own jobs" ON public.jobs;`);
 for(const name of ['jobs_select_rbac','jobs_insert_rbac'])await db.exec(policy(source('20260527000009_rbac_phase5_misc'),name));
 await db.exec(policy(source('20260725200000_cutover_policies_array_form'),'jobs_insert_rbac'));
 await db.exec(policy(source('20260726130000_rls_setbased_missed_tables'),'jobs_select_rbac'));
 await db.exec(policy(source('20260502000001_fix_user_provision_flow'),'profiles_select_via_staff_assignments'));
 await db.exec(`ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
  CREATE POLICY fixture_profile_visibility ON public.profiles AS RESTRICTIVE FOR SELECT TO authenticated USING((SELECT profile_rls FROM public.fixture_task_acl));
  CREATE POLICY fixture_jobs_restrictive ON public.jobs AS RESTRICTIVE FOR ALL TO authenticated
    USING((SELECT select_rls FROM public.fixture_task_acl)) WITH CHECK((SELECT insert_rls FROM public.fixture_task_acl));
  GRANT SELECT ON public.fixture_task_acl,public.profiles,public.staff_assignments,public.buildings,public.rooms,public.job_types TO authenticated;
  GRANT SELECT,INSERT ON public.jobs TO authenticated;`);
 await db.exec(extract(source('20260725180000_authz_audit_append_helper'),'app_private.append_authz_audit_v1'));
 const forward=source('20261014000503_hermes_optional_org_policy_v1');
 for(const name of ['app_private.hermes_effective_org_policy_v1','app_private.hermes_private_command_connection_v1','app_private.hermes_session_gate_v1'])await db.exec(extract(forward,name));
 await db.exec(sql);await db.exec(sql);
 assert.equal((await db.query("SELECT enabled FROM app_private.hermes_capabilities WHERE capability='tasks.create'")).rows[0].enabled,false);
 assert.equal((await db.query("SELECT has_schema_privilege('authenticated','app_private','USAGE') allowed")).rows[0].allowed,false);
 await db.exec("UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='tasks.create'");
 async function rpc(operation,value,b=binding,{role='authenticated',actor=USER,session=SESSION}={}) {
  await db.exec('BEGIN');await db.query("SELECT set_config('request.jwt.claim.role',$1,true),set_config('request.jwt.claim.sub',$2,true),set_config('request.jwt.claim.session',$3,true)",[role,actor,session]);
  await db.exec(`SET LOCAL ROLE ${role}`);
  try { const result=operation==='capabilities'?(await db.query('SELECT public.hermes_task_create_capabilities_v1($1::uuid) result',[ORG])).rows[0].result:
    (await db.query('SELECT public.hermes_task_create_action_v1($1::jsonb,$2::text,$3::jsonb) result',[JSON.stringify(b),operation,JSON.stringify(value)])).rows[0].result;
    await db.exec('COMMIT');return result;
  } catch(error){await db.exec('ROLLBACK');throw error;}finally{await db.exec('RESET ROLE');}
 }
 const counts=async()=> (await db.query(`SELECT (SELECT count(*)::int FROM public.jobs) jobs,(SELECT count(*)::int FROM app_private.hermes_task_create_receipts) receipts,
  (SELECT count(*)::int FROM public.authorization_audit_events WHERE event_type='HERMES_TASK_CREATED') audits`)).rows[0];
 return {db,rpc,counts};
}
