import { readFileSync } from 'node:fs';
import { setup as taskSetup, BUILDING, TYPE, SCOPE, ASSIGNEE, binding } from './task-fixture.mjs';
import { USER, ORG, SESSION, CONNECTION, FOREIGN } from '../hermes-zalo-router/private-command-fixture.mjs';
export { USER, ORG, SESSION, CONNECTION, FOREIGN, BUILDING, TYPE, SCOPE, ASSIGNEE, binding };

// Version-4 identifiers distinct from the shared fixture's repeated-digit ids.
export const u = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const ASSISTANT2 = u(101), SESSION2 = u(102), CONNECTION2 = u(103), OTHER = u(104);
export const binding2 = { connectionId: CONNECTION2, tokenDigest: 'c'.repeat(64), expectedEpoch: 1, expectedPolicyVersion: 1,
  expectedMembershipId: ASSIGNEE, expectedAuthorizationVersion: 1, expectedSessionRevision: 1 };
export const followPath = 'supabase/migrations/20261015110000_hermes_task_follow_v1.sql';
const source = name => readFileSync(`supabase/migrations/${name}.sql`, 'utf8');
const policy = (src, name) => src.match(new RegExp(`(?:CREATE|ALTER) POLICY "?${name}"? ON (?:public\\.)?\\w+[\\s\\S]*?;`, 'i'))[0];

/** Real Hermes identity/session/policy SQL, real canonical jobs table, triggers
 * and current jobs RLS policies; the CRM authorization graph behind
 * authorize/scope helpers is a per-user permission table port. Notifications,
 * notify gate, Vault JWT and pg_net are synthetic ports. */
