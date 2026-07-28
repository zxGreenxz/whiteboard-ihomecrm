import { createHash } from "node:crypto";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ZaloUserInboundEventKindV1 =
  | "MESSAGE"
  | "REACTION"
  | "DELIVERY_RECEIPT"
  | "SEEN"
  | "TYPING"
  | "MEMBERSHIP"
  | "OTHER";

export type ZaloUserInboundMediaKindV1 =
  | "IMAGE"
  | "VIDEO"
  | "AUDIO"
  | "FILE"
  | "STICKER"
  | "OTHER";

export type ZaloUserInboundMediaInputV1 = Readonly<{
  providerMediaId: string | null;
  kind: ZaloUserInboundMediaKindV1;
  mime: string | null;
  byteLength: number | null;
  providerChecksum: string | null;
  fetchRef: string | null;
}>;

export type ZaloUserInboundMediaManifestEntryV1 = Readonly<{
  version: 1;
  index: number;
  providerMediaId: string | null;
  kind: ZaloUserInboundMediaKindV1;
  mime: string | null;
  byteLength: number | null;
  providerChecksum: string | null;
  fetchRef: string | null;
  byteState: "PENDING";
}>;

export type ZaloUserInboundInputV1 = Readonly<{
  providerEventId: string | null;
  providerMessageId: string | null;
  eventKind: ZaloUserInboundEventKindV1;
  providerConversationId: string;
  providerSenderId: string;
  providerTarget: Readonly<{ kind: "PEER" | "SALES_GROUP"; providerId: string }>;
  providerEventType: string;
  sourceTimestamp: string;
  callbackReceivedAt: string;
  rawEnvelope: unknown;
  normalized: Readonly<{
    text: string | null;
    replyToProviderMessageId: string | null;
    media: readonly ZaloUserInboundMediaInputV1[];
  }>;
}>;

export type ZaloUserInboundEnvelopeV1 = Readonly<{
  version: 1;
  organizationId: string;
  accountId: string;
  cellId: string;
  sessionGeneration: number;
  providerEventId: string | null;
  providerMessageId: string | null;
  eventKind: ZaloUserInboundEventKindV1;
  providerConversationId: string;
  providerSenderId: string;
  providerTarget: Readonly<{ kind: "PEER" | "SALES_GROUP"; providerId: string }>;
  providerEventType: string;
  sourceTimestamp: string;
  callbackReceivedAt: string;
  rawEnvelope: JsonValue;
  rawEnvelopeSha256: string;
  normalized: Readonly<{
    text: string | null;
    replyToProviderMessageId: string | null;
    mediaManifest: readonly ZaloUserInboundMediaManifestEntryV1[];
  }>;
  normalizedSha256: string;
}>;

export type InboundBridgeBinding = Readonly<{
  organizationId: string;
  cellId: string;
  sessionGeneration: number;
}>;

export type CommittedInboundBridgeAcknowledgementV1 = Readonly<{
  version: 1;
  status: "committed";
  durability: Readonly<{ journalMode: "WAL"; synchronous: "FULL" }>;
}>;

export type DuplicateInboundBridgeAcknowledgementV1 = Readonly<{
  version: 1;
  status: "duplicate";
}>;

export type CollisionInboundBridgeAcknowledgementV1 = Readonly<{
  version: 1;
  status: "collision";
}>;

export type InboundBridgeAcknowledgementV1 =
  | CommittedInboundBridgeAcknowledgementV1
  | DuplicateInboundBridgeAcknowledgementV1
  | CollisionInboundBridgeAcknowledgementV1;

export type InboundBridgeCommitter = (
  envelope: ZaloUserInboundEnvelopeV1,
) => Promise<unknown>;

export type CommittedInboundResult = Readonly<{
  envelope: ZaloUserInboundEnvelopeV1;
  status: "committed";
}>;

export type DuplicateInboundResult = Readonly<{
  envelope: ZaloUserInboundEnvelopeV1;
  status: "duplicate";
}>;

type InboundCommitResult = CommittedInboundResult | DuplicateInboundResult;

