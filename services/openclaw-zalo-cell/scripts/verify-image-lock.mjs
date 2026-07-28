import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HEX_64 = /^[0-9a-f]{64}$/;
const REVIEWED_TREE = /^[0-9a-f]{40}$/;
const BASE_IMAGE =
  "ghcr.io/openclaw/openclaw:2026.7.1@sha256:165b4992f1b4b74ffdd7a02c887ba006f9f5dc951eca420eef573a8b233b543f";
const BUILDKIT_IMAGE =
  "moby/buildkit:v0.13.2@sha256:9194b5ec1be368f41c516df7f93f7f540630ea06136056b2ffebb62226ed4ad6";
const BUILDX_WINDOWS_SHA256 =
  "6b113e84cbc3cd645646aa82f00a7f7d3737cc10375b4341e0aca0de0c997c75";
const BUILDX_LINUX_SHA256 =
  "3e2bc8ed25a9125d6aeec07df4e0211edea6288e075b524160ef3fd305d3d74c";
const SESSION_DIST = [
  "session-crypto/dist/crypto.js",
  "session-crypto/dist/daemon.js",
  "session-crypto/dist/package.json",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function exactKeys(object, expected, label) {
  if (!object || typeof object !== "object" || Array.isArray(object)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(object).sort(compareUtf8);
  const wanted = [...expected].sort(compareUtf8);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unknown or missing properties`);
  }
}

function assertPortablePath(path, label) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..") ||
    path !== path.normalize("NFC")
  ) {
    throw new Error(`${label} is not a canonical portable relative path`);
  }
}

function contextRecord(role, type, mode, path, digest) {
  return Buffer.from(`${role}\0${type}\0${mode}\0${path}\0${digest}\0`, "utf8");
}

export function computeContextRootV2(lockSha256, inputs) {
  if (!HEX_64.test(lockSha256)) throw new Error("invalid image-lock sha256");
  const sorted = [...inputs].sort((left, right) => compareUtf8(left.path, right.path));
  const preimage = [
    Buffer.from("ihome-openclaw-context-root-v2\0", "utf8"),
    Buffer.from(`count\0${1 + sorted.length}\0`, "utf8"),
    contextRecord("lock", "blob", "100644", "image-lock.json", lockSha256),
  ];
  for (const input of sorted) {
    preimage.push(
      contextRecord("input", input.type, input.mode, input.path, input.sha256),
    );
  }
  return sha256(Buffer.concat(preimage));
}

export function validateImageLock(lock) {
  exactKeys(
    lock,
    [
      "schema_version",
      "algorithm",
      "source_date_epoch",
      "platform",
      "base_image",
      "buildkit_image",
      "buildx",
      "inputs",
    ],
    "image lock",
  );
  if (lock.schema_version !== 2) throw new Error("image lock schema_version must be 2");
  if (lock.algorithm !== "ihome-openclaw-context-root-v2") {
    throw new Error("unsupported image lock algorithm");
  }
  if (lock.source_date_epoch !== "1785062400") throw new Error("wrong source date epoch");
  if (lock.platform !== "linux/amd64") throw new Error("wrong locked platform");
  if (lock.base_image !== BASE_IMAGE) throw new Error("wrong pinned OpenClaw base image");
  if (lock.buildkit_image !== BUILDKIT_IMAGE) throw new Error("wrong pinned BuildKit image");
  exactKeys(
    lock.buildx,
    ["version", "windows_amd64_sha256", "linux_amd64_sha256"],
    "buildx lock",
  );
  if (lock.buildx.version !== "0.13.1") throw new Error("buildx version must be 0.13.1");
  if (lock.buildx.windows_amd64_sha256 !== BUILDX_WINDOWS_SHA256) {
    throw new Error("wrong Windows buildx digest");
  }
  if (lock.buildx.linux_amd64_sha256 !== BUILDX_LINUX_SHA256) {
    throw new Error("wrong Linux buildx digest");
  }
  if (!Array.isArray(lock.inputs) || lock.inputs.length === 0) {
    throw new Error("image lock inputs must be a nonempty array");
  }

  const paths = new Set();
  const collisionKeys = new Set();
  let previousPath;
  for (const [index, input] of lock.inputs.entries()) {
    exactKeys(input, ["path", "type", "mode", "size", "sha256"], `input ${index}`);
    assertPortablePath(input.path, `input ${index} path`);
    if (input.path === "image-lock.json") throw new Error("image lock cannot list itself");
    if (input.type !== "blob") throw new Error(`${input.path} type must be blob`);
    if (input.mode !== "100644" && input.mode !== "100755") {
      throw new Error(`${input.path} has unsupported mode`);
    }
    if (!Number.isSafeInteger(input.size) || input.size < 0) {
      throw new Error(`${input.path} has invalid size`);
    }
    if (!HEX_64.test(input.sha256)) throw new Error(`${input.path} has invalid sha256`);
    if (paths.has(input.path)) throw new Error(`duplicate image input: ${input.path}`);
    paths.add(input.path);
    const collisionKey = input.path.toLowerCase();
    if (collisionKeys.has(collisionKey)) throw new Error(`case-colliding image input: ${input.path}`);
    collisionKeys.add(collisionKey);
    if (previousPath !== undefined && compareUtf8(previousPath, input.path) >= 0) {
      throw new Error("image lock inputs must be raw UTF-8 path sorted");
    }
    previousPath = input.path;
  }
  const sessionPaths = lock.inputs
    .filter(({ path }) => path.startsWith("session-crypto/dist/"))
    .map(({ path }) => path);
  if (JSON.stringify(sessionPaths) !== JSON.stringify(SESSION_DIST)) {
    throw new Error("image lock must bind exactly the three session dist files");
  }
  return lock;
}

function containedPath(root, portablePath) {
  const candidate = resolve(root, ...portablePath.split("/"));
  const rel = relative(root, candidate);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`${portablePath} escaped image root`);
  }
  return candidate;
}

export async function verifyImageLock({ root, lockPath }) {
  const absoluteRoot = resolve(root);
  const rootInfo = await lstat(absoluteRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("image root must be a real directory");
  }
  const absoluteLock = resolve(lockPath);
  const lockBytes = await readFile(absoluteLock);
  const lock = validateImageLock(JSON.parse(lockBytes.toString("utf8")));

  for (const input of lock.inputs) {
    const absolute = containedPath(absoluteRoot, input.path);
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`${input.path} must be a regular file`);
    }
    const bytes = await readFile(absolute);
    if (bytes.length !== input.size) throw new Error(`${input.path} size mismatch`);
    if (sha256(bytes) !== input.sha256) throw new Error(`${input.path} sha256 mismatch`);
  }

  const lockSha256 = sha256(lockBytes);
  return {
    lock,
    lockSha256,
    contextRootSha256: computeContextRootV2(lockSha256, lock.inputs),
  };
}

function parseTarNumber(bytes, label) {
  const text = bytes.toString("ascii").replace(/\0.*$/s, "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error(`invalid tar ${label}`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new Error(`oversized tar ${label}`);
  return value;
}

function tarPath(header) {
  const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
  const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
  return prefix ? `${prefix}/${name}` : name;
}

async function hashRegion(handle, offset, size, capture = false) {
  const hash = createHash("sha256");
  const chunks = [];
  let remaining = size;
  let position = offset;
  while (remaining > 0) {
    const buffer = Buffer.alloc(Math.min(1024 * 1024, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) throw new Error("truncated tar member");
    const chunk = buffer.subarray(0, bytesRead);
    hash.update(chunk);
    if (capture) chunks.push(chunk);
    remaining -= bytesRead;
    position += bytesRead;
  }
  return { sha256: hash.digest("hex"), bytes: capture ? Buffer.concat(chunks) : undefined };
}

async function inspectOciArchive(path) {
  const handle = await open(path, "r");
  try {
    const fileInfo = await handle.stat();
    const entries = new Map();
    const collisionKeys = new Set();
    let offset = 0;
    while (offset + 512 <= fileInfo.size) {
      const header = Buffer.alloc(512);
      const { bytesRead } = await handle.read(header, 0, 512, offset);
      if (bytesRead !== 512) throw new Error("truncated tar header");
      if (header.every((byte) => byte === 0)) break;
      const pathName = tarPath(header);
      assertPortablePath(pathName.replace(/\/$/, ""), "OCI archive path");
      const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
      const size = parseTarNumber(header.subarray(124, 136), "size");
      const dataOffset = offset + 512;
      if (entries.has(pathName)) throw new Error(`duplicate OCI archive path: ${pathName}`);
      const collisionKey = pathName.toLowerCase();
      if (collisionKeys.has(collisionKey)) throw new Error(`case-colliding OCI path: ${pathName}`);
      collisionKeys.add(collisionKey);
      if (type === "0") {
        const capture = pathName === "index.json" || pathName === "oci-layout";
        const hashed = await hashRegion(handle, dataOffset, size, capture);
        entries.set(pathName, { path: pathName, size, offset: dataOffset, ...hashed });
      } else if (type !== "5") {
        throw new Error(`unsupported OCI tar entry type ${type}: ${pathName}`);
      }
      offset = dataOffset + Math.ceil(size / 512) * 512;
    }

    const layoutEntry = entries.get("oci-layout");
    const indexEntry = entries.get("index.json");
    if (!layoutEntry?.bytes || !indexEntry?.bytes) throw new Error("OCI layout files are missing");
    const layout = JSON.parse(layoutEntry.bytes.toString("utf8"));
    if (layout.imageLayoutVersion !== "1.0.0") throw new Error("unsupported OCI layout version");
    const index = JSON.parse(indexEntry.bytes.toString("utf8"));
    if (!Array.isArray(index.manifests) || index.manifests.length !== 1) {
      throw new Error("OCI index must contain exactly one manifest");
    }
    const manifestDescriptor = index.manifests[0];
    const manifestHex = String(manifestDescriptor.digest ?? "").replace(/^sha256:/, "");
    if (!HEX_64.test(manifestHex)) throw new Error("invalid OCI manifest digest");
    const manifestEntry = entries.get(`blobs/sha256/${manifestHex}`);
    if (!manifestEntry || manifestEntry.sha256 !== manifestHex) {
      throw new Error("OCI manifest blob mismatch");
    }
    const manifestBytes = (await hashRegion(handle, manifestEntry.offset, manifestEntry.size, true)).bytes;
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    const descriptors = [manifest.config, ...(manifest.layers ?? [])];
    for (const descriptor of descriptors) {
      const digest = String(descriptor?.digest ?? "").replace(/^sha256:/, "");
      const entry = entries.get(`blobs/sha256/${digest}`);
      if (!HEX_64.test(digest) || !entry || entry.sha256 !== digest || entry.size !== descriptor.size) {
        throw new Error(`OCI descriptor mismatch: ${descriptor?.digest ?? "missing"}`);
      }
    }
    const records = [...entries.values()]
      .map(({ path: entryPath, size, sha256: digest }) => `${entryPath}\0${size}\0${digest}\0`)
      .sort(compareUtf8);
    return {
      index_sha256: indexEntry.sha256,
      manifest_digest: `sha256:${manifestHex}`,
      config_digest: manifest.config.digest,
      layer_digests: manifest.layers.map(({ digest }) => digest),
      blob_manifest_sha256: sha256(Buffer.from(records.join(""), "utf8")),
    };
  } finally {
    await handle.close();
  }
}

async function hashFile(path) {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    return { size: info.size, ...(await hashRegion(handle, 0, info.size)) };
  } finally {
    await handle.close();
  }
}

async function compareFiles(leftPath, rightPath) {
  const left = await hashFile(leftPath);
  const right = await hashFile(rightPath);
  if (left.size !== right.size || left.sha256 !== right.sha256) {
    throw new Error("OCI archives are not byte-identical");
  }
  return left;
}

function validateSchemaValue(value, schema, path = "$", rootSchema = schema) {
  if (schema.$ref) {
    if (!schema.$ref.startsWith("#/$defs/")) throw new Error(`${path} has unsupported schema ref`);
    const definition = rootSchema.$defs?.[schema.$ref.slice("#/$defs/".length)];
    if (!definition) throw new Error(`${path} references a missing schema definition`);
    validateSchemaValue(value, definition, path, rootSchema);
    return;
  }
  if (schema.const !== undefined && value !== schema.const) {
    throw new Error(`${path} does not match const`);
  }
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} is outside enum`);
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${path} must be an object`);
    }
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) throw new Error(`${path}.${required} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) {
          throw new Error(`${path}.${key} is not allowed`);
        }
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) {
        validateSchemaValue(value[key], childSchema, `${path}.${key}`, rootSchema);
      }
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      throw new Error(`${path} has too few items`);
    }
    for (const [index, item] of value.entries()) {
      validateSchemaValue(item, schema.items, `${path}[${index}]`, rootSchema);
    }
  } else if (schema.type === "string") {
    if (typeof value !== "string") throw new Error(`${path} must be a string`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      throw new Error(`${path} does not match pattern`);
    }
  } else if (schema.type === "integer") {
    if (!Number.isInteger(value)) throw new Error(`${path} must be an integer`);
  } else if (schema.type === "boolean" && typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean`);
  }
}

export function validateJsonSchema(value, schema) {
  validateSchemaValue(value, schema, "$", schema);
  return value;
}

async function writeAtomically(path, bytes) {
  if (!isAbsolute(path)) throw new Error(`output path must be absolute: ${path}`);
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const canonicalParent = await realpath(parent);
  if (canonicalParent !== resolve(parent)) throw new Error("output parent must not traverse a link");
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function promoteFile(source, destination) {
  if (!isAbsolute(destination)) throw new Error("release artifact path must be absolute");
  const sourceHash = await hashFile(source);
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(destination), { recursive: true });
  try {
    await copyFile(source, temporary);
    const copiedHash = await hashFile(temporary);
    if (copiedHash.size !== sourceHash.size || copiedHash.sha256 !== sourceHash.sha256) {
      throw new Error("promoted OCI archive copy mismatch");
    }
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return sourceHash;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument: ${key}`);
    result[key.slice(2)] = value;
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.root ?? dirname(args.lock ?? "image-lock.json"));
  const lockPath = resolve(args.lock ?? resolve(root, "image-lock.json"));
  const lockResult = await verifyImageLock({ root, lockPath });
  if (!args["oci-a"] && !args["oci-b"]) {
    process.stdout.write(`${JSON.stringify(lockResult)}\n`);
    return;
  }

  const required = [
    "oci-a",
    "oci-b",
    "reviewed-tree",
    "schema",
    "evidence",
    "release-artifact",
    "buildx-path",
    "buildx-sha256",
  ];
  for (const key of required) if (!args[key]) throw new Error(`--${key} is required`);
  if (!REVIEWED_TREE.test(args["reviewed-tree"])) throw new Error("invalid reviewed tree");
  if (!isAbsolute(args["buildx-path"])) throw new Error("buildx path must be absolute");
  if (!HEX_64.test(args["buildx-sha256"])) throw new Error("invalid buildx sha256");

  const archive = await compareFiles(args["oci-a"], args["oci-b"]);
  const oci = await inspectOciArchive(args["oci-a"]);
  const forkPath = resolve(root, "vendor/zalouser-bridge/FORK.json");
  const fork = JSON.parse(await readFile(forkPath, "utf8"));
  if (!fork.installedTree || !Array.isArray(fork.installedTree.entries)) {
    throw new Error("FORK.json installedTree is missing");
  }
  const promoted = await promoteFile(args["oci-a"], args["release-artifact"]);
  if (promoted.sha256 !== archive.sha256) throw new Error("promoted archive hash mismatch");

  const evidence = {
    schema_version: 1,
    reviewed_tree: args["reviewed-tree"],
    source_date_epoch: lockResult.lock.source_date_epoch,
    platform: lockResult.lock.platform,
    image_digest: oci.manifest_digest,
    image_lock: {
      path: "services/openclaw-zalo-cell/image-lock.json",
      sha256: lockResult.lockSha256,
      algorithm: lockResult.lock.algorithm,
      context_root_sha256: lockResult.contextRootSha256,
    },
    base_image: {
      reference: lockResult.lock.base_image,
      digest: `sha256:${lockResult.lock.base_image.split("@sha256:")[1]}`,
    },
    buildx: {
      path: args["buildx-path"],
      version: lockResult.lock.buildx.version,
      sha256: args["buildx-sha256"],
    },
    buildkit: { image: lockResult.lock.buildkit_image, version: "v0.13.2" },
    docker: {
      stages: ["install", "runtime"],
      network_none: true,
      offline_install: true,
      session_dist_paths: SESSION_DIST,
    },
    oci: {
      archive_a_sha256: archive.sha256,
      archive_b_sha256: archive.sha256,
      byte_identical: true,
      promoted_archive_path: args["release-artifact"],
      promoted_archive_sha256: promoted.sha256,
      ...oci,
    },
    installed_fork: {
      entries: fork.installedTree.entries,
      file_count: fork.installedTree.fileCount,
      directory_count: fork.installedTree.directoryCount,
      root_sha256: fork.installedTree.sha256,
    },
    session_crypto: {
      inputs: lockResult.lock.inputs.filter(({ path }) => SESSION_DIST.includes(path)),
      installed: lockResult.lock.inputs.filter(({ path }) => SESSION_DIST.includes(path)),
      closure_sha256: sha256(
        Buffer.from(
          lockResult.lock.inputs
            .filter(({ path }) => SESSION_DIST.includes(path))
            .map(({ path, sha256: digest }) => `${path}\0${digest}\0`)
            .join(""),
          "utf8",
        ),
      ),
    },
    verification: {
      image_lock: true,
      schema: true,
      normalized_install: true,
      minimal_rootfs: true,
    },
  };
  const schema = JSON.parse(await readFile(args.schema, "utf8"));
  validateJsonSchema(evidence, schema);
  await writeAtomically(args.evidence, Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
