import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath =
  'supabase/migrations/20260829040000_copilot_feature_flags_rls_v1.sql';

describe('Copilot feature flag RLS hardening migration', () => {
  it('enables RLS and leaves browser roles with no direct table policy', () => {
    const migration = readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');

    expect(migration).toMatch(
      /ALTER TABLE public\.copilot_feature_flags\s+ENABLE ROW LEVEL SECURITY/i,
    );
    expect(migration).toMatch(
      /ALTER TABLE public\.copilot_feature_flag_audit\s+ENABLE ROW LEVEL SECURITY/i,
    );
    expect(migration).not.toMatch(
      /CREATE POLICY[\s\S]+ON public\.copilot_feature_flags/i,
    );
    expect(migration).not.toMatch(
      /CREATE POLICY[\s\S]+ON public\.copilot_feature_flag_audit/i,
    );
  });
});
