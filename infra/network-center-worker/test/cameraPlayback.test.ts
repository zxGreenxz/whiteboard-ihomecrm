import { describe, expect, it, vi } from "vitest";
import { createLiveDependencies, createLiveServer, LiveError, LiveSessions, liveConfigSchema, type LiveDependencies } from "../src/cameraLive.js";
import { playbackRange } from "../src/cameraPlayback.js";

const config = liveConfigSchema.parse({ supabaseUrl: "https://tryymsxyyckgbrmmvozx.supabase.co", publishableKey: "fixture-publishable-key", origins: ["https://crm.example.test"], recorders: [{ id: "10000000-0000-4000-8000-000000000001", organizationId: "20000000-0000-4000-8000-000000000001", buildingId: "30000000-0000-4000-8000-000000000001", channels: [1, 2], rtspOrigin: "rtsp://10.0.0.1:18554", username: "fixture", password: "fixture-password", archiveEnabled: true, archiveOrigin: "http://10.0.0.1:18080" }] });
const recorder = config.recorders[0]!;
const range = { start: "2026-10-20T01:00:00.000Z", end: "2026-10-20T02:00:00.000Z" };
const offer = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=recvonly\r\na=rtpmap:96 H265/90000\r\n";
const actor = { id: "40000000-0000-4000-8000-000000000001", expiresAt: Date.now() + 3600_000 };
const fixture = (): LiveDependencies => ({ authorize: vi.fn(async () => actor), start: vi.fn(async () => ({ location: "fixture", answer: offer })), stop: vi.fn(async () => {}), fatal: vi.fn() });

describe("direct recording playback", () => {
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
    const deps = createLiveDependencies(config, vi.fn(), request); const media = await deps.start(recorder, 2, offer, range);
    const path = JSON.parse(String(request.mock.calls[0]?.[1]?.body));
    expect(path).toMatchObject({ record: false, sourceOnDemand: true, maxReaders: 1, rtspTransport: "tcp" });
    const source = new URL(path.source); expect(source.hostname).toBe("10.0.0.1"); expect(source.searchParams.get("channel")).toBe("2"); expect(source.searchParams.get("starttime")).toBe("2026_10_20_08_00_00");
    expect(JSON.stringify(media)).not.toContain(recorder.password);
    await deps.stop(media.location); expect(request.mock.calls.at(-1)?.[0]).toBe(`http://127.0.0.1:18897/v3/config/paths/delete/${name}`);
  });
  it("removes an orphan path on failed WHEP negotiation and fails closed on uncertain cleanup", async () => {
    const fatal = vi.fn(); const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({})).mockResolvedValueOnce(new Response("unsupported", { status: 400 })).mockResolvedValueOnce(Response.json({}));
    await expect(createLiveDependencies(config, fatal, request).start(recorder, 1, offer, range)).rejects.toMatchObject({ code: "CODEC_UNSUPPORTED" });
    expect(request.mock.calls[2]?.[1]?.method).toBe("DELETE"); expect(fatal).not.toHaveBeenCalled();
    request.mockReset().mockRejectedValue(new Error("unreachable"));
    await expect(createLiveDependencies(config, fatal, request).start(recorder, 1, offer, range)).rejects.toMatchObject({ code: "MEDIA_CLEANUP_FAILED" }); expect(fatal).toHaveBeenCalledOnce();
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
      const response = await fetch(url, { method: "POST", headers, body }); expect(response.status).toBe(201);
      expect(deps.start).toHaveBeenCalledWith(recorder, 1, offer, range); expect(sessions.size).toBe(1);
    } finally { await sessions.closeAll(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
