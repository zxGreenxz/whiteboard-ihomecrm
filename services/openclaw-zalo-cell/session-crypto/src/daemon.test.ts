import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AmbiguousDurabilityError,
  SessionCryptoError,
  type EnvelopeMetadata,
} from "./crypto.js";
import * as daemonModule from "./daemon.js";

const CELL_ID = "dddd0000-0000-4000-8000-000000000001";
const VERSION_A = "a".repeat(64);
const VERSION_B = "b".repeat(64);

type RuntimeModule = Record<string, unknown>;

function runtimeExport<T>(name: string): T | undefined {
  return (daemonModule as unknown as RuntimeModule)[name] as T | undefined;
}

function metadata(overrides: Partial<EnvelopeMetadata> = {}): EnvelopeMetadata {
  return {
    algorithm: "AES-256-GCM",
    ciphertextLength: 20,
    envelopeVersion: VERSION_B,
    generation: "g2",
    nonce: Buffer.alloc(12, 0x21).toString("base64"),
    nonceLength: 12,
    tag: Buffer.alloc(16, 0x22).toString("base64"),
    tagLength: 16,
    version: 1,
    ...overrides,
  };
}

function validRequest(operation: "persist" | "restore" | "rotate") {
  return {
    expectedEnvelopeVersion: operation === "persist" ? null : VERSION_A,
    id: `request-${operation}`,
    operation,
    path: "account/session.json",
    version: 1,
  };
}

function asyncLines(...lines: string[]): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const line of lines) yield line;
    },
  };
}

