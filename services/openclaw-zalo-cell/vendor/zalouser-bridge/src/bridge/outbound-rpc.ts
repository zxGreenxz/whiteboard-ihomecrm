import { AsyncLocalStorage } from "node:async_hooks";
import {
  createPreparedOutboundBatch,
  hashProviderBatch,
  snapshotBusinessFrames,
  snapshotPreparedOutboundBatch,
  snapshotPreparedProviderCall,
  snapshotProviderSink,
  snapshotSendContext,
  type BusinessFrame,
  type PreparedOutboundBatchV1,
  type PreparedProviderCallV1,
  type ProviderSinkV1,
  type SendContext,
} from "./send-context.js";

const PRIVATE_SEND_METHOD = "zalouser.bridge.send";
const PRIVATE_RPC_REQUIRED = "PRIVATE_RPC_REQUIRED";

export type PrivateBridgeSendRequestV1 = Readonly<{
  context: SendContext;
  sink: ProviderSinkV1;
  frames: readonly BusinessFrame[];
}>;

export type PrivateOutboundRuntime = Readonly<{
  assertClient(client: unknown): Promise<void>;
  prepare(request: PrivateBridgeSendRequestV1): Promise<PreparedOutboundBatchV1>;
  authorize(
    request: PrivateBridgeSendRequestV1,
    batch: PreparedOutboundBatchV1,
  ): Promise<void>;
  sendPrepared(call: PreparedProviderCallV1): Promise<{ providerMessageId?: string }>;
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
  wrapperChecked: boolean;
  providerIoEntered: boolean;
};

let privateOutboundRuntime: PrivateOutboundRuntime | undefined;
const authorizedProviderScope = new AsyncLocalStorage<AuthorizedProviderScope>();

function failure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function privateRpcRequired(): Error & { code: string } {
  return failure(PRIVATE_RPC_REQUIRED, "business sends require the private bridge RPC");
}

function snapshotExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    return undefined;
  }
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

function snapshotRequest(value: unknown): PrivateBridgeSendRequestV1 {
  const record = snapshotExactRecord(value, ["context", "sink", "frames"]);
  if (!record) throw failure("INVALID_PRIVATE_SEND_REQUEST", "invalid private send request");
  const context = snapshotSendContext(record.context);
  const sink = snapshotProviderSink(record.sink);
  const frames = snapshotBusinessFrames(record.frames);
  if (
    context.accountId !== sink.accountId ||
    context.accountProfile !== sink.accountProfile ||
    context.conversationId !== sink.conversationId ||
    context.isGroup !== sink.isGroup
  ) {
    throw failure("INVALID_SEND_CONTEXT", "send context sink does not match request sink");
  }
  return Object.freeze({ context, sink, frames });
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
  scope.providerIoEntered = true;
}

async function invokePreparedCall(
  call: PreparedProviderCallV1,
  sendPrepared: PrivateOutboundRuntime["sendPrepared"],
): Promise<
  | Readonly<{ ok: true; receipt: { providerMessageId?: string } }>
  | Readonly<{ ok: false; error: unknown; possibleHandoff: boolean }>
> {
  const scope: AuthorizedProviderScope = {
    expected: call,
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
        possibleHandoff: scope.providerIoEntered,
      });
    }
  });
}

export function createPrivateOutboundRpc(options: Pick<
  PrivateOutboundRuntime,
  "prepare" | "authorize" | "sendPrepared"
>) {
  if (
    !options ||
    typeof options.prepare !== "function" ||
    typeof options.authorize !== "function" ||
    typeof options.sendPrepared !== "function"
  ) {
    throw new TypeError("prepare, authorize, and sendPrepared must be functions");
  }
  return Object.freeze({
    async invoke(method: string, requestValue: PrivateBridgeSendRequestV1) {
      if (method !== PRIVATE_SEND_METHOD) throw privateRpcRequired();
      const request = snapshotRequest(requestValue);
      const expected = createPreparedOutboundBatch(request.sink, request.frames);
      const prepared = snapshotPreparedOutboundBatch(await options.prepare(request));
      if (prepared.batchSha256 !== expected.batchSha256) {
        throw failure("INVALID_PROVIDER_BATCH", "prepared batch differs from the private request");
      }
      if (request.context.batchSha256 !== prepared.batchSha256) {
        throw failure("INVALID_SEND_CONTEXT", "send context batch differs from prepared calls");
      }
      await options.authorize(request, prepared);
      const receipts: Array<{ providerMessageId?: string }> = [];
      for (const call of prepared.calls) {
        const result = await invokePreparedCall(call, options.sendPrepared);
        if (!result.ok) {
          if (result.possibleHandoff || receipts.length > 0) {
            return Object.freeze({ receipts: Object.freeze(receipts), status: "UNKNOWN" as const });
          }
          throw result.error;
        }
        receipts.push(result.receipt);
      }
      return Object.freeze({ receipts: Object.freeze(receipts), status: "SENT" as const });
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
        (request as GatewayRequest).respond(false, undefined, {
          code: typeof errorRecord?.code === "string" ? errorRecord.code : "PRIVATE_RPC_FAILED",
          message,
        });
      }
    },
    { scope: "operator.write" },
  );
}

export { PRIVATE_SEND_METHOD };
