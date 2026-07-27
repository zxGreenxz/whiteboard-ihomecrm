#!/usr/bin/env node

import { constants as fsConstants, promises as nodeFs } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

import {
  SessionCryptoError,
  SessionCryptoStore,
  normalizeLogicalSessionPath,
  type EnvelopeMetadata,
  type ExpectedEnvelopeVersion,
  type SessionCryptoStoreConfiguration,
  type SessionCryptoStoreDependencies,
} from "./crypto.js";

export const RUNTIME_PROTOCOL_VERSION = 1;
export const SESSION_KEY_PATH = "/run/secrets/openclaw_session_key";

const MAX_KEY_FILE_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const LINUX_O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0x20000;
const ENVELOPE_VERSION_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const SAFE_GENERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface StartupConfiguration {
  cellId: string;
  persistentRoot: string;
  plaintextRoot: string;
}

export interface RuntimeKeyring {
  activeGeneration: string;
  keys: ReadonlyMap<string, Uint8Array>;
}

export interface KeyFileStat {
  kind: "file" | "other" | "symlink";
  mode: number;
  uid: number;
}

export interface KeyFileOperations {
  getuid(): number;
  open(candidate: string, flags: number): Promise<KeyFileHandle>;
}

export interface KeyFileHandle {
  close(): Promise<void>;
  readFile(): Promise<Buffer>;
  stat(): Promise<KeyFileStat>;
}

export type RuntimeRequest = {
  expectedEnvelopeVersion: ExpectedEnvelopeVersion;
  id: string;
  operation: "persist" | "restore" | "rotate";
  path: string;
  version: typeof RUNTIME_PROTOCOL_VERSION;
};

export interface RuntimeSuccessResponse {
  id: string;
  ok: true;
  result: {
    envelopeVersion: string;
    generation: string;
    operation: RuntimeRequest["operation"];
    path: string;
  };
  version: typeof RUNTIME_PROTOCOL_VERSION;
}

export interface RuntimeErrorResponse {
  error: {
    code: string;
    fatal: boolean;
    message: string;
  };
  id: string | null;
  ok: false;
  version: typeof RUNTIME_PROTOCOL_VERSION;
}

export type RuntimeResponse = RuntimeSuccessResponse | RuntimeErrorResponse;

export interface SessionCryptoOperations {
  persistFromPlaintext(
    logicalPath: string,
    expectedEnvelopeVersion: ExpectedEnvelopeVersion,
  ): Promise<EnvelopeMetadata>;
  restoreToPlaintext(
    logicalPath: string,
    expectedEnvelopeVersion: string,
  ): Promise<EnvelopeMetadata>;
  rotateSession(
    logicalPath: string,
    expectedEnvelopeVersion: string,
  ): Promise<EnvelopeMetadata>;
}

export interface StdioDaemonOptions {
  daemon: SessionCryptoDaemon;
  lines: AsyncIterable<string | Uint8Array>;
  writeLine(line: string): Promise<void>;
}

export interface RuntimeProcessOptions {
  argv: readonly string[];
  createStore?: (
    configuration: SessionCryptoStoreConfiguration,
    dependencies: SessionCryptoStoreDependencies,
  ) => Promise<SessionCryptoOperations>;
  keyFileOperations?: KeyFileOperations;
  lines: AsyncIterable<string | Uint8Array>;
  platform?: NodeJS.Platform;
  storeDependencies?: SessionCryptoStoreDependencies;
  writeLine(line: string): Promise<void>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function invalidRequest(): never {
  throw new SessionCryptoError(
    "INVALID_REQUEST",
    "Request does not match the exact versioned request schema",
  );
}

function decodeCanonicalKey(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new SessionCryptoError("KEY_FILE_FORMAT", "Runtime key file is invalid");
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) {
    throw new SessionCryptoError("KEY_FILE_FORMAT", "Runtime key file is invalid");
  }
  return key;
}

