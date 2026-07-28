import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  open,
  readdir,
  readFile,
  realpath,
  utimes,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED_SOURCE_DATE_EPOCH = "1785062400";
export const DEFAULT_INSTALL_ROOT = "/home/node/.openclaw/npm/projects/zalouser";

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertContained(root, candidate) {
  const rel = relative(root, candidate);
  if (rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))) {
    return;
  }
  throw new Error(`install path escaped root: ${candidate}`);
}

async function walk(root, current, paths, collisionKeys) {
  const names = await readdir(current);
  names.sort(compareUtf8);
  for (const name of names) {
    if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      throw new Error(`invalid install entry name: ${name}`);
    }
    const absolute = resolve(current, name);
    assertContained(root, absolute);
    const relativePath = relative(root, absolute).split(sep).join("/");
    const collisionKey = relativePath.normalize("NFC").toLowerCase();
    if (collisionKeys.has(collisionKey)) {
      throw new Error(`case or Unicode-colliding install path: ${relativePath}`);
    }
    collisionKeys.add(collisionKey);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      throw new Error(`symbolic links are forbidden in installed tree: ${relativePath}`);
    }
    if (info.isDirectory()) {
      paths.push({ absolute, path: relativePath, type: "directory", executable: true });
      await walk(root, absolute, paths, collisionKeys);
      continue;
    }
    if (!info.isFile()) {
      throw new Error(`unsupported installed entry type: ${relativePath}`);
    }
    paths.push({
      absolute,
      path: relativePath,
      type: "file",
    });
  }
}

export async function normalizeInstallTree({
  root = DEFAULT_INSTALL_ROOT,
  sourceDateEpoch,
}) {
  if (String(sourceDateEpoch) !== EXPECTED_SOURCE_DATE_EPOCH) {
    throw new Error(`source date epoch must be ${EXPECTED_SOURCE_DATE_EPOCH}`);
  }
  const epoch = Number(sourceDateEpoch);
  const requestedRoot = resolve(root);
  const rootInfo = await lstat(requestedRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("install root must be a real directory");
  }
  const absoluteRoot = await realpath(requestedRoot);

  const paths = [];
  await walk(absoluteRoot, absoluteRoot, paths, new Set());
  const entries = [];

  for (const entry of paths.filter(({ type }) => type === "file")) {
    const bytes = await readFile(entry.absolute);
    const mode = "0644";
    await chmod(entry.absolute, 0o644);
    await utimes(entry.absolute, epoch, epoch);
    entries.push({
      path: entry.path,
      type: "file",
      mode,
      size: bytes.length,
      sha256: hashBytes(bytes),
    });
  }

  const directories = paths
    .filter(({ type }) => type === "directory")
    .sort((left, right) => right.path.split("/").length - left.path.split("/").length);
  for (const entry of directories) {
    await chmod(entry.absolute, 0o755);
    await utimes(entry.absolute, epoch, epoch);
    entries.push({
      path: entry.path,
      type: "directory",
      mode: "0755",
      size: 0,
      sha256: hashBytes(Buffer.alloc(0)),
    });
  }
  await chmod(absoluteRoot, 0o755);
  await utimes(absoluteRoot, epoch, epoch);

  entries.sort((left, right) => compareUtf8(left.path, right.path));
  const preimage = [Buffer.from("ihome-zalouser-installed-tree-v1\0", "utf8")];
  for (const entry of entries) {
    preimage.push(
      Buffer.from(
        `${entry.path}\0${entry.type}\0${entry.mode}\0${entry.size}\0${entry.sha256}\0`,
        "utf8",
      ),
    );
  }
  return {
    entries,
    fileCount: entries.filter(({ type }) => type === "file").length,
    directoryCount: entries.filter(({ type }) => type === "directory").length,
    sha256: hashBytes(Buffer.concat(preimage)),
  };
}

function parseArgs(argv) {
  let root = DEFAULT_INSTALL_ROOT;
  let sourceDateEpoch;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") {
      root = argv[++index];
    } else if (argument === "--source-date-epoch") {
      sourceDateEpoch = argv[++index];
    } else {
      throw new Error(`unsupported argument: ${argument}`);
    }
  }
  if (!root || !sourceDateEpoch) throw new Error("--source-date-epoch is required");
  return { root, sourceDateEpoch };
}

async function main() {
  const result = await normalizeInstallTree(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
