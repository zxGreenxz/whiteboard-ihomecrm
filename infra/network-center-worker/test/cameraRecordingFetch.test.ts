import { createServer, type Server } from "node:http";
import { createServer as createRawServer } from "node:net";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DahuaClient } from "../src/camera/dahuaClient.js";
import { saveRecording } from "../src/cameraArchiveMedia.js";
import { recordingFetch } from "../src/cameraRecordingFetch.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });
async function listen(server: Server | ReturnType<typeof createRawServer>) {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("FIXTURE_ADDRESS");
  cleanup.push(async () => { if ("closeAllConnections" in server) server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  return `http://127.0.0.1:${address.port}`;
}
const options = (signal = AbortSignal.timeout(2000)): RequestInit => ({ method: "GET", redirect: "error", signal });

describe("recording transport", () => {
  it("survives recorder FIN while a 64 KiB body is paused before consumption", async () => {
    const body = Buffer.alloc(64 * 1024, 0x61);
    const origin = await listen(createRawServer(socket => socket.once("data", () => {
      socket.end(Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`), body]));
    })));
    const response = await recordingFetch(origin)(origin, options());
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(body);
  });

  it("preserves Digest authentication and streams recorder bytes to the bounded file writer", async () => {
    const body = Buffer.alloc(256 * 1024, 0x43); const paths: string[] = []; let authorized = 0;
    const origin = await listen(createServer((request, response) => {
      paths.push(request.url!);
      if (!request.headers.authorization) { response.writeHead(401, { "www-authenticate": 'Digest realm="fixture", nonce="one", qop="auth"' }); response.end(); return; }
      expect(request.headers.authorization).toMatch(/^Digest username="fixture"/u); authorized++;
      expect(request.headers["accept-encoding"]).toBe("identity");
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(body.length), connection: "close" }); response.end(body);
    }));
    const folder = await mkdtemp(join(tmpdir(), "camera-recording-")); cleanup.push(() => rm(folder, { recursive: true }));
    const client = new DahuaClient({ baseUrl: origin, username: "fixture", password: "fixture-only", fetch: recordingFetch(origin) });
    const response = await client.recording(1, "2026-10-25 09:20:00", "2026-10-25 09:20:10", AbortSignal.timeout(2000));
    const file = join(folder, "recording.dav"); await saveRecording(response, file, AbortSignal.timeout(2000));
    expect(await readFile(file)).toEqual(body); expect(authorized).toBe(1);
    expect(paths).toHaveLength(2); expect(paths[0]).toBe(paths[1]); expect(paths[0]).toContain("09%3A20%3A00"); expect(paths[0]).not.toContain("+");
  });

  it("refuses cross-origin requests and redirects without forwarding credentials", async () => {
    let received = 0;
    const other = await listen(createServer((_request, response) => { received++; response.end("unexpected"); }));
    const origin = await listen(createServer((_request, response) => { response.writeHead(302, { location: other }); response.end(); }));
    const request = recordingFetch(origin);
    await expect(request(other, { ...options(), headers: { Authorization: "Digest fixture" } })).rejects.toThrow("RECORDING_ORIGIN_INVALID");
    await expect(request(origin, { ...options(), headers: { Authorization: "Digest fixture" } })).rejects.toThrow("RECORDING_RESPONSE_INVALID");
    expect(received).toBe(0);
  });

  it("abort closes a streaming response and rejects the pending body read", async () => {
    let closed!: () => void; const ended = new Promise<void>(resolve => { closed = resolve; });
    const origin = await listen(createServer((request, response) => { request.once("close", closed); response.writeHead(200); response.write("header"); }));
    const controller = new AbortController(); const response = await recordingFetch(origin)(origin, options(controller.signal));
    const body = response.arrayBuffer(); controller.abort();
    await expect(body).rejects.toBeDefined(); await ended;
  });

  it("byte-limit cancellation closes the recorder response", async () => {
    let closed!: () => void; const ended = new Promise<void>(resolve => { closed = resolve; });
    const origin = await listen(createServer((request, response) => { request.once("close", closed); response.writeHead(200); response.write(Buffer.alloc(8192)); }));
    const folder = await mkdtemp(join(tmpdir(), "camera-recording-limit-")); cleanup.push(() => rm(folder, { recursive: true }));
    const signal = AbortSignal.timeout(2000); const response = await recordingFetch(origin)(origin, options(signal));
    await expect(saveRecording(response, join(folder, "recording.dav"), signal, 4096)).rejects.toMatchObject({ code: "ARCHIVE_TOO_LARGE" });
    await ended;
  });

  it("a truncated recording fails as a body error without terminating the process", async () => {
    const origin = await listen(createRawServer(socket => socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 1000\r\nConnection: close\r\n\r\nshort"))));
    const response = await recordingFetch(origin)(origin, options());
    await expect(response.arrayBuffer()).rejects.toBeDefined();
  });
});
