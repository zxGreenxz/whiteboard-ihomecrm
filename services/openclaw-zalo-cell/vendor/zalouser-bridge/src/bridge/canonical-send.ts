import { createHash } from "node:crypto";
import type { BusinessFrame, ProviderSinkV1 } from "./send-context.js";

export type ZaloUserBridgeSendPartV1 =
  | Readonly<{ version: 1; partIndex: number; kind: "TEXT"; text: string }>
  | Readonly<{
      version: 1;
      partIndex: number;
      kind: "MEDIA";
      objectKey: string;
      sha256: string;
      mime: string;
      bytes: number;
    }>;

export type CanonicalSendPayloadV1 = Readonly<{
  version: 1;
  organizationId: string;
  accountId: string;
  target: Readonly<{ kind: "PEER" | "SALES_GROUP"; providerId: string }>;
  channel: "zalouser";
  accountProfile: string;
  idempotencyKey: string;
  parts: readonly ZaloUserBridgeSendPartV1[];
  replyToProviderMessageId: string | null;
  policyVersionId: string;
  automationVersionId: string | null;
  templateVersionId: string | null;
  frozenInputs: Readonly<{
    campaignVersionId: string | null;
    scheduleVersion: number | null;
    subscriptionVersion: number | null;
    subscriptionId: string | null;
    occurrenceId: string | null;
    sourceTable: string | null;
    sourceId: string | null;
    sourceVersion: string | null;
    knowledgeVersionIds: readonly string[];
    sourceSnapshotHash: string | null;
    targetVersion: number;
    targetDirectoryRefreshedAt: string;
    fieldMappingHash: string | null;
  }>;
}>;

export type OutboundAuthorizationMarkerV1 = Readonly<{
  version: 1;
  outboxId: string;
  claimGeneration: number;
  payloadHash: string;
  fencingToken: number;
  sessionGeneration: number;
  controlVersion: number;
  takeoverVersion: number;
  markerNonce: string;
  expiresAt: string;
}>;

export type OutboxAuthorizeSendRequestV1 = Readonly<{
  version: 1;
  claimToken: string;
  authorizationMarker: OutboundAuthorizationMarkerV1;
}>;

export type ZaloUserBridgeSendParamsV1 = Readonly<{
  version: 1;
  payload: CanonicalSendPayloadV1;
  authorization: OutboxAuthorizeSendRequestV1;
}>;

const MAX_PARTS = 20;
const PAYLOAD_HASH_DOMAIN = "ihome-openclaw-send-v1\0";

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function snapshotRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return undefined;
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
    Object.defineProperty(copy, key, {
      configurable: false,
      enumerable: true,
      value: descriptor.value,
      writable: false,
    });
  }
  return Object.freeze(copy);
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  name: string,
): Readonly<Record<string, unknown>> {
  const record = snapshotRecord(value);
  if (!record) return fail("INVALID_PRIVATE_SEND_REQUEST", `${name} must be a plain object`);
  const keys = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return fail(
      "INVALID_PRIVATE_SEND_REQUEST",
      `${name} must contain exactly: ${expectedKeys.join(", ")}`,
    );
  }
  return record;
}

function denseArray(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return fail("INVALID_PRIVATE_SEND_REQUEST", `${name} must be a plain array`);
  }
  const keys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) || lengthDescriptor.enumerable) {
    return fail("INVALID_PRIVATE_SEND_REQUEST", `${name} has invalid length evidence`);
  }
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1) {
    return fail("INVALID_PRIVATE_SEND_REQUEST", `${name} must contain dense indices only`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      return fail("INVALID_PRIVATE_SEND_REQUEST", `${name} is sparse`);
    }
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    return fail("INVALID_PRIVATE_SEND_REQUEST", `${name} is required`);
  }
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    return fail("INVALID_PRIVATE_SEND_REQUEST", `${name} must be a string or null`);
  }
  return value;
}

function integer(value: unknown, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    return fail("INVALID_PRIVATE_SEND_REQUEST", `${name} must be an integer >= ${minimum}`);
  }
  return value as number;
}

function isoTimestamp(value: unknown, name: string): string {
  const timestamp = requiredString(value, name);
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== timestamp) {
    return fail("INVALID_PRIVATE_SEND_REQUEST", `${name} must be a canonical ISO timestamp`);
  }
  return timestamp;
}

function hasAtMostCodePoints(value: string, maximum: number): boolean {
  let count = 0;
  for (const _codePoint of value) {
    count += 1;
    if (count > maximum) return false;
  }
  return true;
}

