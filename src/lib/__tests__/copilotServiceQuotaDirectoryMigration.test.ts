import { describe, expect, it } from 'vitest';
import { boCommentSql, docSql } from './helpers/sqlTestUtils';

const migration = boCommentSql(docSql('supabase/migrations/20260908142038_copilot_service_quota_directory_v1.sql'));

function body(source: string): string {
  const start = source.search(/create or replace function public\.copilot_service_quota_directory_v1\s*\(/i);
  if (start < 0) return '';
  const rest = source.slice(start + 1);
  const acl = rest.search(/^REVOKE ALL ON FUNCTION/mi);
  return acl < 0 ? source.slice(start) : source.slice(start, start + 1 + acl);
}

describe('copilot service-quota directory migration', () => {
  const fn = () => body(migration);

  it('is one lock-bounded, replayable transaction', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(migration).toContain("SET LOCAL lock_timeout = '15s';");
  });

  it('is authenticated, stable, and disabled by default', () => {
    expect(fn()).toMatch(/auth\.uid\(\)/);
    expect(fn()).toMatch(/LANGUAGE plpgsql STABLE SECURITY DEFINER/);
    expect(fn()).toMatch(/copilot_page_flag_allows_v1\('copilot\.service-quotas\.directory', p_organization_id\)/);
    expect(migration).toMatch(/'page',\s*'copilot\.service-quotas\.directory',\s*'disabled'/);
  });

  it('requires service_quotas.view and joins tier facts only within the selected organization', () => {
    expect(fn()).toMatch(/authorized_scope_v3\('service_quotas\.view', p_organization_id\)/);
    expect(fn()).toMatch(/q\.organization_id = p_organization_id/);
    expect(fn()).toMatch(/t\.organization_id = p_organization_id/);
  });

  it('returns only bounded quota names and tier ranges/prices, excluding notes and ownership', () => {
    expect(fn()).toMatch(/least\(greatest\(coalesce\(p_limit, 20\), 1\), 50\)/);
    expect(fn()).toMatch(/LIMIT v_limit/);
    expect(fn()).toMatch(/'ten'/);
    expect(fn()).toMatch(/'bac'/);
    expect(fn()).toMatch(/'tu'/);
    expect(fn()).toMatch(/'den'/);
    expect(fn()).toMatch(/'don_gia'/);
    expect(fn()).not.toMatch(/description|'user_id'|'organization_id'|profiles|auth\.users|email|full_name/i);
  });

  it('grants the ABI only to authenticated callers and proves ACL properties', () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.copilot_service_quota_directory_v1\([^)]*\) FROM PUBLIC, anon, authenticated, service_role;/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.copilot_service_quota_directory_v1\([^)]*\) TO authenticated;/);
    const acceptance = migration.slice(migration.indexOf('DO $nghiem_thu$'));
    expect(acceptance).toContain('to_regprocedure');
    expect(acceptance).toContain('has_function_privilege');
  });
});
