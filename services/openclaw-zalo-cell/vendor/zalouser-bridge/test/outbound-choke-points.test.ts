import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  businessFramesFromPayload,
  providerSinkFromPayload,
  type ZaloUserBridgeSendParamsV1,
} from "../src/bridge/canonical-send.js";
import {
  assertAuthorizedProviderCall,
  assertAuthorizedProviderIo,
  createPrivateOutboundRpc,
  installPrivateOutboundRuntime,
  registerPrivateOutboundRpc,
} from "../src/bridge/outbound-rpc.js";
import * as outboundRuntimeModule from "../src/bridge/runtime-bootstrap.js";
import { createPreparedOutboundBatch } from "../src/bridge/send-context.js";
import { FRAMES, REQUEST, SINK, makeRequest } from "./outbound-fixtures.js";

const runtimeCleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of runtimeCleanups.splice(0).reverse()) cleanup();
});

function prepareRequest(request: ZaloUserBridgeSendParamsV1) {
  return createPreparedOutboundBatch(
    providerSinkFromPayload(request.payload),
    businessFramesFromPayload(request.payload),
  );
}

describe("private outbound RPC exact choke point", () => {
  it("installs a production runtime that materializes media before immediate authorization", async () => {
    const bytes = Buffer.from("real-media-bytes", "utf8");
    const mediaRequest = makeRequest([
      Object.freeze({
        version: 1,
        partIndex: 0,
        kind: "MEDIA",
        objectKey: "organization-a/account-a/outbox-a/materialized",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        mime: "image/png",
        bytes: bytes.length,
      }),
    ]);
    const mediaPart = mediaRequest.payload.parts[0];
    if (!mediaPart || mediaPart.kind !== "MEDIA") throw new Error("missing media fixture");
    const events: string[] = [];
    const factory = (outboundRuntimeModule as unknown as {
      createProductionBridgeRuntime?: (options: unknown) => ReturnType<typeof createPrivateOutboundRpc> extends never
        ? never
        : Parameters<typeof createPrivateOutboundRpc>[0] & { assertClient(client: unknown): Promise<void> };
    }).createProductionBridgeRuntime;
    expect(typeof factory).toBe("function");
    const runtime = factory!({
      binding: {
        organizationId: "organization-a",
        accountId: "account-a",
        cellId: "cell-a",
        sessionGeneration: 7,
        fencingToken: 9,
        controlVersion: 3,
        takeoverVersion: 2,
      },
      bridgeBaseUrl: "http://bridge.internal",
      bridgeSecret: Buffer.alloc(32, 0x31),
      gatewayClientId: "bridge-client-a",
      now: () => Date.parse("2026-07-29T10:00:00.000Z"),
      nonce: (() => {
        let value = 0;
        return () => `transport-nonce-${value += 1}`;
      })(),
      fetch: async (_url: string, init: RequestInit) => {
        const envelope = JSON.parse(String(init.body)) as {
          operation: string;
          body: unknown;
        };
        events.push(envelope.operation);
        if (envelope.operation === "media.materialize") {
          return new Response(JSON.stringify({
            version: 1,
            objectKey: mediaPart.objectKey,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            mime: "image/png",
            bytes: bytes.length,
            contentBase64: bytes.toString("base64"),
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (envelope.operation === "outbox.authorize-send") {
          expect(envelope.body).toEqual(mediaRequest.authorization);
          return new Response(JSON.stringify({ version: 1, status: "AUTHORIZED" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected operation ${envelope.operation}`);
      },
      loadProviderSender: async () => ({
        prepareSession: async (accountProfile: string) => {
          events.push("session.ready");
          expect(accountProfile).toBe("profile-a");
          return Object.freeze({ accountProfile });
        },
        send: async (
          call: ReturnType<typeof prepareRequest>["calls"][number],
          media: Buffer | undefined,
          session: Readonly<{ accountProfile: string }>,
        ) => {
          events.push("provider");
          expect(session.accountProfile).toBe("profile-a");
          assertAuthorizedProviderCall(call);
          assertAuthorizedProviderIo(call.sink);
          expect(media).toEqual(bytes);
          return { providerMessageId: "provider-media-1" };
        },
      }),
    });
    const rpc = createPrivateOutboundRpc(runtime);

    await expect(rpc.invoke("zalouser.bridge.send", mediaRequest)).resolves.toEqual({
      knownProviderMessageIds: ["provider-media-1"],
      possibleHandoffPrefixLength: 1,
      reasonCode: "ALL_PARTS_ACKNOWLEDGED",
      receipts: [{ providerMessageId: "provider-media-1" }],
      status: "SENT",
      totalPartCount: 1,
    });
    expect(events).toEqual([
      "media.materialize",
      "session.ready",
      "outbox.authorize-send",
      "provider",
    ]);
  });

  it("rejects a stale fencing/control/takeover binding before any bridge or provider call", async () => {
    const factory = (outboundRuntimeModule as unknown as {
      createProductionBridgeRuntime(options: unknown): Parameters<typeof createPrivateOutboundRpc>[0];
    }).createProductionBridgeRuntime;
    const fetchCalls: string[] = [];
    const runtime = factory({
      binding: {
        organizationId: "organization-a",
        accountId: "account-a",
        cellId: "cell-a",
        sessionGeneration: 7,
        fencingToken: 10,
        controlVersion: 3,
        takeoverVersion: 2,
      },
      bridgeBaseUrl: "http://bridge.internal",
      bridgeSecret: Buffer.alloc(32, 0x33),
      gatewayClientId: "bridge-client-a",
      now: () => Date.parse("2026-07-29T10:00:00.000Z"),
      nonce: () => "unused-nonce",
      fetch: async () => {
        fetchCalls.push("fetch");
        throw new Error("must not call bridge");
      },
      loadProviderSender: async () => {
        throw new Error("must not load provider");
      },
    });

    await expect(createPrivateOutboundRpc(runtime).invoke("zalouser.bridge.send", REQUEST))
      .rejects.toMatchObject({ code: "BRIDGE_BINDING_MISMATCH" });
    expect(fetchCalls).toEqual([]);
  });

  it("materializes the execution before authorization and performs no awaited preparation after it", async () => {
    const events: string[] = [];
    const createRpc = createPrivateOutboundRpc as unknown as (options: unknown) => {
      invoke(method: string, request: ZaloUserBridgeSendParamsV1): Promise<unknown>;
    };
    const rpc = createRpc({
      prepare: async (request: ZaloUserBridgeSendParamsV1) => {
        events.push("media-ready");
        return Object.freeze({
          batch: prepareRequest(request),
          sendPrepared: async (call: ReturnType<typeof prepareRequest>["calls"][number]) => {
            events.push(`provider:${call.frameIndex}`);
            assertAuthorizedProviderCall(call);
            assertAuthorizedProviderIo(call.sink);
            return { providerMessageId: `provider-${call.frameIndex}` };
          },
        });
      },
      authorize: async () => {
        events.push("authorize");
      },
    });

    await expect(rpc.invoke("zalouser.bridge.send", REQUEST)).resolves.toMatchObject({
      status: "SENT",
    });
    expect(events).toEqual(["media-ready", "authorize", "provider:0", "provider:1"]);
  });

  it("freezes the complete canonical request and ordered batch before one authorization", async () => {
    const events: string[] = [];
    const prepared = createPreparedOutboundBatch(SINK, FRAMES);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.calls)).toBe(true);
    expect(prepared.calls.every((call) => Object.isFrozen(call) && Object.isFrozen(call.frame))).toBe(true);
    const rpc = createPrivateOutboundRpc({
      prepare: async (request) => {
        events.push("prepare");
        expect(Object.isFrozen(request)).toBe(true);
        expect(Object.isFrozen(request.payload)).toBe(true);
        expect(Object.isFrozen(request.payload.parts)).toBe(true);
        expect(Object.isFrozen(request.authorization.authorizationMarker)).toBe(true);
        return Object.freeze({
          batch: prepareRequest(request),
          sendPrepared: async (call: ReturnType<typeof prepareRequest>["calls"][number]) => {
            events.push(`wrapper:${call.frameIndex}`);
            assertAuthorizedProviderCall(call);
            events.push(`io-check:${call.frameIndex}`);
            assertAuthorizedProviderIo(call.sink);
            events.push(`provider:${call.frameIndex}`);
            return { providerMessageId: `provider-${call.frameIndex}` };
          },
        });
      },
      authorize: async (request) => {
        events.push("authorize");
        expect(request).toEqual(REQUEST);
      },
    });

    await expect(rpc.invoke("zalouser.bridge.send", REQUEST)).resolves.toEqual({
      knownProviderMessageIds: FRAMES.map((_frame, index) => `provider-${index}`),
      possibleHandoffPrefixLength: FRAMES.length,
      reasonCode: "ALL_PARTS_ACKNOWLEDGED",
      receipts: FRAMES.map((_frame, index) => ({ providerMessageId: `provider-${index}` })),
      status: "SENT",
      totalPartCount: FRAMES.length,
    });
    expect(events).toEqual([
      "prepare",
      "authorize",
      "wrapper:0",
      "io-check:0",
      "provider:0",
      "wrapper:1",
      "io-check:1",
      "provider:1",
    ]);
  });

  it("uses immutable snapshots when the caller mutates request objects during authorization", async () => {
    const mutable = structuredClone(REQUEST) as unknown as {
      payload: { accountProfile: string; parts: Array<Record<string, unknown>> };
      authorization: { authorizationMarker: { markerNonce: string } };
    };
    const providerCalls: unknown[] = [];
    const rpc = createPrivateOutboundRpc({
      prepare: async (request) => Object.freeze({
        batch: prepareRequest(request),
        sendPrepared: async (call: ReturnType<typeof prepareRequest>["calls"][number]) => {
          assertAuthorizedProviderCall(call);
          assertAuthorizedProviderIo(call.sink);
          providerCalls.push(call);
          return { providerMessageId: `provider-${call.frameIndex}` };
        },
      }),
      authorize: async () => {
        mutable.payload.accountProfile = "mutated-profile";
        mutable.payload.parts[0]!.text = "mutated-text";
        mutable.authorization.authorizationMarker.markerNonce = "mutated-nonce";
      },
    });

    await rpc.invoke("zalouser.bridge.send", mutable as unknown as ZaloUserBridgeSendParamsV1);

    expect(providerCalls).toMatchObject([
      { sink: { accountProfile: "profile-a" }, frame: { kind: "text", text: "one" } },
      { frame: { kind: "media", objectKey: "organization-a/account-a/outbox-a/part-1" } },
    ]);
  });

  it("registers only the private method and validates the dedicated bridge client", async () => {
    let registered: undefined | {
      handler: (request: unknown) => Promise<void>;
      method: string;
      options: { scope: string };
    };
    const uninstall = installPrivateOutboundRuntime({
      assertClient: async (client) => {
        if ((client as { id?: string })?.id !== "bridge-a") throw new Error("wrong bridge client");
      },
      prepare: async (request) => Object.freeze({
        batch: prepareRequest(request),
        sendPrepared: async (call: ReturnType<typeof prepareRequest>["calls"][number]) => {
          assertAuthorizedProviderCall(call);
          assertAuthorizedProviderIo(call.sink);
          return { providerMessageId: `provider-${call.frameIndex}` };
        },
      }),
      authorize: async () => undefined,
    });
    runtimeCleanups.push(uninstall);
    registerPrivateOutboundRpc({
      registerGatewayMethod(method, handler, options) {
        registered = { method, handler, options };
      },
    });
    const responses: unknown[] = [];

    await registered?.handler({
      client: { id: "bridge-a" },
      params: REQUEST,
      respond: (...arguments_: unknown[]) => responses.push(arguments_),
    });

    expect(registered).toMatchObject({
      method: "zalouser.bridge.send",
      options: { scope: "operator.write" },
    });
    expect(responses).toEqual([[true, expect.objectContaining({ status: "SENT" })]]);
    expect(() => assertAuthorizedProviderCall(createPreparedOutboundBatch(SINK, FRAMES).calls[0]!))
      .toThrowError(expect.objectContaining({ code: "PRIVATE_RPC_REQUIRED" }));
    expect(() => assertAuthorizedProviderIo(SINK)).toThrowError(
      expect.objectContaining({ code: "PRIVATE_RPC_REQUIRED" }),
    );
    uninstall();
  });

  it("rejects a concurrent runtime replacement", () => {
    const runtime = {
      assertClient: async () => undefined,
      prepare: async (request: ZaloUserBridgeSendParamsV1) => Object.freeze({
        batch: prepareRequest(request),
        sendPrepared: async () => ({}),
      }),
      authorize: async () => undefined,
    };
    const uninstall = installPrivateOutboundRuntime(runtime);
    runtimeCleanups.push(uninstall);
    expect(() => installPrivateOutboundRuntime(runtime)).toThrowError(
      expect.objectContaining({ code: "PRIVATE_OUTBOUND_RUNTIME_ALREADY_INSTALLED" }),
    );
    uninstall();
  });

  it("rejects generic methods before preparation or authorization", async () => {
    const prepare = vi.fn(async (request: ZaloUserBridgeSendParamsV1) => Object.freeze({
      batch: prepareRequest(request),
      sendPrepared: async () => ({}),
    }));
    const authorize = vi.fn(async () => undefined);
    const rpc = createPrivateOutboundRpc({ prepare, authorize });

    await expect(rpc.invoke("send", makeRequest())).rejects.toMatchObject({
      code: "PRIVATE_RPC_REQUIRED",
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });
});
