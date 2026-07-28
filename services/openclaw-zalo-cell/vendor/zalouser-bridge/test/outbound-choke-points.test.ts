import { describe, expect, it } from "vitest";
import {
  createPrivateOutboundRpc,
  installPrivateOutboundRuntime,
  registerPrivateOutboundRpc,
  requirePrivateRpcContext,
} from "../src/bridge/outbound-rpc.js";
import { createSendContext, verifySendContext } from "../src/bridge/send-context.js";

const secret = Buffer.alloc(32, 0x42);

describe("private outbound RPC choke point", () => {
  it("authorizes the exact ordered provider batch immediately before provider I/O", async () => {
    const events: string[] = [];
    const frames = [
      { kind: "text" as const, text: "one" },
      { kind: "link" as const, url: "https://example.invalid/two" },
    ];
    const context = createSendContext(
      {
        accountId: "account-a",
        conversationId: "thread-a",
        expiresAt: 2_000,
        frames,
        issuedAt: 1_000,
        nonce: "nonce-a",
      },
      secret,
    );
    const rpc = createPrivateOutboundRpc({
      authorize: async (candidate, candidateFrames) => {
        events.push("authorize");
        verifySendContext(candidate, candidateFrames, { now: 1_500, secret });
      },
      sendFrame: async (frame) => {
        events.push(`send:${frame.kind}`);
        return { providerMessageId: `provider-${frame.kind}` };
      },
    });

    await expect(
      rpc.invoke("zalouser.bridge.send", { context, frames }),
    ).resolves.toMatchObject({ status: "SENT" });
    expect(events).toEqual(["authorize", "send:text", "send:link"]);
  });

  it("rejects generic bypass methods and emits zero frames when authorization denies", async () => {
    let sends = 0;
    const frames = [{ kind: "text" as const, text: "blocked" }];
    const context = createSendContext(
      {
        accountId: "account-a",
        conversationId: "thread-a",
        expiresAt: 2_000,
        frames,
        issuedAt: 1_000,
        nonce: "nonce-a",
      },
      secret,
    );
    const rpc = createPrivateOutboundRpc({
      authorize: async () => {
        throw Object.assign(new Error("denied"), { code: "AUTHORIZATION_DENIED" });
      },
      sendFrame: async () => {
        sends += 1;
        return {};
      },
    });

    await expect(rpc.invoke("send", { context, frames })).rejects.toMatchObject({
      code: "PRIVATE_RPC_REQUIRED",
    });
    await expect(rpc.invoke("zalouser.bridge.send", { context, frames })).rejects.toMatchObject({
      code: "AUTHORIZATION_DENIED",
    });
    expect(sends).toBe(0);
  });

  it("registers only the private method and validates the dedicated bridge client", async () => {
    let registered: undefined | {
      handler: (request: unknown) => Promise<void>;
      method: string;
      options: { scope: string };
    };
    const frames = [{ kind: "text" as const, text: "one" }];
    const sendContext = createSendContext(
      {
        accountId: "account-a",
        conversationId: "thread-a",
        expiresAt: 2_000,
        frames,
        issuedAt: 1_000,
        nonce: "nonce-a",
      },
      secret,
    );
    const uninstall = installPrivateOutboundRuntime({
      assertClient: async (client) => {
        if ((client as { id?: string })?.id !== "bridge-a") throw new Error("wrong bridge client");
      },
      authorize: async () => undefined,
      sendFrame: async (frame) => {
        requirePrivateRpcContext(frame);
        return { providerMessageId: "provider-1" };
      },
    });
    registerPrivateOutboundRpc({
      registerGatewayMethod(method, handler, options) {
        registered = { method, handler, options };
      },
    });
    const responses: unknown[] = [];

    await registered?.handler({
      client: { id: "bridge-a" },
      params: { context: sendContext, frames },
      respond: (...args: unknown[]) => responses.push(args),
    });

    expect(registered).toMatchObject({
      method: "zalouser.bridge.send",
      options: { scope: "operator.write" },
    });
    expect(responses).toEqual([[true, expect.objectContaining({ status: "SENT" })]]);
    expect(() => requirePrivateRpcContext(frames[0])).toThrowError(
      expect.objectContaining({ code: "PRIVATE_RPC_REQUIRED" }),
    );
    uninstall();
  });
});
