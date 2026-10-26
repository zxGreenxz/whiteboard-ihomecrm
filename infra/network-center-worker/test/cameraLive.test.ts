import { afterEach, describe, expect, it, vi } from "vitest";
import { createLiveDependencies, createLiveServer, LiveSessions, LiveError, liveConfigSchema, validateOffer, type LiveDependencies } from "../src/cameraLive.js";
import { mediaConfiguration } from "../src/cameraLiveMain.js";

const config = liveConfigSchema.parse({
  supabaseUrl: "https://tryymsxyyckgbrmmvozx.supabase.co", publishableKey: "test-publishable-key-placeholder", origins: ["https://crm.example.test"],
  recorders: [{ id: "10000000-0000-4000-8000-000000000001", organizationId: "20000000-0000-4000-8000-000000000001", buildingId: "30000000-0000-4000-8000-000000000001", channels: [1, 2], rtspOrigin: "rtsp://10.0.0.1:18554", username: "fixture", password: "fixture-password" }],
});
const recorder = config.recorders[0]!;
const offer = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=recvonly\r\na=rtpmap:96 H265/90000\r\n";
const actor = { id: "40000000-0000-4000-8000-000000000001", expiresAt: 500_000 };
function setup() {
  let now = 100_000;
  const dependencies: LiveDependencies = { authorize: vi.fn(async () => actor), start: vi.fn(async () => ({ location: "http://127.0.0.1:18889/fixed/whep/session", answer: offer })), stop: vi.fn(async () => {}), fatal: vi.fn(), now: () => now };
  return { dependencies, sessions: new LiveSessions(dependencies), advance: (ms: number) => { now += ms; } };
}
afterEach(() => vi.restoreAllMocks());

