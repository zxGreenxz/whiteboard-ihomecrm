// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CameraLiveConnection } from "@/lib/network-center/cameraLive";

const sessionId = "10000000-0000-4000-8000-000000000001";
const auth = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth } }));
class Peer {
  static instances: Peer[] = [];
  localDescription = { sdp: "v=0\r\nfixture-video-offer" };
  iceGatheringState = "complete";
  connectionState = "connected";
  frames = 0;
  ontrack: ((event: { track: unknown }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  close = vi.fn();
  addTransceiver = vi.fn();
  createOffer = vi.fn(async () => ({ type: "offer", sdp: this.localDescription.sdp }));
  setLocalDescription = vi.fn(async () => {});
  setRemoteDescription = vi.fn(async () => {});
  addEventListener = vi.fn(); removeEventListener = vi.fn();
  getStats = vi.fn(async () => new Map([["video", { type: "inbound-rtp", kind: "video", framesDecoded: this.frames }]]));
  constructor() { Peer.instances.push(this); }
}
const request = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.useFakeTimers(); Peer.instances = []; vi.clearAllMocks();
  vi.stubGlobal("RTCPeerConnection", Peer);
  vi.stubGlobal("fetch", request);
  auth.getSession.mockResolvedValue({ data: { session: { access_token: "user-token" } }, error: null });
  request.mockImplementation(async (_url, options) => options?.method === "POST" && options.body ? Response.json({ id: sessionId, answer: "v=0\r\nanswer", expiresAt: Date.now() + 75000 }) : Response.json({ stopped: true }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const options = () => ({ recorderId: "20000000-0000-4000-8000-000000000001", channel: 1, onStream: vi.fn(), onState: vi.fn() });

describe("live camera browser lifecycle", () => {
  it("receives camera audio without microphone access and preserves video when audio arrives later", async () => {
    class Stream { constructor(readonly tracks: unknown[]) {} }
    vi.stubGlobal("MediaStream", Stream);
    const callbacks = { ...options(), onAudio: vi.fn() }; const connection = new CameraLiveConnection(callbacks); await connection.start();
    const peer = Peer.instances[0]!;
    expect(peer.addTransceiver).toHaveBeenCalledWith("audio", { direction: "recvonly" });
    const video = { id: "v", kind: "video" }, audio = Object.assign(new EventTarget(), { id: "a", kind: "audio", readyState: "live", muted: true });
    peer.ontrack!({ track: video }); peer.ontrack!({ track: audio });
    expect(callbacks.onStream.mock.calls.at(-1)?.[0].tracks).toEqual([video, audio]);
    expect(callbacks.onAudio).toHaveBeenLastCalledWith(false);
    audio.muted = false; audio.dispatchEvent(new Event("unmute")); expect(callbacks.onAudio).toHaveBeenLastCalledWith(true);
    await connection.stop();
  });
  it.each(["fullhd", "original"] as const)("requests the selected %s live profile", async (quality) => {
    const connection = new CameraLiveConnection({ ...options(), liveQuality: quality }); await connection.start();
    expect(String(request.mock.calls[0]?.[0])).toContain(`?quality=${quality}`); await connection.stop();
  });
  it("automatically recovers a transient 8x startup failure without another peer or manual retry", async () => {
    request.mockResolvedValueOnce(Response.json({ code: "CAMERA_UNAVAILABLE" }, { status: 502 }));
    const callbacks = options(); const connection = new CameraLiveConnection({ ...callbacks, playback: { start: "2026-10-20T01:00:00Z", end: "2026-10-20T02:00:00Z", quality: "sd", speed: 8 } });
    const started = connection.start(); await vi.advanceTimersByTimeAsync(401); await started;
    expect(request).toHaveBeenCalledTimes(2); expect(Peer.instances).toHaveLength(1); expect(Peer.instances[0]!.setRemoteDescription).toHaveBeenCalledOnce();
    expect(callbacks.onState.mock.calls.some(([state]) => state === "error")).toBe(false); await connection.stop();
  });
  it("bounds retries, cancels retry on stop, and never retries permission or uncertain network failures", async () => {
    const playback = { start: "2026-10-20T01:00:00Z", end: "2026-10-20T02:00:00Z", speed: 8 };
    request.mockImplementation(async () => Response.json({ code: "CAMERA_UNAVAILABLE" }, { status: 502 }));
    const failed = new CameraLiveConnection({ ...options(), playback }); const done = failed.start(); await vi.advanceTimersByTimeAsync(2000); await done;
    expect(request).toHaveBeenCalledTimes(3);
    request.mockClear(); const stopped = new CameraLiveConnection({ ...options(), playback }); void stopped.start(); await vi.advanceTimersByTimeAsync(1); await stopped.stop(); await vi.advanceTimersByTimeAsync(2000); expect(request).toHaveBeenCalledOnce();
    for (const failure of [() => Promise.resolve(Response.json({ code: "CAMERA_ACCESS_DENIED" }, { status: 403 })), () => Promise.reject(new Error("network"))]) {
      request.mockClear().mockImplementation(failure); await new CameraLiveConnection({ ...options(), playback }).start(); expect(request).toHaveBeenCalledOnce();
    }
  });
  it("seeks on the existing authenticated session without replacing WebRTC", async () => {
    const connection = new CameraLiveConnection({ ...options(), playback: { start: "2026-10-20T01:00:00Z", end: "2026-10-20T02:00:00Z", quality: "sd" } }); await connection.start();
    request.mockResolvedValueOnce(Response.json({ time: "2026-10-20T01:10:00.000Z", speed: 8, expiresAt: Date.now()+75000 }));
    await connection.seek(Date.parse("2026-10-20T01:10:00Z"),8);
    expect(request.mock.calls[1]?.[0]).toContain(`/sessions/${sessionId}/playback`); expect(Peer.instances).toHaveLength(1); expect(Peer.instances[0]!.close).not.toHaveBeenCalled(); await connection.stop();
  });
  it("uses the default live substream and only requests the main stream for HD", async () => {
    const sd = new CameraLiveConnection({ ...options(), liveQuality: "sd" }); await sd.start(); await sd.stop();
    expect(request.mock.calls[0]?.[0]).toMatch(/\/sessions$/u);
    request.mockClear();
    const hd = new CameraLiveConnection({ ...options(), liveQuality: "hd" }); await hd.start(); await hd.stop();
    expect(request.mock.calls[0]?.[0]).toMatch(/\/sessions\?quality=hd$/u);
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({ "Content-Type": "application/sdp" });
  });
  it("uses recording signaling for playback and keeps the same authenticated lease lifecycle", async () => {
    const playback = { start: "2026-10-20T01:00:00.000Z", end: "2026-10-20T02:00:00.000Z" };
    const connection = new CameraLiveConnection({ ...options(), playback }); await connection.start();
    expect(String(request.mock.calls[0]?.[0])).toMatch(/\/channels\/1\/playback$/u);
    expect(request.mock.calls[0]?.[1]).toMatchObject({ headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...playback, offer: Peer.instances[0]!.localDescription.sdp }) });
    connection.stop(); await vi.advanceTimersByTimeAsync(1);
    expect(request.mock.calls.at(-1)?.[1]?.method).toBe("DELETE");
  });
  it("only marks video live after decoded frames advance, then hides frozen pictures", async () => {
    const callbacks = options(); const connection = new CameraLiveConnection(callbacks); await connection.start();
    expect(callbacks.onState).not.toHaveBeenCalledWith("playing");
    Peer.instances[0]!.frames = 25; await vi.advanceTimersByTimeAsync(2000);
    expect(callbacks.onState).toHaveBeenLastCalledWith("playing");
    await vi.advanceTimersByTimeAsync(12000);
    expect(callbacks.onState).toHaveBeenLastCalledWith("stalled", "Đang mất hình ảnh mới.");
    connection.stop();
  });
  it("closes the peer and lease on unmount/stop and does not renew afterwards", async () => {
    const callbacks = options(); const connection = new CameraLiveConnection(callbacks); await connection.start();
    connection.stop(); await vi.advanceTimersByTimeAsync(80000);
    expect(Peer.instances[0]!.close).toHaveBeenCalledOnce();
    expect(callbacks.onStream).toHaveBeenLastCalledWith(null);
    expect(request.mock.calls.some(([url, init]) => String(url).endsWith(`/sessions/${sessionId}`) && init?.method === "DELETE")).toBe(true);
    expect(request.mock.calls.some(([url]) => String(url).endsWith("/renew"))).toBe(false);
  });
  it("stops video when lease renewal loses permission", async () => {
    const callbacks = options(); const connection = new CameraLiveConnection(callbacks); await connection.start();
    request.mockImplementation(async (url) => String(url).endsWith("/renew") ? Response.json({ code: "CAMERA_ACCESS_DENIED" }, { status: 403 }) : Response.json({ stopped: true }));
    await vi.advanceTimersByTimeAsync(25000);
    expect(Peer.instances[0]!.close).toHaveBeenCalledOnce();
    expect(callbacks.onState).toHaveBeenLastCalledWith("error", "Bạn không còn quyền xem camera này.");
  });
  it("releases a session whose create response arrives after stop", async () => {
    let resolve!: (value: Response) => void;
    request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const callbacks = options(); const connection = new CameraLiveConnection(callbacks); const started = connection.start();
    await vi.advanceTimersByTimeAsync(1); connection.stop();
    resolve(Response.json({ id: sessionId, answer: "v=0\r\nanswer", expiresAt: Date.now() + 75000 }));
    await started; await vi.advanceTimersByTimeAsync(1);
    expect(request.mock.calls.some(([url, init]) => String(url).endsWith(`/sessions/${sessionId}`) && init?.method === "DELETE")).toBe(true);
    expect(Peer.instances[0]!.setRemoteDescription).not.toHaveBeenCalled();
  });
  it("waits for an in-flight create and its deletion before releasing a preview slot", async () => {
    let created!: (value: Response) => void; let deleted!: (value: Response) => void;
    request.mockImplementationOnce(() => new Promise((resolve) => { created = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { deleted = resolve; }));
    const connection = new CameraLiveConnection(options()); void connection.start();
    await vi.advanceTimersByTimeAsync(1);
    let released = false; const stopped = connection.stop().then(() => { released = true; });
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(false); expect(released).toBe(false);
    created(Response.json({ id: sessionId, answer: "v=0\\r\\nanswer", expiresAt: Date.now() + 75000 }));
    await vi.advanceTimersByTimeAsync(1); expect(released).toBe(false);
    expect(request.mock.calls[1]?.[1]?.method).toBe("DELETE");
    deleted(Response.json({ stopped: true })); await stopped; expect(released).toBe(true);
    expect(Peer.instances[0]!.setRemoteDescription).not.toHaveBeenCalled();
  });
  it("sends credentials in the authorization header only, with a video receive-only offer", async () => {
    const connection = new CameraLiveConnection(options()); await connection.start();
    expect(Peer.instances[0]!.addTransceiver).toHaveBeenCalledWith("video", { direction: "recvonly" });
    expect(request.mock.calls[0]?.[1]).toMatchObject({ headers: { Authorization: "Bearer user-token" }, credentials: "omit", redirect: "error" });
    expect(String(request.mock.calls[0]?.[0])).not.toContain("token"); connection.stop();
  });
});