type InstalledInboundBridge = Readonly<{
  binding: InboundBridgeBinding;
  committer: InboundBridgeCommitter;
}>;

const EVENT_KINDS = new Set<ZaloUserInboundEventKindV1>([
  "MESSAGE",
  "REACTION",
  "DELIVERY_RECEIPT",
  "SEEN",
  "TYPING",
  "MEMBERSHIP",
  "OTHER",
]);

const MEDIA_KINDS = new Set<ZaloUserInboundMediaKindV1>([
  "IMAGE",
  "VIDEO",
  "AUDIO",
  "FILE",
  "STICKER",
  "OTHER",
]);

let installedInboundBridge: InstalledInboundBridge | undefined;

export class InboundIdCollisionError extends Error {
  readonly code = "INBOUND_ID_COLLISION";

  constructor(message = "provider inbound stable id collision") {
    super(message);
    this.name = "InboundIdCollisionError";
  }
}

export class InboundBridgeUnavailableError extends Error {
  readonly code = "INBOUND_BRIDGE_UNAVAILABLE";

  constructor(message = "cell-local inbound bridge binding and committer are unavailable") {
    super(message);
    this.name = "InboundBridgeUnavailableError";
  }
}

export class InboundBridgeInvalidAcknowledgementError extends Error {
  readonly code = "INBOUND_BRIDGE_INVALID_ACK";

  constructor(message = "inbound bridge returned a malformed acknowledgement") {
    super(message);
    this.name = "InboundBridgeInvalidAcknowledgementError";
  }
}

export class InboundEnvelopeInvalidError extends TypeError {
  readonly code = "INBOUND_ENVELOPE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "InboundEnvelopeInvalidError";
  }
}

function invalidEnvelope(message: string): never {
  throw new InboundEnvelopeInvalidError(message);
}

function isSafeRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return false;
  }
  return true;
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function exactRecord(
  name: string,
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (!isSafeRecord(value) || !hasExactKeys(value, expectedKeys)) {
    return invalidEnvelope(`${name} must be a plain object with exactly: ${expectedKeys.join(", ")}`);
  }
  return value;
}

function requiredString(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    return invalidEnvelope(`${name} is required`);
  }
  return value;
}

function nullableString(name: string, value: unknown): string | null {
  if (value === null) return null;
  return requiredString(name, value);
}

function positiveSafeInteger(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    return invalidEnvelope(`${name} must be a positive safe integer`);
  }
  return value as number;
}

function nullableByteLength(name: string, value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalidEnvelope(`${name} must be null or a non-negative safe integer`);
  }
  return value as number;
}

function canonicalTimestamp(name: string, value: unknown): string {
  const timestamp = requiredString(name, value);
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== timestamp) {
    return invalidEnvelope(`${name} must be a canonical UTC timestamp`);
  }
  return timestamp;
}

type CanonicalJson = Readonly<{ json: string; value: JsonValue }>;