describe("camera live session boundaries", () => {
  it("reclaims only the previous document's HD encoders before starting the new group after F5", async () => {
    const { sessions } = setup();
    const wide = { ...recorder, channels: [1, 2, 3, 4, 5] };
    const view = "50000000-0000-4000-8000-000000000001";
    const otherView = "50000000-0000-4000-8000-000000000002";
    await Promise.all([1, 2, 3, 4].map((channel) => sessions.start(actor, wide, channel, offer, undefined, "hd", view)));
    const other = await sessions.start(actor, wide, 1, offer, undefined, "sd", otherView);
    await expect(sessions.start(actor, wide, 5, offer, undefined, "hd")).rejects.toMatchObject({ code: "CAMERA_QUALITY_LIMIT" });
    await sessions.closeView(actor, wide, view);
    expect(sessions.size).toBe(1); expect(sessions.find(other.id)).toBeTruthy();
    await expect(sessions.start(actor, wide, 5, offer, undefined, "hd", otherView)).resolves.toHaveProperty("id");
    await expect(sessions.start(actor, wide, 1, offer, undefined, "hd", view)).rejects.toMatchObject({ code: "LIVE_VIEW_CLOSED" });
  });
  it("fences delayed POSTs, awaits pending media cleanup, and keeps reservations until cleanup is confirmed", async () => {
    const { sessions, dependencies } = setup();
    const view = "50000000-0000-4000-8000-000000000001";
    let finish!: (value: { location: string; answer: string }) => void;
    let removed!: () => void;
    vi.mocked(dependencies.start).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    vi.mocked(dependencies.stop).mockImplementationOnce(() => new Promise((resolve) => { removed = resolve; }));
    const pending = sessions.start(actor, recorder, 1, offer, undefined, "fullhd", view);
    const rejection = expect(pending).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    let closed = false;
    const closing = sessions.closeView(actor, recorder, view).then(() => { closed = true; });
    await expect(sessions.start(actor, recorder, 2, offer, undefined, "hd")).rejects.toMatchObject({ code: "CAMERA_QUALITY_LIMIT" });
    await expect(sessions.start(actor, recorder, 1, offer, undefined, "hd", view)).rejects.toMatchObject({ code: "LIVE_VIEW_CLOSED" });
    finish({ location: "pending-media", answer: offer }); await vi.waitFor(() => expect(dependencies.stop).toHaveBeenCalled());
    expect(closed).toBe(false); expect(sessions.size).toBe(1);
    removed(); await Promise.all([closing, rejection]); expect(sessions.size).toBe(0);
  });
  it("isolates view cleanup by verified actor and recorder, including a cancel arriving before POST", async () => {
    const { sessions, dependencies, advance } = setup();
    const view = "50000000-0000-4000-8000-000000000001";
    await sessions.start(actor, recorder, 1, offer, undefined, "hd", view);
    await sessions.closeView({ ...actor, id: "other-user" }, recorder, view);
    await sessions.closeView(actor, { ...recorder, id: "10000000-0000-4000-8000-000000000002" }, view);
    expect(sessions.size).toBe(1); expect(dependencies.stop).not.toHaveBeenCalled();
    const next = "50000000-0000-4000-8000-000000000002";
    await sessions.closeView(actor, recorder, next);
    await expect(sessions.start(actor, recorder, 2, offer, undefined, "hd", next)).rejects.toMatchObject({ code: "LIVE_VIEW_CLOSED" });
    await sessions.closeView(actor, recorder, view); await sessions.closeView(actor, recorder, view);
    expect(dependencies.stop).toHaveBeenCalledOnce();
    advance(120_001); await sessions.closeView(actor, recorder, next);
    await expect(sessions.start(actor, recorder, 1, offer, undefined, "hd", view)).resolves.toHaveProperty("id");
  });
  it("accepts one receive-only audio track but rejects publishing and duplicate tracks", () => {
    const audio = "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\na=rtpmap:111 opus/48000/2\r\n";
    expect(() => validateOffer(offer + audio)).not.toThrow();
    for (const invalid of [offer + audio + audio, offer + audio.replace("recvonly", "sendrecv"), offer + audio.replace("recvonly", "sendonly"), offer.replace("recvonly", "sendonly") + audio]) {
      expect(() => validateOffer(invalid)).toThrow("INVALID_VIDEO_OFFER");
    }
  });
  it("rejects unconfigured channels, publishers, extra audio/data tracks and oversized SDP before opening media", async () => {
    const { sessions, dependencies } = setup();
    await expect(sessions.start(actor, recorder, 3, offer)).rejects.toMatchObject({ status: 404 });
    for (const invalid of [offer.replace("recvonly", "sendrecv"), offer + "m=audio 9 UDP/TLS/RTP/SAVPF 8\r\n", offer + "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n", offer + "a=recvonly\r\n", offer + " ".repeat(65536)]) {
      expect(() => validateOffer(invalid)).toThrow("INVALID_VIDEO_OFFER");
    }
    expect(dependencies.start).not.toHaveBeenCalled();
  });
  it("reserves pending sessions against concurrent limit bypass", async () => {
    const { sessions, dependencies } = setup();
    const resolve: Array<(value: { location: string; answer: string }) => void> = [];
    vi.mocked(dependencies.start).mockImplementation(() => new Promise((done) => resolve.push(done)));
    const pending = Array.from({ length: 16 }, () => sessions.start(actor, recorder, 1, offer));
    await expect(sessions.start(actor, recorder, 1, offer)).rejects.toMatchObject({ code: "CAMERA_LIMIT" });
    expect(dependencies.start).toHaveBeenCalledTimes(16);
    resolve.forEach((done) => done({ location: "private-session", answer: offer })); await Promise.all(pending);
  });
  it("bounds distinct live encoders even during pending creates and shares a profile between viewers", async () => {
    const { sessions, dependencies } = setup();
    const wide = { ...recorder, channels: [1, 2, 3, 4, 5] };
    const finish: Array<(value: { location: string; answer: string }) => void> = [];
    vi.mocked(dependencies.start).mockImplementation(() => new Promise((resolve) => finish.push(resolve)));
    const pending = [1, 2, 3, 4].map((channel) => sessions.start(actor, wide, channel, offer, undefined, "hd"));
    await expect(sessions.start(actor, wide, 5, offer, undefined, "hd")).rejects.toMatchObject({ code: "CAMERA_QUALITY_LIMIT" });
    pending.push(sessions.start(actor, wide, 1, offer, undefined, "hd"));
    expect(dependencies.start).toHaveBeenCalledTimes(5);
    finish.forEach((resolve) => resolve({ location: "shared", answer: offer })); await Promise.all(pending);
    await expect(sessions.start(actor, wide, 1, offer, undefined, "fullhd")).rejects.toMatchObject({ code: "CAMERA_QUALITY_LIMIT" });
    await sessions.closeAll();
    vi.mocked(dependencies.start).mockResolvedValue({ location: "next", answer: offer });
    await expect(sessions.start(actor, wide, 5, offer, undefined, "fullhd")).resolves.toHaveProperty("id");
    await expect(sessions.start(actor, wide, 5, offer, undefined, "fullhd")).resolves.toHaveProperty("id");
    await expect(sessions.start(actor, wide, 1, offer, undefined, "fullhd")).rejects.toMatchObject({ code: "CAMERA_QUALITY_LIMIT" });
    await expect(sessions.start(actor, wide, 1, offer, undefined, "hd")).rejects.toMatchObject({ code: "CAMERA_QUALITY_LIMIT" });
  });
  it("binds renew and delete to the verified owner, without letting another user extend or close a session", async () => {
    const { sessions, dependencies, advance } = setup();
    const session = await sessions.start(actor, recorder, 1, offer);
    vi.mocked(dependencies.authorize).mockResolvedValue({ ...actor, id: "other-user" });
    await expect(sessions.renew(session.id, "other-token")).rejects.toMatchObject({ status: 403 });
    await expect(sessions.stop(session.id, "other-token")).rejects.toMatchObject({ status: 403 });
    expect(dependencies.stop).not.toHaveBeenCalled();
    advance(75_001); await sessions.expire(); expect(dependencies.stop).toHaveBeenCalledOnce(); expect(sessions.size).toBe(0);
  });
  it("rechecks building access on every renew and expires video after revoked access or JWT expiry", async () => {
    const { sessions, dependencies, advance } = setup();
    const session = await sessions.start({ ...actor, expiresAt: 110_000 }, recorder, 1, offer);
    expect(session.expiresAt).toBe(110_000);
    vi.mocked(dependencies.authorize).mockRejectedValue(new LiveError(403, "CAMERA_ACCESS_DENIED"));
    await expect(sessions.renew(session.id, "revoked-token")).rejects.toMatchObject({ status: 403 });
    advance(10_001); await sessions.expire(); expect(dependencies.stop).toHaveBeenCalledOnce();
  });
  it("does not revive an expired lease when authorization completes late", async () => {
    const { sessions, dependencies, advance } = setup();
    const session = await sessions.start(actor, recorder, 1, offer);
    let finish!: (value: typeof actor) => void;
    vi.mocked(dependencies.authorize).mockImplementation(() => new Promise((done) => { finish = done; }));
    const pending = sessions.renew(session.id, "token"); advance(75_001); await sessions.expire(); finish(actor);
    await expect(pending).rejects.toMatchObject({ code: "SESSION_EXPIRED" }); expect(sessions.size).toBe(0);
  });
  it("cleans up media that finishes starting after its reservation expired", async () => {
    const { sessions, dependencies, advance } = setup();
    let finish!: (value: { location: string; answer: string }) => void;
    vi.mocked(dependencies.start).mockImplementation(() => new Promise((done) => { finish = done; }));
    const pending = sessions.start(actor, recorder, 1, offer); advance(75_001); await sessions.expire();
    finish({ location: "late-session", answer: offer });
    await expect(pending).rejects.toMatchObject({ code: "SESSION_EXPIRED" }); expect(dependencies.stop).toHaveBeenCalledWith("late-session");
  });
  it("terminates the media process when cleanup cannot be confirmed", async () => {
    const { sessions, dependencies } = setup();
    const session = await sessions.start(actor, recorder, 1, offer);
    vi.mocked(dependencies.stop).mockRejectedValue(new Error("unreachable"));
    await sessions.stop(session.id, "token"); expect(dependencies.fatal).toHaveBeenCalledOnce();
  });
});

