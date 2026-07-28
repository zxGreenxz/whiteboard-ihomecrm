import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertAuthorizedProviderCall,
  assertAuthorizedProviderIo,
  createPrivateOutboundRpc,
  installPrivateOutboundRuntime,
  registerPrivateOutboundRpc,
} from "../src/bridge/outbound-rpc.js";
import {
  createPreparedOutboundBatch,
  createSendContext,
  verifySendContext,
  type BusinessFrame,
  type ProviderSinkV1,
} from "../src/bridge/send-context.js";

const secret = Buffer.alloc(32, 0x42);
const MEDIA_SHA256 = "a".repeat(64);
const runtimeCleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of runtimeCleanups.splice(0).reverse()) cleanup();
});

const SINK: ProviderSinkV1 = Object.freeze({
  accountId: "account-a",
  accountProfile: "profile-a",
  conversationId: "thread-a",
  isGroup: true,
});

const FRAMES: readonly BusinessFrame[] = Object.freeze([
  Object.freeze({ kind: "text", text: "one" }),
  Object.freeze({
    kind: "media",
    url: "file:///prepared/image.png",
    caption: "media caption",
    byteLength: 1024,
    contentType: "image/png",
    name: "image.png",
    sha256: MEDIA_SHA256,
  }),
  Object.freeze({ kind: "link", url: "https://example.invalid/two", caption: "link caption" }),
  Object.freeze({
    kind: "reaction",
    msgId: "provider-message-1",
    cliMsgId: "provider-cli-1",
    emoji: "❤",
    remove: false,
  }),
]);

function context(frames: readonly BusinessFrame[] = FRAMES, sink: ProviderSinkV1 = SINK) {
  return createSendContext(
    {
      ...sink,
      expiresAt: 2_000,
      frames,
      issuedAt: 1_000,
      nonce: "nonce-a",
    },
    secret,
  );
}

describe("private outbound RPC exact choke point", () => {
  it("prepares and freezes the complete ordered batch before one authorization and provider I/O", async () => {
    const events: string[] = [];
    const prepared = createPreparedOutboundBatch(SINK, FRAMES);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.calls)).toBe(true);
    expect(prepared.calls.every((call) => Object.isFrozen(call) && Object.isFrozen(call.frame))).toBe(true);
    const rpc = createPrivateOutboundRpc({
      prepare: async (request) => {
        events.push("prepare");
        expect(Object.isFrozen(request)).toBe(true);
        expect(Object.isFrozen(request.frames)).toBe(true);
        return createPreparedOutboundBatch(request.sink, request.frames);
      },
      authorize: async (request, batch) => {
        events.push("authorize");
        verifySendContext(request.context, batch, { now: 1_500, secret });
      },
      sendPrepared: async (call) => {
        events.push(`wrapper:${call.frameIndex}`);
        assertAuthorizedProviderCall(call);
        events.push(`io-check:${call.frameIndex}`);
        assertAuthorizedProviderIo(call.sink);
        events.push(`provider:${call.frameIndex}`);
        return { providerMessageId: `provider-${call.frameIndex}` };
      },
    });

    await expect(rpc.invoke("zalouser.bridge.send", {
      context: context(),
      sink: SINK,
      frames: FRAMES,
    })).resolves.toEqual({
      receipts: FRAMES.map((_frame, index) => ({ providerMessageId: `provider-${index}` })),
      status: "SENT",
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
      "wrapper:2",
      "io-check:2",
      "provider:2",
      "wrapper:3",
      "io-check:3",
      "provider:3",
    ]);
  });

  it("uses immutable snapshots when the caller mutates request objects during authorization", async () => {
    const mutableSink = { ...SINK };
    const mutableFrames = FRAMES.map((frame) => ({ ...frame })) as BusinessFrame[];
    const originalContext = context(mutableFrames, mutableSink);
    const providerCalls: unknown[] = [];
    const rpc = createPrivateOutboundRpc({
      prepare: async (request) => createPreparedOutboundBatch(request.sink, request.frames),
      authorize: async (request, batch) => {
        verifySendContext(request.context, batch, { now: 1_500, secret });
        mutableSink.conversationId = "mutated-thread";
        (mutableFrames[0] as { text?: string }).text = "mutated-text";
      },
      sendPrepared: async (call) => {
        assertAuthorizedProviderCall(call);
        assertAuthorizedProviderIo(call.sink);
        providerCalls.push(call);
        return {};
      },
    });

    await rpc.invoke("zalouser.bridge.send", {
      context: originalContext,
      sink: mutableSink,
      frames: mutableFrames,
    });

    expect(providerCalls).toMatchObject([
      { sink: { conversationId: "thread-a" }, frame: { kind: "text", text: "one" } },
      { frame: { kind: "media", caption: "media caption" } },
      { frame: { kind: "link", caption: "link caption" } },
      { frame: { kind: "reaction", cliMsgId: "provider-cli-1", remove: false } },
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
      prepare: async (request) => createPreparedOutboundBatch(request.sink, request.frames),
      authorize: async () => undefined,
      sendPrepared: async (call) => {
        assertAuthorizedProviderCall(call);
        assertAuthorizedProviderIo(call.sink);
        return { providerMessageId: "provider-1" };
      },
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
      params: { context: context(), sink: SINK, frames: FRAMES },
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
      prepare: async (request: Parameters<typeof createPreparedOutboundBatch>[0] extends never
        ? never
        : { sink: ProviderSinkV1; frames: readonly BusinessFrame[] }) =>
        createPreparedOutboundBatch(request.sink, request.frames),
      authorize: async () => undefined,
      sendPrepared: async () => ({}),
    };
    const uninstall = installPrivateOutboundRuntime(runtime);
    runtimeCleanups.push(uninstall);
    expect(() => installPrivateOutboundRuntime(runtime)).toThrowError(
      expect.objectContaining({ code: "PRIVATE_OUTBOUND_RUNTIME_ALREADY_INSTALLED" }),
    );
    uninstall();
  });

  it("rejects generic methods before preparation or authorization", async () => {
    const prepare = vi.fn(async () => createPreparedOutboundBatch(SINK, FRAMES));
    const authorize = vi.fn(async () => undefined);
    const rpc = createPrivateOutboundRpc({ prepare, authorize, sendPrepared: async () => ({}) });

    await expect(rpc.invoke("send", { context: context(), sink: SINK, frames: FRAMES }))
      .rejects.toMatchObject({ code: "PRIVATE_RPC_REQUIRED" });
    expect(prepare).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });
});
