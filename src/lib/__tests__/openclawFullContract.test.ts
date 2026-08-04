import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every area of the OpenClaw spec must be covered by something, or be explicitly
 * recorded as blocked with a reason.
 *
 * The failure this exists to prevent is silent absence: an area that nobody wrote a
 * test for looks exactly like an area that passes, because there is nothing to run
 * and therefore nothing to go red. Listing the areas and demanding a file per area
 * turns "we forgot" into a failing assertion.
 *
 * `blockedBy` is deliberately part of the contract rather than a comment: a blocked
 * area still has to be declared, and the moment its files appear the entry must
 * move - otherwise a finished area could sit here claiming to be blocked forever.
 */
interface SpecArea {
  key: string;
  /** Files that constitute coverage. At least one must exist. */
  files: readonly string[];
  /** Set only when nothing can cover it yet, with the reason it cannot. */
  blockedBy?: string;
}

const SPEC_AREAS: readonly SpecArea[] = [
  {
    key: "permissions",
    files: [
      "src/hooks/openclaw-zalo/useOpenClawPermissions.ts",
      "src/components/openclaw-zalo/__tests__/authorizationSchema.test.ts",
      "scripts/__tests__/openclaw-browser-privileges.test.mjs",
    ],
  },
  {
    key: "schema-and-rls",
    files: [
      "src/lib/__tests__/openclawZaloMigrations.test.ts",
      "scripts/__tests__/openclaw-sql-harness.test.mjs",
      "scripts/__tests__/openclaw-browser-dml-matrix.test.mjs",
    ],
  },
  {
    key: "cursor-and-realtime",
    files: [
      "src/lib/openclaw-zalo/__tests__/inboxView.test.ts",
      "src/lib/openclaw-zalo/__tests__/stateMachines.property.test.ts",
    ],
  },
  {
    key: "qr-login",
    files: [
      "src/lib/openclaw-zalo/__tests__/qrClient.test.ts",
      "src/lib/openclaw-zalo/__tests__/connection.test.ts",
      "supabase/functions/openclaw-qr/handler.test.ts",
    ],
  },
  {
    key: "ai-draft-and-dlp",
    files: ["src/components/openclaw-zalo/__tests__/inbox.test.tsx"],
  },
  {
    key: "outbox-cas-and-unknown",
    files: [
      "src/lib/openclaw-zalo/__tests__/operations.test.ts",
      "scripts/__tests__/openclaw-concurrency-harness.test.mjs",
    ],
  },
  {
    key: "media",
    files: ["supabase/functions/openclaw-object-tickets/handler.test.ts"],
  },
  {
    key: "runtime-isolation",
    files: [
      "src/lib/__tests__/openclawIsolation.test.ts",
      "scripts/check-openclaw-isolation.mjs",
    ],
  },
  {
    key: "backups-and-migration",
    files: ["infra/openclaw-zalo/test/task20-adapters.test.ts"],
  },
  {
    key: "knowledge-and-automation",
    files: [
      "src/lib/openclaw-zalo/__tests__/knowledge.test.ts",
      "src/lib/openclaw-zalo/__tests__/automationWizard.test.ts",
      "scripts/__tests__/openclaw-knowledge-lifecycle.test.mjs",
    ],
  },
  {
    key: "ui",
    files: [
      "src/components/openclaw-zalo/__tests__/cockpitWiring.test.tsx",
      "src/components/openclaw-zalo/__tests__/operations.test.tsx",
      "src/components/openclaw-zalo/__tests__/globalStop.test.tsx",
    ],
  },
  {
    key: "headless-e2e",
    files: [
      ".e2e-fleet/specs/openclaw-zalo.spec.ts",
      ".e2e-fleet/specs/openclaw-zalo-admin.ts",
      "src/lib/__tests__/openclawE2eGuard.test.ts",
    ],
  },
  {
    // Split out from headless-e2e rather than left inside it: the spec and its
    // environment guard are real, runnable coverage, and folding them into a
    // blocked entry would hide that. What is blocked is narrower and nameable.
    key: "headless-e2e-fake-adapter",
    files: ["supabase/functions/openclaw-fixture/index.ts"],
    blockedBy:
      "The fake adapter drives test-only runtime endpoints that must not exist on a "
      + "production cell, so the scenarios need a local Supabase project - which is "
      + "what the spec's own guard demands (FLEET_OPENCLAW_PROJECT_REF=local). "
      + "`supabase start` requires Docker, and this machine has no Docker, no Docker "
      + "Desktop and no WSL distro, so no local project can be brought up here.",
  },
  {
    key: "rollout",
    files: ["docs/openclaw-zalo/runbooks/vps-migration.md"],
  },
];

const exists = (path: string) => existsSync(resolve(process.cwd(), path));

describe("OpenClaw spec coverage", () => {
  it("covers every area, or records why it cannot be covered yet", () => {
    const uncovered: string[] = [];
    for (const area of SPEC_AREAS) {
      const covered = area.files.some(exists);
      if (covered || area.blockedBy !== undefined) continue;
      uncovered.push(area.key);
    }
    expect(uncovered, "spec areas with neither coverage nor a recorded blocker")
      .toEqual([]);
  });

  it("does not let a blocked area stay blocked once its files exist", () => {
    // Otherwise "blocked" becomes a permanent excuse: the E2E lands, nobody removes
    // the marker, and the area reports as blocked while it is in fact covered.
    for (const area of SPEC_AREAS.filter(item => item.blockedBy !== undefined)) {
      expect(
        area.files.some(exists),
        `${area.key} is marked blocked but ${area.files.join(", ")} now exists - `
          + "remove blockedBy and let the coverage assertion carry it",
      ).toBe(false);
    }
  });

  it("names a real file for every area it claims to cover", () => {
    // A path typo would otherwise read as "this area has no coverage" only in the
    // aggregate, or worse, be masked by a sibling path that does exist.
    for (const area of SPEC_AREAS.filter(item => item.blockedBy === undefined)) {
      for (const file of area.files) {
        expect(exists(file), `${area.key} lists a path that does not exist: ${file}`)
          .toBe(true);
      }
    }
  });

  it("states the blocker in terms of the environment, not of effort", () => {
    // "Not done yet" is not a blocker. A blocker is something the code cannot fix.
    for (const area of SPEC_AREAS.filter(item => item.blockedBy !== undefined)) {
      expect(area.blockedBy!.length, area.key).toBeGreaterThan(40);
      expect(area.blockedBy!, area.key).not.toMatch(/todo|later|chưa làm/iu);
    }
  });
});
