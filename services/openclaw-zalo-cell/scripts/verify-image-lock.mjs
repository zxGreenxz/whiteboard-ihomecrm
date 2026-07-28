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

function parseJsonStrict(bytes, label) {
  const text = Buffer.from(bytes).toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) throw new Error(`${label} contains a BOM`);
  let offset = 0;
  const skipWhitespace = () => {
    while (offset < text.length && /[\u0009\u000a\u000d\u0020]/.test(text[offset])) offset += 1;
  };
  const parseString = () => {
    const start = offset;
    if (text[offset] !== '"') throw new Error(`${label} contains an invalid JSON string`);
    offset += 1;
    while (offset < text.length) {
      const code = text.charCodeAt(offset);
      if (code === 0x22) {
        offset += 1;
        return JSON.parse(text.slice(start, offset));
      }
      if (code === 0x5c) {
        offset += 1;
        if (offset >= text.length) throw new Error(`${label} contains an unterminated JSON escape`);
        const escape = text[offset];
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(offset + 1, offset + 5))) {
            throw new Error(`${label} contains an invalid Unicode escape`);
          }
          offset += 5;
        } else if ('"\\/bfnrt'.includes(escape)) {
          offset += 1;
        } else {
          throw new Error(`${label} contains an invalid JSON escape`);
        }
        continue;
      }
      if (code < 0x20) throw new Error(`${label} contains a control character in a JSON string`);
      offset += 1;
    }
    throw new Error(`${label} contains an unterminated JSON string`);
  };
  const parseValue = () => {
    skipWhitespace();
    const token = text[offset];
    if (token === '"') return parseString();
    if (token === "{") {
      offset += 1;
      skipWhitespace();
      const keys = new Set();
      if (text[offset] === "}") {
        offset += 1;
        return;
      }
      while (offset < text.length) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) throw new Error(`${label} contains a duplicate JSON key: ${key}`);
        keys.add(key);
        skipWhitespace();
        if (text[offset] !== ":") throw new Error(`${label} contains a malformed JSON object`);
        offset += 1;
        parseValue();
        skipWhitespace();
        if (text[offset] === "}") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") throw new Error(`${label} contains a malformed JSON object`);
        offset += 1;
      }
      throw new Error(`${label} contains an unterminated JSON object`);
    }
    if (token === "[") {
      offset += 1;
      skipWhitespace();
      if (text[offset] === "]") {
        offset += 1;
        return;
      }
      while (offset < text.length) {
        parseValue();
        skipWhitespace();
        if (text[offset] === "]") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") throw new Error(`${label} contains a malformed JSON array`);
        offset += 1;
      }
      throw new Error(`${label} contains an unterminated JSON array`);
    }
    const start = offset;
    while (offset < text.length && !/[\u0009\u000a\u000d\u0020,\]}]/.test(text[offset])) offset += 1;
    if (start === offset) throw new Error(`${label} contains an invalid JSON value`);
    const value = JSON.parse(text.slice(start, offset));
    if (typeof value === "number" && (!Number.isFinite(value) || !Number.isSafeInteger(value))) {
      throw new Error(`${label} contains a non-I-JSON number`);
    }
    return value;
  };
  parseValue();
  skipWhitespace();
  if (offset !== text.length) throw new Error(`${label} contains trailing bytes`);
  return JSON.parse(text);
}

