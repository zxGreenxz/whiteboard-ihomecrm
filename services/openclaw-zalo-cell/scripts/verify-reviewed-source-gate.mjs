import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as FS_CONSTANTS,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_LOCAL_CONFIG = /^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|symlinks)|remote\.[^.]+\.(?:url|fetch|mirror|promisor|partialclonefilter)|branch\.[^.]+\.(?:remote|merge|description)|user\.(?:name|email)|extensions\.objectformat)$/iu;

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertPortablePath(path, label) {
  if (
    typeof path !== "string" || path.length === 0 || path.includes("\0") ||
    path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/u.test(path) ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${label} is not a portable repository path`);
  }
  return path;
}

function trustedGitEnvironment(ambient = process.env) {
  const environment = {};
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP", "TMPDIR"]) {
    if (typeof ambient[key] === "string" && ambient[key]) environment[key] = ambient[key];
  }
  environment.HOME = process.platform === "win32" ? "C:\\Windows\\Temp" : "/nonexistent";
  environment.LANG = "C";
  environment.LC_ALL = "C";
  environment.GIT_ATTR_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_NO_LAZY_FETCH = "1";
  environment.GIT_NO_REPLACE_OBJECTS = "1";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}

function assertNoSymbolicLinkChain(path, label) {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  let cursor = resolve(path);
  while (true) {
    const item = lstatSync(cursor);
    if (item.isSymbolicLink()) throw new Error(`${label} must not traverse a symbolic link`);
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

function readRegularFileBound(path, label) {
  assertNoSymbolicLinkChain(path, label);
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  const descriptor = openSync(path, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`${label} changed before its nofollow handle was bound`);
    }
    const bytes = readFileSync(descriptor);
    const handleAfter = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(path, { bigint: true });
    if (
      !pathAfter.isFile() || pathAfter.isSymbolicLink() ||
      handleAfter.dev !== opened.dev || handleAfter.ino !== opened.ino ||
      pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino ||
      handleAfter.size !== opened.size || pathAfter.size !== opened.size ||
      handleAfter.mtimeNs !== opened.mtimeNs || handleAfter.ctimeNs !== opened.ctimeNs ||
      BigInt(bytes.length) !== opened.size
    ) {
      throw new Error(`${label} changed while its exact bytes were read`);
    }
    return { bytes, mode: Number(opened.mode & 0o7777n), size: bytes.length, sha256: sha256(bytes) };
  } finally {
    closeSync(descriptor);
  }
}

function gitBytes({ gitPath, repositoryRoot, expectedGitSha256 }, args, options = {}) {
  if (!isAbsolute(gitPath) || !isAbsolute(repositoryRoot)) {
    throw new Error("reviewed source gate Git paths must be absolute");
  }
  const before = readRegularFileBound(gitPath, "reviewed source gate Git executable");
  if (expectedGitSha256 !== undefined && before.sha256 !== expectedGitSha256) {
    throw new Error("reviewed source gate Git executable SHA-256 mismatch");
  }
  const result = spawnSync(
    gitPath,
    [
      "--no-replace-objects",
      "-c", "core.commitGraph=false",
      "-c", "core.fsmonitor=false",
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.attributesFile=/dev/null",
      "-c", "core.excludesFile=/dev/null",
      "-c", "diff.external=",
      "-c", "credential.helper=",
      "-C", repositoryRoot,
      ...args,
    ],
    {
      encoding: null,
      env: trustedGitEnvironment(),
      input: options.input,
      maxBuffer: options.maxBuffer ?? 128 * 1024 * 1024,
      shell: false,
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (result.signal !== null || result.status !== 0) {
    throw new Error(`reviewed source gate Git command failed (${result.status ?? -1})`);
  }
  const stderr = Buffer.from(result.stderr ?? []);
  if (stderr.length !== 0) {
    throw new Error(`reviewed source gate Git command wrote stderr: ${stderr.toString("utf8").slice(0, 1024)}`);
  }
  const after = readRegularFileBound(gitPath, "reviewed source gate Git executable");
  if (after.size !== before.size || after.sha256 !== before.sha256) {
    throw new Error("reviewed source gate Git executable changed during use");
  }
  return Buffer.from(result.stdout ?? []);
}

function nulRecords(bytes, label) {
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== 0) throw new Error(`${label} is not NUL terminated`);
  return bytes.subarray(0, -1).toString("utf8").split("\0");
}

function singleLine(bytes, label) {
  const match = /^([^\0\r\n]+)\r?\n$/u.exec(bytes.toString("utf8"));
  if (!match) throw new Error(`${label} output is invalid`);
  return match[1];
}

function repositoryPath(repositoryRoot, path) {
  const fullPath = resolve(repositoryRoot, ...path.split("/"));
  const rel = relative(repositoryRoot, fullPath);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("reviewed source gate path escaped repository root");
  }
  return fullPath;
}

function parseTree(bytes) {
  const records = new Map();
  for (const raw of nulRecords(bytes, "reviewed tree listing")) {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/u.exec(raw);
    if (!match) throw new Error("reviewed tree contains a non-regular or malformed entry");
    const path = assertPortablePath(match[3], "reviewed tree path");
    if (records.has(path)) throw new Error("reviewed tree contains a duplicate path");
    records.set(path, { mode: match[1], oid: match[2], path });
  }
  return records;
}

function parseIndex(bytes) {
  const records = new Map();
  for (const raw of nulRecords(bytes, "reviewed index listing")) {
    const match = /^([A-Za-z]) (100644|100755) ([0-9a-f]{40}) ([0-3])\t(.+)$/u.exec(raw);
    if (!match || match[1] !== "H" || match[4] !== "0") {
      throw new Error("reviewed source index has non-default index flags or is unmerged");
    }
    const path = assertPortablePath(match[5], "reviewed index path");
    if (records.has(path)) throw new Error("reviewed source index contains a duplicate path");
    records.set(path, { mode: match[2], oid: match[3], path });
  }
  return records;
}

function assertSameRecords(expected, actual, label) {
  const expectedPaths = [...expected.keys()].sort(compareUtf8);
  const actualPaths = [...actual.keys()].sort(compareUtf8);
  if (
    expectedPaths.length !== actualPaths.length ||
    expectedPaths.some((path, index) => path !== actualPaths[index])
  ) {
    throw new Error(`${label} path set mismatch`);
  }
  for (const path of expectedPaths) {
    const wanted = expected.get(path);
    const found = actual.get(path);
    if (wanted.mode !== found.mode || wanted.oid !== found.oid) {
      throw new Error(`${label} record mismatch: ${path}`);
    }
  }
}

function assertLocalGitPolicy(authority) {
  const commonDir = singleLine(
    gitBytes(authority, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    "absolute Git common directory",
  );
  if (!isAbsolute(commonDir)) throw new Error("absolute Git common directory is invalid");
  assertNoSymbolicLinkChain(commonDir, "Git common directory");
  const commonItem = lstatSync(commonDir);
  if (!commonItem.isDirectory() || commonItem.isSymbolicLink()) {
    throw new Error("Git common directory must be a real directory");
  }
  const localConfigPath = resolve(commonDir, "config");
  const localConfig = readRegularFileBound(localConfigPath, "local Git configuration file");
  const configNames = nulRecords(
    gitBytes(authority, ["config", "--local", "--no-includes", "--null", "--name-only", "--list"]),
    "local Git configuration",
  );
  for (const name of configNames) {
    if (!SAFE_LOCAL_CONFIG.test(name)) {
      throw new Error(`local Git configuration is executable or unreviewed: ${name}`);
    }
  }
  const scalarConfig = (name) => {
    const matching = configNames.filter((candidate) => candidate.toLowerCase() === name);
    if (matching.length === 0) return undefined;
    const values = nulRecords(
      gitBytes(authority, ["config", "--local", "--no-includes", "--null", "--get-all", name]),
      `local Git configuration value ${name}`,
    );
    if (values.length !== 1) throw new Error(`local Git configuration must be singular: ${name}`);
    return values[0].toLowerCase();
  };
  if (scalarConfig("core.repositoryformatversion") !== "0") {
    throw new Error("local Git repository format version must be exactly 0");
  }
  if (scalarConfig("core.bare") !== "false") {
    throw new Error("local Git repository must not be bare");
  }
  const objectFormat = scalarConfig("extensions.objectformat");
  if (objectFormat !== undefined && objectFormat !== "sha1") {
    throw new Error("local Git object format must be sha1");
  }
  const ignoreCase = scalarConfig("core.ignorecase");
  if (process.platform !== "win32" && ignoreCase !== undefined && ignoreCase !== "false") {
    throw new Error("local Git core.ignorecase must be false on the qualification filesystem");
  }
  const topLevel = singleLine(
    gitBytes(authority, ["rev-parse", "--path-format=absolute", "--show-toplevel"]),
    "Git top-level directory",
  );
  if (!isAbsolute(topLevel)) throw new Error("Git top-level directory is not absolute");
  const topLevelItem = lstatSync(realpathSync(topLevel), { bigint: true });
  const repositoryRootItem = lstatSync(realpathSync(authority.repositoryRoot), { bigint: true });
  if (
    !topLevelItem.isDirectory() || !repositoryRootItem.isDirectory() ||
    topLevelItem.dev !== repositoryRootItem.dev || topLevelItem.ino !== repositoryRootItem.ino
  ) {
    throw new Error("local Git worktree root disagrees with the reviewed source root");
  }
  const infoAttributes = singleLine(
    gitBytes(authority, [
      "rev-parse", "--path-format=absolute", "--git-path", "info/attributes",
    ]),
    "local Git info/attributes path",
  );
  if (
    !isAbsolute(infoAttributes) ||
    resolve(infoAttributes) !== resolve(commonDir, "info", "attributes")
  ) {
    throw new Error("local Git info/attributes path escaped the common Git directory");
  }
  try {
    const attributes = readRegularFileBound(infoAttributes, "local Git info/attributes");
    if (attributes.size !== 0) throw new Error("local Git info/attributes must be empty");
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
  }
  for (const statePath of ["MERGE_HEAD", "rebase-merge", "rebase-apply"]) {
    const resolvedState = singleLine(
      gitBytes(authority, ["rev-parse", "--path-format=absolute", "--git-path", statePath]),
      `Git state path ${statePath}`,
    );
    try {
      lstatSync(isAbsolute(resolvedState) ? resolvedState : resolve(authority.repositoryRoot, resolvedState));
      throw new Error("merge/rebase is in progress");
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
    }
  }
  return { localConfig, localConfigPath };
}

export async function verifyReviewedSourceGate({
  gitPath,
  repositoryRoot,
  reviewedTree,
  expectedGitSha256,
  allowedUntrackedPaths = [],
}) {
  if (!isAbsolute(gitPath) || !isAbsolute(repositoryRoot)) {
    throw new Error("reviewed source gate requires absolute Git and repository paths");
  }
  if (!SHA1.test(reviewedTree ?? "")) throw new Error("reviewed source gate commit is invalid");
  if (expectedGitSha256 !== undefined && !SHA256.test(expectedGitSha256)) {
    throw new Error("reviewed source gate expected Git SHA-256 is invalid");
  }
  assertNoSymbolicLinkChain(repositoryRoot, "reviewed source repository root");
  const repositoryItem = lstatSync(repositoryRoot);
  if (!repositoryItem.isDirectory() || repositoryItem.isSymbolicLink()) {
    throw new Error("reviewed source repository root must be a real directory");
  }
  const authority = { gitPath, repositoryRoot, expectedGitSha256 };
  const localPolicy = assertLocalGitPolicy(authority);
  const head = singleLine(gitBytes(authority, ["rev-parse", "HEAD"]), "source HEAD");
  if (head !== reviewedTree) throw new Error("source HEAD is not exact reviewed tree");
  const tree = parseTree(gitBytes(authority, ["ls-tree", "-r", "-z", "--full-tree", reviewedTree]));
  const index = parseIndex(gitBytes(authority, ["ls-files", "--stage", "-v", "-z"]));
  assertSameRecords(tree, index, "reviewed source index");

  const allowed = [...new Set(allowedUntrackedPaths.map((path) => assertPortablePath(path, "allowed untracked path")))]
    .sort(compareUtf8);
  const untracked = nulRecords(gitBytes(authority, ["ls-files", "--others", "-z"]), "untracked listing")
    .map((path) => assertPortablePath(path, "untracked path"))
    .sort(compareUtf8);
  const unexpected = untracked.filter((path) => !allowed.includes(path));
  if (unexpected.length !== 0) {
    throw new Error(`reviewed source has untracked paths: ${unexpected.join(",")}`);
  }
  for (const path of untracked) {
    if (!allowed.includes(path)) continue;
    const fullPath = repositoryPath(repositoryRoot, path);
    assertNoSymbolicLinkChain(fullPath, `allowed untracked output ${path}`);
    const item = lstatSync(fullPath);
    if (!item.isFile() || item.isSymbolicLink()) {
      throw new Error(`allowed untracked output must be a regular non-symlink file: ${path}`);
    }
  }

  for (const record of tree.values()) {
    const bound = readRegularFileBound(repositoryPath(repositoryRoot, record.path), `tracked worktree ${record.path}`);
    const oid = createHash("sha1")
      .update(Buffer.from(`blob ${bound.bytes.length}\0`, "ascii"))
      .update(bound.bytes)
      .digest("hex");
    if (oid !== record.oid) throw new Error(`tracked worktree blob mismatch: ${record.path}`);
    if (process.platform !== "win32") {
      const executable = (bound.mode & 0o111) !== 0;
      if (executable !== (record.mode === "100755")) {
        throw new Error(`tracked worktree executable mode mismatch: ${record.path}`);
      }
    }
  }

  const localConfigAfter = readRegularFileBound(
    localPolicy.localConfigPath,
    "local Git configuration file",
  );
  if (
    localConfigAfter.size !== localPolicy.localConfig.size ||
    localConfigAfter.mode !== localPolicy.localConfig.mode ||
    localConfigAfter.sha256 !== localPolicy.localConfig.sha256
  ) {
    throw new Error("local Git configuration changed while the source gate was running");
  }

  return Object.freeze({
    reviewed_tree: reviewedTree,
    tracked_file_count: tree.size,
    untracked_file_count: untracked.length,
    allowed_untracked_paths: Object.freeze(allowed),
  });
}

function parseCli(argv) {
  const args = {};
  const allowedUntrackedPaths = [];
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!/^--[a-z0-9-]+$/u.test(key ?? "") || value === undefined || value.startsWith("--")) {
      throw new Error("reviewed source gate arguments are invalid");
    }
    const name = key.slice(2);
    if (name === "allow-untracked") {
      allowedUntrackedPaths.push(value);
      continue;
    }
    if (Object.hasOwn(args, name)) throw new Error(`duplicate reviewed source gate option: ${key}`);
    args[name] = value;
  }
  const allowed = new Set([
    "git-path",
    "repository-root",
    "reviewed-tree",
    "git-sha256",
  ]);
  for (const key of Object.keys(args)) if (!allowed.has(key)) throw new Error(`unknown option: --${key}`);
  for (const key of ["git-path", "repository-root", "reviewed-tree", "git-sha256"]) {
    if (!args[key]) throw new Error(`--${key} is required`);
  }
  return { ...args, allowedUntrackedPaths };
}

async function main() {
  const args = parseCli(process.argv.slice(2));
  const result = await verifyReviewedSourceGate({
    gitPath: resolve(args["git-path"]),
    repositoryRoot: resolve(args["repository-root"]),
    reviewedTree: args["reviewed-tree"],
    expectedGitSha256: args["git-sha256"],
    allowedUntrackedPaths: args.allowedUntrackedPaths,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] === "-" || (process.argv[1] && resolve(process.argv[1]) === currentFile)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
