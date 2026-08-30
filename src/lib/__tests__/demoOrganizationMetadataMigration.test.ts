import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath =
  'supabase/migrations/20260829070000_restore_demo_organization_metadata.sql';
const migration = existsSync(migrationPath)
  ? readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n')
  : '';

describe('DEMO organization metadata migration', () => {
  it('guards and restores the canonical DEMO marker', () => {
    expect(migration).toContain('dddd0000-0000-4000-8000-000000000001');
    expect(migration).toContain("slug = 'ihome-demo'");
    expect(migration).toContain("name = 'iHome CRM (Demo)'");
    expect(migration).toContain('is_demo IS DISTINCT FROM true');
    expect(migration).toContain('SET is_demo = true');
  });

  it('fails closed when the canonical organization identity is missing', () => {
    expect(migration).toMatch(/RAISE EXCEPTION[\s\S]*demo organization/i);
    expect(migration).toContain("status = 'ACTIVE'");
  });

  it('does not update any organization outside the canonical DEMO id', () => {
    const updates = migration.match(/UPDATE\s+public\.organizations/gi) ?? [];
    expect(updates).toHaveLength(1);
    expect(migration).toMatch(
      /UPDATE\s+public\.organizations[\s\S]*WHERE[\s\S]*id\s*=\s*'dddd0000-0000-4000-8000-000000000001'/i,
    );
  });
});
