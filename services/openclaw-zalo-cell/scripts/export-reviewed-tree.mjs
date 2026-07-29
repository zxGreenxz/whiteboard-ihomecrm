import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as FS_CONSTANTS,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SHA1 = /^[0-9a-f]{40}$/;
const GIT_SHA256 = "5516c9f362c29376ab9a499a33082f9f611941d8c75930c880e30ad109e39c9a";
const GIT_VERSION = "2.53.0";
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function digest(algorithm, bytes) {
  return createHash(algorithm).update(bytes).digest("hex");
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
  environment.GIT_CONFIG_COUNT = "0";
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
    if (item.isSymbolicLink()) throw new Error(`${label} must not traverse symbolic links`);
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
    return { bytes, size: bytes.length, sha256: digest("sha256", bytes) };
  } finally {
    closeSync(descriptor);
  }
}

function gitBytes(gitPath, repositoryRoot, args, options = {}) {
  if (!isAbsolute(gitPath) || !isAbsolute(repositoryRoot)) {
    throw new Error("Git path and repository root must be absolute");
  }
  if (
    !Array.isArray(args) || args.length === 0 ||
    args.some((argument) => typeof argument !== "string" || argument.length === 0 || argument.includes("\0"))
  ) {
    throw new Error("Git command arguments are invalid");
  }
  const executableBefore = readRegularFileBound(gitPath, "Git executable");
  if (executableBefore.sha256 !== GIT_SHA256) throw new Error("Git executable SHA-256 mismatch");
  const result = spawnSync(gitPath, [
    "--no-replace-objects", "-c", "core.commitGraph=false", "-C", repositoryRoot, ...args,
  ], {
    encoding: null,
    env: trustedGitEnvironment(),
    input: options.input,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw new Error(`Git command failed: ${result.error.message}`);
  if (result.signal !== null) throw new Error(`Git command was terminated by signal: ${result.signal}`);
  const stderr = Buffer.from(result.stderr ?? []);
  if (stderr.length !== 0) {
    throw new Error(`Git command wrote stderr: ${stderr.toString("utf8").slice(0, 2048)}`);
  }
  if (result.status !== 0) throw new Error(`Git command failed (${result.status ?? -1})`);
  const executableAfter = readRegularFileBound(gitPath, "Git executable");
  if (
    executableAfter.size !== executableBefore.size ||
    executableAfter.sha256 !== executableBefore.sha256
  ) {
    throw new Error("Git executable changed during command execution");
  }
  const stdout = Buffer.from(result.stdout ?? []);
  return options.encoding === "utf8" ? stdout.toString("utf8") : stdout;
}

function gitSingleLine(output, label) {
  const match = /^([^\0\r\n]+)\r?\n$/u.exec(output);
  if (!match) throw new Error(`${label} output is invalid`);
  return match[1];
}

function readAuthenticatedGitObjects(gitPath, repositoryRoot, oids, expectedType) {
  if (!Array.isArray(oids) || oids.length === 0 || oids.some((oid) => !SHA1.test(oid))) {
    throw new Error("Git object authentication requires exact SHA-1 object IDs");
  }
  const uniqueOids = [...new Set(oids)];
  const output = gitBytes(gitPath, repositoryRoot, ["cat-file", "--batch"], {
    input: Buffer.from(`${uniqueOids.join("\n")}\n`, "ascii"),
    maxBuffer: 128 * 1024 * 1024,
  });
  const objects = new Map();
  let offset = 0;
  for (const requestedOid of uniqueOids) {
    const newline = output.indexOf(0x0a, offset);
    if (newline < 0) throw new Error(`truncated Git object header: ${requestedOid}`);
    const header = output.subarray(offset, newline).toString("ascii");
    const match = /^([0-9a-f]{40}) ([a-z]+) ([0-9]+)$/u.exec(header);
    if (!match || match[1] !== requestedOid) throw new Error(`Git object identity mismatch: ${requestedOid}`);
    const size = Number(match[3]);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`invalid Git object size: ${requestedOid}`);
    const start = newline + 1;
    const end = start + size;
    if (end >= output.length || output[end] !== 0x0a) {
      throw new Error(`truncated Git object bytes: ${requestedOid}`);
    }
    const type = match[2];
    if (expectedType !== undefined && type !== expectedType) {
      throw new Error(`Git object ${requestedOid} is not ${expectedType}`);
    }
    const bytes = Buffer.from(output.subarray(start, end));
    const calculatedOid = createHash("sha1")
      .update(Buffer.from(`${type} ${bytes.length}\0`, "ascii"))
      .update(bytes)
      .digest("hex");
    if (calculatedOid !== requestedOid) throw new Error(`Git object hash mismatch: ${requestedOid}`);
    objects.set(requestedOid, { oid: requestedOid, type, bytes });
    offset = end + 1;
  }
  if (offset !== output.length) throw new Error("git cat-file returned unexpected trailing bytes");
  return objects;
}

function authenticateReviewedCommitAndTrees(gitPath, repositoryRoot, reviewedTree) {
  const commitObject = readAuthenticatedGitObjects(
    gitPath,
    repositoryRoot,
    [reviewedTree],
    "commit",
  ).get(reviewedTree);
  const headerEnd = commitObject.bytes.indexOf(Buffer.from("\n\n", "ascii"));
  if (headerEnd < 0) throw new Error("reviewed commit header is malformed");
  const treeMatch = /^tree ([0-9a-f]{40})$/mu.exec(
    commitObject.bytes.subarray(0, headerEnd).toString("ascii"),
  );
  if (!treeMatch) throw new Error("reviewed commit tree header is malformed");
  const directoryOutput = gitBytes(
    gitPath,
    repositoryRoot,
    ["ls-tree", "-d", "-r", "-z", "--full-tree", `${reviewedTree}^{tree}`],
  );
  const treeOids = [treeMatch[1]];
  for (const record of directoryOutput.toString("utf8").split("\0")) {
    if (!record) continue;
    const match = /^040000 tree ([0-9a-f]{40})\t(.+)$/u.exec(record);
    if (!match) throw new Error("reviewed recursive tree listing is invalid");
    assertPortablePath(match[2]);
    treeOids.push(match[1]);
  }
  readAuthenticatedGitObjects(gitPath, repositoryRoot, treeOids, "tree");
}

function assertTrustedGitAuthority(gitPath, repositoryRoot) {
  if (!isAbsolute(gitPath) || !isAbsolute(repositoryRoot)) {
    throw new Error("Git authority paths must be absolute");
  }
  assertNoSymbolicLinkChain(repositoryRoot, "Git repository root");
  const repositoryInfo = lstatSync(repositoryRoot);
  if (!repositoryInfo.isDirectory() || repositoryInfo.isSymbolicLink()) {
    throw new Error("Git repository root must be a real directory");
  }
  const before = readRegularFileBound(gitPath, "Git executable");
  if (before.sha256 !== GIT_SHA256) throw new Error("Git executable SHA-256 mismatch");
  const versionResult = spawnSync(gitPath, ["--no-replace-objects", "--version"], {
    encoding: null,
    env: trustedGitEnvironment(),
    maxBuffer: 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (
    versionResult.error || versionResult.signal !== null || versionResult.status !== 0 ||
    Buffer.from(versionResult.stderr ?? []).length !== 0 ||
    gitSingleLine(Buffer.from(versionResult.stdout ?? []).toString("utf8"), "Git version") !==
      `git version ${GIT_VERSION}`
  ) {
    throw new Error("Git executable version mismatch");
  }
  const objectFormat = gitSingleLine(
    gitBytes(gitPath, repositoryRoot, ["rev-parse", "--show-object-format"], { encoding: "utf8" }),
    "Git object format",
  );
  if (objectFormat !== "sha1") throw new Error("Git repository object format must be sha1");
  const commonText = gitSingleLine(
    gitBytes(
      gitPath,
      repositoryRoot,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8" },
    ),
    "Git common-dir",
  );
  if (!isAbsolute(commonText)) throw new Error("Git common-dir must be absolute");
  const commonDir = resolve(commonText);
  assertNoSymbolicLinkChain(commonDir, "Git common directory");
  const commonInfo = lstatSync(commonDir);
  if (!commonInfo.isDirectory() || commonInfo.isSymbolicLink()) {
    throw new Error("Git common directory must be a real directory");
  }
  const replacements = gitBytes(gitPath, repositoryRoot, [
    "for-each-ref", "--format=%(refname)", "refs/replace",
  ]);
  if (replacements.length !== 0) throw new Error("Git refs/replace authority is forbidden");
  for (const relativePath of ["info/grafts", "objects/info/alternates", "objects/info/http-alternates"]) {
    const path = resolve(commonDir, ...relativePath.split("/"));
    if (!existsSync(path)) continue;
    assertNoSymbolicLinkChain(path, `Git ${relativePath}`);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== 0) {
      throw new Error(`Git ${relativePath} authority is forbidden`);
    }
  }
  const after = readRegularFileBound(gitPath, "Git executable");
  if (after.size !== before.size || after.sha256 !== before.sha256) {
    throw new Error("Git executable changed during authority verification");
  }
  return before.sha256;
}

function assertPortablePath(path) {
  if (
    !path ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path !== path.normalize("NFC") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`invalid reviewed Git path: ${path}`);
  }
}

export function parseLsTreeRecords(output) {
  const records = [];
  let offset = 0;
  while (offset < output.length) {
    const nul = output.indexOf(0, offset);
    if (nul < 0) throw new Error("git ls-tree output is not NUL terminated");
    const record = output.subarray(offset, nul);
    offset = nul + 1;
    if (record.length === 0) throw new Error("git ls-tree returned an empty record");
    const tab = record.indexOf(9);
    if (tab < 0) throw new Error("git ls-tree record has no path separator");
    const metadata = record.subarray(0, tab).toString("ascii").split(" ");
    if (metadata.length !== 3) throw new Error("git ls-tree metadata is malformed");
    const [mode, type, oid] = metadata;
    const path = UTF8.decode(record.subarray(tab + 1));
    assertPortablePath(path);
    if ((mode !== "100644" && mode !== "100755") || type !== "blob" || !SHA1.test(oid)) {
      throw new Error(`unsupported reviewed Git entry: ${mode} ${type} ${path}`);
    }
    records.push({ mode, type, oid, path });
  }
  records.sort((left, right) => compareUtf8(left.path, right.path));
  const collisionKeys = new Set();
  for (let index = 0; index < records.length; index += 1) {
    if (index > 0 && records[index - 1].path === records[index].path) {
      throw new Error(`duplicate reviewed Git path: ${records[index].path}`);
    }
    const collisionKey = records[index].path.toLowerCase();
    if (collisionKeys.has(collisionKey)) {
      throw new Error(`case-colliding reviewed Git path: ${records[index].path}`);
    }
    collisionKeys.add(collisionKey);
  }
  return records;
}

function readBatchBlobs(records, { gitPath, repositoryRoot }) {
  const request = Buffer.from(`${records.map(({ oid }) => oid).join("\n")}\n`, "ascii");
  const output = gitBytes(gitPath, repositoryRoot, ["cat-file", "--batch"], {
    input: request,
    encoding: "buffer",
    maxBuffer: 1024 * 1024 * 1024,
  });
  const blobs = new Map();
  let offset = 0;
  for (const record of records) {
    const newline = output.indexOf(10, offset);
    if (newline < 0) throw new Error("git cat-file batch header is truncated");
    const header = output.subarray(offset, newline).toString("ascii").split(" ");
    if (header.length !== 3) throw new Error(`git cat-file rejected ${record.oid}`);
    const [oid, type, sizeText] = header;
    const size = Number(sizeText);
    if (oid !== record.oid || type !== "blob" || !Number.isSafeInteger(size) || size < 0) {
      throw new Error(`git cat-file returned invalid metadata for ${record.path}`);
    }
    const start = newline + 1;
    const end = start + size;
    if (end >= output.length || output[end] !== 10) {
      throw new Error(`git cat-file blob is truncated for ${record.path}`);
    }
    const bytes = Buffer.from(output.subarray(start, end));
    const calculatedOid = createHash("sha1")
      .update(Buffer.from(`blob ${bytes.length}\0`, "ascii"))
      .update(bytes)
      .digest("hex");
    if (calculatedOid !== oid) throw new Error(`Git blob object mismatch for ${record.path}`);
    blobs.set(record.path, { bytes, size, oid });
    offset = end + 1;
  }
  if (offset !== output.length) throw new Error("git cat-file returned unexpected trailing bytes");
  return blobs;
}

function readReviewedTree(reviewedTree, { gitPath, repositoryRoot }) {
  if (!SHA1.test(reviewedTree)) throw new Error("reviewed tree must be an exact 40-hex commit");
  const objectType = gitSingleLine(
    gitBytes(gitPath, repositoryRoot, ["cat-file", "-t", `${reviewedTree}^{commit}`], { encoding: "utf8" }),
    "reviewed commit type",
  );
  if (objectType !== "commit") throw new Error("reviewed tree Git object is not a commit");
  const resolvedCommit = gitSingleLine(
    gitBytes(gitPath, repositoryRoot, ["rev-parse", "--verify", `${reviewedTree}^{commit}`], { encoding: "utf8" }),
    "reviewed commit resolution",
  );
  if (resolvedCommit !== reviewedTree) throw new Error("reviewed tree does not resolve to the exact commit");
  authenticateReviewedCommitAndTrees(gitPath, repositoryRoot, reviewedTree);
  const treeOutput = gitBytes(gitPath, repositoryRoot, ["ls-tree", "-rz", "--full-tree", `${reviewedTree}^{tree}`], {
    encoding: "buffer",
    maxBuffer: 128 * 1024 * 1024,
  });
  const records = parseLsTreeRecords(treeOutput);
  const blobs = readBatchBlobs(records, { gitPath, repositoryRoot });
  return records.map((record) => ({ ...record, ...blobs.get(record.path) }));
}

function manifestEntry(entry) {
  return {
    path: entry.path,
    type: "blob",
    mode: entry.mode,
    git_object_id: entry.oid,
    git_object_size: entry.size,
    content_size: entry.bytes.length,
    content_sha256: digest("sha256", entry.bytes),
  };
}

function assertAbsoluteLeaf(path, label) {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  const parent = dirname(path);
  const parentInfo = lstatSync(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new Error(`${label} parent must be a real directory`);
  }
}

function outputPath(root, portablePath) {
  const result = resolve(root, ...portablePath.split("/"));
  const rel = relative(root, result);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`reviewed output escaped root: ${portablePath}`);
  }
  return result;
}

