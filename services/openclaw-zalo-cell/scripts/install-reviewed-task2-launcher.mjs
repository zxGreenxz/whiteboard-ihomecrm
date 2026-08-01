import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as FS_CONSTANTS,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const APPROVAL_MANIFEST_FILE = "approval-manifest-v1.json";
const BOOTSTRAP_INSTALLER = "/opt/openclaw-tools/reviewed-task2-bootstrap/install-reviewed-task2-launcher.mjs";
const APPROVAL_ROOT = "/opt/openclaw-tools/reviewed-task2-approvals";
const INSTALL_ROOT = "/opt/openclaw-tools/reviewed-task2";
const CURRENT_FILE = fileURLToPath(import.meta.url);
const INSTALLER_PATH = "services/openclaw-zalo-cell/scripts/install-reviewed-task2-launcher.mjs";
const LAUNCHER_PATH = "services/openclaw-zalo-cell/scripts/launch-reviewed-task2.mjs";
const AUTHORITY_PATHS = Object.freeze({
  installer: INSTALLER_PATH,
  launcher: LAUNCHER_PATH,
  orchestrator: "services/openclaw-zalo-cell/scripts/run-reviewed-task2.ps1",
  source_gate: "services/openclaw-zalo-cell/scripts/verify-reviewed-source-gate.mjs",
  build_helper: "services/openclaw-zalo-cell/scripts/build-reproducible-image.ps1",
  evidence_helper: "services/openclaw-zalo-cell/scripts/create-evidence-child.ps1",
});
const AUTHORITY_KEYS = Object.freeze(Object.keys(AUTHORITY_PATHS));
const TOP_LEVEL_KEYS = Object.freeze([
  "schema_version",
  "expected_m",
  "reviewed_tree",
  "authorities",
  "review_reports",
  "runtime",
]);
const RUNTIME_KEYS = Object.freeze(["node", "git", "powershell", "npm", "buildx", "docker"]);
const MAX_MANIFEST_BYTES = 64 * 1024;
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
const PINNED_PWSH = Object.freeze({
  path: "/opt/openclaw-tools/powershell-7.6.2/pwsh",
  version: "7.6.2",
  sha256: "cd7ac031490349b4ffd203cadf8922af85113b84ab9bfc28a50d03730d9309bc",
});
const PINNED_NPM = Object.freeze({
  root_path: "/opt/openclaw-tools/node-v24.15.0-linux-x64/lib/node_modules/npm",
  version: "11.12.1",
  entry_count: 2169,
  root_sha256: "aebb5b5b1892a7dd23c04af9b5afa24747f752beff2e4f2e781d9eb3830f93d9",
  cli_path: "/opt/openclaw-tools/node-v24.15.0-linux-x64/lib/node_modules/npm/bin/npm-cli.js",
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

function assertReviewReport(binding, checkpoint, identity) {
  assertExactKeys(binding, ["checkpoint", "file_name", "size", "sha256"], `${checkpoint} review report`);
  assertExactString(binding.checkpoint, checkpoint, `${checkpoint} review checkpoint`);
  assertExactString(
    binding.file_name,
    `${checkpoint === "M" ? "m" : "r"}-review-report-v1-${identity}.json`,
    `${checkpoint} review report file name`,
  );
  assertPositiveInteger(binding.size, `${checkpoint} review report size`);
  assertPattern(binding.sha256, SHA256, `${checkpoint} review report SHA-256`);
}

function assertRuntime(runtime) {
  assertExactKeys(runtime, RUNTIME_KEYS, "runtime");
  assertExactKeys(runtime.node, ["path", "version", "size", "sha256"], "Node runtime");
  for (const key of ["path", "version", "size", "sha256"]) {
    if (runtime.node[key] !== PINNED_NODE[key]) throw new Error(`Task 2 approval manifest Node ${key} is invalid`);
  }
  assertExactKeys(runtime.git, ["path", "version", "sha256"], "Git runtime");
  for (const key of ["path", "version", "sha256"]) {
    if (runtime.git[key] !== PINNED_GIT[key]) throw new Error(`Task 2 approval manifest Git ${key} is invalid`);
  }
  assertExactKeys(runtime.powershell, ["path", "version", "sha256", "tree_sha256"], "PowerShell runtime");
  for (const key of ["path", "version", "sha256"]) {
    if (runtime.powershell[key] !== PINNED_PWSH[key]) {
      throw new Error(`Task 2 approval manifest PowerShell ${key} is invalid`);
    }
  }
  assertPattern(runtime.powershell.tree_sha256, SHA256, "PowerShell tree SHA-256");
  assertExactKeys(
    runtime.npm,
    ["root_path", "version", "entry_count", "root_sha256", "cli_path", "cli_size", "cli_sha256"],
    "npm runtime",
  );
  for (const key of Object.keys(PINNED_NPM)) {
    if (runtime.npm[key] !== PINNED_NPM[key]) throw new Error(`Task 2 approval manifest npm ${key} is invalid`);
  }
  assertExactKeys(runtime.buildx, ["path", "version", "sha256"], "buildx runtime");
  for (const key of Object.keys(PINNED_BUILDX)) {
    if (runtime.buildx[key] !== PINNED_BUILDX[key]) throw new Error(`Task 2 approval manifest buildx ${key} is invalid`);
  }
  assertExactKeys(runtime.docker, ["path", "version", "sha256", "host"], "Docker runtime");
  for (const key of Object.keys(PINNED_DOCKER)) {
    if (runtime.docker[key] !== PINNED_DOCKER[key]) throw new Error(`Task 2 approval manifest Docker ${key} is invalid`);
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
  if (!(bytes instanceof Uint8Array)) throw new Error("Task 2 approval manifest must be bytes");
  const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (raw.length < 3 || raw.length > MAX_MANIFEST_BYTES) throw new Error("Task 2 approval manifest size is invalid");
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) throw new Error("Task 2 approval manifest has a BOM");
  if (raw.at(-1) !== 0x0a || raw.at(-2) === 0x0a || raw.includes(0x0d)) {
    throw new Error("Task 2 approval manifest requires one trailing LF and no CR");
  }
  const bodyBytes = raw.subarray(0, raw.length - 1);
  if (bodyBytes.includes(0x0a)) throw new Error("Task 2 approval manifest must be one JSON line");
  let body;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes);
  } catch {
    throw new Error("Task 2 approval manifest is not UTF-8");
  }
  let manifest;
  try {
    manifest = JSON.parse(body);
  } catch {
    throw new Error("Task 2 approval manifest is not JSON");
  }
  assertExactKeys(manifest, TOP_LEVEL_KEYS, "top-level");
  if (manifest.schema_version !== 1) throw new Error("Task 2 approval manifest schema version is invalid");
  assertPattern(manifest.expected_m, SHA1, "expected M");
  assertPattern(manifest.reviewed_tree, SHA1, "reviewed R");
  if (manifest.expected_m === manifest.reviewed_tree) throw new Error("Task 2 approval manifest M and R must differ");
  assertExactKeys(manifest.authorities, AUTHORITY_KEYS, "authorities");
  for (const key of AUTHORITY_KEYS) assertFileBinding(manifest.authorities[key], AUTHORITY_PATHS[key], key);
  assertExactKeys(manifest.review_reports, ["M", "R"], "review reports");
  assertReviewReport(manifest.review_reports.M, "M", manifest.expected_m);
  assertReviewReport(manifest.review_reports.R, "R", manifest.reviewed_tree);
  assertRuntime(manifest.runtime);
  if (JSON.stringify(manifest) !== body) throw new Error("Task 2 approval manifest is not canonical JSON");
  return deepFreeze(manifest);
}

