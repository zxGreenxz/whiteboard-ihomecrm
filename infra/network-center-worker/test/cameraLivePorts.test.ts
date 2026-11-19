import { afterEach, describe, expect, it, vi } from "vitest";
import { livePorts } from "../src/cameraLivePorts.js";

const second = { CAMERA_LIVE_PORT: "28751", CAMERA_MEDIA_WEBRTC_PORT: "28889", CAMERA_MEDIA_RTSP_PORT: "28895", CAMERA_MEDIA_API_PORT: "28897" };
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe("gateway loopback ports", () => {
  it("keeps the production ports when nothing is overridden", () => {
    expect(livePorts({})).toEqual({ gateway: 18751, webrtc: 18889, rtsp: 18895, api: 18897 });
    expect(livePorts({ PATH: "/usr/bin", CAMERA_MEDIA_BINARY: "/opt/ihome-camera-live/releases/x/mediamtx" })).toEqual(livePorts({}));
  });
  it("accepts only a complete override that cannot meet the production instance", () => {
    expect(livePorts(second)).toEqual({ gateway: 28751, webrtc: 28889, rtsp: 28895, api: 28897 });
    for (const name of Object.keys(second)) {
      const { [name]: _missing, ...partial } = second as Record<string, string>;
      expect(() => livePorts(partial)).toThrow("LIVE_PORT_INVALID");
    }
    for (const value of ["", "0", "80", "1023", "65536", "28751x", " 28751", "2.8e4", "028751", "-28751"]) expect(() => livePorts({ ...second, CAMERA_MEDIA_API_PORT: value })).toThrow("LIVE_PORT_INVALID");
    expect(() => livePorts({ ...second, CAMERA_MEDIA_API_PORT: second.CAMERA_MEDIA_RTSP_PORT })).toThrow("LIVE_PORT_INVALID");
    // A second instance must never reach the production media API, RTSP, WebRTC or gateway port.
    for (const production of ["18751", "18889", "18895", "18897"]) expect(() => livePorts({ ...second, CAMERA_MEDIA_API_PORT: production })).toThrow("LIVE_PORT_INVALID");
  });
  it("moves every loopback address of a second instance, leaving no production port behind", async () => {
    for (const [name, value] of Object.entries(second)) vi.stubEnv(name, value);
    vi.resetModules();
    const { liveConfigSchema } = await import("../src/cameraLive.js");
    const { mediaConfiguration } = await import("../src/cameraLiveMain.js");
    const { playbackSources } = await import("../src/cameraPlayback.js");
    const config = liveConfigSchema.parse({ supabaseUrl: "https://tryymsxyyckgbrmmvozx.supabase.co", publishableKey: "test-publishable-key-placeholder", origins: ["https://crm.example.test"], recorders: [{ id: "10000000-0000-4000-8000-000000000001", organizationId: "20000000-0000-4000-8000-000000000001", buildingId: "30000000-0000-4000-8000-000000000001", channels: [1], rtspOrigin: "rtsp://10.0.0.1:554", username: "fixture", password: "fixture-password" }] });
    const encoder = `/opt/ihome-camera-live/releases/${"a".repeat(40)}/ffmpeg`;
    const media = mediaConfiguration(config, encoder);
    expect(media).toMatchObject({ rtspAddress: "127.0.0.1:28895", apiAddress: "127.0.0.1:28897", webrtcAddress: "127.0.0.1:28889" });
    let revision = ""; const sent: string[] = [];
    const request = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === "PATCH") revision = JSON.parse(String(init.body)).rtspPlaybackRevision;
      sent.push(String(url), String(init?.body ?? ""));
      return init?.method ? Response.json({}) : Response.json({ typeSpecific: { playbackRevision: revision } });
    });
    const sources = playbackSources(request, vi.fn(), encoder);
    const name = await sources.add(config.recorders[0]!, 1, { start: "2026-10-20T01:00:00.000Z", end: "2026-10-20T02:00:00.000Z", quality: "sd" });
    await sources.control(name, 60, 2, new AbortController().signal); await sources.remove(name);
    const everything = JSON.stringify(media) + sent.join("\n");
    expect(everything).toContain("rtsp://127.0.0.1:28895/"); expect(everything).toContain("http://127.0.0.1:28897/v3/config/paths/add/");
    expect(everything).toContain("http://127.0.0.1:28897/v3/paths/static-sources/get/");
    expect(everything).not.toMatch(/18751|18889|18895|18897/u);
  });
});
