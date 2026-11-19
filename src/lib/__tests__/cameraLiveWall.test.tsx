// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CameraLiveWall from "@/components/network-center/tabs/CameraLiveWall";
import { createDemoCameraRecorder } from "@/lib/network-center/cameraDemo";
const mocks = vi.hoisted(() => ({ capabilities: vi.fn(), start: vi.fn(), stop: vi.fn(), callbacks: [] as Array<{ liveQuality?: string; onStream(stream: MediaStream | null): void; onAudio(available: boolean): void; onState(state: string, detail?: string): void }> }));
vi.mock("@/lib/network-center/cameraLive", () => ({
  cameraLiveCapabilities: mocks.capabilities,
  prepareCameraLiveView: vi.fn(async () => "50000000-0000-4000-8000-000000000001"),
  CameraLiveConnection: class { constructor(callbacks: typeof mocks.callbacks[number]) { mocks.callbacks.push(callbacks); } start = mocks.start; stop = mocks.stop; },
}));
const recorder = { ...createDemoCameraRecorder({ organizationId: "a0000000-0000-4000-8000-000000000001", buildingId: "b0000000-0000-4000-8000-000000000001" }), channel_count: 16 };
beforeEach(() => { vi.clearAllMocks(); mocks.callbacks = []; mocks.capabilities.mockResolvedValue({ channels: Array.from({ length: 16 }, (_, i) => i + 1), maxView: 16, liveQualities: ["sd", "hd"] }); });
afterEach(cleanup);
describe("live camera wall", () => {
  it("reconnects the selected group on refresh after releasing old tiles, without changing quality, page, focus or count", async () => {
    mocks.capabilities.mockResolvedValue({ channels: Array.from({ length: 16 }, (_, i) => i + 1), liveQualities: ["sd", "hd", "fullhd", "original"] });
    const view = render(<CameraLiveWall recorder={recorder} refreshKey={0} />);
    fireEvent.change(screen.getByLabelText("Chất lượng trực tiếp"), { target: { value: "original" } });
    fireEvent.click(screen.getByRole("button", { name: "Xem trực tiếp" }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(4));
    fireEvent.click(screen.getByRole("button", { name: "Nhóm sau" }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(8));
    fireEvent.doubleClick(screen.getAllByRole("article")[1]!);
    act(() => mocks.callbacks.slice(-4).forEach((callback) => callback.onState("error", "Phiên xem cũ")));
    const release: Array<() => void> = [];
    mocks.stop.mockImplementation(() => new Promise<void>((resolve) => release.push(resolve)));
    view.rerender(<CameraLiveWall recorder={recorder} refreshKey={1} />);
    await act(async () => { await Promise.resolve(); });
    expect(mocks.start).toHaveBeenCalledTimes(8);
    expect(screen.queryByText("Phiên xem cũ")).toBeNull();
    await act(async () => release.forEach((resolve) => resolve()));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(12));
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect((screen.getByLabelText("Chất lượng trực tiếp") as HTMLSelectElement).value).toBe("original");
    fireEvent.click(screen.getByRole("button", { name: "Quay về 4 camera" }));
    expect(screen.getByText("2 / 4")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dừng xem" }));
    view.rerender(<CameraLiveWall recorder={recorder} refreshKey={2} />);
    expect(screen.queryByRole("button", { name: "Dừng xem" })).toBeNull();
    mocks.stop.mockReset();
  });
  it("shows the first decoded picture immediately without waiting for the stats poll or audio", async () => {
    const view = render(<CameraLiveWall recorder={recorder} />);
    fireEvent.click(screen.getByRole("button", { name: "Xem trực tiếp" })); await screen.findByRole("button", { name: "Dừng xem" });
    const video = view.container.querySelector("video")!;
    fireEvent.loadedData(video); expect(video.className).toContain("invisible");
    Object.defineProperties(video, { readyState: { value: 2 }, videoWidth: { value: 704 }, videoHeight: { value: 576 } });
    fireEvent.loadedData(video); expect(video.className).not.toContain("invisible"); expect(screen.getByText("● Trực tiếp")).toBeTruthy();
    act(() => mocks.callbacks[0]!.onState("stalled")); expect(video.className).toContain("invisible");
  });
  it("only unmutes the chosen camera and keeps cameras without audio disabled", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const view = render(<CameraLiveWall recorder={recorder} />);
    fireEvent.click(screen.getByRole("button", { name: "Xem trực tiếp" })); await screen.findByRole("button", { name: "Dừng xem" });
    act(() => { for (const callback of mocks.callbacks.slice(0, 2)) callback.onAudio(true); });
    const videos = view.container.querySelectorAll("video");
    expect([...videos].every((v) => v.muted)).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: "Nghe âm thanh" })[0]!);
    expect(videos[0]!.muted).toBe(false); expect(videos[1]!.muted).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Nghe âm thanh" }));
    expect(videos[0]!.muted).toBe(true); expect(videos[1]!.muted).toBe(false);
    expect(screen.queryByRole("button", { name: "Không có âm thanh" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Xem riêng" })).toBeNull();
    play.mockRestore();
  });
  it.each([[4, "hd"], [9, "hd"], [4, "fullhd"], [9, "fullhd"]] as const)("uses SD for a %i-tile wall and applies %s only to the focused tile", async (count, quality) => {
    mocks.capabilities.mockResolvedValue({ channels: Array.from({ length: 16 }, (_, i) => i + 1), liveQualities: ["sd", "hd", "fullhd", "original"] });
    render(<CameraLiveWall recorder={recorder} />);
    fireEvent.change(screen.getByLabelText("Số camera cùng lúc"), { target: { value: String(count) } });
    fireEvent.change(screen.getByLabelText("Chất lượng trực tiếp"), { target: { value: quality } });
    fireEvent.click(screen.getByRole("button", { name: "Xem trực tiếp" })); await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(count));
    expect(mocks.callbacks.every((c) => c.liveQuality === "sd")).toBe(true);
    fireEvent.doubleClick(screen.getAllByRole("article")[1]!); await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(count + 1));
    expect(mocks.callbacks.at(-1)!.liveQuality).toBe(quality);
    fireEvent.click(screen.getByRole("button", { name: `Quay về ${count} camera` }));
    expect(screen.getAllByRole("article")).toHaveLength(count); expect((screen.getByLabelText("Chất lượng trực tiếp") as HTMLSelectElement).value).toBe(quality);
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(count + 2));
    expect(mocks.callbacks.at(-1)!.liveQuality).toBe("sd");
  });
  it("focuses the double-clicked camera without reconnecting and restores the previous page and count", async () => {
    render(<CameraLiveWall recorder={recorder} />);
    fireEvent.click(screen.getByRole("button", { name: "Xem trực tiếp" })); await screen.findByRole("button", { name: "Dừng xem" });
    fireEvent.click(screen.getByRole("button", { name: "Nhóm sau" })); await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(8));
    const tiles = screen.getAllByRole("article"); const selected = tiles[2]!;
    fireEvent.doubleClick(selected);
    expect(screen.getAllByRole("article")).toEqual([selected]);
    expect(mocks.start).toHaveBeenCalledTimes(8); expect(mocks.stop).toHaveBeenCalledTimes(4);
    fireEvent.click(screen.getByRole("button", { name: "Quay về 4 camera" }));
    expect(screen.getAllByRole("article")).toHaveLength(4); expect(screen.getByText("2 / 4")).toBeTruthy();
    expect(mocks.start).toHaveBeenCalledTimes(8);
  });
  it("starts in SD and releases each old stream when switching to HD and back", async () => {
    render(<CameraLiveWall recorder={recorder} />);
    expect((screen.getByLabelText("Chất lượng trực tiếp") as HTMLSelectElement).value).toBe("sd");
    fireEvent.change(screen.getByLabelText("Số camera cùng lúc"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Xem trực tiếp" })); await screen.findByRole("button", { name: "Dừng xem" });
    expect(mocks.callbacks.every((value) => value.liveQuality === "sd")).toBe(true);
    fireEvent.change(screen.getByLabelText("Chất lượng trực tiếp"), { target: { value: "hd" } });
    expect(mocks.stop).toHaveBeenCalledTimes(1); await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(2)); expect(mocks.callbacks.at(-1)!.liveQuality).toBe("hd");
    fireEvent.change(screen.getByLabelText("Chất lượng trực tiếp"), { target: { value: "sd" } });
    expect(mocks.stop).toHaveBeenCalledTimes(2); await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(3)); expect(mocks.callbacks.at(-1)!.liveQuality).toBe("sd");
  });
  it("waits for old leases at the 16-camera limit and skips obsolete quality switches", async () => {
    mocks.capabilities.mockResolvedValue({ channels: Array.from({ length: 16 }, (_, i) => i + 1), liveQualities: ["sd", "hd", "fullhd", "original"] });
    const release: Array<() => void> = [];
    mocks.stop.mockImplementation(() => new Promise<void>((resolve) => release.push(resolve)));
    render(<CameraLiveWall recorder={recorder} />);
    fireEvent.change(screen.getByLabelText("Số camera cùng lúc"), { target: { value: "16" } });
    fireEvent.click(screen.getByRole("button", { name: "Xem trực tiếp" })); await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(16));
    fireEvent.change(screen.getByLabelText("Chất lượng trực tiếp"), { target: { value: "original" } });
    fireEvent.change(screen.getByLabelText("Chất lượng trực tiếp"), { target: { value: "sd" } });
    await act(async () => { await Promise.resolve(); }); expect(mocks.start).toHaveBeenCalledTimes(16);
    await act(async () => { release.forEach((resolve) => resolve()); });
    expect(mocks.start).toHaveBeenCalledTimes(32); expect(mocks.callbacks.slice(-16).every((value) => value.liveQuality === "sd")).toBe(true);
    mocks.stop.mockReset();
  });
  it("releases the native grid before Full HD and waits for the focused profile before switching to HD", async () => {
    mocks.capabilities.mockResolvedValue({ channels: [1, 2, 3, 4], liveQualities: ["sd", "hd", "fullhd", "original"] });
    const release: Array<() => void> = [];
    mocks.stop.mockImplementation(() => new Promise<void>((resolve) => release.push(resolve)));
    render(<CameraLiveWall recorder={recorder} />);
    fireEvent.change(screen.getByLabelText("Chất lượng trực tiếp"), { target: { value: "original" } });
    fireEvent.click(screen.getByRole("button", { name: "Xem trực tiếp" })); await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(4));
    fireEvent.doubleClick(screen.getAllByRole("article")[0]!);
    fireEvent.change(screen.getByLabelText("Chất lượng trực tiếp"), { target: { value: "fullhd" } });
    await act(async () => { release[0]!(); release[2]!(); release[3]!(); });
    expect(mocks.start).toHaveBeenCalledTimes(4);
    await act(async () => { release[1]!(); });
    expect(mocks.start).toHaveBeenCalledTimes(8); expect(mocks.callbacks.slice(-4).map((c) => c.liveQuality)).toEqual(["fullhd", "sd", "sd", "sd"]);
    fireEvent.change(screen.getByLabelText("Chất lượng trực tiếp"), { target: { value: "hd" } });
    await act(async () => { await Promise.resolve(); });
    expect(mocks.start).toHaveBeenCalledTimes(8);
    await act(async () => { release[4]!(); });
    expect(mocks.start).toHaveBeenCalledTimes(9); expect(mocks.callbacks.at(-1)!.liveQuality).toBe("hd");
    mocks.stop.mockReset();
  });
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
    fireEvent.click(screen.getByRole("button", { name: "Nhóm sau" })); expect(mocks.stop).toHaveBeenCalledTimes(4); await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(8));
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
vi.mock("@/hooks/network-center/useCameraQuality", async () => { const { useState } = await import("react"); return { useCameraQuality: () => [...useState("sd"), ""] }; });
