import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationDir = join(process.cwd(), 'supabase', 'migrations');

let corpusCache: { file: string; sql: string }[] | null = null;
function migrationCorpus(): { file: string; sql: string }[] {
  if (!corpusCache) {
    corpusCache = readdirSync(migrationDir)
      .filter((file) => file.endsWith('.sql'))
      .sort()
      .map((file) => ({ file, sql: readFileSync(join(migrationDir, file), 'utf8').replace(/\r\n/g, '\n') }));
  }
  return corpusCache;
}

/** The live definition is the last forward CREATE for this qualified function. */
function liveDefinitionOf(schema: string, functionName: string): { file: string; sql: string } {
  const startPattern = new RegExp(
    `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+${schema}\\.${functionName}\\s*\\(`,
    'i',
  );
  let hit: { file: string; sql: string } | null = null;
  for (const migration of migrationCorpus()) {
    const start = migration.sql.search(startPattern);
    if (start < 0) continue;
    const tail = migration.sql.slice(start);
    const end = tail.search(/\$fn\$;/i);
    if (end < 0) throw new Error(`${migration.file}: incomplete ${schema}.${functionName}`);
    hit = { file: migration.file, sql: tail.slice(0, end + '$fn$;'.length) };
  }
  if (!hit) throw new Error(`Missing ${schema}.${functionName}`);
  return hit;
}

const buildingHelper = liveDefinitionOf('public', 'copilot_org_scope_buildings_v1');
const cashbookHelper = liveDefinitionOf('app_private', 'copilot_scope_cashbooks_v1');

describe('Copilot organization scope semantics migrations', () => {
  it.each([buildingHelper, cashbookHelper])(
    '$file requires a non-revoked active membership before resolving scope',
    ({ sql }) => {
      expect(sql).toMatch(/m\.status\s*=\s*'ACTIVE'[\s\S]{0,180}m\.revoked_at\s+IS\s+NULL/i);
      expect(sql).toMatch(/COALESCE\(m\.valid_from,[\s\S]{0,100}m\.valid_to\s+IS\s+NULL/i);
    },
  );

  it.each([buildingHelper, cashbookHelper])('$file keeps a valid empty resource set empty', ({ sql }) => {
    expect(sql).toContain("RETURN COALESCE(v_scope, '{}'::uuid[])");
    expect(sql).not.toMatch(/cardinality\(v_scope\)[\s\S]{0,120}RAISE EXCEPTION 'not_permitted'/i);
  });

  it.each([buildingHelper, cashbookHelper])('$file delegates resource authority to the canonical resolver', ({ sql }) => {
    expect(sql).toMatch(/app_private\.authorized_scope_v3\(p_permission_key, p_organization_id\)/i);
    expect(sql).not.toMatch(/IF\s+public\.is_super_admin\(\)/i);
  });

  it('projects only the resolver final building IDs into active selected-organization resources', () => {
    expect(buildingHelper.sql).toMatch(
      /unnest\(COALESCE\(s\.building_ids,\s*'\{\}'::uuid\[\]\)\)[\s\S]{0,300}b\.organization_id\s*=\s*p_organization_id[\s\S]{0,100}b\.deleted_at\s+IS\s+NULL/i,
    );
    expect(buildingHelper.sql).not.toMatch(/WHEN\s+s\.org_wide\s+THEN/i);
  });
});
