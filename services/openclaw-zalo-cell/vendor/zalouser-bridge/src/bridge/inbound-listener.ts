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

export type InboundBridgeReady = (
  accountId: string,
  binding: InboundBridgeBinding,
) => Promise<void>;

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
  ready: InboundBridgeReady;
  commitTimeoutMs: number;
  readinessTimeoutMs: number;
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

export class InboundBridgeAlreadyInstalledError extends Error {
  readonly code = "INBOUND_BRIDGE_ALREADY_INSTALLED";

  constructor(message = "an inbound bridge binding is already installed") {
    super(message);
    this.name = "InboundBridgeAlreadyInstalledError";
  }
}

export class InboundBridgeCommitTimeoutError extends Error {
  readonly code = "INBOUND_BRIDGE_COMMIT_TIMEOUT";

  constructor(message = "durable inbound bridge commit timed out") {
    super(message);
    this.name = "InboundBridgeCommitTimeoutError";
  }
}

export class InboundBridgeReadinessTimeoutError extends Error {
  readonly code = "INBOUND_BRIDGE_READINESS_TIMEOUT";

  constructor(message = "inbound bridge readiness check timed out") {
    super(message);
    this.name = "InboundBridgeReadinessTimeoutError";
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
  const snapshot = snapshotDataRecord(value);
  if (!snapshot || !hasExactKeys(snapshot, expectedKeys)) {
    return invalidEnvelope(`${name} must be a plain object with exactly: ${expectedKeys.join(", ")}`);
  }
  return snapshot;
}

function snapshotDataRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return undefined;
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
    Object.defineProperty(snapshot, key, {
      configurable: false,
      enumerable: true,
      value: descriptor.value,
      writable: false,
    });
  }
  return Object.freeze(snapshot);
}

