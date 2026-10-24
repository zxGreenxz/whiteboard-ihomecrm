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
  it("only binds signaling and path control to loopback and disables recording and publish endpoints", () => {
    const media = mediaConfiguration(config);
    expect(media).toMatchObject({ rtsp: false, rtmp: false, hls: false, srt: false, moq: false, api: true, apiAddress: "127.0.0.1:18897", apiAllowOrigins: [], playback: false, webrtcAddress: "127.0.0.1:18889", webrtcLocalUDPAddress: "", webrtcLocalTCPAddress: "", webrtcIPsFromInterfaces: false });
    expect(Object.values(media.paths).every((path) => path.record === false && path.sourceOnDemand === true)).toBe(true);
    expect(media.authInternalUsers[0]).toEqual({ user: "any", ips: ["127.0.0.1"], permissions: [{ action: "read" }, { action: "api" }] });
  });
});

describe("camera live HTTP boundary", () => {
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
