#!/usr/bin/env node

import { constants as fsConstants, promises as nodeFs } from "node:fs";
import path from "node:path";
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
const LINUX_O_DIRECTORY = fsConstants.O_DIRECTORY ?? 0x10000;
const LINUX_O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0x20000;
const WRITER_DIRECTORY_OPEN_FLAGS =
  fsConstants.O_RDONLY | LINUX_O_DIRECTORY | LINUX_O_NOFOLLOW;
const WRITER_LEASE_DATABASE = ".session-crypto-writer.sqlite";
const WRITER_LEASE_SIDECARS = ["-journal", "-shm", "-wal"] as const;
const ENVELOPE_VERSION_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const SAFE_GENERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_CELL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const LOCAL_WRITER_FILE_SYSTEM_TYPES = new Set([
  0x0000ef53, // ext2/3/4
  0x2fc12fc1, // zfs
  0x3153464a, // jfs
  0x52654973, // reiserfs
  0x58465342, // xfs
  0x794c7630, // overlayfs
  0x9123683e, // btrfs
  0xf2f52010, // f2fs
]);

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
  size: number;
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

type SqlInputValue = null | number | bigint | string | NodeJS.ArrayBufferView;

export interface WriterLeasePathStat {
  dev: number;
  ino: number;
  kind: "directory" | "file" | "other" | "symlink";
  mode: number;
  uid: number;
}

export interface WriterLeaseFileHandle {
  close(): Promise<void>;
  descriptorPath(relativePath?: string): string;
  stat(): Promise<WriterLeasePathStat>;
  sync(): Promise<void>;
}

export interface WriterLeaseStatement {
  get(...params: SqlInputValue[]): unknown;
  run(...params: SqlInputValue[]): unknown;
}

export interface WriterLeaseDatabase {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): WriterLeaseStatement;
}

export interface WriterLeaseOperations {
  getuid(): number;
  inspectPath(candidate: string): Promise<WriterLeasePathStat>;
  isLocalFileSystem(candidate: string): Promise<boolean>;
  open(candidate: string, flags: number, mode?: number): Promise<WriterLeaseFileHandle>;
  openDatabase(
    candidate: string,
    expected: WriterLeasePathStat,
  ): Promise<WriterLeaseDatabase>;
  prepareFile(candidate: string): Promise<boolean>;
  realpath(candidate: string): Promise<string>;
}

export interface WriterLeaseConfiguration {
  cellId: string;
  persistentRoot: string;
}

export interface WriterLease {
  release(): Promise<void>;
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

export interface StdioByteStreamOptions {
  daemon: SessionCryptoDaemon;
  input: AsyncIterable<string | Uint8Array>;
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
  writerLeaseOperations?: WriterLeaseOperations;
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
          size: stats.size,
          uid: stats.uid,
        };
      },
    };
  },
};

const defaultWriterLeaseOperations: WriterLeaseOperations = {
  getuid() {
    if (typeof process.getuid !== "function") {
      throw new SessionCryptoError("UNSUPPORTED_PLATFORM", "Runtime is supported only on Linux");
    }
    return process.getuid();
  },
  async inspectPath(candidate) {
    const stats = await nodeFs.lstat(candidate);
    return {
      dev: stats.dev,
      ino: stats.ino,
      kind: stats.isSymbolicLink()
        ? "symlink"
        : stats.isDirectory()
          ? "directory"
          : stats.isFile()
            ? "file"
            : "other",
      mode: stats.mode & 0o777,
      uid: stats.uid,
    };
  },
  async isLocalFileSystem(candidate) {
    const stats = await nodeFs.statfs(candidate);
    return LOCAL_WRITER_FILE_SYSTEM_TYPES.has(stats.type >>> 0);
  },
  async open(candidate, flags, mode) {
    const handle = await nodeFs.open(candidate, flags, mode);
    return {
      close: () => handle.close(),
      descriptorPath(relativePath = "") {
        const descriptorRoot = `/proc/self/fd/${handle.fd}`;
        return relativePath
          ? path.posix.join(descriptorRoot, ...relativePath.split("/"))
          : descriptorRoot;
      },
      async stat() {
        const stats = await handle.stat();
        return {
          dev: stats.dev,
          ino: stats.ino,
          kind: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
          mode: stats.mode & 0o777,
          uid: stats.uid,
        };
      },
      sync: () => handle.sync(),
    };
  },
  async openDatabase(candidate, expected) {
    const before = await this.inspectPath(candidate);
    if (!sameWriterLeaseIdentity(before, expected)) throw writerLeaseUnsafe("Writer lease database changed before open");
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(candidate);
    const after = await this.inspectPath(candidate).catch((error) => {
      database.close();
      throw error;
    });
    if (!sameWriterLeaseIdentity(after, expected)) {
      database.close();
      throw writerLeaseUnsafe("Writer lease database changed during open");
    }
    return {
      close: () => database.close(),
      exec: (sql) => database.exec(sql),
      prepare(sql) {
        const statement = database.prepare(sql);
        return {
          get: (...params) => statement.get(...params),
          run: (...params) => statement.run(...params),
        };
      },
    };
  },
  async prepareFile(candidate) {
    const flags = fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | LINUX_O_NOFOLLOW;
    let handle;
    try {
      handle = await nodeFs.open(candidate, flags, 0o600);
      await handle.sync();
      await handle.close();
      handle = undefined;
      return true;
    } catch (error) {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // The primary creation error remains authoritative.
        }
      }
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      return false;
    }
  },
  realpath: (candidate) => nodeFs.realpath(candidate),
};