function snapshotDenseArray(name: string, value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return invalidEnvelope(`${name} must be a plain array`);
  }
  const keys = Reflect.ownKeys(value);
  const keySet = new Set(keys);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !lengthDescriptor ||
    !("value" in lengthDescriptor) ||
    lengthDescriptor.enumerable ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    return invalidEnvelope(`${name} has an invalid length`);
  }
  const length = lengthDescriptor.value as number;
  if (keys.length !== length + 1 || !keySet.has("length")) {
    return invalidEnvelope(`${name} must contain exactly its dense indices and length`);
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!keySet.has(key)) return invalidEnvelope(`${name} contains a sparse array slot`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      return invalidEnvelope(`${name}[${index}] is not an enumerable data property`);
    }
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
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
      const snapshot = snapshotDenseArray(path, input);
      const values: JsonValue[] = [];
      const json: string[] = [];
      for (let index = 0; index < snapshot.length; index += 1) {
        const item = canonicalizeJsonValue(snapshot[index], `${path}[${index}]`, ancestors);
        values.push(item.value);
        json.push(item.json);
      }
      return { json: `[${json.join(",")}]`, value: Object.freeze(values) as JsonValue[] };
    }

    const snapshot = snapshotDataRecord(input);
    if (!snapshot) {
      return invalidEnvelope(`${path} has an unsafe prototype, symbol key, or accessor`);
    }
    const output: Record<string, JsonValue> = {};
    const json: string[] = [];
    for (const key of Object.keys(snapshot).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(snapshot, key);
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
  const mediaInput = snapshotDenseArray("normalized.media", normalized.media);
  const media: ZaloUserInboundMediaInputV1[] = [];
  for (let index = 0; index < mediaInput.length; index += 1) {
    const value = mediaInput[index];
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
    media.push(Object.freeze({
      providerMediaId: nullableString(`normalized.media[${index}].providerMediaId`, item.providerMediaId),
      kind: item.kind as ZaloUserInboundMediaKindV1,
      mime: nullableString(`normalized.media[${index}].mime`, item.mime),
      byteLength: nullableByteLength(`normalized.media[${index}].byteLength`, item.byteLength),
      providerChecksum: nullableString(
        `normalized.media[${index}].providerChecksum`,
        item.providerChecksum,
      ),
      fetchRef: nullableString(`normalized.media[${index}].fetchRef`, item.fetchRef),
    }));
  }
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
  const mediaManifest: ZaloUserInboundMediaManifestEntryV1[] = [];
  for (let index = 0; index < input.normalized.media.length; index += 1) {
    const item = input.normalized.media[index];
    if (!item) return invalidEnvelope(`normalized.media[${index}] is missing`);
    mediaManifest.push(Object.freeze({
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
  }
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
  const record = snapshotDataRecord(value);
  if (!record || record.version !== 1 || typeof record.status !== "string") {
    return invalidAcknowledgement();
  }
  if (record.status === "committed") {
    if (!hasExactKeys(record, ["version", "status", "durability"])) {
      return invalidAcknowledgement();
    }
    const durability = snapshotDataRecord(record.durability);
    if (
      !durability ||
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
  if (record.status === "duplicate" || record.status === "collision") {
    if (!hasExactKeys(record, ["version", "status"])) return invalidAcknowledgement();
    return Object.freeze({ version: 1, status: record.status });
  }
  return invalidAcknowledgement();
}

export function installInboundBridgeCommitter(optionsValue: Readonly<{
  binding: InboundBridgeBinding;
  committer: InboundBridgeCommitter;
  ready: InboundBridgeReady;
  commitTimeoutMs: number;
  readinessTimeoutMs: number;
}>): () => void {
  const options = exactRecord("inbound bridge installation", optionsValue, [
    "binding",
    "committer",
    "ready",
    "commitTimeoutMs",
    "readinessTimeoutMs",
  ]);
  if (typeof options.committer !== "function") throw new TypeError("committer must be a function");
  if (typeof options.ready !== "function") throw new TypeError("ready must be a function");
  const commitTimeoutMs = positiveSafeInteger("commitTimeoutMs", options.commitTimeoutMs);
  const readinessTimeoutMs = positiveSafeInteger("readinessTimeoutMs", options.readinessTimeoutMs);
  if (commitTimeoutMs > 6_000) invalidEnvelope("commitTimeoutMs may not exceed 6000");
  if (readinessTimeoutMs > 2_000) invalidEnvelope("readinessTimeoutMs may not exceed 2000");
  const installation = Object.freeze({
    binding: validatedBinding(options.binding),
    committer: options.committer as InboundBridgeCommitter,
    ready: options.ready as InboundBridgeReady,
    commitTimeoutMs,
    readinessTimeoutMs,
  });
  if (installedInboundBridge) throw new InboundBridgeAlreadyInstalledError();
  installedInboundBridge = installation;
  return () => {
    if (installedInboundBridge === installation) installedInboundBridge = undefined;
  };
}

async function withBridgeTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutError: Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(timeoutError), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function ensureInboundBridgeReady(accountIdValue: string): Promise<void> {
  const installation = installedInboundBridge;
  if (!installation) throw new InboundBridgeUnavailableError();
  const accountId = requiredString("accountId", accountIdValue);
  await withBridgeTimeout(
    installation.ready(accountId, installation.binding),
    installation.readinessTimeoutMs,
    new InboundBridgeReadinessTimeoutError(),
  );
}

export async function commitInboundThroughBridge(
  accountId: string,
  input: ZaloUserInboundInputV1,
): Promise<InboundCommitResult> {
  const installation = installedInboundBridge;
  if (!installation) throw new InboundBridgeUnavailableError();
  const envelope = buildZaloUserInboundEnvelopeV1(installation.binding, accountId, input);
  const acknowledgement = validateAcknowledgement(await withBridgeTimeout(
    installation.committer(envelope),
    installation.commitTimeoutMs,
    new InboundBridgeCommitTimeoutError(),
  ));
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
