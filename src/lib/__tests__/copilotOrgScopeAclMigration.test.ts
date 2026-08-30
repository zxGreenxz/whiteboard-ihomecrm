import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath =
  'supabase/migrations/20260829050000_copilot_org_scope_acl_v1.sql';

describe('Copilot organization scope ACL migration', () => {
  it('removes anonymous execution from the server-only scope helper', () => {
    const migration = readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');

    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.copilot_org_scope_buildings_v1(text,uuid) FROM PUBLIC, anon',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.copilot_org_scope_buildings_v1(text,uuid) TO authenticated',
    );
  });
});
