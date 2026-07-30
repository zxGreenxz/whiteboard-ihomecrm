import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyControlTraffic,
  createControlTrafficSender,
} from "../src/bridge/control-traffic.js";
import * as controlRuntimeModule from "../src/bridge/control-traffic.js";
import {
  createSignedBridgeResponse,
  type BridgeRuntimeBindingV1,
  type SignedBridgeRequestV1,
} from "../src/bridge/protocol.js";
import * as runtimeBootstrap from "../src/bridge/runtime-bootstrap.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const SINK = Object.freeze({
  accountProfile: "profile-a",
  conversationId: "thread-1",
  isGroup: true,
});

const MESSAGE = Object.freeze({
  at: 0,
  cliMsgId: "cli-1",
  cmd: 0,
  idTo: "thread-1",
  msgId: "provider-1",
  msgType: "webchat",
  st: 0,
  ts: "2026-07-27T00:00:00.000Z",
  uidFrom: "sender-1",
});

describe("closed control traffic schemas", () => {
  it("authorizes a separately authenticated control capability before provider I/O", async () => {
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
    const bridgeSecret = Buffer.alloc(32, 0x34);
    const bridgeNow = Date.parse("2026-07-29T10:00:00.000Z");
    const createRuntime = (runtimeBootstrap as unknown as {
      createProductionControlRuntime?: (options: unknown) => unknown;
    }).createProductionControlRuntime;
    const installRuntime = (controlRuntimeModule as unknown as {
      installControlRuntime?: (runtime: unknown) => () => void;
    }).installControlRuntime;
    const invoke = (controlRuntimeModule as unknown as {
      invokeAuthorizedControl?: (frame: unknown, provider: (frame: unknown) => Promise<void>) => Promise<void>;
    }).invokeAuthorizedControl;
    const assertIo = (controlRuntimeModule as unknown as {
      assertAuthorizedControlIo?: (frame: unknown) => void;
    }).assertAuthorizedControlIo;
    expect(typeof createRuntime).toBe("function");
    expect(typeof installRuntime).toBe("function");
    expect(typeof invoke).toBe("function");
    expect(typeof assertIo).toBe("function");
    const runtime = createRuntime!({
      binding,
      bridgeBaseUrl: "http://bridge.internal",
      bridgeSecret,
      now: () => bridgeNow,
      nonce: () => "control-transport-nonce",
      fetch: async (_url: string, init: RequestInit) => {
        const envelope = JSON.parse(String(init.body)) as SignedBridgeRequestV1;
        events.push(envelope.operation);
        expect(envelope.body).toEqual({ version: 1, kind: "typing", sink: SINK });
        const response = createSignedBridgeResponse({
          operation: envelope.operation,
          requestNonce: envelope.nonce,
          binding,
          body: { version: 1, status: "AUTHORIZED" },
          secret: bridgeSecret,
          now: bridgeNow,
          ttlMs: 1_000,
        });
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    cleanups.push(installRuntime!(runtime));
    const frame = classifyControlTraffic({ version: 1, kind: "typing", sink: SINK });

    await invoke!(frame, async (authorizedFrame) => {
      events.push("provider");
      assertIo!(authorizedFrame);
    });

    expect(events).toEqual(["control.authorize", "provider"]);
  });

  it.each([
    [{ version: 1, kind: "typing", sink: SINK }],
    [{ version: 1, kind: "seen", sink: SINK, message: MESSAGE }],
    [{ version: 1, kind: "delivery-receipt", sink: SINK, message: MESSAGE, isSeen: false }],
  ] as const)("projects and deeply freezes an exact control frame", (candidate) => {
    const frame = classifyControlTraffic(candidate);

    expect(frame).toEqual(candidate);
    expect(frame).not.toBe(candidate);
    expect(frame.sink).not.toBe(candidate.sink);
    expect(Object.isFrozen(frame)).toBe(true);
    expect(Object.isFrozen(frame.sink)).toBe(true);
    if ("message" in frame && "message" in candidate) {
      expect(frame.message).not.toBe(candidate.message);
      expect(Object.isFrozen(frame.message)).toBe(true);
    }
  });

  it.each([
    ["typing extra top-level", { version: 1, kind: "typing", sink: SINK, innocent: true }],
    ["typing message", { version: 1, kind: "typing", sink: SINK, message: MESSAGE }],
    ["seen isSeen", { version: 1, kind: "seen", sink: SINK, message: MESSAGE, isSeen: false }],
    ["delivery missing isSeen", { version: 1, kind: "delivery-receipt", sink: SINK, message: MESSAGE }],
    ["delivery wrong isSeen", {
      version: 1,
      kind: "delivery-receipt",
      sink: SINK,
      message: MESSAGE,
      isSeen: "false",
    }],
    ["unknown kind", { version: 1, kind: "reply", sink: SINK }],
    ["wrong version", { version: 2, kind: "typing", sink: SINK }],
    ["extra sink key", { version: 1, kind: "typing", sink: { ...SINK, accountId: "extra" } }],
    ["extra message key", {
      version: 1,
      kind: "seen",
      sink: SINK,
      message: { ...MESSAGE, text: "business content" },
    }],
    ["missing message field", {
      version: 1,
      kind: "seen",
      sink: SINK,
      message: { ...MESSAGE, cliMsgId: undefined },
    }],
    ["wrong message number", {
      version: 1,
      kind: "seen",
      sink: SINK,
      message: { ...MESSAGE, cmd: 0.5 },
    }],
  ] as const)("rejects %s", (_label, candidate) => {
    expect(() => classifyControlTraffic(candidate)).toThrowError(
      expect.objectContaining({ code: "INVALID_CONTROL_TRAFFIC" }),
    );
  });

  it.each([
    ["array", []],
    ["class", new (class ControlFrame { version = 1; kind = "typing"; sink = SINK; })()],
    ["polluted prototype", Object.assign(Object.create({ polluted: true }), {
      version: 1,
      kind: "typing",
      sink: SINK,
    })],
    ["accessor", Object.defineProperty({ version: 1, kind: "typing" }, "sink", {
      enumerable: true,
      get: () => SINK,
    })],
    ["non-enumerable", Object.defineProperty({ version: 1, kind: "typing", sink: SINK }, "hidden", {
      enumerable: false,
      value: true,
    })],
    ["symbol", Object.assign({ version: 1, kind: "typing", sink: SINK }, {
      [Symbol("hidden")]: true,
    })],
  ] as const)("rejects unsafe %s control records", (_label, candidate) => {
    expect(() => classifyControlTraffic(candidate)).toThrowError(
      expect.objectContaining({ code: "INVALID_CONTROL_TRAFFIC" }),
    );
  });

  it("sends only the fresh projected frame", async () => {
    const sent: unknown[] = [];
    const sender = createControlTrafficSender({
      sendControl: async (frame) => {
        sent.push(frame);
      },
    });
    const candidate = {
      version: 1,
      kind: "delivery-receipt",
      sink: { ...SINK },
      message: { ...MESSAGE },
      isSeen: true,
    } as const;
    const originalSink = candidate.sink;
    const originalMessage = candidate.message;

    await sender(candidate);

    expect(sent).toEqual([candidate]);
    expect((sent[0] as { sink: unknown }).sink).not.toBe(originalSink);
    expect((sent[0] as { message: unknown }).message).not.toBe(originalMessage);
  });

  it("rejects invalid candidates before invoking the sender", async () => {
    const sendControl = vi.fn(async () => undefined);
    const sender = createControlTrafficSender({ sendControl });

    await expect(sender({ version: 1, kind: "typing", sink: SINK, text: "business" }))
      .rejects.toMatchObject({ code: "INVALID_CONTROL_TRAFFIC" });
    expect(sendControl).not.toHaveBeenCalled();
  });
});
