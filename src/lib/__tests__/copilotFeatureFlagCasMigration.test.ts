import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath =
  'supabase/migrations/20260829030000_copilot_feature_flags_cas_v2.sql';
const migration = existsSync(migrationPath)
  ? readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n')
  : '';

describe('Copilot feature flag CAS rollout migration', () => {
  it('introduces an expected-revision super-admin transition boundary', () => {
    expect(migration).toMatch(
      /FUNCTION public\.set_copilot_feature_flag_v2\([\s\S]*p_expected_revision\s+bigint[\s\S]*\)/i,
    );
    expect(migration).toContain('auth.uid()');
    expect(migration).toContain('public.is_super_admin()');
    expect(migration).toContain("RAISE EXCEPTION 'not_permitted'");
    expect(migration).toContain("RAISE EXCEPTION 'rollout_evidence_required'");
  });

  it('serializes transitions and rejects stale global revisions', () => {
    expect(migration).toContain("pg_advisory_xact_lock(hashtext('copilot_feature_rollout_global')");
    expect(migration).toMatch(/SELECT[\s\S]*FROM public\.copilot_feature_flags[\s\S]*FOR UPDATE/i);
    expect(migration).toContain('p_expected_revision');
    expect(migration).toContain('copilot_rollout_stale_revision');
    expect(migration).toContain('40001');
    expect(migration).toContain('last_value');
  });

  it('clears the transition-only write marker before returning', () => {
    expect(migration).toMatch(
      /UPDATE public\.copilot_feature_flags[\s\S]*set_config\('app\.copilot_feature_flag_transition',\s*'',\s*true\)/i,
    );
  });

  it('attaches the guarded revision trigger to the flag table', () => {
    expect(migration).toMatch(
      /CREATE TRIGGER trg_copilot_feature_flags_bump_revision[\s\S]*ON public\.copilot_feature_flags/i,
    );
  });

  it('enforces the disabled-shadow-enabled graph and explicit rollback', () => {
    expect(migration).toContain("p_state = 'enabled'");
    expect(migration).toContain("v_row.state = 'disabled'");
    expect(migration).toContain("v_row.state = 'shadow'");
    expect(migration).toContain("v_row.state = 'enabled'");
    expect(migration).toContain('invalid_rollout_transition');
    expect(migration).toContain("p_state = 'disabled'");
  });

  it('keeps audit and snapshot boundaries safe while retiring the unguarded setter', () => {
    expect(migration).toContain('copilot_feature_flag_audit_immutable');
    expect(migration).toMatch(/BEFORE UPDATE OR DELETE ON public\.copilot_feature_flag_audit/i);
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.set_copilot_feature_flag_v1');
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.set_copilot_feature_flag_v2',
    );
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.get_my_copilot_availability_v1\([\s\S]*last_value[\s\S]*states/i,
    );
    expect(migration).not.toMatch(/max\(f\.revision\)/i);
  });
});
