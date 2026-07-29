import path from "node:path";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  AmbiguousDurabilityError,
  SessionCryptoEngine,
  SessionCryptoError,
  SessionCryptoStore,
  assertSafeRootConfiguration,
  durableAtomicWrite,
  inspectEnvelope,
  normalizeLogicalSessionPath,
  type FileHandleOperations,
  type FileSystemOperations,
  type PathEntry,
  type RandomBytes,
  type SessionCryptoStoreConfiguration,
} from "./crypto.js";
import { SessionCryptoDaemon } from "./daemon.js";

const CELL_A = "dddd0000-0000-4000-8000-000000000001";
const CELL_B = "dddd0000-0000-4000-8000-000000000002";
const KEY_A = Buffer.alloc(32, 0x11);
const KEY_B = Buffer.alloc(32, 0x22);
const KEY_C = Buffer.alloc(32, 0x33);

function sequenceRandom(...values: Buffer[]): RandomBytes {
  let index = 0;
  return (size) => {
    const value = values[index++];
    if (!value || value.length !== size) {
      throw new Error(`Missing ${size}-byte random fixture at index ${index - 1}`);
    }
    return Buffer.from(value);
  };
}

function createEngine(options: {
  cellId?: string;
  activeGeneration?: string;
  keys?: ReadonlyMap<string, Uint8Array>;
  randomBytes?: RandomBytes;
} = {}): SessionCryptoEngine {
  return new SessionCryptoEngine({
    cellId: options.cellId ?? CELL_A,
    activeGeneration: options.activeGeneration ?? "g1",
    keys: options.keys ?? new Map([["g1", KEY_A], ["g2", KEY_B]]),
    randomBytes: options.randomBytes ?? sequenceRandom(Buffer.alloc(12, 1)),
  });
}

function mutateEnvelope(
  envelope: Buffer,
  mutation: (value: Record<string, unknown>) => void,
): Buffer {
  const value = JSON.parse(envelope.toString("utf8")) as Record<string, unknown>;
  mutation(value);
  return Buffer.from(JSON.stringify(value), "utf8");
}

function envelopeVersion(envelope: Uint8Array): string {
  return createHash("sha256").update(envelope).digest("hex");
}

function countingRandom(): RandomBytes {
  let nonce = 0;
  let suffix = 0;
  return (size) => {
    if (size === 12) return Buffer.alloc(12, ++nonce);
    if (size === 8) return Buffer.alloc(8, ++suffix);
    throw new Error(`Unexpected randomness request for ${size} bytes`);
  };
}

describe("AES-256-GCM envelope", () => {
  it("round trips session bytes without placing plaintext in the ciphertext envelope", () => {
    const plaintext = Buffer.from("fixture-plaintext-alpha", "utf8");
    const engine = createEngine();

    const envelope = engine.encrypt("accounts/main/session.json", plaintext);
    const decrypted = engine.decrypt("accounts/main/session.json", envelope);
    const metadata = inspectEnvelope(envelope);

    expect(decrypted.plaintext).toEqual(plaintext);
    expect(decrypted.generation).toBe("g1");
    expect(envelope.toString("utf8")).not.toContain(plaintext.toString("utf8"));
    expect(metadata).toMatchObject({
      algorithm: "AES-256-GCM",
      generation: "g1",
      nonceLength: 12,
      tagLength: 16,
      version: 1,
    });
  });

  it("uses an injected 12-byte nonce source for standalone envelope fixtures", () => {
    const nonce = Buffer.alloc(12, 0x41);
    const engine = createEngine({ randomBytes: sequenceRandom(nonce) });

    const metadata = inspectEnvelope(engine.encrypt("session.json", Buffer.from("one")));

    expect(metadata.nonce).toBe(nonce.toString("base64"));
  });

  it("fails closed for the wrong key, generation, cell, path, or authentication tag", () => {
    const engine = createEngine();
    const envelope = engine.encrypt(
      "sessions/a.json",
      Buffer.from("fixture-plaintext-beta"),
    );
    const wrongKeyEngine = createEngine({ keys: new Map([["g1", KEY_C]]) });
    const wrongCellEngine = createEngine({ cellId: CELL_B });
    const substitutedGeneration = mutateEnvelope(envelope, (value) => {
      value.keyGeneration = "g2";
    });
    const unknownGeneration = mutateEnvelope(envelope, (value) => {
      value.keyGeneration = "missing";
    });
    const badTag = mutateEnvelope(envelope, (value) => {
      const tag = Buffer.from(String(value.tag), "base64");
      tag[0] = (tag[0] ?? 0) ^ 0xff;
      value.tag = tag.toString("base64");
    });

    expect(() => wrongKeyEngine.decrypt("sessions/a.json", envelope)).toThrow(SessionCryptoError);
    expect(() => engine.decrypt("sessions/a.json", substitutedGeneration)).toThrow(
      /authentication/i,
    );
    expect(() => createEngine().decrypt("sessions/a.json", unknownGeneration)).toThrow(
      /unknown key generation/i,
    );
    expect(() => wrongCellEngine.decrypt("sessions/a.json", envelope)).toThrow(/authentication/i);
    expect(() => createEngine().decrypt("sessions/b.json", envelope)).toThrow(/authentication/i);
    expect(() => createEngine().decrypt("sessions/a.json", badTag)).toThrow(/authentication/i);
  });

  it.each([
    ["invalid JSON", Buffer.from("not-json")],
    ["non-object JSON", Buffer.from("[]")],
    [
      "non-canonical base64",
      Buffer.from(
        JSON.stringify({
          algorithm: "AES-256-GCM",
          ciphertext: "AA==",
          keyGeneration: "g1",
          nonce: "not base64",
          tag: Buffer.alloc(16).toString("base64"),
          version: 1,
        }),
      ),
    ],
    [
      "wrong nonce length",
      Buffer.from(
        JSON.stringify({
          algorithm: "AES-256-GCM",
          ciphertext: "",
          keyGeneration: "g1",
          nonce: Buffer.alloc(11).toString("base64"),
          tag: Buffer.alloc(16).toString("base64"),
          version: 1,
        }),
      ),
    ],
    [
      "wrong tag length",
      Buffer.from(
        JSON.stringify({
          algorithm: "AES-256-GCM",
          ciphertext: "",
          keyGeneration: "g1",
          nonce: Buffer.alloc(12).toString("base64"),
          tag: Buffer.alloc(15).toString("base64"),
          version: 1,
        }),
      ),
    ],
  ])("rejects malformed envelopes: %s", (_label, envelope) => {
    expect(() => createEngine().decrypt("session.json", envelope)).toThrow(SessionCryptoError);
  });

  it("requires explicit known generations backed by exactly 32-byte keys", () => {
    expect(
      () =>
        new SessionCryptoEngine({
          cellId: CELL_A,
          activeGeneration: "g2",
          keys: new Map([["g1", KEY_A]]),
        }),
    ).toThrow(/active key generation/i);
    expect(
      () =>
        new SessionCryptoEngine({
          cellId: CELL_A,
          activeGeneration: "g1",
          keys: new Map([["g1", Buffer.alloc(31)]]),
        }),
    ).toThrow(/32 bytes/i);
  });

  it("rejects duplicate AES key bytes assigned to different generations", () => {
    expect(
      () =>
        new SessionCryptoEngine({
          activeGeneration: "g1",
          cellId: CELL_A,
          keys: new Map([
            ["g1", KEY_A],
            ["g2", Buffer.from(KEY_A)],
          ]),
        }),
    ).toThrow(/duplicate key bytes/i);
  });

  it("rejects an envelope above the reader limit before it can be persisted", () => {
    const plaintext = Buffer.from("bounded-envelope-fixture");
    const reference = createEngine({
      randomBytes: sequenceRandom(Buffer.alloc(12, 0x35)),
    }).encrypt("session.json", plaintext);
    const exactBoundary = new SessionCryptoEngine({
      activeGeneration: "g1",
      cellId: CELL_A,
      keys: new Map([["g1", KEY_A]]),
      maxEnvelopeBytes: reference.length,
      randomBytes: sequenceRandom(Buffer.alloc(12, 0x36)),
    });
    const belowBoundary = new SessionCryptoEngine({
      activeGeneration: "g1",
      cellId: CELL_A,
      keys: new Map([["g1", KEY_A]]),
      maxEnvelopeBytes: reference.length - 1,
      randomBytes: sequenceRandom(Buffer.alloc(12, 0x37)),
    });

    expect(exactBoundary.encrypt("session.json", plaintext)).toHaveLength(reference.length);
    expect(() => belowBoundary.encrypt("session.json", plaintext)).toThrow(/envelope.*limit/i);
  });
});

