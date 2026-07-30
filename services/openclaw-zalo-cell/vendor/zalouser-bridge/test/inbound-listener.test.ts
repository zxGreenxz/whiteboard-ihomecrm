import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as inboundBridge from "../src/bridge/inbound-listener.js";
import {
  createSignedBridgeResponse,
  type BridgeRuntimeBindingV1,
  type SignedBridgeRequestV1,
} from "../src/bridge/protocol.js";
import * as runtimeBootstrap from "../src/bridge/runtime-bootstrap.js";

type Binding = Readonly<{
  cellId: string;
  organizationId: string;
  sessionGeneration: number;
}>;

type MediaInput = Readonly<{
  byteLength: number | null;
  fetchRef: string | null;
  kind: "IMAGE" | "VIDEO" | "AUDIO" | "FILE" | "STICKER" | "OTHER";
  mime: string | null;
  providerChecksum: string | null;
  providerMediaId: string | null;
}>;

type InboundInput = Readonly<{
  callbackReceivedAt: string;
  eventKind:
    | "MESSAGE"
    | "REACTION"
    | "DELIVERY_RECEIPT"
    | "SEEN"
    | "TYPING"
    | "MEMBERSHIP"
    | "OTHER";
  normalized: Readonly<{
    media: readonly MediaInput[];
    replyToProviderMessageId: string | null;
    text: string | null;
  }>;
  providerConversationId: string;
  providerEventId: string | null;
  providerEventType: string;
  providerMessageId: string | null;
  providerSenderId: string;
  providerTarget: Readonly<{ kind: "PEER" | "SALES_GROUP"; providerId: string }>;
  rawEnvelope: unknown;
  sourceTimestamp: string;
}>;

const BINDING: Binding = Object.freeze({
  cellId: "cell-a",
  organizationId: "organization-a",
  sessionGeneration: 7,
});

const COMMITTED_ACK = Object.freeze({
  durability: Object.freeze({ journalMode: "WAL", synchronous: "FULL" }),
  status: "committed",
  version: 1,
});

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.useRealTimers();
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function input(overrides: Partial<InboundInput> = {}): InboundInput {
  return {
    callbackReceivedAt: "2026-07-27T00:00:01.000Z",
    eventKind: "MESSAGE",
    normalized: {
      media: [],
      replyToProviderMessageId: null,
      text: "hello",
    },
    providerConversationId: "conversation-1",
    providerEventId: "event-1",
    providerEventType: "webchat",
    providerMessageId: "message-1",
    providerSenderId: "sender-1",
    providerTarget: { kind: "PEER", providerId: "peer-1" },
    rawEnvelope: { a: { nested: "raw" }, z: ["evidence", { a: true, b: 2 }] },
    sourceTimestamp: "2026-07-27T00:00:00.000Z",
    ...overrides,
  };
}

function install(
  committer: (envelope: unknown) => Promise<unknown>,
  binding: Binding = BINDING,
): void {
  const uninstall = inboundBridge.installInboundBridgeCommitter({
    binding,
    committer,
    ready: async () => undefined,
    commitTimeoutMs: 6_000,
    readinessTimeoutMs: 2_000,
  } as never);
  cleanups.push(uninstall);
}

function listener(dispatch: (envelope: unknown) => Promise<void>) {
  return inboundBridge.createDurableInboundListener({
    accountId: "account-a",
    dispatch,
  } as never) as unknown as (value: InboundInput) => Promise<unknown>;
}

