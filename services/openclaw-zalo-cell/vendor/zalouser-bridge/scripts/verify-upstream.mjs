import {
  X509Certificate,
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
} from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

// Commit ĐÃ REVIEW của checkpoint M. Export để test dựng được bản export từ
// đúng cây này thay vì từ HEAD — xem chú thích trong vendor-integrity.test.ts.
export const M_SHA = "0650187981ad9728d295fae34eff92b508e36bc8";
const VENDOR_REL = "services/openclaw-zalo-cell/vendor/zalouser-bridge";
const UPSTREAM_REL = `${VENDOR_REL}/UPSTREAM.json`;
const EXPECTED_AGGREGATE = "72470cdd84ed7d0cbb06152f57f0e4d1439891cf1909f164c8ece4485fc31a6b";
const EXPECTED_UPSTREAM = Object.freeze({
  mode: "100644",
  oid: "1feb5726487a162aab7310f702e036ecac09bda1",
  sha256: "989902dd5a1873025b1fef4864c4a6b9874fbaa15216201dc1c75ad053ce31ea",
  size: 29539,
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(message) {
  throw new Error(message);
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) fail(`${label} mismatch`);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );
  const wanted = [...expected].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} has unknown or missing properties`);
  }
}

function decodeBase64(value, label) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    fail(`${label} is not canonical base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail(`${label} is not canonical base64`);
  return bytes;
}

function parseSafeDecimal(value, label) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) fail(`${label} is not canonical decimal`);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) fail(`${label} exceeds the safe integer range`);
  return result;
}

async function readBoundedResponse(response, cap, label) {
  if (!Number.isSafeInteger(cap) || cap < 1) fail(`${label} cap is invalid`);
  if (!response.body) fail(`${label} response has no body`);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > cap) {
        await reader.cancel(`${label} exceeded byte cap`);
        fail(`${label} exceeded byte cap`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function parseJsonStrict(bytes, label = "JSON") {
  const text = Buffer.from(bytes).toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) fail(`${label} contains a BOM`);
  let offset = 0;
  const skipWhitespace = () => {
    while (offset < text.length && /[\u0009\u000a\u000d\u0020]/.test(text[offset])) offset += 1;
  };
  const parseString = () => {
    const start = offset;
    if (text[offset] !== '"') fail(`${label} contains an invalid JSON string`);
    offset += 1;
    while (offset < text.length) {
      const code = text.charCodeAt(offset);
      if (code === 0x22) {
        offset += 1;
        return JSON.parse(text.slice(start, offset));
      }
      if (code === 0x5c) {
        offset += 1;
        if (offset >= text.length) fail(`${label} contains an unterminated JSON escape`);
        const escape = text[offset];
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(offset + 1, offset + 5))) fail(`${label} contains an invalid Unicode escape`);
          offset += 5;
        } else if ('"\\/bfnrt'.includes(escape)) {
          offset += 1;
        } else {
          fail(`${label} contains an invalid JSON escape`);
        }
        continue;
      }
      if (code < 0x20) fail(`${label} contains a control character in a JSON string`);
      offset += 1;
    }
    fail(`${label} contains an unterminated JSON string`);
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
        if (keys.has(key)) fail(`${label} contains a duplicate JSON key: ${key}`);
        keys.add(key);
        skipWhitespace();
        if (text[offset] !== ":") fail(`${label} contains a malformed JSON object`);
        offset += 1;
        parseValue();
        skipWhitespace();
        if (text[offset] === "}") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") fail(`${label} contains a malformed JSON object`);
        offset += 1;
      }
      fail(`${label} contains an unterminated JSON object`);
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
        if (text[offset] !== ",") fail(`${label} contains a malformed JSON array`);
        offset += 1;
      }
      fail(`${label} contains an unterminated JSON array`);
    }
    const start = offset;
    while (offset < text.length && !/[\u0009\u000a\u000d\u0020,\]}]/.test(text[offset])) offset += 1;
    if (start === offset) fail(`${label} contains an invalid JSON value`);
    const value = JSON.parse(text.slice(start, offset));
    if (typeof value === "number" && (!Number.isFinite(value) || !Number.isSafeInteger(value))) {
      fail(`${label} contains a non-I-JSON number`);
    }
    return value;
  };
  const value = parseValue();
  skipWhitespace();
  if (offset !== text.length) fail(`${label} contains trailing bytes`);
  return JSON.parse(text);
}

