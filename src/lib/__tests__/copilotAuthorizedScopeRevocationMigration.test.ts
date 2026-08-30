import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath =
  'supabase/migrations/20260829100000_copilot_authorized_scope_revocation_v1.sql';
const migration = existsSync(migrationPath)
  ? readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n')
  : '';
const historical = readFileSync(
  'supabase/migrations/20260725070000_authz_read_path_v3.sql',
  'utf8',
).replace(/\r\n/g, '\n');

function authorizedScopeBody(sql: string): string {
  const start = sql.search(
    /create or replace function app_private\.authorized_scope_v3\s*\(/i,
  );
  if (start < 0) return '';
  const end = sql.indexOf('\n$fn$;', start);
  return end < 0 ? sql.slice(start) : sql.slice(start, end + '\n$fn$;'.length);
}

describe('authorized_scope_v3 membership revocation migration', () => {
  it('redefines the shared resolver in a forward migration', () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION app_private\.authorized_scope_v3/i);
    expect(migration).toMatch(/SET search_path TO 'pg_catalog', 'app_private', 'public'/i);
    expect(migration).toMatch(/SECURITY DEFINER/i);
  });

  it('excludes revoked memberships inside the resolver membership CTE', () => {
    const body = authorizedScopeBody(migration);
    expect(body).toMatch(
      /membership as \([\s\S]*?m\.status\s*=\s*'ACTIVE'[\s\S]*?m\.revoked_at\s+is\s+null[\s\S]*?\),\s*\n\s*emergency as/i,
    );
  });

  it('preserves the historical resolver semantics except for the revocation predicate', () => {
    const normalize = (value: string) =>
      authorizedScopeBody(value)
        .replace(/\n\s*and m\.revoked_at is null/i, '')
        .replace(/--[^\n]*/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    expect(normalize(migration)).toBe(normalize(historical));
  });
});