function canonicalizeJsonValue(
  input: unknown,
  path: string,
  ancestors: WeakSet<object>,
): CanonicalJson {
  if (input === null) return { json: "null", value: null };
  if (typeof input === "string" || typeof input === "boolean") {
    return { json: JSON.stringify(input), value: input };
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return invalidEnvelope(`${path} contains a non-finite number`);
    return { json: JSON.stringify(input), value: Object.is(input, -0) ? 0 : input };
  }
  if (typeof input !== "object") {
    return invalidEnvelope(`${path} contains a non-JSON-safe ${typeof input} value`);
  }
  if (ancestors.has(input)) return invalidEnvelope(`${path} contains a cycle`);
  ancestors.add(input);
  try {
    if (Array.isArray(input)) {
      if (Object.getPrototypeOf(input) !== Array.prototype) {
        return invalidEnvelope(`${path} has an unsafe array prototype`);
      }
      const keys = Reflect.ownKeys(input);
      if (
        keys.some(
          (key) =>
            typeof key !== "string" ||
            (key !== "length" && !/^(0|[1-9]\d*)$/u.test(key)),
        )
      ) {
        return invalidEnvelope(`${path} has non-JSON array properties`);
      }
      const values: JsonValue[] = [];
      const json: string[] = [];
      for (let index = 0; index < input.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(input, index)) {
          return invalidEnvelope(`${path} contains a sparse array slot`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          return invalidEnvelope(`${path}[${index}] is not an enumerable data property`);
        }
        const item = canonicalizeJsonValue(descriptor.value, `${path}[${index}]`, ancestors);
        values.push(item.value);
        json.push(item.json);
      }
      return { json: `[${json.join(",")}]`, value: Object.freeze(values) as JsonValue[] };
    }

    if (!isSafeRecord(input)) {
      return invalidEnvelope(`${path} has an unsafe prototype, symbol key, or accessor`);
    }
    const output: Record<string, JsonValue> = {};
    const json: string[] = [];
    for (const key of Object.keys(input).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !("value" in descriptor)) {
        return invalidEnvelope(`${path}.${key} is not a data property`);
      }
      const item = canonicalizeJsonValue(descriptor.value, `${path}.${key}`, ancestors);
      Object.defineProperty(output, key, {
        configurable: false,
        enumerable: true,
        value: item.value,
        writable: false,
      });
      json.push(`${JSON.stringify(key)}:${item.json}`);
    }
    return { json: `{${json.join(",")}}`, value: Object.freeze(output) };
  } finally {
    ancestors.delete(input);
  }
}

function canonicalizeJson(input: unknown, path: string): CanonicalJson {
  return canonicalizeJsonValue(input, path, new WeakSet<object>());
}

function sha256(canonicalJson: string): string {
  return createHash("sha256").update(canonicalJson, "utf8").digest("hex");
}

function validatedBinding(value: unknown): InboundBridgeBinding {
  const record = exactRecord("binding", value, [
    "organizationId",
    "cellId",
    "sessionGeneration",
  ]);
  return Object.freeze({
    organizationId: requiredString("organizationId", record.organizationId),
    cellId: requiredString("cellId", record.cellId),
    sessionGeneration: positiveSafeInteger("sessionGeneration", record.sessionGeneration),
  });
}

function validatedInput(value: unknown): ZaloUserInboundInputV1 {
  const record = exactRecord("inbound input", value, [
    "providerEventId",
    "providerMessageId",
    "eventKind",
    "providerConversationId",
    "providerSenderId",
    "providerTarget",
    "providerEventType",
    "sourceTimestamp",
    "callbackReceivedAt",
    "rawEnvelope",
    "normalized",
  ]);
  if (!EVENT_KINDS.has(record.eventKind as ZaloUserInboundEventKindV1)) {
    return invalidEnvelope("eventKind is invalid");
  }
  const target = exactRecord("providerTarget", record.providerTarget, ["kind", "providerId"]);
  if (target.kind !== "PEER" && target.kind !== "SALES_GROUP") {
    return invalidEnvelope("providerTarget.kind is invalid");
  }
  const normalized = exactRecord("normalized", record.normalized, [
    "text",
    "replyToProviderMessageId",
    "media",
  ]);
  if (!Array.isArray(normalized.media)) return invalidEnvelope("normalized.media must be an array");
  const media = normalized.media.map((value, index) => {
    const item = exactRecord(`normalized.media[${index}]`, value, [
      "providerMediaId",
      "kind",
      "mime",
      "byteLength",
      "providerChecksum",
      "fetchRef",
    ]);
    if (!MEDIA_KINDS.has(item.kind as ZaloUserInboundMediaKindV1)) {
      return invalidEnvelope(`normalized.media[${index}].kind is invalid`);
    }
    return Object.freeze({
      providerMediaId: nullableString(`normalized.media[${index}].providerMediaId`, item.providerMediaId),
      kind: item.kind as ZaloUserInboundMediaKindV1,
      mime: nullableString(`normalized.media[${index}].mime`, item.mime),
      byteLength: nullableByteLength(`normalized.media[${index}].byteLength`, item.byteLength),
      providerChecksum: nullableString(
        `normalized.media[${index}].providerChecksum`,
        item.providerChecksum,
      ),
      fetchRef: nullableString(`normalized.media[${index}].fetchRef`, item.fetchRef),
    });
  });
  return Object.freeze({
    providerEventId: nullableString("providerEventId", record.providerEventId),
    providerMessageId: nullableString("providerMessageId", record.providerMessageId),
    eventKind: record.eventKind as ZaloUserInboundEventKindV1,
    providerConversationId: requiredString("providerConversationId", record.providerConversationId),
    providerSenderId: requiredString("providerSenderId", record.providerSenderId),
    providerTarget: Object.freeze({
      kind: target.kind,
      providerId: requiredString("providerTarget.providerId", target.providerId),
    }) as ZaloUserInboundInputV1["providerTarget"],
    providerEventType: requiredString("providerEventType", record.providerEventType),
    sourceTimestamp: canonicalTimestamp("sourceTimestamp", record.sourceTimestamp),
    callbackReceivedAt: canonicalTimestamp("callbackReceivedAt", record.callbackReceivedAt),
    rawEnvelope: record.rawEnvelope,
    normalized: Object.freeze({
      text: nullableString("normalized.text", normalized.text),
      replyToProviderMessageId: nullableString(
        "normalized.replyToProviderMessageId",
        normalized.replyToProviderMessageId,
      ),
      media: Object.freeze(media),
    }),
  });
}

