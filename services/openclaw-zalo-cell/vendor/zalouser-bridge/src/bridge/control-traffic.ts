import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

export type ControlSinkV1 = Readonly<{
  accountProfile: string;
  conversationId: string;
  isGroup: boolean;
}>;

export type ExactDeliveryMessageRefV1 = Readonly<{
  msgId: string;
  cliMsgId: string;
  uidFrom: string;
  idTo: string;
  msgType: string;
  st: number;
  at: number;
  cmd: number;
  ts: string | number;
}>;

export type TypingControlV1 = Readonly<{
  version: 1;
  kind: "typing";
  sink: ControlSinkV1;
}>;

export type SeenControlV1 = Readonly<{
  version: 1;
  kind: "seen";
  sink: ControlSinkV1;
  message: ExactDeliveryMessageRefV1;
}>;

export type DeliveryReceiptControlV1 = Readonly<{
  version: 1;
  kind: "delivery-receipt";
  sink: ControlSinkV1;
  message: ExactDeliveryMessageRefV1;
  isSeen: boolean;
}>;

export type ControlTraffic = TypingControlV1 | SeenControlV1 | DeliveryReceiptControlV1;

export type ControlRuntime = Readonly<{
  authorize(frame: ControlTraffic): Promise<void>;
  providerTimeoutMs: number;
}>;

type AuthorizedControlScope = {
  expectedSha256: string;
  providerIoEntered: boolean;
};

let installedControlRuntime: ControlRuntime | undefined;
const authorizedControlScope = new AsyncLocalStorage<AuthorizedControlScope>();

function fail(message: string): never {
  throw Object.assign(new Error(message), { code: "INVALID_CONTROL_TRAFFIC" });
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

function hasExactKeys(record: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function exactRecord(
  name: string,
  value: unknown,
  expected: readonly string[],
): Readonly<Record<string, unknown>> {
  const record = snapshotDataRecord(value);
  if (!record || !hasExactKeys(record, expected)) {
    return fail(`${name} must contain exactly: ${expected.join(", ")}`);
  }
  return record;
}

function requiredString(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return fail(`${name} is required`);
  return value.trim();
}

function requiredInteger(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value)) return fail(`${name} must be a safe integer`);
  return value as number;
}

function projectSink(value: unknown): ControlSinkV1 {
  const record = exactRecord("control sink", value, [
    "accountProfile",
    "conversationId",
    "isGroup",
  ]);
  if (typeof record.isGroup !== "boolean") return fail("control sink isGroup must be boolean");
  return Object.freeze({
    accountProfile: requiredString("control sink accountProfile", record.accountProfile),
    conversationId: requiredString("control sink conversationId", record.conversationId),
    isGroup: record.isGroup,
  });
}

function projectMessage(value: unknown): ExactDeliveryMessageRefV1 {
  const record = exactRecord("control message", value, [
    "msgId",
    "cliMsgId",
    "uidFrom",
    "idTo",
    "msgType",
    "st",
    "at",
    "cmd",
    "ts",
  ]);
  const ts = record.ts;
  if (
    !(
      (typeof ts === "string" && ts.trim() !== "") ||
      (typeof ts === "number" && Number.isSafeInteger(ts))
    )
  ) {
    return fail("control message ts must be a non-empty string or safe integer");
  }
  return Object.freeze({
    msgId: requiredString("control message msgId", record.msgId),
    cliMsgId: requiredString("control message cliMsgId", record.cliMsgId),
    uidFrom: requiredString("control message uidFrom", record.uidFrom),
    idTo: requiredString("control message idTo", record.idTo),
    msgType: requiredString("control message msgType", record.msgType),
    st: requiredInteger("control message st", record.st),
    at: requiredInteger("control message at", record.at),
    cmd: requiredInteger("control message cmd", record.cmd),
    ts: typeof ts === "string" ? ts.trim() : ts,
  });
}

