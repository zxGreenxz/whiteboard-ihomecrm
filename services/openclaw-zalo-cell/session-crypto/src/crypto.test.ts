import path from "node:path";

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

  it("retries an injected duplicate nonce and never reuses it", () => {
    const firstNonce = Buffer.alloc(12, 0x41);
    const secondNonce = Buffer.alloc(12, 0x42);
    const engine = createEngine({
      randomBytes: sequenceRandom(firstNonce, firstNonce, secondNonce),
    });

    const first = inspectEnvelope(engine.encrypt("session.json", Buffer.from("one")));
    const second = inspectEnvelope(engine.encrypt("session.json", Buffer.from("two")));

    expect(first.nonce).not.toBe(second.nonce);
    expect(first.nonce).toBe(firstNonce.toString("base64"));
    expect(second.nonce).toBe(secondNonce.toString("base64"));
  });

  it("fails closed for the wrong key, generation, cell, path, or authentication tag", () => {
    const sameKeyAcrossGenerations = createEngine({
      keys: new Map([["g1", KEY_A], ["g2", KEY_A]]),
    });
    const envelope = sameKeyAcrossGenerations.encrypt(
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
    expect(() => sameKeyAcrossGenerations.decrypt("sessions/a.json", substitutedGeneration)).toThrow(
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

type FailurePoint = "write" | "file-fsync" | "rename" | "dir-fsync";

class OrderedFileSystem implements FileSystemOperations {
  readonly events: string[] = [];
  readonly files = new Map<string, Buffer>();
  readonly directories = new Set<string>();

  constructor(private readonly failure?: FailurePoint) {}

  async mkdir(directoryPath: string): Promise<void> {
    this.events.push(`mkdir:${directoryPath}`);
    this.directories.add(directoryPath);
  }

  async open(filePath: string, flags: string | number, mode?: number): Promise<FileHandleOperations> {
    const directoryHandle = flags === "r";
    this.events.push(
      directoryHandle
        ? `open-dir:${filePath}`
        : `open-temp:${filePath}:${String(flags)}:${String(mode)}`,
    );
    let bytes = Buffer.alloc(0);

    return {
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
    if (this.files.has(candidate)) return { kind: "file" };
    if (this.directories.has(candidate)) return { kind: "directory" };
    return { kind: "missing" };
  }

  async realpath(candidate: string): Promise<string> {
    return candidate;
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

    await durableAtomicWrite(fs, target, Buffer.from("ciphertext"), randomBytes);

    expect(fs.events).toEqual([
      `mkdir:${parent}`,
      expect.stringMatching(`^open-temp:${temporary.replaceAll("\\", "\\\\")}:\\d+:384$`),
      `write:${temporary}`,
      `fsync-file:${temporary}`,
      `close-file:${temporary}`,
      `rename:${temporary}->${target}`,
      `open-dir:${parent}`,
      `fsync-dir:${parent}`,
      `close-dir:${parent}`,
    ]);
    expect(fs.files.get(target)).toEqual(Buffer.from("ciphertext"));
  });

  it.each(["write", "file-fsync", "rename"] as const)(
    "cleans the temp and preserves the last good ciphertext when %s fails before rename",
    async (failure) => {
      const fs = new OrderedFileSystem(failure);
      const target = path.resolve("durable", `${failure}.enc`);
      fs.files.set(target, Buffer.from("old-ciphertext"));

      await expect(
        durableAtomicWrite(fs, target, Buffer.from("new-ciphertext"), sequenceRandom(suffix)),
      ).rejects.toThrow(/injected/i);

      expect(fs.files.get(target)).toEqual(Buffer.from("old-ciphertext"));
      expect([...fs.files.keys()].filter((file) => file.includes(".tmp-"))).toEqual([]);
      expect(fs.events.some((event) => event.startsWith("unlink:"))).toBe(true);
    },
  );

  it("surfaces directory-fsync failure as ambiguous after rename without plaintext fallback", async () => {
    const fs = new OrderedFileSystem("dir-fsync");
    const target = path.resolve("durable", "ambiguous.enc");
    fs.files.set(target, Buffer.from("old-ciphertext"));

    await expect(
      durableAtomicWrite(fs, target, Buffer.from("new-ciphertext"), sequenceRandom(suffix)),
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

function createStoreFixture(options: { failure?: FailurePoint; random?: Buffer[] } = {}) {
  const base = path.resolve("memory-store");
  const plaintextRoot = path.join(base, "plain");
  const persistentRoot = path.join(base, "cipher");
  const fs = new MemoryFileSystem(options.failure);
  fs.directories.add(base);
  fs.directories.add(plaintextRoot);
  fs.directories.add(persistentRoot);
  const randomValues = options.random ?? [Buffer.alloc(12, 0x51), Buffer.alloc(8, 0x61)];

  return {
    fs,
    plaintextRoot,
    persistentRoot,
    create: () =>
      SessionCryptoStore.create(
        {
          activeGeneration: "g1",
          cellId: CELL_A,
          keys: new Map([["g1", KEY_A], ["g2", KEY_B]]),
          persistentRoot,
          plaintextRoot,
        },
        {
          fs,
          isTmpfsRoot: async (candidate) => candidate === plaintextRoot,
          randomBytes: sequenceRandom(...randomValues),
        },
      ),
  };
}

describe("session store and rotation", () => {
  it("persists plaintext only from tmpfs and stores authenticated ciphertext in the persistent root", async () => {
    const fixture = createStoreFixture();
    const logicalPath = "account/session.json";
    const plaintextPath = path.join(fixture.plaintextRoot, "account", "session.json");
    const persistentPath = path.join(fixture.persistentRoot, "account", "session.json");
    const plaintext = Buffer.from("fixture-plaintext-gamma", "utf8");
    fixture.fs.files.set(plaintextPath, plaintext);
    const store = await fixture.create();

    const persisted = await store.persistFromPlaintext(logicalPath);
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
    expect(fixture.fs.events.filter((event) => event.startsWith("read:"))).toEqual([
      `read:${persistentPath}`,
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

    await store.restoreToPlaintext(logicalPath);

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
        store.writeSession("account/session.json", Buffer.from("fixture-plaintext-epsilon")),
      ).rejects.toThrow(
        new RegExp(kind, "i"),
      );
    },
  );

  it("rotates to a new generation and nonce while retaining decryptability", async () => {
    const fixture = createStoreFixture({
      random: [
        Buffer.alloc(12, 0x71),
        Buffer.alloc(8, 0x72),
        Buffer.alloc(12, 0x73),
        Buffer.alloc(8, 0x74),
      ],
    });
    const store = await fixture.create();
    await store.writeSession("session.json", Buffer.from("fixture-plaintext-zeta"));
    const before = inspectEnvelope(
      fixture.fs.files.get(path.join(fixture.persistentRoot, "session.json"))!,
    );

    const rotated = await store.rotateSession("session.json", "g2");
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
      failure: "rename",
      random: [Buffer.alloc(12, 0x01), Buffer.alloc(8, 0x02)],
    });
    const store = await fixture.create();
    const engine = createEngine({ randomBytes: sequenceRandom(Buffer.alloc(12, 0x03)) });
    const oldEnvelope = engine.encrypt("session.json", Buffer.from("fixture-plaintext-eta"));
    const persistentPath = path.join(fixture.persistentRoot, "session.json");
    fixture.fs.files.set(persistentPath, oldEnvelope);

    await expect(store.rotateSession("session.json", "g2")).rejects.toThrow(/rename/i);

    expect(inspectEnvelope(fixture.fs.files.get(persistentPath)!).generation).toBe("g1");
    expect((await store.readSession("session.json")).plaintext).toEqual(
      Buffer.from("fixture-plaintext-eta"),
    );
  });

  it("reports an explicit fatal ambiguity if rotation fails after rename", async () => {
    const fixture = createStoreFixture({
      failure: "dir-fsync",
      random: [Buffer.alloc(12, 0x21), Buffer.alloc(8, 0x22)],
    });
    const store = await fixture.create();
    const engine = createEngine({ randomBytes: sequenceRandom(Buffer.alloc(12, 0x23)) });
    const persistentPath = path.join(fixture.persistentRoot, "session.json");
    fixture.fs.files.set(
      persistentPath,
      engine.encrypt("session.json", Buffer.from("fixture-plaintext-theta")),
    );

    await expect(store.rotateSession("session.json", "g2")).rejects.toBeInstanceOf(
      AmbiguousDurabilityError,
    );
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

    const result = await daemon.execute({ operation: "persist", path: logicalPath });

    expect(result).toEqual({ generation: "g1", operation: "persist", path: logicalPath });
    expect(JSON.stringify(result)).not.toContain("fixture-plaintext-iota");
  });
});