export async function fetchBoundedJson(url, cap, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Accept: "application/json", "Accept-Encoding": "identity" },
    redirect: "manual",
  });
  if (response.status !== 200 || response.redirected) fail(`JSON acquisition failed for ${url}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    fail(`JSON acquisition content type mismatch for ${url}`);
  }
  if (response.headers.has("content-encoding")) fail(`JSON acquisition was compressed for ${url}`);
  const bytes = await readBoundedResponse(response, cap, `JSON acquisition ${url}`);
  parseJsonStrict(bytes, `JSON acquisition ${url}`);
  return { bytes, contentType };
}

function assertRegistryTarballUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("tarball redirect URL is invalid");
  }
  const labels = url.hostname.toLowerCase().split(".");
  const registryHost = url.hostname.toLowerCase() === "registry.npmjs.org";
  const directSubdomain = labels.length === 4 && labels.slice(1).join(".") === "registry.npmjs.org";
  if (
    url.protocol !== "https:" ||
    (!registryHost && !directSubdomain) ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    fail("tarball redirect left the allowed npm registry hosts");
  }
  return url;
}

export async function fetchTarballWithRedirects(url, cap, fetchImpl = fetch) {
  let current = assertRegistryTarballUrl(url);
  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    const response = await fetchImpl(current.href, {
      method: "GET",
      headers: { Accept: "application/octet-stream", "Accept-Encoding": "identity" },
      redirect: "manual",
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirectCount === 3) fail("tarball exceeded the three-redirect limit");
      const location = response.headers.get("location");
      if (!location) fail("tarball redirect is missing Location");
      current = assertRegistryTarballUrl(new URL(location, current).href);
      continue;
    }
    if (response.status !== 200 || response.redirected) fail("tarball acquisition failed");
    if (response.headers.has("content-encoding")) fail("tarball acquisition was compressed");
    const bytes = await readBoundedResponse(response, cap, "tarball acquisition");
    return { bytes, finalUrl: current.href };
  }
  fail("tarball redirect loop is unreachable");
}

async function fetchGithubJson(url, fetchImpl) {
  const { bytes } = await fetchBoundedJson(url, 32 * 1024 * 1024, fetchImpl);
  return JSON.parse(bytes.toString("utf8"));
}

function uniqueTreeEntry(tree, path, type, label) {
  const matches = tree.filter((item) => item.path === path && item.type === type);
  if (matches.length !== 1) fail(`${label} tree entry mismatch`);
  return matches[0];
}

export async function verifyExternalSourceMembership(options) {
  const { upstream } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiRoot = "https://api.github.com/repos/openclaw/openclaw/git";
  const commit = await fetchGithubJson(`${apiRoot}/commits/${upstream.sourceCommit}`, fetchImpl);
  expectEqual(commit.sha, upstream.sourceCommit, "GitHub source commit");
  if (!/^[0-9a-f]{40}$/.test(commit.tree?.sha ?? "")) fail("GitHub root tree ID is invalid");
  const rootTree = await fetchGithubJson(`${apiRoot}/trees/${commit.tree.sha}`, fetchImpl);
  if (rootTree.truncated !== false || !Array.isArray(rootTree.tree)) fail("GitHub root tree is incomplete");
  for (const item of upstream.rootCompliance) {
    const entry = uniqueTreeEntry(rootTree.tree, item.sourcePath, "blob", `root ${item.sourcePath}`);
    if (entry.mode !== item.mode || entry.sha !== item.gitBlobOid || entry.size !== item.size) {
      fail(`root ${item.sourcePath} Git object mismatch`);
    }
  }
  const extensions = uniqueTreeEntry(rootTree.tree, "extensions", "tree", "extensions");
  if (extensions.mode !== "040000" || !/^[0-9a-f]{40}$/.test(extensions.sha ?? "")) {
    fail("GitHub extensions tree identity mismatch");
  }
  const extensionsTree = await fetchGithubJson(`${apiRoot}/trees/${extensions.sha}`, fetchImpl);
  if (extensionsTree.truncated !== false || !Array.isArray(extensionsTree.tree)) {
    fail("GitHub extensions tree is incomplete");
  }
  const zalouser = uniqueTreeEntry(extensionsTree.tree, "zalouser", "tree", "zalouser");
  if (zalouser.mode !== "040000" || !/^[0-9a-f]{40}$/.test(zalouser.sha ?? "")) {
    fail("GitHub zalouser tree identity mismatch");
  }
  const sourceTree = await fetchGithubJson(`${apiRoot}/trees/${zalouser.sha}?recursive=1`, fetchImpl);
  if (sourceTree.truncated !== false || !Array.isArray(sourceTree.tree)) fail("GitHub source tree is incomplete");
  if (sourceTree.tree.some((item) => item.type !== "blob" && item.type !== "tree")) {
    fail("GitHub source tree contains a forbidden entry type");
  }
  const blobs = sourceTree.tree.filter((item) => item.type === "blob");
  if (blobs.length !== upstream.sourceManifest.length) fail("GitHub source blob count mismatch");
  const byPath = new Map();
  for (const entry of blobs) {
    if (typeof entry.path !== "string" || byPath.has(entry.path)) fail("GitHub source path collision");
    byPath.set(entry.path, entry);
  }
  for (const item of upstream.sourceManifest) {
    const path = item.sourcePath.slice(`${upstream.sourceSubtree}/`.length);
    const entry = byPath.get(path);
    if (!entry || entry.mode !== item.mode || entry.sha !== item.gitBlobOid || entry.size !== item.size) {
      fail(`GitHub source blob mismatch: ${item.sourcePath}`);
    }
  }
  return { requestCount: 4, sourceBlobCount: blobs.length };
}

export async function reacquireProvenanceInputs(options) {
  const vendorRoot = resolve(options.vendorRoot);
  const { upstream } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const parsed = new Map();
  for (const item of upstream.provenanceInputs) {
    const committedBytes = readFileSync(resolve(vendorRoot, item.path));
    if (committedBytes.length !== item.size || sha256(committedBytes) !== item.sha256) {
      fail(`committed provenance input mismatch: ${item.path}`);
    }
    const committedValue = parseJsonStrict(committedBytes, `committed ${item.path}`);
    const { bytes } = await fetchBoundedJson(item.endpoint, item.cap, fetchImpl);
    const reacquiredValue = parseJsonStrict(bytes, `reacquired ${item.path}`);
    // So NOI DUNG (JCS: sort khoa, bo moi khoang trang), KHONG so tung byte.
    //
    // VI SAO DOI (do 22/08/2026): npm doi cach DINH DANG response cua endpoint
    // attestation. Noi dung khong doi mot ly — JCS cua ban cu va ban moi bang
    // nhau tuyet doi, cung sha512 doi tuong duoc ky, cung chu ky DSSE — nhung
    // phep so byte van do.
    //
    // Va ghim lai bytes KHONG cuu duoc: da thu that. Ghim 15645 -> CI do; ghim
    // 15559 (dung bytes npm tra ve cho may nay, VPS Singapore, va cho chinh
    // fetchBoundedJson) -> CI VAN do, chay lai lan hai van do. Runner nhan mot
    // chuoi byte thu ba ma khong client nao o day tai ve duoc. Mot cua doi bang
    // nhau TUNG BYTE voi endpoint song cua ben thu ba chi xanh khi ben do byte-on
    // dinh voi MOI client — dieu npm khong bao dam va thuc te khong giu.
    //
    // Tinh chat bao mat GIU NGUYEN, khong nhuong mot buoc nao:
    //   - Ban DA COMMIT van ghim tung byte (size + sha256 tu UPSTREAM.json) o
    //     phep kiem ngay tren, va van nam trong M-aggregate.
    //   - Ban TAI LAI phai trung KHOP TUNG GIA TRI: chu ky, digest, payload,
    //     thu tu phan tu mang. JSON khong gan nghia cho khoang trang hay thu tu
    //     khoa, nen thu bo di dung la thu khong mang thong tin.
    //   - Doi mot byte trong chu ky hay digest van do — co test dot bien ben duoi.
    if (jcs(reacquiredValue) !== jcs(committedValue)) {
      fail(`reacquired provenance input mismatch: ${item.path}`);
    }
    parsed.set(item.path, committedValue);
  }
  return { inputCount: parsed.size, parsed };
}

function dssePae(envelope) {
  expectEqual(envelope.payloadType, "application/vnd.in-toto+json", "DSSE payload type");
  const payload = decodeBase64(envelope.payload, "DSSE payload");
  const payloadType = Buffer.from(envelope.payloadType, "utf8");
  return {
    payload,
    pae: Buffer.concat([
      Buffer.from(`DSSEv1 ${payloadType.length} `, "ascii"),
      payloadType,
      Buffer.from(` ${payload.length} `, "ascii"),
      payload,
    ]),
  };
}

function verifyDsseEnvelope(envelope, publicKey, expectedKeyId) {
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length !== 1) fail("DSSE signature count mismatch");
  const signature = envelope.signatures[0];
  if (expectedKeyId !== undefined) expectEqual(signature.keyid, expectedKeyId, "DSSE key ID");
  const { pae, payload } = dssePae(envelope);
  if (!verifySignature("sha256", pae, publicKey, decodeBase64(signature.sig, "DSSE signature"))) {
    fail("DSSE signature verification failed");
  }
  return JSON.parse(payload.toString("utf8"));
}

function verifyStatementSubject(statement, upstream) {
  expectEqual(statement.subject?.length, 1, "attestation subject count");
  expectEqual(statement.subject[0]?.name, upstream.attestation.subject, "attestation subject");
  expectEqual(statement.subject[0]?.digest?.sha512, upstream.attestation.subjectSha512, "attestation SHA-512");
}

function readDerNode(bytes, offset = 0) {
  if (offset + 2 > bytes.length) fail("truncated DER node");
  const tag = bytes[offset];
  const firstLength = bytes[offset + 1];
  let length = firstLength;
  let headerLength = 2;
  if ((firstLength & 0x80) !== 0) {
    const lengthBytes = firstLength & 0x7f;
    if (lengthBytes === 0 || lengthBytes > 4 || offset + 2 + lengthBytes > bytes.length) fail("invalid DER length");
    length = 0;
    for (let index = 0; index < lengthBytes; index += 1) length = length * 256 + bytes[offset + 2 + index];
    headerLength += lengthBytes;
  }
  const contentStart = offset + headerLength;
  const end = contentStart + length;
  if (end > bytes.length) fail("truncated DER content");
  return { bytes, contentStart, end, next: end, start: offset, tag };
}

function derChildren(node) {
  const result = [];
  let offset = node.contentStart;
  while (offset < node.end) {
    const child = readDerNode(node.bytes, offset);
    result.push(child);
    offset = child.next;
  }
  if (offset !== node.end) fail("invalid DER child boundary");
  return result;
}

function decodeOid(bytes) {
  if (bytes.length === 0) fail("empty DER OID");
  const parts = [Math.floor(bytes[0] / 40), bytes[0] % 40];
  let value = 0;
  for (const byte of bytes.subarray(1)) {
    value = value * 128 + (byte & 0x7f);
    if (!Number.isSafeInteger(value)) fail("DER OID component overflow");
    if ((byte & 0x80) === 0) {
      parts.push(value);
      value = 0;
    }
  }
  if (value !== 0) fail("truncated DER OID");
  return parts.join(".");
}

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(`${label} is not valid UTF-8`);
  }
}

function readCertificateExtensions(rawCertificate) {
  const certificate = readDerNode(rawCertificate);
  if (certificate.tag !== 0x30 || certificate.end !== rawCertificate.length) fail("certificate DER root mismatch");
  const tbs = derChildren(certificate)[0];
  if (!tbs || tbs.tag !== 0x30) fail("certificate TBS sequence is missing");
  const extensionsWrapper = derChildren(tbs).find((node) => node.tag === 0xa3);
  if (!extensionsWrapper) fail("certificate extensions are missing");
  const extensionSequence = derChildren(extensionsWrapper)[0];
  if (!extensionSequence || extensionSequence.tag !== 0x30) fail("certificate extension sequence is invalid");
  const extensions = new Map();
  for (const extension of derChildren(extensionSequence)) {
    if (extension.tag !== 0x30) fail("certificate extension record is invalid");
    const fields = derChildren(extension);
    if (fields[0]?.tag !== 0x06) fail("certificate extension OID is missing");
    const oid = decodeOid(rawCertificate.subarray(fields[0].contentStart, fields[0].end));
    if (!oid.startsWith("1.3.6.1.4.1.57264.")) continue;
    const valueNode = fields.at(-1);
    if (!valueNode || valueNode.tag !== 0x04) fail("certificate extension value is missing");
    const rawValue = rawCertificate.subarray(valueNode.contentStart, valueNode.end);
    const nested = rawValue.length > 1 && rawValue[0] === 0x0c ? readDerNode(rawValue) : null;
    const value = nested && nested.end === rawValue.length
      ? decodeUtf8(rawValue.subarray(nested.contentStart, nested.end), `certificate extension ${oid}`)
      : decodeUtf8(rawValue, `certificate extension ${oid}`);
    extensions.set(oid, value);
  }
  return extensions;
}

function verifyFulcioCertificate(rawLeaf, trustRoot, upstream, integratedTime) {
  expectEqual(sha256(rawLeaf), upstream.slsa.leafCertificateSha256, "Fulcio leaf certificate hash");
  const leaf = new X509Certificate(rawLeaf);
  const trustedCertificates = trustRoot.certificateAuthorities.flatMap((authority) => authority.certChain.certificates);
  const findCertificate = (digest, label) => {
    const matches = trustedCertificates
      .map((item) => decodeBase64(item.rawBytes, `${label} certificate`))
      .filter((raw) => sha256(raw) === digest);
    if (matches.length !== 1) fail(`${label} certificate selection mismatch`);
    return new X509Certificate(matches[0]);
  };
  const intermediate = findCertificate(upstream.slsa.fulcioIntermediateDerSha256, "Fulcio intermediate");
  const root = findCertificate(upstream.slsa.fulcioRootDerSha256, "Fulcio root");
  if (
    leaf.ca || !intermediate.ca || !root.ca ||
    !leaf.checkIssued(intermediate) || !leaf.verify(intermediate.publicKey) ||
    !intermediate.checkIssued(root) || !intermediate.verify(root.publicKey) ||
    !root.checkIssued(root) || !root.verify(root.publicKey)
  ) {
    fail("Fulcio certificate chain verification failed");
  }
  if (leaf.publicKey.asymmetricKeyType !== "ec" || leaf.publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    fail("Fulcio leaf key type mismatch");
  }
  expectEqual(leaf.subjectAltName, `URI:${upstream.slsa.uriSan}`, "Fulcio URI SAN");
  const integratedAt = integratedTime * 1000;
  if (integratedAt < Date.parse(leaf.validFrom) || integratedAt > Date.parse(leaf.validTo)) {
    fail("Rekor integrated time is outside Fulcio certificate validity");
  }
  const extensions = readCertificateExtensions(rawLeaf);
  const requireOneOf = (oids, expected, label) => {
    const values = oids.map((oid) => extensions.get(oid)).filter((value) => value !== undefined);
    if (values.length === 0 || values.some((value) => value !== expected)) fail(`${label} certificate extension mismatch`);
  };
  requireOneOf(["1.3.6.1.4.1.57264.1.1", "1.3.6.1.4.1.57264.1.8"], upstream.slsa.oidcIssuer, "OIDC issuer");
  requireOneOf(["1.3.6.1.4.1.57264.1.2", "1.3.6.1.4.1.57264.1.20"], upstream.slsa.workflowEvent, "workflow event");
  requireOneOf(["1.3.6.1.4.1.57264.1.5"], upstream.slsa.repository, "repository");
  requireOneOf(["1.3.6.1.4.1.57264.1.6", "1.3.6.1.4.1.57264.1.14"], upstream.slsa.ref, "source ref");
  requireOneOf(["1.3.6.1.4.1.57264.1.23"], upstream.slsa.environment, "build environment");
  return leaf;
}

function hashRekorLeaf(bytes) {
  return createHash("sha256").update(Buffer.from([0])).update(bytes).digest();
}

function hashRekorNode(left, right) {
  return createHash("sha256").update(Buffer.from([1])).update(left).update(right).digest();
}

function verifyInclusionProof(entry, bodyBytes) {
  const proof = entry.inclusionProof;
  let nodeIndex = BigInt(parseSafeDecimal(proof.logIndex, "Rekor proof log index"));
  let lastNode = BigInt(parseSafeDecimal(proof.treeSize, "Rekor proof tree size")) - 1n;
  if (nodeIndex < 0n || nodeIndex > lastNode) fail("Rekor proof index is outside the tree");
  let root = hashRekorLeaf(bodyBytes);
  for (const encodedHash of proof.hashes) {
    const sibling = decodeBase64(encodedHash, "Rekor proof hash");
    if (sibling.length !== 32) fail("Rekor proof hash length mismatch");
    if ((nodeIndex & 1n) === 1n || nodeIndex === lastNode) {
      root = hashRekorNode(sibling, root);
      while ((nodeIndex & 1n) === 0n && nodeIndex !== 0n) {
        nodeIndex >>= 1n;
        lastNode >>= 1n;
      }
    } else {
      root = hashRekorNode(root, sibling);
    }
    nodeIndex >>= 1n;
    lastNode >>= 1n;
  }
  if (nodeIndex !== 0n || lastNode !== 0n || !root.equals(decodeBase64(proof.rootHash, "Rekor root hash"))) {
    fail("Rekor inclusion proof verification failed");
  }
}

function verifyCheckpoint(proof, rekorKey, upstream) {
  const envelope = proof.checkpoint?.envelope;
  if (typeof envelope !== "string") fail("Rekor checkpoint is missing");
  const sections = envelope.split("\n\n");
  if (sections.length !== 2) fail("Rekor checkpoint envelope format mismatch");
  const lines = sections[0].split("\n");
  if (lines.length !== 3 || lines[0] !== "rekor.sigstore.dev - 1193050959916656506") {
    fail("Rekor checkpoint origin mismatch");
  }
  expectEqual(lines[1], proof.treeSize, "Rekor checkpoint tree size");
  expectEqual(lines[2], proof.rootHash, "Rekor checkpoint root hash");
  const signatureParts = sections[1].trim().split(/\s+/);
  if (signatureParts.length !== 3 || signatureParts[0] !== "\u2014" || signatureParts[1] !== "rekor.sigstore.dev") {
    fail("Rekor checkpoint signature line mismatch");
  }
  const signed = decodeBase64(signatureParts[2], "Rekor checkpoint signature");
  const keyHint = Buffer.from(upstream.slsa.rekorSpkiSha256.slice(0, 8), "hex");
  if (!signed.subarray(0, 4).equals(keyHint)) fail("Rekor checkpoint key hint mismatch");
  if (!verifySignature("sha256", Buffer.from(`${sections[0]}\n`, "utf8"), rekorKey, signed.subarray(4))) {
    fail("Rekor checkpoint signature verification failed");
  }
}

function rekorEnvelopeBytes(envelope) {
  return Buffer.from(JSON.stringify({
    payload: envelope.payload,
    payloadType: envelope.payloadType,
    signatures: envelope.signatures.map((signature) => signature.keyid
      ? { sig: signature.sig, keyid: signature.keyid }
      : { sig: signature.sig }),
  }), "utf8");
}

function verifyRekorEntry(entry, envelope, rekorKey, upstream, verifier) {
  expectEqual(entry.logId?.keyId, upstream.slsa.rekorKeyIdBase64, "Rekor log ID");
  expectEqual(entry.kindVersion?.kind, "dsse", "Rekor entry kind");
  expectEqual(entry.kindVersion?.version, "0.0.1", "Rekor entry version");
  const integratedTime = parseSafeDecimal(entry.integratedTime, "Rekor integrated time");
  const logIndex = parseSafeDecimal(entry.logIndex, "Rekor log index");
  const bodyBytes = decodeBase64(entry.canonicalizedBody, "Rekor canonical body");
  const setPreimage = Buffer.from(JSON.stringify({
    body: entry.canonicalizedBody,
    integratedTime,
    logID: decodeBase64(entry.logId.keyId, "Rekor log ID").toString("hex"),
    logIndex,
  }), "utf8");
  if (!verifySignature("sha256", setPreimage, rekorKey, decodeBase64(entry.inclusionPromise?.signedEntryTimestamp, "Rekor SET"))) {
    fail("Rekor SET verification failed");
  }
  const body = JSON.parse(bodyBytes.toString("utf8"));
  expectEqual(body.apiVersion, "0.0.1", "Rekor body API version");
  expectEqual(body.kind, "dsse", "Rekor body kind");
  expectEqual(body.spec?.payloadHash?.algorithm, "sha256", "Rekor payload hash algorithm");
  expectEqual(body.spec?.payloadHash?.value, sha256(decodeBase64(envelope.payload, "DSSE payload")), "Rekor payload hash");
  expectEqual(body.spec?.envelopeHash?.algorithm, "sha256", "Rekor envelope hash algorithm");
  expectEqual(body.spec?.envelopeHash?.value, sha256(rekorEnvelopeBytes(envelope)), "Rekor envelope hash");
  expectEqual(body.spec?.signatures?.length, 1, "Rekor signature count");
  expectEqual(body.spec.signatures[0].signature, envelope.signatures[0].sig, "Rekor DSSE signature binding");
  verifier(body.spec.signatures[0].verifier);
  verifyInclusionProof(entry, bodyBytes);
  verifyCheckpoint(entry.inclusionProof, rekorKey, upstream);
  return integratedTime;
}

export function verifySigstoreAttestations(options) {
  const { upstream } = options;
  const vendorRoot = resolve(options.vendorRoot);
  inspectTarball(options.tarballBytes, upstream);
  const metadata = options.metadata ?? JSON.parse(readFileSync(resolve(vendorRoot, "upstream/provenance/npm-registry-metadata.json"), "utf8"));
  const keys = options.keys ?? JSON.parse(readFileSync(resolve(vendorRoot, "upstream/provenance/npm-registry-keys.json"), "utf8"));
  const attestations = options.attestations ?? JSON.parse(readFileSync(resolve(vendorRoot, "upstream/provenance/npm-attestation-bundles.json"), "utf8"));
  const trustRoot = options.trustRoot ?? JSON.parse(readFileSync(resolve(vendorRoot, "upstream/provenance/sigstore-trusted-root.json"), "utf8"));
  expectEqual(metadata.name, upstream.package, "npm metadata package");
  expectEqual(metadata.version, upstream.version, "npm metadata version");
  expectEqual(metadata.gitHead, upstream.sourceCommit, "npm metadata Git head");
  expectEqual(metadata.dist?.tarball, upstream.tarball.url, "npm metadata tarball URL");
  expectEqual(metadata.dist?.integrity, upstream.tarball.lock.sri, "npm metadata integrity");
  expectEqual(metadata.dist?.shasum, upstream.tarball.lock.sha1, "npm metadata shasum");
  expectEqual(metadata.dist?.fileCount, upstream.tarball.counts.regularFiles, "npm metadata file count");
  const npmSignatures = metadata.dist?.signatures?.filter((item) => item.keyid === upstream.npmSignature.keyId) ?? [];
  const npmKeys = keys.keys?.filter((item) => item.keyid === upstream.npmSignature.keyId) ?? [];
  if (npmSignatures.length !== 1 || npmKeys.length !== 1) fail("npm signature/key selection mismatch");
  const npmKeyRecord = npmKeys[0];
  expectEqual(npmKeyRecord.keytype, upstream.npmSignature.algorithm, "npm key type");
  expectEqual(npmKeyRecord.scheme, upstream.npmSignature.algorithm, "npm key scheme");
  expectEqual(npmKeyRecord.key, upstream.npmSignature.spki, "npm SPKI");
  const npmSpki = decodeBase64(npmKeyRecord.key, "npm SPKI");
  const npmKey = createPublicKey({ key: npmSpki, format: "der", type: "spki" });
  if (npmKey.asymmetricKeyType !== "ec" || npmKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") fail("npm key curve mismatch");
  const npmPreimage = Buffer.from(`${metadata.name}@${metadata.version}:${metadata.dist.integrity}`, "utf8");
  if (!verifySignature("sha256", npmPreimage, npmKey, decodeBase64(npmSignatures[0].sig, "npm signature"))) {
    fail("npm signature verification failed");
  }
  const publishMatches = attestations.attestations?.filter((item) => item.predicateType === "https://github.com/npm/attestation/tree/main/specs/publish/v0.1") ?? [];
  const slsaMatches = attestations.attestations?.filter((item) => item.predicateType === "https://slsa.dev/provenance/v1") ?? [];
  if (publishMatches.length !== 1 || slsaMatches.length !== 1 || attestations.attestations.length !== 2) {
    fail("attestation bundle selection mismatch");
  }
  const publish = publishMatches[0].bundle;
  expectEqual(publish.verificationMaterial?.publicKey?.hint, upstream.npmSignature.keyId, "publish key hint");
  const publishStatement = verifyDsseEnvelope(publish.dsseEnvelope, npmKey, upstream.npmSignature.keyId);
  verifyStatementSubject(publishStatement, upstream);
  expectEqual(publishStatement.predicateType, publishMatches[0].predicateType, "publish predicate type");
  expectEqual(publishStatement.predicate?.name, upstream.package, "publish package");
  expectEqual(publishStatement.predicate?.version, upstream.version, "publish version");
  expectEqual(publishStatement.predicate?.registry, "https://registry.npmjs.org", "publish registry");
  const tlogs = trustRoot.tlogs?.filter((item) => item.logId?.keyId === upstream.slsa.rekorKeyIdBase64) ?? [];
  if (tlogs.length !== 1) fail("Rekor trusted key selection mismatch");
  const rekorSpki = decodeBase64(tlogs[0].publicKey?.rawBytes, "Rekor SPKI");
  expectEqual(sha256(rekorSpki), upstream.slsa.rekorSpkiSha256, "Rekor SPKI hash");
  const rekorKey = createPublicKey({ key: rekorSpki, format: "der", type: "spki" });
  const publishEntries = publish.verificationMaterial?.tlogEntries ?? [];
  if (publishEntries.length !== 1) fail("publish Rekor entry count mismatch");
  verifyRekorEntry(publishEntries[0], publish.dsseEnvelope, rekorKey, upstream, (encodedVerifier) => {
    const verifierKey = createPublicKey(decodeBase64(encodedVerifier, "publish Rekor verifier"));
    const verifierSpki = verifierKey.export({ format: "der", type: "spki" });
    if (!Buffer.from(verifierSpki).equals(npmSpki)) fail("publish Rekor verifier mismatch");
  });
  const slsa = slsaMatches[0].bundle;
  const slsaEntries = slsa.verificationMaterial?.tlogEntries ?? [];
  if (slsaEntries.length !== 1) fail("SLSA Rekor entry count mismatch");
  const rawLeaf = decodeBase64(slsa.verificationMaterial?.certificate?.rawBytes, "Fulcio leaf certificate");
  const leaf = verifyFulcioCertificate(
    rawLeaf,
    trustRoot,
    upstream,
    parseSafeDecimal(slsaEntries[0].integratedTime, "SLSA integrated time"),
  );
  const slsaStatement = verifyDsseEnvelope(slsa.dsseEnvelope, leaf.publicKey, "");
  verifyStatementSubject(slsaStatement, upstream);
  expectEqual(slsaStatement.predicateType, slsaMatches[0].predicateType, "SLSA predicate type");
  const definition = slsaStatement.predicate?.buildDefinition;
  expectEqual(definition?.buildType, upstream.slsa.buildType, "SLSA build type");
  expectEqual(definition?.externalParameters?.workflow?.repository, `https://github.com/${upstream.slsa.repository}`, "SLSA repository");
  expectEqual(definition?.externalParameters?.workflow?.path, ".github/workflows/plugin-npm-release.yml", "SLSA workflow path");
  expectEqual(definition?.externalParameters?.workflow?.ref, upstream.slsa.ref, "SLSA ref");
  expectEqual(definition?.internalParameters?.github?.event_name, upstream.slsa.workflowEvent, "SLSA event");
  expectEqual(definition?.resolvedDependencies?.length, 1, "SLSA resolved dependency count");
  expectEqual(definition.resolvedDependencies[0]?.digest?.gitCommit, upstream.slsa.resolvedCommit, "SLSA resolved commit");
  verifyRekorEntry(slsaEntries[0], slsa.dsseEnvelope, rekorKey, upstream, (encodedVerifier) => {
    const verifierCertificate = new X509Certificate(decodeBase64(encodedVerifier, "SLSA Rekor verifier"));
    if (!verifierCertificate.raw.equals(rawLeaf)) fail("SLSA Rekor verifier mismatch");
  });
  return { npm: "verified", rekorEntries: 2, slsa: "verified" };
}

