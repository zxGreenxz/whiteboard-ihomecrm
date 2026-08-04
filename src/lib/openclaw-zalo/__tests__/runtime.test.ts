import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { isOpenClawEnabled, resolveOpenClawMode } from "../runtime";

/**
 * The switch that decides whether an unfinished cockpit is reachable in a build.
 *
 * It exists because the server permission cannot do this job. `openclaw_zalo.view`
 * is granted to the owner role of every organization, the real one included, so it
 * answers "who may use this" - not "is this finished". Without a build-time flag,
 * the first deploy of this branch would put Tasks 26/28/29-incomplete screens in
 * front of real owners.
 */
describe("OpenClaw runtime flag", () => {
  it("is off when nothing is configured", () => {
    // The default has to be off, not on: a feature that ships by forgetting to set
    // a variable is a feature nobody decided to ship.
    expect(resolveOpenClawMode(undefined, false)).toBe("off");
    expect(resolveOpenClawMode("", false)).toBe("off");
    expect(resolveOpenClawMode("   ", true)).toBe("off");
    expect(isOpenClawEnabled(resolveOpenClawMode(undefined, true))).toBe(false);
  });

  it("refuses demo in a production build", () => {
    // A stray VITE_OPENCLAW_ZALO_MODE=demo in the Vercel project would otherwise
    // open the cockpit on ptcrm.vercel.app, which is exactly the accident this
    // guard exists to make impossible.
    expect(resolveOpenClawMode("demo", true)).toBe("off");
    expect(resolveOpenClawMode("demo", false)).toBe("demo");
  });

  it("opens only for an exact, deliberate value", () => {
    expect(resolveOpenClawMode("production", true)).toBe("production");
    expect(resolveOpenClawMode("PRODUCTION", true)).toBe("production");
    for (const wrong of ["prod", "on", "true", "1", "enabled", "productions"]) {
      expect(resolveOpenClawMode(wrong, false), wrong).toBe("off");
    }
  });

  it("gates the route, the way Network Center already does", () => {
    // Asserted against App.tsx rather than described in prose: a flag nothing
    // consults is not a flag. The route must sit inside the conditional.
    const app = readFileSync("src/App.tsx", "utf8");
    expect(app).toContain("OPENCLAW_RUNTIME_ENABLED");
    const guarded = /OPENCLAW_RUNTIME_ENABLED \? \([\s\S]{0,600}?path="\/openclaw-zalo"/u;
    expect(app, "the /openclaw-zalo route is not inside the flag").toMatch(guarded);
  });
});
