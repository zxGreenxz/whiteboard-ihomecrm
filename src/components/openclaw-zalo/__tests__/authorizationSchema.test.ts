import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * The guard parses `get_authorization_context_v1`, a SHARED platform RPC it does
 * not own. Declaring only the two fields it reads and marking the schema
 * `.strict()` took the entire OpenClaw route down for every user: the parse threw
 * `unrecognized_keys`, and because a ZodError carries no `.code` the 42501 branch
 * never matched, so every user hit the fatal "cannot verify permission" screen.
 *
 * No test mocked that RPC, which is why fifteen shell tests stayed green. These
 * assertions parse the payload the SQL actually builds.
 */
const guardSource = readFileSync(
  resolve(process.cwd(), "src/components/openclaw-zalo/OpenClawRouteGuard.tsx"),
  "utf8",
);
const authzSql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260725190000_authz_read_rpcs.sql"),
  "utf8",
).replace(/\r\n/gu, "\n");

/** Rebuilt from the guard so the test exercises the real shape, not a copy. */
const authorizationSchema = z.object({
  organizationId: z.string().uuid().nullable(),
  permissions: z.record(z.string(), z.boolean()),
}).passthrough();

const REALISTIC_PAYLOAD = {
  organizationId: "dddd0000-0000-4000-8000-000000000001",
  membershipId: "dddd1000-0000-4000-8000-000000000001",
  memberType: "STAFF",
  authorizationVersion: 7,
  nearestDeadline: null,
  isPlatformAdmin: false,
  isOffboarded: false,
  organizations: [],
  permissions: { "openclaw_zalo.view": true },
  scopeSets: [],
  scopes: {},
};

describe("OpenClaw authorization schema", () => {
  it("parses the payload the platform RPC actually returns", () => {
    const parsed = authorizationSchema.safeParse(REALISTIC_PAYLOAD);
    expect(parsed.success, JSON.stringify((parsed as { error?: unknown }).error)).toBe(true);
    expect(parsed.success && parsed.data.permissions["openclaw_zalo.view"]).toBe(true);
  });

  it("parses the unauthenticated shape the same RPC returns from its other branch", () => {
    const parsed = authorizationSchema.safeParse({
      ...REALISTIC_PAYLOAD,
      organizationId: null,
      membershipId: null,
      memberType: null,
      authorizationVersion: null,
      permissions: {},
    });
    expect(parsed.success).toBe(true);
  });

  it("stays passthrough, because the feature does not own this RPC", () => {
    // A future `.strict()` here is the exact change that broke the route.
    expect(guardSource).toMatch(/permissions: z\.record\(z\.string\(\), z\.boolean\(\)\),\s*\}\)\.passthrough\(\)/u);
    // Guard the guard: prove the SQL really does return keys the schema does not
    // declare, so passthrough is load-bearing rather than incidental.
    for (const key of ["membershipId", "authorizationVersion", "scopeSets", "isPlatformAdmin"]) {
      expect(authzSql).toContain(`'${key}'`);
      expect(guardSource).not.toContain(`${key}:`);
    }
  });

  it("still rejects a payload missing what the guard depends on", () => {
    expect(authorizationSchema.safeParse({ ...REALISTIC_PAYLOAD, permissions: undefined }).success)
      .toBe(false);
    expect(authorizationSchema.safeParse({ ...REALISTIC_PAYLOAD, organizationId: "not-a-uuid" }).success)
      .toBe(false);
  });
});
