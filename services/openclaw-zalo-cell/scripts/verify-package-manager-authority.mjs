import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants as FS_CONSTANTS,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const PINNED_NPM_AUTHORITY = Object.freeze({
  version: "11.12.1",
  entry_count: 2169,
  root_sha256: "aebb5b5b1892a7dd23c04af9b5afa24747f752beff2e4f2e781d9eb3830f93d9",
  cli_path: "bin/npm-cli.js",
  cli_size: 54,
  cli_sha256: "8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7",
});

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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
    return { bytes, sha256: sha256(bytes), size: bytes.length };
  } finally {
    closeSync(descriptor);
  }
}

function modeString(item) {
  return (item.mode & 0o7777).toString(8).padStart(4, "0");
}

function assertNotWritableByCurrentIdentity(item, absolutePath, label) {
  if (process.platform === "win32" || typeof process.getuid !== "function") return;
  const uid = process.getuid();
  if (uid === 0) throw new Error("package-manager authority must be verified by a non-root identity");
  const groups = new Set(typeof process.getgroups === "function" ? process.getgroups() : []);
  if (
    item.uid === uid ||
    (groups.has(item.gid) && (item.mode & 0o020) !== 0) ||
    (item.mode & 0o002) !== 0
  ) {
    throw new Error(`package-manager authority is owned or writable by the verifier identity: ${label}`);
  }
  try {
    accessSync(absolutePath, FS_CONSTANTS.W_OK);
  } catch (error) {
    if (error && typeof error === "object" && ["EACCES", "EPERM", "EROFS"].includes(error.code)) {
      return;
    }
    throw error;
  }
  throw new Error(`package-manager authority has effective write access: ${label}`);
}

function assertImmutableAncestorChain(path, label) {
  let cursor = resolve(path);
  while (true) {
    const item = lstatSync(cursor);
    if (item.isSymbolicLink()) throw new Error(`${label} must not traverse symbolic links`);
    assertNotWritableByCurrentIdentity(item, cursor, `${label} ${cursor}`);
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

function bindNodeDistribution(npmRoot, nodePath, requireImmutable) {
  if (nodePath === undefined) return undefined;
  if (!isAbsolute(nodePath)) throw new Error("Node authority path must be absolute");
  assertNoSymbolicLinkChain(nodePath, "Node authority path");
  const canonicalNodePath = realpathSync(nodePath);
  if (canonicalNodePath !== resolve(nodePath)) throw new Error("Node authority path is not canonical");
  const nodeItem = lstatSync(canonicalNodePath);
  if (!nodeItem.isFile() || nodeItem.isSymbolicLink()) {
    throw new Error("Node authority path must be a regular non-symlink file");
  }
  const distributionRoot = dirname(dirname(canonicalNodePath));
  const expectedNodePath = resolve(
    distributionRoot,
    "bin",
    process.platform === "win32" ? "node.exe" : "node",
  );
  if (canonicalNodePath !== expectedNodePath) {
    throw new Error("Node executable escaped the canonical official Node distribution root bin path");
  }
  const expectedNpmRoot = resolve(distributionRoot, "lib", "node_modules", "npm");
  if (resolve(npmRoot) !== expectedNpmRoot) {
    throw new Error("npm root and Node executable are not from the same official Node distribution root");
  }
  if (requireImmutable) {
    assertImmutableAncestorChain(distributionRoot, "Node distribution root");
    assertNotWritableByCurrentIdentity(nodeItem, canonicalNodePath, "Node executable");
  }
  return Object.freeze({ nodePath: canonicalNodePath, distributionRoot });
}

export async function computePackageManagerAuthority(
  npmRoot,
  { requireImmutable = false, nodePath } = {},
) {
  if (!isAbsolute(npmRoot)) throw new Error("package-manager authority root must be absolute");
  assertNoSymbolicLinkChain(npmRoot, "package-manager authority root");
  const canonicalRoot = realpathSync(npmRoot);
  if (canonicalRoot !== resolve(npmRoot)) throw new Error("package-manager authority root is not canonical");
  const rootItem = lstatSync(canonicalRoot);
  if (!rootItem.isDirectory() || rootItem.isSymbolicLink()) {
    throw new Error("package-manager authority root must be a real directory");
  }
  const nodeDistribution = bindNodeDistribution(canonicalRoot, nodePath, requireImmutable);
  if (requireImmutable) {
    assertNotWritableByCurrentIdentity(rootItem, canonicalRoot, ".");
  }

  const records = [];
  const walk = (directory, prefix = "") => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      const item = lstatSync(absolutePath);
      if (item.isSymbolicLink()) throw new Error(`package-manager authority contains a symlink: ${path}`);
      if (requireImmutable) assertNotWritableByCurrentIdentity(item, absolutePath, path);
      if (item.isDirectory()) {
        records.push({
          path,
          type: "directory",
          mode: modeString(item),
          size: 0,
          sha256: sha256(Buffer.alloc(0)),
        });
        walk(absolutePath, path);
      } else if (item.isFile()) {
        if (requireImmutable && item.nlink !== 1) {
          throw new Error(`package-manager authority contains a hardlinked file: ${path}`);
        }
        const file = readRegularFileBound(absolutePath, `package-manager authority ${path}`);
        records.push({
          path,
          type: "file",
          mode: modeString(item),
          size: file.size,
          sha256: file.sha256,
        });
      } else {
        throw new Error(`package-manager authority contains a special entry: ${path}`);
      }
    }
  };
  walk(canonicalRoot);
  records.sort((left, right) => compareUtf8(left.path, right.path));
  const aggregate = createHash("sha256").update(
    Buffer.from("ihome-openclaw-npm-authority-v1\0", "utf8"),
  );
  for (const record of records) {
    aggregate.update(Buffer.from(
      `${record.path}\0${record.type}\0${record.mode}\0${record.size}\0${record.sha256}\0`,
      "utf8",
    ));
  }
  const packageRecord = readRegularFileBound(join(canonicalRoot, "package.json"), "npm package.json");
  const metadata = JSON.parse(packageRecord.bytes.toString("utf8"));
  const cli = readRegularFileBound(join(canonicalRoot, "bin", "npm-cli.js"), "npm CLI");
  return Object.freeze({
    version: metadata.version,
    entry_count: records.length,
    root_sha256: aggregate.digest("hex"),
    cli_path: "bin/npm-cli.js",
    cli_size: cli.size,
    cli_sha256: cli.sha256,
    ...(nodeDistribution
      ? {
          node_path: nodeDistribution.nodePath,
          node_distribution_root: nodeDistribution.distributionRoot,
        }
      : {}),
  });
}