function snapshotPart(value: unknown, expectedIndex: number): ZaloUserBridgeSendPartV1 {
  const base = snapshotRecord(value);
  if (!base || base.version !== 1 || base.partIndex !== expectedIndex) {
    return fail(
      "INVALID_PRIVATE_SEND_REQUEST",
      `parts[${expectedIndex}] must use version 1 and its exact zero-based index`,
    );
  }
  if (base.kind === "TEXT") {
    const record = exactRecord(base, ["version", "partIndex", "kind", "text"], `parts[${expectedIndex}]`);
    const text = requiredString(record.text, `parts[${expectedIndex}].text`);
    if (!hasAtMostCodePoints(text, 2_000)) {
      return fail("INVALID_PRIVATE_SEND_REQUEST", `parts[${expectedIndex}].text exceeds 2000 code points`);
    }
    return Object.freeze({ version: 1, partIndex: expectedIndex, kind: "TEXT", text });
  }
  if (base.kind === "MEDIA") {
    const record = exactRecord(
      base,
      ["version", "partIndex", "kind", "objectKey", "sha256", "mime", "bytes"],
      `parts[${expectedIndex}]`,
    );
    const sha256 = requiredString(record.sha256, `parts[${expectedIndex}].sha256`);
    if (!/^[0-9a-f]{64}$/u.test(sha256)) {
      return fail("INVALID_PRIVATE_SEND_REQUEST", `parts[${expectedIndex}].sha256 is invalid`);
    }
    return Object.freeze({
      version: 1,
      partIndex: expectedIndex,
      kind: "MEDIA",
      objectKey: requiredString(record.objectKey, `parts[${expectedIndex}].objectKey`),
      sha256,
      mime: requiredString(record.mime, `parts[${expectedIndex}].mime`),
      bytes: integer(record.bytes, `parts[${expectedIndex}].bytes`, 1),
    });
  }
  return fail("UNSUPPORTED_BUSINESS_PART", "only TEXT and MEDIA business parts are supported");
}

function snapshotFrozenInputs(value: unknown): CanonicalSendPayloadV1["frozenInputs"] {
  const record = exactRecord(value, [
    "campaignVersionId",
    "scheduleVersion",
    "subscriptionVersion",
    "subscriptionId",
    "occurrenceId",
    "sourceTable",
    "sourceId",
    "sourceVersion",
    "knowledgeVersionIds",
    "sourceSnapshotHash",
    "targetVersion",
    "targetDirectoryRefreshedAt",
    "fieldMappingHash",
  ], "frozenInputs");
  const knowledgeValues = denseArray(record.knowledgeVersionIds, "knowledgeVersionIds");
  const knowledgeVersionIds = Object.freeze(
    knowledgeValues.map((item, index) => requiredString(item, `knowledgeVersionIds[${index}]`)),
  );
  const nullableInteger = (candidate: unknown, name: string): number | null =>
    candidate === null ? null : integer(candidate, name);
  return Object.freeze({
    campaignVersionId: nullableString(record.campaignVersionId, "campaignVersionId"),
    scheduleVersion: nullableInteger(record.scheduleVersion, "scheduleVersion"),
    subscriptionVersion: nullableInteger(record.subscriptionVersion, "subscriptionVersion"),
    subscriptionId: nullableString(record.subscriptionId, "subscriptionId"),
    occurrenceId: nullableString(record.occurrenceId, "occurrenceId"),
    sourceTable: nullableString(record.sourceTable, "sourceTable"),
    sourceId: nullableString(record.sourceId, "sourceId"),
    sourceVersion: nullableString(record.sourceVersion, "sourceVersion"),
    knowledgeVersionIds,
    sourceSnapshotHash: nullableString(record.sourceSnapshotHash, "sourceSnapshotHash"),
    targetVersion: integer(record.targetVersion, "targetVersion"),
    targetDirectoryRefreshedAt: isoTimestamp(
      record.targetDirectoryRefreshedAt,
      "targetDirectoryRefreshedAt",
    ),
    fieldMappingHash: nullableString(record.fieldMappingHash, "fieldMappingHash"),
  });
}

