import { describe, expect, it } from 'vitest';

import { boCommentSql, docSql } from './helpers/sqlTestUtils';

const migration = boCommentSql(
  docSql('supabase/migrations/20260908101105_copilot_service_directory_v1.sql'),
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

describe('copilot service directory migration', () => {
  const body = () => functionBody(migration, 'copilot_service_directory_v1');

  it('is one lock-bounded, replayable transaction', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(migration).toContain("SET LOCAL lock_timeout = '15s';");
  });

  it('is authenticated, stable, and restricted to the services page rollout', () => {
    expect(body()).toMatch(/auth\.uid\(\)/);
    expect(body()).toMatch(/LANGUAGE plpgsql STABLE SECURITY DEFINER/);
    expect(body()).toMatch(/SET search_path = pg_catalog, public, app_private/);
    expect(body()).toMatch(/copilot_page_flag_allows_v1\('services\.list', p_organization_id\)/);
  });

  it('uses services.view scope and only exposes active links to permitted buildings', () => {
    expect(body()).toMatch(/copilot_org_scope_buildings_v1\('services\.view', p_organization_id\)/);
    expect(body()).toMatch(/authorized_scope_v3\('services\.view', p_organization_id\)/);
    expect(body()).toMatch(/s\.organization_id = p_organization_id/);
    expect(body()).toMatch(/bs\.organization_id = p_organization_id/);
    expect(body()).toMatch(/bs\.building_id = ANY\(v_buildings\)/);
    expect(body()).toMatch(/bs\.is_active/);
    expect(body()).toMatch(/s\.user_id = ANY\(public\.current_visible_owner_ids\(\)\)/);
    expect(body()).toMatch(/s\.deleted_at IS NULL/);
  });

  it('returns bounded service and applicable-price facts without free text or quota internals', () => {
    expect(body()).toMatch(/least\(greatest\(coalesce\(p_limit, 20\), 1\), 50\)/);
    expect(body()).toMatch(/LIMIT v_limit/);
    expect(body()).toMatch(/'gia_mac_dinh'/);
    expect(body()).toMatch(/'toa_ap_dung'/);
    expect(body()).not.toMatch(/description|quota_id|service_quota/i);
  });

  it('grants the ABI only to authenticated callers and proves catalog properties', () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.copilot_service_directory_v1\([^)]*\) FROM PUBLIC, anon, authenticated, service_role;/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.copilot_service_directory_v1\([^)]*\) TO authenticated;/);
    const acceptance = migration.slice(migration.indexOf('DO $nghiem_thu$'));
    expect(acceptance).toContain('to_regprocedure');
    expect(acceptance).toContain('has_function_privilege');
    expect(acceptance).not.toMatch(/FROM public\.[a-z_]+/i);
  });
});
