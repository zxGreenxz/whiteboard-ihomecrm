import { describe, expect, it } from "vitest";

import {
  assertDemoOrganization,
  DEMO_ORG_ID,
  fixtureMarker,
  requireLocalPreviewEnv,
} from "../../../.e2e-fleet/specs/openclaw-zalo-admin";

/**
 * The OpenClaw E2E fixtures drive a fake adapter, kick sessions and delete
 * retention subjects. Every other spec in the fleet defaults to the production
 * deployment, so the guard that stops these ones inheriting that default is the
 * single thing standing between a mistyped command and damaged tenant data.
 *
 * It is worth testing on its own because it is the one part of Task 26 that can be
 * exercised without a browser or a database - and because a guard nobody ever
 * watched fail is a guard nobody knows works.
 */

const GOOD = {
  FLEET_BASE_URL: "http://127.0.0.1:4173",
  FLEET_OPENCLAW_FIXTURE_ENV: "local-preview",
  FLEET_OPENCLAW_PROJECT_REF: "local",
};

describe("OpenClaw E2E environment guard", () => {
  it("accepts exactly the documented preproduction inputs", () => {
    const env = requireLocalPreviewEnv(GOOD);
    expect(env.baseUrl).toBe("http://127.0.0.1:4173");
    expect(env.fixtureEnv).toBe("local-preview");
    expect(env.projectRef).toBe("local");
    expect(env.markerPrefix).not.toBe("");
  });

  it("refuses when any input is missing, and names which", () => {
    for (const key of Object.keys(GOOD)) {
      const partial = { ...GOOD, [key]: undefined };
      expect(() => requireLocalPreviewEnv(partial), key).toThrow(new RegExp(key, "u"));
    }
    // Empty string is absent, not present-and-blank: an unset shell variable often
    // arrives this way and must not read as "configured".
    expect(() => requireLocalPreviewEnv({ ...GOOD, FLEET_OPENCLAW_PROJECT_REF: "" }))
      .toThrow(/FLEET_OPENCLAW_PROJECT_REF/u);
  });

  it("compares exactly, so a value that merely contains the expected one fails", () => {
    // `http://127.0.0.1:4173.evil.example` contains the expected base URL and
    // `local-copy-of-production` starts with `local`. A lenient check passes both.
    expect(() => requireLocalPreviewEnv({
      ...GOOD, FLEET_BASE_URL: "http://127.0.0.1:4173.evil.example",
    })).toThrow(/FLEET_BASE_URL/u);
    expect(() => requireLocalPreviewEnv({
      ...GOOD, FLEET_OPENCLAW_PROJECT_REF: "local-copy-of-production",
    })).toThrow(/FLEET_OPENCLAW_PROJECT_REF/u);
    expect(() => requireLocalPreviewEnv({
      ...GOOD, FLEET_OPENCLAW_FIXTURE_ENV: "LOCAL-PREVIEW",
    })).toThrow(/FLEET_OPENCLAW_FIXTURE_ENV/u);
  });

  it("says plainly when it has been pointed at production", () => {
    // The generic mismatch message would be technically correct and useless. The
    // person who typed this needs to know what would have happened.
    const message = (() => {
      try {
        requireLocalPreviewEnv({ ...GOOD, FLEET_BASE_URL: "https://ptcrm.vercel.app" });
        return "";
      } catch (error) {
        return String((error as Error).message);
      }
    })();
    expect(message).toContain("production");
    expect(message).toContain("dữ liệu khách hàng thật");
  });

  it("refuses the shared Supabase project by identity", () => {
    expect(() => requireLocalPreviewEnv({
      ...GOOD, FLEET_OPENCLAW_PROJECT_REF: "tryymsxyyckgbrmmvozx",
    })).toThrow(/dùng chung/u);
  });

  it("reports every problem at once rather than one per run", () => {
    // Three runs to learn about three missing variables is three chances to point
    // the fourth run at production out of frustration.
    const message = (() => {
      try {
        requireLocalPreviewEnv({});
        return "";
      } catch (error) {
        return String((error as Error).message);
      }
    })();
    for (const key of Object.keys(GOOD)) expect(message, key).toContain(key);
  });
});

describe("DEMO organization guard", () => {
  it("passes the DEMO organization through", () => {
    expect(assertDemoOrganization(DEMO_ORG_ID)).toBe(DEMO_ORG_ID);
  });

  it("refuses the production organization by identity", () => {
    expect(() => assertDemoOrganization("aaaa0000-0000-4000-8000-000000000001"))
      .toThrow(/production/u);
  });

  it("refuses any other organization too", () => {
    // A guard that only knew the one production id would wave through a second
    // real tenant added later.
    expect(() => assertDemoOrganization("cccc0000-0000-4000-8000-000000000009"))
      .toThrow(/DEMO/u);
  });
});

describe("fixture markers", () => {
  it("prefixes every marker, so cleanup can find its own leavings", () => {
    const env = requireLocalPreviewEnv(GOOD);
    const marker = fixtureMarker(env, "unknown-resolution");
    expect(marker.startsWith(env.markerPrefix)).toBe(true);
    expect(marker).toContain("unknown-resolution");
  });
});
