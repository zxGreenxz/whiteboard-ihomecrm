import { describe, expect, it, vi } from "vitest";
import { createLiveDependencies, createLiveServer, LiveError, LiveSessions, liveConfigSchema, type LiveDependencies } from "../src/cameraLive.js";
import { playbackRange, playbackSources } from "../src/cameraPlayback.js";

const config = liveConfigSchema.parse({ supabaseUrl: "https://tryymsxyyckgbrmmvozx.supabase.co", publishableKey: "fixture-publishable-key", origins: ["https://crm.example.test"], recorders: [{ id: "10000000-0000-4000-8000-000000000001", organizationId: "20000000-0000-4000-8000-000000000001", buildingId: "30000000-0000-4000-8000-000000000001", channels: [1, 2], rtspOrigin: "rtsp://10.0.0.1:18554", username: "fixture", password: "fixture-password", archiveEnabled: true, archiveOrigin: "http://10.0.0.1:18080" }] });
const recorder = config.recorders[0]!;
const range = { start: "2026-10-20T01:00:00.000Z", end: "2026-10-20T02:00:00.000Z" };
const offer = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=recvonly\r\na=rtpmap:96 H265/90000\r\n";
const actor = { id: "40000000-0000-4000-8000-000000000001", expiresAt: Date.now() + 3600_000 };
const fixture = (): LiveDependencies => ({ authorize: vi.fn(async () => actor), start: vi.fn(async () => ({ location: "fixture", answer: offer })), stop: vi.fn(async () => {}), fatal: vi.fn() });

