import {
  constants as fsConstants,
  promises as nodeFs,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes as nodeRandomBytes,
} from "node:crypto";
import { TextDecoder } from "node:util";

const ENVELOPE_VERSION = 1;
const ALGORITHM_LABEL = "AES-256-GCM";
const NODE_ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const MAX_ENVELOPE_BYTES = 64 * 1024 * 1024;
const MAX_NONCE_ATTEMPTS = 32;
const AAD_DOMAIN = Buffer.from("ihome-openclaw-session-aad-v1\0", "utf8");

export type RandomBytes = (size: number) => Uint8Array;
export type PathEntry = {
  kind: "directory" | "file" | "missing" | "reparse" | "symlink";
};

export interface FileHandleOperations {
  writeFile(data: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface FileSystemOperations {
  mkdir(
    directoryPath: string,
    options?: { mode?: number; recursive?: boolean },
  ): Promise<void>;
  open(filePath: string, flags: number | string, mode?: number): Promise<FileHandleOperations>;
  rename(from: string, to: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  readFile(filePath: string): Promise<Buffer>;
  inspectPath(candidate: string): Promise<PathEntry>;
  realpath(candidate: string): Promise<string>;
}

export interface RootSafetyOperations {
  inspectPath(candidate: string): Promise<PathEntry>;
  isTmpfsRoot(candidate: string): Promise<boolean>;
  realpath(candidate: string): Promise<string>;
}

export interface SessionCryptoEngineOptions {
  activeGeneration: string;
  cellId: string;
  keys: ReadonlyMap<string, Uint8Array>;
  randomBytes?: RandomBytes;
}

export interface SessionCryptoStoreConfiguration extends SessionCryptoEngineOptions {
  persistentRoot: string;
  plaintextRoot: string;
}

export interface SessionCryptoStoreDependencies {
  fs?: FileSystemOperations;
  isTmpfsRoot?: (candidate: string) => Promise<boolean>;
  randomBytes?: RandomBytes;
}

export interface RootConfiguration {
  persistentRoot: string;
  plaintextRoot: string;
}

export interface EnvelopeMetadata {
  algorithm: typeof ALGORITHM_LABEL;
  ciphertextLength: number;
  generation: string;
  nonce: string;
  nonceLength: number;
  tag: string;
  tagLength: number;
  version: typeof ENVELOPE_VERSION;
}

export interface DecryptedSession extends EnvelopeMetadata {
  plaintext: Buffer;
}

interface ParsedEnvelope extends EnvelopeMetadata {
  ciphertextBytes: Buffer;
  nonceBytes: Buffer;
  tagBytes: Buffer;
}

interface CiphertextEnvelope {
  algorithm: typeof ALGORITHM_LABEL;
  ciphertext: string;
  keyGeneration: string;
  nonce: string;
  tag: string;
  version: typeof ENVELOPE_VERSION;
}

export class SessionCryptoError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SessionCryptoError";
  }
}

export class AmbiguousDurabilityError extends SessionCryptoError {
  constructor(message: string, options?: ErrorOptions) {
    super("AMBIGUOUS_DURABILITY", message, options);
    this.name = "AmbiguousDurabilityError";
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function normalizedComparisonPath(candidate: string): string {
  const normalized = path.normalize(path.resolve(candidate));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isSameOrDescendant(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function validateGeneration(generation: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(generation)) {
    throw new SessionCryptoError(
      "INVALID_KEY_GENERATION",
      "Key generation must be an explicit safe identifier",
    );
  }
  return generation;
}

function validateCellId(cellId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(cellId)) {
    throw new SessionCryptoError("INVALID_CELL_ID", "Cell ID must be a non-empty safe identifier");
  }
  return cellId;
}

export function normalizeLogicalSessionPath(logicalPath: string): string {
  if (logicalPath.length === 0 || logicalPath.includes("\0")) {
    throw new SessionCryptoError("INVALID_LOGICAL_PATH", "Logical session path is empty or contains NUL");
  }
  if (
    logicalPath.startsWith("/") ||
    logicalPath.startsWith("\\") ||
    /^[A-Za-z]:/.test(logicalPath) ||
    logicalPath.includes("\\")
  ) {
    throw new SessionCryptoError(
      "INVALID_LOGICAL_PATH",
      "Logical session path must be relative and use canonical slash separators",
    );
  }

  const segments = logicalPath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new SessionCryptoError(
      "INVALID_LOGICAL_PATH",
      "Logical session path contains an empty, dot, or traversal segment",
    );
  }
  const reservedWindowsName = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
  if (
    segments.some(
      (segment) =>
        Buffer.byteLength(segment, "utf8") > 255 ||
        /[<>:"|?*]/.test(segment) ||
        [...segment].some((character) => character.codePointAt(0)! < 0x20) ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        reservedWindowsName.test(segment),
    )
  ) {
    throw new SessionCryptoError(
      "INVALID_LOGICAL_PATH",
      "Logical session path contains a non-portable or alias-prone segment",
    );
  }
  return segments.join("/");
}

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function buildAdditionalAuthenticatedData(
  cellId: string,
  logicalPath: string,
  generation: string,
): Buffer {
  return Buffer.concat([
    AAD_DOMAIN,
    lengthPrefixed(String(ENVELOPE_VERSION)),
    lengthPrefixed(generation),
    lengthPrefixed(cellId),
    lengthPrefixed(logicalPath),
  ]);
}

function decodeCanonicalBase64(field: string, value: string, allowEmpty: boolean): Buffer {
  if ((!allowEmpty && value.length === 0) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new SessionCryptoError("MALFORMED_ENVELOPE", `${field} is not canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new SessionCryptoError("MALFORMED_ENVELOPE", `${field} is not canonical base64`);
  }
  return decoded;
}

function parseEnvelope(envelopeBytes: Uint8Array): ParsedEnvelope {
  const bytes = Buffer.from(envelopeBytes);
  if (bytes.length === 0 || bytes.length > MAX_ENVELOPE_BYTES) {
    throw new SessionCryptoError("MALFORMED_ENVELOPE", "Ciphertext envelope has an invalid length");
  }

  let parsed: unknown;
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(json) as unknown;
  } catch (error) {
    throw new SessionCryptoError("MALFORMED_ENVELOPE", "Ciphertext envelope is not valid UTF-8 JSON", {
      cause: error,
    });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SessionCryptoError("MALFORMED_ENVELOPE", "Ciphertext envelope must be an object");
  }

  const value = parsed as Record<string, unknown>;
  const expectedFields = ["algorithm", "ciphertext", "keyGeneration", "nonce", "tag", "version"];
  const actualFields = Object.keys(value).sort();
  if (actualFields.length !== expectedFields.length || actualFields.some((field, index) => field !== expectedFields[index])) {
    throw new SessionCryptoError("MALFORMED_ENVELOPE", "Ciphertext envelope fields are not exact");
  }
  if (value.version !== ENVELOPE_VERSION || value.algorithm !== ALGORITHM_LABEL) {
    throw new SessionCryptoError("MALFORMED_ENVELOPE", "Ciphertext envelope version or algorithm is unsupported");
  }
  if (
    typeof value.keyGeneration !== "string" ||
    typeof value.nonce !== "string" ||
    typeof value.tag !== "string" ||
    typeof value.ciphertext !== "string"
  ) {
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
    nonce: value.nonce,
    nonceBytes,
    nonceLength: nonceBytes.length,
    tag: value.tag,
    tagBytes,
    tagLength: tagBytes.length,
    version: ENVELOPE_VERSION,
  };
}

function publicMetadata(envelope: ParsedEnvelope): EnvelopeMetadata {
  return {
    algorithm: envelope.algorithm,
    ciphertextLength: envelope.ciphertextLength,
    generation: envelope.generation,
    nonce: envelope.nonce,
    nonceLength: envelope.nonceLength,
    tag: envelope.tag,
    tagLength: envelope.tagLength,
    version: envelope.version,
  };
}

export function inspectEnvelope(envelopeBytes: Uint8Array): EnvelopeMetadata {
  return publicMetadata(parseEnvelope(envelopeBytes));
}

export class SessionCryptoEngine {
  private readonly activeGeneration: string;
  private readonly cellId: string;
  private readonly keys = new Map<string, Buffer>();
  private readonly randomBytes: RandomBytes;
  private readonly usedNonces = new Set<string>();

  constructor(options: SessionCryptoEngineOptions) {
    this.cellId = validateCellId(options.cellId);
    this.activeGeneration = validateGeneration(options.activeGeneration);
    this.randomBytes = options.randomBytes ?? nodeRandomBytes;

    for (const [generationValue, keyValue] of options.keys) {
      const generation = validateGeneration(generationValue);
      const key = Buffer.from(keyValue);
      if (key.length !== KEY_LENGTH) {
        throw new SessionCryptoError(
          "INVALID_KEY_LENGTH",
          `AES-256-GCM key for generation ${generation} must be exactly 32 bytes`,
        );
      }
      this.keys.set(generation, key);
    }
    if (!this.keys.has(this.activeGeneration)) {
      throw new SessionCryptoError(
        "UNKNOWN_ACTIVE_GENERATION",
        "The active key generation is not present in the keyring",
      );
    }
  }

  private keyFor(generation: string): Buffer {
    const key = this.keys.get(generation);
    if (!key) {
      throw new SessionCryptoError(
        "UNKNOWN_KEY_GENERATION",
        `Ciphertext references unknown key generation ${generation}`,
      );
    }
    return key;
  }

  private nextNonce(forbiddenNonce?: string): Buffer {
    for (let attempt = 0; attempt < MAX_NONCE_ATTEMPTS; attempt += 1) {
      const nonce = Buffer.from(this.randomBytes(NONCE_LENGTH));
      if (nonce.length !== NONCE_LENGTH) {
        throw new SessionCryptoError("INVALID_RANDOMNESS", "Random source returned an invalid nonce length");
      }
      const encoded = nonce.toString("base64");
      if (!this.usedNonces.has(encoded) && encoded !== forbiddenNonce) {
        this.usedNonces.add(encoded);
        return nonce;
      }
    }
    throw new SessionCryptoError(
      "NONCE_EXHAUSTED",
      "Random source repeatedly returned an already-used AES-GCM nonce",
    );
  }

  encrypt(
    logicalPathValue: string,
    plaintext: Uint8Array,
    generationValue = this.activeGeneration,
    forbiddenNonce?: string,
  ): Buffer {
    const logicalPath = normalizeLogicalSessionPath(logicalPathValue);
    const generation = validateGeneration(generationValue);
    const key = this.keyFor(generation);
    const nonce = this.nextNonce(forbiddenNonce);
    const aad = buildAdditionalAuthenticatedData(this.cellId, logicalPath, generation);
    const cipher = createCipheriv(NODE_ALGORITHM, key, nonce, { authTagLength: TAG_LENGTH });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
    const tag = cipher.getAuthTag();
    const envelope: CiphertextEnvelope = {
      algorithm: ALGORITHM_LABEL,
      ciphertext: ciphertext.toString("base64"),
      keyGeneration: generation,
      nonce: nonce.toString("base64"),
      tag: tag.toString("base64"),
      version: ENVELOPE_VERSION,
    };
    return Buffer.from(JSON.stringify(envelope), "utf8");
  }

  decrypt(logicalPathValue: string, envelopeBytes: Uint8Array): DecryptedSession {
    const logicalPath = normalizeLogicalSessionPath(logicalPathValue);
    const envelope = parseEnvelope(envelopeBytes);
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
    } catch (error) {
      throw new SessionCryptoError(
        "AUTHENTICATION_FAILED",
        "Ciphertext authentication failed; plaintext fallback is forbidden",
        { cause: error },
      );
    }
  }

  rotate(logicalPath: string, envelopeBytes: Uint8Array, newGenerationValue: string): Buffer {
    const existing = parseEnvelope(envelopeBytes);
    const decrypted = this.decrypt(logicalPath, envelopeBytes);
    const newGeneration = validateGeneration(newGenerationValue);
    if (newGeneration === existing.generation) {
      throw new SessionCryptoError(
        "ROTATION_GENERATION_UNCHANGED",
        "Rotation requires a different explicit key generation",
      );
    }
    return this.encrypt(logicalPath, decrypted.plaintext, newGeneration, existing.nonce);
  }
}

function rootComponents(root: string): string[] {
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

async function assertDirectoryTreeIsSafe(
  root: string,
  inspectPath: (candidate: string) => Promise<PathEntry>,
): Promise<void> {
  const components = rootComponents(root);
  for (const component of components) {
    const entry = await inspectPath(component);
    if (entry.kind === "symlink" || entry.kind === "reparse") {
      throw new SessionCryptoError(
        "UNSAFE_ROOT_COMPONENT",
        `Configured root contains a ${entry.kind} component`,
      );
    }
    if (entry.kind !== "directory") {
      throw new SessionCryptoError(
        "INVALID_ROOT",
        "Configured roots and every parent component must already be directories",
      );
    }
  }
}

export async function assertSafeRootConfiguration(
  configuration: RootConfiguration,
  operations: RootSafetyOperations,
): Promise<RootConfiguration> {
  if (!path.isAbsolute(configuration.plaintextRoot) || !path.isAbsolute(configuration.persistentRoot)) {
    throw new SessionCryptoError("INVALID_ROOT", "Plaintext and persistent roots must be absolute paths");
  }
  const plaintextRoot = path.resolve(configuration.plaintextRoot);
  const persistentRoot = path.resolve(configuration.persistentRoot);
  if (
    isSameOrDescendant(plaintextRoot, persistentRoot) ||
    isSameOrDescendant(persistentRoot, plaintextRoot)
  ) {
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
  if (
    isSameOrDescendant(realPlaintextRoot, realPersistentRoot) ||
    isSameOrDescendant(realPersistentRoot, realPlaintextRoot)
  ) {
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

function resolveLogicalTarget(root: string, logicalPathValue: string): {
  logicalPath: string;
  targetPath: string;
} {
  const logicalPath = normalizeLogicalSessionPath(logicalPathValue);
  const targetPath = path.resolve(root, ...logicalPath.split("/"));
  if (!isSameOrDescendant(root, targetPath) || targetPath === root) {
    throw new SessionCryptoError("PATH_ESCAPE", "Logical path escapes its configured root");
  }
  return { logicalPath, targetPath };
}

async function assertTargetComponentsAreSafe(
  root: string,
  targetPath: string,
  inspectPath: (candidate: string) => Promise<PathEntry>,
): Promise<void> {
  const relative = path.relative(root, targetPath);
  const segments = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);
    const entry = await inspectPath(current);
    if (entry.kind === "symlink" || entry.kind === "reparse") {
      throw new SessionCryptoError(
        "UNSAFE_PATH_COMPONENT",
        `Logical session path contains a ${entry.kind} component`,
      );
    }
    if (index < segments.length - 1 && entry.kind === "file") {
      throw new SessionCryptoError(
        "UNSAFE_PATH_COMPONENT",
        "Logical session path contains a file where a directory is required",
      );
    }
  }
}

async function cleanupTemporaryFile(
  fs: FileSystemOperations,
  temporaryPath: string,
): Promise<unknown | undefined> {
  try {
    await fs.unlink(temporaryPath);
    return undefined;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    return error;
  }
}

export async function durableAtomicWrite(
  fs: FileSystemOperations,
  targetPath: string,
  bytes: Uint8Array,
  randomBytes: RandomBytes = nodeRandomBytes,
): Promise<void> {
  const directoryPath = path.dirname(targetPath);
  await fs.mkdir(directoryPath, { mode: 0o700, recursive: true });
  const suffix = Buffer.from(randomBytes(8));
  if (suffix.length !== 8) {
    throw new SessionCryptoError("INVALID_RANDOMNESS", "Random source returned an invalid temp suffix");
  }
  const temporaryPath = path.join(
    directoryPath,
    `.${path.basename(targetPath)}.tmp-${suffix.toString("hex")}`,
  );
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow;
  let handle: FileHandleOperations | undefined;
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
  } catch (error) {
    if (handle && !closed) {
      try {
        await handle.close();
      } catch {
        // Cleanup still proceeds and the original write failure remains primary.
      }
    }
    const cleanupError = temporaryCreated
      ? await cleanupTemporaryFile(fs, temporaryPath)
      : undefined;
    if (cleanupError) {
      throw new SessionCryptoError(
        "TEMP_CLEANUP_FAILED",
        "Persistent write failed before rename and temp cleanup also failed",
        { cause: new AggregateError([error, cleanupError]) },
      );
    }
    throw error;
  }

  let directoryHandle: FileHandleOperations | undefined;
  try {
    directoryHandle = await fs.open(directoryPath, "r");
    await directoryHandle.sync();
    await directoryHandle.close();
  } catch (error) {
    if (directoryHandle) {
      try {
        await directoryHandle.close();
      } catch {
        // The rename already happened, so every close failure is still ambiguous.
      }
    }
    throw new AmbiguousDurabilityError(
      "Atomic rename completed but directory durability could not be confirmed; explicit recovery is required",
      { cause: error },
    );
  }
}

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\(040|011|012|134)/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

async function defaultIsTmpfsRoot(candidate: string): Promise<boolean> {
  if (process.platform !== "linux") return false;
  let mountInfo: string;
  try {
    mountInfo = await nodeFs.readFile("/proc/self/mountinfo", "utf8");
  } catch {
    return false;
  }

  const normalizedCandidate = path.resolve(candidate);
  const mounts: Array<{ mountPoint: string; type: string }> = [];
  for (const line of mountInfo.split("\n")) {
    if (!line) continue;
    const separatorIndex = line.indexOf(" - ");
    if (separatorIndex < 0) continue;
    const before = line.slice(0, separatorIndex).split(" ");
    const after = line.slice(separatorIndex + 3).split(" ");
    const mountPoint = before[4];
    const type = after[0];
    if (!mountPoint || !type) continue;
    mounts.push({ mountPoint: path.resolve(decodeMountInfoPath(mountPoint)), type });
  }

  const containingMount = mounts
    .filter((mount) => isSameOrDescendant(mount.mountPoint, normalizedCandidate))
    .sort((left, right) => right.mountPoint.length - left.mountPoint.length)[0];
  return containingMount?.type === "tmpfs";
}

function wrapFileHandle(handle: FileHandle): FileHandleOperations {
  return {
    close: () => handle.close(),
    sync: () => handle.sync(),
    writeFile: (data) => handle.writeFile(data),
  };
}

const defaultFileSystem: FileSystemOperations = {
  async inspectPath(candidate) {
    try {
      const stats = await nodeFs.lstat(candidate);
      if (stats.isSymbolicLink()) return { kind: "symlink" };
      if (stats.isDirectory()) return { kind: "directory" };
      if (stats.isFile()) return { kind: "file" };
      return { kind: "reparse" };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return { kind: "missing" };
      throw error;
    }
  },
  mkdir: (directoryPath, options) => nodeFs.mkdir(directoryPath, options).then(() => undefined),
  open: async (filePath, flags, mode) => wrapFileHandle(await nodeFs.open(filePath, flags, mode)),
  readFile: (filePath) => nodeFs.readFile(filePath),
  realpath: (candidate) => nodeFs.realpath(candidate),
  rename: (from, to) => nodeFs.rename(from, to),
  unlink: (filePath) => nodeFs.unlink(filePath),
};

export class SessionCryptoStore {
  private constructor(
    private readonly engine: SessionCryptoEngine,
    private readonly fs: FileSystemOperations,
    private readonly plaintextRoot: string,
    private readonly persistentRoot: string,
    private readonly randomBytes: RandomBytes,
  ) {}

  static async create(
    configuration: SessionCryptoStoreConfiguration,
    dependencies: SessionCryptoStoreDependencies = {},
  ): Promise<SessionCryptoStore> {
    const fs = dependencies.fs ?? defaultFileSystem;
    const roots = await assertSafeRootConfiguration(
      {
        persistentRoot: configuration.persistentRoot,
        plaintextRoot: configuration.plaintextRoot,
      },
      {
        inspectPath: (candidate) => fs.inspectPath(candidate),
        isTmpfsRoot: dependencies.isTmpfsRoot ?? defaultIsTmpfsRoot,
        realpath: (candidate) => fs.realpath(candidate),
      },
    );
    const randomBytes = dependencies.randomBytes ?? configuration.randomBytes ?? nodeRandomBytes;
    const engine = new SessionCryptoEngine({
      activeGeneration: configuration.activeGeneration,
      cellId: configuration.cellId,
      keys: configuration.keys,
      randomBytes,
    });
    return new SessionCryptoStore(
      engine,
      fs,
      roots.plaintextRoot,
      roots.persistentRoot,
      randomBytes,
    );
  }

  private async readFromRoot(root: string, logicalPathValue: string): Promise<Buffer> {
    const { targetPath } = resolveLogicalTarget(root, logicalPathValue);
    await assertTargetComponentsAreSafe(root, targetPath, (candidate) => this.fs.inspectPath(candidate));
    return this.fs.readFile(targetPath);
  }

  private async writeToRoot(
    root: string,
    logicalPathValue: string,
    bytes: Uint8Array,
  ): Promise<void> {
    const { targetPath } = resolveLogicalTarget(root, logicalPathValue);
    await assertTargetComponentsAreSafe(root, targetPath, (candidate) => this.fs.inspectPath(candidate));
    await durableAtomicWrite(this.fs, targetPath, bytes, this.randomBytes);
  }

  async writeSession(logicalPathValue: string, plaintext: Uint8Array): Promise<EnvelopeMetadata> {
    const logicalPath = normalizeLogicalSessionPath(logicalPathValue);
    const envelope = this.engine.encrypt(logicalPath, plaintext);
    await this.writeToRoot(this.persistentRoot, logicalPath, envelope);
    return inspectEnvelope(envelope);
  }

  async persistFromPlaintext(logicalPathValue: string): Promise<EnvelopeMetadata> {
    const logicalPath = normalizeLogicalSessionPath(logicalPathValue);
    const plaintext = await this.readFromRoot(this.plaintextRoot, logicalPath);
    return this.writeSession(logicalPath, plaintext);
  }

  async readSession(logicalPathValue: string): Promise<DecryptedSession> {
    const logicalPath = normalizeLogicalSessionPath(logicalPathValue);
    const envelope = await this.readFromRoot(this.persistentRoot, logicalPath);
    return this.engine.decrypt(logicalPath, envelope);
  }

  async restoreToPlaintext(logicalPathValue: string): Promise<EnvelopeMetadata> {
    const logicalPath = normalizeLogicalSessionPath(logicalPathValue);
    const decrypted = await this.readSession(logicalPath);
    await this.writeToRoot(this.plaintextRoot, logicalPath, decrypted.plaintext);
    const { plaintext: _plaintext, ...metadata } = decrypted;
    return metadata;
  }

  async rotateSession(
    logicalPathValue: string,
    newGeneration: string,
  ): Promise<EnvelopeMetadata> {
    const logicalPath = normalizeLogicalSessionPath(logicalPathValue);
    const existing = await this.readFromRoot(this.persistentRoot, logicalPath);
    const rotated = this.engine.rotate(logicalPath, existing, newGeneration);
    await this.writeToRoot(this.persistentRoot, logicalPath, rotated);
    return inspectEnvelope(rotated);
  }
}
