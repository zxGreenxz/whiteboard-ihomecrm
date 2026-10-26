// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCameraExport } from "../network-center/useCameraExport";
import type { CameraArchiveJob, CameraArchiveRequest } from "@/lib/network-center/cameraArchive";
import { CameraLiveError } from "@/lib/network-center/cameraLive";
const mocks = vi.hoisted(() => ({ owner: "40000000-0000-4000-8000-000000000001", prepare: vi.fn(), find: vi.fn(), cancel: vi.fn() }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ data: { id: mocks.owner } }) }));
vi.mock("@/lib/network-center/cameraArchive", () => ({ prepareCameraArchive: mocks.prepare, findCameraArchive: mocks.find, cancelCameraArchive: mocks.cancel }));
const recorderId = "20000000-0000-4000-8000-000000000001", id = "10000000-0000-4000-8000-000000000001";
const input: CameraArchiveRequest = { recorderId, channel: 1, start: "2026-10-20T01:00:00.000Z", end: "2026-10-20T01:01:00.000Z", purpose: "export", resolution: "480p" };
const job: CameraArchiveJob = { ...input, id, resolution: "480p", state: "processing", progress: 32, expiresAt: Date.now() + 300000 };
const key = () => `ihomecrm.camera-export:${mocks.owner}:${recorderId}`;
const mount = () => renderHook(() => useCameraExport(recorderId, true));
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); mocks.owner = "40000000-0000-4000-8000-000000000001";
  mocks.find.mockResolvedValue(null); mocks.cancel.mockResolvedValue(undefined); mocks.prepare.mockImplementation(() => new Promise(() => {}));
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:ready"); vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("export reload recovery", () => {
  it("persists before POST, discovers the same request after reload, and never cancels on unmount", async () => {
    const first = mount(); await waitFor(() => expect(first.result.current.busy).toBe(false));
    mocks.prepare.mockImplementation((request) => { expect(JSON.parse(localStorage.getItem(key())!).input.requestId).toBe(request.requestId); return new Promise(() => {}); });
    act(() => { void first.result.current.prepare(input); });
    const request = mocks.prepare.mock.calls[0]![0]; expect(request.requestId).toMatch(/^[a-f0-9-]{36}$/u);
    first.unmount(); expect(mocks.prepare.mock.calls[0]![1].aborted).toBe(true); expect(mocks.cancel).not.toHaveBeenCalled();
    mocks.find.mockResolvedValue(job); mount(); await waitFor(() => expect(mocks.prepare).toHaveBeenCalledTimes(2));
    expect(mocks.find).toHaveBeenLastCalledWith(recorderId, expect.any(AbortSignal), request.requestId);
    expect(mocks.prepare.mock.calls[1]![0]).toEqual(request); expect(mocks.prepare.mock.calls[1]![3].resumeId).toBe(id);
  });
  it("restores the exact job id, range and quality instead of creating another job", async () => {
    localStorage.setItem(key(), JSON.stringify({ createdAt: Date.now(), input: { ...input, resolution: "original", requestId: id }, jobId: id }));
    const view = mount(); await waitFor(() => expect(mocks.prepare).toHaveBeenCalledOnce());
    expect(mocks.prepare.mock.calls[0]![3].resumeId).toBe(id); expect(view.result.current.restored?.resolution).toBe("original"); expect(mocks.find).not.toHaveBeenCalled();
  });
  it("recovers a completed file through server lookup and retains it across reloads", async () => {
    const ready = { ...job, state: "ready", bytes: 4, durationSeconds: 60, filename: "camera.mp4", sha256: "a".repeat(64) };
    mocks.find.mockResolvedValue(ready); mocks.prepare.mockResolvedValue({ job: ready, blob: new Blob(["data"]) });
    const first = mount(); await waitFor(() => expect(first.result.current.result?.url).toBe("blob:ready")); first.unmount();
    expect(mocks.cancel).not.toHaveBeenCalled(); const second = mount(); await waitFor(() => expect(second.result.current.result?.url).toBe("blob:ready"));
    expect(mocks.prepare.mock.calls[1]![3].resumeId).toBe(id); expect(mocks.find).toHaveBeenCalledOnce();
  });
  it("cancels by persisted request id even before a job id is returned", async () => {
    const view = mount(); await waitFor(() => expect(view.result.current.busy).toBe(false));
    act(() => { void view.result.current.prepare(input); }); const request = mocks.prepare.mock.calls[0]![0];
    await act(async () => view.result.current.cancel());
    expect(mocks.cancel).toHaveBeenCalledWith(request, expect.any(AbortSignal), undefined); expect(localStorage.getItem(key())).toBeNull(); expect(view.result.current.busy).toBe(false);
  });
  it("persists cancellation intent on network failure and retries cancel after reload, never POST", async () => {
    localStorage.setItem(key(), JSON.stringify({ createdAt: Date.now(), input: { ...input, requestId: id }, cancelling: true }));
    mocks.cancel.mockRejectedValueOnce(new Error("network")); const view = mount();
    await waitFor(() => expect(view.result.current.error).toContain("Chưa xác nhận hủy")); expect(view.result.current.cancelling).toBe(true);
    view.unmount(); mount(); await waitFor(() => expect(mocks.cancel).toHaveBeenCalledTimes(2)); expect(mocks.prepare).not.toHaveBeenCalled(); expect(localStorage.getItem(key())).toBeNull();
  });
  it("clears expired references and requires an explicit new request instead of auto-POST", async () => {
    localStorage.setItem(key(), JSON.stringify({ createdAt: Date.now(), input: { ...input, requestId: id }, jobId: id })); mocks.prepare.mockRejectedValue(new CameraLiveError("ARCHIVE_EXPIRED"));
    const view = mount(); await waitFor(() => expect(view.result.current.error).not.toBe(""));
    expect(localStorage.getItem(key())).toBeNull(); expect(mocks.prepare).toHaveBeenCalledOnce(); expect(mocks.prepare.mock.calls[0]![3].resumeId).toBe(id);
  });
  it("ignores old-account progress and completion after the account changes", async () => {
    let complete!: (result: unknown) => void; mocks.prepare.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const view = mount(); await waitFor(() => expect(view.result.current.busy).toBe(false)); act(() => { void view.result.current.prepare(input); });
    const progress = mocks.prepare.mock.calls[0]![2]; mocks.owner = "50000000-0000-4000-8000-000000000001"; view.rerender();
    await act(async () => { progress(job); complete({ job, blob: new Blob(["private"]) }); });
    expect(view.result.current.result).toBeUndefined(); expect(view.result.current.job).toBeUndefined(); expect(URL.createObjectURL).not.toHaveBeenCalled(); expect(localStorage.getItem(key())).toBeNull();
  });
  it("never auto-POSTs when the server has lost a request, but an explicit retry keeps its id", async () => {
    localStorage.setItem(key(), JSON.stringify({ createdAt: Date.now(), input: { ...input, requestId: id } }));
    const view = mount(); await waitFor(() => expect(view.result.current.error).toContain("Chưa xác nhận")); expect(mocks.prepare).not.toHaveBeenCalled();
    act(() => { void view.result.current.prepare(input); }); expect(mocks.prepare.mock.calls[0]![0].requestId).toBe(id);
  });
  it("does not replay an unknown request beyond its deadline after a long absence", async () => {
    localStorage.setItem(key(), JSON.stringify({ createdAt: Date.now() - 91 * 60000, input: { ...input, requestId: id } }));
    const view = mount(); await waitFor(() => expect(view.result.current.error).toContain("hết hạn"));
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.find).not.toHaveBeenCalled(); expect(localStorage.getItem(key())).toBeNull();
    act(() => { void view.result.current.prepare(input); }); expect(mocks.prepare.mock.calls[0]![0].requestId).not.toBe(id);
  });
  it("keeps source/encoding progress and download progress distinct", async () => {
    const view = mount(); await waitFor(() => expect(view.result.current.busy).toBe(false)); act(() => { void view.result.current.prepare(input); });
    act(() => mocks.prepare.mock.calls[0]![2]({ ...job, phase: "source", sourceBytes: 1024 })); expect(view.result.current.job?.phase).toBe("source");
    act(() => mocks.prepare.mock.calls[0]![2]({ ...job, phase: "encoding" })); expect(view.result.current.job?.progress).toBe(32);
    act(() => mocks.prepare.mock.calls[0]![3].onDownloadProgress(256, 1024)); expect(view.result.current.downloaded).toBe(25);
  });
});
