#!/usr/bin/env node

import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALLOWED_CONTROL_RPCS,
  PRIVATE_SEND_RPC,
  hashCanonicalSendPayload,
  type CellRpcTransport,
} from "../adapters/zalouser-bridge-rpc-adapter.js";
import {
  parseOutboundAuthorizationMarker,
  snapshotCanonicalSendPayload,
  type CanonicalSendPayloadV1,
  type OutboxAuthorizeSendRequestV1,
} from "../runtime-api/schemas.js";
import { FakeZaloAdapter } from "../testing/fake-zalo-adapter.js";

interface FakeCellOptions {
  provider: FakeZaloAdapter;
  authorizeSend(
    authorization: OutboxAuthorizeSendRequestV1,
    payload: CanonicalSendPayloadV1,
  ): Promise<{ authorized: boolean }>;
  agentResult?: unknown;
}

function exactRequest(value: unknown): {
  payload: CanonicalSendPayloadV1;
  authorization: OutboxAuthorizeSendRequestV1;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new TypeError("private send request is invalid"), { code: "PRIVATE_SEND_INVALID" });
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "authorization,payload,version" ||
    record.version !== 1 || !record.authorization || typeof record.authorization !== "object" ||
    Array.isArray(record.authorization)
  ) throw Object.assign(new TypeError("private send request is invalid"), { code: "PRIVATE_SEND_INVALID" });
  const authorization = record.authorization as Record<string, unknown>;
  if (
    Object.keys(authorization).sort().join(",") !== "authorizationMarker,claimToken,version" ||
    authorization.version !== 1 || typeof authorization.claimToken !== "string" ||
    authorization.claimToken.length === 0
  ) throw Object.assign(new TypeError("private send authorization is invalid"), { code: "PRIVATE_SEND_INVALID" });
  const payload = snapshotCanonicalSendPayload(record.payload);
  const marker = parseOutboundAuthorizationMarker(authorization.authorizationMarker);
  if (marker.payloadHash !== hashCanonicalSendPayload(payload)) {
    throw Object.assign(new Error("private send payload hash mismatch"), {
      code: "MARKER_PAYLOAD_MISMATCH",
      authorizedHandoffRecorded: false,
    });
  }
  return {
    payload,
    authorization: {
      version: 1,
      claimToken: authorization.claimToken,
      authorizationMarker: marker,
    },
  };
}

