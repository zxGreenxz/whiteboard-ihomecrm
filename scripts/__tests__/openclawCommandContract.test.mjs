import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Pins the SHAPE of the OpenClaw npm commands, not their output.
 *
 * These scripts are what CI runs, so a change that quietly drops a harness from
 * `test:openclaw:sql:fast` removes a gate without any test going red - the suite
 * simply stops running the file. Asserting the command text is the only place that
 * catches it.
 */
const packageJson = JSON.parse(
  readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
);
const scripts = packageJson.scripts ?? {};

/** The twelve reviewed migrations, from the manifest the SQL gate pins. */
const migrationManifest = readFileSync(
  resolve(process.cwd(), "scripts/test-openclaw-migrations.mjs"),
  "utf8",
);

describe("OpenClaw npm command contract", () => {
  it("keeps the three OpenClaw command families", () => {
    for (const name of ["test:openclaw:services", "test:openclaw:sql", "test:openclaw:r2"]) {
      expect(scripts[name], `${name} is missing`).toBeTruthy();
    }
  });

  it("never redirects a generator into the committed types file", () => {
    // `node gen-types > src/integrations/supabase/types.ts` TRUNCATES the file before
    // the generator runs, so a generator that fails - a network blip, a bad PAT -
    // leaves an empty types.ts and breaks the whole app build. The script writes the
    // file itself, atomically.
    for (const [name, command] of Object.entries(scripts)) {
      expect(String(command), `${name} redirects into types.ts`)
        .not.toMatch(/>\s*src\/integrations\/supabase\/types\.ts/u);
    }
    expect(scripts["gen:types"]).toBe("node scripts/gen-supabase-types.mjs");
  });

  it("runs every SQL harness that exists, so adding one cannot be forgotten", () => {
    // A harness file that no command references is a gate nobody runs. This compares
    // the directory against the command rather than restating a list.
    const command = String(scripts["test:openclaw:sql:fast"] ?? "");
    for (const harness of openclawSqlHarnessFiles()) {
      expect(command, `${harness} is never run by test:openclaw:sql:fast`)
        .toContain(harness);
    }
  });

  it("keeps the migration chain and the reset plan in the SQL command", () => {
    const command = String(scripts["test:openclaw:sql:fast"] ?? "");
    for (const step of [
      "scripts/test-openclaw-full-reset.mjs --plan-only",
      "scripts/test-openclaw-migrations.mjs --local",
      "scripts/test-openclaw-sql.mjs --local",
      "scripts/test-openclaw-concurrency.mjs --local",
    ]) {
      expect(command, `${step} is missing`).toContain(step);
    }
  });

  it("pins exactly twelve reviewed migrations", () => {
    // The manifest is what stops a thirteenth file shipping unreviewed; the SQL gate
    // matches it by regex, so an extra file would simply never be gated.
    const names = [...migrationManifest.matchAll(/"(20260727\d{6}_openclaw_[a-z_]+\.sql)"/gu)]
      .map(match => match[1]);
    expect(new Set(names).size).toBe(12);
  });

  it("keeps service commands inside the isolated service and gateway paths", () => {
    // The isolation rule is that OpenClaw code lives under its own directories. A
    // service command reaching into src/ would mean the boundary moved.
    const command = String(scripts["test:openclaw:services"] ?? "");
    for (const prefix of [...command.matchAll(/--prefix\s+(\S+)/gu)].map(match => match[1])) {
      expect(prefix, `${prefix} is outside the isolated service paths`)
        .toMatch(/^(services\/openclaw-|infra\/openclaw-)/u);
    }
  });
});

/** Harness files under scripts/__tests__ that the SQL gate is expected to run. */
function openclawSqlHarnessFiles() {
  return readdirSync(resolve(process.cwd(), "scripts/__tests__"))
    .filter(name => name.startsWith("openclaw-") && name.endsWith(".test.mjs"))
    .map(name => `scripts/__tests__/${name}`);
}