function isErrorCode(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && "code" in error && codes.includes(String(error.code));
}

function isWriterLeaseContentionError(error: unknown): boolean {
  if (isErrorCode(error, "SQLITE_BUSY", "SQLITE_LOCKED")) return true;
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    String(error.code) !== "ERR_SQLITE_ERROR" ||
    !("errcode" in error)
  ) {
    return false;
  }
  if (typeof error.errcode !== "number" || !Number.isInteger(error.errcode) || error.errcode < 0) {
    return false;
  }
  const baseErrorCode = error.errcode & 0xff;
  return baseErrorCode === 5 || baseErrorCode === 6;
}

function writerLeaseUnsafe(message: string, cause?: unknown): SessionCryptoError {
  return new SessionCryptoError("WRITER_LEASE_UNSAFE", message, cause === undefined ? undefined : { cause });
}

function sameWriterLeaseIdentity(
  left: WriterLeasePathStat,
  right: WriterLeasePathStat,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.kind === right.kind &&
    left.mode === right.mode &&
    left.uid === right.uid
  );
}

function assertWriterLeasePath(
  stat: WriterLeasePathStat,
  expected: WriterLeasePathStat,
  message: string,
): void {
  if (!sameWriterLeaseIdentity(stat, expected)) throw writerLeaseUnsafe(message);
}

