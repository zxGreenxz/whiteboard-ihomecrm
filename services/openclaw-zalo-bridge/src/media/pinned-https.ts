import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";

import type { InboundMediaFetchOptions } from "./inbound-fetch.js";

type HttpsRequest = typeof httpsRequest;

function addressFamily(address: string): 4 | 6 {
  return address.includes(":") ? 6 : 4;
}

/**
 * Opens HTTPS only through the address the policy has already accepted. The
 * SNI/servername remains the original host, so certificate validation is not
 * weakened by DNS pinning.
 */
export function createPinnedHttpsRequest(options: {
  request?: HttpsRequest;
  timeoutMs?: number;
} = {}): InboundMediaFetchOptions["request"] {
  const request = options.request ?? httpsRequest;
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new RangeError("pinned HTTPS timeout is invalid");
  }
  return async ({ url, pinnedAddress, signal }) => await new Promise<Response>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };
    const pending = request({
      protocol: "https:",
      hostname: url.hostname,
      port: 443,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { accept: "*/*", "accept-encoding": "identity", host: url.host },
      servername: url.hostname,
      rejectUnauthorized: true,
      lookup: (_hostname, _lookupOptions, callback) => callback(null, pinnedAddress, addressFamily(pinnedAddress)),
    }, (response: IncomingMessage) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) headers.set(name, value.join(", "));
        else if (value !== undefined) headers.set(name, String(value));
      }
      settle(() => resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
        status: response.statusCode ?? 502,
        headers,
      })));
    });
    const abort = () => pending.destroy(new Error("pinned HTTPS request aborted"));
    if (signal?.aborted) {
      abort();
      reject(new Error("pinned HTTPS request aborted"));
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    pending.setTimeout?.(timeoutMs, () => pending.destroy(new Error("pinned HTTPS request timed out")));
    pending.once("error", (error) => settle(() => reject(error)));
    pending.end();
  });
}
