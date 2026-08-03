import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// The REAL schema, imported - not a copy. An earlier version of this file rebuilt
// the shape by hand while claiming it did not, so tightening the guard's schema
// would have left every assertion here green.
import { authorizationSchema } from "../OpenClawRouteGuard";

/**
 * The guard parses `get_authorization_context_v1`, a SHARED platform RPC it does
 * not own. Declaring only the two fields it reads and marking the schema
 * `.strict()` took the entire OpenClaw route down for every user: the parse threw
 * `unrecognized_keys`, and because a ZodError carries no `.code` the 42501 branch
 * never matched, so every user hit the fatal "cannot verify permission" screen.
 */
const authzSql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260725190000_authz_read_rpcs.sql"),
  "utf8",
).replace(/\r\n/gu, "\n");

/** What the authenticated branch of the RPC builds. */
const AUTHENTICATED_PAYLOAD = {
  organizationId: "dddd0000-0000-4000-8000-000000000001",
  membershipId: "dddd1000-0000-4000-8000-000000000001",
  memberType: "STAFF",
  authorizationVersion: 7,
  isPlatformAdmin: false,
  isOffboarded: false,
  organizations: [],
  permissions: { "openclaw_zalo.view": true },
  scopeSets: [],
  scopes: {},
};

/**
 * What the RPC returns for an authenticated caller with NO membership in the
 * requested organization - the "empty package" branch. It is not the
 * unauthenticated case: that raises 42501, which the guard handles separately.
 */
const EMPTY_PACKAGE_PAYLOAD = {
  ...AUTHENTICATED_PAYLOAD,
  organizationId: null,
  membershipId: null,
  memberType: null,
  authorizationVersion: null,
  nearestDeadline: null,
  permissions: {},
};

describe("OpenClaw authorization schema", () => {
  it("parses both branches the platform RPC can return", () => {
    for (const [label, payload] of [
      ["authenticated", AUTHENTICATED_PAYLOAD],
      ["empty package", EMPTY_PACKAGE_PAYLOAD],
    ] as const) {
      const parsed = authorizationSchema.safeParse(payload);
      expect(parsed.success, `${label}: ${JSON.stringify((parsed as { error?: unknown }).error)}`)
        .toBe(true);
    }
    expect(authorizationSchema.parse(AUTHENTICATED_PAYLOAD).permissions["openclaw_zalo.view"])
      .toBe(true);
  });

  it("accepts a field the platform adds later, which is what passthrough is for", () => {
    // Behavioural, not a source regex: re-introducing `.strict()` fails HERE,
    // and so does any change that stops tolerating upstream additions.
    const parsed = authorizationSchema.safeParse({
      ...AUTHENTICATED_PAYLOAD,
      someFieldAddedUpstreamNextQuarter: { anything: true },
    });
    expect(parsed.success).toBe(true);
  });

  it("still rejects a payload missing or mistyping what the guard depends on", () => {
    const { organizationId: _omitted, ...withoutOrganization } = AUTHENTICATED_PAYLOAD;
    expect(authorizationSchema.safeParse(withoutOrganization).success).toBe(false);
    expect(authorizationSchema.safeParse({ ...AUTHENTICATED_PAYLOAD, organizationId: "nope" }).success)
      .toBe(false);
    expect(authorizationSchema.safeParse({ ...AUTHENTICATED_PAYLOAD, permissions: null }).success)
      .toBe(false);
    // A non-boolean permission value must not be coerced into an entitlement.
    expect(authorizationSchema.safeParse({
      ...AUTHENTICATED_PAYLOAD,
      permissions: { "openclaw_zalo.view": "yes" },
    }).success).toBe(false);
  });

  it("keeps the fixtures honest against the SQL that produces them", () => {
    // Scoped to the one function, not the whole file: a whole-file substring check
    // also matches comments and explain_authorization_v1, so it would stay green
    // even if the key were dropped from get_authorization_context_v1.
    const start = authzSql.indexOf("function public.get_authorization_context_v1");
    expect(start).toBeGreaterThan(-1);
    const body = authzSql.slice(start, authzSql.indexOf("$function$;", start));
    for (const key of Object.keys(AUTHENTICATED_PAYLOAD)) {
      expect(body, `${key} is no longer built by the RPC`).toContain(`'${key}'`);
    }
    // Passthrough is load-bearing precisely because the RPC returns more than the
    // guard declares: prove the fixture really is wider than the schema.
    const declared = Object.keys(
      (authorizationSchema as unknown as { shape: Record<string, unknown> }).shape,
    );
    expect(Object.keys(AUTHENTICATED_PAYLOAD).length).toBeGreaterThan(declared.length);
  });
});
