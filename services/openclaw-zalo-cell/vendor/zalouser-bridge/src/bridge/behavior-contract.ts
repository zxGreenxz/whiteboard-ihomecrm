import {
  commitAndDispatchInbound,
  ensureInboundBridgeReady,
  installInboundBridgeCommitter,
  type DuplicateInboundResult,
  type ZaloUserInboundEnvelopeV1,
  type ZaloUserInboundInputV1,
} from "./inbound-listener.js";
import {
  installControlRuntime,
  invokeAuthorizedControl,
  type ControlTraffic,
} from "./control-traffic.js";
import { installPrivateOutboundRuntime } from "./outbound-rpc.js";
import type { BridgeRuntimeBindingV1 } from "./protocol.js";
import {
  createProductionBridgeRuntime,
  createProductionControlRuntime,
  createProductionInboundBridge,
} from "./runtime-bootstrap.js";
import type { PreparedProviderCallV1 } from "./send-context.js";

export type BehaviorContractProviderRuntimeV1 = Readonly<{
  prepareSession(accountProfile: string): unknown | Promise<unknown>;
  send(
    call: PreparedProviderCallV1,
    materializedMedia?: Buffer,
    preparedSession?: unknown,
  ): Promise<{ providerMessageId?: string }>;
}>;

export type BehaviorContractRuntimeV1Options = Readonly<{
  binding: BridgeRuntimeBindingV1;
  bridgeBaseUrl: string;
  bridgeSecret: Uint8Array;
  gatewayDeviceId: string;
  now(): number;
  nonce(): string;
  bridgeFetch(url: string, init: RequestInit): Promise<Response>;
  providerRuntime: BehaviorContractProviderRuntimeV1;
}>;

export type BehaviorContractRuntimeV1 = Readonly<{
  readyInbound(accountId: string): Promise<void>;
  commitInboundAndDispatch(
    accountId: string,
    input: ZaloUserInboundInputV1,
    dispatch: (envelope: ZaloUserInboundEnvelopeV1) => Promise<void>,
  ): Promise<DuplicateInboundResult | Readonly<{
    envelope: ZaloUserInboundEnvelopeV1;
    status: "dispatched";
  }>>;
  invokeControl(
    frame: ControlTraffic,
    providerCall: (frame: ControlTraffic) => Promise<void>,
  ): Promise<void>;
  close(): void;
}>;

export function installBehaviorContractRuntimeV1(
  options: BehaviorContractRuntimeV1Options,
): BehaviorContractRuntimeV1 {
  if (!options || typeof options !== "object") {
    throw new TypeError("behavior contract options are required");
  }
  if (typeof options.bridgeFetch !== "function") {
    throw new TypeError("bridgeFetch must be a function");
  }
  if (!options.providerRuntime || typeof options.providerRuntime !== "object") {
    throw new TypeError("providerRuntime is required");
  }
  const shared = Object.freeze({
    binding: options.binding,
    bridgeBaseUrl: options.bridgeBaseUrl,
    bridgeSecret: options.bridgeSecret,
    fetch: options.bridgeFetch,
    now: options.now,
    nonce: options.nonce,
  });
  const cleanups: Array<() => void> = [];
  try {
    cleanups.push(installInboundBridgeCommitter(createProductionInboundBridge(shared)));
    cleanups.push(installControlRuntime(createProductionControlRuntime(shared)));
    cleanups.push(installPrivateOutboundRuntime(createProductionBridgeRuntime({
      ...shared,
      gatewayDeviceId: options.gatewayDeviceId,
      loadProviderSender: async () => options.providerRuntime,
    })));
  } catch (error) {
    for (const cleanup of cleanups.reverse()) cleanup();
    throw error;
  }

  let closed = false;
  return Object.freeze({
    readyInbound: async (accountId) => await ensureInboundBridgeReady(accountId),
    commitInboundAndDispatch: async (accountId, input, dispatch) =>
      await commitAndDispatchInbound(accountId, input, dispatch),
    invokeControl: async (frame, providerCall) =>
      await invokeAuthorizedControl(frame, providerCall),
    close() {
      if (closed) return;
      closed = true;
      for (const cleanup of cleanups.reverse()) cleanup();
    },
  });
}