export function classifyControlTraffic(candidate: unknown): ControlTraffic {
  const record = snapshotDataRecord(candidate);
  if (!record || record.version !== 1 || typeof record.kind !== "string") {
    return fail("control traffic must be an exact version 1 object");
  }
  if (record.kind === "typing") {
    if (!hasExactKeys(record, ["version", "kind", "sink"])) {
      return fail("typing control traffic has unexpected fields");
    }
    return Object.freeze({ version: 1, kind: "typing", sink: projectSink(record.sink) });
  }
  if (record.kind === "seen") {
    if (!hasExactKeys(record, ["version", "kind", "sink", "message"])) {
      return fail("seen control traffic has unexpected fields");
    }
    return Object.freeze({
      version: 1,
      kind: "seen",
      sink: projectSink(record.sink),
      message: projectMessage(record.message),
    });
  }
  if (record.kind === "delivery-receipt") {
    if (!hasExactKeys(record, ["version", "kind", "sink", "message", "isSeen"])) {
      return fail("delivery receipt control traffic has unexpected fields");
    }
    if (typeof record.isSeen !== "boolean") {
      return fail("delivery receipt isSeen must be boolean");
    }
    return Object.freeze({
      version: 1,
      kind: "delivery-receipt",
      sink: projectSink(record.sink),
      message: projectMessage(record.message),
      isSeen: record.isSeen,
    });
  }
  return fail("unknown control traffic kind");
}

export function createControlTrafficSender(options: {
  sendControl(frame: ControlTraffic): Promise<void>;
}) {
  if (!options || typeof options.sendControl !== "function") {
    throw new TypeError("sendControl must be a function");
  }
  return async (candidate: unknown) => {
    const frame = classifyControlTraffic(candidate);
    await options.sendControl(frame);
  };
}

function controlSha256(frame: ControlTraffic): string {
  return createHash("sha256").update(JSON.stringify(frame), "utf8").digest("hex");
}

function controlFailure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function installControlRuntime(runtime: ControlRuntime): () => void {
  if (
    !runtime || typeof runtime.authorize !== "function" ||
    !Number.isSafeInteger(runtime.providerTimeoutMs) || runtime.providerTimeoutMs <= 0 ||
    runtime.providerTimeoutMs > 5_000
  ) {
    throw new TypeError("control runtime is invalid");
  }
  if (installedControlRuntime) {
    throw controlFailure("CONTROL_RUNTIME_ALREADY_INSTALLED", "a control runtime is already installed");
  }
  installedControlRuntime = Object.freeze({
    authorize: runtime.authorize,
    providerTimeoutMs: runtime.providerTimeoutMs,
  });
  const installed = installedControlRuntime;
  return () => {
    if (installedControlRuntime === installed) installedControlRuntime = undefined;
  };
}

export function assertAuthorizedControlIo(frameValue: unknown): void {
  const scope = authorizedControlScope.getStore();
  if (!scope) throw controlFailure("CONTROL_AUTHORIZATION_REQUIRED", "control provider I/O is unauthorized");
  if (scope.providerIoEntered) {
    throw controlFailure("CONTROL_PROVIDER_IO_REPLAY", "control provider I/O was already entered");
  }
  const frame = classifyControlTraffic(frameValue);
  if (controlSha256(frame) !== scope.expectedSha256) {
    throw controlFailure("CONTROL_AUTHORIZATION_MISMATCH", "control provider frame differs from authorization");
  }
  scope.providerIoEntered = true;
}

export async function invokeAuthorizedControl(
  frameValue: unknown,
  provider: (frame: ControlTraffic) => Promise<void>,
): Promise<void> {
  const runtime = installedControlRuntime;
  if (!runtime) throw controlFailure("CONTROL_RUNTIME_UNAVAILABLE", "control runtime is unavailable");
  if (typeof provider !== "function") throw new TypeError("provider must be a function");
  const frame = classifyControlTraffic(frameValue);
  await runtime.authorize(frame);
  const scope: AuthorizedControlScope = {
    expectedSha256: controlSha256(frame),
    providerIoEntered: false,
  };
  await authorizedControlScope.run(scope, async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        provider(frame),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(controlFailure("CONTROL_PROVIDER_TIMEOUT", "control provider call timed out"));
          }, runtime.providerTimeoutMs);
        }),
      ]);
      if (!scope.providerIoEntered) {
        throw controlFailure("CONTROL_PROVIDER_BOUNDARY_MISSING", "control provider bypassed its I/O guard");
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  });
}
