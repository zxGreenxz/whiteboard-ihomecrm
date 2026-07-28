import { describe, expect, it, vi } from "vitest";
import { createAuthorizeClient } from "../src/bridge/authorize-client.js";
import {
  assertAuthorizedProviderCall,
  assertAuthorizedProviderIo,
  createPrivateOutboundRpc,
} from "../src/bridge/outbound-rpc.js";
import {
  createPreparedOutboundBatch,
  createSendContext,
  verifySendContext,
  type BusinessFrame,
  type PreparedProviderCallV1,
  type ProviderSinkV1,
} from "../src/bridge/send-context.js";

const secret = Buffer.alloc(32, 0x24);
const MEDIA_SHA256 = "b".repeat(64);
const SINK: ProviderSinkV1 = Object.freeze({
  accountId: "account-a",
  accountProfile: "profile-a",
  conversationId: "thread-a",
  isGroup: false,
});
const FRAMES: readonly BusinessFrame[] = Object.freeze([
  Object.freeze({ kind: "text", text: "hello" }),
  Object.freeze({
    kind: "media",
    url: "file:///prepared/a.png",
    caption: "caption",
    byteLength: 2048,
    contentType: "image/png",
    name: "a.png",
    sha256: MEDIA_SHA256,
  }),
  Object.freeze({ kind: "link", url: "https://example.invalid", caption: "link" }),
  Object.freeze({
    kind: "reaction",
    msgId: "message-1",
    cliMsgId: "cli-1",
    emoji: "❤",
    remove: false,
  }),
]);

function context(frames: readonly BusinessFrame[] = FRAMES, sink: ProviderSinkV1 = SINK) {
  return createSendContext({
    ...sink,
    expiresAt: 2_000,
    frames,
    issuedAt: 1_000,
    nonce: "nonce-a",
  }, secret);
}

function request(frames: readonly BusinessFrame[] = FRAMES, sink: ProviderSinkV1 = SINK) {
  return { context: context(frames, sink), sink, frames };
}

function changedCall(
  call: PreparedProviderCallV1,
  mutate: (copy: Record<string, unknown>) => void,
): PreparedProviderCallV1 {
  const copy = structuredClone(call) as unknown as Record<string, unknown>;
  mutate(copy);
  return copy as unknown as PreparedProviderCallV1;
}