function assertReviewIdentity(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function reviewEvidenceFromBytes(bytes, expected) {
  if (!expected || !["M", "R"].includes(expected.checkpoint)) {
    throw new Error("expected review checkpoint must be M or R");
  }
  if (!REVIEWED_TREE.test(expected.reviewedSha)) throw new Error("expected reviewed SHA is invalid");
  const report = parseJsonStrict(bytes, `${expected.checkpoint} review report`);
  const keys = [
    "checkpoint",
    "decision",
    "findings",
    "reviewedSha",
    "reviewerIdentity",
    "reviewerRole",
    "reviewerRunId",
    "schema",
  ];
  exactKeys(report, keys, `${expected.checkpoint} review report`);
  if (report.schema !== 1) throw new Error("review report schema must be 1");
  if (report.checkpoint !== expected.checkpoint) throw new Error("review report checkpoint mismatch");
  if (report.reviewedSha !== expected.reviewedSha) throw new Error("review report SHA mismatch");
  if (report.reviewerRole !== "reviewer") throw new Error("review report role must be reviewer");
  if (report.decision !== "APPROVED") throw new Error("review report decision must be APPROVED");
  if (!Array.isArray(report.findings) || report.findings.length !== 0) {
    throw new Error("review report findings must be empty");
  }
  assertReviewIdentity(report.reviewerIdentity, "reviewer identity");
  assertReviewIdentity(report.reviewerRunId, "reviewer run ID");
  const canonical = Buffer.from(`${JSON.stringify(report)}\n`, "utf8");
  if (!bytes.equals(canonical)) throw new Error("review report bytes are not canonical");
  return {
    checkpoint: report.checkpoint,
    report_base64: bytes.toString("base64"),
    report_size: bytes.length,
    report_sha256: sha256(bytes),
    reviewed_sha: report.reviewedSha,
    reviewer_role: report.reviewerRole,
    reviewer_identity: report.reviewerIdentity,
    reviewer_run_id: report.reviewerRunId,
    decision: report.decision,
    findings: report.findings,
  };
}

export function validateEmbeddedReviewRecord(record, expected) {
  const keys = [
    "checkpoint",
    "report_base64",
    "report_size",
    "report_sha256",
    "reviewed_sha",
    "reviewer_role",
    "reviewer_identity",
    "reviewer_run_id",
    "decision",
    "findings",
  ];
  exactKeys(record, keys, `${expected.checkpoint} embedded review`);
  if (typeof record.report_base64 !== "string" || record.report_base64.length === 0) {
    throw new Error("embedded review base64 is invalid");
  }
  const bytes = Buffer.from(record.report_base64, "base64");
  if (bytes.toString("base64") !== record.report_base64) {
    throw new Error("embedded review base64 is not canonical");
  }
  const computed = reviewEvidenceFromBytes(bytes, expected);
  for (const key of keys) {
    if (JSON.stringify(record[key]) !== JSON.stringify(computed[key])) {
      throw new Error(`${expected.checkpoint} embedded review ${key} mismatch`);
    }
  }
  return computed;
}

export async function readCanonicalReviewReport(reportPath, expected) {
  if (!isAbsolute(reportPath)) throw new Error("review report path must be absolute");
  const item = await lstat(reportPath);
  if (!item.isFile() || item.isSymbolicLink()) {
    throw new Error("review report must be a regular non-symlink file");
  }
  return reviewEvidenceFromBytes(await readFile(reportPath), expected);
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
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      throw new Error(`${path} must contain at most ${schema.maxItems} items`);
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

function assertJsonEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} mismatch`);
  }
}

export async function verifyEvidenceFile({
  root,
  lockPath,
  evidencePath,
  schemaPath,
  reviewedTree,
  releaseArtifactPath,
}) {
  if (!REVIEWED_TREE.test(reviewedTree)) throw new Error("invalid reviewed tree");
  if (!isAbsolute(releaseArtifactPath)) throw new Error("release artifact path must be absolute");
  const evidenceItem = await lstat(evidencePath);
  const schemaItem = await lstat(schemaPath);
  const archiveItem = await lstat(releaseArtifactPath);
  for (const [item, label] of [
    [evidenceItem, "evidence"],
    [schemaItem, "evidence schema"],
    [archiveItem, "release artifact"],
  ]) {
    if (!item.isFile() || item.isSymbolicLink()) {
      throw new Error(`${label} must be a regular non-symlink file`);
    }
  }

  const evidenceBytes = await readFile(evidencePath);
  const evidence = parseJsonStrict(evidenceBytes, "build evidence");
  const canonicalEvidence = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  if (!evidenceBytes.equals(canonicalEvidence)) throw new Error("build evidence bytes are not canonical");
  const schema = parseJsonStrict(await readFile(schemaPath), "build evidence schema");
  validateJsonSchema(evidence, schema);
  if (evidence.reviewed_tree !== reviewedTree) throw new Error("build evidence reviewed tree mismatch");
  exactKeys(evidence.reviews, ["M", "R"], "build evidence reviews");
  validateEmbeddedReviewRecord(evidence.reviews.M, {
    checkpoint: "M",
    reviewedSha: evidence.reviews.M.reviewed_sha,
  });
  validateEmbeddedReviewRecord(evidence.reviews.R, {
    checkpoint: "R",
    reviewedSha: reviewedTree,
  });
  if (evidence.reviews.M.reviewed_sha === reviewedTree) {
    throw new Error("embedded M and R reviewed SHAs must be distinct");
  }

  const lockResult = await verifyImageLock({ root, lockPath });
  if (evidence.image_lock.sha256 !== lockResult.lockSha256) {
    throw new Error("build evidence image lock hash mismatch");
  }
  if (evidence.image_lock.algorithm !== lockResult.lock.algorithm) {
    throw new Error("build evidence context algorithm mismatch");
  }
  if (evidence.image_lock.context_root_sha256 !== lockResult.contextRootSha256) {
    throw new Error("build evidence context root mismatch");
  }
  if (evidence.source_date_epoch !== lockResult.lock.source_date_epoch) {
    throw new Error("build evidence source epoch mismatch");
  }
  if (evidence.platform !== lockResult.lock.platform) {
    throw new Error("build evidence platform mismatch");
  }
  if (evidence.base_image.reference !== lockResult.lock.base_image) {
    throw new Error("build evidence base image mismatch");
  }
  if (evidence.buildkit.image !== lockResult.lock.buildkit_image) {
    throw new Error("build evidence BuildKit image mismatch");
  }
  if (
    evidence.buildx.version !== lockResult.lock.buildx.version ||
    ![
      lockResult.lock.buildx.windows_amd64_sha256,
      lockResult.lock.buildx.linux_amd64_sha256,
    ].includes(evidence.buildx.sha256)
  ) {
    throw new Error("build evidence buildx lock mismatch");
  }
  if (!isAbsolute(evidence.buildx.path)) throw new Error("build evidence buildx path must be absolute");
  const buildxItem = await lstat(evidence.buildx.path);
  if (!buildxItem.isFile() || buildxItem.isSymbolicLink()) {
    throw new Error("build evidence buildx path must be a regular non-symlink file");
  }
  if ((await hashFile(evidence.buildx.path)).sha256 !== evidence.buildx.sha256) {
    throw new Error("build evidence buildx binary hash mismatch");
  }

  if (!isAbsolute(evidence.oci.promoted_archive_path)) {
    throw new Error("build evidence promoted archive path must be absolute");
  }
  const canonicalArchive = resolve(releaseArtifactPath);
  if (resolve(evidence.oci.promoted_archive_path) !== canonicalArchive) {
    throw new Error("build evidence promoted archive path mismatch");
  }
  const archiveHash = await hashFile(canonicalArchive);
  for (const [field, value] of [
    ["archive_a_sha256", evidence.oci.archive_a_sha256],
    ["archive_b_sha256", evidence.oci.archive_b_sha256],
    ["promoted_archive_sha256", evidence.oci.promoted_archive_sha256],
  ]) {
    if (value !== archiveHash.sha256) throw new Error(`build evidence ${field} mismatch`);
  }
  const inspectedOci = await inspectOciArchive(canonicalArchive);
  for (const key of [
    "index_sha256",
    "manifest_digest",
    "config_digest",
    "layer_digests",
    "blob_manifest_sha256",
  ]) {
    assertJsonEqual(evidence.oci[key], inspectedOci[key], `build evidence OCI ${key}`);
  }
  if (evidence.image_digest !== inspectedOci.manifest_digest) {
    throw new Error("build evidence image digest mismatch");
  }

  const fork = parseJsonStrict(
    await readFile(resolve(root, "vendor/zalouser-bridge/FORK.json")),
    "FORK.json",
  );
  assertJsonEqual(evidence.installed_fork.entries, fork.installedTree.entries, "installed fork entries");
  if (
    evidence.installed_fork.file_count !== fork.installedTree.fileCount ||
    evidence.installed_fork.directory_count !== fork.installedTree.directoryCount ||
    evidence.installed_fork.root_sha256 !== fork.installedTree.sha256
  ) {
    throw new Error("installed fork summary mismatch");
  }
  const expectedSession = lockResult.lock.inputs.filter(({ path }) => SESSION_DIST.includes(path));
  assertJsonEqual(evidence.session_crypto.inputs, expectedSession, "session crypto inputs");
  assertJsonEqual(evidence.session_crypto.installed, expectedSession, "session crypto installed files");
  const expectedClosure = sha256(
    Buffer.from(
      expectedSession.map(({ path, sha256: digest }) => `${path}\0${digest}\0`).join(""),
      "utf8",
    ),
  );
  if (evidence.session_crypto.closure_sha256 !== expectedClosure) {
    throw new Error("session crypto closure mismatch");
  }
  return { evidence_sha256: sha256(evidenceBytes), archive_sha256: archiveHash.sha256 };
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

async function readReviewsFromArgs(args) {
  const required = [
    "m-reviewed-tree",
    "reviewed-tree",
    "m-review-report",
    "r-review-report",
  ];
  const present = required.filter((key) => args[key]);
  if (present.length === 0) return undefined;
  for (const key of required) if (!args[key]) throw new Error(`--${key} is required`);
  if (!REVIEWED_TREE.test(args["m-reviewed-tree"])) throw new Error("invalid M reviewed tree");
  if (!REVIEWED_TREE.test(args["reviewed-tree"])) throw new Error("invalid reviewed tree");
  if (args["m-reviewed-tree"] === args["reviewed-tree"]) {
    throw new Error("M and R reviewed trees must be distinct");
  }
  return {
    M: await readCanonicalReviewReport(args["m-review-report"], {
      checkpoint: "M",
      reviewedSha: args["m-reviewed-tree"],
    }),
    R: await readCanonicalReviewReport(args["r-review-report"], {
      checkpoint: "R",
      reviewedSha: args["reviewed-tree"],
    }),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scriptCellRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const root = resolve(args.root ?? (args.lock ? dirname(args.lock) : scriptCellRoot));
  const lockPath = resolve(args.lock ?? resolve(root, "image-lock.json"));
  if (!args["oci-a"] && !args["oci-b"] && args.evidence) {
    for (const key of ["schema", "reviewed-tree", "release-artifact"]) {
      if (!args[key]) throw new Error(`--${key} is required with --evidence`);
    }
    const result = await verifyEvidenceFile({
      root,
      lockPath,
      evidencePath: resolve(args.evidence),
      schemaPath: resolve(args.schema),
      reviewedTree: args["reviewed-tree"],
      releaseArtifactPath: args["release-artifact"],
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const lockResult = await verifyImageLock({ root, lockPath });
  const reviews = await readReviewsFromArgs(args);
  if (!args["oci-a"] && !args["oci-b"]) {
    process.stdout.write(`${JSON.stringify({ ...lockResult, ...(reviews ? { reviews } : {}) })}\n`);
    return;
  }

  const required = [
    "oci-a",
    "oci-b",
    "m-reviewed-tree",
    "reviewed-tree",
    "m-review-report",
    "r-review-report",
    "schema",
    "evidence",
    "release-artifact",
    "buildx-path",
    "buildx-sha256",
  ];
  for (const key of required) if (!args[key]) throw new Error(`--${key} is required`);
  if (!reviews) throw new Error("canonical M/R review reports are required");
  if (!REVIEWED_TREE.test(args["m-reviewed-tree"])) throw new Error("invalid M reviewed tree");
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
    reviews,
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