function writeManifest(path, manifest) {
  assertAbsoluteLeaf(path, "manifest path");
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function exportReviewedTree({ gitPath, repositoryRoot, reviewedTree, outputRoot, manifestPath }) {
  if (!isAbsolute(outputRoot) || existsSync(outputRoot)) {
    throw new Error("output root must be an absent absolute path");
  }
  assertAbsoluteLeaf(manifestPath, "manifest path");
  const gitSha256 = assertTrustedGitAuthority(gitPath, repositoryRoot);
  const entries = readReviewedTree(reviewedTree, { gitPath, repositoryRoot });
  mkdirSync(outputRoot, { recursive: false });
  try {
    for (const entry of entries) {
      const destination = outputPath(outputRoot, entry.path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, entry.bytes, { flag: "wx" });
      chmodSync(destination, entry.mode === "100755" ? 0o755 : 0o644);
    }
    const manifest = {
      schema_version: 1,
      git_object_format: "sha1",
      reviewed_tree: reviewedTree,
      entries: entries.map(manifestEntry),
    };
    writeManifest(manifestPath, manifest);
    if (assertTrustedGitAuthority(gitPath, repositoryRoot) !== gitSha256) {
      throw new Error("Git executable changed during reviewed export");
    }
    return manifest;
  } catch (error) {
    rmSync(outputRoot, { recursive: true, force: true });
    throw error;
  }
}

function listOutputFiles(root) {
  const files = [];
  const visit = (directory, relativeDirectory) => {
    const names = readdirSync(directory);
    names.sort(compareUtf8);
    for (const name of names) {
      const absolute = resolve(directory, name);
      const path = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) throw new Error(`exported tree contains a link: ${path}`);
      if (info.isDirectory()) visit(absolute, path);
      else if (info.isFile()) files.push(path);
      else throw new Error(`exported tree contains unsupported entry: ${path}`);
    }
  };
  visit(root, "");
  return files.sort(compareUtf8);
}