export function buildZaloUserInboundEnvelopeV1(
  bindingValue: InboundBridgeBinding,
  accountIdValue: string,
  inputValue: ZaloUserInboundInputV1,
): ZaloUserInboundEnvelopeV1 {
  const binding = validatedBinding(bindingValue);
  const accountId = requiredString("accountId", accountIdValue);
  const input = validatedInput(inputValue);
  const rawEnvelope = canonicalizeJson(input.rawEnvelope, "rawEnvelope");
  const mediaManifest = input.normalized.media.map((item, index) => Object.freeze({
    version: 1 as const,
    index,
    providerMediaId: item.providerMediaId,
    kind: item.kind,
    mime: item.mime,
    byteLength: item.byteLength,
    providerChecksum: item.providerChecksum,
    fetchRef: item.fetchRef,
    byteState: "PENDING" as const,
  }));
  const normalizedValue: ZaloUserInboundEnvelopeV1["normalized"] = Object.freeze({
    text: input.normalized.text,
    replyToProviderMessageId: input.normalized.replyToProviderMessageId,
    mediaManifest: Object.freeze(mediaManifest),
  });
  const normalized = canonicalizeJson(normalizedValue, "normalized");

  return Object.freeze({
    version: 1,
    organizationId: binding.organizationId,
    accountId,
    cellId: binding.cellId,
    sessionGeneration: binding.sessionGeneration,
    providerEventId: input.providerEventId,
    providerMessageId: input.providerMessageId,
    eventKind: input.eventKind,
    providerConversationId: input.providerConversationId,
    providerSenderId: input.providerSenderId,
    providerTarget: input.providerTarget,
    providerEventType: input.providerEventType,
    sourceTimestamp: input.sourceTimestamp,
    callbackReceivedAt: input.callbackReceivedAt,
    rawEnvelope: rawEnvelope.value,
    rawEnvelopeSha256: sha256(rawEnvelope.json),
    normalized: normalizedValue,
    normalizedSha256: sha256(normalized.json),
  });
}

function invalidAcknowledgement(): never {
  throw new InboundBridgeInvalidAcknowledgementError();
}

