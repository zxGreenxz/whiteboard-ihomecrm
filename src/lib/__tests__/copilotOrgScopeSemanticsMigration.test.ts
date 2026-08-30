import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20260829090000_copilot_org_scope_semantics_v1.sql',
  'utf8',
).replace(/\r\n/g, '\n');

describe('Copilot organization scope semantics migration', () => {
  it('excludes revoked memberships before resolving scope', () => {
    expect(migration).toMatch(/m\.revoked_at\s+IS\s+NULL/i);
  });

  it('keeps authorized empty organizations as an empty result', () => {
    expect(migration).toContain("RETURN COALESCE(v_scope, '{}'::uuid[])");
    expect(migration).not.toMatch(/cardinality\(v_scope\)[\s\S]{0,120}RAISE EXCEPTION 'not_permitted'/i);
  });

  it('aligns superadmin scope with the selectable non-sandbox directory', () => {
    expect(migration).toContain('public.is_super_admin()');
    expect(migration).toContain('public.sandbox_org_ids()');
  });

  it('does not turn superadmin directory visibility into implicit resource scope', () => {
    // A directory entry only permits selecting an organization. Resource scope
    // must still come from the shared permission/deny resolver.
    expect(migration).toMatch(/app_private\.authorized_scope_v3\(p_permission_key, p_organization_id\)/i);
    const buildingStart = migration.indexOf('CREATE OR REPLACE FUNCTION public.copilot_org_scope_buildings_v1');
    const cashbookStart = migration.indexOf('CREATE OR REPLACE FUNCTION app_private.copilot_scope_cashbooks_v1');
    expect(buildingStart).toBeGreaterThanOrEqual(0);
    expect(cashbookStart).toBeGreaterThan(buildingStart);
    const buildingBody = migration.slice(buildingStart, cashbookStart);
    const cashbookEnd = migration.indexOf('CREATE OR REPLACE FUNCTION public.copilot_cashbook_settlement_v2');
    expect(cashbookEnd).toBeGreaterThan(cashbookStart);
    const cashbookBody = migration.slice(cashbookStart, cashbookEnd);
    expect(buildingBody).not.toMatch(/IF\s+public\.is_super_admin\(\)/i);
    expect(cashbookBody).not.toMatch(/IF\s+public\.is_super_admin\(\)/i);
  });

  it('requires a non-revoked active membership before delegating to scope resolution', () => {
    expect(migration).toMatch(
      /m\.status\s*=\s*'ACTIVE'[\s\S]{0,180}m\.revoked_at\s+IS\s+NULL/i,
    );
  });
});
