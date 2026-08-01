import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createHash } from "node:crypto";
import type { Socket } from "node:net";

import { liveness, type Readiness } from "../health/snapshot.js";
import {
  InboundEnvelopeError,
  InboundBindingError,
  InboundIntakeStoppedError,
  type InboundController,
} from "./inbound-controller.js";
import {
  LocalCellAuthenticationError,
  LocalCellAuthenticator,
  type LocalCellBindingV1,
} from "./local-cell-protocol.js";
import {
  parseOutboundAuthorizationMarker,
  type OutboxAuthorizeSendRequestV1,
} from "../runtime-api/schemas.js";

export interface BridgeServerOptions {
  readiness: () => Readiness;
  localCell?: {
    secret: Uint8Array;
    binding: LocalCellBindingV1;
    inbound: Pick<InboundController, "ready" | "commit">;
    authorizeSend(request: OutboxAuthorizeSendRequestV1): Promise<void>;
    authorizeControl?(request: LocalControlTrafficV1): Promise<void>;
    materializeMedia?(request: LocalMediaMaterializeRequestV1): Promise<LocalMediaMaterializeResponseV1>;
    now?: () => number;
  };
}

export type LocalControlTrafficV1 =
  | {
      version: 1;
      kind: "typing";
      sink: { accountProfile: string; conversationId: string; isGroup: boolean };
    }
  | {
      version: 1;
      kind: "seen";
      sink: { accountProfile: string; conversationId: string; isGroup: boolean };
      message: LocalControlMessageV1;
    }
  | {
      version: 1;
      kind: "delivery-receipt";
      sink: { accountProfile: string; conversationId: string; isGroup: boolean };
      message: LocalControlMessageV1;
      isSeen: boolean;
    };

interface LocalControlMessageV1 {
  msgId: string;
  cliMsgId: string;
  uidFrom: string;
  idTo: string;
  msgType: string;
  st: number;
  at: number;
  cmd: number;
  ts: string | number;
}

export interface LocalMediaMaterializeRequestV1 {
  version: 1;
  objectKey: string;
  sha256: string;
  mime: string;
  bytes: number;
}

export interface LocalMediaMaterializeResponseV1 extends LocalMediaMaterializeRequestV1 {
  contentBase64: string;
}

export interface BridgeListenAddress {
  host: string;
  port: number;
}

const RESPONSE_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
} as const;
const MAX_INBOUND_BYTES = 256 * 1024;
const serverConnections = new WeakMap<Server, Set<Socket>>();

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...RESPONSE_HEADERS,
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function requestPath(request: IncomingMessage): string | null {
  try {
    const target = new URL(request.url ?? "/", "http://bridge.invalid");
    return target.search.length === 0 ? target.pathname : "";
  } catch {
    return null;
  }
}

function isReadiness(value: unknown): value is Readiness {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return ["inboundReady", "outboundReady", "aiReady", "heartbeatStale"]
    .every((key) => typeof candidate[key] === "boolean");
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    if (!/^(?:0|[1-9]\d*)$/u.test(declared) || Number(declared) > MAX_INBOUND_BYTES) {
      throw Object.assign(new Error("request body is too large"), { code: "BODY_TOO_LARGE" });
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_INBOUND_BYTES) {
      throw Object.assign(new Error("request body is too large"), { code: "BODY_TOO_LARGE" });
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

function methodNotAllowed(response: ServerResponse, allowed: string): void {
  response.setHeader("allow", allowed);
  writeJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
}

function authorization(value: unknown): OutboxAuthorizeSendRequestV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("outbox authorization is invalid");
  }
  const request = value as Record<string, unknown>;
  if (
    Object.keys(request).sort().join(",") !== "authorizationMarker,claimToken,version" ||
    request.version !== 1 || typeof request.claimToken !== "string" ||
    request.claimToken.length < 32 || request.claimToken.length > 512
  ) throw new TypeError("outbox authorization is invalid");
  return {
    version: 1,
    claimToken: request.claimToken,
    authorizationMarker: parseOutboundAuthorizationMarker(request.authorizationMarker),
  };
}

function exactRecord(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InboundEnvelopeError(`${name} is invalid`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new InboundEnvelopeError(`${name} fields are invalid`);
  }
  return record;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InboundEnvelopeError(`${name} is invalid`);
  }
  return value.trim();
}

function controlSink(value: unknown): LocalControlTrafficV1["sink"] {
  const sink = exactRecord(value, ["accountProfile", "conversationId", "isGroup"], "control sink");
  if (typeof sink.isGroup !== "boolean") throw new InboundEnvelopeError("control sink is invalid");
  return {
    accountProfile: requiredString(sink.accountProfile, "control account profile"),
    conversationId: requiredString(sink.conversationId, "control conversation id"),
    isGroup: sink.isGroup,
  };
}

