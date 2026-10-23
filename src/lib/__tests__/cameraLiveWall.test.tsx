// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CameraLiveWall from "@/components/network-center/tabs/CameraLiveWall";
import { createDemoCameraRecorder } from "@/lib/network-center/cameraDemo";
const mocks = vi.hoisted(() => ({ capabilities: vi.fn(), start: vi.fn(), stop: vi.fn(), callbacks: [] as Array<{ onState(state: string, detail?: string): void }> }));
vi.mock("@/lib/network-center/cameraLive", () => ({
  cameraLiveCapabilities: mocks.capabilities,
  CameraLiveConnection: class { constructor(callbacks: { onState(state: string, detail?: string): void }) { mocks.callbacks.push(callbacks); } start = mocks.start; stop = mocks.stop; },
}));
const recorder = { ...createDemoCameraRecorder({ organizationId: "a0000000-0000-4000-8000-000000000001", buildingId: "b0000000-0000-4000-8000-000000000001" }), channel_count: 16 };
beforeEach(() => { vi.clearAllMocks(); mocks.callbacks = []; mocks.capabilities.mockResolvedValue({ channels: Array.from({ length: 16 }, (_, i) => i + 1), maxView: 16 }); });
afterEach(cleanup);
describe("live camera wall", () => {
  it("does not connect automatically and cleans up every active tile when stopped", async () => {
    const view = render(<CameraLiveWall recorder={recorder} />);
    expect(mocks.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Xem trực tiếp" }));
    await screen.findByRole("button", { name: "Dừng xem" });
    expect(mocks.start).toHaveBeenCalledTimes(4);
    fireEvent.click(screen.getByRole("button", { name: "Dừng xem" }));
    expect(mocks.stop).toHaveBeenCalledTimes(4); expect(view.container.querySelectorAll("video")).toHaveLength(0);
  });
  it("releases old page streams and opens the chosen number of new channels", async () => {
    render(<CameraLiveWall recorder={recorder} />);
    fireEvent.click(screen.getByRole("button", { name: "Xem trực tiếp" })); await screen.findByRole("button", { name: "Dừng xem" });
    fireEvent.click(screen.getByRole("button", { name: "Nhóm sau" })); expect(mocks.stop).toHaveBeenCalledTimes(4); expect(mocks.start).toHaveBeenCalledTimes(8);
    fireEvent.change(screen.getByLabelText("Số camera cùng lúc"), { target: { value: "16" } });
    expect(screen.getAllByLabelText(/^Video /)).toHaveLength(16);
  });
  it("hides a stalled frame and releases streams when the wall unmounts", async () => {
    const view = render(<CameraLiveWall recorder={recorder} />);
    fireEvent.click(screen.getByRole("button", { name: "Xem trực tiếp" })); await screen.findByRole("button", { name: "Dừng xem" });
    act(() => mocks.callbacks[0]!.onState("playing"));
    expect(view.container.querySelector("video")?.className).not.toContain("invisible");
    act(() => mocks.callbacks[0]!.onState("stalled", "Đang mất hình ảnh mới."));
    expect(view.container.querySelector("video")?.className).toContain("invisible");
    view.unmount(); expect(mocks.stop).toHaveBeenCalledTimes(4);
  });
  it("shows access errors without starting a video session", async () => {
    mocks.capabilities.mockRejectedValue(new Error("Bạn không có quyền xem camera này."));
    render(<CameraLiveWall recorder={recorder} />); fireEvent.click(screen.getByRole("button", { name: "Xem trực tiếp" }));
    expect((await screen.findByRole("alert")).textContent).toContain("không có quyền"); expect(mocks.start).not.toHaveBeenCalled();
  });
});
