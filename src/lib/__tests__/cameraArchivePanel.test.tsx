// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CameraArchivePanel from "@/components/network-center/tabs/CameraArchivePanel";
import { createDemoCameraRecorder } from "@/lib/network-center/cameraDemo";
import { CameraLiveError, type CameraLiveOptions } from "@/lib/network-center/cameraLive";
vi.mock("@/hooks/network-center/useCameraQuality", async () => { const { useState } = await import("react"); return { useCameraQuality: (kind: string) => [...useState(kind === "export" ? "480p" : "sd"), ""] }; });
const mocks = vi.hoisted(() => ({ capabilities: vi.fn(), prepare: vi.fn(), find: vi.fn(), cancel: vi.fn(), start: vi.fn(), stop: vi.fn(), seek: vi.fn(), frame: vi.fn(), connections: [] as CameraLiveOptions[] }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ data: { id: "40000000-0000-4000-8000-000000000001" } }) }));
vi.mock("@/lib/network-center/cameraPlayback", async (original) => ({ ...await original<typeof import("../network-center/cameraPlayback")>(), cameraFrame: mocks.frame }));
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
  mocks.frame.mockReturnValue("data:image/jpeg;base64,previous");
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
    expect(mocks.connections[1]?.playback).toMatchObject({ start: "2026-10-20T01:00:00.000Z", end: "2026-10-20T02:00:00.000Z", position: "2026-10-20T01:00:10.000Z", quality: "fullhd" });
    // Luồng chuyển mã mới mở ở 1× rồi mới xin lại 8× bằng lệnh tua (cổng không mở thẳng được ở tốc độ cao).
    expect(mocks.connections[1]?.playback).not.toHaveProperty("speed");
    await waitFor(() => expect(mocks.seek).toHaveBeenCalledTimes(3));
    expect(mocks.seek).toHaveBeenLastCalledWith(Date.parse("2026-10-20T01:00:10Z"), 8);
    fireEvent.click(screen.getByRole("button", { name: "Lùi 10 giây" }));
    await waitFor(() => expect(mocks.seek).toHaveBeenLastCalledWith(Date.parse("2026-10-20T01:00:00Z"), 8));
    expect(mocks.connections).toHaveLength(2);
  });
  it("mở luồng SD/HD mới ở 1× rồi xin tốc độ đã chọn bằng lệnh tua; chất lượng gốc vẫn mở thẳng ở tốc độ đó", async () => {
    mocks.seek.mockResolvedValue(undefined);
    mocks.capabilities.mockResolvedValue({ channels: [1], archive: true, playback: true, playbackControl: true, playbackSpeeds: [1, 2, 4, 6, 8], playbackQualities: ["sd", "hd", "original"] });
    render(<CameraArchivePanel recorder={recorder} buildingName="Tòa mẫu" />); await ready(); setWindow();
    fireEvent.click(screen.getByRole("button", { name: "Xem khoảng thời gian" }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText("Tốc độ xem lại"), { target: { value: "8" } });
    await waitFor(() => expect(mocks.seek).toHaveBeenCalledWith(Date.parse("2026-10-20T01:00:00Z"), 8));
    // Đang 8× đổi SD → HD: đúng thao tác báo "Mất kết nối tới máy chủ video" trên production trước khi sửa.
    fireEvent.change(screen.getByLabelText("Chất lượng xem lại"), { target: { value: "hd" } });
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(2));
    expect(mocks.connections[1]?.playback).toMatchObject({ quality: "hd" }); expect(mocks.connections[1]?.playback).not.toHaveProperty("speed");
    await waitFor(() => expect(mocks.seek).toHaveBeenCalledTimes(2));
    expect(mocks.seek).toHaveBeenLastCalledWith(Date.parse("2026-10-20T01:00:00Z"), 8);
    expect((screen.getByLabelText("Tốc độ xem lại") as HTMLSelectElement).value).toBe("8");
    // Tạm dừng rồi xem tiếp lúc đang 8× cũng là một luồng mới.
    fireEvent.click(screen.getByRole("button", { name: "Tạm dừng" })); fireEvent.click(screen.getByRole("button", { name: "Tiếp tục xem" }));
    await waitFor(() => expect(mocks.seek).toHaveBeenCalledTimes(3));
    expect(mocks.connections[2]?.playback).toMatchObject({ quality: "hd" }); expect(mocks.connections[2]?.playback).not.toHaveProperty("speed");
    // Chất lượng gốc không qua bộ chuyển mã: mở thẳng 8×, không cần lệnh tua kèm theo.
    fireEvent.change(screen.getByLabelText("Chất lượng xem lại"), { target: { value: "original" } });
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(4));
    expect(mocks.connections[3]?.playback).toMatchObject({ quality: "original", speed: 8 });
    await act(async () => { await Promise.resolve(); });
    expect(mocks.seek).toHaveBeenCalledTimes(3);
  });
  it("giữ câu báo lỗi mở luồng, không đè bằng lỗi của lệnh lên tốc độ đi kèm và không tự nối lại vô ích", async () => {
    mocks.seek.mockResolvedValue(undefined);
    mocks.capabilities.mockResolvedValue({ channels: [1], archive: true, playback: true, playbackControl: true, playbackSpeeds: [1, 8], playbackQualities: ["sd", "hd"] });
    render(<CameraArchivePanel recorder={recorder} buildingName="Tòa mẫu" />); await ready(); setWindow();
    fireEvent.click(screen.getByRole("button", { name: "Xem khoảng thời gian" }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText("Tốc độ xem lại"), { target: { value: "8" } });
    await waitFor(() => expect(mocks.seek).toHaveBeenCalledOnce());
    // Luồng mới không mở được (kết nối tự đóng rồi báo lỗi); lệnh lên tốc độ xếp sau đó thất bại vì phiên đã đóng.
    let rejectSeek!: (error: unknown) => void;
    mocks.seek.mockImplementationOnce(() => new Promise((_, reject) => { rejectSeek = reject; }));
    fireEvent.change(screen.getByLabelText("Chất lượng xem lại"), { target: { value: "hd" } });
    await waitFor(() => expect(mocks.seek).toHaveBeenCalledTimes(2));
    act(() => mocks.connections[1]!.onState("error", "Mất kết nối tới máy chủ video."));
    await act(async () => { rejectSeek(new CameraLiveError("SESSION_EXPIRED")); await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByRole("alert").textContent).toBe("Mất kết nối tới máy chủ video.");
    expect(mocks.connections).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Thử lại" })).toBeTruthy();
  });
  it("trình duyệt không báo từng khung hình (iPhone): timeupdate gỡ ảnh giữ tạm sau khi lệnh tua được nhận", async () => {
    mocks.seek.mockResolvedValue(undefined);
    mocks.capabilities.mockResolvedValue({ channels: [1], archive: true, playback: true, playbackControl: true, playbackQualities: ["sd", "hd"] });
    render(<CameraArchivePanel recorder={recorder} buildingName="Tòa mẫu" />); await ready(); setWindow();
    fireEvent.click(screen.getByRole("button", { name: "Xem khoảng thời gian" }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
    const video = screen.getByLabelText(/^Video xem lại/);
    Object.defineProperties(video, { currentTime: { value: 5, writable: true }, readyState: { value: 4 } });
    fireEvent.playing(video);
    fireEvent.click(screen.getByRole("button", { name: "Tới 10 giây" }));
    await waitFor(() => expect(mocks.seek).toHaveBeenCalledOnce());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(mocks.connections).toHaveLength(1); expect(screen.getByLabelText(/^Video xem lại/)).toBe(video);
    // Vừa nhận lệnh tua: hình tại mốc mới chưa chắc đã về, còn giữ ảnh cũ.
    fireEvent.timeUpdate(video);
    expect(screen.getByAltText("Khung hình trước khi chuyển mốc")).toBeTruthy(); expect(screen.getByText(/Đang chuyển mốc/)).toBeTruthy();
    const acknowledged = Date.now(); vi.spyOn(Date, "now").mockReturnValue(acknowledged + 1500);
    (video as HTMLVideoElement).currentTime = 7; fireEvent.timeUpdate(video);
    expect(screen.queryByAltText("Khung hình trước khi chuyển mốc")).toBeNull(); expect(screen.queryByText(/Đang chuyển mốc/)).toBeNull();
  });
  it("hình ngừng khi mốc ước tính đã sát cuối khoảng xem ⇒ báo đã hết khoảng, không treo chờ lỗi mất hình", async () => {
    const frames: VideoFrameRequestCallback[] = [];
    const prototype = HTMLVideoElement.prototype as unknown as { requestVideoFrameCallback?: unknown; cancelVideoFrameCallback?: unknown };
    prototype.requestVideoFrameCallback = (callback: VideoFrameRequestCallback) => frames.push(callback); prototype.cancelVideoFrameCallback = () => {};
    try {
      render(<CameraArchivePanel recorder={recorder} buildingName="Tòa mẫu" />); await ready(); setWindow();
      fireEvent.change(screen.getByLabelText("Đến ngày giờ"), { target: { value: "2026-10-20T08:00:10" } });
      fireEvent.click(screen.getByRole("button", { name: "Xem khoảng thời gian" }));
      // Mốc cách cuối khoảng 2 giây; đầu ghi gửi một khung hình rồi ngừng vì đã hết bản ghi của khoảng.
      fireEvent.change(screen.getByLabelText("Thanh thời gian xem lại"), { target: { value: "8" } }); fireEvent.pointerUp(screen.getByLabelText("Thanh thời gian xem lại"));
      await waitFor(() => expect(mocks.connections).toHaveLength(2));
      act(() => frames.at(-1)!(1000, { mediaTime: 0 } as VideoFrameCallbackMetadata));
      expect(screen.getByText(/Vị trí ước tính: 08:00:08/)).toBeTruthy();
      expect(screen.queryByText("Đã hết khoảng thời gian đã chọn.")).toBeNull();
      const seen = Date.now(); vi.spyOn(Date, "now").mockReturnValue(seen + 3000);
      await waitFor(() => expect(screen.getByText("Đã hết khoảng thời gian đã chọn.")).toBeTruthy(), { timeout: 3000 });
      expect(screen.getByRole("button", { name: "Tiếp tục xem" })).toBeTruthy();
    } finally { delete prototype.requestVideoFrameCallback; delete prototype.cancelVideoFrameCallback; }
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
  it("does not fetch thumbnails or open extra streams while playing and scrubbing a long window", async () => {
    mocks.capabilities.mockResolvedValue({ channels: [1], archive: true, playback: true, playbackPreview: true, playbackControl: true, playbackQualities: ["sd", "original"] });
    render(<CameraArchivePanel recorder={recorder} buildingName="Tòa mẫu" />); await ready(); setWindow();
    fireEvent.change(screen.getByLabelText("Đến ngày giờ"), { target: { value: "2026-10-20T13:00:00" } });
    fireEvent.change(screen.getByLabelText("Chất lượng xem lại"), { target: { value: "original" } });
    fireEvent.click(screen.getByRole("button", { name: "Xem khoảng thời gian" }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
    act(() => mocks.connections[0]!.onState("playing"));
    const slider = screen.getByLabelText("Thanh thời gian xem lại");
    fireEvent.pointerDown(slider, { pointerType: "touch" });
    for (const value of [120, 10000, 15000]) fireEvent.change(slider, { target: { value: String(value) } });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(screen.queryByText(/Đang lấy ảnh xem trước|Ảnh xem trước:/)).toBeNull();
    expect(screen.queryByAltText(/Ảnh xem trước/)).toBeNull();
    expect(mocks.connections).toHaveLength(1); expect(mocks.seek).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider);
    await waitFor(() => expect(mocks.seek).toHaveBeenLastCalledWith(Date.parse("2026-10-20T05:10:00Z"), 1));
    expect(mocks.connections).toHaveLength(1);
    expect(mocks.connections[0]!.playback).toMatchObject({ start: "2026-10-20T01:00:00.000Z", end: "2026-10-20T06:00:00.000Z", quality: "original" });
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
  it("đầu ghi Hikvision (xem lại được, không trích xuất, không tua trên luồng đang chạy): tua và đổi tốc độ đều mở luồng mới tại mốc đó, phần xuất MP4 bị khoá", async () => {
    mocks.capabilities.mockResolvedValue({ channels: [1, 9], archive: false, playback: true, playbackControl: false, playbackSpeeds: [1, 2, 4], playbackQualities: ["sd", "hd"] });
    render(<CameraArchivePanel recorder={recorder} buildingName="Tòa mẫu" />); await ready(); setWindow(); setClip();
    expect(screen.getByText("Đầu ghi chưa được bật dịch vụ trích xuất video.")).toBeTruthy(); expect(screen.queryByText("Đầu ghi chưa được bật dịch vụ phát lại trực tiếp.")).toBeNull();
    expect(screen.getByRole("button", { name: "Tạo đoạn MP4" }).hasAttribute("disabled")).toBe(true); expect((screen.getByLabelText("Camera trích xuất") as HTMLSelectElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Tạo đoạn MP4" }));
    fireEvent.change(screen.getByLabelText("Camera cần tìm"), { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: "Xem khoảng thời gian" })); await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
    expect(mocks.connections[0]).toMatchObject({ channel: 9, playback: { start: "2026-10-20T01:00:00.000Z", end: "2026-10-20T02:00:00.000Z", quality: "sd" } });
    expect(mocks.connections[0]?.playback).not.toHaveProperty("speed");
    expect([...(screen.getByLabelText("Tốc độ xem lại") as HTMLSelectElement).options].map((option) => option.value)).toEqual(["1", "2", "4"]);
    // Đổi tốc độ: luồng mới mở thẳng ở tốc độ đó (không có lệnh tua để xin sau), bắt đầu tại mốc đang xem.
    fireEvent.change(screen.getByLabelText("Tốc độ xem lại"), { target: { value: "4" } });
    expect(mocks.connections).toHaveLength(2); expect(mocks.connections[1]?.playback).toMatchObject({ start: "2026-10-20T01:00:00.000Z", quality: "sd", speed: 4 });
    // Tua: lại một luồng mới bắt đầu tại mốc tua, giữ tốc độ; không bao giờ gửi `position`.
    fireEvent.click(screen.getByRole("button", { name: "Tới 10 giây" }));
    expect(mocks.connections).toHaveLength(3); expect(mocks.connections[2]?.playback).toMatchObject({ start: "2026-10-20T01:00:10.000Z", end: "2026-10-20T02:00:00.000Z", speed: 4 });
    for (const connection of mocks.connections) expect(connection.playback).not.toHaveProperty("position");
    // Luồng mới hỏng: báo lỗi và chờ người dùng, không tự mở thêm luồng nào.
    act(() => mocks.connections[2]!.onState("error", "Chưa nhận được video từ đầu ghi. Vui lòng thử lại."));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(screen.getByText("Chưa nhận được video từ đầu ghi. Vui lòng thử lại.")).toBeTruthy(); expect(mocks.connections).toHaveLength(3);
    // Người dùng hạ về 1× rồi xem tiếp được ngay tại mốc đó.
    fireEvent.change(screen.getByLabelText("Tốc độ xem lại"), { target: { value: "1" } });
    expect(mocks.connections).toHaveLength(4); expect(mocks.connections[3]?.playback).toMatchObject({ start: "2026-10-20T01:00:10.000Z", quality: "sd" });
    expect(mocks.connections[3]?.playback).not.toHaveProperty("speed");
    expect(mocks.seek).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.find).not.toHaveBeenCalled();
  });
});