function controlMessage(value: unknown): LocalControlMessageV1 {
  const message = exactRecord(value, [
    "msgId", "cliMsgId", "uidFrom", "idTo", "msgType", "st", "at", "cmd", "ts",
  ], "control message");
  for (const field of ["st", "at", "cmd"] as const) {
    if (!Number.isSafeInteger(message[field])) throw new InboundEnvelopeError("control message is invalid");
  }
  if (!(
    (typeof message.ts === "string" && message.ts.trim().length > 0) ||
    (typeof message.ts === "number" && Number.isSafeInteger(message.ts))
  )) throw new InboundEnvelopeError("control message is invalid");
  return {
    msgId: requiredString(message.msgId, "control msgId"),
    cliMsgId: requiredString(message.cliMsgId, "control cliMsgId"),
    uidFrom: requiredString(message.uidFrom, "control uidFrom"),
    idTo: requiredString(message.idTo, "control idTo"),
    msgType: requiredString(message.msgType, "control msgType"),
    st: message.st as number,
    at: message.at as number,
    cmd: message.cmd as number,
    ts: typeof message.ts === "string" ? message.ts.trim() : message.ts,
  };
}

function controlTraffic(value: unknown): LocalControlTrafficV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InboundEnvelopeError("control traffic is invalid");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw new InboundEnvelopeError("control traffic is invalid");
  if (record.kind === "typing") {
    exactRecord(value, ["version", "kind", "sink"], "typing control traffic");
    return { version: 1, kind: "typing", sink: controlSink(record.sink) };
  }
  if (record.kind === "seen") {
    exactRecord(value, ["version", "kind", "sink", "message"], "seen control traffic");
    return { version: 1, kind: "seen", sink: controlSink(record.sink), message: controlMessage(record.message) };
  }
  if (record.kind === "delivery-receipt") {
    exactRecord(value, ["version", "kind", "sink", "message", "isSeen"], "delivery control traffic");
    if (typeof record.isSeen !== "boolean") throw new InboundEnvelopeError("delivery control traffic is invalid");
    return {
      version: 1,
      kind: "delivery-receipt",
      sink: controlSink(record.sink),
      message: controlMessage(record.message),
      isSeen: record.isSeen,
    };
  }
  throw new InboundEnvelopeError("control traffic kind is invalid");
}

function mediaMaterializeRequest(value: unknown): LocalMediaMaterializeRequestV1 {
  const request = exactRecord(value, ["version", "objectKey", "sha256", "mime", "bytes"], "media materialize request");
  if (
    request.version !== 1 || typeof request.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(request.sha256) ||
    !Number.isSafeInteger(request.bytes) || (request.bytes as number) < 1 ||
    (request.bytes as number) > 32 * 1024 * 1024
  ) throw new InboundEnvelopeError("media materialize request is invalid");
  return {
    version: 1,
    objectKey: requiredString(request.objectKey, "media object key"),
    sha256: request.sha256,
    mime: requiredString(request.mime, "media MIME"),
    bytes: request.bytes as number,
  };
}

