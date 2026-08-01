import { AsyncLocalStorage } from "node:async_hooks";
import {
  businessFramesFromPayload,
  providerSinkFromPayload,
  snapshotZaloUserBridgeSendParams,
  type ZaloUserBridgeSendParamsV1,
} from "./canonical-send.js";
import {
  createPreparedOutboundBatch,
  hashProviderBatch,
  snapshotPreparedOutboundBatch,
  snapshotPreparedProviderCall,
  snapshotProviderSink,
  type PreparedOutboundBatchV1,
  type PreparedProviderCallV1,
  type ProviderSinkV1,
} from "./send-context.js";

const PRIVATE_SEND_METHOD = "zalouser.bridge.send";
const PRIVATE_RPC_REQUIRED = "PRIVATE_RPC_REQUIRED";

export type PrivateBridgeSendRequestV1 = ZaloUserBridgeSendParamsV1;

export type PreparedPrivateOutboundExecutionV1 = Readonly<{
  batch: PreparedOutboundBatchV1;
  sendPrepared(call: PreparedProviderCallV1): Promise<{ providerMessageId?: string }>;
}>;

export type PrivateOutboundRuntime = Readonly<{
  assertClient(client: unknown): Promise<void>;
  assertAuthorizationCurrent(request: PrivateBridgeSendRequestV1): void;
  prepare(request: PrivateBridgeSendRequestV1): Promise<PreparedPrivateOutboundExecutionV1>;
  authorize(
    request: PrivateBridgeSendRequestV1,
    batch: PreparedOutboundBatchV1,
  ): Promise<void>;
}>;

type GatewayRequest = Readonly<{
  client: unknown;
  params: PrivateBridgeSendRequestV1;
  respond(ok: boolean, payload?: unknown, error?: unknown): void;
}>;

type GatewayApi = Readonly<{
  registerGatewayMethod(
    method: string,
    handler: (request: unknown) => Promise<void>,
    options: Readonly<{ scope: string }>,
  ): void;
}>;

type AuthorizedProviderScope = {
  readonly expected: PreparedProviderCallV1;
  readonly assertAuthorizationCurrent: (() => void) | undefined;
  wrapperChecked: boolean;
  providerIoEntered: boolean;
};

type ProviderReceiptV1 = Readonly<{ providerMessageId: string }>;
type UnknownReasonCodeV1 =
  | "PROVIDER_TIMEOUT_AFTER_POSSIBLE_HANDOFF"
  | "PROVIDER_DISCONNECT_AFTER_POSSIBLE_HANDOFF"
  | "ACK_LOST_AFTER_HANDOFF";

let privateOutboundRuntime: PrivateOutboundRuntime | undefined;
const authorizedProviderScope = new AsyncLocalStorage<AuthorizedProviderScope>();
const provenPreHandoffFailures = new WeakSet<object>();

function failure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function privateRpcRequired(): Error & { code: string } {
  return failure(PRIVATE_RPC_REQUIRED, "business sends require the private bridge RPC");
}

function provenPreHandoffFailure(error: unknown): Error & {
  code: string;
  authorizedHandoffRecorded: false;
} {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : undefined;
  const marked = Object.assign(
    new Error(error instanceof Error ? error.message : String(error), { cause: error }),
    {
      code: typeof record?.code === "string" ? record.code : "AUTHORIZATION_BARRIER_FAILED",
      authorizedHandoffRecorded: false as const,
    },
  );
  provenPreHandoffFailures.add(marked);
  return marked;
}

export function isProvenPreHandoffFailure(error: unknown): boolean {
  return !!error && typeof error === "object" && provenPreHandoffFailures.has(error);
}

function snapshotRequest(value: unknown): PrivateBridgeSendRequestV1 {
  return snapshotZaloUserBridgeSendParams(value);
}

function snapshotPreparedExecution(value: unknown): PreparedPrivateOutboundExecutionV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw failure("INVALID_PROVIDER_BATCH", "prepared execution must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== 2 ||
    !keys.includes("batch") ||
    !keys.includes("sendPrepared")
  ) {
    throw failure("INVALID_PROVIDER_BATCH", "prepared execution has an invalid shape");
  }
  const batchDescriptor = Object.getOwnPropertyDescriptor(value, "batch");
  const sendDescriptor = Object.getOwnPropertyDescriptor(value, "sendPrepared");
  if (
    !batchDescriptor?.enumerable || !("value" in batchDescriptor) ||
    !sendDescriptor?.enumerable || !("value" in sendDescriptor) ||
    typeof sendDescriptor.value !== "function"
  ) {
    throw failure("INVALID_PROVIDER_BATCH", "prepared execution must use data properties");
  }
  return Object.freeze({
    batch: snapshotPreparedOutboundBatch(batchDescriptor.value),
    sendPrepared: sendDescriptor.value as PreparedPrivateOutboundExecutionV1["sendPrepared"],
  });
}