export function snapshotCanonicalSendPayload(value: unknown): CanonicalSendPayloadV1 {
  const record = exactRecord(value, [
    "version",
    "organizationId",
    "accountId",
    "target",
    "channel",
    "accountProfile",
    "idempotencyKey",
    "parts",
    "replyToProviderMessageId",
    "policyVersionId",
    "automationVersionId",
    "templateVersionId",
    "frozenInputs",
  ], "payload");
  if (record.version !== 1 || record.channel !== "zalouser") {
    return fail("INVALID_PRIVATE_SEND_REQUEST", "payload version/channel is invalid");
  }
  const target = exactRecord(record.target, ["kind", "providerId"], "payload.target");
  if (target.kind !== "PEER" && target.kind !== "SALES_GROUP") {
    return fail("INVALID_PRIVATE_SEND_REQUEST", "payload.target.kind is invalid");
  }
  const partValues = denseArray(record.parts, "payload.parts");
  if (partValues.length === 0 || partValues.length > MAX_PARTS) {
    return fail("INVALID_PRIVATE_SEND_REQUEST", `payload.parts must contain 1-${MAX_PARTS} items`);
  }
  const parts = Object.freeze(partValues.map((part, index) => snapshotPart(part, index)));
  return Object.freeze({
    version: 1,
    organizationId: requiredString(record.organizationId, "payload.organizationId"),
    accountId: requiredString(record.accountId, "payload.accountId"),
    target: Object.freeze({
      kind: target.kind,
      providerId: requiredString(target.providerId, "payload.target.providerId"),
    }),
    channel: "zalouser",
    accountProfile: requiredString(record.accountProfile, "payload.accountProfile"),
    idempotencyKey: requiredString(record.idempotencyKey, "payload.idempotencyKey"),
    parts,
    replyToProviderMessageId: nullableString(
      record.replyToProviderMessageId,
      "payload.replyToProviderMessageId",
    ),
    policyVersionId: requiredString(record.policyVersionId, "payload.policyVersionId"),
    automationVersionId: nullableString(record.automationVersionId, "payload.automationVersionId"),
    templateVersionId: nullableString(record.templateVersionId, "payload.templateVersionId"),
    frozenInputs: snapshotFrozenInputs(record.frozenInputs),
  });
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) items.push(canonical(value[index]));
    return `[${items.join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

export function hashCanonicalSendPayload(payloadValue: CanonicalSendPayloadV1): string {
  const payload = snapshotCanonicalSendPayload(payloadValue);
  return createHash("sha256")
    .update(PAYLOAD_HASH_DOMAIN, "utf8")
    .update(canonical(payload), "utf8")
    .digest("hex");
}

function snapshotAuthorization(value: unknown, payload: CanonicalSendPayloadV1): OutboxAuthorizeSendRequestV1 {
  const record = exactRecord(value, ["version", "claimToken", "authorizationMarker"], "authorization");
  if (record.version !== 1) return fail("INVALID_PRIVATE_SEND_REQUEST", "authorization.version must be 1");
  const marker = exactRecord(record.authorizationMarker, [
    "version",
    "outboxId",
    "claimGeneration",
    "payloadHash",
    "fencingToken",
    "sessionGeneration",
    "controlVersion",
    "takeoverVersion",
    "markerNonce",
    "expiresAt",
  ], "authorization.authorizationMarker");
  if (marker.version !== 1) {
    return fail("INVALID_PRIVATE_SEND_REQUEST", "authorization marker version must be 1");
  }
  const expectedPayloadHash = hashCanonicalSendPayload(payload);
  const markerPayloadHash = requiredString(marker.payloadHash, "authorizationMarker.payloadHash");
  if (markerPayloadHash !== expectedPayloadHash) {
    return fail("AUTHORIZATION_HASH_MISMATCH", "authorization marker payload hash is invalid");
  }
  return Object.freeze({
    version: 1,
    claimToken: requiredString(record.claimToken, "authorization.claimToken"),
    authorizationMarker: Object.freeze({
      version: 1,
      outboxId: requiredString(marker.outboxId, "authorizationMarker.outboxId"),
      claimGeneration: integer(marker.claimGeneration, "authorizationMarker.claimGeneration", 1),
      payloadHash: markerPayloadHash,
      fencingToken: integer(marker.fencingToken, "authorizationMarker.fencingToken", 1),
      sessionGeneration: integer(marker.sessionGeneration, "authorizationMarker.sessionGeneration", 1),
      controlVersion: integer(marker.controlVersion, "authorizationMarker.controlVersion"),
      takeoverVersion: integer(marker.takeoverVersion, "authorizationMarker.takeoverVersion"),
      markerNonce: requiredString(marker.markerNonce, "authorizationMarker.markerNonce"),
      expiresAt: isoTimestamp(marker.expiresAt, "authorizationMarker.expiresAt"),
    }),
  });
}

export function snapshotZaloUserBridgeSendParams(value: unknown): ZaloUserBridgeSendParamsV1 {
  const record = exactRecord(value, ["version", "payload", "authorization"], "private send request");
  if (record.version !== 1) return fail("INVALID_PRIVATE_SEND_REQUEST", "request.version must be 1");
  const payload = snapshotCanonicalSendPayload(record.payload);
  const authorization = snapshotAuthorization(record.authorization, payload);
  return Object.freeze({ version: 1, payload, authorization });
}

export function providerSinkFromPayload(payloadValue: CanonicalSendPayloadV1): ProviderSinkV1 {
  const payload = snapshotCanonicalSendPayload(payloadValue);
  return Object.freeze({
    accountId: payload.accountId,
    accountProfile: payload.accountProfile,
    conversationId: payload.target.providerId,
    isGroup: payload.target.kind === "SALES_GROUP",
  });
}

export function businessFramesFromPayload(payloadValue: CanonicalSendPayloadV1): readonly BusinessFrame[] {
  const payload = snapshotCanonicalSendPayload(payloadValue);
  return Object.freeze(payload.parts.map((part): BusinessFrame => {
    if (part.kind === "TEXT") return Object.freeze({ kind: "text", text: part.text });
    return Object.freeze({
      kind: "media",
      objectKey: part.objectKey,
      byteLength: part.bytes,
      contentType: part.mime,
      sha256: part.sha256,
    });
  }));
}
