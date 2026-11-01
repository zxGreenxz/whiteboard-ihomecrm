// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth } }));
const recorder = "10000000-0000-4000-8000-000000000001";
const previous = "20000000-0000-4000-8000-000000000001";
const key = `camera-live-view:${recorder}`;
const request = vi.fn<typeof fetch>();
const lockRequest = vi.fn();
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); sessionStorage.clear();
  auth.getSession.mockResolvedValue({ data: { session: { access_token: "fixture-token" } }, error: null });
  request.mockResolvedValue(Response.json({ stopped: true })); vi.stubGlobal("fetch", request);
  vi.stubGlobal("performance", { getEntriesByType: () => [{ type: "reload" }] });
  lockRequest.mockImplementation((name, _options, callback) => Promise.resolve(callback({ name })));
  vi.stubGlobal("navigator", { locks: { request: lockRequest } });
});
afterEach(() => vi.unstubAllGlobals());

describe("camera document recovery", () => {
  it("cleans the previous document once before concurrent tiles may open, then persists the new view", async () => {
    sessionStorage.setItem(key, previous);
    let finish!: (response: Response) => void;
    request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { prepareCameraLiveView } = await import("@/lib/network-center/cameraLive");
    let ready = false;
    const first = prepareCameraLiveView(recorder).then((id) => { ready = true; return id; });
    const second = prepareCameraLiveView(recorder);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(ready).toBe(false); expect(sessionStorage.getItem(key)).toBe(previous);
    expect(request.mock.calls[0]).toEqual([expect.stringContaining(`/recorders/${recorder}/live-views/${previous}`), expect.objectContaining({ method: "DELETE", headers: { Authorization: "Bearer fixture-token" } })]);
    finish(Response.json({ stopped: true }));
    const [a, b] = await Promise.all([first, second]); expect(a).toBe(b); expect(a).not.toBe(previous);
    expect(sessionStorage.getItem(key)).toBe(a);
    expect(await prepareCameraLiveView(recorder)).toBe(a); expect(request).toHaveBeenCalledOnce();
  });
  it("retains the predecessor across another F5 when cleanup fails and retries before opening video", async () => {
    sessionStorage.setItem(key, previous);
    request.mockRejectedValueOnce(new Error("offline"));
    const { prepareCameraLiveView } = await import("@/lib/network-center/cameraLive");
    await expect(prepareCameraLiveView(recorder)).rejects.toThrow(); expect(sessionStorage.getItem(key)).toBe(previous);
    const id = await prepareCameraLiveView(recorder); expect(request).toHaveBeenCalledTimes(2);
    expect(sessionStorage.getItem(key)).toBe(id);
  });
  it("does not close the opener when a new or duplicated tab inherits sessionStorage", async () => {
    sessionStorage.setItem(key, previous);
    vi.stubGlobal("performance", { getEntriesByType: () => [{ type: "navigate" }] });
    const { prepareCameraLiveView } = await import("@/lib/network-center/cameraLive");
    const id = await prepareCameraLiveView(recorder);
    expect(id).not.toBe(previous); expect(request).not.toHaveBeenCalled(); expect(sessionStorage.getItem(key)).toBe(id);
  });
  it("does not close an active opener when its duplicate reloads before ever opening video", async () => {
    sessionStorage.setItem(key, previous);
    lockRequest.mockImplementation((name, _options, callback) => Promise.resolve(callback(name === `camera-live-view:${previous}` ? null : { name })));
    const { prepareCameraLiveView } = await import("@/lib/network-center/cameraLive");
    const id = await prepareCameraLiveView(recorder);
    expect(id).not.toBe(previous); expect(request).not.toHaveBeenCalled();
    expect(lockRequest).toHaveBeenCalledWith(`camera-live-view:${previous}`, { ifAvailable: true }, expect.any(Function));
  });
  it("falls back to lease expiry when ownership locks are unavailable instead of closing another tab", async () => {
    sessionStorage.setItem(key, previous); vi.stubGlobal("navigator", {});
    const { prepareCameraLiveView } = await import("@/lib/network-center/cameraLive");
    expect(await prepareCameraLiveView(recorder)).not.toBe(previous); expect(request).not.toHaveBeenCalled();
  });
  it("does not send malformed storage to the gateway", async () => {
    sessionStorage.setItem(key, "untrusted/storage-value");
    const { prepareCameraLiveView } = await import("@/lib/network-center/cameraLive");
    expect(await prepareCameraLiveView(recorder)).toMatch(/^[a-f0-9-]{36}$/u); expect(request).not.toHaveBeenCalled();
  });
});
