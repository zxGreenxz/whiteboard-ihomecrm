import {
  createZaloUserBridgeRpcAdapter,
  type CellRpcTransport,
  type ControlRpc,
} from "./zalouser-bridge-rpc-adapter.js";
import type {
  CanonicalSendPayloadV1,
  OutboxAuthorizeSendRequestV1,
} from "../runtime-api/schemas.js";
import { canonicalJson } from "../spool/checksum.js";

export interface ClosableCellRpcTransport extends CellRpcTransport {
  close?(): Promise<void> | void;
}

export interface ChannelAdapter {
  sendBusiness(
    payload: CanonicalSendPayloadV1,
    authorization: OutboxAuthorizeSendRequestV1,
  ): Promise<unknown>;
  control(method: ControlRpc, params: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export class CellRpcError extends Error {
  readonly code: string;
  readonly authorizedHandoffRecorded?: false;

  constructor(code: string, options: { preHandoff?: boolean } = {}) {
    super("cell RPC request failed");
    this.name = "CellRpcError";
    this.code = code;
    if (options.preHandoff) this.authorizedHandoffRecorded = false;
  }
}

export function createHttpCellRpcTransport(options: {
  url: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}): ClosableCellRpcTransport {
  const url = new URL(options.url);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password ||
    url.search || url.hash || url.pathname !== "/rpc"
  ) throw new TypeError("cell RPC URL is invalid");
  const request = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new RangeError("cell RPC timeout is invalid");
  }
  const controllers = new Set<AbortController>();
  let closed = false;
  return Object.freeze({
    async invoke(method: string, params: unknown): Promise<unknown> {
      if (closed) throw new CellRpcError("CELL_RPC_CLOSED", { preHandoff: true });
      if (typeof method !== "string" || method.length === 0 || method.length > 128) {
        throw new CellRpcError("CELL_RPC_METHOD_INVALID", { preHandoff: true });
      }
      const body = canonicalJson({ version: 1, method, params });
      const controller = new AbortController();
      controllers.add(controller);
      const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: controller.signal,
        });
      } catch {
        throw new CellRpcError("CELL_RPC_TRANSPORT_FAILED");
      } finally {
        globalThis.clearTimeout(timer);
        controllers.delete(controller);
      }
      if (!response.ok) throw new CellRpcError("CELL_RPC_REJECTED");
      if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
        throw new CellRpcError("CELL_RPC_RESPONSE_INVALID");
      }
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new CellRpcError("CELL_RPC_RESPONSE_INVALID");
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new CellRpcError("CELL_RPC_RESPONSE_INVALID");
      }
      const envelope = value as Record<string, unknown>;
      if (
        Object.keys(envelope).sort().join(",") !== "result,version" ||
        envelope.version !== 1
      ) throw new CellRpcError("CELL_RPC_RESPONSE_INVALID");
      return envelope.result;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    },
  });
}

/**
 * Canonical bridge-to-cell surface. Business traffic has one named method and
 * one underlying private RPC; no generic send or provider-frame API is exposed.
 */
export function createChannelAdapter(transport: ClosableCellRpcTransport): Readonly<ChannelAdapter> {
  const rpc = createZaloUserBridgeRpcAdapter(transport);
  return Object.freeze({
    async sendBusiness(
      payload: CanonicalSendPayloadV1,
      authorization: OutboxAuthorizeSendRequestV1,
    ): Promise<unknown> {
      return await rpc.send(payload, authorization);
    },
    async control(method: ControlRpc, params: unknown): Promise<unknown> {
      return await rpc.control(method, params);
    },
    async close(): Promise<void> {
      await transport.close?.();
    },
  });
}