function asyncChunks(...chunks: Array<string | Uint8Array>): AsyncIterable<string | Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function errno(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function createLeaseHarness(...roots: string[]) {
  const rootEntries = new Map<
    string,
    {
      dev: number;
      ino: number;
      kind: "directory" | "file" | "other" | "symlink";
      mode: number;
      uid: number;
    }
  >(
    roots.map((root, index) => [
      root,
      {
        dev: 1,
        ino: 10 + index,
        kind: "directory" as const,
        mode: 0o700,
        uid: 1000,
      },
    ]),
  );
  const databaseEntries = new Map<
    string,
    {
      dev: number;
      ino: number;
      kind: "file" | "symlink";
      mode: number;
      uid: number;
    }
  >();
  const activeLocks = new Map<string, symbol>();
  const identities = new Map<string, { cellId: string; persistentRoot: string }>();
  const events: string[] = [];
  const localRoots = new Map(roots.map((root) => [root, true]));
  const resolvedRoots = new Map(roots.map((root) => [root, root]));
  const descriptorRoots = new Map<number, { path: string; stat: ReturnType<typeof rootEntries.get> }>();
  let nextDescriptor = 50;
  let nextInode = 100;
  let beforeDatabaseOpen: ((candidate: string) => void) | undefined;

  const decodeCandidate = (candidate: string): { descriptor: boolean; path: string } => {
    const match = /^@lease-fd:(\d+):(.*)$/.exec(candidate);
    if (!match) return { descriptor: false, path: candidate };
    const descriptor = descriptorRoots.get(Number(match[1]));
    if (!descriptor) throw errno("EBADF");
    return {
      descriptor: true,
      path: match[2] ? `${descriptor.path}/${match[2]}` : descriptor.path,
    };
  };

  const sameIdentity = (
    left: { dev: number; ino: number; kind: string; mode: number; uid: number },
    right: { dev: number; ino: number; kind: string; mode: number; uid: number },
  ) =>
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.kind === right.kind &&
    left.mode === right.mode &&
    left.uid === right.uid;

  const operations = {
    getuid: () => 1000,
    async inspectPath(candidate: string) {
      const decoded = decodeCandidate(candidate);
      const entry = rootEntries.get(decoded.path) ?? databaseEntries.get(decoded.path);
      if (!entry) throw errno("ENOENT");
      return { ...entry };
    },
    async isLocalFileSystem(candidate: string) {
      return localRoots.get(decodeCandidate(candidate).path) ?? false;
    },
    async open(candidate: string, flags: number, mode?: number) {
      const decoded = decodeCandidate(candidate);
      const directory = (flags & (fsConstants.O_DIRECTORY ?? 0x10000)) !== 0;
      const noFollow = (flags & (fsConstants.O_NOFOLLOW ?? 0x20000)) !== 0;
      const create = (flags & fsConstants.O_CREAT) !== 0;
      const exclusive = (flags & fsConstants.O_EXCL) !== 0;
      const current = rootEntries.get(decoded.path) ?? databaseEntries.get(decoded.path);
      if (noFollow && current?.kind === "symlink") throw errno("ELOOP");
      if (directory && current?.kind !== "directory") throw errno(current ? "ENOTDIR" : "ENOENT");
      if (!directory && create && exclusive && current) throw errno("EEXIST");
      if (!directory && create && !current) {
        databaseEntries.set(decoded.path, {
          dev: 1,
          ino: nextInode++,
          kind: "file",
          mode: mode ?? 0o600,
          uid: 1000,
        });
      }
      const entry = rootEntries.get(decoded.path) ?? databaseEntries.get(decoded.path);
      if (!entry) throw errno("ENOENT");
      const descriptor = nextDescriptor++;
      descriptorRoots.set(descriptor, { path: decoded.path, stat: { ...entry } });
      let closed = false;
      return {
        close: async () => {
          if (closed) return;
          closed = true;
          descriptorRoots.delete(descriptor);
        },
        descriptorPath: (relativePath = "") => `@lease-fd:${descriptor}:${relativePath}`,
        stat: async () => ({ ...descriptorRoots.get(descriptor)!.stat! }),
        sync: async () => undefined,
      };
    },
    async openDatabase(
      candidate: string,
      expected?: { dev: number; ino: number; kind: string; mode: number; uid: number },
    ) {
      const decoded = decodeCandidate(candidate);
      beforeDatabaseOpen?.(decoded.path);
      const current = databaseEntries.get(decoded.path);
      if (expected && (!current || !sameIdentity(current, expected))) throw errno("ESTALE");
      events.push(`open:${decoded.path}`);
      const owner = Symbol(decoded.path);
      let closed = false;
      const release = () => {
        if (activeLocks.get(decoded.path) === owner) activeLocks.delete(decoded.path);
      };
      return {
        close() {
          if (closed) return;
          closed = true;
          release();
          events.push(`close:${decoded.path}`);
        },
        exec(sql: string) {
          events.push(`exec:${sql}`);
          if (sql === "BEGIN EXCLUSIVE") {
            if (activeLocks.has(decoded.path) && activeLocks.get(decoded.path) !== owner) {
              throw errno("SQLITE_BUSY");
            }
            activeLocks.set(decoded.path, owner);
          } else if (sql === "COMMIT" || sql === "ROLLBACK") {
            release();
          }
        },
        prepare(sql: string) {
          if (sql.startsWith("SELECT")) {
            return {
              get: () => identities.get(decoded.path),
              run: () => {
                throw new Error("SELECT cannot run");
              },
            };
          }
          if (sql.startsWith("INSERT")) {
            return {
              get: () => undefined,
              run: (cellId: string, persistentRoot: string) => {
                identities.set(decoded.path, { cellId, persistentRoot });
              },
            };
          }
          throw new Error(`unexpected SQL: ${sql}`);
        },
      };
    },
    async prepareFile(candidate: string) {
      const decoded = decodeCandidate(candidate);
      events.push(`prepare:${decoded.path}`);
      if (!databaseEntries.has(decoded.path)) {
        databaseEntries.set(decoded.path, {
          dev: 1,
          ino: nextInode++,
          kind: "file",
          mode: 0o600,
          uid: 1000,
        });
        return true;
      }
      return false;
    },
    async realpath(candidate: string) {
      const decoded = decodeCandidate(candidate);
      if (decoded.descriptor) return decoded.path;
      const resolved = resolvedRoots.get(decoded.path);
      if (!resolved) throw errno("ENOENT");
      return resolved;
    },
  };

  return {
    crash() {
      activeLocks.clear();
    },
    activeLocks,
    databaseEntries,
    databasePath(root: string) {
      return `${root}/.session-crypto-writer.sqlite`;
    },
    events,
    identities,
    operations,
    rootEntries,
    setBeforeDatabaseOpen(hook: ((candidate: string) => void) | undefined) {
      beforeDatabaseOpen = hook;
    },
    setLocal(root: string, local: boolean) {
      localRoots.set(root, local);
    },
    setResolvedRoot(root: string, candidate: string) {
      resolvedRoots.set(root, candidate);
    },
  };
}

describe("runtime bootstrap contracts", () => {
  it("publishes a real executable and stdio bootstrap without network listeners", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    const source = await readFile(new URL("./daemon.ts", import.meta.url), "utf8");

    expect(packageJson.bin).toEqual({
      "openclaw-session-crypto": "./dist/daemon.js",
    });
    expect(packageJson.engines).toEqual({ node: ">=22.13.0" });
    expect(runtimeExport("runStdioDaemon")).toBeTypeOf("function");
    expect(runtimeExport("runSessionCryptoProcess")).toBeTypeOf("function");
    expect(source).not.toMatch(/node:(?:http|https|net|tls|dgram|http2)/);
  });

  it("enforces one active writer with an exclusive SQLite transaction", async () => {
    const acquireWriterLease = runtimeExport<
      (
        configuration: { cellId: string; persistentRoot: string },
        operations: ReturnType<typeof createLeaseHarness>["operations"],
      ) =>
        Promise<{ release(): Promise<void> }>
    >("acquireWriterLease");
    expect(acquireWriterLease).toBeTypeOf("function");
    if (!acquireWriterLease) return;
    const harness = createLeaseHarness("/srv/openclaw-session");

    const first = await acquireWriterLease(
      { cellId: CELL_ID, persistentRoot: "/srv/openclaw-session" },
      harness.operations,
    );
    await expect(
      acquireWriterLease(
        { cellId: CELL_ID, persistentRoot: "/srv/openclaw-session" },
        harness.operations,
      ),
    ).rejects.toMatchObject({ code: "WRITER_LEASE_ACTIVE" });

    await first.release();
    expect(harness.activeLocks.size).toBe(0);
    expect(harness.events).toContain("exec:PRAGMA locking_mode = EXCLUSIVE");
    expect(harness.events).toContain("exec:BEGIN EXCLUSIVE");
  });

  it.each([5, 6, 261, 262])(
    "classifies node:sqlite contention errcode %i and closes the rejected handle",
    async (errcode) => {
    const acquireWriterLease = runtimeExport<
      (
        configuration: { cellId: string; persistentRoot: string },
        operations: ReturnType<typeof createLeaseHarness>["operations"],
      ) => Promise<{ release(): Promise<void> }>
    >("acquireWriterLease");
    expect(acquireWriterLease).toBeTypeOf("function");
    if (!acquireWriterLease) return;
    const root = "/srv/openclaw-session";
    const harness = createLeaseHarness(root);
    const active = await acquireWriterLease(
      { cellId: CELL_ID, persistentRoot: root },
      harness.operations,
    );
    const nativeBusyOperations = {
      ...harness.operations,
      async openDatabase(candidate: string) {
        const database = await harness.operations.openDatabase(candidate);
        return {
          ...database,
          exec(sql: string) {
            if (sql === "PRAGMA journal_mode = DELETE") {
              throw Object.assign(new Error("database is locked"), {
                code: "ERR_SQLITE_ERROR",
                errcode,
                errstr: "database is locked",
              });
            }
            database.exec(sql);
          },
        };
      },
    };

    await expect(
      acquireWriterLease(
        { cellId: CELL_ID, persistentRoot: root },
        nativeBusyOperations,
      ),
    ).rejects.toMatchObject({ code: "WRITER_LEASE_ACTIVE" });
    expect(harness.events.filter((event) => event === `close:${harness.databasePath(root)}`)).toHaveLength(1);

    await active.release();
    expect(harness.events.filter((event) => event === `close:${harness.databasePath(root)}`)).toHaveLength(2);
    },
  );

  it("retries close after a failed release without replaying a successful rollback", async () => {
    const acquireWriterLease = runtimeExport<
      (
        configuration: { cellId: string; persistentRoot: string },
        operations: ReturnType<typeof createLeaseHarness>["operations"],
      ) => Promise<{ release(): Promise<void> }>
    >("acquireWriterLease");
    expect(acquireWriterLease).toBeTypeOf("function");
    if (!acquireWriterLease) return;
    const root = "/srv/openclaw-session";
    const harness = createLeaseHarness(root);
    let closeAttempts = 0;
    const operations = {
      ...harness.operations,
      async openDatabase(candidate: string) {
        const database = await harness.operations.openDatabase(candidate);
        return {
          ...database,
          close() {
            closeAttempts += 1;
            if (closeAttempts === 1) throw errno("EBUSY");
            database.close();
          },
        };
      },
    };
    const lease = await acquireWriterLease(
      { cellId: CELL_ID, persistentRoot: root },
      operations,
    );

    await expect(lease.release()).rejects.toMatchObject({
      code: "WRITER_LEASE_RELEASE_FAILED",
    });
    expect(harness.events.filter((event) => event === "exec:ROLLBACK")).toHaveLength(1);
    await lease.release();
    await lease.release();

    expect(closeAttempts).toBe(2);
    expect(harness.events.filter((event) => event === "exec:ROLLBACK")).toHaveLength(1);
    expect(harness.events.filter((event) => event === `close:${harness.databasePath(root)}`)).toHaveLength(1);
  });

  it("retries rollback and close when neither cleanup step completed", async () => {
    const acquireWriterLease = runtimeExport<
      (
        configuration: { cellId: string; persistentRoot: string },
        operations: ReturnType<typeof createLeaseHarness>["operations"],
      ) => Promise<{ release(): Promise<void> }>
    >("acquireWriterLease");
    expect(acquireWriterLease).toBeTypeOf("function");
    if (!acquireWriterLease) return;
    const root = "/srv/openclaw-session";
    const harness = createLeaseHarness(root);
    let closeAttempts = 0;
    let rollbackAttempts = 0;
    const operations = {
      ...harness.operations,
      async openDatabase(candidate: string) {
        const database = await harness.operations.openDatabase(candidate);
        return {
          ...database,
          close() {
            closeAttempts += 1;
            if (closeAttempts === 1) throw errno("EBUSY");
            database.close();
          },
          exec(sql: string) {
            if (sql === "ROLLBACK") {
              rollbackAttempts += 1;
              if (rollbackAttempts === 1) throw errno("SQLITE_IOERR");
            }
            database.exec(sql);
          },
        };
      },
    };
    const lease = await acquireWriterLease(
      { cellId: CELL_ID, persistentRoot: root },
      operations,
    );

    await expect(lease.release()).rejects.toMatchObject({
      code: "WRITER_LEASE_RELEASE_FAILED",
    });
    expect(harness.activeLocks.size).toBe(1);
    await lease.release();

    expect(rollbackAttempts).toBe(2);
    expect(closeAttempts).toBe(2);
    expect(harness.activeLocks.size).toBe(0);
  });

  it("closes real SQLite contenders before reacquire and immediate temp-root cleanup", async () => {
    const acquireWriterLease = runtimeExport<
      (
        configuration: { cellId: string; persistentRoot: string },
        operations: daemonModule.WriterLeaseOperations,
      ) => Promise<{ release(): Promise<void> }>
    >("acquireWriterLease");
    expect(acquireWriterLease).toBeTypeOf("function");
    if (!acquireWriterLease) return;
    const logicalRoot = "/srv/openclaw-session";
    const logicalDatabase = `${logicalRoot}/.session-crypto-writer.sqlite`;
    const temporaryRoot = await mkdtemp(join(tmpdir(), "openclaw-sqlite-lease-"));
    const databasePath = join(temporaryRoot, "writer.sqlite");
    let databasePrepared = false;
    let databaseHandlesOpened = 0;
    let databaseHandlesClosed = 0;
    const databaseEvents: string[] = [];
    const operations: daemonModule.WriterLeaseOperations = {
      getuid: () => 1000,
      async inspectPath(candidate) {
        if (candidate === logicalRoot) {
          return { dev: 1, ino: 1, kind: "directory", mode: 0o700, uid: 1000 };
        }
        if (candidate === logicalDatabase && databasePrepared) {
          return { dev: 1, ino: 2, kind: "file", mode: 0o600, uid: 1000 };
        }
        throw errno("ENOENT");
      },
      async isLocalFileSystem(candidate) {
        return candidate === logicalRoot;
      },
      async open(candidate, flags) {
        if ((flags & (fsConstants.O_DIRECTORY ?? 0x10000)) !== 0) {
          expect(candidate).toBe(logicalRoot);
          return {
            close: async () => undefined,
            descriptorPath: (relativePath = "") =>
              relativePath ? `${logicalRoot}/${relativePath}` : logicalRoot,
            stat: async () => ({
              dev: 1,
              ino: 1,
              kind: "directory" as const,
              mode: 0o700,
              uid: 1000,
            }),
            sync: async () => undefined,
          };
        }
        expect(candidate).toBe(logicalDatabase);
        return {
          close: async () => undefined,
          descriptorPath: () => logicalDatabase,
          stat: async () => ({
            dev: 1,
            ino: 2,
            kind: "file" as const,
            mode: 0o600,
            uid: 1000,
          }),
          sync: async () => undefined,
        };
      },
      async openDatabase(candidate, _expected) {
        expect(candidate).toBe(logicalDatabase);
        const { DatabaseSync } = await import("node:sqlite");
        const database = new DatabaseSync(databasePath);
        const handleId = ++databaseHandlesOpened;
        return {
          close() {
            database.close();
            databaseHandlesClosed += 1;
            databaseEvents.push(`${handleId}:close`);
          },
          exec(sql) {
            databaseEvents.push(`${handleId}:exec:${sql}`);
            database.exec(sql);
          },
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
        expect(candidate).toBe(logicalDatabase);
        if (databasePrepared) return false;
        const handle = await open(databasePath, "wx", 0o600);
        await handle.close();
        databasePrepared = true;
        return true;
      },
      async realpath(candidate) {
        return candidate;
      },
    };
    let first: { release(): Promise<void> } | undefined;
    let replacement: { release(): Promise<void> } | undefined;
    let cleanupComplete = false;

    try {
      first = await acquireWriterLease(
        { cellId: CELL_ID, persistentRoot: logicalRoot },
        operations,
      );
      await expect(
        acquireWriterLease(
          { cellId: CELL_ID, persistentRoot: logicalRoot },
          operations,
        ),
      ).rejects.toMatchObject({ code: "WRITER_LEASE_ACTIVE" });
      expect(databaseHandlesOpened).toBe(2);
      expect(databaseHandlesClosed).toBe(1);
      expect(databaseEvents).toContain("2:close");

      await first.release();
      await first.release();
      expect(databaseHandlesClosed).toBe(2);
      expect(databaseEvents.indexOf("1:exec:ROLLBACK")).toBeLessThan(
        databaseEvents.indexOf("1:close"),
      );
      first = undefined;
      replacement = await acquireWriterLease(
        { cellId: CELL_ID, persistentRoot: logicalRoot },
        operations,
      );
      await replacement.release();
      await replacement.release();
      expect(databaseHandlesOpened).toBe(3);
      expect(databaseHandlesClosed).toBe(3);
      expect(databaseEvents.indexOf("3:exec:ROLLBACK")).toBeLessThan(
        databaseEvents.indexOf("3:close"),
      );
      replacement = undefined;

      const { DatabaseSync } = await import("node:sqlite");
      const probe = new DatabaseSync(databasePath);
      try {
        expect(probe.prepare("PRAGMA journal_mode").get()).toMatchObject({
          journal_mode: "delete",
        });
      } finally {
        probe.close();
      }

      await rm(temporaryRoot, { recursive: true });
      cleanupComplete = true;
    } finally {
      await replacement?.release().catch(() => undefined);
      await first?.release().catch(() => undefined);
      if (!cleanupComplete) {
        await rm(temporaryRoot, { force: true, recursive: true }).catch(() => undefined);
      }
    }
  });

  it("reacquires after crash and still allows only one concurrent replacement", async () => {
    const acquireWriterLease = runtimeExport<
      (
        configuration: { cellId: string; persistentRoot: string },
        operations: ReturnType<typeof createLeaseHarness>["operations"],
      ) =>
        Promise<{ release(): Promise<void> }>
    >("acquireWriterLease");
    expect(acquireWriterLease).toBeTypeOf("function");
    if (!acquireWriterLease) return;
    const harness = createLeaseHarness("/srv/openclaw-session");
    await acquireWriterLease(
      { cellId: CELL_ID, persistentRoot: "/srv/openclaw-session" },
      harness.operations,
    );
    harness.crash();

    const attempts = await Promise.allSettled([
      acquireWriterLease(
        { cellId: CELL_ID, persistentRoot: "/srv/openclaw-session" },
        harness.operations,
      ),
      acquireWriterLease(
        { cellId: CELL_ID, persistentRoot: "/srv/openclaw-session" },
        harness.operations,
      ),
    ]);
    const winners = attempts.filter(
      (result): result is PromiseFulfilledResult<{ release(): Promise<void> }> =>
        result.status === "fulfilled",
    );
    const losers = attempts.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.reason).toMatchObject({
      code: expect.stringMatching(/^WRITER_LEASE_/),
    });
    await winners[0]!.value.release();
  });

  it("keeps different persistent roots independent and binds each root to its cell", async () => {
    const acquireWriterLease = runtimeExport<
      (
        configuration: { cellId: string; persistentRoot: string },
        operations: ReturnType<typeof createLeaseHarness>["operations"],
      ) => Promise<{ release(): Promise<void> }>
    >("acquireWriterLease");
    expect(acquireWriterLease).toBeTypeOf("function");
    if (!acquireWriterLease) return;
    const harness = createLeaseHarness("/srv/root-a", "/srv/root-b");

    const leases = await Promise.all([
      acquireWriterLease({ cellId: "cell-a", persistentRoot: "/srv/root-a" }, harness.operations),
      acquireWriterLease({ cellId: "cell-b", persistentRoot: "/srv/root-b" }, harness.operations),
    ]);

    expect(harness.activeLocks.size).toBe(2);
    await Promise.all(leases.map((lease) => lease.release()));
    await expect(
      acquireWriterLease({ cellId: "cell-c", persistentRoot: "/srv/root-a" }, harness.operations),
    ).rejects.toMatchObject({ code: "WRITER_LEASE_UNSAFE" });
  });

  it.each([
    ["root alias", (harness: ReturnType<typeof createLeaseHarness>) => {
      harness.setResolvedRoot("/srv/openclaw-session", "/srv/other");
    }],
    ["root type", (harness: ReturnType<typeof createLeaseHarness>) => {
      harness.rootEntries.get("/srv/openclaw-session")!.kind = "file";
    }],
    ["root owner", (harness: ReturnType<typeof createLeaseHarness>) => {
      harness.rootEntries.get("/srv/openclaw-session")!.uid = 0;
    }],
    ["root mode", (harness: ReturnType<typeof createLeaseHarness>) => {
      harness.rootEntries.get("/srv/openclaw-session")!.mode = 0o755;
    }],
    ["remote filesystem", (harness: ReturnType<typeof createLeaseHarness>) => {
      harness.setLocal("/srv/openclaw-session", false);
    }],
    ["database symlink", (harness: ReturnType<typeof createLeaseHarness>) => {
      harness.databaseEntries.set(harness.databasePath("/srv/openclaw-session"), {
        dev: 1,
        ino: 901,
        kind: "symlink",
        mode: 0o600,
        uid: 1000,
      });
    }],
    ["database owner", (harness: ReturnType<typeof createLeaseHarness>) => {
      harness.databaseEntries.set(harness.databasePath("/srv/openclaw-session"), {
        dev: 1,
        ino: 902,
        kind: "file",
        mode: 0o600,
        uid: 0,
      });
    }],
    ["database mode", (harness: ReturnType<typeof createLeaseHarness>) => {
      harness.databaseEntries.set(harness.databasePath("/srv/openclaw-session"), {
        dev: 1,
        ino: 903,
        kind: "file",
        mode: 0o644,
        uid: 1000,
      });
    }],
  ])("fails closed on writer lease %s mismatch", async (_label, mutate) => {
    const acquireWriterLease = runtimeExport<
      (
        configuration: { cellId: string; persistentRoot: string },
        operations: ReturnType<typeof createLeaseHarness>["operations"],
      ) =>
        Promise<{ release(): Promise<void> }>
    >("acquireWriterLease");
    expect(acquireWriterLease).toBeTypeOf("function");
    if (!acquireWriterLease) return;
    const harness = createLeaseHarness("/srv/openclaw-session");
    mutate(harness);

    await expect(
      acquireWriterLease(
        { cellId: CELL_ID, persistentRoot: "/srv/openclaw-session" },
        harness.operations,
      ),
    ).rejects.toMatchObject({ code: "WRITER_LEASE_UNSAFE" });
  });

  it("rejects a database leaf swapped to a symlink immediately before DatabaseSync", async () => {
    const acquireWriterLease = runtimeExport<
      (
        configuration: { cellId: string; persistentRoot: string },
        operations: ReturnType<typeof createLeaseHarness>["operations"],
      ) => Promise<{ release(): Promise<void> }>
    >("acquireWriterLease");
    expect(acquireWriterLease).toBeTypeOf("function");
    if (!acquireWriterLease) return;
    const root = "/srv/openclaw-session";
    const harness = createLeaseHarness(root);
    harness.setBeforeDatabaseOpen((candidate) => {
      harness.databaseEntries.set(candidate, {
        dev: 1,
        ino: 950,
        kind: "symlink",
        mode: 0o600,
        uid: 1000,
      });
    });

    await expect(
      acquireWriterLease({ cellId: CELL_ID, persistentRoot: root }, harness.operations),
    ).rejects.toMatchObject({ code: "WRITER_LEASE_UNSAFE" });
  });

  it("rejects a safe-looking database inode replacement before DatabaseSync", async () => {
    const acquireWriterLease = runtimeExport<
      (
        configuration: { cellId: string; persistentRoot: string },
        operations: ReturnType<typeof createLeaseHarness>["operations"],
      ) => Promise<{ release(): Promise<void> }>
    >("acquireWriterLease");
    expect(acquireWriterLease).toBeTypeOf("function");
    if (!acquireWriterLease) return;
    const root = "/srv/openclaw-session";
    const harness = createLeaseHarness(root);
    harness.setBeforeDatabaseOpen((candidate) => {
      harness.databaseEntries.set(candidate, {
        dev: 1,
        ino: 951,
        kind: "file",
        mode: 0o600,
        uid: 1000,
      });
    });

    await expect(
      acquireWriterLease({ cellId: CELL_ID, persistentRoot: root }, harness.operations),
    ).rejects.toMatchObject({ code: "WRITER_LEASE_UNSAFE" });
  });

  it("rejects a symlinked SQLite sidecar before lease acquisition", async () => {
    const acquireWriterLease = runtimeExport<
      (
        configuration: { cellId: string; persistentRoot: string },
        operations: ReturnType<typeof createLeaseHarness>["operations"],
      ) => Promise<{ release(): Promise<void> }>
    >("acquireWriterLease");
    expect(acquireWriterLease).toBeTypeOf("function");
    if (!acquireWriterLease) return;
    const root = "/srv/openclaw-session";
    const harness = createLeaseHarness(root);
    harness.databaseEntries.set(`${harness.databasePath(root)}-journal`, {
      dev: 1,
      ino: 952,
      kind: "symlink",
      mode: 0o600,
      uid: 1000,
    });

    await expect(
      acquireWriterLease({ cellId: CELL_ID, persistentRoot: root }, harness.operations),
    ).rejects.toMatchObject({ code: "WRITER_LEASE_UNSAFE" });
  });

  it("revalidates the guarded database inode after every SQLite operation", async () => {
    const acquireWriterLease = runtimeExport<
      (
        configuration: { cellId: string; persistentRoot: string },
        operations: ReturnType<typeof createLeaseHarness>["operations"],
      ) => Promise<{ release(): Promise<void> }>
    >("acquireWriterLease");
    expect(acquireWriterLease).toBeTypeOf("function");
    if (!acquireWriterLease) return;
    const root = "/srv/openclaw-session";
    const harness = createLeaseHarness(root);
    const databasePath = harness.databasePath(root);
    let replaced = false;
    const operations = {
      ...harness.operations,
      async openDatabase(candidate: string, expected?: Parameters<typeof harness.operations.openDatabase>[1]) {
        const database = await harness.operations.openDatabase(candidate, expected);
        return {
          ...database,
          exec(sql: string) {
            database.exec(sql);
            if (!replaced && sql === "PRAGMA busy_timeout = 0") {
              replaced = true;
              harness.databaseEntries.set(databasePath, {
                dev: 1,
                ino: 953,
                kind: "file",
                mode: 0o600,
                uid: 1000,
              });
            }
          },
        };
      },
    };

    await expect(
      acquireWriterLease({ cellId: CELL_ID, persistentRoot: root }, operations),
    ).rejects.toMatchObject({ code: "WRITER_LEASE_UNSAFE" });
  });

  it("revalidates after a failed SQLite operation before classifying contention", async () => {
    const acquireWriterLease = runtimeExport<
      (
        configuration: { cellId: string; persistentRoot: string },
        operations: ReturnType<typeof createLeaseHarness>["operations"],
      ) => Promise<{ release(): Promise<void> }>
    >("acquireWriterLease");
    expect(acquireWriterLease).toBeTypeOf("function");
    if (!acquireWriterLease) return;
    const root = "/srv/openclaw-session";
    const harness = createLeaseHarness(root);
    const databasePath = harness.databasePath(root);
    const operations = {
      ...harness.operations,
      async openDatabase(candidate: string, expected?: Parameters<typeof harness.operations.openDatabase>[1]) {
        const database = await harness.operations.openDatabase(candidate, expected);
        return {
          ...database,
          exec(sql: string) {
            if (sql === "BEGIN EXCLUSIVE") {
              harness.databaseEntries.set(databasePath, {
                dev: 1,
                ino: 956,
                kind: "file",
                mode: 0o600,
                uid: 1000,
              });
              throw errno("SQLITE_BUSY");
            }
            database.exec(sql);
          },
        };
      },
    };

    await expect(
      acquireWriterLease({ cellId: CELL_ID, persistentRoot: root }, operations),
    ).rejects.toMatchObject({ code: "WRITER_LEASE_UNSAFE" });
  });

  it("rejects a canonical root replaced after its descriptor is pinned", async () => {
    const acquireWriterLease = runtimeExport<
      (
        configuration: { cellId: string; persistentRoot: string },
        operations: ReturnType<typeof createLeaseHarness>["operations"],
      ) => Promise<{ release(): Promise<void> }>
    >("acquireWriterLease");
    expect(acquireWriterLease).toBeTypeOf("function");
    if (!acquireWriterLease) return;
    const root = "/srv/openclaw-session";
    const harness = createLeaseHarness(root);
    const prepareFile = harness.operations.prepareFile;
    const operations = {
      ...harness.operations,
      async prepareFile(candidate: string) {
        const created = await prepareFile(candidate);
        harness.rootEntries.set(root, {
          dev: 1,
          ino: 954,
          kind: "symlink",
          mode: 0o700,
          uid: 1000,
        });
        return created;
      },
    };

    await expect(
      acquireWriterLease({ cellId: CELL_ID, persistentRoot: root }, operations),
    ).rejects.toMatchObject({ code: "WRITER_LEASE_UNSAFE" });
  });

  it("revalidates the guarded database around release rollback", async () => {
    const acquireWriterLease = runtimeExport<
      (
        configuration: { cellId: string; persistentRoot: string },
        operations: ReturnType<typeof createLeaseHarness>["operations"],
      ) => Promise<{ release(): Promise<void> }>
    >("acquireWriterLease");
    expect(acquireWriterLease).toBeTypeOf("function");
    if (!acquireWriterLease) return;
    const root = "/srv/openclaw-session";
    const harness = createLeaseHarness(root);
    const lease = await acquireWriterLease(
      { cellId: CELL_ID, persistentRoot: root },
      harness.operations,
    );
    harness.databaseEntries.set(harness.databasePath(root), {
      dev: 1,
      ino: 955,
      kind: "file",
      mode: 0o600,
      uid: 1000,
    });

    await expect(lease.release()).rejects.toMatchObject({
      code: "WRITER_LEASE_RELEASE_FAILED",
    });
    expect(harness.activeLocks.size).toBe(0);
    await lease.release();
  });

  it("rejects an unsafe cell identifier before opening the lease database", async () => {
    const acquireWriterLease = runtimeExport<
      (
        configuration: { cellId: string; persistentRoot: string },
        operations: ReturnType<typeof createLeaseHarness>["operations"],
      ) =>
        Promise<{ release(): Promise<void> }>
    >("acquireWriterLease");
    expect(acquireWriterLease).toBeTypeOf("function");
    if (!acquireWriterLease) return;
    const harness = createLeaseHarness("/srv/openclaw-session");

    await expect(
      acquireWriterLease(
        { cellId: "../unsafe", persistentRoot: "/srv/openclaw-session" },
        harness.operations,
      ),
    ).rejects.toMatchObject({ code: "WRITER_LEASE_UNSAFE" });
    expect(harness.events).toEqual([]);
  });

  it("an expired database handle cannot release a replacement lease after crash recovery", async () => {
    const acquireWriterLease = runtimeExport<
      (
        configuration: { cellId: string; persistentRoot: string },
        operations: ReturnType<typeof createLeaseHarness>["operations"],
      ) => Promise<{ release(): Promise<void> }>
    >("acquireWriterLease");
    expect(acquireWriterLease).toBeTypeOf("function");
    if (!acquireWriterLease) return;
    const harness = createLeaseHarness("/srv/openclaw-session");
    const expired = await acquireWriterLease(
      { cellId: CELL_ID, persistentRoot: "/srv/openclaw-session" },
      harness.operations,
    );
    harness.crash();
    const replacement = await acquireWriterLease(
      { cellId: CELL_ID, persistentRoot: "/srv/openclaw-session" },
      harness.operations,
    );

    await expired.release();
    await expect(
      acquireWriterLease(
        { cellId: CELL_ID, persistentRoot: "/srv/openclaw-session" },
        harness.operations,
      ),
    ).rejects.toMatchObject({ code: "WRITER_LEASE_ACTIVE" });
    await replacement.release();
  });

  it("holds the writer lease before consuming stdin and releases it after shutdown", async () => {
    const runSessionCryptoProcess = runtimeExport<
      (options: Record<string, unknown>) => Promise<number>
    >("runSessionCryptoProcess");
    expect(runSessionCryptoProcess).toBeTypeOf("function");
    if (!runSessionCryptoProcess) return;
    const harness = createLeaseHarness("/srv/openclaw-session");
    const output: string[] = [];
    const keyBytes = Buffer.from(
      JSON.stringify({
        activeGeneration: "g2",
        keys: { g2: Buffer.alloc(32, 0x22).toString("base64") },
        version: 1,
      }),
    );
    const input = {
      async *[Symbol.asyncIterator]() {
        expect(harness.activeLocks.size).toBe(1);
        yield Buffer.from(`${JSON.stringify(validRequest("persist"))}\n`, "utf8");
      },
    };

    const exitCode = await runSessionCryptoProcess({
      argv: [
        "--cell-id",
        CELL_ID,
        "--plaintext-root",
        "/run/openclaw-session",
        "--persistent-root",
        "/srv/openclaw-session",
      ],
      createStore: async () => ({
        persistFromPlaintext: async () => metadata(),
        restoreToPlaintext: async () => metadata(),
        rotateSession: async () => metadata(),
      }),
      keyFileOperations: {
        getuid: () => 1000,
        open: async () => ({
          close: async () => undefined,
          readFile: async () => keyBytes,
          stat: async () => ({ kind: "file", mode: 0o400, size: keyBytes.length, uid: 1000 }),
        }),
      },
      lines: input,
      platform: "linux",
      writeLine: async (line: string) => {
        output.push(line);
      },
      writerLeaseOperations: harness.operations,
    });

    expect(exitCode).toBe(0);
    expect(output.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ ok: true }),
    ]);
    expect(harness.activeLocks.size).toBe(0);
  });

  it("reports a duplicate writer as a sanitized fatal startup error", async () => {
    const acquireWriterLease = runtimeExport<
      (
        configuration: { cellId: string; persistentRoot: string },
        operations: ReturnType<typeof createLeaseHarness>["operations"],
      ) => Promise<{ release(): Promise<void> }>
    >("acquireWriterLease");
    const runSessionCryptoProcess = runtimeExport<
      (options: Record<string, unknown>) => Promise<number>
    >("runSessionCryptoProcess");
    expect(acquireWriterLease).toBeTypeOf("function");
    expect(runSessionCryptoProcess).toBeTypeOf("function");
    if (!acquireWriterLease || !runSessionCryptoProcess) return;
    const harness = createLeaseHarness("/srv/openclaw-session");
    const active = await acquireWriterLease(
      { cellId: CELL_ID, persistentRoot: "/srv/openclaw-session" },
      harness.operations,
    );
    const output: string[] = [];
    const canary = "WRITER-LEASE-CANARY";
    const keyBytes = Buffer.from(
      JSON.stringify({
        activeGeneration: "g2",
        keys: { g2: Buffer.alloc(32, 0x22).toString("base64") },
        version: 1,
      }),
    );

    const exitCode = await runSessionCryptoProcess({
      argv: [
        "--cell-id",
        CELL_ID,
        "--plaintext-root",
        "/run/openclaw-session",
        "--persistent-root",
        "/srv/openclaw-session",
      ],
      createStore: async () => ({
        persistFromPlaintext: async () => metadata(),
        restoreToPlaintext: async () => metadata(),
        rotateSession: async () => metadata(),
      }),
      keyFileOperations: {
        getuid: () => 1000,
        open: async () => ({
          close: async () => undefined,
          readFile: async () => keyBytes,
          stat: async () => ({ kind: "file", mode: 0o400, size: keyBytes.length, uid: 1000 }),
        }),
      },
      lines: asyncChunks(Buffer.from(canary)),
      platform: "linux",
      writeLine: async (line: string) => {
        output.push(line);
      },
      writerLeaseOperations: harness.operations,
    });

    expect(exitCode).toBe(1);
    expect(output).toHaveLength(1);
    expect(output[0]).not.toContain(canary);
    expect(JSON.parse(output[0]!)).toMatchObject({
      error: { code: "WRITER_LEASE_ACTIVE", fatal: true },
      ok: false,
    });
    await active.release();
  });

  it("accepts only trusted non-secret startup cell and root arguments", () => {
    const parseStartupArguments = runtimeExport<
      (argv: readonly string[]) => {
        cellId: string;
        persistentRoot: string;
        plaintextRoot: string;
      }
    >("parseStartupArguments");
    expect(parseStartupArguments).toBeTypeOf("function");
    if (!parseStartupArguments) return;

    expect(
      parseStartupArguments([
        "--cell-id",
        CELL_ID,
        "--plaintext-root",
        "/run/openclaw-session",
        "--persistent-root",
        "/srv/openclaw-session",
      ]),
    ).toEqual({
      cellId: CELL_ID,
      persistentRoot: "/srv/openclaw-session",
      plaintextRoot: "/run/openclaw-session",
    });
    expect(() =>
      parseStartupArguments([
        "--cell-id",
        CELL_ID,
        "--plaintext-root",
        "/run/openclaw-session",
        "--persistent-root",
        "/srv/openclaw-session",
        "--key-path",
        "/tmp/attacker-key",
      ]),
    ).toThrow(/startup argument/i);
  });

  it("loads the exact keyring only from the hardcoded protected secret file", async () => {
    const loadRuntimeKeyring = runtimeExport<
      (operations: {
        getuid(): number;
        open(candidate: string, flags: number): Promise<{
          close(): Promise<void>;
          readFile(): Promise<Buffer>;
          stat(): Promise<{ kind: string; mode: number; size: number; uid: number }>;
        }>;
      }) => Promise<{ activeGeneration: string; keys: ReadonlyMap<string, Uint8Array> }>
    >("loadRuntimeKeyring");
    expect(loadRuntimeKeyring).toBeTypeOf("function");
    if (!loadRuntimeKeyring) return;
    const visited: string[] = [];

    const keyring = await loadRuntimeKeyring({
      getuid: () => 1000,
      open: async (candidate, flags) => {
        visited.push(candidate);
        const noFollow = fsConstants.O_NOFOLLOW ?? 0x20000;
        expect(flags & noFollow).toBe(noFollow);
        return {
          close: async () => undefined,
          readFile: async () =>
            Buffer.from(
              JSON.stringify({
                activeGeneration: "g2",
                keys: {
                  g1: Buffer.alloc(32, 0x11).toString("base64"),
                  g2: Buffer.alloc(32, 0x22).toString("base64"),
                },
                version: 1,
              }),
            ),
          stat: async () => ({ kind: "file", mode: 0o400, size: 200, uid: 1000 }),
        };
      },
    });

    expect(visited).toEqual(["/run/secrets/openclaw_session_key"]);
    expect(keyring.activeGeneration).toBe("g2");
    expect(keyring.keys.get("g2")).toEqual(Buffer.alloc(32, 0x22));
  });

  it("rejects an oversized key file from descriptor stat before reading bytes", async () => {
    const loadRuntimeKeyring = runtimeExport<
      (operations: {
        getuid(): number;
        open(candidate: string, flags: number): Promise<{
          close(): Promise<void>;
          readFile(): Promise<Buffer>;
          stat(): Promise<{ kind: string; mode: number; size: number; uid: number }>;
        }>;
      }) => Promise<unknown>
    >("loadRuntimeKeyring");
    expect(loadRuntimeKeyring).toBeTypeOf("function");
    if (!loadRuntimeKeyring) return;
    let reads = 0;

    await expect(
      loadRuntimeKeyring({
        getuid: () => 1000,
        open: async () => ({
          close: async () => undefined,
          readFile: async () => {
            reads += 1;
            return Buffer.from("KEY-FILE-CANARY");
          },
          stat: async () => ({ kind: "file", mode: 0o400, size: 64 * 1024 + 1, uid: 1000 }),
        }),
      }),
    ).rejects.toMatchObject({ code: "KEY_FILE_FORMAT" });
    expect(reads).toBe(0);
  });

  it.each([
    ["symlink", { kind: "symlink", mode: 0o400, size: 2, uid: 1000 }],
    ["permissions", { kind: "file", mode: 0o440, size: 2, uid: 1000 }],
    ["owner", { kind: "file", mode: 0o400, size: 2, uid: 0 }],
  ])("rejects an unsafe key file: %s", async (_label, stat) => {
    const loadRuntimeKeyring = runtimeExport<
      (operations: {
        getuid(): number;
        open(candidate: string, flags: number): Promise<{
          close(): Promise<void>;
          readFile(): Promise<Buffer>;
          stat(): Promise<typeof stat>;
        }>;
      }) => Promise<unknown>
    >("loadRuntimeKeyring");
    expect(loadRuntimeKeyring).toBeTypeOf("function");
    if (!loadRuntimeKeyring) return;

    await expect(
      loadRuntimeKeyring({
        getuid: () => 1000,
        open: async () => ({
          close: async () => undefined,
          readFile: async () => Buffer.from("{}"),
          stat: async () => stat,
        }),
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^KEY_FILE_/) });
  });

  it("fails startup nonzero with a sanitized key-file error", async () => {
    const runSessionCryptoProcess = runtimeExport<
      (options: Record<string, unknown>) => Promise<number>
    >("runSessionCryptoProcess");
    expect(runSessionCryptoProcess).toBeTypeOf("function");
    if (!runSessionCryptoProcess) return;
    const output: string[] = [];
    const canary = "KEY-CONTENT-CANARY-DO-NOT-LEAK";

    const exitCode = await runSessionCryptoProcess({
      argv: [
        "--cell-id",
        CELL_ID,
        "--plaintext-root",
        "/run/openclaw-session",
        "--persistent-root",
        "/srv/openclaw-session",
      ],
      keyFileOperations: {
        getuid: () => 1000,
        open: async () => {
          throw new Error(canary, { cause: Buffer.from(canary) });
        },
      },
      lines: asyncLines(),
      platform: "linux",
      writeLine: async (line: string) => {
        output.push(line);
      },
    });

    expect(exitCode).toBe(1);
    expect(output).toHaveLength(1);
    expect(output[0]).not.toContain(canary);
    expect(JSON.parse(output[0]!)).toMatchObject({
      error: { fatal: true },
      id: null,
      ok: false,
      version: 1,
    });
  });
});