export function verifyReviewedTree({ gitPath, repositoryRoot, reviewedTree, outputRoot, manifestPath }) {
  if (!isAbsolute(outputRoot) || !isAbsolute(manifestPath)) {
    throw new Error("verify paths must be absolute");
  }
  const gitSha256 = assertTrustedGitAuthority(gitPath, repositoryRoot);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entries = readReviewedTree(reviewedTree, { gitPath, repositoryRoot });
  const expectedManifest = {
    schema_version: 1,
    git_object_format: "sha1",
    reviewed_tree: reviewedTree,
    entries: entries.map(manifestEntry),
  };
  if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest)) {
    throw new Error("reviewed export manifest mismatch");
  }
  const actualPaths = listOutputFiles(outputRoot);
  const expectedPaths = entries.map(({ path }) => path);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error("reviewed export file set mismatch");
  }
  for (const entry of entries) {
    const path = outputPath(outputRoot, entry.path);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`reviewed export is not a regular file: ${entry.path}`);
    }
    const bytes = readFileSync(path);
    if (bytes.length !== entry.bytes.length || !bytes.equals(entry.bytes)) {
      throw new Error(`reviewed export content mismatch: ${entry.path}`);
    }
    if (digest("sha256", bytes) !== manifestEntry(entry).content_sha256) {
      throw new Error(`reviewed export hash mismatch: ${entry.path}`);
    }
  }
  if (assertTrustedGitAuthority(gitPath, repositoryRoot) !== gitSha256) {
    throw new Error("Git executable changed during reviewed export verification");
  }
  return expectedManifest;
}

