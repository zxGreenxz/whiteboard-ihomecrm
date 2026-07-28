import { AsyncLocalStorage } from "node:async_hooks";
import type { BusinessFrame, SendContext } from "./send-context.js";

const PRIVATE_SEND_METHOD = "zalouser.bridge.send";
const PRIVATE_RPC_REQUIRED = "PRIVATE_RPC_REQUIRED";

type PrivateOutboundRuntime = Readonly<{
  assertClient(client: unknown): Promise<void>;
  authorize(context: SendContext, frames: readonly BusinessFrame[]): Promise<void>;
  sendFrame(frame: BusinessFrame): Promise<{ providerMessageId?: string }>;
}>;

type GatewayRequest = Readonly<{
  client: unknown;
  params: Readonly<{ context: SendContext; frames: readonly BusinessFrame[] }>;
  respond(ok: boolean, payload?: unknown, error?: unknown): void;
}>;

type GatewayApi = Readonly<{
  registerGatewayMethod(
    method: string,
    handler: (request: unknown) => Promise<void>,
    options: Readonly<{ scope: string }>,
  ): void;
}>;

let privateOutboundRuntime: PrivateOutboundRuntime | undefined;
const privateRpcFrame = new AsyncLocalStorage<BusinessFrame>();

function privateRpcRequired(): Error & { code: string } {
  return Object.assign(new Error("business sends require the private bridge RPC"), {
    code: PRIVATE_RPC_REQUIRED,
  });
}

export function createPrivateOutboundRpc(options: {
  authorize(context: SendContext, frames: readonly BusinessFrame[]): Promise<void>;
  sendFrame(frame: BusinessFrame): Promise<{ providerMessageId?: string }>;
}) {
  return Object.freeze({
    async invoke(
      method: string,
      request: Readonly<{ context: SendContext; frames: readonly BusinessFrame[] }>,
    ) {
      if (method !== PRIVATE_SEND_METHOD) {
        throw privateRpcRequired();
      }
      if (!Array.isArray(request.frames) || request.frames.length === 0) {
        throw Object.assign(new Error("provider batch is empty"), {
          code: "INVALID_PROVIDER_BATCH",
        });
      }
      await options.authorize(request.context, request.frames);
      const receipts = [];
      for (const frame of request.frames) {
        try {
          receipts.push(await options.sendFrame(frame));
        } catch {
          return { receipts, status: "UNKNOWN" as const };
        }
      }
      return { receipts, status: "SENT" as const };
    },
  });
}

export function installPrivateOutboundRuntime(runtime: PrivateOutboundRuntime): () => void {
  privateOutboundRuntime = runtime;
  return () => {
    if (privateOutboundRuntime === runtime) privateOutboundRuntime = undefined;
  };
}

export function requirePrivateRpcContext(
  _frame?: BusinessFrame,
  expectedCode: typeof PRIVATE_RPC_REQUIRED = PRIVATE_RPC_REQUIRED,
): void {
  if (expectedCode !== PRIVATE_RPC_REQUIRED) throw privateRpcRequired();
  if (!privateRpcFrame.getStore()) throw privateRpcRequired();
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
        const rpc = createPrivateOutboundRpc({
          authorize: runtime.authorize,
          sendFrame: async (frame) =>
            await privateRpcFrame.run(frame, async () => await runtime.sendFrame(frame)),
        });
        gatewayRequest.respond(true, await rpc.invoke(method, gatewayRequest.params));
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        (request as GatewayRequest).respond(false, undefined, {
          code: "code" in failure ? failure.code : "PRIVATE_RPC_FAILED",
          message: failure.message,
        });
      }
    },
    { scope: "operator.write" },
  );
}

export { PRIVATE_SEND_METHOD };
