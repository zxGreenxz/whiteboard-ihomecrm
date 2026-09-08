import { describe, expect, it } from 'vitest';
import { boCommentSql, docSql } from './helpers/sqlTestUtils';

const migration = boCommentSql(docSql('supabase/migrations/20260908153826_copilot_auto_debt_status_v1.sql'));

function body(source: string): string {
  const start = source.search(/create or replace function public\.copilot_auto_debt_status_v1\s*\(/i);
  if (start < 0) return '';
  const rest = source.slice(start + 1);
  const acl = rest.search(/^REVOKE ALL ON FUNCTION/mi);
  return acl < 0 ? source.slice(start) : source.slice(start, start + 1 + acl);
}

describe('copilot automatic-debt status migration', () => {
  const fn = () => body(migration);

  it('is one lock-bounded, replayable transaction', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(migration).toContain("SET LOCAL lock_timeout = '15s';");
  });

  it('is authenticated, stable, and disabled by default', () => {
    expect(fn()).toMatch(/auth\.uid\(\)/);
    expect(fn()).toMatch(/LANGUAGE plpgsql STABLE SECURITY DEFINER/);
    expect(fn()).toMatch(/copilot_page_flag_allows_v1\('copilot\.auto-debt\.status', p_organization_id\)/);
    expect(migration).toMatch(/'page',\s*'copilot\.auto-debt\.status',\s*'disabled'/);
  });

  it('requires organization-wide auto_debt.view and selected-organization rows only', () => {
    expect(fn()).toMatch(/authorized_scope_v3\('auto_debt\.view', p_organization_id\)/);
    expect(fn()).toMatch(/scope\.org_wide/);
    expect(fn()).toMatch(/c\.organization_id = p_organization_id/);
    expect(fn()).toMatch(/c\.building_id IS NULL OR \(b\.id IS NOT NULL AND b\.deleted_at IS NULL\)/);
  });

  it('returns only bounded configuration state, never bank account, rules, owner, or internal identifiers', () => {
    expect(fn()).toMatch(/least\(greatest\(coalesce\(p_limit, 20\), 1\), 50\)/);
    expect(fn()).toMatch(/LIMIT v_limit/);
    expect(fn()).toMatch(/'pham_vi'/);
    expect(fn()).toMatch(/'trang_thai'/);
    expect(fn()).toMatch(/'da_cau_hinh_tai_khoan'/);
    expect(fn()).toMatch(/'da_cau_hinh_quy_tac'/);
    expect(fn()).not.toMatch(/jsonb_build_object\([^)]*'bank_account'|jsonb_build_object\([^)]*'matching_rules'|jsonb_build_object\([^)]*'user_id'|jsonb_build_object\([^)]*'id'/i);
  });

  it('grants the ABI only to authenticated callers and proves ACL properties', () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.copilot_auto_debt_status_v1\([^)]*\) FROM PUBLIC, anon, authenticated, service_role;/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.copilot_auto_debt_status_v1\([^)]*\) TO authenticated;/);
    const acceptance = migration.slice(migration.indexOf('DO $nghiem_thu$'));
    expect(acceptance).toContain('to_regprocedure');
    expect(acceptance).toContain('has_function_privilege');
  });
});
