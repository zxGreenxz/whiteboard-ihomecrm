import { describe, expect, it } from 'vitest';

import { boCommentSql, docSql } from './helpers/sqlTestUtils';

const migration = boCommentSql(
  docSql('supabase/migrations/20260908113634_copilot_member_role_directory_v1.sql'),
);

function functionBody(source: string, name: string): string {
  const start = source.search(
    new RegExp(`create or replace function public\\.${name}\\s*\\(`, 'i'),
  );
  if (start < 0) return '';
  const rest = source.slice(start + 1);
  const acl = rest.search(/^REVOKE ALL ON FUNCTION/mi);
  return acl < 0 ? source.slice(start) : source.slice(start, start + 1 + acl);
}

describe('copilot member-role directory migration', () => {
  const body = () => functionBody(migration, 'copilot_member_role_directory_v1');

  it('is one lock-bounded, replayable transaction', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(migration).toContain("SET LOCAL lock_timeout = '15s';");
  });

  it('is authenticated, stable, and denied by the dedicated member-role rollout by default', () => {
    expect(body()).toMatch(/auth\.uid\(\)/);
    expect(body()).toMatch(/LANGUAGE plpgsql STABLE SECURITY DEFINER/);
    expect(body()).toMatch(/SET search_path = pg_catalog, public, app_private/);
    expect(body()).toMatch(/copilot_page_flag_allows_v1\('copilot\.members-roles\.directory', p_organization_id\)/);
    expect(migration).toMatch(/'page',\s*'copilot\.members-roles\.directory',\s*'disabled'/);
  });

  it('requires users.view in exactly the selected organization and rejects a partial scope', () => {
    expect(body()).toMatch(/authorized_scope_v3\('users\.view', p_organization_id\)/);
    expect(body()).toMatch(/COALESCE\(v_org_wide, false\)/);
    expect(body().match(/m\.organization_id = p_organization_id/g)).toHaveLength(3);
    expect(body()).toMatch(/r\.organization_id = p_organization_id/);
    expect(body()).toMatch(/rb\.organization_id = p_organization_id/);
  });

  it('returns only bounded redacted role-state facts and excludes personal and permission-detail columns', () => {
    expect(body()).toMatch(/least\(greatest\(coalesce\(p_limit, 20\), 1\), 50\)/);
    expect(body()).toMatch(/LIMIT v_limit/);
    expect(body()).toMatch(/'ma_thanh_vien'/);
    expect(body()).toMatch(/'so_quyen_hieu_luc'/);
    expect(body()).not.toMatch(/profiles|auth\.users|email|full_name|user_id|permission_key|authorization_scopes/i);
  });

  it('grants the ABI only to authenticated callers and proves catalog properties', () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.copilot_member_role_directory_v1\([^)]*\) FROM PUBLIC, anon, authenticated, service_role;/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.copilot_member_role_directory_v1\([^)]*\) TO authenticated;/);
    const acceptance = migration.slice(migration.indexOf('DO $nghiem_thu$'));
    expect(acceptance).toContain('to_regprocedure');
    expect(acceptance).toContain('has_function_privilege');
    expect(acceptance).not.toMatch(/FROM public\.[a-z_]+/i);
  });
});