async function inspectWriterLeaseOptional(
  operations: WriterLeaseOperations,
  candidate: string,
): Promise<WriterLeasePathStat | undefined> {
  try {
    return await operations.inspectPath(candidate);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function assertWriterLeaseState(
  operations: WriterLeaseOperations,
  canonicalRoot: string,
  rootHandle: WriterLeaseFileHandle,
  rootStat: WriterLeasePathStat,
  databasePath: string,
  databaseHandle: WriterLeaseFileHandle,
  databaseStat: WriterLeasePathStat,
  expectedUid: number,
): Promise<void> {
  const rootDescriptorStat = await rootHandle.stat();
  assertWriterLeasePath(
    rootDescriptorStat,
    rootStat,
    "Writer lease root descriptor changed",
  );
  const rootPathStat = await operations.inspectPath(canonicalRoot);
  assertWriterLeasePath(rootPathStat, rootStat, "Writer lease root pathname changed");

  const databaseDescriptorStat = await databaseHandle.stat();
  assertWriterLeasePath(
    databaseDescriptorStat,
    databaseStat,
    "Writer lease database guard changed",
  );
  const databasePathStat = await operations.inspectPath(databasePath);
  assertWriterLeasePath(
    databasePathStat,
    databaseStat,
    "Writer lease database pathname changed",
  );
  for (const suffix of WRITER_LEASE_SIDECARS) {
    const sidecar = await inspectWriterLeaseOptional(operations, `${databasePath}${suffix}`);
    if (!sidecar) continue;
    if (
      sidecar.kind !== "file" ||
      sidecar.uid !== expectedUid ||
      sidecar.mode !== 0o600
    ) {
      throw writerLeaseUnsafe("Writer lease SQLite sidecar is unsafe");
    }
  }
}

async function checkedWriterLeaseOperation<T>(
  validate: () => Promise<void>,
  operation: () => T,
): Promise<T> {
  await validate();
  let operationError: unknown;
  let result: T | undefined;
  try {
    result = operation();
  } catch (error) {
    operationError = error;
  }
  try {
    await validate();
  } catch (validationError) {
    if (operationError) {
      throw writerLeaseUnsafe(
        "Writer lease state changed during a failed SQLite operation",
        new AggregateError([operationError, validationError]),
      );
    }
    if (validationError instanceof SessionCryptoError) throw validationError;
    throw writerLeaseUnsafe("Writer lease state could not be revalidated", validationError);
  }
  if (operationError) throw operationError;
  return result as T;
}

async function closeWriterDatabase(
  database: WriterLeaseDatabase,
  state: { closed: boolean; transactionActive: boolean },
  validate?: () => Promise<void>,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  if (state.closed) return errors;
  if (state.transactionActive) {
    if (validate) {
      try {
        await validate();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      database.exec("ROLLBACK");
      state.transactionActive = false;
    } catch (error) {
      errors.push(error);
    }
    if (validate) {
      try {
        await validate();
      } catch (error) {
        errors.push(error);
      }
    }
  }
  try {
    database.close();
    state.closed = true;
  } catch (error) {
    errors.push(error);
  }
  return errors;
}

export async function acquireWriterLease(
  configuration: WriterLeaseConfiguration,
  operations: WriterLeaseOperations = defaultWriterLeaseOperations,
): Promise<WriterLease> {
  if (!SAFE_CELL_ID_PATTERN.test(configuration.cellId)) {
    throw writerLeaseUnsafe("Writer lease cell identifier is invalid");
  }
  if (!path.posix.isAbsolute(configuration.persistentRoot)) {
    throw writerLeaseUnsafe("Writer lease root must be an absolute Linux path");
  }
  const resolvedRoot = path.posix.resolve(configuration.persistentRoot);
  let canonicalRoot: string;
  try {
    canonicalRoot = await operations.realpath(resolvedRoot);
  } catch (error) {
    throw writerLeaseUnsafe("Writer lease root cannot be resolved", error);
  }
  if (canonicalRoot !== resolvedRoot) {
    throw writerLeaseUnsafe("Writer lease root resolves through an alias");
  }

  const expectedUid = operations.getuid();
  let checkedRootStat: WriterLeasePathStat;
  try {
    checkedRootStat = await operations.inspectPath(canonicalRoot);
  } catch (error) {
    throw writerLeaseUnsafe("Writer lease root cannot be inspected", error);
  }
  if (
    checkedRootStat.kind !== "directory" ||
    checkedRootStat.uid !== expectedUid ||
    (checkedRootStat.mode & 0o077) !== 0
  ) {
    throw writerLeaseUnsafe("Writer lease root type, owner, or mode is unsafe");
  }

  let rootHandle: WriterLeaseFileHandle | undefined;
  try {
    rootHandle = await operations.open(canonicalRoot, WRITER_DIRECTORY_OPEN_FLAGS);
    const descriptorStat = await rootHandle.stat();
    const recheckedRootStat = await operations.inspectPath(canonicalRoot);
    const descriptorRealPath = path.posix.resolve(
      await operations.realpath(rootHandle.descriptorPath()),
    );
    assertWriterLeasePath(
      descriptorStat,
      checkedRootStat,
      "Writer lease root changed while its descriptor was opened",
    );
    assertWriterLeasePath(
      recheckedRootStat,
      checkedRootStat,
      "Writer lease root changed while its descriptor was opened",
    );
    if (descriptorRealPath !== canonicalRoot) {
      throw writerLeaseUnsafe("Writer lease root descriptor resolves through an alias");
    }
  } catch (error) {
    await rootHandle?.close().catch(() => undefined);
    if (error instanceof SessionCryptoError) throw error;
    throw writerLeaseUnsafe("Writer lease root descriptor cannot be opened", error);
  }
  if (!rootHandle) throw writerLeaseUnsafe("Writer lease root descriptor cannot be opened");
  try {
    if (!(await operations.isLocalFileSystem(rootHandle.descriptorPath()))) {
      throw writerLeaseUnsafe("Writer lease requires a verified local filesystem");
    }
  } catch (error) {
    await rootHandle.close().catch(() => undefined);
    if (error instanceof SessionCryptoError) throw error;
    throw writerLeaseUnsafe("Writer lease filesystem type cannot be verified", error);
  }

  const databasePath = rootHandle.descriptorPath(WRITER_LEASE_DATABASE);
  try {
    if (await operations.prepareFile(databasePath)) await rootHandle.sync();
  } catch (error) {
    await rootHandle.close().catch(() => undefined);
    throw writerLeaseUnsafe("Writer lease database cannot be safely prepared", error);
  }
  let databaseStat: WriterLeasePathStat;
  try {
    databaseStat = await operations.inspectPath(databasePath);
  } catch (error) {
    await rootHandle.close().catch(() => undefined);
    throw writerLeaseUnsafe("Writer lease database cannot be inspected", error);
  }
  if (
    databaseStat.kind !== "file" ||
    databaseStat.uid !== expectedUid ||
    databaseStat.mode !== 0o600
  ) {
    await rootHandle.close().catch(() => undefined);
    throw writerLeaseUnsafe("Writer lease database type, owner, or mode is unsafe");
  }

  let databaseHandle: WriterLeaseFileHandle | undefined;
  try {
    databaseHandle = await operations.open(
      databasePath,
      fsConstants.O_RDWR | LINUX_O_NOFOLLOW,
    );
    assertWriterLeasePath(
      await databaseHandle.stat(),
      databaseStat,
      "Writer lease database changed while its guard descriptor was opened",
    );
  } catch (error) {
    await databaseHandle?.close().catch(() => undefined);
    await rootHandle.close().catch(() => undefined);
    if (error instanceof SessionCryptoError) throw error;
    throw writerLeaseUnsafe("Writer lease database guard cannot be opened", error);
  }
  if (!databaseHandle) throw writerLeaseUnsafe("Writer lease database guard cannot be opened");

  const validate = () =>
    assertWriterLeaseState(
      operations,
      canonicalRoot,
      rootHandle,
      checkedRootStat,
      databasePath,
      databaseHandle,
      databaseStat,
      expectedUid,
    );

  let database: WriterLeaseDatabase;
  try {
    await validate();
    database = await operations.openDatabase(databasePath, databaseStat);
    await validate();
  } catch (error) {
    await databaseHandle.close().catch(() => undefined);
    await rootHandle.close().catch(() => undefined);
    if (error instanceof SessionCryptoError) throw error;
    if (isErrorCode(error, "ELOOP", "ENOTDIR", "ESTALE")) {
      throw writerLeaseUnsafe("Writer lease database changed before it could be opened", error);
    }
    throw new SessionCryptoError("WRITER_LEASE_IO", "Writer lease database cannot be opened", {
      cause: error,
    });
  }

  let transactionActive = false;
  try {
    await checkedWriterLeaseOperation(validate, () => database.exec("PRAGMA busy_timeout = 0"));
    await checkedWriterLeaseOperation(validate, () => database.exec("PRAGMA journal_mode = DELETE"));
    await checkedWriterLeaseOperation(validate, () => database.exec("PRAGMA locking_mode = EXCLUSIVE"));
    await checkedWriterLeaseOperation(validate, () => database.exec("BEGIN EXCLUSIVE"));
    transactionActive = true;
    await checkedWriterLeaseOperation(validate, () =>
      database.exec(
        "CREATE TABLE IF NOT EXISTS writer_identity (version INTEGER PRIMARY KEY, cell_id TEXT NOT NULL, persistent_root TEXT NOT NULL)",
      ),
    );
    const identity = await checkedWriterLeaseOperation(
      validate,
      () =>
        database
          .prepare("SELECT cell_id AS cellId, persistent_root AS persistentRoot FROM writer_identity WHERE version = 1")
          .get() as { cellId?: unknown; persistentRoot?: unknown } | undefined,
    );
    if (!identity) {
      await checkedWriterLeaseOperation(validate, () =>
        database
          .prepare("INSERT INTO writer_identity (version, cell_id, persistent_root) VALUES (1, ?, ?)")
          .run(configuration.cellId, canonicalRoot),
      );
    } else if (identity.cellId !== configuration.cellId || identity.persistentRoot !== canonicalRoot) {
      throw writerLeaseUnsafe("Writer lease database identity does not match this cell and root");
    }
    await checkedWriterLeaseOperation(validate, () => database.exec("COMMIT"));
    transactionActive = false;
    await checkedWriterLeaseOperation(validate, () => database.exec("BEGIN EXCLUSIVE"));
    transactionActive = true;
  } catch (error) {
    await closeWriterDatabase(database, { closed: false, transactionActive });
    await databaseHandle.close().catch(() => undefined);
    await rootHandle.close().catch(() => undefined);
    if (error instanceof SessionCryptoError) throw error;
    if (isWriterLeaseContentionError(error)) {
      throw new SessionCryptoError("WRITER_LEASE_ACTIVE", "Another writer owns this persistent root");
    }
    throw new SessionCryptoError("WRITER_LEASE_IO", "Writer lease acquisition failed", {
      cause: error,
    });
  }

  const cleanupState = {
    closed: false,
    databaseHandleClosed: false,
    rootHandleClosed: false,
    transactionActive: true,
  };
  let releaseAttempt: Promise<void> | undefined;
  return {
    release() {
      if (
        cleanupState.closed &&
        cleanupState.databaseHandleClosed &&
        cleanupState.rootHandleClosed
      ) {
        return Promise.resolve();
      }
      if (releaseAttempt) return releaseAttempt;
      releaseAttempt = (async () => {
        const errors = await closeWriterDatabase(database, cleanupState, validate);
        if (cleanupState.closed && !cleanupState.databaseHandleClosed) {
          try {
            await databaseHandle.close();
            cleanupState.databaseHandleClosed = true;
          } catch (error) {
            errors.push(error);
          }
        }
        if (cleanupState.closed && !cleanupState.rootHandleClosed) {
          try {
            await rootHandle.close();
            cleanupState.rootHandleClosed = true;
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) {
          throw new SessionCryptoError(
            "WRITER_LEASE_RELEASE_FAILED",
            "Writer lease cleanup failed",
            { cause: new AggregateError(errors) },
          );
        }
      })().finally(() => {
        releaseAttempt = undefined;
      });
      return releaseAttempt;
    },
  };
}

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
    if (!Number.isSafeInteger(stat.size) || stat.size <= 0 || stat.size > MAX_KEY_FILE_BYTES) {
      throw new SessionCryptoError("KEY_FILE_FORMAT", "Runtime key file has an invalid length");
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
  ["WRITER_LEASE_ACTIVE", "Another session crypto writer already owns this persistent root"],
  ["WRITER_LEASE_IO", "Session crypto writer lease could not be established"],
  ["WRITER_LEASE_RELEASE_FAILED", "Session crypto writer lease cleanup failed"],
  ["WRITER_LEASE_UNSAFE", "Session crypto writer lease path is unsafe"],
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
    const response = await responseForLine(options.daemon, line);
    await options.writeLine(JSON.stringify(response));
    if (!response.ok && response.error.fatal) return 1;
  }
  return 0;
}

async function responseForLine(daemon: SessionCryptoDaemon, line: string): Promise<RuntimeResponse> {
  if (Buffer.byteLength(line, "utf8") > MAX_REQUEST_BYTES) {
    return errorResponse("MALFORMED_REQUEST", null);
  }
  try {
    return daemon.handle(JSON.parse(line) as unknown);
  } catch {
    return errorResponse("MALFORMED_REQUEST", null);
  }
}

export async function runStdioByteStream(options: StdioByteStreamOptions): Promise<number> {
  let buffered: Buffer[] = [];
  let bufferedBytes = 0;
  let oversized = false;

  const emitLine = async (): Promise<number | undefined> => {
    let response: RuntimeResponse;
    if (oversized) {
      response = errorResponse("MALFORMED_REQUEST", null);
    } else {
      let lineBytes = Buffer.concat(buffered, bufferedBytes);
      if (lineBytes.at(-1) === 0x0d) lineBytes = lineBytes.subarray(0, -1);
      response = await responseForLine(options.daemon, lineBytes.toString("utf8"));
    }
    buffered = [];
    bufferedBytes = 0;
    oversized = false;
    await options.writeLine(JSON.stringify(response));
    return !response.ok && response.error.fatal ? 1 : undefined;
  };

  for await (const rawChunk of options.input) {
    const chunk =
      typeof rawChunk === "string"
        ? Buffer.from(rawChunk, "utf8")
        : Buffer.isBuffer(rawChunk)
          ? rawChunk
          : Buffer.from(rawChunk.buffer, rawChunk.byteOffset, rawChunk.byteLength);
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.length : newline;
      const segment = chunk.subarray(offset, end);
      if (!oversized) {
        if (bufferedBytes + segment.length > MAX_REQUEST_BYTES) {
          buffered = [];
          bufferedBytes = 0;
          oversized = true;
        } else if (segment.length > 0) {
          buffered.push(segment);
          bufferedBytes += segment.length;
        }
      }
      if (newline < 0) break;
      const exitCode = await emitLine();
      if (exitCode !== undefined) return exitCode;
      offset = newline + 1;
    }
  }

  if (oversized || bufferedBytes > 0) {
    const exitCode = await emitLine();
    if (exitCode !== undefined) return exitCode;
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
    const writerLease = await acquireWriterLease(
      { cellId: startup.cellId, persistentRoot: startup.persistentRoot },
      options.writerLeaseOperations,
    );
    try {
      return await runStdioByteStream({
        daemon: new SessionCryptoDaemon(store),
        input: options.lines,
        writeLine: options.writeLine,
      });
    } finally {
      await writerLease.release();
    }
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
  return runSessionCryptoProcess({ argv, lines: process.stdin, writeLine: writeStdoutLine });
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
