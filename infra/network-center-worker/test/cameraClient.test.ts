import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { DahuaClient, parseCameraStates, parseCameraStorage } from "../src/camera/dahuaClient.js";
import { CameraMultipartParser, parseCameraEvent } from "../src/camera/eventParser.js";
import { CAMERA_ISSUES } from "../src/camera/types.js";

const disk = [
  "list.info[0].State=Success", "list.info[0].Detail[0].IsError=false",
  "list.info[0].Detail[0].TotalBytes=1000.000000", "list.info[0].Detail[0].UsedBytes=500.000000",
  "list.info[0].Detail[1].IsError=false", "list.info[0].Detail[1].TotalBytes=2000.000000", "list.info[0].Detail[1].UsedBytes=300.000000",
].join("\r\n");
const rpc = (value: unknown) => new Response(JSON.stringify(value));
const challenge = () => rpc({ result: false, session: 91, params: { realm: "fixture", random: "random-challenge", encryption: "Default" } });
const session = () => rpc({ result: true, session: 92 });
const states = () => rpc({ result: true, params: { states: [{ channel: 0, connectionState: "Connected" }, { channel: 1, connectionState: "Empty" }] } });
const success = () => rpc({ result: true });
const fixedNow = () => new Date("2026-01-01T00:00:00.000Z");

function fixture(responses: Array<() => Response>, overrides: Partial<ConstructorParameters<typeof DahuaClient>[0]> = {}) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error("fixture exhausted");
    return next();
  };
  return { calls, client: new DahuaClient({ baseUrl: "http://192.0.2.10", username: "fixture-user", password: "fixture-secret", fetch: fetcher, now: fixedNow, ...overrides }) };
}

