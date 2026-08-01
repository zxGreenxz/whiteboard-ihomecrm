import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as FS_CONSTANTS,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PINNED_NODE = Object.freeze({
  path: "/opt/openclaw-tools/node-v24.15.0-linux-x64/bin/node",
  version: "v24.15.0",
  size: 122889056,
  sha256: "d1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c",
});
const PINNED_GIT = Object.freeze({
  path: "/usr/bin/git",
  version: "git version 2.53.0",
  sha256: "5516c9f362c29376ab9a499a33082f9f611941d8c75930c880e30ad109e39c9a",
});
export const PINNED_PWSH = Object.freeze({
  path: "/opt/openclaw-tools/powershell-7.6.2/pwsh",
  version: "7.6.2",
  sha256: "cd7ac031490349b4ffd203cadf8922af85113b84ab9bfc28a50d03730d9309bc",
});
const PINNED_NPM = Object.freeze({
  version: "11.12.1",
  entry_count: 2169,
  root_sha256: "aebb5b5b1892a7dd23c04af9b5afa24747f752beff2e4f2e781d9eb3830f93d9",
  cli_size: 54,
  cli_sha256: "8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7",
});
const PINNED_BUILDX = Object.freeze({
  path: "/opt/openclaw-tools/docker-buildx-v0.13.1",
  version: "0.13.1",
  sha256: "3e2bc8ed25a9125d6aeec07df4e0211edea6288e075b524160ef3fd305d3d74c",
});
const PINNED_DOCKER = Object.freeze({
  path: "/usr/bin/docker",
  version: "29.1.3",
  sha256: "226408f543344f0d2bfc84c7df4243c5364baccf509e8984d04e1e62c74efac0",
  host: "unix:///run/user/1001/docker.sock",
});
const APPROVAL_MANIFEST_FILE = "approval-manifest-v1.json";
const CLI_OPTIONS = Object.freeze(["--phase", "--repository-root", "--approval-manifest"]);
const INSTALLED_TASK2_ROOT = "/opt/openclaw-tools/reviewed-task2";
const LAUNCHER_PATH = "services/openclaw-zalo-cell/scripts/launch-reviewed-task2.mjs";
const INSTALLER_PATH = "services/openclaw-zalo-cell/scripts/install-reviewed-task2-launcher.mjs";
const ORCHESTRATOR_PATH = "services/openclaw-zalo-cell/scripts/run-reviewed-task2.ps1";
const SOURCE_GATE_PATH = "services/openclaw-zalo-cell/scripts/verify-reviewed-source-gate.mjs";
const BUILD_HELPER_PATH = "services/openclaw-zalo-cell/scripts/build-reproducible-image.ps1";
const EVIDENCE_HELPER_PATH = "services/openclaw-zalo-cell/scripts/create-evidence-child.ps1";
const CURRENT_FILE = fileURLToPath(import.meta.url);
const AUTHORITY_PATHS = Object.freeze({
  installer: INSTALLER_PATH,
  launcher: LAUNCHER_PATH,
  orchestrator: ORCHESTRATOR_PATH,
  source_gate: SOURCE_GATE_PATH,
  build_helper: BUILD_HELPER_PATH,
  evidence_helper: EVIDENCE_HELPER_PATH,
});
const TOP_LEVEL_KEYS = Object.freeze([
  "schema_version",
  "expected_m",
  "reviewed_tree",
  "authorities",
  "review_reports",
  "runtime",
]);
const AUTHORITY_KEYS = Object.freeze(Object.keys(AUTHORITY_PATHS));
const RUNTIME_KEYS = Object.freeze(["node", "git", "powershell", "npm", "buildx", "docker"]);
const MAX_MANIFEST_BYTES = 64 * 1024;
const CANDIDATE_PATHS = Object.freeze([
  "services/openclaw-zalo-cell/.release/task2-build-evidence.json",
  "services/openclaw-zalo-cell/.release/openclaw-zalo-cell-fork-a-linux-amd64.oci.tar",
  "services/openclaw-zalo-cell/.release/openclaw-zalo-cell-fork-b-linux-amd64.oci.tar",
  "services/openclaw-zalo-cell/.release/openclaw-zalo-cell-stock-linux-amd64.oci.tar",
  "services/openclaw-zalo-cell/.release/zalouser-2026.7.1-verified.tgz",
]);

export const POWERSHELL_STDIN_BOOTSTRAP = [
  "$ErrorActionPreference = 'Stop'",
  "$approvedRootText = $env:OPENCLAW_PWSH_APPROVED_ROOT",
  "$logicalPathText = $env:OPENCLAW_PWSH_LOGICAL_PATH",
  "if ([string]::IsNullOrWhiteSpace($approvedRootText) -or [string]::IsNullOrWhiteSpace($logicalPathText)) { throw 'reviewed PowerShell logical path metadata is missing' }",
  "if (-not [IO.Path]::IsPathFullyQualified($approvedRootText) -or -not [IO.Path]::IsPathFullyQualified($logicalPathText)) { throw 'reviewed PowerShell logical paths must be absolute' }",
  "$approvedRoot = [IO.Path]::GetFullPath($approvedRootText)",
  "$logicalPath = [IO.Path]::GetFullPath($logicalPathText)",
  "if ($approvedRoot -cne $approvedRootText -or $logicalPath -cne $logicalPathText) { throw 'reviewed PowerShell logical paths must be canonical' }",
  "$relativePath = [IO.Path]::GetRelativePath($approvedRoot, $logicalPath)",
  "if ([IO.Path]::IsPathRooted($relativePath) -or $relativePath -in @('.', '..') -or $relativePath.StartsWith('..' + [IO.Path]::DirectorySeparatorChar, [StringComparison]::Ordinal)) { throw 'reviewed PowerShell logical path escaped its approved root' }",
  "[long]$expectedSize = 0",
  "if (-not [long]::TryParse($env:OPENCLAW_PWSH_BLOB_SIZE, [Globalization.NumberStyles]::None, [Globalization.CultureInfo]::InvariantCulture, [ref]$expectedSize) -or $expectedSize -lt 1) { throw 'reviewed PowerShell byte length is invalid' }",
  "$expectedSha256 = $env:OPENCLAW_PWSH_BLOB_SHA256",
  "if ($expectedSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'reviewed PowerShell SHA-256 is invalid' }",
  "$memory = [IO.MemoryStream]::new()",
  "try { [Console]::OpenStandardInput().CopyTo($memory); [byte[]]$scriptBytes = $memory.ToArray() } finally { $memory.Dispose() }",
  "if ($scriptBytes.LongLength -ne $expectedSize) { throw 'reviewed PowerShell byte length mismatch' }",
  "$actualSha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($scriptBytes)).ToLowerInvariant()",
  "if ($actualSha256 -cne $expectedSha256) { throw 'reviewed PowerShell SHA-256 mismatch' }",
  "$scriptText = [Text.UTF8Encoding]::new($false, $true).GetString($scriptBytes)",
  "$tokens = $null",
  "$parseErrors = $null",
  "$ast = [Management.Automation.Language.Parser]::ParseInput($scriptText, $logicalPath, [ref]$tokens, [ref]$parseErrors)",
  "if (@($parseErrors).Count -ne 0) { throw 'reviewed PowerShell source contains a parse error' }",
  "$argumentsJson = $env:OPENCLAW_PWSH_ARGUMENTS_JSON",
  "if ([string]::IsNullOrWhiteSpace($argumentsJson)) { throw 'reviewed PowerShell arguments are missing' }",
  "[string[]]$argumentList = [Text.Json.JsonSerializer]::Deserialize[string[]]($argumentsJson)",
  "if ($null -eq $argumentList -or $argumentList.Count -eq 0 -or ($argumentList.Count % 2) -ne 0) { throw 'reviewed PowerShell arguments must be nonempty option/value pairs' }",
  "$namedArguments = [ordered]@{}",
  "for ($index = 0; $index -lt $argumentList.Count; $index += 2) { $option = $argumentList[$index]; if ($option -cnotmatch '^-[A-Za-z][A-Za-z0-9-]*$') { throw 'reviewed PowerShell option name is invalid' }; $parameterName = $option.Substring(1); if ($namedArguments.Contains($parameterName)) { throw 'reviewed PowerShell option is duplicated' }; $namedArguments[$parameterName] = $argumentList[$index + 1] }",
  "$scriptBlock = $ast.GetScriptBlock()",
  "& $scriptBlock @namedArguments",
].join("\n");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitObjectId(type, bytes) {
  return createHash("sha1")
    .update(Buffer.from(`${type} ${bytes.length}\0`, "ascii"))
    .update(bytes)
    .digest("hex");
}

function assertExactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Task 2 approval manifest ${label} must be an object`);
  }
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Task 2 approval manifest ${label} keys/order are not canonical`);
  }
  return value;
}

function assertExactString(value, expected, label) {
  if (typeof value !== "string" || value !== expected) {
    throw new Error(`Task 2 approval manifest ${label} is invalid`);
  }
}

function assertPattern(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`Task 2 approval manifest ${label} is invalid`);
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Task 2 approval manifest ${label} must be a positive safe integer`);
  }
}

function assertFileBinding(binding, expectedPath, label) {
  assertExactKeys(binding, ["repository_path", "blob_oid", "size", "sha256"], `${label} binding`);
  assertExactString(binding.repository_path, expectedPath, `${label} repository path`);
  assertPattern(binding.blob_oid, SHA1, `${label} blob OID`);
  assertPositiveInteger(binding.size, `${label} size`);
  assertPattern(binding.sha256, SHA256, `${label} SHA-256`);
}

function assertReviewReportBinding(binding, checkpoint, identity) {
  assertExactKeys(binding, ["checkpoint", "file_name", "size", "sha256"], `${checkpoint} review report`);
  assertExactString(binding.checkpoint, checkpoint, `${checkpoint} review checkpoint`);
  const prefix = checkpoint === "M" ? "m" : "r";
  assertExactString(
    binding.file_name,
    `${prefix}-review-report-v1-${identity}.json`,
    `${checkpoint} review report file name`,
  );
  assertPositiveInteger(binding.size, `${checkpoint} review report size`);
  assertPattern(binding.sha256, SHA256, `${checkpoint} review report SHA-256`);
}

function assertRuntimeManifest(runtime) {
  assertExactKeys(runtime, RUNTIME_KEYS, "runtime");

  assertExactKeys(runtime.node, ["path", "version", "size", "sha256"], "Node runtime");
  for (const key of ["path", "version", "sha256"]) {
    assertExactString(runtime.node[key], PINNED_NODE[key], `Node runtime ${key}`);
  }
  if (runtime.node.size !== PINNED_NODE.size) {
    throw new Error("Task 2 approval manifest Node runtime size is invalid");
  }

  assertExactKeys(runtime.git, ["path", "version", "sha256"], "Git runtime");
  for (const key of ["path", "version", "sha256"]) {
    assertExactString(runtime.git[key], PINNED_GIT[key], `Git runtime ${key}`);
  }

  assertExactKeys(runtime.powershell, ["path", "version", "sha256", "tree_sha256"], "PowerShell runtime");
  assertExactString(runtime.powershell.path, PINNED_PWSH.path, "PowerShell runtime path");
  assertExactString(runtime.powershell.version, PINNED_PWSH.version, "PowerShell runtime version");
  assertPattern(runtime.powershell.sha256, SHA256, "PowerShell runtime SHA-256");
  assertPattern(runtime.powershell.tree_sha256, SHA256, "PowerShell runtime tree SHA-256");

  assertExactKeys(
    runtime.npm,
    ["root_path", "version", "entry_count", "root_sha256", "cli_path", "cli_size", "cli_sha256"],
    "npm runtime",
  );
  assertExactString(
    runtime.npm.root_path,
    "/opt/openclaw-tools/node-v24.15.0-linux-x64/lib/node_modules/npm",
    "npm runtime root path",
  );
  assertExactString(runtime.npm.version, PINNED_NPM.version, "npm runtime version");
  if (runtime.npm.entry_count !== PINNED_NPM.entry_count) {
    throw new Error("Task 2 approval manifest npm runtime entry count is invalid");
  }
  assertPattern(runtime.npm.root_sha256, SHA256, "npm runtime root SHA-256");
  assertExactString(
    runtime.npm.cli_path,
    "/opt/openclaw-tools/node-v24.15.0-linux-x64/lib/node_modules/npm/bin/npm-cli.js",
    "npm runtime CLI path",
  );
  if (runtime.npm.cli_size !== PINNED_NPM.cli_size) {
    throw new Error("Task 2 approval manifest npm runtime CLI size is invalid");
  }
  assertPattern(runtime.npm.cli_sha256, SHA256, "npm runtime CLI SHA-256");

  assertExactKeys(runtime.buildx, ["path", "version", "sha256"], "buildx runtime");
  assertExactString(runtime.buildx.path, PINNED_BUILDX.path, "buildx runtime path");
  assertExactString(runtime.buildx.version, PINNED_BUILDX.version, "buildx runtime version");
  assertPattern(runtime.buildx.sha256, SHA256, "buildx runtime SHA-256");

  assertExactKeys(runtime.docker, ["path", "version", "sha256", "host"], "Docker runtime");
  for (const key of ["path", "version", "sha256", "host"]) {
    assertExactString(runtime.docker[key], PINNED_DOCKER[key], `Docker runtime ${key}`);
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function parseTask2ApprovalManifest(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error("Task 2 approval manifest must be supplied as UTF-8 bytes");
  }
  const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (raw.length < 3 || raw.length > MAX_MANIFEST_BYTES) {
    throw new Error("Task 2 approval manifest byte length is invalid");
  }
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    throw new Error("Task 2 approval manifest must not contain a UTF-8 BOM");
  }
  if (raw.at(-1) !== 0x0a || raw.at(-2) === 0x0a || raw.includes(0x0d)) {
    throw new Error("Task 2 approval manifest requires exactly one trailing LF and no CR bytes");
  }
  const bodyBytes = raw.subarray(0, raw.length - 1);
  if (bodyBytes.includes(0x0a)) {
    throw new Error("Task 2 approval manifest must be one canonical JSON line");
  }
  let body;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes);
  } catch {
    throw new Error("Task 2 approval manifest is not valid UTF-8");
  }
  let manifest;
  try {
    manifest = JSON.parse(body);
  } catch {
    throw new Error("Task 2 approval manifest is not valid JSON");
  }

  assertExactKeys(manifest, TOP_LEVEL_KEYS, "top-level");
  if (manifest.schema_version !== 1) {
    throw new Error("Task 2 approval manifest schema version is invalid");
  }
  assertPattern(manifest.expected_m, SHA1, "expected M identity");
  assertPattern(manifest.reviewed_tree, SHA1, "reviewed R identity");
  if (manifest.expected_m === manifest.reviewed_tree) {
    throw new Error("Task 2 approval manifest requires distinct M and R identities");
  }

  assertExactKeys(manifest.authorities, AUTHORITY_KEYS, "authorities");
  const repositoryPaths = [];
  for (const key of AUTHORITY_KEYS) {
    assertFileBinding(manifest.authorities[key], AUTHORITY_PATHS[key], `${key} authority`);
    repositoryPaths.push(manifest.authorities[key].repository_path);
  }
  if (new Set(repositoryPaths).size !== repositoryPaths.length) {
    throw new Error("Task 2 approval manifest authority repository paths must be unique");
  }

  assertExactKeys(manifest.review_reports, ["M", "R"], "review reports");
  assertReviewReportBinding(manifest.review_reports.M, "M", manifest.expected_m);
  assertReviewReportBinding(manifest.review_reports.R, "R", manifest.reviewed_tree);
  assertRuntimeManifest(manifest.runtime);

  if (JSON.stringify(manifest) !== body) {
    throw new Error("Task 2 approval manifest is not canonical JSON or contains duplicate keys");
  }
  return deepFreeze(manifest);
}

function assertAbsolute(path, label) {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  return resolve(path);
}

function assertNoSymbolicLinkChain(path, label) {
  let cursor = assertAbsolute(path, label);
  while (true) {
    const item = lstatSync(cursor);
    if (item.isSymbolicLink()) throw new Error(`${label} must not traverse symbolic links`);
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

export function assertRootOwnedImmutablePath(path, label = "root-owned authority") {
  let cursor = assertAbsolute(path, label);
  while (true) {
    const item = lstatSync(cursor);
    if (item.isSymbolicLink()) throw new Error(`${label} must not traverse symbolic links`);
    if (process.platform !== "win32" && typeof process.getuid === "function") {
      if (item.uid !== 0 || item.gid !== 0) {
        throw new Error(`${label} path chain must be owned by root:root: ${cursor}`);
      }
      if ((item.mode & 0o022) !== 0) {
        throw new Error(`${label} path chain must not be group/world writable: ${cursor}`);
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const canonical = resolve(path);
  if (realpathSync(canonical) !== canonical) throw new Error(`${label} path is not canonical`);
  return canonical;
}

function readRegularFileBound(path, label) {
  const canonical = assertAbsolute(path, label);
  assertNoSymbolicLinkChain(canonical, label);
  if (realpathSync(canonical) !== canonical) throw new Error(`${label} is not canonical`);
  const before = lstatSync(canonical, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  const descriptor = openSync(canonical, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`${label} changed before its nofollow descriptor was bound`);
    }
    const bytes = readFileSync(descriptor);
    const handleAfter = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(canonical, { bigint: true });
    if (
      !pathAfter.isFile() || pathAfter.isSymbolicLink() ||
      handleAfter.dev !== opened.dev || handleAfter.ino !== opened.ino ||
      pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino ||
      handleAfter.size !== opened.size || pathAfter.size !== opened.size ||
      handleAfter.mtimeNs !== opened.mtimeNs || handleAfter.ctimeNs !== opened.ctimeNs ||
      pathAfter.mtimeNs !== opened.mtimeNs || pathAfter.ctimeNs !== opened.ctimeNs ||
      BigInt(bytes.length) !== opened.size
    ) {
      throw new Error(`${label} changed while its exact bytes were read`);
    }
    return Object.freeze({ path: canonical, bytes, size: bytes.length, sha256: sha256(bytes) });
  } finally {
    closeSync(descriptor);
  }
}

function readRootOwnedApprovalManifest(path) {
  const canonical = assertAbsolute(path, "Task 2 approval manifest");
  if (basename(canonical) !== APPROVAL_MANIFEST_FILE) {
    throw new Error(`Task 2 approval manifest must use the fixed ${APPROVAL_MANIFEST_FILE} file name`);
  }
  assertRootOwnedImmutablePath(canonical, "Task 2 approval manifest");
  const binding = readRegularFileBound(canonical, "Task 2 approval manifest");
  assertRootOwnedImmutablePath(canonical, "Task 2 approval manifest after read");
  const manifest = parseTask2ApprovalManifest(binding.bytes);
  return Object.freeze({ ...binding, manifest });
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function modeString(item) {
  return (item.mode & 0o7777).toString(8).padStart(4, "0");
}

function bindImmutableDirectoryTree(root, label, domain) {
  const canonicalRoot = assertAbsolute(root, label);
  assertRootOwnedImmutablePath(canonicalRoot, label);
  if (realpathSync(canonicalRoot) !== canonicalRoot) throw new Error(`${label} is not canonical`);
  const rootItem = lstatSync(canonicalRoot);
  if (!rootItem.isDirectory() || rootItem.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  const records = [];
  const walk = (directory, prefix = "") => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of entries) {
      const portablePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (
        entry.name.includes("/") || entry.name.includes("\\") ||
        entry.name === "." || entry.name === ".."
      ) {
        throw new Error(`${label} contains a non-portable path`);
      }
      const absolutePath = join(directory, entry.name);
      const item = lstatSync(absolutePath);
      if (item.isSymbolicLink()) throw new Error(`${label} contains a symbolic link: ${portablePath}`);
      if (process.platform !== "win32" && typeof process.getuid === "function") {
        if (item.uid !== 0 || item.gid !== 0) {
          throw new Error(`${label} entry must be owned by root:root: ${portablePath}`);
        }
        if ((item.mode & 0o022) !== 0) {
          throw new Error(`${label} entry must not be group/world writable: ${portablePath}`);
        }
      }
      if (item.isDirectory()) {
        records.push(Object.freeze({
          path: portablePath,
          type: "directory",
          mode: modeString(item),
          size: 0,
          sha256: sha256(Buffer.alloc(0)),
        }));
        walk(absolutePath, portablePath);
      } else if (item.isFile()) {
        if (item.nlink !== 1) throw new Error(`${label} contains a hardlinked file: ${portablePath}`);
        const file = readRegularFileBound(absolutePath, `${label} ${portablePath}`);
        records.push(Object.freeze({
          path: portablePath,
          type: "file",
          mode: modeString(item),
          size: file.size,
          sha256: file.sha256,
        }));
      } else {
        throw new Error(`${label} contains a special entry: ${portablePath}`);
      }
    }
  };
  walk(canonicalRoot);
  records.sort((left, right) => compareUtf8(left.path, right.path));
  const aggregate = createHash("sha256").update(Buffer.from(`${domain}\0`, "utf8"));
  for (const record of records) {
    aggregate.update(Buffer.from(
      `${record.path}\0${record.type}\0${record.mode}\0${record.size}\0${record.sha256}\0`,
      "utf8",
    ));
  }
  return Object.freeze({ root: canonicalRoot, entryCount: records.length, sha256: aggregate.digest("hex") });
}

function cleanBaseEnvironment() {
  return Object.freeze({ HOME: "/nonexistent", LANG: "C", LC_ALL: "C", TZ: "UTC" });
}

function gitEnvironment() {
  return Object.freeze({
    ...cleanBaseEnvironment(),
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  });
}

const GIT_PREFIX = Object.freeze([
  "--no-replace-objects",
  "-c", "core.commitGraph=false",
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "commit.gpgSign=false",
  "-c", "core.attributesFile=/dev/null",
  "-c", "core.excludesFile=/dev/null",
  "-c", "diff.external=",
  "-c", "credential.helper=",
]);

function runCaptured(file, args, { cwd, env, input } = {}) {
  const result = spawnSync(file, args, {
    cwd,
    env: env ?? cleanBaseEnvironment(),
    input,
    encoding: null,
    maxBuffer: 256 * 1024 * 1024,
    timeout: 60_000,
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`reviewed native command failed (${result.status}): ${file} ${args.join(" ")}\n${result.stderr?.toString("utf8") ?? ""}`);
  }
  if (result.stderr?.length) {
    throw new Error(`reviewed native command wrote unexpected stderr: ${file}\n${result.stderr.toString("utf8")}`);
  }
  return Buffer.from(result.stdout ?? Buffer.alloc(0));
}

function runPowerShell(file, args, { cwd, env, input }) {
  const result = spawnSync(file, args, {
    cwd,
    env,
    input,
    stdio: ["pipe", "inherit", "pipe"],
    timeout: 4 * 60 * 60 * 1000,
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`reviewed PowerShell failed (${result.status})\n${result.stderr?.toString("utf8") ?? ""}`);
  }
  if (result.stderr?.length) {
    throw new Error(`reviewed PowerShell wrote unexpected stderr\n${result.stderr.toString("utf8")}`);
  }
}

function bindExecutable(path, expected, label) {
  assertRootOwnedImmutablePath(path, label);
  const binding = readRegularFileBound(path, label);
  if (binding.sha256 !== expected.sha256 || (expected.size !== undefined && binding.size !== expected.size)) {
    throw new Error(`${label} bytes do not match the pinned authority`);
  }
  return binding;
}

function assertRuntimeMinimumPins(runtime) {
  for (const [actual, minimum, keys, label] of [
    [runtime.node, PINNED_NODE, ["path", "version", "size", "sha256"], "Node"],
    [runtime.git, PINNED_GIT, ["path", "version", "sha256"], "Git"],
    [runtime.powershell, PINNED_PWSH, ["path", "version", "sha256"], "PowerShell"],
    [runtime.npm, PINNED_NPM, ["version", "entry_count", "root_sha256", "cli_size", "cli_sha256"], "npm"],
    [runtime.buildx, PINNED_BUILDX, ["path", "version", "sha256"], "buildx"],
    [runtime.docker, PINNED_DOCKER, ["path", "version", "sha256", "host"], "Docker"],
  ]) {
    if (keys.some((key) => actual[key] !== minimum[key])) {
      throw new Error(`${label} approval binding does not match the hard-coded minimum authority`);
    }
  }
}

function bindNpmAuthority(expected, nodePath) {
  const expectedDistributionRoot = dirname(dirname(nodePath));
  const expectedRoot = resolve(expectedDistributionRoot, "lib/node_modules/npm");
  if (expected.root_path !== expectedRoot || expected.cli_path !== resolve(expectedRoot, "bin/npm-cli.js")) {
    throw new Error("npm approval binding escaped the pinned Node distribution");
  }
  const tree = bindImmutableDirectoryTree(expected.root_path, "npm authority", "ihome-openclaw-npm-authority-v1");
  const packageFile = readRegularFileBound(resolve(expected.root_path, "package.json"), "npm package.json");
  let metadata;
  try {
    metadata = JSON.parse(packageFile.bytes.toString("utf8"));
  } catch {
    throw new Error("npm package metadata is invalid JSON");
  }
  const cli = readRegularFileBound(expected.cli_path, "npm CLI");
  if (
    metadata?.version !== expected.version ||
    tree.entryCount !== expected.entry_count ||
    tree.sha256 !== expected.root_sha256 ||
    cli.size !== expected.cli_size ||
    cli.sha256 !== expected.cli_sha256
  ) {
    throw new Error("npm authority closure does not match the approval manifest");
  }
  return Object.freeze({ ...tree, cliSize: cli.size, cliSha256: cli.sha256 });
}

function bindPowerShellAuthority(expected, label) {
  const executable = bindExecutable(expected.path, expected, label);
  const tree = bindImmutableDirectoryTree(
    dirname(expected.path),
    `${label} distribution`,
    "ihome-openclaw-powershell-authority-v1",
  );
  if (tree.sha256 !== expected.tree_sha256) {
    throw new Error(`${label} distribution tree does not match the approval manifest`);
  }
  const actualVersion = runCaptured(expected.path, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "[Console]::Out.Write($PSVersionTable.PSVersion.ToString())",
  ]).toString("utf8");
  if (actualVersion !== expected.version) throw new Error("PowerShell semantic version mismatch");
  return Object.freeze({ executable, tree });
}

function bindRuntimeAuthorities(runtime, phase) {
  assertRuntimeMinimumPins(runtime);
  if (resolve(process.execPath) !== runtime.node.path) {
    throw new Error("current process.execPath does not equal the approved Node authority path");
  }
  const node = bindExecutable(process.execPath, runtime.node, "Node authority");
  if (runCaptured(process.execPath, ["--version"]).toString("utf8").trim() !== runtime.node.version) {
    throw new Error("Node semantic version mismatch");
  }
  const git = bindExecutable(runtime.git.path, runtime.git, "Git authority");
  const gitVersion = runCaptured(runtime.git.path, ["--version"], {
    env: gitEnvironment(),
  }).toString("utf8").trim();
  if (gitVersion !== runtime.git.version) throw new Error("Git semantic version mismatch");
  const powershell = bindPowerShellAuthority(runtime.powershell, "PowerShell authority");
  const docker = bindExecutable(runtime.docker.path, runtime.docker, "Docker authority");
  const dockerVersion = runCaptured(runtime.docker.path, ["--version"]).toString("utf8").trim();
  const escapedDockerVersion = runtime.docker.version.replaceAll(".", "\\.");
  if (!new RegExp(`^Docker version ${escapedDockerVersion}, build [0-9A-Za-z._+-]+$`, "u").test(dockerVersion)) {
    throw new Error("Docker client semantic version mismatch");
  }
  let npm;
  let buildx;
  if (phase === "qualification") {
    npm = bindNpmAuthority(runtime.npm, runtime.node.path);
    buildx = bindExecutable(runtime.buildx.path, runtime.buildx, "buildx authority");
    const buildxVersion = runCaptured(runtime.buildx.path, ["version"]).toString("utf8");
    const escapedBuildxVersion = runtime.buildx.version.replaceAll(".", "\\.");
    if (!new RegExp(`(?:^|[^0-9])v?${escapedBuildxVersion}(?:[^0-9]|$)`, "u").test(buildxVersion)) {
      throw new Error("buildx semantic version mismatch");
    }
  }
  return Object.freeze({ node, git, powershell, docker, npm, buildx });
}

function assertRuntimeAuthoritiesUnchanged(before, after, phase) {
  for (const [left, right, label] of [
    [before.node, after.node, "Node"],
    [before.git, after.git, "Git"],
    [before.powershell.executable, after.powershell.executable, "PowerShell executable"],
    [before.docker, after.docker, "Docker"],
  ]) {
    if (!sameFileBinding(left, right)) throw new Error(`${label} authority changed during launch`);
  }
  if (
    before.powershell.tree.entryCount !== after.powershell.tree.entryCount ||
    before.powershell.tree.sha256 !== after.powershell.tree.sha256
  ) {
    throw new Error("PowerShell distribution authority changed during launch");
  }
  if (phase === "qualification") {
    if (
      before.npm.entryCount !== after.npm.entryCount ||
      before.npm.sha256 !== after.npm.sha256 ||
      before.npm.cliSize !== after.npm.cliSize ||
      before.npm.cliSha256 !== after.npm.cliSha256
    ) {
      throw new Error("npm authority changed during launch");
    }
    if (!sameFileBinding(before.buildx, after.buildx)) {
      throw new Error("buildx authority changed during launch");
    }
  }
}

function gitBytes(authority, args) {
  return runCaptured(authority.gitPath, [...GIT_PREFIX, "-C", authority.repositoryRoot, ...args], {
    cwd: authority.repositoryRoot,
    env: gitEnvironment(),
  });
}

function gitLine(authority, args, label) {
  const value = gitBytes(authority, args).toString("utf8").trim();
  if (!value || value.includes("\n") || value.includes("\r")) throw new Error(`${label} is not one line`);
  return value;
}

function getAuthenticatedGitObject(authority, objectId, type, label) {
  if (!SHA1.test(objectId)) throw new Error(`${label} object ID is invalid`);
  if (gitLine(authority, ["cat-file", "-t", objectId], `${label} type`) !== type) {
    throw new Error(`${label} object type mismatch`);
  }
  const sizeText = gitLine(authority, ["cat-file", "-s", objectId], `${label} size`);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(sizeText)) throw new Error(`${label} object size is invalid`);
  const bytes = gitBytes(authority, ["cat-file", type, objectId]);
  if (bytes.length !== Number(sizeText) || gitObjectId(type, bytes) !== objectId) {
    throw new Error(`${label} raw Git object authentication failed`);
  }
  return Object.freeze({ objectId, type, size: bytes.length, sha256: sha256(bytes), bytes });
}

function commitTreeId(commit, label) {
  const text = commit.bytes.toString("utf8");
  const headerEnd = text.indexOf("\n\n");
  if (headerEnd < 0) throw new Error(`${label} has no header terminator`);
  const trees = text.slice(0, headerEnd).split("\n").filter((line) => /^tree [0-9a-f]{40}$/u.test(line));
  if (trees.length !== 1) throw new Error(`${label} must contain exactly one tree`);
  return trees[0].slice(5);
}

function commitParentIds(commit, label) {
  const headerEnd = commit.bytes.indexOf(Buffer.from("\n\n", "ascii"));
  if (headerEnd < 0) throw new Error(`${label} has no header terminator`);
  const header = commit.bytes.subarray(0, headerEnd).toString("utf8");
  if (header.includes("\r") || header.includes("\0")) throw new Error(`${label} headers are malformed`);
  const parents = [];
  for (const line of header.split("\n")) {
    if (!line.startsWith("parent ")) continue;
    if (!/^parent [0-9a-f]{40}$/u.test(line)) throw new Error(`${label} parent header is malformed`);
    parents.push(line.slice(7));
  }
  return Object.freeze(parents);
}

export function authenticateRawCommitAncestry({ gitPath, repositoryRoot, expectedM, reviewedTree }) {
  if (!SHA1.test(expectedM ?? "") || !SHA1.test(reviewedTree ?? "")) {
    throw new Error("approved ancestry identities are invalid");
  }
  const authority = Object.freeze({
    gitPath: assertAbsolute(gitPath, "Git path"),
    repositoryRoot: assertAbsolute(repositoryRoot, "repository root"),
  });
  const pending = [reviewedTree];
  const visited = new Set();
  while (pending.length > 0) {
    const objectId = pending.shift();
    if (visited.has(objectId)) continue;
    visited.add(objectId);
    if (visited.size > 100_000) throw new Error("approved ancestry exceeds the authenticated commit bound");
    const commit = getAuthenticatedGitObject(authority, objectId, "commit", `approved ancestry commit ${objectId}`);
    commitTreeId(commit, `approved ancestry commit ${objectId}`);
    if (objectId === expectedM) {
      return Object.freeze({ expectedM, reviewedTree, authenticatedCommitCount: visited.size });
    }
    for (const parent of commitParentIds(commit, `approved ancestry commit ${objectId}`)) {
      if (!visited.has(parent)) pending.push(parent);
    }
  }
  throw new Error("approved M is not on an authenticated raw commit path from approved R");
}

function findTreeEntry(tree, name, label) {
  let offset = 0;
  let match;
  while (offset < tree.bytes.length) {
    const nul = tree.bytes.indexOf(0, offset);
    if (nul <= offset || nul + 20 >= tree.bytes.length) throw new Error(`${label} tree is malformed`);
    const header = tree.bytes.subarray(offset, nul).toString("utf8");
    const space = header.indexOf(" ");
    if (space <= 0) throw new Error(`${label} tree header is malformed`);
    const entry = Object.freeze({
      mode: header.slice(0, space),
      name: header.slice(space + 1),
      objectId: tree.bytes.subarray(nul + 1, nul + 21).toString("hex"),
    });
    if (entry.name === name) {
      if (match) throw new Error(`${label} tree contains a duplicate segment`);
      match = entry;
    }
    offset = nul + 21;
  }
  if (!match) throw new Error(`${label} path segment is absent: ${name}`);
  return match;
}

export function getAuthenticatedReviewedBlob(authority, reviewedTree, repositoryPath, label) {
  if (!SHA1.test(reviewedTree)) throw new Error("reviewed R is invalid");
  if (
    repositoryPath.startsWith("/") || repositoryPath.includes("\\") ||
    repositoryPath.split("/").some((part) => ["", ".", ".."].includes(part))
  ) {
    throw new Error(`${label} path is not portable`);
  }
  const commit = getAuthenticatedGitObject(authority, reviewedTree, "commit", "reviewed R commit");
  let tree = getAuthenticatedGitObject(authority, commitTreeId(commit, "reviewed R commit"), "tree", "reviewed R tree");
  const segments = repositoryPath.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const entry = findTreeEntry(tree, segments[index], label);
    if (index < segments.length - 1) {
      if (entry.mode !== "40000") throw new Error(`${label} parent is not a tree`);
      tree = getAuthenticatedGitObject(authority, entry.objectId, "tree", `${label} parent tree`);
    } else {
      if (!["100644", "100755"].includes(entry.mode)) throw new Error(`${label} is not a regular blob`);
      return getAuthenticatedGitObject(authority, entry.objectId, "blob", label);
    }
  }
  throw new Error(`unable to resolve ${label}`);
}

function assertGitAncestry(authority, expectedM, reviewedTree) {
  const result = spawnSync(
    authority.gitPath,
    [...GIT_PREFIX, "-C", authority.repositoryRoot, "merge-base", "--is-ancestor", expectedM, reviewedTree],
    {
      cwd: authority.repositoryRoot,
      env: gitEnvironment(),
      encoding: null,
      timeout: 60_000,
      shell: false,
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (result.stderr?.length || result.stdout?.length) {
    throw new Error("Git M-to-R ancestry proof wrote unexpected output");
  }
  if (result.status !== 0) throw new Error("approved M is not an ancestor of approved R");
}

function authenticateReviewedLineage(authority, manifest) {
  const expectedM = getAuthenticatedGitObject(authority, manifest.expected_m, "commit", "approved M commit");
  const reviewedR = getAuthenticatedGitObject(authority, manifest.reviewed_tree, "commit", "approved R commit");
  const expectedMTree = getAuthenticatedGitObject(
    authority,
    commitTreeId(expectedM, "approved M commit"),
    "tree",
    "approved M tree",
  );
  const reviewedRTree = getAuthenticatedGitObject(
    authority,
    commitTreeId(reviewedR, "approved R commit"),
    "tree",
    "approved R tree",
  );
  authenticateRawCommitAncestry({
    gitPath: authority.gitPath,
    repositoryRoot: authority.repositoryRoot,
    expectedM: manifest.expected_m,
    reviewedTree: manifest.reviewed_tree,
  });
  assertGitAncestry(authority, manifest.expected_m, manifest.reviewed_tree);
  return Object.freeze({ expectedM, reviewedR, expectedMTree, reviewedRTree });
}

function authenticateManifestAuthorities(authority, manifest) {
  const authenticated = {};
  for (const key of AUTHORITY_KEYS) {
    const expected = manifest.authorities[key];
    const blob = getAuthenticatedReviewedBlob(
      authority,
      manifest.reviewed_tree,
      expected.repository_path,
      `approved ${key} authority`,
    );
    if (
      blob.objectId !== expected.blob_oid ||
      blob.size !== expected.size ||
      blob.sha256 !== expected.sha256
    ) {
      throw new Error(`approved ${key} authority does not match its exact raw-R blob binding`);
    }
    authenticated[key] = blob;
  }
  return Object.freeze(authenticated);
}

function sameFileBinding(before, after) {
  return before.size === after.size && before.sha256 === after.sha256;
}

function sameGitBinding(before, after) {
  return (
    before.objectId === after.objectId &&
    before.type === after.type &&
    before.size === after.size &&
    before.sha256 === after.sha256
  );
}

function portableRepositoryPath(repositoryRoot, path, label) {
  const rel = relative(repositoryRoot, assertAbsolute(path, label));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} escaped the repository`);
  }
  const portable = rel.split(sep).join("/");
  if (portable.includes("\\")) throw new Error(`${label} is not portable`);
  return portable;
}