export function createFakeCellTransport(options: FakeCellOptions): CellRpcTransport & {
  close(): Promise<void>;
} {
  let running = true;
  return Object.freeze({
    async invoke(method: string, params: unknown): Promise<unknown> {
      if (method === "send") {
        throw Object.assign(new Error("generic send is forbidden"), { code: "GENERIC_SEND_FORBIDDEN" });
      }
      if (method === PRIVATE_SEND_RPC) {
        const request = exactRequest(params);
        let authorization: { authorized: boolean };
        try {
          // This is deliberately the final awaited operation before the first
          // provider call below.
          authorization = await options.authorizeSend(request.authorization, request.payload);
        } catch {
          throw Object.assign(new Error("private send authorization failed"), {
            code: "AUTHORIZATION_DENIED",
            authorizedHandoffRecorded: false,
          });
        }
        if (!authorization.authorized) {
          throw Object.assign(new Error("private send authorization denied"), {
            code: "AUTHORIZATION_DENIED",
            authorizedHandoffRecorded: false,
          });
        }

        const knownProviderMessageIds: string[] = [];
        for (const [index, part] of request.payload.parts.entries()) {
          const result = await options.provider.emitFakeOutcome({
            version: 1,
            target: request.payload.target,
            accountProfile: request.payload.accountProfile,
            idempotencyKey: request.payload.idempotencyKey,
            part,
          });
          if (result.outcome === "SUCCESS") {
            if (result.providerMessageId !== null) knownProviderMessageIds.push(result.providerMessageId);
            continue;
          }
          if (result.outcome === "PROVIDER_REJECT" && index === 0) {
            return {
              status: "FAILED",
              reasonCode: "PROVIDER_REJECTED_BEFORE_ACCEPT",
              totalPartCount: request.payload.parts.length,
              possibleHandoffPrefixLength: 0,
              knownProviderMessageIds: [],
              receipts: [],
            };
          }
          return {
            status: "UNKNOWN",
            reasonCode: result.outcome === "AMBIGUOUS_TIMEOUT"
              ? "PROVIDER_TIMEOUT_AFTER_POSSIBLE_HANDOFF"
              : "ACK_LOST_AFTER_HANDOFF",
            totalPartCount: request.payload.parts.length,
            possibleHandoffPrefixLength: Math.max(1, result.outcome === "AMBIGUOUS_TIMEOUT" ? index + 1 : index),
            knownProviderMessageIds,
            receipts: knownProviderMessageIds.map((providerMessageId) => ({ providerMessageId })),
          };
        }
        return {
          status: "SENT",
          reasonCode: "ALL_PARTS_ACKNOWLEDGED",
          totalPartCount: request.payload.parts.length,
          possibleHandoffPrefixLength: request.payload.parts.length,
          knownProviderMessageIds,
          receipts: knownProviderMessageIds.map((providerMessageId) => ({ providerMessageId })),
        };
      }

      if (!(ALLOWED_CONTROL_RPCS as readonly string[]).includes(method)) {
        throw Object.assign(new Error("cell RPC method is forbidden"), { code: "CONTROL_RPC_FORBIDDEN" });
      }
      switch (method) {
        case "channels.status":
          return { version: 1, running, connected: running };
        case "channels.start":
          running = true;
          return { version: 1, running };
        case "channels.stop":
        case "channels.logout":
          running = false;
          return { version: 1, running };
        case "web.login.start":
          return await options.provider.requestQr();
        case "web.login.wait":
          return { version: 1, status: running ? "CONNECTED" : "PENDING" };
        case "agent":
          return options.agentResult ?? {
            version: 1,
            classification: "OTHER",
            disposition: "NO_SEND",
            draftText: "",
            confidence: 1,
            knowledgeChunkIds: [],
          };
      }
    },
    async close(): Promise<void> {
      running = false;
    },
  });
}

export async function startFakeCellProcess(options: {
  host?: string;
  port?: number;
  transport?: ReturnType<typeof createFakeCellTransport>;
} = {}): Promise<{ server: Server; host: string; port: number }> {
  const transport = options.transport ?? createFakeCellTransport({
    provider: new FakeZaloAdapter({
      qrPayload: "fake-cell-qr",
      directory: [],
      inbound: [],
      sendOutcomes: [],
    }),
    // Standalone fake process is fail-closed. Tests must inject an explicit
    // authorizer to exercise provider outcomes.
    authorizeSend: async () => ({ authorized: false }),
  });
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/rpc") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end('{"error":"NOT_FOUND"}');
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += value.byteLength;
        if (bytes > 512 * 1024) throw new Error("fake cell request is too large");
        chunks.push(value);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const result = await transport.invoke(String(body.method), body.params);
      const payload = JSON.stringify({ version: 1, result });
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        "cache-control": "no-store",
      });
      response.end(payload);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" });
      response.end('{"error":"RPC_FAILED"}');
    });
  });
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen({ host, port, exclusive: true }, () => resolvePromise());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake cell failed to bind");
  return { server, host, port: address.port };
}

function isDirectInvocation(): boolean {
  return process.argv[1] !== undefined &&
    resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isDirectInvocation()) {
  void startFakeCellProcess({
    host: process.env.OPENCLAW_FAKE_CELL_HOST ?? "127.0.0.1",
    port: Number(process.env.OPENCLAW_FAKE_CELL_PORT ?? "0"),
  }).then(({ host, port }) => {
    console.log(JSON.stringify({ event: "fake_cell_listening", host, port }));
  }, () => {
    console.error(JSON.stringify({ event: "fake_cell_start_failed" }));
    process.exitCode = 1;
  });
}
