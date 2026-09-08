import { describe, expect, it } from 'vitest';
import { boCommentSql, docSql } from './helpers/sqlTestUtils';

const migration = boCommentSql(docSql('supabase/migrations/20260908144903_copilot_asset_maintenance_directory_v1.sql'));

function body(source: string): string {
  const start = source.search(/create or replace function public\.copilot_asset_maintenance_directory_v1\s*\(/i);
  if (start < 0) return '';
  const rest = source.slice(start + 1);
  const acl = rest.search(/^REVOKE ALL ON FUNCTION/mi);
  return acl < 0 ? source.slice(start) : source.slice(start, start + 1 + acl);
}

describe('copilot asset-maintenance directory migration', () => {
  const fn = () => body(migration);

  it('is one lock-bounded, replayable transaction', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(migration).toContain("SET LOCAL lock_timeout = '15s';");
  });

  it('is authenticated, stable, and disabled by default', () => {
    expect(fn()).toMatch(/auth\.uid\(\)/);
    expect(fn()).toMatch(/LANGUAGE plpgsql STABLE SECURITY DEFINER/);
    expect(fn()).toMatch(/copilot_page_flag_allows_v1\('copilot\.assets\.maintenance\.directory', p_organization_id\)/);
    expect(migration).toMatch(/'page',\s*'copilot\.assets\.maintenance\.directory',\s*'disabled'/);
  });

  it('requires assets.view and restricts every maintenance row through its authorized asset scope', () => {
    expect(fn()).toMatch(/authorized_scope_v3\('assets\.view', p_organization_id\)/);
    expect(fn()).toMatch(/copilot_org_scope_buildings_v1\('assets\.view', p_organization_id\)/);
    expect(fn()).toMatch(/m\.organization_id = p_organization_id/);
    expect(fn()).toMatch(/a\.organization_id = p_organization_id/);
    expect(fn()).toMatch(/b\.id = ANY\(v_buildings\)/);
  });

  it('returns only bounded asset, date and state facts without finance, notes or ownership', () => {
    expect(fn()).toMatch(/least\(greatest\(coalesce\(p_limit, 20\), 1\), 50\)/);
    expect(fn()).toMatch(/LIMIT v_limit/);
    expect(fn()).toMatch(/'ma'/);
    expect(fn()).toMatch(/'tai_san'/);
    expect(fn()).toMatch(/'ngay'/);
    expect(fn()).toMatch(/'trang_thai'/);
    expect(fn()).not.toMatch(/cost|notes|assigned_to|user_id|issue_description|profiles|auth\.users|email|full_name/i);
  });

  it('grants the ABI only to authenticated callers and proves ACL properties', () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.copilot_asset_maintenance_directory_v1\([^)]*\) FROM PUBLIC, anon, authenticated, service_role;/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.copilot_asset_maintenance_directory_v1\([^)]*\) TO authenticated;/);
    const acceptance = migration.slice(migration.indexOf('DO $nghiem_thu$'));
    expect(acceptance).toContain('to_regprocedure');
    expect(acceptance).toContain('has_function_privilege');
  });
});