function readTarString(header, start, length) {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString("utf8");
}

function readTarNumber(header, start, length) {
  const field = header.subarray(start, start + length);
  if ((field[0] & 0x80) !== 0) {
    let value = BigInt(field[0] & 0x7f);
    for (const byte of field.subarray(1)) value = (value << 8n) | BigInt(byte);
    return Number(value);
  }
  const text = field.toString("ascii").replace(/\0.*$/s, "").trim();
  return text === "" ? 0 : Number.parseInt(text, 8);
}

function validateArchivePath(path) {
  if (
    path === "" ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`unsafe archive path: ${path}`);
  }
}

function parsePax(bytes) {
  const result = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space < 0) throw new Error("invalid pax record length");
    const length = Number.parseInt(bytes.subarray(offset, space).toString("ascii"), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > bytes.length) {
      throw new Error("invalid pax record");
    }
    const record = bytes.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals < 1) throw new Error("invalid pax key/value");
    result[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return result;
}

export function readTgzEntries(tgzBytes) {
  const tar = gunzipSync(tgzBytes, { maxOutputLength: 256 * 1024 * 1024 });
  const entries = [];
  const seen = new Set();
  const folded = new Set();
  let offset = 0;
  let pendingPax = null;
  let pendingLongPath = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (!tar.subarray(offset).every((byte) => byte === 0)) throw new Error("nonzero bytes after tar terminator");
      return entries;
    }
    const storedChecksum = readTarNumber(header, 148, 8);
    let checksum = 0;
    for (let index = 0; index < header.length; index += 1) {
      checksum += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    if (checksum !== storedChecksum) throw new Error("tar header checksum mismatch");
    const prefix = readTarString(header, 345, 155);
    const name = readTarString(header, 0, 100);
    let path = prefix ? `${prefix}/${name}` : name;
    const typeByte = header[156];
    const type = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
    const size = readTarNumber(header, 124, 12);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`invalid tar size: ${path}`);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error(`truncated tar entry: ${path}`);
    const bytes = tar.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type === "x") {
      pendingPax = parsePax(bytes);
      continue;
    }
    if (type === "L") {
      pendingLongPath = bytes.subarray(0, Math.max(0, bytes.indexOf(0))).toString("utf8");
      continue;
    }
    path = pendingPax?.path ?? pendingLongPath ?? path;
    const effectiveSize = pendingPax?.size === undefined ? size : Number(pendingPax.size);
    pendingPax = null;
    pendingLongPath = null;
    validateArchivePath(path.replace(/\/$/, ""));
    if (type === "5") continue;
    if (type !== "0") throw new Error(`forbidden tar entry type ${type}: ${path}`);
    if (effectiveSize !== size) throw new Error(`pax size mismatch: ${path}`);
    if (seen.has(path)) throw new Error(`duplicate tar path: ${path}`);
    const foldedPath = path.toLowerCase();
    if (folded.has(foldedPath)) throw new Error(`case-colliding tar path: ${path}`);
    seen.add(path);
    folded.add(foldedPath);
    entries.push(Object.freeze({ bytes: Buffer.from(bytes), mode: readTarNumber(header, 100, 8), path, size }));
  }
  throw new Error("tar archive is missing its terminator");
}

