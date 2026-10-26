// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { cameraInputTime, cancelCameraArchive, findCameraArchive, prepareCameraArchive, validateCameraWindow, vietnamCameraInput } from "../network-center/cameraArchive";
const auth = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth } }));
const request = vi.fn<typeof fetch>();
const id = "10000000-0000-4000-8000-000000000001";
const input = { recorderId: "20000000-0000-4000-8000-000000000001", channel: 1, start: "2026-10-20T01:00:00.000Z", end: "2026-10-20T01:01:00.000Z", purpose: "export" as const };
const processing = { id, ...input, resolution: "480p", state: "processing", progress: 12, expiresAt: Date.now() + 75000 };
const bytes = new Uint8Array([1, 2, 3, 4]);
const ready = { ...processing, state: "ready", progress: 100, bytes: bytes.length, durationSeconds: 60, sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a", filename: "camera-fixture.mp4" };
beforeEach(() => { vi.clearAllMocks(); request.mockReset(); vi.stubGlobal("fetch", request); vi.stubGlobal("crypto", webcrypto); auth.getSession.mockResolvedValue({ data: { session: { access_token: "fixture-token" } }, error: null }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("archive browser time contract", () => {
  it("round-trips Vietnam time without using the computer timezone", () => {
    expect(cameraInputTime("2026-10-20T08:00:00")).toBe(Date.parse(input.start));
    expect(cameraInputTime("2026-10-20T08:00:30.000")).toBe(Date.parse(input.start) + 30_000);
    expect(vietnamCameraInput(Date.parse(input.start))).toBe("2026-10-20T08:00:00");
    expect(cameraInputTime("2026-02-30T08:00:00")).toBeNaN();
    expect(() => validateCameraWindow("2026-10-20T08:00", "2026-10-20T08:00", 30)).toThrow("sau");
    expect(() => validateCameraWindow("2026-10-20T08:00", "2026-10-20T09:00", 30, Date.parse("2026-10-24T00:00:00Z"))).toThrow("30 phút");
  });
  it("only downloads a verified complete file and retains the server copy for reload recovery", async () => {
    // Node's Blob provides arrayBuffer in jsdom just like a browser.
    const { Blob } = await import("node:buffer"); vi.stubGlobal("Blob", Blob);
    request.mockResolvedValueOnce(Response.json(ready)).mockResolvedValueOnce(new Response(bytes, { headers: { "Content-Type": "video/mp4" } }));
    const result = await prepareCameraArchive(input, new AbortController().signal, vi.fn());
    expect(result.blob.size).toBe(4);
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({ resolution: "480p" });
    expect(request.mock.calls[0]?.[1]).toMatchObject({ headers: { Authorization: "Bearer fixture-token", "Content-Type": "application/json" }, credentials: "omit", redirect: "error" });
    expect(request).toHaveBeenCalledTimes(2); expect(request.mock.calls.at(-1)?.[1]?.method).toBe("GET");
    expect(request.mock.calls.every(([url]) => !String(url).includes("token"))).toBe(true);
  });
  it("rejects a substituted camera or corrupt download without deleting someone else's job", async () => {
    request.mockResolvedValueOnce(Response.json({ ...ready, channel: 2 }));
    await expect(prepareCameraArchive(input, new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: "ARCHIVE_DOWNLOAD_INVALID" });
    expect(request).toHaveBeenCalledOnce();
    request.mockResolvedValueOnce(Response.json(ready)).mockResolvedValueOnce(new Response(new Uint8Array(8), { headers: { "Content-Type": "video/mp4" } }));
    await expect(prepareCameraArchive(input, new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: "ARCHIVE_DOWNLOAD_INVALID" });
  });
  it("sends the selected export resolution and rejects a substituted quality", async () => {
    request.mockResolvedValueOnce(Response.json(ready));
    await expect(prepareCameraArchive({ ...input, resolution: "1080p" }, new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: "ARCHIVE_DOWNLOAD_INVALID" });
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({ resolution: "1080p" });
    expect(request).toHaveBeenCalledOnce();
  });
  it("detaches a reloading page without cancelling the server job or further polling", async () => {
    vi.useFakeTimers(); request.mockResolvedValueOnce(Response.json(processing)).mockResolvedValue(Response.json({ stopped: true }));
    const abort = new AbortController(); const progress = vi.fn();
    const pending = prepareCameraArchive(input, abort.signal, progress); const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(1); abort.abort(); await rejected;
    expect(request).toHaveBeenCalledOnce();
  });
  it("resumes by job id using only GET and exposes download progress", async () => {
    const { Blob } = await import("node:buffer"); vi.stubGlobal("Blob", Blob);
    request.mockResolvedValueOnce(Response.json(ready)).mockResolvedValueOnce(new Response(bytes, { headers: { "Content-Type": "video/mp4" } }));
    const progress = vi.fn(); await prepareCameraArchive(input, new AbortController().signal, vi.fn(), { resumeId: id, onDownloadProgress: progress });
    expect(request.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true); expect(progress).toHaveBeenLastCalledWith(4, 4);
  });
  it("finds only matching recorder jobs and cancels by request id before POST completes", async () => {
    request.mockResolvedValueOnce(Response.json({ job: ready }));
    await expect(findCameraArchive(input.recorderId, new AbortController().signal)).resolves.toMatchObject({ id });
    request.mockResolvedValueOnce(Response.json({ stopped: true }));
    await cancelCameraArchive({ ...input, requestId: id }, new AbortController().signal);
    expect(String(request.mock.calls[1]?.[0])).toContain(`/recorders/${input.recorderId}/archive/requests/${id}`); expect(request.mock.calls[1]?.[1]?.method).toBe("DELETE");
    request.mockResolvedValueOnce(Response.json({ job: { ...ready, recorderId: id } }));
    await expect(findCameraArchive(input.recorderId, new AbortController().signal)).rejects.toMatchObject({ code: "ARCHIVE_DOWNLOAD_INVALID" });
  });
  it("surfaces revoked access instead of downloading and never calls API when signed out", async () => {
    request.mockResolvedValueOnce(Response.json({ code: "CAMERA_ACCESS_DENIED" }, { status: 403 }));
    await expect(prepareCameraArchive(input, new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: "CAMERA_ACCESS_DENIED" });
    auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    await expect(prepareCameraArchive(input, new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: "LOGIN_REQUIRED" }); expect(request).toHaveBeenCalledTimes(1);
  });
});