function callsEqual(left: PreparedProviderCallV1, right: PreparedProviderCallV1): boolean {
  return hashProviderBatch(Object.freeze([left])) === hashProviderBatch(Object.freeze([right]));
}

function sinksEqual(left: ProviderSinkV1, right: ProviderSinkV1): boolean {
  return (
    left.accountId === right.accountId &&
    left.accountProfile === right.accountProfile &&
    left.conversationId === right.conversationId &&
    left.isGroup === right.isGroup
  );
}

function providerMessageId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, "providerMessageId");
  if (!descriptor || !("value" in descriptor)) return undefined;
  return typeof descriptor.value === "string" && descriptor.value.trim() !== ""
    ? descriptor.value
    : undefined;
}

function unknownReason(error: unknown): UnknownReasonCodeV1 {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : undefined;
  const evidence = `${typeof record?.code === "string" ? record.code : ""} ${
    error instanceof Error ? error.message : String(error ?? "")
  }`.toLowerCase();
  if (/timeout|timedout|abort/u.test(evidence)) {
    return "PROVIDER_TIMEOUT_AFTER_POSSIBLE_HANDOFF";
  }
  if (/disconnect|closed|econn|epipe|socket|network/u.test(evidence)) {
    return "PROVIDER_DISCONNECT_AFTER_POSSIBLE_HANDOFF";
  }
  return "ACK_LOST_AFTER_HANDOFF";
}

function unknownResult(
  receipts: readonly ProviderReceiptV1[],
  totalPartCount: number,
  possibleHandoffPrefixLength: number,
  reasonCode: UnknownReasonCodeV1,
) {
  const retainedReceipts = Object.freeze([...receipts]);
  return Object.freeze({
    knownProviderMessageIds: Object.freeze(retainedReceipts.map(({ providerMessageId }) => providerMessageId)),
    possibleHandoffPrefixLength,
    reasonCode,
    receipts: retainedReceipts,
    status: "UNKNOWN" as const,
    totalPartCount,
  });
}

export function assertAuthorizedProviderCall(actualValue: PreparedProviderCallV1): void {
  const scope = authorizedProviderScope.getStore();
  if (!scope) throw privateRpcRequired();
  if (scope.wrapperChecked) {
    throw failure("AUTHORIZED_PROVIDER_CALL_REPLAY", "authorized provider call was already checked");
  }
  let actual: PreparedProviderCallV1;
  try {
    actual = snapshotPreparedProviderCall(actualValue);
  } catch {
    throw failure("AUTHORIZED_PROVIDER_CALL_MISMATCH", "provider call is malformed");
  }
  if (!callsEqual(actual, scope.expected)) {
    throw failure("AUTHORIZED_PROVIDER_CALL_MISMATCH", "provider call does not match authorization");
  }
  scope.wrapperChecked = true;
}

export function assertAuthorizedProviderIo(actualSinkValue: ProviderSinkV1): void {
  const scope = authorizedProviderScope.getStore();
  if (!scope || !scope.wrapperChecked) throw privateRpcRequired();
  if (scope.providerIoEntered) {
    throw failure("AUTHORIZED_PROVIDER_IO_REPLAY", "provider I/O was already entered for this call");
  }
  let actualSink: ProviderSinkV1;
  try {
    actualSink = snapshotProviderSink(actualSinkValue);
  } catch {
    throw failure("AUTHORIZED_PROVIDER_SINK_MISMATCH", "provider sink is malformed");
  }
  if (!sinksEqual(actualSink, scope.expected.sink)) {
    throw failure("AUTHORIZED_PROVIDER_SINK_MISMATCH", "provider sink does not match authorization");
  }
  if (scope.assertAuthorizationCurrent) {
    try {
      scope.assertAuthorizationCurrent();
    } catch (error) {
      throw provenPreHandoffFailure(error);
    }
  }
  scope.providerIoEntered = true;
}

async function invokePreparedCall(
  call: PreparedProviderCallV1,
  sendPrepared: PreparedPrivateOutboundExecutionV1["sendPrepared"],
  assertAuthorizationCurrent?: () => void,
): Promise<
  | Readonly<{ ok: true; receipt: { providerMessageId?: string } }>
  | Readonly<{ ok: false; error: unknown; possibleHandoff: boolean }>
> {
  const scope: AuthorizedProviderScope = {
    expected: call,
    assertAuthorizationCurrent,
    wrapperChecked: false,
    providerIoEntered: false,
  };
  return await authorizedProviderScope.run(scope, async () => {
    try {
      const receipt = await sendPrepared(call);
      if (!scope.wrapperChecked || !scope.providerIoEntered) throw privateRpcRequired();
      return Object.freeze({ ok: true as const, receipt });
    } catch (error) {
      return Object.freeze({
        ok: false as const,
        error,
        possibleHandoff: scope.providerIoEntered && !isProvenPreHandoffFailure(error),
      });
    }
  });
}