describe("outbound exact frame and sink binding", () => {
  it("allows exactly 2000 Unicode code points and rejects 2001", () => {
    const exact = Object.freeze([{ kind: "text" as const, text: "😀".repeat(2_000) }]);
    const overflow = Object.freeze([{ kind: "text" as const, text: "😀".repeat(2_001) }]);

    expect(createPreparedOutboundBatch(SINK, exact).calls[0]).toMatchObject({
      frame: { text: exact[0]?.text },
    });
    expect(() => createPreparedOutboundBatch(SINK, overflow)).toThrowError(
      expect.objectContaining({ code: "INVALID_PROVIDER_FRAME" }),
    );
  });

  it.each([
    ["extra frame field", [{ kind: "text", text: "x", caption: "extra" }]],
    ["bad media sha", [{ ...FRAMES[1], sha256: "ABC" }]],
    ["zero media bytes", [{ ...FRAMES[1], byteLength: 0 }]],
    ["unsafe frame class", [new (class Frame { kind = "text"; text = "x"; })()]],
    ["extra sink field", FRAMES.slice(0, 1), { ...SINK, extra: true }],
    ["unsafe sink class", FRAMES.slice(0, 1), new (class Sink {
      accountId = SINK.accountId;
      accountProfile = SINK.accountProfile;
      conversationId = SINK.conversationId;
      isGroup = SINK.isGroup;
    })()],
  ] as const)("rejects strict input: %s", (_label, frames, sink = SINK) => {
    expect(() => createPreparedOutboundBatch(
      sink as ProviderSinkV1,
      frames as readonly BusinessFrame[],
    )).toThrow();
  });

  it.each([
    ["frame index", (call: PreparedProviderCallV1) => changedCall(call, (copy) => { copy.frameIndex = 1; })],
    ["accountId", (call: PreparedProviderCallV1) => changedCall(call, (copy) => {
      (copy.sink as Record<string, unknown>).accountId = "account-b";
    })],
    ["accountProfile", (call: PreparedProviderCallV1) => changedCall(call, (copy) => {
      (copy.sink as Record<string, unknown>).accountProfile = "profile-b";
    })],
    ["conversationId", (call: PreparedProviderCallV1) => changedCall(call, (copy) => {
      (copy.sink as Record<string, unknown>).conversationId = "thread-b";
    })],
    ["isGroup", (call: PreparedProviderCallV1) => changedCall(call, (copy) => {
      (copy.sink as Record<string, unknown>).isGroup = true;
    })],
    ["text", (call: PreparedProviderCallV1) => changedCall(call, (copy) => {
      (copy.frame as Record<string, unknown>).text = "changed";
    })],
  ] as const)("rejects altered %s before provider I/O", async (_label, alter) => {
    let authorizeCalls = 0;
    let providerCalls = 0;
    const rpc = createPrivateOutboundRpc({
      prepare: async (candidate) => createPreparedOutboundBatch(candidate.sink, candidate.frames.slice(0, 1)),
      authorize: async () => { authorizeCalls += 1; },
      sendPrepared: async (call) => {
        assertAuthorizedProviderCall(alter(call));
        assertAuthorizedProviderIo(call.sink);
        providerCalls += 1;
        return {};
      },
    });

    await expect(rpc.invoke("zalouser.bridge.send", request(FRAMES.slice(0, 1))))
      .rejects.toMatchObject({ code: "AUTHORIZED_PROVIDER_CALL_MISMATCH" });
    expect(authorizeCalls).toBe(1);
    expect(providerCalls).toBe(0);
  });

  it.each([
    [0, "text"],
    [1, "caption"],
    [1, "byteLength"],
    [1, "contentType"],
    [1, "name"],
    [1, "sha256"],
    [1, "url"],
    [2, "caption"],
    [2, "url"],
    [3, "msgId"],
    [3, "cliMsgId"],
    [3, "emoji"],
    [3, "remove"],
  ] as const)("binds frame %d field %s", async (frameIndex, field) => {
    const selectedFrame = FRAMES[frameIndex];
    if (!selectedFrame) throw new Error(`missing fixture frame ${frameIndex}`);
    const selectedFrames = Object.freeze([selectedFrame]);
    let providerCalls = 0;
    const rpc = createPrivateOutboundRpc({
      prepare: async (candidate) => createPreparedOutboundBatch(candidate.sink, candidate.frames),
      authorize: async () => undefined,
      sendPrepared: async (call) => {
        const actual = changedCall(call, (copy) => {
          const frame = copy.frame as Record<string, unknown>;
          frame[field] = typeof frame[field] === "boolean" ? !frame[field] : `${String(frame[field])}-changed`;
        });
        assertAuthorizedProviderCall(actual);
        assertAuthorizedProviderIo(call.sink);
        providerCalls += 1;
        return {};
      },
    });

    await expect(rpc.invoke("zalouser.bridge.send", request(selectedFrames))).rejects.toMatchObject({
      code: "AUTHORIZED_PROVIDER_CALL_MISMATCH",
    });
    expect(providerCalls).toBe(0);
  });

  it.each(["accountId", "accountProfile", "conversationId", "isGroup"] as const)(
    "rechecks actual provider I/O sink field %s without reauthorizing",
    async (field) => {
      let authorizeCalls = 0;
      let providerCalls = 0;
      const rpc = createPrivateOutboundRpc({
        prepare: async (candidate) => createPreparedOutboundBatch(candidate.sink, candidate.frames),
        authorize: async () => { authorizeCalls += 1; },
        sendPrepared: async (call) => {
          assertAuthorizedProviderCall(call);
          const actualSink = { ...call.sink } as Record<string, unknown>;
          actualSink[field] = typeof actualSink[field] === "boolean"
            ? !actualSink[field]
            : `${String(actualSink[field])}-changed`;
          assertAuthorizedProviderIo(actualSink as ProviderSinkV1);
          providerCalls += 1;
          return {};
        },
      });

      await expect(rpc.invoke("zalouser.bridge.send", request(FRAMES.slice(0, 1))))
        .rejects.toMatchObject({ code: "AUTHORIZED_PROVIDER_SINK_MISMATCH" });
      expect(authorizeCalls).toBe(1);
      expect(providerCalls).toBe(0);
    },
  );

  it("rejects swapped prepared order before authorization", async () => {
    const authorize = vi.fn(async () => undefined);
    const sendPrepared = vi.fn(async () => ({}));
    const rpc = createPrivateOutboundRpc({
      prepare: async (candidate) => createPreparedOutboundBatch(
        candidate.sink,
        [...candidate.frames].reverse(),
      ),
      authorize,
      sendPrepared,
    });

    await expect(rpc.invoke("zalouser.bridge.send", request())).rejects.toMatchObject({
      code: "INVALID_PROVIDER_BATCH",
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(sendPrepared).not.toHaveBeenCalled();
  });

  it("binds frame index even when duplicate frames are structurally identical", async () => {
    const duplicate = Object.freeze({ kind: "text" as const, text: "same" });
    const frames = Object.freeze([duplicate, duplicate]);
    let providerCalls = 0;
    const rpc = createPrivateOutboundRpc({
      prepare: async (candidate) => createPreparedOutboundBatch(candidate.sink, candidate.frames),
      authorize: async () => undefined,
      sendPrepared: async (call) => {
        assertAuthorizedProviderCall(changedCall(call, (copy) => {
          copy.frameIndex = call.frameIndex === 0 ? 1 : 0;
        }));
        assertAuthorizedProviderIo(call.sink);
        providerCalls += 1;
        return {};
      },
    });

    await expect(rpc.invoke("zalouser.bridge.send", request(frames))).rejects.toMatchObject({
      code: "AUTHORIZED_PROVIDER_CALL_MISMATCH",
    });
    expect(providerCalls).toBe(0);
  });
});

describe("outbound fail-closed outcomes", () => {
  it.each([
    ["denied", Object.assign(new Error("denied"), { code: "AUTHORIZATION_DENIED" })],
    ["server error", Object.assign(new Error("error"), { code: "AUTHORIZATION_ERROR" })],
    ["stale", Object.assign(new Error("stale"), { code: "AUTHORIZATION_STALE" })],
    ["replay", Object.assign(new Error("replay"), { code: "AUTHORIZATION_REPLAY" })],
    ["hash mismatch", Object.assign(new Error("hash"), { code: "AUTHORIZATION_HASH_MISMATCH" })],
  ])("emits zero provider calls when authorization is %s", async (_label, failure) => {
    const sendPrepared = vi.fn(async () => ({}));
    const rpc = createPrivateOutboundRpc({
      prepare: async (candidate) => createPreparedOutboundBatch(candidate.sink, candidate.frames),
      authorize: async () => { throw failure; },
      sendPrepared,
    });

    await expect(rpc.invoke("zalouser.bridge.send", request())).rejects.toBe(failure);
    expect(sendPrepared).not.toHaveBeenCalled();
  });

  it("emits zero provider calls on authorization timeout", async () => {
    const authorize = createAuthorizeClient({
      call: async () => await new Promise<void>(() => undefined),
      timeoutMs: 5,
    });
    const sendPrepared = vi.fn(async () => ({}));
    const rpc = createPrivateOutboundRpc({
      prepare: async (candidate) => createPreparedOutboundBatch(candidate.sink, candidate.frames),
      authorize,
      sendPrepared,
    });

    await expect(rpc.invoke("zalouser.bridge.send", request())).rejects.toMatchObject({
      code: "AUTHORIZATION_TIMEOUT",
    });
    expect(sendPrepared).not.toHaveBeenCalled();
  });

  it("rejects stale or hash-mismatched context before provider I/O", async () => {
    const sendPrepared = vi.fn(async () => ({}));
    const staleRpc = createPrivateOutboundRpc({
      prepare: async (candidate) => createPreparedOutboundBatch(candidate.sink, candidate.frames),
      authorize: async (candidate, batch) => {
        verifySendContext(candidate.context, batch, { now: 2_001, secret });
      },
      sendPrepared,
    });
    await expect(staleRpc.invoke("zalouser.bridge.send", request())).rejects.toMatchObject({
      code: "STALE_SEND_CONTEXT",
    });

    const otherFrames = Object.freeze([{ kind: "text" as const, text: "other" }]);
    const mismatchRpc = createPrivateOutboundRpc({
      prepare: async (candidate) => createPreparedOutboundBatch(candidate.sink, candidate.frames),
      authorize: async (candidate, batch) => {
        verifySendContext(candidate.context, batch, { now: 1_500, secret });
      },
      sendPrepared,
    });
    await expect(mismatchRpc.invoke("zalouser.bridge.send", {
      context: context(otherFrames),
      sink: SINK,
      frames: FRAMES,
    })).rejects.toMatchObject({ code: "INVALID_SEND_CONTEXT" });
    expect(sendPrepared).not.toHaveBeenCalled();
  });

  it("returns UNKNOWN only after the provider boundary is entered and never retries", async () => {
    let providerCalls = 0;
    const rpc = createPrivateOutboundRpc({
      prepare: async (candidate) => createPreparedOutboundBatch(candidate.sink, candidate.frames.slice(0, 1)),
      authorize: async () => undefined,
      sendPrepared: async (call) => {
        assertAuthorizedProviderCall(call);
        assertAuthorizedProviderIo(call.sink);
        providerCalls += 1;
        throw new Error("connection closed after write");
      },
    });

    await expect(rpc.invoke("zalouser.bridge.send", request(FRAMES.slice(0, 1))))
      .resolves.toEqual({ receipts: [], status: "UNKNOWN" });
    expect(providerCalls).toBe(1);
  });

  it("rejects errors before provider I/O instead of misclassifying them as UNKNOWN", async () => {
    const failure = new Error("local preparation failed after wrapper entry");
    const rpc = createPrivateOutboundRpc({
      prepare: async (candidate) => createPreparedOutboundBatch(candidate.sink, candidate.frames.slice(0, 1)),
      authorize: async () => undefined,
      sendPrepared: async (call) => {
        assertAuthorizedProviderCall(call);
        throw failure;
      },
    });

    await expect(rpc.invoke("zalouser.bridge.send", request(FRAMES.slice(0, 1))))
      .rejects.toBe(failure);
  });

  it("keeps UNKNOWN when a later call fails before I/O after an earlier handoff", async () => {
    const failure = new Error("second frame wrapper mismatch");
    let calls = 0;
    const rpc = createPrivateOutboundRpc({
      prepare: async (candidate) => createPreparedOutboundBatch(candidate.sink, candidate.frames.slice(0, 2)),
      authorize: async () => undefined,
      sendPrepared: async (call) => {
        assertAuthorizedProviderCall(call);
        if (call.frameIndex === 1) throw failure;
        assertAuthorizedProviderIo(call.sink);
        calls += 1;
        return { providerMessageId: "provider-0" };
      },
    });

    await expect(rpc.invoke("zalouser.bridge.send", request(FRAMES.slice(0, 2))))
      .resolves.toEqual({
        receipts: [{ providerMessageId: "provider-0" }],
        status: "UNKNOWN",
      });
    expect(calls).toBe(1);
  });

  it("allows one provider boundary entry per authorized call", async () => {
    let providerCalls = 0;
    const rpc = createPrivateOutboundRpc({
      prepare: async (candidate) => createPreparedOutboundBatch(candidate.sink, candidate.frames.slice(0, 1)),
      authorize: async () => undefined,
      sendPrepared: async (call) => {
        assertAuthorizedProviderCall(call);
        assertAuthorizedProviderIo(call.sink);
        providerCalls += 1;
        assertAuthorizedProviderIo(call.sink);
        providerCalls += 1;
        return {};
      },
    });

    await expect(rpc.invoke("zalouser.bridge.send", request(FRAMES.slice(0, 1))))
      .resolves.toMatchObject({ status: "UNKNOWN" });
    expect(providerCalls).toBe(1);
  });
});
