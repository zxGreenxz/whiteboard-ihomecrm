import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { mediaResolveContract } from "../action-contracts";

/**
 * `actionContracts.test.ts` builds its "representative response" from the very
 * schema under test, so it can only compare a schema with itself. That is how
 * `mediaResolveContract` shipped `.strict()` without `version` while the RPC always
 * returns `version`: every real response threw `unrecognized_keys` and no test noticed.
 *
 * These assertions take the SQL as the source of truth instead.
 */
const migrationDirectory = resolve(process.cwd(), "supabase/migrations");
const migrations = readdirSync(migrationDirectory)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFileSync(resolve(migrationDirectory, name), "utf8"))
  .join("\n")
  .replace(/\r\n/gu, "\n");

/** Top-level literal keys of the jsonb_build_object starting at `open`. */
function keysAt(body: string, open: number): string[] {
  let depth = 0;
  // Count top-level commas instead of toggling a flag: arguments alternate
  // key,value,key,value, so a quoted string is a KEY only at an even position.
  // Toggling on every comma silently skipped every second key.
  let position = 0;
  const keys: string[] = [];
  for (let index = open + "jsonb_build_object".length; index < body.length; index += 1) {
    const character = body[index];
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth -= 1;
      if (depth === 0) break;
      continue;
    }
    if (depth !== 1) continue;
    if (character === ",") {
      position += 1;
      continue;
    }
    if (character === "'" && position % 2 === 0) {
      const close = body.indexOf("'", index + 1);
      if (close < 0) break;
      keys.push(body.slice(index + 1, close));
      index = close;
    }
  }
  return keys;
}

/** The literal keys the facade's response object is built from. */
function returnedKeys(rpcName: string): string[] {
  const start = migrations.indexOf(`create or replace function public.${rpcName}(`);
  expect(start, `${rpcName} is not defined in any migration`).toBeGreaterThan(-1);
  const body = migrations.slice(start, migrations.indexOf("$function$;", start));
  // A facade may build several objects (guards, nested item projections). The
  // response is the richest one, so pick by key count rather than by position.
  let best: string[] = [];
  for (
    let cursor = body.indexOf("jsonb_build_object(");
    cursor >= 0;
    cursor = body.indexOf("jsonb_build_object(", cursor + 1)
  ) {
    const keys = keysAt(body, cursor);
    if (keys.length > best.length) best = keys;
  }
  expect(best.length, `${rpcName} builds no response object`).toBeGreaterThan(0);
  return best;
}

describe("media resolve contract matches the SQL that produces it", () => {
  it("declares every key the facade actually returns", () => {
    const sqlKeys = returnedKeys(mediaResolveContract.rpcName);
    // Sanity-check the extractor itself, so a silent empty result cannot make the
    // real assertion below vacuously true.
    expect(sqlKeys).toContain("mediaId");
    expect(sqlKeys).toContain("sessionGeneration");
    expect(sqlKeys).toContain("version");

    const declared = Object.keys(
      (mediaResolveContract.resultSchema as unknown as { shape: Record<string, unknown> }).shape,
    );
    expect(sqlKeys.filter((key) => !declared.includes(key))).toEqual([]);
  });

  it("parses the exact payload the facade returns, and still rejects drift", () => {
    const payload = {
      version: 1,
      mediaId: "dddd1000-0000-4000-8000-000000000001",
      organizationId: "dddd0000-0000-4000-8000-000000000001",
      accountId: "dddd1000-0000-4000-8000-000000000002",
      conversationId: "dddd1000-0000-4000-8000-000000000003",
      messageId: "dddd1000-0000-4000-8000-000000000004",
      mime: "image/jpeg",
      byteLength: 2048,
      sha256: "b".repeat(64),
      objectKey: "openclaw/media/x",
      byteState: "AVAILABLE" as const,
      sessionGeneration: 3,
    };
    const parsed = mediaResolveContract.resultSchema.safeParse(payload);
    expect(parsed.success, JSON.stringify((parsed as { error?: unknown }).error)).toBe(true);
    // Strictness is the point of the schema; it must still reject an unknown key.
    expect(mediaResolveContract.resultSchema.safeParse({ ...payload, surprise: true }).success)
      .toBe(false);
  });
});
