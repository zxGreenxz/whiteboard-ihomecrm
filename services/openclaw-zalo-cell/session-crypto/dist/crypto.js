import { constants as fsConstants, promises as nodeFs, } from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes as nodeRandomBytes, } from "node:crypto";
import { TextDecoder } from "node:util";
const ENVELOPE_VERSION = 1;
const ALGORITHM_LABEL = "AES-256-GCM";
const NODE_ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
export const DEFAULT_MAX_ENVELOPE_BYTES = 64 * 1024 * 1024;
const MAX_NONCE_ATTEMPTS = 32;
const AAD_DOMAIN = Buffer.from("ihome-openclaw-session-aad-v1\0", "utf8");
const LINUX_O_DIRECTORY = fsConstants.O_DIRECTORY ?? 0x10000;
const LINUX_O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0x20000;
const DIRECTORY_OPEN_FLAGS = fsConstants.O_RDONLY | LINUX_O_DIRECTORY | LINUX_O_NOFOLLOW;
export class SessionCryptoError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.code = code;
        this.name = "SessionCryptoError";
    }
}
export class AmbiguousDurabilityError extends SessionCryptoError {
    constructor(message, options) {
        super("AMBIGUOUS_DURABILITY", message, options);
        this.name = "AmbiguousDurabilityError";
    }
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
function normalizedComparisonPath(candidate) {
    const normalized = path.normalize(path.resolve(candidate));
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function isSameOrDescendant(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function validateGeneration(generation) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(generation)) {
        throw new SessionCryptoError("INVALID_KEY_GENERATION", "Key generation must be an explicit safe identifier");
    }
    return generation;
}
function validateCellId(cellId) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(cellId)) {
        throw new SessionCryptoError("INVALID_CELL_ID", "Cell ID must be a non-empty safe identifier");
    }
    return cellId;
}
export function normalizeLogicalSessionPath(logicalPath) {
    if (logicalPath.length === 0 || logicalPath.includes("\0")) {
        throw new SessionCryptoError("INVALID_LOGICAL_PATH", "Logical session path is empty or contains NUL");
    }
    if (logicalPath.startsWith("/") ||
        logicalPath.startsWith("\\") ||
        /^[A-Za-z]:/.test(logicalPath) ||
        logicalPath.includes("\\")) {
        throw new SessionCryptoError("INVALID_LOGICAL_PATH", "Logical session path must be relative and use canonical slash separators");
    }
    const segments = logicalPath.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
        throw new SessionCryptoError("INVALID_LOGICAL_PATH", "Logical session path contains an empty, dot, or traversal segment");
    }
    const firstSegment = segments[0];
    if (firstSegment.startsWith(".openclaw-") ||
        firstSegment.startsWith(".session-crypto-writer.sqlite")) {
        throw new SessionCryptoError("INVALID_LOGICAL_PATH", "Logical session path collides with reserved crypto metadata");
    }
    const reservedWindowsName = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
    if (segments.some((segment) => Buffer.byteLength(segment, "utf8") > 255 ||
        /[<>:"|?*]/.test(segment) ||
        [...segment].some((character) => character.codePointAt(0) < 0x20) ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        reservedWindowsName.test(segment))) {
        throw new SessionCryptoError("INVALID_LOGICAL_PATH", "Logical session path contains a non-portable or alias-prone segment");
    }
    return segments.join("/");
}
function lengthPrefixed(value) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
}
function buildAdditionalAuthenticatedData(cellId, logicalPath, generation) {
    return Buffer.concat([
        AAD_DOMAIN,
        lengthPrefixed(String(ENVELOPE_VERSION)),
        lengthPrefixed(generation),
        lengthPrefixed(cellId),
        lengthPrefixed(logicalPath),
    ]);
}
function decodeCanonicalBase64(field, value, allowEmpty) {
    if ((!allowEmpty && value.length === 0) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw new SessionCryptoError("MALFORMED_ENVELOPE", `${field} is not canonical base64`);
    }
    const decoded = Buffer.from(value, "base64");
    if (decoded.toString("base64") !== value) {
        throw new SessionCryptoError("MALFORMED_ENVELOPE", `${field} is not canonical base64`);
    }
    return decoded;
}
function parseEnvelope(envelopeBytes, maxEnvelopeBytes = DEFAULT_MAX_ENVELOPE_BYTES) {
    const bytes = Buffer.from(envelopeBytes);
    if (bytes.length === 0 || bytes.length > maxEnvelopeBytes) {
        throw new SessionCryptoError("MALFORMED_ENVELOPE", "Ciphertext envelope has an invalid length");
    }
    let parsed;
    try {
        const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        parsed = JSON.parse(json);
    }
    catch (error) {
        throw new SessionCryptoError("MALFORMED_ENVELOPE", "Ciphertext envelope is not valid UTF-8 JSON", {
            cause: error,
        });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new SessionCryptoError("MALFORMED_ENVELOPE", "Ciphertext envelope must be an object");
    }
    const value = parsed;
    const expectedFields = ["algorithm", "ciphertext", "keyGeneration", "nonce", "tag", "version"];
    const actualFields = Object.keys(value).sort();
    if (actualFields.length !== expectedFields.length || actualFields.some((field, index) => field !== expectedFields[index])) {
        throw new SessionCryptoError("MALFORMED_ENVELOPE", "Ciphertext envelope fields are not exact");
    }
    if (value.version !== ENVELOPE_VERSION || value.algorithm !== ALGORITHM_LABEL) {
        throw new SessionCryptoError("MALFORMED_ENVELOPE", "Ciphertext envelope version or algorithm is unsupported");
    }
    if (typeof value.keyGeneration !== "string" ||
        typeof value.nonce !== "string" ||
        typeof value.tag !== "string" ||
        typeof value.ciphertext !== "string") {
        throw new SessionCryptoError("MALFORMED_ENVELOPE", "Ciphertext envelope fields have invalid types");
    }
    const generation = validateGeneration(value.keyGeneration);
    const nonceBytes = decodeCanonicalBase64("nonce", value.nonce, false);
    const tagBytes = decodeCanonicalBase64("tag", value.tag, false);
    const ciphertextBytes = decodeCanonicalBase64("ciphertext", value.ciphertext, true);
    if (nonceBytes.length !== NONCE_LENGTH) {
        throw new SessionCryptoError("MALFORMED_ENVELOPE", "AES-GCM nonce must be exactly 12 bytes");
    }
    if (tagBytes.length !== TAG_LENGTH) {
        throw new SessionCryptoError("MALFORMED_ENVELOPE", "AES-GCM authentication tag must be exactly 16 bytes");
    }
    return {
        algorithm: ALGORITHM_LABEL,
        ciphertextBytes,
        ciphertextLength: ciphertextBytes.length,
        generation,
        envelopeVersion: createHash("sha256").update(bytes).digest("hex"),
        nonce: value.nonce,
        nonceBytes,
        nonceLength: nonceBytes.length,
        tag: value.tag,
        tagBytes,
        tagLength: tagBytes.length,
        version: ENVELOPE_VERSION,
    };
}
function publicMetadata(envelope) {
    return {
        algorithm: envelope.algorithm,
        ciphertextLength: envelope.ciphertextLength,
        envelopeVersion: envelope.envelopeVersion,
        generation: envelope.generation,
        nonce: envelope.nonce,
        nonceLength: envelope.nonceLength,
        tag: envelope.tag,
        tagLength: envelope.tagLength,
        version: envelope.version,
    };
}
export function inspectEnvelope(envelopeBytes) {
    return publicMetadata(parseEnvelope(envelopeBytes));
}
export class SessionCryptoEngine {
    activeGeneration;
    cellId;
    keys = new Map();
    maxEnvelopeBytes;
    randomBytes;
    constructor(options) {
        this.cellId = validateCellId(options.cellId);
        this.activeGeneration = validateGeneration(options.activeGeneration);
        this.maxEnvelopeBytes = options.maxEnvelopeBytes ?? DEFAULT_MAX_ENVELOPE_BYTES;
        if (!Number.isSafeInteger(this.maxEnvelopeBytes) || this.maxEnvelopeBytes <= 0) {
            throw new SessionCryptoError("INVALID_ENVELOPE_LIMIT", "Ciphertext envelope limit must be a positive safe integer");
        }
        this.randomBytes = options.randomBytes ?? nodeRandomBytes;
        const keyFingerprints = new Set();
        for (const [generationValue, keyValue] of options.keys) {
            const generation = validateGeneration(generationValue);
            const key = Buffer.from(keyValue);
            if (key.length !== KEY_LENGTH) {
                throw new SessionCryptoError("INVALID_KEY_LENGTH", `AES-256-GCM key for generation ${generation} must be exactly 32 bytes`);
            }
            const fingerprint = key.toString("hex");
            if (keyFingerprints.has(fingerprint)) {
                throw new SessionCryptoError("DUPLICATE_KEY_BYTES", "Different key generations must not use duplicate key bytes");
            }
            keyFingerprints.add(fingerprint);
            this.keys.set(generation, key);
        }
        if (!this.keys.has(this.activeGeneration)) {
            throw new SessionCryptoError("UNKNOWN_ACTIVE_GENERATION", "The active key generation is not present in the keyring");
        }
    }
    keyFor(generation) {
        const key = this.keys.get(generation);
        if (!key) {
            throw new SessionCryptoError("UNKNOWN_KEY_GENERATION", `Ciphertext references unknown key generation ${generation}`);
        }
        return key;
    }
    nextNonce(forbiddenNonce) {
        for (let attempt = 0; attempt < MAX_NONCE_ATTEMPTS; attempt += 1) {
            const nonce = Buffer.from(this.randomBytes(NONCE_LENGTH));
            if (nonce.length !== NONCE_LENGTH) {
                throw new SessionCryptoError("INVALID_RANDOMNESS", "Random source returned an invalid nonce length");
            }
            const encoded = nonce.toString("base64");
            if (encoded !== forbiddenNonce)
                return nonce;
        }
        throw new SessionCryptoError("NONCE_EXHAUSTED", "Random source repeatedly returned a forbidden AES-GCM nonce");
    }
    getActiveGeneration() {
        return this.activeGeneration;
    }
    inspect(envelopeBytes) {
        return publicMetadata(parseEnvelope(envelopeBytes, this.maxEnvelopeBytes));
    }
    encryptWithNonce(logicalPathValue, plaintext, generationValue, nonceValue) {
        const nonce = Buffer.from(nonceValue);
        if (nonce.length !== NONCE_LENGTH) {
            throw new SessionCryptoError("INVALID_NONCE", "AES-GCM nonce must be exactly 12 bytes");
        }
        return this.encryptInternal(logicalPathValue, plaintext, generationValue, nonce);
    }
    encryptInternal(logicalPathValue, plaintext, generationValue, nonce) {
        const logicalPath = normalizeLogicalSessionPath(logicalPathValue);
        const generation = validateGeneration(generationValue);
        const key = this.keyFor(generation);
        const aad = buildAdditionalAuthenticatedData(this.cellId, logicalPath, generation);
        const cipher = createCipheriv(NODE_ALGORITHM, key, nonce, { authTagLength: TAG_LENGTH });
        cipher.setAAD(aad);
        const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
        const tag = cipher.getAuthTag();
        const envelope = {
            algorithm: ALGORITHM_LABEL,
            ciphertext: ciphertext.toString("base64"),
            keyGeneration: generation,
            nonce: nonce.toString("base64"),
            tag: tag.toString("base64"),
            version: ENVELOPE_VERSION,
        };
        const serialized = Buffer.from(JSON.stringify(envelope), "utf8");
        if (serialized.length > this.maxEnvelopeBytes) {
            throw new SessionCryptoError("ENVELOPE_TOO_LARGE", "Ciphertext envelope exceeds the configured reader limit");
        }
        return serialized;
    }
    encrypt(logicalPathValue, plaintext, generationValue = this.activeGeneration, forbiddenNonce) {
        const nonce = this.nextNonce(forbiddenNonce);
        return this.encryptInternal(logicalPathValue, plaintext, generationValue, nonce);
    }
    decrypt(logicalPathValue, envelopeBytes) {
        const logicalPath = normalizeLogicalSessionPath(logicalPathValue);
        const envelope = parseEnvelope(envelopeBytes, this.maxEnvelopeBytes);
        const key = this.keyFor(envelope.generation);
        const aad = buildAdditionalAuthenticatedData(this.cellId, logicalPath, envelope.generation);
        try {
            const decipher = createDecipheriv(NODE_ALGORITHM, key, envelope.nonceBytes, {
                authTagLength: TAG_LENGTH,
            });
            decipher.setAAD(aad);
            decipher.setAuthTag(envelope.tagBytes);
            const plaintext = Buffer.concat([
                decipher.update(envelope.ciphertextBytes),
                decipher.final(),
            ]);
            return { ...publicMetadata(envelope), plaintext };
        }
        catch (error) {
            throw new SessionCryptoError("AUTHENTICATION_FAILED", "Ciphertext authentication failed; plaintext fallback is forbidden", { cause: error });
        }
    }
    rotate(logicalPath, envelopeBytes, newGenerationValue) {
        const existing = parseEnvelope(envelopeBytes, this.maxEnvelopeBytes);
        const decrypted = this.decrypt(logicalPath, envelopeBytes);
        const newGeneration = validateGeneration(newGenerationValue);
        if (newGeneration === existing.generation) {
            throw new SessionCryptoError("ROTATION_GENERATION_UNCHANGED", "Rotation requires a different explicit key generation");
        }
        return this.encrypt(logicalPath, decrypted.plaintext, newGeneration, existing.nonce);
    }
    rotateToActiveWithNonce(logicalPath, envelopeBytes, nonce) {
        const existing = parseEnvelope(envelopeBytes, this.maxEnvelopeBytes);
        if (existing.generation === this.activeGeneration) {
            throw new SessionCryptoError("ROTATION_GENERATION_UNCHANGED", "Ciphertext already uses the configured active key generation");
        }
        const decrypted = this.decrypt(logicalPath, envelopeBytes);
        return this.encryptWithNonce(logicalPath, decrypted.plaintext, this.activeGeneration, nonce);
    }
}
function rootComponents(root) {
    const parsed = path.parse(root);
    const relative = path.relative(parsed.root, root);
    const components = [parsed.root];
    let current = parsed.root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        components.push(current);
    }
    return components;
}
async function assertDirectoryTreeIsSafe(root, inspectPath) {
    const components = rootComponents(root);
    for (const component of components) {
        const entry = await inspectPath(component);
        if (entry.kind === "symlink" || entry.kind === "reparse") {
            throw new SessionCryptoError("UNSAFE_ROOT_COMPONENT", `Configured root contains a ${entry.kind} component`);
        }
        if (entry.kind !== "directory") {
            throw new SessionCryptoError("INVALID_ROOT", "Configured roots and every parent component must already be directories");
        }
    }
}
export async function assertSafeRootConfiguration(configuration, operations) {
    if (!path.isAbsolute(configuration.plaintextRoot) || !path.isAbsolute(configuration.persistentRoot)) {
        throw new SessionCryptoError("INVALID_ROOT", "Plaintext and persistent roots must be absolute paths");
    }
    const plaintextRoot = path.resolve(configuration.plaintextRoot);
    const persistentRoot = path.resolve(configuration.persistentRoot);
    if (isSameOrDescendant(plaintextRoot, persistentRoot) ||
        isSameOrDescendant(persistentRoot, plaintextRoot)) {
        throw new SessionCryptoError("ROOT_OVERLAP", "Plaintext and persistent roots must not overlap");
    }
    await assertDirectoryTreeIsSafe(plaintextRoot, operations.inspectPath);
    await assertDirectoryTreeIsSafe(persistentRoot, operations.inspectPath);
    const realPlaintextRoot = path.resolve(await operations.realpath(plaintextRoot));
    const realPersistentRoot = path.resolve(await operations.realpath(persistentRoot));
    if (normalizedComparisonPath(realPlaintextRoot) !== normalizedComparisonPath(plaintextRoot)) {
        throw new SessionCryptoError("ROOT_ALIAS", "Plaintext root resolves through an alias");
    }
    if (normalizedComparisonPath(realPersistentRoot) !== normalizedComparisonPath(persistentRoot)) {
        throw new SessionCryptoError("ROOT_ALIAS", "Persistent root resolves through an alias");
    }
    if (isSameOrDescendant(realPlaintextRoot, realPersistentRoot) ||
        isSameOrDescendant(realPersistentRoot, realPlaintextRoot)) {
        throw new SessionCryptoError("ROOT_ALIAS", "Plaintext and persistent roots alias or overlap");
    }
    if (!(await operations.isTmpfsRoot(realPlaintextRoot))) {
        throw new SessionCryptoError("PLAINTEXT_NOT_TMPFS", "Plaintext root is not verified tmpfs");
    }
    if (await operations.isTmpfsRoot(realPersistentRoot)) {
        throw new SessionCryptoError("PERSISTENT_IS_TMPFS", "Persistent ciphertext root must not be tmpfs");
    }
    return { persistentRoot: realPersistentRoot, plaintextRoot: realPlaintextRoot };
}
async function cleanupTemporaryFile(fs, parentHandle, temporaryName) {
    try {
        await fs.unlink(parentHandle.descriptorPath(temporaryName));
        return undefined;
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT")
            return undefined;
        return error;
    }
}
export async function durableAtomicWrite(fs, parentHandle, targetName, bytes, randomBytes = nodeRandomBytes) {
    if (targetName.length === 0 ||
        targetName === "." ||
        targetName === ".." ||
        targetName.includes("/") ||
        targetName.includes("\\")) {
        throw new SessionCryptoError("INVALID_LOGICAL_PATH", "Atomic write target must be one safe leaf name");
    }
    const suffix = Buffer.from(randomBytes(8));
    if (suffix.length !== 8) {
        throw new SessionCryptoError("INVALID_RANDOMNESS", "Random source returned an invalid temp suffix");
    }
    const temporaryName = `.${targetName}.tmp-${suffix.toString("hex")}`;
    const temporaryPath = parentHandle.descriptorPath(temporaryName);
    const targetPath = parentHandle.descriptorPath(targetName);
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | LINUX_O_NOFOLLOW;
    let handle;
    let temporaryCreated = false;
    let closed = false;
    try {
        handle = await fs.open(temporaryPath, flags, 0o600);
        temporaryCreated = true;
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.close();
        closed = true;
        await fs.rename(temporaryPath, targetPath);
        temporaryCreated = false;
    }
    catch (error) {
        if (handle && !closed) {
            try {
                await handle.close();
            }
            catch {
                // Cleanup still proceeds and the original write failure remains primary.
            }
        }
        const cleanupError = temporaryCreated
            ? await cleanupTemporaryFile(fs, parentHandle, temporaryName)
            : undefined;
        if (cleanupError) {
            throw new SessionCryptoError("TEMP_CLEANUP_FAILED", "Persistent write failed before rename and temp cleanup also failed", { cause: new AggregateError([error, cleanupError]) });
        }
        throw error;
    }
    try {
        await parentHandle.sync();
    }
    catch (error) {
        throw new AmbiguousDurabilityError("Atomic rename completed but directory durability could not be confirmed; explicit recovery is required", { cause: error });
    }
}
function decodeMountInfoPath(value) {
    return value.replace(/\\(040|011|012|134)/g, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}
async function defaultIsTmpfsRoot(candidate) {
    if (process.platform !== "linux")
        return false;
    let mountInfo;
    try {
        mountInfo = await nodeFs.readFile("/proc/self/mountinfo", "utf8");
    }
    catch {
        return false;
    }
    let normalizedCandidate;
    try {
        normalizedCandidate = path.resolve(await nodeFs.realpath(candidate));
    }
    catch {
        return false;
    }
    const mounts = [];
    for (const line of mountInfo.split("\n")) {
        if (!line)
            continue;
        const separatorIndex = line.indexOf(" - ");
        if (separatorIndex < 0)
            continue;
        const before = line.slice(0, separatorIndex).split(" ");
        const after = line.slice(separatorIndex + 3).split(" ");
        const mountPoint = before[4];
        const type = after[0];
        if (!mountPoint || !type)
            continue;
        mounts.push({ mountPoint: path.resolve(decodeMountInfoPath(mountPoint)), type });
    }
    const containingMount = mounts
        .filter((mount) => isSameOrDescendant(mount.mountPoint, normalizedCandidate))
        .sort((left, right) => right.mountPoint.length - left.mountPoint.length)[0];
    return containingMount?.type === "tmpfs";
}
function wrapFileHandle(handle) {
    return {
        close: () => handle.close(),
        descriptorPath(relativePath = "") {
            const descriptorRoot = `/proc/self/fd/${handle.fd}`;
            return relativePath
                ? path.posix.join(descriptorRoot, ...relativePath.split("/"))
                : descriptorRoot;
        },
        readFile: () => handle.readFile(),
        async stat() {
            const stats = await handle.stat();
            return {
                dev: stats.dev,
                ino: stats.ino,
                kind: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "reparse",
                mode: stats.mode & 0o777,
                uid: stats.uid,
            };
        },
        sync: () => handle.sync(),
        writeFile: (data) => handle.writeFile(data),
    };
}
const defaultFileSystem = {
    async inspectPath(candidate) {
        try {
            const stats = await nodeFs.lstat(candidate);
            if (stats.isSymbolicLink())
                return { kind: "symlink" };
            if (stats.isDirectory()) {
                return {
                    dev: stats.dev,
                    ino: stats.ino,
                    kind: "directory",
                    mode: stats.mode & 0o777,
                    uid: stats.uid,
                };
            }
            if (stats.isFile()) {
                return {
                    dev: stats.dev,
                    ino: stats.ino,
                    kind: "file",
                    mode: stats.mode & 0o777,
                    uid: stats.uid,
                };
            }
            return { kind: "reparse" };
        }
        catch (error) {
            if (isNodeError(error) && error.code === "ENOENT")
                return { kind: "missing" };
            throw error;
        }
    },
    open: async (filePath, flags, mode) => wrapFileHandle(await nodeFs.open(filePath, flags, mode)),
    realpath: (candidate) => nodeFs.realpath(candidate),
    rename: (from, to) => nodeFs.rename(from, to),
    unlink: (filePath) => nodeFs.unlink(filePath),
};
function validateExpectedEnvelopeVersion(value) {
    if (value !== null && !/^[0-9a-f]{64}$/.test(value)) {
        throw new SessionCryptoError("INVALID_EXPECTED_ENVELOPE_VERSION", "Expected envelope version must be null or a lowercase SHA-256 digest");
    }
}
function assertExpectedEnvelope(expected, current) {
    validateExpectedEnvelopeVersion(expected);
    if (expected === null ? current !== null : current?.metadata.envelopeVersion !== expected) {
        throw new SessionCryptoError("ENVELOPE_CONFLICT", "Ciphertext changed since the caller observed it");
    }
}
async function reserveUniqueNonce(fs, persistentRootHandle, generation, randomBytes, forbiddenNonce) {
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | LINUX_O_NOFOLLOW;
    for (let attempt = 0; attempt < MAX_NONCE_ATTEMPTS; attempt += 1) {
        const nonce = Buffer.from(randomBytes(NONCE_LENGTH));
        if (nonce.length !== NONCE_LENGTH) {
            throw new SessionCryptoError("INVALID_RANDOMNESS", "Random source returned an invalid nonce length");
        }
        const encoded = nonce.toString("base64");
        if (encoded === forbiddenNonce)
            continue;
        const reservationPath = persistentRootHandle.descriptorPath(`.openclaw-nonce-v1-${generation}-${nonce.toString("hex")}.reserve`);
        let handle;
        try {
            handle = await fs.open(reservationPath, flags, 0o600);
        }
        catch (error) {
            if (isNodeError(error) && error.code === "EEXIST")
                continue;
            throw new SessionCryptoError("NONCE_RESERVATION_FAILED", "Unable to create a durable AES-GCM nonce reservation", { cause: error });
        }
        try {
            await handle.writeFile(Buffer.from(`openclaw-nonce-reservation-v1\n${generation}\n${encoded}\n`, "utf8"));
            await handle.sync();
            await handle.close();
            try {
                await persistentRootHandle.sync();
            }
            catch (error) {
                throw new AmbiguousDurabilityError("Directory durability could not be confirmed; explicit recovery is required", { cause: error });
            }
            return nonce;
        }
        catch (error) {
            try {
                await handle.close();
            }
            catch {
                // The reservation is deliberately retained to burn this nonce.
            }
            if (error instanceof AmbiguousDurabilityError)
                throw error;
            throw new SessionCryptoError("NONCE_RESERVATION_FAILED", "AES-GCM nonce reservation could not be durably recorded", { cause: error });
        }
    }
    throw new SessionCryptoError("NONCE_EXHAUSTED", "Unable to reserve a unique AES-GCM nonce after repeated collisions");
}
function sameFileIdentity(left, right) {
    if (left.dev === undefined ||
        left.ino === undefined ||
        right.dev === undefined ||
        right.ino === undefined) {
        return false;
    }
    return left.dev === right.dev && left.ino === right.ino;
}
function assertOwnedPrivateDirectory(entry, expectedOwnerUid) {
    if (entry.kind !== "directory") {
        throw new SessionCryptoError("UNSAFE_PATH_COMPONENT", `Logical session path contains a ${entry.kind} where a directory is required`);
    }
    if (entry.uid !== undefined && entry.uid !== expectedOwnerUid) {
        throw new SessionCryptoError("UNSAFE_DIRECTORY_OWNER", "Session parent directory has an unexpected owner");
    }
    if (entry.mode !== undefined && (entry.mode & 0o077) !== 0) {
        throw new SessionCryptoError("UNSAFE_DIRECTORY_MODE", "Session parent directory mode exposes data outside the service owner");
    }
}
async function openVerifiedRootDirectory(fs, root, expectedOwnerUid) {
    const checked = await fs.inspectPath(root);
    let handle;
    try {
        handle = await fs.open(root, DIRECTORY_OPEN_FLAGS);
        const descriptorEntry = await handle.stat();
        const rechecked = await fs.inspectPath(root);
        const descriptorRealPath = path.resolve(await fs.realpath(handle.descriptorPath()));
        if (descriptorEntry.kind !== "directory") {
            throw new SessionCryptoError("UNSAFE_ROOT_COMPONENT", "Configured session root is not a directory");
        }
        if (descriptorEntry.uid !== undefined && descriptorEntry.uid !== expectedOwnerUid) {
            throw new SessionCryptoError("UNSAFE_ROOT_OWNER", "Configured session root has an unexpected owner");
        }
        if (descriptorEntry.mode !== undefined && (descriptorEntry.mode & 0o077) !== 0) {
            throw new SessionCryptoError("UNSAFE_ROOT_MODE", "Configured session root mode exposes data outside the service owner");
        }
        if (checked.kind !== "directory" ||
            rechecked.kind !== "directory" ||
            !sameFileIdentity(checked, descriptorEntry) ||
            !sameFileIdentity(rechecked, descriptorEntry) ||
            normalizedComparisonPath(descriptorRealPath) !== normalizedComparisonPath(root)) {
            throw new SessionCryptoError("UNSAFE_ROOT_COMPONENT", "Configured session root changed while its directory descriptor was opened");
        }
        return handle;
    }
    catch (error) {
        if (handle) {
            try {
                await handle.close();
            }
            catch {
                // The root validation failure remains authoritative.
            }
        }
        if (isNodeError(error) && ["ELOOP", "ENOTDIR"].includes(String(error.code))) {
            throw new SessionCryptoError("UNSAFE_ROOT_COMPONENT", "Configured session root changed to an unsafe path component", { cause: error });
        }
        throw error;
    }
}
async function openSessionParent(fs, rootHandle, logicalPathValue, expectedOwnerUid) {
    const segments = normalizeLogicalSessionPath(logicalPathValue).split("/");
    const leafName = segments.pop();
    let current = rootHandle;
    let currentOwned = false;
    try {
        for (const segment of segments) {
            let child;
            const childPath = current.descriptorPath(segment);
            try {
                child = await fs.open(childPath, DIRECTORY_OPEN_FLAGS);
            }
            catch (error) {
                if (isNodeError(error) && error.code === "ENOENT") {
                    throw new SessionCryptoError("PARENT_DIRECTORY_MISSING", "Every parent of a session file must be a pre-existing directory", { cause: error });
                }
                if (isNodeError(error) && ["ELOOP", "ENOTDIR"].includes(String(error.code))) {
                    const entry = await fs.inspectPath(childPath).catch(() => undefined);
                    const kind = entry?.kind === "symlink" || entry?.kind === "reparse"
                        ? entry.kind
                        : "unsafe parent";
                    throw new SessionCryptoError("UNSAFE_PATH_COMPONENT", `Logical session path contains a ${kind} component`, { cause: error });
                }
                throw error;
            }
            try {
                assertOwnedPrivateDirectory(await child.stat(), expectedOwnerUid);
            }
            catch (error) {
                await child.close().catch(() => undefined);
                throw error;
            }
            if (currentOwned)
                await current.close();
            current = child;
            currentOwned = true;
        }
        return {
            handle: current,
            leafName,
            release: currentOwned ? () => current.close() : async () => undefined,
        };
    }
    catch (error) {
        if (currentOwned)
            await current.close().catch(() => undefined);
        throw error;
    }
}
async function readLeafFromParent(fs, parent, leafName) {
    let handle;
    try {
        handle = await fs.open(parent.descriptorPath(leafName), fsConstants.O_RDONLY | LINUX_O_NOFOLLOW);
    }
    catch (error) {
        if (isNodeError(error) && ["ELOOP", "ENOTDIR"].includes(String(error.code))) {
            throw new SessionCryptoError("UNSAFE_PATH_COMPONENT", "Logical session leaf changed to an unsafe path component", { cause: error });
        }
        throw error;
    }
    let operationError;
    let bytes = Buffer.alloc(0);
    try {
        const entry = await handle.stat();
        if (entry.kind !== "file") {
            throw new SessionCryptoError("UNSAFE_PATH_COMPONENT", "Logical session leaf must be a regular file");
        }
        bytes = await handle.readFile();
    }
    catch (error) {
        operationError = error;
    }
    try {
        await handle.close();
    }
    catch (error) {
        if (!operationError)
            operationError = error;
    }
    if (operationError)
        throw operationError;
    return bytes;
}
export class SessionCryptoStore {
    engine;
    fs;
    plaintextRootHandle;
    persistentRootHandle;
    randomBytes;
    expectedOwnerUid;
    pathLocks = new Map();
    constructor(engine, fs, plaintextRootHandle, persistentRootHandle, randomBytes, expectedOwnerUid) {
        this.engine = engine;
        this.fs = fs;
        this.plaintextRootHandle = plaintextRootHandle;
        this.persistentRootHandle = persistentRootHandle;
        this.randomBytes = randomBytes;
        this.expectedOwnerUid = expectedOwnerUid;
    }
    static async create(configuration, dependencies = {}) {
        const platform = dependencies.platform ?? process.platform;
        if (platform !== "linux") {
            throw new SessionCryptoError("UNSUPPORTED_PLATFORM", "Session crypto runtime is supported only on Linux");
        }
        const fs = dependencies.fs ?? defaultFileSystem;
        const roots = await assertSafeRootConfiguration({
            persistentRoot: configuration.persistentRoot,
            plaintextRoot: configuration.plaintextRoot,
        }, {
            inspectPath: (candidate) => fs.inspectPath(candidate),
            isTmpfsRoot: dependencies.isTmpfsRoot ?? defaultIsTmpfsRoot,
            realpath: (candidate) => fs.realpath(candidate),
        });
        const randomBytes = dependencies.randomBytes ?? configuration.randomBytes ?? nodeRandomBytes;
        const expectedOwnerUid = dependencies.expectedOwnerUid ??
            (typeof process.getuid === "function" ? process.getuid() : 0);
        for (const root of [roots.plaintextRoot, roots.persistentRoot]) {
            const entry = await fs.inspectPath(root);
            if (entry.uid !== undefined && entry.uid !== expectedOwnerUid) {
                throw new SessionCryptoError("UNSAFE_ROOT_OWNER", "Configured session root has an unexpected owner");
            }
            if (entry.mode !== undefined && (entry.mode & 0o077) !== 0) {
                throw new SessionCryptoError("UNSAFE_ROOT_MODE", "Configured session root mode exposes data outside the service owner");
            }
        }
        const engineOptions = {
            activeGeneration: configuration.activeGeneration,
            cellId: configuration.cellId,
            keys: configuration.keys,
            randomBytes,
        };
        if (configuration.maxEnvelopeBytes !== undefined) {
            engineOptions.maxEnvelopeBytes = configuration.maxEnvelopeBytes;
        }
        const engine = new SessionCryptoEngine(engineOptions);
        let plaintextRootHandle;
        let persistentRootHandle;
        try {
            plaintextRootHandle = await openVerifiedRootDirectory(fs, roots.plaintextRoot, expectedOwnerUid);
            persistentRootHandle = await openVerifiedRootDirectory(fs, roots.persistentRoot, expectedOwnerUid);
        }
        catch (error) {
            await persistentRootHandle?.close().catch(() => undefined);
            await plaintextRootHandle?.close().catch(() => undefined);
            throw error;
        }
        return new SessionCryptoStore(engine, fs, plaintextRootHandle, persistentRootHandle, randomBytes, expectedOwnerUid);
    }
    async serializePath(logicalPath, operation) {
        const previous = this.pathLocks.get(logicalPath) ?? Promise.resolve();
        let release = () => undefined;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const tail = previous.then(() => gate);
        this.pathLocks.set(logicalPath, tail);
        await previous;
        try {
            return await operation();
        }
        finally {
            release();
            if (this.pathLocks.get(logicalPath) === tail)
                this.pathLocks.delete(logicalPath);
        }
    }
    async readFromRoot(rootHandle, logicalPathValue) {
        const parent = await openSessionParent(this.fs, rootHandle, logicalPathValue, this.expectedOwnerUid);
        try {
            return await readLeafFromParent(this.fs, parent.handle, parent.leafName);
        }
        finally {
            await parent.release();
        }
    }
    async readCurrentEnvelope(logicalPath) {
        try {
            const bytes = await this.readFromRoot(this.persistentRootHandle, logicalPath);
            return { bytes, metadata: this.engine.inspect(bytes) };
        }
        catch (error) {
            if (isNodeError(error) && error.code === "ENOENT")
                return null;
            throw error;
        }
    }
    async writeToRoot(rootHandle, logicalPathValue, bytes) {
        const parent = await openSessionParent(this.fs, rootHandle, logicalPathValue, this.expectedOwnerUid);
        try {
            await durableAtomicWrite(this.fs, parent.handle, parent.leafName, bytes, this.randomBytes);
        }
        finally {
            await parent.release();
        }
    }
    async writeSessionUnlocked(logicalPath, plaintext, expectedEnvelopeVersion) {
        const current = await this.readCurrentEnvelope(logicalPath);
        assertExpectedEnvelope(expectedEnvelopeVersion, current);
        const nonce = await reserveUniqueNonce(this.fs, this.persistentRootHandle, this.engine.getActiveGeneration(), this.randomBytes, current?.metadata.nonce);
        const envelope = this.engine.encryptWithNonce(logicalPath, plaintext, this.engine.getActiveGeneration(), nonce);
        await this.writeToRoot(this.persistentRootHandle, logicalPath, envelope);
        return this.engine.inspect(envelope);
    }
    async writeSession(logicalPathValue, plaintext, expectedEnvelopeVersion) {
        const logicalPath = normalizeLogicalSessionPath(logicalPathValue);
        return this.serializePath(logicalPath, () => this.writeSessionUnlocked(logicalPath, plaintext, expectedEnvelopeVersion));
    }
    async persistFromPlaintext(logicalPathValue, expectedEnvelopeVersion) {
        const logicalPath = normalizeLogicalSessionPath(logicalPathValue);
        return this.serializePath(logicalPath, async () => {
            const plaintext = await this.readFromRoot(this.plaintextRootHandle, logicalPath);
            return this.writeSessionUnlocked(logicalPath, plaintext, expectedEnvelopeVersion);
        });
    }
    async readSession(logicalPathValue) {
        const logicalPath = normalizeLogicalSessionPath(logicalPathValue);
        return this.serializePath(logicalPath, async () => {
            const current = await this.readCurrentEnvelope(logicalPath);
            if (!current) {
                throw new SessionCryptoError("CIPHERTEXT_MISSING", "Ciphertext session file is missing");
            }
            return this.engine.decrypt(logicalPath, current.bytes);
        });
    }
    async restoreToPlaintext(logicalPathValue, expectedEnvelopeVersion) {
        const logicalPath = normalizeLogicalSessionPath(logicalPathValue);
        return this.serializePath(logicalPath, async () => {
            const current = await this.readCurrentEnvelope(logicalPath);
            assertExpectedEnvelope(expectedEnvelopeVersion, current);
            if (!current) {
                throw new SessionCryptoError("CIPHERTEXT_MISSING", "Ciphertext session file is missing");
            }
            const decrypted = this.engine.decrypt(logicalPath, current.bytes);
            await this.writeToRoot(this.plaintextRootHandle, logicalPath, decrypted.plaintext);
            const { plaintext: _plaintext, ...metadata } = decrypted;
            return metadata;
        });
    }
    async rotateSession(logicalPathValue, expectedEnvelopeVersion) {
        const logicalPath = normalizeLogicalSessionPath(logicalPathValue);
        return this.serializePath(logicalPath, async () => {
            const current = await this.readCurrentEnvelope(logicalPath);
            assertExpectedEnvelope(expectedEnvelopeVersion, current);
            if (!current) {
                throw new SessionCryptoError("CIPHERTEXT_MISSING", "Ciphertext session file is missing");
            }
            if (current.metadata.generation === this.engine.getActiveGeneration()) {
                throw new SessionCryptoError("ROTATION_GENERATION_UNCHANGED", "Ciphertext already uses the configured active key generation");
            }
            const nonce = await reserveUniqueNonce(this.fs, this.persistentRootHandle, this.engine.getActiveGeneration(), this.randomBytes, current.metadata.nonce);
            const rotated = this.engine.rotateToActiveWithNonce(logicalPath, current.bytes, nonce);
            await this.writeToRoot(this.persistentRootHandle, logicalPath, rotated);
            return this.engine.inspect(rotated);
        });
    }
}
