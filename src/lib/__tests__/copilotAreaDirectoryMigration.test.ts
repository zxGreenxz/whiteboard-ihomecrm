import { describe, expect, it } from 'vitest';

import { boCommentSql, docSql } from './helpers/sqlTestUtils';

const migrationPath =
  'supabase/migrations/20260908085839_copilot_area_directory_v1.sql';
const migration = boCommentSql(docSql(migrationPath));

function functionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`create or replace function public\\.${name}\\s*\\(`, 'i'));
  if (start < 0) return '';
  const rest = source.slice(start + 1);
  const nextFn = rest.search(/CREATE OR REPLACE FUNCTION/i);
  const acl = rest.search(/^REVOKE ALL ON FUNCTION/mi);
  const end = [nextFn, acl].filter((index) => index >= 0);
  return end.length === 0 ? source.slice(start) : source.slice(start, start + 1 + Math.min(...end));
}

describe('copilot area directory migration', () => {
  const body = () => functionBody(migration, 'copilot_area_directory_v1');

  it('is one lock-bounded, replayable transaction', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(migration).toContain("SET LOCAL lock_timeout = '15s';");
    expect(migration).not.toMatch(/^\s*CREATE (?!OR REPLACE)[A-Z]/gm);
  });

  it('keeps the function authenticated, stable and isolated', () => {
    expect(body()).toMatch(/p_organization_id uuid/);
    expect(body()).toMatch(/auth\.uid\(\)/);
    expect(body()).toMatch(/not_permitted/);
    expect(body()).toMatch(/LANGUAGE plpgsql STABLE SECURITY DEFINER/);
    expect(body()).toMatch(/SET search_path = pg_catalog, public, app_private/);
  });

  it('binds every returned area through areas.view and accessible buildings in the selected organization', () => {
    expect(body()).toMatch(/copilot_page_flag_allows_v1\('copilot\.areas\.directory', p_organization_id\)/);
    expect(body()).toMatch(/copilot_org_scope_buildings_v1\('areas\.view', p_organization_id\)/);
    expect(body()).toMatch(/a\.organization_id = p_organization_id/);
    expect(body()).toMatch(/b\.organization_id = p_organization_id/);
    expect(body()).toMatch(/ab\.building_id = ANY\(v_buildings\)/);
    expect(body()).toMatch(/a\.deleted_at IS NULL/);
    expect(body()).toMatch(/b\.deleted_at IS NULL/);
  });

  it('caps and echoes the directory result without returning contact data', () => {
    expect(body()).toMatch(/least\(greatest\(coalesce\(p_limit, 20\), 1\), 50\)/);
    expect(body()).toMatch(/LIMIT v_limit/);
    expect(body()).toMatch(/'gioi_han', v_limit/);
    expect(body()).not.toMatch(/phone|email|contact|owner/i);
  });

  it('makes the public ABI authenticated-only and proves only catalog properties on an empty database', () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.copilot_area_directory_v1\([^)]*\) FROM PUBLIC, anon, authenticated, service_role;/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.copilot_area_directory_v1\([^)]*\) TO authenticated;/);
    const acceptance = migration.slice(migration.indexOf('DO $nghiem_thu$'));
    expect(acceptance).toContain('to_regprocedure');
    expect(acceptance).toContain('has_function_privilege');
    expect(acceptance).not.toMatch(/FROM public\.[a-z_]+/i);
  });

  it('seeds a separate disabled rollout contract for this directory', () => {
    expect(migration).toMatch(/VALUES\s*\(\s*'page',\s*'copilot\.areas\.directory',\s*'disabled'/);
    expect(migration).toMatch(/ON CONFLICT \(scope, contract_id\) DO NOTHING/);
  });
});
