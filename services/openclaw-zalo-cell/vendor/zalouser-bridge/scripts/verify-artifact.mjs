import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PLUGIN_ID,
  SOURCE_DATE_EPOCH,
} from "./build.mjs";
import {
  canonicalJson,
  canonicalSha256,
  controlledNpmEnvironment,
  inspectArtifactBytes,
  readArtifactEntries,
} from "./pack.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function assertEpoch(value) {
  if (value !== SOURCE_DATE_EPOCH) throw new Error(`SOURCE_DATE_EPOCH must be ${SOURCE_DATE_EPOCH}`);
}

function npmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
  ].filter(Boolean);
  const candidate = candidates.find((path) => existsSync(path));
  if (!candidate) throw new Error(`npm CLI was not found for portable Node ${process.execPath}`);
  return candidate;
}

function extractEntries(entries, root) {
  for (const entry of entries) {
    const relativePath = entry.path.slice("package/".length);
    const output = resolve(root, relativePath);
    const prefix = `${resolve(root)}${sep}`;
    if (!output.startsWith(prefix)) throw new Error(`artifact extraction escaped root: ${entry.path}`);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, entry.bytes, { flag: "wx" });
  }
}

function hashInstalledEntries(entries) {
  const hash = createHash("sha256");
  hash.update("ihome-zalouser-installed-tree-v1\0", "utf8");
  for (const entry of entries) {
    hash.update(`${entry.path}\0${entry.type}\0${entry.mode}\0${entry.size}\0${entry.sha256}\0`, "utf8");
  }
  return hash.digest("hex");
}

function installedTree(root) {
  const entries = [];
  const visit = (directory, relativeDirectory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => utf8Compare(left.name, right.name))) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = resolve(directory, entry.name);
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) throw new Error(`symlink installed member is forbidden: ${relativePath}`);
      if (entry.isDirectory()) {
        entries.push({ path: relativePath, type: "directory", mode: "0755", size: 0, sha256: sha256(Buffer.alloc(0)) });
        visit(absolute, relativePath);
      } else if (entry.isFile()) {
        const bytes = readFileSync(absolute);
        entries.push({ path: relativePath, type: "file", mode: "0644", size: bytes.length, sha256: sha256(bytes) });
      } else {
        throw new Error(`non-regular installed member is forbidden: ${relativePath}`);
      }
    }
  };
  visit(root, "");
  entries.sort((left, right) => utf8Compare(left.path, right.path));
  const rootSha256 = hashInstalledEntries(entries);
  return {
    entries,
    fileCount: entries.filter((entry) => entry.type === "file").length,
    directoryCount: entries.filter((entry) => entry.type === "directory").length,
    sha256: rootSha256,
    rootSha256,
  };
}

function assertNoForbiddenMembers(entries) {
  for (const entry of entries) {
    if (entry.path === "package/FORK.json" || entry.path.endsWith(".ts") || entry.path.endsWith(".map")) {
      throw new Error(`source/control artifact member is forbidden: ${entry.path}`);
    }
    if (/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|(?:^|\.)test\.[^/]+$/i.test(entry.path)) {
      throw new Error(`test artifact member is forbidden: ${entry.path}`);
    }
  }
}

function expectedLegalMembers(vendorRoot) {
  const manifest = JSON.parse(readFileSync(resolve(vendorRoot, "licenses/manifest.json"), "utf8"));
  const expected = new Map([
    ["package/LICENSE", readFileSync(resolve(vendorRoot, "LICENSE"))],
    ["package/THIRD_PARTY_NOTICES.md", readFileSync(resolve(vendorRoot, "THIRD_PARTY_NOTICES.md"))],
  ]);
  for (const carrier of manifest.carriers) expected.set(`package/${carrier.outputPath}`, readFileSync(resolve(vendorRoot, carrier.outputPath)));
  return expected;
}