const defaultKeyFileOperations: KeyFileOperations = {
  getuid() {
    if (typeof process.getuid !== "function") {
      throw new SessionCryptoError("UNSUPPORTED_PLATFORM", "Runtime is supported only on Linux");
    }
    return process.getuid();
  },
  async open(candidate, flags) {
    const handle = await nodeFs.open(candidate, flags);
    return {
      close: () => handle.close(),
      readFile: () => handle.readFile(),
      async stat() {
        const stats = await handle.stat();
        return {
          kind: stats.isSymbolicLink() ? "symlink" : stats.isFile() ? "file" : "other",
          mode: stats.mode & 0o777,
          uid: stats.uid,
        };
      },
    };
  },
};

export function parseStartupArguments(argv: readonly string[]): StartupConfiguration {
  const allowed = new Set(["--cell-id", "--plaintext-root", "--persistent-root"]);
  const parsed = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option || !value || !allowed.has(option) || parsed.has(option) || value.length === 0) {
      throw new SessionCryptoError(
        "INVALID_STARTUP_ARGUMENT",
        "Unknown, duplicate, or missing trusted startup argument",
      );
    }
    parsed.set(option, value);
  }
  if (argv.length !== 6 || parsed.size !== 3) {
    throw new SessionCryptoError(
      "INVALID_STARTUP_ARGUMENT",
      "Exactly cell ID, plaintext root, and persistent root startup arguments are required",
    );
  }
  return {
    cellId: parsed.get("--cell-id")!,
    persistentRoot: parsed.get("--persistent-root")!,
    plaintextRoot: parsed.get("--plaintext-root")!,
  };
}

export async function loadRuntimeKeyring(
  operations: KeyFileOperations = defaultKeyFileOperations,
): Promise<RuntimeKeyring> {
  let handle: KeyFileHandle;
  try {
    handle = await operations.open(
      SESSION_KEY_PATH,
      fsConstants.O_RDONLY | LINUX_O_NOFOLLOW,
    );
  } catch (error) {
    throw new SessionCryptoError("KEY_FILE_UNREADABLE", "Runtime key file cannot be read", {
      cause: error,
    });
  }
  let operationError: unknown;
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (stat.kind !== "file") {
      throw new SessionCryptoError("KEY_FILE_TYPE", "Runtime key path must be a regular file");
    }
    if ((stat.mode & 0o777) !== 0o400) {
      throw new SessionCryptoError("KEY_FILE_MODE", "Runtime key file mode must be exactly 0400");
    }
    if (stat.uid !== operations.getuid()) {
      throw new SessionCryptoError("KEY_FILE_OWNER", "Runtime key file owner is invalid");
    }
    bytes = await handle.readFile();
  } catch (error) {
    operationError = error;
    bytes = Buffer.alloc(0);
  }
  try {
    await handle.close();
  } catch (error) {
    if (!operationError) operationError = error;
  }
  if (operationError) {
    if (operationError instanceof SessionCryptoError) throw operationError;
    throw new SessionCryptoError("KEY_FILE_UNREADABLE", "Runtime key file cannot be read", {
      cause: operationError,
    });
  }
  if (bytes.length === 0 || bytes.length > MAX_KEY_FILE_BYTES) {
    throw new SessionCryptoError("KEY_FILE_FORMAT", "Runtime key file has an invalid length");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    throw new SessionCryptoError("KEY_FILE_FORMAT", "Runtime key file is invalid", {
      cause: error,
    });
  }
  if (
    !isPlainObject(decoded) ||
    !hasExactFields(decoded, ["activeGeneration", "keys", "version"]) ||
    decoded.version !== 1 ||
    typeof decoded.activeGeneration !== "string" ||
    !SAFE_GENERATION_PATTERN.test(decoded.activeGeneration) ||
    !isPlainObject(decoded.keys)
  ) {
    throw new SessionCryptoError("KEY_FILE_FORMAT", "Runtime key file is invalid");
  }

  const keys = new Map<string, Uint8Array>();
  const fingerprints = new Set<string>();
  for (const [generation, encoded] of Object.entries(decoded.keys)) {
    if (!SAFE_GENERATION_PATTERN.test(generation) || typeof encoded !== "string") {
      throw new SessionCryptoError("KEY_FILE_FORMAT", "Runtime key file is invalid");
    }
    const key = decodeCanonicalKey(encoded);
    const fingerprint = key.toString("hex");
    if (fingerprints.has(fingerprint)) {
      throw new SessionCryptoError(
        "KEY_FILE_DUPLICATE_KEY",
        "Runtime key generations must use distinct key bytes",
      );
    }
    fingerprints.add(fingerprint);
    keys.set(generation, key);
  }
  if (keys.size === 0 || !keys.has(decoded.activeGeneration)) {
    throw new SessionCryptoError("KEY_FILE_FORMAT", "Runtime key file is invalid");
  }
  return { activeGeneration: decoded.activeGeneration, keys };
}

