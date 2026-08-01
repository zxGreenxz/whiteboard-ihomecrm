import { describe, expect, it, vi } from "vitest";

import {
  ALLOWED_CONTROL_RPCS,
  genericSend,
  hashCanonicalSendPayload,
  isAllowedControlRpc,
  materializeBatch,
  PRIVATE_SEND_RPC,
  validateControlTraffic,
  zalouserBridgeSend,
  type CanonicalSendPayloadV1,
} from "../src/adapters/zalouser-bridge-rpc-adapter.js";
import type { MarkerFields } from "../src/outbox/state-machine.js";

const NOW = 1_785_062_400_000;

function payload(overrides: Partial<CanonicalSendPayloadV1> = {}): CanonicalSendPayloadV1 {
  return {
    version: 1,
    organizationId: "dddd0000-0000-4000-8000-000000000001",
    accountId: "dddd1000-0000-4000-8000-000000000001",
    target: { kind: "PEER", providerId: "peer-stable-1" },
    channel: "zalouser",
    accountProfile: "primary",
    idempotencyKey: "idem-1",
    parts: [{ version: 1, partIndex: 0, kind: "TEXT", text: "xin chào" }],
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
    ...overrides,
  };
}

function marker(payloadSha256: string, overrides: Partial<MarkerFields> = {}): MarkerFields {
  return {
    version: 1,
    outboxId: "dddd8000-0000-4000-8000-000000000001",
    claimGeneration: 3,
    payloadHash: payloadSha256,
    fencingToken: 7,
    sessionGeneration: 5,
    controlVersion: 2,
    takeoverVersion: 1,
    markerNonce: "dddd7000-0000-4000-8000-000000000001",
    expiresAt: new Date(NOW + 10_000).toISOString(),
    ...overrides,
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  const emitProviderFrame = vi.fn((_part: unknown, index: number) =>
    Promise.resolve(`provider-message-${index}`)
  );
  const authorizeSend = vi.fn(() => Promise.resolve({ authorized: true }));
  return {
    authorizeSend,
    emitProviderFrame,
    nowEpochMs: () => NOW,
    leaseExpiresAtEpochMs: NOW + 30_000,
    currentFencingToken: 7,
    currentSessionGeneration: 5,
    currentControlVersion: 2,
    currentTakeoverVersion: 1,
    nonceAlreadyConsumed: false,
    ...overrides,
  } as Parameters<typeof zalouserBridgeSend>[2] & {
    authorizeSend: typeof authorizeSend;
    emitProviderFrame: typeof emitProviderFrame;
  };
}

describe("Private bridge RPC surface", () => {
  it("names exactly one private business-send RPC", () => {
    expect(PRIVATE_SEND_RPC).toBe("zalouser.bridge.send");
  });

  it("allows only the ordinary control RPCs", () => {
    expect([...ALLOWED_CONTROL_RPCS]).toEqual([
      "web.login.start",
      "web.login.wait",
      "channels.status",
      "channels.start",
      "channels.stop",
      "channels.logout",
      "agent",
    ]);
    expect(isAllowedControlRpc("agent")).toBe(true);
    expect(isAllowedControlRpc("send")).toBe(false);
    expect(isAllowedControlRpc("message.tool")).toBe(false);
  });

  it("always denies the stock generic send for business traffic", () => {
    const result = genericSend();
    expect(result.authorized).toBe(false);
    expect(result.denial).toBe("GENERIC_SEND_FORBIDDEN");
    expect(result.providerFramesEmitted).toBe(0);
  });

  it("keeps control traffic content-free and unable to mint authorization", () => {
    expect(validateControlTraffic("typing", {})).toEqual({ ok: true });
    expect(validateControlTraffic("seen", {})).toEqual({ ok: true });
    expect(validateControlTraffic("delivery-receipt", {})).toEqual({ ok: true });

    expect(validateControlTraffic("typing", { text: "hi" }).reason)
      .toBe("CONTROL_CARRIES_CONTENT");
    expect(validateControlTraffic("typing", { marker: {} }).reason)
      .toBe("CONTROL_CARRIES_CONTENT");
    expect(validateControlTraffic("pairing-notification", {}).reason)
      .toBe("CONTROL_KIND_FORBIDDEN");
  });
});

describe("Provider batch materialization", () => {
  it("accepts an ordered TEXT and MEDIA batch", () => {
    const result = materializeBatch(
      payload({
        parts: [
          { version: 1, partIndex: 0, kind: "TEXT", text: "a" },
          {
            version: 1,
            partIndex: 1,
            kind: "MEDIA",
            objectKey: "v1/org/o/account/a/conversation/c/message/m/media/x/original",
            sha256: "a".repeat(64),
            mime: "image/png",
            bytes: 10,
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.parts.map((part) => part.kind)).toEqual(["TEXT", "MEDIA"]);
  });

  it("rejects link and reaction bypass attempts before authorization", () => {
    for (const kind of ["LINK", "REACTION", "STICKER"]) {
      const result = materializeBatch(
        payload({ parts: [{ version: 1, partIndex: 0, kind: kind as never }] }),
      );
      expect(result.ok, kind).toBe(false);
      expect(result.denial, kind).toBe("UNSUPPORTED_PART_KIND");
    }
  });

  it("rejects an empty batch", () => {
    expect(materializeBatch(payload({ parts: [] })).denial).toBe("EMPTY_BATCH");
  });

  it("rejects unverified media bytes", () => {
    for (const mutation of [
      { sha256: "short" },
      { mime: "" },
      { bytes: 0 },
    ]) {
      const result = materializeBatch(
        payload({
          parts: [{
            version: 1,
            partIndex: 0,
            kind: "MEDIA",
            objectKey: "v1/org/o/account/a/conversation/c/message/m/media/x/original",
            sha256: "a".repeat(64),
            mime: "image/png",
            bytes: 10,
            ...mutation,
          }],
        }),
      );
      expect(result.denial).toBe("MEDIA_UNVERIFIED");
    }
  });
});

describe("Authorized single-call dispatch", () => {
  it("authorizes immediately before the first provider frame", async () => {
    const order: string[] = [];
    const send = payload();
    const hash = hashCanonicalSendPayload(send);
    const dependency = dependencies({
      authorizeSend: vi.fn(() => {
        order.push("authorize");
        return Promise.resolve({ authorized: true });
      }),
      emitProviderFrame: vi.fn((_part: unknown, index: number) => {
        order.push(`frame-${index}`);
        return Promise.resolve(`provider-message-${index}`);
      }),
    });

    const result = await zalouserBridgeSend(send, marker(hash), dependency);

    expect(result.outcome).toBe("SENT");
    expect(order).toEqual(["authorize", "frame-0"]);
    expect(result.providerMessageIds).toEqual(["provider-message-0"]);
  });

  it("fails closed when authorization expires after authorize returns but before the first frame", async () => {
    const send = payload();
    let now = NOW;
    const dependency = dependencies({
      nowEpochMs: () => now,
      authorizeSend: vi.fn(async () => {
        now = NOW + 10_000;
        return { authorized: true };
      }),
    });

    await expect(zalouserBridgeSend(
      send,
      marker(hashCanonicalSendPayload(send)),
      dependency,
    )).rejects.toMatchObject({
      code: "AUTHORIZATION_EXPIRED",
      authorizedHandoffRecorded: false,
    });
    expect(dependency.emitProviderFrame).not.toHaveBeenCalled();
  });

  it("returns every provider message id in order on full success", async () => {
    const send = payload({
      parts: [
        { version: 1, partIndex: 0, kind: "TEXT", text: "a" },
        { version: 1, partIndex: 1, kind: "TEXT", text: "b" },
        { version: 1, partIndex: 2, kind: "TEXT", text: "c" },
      ],
    });
    const result = await zalouserBridgeSend(
      send,
      marker(hashCanonicalSendPayload(send)),
      dependencies(),
    );

    expect(result.providerMessageIds).toEqual([
      "provider-message-0",
      "provider-message-1",
      "provider-message-2",
    ]);
  });

  it("emits zero provider frames when authorization is denied", async () => {
    const send = payload();
    const dependency = dependencies({
      authorizeSend: vi.fn(() => Promise.resolve({ authorized: false })),
    });

    const result = await zalouserBridgeSend(
      send,
      marker(hashCanonicalSendPayload(send)),
      dependency,
    );

    expect(result.authorized).toBe(false);
    expect(result.providerFramesEmitted).toBe(0);
    expect(dependency.emitProviderFrame).not.toHaveBeenCalled();
  });

  it("emits zero provider frames when the Edge call errors or times out", async () => {
    const send = payload();
    const dependency = dependencies({
      authorizeSend: vi.fn(() => Promise.reject(new Error("timeout"))),
    });

    const result = await zalouserBridgeSend(
      send,
      marker(hashCanonicalSendPayload(send)),
      dependency,
    );

    expect(result.providerFramesEmitted).toBe(0);
    expect(dependency.emitProviderFrame).not.toHaveBeenCalled();
  });

  it("emits zero provider frames for a stale, replayed, or mismatched marker", async () => {
    const send = payload();
    const hash = hashCanonicalSendPayload(send);

    for (const [label, dependency, markerOverride] of [
      ["stale fencing", dependencies({ currentFencingToken: 8 }), {}],
      ["replayed nonce", dependencies({ nonceAlreadyConsumed: true }), {}],
      ["expired", dependencies({ nowEpochMs: () => NOW + 20_000 }), {}],
    ] as const) {
      const result = await zalouserBridgeSend(
        send,
        marker(hash, markerOverride),
        dependency,
      );
      expect(result.authorized, label).toBe(false);
      expect(result.providerFramesEmitted, label).toBe(0);
      expect(dependency.authorizeSend, label).not.toHaveBeenCalled();
    }
  });

  it("detects a payload hash mismatch before authorization", async () => {
    const send = payload();
    const dependency = dependencies();
    const result = await zalouserBridgeSend(
      send,
      marker("b".repeat(64)),
      dependency,
    );

    expect(result.denial).toBe("PAYLOAD_HASH_MISMATCH");
    expect(dependency.authorizeSend).not.toHaveBeenCalled();
  });

  it("makes the whole outbox UNKNOWN when a later part fails after handoff", async () => {
    const send = payload({
      parts: [
        { version: 1, partIndex: 0, kind: "TEXT", text: "a" },
        { version: 1, partIndex: 1, kind: "TEXT", text: "b" },
      ],
    });
    const dependency = dependencies({
      emitProviderFrame: vi.fn((_part: unknown, index: number) => {
        if (index === 1) return Promise.reject(new Error("disconnect"));
        return Promise.resolve(`provider-message-${index}`);
      }),
    });

    const result = await zalouserBridgeSend(
      send,
      marker(hashCanonicalSendPayload(send)),
      dependency,
    );

    expect(result.outcome).toBe("UNKNOWN");
    expect(result.providerFramesEmitted).toBe(2);
    expect(result.providerMessageIds).toEqual(["provider-message-0"]);
  });

  it("produces a stable canonical payload hash", () => {
    const send = payload();
    expect(hashCanonicalSendPayload(send)).toBe(hashCanonicalSendPayload({ ...send }));
    expect(hashCanonicalSendPayload(send)).not.toBe(
      hashCanonicalSendPayload(payload({ idempotencyKey: "idem-2" })),
    );
  });

  it("uses the exact cross-runtime hash domain and excludes the outbox id", () => {
    const send = payload();
    expect(hashCanonicalSendPayload(send)).toBe(
      "6a6a42a66c7eee53bc53669a5b225ac4d615dc8543b6be7c2693de98abffb4e6",
    );
    expect("outboxId" in send).toBe(false);
  });

  it("rejects non-contiguous partIndex and text over 2,000 Unicode code points", () => {
    expect(materializeBatch(payload({
      parts: [{ version: 1, partIndex: 1, kind: "TEXT", text: "a" }],
    })).denial).toBe("PART_INDEX_INVALID");
    expect(materializeBatch(payload({
      parts: [{ version: 1, partIndex: 0, kind: "TEXT", text: "😀".repeat(2_001) }],
    })).denial).toBe("TEXT_TOO_LONG");
  });
});
