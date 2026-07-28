import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PLUGIN_ID,
  SOURCE_DATE_EPOCH,
  buildPreparedTree,
  regularFileManifest,
} from "./build.mjs";
import { prepareVendorTree } from "./prepare.mjs";

const ARTIFACT_NAME = "openclaw-zalouser-2026.7.1.tgz";
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort(utf8Compare)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

export function canonicalSha256(value) {
  return sha256(Buffer.from(canonicalJson(value), "utf8"));
}

export function controlledNpmEnvironment(overrides, sourceEnvironment = process.env) {
  const environment = {};
  for (const [key, value] of Object.entries(sourceEnvironment)) {
    if (!/^npm_config_/i.test(key) && value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!/^npm_config_/i.test(key)) {
      throw new Error(`controlled npm override must use npm_config_*: ${key}`);
    }
    environment[key.toLowerCase()] = String(value);
  }
  return environment;
}

function assertEpoch(value) {
  if (value !== SOURCE_DATE_EPOCH) throw new Error(`SOURCE_DATE_EPOCH must be ${SOURCE_DATE_EPOCH}`);
}

function safeOutput(root, path) {
  const output = resolve(root, path);
  if (output !== resolve(root) && !output.startsWith(`${resolve(root)}${sep}`)) {
    throw new Error(`output escapes root: ${path}`);
  }
  return output;
}

function atomicWrite(path, bytes, sourceDateEpoch) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, bytes, { flag: "wx" });
  chmodSync(temporary, 0o644);
  const timestamp = new Date(sourceDateEpoch * 1000);
  utimesSync(temporary, timestamp, timestamp);
  renameSync(temporary, path);
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