export function parseRuntimeRequest(value: unknown): RuntimeRequest {
  if (
    !isPlainObject(value) ||
    !hasExactFields(value, [
      "expectedEnvelopeVersion",
      "id",
      "operation",
      "path",
      "version",
    ]) ||
    value.version !== RUNTIME_PROTOCOL_VERSION ||
    typeof value.id !== "string" ||
    !SAFE_ID_PATTERN.test(value.id) ||
    typeof value.operation !== "string" ||
    !["persist", "restore", "rotate"].includes(value.operation) ||
    typeof value.path !== "string"
  ) {
    return invalidRequest();
  }
  const operation = value.operation as RuntimeRequest["operation"];
  const expected = value.expectedEnvelopeVersion;
  const expectedIsDigest = typeof expected === "string" && ENVELOPE_VERSION_PATTERN.test(expected);
  if ((operation === "persist" && expected !== null && !expectedIsDigest) || (operation !== "persist" && !expectedIsDigest)) {
    return invalidRequest();
  }
  let logicalPath: string;
  try {
    logicalPath = normalizeLogicalSessionPath(value.path);
  } catch {
    return invalidRequest();
  }
  return {
    expectedEnvelopeVersion: expected as ExpectedEnvelopeVersion,
    id: value.id,
    operation,
    path: logicalPath,
    version: RUNTIME_PROTOCOL_VERSION,
  };
}

const publicErrors = new Map<string, string>([
  ["AMBIGUOUS_DURABILITY", "Storage durability is ambiguous; explicit recovery is required"],
  ["AUTHENTICATION_FAILED", "Ciphertext authentication failed"],
  ["DAEMON_UNHEALTHY", "Session crypto daemon is unhealthy"],
  ["ENVELOPE_CONFLICT", "Ciphertext changed since it was observed"],
  ["ENVELOPE_TOO_LARGE", "Session data exceeds the encrypted envelope limit"],
  ["INVALID_REQUEST", "Request does not match the exact versioned request schema"],
  ["INVALID_STARTUP_ARGUMENT", "Trusted startup configuration is invalid"],
  ["KEY_FILE_DUPLICATE_KEY", "Runtime key file is invalid"],
  ["KEY_FILE_FORMAT", "Runtime key file is invalid"],
  ["KEY_FILE_MODE", "Runtime key file permissions are invalid"],
  ["KEY_FILE_OWNER", "Runtime key file owner is invalid"],
  ["KEY_FILE_TYPE", "Runtime key path is invalid"],
  ["KEY_FILE_UNREADABLE", "Runtime key file cannot be read"],
  ["MALFORMED_ENVELOPE", "Ciphertext envelope is invalid"],
  ["MALFORMED_REQUEST", "Input line is not valid protocol JSON"],
  ["ROTATION_GENERATION_UNCHANGED", "Ciphertext already uses the active generation"],
  ["UNKNOWN_KEY_GENERATION", "Ciphertext key generation is unavailable"],
  ["UNSUPPORTED_PLATFORM", "Session crypto runtime is supported only on Linux"],
]);

const nonFatalErrors = new Set([
  "ENVELOPE_CONFLICT",
  "ENVELOPE_TOO_LARGE",
  "INVALID_REQUEST",
  "MALFORMED_REQUEST",
  "ROTATION_GENERATION_UNCHANGED",
]);

function errorResponse(code: string, id: string | null): RuntimeErrorResponse {
  const knownMessage = publicErrors.get(code);
  const publicCode = knownMessage ? code : "INTERNAL_ERROR";
  return {
    error: {
      code: publicCode,
      fatal: !nonFatalErrors.has(publicCode),
      message: knownMessage ?? "Session crypto operation failed",
    },
    id,
    ok: false,
    version: RUNTIME_PROTOCOL_VERSION,
  };
}

