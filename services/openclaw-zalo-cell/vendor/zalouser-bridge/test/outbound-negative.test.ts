import { describe, expect, it, vi } from "vitest";
import { createAuthorizeClient } from "../src/bridge/authorize-client.js";
import {
  businessFramesFromPayload,
  providerSinkFromPayload,
  type ZaloUserBridgeSendParamsV1,
  type ZaloUserBridgeSendPartV1,
} from "../src/bridge/canonical-send.js";
import {
  assertAuthorizedProviderCall,
  assertAuthorizedProviderIo,
  createPrivateOutboundRpc,
  installPrivateOutboundRuntime,
  registerPrivateOutboundRpc,
} from "../src/bridge/outbound-rpc.js";
import {
  createPreparedOutboundBatch,
  type BusinessFrame,
  type PreparedProviderCallV1,
  type ProviderSinkV1,
} from "../src/bridge/send-context.js";
import { FRAMES, MEDIA_PART, PARTS, REQUEST, SINK, TEXT_PART, makeRequest } from "./outbound-fixtures.js";

function prepareRequest(request: ZaloUserBridgeSendParamsV1) {
  return createPreparedOutboundBatch(
    providerSinkFromPayload(request.payload),
    businessFramesFromPayload(request.payload),
  );
}

type SendPrepared = (
  call: ReturnType<typeof prepareRequest>["calls"][number],
) => Promise<{ providerMessageId?: string }>;

function preparedExecution(
  request: ZaloUserBridgeSendParamsV1,
  sendPrepared: SendPrepared = async () => ({}),
) {
  return Object.freeze({ batch: prepareRequest(request), sendPrepared });
}

function changedCall(
  call: PreparedProviderCallV1,
  mutate: (copy: Record<string, unknown>) => void,
): PreparedProviderCallV1 {
  const copy = structuredClone(call) as unknown as Record<string, unknown>;
  mutate(copy);
  return copy as unknown as PreparedProviderCallV1;
}

function reindex(parts: readonly ZaloUserBridgeSendPartV1[]): readonly ZaloUserBridgeSendPartV1[] {
  return Object.freeze(parts.map((part, partIndex) => Object.freeze({ ...part, partIndex })));
}

