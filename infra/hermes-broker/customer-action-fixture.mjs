import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture, id, USER, ORG, FOREIGN, SESSION, CONNECTION } from '../hermes-zalo-router/private-command-fixture.mjs';
export { id, USER, ORG, FOREIGN, SESSION, CONNECTION };
export const SCOPE = id('e'), REQUEST = id('f');
export const binding = { connectionId: CONNECTION, tokenDigest: 'b'.repeat(64), expectedEpoch: 1, expectedPolicyVersion: 1,
  expectedMembershipId: USER, expectedAuthorizationVersion: 1, expectedSessionRevision: 1 };
export const customerInput = { requestId: REQUEST, name: 'Khách thử Hermes', phone: '0900000000', email: null, notes: 'Fixture dùng một lần' };
export const leadInput = { ...customerInput, source: 'ZALO' };
export const candidatePath = 'supabase/migrations/20261014104442_hermes_customer_lead_create_action_v1.sql';
const source = name => readFileSync(`supabase/migrations/${name}.sql`, 'utf8');
const baseline = readFileSync('supabase/baseline/schema.sql', 'utf8');
const fn = (src, name) => {
  const match = src.match(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION ${name.replaceAll('.', '\\.')}\\([\\s\\S]*?\\$(?:fn)?\\$;`, 'i'));
  assert.ok(match, `canonical function ${name} exists`); return match[0];
};
const table = name => baseline.match(new RegExp(`CREATE TABLE public\\.${name} \\([\\s\\S]*?\n\\);`))[0];
const policy = name => baseline.match(new RegExp(`CREATE POLICY ${name} ON public\\.\\w+[\\s\\S]*?;`))[0];
const trigger = name => baseline.match(new RegExp(`CREATE TRIGGER ${name} [\\s\\S]*?;`))[0];
export async function setup(t, { sql = readFileSync(process.env.HERMES_CUSTOMER_SQL ?? candidatePath, 'utf8') } = {}) {
  const { db } = await fixture(t, { migrations: ['20261013084000_hermes_private_command_dispatch_v1'] });
  await db.exec(`CREATE SCHEMA extensions;
    CREATE FUNCTION extensions.digest(value text,algorithm text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$SELECT decode(md5(value)||md5(value),'hex')$$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('session_id',current_setting('request.jwt.claim.session',true))$$;
    CREATE TABLE public.authorization_scopes(id uuid PRIMARY KEY,organization_id uuid,scope_type text,building_id uuid,area_id uuid,cashbook_id uuid);
    CREATE TABLE public.fixture_customer_acl(permission text PRIMARY KEY,allowed boolean,insert_rls boolean,select_rls boolean,crm_org_wide boolean,entity_permission boolean);
    INSERT INTO public.fixture_customer_acl VALUES('customers.create',true,true,true,false,true),('leads.create',true,true,true,false,true);
    CREATE TABLE public.authorization_audit_events(id uuid,organization_id uuid,occurred_at timestamptz,actor_user_id uuid,actor_membership_id uuid,event_type text,
      resource_type text,resource_id uuid,old_state jsonb,new_state jsonb,reason text,prev_hash text,event_hash text);
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$SELECT EXISTS(SELECT 1 FROM public.super_admins WHERE user_id=auth.uid())$$;
    CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql AS $$SELECT public.is_super_admin()$$;
    CREATE FUNCTION app_private.has_any_scope_v3(text) RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$SELECT COALESCE((SELECT allowed AND entity_permission FROM public.fixture_customer_acl WHERE permission=replace($1,'.view','.create')),false)$$;
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql SECURITY DEFINER AS $$SELECT ARRAY(SELECT organization_id FROM public.organization_memberships WHERE user_id=auth.uid() AND status='ACTIVE')$$;
    CREATE FUNCTION app_private.buildings_for_v3(text) RETURNS uuid[] LANGUAGE sql AS $$SELECT '{}'::uuid[]$$;
    CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
    CREATE FUNCTION public.get_authorization_context_v1(p_org uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('organizationId',p_org,'isOffboarded',false,
      'membershipId','${USER}','authorizationVersion',1,'permissions',(SELECT jsonb_object_agg(permission,allowed) FROM public.fixture_customer_acl))$$;
    INSERT INTO public.authorization_scopes VALUES('${SCOPE}','${ORG}','ORGANIZATION',null,null,null);
    UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['customers.create','leads.create'],scope_ids=ARRAY['${SCOPE}'::uuid];
    UPDATE app_private.hermes_org_policies SET action_capabilities=ARRAY['customers.create','leads.create'],scope_ids=ARRAY['${SCOPE}'::uuid];`);
  // Actual canonical tables, CHECK constraints, defaults, policies and actor trigger.
  // The permission graph behind has_any_scope/context is a fixture port. In
  // particular crm_org_wide=false does not invent an org-wide CRM requirement.
  for (const name of ['customer_type', 'id_type', 'customer_status', 'customer_status_v2', 'lead_source', 'lead_status'])
    await db.exec(baseline.match(new RegExp(`CREATE TYPE public\\.${name} AS ENUM \\([\\s\\S]*?\\);`))[0]);
  for (const name of ['customers', 'leads']) await db.exec(table(name));
  for (const name of ['public.can_access_org_entity', 'public.current_visible_owner_ids', 'public.set_user_id_from_auth',
    'app_private.openclaw_bump_lead_assignment_revision_v1', 'public.update_lead_score', 'app_private.openclaw_emit_lead_occurrence_v1']) await db.exec(fn(baseline, name));
  // Canonical emitter executes, capturing its typed occurrence locally. The
  // downstream OpenClaw routing/notification delivery is outside this fixture.
  await db.exec(`CREATE TABLE public.fixture_occurrences(organization_id uuid,event_type text,event_subtype text,source_table text,source_id uuid,source_version bigint,snapshot jsonb,occurred_at timestamptz);
    CREATE FUNCTION app_private.openclaw_insert_crm_occurrence_v1(uuid,text,text,text,uuid,bigint,jsonb,timestamptz) RETURNS boolean LANGUAGE plpgsql AS $$
    BEGIN INSERT INTO public.fixture_occurrences VALUES($1,$2,$3,$4,$5,$6,$7,$8);RETURN true;END$$;
    CREATE FUNCTION public.org_today_v1(uuid) RETURNS date LANGUAGE sql AS $$SELECT current_date$$;`);
  for (const name of ['customers_set_user_id_audit', 'leads_set_user_id_audit', 'openclaw_leads_assignment_revision', 'openclaw_leads_emit_typed_occurrence', 'trigger_update_lead_score'])
    await db.exec(trigger(name));
  for (const name of ['customers', 'leads']) {
    await db.exec(`ALTER TABLE public.${name} ENABLE ROW LEVEL SECURITY;GRANT SELECT,INSERT ON public.${name} TO authenticated;`);
    for (const suffix of ['insert_rbac', 'select_rbac', 'org_boundary']) await db.exec(policy(`${name}_${suffix}`));
    await db.exec(`CREATE POLICY fixture_${name}_rls ON public.${name} AS RESTRICTIVE FOR ALL TO authenticated
      USING((SELECT select_rls FROM public.fixture_customer_acl WHERE permission='${name}.create'))
      WITH CHECK((SELECT insert_rls FROM public.fixture_customer_acl WHERE permission='${name}.create'));`);
  }
  await db.exec('GRANT SELECT ON public.fixture_customer_acl TO authenticated;');
  await db.exec(fn(source('20260725180000_authz_audit_append_helper'), 'app_private.append_authz_audit_v1'));
  const forward = source('20261014000503_hermes_optional_org_policy_v1');
  for (const name of ['app_private.hermes_effective_org_policy_v1', 'app_private.hermes_private_command_connection_v1', 'app_private.hermes_session_gate_v1']) await db.exec(fn(forward, name));
  await db.exec(sql); await db.exec(sql);
  assert.equal((await db.query("SELECT count(*)::int n FROM app_private.hermes_capabilities WHERE capability IN ('customers.create','leads.create') AND enabled")).rows[0].n, 0);
  await db.exec("UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability IN ('customers.create','leads.create')");
  async function rpc(kind, operation, input, b = binding, { role = 'authenticated', actor = USER, session = SESSION } = {}) {
    await db.exec('BEGIN');
    await db.query("SELECT set_config('request.jwt.claim.role',$1,true),set_config('request.jwt.claim.sub',$2,true),set_config('request.jwt.claim.session',$3,true)", [role, actor, session]);
    await db.exec(`SET LOCAL ROLE ${role}`);
    try {
      const result = operation === 'capabilities' ? (await db.query('SELECT public.hermes_customer_create_capabilities_v1($1::uuid) result', [ORG])).rows[0].result :
        (await db.query('SELECT public.hermes_customer_create_action_v1($1::jsonb,$2::text,$3::text,$4::jsonb) result', [JSON.stringify(b), kind, operation, JSON.stringify(input)])).rows[0].result;
      await db.exec('COMMIT'); return result;
    } catch (error) { await db.exec('ROLLBACK'); throw error; } finally { await db.exec('RESET ROLE'); }
  }
  const counts = async () => (await db.query(`SELECT (SELECT count(*)::int FROM public.customers) customers,(SELECT count(*)::int FROM public.leads) leads,
    (SELECT count(*)::int FROM app_private.hermes_customer_create_receipts) receipts,(SELECT count(*)::int FROM public.authorization_audit_events) audits,
    (SELECT count(*)::int FROM public.fixture_occurrences) occurrences`)).rows[0];
  return { db, rpc, counts };
}