export function inspectTarball(tgzBytes, upstream) {
  const lock = upstream.tarball.lock;
  if (tgzBytes.length !== lock.size) throw new Error("tarball size mismatch");
  for (const algorithm of ["sha1", "sha256", "sha512"]) {
    const digest = createHash(algorithm).update(tgzBytes).digest("hex");
    if (digest !== lock[algorithm]) throw new Error(`tarball ${algorithm} mismatch`);
  }
  const sri = `sha512-${createHash("sha512").update(tgzBytes).digest("base64")}`;
  if (sri !== lock.sri) throw new Error("tarball SRI mismatch");
  const entries = readTgzEntries(tgzBytes);
  const packageOwned = entries.filter((entry) => !entry.path.startsWith("package/node_modules/"));
  const bundled = entries.filter((entry) => entry.path.startsWith("package/node_modules/"));
  const roots = new Set(
    bundled.map((entry) => {
      const parts = entry.path.slice("package/node_modules/".length).split("/");
      return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
    }),
  );
  const expected = upstream.tarball.counts;
  if (
    entries.length !== expected.regularFiles ||
    packageOwned.length !== expected.packageOwnedFiles ||
    bundled.length !== expected.bundledFiles ||
    roots.size !== expected.dependencyPackageRoots
  ) {
    throw new Error("tarball entry counts mismatch");
  }
  return { bundled, entries, packageOwned, roots };
}