describe("outbound exact frame and sink binding", () => {
  it("allows exactly 2000 Unicode code points and rejects 2001", async () => {
    const exact = makeRequest([Object.freeze({ ...TEXT_PART, text: "😀".repeat(2_000) })]);
    const overflow = structuredClone(exact) as unknown as { payload: { parts: Array<{ text: string }> } };
    overflow.payload.parts[0]!.text = "😀".repeat(2_001);

    expect(businessFramesFromPayload(exact.payload)[0]).toMatchObject({
      text: exact.payload.parts[0]?.kind === "TEXT" ? exact.payload.parts[0].text : undefined,
    });
    await expect(createPrivateOutboundRpc({
      prepare: async (request) => preparedExecution(request),
      authorize: async () => undefined,
    }).invoke("zalouser.bridge.send", overflow as unknown as ZaloUserBridgeSendParamsV1))
      .rejects.toMatchObject({ code: "INVALID_PRIVATE_SEND_REQUEST" });
  });

  it.each([
    ["extra frame field", [{ kind: "text", text: "x", caption: "extra" }]],
    ["bad media sha", [{ ...FRAMES[1], sha256: "ABC" }]],
    ["zero media bytes", [{ ...FRAMES[1], byteLength: 0 }]],
    ["legacy media URL", [{ kind: "media", url: "file:///x", caption: null, byteLength: 1, contentType: "image/png", name: null, sha256: "a".repeat(64) }]],
    ["unsafe frame class", [new (class Frame { kind = "text"; text = "x"; })()]],
    ["extra sink field", FRAMES.slice(0, 1), { ...SINK, extra: true }],
    ["unsafe sink class", FRAMES.slice(0, 1), new (class Sink {
      accountId = SINK.accountId;
      accountProfile = SINK.accountProfile;
      conversationId = SINK.conversationId;
      isGroup = SINK.isGroup;
    })()],
  ] as const)("rejects strict provider input: %s", (_label, frames, sink = SINK) => {
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
      (copy.sink as Record<string, unknown>).isGroup = false;
    })],
    ["text", (call: PreparedProviderCallV1) => changedCall(call, (copy) => {
      (copy.frame as Record<string, unknown>).text = "changed";
    })],
  ] as const)("rejects altered %s before provider I/O", async (_label, alter) => {
    let authorizeCalls = 0;
    let providerCalls = 0;
    const request = makeRequest([TEXT_PART]);
    const rpc = createPrivateOutboundRpc({
      prepare: async (candidate) => preparedExecution(candidate, async (call) => {
        assertAuthorizedProviderCall(alter(call));
        assertAuthorizedProviderIo(call.sink);
        providerCalls += 1;
        return {};
      }),
      authorize: async () => { authorizeCalls += 1; },
    });

    await expect(rpc.invoke("zalouser.bridge.send", request))
      .rejects.toMatchObject({ code: "AUTHORIZED_PROVIDER_CALL_MISMATCH" });
    expect(authorizeCalls).toBe(1);
    expect(providerCalls).toBe(0);
  });

  it.each([
    [0, "text"],
    [1, "objectKey"],
    [1, "byteLength"],
    [1, "contentType"],
    [1, "sha256"],
  ] as const)("binds frame %d field %s", async (frameIndex, field) => {
    const selectedPart = PARTS[frameIndex];
    if (!selectedPart) throw new Error(`missing fixture part ${frameIndex}`);
    const selectedRequest = makeRequest(reindex([selectedPart]));
    let providerCalls = 0;
    const rpc = createPrivateOutboundRpc({
      prepare: async (candidate) => preparedExecution(candidate, async (call) => {
        const actual = changedCall(call, (copy) => {
          const frame = copy.frame as Record<string, unknown>;
          frame[field] = `${String(frame[field])}-changed`;
        });
        assertAuthorizedProviderCall(actual);
        assertAuthorizedProviderIo(call.sink);
        providerCalls += 1;
        return {};
      }),
      authorize: async () => undefined,
    });

    await expect(rpc.invoke("zalouser.bridge.send", selectedRequest)).rejects.toMatchObject({
      code: "AUTHORIZED_PROVIDER_CALL_MISMATCH",
    });
    expect(providerCalls).toBe(0);
  });

  it.each(["accountId", "accountProfile", "conversationId", "isGroup"] as const)(
    "rechecks actual provider I/O sink field %s without reauthorizing",
    async (field) => {
      let authorizeCalls = 0;
      let providerCalls = 0;
      const request = makeRequest([TEXT_PART]);
      const rpc = createPrivateOutboundRpc({
        prepare: async (candidate) => preparedExecution(candidate, async (call) => {
          assertAuthorizedProviderCall(call);
          const actualSink = { ...call.sink } as Record<string, unknown>;
          actualSink[field] = typeof actualSink[field] === "boolean"
            ? !actualSink[field]
            : `${String(actualSink[field])}-changed`;
          assertAuthorizedProviderIo(actualSink as ProviderSinkV1);
          providerCalls += 1;
          return {};
        }),
        authorize: async () => { authorizeCalls += 1; },
      });

      await expect(rpc.invoke("zalouser.bridge.send", request))
        .rejects.toMatchObject({ code: "AUTHORIZED_PROVIDER_SINK_MISMATCH" });
      expect(authorizeCalls).toBe(1);
      expect(providerCalls).toBe(0);
    },
  );

  it("rejects swapped prepared order before authorization", async () => {
    const authorize = vi.fn(async () => undefined);
    const sendPrepared = vi.fn(async () => ({}));
    const rpc = createPrivateOutboundRpc({
      prepare: async (candidate) => Object.freeze({
        batch: createPreparedOutboundBatch(
          providerSinkFromPayload(candidate.payload),
          [...businessFramesFromPayload(candidate.payload)].reverse(),
        ),
        sendPrepared,
      }),
      authorize,
    });

    await expect(rpc.invoke("zalouser.bridge.send", REQUEST)).rejects.toMatchObject({
      code: "INVALID_PROVIDER_BATCH",
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(sendPrepared).not.toHaveBeenCalled();
  });

  it("binds frame index even when duplicate frames are structurally identical", async () => {
    const parts = reindex([TEXT_PART, TEXT_PART]);
    let providerCalls = 0;
    const rpc = createPrivateOutboundRpc({
      prepare: async (candidate) => preparedExecution(candidate, async (call) => {
        assertAuthorizedProviderCall(changedCall(call, (copy) => {
          copy.frameIndex = call.frameIndex === 0 ? 1 : 0;
        }));
        assertAuthorizedProviderIo(call.sink);
        providerCalls += 1;
        return {};
      }),
      authorize: async () => undefined,
    });

    await expect(rpc.invoke("zalouser.bridge.send", makeRequest(parts))).rejects.toMatchObject({
      code: "AUTHORIZED_PROVIDER_CALL_MISMATCH",
    });
    expect(providerCalls).toBe(0);
  });
});

