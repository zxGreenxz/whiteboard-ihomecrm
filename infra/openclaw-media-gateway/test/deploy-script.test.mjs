import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as deployLib from "../scripts/deploy-lib.mjs";

const {
  boundedSpawnOptions,
  createDeployPlan,
  nodeVersionIsSupported,
  parseDeployArguments,
  posixProcessGroupId,
  runBoundedCommand,
} = deployLib;

const HASH = "a".repeat(64);

describe("gateway deploy helper", () => {
  it("accepts only dry-run or an exact reviewed live bundle hash", () => {
    expect(parseDeployArguments(["--dry-run"])).toEqual({
      dryRun: true,
      expectedBundleSha256: null,
      expectedConfigSha256: null,
    });
    expect(parseDeployArguments([
      "--expected-bundle-sha256",
      HASH,
      "--expected-config-sha256",
      HASH,
    ])).toEqual({
      dryRun: false,
      expectedBundleSha256: HASH,
      expectedConfigSha256: HASH,
    });
    for (const args of [
      [],
      ["--expected-bundle-sha256", HASH],
      ["--expected-bundle-sha256", "A".repeat(64)],
      ["--expected-bundle-sha256", "0"],
      ["--dry-run", "--expected-bundle-sha256", HASH],
    ]) {
      expect(() => parseDeployArguments(args)).toThrow(/Usage/u);
    }
  });

  it("requires an exact stable Node 24.15+ release", () => {
    expect(nodeVersionIsSupported("24.15.0")).toBe(true);
    expect(nodeVersionIsSupported("24.99.1")).toBe(true);
    for (const version of ["24.14.9", "25.0.0", "24.18.0-rc.1", "v24.18.0", "24.18"]) {
      expect(nodeVersionIsSupported(version), version).toBe(false);
    }
  });

  it("emits deterministic JS and uploads it with the absolute reviewed config", () => {
    const plan = createDeployPlan({
      bundleDirectory: "C:/temp/gateway-bundle",
      bundlePath: "C:/temp/gateway-bundle/index.js",
      sourcePath: "C:/repo/infra/openclaw-media-gateway/src/index.ts",
      stagedConfigPath: "C:/temp/gateway-bundle/wrangler.toml",
    });
    expect(plan.bundleArgs).toEqual([
      "deploy", "C:/repo/infra/openclaw-media-gateway/src/index.ts",
      "--dry-run", "--minify", "--keep-vars",
      "--outdir", "C:/temp/gateway-bundle",
      "--config", "C:/temp/gateway-bundle/wrangler.toml",
    ]);
    expect(plan.uploadArgs).toEqual([
      "deploy", "C:/temp/gateway-bundle/index.js", "--no-bundle", "--keep-vars",
      "--config", "C:/temp/gateway-bundle/wrangler.toml",
    ]);
  });

  it("stages immutable reviewed config bytes before the mutable source changes", async () => {
    expect(deployLib.stageReviewedConfig).toBeTypeOf("function");
    if (typeof deployLib.stageReviewedConfig !== "function") return;
    const directory = await mkdtemp(join(tmpdir(), "gateway-config-race-"));
    const sourcePath = join(directory, "source.toml");
    const stagedConfigPath = join(directory, "staged.toml");
    try {
      const reviewed = Buffer.from('workers_dev = false\npreview_urls = false\n');
      await writeFile(sourcePath, reviewed);
      const staged = await deployLib.stageReviewedConfig(sourcePath, stagedConfigPath);
      await writeFile(sourcePath, 'workers_dev = true\npreview_urls = true\n');

      expect(await readFile(stagedConfigPath)).toEqual(reviewed);
      expect(staged.configPath).toBe(stagedConfigPath);
      expect(staged.configSha256).toMatch(/^[0-9a-f]{64}$/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("terminates an over-limit child and waits for close before rejecting", async () => {
    const startedAt = Date.now();
    await expect(runBoundedCommand(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(8192));setInterval(()=>{},1000)"],
      { cwd: process.cwd(), outputLimit: 1024, timeoutMs: 10_000, terminateGraceMs: 100 },
    )).rejects.toThrow("output exceeded");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("isolates POSIX children in a process group for whole-tree termination", () => {
    expect(boundedSpawnOptions("linux")).toMatchObject({ detached: true });
    expect(boundedSpawnOptions("darwin")).toMatchObject({ detached: true });
    expect(boundedSpawnOptions("win32")).toMatchObject({ detached: false });
    expect(posixProcessGroupId(1234)).toBe(-1234);
    expect(() => posixProcessGroupId(0)).toThrow("child pid invalid");
  });
});
