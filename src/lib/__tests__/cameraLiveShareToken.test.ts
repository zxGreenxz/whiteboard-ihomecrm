// @vitest-environment jsdom
// Phiên chia sẻ camera (`cs_…`) thay đăng nhập CRM cho MỌI lời gọi cổng video của một kết nối: không hỏi phiên
// Supabase, gửi đúng Bearer; cổng báo SHARE_ENDED thì kết nối dừng và báo mã cho trang khách.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CameraLiveConnection, CameraLiveError, cameraLiveCapabilities } from "@/lib/network-center/cameraLive";

const sessionId = "10000000-0000-4000-8000-000000000001";
const recorderId = "20000000-0000-4000-8000-000000000001";
// Dựng lúc chạy để máy quét bí mật không coi chuỗi giả là token thật.
const shareToken = `cs_${"Q".repeat(43)}`;
const auth = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth } }));
class Peer {
  static instances: Peer[] = [];
  localDescription = { sdp: "v=0\r\nfixture-video-offer" };
  iceGatheringState = "complete";
  connectionState = "connected";
  ontrack: ((event: { track: unknown }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  close = vi.fn();
  addTransceiver = vi.fn();
  createOffer = vi.fn(async () => ({ type: "offer", sdp: this.localDescription.sdp }));
  setLocalDescription = vi.fn(async () => {});
  setRemoteDescription = vi.fn(async () => {});
  addEventListener = vi.fn(); removeEventListener = vi.fn();
  getStats = vi.fn(async () => new Map());
  constructor() { Peer.instances.push(this); }
}
class Stream { addTrack() { /* Media tracks are not exercised here. */ } }
const request = vi.fn<typeof fetch>();
const authorization = (index: number) => (request.mock.calls[index]?.[1]?.headers as Record<string, string> | undefined)?.Authorization;
const playback = { start: "2026-11-10T01:00:00.000Z", end: "2026-11-10T02:00:00.000Z", quality: "sd" as const };

beforeEach(() => {
  vi.useFakeTimers(); Peer.instances = []; vi.clearAllMocks();
  vi.stubGlobal("RTCPeerConnection", Peer);
  vi.stubGlobal("MediaStream", Stream);
  vi.stubGlobal("fetch", request);
  auth.getSession.mockResolvedValue({ data: { session: { access_token: "staff-session" } }, error: null });
  request.mockImplementation(async (url, options) => {
    if (String(url).endsWith(`/recorders/${recorderId}`)) return Response.json({ channels: [3], maxView: 1, leaseSeconds: 75, archive: false, liveQualities: [], playback: true, playbackControl: true, playbackSpeeds: [1, 2, 4], playbackQualities: ["sd", "hd"] });
    if (String(url).endsWith("/playback") && String(url).includes("/sessions/")) return Response.json({ time: "2026-11-10T01:10:00.000Z", speed: 2, expiresAt: Date.now() + 75000 });
    return options?.method === "POST" && options.body ? Response.json({ id: sessionId, answer: "v=0\r\nanswer", expiresAt: Date.now() + 75000 }) : Response.json({ stopped: true });
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("camera gateway with a share session", () => {
  it("reads restricted capabilities with the share token and never asks for a CRM session", async () => {
    const capabilities = await cameraLiveCapabilities(recorderId, new AbortController().signal, shareToken);
    expect(capabilities).toMatchObject({ channels: [3], archive: false, liveQualities: [], playbackQualities: ["sd", "hd"] });
    expect(authorization(0)).toBe(`Bearer ${shareToken}`);
    expect(String(request.mock.calls[0]?.[0])).not.toContain(shareToken);
    expect(auth.getSession).not.toHaveBeenCalled();
  });

  it("uses the share token for playback creation, seeking, renewal and release", async () => {
    const connection = new CameraLiveConnection({ recorderId, channel: 3, accessToken: shareToken, playback, onStream: vi.fn(), onState: vi.fn() });
    await connection.start();
    expect(String(request.mock.calls[0]?.[0])).toMatch(/\/channels\/3\/playback$/u);
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({ ...playback, offer: Peer.instances[0]!.localDescription.sdp });
    await connection.seek(Date.parse("2026-11-10T01:10:00Z"), 2);
    await vi.advanceTimersByTimeAsync(25_000);
    connection.stop(); await vi.advanceTimersByTimeAsync(1);
    const paths = request.mock.calls.map(([url, init]) => `${init?.method} ${String(url).replace(/^.*\/v1/u, "")}`);
    expect(paths).toEqual([
      "POST /recorders/20000000-0000-4000-8000-000000000001/channels/3/playback",
      `POST /sessions/${sessionId}/playback`,
      `POST /sessions/${sessionId}/renew`,
      `DELETE /sessions/${sessionId}`,
    ]);
    expect(request.mock.calls.map((_, index) => authorization(index))).toEqual(Array(4).fill(`Bearer ${shareToken}`));
    expect(auth.getSession).not.toHaveBeenCalled();
  });

  it("stops and reports SHARE_ENDED when renewal finds the share expired or revoked", async () => {
    const onState = vi.fn(); const onErrorCode = vi.fn();
    const connection = new CameraLiveConnection({ recorderId, channel: 3, accessToken: shareToken, playback, onStream: vi.fn(), onState, onErrorCode });
    await connection.start();
    request.mockImplementation(async (url) => String(url).endsWith("/renew") ? Response.json({ code: "SHARE_ENDED" }, { status: 401 }) : Response.json({ stopped: true }));
    await vi.advanceTimersByTimeAsync(25_000);
    expect(onErrorCode).toHaveBeenCalledWith("SHARE_ENDED");
    expect(onState).toHaveBeenLastCalledWith("error", "Lượt chia sẻ đã hết hạn hoặc đã bị thu hồi.");
    expect(Peer.instances[0]!.close).toHaveBeenCalledOnce();
    expect(new CameraLiveError("SHARE_SCOPE_DENIED").message).toBe("Lượt chia sẻ không cho phép thao tác này.");
  });

  it("does not retry a scope denial and refuses an empty share token without calling the gateway", async () => {
    request.mockResolvedValue(Response.json({ code: "SHARE_SCOPE_DENIED" }, { status: 403 }));
    const onErrorCode = vi.fn(); const onState = vi.fn();
    await new CameraLiveConnection({ recorderId, channel: 3, accessToken: shareToken, playback, onStream: vi.fn(), onState, onErrorCode }).start();
    expect(request).toHaveBeenCalledOnce();
    expect(onErrorCode).toHaveBeenCalledWith("SHARE_SCOPE_DENIED");
    request.mockClear();
    await expect(cameraLiveCapabilities(recorderId, new AbortController().signal, "")).rejects.toMatchObject({ code: "SHARE_ENDED" });
    expect(request).not.toHaveBeenCalled();
    expect(auth.getSession).not.toHaveBeenCalled();
  });

  it("keeps staff calls on the CRM session when no share token is given", async () => {
    await cameraLiveCapabilities(recorderId, new AbortController().signal);
    expect(auth.getSession).toHaveBeenCalledOnce();
    expect(authorization(0)).toBe("Bearer staff-session");
  });
});