function git(repoRoot, args, options = {}) {
  return execFileSync("git", args, { cwd: repoRoot, ...options });
}

function readReviewedRecords(repoRoot, commit, paths) {
  const tree = new Map();
  const rawTree = git(repoRoot, ["ls-tree", "-rz", "--full-tree", commit]);
  for (const rawRecord of rawTree.toString("utf8").split("\0")) {
    if (rawRecord === "") continue;
    const match = /^(\d{6}) (\S+) ([0-9a-f]{40})\t(.+)$/.exec(rawRecord);
    if (!match) throw new Error("invalid reviewed Git tree record");
    tree.set(match[4], { mode: match[1], oid: match[3], path: match[4], type: match[2] });
  }
  const selected = paths.map((path) => {
    const item = tree.get(path);
    if (!item) throw new Error(`missing reviewed Git path: ${path}`);
    if (item.type !== "blob") throw new Error(`reviewed path is not a blob: ${path}`);
    if (item.mode !== "100644" && item.mode !== "100755") {
      throw new Error(`reviewed blob mode is forbidden: ${path}`);
    }
    return item;
  });
  const objectProcess = spawnSync("git", ["cat-file", "--batch"], {
    cwd: repoRoot,
    input: Buffer.from(`${selected.map((item) => item.oid).join("\n")}\n`, "ascii"),
    maxBuffer: 32 * 1024 * 1024,
  });
  if (objectProcess.status !== 0 || !objectProcess.stdout) {
    throw new Error(`git cat-file --batch failed: ${objectProcess.stderr?.toString("utf8") ?? ""}`);
  }
  const objects = new Map();
  let offset = 0;
  for (const item of selected) {
    const newline = objectProcess.stdout.indexOf(0x0a, offset);
    if (newline < 0) throw new Error("truncated git cat-file header");
    const header = objectProcess.stdout.subarray(offset, newline).toString("ascii");
    const match = /^([0-9a-f]{40}) blob (\d+)$/.exec(header);
    if (!match || match[1] !== item.oid) throw new Error(`invalid git cat-file object: ${item.path}`);
    const size = Number(match[2]);
    const start = newline + 1;
    const end = start + size;
    if (objectProcess.stdout[end] !== 0x0a) throw new Error(`truncated git blob: ${item.path}`);
    objects.set(item.oid, objectProcess.stdout.subarray(start, end));
    offset = end + 1;
  }
  if (offset !== objectProcess.stdout.length) throw new Error("unexpected git cat-file trailing bytes");
  return selected.map((item) => {
    const bytes = objects.get(item.oid);
    return { bytes, mode: item.mode, oid: item.oid, path: item.path, sha256: sha256(bytes), size: bytes.length };
  });
}

