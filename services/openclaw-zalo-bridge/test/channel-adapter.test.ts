import { describe, expect, it, vi } from "vitest";

import { createChannelAdapter } from "../src/adapters/channel-adapter.js";
import { createFakeCellTransport } from "../src/bin/fake-cell.js";
import { FakeZaloAdapter } from "../src/testing/fake-zalo-adapter.js";
import type {
  CanonicalSendPayloadV1,
  OutboxAuthorizeSendRequestV1,
} from "../src/runtime-api/schemas.js";

const payload = {
  version: 1,
  organizationId: "dddd0000-0000-4000-8000-000000000001",
  accountId: "dddd1000-0000-4000-8000-000000000001",
  target: { kind: "PEER", providerId: "peer-1" },
  channel: "zalouser",
  accountProfile: "primary",
  idempotencyKey: "manual:1",
  parts: [{ version: 1, partIndex: 0, kind: "TEXT", text: "hello" }],
  replyToProviderMessageId: null,
  policyVersionId: "dddd3000-0000-4000-8000-000000000001",
  automationVersionId: null,
  templateVersionId: null,
  frozenInputs: {
    campaignVersionId: null,
    scheduleVersion: null,
    subscriptionVersion: null,
    subscriptionId: null,
    occurrenceId: null,
    sourceTable: null,
    sourceId: null,
    sourceVersion: null,
    knowledgeVersionIds: [],
    sourceSnapshotHash: null,
    targetVersion: 1,
    targetDirectoryRefreshedAt: "2026-08-01T00:00:00.000Z",
    fieldMappingHash: null,
  },
} satisfies CanonicalSendPayloadV1;

const authorization = {
  version: 1,
  claimToken: "claim-token-1",
  authorizationMarker: {
    version: 1,
    outboxId: "dddd8000-0000-4000-8000-000000000001",
    claimGeneration: 3,
    payloadHash: "a".repeat(64),
    fencingToken: 7,
    sessionGeneration: 5,
    controlVersion: 2,
    takeoverVersion: 1,
    markerNonce: "dddd7000-0000-4000-8000-000000000001",
    expiresAt: "2026-08-01T00:00:15.000Z",
  },
} satisfies OutboxAuthorizeSendRequestV1;

describe("canonical bridge channel adapter", () => {
  it("uses only the private business RPC and allowlisted controls", async () => {
    const invoke = vi.fn(async (method: string) => ({ method }));
    const adapter = createChannelAdapter({ invoke });

    await adapter.sendBusiness(payload, authorization);
    await adapter.control("channels.status", {});

    expect(invoke.mock.calls.map(([method]) => method)).toEqual([
      "zalouser.bridge.send",
      "channels.status",
    ]);
    expect("send" in adapter).toBe(false);
    expect("emitProviderFrame" in adapter).toBe(false);
    await expect(adapter.control("send" as never, {})).rejects.toThrow(/forbidden/i);
  });

  it("keeps final authorization immediately before fake provider I/O", async () => {
    const order: string[] = [];
    const provider = new FakeZaloAdapter({
      qrPayload: "fake-qr",
      directory: [],
      inbound: [],
      sendOutcomes: ["SUCCESS"],
    });
    const originalSend = provider.emitFakeOutcome.bind(provider);
    provider.emitFakeOutcome = async (value) => {
      order.push("provider");
      return await originalSend(value);
    };
    const transport = createFakeCellTransport({
      provider,
      authorizeSend: async () => {
        order.push("authorize");
        return { authorized: true };
      },
    });
    const adapter = createChannelAdapter(transport);

    await expect(adapter.sendBusiness(payload, {
      ...authorization,
      authorizationMarker: {
        ...authorization.authorizationMarker,
        payloadHash: (await import("../src/adapters/zalouser-bridge-rpc-adapter.js"))
          .hashCanonicalSendPayload(payload),
      },
    })).resolves.toMatchObject({ status: "SENT", knownProviderMessageIds: ["fake-message-1"] });
    expect(order).toEqual(["authorize", "provider"]);
  });
});
