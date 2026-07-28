import { describe, expect, it } from "vitest";
import {
  commitInboundThroughBridge,
  createDurableInboundListener,
  installInboundBridgeCommitter,
} from "../src/bridge/inbound-listener.js";

describe("durable inbound bridge listener", () => {
  it("commits the complete envelope and media manifest before dispatch", async () => {
    const events: string[] = [];
    const committed: unknown[] = [];
    const listener = createDurableInboundListener({
      accountId: "account-a",
      commit: async (record) => {
        events.push("commit");
        committed.push(record);
        return { status: "committed" };
      },
      dispatch: async () => {
        events.push("dispatch");
      },
    });

    const result = await listener({
      content: { text: "hello" },
      media: [{ contentType: "image/jpeg", name: "a.jpg", size: 12, url: "https://media.invalid/a" }],
      occurredAt: "2026-07-27T00:00:00.000Z",
      providerMessageId: "provider-message-1",
      senderId: "sender-1",
      threadId: "thread-1",
    });

    expect(events).toEqual(["commit", "dispatch"]);
    expect(committed).toEqual([
      expect.objectContaining({
        accountId: "account-a",
        content: { text: "hello" },
        dedupeKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        media: [expect.objectContaining({ name: "a.jpg", size: 12 })],
        providerMessageId: "provider-message-1",
      }),
    ]);
    expect(result).toMatchObject({ status: "dispatched" });
  });

  it("deduplicates an identical provider message and fails closed on collision or commit failure", async () => {
    let dispatches = 0;
    const message = {
      content: { text: "hello" },
      occurredAt: "2026-07-27T00:00:00.000Z",
      providerMessageId: "provider-message-1",
      senderId: "sender-1",
      threadId: "thread-1",
    };
    const duplicate = createDurableInboundListener({
      accountId: "account-a",
      commit: async () => ({ status: "duplicate" }),
      dispatch: async () => {
        dispatches += 1;
      },
    });
    const collision = createDurableInboundListener({
      accountId: "account-a",
      commit: async () => ({ status: "collision" }),
      dispatch: async () => {
        dispatches += 1;
      },
    });
    const failed = createDurableInboundListener({
      accountId: "account-a",
      commit: async () => {
        throw new Error("wal unavailable");
      },
      dispatch: async () => {
        dispatches += 1;
      },
    });

    await expect(duplicate(message)).resolves.toMatchObject({ status: "duplicate" });
    await expect(collision(message)).rejects.toMatchObject({ code: "INBOUND_ID_COLLISION" });
    await expect(failed(message)).rejects.toThrow("wal unavailable");
    expect(dispatches).toBe(0);
  });

  it("fails closed unless the cell-local bridge committer is installed", async () => {
    const events: unknown[] = [];
    const uninstall = installInboundBridgeCommitter(async (request) => {
      events.push(request);
      return { status: "committed" };
    });

    await expect(
      commitInboundThroughBridge("account-a", { raw: "complete-provider-envelope" }),
    ).resolves.toMatchObject({ status: "committed" });
    expect(events).toEqual([
      { accountId: "account-a", envelope: { raw: "complete-provider-envelope" } },
    ]);
    uninstall();
    await expect(commitInboundThroughBridge("account-a", {})).rejects.toMatchObject({
      code: "INBOUND_BRIDGE_UNAVAILABLE",
    });
  });
});
