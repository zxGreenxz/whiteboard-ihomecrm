import { describe, expect, it } from "vitest";
import { createAuthorizeClient } from "../src/bridge/authorize-client.js";
import { createPrivateOutboundRpc } from "../src/bridge/outbound-rpc.js";
import { createSendContext, verifySendContext } from "../src/bridge/send-context.js";

const secret = Buffer.alloc(32, 0x24);
const frames = [{ kind: "text" as const, text: "hello" }];

function context() {
  return createSendContext(
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
}

describe("outbound fail-closed behavior", () => {
  it("emits zero business frames on authorization timeout or stale context", async () => {
    let sends = 0;
    const authorize = createAuthorizeClient({
      call: async () => await new Promise<void>(() => undefined),
      timeoutMs: 5,
    });
    const rpc = createPrivateOutboundRpc({
      authorize,
      sendFrame: async () => {
        sends += 1;
        return {};
      },
    });

    await expect(rpc.invoke("zalouser.bridge.send", { context: context(), frames })).rejects.toMatchObject({
      code: "AUTHORIZATION_TIMEOUT",
    });
    expect(() => verifySendContext(context(), frames, { now: 2_001, secret })).toThrowError(
      expect.objectContaining({ code: "STALE_SEND_CONTEXT" }),
    );
    expect(sends).toBe(0);
  });

  it("classifies possible provider handoff as UNKNOWN and never retries automatically", async () => {
    let sends = 0;
    const rpc = createPrivateOutboundRpc({
      authorize: async () => undefined,
      sendFrame: async () => {
        sends += 1;
        throw new Error("connection closed after write");
      },
    });

    await expect(
      rpc.invoke("zalouser.bridge.send", { context: context(), frames }),
    ).resolves.toMatchObject({ status: "UNKNOWN" });
    expect(sends).toBe(1);
  });
});
