import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SHA1 = /^[0-9a-f]{40}$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function digest(algorithm, bytes) {
  return createHash(algorithm).update(bytes).digest("hex");
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

function readBatchBlobs(records) {
  const request = Buffer.from(`${records.map(({ oid }) => oid).join("\n")}\n`, "ascii");
  const output = execFileSync("git", ["cat-file", "--batch"], {
    input: request,
    encoding: "buffer",
    maxBuffer: 1024 * 1024 * 1024,
    windowsHide: true,
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

function readReviewedTree(reviewedTree) {
  if (!SHA1.test(reviewedTree)) throw new Error("reviewed tree must be an exact 40-hex commit");
  const treeOutput = execFileSync(
    "git",
    ["ls-tree", "-rz", "--full-tree", reviewedTree],
    { encoding: "buffer", maxBuffer: 128 * 1024 * 1024, windowsHide: true },
  );
  const records = parseLsTreeRecords(treeOutput);
  const blobs = readBatchBlobs(records);
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

export function exportReviewedTree({ reviewedTree, outputRoot, manifestPath }) {
  if (!isAbsolute(outputRoot) || existsSync(outputRoot)) {
    throw new Error("output root must be an absent absolute path");
  }
  assertAbsoluteLeaf(manifestPath, "manifest path");
  const entries = readReviewedTree(reviewedTree);
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

export function verifyReviewedTree({ reviewedTree, outputRoot, manifestPath }) {
  if (!isAbsolute(outputRoot) || !isAbsolute(manifestPath)) {
    throw new Error("verify paths must be absolute");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entries = readReviewedTree(reviewedTree);
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
  return expectedManifest;
}

function parseArgs(argv) {
  const command = argv[0];
  if (command !== "export" && command !== "verify") {
    throw new Error("first argument must be export or verify");
  }
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument: ${key}`);
    values[key.slice(2)] = value;
  }
  for (const key of ["reviewed-tree", "output-root", "manifest"]) {
    if (!values[key]) throw new Error(`--${key} is required`);
  }
  return {
    command,
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
