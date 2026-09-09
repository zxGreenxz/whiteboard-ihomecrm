import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationDirectory = join(process.cwd(), 'supabase', 'migrations');

function liveAuthorizedScopeDefinition(): string {
  const definition = /create or replace function app_private\.authorized_scope_v3\s*\(/i;
  let live = '';

  for (const file of readdirSync(migrationDirectory)
    .filter((entry) => entry.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(join(migrationDirectory, file), 'utf8').replace(/\r\n/g, '\n');
    if (definition.test(sql)) live = sql;
  }

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

describe('authorized_scope_v3 scoped-deny correction', () => {
  it('does not report organization-wide access after a building or cashbook DENY', () => {
    const body = authorizedScopeBody(liveAuthorizedScopeDefinition());
    expect(body).toMatch(/when\s+coalesce\(cardinality\(r\.d_b\),\s*0\)\s*>\s*0\s+then\s+false/i);
    expect(body).toMatch(/when\s+coalesce\(cardinality\(r\.d_c\),\s*0\)\s*>\s*0\s+then\s+false/i);
    expect(body).toMatch(/else\s+r\.a_org\s+end\s+as\s+org_wide/i);
  });
});
