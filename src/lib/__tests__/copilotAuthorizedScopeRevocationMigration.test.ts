import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationDirectory = join(process.cwd(), 'supabase', 'migrations');

function liveAuthorizedScopeDefinition(): { file: string; sql: string } {
  const definition = /create or replace function app_private\.authorized_scope_v3\s*\(/i;
  let live: { file: string; sql: string } | null = null;

  for (const file of readdirSync(migrationDirectory)
    .filter((entry) => entry.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(join(migrationDirectory, file), 'utf8').replace(/\r\n/g, '\n');
    if (definition.test(sql)) live = { file, sql };
  }

  if (!live) throw new Error('Không tìm thấy định nghĩa authorized_scope_v3 trong migration.');
  return live;
}

function authorizedScopeBody(sql: string): string {
  const start = sql.search(
    /create or replace function app_private\.authorized_scope_v3\s*\(/i,
  );
  if (start < 0) return '';
  const end = sql.indexOf('\n$fn$;', start);
  return end < 0 ? sql.slice(start) : sql.slice(start, end + '\n$fn$;'.length);
}

describe('authorized_scope_v3 membership revocation migration', () => {
  it('keeps the live shared resolver in a safe forward definition', () => {
    const { file, sql } = liveAuthorizedScopeDefinition();
    expect(file).toMatch(/^\d{14}_.+\.sql$/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION app_private\.authorized_scope_v3/i);
    expect(sql).toMatch(/SET search_path TO 'pg_catalog', 'app_private', 'public'/i);
    expect(sql).toMatch(/SECURITY DEFINER/i);
  });

  it('excludes revoked memberships inside the resolver membership CTE', () => {
    const body = authorizedScopeBody(liveAuthorizedScopeDefinition().sql);
    expect(body).toMatch(
      /membership as \([\s\S]*?m\.status\s*=\s*'ACTIVE'[\s\S]*?m\.revoked_at\s+is\s+null[\s\S]*?\),\s*\n\s*emergency as/i,
    );
  });

  it('keeps organization-wide access false after a scoped DENY', () => {
    const body = authorizedScopeBody(liveAuthorizedScopeDefinition().sql);
    expect(body).toMatch(/when\s+coalesce\(cardinality\(r\.d_b\),\s*0\)\s*>\s*0\s+then\s+false/i);
    expect(body).toMatch(/when\s+coalesce\(cardinality\(r\.d_c\),\s*0\)\s*>\s*0\s+then\s+false/i);
  });
});