function sanitizedError(error: unknown, id: string | null): RuntimeErrorResponse {
  return errorResponse(error instanceof SessionCryptoError ? error.code : "INTERNAL_ERROR", id);
}

function successResponse(
  request: RuntimeRequest,
  result: EnvelopeMetadata,
): RuntimeSuccessResponse {
  return {
    id: request.id,
    ok: true,
    result: {
      envelopeVersion: result.envelopeVersion,
      generation: result.generation,
      operation: request.operation,
      path: request.path,
    },
    version: RUNTIME_PROTOCOL_VERSION,
  };
}

export class SessionCryptoDaemon {
  private healthy = true;

  constructor(private readonly store: SessionCryptoOperations) {}

  async handle(value: unknown): Promise<RuntimeResponse> {
    if (!this.healthy) return errorResponse("DAEMON_UNHEALTHY", null);

    let request: RuntimeRequest;
    try {
      request = parseRuntimeRequest(value);
    } catch (error) {
      return sanitizedError(error, null);
    }

    try {
      let result: EnvelopeMetadata;
      switch (request.operation) {
        case "persist":
          result = await this.store.persistFromPlaintext(
            request.path,
            request.expectedEnvelopeVersion,
          );
          break;
        case "restore":
          result = await this.store.restoreToPlaintext(
            request.path,
            request.expectedEnvelopeVersion as string,
          );
          break;
        case "rotate":
          result = await this.store.rotateSession(
            request.path,
            request.expectedEnvelopeVersion as string,
          );
          break;
      }
      return successResponse(request, result);
    } catch (error) {
      const response = sanitizedError(error, request.id);
      if (response.error.fatal) this.healthy = false;
      return response;
    }
  }
}

export async function runStdioDaemon(options: StdioDaemonOptions): Promise<number> {
  for await (const rawLine of options.lines) {
    const line = typeof rawLine === "string" ? rawLine : Buffer.from(rawLine).toString("utf8");
    let value: unknown;
    let response: RuntimeResponse;
    if (Buffer.byteLength(line, "utf8") > MAX_REQUEST_BYTES) {
      response = errorResponse("MALFORMED_REQUEST", null);
    } else {
      try {
        value = JSON.parse(line) as unknown;
        response = await options.daemon.handle(value);
      } catch {
        response = errorResponse("MALFORMED_REQUEST", null);
      }
    }
    await options.writeLine(JSON.stringify(response));
    if (!response.ok && response.error.fatal) return 1;
  }
  return 0;
}

export async function runSessionCryptoProcess(options: RuntimeProcessOptions): Promise<number> {
  try {
    const platform = options.platform ?? process.platform;
    if (platform !== "linux") {
      throw new SessionCryptoError(
        "UNSUPPORTED_PLATFORM",
        "Session crypto runtime is supported only on Linux",
      );
    }
    const startup = parseStartupArguments(options.argv);
    const keyring = await loadRuntimeKeyring(options.keyFileOperations);
    const createStore = options.createStore ?? SessionCryptoStore.create;
    const storeDependencies: SessionCryptoStoreDependencies = {
      ...(options.storeDependencies ?? {}),
      platform,
    };
    const store = await createStore(
      {
        activeGeneration: keyring.activeGeneration,
        cellId: startup.cellId,
        keys: keyring.keys,
        persistentRoot: startup.persistentRoot,
        plaintextRoot: startup.plaintextRoot,
      },
      storeDependencies,
    );
    return runStdioDaemon({
      daemon: new SessionCryptoDaemon(store),
      lines: options.lines,
      writeLine: options.writeLine,
    });
  } catch (error) {
    await options.writeLine(JSON.stringify(sanitizedError(error, null)));
    return 1;
  }
}

async function writeStdoutLine(line: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${line}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const lines = createInterface({ crlfDelay: Infinity, input: process.stdin });
  return runSessionCryptoProcess({ argv, lines, writeLine: writeStdoutLine });
}

const directEntry = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (directEntry === import.meta.url) {
  void main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(async () => {
      process.exitCode = 1;
      try {
        await writeStdoutLine(JSON.stringify(errorResponse("INTERNAL_ERROR", null)));
      } catch {
        // There is no safe output channel left; exit nonzero without logging details.
      }
    });
}