export function powerShellArgv(phase) {
  if (!["qualification", "evidence"].includes(phase)) throw new Error("Task 2 phase is invalid");
  return Object.freeze([
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    POWERSHELL_STDIN_BOOTSTRAP,
  ]);
}

export function buildPowerShellEnvironment(options) {
  const required = [
    "phase", "workRoot", "reviewedTree", "expectedM", "mReviewReport", "rReviewReport",
    "approvalManifestPath", "nodePath", "gitPath", "dockerPath", "dockerHost",
    "scriptApprovedRoot", "scriptLogicalPath",
  ];
  for (const key of required) if (typeof options[key] !== "string" || options[key] === "") throw new Error(`${key} is required`);
  if (!["qualification", "evidence"].includes(options.phase)) throw new Error("Task 2 phase is invalid");
  if (!SHA1.test(options.reviewedTree) || !SHA1.test(options.expectedM)) throw new Error("reviewed Git identities are invalid");
  for (const key of [
    "workRoot", "mReviewReport", "rReviewReport", "approvalManifestPath", "nodePath", "gitPath",
    "dockerPath",
  ]) {
    assertAbsolute(options[key], key);
  }
  assertAbsolute(options.scriptApprovedRoot, "scriptApprovedRoot");
  assertAbsolute(options.scriptLogicalPath, "scriptLogicalPath");
  const scriptApprovedRoot = options.scriptApprovedRoot;
  const scriptLogicalPath = options.scriptLogicalPath;
  const relativeScriptPath = relative(scriptApprovedRoot, scriptLogicalPath);
  if (
    !relativeScriptPath || relativeScriptPath === ".." || relativeScriptPath.startsWith(`..${sep}`) ||
    isAbsolute(relativeScriptPath)
  ) {
    throw new Error("reviewed PowerShell logical path escaped its approved root");
  }
  if (!Number.isSafeInteger(options.scriptSize) || options.scriptSize < 1) {
    throw new Error("reviewed PowerShell scriptSize is invalid");
  }
  if (!SHA256.test(options.scriptSha256 ?? "")) {
    throw new Error("reviewed PowerShell scriptSha256 is invalid");
  }
  const environment = {
    HOME: join(options.workRoot, "home"),
    TMPDIR: join(options.workRoot, "tmp"),
    XDG_CACHE_HOME: join(options.workRoot, "xdg-cache"),
    XDG_CONFIG_HOME: join(options.workRoot, "xdg-config"),
    XDG_DATA_HOME: join(options.workRoot, "xdg-data"),
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    PATH: "/nonexistent",
    PSModulePath: "/opt/openclaw-tools/powershell-7.6.2/Modules",
    POWERSHELL_TELEMETRY_OPTOUT: "1",
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    OPENCLAW_REVIEWED_R_SHA: options.reviewedTree,
    OPENCLAW_REVIEWED_M_SHA: options.expectedM,
    OPENCLAW_M_REVIEW_REPORT: options.mReviewReport,
    OPENCLAW_R_REVIEW_REPORT: options.rReviewReport,
    OPENCLAW_TASK2_APPROVAL_MANIFEST: options.approvalManifestPath,
    OPENCLAW_NODE_PATH: options.nodePath,
    OPENCLAW_GIT_PATH: options.gitPath,
    OPENCLAW_DOCKER_PATH: options.dockerPath,
    OPENCLAW_DOCKER_HOST: options.dockerHost,
    OPENCLAW_PWSH_APPROVED_ROOT: scriptApprovedRoot,
    OPENCLAW_PWSH_LOGICAL_PATH: scriptLogicalPath,
    OPENCLAW_PWSH_BLOB_SIZE: String(options.scriptSize),
    OPENCLAW_PWSH_BLOB_SHA256: options.scriptSha256,
    OPENCLAW_PWSH_ARGUMENTS_JSON: JSON.stringify([
      "-Phase",
      options.phase === "qualification" ? "Qualification" : "Evidence",
    ]),
  };
  if (options.phase === "qualification") {
    environment.OPENCLAW_NPM_ROOT = assertAbsolute(options.npmRoot, "npmRoot");
    environment.OPENCLAW_BUILDX_PATH = assertAbsolute(options.buildxPath, "buildxPath");
  }
  return Object.freeze(environment);
}