describe("complete authorization contract", () => {
  it.each([
    ["claimToken", (value: Record<string, unknown>) => { delete (value.authorization as Record<string, unknown>).claimToken; }],
    ["outboxId", (value: Record<string, unknown>) => { delete ((value.authorization as Record<string, unknown>).authorizationMarker as Record<string, unknown>).outboxId; }],
    ["claimGeneration", (value: Record<string, unknown>) => { delete ((value.authorization as Record<string, unknown>).authorizationMarker as Record<string, unknown>).claimGeneration; }],
    ["payloadHash", (value: Record<string, unknown>) => { ((value.authorization as Record<string, unknown>).authorizationMarker as Record<string, unknown>).payloadHash = "b".repeat(64); }],
    ["fencingToken", (value: Record<string, unknown>) => { delete ((value.authorization as Record<string, unknown>).authorizationMarker as Record<string, unknown>).fencingToken; }],
    ["sessionGeneration", (value: Record<string, unknown>) => { delete ((value.authorization as Record<string, unknown>).authorizationMarker as Record<string, unknown>).sessionGeneration; }],
    ["controlVersion", (value: Record<string, unknown>) => { delete ((value.authorization as Record<string, unknown>).authorizationMarker as Record<string, unknown>).controlVersion; }],
    ["takeoverVersion", (value: Record<string, unknown>) => { delete ((value.authorization as Record<string, unknown>).authorizationMarker as Record<string, unknown>).takeoverVersion; }],
    ["markerNonce", (value: Record<string, unknown>) => { delete ((value.authorization as Record<string, unknown>).authorizationMarker as Record<string, unknown>).markerNonce; }],
    ["expiresAt", (value: Record<string, unknown>) => { delete ((value.authorization as Record<string, unknown>).authorizationMarker as Record<string, unknown>).expiresAt; }],
  ] as const)("rejects missing or mismatched %s before preparation", async (_field, mutate) => {
    const candidate = structuredClone(REQUEST) as unknown as Record<string, unknown>;
    mutate(candidate);
    const sendPrepared = vi.fn(async () => ({}));
    const prepare = vi.fn(async (request: ZaloUserBridgeSendParamsV1) =>
      preparedExecution(request, sendPrepared));
    const authorize = vi.fn(async () => undefined);
    const rpc = createPrivateOutboundRpc({ prepare, authorize });

    await expect(rpc.invoke(
      "zalouser.bridge.send",
      candidate as unknown as ZaloUserBridgeSendParamsV1,
    )).rejects.toMatchObject({ code: expect.stringMatching(/INVALID|MISMATCH/u) });
    expect(prepare).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(sendPrepared).not.toHaveBeenCalled();
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
      prepare: async (candidate) => preparedExecution(candidate, sendPrepared),
      authorize: async () => { throw failure; },
    });

    await expect(rpc.invoke("zalouser.bridge.send", REQUEST)).rejects.toBe(failure);
    expect(sendPrepared).not.toHaveBeenCalled();
  });

  it("emits zero provider calls on authorization timeout", async () => {
    const authorize = createAuthorizeClient({
      call: async () => await new Promise<void>(() => undefined),
      timeoutMs: 5,
    });
    const sendPrepared = vi.fn(async () => ({}));
    const rpc = createPrivateOutboundRpc({
      prepare: async (candidate) => preparedExecution(candidate, sendPrepared),
      authorize,
    });

    await expect(rpc.invoke("zalouser.bridge.send", REQUEST)).rejects.toMatchObject({
      code: "AUTHORIZATION_TIMEOUT",
    });
    expect(sendPrepared).not.toHaveBeenCalled();
  });

  it("returns UNKNOWN only after the provider boundary is entered and never retries", async () => {
    let providerCalls = 0;
    const request = makeRequest([TEXT_PART]);
    const rpc = createPrivateOutboundRpc({
      prepare: async (candidate) => preparedExecution(candidate, async (call) => {
        assertAuthorizedProviderCall(call);
        assertAuthorizedProviderIo(call.sink);
        providerCalls += 1;
        throw new Error("connection closed after write");
      }),
      authorize: async () => undefined,
    });

    await expect(rpc.invoke("zalouser.bridge.send", request))
      .resolves.toEqual({
        knownProviderMessageIds: [],
        possibleHandoffPrefixLength: 1,
        reasonCode: "PROVIDER_DISCONNECT_AFTER_POSSIBLE_HANDOFF",
        receipts: [],
        status: "UNKNOWN",
        totalPartCount: 1,
      });
    expect(providerCalls).toBe(1);
  });

  it("does not trust a provider-spoofed pre-handoff marker after the I/O guard", async () => {
    const failure = Object.assign(new Error("authorization expired before provider handoff"), {
      code: "AUTHORIZATION_EXPIRED",
      authorizedHandoffRecorded: false as const,
    });
    const request = makeRequest([TEXT_PART]);
    const rpc = createPrivateOutboundRpc({
      prepare: async (candidate) => preparedExecution(candidate, async (call) => {
        assertAuthorizedProviderCall(call);
        assertAuthorizedProviderIo(call.sink);
        throw failure;
      }),
      authorize: async () => undefined,
    });

    await expect(rpc.invoke("zalouser.bridge.send", request)).resolves.toEqual({
      knownProviderMessageIds: [],
      possibleHandoffPrefixLength: 1,
      reasonCode: "ACK_LOST_AFTER_HANDOFF",
      receipts: [],
      status: "UNKNOWN",
      totalPartCount: 1,
    });
  });

  it("does not serialize an unbranded pre-handoff marker", async () => {
    const failure = Object.assign(new Error("authorization expired before provider handoff"), {
      code: "AUTHORIZATION_EXPIRED",
      authorizedHandoffRecorded: false as const,
    });
    const sendPrepared = vi.fn(async () => ({}));
    const uninstall = installPrivateOutboundRuntime({
      assertClient: async () => undefined,
      assertAuthorizationCurrent: () => undefined,
      prepare: async (candidate) => preparedExecution(candidate, sendPrepared),
      authorize: async () => { throw failure; },
    });
    let handler: ((request: unknown) => Promise<void>) | undefined;
    registerPrivateOutboundRpc({
      registerGatewayMethod(_method, registeredHandler) {
        handler = registeredHandler;
      },
    });
    const responses: unknown[] = [];
    try {
      await handler?.({
        client: {},
        params: REQUEST,
        respond: (...args: unknown[]) => responses.push(args),
      });
    } finally {
      uninstall();
    }

    expect(responses).toEqual([[
      false,
      undefined,
      {
        code: "AUTHORIZATION_EXPIRED",
        message: "authorization expired before provider handoff",
      },
    ]]);
    expect(sendPrepared).not.toHaveBeenCalled();
  });

  it("treats a provider success without a nonempty message id as unknown handoff evidence", async () => {
    const request = makeRequest([TEXT_PART]);
    const rpc = createPrivateOutboundRpc({
      prepare: async (candidate) => preparedExecution(candidate, async (call) => {
        assertAuthorizedProviderCall(call);
        assertAuthorizedProviderIo(call.sink);
        return {};
      }),
      authorize: async () => undefined,
    });

    await expect(rpc.invoke("zalouser.bridge.send", request)).resolves.toEqual({
      knownProviderMessageIds: [],
      possibleHandoffPrefixLength: 1,
      reasonCode: "ACK_LOST_AFTER_HANDOFF",
      receipts: [],
      status: "UNKNOWN",
      totalPartCount: 1,
    });
  });

  it("distinguishes a later pre-I/O failure from a post-I/O possible handoff", async () => {
    const makeRpc = (enterSecondIo: boolean) => createPrivateOutboundRpc({
      prepare: async (candidate) => preparedExecution(candidate, async (call) => {
        assertAuthorizedProviderCall(call);
        if (call.frameIndex === 0) {
          assertAuthorizedProviderIo(call.sink);
          return { providerMessageId: "provider-0" };
        }
        if (enterSecondIo) assertAuthorizedProviderIo(call.sink);
        throw new Error(enterSecondIo ? "connection closed after write" : "wrapper failed before I/O");
      }),
      authorize: async () => undefined,
    });

    await expect(makeRpc(false).invoke("zalouser.bridge.send", REQUEST)).resolves.toEqual({
      knownProviderMessageIds: ["provider-0"],
      possibleHandoffPrefixLength: 1,
      reasonCode: "ACK_LOST_AFTER_HANDOFF",
      receipts: [{ providerMessageId: "provider-0" }],
      status: "UNKNOWN",
      totalPartCount: 2,
    });
    await expect(makeRpc(true).invoke("zalouser.bridge.send", REQUEST)).resolves.toEqual({
      knownProviderMessageIds: ["provider-0"],
      possibleHandoffPrefixLength: 2,
      reasonCode: "PROVIDER_DISCONNECT_AFTER_POSSIBLE_HANDOFF",
      receipts: [{ providerMessageId: "provider-0" }],
      status: "UNKNOWN",
      totalPartCount: 2,
    });
  });

  it("rejects errors before provider I/O instead of misclassifying them as UNKNOWN", async () => {
    const failure = new Error("local preparation failed after wrapper entry");
    const request = makeRequest([TEXT_PART]);
    const rpc = createPrivateOutboundRpc({
      prepare: async (candidate) => preparedExecution(candidate, async (call) => {
        assertAuthorizedProviderCall(call);
        throw failure;
      }),
      authorize: async () => undefined,
    });

    await expect(rpc.invoke("zalouser.bridge.send", request)).rejects.toBe(failure);
  });

  it("keeps UNKNOWN when a later call fails before I/O after an earlier handoff", async () => {
    const failure = new Error("second frame wrapper mismatch");
    let calls = 0;
    const rpc = createPrivateOutboundRpc({
      prepare: async (candidate) => preparedExecution(candidate, async (call) => {
        assertAuthorizedProviderCall(call);
        if (call.frameIndex === 1) throw failure;
        assertAuthorizedProviderIo(call.sink);
        calls += 1;
        return { providerMessageId: "provider-0" };
      }),
      authorize: async () => undefined,
    });

    await expect(rpc.invoke("zalouser.bridge.send", REQUEST)).resolves.toEqual({
      knownProviderMessageIds: ["provider-0"],
      possibleHandoffPrefixLength: 1,
      reasonCode: "ACK_LOST_AFTER_HANDOFF",
      receipts: [{ providerMessageId: "provider-0" }],
      status: "UNKNOWN",
      totalPartCount: 2,
    });
    expect(calls).toBe(1);
  });

  it("allows one provider boundary entry per authorized call", async () => {
    let providerCalls = 0;
    const request = makeRequest([TEXT_PART]);
    const rpc = createPrivateOutboundRpc({
      prepare: async (candidate) => preparedExecution(candidate, async (call) => {
        assertAuthorizedProviderCall(call);
        assertAuthorizedProviderIo(call.sink);
        providerCalls += 1;
        assertAuthorizedProviderIo(call.sink);
        providerCalls += 1;
        return {};
      }),
      authorize: async () => undefined,
    });

    await expect(rpc.invoke("zalouser.bridge.send", request))
      .resolves.toMatchObject({ status: "UNKNOWN" });
    expect(providerCalls).toBe(1);
  });
});
