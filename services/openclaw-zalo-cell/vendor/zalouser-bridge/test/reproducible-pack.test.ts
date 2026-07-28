import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

const vendorRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DATE_EPOCH = 1_785_062_400;
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("reviewed patch series", () => {
  it("applies the exact three patches to the immutable source snapshot", () => {
    const series = readFileSync(resolve(vendorRoot, "patches/series"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean);
    expect(series).toEqual([
      "0001-durable-inbound-bridge-listener.patch",
      "0002-private-bridge-send-rpc.patch",
      "0003-close-bypasses-and-classify-control.patch",
    ]);
    const preparedRoot = mkdtempSync(resolve(tmpdir(), "ihome-zalouser-patches-"));
    temporaryRoots.push(preparedRoot);
    cpSync(resolve(vendorRoot, "upstream/package"), preparedRoot, { recursive: true });

    for (const name of series) {
      const patch = resolve(vendorRoot, "patches", name);
      execFileSync("git", ["apply", "--check", patch], { cwd: preparedRoot });
      execFileSync("git", ["apply", patch], { cwd: preparedRoot });
    }

    expect(readFileSync(resolve(preparedRoot, "src/zalo-js.ts"), "utf8")).toContain(
      "Promise.resolve(params.onMessage(normalized))",
    );
    expect(readFileSync(resolve(preparedRoot, "src/monitor.ts"), "utf8")).toContain(
      "await commitInboundThroughBridge",
    );
    expect(readFileSync(resolve(preparedRoot, "index.ts"), "utf8")).toContain(
      'registerPrivateOutboundRpc(api, "zalouser.bridge.send")',
    );
    for (const path of ["src/send.ts", "src/channel.adapters.ts", "src/tool.ts"]) {
      expect(readFileSync(resolve(preparedRoot, path), "utf8")).toContain("PRIVATE_RPC_REQUIRED");
    }
  });
});

function latestPreparedRoot() {
  const workRoot = resolve(vendorRoot, ".work");
  const candidates = readdirSync(workRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^prepared-[0-9a-f-]+$/.test(entry.name))
    .map((entry) => resolve(workRoot, entry.name))
    .filter((path) => existsSync(resolve(path, "package.json")))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  const [latest] = candidates;
  if (latest === undefined) throw new Error("vendor:prepare must run before artifact tests");
  return latest;
}

async function loadArtifactScripts() {
  const [
    { buildPreparedTree },
    { controlledNpmEnvironment, packArtifact },
    { prepareVendorTree },
    { verifyArtifact },
  ] = await Promise.all([
    import("../scripts/build.mjs"),
    import("../scripts/pack.mjs"),
    import("../scripts/prepare.mjs"),
    import("../scripts/verify-artifact.mjs"),
  ]);
  return {
    buildPreparedTree,
    controlledNpmEnvironment,
    packArtifact,
    prepareVendorTree,
    verifyArtifact,
  };
}

describe("controlled npm child environment", () => {
  it("removes inherited npm config in every casing before applying reviewed overrides", async () => {
    const { controlledNpmEnvironment } = await loadArtifactScripts();
    const environment = controlledNpmEnvironment(
      {
        npm_config_cache: "C:/controlled/cache",
        npm_config_registry: "http://127.0.0.1:9",
      },
      {
        PATH: "C:/portable-node",
        npm_execpath: "C:/portable-node/npm-cli.js",
        npm_config_cache: "C:/lowercase-leak",
        NPM_CONFIG_CACHE: "C:/uppercase-leak",
        NpM_CoNfIg_UsErCoNfIg: "C:/config-leak",
        npm_config_registry: "https://registry.example.invalid",
      },
    );

    expect(environment).toEqual({
      PATH: "C:/portable-node",
      npm_execpath: "C:/portable-node/npm-cli.js",
      npm_config_cache: "C:/controlled/cache",
      npm_config_registry: "http://127.0.0.1:9",
    });
  });
});

describe("reproducible internal artifact", () => {
  it("builds only the prepared source with fixed timestamps and reviewed identity", async () => {
    const { buildPreparedTree } = await loadArtifactScripts();
    const root = mkdtempSync(resolve(tmpdir(), "ihome-zalouser-build-"));
    temporaryRoots.push(root);
    const result = await buildPreparedTree({
      vendorRoot,
      preparedRoot: latestPreparedRoot(),
      outputRoot: root,
      sourceDateEpoch: SOURCE_DATE_EPOCH,
    });

    const packageJson = JSON.parse(readFileSync(resolve(result.packageRoot, "package.json"), "utf8"));
    const plugin = JSON.parse(readFileSync(resolve(result.packageRoot, "openclaw.plugin.json"), "utf8"));
    expect(packageJson.name).toBe("@openclaw/zalouser");
    expect(packageJson.version).toBe("2026.7.1");
    expect(packageJson.openclaw.extensions).toEqual(["./dist/index.js"]);
    expect(plugin.id).toBe("zalouser");
    expect(plugin.channels).toEqual(["zalouser"]);
    expect(result.members.some((member) => member.path.endsWith(".ts"))).toBe(false);
    expect(result.members.some((member) => /(?:\.test\.|\.map$|FORK\.json$)/.test(member.path))).toBe(false);
    for (const member of result.members) {
      expect(member.type).toBe("file");
      expect(Math.floor(statSync(resolve(result.packageRoot, member.path)).mtimeMs / 1000)).toBe(
        SOURCE_DATE_EPOCH,
      );
    }
  });

  it("packs twice to byte-identical archives without control metadata", async () => {
    const { buildPreparedTree, packArtifact } = await loadArtifactScripts();
    const root = mkdtempSync(resolve(tmpdir(), "ihome-zalouser-pack-"));
    temporaryRoots.push(root);
    const firstBuild = await buildPreparedTree({
      vendorRoot,
      preparedRoot: latestPreparedRoot(),
      outputRoot: resolve(root, "build-a"),
      sourceDateEpoch: SOURCE_DATE_EPOCH,
    });
    const secondBuild = await buildPreparedTree({
      vendorRoot,
      preparedRoot: latestPreparedRoot(),
      outputRoot: resolve(root, "build-b"),
      sourceDateEpoch: SOURCE_DATE_EPOCH,
    });
    const first = await packArtifact({
      vendorRoot,
      packageRoot: firstBuild.packageRoot,
      outputPath: resolve(root, "first.tgz"),
      sourceDateEpoch: SOURCE_DATE_EPOCH,
    });
    const second = await packArtifact({
      vendorRoot,
      packageRoot: secondBuild.packageRoot,
      outputPath: resolve(root, "second.tgz"),
      sourceDateEpoch: SOURCE_DATE_EPOCH,
    });

    expect(createHash("sha256").update(readFileSync(first.artifactPath)).digest("hex")).toBe(
      createHash("sha256").update(readFileSync(second.artifactPath)).digest("hex"),
    );
    expect(first.members).toEqual(second.members);
    expect(first.members.every((member) => member.type === "file")).toBe(true);
    expect(first.members.some((member) => member.path.includes("FORK.json"))).toBe(false);
    expect(first.members.some((member) => /(?:\.ts$|\.test\.|\.map$)/.test(member.path))).toBe(false);
  });

  it("is byte-identical across independently prepared source roots", async () => {
    const { buildPreparedTree, packArtifact, prepareVendorTree } = await loadArtifactScripts();
    const repoRoot = resolve(vendorRoot, "../../../..");
    const tarballPath = resolve(vendorRoot, ".work/verified-upstream.tgz");
    const preparedA = await prepareVendorTree({ repoRoot, tarballPath, vendorRoot });
    const preparedB = await prepareVendorTree({ repoRoot, tarballPath, vendorRoot });
    temporaryRoots.push(preparedA, preparedB);
    const root = mkdtempSync(resolve(tmpdir(), "ihome-zalouser-independent-pack-"));
    temporaryRoots.push(root);
    const buildA = await buildPreparedTree({
      vendorRoot,
      preparedRoot: preparedA,
      outputRoot: resolve(root, "build-a"),
      sourceDateEpoch: SOURCE_DATE_EPOCH,
    });
    const buildB = await buildPreparedTree({
      vendorRoot,
      preparedRoot: preparedB,
      outputRoot: resolve(root, "build-b"),
      sourceDateEpoch: SOURCE_DATE_EPOCH,
    });
    const packedA = await packArtifact({
      vendorRoot,
      packageRoot: buildA.packageRoot,
      outputPath: resolve(root, "independent-a.tgz"),
      sourceDateEpoch: SOURCE_DATE_EPOCH,
    });
    const packedB = await packArtifact({
      vendorRoot,
      packageRoot: buildB.packageRoot,
      outputPath: resolve(root, "independent-b.tgz"),
      sourceDateEpoch: SOURCE_DATE_EPOCH,
    });

    expect(packedA.members).toEqual(packedB.members);
    expect(readFileSync(packedA.artifactPath)).toEqual(readFileSync(packedB.artifactPath));
  });

  it("verifies an offline install and records its exact installed tree", async () => {
    const { buildPreparedTree, packArtifact, verifyArtifact } = await loadArtifactScripts();
    const root = mkdtempSync(resolve(tmpdir(), "ihome-zalouser-verify-"));
    temporaryRoots.push(root);
    const build = await buildPreparedTree({
      vendorRoot,
      preparedRoot: latestPreparedRoot(),
      outputRoot: resolve(root, "build"),
      sourceDateEpoch: SOURCE_DATE_EPOCH,
    });
    const packed = await packArtifact({
      vendorRoot,
      packageRoot: build.packageRoot,
      outputPath: resolve(root, "artifact.tgz"),
      sourceDateEpoch: SOURCE_DATE_EPOCH,
    });
    const result = await verifyArtifact({
      vendorRoot,
      artifactPath: packed.artifactPath,
      installRoot: resolve(root, "install"),
      sourceDateEpoch: SOURCE_DATE_EPOCH,
    });

    expect(result.package.name).toBe("@openclaw/zalouser");
    expect(result.package.version).toBe("2026.7.1");
    expect(result.plugin.id).toBe("zalouser");
    expect(result.installedTree.fileCount).toBeGreaterThan(0);
    expect(result.installedTree.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