describe("logical path and root safety", () => {
  it("normalizes a valid relative logical path", () => {
    expect(normalizeLogicalSessionPath("accounts/main/session.json")).toBe(
      "accounts/main/session.json",
    );
  });

  it.each([
    "",
    ".",
    "..",
    "accounts/../session.json",
    "accounts/./session.json",
    "accounts//session.json",
    "accounts/session.json/",
    "/absolute/session.json",
    "C:\\absolute\\session.json",
    "\\\\server\\share\\session.json",
    "accounts\\session.json",
    "accounts/\0/session.json",
    "accounts/session.json:alternate-stream",
    "accounts/session.json.",
    "accounts/NUL",
    "accounts/aux.txt",
    ".openclaw-nonce-v1-g2-deadbeef.reserve",
    ".session-crypto-writer.sqlite",
    ".session-crypto-writer.sqlite-journal",
  ])("rejects unsafe logical path %j", (logicalPath) => {
    expect(() => normalizeLogicalSessionPath(logicalPath)).toThrow(SessionCryptoError);
  });

  it("rejects lexical overlap, real-path aliases, and non-tmpfs plaintext roots", async () => {
    const base = path.resolve("root-safety");
    const plaintextRoot = path.join(base, "plain");
    const persistentRoot = path.join(base, "cipher");
    const directoryInspector = async (): Promise<PathEntry> => ({ kind: "directory" });

    await expect(
      assertSafeRootConfiguration(
        { plaintextRoot, persistentRoot: path.join(plaintextRoot, "nested") },
        {
          inspectPath: directoryInspector,
          isTmpfsRoot: async () => true,
          realpath: async (candidate) => candidate,
        },
      ),
    ).rejects.toThrow(/overlap/i);

    await expect(
      assertSafeRootConfiguration(
        { plaintextRoot, persistentRoot },
        {
          inspectPath: directoryInspector,
          isTmpfsRoot: async (candidate) => candidate === plaintextRoot,
          realpath: async () => path.join(base, "same-real-path"),
        },
      ),
    ).rejects.toThrow(/alias|overlap/i);

    await expect(
      assertSafeRootConfiguration(
        { plaintextRoot, persistentRoot },
        {
          inspectPath: directoryInspector,
          isTmpfsRoot: async () => false,
          realpath: async (candidate) => candidate,
        },
      ),
    ).rejects.toThrow(/tmpfs/i);

    await expect(
      assertSafeRootConfiguration(
        { plaintextRoot, persistentRoot },
        {
          inspectPath: directoryInspector,
          isTmpfsRoot: async () => true,
          realpath: async (candidate) => candidate,
        },
      ),
    ).rejects.toThrow(/persistent.*tmpfs/i);
  });

  it.each(["symlink", "reparse"] as const)(
    "rejects a %s component in a configured root",
    async (kind) => {
      const base = path.resolve("unsafe-root");
      const plaintextRoot = path.join(base, "plain");
      const persistentRoot = path.join(base, "cipher");

      await expect(
        assertSafeRootConfiguration(
          { plaintextRoot, persistentRoot },
          {
            inspectPath: async (candidate) =>
              candidate === plaintextRoot ? { kind } : { kind: "directory" },
            isTmpfsRoot: async (candidate) => candidate === plaintextRoot,
            realpath: async (candidate) => candidate,
          },
        ),
      ).rejects.toThrow(new RegExp(kind, "i"));
    },
  );
});

type FailurePoint = "write" | "file-fsync" | "rename" | "dir-fsync" | "second-dir-fsync";

class OrderedFileSystem implements FileSystemOperations {
  readonly events: string[] = [];
  readonly files = new Map<string, Buffer>();
  readonly directories = new Set<string>();
  private directorySyncCount = 0;
  private readonly identities = new Map<string, number>();
  private nextInode = 1;

  constructor(private readonly failure?: FailurePoint) {}

  async mkdir(directoryPath: string): Promise<void> {
    this.events.push(`mkdir:${directoryPath}`);
    this.directories.add(directoryPath);
  }

