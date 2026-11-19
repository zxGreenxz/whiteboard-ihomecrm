import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

/** Download only from the recorder origin already validated by cameraConfig.
 * Native HTTP keeps streaming backpressure/abort without Undici's fatal paused
 * parser assertion on recorder FIN (https://github.com/nodejs/undici/issues/5360).
 * Digest authentication remains in DahuaClient; redirects never carry it away.
 */
export function recordingFetch(origin: string): typeof fetch {
  const base = new URL(origin);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.pathname !== "/" || base.search || base.hash) throw new Error("RECORDING_ORIGIN_INVALID");
  return async (input, init) => {
    if (input instanceof Request || init?.method !== "GET" || init.body != null || init.redirect !== "error" || !init.signal) throw new Error("RECORDING_REQUEST_INVALID");
    const url = new URL(String(input));
    if (url.origin !== base.origin || url.username || url.password || url.hash) throw new Error("RECORDING_ORIGIN_INVALID");
    init.signal.throwIfAborted();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
    headers["accept-encoding"] = "identity";
    return new Promise<Response>((resolve, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        method: "GET", headers, agent: false, signal: init.signal!,
      }, (incoming) => {
        const status = incoming.statusCode ?? 502;
        if ((status >= 300 && status < 400) || (incoming.headers["content-encoding"] && incoming.headers["content-encoding"] !== "identity")) {
          incoming.destroy(); reject(new Error("RECORDING_RESPONSE_INVALID")); return;
        }
        try {
          const responseHeaders = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) responseHeaders.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
          // toWeb propagates cancellation, aborted/truncated sockets and bounded
          // backpressure; it does not buffer the whole recording in memory.
          const body = [204, 205, 304].includes(status) ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
          if (!body) incoming.resume();
          resolve(new Response(body, { status, headers: responseHeaders }));
        } catch (error) { incoming.destroy(); reject(error); }
      });
      request.once("error", reject);
      request.end();
    });
  };
}