describe("versioned daemon protocol", () => {
  it("bounds an oversized NDJSON request while streaming and continues at the next line", async () => {
    const runStdioByteStream = runtimeExport<
      (options: {
        daemon: unknown;
        input: AsyncIterable<string | Uint8Array>;
        writeLine(line: string): Promise<void>;
      }) => Promise<number>
    >("runStdioByteStream");
    expect(runStdioByteStream).toBeTypeOf("function");
    if (!runStdioByteStream) return;
    const canary = "STDIO-OVERSIZE-CANARY";
    const oversized = Buffer.from(canary.repeat(4_000), "utf8");
    let calls = 0;
    const store = {
      persistFromPlaintext: async () => {
        calls += 1;
        return metadata();
      },
      restoreToPlaintext: async () => metadata(),
      rotateSession: async () => metadata(),
    };
    const output: string[] = [];

    const exitCode = await runStdioByteStream({
      daemon: new daemonModule.SessionCryptoDaemon(store),
      input: asyncChunks(
        oversized.subarray(0, 40_000),
        oversized.subarray(40_000),
        Buffer.from(`\n${JSON.stringify(validRequest("persist"))}\n`, "utf8"),
      ),
      writeLine: async (line) => {
        output.push(line);
      },
    });

    expect(exitCode).toBe(0);
    expect(calls).toBe(1);
    expect(output).toHaveLength(2);
    expect(output.join("\n")).not.toContain(canary);
    expect(output.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({ code: "MALFORMED_REQUEST", fatal: false }),
        ok: false,
      }),
      expect.objectContaining({ ok: true }),
    ]);
  });

  it("runtime-validates exact command schemas and forbids generation/root/key fields", () => {
    const parseRuntimeRequest = runtimeExport<(value: unknown) => unknown>("parseRuntimeRequest");
    expect(parseRuntimeRequest).toBeTypeOf("function");
    if (!parseRuntimeRequest) return;

    expect(parseRuntimeRequest(validRequest("persist"))).toEqual(validRequest("persist"));
    for (const field of ["generation", "persistentRoot", "plaintextRoot", "keyPath"] as const) {
      expect(() => parseRuntimeRequest({ ...validRequest("rotate"), [field]: "attacker" })).toThrow(
        /request schema/i,
      );
    }
    expect(() => parseRuntimeRequest({ ...validRequest("restore"), version: 2 })).toThrow(
      /request schema/i,
    );
    expect(() =>
      parseRuntimeRequest({ ...validRequest("rotate"), expectedEnvelopeVersion: null }),
    ).toThrow(/request schema/i);
  });

  it("dispatches persist, restore, and active-generation rotate with expected-envelope CAS", async () => {
    const calls: unknown[][] = [];
    const store = {
      persistFromPlaintext: async (...args: unknown[]) => {
        calls.push(["persist", ...args]);
        return metadata();
      },
      restoreToPlaintext: async (...args: unknown[]) => {
        calls.push(["restore", ...args]);
        return metadata();
      },
      rotateSession: async (...args: unknown[]) => {
        calls.push(["rotate", ...args]);
        return metadata();
      },
    };
    const Daemon = daemonModule.SessionCryptoDaemon as unknown as new (store: unknown) => {
      handle(value: unknown): Promise<unknown>;
    };
    const daemon = new Daemon(store);

    const responses = await Promise.all([
      daemon.handle(validRequest("persist")),
      daemon.handle(validRequest("restore")),
      daemon.handle(validRequest("rotate")),
    ]);

    expect(calls).toEqual([
      ["persist", "account/session.json", null],
      ["restore", "account/session.json", VERSION_A],
      ["rotate", "account/session.json", VERSION_A],
    ]);
    expect(responses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ok: true,
          result: expect.not.objectContaining({ nonce: expect.anything(), plaintext: expect.anything() }),
          version: 1,
        }),
      ]),
    );
  });

  it("sanitizes fatal cause graphs, latches unhealthy, and never handles another command", async () => {
    const canary = "PLAINTEXT-CANARY-NEVER-SERIALIZE";
    let calls = 0;
    const store = {
      persistFromPlaintext: async () => {
        calls += 1;
        throw new SessionCryptoError("AUTHENTICATION_FAILED", canary, {
          cause: new AggregateError([new Error(canary), Buffer.from(canary)]),
        });
      },
      restoreToPlaintext: async () => metadata(),
      rotateSession: async () => metadata(),
    };
    const Daemon = daemonModule.SessionCryptoDaemon as unknown as new (store: unknown) => {
      handle(value: unknown): Promise<unknown>;
    };
    const daemon = new Daemon(store);

    const fatal = await daemon.handle(validRequest("persist"));
    const unhealthy = await daemon.handle(validRequest("persist"));
    const serialized = JSON.stringify([fatal, unhealthy]);

    expect(calls).toBe(1);
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain("cause");
    expect(serialized).not.toContain("stack");
    expect(fatal).toMatchObject({ error: { code: "AUTHENTICATION_FAILED", fatal: true }, ok: false });
    expect(unhealthy).toMatchObject({ error: { code: "DAEMON_UNHEALTHY", fatal: true }, ok: false });
  });

  it("keeps CAS conflicts nonfatal and remains healthy for a later request", async () => {
    let attempts = 0;
    const store = {
      persistFromPlaintext: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new SessionCryptoError("ENVELOPE_CONFLICT", "internal version details");
        }
        return metadata();
      },
      restoreToPlaintext: async () => metadata(),
      rotateSession: async () => metadata(),
    };
    const Daemon = daemonModule.SessionCryptoDaemon as unknown as new (store: unknown) => {
      handle(value: unknown): Promise<unknown>;
    };
    const daemon = new Daemon(store);

    expect(await daemon.handle(validRequest("persist"))).toMatchObject({
      error: { code: "ENVELOPE_CONFLICT", fatal: false },
      ok: false,
    });
    expect(await daemon.handle({ ...validRequest("persist"), id: "request-after-conflict" })).toMatchObject({
      ok: true,
    });
  });

  it("reports ambiguous durability as a sanitized fatal protocol error", async () => {
    const canary = "AMBIGUOUS-DURABILITY-CANARY";
    const store = {
      persistFromPlaintext: async () => metadata(),
      restoreToPlaintext: async () => metadata(),
      rotateSession: async () => {
        throw new AmbiguousDurabilityError(canary, { cause: Buffer.from(canary) });
      },
    };
    const daemon = new daemonModule.SessionCryptoDaemon(store);

    const response = await daemon.handle(validRequest("rotate"));

    expect(response).toMatchObject({
      error: { code: "AMBIGUOUS_DURABILITY", fatal: true },
      ok: false,
    });
    expect(JSON.stringify(response)).not.toContain(canary);
  });

  it("sanitizes malformed JSON, stops on a fatal response, and ignores later lines", async () => {
    const runStdioDaemon = runtimeExport<
      (options: {
        daemon: unknown;
        lines: AsyncIterable<string>;
        writeLine(line: string): Promise<void>;
      }) => Promise<number>
    >("runStdioDaemon");
    expect(runStdioDaemon).toBeTypeOf("function");
    if (!runStdioDaemon) return;
    const canary = "MALFORMED-JSON-CANARY";
    let calls = 0;
    const store = {
      persistFromPlaintext: async () => {
        calls += 1;
        throw new SessionCryptoError("MALFORMED_ENVELOPE", canary, {
          cause: Buffer.from(canary),
        });
      },
      restoreToPlaintext: async () => metadata(),
      rotateSession: async () => metadata(),
    };
    const Daemon = daemonModule.SessionCryptoDaemon as unknown as new (store: unknown) => unknown;
    const output: string[] = [];

    const exitCode = await runStdioDaemon({
      daemon: new Daemon(store),
      lines: asyncLines(
        `{"version":1,"id":"${canary}`,
        JSON.stringify(validRequest("persist")),
        JSON.stringify({ ...validRequest("restore"), id: "must-not-run" }),
      ),
      writeLine: async (line) => {
        output.push(line);
      },
    });

    expect(exitCode).toBe(1);
    expect(calls).toBe(1);
    expect(output).toHaveLength(2);
    expect(output.join("\n")).not.toContain(canary);
    expect(output.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({ code: "MALFORMED_REQUEST", fatal: false }),
        ok: false,
      }),
      expect.objectContaining({
        error: expect.objectContaining({ code: "MALFORMED_ENVELOPE", fatal: true }),
        ok: false,
      }),
    ]);
  });
});
