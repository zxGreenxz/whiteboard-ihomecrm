// One route, one method, one ticket. Everything the service will do for anyone
// is `PUT /v1/object` with a ticket the control plane signed; there is no
// listing, no delete, no read-back and no unauthenticated path.

import { randomUUID, webcrypto } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { ObjectStore } from "./storage.js";
import {
  decodeTicket,
  mediaIdFromObjectKey,
  signReceipt,
  UploadRejected,
  verifyBytes,
  verifyTicket,
} from "./upload.js";

export interface GatewayDependencies {
  store: ObjectStore;
  ticketPublicKeyEs256: webcrypto.CryptoKey;
  ticketKeyGeneration: number;
  receiptSigningKey: webcrypto.CryptoKey;
  receiptKeyGeneration: number;
  maxContentLength: number;
  now?: () => Date;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(payload.byteLength),
    "cache-control": "no-store",
  });
  response.end(payload);
}

function writeError(response: ServerResponse, status: number, code: string): void {
  writeJson(response, status, { error: { code } });
}

/**
 * Reads at most `limit` bytes. A body that exceeds the length the ticket
 * committed to is abandoned mid-stream rather than buffered and then judged.
 */
async function readBody(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > limit) throw new UploadRejected(413, "CONTENT_TOO_LARGE", "upload exceeds the ticket length");
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}

export function createGatewayHandler(dependencies: GatewayDependencies) {
  const clock = dependencies.now ?? (() => new Date());

  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://media.invalid");
      if (url.pathname === "/healthz" && request.method === "GET") {
        writeJson(response, 200, { status: "ok" });
        return;
      }
      if (url.pathname !== "/v1/object") {
        writeError(response, 404, "NOT_FOUND");
        return;
      }
      if (request.method === "DELETE") {
        // Retention deletes are authorized by the control plane and carried out
        // by the maintenance runner against this route. That path is not built
        // yet, and it is answered distinctly rather than as "method not allowed"
        // so a retention run fails as an unimplemented capability instead of
        // looking like a gateway that never accepted deletes by design.
        writeError(response, 501, "RETENTION_DELETE_NOT_IMPLEMENTED");
        return;
      }
      if (request.method !== "PUT") {
        response.setHeader("allow", "PUT");
        writeError(response, 405, "METHOD_NOT_ALLOWED");
        return;
      }
      if (url.search !== "") {
        writeError(response, 400, "QUERY_NOT_ALLOWED");
        return;
      }

      const header = request.headers["x-openclaw-media-ticket"];
      if (typeof header !== "string" || header.length === 0) {
        writeError(response, 401, "TICKET_MISSING");
        return;
      }

      const ticket = await verifyTicket({
        ticket: decodeTicket(header),
        ticketPublicKeyEs256: dependencies.ticketPublicKeyEs256,
        ticketKeyGeneration: dependencies.ticketKeyGeneration,
        receiptKeyGeneration: dependencies.receiptKeyGeneration,
        now: clock(),
      });

      if (ticket.contentLength > dependencies.maxContentLength) {
        writeError(response, 413, "CONTENT_TOO_LARGE");
        return;
      }
      // The declared header has to agree with the ticket before a byte is read.
      const declared = request.headers["content-length"];
      if (declared !== undefined && Number(declared) !== ticket.contentLength) {
        writeError(response, 400, "CONTENT_LENGTH_MISMATCH");
        return;
      }

      const bytes = await readBody(request, ticket.contentLength);
      verifyBytes(ticket, bytes);

      const mediaId = mediaIdFromObjectKey(ticket.objectKey);
      const stored = await dependencies.store.put(ticket.objectKey, bytes, ticket.sha256);
      const receipt = await signReceipt({
        ticket,
        mediaId,
        receiptId: randomUUID(),
        objectVersionOrEtag: stored.objectVersionOrEtag,
        storedAt: clock(),
        receiptSigningKey: dependencies.receiptSigningKey,
      });
      writeJson(response, stored.reused ? 200 : 201, receipt);
    } catch (error) {
      if (error instanceof UploadRejected) {
        writeError(response, error.status, error.code);
        return;
      }
      writeError(response, 500, "INTERNAL_ERROR");
    }
  };
}