function gitBlobOid(bytes) {
  return createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`, "ascii"))
    .update(bytes)
    .digest("hex");
}

function exportedPath(exportRoot, portablePath) {
  const candidate = resolve(exportRoot, ...portablePath.split("/"));
  const rel = relative(exportRoot, candidate);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`reviewed export path escaped root: ${portablePath}`);
  }
  return candidate;
}

function readReviewedExportRecords(exportRoot, manifestPath, reviewedTree, paths, expectedManifestSha256) {
  if (!isAbsolute(manifestPath)) throw new Error("reviewed export manifest path must be absolute");
  if (!/^[0-9a-f]{40}$/.test(reviewedTree ?? "")) {
    throw new Error("reviewed export tree must be an exact 40-hex commit");
  }
  const manifestInfo = lstatSync(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
    throw new Error("reviewed export manifest must be a regular non-symlink file");
  }
  const manifestBytes = readFileSync(manifestPath);
  if (expectedManifestSha256 !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(expectedManifestSha256)) {
      throw new Error("reviewed export manifest SHA-256 is invalid");
    }
    if (sha256(manifestBytes) !== expectedManifestSha256) {
      throw new Error("reviewed export manifest SHA-256 mismatch");
    }
  }
  const manifest = parseJsonStrict(manifestBytes, "reviewed export manifest");
  const canonicalBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (!manifestBytes.equals(canonicalBytes)) {
    throw new Error("reviewed export manifest bytes are not canonical");
  }
  exactKeys(
    manifest,
    ["schema_version", "git_object_format", "reviewed_tree", "entries"],
    "reviewed export manifest",
  );
  if (
    manifest.schema_version !== 1 ||
    manifest.git_object_format !== "sha1" ||
    manifest.reviewed_tree !== reviewedTree ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length === 0
  ) {
    throw new Error("reviewed export manifest identity mismatch");
  }

  const byPath = new Map();
  const collisionKeys = new Set();
  let previousPath;
  for (const [index, entry] of manifest.entries.entries()) {
    exactKeys(
      entry,
      [
        "path",
        "type",
        "mode",
        "git_object_id",
        "git_object_size",
        "content_size",
        "content_sha256",
      ],
      `reviewed export entry ${index}`,
    );
    validateArchivePath(entry.path);
    if (
      entry.type !== "blob" ||
      !["100644", "100755"].includes(entry.mode) ||
      !/^[0-9a-f]{40}$/.test(entry.git_object_id ?? "") ||
      !Number.isSafeInteger(entry.git_object_size) ||
      entry.git_object_size < 0 ||
      entry.content_size !== entry.git_object_size ||
      !/^[0-9a-f]{64}$/.test(entry.content_sha256 ?? "")
    ) {
      throw new Error(`reviewed export entry is invalid: ${entry.path}`);
    }
    if (previousPath !== undefined && compareUtf8Paths({ path: previousPath }, entry) >= 0) {
      throw new Error("reviewed export entries are not raw UTF-8 path sorted");
    }
    previousPath = entry.path;
    const collisionKey = entry.path.normalize("NFC").toLowerCase();
    if (entry.path !== entry.path.normalize("NFC") || collisionKeys.has(collisionKey)) {
      throw new Error(`reviewed export path collision: ${entry.path}`);
    }
    collisionKeys.add(collisionKey);
    byPath.set(entry.path, entry);
  }

  return paths.map((path) => {
    const entry = byPath.get(path);
    if (!entry) throw new Error(`missing reviewed export path: ${path}`);
    const absolute = exportedPath(exportRoot, path);
    const info = lstatSync(absolute);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`reviewed export path is not a regular file: ${path}`);
    }
    const bytes = readFileSync(absolute);
    const oid = gitBlobOid(bytes);
    const contentSha256 = sha256(bytes);
    if (
      bytes.length !== entry.content_size ||
      oid !== entry.git_object_id ||
      contentSha256 !== entry.content_sha256
    ) {
      throw new Error(`reviewed export content mismatch: ${path}`);
    }
    return {
      bytes,
      mode: entry.mode,
      oid,
      path,
      sha256: contentSha256,
      size: bytes.length,
    };
  });
}

function compareUtf8Paths(left, right) {
  return Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"));
}

function jcs(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  if (!value || typeof value !== "object") throw new Error("unsupported JSON value");
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${jcs(value[key])}`)
    .join(",")}}`;
}

function record(kind, path, mode, size, objectId, digest) {
  return Buffer.from(`${kind}\0${path}\0${mode}\0${size}\0${objectId}\0${digest}\0`, "utf8");
}

function assertGoldenAggregate() {
  const projection = Buffer.from(
    '{"mInputAggregate":{"domain":"ihome-openclaw-m-inputs-v1","pathCount":2,"schema":1,"sha256":null}}',
    "utf8",
  );
  const chunks = [
    Buffer.from("ihome-openclaw-m-inputs-v1\0count\0" + "2\0", "utf8"),
    record(
      "blob",
      ".gitattributes",
      "100644",
      0,
      "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    ),
    record(
      "projection",
      "UPSTREAM.json",
      "100644",
      projection.length,
      "-",
      sha256(projection),
    ),
  ];
  const digest = sha256(Buffer.concat(chunks));
  if (projection.length !== 98 || sha256(projection) !== "5596aa901117139fdb6a574ceaa1b973f9af5d5e6d60422ca4fdec2fcf9120d3") {
    throw new Error("M aggregate projection golden vector failed");
  }
  if (digest !== "1d37c61eb87d4e9caf320f9ab07aed1e0d4cfc11e7496493db46fe1d4f6a97fb") {
    throw new Error("M aggregate root golden vector failed");
  }
}

function inventoryPaths(upstream) {
  const paths = new Set([
    ".gitattributes",
    "eslint.config.js",
    "vite.config.ts",
    `${VENDOR_REL}/SHA512SUMS`,
    `${VENDOR_REL}/licenses/manifest.json`,
    ...upstream.rootCompliance.map((item) => `${VENDOR_REL}/${item.outputPath}`),
    ...upstream.provenanceInputs.map((item) => `${VENDOR_REL}/${item.path}`),
    ...upstream.sourceManifest.map((item) => `${VENDOR_REL}/${item.outputPath}`),
    UPSTREAM_REL,
  ]);
  const result = [...paths].map((path) => ({ path })).sort(compareUtf8Paths).map((item) => item.path);
  if (result.length !== 87) throw new Error(`M inventory must contain 87 paths, got ${result.length}`);
  return result;
}

function verifyManifestBindings(records, upstream) {
  const byPath = new Map(records.map((item) => [item.path, item]));
  for (const item of upstream.sourceManifest) {
    const record = byPath.get(`${VENDOR_REL}/${item.outputPath}`);
    if (!record || record.mode !== item.mode || record.oid !== item.gitBlobOid || record.size !== item.size || record.sha256 !== item.sha256) {
      throw new Error(`source manifest Git object mismatch: ${item.outputPath}`);
    }
  }
  for (const item of [...upstream.rootCompliance, ...upstream.provenanceInputs]) {
    const record = byPath.get(`${VENDOR_REL}/${item.outputPath ?? item.path}`);
    if (!record || record.size !== item.size || record.sha256 !== item.sha256) {
      throw new Error(`reviewed input mismatch: ${item.outputPath ?? item.path}`);
    }
  }
  const license = byPath.get(`${VENDOR_REL}/${upstream.licenseManifestPath}`);
  if (!license || license.sha256 !== upstream.licenseManifestSha256) {
    throw new Error("license manifest hash mismatch");
  }
}

export function computeMInputAggregate(records, upstream) {
  const projected = structuredClone(upstream);
  projected.mInputAggregate.sha256 = null;
  const projectionBytes = Buffer.from(jcs(projected), "utf8");
  const aggregateRecords = records
    .map((item) =>
      item.path === UPSTREAM_REL
        ? { ...item, bytes: projectionBytes, kind: "projection", oid: "-", sha256: sha256(projectionBytes), size: projectionBytes.length }
        : { ...item, kind: "blob" },
    )
    .sort(compareUtf8Paths);
  const preimage = [
    Buffer.from(`ihome-openclaw-m-inputs-v1\0count\0${aggregateRecords.length}\0`, "utf8"),
    ...aggregateRecords.map((item) => record(item.kind, item.path, item.mode, item.size, item.oid, item.sha256)),
  ];
  return sha256(Buffer.concat(preimage));
}

export async function verifyCommittedInputs(options = {}) {
  const vendorRoot = resolve(options.vendorRoot ?? dirname(dirname(fileURLToPath(import.meta.url))));
  const repoRoot = resolve(options.repoRoot ?? resolve(vendorRoot, "../../../.."));
  const expectedVendorRoot = resolve(repoRoot, VENDOR_REL);
  if (vendorRoot !== expectedVendorRoot) throw new Error("vendorRoot does not match repository layout");
  assertGoldenAggregate();
  const explicitReviewedExportBinding = [
    "reviewedExportManifestPath",
    "reviewedTree",
    "reviewedExportManifestSha256",
  ].some((key) => Object.prototype.hasOwnProperty.call(options, key));
  const reviewedExportManifestPath = explicitReviewedExportBinding
    ? options.reviewedExportManifestPath
    : process.env.OPENCLAW_REVIEWED_EXPORT_MANIFEST;
  const reviewedTree = explicitReviewedExportBinding
    ? options.reviewedTree
    : process.env.OPENCLAW_REVIEWED_R_SHA;
  const reviewedExportManifestSha256 = explicitReviewedExportBinding
    ? options.reviewedExportManifestSha256
    : process.env.OPENCLAW_REVIEWED_EXPORT_MANIFEST_SHA256;
  const hasReviewedExportBinding =
    explicitReviewedExportBinding ||
    Boolean(reviewedExportManifestPath || reviewedTree || reviewedExportManifestSha256);
  if (hasReviewedExportBinding && !reviewedExportManifestPath) {
    throw new Error("reviewed export manifest path is required");
  }
  if (hasReviewedExportBinding && !reviewedTree) {
    throw new Error("reviewed export tree is required");
  }
  if (hasReviewedExportBinding && !reviewedExportManifestSha256) {
    throw new Error("reviewed export manifest SHA-256 is required");
  }
  const readRecords = reviewedExportManifestPath
    ? (paths) =>
        readReviewedExportRecords(
          repoRoot,
          reviewedExportManifestPath,
          reviewedTree,
          paths,
          reviewedExportManifestSha256,
        )
    : (paths) => readReviewedRecords(repoRoot, M_SHA, paths);
  const upstreamRecord = readRecords([UPSTREAM_REL])[0];
  const upstream = parseJsonStrict(upstreamRecord.bytes, "reviewed UPSTREAM.json");
  const paths = inventoryPaths(upstream);
  const records = readRecords(paths);
  verifyManifestBindings(records, upstream);
  const aggregateSha256 = computeMInputAggregate(records, upstream);
  if (aggregateSha256 !== EXPECTED_AGGREGATE || aggregateSha256 !== upstream.mInputAggregate.sha256) {
    throw new Error("M aggregate mismatch");
  }
  if (
    upstreamRecord.mode !== EXPECTED_UPSTREAM.mode ||
    upstreamRecord.size !== EXPECTED_UPSTREAM.size ||
    upstreamRecord.oid !== EXPECTED_UPSTREAM.oid ||
    upstreamRecord.sha256 !== EXPECTED_UPSTREAM.sha256
  ) {
    throw new Error("final UPSTREAM.json Git blob mismatch");
  }
  for (const item of upstream.sourceManifest) {
    const workingBytes = readFileSync(resolve(vendorRoot, item.outputPath));
    if (workingBytes.length !== item.size || sha256(workingBytes) !== item.sha256) {
      throw new Error(`working source snapshot changed: ${item.outputPath}`);
    }
  }
  return {
    aggregateSha256,
    inputCount: records.length,
    sourceBlobCount: upstream.sourceManifest.length,
    upstream,
    upstreamBlobOid: upstreamRecord.oid,
    upstreamSha256: upstreamRecord.sha256,
    ...(reviewedExportManifestPath
      ? {
          reviewedExportManifestSha256: sha256(readFileSync(reviewedExportManifestPath)),
          reviewedTree,
        }
      : {}),
  };
}

export async function verifyOnlineInputs(options = {}) {
  const vendorRoot = resolve(options.vendorRoot ?? dirname(dirname(fileURLToPath(import.meta.url))));
  const committed = await verifyCommittedInputs({ ...options, vendorRoot });
  const reacquired = await reacquireProvenanceInputs({
    vendorRoot,
    upstream: committed.upstream,
    fetchImpl: options.fetchImpl,
  });
  const tarball = await fetchTarballWithRedirects(
    committed.upstream.tarball.url,
    committed.upstream.tarball.lock.size,
    options.fetchImpl,
  );
  inspectTarball(tarball.bytes, committed.upstream);
  const provenanceByPath = reacquired.parsed;
  const sigstore = verifySigstoreAttestations({
    vendorRoot,
    upstream: committed.upstream,
    tarballBytes: tarball.bytes,
    metadata: provenanceByPath.get("upstream/provenance/npm-registry-metadata.json"),
    keys: provenanceByPath.get("upstream/provenance/npm-registry-keys.json"),
    attestations: provenanceByPath.get("upstream/provenance/npm-attestation-bundles.json"),
    trustRoot: provenanceByPath.get("upstream/provenance/sigstore-trusted-root.json"),
  });
  const source = await verifyExternalSourceMembership({
    upstream: committed.upstream,
    fetchImpl: options.fetchImpl,
  });
  const workRoot = resolve(vendorRoot, ".work");
  const outputPath = resolve(options.outputPath ?? resolve(workRoot, "verified-upstream.tgz"));
  const relativeOutput = relative(workRoot, outputPath).replaceAll("\\", "/");
  if (relativeOutput === ".." || relativeOutput.startsWith("../") || relativeOutput === "") {
    fail("verified tarball output escaped the vendor work directory");
  }
  mkdirSync(workRoot, { recursive: true });
  const temporaryPath = resolve(workRoot, `.verified-upstream-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(temporaryPath, tarball.bytes, { flag: "wx" });
    renameSync(temporaryPath, outputPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return {
    ...committed,
    finalTarballUrl: tarball.finalUrl,
    provenanceInputCount: reacquired.inputCount,
    sourceBlobCount: source.sourceBlobCount,
    sigstore,
    verifiedTarballPath: outputPath,
  };
}

