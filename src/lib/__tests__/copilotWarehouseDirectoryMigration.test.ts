import { describe, expect, it } from 'vitest';

import { boCommentSql, docSql } from './helpers/sqlTestUtils';

const migration = boCommentSql(
  docSql('supabase/migrations/20260908115524_copilot_warehouse_directory_v1.sql'),
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

describe('copilot warehouse directory migration', () => {
  const body = () => functionBody(migration, 'copilot_warehouse_directory_v1');

  it('is one lock-bounded, replayable transaction', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(migration).toContain("SET LOCAL lock_timeout = '15s';");
  });

  it('is authenticated, stable, and denied by the dedicated warehouse rollout by default', () => {
    expect(body()).toMatch(/auth\.uid\(\)/);
    expect(body()).toMatch(/LANGUAGE plpgsql STABLE SECURITY DEFINER/);
    expect(body()).toMatch(/SET search_path = pg_catalog, public, app_private/);
    expect(body()).toMatch(/copilot_page_flag_allows_v1\('copilot\.warehouses\.directory', p_organization_id\)/);
    expect(migration).toMatch(/'page',\s*'copilot\.warehouses\.directory',\s*'disabled'/);
  });

  it('requires warehouses.view in the selected organization and enforces the derived building scope', () => {
    expect(body()).toMatch(/copilot_org_scope_buildings_v1\('warehouses\.view', p_organization_id\)/);
    expect(body()).toMatch(/authorized_scope_v3\('warehouses\.view', p_organization_id\)/);
    expect(body()).toMatch(/w\.organization_id = p_organization_id/);
    expect(body()).toMatch(/b\.organization_id = p_organization_id/);
    expect(body()).toMatch(/w\.building_id = ANY\(v_buildings\)/);
    expect(body()).toMatch(/w\.building_id IS NULL AND v_org_wide/);
  });

  it('returns only a bounded warehouse name, location and authorized building without ownership identifiers', () => {
    expect(body()).toMatch(/least\(greatest\(coalesce\(p_limit, 20\), 1\), 50\)/);
    expect(body()).toMatch(/LIMIT v_limit/);
    expect(body()).toMatch(/'ma'/);
    expect(body()).toMatch(/'vi_tri'/);
    expect(body()).toMatch(/'toa_nha'/);
    expect(body()).not.toMatch(/'user_id'|'organization_id'|profiles|auth\.users|email|full_name/i);
  });

  it('grants the ABI only to authenticated callers and proves catalog properties', () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.copilot_warehouse_directory_v1\([^)]*\) FROM PUBLIC, anon, authenticated, service_role;/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.copilot_warehouse_directory_v1\([^)]*\) TO authenticated;/);
    const acceptance = migration.slice(migration.indexOf('DO $nghiem_thu$'));
    expect(acceptance).toContain('to_regprocedure');
    expect(acceptance).toContain('has_function_privilege');
    expect(acceptance).not.toMatch(/FROM public\.[a-z_]+/i);
  });
});
