import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The organization selector is the first thing a user touches in OpenClaw. Listing
 * every membership meant it offered organizations the route guard then bounced them
 * out of, with no explanation - and it made the sidebar entry look wrong when the
 * sidebar was right: having the permission in ANY organization is exactly when the
 * entry belongs there.
 */
const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260727060000_openclaw_rpc_surface.sql"),
  "utf8",
).replace(/\r\n/gu, "\n");

function functionBody(name: string): string {
  const start = migration.indexOf(`create or replace function public.${name}(`);
  expect(start, `${name} is missing`).toBeGreaterThan(-1);
  const end = migration.indexOf("$function$;", start);
  expect(end).toBeGreaterThan(start);
  return migration.slice(start, end);
}

describe("organization selector scope", () => {
  it("lists only organizations where the caller holds openclaw_zalo.view", () => {
    const body = functionBody("openclaw_list_my_organizations_v1");
    expect(body).toContain("openclaw_authorized_org_ids_v1('openclaw_zalo.view')");
    // The raw membership list must no longer be the filter: it is every organization
    // the user belongs to, regardless of this product's permission.
    expect(body).not.toMatch(/where organization\.id = any\(public\.my_org_ids\(\)\)/u);
  });

  it("still requires authentication before listing anything", () => {
    const body = functionBody("openclaw_list_my_organizations_v1");
    expect(body).toContain("authentication required");
    expect(body).toContain("42501");
  });

  it("keeps using the shared authorization helper rather than a local copy", () => {
    // A hand-rolled permission check here would drift from the guard's own check,
    // which is the failure this whole finding is about.
    const body = functionBody("openclaw_list_my_organizations_v1");
    expect(body).not.toMatch(/authorized_scope_v3|role_bindings|permission_key\s*=/u);
  });
});