  async open(filePath: string, flags: string | number, mode?: number): Promise<FileHandleOperations> {
    const directoryHandle =
      flags === "r" ||
      (typeof flags === "number" &&
        (flags & (fsConstants.O_DIRECTORY ?? 0x10000)) !== 0);
    const exclusiveCreate =
      typeof flags === "number" &&
      (flags & fsConstants.O_CREAT) !== 0 &&
      (flags & fsConstants.O_EXCL) !== 0;
    if (!directoryHandle && exclusiveCreate && this.files.has(filePath)) {
      throw Object.assign(new Error("already exists"), { code: "EEXIST" });
    }
    this.events.push(
      directoryHandle
        ? `open-dir:${filePath}`
        : `open-temp:${filePath}:${String(flags)}:${String(mode)}`,
    );
    if (directoryHandle && !this.directories.has(filePath)) {
      const entry = await this.inspectPath(filePath);
      throw Object.assign(new Error(entry.kind === "missing" ? "missing" : "not a directory"), {
        code: entry.kind === "missing" ? "ENOENT" : "ENOTDIR",
      });
    }
    if (!directoryHandle && exclusiveCreate) this.files.set(filePath, Buffer.alloc(0));
    if (!directoryHandle && !this.files.has(filePath)) {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }
    let bytes = this.files.get(filePath) ?? Buffer.alloc(0);

    return {
      descriptorPath: (relativePath = "") =>
        relativePath ? path.join(filePath, ...relativePath.split("/")) : filePath,
      readFile: async () => {
        this.events.push(`read-handle:${filePath}`);
        const value = this.files.get(filePath);
        if (!value) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return Buffer.from(value);
      },
      stat: async () => {
        const entry = await this.inspectPath(filePath);
        if (entry.kind === "missing") {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        }
        return entry;
      },
      writeFile: async (value) => {
        this.events.push(`write:${filePath}`);
        if (this.failure === "write") throw new Error("injected write failure");
        bytes = Buffer.from(value);
        this.files.set(filePath, bytes);
      },
      sync: async () => {
        this.events.push(`${directoryHandle ? "fsync-dir" : "fsync-file"}:${filePath}`);
        if (!directoryHandle && this.failure === "file-fsync") {
          throw new Error("injected file fsync failure");
        }
        if (directoryHandle && this.failure === "dir-fsync") {
          throw new Error("injected directory fsync failure");
        }
        if (directoryHandle) {
          this.directorySyncCount += 1;
          if (this.failure === "second-dir-fsync" && this.directorySyncCount === 2) {
            throw new Error("injected second directory fsync failure");
          }
        }
      },
      close: async () => {
        this.events.push(`${directoryHandle ? "close-dir" : "close-file"}:${filePath}`);
      },
    };
  }

  async rename(from: string, to: string): Promise<void> {
    this.events.push(`rename:${from}->${to}`);
    if (this.failure === "rename") throw new Error("injected rename failure");
    const value = this.files.get(from);
    if (!value) throw new Error("source is missing");
    this.files.set(to, value);
    this.files.delete(from);
  }

  async unlink(filePath: string): Promise<void> {
    this.events.push(`unlink:${filePath}`);
    this.files.delete(filePath);
  }

  async readFile(filePath: string): Promise<Buffer> {
    this.events.push(`read:${filePath}`);
    const value = this.files.get(filePath);
    if (!value) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return Buffer.from(value);
  }

  async inspectPath(candidate: string): Promise<PathEntry> {
    if (this.files.has(candidate)) return { dev: 1, ino: this.identity(candidate), kind: "file" };
    if (this.directories.has(candidate)) {
      return { dev: 1, ino: this.identity(candidate), kind: "directory" };
    }
    return { kind: "missing" };
  }

  async realpath(candidate: string): Promise<string> {
    return candidate;
  }

  private identity(candidate: string): number {
    let identity = this.identities.get(candidate);
    if (identity === undefined) {
      identity = this.nextInode++;
      this.identities.set(candidate, identity);
    }
    return identity;
  }
}

describe("durable persistent writes", () => {
  const suffix = Buffer.from("0102030405060708", "hex");
  const randomBytes = sequenceRandom(suffix);

  it("uses restrictive same-directory temp, full write, fsync, close, rename, then directory fsync", async () => {
    const fs = new OrderedFileSystem();
    const target = path.resolve("durable", "session.enc");
    const parent = path.dirname(target);
    const temporary = path.join(parent, ".session.enc.tmp-0102030405060708");
    fs.directories.add(parent);
    const parentHandle = await fs.open(
      parent,
      fsConstants.O_RDONLY |
        (fsConstants.O_DIRECTORY ?? 0x10000) |
        (fsConstants.O_NOFOLLOW ?? 0x20000),
    );
    fs.events.length = 0;

    await durableAtomicWrite(fs, parentHandle, "session.enc", Buffer.from("ciphertext"), randomBytes);

    expect(fs.events).toEqual([
      expect.stringMatching(`^open-temp:${temporary.replaceAll("\\", "\\\\")}:\\d+:384$`),
      `write:${temporary}`,
      `fsync-file:${temporary}`,
      `close-file:${temporary}`,
      `rename:${temporary}->${target}`,
      `fsync-dir:${parent}`,
    ]);
    expect(fs.files.get(target)).toEqual(Buffer.from("ciphertext"));
  });

  it.each(["write", "file-fsync", "rename"] as const)(
    "cleans the temp and preserves the last good ciphertext when %s fails before rename",
    async (failure) => {
      const fs = new OrderedFileSystem(failure);
      const target = path.resolve("durable", `${failure}.enc`);
      const parent = path.dirname(target);
      fs.directories.add(parent);
      fs.files.set(target, Buffer.from("old-ciphertext"));
      const parentHandle = await fs.open(
        parent,
        fsConstants.O_RDONLY |
          (fsConstants.O_DIRECTORY ?? 0x10000) |
          (fsConstants.O_NOFOLLOW ?? 0x20000),
      );

      await expect(
        durableAtomicWrite(
          fs,
          parentHandle,
          path.basename(target),
          Buffer.from("new-ciphertext"),
          sequenceRandom(suffix),
        ),
      ).rejects.toThrow(/injected/i);

      expect(fs.files.get(target)).toEqual(Buffer.from("old-ciphertext"));
      expect([...fs.files.keys()].filter((file) => file.includes(".tmp-"))).toEqual([]);
      expect(fs.events.some((event) => event.startsWith("unlink:"))).toBe(true);
    },
  );

  it("surfaces directory-fsync failure as ambiguous after rename without plaintext fallback", async () => {
    const fs = new OrderedFileSystem("dir-fsync");
    const target = path.resolve("durable", "ambiguous.enc");
    const parent = path.dirname(target);
    fs.directories.add(parent);
    fs.files.set(target, Buffer.from("old-ciphertext"));
    const parentHandle = await fs.open(
      parent,
      fsConstants.O_RDONLY |
        (fsConstants.O_DIRECTORY ?? 0x10000) |
        (fsConstants.O_NOFOLLOW ?? 0x20000),
    );

    await expect(
      durableAtomicWrite(
        fs,
        parentHandle,
        path.basename(target),
        Buffer.from("new-ciphertext"),
        sequenceRandom(suffix),
      ),
    ).rejects.toBeInstanceOf(AmbiguousDurabilityError);

    expect(fs.files.get(target)).toEqual(Buffer.from("new-ciphertext"));
    expect([...fs.files.values()].some((value) => value.equals(Buffer.from("plaintext")))).toBe(false);
  });
});

class MemoryFileSystem extends OrderedFileSystem {
  readonly unsafeEntries = new Map<string, PathEntry>();
  readonly aliases = new Map<string, string>();

