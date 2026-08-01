import { describe, expect, it, vi } from "vitest";

import { hashCanonicalSendPayload } from "../src/adapters/zalouser-bridge-rpc-adapter.js";
import {
  deliveryEvidenceHash,
  preHandoffEvidenceHash,
  runOutboxBatch,
} from "../src/outbox/worker.js";
import type {
  CanonicalSendPayloadV1,
  OutboxClaim,
  OutboundAuthorizationMarker,
} from "../src/runtime-api/schemas.js";
import { canonicalJson } from "../src/spool/checksum.js";

const payload: CanonicalSendPayloadV1 = {
  version: 1,
  organizationId: "dddd0000-0000-4000-8000-000000000001",
  accountId: "dddd1000-0000-4000-8000-000000000001",
  target: { kind: "PEER", providerId: "peer-1" },
  channel: "zalouser",
  accountProfile: "primary",
  idempotencyKey: "manual:1",
  parts: [{ version: 1, partIndex: 0, kind: "TEXT", text: "Xin chào" }],
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
};
const payloadHash = hashCanonicalSendPayload(payload);
const claim: OutboxClaim = {
  version: 1,
  outboxId: "dddd8000-0000-4000-8000-000000000001",
  organizationId: payload.organizationId,
  accountId: payload.accountId,
  claimToken: "claim-token-1",
  claimGeneration: 3,
  fencingToken: 7,
  sessionGeneration: 5,
  controlVersion: 2,
  takeoverVersion: 1,
  leaseExpiresAt: "2026-08-01T00:00:30.000Z",
  payloadHash,
  payload,
};
const marker: OutboundAuthorizationMarker = {
  version: 1,
  outboxId: claim.outboxId,
  claimGeneration: claim.claimGeneration,
  payloadHash,
  fencingToken: claim.fencingToken,
  sessionGeneration: claim.sessionGeneration,
  controlVersion: claim.controlVersion,
  takeoverVersion: claim.takeoverVersion,
  markerNonce: "dddd7000-0000-4000-8000-000000000001",
  expiresAt: "2026-08-01T00:00:15.000Z",
};

function runtime(preflight: Record<string, unknown> = {
  version: 1,
  outboxId: claim.outboxId,
  decision: "ALLOWED",
  disposition: "HANDOFF_AUTHORIZED",
  transitionApplied: false,
  canonicalPayload: payload,
  authorizationMarker: marker,
  databaseTime: "2026-08-01T00:00:00.000Z",
  retryNotBefore: null,
}) {
  const calls: Array<{ path: string; body: unknown }> = [];
  return {
    calls,
    post: vi.fn(async (path: string, body: unknown) => {
      calls.push({ path, body });
      if (path === "/v1/outbox/claim") return { version: 1, items: [claim] };
      if (path === "/v1/outbox/preflight") return preflight;
      if (path === "/v1/outbox/requeue") {
        return { version: 1, outboxId: claim.outboxId, state: "QUEUED" };
      }
      if (path === "/v1/outbox/complete") {
        const completion = body as {
          outcome: string;
          deliveryEvidenceHash: string;
          deliveryEvidence: {
            knownProviderMessageIds: string[];
            possibleHandoffPrefixLength: number;
          };
        };
        return {
          version: 1,
          outboxId: claim.outboxId,
          state: completion.outcome,
          knownProviderMessageIds: completion.deliveryEvidence.knownProviderMessageIds,
          possibleHandoffPrefixLength: completion.deliveryEvidence.possibleHandoffPrefixLength,
          deliveryEvidenceHash: completion.deliveryEvidenceHash,
        };
      }
      throw new Error(`unexpected route ${path}`);
    }),
  };
}