describe("ZaloUser inbound envelope V1", () => {
  it("commits the exact complete immutable envelope and canonical hashes before dispatch", async () => {
    const events: string[] = [];
    const committed: unknown[] = [];
    const media: MediaInput = {
      byteLength: 12,
      fetchRef: "zca://media/photo-1",
      kind: "IMAGE",
      mime: "image/jpeg",
      providerChecksum: "provider-checksum-1",
      providerMediaId: "photo-1",
    };
    install(async (envelope) => {
      events.push("commit");
      committed.push(envelope);
      return COMMITTED_ACK;
    });
    const onInbound = listener(async () => {
      events.push("dispatch");
    });

    const result = await onInbound(
      input({
        normalized: {
          media: [media],
          replyToProviderMessageId: "reply-1",
          text: "hello",
        },
      }),
    );

    const canonicalRaw = '{"a":{"nested":"raw"},"z":["evidence",{"a":true,"b":2}]}';
    const canonicalNormalized =
      '{"mediaManifest":[{"byteLength":12,"byteState":"PENDING","fetchRef":"zca://media/photo-1","index":0,"kind":"IMAGE","mime":"image/jpeg","providerChecksum":"provider-checksum-1","providerMediaId":"photo-1","version":1}],"replyToProviderMessageId":"reply-1","text":"hello"}';
    const expected = {
      accountId: "account-a",
      callbackReceivedAt: "2026-07-27T00:00:01.000Z",
      cellId: "cell-a",
      eventKind: "MESSAGE",
      normalized: {
        mediaManifest: [
          {
            byteLength: 12,
            byteState: "PENDING",
            fetchRef: "zca://media/photo-1",
            index: 0,
            kind: "IMAGE",
            mime: "image/jpeg",
            providerChecksum: "provider-checksum-1",
            providerMediaId: "photo-1",
            version: 1,
          },
        ],
        replyToProviderMessageId: "reply-1",
        text: "hello",
      },
      normalizedSha256: sha256(canonicalNormalized),
      organizationId: "organization-a",
      providerConversationId: "conversation-1",
      providerEventId: "event-1",
      providerEventType: "webchat",
      providerMessageId: "message-1",
      providerSenderId: "sender-1",
      providerTarget: { kind: "PEER", providerId: "peer-1" },
      rawEnvelope: { a: { nested: "raw" }, z: ["evidence", { a: true, b: 2 }] },
      rawEnvelopeSha256: sha256(canonicalRaw),
      sessionGeneration: 7,
      sourceTimestamp: "2026-07-27T00:00:00.000Z",
      version: 1,
    };

    expect(events).toEqual(["commit", "dispatch"]);
    expect(committed).toEqual([expected]);
    expect(committed[0]).not.toHaveProperty("dedupeKey");
    expect(result).toEqual({ envelope: expected, status: "dispatched" });
    const envelope = committed[0] as typeof expected;
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.rawEnvelope)).toBe(true);
    expect(Object.isFrozen(envelope.normalized)).toBe(true);
    expect(Object.isFrozen(envelope.normalized.mediaManifest)).toBe(true);
    expect(Object.isFrozen(envelope.normalized.mediaManifest[0])).toBe(true);
  });

  it.each([
    ["PEER", "peer-1"],
    ["SALES_GROUP", "sales-group-1"],
  ] as const)("preserves a %s provider target", async (kind, providerId) => {
    const committed: Array<{ providerTarget?: unknown }> = [];
    install(async (envelope) => {
      committed.push(envelope as { providerTarget?: unknown });
      return COMMITTED_ACK;
    });

    await listener(async () => undefined)(
      input({ providerTarget: { kind, providerId } }),
    );

    expect(committed[0]?.providerTarget).toEqual({ kind, providerId });
  });

  it.each([
    ["event only", "event-1", null],
    ["message only", null, "message-1"],
    ["both", "event-1", "message-1"],
    ["neither", null, null],
  ] as const)(
    "transports the stable-ID matrix without synthesis or fork dedupe: %s",
    async (_label, providerEventId, providerMessageId) => {
      const committed: Array<Record<string, unknown>> = [];
      install(async (envelope) => {
        committed.push(envelope as Record<string, unknown>);
        return COMMITTED_ACK;
      });

      await listener(async () => undefined)(input({ providerEventId, providerMessageId }));

      expect(committed).toHaveLength(1);
      expect(committed[0]).toMatchObject({ providerEventId, providerMessageId });
      expect(committed[0]).not.toHaveProperty("dedupeKey");
      expect(committed[0]).not.toHaveProperty("fingerprint");
    },
  );

  it("keeps the same textual provider IDs distinct through organization and account scope", async () => {
    const committed: Array<Record<string, unknown>> = [];
    install(async (envelope) => {
      committed.push(envelope as Record<string, unknown>);
      return COMMITTED_ACK;
    });
    await listener(async () => undefined)(input());
    await inboundBridge.createDurableInboundListener({
      accountId: "account-b",
      dispatch: async () => undefined,
    } as never)(input() as never);
    cleanups.pop()?.();
    install(
      async (envelope) => {
        committed.push(envelope as Record<string, unknown>);
        return COMMITTED_ACK;
      },
      { ...BINDING, organizationId: "organization-b" },
    );
    await listener(async () => undefined)(input());

    expect(committed.map(({ organizationId, accountId, providerEventId, providerMessageId }) => ({
      organizationId,
      accountId,
      providerEventId,
      providerMessageId,
    }))).toEqual([
      {
        accountId: "account-a",
        organizationId: "organization-a",
        providerEventId: "event-1",
        providerMessageId: "message-1",
      },
      {
        accountId: "account-b",
        organizationId: "organization-a",
        providerEventId: "event-1",
        providerMessageId: "message-1",
      },
      {
        accountId: "account-a",
        organizationId: "organization-b",
        providerEventId: "event-1",
        providerMessageId: "message-1",
      },
    ]);
  });

  it.each([
    ["cycle", () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      return cyclic;
    }],
    ["non-finite number", () => ({ bad: Number.NaN })],
    ["undefined", () => ({ bad: undefined })],
    ["function", () => ({ bad: () => undefined })],
    ["symbol", () => ({ bad: Symbol("bad") })],
    ["bigint", () => ({ bad: 1n })],
    ["unsafe prototype", () => new Date("2026-07-27T00:00:00.000Z")],
    ["sparse array", () => Array(1)],
    ["accessor", () => Object.defineProperty({}, "bad", { enumerable: true, get: () => "x" })],
  ] as const)("rejects non-JSON-safe raw evidence: %s", async (_label, rawEnvelope) => {
    let commits = 0;
    let dispatches = 0;
    install(async () => {
      commits += 1;
      return COMMITTED_ACK;
    });

    await expect(
      listener(async () => {
        dispatches += 1;
      })(input({ rawEnvelope: rawEnvelope() })),
    ).rejects.toMatchObject({ code: "INBOUND_ENVELOPE_INVALID" });
    expect({ commits, dispatches }).toEqual({ commits: 0, dispatches: 0 });
  });

  it("rejects raw array properties outside the exact dense index range", async () => {
    const rawEnvelope: unknown[] = [];
    Object.defineProperty(rawEnvelope, "4294967295", {
      configurable: true,
      enumerable: true,
      value: "must-not-be-ignored",
      writable: true,
    });
    let commits = 0;
    install(async () => {
      commits += 1;
      return COMMITTED_ACK;
    });

    await expect(listener(async () => undefined)(input({ rawEnvelope }))).rejects.toMatchObject({
      code: "INBOUND_ENVELOPE_INVALID",
    });
    expect(commits).toBe(0);
  });

  it("snapshots raw record keys and descriptors once before canonical hashing", async () => {
    let ownKeyReads = 0;
    const rawEnvelope = new Proxy({ mustPersist: "x" }, {
      ownKeys() {
        ownKeyReads += 1;
        return ownKeyReads === 1 ? ["mustPersist"] : [];
      },
    });
    let committed: unknown;
    install(async (envelope) => {
      committed = envelope;
      return COMMITTED_ACK;
    });

    await listener(async () => undefined)(input({ rawEnvelope }));

    expect(committed).toMatchObject({
      rawEnvelope: { mustPersist: "x" },
      rawEnvelopeSha256: sha256('{"mustPersist":"x"}'),
    });
    expect(ownKeyReads).toBe(1);
  });

  it("snapshots normalized media without invoking an overridden array map", async () => {
    const media: MediaInput[] = [];
    const maliciousMap = vi.fn(() => [{
      byteLength: null,
      fetchRef: null,
      kind: "IMAGE",
      mime: null,
      providerChecksum: null,
      providerMediaId: "injected",
    }]);
    Object.defineProperty(media, "map", {
      configurable: true,
      enumerable: false,
      value: maliciousMap,
      writable: true,
    });
    let commits = 0;
    install(async () => {
      commits += 1;
      return COMMITTED_ACK;
    });

    await expect(listener(async () => undefined)(input({
      normalized: {
        media,
        replyToProviderMessageId: null,
        text: "hello",
      },
    }))).rejects.toMatchObject({ code: "INBOUND_ENVELOPE_INVALID" });
    expect(maliciousMap).not.toHaveBeenCalled();
    expect(commits).toBe(0);
  });
});

