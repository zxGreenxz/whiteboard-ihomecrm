import { describe, expect, it } from "vitest";
import {
  classifyControlTraffic,
  createControlTrafficSender,
} from "../src/bridge/control-traffic.js";

describe("control traffic classification", () => {
  it.each(["typing", "seen", "delivery-receipt"] as const)(
    "classifies %s without entering the business-send RPC",
    async (kind) => {
      const sent: unknown[] = [];
      const sender = createControlTrafficSender({
        sendControl: async (frame) => {
          sent.push(frame);
        },
      });
      const frame = { kind, providerMessageId: "provider-1", threadId: "thread-1" };

      expect(classifyControlTraffic(frame)).toEqual(frame);
      await sender(frame);
      expect(sent).toEqual([frame]);
    },
  );

  it("rejects business content and unknown control kinds", async () => {
    expect(() =>
      classifyControlTraffic({ kind: "typing", text: "business content", threadId: "thread-1" }),
    ).toThrowError(expect.objectContaining({ code: "CONTROL_TRAFFIC_HAS_BUSINESS_CONTENT" }));
    expect(() => classifyControlTraffic({ kind: "reply", threadId: "thread-1" })).toThrowError(
      expect.objectContaining({ code: "INVALID_CONTROL_TRAFFIC" }),
    );
  });
});