export async function assertPackageManagerAuthority(
  npmRoot,
  expected = PINNED_NPM_AUTHORITY,
  options = {},
) {
  const actual = await computePackageManagerAuthority(npmRoot, options);
  const keys = ["version", "entry_count", "root_sha256", "cli_path", "cli_size", "cli_sha256"];
  if (keys.some((key) => actual[key] !== expected[key])) {
    throw new Error("package-manager authority closure mismatch");
  }
  return actual;
}

function parseCli(argv) {
  if (argv.length !== 4) {
    throw new Error(
      "usage: verify-package-manager-authority.mjs --node-path <absolute-path> --npm-root <absolute-path>",
    );
  }
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!["--node-path", "--npm-root"].includes(key) || !isAbsolute(value ?? "")) {
      throw new Error("package-manager authority CLI arguments are invalid");
    }
    if (Object.hasOwn(args, key)) throw new Error(`duplicate package-manager authority option: ${key}`);
    args[key] = value;
  }
  if (!args["--node-path"] || !args["--npm-root"]) {
    throw new Error("both --node-path and --npm-root are required");
  }
  return { nodePath: args["--node-path"], npmRoot: args["--npm-root"] };
}

async function main() {
  const { nodePath, npmRoot } = parseCli(process.argv.slice(2));
  const result = await assertPackageManagerAuthority(npmRoot, PINNED_NPM_AUTHORITY, {
    requireImmutable: true,
    nodePath,
  });
  const cliPath = resolve(npmRoot, ...result.cli_path.split("/"));
  const rel = relative(npmRoot, cliPath);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("pinned npm CLI escaped its authenticated root");
  }
  process.stdout.write(`${JSON.stringify({ ...result, npm_root: npmRoot, npm_cli_path: cliPath })}\n`);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] === "-" || (process.argv[1] && resolve(process.argv[1]) === currentFile)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