describe("camera boundary parsers", () => {
  it("converts index zero exactly once and does not make empty slots offline", () => {
    expect(parseCameraStates([{ channel: 0, connectionState: "Connected" }, { channel: 15, connectionState: "Empty" }])).toEqual([
      { channel: 1, state: "CONNECTED" }, { channel: 16, state: "EMPTY" },
    ]);
    expect(parseCameraStates([{ channel: 0, connectionState: "Unexpected" }])[0]?.state).toBe("UNKNOWN");
  });

  it.each([null, [], {}, [{ channel: 0, Address: "192.0.2.1" }], [{ channel: -1, connectionState: "Connected" }], [{ channel: 0, connectionState: "Connected" }, { channel: 0, connectionState: "Connected" }]])("rejects malformed states rather than claiming healthy: %j", (value) => {
    expect(() => parseCameraStates(value)).toThrow("INVALID_RESPONSE");
  });

  it("adds partitions and requires explicit disk success and error flags", () => {
    expect(parseCameraStorage(disk)).toEqual([{ slot: 1, state: "NORMAL", totalBytes: 3000, usedBytes: 800 }]);
    expect(parseCameraStorage(disk.replace("IsError=false", "IsError=true"))[0]?.state).toBe("ERROR");
    expect(parseCameraStorage("list[0].State=Success")[0]?.state).toBe("UNKNOWN");
    expect(() => parseCameraStorage("Error:No SD Card")).toThrow("INVALID_RESPONSE");
  });

  it("keeps camera and disk indexes distinct and never interprets heartbeat as recovery", () => {
    expect(parseCameraEvent("Heartbeat")).toBeNull();
    expect(parseCameraEvent("Code=VideoLoss;action=Stop;index=0")).toEqual({ code: "VideoLoss", action: "Stop", index: 0, channelNumber: 1 });
    expect(parseCameraEvent("Code=StorageFailure;action=Start;index=0")).toEqual({ code: "StorageFailure", action: "Start", index: 0 });
    expect(parseCameraEvent("Code=VideoLoss;action=Start;index=-1")).toBeNull();
    expect(parseCameraEvent('Code=VideoLoss;action=Start;index=0;data={\n"detail":"private"\n}')?.channelNumber).toBe(1);
    expect(parseCameraEvent("Code=VideoLoss;action=Start;index=0;data=invalid")).toBeNull();
  });

  it("frames across arbitrary TCP splits without waiting for the next heartbeat", () => {
    const parser = new CameraMultipartParser("fixture");
    const body = "Code=VideoLoss;action=Start;index=0";
    const bytes = Buffer.from(`--fixture\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    const messages = [];
    for (const byte of bytes) messages.push(...parser.push(Uint8Array.of(byte)));
    expect(messages).toEqual([{ type: "event", event: { code: "VideoLoss", action: "Start", index: 0, channelNumber: 1 } }]);
    expect(parser.push(Buffer.from("\r\n--fixture\r\nContent-Length: 9\r\n\r\nHeartbeat"))).toEqual([{ type: "heartbeat" }]);
  });

  it("supports boundary framing without length and rejects oversized or malformed parts", () => {
    const parser = new CameraMultipartParser("b");
    expect(parser.push(Buffer.from("--b\r\nContent-Type: text/plain\r\n\r\nHeartbeat\r\n--b"))).toEqual([{ type: "heartbeat" }]);
    expect(() => new CameraMultipartParser("b").push(Buffer.alloc(65537))).toThrow("CAMERA_EVENT_TOO_LARGE");
    expect(() => new CameraMultipartParser("b").push(Buffer.from("--b\r\nContent-Length: 999999\r\n\r\n"))).toThrow("CAMERA_EVENT_TOO_LARGE");
    expect(() => new CameraMultipartParser("b").push(Buffer.from("--b\r\nContent-Length: 3\r\n\r\nbad"))).toThrow("INVALID_CAMERA_EVENT_PAYLOAD");
  });
});

describe("Dahua authenticated read-only polling", () => {
  it("downloads native recordings with Digest and percent-encoded wall-clock times", async () => {
    const {client,calls}=fixture([
      ()=>new Response("",{status:401,headers:{"www-authenticate":'Digest realm="fixture", nonce="nonce", qop="auth", algorithm=MD5'}}),
      ()=>new Response(new Uint8Array(40)),
    ]);
    const signal=new AbortController().signal;
    const response=await client.recording(1,"2026-10-24 09:50:05","2026-10-24 09:50:10",signal);
    expect((await response.arrayBuffer()).byteLength).toBe(40);
    expect(calls[1]?.url).toContain("startTime=2026-10-24%2009%3A50%3A05");
    expect(calls[1]?.url).not.toMatch(/fixture-secret|\+/u);
    expect(calls[1]?.init?.redirect).toBe("error");
    expect(calls[1]?.init?.signal).toBe(signal);
    await expect(client.recording(0,"2026-10-24 09:50:05","2026-10-24 09:50:10",signal)).rejects.toMatchObject({code:"INVALID_RESPONSE"});
  });
  it("uses challenge hashing, Digest disk reads, bounded private-origin requests and logout", async () => {
    const { client, calls } = fixture([
      challenge, session, states,
      () => new Response("", { status: 401, headers: { "www-authenticate": 'Digest realm="fixture", nonce="nonce", qop="auth", algorithm=MD5' } }),
      () => new Response(disk), success,
    ]);
    const snapshot = await client.poll();
    expect(snapshot.status).toBe("ONLINE");
    expect(snapshot.eventCoverage).toBe("STATE_POLLING_ONLY");
    expect(snapshot.channels[1]?.state).toBe("EMPTY");
    const login = JSON.parse(String(calls[1]?.init?.body));
    const hash = (value: string) => createHash("md5").update(value).digest("hex").toUpperCase();
    expect(login.params.password).toBe(hash(`fixture-user:random-challenge:${hash("fixture-user:fixture:fixture-secret")}`));
    expect(login.session).toBe(91);
    expect(JSON.parse(String(calls[2]?.init?.body)).session).toBe(92);
    expect(JSON.parse(String(calls.at(-1)?.init?.body)).method).toBe("global.logout");
    expect(new Headers(calls[4]?.init?.headers).get("Authorization")).toContain("Digest ");
    expect(calls.every((call) => call.init?.redirect === "error" && !call.url.includes("fixture-secret"))).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("fixture-secret");
  });

  it("does not retry login after denial or mislabel it offline", async () => {
    const { client, calls } = fixture([challenge, () => rpc({ result: false, error: { code: 268632080, message: "fixture-secret" } })]);
    expect(await client.poll()).toMatchObject({ status: "AUTH_DENIED", issues: ["AUTHENTICATION_FAILED"], channels: [] });
    expect(calls).toHaveLength(2);
  });

  it("logs out even when channel state is malformed; absent data cannot become healthy", async () => {
    const { client, calls } = fixture([challenge, session, () => rpc({ result: true, params: { states: {} } }), success]);
    expect(await client.poll()).toMatchObject({ status: "UNKNOWN", issues: ["DEVICE_RESPONSE_INVALID"] });
    expect(JSON.parse(String(calls.at(-1)?.init?.body)).method).toBe("global.logout");
  });

  it("keeps endpoint permission failure distinct from transport loss", async () => {
    const { client } = fixture([challenge, session, states, () => new Response("", { status: 403 }), success]);
    expect(await client.poll()).toMatchObject({ status: "AUTH_DENIED", issues: ["AUTHENTICATION_FAILED"] });
    const unreachable = fixture([]).client;
    expect(await unreachable.poll()).toMatchObject({ status: "OFFLINE", issues: ["NETWORK_UNREACHABLE"] });
  });

  it("does not certify a truncated channel list against the configured capacity", async () => {
    const { client } = fixture([challenge, session, states, success], { expectedChannelCount: 16 });
    expect(await client.poll()).toMatchObject({ status: "UNKNOWN", issues: ["DEVICE_RESPONSE_INVALID"] });
  });

  it("removes out-of-assignment channels so the failure snapshot remains ingestible", async () => {
    const { client } = fixture([challenge, session, () => rpc({ result: true, params: { states: [{ channel: 17, connectionState: "Connected" }] } }), success], { expectedChannelCount: 16 });
    expect(await client.poll()).toMatchObject({ status: "UNKNOWN", issues: ["DEVICE_RESPONSE_INVALID"], channels: [] });
  });

  it("bounds response bodies and still releases an authenticated session", async () => {
    const { client, calls } = fixture([challenge, session, () => new Response("x".repeat(1025)), success], { maxResponseBytes: 1024 });
    expect(await client.poll()).toMatchObject({ status: "UNKNOWN", issues: ["DEVICE_RESPONSE_INVALID"] });
    expect(JSON.parse(String(calls.at(-1)?.init?.body)).method).toBe("global.logout");
  });

  it("aborts request timeouts and does not expose thrown fetch secrets", async () => {
    const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("fixture-secret")), { once: true });
    });
    const client = fixture([], { fetch: fetcher, timeoutMs: 5 }).client;
    expect(await client.poll()).toMatchObject({ status: "OFFLINE", issues: ["NETWORK_UNREACHABLE"] });
  });

  it("provides stream heartbeat separately and reports early stream close as a gap", async () => {
    const { client } = fixture([() => new Response("--b\r\nContent-Length: 9\r\n\r\nHeartbeat", { headers: { "content-type": "multipart/x-mixed-replace; boundary=b" } })]);
    const stream = client.openEventStream();
    expect(await stream.next()).toMatchObject({ value: { type: "heartbeat" }, done: false });
    await expect(stream.next()).rejects.toThrow("STREAM_ENDED");
  });

  it("does not deliver an out-of-assignment event to the durable outbox", async () => {
    const payload = "Code=VideoLoss;action=Start;index=17";
    const { client } = fixture([() => new Response(`--b\r\nContent-Length: ${payload.length}\r\n\r\n${payload}`, { headers: { "content-type": "multipart/x-mixed-replace; boundary=b" } })], { expectedChannelCount: 16 });
    await expect(client.openEventStream().next()).rejects.toThrow("INVALID_RESPONSE");
  });

  it("ends a silent stream on the idle deadline and releases its reader", async () => {
    let aborted = false;
    const fetcher: typeof fetch = async (_url, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) { init?.signal?.addEventListener("abort", () => { aborted = true; controller.error(new Error("fixture-secret")); }, { once: true }); },
    }), { headers: { "content-type": "multipart/x-mixed-replace; boundary=b" } });
    const client = fixture([], { fetch: fetcher, streamIdleTimeoutMs: 5 }).client;
    await expect(client.openEventStream().next()).rejects.toThrow("STREAM_TIMEOUT");
    expect(aborted).toBe(true);
  });

  it("user cancellation aborts a pending stream read without reporting a device error", async () => {
    const abort = new AbortController();
    const fetcher: typeof fetch = async (_url, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) { init?.signal?.addEventListener("abort", () => controller.error(new Error("fixture-secret")), { once: true }); },
    }), { headers: { "content-type": "multipart/x-mixed-replace; boundary=b" } });
    const client = fixture([], { fetch: fetcher }).client;
    const next = client.openEventStream(abort.signal).next();
    setTimeout(() => abort.abort(), 5);
    expect(await next).toMatchObject({ done: true });
  });

  it("rejects embedded credentials and redirect-like base URLs", () => {
    expect(() => fixture([], { baseUrl: "http://user:secret@192.0.2.10" })).toThrow("INVALID_CAMERA_BASE_URL");
    expect(() => fixture([], { baseUrl: "http://192.0.2.10/untrusted" })).toThrow("INVALID_CAMERA_BASE_URL");
  });

  it.each([
    { phase: "channels", status: 400, issue: "CHANNEL_STATUS_UNAVAILABLE" },
    { phase: "storage", status: 400, issue: "STORAGE_STATUS_UNAVAILABLE" },
    { phase: "logout", status: 400, issue: "DEVICE_RESPONSE_INVALID" },
  ])("only sends accepted ingestion issues for $phase failures", async ({ phase, status, issue }) => {
    const failure = () => new Response("private response", { status });
    const responses = phase === "channels" ? [challenge, session, failure, success]
      : phase === "storage" ? [challenge, session, states, failure, success]
      : [challenge, session, states, () => new Response(disk), failure];
    const { client } = fixture(responses);
    const snapshot = await client.poll();
    expect(snapshot.issues).toContain(issue);
    expect(snapshot.issues.every((code) => (CAMERA_ISSUES as readonly string[]).includes(code))).toBe(true);
  });
});