  override async inspectPath(candidate: string): Promise<PathEntry> {
    const unsafe = this.unsafeEntries.get(candidate);
    if (unsafe) return unsafe;
    if (candidate === path.parse(candidate).root) return { kind: "directory" };
    const known = await super.inspectPath(candidate);
    if (known.kind !== "missing") return known;

    for (const directory of this.directories) {
      if (directory.startsWith(`${candidate}${path.sep}`)) return { kind: "directory" };
    }
    return { kind: "missing" };
  }

  override async realpath(candidate: string): Promise<string> {
    return this.aliases.get(candidate) ?? candidate;
  }
}

function createStoreFixture(options: {
  activeGeneration?: string;
  failure?: FailurePoint;
  keys?: ReadonlyMap<string, Uint8Array>;
  maxEnvelopeBytes?: number;
  random?: Buffer[];
  randomBytes?: RandomBytes;
} = {}) {
  const base = path.resolve("memory-store");
  const plaintextRoot = path.join(base, "plain");
  const persistentRoot = path.join(base, "cipher");
  const fs = new MemoryFileSystem(options.failure);
  fs.directories.add(base);
  fs.directories.add(plaintextRoot);
  fs.directories.add(persistentRoot);
  fs.directories.add(path.join(plaintextRoot, "account"));
  fs.directories.add(path.join(persistentRoot, "account"));
  const randomValues = options.random ?? [Buffer.alloc(12, 0x51), Buffer.alloc(8, 0x61)];

  return {
    fs,
    plaintextRoot,
    persistentRoot,
    create: () => {
      const configuration: SessionCryptoStoreConfiguration = {
        activeGeneration: options.activeGeneration ?? "g1",
        cellId: CELL_A,
        keys: options.keys ?? new Map([["g1", KEY_A], ["g2", KEY_B]]),
        persistentRoot,
        plaintextRoot,
      };
      if (options.maxEnvelopeBytes !== undefined) {
        configuration.maxEnvelopeBytes = options.maxEnvelopeBytes;
      }
      return SessionCryptoStore.create(
        configuration,
        {
          fs,
          isTmpfsRoot: async (candidate) => candidate === plaintextRoot,
          platform: "linux",
          randomBytes: options.randomBytes ?? sequenceRandom(...randomValues),
        },
      );
    },
  };
}

type RaceEntry = PathEntry & {
  dev: number;
  ino: number;
};

type DescriptorFileHandle = FileHandleOperations & {
  descriptorPath(relativePath?: string): string;
  readFile(): Promise<Buffer>;
  stat(): Promise<RaceEntry>;
};

class RaceHookFileSystem implements FileSystemOperations {
  readonly directories = new Map<string, RaceEntry>();
  readonly files = new Map<string, { bytes: Buffer; entry: RaceEntry }>();
  readonly symlinks = new Map<string, string>();
  beforeAccess?: (operation: "open" | "read" | "rename", candidate: string) => void;
  private readonly descriptors = new Map<number, string>();
  private nextDescriptor = 10;
  private nextInode = 100;

  addDirectory(candidate: string, mode = 0o700, uid = 0): void {
    const resolved = path.resolve(candidate);
    for (const component of this.pathComponents(resolved)) {
      if (!this.directories.has(component)) {
        this.directories.set(component, {
          dev: 1,
          ino: this.nextInode++,
          kind: "directory",
          mode,
          uid,
        });
      }
    }
  }

  addFile(candidate: string, bytes: Uint8Array, mode = 0o600, uid = 0): void {
    const resolved = path.resolve(candidate);
    this.addDirectory(path.dirname(resolved), 0o700, uid);
    this.files.set(resolved, {
      bytes: Buffer.from(bytes),
      entry: { dev: 1, ino: this.nextInode++, kind: "file", mode, uid },
    });
  }

  replaceWithSymlink(candidate: string, target: string): void {
    this.symlinks.set(path.resolve(candidate), path.resolve(target));
  }

  async mkdir(directoryPath: string): Promise<void> {
    this.addDirectory(directoryPath);
  }

  async open(
    filePath: string,
    flags: string | number,
    mode?: number,
  ): Promise<DescriptorFileHandle> {
    const requested = this.decodeCandidate(filePath);
    const requestedPath = requested.target;
    this.beforeAccess?.("open", requestedPath);
    const noFollow =
      typeof flags === "number" && (flags & (fsConstants.O_NOFOLLOW ?? 0x20000)) !== 0;
    if (noFollow && this.symlinks.has(requestedPath)) {
      throw Object.assign(new Error("symlink refused"), { code: "ELOOP" });
    }
    const targetPath = requested.descriptor
      ? noFollow
        ? requestedPath
        : this.resolvePath(requestedPath, true)
      : this.resolvePath(requestedPath, !noFollow);
    const directory =
      flags === "r" ||
      (typeof flags === "number" &&
        (flags & (fsConstants.O_DIRECTORY ?? 0x10000)) !== 0);
    const exclusiveCreate =
      typeof flags === "number" &&
      (flags & fsConstants.O_CREAT) !== 0 &&
      (flags & fsConstants.O_EXCL) !== 0;

    if (directory) {
      if (!this.directories.has(targetPath)) {
        throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
      }
    } else if (exclusiveCreate) {
      if (this.files.has(targetPath) || this.symlinks.has(targetPath)) {
        throw Object.assign(new Error("already exists"), { code: "EEXIST" });
      }
      this.addFile(targetPath, Buffer.alloc(0), mode ?? 0o600);
    } else if (!this.files.has(targetPath)) {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }

    const descriptor = this.nextDescriptor++;
    this.descriptors.set(descriptor, targetPath);
    let closed = false;
    const handle: DescriptorFileHandle = {
      close: async () => {
        if (closed) return;
        closed = true;
        this.descriptors.delete(descriptor);
      },
      descriptorPath: (relativePath = "") => `@fd:${descriptor}:${relativePath}`,
      readFile: async () => {
        const file = this.files.get(targetPath);
        if (!file) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return Buffer.from(file.bytes);
      },
      stat: async () => {
        const entry = this.directories.get(targetPath) ?? this.files.get(targetPath)?.entry;
        if (!entry) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return { ...entry };
      },
      sync: async () => undefined,
      writeFile: async (value) => {
        const file = this.files.get(targetPath);
        if (!file) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        file.bytes = Buffer.from(value);
      },
    };
    return handle;
  }

  async rename(from: string, to: string): Promise<void> {
    const decodedSource = this.decodeCandidate(from);
    const decodedTarget = this.decodeCandidate(to);
    this.beforeAccess?.("rename", decodedTarget.target);
    const source = decodedSource.descriptor
      ? decodedSource.target
      : this.resolvePath(decodedSource.target, false);
    const target = decodedTarget.descriptor
      ? decodedTarget.target
      : this.resolvePath(decodedTarget.target, false);
    const file = this.files.get(source);
    if (!file) throw Object.assign(new Error("source is missing"), { code: "ENOENT" });
    this.files.set(target, file);
    this.files.delete(source);
    this.symlinks.delete(target);
  }