function parseArgs(argv) {
  if (argv.length % 2 !== 0) throw new Error("Task 2 launcher arguments must be option/value pairs");
  const allowed = new Set(CLI_OPTIONS.map((option) => option.slice(2)));
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!/^--[a-z0-9-]+$/u.test(option ?? "") || value === undefined || value.startsWith("--")) {
      throw new Error("Task 2 launcher arguments are invalid");
    }
    const name = option.slice(2);
    if (!allowed.has(name)) throw new Error(`unknown Task 2 launcher option: ${option}`);
    if (Object.hasOwn(values, name)) throw new Error(`duplicate Task 2 launcher option: ${option}`);
    values[name] = value;
  }
  for (const name of ["phase", "repository-root", "approval-manifest"]) {
    if (!values[name]) throw new Error(`--${name} is required`);
  }
  if (!["qualification", "evidence"].includes(values.phase)) throw new Error("--phase is invalid");
  return Object.freeze(values);
}

function assertCanonicalDockerHost(value) {
  if (typeof value !== "string" || !/^unix:\/\/[A-Za-z0-9._/-]+$/u.test(value)) {
    throw new Error("Task 2 Docker host must be an explicit canonical Unix socket URI");
  }
  const socketPath = value.slice("unix://".length);
  if (
    !socketPath.startsWith("/") ||
    socketPath.includes("//") ||
    socketPath.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("Task 2 Docker host path is not canonical");
  }
  return value;
}

