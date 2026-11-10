import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLiveDependencies, liveConfigSchema } from "../src/cameraLive.js";
import { LIVE_DECODE_WAIT_MS, liveDecodeCheck } from "../src/cameraLiveProbe.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
type Child = EventEmitter & { kill: ReturnType<typeof vi.fn> };
let children: Child[];
const encoder = `/opt/ihome-camera-live/releases/${"a".repeat(40)}/ffmpeg`;
const recorderId = "10000000-0000-4000-8000-000000000002"; const name = `camera-${recorderId}-1`;
/** Media API answering how many bytes the recorder has sent on a path. */
const mediaApi = (inboundBytes: number | "missing") => vi.fn<typeof fetch>(async () => inboundBytes === "missing" ? new Response(null, { status: 404 }) : Response.json({ name, online: true, inboundBytes }));
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); children = [];
  mocks.spawn.mockImplementation(() => { const child: Child = Object.assign(new EventEmitter(), { kill: vi.fn(() => { child.emit("close", null); return true; }) }); children.push(child); return child; });
});
afterEach(() => vi.useRealTimers());

describe("live decode check", () => {
  it("offers the stream once a frame decodes and then trusts every channel of that recorder for a while", async () => {
    let now = 1_000_000; const request = mediaApi(0); const check = liveDecodeCheck(encoder, request, () => now);
    const first = check(recorderId, name); const second = check(recorderId, `camera-${recorderId}-9`);
    expect(mocks.spawn).toHaveBeenCalledOnce(); // Concurrent tiles share one decoder.
    children[0]!.emit("close", 0); await first; await second;
    const [binary, args, options] = mocks.spawn.mock.calls[0]!;
    expect(binary).toBe(encoder); expect(options).toEqual({ stdio: "ignore" });
    expect(args).toEqual(["-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1", "-rtsp_transport", "tcp", "-timeout", "5000000", "-i", `rtsp://127.0.0.1:18895/${name}`, "-an", "-frames:v", "1", "-f", "null", "-"]);
    await check(recorderId, `camera-${recorderId}-16`); now += 9 * 60_000; await check(recorderId, name);
    expect(mocks.spawn).toHaveBeenCalledOnce(); expect(request).not.toHaveBeenCalled();
    now += 2 * 60_000; const later = check(recorderId, name); expect(mocks.spawn).toHaveBeenCalledTimes(2);
    children[1]!.emit("close", 0); await later;
  });
  it("refuses with a fixed code when video arrives but no frame ever decodes, and stops the decoder", async () => {
    let now = 1_000_000; const request = mediaApi(900_000); const check = liveDecodeCheck(encoder, request, () => now);
    const tiles = [check(recorderId, name), check(recorderId, `camera-${recorderId}-2`)];
    const refused = Promise.all(tiles.map((tile) => expect(tile).rejects.toMatchObject({ status: 502, code: "LIVE_STREAM_UNDECODABLE" })));
    await vi.advanceTimersByTimeAsync(LIVE_DECODE_WAIT_MS - 1); expect(children[0]!.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
    await refused; expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(String(request.mock.calls[0]?.[0])).toBe(`http://127.0.0.1:18897/v3/paths/get/${name}`);
    // The same stream is refused at once for a short while: no decoder is started per retry.
    await expect(check(recorderId, name)).rejects.toMatchObject({ code: "LIVE_STREAM_UNDECODABLE" }); expect(mocks.spawn).toHaveBeenCalledOnce();
    now += 31_000; const retry = check(recorderId, name); expect(mocks.spawn).toHaveBeenCalledTimes(2);
    children[1]!.emit("close", 0); await retry; // Encryption switched off: live again, without a restart.
    await check(recorderId, `camera-${recorderId}-2`); expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });
  it("judges one recorder at a time", async () => {
    const check = liveDecodeCheck(encoder, mediaApi(900_000), () => 1_000_000);
    const encrypted = expect(check(recorderId, name)).rejects.toMatchObject({ code: "LIVE_STREAM_UNDECODABLE" });
    const other = check("10000000-0000-4000-8000-000000000003", "camera-10000000-0000-4000-8000-000000000003-1");
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    children[1]!.emit("close", 0); await other;
    children[0]!.emit("close", 1); await encrypted;
  });
  it.each([["no video arrived", 512], ["the path is gone", "missing"], ["the media API is unreachable", "unreachable"]] as const)("leaves the ordinary camera-unavailable path alone when %s", async (_reason, bytes) => {
    const request = bytes === "unreachable" ? vi.fn<typeof fetch>().mockRejectedValue(new Error("refused")) : mediaApi(bytes);
    const check = liveDecodeCheck(encoder, request, () => 1_000_000);
    const pending = check(recorderId, name); children[0]!.emit("close", 1); await pending;
    // Nothing was proven either way, so the next viewer is checked again.
    const again = check(recorderId, name); expect(mocks.spawn).toHaveBeenCalledTimes(2); children[1]!.emit("close", 0); await again;
  });
  it("does not block viewers when the decoder cannot start", async () => {
    const check = liveDecodeCheck(encoder, mediaApi("missing"), () => 1_000_000);
    const pending = check(recorderId, name); children[0]!.emit("error", new Error("spawn")); await pending;
    await vi.advanceTimersByTimeAsync(LIVE_DECODE_WAIT_MS); expect(children[0]!.kill).not.toHaveBeenCalled();
  });
});

describe("live start with the decode check", () => {
  const base = { organizationId: "20000000-0000-4000-8000-000000000001", buildingId: "30000000-0000-4000-8000-000000000001", channels: [1, 9], username: "fixture", password: "fixture-password" };
  const config = liveConfigSchema.parse({ supabaseUrl: "https://tryymsxyyckgbrmmvozx.supabase.co", publishableKey: "test-publishable-key-placeholder", origins: ["https://crm.example.test"], recorders: [
    { ...base, id: "10000000-0000-4000-8000-000000000001", rtspOrigin: "rtsp://10.0.0.1:554" },
    { ...base, id: recorderId, vendor: "HIKVISION", rtspOrigin: "rtsp://10.0.0.2:554" },
  ] });
  const [dahua, hikvision] = config.recorders as [typeof config.recorders[number], typeof config.recorders[number]];
  const offer = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=recvonly\r\na=rtpmap:96 H265/90000\r\n";
  const media = () => vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.includes("/v3/paths/get/")) return Response.json({ inboundBytes: 900_000 });
    if (init?.method === "POST" && url.endsWith("/whep")) return new Response(offer, { status: 201, headers: { Location: `${new URL(url).pathname}/50000000-0000-4000-8000-000000000001` } });
    return Response.json({});
  });
  it("never checks a Dahua recorder, and cannot check anything without the decoder binary", async () => {
    const request = media();
    await createLiveDependencies(config, vi.fn(), request, encoder).start(dahua, 1, offer);
    await createLiveDependencies(config, vi.fn(), request).start(hikvision, 1, offer);
    expect(mocks.spawn).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledTimes(2);
  });
  it("opens Hikvision live only after one sub-stream frame decoded, whatever quality was asked", async () => {
    const request = media(); const dependencies = createLiveDependencies(config, vi.fn(), request, encoder);
    const pending = dependencies.start(hikvision, 9, offer, undefined, "fullhd");
    await vi.advanceTimersByTimeAsync(0); expect(request).not.toHaveBeenCalled();
    expect(mocks.spawn.mock.calls[0]?.[1]).toContain(`rtsp://127.0.0.1:18895/camera-${recorderId}-9`);
    children[0]!.emit("close", 0);
    expect(await pending).toMatchObject({ answer: offer }); expect(String(request.mock.calls[0]?.[0])).toBe(`http://127.0.0.1:18889/camera-${recorderId}-9-fullhd/whep`);
  });
  it("answers LIVE_STREAM_UNDECODABLE instead of opening a stream that would stay black, and never touches playback", async () => {
    const fatal = vi.fn(); const request = media(); const dependencies = createLiveDependencies(config, fatal, request, encoder);
    const refused = expect(dependencies.start(hikvision, 1, offer)).rejects.toMatchObject({ status: 502, code: "LIVE_STREAM_UNDECODABLE" });
    await vi.advanceTimersByTimeAsync(LIVE_DECODE_WAIT_MS); await refused;
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([`http://127.0.0.1:18897/v3/paths/get/camera-${recorderId}-1`]); expect(fatal).not.toHaveBeenCalled();
    // Recorded playback of the same recorder decodes normally (measured), so it is never gated on the live verdict.
    request.mockClear();
    await dependencies.start({ ...hikvision, playbackEnabled: true }, 1, offer, { start: "2026-10-20T01:00:00.000Z", end: "2026-10-20T02:00:00.000Z" });
    expect(mocks.spawn).toHaveBeenCalledOnce(); expect(String(request.mock.calls[0]?.[0])).toContain("/v3/config/paths/add/playback-");
  });
});