describe("bounded outbox worker orchestration", () => {
  it.each([
    ["GLOBAL_STOP", "2026-08-01T00:05:00.000Z"],
    ["SUPPRESSED", "2026-08-01T01:00:00.000Z"],
    ["CONSENT_MISSING", "2026-08-01T02:00:00.000Z"],
    ["QUIET_HOURS", "2026-08-01T06:00:00.000Z"],
    ["RATE_LIMITED", "2026-08-01T00:01:00.000Z"],
  ])("consumes authoritative %s SAFE_RETRY without provider or follow-up RPC", async (
    decision,
    retryNotBefore,
  ) => {
    const api = runtime({
      version: 1,
      outboxId: claim.outboxId,
      decision,
      disposition: "SAFE_RETRY",
      transitionApplied: true,
      canonicalPayload: null,
      authorizationMarker: null,
      databaseTime: "2026-08-01T00:00:00.000Z",
      retryNotBefore,
    });
    const cellRpc = { invoke: vi.fn() };

    await expect(runOutboxBatch({
      runtime: api,
      cellRpc,
      claimToken: () => "claim-token-1",
      now: () => new Date("2026-08-01T00:00:01.000Z"),
      retryNotBefore: () => "2026-08-01T00:00:10.000Z",
      limit: 1,
    })).resolves.toEqual([{
      outboxId: claim.outboxId,
      outcome: "SAFE_RETRY",
      reasonCode: decision,
      retryNotBefore,
    }]);

    expect(cellRpc.invoke).not.toHaveBeenCalled();
    expect(api.calls.map((entry) => entry.path)).toEqual([
      "/v1/outbox/claim",
      "/v1/outbox/preflight",
    ]);
  });

  it("consumes an authoritative campaign cancellation as terminal no-send", async () => {
    const api = runtime({
      version: 1,
      outboxId: claim.outboxId,
      decision: "CAMPAIGN_CANCELLED",
      disposition: "TERMINAL_NO_SEND",
      transitionApplied: true,
      canonicalPayload: null,
      authorizationMarker: null,
      databaseTime: "2026-08-01T00:00:00.000Z",
      retryNotBefore: null,
    });
    const cellRpc = { invoke: vi.fn() };

    await expect(runOutboxBatch({
      runtime: api,
      cellRpc,
      claimToken: () => "claim-token-1",
      now: () => new Date("2026-08-01T00:00:01.000Z"),
      retryNotBefore: () => "2026-08-01T00:00:10.000Z",
      limit: 1,
    })).resolves.toEqual([{
      outboxId: claim.outboxId,
      outcome: "TERMINAL_NO_SEND",
      reasonCode: "CAMPAIGN_CANCELLED",
    }]);

    expect(cellRpc.invoke).not.toHaveBeenCalled();
    expect(api.calls.map((entry) => entry.path)).toEqual([
      "/v1/outbox/claim",
      "/v1/outbox/preflight",
    ]);
  });

  it("accepts SQL-refreshed marker versions as the final handoff authority", async () => {
    const refreshedMarker = {
      ...marker,
      controlVersion: marker.controlVersion + 1,
      takeoverVersion: marker.takeoverVersion + 1,
    };
    const api = runtime({
      version: 1,
      outboxId: claim.outboxId,
      decision: "ALLOWED",
      disposition: "HANDOFF_AUTHORIZED",
      transitionApplied: false,
      canonicalPayload: payload,
      authorizationMarker: refreshedMarker,
      databaseTime: "2026-08-01T00:00:00.000Z",
      retryNotBefore: null,
    });
    const cellRpc = {
      invoke: vi.fn(async () => ({
        status: "SENT" as const,
        reasonCode: "ALL_PARTS_ACKNOWLEDGED" as const,
        totalPartCount: 1,
        possibleHandoffPrefixLength: 1,
        knownProviderMessageIds: ["provider-1"],
      })),
    };

    await expect(runOutboxBatch({
      runtime: api,
      cellRpc,
      claimToken: () => "claim-token-1",
      now: () => new Date("2026-08-01T00:00:01.000Z"),
      retryNotBefore: () => "2026-08-01T00:00:10.000Z",
      limit: 1,
    })).resolves.toEqual([{ outboxId: claim.outboxId, outcome: "SENT" }]);
    expect(cellRpc.invoke).toHaveBeenCalledWith("zalouser.bridge.send", expect.objectContaining({
      authorization: expect.objectContaining({ authorizationMarker: refreshedMarker }),
    }));
  });

  it("claims, preflights, invokes exactly one private RPC, then submits exact SENT evidence", async () => {
    const api = runtime();
    const cellRpc = {
      invoke: vi.fn(async () => ({
        status: "SENT" as const,
        reasonCode: "ALL_PARTS_ACKNOWLEDGED" as const,
        totalPartCount: 1,
        possibleHandoffPrefixLength: 1,
        knownProviderMessageIds: ["provider-1"],
        receipts: [{ providerMessageId: "provider-1" }],
      })),
    };

    const result = await runOutboxBatch({
      runtime: api,
      cellRpc,
      claimToken: () => "claim-token-1",
      now: () => new Date("2026-08-01T00:00:01.000Z"),
      retryNotBefore: () => "2026-08-01T00:00:10.000Z",
      limit: 1,
    });

    expect(result).toEqual([{ outboxId: claim.outboxId, outcome: "SENT" }]);
    expect(cellRpc.invoke).toHaveBeenCalledTimes(1);
    expect(cellRpc.invoke).toHaveBeenCalledWith("zalouser.bridge.send", {
      version: 1,
      payload,
      authorization: { version: 1, claimToken: claim.claimToken, authorizationMarker: marker },
    });
    expect(api.calls.map((entry) => entry.path)).toEqual([
      "/v1/outbox/claim",
      "/v1/outbox/preflight",
      "/v1/outbox/complete",
    ]);
    const completion = api.calls[2]!.body as Record<string, unknown>;
    expect(completion).toMatchObject({
      version: 1,
      outcome: "SENT",
      reasonCode: "ALL_PARTS_ACKNOWLEDGED",
      authorization: { version: 1, claimToken: claim.claimToken, authorizationMarker: marker },
      deliveryEvidence: {
        version: 1,
        evidenceKind: "OUTBOX_DELIVERY",
        outboxId: claim.outboxId,
        claimGeneration: claim.claimGeneration,
        payloadHash,
        authorizationMarker: marker,
        totalPartCount: 1,
        knownProviderMessageIds: ["provider-1"],
        possibleHandoffPrefixLength: 1,
        outcome: "SENT",
      },
    });
    expect(completion.deliveryEvidenceHash).toBe(
      deliveryEvidenceHash(completion.deliveryEvidence),
    );
    expect(Object.keys(completion).sort()).toEqual([
      "authorization",
      "deliveryEvidence",
      "deliveryEvidenceHash",
      "outcome",
      "reasonCode",
      "version",
    ]);
  });

  it("requeues only a proven pre-handoff failure with exact evidence", async () => {
    const api = runtime();
    const cellRpc = { invoke: vi.fn(async () => {
      throw Object.assign(new Error("adapter not ready"), {
        code: "ADAPTER_NOT_READY",
        authorizedHandoffRecorded: false,
      });
    }) };

    const result = await runOutboxBatch({
      runtime: api,
      cellRpc,
      claimToken: () => "claim-token-1",
      now: () => new Date("2026-08-01T00:00:01.000Z"),
      retryNotBefore: () => "2026-08-01T00:00:10.000Z",
      limit: 1,
    });

    expect(result[0]?.outcome).toBe("SAFE_RETRY");
    expect(cellRpc.invoke).toHaveBeenCalledTimes(1);
    const requeue = api.calls[2]!.body as Record<string, unknown>;
    expect(requeue).toMatchObject({
      version: 1,
      outcome: "SAFE_RETRY",
      reasonCode: "ADAPTER_NOT_READY",
      authorization: {
        version: 1,
        claimToken: claim.claimToken,
        authorizationMarker: marker,
      },
      preHandoffEvidence: {
        version: 1,
        evidenceKind: "OUTBOX_PRE_HANDOFF",
        outboxId: claim.outboxId,
        claimGeneration: claim.claimGeneration,
        payloadHash,
        authorizationMarker: marker,
        reasonCode: "ADAPTER_NOT_READY",
        authorizedHandoffRecorded: false,
      },
      retryNotBefore: "2026-08-01T00:00:10.000Z",
    });
    expect(requeue.preHandoffEvidenceHash).toBe(
      preHandoffEvidenceHash(requeue.preHandoffEvidence),
    );
    expect(Object.keys(requeue).sort()).toEqual([
      "authorization",
      "outcome",
      "preHandoffEvidence",
      "preHandoffEvidenceHash",
      "reasonCode",
      "retryNotBefore",
      "version",
    ]);
  });

  it("completes every possible post-handoff ambiguity as UNKNOWN and never requeues it", async () => {
    const api = runtime();
    const cellRpc = {
      invoke: vi.fn(async () => ({
        status: "UNKNOWN" as const,
        reasonCode: "PROVIDER_TIMEOUT_AFTER_POSSIBLE_HANDOFF" as const,
        totalPartCount: 1,
        possibleHandoffPrefixLength: 1,
        knownProviderMessageIds: [],
        receipts: [],
      })),
    };

    const result = await runOutboxBatch({
      runtime: api,
      cellRpc,
      claimToken: () => "claim-token-1",
      now: () => new Date("2026-08-01T00:00:01.000Z"),
      retryNotBefore: () => "2026-08-01T00:00:10.000Z",
      limit: 1,
    });

    expect(result[0]?.outcome).toBe("UNKNOWN");
    expect(api.calls.some((entry) => entry.path === "/v1/outbox/requeue")).toBe(false);
    expect(api.calls.at(-1)).toMatchObject({
      path: "/v1/outbox/complete",
      body: {
        outcome: "UNKNOWN",
        reasonCode: "PROVIDER_TIMEOUT_AFTER_POSSIBLE_HANDOFF",
        deliveryEvidence: { possibleHandoffPrefixLength: 1 },
      },
    });
  });

  it("fails closed without requeue when the private RPC error cannot prove pre-handoff", async () => {
    const api = runtime();
    const cellRpc = { invoke: vi.fn(async () => {
      throw Object.assign(new Error("socket closed"), { code: "SOCKET_CLOSED" });
    }) };

    const result = await runOutboxBatch({
      runtime: api,
      cellRpc,
      claimToken: () => "claim-token-1",
      now: () => new Date("2026-08-01T00:00:01.000Z"),
      retryNotBefore: () => "2026-08-01T00:00:10.000Z",
      limit: 1,
    });

    expect(result[0]?.outcome).toBe("UNKNOWN");
    expect(api.calls.some((entry) => entry.path === "/v1/outbox/requeue")).toBe(false);
  });

  it("replays the exact SENT completion after a committed response is lost", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    let committedCompletionBytes: string | null = null;
    let completeAttempts = 0;
    const api = {
      post: vi.fn(async (path: string, body: unknown) => {
        calls.push({ path, body });
        if (path === "/v1/outbox/claim") return { version: 1, items: [claim] };
        if (path === "/v1/outbox/preflight") {
          return {
            version: 1,
            outboxId: claim.outboxId,
            decision: "ALLOWED",
            disposition: "HANDOFF_AUTHORIZED",
            transitionApplied: false,
            canonicalPayload: payload,
            authorizationMarker: marker,
            databaseTime: "2026-08-01T00:00:00.000Z",
            retryNotBefore: null,
          };
        }
        if (path === "/v1/outbox/complete") {
          completeAttempts += 1;
          const bytes = canonicalJson(body);
          if (completeAttempts === 1) {
            committedCompletionBytes = bytes;
            throw new Error("response lost after commit");
          }
          expect(bytes).toBe(committedCompletionBytes);
          const completion = body as {
            deliveryEvidenceHash: string;
            deliveryEvidence: {
              knownProviderMessageIds: string[];
              possibleHandoffPrefixLength: number;
            };
          };
          return {
            version: 1,
            outboxId: claim.outboxId,
            state: "SENT",
            knownProviderMessageIds: completion.deliveryEvidence.knownProviderMessageIds,
            possibleHandoffPrefixLength: completion.deliveryEvidence.possibleHandoffPrefixLength,
            deliveryEvidenceHash: completion.deliveryEvidenceHash,
          };
        }
        throw new Error(`unexpected route ${path}`);
      }),
    };
    const cellRpc = {
      invoke: vi.fn(async () => ({
        status: "SENT" as const,
        reasonCode: "ALL_PARTS_ACKNOWLEDGED" as const,
        totalPartCount: 1,
        possibleHandoffPrefixLength: 1,
        knownProviderMessageIds: ["provider-1"],
        receipts: [{ providerMessageId: "provider-1" }],
      })),
    };

    await expect(runOutboxBatch({
      runtime: api,
      cellRpc,
      claimToken: () => "claim-token-1",
      now: () => new Date("2026-08-01T00:00:01.000Z"),
      retryNotBefore: () => "2026-08-01T00:00:10.000Z",
      limit: 1,
    })).resolves.toEqual([{ outboxId: claim.outboxId, outcome: "SENT" }]);

    expect(cellRpc.invoke).toHaveBeenCalledTimes(1);
    expect(completeAttempts).toBe(2);
    expect(calls.filter((entry) => entry.path === "/v1/outbox/requeue")).toEqual([]);
  });

  it("replays the exact completion when the response is malformed and never rewrites SENT", async () => {
    const completionBodies: string[] = [];
    const api = {
      post: vi.fn(async (path: string, body: unknown) => {
        if (path === "/v1/outbox/claim") return { version: 1, items: [claim] };
        if (path === "/v1/outbox/preflight") {
          return {
            version: 1,
            outboxId: claim.outboxId,
            decision: "ALLOWED",
            disposition: "HANDOFF_AUTHORIZED",
            transitionApplied: false,
            canonicalPayload: payload,
            authorizationMarker: marker,
            databaseTime: "2026-08-01T00:00:00.000Z",
            retryNotBefore: null,
          };
        }
        if (path === "/v1/outbox/complete") {
          completionBodies.push(canonicalJson(body));
          return { version: 1, outboxId: claim.outboxId, state: "UNKNOWN" };
        }
        throw new Error(`unexpected route ${path}`);
      }),
    };
    const cellRpc = {
      invoke: vi.fn(async () => ({
        status: "SENT" as const,
        reasonCode: "ALL_PARTS_ACKNOWLEDGED" as const,
        totalPartCount: 1,
        possibleHandoffPrefixLength: 1,
        knownProviderMessageIds: ["provider-1"],
      })),
    };

    await expect(runOutboxBatch({
      runtime: api,
      cellRpc,
      claimToken: () => "claim-token-1",
      now: () => new Date("2026-08-01T00:00:01.000Z"),
      retryNotBefore: () => "2026-08-01T00:00:10.000Z",
      limit: 1,
    })).rejects.toMatchObject({ code: "OUTBOX_COMPLETION_REPLAY_FAILED" });

    expect(cellRpc.invoke).toHaveBeenCalledTimes(1);
    expect(completionBodies).toHaveLength(2);
    expect(new Set(completionBodies).size).toBe(1);
    expect(completionBodies[0]).toContain('"outcome":"SENT"');
    expect(completionBodies[0]).not.toContain('"outcome":"UNKNOWN"');
  });

  it("does not submit contradictory provider ids beyond the possible handoff prefix", async () => {
    const twoPartPayload: CanonicalSendPayloadV1 = {
      ...payload,
      parts: [
        { version: 1, partIndex: 0, kind: "TEXT", text: "one" },
        { version: 1, partIndex: 1, kind: "TEXT", text: "two" },
      ],
    };
    const twoPartClaim: OutboxClaim = {
      ...claim,
      payload: twoPartPayload,
      payloadHash: hashCanonicalSendPayload(twoPartPayload),
    };
    const twoPartMarker: OutboundAuthorizationMarker = {
      ...marker,
      payloadHash: twoPartClaim.payloadHash,
    };
    const calls: Array<{ path: string; body: unknown }> = [];
    const api = {
      post: vi.fn(async (path: string, body: unknown) => {
        calls.push({ path, body });
        if (path === "/v1/outbox/claim") return { version: 1, items: [twoPartClaim] };
        if (path === "/v1/outbox/preflight") {
          return {
            version: 1,
            outboxId: claim.outboxId,
            decision: "ALLOWED",
            disposition: "HANDOFF_AUTHORIZED",
            transitionApplied: false,
            canonicalPayload: twoPartPayload,
            authorizationMarker: twoPartMarker,
            databaseTime: "2026-08-01T00:00:00.000Z",
            retryNotBefore: null,
          };
        }
        if (path === "/v1/outbox/complete") {
          const completion = body as {
            outcome: string;
            deliveryEvidenceHash: string;
            deliveryEvidence: {
              knownProviderMessageIds: string[];
              possibleHandoffPrefixLength: number;
            };
          };
          return {
            version: 1,
            outboxId: claim.outboxId,
            state: completion.outcome,
            knownProviderMessageIds: completion.deliveryEvidence.knownProviderMessageIds,
            possibleHandoffPrefixLength: completion.deliveryEvidence.possibleHandoffPrefixLength,
            deliveryEvidenceHash: completion.deliveryEvidenceHash,
          };
        }
        throw new Error(`unexpected route ${path}`);
      }),
    };

    await expect(runOutboxBatch({
      runtime: api,
      cellRpc: {
        invoke: vi.fn(async () => ({
          status: "UNKNOWN" as const,
          reasonCode: "ACK_LOST_AFTER_HANDOFF" as const,
          totalPartCount: 2,
          possibleHandoffPrefixLength: 1,
          knownProviderMessageIds: ["provider-1", "provider-2"],
        })),
      },
      claimToken: () => "claim-token-1",
      now: () => new Date("2026-08-01T00:00:01.000Z"),
      retryNotBefore: () => "2026-08-01T00:00:10.000Z",
      limit: 1,
    })).resolves.toEqual([{ outboxId: claim.outboxId, outcome: "UNKNOWN" }]);

    expect(calls.at(-1)?.body).toMatchObject({
      outcome: "UNKNOWN",
      deliveryEvidence: {
        knownProviderMessageIds: [],
        possibleHandoffPrefixLength: 1,
      },
    });
  });
});