describe("direct recording playback", () => {
  it("authorizes thumbnail requests, bounds concurrency and releases cancelled work before reuse", async () => {
    let finished!: (value: string) => void; let previewSignal!: AbortSignal;
    const preview = vi.fn(async (_recorder, _channel, _start, _end, signal: AbortSignal) => { previewSignal = signal; return new Promise<string>((resolve) => { finished = resolve; }); });
    const deps = { ...fixture(), preview }; const { server } = createLiveServer(config, deps);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("address");
    const url = `http://127.0.0.1:${address.port}/camera-live/v1/recorders/${recorder.id}/channels/1/preview`;
    const headers = { Origin: config.origins[0]!, Authorization: "Bearer fixture-token-long-enough", "Content-Type": "application/json" };
    const body = JSON.stringify({ start: range.start, end: "2026-10-20T01:00:20.000Z" });
    try {
      expect((await fetch(url, { method: "POST", body })).status).toBe(403);
      vi.mocked(deps.authorize).mockRejectedValueOnce(new LiveError(403, "CAMERA_ACCESS_DENIED"));
      expect((await fetch(url, { method: "POST", headers, body })).status).toBe(403); expect(preview).not.toHaveBeenCalled();
      expect((await fetch(url, { method: "POST", headers, body: JSON.stringify(range) })).status).toBe(400);
      const abort = new AbortController();
      const pending = fetch(url, { method: "POST", headers, body, signal: abort.signal }).catch(() => undefined);
      await vi.waitFor(() => expect(preview).toHaveBeenCalledOnce());
      expect((await fetch(url, { method: "POST", headers, body })).status).toBe(429);
      abort.abort(); await pending; await vi.waitFor(() => expect(previewSignal.aborted).toBe(true));
      expect((await fetch(url, { method: "POST", headers, body })).status).toBe(429); // Process has not exited yet.
      finished("/9j/2Q=="); await new Promise((resolve) => setTimeout(resolve, 10));
      preview.mockResolvedValueOnce("/9j/2Q==");
      const response = await fetch(url, { method: "POST", headers, body }); expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ time: range.start, image: "/9j/2Q==" });
    } finally { finished?.(""); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  it("validates quality and creates a bounded, credential-free encoder between private paths", async () => {
    const encoder = `/opt/ihome-camera-live/releases/${"a".repeat(40)}/ffmpeg`;
    for (const quality of ["sd", "hd", "fullhd", "original"] as const) {
      expect(playbackRange({ ...range, quality }).quality).toBe(quality);
      const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({}));
      const sources = playbackSources(request, vi.fn(), encoder);
      const name = await sources.add(recorder, 1, { ...range, quality, speed: 8 });
      const source = JSON.parse(String(request.mock.calls[0]?.[1]?.body));
      const output = JSON.parse(String(request.mock.calls[1]?.[1]?.body));
      expect(source.rtspScale).toBe("8"); expect(output).toMatchObject({ record: false, maxReaders: 1, runOnDemandRestart: false, runOnDemandCloseAfter: "1s" });
      expect(output.runOnDemand).toContain({ sd: "min(854,iw)", hd: "min(1280,iw)", fullhd: "min(1920,iw)", original: "trunc(iw/2)*2" }[quality]);
      expect(output.runOnDemand).toContain("'expr:gte(t,n_forced*0.5)'"); expect(output.runOnDemand).toContain("'passthrough'"); expect(output.runOnDemand).toContain("'1:90000'");
      expect(output.runOnDemand).toContain("setpts=(RTCTIME-RTCSTART)/(TB*1000000)");
      expect(output.runOnDemand).not.toContain(recorder.password); expect(output.runOnDemand).not.toContain("10.0.0.1");
      await sources.remove(name);
      expect(request.mock.calls.slice(2).map(([url]) => String(url))).toEqual([`http://127.0.0.1:18897/v3/config/paths/delete/${name}`, `http://127.0.0.1:18897/v3/config/paths/delete/${name.replace("playback-", "playback-source-")}`]);
    }
    for (const quality of ["4k", "SD", "480p;command", null]) expect(() => playbackRange({ ...range, quality })).toThrow("INVALID_PLAYBACK_RANGE");
    expect(() => playbackSources(fetch, vi.fn(), "/tmp/ffmpeg;command")).toThrow("PLAYBACK_ENCODER_INVALID");
    await expect(playbackSources(fetch, vi.fn()).add(recorder, 1, { ...range, quality: "sd" })).rejects.toMatchObject({ code: "PLAYBACK_QUALITY_UNAVAILABLE" });
  });
  it("cleans both paths when creating an encoded output fails", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({})).mockResolvedValueOnce(new Response(null, { status: 400 })).mockImplementation(async () => Response.json({}));
    await expect(playbackSources(request, vi.fn(), `/opt/ihome-camera-live/releases/${"a".repeat(40)}/ffmpeg`).add(recorder, 1, { ...range, quality: "sd" })).rejects.toMatchObject({ code: "RECORDING_UNAVAILABLE" });
    expect(request.mock.calls.slice(2).map(([, init]) => init?.method)).toEqual(["DELETE", "DELETE"]);
  });
  it("accepts only the recorder's supported speeds", () => {
    for (const speed of [1, 2, 4, 6, 8]) expect(playbackRange({ ...range, speed })).toEqual({ ...range, speed });
    for (const speed of [0, -1, 3, 16, 1.5, "8", null]) expect(() => playbackRange({ ...range, speed })).toThrow("INVALID_PLAYBACK_RANGE");
  });
  it("expires accelerated playback at the scaled recording end", async () => {
    let now = Date.now(); const deps = { ...fixture(), now: () => now }; const sessions = new LiveSessions(deps);
    await sessions.start(actor, recorder, 1, offer, { ...range, end: "2026-10-20T01:04:00Z", speed: 8 });
    now += 61_000; await sessions.expire(); expect(deps.stop).toHaveBeenCalledOnce(); expect(sessions.size).toBe(0);
  });
  it("rejects future, excessive, fractional, injected and reversed intervals", () => {
    for (const invalid of [{ ...range, start: range.end }, { ...range, end: "2999-01-01T00:00:00Z" }, { ...range, end: "2026-10-22T00:00:00Z" }, { ...range, start: "2026-10-20T01:00:00.001Z" }, { ...range, source: "rtsp://outside" }, { ...range, start: "bad" }]) expect(() => playbackRange(invalid)).toThrow("INVALID_PLAYBACK_RANGE");
    expect(playbackRange({ start: "2026-10-20T08:00:00+07:00", end: "2026-10-20T09:00:00+07:00" })).toEqual(range);
  });
  it("reserves only four playback streams before media starts, without consuming the export queue", async () => {
    const deps = fixture(); const sessions = new LiveSessions(deps);
    let finish!: (value: { location: string; answer: string }) => void;
    const waiting = new Promise<{ location: string; answer: string }>((resolve) => { finish = resolve; });
    vi.mocked(deps.start).mockReturnValue(waiting);
    const pending = Array.from({ length: 4 }, () => sessions.start(actor, recorder, 1, offer, range));
    await expect(sessions.start(actor, recorder, 1, offer, range)).rejects.toMatchObject({ code: "PLAYBACK_BUSY" });
    finish({ location: "fixture", answer: offer }); await Promise.all(pending); await sessions.closeAll();
    await expect(sessions.start(actor, recorder, 3, offer, range)).rejects.toMatchObject({ code: "CAMERA_NOT_CONFIGURED" });
    await expect(sessions.start(actor, { ...recorder, archiveEnabled: false }, 1, offer, range)).rejects.toMatchObject({ code: "ARCHIVE_NOT_CONFIGURED" });
  });
  it("stops at the recording end even if the client keeps renewing", async () => {
    let now = Date.now(); const deps = { ...fixture(), now: () => now }; const sessions = new LiveSessions(deps);
    const result = await sessions.start(actor, recorder, 1, offer, { ...range, end: "2026-10-20T01:00:05Z" });
    now += 25_000; expect(await sessions.renew(result.id, "token")).toBe(result.expiresAt);
    now += 11_000; await sessions.expire(); expect(deps.stop).toHaveBeenCalledOnce(); expect(sessions.size).toBe(0);
  });
  it("uses a private per-session RTSP path with Vietnam time and removes it on stop", async () => {
    let name = "";
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("/add/")) { name = url.split("/").at(-1)!; return Response.json({ status: "ok" }); }
      if (init?.method === "POST") return new Response(offer, { status: 201, headers: { Location: `/${name}/whep/50000000-0000-4000-8000-000000000001` } });
      return Response.json({ status: "ok" });
    });
    const deps = createLiveDependencies(config, vi.fn(), request); const media = await deps.start(recorder, 2, offer, { ...range, speed: 6 });
    const path = JSON.parse(String(request.mock.calls[0]?.[1]?.body));
    expect(path).toMatchObject({ record: false, sourceOnDemand: true, maxReaders: 1, rtspTransport: "tcp", rtspScale: "6" });
    const source = new URL(path.source); expect(source.hostname).toBe("10.0.0.1"); expect(source.searchParams.get("channel")).toBe("2"); expect(source.searchParams.get("starttime")).toBe("2026_10_20_08_00_00");
    expect(JSON.stringify(media)).not.toContain(recorder.password);
    await deps.stop(media.location); expect(request.mock.calls.at(-1)?.[0]).toBe(`http://127.0.0.1:18897/v3/config/paths/delete/${name}`);
  });
  it("removes an orphan path on failed WHEP negotiation and fails closed on uncertain cleanup", async () => {
    const fatal = vi.fn(); const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({})).mockResolvedValueOnce(new Response("no supported codecs", { status: 400 })).mockResolvedValueOnce(Response.json({}));
    await expect(createLiveDependencies(config, fatal, request).start(recorder, 1, offer, range)).rejects.toMatchObject({ code: "CODEC_UNSUPPORTED" });
    expect(request.mock.calls[2]?.[1]?.method).toBe("DELETE"); expect(fatal).not.toHaveBeenCalled();
    request.mockReset().mockRejectedValue(new Error("unreachable"));
    await expect(createLiveDependencies(config, fatal, request).start(recorder, 1, offer, range)).rejects.toMatchObject({ code: "MEDIA_CLEANUP_FAILED" }); expect(fatal).toHaveBeenCalledOnce();
  });
  it("controls only an owned unexpired playback, bounds seeks and cancels control on stop", async () => {
    const control = vi.fn(async (_location: string, _offset: number, _speed: number, signal: AbortSignal) => { expect(signal.aborted).toBe(false); });
    const deps = { ...fixture(), control }; const sessions = new LiveSessions(deps);
    const session = await sessions.start(actor, recorder, 1, offer, { ...range, quality: "sd", position: "2026-10-20T01:20:00Z" });
    await sessions.control(session.id, "token", { time: "2026-10-20T01:01:00Z", speed: 8 });
    expect(control).toHaveBeenCalledWith("fixture", 60, 8, expect.any(AbortSignal));
    await expect(sessions.control(session.id, "token", { time: range.end, speed: 1 })).rejects.toMatchObject({ code: "INVALID_PLAYBACK_RANGE" });
    await expect(sessions.control(session.id, "token", { time: "2026-10-20T00:59:59Z", speed: 1 })).rejects.toMatchObject({ code: "INVALID_PLAYBACK_RANGE" });
    vi.mocked(deps.authorize).mockResolvedValueOnce({ ...actor, id: "other" });
    await expect(sessions.control(session.id, "token", { time: range.start, speed: 1 })).rejects.toMatchObject({ code: "SESSION_OWNER_MISMATCH" });
    expect(control).toHaveBeenCalledTimes(1);
    let complete!: () => void;
    control.mockImplementationOnce(async (_location, _offset, _speed, signal) => { await new Promise<void>((resolve) => { complete = resolve; signal.addEventListener("abort", resolve as () => void, { once: true }); }); });
    const pending = sessions.control(session.id, "token", { time: range.start, speed: 1 });
    await vi.waitFor(() => expect(control).toHaveBeenCalledTimes(2));
    await expect(sessions.control(session.id, "token", { time: range.start, speed: 1 })).rejects.toMatchObject({ code: "PLAYBACK_BUSY" });
    await sessions.stop(session.id, "token"); complete();
    await expect(pending).rejects.toMatchObject({ code: "SESSION_EXPIRED" }); expect(sessions.size).toBe(0);
  });
  it("waits for the recorder acknowledgement and omits Scale when returning to normal speed", async () => {
    let revision = ""; let polls = 0;
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === "PATCH") revision = JSON.parse(String(init.body)).rtspPlaybackRevision;
      if (!init?.method) return Response.json({ typeSpecific: { playbackRevision: ++polls === 1 ? "old" : revision } });
      return Response.json({});
    });
    const sources = playbackSources(request, vi.fn(), `/opt/ihome-camera-live/releases/${"a".repeat(40)}/ffmpeg`);
    const name = await sources.add(recorder, 1, { ...range, quality: "sd" });
    await sources.control(name, 120, 1, new AbortController().signal);
    expect(polls).toBe(2); expect(JSON.parse(String(request.mock.calls.find(([, init]) => init?.method === "PATCH")?.[1]?.body))).toMatchObject({ rtspScale: "", rtspRangeStart: "120s" });
    await sources.remove(name);
  });
  it("requires origin, identity, recorder access and receive-only SDP on the playback route", async () => {
    const deps = fixture(); const { server, sessions } = createLiveServer(config, deps);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("address");
    const url = `http://127.0.0.1:${address.port}/camera-live/v1/recorders/${recorder.id}/channels/1/playback`;
    const headers = { Origin: config.origins[0]!, Authorization: "Bearer fixture-token-long-enough", "Content-Type": "application/json" };
    const body = JSON.stringify({ ...range, offer });
    try {
      expect((await fetch(url, { method: "POST", body })).status).toBe(403);
      expect((await fetch(url, { method: "POST", headers: { Origin: headers.Origin }, body })).status).toBe(401);
      vi.mocked(deps.authorize).mockRejectedValueOnce(new LiveError(403, "CAMERA_ACCESS_DENIED"));
      expect((await fetch(url, { method: "POST", headers, body })).status).toBe(403); expect(deps.start).not.toHaveBeenCalled();
      expect((await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...range, offer: offer.replace("recvonly", "sendrecv") }) })).status).toBe(400);
      expect((await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...range, offer, speed: 16 }) })).status).toBe(400);
      const response = await fetch(url, { method: "POST", headers, body }); expect(response.status).toBe(201);
      expect(deps.start).toHaveBeenCalledWith(recorder, 1, offer, range); expect(sessions.size).toBe(1);
      expect((await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...range, offer, speed: 8 }) })).status).toBe(201);
      expect(deps.start).toHaveBeenLastCalledWith(recorder, 1, offer, { ...range, speed: 8 });
    } finally { await sessions.closeAll(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