function mediaMaterializeResponse(
  value: unknown,
  request: LocalMediaMaterializeRequestV1,
): LocalMediaMaterializeResponseV1 {
  const response = exactRecord(
    value,
    ["version", "objectKey", "sha256", "mime", "bytes", "contentBase64"],
    "media materialize response",
  );
  if (
    response.version !== request.version || response.objectKey !== request.objectKey ||
    response.sha256 !== request.sha256 || response.mime !== request.mime || response.bytes !== request.bytes ||
    typeof response.contentBase64 !== "string"
  ) throw new Error("materialized media metadata mismatch");
  const bytes = Buffer.from(response.contentBase64, "base64");
  if (
    bytes.byteLength !== request.bytes || bytes.toString("base64") !== response.contentBase64 ||
    createHash("sha256").update(bytes).digest("hex") !== request.sha256
  ) throw new Error("materialized media bytes mismatch");
  return { ...request, contentBase64: response.contentBase64 };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: BridgeServerOptions,
  localCellAuthenticator: LocalCellAuthenticator | null,
): Promise<void> {
  const path = requestPath(request);
  if (path === null) {
    writeJson(response, 400, { error: "BAD_REQUEST" });
    return;
  }

  if (path === "/livez") {
    if (request.method !== "GET") return methodNotAllowed(response, "GET");
    writeJson(response, 200, liveness());
    return;
  }

  if (path === "/readyz") {
    if (request.method !== "GET") return methodNotAllowed(response, "GET");
    try {
      const readiness = options.readiness();
      if (!isReadiness(readiness)) {
        writeJson(response, 503, { error: "READINESS_UNAVAILABLE" });
        return;
      }
      writeJson(response, readiness.inboundReady ? 200 : 503, readiness);
    } catch {
      writeJson(response, 503, { error: "READINESS_UNAVAILABLE" });
    }
    return;
  }

  const localOperation = path === "/v1/zalouser/ready"
    ? "inbound.ready"
    : path === "/v1/zalouser/inbound/commit"
      ? "inbound.commit"
      : path === "/v1/outbox/authorize-send"
        ? "outbox.authorize-send"
        : path === "/v1/zalouser/control/authorize"
          ? "control.authorize"
          : path === "/v1/zalouser/media/materialize"
            ? "media.materialize"
        : null;
  if (localOperation !== null && options.localCell !== undefined && localCellAuthenticator !== null) {
    if (request.method !== "POST") return methodNotAllowed(response, "POST");
    const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      writeJson(response, 415, { error: "UNSUPPORTED_MEDIA_TYPE" });
      return;
    }
    try {
      const body = await readRequestBody(request);
      let value: unknown;
      try {
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(body);
        value = JSON.parse(decoded);
      } catch {
        writeJson(response, 400, { error: "INVALID_INBOUND_ENVELOPE" });
        return;
      }
      const authenticated = localCellAuthenticator.verify(value, localOperation);
      let result: unknown;
      if (localOperation === "inbound.ready") {
        if (!authenticated.body || typeof authenticated.body !== "object" ||
          Array.isArray(authenticated.body) ||
          Object.keys(authenticated.body as Record<string, unknown>).join(",") !== "version" ||
          (authenticated.body as Record<string, unknown>).version !== 1) {
          throw new InboundEnvelopeError("readiness body is invalid");
        }
        if (!options.localCell.inbound.ready()) {
          writeJson(response, 503, { error: "INBOUND_NOT_READY" });
          return;
        }
        result = { version: 1, status: "READY" };
      } else if (localOperation === "inbound.commit") {
        result = options.localCell.inbound.commit(authenticated.body, authenticated.binding);
      } else if (localOperation === "outbox.authorize-send") {
        await options.localCell.authorizeSend(authorization(authenticated.body));
        result = { version: 1, status: "AUTHORIZED" };
      } else if (localOperation === "control.authorize") {
        if (options.localCell.authorizeControl === undefined) throw new Error("control authorization is unavailable");
        await options.localCell.authorizeControl(controlTraffic(authenticated.body));
        result = { version: 1, status: "AUTHORIZED" };
      } else {
        if (options.localCell.materializeMedia === undefined) throw new Error("media materialization is unavailable");
        const request = mediaMaterializeRequest(authenticated.body);
        result = mediaMaterializeResponse(await options.localCell.materializeMedia(request), request);
      }
      writeJson(response, 200, localCellAuthenticator.response(authenticated, result));
    } catch (error) {
      if (error instanceof LocalCellAuthenticationError || error instanceof InboundBindingError) {
        writeJson(response, 401, { error: "UNAUTHORIZED" });
      } else if (error instanceof InboundEnvelopeError) {
        writeJson(response, 400, { error: "INVALID_INBOUND_ENVELOPE" });
      } else if (error instanceof InboundIntakeStoppedError) {
        writeJson(response, 503, { error: "INBOUND_INTAKE_STOPPED" });
      } else if ((error as { code?: unknown } | null)?.code === "BODY_TOO_LARGE") {
        writeJson(response, 413, { error: "PAYLOAD_TOO_LARGE" });
      } else {
        writeJson(response, 500, { error: "INBOUND_COMMIT_FAILED" });
      }
    }
    return;
  }

  writeJson(response, 404, { error: "NOT_FOUND" });
}

/** Minimal, content-free health surface for the channel bridge process. */
export function createBridgeServer(options: BridgeServerOptions): Server {
  const localCellAuthenticator = options.localCell === undefined
    ? null
    : new LocalCellAuthenticator({
      secret: options.localCell.secret,
      binding: options.localCell.binding,
      now: options.localCell.now,
    });
  const server = createServer((request, response) => {
    void handleRequest(request, response, options, localCellAuthenticator).catch(() => {
      if (!response.headersSent) writeJson(response, 500, { error: "INTERNAL_ERROR" });
      else response.destroy();
    });
  });
  const connections = new Set<Socket>();
  serverConnections.set(server, connections);
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  return server;
}

export function listenBridgeServer(
  server: Server,
  address: BridgeListenAddress,
): Promise<BridgeListenAddress> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const bound = server.address();
      if (bound === null || typeof bound === "string") {
        reject(new Error("Bridge server did not bind a TCP address"));
        return;
      }
      resolve({ host: address.host, port: bound.port });
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: address.host, port: address.port, exclusive: true });
  });
}

export function closeBridgeServer(
  server: Server,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  if (!server.listening) return Promise.resolve();
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    return Promise.reject(new RangeError("bridge close timeout is invalid"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      for (const socket of serverConnections.get(server) ?? []) {
        if (typeof socket.resetAndDestroy === "function") socket.resetAndDestroy();
        else socket.destroy();
      }
      server.closeAllConnections?.();
      setTimeout(finish, 0);
    }, timeoutMs);
    server.close((error) => {
      finish(error ?? undefined);
    });
    server.closeIdleConnections?.();
  });
}
