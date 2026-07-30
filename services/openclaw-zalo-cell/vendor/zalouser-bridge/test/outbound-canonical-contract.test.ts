import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  assertAuthorizedProviderCall,
  assertAuthorizedProviderIo,
  createPrivateOutboundRpc,
  type PrivateBridgeSendRequestV1,
} from "../src/bridge/outbound-rpc.js";
import {
  businessFramesFromPayload,
  snapshotCanonicalSendPayload,
  type CanonicalSendPayloadV1,
} from "../src/bridge/canonical-send.js";
import {
  createPreparedOutboundBatch,
  type BusinessFrame,
  type ProviderSinkV1,
} from "../src/bridge/send-context.js";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function payloadHash(payload: unknown): string {
  return createHash("sha256")
    .update("ihome-openclaw-send-v1\0", "utf8")
    .update(canonical(payload), "utf8")
    .digest("hex");
}

const payload = Object.freeze({
  version: 1 as const,
  organizationId: "organization-a",
  accountId: "account-a",
  target: Object.freeze({ kind: "SALES_GROUP" as const, providerId: "group-a" }),
  channel: "zalouser" as const,
  accountProfile: "profile-a",
  idempotencyKey: "outbox-a:1",
  parts: Object.freeze([
    Object.freeze({ version: 1 as const, partIndex: 0, kind: "TEXT" as const, text: "hello" }),
    Object.freeze({
      version: 1 as const,
      partIndex: 1,
      kind: "MEDIA" as const,
      objectKey: "organization-a/account-a/outbox-a/part-1",
      sha256: "a".repeat(64),
      mime: "image/png",
      bytes: 4,
    }),
  ]),
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

const request = Object.freeze({
  version: 1 as const,
  payload,
  authorization: Object.freeze({
    version: 1 as const,
    claimToken: "claim-token-secret",
    authorizationMarker: Object.freeze({
      version: 1 as const,
      outboxId: "outbox-a",
      claimGeneration: 1,
      payloadHash: payloadHash(payload),
      fencingToken: 9,
      sessionGeneration: 7,
      controlVersion: 3,
      takeoverVersion: 2,
      markerNonce: "marker-nonce-a",
      expiresAt: "2026-07-29T10:00:15.000Z",
    }),
  }),
});

const sink: ProviderSinkV1 = Object.freeze({
  accountId: payload.accountId,
  accountProfile: payload.accountProfile,
  conversationId: payload.target.providerId,
  isGroup: true,
});

const mediaPart = payload.parts[1];
if (!mediaPart || mediaPart.kind !== "MEDIA") throw new Error("missing media fixture");

const frames = Object.freeze([
  Object.freeze({ kind: "text", text: "hello" }),
  Object.freeze({
    kind: "media",
    objectKey: mediaPart.objectKey,
    byteLength: 4,
    contentType: "image/png",
    sha256: "a".repeat(64),
  }),
]) as unknown as readonly BusinessFrame[];

type MutablePayload = Record<string, unknown> & {
  organizationId: string;
  accountId: string;
  target: { providerId: string };
  accountProfile: string;
  idempotencyKey: string;
  parts: Array<Record<string, unknown>>;
  replyToProviderMessageId: string | null;
  policyVersionId: string;
};

function mutablePayload(): MutablePayload {
  return JSON.parse(JSON.stringify(payload)) as MutablePayload;
}

describe("canonical ZaloUserBridgeSendParamsV1", () => {
  it("accepts the complete canonical payload and authorization marker", async () => {
    const authorize = vi.fn(async (candidate: PrivateBridgeSendRequestV1) => {
      expect(candidate).toEqual(request);
    });
    const rpc = createPrivateOutboundRpc({
      prepare: async () => Object.freeze({
        batch: createPreparedOutboundBatch(sink, frames),
        sendPrepared: async (call: ReturnType<typeof createPreparedOutboundBatch>["calls"][number]) => {
          assertAuthorizedProviderCall(call);
          assertAuthorizedProviderIo(call.sink);
          return { providerMessageId: `provider-${call.frameIndex}` };
        },
      }),
      authorize,
    });

    await expect(rpc.invoke(
      "zalouser.bridge.send",
      request as unknown as PrivateBridgeSendRequestV1,
    )).resolves.toMatchObject({ status: "SENT" });
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it.each([
    { kind: "link", url: "https://example.invalid", caption: null },
    { kind: "reaction", msgId: "m", cliMsgId: "c", emoji: "heart", remove: false },
  ])("rejects $kind as a business part before authorization", (unsupported) => {
    expect(() => createPreparedOutboundBatch(
      sink,
      [unsupported] as unknown as readonly BusinessFrame[],
    )).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_BUSINESS_PART" }));
  });

  it.each([
    ["organizationId", (candidate: MutablePayload) => { candidate.organizationId = " organization-a"; }],
    ["accountId", (candidate: MutablePayload) => { candidate.accountId = "account-a "; }],
    ["target.providerId", (candidate: MutablePayload) => { candidate.target.providerId = " group-a "; }],
    ["accountProfile", (candidate: MutablePayload) => { candidate.accountProfile = " profile-a"; }],
    ["idempotencyKey", (candidate: MutablePayload) => { candidate.idempotencyKey = "outbox-a:1 "; }],
    ["replyToProviderMessageId", (candidate: MutablePayload) => {
      candidate.replyToProviderMessageId = " provider-message-a ";
    }],
    ["policyVersionId", (candidate: MutablePayload) => { candidate.policyVersionId = " policy-v1"; }],
  ])("rejects non-canonical whitespace in routing identifier %s", (_field, mutate) => {
    const candidate = mutablePayload();
    mutate(candidate);
    expect(() => snapshotCanonicalSendPayload(candidate)).toThrowError(
      expect.objectContaining({ code: "INVALID_PRIVATE_SEND_REQUEST" }),
    );
  });

  it("preserves intentional whitespace in message text", () => {
    const candidate = mutablePayload();
    candidate.parts = [{ version: 1, partIndex: 0, kind: "TEXT", text: "  hello  " }];
    expect(snapshotCanonicalSendPayload(candidate).parts[0]).toMatchObject({ text: "  hello  " });
  });

  it("rejects a media part or aggregate that exceeds the bounded materialization budget", () => {
    const oversizedPart = mutablePayload();
    oversizedPart.parts = [{
      version: 1,
      partIndex: 0,
      kind: "MEDIA",
      objectKey: "organization-a/account-a/outbox-a/part-0",
      sha256: "b".repeat(64),
      mime: "image/png",
      bytes: 32 * 1024 * 1024 + 1,
    }];
    expect(() => snapshotCanonicalSendPayload(oversizedPart)).toThrowError(
      expect.objectContaining({ code: "INVALID_PRIVATE_SEND_REQUEST" }),
    );

    const oversizedAggregate = mutablePayload();
    oversizedAggregate.parts = [0, 1, 2].map((partIndex) => ({
      version: 1,
      partIndex,
      kind: "MEDIA",
      objectKey: `organization-a/account-a/outbox-a/part-${partIndex}`,
      sha256: String(partIndex + 1).repeat(64),
      mime: "image/png",
      bytes: partIndex === 2 ? 1 : 32 * 1024 * 1024,
    }));
    expect(() => snapshotCanonicalSendPayload(oversizedAggregate)).toThrowError(
      expect.objectContaining({ code: "INVALID_PRIVATE_SEND_REQUEST" }),
    );
  });

  it("rejects mixed-case MIME before provider classification", () => {
    const candidate = mutablePayload();
    const media = candidate.parts[1];
    if (!media) throw new Error("missing media fixture");
    media.mime = "Image/PNG";
    expect(() => snapshotCanonicalSendPayload(candidate)).toThrowError(
      expect.objectContaining({ code: "INVALID_PRIVATE_SEND_REQUEST" }),
    );
  });

  it("fails closed instead of silently dropping a provider reply intent", () => {
    const candidate = mutablePayload();
    candidate.replyToProviderMessageId = "provider-message-a";
    const canonicalPayload = snapshotCanonicalSendPayload(candidate) as CanonicalSendPayloadV1;
    expect(() => businessFramesFromPayload(canonicalPayload)).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_PROVIDER_REPLY" }),
    );
  });
});
