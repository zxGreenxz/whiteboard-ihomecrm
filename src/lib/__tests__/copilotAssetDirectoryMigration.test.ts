import { describe, expect, it } from 'vitest';

import { boCommentSql, docSql } from './helpers/sqlTestUtils';

const migration = boCommentSql(
  docSql('supabase/migrations/20260908094448_copilot_asset_directory_v1.sql'),
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

describe('copilot asset directory migration', () => {
  const body = () => functionBody(migration, 'copilot_asset_directory_v1');

  it('is one lock-bounded, replayable transaction', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(migration).toContain("SET LOCAL lock_timeout = '15s';");
  });

  it('is authenticated, stable, and restricted to the assets page rollout', () => {
    expect(body()).toMatch(/auth\.uid\(\)/);
    expect(body()).toMatch(/LANGUAGE plpgsql STABLE SECURITY DEFINER/);
    expect(body()).toMatch(/SET search_path = pg_catalog, public, app_private/);
    expect(body()).toMatch(/copilot_page_flag_allows_v1\('assets\.list', p_organization_id\)/);
  });

  it('uses assets.view scope and mirrors the org-level asset boundary', () => {
    expect(body()).toMatch(/copilot_org_scope_buildings_v1\('assets\.view', p_organization_id\)/);
    expect(body()).toMatch(/authorized_scope_v3\('assets\.view', p_organization_id\)/);
    expect(body()).toMatch(/a\.organization_id = p_organization_id/);
    expect(body()).toMatch(/b\.id = ANY\(v_buildings\)/);
    expect(body()).toMatch(/a\.user_id = ANY\(public\.current_visible_owner_ids\(\)\)/);
    expect(body()).toMatch(/a\.deleted_at IS NULL/);
  });

  it('returns only bounded operational facts, never purchase or supplier data', () => {
    expect(body()).toMatch(/least\(greatest\(coalesce\(p_limit, 20\), 1\), 50\)/);
    expect(body()).toMatch(/LIMIT v_limit/);
    expect(body()).toMatch(/'tinh_trang'/);
    expect(body()).toMatch(/'bao_tri_gan_nhat'/);
    expect(body()).not.toMatch(/purchase_price|supplier_id|description|images/i);
  });

  it('grants the ABI only to authenticated callers and proves catalog properties', () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.copilot_asset_directory_v1\([^)]*\) FROM PUBLIC, anon, authenticated, service_role;/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.copilot_asset_directory_v1\([^)]*\) TO authenticated;/);
    const acceptance = migration.slice(migration.indexOf('DO $nghiem_thu$'));
    expect(acceptance).toContain('to_regprocedure');
    expect(acceptance).toContain('has_function_privilege');
    expect(acceptance).not.toMatch(/FROM public\.[a-z_]+/i);
  });
});