  async unlink(filePath: string): Promise<void> {
    const decoded = this.decodeCandidate(filePath);
    const target = decoded.descriptor ? decoded.target : this.resolvePath(decoded.target, false);
    if (!this.files.delete(target) && !this.symlinks.delete(target)) {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }
  }

  async readFile(filePath: string): Promise<Buffer> {
    const requested = this.decodeCandidate(filePath);
    const requestedPath = requested.target;
    this.beforeAccess?.("read", requestedPath);
    const target = requested.descriptor ? requestedPath : this.resolvePath(requestedPath, true);
    const file = this.files.get(target);
    if (!file) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return Buffer.from(file.bytes);
  }

  async inspectPath(candidate: string): Promise<PathEntry> {
    const requested = this.decodeCandidate(candidate);
    const requestedPath = requested.target;
    if (this.symlinks.has(requestedPath)) return { kind: "symlink" };
    const target = requested.descriptor ? requestedPath : this.resolvePath(requestedPath, true);
    const entry = this.directories.get(target) ?? this.files.get(target)?.entry;
    return entry ? { ...entry } : { kind: "missing" };
  }

  async realpath(candidate: string): Promise<string> {
    const decoded = this.decodeCandidate(candidate);
    return decoded.descriptor ? decoded.target : this.resolvePath(decoded.target, true);
  }

  private decodeCandidate(candidate: string): { descriptor: boolean; target: string } {
    const match = /^@fd:(\d+):(.*)$/.exec(candidate);
    if (!match) return { descriptor: false, target: path.resolve(candidate) };
    const base = this.descriptors.get(Number(match[1]));
    if (!base) throw Object.assign(new Error("bad descriptor"), { code: "EBADF" });
    const relative = match[2];
    return {
      descriptor: true,
      target: relative ? path.join(base, ...relative.split("/").filter(Boolean)) : base,
    };
  }

  private pathComponents(candidate: string): string[] {
    const parsed = path.parse(candidate);
    const components = [parsed.root];
    let current = parsed.root;
    for (const segment of path.relative(parsed.root, candidate).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      components.push(current);
    }
    return components;
  }

  private resolvePath(candidate: string, followLeaf: boolean): string {
    let resolved = path.resolve(candidate);
    for (let attempts = 0; attempts < 16; attempts += 1) {
      const link = [...this.symlinks.keys()]
        .filter((entry) => resolved === entry || resolved.startsWith(`${entry}${path.sep}`))
        .filter((entry) => followLeaf || resolved !== entry)
        .sort((left, right) => right.length - left.length)[0];
      if (!link) return resolved;
      const suffix = path.relative(link, resolved);
      resolved = suffix ? path.join(this.symlinks.get(link)!, suffix) : this.symlinks.get(link)!;
    }
    throw new Error("symlink loop");
  }
}

function createRaceStoreFixture() {
  const base = path.resolve("race-store");
  const plaintextRoot = path.join(base, "plain");
  const persistentRoot = path.join(base, "cipher");
  const attackerRoot = path.join(base, "attacker");
  const fs = new RaceHookFileSystem();
  for (const directory of [
    plaintextRoot,
    persistentRoot,
    attackerRoot,
    path.join(plaintextRoot, "account"),
    path.join(persistentRoot, "account"),
    path.join(attackerRoot, "account"),
  ]) {
    fs.addDirectory(directory);
  }
  return {
    attackerRoot,
    fs,
    persistentRoot,
    plaintextRoot,
    create: () =>
      SessionCryptoStore.create(
        {
          activeGeneration: "g1",
          cellId: CELL_A,
          keys: new Map([["g1", KEY_A]]),
          persistentRoot,
          plaintextRoot,
        },
        {
          expectedOwnerUid: 0,
          fs,
          isTmpfsRoot: async (candidate) => candidate === plaintextRoot,
          platform: "linux",
          randomBytes: sequenceRandom(Buffer.alloc(12, 0x31), Buffer.alloc(8, 0x32)),
        },
      ),
  };
}

