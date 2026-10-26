// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CameraArchivePanel from "@/components/network-center/tabs/CameraArchivePanel";
import { createDemoCameraRecorder } from "@/lib/network-center/cameraDemo";
import type { CameraLiveOptions } from "@/lib/network-center/cameraLive";
vi.mock("@/hooks/network-center/useCameraQuality", async () => { const { useState } = await import("react"); return { useCameraQuality: (kind: string) => [...useState(kind === "export" ? "480p" : "sd"), ""] }; });
const mocks = vi.hoisted(() => ({ capabilities: vi.fn(), prepare: vi.fn(), find: vi.fn(), cancel: vi.fn(), start: vi.fn(), stop: vi.fn(), seek: vi.fn(), capture: vi.fn(), frame: vi.fn(), connections: [] as CameraLiveOptions[] }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ data: { id: "40000000-0000-4000-8000-000000000001" } }) }));
vi.mock("@/lib/network-center/cameraPlayback", async (original) => ({ ...await original<typeof import("../network-center/cameraPlayback")>(), capturePlaybackFrame: mocks.capture, cameraFrame: mocks.frame }));
vi.mock("@/lib/network-center/cameraLive", async (original) => ({ ...await original<typeof import("../network-center/cameraLive")>(), cameraLiveCapabilities: mocks.capabilities, CameraLiveConnection: class { constructor(options: CameraLiveOptions) { mocks.connections.push(options); } start = mocks.start; stop = mocks.stop; seek = mocks.seek; } }));
vi.mock("@/lib/network-center/cameraArchive", async (original) => ({ ...await original<typeof import("../network-center/cameraArchive")>(), prepareCameraArchive: mocks.prepare, findCameraArchive: mocks.find, cancelCameraArchive: mocks.cancel }));
const recorder = createDemoCameraRecorder({ organizationId: "a0000000-0000-4000-8000-000000000001", buildingId: "b0000000-0000-4000-8000-000000000001" });
function setWindow() {
  fireEvent.change(screen.getByLabelText("Từ ngày giờ"), { target: { value: "2026-10-20T08:00:00" } });
  fireEvent.change(screen.getByLabelText("Đến ngày giờ"), { target: { value: "2026-10-20T09:00:00" } });
}
function setClip() {
  fireEvent.change(screen.getByLabelText("Bắt đầu đoạn cắt"), { target: { value: "2026-10-20T08:12:00" } });
  fireEvent.change(screen.getByLabelText("Kết thúc đoạn cắt"), { target: { value: "2026-10-20T08:14:30" } });
}
async function ready() { await waitFor(() => expect(screen.queryByText("Đang kiểm tra dịch vụ xem lại…")).toBeNull()); }
beforeEach(() => {
  localStorage.clear(); mocks.find.mockResolvedValue(null); mocks.cancel.mockResolvedValue(undefined);
  vi.clearAllMocks(); mocks.stop.mockResolvedValue(undefined); mocks.connections.length = 0; mocks.capabilities.mockResolvedValue({ channels: [1, 2], archive: true, playback: true, playbackSpeeds: [1, 2, 4, 6, 8], playbackQualities: ["sd", "hd"] });
  mocks.frame.mockReturnValue("data:image/jpeg;base64,previous"); mocks.capture.mockResolvedValue("data:image/jpeg;base64,preview");
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture"); vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  mocks.prepare.mockImplementation(async (input) => ({ blob: new Blob(["fixture"]), job: { ...input, id: "job", state: "ready", bytes: 7, durationSeconds: (Date.parse(input.end) - Date.parse(input.start)) / 1000, sha256: "a".repeat(64), filename: "camera-fixture.mp4" } }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("separate playback and export", () => {
  it("waits for the original cleanup when quality changes twice before a pending connection can start", async () => {
    let released!: () => void;
    mocks.stop.mockImplementationOnce(() => new Promise<void>((resolve) => { released = resolve; }));
    mocks.capabilities.mockResolvedValue({ channels: [1], archive: true, playback: true, playbackControl: true, playbackQualities: ["sd", "hd", "fullhd"] });
    render(<CameraArchivePanel recorder={recorder} buildingName="Tòa mẫu" />); await ready(); setWindow();
    fireEvent.click(screen.getByRole("button", { name: "Xem khoảng thời gian" })); await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText("Chất lượng xem lại"), { target: { value: "hd" } });
    fireEvent.change(screen.getByLabelText("Chất lượng xem lại"), { target: { value: "fullhd" } });
    await act(async () => { await Promise.resolve(); });
    expect(mocks.start).toHaveBeenCalledOnce(); expect(mocks.connections).toHaveLength(3);
    await act(async () => released());
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(2));
    expect(mocks.connections.at(-1)?.playback?.quality).toBe("fullhd");
  });
  it("reuses one connection for seeking and 8x, but preserves the whole seekable window on Full HD restart", async () => {
    mocks.seek.mockResolvedValue(undefined);
    mocks.capabilities.mockResolvedValue({ channels: [1, 2], archive: true, playback: true, playbackControl: true, playbackPreview: true, playbackSpeeds: [1, 2, 4, 6, 8], playbackQualities: ["sd", "hd", "fullhd", "original"] });
    render(<CameraArchivePanel recorder={recorder} buildingName="Tòa mẫu" />); await ready(); setWindow();
    fireEvent.click(screen.getByRole("button", { name: "Xem khoảng thời gian" }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
    const video = screen.getByLabelText(/^Video xem lại/);
    fireEvent.change(screen.getByLabelText("Tốc độ xem lại"), { target: { value: "8" } });
    await waitFor(() => expect(mocks.seek).toHaveBeenCalledWith(Date.parse("2026-10-20T01:00:00Z"), 8));
    fireEvent.click(screen.getByRole("button", { name: "Tới 10 giây" }));
    await waitFor(() => expect(mocks.seek).toHaveBeenLastCalledWith(Date.parse("2026-10-20T01:00:10Z"), 8));
    expect(mocks.connections).toHaveLength(1); expect(screen.getByLabelText(/^Video xem lại/)).toBe(video);
    fireEvent.change(screen.getByLabelText("Chất lượng xem lại"), { target: { value: "fullhd" } });
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(2));
    expect(mocks.connections[1]?.playback).toMatchObject({ start: "2026-10-20T01:00:00.000Z", end: "2026-10-20T02:00:00.000Z", position: "2026-10-20T01:00:10.000Z", quality: "fullhd", speed: 8 });
    fireEvent.click(screen.getByRole("button", { name: "Lùi 10 giây" }));
    await waitFor(() => expect(mocks.seek).toHaveBeenLastCalledWith(Date.parse("2026-10-20T01:00:00Z"), 8));
    expect(mocks.connections).toHaveLength(2);
  });
  it("defaults playback to SD, switches quality at the current time and preserves the selected speed", async () => {
    render(<CameraArchivePanel recorder={recorder} buildingName="Tòa mẫu" />); await ready(); setWindow();
    expect((screen.getByLabelText("Chất lượng xem lại") as HTMLSelectElement).value).toBe("sd");
    fireEvent.click(screen.getByRole("button", { name: "Xem khoảng thời gian" }));
    expect(mocks.connections.at(-1)?.playback?.quality).toBe("sd");
    fireEvent.change(screen.getByLabelText("Tốc độ xem lại"), { target: { value: "4" } });
    const video = screen.getByLabelText(/^Video xem lại/);
    Object.defineProperties(video, { currentTime: { value: 10 }, readyState: { value: 4 } }); fireEvent.timeUpdate(video);
    fireEvent.change(screen.getByLabelText("Chất lượng xem lại"), { target: { value: "hd" } });
    expect(mocks.connections.at(-1)?.playback).toMatchObject({ start: "2026-10-20T01:00:40.000Z", quality: "hd", speed: 4 });
    expect(mocks.prepare).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByLabelText("Thanh thời gian xem lại"), { pointerType: "touch" });
    fireEvent.change(screen.getByLabelText("Thanh thời gian xem lại"), { target: { value: "120" } });
    fireEvent.pointerCancel(screen.getByLabelText("Thanh thời gian xem lại"));
    expect(screen.queryByText("Đang lấy ảnh xem trước…")).toBeNull();
    expect((screen.getByLabelText("Thanh thời gian xem lại") as HTMLInputElement).value).toBe("40");
  });
  it("preserves the last frame on seek/pause and requests native speeds while updating the timeline", async () => {
    render(<CameraArchivePanel recorder={recorder} buildingName="Tòa mẫu" />); await ready(); setWindow();
    fireEvent.click(screen.getByRole("button", { name: "Xem khoảng thời gian" }));
    for (const speed of [2, 4, 6, 8]) {
      fireEvent.change(screen.getByLabelText("Tốc độ xem lại"), { target: { value: String(speed) } });
      expect(mocks.connections.at(-1)?.playback?.speed).toBe(speed);
    }
    expect(screen.getByAltText("Khung hình trước khi chuyển mốc").getAttribute("src")).toContain("previous");
    act(() => mocks.connections.at(-1)!.onState("error", "Mất kết nối"));
    expect(screen.getByText("Ảnh của mốc trước · chưa có hình tại mốc đã chọn")).toBeTruthy();
    const video = screen.getByLabelText(/^Video xem lại/);
    Object.defineProperties(video, { currentTime: { value: 10 }, readyState: { value: 4 } });
    fireEvent.playing(video); fireEvent.timeUpdate(video);
    expect((screen.getByLabelText("Thanh thời gian xem lại") as HTMLInputElement).value).toBe("80");
    expect(screen.queryByAltText("Khung hình trước khi chuyển mốc")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Tạm dừng" }));
    expect(screen.getByAltText("Khung hình trước khi chuyển mốc")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Tiếp tục xem" }));
    expect(mocks.connections.at(-1)?.playback).toMatchObject({ start: "2026-10-20T01:01:20.000Z", speed: 8 });
  });
  it("shows an actual thumbnail while dragging without seeking the main stream, then commits the target", async () => {
    render(<CameraArchivePanel recorder={recorder} buildingName="Tòa mẫu" />); await ready(); setWindow();
    fireEvent.click(screen.getByRole("button", { name: "Xem khoảng thời gian" }));
    const slider = screen.getByLabelText("Thanh thời gian xem lại");
    fireEvent.pointerDown(slider); fireEvent.change(slider, { target: { value: "120" } });
    expect(screen.getByText("Đang lấy ảnh xem trước…")).toBeTruthy();
    await screen.findByAltText(/Ảnh xem trước/);
    expect(mocks.capture).toHaveBeenCalledWith(recorder.id, 1, Date.parse("2026-10-20T01:02:00Z"), Date.parse("2026-10-20T02:00:00Z"), expect.any(AbortSignal), "sd", false);
    expect(mocks.connections).toHaveLength(1);
    fireEvent.pointerUp(slider); expect(mocks.connections.at(-1)?.playback?.start).toBe("2026-10-20T01:02:00.000Z");
    expect(screen.queryByAltText(/Ảnh xem trước/)).toBeNull();
    fireEvent.pointerDown(slider); fireEvent.change(slider, { target: { value: "130" } });
    fireEvent.change(screen.getByLabelText("Camera cần tìm"), { target: { value: "2" } });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(mocks.capture).toHaveBeenCalledTimes(1); expect(screen.queryByAltText(/Ảnh xem trước/)).toBeNull();
  });
  it("opens a direct recording stream without creating or downloading an archive, and seeks by replacing the stream", async () => {
    render(<CameraArchivePanel recorder={recorder} buildingName="Tòa mẫu" />); await ready(); setWindow();
    const select = within(screen.getByLabelText("Camera cần tìm")); expect(select.getByRole("option", { name: "Sảnh DEMO" }).getAttribute("value")).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "Xem khoảng thời gian" }));
    expect(mocks.connections[0]).toMatchObject({ channel: 1, playback: { start: "2026-10-20T01:00:00.000Z", end: "2026-10-20T02:00:00.000Z" } });
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(URL.createObjectURL).not.toHaveBeenCalled();
    const oldVideo = screen.getByLabelText(/^Video xem lại/);
    fireEvent.click(screen.getByRole("button", { name: "Tới 10 giây" }));
    expect(mocks.stop).toHaveBeenCalledOnce(); expect(mocks.connections[1]?.playback?.start).toBe("2026-10-20T01:00:10.000Z");
    expect(screen.getByLabelText(/^Video xem lại/)).not.toBe(oldVideo);
    Object.defineProperties(oldVideo, { currentTime: { value: 3600 }, readyState: { value: 4 } });
    fireEvent.timeUpdate(oldVideo); fireEvent.playing(oldVideo);
    expect(screen.getByText(/Đang chuyển mốc/)).toBeTruthy(); expect(mocks.stop).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: /Lấy vị trí xem/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Tạm dừng" })); expect(mocks.stop).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Tiếp tục xem" })); expect(mocks.connections).toHaveLength(3);
    fireEvent.change(screen.getByLabelText("Camera cần tìm"), { target: { value: "2" } });
    expect(screen.queryByLabelText(/^Video xem lại/)).toBeNull(); expect(mocks.stop).toHaveBeenCalledTimes(3);
  });
  it("exports without opening playback, defaults to SD and retains independent channel controls", async () => {
    render(<CameraArchivePanel recorder={recorder} buildingName="Tòa mẫu" />); await ready(); setClip();
    fireEvent.change(screen.getByLabelText("Camera trích xuất"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Tạo đoạn MP4" })); await screen.findByRole("link", { name: "Tải video MP4" });
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.prepare.mock.calls[0]?.[0]).toMatchObject({ channel: 2, purpose: "export", resolution: "480p", start: "2026-10-20T01:12:00.000Z", end: "2026-10-20T01:14:30.000Z" });
    expect((screen.getByLabelText("Camera cần tìm") as HTMLSelectElement).value).toBe("1");
    fireEvent.change(screen.getByLabelText("Độ phân giải video xuất"), { target: { value: "original" } });
    expect(screen.queryByRole("link", { name: "Tải video MP4" })).toBeNull(); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fixture");
    fireEvent.click(screen.getByRole("button", { name: "Tạo đoạn MP4" })); await screen.findByRole("link", { name: "Tải video MP4" });
    expect(mocks.prepare.mock.calls[1]?.[0]).toMatchObject({ resolution: "original" });
  });
  it("allows playback while exporting and cancels only the selected operation", async () => {
    mocks.prepare.mockImplementation(() => new Promise(() => {}));
    const view = render(<CameraArchivePanel recorder={recorder} buildingName="Tòa mẫu" />); await ready(); setWindow(); setClip();
    fireEvent.click(screen.getByRole("button", { name: "Tạo đoạn MP4" }));
    fireEvent.click(screen.getByRole("button", { name: "Xem khoảng thời gian" })); await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Hủy trích xuất" })); expect(mocks.prepare.mock.calls[0]?.[1].aborted).toBe(true); expect(mocks.stop).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Tạo đoạn MP4" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Tạo đoạn MP4" })); view.unmount();
    expect(mocks.prepare.mock.calls[1]?.[1].aborted).toBe(true); expect(mocks.stop).toHaveBeenCalledOnce();
  });
  it("rejects oversized exports and handles a server without direct playback", async () => {
    mocks.capabilities.mockResolvedValue({ channels: [1, 2], archive: true, playback: false });
    render(<CameraArchivePanel recorder={recorder} buildingName="Tòa mẫu" />); await ready(); setClip();
    expect(screen.getByRole("button", { name: "Xem khoảng thời gian" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Kết thúc đoạn cắt"), { target: { value: "2026-10-20T09:00:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Tạo đoạn MP4" })); expect(screen.getByText(/Chọn khoảng tối đa 30 phút/)).toBeTruthy(); expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