function verifyNpmPackSelection(packageRoot, expectedPaths) {
  const temporary = mkdtempSync(resolve(dirname(packageRoot), ".npm-pack-"));
  try {
    const cache = resolve(temporary, "cache");
    mkdirSync(cache, { recursive: true });
    const stdout = execFileSync(
      process.execPath,
      [npmCliPath(), "pack", packageRoot, "--ignore-scripts", "--json"],
      {
        cwd: temporary,
        encoding: "utf8",
        env: controlledNpmEnvironment({
          npm_config_audit: "false",
          npm_config_cache: cache,
          npm_config_fund: "false",
          npm_config_update_notifier: "false",
        }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const result = JSON.parse(stdout);
    if (!Array.isArray(result) || result.length !== 1 || !Array.isArray(result[0].files)) {
      throw new Error("npm pack returned an unexpected JSON result");
    }
    const selected = result[0].files.map((entry) => entry.path.replaceAll("\\", "/")).sort(utf8Compare);
    const expected = [...expectedPaths].sort(utf8Compare);
    if (JSON.stringify(selected) !== JSON.stringify(expected)) {
      throw new Error(`npm pack selection mismatch\nexpected=${JSON.stringify(expected)}\nactual=${JSON.stringify(selected)}`);
    }
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}

function writeOctal(header, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length > length - 1) throw new Error(`tar numeric field overflow: ${value}`);
  header.write(encoded, offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

function splitTarPath(path) {
  const bytes = Buffer.byteLength(path, "utf8");
  if (bytes <= 100) return { name: path, prefix: "" };
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(name, "utf8") <= 100 && Buffer.byteLength(prefix, "utf8") <= 155) {
      return { name, prefix };
    }
  }
  throw new Error(`tar path cannot be represented as ustar: ${path}`);
}

function tarHeader(path, size, sourceDateEpoch) {
  const { name, prefix } = splitTarPath(path);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, sourceDateEpoch);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write(prefix, 345, 155, "utf8");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumText = checksum.toString(8).padStart(6, "0");
  header.write(checksumText, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function buildTar(packageRoot, sourceDateEpoch) {
  const files = regularFileManifest(packageRoot);
  const chunks = [];
  for (const file of files) {
    const path = `package/${file.path}`;
    const bytes = readFileSync(resolve(packageRoot, file.path));
    chunks.push(tarHeader(path, bytes.length, sourceDateEpoch), bytes);
    const padding = (512 - (bytes.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

function readNullTerminatedAscii(buffer, offset, length) {
  const field = buffer.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString("utf8");
}

function parseOctal(buffer, offset, length, label) {
  const raw = readNullTerminatedAscii(buffer, offset, length).trim();
  if (!/^[0-7]+$/.test(raw)) throw new Error(`invalid tar ${label}: ${JSON.stringify(raw)}`);
  return Number.parseInt(raw, 8);
}

export function readArtifactEntries(artifactBytes, sourceDateEpoch = SOURCE_DATE_EPOCH) {
  assertEpoch(sourceDateEpoch);
  const tar = gunzipSync(artifactBytes);
  const entries = [];
  const seen = new Set();
  const folded = new Set();
  let offset = 0;
  let zeroBlocks = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      if (zeroBlocks === 2) break;
      continue;
    }
    if (zeroBlocks !== 0) throw new Error("tar contains data after a zero block");
    const storedChecksum = parseOctal(header, 148, 8, "checksum");
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    let computedChecksum = 0;
    for (const byte of checksumHeader) computedChecksum += byte;
    if (computedChecksum !== storedChecksum) throw new Error("tar header checksum mismatch");
    const magic = header.subarray(257, 263).toString("ascii");
    if (magic !== "ustar\0") throw new Error("artifact must use deterministic ustar headers");
    const name = readNullTerminatedAscii(header, 0, 100);
    const prefix = readNullTerminatedAscii(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const typeFlag = String.fromCharCode(header[156]);
    if (typeFlag !== "0" && typeFlag !== "\0") throw new Error(`non-regular tar member is forbidden: ${path}`);
    if (!path.startsWith("package/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error(`unsafe tar member path: ${path}`);
    }
    const normalized = path.normalize("NFC");
    const lower = normalized.toLocaleLowerCase("en-US");
    if (seen.has(normalized)) throw new Error(`duplicate tar member: ${path}`);
    if (folded.has(lower)) throw new Error(`case-colliding tar member: ${path}`);
    seen.add(normalized);
    folded.add(lower);
    const mode = parseOctal(header, 100, 8, "mode");
    if (mode !== 0o644) throw new Error(`unexpected tar member mode for ${path}: ${mode.toString(8)}`);
    const size = parseOctal(header, 124, 12, "size");
    const mtime = parseOctal(header, 136, 12, "mtime");
    if (mtime !== sourceDateEpoch) throw new Error(`unexpected tar member timestamp for ${path}: ${mtime}`);
    if (offset + size > tar.length) throw new Error(`truncated tar member: ${path}`);
    const bytes = tar.subarray(offset, offset + size);
    entries.push({ path, type: "file", mode: "0644", size, sha256: sha256(bytes), bytes: Buffer.from(bytes) });
    offset += size + ((512 - (size % 512)) % 512);
  }
  if (zeroBlocks !== 2) throw new Error("tar is missing its two terminating zero blocks");
  if (tar.subarray(offset).some((byte) => byte !== 0)) throw new Error("tar has non-zero trailing data");
  return entries.sort((left, right) => utf8Compare(left.path, right.path));
}

export function inspectArtifactBytes(artifactBytes, sourceDateEpoch = SOURCE_DATE_EPOCH) {
  return readArtifactEntries(artifactBytes, sourceDateEpoch).map(({ bytes: _bytes, ...member }) => member);
}

export async function packArtifact({
  vendorRoot,
  packageRoot,
  outputPath,
  sourceDateEpoch = SOURCE_DATE_EPOCH,
}) {
  assertEpoch(sourceDateEpoch);
  const resolvedPackageRoot = resolve(packageRoot);
  const packageManifest = JSON.parse(readFileSync(resolve(resolvedPackageRoot, "package.json"), "utf8"));
  if (packageManifest.name !== PACKAGE_NAME || packageManifest.version !== PACKAGE_VERSION) {
    throw new Error(`package identity must be ${PACKAGE_NAME}@${PACKAGE_VERSION}`);
  }
  if (existsSync(resolve(resolvedPackageRoot, "FORK.json"))) throw new Error("FORK.json must remain external to the artifact");
  const expectedFiles = regularFileManifest(resolvedPackageRoot).map((entry) => entry.path);
  verifyNpmPackSelection(resolvedPackageRoot, expectedFiles);
  const bytes = buildTar(resolvedPackageRoot, sourceDateEpoch);
  const members = inspectArtifactBytes(bytes, sourceDateEpoch);
  const expectedMembers = regularFileManifest(resolvedPackageRoot).map((entry) => ({
    ...entry,
    path: `package/${entry.path}`,
  }));
  if (canonicalJson(members) !== canonicalJson(expectedMembers)) {
    throw new Error("artifact member manifest does not match the built package tree");
  }
  const artifactPath = resolve(outputPath);
  atomicWrite(artifactPath, bytes, sourceDateEpoch);
  return {
    artifactPath,
    artifactSha256: sha256(bytes),
    bytes,
    members,
    membersSha256: canonicalSha256(members),
  };
}

function hashPatchSeries(vendorRoot) {
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

function hashBridgeOverlay(vendorRoot) {
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

function legalMembers(members) {
  return members
    .map((member) => member.path)
    .filter(
      (path) =>
        path === "package/LICENSE" ||
        path === "package/THIRD_PARTY_NOTICES.md" ||
        path.startsWith("package/licenses/"),
    )
    .sort(utf8Compare);
}

function packageMetadataMembers(members) {
  const allowed = new Set(["package/package.json", "package/openclaw.plugin.json", "package/README.md"]);
  return members
    .map((member) => member.path)
    .filter((path) => allowed.has(path))
    .sort(utf8Compare);
}

function forkMetadata({ vendorRoot, packed, installedTree, runtimeDynamicSiteInventory }) {
  const patches = hashPatchSeries(vendorRoot);
  const overlay = hashBridgeOverlay(vendorRoot);
  const legalMemberExceptions = legalMembers(packed.members);
  const packageMetadataExceptions = packageMetadataMembers(packed.members);
  const exceptions = new Set([...legalMemberExceptions, ...packageMetadataExceptions]);
  const runtimeReachabilityAllowlist = packed.members
    .map((member) => member.path)
    .filter((path) => !exceptions.has(path))
    .sort(utf8Compare);
  const publicEntrypoints = [
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
  const licenseManifestBytes = readFileSync(resolve(vendorRoot, "licenses/manifest.json"));
  return {
    schema: 1,
    package: { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    plugin: { id: PLUGIN_ID, channels: [PLUGIN_ID] },
    sourceDateEpoch: SOURCE_DATE_EPOCH,
    artifactPath: `artifacts/${ARTIFACT_NAME}`,
    artifactSha256: packed.artifactSha256,
    builtTgzSha256: packed.artifactSha256,
    artifactMembers: packed.members,
    artifactMembersSha256: packed.membersSha256,
    patches: patches.names,
    patchSeriesSha256: patches.sha256,
    bridgeOverlay: overlay,
    licenseManifestSha256: sha256(licenseManifestBytes),
    publicEntrypoints,
    runtimeDynamicSiteInventory,
    runtimeDynamicImportPatterns: ["package/dist/chunks/*.js"],
    runtimeAssetPatterns: [],
    runtimeReachabilityAllowlist,
    legalMemberExceptions,
    packageMetadataExceptions,
    installedTree,
  };
}

function verifyWithChildProcess({ vendorRoot, artifactPath, installRoot, requireFork, sourceDateEpoch }) {
  const argumentsList = [
    resolve(vendorRoot, "scripts/verify-artifact.mjs"),
    "--artifact",
    artifactPath,
    "--install-root",
    installRoot,
    "--source-date-epoch",
    String(sourceDateEpoch),
    "--json",
  ];
  if (!requireFork) argumentsList.push("--no-fork");
  return JSON.parse(
    execFileSync(process.execPath, argumentsList, {
      cwd: vendorRoot,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

export async function buildReproducibleArtifact({ vendorRoot, preparedRoot, sourceDateEpoch = SOURCE_DATE_EPOCH }) {
  assertEpoch(sourceDateEpoch);
  const workRoot = resolve(vendorRoot, ".work");
  const firstBuild = await buildPreparedTree({
    vendorRoot,
    preparedRoot,
    outputRoot: safeOutput(workRoot, "reproducible-build-a"),
    sourceDateEpoch,
  });
  const secondBuild = await buildPreparedTree({
    vendorRoot,
    preparedRoot,
    outputRoot: safeOutput(workRoot, "reproducible-build-b"),
    sourceDateEpoch,
  });
  const first = await packArtifact({
    vendorRoot,
    packageRoot: firstBuild.packageRoot,
    outputPath: safeOutput(workRoot, "reproducible-a.tgz"),
    sourceDateEpoch,
  });
  const second = await packArtifact({
    vendorRoot,
    packageRoot: secondBuild.packageRoot,
    outputPath: safeOutput(workRoot, "reproducible-b.tgz"),
    sourceDateEpoch,
  });
  if (!first.bytes.equals(second.bytes) || canonicalJson(first.members) !== canonicalJson(second.members)) {
    throw new Error("two clean artifact builds are not byte-identical");
  }
  const artifactPath = resolve(vendorRoot, "artifacts", ARTIFACT_NAME);
  atomicWrite(artifactPath, first.bytes, sourceDateEpoch);
  const verified = verifyWithChildProcess({
    vendorRoot,
    artifactPath,
    installRoot: safeOutput(workRoot, "pack-installed-a"),
    requireFork: false,
    sourceDateEpoch,
  });
  const fork = forkMetadata({
    vendorRoot,
    packed: first,
    installedTree: verified.installedTree,
    runtimeDynamicSiteInventory: firstBuild.runtimeDynamicSiteInventory,
  });
  atomicWrite(resolve(vendorRoot, "FORK.json"), Buffer.from(`${JSON.stringify(fork, null, 2)}\n`, "utf8"), sourceDateEpoch);
  verifyWithChildProcess({
    vendorRoot,
    artifactPath,
    installRoot: safeOutput(workRoot, "pack-installed-b"),
    requireFork: true,
    sourceDateEpoch,
  });
  return { artifactPath, fork };
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
  const repoRoot = resolve(vendorRoot, "../../../..");
  const sourceDateEpoch = Number(parseArgument("--source-date-epoch") ?? SOURCE_DATE_EPOCH);
  const preparedRoot = parseArgument("--prepared")
    ? resolve(parseArgument("--prepared"))
    : await prepareVendorTree({
        repoRoot,
        tarballPath: resolve(vendorRoot, ".work/verified-upstream.tgz"),
        vendorRoot,
      });
  const result = await buildReproducibleArtifact({ vendorRoot, preparedRoot, sourceDateEpoch });
  process.stdout.write(`${result.artifactPath}\n`);
}
