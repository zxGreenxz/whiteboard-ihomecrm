import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20260828170000_copilot_feature_flags_v1.sql',
  'utf8',
).replace(/\r\n/g, '\n');

describe('Copilot server availability migration', () => {
  it('defines the fail-closed feature flag table and audit trail', () => {
    expect(migration).toMatch(/CREATE TABLE(?: IF NOT EXISTS)? public\.copilot_feature_flags/);
    expect(migration).toContain("scope text NOT NULL CHECK (scope IN ('page', 'action'))");
    expect(migration).toMatch(/state text NOT NULL[\s\S]*CHECK \(state IN \('disabled', 'shadow', 'enabled'\)\)/);
    expect(migration).toContain('contract_id text NOT NULL');
    expect(migration).toContain('canary_org uuid');
    expect(migration).toContain('updated_by uuid');
    expect(migration).toContain('copilot_feature_flag_audit');
    expect(migration).toContain('copilot_feature_rollout_revision_seq');
    expect(migration).toContain('reason text NOT NULL');
    expect(migration).toContain('evidence_link text NOT NULL');
    expect(migration).toContain('rollback_reference text NOT NULL');
    expect(migration).toContain('REVOKE ALL ON TABLE public.copilot_feature_flags FROM PUBLIC, anon, authenticated');
  });

  it('derives actor and organization scope in the authenticated-only availability RPC', () => {
    expect(migration).toMatch(/FUNCTION public\.get_my_copilot_availability_v1\([\s\S]*p_organization_id uuid/);
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path = pg_catalog, public, app_private');
    expect(migration).toContain('auth.uid()');
    expect(migration).toContain('authorized_scope_v3');
    expect(migration).toContain("'organization_id'");
    expect(migration).toContain("'actor_user_id'");
    expect(migration).toContain("'revision'");
    expect(migration).toContain("'fetched_at'");
    expect(migration).toContain("'digest'");
    expect(migration).toContain("'states'");
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.get_my_copilot_availability_v1(uuid) FROM PUBLIC, anon');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.get_my_copilot_availability_v1(uuid) TO authenticated');
    expect(migration).toContain("x ->> 'scope'");
    expect(migration).toContain("x ->> 'contract_id'");
    expect(migration).toContain('f.expires_at > v_fetched_at');
  });

  it('provides a super-admin transition RPC with a global revision and bounded canary metadata', () => {
    expect(migration).toMatch(/FUNCTION public\.set_copilot_feature_flag_v1\([\s\S]*p_scope text[\s\S]*p_contract_id text[\s\S]*p_state text/);
    expect(migration).toContain('public.is_super_admin()');
    expect(migration).toContain('nextval(\'public.copilot_feature_rollout_revision_seq\')');
    expect(migration).toContain('p_reason text');
    expect(migration).toContain('p_evidence_link text');
    expect(migration).toContain('p_rollback_reference text');
    expect(migration).toContain('p_expires_at timestamptz');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.set_copilot_feature_flag_v1');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.set_copilot_feature_flag_v1');
  });

  it('makes rollout audit append-only', () => {
    expect(migration).toContain('copilot_feature_flag_audit_immutable');
    expect(migration).toMatch(/BEFORE UPDATE OR DELETE ON public\.copilot_feature_flag_audit/);
    expect(migration).toContain("RAISE EXCEPTION 'copilot_feature_flag_audit_immutable'");
  });

  it('does not expose a client update path for flags', () => {
    expect(migration).not.toMatch(/CREATE POLICY[^\n]+copilot_feature_flags[^\n]+FOR (INSERT|UPDATE|DELETE)/i);
    expect(migration).not.toMatch(/\.from\(['"]copilot_feature_flags['"]\).*\.(insert|update|upsert|delete)/i);
  });
});