function assertReleaseIdentity() {
  if (
    process.platform === "win32" ||
    typeof process.getuid !== "function" ||
    typeof process.getgid !== "function" ||
    process.getuid() !== 1001 ||
    process.getgid() !== 1001
  ) {
    throw new Error("reviewed Task 2 launcher must run as openclaw-runner uid/gid 1001");
  }
}

function bindReviewReport(path, expected, label) {
  const binding = readRegularFileBound(path, label);
  if (binding.size !== expected.size || binding.sha256 !== expected.sha256) {
    throw new Error(`${label} bytes do not match the approval manifest`);
  }
  return binding;
}

function assertCanonicalReviewReports(manifest, releaseRoot) {
  const reviewRoot = resolve(releaseRoot, "reviews");
  const expectedM = resolve(reviewRoot, manifest.review_reports.M.file_name);
  const expectedR = resolve(reviewRoot, manifest.review_reports.R.file_name);
  if (dirname(expectedM) !== reviewRoot || dirname(expectedR) !== reviewRoot) {
    throw new Error("canonical SHA-bound M/R review reports are required");
  }
  return Object.freeze([
    bindReviewReport(expectedM, manifest.review_reports.M, "M review report"),
    bindReviewReport(expectedR, manifest.review_reports.R, "R review report"),
  ]);
}

