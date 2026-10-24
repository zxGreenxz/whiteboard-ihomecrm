// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CameraArchivePanel from "@/components/network-center/tabs/CameraArchivePanel";
import { createDemoCameraRecorder } from "@/lib/network-center/cameraDemo";
const mocks = vi.hoisted(() => ({ capabilities: vi.fn(), prepare: vi.fn() }));
vi.mock("@/lib/network-center/cameraLive", () => ({ cameraLiveCapabilities: mocks.capabilities }));
vi.mock("@/lib/network-center/cameraArchive", async (original) => ({ ...await original<typeof import("../network-center/cameraArchive")>(), prepareCameraArchive: mocks.prepare }));
const recorder = createDemoCameraRecorder({ organizationId: "a0000000-0000-4000-8000-000000000001", buildingId: "b0000000-0000-4000-8000-000000000001" });
function setWindow() {
  fireEvent.change(screen.getByLabelText("Từ ngày giờ"), { target: { value: "2026-10-20T08:00:00" } });
  fireEvent.change(screen.getByLabelText("Đến ngày giờ"), { target: { value: "2026-10-20T09:00:00" } });
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.capabilities.mockResolvedValue({ channels: [1, 2], archive: true });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture"); vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  mocks.prepare.mockImplementation(async (input) => ({ blob: new Blob(["fixture"]), job: { ...input, id: "job", state: "ready", bytes: 7, durationSeconds: (Date.parse(input.end) - Date.parse(input.start)) / 1000, sha256: "a".repeat(64), filename: "camera-fixture.mp4" } }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("camera archive manager workflow", () => {
  it("loads only on request, splits a one-hour search and exports the chosen times", async () => {
    render(<CameraArchivePanel recorder={recorder} buildingName="Tòa mẫu" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Xem khoảng thời gian" }).hasAttribute("disabled")).toBe(false));
    expect(mocks.prepare).not.toHaveBeenCalled(); setWindow();
    expect(screen.getByRole("option", { name: "Sảnh DEMO" }).getAttribute("value")).toBe("1");
    expect(screen.getByRole("option", { name: "Hành lang DEMO" }).getAttribute("value")).toBe("2");
    fireEvent.click(screen.getByRole("button", { name: "Xem khoảng thời gian" })); await screen.findByLabelText(/^Video xem lại/);
    expect(mocks.prepare.mock.calls[0]?.[0]).toMatchObject({ start: "2026-10-20T01:00:00.000Z", end: "2026-10-20T01:10:00.000Z", purpose: "preview" });
    fireEvent.click(screen.getByRole("button", { name: "Đoạn sau" })); await waitFor(() => expect(mocks.prepare).toHaveBeenCalledTimes(2)); await screen.findByLabelText(/^Video xem lại/);
    expect(mocks.prepare.mock.calls[1]?.[0]).toMatchObject({ start: "2026-10-20T01:10:00.000Z" });
    fireEvent.change(screen.getByLabelText("Bắt đầu đoạn cắt"), { target: { value: "2026-10-20T08:12:00" } });
    fireEvent.change(screen.getByLabelText("Kết thúc đoạn cắt"), { target: { value: "2026-10-20T08:14:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Tạo đoạn MP4" })); await screen.findByRole("link", { name: "Tải video MP4" });
    expect(mocks.prepare.mock.calls[2]?.[0]).toMatchObject({ purpose: "export", resolution: "720p", start: "2026-10-20T01:12:00.000Z", end: "2026-10-20T01:14:30.000Z" });
    expect(screen.getByRole("button", { name: "Tải thông tin bàn giao" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Độ phân giải video xuất"), { target: { value: "original" } });
    expect(screen.queryByRole("link", { name: "Tải video MP4" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Tạo đoạn MP4" })); await screen.findByRole("link", { name: "Tải video MP4" });
    expect(mocks.prepare.mock.calls[3]?.[0]).toMatchObject({ resolution: "original" });
  });
  it("rejects invalid ranges without starting a job and clears old media on camera change", async () => {
    render(<CameraArchivePanel recorder={recorder} buildingName="Tòa mẫu" />);
    await waitFor(() => expect(screen.queryByText("Đang kiểm tra dịch vụ xem lại…")).toBeNull());
    setWindow(); fireEvent.click(screen.getByRole("button", { name: "Xem khoảng thời gian" })); await screen.findByLabelText(/^Video xem lại/);
    fireEvent.change(screen.getByLabelText("Kết thúc đoạn cắt"), { target: { value: "2026-10-20T09:00:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Tạo đoạn MP4" })); expect(screen.getByRole("alert").textContent).toContain("30 phút"); expect(mocks.prepare).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("Camera cần tìm"), { target: { value: "2" } });
    expect(screen.queryByLabelText(/^Video xem lại/)).toBeNull(); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fixture");
  });
  it("cancels in-flight work when leaving and reports unavailable service honestly", async () => {
    mocks.prepare.mockImplementation(() => new Promise(() => {}));
    const view = render(<CameraArchivePanel recorder={recorder} buildingName="Tòa mẫu" />);
    await waitFor(() => expect(screen.queryByText("Đang kiểm tra dịch vụ xem lại…")).toBeNull());
    setWindow(); fireEvent.click(screen.getByRole("button", { name: "Xem khoảng thời gian" }));
    view.unmount(); expect(mocks.prepare.mock.calls[0]?.[1].aborted).toBe(true);
    mocks.capabilities.mockResolvedValue({ channels: [1], archive: false });
    render(<CameraArchivePanel recorder={recorder} buildingName="Tòa mẫu" />);
    expect((await screen.findByRole("alert")).textContent).toContain("chưa được bật"); expect(screen.getByRole("button", { name: "Xem khoảng thời gian" }).hasAttribute("disabled")).toBe(true);
  });
});
