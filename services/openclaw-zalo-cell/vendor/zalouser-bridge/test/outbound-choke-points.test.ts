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
import {
  createSignedBridgeResponse,
  type BridgeRuntimeBindingV1,
  type SignedBridgeRequestV1,
} from "../src/bridge/protocol.js";
import { createPreparedOutboundBatch } from "../src/bridge/send-context.js";
import { FRAMES, REQUEST, SINK, TEXT_PART, makeRequest } from "./outbound-fixtures.js";

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
  it("fails closed when the production plugin starts without bridge configuration", () => {
    expect(() => outboundRuntimeModule.installProductionBridgeRuntimeFromEnvironment({}))
      .toThrowError(expect.objectContaining({ code: "BRIDGE_CONFIGURATION_INVALID" }));
  });

  it("accepts only a dedicated canonical public HTTPS customer AI base URL", () => {
    const validate = (outboundRuntimeModule as unknown as {
      validateCustomerAiBaseUrl(value: string): string;
    }).validateCustomerAiBaseUrl;

    expect(validate("https://customer-ai.example.com/v1"))
      .toBe("https://customer-ai.example.com/v1");
    for (const value of [
      "http://customer-ai.example.com/v1",
      "https://customer-ai.example.com/v1/",
      "https://customer-ai.example.com/v2",
      "https://customer-ai.example.com:8443/v1",
      "https://customer-ai.example.com/v1?fallback=1",
      "https://ai.chillhome.io.vn/v1",
      "https://api.9router.example/v1",
      "https://router9.example/v1",
      "https://localhost/v1",
      "https://localhost./v1",
      "https://customer-ai.internal/v1",
      "https://customer-ai.internal./v1",
      "https://ai.chillhome.io.vn./v1",
      "https://customer-ai.example.com./v1",
      "https://127.0.0.1/v1",
      "https://10.0.0.5/v1",
      "https://[::1]/v1",
    ]) {
      expect(() => validate(value), value).toThrowError(
        expect.objectContaining({ code: "AI_CONFIGURATION_INVALID" }),
      );
    }
  });

  it("fails production startup on a forbidden customer AI base URL before reading secrets", () => {
    const environment = {
      OPENCLAW_ZALO_BRIDGE_URL: "http://bridge.internal",
      OPENCLAW_ZALO_ORGANIZATION_ID: "organization-a",
      OPENCLAW_ZALO_ACCOUNT_ID: "account-a",
      OPENCLAW_ZALO_CELL_ID: "cell-a",
      OPENCLAW_ZALO_SESSION_GENERATION: "7",
      OPENCLAW_ZALO_FENCING_TOKEN: "9",
      OPENCLAW_ZALO_CONTROL_VERSION: "3",
      OPENCLAW_ZALO_TAKEOVER_VERSION: "2",
      OPENCLAW_ZALO_GATEWAY_DEVICE_ID: "bridge-device-a",
      OPENCLAW_ZALO_BRIDGE_SECRET_FILE: "/run/secrets/openclaw_zalo_bridge_hmac",
      OPENCLAW_ZALO_CUSTOMER_AI_API_KEY: "test-only-placeholder",
      OPENCLAW_ZALO_CUSTOMER_AI_MODEL: "customer-drafting-model",
    } as const;

    for (const baseUrl of [
      "https://ai.chillhome.io.vn/v1",
      "https://api.9router.example/v1",
      "https://169.254.169.254/v1",
      "https://[fe80::1]/v1",
      "https://localhost/v1",
      "https://customer-ai.internal./v1",
      "https://customer-ai.example.com/v1?fallback=1",
    ]) {
      expect(
        () => outboundRuntimeModule.installProductionBridgeRuntimeFromEnvironment({
          ...environment,
          OPENCLAW_ZALO_CUSTOMER_AI_BASE_URL: baseUrl,
        }),
        baseUrl,
      ).toThrowError(expect.objectContaining({ code: "AI_CONFIGURATION_INVALID" }));
    }
  });

  it("binds private RPC access to the authenticated nested gateway device principal", async () => {
    const factory = (outboundRuntimeModule as unknown as {
      createProductionBridgeRuntime(options: unknown): Parameters<typeof createPrivateOutboundRpc>[0] & {
        assertClient(client: unknown): Promise<void>;
      };
    }).createProductionBridgeRuntime;
    const runtime = factory({
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
      bridgeSecret: Buffer.alloc(32, 0x30),
      gatewayDeviceId: "bridge-device-a",
      now: () => Date.parse("2026-07-29T10:00:00.000Z"),
      nonce: () => "unused-nonce",
      fetch: async () => {
        throw new Error("must not call bridge while checking the gateway principal");
      },
      loadProviderSender: async () => {
        throw new Error("must not load provider while checking the gateway principal");
      },
    });
    const trustedClient = Object.freeze({
      isDeviceTokenAuth: true,
      connect: Object.freeze({
        client: Object.freeze({ id: "gateway-client", mode: "backend" }),
        device: Object.freeze({ id: "bridge-device-a" }),
      }),
    });

    await expect(runtime.assertClient(trustedClient)).resolves.toBeUndefined();
    await expect(runtime.assertClient({ id: "bridge-device-a" }))
      .rejects.toMatchObject({ code: "PRIVATE_BRIDGE_CLIENT_DENIED" });
    for (const denied of [
      { connect: trustedClient.connect },
      { isDeviceTokenAuth: true },
      { ...trustedClient, isDeviceTokenAuth: false },
      { ...trustedClient, connect: { ...trustedClient.connect, device: {} } },
      { ...trustedClient, connect: { ...trustedClient.connect, device: { id: "other-device" } } },
      { ...trustedClient, connect: { ...trustedClient.connect, client: { mode: "backend" } } },
      { ...trustedClient, connect: { ...trustedClient.connect, client: { id: "gateway-client" } } },
      { ...trustedClient, connect: { ...trustedClient.connect, client: { id: "cli", mode: "backend" } } },
      { ...trustedClient, connect: { ...trustedClient.connect, client: { id: "gateway-client", mode: "cli" } } },
    ]) {
      await expect(runtime.assertClient(denied)).rejects.toMatchObject({
        code: "PRIVATE_BRIDGE_CLIENT_DENIED",
      });
    }
  });

  it("materializes media with startup transport binding before authorizing refreshed live versions", async () => {
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
    ], {
      fencingToken: 10,
      controlVersion: 4,
      takeoverVersion: 3,
    });
    const mediaPart = mediaRequest.payload.parts[0];
    if (!mediaPart || mediaPart.kind !== "MEDIA") throw new Error("missing media fixture");
    const events: string[] = [];
    const binding: BridgeRuntimeBindingV1 = Object.freeze({
      organizationId: "organization-a",
      accountId: "account-a",
      cellId: "cell-a",
      sessionGeneration: 7,
      fencingToken: 9,
      controlVersion: 3,
      takeoverVersion: 2,
    });
    const bridgeSecret = Buffer.alloc(32, 0x31);
    const bridgeNow = Date.parse("2026-07-29T10:00:00.000Z");
    const factory = (outboundRuntimeModule as unknown as {
      createProductionBridgeRuntime?: (options: unknown) => ReturnType<typeof createPrivateOutboundRpc> extends never
        ? never
        : Parameters<typeof createPrivateOutboundRpc>[0] & { assertClient(client: unknown): Promise<void> };
    }).createProductionBridgeRuntime;
    expect(typeof factory).toBe("function");
    const runtime = factory!({
      binding,
      bridgeBaseUrl: "http://bridge.internal",
      bridgeSecret,
      gatewayDeviceId: "bridge-client-a",
      now: () => bridgeNow,
      nonce: (() => {
        let value = 0;
        return () => `transport-nonce-${value += 1}`;
      })(),
      fetch: async (_url: string, init: RequestInit) => {
        const envelope = JSON.parse(String(init.body)) as SignedBridgeRequestV1;
        expect(envelope.binding).toEqual(binding);
        events.push(envelope.operation);
        const signed = (body: unknown) => createSignedBridgeResponse({
          operation: envelope.operation,
          requestNonce: envelope.nonce,
          binding,
          body,
          secret: bridgeSecret,
          now: bridgeNow,
          ttlMs: 1_000,
        });
        if (envelope.operation === "media.materialize") {
          return new Response(JSON.stringify(signed({
            version: 1,
            objectKey: mediaPart.objectKey,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            mime: "image/png",
            bytes: bytes.length,
            contentBase64: bytes.toString("base64"),
          })), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (envelope.operation === "outbox.authorize-send") {
          expect(envelope.body).toEqual(mediaRequest.authorization);
          return new Response(JSON.stringify(signed({ version: 1, status: "AUTHORIZED" })), {
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

  it("rejects an unsigned authorization response before provider I/O", async () => {
    const textRequest = makeRequest([TEXT_PART]);
    const send = vi.fn(async (call: ReturnType<typeof prepareRequest>["calls"][number]) => {
      assertAuthorizedProviderCall(call);
      assertAuthorizedProviderIo(call.sink);
      return { providerMessageId: "must-not-send" };
    });
    const runtime = outboundRuntimeModule.createProductionBridgeRuntime({
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
      bridgeSecret: Buffer.alloc(32, 0x34),
      gatewayDeviceId: "bridge-client-a",
      now: () => Date.parse("2026-07-29T10:00:00.000Z"),
      nonce: () => "authorization-nonce-a",
      fetch: async () => new Response(JSON.stringify({ version: 1, status: "AUTHORIZED" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      loadProviderSender: async () => ({
        prepareSession: async () => Object.freeze({ ready: true }),
        send,
      }),
    });

    await expect(createPrivateOutboundRpc(runtime).invoke("zalouser.bridge.send", textRequest))
      .rejects.toMatchObject({ code: "BRIDGE_RESPONSE_AUTHENTICATION_FAILED" });
    expect(send).not.toHaveBeenCalled();
  });

  it("aborts and cancels an authorization response stream at the byte cap", async () => {
    let requestSignal: AbortSignal | null = null;
    let streamCancelled = false;
    const send = vi.fn(async () => ({ providerMessageId: "must-not-send" }));
    const runtime = outboundRuntimeModule.createProductionBridgeRuntime({
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
      bridgeSecret: Buffer.alloc(32, 0x37),
      gatewayDeviceId: "bridge-client-a",
      now: () => Date.parse("2026-07-29T10:00:00.000Z"),
      nonce: () => "authorization-overflow-nonce-a",
      fetch: async (_url: string, init: RequestInit) => {
        requestSignal = init.signal ?? null;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(64 * 1024 + 1));
          },
          cancel() {
            streamCancelled = true;
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
      loadProviderSender: async () => ({
        prepareSession: async () => Object.freeze({ ready: true }),
        send,
      }),
    });

    await expect(createPrivateOutboundRpc(runtime).invoke(
      "zalouser.bridge.send",
      makeRequest([TEXT_PART]),
    )).rejects.toMatchObject({ code: "AUTHORIZATION_ERROR" });
    const observedSignal = requestSignal as AbortSignal | null;
    expect(observedSignal).not.toBeNull();
    expect((observedSignal as AbortSignal).aborted).toBe(true);
    expect(streamCancelled).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects invalid UTF-8 authorization bytes before provider I/O", async () => {
    const send = vi.fn(async () => ({ providerMessageId: "must-not-send" }));
    const runtime = outboundRuntimeModule.createProductionBridgeRuntime({
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
      bridgeSecret: Buffer.alloc(32, 0x38),
      gatewayDeviceId: "bridge-client-a",
      now: () => Date.parse("2026-07-29T10:00:00.000Z"),
      nonce: () => "authorization-utf8-nonce-a",
      fetch: async () => new Response(new Uint8Array([0xc3, 0x28]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      loadProviderSender: async () => ({
        prepareSession: async () => Object.freeze({ ready: true }),
        send,
      }),
    });

    await expect(createPrivateOutboundRpc(runtime).invoke(
      "zalouser.bridge.send",
      makeRequest([TEXT_PART]),
    )).rejects.toMatchObject({
      code: "AUTHORIZATION_ERROR",
      message: "bridge response is not valid UTF-8",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    [500, "application/json"],
    [200, "text/plain"],
  ] as const)("aborts and cancels an unusable HTTP %s %s response", async (status, contentType) => {
    let requestSignal: AbortSignal | null = null;
    let cancellations = 0;
    const runtime = outboundRuntimeModule.createProductionControlRuntime({
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
      bridgeSecret: Buffer.alloc(32, 0x39),
      now: () => Date.parse("2026-07-29T10:00:00.000Z"),
      nonce: () => "control-unusable-response-nonce-a",
      fetch: async (_url: string, init: RequestInit) => {
        requestSignal = init.signal ?? null;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([0x7b]));
          },
          cancel() {
            cancellations += 1;
          },
        }), { status, headers: { "content-type": contentType } });
      },
    });

    await expect(runtime.authorize({ version: 1, kind: "typing", sink: SINK }))
      .rejects.toMatchObject({ code: "CONTROL_AUTHORIZATION_FAILED" });
    const observedSignal = requestSignal as AbortSignal | null;
    expect(observedSignal).not.toBeNull();
    expect((observedSignal as AbortSignal).aborted).toBe(true);
    expect(cancellations).toBe(1);
  });

  it("does not let a stalled stream cancellation defeat the authorization deadline", async () => {
    vi.useFakeTimers();
    let resolvePull!: () => void;
    let resolveCancel!: () => void;
    const pullGate = new Promise<void>((resolve) => {
      resolvePull = resolve;
    });
    const cancelGate = new Promise<void>((resolve) => {
      resolveCancel = resolve;
    });
    const runtime = outboundRuntimeModule.createProductionControlRuntime({
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
      bridgeSecret: Buffer.alloc(32, 0x3a),
      now: () => Date.parse("2026-07-29T10:00:00.000Z"),
      nonce: () => "control-stalled-cancel-nonce-a",
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        pull: () => pullGate,
        cancel: () => cancelGate,
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    let outcome: "pending" | "resolved" | "rejected" = "pending";
    const settled = runtime.authorize({ version: 1, kind: "typing", sink: SINK }).then(
      () => {
        outcome = "resolved";
        return { status: "resolved" as const, error: undefined };
      },
      (error: unknown) => {
        outcome = "rejected";
        return { status: "rejected" as const, error };
      },
    );
    try {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_001);
      await Promise.resolve();

      expect(outcome).toBe("rejected");
      await expect(settled).resolves.toMatchObject({
        status: "rejected",
        error: { code: "CONTROL_AUTHORIZATION_TIMEOUT" },
      });
    } finally {
      resolvePull();
      resolveCancel();
      await settled;
      vi.useRealTimers();
    }
  });

  it("aborts the in-flight authorization fetch when its deadline expires", async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | null = null;
      let markFetchStarted: (() => void) | undefined;
      const fetchStarted = new Promise<void>((resolve) => {
        markFetchStarted = resolve;
      });
      const send = vi.fn(async () => ({ providerMessageId: "must-not-send" }));
      const textRequest = makeRequest([TEXT_PART]);
      const runtime = outboundRuntimeModule.createProductionBridgeRuntime({
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
        bridgeSecret: Buffer.alloc(32, 0x35),
        gatewayDeviceId: "bridge-client-a",
        now: () => Date.parse("2026-07-29T10:00:00.000Z"),
        nonce: () => "authorization-timeout-nonce-a",
        fetch: async (_url, init) => {
          requestSignal = init.signal ?? null;
          markFetchStarted?.();
          return await new Promise<Response>((_resolve, reject) => {
            requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
          });
        },
        loadProviderSender: async () => ({
          prepareSession: async () => Object.freeze({ ready: true }),
          send,
        }),
      });
      const invocation = createPrivateOutboundRpc(runtime).invoke("zalouser.bridge.send", textRequest);
      const rejected = expect(invocation).rejects.toMatchObject({
        code: "OUTBOX_AUTHORIZE_SEND_TIMEOUT",
      });

      await fetchStarted;
      await vi.advanceTimersByTimeAsync(2_001);

      await rejected;
      const observedSignal = requestSignal as AbortSignal | null;
      expect(observedSignal).not.toBeNull();
      expect((observedSignal as AbortSignal).aborted).toBe(true);
      expect(send).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes every abort listener after a successful bridge response", async () => {
    const binding: BridgeRuntimeBindingV1 = Object.freeze({
      organizationId: "organization-a",
      accountId: "account-a",
      cellId: "cell-a",
      sessionGeneration: 7,
      fencingToken: 9,
      controlVersion: 3,
      takeoverVersion: 2,
    });
    const bridgeSecret = Buffer.alloc(32, 0x36);
    const bridgeNow = Date.parse("2026-07-29T10:00:00.000Z");
    type AbortListener = Parameters<AbortSignal["addEventListener"]>[1];
    const added: AbortListener[] = [];
    const removed: AbortListener[] = [];
    const originalAdd = AbortSignal.prototype.addEventListener;
    const originalRemove = AbortSignal.prototype.removeEventListener;
    const addSpy = vi.spyOn(AbortSignal.prototype, "addEventListener").mockImplementation(function (
      this: AbortSignal,
      ...args: Parameters<AbortSignal["addEventListener"]>
    ) {
      const [type, listener] = args;
      if (type === "abort") added.push(listener);
      return Reflect.apply(originalAdd, this, args) as void;
    });
    const removeSpy = vi.spyOn(AbortSignal.prototype, "removeEventListener").mockImplementation(function (
      this: AbortSignal,
      ...args: Parameters<AbortSignal["removeEventListener"]>
    ) {
      const [type, listener] = args;
      if (type === "abort") removed.push(listener);
      return Reflect.apply(originalRemove, this, args) as void;
    });
    try {
      const runtime = outboundRuntimeModule.createProductionBridgeRuntime({
        binding,
        bridgeBaseUrl: "http://bridge.internal",
        bridgeSecret,
        gatewayDeviceId: "bridge-client-a",
        now: () => bridgeNow,
        nonce: () => "authorization-listener-nonce-a",
        fetch: async (_url, init) => {
          const envelope = JSON.parse(String(init.body)) as SignedBridgeRequestV1;
          return new Response(JSON.stringify(createSignedBridgeResponse({
            operation: envelope.operation,
            requestNonce: envelope.nonce,
            binding,
            body: { version: 1, status: "AUTHORIZED" },
            secret: bridgeSecret,
            now: bridgeNow,
            ttlMs: 1_000,
          })), { status: 200, headers: { "content-type": "application/json" } });
        },
        loadProviderSender: async () => ({
          prepareSession: async () => Object.freeze({ ready: true }),
          send: async (call) => {
            assertAuthorizedProviderCall(call);
            assertAuthorizedProviderIo(call.sink);
            return { providerMessageId: "provider-a" };
          },
        }),
      });

      await expect(createPrivateOutboundRpc(runtime).invoke(
        "zalouser.bridge.send",
        makeRequest([TEXT_PART]),
      )).resolves.toMatchObject({ status: "SENT" });
    } finally {
      addSpy.mockRestore();
      removeSpy.mockRestore();
    }

    expect(added.length).toBeGreaterThan(0);
    expect(removed).toHaveLength(added.length);
    for (const listener of added) expect(removed).toContain(listener);
  });

  it("propagates a production authorization expiry before provider I/O", async () => {
    const binding: BridgeRuntimeBindingV1 = Object.freeze({
      organizationId: "organization-a",
      accountId: "account-a",
      cellId: "cell-a",
      sessionGeneration: 7,
      fencingToken: 9,
      controlVersion: 3,
      takeoverVersion: 2,
    });
    const bridgeSecret = Buffer.alloc(32, 0x46);
    const request = makeRequest([TEXT_PART]);
    const requestNow = Date.parse("2026-07-29T10:00:00.000Z");
    const responseNow = Date.parse("2026-07-29T10:00:14.000Z");
    const expiresAt = Date.parse(request.authorization.authorizationMarker.expiresAt);
    const times = [requestNow, responseNow, expiresAt];
    const providerIo: string[] = [];
    const runtime = outboundRuntimeModule.createProductionBridgeRuntime({
      binding,
      bridgeBaseUrl: "http://bridge.internal",
      bridgeSecret,
      gatewayDeviceId: "gateway-a",
      now: () => times.shift() ?? expiresAt,
      nonce: () => "authorization-expiry-nonce-a",
      fetch: async (_url, init) => {
        const envelope = JSON.parse(String(init.body)) as SignedBridgeRequestV1;
        return new Response(JSON.stringify(createSignedBridgeResponse({
          operation: envelope.operation,
          requestNonce: envelope.nonce,
          binding,
          body: { version: 1, status: "AUTHORIZED" },
          secret: bridgeSecret,
          now: responseNow,
          ttlMs: 1_000,
        })), { status: 200, headers: { "content-type": "application/json" } });
      },
      loadProviderSender: async () => ({
        prepareSession: async () => Object.freeze({ ready: true }),
        send: async (call: ReturnType<typeof prepareRequest>["calls"][number]) => {
          assertAuthorizedProviderCall(call);
          assertAuthorizedProviderIo(call.sink);
          providerIo.push("send");
          return { providerMessageId: "must-not-send" };
        },
      }),
    });
    const uninstall = installPrivateOutboundRuntime(runtime);
    runtimeCleanups.push(uninstall);
    let handler: ((request: unknown) => Promise<void>) | undefined;
    registerPrivateOutboundRpc({
      registerGatewayMethod(_method, registeredHandler) {
        handler = registeredHandler;
      },
    });
    let response: unknown;

    await handler?.({
      client: {
        isDeviceTokenAuth: true,
        connect: {
          client: { id: "gateway-client", mode: "backend" },
          device: { id: "gateway-a" },
        },
      },
      params: request,
      respond(ok: boolean, payload: unknown, error: unknown) {
        response = { ok, payload, error };
      },
    });

    expect(response).toEqual({
      ok: false,
      payload: undefined,
      error: {
        code: "AUTHORIZATION_EXPIRED",
        message: "authorization expired before provider handoff",
        authorizedHandoffRecorded: false,
      },
    });
    expect(providerIo).toEqual([]);
  });

  it("accepts refreshed fencing/control/takeover versions only after signed Bridge authorization", async () => {
    const factory = (outboundRuntimeModule as unknown as {
      createProductionBridgeRuntime(options: unknown): Parameters<typeof createPrivateOutboundRpc>[0];
    }).createProductionBridgeRuntime;
    const binding: BridgeRuntimeBindingV1 = Object.freeze({
      organizationId: "organization-a",
      accountId: "account-a",
      cellId: "cell-a",
      sessionGeneration: 7,
      fencingToken: 9,
      controlVersion: 3,
      takeoverVersion: 2,
    });
    const request = makeRequest([TEXT_PART], {
      fencingToken: 10,
      controlVersion: 4,
      takeoverVersion: 3,
    });
    const bridgeSecret = Buffer.alloc(32, 0x33);
    const bridgeNow = Date.parse("2026-07-29T10:00:00.000Z");
    const authorizationBodies: unknown[] = [];
    const providerIo: string[] = [];
    const runtime = factory({
      binding,
      bridgeBaseUrl: "http://bridge.internal",
      bridgeSecret,
      gatewayDeviceId: "bridge-client-a",
      now: () => bridgeNow,
      nonce: () => "live-binding-refresh-nonce-a",
      fetch: async (_url: string, init: RequestInit) => {
        const envelope = JSON.parse(String(init.body)) as SignedBridgeRequestV1;
        expect(envelope.binding).toEqual(binding);
        expect(envelope.operation).toBe("outbox.authorize-send");
        authorizationBodies.push(envelope.body);
        return new Response(JSON.stringify(createSignedBridgeResponse({
          operation: envelope.operation,
          requestNonce: envelope.nonce,
          binding,
          body: { version: 1, status: "AUTHORIZED" },
          secret: bridgeSecret,
          now: bridgeNow,
          ttlMs: 1_000,
        })), { status: 200, headers: { "content-type": "application/json" } });
      },
      loadProviderSender: async () => ({
        prepareSession: async () => Object.freeze({ ready: true }),
        send: async (call: ReturnType<typeof prepareRequest>["calls"][number]) => {
          assertAuthorizedProviderCall(call);
          assertAuthorizedProviderIo(call.sink);
          providerIo.push("send");
          return { providerMessageId: "provider-live-binding-a" };
        },
      }),
    });

    await expect(createPrivateOutboundRpc(runtime).invoke("zalouser.bridge.send", request))
      .resolves.toMatchObject({
        status: "SENT",
        knownProviderMessageIds: ["provider-live-binding-a"],
      });
    expect(authorizationBodies).toEqual([request.authorization]);
    expect(providerIo).toEqual(["send"]);
  });

  it.each([
    ["organization", { organizationId: "organization-b" }],
    ["account", { accountId: "account-b" }],
    ["session generation", { sessionGeneration: 8 }],
  ] as const)("rejects an immutable %s mismatch before Bridge or provider preparation", async (_label, overrides) => {
    const fetchCalls: string[] = [];
    const providerLoads: string[] = [];
    const runtime = outboundRuntimeModule.createProductionBridgeRuntime({
      binding: {
        organizationId: "organization-a",
        accountId: "account-a",
        cellId: "cell-a",
        sessionGeneration: 7,
        fencingToken: 9,
        controlVersion: 3,
        takeoverVersion: 2,
        ...overrides,
      },
      bridgeBaseUrl: "http://bridge.internal",
      bridgeSecret: Buffer.alloc(32, 0x48),
      gatewayDeviceId: "bridge-client-a",
      now: () => Date.parse("2026-07-29T10:00:00.000Z"),
      nonce: () => "unused-identity-mismatch-nonce-a",
      fetch: async () => {
        fetchCalls.push("fetch");
        throw new Error("must not call Bridge");
      },
      loadProviderSender: async () => {
        providerLoads.push("load");
        throw new Error("must not load provider");
      },
    });

    await expect(createPrivateOutboundRpc(runtime).invoke("zalouser.bridge.send", REQUEST))
      .rejects.toMatchObject({ code: "BRIDGE_BINDING_MISMATCH" });
    expect(fetchCalls).toEqual([]);
    expect(providerLoads).toEqual([]);
  });

  it("does not transfer a signed authorization proof to a structurally equal request", async () => {
    const binding: BridgeRuntimeBindingV1 = Object.freeze({
      organizationId: "organization-a",
      accountId: "account-a",
      cellId: "cell-a",
      sessionGeneration: 7,
      fencingToken: 9,
      controlVersion: 3,
      takeoverVersion: 2,
    });
    const bridgeSecret = Buffer.alloc(32, 0x49);
    const bridgeNow = Date.parse("2026-07-29T10:00:00.000Z");
    const runtime = outboundRuntimeModule.createProductionBridgeRuntime({
      binding,
      bridgeBaseUrl: "http://bridge.internal",
      bridgeSecret,
      gatewayDeviceId: "bridge-client-a",
      now: () => bridgeNow,
      nonce: () => "authorization-proof-nonce-a",
      fetch: async (_url: string, init: RequestInit) => {
        const envelope = JSON.parse(String(init.body)) as SignedBridgeRequestV1;
        return new Response(JSON.stringify(createSignedBridgeResponse({
          operation: envelope.operation,
          requestNonce: envelope.nonce,
          binding,
          body: { version: 1, status: "AUTHORIZED" },
          secret: bridgeSecret,
          now: bridgeNow,
          ttlMs: 1_000,
        })), { status: 200, headers: { "content-type": "application/json" } });
      },
      loadProviderSender: async () => { throw new Error("must not load provider"); },
    });
    const authorized = makeRequest([TEXT_PART]);
    const equalClone = makeRequest([TEXT_PART]);

    await expect(runtime.authorize(authorized, prepareRequest(authorized))).resolves.toBeUndefined();
    expect(() => runtime.assertAuthorizationCurrent(authorized)).not.toThrow();
    expect(() => runtime.assertAuthorizationCurrent(equalClone)).toThrowError(
      expect.objectContaining({ code: "AUTHORIZATION_PROOF_MISSING" }),
    );
  });

  it("requires an internal authorization proof for the exact snapshotted request", () => {
    const request = makeRequest([TEXT_PART]);
    const runtime = outboundRuntimeModule.createProductionBridgeRuntime({
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
      bridgeSecret: Buffer.alloc(32, 0x47),
      gatewayDeviceId: "bridge-client-a",
      now: () => Date.parse("2026-07-29T10:00:00.000Z"),
      nonce: () => "unused-proof-nonce-a",
      fetch: async () => { throw new Error("must not call bridge"); },
      loadProviderSender: async () => { throw new Error("must not load provider"); },
    });

    expect(() => runtime.assertAuthorizationCurrent(request)).toThrowError(
      expect.objectContaining({ code: "AUTHORIZATION_PROOF_MISSING" }),
    );
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
      assertAuthorizationCurrent: () => undefined,
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
      assertAuthorizationCurrent: () => undefined,
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
