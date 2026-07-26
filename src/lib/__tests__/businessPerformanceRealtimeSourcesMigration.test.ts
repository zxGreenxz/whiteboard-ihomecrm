import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260726030000_business_performance_realtime_sources.sql",
);
const historicalMigrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260704120000_realtime_business_tables.sql",
);
const advisoryLockKey = "20260726030000";

const sql = existsSync(migrationPath)
  ? readFileSync(migrationPath, "utf8").replace(/\r\n/g, "\n")
  : "";
const historicalSql = readFileSync(historicalMigrationPath, "utf8").replace(
  /\r\n/g,
  "\n",
);

function publicationSourceTables(source: string): string[] {
  const tableArray = source.match(
    /FOREACH\s+\w+\s+IN\s+ARRAY\s+ARRAY\[([^\]]+)]/i,
  );
  return Array.from(
    tableArray?.[1].matchAll(/'([^']+)'/g) ?? [],
    ([, table]) => table,
  );
}

const forbiddenNonPublicationChanges = [
  /\b(?:GRANT|REVOKE)\b/i,
  /\b(?:CREATE|ALTER|DROP)\s+POLICY\b/i,
  /\b(?:ENABLE|DISABLE|FORCE)\s+ROW\s+LEVEL\s+SECURITY\b/i,
  /\b(?:CREATE(?:\s+OR\s+REPLACE)?|ALTER|DROP)\s+(?:MATERIALIZED\s+)?VIEW\b/i,
  /\bREPLICA\s+IDENTITY\b/i,
] as const;

describe("business performance realtime sources migration", () => {
  it("adds exactly rooms and buildings in one forward transaction", () => {
    expect(existsSync(migrationPath), `Missing migration: ${migrationPath}`).toBe(
      true,
    );
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(publicationSourceTables(sql)).toEqual(["rooms", "buildings"]);
  });

  it("serializes concurrent publication changes with a stable transaction lock", () => {
    const lockPattern = new RegExp(
      `SELECT\\s+pg_advisory_xact_lock\\(\\s*${advisoryLockKey}::bigint\\s*\\)\\s*;`,
      "i",
    );
    expect(sql.match(/\bpg_advisory_xact_lock\b/gi)).toHaveLength(1);
    expect(sql).toMatch(lockPattern);

    const beginIndex = sql.indexOf("BEGIN;");
    const lockIndex = sql.search(lockPattern);
    const publicationBlockIndex = sql.indexOf("DO $$");
    const commitIndex = sql.indexOf("COMMIT;");
    expect(beginIndex).toBeLessThan(lockIndex);
    expect(lockIndex).toBeLessThan(publicationBlockIndex);
    expect(publicationBlockIndex).toBeLessThan(commitIndex);
  });

  it("guards each quoted dynamic ADD TABLE against publication membership", () => {
    expect(sql).toContain("FROM pg_publication_tables");
    expect(sql).toContain("pubname = 'supabase_realtime'");
    expect(sql).toContain("schemaname = 'public'");
    expect(sql).toContain("tablename = t");
    expect(sql).toContain(
      "EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);",
    );
    expect(sql).toMatch(/IF NOT EXISTS\s*\([\s\S]*pg_publication_tables[\s\S]*\) THEN/i);
    expect(sql.match(/\bALTER\s+PUBLICATION\b/gi)).toHaveLength(1);
    expect(sql.match(/\bADD\s+TABLE\b/gi)).toHaveLength(1);
    expect(sql.match(/\bEXECUTE\b/gi)).toHaveLength(1);
    expect(sql).toMatch(
      /FOREACH\s+\w+\s+IN\s+ARRAY\s+ARRAY\[[^\]]+]\s+LOOP[\s\S]*?IF\s+NOT\s+EXISTS\s*\([\s\S]*?pg_publication_tables[\s\S]*?\)\s+THEN[\s\S]*?EXECUTE\s+format\([\s\S]*?ALTER\s+PUBLICATION\s+supabase_realtime\s+ADD\s+TABLE\s+public\.%I[\s\S]*?END\s+IF\s*;[\s\S]*?END\s+LOOP\s*;/i,
    );
  });

  it("is additive only and leaves the historical publication migration unchanged", () => {
    expect(sql).not.toMatch(/\bSET\s+TABLE\b/i);
    for (const forbidden of forbiddenNonPublicationChanges) {
      expect(sql).not.toMatch(forbidden);
    }
    expect(publicationSourceTables(historicalSql)).toEqual([
      "invoices",
      "income_expenses",
      "contracts",
      "jobs",
      "customers",
    ]);
    expect(historicalSql).not.toMatch(/['"](?:rooms|buildings)['"]/i);
  });
});