describe("durable bridge acknowledgement and ordering", () => {
  it("installs the authenticated production readiness and durable commit client", async () => {
    const operations: string[] = [];
    const binding: BridgeRuntimeBindingV1 = Object.freeze({
      ...BINDING,
      accountId: "account-a",
      fencingToken: 9,
      controlVersion: 3,
      takeoverVersion: 2,
    });
    const bridgeSecret = Buffer.alloc(32, 0x32);
    const bridgeNow = Date.parse("2026-07-29T10:00:00.000Z");
    const factory = (runtimeBootstrap as unknown as {
      createProductionInboundBridge?: (options: unknown) => Parameters<
        typeof inboundBridge.installInboundBridgeCommitter
      >[0];
    }).createProductionInboundBridge;
    expect(typeof factory).toBe("function");
    const installation = factory!({
      binding,
      bridgeBaseUrl: "http://bridge.internal",
      bridgeSecret,
      now: () => bridgeNow,
      nonce: (() => {
        let value = 0;
        return () => `inbound-transport-${value += 1}`;
      })(),
      fetch: async (_url: string, init: RequestInit) => {
        const envelope = JSON.parse(String(init.body)) as SignedBridgeRequestV1;
        operations.push(envelope.operation);
        const signed = (body: unknown) => createSignedBridgeResponse({
          operation: envelope.operation,
          requestNonce: envelope.nonce,
          binding,
          body,
          secret: bridgeSecret,
          now: bridgeNow,
          ttlMs: 1_000,
        });
        if (envelope.operation === "inbound.ready") {
          return new Response(JSON.stringify(signed({ version: 1, status: "READY" })), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (envelope.operation === "inbound.commit") {
          expect(envelope.body).toMatchObject({
            version: 1,
            organizationId: BINDING.organizationId,
            accountId: "account-a",
            cellId: BINDING.cellId,
          });
          return new Response(JSON.stringify(signed(COMMITTED_ACK)), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected operation ${envelope.operation}`);
      },
    });
    const uninstall = inboundBridge.installInboundBridgeCommitter(installation);
    cleanups.push(uninstall);

    await inboundBridge.ensureInboundBridgeReady("account-a");
    await expect(inboundBridge.commitInboundThroughBridge("account-a", input() as never))
      .resolves.toMatchObject({ status: "committed" });
    expect(operations).toEqual(["inbound.ready", "inbound.commit"]);
  });

  it("permits dispatch only after an exact committed WAL/FULL acknowledgement", async () => {
    let resolveCommit!: (value: unknown) => void;
    const commit = new Promise<unknown>((resolve) => {
      resolveCommit = resolve;
    });
    const events: string[] = [];
    install(async () => {
      events.push("commit-started");
      return await commit;
    });
    const pending = listener(async () => {
      events.push("dispatch");
    })(input());

    await vi.waitFor(() => expect(events).toEqual(["commit-started"]));
    expect(events).toEqual(["commit-started"]);
    resolveCommit(COMMITTED_ACK);

    await expect(pending).resolves.toMatchObject({ status: "dispatched" });
    expect(events).toEqual(["commit-started", "dispatch"]);
  });

  it("returns an exact duplicate without dispatch", async () => {
    let dispatches = 0;
    install(async () => ({ status: "duplicate", version: 1 }));

    await expect(
      listener(async () => {
        dispatches += 1;
      })(input()),
    ).resolves.toMatchObject({ status: "duplicate" });
    expect(dispatches).toBe(0);
  });

  it("snapshots acknowledgement descriptors once before choosing a status", async () => {
    let statusReads = 0;
    const target = {
      durability: { journalMode: "WAL", synchronous: "FULL" },
      status: "duplicate",
      version: 1,
    };
    const acknowledgement = new Proxy(target, {
      get(current, property, receiver) {
        if (property === "status") {
          statusReads += 1;
          return statusReads === 1 ? "duplicate" : "committed";
        }
        return Reflect.get(current, property, receiver);
      },
    });
    let dispatches = 0;
    install(async () => acknowledgement);

    await expect(listener(async () => {
      dispatches += 1;
    })(input())).rejects.toMatchObject({ code: "INBOUND_BRIDGE_INVALID_ACK" });
    expect(dispatches).toBe(0);
  });

  it("fails closed on an exact collision", async () => {
    let dispatches = 0;
    install(async () => ({ status: "collision", version: 1 }));

    await expect(
      listener(async () => {
        dispatches += 1;
      })(input()),
    ).rejects.toMatchObject({ code: "INBOUND_ID_COLLISION" });
    expect(dispatches).toBe(0);
  });

  it.each([
    ["old reduced ack", { status: "committed" }],
    ["wrong journal", { ...COMMITTED_ACK, durability: { journalMode: "DELETE", synchronous: "FULL" } }],
    ["wrong synchronous mode", { ...COMMITTED_ACK, durability: { journalMode: "WAL", synchronous: "NORMAL" } }],
    ["extra acknowledgement evidence", { ...COMMITTED_ACK, localSequence: 1 }],
    ["duplicate with extra field", { status: "duplicate", version: 1, payloadHash: "unexpected" }],
    ["unknown status", { status: "ok", version: 1 }],
    ["null", null],
  ])("rejects a malformed or corrupt acknowledgement: %s", async (_label, acknowledgement) => {
    let dispatches = 0;
    install(async () => acknowledgement);

    await expect(
      listener(async () => {
        dispatches += 1;
      })(input()),
    ).rejects.toMatchObject({ code: "INBOUND_BRIDGE_INVALID_ACK" });
    expect(dispatches).toBe(0);
  });

  it.each([
    ["rejection", Object.assign(new Error("provider rejected bridge write"), { code: "REJECTED" })],
    ["timeout", Object.assign(new Error("bridge timeout"), { code: "ETIMEDOUT" })],
    ["process crash", Object.assign(new Error("bridge process exited"), { code: "EPIPE" })],
    ["ENOSPC", Object.assign(new Error("no space left on device"), { code: "ENOSPC" })],
  ])("dispatches nothing when commit fails: %s", async (_label, failure) => {
    let dispatches = 0;
    install(async () => {
      throw failure;
    });

    await expect(
      listener(async () => {
        dispatches += 1;
      })(input()),
    ).rejects.toBe(failure);
    expect(dispatches).toBe(0);
  });

  it("times out a stalled durable commit itself and dispatches nothing", async () => {
    let dispatches = 0;
    const uninstall = inboundBridge.installInboundBridgeCommitter({
      binding: BINDING,
      committer: async () => await new Promise<never>(() => undefined),
      ready: async () => undefined,
      commitTimeoutMs: 5,
      readinessTimeoutMs: 5,
    } as never);
    cleanups.push(uninstall);

    await expect(listener(async () => {
      dispatches += 1;
    })(input())).rejects.toMatchObject({ code: "INBOUND_BRIDGE_COMMIT_TIMEOUT" });
    expect(dispatches).toBe(0);
  });

  it("checks authenticated bridge readiness before a provider listener may attach", async () => {
    const readyCalls: unknown[] = [];
    const ensureReady = (inboundBridge as unknown as {
      ensureInboundBridgeReady(accountId: string): Promise<void>;
    }).ensureInboundBridgeReady;
    expect(typeof ensureReady).toBe("function");
    const uninstall = inboundBridge.installInboundBridgeCommitter({
      binding: BINDING,
      committer: async () => COMMITTED_ACK,
      ready: async (accountId: string, binding: Binding) => {
        readyCalls.push({ accountId, binding });
      },
      commitTimeoutMs: 6_000,
      readinessTimeoutMs: 2_000,
    } as never);
    cleanups.push(uninstall);

    await expect(ensureReady("account-a")).resolves.toBeUndefined();
    expect(readyCalls).toEqual([{ accountId: "account-a", binding: BINDING }]);
  });

  it("fails closed when the process-scoped binding or committer is missing", async () => {
    await expect(
      listener(async () => {
        throw new Error("must not dispatch");
      })(input()),
    ).rejects.toMatchObject({ code: "INBOUND_BRIDGE_UNAVAILABLE" });

    expect(() => inboundBridge.installInboundBridgeCommitter({
      binding: BINDING,
    } as never)).toThrow();
    expect(() => inboundBridge.installInboundBridgeCommitter({
      committer: async () => COMMITTED_ACK,
    } as never)).toThrow();
    expect(() => inboundBridge.installInboundBridgeCommitter({
      binding: { ...BINDING, organizationId: "" },
      committer: async () => COMMITTED_ACK,
    } as never)).toThrow();
  });

  it("rejects concurrent bridge replacement and permits explicit uninstall then rotation", async () => {
    const firstUninstall = inboundBridge.installInboundBridgeCommitter({
      binding: BINDING,
      committer: async () => ({ status: "duplicate", version: 1 }),
      ready: async () => undefined,
      commitTimeoutMs: 6_000,
      readinessTimeoutMs: 2_000,
    } as never);
    cleanups.push(firstUninstall);

    expect(() => inboundBridge.installInboundBridgeCommitter({
      binding: { ...BINDING, sessionGeneration: 8 },
      committer: async () => COMMITTED_ACK,
      ready: async () => undefined,
      commitTimeoutMs: 6_000,
      readinessTimeoutMs: 2_000,
    } as never)).toThrowError(expect.objectContaining({
      code: "INBOUND_BRIDGE_ALREADY_INSTALLED",
    }));
    await expect(inboundBridge.commitInboundThroughBridge("account-a", input() as never))
      .resolves.toMatchObject({ status: "duplicate" });

    firstUninstall();
    cleanups.splice(cleanups.lastIndexOf(firstUninstall), 1);
    const secondUninstall = inboundBridge.installInboundBridgeCommitter({
      binding: { ...BINDING, sessionGeneration: 8 },
      committer: async () => COMMITTED_ACK,
      ready: async () => undefined,
      commitTimeoutMs: 6_000,
      readinessTimeoutMs: 2_000,
    } as never);
    cleanups.push(secondUninstall);
    await expect(inboundBridge.commitInboundThroughBridge("account-a", input() as never))
      .resolves.toMatchObject({
        envelope: { sessionGeneration: 8 },
        status: "committed",
      });
  });

  it("keeps the provider callback void while its internal Promise catches awaited failure", async () => {
    const invokeVoidProviderCallback = (
      inboundBridge as unknown as {
        invokeVoidProviderCallback(
          callback: () => void | Promise<void>,
          failListener: (error: Error) => void,
        ): void;
      }
    ).invokeVoidProviderCallback;
    let rejectCommit!: (reason: unknown) => void;
    const commit = new Promise<never>((_resolve, reject) => {
      rejectCommit = reject;
    });
    const failures: Error[] = [];
    let dispatches = 0;
    install(async () => await commit);

    const callbackResult = invokeVoidProviderCallback(
      () => listener(async () => {
        dispatches += 1;
      })(input()).then(() => undefined),
      (error) => failures.push(error),
    );

    expect(callbackResult).toBeUndefined();
    expect(failures).toEqual([]);
    const failure = Object.assign(new Error("WAL write failed"), { code: "ENOSPC" });
    rejectCommit(failure);
    await vi.waitFor(() => expect(failures).toEqual([failure]));
    expect(dispatches).toBe(0);
  });
});
