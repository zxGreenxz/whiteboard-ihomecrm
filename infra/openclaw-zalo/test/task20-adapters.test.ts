import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  COMMANDS as RECOVERY_COMMANDS,
  findPlaintextSessionArtifacts,
  parseArguments as parseRecovery,
} from "../scripts/openclaw-recovery-adapter.mjs";
import {
  COMMANDS as MIGRATION_COMMANDS,
  parseArguments as parseMigration,
  snapshotDigest,
} from "../scripts/openclaw-migration-adapter.mjs";

const root = resolve(import.meta.dirname, "../../..");
const ORG = "dddd0000-0000-4000-8000-000000000001";
const OLD_CELL = "dddd2000-0000-4000-8000-000000000001";
const NEW_CELL = "dddd2000-0000-4000-8000-000000000002";

const recoveryAdapter = resolve(root, "infra/openclaw-zalo/scripts/openclaw-recovery-adapter.mjs");
const migrationAdapter = resolve(root, "infra/openclaw-zalo/scripts/openclaw-migration-adapter.mjs");

function runAdapter(adapter: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [adapter, ...args], {
    encoding: "utf8",
    // A deliberately EMPTY infrastructure environment unless the test supplies one.
    env: { PATH: process.env.PATH ?? "", ...env },
  });
}