export function createPrivateOutboundRpc(options: Pick<
  PrivateOutboundRuntime,
  "prepare" | "authorize"
> & Partial<Pick<PrivateOutboundRuntime, "assertAuthorizationCurrent">>) {
  if (
    !options ||
    typeof options.prepare !== "function" ||
    typeof options.authorize !== "function" ||
    (options.assertAuthorizationCurrent !== undefined &&
      typeof options.assertAuthorizationCurrent !== "function")
  ) {
    throw new TypeError("prepare and authorize must be functions");
  }
  return Object.freeze({
    async invoke(method: string, requestValue: PrivateBridgeSendRequestV1) {
      if (method !== PRIVATE_SEND_METHOD) throw privateRpcRequired();
      const request = snapshotRequest(requestValue);
      const sink = providerSinkFromPayload(request.payload);
      const frames = businessFramesFromPayload(request.payload);
      const expected = createPreparedOutboundBatch(sink, frames);
      const execution = snapshotPreparedExecution(await options.prepare(request));
      if (execution.batch.batchSha256 !== expected.batchSha256) {
        throw failure("INVALID_PROVIDER_BATCH", "prepared batch differs from the private request");
      }
      await options.authorize(request, execution.batch);
      const receipts: ProviderReceiptV1[] = [];
      const totalPartCount = execution.batch.calls.length;
      for (const call of execution.batch.calls) {
        const result = await invokePreparedCall(
          call,
          execution.sendPrepared,
          options.assertAuthorizationCurrent === undefined
            ? undefined
            : () => options.assertAuthorizationCurrent?.(request),
        );
        if (!result.ok) {
          if (result.possibleHandoff || receipts.length > 0) {
            return unknownResult(
              receipts,
              totalPartCount,
              receipts.length + (result.possibleHandoff ? 1 : 0),
              unknownReason(result.error),
            );
          }
          throw result.error;
        }
        const messageId = providerMessageId(result.receipt);
        if (!messageId || receipts.some(({ providerMessageId }) => providerMessageId === messageId)) {
          return unknownResult(
            receipts,
            totalPartCount,
            receipts.length + 1,
            "ACK_LOST_AFTER_HANDOFF",
          );
        }
        receipts.push(Object.freeze({ providerMessageId: messageId }));
      }
      const retainedReceipts = Object.freeze([...receipts]);
      return Object.freeze({
        knownProviderMessageIds: Object.freeze(retainedReceipts.map(({ providerMessageId }) => providerMessageId)),
        possibleHandoffPrefixLength: totalPartCount,
        reasonCode: "ALL_PARTS_ACKNOWLEDGED" as const,
        receipts: retainedReceipts,
        status: "SENT" as const,
        totalPartCount,
      });
    },
  });
}

export function installPrivateOutboundRuntime(runtime: PrivateOutboundRuntime): () => void {
  if (privateOutboundRuntime) {
    throw failure(
      "PRIVATE_OUTBOUND_RUNTIME_ALREADY_INSTALLED",
      "a private outbound runtime is already installed",
    );
  }
  privateOutboundRuntime = runtime;
  return () => {
    if (privateOutboundRuntime === runtime) privateOutboundRuntime = undefined;
  };
}

export function registerPrivateOutboundRpc(
  api: GatewayApi,
  method: typeof PRIVATE_SEND_METHOD = PRIVATE_SEND_METHOD,
): void {
  if (method !== PRIVATE_SEND_METHOD) throw privateRpcRequired();
  api.registerGatewayMethod(
    method,
    async (request) => {
      try {
        const gatewayRequest = request as GatewayRequest;
        const runtime = privateOutboundRuntime;
        if (!runtime) throw privateRpcRequired();
        await runtime.assertClient(gatewayRequest.client);
        const rpc = createPrivateOutboundRpc(runtime);
        gatewayRequest.respond(true, await rpc.invoke(method, gatewayRequest.params));
      } catch (error) {
        const errorRecord = error && typeof error === "object"
          ? error as Record<string, unknown>
          : undefined;
        const message = error instanceof Error ? error.message : String(error);
        const preHandoff = isProvenPreHandoffFailure(error);
        (request as GatewayRequest).respond(false, undefined, {
          code: typeof errorRecord?.code === "string" ? errorRecord.code : "PRIVATE_RPC_FAILED",
          message,
          ...(preHandoff ? { authorizedHandoffRecorded: false as const } : {}),
        });
      }
    },
    { scope: "operator.write" },
  );
}

export { PRIVATE_SEND_METHOD };