describe("camera live upstream authorization", () => {
  it("passes native SD/main video and audio directly, sharing encoders only for resized profiles", () => {
    const encoder = `/opt/ihome-camera-live/releases/${"a".repeat(40)}/ffmpeg`;
    const media = mediaConfiguration(config, encoder);
    const paths = media.paths as Record<string, { source: string; runOnDemand?: string }>;
    for (const suffix of ["-hd", "-fullhd"]) {
      const path = paths[`camera-${recorder.id}-1${suffix}`]!;
      expect(path.source).toBe("publisher"); expect(path.runOnDemand).toContain("libopus"); expect(path.runOnDemand).toContain("0:a:0?");
      expect(path.runOnDemand).not.toContain(recorder.password); expect(path.runOnDemand).not.toContain(recorder.rtspOrigin);
      expect(path.runOnDemand).toContain(suffix === "-hd" ? "1280" : "1920");
      expect(path.runOnDemand).toContain(`camera-${recorder.id}-1-original`);
    }
    for (const suffix of ["", "-original"]) {
      const path = paths[`camera-${recorder.id}-1${suffix}`]!;
      expect(path.runOnDemand).toBeUndefined(); expect(new URL(path.source).searchParams.get("subtype")).toBe(suffix ? "0" : "1");
    }
    expect(() => mediaConfiguration(config, "/tmp/unverified-ffmpeg")).toThrow("LIVE_ENCODER_INVALID");
  });
  const id = actor.id;
  const token = `test.${Buffer.from(JSON.stringify({ sub: id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
  const allowed = { recorders: [{ id: recorder.id, organization_id: recorder.organizationId, building_id: recorder.buildingId, enabled: true, channel_count: 16 }] };
  it("uses the user's JWT for both verified identity and building-scoped RPC", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ id })).mockResolvedValueOnce(Response.json(allowed));
    await expect(createLiveDependencies(config, vi.fn(), request).authorize(token, recorder)).resolves.toMatchObject({ id });
    expect(request.mock.calls[1]?.[0]).toContain("/rpc/camera_building_snapshot_v1");
    expect(request.mock.calls[1]?.[1]).toMatchObject({ headers: { Authorization: `Bearer ${token}`, "Content-Profile": "public", "Accept-Profile": "public" }, body: JSON.stringify({ p_building_id: recorder.buildingId }), redirect: "error" });
  });
  it.each(["organization_id", "building_id", "id", "enabled"] as const)("denies mismatched %s even when a snapshot is returned", async (field) => {
    const changed = { ...allowed.recorders[0], [field]: field === "enabled" ? false : "99999999-9999-4999-8999-999999999999" };
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ id })).mockResolvedValueOnce(Response.json({ recorders: [changed] }));
    await expect(createLiveDependencies(config, vi.fn(), request).authorize(token, recorder)).rejects.toMatchObject({ status: 403 });
  });
  it("rejects invalid Auth before any RPC, without trusting JWT claims", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("denied", { status: 401 }));
    await expect(createLiveDependencies(config, vi.fn(), request).authorize(token, recorder)).rejects.toMatchObject({ status: 401 }); expect(request).toHaveBeenCalledOnce();
  });
  it("rejects upstream redirect locations and fails closed on uncertain create", async () => {
    const fatal = vi.fn();
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(offer, { status: 201, headers: { Location: "https://outside.example/private" } }));
    await expect(createLiveDependencies(config, fatal, request).start(recorder, 1, offer)).rejects.toMatchObject({ code: "UPSTREAM_INVALID" }); expect(fatal).toHaveBeenCalledOnce();
    request.mockRejectedValue(new Error("timeout"));
    await expect(createLiveDependencies(config, fatal, request).start(recorder, 1, offer)).rejects.toMatchObject({ code: "MEDIA_START_UNCERTAIN" }); expect(fatal).toHaveBeenCalledTimes(2);
    request.mockResolvedValue(new Response(offer, { status: 201, headers: { Location: "http://[malformed" } }));
    await expect(createLiveDependencies(config, fatal, request).start(recorder, 1, offer)).rejects.toMatchObject({ code: "UPSTREAM_INVALID" }); expect(fatal).toHaveBeenCalledTimes(3);
  });
  it("only binds signaling and path control to loopback and restricts publishing to generated playback paths", () => {
    const media = mediaConfiguration(config);
    expect(media).toMatchObject({ rtsp: true, rtspAddress: "127.0.0.1:18895", rtspTransports: ["tcp"], rtmp: false, hls: false, srt: false, moq: false, api: true, apiAddress: "127.0.0.1:18897", apiAllowOrigins: [], playback: false, webrtcAddress: "127.0.0.1:18889", webrtcLocalUDPAddress: "", webrtcLocalTCPAddress: "", webrtcIPsFromInterfaces: false });
    expect(Object.values(media.paths).every((path) => path.record === false && path.sourceOnDemand === true)).toBe(true);
    expect(new URL(media.paths[`camera-${recorder.id}-1`]!.source).searchParams.get("subtype")).toBe("1");
    expect(new URL(media.paths[`camera-${recorder.id}-1-hd`]!.source).searchParams.get("subtype")).toBe("0");
    expect(media.authInternalUsers[0]).toEqual({ user: "any", ips: ["127.0.0.1"], permissions: [{ action: "read" }, { action: "api" }, { action: "publish", path: "~^playback-[a-f0-9-]{36}$" }] });
  });
});

describe("camera live HTTP boundary", () => {
  it("authenticates reload cleanup, scopes it to the actor's view, and rejects delayed creation", async () => {
    const { dependencies } = setup(); const { server, sessions } = createLiveServer(config, dependencies);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("address");
    const base = `http://127.0.0.1:${address.port}/camera-live/v1/recorders/${recorder.id}`;
    const view = "50000000-0000-4000-8000-000000000001";
    const headers = { Origin: config.origins[0]!, Authorization: "Bearer a-token-long-enough-for-validation", "Content-Type": "application/sdp", "X-Camera-View-Id": view };
    try {
      const post = () => fetch(base + "/channels/1/sessions?quality=hd", { method: "POST", headers, body: offer });
      expect((await post()).status).toBe(201);
      const url = base + `/live-views/${view}`;
      expect((await fetch(url, { method: "DELETE", headers: { Origin: config.origins[0]! } })).status).toBe(401);
      vi.mocked(dependencies.authorize).mockRejectedValueOnce(new LiveError(403, "CAMERA_ACCESS_DENIED"));
      expect((await fetch(url, { method: "DELETE", headers })).status).toBe(403); expect(sessions.size).toBe(1);
      expect((await fetch(url, { method: "DELETE", headers })).status).toBe(200); expect(sessions.size).toBe(0);
      expect((await post()).status).toBe(409);
      expect((await fetch(base + "/channels/1/sessions", { method: "POST", headers: { ...headers, "X-Camera-View-Id": "invalid" }, body: offer })).status).toBe(400);
      const cors = await fetch(base, { method: "OPTIONS", headers });
      expect(cors.headers.get("access-control-allow-headers")).toContain("X-Camera-View-Id");
    } finally { await sessions.closeAll(); await new Promise<void>((done) => server.close(() => done())); }
  });
  it("keeps recorder authorization on HD requests and rejects arbitrary quality or channel paths", async () => {
    const { dependencies } = setup(); const { server, sessions } = createLiveServer(config, dependencies);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("address");
    const base = `http://127.0.0.1:${address.port}/camera-live/v1/recorders/${recorder.id}/channels/1/sessions`;
    const headers = { Origin: config.origins[0]!, Authorization: "Bearer a-token-long-enough-for-validation", "Content-Type": "application/sdp" };
    try {
      vi.mocked(dependencies.authorize).mockRejectedValueOnce(new LiveError(403, "CAMERA_ACCESS_DENIED"));
      expect((await fetch(base + "?quality=hd", { method: "POST", headers, body: offer })).status).toBe(403); expect(dependencies.start).not.toHaveBeenCalled();
      expect((await fetch(base + "?quality=hd", { method: "POST", headers, body: offer })).status).toBe(201);
      expect(dependencies.start).toHaveBeenLastCalledWith(recorder, 1, offer, undefined, "hd");
      await sessions.closeAll();
      for (const quality of ["fullhd", "original"]) {
        expect((await fetch(base + `?quality=${quality}`, { method: "POST", headers, body: offer })).status).toBe(201);
        expect(dependencies.start).toHaveBeenLastCalledWith(recorder, 1, offer, undefined, quality);
      }
      expect((await fetch(base + "?quality=outside", { method: "POST", headers, body: offer })).status).toBe(404);
      expect((await fetch(base.replace("channels/1/", "channels/99/") + "?quality=hd", { method: "POST", headers, body: offer })).status).toBe(404);
    } finally { await sessions.closeAll(); await new Promise<void>((done) => server.close(() => done())); }
  });
  it("requires allowed origin and bearer token and does not expose upstream configuration", async () => {
    const { dependencies } = setup(); const { server } = createLiveServer(config, dependencies);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("address");
    const base = `http://127.0.0.1:${address.port}/camera-live/v1/recorders/${recorder.id}`;
    try {
      expect((await fetch(base)).status).toBe(403);
      expect((await fetch(base, { headers: { Origin: config.origins[0]! } })).status).toBe(401);
      const response = await fetch(base, { headers: { Origin: config.origins[0]!, Authorization: "Bearer a-token-long-enough-for-validation" } });
      expect(response.status).toBe(200); const body = await response.text();
      expect(body).toContain('"channels":[1,2]'); expect(body).not.toContain(recorder.password); expect(body).not.toContain(recorder.rtspOrigin);
      expect((await fetch(base + "?token=secret", { headers: { Origin: config.origins[0]!, Authorization: "Bearer a-token-long-enough-for-validation" } })).status).toBe(404);
    } finally { await new Promise<void>((done) => server.close(() => done())); }
  });
});