function patchSeriesMetadata(vendorRoot) {
  const names = readFileSync(resolve(vendorRoot, "patches/series"), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const hash = createHash("sha256");
  hash.update("ihome-zalouser-patch-series-v1\0", "utf8");
  for (const name of names) {
    const path = `patches/${name}`;
    hash.update(path, "utf8");
    hash.update("\0", "utf8");
    hash.update(readFileSync(resolve(vendorRoot, path)));
    hash.update("\0", "utf8");
  }
  return { names, sha256: hash.digest("hex") };
}

function bridgeOverlayMetadata(vendorRoot) {
  const bridgeRoot = resolve(vendorRoot, "src/bridge");
  const paths = readdirSync(bridgeRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => `src/bridge/${entry.name}`)
    .sort(utf8Compare);
  const hash = createHash("sha256");
  hash.update("ihome-zalouser-bridge-overlay-v1\0", "utf8");
  const members = [];
  for (const path of paths) {
    const bytes = readFileSync(resolve(vendorRoot, path));
    hash.update(path, "utf8");
    hash.update("\0", "utf8");
    hash.update(bytes);
    hash.update("\0", "utf8");
    members.push({ path, size: bytes.length, sha256: sha256(bytes) });
  }
  return { members, sha256: hash.digest("hex") };
}

function verifyDynamicInventory(fork, allowlist) {
  const inventory = fork.runtimeDynamicSiteInventory;
  if (!Array.isArray(inventory) || inventory.length === 0) throw new Error("FORK runtime dynamic site inventory is missing");
  const identities = new Set();
  for (const site of inventory) {
    if (
      typeof site?.source !== "string" ||
      !Number.isInteger(site?.line) ||
      site.line < 1 ||
      !["dynamic-import", "require", "filesystem-read", "import-meta-resolve", "package-exports"].includes(site?.operation) ||
      typeof site?.expression !== "string" ||
      !["literal", "reviewed-finite"].includes(site?.resolution) ||
      !Array.isArray(site?.expandedMembers) ||
      site.expandedMembers.length === 0
    ) {
      throw new Error("FORK runtime dynamic site inventory contains an incomplete record");
    }
    const identity = `${site.source}\0${site.line}\0${site.operation}`;
    if (identities.has(identity)) throw new Error(`FORK runtime dynamic site inventory contains a duplicate: ${identity}`);
    identities.add(identity);
    const expanded = [...site.expandedMembers].sort(utf8Compare);
    if (new Set(expanded).size !== expanded.length || canonicalJson(expanded) !== canonicalJson(site.expandedMembers)) {
      throw new Error(`FORK runtime dynamic site expansion is not exact and sorted: ${identity}`);
    }
    if (expanded.some((path) => !allowlist.includes(path))) throw new Error(`FORK runtime dynamic site expands outside allowlist: ${identity}`);
  }
  if (!inventory.some((site) => site.operation === "package-exports")) throw new Error("FORK package export inventory is missing");
}

function verifyFork(vendorRoot, artifactPath, artifactBytes, entries, installed) {
  const forkPath = resolve(vendorRoot, "FORK.json");
  if (!existsSync(forkPath)) throw new Error("FORK.json is required for artifact verification");
  const fork = JSON.parse(readFileSync(forkPath, "utf8"));
  if (fork.schema !== 1) throw new Error("unsupported FORK.json schema");
  if (fork.package?.name !== PACKAGE_NAME || fork.package?.version !== PACKAGE_VERSION) throw new Error("FORK package identity mismatch");
  if (fork.plugin?.id !== PLUGIN_ID || canonicalJson(fork.plugin?.channels) !== canonicalJson([PLUGIN_ID])) throw new Error("FORK plugin identity mismatch");
  if (fork.sourceDateEpoch !== SOURCE_DATE_EPOCH) throw new Error("FORK source epoch mismatch");
  if (fork.artifactPath !== "artifacts/openclaw-zalouser-2026.7.1.tgz") throw new Error("FORK artifact path mismatch");
  if (resolve(artifactPath) !== resolve(vendorRoot, fork.artifactPath)) throw new Error("verified artifact is not the committed FORK artifact path");
  const artifactSha256 = sha256(artifactBytes);
  if (fork.artifactSha256 !== artifactSha256 || fork.builtTgzSha256 !== artifactSha256) throw new Error("FORK artifact hash mismatch");
  if (fork.artifactMembersSha256 !== canonicalSha256(entries)) throw new Error("FORK artifact member hash mismatch");
  if (canonicalJson(fork.artifactMembers) !== canonicalJson(entries)) throw new Error("FORK artifact member manifest mismatch");
  const actualPaths = entries.map((entry) => entry.path).sort(utf8Compare);
  const legal = [...(fork.legalMemberExceptions ?? [])].sort(utf8Compare);
  const metadata = [...(fork.packageMetadataExceptions ?? [])].sort(utf8Compare);
  const allowlist = [...(fork.runtimeReachabilityAllowlist ?? [])].sort(utf8Compare);
  const union = [...new Set([...legal, ...metadata, ...allowlist])].sort(utf8Compare);
  if (canonicalJson(union) !== canonicalJson(actualPaths)) throw new Error("FORK member classifications are not exhaustive");
  if (legal.length + metadata.length + allowlist.length !== union.length) throw new Error("FORK member classifications overlap");
  const expectedLegal = [...expectedLegalMembers(vendorRoot).keys()].sort(utf8Compare);
  if (canonicalJson(legal) !== canonicalJson(expectedLegal)) throw new Error("FORK legal member exceptions mismatch");
  const expectedMetadata = ["package/README.md", "package/openclaw.plugin.json", "package/package.json"].sort(utf8Compare);
  if (canonicalJson(metadata) !== canonicalJson(expectedMetadata)) throw new Error("FORK package metadata exceptions mismatch");
  const expectedRuntime = actualPaths.filter((path) => path.startsWith("package/dist/")).sort(utf8Compare);
  if (canonicalJson(allowlist) !== canonicalJson(expectedRuntime)) throw new Error("FORK runtime allowlist is not the exact dist closure");
  const expectedEntrypoints = [
    "api",
    "channel-plugin-api",
    "contract-api",
    "doctor-contract-api",
    "index",
    "runtime-api",
    "secret-contract-api",
    "setup-entry",
    "setup-plugin-api",
  ].map((name) => `package/dist/${name}.js`);
  if (canonicalJson(fork.publicEntrypoints) !== canonicalJson(expectedEntrypoints)) throw new Error("FORK public entrypoint manifest mismatch");
  verifyDynamicInventory(fork, allowlist);
  const patches = patchSeriesMetadata(vendorRoot);
  if (canonicalJson(fork.patches) !== canonicalJson(patches.names) || fork.patchSeriesSha256 !== patches.sha256) throw new Error("FORK patch series mismatch");
  const overlay = bridgeOverlayMetadata(vendorRoot);
  if (canonicalJson(fork.bridgeOverlay) !== canonicalJson(overlay)) throw new Error("FORK bridge overlay mismatch");
  if (fork.licenseManifestSha256 !== sha256(readFileSync(resolve(vendorRoot, "licenses/manifest.json")))) throw new Error("FORK license manifest hash mismatch");
  if (
    fork.installedTree?.sha256 !== installed.sha256 ||
    fork.installedTree?.rootSha256 !== installed.rootSha256 ||
    fork.installedTree?.fileCount !== installed.fileCount ||
    fork.installedTree?.directoryCount !== installed.directoryCount ||
    canonicalJson(fork.installedTree?.entries) !== canonicalJson(installed.entries)
  ) {
    throw new Error("FORK installed tree mismatch");
  }
  return fork;
}

export async function verifyArtifact({
  vendorRoot,
  artifactPath,
  installRoot,
  requireFork = false,
  sourceDateEpoch = SOURCE_DATE_EPOCH,
}) {
  assertEpoch(sourceDateEpoch);
  const resolvedArtifactPath = resolve(artifactPath);
  const artifactBytes = readFileSync(resolvedArtifactPath);
  const entries = readArtifactEntries(artifactBytes, sourceDateEpoch);
  const manifest = inspectArtifactBytes(artifactBytes, sourceDateEpoch);
  assertNoForbiddenMembers(entries);
  const expectedLegal = expectedLegalMembers(resolve(vendorRoot));
  const complianceEntries = entries.filter(
    (entry) =>
      entry.path === "package/LICENSE" ||
      entry.path === "package/THIRD_PARTY_NOTICES.md" ||
      entry.path.startsWith("package/licenses/") ||
      /\/(?:license|licence|notice)(?:\.|$)/i.test(entry.path),
  );
  const actualLegal = new Map(complianceEntries.map((entry) => [entry.path, entry]));
  const expectedLegalPaths = [...expectedLegal.keys()].sort(utf8Compare);
  const actualLegalPaths = [...actualLegal.keys()].sort(utf8Compare);
  if (canonicalJson(actualLegalPaths) !== canonicalJson(expectedLegalPaths)) throw new Error("artifact legal carrier set is not exact");
  for (const [path, bytes] of expectedLegal) {
    const actual = actualLegal.get(path);
    if (!actual || actual.size !== bytes.length || actual.sha256 !== sha256(bytes)) throw new Error(`artifact legal carrier mismatch: ${path}`);
  }
  const extracted = resolve(installRoot ?? resolve(tmpdir(), `ihome-zalouser-install-${process.pid}-${Date.now()}`));
  rmSync(extracted, { force: true, recursive: true });
  mkdirSync(extracted, { recursive: true });
  const packageSource = resolve(extracted, "package-source");
  mkdirSync(packageSource, { recursive: true });
  extractEntries(entries, packageSource);
  const packageJson = JSON.parse(readFileSync(resolve(packageSource, "package.json"), "utf8"));
  const plugin = JSON.parse(readFileSync(resolve(packageSource, "openclaw.plugin.json"), "utf8"));
  if (packageJson.name !== PACKAGE_NAME || packageJson.version !== PACKAGE_VERSION) throw new Error("artifact package identity mismatch");
  if (plugin.id !== PLUGIN_ID || canonicalJson(plugin.channels) !== canonicalJson([PLUGIN_ID])) throw new Error("artifact plugin identity mismatch");
  if (canonicalJson(packageJson.openclaw?.extensions) !== canonicalJson(["./dist/index.js"])) throw new Error("artifact extension entrypoint mismatch");
  for (const entry of entries.filter((item) => item.path.endsWith(".js"))) {
    if (/sourceMappingURL\s*=/.test(readFileSync(resolve(packageSource, entry.path.slice("package/".length)), "utf8"))) {
      throw new Error(`inline source map reference is forbidden: ${entry.path}`);
    }
  }

  const npmRoot = resolve(extracted, "npm-install");
  mkdirSync(npmRoot, { recursive: true });
  writeFileSync(resolve(npmRoot, "package.json"), Buffer.from('{"private":true}\n', "utf8"));
  const cache = resolve(npmRoot, "cache");
  mkdirSync(cache, { recursive: true });
  execFileSync(
    process.execPath,
    [npmCliPath(), "install", resolvedArtifactPath, "--ignore-scripts", "--offline", "--no-audit", "--no-fund", "--no-package-lock", "--omit=dev", "--omit=optional"],
    {
      cwd: npmRoot,
      env: controlledNpmEnvironment({
        npm_config_cache: cache,
        npm_config_registry: "http://127.0.0.1:9",
        npm_config_update_notifier: "false",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const installedPackageRoot = resolve(npmRoot, "node_modules/@openclaw/zalouser");
  if (!existsSync(installedPackageRoot)) throw new Error("offline npm install did not materialize @openclaw/zalouser");
  const installed = installedTree(installedPackageRoot);
  const artifactFiles = manifest.map((entry) => ({ ...entry, path: entry.path.slice("package/".length) }));
  const installedFiles = installed.entries.filter((entry) => entry.type === "file");
  if (canonicalJson(installedFiles) !== canonicalJson(artifactFiles)) throw new Error("installed tree differs from artifact members");
  const installedPackage = JSON.parse(readFileSync(resolve(installedPackageRoot, "package.json"), "utf8"));
  const installedPlugin = JSON.parse(readFileSync(resolve(installedPackageRoot, "openclaw.plugin.json"), "utf8"));
  if (installedPackage.name !== PACKAGE_NAME || installedPackage.version !== PACKAGE_VERSION) throw new Error("installed package identity mismatch");
  if (installedPlugin.id !== PLUGIN_ID || canonicalJson(installedPlugin.channels) !== canonicalJson([PLUGIN_ID])) throw new Error("installed plugin identity mismatch");
  const fork = requireFork ? verifyFork(vendorRoot, resolvedArtifactPath, artifactBytes, manifest, installed) : null;
  return {
    artifactPath: resolvedArtifactPath,
    artifactSha256: sha256(artifactBytes),
    artifactMembers: manifest,
    package: { name: installedPackage.name, version: installedPackage.version },
    plugin: { id: installedPlugin.id, channels: installedPlugin.channels },
    installedTree: installed,
    fork,
  };
}

function parseArgument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const vendorRoot = resolve(dirname(dirname(fileURLToPath(import.meta.url))));
  const sourceDateEpoch = Number(parseArgument("--source-date-epoch") ?? SOURCE_DATE_EPOCH);
  const artifactPath = resolve(parseArgument("--artifact") ?? resolve(vendorRoot, "artifacts/openclaw-zalouser-2026.7.1.tgz"));
  const installRoot = parseArgument("--install-root") ?? resolve(vendorRoot, ".work/verify-installed");
  const result = await verifyArtifact({
    vendorRoot,
    artifactPath,
    installRoot,
    requireFork: !process.argv.includes("--no-fork"),
    sourceDateEpoch,
  });
  if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write(`Verified ${result.package.name}@${result.package.version} (${result.installedTree.fileCount} files).\n`);
}
