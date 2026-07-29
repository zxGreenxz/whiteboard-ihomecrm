import {
  businessFramesFromPayload,
  hashCanonicalSendPayload,
  providerSinkFromPayload,
  type CanonicalSendPayloadV1,
  type OutboundAuthorizationMarkerV1,
  type ZaloUserBridgeSendParamsV1,
  type ZaloUserBridgeSendPartV1,
} from "../src/bridge/canonical-send.js";

export const TEXT_PART = Object.freeze({
  version: 1 as const,
  partIndex: 0,
  kind: "TEXT" as const,
  text: "one",
});

export const MEDIA_PART = Object.freeze({
  version: 1 as const,
  partIndex: 1,
  kind: "MEDIA" as const,
  objectKey: "organization-a/account-a/outbox-a/part-1",
  sha256: "a".repeat(64),
  mime: "image/png",
  bytes: 4,
});

export const PARTS = Object.freeze([TEXT_PART, MEDIA_PART]);

export function makePayload(
  parts: readonly ZaloUserBridgeSendPartV1[] = PARTS,
): CanonicalSendPayloadV1 {
  return Object.freeze({
    version: 1,
    organizationId: "organization-a",
    accountId: "account-a",
    target: Object.freeze({ kind: "SALES_GROUP", providerId: "group-a" }),
    channel: "zalouser",
    accountProfile: "profile-a",
    idempotencyKey: "outbox-a:1",
    parts: Object.freeze([...parts]),
    replyToProviderMessageId: null,
    policyVersionId: "policy-v1",
    automationVersionId: null,
    templateVersionId: null,
    frozenInputs: Object.freeze({
      campaignVersionId: null,
      scheduleVersion: null,
      subscriptionVersion: null,
      subscriptionId: null,
      occurrenceId: null,
      sourceTable: null,
      sourceId: null,
      sourceVersion: null,
      knowledgeVersionIds: Object.freeze([]),
      sourceSnapshotHash: null,
      targetVersion: 1,
      targetDirectoryRefreshedAt: "2026-07-29T10:00:00.000Z",
      fieldMappingHash: null,
    }),
  });
}

export function makeRequest(
  parts: readonly ZaloUserBridgeSendPartV1[] = PARTS,
  markerOverrides: Partial<OutboundAuthorizationMarkerV1> = {},
): ZaloUserBridgeSendParamsV1 {
  const payload = makePayload(parts);
  return Object.freeze({
    version: 1,
    payload,
    authorization: Object.freeze({
      version: 1,
      claimToken: "claim-token-secret",
      authorizationMarker: Object.freeze({
        version: 1,
        outboxId: "outbox-a",
        claimGeneration: 1,
        payloadHash: hashCanonicalSendPayload(payload),
        fencingToken: 9,
        sessionGeneration: 7,
        controlVersion: 3,
        takeoverVersion: 2,
        markerNonce: "marker-nonce-a",
        expiresAt: "2026-07-29T10:00:15.000Z",
        ...markerOverrides,
      }),
    }),
  });
}

export const REQUEST = makeRequest();
export const SINK = providerSinkFromPayload(REQUEST.payload);
export const FRAMES = businessFramesFromPayload(REQUEST.payload);