function assertInstalledApprovalPaths(approvalManifestPath, manifest) {
  const installRoot = resolve(INSTALLED_TASK2_ROOT, manifest.reviewed_tree);
  const expectedLauncher = resolve(installRoot, "launch-reviewed-task2.mjs");
  const expectedManifest = resolve(installRoot, APPROVAL_MANIFEST_FILE);
  if (resolve(CURRENT_FILE) !== expectedLauncher || resolve(approvalManifestPath) !== expectedManifest) {
    throw new Error("Task 2 launcher and approval manifest are not at their exact R-bound installed paths");
  }
  assertRootOwnedImmutablePath(CURRENT_FILE, "installed Task 2 launcher");
  assertRootOwnedImmutablePath(approvalManifestPath, "installed Task 2 approval manifest");
  return Object.freeze({ installRoot, launcherPath: expectedLauncher, manifestPath: expectedManifest });
}

function invokeSourceGate(authority, options, allowedPaths) {
  const gate = getAuthenticatedReviewedBlob(authority, options.reviewedTree, SOURCE_GATE_PATH, "reviewed source gate");
  const args = [
    "--input-type=module", "-",
    "--git-path", authority.gitPath,
    "--repository-root", authority.repositoryRoot,
    "--reviewed-tree", options.reviewedTree,
    "--git-sha256", PINNED_GIT.sha256,
  ];
  for (const path of allowedPaths) args.push("--allow-untracked", path);
  const output = runCaptured(options.nodePath, args, {
    cwd: authority.repositoryRoot,
    env: cleanBaseEnvironment(),
    input: gate.bytes,
  });
  const record = JSON.parse(output.toString("utf8"));
  if (
    record.reviewed_tree !== options.reviewedTree ||
    JSON.stringify(record.allowed_untracked_paths) !== JSON.stringify([...allowedPaths].sort())
  ) {
    throw new Error("reviewed source gate returned an unexpected binding");
  }
  return gate;
}