function isMain() {
  return import.meta.url.startsWith("file:") &&
    process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

export function parseCliArguments(argv) {
  if (!Array.isArray(argv)) throw new TypeError("CLI arguments must be an array");
  const optionBindings = new Map([
    ["--reviewed-export-manifest", "reviewedExportManifestPath"],
    ["--reviewed-export-manifest-sha256", "reviewedExportManifestSha256"],
    ["--reviewed-tree", "reviewedTree"],
  ]);
  const seen = new Set();
  const options = {};
  let mode;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--online" || argument === "--offline") {
      if (seen.has(argument)) throw new Error(`duplicate CLI argument: ${argument}`);
      seen.add(argument);
      const candidateMode = argument.slice(2);
      if (mode && mode !== candidateMode) throw new Error("conflicting --online and --offline modes");
      mode = candidateMode;
      continue;
    }

    const optionName = optionBindings.get(argument);
    if (!optionName) throw new Error(`unknown CLI argument: ${argument}`);
    if (seen.has(argument)) throw new Error(`duplicate CLI argument: ${argument}`);
    seen.add(argument);
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    options[optionName] = value;
    index += 1;
  }

  if (!mode) throw new Error("exactly one of --online or --offline is required");
  const reviewedBindingCount = [...optionBindings.values()].filter((key) =>
    Object.prototype.hasOwnProperty.call(options, key),
  ).length;
  if (reviewedBindingCount !== 0 && reviewedBindingCount !== optionBindings.size) {
    throw new Error("all reviewed export arguments must be supplied together");
  }
  return { mode, options };
}

if (isMain()) {
  const cli = parseCliArguments(process.argv.slice(2));
  if (cli.mode === "offline") {
    const result = await verifyCommittedInputs(cli.options);
    process.stdout.write(`Verified ${result.inputCount} committed M inputs offline; this is non-qualifying.\n`);
  } else {
    const result = await verifyOnlineInputs(cli.options);
    process.stdout.write(
      `Verified ${result.inputCount} committed M inputs, ${result.provenanceInputCount} reacquired provenance inputs, ${result.sourceBlobCount} source blobs, and the signed upstream tarball online.\n`,
    );
  }
}
