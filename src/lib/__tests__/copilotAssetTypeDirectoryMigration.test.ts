import { describe, expect, it } from 'vitest';

import { boCommentSql, docSql } from './helpers/sqlTestUtils';

const migration = boCommentSql(
  docSql('supabase/migrations/20260908124611_copilot_asset_type_directory_v1.sql'),
);

function functionBody(source: string, name: string): string {
  const pattern = new RegExp('create or replace function public\\.' + name + '\\s*\\(', 'i');
  const start = source.search(pattern);
  if (start < 0) return '';
  const rest = source.slice(start + 1);
  const acl = rest.search(/^REVOKE ALL ON FUNCTION/mi);
  return acl < 0 ? source.slice(start) : source.slice(start, start + 1 + acl);
}

describe('copilot asset-type directory migration', () => {
  const body = () => functionBody(migration, 'copilot_asset_type_directory_v1');

  it('is one lock-bounded, replayable transaction', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(migration).toContain("SET LOCAL lock_timeout = '15s';");
  });

  it('is authenticated, stable, and denied by the dedicated asset-type rollout by default', () => {
    expect(body()).toMatch(/auth\.uid\(\)/);
    expect(body()).toMatch(/LANGUAGE plpgsql STABLE SECURITY DEFINER/);
    expect(body()).toMatch(/SET search_path = pg_catalog, public, app_private/);
    expect(body()).toMatch(/copilot_page_flag_allows_v1\('copilot\.asset-types\.directory', p_organization_id\)/);
    expect(migration).toMatch(/'page',\s*'copilot\.asset-types\.directory',\s*'disabled'/);
  });

  it('requires asset_types.view in the selected organization', () => {
    expect(body()).toMatch(/authorized_scope_v3\('asset_types\.view', p_organization_id\)/);
    expect(body()).toMatch(/COALESCE\(v_org_wide, false\)/);
    expect(body()).toMatch(/c\.organization_id = p_organization_id/);
  });

  it('returns only bounded derived code and type name, excluding descriptions and ownership fields', () => {
    expect(body()).toMatch(/least\(greatest\(coalesce\(p_limit, 20\), 1\), 50\)/);
    expect(body()).toMatch(/LIMIT v_limit/);
    expect(body()).toMatch(/'ma'/);
    expect(body()).toMatch(/'ten'/);
    expect(body()).not.toMatch(/'user_id'|'organization_id'|'description'|profiles|auth\.users|full_name/i);
  });

  it('grants the ABI only to authenticated callers and proves catalog properties', () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.copilot_asset_type_directory_v1\([^)]*\) FROM PUBLIC, anon, authenticated, service_role;/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.copilot_asset_type_directory_v1\([^)]*\) TO authenticated;/);
    const acceptance = migration.slice(migration.indexOf('DO $nghiem_thu$'));
    expect(acceptance).toContain('to_regprocedure');
    expect(acceptance).toContain('has_function_privilege');
    expect(acceptance).not.toMatch(/FROM public\.[a-z_]+/i);
  });
});