function createPrivateWorkRoot() {
  const tempRoot = "/tmp";
  const item = lstatSync(tempRoot);
  if (!item.isDirectory() || item.isSymbolicLink()) throw new Error("fixed temp root is invalid");
  const workRoot = mkdtempSync(join(tempRoot, "ihome-openclaw-task2-launch-"));
  chmodSync(workRoot, 0o700);
  for (const name of ["home", "tmp", "xdg-cache", "xdg-config", "xdg-data"]) {
    const path = join(workRoot, name);
    mkdirSync(path, { mode: 0o700 });
  }
  return workRoot;
}

function removePrivateWorkRoot(workRoot) {
  if (!workRoot?.startsWith("/tmp/ihome-openclaw-task2-launch-") || dirname(workRoot) !== "/tmp") {
    throw new Error("refusing to remove an untrusted launcher work root");
  }
  const item = lstatSync(workRoot);
  if (!item.isDirectory() || item.isSymbolicLink()) throw new Error("launcher work root changed before cleanup");
  rmSync(workRoot, { recursive: true, force: false });
}

export function runReviewedTask2(rawOptions) {
  assertReleaseIdentity();
  if (!["qualification", "evidence"].includes(rawOptions.phase)) {
    throw new Error("Task 2 phase is invalid");
  }
  const approvalManifestPath = assertAbsolute(rawOptions.approvalManifestPath, "Task 2 approval manifest");
  const approvalBefore = readRootOwnedApprovalManifest(approvalManifestPath);
  const manifest = approvalBefore.manifest;
  assertInstalledApprovalPaths(approvalManifestPath, manifest);
  const options = Object.freeze({
    phase: rawOptions.phase,
    repositoryRoot: assertAbsolute(rawOptions.repositoryRoot, "repository root"),
    approvalManifestPath,
    reviewedTree: manifest.reviewed_tree,
    expectedM: manifest.expected_m,
    nodePath: manifest.runtime.node.path,
    gitPath: manifest.runtime.git.path,
    npmRoot: manifest.runtime.npm.root_path,
    buildxPath: manifest.runtime.buildx.path,
    dockerPath: manifest.runtime.docker.path,
    dockerHost: assertCanonicalDockerHost(manifest.runtime.docker.host),
  });
  assertNoSymbolicLinkChain(options.repositoryRoot, "repository root");
  if (realpathSync(options.repositoryRoot) !== options.repositoryRoot) {
    throw new Error("repository root is not canonical");
  }
  const repositoryItem = lstatSync(options.repositoryRoot);
  if (!repositoryItem.isDirectory() || repositoryItem.isSymbolicLink()) throw new Error("repository root is invalid");

  const runtimeBefore = bindRuntimeAuthorities(manifest.runtime, options.phase);
  const authority = Object.freeze({
    gitPath: manifest.runtime.git.path,
    repositoryRoot: options.repositoryRoot,
  });
  const lineageBefore = authenticateReviewedLineage(authority, manifest);
  const authoritiesBefore = authenticateManifestAuthorities(authority, manifest);
  const currentLauncherBefore = readRegularFileBound(CURRENT_FILE, "installed Task 2 launcher");
  if (
    !sameFileBinding(currentLauncherBefore, authoritiesBefore.launcher) ||
    !currentLauncherBefore.bytes.equals(authoritiesBefore.launcher.bytes)
  ) {
    throw new Error("current launcher source is not byte-equal to the exact raw-R launcher authority");
  }

  const releaseRoot = resolve(options.repositoryRoot, "services/openclaw-zalo-cell/.release");
  const reportsBefore = assertCanonicalReviewReports(manifest, releaseRoot);
  const optionsWithReports = Object.freeze({
    ...options,
    mReviewReport: reportsBefore[0].path,
    rReviewReport: reportsBefore[1].path,
  });
  const allowedPaths = reportsBefore.map((report, index) => portableRepositoryPath(
    options.repositoryRoot,
    report.path,
    index === 0 ? "M review report" : "R review report",
  ));
  if (options.phase === "evidence") allowedPaths.push(...CANDIDATE_PATHS);
  const sourceGate = invokeSourceGate(authority, options, allowedPaths);
  if (!sameGitBinding(sourceGate, authoritiesBefore.source_gate)) {
    throw new Error("source gate execution bytes do not match the approval manifest");
  }

  let workRoot;
  let primaryError;
  let cleanupError;
  try {
    workRoot = createPrivateWorkRoot();
    const env = buildPowerShellEnvironment({
      ...optionsWithReports,
      workRoot,
      scriptApprovedRoot: options.repositoryRoot,
      scriptLogicalPath: resolve(options.repositoryRoot, ORCHESTRATOR_PATH),
      scriptSize: authoritiesBefore.orchestrator.size,
      scriptSha256: authoritiesBefore.orchestrator.sha256,
    });
    runPowerShell(manifest.runtime.powershell.path, powerShellArgv(options.phase), {
      cwd: options.repositoryRoot,
      env,
      input: authoritiesBefore.orchestrator.bytes,
    });
    const approvalAfter = readRootOwnedApprovalManifest(approvalManifestPath);
    if (
      !sameFileBinding(approvalBefore, approvalAfter) ||
      !approvalBefore.bytes.equals(approvalAfter.bytes)
    ) {
      throw new Error("Task 2 approval manifest changed during launch");
    }
    assertInstalledApprovalPaths(approvalManifestPath, approvalAfter.manifest);
    const currentLauncherAfter = readRegularFileBound(CURRENT_FILE, "installed Task 2 launcher after launch");
    if (
      !sameFileBinding(currentLauncherBefore, currentLauncherAfter) ||
      !currentLauncherBefore.bytes.equals(currentLauncherAfter.bytes)
    ) {
      throw new Error("installed Task 2 launcher changed during launch");
    }
    const runtimeAfter = bindRuntimeAuthorities(manifest.runtime, options.phase);
    assertRuntimeAuthoritiesUnchanged(runtimeBefore, runtimeAfter, options.phase);
    const lineageAfter = authenticateReviewedLineage(authority, manifest);
    for (const key of ["expectedM", "reviewedR", "expectedMTree", "reviewedRTree"]) {
      if (!sameGitBinding(lineageBefore[key], lineageAfter[key])) {
        throw new Error(`approved ${key} Git binding changed during launch`);
      }
    }
    const authoritiesAfter = authenticateManifestAuthorities(authority, manifest);
    for (const key of AUTHORITY_KEYS) {
      if (!sameGitBinding(authoritiesBefore[key], authoritiesAfter[key])) {
        throw new Error(`approved ${key} authority changed during launch`);
      }
    }
    const reportsAfter = assertCanonicalReviewReports(manifest, releaseRoot);
    for (let index = 0; index < reportsBefore.length; index += 1) {
      if (
        !sameFileBinding(reportsBefore[index], reportsAfter[index]) ||
        !reportsBefore[index].bytes.equals(reportsAfter[index].bytes)
      ) {
        throw new Error(`${index === 0 ? "M" : "R"} review report changed during launch`);
      }
    }
  } catch (error) {
    primaryError = error;
  } finally {
    if (workRoot) {
      try {
        removePrivateWorkRoot(workRoot);
      } catch (error) {
        cleanupError = error;
      }
    }
  }
  if (primaryError) {
    if (cleanupError) process.stderr.write(`Task 2 launcher cleanup also failed: ${cleanupError.message}\n`);
    throw primaryError;
  }
  if (cleanupError) throw cleanupError;
  return Object.freeze({
    reviewedTree: options.reviewedTree,
    expectedM: options.expectedM,
    phase: options.phase,
    launcherBlob: authoritiesBefore.launcher.objectId,
    orchestratorBlob: authoritiesBefore.orchestrator.objectId,
    sourceGateBlob: sourceGate.objectId,
  });
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  runReviewedTask2({
    phase: parsed.phase,
    repositoryRoot: parsed["repository-root"],
    approvalManifestPath: parsed["approval-manifest"],
  });
}

if (process.argv[1] === "-" || (process.argv[1] && resolve(process.argv[1]) === CURRENT_FILE)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