describe("Task 20 recovery and migration adapters", () => {
  it("covers exactly the subcommands the reviewed scripts invoke", () => {
    // The scripts are the specification: every `run_adapter <x>` / `run <x>` must
    // exist, and the adapter must expose nothing beyond them.
    const drill = spawnSync("git", ["show", "HEAD:infra/openclaw-zalo/scripts/restore-drill.sh"], {
      cwd: root,
      encoding: "utf8",
    });
    const migrate = spawnSync("git", ["show", "HEAD:infra/openclaw-zalo/scripts/migrate-cell.sh"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(drill.status, drill.stderr).toBe(0);
    expect(migrate.status, migrate.stderr).toBe(0);

    const invoked = (source: string, verb: string) =>
      new Set(
        // `\\s` not `\s`: inside a template literal an unrecognised escape collapses
        // to the bare letter, which would silently miss every indented call.
        [...source.matchAll(new RegExp(`^\\s*${verb} ([a-z0-9-]+)`, "gmu"))].map((match) => match[1]!),
      );
    const drillSteps = invoked(drill.stdout, "run_adapter");
    const migrateSteps = invoked(migrate.stdout, "run");
    expect(drillSteps.size).toBeGreaterThan(5);
    expect(migrateSteps.size).toBeGreaterThan(10);
    for (const step of drillSteps) expect(Object.keys(RECOVERY_COMMANDS)).toContain(step);
    for (const step of migrateSteps) expect(Object.keys(MIGRATION_COMMANDS)).toContain(step);
    expect(new Set(Object.keys(RECOVERY_COMMANDS))).toEqual(drillSteps);
    expect(new Set(Object.keys(MIGRATION_COMMANDS))).toEqual(migrateSteps);
  });

  /**
   * Facades the adapters call that are not implemented yet. An adapter step naming
   * one of these fails closed at the RPC, which is safe but means that step can
   * never pass. The list is allowed to SHRINK only: adding a new unimplemented
   * facade fails this test, so the gap can never grow silently again.
   */
  const PENDING_FACADES = new Set([
    "openclaw_service_begin_restore_drill_v1",
    "openclaw_service_verify_restore_drill_v1",
    "openclaw_service_sync_migration_history_v1",
    "openclaw_service_run_migration_smoke_v1",
    "openclaw_service_verify_canonical_stores_v1",
  ]);

  it("calls only facades that exist, or ones tracked as explicitly pending", async () => {
    const { readFile, readdir } = await import("node:fs/promises");
    const migrationDirectory = resolve(root, "supabase/migrations");
    const migrations = (await Promise.all(
      (await readdir(migrationDirectory))
        .filter((name) => name.endsWith(".sql"))
        .map((name) => readFile(resolve(migrationDirectory, name), "utf8")),
    )).join("\n");

    const called = new Set<string>();
    for (const adapter of [recoveryAdapter, migrationAdapter]) {
      const source = await readFile(adapter, "utf8");
      for (const match of source.matchAll(/"(openclaw_service_[a-z0-9_]+)"/gu)) {
        called.add(match[1]!);
      }
    }
    expect(called.size).toBeGreaterThan(10);

    const missing = [...called].filter(
      (facade) => !migrations.includes(`create or replace function public.${facade}(`),
    );
    // Every gap must be a KNOWN gap.
    expect(missing.filter((facade) => !PENDING_FACADES.has(facade))).toEqual([]);
    // And the pending list must not outlive the gap: once a facade ships, drop it
    // from PENDING_FACADES so this assertion keeps its teeth.
    expect([...PENDING_FACADES].filter((facade) => !missing.includes(facade))).toEqual([]);
  });

  it("rejects unknown subcommands, unknown flags, and repeats as usage errors", () => {
    for (const argv of [
      ["not-a-step", "--organization", ORG, "--cell", OLD_CELL],
      ["r2-verify-restored", "--object-id", OLD_CELL, "--organization", ORG, "--cell", OLD_CELL, "--extra", "x"],
      ["r2-verify-restored", "--object-id", OLD_CELL, "--object-id", OLD_CELL, "--organization", ORG, "--cell", OLD_CELL],
      ["r2-verify-restored", "--organization", ORG, "--cell", OLD_CELL],
    ]) {
      expect(() => parseRecovery(argv)).toThrow();
    }
    // A flag that migrate-cell.sh always passes is mandatory: its absence means the
    // caller is not the reviewed script.
    expect(() => parseMigration([
      "drain-outbox", "--stop-new-claims",
      "--organization", ORG, "--old-cell", OLD_CELL, "--new-cell", NEW_CELL,
    ])).toThrow(/return-leased-to-queue/u);
  });

  it("fails closed - never silently succeeds - when infrastructure is absent", () => {
    const result = runAdapter(recoveryAdapter, [
      "supabase-verify-canonical",
      "--maximum-rpo-seconds", "900",
      "--maximum-rto-seconds", "14400",
      "--organization", ORG,
      "--cell", OLD_CELL,
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/OPENCLAW_RECOVERY_SUPABASE_URL is required/u);
    expect(result.stderr).toMatch(/never exercised/u);

    const migration = runAdapter(migrationAdapter, [
      "global-stop", "--scope", "organization", "--reason", "planned-vps-migration",
      "--organization", ORG, "--old-cell", OLD_CELL, "--new-cell", NEW_CELL,
    ]);
    expect(migration.status).toBe(1);
    expect(migration.stdout).toBe("");
    expect(migration.stderr).toMatch(/never happened/u);
  });

  it("refuses to mutate anything outside the DEMO organization", () => {
    const result = runAdapter(recoveryAdapter, [
      "prove-no-plaintext-session-snapshot", "--runtime-root", "/srv/openclaw-runtime",
      "--organization", "aaaa0000-0000-4000-8000-000000000001", "--cell", OLD_CELL,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/DEMO/u);
  });

  it("enforces the never-copy rules that make a migration safe", () => {
    for (const [args, pattern] of [
      [["require-fresh-qr-login", "--copy-session", "always"], /copy-session must be never/u],
      [
        ["verify-external-canonical-stores", "--supabase-copy", "true", "--r2-copy", "false"],
        /never copied/u,
      ],
      [["controlled-smoke", "--one-send-ceiling", "5", "--cleanup-required"], /exactly 1/u],
      [
        ["resume-organization", "--permission", "openclaw_zalo.view", "--reason", "x"],
        /manage_operations/u,
      ],
    ] as const) {
      const result = runAdapter(migrationAdapter, [
        ...args, "--organization", ORG, "--old-cell", OLD_CELL, "--new-cell", NEW_CELL,
      ]);
      expect(result.status).toBe(64);
      expect(result.stderr).toMatch(pattern);
    }
  });

  it("detects plaintext session artifacts and reports digests, never paths", () => {
    const workspace = mkdtempSync(join(tmpdir(), "openclaw-plaintext-"));
    mkdirSync(join(workspace, "cells", "alpha"), { recursive: true });
    writeFileSync(join(workspace, "cells", "alpha", "encrypted.bin"), "ciphertext");
    const clean = findPlaintextSessionArtifacts(workspace);
    expect(clean.found).toHaveLength(0);
    expect(clean.scanned).toBeGreaterThan(0);

    writeFileSync(join(workspace, "cells", "alpha", "credentials.json"), "{}");
    writeFileSync(join(workspace, "cells", "alpha", "zalo.cookie"), "x");
    const dirty = findPlaintextSessionArtifacts(workspace);
    expect(dirty.found).toHaveLength(2);
    // Digests only: a path in evidence would leak where session material lives.
    for (const digest of dirty.found) {
      expect(digest).toMatch(/^[0-9a-f]{16}$/u);
      expect(workspace).not.toContain(digest);
    }
  });

  it("does not follow symlinks out of the runtime root", () => {
    const workspace = mkdtempSync(join(tmpdir(), "openclaw-symlink-"));
    const outside = mkdtempSync(join(tmpdir(), "openclaw-outside-"));
    writeFileSync(join(outside, "credentials.json"), "{}");
    try {
      symlinkSync(outside, join(workspace, "escape"), "dir");
    } catch {
      return; // Windows without developer mode cannot create the link; skip.
    }
    expect(findPlaintextSessionArtifacts(workspace).found).toHaveLength(0);
  });

  it("digests a co-tenant snapshot stably regardless of key order", () => {
    const first = snapshotDigest({
      "9router": { image: "decolua/9router", restartCount: 0 },
      cell: { image: "ihome/openclaw", restartCount: 1 },
    });
    const second = snapshotDigest({
      cell: { image: "ihome/openclaw", restartCount: 1 },
      "9router": { image: "decolua/9router", restartCount: 0 },
    });
    expect(first).toBe(second);
  });

  it("notices a change in ANY nested field, not just an added or removed container", () => {
    // The previous assertion only ever varied the container-name set, so it passed
    // while `compare-cotenants --fail-on-change` was blind to every nested field:
    // a co-tenant could be restarted onto a new image with new ports and still
    // digest identically. Each mutation below keeps the same container names.
    const baseline = {
      "9router": {
        id: "aaa",
        image: "decolua/9router@sha256:1111",
        network: ["bridge"],
        mounts: ["bind:/var/lib/9router:/data"],
        restartCount: 0,
        ports: ["20128/tcp"],
      },
      cell: { id: "bbb", image: "ihome/openclaw@sha256:2222", restartCount: 1 },
    };
    const digest = snapshotDigest(baseline);
    const mutations = [
      { ...baseline, "9router": { ...baseline["9router"], id: "zzz" } },
      { ...baseline, "9router": { ...baseline["9router"], image: "decolua/9router@sha256:9999" } },
      { ...baseline, "9router": { ...baseline["9router"], network: ["bridge", "host"] } },
      { ...baseline, "9router": { ...baseline["9router"], mounts: ["bind:/etc:/etc"] } },
      { ...baseline, "9router": { ...baseline["9router"], restartCount: 1 } },
      { ...baseline, "9router": { ...baseline["9router"], ports: ["20128/tcp", "443/tcp"] } },
      { ...baseline, cell: { ...baseline.cell, restartCount: 2 } },
    ];
    for (const mutated of mutations) {
      expect(snapshotDigest(mutated), JSON.stringify(mutated)).not.toBe(digest);
    }
  });

  it("holds no verb that could mutate an external co-tenant", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(migrationAdapter, "utf8");
    // Read-only inventory only: inspect and ps. Anything that changes a container
    // would put the external 9Router host inside this adapter's reach.
    expect(source).not.toMatch(
      /"(?:stop|restart|kill|rm|exec|update|pause)"|docker\s+(?:stop|restart|kill|rm|exec)/u,
    );
    expect(source).toMatch(/execFileSync\(\s*"docker",\s*\[\s*"inspect"/u);
    // `docker compose up` is the only verb that CREATES containers, so it is the
    // only path that could reach a co-tenant. It must be guarded by the forbidden
    // name list, not merely accompanied by a comment about it.
    expect(source).toMatch(/for \(const pattern of FORBIDDEN_CONTAINER_PATTERNS\)/u);
    const guardIndex = source.indexOf("FORBIDDEN_CONTAINER_PATTERNS)");
    const composeIndex = source.indexOf('"compose", "--project-name"');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(composeIndex).toBeGreaterThan(guardIndex);
    // Rootless socket only: a rootful socket would put the external 9Router host
    // inside this adapter's reach. Matched loosely because the source writes the
    // path inside a regex literal, where every slash is escaped.
    expect(source).toMatch(/unix:[^\n]*run[^\n]*user[^\n]*docker[^\n]*sock/u);
  });
});
