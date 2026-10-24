// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CameraArchivePanel from "@/components/network-center/tabs/CameraArchivePanel";
import { createDemoCameraRecorder } from "@/lib/network-center/cameraDemo";
import type { CameraLiveOptions } from "@/lib/network-center/cameraLive";
const mocks = vi.hoisted(() => ({ capabilities: vi.fn(), prepare: vi.fn(), start: vi.fn(), stop: vi.fn(), connections: [] as CameraLiveOptions[] }));
vi.mock("@/lib/network-center/cameraLive", async (original) => ({ ...await original<typeof import("../network-center/cameraLive")>(), cameraLiveCapabilities: mocks.capabilities, CameraLiveConnection: class { constructor(options: CameraLiveOptions) { mocks.connections.push(options); } start = mocks.start; stop = mocks.stop; } }));
vi.mock("@/lib/network-center/cameraArchive", async (original) => ({ ...await original<typeof import("../network-center/cameraArchive")>(), prepareCameraArchive: mocks.prepare }));
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
  vi.clearAllMocks(); mocks.connections.length = 0; mocks.capabilities.mockResolvedValue({ channels: [1, 2], archive: true, playback: true });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture"); vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  mocks.prepare.mockImplementation(async (input) => ({ blob: new Blob(["fixture"]), job: { ...input, id: "job", state: "ready", bytes: 7, durationSeconds: (Date.parse(input.end) - Date.parse(input.start)) / 1000, sha256: "a".repeat(64), filename: "camera-fixture.mp4" } }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("separate playback and export", () => {
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
    expect(screen.getByText("Đang mở bản ghi…")).toBeTruthy(); expect(mocks.stop).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: /Lấy vị trí xem/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Tạm dừng" })); expect(mocks.stop).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Tiếp tục xem" })); expect(mocks.connections).toHaveLength(3);
    fireEvent.change(screen.getByLabelText("Camera cần tìm"), { target: { value: "2" } });
    expect(screen.queryByLabelText(/^Video xem lại/)).toBeNull(); expect(mocks.stop).toHaveBeenCalledTimes(3);
  });
  it("exports without opening playback, defaults to HD and retains independent channel controls", async () => {
    render(<CameraArchivePanel recorder={recorder} buildingName="Tòa mẫu" />); await ready(); setClip();
    fireEvent.change(screen.getByLabelText("Camera trích xuất"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Tạo đoạn MP4" })); await screen.findByRole("link", { name: "Tải video MP4" });
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.prepare.mock.calls[0]?.[0]).toMatchObject({ channel: 2, purpose: "export", resolution: "720p", start: "2026-10-20T01:12:00.000Z", end: "2026-10-20T01:14:30.000Z" });
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
    fireEvent.click(screen.getByRole("button", { name: "Xem khoảng thời gian" })); expect(mocks.start).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Hủy trích xuất" })); expect(mocks.prepare.mock.calls[0]?.[1].aborted).toBe(true); expect(mocks.stop).not.toHaveBeenCalled();
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
