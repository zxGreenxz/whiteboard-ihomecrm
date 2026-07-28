import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
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

    const patchedZaloJs = readFileSync(resolve(preparedRoot, "src/zalo-js.ts"), "utf8");
    expect(patchedZaloJs).toContain(
      "const callbackReceivedAt = captureProviderCallbackReceivedAt();",
    );
    expect(patchedZaloJs).toContain("pending = params.onMessage(normalized);");
    expect(patchedZaloJs).toContain("Promise.resolve(pending).catch");
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
    { controlledNpmEnvironment, forkMetadata, packArtifact },
    { prepareVendorTree },
    { verifyArtifact, verifyRuntimeReachabilityMetadata },
  ] = await Promise.all([
    import("../scripts/build.mjs"),
    import("../scripts/pack.mjs"),
    import("../scripts/prepare.mjs"),
    import("../scripts/verify-artifact.mjs"),
  ]);
  return {
    buildPreparedTree,
    controlledNpmEnvironment,
    forkMetadata,
    packArtifact,
    prepareVendorTree,
    verifyArtifact,
    verifyRuntimeReachabilityMetadata,
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

  it("derives the exact runtime closure with a finite expansion for every dynamic site", async () => {
    const { buildPreparedTree } = await loadArtifactScripts();
    const root = mkdtempSync(resolve(tmpdir(), "ihome-zalouser-runtime-closure-"));
    temporaryRoots.push(root);
    const result = await buildPreparedTree({
      vendorRoot,
      preparedRoot: latestPreparedRoot(),
      outputRoot: root,
      sourceDateEpoch: SOURCE_DATE_EPOCH,
    });

    const runtimeMembers = result.members
      .filter((member) => member.path.startsWith("dist/"))
      .map((member) => `package/${member.path}`)
      .sort();
    expect(result.derivedRuntimeSet).toEqual(runtimeMembers);
    const dynamicSites = result.runtimeDynamicSiteInventory.filter(
      ({ operation }) => operation === "dynamic-import",
    );
    expect(dynamicSites).toHaveLength(6);
    for (const site of dynamicSites) {
      expect(site.expandedMembers.length).toBeGreaterThan(0);
      expect(site.expandedMembers).not.toEqual(runtimeMembers);
    }
    const accountsSite = dynamicSites.find(({ source }) => source === "src/accounts.ts");
    expect(accountsSite?.expandedMembers.some((member) => /accounts\.runtime-/.test(member))).toBe(
      true,
    );
    expect(accountsSite?.expandedMembers.some((member) => /channel\.runtime-/.test(member))).toBe(
      false,
    );
  });

  it.each([
    ["dynamic import", "void import(resolveUnboundedRuntimeSpecifier());"],
    ["require", "void require(resolveUnboundedRuntimeSpecifier());"],
    ["createRequire", "const runtimeRequire = createRequire(import.meta.url); void runtimeRequire(resolveUnboundedRuntimeSpecifier());"],
    ["import.meta.resolve", "void import.meta.resolve(resolveUnboundedRuntimeSpecifier());"],
    ["filesystem read", "void readFileSync(resolveUnboundedRuntimeSpecifier());"],
  ])("fails closed on an unclassified non-literal %s site", async (_kind, statement) => {
    const { buildPreparedTree } = await loadArtifactScripts();
    const preparedRoot = resolve(
      vendorRoot,
      ".work",
      `prepared-${randomUUID()}`,
    );
    temporaryRoots.push(preparedRoot);
    cpSync(latestPreparedRoot(), preparedRoot, { recursive: true });
    const accountsPath = resolve(preparedRoot, "src/accounts.ts");
    writeFileSync(
      accountsPath,
      `${readFileSync(accountsPath, "utf8")}\n${statement}\n`,
    );
    const outputRoot = mkdtempSync(resolve(tmpdir(), "ihome-zalouser-unclassified-site-"));
    temporaryRoots.push(outputRoot);

    await expect(
      buildPreparedTree({
        vendorRoot,
        preparedRoot,
        outputRoot,
        sourceDateEpoch: SOURCE_DATE_EPOCH,
      }),
    ).rejects.toThrow(/unclassified|non-finite|dynamic resolution/i);
  });

  it("uses the independently derived closure as the fork runtime allowlist", async () => {
    const {
      buildPreparedTree,
      forkMetadata,
      packArtifact,
      verifyRuntimeReachabilityMetadata,
    } = await loadArtifactScripts();
    const root = mkdtempSync(resolve(tmpdir(), "ihome-zalouser-derived-allowlist-"));
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
    const installedTree = {
      entries: [],
      fileCount: 0,
      directoryCount: 0,
      sha256: "0".repeat(64),
      rootSha256: "0".repeat(64),
    };
    const fork = forkMetadata({
      vendorRoot,
      packed,
      installedTree,
      runtimeDynamicSiteInventory: build.runtimeDynamicSiteInventory,
      derivedRuntimeSet: build.derivedRuntimeSet,
    });

    expect(fork.derivedRuntimeSet).toEqual(build.derivedRuntimeSet);
    expect(fork.runtimeReachabilityAllowlist).toEqual(build.derivedRuntimeSet);
    expect(() =>
      verifyRuntimeReachabilityMetadata(
        fork,
        packed.members.map(({ path }) => path),
      ),
    ).not.toThrow();
    expect(() =>
      verifyRuntimeReachabilityMetadata(
        { ...fork, derivedRuntimeSet: fork.derivedRuntimeSet.slice(1) },
        packed.members.map(({ path }) => path),
      ),
    ).toThrow(/derived runtime set/i);
    expect(() =>
      forkMetadata({
        vendorRoot,
        packed,
        installedTree,
        runtimeDynamicSiteInventory: build.runtimeDynamicSiteInventory,
        derivedRuntimeSet: build.derivedRuntimeSet.slice(1),
      }),
    ).toThrow(/derived runtime closure/i);
  });

  it("loads the bundled zca runtime under ESM without a dynamic-require failure", async () => {
    const { buildPreparedTree } = await loadArtifactScripts();
    const root = mkdtempSync(resolve(tmpdir(), "ihome-zalouser-zca-esm-"));
    temporaryRoots.push(root);
    const build = await buildPreparedTree({
      vendorRoot,
      preparedRoot: latestPreparedRoot(),
      outputRoot: root,
      sourceDateEpoch: SOURCE_DATE_EPOCH,
    });
    const zcaSite = build.runtimeDynamicSiteInventory.find(
      ({ source, operation }) => source === "src/zca-client.ts" && operation === "dynamic-import",
    );
    const target = zcaSite?.expandedMembers.find((member) => /\/dist-[A-Z0-9]+\.js$/.test(member));
    expect(target).toBeTruthy();
    const targetUrl = pathToFileURL(
      resolve(build.packageRoot, target.slice("package/".length)),
    ).href;
    expect(() =>
      execFileSync(process.execPath, ["--input-type=module", "--eval", `await import(${JSON.stringify(targetUrl)})`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ).not.toThrow();
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
    const installedPaths = new Map(
      result.installedTree.entries.map((entry) => [entry.path, entry]),
    );
    expect(installedPaths.get("package.json")).toMatchObject({
      type: "file",
      mode: "0644",
    });
    expect(installedPaths.get("node_modules")).toMatchObject({ type: "directory" });
    expect(installedPaths.get("node_modules/@openclaw")).toMatchObject({
      type: "directory",
    });
    expect(installedPaths.get("node_modules/@openclaw/zalouser/package.json")).toMatchObject({
      type: "file",
      size: 2050,
    });
    expect(
      result.installedTree.entries.some(({ path }) => path.endsWith(".package-lock.json")),
    ).toBe(false);
  });
});