export async function setupFollow(t, { sql = readFileSync(process.env.HERMES_TASK_FOLLOW_SQL ?? followPath, 'utf8') } = {}) {
  const base = await taskSetup(t);
  const { db } = base;
  await db.exec(`
    CREATE TABLE public.fixture_perm(user_id uuid,permission text,building_id uuid,rls_blocked boolean NOT NULL DEFAULT false);
    INSERT INTO public.fixture_perm(user_id,permission,building_id) VALUES
      ('${USER}','tasks.view','${BUILDING}'),('${USER}','tasks.create','${BUILDING}'),('${USER}','tasks.edit','${BUILDING}'),
      ('${USER}','tasks.delete','${BUILDING}'),('${USER}','users.view',null),
      ('${ASSIGNEE}','tasks.view','${BUILDING}'),('${ASSIGNEE}','tasks.create','${BUILDING}'),('${ASSIGNEE}','tasks.edit','${BUILDING}');
    CREATE OR REPLACE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid)
      RETURNS TABLE(allowed boolean,authorization_version bigint,nearest_deadline timestamptz) LANGUAGE sql AS $$
      SELECT allowed AND $2='${ORG}'::uuid AND EXISTS(SELECT 1 FROM public.fixture_perm p WHERE p.user_id=$1 AND p.permission=$3
        AND ($4 IS NULL OR p.building_id IS NULL OR p.building_id=$4)),context_version,deadline FROM public.fixture_task_acl $$;
    CREATE OR REPLACE FUNCTION app_private.authorized_scope_v3(text,uuid) RETURNS TABLE(org_wide boolean,building_ids uuid[],cashbook_ids uuid[]) LANGUAGE sql AS $$
      SELECT false,CASE WHEN allowed AND $2='${ORG}'::uuid THEN COALESCE((SELECT array_agg(p.building_id) FROM public.fixture_perm p
        WHERE p.user_id=auth.uid() AND p.permission=$1 AND p.building_id IS NOT NULL),'{}'::uuid[]) ELSE '{}'::uuid[] END,'{}'::uuid[]
      FROM public.fixture_task_acl $$;
    CREATE OR REPLACE FUNCTION app_private.buildings_for_v3(text) RETURNS uuid[] LANGUAGE sql SECURITY DEFINER AS $$
      SELECT CASE WHEN insert_rls THEN COALESCE((SELECT array_agg(p.building_id) FROM public.fixture_perm p
        WHERE p.user_id=auth.uid() AND p.permission=$1 AND NOT p.rls_blocked AND p.building_id IS NOT NULL),'{}'::uuid[]) ELSE '{}'::uuid[] END
      FROM public.fixture_task_acl $$;
    CREATE OR REPLACE FUNCTION public.get_authorization_context_v1(p_org uuid) RETURNS jsonb LANGUAGE sql AS $$
      SELECT jsonb_build_object('organizationId',p_org,'isOffboarded',false,'membershipId',auth.uid(),'authorizationVersion',context_version,
        'permissions',COALESCE((SELECT jsonb_object_agg(x.permission,allowed) FROM (SELECT DISTINCT p.permission FROM public.fixture_perm p
          WHERE p.user_id=auth.uid()) x),'{}'::jsonb)) FROM public.fixture_task_acl $$;
    CREATE FUNCTION app_private.is_actor_offboarded_v1() RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
    CREATE TABLE public.material_usages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid);
    CREATE TABLE public.notifications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,user_id uuid NOT NULL,type text NOT NULL,
      channel text NOT NULL,status text DEFAULT 'PENDING',subject text,content text NOT NULL CHECK(char_length(content)>0),job_id uuid,
      metadata jsonb NOT NULL DEFAULT '{}',push_state text,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
    CREATE TABLE public.fixture_gate(user_id uuid PRIMARY KEY,in_app boolean,push boolean);
    CREATE FUNCTION app_private.notify_gate_v1(p_user uuid,p_org uuid,p_event text,p_amount numeric DEFAULT NULL)
      RETURNS TABLE(g_in_app boolean,g_push boolean) LANGUAGE sql AS $$
      SELECT COALESCE((SELECT in_app FROM public.fixture_gate WHERE user_id=p_user),true),COALESCE((SELECT push FROM public.fixture_gate WHERE user_id=p_user),true) $$;
    CREATE TABLE public.fixture_jwt(value text);
    CREATE FUNCTION app_private.lifecycle_reminder_service_jwt_v1() RETURNS text LANGUAGE plpgsql AS $$
      DECLARE v text; BEGIN SELECT value INTO v FROM public.fixture_jwt; IF v IS NULL THEN RAISE EXCEPTION 'marked test database'; END IF; RETURN v; END $$;
    CREATE SCHEMA net; CREATE TABLE public.fixture_push(body jsonb,headers jsonb);
    CREATE FUNCTION net.http_post(url text,body jsonb,headers jsonb,timeout_milliseconds integer) RETURNS bigint LANGUAGE sql AS $$
      INSERT INTO public.fixture_push VALUES(body,headers) RETURNING 1::bigint $$;
    INSERT INTO public.profiles VALUES('${OTHER}','Third person');
    INSERT INTO auth.users VALUES('${OTHER}');
    INSERT INTO public.organization_memberships(id,user_id,organization_id,status) VALUES('${OTHER}','${OTHER}','${ORG}','ACTIVE');
    INSERT INTO app_private.hermes_capabilities(capability,mode,enabled) VALUES('tasks.view','read',true)
      ON CONFLICT(capability) DO UPDATE SET enabled=true;
    UPDATE app_private.hermes_org_policies SET read_capabilities=ARRAY['tasks.view'],action_capabilities=ARRAY['tasks.create','tasks.edit','tasks.delete'];
    UPDATE app_private.hermes_connections SET read_capabilities=ARRAY['tasks.view'],action_capabilities=ARRAY['tasks.create','tasks.edit','tasks.delete'];
    INSERT INTO app_private.hermes_assistants(id,organization_id,user_id) VALUES('${ASSISTANT2}','${ORG}','${ASSIGNEE}');
    INSERT INTO app_private.hermes_sessions(id,assistant_id,organization_id,user_id,provider_session_id,state,envelope,expires_at)
      VALUES('${SESSION2}','${ASSISTANT2}','${ORG}','${ASSIGNEE}','${SESSION2}','ACTIVE','{}',clock_timestamp()+interval '1 hour');
    INSERT INTO app_private.hermes_connections(id,assistant_id,organization_id,user_id,state,credential_ref,intent_digest,intent_expires_at,
      activation_operation_id,read_capabilities,action_capabilities,scope_ids)
      VALUES('${CONNECTION2}','${ASSISTANT2}','${ORG}','${ASSIGNEE}','ACTIVE','${SESSION2}',repeat('a',64),clock_timestamp()+interval '1 hour',
      '${CONNECTION2}',ARRAY['tasks.view'],ARRAY['tasks.create','tasks.edit'],ARRAY['${SCOPE}'::uuid]);
    INSERT INTO app_private.hermes_connection_tokens(token_digest,connection_id,expires_at) VALUES(repeat('c',64),'${CONNECTION2}',clock_timestamp()+interval '10 minutes');
  `);
  const misc = source('20260527000009_rbac_phase5_misc'), cutover = source('20260725200000_cutover_policies_array_form');
  for (const name of ['jobs_update_rbac', 'jobs_delete_rbac']) { await db.exec(policy(misc, name)); await db.exec(policy(cutover, name)); }
  await db.exec('GRANT UPDATE,DELETE ON public.jobs TO authenticated');
  await db.exec(sql); await db.exec(sql);
  const installed = (await db.query("SELECT bool_or(enabled) enabled,count(*)::int n FROM app_private.hermes_capabilities WHERE capability IN ('tasks.edit','tasks.delete')")).rows[0];
  if (installed.n !== 2 || installed.enabled !== false) throw new Error('task follow capabilities must install disabled');
  await db.exec("UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability IN ('tasks.edit','tasks.delete')");
  const actors = { user: { actor: USER, session: SESSION, binding }, assignee: { actor: ASSIGNEE, session: SESSION2, binding: binding2 } };
  async function call(query, params, as = 'user') {
    const { actor, session } = actors[as];
    await db.exec('BEGIN');
    await db.query("SELECT set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.session',$2,true)", [actor, session]);
    await db.exec('SET LOCAL ROLE authenticated');
    try { const result = (await db.query(query, params)).rows[0].result; await db.exec('COMMIT'); return result; }
    catch (error) { await db.exec('ROLLBACK'); throw error; }
    finally { await db.exec('RESET ROLE'); }
  }
  const action = (operation, input, as = 'user', b = actors[as].binding) => call('SELECT public.hermes_task_follow_action_v1($1::jsonb,$2::text,$3::jsonb) result',
    [JSON.stringify(b), operation, JSON.stringify(input)], as);
  const read = (input, as = 'user', b = actors[as].binding) => call('SELECT public.hermes_task_follow_read_v1($1::jsonb,$2::jsonb) result', [JSON.stringify(b), JSON.stringify(input)], as);
  const web = (name, input, as = 'user') => call(`SELECT public.${name}($1::uuid,$2::jsonb) result`, [ORG, JSON.stringify(input)], as);
  const capabilities = (as = 'user') => call('SELECT public.hermes_task_follow_capabilities_v1($1::uuid) result', [ORG], as);
  const tick = async () => (await db.query('SELECT app_private.hermes_task_follow_tick_v1() result')).rows[0].result;
  let next = 500;
  async function job({ title = 'Thay bóng đèn', assignee = ASSIGNEE, creator = USER, deadline = null, status = 'IN_PROGRESS' } = {}) {
    const id = u(next++);
    await db.query(`INSERT INTO public.jobs(id,user_id,code,title,building_id,job_type_id,priority,assignee_id,deadline,status,organization_id,started_at)
      VALUES($1,$2,$3,$4,$5,$6,'NORMAL',$7,$8,$9,$10,clock_timestamp())`, [id, creator, `JOB-T-${next}`, title, BUILDING, TYPE, assignee, deadline, status, ORG]);
    return id;
  }
  return { ...base, db, call, action, read, web, capabilities, tick, job };
}
