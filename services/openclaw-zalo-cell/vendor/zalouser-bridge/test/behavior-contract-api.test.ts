import { beforeEach, describe, expect, it } from "vitest";
import {
  installBehaviorContractRuntimeV1,
  type BehaviorContractRuntimeV1Options,
} from "../src/bridge/behavior-contract.js";
import {
  assertAuthorizedProviderCall,
  assertAuthorizedProviderIo,
  registerPrivateOutboundRpc,
} from "../src/bridge/outbound-rpc.js";
import { makeRequest, TEXT_PART } from "./outbound-fixtures.js";

const installedProvider = { events: [] as string[] };

const providerRuntime = {
  prepareSession(profile: string) {
      installedProvider.events.push(`provider:prepare:${profile}`);
      return Object.freeze({ profile });
  },
  async send(call: Parameters<typeof assertAuthorizedProviderCall>[0]) {
      assertAuthorizedProviderCall(call);
      assertAuthorizedProviderIo(call.sink);
      installedProvider.events.push(`provider:send:${call.frame.kind}`);
      return { providerMessageId: "provider-a" };
  },
};

const binding = Object.freeze({
  organizationId: "organization-a",
  accountId: "account-a",
  cellId: "cell-a",
  sessionGeneration: 7,
  fencingToken: 9,
  controlVersion: 3,
  takeoverVersion: 2,
});

function options(events: string[]): BehaviorContractRuntimeV1Options {
  return {
    binding,
    bridgeBaseUrl: "http://bridge.internal",
    bridgeSecret: Buffer.alloc(32, 0x45),
    gatewayDeviceId: "gateway-a",
    now: () => Date.parse("2026-07-29T10:00:00.000Z"),
    nonce: (() => {
      let value = 0;
      return () => `behavior-${value += 1}`;
    })(),
    bridgeFetch: async (_url, init) => {
      const request = JSON.parse(String(init.body)) as { operation: string };
      events.push(`bridge:${request.operation}`);
      if (request.operation === "inbound.ready") {
        return new Response(JSON.stringify({ version: 1, status: "READY" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (request.operation === "inbound.commit") {
        return new Response(JSON.stringify({
          version: 1,
          status: "committed",
          durability: { journalMode: "WAL", synchronous: "FULL" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (request.operation === "outbox.authorize-send" || request.operation === "control.authorize") {
        return new Response(JSON.stringify({ version: 1, status: "AUTHORIZED" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected bridge operation ${request.operation}`);
    },
    providerRuntime,
  };
}

const inbound = Object.freeze({
  providerEventId: "event-a",
  providerMessageId: "message-a",
  eventKind: "MESSAGE" as const,
  providerConversationId: "conversation-a",
  providerSenderId: "sender-a",
  providerTarget: Object.freeze({ kind: "PEER" as const, providerId: "peer-a" }),
  providerEventType: "message",
  sourceTimestamp: "2026-07-29T10:00:00.000Z",
  callbackReceivedAt: "2026-07-29T10:00:00.001Z",
  rawEnvelope: Object.freeze({ id: "event-a" }),
  normalized: Object.freeze({ text: "probe", replyToProviderMessageId: null, media: Object.freeze([]) }),
});

describe("installed behavior contract", () => {
  beforeEach(() => {
    installedProvider.events = [];
  });

  it("uses the durable production inbound bridge before dispatch", async () => {
    const events: string[] = [];
    const installation = installBehaviorContractRuntimeV1(options(events));
    try {
      await installation.readyInbound("account-a");
      await installation.commitInboundAndDispatch("account-a", inbound, async () => {
        events.push("dispatch");
      });
      expect(events).toEqual([
        "bridge:inbound.ready",
        "bridge:inbound.commit",
        "dispatch",
      ]);
    } finally {
      installation.close();
    }
  });

  it("drives the registered private RPC through authorization and guarded provider I/O", async () => {
    const events: string[] = [];
    const installation = installBehaviorContractRuntimeV1(options(events));
    const registrations: Array<{ method: string; handler: (request: unknown) => Promise<void> }> = [];
    registerPrivateOutboundRpc({
      registerGatewayMethod(method, handler) {
        registrations.push({ method, handler });
      },
    }, "zalouser.bridge.send");
    expect(registrations.map(({ method }) => method)).toEqual(["zalouser.bridge.send"]);
    let response: unknown;
    try {
      await registrations[0]!.handler({
        client: {
          isDeviceTokenAuth: true,
          connect: {
            client: { id: "gateway-client", mode: "backend" },
            device: { id: "gateway-a" },
          },
        },
        params: makeRequest([TEXT_PART]),
        respond(ok: boolean, payload: unknown, error: unknown) {
          response = { ok, payload, error };
        },
      });
      expect(response).toEqual({
        ok: true,
        payload: {
          knownProviderMessageIds: ["provider-a"],
          possibleHandoffPrefixLength: 1,
          reasonCode: "ALL_PARTS_ACKNOWLEDGED",
          receipts: [{ providerMessageId: "provider-a" }],
          status: "SENT",
          totalPartCount: 1,
        },
        error: undefined,
      });
      expect(events).toEqual([
        "bridge:outbox.authorize-send",
      ]);
      expect(installedProvider.events).toEqual([
        "provider:prepare:profile-a",
        "provider:send:text",
      ]);
    } finally {
      installation.close();
    }
  });

  it("closes every installed runtime in reverse order and is idempotent", () => {
    const installation = installBehaviorContractRuntimeV1(options([]));
    installation.close();
    expect(() => installation.close()).not.toThrow();
    const secondInstallation = installBehaviorContractRuntimeV1(options([]));
    expect(() => secondInstallation.close()).not.toThrow();
  });
});
