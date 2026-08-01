import { describe, expect, it } from "vitest";

import {
  parseOpenClawSendWorkClaimV1,
  parseOutboxClaim,
  parseOutboundAuthorizationMarker,
  snapshotCanonicalSendPayload,
  type CanonicalSendPayloadV1,
} from "../src/runtime-api/schemas.js";
import { hashCanonicalSendPayload } from "../src/adapters/zalouser-bridge-rpc-adapter.js";

const payload: CanonicalSendPayloadV1 = {
  version: 1,
  organizationId: "dddd0000-0000-4000-8000-000000000001",
  accountId: "dddd1000-0000-4000-8000-000000000001",
  target: { kind: "PEER", providerId: "peer-1" },
  channel: "zalouser",
  accountProfile: "primary",
  idempotencyKey: "work:1",
  parts: [{ version: 1, partIndex: 0, kind: "TEXT", text: "Xin chào 😀" }],
  replyToProviderMessageId: null,
  policyVersionId: "dddd3000-0000-4000-8000-000000000001",
  automationVersionId: "dddd4000-0000-4000-8000-000000000001",
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
    sourceSnapshotHash: "a".repeat(64),
    targetVersion: 2,
    targetDirectoryRefreshedAt: "2026-08-01T00:00:00.000Z",
    fieldMappingHash: null,
  },
};

describe("Task 18 exact runtime contracts", () => {
  it("snapshots a strict canonical payload and rejects unknown keys", () => {
    expect(snapshotCanonicalSendPayload(payload)).toEqual(payload);
    expect(() => snapshotCanonicalSendPayload({ ...payload, outboxId: "forbidden" }))
      .toThrowError(/exact/i);
  });

  it("parses a complete OutboxClaim and verifies its payload hash", () => {
    const claim = {
      version: 1,
      outboxId: "dddd8000-0000-4000-8000-000000000001",
      organizationId: payload.organizationId,
      accountId: payload.accountId,
      claimToken: "private-claim-token",
      claimGeneration: 3,
      fencingToken: 7,
      sessionGeneration: 5,
      controlVersion: 2,
      takeoverVersion: 1,
      leaseExpiresAt: "2026-08-01T00:00:30.000Z",
      payloadHash: hashCanonicalSendPayload(payload),
      payload,
    };
    expect(parseOutboxClaim(claim)).toEqual(claim);
    expect(() => parseOutboxClaim({ ...claim, payloadHash: "b".repeat(64) }))
      .toThrowError(/payload hash/i);
  });

  it("preserves PostgreSQL RFC3339 offsets in SQL-shaped runtime claims", () => {
    const offsetPayload = {
      ...payload,
      frozenInputs: {
        ...payload.frozenInputs,
        targetDirectoryRefreshedAt: "2026-08-01T00:00:00+00:00",
      },
    };
    const outboxClaim = {
      version: 1,
      outboxId: "dddd8000-0000-4000-8000-000000000001",
      organizationId: payload.organizationId,
      accountId: payload.accountId,
      claimToken: "private-claim-token",
      claimGeneration: 3,
      fencingToken: 7,
      sessionGeneration: 5,
      controlVersion: 2,
      takeoverVersion: 1,
      leaseExpiresAt: "2026-08-01T00:00:30+00:00",
      payloadHash: hashCanonicalSendPayload(offsetPayload),
      payload: offsetPayload,
    };
    expect(parseOutboxClaim(outboxClaim)).toEqual(outboxClaim);

    const sendWorkClaim = {
      version: 1,
      workItemId: "dddd9000-0000-4000-8000-000000000001",
      organizationId: payload.organizationId,
      accountId: payload.accountId,
      cellId: "dddd2000-0000-4000-8000-000000000001",
      credentialGeneration: 4,
      leaseGeneration: 3,
      sourceKey: "inbound:event-1:v1",
      claimToken: "work-claim-token",
      claimGeneration: 2,
      fencingToken: 7,
      leaseExpiresAt: "2026-08-01T07:00:30+07:00",
      payload: {
        kind: "INBOUND_AUTOMATION",
        inboundEventId: "dddd9100-0000-4000-8000-000000000001",
        messageId: "dddd9200-0000-4000-8000-000000000001",
        conversationId: "dddd9300-0000-4000-8000-000000000001",
        targetId: "dddd9400-0000-4000-8000-000000000001",
        targetVersion: 2,
        targetDirectoryRefreshedAt: "2026-08-01T07:00:00+07:00",
        automationVersionId: "dddd4000-0000-4000-8000-000000000001",
        templateVersionId: "dddd4100-0000-4000-8000-000000000001",
        knowledgeVersionIds: [],
        eligibilityDecisionHash: "c".repeat(64),
      },
    };
    expect(parseOpenClawSendWorkClaimV1(sendWorkClaim)).toEqual(sendWorkClaim);
  });

  it("rejects incomplete, extra, or non-canonical authorization markers", () => {
    const marker = {
      version: 1,
      outboxId: "dddd8000-0000-4000-8000-000000000001",
      claimGeneration: 3,
      payloadHash: hashCanonicalSendPayload(payload),
      fencingToken: 7,
      sessionGeneration: 5,
      controlVersion: 2,
      takeoverVersion: 1,
      markerNonce: "dddd7000-0000-4000-8000-000000000001",
      expiresAt: "2026-08-01T00:00:15.000Z",
    };
    expect(parseOutboundAuthorizationMarker(marker)).toEqual(marker);
    const { markerNonce: _missing, ...incomplete } = marker;
    expect(() => parseOutboundAuthorizationMarker(incomplete)).toThrow();
    expect(() => parseOutboundAuthorizationMarker({ ...marker, token: "secret" })).toThrow();
    expect(() => parseOutboundAuthorizationMarker({
      ...marker,
      expiresAt: "2026-08-01 00:00:15Z",
    })).toThrow();
  });

  it("parses only the exact discriminated send-work claim", () => {
    const claim = {
      version: 1,
      workItemId: "dddd9000-0000-4000-8000-000000000001",
      organizationId: payload.organizationId,
      accountId: payload.accountId,
      cellId: "dddd2000-0000-4000-8000-000000000001",
      credentialGeneration: 4,
      leaseGeneration: 3,
      sourceKey: "inbound:event-1:v1",
      claimToken: "work-claim-token",
      claimGeneration: 2,
      fencingToken: 7,
      leaseExpiresAt: "2026-08-01T00:00:30.000Z",
      payload: {
        kind: "INBOUND_AUTOMATION",
        inboundEventId: "dddd9100-0000-4000-8000-000000000001",
        messageId: "dddd9200-0000-4000-8000-000000000001",
        conversationId: "dddd9300-0000-4000-8000-000000000001",
        targetId: "dddd9400-0000-4000-8000-000000000001",
        targetVersion: 2,
        targetDirectoryRefreshedAt: "2026-08-01T00:00:00.000Z",
        automationVersionId: "dddd4000-0000-4000-8000-000000000001",
        templateVersionId: "dddd4100-0000-4000-8000-000000000001",
        knowledgeVersionIds: [],
        eligibilityDecisionHash: "c".repeat(64),
      },
    };
    expect(parseOpenClawSendWorkClaimV1(claim)).toEqual(claim);
    expect(() => parseOpenClawSendWorkClaimV1({
      ...claim,
      payload: { ...claim.payload, kind: "RETENTION_DELETE" },
    })).toThrow();
  });
});