function assertAbsolute(path, label) {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  return resolve(path);
}

export function assertRootOwnedImmutablePath(path, label = "root-owned authority") {
  let cursor = assertAbsolute(path, label);
  while (true) {
    const item = lstatSync(cursor);
    if (item.isSymbolicLink()) throw new Error(`${label} must not traverse symbolic links`);
    if (process.platform !== "win32" && typeof process.getuid === "function") {
      if (item.uid !== 0 || item.gid !== 0) throw new Error(`${label} must be owned by root:root: ${cursor}`);
      if ((item.mode & 0o022) !== 0) throw new Error(`${label} must not be group/world writable: ${cursor}`);
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const canonical = resolve(path);
  if (realpathSync(canonical) !== canonical) throw new Error(`${label} must be canonical`);
  return canonical;
}

function readRegularFileBound(path, label) {
  const canonical = assertAbsolute(path, label);
  const before = lstatSync(canonical, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  const descriptor = openSync(canonical, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`${label} changed before its descriptor was bound`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(canonical, { bigint: true });
    if (
      after.dev !== opened.dev || after.ino !== opened.ino || pathAfter.dev !== opened.dev ||
      pathAfter.ino !== opened.ino || after.size !== opened.size || pathAfter.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs ||
      pathAfter.mtimeNs !== opened.mtimeNs || pathAfter.ctimeNs !== opened.ctimeNs ||
      BigInt(bytes.length) !== opened.size
    ) {
      throw new Error(`${label} changed while its bytes were read`);
    }
    return Object.freeze({ path: canonical, bytes, size: bytes.length, sha256: sha256(bytes) });
  } finally {
    closeSync(descriptor);
  }
}

function cleanEnvironment() {
  return Object.freeze({
    HOME: "/nonexistent",
    LANG: "C",
    LC_ALL: "C",
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

function runCaptured(file, args, { cwd } = {}) {
  const result = spawnSync(file, args, {
    cwd,
    env: cleanEnvironment(),
    encoding: null,
    timeout: 60_000,
    maxBuffer: 256 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.stderr?.length) {
    throw new Error(`Task 2 installer native command failed: ${file} ${args.join(" ")}\n${result.stderr?.toString("utf8") ?? ""}`);
  }
  return Buffer.from(result.stdout ?? Buffer.alloc(0));
}

function bindExecutable(path, expected, label) {
  assertRootOwnedImmutablePath(path, label);
  const binding = readRegularFileBound(path, label);
  if (binding.size !== expected.size && expected.size !== undefined) throw new Error(`${label} size mismatch`);
  if (binding.sha256 !== expected.sha256) throw new Error(`${label} SHA-256 mismatch`);
  return binding;
}

function gitBytes(authority, args) {
  return runCaptured(authority.gitPath, [...GIT_PREFIX, "-C", authority.repositoryRoot, ...args], {
    cwd: authority.repositoryRoot,
  });
}

function gitLine(authority, args, label) {
  const value = gitBytes(authority, args).toString("utf8").trim();
  if (!value || value.includes("\n") || value.includes("\r")) throw new Error(`${label} must be one line`);
  return value;
}

function getAuthenticatedGitObject(authority, objectId, type, label) {
  if (!SHA1.test(objectId)) throw new Error(`${label} object ID is invalid`);
  if (gitLine(authority, ["cat-file", "-t", objectId], `${label} type`) !== type) {
    throw new Error(`${label} type mismatch`);
  }
  const sizeText = gitLine(authority, ["cat-file", "-s", objectId], `${label} size`);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(sizeText)) throw new Error(`${label} size is invalid`);
  const bytes = gitBytes(authority, ["cat-file", type, objectId]);
  if (bytes.length !== Number(sizeText) || gitObjectId(type, bytes) !== objectId) {
    throw new Error(`${label} raw Git object authentication failed`);
  }
  return Object.freeze({ objectId, type, size: bytes.length, sha256: sha256(bytes), bytes });
}

function commitTreeId(commit, label) {
  const text = commit.bytes.toString("utf8");
  const end = text.indexOf("\n\n");
  if (end < 0) throw new Error(`${label} is malformed`);
  const trees = text.slice(0, end).split("\n").filter((line) => /^tree [0-9a-f]{40}$/u.test(line));
  if (trees.length !== 1) throw new Error(`${label} must contain one tree`);
  return trees[0].slice(5);
}

function commitParentIds(commit, label) {
  const end = commit.bytes.indexOf(Buffer.from("\n\n", "ascii"));
  if (end < 0) throw new Error(`${label} is malformed`);
  const header = commit.bytes.subarray(0, end).toString("utf8");
  if (header.includes("\r") || header.includes("\0")) throw new Error(`${label} headers are malformed`);
  const parents = [];
  for (const line of header.split("\n")) {
    if (!line.startsWith("parent ")) continue;
    if (!/^parent [0-9a-f]{40}$/u.test(line)) throw new Error(`${label} parent header is malformed`);
    parents.push(line.slice(7));
  }
  return Object.freeze(parents);
}

function authenticateRawCommitAncestry(authority, expectedM, reviewedTree) {
  const pending = [reviewedTree];
  const visited = new Set();
  while (pending.length > 0) {
    const objectId = pending.shift();
    if (visited.has(objectId)) continue;
    visited.add(objectId);
    if (visited.size > 100_000) throw new Error("approved ancestry exceeds the authenticated commit bound");
    const commit = getAuthenticatedGitObject(authority, objectId, "commit", `approved ancestry commit ${objectId}`);
    commitTreeId(commit, `approved ancestry commit ${objectId}`);
    if (objectId === expectedM) return;
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
    if (space <= 0) throw new Error(`${label} tree entry is malformed`);
    const entry = Object.freeze({
      mode: header.slice(0, space),
      name: header.slice(space + 1),
      objectId: tree.bytes.subarray(nul + 1, nul + 21).toString("hex"),
    });
    if (entry.name === name) {
      if (match) throw new Error(`${label} tree has a duplicate segment`);
      match = entry;
    }
    offset = nul + 21;
  }
  if (!match) throw new Error(`${label} path segment is missing: ${name}`);
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
  const parts = repositoryPath.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    const entry = findTreeEntry(tree, parts[index], label);
    if (index < parts.length - 1) {
      if (entry.mode !== "40000") throw new Error(`${label} parent is not a tree`);
      tree = getAuthenticatedGitObject(authority, entry.objectId, "tree", `${label} parent tree`);
    } else {
      if (!["100644", "100755"].includes(entry.mode)) throw new Error(`${label} is not a regular blob`);
      return getAuthenticatedGitObject(authority, entry.objectId, "blob", label);
    }
  }
  throw new Error(`unable to authenticate ${label}`);
}

function authenticateLineage(authority, manifest) {
  getAuthenticatedGitObject(authority, manifest.expected_m, "commit", "approved M commit");
  getAuthenticatedGitObject(authority, manifest.reviewed_tree, "commit", "approved R commit");
  authenticateRawCommitAncestry(authority, manifest.expected_m, manifest.reviewed_tree);
  const result = spawnSync(
    authority.gitPath,
    [...GIT_PREFIX, "-C", authority.repositoryRoot, "merge-base", "--is-ancestor", manifest.expected_m, manifest.reviewed_tree],
    { cwd: authority.repositoryRoot, env: cleanEnvironment(), encoding: null, timeout: 60_000, shell: false, windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 || result.stdout?.length || result.stderr?.length) {
    throw new Error("approved M is not an ancestor of approved R");
  }
}

function authenticateManifestAuthorities(authority, manifest) {
  const authenticated = {};
  for (const key of AUTHORITY_KEYS) {
    const expected = manifest.authorities[key];
    const actual = getAuthenticatedReviewedBlob(authority, manifest.reviewed_tree, expected.repository_path, `approved ${key}`);
    if (actual.objectId !== expected.blob_oid || actual.size !== expected.size || actual.sha256 !== expected.sha256) {
      throw new Error(`approved ${key} does not match its raw-R binding`);
    }
    authenticated[key] = actual;
  }
  return Object.freeze(authenticated);
}

function sameBytes(binding, expected) {
  return (
    binding.size === expected.size &&
    binding.sha256 === expected.sha256 &&
    (!(expected.bytes instanceof Uint8Array) || binding.bytes.equals(expected.bytes))
  );
}

function ensureRootDirectory(path, mode, label) {
  if (!lstatExists(path)) {
    mkdirSync(path, { mode });
    chmodSync(path, mode);
  }
  assertRootOwnedImmutablePath(path, label);
  const item = lstatSync(path);
  if (!item.isDirectory() || item.isSymbolicLink()) throw new Error(`${label} must be a directory`);
}

function lstatExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_DIRECTORY ?? 0) | (FS_CONSTANTS.O_NOFOLLOW ?? 0));
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeImmutableFile(path, bytes) {
  const descriptor = openSync(
    path,
    FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL | (FS_CONSTANTS.O_NOFOLLOW ?? 0),
    0o400,
  );
  try {
    writeFileSync(descriptor, bytes);
    fchownSync(descriptor, 0, 0);
    fchmodSync(descriptor, 0o444);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function verifyInstalled(finalRoot, launcher, approval) {
  assertRootOwnedImmutablePath(finalRoot, "installed Task 2 directory");
  const rootItem = lstatSync(finalRoot);
  if (!rootItem.isDirectory() || rootItem.isSymbolicLink() || (rootItem.mode & 0o777) !== 0o555) {
    throw new Error("installed Task 2 directory mode is invalid");
  }
  const entries = readdirSync(finalRoot).sort();
  if (JSON.stringify(entries) !== JSON.stringify([APPROVAL_MANIFEST_FILE, "launch-reviewed-task2.mjs"])) {
    throw new Error("installed Task 2 directory contains an unexpected entry");
  }
  for (const [name, expected] of [["launch-reviewed-task2.mjs", launcher], [APPROVAL_MANIFEST_FILE, approval]]) {
    const path = join(finalRoot, name);
    assertRootOwnedImmutablePath(path, `installed ${name}`);
    const item = lstatSync(path);
    if ((item.mode & 0o777) !== 0o444 || item.nlink !== 1) throw new Error(`installed ${name} mode/link count is invalid`);
    const actual = readRegularFileBound(path, `installed ${name}`);
    if (!sameBytes(actual, expected)) throw new Error(`installed ${name} bytes do not match`);
  }
}

function removeCandidate(candidateRoot, reviewedTree) {
  const prefix = `.candidate-${reviewedTree}-`;
  if (dirname(candidateRoot) !== INSTALL_ROOT || !basename(candidateRoot).startsWith(prefix)) {
    throw new Error("refusing to remove an untrusted installer candidate");
  }
  const item = lstatSync(candidateRoot);
  if (!item.isDirectory() || item.isSymbolicLink()) throw new Error("installer candidate changed before cleanup");
  rmSync(candidateRoot, { recursive: true, force: false });
}

function assertRootInstallerIdentity() {
  if (
    process.platform === "win32" || typeof process.getuid !== "function" || typeof process.getgid !== "function" ||
    process.getuid() !== 0 || process.getgid() !== 0
  ) {
    throw new Error("Task 2 installer must run as root:root");
  }
}

export function installReviewedTask2(rawOptions) {
  assertRootInstallerIdentity();
  if (resolve(CURRENT_FILE) !== BOOTSTRAP_INSTALLER) throw new Error("Task 2 installer is not at its fixed bootstrap path");
  assertRootOwnedImmutablePath(CURRENT_FILE, "Task 2 bootstrap installer");
  if (resolve(process.execPath) !== PINNED_NODE.path) throw new Error("Task 2 installer is not running under pinned Node");
  const node = bindExecutable(process.execPath, PINNED_NODE, "Node authority");
  if (runCaptured(process.execPath, ["--version"]).toString("utf8").trim() !== PINNED_NODE.version) {
    throw new Error("Node semantic version mismatch");
  }
  const git = bindExecutable(PINNED_GIT.path, PINNED_GIT, "Git authority");
  if (runCaptured(PINNED_GIT.path, ["--version"]).toString("utf8").trim() !== PINNED_GIT.version) {
    throw new Error("Git semantic version mismatch");
  }
  const repositoryRoot = assertAbsolute(rawOptions.repositoryRoot, "repository root");
  if (realpathSync(repositoryRoot) !== repositoryRoot) throw new Error("repository root is not canonical");
  const repositoryItem = lstatSync(repositoryRoot);
  if (!repositoryItem.isDirectory() || repositoryItem.isSymbolicLink()) throw new Error("repository root is invalid");
  const approvalPath = assertAbsolute(rawOptions.approvalManifestPath, "approval manifest");
  assertRootOwnedImmutablePath(approvalPath, "approval manifest");
  const approval = readRegularFileBound(approvalPath, "approval manifest");
  const manifest = parseTask2ApprovalManifest(approval.bytes);
  const expectedApprovalPath = resolve(APPROVAL_ROOT, manifest.reviewed_tree, APPROVAL_MANIFEST_FILE);
  if (approvalPath !== expectedApprovalPath) throw new Error("approval manifest is not at its exact R-bound staging path");
  const authority = Object.freeze({ gitPath: PINNED_GIT.path, repositoryRoot });
  authenticateLineage(authority, manifest);
  const authorities = authenticateManifestAuthorities(authority, manifest);
  const currentInstaller = readRegularFileBound(CURRENT_FILE, "Task 2 bootstrap installer");
  if (!sameBytes(currentInstaller, authorities.installer) || !sameBytes(currentInstaller, manifest.authorities.installer)) {
    throw new Error("root bootstrap installer does not match the exact raw-R installer binding");
  }
  if (!sameBytes(authorities.launcher, manifest.authorities.launcher)) {
    throw new Error("exact raw-R launcher binding is invalid");
  }
  if (node.sha256 !== manifest.runtime.node.sha256 || git.sha256 !== manifest.runtime.git.sha256) {
    throw new Error("installer runtime authorities do not match the approval manifest");
  }

  ensureRootDirectory(INSTALL_ROOT, 0o755, "Task 2 install root");
  const finalRoot = resolve(INSTALL_ROOT, manifest.reviewed_tree);
  if (dirname(finalRoot) !== INSTALL_ROOT) throw new Error("reviewed install path escaped its root");
  if (lstatExists(finalRoot)) {
    verifyInstalled(finalRoot, authorities.launcher, approval);
    return Object.freeze({ reviewedTree: manifest.reviewed_tree, finalRoot, installed: false });
  }

  let candidateRoot;
  let primaryError;
  let cleanupError;
  try {
    candidateRoot = mkdtempSync(join(INSTALL_ROOT, `.candidate-${manifest.reviewed_tree}-`));
    chmodSync(candidateRoot, 0o700);
    writeImmutableFile(join(candidateRoot, "launch-reviewed-task2.mjs"), authorities.launcher.bytes);
    writeImmutableFile(join(candidateRoot, APPROVAL_MANIFEST_FILE), approval.bytes);
    chmodSync(candidateRoot, 0o555);
    fsyncDirectory(candidateRoot);
    verifyInstalled(candidateRoot, authorities.launcher, approval);
    renameSync(candidateRoot, finalRoot);
    candidateRoot = undefined;
    fsyncDirectory(INSTALL_ROOT);
    verifyInstalled(finalRoot, authorities.launcher, approval);
  } catch (error) {
    primaryError = error;
  } finally {
    if (candidateRoot && lstatExists(candidateRoot)) {
      try {
        removeCandidate(candidateRoot, manifest.reviewed_tree);
      } catch (error) {
        cleanupError = error;
      }
    }
  }
  if (primaryError) {
    if (cleanupError) process.stderr.write(`Task 2 installer cleanup also failed: ${cleanupError.message}\n`);
    throw primaryError;
  }
  if (cleanupError) throw cleanupError;
  return Object.freeze({ reviewedTree: manifest.reviewed_tree, finalRoot, installed: true });
}

function parseArgs(argv) {
  if (argv.length % 2 !== 0) throw new Error("Task 2 installer arguments must be option/value pairs");
  const allowed = new Set(["repository-root", "approval-manifest"]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!/^--[a-z0-9-]+$/u.test(option ?? "") || value === undefined || value.startsWith("--")) {
      throw new Error("Task 2 installer arguments are invalid");
    }
    const name = option.slice(2);
    if (!allowed.has(name)) throw new Error(`unknown Task 2 installer option: ${option}`);
    if (Object.hasOwn(values, name)) throw new Error(`duplicate Task 2 installer option: ${option}`);
    values[name] = value;
  }
  for (const name of allowed) if (!values[name]) throw new Error(`--${name} is required`);
  return Object.freeze(values);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  installReviewedTask2({
    repositoryRoot: options["repository-root"],
    approvalManifestPath: options["approval-manifest"],
  });
}

if (process.argv[1] && resolve(process.argv[1]) === CURRENT_FILE) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