describe("session store and rotation", () => {
  it("keeps verified root descriptors pinned for the store lifetime", async () => {
    const fixture = createRaceStoreFixture();
    const logicalPath = "account/session.json";
    const original = createEngine().encrypt(logicalPath, Buffer.from("original-root"));
    const attacker = createEngine().encrypt(logicalPath, Buffer.from("attacker-root"));
    fixture.fs.addFile(path.join(fixture.persistentRoot, logicalPath), original);
    fixture.fs.addFile(path.join(fixture.attackerRoot, logicalPath), attacker);
    const store = await fixture.create();

    fixture.fs.replaceWithSymlink(fixture.persistentRoot, fixture.attackerRoot);

    expect((await store.readSession(logicalPath)).plaintext).toEqual(Buffer.from("original-root"));
  });

  it("rejects a parent swapped to a symlink between validation and directory open", async () => {
    const fixture = createRaceStoreFixture();
    const logicalPath = "account/session.json";
    const parent = path.join(fixture.persistentRoot, "account");
    fixture.fs.addFile(
      path.join(fixture.persistentRoot, logicalPath),
      createEngine().encrypt(logicalPath, Buffer.from("original-parent")),
    );
    fixture.fs.addFile(
      path.join(fixture.attackerRoot, logicalPath),
      createEngine().encrypt(logicalPath, Buffer.from("attacker-parent")),
    );
    const store = await fixture.create();
    let raced = false;
    fixture.fs.beforeAccess = (operation, candidate) => {
      if (!raced && ((operation === "open" && candidate === parent) || operation === "read")) {
        raced = true;
        fixture.fs.replaceWithSymlink(parent, path.join(fixture.attackerRoot, "account"));
      }
    };

    await expect(store.readSession(logicalPath)).rejects.toMatchObject({
      code: "UNSAFE_PATH_COMPONENT",
    });
  });

  it("rejects a leaf swapped to a symlink between validation and descriptor read", async () => {
    const fixture = createRaceStoreFixture();
    const logicalPath = "account/session.json";
    const leaf = path.join(fixture.persistentRoot, logicalPath);
    const attackerLeaf = path.join(fixture.attackerRoot, logicalPath);
    fixture.fs.addFile(leaf, createEngine().encrypt(logicalPath, Buffer.from("original-leaf")));
    fixture.fs.addFile(
      attackerLeaf,
      createEngine().encrypt(logicalPath, Buffer.from("attacker-leaf")),
    );
    const store = await fixture.create();
    let raced = false;
    fixture.fs.beforeAccess = (operation, candidate) => {
      if (!raced && candidate === leaf && (operation === "open" || operation === "read")) {
        raced = true;
        fixture.fs.replaceWithSymlink(leaf, attackerLeaf);
      }
    };

    await expect(store.readSession(logicalPath)).rejects.toMatchObject({
      code: "UNSAFE_PATH_COMPONENT",
    });
  });

  it("renames through the pinned parent when its checked pathname is swapped", async () => {
    const fixture = createRaceStoreFixture();
    const logicalPath = "account/session.json";
    const target = path.join(fixture.persistentRoot, logicalPath);
    const parent = path.dirname(target);
    const attackerParent = path.join(fixture.attackerRoot, "account");
    const store = await fixture.create();
    fixture.fs.beforeAccess = (operation, candidate) => {
      if (operation !== "rename" || candidate !== target) return;
      fixture.fs.replaceWithSymlink(parent, attackerParent);
      fixture.fs.addFile(
        path.join(attackerParent, ".session.json.tmp-3232323232323232"),
        Buffer.from("attacker-temp"),
      );
    };

    const metadata = await store.writeSession(logicalPath, Buffer.from("pinned-write"), null);
    const persisted = fixture.fs.files.get(target)?.bytes;

    expect(persisted).toBeDefined();
    expect(envelopeVersion(persisted!)).toBe(metadata.envelopeVersion);
    expect(fixture.fs.files.get(path.join(attackerParent, "session.json"))?.bytes).not.toEqual(
      Buffer.from("attacker-temp"),
    );
  });

  it("creates nonce reservations through the pinned persistent root", async () => {
    const fixture = createRaceStoreFixture();
    const store = await fixture.create();
    let raced = false;
    fixture.fs.beforeAccess = (operation, candidate) => {
      if (
        !raced &&
        operation === "open" &&
        path.basename(candidate).startsWith(".openclaw-nonce-v1-")
      ) {
        raced = true;
        fixture.fs.replaceWithSymlink(fixture.persistentRoot, fixture.attackerRoot);
      }
    };

    await store.writeSession("session.json", Buffer.from("nonce-root"), null);

    expect(
      [...fixture.fs.files.keys()].some(
        (candidate) =>
          path.dirname(candidate) === fixture.persistentRoot &&
          path.basename(candidate).startsWith(".openclaw-nonce-v1-"),
      ),
    ).toBe(true);
    expect(
      [...fixture.fs.files.keys()].some(
        (candidate) =>
          path.dirname(candidate) === fixture.attackerRoot &&
          path.basename(candidate).startsWith(".openclaw-nonce-v1-"),
      ),
    ).toBe(false);
  });

  it("returns a stable ciphertext envelope version for compare-and-swap", async () => {
    const fixture = createStoreFixture();
    const store = await fixture.create();

    const written = await store.writeSession("session.json", Buffer.from("fixture-cas-initial"), null);
    const persisted = fixture.fs.files.get(path.join(fixture.persistentRoot, "session.json"))!;

    expect(written.envelopeVersion).toBe(envelopeVersion(persisted));
  });

  it("serializes same-path writers so only one stale expected version can commit", async () => {
    const fixture = createStoreFixture({ randomBytes: countingRandom() });
    const store = await fixture.create();
    const initial = await store.writeSession("session.json", Buffer.from("fixture-cas-base"), null);

    const results = await Promise.allSettled([
      store.writeSession(
        "session.json",
        Buffer.from("fixture-cas-contender-a"),
        initial.envelopeVersion,
      ),
      store.writeSession(
        "session.json",
        Buffer.from("fixture-cas-contender-b"),
        initial.envelopeVersion,
      ),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason).toMatchObject({ code: "ENVELOPE_CONFLICT" });
  });

  it("does not restore plaintext when the expected envelope version is stale", async () => {
    const fixture = createStoreFixture({ randomBytes: countingRandom() });
    const persistentPath = path.join(fixture.persistentRoot, "session.json");
    const plaintextPath = path.join(fixture.plaintextRoot, "session.json");
    const envelope = createEngine({
      randomBytes: sequenceRandom(Buffer.alloc(12, 0x41)),
    }).encrypt("session.json", Buffer.from("fixture-restore-current"));
    fixture.fs.files.set(persistentPath, envelope);
    fixture.fs.files.set(plaintextPath, Buffer.from("fixture-restore-previous"));
    const store = await fixture.create();

    await expect(store.restoreToPlaintext("session.json", "0".repeat(64))).rejects.toMatchObject({
      code: "ENVELOPE_CONFLICT",
    });
    expect(fixture.fs.files.get(plaintextPath)).toEqual(Buffer.from("fixture-restore-previous"));
  });

  it("rotates only to the configured active generation and later persists remain on it", async () => {
    const fixture = createStoreFixture({
      activeGeneration: "g2",
      randomBytes: countingRandom(),
    });
    const logicalPath = "session.json";
    const persistentPath = path.join(fixture.persistentRoot, logicalPath);
    const plaintextPath = path.join(fixture.plaintextRoot, logicalPath);
    const oldEnvelope = createEngine({
      randomBytes: sequenceRandom(Buffer.alloc(12, 0x44)),
    }).encrypt(logicalPath, Buffer.from("fixture-before-active-rotation"));
    fixture.fs.files.set(persistentPath, oldEnvelope);
    fixture.fs.files.set(plaintextPath, Buffer.from("fixture-after-active-rotation"));
    const store = await fixture.create();

    const rotated = await store.rotateSession(logicalPath, envelopeVersion(oldEnvelope));
    const persisted = await store.persistFromPlaintext(logicalPath, rotated.envelopeVersion);

    expect(rotated.generation).toBe("g2");
    expect(persisted.generation).toBe("g2");
  });

  it("rejects rotation when ciphertext already uses the configured active generation", async () => {
    const fixture = createStoreFixture({ activeGeneration: "g2", randomBytes: countingRandom() });
    const engine = new SessionCryptoEngine({
      activeGeneration: "g2",
      cellId: CELL_A,
      keys: new Map([["g1", KEY_A], ["g2", KEY_B]]),
      randomBytes: sequenceRandom(Buffer.alloc(12, 0x45)),
    });
    const envelope = engine.encrypt("session.json", Buffer.from("fixture-already-active"));
    fixture.fs.files.set(path.join(fixture.persistentRoot, "session.json"), envelope);
    const store = await fixture.create();

    await expect(
      store.rotateSession("session.json", envelopeVersion(envelope)),
    ).rejects.toMatchObject({ code: "ROTATION_GENERATION_UNCHANGED" });
  });

  it("reserves nonces durably across restarted store instances", async () => {
    const fixture = createStoreFixture();
    const sharedNonce = Buffer.alloc(12, 0x52);
    let secondNonceCall = 0;
    const firstStore = await SessionCryptoStore.create(
      {
        activeGeneration: "g1",
        cellId: CELL_A,
        keys: new Map([["g1", KEY_A], ["g2", KEY_B]]),
        persistentRoot: fixture.persistentRoot,
        plaintextRoot: fixture.plaintextRoot,
      },
      {
        fs: fixture.fs,
        isTmpfsRoot: async (candidate) => candidate === fixture.plaintextRoot,
        platform: "linux",
        randomBytes: (size) =>
          size === 12 ? sharedNonce : Buffer.alloc(8, 0x53),
      },
    );
    const secondStore = await SessionCryptoStore.create(
      {
        activeGeneration: "g1",
        cellId: CELL_A,
        keys: new Map([["g1", KEY_A], ["g2", KEY_B]]),
        persistentRoot: fixture.persistentRoot,
        plaintextRoot: fixture.plaintextRoot,
      },
      {
        fs: fixture.fs,
        isTmpfsRoot: async (candidate) => candidate === fixture.plaintextRoot,
        platform: "linux",
        randomBytes: (size) => {
          if (size === 8) return Buffer.alloc(8, 0x54);
          secondNonceCall += 1;
          return secondNonceCall === 1 ? sharedNonce : Buffer.alloc(12, 0x55);
        },
      },
    );

    const first = await firstStore.writeSession("first.json", Buffer.from("fixture-first"), null);
    const second = await secondStore.writeSession("second.json", Buffer.from("fixture-second"), null);

    expect(first.nonce).not.toBe(second.nonce);
  });

  it("never reuses the persisted previous nonce after restart even without an old reservation", async () => {
    const fixture = createStoreFixture();
    const previousNonce = Buffer.alloc(12, 0x56);
    const oldEnvelope = createEngine({
      randomBytes: sequenceRandom(previousNonce),
    }).encrypt("session.json", Buffer.from("fixture-previous-nonce"));
    fixture.fs.files.set(path.join(fixture.persistentRoot, "session.json"), oldEnvelope);
    let nonceCall = 0;
    const store = await SessionCryptoStore.create(
      {
        activeGeneration: "g1",
        cellId: CELL_A,
        keys: new Map([["g1", KEY_A], ["g2", KEY_B]]),
        persistentRoot: fixture.persistentRoot,
        plaintextRoot: fixture.plaintextRoot,
      },
      {
        fs: fixture.fs,
        isTmpfsRoot: async (candidate) => candidate === fixture.plaintextRoot,
        platform: "linux",
        randomBytes: (size) => {
          if (size === 8) return Buffer.alloc(8, 0x57);
          nonceCall += 1;
          return nonceCall === 1 ? previousNonce : Buffer.alloc(12, 0x58);
        },
      },
    );

    const persisted = await store.writeSession(
      "session.json",
      Buffer.from("fixture-new-nonce"),
      envelopeVersion(oldEnvelope),
    );

    expect(persisted.nonce).not.toBe(previousNonce.toString("base64"));
  });

  it("rejects missing or unsafe parent directories instead of recursively creating them", async () => {
    const fixture = createStoreFixture({ randomBytes: countingRandom() });
    const store = await fixture.create();

    await expect(
      store.writeSession("missing/session.json", Buffer.from("fixture-parent-missing"), null),
    ).rejects.toThrow(/pre-existing directory/i);
    expect(fixture.fs.events.some((event) => event.startsWith("mkdir:"))).toBe(false);
  });

  it("rejects an unowned or broadly accessible parent directory", async () => {
    const fixture = createStoreFixture({ randomBytes: countingRandom() });
    const unsafeParent = path.join(fixture.persistentRoot, "unsafe");
    fixture.fs.directories.add(unsafeParent);
    fixture.fs.unsafeEntries.set(unsafeParent, { kind: "directory", mode: 0o777, uid: 9999 });
    const store = await fixture.create();

    await expect(
      store.writeSession("unsafe/session.json", Buffer.from("fixture-unsafe-parent"), null),
    ).rejects.toThrow(/owner|mode/i);
  });

  it("rejects an unowned or broadly accessible configured session root", async () => {
    const fixture = createStoreFixture();
    fixture.fs.unsafeEntries.set(fixture.persistentRoot, {
      kind: "directory",
      mode: 0o755,
      uid: 9999,
    });

    let rejection: unknown;
    try {
      await fixture.create();
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(SessionCryptoError);
    expect(String((rejection as Error | undefined)?.message)).toMatch(/root.*owner|root.*mode/i);
  });

  it("rejects a root descriptor without stable device and inode identity", async () => {
    const fixture = createStoreFixture();
    const openFile = fixture.fs.open.bind(fixture.fs);
    fixture.fs.open = async (candidate, flags, mode) => {
      const handle = await openFile(candidate, flags, mode);
      if (candidate !== fixture.plaintextRoot) return handle;
      return {
        ...handle,
        async stat() {
          const { dev: _dev, ino: _ino, ...stat } = await handle.stat();
          return stat;
        },
      };
    };

    await expect(fixture.create()).rejects.toMatchObject({
      code: "UNSAFE_ROOT_COMPONENT",
    });
  });

  it("fails explicitly when the store runtime is not Linux", async () => {
    const fixture = createStoreFixture();

    await expect(
      SessionCryptoStore.create(
        {
          activeGeneration: "g1",
          cellId: CELL_A,
          keys: new Map([["g1", KEY_A], ["g2", KEY_B]]),
          persistentRoot: fixture.persistentRoot,
          plaintextRoot: fixture.plaintextRoot,
        },
        {
          fs: fixture.fs,
          isTmpfsRoot: async () => true,
          platform: "win32",
          randomBytes: countingRandom(),
        },
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_PLATFORM" });
  });

  it("preserves the last good ciphertext when a new envelope exceeds the store limit", async () => {
    const oldEnvelope = createEngine({
      randomBytes: sequenceRandom(Buffer.alloc(12, 0x59)),
    }).encrypt("session.json", Buffer.from("small"));
    const fixture = createStoreFixture({
      maxEnvelopeBytes: oldEnvelope.length + 8,
      randomBytes: countingRandom(),
    });
    const persistentPath = path.join(fixture.persistentRoot, "session.json");
    fixture.fs.files.set(persistentPath, oldEnvelope);
    const store = await fixture.create();

    await expect(
      store.writeSession(
        "session.json",
        Buffer.alloc(1024, 0x61),
        envelopeVersion(oldEnvelope),
      ),
    ).rejects.toMatchObject({ code: "ENVELOPE_TOO_LARGE" });
    expect(fixture.fs.files.get(persistentPath)).toEqual(oldEnvelope);
  });

  it("persists plaintext only from tmpfs and stores authenticated ciphertext in the persistent root", async () => {
    const fixture = createStoreFixture();
    const logicalPath = "account/session.json";
    const plaintextPath = path.join(fixture.plaintextRoot, "account", "session.json");
    const persistentPath = path.join(fixture.persistentRoot, "account", "session.json");
    const plaintext = Buffer.from("fixture-plaintext-gamma", "utf8");
    fixture.fs.files.set(plaintextPath, plaintext);
    const store = await fixture.create();

    const persisted = await store.persistFromPlaintext(logicalPath, null);
    const ciphertext = fixture.fs.files.get(persistentPath);

    expect(persisted.generation).toBe("g1");
    expect(ciphertext).toBeDefined();
    expect(ciphertext?.toString("utf8")).not.toContain(plaintext.toString("utf8"));
    expect((await store.readSession(logicalPath)).plaintext).toEqual(plaintext);
  });

  it("never falls back to a plaintext tmpfs copy when persistent authentication fails", async () => {
    const fixture = createStoreFixture();
    const logicalPath = "account/session.json";
    const plaintextPath = path.join(fixture.plaintextRoot, "account", "session.json");
    const persistentPath = path.join(fixture.persistentRoot, "account", "session.json");
    fixture.fs.files.set(plaintextPath, Buffer.from("still-present-in-tmpfs"));
    fixture.fs.files.set(persistentPath, Buffer.from("malformed-ciphertext"));
    const store = await fixture.create();

    await expect(store.readSession(logicalPath)).rejects.toThrow(SessionCryptoError);
    expect(fixture.fs.events.filter((event) => event.startsWith("read-handle:"))).toEqual([
      `read-handle:${persistentPath}`,
    ]);
  });

  it("restores decrypted bytes only into the verified plaintext root", async () => {
    const fixture = createStoreFixture({ random: [Buffer.alloc(8, 0x63)] });
    const logicalPath = "account/session.json";
    const plaintextPath = path.join(fixture.plaintextRoot, "account", "session.json");
    const persistentPath = path.join(fixture.persistentRoot, "account", "session.json");
    const plaintext = Buffer.from("fixture-plaintext-delta");
    const envelope = createEngine({
      randomBytes: sequenceRandom(Buffer.alloc(12, 0x62)),
    }).encrypt(logicalPath, plaintext);
    fixture.fs.files.set(persistentPath, envelope);
    const store = await fixture.create();

    await store.restoreToPlaintext(logicalPath, envelopeVersion(envelope));

    expect(fixture.fs.files.get(plaintextPath)).toEqual(plaintext);
    expect(fixture.fs.files.get(persistentPath)).toEqual(envelope);
  });

  it.each(["symlink", "reparse"] as const)(
    "rejects a %s component below an approved root",
    async (kind) => {
      const fixture = createStoreFixture();
      const unsafeDirectory = path.join(fixture.persistentRoot, "account");
      fixture.fs.unsafeEntries.set(unsafeDirectory, { kind });
      const store = await fixture.create();

      await expect(
        store.writeSession(
          "account/session.json",
          Buffer.from("fixture-plaintext-epsilon"),
          null,
        ),
      ).rejects.toThrow(
        new RegExp(kind, "i"),
      );
    },
  );

  it("rotates to a new generation and nonce while retaining decryptability", async () => {
    const fixture = createStoreFixture({
      activeGeneration: "g2",
      random: [Buffer.alloc(12, 0x73), Buffer.alloc(8, 0x74)],
    });
    const store = await fixture.create();
    const oldEnvelope = createEngine({
      randomBytes: sequenceRandom(Buffer.alloc(12, 0x71)),
    }).encrypt("session.json", Buffer.from("fixture-plaintext-zeta"));
    fixture.fs.files.set(path.join(fixture.persistentRoot, "session.json"), oldEnvelope);
    const before = inspectEnvelope(oldEnvelope);

    const rotated = await store.rotateSession("session.json", envelopeVersion(oldEnvelope));
    const afterEnvelope = fixture.fs.files.get(path.join(fixture.persistentRoot, "session.json"))!;
    const after = inspectEnvelope(afterEnvelope);

    expect(rotated.generation).toBe("g2");
    expect(after.generation).toBe("g2");
    expect(after.nonce).not.toBe(before.nonce);
    expect((await store.readSession("session.json")).plaintext).toEqual(
      Buffer.from("fixture-plaintext-zeta"),
    );
  });

  it("preserves the recoverable old generation when rotation fails before rename", async () => {
    const fixture = createStoreFixture({
      activeGeneration: "g2",
      failure: "rename",
      random: [Buffer.alloc(12, 0x01), Buffer.alloc(8, 0x02)],
    });
    const store = await fixture.create();
    const engine = createEngine({ randomBytes: sequenceRandom(Buffer.alloc(12, 0x03)) });
    const oldEnvelope = engine.encrypt("session.json", Buffer.from("fixture-plaintext-eta"));
    const persistentPath = path.join(fixture.persistentRoot, "session.json");
    fixture.fs.files.set(persistentPath, oldEnvelope);

    await expect(
      store.rotateSession("session.json", envelopeVersion(oldEnvelope)),
    ).rejects.toThrow(/rename/i);

    expect(inspectEnvelope(fixture.fs.files.get(persistentPath)!).generation).toBe("g1");
    expect((await store.readSession("session.json")).plaintext).toEqual(
      Buffer.from("fixture-plaintext-eta"),
    );
  });

  it("reports an explicit fatal ambiguity if rotation fails after rename", async () => {
    const fixture = createStoreFixture({
      activeGeneration: "g2",
      failure: "second-dir-fsync",
      random: [Buffer.alloc(12, 0x21), Buffer.alloc(8, 0x22)],
    });
    const store = await fixture.create();
    const engine = createEngine({ randomBytes: sequenceRandom(Buffer.alloc(12, 0x23)) });
    const persistentPath = path.join(fixture.persistentRoot, "session.json");
    const oldEnvelope = engine.encrypt("session.json", Buffer.from("fixture-plaintext-theta"));
    fixture.fs.files.set(persistentPath, oldEnvelope);

    await expect(
      store.rotateSession("session.json", envelopeVersion(oldEnvelope)),
    ).rejects.toBeInstanceOf(AmbiguousDurabilityError);
    expect(inspectEnvelope(fixture.fs.files.get(persistentPath)!).generation).toBe("g2");
  });

  it("exposes a narrow daemon interface that returns metadata rather than secret bytes", async () => {
    const fixture = createStoreFixture({
      random: [Buffer.alloc(12, 0x31), Buffer.alloc(8, 0x32)],
    });
    const logicalPath = "session.json";
    fixture.fs.files.set(
      path.join(fixture.plaintextRoot, logicalPath),
      Buffer.from("fixture-plaintext-iota"),
    );
    const daemon = new SessionCryptoDaemon(await fixture.create());

    const result = await daemon.handle({
      expectedEnvelopeVersion: null,
      id: "integrated-persist",
      operation: "persist",
      path: logicalPath,
      version: 1,
    });

    expect(result).toMatchObject({
      id: "integrated-persist",
      ok: true,
      result: {
        envelopeVersion: expect.stringMatching(/^[0-9a-f]{64}$/),
        generation: "g1",
        operation: "persist",
        path: logicalPath,
      },
      version: 1,
    });
    expect(JSON.stringify(result)).not.toContain("fixture-plaintext-iota");
  });
});
