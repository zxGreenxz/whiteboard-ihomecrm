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
  it("sends credentials in the authorization header only, with a video receive-only offer", async () => {
    const connection = new CameraLiveConnection(options()); await connection.start();
    expect(Peer.instances[0]!.addTransceiver).toHaveBeenCalledWith("video", { direction: "recvonly" });
    expect(request.mock.calls[0]?.[1]).toMatchObject({ headers: { Authorization: "Bearer user-token" }, credentials: "omit", redirect: "error" });
    expect(String(request.mock.calls[0]?.[0])).not.toContain("token"); connection.stop();
  });
});