function validateAcknowledgement(value: unknown): InboundBridgeAcknowledgementV1 {
  if (!isSafeRecord(value) || value.version !== 1 || typeof value.status !== "string") {
    return invalidAcknowledgement();
  }
  if (value.status === "committed") {
    if (!hasExactKeys(value, ["version", "status", "durability"])) {
      return invalidAcknowledgement();
    }
    const durability = value.durability;
    if (
      !isSafeRecord(durability) ||
      !hasExactKeys(durability, ["journalMode", "synchronous"]) ||
      durability.journalMode !== "WAL" ||
      durability.synchronous !== "FULL"
    ) {
      return invalidAcknowledgement();
    }
    return Object.freeze({
      version: 1,
      status: "committed",
      durability: Object.freeze({ journalMode: "WAL", synchronous: "FULL" }),
    });
  }
  if (value.status === "duplicate" || value.status === "collision") {
    if (!hasExactKeys(value, ["version", "status"])) return invalidAcknowledgement();
    return Object.freeze({ version: 1, status: value.status });
  }
  return invalidAcknowledgement();
}

export function installInboundBridgeCommitter(optionsValue: Readonly<{
  binding: InboundBridgeBinding;
  committer: InboundBridgeCommitter;
}>): () => void {
  const options = exactRecord("inbound bridge installation", optionsValue, ["binding", "committer"]);
  if (typeof options.committer !== "function") throw new TypeError("committer must be a function");
  const installation = Object.freeze({
    binding: validatedBinding(options.binding),
    committer: options.committer as InboundBridgeCommitter,
  });
  installedInboundBridge = installation;
  return () => {
    if (installedInboundBridge === installation) installedInboundBridge = undefined;
  };
}

export async function commitInboundThroughBridge(
  accountId: string,
  input: ZaloUserInboundInputV1,
): Promise<InboundCommitResult> {
  const installation = installedInboundBridge;
  if (!installation) throw new InboundBridgeUnavailableError();
  const envelope = buildZaloUserInboundEnvelopeV1(installation.binding, accountId, input);
  const acknowledgement = validateAcknowledgement(await installation.committer(envelope));
  if (acknowledgement.status === "collision") throw new InboundIdCollisionError();
  return Object.freeze({ envelope, status: acknowledgement.status });
}

export async function commitAndDispatchInbound(
  accountId: string,
  input: ZaloUserInboundInputV1,
  dispatch: (envelope: ZaloUserInboundEnvelopeV1) => Promise<void>,
): Promise<DuplicateInboundResult | Readonly<{
  envelope: ZaloUserInboundEnvelopeV1;
  status: "dispatched";
}>> {
  if (typeof dispatch !== "function") throw new TypeError("dispatch must be a function");
  const result = await commitInboundThroughBridge(accountId, input);
  if (result.status === "duplicate") return result;
  await dispatch(result.envelope);
  return Object.freeze({ envelope: result.envelope, status: "dispatched" });
}

export function createDurableInboundListener(optionsValue: Readonly<{
  accountId: string;
  dispatch(envelope: ZaloUserInboundEnvelopeV1): Promise<void>;
}>): (input: ZaloUserInboundInputV1) => ReturnType<typeof commitAndDispatchInbound> {
  const options = exactRecord("durable inbound listener options", optionsValue, ["accountId", "dispatch"]);
  const accountId = requiredString("accountId", options.accountId);
  if (typeof options.dispatch !== "function") throw new TypeError("dispatch must be a function");
  const dispatch = options.dispatch as (envelope: ZaloUserInboundEnvelopeV1) => Promise<void>;
  return async (input) => await commitAndDispatchInbound(accountId, input, dispatch);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function invokeVoidProviderCallback(
  callback: () => void | Promise<void>,
  failListener: (error: Error) => void,
): void {
  if (typeof callback !== "function") throw new TypeError("callback must be a function");
  if (typeof failListener !== "function") throw new TypeError("failListener must be a function");
  let pending: void | Promise<void>;
  try {
    pending = callback();
  } catch (error) {
    failListener(toError(error));
    return;
  }
  void Promise.resolve(pending).catch((error: unknown) => {
    failListener(toError(error));
  });
}

export function captureProviderCallbackReceivedAt(): string {
  return new Date().toISOString();
}

export function isInboundControlContent(content: unknown): boolean {
  if (!content || typeof content !== "object") return false;
  const kind = (content as Record<string, unknown>).kind;
  return kind === "typing" || kind === "seen" || kind === "delivery-receipt";
}
