import { readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

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

describe("runtime bootstrap contracts", () => {
  it("publishes a real executable and stdio bootstrap without network listeners", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    const source = await readFile(new URL("./daemon.ts", import.meta.url), "utf8");

    expect(packageJson.bin).toEqual({
      "openclaw-session-crypto": "./dist/daemon.js",
    });
    expect(runtimeExport("runStdioDaemon")).toBeTypeOf("function");
    expect(runtimeExport("runSessionCryptoProcess")).toBeTypeOf("function");
    expect(source).not.toMatch(/node:(?:http|https|net|tls|dgram|http2)/);
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
          stat(): Promise<{ kind: string; mode: number; uid: number }>;
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
          stat: async () => ({ kind: "file", mode: 0o400, uid: 1000 }),
        };
      },
    });

    expect(visited).toEqual(["/run/secrets/openclaw_session_key"]);
    expect(keyring.activeGeneration).toBe("g2");
    expect(keyring.keys.get("g2")).toEqual(Buffer.alloc(32, 0x22));
  });

  it.each([
    ["symlink", { kind: "symlink", mode: 0o400, uid: 1000 }],
    ["permissions", { kind: "file", mode: 0o440, uid: 1000 }],
    ["owner", { kind: "file", mode: 0o400, uid: 0 }],
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