function parseArgs(argv) {
  const command = argv[0];
  if (command !== "export" && command !== "verify") {
    throw new Error("first argument must be export or verify");
  }
  const values = {};
  const allowed = new Set(["git-path", "repository-root", "reviewed-tree", "output-root", "manifest"]);
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument: ${key}`);
    const name = key.slice(2);
    if (!allowed.has(name)) throw new Error(`unknown argument: ${key}`);
    if (Object.hasOwn(values, name)) throw new Error(`duplicate argument: ${key}`);
    values[name] = value;
  }
  if (!values["git-path"]) throw new Error("--git-path is required");
  for (const key of ["git-path", "repository-root", "reviewed-tree", "output-root", "manifest"]) {
    if (!values[key]) throw new Error(`--${key} is required`);
  }
  for (const key of ["git-path", "repository-root", "output-root", "manifest"]) {
    if (!isAbsolute(values[key])) throw new Error(`--${key} must be absolute`);
  }
  return {
    command,
    gitPath: resolve(values["git-path"]),
    repositoryRoot: resolve(values["repository-root"]),
    reviewedTree: values["reviewed-tree"],
    outputRoot: resolve(values["output-root"]),
    manifestPath: resolve(values.manifest),
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "export") exportReviewedTree(options);
  else verifyReviewedTree(options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
