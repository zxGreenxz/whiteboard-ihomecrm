import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  FULL_RESET_MANIFEST_DOMAIN,
  SUPABASE_CLI_VERSION,
  buildFullResetPlan,
  loadRepositoryMigrationInputs,
  parseSupabaseStatus,
  parseFullResetArgs,
  prepareDisposableFullResetProject,
  runFullResetHarness,
  runFullResetSmokeAssertions,
} from "../test-openclaw-full-reset.mjs";

describe("OpenClaw complete Supabase reset harness", () => {
  it("exposes plan-only and Docker-backed package gates separately", async () => {
    const packageJson = JSON.parse(
      await readFile(join(process.cwd(), "package.json"), "utf8"),
    );
    expect(packageJson.scripts["test:openclaw:sql:full-reset"]).toBe(
      "node scripts/test-openclaw-full-reset.mjs --local",
    );
    expect(packageJson.scripts["test:openclaw:sql:fast"]).toContain(
      "openclaw-full-reset-harness.test.mjs",
    );
    expect(packageJson.scripts["test:openclaw:sql:fast"]).toContain(
      "test-openclaw-full-reset.mjs --plan-only",
    );
    expect(packageJson.scripts["test:openclaw:sql:fast"].indexOf(
      "test-openclaw-full-reset.mjs --plan-only",
    )).toBeLessThan(packageJson.scripts["test:openclaw:sql:fast"].indexOf(
      "test-openclaw-migrations.mjs --local",
    ));
    expect(packageJson.scripts["test:openclaw:sql:fast"]).not.toContain(
      "test-openclaw-full-reset.mjs --local",
    );
    expect(packageJson.scripts["test:openclaw:sql:local"]).toBe(
      "npm run test:openclaw:sql:fast && npm run test:openclaw:sql:full-reset",
    );
  });

  it("maps full filenames to unique ordered versions without changing SQL bytes", () => {
    const inputs = [
      { file: "017_z.sql", bytes: Buffer.from("select 'z';\n") },
      { file: "016_b.sql", bytes: Buffer.from("select 'b';\n") },
      { file: "016_a.sql", bytes: Buffer.from("select 'a';\n") },
    ];
    const plan = buildFullResetPlan(inputs);

    expect(plan.entries.map((entry) => entry.sourceFile)).toEqual([
      "016_a.sql",
      "016_b.sql",
      "017_z.sql",
    ]);
    expect(plan.entries.map((entry) => entry.targetVersion)).toEqual([
      "0161",
      "0162",
      "017",
    ]);
    expect(plan.entries.map((entry) => entry.targetFile)).toEqual([
      "0161_a.sql",
      "0162_b.sql",
      "017_z.sql",
    ]);
    expect(new Set(plan.entries.map((entry) => entry.targetVersion)).size).toBe(3);
    expect(plan.duplicateOriginalVersionGroups).toBe(1);
    for (const entry of plan.entries) {
      const source = inputs.find((input) => input.file === entry.sourceFile);
      expect(entry.bytes.equals(source.bytes)).toBe(true);
      expect(entry.rawSha256).toBe(
        createHash("sha256").update(source.bytes).digest("hex"),
      );
    }
    expect(plan.aggregateSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(FULL_RESET_MANIFEST_DOMAIN).toBe("ihome-openclaw-full-reset-plan-v1");
  });

  it("rejects ambiguous, unsafe, or duplicate source filenames", () => {
    expect(() => buildFullResetPlan([
      { file: "not-a-migration.sql", bytes: Buffer.from("select 1") },
    ])).toThrow(/migration filename/i);
    expect(() => buildFullResetPlan([
      { file: "001_same.sql", bytes: Buffer.from("select 1") },
      { file: "001_same.sql", bytes: Buffer.from("select 2") },
    ])).toThrow(/duplicate migration file/i);
    expect(() => buildFullResetPlan([
      { file: "001_../escape.sql", bytes: Buffer.from("select 1") },
    ])).toThrow(/migration filename/i);
  });

  it("loads the complete current repository chain with all duplicate groups explicit", async () => {
    const inputs = await loadRepositoryMigrationInputs();
    const plan = buildFullResetPlan(inputs);
    expect(plan.entries).toHaveLength(498);
    expect(plan.duplicateOriginalVersionGroups).toBe(18);
    expect(new Set(plan.entries.map((entry) => entry.targetFile)).size).toBe(498);
    const sourceBytes = new Map(inputs.map((input) => [input.file, input.bytes]));
    for (const entry of plan.entries) {
      expect(entry.bytes.equals(sourceBytes.get(entry.sourceFile))).toBe(true);
    }
  });

  it("keeps plan-only read-only and never prepares or invokes Supabase", async () => {
    const loadInputs = vi.fn(loadRepositoryMigrationInputs);
    const prepareProject = vi.fn();
    const runCli = vi.fn();

    const result = await runFullResetHarness({
      args: ["--plan-only"],
      dependencies: { loadInputs, prepareProject, runCli },
    });

    expect(result.summary).toMatch(/PASS.*498-file/i);
    expect(loadInputs).toHaveBeenCalledOnce();
    expect(prepareProject).not.toHaveBeenCalled();
    expect(runCli).not.toHaveBeenCalled();
  });

  it("prepares isolated byte-identical projects with unique Docker ownership", async () => {
    const prepared = await prepareDisposableFullResetProject({
      inputs: [
        { file: "016_a.sql", bytes: Buffer.from("select 'a';\n") },
        { file: "016_b.sql", bytes: Buffer.from("select 'b';\n") },
      ],
      configToml: 'project_id = "production-ref"\n[db]\nmajor_version = 17\n',
    });
    const second = await prepareDisposableFullResetProject({
      inputs: [
        { file: "016_a.sql", bytes: Buffer.from("select 'a';\n") },
        { file: "016_b.sql", bytes: Buffer.from("select 'b';\n") },
      ],
      configToml: 'project_id = "production-ref"\n[db]\nmajor_version = 17\n',
    });
    try {
      const config = await readFile(join(prepared.root, "supabase", "config.toml"), "utf8");
      const secondConfig = await readFile(
        join(second.root, "supabase", "config.toml"),
        "utf8",
      );
      expect(config).toMatch(/project_id = "openclaw_task12_[a-z0-9]+"/);
      expect(config).not.toContain("production-ref");
      expect(secondConfig).not.toBe(config);
      for (const entry of prepared.plan.entries) {
        const copied = await readFile(
          join(prepared.root, "supabase", "migrations", entry.targetFile),
        );
        expect(copied.equals(entry.bytes)).toBe(true);
      }
    } finally {
      await prepared.cleanup();
      await second.cleanup();
    }
  });

  it("pins CLI commands, resets locally, and always destroys disposable state", async () => {
    expect(parseFullResetArgs(["--plan-only"])).toEqual({ mode: "plan-only" });
    expect(parseFullResetArgs(["--local"])).toEqual({ mode: "local" });
    expect(() => parseFullResetArgs([])).toThrow(/explicit/i);
    expect(() => parseFullResetArgs(["--linked"])).toThrow(/explicit/i);

    const cleanup = vi.fn(async () => {});
    const assertReset = vi.fn(async () => {});
    const prepareProject = vi.fn(async () => ({
      root: "C:/temp/openclaw-full-reset",
      plan: {
        entries: Array.from({ length: 498 }, (_, index) => ({ index: index + 1 })),
        duplicateOriginalVersionGroups: 18,
        aggregateSha256: "a".repeat(64),
      },
      cleanup,
    }));
    const runCli = vi
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        stdout: `${SUPABASE_CLI_VERSION}\n`,
        stderr: "",
      })
      .mockResolvedValueOnce({ code: 0, stdout: "started", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "reset", stderr: "" })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({ DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres" }),
        stderr: "",
      })
      .mockResolvedValueOnce({ code: 0, stdout: "stopped", stderr: "" });

    const result = await runFullResetHarness({
      args: ["--local"],
      dependencies: { prepareProject, runCli, assertReset },
    });
    expect(result.summary).toMatch(/PASS.*498-file/i);
    expect(runCli.mock.calls.map(([args]) => args)).toEqual([
      ["--version"],
      ["db", "start", "--workdir", "C:/temp/openclaw-full-reset"],
      [
        "db",
        "reset",
        "--local",
        "--no-seed",
        "--workdir",
        "C:/temp/openclaw-full-reset",
      ],
      ["status", "-o", "json", "--workdir", "C:/temp/openclaw-full-reset"],
      ["stop", "--no-backup", "--workdir", "C:/temp/openclaw-full-reset"],
    ]);
    expect(assertReset).toHaveBeenCalledOnce();
    expect(assertReset).toHaveBeenCalledWith(expect.objectContaining({
      databaseUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      plan: expect.objectContaining({ aggregateSha256: "a".repeat(64) }),
    }));
    expect(cleanup).toHaveBeenCalledOnce();
    expect(SUPABASE_CLI_VERSION).toBe("2.109.1");
  });

  it("accepts only a loopback local Supabase database URL", () => {
    expect(parseSupabaseStatus(JSON.stringify({
      DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    }))).toBe("postgresql://postgres:postgres@127.0.0.1:54322/postgres");
    expect(() => parseSupabaseStatus("{}"))
      .toThrow(/DB_URL/i);
    expect(() => parseSupabaseStatus(JSON.stringify({
      DB_URL: "postgresql://postgres:postgres@db.example.com:5432/postgres",
    }))).toThrow(/loopback/i);
  });

  it("asserts exact migration identity, disabled OpenClaw state, ACLs, and snapshot fidelity", async () => {
    const plan = buildFullResetPlan([
      { file: "20260722000000_before.sql", bytes: Buffer.from("select 1") },
      { file: "20260723010000_finance_v2_semantics_snapshot.sql", bytes: Buffer.from("select 2") },
      { file: "20260727010000_openclaw_catalog_foundation.sql", bytes: Buffer.from("select 3") },
    ]);
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: plan.entries.map((entry) => ({ version: entry.targetVersion })),
      })
      .mockResolvedValueOnce({
        rows: [{
          openclaw_table_count: 1,
          browser_dml_leak_count: 0,
          unsafe_public_view_count: 0,
          public_execute_leak_count: 0,
          bad_activation_default_count: 0,
          enabled_control_row_count: 0,
          finance_snapshot_tail: "20260722000000",
        }],
      });
    const end = vi.fn(async () => {});
    const connect = vi.fn(async () => ({ query, end }));

    await runFullResetSmokeAssertions({
      databaseUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      plan,
      connect,
    });

    expect(connect).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledTimes(2);
    expect(end).toHaveBeenCalledOnce();
  });

  it("propagates a post-reset smoke failure and still stops plus cleans", async () => {
    const cleanup = vi.fn(async () => {});
    const assertReset = vi.fn(async () => {
      throw new Error("post-reset ACL smoke failed");
    });
    const runCli = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: "2.109.1\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "started", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "reset", stderr: "" })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({ DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres" }),
        stderr: "",
      })
      .mockResolvedValueOnce({ code: 0, stdout: "stopped", stderr: "" });

    await expect(runFullResetHarness({
      args: ["--local"],
      dependencies: {
        prepareProject: vi.fn(async () => ({
          root: "C:/temp/openclaw-full-reset",
          plan: {
            entries: Array.from({ length: 498 }, (_, index) => ({
              sourceFile: `migration-${index}.sql`,
              targetVersion: String(index + 1),
            })),
            duplicateOriginalVersionGroups: 18,
            aggregateSha256: "d".repeat(64),
          },
          cleanup,
        })),
        runCli,
        assertReset,
      },
    })).rejects.toThrow(/post-reset ACL smoke failed/i);
    expect(runCli.mock.calls.at(-1)[0]).toEqual([
      "stop",
      "--no-backup",
      "--workdir",
      "C:/temp/openclaw-full-reset",
    ]);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("cleans a prepared project and propagates validation plus cleanup failures", async () => {
    const cleanup = vi.fn(async () => {
      throw new Error("temporary directory cleanup failed");
    });
    const runCli = vi.fn();
    let failure;

    try {
      await runFullResetHarness({
        args: ["--local"],
        dependencies: {
          prepareProject: vi.fn(async () => ({
            root: "C:/temp/openclaw-full-reset",
            plan: {
              entries: Array.from({ length: 497 }, (_, index) => ({
                index: index + 1,
              })),
              duplicateOriginalVersionGroups: 18,
              aggregateSha256: "c".repeat(64),
            },
            cleanup,
          })),
          runCli,
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors.map((error) => error.message)).toEqual([
      "Full-reset migration cardinality drifted: 497.",
      "temporary directory cleanup failed",
    ]);
    expect(runCli).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("propagates reset and cleanup failures without skipping stop", async () => {
    const cleanup = vi.fn(async () => {
      throw new Error("temporary directory cleanup failed");
    });
    const runCli = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: "2.109.1\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "started", stderr: "" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "migration failed" })
      .mockResolvedValueOnce({ code: 0, stdout: "stopped", stderr: "" });

    await expect(runFullResetHarness({
      args: ["--local"],
      dependencies: {
        prepareProject: vi.fn(async () => ({
          root: "C:/temp/openclaw-full-reset",
          plan: {
            entries: Array.from({ length: 498 }, (_, index) => ({ index: index + 1 })),
            duplicateOriginalVersionGroups: 18,
            aggregateSha256: "b".repeat(64),
          },
          cleanup,
        })),
        runCli,
      },
    })).rejects.toThrow(/migration failed.*cleanup failed/is);
    expect(runCli.mock.calls.at(-1)[0]).toEqual([
      "stop",
      "--no-backup",
      "--workdir",
      "C:/temp/openclaw-full-reset",
    ]);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("keeps the terminal cause when verbose CLI diagnostics are bounded", async () => {
    const cleanup = vi.fn(async () => {});
    const runCli = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: "2.109.1\n", stderr: "" })
      .mockResolvedValueOnce({
        code: 1,
        stdout: "",
        stderr: `${"pull progress\n".repeat(1_000)}no space left on device`,
      })
      .mockResolvedValueOnce({ code: 0, stdout: "stopped", stderr: "" });

    await expect(runFullResetHarness({
      args: ["--local"],
      dependencies: {
        prepareProject: vi.fn(async () => ({
          root: "C:/temp/openclaw-full-reset",
          plan: {
            entries: Array.from({ length: 498 }, (_, index) => ({
              sourceFile: `migration-${index}.sql`,
              targetVersion: String(index + 1),
            })),
            duplicateOriginalVersionGroups: 18,
            aggregateSha256: "e".repeat(64),
          },
          cleanup,
        })),
        runCli,
      },
    })).rejects.toThrow(/no space left on device/i);
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
