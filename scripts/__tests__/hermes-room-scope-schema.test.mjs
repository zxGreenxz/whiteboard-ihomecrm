import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { splitSqlStatements } from '../network-center-function-bodies.mjs';

// Source contracts and mutation witnesses, not PostgreSQL compilation, live ACL,
// concurrency or PostgREST/JWT proof. Latest Hermes definition wins.
const directory = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
const clean = sql => sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
const statements = readdirSync(directory).filter(name => /hermes.*\.sql$/i.test(name)).sort()
  .flatMap(name => splitSqlStatements(readFileSync(join(directory, name), 'utf8')).map(clean));
const find = name => statements.filter(sql => new RegExp(`^CREATE (?:OR REPLACE )?FUNCTION ${name.replace('.', '\\.')}\\(`, 'i').test(sql)).at(-1);
const source = find('public.hermes_room_scope_map_v1');
assert(source, 'current bound room scope definition must exist');

function coherentDecision(sql) {
  assert.match(sql, /RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private/i);
  assert.doesNotMatch(sql, /\bVOLATILE\b|\bFOR (?:SHARE|UPDATE|NO KEY UPDATE)\b|\bLOCK\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bEXECUTE\b/i);
  assert.doesNotMatch(sql, /(?:PERFORM|:=)\s*app_private\.(?:hermes_member_v1|lock_org_for_decision_v1)/i);
  assert.match(sql, /v_auth:=public\.get_authorization_context_v1\(p_organization_id\)/);
  assert.match(sql, /v_auth->'permissions'->'rooms\.view' IS DISTINCT FROM 'true'::jsonb/);
  assert.match(sql, /v_buildings:=public\.hermes_scope_buildings_v1\('rooms\.view',p_organization_id\)/);
  assert.match(sql, /cardinality\(v_buildings\)<1 OR cardinality\(v_buildings\)>256/);
}
function ownershipFence(sql, policy = find('app_private.hermes_effective_org_policy_v1')) {
  for (const value of ["auth.role() IS DISTINCT FROM 'authenticated'", "v_actor uuid:=auth.uid()",
    "id=p_connection_id AND organization_id=p_organization_id AND user_id=v_actor AND state='ACTIVE'",
    'id=v_c.credential_ref AND assistant_id=v_c.assistant_id AND organization_id=p_organization_id',
    "user_id=v_actor AND provider_session_id::text=auth.jwt()->>'session_id'",
    "state='ACTIVE' AND quarantine_reason IS NULL AND expires_at>v_now",
    'token_digest=p_token_digest AND connection_id=v_c.id AND revoked_at IS NULL AND expires_at>v_now',
    "a.id=v_c.assistant_id AND a.organization_id=p_organization_id AND a.user_id=v_actor AND a.state='ACTIVE'",
    'SELECT * INTO v_p FROM app_private.hermes_effective_org_policy_v1(p_organization_id,v_c.read_capabilities,v_c.action_capabilities,v_c.scope_ids) WHERE enabled;',
    "'rooms.view'=ANY(v_c.read_capabilities)",
    "'rooms.view'=ANY(v_p.read_capabilities)", "cap.capability='rooms.view' AND cap.mode='read' AND cap.enabled",
    'v_c.epoch<>p_expected_epoch', 'v_p.version<>p_expected_policy_version', 'v_s.revision<>p_expected_session_revision',
    "v_auth->>'membershipId' IS DISTINCT FROM p_expected_membership_id::text",
    "v_auth->>'authorizationVersion' IS DISTINCT FROM p_expected_authorization_version::text",
    'v_s.expires_at<=clock_timestamp() OR v_t.expires_at<=clock_timestamp()',
    'v_member.valid_to IS NOT NULL AND v_member.valid_to<=clock_timestamp()']) assert(sql.includes(value), value);
  assert.match(sql, /WHERE enabled; IF NOT FOUND OR NOT EXISTS\(SELECT 1 FROM app_private\.hermes_assistants.*THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;/);
  assert.match(policy, /LANGUAGE plpgsql STABLE SECURITY DEFINER/);
  assert.match(policy, /SELECT \* INTO v_policy FROM app_private\.hermes_org_policies WHERE organization_id=p_org; IF FOUND THEN RETURN v_policy; END IF;/,
    'explicit disabled or empty policy must never fall back to neutral');
  assert.match(policy, /v_policy\.organization_id:=p_org; v_policy\.enabled:=true; v_policy\.version:=0;/);
}
function membershipParity(sql) {
  // Match the strict Hermes identity/lifetime rules without cloning permission
  // calculation: selected membership exactly one, ordinary users one active org,
  // superadmin still requires an explicit selected-org membership.
  for (const value of ['SELECT count(*) INTO v_count FROM public.organization_memberships m',
    "m.user_id=v_actor AND m.organization_id=p_organization_id AND o.status='ACTIVE'",
    "m.status='ACTIVE' AND m.revoked_at IS NULL", "COALESCE(m.valid_from,'-infinity'::timestamptz)<=v_now",
    '(m.valid_to IS NULL OR m.valid_to>v_now)', "IF v_count<>1 THEN RAISE EXCEPTION 'hermes_membership_required'",
    'id=p_expected_membership_id AND user_id=v_actor AND organization_id=p_organization_id',
    'IF NOT EXISTS(SELECT 1 FROM public.super_admins WHERE user_id=v_actor)',
    'SELECT count(DISTINCT m.organization_id) INTO v_count',
    "IF v_count<>1 THEN RAISE EXCEPTION 'hermes_ordinary_org_ambiguous'"]) assert(sql.includes(value), value);
}
function mappedScope(sql) {
  for (const value of ['SELECT unnest(v_c.scope_ids) AS id INTERSECT SELECT unnest(v_p.scope_ids) AS id',
    'NOT(p_scope_ids<@v_allowed) OR NOT(v_allowed<@p_scope_ids)',
    'cardinality(p_scope_ids)>256', 's.id=requested.id AND s.organization_id=p_organization_id',
    "v_inherited_unrestricted:=v_c.permission_mode='inherit_crm' AND v_c.scope_mode='unrestricted'",
    'a.id=s.area_id AND a.organization_id=p_organization_id AND (a.deleted_at IS NULL OR v_inherited_unrestricted)',
    'b.id=s.building_id AND b.organization_id=p_organization_id AND (b.deleted_at IS NULL OR v_inherited_unrestricted)',
    'JOIN public.areas a ON a.id=ab.area_id AND a.organization_id=ab.organization_id AND a.deleted_at IS NULL',
    'JOIN public.buildings b ON b.id=ab.building_id AND b.organization_id=ab.organization_id AND b.deleted_at IS NULL',
    'ab.organization_id=p_organization_id AND ab.building_id=ANY(v_buildings)',
    "s.id=ANY(p_scope_ids) AND s.scope_type='AREA' AND s.area_id=ab.area_id",
    'jsonb_array_length(v_scopes)<>cardinality(p_scope_ids)', 'jsonb_array_length(v_edges)>=4096',
    "'permissionBuildingIds',to_jsonb(v_buildings)", "'binding',jsonb_build_object('connectionId',v_c.id,'epoch',v_c.epoch,'policyVersion',v_p.version",
    "'membershipId',v_member.id,'authorizationVersion',p_expected_authorization_version,'sessionRevision',v_s.revision"]) {
    assert(sql.includes(value), value);
  }
  assert.doesNotMatch(sql, /\bLIMIT\b|\bOFFSET\b|require_perm_v1/i);
}

test('final room decision uses one STABLE snapshot and the canonical boolean plus concrete scope resolver', () => coherentDecision(source));
test('final map binds actual assistant JWT session, token, lifecycle, capabilities and every expected version', () => ownershipFence(source));
test('membership identity/time/ordinary-org rules match Hermes strict semantics with explicit superadmin membership', () => membershipParity(source));
test('mapping uses exact company intersection, same-org nodes, inherited-only tombstones and live building/AREA edges', () => mappedScope(source));

test('canonical scope/context dependencies are STABLE in their source definitions', () => {
  const definitions = [
    ['20260725190000_authz_read_rpcs.sql', 'public.get_authorization_context_v1'],
    ['20261017023242_hermes_scope_buildings_v1.sql', 'public.hermes_scope_buildings_v1'],
    ['20260908162757_authz_scope_org_wide_scoped_deny_v1.sql', 'app_private.authorized_scope_v3'],
  ];
  for (const [filename, name] of definitions) {
    const definition = splitSqlStatements(readFileSync(join(directory, filename), 'utf8')).map(clean)
      .find(sql => new RegExp(`^CREATE OR REPLACE FUNCTION ${name.replace('.', '\\.')}\\(`, 'i').test(sql));
    assert(definition, name); assert.match(definition.split(/\bAS \$/i)[0], /\bSTABLE\b/i);
  }
});

for (const [name, contract, from, to] of [
  ['mixed-snapshot volatility', coherentDecision, 'LANGUAGE plpgsql STABLE SECURITY DEFINER', 'LANGUAGE plpgsql VOLATILE SECURITY DEFINER'],
  ['missing actual provider-session binding', ownershipFence, "AND provider_session_id::text=auth.jwt()->>'session_id'", ''],
  ['missing token-digest binding', ownershipFence, 'token_digest=p_token_digest AND ', ''],
  ['missing policy epoch fence', ownershipFence, ' OR v_p.version<>p_expected_policy_version', ''],
  ['disabled policy bypass', ownershipFence, 'v_c.scope_ids) WHERE enabled', 'v_c.scope_ids)'],
  ['unbounded neutral policy', ownershipFence, 'p_organization_id,v_c.read_capabilities,v_c.action_capabilities,v_c.scope_ids', 'p_organization_id,NULL,NULL,NULL'],
  ['missing session revision fence', ownershipFence, ' OR v_s.revision<>p_expected_session_revision', ''],
  ['broadened assistant scope union', mappedScope, 'INTERSECT SELECT unnest(v_p.scope_ids)', 'UNION SELECT unnest(v_p.scope_ids)'],
  ['tombstone exception for restricted selection', mappedScope, "v_c.permission_mode='inherit_crm' AND v_c.scope_mode='unrestricted'", "v_c.permission_mode='inherit_crm'"],
  ['deleted AREA grants live edge', mappedScope, 'a.organization_id=ab.organization_id AND a.deleted_at IS NULL', 'a.organization_id=ab.organization_id'],
  ['deleted BUILDING grants live edge', mappedScope, 'b.organization_id=ab.organization_id AND b.deleted_at IS NULL', 'b.organization_id=ab.organization_id'],
  ['missing ordinary single-org rule', membershipParity, "IF v_count<>1 THEN RAISE EXCEPTION 'hermes_ordinary_org_ambiguous'", "IF false THEN RAISE EXCEPTION 'hermes_ordinary_org_ambiguous'"],
]) test(`mutation witness rejects ${name}`, () => {
  const mutated = source.replace(from, to); assert.notEqual(mutated, source, 'mutation must change the source');
  assert.throws(() => contract(mutated));
});

test('mutation witness rejects replacing explicit disabled policy with a neutral ceiling', () => {
  const policy = find('app_private.hermes_effective_org_policy_v1');
  const changed = policy.replace('IF FOUND THEN RETURN v_policy', 'IF FOUND AND v_policy.enabled THEN RETURN v_policy');
  assert.notEqual(changed, policy);
  assert.throws(() => ownershipFence(source, changed), /explicit disabled or empty policy/);
});
